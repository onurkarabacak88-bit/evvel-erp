"""
Belge Talep Motoru — İZOLE.

Amaç: Şube bir toptancı siparişini "Ürün Teslim Al" ile kabul edince, o teslimata
ait FATURANIN PDF'ini tedarikçiden KOVALAMAK. Fatura OKUMAZ (OCR ayrı) — belge talep
eder + takip eder.

Tasarım (bkz. memory feedback_duyu_izole_toplayici_kurali + project_tedarik_belge_denetim_duyulari):
  - Tetikleyici TEK: şube teslim-al → belge_talep kaydı (durum='bekliyor').
  - Yarı-otomatik wa.me: sistem mesajı HAZIRLAR; sahip cep'ten tek tık gönderir (ücretsiz, kotasız).
  - İZOLE: kendi tablosu; tetikleyici KENDİ transaction'ında, hata YUTAR → teslim-al'ı bozmaz.
  - Öneri-Only: stok/sipariş akışını ETKİLEMEZ; çökse sistem yaşar.
  - Şube paneli bunu GÖRMEZ — sadece cep (sahip).
  - Türev-hazır: teslim→pdf süresi ölçülür → ileride "tedarikçi belge ritmi" duyusu.

Kaldırmak: main.py'den router'ı çıkar + urun-sevk'teki tek tetik satırını sil. Tablo zararsız kalır.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/belge-talep", tags=["belge-talep"])


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS belge_talep (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            ts_id         TEXT,                -- toptanci_siparis id (tetik)
            talep_id      TEXT,                -- siparis_talep id
            sube_id       TEXT,
            sube_adi      TEXT,                -- snapshot
            tedarikci_id  TEXT,
            tedarikci_ad  TEXT,                -- snapshot
            tedarikci_tel TEXT,               -- snapshot (wa.me için)
            teslim_tarihi DATE,
            durum         TEXT NOT NULL DEFAULT 'bekliyor',  -- bekliyor | pdf_geldi | kapandi
            mesaj_sayisi  INT NOT NULL DEFAULT 0,
            son_mesaj_ts  TIMESTAMPTZ,
            kapanma_ts    TIMESTAMPTZ,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (ts_id)                     -- teslimat başına tek talep (idempotent)
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_belge_talep_durum ON belge_talep (durum, olusturma DESC)")
    # Yüklenen faturanın izi (hangi tedarikci_fatura kaydı bu teslimatı kapattı)
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS fatura_id TEXT")
    # AÇIK TESLİMAT DUYUSU (2026-07-06, tasarım: project_tedarik_belge_denetim_duyulari):
    # her teslimat OPEN doğar, ÜÇ kanıtla kapanır — fatura / irsaliye / manuel açıklama.
    # Önemli olan belge TÜRÜ değil, teslimatın sonsuza dek açık kalmaması. Kapanış kanıtı iz bırakır.
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS kapanis_tipi TEXT")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS kapanis_aciklama TEXT")
    # ELLE kayıt notu (2026-07-26, ATALAY vakası): sistem-dışı gelen mal için sahip notu
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS elle_not TEXT")
    # ── PARASAL BOYUT (2026-08-08, sahip doktrini: "ürün artık para olmuştur ve
    # borca yazılır") ────────────────────────────────────────────────────────────
    # Teslimat kaydı bugüne dek YALNIZ "kim / hangi şube / ne zaman" tutuyordu;
    # "NE KADAR" yoktu. Sonuç: canlıda 4 açık teslimat (en eskisi 18 günlük) ve
    # 13 vadeli alım kaydının HİÇBİRİNDE fatura bağı yok — mal gelmiş, borç
    # görünmüyor. Üç kimliğin de kör kaldığı nokta:
    #   · vergi: belgesiz mal → KDV indirilemez, gider ispatsız
    #   · maliyet: tahakkuk etmemiş borç → P&L eksik
    #   · nakit: bilinmeyen tutar → ödeme planında yok
    # BEKLENEN tutar teslim anında hesaplanır (kalem × fiyat), fatura gelince
    # GERÇEK tutarla karşılaştırılır; fark denetim sinyalidir (fatura ≠ sipariş).
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS beklenen_tutar_tl NUMERIC(14,2)")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS kalem_sayisi INT")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS fiyatsiz_kalem INT")
    # 'alis' = gerçek alış fiyatı · 'katalog' = sipariş kataloğu · 'kismi' = ikisi karışık
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS tutar_kaynagi TEXT")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS fatura_tutar_tl NUMERIC(14,2)")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS tutar_fark_tl NUMERIC(14,2)")


def _teslim_parasal_deger(cur, kalemler: Any) -> Dict[str, Any]:
    """"ÜRÜN ARTIK PARA OLMUŞTUR" — teslim kalemlerini paraya çevirir.

    Sahip doktrini (2026-08-08): şube sipariş verir → toptancıya gider → şube
    teslim alır → "ürün artık para olmuştur ve borca yazılır". Bu fonksiyon o
    dönüşümün hesabıdır; borcun BEKLENEN tutarını verir (fatura gelene kadar).

    FİYAT ÖNCELİĞİ (maliyeci kuralı — en gerçeğe yakın olan kazanır):
      1. `alis_fiyatlari` — bu kalemin fiilen ödenen son alış fiyatı
      2. `siparis_urun.birim_fiyat_tl` — katalog fiyatı (sözleşme/liste)
      3. yoksa → kalem fiyatsız sayılır, tutara GİRMEZ ve ayrıca bildirilir
         (uydurma fiyatla borç yazmak, yanlış P&L'den daha kötüdür)

    Kalem eşleşmesi ürün-aç zinciriyle AYNI anahtar sırasını izler:
    kalem_kodu → urun_id → depo_stok_kalem_kodu → normalize ad.
    """
    sonuc = {"tutar": 0.0, "kalem": 0, "fiyatsiz": 0, "kaynak": None}
    if not isinstance(kalemler, list) or not kalemler:
        return sonuc

    alis_map, katalog_map, katalog_ad_map = _kalem_fiyat_haritalari(cur, kalemler)

    kaynaklar = set()
    for k in kalemler:
        if not isinstance(k, dict):
            continue
        try:
            adet = float(k.get("adet") or k.get("miktar") or 0)
        except (TypeError, ValueError):
            adet = 0.0
        if adet <= 0:
            continue
        sonuc["kalem"] += 1
        fiyat, kaynak = _kalem_birim_fiyat(k, alis_map, katalog_map, katalog_ad_map)
        if fiyat > 0:
            sonuc["tutar"] += adet * fiyat
            kaynaklar.add(kaynak)
        else:
            sonuc["fiyatsiz"] += 1

    sonuc["tutar"] = round(sonuc["tutar"], 2)
    if len(kaynaklar) == 1:
        sonuc["kaynak"] = kaynaklar.pop()
    elif len(kaynaklar) > 1:
        sonuc["kaynak"] = "kismi"
    return sonuc


def _kalem_fiyat_haritalari(cur, kalemler: Any):
    """Sipariş kalemleri için FİYAT HARİTALARI — tek merkez (alis / katalog / katalog-ad).

    `_teslim_parasal_deger` (beklenen borç) ve `_siparis_kalem_detay` (aday
    motorunun kalem örtüşmesi) AYNI fiyat önceliğini kullanmak zorundadır; iki
    kopya zamanla ayrışır (birinde düzeltilen tuzak diğerinde kalır).
    Hata-yutar: fiyat okunamazsa BOŞ harita döner, çağıran kalem sayımını sürdürür.
    """
    kodlar = set()
    for k in (kalemler if isinstance(kalemler, list) else []):
        if not isinstance(k, dict):
            continue
        for alan in ("kalem_kodu", "urun_id", "depo_stok_kalem_kodu"):
            v = str(k.get(alan) or "").strip()
            if v:
                kodlar.add(v)

    alis_map: Dict[str, float] = {}
    katalog_map: Dict[str, float] = {}
    katalog_ad_map: Dict[str, float] = {}
    try:
        if kodlar:
            # 1) Gerçek alış fiyatı — yalnız yürürlükteki kayıt (gecerli_bitis boş).
            # ⚠️ Tablo adı `urun_alis_fiyat` (tekil); ilk sürümde `alis_fiyatlari`
            # yazmıştım → sorgu hata verip except bloğunda SESSİZCE erken dönüyordu,
            # 10 teslimatın 10'u "kalemsiz" görünüyordu. Şema adını varsayma dersi
            # bugün dördüncü kez çıktı; teşhis çıktısı olmasa körlemesine aranırdı.
            cur.execute(
                """SELECT kalem_kodu, birim_maliyet_tl
                   FROM urun_alis_fiyat
                   WHERE kalem_kodu = ANY(%s) AND gecerli_bitis IS NULL""",
                (list(kodlar),),
            )
            for r in (cur.fetchall() or []):
                d = dict(r)
                alis_map[str(d["kalem_kodu"])] = float(d["birim_maliyet_tl"] or 0)
        # 2) Katalog fiyatı — id VE depo kodu üzerinden, ayrıca ad haritası
        cur.execute(
            """SELECT id::text AS id, ad, depo_stok_kalem_kodu,
                      COALESCE(birim_fiyat_tl,0)::float AS f
               FROM siparis_urun WHERE COALESCE(birim_fiyat_tl,0) > 0"""
        )
        for r in (cur.fetchall() or []):
            d = dict(r)
            katalog_map[str(d["id"])] = d["f"]
            dk = str(d.get("depo_stok_kalem_kodu") or "").strip()
            if dk:
                katalog_map.setdefault(dk, d["f"])
            ad = str(d.get("ad") or "").strip().lower()
            if ad:
                katalog_ad_map.setdefault(ad, d["f"])
    except Exception as e:  # noqa: BLE001
        # Fiyat okunamasa bile ERKEN DÖNME: kalem sayımı ve "fiyatsız" bilgisi
        # yine üretilsin. İlk sürüm burada return ediyordu ve tek bir şema hatası
        # tüm teslimatları "kalemsiz" gösteriyordu — hata gizlenmiş oluyordu.
        logger.warning("teslim parasal deger fiyat okunamadi (kalem sayimi surer): %s", str(e)[:150])
        alis_map, katalog_map, katalog_ad_map = {}, {}, {}
    return alis_map, katalog_map, katalog_ad_map


def _kalem_birim_fiyat(k: Dict[str, Any], alis_map, katalog_map, katalog_ad_map):
    """Tek sipariş kaleminin birim fiyatı — anahtar sırası ürün-aç zinciriyle AYNI:
    kalem_kodu → urun_id → depo_stok_kalem_kodu → normalize ad. (0.0, None) = fiyatsız."""
    for alan in ("kalem_kodu", "urun_id", "depo_stok_kalem_kodu"):
        v = str(k.get(alan) or "").strip()
        if not v:
            continue
        if v in alis_map and alis_map[v] > 0:
            return alis_map[v], "alis"
        if v in katalog_map and katalog_map[v] > 0:
            return katalog_map[v], "katalog"
    ad = str(k.get("urun_ad") or k.get("kalem_adi") or "").strip().lower()
    if ad and katalog_ad_map.get(ad, 0) > 0:
        return katalog_ad_map[ad], "katalog"
    return 0.0, None


def belge_talep_olustur_izole(ts_id: str, *, teslim_tarihi=None) -> None:
    """ŞUBE TESLİM ALINCA çağrılır (urun-sevk'ten). KENDİ transaction'ında çalışır;
    HER hata YUTULUR — teslim-al akışını ASLA bozmaz. İdempotent (ts_id unique).

    ⚠️ teslim_tarihi (2026-08-31): normal akışta None → CURRENT_DATE doğrudur,
    çünkü teslim ŞU AN alınıyor. TELAFİ taramasında ise teslimat geçmişte
    olmuştur; oraya bugünü yazmak 75 günlük bir teslimatı "bugün geldi" diye
    kaydeder ve yaş hesabını, dolayısıyla gecikme alarmını YALANLAR.
    Telafi çağıranı gerçek `toptanci_siparis.teslim_ts` tarihini geçirir.
    """
    tsid = str(ts_id or "").strip()
    if not tsid:
        return
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute("SELECT 1 FROM belge_talep WHERE ts_id=%s", (tsid,))
            if cur.fetchone():
                return  # zaten var
            cur.execute(
                """
                SELECT ts.id, ts.talep_id, ts.sube_id, ts.tedarikci_id,
                       ts.tedarikci_ad, ts.tedarikci_tel, ts.kalemler, s.ad AS sube_adi
                FROM toptanci_siparis ts LEFT JOIN subeler s ON s.id = ts.sube_id
                WHERE ts.id=%s
                """,
                (tsid,),
            )
            r = cur.fetchone()
            if not r:
                return
            t = dict(r)
            # "ÜRÜN ARTIK PARA OLMUŞTUR" — teslimatın beklenen borç değeri.
            # Hata-yutar: fiyat okunamazsa kayıt yine açılır, yalnız tutar boş kalır
            # (teslim-al akışı hiçbir koşulda bozulmaz — bu fonksiyonun ana sözü).
            pd = {"tutar": None, "kalem": None, "fiyatsiz": None, "kaynak": None}
            try:
                pd = _teslim_parasal_deger(cur, t.get("kalemler"))
            except Exception as _e_pd:  # noqa: BLE001
                logger.warning("teslim parasal deger hesaplanamadi: %s", str(_e_pd)[:150])
            # Telefonu olmayan tedarikçi için yine kayıt aç (cep'te "tel yok" gösterilir)
            cur.execute(
                """
                INSERT INTO belge_talep
                    (ts_id, talep_id, sube_id, sube_adi, tedarikci_id, tedarikci_ad,
                     tedarikci_tel, teslim_tarihi,
                     beklenen_tutar_tl, kalem_sayisi, fiyatsiz_kalem, tutar_kaynagi)
                VALUES (%s,%s,%s,%s,%s,%s,%s, COALESCE(%s::date, CURRENT_DATE), %s,%s,%s,%s)
                ON CONFLICT (ts_id) DO NOTHING
                """,
                (tsid, t.get("talep_id"), t.get("sube_id"), t.get("sube_adi"),
                 t.get("tedarikci_id"), t.get("tedarikci_ad"), t.get("tedarikci_tel"),
                 (teslim_tarihi or None),
                 (pd.get("tutar") or None), pd.get("kalem"), pd.get("fiyatsiz"), pd.get("kaynak")),
            )
    except Exception as e:  # noqa: BLE001 — bilerek yutuluyor (teslim-al bozulmasın)
        logger.warning("belge_talep olusturulamadi (yutuldu, teslim-al etkilenmedi): %s", str(e)[:200])
        return
    # FAZ 0 (2026-07-06): omurga olayı — REFERANS ÜRETİCİ. Hata-yutar, kendi bağlantısı,
    # idempotent; teslim-al akışını hiçbir koşulda etkilemez.
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz(
            "acik_teslimat", "tedarik.teslimat.acik_dogdu", tsid,
            entity_scope="tedarikci", entity_id=(t.get("tedarikci_id") or t.get("tedarikci_ad")),
            occurred_at=None, signal_name="Açık teslimat doğdu",
            payload={"sube_adi": t.get("sube_adi"), "tedarikci_ad": t.get("tedarikci_ad")},
        )
    except Exception:  # noqa: BLE001
        pass


@router.get("/telafi-adaylari")
def belge_talep_telafi_adaylari(gun: int = 400):
    """🩹 TESLİM ALINMIŞ AMA BELGE TALEBİ HİÇ AÇILMAMIŞ gönderimler. SALT OKUR.

    ── NEDEN (2026-08-31, canlı ölçüm + Codex/Fable denetimi) ────────────────
    Belge talebini açan tek tetik `sube_panel` teslim-al ucundadır ve yalnız
    gövdede `toptanci_siparis_id` DOLU gelirse çalışır. Bu tetiği kaçıran her
    teslimat — motorun doğduğu 6 Temmuz 2026 öncesindekiler dahil — sistemde
    "mal geldi ama fatura kimse kovalamıyor" olarak kalır.
    Canlı ölçümde 7 gönderim tam bu halde bulundu (72-75 gün yaşında).
    Telafi yolu OLMADIĞI için bu kayıtlar sonsuza kadar kopuk kalıyordu.

    ⚠️ Bu uç SALT OKUR — hiçbir şey yazmaz. Yazan uç ayrıdır (`/telafi-uygula`)
       ve ne yaptığını satır satır döndürür. Görmeden uygulamak yok.
    ⚠️ VERİ UYDURMUYORUZ: teslimat gerçekten olmuş bir olaydır (durum
       'teslim_alindi', teslim_ts dolu). Eksik olan, o olayın doğurması
       gereken TAKİP KAYDIdır. Onu açmak kayıt uydurmak değil, zinciri
       kurmaktır.
    """
    g = max(1, min(730, int(gun or 400)))
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """
            SELECT ts.id, ts.talep_id, ts.tedarikci_ad, ts.sube_id,
                   s.ad AS sube_adi,
                   ts.teslim_ts, ts.durum,
                   (CURRENT_DATE - ts.teslim_ts::date) AS yas_gun,
                   ts.kalemler
              FROM toptanci_siparis ts
              LEFT JOIN subeler s ON s.id = ts.sube_id
             WHERE ts.durum = 'teslim_alindi'
               AND ts.teslim_ts IS NOT NULL
               AND ts.teslim_ts >= CURRENT_DATE - %s
               AND NOT EXISTS (SELECT 1 FROM belge_talep bt WHERE bt.ts_id = ts.id)
             ORDER BY ts.teslim_ts ASC
            """,
            (g,),
        )
        satirlar = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            _kl = d.get("kalemler") or []
            if isinstance(_kl, str):
                try:
                    _kl = json.loads(_kl)
                except Exception:  # noqa: BLE001
                    _kl = []
            satirlar.append({
                "ts_id": str(d.get("id") or ""),
                "talep_id": str(d.get("talep_id") or ""),
                "tedarikci_ad": d.get("tedarikci_ad"),
                "sube_adi": d.get("sube_adi"),
                "teslim_ts": str(d.get("teslim_ts") or ""),
                "yas_gun": int(d.get("yas_gun") or 0),
                "kalem_cesidi": len([x for x in _kl if isinstance(x, dict)]),
                "kalem_ozeti": " · ".join(
                    f"{x.get('urun_ad')} ×{x.get('adet')}"
                    for x in _kl[:4] if isinstance(x, dict)
                ),
            })
    return {
        "gun": g,
        "aday_adet": len(satirlar),
        "en_eski_gun": max((s["yas_gun"] for s in satirlar), default=0),
        "adaylar": satirlar,
        "not": (
            "Bu gönderimlerde mal TESLİM ALINMIŞ ama fatura takip kaydı hiç "
            "açılmamış. Uygulamak için POST /api/belge-talep/telafi-uygula. "
            "Kayıt, teslimatın GERÇEK tarihiyle açılır (bugünle değil) — yoksa "
            "75 günlük bir gecikme 'bugün geldi' diye görünürdü."
        ),
    }


@router.post("/telafi-uygula")
def belge_talep_telafi_uygula(gun: int = 400, en_fazla: int = 100):
    """🩹 Yukarıdaki adaylar için belge talebini AÇAR. İdempotent.

    Her satır için ne yapıldığı ayrı ayrı döndürülür — toplu "başarılı" demez.
    ⚠️ `belge_talep_olustur_izole` hata YUTAR (teslim-al akışını bozmamak için).
       Bu yüzden burada açılıp açılmadığı SONRADAN ölçülür; motorun sözüne
       değil, veritabanının haline bakılır. (SAHTE YEŞİL YASAK)
    """
    aday = belge_talep_telafi_adaylari(gun=gun).get("adaylar") or []
    aday = aday[: max(1, min(500, int(en_fazla or 100)))]
    sonuc = []
    for a in aday:
        tsid = a["ts_id"]
        try:
            belge_talep_olustur_izole(
                tsid, teslim_tarihi=(a.get("teslim_ts") or "")[:10] or None,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("telafi: olusturma cagrisi patladi ts=%s: %s", tsid, str(e)[:150])
        # ÖLÇ: gerçekten açıldı mı?
        try:
            with db() as (_, c2):
                c2.execute("SELECT 1 FROM belge_talep WHERE ts_id=%s", (tsid,))
                acildi = bool(c2.fetchone())
        except Exception as e2:  # noqa: BLE001
            acildi = None
            logger.warning("telafi: dogrulama okunamadi ts=%s: %s", tsid, str(e2)[:150])
        sonuc.append({
            "ts_id": tsid,
            "tedarikci_ad": a.get("tedarikci_ad"),
            "sube_adi": a.get("sube_adi"),
            "yas_gun": a.get("yas_gun"),
            "acildi": acildi,
            "durum": ("acildi" if acildi else
                      ("olculemedi" if acildi is None else "ACILAMADI")),
        })
    _ac = sum(1 for s in sonuc if s["durum"] == "acildi")
    _hata = sum(1 for s in sonuc if s["durum"] == "ACILAMADI")
    _olcusuz = sum(1 for s in sonuc if s["durum"] == "olculemedi")
    return {
        "denenen": len(sonuc),
        "acilan": _ac,
        "acilamayan": _hata,
        "olculemeyen": _olcusuz,
        "satirlar": sonuc,
        "not": (
            f"{_ac} takip kaydı açıldı. "
            + (f"{_hata} kayıt AÇILAMADI — sebebi sunucu günlüğünde. " if _hata else "")
            + (f"{_olcusuz} kaydın sonucu ÖLÇÜLEMEDİ (doğrulama sorgusu düştü). "
               if _olcusuz else "")
            + "Açılan kayıtlar artık fatura kuyruğunda görünür."
        ),
    }


def _tedarikci_ritim_map(cur) -> dict:
    """Tedarikçi belge ritmi: kapanmış taleplerin teslim→kapanış MEDYAN süresi (gün).
    Bağlam sinyalidir — önceliği ayarlar, HİÇBİR ŞEYİ susturmaz (tasarım kuralı #3)."""
    cur.execute(
        """
        SELECT COALESCE(tedarikci_id, tedarikci_ad) AS tkey,
               MAX(tedarikci_ad) AS tedarikci_ad,
               COUNT(*)::int AS kapanan_adet,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
                   GREATEST(0, EXTRACT(EPOCH FROM (kapanma_ts - olusturma)) / 86400.0)
               ) AS medyan_gun
        FROM belge_talep
        WHERE durum <> 'bekliyor' AND kapanma_ts IS NOT NULL
        GROUP BY COALESCE(tedarikci_id, tedarikci_ad)
        """
    )
    return {str(r["tkey"]): {"medyan_gun": round(float(r["medyan_gun"] or 0), 1),
                             "kapanan_adet": int(r["kapanan_adet"])}
            for r in (cur.fetchall() or [])}


def _oncelik(yas_gun: float, rt: Optional[dict]) -> str:
    """Öncelik = bağlam, alarm DEĞİL. Ritmi bilinen tedarikçide yaş/ritim oranı; ritimsizde ham yaş."""
    if rt and rt.get("medyan_gun", 0) > 0:
        m = rt["medyan_gun"]
        return "yuksek" if yas_gun > m * 2 else ("orta" if yas_gun > m else "dusuk")
    return "yuksek" if yas_gun >= 15 else ("orta" if yas_gun >= 7 else "dusuk")


class ElleTalepBody(BaseModel):
    tedarikci_ad: str
    teslim_tarihi: Optional[str] = None   # YYYY-MM-DD; boşsa bugün
    not_metin: Optional[str] = None       # "kahve geldi, irsaliye yok" vb.
    # 💰 2026-08-10 (KONYA SU vakası): borç TUTARI biliniyor ama fatura henüz
    # gelmemiş olabilir. Tutarsız açılan talep "gerçek borç" hesabına giremiyor,
    # sahip 11.200 ₺'lik eksiği hiçbir yerde göremiyordu. Tutar İSTEĞE BAĞLI:
    # biliniyorsa yazılır, bilinmiyorsa boş kalır (uydurma yapılmaz).
    beklenen_tutar_tl: Optional[float] = None


@router.post("/elle")
def belge_talep_elle(body: ElleTalepBody):
    """ELLE FATURA-BEKLENEN kaydı (2026-07-26, ATALAY vakası): mal sistem-dışı geldi
    (toptancı sipariş/teslim-al akışından geçmedi) → hiçbir yerde 'fatura bekleniyor'
    izi doğmuyordu. Sahip tek satırla açar; kapanış aynı /kapat ucundan (kanıt zorunlu)."""
    ad = (body.tedarikci_ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "tedarikci_ad zorunlu")
    tarih = (body.teslim_tarihi or "").strip() or None
    with db() as (_, cur):
        _ensure(cur)
        # Telefonu tedarikçi kartından dene (birebir, sonra içerme) — bulunamazsa boş kalır
        tel = None
        ted_id = None
        try:
            cur.execute("SELECT id, telefon FROM tedarikciler WHERE aktif=TRUE AND LOWER(TRIM(ad))=LOWER(TRIM(%s)) LIMIT 1", (ad,))
            r = cur.fetchone()
            if not r:
                cur.execute("SELECT id, telefon FROM tedarikciler WHERE aktif=TRUE AND (LOWER(ad) LIKE LOWER(%s) OR LOWER(%s) LIKE '%%'||LOWER(TRIM(ad))||'%%') LIMIT 1",
                            ("%" + ad + "%", ad))
                r = cur.fetchone()
            if r:
                ted_id, tel = dict(r).get("id"), dict(r).get("telefon")
        except Exception:  # noqa: BLE001 — tel sadece kolaylık, yokluğu engel değil
            pass
        tid = "elle-" + str(uuid.uuid4())
        cur.execute(
            """INSERT INTO belge_talep
                   (ts_id, sube_adi, tedarikci_id, tedarikci_ad, tedarikci_tel,
                    teslim_tarihi, elle_not, beklenen_tutar_tl)
               VALUES (%s, '(elle kayıt)', %s, %s, %s, COALESCE(%s::date, CURRENT_DATE), %s, %s)
               RETURNING id""",
            (tid, ted_id, ad, tel, tarih, (body.not_metin or "").strip() or None,
             (float(body.beklenen_tutar_tl)
              if body.beklenen_tutar_tl and float(body.beklenen_tutar_tl) > 0 else None)),
        )
        yeni_id = dict(cur.fetchone())["id"]
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz(
            "acik_teslimat", "tedarik.teslimat.acik_dogdu", tid,
            entity_scope="tedarikci", entity_id=(ted_id or ad),
            occurred_at=tarih, signal_name="Açık teslimat doğdu (elle)",
            payload={"tedarikci_ad": ad, "kaynak": "elle"},
        )
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "id": yeni_id}


def _gelen_fatura_ipucu(cur, rows: list) -> None:
    """ÖNERİ-ONLY ipucu: talep sonrası AYNI tedarikçiden sağlıklı fatura geldiyse
    satıra 'gelen_fatura_adet' yazar — kapanış kararı İNSANDA (yanlış teslimatı
    otomatik kapatma riski alınmaz). Token eşleşmesi gevşek; hata YUTULUR."""
    if not rows:
        return
    try:
        try:
            from fatura_api import _JENERIK, _cari_katla  # tek kaynak (SÜTAŞ dersi)
        except Exception:  # noqa: BLE001
            _JENERIK, _cari_katla = set(), (lambda s: str(s or "").upper())

        def _tokenlar(ad):
            return {w.strip(".,()") for w in _cari_katla(ad).split()
                    if len(w.strip(".,()")) >= 3 and w.strip(".,()") not in _JENERIK}

        # 🔴 TÜKETİLMİŞ FATURA HAVUZA GİRMEZ (sahip 2026-08-15: "bir fatura
        # yükleyince diğeri eksik görünmüyordu, iki teslimat olmasına rağmen").
        # İpucu tedarikçi DÜZEYİNDE sayıyor; başka bir teslimata ZATEN bağlanmış
        # fatura da sayılmaya devam ediyordu → tek fatura yüklenince aynı
        # tedarikçinin TÜM açık teslimatları "gelen fatura var" görünüyordu.
        # Bir fatura bir teslimatı kapatır: belge_talep.fatura_id'de kullanılmışsa
        # başka teslimata ipucu OLAMAZ.
        cur.execute(
            """SELECT tedarikci_ad, fatura_tarih::text AS ft, olusturma
               FROM tedarikci_fatura
               WHERE durum IN ('ocr_tamam','okundu') AND COALESCE(toplam_tutar,0) > 0
                 AND olusturma >= NOW() - INTERVAL '45 days'
                 AND NOT EXISTS (SELECT 1 FROM belge_talep bt
                                  WHERE bt.fatura_id = tedarikci_fatura.id)"""
        )
        faturalar = [dict(r) for r in (cur.fetchall() or [])]
        for d in rows:
            tset = _tokenlar(d.get("tedarikci_ad"))
            if not tset:
                continue
            adet = 0
            for f in faturalar:
                if not (tset & _tokenlar(f.get("tedarikci_ad"))):
                    continue
                # fatura talep SONRASI okundu ya da teslim tarihinden yeni tarihli
                ft = str(f.get("ft") or "")
                if str(f.get("olusturma") or "") >= str(d.get("olusturma") or "") or \
                        (ft and ft >= str(d.get("teslim_tarihi") or "9999")):
                    adet += 1
            if adet:
                d["gelen_fatura_adet"] = adet
                # BAĞLAM: ipucu tedarikçi düzeyinde sayıldığı için "1 fatura"
                # tek başına yanıltıcı — kaç açık teslimata karşı geldiği de
                # yazılır. FE ileride "1 yeni fatura / 2 açık teslimat" diyebilir
                # (bu tur FE değişikliği yok, alan hazır bekler).
                d["gelen_fatura_toplam_acik"] = sum(
                    1 for x in rows if tset & _tokenlar(x.get("tedarikci_ad")))
    except Exception as e:  # noqa: BLE001 — ipucu çökse liste yaşar
        logger.warning("gelen fatura ipucu atlandi: %s", str(e)[:120])


@router.get("/bekleyen")
def belge_talep_bekleyen():
    """Cep + masaüstü 'Fatura Beklenen': fatura bekleyen teslimatlar (durum='bekliyor'),
    yaş + mesaj sayısı + AÇIK TESLİMAT bağlamı (tedarikçi ritmi + öncelik) + elle kayıtlar."""
    with db() as (_, cur):
        _ensure(cur)
        ritim = _tedarikci_ritim_map(cur)
        cur.execute(
            """
            SELECT id, ts_id, sube_id, sube_adi, tedarikci_id, tedarikci_ad, tedarikci_tel,
                   teslim_tarihi, durum, mesaj_sayisi, son_mesaj_ts, olusturma, elle_not,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - olusturma)) / 3600.0, 1) AS yas_saat
            FROM belge_talep
            WHERE durum = 'bekliyor'
            ORDER BY olusturma ASC
            """
        )
        rows = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            d["teslim_tarihi"] = str(d.get("teslim_tarihi") or "")
            d["olusturma"] = str(d.get("olusturma") or "")
            d["son_mesaj_ts"] = str(d.get("son_mesaj_ts") or "")
            d["yas_saat"] = float(d.get("yas_saat") or 0)
            d["kaynak"] = "elle" if str(d.get("ts_id") or "").startswith("elle-") else "teslimat"
            _tkey = str(d.get("tedarikci_id") or d.get("tedarikci_ad") or "")
            _rt = ritim.get(_tkey)
            d["ritim_medyan_gun"] = _rt["medyan_gun"] if _rt else None
            d["oncelik"] = _oncelik(d["yas_saat"] / 24.0, _rt)
            rows.append(d)
        _gelen_fatura_ipucu(cur, rows)
    return {"toplam": len(rows), "talepler": rows}


@router.post("/tutar-tazele")
def belge_talep_tutar_tazele(sadece_bos: int = 1):
    """Açık teslimatların BEKLENEN BORÇ değerini (yeniden) hesaplar.

    Neden gerekli: parasal boyut 2026-08-08'de eklendi; o tarihten ÖNCE doğmuş
    teslimatların tutarı boştur (canlıda 4 açık teslimat, en eskisi 18 günlük).
    Ayrıca alış fiyatı sonradan girilen kalemlerde tutar netleşir.

    `sadece_bos=1` (varsayılan): yalnız tutarı boş kayıtları doldurur — mevcut
    hesapları EZMEZ. `sadece_bos=0`: hepsini yeniden hesaplar (fiyat düzeltmesi
    sonrası). Faturası gelmiş (fatura_tutar_tl dolu) kayıtların BEKLENEN değeri
    yine güncellenir ama fark alanı korunur; gerçek tutar fatura tarafındadır.
    """
    guncellenen, atlanan, hata = 0, 0, 0
    with db() as (conn, cur):
        _ensure(cur)
        kosul = "AND bt.beklenen_tutar_tl IS NULL" if sadece_bos else ""
        cur.execute(
            f"""SELECT bt.id, ts.kalemler
                FROM belge_talep bt
                JOIN toptanci_siparis ts ON ts.id = bt.ts_id
                WHERE bt.durum <> 'kapandi' {kosul}"""
        )
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
        for s in satirlar:
            try:
                pd = _teslim_parasal_deger(cur, s.get("kalemler"))
            except Exception:  # noqa: BLE001
                hata += 1
                continue
            if not pd.get("kalem"):
                atlanan += 1
                continue
            cur.execute(
                """UPDATE belge_talep
                   SET beklenen_tutar_tl=%s, kalem_sayisi=%s,
                       fiyatsiz_kalem=%s, tutar_kaynagi=%s,
                       tutar_fark_tl = CASE WHEN fatura_tutar_tl IS NOT NULL
                                            THEN fatura_tutar_tl - %s ELSE tutar_fark_tl END
                   WHERE id=%s""",
                ((pd.get("tutar") or None), pd.get("kalem"), pd.get("fiyatsiz"),
                 pd.get("kaynak"), (pd.get("tutar") or 0), s["id"]),
            )
            guncellenen += 1
        conn.commit()
    return {"guncellenen": guncellenen, "kalemsiz_atlanan": atlanan, "hata": hata,
            "toplam_bakilan": len(satirlar), "sadece_bos": bool(sadece_bos)}


def _ad_norm(s: Optional[str]) -> str:
    """Tedarikçi adı normalizasyonu — Türkçe katlama + gürültü kelime atma."""
    t = (s or "").lower()
    for a, b in (("ı", "i"), ("ğ", "g"), ("ü", "u"), ("ş", "s"), ("ö", "o"), ("ç", "c"), ("â", "a")):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    # Unvan/gürültü kelimeleri: eşleşmeyi bozar ("ATALAY KAHVE" ↔ "MEHMET ATALAY")
    cop = {"ltd", "sti", "as", "anonim", "sirketi", "sirket", "ticaret", "tic", "sanayi",
           "san", "ve", "gida", "kahve", "limited", "sirketi", "enerji", "yatirim", "market"}
    return " ".join(w for w in t.split() if w and w not in cop and len(w) > 2)


# ═══════════════ KALEM ÖRTÜŞMESİ (F4, 2026-08-15) ══════════════════════════
# Sahip dersi (canlı vaka): 8 Ağu teslimatı 1 Ağu faturasına bağlandı çünkü
# TUTAR yakındı. Gerçek kanıt tutar değil, MALIN KENDİSİDİR: "10 kg espresso
# ısmarladık, faturada 10 kg espresso var mı?". Bu blok o kanıtı üretir.
#
# 🔒 DOKTRİN: kalem eşleşmesi EN GÜÇLÜ POZİTİF kanıttır; eşleşmeme NEGATİF
# HÜKÜM DEĞİLDİR. OCR/LLM kalem okuması gürültülüdür (kalem hiç okunmamış,
# yarım okunmuş, farklı adla yazılmış olabilir) — bir adayı "kalemi tutmadı"
# diye ELEMEK sahte-kesinliktir. Eşleşmeme yalnız puanı/güveni düşürür.
#
# 💰 FİYAT SİNYALİ BURADA (ADAY AŞAMASINDA) ALARM TABLOSUNA YAZILMAZ — ama
# BAĞ KURULUNCA YAZILIR. İki aşamanın ayrımı bilinçlidir (2026-08-15):
#   · BURASI = ADAY listesi. Hangi faturanın hangi teslimata ait olduğu HENÜZ
#     BİLİNMİYOR. Yanlış adaya bakıp alarm yazmak sahibin "gerçek zam" listesini
#     gürültüyle doldurur ve geri alınamaz (tablo append-only). Ayrıca
#     /gecmis-eslestir SALT-OKUR bir GET ucudur; okuma ucundan yan-etki yazmak
#     "kasa izi = tek gerçek" disiplinini bozar. → yalnız `fiyat_degisimi` alanı.
#   · BAĞ ANI = `fatura_bagla_uygula` → `_bag_zam_alarmi_yaz` (Z1, aşağıda).
#     Orada fatura ARTIK o teslimatındır (insan onayı taşır) ve alarm YAZILIR.
# Yani soru "OCR'a güvenilir mi" değil, "bağ onaylandı mı"dır.
_KALEM_COP = {
    "kg", "gr", "gram", "lt", "ltr", "litre", "ml", "cl", "adet", "ad", "paket",
    "pkt", "koli", "kutu", "cuval", "torba", "kavanoz", "sise", "kasa", "top",
    "birim", "urun", "no", "lu", "li", "lik", "lik", "gm",
}


def _urun_norm(s: Optional[str]) -> str:
    """Ürün adı normalizasyonu — Türkçe katlama + ölçü/ambalaj gürültüsü atma.

    ⚠️ Türkçe-I tuzağı: 'İ'.lower() Python'da 'i̇' (birleşik) üretir; önce
    büyük-İ elle katlanır, sonra küçültülür. (v2 devir notundaki trKucuk dersi.)
    """
    t = (s or "").replace("İ", "i").replace("I", "ı").lower()
    for a, b in (("ı", "i"), ("ğ", "g"), ("ü", "u"), ("ş", "s"), ("ö", "o"),
                 ("ç", "c"), ("â", "a"), ("î", "i"), ("û", "u")):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9 ]+", " ", t)
    kel = []
    for w in t.split():
        if not w or w in _KALEM_COP:
            continue
        if w.isdigit():          # '10', '500' — ambalaj sayısı, ad değil
            continue
        if len(w) < 3:
            continue
        kel.append(w)
    return " ".join(kel)


def _kalem_benzerlik(a_norm: str, b_norm: str) -> float:
    """0..1 ürün adı benzerliği (token kümesi). Kapsama = 1.0:
    'ESPRESSO ÇEKİRDEK' ⊂ 'ESPRESSO ÇEKİRDEK KAHVE 10 KG' aynı maldır."""
    A, B = set((a_norm or "").split()), set((b_norm or "").split())
    if not A or not B:
        return 0.0
    ortak = A & B
    if not ortak:
        return 0.0
    if A <= B or B <= A:
        return 1.0
    return len(ortak) / len(A | B)


def _siparis_kalem_detay(cur, kalemler: Any) -> list:
    """Teslimatın sipariş kalemleri → {ad, norm, kod, adet, birim_fiyat}.

    Birim fiyat `_teslim_parasal_deger` ile AYNI merkezden (alis → katalog)
    gelir; fiyat_degisimi karşılaştırmasının 'eski' tarafı budur."""
    if not isinstance(kalemler, list) or not kalemler:
        return []
    try:
        alis_map, katalog_map, katalog_ad_map = _kalem_fiyat_haritalari(cur, kalemler)
    except Exception:  # noqa: BLE001 — fiyat düşse de kalem listesi üretilir
        alis_map, katalog_map, katalog_ad_map = {}, {}, {}
    cikti = []
    for k in kalemler:
        if not isinstance(k, dict):
            continue
        ad = str(k.get("urun_ad") or k.get("kalem_adi") or "").strip()
        if not ad:
            continue
        try:
            adet = float(k.get("adet") or k.get("miktar") or 0)
        except (TypeError, ValueError):
            adet = 0.0
        try:
            bf, _kaynak = _kalem_birim_fiyat(k, alis_map, katalog_map, katalog_ad_map)
        except Exception:  # noqa: BLE001
            bf, _kaynak = 0.0, None
        cikti.append({
            "ad": ad, "norm": _urun_norm(ad),
            "kod": str(k.get("kalem_kodu") or "").strip() or None,
            "adet": adet, "birim_fiyat": (float(bf) if bf else None),
            "fiyat_kaynagi": _kaynak,
        })
    return cikti


def _fatura_kalem_detay_toplu(cur, fatura_idler: list) -> Dict[str, list]:
    """Faturaların OCR kalemleri → {fatura_id: [{ad, norm, kod, adet, birim_fiyat}]}.

    KAYNAK SIRASI: (1) `tedarikci_fatura_kalem` — OCR sonrası normalize edilmiş
    kanonik tablo, (2) yedek: `tedarikci_fatura.ocr_json->'kalemler'` (kalem
    tablosuna yazım düşmüşse ham JSON hâlâ okunabilir).
    Hata-yutar: okunamazsa BOŞ döner → 'ölçüm yok' (uyuşmazlık DEĞİL)."""
    sonuc: Dict[str, list] = {}
    if not fatura_idler:
        return sonuc

    def _ekle(fid: str, ad, kod, adet, bf):
        ad = str(ad or "").strip()
        if not ad:
            return
        try:
            adet_f = float(adet or 0)
        except (TypeError, ValueError):
            adet_f = 0.0
        try:
            bf_f = float(bf) if bf not in (None, "") else None
        except (TypeError, ValueError):
            bf_f = None
        sonuc.setdefault(fid, []).append({
            "ad": ad, "norm": _urun_norm(ad),
            "kod": (str(kod).strip() or None) if kod else None,
            "adet": adet_f, "birim_fiyat": bf_f,
        })

    try:
        cur.execute(
            """SELECT fatura_id, ocr_ad, ocr_urun_kodu, adet, birim_fiyat
                 FROM tedarikci_fatura_kalem
                WHERE fatura_id = ANY(%s)
                ORDER BY fatura_id, sira NULLS LAST""", (list(fatura_idler),))
        for r in (cur.fetchall() or []):
            d = dict(r)
            _ekle(str(d["fatura_id"]), d.get("ocr_ad"), d.get("ocr_urun_kodu"),
                  d.get("adet"), d.get("birim_fiyat"))
    except Exception as e:  # noqa: BLE001
        logger.warning("fatura kalem tablosu okunamadi (ocr_json yedegine dusuluyor): %s",
                       str(e)[:120])

    # Yedek: kalem tablosunda satırı olmayan faturalar için ham OCR JSON'u
    eksik = [f for f in fatura_idler if not sonuc.get(f)]
    if eksik:
        try:
            cur.execute(
                "SELECT id::text AS id, ocr_json FROM tedarikci_fatura WHERE id = ANY(%s)",
                (eksik,))
            for r in (cur.fetchall() or []):
                d = dict(r)
                oj = d.get("ocr_json") or {}
                if isinstance(oj, str):
                    try:
                        import json as _j
                        oj = _j.loads(oj)
                    except Exception:  # noqa: BLE001
                        oj = {}
                for k in (oj.get("kalemler") or []) if isinstance(oj, dict) else []:
                    if isinstance(k, dict):
                        _ekle(str(d["id"]), k.get("ad") or k.get("kalem_adi"),
                              k.get("urun_kodu"), k.get("adet") or k.get("miktar"),
                              k.get("birim_fiyat"))
        except Exception as e:  # noqa: BLE001
            logger.warning("ocr_json kalem yedegi okunamadi: %s", str(e)[:120])
    return sonuc


_KALEM_AD_ESIK = 0.5      # altı "aynı ürün" sayılmaz
_MIKTAR_TOLERANS = 0.02   # %2 — birim yuvarlamaları tam eşleşmeyi bozmasın


def _kalem_ortusmesi(sip: list, fat: list) -> Dict[str, Any]:
    """Sipariş kalemleri ↔ fatura kalemleri örtüşmesi (greedy, her fatura satırı
    en fazla BİR sipariş kalemine sayılır — bir satır iki kalemi birden kanıtlamaz).

    Dönüş `olcum=False` → iki taraftan biri kalemsiz: BİLİNMİYOR (uyuşmuyor DEĞİL).
    """
    if not sip or not fat:
        return {"olcum": False, "oran": None, "eslesen_adet": 0, "tam_eslesme": 0,
                "siparis_kalem": len(sip or []), "fatura_kalem": len(fat or []),
                "eslesen": [], "fiyat_degisimi": [],
                "neden": ("sipariş kalemi okunamadı" if not sip else "fatura kalemi okunamadı")}

    kullanilan, eslesen, fiyat_degisimi = set(), [], []
    puan = 0.0
    for s in sip:
        en_i, en_b, en_f = -1, 0.0, None
        for i, f in enumerate(fat):
            if i in kullanilan:
                continue
            if s.get("kod") and f.get("kod") and str(s["kod"]) == str(f["kod"]):
                b = 1.0
            else:
                b = _kalem_benzerlik(s.get("norm"), f.get("norm"))
            if b > en_b:
                en_i, en_b, en_f = i, b, f
        if en_f is None or en_b < _KALEM_AD_ESIK:
            continue
        kullanilan.add(en_i)
        s_adet, f_adet = float(s.get("adet") or 0), float(en_f.get("adet") or 0)
        miktar_ayni = bool(
            s_adet > 0 and f_adet > 0
            and abs(s_adet - f_adet) <= max(0.01, s_adet * _MIKTAR_TOLERANS))
        # Tam ürün+miktar = tam ağırlık; ad tuttu miktar tutmadı = kısmi
        # (kısmi teslimat/iki partili fatura meşrudur, silinmez).
        puan += en_b * (1.0 if miktar_ayni else 0.6)
        eslesen.append({
            "siparis_urun": s.get("ad"), "fatura_urun": en_f.get("ad"),
            "siparis_adet": s_adet, "fatura_adet": f_adet,
            "miktar_ayni": miktar_ayni, "ad_benzerlik": round(en_b, 2),
        })
        eski, yeni = s.get("birim_fiyat"), en_f.get("birim_fiyat")
        if eski and yeni and float(eski) > 0:
            eski_f, yeni_f = float(eski), float(yeni)
            if abs(yeni_f - eski_f) > max(0.01, eski_f * 0.005):
                fiyat_degisimi.append({
                    "urun": en_f.get("ad") or s.get("ad"),
                    "eski": round(eski_f, 4), "yeni": round(yeni_f, 4),
                    "pct": round((yeni_f - eski_f) / eski_f * 100.0, 1),
                    "eski_kaynak": s.get("fiyat_kaynagi"),
                    # ⬇ Z1 (2026-08-15): alarm kaydının KİMLİĞİ. Sipariş kodu
                    # birincil (katalog kimliği), fatura kodu yedek, normalize ad
                    # son çare — dedupe anahtarı bu olduğu için KARARLI olmalı.
                    "kod": (s.get("kod") or en_f.get("kod")
                            or (s.get("norm") or en_f.get("norm") or "")[:60] or None),
                    "siparis_urun": s.get("ad"),
                })
    oran = min(1.0, puan / len(sip)) if sip else 0.0
    return {
        "olcum": True, "oran": round(oran, 3),
        "eslesen_adet": len(eslesen),
        "tam_eslesme": sum(1 for e in eslesen if e["miktar_ayni"]),
        "siparis_kalem": len(sip), "fatura_kalem": len(fat),
        "eslesen": eslesen[:12], "fiyat_degisimi": fiyat_degisimi[:12],
        "neden": None,
    }


def eslestirme_verisi_topla(cur, bugun, gun: int = 120, fatura_idler: Optional[list] = None):
    """Aday motorunun HAM VERİSİ — açık teslimatlar + bağlanmamış faturalar (+kalemler).

    TEK TOPLAYICI: hem GET /gecmis-eslestir hem F5 öneri motoru (yükleme-anı ve
    gece koşusu) buradan besleniyor — üç kopya sorgu zamanla ayrışırdı.
    `fatura_idler` verilirse yalnız o faturalar değerlendirilir (yükleme-anı yolu).
    Dönüş: (teslimatlar, faturalar, ham_faturalar, elenen_hizmet)
    """
    _ensure(cur)
    cur.execute(
        """SELECT id, ts_id, talep_id, tedarikci_ad, sube_adi,
                  teslim_tarihi::text AS tarih,
                  beklenen_tutar_tl::float AS beklenen,
                  GREATEST(0,(CURRENT_DATE - COALESCE(teslim_tarihi, olusturma::date)))::int AS yas
           FROM belge_talep
           WHERE durum = 'bekliyor' AND fatura_id IS NULL
           ORDER BY teslim_tarihi DESC NULLS LAST"""
    )
    teslimatlar = [dict(r) for r in (cur.fetchall() or [])]

    # Henüz bir teslimata bağlanmamış faturalar.
    # 'kopya' durumundakiler HARİÇ — aynı belgenin ikinci kaydı aday olmamalı.
    if fatura_idler:
        cur.execute(
            """SELECT tf.id, tf.tedarikci_ad, tf.fatura_tarih::text AS tarih,
                      COALESCE(tf.toplam_tutar,0)::float AS tutar,
                      tf.siparis_talep_id, tf.durum, tf.belge_sinifi,
                      COALESCE(tf.fatura_no,'') AS fatura_no
               FROM tedarikci_fatura tf
               WHERE tf.id = ANY(%s)
                 AND COALESCE(tf.durum,'') <> 'kopya'
                 AND NOT EXISTS (SELECT 1 FROM belge_talep b WHERE b.fatura_id = tf.id)
               ORDER BY tf.fatura_tarih DESC NULLS LAST""",
            (list(fatura_idler),),
        )
    else:
        cur.execute(
            """SELECT tf.id, tf.tedarikci_ad, tf.fatura_tarih::text AS tarih,
                      COALESCE(tf.toplam_tutar,0)::float AS tutar,
                      tf.siparis_talep_id, tf.durum, tf.belge_sinifi,
                      COALESCE(tf.fatura_no,'') AS fatura_no
               FROM tedarikci_fatura tf
               WHERE COALESCE(tf.fatura_tarih, tf.olusturma::date) >= %s
                 AND COALESCE(tf.durum,'') <> 'kopya'
                 AND NOT EXISTS (SELECT 1 FROM belge_talep b WHERE b.fatura_id = tf.id)
               ORDER BY tf.fatura_tarih DESC NULLS LAST""",
            (bugun - timedelta(days=gun),),
        )
    ham_faturalar = [dict(r) for r in (cur.fetchall() or [])]

    # ── 🏷 SINIF FRENİ (2026-08-08, sahip: "ürüne gelen faturayla elektrik
    # faturası arasında fark var — sistem bunun farkında mı?").
    # belge_talep kuyruğu SADECE mal teslimatıdır (toptanci_siparis'ten doğar).
    # Bir elektrik/su/telekom faturası buraya aday OLAMAZ — adı tesadüfen
    # tedarikçiye benzese bile. Damga yoksa ad heuristiğine düşülür (emniyet ağı).
    try:
        from fatura_api import tedarikci_sinif  # tek kaynak
    except Exception:  # noqa: BLE001
        tedarikci_sinif = lambda _a: "mal"  # noqa: E731 — fren çalışmazsa eski davranış
    faturalar, elenen_hizmet = [], []
    for f in ham_faturalar:
        s = f.get("belge_sinifi") or tedarikci_sinif(f.get("tedarikci_ad"))
        f["belge_sinifi"] = s
        if s == "hizmet":
            elenen_hizmet.append({
                "fatura_id": f["id"], "tedarikci": f.get("tedarikci_ad"),
                "tarih": f.get("tarih"), "tutar": f.get("tutar"),
                "neden": "Gider/abonelik faturası — mal teslimatına bağlanamaz",
            })
            continue
        faturalar.append(f)

    # ── 📦 KALEM VERİSİ — çift döngüden ÖNCE, TEK SEFERDE ────────────────────
    # (N×M sorgu tuzağı: kalemleri _puanla içinde çekmek 5×44 = 220 sorgu ederdi.)
    for t in teslimatlar:
        t["kalemler"] = []
        try:
            if t.get("ts_id"):
                cur.execute("SELECT kalemler FROM toptanci_siparis WHERE id=%s", (t["ts_id"],))
                _r = cur.fetchone()
                if _r:
                    _kl = dict(_r).get("kalemler") or []
                    if isinstance(_kl, str):
                        import json as _j
                        try:
                            _kl = _j.loads(_kl)
                        except Exception:  # noqa: BLE001
                            _kl = []
                    t["kalemler"] = _siparis_kalem_detay(cur, _kl)
        except Exception as e:  # noqa: BLE001 — kalem düşse motor eski hâline döner
            logger.warning("siparis kalemi okunamadi (teslimat %s): %s", t.get("id"), str(e)[:120])
            t["kalemler"] = []
    try:
        _fk = _fatura_kalem_detay_toplu(cur, [f["id"] for f in faturalar])
    except Exception as e:  # noqa: BLE001
        logger.warning("fatura kalemleri okunamadi: %s", str(e)[:120])
        _fk = {}
    for f in faturalar:
        f["kalemler"] = _fk.get(str(f["id"])) or []

    return teslimatlar, faturalar, ham_faturalar, elenen_hizmet


@router.get("/gecmis-eslestir")
def belge_talep_gecmis_eslestir(gun: int = 120):
    """GEÇMİŞE DÖNÜK FATURA ↔ TESLİMAT TARAMASI.

    Sahip (2026-08-08): "geçmişe yönelik de bir tarama ile arama yapması lazım."

    Fatura sisteme girmiş olabilir ama hangi teslimata ait olduğu yazılmamıştır
    (şube fotoğrafı ayrı kanaldan, merkez PDF'i ayrı kanaldan geldi). Canlı örnek:
    açık teslimat "ATALAY KAHVE 25.07" dururken arşivde "MEHMET ATALAY 01.08
    8.261,80 ₺" faturası bağsız bekliyordu.

    İKİ SEVİYE:
      · KESİN  — fatura.siparis_talep_id = belge_talep.talep_id (aynı siparişten
                 doğmuş; başka kanıt gerekmez)
      · ADAY   — tedarikçi adı normalize eşleşmesi + tarih yakınlığı (±30 gün)
                 (+ beklenen tutar varsa yakınlık puanı)

    HÜKÜM YOK: hiçbir bağ otomatik kurulmaz. Liste döner, sahip onaylar
    (POST /belge-talep/{id}/fatura-bagla).
    """
    # Kanonik TR takvim günü — sunucu UTC'de olduğu için date.today() gece
    # yarısından sonra bir gün geride kalıyor (tz tuzağı dersi, 2026-08-07).
    try:
        from tr_saat import bugun_tr
        bugun = bugun_tr()
    except Exception:  # noqa: BLE001
        bugun = date.today()
    with db() as (_c, cur):
        teslimatlar, faturalar, ham_faturalar, elenen_hizmet = eslestirme_verisi_topla(
            cur, bugun, gun)
        kesin, havuz = eslesme_degerlendir(teslimatlar, faturalar)

    havuz.sort(key=lambda x: (not x["onerilen"], -x["puan"]))
    onerilen = [c for c in havuz if c["onerilen"]]
    return {
        "uretildi": str(bugun), "pencere_gun": gun,
        "acik_teslimat_adet": len(teslimatlar),
        "bagsiz_fatura_adet": len(faturalar),
        "taranan_fatura_adet": len(ham_faturalar),
        "elenen_hizmet_adet": len(elenen_hizmet),
        "elenen_hizmet": elenen_hizmet[:25],
        "kesin_eslesme": kesin,
        "onerilen_adet": len(onerilen),
        "aday_eslesme": havuz[:60],
        "puanlama": {
            "ad_max": AD_PUAN, "kalem_max": KALEM_PUAN,
            "tarih_max": TARIH_PUAN, "tutar_max": TUTAR_PUAN,
            "esik": ESIK, "tarih_tavan_gun": TARIH_TAVAN, "tutar_tavan_pct": TUTAR_TAVAN * 100,
            "aciklama": "KALEM = en güçlü kanıt (ısmarlanan ürün+miktar faturada var mı). "
                        "Ad = ortak kelime / birleşim (Jaccard). Tarih = yakınlık eğrisi; "
                        "fatura teslimattan ÖNCE kesilmişse (tarih_yonu_ihlali) puan ¼'e iner "
                        "ama aday ELENMEZ. Tutar = EN ZAYIF bileşen (dünkü yanlış eşleşmenin "
                        "sebebi tutar yakınlığıydı). Kalem/tutar okunamıyorsa NÖTR yarım puan "
                        "(bilinmiyor ≠ uyuşmuyor). Eşik altı listeye girmez.",
        },
        "not": "Hiçbir bağ OTOMATİK kurulmaz. 'onerilen' = karşılıklı en iyi eşleşme "
               "(teslimat bu faturayı, fatura da bu teslimatı en iyi eşi görüyor). "
               "'cakisma' = fatura birden çok teslimata aday. "
               "'kalem_ortusme' = hangi ürünler tuttu; 'fiyat_degisimi' = eşleşen kalemin "
               "birim fiyat sapması. Aday aşamasında bu YALNIZ bir alandır; bağ "
               "kurulduğunda (sahip onayı) fiyat zam alarmı otomatik yazılır. "
               "Onay: POST /belge-talep/{id}/fatura-bagla",
    }


# ══════════════ PUANLAMA ÇEKİRDEĞİ (0-100, deterministik, açıklanabilir) ══════
# İlk sürüm kartezyen çarpım üretiyordu (5 teslimat × 44 fatura) ve aynı fatura
# defalarca listeleniyordu; "hangisi doğru" belli olmuyordu. Kurgu dört ilkeye dayanır:
#   1. Her (teslimat, fatura) çifti TEK KEZ puanlanır.
#   2. Puan dört bileşenin toplamıdır; her bileşenin katkısı cevapta YAZILIR.
#   3. Bir çift ancak KARŞILIKLI EN İYİ ise "önerilen" sayılır — teslimat bu
#      faturayı, fatura da bu teslimatı en iyi eşi olarak görüyorsa.
#   4. (F4, 2026-08-15) KANIT SIRALAMASI DEĞİŞTİ: en güçlü kanıt MALIN KENDİSİ
#      (kalem örtüşmesi), en zayıf kanıt TUTAR'dır. Dünkü yanlış eşleşmenin tek
#      sebebi tutar yakınlığıydı — 30 puanlık tutar bileşeni ad+tarihi eziyordu.
AD_PUAN, KALEM_PUAN, TARIH_PUAN, TUTAR_PUAN = 30.0, 35.0, 25.0, 10.0
ESIK = 35.0          # altı gürültü sayılır, listeye girmez
TARIH_TAVAN = 30     # gün — bu kadar uzak çift zaten aynı sevkiyat olamaz
TUTAR_TAVAN = 0.25   # %25 üstü fark: KALEM KANITI YOKSA eler, varsa yalnız 0 puan
TARIH_YONU_CARPAN = 0.25   # fatura teslimattan önce kesilmiş → tarih puanı ¼


def _cift_puanla(t, f):
    """Tek (teslimat, fatura) çifti → aday satırı | None (eşik altı / eleme).

    🔒 ELEME YALNIZ ÜÇ SEBEPLE: ortak tedarikçi kelimesi yok · tarih tavanı aşıldı ·
    (tutar tavanı aşıldı VE kalem kanıtı yok). Kalem uyuşmazlığı ELEMEZ — OCR
    gürültüsüne dayanarak "bu fatura o teslimatın değil" demek sahte-kesinliktir.
    """
    t_kel = set(_ad_norm(t.get("tedarikci_ad")).split())
    f_kel = set(_ad_norm(f.get("tedarikci_ad")).split())
    ortak = t_kel & f_kel
    if not ortak:
        return None
    # 1) AD — Jaccard: ortak / birleşim (tek kelime tesadüfi eşleşmeyi şişirmesin)
    birlesim = t_kel | f_kel
    ad_oran = len(ortak) / len(birlesim) if birlesim else 0.0
    ad_p = ad_oran * AD_PUAN

    # 2) KALEM ÖRTÜŞMESİ — EN GÜÇLÜ POZİTİF KANIT
    #    ölçüm yoksa (kalem okunamadı) NÖTR yarım puan: bilinmiyor ≠ uyuşmuyor.
    try:
        ko = _kalem_ortusmesi(t.get("kalemler") or [], f.get("kalemler") or [])
    except Exception as _e:  # noqa: BLE001 — kalem motoru düşse aday motoru yaşar
        logger.warning("kalem ortusmesi hesaplanamadi: %s", str(_e)[:120])
        ko = {"olcum": False, "oran": None, "eslesen_adet": 0, "tam_eslesme": 0,
              "siparis_kalem": 0, "fatura_kalem": 0, "eslesen": [], "fiyat_degisimi": [],
              "neden": "kalem karşılaştırması hata verdi"}
    if not ko.get("olcum"):
        kalem_p = KALEM_PUAN * 0.5
    else:
        kalem_p = float(ko.get("oran") or 0.0) * KALEM_PUAN

    # 3) TARİH — yakınlık eğrisi; tavanı aşan çift elenir.
    #    YÖN AYRI BİR ŞEYDİR: fatura teslimattan ÖNCE kesilmişse (1 gün tolerans)
    #    o teslimatın faturası olma ihtimali düşer — ama aday ELENMEZ, işaretlenir
    #    ve puanı ¼'e iner. (fatura-bagla guard'ı zaten ikinci kemer.)
    gun_fark = None
    tarih_yonu_ihlali = False
    if t.get("tarih") and f.get("tarih"):
        try:
            _ft = date.fromisoformat(str(f["tarih"])[:10])
            _tt = date.fromisoformat(str(t["tarih"])[:10])
            gun_fark = abs((_ft - _tt).days)
            tarih_yonu_ihlali = _ft < (_tt - timedelta(days=1))
        except Exception:  # noqa: BLE001
            gun_fark, tarih_yonu_ihlali = None, False
    if gun_fark is not None and gun_fark > TARIH_TAVAN:
        return None
    tarih_p = ((max(0.0, 1 - (gun_fark / TARIH_TAVAN)) * TARIH_PUAN)
               if gun_fark is not None else TARIH_PUAN * 0.5)
    if tarih_yonu_ihlali:
        tarih_p *= TARIH_YONU_CARPAN

    # 4) TUTAR — EN ZAYIF bileşen; beklenen yoksa NÖTR yarım puan
    bek, ftl = float(t.get("beklenen") or 0), float(f.get("tutar") or 0)
    tutar_fark = round(ftl - bek, 2) if (bek and ftl) else None
    tutar_tavan_asildi = False
    if tutar_fark is not None and bek:
        oran = abs(tutar_fark) / bek
        if oran > TUTAR_TAVAN:
            # Kalem kanıtı VARSA eleme yok: kısmi teslimat / iki partili fatura
            # meşrudur ve mal örtüşüyorsa tutar farkı tek başına hüküm veremez.
            if not (ko.get("olcum") and ko.get("eslesen_adet")):
                return None
            tutar_p, tutar_tavan_asildi = 0.0, True
        else:
            tutar_p = max(0.0, 1 - (oran / TUTAR_TAVAN)) * TUTAR_PUAN
    else:
        tutar_p = TUTAR_PUAN * 0.5

    puan = round(ad_p + kalem_p + tarih_p + tutar_p, 1)
    if puan < ESIK:
        return None

    kalem_ozet = (
        f"{ko['tam_eslesme']}/{ko['siparis_kalem']} kalem tam (ürün+miktar)"
        if ko.get("olcum") and ko.get("tam_eslesme")
        else (f"{ko['eslesen_adet']}/{ko['siparis_kalem']} kalem adı tuttu, miktar farklı"
              if ko.get("olcum") and ko.get("eslesen_adet")
              else ("kalem örtüşmesi yok (fatura kalemleri farklı ürünler)"
                    if ko.get("olcum") else f"kalem karşılaştırılamadı ({ko.get('neden')})"))
    )
    return {
        "belge_talep_id": t["id"], "fatura_id": f["id"],
        "tedarikci_teslimat": t.get("tedarikci_ad"), "tedarikci_fatura": f.get("tedarikci_ad"),
        "fatura_no": f.get("fatura_no"),
        "sube_adi": t.get("sube_adi"), "teslim_yas_gun": t.get("yas"),
        "teslim_tarihi": t.get("tarih"), "fatura_tarihi": f.get("tarih"),
        "beklenen_tl": t.get("beklenen"), "fatura_tl": f.get("tutar"),
        "tutar_fark_tl": tutar_fark, "gun_fark": gun_fark,
        "tarih_yonu_ihlali": tarih_yonu_ihlali,
        "tutar_tavan_asildi": tutar_tavan_asildi,
        "ortak_kelime": sorted(ortak),
        "puan": puan,
        "puan_dokumu": {
            "ad": round(ad_p, 1), "kalem": round(kalem_p, 1),
            "tarih": round(tarih_p, 1), "tutar": round(tutar_p, 1),
            "ad_orani_pct": round(ad_oran * 100, 1),
            "kalem_orani_pct": (round(float(ko.get("oran") or 0) * 100, 1)
                                if ko.get("olcum") else None),
        },
        "kalem_ortusme": {
            "olcum": bool(ko.get("olcum")), "oran": ko.get("oran"),
            "tam_eslesme": ko.get("tam_eslesme"), "eslesen_adet": ko.get("eslesen_adet"),
            "siparis_kalem": ko.get("siparis_kalem"), "fatura_kalem": ko.get("fatura_kalem"),
            "eslesen": ko.get("eslesen"), "neden": ko.get("neden"),
        },
        # 💰 FİYAT SİNYALİ (öneri-only): eşleşen kalemin birim fiyatı sipariş
        # tarafındaki (alış/katalog) fiyattan sapmışsa burada yazar.
        # ⛔ fiyat_zam_alarmi tablosuna YAZILMAZ — bkz. modül başındaki not.
        "fiyat_degisimi": ko.get("fiyat_degisimi") or [],
        "gerekce": (f"Ad ortak: {', '.join(sorted(ortak))} (%{ad_oran*100:.0f} örtüşme)"
                    + f" · {kalem_ozet}"
                    + (f" · {gun_fark} gün fark" if gun_fark is not None else " · tarih bilinmiyor")
                    + (" · ⚠ fatura teslimattan ÖNCE kesilmiş" if tarih_yonu_ihlali else "")
                    + (f" · tutar farkı {tutar_fark:+,.2f} ₺" if tutar_fark is not None
                       else " · tutar karşılaştırılamadı")).replace(",", "."),
    }


def eslesme_degerlendir(teslimatlar, faturalar):
    """KESİN + ADAY değerlendirmesi — TEK ÇEKİRDEK.

    GET /gecmis-eslestir (ekran), F5 yükleme-anı öneri motoru ve F5 gece koşusu
    AYNI bu fonksiyonu çağırır. İki kopya mantık yasak: eşik bir yerde değişip
    diğerinde kalırsa "ekran öneriyor ama kuyruk yazmıyor" çelişkisi doğar.

    Dönüş: (kesin_eslesme_listesi, aday_havuzu). Havuz satırları `onerilen`,
    `cakisma`, `guven`, `ne_yapmali` ile işaretlenmiştir. HÜKÜM YOK — hiçbir bağ
    burada kurulmaz.
    """
    # ── KESİN eşleşmeler (aynı sipariş talebi) — puanlamadan bağımsız ─────────
    kesin, kesin_talep, kesin_fatura = [], set(), set()
    for t in teslimatlar:
        for f in faturalar:
            if t.get("talep_id") and f.get("siparis_talep_id") and \
               str(t["talep_id"]) == str(f["siparis_talep_id"]):
                kesin.append({
                    "belge_talep_id": t["id"], "fatura_id": f["id"],
                    "tedarikci_teslimat": t.get("tedarikci_ad"), "tedarikci_fatura": f.get("tedarikci_ad"),
                    "teslim_tarihi": t.get("tarih"), "fatura_tarihi": f.get("tarih"),
                    "beklenen_tl": t.get("beklenen"), "fatura_tl": f.get("tutar"),
                    "gerekce": "Aynı sipariş talebinden doğmuş (siparis_talep_id eşleşiyor)",
                    "ne_yapmali": "Bağla — başka kanıt gerekmez",
                })
                kesin_talep.add(t["id"]); kesin_fatura.add(f["id"])

    # ── ADAY havuzu: her çift TEK KEZ, kesinler hariç ─────────────────────────
    havuz = []
    for t in teslimatlar:
        if t["id"] in kesin_talep:
            continue
        for f in faturalar:
            if f["id"] in kesin_fatura:
                continue
            p = _cift_puanla(t, f)
            if p:
                havuz.append(p)

    # ── KARŞILIKLI EN İYİ: iki taraf da birbirini en iyi görüyorsa "önerilen" ──
    en_iyi_t, en_iyi_f = {}, {}
    for c in havuz:
        a, b = c["belge_talep_id"], c["fatura_id"]
        if a not in en_iyi_t or c["puan"] > en_iyi_t[a]["puan"]:
            en_iyi_t[a] = c
        if b not in en_iyi_f or c["puan"] > en_iyi_f[b]["puan"]:
            en_iyi_f[b] = c
    # Bir fatura kaç teslimata aday? (çakışma uyarısı)
    fatura_aday_sayisi: Dict[str, int] = {}
    for c in havuz:
        fatura_aday_sayisi[c["fatura_id"]] = fatura_aday_sayisi.get(c["fatura_id"], 0) + 1

    for c in havuz:
        karsilikli = (en_iyi_t.get(c["belge_talep_id"], {}).get("fatura_id") == c["fatura_id"]
                      and en_iyi_f.get(c["fatura_id"], {}).get("belge_talep_id") == c["belge_talep_id"])
        c["onerilen"] = bool(karsilikli)
        c["cakisma"] = fatura_aday_sayisi.get(c["fatura_id"], 0) > 1
        guven = ("yüksek" if (karsilikli and c["puan"] >= 70)
                 else "orta" if c["puan"] >= 55 else "düşük")
        # GÜVEN TAVANI: kalem ölçüldü ama HİÇ tutmadıysa ya da tarih yönü ters ise
        # puan yüksek olsa bile "yüksek güven" DENMEZ (eleme değil, frenleme).
        ko = c.get("kalem_ortusme") or {}
        if ko.get("olcum") and not ko.get("eslesen_adet"):
            guven = "düşük" if guven == "yüksek" else guven
            c["guven_freni"] = "kalem örtüşmesi yok"
        if c.get("tarih_yonu_ihlali"):
            guven = "düşük"
            c["guven_freni"] = "fatura teslimattan önce kesilmiş"
        c["guven"] = guven
        c["ne_yapmali"] = (
            "Önerilen eşleşme — kontrol edip bağla" if karsilikli
            else "Alternatif aday; önce önerilen satıra bak"
        )
        if c["cakisma"]:
            c["ne_yapmali"] += " (bu fatura birden çok teslimata aday — tek birine bağlanabilir)"
    return kesin, havuz


class FaturaBaglaBody(BaseModel):
    fatura_id: str
    # 🔒 HAM BIND KAPISI (F3): bağlama ONAY KAYNAĞI olmadan yapılamaz. Dünkü
    # yanlış eşleşme "kim/neye dayanarak bağladı" sorusunu cevapsız bırakmıştı.
    onay_kaynagi: Optional[str] = None      # 'sahip-ui' | 'oneri-onayi' | 'override'
    # 🚧 GUARD AŞMA (F2): tarih yönü / çoklu aday reddini bilerek geçmek için.
    override: bool = False
    override_gerekce: Optional[str] = None


class FaturaBagGeriAlBody(BaseModel):
    gerekce: str


@router.post("/{talep_id}/fatura-bagla-geri-al")
def belge_talep_fatura_bag_geri_al(talep_id: str, body: FaturaBagGeriAlBody):
    """↩️ Yanlış kurulmuş fatura↔teslimat bağını ÇÖZER.

    Canlı ders (2026-08-15): 8-10 Ağustos teslimatları 1 Ağustos faturalarına
    bağlanmıştı; gerçek eşler 13 Ağustos'ta kesilen faturalardı — TUTAR YAKINLIĞI
    yanılttı. Yanlış bağı düzeltecek uç yoktu.

    ⚠️ BAĞLAMA ≠ KAPATMA gibi, GERİ-ALMA ≠ SİLME: fatura kaydına DOKUNULMAZ
    (tedarikci_fatura satırı yerinde durur), yalnız bağ çözülür ve fatura tekrar
    bağlanabilir hâle gelir. Geri alma İZ BIRAKIR: kapanis_aciklama'ya damga
    eklenir (üstüne yazılmaz) — "bu bağ neden çözüldü" sonradan okunabilsin.
    """
    tid = (talep_id or "").strip()
    gerekce = (body.gerekce or "").strip()
    if not tid:
        raise HTTPException(400, "talep_id zorunlu")
    if len(gerekce) < 3:
        raise HTTPException(400, "Gerekçe zorunlu — bağın neden yanlış olduğu yazılmalı")
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute(
            """SELECT id, fatura_id, durum, kapanis_tipi, fatura_tutar_tl,
                      COALESCE(kapanis_aciklama,'') AS kapanis_aciklama
                 FROM belge_talep WHERE id=%s""", (tid,))
        bt = cur.fetchone()
        if not bt:
            raise HTTPException(404, "Belge talep bulunamadı")
        bt = dict(bt)
        if not bt.get("fatura_id"):
            raise HTTPException(409, "Bu teslimatta çözülecek fatura bağı yok.")
        eski_fid = str(bt["fatura_id"])
        # Damgada fatura NUMARASI dursun (id kısası son çare) — sonradan okuyan
        # kişi hangi belgenin yanlış bağlandığını numarasından tanır.
        cur.execute("SELECT COALESCE(fatura_no,'') AS fno FROM tedarikci_fatura WHERE id=%s",
                    (eski_fid,))
        _f = cur.fetchone()
        etiket = (dict(_f).get("fno") if _f else "") or eski_fid[:8]
        damga = (f"[BAĞ GERİ ALINDI {date.today().isoformat()}: "
                 f"eski fatura {etiket} — {gerekce}]")
        yeni_aciklama = f"{bt['kapanis_aciklama']} {damga}".strip()[:1000]
        cur.execute(
            """UPDATE belge_talep
                  SET fatura_id=NULL, durum='bekliyor', kapanma_ts=NULL,
                      kapanis_tipi=NULL, fatura_tutar_tl=NULL, tutar_fark_tl=NULL,
                      kapanis_aciklama=%s
                WHERE id=%s AND fatura_id IS NOT NULL""",
            (yeni_aciklama, tid))
        if cur.rowcount == 0:
            # Bu sırada başkası çözmüş — sessizce "başarılı" deme.
            raise HTTPException(409, "Bağ bu sırada başka bir yerden çözüldü — listeyi yenileyin.")
        try:
            from kasa_service import audit
            audit(cur, 'belge_talep', tid, 'FATURA_BAG_GERI_AL',
                  eski={"fatura_id": eski_fid, "durum": bt.get("durum"),
                        "kapanis_tipi": bt.get("kapanis_tipi"),
                        "fatura_tutar_tl": bt.get("fatura_tutar_tl")},
                  yeni={"fatura_id": None, "durum": "bekliyor", "gerekce": gerekce})
        except Exception as e:  # noqa: BLE001 — audit düşse de bağ çözülmüş kalır
            logger.warning("fatura bag geri al audit atlandi: %s", str(e)[:120])
        conn.commit()
    return {"ok": True, "belge_talep_id": tid, "cozulen_fatura_id": eski_fid,
            "durum": "bekliyor",
            "not": "Bağ çözüldü. Fatura kaydı SİLİNMEDİ — tekrar bağlanabilir. "
                   "Geri alma izi kapanış açıklamasına damgalandı."}


# ⚠️ EŞLEŞTİRME KANITI TUTAR DEĞİL, KİMLİK + TARİH YÖNÜDÜR: fatura tarihi
# teslimattan ÖNCEYSE şüphelen — 1 Ağu fatura / 8 Ağu teslimat vakası (2026-08-15).
@router.post("/{talep_id}/fatura-bagla")
def belge_talep_fatura_bagla(talep_id: str, body: FaturaBaglaBody):
    """Var olan bir faturayı açık teslimata BAĞLAR (dosya yüklemeden).

    Geçmişe dönük taramanın onay adımı. Yükleme akışıyla AYNI sonucu üretir:
    fatura_id damgası + durum 'pdf_geldi' + gerçek tutar + beklenen'e göre fark.
    Yeni fatura kaydı OLUŞTURMAZ — yalnız bağ kurar (mükerrer fatura riski yok).

    İnce sarmalayıcı: bütün iş `fatura_bagla_uygula`'da — onay kuyruğu yolu
    (TESLIMAT_FATURA_ESLESME onayı) AYNI fonksiyonu çağırır, HTTP üzerinden değil.
    """
    return _fatura_bagla_http(talep_id, body)


def _fatura_bagla_http(talep_id: str, body: FaturaBaglaBody):
    tid = (talep_id or "").strip()
    fid = (body.fatura_id or "").strip()
    onay_kaynagi = (body.onay_kaynagi or "").strip().lower()
    zorla = bool(body.override)
    zorla_gerekce = (body.override_gerekce or "").strip()
    with db() as (conn, cur):
        sonuc = fatura_bagla_uygula(cur, tid, fid, onay_kaynagi, zorla, zorla_gerekce)
        conn.commit()
    return sonuc


def fatura_bagla_uygula(cur, talep_id: str, fatura_id: str, onay_kaynagi: str,
                        zorla: bool = False, zorla_gerekce: str = ""):
    """Fatura ↔ teslimat bağını KURAR — tek yazıcı, COMMIT ETMEZ.

    İki çağıran: (1) POST /{id}/fatura-bagla (sahip UI), (2) onay kuyruğundaki
    TESLIMAT_FATURA_ESLESME önerisinin onaylanması (main.py `_onayla_tx`).
    İkinci yol HTTP çağrısı YAPMAZ — aynı transaction içinde bu fonksiyona girer;
    aksi hâlde onay ile bağ ayrı transaction'larda olur ve biri düşerse diğeri
    yalnız kalır (yarım bağ / öksüz onay).

    Commit ÇAĞIRANIN sorumluluğudur (onay yolu kendi tx'ini kapatır).
    """
    tid = (talep_id or "").strip()
    fid = (fatura_id or "").strip()
    if not tid or not fid:
        raise HTTPException(400, "talep_id ve fatura_id zorunlu")
    # ── F3: HAM BIND KAPISI ──────────────────────────────────────────────────
    # Bağ kuran her çağrı NEYE DAYANDIĞINI beyan etmek zorunda. Dünkü yanlış
    # eşleşmede "kim, hangi kanıtla bağladı" sorusu cevapsızdı.
    onay_kaynagi = (onay_kaynagi or "").strip().lower()
    if onay_kaynagi not in ("sahip-ui", "oneri-onayi", "override"):
        raise HTTPException(
            400, "Bağlama onay kaynağı olmadan yapılamaz "
                 "(onay_kaynagi: 'sahip-ui' | 'oneri-onayi' | 'override').")
    zorla = bool(zorla)
    zorla_gerekce = (zorla_gerekce or "").strip()
    if zorla and len(zorla_gerekce) < 3:
        raise HTTPException(400, "override kullanıyorsanız override_gerekce zorunlu.")
    _ensure(cur)
    cur.execute(
        """SELECT id, fatura_id, beklenen_tutar_tl, tedarikci_ad,
                  teslim_tarihi::text AS teslim_tarihi,
                  COALESCE(kapanis_aciklama,'') AS kapanis_aciklama
             FROM belge_talep WHERE id=%s""", (tid,))
    bt = cur.fetchone()
    if not bt:
        raise HTTPException(404, "Belge talep bulunamadı")
    bt = dict(bt)
    if bt.get("fatura_id"):
        raise HTTPException(409, "Bu teslimatın belgesi zaten bağlı.")
    cur.execute(
        """SELECT id, COALESCE(toplam_tutar,0)::float AS tutar,
                  fatura_tarih::text AS fatura_tarih, COALESCE(fatura_no,'') AS fno
             FROM tedarikci_fatura WHERE id=%s""", (fid,))
    f = cur.fetchone()
    if not f:
        raise HTTPException(404, "Fatura bulunamadı")
    f = dict(f)
    cur.execute("SELECT 1 FROM belge_talep WHERE fatura_id=%s", (fid,))
    if cur.fetchone():
        raise HTTPException(409, "Bu fatura başka bir teslimata bağlı.")

    # ── F2-a: TARİH YÖNÜ GUARD'I ────────────────────────────────────────
    # Fatura teslimattan ÖNCE kesilmişse o teslimatın faturası olamaz.
    # Canlı vaka (2026-08-15): 8-10 Ağu teslimatları 1 Ağu faturalarına
    # bağlandı; gerçek eşler 13 Ağu'da kesilmişti — TUTAR YAKINLIĞI yanılttı.
    # 1 gün tolerans: aynı gün/bir gün önce kesilip ertesi gün teslim meşru.
    ft_s, tt_s = str(f.get("fatura_tarih") or ""), str(bt.get("teslim_tarihi") or "")
    tarih_ihlali = False
    if ft_s and tt_s:
        try:
            tarih_ihlali = date.fromisoformat(ft_s[:10]) < (
                date.fromisoformat(tt_s[:10]) - timedelta(days=1))
        except Exception:  # noqa: BLE001 — tarih okunamazsa guard susar
            tarih_ihlali = False
    if tarih_ihlali and not zorla:
        raise HTTPException(
            422, f"Tarih yönü ters: fatura {ft_s[:10]} tarihli, teslimat {tt_s[:10]}. "
                 f"Fatura teslimattan önce kesilmiş — bu teslimatın faturası olmayabilir. "
                 f"Eminseniz override=true & override_gerekce ile zorlayabilirsiniz.")

    # ── F2-b: ÇOKLU GÜÇLÜ ADAY GUARD'I ──────────────────────────────────
    # Aynı tedarikçide, teslim tarihine ±7 gün ve tutarı %15 içinde olan
    # BAĞLANMAMIŞ başka faturalar varsa seçim körlemesine yapılmasın.
    # (Ağır aday motoru burada çağrılmaz — hafif, tek sorgu.)
    rakipler = []
    try:
        cur.execute(
            """SELECT COALESCE(fatura_no,'') AS fno, fatura_tarih::text AS ft
                 FROM tedarikci_fatura tf
                WHERE tf.id <> %s
                  AND COALESCE(tf.durum,'') <> 'kopya'
                  AND tf.tedarikci_ad IS NOT NULL AND %s IS NOT NULL
                  AND UPPER(TRIM(tf.tedarikci_ad)) = UPPER(TRIM(%s))
                  AND tf.fatura_tarih BETWEEN %s::date - 7 AND %s::date + 7
                  AND COALESCE(tf.toplam_tutar,0) > 0
                  AND ABS(COALESCE(tf.toplam_tutar,0) - %s) <= GREATEST(1, %s * 0.15)
                  AND NOT EXISTS (SELECT 1 FROM belge_talep b WHERE b.fatura_id = tf.id)
                ORDER BY tf.fatura_tarih DESC LIMIT 5""",
            (fid, bt.get("tedarikci_ad"), bt.get("tedarikci_ad"), tt_s or None, tt_s or None,
             float(bt.get("beklenen_tutar_tl") or 0), float(bt.get("beklenen_tutar_tl") or 0)))
        rakipler = [dict(r) for r in (cur.fetchall() or [])]
    except Exception as e:  # noqa: BLE001 — guard düşse bağ akışı yaşar
        logger.warning("coklu aday guard atlandi: %s", str(e)[:120])
        rakipler = []
    if rakipler and not zorla:
        _liste = ", ".join(f"{r['fno'] or '(no yok)'} ({str(r['ft'] or '')[:10]})"
                           for r in rakipler[:3])
        raise HTTPException(
            422, f"Bu teslimat için başka güçlü aday(lar) var: {_liste}. "
                 f"Yanlış eşleşme riski — doğru olduğundan eminseniz "
                 f"override=true & override_gerekce ile zorlayabilirsiniz.")

    ftl = float(f.get("tutar") or 0) or None
    # Override kullanıldıysa NEDEN'i deftere damgala (iz kalıcı).
    damga = ""
    if zorla and (tarih_ihlali or rakipler):
        damga = (f"[TARİH-YÖNÜ OVERRIDE: {zorla_gerekce}]" if tarih_ihlali
                 else f"[ÇOKLU-ADAY OVERRIDE: {zorla_gerekce}]")
    yeni_aciklama = f"{bt['kapanis_aciklama']} {damga}".strip()[:1000] if damga else None
    cur.execute(
        """UPDATE belge_talep
           SET durum='pdf_geldi', kapanma_ts=NOW(), fatura_id=%s, kapanis_tipi='fatura',
               fatura_tutar_tl = COALESCE(%s, fatura_tutar_tl),
               tutar_fark_tl = CASE WHEN %s IS NOT NULL AND beklenen_tutar_tl IS NOT NULL
                                    THEN %s - beklenen_tutar_tl ELSE tutar_fark_tl END,
               kapanis_aciklama = COALESCE(%s, kapanis_aciklama)
           WHERE id=%s""",
        (fid, ftl, ftl, ftl, yeni_aciklama, tid),
    )
    # 📜 APPEND-ONLY İZ: HER bağ, kaynağıyla birlikte deftere yazılır. Öneri
    # onayından gelen bağ da (onay_kaynagi='oneri-onayi') "kim/neye dayanarak
    # bağladı" sorusunu cevaplayabilmeli — yalnız override'ı damgalamak yetmez.
    try:
        from kasa_service import audit
        audit(cur, 'belge_talep', tid,
              'FATURA_BAG_OVERRIDE' if damga else 'FATURA_BAGLANDI',
              eski={"tarih_ihlali": tarih_ihlali, "rakip_adet": len(rakipler)},
              yeni={"fatura_id": fid, "onay_kaynagi": onay_kaynagi,
                    "fatura_tutar_tl": ftl,
                    **({"gerekce": zorla_gerekce} if damga else {})})
    except Exception as e:  # noqa: BLE001 — audit düşse de bağ kurulmuş kalır
        logger.warning("fatura bag audit atlandi: %s", str(e)[:120])
    # 💰 Z1 — SAHİP ONAYLI BAĞ = ONAYLI FİYAT KAYNAĞI (2026-08-15)
    zam = _bag_zam_alarmi_yaz(cur, tid, fid, bt.get("tedarikci_ad"), f.get("fno"))
    return {"ok": True, "belge_talep_id": tid, "fatura_id": fid,
            "fatura_tutar_tl": ftl,
            "beklenen_tutar_tl": float(bt.get("beklenen_tutar_tl") or 0) or None,
            "zam_alarmi": zam}


# ═══════════ Z1 · BAĞDAN DOĞAN FİYAT ZAM ALARMI (2026-08-15) ═════════════════
# SAHİP: "ben bu zamları GÖRMEM lazım — ürün bazlı artışı görmem gerekiyor!"
#
# 🔓 F4'TEKİ DOKTRİN KARARI BURADA GEÇERLİ DEĞİL — ve bu bir çelişki değildir:
#   · /gecmis-eslestir bir ADAY listesidir: hangi faturanın hangi teslimata ait
#     olduğu HENÜZ BİLİNMİYOR. Oradan alarm yazmak, yanlış faturanın fiyatını
#     gerçek zam sanmaktı — o yüzden yalnız yanıt alanı olarak döndürüldü.
#   · BURASI ise BAĞIN KURULDUĞU andır. Bağı kuran her yol İNSAN ONAYI taşır
#     (sahip-ui = sahibin tıkı · oneri-onayi = onay kuyruğunda "evet" · override
#     = sahibin gerekçeli zorlaması). Yani fatura ARTIK o teslimatın faturasıdır.
#
# DOKTRİN CÜMLESİ (tek satır — sonradan grep'lenecek çapa):
# OCR tahmini DEĞİL — sahip onaylı bağdan gelen gerçek fatura fiyatı; alarm tetiklenmesi meşru.
#
# ÖNERİ-ONLY korunur: alarm bir SİNYALDİR, fiyat GÜNCELLEMESİ değildir. Katalog/
# alış fiyatına DOKUNULMAZ; sahip "gördüm" der ya da fiyatı kendi onaylar.
def _zam_kaynak_etiketi(tedarikci_ad, fatura_no, fatura_id) -> str:
    """Alarmın KAYNAK açıklaması. Tabloda serbest metin kolonu yok; provenance
    `tedarikci` alanının sonuna eklenir — ekranda zaten ikincil meta satırında
    (`{olusturma} · {tedarikci}`, MaliyetModulu.jsx:2524) gösterildiği için doğru
    yer orası. TABLO ŞEKLİ DEĞİŞMEZ (yeni kolon açmak mevcut yazıcıyla şekil
    ayrışması doğururdu)."""
    fno = (str(fatura_no or "").strip() or str(fatura_id or "")[:8]) or "—"
    ted = (str(tedarikci_ad or "").strip() or "—")
    return f"{ted} · teslimat-fatura bağı (sahip onaylı) — Fatura {fno}"[:200]


def _bag_zam_alarmi_yaz(cur, talep_id: str, fatura_id: str,
                        tedarikci_ad=None, fatura_no=None) -> Dict[str, Any]:
    """Bağlanan faturanın kalemlerini siparişle karşılaştırır → fiyat zam alarmı.

    Karşılaştırma F4 altyapısının AYNISIDIR (`_siparis_kalem_detay`,
    `_fatura_kalem_detay_toplu`, `_kalem_ortusmesi`) — kopya mantık YOK.
    Yazım `operasyon_merkez_api._fiyat_zam_alarmi_yaz` ile, yani eşik (%15
    varsayılan) ve tablo şekli mevcut yazıcıyla BİREBİR.

    ⚠️ SAVEPOINT ZORUNLU: bu fonksiyon ÇAĞIRANIN transaction'ında çalışır ve o
    transaction bir ONAY olabilir. psycopg2'de hatalı sorgu işlemi ABORT eder;
    dahası `_fiyat_zam_alarmi_yaz` istisnayı KENDİ İÇİNDE YUTUYOR (`except: pass`)
    — yutulan hata bile tx'i abort bırakır ve sonraki her sorgu patlar. Bu yüzden
    her kalem kendi SAVEPOINT'inde yazılır ve yazımdan SONRA satır gerçekten
    düştü mü diye BAKILIR (sahte-yeşil önlemi).

    ⚠️ ALARM DÜŞERSE BAĞ YAŞAR: hiçbir istisna dışarı sızmaz.
    """
    ozet = {"bakilan": 0, "yazilan": 0, "mukerrer": 0, "esik_alti": 0, "hata": None}
    try:
        cur.execute("SAVEPOINT sp_zam_hazirlik")
        try:
            cur.execute(
                """SELECT bt.ts_id, ts.kalemler
                     FROM belge_talep bt
                     LEFT JOIN toptanci_siparis ts ON ts.id = bt.ts_id
                    WHERE bt.id=%s""", (str(talep_id),))
            r = cur.fetchone()
            kalemler = (dict(r).get("kalemler") if r else None) or []
            if isinstance(kalemler, str):
                import json as _j
                try:
                    kalemler = _j.loads(kalemler)
                except Exception:  # noqa: BLE001
                    kalemler = []
            sip = _siparis_kalem_detay(cur, kalemler)
            fat = (_fatura_kalem_detay_toplu(cur, [str(fatura_id)]) or {}).get(str(fatura_id)) or []
            cur.execute("RELEASE SAVEPOINT sp_zam_hazirlik")
        except Exception:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_zam_hazirlik")
                cur.execute("RELEASE SAVEPOINT sp_zam_hazirlik")
            except Exception:  # noqa: BLE001
                pass
            raise
        if not sip or not fat:
            ozet["hata"] = "kalem okunamadı (sipariş veya fatura kalemsiz)"
            return ozet

        ko = _kalem_ortusmesi(sip, fat)
        degisim = [d for d in (ko.get("fiyat_degisimi") or []) if float(d.get("pct") or 0) > 0]
        ozet["bakilan"] = len(degisim)
        if not degisim:
            return ozet

        from operasyon_merkez_api import _fiyat_zam_alarmi_yaz   # tek yazıcı
        etiket = _zam_kaynak_etiketi(tedarikci_ad, fatura_no, fatura_id)
        for d in degisim:
            kod = str(d.get("kod") or "").strip()
            if not kod:
                continue
            cur.execute("SAVEPOINT sp_zam_k")
            try:
                # MÜKERRER: aynı (ürün, fatura) ikinci kez yazılmaz. Tablo henüz
                # yoksa mükerrer de olamaz (ilk yazım onu yaratacak).
                cur.execute("SELECT to_regclass('public.fiyat_zam_alarmi') AS t")
                if (cur.fetchone() or {}).get("t"):
                    cur.execute(
                        """SELECT 1 FROM fiyat_zam_alarmi
                            WHERE fatura_id=%s AND kalem_kodu=%s LIMIT 1""",
                        (str(fatura_id), kod))
                    if cur.fetchone():
                        ozet["mukerrer"] += 1
                        cur.execute("RELEASE SAVEPOINT sp_zam_k")
                        continue
                _fiyat_zam_alarmi_yaz(
                    cur, kod, (d.get("siparis_urun") or d.get("urun")),
                    d.get("eski"), d.get("yeni"), etiket, str(fatura_id))
                # 🔴 SAHTE-YEŞİL ÖNLEMİ: yazıcı istisnayı yutuyor → "yazdım" demeden
                # ÖNCE satırın gerçekten düştüğünü doğrula. Düşmediyse iki meşru
                # sebep var: eşik altı artış (%15) ya da yazım hatası — ikisi de
                # "yazıldı" sayılmamalı.
                cur.execute(
                    """SELECT 1 FROM fiyat_zam_alarmi
                        WHERE fatura_id=%s AND kalem_kodu=%s LIMIT 1""",
                    (str(fatura_id), kod))
                if cur.fetchone():
                    ozet["yazilan"] += 1
                else:
                    ozet["esik_alti"] += 1
                cur.execute("RELEASE SAVEPOINT sp_zam_k")
            except Exception as e:  # noqa: BLE001
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_zam_k")
                    cur.execute("RELEASE SAVEPOINT sp_zam_k")
                except Exception:  # noqa: BLE001
                    pass
                logger.warning("zam alarmi kalem atlandi (%s/%s): %s",
                               fatura_id, kod, str(e)[:120])
    except Exception as e:  # noqa: BLE001 — ALARM DÜŞSE DE BAĞ YAŞAR
        ozet["hata"] = str(e)[:200]
        logger.warning("bag zam alarmi atlandi (talep %s / fatura %s): %s",
                       talep_id, fatura_id, str(e)[:200])
    return ozet


@router.post("/zam-tara")
def belge_talep_zam_tara(gun: int = 30):
    """🔧 Z2 — GERİYE DÖNÜK ONARIM: son `gun` günde kurulmuş bağlardan eksik
    kalan fiyat zam alarmlarını üretir.

    Neden gerekli: Z1 bugün açıldı; ondan ÖNCE kurulmuş bağlar (ATALAY espresso
    750→875, FEZ kalemleri) alarm doğurmadan geçti — sahip onayladı ama zammı
    göremedi. Bu uç o boşluğu kapatır.

    · SALT YAZIM, ÖNERİ-ONLY: bağa/faturaya/fiyata DOKUNMAZ, yalnız alarm düşer.
    · İDEMPOTENT: Z1 ile AYNI mükerrer engeli (ürün+fatura) — defalarca
      çağrılabilir, ikinci koşuda hiçbir şey yazmaz.
    · Bağ başına izole: bir teslimatın kalemleri okunamazsa diğerleri sürer.
    """
    g = max(1, min(365, int(gun or 30)))
    sonuc = {"pencere_gun": g, "taranan_bag": 0, "yazilan": 0,
             "mukerrer": 0, "esik_alti": 0, "kalemsiz": 0, "bag": []}
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute(
            """SELECT bt.id, bt.fatura_id, bt.tedarikci_ad,
                      COALESCE(tf.fatura_no,'') AS fno,
                      bt.kapanma_ts::text AS kapanma
                 FROM belge_talep bt
                 LEFT JOIN tedarikci_fatura tf ON tf.id = bt.fatura_id
                WHERE bt.fatura_id IS NOT NULL
                  AND COALESCE(bt.kapanma_ts, bt.olusturma) >= NOW() - (%s * INTERVAL '1 day')
                ORDER BY bt.kapanma_ts DESC NULLS LAST""", (g,))
        baglar = [dict(r) for r in (cur.fetchall() or [])]
        for b in baglar:
            sonuc["taranan_bag"] += 1
            z = _bag_zam_alarmi_yaz(cur, b["id"], b["fatura_id"],
                                    b.get("tedarikci_ad"), b.get("fno"))
            sonuc["yazilan"] += z["yazilan"]
            sonuc["mukerrer"] += z["mukerrer"]
            sonuc["esik_alti"] += z["esik_alti"]
            if z.get("hata"):
                sonuc["kalemsiz"] += 1
            if z["yazilan"] or z["mukerrer"] or z["esik_alti"]:
                sonuc["bag"].append({
                    "belge_talep_id": b["id"], "fatura_no": b.get("fno"),
                    "tedarikci": b.get("tedarikci_ad"), "kapanma": b.get("kapanma"),
                    **{k: z[k] for k in ("bakilan", "yazilan", "mukerrer", "esik_alti")},
                })
        conn.commit()
    sonuc["not"] = (
        "Öneri-only: yalnız ALARM yazıldı — fiyat/katalog/bağ değişmedi. "
        "Alarmlar Maliyet ekranı → 'Fiyat zinciri' bölümünde ürün bazlı listelenir "
        "(/api/ops/fiyat-zam-alarmlari). Eşik altı artışlar (%15) alarm doğurmaz. "
        "İdempotent: tekrar çağırmak mükerrer üretmez."
    )
    return sonuc


# ═══════════ F5 · YÜKSEK GÜVENLİ ÖNERİ → ONAY KUYRUĞU (2026-08-15) ═══════════
# Sahip: "bu motor her gece kendi koşacak mı?" → EVET. İki tetik, TEK MANTIK:
#   · YÜKLEME ANI — fatura okunur okunmaz (OCR biter bitmez) o faturaya bakılır
#   · GECE KOŞUSU — tüm açık teslimatlar × bağlanmamış faturalar taranır
# İkisi de `teslimat_fatura_oneri_tara`'yı çağırır; iki kopya eşik/mantık YASAK
# (biri değişip diğeri kalırsa "gece öneriyor, yükleme önermiyor" çelişkisi doğar).
#
# 🔒 ÖNERİ-ONLY: burada HİÇBİR BAĞ KURULMAZ. Yalnız onay_kuyrugu'na bir satır
# düşer; bağ ancak sahip onaylarsa (main.py `_onayla_tx` → fatura_bagla_uygula,
# onay_kaynagi='oneri-onayi') kurulur. Reddedilirse HİÇBİR ŞEY olmaz.
ONERI_ISLEM_TURU = "TESLIMAT_FATURA_ESLESME"
ONERI_TUTAR_YAKINLIK = 0.10       # kalem kanıtı yoksa tutar bu kadar yakın olmalı


def _oneri_damgasi(fatura_id: str) -> str:
    """Açıklamaya gömülen fatura kimliği. onay_kuyrugu'nun kaynak_id'si TESLİMATtır
    (kayıt dosyası oradan çözülüyor); faturayı taşıyacak ikinci kolon yok →
    açıklamanın SONUNA damgalanır ve onay işleyicisi buradan okur."""
    return f"[fatura:{fatura_id}]"


def _oneri_faturasini_coz(aciklama: Optional[str]) -> Optional[str]:
    """Onay açıklamasındaki [fatura:<id>] damgasını çözer. Yoksa None."""
    m = re.search(r"\[fatura:([^\]]+)\]", str(aciklama or ""))
    return m.group(1).strip() if m else None


def teslimat_fatura_oneri_tara(fatura_idler: Optional[list] = None,
                               kaynak: str = "gece", gun: int = 120) -> Dict[str, Any]:
    """Yüksek güvenli teslimat↔fatura eşleşmelerini ONAY KUYRUĞUNA öneri yazar.

    EŞİK (hepsi birden): karşılıklı-en-iyi · tarih yönü temiz · çakışmasız ·
    (kalem eşleşmesi VAR **veya** tutar %10 içinde). Zayıf adaylar HİÇBİR
    kuyruğa girmez — onay kuyruğu sahibin dikkatidir, gürültüyle doldurulamaz.

    MÜKERRER ENGELİ (gece koşusu her gece aynı öneriyi ÇOĞALTMAMALI):
      · aynı teslimat için BEKLEYEN aynı-tip öneri varsa → yazma
      · aynı (teslimat, fatura) çifti için DAHA ÖNCE herhangi bir öneri
        yazılmışsa (onaylanmış/reddedilmiş dâhil) → yazma. Reddedilmiş bir
        eşleşmeyi her gece tekrar sormak "hayır" cevabına saygısızlıktır.

    Hata-yutar: hiçbir istisna dışarı sızmaz (yükleme akışını ve gece zincirini
    bozmaz). Dönüş özet sözlüğü — çağıran loglar.
    """
    ozet = {"kaynak": kaynak, "bakilan_aday": 0, "yazilan": 0,
            "mukerrer_atlandi": 0, "zayif_atlandi": 0, "oneriler": [], "hata": None}
    try:
        try:
            from tr_saat import bugun_tr
            bugun = bugun_tr()
        except Exception:  # noqa: BLE001
            bugun = date.today()
        from kasa_service import onay_ekle
        with db() as (conn, cur):
            teslimatlar, faturalar, _ham, _elenen = eslestirme_verisi_topla(
                cur, bugun, gun, fatura_idler=fatura_idler)
            if not teslimatlar or not faturalar:
                return ozet
            _kesin, havuz = eslesme_degerlendir(teslimatlar, faturalar)
            for c in havuz:
                if not c.get("onerilen"):
                    continue
                ozet["bakilan_aday"] += 1
                ko = c.get("kalem_ortusme") or {}
                kalem_kaniti = bool(ko.get("olcum") and ko.get("eslesen_adet"))
                bek, ftl = float(c.get("beklenen_tl") or 0), float(c.get("fatura_tl") or 0)
                tutar_yakin = bool(bek and ftl and abs(ftl - bek) / bek <= ONERI_TUTAR_YAKINLIK)
                if (c.get("tarih_yonu_ihlali") or c.get("cakisma")
                        or not (kalem_kaniti or tutar_yakin)):
                    ozet["zayif_atlandi"] += 1
                    continue

                tid, fid = str(c["belge_talep_id"]), str(c["fatura_id"])
                # ── MÜKERRER ENGELİ ──────────────────────────────────────────
                cur.execute(
                    """SELECT 1 FROM onay_kuyrugu
                        WHERE islem_turu=%s AND kaynak_tablo='belge_talep'
                          AND kaynak_id=%s
                          AND (durum='bekliyor' OR aciklama LIKE %s)
                        LIMIT 1""",
                    (ONERI_ISLEM_TURU, tid, f"%{_oneri_damgasi(fid)}%"))
                if cur.fetchone():
                    ozet["mukerrer_atlandi"] += 1
                    continue
                # Fatura başka bir teslimatın bekleyen önerisinde mi? (iki teslimat
                # aynı faturayı bekleyemez — onay sırasında ikincisi 409 alırdı.)
                cur.execute(
                    """SELECT 1 FROM onay_kuyrugu
                        WHERE islem_turu=%s AND durum='bekliyor' AND aciklama LIKE %s
                        LIMIT 1""",
                    (ONERI_ISLEM_TURU, f"%{_oneri_damgasi(fid)}%"))
                if cur.fetchone():
                    ozet["mukerrer_atlandi"] += 1
                    continue

                kanit = []
                if kalem_kaniti:
                    _ilk = (ko.get("eslesen") or [{}])[0]
                    kanit.append(
                        f"kalem {(_ilk.get('fatura_urun') or _ilk.get('siparis_urun') or '')[:30]}"
                        f" {ko.get('tam_eslesme') or 0}/{ko.get('siparis_kalem') or 0} tam")
                if tutar_yakin:
                    kanit.append(f"tutar %{abs(ftl - bek) / bek * 100:.1f} içinde")
                kanit.append("tarih uyumlu")
                fno = (c.get("fatura_no") or "").strip() or fid[:8]
                aciklama = (
                    f"Fatura {fno} ↔ {c.get('sube_adi') or '—'} "
                    f"{str(c.get('teslim_tarihi') or '')[:10]} teslimatı — "
                    f"kanıt: {' + '.join(kanit)} (puan {c['puan']}) {_oneri_damgasi(fid)}"
                )[:500]
                onay_ekle(cur, ONERI_ISLEM_TURU, "belge_talep", tid, aciklama,
                          round(ftl or bek or 0.0, 2),
                          str(c.get("fatura_tarihi") or c.get("teslim_tarihi")
                              or bugun)[:10])
                ozet["yazilan"] += 1
                ozet["oneriler"].append({"belge_talep_id": tid, "fatura_id": fid,
                                         "puan": c["puan"], "aciklama": aciklama})
            conn.commit()
    except Exception as e:  # noqa: BLE001 — öneri motoru hiçbir akışı bozmaz
        ozet["hata"] = str(e)[:200]
        logger.warning("teslimat-fatura oneri taramasi atlandi (%s): %s", kaynak, str(e)[:200])
    return ozet


@router.post("/oneri-tara")
def belge_talep_oneri_tara_ucu(gun: int = 120):
    """F5 öneri taramasını ELLE tetikler (gece koşusunun aynısı — teşhis/ilk kurulum).
    Öneri-only: bağ kurmaz, yalnız onay kuyruğuna aday düşürür."""
    return teslimat_fatura_oneri_tara(kaynak="elle", gun=gun)


@router.get("/acik-teslimat")
def acik_teslimat_ozet():
    """AÇIK TESLİMAT DUYUSU — salt-okur, ALARMSIZ (consistency engine, truth engine değil).

    'Neden hâlâ açık?' ekranı: kapanmamış teslimat yaşlanması + tedarikçi belge ritmi bağlamı.
    Ritim SADECE önceliği ayarlar, hiçbir şeyi susturmaz (tasarım kuralı #3): ay-sonu kesen
    tedarikçinin 20 günlük açığı DÜŞÜK öncelik ama LİSTEDE KALIR. Üç-evren değerlendirmesi
    (tedarikçi kesmedi / personel yüklemedi / kayıt-dışı) İNSANA bırakılır — veri birikmeden
    çıkarım kodlanmaz. Ek blok: İÇ SEVKİYAT yolda yaşlanması (merkez→şube, ayrı evren — S4
    görünürlüğü: sevk edildi ama şube kabul etmedi kayıtları sonsuza dek 'yolda' kalmasın)."""
    with db() as (_, cur):
        _ensure(cur)
        # 1) Açık teslimatlar (yaş gün + tedarikçi kırılımı)
        cur.execute(
            """
            SELECT id, ts_id, sube_adi, tedarikci_id, tedarikci_ad, tedarikci_tel,
                   teslim_tarihi::text AS teslim_tarihi, mesaj_sayisi,
                   -- PARASAL BOYUT (2026-08-08): "bu teslimat ne kadarlık borç?"
                   -- Belgesiz teslimat artık yalnız yaşıyla değil, TUTARIYLA da
                   -- görünür; CFO/vergi tarafı "18 gündür belgesiz 12.400 ₺" der.
                   beklenen_tutar_tl::float AS beklenen_tutar_tl,
                   kalem_sayisi, fiyatsiz_kalem, tutar_kaynagi,
                   fatura_tutar_tl::float AS fatura_tutar_tl,
                   tutar_fark_tl::float AS tutar_fark_tl,
                   GREATEST(0, (CURRENT_DATE - COALESCE(teslim_tarihi, olusturma::date)))::int AS yas_gun
            FROM belge_talep
            WHERE durum = 'bekliyor'
            ORDER BY yas_gun DESC, olusturma ASC
            """
        )
        acik = [dict(r) for r in (cur.fetchall() or [])]

        # 2) Tedarikçi belge ritmi — 'bu tedarikçi genelde X günde kapatır' bağlamı (tek merkez)
        ritim = _tedarikci_ritim_map(cur)

        kovalar = {"0_3": 0, "4_7": 0, "8_14": 0, "15_plus": 0}
        for a in acik:
            g = int(a["yas_gun"])
            tkey = str(a.get("tedarikci_id") or a.get("tedarikci_ad") or "")
            rt = ritim.get(tkey)
            a["ritim_medyan_gun"] = rt["medyan_gun"] if rt else None
            a["ritim_kapanan_adet"] = rt["kapanan_adet"] if rt else 0
            a["oncelik"] = _oncelik(g, rt)
            if g <= 3:
                kovalar["0_3"] += 1
            elif g <= 7:
                kovalar["4_7"] += 1
            elif g <= 14:
                kovalar["8_14"] += 1
            else:
                kovalar["15_plus"] += 1

        # 3) İÇ SEVKİYAT — merkez→şube 'yolda' yaşlanması (ayrı evren, hata-yutar salt-okur)
        ic_sevkiyat = []
        try:
            cur.execute(
                """
                SELECT sy.siparis_talep_id, sy.kalem_kodu, sy.kalem_adi, sy.sevk_adet,
                       COALESCE(s.ad, sy.sube_id::text) AS sube_ad,
                       GREATEST(0, (CURRENT_DATE - sy.sevk_ts::date))::int AS yas_gun
                FROM stok_yolda sy
                LEFT JOIN subeler s ON s.id::text = sy.sube_id::text
                WHERE sy.durum = 'yolda'
                ORDER BY yas_gun DESC
                LIMIT 50
                """
            )
            ic_sevkiyat = [dict(r) for r in (cur.fetchall() or [])]
        except Exception as e:  # noqa: BLE001 — şema farkıysa blok boş kalır, duyu çökmez
            logger.warning("acik-teslimat ic_sevkiyat blogu atlandi: %s", str(e)[:120])

    # PARASAL ÖZET (2026-08-08): "kaç teslimat açık" yetmez — CFO/vergi tarafı
    # "NE KADARLIK borç belgesiz" diye sorar. Tutarı hesaplanamayan teslimat
    # ayrıca sayılır; sıfır göstermek, bilmemekten daha yanlıştır.
    _tutarli = [a for a in acik if a.get("beklenen_tutar_tl")]
    _tutarsiz = [a for a in acik if not a.get("beklenen_tutar_tl")]
    _fiyatsiz_kalemli = [a for a in acik if (a.get("fiyatsiz_kalem") or 0) > 0]
    parasal = {
        "beklenen_borc_tl": round(sum(float(a.get("beklenen_tutar_tl") or 0) for a in acik), 2),
        "tutari_hesaplanan_adet": len(_tutarli),
        "tutari_bilinmeyen_adet": len(_tutarsiz),
        "fiyatsiz_kalemli_adet": len(_fiyatsiz_kalemli),
        "en_eski_tutarli": (max((a.get("yas_gun") or 0) for a in _tutarli) if _tutarli else None),
        "not": "Beklenen borç = teslim kalemleri × (gerçek alış fiyatı, yoksa katalog). "
               "Fatura gelince gerçek tutarla değişir; fark denetim sinyalidir.",
    }

    # ── FATURA SAPMA DENETİMİ (kapanmış teslimatlarda beklenen ↔ gerçek) ───────
    # Vergi/maliyet gözü: fatura siparişten pahalı geldiyse SEBEBİ sorulmalı
    # (zam · fazla kalem · yanlış eşleşme). Ucuz geldiyse eksik teslim ya da
    # iskonto. Bu blok hüküm vermez, farkı GÖRÜNÜR yapar.
    # ⚠️ Bu blok yukarıdaki `with db()` kapsamının DIŞINDA — kendi bağlantısını
    # açar. İlk yazımda dışarıdaki `cur`'u kullanıyordu; kapalı cursor'la çalışma
    # anında patlardı (girinti kontrolüyle yakalandı, canlıya çıkmadan).
    sapma: Dict[str, Any] = {"kayit": 0}
    try:
        with db() as (_c2, cur2):
            cur2.execute(
                """SELECT id, tedarikci_ad, sube_adi, teslim_tarihi::text AS teslim_tarihi,
                          beklenen_tutar_tl::float AS beklenen, fatura_tutar_tl::float AS fatura,
                          tutar_fark_tl::float AS fark
                   FROM belge_talep
                   WHERE fatura_tutar_tl IS NOT NULL AND beklenen_tutar_tl IS NOT NULL
                     AND ABS(COALESCE(tutar_fark_tl,0)) > 0.01
                   ORDER BY ABS(COALESCE(tutar_fark_tl,0)) DESC
                   LIMIT 30"""
            )
            _sap = [dict(r) for r in (cur2.fetchall() or [])]
        for s in _sap:
            b = float(s.get("beklenen") or 0)
            s["sapma_pct"] = round((float(s.get("fark") or 0) / b) * 100, 1) if b else None
            s["yon"] = "fatura pahalı" if float(s.get("fark") or 0) > 0 else "fatura ucuz"
        sapma = {
            "kayit": len(_sap),
            "toplam_fark_tl": round(sum(float(s.get("fark") or 0) for s in _sap), 2),
            "satirlar": _sap,
            "not": "Fark = fatura tutarı − beklenen tutar. Pahalı: zam/fazla kalem/yanlış "
                   "eşleşme olabilir. Ucuz: eksik teslim ya da iskonto. Hüküm yok.",
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("fatura sapma blogu atlandi: %s", str(e)[:120])
    return {
        "acik_toplam": len(acik),
        "parasal": parasal,
        "fatura_sapma": sapma,
        "yas_kovalari": kovalar,
        "acik_teslimatlar": acik,
        "tedarikci_ritim": ritim,
        "ic_sevkiyat_yolda": ic_sevkiyat,
        "ic_sevkiyat_yolda_adet": len(ic_sevkiyat),
        "not": "Salt-okur duyu — alarm üretmez. Öncelik yalnız bağlamdır (yaş vs tedarikçi ritmi); "
               "hiçbir kayıt susturulmaz. Kapanış: fatura / irsaliye / manuel açıklama.",
    }


@router.post("/{talep_id}/mesaj-gonderildi")
def belge_talep_mesaj_gonderildi(talep_id: str):
    """Sahip wa.me'den mesajı gönderince çağrılır → mesaj_sayisi++ (belge ritmi izi)."""
    tid = (talep_id or "").strip()
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            "UPDATE belge_talep SET mesaj_sayisi = mesaj_sayisi + 1, son_mesaj_ts = NOW() WHERE id=%s AND durum='bekliyor'",
            (tid,),
        )
    return {"ok": True}


class KapatBody(BaseModel):
    durum: str = "pdf_geldi"          # pdf_geldi | kapandi (geriye uyum)
    kapanis_tipi: Optional[str] = None    # fatura | irsaliye | manuel
    aciklama: Optional[str] = None        # manuel kapanışta ZORUNLU (kapanış kanıtı)


@router.post("/{talep_id}/kapat")
def belge_talep_kapat(talep_id: str, body: KapatBody = None):
    """AÇIK TESLİMAT kapanışı — üç kanıttan biriyle: fatura / irsaliye / manuel açıklama.
    Manuel kapanışta açıklama ZORUNLU: teslimat sessizce kapanamaz, 'neden kapandı' iz bırakır
    (tasarım: sistem 'neden hâlâ açık?' sorar, 'neden suçlusun?' değil — ama kapanış kanıtsız olmaz).
    Geriye uyum: eski istemciler yalnız durum yollar → kapanis_tipi='manuel' sayılır ama
    açıklamasızsa genel not düşülür (eski davranış kırılmaz)."""
    tid = (talep_id or "").strip()
    durum = (getattr(body, "durum", None) or "pdf_geldi").strip().lower()
    if durum not in ("pdf_geldi", "kapandi"):
        durum = "pdf_geldi"
    tip = (getattr(body, "kapanis_tipi", None) or "").strip().lower()
    if tip and tip not in ("fatura", "irsaliye", "manuel"):
        raise HTTPException(400, "kapanis_tipi: fatura | irsaliye | manuel")
    acik = (getattr(body, "aciklama", None) or "").strip()
    if tip == "manuel" and not acik:
        raise HTTPException(400, "Manuel kapanışta açıklama zorunlu — teslimat kanıtsız kapanamaz "
                                 "(örn. 'irsaliye elden alındı', 'ay sonu faturasına dahil').")
    if not tip:
        # Geriye uyum: tip belirtilmemişse pdf_geldi=fatura, kapandi=manuel say
        tip = "fatura" if durum == "pdf_geldi" else "manuel"
        if tip == "manuel" and not acik:
            acik = "(eski istemci — açıklamasız manuel kapanış)"
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """UPDATE belge_talep
               SET durum=%s, kapanma_ts=NOW(), kapanis_tipi=%s,
                   kapanis_aciklama=COALESCE(NULLIF(%s,''), kapanis_aciklama)
               WHERE id=%s AND durum='bekliyor'
               RETURNING ts_id, tedarikci_id, tedarikci_ad, teslim_tarihi""",
            (durum, tip, acik, tid),
        )
        _kap = cur.fetchone()
    # FAZ 0: omurga olayı + (manuel kapanışta) ground-truth etiketi — hata-yutar
    if _kap:
        try:
            from duyu_omurga import duyu_etiket_yaz, duyu_olay_yaz
            _kd = dict(_kap)
            duyu_olay_yaz(
                "acik_teslimat", "tedarik.teslimat.kapandi", str(_kd.get("ts_id") or tid),
                entity_scope="tedarikci", entity_id=(_kd.get("tedarikci_id") or _kd.get("tedarikci_ad")),
                occurred_at=_kd.get("teslim_tarihi"), signal_name="Teslimat kapandı",
                payload={"kapanis_tipi": tip, "tedarikci_ad": _kd.get("tedarikci_ad")},
            )
            if tip == "manuel" and acik:
                # İnsan kararı = öğretmen verisi: teslimat NEDEN belgesiz kapandı
                duyu_etiket_yaz("manuel_kapanis", tid, insan_karari=acik,
                                detay={"tedarikci_ad": _kd.get("tedarikci_ad")})
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "durum": durum, "kapanis_tipi": tip}


