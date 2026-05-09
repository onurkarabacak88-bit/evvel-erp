from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

router = APIRouter(tags=["tedarikci"])


class TedarikciBody(BaseModel):
    ad: str
    kategori: str = ""
    telefon: str = ""
    aciklama: str = ""


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
    return {"success": True, "id": tid}


@router.put("/api/tedarikciler/{tid}")
def tedarikci_guncelle(tid: str, body: TedarikciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Tedarikçi adı en az 2 karakter olmalı")
    with db() as (conn, cur):
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
    return {"success": True}


@router.delete("/api/tedarikciler/{tid}")
def tedarikci_sil(tid: str):
    with db() as (conn, cur):
        cur.execute("UPDATE tedarikciler SET aktif=FALSE WHERE id=%s", (tid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Tedarikçi bulunamadı")
    return {"success": True}

