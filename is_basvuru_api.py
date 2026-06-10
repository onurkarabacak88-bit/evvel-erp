"""İş Başvurusu API — CV toplama, listeleme, durum güncelleme."""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
import uuid, io
from datetime import datetime
from database import db
from tr_saat import dt_now_tr

router = APIRouter(prefix="/api/is-basvurusu", tags=["is-basvurusu"])


# ── Modeller ─────────────────────────────────────────────────────────────────

class BasvuruGonder(BaseModel):
    ad_soyad: str
    telefon: str
    dogum_yili: Optional[int] = None
    ilce: Optional[str] = None
    pozisyon: Optional[str] = None          # barista | kasiyer | servis | diger
    tercih_subeler: Optional[List[str]] = None   # ["Zafer","Alsancak",...]
    kahve_deneyim: Optional[str] = None     # var_1yil | var_2yil | yok_ogreneyim | kismi
    onceki_is: Optional[str] = None         # serbest metin
    calisma_tercihi: Optional[str] = None   # tam | yari | esnek
    musait_gunler: Optional[List[str]] = None    # ["Pazartesi","Salı",...]
    baslangic: Optional[str] = None         # hemen | 2hafta | 1ay
    tanitim: Optional[str] = None           # kısa tanıtım
    referans_ad: Optional[str] = None
    referans_tel: Optional[str] = None
    kaynak_sube: Optional[str] = None       # hangi QR'dan geldi (opsiyonel)

class DurumGuncelle(BaseModel):
    durum: str  # bekliyor | gorusme | olumlu | olumsuz | arsiv


# ── DB yardımcıları ──────────────────────────────────────────────────────────

def _ensure_table(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS is_basvuru (
            id TEXT PRIMARY KEY,
            ad_soyad TEXT NOT NULL,
            telefon TEXT NOT NULL,
            dogum_yili INTEGER,
            ilce TEXT,
            pozisyon TEXT,
            tercih_subeler JSONB DEFAULT '[]',
            kahve_deneyim TEXT,
            onceki_is TEXT,
            calisma_tercihi TEXT,
            musait_gunler JSONB DEFAULT '[]',
            baslangic TEXT,
            tanitim TEXT,
            referans_ad TEXT,
            referans_tel TEXT,
            kaynak_sube TEXT,
            durum TEXT NOT NULL DEFAULT 'bekliyor',
            olusturma_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            guncelleme_ts TIMESTAMPTZ
        )
    """)


def _row_to_dict(r):
    import json as _j
    d = dict(r)
    for k in ("tercih_subeler", "musait_gunler"):
        if isinstance(d.get(k), str):
            try:
                d[k] = _j.loads(d[k])
            except Exception:
                d[k] = []
    return d


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("")
def basvuru_gonder(body: BasvuruGonder):
    """Mobil formdan gelen başvuruyu kaydet."""
    if not body.ad_soyad.strip():
        raise HTTPException(400, "Ad soyad zorunlu.")
    if not body.telefon.strip():
        raise HTTPException(400, "Telefon zorunlu.")

    bid = str(uuid.uuid4())
    import json as _j
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("""
            INSERT INTO is_basvuru
                (id, ad_soyad, telefon, dogum_yili, ilce, pozisyon,
                 tercih_subeler, kahve_deneyim, onceki_is, calisma_tercihi,
                 musait_gunler, baslangic, tanitim, referans_ad, referans_tel,
                 kaynak_sube, durum, olusturma_ts)
            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,'bekliyor',%s)
        """, (
            bid,
            body.ad_soyad.strip(),
            body.telefon.strip(),
            body.dogum_yili,
            (body.ilce or "").strip() or None,
            body.pozisyon,
            _j.dumps(body.tercih_subeler or [], ensure_ascii=False),
            body.kahve_deneyim,
            (body.onceki_is or "").strip() or None,
            body.calisma_tercihi,
            _j.dumps(body.musait_gunler or [], ensure_ascii=False),
            body.baslangic,
            (body.tanitim or "").strip() or None,
            (body.referans_ad or "").strip() or None,
            (body.referans_tel or "").strip() or None,
            (body.kaynak_sube or "").strip() or None,
            dt_now_tr(),
        ))
        conn.commit()
    return {"success": True, "id": bid}


@router.get("")
def basvuru_listele(
    durum: Optional[str] = Query(None),
    limit: int = Query(200, le=500),
):
    """Başvuruları listele. durum filtresi: bekliyor|gorusme|olumlu|olumsuz|arsiv"""
    with db() as (conn, cur):
        _ensure_table(cur)
        if durum:
            cur.execute("""
                SELECT * FROM is_basvuru
                WHERE durum = %s
                ORDER BY olusturma_ts DESC LIMIT %s
            """, (durum, limit))
        else:
            cur.execute("""
                SELECT * FROM is_basvuru
                ORDER BY olusturma_ts DESC LIMIT %s
            """, (limit,))
        rows = cur.fetchall()
    return [_row_to_dict(r) for r in rows]


@router.get("/ozet")
def basvuru_ozet():
    """Durum bazlı adet özeti."""
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("""
            SELECT durum, COUNT(*) as adet
            FROM is_basvuru
            GROUP BY durum
        """)
        rows = cur.fetchall()
    return {r["durum"]: r["adet"] for r in rows}


@router.get("/{bid}")
def basvuru_detay(bid: str):
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("SELECT * FROM is_basvuru WHERE id = %s", (bid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Başvuru bulunamadı.")
    return _row_to_dict(row)


@router.patch("/{bid}/durum")
def basvuru_durum_guncelle(bid: str, body: DurumGuncelle):
    gecerli = {"bekliyor", "gorusme", "olumlu", "olumsuz", "arsiv"}
    if body.durum not in gecerli:
        raise HTTPException(400, f"Geçersiz durum. Geçerli: {gecerli}")
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("""
            UPDATE is_basvuru
            SET durum = %s, guncelleme_ts = %s
            WHERE id = %s
        """, (body.durum, dt_now_tr(), bid))
        if cur.rowcount == 0:
            raise HTTPException(404, "Başvuru bulunamadı.")
        conn.commit()
    return {"success": True}


@router.delete("/{bid}")
def basvuru_sil(bid: str):
    with db() as (conn, cur):
        _ensure_table(cur)
        cur.execute("DELETE FROM is_basvuru WHERE id = %s", (bid,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Başvuru bulunamadı.")
        conn.commit()
    return {"success": True}


@router.get("/qr/indir")
def basvuru_qr():
    """İş başvurusu QR kodunu PNG olarak döndür."""
    try:
        import qrcode
        from fastapi.responses import StreamingResponse
        url = "https://evvel-erp-production.up.railway.app/is-basvurusu"
        qr = qrcode.QRCode(version=2, error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="image/png",
            headers={"Content-Disposition": 'attachment; filename="evvel_is_basvurusu_qr.png"'},
        )
    except ImportError:
        raise HTTPException(500, "qrcode kütüphanesi yüklü değil.")