@router.post("/{talep_id}/fatura-yukle")
async def belge_talep_fatura_yukle(talep_id: str, dosya: UploadFile = File(...)):
    """Toptancı WhatsApp'tan faturayı yolladı → sahip cep'ten yükler. Dosya mevcut FATURA
    boru hattına aktarılır (OCR/maliyet ayrı modül), bu teslimata DAMGALANIR (siparis_talep_id
    + belge_talep.fatura_id) ve 'fatura geldi' sinyali yakalanır → belge talebi kapanır.
    Fatura çekirdeği DEĞİŞMEZ; bağ tek yönlü (belge_talep tüketici)."""
    tid = (talep_id or "").strip()
    raw = await dosya.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")

    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT sube_id, talep_id, fatura_id, durum FROM belge_talep WHERE id=%s", (tid,))
        bt = cur.fetchone()
    if not bt:
        raise HTTPException(404, "Belge talep bulunamadı")
    bt = dict(bt)
    # 🛑 katman-2 (2026-07-23, sahip: 'aynı belge iki yerden ekleniyor'):
    # bu talebin belgesi zaten geldi → ikinci yükleme yeni kayıt AÇMAZ
    if bt.get("fatura_id"):
        raise HTTPException(409,
            "Bu teslimatın belgesi zaten yüklendi (fatura bağlı, talep kapalı). "
            "Farklı bir belge ise şube panelindeki fatura yükleme akışını kullan.")
    sube_id = bt.get("sube_id")
    siparis_talep_id = bt.get("talep_id")

    # Fatura modülü yardımcıları — izole import (modül kapalıysa yükleme reddedilir)
    try:
        from fatura_api import (
            _ensure_tablolar, _ocr_calistir, _pdf_faturalara_bol, fatura_modul_aktif,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Fatura modülü yüklenemedi: {str(e)[:120]}")
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")

    ad = (dosya.filename or "").lower()
    is_pdf = ad.endswith(".pdf") or (dosya.content_type or "").lower() == "application/pdf"
    fatura_idler: list[str] = []
    ocr_calisacak: list[str] = []

    with db() as (conn, cur):
        _ensure_tablolar(cur)
        # 🛑 katman-1: birebir aynı dosya başka kanaldan (şube foto) zaten girdiyse dur
        try:
            from fatura_api import dosya_hash_kontrol
            dh, es = dosya_hash_kontrol(cur, raw)
            if es:
                raise HTTPException(409,
                    f"Bu belge zaten sistemde — {es.get('tedarikci_ad') or 'kayıt'} "
                    f"({(es.get('tarih') or es.get('yuklenme') or '')[:10]}). Mükerrer yükleme engellendi.")
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            dh = None  # hash altyapısı yoksa yükleme engellenmez (fail-open)
        if is_pdf:
            try:
                faturalar = _pdf_faturalara_bol(raw)
            except Exception:
                faturalar = []
            if faturalar:
                for f in faturalar:
                    fno = (f.get("fatura_no") or "").strip() or None
                    metin = (f.get("metin") or "").strip()
                    if not metin:
                        continue
                    if fno:
                        cur.execute("SELECT 1 FROM tedarikci_fatura WHERE fatura_no=%s LIMIT 1", (fno,))
                        if cur.fetchone():
                            continue
                    fid = str(uuid.uuid4())
                    # Orijinal PDF de saklanır ('gör' hep açılsın — 2026-07-14 dersi)
                    cur.execute(
                        """
                        INSERT INTO tedarikci_fatura
                            (id, sube_id, siparis_talep_id, fatura_no, fatura_tarih, onceki_bakiye,
                             bakiye_dahil, kaynak_metin, kaynak_tip, durum, foto, foto_mime)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pdf','ocr_bekliyor',%s,'application/pdf')
                        """,
                        (fid, sube_id, siparis_talep_id, fno, f.get("fatura_tarih"),
                         f.get("onceki_bakiye"), f.get("bakiye_dahil"), metin, raw),
                    )
                    fatura_idler.append(fid)
                    ocr_calisacak.append(fid)
            if not fatura_idler:
                # Bölünemeyen PDF → ham dosyayı sakla + bağla (manuel işlenebilir kalır)
                fid = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO tedarikci_fatura
                        (id, sube_id, siparis_talep_id, foto, foto_mime, kaynak_tip, durum)
                    VALUES (%s,%s,%s,%s,'application/pdf','pdf','ocr_bekliyor')
                    """,
                    (fid, sube_id, siparis_talep_id, raw),
                )
                fatura_idler.append(fid)
        else:
            # Görüntü (toptancı foto olarak yolladıysa) → şube foto akışıyla aynı
            mime = dosya.content_type or "image/jpeg"
            fid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO tedarikci_fatura
                    (id, sube_id, siparis_talep_id, foto, foto_mime, durum)
                VALUES (%s,%s,%s,%s,%s,'ocr_bekliyor')
                """,
                (fid, sube_id, siparis_talep_id, raw, mime),
            )
            fatura_idler.append(fid)
            ocr_calisacak.append(fid)

        # katman-1 damgası: bu dosyadan doğan tüm kayıtlara hash yaz (sonraki yüklemeler yakalansın)
        if dh and fatura_idler:
            cur.execute("UPDATE tedarikci_fatura SET dosya_hash=%s WHERE id = ANY(%s)",
                        (dh, fatura_idler))
        # ── BEKLENEN ↔ GERÇEK (2026-08-08, sahip doktrini: fatura gelince borç
        # kesinleşir) ───────────────────────────────────────────────────────────
        # Teslim anında BEKLENEN tutar hesaplanmıştı (kalem × alış/katalog fiyatı).
        # Fatura geldiğinde GERÇEK tutar yazılır ve fark denetim sinyali olur:
        #   fark > 0 → fatura siparişten pahalı (zam? fazla kalem? yanlış eşleşme?)
        #   fark < 0 → eksik teslimat ya da iskonto
        # Vergi/maliyet açısından kritik: borç artık TAHMİN değil BELGELİ tutardır.
        # Çoklu fatura (PDF birden çok fatura içeriyorsa) hepsinin toplamı alınır.
        _fatura_tutar = None
        try:
            if fatura_idler:
                cur.execute(
                    """SELECT COALESCE(SUM(COALESCE(toplam_tutar,0)),0)::float AS t
                       FROM tedarikci_fatura WHERE id = ANY(%s)""",
                    (fatura_idler,),
                )
                _ft = float((dict(cur.fetchone() or {}) or {}).get("t") or 0)
                _fatura_tutar = _ft if _ft > 0 else None
        except Exception as _e_ft:  # noqa: BLE001
            logger.warning("fatura tutari okunamadi (kapanis surer): %s", str(_e_ft)[:120])

        cur.execute(
            """UPDATE belge_talep
               SET durum='pdf_geldi', kapanma_ts=NOW(), fatura_id=%s, kapanis_tipi='fatura',
                   fatura_tutar_tl = COALESCE(%s, fatura_tutar_tl),
                   tutar_fark_tl = CASE
                       WHEN %s IS NOT NULL AND beklenen_tutar_tl IS NOT NULL
                       THEN %s - beklenen_tutar_tl ELSE tutar_fark_tl END
               WHERE id=%s""",
            (fatura_idler[0] if fatura_idler else None,
             _fatura_tutar, _fatura_tutar, _fatura_tutar, tid),
        )
        conn.commit()

    # FAZ 0: omurga olayı (fatura ile kapanış) — hata-yutar, ana akışı etkilemez
    try:
        from duyu_omurga import duyu_olay_yaz
        duyu_olay_yaz(
            "acik_teslimat", "tedarik.teslimat.kapandi", str(bt.get("talep_id") or tid),
            entity_scope="tedarikci", entity_id=None, signal_name="Teslimat kapandı",
            payload={"kapanis_tipi": "fatura", "fatura_adet": len(fatura_idler)},
        )
    except Exception:  # noqa: BLE001
        pass

    # Asenkron OCR — yüklemeyi bekletmeden
    for fid in ocr_calisacak:
        threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()

    return {"ok": True, "durum": "pdf_geldi", "fatura_idler": fatura_idler, "ocr": len(ocr_calisacak)}


