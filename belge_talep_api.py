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
    # AÇIK TESLİMAT DUYUSU (2026-07-06, tasarım: project_tedarik_belge_denetim_duyulari):
    # her teslimat OPEN doğar, ÜÇ kanıtla kapanır — fatura / irsaliye / manuel açıklama.
    # Önemli olan belge TÜRÜ değil, teslimatın sonsuza dek açık kalmaması. Kapanış kanıtı iz bırakır.
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS kapanis_tipi TEXT")
    cur.execute("ALTER TABLE belge_talep ADD COLUMN IF NOT EXISTS kapanis_aciklama TEXT")


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


def _tedarikci_ritim_map(cur) -> dict:
    """Tedarikçi belge ritmi: kapanmış taleplerin teslim→kapanış MEDYAN süresi (gün).
    Bağlam sinyalidir — önceliği ayarlar, HİÇBİR ŞEYİ susturmaz (tasarım kuralı #3)."""
    cur.execute(
        """
        SELECT COALESCE(tedarikci_id, tedarikci_ad) AS tkey,
               MAX(tedarikci_ad) AS tedarikci_ad,
               COUNT(*)::int AS kapanan_adet,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
                   GREATEST(0, EXTRACT(EPOCH FROM (kapanma_ts - olusturma)) / 86400.0)
               ) AS medyan_gun
        FROM belge_talep
        WHERE durum <> 'bekliyor' AND kapanma_ts IS NOT NULL
        GROUP BY COALESCE(tedarikci_id, tedarikci_ad)
        """
    )
    return {str(r["tkey"]): {"medyan_gun": round(float(r["medyan_gun"] or 0), 1),
                             "kapanan_adet": int(r["kapanan_adet"])}
            for r in (cur.fetchall() or [])}


def _oncelik(yas_gun: float, rt: Optional[dict]) -> str:
    """Öncelik = bağlam, alarm DEĞİL. Ritmi bilinen tedarikçide yaş/ritim oranı; ritimsizde ham yaş."""
    if rt and rt.get("medyan_gun", 0) > 0:
        m = rt["medyan_gun"]
        return "yuksek" if yas_gun > m * 2 else ("orta" if yas_gun > m else "dusuk")
    return "yuksek" if yas_gun >= 15 else ("orta" if yas_gun >= 7 else "dusuk")


@router.get("/bekleyen")
def belge_talep_bekleyen():
    """Cep: fatura bekleyen teslimatlar (durum='bekliyor'), yaş + mesaj sayısı +
    AÇIK TESLİMAT bağlamı (tedarikçi ritmi + öncelik — alarm değil, görünürlük)."""
    with db() as (_, cur):
        _ensure(cur)
        ritim = _tedarikci_ritim_map(cur)
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
            _tkey = str(d.get("tedarikci_id") or d.get("tedarikci_ad") or "")
            _rt = ritim.get(_tkey)
            d["ritim_medyan_gun"] = _rt["medyan_gun"] if _rt else None
            d["oncelik"] = _oncelik(d["yas_saat"] / 24.0, _rt)
            rows.append(d)
    return {"toplam": len(rows), "talepler": rows}


