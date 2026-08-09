"""
supplier_payment_event — "Tedarikçiye ödeme"yi BİRİNCİ SINIF olay yapan katman.

FELSEFE (KUZEY YILDIZI: "duyu duysun, beyin daha çalışmasın"):
  - Bu katman SADECE VERİ TOPLAR (kart/nakit ödemelerini tedarikçiyle ilişkilendirip
    olay üretir). HİÇBİR alarm/çıkarım YOK. Beyin (Akıllı Denetim) henüz uyanmaz.
  - İleride "ödeme mutabakatı" duyusu YALNIZCA bu tabloyu okuyacak — ham
    kart_hareketleri / anlik_giderler tablolarını ASLA okumayacak (event-driven;
    Stripe/Shopify dersi: denetim motoru olaylara bağımlı, altyapıya değil).
  - İZOLE: kendi tablosu, kendi router'ı, idempotent (ON CONFLICT). Çökse kritik akış
    etkilenmez. Tek yönlü: kart/nakit OKUR, yalnızca kendi tablosuna YAZAR.

Backfill mantığı (asimetrik hibrit — GPT+Opus sentezi):
  - Geçmiş veri serbest-metin olduğu için fuzzy (tedarikçi adı ~ açıklama) eşleştirilir,
    DÜŞÜK güven (confidence=0.5). Eşleşmeyen ödeme = "tedarikçiye ödeme" sayılmaz, atlanır.
  - İleride ödeme ekranına opsiyonel-görünür tedarikçi alanı gelince → confidence=1.0.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from datetime import date as _dt_date
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/supplier-payment", tags=["supplier-payment"])

_TABLO_HAZIR = False


def _ensure_tablo(cur) -> None:
    """Olay katmanı tablosu (lazy). Kritik tablolara SERT FK yok (yumuşak ref)."""
    global _TABLO_HAZIR
    if _TABLO_HAZIR:
        return
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS supplier_payment_event (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tedarikci_id    TEXT,                 -- nullable (kesin değilse NULL)
            tedarikci_ad    TEXT,                 -- snapshot / serbest metin
            tutar           NUMERIC(14,2) NOT NULL,
            tarih           DATE NOT NULL,
            kaynak          TEXT NOT NULL,         -- 'kart' | 'nakit' | 'havale' | 'manuel'
            kaynak_tablo    TEXT,                  -- 'kart_hareketleri' | 'anlik_giderler'
            kaynak_id       TEXT,                  -- o satırın id'si (idempotency)
            confidence      DOUBLE PRECISION NOT NULL DEFAULT 0.3,  -- 1.0 kesin, 0.5 fuzzy
            eslesme_yontemi TEXT,                  -- 'tedarikci_id' | 'fuzzy_ad' | 'manuel'
            aciklama        TEXT,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (kaynak_tablo, kaynak_id)       -- aynı kaynak iki kez akmaz
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spe_ted ON supplier_payment_event (tedarikci_id, tarih DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spe_tarih ON supplier_payment_event (tarih DESC)")
    _TABLO_HAZIR = True


def _norm(s: Optional[str]) -> str:
    """Türkçe-güvenli, aksandan arınmış anahtar (İ tuzağı + NFKD)."""
    s = (s or "").replace("İ", "i").replace("I", "ı")
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c)).strip()


def supplier_payment_sync_v2(cur) -> Dict[str, Any]:
    """🎯 KANONİK ÖDEME KATMANI v2 — cari hesabın TAM AYNI süzgeçleriyle (2026-08-08).

    NEDEN v2: v1 ile cari hesap arasında canlıda 656.760 ₺ fark ölçüldü (kanonik
    katman 1.108.106 ₺, cari 451.345 ₺; 0 tedarikçide eşitlik). Sebepleri:
      1. Aynı ödemeyi İKİ KEZ alıyordu (hem kart hem eşlenik anlık gider satırı)
      2. Sistem başlangıcı çizgisini tanımıyordu (devirde sayılı ödemeler tekrar)
      3. Basit substring araması — marka tokeni / kişi adı kuralı / jenerik eleme yok
      4. vadeli_alimlar kanalını HİÇ okumuyordu
    Bu katman cari hesabın yerine geçecekse ONUNLA AYNI GERÇEĞİ üretmelidir;
    yoksa iki ayrı doğruluk olur. v2 dört kusuru da kapatır.

    ÜÇ KANAL — cari_ekstre ile birebir aynı süzgeçler:
      · vadeli_alimlar  : durum='odendi'
      · anlik_giderler  : durum='aktif' AND kaynak_id IS NULL
      · kart_hareketleri: HARCAMA + aktif + (kaynak_id IS NULL OR
                          kaynak_tablo='ekstre_import') + harcama_tipi<>'sahsi'
    Hepsinde tarih >= EVVEL_SISTEM_BASLANGIC.

    DAMGA ÖNCELİĞİ: kart satırında cari_tedarikci damgası varsa ad eşleşmesi
    ARANMAZ (sahibin kararı konuşur); '(ilgisiz)' damgası satırı tümden eler.

    İDEMPOTENT: UNIQUE(kaynak_tablo, kaynak_id) + ON CONFLICT DO NOTHING.
    """
    _ensure_tablo(cur)
    try:
        cur.execute("ALTER TABLE supplier_payment_event ADD COLUMN IF NOT EXISTS surum INT DEFAULT 1")
        cur.execute("ALTER TABLE supplier_payment_event ADD COLUMN IF NOT EXISTS gecersiz BOOLEAN DEFAULT FALSE")
    except Exception:  # noqa: BLE001
        pass
    from fatura_api import (_odeme_eslesir, _cari_katla, EVVEL_SISTEM_BASLANGIC,
                            tedarikci_eslestirme_haritasi)

    # ── TEDARİKÇİ EVRENİ: cari hesabın gördüğü adlar (fatura + kanonik harita)
    adlar: List[str] = []
    try:
        cur.execute("""SELECT DISTINCT tedarikci_ad FROM tedarikci_fatura
                       WHERE COALESCE(tedarikci_ad,'') <> ''
                         AND COALESCE(durum,'') <> 'kopya'""")
        adlar = [r["tedarikci_ad"] for r in (cur.fetchall() or [])]
    except Exception:  # noqa: BLE001
        pass
    try:
        for _k, _v in (tedarikci_eslestirme_haritasi() or {}).items():
            kisa = (_v or {}).get("kisa")
            if kisa and kisa not in adlar:
                adlar.append(kisa)
    except Exception:  # noqa: BLE001
        pass
    # Kanonik kısa ada indir (aynı tedarikçinin iki yazımı tek olay üretmesin)
    _harita = {}
    try:
        _harita = tedarikci_eslestirme_haritasi() or {}
    except Exception:  # noqa: BLE001
        pass

    def _kanonik_ad(ad: str) -> str:
        return ((_harita.get((ad or "").strip().upper()) or {}).get("kisa") or ad).strip()

    def _eslestir(metin: Optional[str]) -> Optional[str]:
        for a in adlar:
            if _odeme_eslesir(a, metin or ""):
                return _kanonik_ad(a)
        return None

    def _ekle(ted_ad, tutar, tarih, kaynak, ktablo, kid, aciklama, yontem, guven) -> int:
        cur.execute(
            """INSERT INTO supplier_payment_event
                 (tedarikci_id, tedarikci_ad, tutar, tarih, kaynak, kaynak_tablo,
                  kaynak_id, confidence, eslesme_yontemi, aciklama, surum, gecersiz)
               VALUES (NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s,2,FALSE)
               ON CONFLICT (kaynak_tablo, kaynak_id) DO NOTHING""",
            (ted_ad, tutar, tarih, kaynak, ktablo, kid, guven, yontem, aciklama))
        return cur.rowcount or 0

    eklenen, taranan = 0, {"vadeli": 0, "nakit": 0, "kart": 0}
    B = EVVEL_SISTEM_BASLANGIC
    # 🪢 ÇİFT KANAL (2026-08-09): vadeli alım/anlık gider KARTLA ödendiğinde iki
    # iz doğar — sistem kaydı + banka ekstresinin ham satırı. Kanal 1-2'de
    # eklenenler burada birikir; kanal 3 aynı parayı ikinci kez EKLEMEZ.
    # cari_ekstre/cari_ozet ile aynı kural — iki katman aynı gerçeği üretmeli.
    _sistem_izleri: List[Dict[str, Any]] = []
    _tuketilen: set = set()

    def _cift_kanal_mi(ted_ad: str, tutar, tarih) -> Optional[int]:
        try:
            t = float(tutar or 0)
            d1 = tarih if isinstance(tarih, _dt_date) else _dt_date.fromisoformat(str(tarih)[:10])
        except Exception:  # noqa: BLE001
            return None
        for i, s in enumerate(_sistem_izleri):
            if i in _tuketilen or s["ted"] != ted_ad:
                continue
            if not t or abs(t - s["tutar"]) > max(3.0, t * 0.02):
                continue
            if abs((d1 - s["tarih"]).days) <= 3:
                return i
        return None

    # ── 1) VADELİ ALIM (ödenmiş sözler) — v1'de HİÇ YOKTU
    try:
        cur.execute("SAVEPOINT sp_v")
        cur.execute(
            """SELECT id, vade_tarihi AS tarih, tutar,
                      COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,'') AS metin
               FROM vadeli_alimlar
               WHERE durum='odendi' AND vade_tarihi >= %s::date""", (B,))
        for r in [dict(x) for x in (cur.fetchall() or [])]:
            taranan["vadeli"] += 1
            ted = _eslestir(r["metin"])
            if ted:
                eklenen += _ekle(ted, r["tutar"], r["tarih"], "vadeli",
                                 "vadeli_alimlar", r["id"], r["metin"][:200],
                                 "marka_token", 0.7)
                _sistem_izleri.append({"ted": ted, "tutar": float(r["tutar"] or 0),
                                       "tarih": r["tarih"], "metin": r["metin"][:80]})
        cur.execute("RELEASE SAVEPOINT sp_v")
    except Exception as e:  # noqa: BLE001
        cur.execute("ROLLBACK TO SAVEPOINT sp_v"); cur.execute("RELEASE SAVEPOINT sp_v")
        logger.warning("spe v2 vadeli hata: %s", str(e)[:140])

    # ── 2) NAKİT (anlık gider) — kaynak_id IS NULL şartı v1'de YOKTU
    try:
        cur.execute("SAVEPOINT sp_n")
        cur.execute(
            """SELECT id, tarih, tutar,
                      COALESCE(tedarikci,'') || ' ' || COALESCE(aciklama,'') AS metin
               FROM anlik_giderler
               WHERE COALESCE(durum,'aktif')='aktif' AND kaynak_id IS NULL
                 AND tarih >= %s::date""", (B,))
        for r in [dict(x) for x in (cur.fetchall() or [])]:
            taranan["nakit"] += 1
            ted = _eslestir(r["metin"])
            if ted:
                eklenen += _ekle(ted, r["tutar"], r["tarih"], "nakit",
                                 "anlik_giderler", r["id"], r["metin"][:200],
                                 "marka_token", 0.6)
                _sistem_izleri.append({"ted": ted, "tutar": float(r["tutar"] or 0),
                                       "tarih": r["tarih"], "metin": r["metin"][:80]})
        cur.execute("RELEASE SAVEPOINT sp_n")
    except Exception as e:  # noqa: BLE001
        cur.execute("ROLLBACK TO SAVEPOINT sp_n"); cur.execute("RELEASE SAVEPOINT sp_n")
        logger.warning("spe v2 nakit hata: %s", str(e)[:140])

    # ── 3) KART — sistem üretimi satırlar ELENİR, damga önceliklidir
    try:
        cur.execute("SAVEPOINT sp_k")
        cur.execute(
            """SELECT id, tarih, tutar, COALESCE(aciklama,'') AS metin, cari_tedarikci
               FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'
                 AND (kaynak_id IS NULL OR COALESCE(kaynak_tablo,'')='ekstre_import')
                 AND COALESCE(harcama_tipi,'belirsiz') <> 'sahsi'
                 AND tarih >= %s::date""", (B,))
        for r in [dict(x) for x in (cur.fetchall() or [])]:
            taranan["kart"] += 1
            damga = (r.get("cari_tedarikci") or "").strip()
            if damga == "(ilgisiz)":
                continue                      # sahip "bizim ödememiz değil" dedi
            if damga:
                ted, yontem, guven = _kanonik_ad(damga), "sahip_damgasi", 1.0
            else:
                ted, yontem, guven = _eslestir(r["metin"]), "marka_token", 0.6
            if ted:
                _cift = _cift_kanal_mi(ted, r["tutar"], r["tarih"])
                if _cift is not None:
                    _tuketilen.add(_cift)      # aynı para sistem kaydında sayılı
                    taranan["cift_kanal_elenen"] = taranan.get("cift_kanal_elenen", 0) + 1
                    # ⚠️ ON CONFLICT DO NOTHING geçmişte eklenmiş satırı SİLMEZ —
                    # yalnız 'continue' demek eski çift kaydı tabloda bırakırdı
                    # (redbull 21.482 ₺ kanonik katmanda kalıp cari ile farkı
                    # kapatmıyordu). Silmiyoruz, GEÇERSİZ damgalıyoruz.
                    cur.execute(
                        """UPDATE supplier_payment_event SET gecersiz=TRUE
                           WHERE kaynak_tablo='kart_hareketleri' AND kaynak_id=%s
                             AND COALESCE(gecersiz,FALSE)=FALSE""", (str(r["id"]),))
                    continue
                eklenen += _ekle(ted, r["tutar"], r["tarih"], "kart",
                                 "kart_hareketleri", r["id"], r["metin"][:200],
                                 yontem, guven)
        cur.execute("RELEASE SAVEPOINT sp_k")
    except Exception as e:  # noqa: BLE001
        cur.execute("ROLLBACK TO SAVEPOINT sp_k"); cur.execute("RELEASE SAVEPOINT sp_k")
        logger.warning("spe v2 kart hata: %s", str(e)[:140])

    return {"surum": 2, "eklenen": eklenen, "taranan": taranan,
            "tedarikci_evreni": len(adlar)}


def supplier_payment_sync(cur) -> Dict[str, Any]:
    """v1 — ESKİ MANTIK, ARTIK ÇAĞRILMIYOR (2026-08-08).

    Cari hesapla 656.760 ₺ fark ürettiği ölçüldüğü için devre dışı; yerine
    supplier_payment_sync_v2 geçti. Kod silinmedi (karşılaştırma/geri dönüş
    için durur) ama gece zinciri v2'yi çağırır.
    """
    _ensure_tablo(cur)

    # Tedarikçi adları (≥3 harf normalize — kısa/gürültülü eşleşme engellenir)
    teds: List[Tuple[str, str, str]] = []
    try:
        cur.execute("SAVEPOINT sp_ted")
        cur.execute("SELECT id, ad FROM tedarikciler WHERE COALESCE(aktif, TRUE) = TRUE")
        for r in cur.fetchall() or []:
            d = dict(r)
            nad = _norm(d.get("ad"))
            if nad and len(nad) >= 3:
                teds.append((str(d.get("id")), str(d.get("ad")), nad))
        cur.execute("RELEASE SAVEPOINT sp_ted")
    except Exception:
        cur.execute("ROLLBACK TO SAVEPOINT sp_ted"); cur.execute("RELEASE SAVEPOINT sp_ted")
        return {"hata": "tedarikciler okunamadi", "eklenen": 0}

    def _match(aciklama: Optional[str]) -> Optional[Tuple[str, str]]:
        n = _norm(aciklama)
        if not n:
            return None
        for tid, ad, nad in teds:
            if nad in n:
                return (tid, ad)
        return None

    def _ekle(m, tutar, tarih, kaynak, ktablo, kid, aciklama) -> int:
        cur.execute(
            """
            INSERT INTO supplier_payment_event
                (tedarikci_id, tedarikci_ad, tutar, tarih, kaynak, kaynak_tablo,
                 kaynak_id, confidence, eslesme_yontemi, aciklama)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 0.5, 'fuzzy_ad', %s)
            ON CONFLICT (kaynak_tablo, kaynak_id) DO NOTHING
            """,
            (m[0], m[1], tutar, tarih, kaynak, ktablo, kid, aciklama),
        )
        return cur.rowcount or 0

    eklenen = 0
    taranan = {"kart": 0, "nakit": 0}

    # ── KART (HARCAMA) ──────────────────────────────────────────────────
    try:
        cur.execute("SAVEPOINT sp_kart")
        cur.execute(
            """SELECT id, tarih, tutar, aciklama FROM kart_hareketleri
               WHERE islem_turu='HARCAMA' AND COALESCE(durum,'aktif')='aktif'"""
        )
        for r in [dict(x) for x in (cur.fetchall() or [])]:
            taranan["kart"] += 1
            m = _match(r.get("aciklama"))
            if m:
                eklenen += _ekle(m, r["tutar"], r["tarih"], "kart", "kart_hareketleri", r["id"], r.get("aciklama"))
        cur.execute("RELEASE SAVEPOINT sp_kart")
    except Exception as e:
        cur.execute("ROLLBACK TO SAVEPOINT sp_kart"); cur.execute("RELEASE SAVEPOINT sp_kart")
        logger.warning("supplier_payment_sync kart hata: %s", e)

    # ── NAKİT (anlik_giderler) ──────────────────────────────────────────
    try:
        cur.execute("SAVEPOINT sp_nakit")
        cur.execute(
            """SELECT id, tarih, tutar, aciklama FROM anlik_giderler
               WHERE COALESCE(durum,'aktif')='aktif'"""
        )
        for r in [dict(x) for x in (cur.fetchall() or [])]:
            taranan["nakit"] += 1
            m = _match(r.get("aciklama"))
            if m:
                eklenen += _ekle(m, r["tutar"], r["tarih"], "nakit", "anlik_giderler", r["id"], r.get("aciklama"))
        cur.execute("RELEASE SAVEPOINT sp_nakit")
    except Exception as e:
        cur.execute("ROLLBACK TO SAVEPOINT sp_nakit"); cur.execute("RELEASE SAVEPOINT sp_nakit")
        logger.warning("supplier_payment_sync nakit hata: %s", e)

    return {"eklenen": eklenen, "taranan": taranan, "tedarikci_sayisi": len(teds)}


def spe_tetikle(neden: str = "-") -> Dict[str, Any]:
    """⚡ ÖDEME SONRASI ANLIK TAZELEME (2026-08-08, sahip: "her yazma işleminde
    anlık güncellensin").

    Kanonik katman gece + ekstre importuyla doluyordu; aradaki ödemeler senkrona
    kadar katmanda GÖRÜNMÜYORDU. Cari hesap canlı tablolardan okuduğu için ikisi
    ayrışıyordu. Bu yardımcı her para yazımından sonra çağrılır ve katmanı aynı
    saniyede hizalar.

    HATA-YUTAR: tazeleme patlarsa ödeme İŞLEMİ BOZULMAZ — para zaten yazıldı,
    katman en geç gece tekrar hizalanır. Kendi bağlantısını açar (çağıranın
    transaction'ına karışmaz).
    """
    try:
        with db() as (conn, cur):
            out = supplier_payment_sync_v2(cur)
            conn.commit()
        if out.get("eklenen"):
            logger.info("kanonik ödeme katmanı tazelendi (%s): +%s olay",
                        neden, out.get("eklenen"))
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("spe tetikleme atlandı (%s): %s", neden, str(e)[:140])
        return {"ok": False, "neden": neden}


@router.post("/sync")
def sp_sync():
    """Ödemeleri olay katmanına akıt — v2 mantığı (idempotent, alarmsız)."""
    with db() as (conn, cur):
        out = supplier_payment_sync_v2(cur)
        conn.commit()
    return out


@router.post("/yeniden-kur")
def sp_yeniden_kur(kuru: int = 1):
    """♻️ Katmanı v2 mantığıyla YENİDEN İNŞA eder — v1 satırları geçersiz kılınır.

    v1 ile cari hesap arasında 656.760 ₺ fark ölçüldü (aynı ödemeyi iki kez
    sayma, devir çizgisi tanımama, ilkel metin araması, vadeli kanalı eksik).
    Bu uç v1 satırlarını SİLMEZ — `gecersiz=TRUE` damgalar (doktrin: hiçbir
    kayıt silinmez) ve v2 mantığıyla yeniden doldurur.

    kuru=1 → yalnız sayar. kuru=0 → uygular.
    """
    with db() as (conn, cur):
        _ensure_tablo(cur)
        try:
            cur.execute("ALTER TABLE supplier_payment_event ADD COLUMN IF NOT EXISTS surum INT DEFAULT 1")
            cur.execute("ALTER TABLE supplier_payment_event ADD COLUMN IF NOT EXISTS gecersiz BOOLEAN DEFAULT FALSE")
            conn.commit()
        except Exception:  # noqa: BLE001
            pass
        cur.execute("""SELECT COUNT(*)::int AS n, COALESCE(SUM(tutar),0)::float AS t
                       FROM supplier_payment_event
                       WHERE COALESCE(surum,1)=1 AND NOT COALESCE(gecersiz,FALSE)""")
        v1 = dict(cur.fetchone() or {})
        if kuru:
            return {"kuru_calistirma": True, "gecersiz_kilinacak_v1": v1,
                    "not": "v1 satırları SİLİNMEZ, gecersiz=TRUE damgalanır. "
                           "Uygulamak için ?kuru=0"}
        # v1'i geçersiz kıl — UNIQUE(kaynak_tablo,kaynak_id) çakışmasın diye
        # kaynak anahtarını da nötrle (aynı kaynak v2'de yeniden akabilsin)
        cur.execute("""UPDATE supplier_payment_event
                          SET gecersiz=TRUE,
                              kaynak_tablo = kaynak_tablo || '#v1',
                              aciklama = COALESCE(aciklama,'') || ' [v1 — geçersiz kılındı]'
                        WHERE COALESCE(surum,1)=1 AND NOT COALESCE(gecersiz,FALSE)""")
        gecersiz = cur.rowcount
        conn.commit()
        yeni = supplier_payment_sync_v2(cur)
        conn.commit()
    return {"kuru_calistirma": False, "gecersiz_kilinan_v1": gecersiz,
            "v1_ozet": v1, "v2_sonuc": yeni,
            "not": "v1 kayıtları arşivde duruyor (gecersiz=TRUE, kaynak_tablo'ya "
                   "'#v1' eklendi). Kıyas için: GET /api/fatura/odeme-katmani-kiyas"}


@router.get("/durum")
def sp_durum():
    """Salt-okur durum: kaç olay toplandı, tedarikçi bazında özet. (Beyin değil, sayaç.)"""
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute(
            """SELECT COUNT(*) AS olay, COUNT(tedarikci_id) AS tedarikcili,
                      COALESCE(SUM(tutar),0)::float8 AS toplam_tutar,
                      MIN(tarih)::text AS ilk, MAX(tarih)::text AS son
               FROM supplier_payment_event"""
        )
        ozet = dict(cur.fetchone() or {})
        cur.execute(
            """SELECT tedarikci_ad, COUNT(*) AS adet, COALESCE(SUM(tutar),0)::float8 AS toplam
               FROM supplier_payment_event
               WHERE NOT COALESCE(gecersiz,FALSE)
               GROUP BY tedarikci_ad ORDER BY adet DESC LIMIT 25"""
        )
        ozet["tedarikci_dagilim"] = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT kaynak, COUNT(*) AS adet, COALESCE(SUM(tutar),0)::float8 AS toplam
               FROM supplier_payment_event WHERE NOT COALESCE(gecersiz,FALSE)
               GROUP BY kaynak ORDER BY 2 DESC"""
        )
        ozet["kanal_dagilim"] = [dict(r) for r in (cur.fetchall() or [])]
        cur.execute(
            """SELECT COUNT(*) FILTER (WHERE COALESCE(gecersiz,FALSE)) AS gecersiz_v1,
                      COUNT(*) FILTER (WHERE NOT COALESCE(gecersiz,FALSE)) AS aktif_v2
               FROM supplier_payment_event"""
        )
        ozet["surum_durumu"] = dict(cur.fetchone() or {})
    return ozet
