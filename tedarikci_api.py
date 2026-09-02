from __future__ import annotations

import json
import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit

log = logging.getLogger(__name__)

router = APIRouter(tags=["tedarikci"])


class TedarikciBody(BaseModel):
    ad: str
    kategori: str = ""
    telefon: str = ""
    aciklama: str = ""


# Ada dayalı eşleşmenin geçtiği tablolar — rename ETKİSİ burada ölçülür.
# ⚠️ Liste TAHMİN DEĞİL: her biri kodda tedarikçi adını METİN olarak tutuyor
# ve ödeme/cari eşleştirmesi bu metinlere bakıyor (fatura_api._odeme_eslesir,
# sevkiyat_helpers.ad_anahtar). Yeni bir ad alanı eklenirse buraya da eklenmeli.
_AD_TASIYAN = (
    ("tedarikci_fatura", "tedarikci_ad"),
    ("vadeli_alimlar",   "tedarikci"),
    ("toptanci_siparis", "tedarikci_ad"),
    ("cari_odeme",       "tedarikci_ad"),
)


def _ensure_ad_gecmisi(cur) -> None:
    """Tedarikçi ad geçmişi — APPEND-ONLY.

    ⚠️ `lock_timeout` şart: DDL, ACCESS EXCLUSIVE ister ve devreden dağıtımda
    sıraya girip tabloyu bloklayabilir (2026-09-02'de aynı desen canlıyı
    15 dk 502'de bıraktı). Kilidi kapamazsak pes ederiz.
    """
    cur.execute("SET LOCAL lock_timeout = '3s'")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_ad_gecmisi (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            tedarikci_id  TEXT NOT NULL,
            eski_ad       TEXT NOT NULL,
            yeni_ad       TEXT NOT NULL,
            etkilenen     JSONB,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS ix_ted_ad_gecmisi ON tedarikci_ad_gecmisi (tedarikci_id, olusturma DESC)")


def _eski_ada_bagli_kayitlar(cur, eski_ad: str) -> dict:
    """Eski adı METİN olarak taşıyan kaç kayıt var — TAHMİN DEĞİL, SAYIM.

    Rename sonrası bu kayıtlar yeni adla eşleşmez; sahip bunu görmeden
    ad değiştirirse cari mutabakatı sessizce bozulur.
    """
    from database import savepoint
    sonuc = {}
    for tablo, kolon in _AD_TASIYAN:
        try:
            with savepoint(cur, "sp_ad_say"):
                cur.execute(
                    f"SELECT COUNT(*) AS n FROM {tablo} "
                    f"WHERE LOWER(TRIM(COALESCE({kolon},''))) = LOWER(TRIM(%s))",
                    (eski_ad,))
                sonuc[tablo] = int((cur.fetchone() or {}).get("n") or 0)
        except Exception:
            # Tablo/kolon yoksa SIFIR YAZMIYORUZ — "yok" ile "bakamadım" farklı.
            sonuc[tablo] = None
    return sonuc


@router.get("/api/tedarikciler")
def tedarikci_liste(aktif: bool = True):
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, ad, kategori, telefon, aciklama, aktif, olusturma
            FROM tedarikciler
            WHERE (%s IS NULL OR aktif = %s)
            ORDER BY ad
            """,
            (aktif, aktif),
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            rows.append(d)
    return {"tedarikciler": rows}


@router.post("/api/tedarikciler")
def tedarikci_ekle(body: TedarikciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Tedarikçi adı en az 2 karakter olmalı")
    tid = str(uuid.uuid4())
    with db() as (conn, cur):
        try:
            cur.execute(
                """
                INSERT INTO tedarikciler (id, ad, kategori, telefon, aciklama)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    tid,
                    ad,
                    (body.kategori or "").strip() or None,
                    (body.telefon or "").strip() or None,
                    (body.aciklama or "").strip() or None,
                ),
            )
        except Exception as e:
            if "unique" in str(e).lower() or "duplicate" in str(e).lower():
                raise HTTPException(409, f"'{ad}' adında aktif tedarikçi zaten var")
            raise
        audit(cur, "tedarikciler", tid, "INSERT",
              yeni={"ad": ad, "kategori": body.kategori, "telefon": body.telefon})
    return {"success": True, "id": tid}