@router.get("/acik-teslimat")
def acik_teslimat_ozet():
    """AÇIK TESLİMAT DUYUSU — salt-okur, ALARMSIZ (consistency engine, truth engine değil).

    'Neden hâlâ açık?' ekranı: kapanmamış teslimat yaşlanması + tedarikçi belge ritmi bağlamı.
    Ritim SADECE önceliği ayarlar, hiçbir şeyi susturmaz (tasarım kuralı #3): ay-sonu kesen
    tedarikçinin 20 günlük açığı DÜŞÜK öncelik ama LİSTEDE KALIR. Üç-evren değerlendirmesi
    (tedarikçi kesmedi / personel yüklemedi / kayıt-dışı) İNSANA bırakılır — veri birikmeden
    çıkarım kodlanmaz. Ek blok: İÇ SEVKİYAT yolda yaşlanması (merkez→şube, ayrı evren — S4
    görünürlüğü: sevk edildi ama şube kabul etmedi kayıtları sonsuza dek 'yolda' kalmasın)."""
    with db() as (_, cur):
        _ensure(cur)
        # 1) Açık teslimatlar (yaş gün + tedarikçi kırılımı)
        cur.execute(
            """
            SELECT id, ts_id, sube_adi, tedarikci_id, tedarikci_ad, tedarikci_tel,
                   teslim_tarihi::text AS teslim_tarihi, mesaj_sayisi,
                   GREATEST(0, (CURRENT_DATE - COALESCE(teslim_tarihi, olusturma::date)))::int AS yas_gun
            FROM belge_talep
            WHERE durum = 'bekliyor'
            ORDER BY yas_gun DESC, olusturma ASC
            """
        )
        acik = [dict(r) for r in (cur.fetchall() or [])]

        # 2) Tedarikçi belge ritmi — 'bu tedarikçi genelde X günde kapatır' bağlamı (tek merkez)
        ritim = _tedarikci_ritim_map(cur)

        kovalar = {"0_3": 0, "4_7": 0, "8_14": 0, "15_plus": 0}
        for a in acik:
            g = int(a["yas_gun"])
            tkey = str(a.get("tedarikci_id") or a.get("tedarikci_ad") or "")
            rt = ritim.get(tkey)
            a["ritim_medyan_gun"] = rt["medyan_gun"] if rt else None
            a["ritim_kapanan_adet"] = rt["kapanan_adet"] if rt else 0
            a["oncelik"] = _oncelik(g, rt)
            if g <= 3:
                kovalar["0_3"] += 1
            elif g <= 7:
                kovalar["4_7"] += 1
            elif g <= 14:
                kovalar["8_14"] += 1
            else:
                kovalar["15_plus"] += 1

        # 3) İÇ SEVKİYAT — merkez→şube 'yolda' yaşlanması (ayrı evren, hata-yutar salt-okur)
        ic_sevkiyat = []
        try:
            cur.execute(
                """
                SELECT sy.siparis_talep_id, sy.kalem_kodu, sy.kalem_adi, sy.sevk_adet,
                       COALESCE(s.ad, sy.sube_id::text) AS sube_ad,
                       GREATEST(0, (CURRENT_DATE - sy.sevk_ts::date))::int AS yas_gun
                FROM stok_yolda sy
                LEFT JOIN subeler s ON s.id::text = sy.sube_id::text
                WHERE sy.durum = 'yolda'
                ORDER BY yas_gun DESC
                LIMIT 50
                """
            )
            ic_sevkiyat = [dict(r) for r in (cur.fetchall() or [])]
        except Exception as e:  # noqa: BLE001 — şema farkıysa blok boş kalır, duyu çökmez
            logger.warning("acik-teslimat ic_sevkiyat blogu atlandi: %s", str(e)[:120])

    return {
        "acik_toplam": len(acik),
        "yas_kovalari": kovalar,
        "acik_teslimatlar": acik,
        "tedarikci_ritim": ritim,
        "ic_sevkiyat_yolda": ic_sevkiyat,
        "ic_sevkiyat_yolda_adet": len(ic_sevkiyat),
        "not": "Salt-okur duyu — alarm üretmez. Öncelik yalnız bağlamdır (yaş vs tedarikçi ritmi); "
               "hiçbir kayıt susturulmaz. Kapanış: fatura / irsaliye / manuel açıklama.",
    }


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
    durum: str = "pdf_geldi"          # pdf_geldi | kapandi (geriye uyum)
    kapanis_tipi: Optional[str] = None    # fatura | irsaliye | manuel
    aciklama: Optional[str] = None        # manuel kapanışta ZORUNLU (kapanış kanıtı)


@router.post("/{talep_id}/kapat")
def belge_talep_kapat(talep_id: str, body: KapatBody = None):
    """AÇIK TESLİMAT kapanışı — üç kanıttan biriyle: fatura / irsaliye / manuel açıklama.
    Manuel kapanışta açıklama ZORUNLU: teslimat sessizce kapanamaz, 'neden kapandı' iz bırakır
    (tasarım: sistem 'neden hâlâ açık?' sorar, 'neden suçlusun?' değil — ama kapanış kanıtsız olmaz).
    Geriye uyum: eski istemciler yalnız durum yollar → kapanis_tipi='manuel' sayılır ama
    açıklamasızsa genel not düşülür (eski davranış kırılmaz)."""
    tid = (talep_id or "").strip()
    durum = (getattr(body, "durum", None) or "pdf_geldi").strip().lower()
    if durum not in ("pdf_geldi", "kapandi"):
        durum = "pdf_geldi"
    tip = (getattr(body, "kapanis_tipi", None) or "").strip().lower()
    if tip and tip not in ("fatura", "irsaliye", "manuel"):
        raise HTTPException(400, "kapanis_tipi: fatura | irsaliye | manuel")
    acik = (getattr(body, "aciklama", None) or "").strip()
    if tip == "manuel" and not acik:
        raise HTTPException(400, "Manuel kapanışta açıklama zorunlu — teslimat kanıtsız kapanamaz "
                                 "(örn. 'irsaliye elden alındı', 'ay sonu faturasına dahil').")
    if not tip:
        # Geriye uyum: tip belirtilmemişse pdf_geldi=fatura, kapandi=manuel say
        tip = "fatura" if durum == "pdf_geldi" else "manuel"
        if tip == "manuel" and not acik:
            acik = "(eski istemci — açıklamasız manuel kapanış)"
    with db() as (_, cur):
        _ensure(cur)
        cur.execute(
            """UPDATE belge_talep
               SET durum=%s, kapanma_ts=NOW(), kapanis_tipi=%s,
                   kapanis_aciklama=COALESCE(NULLIF(%s,''), kapanis_aciklama)
               WHERE id=%s AND durum='bekliyor'""",
            (durum, tip, acik, tid),
        )
    return {"ok": True, "durum": durum, "kapanis_tipi": tip}


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

        # 'fatura geldi' sinyali — belge talebini kapat + damga (kapanış kanıtı = fatura)
        cur.execute(
            """UPDATE belge_talep
               SET durum='pdf_geldi', kapanma_ts=NOW(), fatura_id=%s, kapanis_tipi='fatura'
               WHERE id=%s""",
            (fatura_idler[0] if fatura_idler else None, tid),
        )
        conn.commit()

    # Asenkron OCR — yüklemeyi bekletmeden
    for fid in ocr_calisacak:
        threading.Thread(target=_ocr_calistir, args=(fid,), daemon=True).start()

    return {"ok": True, "durum": "pdf_geldi", "fatura_idler": fatura_idler, "ocr": len(ocr_calisacak)}
