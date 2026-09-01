"""
🕳️ BAĞSIZ STOK GİRİŞİ DUYUSU — İZOLE (Akıllı Denetim'in tedarik duyusu).

NEDEN KURULDU (canlı bulgu, 2026-09-02 · ATALAY vakası):
  ZAFER şubesine 01.08.2026 19:47'de **Espresso +10** ve **Türk Kahvesi +1**
  girmiş; stok 3 → 13 olmuş, geri alma yok. Ama o teslimatın toptancı
  siparişi `iptal` durumunda: yani mal içeride, sistemde HİÇBİR tedarikçiye
  bağlı değil. Sonuç zinciri:
      tedarikçi bağı yok → belge talebi doğmadı → fatura kovalanmadı
      → borç tahakkuk etmedi → CARİ HESAPTA GÖRÜNMEDİ  (~8.837,50 ₺)

  Ve en kötüsü: **mevcut hiçbir duyu bunu göremiyordu.**
    · `acik-teslimat` (GRNI) yalnız `belge_talep` satırı DOĞMUŞ teslimatları sayar.
    · `telafi-adaylari` yalnız `toptanci_siparis.durum='teslim_alindi'` satırlara bakar.
  Bu kayıt ikisine de düşmüyor (`iptal` + belge talebi yok). `telafi-adaylari: 0`
  derken 10 adet Espresso ortada duruyordu. Kör noktanın adı budur.

ÖLÇTÜĞÜ ŞEY (tek cümle):
  "Depoya mal GİRDİ ama bu girişi hiçbir tedarikçi zincirine bağlayamıyorum."

──────────────────────────────────────────────────────────────────────────────
DUYU DİSİPLİNİ (bkz. memory: feedback_duyu_izole_toplayici_kurali,
                 feedback_duyu_ham_veri_once, feedback_duyu_mimari_disiplin)
  · İZOLE     — kendi tablosu (`bagsiz_giris_gozlem`), başka tabloya YAZMAZ.
  · SALT-OKUR — `sube_depo_stok_hareket`, `toptanci_siparis`, `siparis_talep`
                yalnız OKUNUR; hiçbiri değiştirilmez (tek yön).
  · APPEND-ONLY — gözlem satırı silinmez/güncellenmez; yeni tarama yeni satır.
  · HATA-YUTAR — her yazım savepoint içinde; modül patlasa bile ana akış yaşar.
  · HAM VERİ ÖNCE — eşik UYGULAMAZ, alarm ÜRETMEZ. Bağ bulunamadı bilgisini
    KANITIYLA saklar; "bu kötü mü" hükmünü beyin/insan sonra verir.

⚠️ NEDEN `kaynak_id` YETMEZ (ölçüldü): bağlı olan 08.08 ve 24.08 girişlerinde de
   `kaynak_id` NULL'du. Yani o alan ayırt edici DEĞİL. Bağ, teslim ZAMANI +
   ŞUBE üzerinden kurulur: canlıda eşleşenlerde `toptanci_siparis.teslim_ts`
   hareket zamanıyla SANİYESİ SANİYESİNE aynıydı. Pencere yine de tolerans
   bırakır (varsayılan ±15 dk) — saat kayması bağı koparmasın.

⚠️ İÇ SEVKİYAT MUAF: `SEVK_GIRIS` / `SEVK_UZLASMA` şubeler arası aktarımdır;
   tedarikçi zinciri BEKLENMEZ. Onları "bağsız" saymak sahte kalabalık üretir
   (bu denetimin kendi D-7 dersi).
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from database import db, savepoint

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/duyu-stok", tags=["duyu-stok"])

# Tedarikçiden gelen giriş türleri. İç sevkiyat (SEVK_*) BİLEREK dışarıda.
TEDARIKCI_GIRIS_TURLERI = ("TESLIM_GIRIS",)
# Bağ ararken zaman toleransı (dakika).
BAG_PENCERE_DK = 15


def _ensure_tablolar(cur) -> None:
    """Modülün KENDİ tablosu — lazy, idempotent, izole."""
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bagsiz_giris_gozlem (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            -- Hangi stok hareketi gözlendi (idempotans anahtarı)
            hareket_id      TEXT NOT NULL,
            zaman           TIMESTAMPTZ,
            sube_id         TEXT,
            sube_adi        TEXT,
            kalem_kodu      TEXT,
            kalem_adi       TEXT,
            miktar          NUMERIC(12,4),
            -- Bağ arandı mı, bulundu mu, hangi kanıtla
            bagli           BOOLEAN NOT NULL DEFAULT FALSE,
            bag_kanit       TEXT,          -- 'teslim_ts' | 'kaynak_id' | NULL
            bag_ts_id       TEXT,          -- eşleşen toptanci_siparis
            -- Ham şiddet alanları (normalizasyonu BEYİN yapar — eşik YOK)
            tahmini_tutar   NUMERIC(14,2),
            tutar_kaynagi   TEXT,          -- 'katalog' | 'yok'
            yas_gun         INT,
            ham_detay       JSONB NOT NULL DEFAULT '{}'::jsonb,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    # Aynı hareket için tek gözlem — tarama tekrar koşsa da satır ikilenmez.
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_bagsiz_giris_hareket
        ON bagsiz_giris_gozlem (hareket_id)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS ix_bagsiz_giris_bagli
        ON bagsiz_giris_gozlem (bagli, zaman DESC)
    """)


