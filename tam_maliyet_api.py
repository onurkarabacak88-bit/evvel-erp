"""
TAM MALİYET — İZOLE modül (genel merkez gideri + tahakkuk + şube dağıtımı).

AMAÇ (kullanıcı + GPT denetimi 2026-06-23): Operasyonel P&L'nin GÖREMEDİĞİ
maliyetleri OTOMATİK + insan-hatasına-kapalı şekilde şubelere yükle:
  - Genel merkez giderleri (muhasebeci, reklam/Meta, genel müdür, ERP...) →
    şubelerde HİÇ görünmüyordu → bazı şubeler olduğundan kârlı görünüyor.
  - Değişken gider tahakkuku: fatura gelene kadar 0 değil, TAHMİNİ ile hesaplanır
    (fatura gelince gerçeğiyle düzeltilir) → "accrued expense".
  - Gerçek gün sayısı: aylık ÷ 30 SABİT yerine ayın GERÇEK gün sayısı (Şubat 28,
    31'lik ay 31) → %5-10 sapma kapanır.

İZOLASYON (mutlak — çalışan P&L bozulmasın, veri zarar görmesin):
  - Kendi tablosuna yazar: `merkez_gider` (+ ileride finansman/amortisman).
  - Kritik tablolardan SADECE OKUR: `ciro` (şube dağıtım ağırlığı), `subeler`.
    Hiçbirini DEĞİŞTİRMEZ (tek-yön).
  - Tüm uçlar/yazımlar hata-yutar; ana akışı ASLA bozmaz.
  - main.py'ye try/except ile takılır; modül patlasa app ayakta kalır.
  - P&L'ye BAĞLAMA ayrı/sonraki faz: bu modül salt-okur hesap döndürür, Maliyet
    ekranı onu okur (operasyonel kâr DEĞİŞMEZ → "Tam Net Kâr" AYRI katman).

ÇİFT SAYIM KİLİDİ: Buraya SADECE operasyonel P&L'de OLMAYAN giderler girilir
  (genel merkez / finansman / amortisman). Şube kira/personel/fatura zaten
  gun-gun'da var → buraya GİRİLMEZ (kategori listesi bunu yönlendirir).
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from calendar import monthrange
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tam-maliyet", tags=["tam-maliyet"])

# Genel merkez gider kategorileri (kategori ESAS — metin eşleşme değil; audit Karar B).
# Şube-operasyonel kalemler (kira/personel/fatura) BİLEREK YOK → çift sayım kilidi.
MERKEZ_KATEGORILER = [
    "Muhasebe / Mali Müşavir",
    "Reklam / Pazarlama (Meta, Google...)",
    "Genel Yönetim (maaş, ofis)",
    "Yazılım / ERP / Abonelik (merkez)",
    "Danışmanlık / Hukuk",
    "Bakım / Onarım (merkez)",
    "Diğer Merkez Gideri",
]

_TABLO_HAZIR = False


def _ensure_tablolar(cur) -> None:
    """İzole tablo — ilk kullanımda lazy. Hata-yutar (ana akışı bozmaz)."""
    global _TABLO_HAZIR
    if _TABLO_HAZIR:
        return
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS merkez_gider (
            id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
            ad              TEXT NOT NULL,
            kategori        TEXT NOT NULL DEFAULT 'Diğer Merkez Gideri',
            tip             TEXT NOT NULL DEFAULT 'sabit',   -- 'sabit' | 'degisken'
            aylik_tutar     NUMERIC(14,2) NOT NULL DEFAULT 0, -- sabit=kesin / degisken=tahmini
            -- Değişken giderde fatura gelince GERÇEK tutar (NULL ise tahmini=aylik_tutar kullanılır)
            gercek_tutar    NUMERIC(14,2),
            gercek_ay       TEXT,                             -- 'YYYY-MM' gerçek hangi aya ait
            dagitim         TEXT NOT NULL DEFAULT 'ciro',     -- 'ciro' | 'esit' (otomatik) | 'manuel'
            baslangic       DATE,
            bitis           DATE,
            aktif           BOOLEAN NOT NULL DEFAULT TRUE,
            notlar          TEXT,
            olusturma       TIMESTAMP NOT NULL DEFAULT NOW(),
            guncelleme      TIMESTAMP NOT NULL DEFAULT NOW()
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_merkez_gider_aktif ON merkez_gider (aktif)")
    # Manuel dağıtım ağırlıkları (opsiyonel; dagitim='manuel' kalemler için)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS merkez_gider_agirlik (
            gider_id   TEXT NOT NULL,
            sube_id    TEXT NOT NULL,
            agirlik    NUMERIC(8,4) NOT NULL DEFAULT 0,
            PRIMARY KEY (gider_id, sube_id)
        )
        """
    )
    _TABLO_HAZIR = True


