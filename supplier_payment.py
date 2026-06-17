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


def supplier_payment_sync(cur) -> Dict[str, Any]:
    """Kart (HARCAMA) + nakit (anlik_gider) ödemelerini tedarikçi adıyla eşleştirip
    supplier_payment_event'e yazar. İDEMPOTENT (re-run güvenli). ALARM YOK.
    Eşleşmeyen ödeme atlanır (tedarikçiye ödeme olduğu belli değil)."""
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


@router.post("/sync")
def sp_sync():
    """Geçmiş + yeni kart/nakit ödemelerini olay katmanına akıt (idempotent, alarmsız)."""
    with db() as (conn, cur):
        out = supplier_payment_sync(cur)
        conn.commit()
    return out


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
               FROM supplier_payment_event GROUP BY tedarikci_ad ORDER BY adet DESC LIMIT 25"""
        )
        ozet["tedarikci_dagilim"] = [dict(r) for r in (cur.fetchall() or [])]
    return ozet
