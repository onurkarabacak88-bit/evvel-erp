"""
Belge Talep Motoru — İZOLE.

Amaç: Şube bir toptancı siparişini "Ürün Teslim Al" ile kabul edince, o teslimata
ait FATURANIN PDF'ini tedarikçiden KOVALAMAK. Fatura OKUMAZ (OCR ayrı) — belge talep
eder + takip eder.

Tasarım (bkz. memory feedback_duyu_izole_toplayici_kurali + project_tedarik_belge_denetim_duyulari):
  - Tetikleyici TEK: şube teslim-al → belge_talep kaydı (durum='bekliyor').
  - Yarı-otomatik wa.me: sistem mesajı HAZIRLAR; sahip cep'ten tek tık gönderir (ücretsiz, kotasız).
  - İZOLE: kendi tablosu; tetikleyici KENDİ transaction'ında, hata YUTAR → teslim-al'ı bozmaz.
  - Öneri-Only: stok/sipariş akışını ETKİLEMEZ; çökse sistem yaşar.
  - Şube paneli bunu GÖRMEZ — sadece cep (sahip).
  - Türev-hazır: teslim→pdf süresi ölçülür → ileride "tedarikçi belge ritmi" duyusu.

Kaldırmak: main.py'den router'ı çıkar + urun-sevk'teki tek tetik satırını sil. Tablo zararsız kalır.
"""
from __future__ import annotations

import logging
import threading
import uuid
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/belge-talep", tags=["belge-talep"])


def _ensure(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS belge_talep (
            id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            ts_id         TEXT,                -- toptanci_siparis id (tetik)
            talep_id      TEXT,                -- siparis_talep id
            sube_id       TEXT,
            sube_adi      TEXT,                -- snapshot
            tedarikci_id  TEXT,
            tedarikci_ad  TEXT,                -- snapshot
            tedarikci_tel TEXT,               -- snapshot (wa.me için)
            teslim_tarihi DATE,
            durum         TEXT NOT NULL DEFAULT 'bekliyor',  -- bekliyor | pdf_geldi | kapandi
            mesaj_sayisi  INT NOT NULL DEFAULT 0,
            son_mesaj_ts  TIMESTAMPTZ,
            kapanma_ts    TIMESTAMPTZ,
            olusturma     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (ts_id)                     -- teslimat başına tek talep (idempotent)
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_belge_talep_durum ON belge_talep (durum, olusturma DESC)")
    # Yüklenen faturanın izi (hangi tedarikci_fatura kaydı bu teslimatı kapattı)
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS fatura_id TEXT")


def belge_talep_olustur_izole(ts_id: str) -> None:
    """ŞUBE TESLİM ALINCA çağrılır (urun-sevk'ten). KENDİ transaction'ında çalışır;
    HER hata YUTULUR — teslim-al akışını ASLA bozmaz. İdempotent (ts_id unique)."""
    tsid = str(ts_id or "").strip()
    if not tsid:
        return
    try:
        with db() as (_, cur):
            _ensure(cur)
            cur.execute("SELECT 1 FROM belge_talep WHERE ts_id=%s", (tsid,))
            if cur.fetchone():
                return  # zaten var
            cur.execute(
                """
                SELECT ts.id, ts.talep_id, ts.sube_id, ts.tedarikci_id,
                       ts.tedarikci_ad, ts.tedarikci_tel, s.ad AS sube_adi
                FROM toptanci_siparis ts LEFT JOIN subeler s ON s.id = ts.sube_id
                WHERE ts.id=%s
                """,
                (tsid,),
            )
            r = cur.fetchone()
            if not r:
                return
            t = dict(r)
            # Telefonu olmayan tedarikçi için yine kayıt aç (cep'te "tel yok" gösterilir)
            cur.execute(
                """
                INSERT INTO belge_talep
                    (ts_id, talep_id, sube_id, sube_adi, tedarikci_id, tedarikci_ad,
                     tedarikci_tel, teslim_tarihi)
                VALUES (%s,%s,%s,%s,%s,%s,%s, CURRENT_DATE)
                ON CONFLICT (ts_id) DO NOTHING
                """,
                (tsid, t.get("talep_id"), t.get("sube_id"), t.get("sube_adi"),
                 t.get("tedarikci_id"), t.get("tedarikci_ad"), t.get("tedarikci_tel")),
            )
    except Exception as e:  # noqa: BLE001 — bilerek yutuluyor (teslim-al bozulmasın)
        logger.warning("belge_talep olusturulamadi (yutuldu, teslim-al etkilenmedi): %s", str(e)[:200])


@router.get("/bekleyen")
def belge_talep_bekleyen():
    """Cep: fatura bekleyen teslimatlar (durum='bekliyor'), yaş + mesaj sayısıyla."""
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """
            SELECT id, ts_id, sube_id, sube_adi, tedarikci_id, tedarikci_ad, tedarikci_tel,
                   teslim_tarihi, durum, mesaj_sayisi, son_mesaj_ts, olusturma,
                   ROUND(EXTRACT(EPOCH FROM (NOW() - olusturma)) / 3600.0, 1) AS yas_saat
            FROM belge_talep
            WHERE durum = 'bekliyor'
            ORDER BY olusturma ASC
            """
        )
        rows = []
        for r in (cur.fetchall() or []):
            d = dict(r)
            d["teslim_tarihi"] = str(d.get("teslim_tarihi") or "")
            d["olusturma"] = str(d.get("olusturma") or "")
            d["son_mesaj_ts"] = str(d.get("son_mesaj_ts") or "")
            d["yas_saat"] = float(d.get("yas_saat") or 0)
            rows.append(d)
    return {"toplam": len(rows), "talepler": rows}


@router.post("/{talep_id}/mesaj-gonderildi")
def belge_talep_mesaj_gonderildi(talep_id: str):
    """Sahip wa.me'den mesajı gönderince çağrılır → mesaj_sayisi++ (belge ritmi izi)."""
    tid = (talep_id or "").strip()
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            "UPDATE belge_talep SET mesaj_sayisi = mesaj_sayisi + 1, son_mesaj_ts = NOW() WHERE id=%s AND durum='bekliyor'",
            (tid,),
        )
    return {"ok": True}


