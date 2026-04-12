"""
Şube personel paneli API — dar DTO (finansal sonuç / fark / analiz yok).
Prefix: /api/sube-personel
"""
from __future__ import annotations

from fastapi import APIRouter

from database import db
from sube_panel import _build_sube_panel_payload, sube_personel_panel_public

router = APIRouter(prefix="/api/sube-personel", tags=["sube-personel"])


@router.get("/{sube_id}/durum")
def personel_sube_durum(sube_id: str):
    with db() as (conn, cur):
        full = _build_sube_panel_payload(cur, sube_id)
    return sube_personel_panel_public(full)
