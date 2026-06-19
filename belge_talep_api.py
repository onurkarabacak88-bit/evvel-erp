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
from typing import Optional

from fastapi import APIRouter, HTTPException
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
