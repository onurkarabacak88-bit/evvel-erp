"""
Tedarikçi Fatura Okuma Modülü — İZOLE.

Tasarım ilkesi (bkz. memory project_fatura_okuma_modulu + feedback_cozum_felsefesi
"Öneri-Only / Proposed State"):
  - Bu modül sistemin GERÇEKLERİNİ (stok maliyeti, ürün fiyatı) ASLA doğrudan
    değiştirmez. Yalnızca KENDİ tablolarına yazar (öneri/ham veri).
  - FAIL CLOSED + ASENKRON: şube OCR beklemez. Foto yüklenince kabul anında biter;
    OCR arka planda çalışır, sonuç inceleme ekranına düşer. OCR çökse manuel devam.
  - Kill switch: FATURA_MODUL env=0 → tamamen kapanır (kritik akış etkilenmez).
  - Kritik tablolara SERT FK yok; sadece yumuşak id referansı (sube_id, siparis_talep_id).

Faz 1 (bu dosya): foto upload → asenkron vision OCR → ham JSON + kalemler. Öneri-only.
Faz 2+: ürün eşleştirme hafızası, üç-yönlü uzlaşma, fiyat onayı (Price Approval Service).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fatura", tags=["fatura-okuma"])


def fatura_modul_aktif() -> bool:
    """Kill switch — FATURA_MODUL=0 ise modül pasif (kritik akış etkilenmez)."""
    return os.getenv("FATURA_MODUL", "1").strip() not in ("0", "false", "False", "")


_TABLOLAR_HAZIR = False


def _ensure_tablolar(cur) -> None:
    """Modülün KENDİ tabloları (izole). İlk kullanımda lazy oluşturulur."""
    global _TABLOLAR_HAZIR
    if _TABLOLAR_HAZIR:
        return
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura (
            id                  TEXT PRIMARY KEY,
            sube_id             TEXT,
            siparis_talep_id    TEXT,
            tedarikci_ad        TEXT,
            fatura_tarih        DATE,
            toplam_tutar        DOUBLE PRECISION,
            foto                BYTEA,
            foto_mime           TEXT,
            durum               TEXT NOT NULL DEFAULT 'ocr_bekliyor',
            ocr_json            JSONB,
            ocr_hata            TEXT,
            yukleyen_personel_id TEXT,
            olusturma           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            inceleme_ts         TIMESTAMPTZ,
            inceleyen           TEXT
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tf_sube_durum ON tedarikci_fatura (sube_id, durum, olusturma DESC)")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_fatura_kalem (
            id              TEXT PRIMARY KEY,
            fatura_id       TEXT NOT NULL,
            sira            INT,
            ocr_ad          TEXT,
            adet            DOUBLE PRECISION,
            birim           TEXT,
            birim_fiyat     DOUBLE PRECISION,
            satir_toplam    DOUBLE PRECISION,
            eslesen_stok_kodu TEXT,   -- ÖNERİ (nullable), eşleştirme Faz 2
            eslesme_guven   DOUBLE PRECISION,
            olusturma       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tfk_fatura ON tedarikci_fatura_kalem (fatura_id)")
    # Fiyat geçmişi — GERÇEK fiyat değil; modülün kendi takip kaydı. Kritik maliyete
    # ancak ayrı Price Approval Service + insan onayı ile bağlanır (Faz 3).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tedarikci_urun_fiyat_gecmis (
            id              TEXT PRIMARY KEY,
            tedarikci_ad    TEXT,
            stok_kodu       TEXT,
            urun_ad         TEXT,
            birim_fiyat     DOUBLE PRECISION,
            fatura_id       TEXT,
            onaylayan       TEXT,
            gecerlilik_ts   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tufg_ted_stok ON tedarikci_urun_fiyat_gecmis (tedarikci_ad, stok_kodu, gecerlilik_ts DESC)")
    _TABLOLAR_HAZIR = True


# ── OCR (asenkron, arka plan) ────────────────────────────────────────────────

_OCR_PROMPT = (
    "Bu bir tedarikçi/toptancı FATURASI veya irsaliyesi fotoğrafı. Türkçe. "
    "İçindeki bilgileri SADECE şu JSON formatında çıkar, başka metin yazma:\n"
    '{"tedarikci": "<firma adı>", "fatura_tarih": "YYYY-MM-DD veya null", '
    '"toplam_tutar": <sayı veya null>, "kalemler": [{"ad": "<ürün adı>", '
    '"adet": <sayı>, "birim": "<adet/kg/lt/koli vb>", "birim_fiyat": <sayı>, '
    '"satir_toplam": <sayı>}]}\n'
    "Sayıları nokta ondalıkla ver (30.50). Okuyamadığın alanı null bırak. "
    "Emin olmadığın kalemi yine de ekle ama değerini null yap."
)


def _vision_ocr(foto: bytes, mime: str) -> Dict[str, Any]:
    """Vision model ile faturadan yapılandırılmış JSON çıkarır. Hata → exception."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY yok")
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    b64 = base64.b64encode(foto).decode("ascii")
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_FATURA_MODEL", "gpt-4o-mini"),
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": _OCR_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
        max_tokens=1500,
    )
    metin = (resp.choices[0].message.content or "").strip()
    # JSON gövdeyi ayıkla (model bazen ```json ... ``` sarar)
    if "```" in metin:
        metin = metin.split("```")[1]
        if metin.startswith("json"):
            metin = metin[4:]
    metin = metin.strip()
    j = json.loads(metin)
    return j if isinstance(j, dict) else {}


