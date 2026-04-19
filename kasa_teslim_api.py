from __future__ import annotations

import uuid
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db
from kasa_service import audit

router = APIRouter(tags=["kasa-teslim"])


# ── KASA TESLİM ALICI CRUD ────────────────────────────────────
class KasaTeslimAliciBody(BaseModel):
    ad: str
    unvan: str = ""
    sube_id: Optional[str] = None


@router.get("/api/kasa-teslim-alici")
def kasa_teslim_alici_liste(sube_id: Optional[str] = None, aktif: bool = True):
    with db() as (conn, cur):
        q = """
            SELECT k.*, s.ad AS sube_adi
            FROM kasa_teslim_alici k
            LEFT JOIN subeler s ON s.id = k.sube_id
            WHERE k.aktif = %s
              AND (%s IS NULL OR k.sube_id = %s OR k.sube_id IS NULL)
            ORDER BY k.ad
        """
        cur.execute(q, (aktif, sube_id, sube_id))
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            rows.append(d)
    return {"alicilar": rows}


@router.post("/api/kasa-teslim-alici")
def kasa_teslim_alici_ekle(body: KasaTeslimAliciBody):
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ad en az 2 karakter olmalı")
    with db() as (conn, cur):
        tid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO kasa_teslim_alici (id, ad, unvan, sube_id)
               VALUES (%s, %s, %s, %s)""",
            (
                tid,
                ad,
                (body.unvan or "").strip() or None,
                (body.sube_id or "").strip() or None,
            ),
        )
    return {"success": True, "id": tid}


@router.put("/api/kasa-teslim-alici/{tid}")
def kasa_teslim_alici_guncelle(tid: str, body: KasaTeslimAliciBody):
    with db() as (conn, cur):
        cur.execute(
            """UPDATE kasa_teslim_alici
               SET ad=%s, unvan=%s, sube_id=%s
               WHERE id=%s""",
            (
                (body.ad or "").strip(),
                (body.unvan or "").strip() or None,
                (body.sube_id or "").strip() or None,
                tid,
            ),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Kayıt bulunamadı")
    return {"success": True}


@router.delete("/api/kasa-teslim-alici/{tid}")
def kasa_teslim_alici_sil(tid: str):
    with db() as (conn, cur):
        cur.execute("UPDATE kasa_teslim_alici SET aktif=FALSE WHERE id=%s", (tid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Kayıt bulunamadı")
    return {"success": True}


# ── KASA TESLİM HAREKETLERİ ──────────────────────────────────
class KasaTeslimBody(BaseModel):
    sube_id: str
    tutar: float
    teslim_eden_personel_id: Optional[str] = None
    teslim_eden_ad: Optional[str] = None
    teslim_alan_id: str
    teslim_turu: str = "ara"  # 'ara' | 'gun_sonu'
    aciklama: Optional[str] = None
    pin: Optional[str] = None


@router.post("/api/kasa-teslim")
def kasa_teslim_ekle(body: KasaTeslimBody):
    if body.tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    if body.teslim_turu not in ("ara", "gun_sonu"):
        raise HTTPException(400, "teslim_turu: ara | gun_sonu")

    with db() as (conn, cur):
        # Teslim alan kontrolü
        cur.execute(
            "SELECT id, ad, unvan FROM kasa_teslim_alici WHERE id=%s AND aktif=TRUE",
            (body.teslim_alan_id,),
        )
        alici = cur.fetchone()
        if not alici:
            raise HTTPException(404, "Teslim alıcı bulunamadı")
        alici = dict(alici)

        # PIN doğrulama (opsiyonel)
        onay_ad = (body.teslim_eden_ad or "").strip() or "—"
        pid = (body.teslim_eden_personel_id or "").strip() or None
        if pid and (body.pin or "").strip():
            from personel_panel_auth import dogrula_personel_panel_pin

            ku = dogrula_personel_panel_pin(cur, pid, body.pin.strip())
            onay_ad = (ku.get("ad_soyad") or onay_ad).strip()
            pid = str(ku.get("id") or pid)

        tid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO kasa_teslim
               (id, sube_id, tarih, tutar,
                teslim_eden_personel_id, teslim_eden_ad,
                teslim_alan_id, teslim_alan_ad,
                teslim_turu, aciklama)
               VALUES (%s, %s, CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s)""",
            (
                tid,
                body.sube_id,
                body.tutar,
                pid,
                onay_ad,
                body.teslim_alan_id,
                alici["ad"] + (" — " + alici["unvan"] if alici.get("unvan") else ""),
                body.teslim_turu,
                (body.aciklama or "").strip() or None,
            ),
        )
        audit(cur, "kasa_teslim", tid, "KASA_TESLIM")

        from operasyon_defter import operasyon_defter_ekle
        from tr_saat import dt_now_tr

        saat = dt_now_tr().strftime("%H:%M:%S")
        operasyon_defter_ekle(
            cur,
            body.sube_id,
            "KASA_TESLIM",
            f"Kasa teslim — {body.teslim_turu} — {onay_ad} → {alici['ad']} — {body.tutar:,.0f}₺",
            bildirim_saati=saat,
            personel_id=pid,
            personel_ad=onay_ad,
        )

    return {"success": True, "id": tid}


