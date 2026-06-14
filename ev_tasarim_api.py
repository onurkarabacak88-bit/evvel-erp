"""
Ev Tasarımı — kişisel iç mimari tasarım aracı.

Oda fotoğrafı + ölçüler + referans (ilham) görsellerine göre AI ile yeniden
tasarlanmış oda görseli ve yaklaşık maliyet tahmini üretir. Görseller Postgres'te
bytea olarak saklanır (Railway dosya sistemi kalıcı değil).
"""
from __future__ import annotations

import base64
import io
import json
import os
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from database import db

router = APIRouter(tags=["ev-tasarim"])

_MAX_UPLOAD_BYTES = 12 * 1024 * 1024
_MAX_BOYUT = 1536


def _resim_isle(raw: bytes) -> tuple[bytes, str]:
    """Yüklenen görseli PNG'ye çevirir ve büyükse yeniden boyutlandırır."""
    try:
        from PIL import Image
    except ImportError as e:
        raise HTTPException(503, "pillow paketi yüklü değil") from e

    try:
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGB")
    except Exception as e:
        raise HTTPException(400, "Geçersiz görüntü dosyası") from e

    if max(img.size) > _MAX_BOYUT:
        img.thumbnail((_MAX_BOYUT, _MAX_BOYUT))

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), "image/png"


def _maske_isle(raw: bytes, target_size: tuple[int, int]) -> bytes:
    """Maske görselini RGBA olarak işler ve hedef boyuta (oda fotoğrafı) eşitler."""
    try:
        from PIL import Image
    except ImportError as e:
        raise HTTPException(503, "pillow paketi yüklü değil") from e

    try:
        img = Image.open(io.BytesIO(raw))
        img = img.convert("RGBA")
    except Exception as e:
        raise HTTPException(400, "Geçersiz maske dosyası") from e

    if img.size != target_size:
        img = img.resize(target_size)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class OdaBody(BaseModel):
    isim: str
    genislik_m: Optional[float] = None
    uzunluk_m: Optional[float] = None
    yukseklik_m: Optional[float] = None
    notlar: str = ""


@router.get("/api/ev-tasarim/odalar")
def oda_liste():
    with db() as (conn, cur):
        cur.execute("""
            SELECT o.id, o.isim, o.genislik_m, o.uzunluk_m, o.yukseklik_m, o.notlar, o.olusturma,
                   COUNT(*) FILTER (WHERE g.tip = 'foto')     AS foto_sayisi,
                   COUNT(*) FILTER (WHERE g.tip = 'referans') AS referans_sayisi,
                   COUNT(*) FILTER (WHERE g.tip = 'urun')     AS urun_sayisi,
                   COUNT(*) FILTER (WHERE g.tip = 'uretilen') AS uretilen_sayisi
            FROM ev_tasarim_oda o
            LEFT JOIN ev_tasarim_gorsel g ON g.oda_id = o.id
            GROUP BY o.id
            ORDER BY o.olusturma DESC
        """)
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["id"] = str(d["id"])
            d["olusturma"] = str(d["olusturma"]) if d.get("olusturma") else None
            rows.append(d)
    return {"odalar": rows}


@router.post("/api/ev-tasarim/odalar")
def oda_ekle(body: OdaBody):
    isim = (body.isim or "").strip()
    if len(isim) < 2:
        raise HTTPException(400, "Oda adı en az 2 karakter olmalı")
    with db() as (conn, cur):
        cur.execute("""
            INSERT INTO ev_tasarim_oda (isim, genislik_m, uzunluk_m, yukseklik_m, notlar)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
        """, (isim, body.genislik_m, body.uzunluk_m, body.yukseklik_m, (body.notlar or "").strip() or None))
        oid = cur.fetchone()["id"]
    return {"success": True, "id": str(oid)}