def _gun_tahakkuk(aylik_tutar: float, bas: date, bit: date) -> float:
    """Aylık tutarı, aralıktaki her güne O AYIN GERÇEK gün sayısıyla böler (accrual).
    30 sabiti YERİNE ayın gerçek günü → Şubat/31'lik ay sapması kapanır (audit Karar C)."""
    if aylik_tutar <= 0 or bit < bas:
        return 0.0
    toplam = 0.0
    g = bas
    while g <= bit:
        ay_gun = monthrange(g.year, g.month)[1]  # o ayın gerçek gün sayısı
        toplam += aylik_tutar / ay_gun
        g += timedelta(days=1)
    return round(toplam, 2)


def _aktif_mi(r: Dict[str, Any], bas: date, bit: date) -> bool:
    """Gider dönemde aktif mi (baslangic/bitis penceresi)."""
    if not r.get("aktif"):
        return False
    b = r.get("baslangic")
    e = r.get("bitis")
    if b and isinstance(b, date) and b > bit:
        return False
    if e and isinstance(e, date) and e < bas:
        return False
    return True


# ── Modeller ──────────────────────────────────────────────────────────────
class MerkezGiderIn(BaseModel):
    ad: str
    kategori: Optional[str] = "Diğer Merkez Gideri"
    tip: Optional[str] = "sabit"
    aylik_tutar: float
    dagitim: Optional[str] = "ciro"
    baslangic: Optional[str] = None
    bitis: Optional[str] = None
    notlar: Optional[str] = None


class GercekTutarIn(BaseModel):
    gercek_tutar: float
    gercek_ay: Optional[str] = None


# ── Uçlar ─────────────────────────────────────────────────────────────────
@router.get("/kategoriler")
def kategoriler():
    return {"kategoriler": MERKEZ_KATEGORILER}