def _bagsiz_girisleri_bul(cur, gun: int) -> List[Dict[str, Any]]:
    """SALT-OKUR ölçüm: tedarikçi girişleri + bağ durumu.

    Bağ kuralı (kanıt sırasıyla):
      1) `kaynak_id` bir `toptanci_siparis` satırına işaret ediyorsa → BAĞLI
      2) Aynı şubede, hareket zamanının ±`BAG_PENCERE_DK` dakikasında
         `teslim_ts` taşıyan bir `toptanci_siparis` varsa → BAĞLI
      3) Hiçbiri yoksa → BAĞSIZ (öksüz giriş)

    ⚠️ Tutar TAHMİNDİR: katalog birim fiyatından türetilir. Fiyat yoksa NULL
       döner ve `tutar_kaynagi='yok'` yazılır — sıfır yazmak "borç yok"
       yalanı olurdu ("sıfır ile ölçemedim aynı şey değildir" dersi).
    """
    # ⚠️ f-STRING DEGIL (2026-09-02): burada hicbir Python yer tutucusu yok;
    # psycopg2 %s kullaniyor. f-prefix yalnizca SQL yorumlarindaki { } ve
    # JSON ornekleri yuzunden SyntaxError uretiyordu. Duz string daha guvenli.
    cur.execute(
        """
        SELECT h.id::text                         AS hareket_id,
               h.zaman                            AS zaman,
               h.sube_id,
               COALESCE(s.ad, h.sube_id)          AS sube_adi,
               h.kalem_kodu,
               COALESCE(h.kalem_adi, h.kalem_kodu) AS kalem_adi,
               h.miktar::float                    AS miktar,
               h.kaynak_tip, h.kaynak_id,
               (CURRENT_DATE - h.zaman::date)     AS yas_gun,
               su.birim_fiyat_tl::float           AS birim_fiyat,
               -- 1) kaynak_id ile doğrudan bağ
               EXISTS (SELECT 1 FROM toptanci_siparis ts
                        WHERE ts.id::text = h.kaynak_id)            AS bag_kaynak_id,
               -- 2) teslim zamanı + şube ile toptancı siparişi bağı
               (SELECT ts.id::text FROM toptanci_siparis ts
                 WHERE ts.sube_id = h.sube_id
                   AND ts.teslim_ts IS NOT NULL
                   AND ts.teslim_ts BETWEEN h.zaman - (%s * INTERVAL '1 minute')
                                        AND h.zaman + (%s * INTERVAL '1 minute')
                 ORDER BY ABS(EXTRACT(EPOCH FROM (ts.teslim_ts - h.zaman)))
                 LIMIT 1)                                           AS bag_ts_id,
               -- 3) DOĞRUDAN TESLİM KAYDI (2026-09-02 ölçümü sonrası eklendi)
               -- ⚠️ İlk sürüm yalnız (1) ve (2)'ye bakıyordu ve 830 girişin
               -- 716'sını (%%86) "bağsız" saydı — SAHTE KALABALIK. Sebep:
               -- şube "Ürün Teslim Al" ekranından toptancı siparişi OLMADAN da
               -- mal kabul ediyor; o kayıt `operasyon_defter`e URUN_SEVK olarak
               -- tedarikçisiyle birlikte yazılıyor. Tedarikçi ORADA duruyorsa
               -- giriş öksüz DEĞİLDİR. Bir duyu, gürültü üretirse ölçmüyor
               -- demektir (bu denetimin kendi D-7 dersi).
               -- ⚠️ JSON'A HİÇ ÇEVİRME (canlı 500, 2026-09-02): `aciklama`
               -- 'URUN_SEVK_JSON:{...}' önekiyle başlıyor AMA bazı satırlarda
               -- JSON'dan SONRA da metin var ("...} | 3 adet tedarikçi teslimi").
               -- Öneki kesip ::jsonb cast etmek o satırlarda patlıyor ve TÜM
               -- ucu 500 yapıyordu. Tedarikçi alanı METİN olarak çekilir —
               -- ayrıştırma yok, kırılma yok. (POSIX sınıfı kullanılıyor;
               -- ters-bölü kaçışı Python f-string'inde ayrı bir tuzak.)
               (SELECT NULLIF(TRIM(COALESCE(
                          substring(d.aciklama from '"tedarikci_id"[[:space:]]*:[[:space:]]*"([^"]+)"'),
                          substring(d.aciklama from '"tedarikci"[[:space:]]*:[[:space:]]*"([^"]+)"'),
                          substring(d.aciklama from '"tedarikci_ad"[[:space:]]*:[[:space:]]*"([^"]+)"'))), '')
                  FROM operasyon_defter d
                 WHERE d.etiket = 'URUN_SEVK'
                   AND d.sube_id = h.sube_id
                   AND d.olay_ts BETWEEN h.zaman - (%s * INTERVAL '1 minute')
                                     AND h.zaman + (%s * INTERVAL '1 minute')
                   AND d.aciklama LIKE 'URUN_SEVK_JSON:%%'
                 ORDER BY ABS(EXTRACT(EPOCH FROM (d.olay_ts - h.zaman)))
                 LIMIT 1)                                           AS bag_defter
          FROM sube_depo_stok_hareket h
          LEFT JOIN subeler s      ON s.id = h.sube_id
          LEFT JOIN siparis_urun su ON su.id::text = h.kalem_kodu
         WHERE h.zaman >= NOW() - (%s * INTERVAL '1 day')
           AND h.miktar > 0
           AND h.hareket_turu = ANY(%s)
         ORDER BY h.zaman DESC
        """,
        (BAG_PENCERE_DK, BAG_PENCERE_DK, BAG_PENCERE_DK, BAG_PENCERE_DK,
         gun, list(TEDARIKCI_GIRIS_TURLERI)),
    )
    out: List[Dict[str, Any]] = []
    for r in (cur.fetchall() or []):
        d = dict(r)
        # 3 KANIT — herhangi biri yeterli. Sira: en gucluden en zayifa.
        bagli = bool(d.get("bag_kaynak_id") or d.get("bag_ts_id") or d.get("bag_defter"))
        kanit = ("kaynak_id" if d.get("bag_kaynak_id")
                 else "teslim_ts" if d.get("bag_ts_id")
                 else "teslim_kaydi" if d.get("bag_defter") else None)
        bf = d.get("birim_fiyat")
        mik = float(d.get("miktar") or 0)
        out.append({
            "hareket_id": d["hareket_id"],
            "zaman": str(d.get("zaman") or ""),
            "sube_id": d.get("sube_id"),
            "sube_adi": d.get("sube_adi"),
            "kalem_kodu": d.get("kalem_kodu"),
            "kalem_adi": d.get("kalem_adi"),
            "miktar": mik,
            "bagli": bagli,
            "bag_kanit": kanit,
            "bag_ts_id": d.get("bag_ts_id"),
            "bag_defter_ted": d.get("bag_defter"),
            "yas_gun": int(d.get("yas_gun") or 0),
            "tahmini_tutar": (round(float(bf) * mik, 2) if bf else None),
            "tutar_kaynagi": ("katalog" if bf else "yok"),
        })
    return out


