"""CFO: kasadan bankaya yatırılan tutarların takibi (kim, ne zaman)."""
from __future__ import annotations

import uuid
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from database import db
from kasa_service import audit

router = APIRouter(prefix="/api/banka-yatirimlari", tags=["banka-yatirim"])


class BankaYatirimOlustur(BaseModel):
    tarih: date
    tutar: float = Field(..., gt=0)
    yatiran_ad: str = Field(..., min_length=1, max_length=200)
    aciklama: Optional[str] = Field(None, max_length=500)


@router.get("")
def banka_yatirim_liste(limit: int = Query(200, ge=1, le=500)):
    lim = min(500, max(1, int(limit)))
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT id, tarih, tutar, yatiran_ad, aciklama, olusturma
            FROM banka_yatirimlari
            ORDER BY tarih DESC, olusturma DESC
            LIMIT %s
            """,
            (lim,),
        )
        rows: List[dict] = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("tutar") is not None:
                d["tutar"] = float(d["tutar"])
            rows.append(d)
    return {"satirlar": rows}


@router.post("")
def banka_yatirim_ekle(body: BankaYatirimOlustur):
    tutar = round(float(body.tutar), 2)
    if tutar <= 0:
        raise HTTPException(400, "Tutar pozitif olmalı")
    ad = (body.yatiran_ad or "").strip()
    if not ad:
        raise HTTPException(400, "Yatıran adı gerekli")
    bid = str(uuid.uuid4())
    acik = (body.aciklama or "").strip() or None
    with db() as (conn, cur):
        cur.execute(
            """
            INSERT INTO banka_yatirimlari (id, tarih, tutar, yatiran_ad, aciklama)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (bid, str(body.tarih), tutar, ad, acik),
        )
        audit(cur, "banka_yatirimlari", bid, "INSERT")
    return {"success": True, "id": bid}