def _ocr_calistir(fatura_id: str) -> None:
    """Arka plan iş parçacığı — kendi DB bağlantısı. Hiçbir hata fırlatmaz."""
    try:
        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute("SELECT foto, foto_mime FROM tedarikci_fatura WHERE id=%s", (fatura_id,))
            r = cur.fetchone()
            if not r:
                return
            foto = bytes(dict(r).get("foto") or b"")
            mime = dict(r).get("foto_mime") or "image/jpeg"
        if not foto:
            raise RuntimeError("foto boş")

        j = _vision_ocr(foto, mime)
        kalemler = j.get("kalemler") if isinstance(j.get("kalemler"), list) else []

        with db() as (conn, cur):
            _ensure_tablolar(cur)
            cur.execute(
                """
                UPDATE tedarikci_fatura
                SET tedarikci_ad=%s, fatura_tarih=%s, toplam_tutar=%s,
                    ocr_json=%s::jsonb, durum='ocr_tamam', ocr_hata=NULL
                WHERE id=%s
                """,
                (
                    (str(j.get("tedarikci") or "").strip() or None),
                    (str(j.get("fatura_tarih")) if j.get("fatura_tarih") else None),
                    _sayi(j.get("toplam_tutar")),
                    json.dumps(j, ensure_ascii=False),
                    fatura_id,
                ),
            )
            for i, k in enumerate(kalemler):
                if not isinstance(k, dict):
                    continue
                cur.execute(
                    """
                    INSERT INTO tedarikci_fatura_kalem
                        (id, fatura_id, sira, ocr_ad, adet, birim, birim_fiyat, satir_toplam)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(uuid.uuid4()), fatura_id, i,
                        (str(k.get("ad") or "").strip() or None),
                        _sayi(k.get("adet")), (str(k.get("birim") or "").strip() or None),
                        _sayi(k.get("birim_fiyat")), _sayi(k.get("satir_toplam")),
                    ),
                )
            conn.commit()
        logger.info("fatura OCR tamam: %s (%d kalem)", fatura_id, len(kalemler))
    except Exception as e:
        logger.warning("fatura OCR hata %s: %s", fatura_id, e)
        try:
            with db() as (conn, cur):
                cur.execute(
                    "UPDATE tedarikci_fatura SET durum='ocr_hata', ocr_hata=%s WHERE id=%s",
                    (str(e)[:500], fatura_id),
                )
                conn.commit()
        except Exception:
            pass


def _sayi(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


# ── Endpoint'ler ─────────────────────────────────────────────────────────────

@router.post("/yukle")
async def fatura_yukle(
    foto: UploadFile = File(...),
    sube_id: str = Form(...),
    siparis_talep_id: Optional[str] = Form(None),
    personel_id: Optional[str] = Form(None),
):
    """Fatura fotoğrafı yükle. ANINDA döner (durum=ocr_bekliyor); OCR arka planda.
    Şube bu çağrıyı beklemez — kabul akışı kesintisiz devam eder."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")
    raw = await foto.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")
    mime = foto.content_type or "image/jpeg"
    fid = str(uuid.uuid4())
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            INSERT INTO tedarikci_fatura
                (id, sube_id, siparis_talep_id, foto, foto_mime, durum, yukleyen_personel_id)
            VALUES (%s, %s, %s, %s, %s, 'ocr_bekliyor', %s)
            """,
            (fid, sube_id.strip(), (siparis_talep_id or None), raw, mime, (personel_id or None)),
        )
        conn.commit()
    # Asenkron OCR — şubeyi bekletmeden
    threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()
    return {"fatura_id": fid, "durum": "ocr_bekliyor"}


@router.get("/bekleyen")
def fatura_bekleyen(sube_id: Optional[str] = None, limit: int = 50):
    """İncelenmeyi bekleyen faturalar (OCR tamam ama insan onayı yok)."""
    if not fatura_modul_aktif():
        return {"satirlar": []}
    lim = max(1, min(200, int(limit or 50)))
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        kosul = "durum IN ('ocr_tamam','ocr_hata','ocr_bekliyor')"
        params: List[Any] = []
        if sube_id:
            kosul += " AND sube_id=%s"
            params.append(sube_id.strip())
        cur.execute(
            f"""
            SELECT id, sube_id, tedarikci_ad, fatura_tarih, toplam_tutar, durum,
                   ocr_hata, olusturma
            FROM tedarikci_fatura
            WHERE {kosul}
            ORDER BY olusturma DESC
            LIMIT %s
            """,
            tuple(params + [lim]),
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    for r in rows:
        r["fatura_tarih"] = str(r.get("fatura_tarih") or "")
        r["olusturma"] = str(r.get("olusturma") or "")
    return {"satirlar": rows, "toplam": len(rows)}


@router.get("/{fatura_id}")
def fatura_detay(fatura_id: str):
    """Tek fatura: başlık + OCR kalemleri (öneri-only)."""
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı.")
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, sube_id, siparis_talep_id, tedarikci_ad, fatura_tarih,
                   toplam_tutar, durum, ocr_hata, olusturma
            FROM tedarikci_fatura WHERE id=%s
            """,
            (fatura_id,),
        )
        h = cur.fetchone()
        if not h:
            raise HTTPException(404, "Fatura bulunamadı")
        h = dict(h)
        cur.execute(
            """
            SELECT id, sira, ocr_ad, adet, birim, birim_fiyat, satir_toplam,
                   eslesen_stok_kodu, eslesme_guven
            FROM tedarikci_fatura_kalem WHERE fatura_id=%s ORDER BY sira
            """,
            (fatura_id,),
        )
        kalemler = [dict(r) for r in (cur.fetchall() or [])]
    h["fatura_tarih"] = str(h.get("fatura_tarih") or "")
    h["olusturma"] = str(h.get("olusturma") or "")
    return {"fatura": h, "kalemler": kalemler}
