from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from database import db
from tr_saat import bugun_tr
from kasa_service import kart_plan_guncelle_tx
from motors import aylik_odeme_plani_uret, uyari_motoru

router = APIRouter(tags=["odeme-plani-motor"])
logger = logging.getLogger("evvel-erp")


@router.post("/api/kart-plan-guncelle")
def kart_plan_guncelle_api():
    """Kart borçlarını hesaplayıp mevcut bekleyen planları günceller (tek transaction)."""
    with db() as (conn, cur):
        guncellenen = kart_plan_guncelle_tx(cur)
    return {"success": True, "guncellenen": guncellenen}


@router.post("/api/odeme-plani/uret")
def odeme_plani_manuel_uret(yil: Optional[int] = None, ay: Optional[int] = None):
    """Manuel ödeme planı üretimi — butona basınca çalışır."""
    try:
        sonuc = aylik_odeme_plani_uret(yil, ay)
        return sonuc
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/uyarilar")
def uyarilari_listele():
    """Yaklaşan ödemelerin uyarılarını döner."""
    try:
        # Scheduler durmuş olsa bile ayın planını istek anında garanti et.
        try:
            bugun = bugun_tr()
            aylik_odeme_plani_uret(bugun.year, bugun.month)
        except Exception as pe:
            logger.warning(f"Uyarı öncesi plan üretim denemesi başarısız: {pe}")
        return uyari_motoru()
    except Exception as e:
        raise HTTPException(500, str(e))

