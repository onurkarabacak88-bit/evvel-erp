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

import logging
import re
import threading
import uuid
from datetime import date, timedelta
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

    # Kalem anahtarlarını topla
    kodlar, adlar = set(), set()
    for k in kalemler:
        if not isinstance(k, dict):
            continue
        for alan in ("kalem_kodu", "urun_id", "depo_stok_kalem_kodu"):
            v = str(k.get(alan) or "").strip()
            if v:
                kodlar.add(v)
        ad = str(k.get("urun_ad") or k.get("kalem_adi") or "").strip()
        if ad:
            adlar.add(ad.lower())

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
        fiyat, kaynak = 0.0, None
        for alan in ("kalem_kodu", "urun_id", "depo_stok_kalem_kodu"):
            v = str(k.get(alan) or "").strip()
            if not v:
                continue
            if v in alis_map and alis_map[v] > 0:
                fiyat, kaynak = alis_map[v], "alis"
                break
            if v in katalog_map and katalog_map[v] > 0:
                fiyat, kaynak = katalog_map[v], "katalog"
                break
        if fiyat <= 0:
            ad = str(k.get("urun_ad") or k.get("kalem_adi") or "").strip().lower()
            if ad and katalog_ad_map.get(ad, 0) > 0:
                fiyat, kaynak = katalog_ad_map[ad], "katalog"
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


def belge_talep_olustur_izole(ts_id: str) -> None:
    """ŞUBE TESLİM ALINCA çağrılır (urun-sevk'ten). KENDİ transaction'ında çalışır;
    HER hata YUTULUR — teslim-al akışını ASLA bozmaz. İdempotent (ts_id unique)."""
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
                VALUES (%s,%s,%s,%s,%s,%s,%s, CURRENT_DATE, %s,%s,%s,%s)
                ON CONFLICT (ts_id) DO NOTHING
                """,
                (tsid, t.get("talep_id"), t.get("sube_id"), t.get("sube_adi"),
                 t.get("tedarikci_id"), t.get("tedarikci_ad"), t.get("tedarikci_tel"),
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

        cur.execute(
            """SELECT tedarikci_ad, fatura_tarih::text AS ft, olusturma
               FROM tedarikci_fatura
               WHERE durum IN ('ocr_tamam','okundu') AND COALESCE(toplam_tutar,0) > 0
                 AND olusturma >= NOW() - INTERVAL '45 days'"""
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
        cur.execute(
            """SELECT tf.id, tf.tedarikci_ad, tf.fatura_tarih::text AS tarih,
                      COALESCE(tf.toplam_tutar,0)::float AS tutar,
                      tf.siparis_talep_id, tf.durum, tf.belge_sinifi
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

    # ── PUANLAMA (0-100, deterministik ve açıklanabilir) ──────────────────────
    # İlk sürüm kartezyen çarpım üretiyordu (5 teslimat × 44 fatura) ve aynı
    # fatura defalarca listeleniyordu; "hangisi doğru" belli olmuyordu.
    # Yeni kurgu üç ilkeye dayanır:
    #   1. Her (teslimat, fatura) çifti TEK KEZ puanlanır.
    #   2. Puan üç bileşenin toplamıdır; her bileşenin katkısı cevapta YAZILIR.
    #   3. Bir çift ancak KARŞILIKLI EN İYİ ise "önerilen" sayılır — teslimat bu
    #      faturayı, fatura da bu teslimatı en iyi eşi olarak görüyorsa.
    AD_PUAN, TARIH_PUAN, TUTAR_PUAN = 40.0, 30.0, 30.0
    ESIK = 35.0          # altı gürültü sayılır, listeye girmez
    TARIH_TAVAN = 30     # gün
    TUTAR_TAVAN = 0.25   # %25 üstü fark eşleşmeyi öldürür

    def _puanla(t, f):
        t_kel = set(_ad_norm(t.get("tedarikci_ad")).split())
        f_kel = set(_ad_norm(f.get("tedarikci_ad")).split())
        ortak = t_kel & f_kel
        if not ortak:
            return None
        # 1) AD — Jaccard: ortak / birleşim (tek kelime tesadüfi eşleşmeyi şişirmesin)
        birlesim = t_kel | f_kel
        ad_oran = len(ortak) / len(birlesim) if birlesim else 0.0
        ad_p = ad_oran * AD_PUAN

        # 2) TARİH — yakınlık eğrisi; tavanı aşan çift elenir
        gun_fark = None
        if t.get("tarih") and f.get("tarih"):
            try:
                gun_fark = abs((date.fromisoformat(f["tarih"][:10])
                                - date.fromisoformat(t["tarih"][:10])).days)
            except Exception:  # noqa: BLE001
                gun_fark = None
        if gun_fark is not None and gun_fark > TARIH_TAVAN:
            return None
        tarih_p = (max(0.0, 1 - (gun_fark / TARIH_TAVAN)) * TARIH_PUAN) if gun_fark is not None else TARIH_PUAN * 0.5

        # 3) TUTAR — beklenen yoksa NÖTR yarım puan (bilinmiyor ≠ uyuşmuyor)
        bek, ftl = float(t.get("beklenen") or 0), float(f.get("tutar") or 0)
        tutar_fark = round(ftl - bek, 2) if (bek and ftl) else None
        if tutar_fark is not None and bek:
            oran = abs(tutar_fark) / bek
            if oran > TUTAR_TAVAN:
                return None
            tutar_p = max(0.0, 1 - (oran / TUTAR_TAVAN)) * TUTAR_PUAN
        else:
            tutar_p = TUTAR_PUAN * 0.5

        puan = round(ad_p + tarih_p + tutar_p, 1)
        if puan < ESIK:
            return None
        return {
            "belge_talep_id": t["id"], "fatura_id": f["id"],
            "tedarikci_teslimat": t.get("tedarikci_ad"), "tedarikci_fatura": f.get("tedarikci_ad"),
            "sube_adi": t.get("sube_adi"), "teslim_yas_gun": t.get("yas"),
            "teslim_tarihi": t.get("tarih"), "fatura_tarihi": f.get("tarih"),
            "beklenen_tl": t.get("beklenen"), "fatura_tl": f.get("tutar"),
            "tutar_fark_tl": tutar_fark, "gun_fark": gun_fark,
            "ortak_kelime": sorted(ortak),
            "puan": puan,
            "puan_dokumu": {
                "ad": round(ad_p, 1), "tarih": round(tarih_p, 1), "tutar": round(tutar_p, 1),
                "ad_orani_pct": round(ad_oran * 100, 1),
            },
            "gerekce": (f"Ad ortak: {', '.join(sorted(ortak))} (%{ad_oran*100:.0f} örtüşme)"
                        + (f" · {gun_fark} gün fark" if gun_fark is not None else " · tarih bilinmiyor")
                        + (f" · tutar farkı {tutar_fark:+,.2f} ₺" if tutar_fark is not None
                           else " · tutar karşılaştırılamadı")).replace(",", "."),
        }

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
            p = _puanla(t, f)
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
        c["guven"] = ("yüksek" if (karsilikli and c["puan"] >= 70)
                      else "orta" if c["puan"] >= 55 else "düşük")
        c["ne_yapmali"] = (
            "Önerilen eşleşme — kontrol edip bağla" if karsilikli
            else "Alternatif aday; önce önerilen satıra bak"
        )
        if c["cakisma"]:
            c["ne_yapmali"] += " (bu fatura birden çok teslimata aday — tek birine bağlanabilir)"

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
            "ad_max": AD_PUAN, "tarih_max": TARIH_PUAN, "tutar_max": TUTAR_PUAN,
            "esik": ESIK, "tarih_tavan_gun": TARIH_TAVAN, "tutar_tavan_pct": TUTAR_TAVAN * 100,
            "aciklama": "Ad = ortak kelime / birleşim (Jaccard). Tarih = yakınlık eğrisi, "
                        "tavanı aşan çift elenir. Tutar = yüzde fark eğrisi; beklenen tutar "
                        "yoksa NÖTR yarım puan (bilinmiyor ≠ uyuşmuyor). Eşik altı listeye girmez.",
        },
        "not": "Hiçbir bağ OTOMATİK kurulmaz. 'onerilen' = karşılıklı en iyi eşleşme "
               "(teslimat bu faturayı, fatura da bu teslimatı en iyi eşi görüyor). "
               "'cakisma' = fatura birden çok teslimata aday. "
               "Onay: POST /belge-talep/{id}/fatura-bagla",
    }


