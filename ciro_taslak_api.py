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
    nakit = float(body.nakit or 0)
    pos = float(body.pos or 0)
    online = float(body.online or 0)
    if online > 0.001 and nakit > 0.001 and pos > 0.001 and abs(online - (nakit + pos)) < 0.01:
        raise HTTPException(
            400,
            "Online tutarı nakit+POS toplamına eşit — çift sayım. Online yoksa 0 girin.",
        )
    toplam = nakit + pos + online
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
        lock_key = f"ciro:{sube_id}:{t.get('tarih')}"
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))
        cur.execute(
            """
            SELECT id
            FROM ciro
            WHERE sube_id=%s AND tarih=%s AND durum='aktif'
            FOR UPDATE
            """,
            (sube_id, t.get("tarih")),
        )
        if cur.fetchone():
            raise HTTPException(
                409,
                "Bu şube için bugün onaylı ciro zaten var — taslak çakışıyor.",
            )

        if _bugun_ciro_var_mi(cur, sube_id):
            raise HTTPException(
                409,
                "Bu şube için bugün onaylı ciro zaten var — taslak çakışıyor.",
            )

        nakit = float(body.nakit) if body.nakit is not None else float(t["nakit"])
        pos = float(body.pos) if body.pos is not None else float(t["pos"])
        online = float(body.online) if body.online is not None else float(t["online"])
        if online > 0.001 and nakit > 0.001 and pos > 0.001 and abs(online - (nakit + pos)) < 0.01:
            raise HTTPException(
                400,
                "Online tutarı nakit+POS toplamına eşit — çift sayım. Online yoksa 0 onaylayın.",
            )
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
            tarih=t.get("tarih"),  # Taslağın gerçek gelir tarihi — bugün değil
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

        # ── RAPOR CACHE HOOK ── (defensive)
        try:
            from rapor_cache import gunluk_ozet_yenile
            gunluk_ozet_yenile(cur, sube_id, t.get("tarih"), kaynak='event_ciro_onay')
        except Exception:
            pass

    return {
        "success": True,
        "ciro_id": cid,
        "net_tutar": sonuc["net_tutar"],
        "pos_kesinti": sonuc["pos_kesinti"],
        "online_kesinti": sonuc["online_kesinti"],
    }


class GecmisCiroBody(BaseModel):
    sube_ad: str = "tema"        # şube adı parçası (ILIKE)
    tarih: str                   # YYYY-MM-DD (geçmiş gün)
    nakit: float = 0
    pos: float = 0
    online: float = 0
    uygula: bool = False         # False → sadece önizleme


@router.post("/gecmis-gun-gonder")
def gecmis_gun_ciro_gonder(body: GecmisCiroBody):
    """Geçmiş bir gün için (kapanışı yapılmamış) ciroyu kaydeder — mevcut onay
    pipeline'ının çekirdeği (_ciro_insert_aktif_ve_kasa, tarih=geçmiş) ile ciro +
    kasa + günlük özet üretir. İdempotent: o tarihte aktif ciro varsa eklemez.
    uygula=False → önizleme (yazmaz)."""
    sad = f"%{(body.sube_ad or '').strip().lower()}%"
    nakit = float(body.nakit or 0); pos = float(body.pos or 0); online = float(body.online or 0)
    toplam = round(nakit + pos + online, 2)
    if toplam <= 0:
        raise HTTPException(400, "Tutar 0 — nakit/pos girilmeli")
    with db() as (conn, cur):
        cur.execute("SELECT id, ad FROM subeler WHERE LOWER(ad) LIKE %s ORDER BY ad LIMIT 1", (sad,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Şube bulunamadı")
        sube_id = s["id"]; sube_ad2 = s["ad"]
        # İdempotent: o tarihte aktif ciro zaten var mı?
        cur.execute("SELECT id FROM ciro WHERE sube_id=%s AND tarih=%s::date AND durum='aktif' LIMIT 1",
                    (sube_id, body.tarih))
        if cur.fetchone():
            return {"durum": "zaten_var", "sube": sube_ad2, "tarih": body.tarih,
                    "mesaj": f"{sube_ad2} {body.tarih} için zaten aktif ciro var — eklenmedi."}
        if not body.uygula:
            return {"durum": "onizleme", "sube": sube_ad2, "tarih": body.tarih,
                    "nakit": nakit, "pos": pos, "online": online, "toplam": toplam,
                    "mesaj": "ÖNİZLEME — henüz gönderilmedi."}
        sube = _sube_getir(cur, sube_id)
        sonuc = _ciro_insert_aktif_ve_kasa(
            cur, sube, sube_id, nakit, pos, online,
            f"Geçmiş gün ciro (Evo) — {body.tarih}",
            audit_etiket="GECMIS_CIRO_EVO", tarih=body.tarih,
        )
        try:
            from rapor_cache import gunluk_ozet_yenile
            gunluk_ozet_yenile(cur, sube_id, body.tarih, kaynak='gecmis_ciro_evo')
        except Exception:
            pass
    return {"durum": "gonderildi", "sube": sube_ad2, "tarih": body.tarih,
            "nakit": nakit, "pos": pos, "online": online, "toplam": toplam,
            "ciro_id": sonuc.get("id"), "mesaj": "Ciro kaydedildi (ciro + kasa + özet)."}


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
