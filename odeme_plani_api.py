"""Ödeme planı — salt okuma uçları (GET).

Mutasyon uçları (POST /ode, /ertele, /kismi-ode, DELETE vb.) main.py içinde kalır;
ortak iş mantığı (odeme_yap vb.) ile sıkı bağlı oldukları için aşamalı taşınır.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from database import db

router = APIRouter(tags=["odeme-plani"])


@router.get("/api/odeme-plani/{oid}/kaynak")
def odeme_plani_kaynak(oid: str):
    """Panel'in vadeli alım kart önerisi için kaynak_tablo ve kaynak_id döner."""
    with db() as (conn, cur):
        cur.execute("SELECT kaynak_tablo, kaynak_id FROM odeme_plani WHERE id=%s", (oid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404)
        return {"kaynak_tablo": row["kaynak_tablo"], "kaynak_id": row["kaynak_id"]}


@router.get("/api/odeme-plani")
def odeme_plani_listele():
    with db() as (conn, cur):
        cur.execute(
            """SELECT op.*, k.banka, k.kart_adi, k.faiz_orani FROM odeme_plani op
            JOIN kartlar k ON k.id=op.kart_id
            WHERE op.tarih >= CURRENT_DATE - INTERVAL '30 days'
            ORDER BY op.tarih ASC"""
        )
        return [dict(r) for r in cur.fetchall()]