class FaturaBaglaBody(BaseModel):
    fatura_id: str


@router.post("/{talep_id}/fatura-bagla")
def belge_talep_fatura_bagla(talep_id: str, body: FaturaBaglaBody):
    """Var olan bir faturayı açık teslimata BAĞLAR (dosya yüklemeden).

    Geçmişe dönük taramanın onay adımı. Yükleme akışıyla AYNI sonucu üretir:
    fatura_id damgası + durum 'pdf_geldi' + gerçek tutar + beklenen'e göre fark.
    Yeni fatura kaydı OLUŞTURMAZ — yalnız bağ kurar (mükerrer fatura riski yok).
    """
    tid = (talep_id or "").strip()
    fid = (body.fatura_id or "").strip()
    if not tid or not fid:
        raise HTTPException(400, "talep_id ve fatura_id zorunlu")
    with db() as (conn, cur):
        _ensure(cur)
        cur.execute("SELECT id, fatura_id, beklenen_tutar_tl FROM belge_talep WHERE id=%s", (tid,))
        bt = cur.fetchone()
        if not bt:
            raise HTTPException(404, "Belge talep bulunamadı")
        bt = dict(bt)
        if bt.get("fatura_id"):
            raise HTTPException(409, "Bu teslimatın belgesi zaten bağlı.")
        cur.execute("SELECT id, COALESCE(toplam_tutar,0)::float AS tutar FROM tedarikci_fatura WHERE id=%s", (fid,))
        f = cur.fetchone()
        if not f:
            raise HTTPException(404, "Fatura bulunamadı")
        f = dict(f)
        cur.execute("SELECT 1 FROM belge_talep WHERE fatura_id=%s", (fid,))
        if cur.fetchone():
            raise HTTPException(409, "Bu fatura başka bir teslimata bağlı.")
        ftl = float(f.get("tutar") or 0) or None
        cur.execute(
            """UPDATE belge_talep
               SET durum='pdf_geldi', kapanma_ts=NOW(), fatura_id=%s, kapanis_tipi='fatura',
                   fatura_tutar_tl = COALESCE(%s, fatura_tutar_tl),
                   tutar_fark_tl = CASE WHEN %s IS NOT NULL AND beklenen_tutar_tl IS NOT NULL
                                        THEN %s - beklenen_tutar_tl ELSE tutar_fark_tl END
               WHERE id=%s""",
            (fid, ftl, ftl, ftl, tid),
        )
        conn.commit()
    return {"ok": True, "belge_talep_id": tid, "fatura_id": fid,
            "fatura_tutar_tl": ftl,
            "beklenen_tutar_tl": float(bt.get("beklenen_tutar_tl") or 0) or None}


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
