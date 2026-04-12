"""
Merkez ciro taslağı onayı — ödeme onay kuyruğundan ayrı uçlar.
Prefix: /api/ciro-taslak
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit
from sube_panel import _bugun_ciro_var_mi, _ciro_insert_aktif_ve_kasa, _sube_getir

router = APIRouter(prefix="/api/ciro-taslak", tags=["ciro-taslak"])


class CiroTaslakTutarBody(BaseModel):
    nakit: float = 0
    pos: float = 0
    online: float = 0


class CiroTaslakOnayTutarlari(BaseModel):
    """Boş gövde: taslağın mevcut tutarlarıyla onay. Dolu alanlar onay anında düzeltme sayılır."""
    nakit: Optional[float] = None
    pos: Optional[float] = None
    online: Optional[float] = None


class CiroTaslakRedBody(BaseModel):
    neden: str = ""


def _taslak_dict(row: dict) -> dict:
    d = dict(row)
    if d.get("tarih"):
        d["tarih"] = str(d["tarih"])
    if d.get("olusturma"):
        d["olusturma"] = str(d["olusturma"])
    if d.get("onay_zamani"):
        d["onay_zamani"] = str(d["onay_zamani"])
    for k in ("nakit", "pos", "online"):
        if d.get(k) is not None:
            d[k] = float(d[k])
    return d


@router.get("")
def ciro_taslak_liste(durum: str = "bekliyor") -> List[dict]:
    if durum not in ("bekliyor", "onaylandi", "reddedildi", "hepsi"):
        raise HTTPException(400, "durum: bekliyor | onaylandi | reddedildi | hepsi")
    with db() as (conn, cur):
        if durum == "hepsi":
            cur.execute(
                """
                SELECT t.*, s.ad AS sube_adi
                FROM ciro_taslak t
                JOIN subeler s ON s.id = t.sube_id
                ORDER BY t.olusturma DESC
                LIMIT 200
                """
            )
        else:
            cur.execute(
                """
                SELECT t.*, s.ad AS sube_adi
                FROM ciro_taslak t
                JOIN subeler s ON s.id = t.sube_id
                WHERE t.durum = %s
                ORDER BY t.olusturma ASC
                """,
                (durum,),
            )
        rows = cur.fetchall()
    return [_taslak_dict(r) for r in rows]


@router.get("/{taslak_id}")
def ciro_taslak_detay(taslak_id: str):
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT t.*, s.ad AS sube_adi
            FROM ciro_taslak t
            JOIN subeler s ON s.id = t.sube_id
            WHERE t.id = %s
            """,
            (taslak_id,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Taslak bulunamadı")
    return _taslak_dict(dict(row))


@router.patch("/{taslak_id}")
def ciro_taslak_duzenle(taslak_id: str, body: CiroTaslakTutarBody):
    toplam = float(body.nakit or 0) + float(body.pos or 0) + float(body.online or 0)
    if toplam <= 0:
        raise HTTPException(400, "En az bir tutar girilmeli")
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, durum FROM ciro_taslak WHERE id=%s FOR UPDATE",
            (taslak_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Taslak bulunamadı")
        if r["durum"] != "bekliyor":
            raise HTTPException(400, "Yalnızca bekleyen taslaklar düzenlenebilir")
        cur.execute(
            """
            UPDATE ciro_taslak
            SET nakit=%s, pos=%s, online=%s
            WHERE id=%s AND durum='bekliyor'
            """,
            (body.nakit, body.pos, body.online, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "MERKEZ_DUZENLE")
    return {"success": True, "id": taslak_id}


@router.post("/{taslak_id}/onayla")
def ciro_taslak_onayla(taslak_id: str, body: CiroTaslakOnayTutarlari = CiroTaslakOnayTutarlari()):
    """Taslağı onayla; isteğe bağlı gövde ile tutarları onay anında güncelleyebilirsiniz."""
    with db() as (conn, cur):
        cur.execute(
            """
            SELECT * FROM ciro_taslak
            WHERE id=%s AND durum='bekliyor'
            FOR UPDATE
            """,
            (taslak_id,),
        )
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Bekleyen taslak bulunamadı")
        t = dict(t)
        sube_id = t["sube_id"]

        if _bugun_ciro_var_mi(cur, sube_id):
            raise HTTPException(
                409,
                "Bu şube için bugün onaylı ciro zaten var — taslak çakışıyor.",
            )

        nakit = float(body.nakit) if body.nakit is not None else float(t["nakit"])
        pos = float(body.pos) if body.pos is not None else float(t["pos"])
        online = float(body.online) if body.online is not None else float(t["online"])
        if nakit + pos + online <= 0:
            raise HTTPException(400, "Onay tutarları geçersiz")

        sube = _sube_getir(cur, sube_id)
        aciklama = (t.get("aciklama") or "").strip() or "Şube paneli taslağı — onay"
        sonuc = _ciro_insert_aktif_ve_kasa(
            cur,
            sube,
            sube_id,
            nakit,
            pos,
            online,
            aciklama,
            audit_etiket="CIRO_TASLAK_ONAY",
        )
        cid = sonuc["id"]

        cur.execute(
            """
            UPDATE ciro_taslak
            SET durum='onaylandi', onay_zamani=NOW(), ciro_id=%s,
                nakit=%s, pos=%s, online=%s
            WHERE id=%s
            """,
            (cid, nakit, pos, online, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "ONAYLANDI")

    return {
        "success": True,
        "ciro_id": cid,
        "net_tutar": sonuc["net_tutar"],
        "pos_kesinti": sonuc["pos_kesinti"],
        "online_kesinti": sonuc["online_kesinti"],
    }


@router.post("/{taslak_id}/reddet")
def ciro_taslak_reddet(taslak_id: str, body: CiroTaslakRedBody):
    neden = (body.neden or "").strip() or "Reddedildi"
    with db() as (conn, cur):
        cur.execute(
            "SELECT id, durum FROM ciro_taslak WHERE id=%s FOR UPDATE",
            (taslak_id,),
        )
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Taslak bulunamadı")
        if r["durum"] != "bekliyor":
            raise HTTPException(400, "Yalnızca bekleyen taslaklar reddedilebilir")
        cur.execute(
            """
            UPDATE ciro_taslak
            SET durum='reddedildi', red_nedeni=%s, onay_zamani=NOW()
            WHERE id=%s
            """,
            (neden, taslak_id),
        )
        audit(cur, "ciro_taslak", taslak_id, "REDDEDILDI")
    return {"success": True, "id": taslak_id}
