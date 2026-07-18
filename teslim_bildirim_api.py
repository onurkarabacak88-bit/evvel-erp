"""
TESLİM BİLDİRİM AKIŞI — İZOLE (2026-07-18).

Sahip talebi: "Ürün personel tarafından kabul edildiğinde ben kontrol etmediğim
sürece haberim olmuyor — telefona/uygulamaya küçük bir bilgi notu çıksın,
Tamam deyince bir daha çıkmasın."

Tasarım (izole duyu kuralı + öneri-only):
- KAYNAK: sube_depo_stok_hareket defteri (TESLIM_GIRIS = toptancı kabulü,
  SEVK_GIRIS = merkez sevkiyat kabulü). Dakika-kovası gruplama: aynı dakikada
  aynı şubeye giren kalemler TEK teslim olayıdır (TEMA 17:20 → 9 kalem/84 adet).
- SALT-OKUR türetme: hiçbir stok/kasa kaydına dokunmaz; yalnız kendi
  'görüldü' defterine yazar (teslim_bildirim_goruldu, anahtar UNIQUE).
- 'Tamam' = kalıcı: anahtar (sube|kaynak|dakika) görüldü defterine girer,
  o olay bir daha görünmez. Hata-yutar; çökse hiçbir akış etkilenmez.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/teslim-bildirim", tags=["teslim-bildirim"])


def _ensure(cur) -> None:
    cur.execute("""CREATE TABLE IF NOT EXISTS teslim_bildirim_goruldu (
                       anahtar TEXT PRIMARY KEY,
                       goruldu_ts TIMESTAMPTZ NOT NULL DEFAULT NOW())""")


@router.get("/liste")
def teslim_bildirim_liste(gun: int = 7, hepsi: int = 0):
    """Görülmemiş teslim olayları (varsayılan) — sahip 'Tamam' deyince düşer."""
    g = max(1, min(int(gun or 7), 30))
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute(
                """SELECT h.sube_id,
                          COALESCE(s.ad, h.sube_id) AS sube_ad,
                          h.kaynak_tip,
                          TO_CHAR(DATE_TRUNC('minute', h.zaman),
                                  'YYYY-MM-DD"T"HH24:MI') AS dk,
                          MIN(h.zaman) AS zaman,
                          COUNT(*)::int AS kalem_adet,
                          COALESCE(SUM(h.miktar),0)::float AS toplam_miktar
                   FROM sube_depo_stok_hareket h
                   LEFT JOIN subeler s ON s.id::text = h.sube_id::text
                   WHERE h.hareket_turu IN ('TESLIM_GIRIS','SEVK_GIRIS')
                     AND h.zaman >= NOW() - (%s || ' days')::interval
                   GROUP BY h.sube_id, s.ad, h.kaynak_tip, dk
                   ORDER BY MIN(h.zaman) DESC LIMIT 60""", (g,))
            olaylar = [dict(r) for r in cur.fetchall() or []]
            cur.execute("SELECT anahtar FROM teslim_bildirim_goruldu")
            gorulen = {r["anahtar"] for r in cur.fetchall() or []}
    except Exception as e:  # noqa: BLE001 — bildirim çökse sistem yaşar
        logger.warning("teslim bildirim listesi hatasi (yutuldu): %s", str(e)[:150])
        return {"olaylar": [], "gorulmemis": 0}
    for o in olaylar:
        o["anahtar"] = f"{o['sube_id']}|{o['kaynak_tip']}|{o['dk']}"
        o["goruldu"] = o["anahtar"] in gorulen
        o["zaman"] = str(o.get("zaman") or "")[:16]
        o["tur"] = ("Toptancı teslimi" if o.get("kaynak_tip") == "teslim_al"
                    else "Merkez sevkiyat kabulü")
    if not hepsi:
        olaylar = [o for o in olaylar if not o["goruldu"]]
    return {"olaylar": olaylar,
            "gorulmemis": len([o for o in olaylar if not o["goruldu"]])}


class GordumBody(BaseModel):
    anahtar: str


@router.post("/gordum")
def teslim_bildirim_gordum(body: GordumBody):
    a = (body.anahtar or "").strip()
    if not a or "|" not in a:
        raise HTTPException(400, "geçersiz anahtar")
    with db() as (_, cur):
        _ensure(cur)
        cur.execute("""INSERT INTO teslim_bildirim_goruldu (anahtar)
                       VALUES (%s) ON CONFLICT (anahtar) DO NOTHING""", (a,))
    return {"ok": True}