@router.put("/api/ev-tasarim/odalar/{oda_id}")
def oda_guncelle(oda_id: str, body: OdaBody):
    isim = (body.isim or "").strip()
    if len(isim) < 2:
        raise HTTPException(400, "Oda adı en az 2 karakter olmalı")
    with db() as (conn, cur):
        cur.execute("""
            UPDATE ev_tasarim_oda
            SET isim=%s, genislik_m=%s, uzunluk_m=%s, yukseklik_m=%s, notlar=%s
            WHERE id=%s
        """, (isim, body.genislik_m, body.uzunluk_m, body.yukseklik_m,
              (body.notlar or "").strip() or None, oda_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "Oda bulunamadı")
    return {"success": True}


@router.delete("/api/ev-tasarim/odalar/{oda_id}")
def oda_sil(oda_id: str):
    with db() as (conn, cur):
        cur.execute("DELETE FROM ev_tasarim_oda WHERE id=%s", (oda_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Oda bulunamadı")
    return {"success": True}


@router.post("/api/ev-tasarim/odalar/{oda_id}/gorsel")
async def gorsel_yukle(oda_id: str, tip: str = Form(...), dosya: UploadFile = File(...)):
    if tip not in ("foto", "referans", "urun"):
        raise HTTPException(400, "tip 'foto', 'referans' veya 'urun' olmalı")

    raw = await dosya.read()
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Dosya çok büyük (en fazla 12 MB)")

    png_bytes, mime = _resim_isle(raw)

    with db() as (conn, cur):
        cur.execute("SELECT id FROM ev_tasarim_oda WHERE id=%s", (oda_id,))
        if not cur.fetchone():
            raise HTTPException(404, "Oda bulunamadı")
        cur.execute("""
            INSERT INTO ev_tasarim_gorsel (oda_id, tip, veri, mime)
            VALUES (%s, %s, %s, %s)
            RETURNING id
        """, (oda_id, tip, psycopg2.Binary(png_bytes), mime))
        gid = cur.fetchone()["id"]
    return {"success": True, "id": str(gid)}


@router.get("/api/ev-tasarim/odalar/{oda_id}/gorseller")
def gorsel_liste(oda_id: str, tip: Optional[str] = None):
    with db() as (conn, cur):
        cur.execute("""
            SELECT id, tip, olusturma
            FROM ev_tasarim_gorsel
            WHERE oda_id=%s AND (%s IS NULL OR tip=%s)
            ORDER BY olusturma DESC
        """, (oda_id, tip, tip))
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["id"] = str(d["id"])
            d["olusturma"] = str(d["olusturma"]) if d.get("olusturma") else None
            rows.append(d)
    return {"gorseller": rows}


@router.get("/api/ev-tasarim/gorsel/{gorsel_id}")
def gorsel_getir(gorsel_id: str):
    with db() as (conn, cur):
        cur.execute("SELECT veri, mime FROM ev_tasarim_gorsel WHERE id=%s", (gorsel_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Görsel bulunamadı")
    return Response(content=bytes(row["veri"]), media_type=row["mime"])


@router.delete("/api/ev-tasarim/gorsel/{gorsel_id}")
def gorsel_sil(gorsel_id: str):
    with db() as (conn, cur):
        cur.execute("DELETE FROM ev_tasarim_gorsel WHERE id=%s", (gorsel_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Görsel bulunamadı")
    return {"success": True}


@router.get("/api/ev-tasarim/odalar/{oda_id}/oneriler")
def oneri_liste(oda_id: str):
    with db() as (conn, cur):
        cur.execute("""
            SELECT g.id AS gorsel_id, g.prompt, g.olusturma,
                   m.id AS maliyet_id, m.icerik AS maliyet
            FROM ev_tasarim_gorsel g
            LEFT JOIN ev_tasarim_maliyet m ON m.gorsel_id = g.id
            WHERE g.oda_id=%s AND g.tip='uretilen'
            ORDER BY g.olusturma DESC
        """, (oda_id,))
        rows = []
        for r in cur.fetchall():
            d = dict(r)
            d["gorsel_id"] = str(d["gorsel_id"])
            d["maliyet_id"] = str(d["maliyet_id"]) if d.get("maliyet_id") else None
            d["olusturma"] = str(d["olusturma"]) if d.get("olusturma") else None
            rows.append(d)
    return {"oneriler": rows}


@router.post("/api/ev-tasarim/odalar/{oda_id}/tasarim-uret")
def tasarim_uret(oda_id: str, stil_notu: str = Form(""), maske: Optional[UploadFile] = File(None)):
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(503, "OPENAI_API_KEY ortam değişkeni tanımlı değil — tasarım üretimi kullanılamaz.")

    try:
        from openai import OpenAI
    except ImportError as e:
        raise HTTPException(503, "openai paketi yüklü değil: pip install openai") from e

    with db() as (conn, cur):
        cur.execute("SELECT isim, genislik_m, uzunluk_m, yukseklik_m, notlar FROM ev_tasarim_oda WHERE id=%s", (oda_id,))
        oda = cur.fetchone()
        if not oda:
            raise HTTPException(404, "Oda bulunamadı")

        cur.execute("""
            SELECT id, veri, mime FROM ev_tasarim_gorsel
            WHERE oda_id=%s AND tip='foto' ORDER BY olusturma DESC LIMIT 1
        """, (oda_id,))
        foto = cur.fetchone()
        if not foto:
            raise HTTPException(400, "Önce odanın bir fotoğrafını yükleyin")

        cur.execute("""
            SELECT veri, mime FROM ev_tasarim_gorsel
            WHERE oda_id=%s AND tip='referans' ORDER BY olusturma DESC LIMIT 4
        """, (oda_id,))
        referanslar = cur.fetchall()

        cur.execute("""
            SELECT veri, mime FROM ev_tasarim_gorsel
            WHERE oda_id=%s AND tip='urun' ORDER BY olusturma DESC LIMIT 4
        """, (oda_id,))
        urunler = cur.fetchall()

    client = OpenAI(api_key=api_key)

    # 1) Referans görsellerden stil özeti çıkar (varsa)
    stil_ozeti = ""
    if referanslar:
        try:
            content = [{"type": "text", "text": (
                "Bu görseller bir iç mekan tasarımı için ilham/referans olarak verildi. "
                "Renk paleti, malzemeler, mobilya tarzı ve genel atmosferi 2-3 cümlede özetle. "
                "Sadece özet metni döndür, başka açıklama yazma."
            )}]
            for ref in referanslar:
                b64 = base64.b64encode(bytes(ref["veri"])).decode("ascii")
                content.append({"type": "image_url", "image_url": {"url": f"data:{ref['mime']};base64,{b64}"}})
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_EV_TASARIM_VISION_MODEL", "gpt-4o-mini"),
                messages=[{"role": "user", "content": content}],
                max_tokens=300,
            )
            stil_ozeti = (resp.choices[0].message.content or "").strip()
        except Exception:
            stil_ozeti = ""

    # 2) Tasarım prompt'unu oluştur
    olcu_parcalari = []
    if oda.get("genislik_m"):
        olcu_parcalari.append(f"genişlik {oda['genislik_m']} m")
    if oda.get("uzunluk_m"):
        olcu_parcalari.append(f"uzunluk {oda['uzunluk_m']} m")
    if oda.get("yukseklik_m"):
        olcu_parcalari.append(f"tavan yüksekliği {oda['yukseklik_m']} m")
    olcu_metni = ", ".join(olcu_parcalari)

    prompt_parcalari = [
        f"Bu odayı ({oda['isim']}) yeniden tasarla, iç mimari render olarak göster.",
        "Odanın temel yapısını (pencere, kapı, duvar konumları) koru, sadece dekorasyon/mobilya/renk/aydınlatmayı yenile.",
    ]
    if olcu_metni:
        prompt_parcalari.append(f"Oda ölçüleri: {olcu_metni}.")
    if stil_ozeti:
        prompt_parcalari.append(f"İstenen tarz/referanslardan çıkarılan özet: {stil_ozeti}")
    if oda.get("notlar"):
        prompt_parcalari.append(f"Oda notları: {oda['notlar']}")
    if stil_notu and stil_notu.strip():
        prompt_parcalari.append(f"Kullanıcı isteği: {stil_notu.strip()}")

    maske_bytes: Optional[bytes] = None
    if maske is not None:
        maske_raw = maske.file.read()
        if maske_raw:
            maske_bytes = maske_raw

    if maske_bytes:
        prompt_parcalari.append(
            "Şeffaf/işaretsiz alanlardaki mevcut mobilya ve eşyalar DEĞİŞTİRİLMEYECEK — "
            "sadece maske ile boyanmamış diğer alanlar (duvar, zemin, genel dekorasyon) "
            "yeniden tasarlanacak."
        )
    if urunler:
        prompt_parcalari.append(
            f"Ayrıca, sağlanan {len(urunler)} ek ürün görselindeki ürünleri "
            "(mobilya/aksesuar) bu tasarıma, görseldeki haline (rengi, formu, "
            "dokusu) olabildiğince sadık kalarak uygun bir konuma yerleştir."
        )
    prompt = " ".join(prompt_parcalari)

    # 3) Görsel üret
    try:
        from PIL import Image

        foto_bytes = bytes(foto["veri"])
        target_size = Image.open(io.BytesIO(foto_bytes)).size

        img_file = io.BytesIO(foto_bytes)
        img_file.name = "oda.png"

        image_arg = img_file
        if urunler:
            urun_dosyalari = []
            for i, urun in enumerate(urunler):
                uf = io.BytesIO(bytes(urun["veri"]))
                uf.name = f"urun_{i}.png"
                urun_dosyalari.append(uf)
            image_arg = [img_file, *urun_dosyalari]

        edit_kwargs = {}
        if maske_bytes:
            islenmis_maske = _maske_isle(maske_bytes, target_size)
            mask_file = io.BytesIO(islenmis_maske)
            mask_file.name = "mask.png"
            edit_kwargs["mask"] = mask_file

        result = client.images.edit(
            model=os.getenv("OPENAI_EV_TASARIM_IMAGE_MODEL", "gpt-image-1"),
            image=image_arg,
            prompt=prompt,
            **edit_kwargs,
        )
        b64_out = result.data[0].b64_json
        uretilen_bytes = base64.b64decode(b64_out)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Görsel üretimi başarısız: {e}") from e

    # 4) Maliyet tahmini
    maliyet_json = {"kalemler": [], "toplam_min": 0, "toplam_max": 0, "not": ""}
    try:
        maliyet_prompt = (
            "Aşağıdaki bilgilere göre bu odanın yeniden dekorasyonu için Türkiye piyasasına göre "
            "TAHMİNİ maliyet aralığı (TL) ver. Kalem bazlı (örn. boya, döşeme/zemin, mobilya, "
            "aydıntma, aksesuar, işçilik) min-max TL ve toplam min-max TL hesapla. "
            "SADECE şu JSON formatında cevap ver, başka metin yazma: "
            '{"kalemler":[{"ad":"...","min":0,"max":0,"birim":"adet/m2/toplam","aciklama":"..."}],'
            '"toplam_min":0,"toplam_max":0,"not":"..."}\n\n'
            f"Oda: {oda['isim']}. Ölçüler: {olcu_metni or 'belirtilmemiş'}. "
            f"Tasarım açıklaması: {prompt}"
            + (
                " NOT: Maske ile korunan mevcut mobilya/eşyalar değiştirilmiyor, "
                "bu kalemleri maliyete dahil ETME."
                if maske_bytes else ""
            )
            + (
                " NOT: Kullanıcının kendi ürün görseliyle eklediği ürünler "
                "(kendisinde olan veya satın almayı planladığı) maliyete dahil ETME, "
                "sadece genel dekorasyon/yapı kalemlerini hesapla."
                if urunler else ""
            )
        )
        resp = client.chat.completions.create(
            model=os.getenv("OPENAI_EV_TASARIM_TEXT_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": maliyet_prompt}],
            max_tokens=900,
            response_format={"type": "json_object"},
        )
        maliyet_json = json.loads(resp.choices[0].message.content or "{}")
    except Exception as e:
        maliyet_json = {"kalemler": [], "toplam_min": 0, "toplam_max": 0, "not": f"Maliyet tahmini alınamadı: {e}"}

    # 5) Kaydet
    with db() as (conn, cur):
        cur.execute("""
            INSERT INTO ev_tasarim_gorsel (oda_id, tip, veri, mime, prompt)
            VALUES (%s, 'uretilen', %s, 'image/png', %s)
            RETURNING id
        """, (oda_id, psycopg2.Binary(uretilen_bytes), prompt))
        new_gorsel_id = cur.fetchone()["id"]

        cur.execute("""
            INSERT INTO ev_tasarim_maliyet (oda_id, gorsel_id, icerik)
            VALUES (%s, %s, %s)
            RETURNING id
        """, (oda_id, new_gorsel_id, psycopg2.extras.Json(maliyet_json)))
        maliyet_id = cur.fetchone()["id"]

    return {
        "success": True,
        "gorsel_id": str(new_gorsel_id),
        "maliyet_id": str(maliyet_id),
        "maliyet": maliyet_json,
    }