@router.put("/api/tedarikciler/{tid}")
def tedarikci_guncelle(tid: str, body: TedarikciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Tedarikçi adı en az 2 karakter olmalı")
    with db() as (conn, cur):
        # 🔴 TANIM-001 (2026-09-02): bu uçta tek bir audit yoktu ve `ad` doğrudan
        # eziliyordu. Oysa ödeme/cari eşleştirmesinin bir kısmı tedarikçi adını
        # METİN olarak karşılaştırıyor. Ad değişince geçmiş kayıtlar yeni adla
        # eşleşmez — cari mutabakatı SESSİZCE bozulur ve neden bozulduğunu
        # söyleyecek hiçbir kayıt kalmaz.
        # Rename ENGELLENMİYOR (meşru iş); ama artık ÖLÇÜLÜYOR ve İZ BIRAKIYOR.
        cur.execute("SELECT * FROM tedarikciler WHERE id=%s", (tid,))
        _eski = cur.fetchone()
        if not _eski:
            raise HTTPException(404, "Tedarikçi bulunamadı")
        _eski = dict(_eski)
        _eski_ad = (_eski.get("ad") or "").strip()
        _ad_degisti = _eski_ad.lower() != ad.lower()

        cur.execute(
            """
            UPDATE tedarikciler SET ad=%s, kategori=%s, telefon=%s, aciklama=%s
            WHERE id=%s
            """,
            (
                ad,
                (body.kategori or "").strip() or None,
                (body.telefon or "").strip() or None,
                (body.aciklama or "").strip() or None,
                tid,
            ),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Tedarikçi bulunamadı")

        _etkilenen = None
        if _ad_degisti:
            _etkilenen = _eski_ada_bagli_kayitlar(cur, _eski_ad)
            try:
                # SAVEPOINT: yutulan cur.execute transaction'ı ZEHİRLER —
                # ad geçmişi yazılamazsa GÜNCELLEMENİN KENDİSİ de sessizce
                # geri sarılır ve uç success döner (bu projenin klasik tuzağı).
                from database import savepoint
                with savepoint(cur, "sp_ted_ad_gecmis"):
                    _ensure_ad_gecmisi(cur)
                    cur.execute(
                        """INSERT INTO tedarikci_ad_gecmisi
                               (tedarikci_id, eski_ad, yeni_ad, etkilenen)
                           VALUES (%s, %s, %s, %s::jsonb)""",
                        (tid, _eski_ad, ad, json.dumps(_etkilenen, default=str)))
            except Exception as e:  # noqa: BLE001
                # Geçmiş yazılamadıysa güncelleme durmaz ama SESSİZ de kalmaz.
                log.warning("tedarikçi ad geçmişi yazılamadı (%s): %s", tid, e)

        audit(cur, "tedarikciler", tid, "GUNCELLEME",
              eski={k: _eski.get(k) for k in ("ad", "kategori", "telefon", "aciklama")},
              yeni={"ad": ad, "kategori": body.kategori, "telefon": body.telefon,
                    "ad_degisti": _ad_degisti, "eski_ada_bagli": _etkilenen})

    _c = {}
    if _ad_degisti and isinstance(_etkilenen, dict):
        _c = {k: v for k, v in _etkilenen.items() if v}
    return {
        "success": True,
        "ad_degisti": _ad_degisti,
        "eski_ad": _eski_ad if _ad_degisti else None,
        # Sahip bunu GÖRMELİ: ada dayalı eşleşmeler bu kayıtlarda kopabilir.
        "eski_ada_bagli_kayit": _c or None,
        "uyari": (
            f"'{_eski_ad}' → '{ad}' değişti. Eski adı metin olarak taşıyan "
            f"{sum(v for v in _c.values() if isinstance(v, int))} kayıt var; "
            "ada dayalı ödeme/cari eşleşmeleri bunlarda kopabilir."
        ) if _c else None,
    }


@router.delete("/api/tedarikciler/{tid}")
def tedarikci_sil(tid: str):
    with db() as (conn, cur):
        cur.execute("SELECT ad FROM tedarikciler WHERE id=%s", (tid,))
        _r = cur.fetchone()
        cur.execute("UPDATE tedarikciler SET aktif=FALSE WHERE id=%s", (tid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Tedarikçi bulunamadı")
        audit(cur, "tedarikciler", tid, "PASIFLESTIR",
              eski={"ad": dict(_r or {}).get("ad"), "aktif": True},
              yeni={"aktif": False})
    return {"success": True}