@router.get("/merkez-gider")
def merkez_gider_liste():
    """Tüm merkez giderleri (aktif + pasif)."""
    with db() as (_, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            SELECT id, ad, kategori, tip, aylik_tutar::float AS aylik_tutar,
                   gercek_tutar::float AS gercek_tutar, gercek_ay, dagitim,
                   baslangic::text AS baslangic, bitis::text AS bitis, aktif, notlar
            FROM merkez_gider ORDER BY aktif DESC, kategori, ad
            """
        )
        rows = [dict(r) for r in (cur.fetchall() or [])]
    # Değişken giderde fatura gelmemişse tahmini kullanıldığını göster
    for r in rows:
        r["etkin_tutar"] = float(r.get("gercek_tutar") or 0) if r.get("gercek_tutar") is not None else float(r.get("aylik_tutar") or 0)
        r["tahmini_mi"] = r.get("tip") == "degisken" and r.get("gercek_tutar") is None
    return {"satirlar": rows}


@router.post("/merkez-gider")
def merkez_gider_ekle(body: MerkezGiderIn):
    ad = (body.ad or "").strip()
    if not ad:
        raise HTTPException(400, "Gider adı zorunlu")
    if not (body.aylik_tutar is not None and float(body.aylik_tutar) > 0):
        raise HTTPException(400, "Aylık tutar 0'dan büyük olmalı (değişken gider için TAHMİNİ gir — 0 bırakma)")
    tip = body.tip if body.tip in ("sabit", "degisken") else "sabit"
    dag = body.dagitim if body.dagitim in ("ciro", "esit", "manuel") else "ciro"
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        gid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO merkez_gider (id, ad, kategori, tip, aylik_tutar, dagitim, baslangic, bitis, notlar)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (gid, ad, (body.kategori or "Diğer Merkez Gideri"), tip, round(float(body.aylik_tutar), 2),
             dag, (body.baslangic or None), (body.bitis or None), (body.notlar or None)),
        )
        conn.commit()
    return {"success": True, "id": gid}


@router.put("/merkez-gider/{gider_id}")
def merkez_gider_guncelle(gider_id: str, body: MerkezGiderIn):
    ad = (body.ad or "").strip()
    if not ad:
        raise HTTPException(400, "Gider adı zorunlu")
    tip = body.tip if body.tip in ("sabit", "degisken") else "sabit"
    dag = body.dagitim if body.dagitim in ("ciro", "esit", "manuel") else "ciro"
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            """
            UPDATE merkez_gider
            SET ad=%s, kategori=%s, tip=%s, aylik_tutar=%s, dagitim=%s,
                baslangic=%s, bitis=%s, notlar=%s, guncelleme=NOW()
            WHERE id=%s
            """,
            (ad, (body.kategori or "Diğer Merkez Gideri"), tip, round(float(body.aylik_tutar or 0), 2),
             dag, (body.baslangic or None), (body.bitis or None), (body.notlar or None), gider_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Gider bulunamadı")
        conn.commit()
    return {"success": True}


@router.post("/merkez-gider/{gider_id}/gercek-tutar")
def merkez_gider_gercek(gider_id: str, body: GercekTutarIn):
    """Değişken giderde fatura gelince GERÇEK tutarı yaz (tahmini yerine geçer)."""
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute(
            "UPDATE merkez_gider SET gercek_tutar=%s, gercek_ay=%s, guncelleme=NOW() WHERE id=%s",
            (round(float(body.gercek_tutar), 2), (body.gercek_ay or None), gider_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Gider bulunamadı")
        conn.commit()
    return {"success": True}


@router.delete("/merkez-gider/{gider_id}")
def merkez_gider_sil(gider_id: str):
    with db() as (conn, cur):
        _ensure_tablolar(cur)
        cur.execute("DELETE FROM merkez_gider_agirlik WHERE gider_id=%s", (gider_id,))
        cur.execute("DELETE FROM merkez_gider WHERE id=%s", (gider_id,))
        conn.commit()
    return {"success": True}


@router.get("/dagitim")
def dagitim(bas: str, bit: str):
    """SALT-OKUR: dönemdeki merkez giderlerini şubelere OTOMATİK dağıtır.
    - Tahakkuk: her gün O AYIN gerçek gün sayısıyla (audit Karar C).
    - Değişken gider: gercek_tutar varsa o, yoksa tahmini (aylik_tutar) — 0 değil (audit Karar D).
    - Dağıtım: 'ciro' (dönemdeki şube ciro oranına göre — OTOMATİK, insan hatası yok),
      'esit' (şube sayısına eşit), 'manuel' (merkez_gider_agirlik). Ciro yoksa eşite düşer.
    Hiçbir veriyi DEĞİŞTİRMEZ — ciro/subeler salt-okur."""
    try:
        d_bas = date.fromisoformat(bas[:10])
        d_bit = date.fromisoformat(bit[:10])
    except Exception:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD olmalı")
    if d_bit < d_bas:
        raise HTTPException(400, "bitiş başlangıçtan önce olamaz")

    with db() as (_, cur):
        _ensure_tablolar(cur)
        # Operasyonel (satış) şubeler — merkez/sevkiyat hariç dağıtım hedefi
        cur.execute(
            "SELECT id::text AS id, ad FROM subeler WHERE aktif=TRUE AND id <> 'sube-merkez' ORDER BY ad"
        )
        subeler = [dict(r) for r in (cur.fetchall() or [])]
        sube_ids = [s["id"] for s in subeler]

        # Dönemdeki şube ciroları (dağıtım ağırlığı için — SALT-OKUR)
        ciro_map: Dict[str, float] = {sid: 0.0 for sid in sube_ids}
        if sube_ids:
            cur.execute(
                """
                SELECT sube_id::text AS sid,
                       COALESCE(SUM(COALESCE(nakit,0)+COALESCE(pos,0)+COALESCE(online,0)),0)::float AS ciro
                FROM ciro
                WHERE tarih BETWEEN %s::date AND %s::date AND sube_id = ANY(%s)
                GROUP BY sube_id
                """,
                (d_bas, d_bit, sube_ids),
            )
            for r in cur.fetchall():
                ciro_map[str(r["sid"])] = float(r["ciro"] or 0)
        toplam_ciro = sum(ciro_map.values())

        # Merkez giderleri
        cur.execute(
            """
            SELECT id, ad, kategori, tip, aylik_tutar::float AS aylik_tutar,
                   gercek_tutar::float AS gercek_tutar, dagitim,
                   baslangic, bitis, aktif
            FROM merkez_gider
            """
        )
        giderler = [dict(r) for r in (cur.fetchall() or [])]

        # Manuel ağırlıklar
        cur.execute("SELECT gider_id, sube_id::text AS sube_id, agirlik::float AS agirlik FROM merkez_gider_agirlik")
        agirlik_map: Dict[str, Dict[str, float]] = {}
        for r in cur.fetchall():
            agirlik_map.setdefault(str(r["gider_id"]), {})[str(r["sube_id"])] = float(r["agirlik"] or 0)

    # Hesap (Python — DB'ye dokunmaz)
    sube_pay: Dict[str, float] = {sid: 0.0 for sid in sube_ids}
    kalem_detay: List[Dict[str, Any]] = []
    toplam_tahakkuk = 0.0
    for g in giderler:
        if not _aktif_mi(g, d_bas, d_bit):
            continue
        etkin = float(g["gercek_tutar"]) if g.get("gercek_tutar") is not None else float(g.get("aylik_tutar") or 0)
        tutar = _gun_tahakkuk(etkin, d_bas, d_bit)
        if tutar <= 0:
            continue
        toplam_tahakkuk += tutar

        # Dağıtım oranları
        dag = g.get("dagitim") or "ciro"
        oranlar: Dict[str, float] = {}
        if dag == "manuel" and agirlik_map.get(g["id"]):
            am = agirlik_map[g["id"]]
            top = sum(am.get(sid, 0) for sid in sube_ids)
            if top > 0:
                oranlar = {sid: am.get(sid, 0) / top for sid in sube_ids}
        if not oranlar and dag != "esit" and toplam_ciro > 0:
            oranlar = {sid: ciro_map[sid] / toplam_ciro for sid in sube_ids}
        if not oranlar:  # esit veya ciro yok → eşit dağıt
            n = len(sube_ids) or 1
            oranlar = {sid: 1.0 / n for sid in sube_ids}

        for sid in sube_ids:
            sube_pay[sid] += tutar * oranlar.get(sid, 0)

        kalem_detay.append({
            "id": g["id"], "ad": g["ad"], "kategori": g["kategori"], "tip": g["tip"],
            "donem_tutar": round(tutar, 2), "dagitim": dag,
            "tahmini_mi": g.get("tip") == "degisken" and g.get("gercek_tutar") is None,
        })

    return {
        "bas": bas, "bit": bit,
        "toplam_merkez_gideri": round(toplam_tahakkuk, 2),
        "toplam_ciro": round(toplam_ciro, 2),
        "subeler": [
            {"sube_id": s["id"], "sube_adi": s["ad"],
             "ciro": round(ciro_map.get(s["id"], 0), 2),
             "merkez_gider_payi": round(sube_pay.get(s["id"], 0), 2)}
            for s in subeler
        ],
        "kalemler": sorted(kalem_detay, key=lambda x: -x["donem_tutar"]),
    }