@router.get("/bagsiz-giris")
def bagsiz_giris_olc(gun: int = Query(90, ge=1, le=730),
                     tumu: int = Query(0, ge=0, le=1),
                     sube: str = Query(""),
                     kalem: str = Query("")):
    """🔎 SALT-OKUR ÖLÇÜM — hiçbir şey yazmaz.

    "Depoya mal girdi ama hiçbir tedarikçi zincirine bağlanamıyor" satırları.
    Bağlı girişler de sayılır (kıyas için) — yalnız bağsızları göstermek
    "hep kötü haber" ekranı üretir ve oranı gizler.
    """
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        satirlar = _bagsiz_girisleri_bul(cur, gun)
    bagsiz = [s for s in satirlar if not s["bagli"]]
    _tutarli = [s for s in bagsiz if s["tahmini_tutar"] is not None]
    # 🔬 KENDİNİ AÇIKLAYAN DUYU (2026-09-02): `tumu=1` BAĞLI satırları da
    # KANITIYLA döndürür. Olmadan "bu giriş neden bağsız sayılmadı" sorusu
    # dolaylı uçlarla kovalanıyor ve cevap bulunamıyordu. Bir duyu, kendi
    # hükmünün gerekçesini gösteremiyorsa denetlenemez.
    _goster = satirlar if int(tumu or 0) else bagsiz
    if sube:
        _sl = sube.lower()
        _goster = [x for x in _goster if _sl in str(x.get("sube_adi") or "").lower()]
    if kalem:
        _kl = kalem.lower()
        _goster = [x for x in _goster if _kl in str(x.get("kalem_adi") or "").lower()]
    # 📊 HAM DAĞILIM — hangi kanıt kaç kez tuttu. Bu olmadan "bağsız" sayısı
    # yorumlanamaz: oran yüksekse duyu değil KURAL yanlıştır (ilk sürüm 830'un
    # 716'sını bağsız saydı çünkü doğrudan teslim kaydını hiç görmüyordu).
    _dagilim: Dict[str, int] = {}
    for _s in satirlar:
        _k = _s.get("bag_kanit") or "BAGSIZ"
        _dagilim[_k] = _dagilim.get(_k, 0) + 1
    return {
        "gun": gun,
        "kanit_dagilimi": _dagilim,
        "bag_penceresi_dk": BAG_PENCERE_DK,
        "kapsanan_hareket_turleri": list(TEDARIKCI_GIRIS_TURLERI),
        "toplam_giris": len(satirlar),
        "bagli_giris": len(satirlar) - len(bagsiz),
        "bagsiz_giris": len(bagsiz),
        # ⚠️ Tutarı bilinmeyen AYRI sayılır — sıfır yazmak "borç yok" yalanıdır.
        "bagsiz_tahmini_tutar": round(sum(s["tahmini_tutar"] for s in _tutarli), 2),
        "tutari_bilinmeyen_adet": len(bagsiz) - len(_tutarli),
        "en_eski_gun": max((s["yas_gun"] for s in bagsiz), default=0),
        "satirlar": _goster,
        "satirlar_kapsami": ("tum girisler (bagli + bagsiz)" if int(tumu or 0)
                             else "yalniz bagsiz"),
        "not": ("Bu girişler hicbir tedarikci zincirine baglanamadi: belge talebi "
                "dogmadi, fatura kovalanmadi, borc tahakkuk etmedi, cariye "
                "girmedi. Ic sevkiyat (SEVK_GIRIS) BILEREK haric — orada "
                "tedarikci beklenmez. Tutar TAHMINDIR (katalog birim fiyati); "
                "fiyat yoksa NULL doner, sifir yazilmaz."),
    }