class KapatBody(BaseModel):
    durum: str = "pdf_geldi"  # pdf_geldi | kapandi


@router.post("/{talep_id}/kapat")
def belge_talep_kapat(talep_id: str, body: KapatBody = None):
    """PDF geldi / manuel kapat → durum kapanır (kovalama biter, süre ölçüsü kaydolur)."""
    tid = (talep_id or "").strip()
    durum = (getattr(body, "durum", None) or "pdf_geldi").strip().lower()
    if durum not in ("pdf_geldi", "kapandi"):
        durum = "pdf_geldi"
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            "UPDATE belge_talep SET durum=%s, kapanma_ts=NOW() WHERE id=%s AND durum='bekliyor'",
            (durum, tid),
        )
    return {"ok": True, "durum": durum}


@router.post("/{talep_id}/fatura-yukle")
async def belge_talep_fatura_yukle(talep_id: str, dosya: UploadFile = File(...)):
    """Toptancı WhatsApp'tan faturayı yolladı → sahip cep'ten yükler. Dosya mevcut FATURA
    boru hattına aktarılır (OCR/maliyet ayrı modül), bu teslimata DAMGALANIR (siparis_talep_id
    + belge_talep.fatura_id) ve 'fatura geldi' sinyali yakalanır → belge talebi kapanır.
    Fatura çekirdeği DEĞİŞMEZ; bağ tek yönlü (belge_talep tüketici)."""
    tid = (talep_id or "").strip()
    raw = await dosya.read()
    if not raw:
        raise HTTPException(400, "Boş dosya")

    with db() as (_, cur):
        _ensure(cur)
        cur.execute("SELECT sube_id, talep_id FROM belge_talep WHERE id=%s", (tid,))
        bt = cur.fetchone()
    if not bt:
        raise HTTPException(404, "Belge talep bulunamadı")
    bt = dict(bt)
    sube_id = bt.get("sube_id")
    siparis_talep_id = bt.get("talep_id")

    # Fatura modülü yardımcıları — izole import (modül kapalıysa yükleme reddedilir)
    try:
        from fatura_api import (
            _ensure_tablolar, _ocr_calistir, _pdf_faturalara_bol, fatura_modul_aktif,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Fatura modülü yüklenemedi: {str(e)[:120]}")
    if not fatura_modul_aktif():
        raise HTTPException(503, "Fatura modülü kapalı (FATURA_MODUL=0).")

    ad = (dosya.filename or "").lower()
    is_pdf = ad.endswith(".pdf") or (dosya.content_type or "").lower() == "application/pdf"
    fatura_idler: list[str] = []
    ocr_calisacak: list[str] = []

    with db() as (conn, cur):
        _ensure_tablolar(cur)
        if is_pdf:
            try:
                faturalar = _pdf_faturalara_bol(raw)
            except Exception:
                faturalar = []
            if faturalar:
                for f in faturalar:
                    fno = (f.get("fatura_no") or "").strip() or None
                    metin = (f.get("metin") or "").strip()
                    if not metin:
                        continue
                    if fno:
                        cur.execute("SELECT 1 FROM tedarikci_fatura WHERE fatura_no=%s LIMIT 1", (fno,))
                        if cur.fetchone():
                            continue
                    fid = str(uuid.uuid4())
                    cur.execute(
                        """
                        INSERT INTO tedarikci_fatura
                            (id, sube_id, siparis_talep_id, fatura_no, fatura_tarih, onceki_bakiye,
                             bakiye_dahil, kaynak_metin, kaynak_tip, durum)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'pdf','ocr_bekliyor')
                        """,
                        (fid, sube_id, siparis_talep_id, fno, f.get("fatura_tarih"),
                         f.get("onceki_bakiye"), f.get("bakiye_dahil"), metin),
                    )
                    fatura_idler.append(fid)
                    ocr_calisacak.append(fid)
            if not fatura_idler:
                # Bölünemeyen PDF → ham dosyayı sakla + bağla (manuel işlenebilir kalır)
                fid = str(uuid.uuid4())
                cur.execute(
                    """
                    INSERT INTO tedarikci_fatura
                        (id, sube_id, siparis_talep_id, foto, foto_mime, kaynak_tip, durum)
                    VALUES (%s,%s,%s,%s,'application/pdf','pdf','ocr_bekliyor')
                    """,
                    (fid, sube_id, siparis_talep_id, raw),
                )
                fatura_idler.append(fid)
        else:
            # Görüntü (toptancı foto olarak yolladıysa) → şube foto akışıyla aynı
            mime = dosya.content_type or "image/jpeg"
            fid = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO tedarikci_fatura
                    (id, sube_id, siparis_talep_id, foto, foto_mime, durum)
                VALUES (%s,%s,%s,%s,%s,'ocr_bekliyor')
                """,
                (fid, sube_id, siparis_talep_id, raw, mime),
            )
            fatura_idler.append(fid)
            ocr_calisacak.append(fid)

        # 'fatura geldi' sinyali — belge talebini kapat + damga
        cur.execute(
            "UPDATE belge_talep SET durum='pdf_geldi', kapanma_ts=NOW(), fatura_id=%s WHERE id=%s",
            (fatura_idler[0] if fatura_idler else None, tid),
        )
        conn.commit()

    # Asenkron OCR — yüklemeyi bekletmeden
    for fid in ocr_calisacak:
        threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()

    return {"ok": True, "durum": "pdf_geldi", "fatura_idler": fatura_idler, "ocr": len(ocr_calisacak)}