@router.get("/api/kasa-teslim")
def kasa_teslim_liste(
    sube_id: Optional[str] = None,
    tarih_baslangic: Optional[str] = None,
    tarih_bitis: Optional[str] = None,
    teslim_eden_ad: Optional[str] = None,
    teslim_alan_id: Optional[str] = None,
    teslim_turu: Optional[str] = None,
    limit: int = 300,
):
    lim = max(10, min(1000, int(limit)))
    with db() as (conn, cur):
        qp: List[Any] = []
        where: List[str] = ["1=1"]

        if sube_id:
            where.append("k.sube_id = %s")
            qp.append(sube_id)
        if tarih_baslangic:
            where.append("k.tarih >= %s::date")
            qp.append(tarih_baslangic)
        if tarih_bitis:
            where.append("k.tarih <= %s::date")
            qp.append(tarih_bitis)
        if teslim_eden_ad:
            where.append("k.teslim_eden_ad ILIKE %s")
            qp.append(f"%{teslim_eden_ad}%")
        if teslim_alan_id:
            where.append("k.teslim_alan_id = %s")
            qp.append(teslim_alan_id)
        if teslim_turu:
            where.append("k.teslim_turu = %s")
            qp.append(teslim_turu)

        qp_list = list(qp)
        qp_list.append(lim)
        cur.execute(
            f"""
            SELECT
                k.*,
                s.ad AS sube_adi
            FROM kasa_teslim k
            JOIN subeler s ON s.id = k.sube_id
            WHERE {' AND '.join(where)}
            ORDER BY k.tarih DESC, k.olusturma DESC
            LIMIT %s
            """,
            qp_list,
        )
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            if d.get("olusturma"):
                d["olusturma"] = str(d["olusturma"])
            if d.get("tarih"):
                d["tarih"] = str(d["tarih"])
            d["tutar"] = float(d["tutar"])
            rows.append(d)

        # Özet (limit'siz)
        cur.execute(
            f"""
            SELECT
                teslim_turu,
                COUNT(*)::int AS adet,
                COALESCE(SUM(tutar), 0) AS toplam
            FROM kasa_teslim k
            WHERE {' AND '.join(where)}
            GROUP BY teslim_turu
            """,
            qp,
        )
        ozet = {
            str(r["teslim_turu"]): {"adet": int(r["adet"]), "toplam": float(r["toplam"] or 0)}
            for r in cur.fetchall()
        }

    return {
        "satirlar": rows,
        "toplam_adet": len(rows),
        "toplam_tutar": sum(r["tutar"] for r in rows),
        "ozet": ozet,
    }