def bagsiz_giris_tara(gun: int = 90) -> Dict[str, Any]:
    """🌙 TARAMA — gözlemleri kendi tablosuna yazar (append-only, idempotent).

    Yalnız BAĞSIZ satırlar gözleme yazılır; bağlı olanlar zaten normal akış.
    Aynı hareket ikinci kez taranırsa `ON CONFLICT DO NOTHING` ile atlanır.
    HİÇBİR iş tablosuna yazmaz.
    """
    yazilan = 0
    bagsiz: List[Dict[str, Any]] = []
    try:
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            satirlar = _bagsiz_girisleri_bul(cur, gun)
            bagsiz = [s for s in satirlar if not s["bagli"]]
            for s in bagsiz:
                try:
                    with savepoint(cur, "sp_bagsiz_gozlem"):
                        cur.execute(
                            """INSERT INTO bagsiz_giris_gozlem
                                 (id, hareket_id, zaman, sube_id, sube_adi,
                                  kalem_kodu, kalem_adi, miktar, bagli, bag_kanit,
                                  bag_ts_id, tahmini_tutar, tutar_kaynagi,
                                  yas_gun, ham_detay)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,FALSE,NULL,NULL,
                                       %s,%s,%s,%s::jsonb)
                               ON CONFLICT (hareket_id) DO NOTHING""",
                            (str(uuid.uuid4()), s["hareket_id"], s["zaman"] or None,
                             s["sube_id"], s["sube_adi"], s["kalem_kodu"],
                             s["kalem_adi"], s["miktar"], s["tahmini_tutar"],
                             s["tutar_kaynagi"], s["yas_gun"],
                             json.dumps(s, ensure_ascii=False)),
                        )
                        yazilan += cur.rowcount or 0
                except Exception:
                    logger.warning("bagsiz giris gozlemi yazilamadi (hareket=%s)",
                                   s.get("hareket_id"), exc_info=True)
    except Exception as e:  # noqa: BLE001 — duyu ana akisi ASLA bozmaz
        logger.warning("bagsiz giris taramasi dustu (yutuldu): %s", str(e)[:150])
        return {"ok": False, "hata": str(e)[:150]}

    # Omurga olayı — Sv0 GÖZLEM (alarm değil). Eşik yok: bir tane bile varsa
    # görünmesi gerekir, çünkü tanımı gereği başka hiçbir yerde görünmüyor.
    if bagsiz:
        try:
            from duyu_omurga import duyu_olay_yaz
            duyu_olay_yaz(
                "bagsiz_giris", "tedarik.stok.bagsiz_giris",
                f"bagsiz_{len(bagsiz)}",
                entity_scope="sistem", entity_id=None,
                signal_name="Tedarikçiye bağlanamayan stok girişi",
                payload={"adet": len(bagsiz),
                         "en_eski_gun": max(s["yas_gun"] for s in bagsiz),
                         "ornek": [f"{s['sube_adi']} · {s['kalem_adi']} ×{s['miktar']:g}"
                                   for s in bagsiz[:5]],
                         "not": ("Mal depoya girdi ama hicbir tedarikci zincirine "
                                 "bagli degil: belge talebi dogmadi, fatura "
                                 "kovalanmadi, cari olusmadi. "
                                 "/api/duyu-stok/bagsiz-giris ile inceleyin.")},
            )
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "taranan_gun": gun, "bagsiz_adet": len(bagsiz),
            "yeni_gozlem": yazilan}


