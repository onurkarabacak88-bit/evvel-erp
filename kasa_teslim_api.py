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
    # 🟡 P2 (2026-08-12): create'te ad>=2 kontrolü vardı, update'te YOKTU → mevcut
    # alıcı boş/tek-karakter ada ezilip teslim kayıtlarının okunurluğu bozulabiliyordu.
    ad = (body.ad or "").strip()
    if len(ad) < 2:
        raise HTTPException(400, "Ad en az 2 karakter olmalı")
    with db() as (conn, cur):
        cur.execute(
            """UPDATE kasa_teslim_alici
               SET ad=%s, unvan=%s, sube_id=%s
               WHERE id=%s""",
            (
                ad,
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
    """
    FIX KP5 (2026-07-06): bu uç kimliksizdi — PIN opsiyonel, şube doğrulanmıyordu; kasa teslimi
    kapanış farkını doğrudan etkilediği için curl ile isimsiz/istenen ada yazılabiliyordu.
    Şube panelinin ara-teslim ucu (sube_panel.sube_ara_kasa_teslim) zaten sıkıydı ve tüm meşru
    akış oradan geçiyor (bu ucu çağıran frontend YOK) → aynı disipline çekildi:
    şube doğrulanır + teslim eden personel + 4 haneli panel PIN ZORUNLU.
    """
    if body.tutar <= 0:
        raise HTTPException(400, "Tutar sıfırdan büyük olmalı")
    if body.teslim_turu not in ("ara", "gun_sonu"):
        raise HTTPException(400, "teslim_turu: ara | gun_sonu")
    pid_in = (body.teslim_eden_personel_id or "").strip()
    pin = (body.pin or "").replace(" ", "")
    if not pid_in:
        raise HTTPException(400, "teslim_eden_personel_id gerekli")
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "4 haneli panel PIN gerekli")

    with db() as (conn, cur):
        # Şube doğrulama — kapanış farkı şube bazlı hesaplanır, hayalet şubeye teslim yazılamaz
        cur.execute("SELECT 1 FROM subeler WHERE id=%s", ((body.sube_id or "").strip(),))
        if not cur.fetchone():
            raise HTTPException(404, "Şube bulunamadı")

        # Teslim alan kontrolü
        cur.execute(
            "SELECT id, ad, unvan FROM kasa_teslim_alici WHERE id=%s AND aktif=TRUE",
            (body.teslim_alan_id,),
        )
        alici = cur.fetchone()
        if not alici:
            raise HTTPException(404, "Teslim alıcı bulunamadı")
        alici = dict(alici)

        # PIN doğrulama (ZORUNLU — kasa teslimi kimliksiz olamaz)
        from personel_panel_auth import dogrula_personel_panel_pin

        ku = dogrula_personel_panel_pin(cur, pid_in, pin)
        onay_ad = (ku.get("ad_soyad") or "").strip() or "—"
        pid = str(ku.get("id") or pid_in)

        from tr_saat import dt_now_tr, is_gunu_tr

        tid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO kasa_teslim
               (id, sube_id, tarih, tutar,
                teslim_eden_personel_id, teslim_eden_ad,
                teslim_alan_id, teslim_alan_ad,
                teslim_turu, aciklama)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                tid,
                body.sube_id,
                is_gunu_tr(),
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

        # 💵 TESLİMİ HEMEN DEFTERE İŞLE (2026-08-18)
        # Defterleşme (KASA_TESLIM_CIKIS/GIRIS çift kaydı) başlangıçta da
        # çalışır AMA yalnız uygulama yeniden başlayınca. Bugün canlıda tam bu
        # görüldü: iki yeni teslim (ZAFER 4.600 · TEMA 1.500) ancak deploy
        # sonrası çift kayda döndü. Deploy olmayan bir haftada yeni teslimler
        # defterde İZSİZ kalırdı — düzelttiğimiz kusurun aynısı geri gelirdi.
        # İdempotent ve ucuz: yalnız eşi olmayan teslimleri işler.
        try:
            from database import ensure_kasa_teslim_defterlesme
            ensure_kasa_teslim_defterlesme(cur)
        except Exception:  # noqa: BLE001 — defterleşme teslim kaydını ASLA kilitlemez
            pass

        from operasyon_defter import operasyon_defter_ekle

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