# ═══════════════════════════════════════════════════════════════════════════
# 🔗 TEDARİKÇİ ZİNCİR İZİ — SİPARİŞ → TESLİM → BELGE TALEBİ → FATURA
# ═══════════════════════════════════════════════════════════════════════════
@router.get("/zincir-izi")
def belge_talep_zincir_izi(tedarikci: str = "", gun: int = 120, sube: str = ""):
    """🔗 Bir tedarikçinin her siparişini UÇTAN UCA gösterir. SALT OKUR.

    ── NEDEN ───────────────────────────────────────────────────────────────
    Sahip 2026-08-24'te sordu: "FEZ'den ürün teslimi var ama ondan önce şube
    panelinden sipariş var — şube siparişi KABUL ETMİŞ Mİ? FATURASI YÜKLENMİŞ Mİ?"
    Sistem bu soruyu cevaplayamıyordu. Parçalar ayrı uçlardaydı:
        sipariş  → /ops/siparis/toptanci-listesi (gönderimler)
        teslim   → /ops/toptanci-teslimler
        belge    → /belge-talep/bekleyen  ← YALNIZ durum='bekliyor' gösteriyor
        fatura   → /fatura/ara
    Yani KAPANMIŞ ya da HİÇ AÇILMAMIŞ bir belge talebinin akıbeti hiçbir uçtan
    görünmüyordu. Üstelik belge talebi teslim-al akışında `except: pass` ile
    açılıyor (teslimatı bozmasın diye — doğru karar); açılmazsa HİÇ İZ KALMIYOR.
    "Bekleyen listesi boş" o yüzden iki ayrı şeyi birden anlatabiliyordu:
    ya her şey kapandı, ya da hiç kayıt açılmadı. Bu, sahte yeşilin ta kendisi.

    ── NE YAPAR ────────────────────────────────────────────────────────────
    Her gönderim için zinciri kurar ve KOPTUĞU HALKAYI adıyla söyler:
        siparis_ts → teslim_ts → belge_talep(durum) → fatura(no, tarih, tutar)
    `kopuk_halka` alanı şunlardan biridir:
        TESLIM ALINMAMIS        sipariş gitti, şube teslim almadı
        BELGE TALEBI ACILMAMIS  teslim alındı ama fatura kovalama kaydı YOK
        FATURA BEKLENIYOR       talep açık, fatura gelmedi
        FATURA BAGLANMAMIS      talep kapandı ama hangi faturayla belli değil
        (yok)                   zincir tam

    ⚠️ ÖNERİ-ONLY — hiçbir kayıt yazılmaz. Kopuk halka her zaman hata değildir
    (yeni sipariş henüz teslim edilmemiş olabilir); yaş günü birlikte verilir ki
    "daha yeni" ile "unutulmuş" ayırt edilebilsin.
    """
    g = max(1, min(730, int(gun or 120)))
    t = (tedarikci or "").strip()
    with db() as (_, cur):
        _ensure(cur)
        kos = ["ts.olusturma >= NOW() - (%s || ' days')::interval"]
        par: list = [g]
        if t:
            kos.append("(ts.tedarikci_ad ILIKE %s OR td.ad ILIKE %s)")
            par += [f"%{t}%", f"%{t}%"]
        if sube:
            kos.append("(ts.sube_id = %s OR s.ad ILIKE %s)")
            par += [sube, f"%{sube}%"]
        cur.execute(f"""
            SELECT ts.id AS ts_id, ts.talep_id, ts.olusturma AS siparis_ts,
                   ts.teslim_ts, ts.durum AS siparis_durum, ts.kalemler,
                   COALESCE(ts.tedarikci_ad, td.ad) AS tedarikci_ad,
                   ts.tedarikci_id, s.ad AS sube_adi,
                   bt.id AS bt_id, bt.durum AS bt_durum, bt.fatura_id,
                   bt.kapanis_tipi, bt.kapanma_ts, bt.beklenen_tutar_tl::float AS beklenen_tutar,
                   f.fatura_no, f.fatura_tarih::text AS fatura_tarih,
                   COALESCE(f.toplam_tutar,0)::float AS fatura_tutar,
                   f.tedarikci_ad AS fatura_tedarikci_ad
              FROM toptanci_siparis ts
              LEFT JOIN tedarikciler td ON td.id = ts.tedarikci_id
              LEFT JOIN subeler s ON s.id = ts.sube_id
              LEFT JOIN belge_talep bt ON bt.ts_id = ts.id
              LEFT JOIN tedarikci_fatura f ON f.id = bt.fatura_id
             WHERE {' AND '.join(kos)}
             ORDER BY ts.olusturma DESC
        """, tuple(par))
        satirlar = []
        sayac = {"tam": 0, "teslim_yok": 0, "talep_yok": 0, "fatura_yok": 0,
                 "bag_yok": 0, "iptal": 0}
        for r in (cur.fetchall() or []):
            d = dict(r)
            kalemler = d.get("kalemler") or []
            if isinstance(kalemler, str):
                try:
                    kalemler = json.loads(kalemler)
                except Exception:  # noqa: BLE001
                    kalemler = []
            ozet = " · ".join(
                f"{(k.get('urun_ad') or k.get('ad') or '?')} ×{k.get('adet')}"
                for k in (kalemler[:4] if isinstance(kalemler, list) else [])
            )
            if isinstance(kalemler, list) and len(kalemler) > 4:
                ozet += f" … (+{len(kalemler) - 4})"

            # ⛔ İPTAL EDİLEN SİPARİŞ BULGU DEĞİLDİR (2026-08-24)
            # Sahip TEMA'nın 19 Ağustos'taki 8 hatalı siparişini iptal etti;
            # kayıtlar durum='iptal' olarak DURUYOR (geri-alma ≠ silme) ama bu
            # uç durumu okumadığı için hepsini hâlâ "TESLİM ALINMAMIŞ" diye
            # bulgu sayıyordu. Kapatılan bir işi listede tutan duyu, sahibe
            # "hiçbir şey değişmedi" der ve güvenilirliğini yitirir.
            # İz KALIR (satır görünür), ama KOPUK HALKA sayılmaz.
            if str(d.get("siparis_durum") or "") == "iptal":
                kopuk = None; sayac["iptal"] = sayac.get("iptal", 0) + 1
            elif not d.get("teslim_ts"):
                kopuk = "TESLIM ALINMAMIS"; sayac["teslim_yok"] += 1
            elif not d.get("bt_id"):
                kopuk = "BELGE TALEBI ACILMAMIS"; sayac["talep_yok"] += 1
            elif d.get("bt_durum") == "bekliyor":
                kopuk = "FATURA BEKLENIYOR"; sayac["fatura_yok"] += 1
            elif not d.get("fatura_id"):
                kopuk = "FATURA BAGLANMAMIS"; sayac["bag_yok"] += 1
            else:
                kopuk = None; sayac["tam"] += 1

            satirlar.append({
                "ts_id": d["ts_id"], "talep_id": d.get("talep_id"),
                "sube_adi": d.get("sube_adi"), "tedarikci_ad": d.get("tedarikci_ad"),
                "siparis_ts": str(d.get("siparis_ts") or "")[:19],
                "teslim_ts": str(d.get("teslim_ts") or "")[:19] or None,
                "siparis_durum": d.get("siparis_durum"),
                "kalem_ozeti": ozet or None,
                "belge_talep_durum": d.get("bt_durum"),
                "kapanis_tipi": d.get("kapanis_tipi"),
                "kapanma_ts": str(d.get("kapanma_ts") or "")[:19] or None,
                "beklenen_tutar": d.get("beklenen_tutar"),
                "fatura_no": d.get("fatura_no"),
                "fatura_tarih": d.get("fatura_tarih"),
                "fatura_tutar": (d.get("fatura_tutar") or None),
                "fatura_tedarikci_ad": d.get("fatura_tedarikci_ad"),
                # ⚠️ KİMLİK ÇATLAĞI: teslimat tedarikçi KAYDINA (id) bağlıdır,
                # fatura ise tedarikçi ADINA (metin). İkisi farklı yazılmışsa
                # zincir "tam" görünür ama iki AYRI karşı tarafı anlatır.
                "kimlik_uyari": (
                    "teslimat '%s' adına, fatura '%s' adına — aynı karşı taraf mı?"
                    % (d.get("tedarikci_ad"), d.get("fatura_tedarikci_ad"))
                    if (d.get("fatura_tedarikci_ad") and d.get("tedarikci_ad")
                        and str(d.get("tedarikci_ad")).upper()[:6]
                        not in str(d.get("fatura_tedarikci_ad")).upper())
                    else None),
                "kopuk_halka": kopuk,
                "yas_gun": None,
            })
        # yaş: zincirin KOPTUĞU andan bugüne
        for x in satirlar:
            capa = x["teslim_ts"] or x["siparis_ts"]
            try:
                x["yas_gun"] = (datetime.now() - datetime.strptime(capa[:10], "%Y-%m-%d")).days
            except Exception:  # noqa: BLE001
                x["yas_gun"] = None
    return {
        "tedarikci": t or "(hepsi)", "gun": g, "toplam": len(satirlar),
        "ozet": sayac, "satirlar": satirlar,
        "not": ("ÖNERİ-ONLY — hiçbir kayıt yazılmadı. 'kopuk_halka' zincirin nerede "
                "durduğunu söyler; boşsa zincir tamdır. Kopuk halka her zaman hata "
                "değildir (yeni sipariş henüz teslim edilmemiş olabilir) — bu yüzden "
                "yaş_gun birlikte verilir: 'daha yeni' ile 'unutulmuş' ayrılabilsin."),
    }