@router.post("/bagsiz-giris/tara")
def bagsiz_giris_tara_uc(gun: int = Query(90, ge=1, le=730)):
    """Taramayı elle tetikler. Yalnız KENDİ gözlem tablosuna yazar."""
    return bagsiz_giris_tara(gun=gun)


@router.get("/bagsiz-giris/gozlem")
def bagsiz_giris_gozlem(limit: int = Query(200, ge=1, le=1000)):
    """Geçmiş gözlemler (append-only defter). Salt-okur."""
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """SELECT hareket_id, zaman::text AS zaman, sube_adi, kalem_adi,
                      miktar::float AS miktar, tahmini_tutar::float AS tahmini_tutar,
                      tutar_kaynagi, yas_gun, olusturma::text AS olusturma
                 FROM bagsiz_giris_gozlem
                ORDER BY zaman DESC NULLS LAST
                LIMIT %s""", (limit,))
        satirlar = [dict(r) for r in (cur.fetchall() or [])]
    return {"toplam": len(satirlar), "satirlar": satirlar,
            "not": "Append-only gozlem defteri — satir silinmez, guncellenmez."}


def gece_bagsiz_giris_tara() -> Dict[str, Any]:
    """Gece zinciri halkası — hata-yutar."""
    try:
        return bagsiz_giris_tara(gun=180)
    except Exception as e:  # noqa: BLE001
        logger.warning("gece bagsiz giris taramasi dustu: %s", str(e)[:150])
        return {"ok": False}
