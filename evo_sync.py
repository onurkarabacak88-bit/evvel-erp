"""
evobulut REST API entegrasyonu.
Günlük satış verisi çeker → bar-ozet fiziksel sayımıyla karşılaştırır → fark alarmı üretir.

Env değişkenleri:
    EVO_KULLANICI  → evobulut kullanıcı adı (e-posta)
    EVO_SIFRE      → evobulut şifresi
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import APIRouter, HTTPException, Query

from database import db
from tr_saat import bugun_tr

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/evo", tags=["evo-sync"])

EVO_API   = "https://ws.evobulut.com/api"
EVO_USER  = os.environ.get("EVO_KULLANICI", "")
EVO_PASS  = os.environ.get("EVO_SIFRE", "")

# ─────────────────────────────────────────────
# 1. TOKEN YÖNETİMİ
# ─────────────────────────────────────────────

_token_cache: Dict[str, Any] = {}   # {"token": str, "expires": datetime}


def _token_al() -> str:
    """Token önbellekte geçerliyse döndür, yoksa yeni al."""
    now = datetime.utcnow()
    if _token_cache.get("token") and _token_cache.get("expires", now) > now:
        return _token_cache["token"]

    if not EVO_USER or not EVO_PASS:
        raise HTTPException(500, "EVO_KULLANICI veya EVO_SIFRE env değişkeni eksik")

    r = requests.post(
        f"{EVO_API}/Login",
        json={"kullanici_kodu": EVO_USER, "sifre": EVO_PASS},
        timeout=15,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut login başarısız: HTTP {r.status_code}")

    data = r.json()
    # evobulut cevabı: [{"Sonuc":"OK","TokenUID":"xxx",...}]
    if isinstance(data, list):
        data = data[0]

    token = data.get("TokenUID") or data.get("token_uid") or data.get("Token")
    if not token:
        raise HTTPException(502, f"evobulut token alınamadı: {data}")

    _token_cache["token"]   = token
    _token_cache["expires"] = now + timedelta(hours=8)   # genellikle günlük geçerli
    log.info("evobulut token alındı")
    return token


def _headers() -> dict:
    return {"TokenUID": _token_al(), "Content-Type": "application/json"}


# ─────────────────────────────────────────────
# 2. SATIŞ VERİSİ ÇEK
# ─────────────────────────────────────────────

def _tarih_fmt(d: date) -> str:
    """evobulut DD.MM.YYYY formatı bekliyor."""
    return d.strftime("%d.%m.%Y")


def evo_satis_cek(bastar: date, bittar: date, tip: int = 34) -> List[Dict]:
    """
    Fatura listesini çeker.
    tip=34 → Satış Fişi (hızlı satış)
    tip=31 → Satış Faturası
    """
    params = {
        "bastar": _tarih_fmt(bastar),
        "bittar": _tarih_fmt(bittar),
        "tip": tip,
    }
    r = requests.get(
        f"{EVO_API}/FaturaListesi",
        headers=_headers(),
        params=params,
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut FaturaListesi hatası: HTTP {r.status_code}")
    data = r.json()
    if isinstance(data, list):
        return data
    return data.get("Rows") or data.get("rows") or []


def evo_fatura_detay(fatura_id: str) -> List[Dict]:
    """Bir faturanın satır detaylarını (ürün adedi) çeker."""
    r = requests.get(
        f"{EVO_API}/FaturaBilgisiGetir",
        headers=_headers(),
        params={"id": fatura_id},
        timeout=15,
    )
    if r.status_code != 200:
        return []
    data = r.json()
    if isinstance(data, list):
        data = data[0] if data else {}
    return data.get("satirlar") or data.get("Satirlar") or []


def evo_urun_bazli_satis(bastar: date, bittar: date) -> Dict[str, float]:
    """
    Belirtilen tarih aralığında ürün adı → toplam satılan adet sözlüğü döndürür.
    Fatura listesini çeker, her faturanın satırlarını toplar.
    """
    faturalar = evo_satis_cek(bastar, bittar, tip=34)   # satış fişleri
    faturalar += evo_satis_cek(bastar, bittar, tip=31)  # satış faturaları

    urun_toplam: Dict[str, float] = {}
    for f in faturalar:
        fid = str(f.get("id") or f.get("ID") or f.get("a_id") or "")
        if not fid:
            continue
        satirlar = evo_fatura_detay(fid)
        for s in satirlar:
            ad  = str(s.get("stok_adi") or s.get("urun_adi") or s.get("a_adi") or "").strip()
            mik = float(s.get("miktar") or s.get("Miktar") or 0)
            if ad and mik > 0:
                urun_toplam[ad] = urun_toplam.get(ad, 0) + mik

    return urun_toplam


# ─────────────────────────────────────────────
# 3. FİZİKSEL SAYIM vs POS KARŞILAŞTIRMA
# ─────────────────────────────────────────────

# evobulut ürün adı → senin sistemindeki bar_key eşlemesi
_URUN_MAP: Dict[str, str] = {
    "Su":            "su_adet",
    "Redbull":       "redbull_adet",
    "Sade Soda":     "soda_adet",
    "Elmalı Soda":   "soda_adet",
    "Limonata":      "soda_adet",
    "Limonlu Soda":  "soda_adet",
    "Pasta":         "pasta_adet",
    # kahve ürünleri → kahve_paket olarak say
    "Türk Kahvesi":              "kahve_paket",
    "Filtre Kahve 14 Oz":        "kahve_paket",
    "Filtre Kahve 8 Oz":         "kahve_paket",
    "Americano 14 Oz":           "kahve_paket",
    "Americano 8 Oz":            "kahve_paket",
    "Latte 14 Oz":               "kahve_paket",
    "Latte 8 Oz":                "kahve_paket",
    "Caramel Macchiato 14 Oz":   "kahve_paket",
    "Caramel Macchiato 8 Oz":    "kahve_paket",
    "White Mocha 14 Oz":         "kahve_paket",
    "White Mocha 8 Oz":          "kahve_paket",
    "Mocha 14 Oz":               "kahve_paket",
    "Flat White 14 Oz":          "kahve_paket",
    "Toffee Nut Latte 14 Oz":    "kahve_paket",
    "Cookie Latte 14 Oz":        "kahve_paket",
    "Menengiç Kahvesi":          "kahve_paket",
    "Sahlep 14 Oz":              "kahve_paket",
    "Sıcak Çikolata 14 Oz":      "kahve_paket",
    "Sıcak Çikolata 8 Oz":       "kahve_paket",
    # ice
    "Americano Ice":             "kahve_paket",
    "Caramel Macchiato Ice":     "kahve_paket",
    "Latte Ice":                 "kahve_paket",
    "White Mocha Ice":           "kahve_paket",
    "Filtre Kahve Ice":          "kahve_paket",
}


def pos_vs_fiziksel(
    sube_id: str,
    tarih: date,
    evo_satis: Dict[str, float],
) -> List[Dict]:
    """
    evobulut POS satışı ile fiziksel açılış-kapanış farkını karşılaştırır.
    Sonuç: her bar_key için {urun, pos_adet, fizik_adet, fark, fark_pct} listesi
    """
    # Fiziksel satılan = bar-ozet hesabından
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT e.meta, e.tip
                FROM sube_operasyon_event e
                WHERE e.sube_id = %s
                  AND e.tarih  = %s
                  AND e.tip IN ('ACILIS','KAPANIS')
                  AND e.durum  = 'tamamlandi'
                ORDER BY e.tip
            """, (sube_id, tarih))
            rows = {r["tip"]: r for r in cur.fetchall()}

    def _stok(row, alan):
        if not row:
            return {}
        meta = row.get("meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        return meta.get(alan) or {}

    acilis  = _stok(rows.get("ACILIS"),  "acilis_stok_sayim")
    kapanis = _stok(rows.get("KAPANIS"), "kapanis_stok_sayim")

    # POS verisini bar_key'e çevir
    pos_key: Dict[str, float] = {}
    for urun_adi, adet in evo_satis.items():
        key = _URUN_MAP.get(urun_adi)
        if key:
            pos_key[key] = pos_key.get(key, 0) + adet

    # Karşılaştır
    sonuclar = []
    for key, pos_adet in pos_key.items():
        a   = float(acilis.get(key) or 0)
        k   = float(kapanis.get(key) or 0)
        fiz = a - k   # fiziksel kullanım
        fark = fiz - pos_adet
        fark_pct = abs(fark / pos_adet * 100) if pos_adet else 0

        sonuclar.append({
            "bar_key":  key,
            "pos_adet": round(pos_adet, 1),
            "fiz_adet": round(fiz, 1),
            "fark":     round(fark, 1),
            "fark_pct": round(fark_pct, 1),
            "durum": (
                "ok"          if fark_pct < 5  else
                "uyari"       if fark_pct < 15 else
                "sorusturma"
            ),
        })

    sonuclar.sort(key=lambda x: -abs(x["fark"]))
    return sonuclar


# ─────────────────────────────────────────────
# 4. API ENDPOINT'LERİ
# ─────────────────────────────────────────────

@router.get("/token-test")
def evo_token_test():
    """evobulut bağlantısını test eder."""
    try:
        token = _token_al()
        return {"durum": "ok", "token_var": bool(token)}
    except Exception as e:
        raise HTTPException(502, str(e))


@router.get("/satis")
def evo_satis_endpoint(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
):
    """evobulut'tan ürün bazlı satış verisi çeker."""
    try:
        b = date.fromisoformat(bastar)
        e = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD olmalı")

    satis = evo_urun_bazli_satis(b, e)
    return {
        "bastar": bastar,
        "bittar": bittar,
        "toplam_urun": len(satis),
        "satislar": satis,
    }


@router.get("/karsilastir")
def evo_karsilastir(
    sube_id: str = Query(...),
    tarih: str   = Query(..., description="YYYY-MM-DD"),
):
    """
    Bir şubenin belirtilen günü için:
    evobulut POS satışı vs fiziksel açılış-kapanış farkını karşılaştırır.
    """
    try:
        t = date.fromisoformat(tarih)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD olmalı")

    evo_satis = evo_urun_bazli_satis(t, t)
    sonuclar  = pos_vs_fiziksel(sube_id, t, evo_satis)

    alarm_var = any(s["durum"] != "ok" for s in sonuclar)
    return {
        "sube_id":   sube_id,
        "tarih":     tarih,
        "alarm_var": alarm_var,
        "satirlar":  sonuclar,
    }


@router.get("/bugun")
def evo_bugun(sube_id: str = Query(...)):
    """Bugünkü karşılaştırmayı döndürür."""
    return evo_karsilastir(sube_id=sube_id, tarih=str(bugun_tr()))
