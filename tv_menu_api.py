"""
TV MENÜ — İZOLE modül (TULİPİ dijital menü panosu + canlı fiyat yönetimi).

AMAÇ: TV'den açılabilen tam ekran, otomatik dönen "yaşayan menü" + fiyatların
EVVEL'den canlı çekilmesi. Panelden fiyat değişince TV kendiliğinden günceller.

İZOLASYON: Kendi tablosu `tv_menu`. Başka hiçbir tabloya dokunmaz. main.py'ye
try/except ile takılır; patlasa ana app ayakta kalır.

UÇLAR:
  GET    /api/tv-menu          → TV'nin çektiği canlı menü (kategori gruplu JSON)
  GET    /api/tv-menu/liste    → yönetim için düz liste
  POST   /api/tv-menu/urun     → ürün ekle
  PUT    /api/tv-menu/urun/{id}→ ürün/fiyat güncelle
  DELETE /api/tv-menu/urun/{id}→ ürün sil
  GET    /tv-menu              → TAM EKRAN HTML pano (TV'de aç)
  GET    /tv-menu/logo         → marka logosu (jpg)
"""
from __future__ import annotations

import logging
import os
import re
import time
import uuid
from datetime import datetime, date as _date
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

from database import db

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tv-menu"])

_TABLO_HAZIR = False

# Tohum menü (ilk kurulumda) — kategori, ad, açıklama, 8oz, 14oz, ice, sıra
_TOHUM = [
    ("Classic Coffees", "Espresso", "single origin", 110, None, None),
    ("Classic Coffees", "Double Espresso", "", 120, None, None),
    ("Classic Coffees", "Americano", "", 135, 145, 155),
    ("Classic Coffees", "Latte", "silky · smooth", 170, 180, 195),
    ("Classic Coffees", "Cappuccino", "velvet foam", 170, 180, 195),
    ("Classic Coffees", "Flat White", "", None, 185, 195),
    ("Classic Coffees", "Mocha", "70% cacao", 185, 200, 205),
    ("Classic Coffees", "White Mocha", "", 185, 200, 205),
    ("Classic Coffees", "Caramel Macchiato", "", 185, 200, 205),
    ("Classic Coffees", "Filtre Kahve", "", 135, 145, 155),
    ("Classic Coffees", "Sütlü Filtre Kahve", "", 145, 155, 165),
    ("Iced & Cold", "Iced Latte", "over ice", 180, None, None),
    ("Iced & Cold", "Iced Americano", "", 155, None, None),
    ("Iced & Cold", "Iced Mocha", "", 205, None, None),
    ("Iced & Cold", "Cold Brew", "18h steeped", 175, None, None),
]

# TOHUM V2 — gerçek TULİPİ menüsü (Signature/Mocktails/Milkshakes). Mevcut kayıtlara
# EKLENİR (silmez/ezmez), tv_ayar.menu_v2_yuklendi bayrağıyla tek seferlik çalışır.
# Mocktail/Milkshake fiyatları kaynak görselde yoktu → None (panelden doldurulmalı).
_TOHUM_V2 = [
    ("Signature Coffees", "Cookie Latte", "", 190, 205, 215),
    ("Signature Coffees", "Pumpkin Latte", "", 190, 205, 215),
    ("Signature Coffees", "Dream Latte", "", 190, 205, 215),
    ("Signature Coffees", "Banana Fish", "", 190, 205, 215),
    ("Signature Coffees", "Berry Latte", "", 190, 205, 215),
    ("Signature Coffees", "Vanilla Latte", "", 190, 205, 215),
    ("Signature Coffees", "Toffee Nut Latte", "", 190, 205, 215),
    ("Signature Coffees", "Salted Caramel Cappuccino", "", 190, 205, 215),
    ("Signature Coffees", "Madagaskar Latte", "", 190, 205, 215),
    ("Signature Coffees", "Velvet Latte", "", 190, 205, 215),
    ("Signature Coffees", "Taro Latte", "", 190, 205, 215),
    ("Signature Coffees", "Pop Latte", "", 190, 205, 215),
    ("Signature Coffees", "Irish Cream Latte", "", 190, 205, 215),
    ("Signature Coffees", "Zebra Mocha", "", 190, 205, 215),
    ("Mocktails", "YODA", "", None, None, None),
    ("Mocktails", "Fetish", "", None, None, None),
    ("Mocktails", "Serotonin", "", None, None, None),
    ("Mocktails", "Kuzukulağı", "", None, None, None),
    ("Mocktails", "Sparkle", "", None, None, None),
    ("Mocktails", "Pink Floyd", "", None, None, None),
    ("Mocktails", "Nar Spark", "", None, None, None),
    ("Milkshakes", "Çikolata Milkshake", "", None, None, None),
    ("Milkshakes", "Çilek Milkshake", "", None, None, None),
    ("Milkshakes", "Muz Milkshake", "", None, None, None),
    ("Milkshakes", "Vanilya Milkshake", "", None, None, None),
    ("Milkshakes", "Velvet Milkshake", "", None, None, None),
    ("Milkshakes", "Tulipi Milkshake", "", None, None, None),
]


def _seed_v2(cur):
    """Gerçek menüyü (Signature/Mocktails/Milkshakes) tek seferlik, EKLEYEREK kurar."""
    cur.execute("SELECT deger FROM tv_ayar WHERE anahtar='menu_v2_yuklendi'")
    r = cur.fetchone()
    if r and r.get("deger") == "1":
        return
    cur.execute("SELECT ad FROM tv_menu")
    mevcut = {str(x["ad"]).strip().lower() for x in (cur.fetchall() or [])}
    cur.execute("SELECT COALESCE(MAX(sira),0) AS m FROM tv_menu")
    sira0 = int((cur.fetchone() or {}).get("m") or 0) + 1
    for i, (kat, ad, ack, f8, f14, fice) in enumerate(_TOHUM_V2):
        if ad.strip().lower() in mevcut:
            continue
        cur.execute(
            """INSERT INTO tv_menu (id,kategori,ad,aciklama,f8,f14,fice,sira)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (str(uuid.uuid4()), kat, ad, ack, f8, f14, fice, sira0 + i),
        )
    cur.execute(
        "INSERT INTO tv_ayar (anahtar,deger) VALUES ('menu_v2_yuklendi','1') "
        "ON CONFLICT (anahtar) DO UPDATE SET deger=EXCLUDED.deger"
    )


def _ensure_tablo(cur):
    global _TABLO_HAZIR
    if _TABLO_HAZIR:
        return
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tv_menu (
            id TEXT PRIMARY KEY,
            kategori TEXT NOT NULL,
            kategori_alt TEXT,
            ad TEXT NOT NULL,
            aciklama TEXT,
            f8 NUMERIC, f14 NUMERIC, fice NUMERIC,
            sira INTEGER DEFAULT 0,
            aktif BOOLEAN DEFAULT TRUE,
            guncelleme TIMESTAMPTZ DEFAULT NOW()
        )"""
    )
    # FAZ 2: yeni ürün bayrağı + ayar tablosu (happy hour, öne çıkan)
    try:
        cur.execute("ALTER TABLE tv_menu ADD COLUMN IF NOT EXISTS yeni BOOLEAN DEFAULT FALSE")
    except Exception:
        pass
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tv_ayar (anahtar TEXT PRIMARY KEY, deger TEXT)"""
    )
    cur.execute("SELECT COUNT(*) AS n FROM tv_menu")
    if int((cur.fetchone() or {}).get("n") or 0) == 0:
        for i, (kat, ad, ack, f8, f14, fice) in enumerate(_TOHUM):
            cur.execute(
                """INSERT INTO tv_menu (id,kategori,ad,aciklama,f8,f14,fice,sira)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (str(uuid.uuid4()), kat, ad, ack, f8, f14, fice, i),
            )
    _seed_v2(cur)
    _TABLO_HAZIR = True


def _ayar_oku(cur) -> dict:
    cur.execute("SELECT anahtar, deger FROM tv_ayar")
    return {r["anahtar"]: r["deger"] for r in (cur.fetchall() or [])}


# Evo "en çok satılan" — bellek cache (token kırılgan + Evo yavaş; 30 dk'da bir yenilenir)
_EVO_CACHE = {"ts": 0.0, "urun": None}


class UrunModel(BaseModel):
    kategori: str
    ad: str
    aciklama: Optional[str] = None
    f8: Optional[float] = None
    f14: Optional[float] = None
    fice: Optional[float] = None
    sira: Optional[int] = 0
    aktif: Optional[bool] = True
    yeni: Optional[bool] = False


def _fmt(v):
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 2)


@router.get("/api/tv-menu")
def tv_menu_json():
    """TV'nin çektiği canlı menü — kategori gruplu."""
    try:
        with db() as (conn, cur):
            _ensure_tablo(cur)
            ayar = _ayar_oku(cur)
            cur.execute(
                """SELECT kategori, kategori_alt, ad, aciklama, f8, f14, fice
                   FROM tv_menu WHERE aktif=TRUE ORDER BY kategori, sira, ad"""
            )
            rows = [dict(r) for r in (cur.fetchall() or [])]
        kats = []
        idx = {}
        for r in rows:
            k = r["kategori"]
            if k not in idx:
                idx[k] = {"kategori": k, "alt": r.get("kategori_alt") or "", "urunler": []}
                kats.append(idx[k])
            idx[k]["urunler"].append({
                "ad": r["ad"], "aciklama": r.get("aciklama") or "",
                "f8": _fmt(r.get("f8")), "f14": _fmt(r.get("f14")), "fice": _fmt(r.get("fice")),
            })
        # İMZA SPOTLIGHT — panelden "imza ürünü" seçilirse fiyatı menüden bulup ekle
        imza = None
        iad = (ayar.get("imza_urun") or "").strip()
        if iad:
            fy = None
            for r in rows:
                if str(r["ad"]).strip().lower() == iad.lower():
                    fy = _fmt(r.get("f8")) or _fmt(r.get("f14")) or _fmt(r.get("fice"))
                    break
            imza = {"ad": iad, "aciklama": (ayar.get("imza_aciklama") or "").strip(), "fiyat": fy}
        # PERFECT PAIR — eşleştirme önerisi (upsell): panelden seçilen ürünün fiyatını menüden bul
        pair = None
        pad = (ayar.get("pair_urun") or "").strip()
        if pad:
            pf = None
            for r in rows:
                if str(r["ad"]).strip().lower() == pad.lower():
                    pf = _fmt(r.get("f8")) or _fmt(r.get("f14")) or _fmt(r.get("fice"))
                    break
            pair = {"ad": pad, "fiyat": pf, "mesaj": (ayar.get("pair_mesaj") or "Yanına çok yakışır")}
        return {"marka": "TULİPİ", "guncelleme": datetime.now().isoformat(), "kategoriler": kats, "imza": imza, "pair": pair}
    except Exception as e:
        logger.warning("tv-menu json hata: %s", e)
        return {"marka": "TULİPİ", "kategoriler": [], "hata": str(e)}


@router.get("/api/tv-menu/liste")
def tv_menu_liste():
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("SELECT * FROM tv_menu ORDER BY kategori, sira, ad")
        return [dict(r) for r in (cur.fetchall() or [])]


def _evo_parse(ad: str):
    """Evo ürün adı → (taban ad, kolon). 'X Ice'→fice, 'X 14oz'→f14, diğer→f8."""
    n = re.sub(r"\s+", " ", str(ad).strip().lower())
    if re.search(r"\bice\b", n):
        return re.sub(r"\bice\b", "", n).strip(), "fice"
    if re.search(r"14 ?oz", n):
        return re.sub(r"14 ?oz", "", n).strip(), "f14"
    if re.search(r"8 ?oz", n):
        return re.sub(r"8 ?oz", "", n).strip(), "f8"
    return n, "f8"


@router.get("/api/tv-menu/evo-fiyat-oneri")
def tv_evo_fiyat_oneri(gun: int = 30, max_fatura: int = 80, ham: int = 0):
    """Evo'dan ürün fiyatlarını çekip TV menüsüyle eşleştirir — SALT-OKUR ÖNERİ (ezmez).
    Aylık pencere (gün=30) yavaş satan pastaları da yakalar. 'X Ice'→fice, 'X 14oz'→f14, diğer→f8."""
    from datetime import timedelta
    try:
        from evo_sync import evo_urun_fiyatlari
        bit = _date.today()
        bas = bit - timedelta(days=max(1, gun))
        if ham == 1:
            from evo_sync import _hs_cok_satilan
            return {"ham_ornek": _hs_cok_satilan(bas, bit)}
        if ham == 2:
            from evo_sync import _hs_rapor_full
            d = _hs_rapor_full(bas, bit)
            return {"keys": list(d.keys()),
                    "bolumler": {k: (len(v) if isinstance(v, list) else str(v)[:60]) for k, v in d.items()},
                    "grup_pasta": d.get("Grup_Pasta", [])}
        evo = evo_urun_fiyatlari(bas, bit, max_fatura)
    except Exception as e:
        raise HTTPException(503, "Evo fiyat alınamadı: %s" % e)
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("SELECT id,kategori,ad,f8,f14,fice FROM tv_menu WHERE aktif=TRUE ORDER BY kategori,sira,ad")
        rows = [dict(r) for r in (cur.fetchall() or [])]
    norm = lambda s: re.sub(r"\s+", " ", str(s).strip().lower())
    evo_map = {}
    for ad, fy in evo.items():
        b, k = _evo_parse(ad)
        evo_map[(b, k)] = (ad, fy)
    oneriler = []
    for r in rows:
        base = norm(r["ad"])
        for kol in ("f8", "f14", "fice"):
            hit = evo_map.get((base, kol))
            if hit:
                mevcut = r.get(kol)
                oneriler.append({
                    "id": r["id"], "menu_ad": r["ad"], "kolon": kol,
                    "evo_ad": hit[0], "mevcut": _fmt(mevcut), "evo": hit[1],
                    "fark": (None if mevcut is None else round(float(hit[1]) - float(mevcut), 2)),
                })
    eslesen = {norm(r["ad"]) for r in rows}
    eslesmeyen = sorted({_evo_parse(a)[0] for a in evo if _evo_parse(a)[0] not in eslesen})
    return {"tarih_araligi": [str(bas), str(bit)], "evo_urun_sayisi": len(evo),
            "oneri_sayisi": len(oneriler), "oneriler": oneriler, "eslesmeyen": eslesmeyen[:40],
            "evo_fiyatlar": dict(sorted(evo.items()))}


@router.post("/api/tv-menu/evo-fiyat-uygula")
def tv_evo_fiyat_uygula(gun: int = 30, max_fatura: int = 80):
    """Evo fiyatlarını menüye UYGULAR (eşleşen kolonları günceller). İnsan tetikler (panel butonu)."""
    from datetime import timedelta
    try:
        from evo_sync import evo_urun_fiyatlari
        bit = _date.today()
        bas = bit - timedelta(days=max(1, gun))
        evo = evo_urun_fiyatlari(bas, bit, max_fatura)
    except Exception as e:
        raise HTTPException(503, "Evo fiyat alınamadı: %s" % e)
    if not evo:
        raise HTTPException(503, "Evo'dan fiyat gelmedi (token/veri yok)")
    norm = lambda s: re.sub(r"\s+", " ", str(s).strip().lower())
    evo_map = {}
    for ad, fy in evo.items():
        b, k = _evo_parse(ad)
        evo_map[(b, k)] = fy
    degisti = []
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("SELECT id,ad,f8,f14,fice FROM tv_menu WHERE aktif=TRUE")
        rows = [dict(r) for r in (cur.fetchall() or [])]
        for r in rows:
            base = norm(r["ad"])
            upd = {}
            for kol in ("f8", "f14", "fice"):
                ev = evo_map.get((base, kol))
                if ev is None:
                    continue
                cur_v = r.get(kol)
                if cur_v is None or abs(float(cur_v) - float(ev)) >= 0.5:
                    upd[kol] = ev
                    degisti.append({"ad": r["ad"], "kolon": kol, "eski": _fmt(cur_v), "yeni": ev})
            if upd:
                cols = list(upd.keys())
                setsql = ",".join(c + "=%s" for c in cols)
                cur.execute("UPDATE tv_menu SET " + setsql + ",guncelleme=NOW() WHERE id=%s",
                            [upd[c] for c in cols] + [r["id"]])
    return {"degisen_sayisi": len(degisti), "degisenler": degisti}


@router.post("/api/tv-menu/urun")
def tv_menu_ekle(u: UrunModel):
    with db() as (conn, cur):
        _ensure_tablo(cur)
        uid = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO tv_menu (id,kategori,ad,aciklama,f8,f14,fice,sira,aktif,yeni)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (uid, u.kategori, u.ad, u.aciklama, u.f8, u.f14, u.fice, (u.sira or 0), u.aktif, bool(u.yeni)),
        )
    return {"id": uid, "success": True}


@router.put("/api/tv-menu/urun/{uid}")
def tv_menu_guncelle(uid: str, u: UrunModel):
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("SELECT id FROM tv_menu WHERE id=%s", (uid,))
        if not cur.fetchone():
            raise HTTPException(404, "Ürün bulunamadı")
        cur.execute(
            """UPDATE tv_menu SET kategori=%s,ad=%s,aciklama=%s,f8=%s,f14=%s,fice=%s,
               sira=%s,aktif=%s,yeni=%s,guncelleme=NOW() WHERE id=%s""",
            (u.kategori, u.ad, u.aciklama, u.f8, u.f14, u.fice, (u.sira or 0), u.aktif, bool(u.yeni), uid),
        )
    return {"success": True}


@router.delete("/api/tv-menu/urun/{uid}")
def tv_menu_sil(uid: str):
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("DELETE FROM tv_menu WHERE id=%s", (uid,))
    return {"success": True}


def _saat_modu():
    h = datetime.now().hour
    if 6 <= h < 11:
        return {"mod": "sabah", "etiket": "GÜNAYDIN", "oneri": "Breakfast"}
    if 11 <= h < 17:
        return {"mod": "ogle", "etiket": "SERİNLE", "oneri": "Iced Drinks"}
    if 17 <= h < 23:
        return {"mod": "aksam", "etiket": "TATLI SAATİ", "oneri": "Dessert + Coffee"}
    return {"mod": "gece", "etiket": "İYİ GECELER", "oneri": ""}


def _mevsim():
    m = datetime.now().month
    if m in (12, 1, 2):
        return {"ad": "kis", "etiket": "❄️ Kış", "oneri": "Sıcak Çikolata · Tarçınlı Latte"}
    if m in (3, 4, 5):
        return {"ad": "ilkbahar", "etiket": "🌸 İlkbahar", "oneri": ""}
    if m in (6, 7, 8):
        return {"ad": "yaz", "etiket": "☀️ Yaz", "oneri": "Cold Brew · Iced Latte"}
    return {"ad": "sonbahar", "etiket": "🍂 Sonbahar", "oneri": ""}


def _ozel_gun(ayar):
    """Özel gün motoru: manuel override (Ramazan vb. ay takvimi gerektirir) öncelikli; yoksa sabit tarihler."""
    om = (ayar.get("ozel_mesaj") or "").strip()
    if om:
        return {"ad": "manuel", "etiket": (ayar.get("ozel_etiket") or "✨").strip(), "mesaj": om}
    t = datetime.now()
    m, d = t.month, t.day
    if (m == 12 and d >= 28) or (m == 1 and d <= 2):
        return {"ad": "yilbasi", "etiket": "🎄 Yeni Yıl", "mesaj": "Mutlu Yıllar"}
    if m == 10 and d == 29:
        return {"ad": "cumhuriyet", "etiket": "🇹🇷 29 Ekim", "mesaj": "Cumhuriyet Bayramı Kutlu Olsun"}
    if m == 2 and d == 14:
        return {"ad": "sevgili", "etiket": "❤️", "mesaj": "Sevgililer Günü"}
    return None


def _en_cok(ayar):
    """Manuel öne çıkan öncelikli; oto açıksa Evo'dan (30 dk cache, hata-yutar)."""
    if str(ayar.get("one_cikan_oto") or "") == "1":
        if time.time() - _EVO_CACHE["ts"] > 1800 or not _EVO_CACHE["urun"]:
            try:
                from evo_sync import hs_rapor_urun_satis
                m = hs_rapor_urun_satis(_date.today(), _date.today())
                if m:
                    _EVO_CACHE["urun"] = max(m.items(), key=lambda x: x[1])[0]
                    _EVO_CACHE["ts"] = time.time()
            except Exception as e:
                logger.warning("tv en_cok Evo hata: %s", e)
        if _EVO_CACHE["urun"]:
            return _EVO_CACHE["urun"]
    return (ayar.get("one_cikan") or "").strip() or None


# Saat-modu / mevsim → bu kategorilerden az-satılan ürün öner (akıllı menü).
# Klasik temel ürünler (Classic Coffees/Iced & Cold) zaten bilinir, öneri motoru
# vitrin/imza ürünlere (Signature/Mocktails/Milkshakes) odaklanır.
_ONERI_KATEGORI = {
    "sabah": ["Signature Coffees", "Classic Coffees"],
    "ogle": ["Mocktails", "Iced & Cold"],
    "aksam": ["Milkshakes", "Signature Coffees"],
    "gece": ["Milkshakes", "Mocktails"],
}
_ONERI_NEDEN = {
    "sabah": "Güne güçlü başla",
    "ogle": "Serinlemek için birebir",
    "aksam": "Tatlı saatinin yıldızı",
    "gece": "Gece molası",
}

# Evo 30 günlük satış adedi — bellek cache (30 dk, hata-yutar)
_SATIS_CACHE = {"ts": 0.0, "map": {}}


def _satis_30gun():
    if time.time() - _SATIS_CACHE["ts"] < 1800 and _SATIS_CACHE["map"]:
        return _SATIS_CACHE["map"]
    try:
        from datetime import timedelta
        from evo_sync import hs_rapor_urun_satis
        bit = _date.today()
        bas = bit - timedelta(days=30)
        m = hs_rapor_urun_satis(bas, bit) or {}
        _SATIS_CACHE["map"] = m
        _SATIS_CACHE["ts"] = time.time()
    except Exception as e:
        logger.warning("tv satis_30gun hata: %s", e)
    return _SATIS_CACHE["map"]


def _top3(satis):
    """Bugün/son 30 günde en çok tercih edilen 3 ürün (ayrı sahne için)."""
    sirali = sorted(satis.items(), key=lambda x: -x[1])[:3]
    return [{"ad": a, "adet": c} for a, c in sirali if c > 0]


def _oneri_motoru(rows, sm_mod, mevsim_ad, haric=None):
    """Az satılan ama saat/mevsime uygun bir vitrin ürünü seçer (sürekli tazelenen öneri).
    Çok satılanı tekrar önermez (haric), sessiz kalan ürünleri öne çıkarır."""
    satis = _satis_30gun()
    norm = lambda s: re.sub(r"\s+", " ", str(s).strip().lower())
    pref = list(_ONERI_KATEGORI.get(sm_mod, ["Signature Coffees"]))
    if mevsim_ad == "yaz":
        for c in ("Mocktails", "Milkshakes", "Iced & Cold"):
            if c not in pref:
                pref.append(c)
    elif mevsim_ad == "kis":
        for c in ("Signature Coffees", "Classic Coffees"):
            if c not in pref:
                pref.append(c)
    hn = norm(haric) if haric else None
    cands = [r for r in rows if r["kategori"] in pref and (not hn or norm(r["ad"]) != hn)]
    if not cands:
        cands = [r for r in rows if not hn or norm(r["ad"]) != hn]
    if not cands:
        return None

    def adet(r):
        rn = norm(r["ad"])
        for k, v in satis.items():
            if norm(k) == rn:
                return v
        return 0

    cands_sirali = sorted(cands, key=lambda r: (adet(r), r.get("sira") or 0))
    pick = cands_sirali[0]
    fy = _fmt(pick.get("f8")) or _fmt(pick.get("f14")) or _fmt(pick.get("fice"))
    return {"ad": pick["ad"], "fiyat": fy, "kategori": pick["kategori"],
            "neden": _ONERI_NEDEN.get(sm_mod, "Bugün dene")}


@router.get("/api/tv-signals")
def tv_signals():
    """FAZ 2 — yaşayan menü sinyalleri (saat-modu / en-çok / yeni / happy hour / akıllı öneri / top3)."""
    yeni = []
    ayar = {}
    rows = []
    try:
        with db() as (conn, cur):
            _ensure_tablo(cur)
            ayar = _ayar_oku(cur)
            cur.execute(
                "SELECT kategori,ad,f8,f14,fice,sira,yeni FROM tv_menu WHERE aktif=TRUE ORDER BY kategori, sira, ad"
            )
            rows = [dict(r) for r in (cur.fetchall() or [])]
            yeni = [r["ad"] for r in rows if r.get("yeni")]
    except Exception as e:
        logger.warning("tv-signals hata: %s", e)
    sm = _saat_modu()
    mv = _mevsim()
    en_cok = _en_cok(ayar)
    satis = _satis_30gun()
    top3 = _top3(satis)
    oneri = None
    try:
        oneri = _oneri_motoru(rows, sm["mod"], mv["ad"], haric=en_cok)
    except Exception as e:
        logger.warning("tv oneri_motoru hata: %s", e)
    hh = None
    try:
        if str(ayar.get("hh_aktif") or "") == "1":
            bas = int(ayar.get("hh_bas") or 14)
            bit = int(ayar.get("hh_bit") or 16)
            hh = {"aktif": bas <= datetime.now().hour < bit, "bas": bas, "bit": bit,
                  "mesaj": (ayar.get("hh_mesaj") or "Happy Hour")}
    except Exception:
        pass
    seritler = []
    if en_cok:
        seritler.append("🔥 Bugün en çok: " + en_cok)
    if yeni:
        seritler.append("✨ Yeni: " + " · ".join(yeni[:2]))
    if hh and hh.get("aktif"):
        seritler.append("⏰ " + hh["mesaj"] + " · " + str(hh["bas"]) + ":00–" + str(hh["bit"]) + ":00")
    if sm["oneri"]:
        seritler.append(sm["etiket"] + " · " + sm["oneri"])
    if mv["oneri"]:
        seritler.append(mv["etiket"] + " · " + mv["oneri"])
    if oneri:
        seritler.append("💡 " + oneri["neden"] + " · " + oneri["ad"])
    oz = _ozel_gun(ayar)
    if oz:
        seritler.insert(0, oz["etiket"] + " · " + oz["mesaj"])   # özel gün şeridi en başta
    return {"saat_modu": sm, "mevsim": mv, "ozel": oz, "en_cok": en_cok, "yeni": yeni,
            "happy_hour": hh, "top3": top3, "oneri": oneri, "seritler": seritler}


class AyarModel(BaseModel):
    one_cikan: Optional[str] = None
    one_cikan_oto: Optional[bool] = None
    hh_aktif: Optional[bool] = None
    hh_bas: Optional[int] = None
    hh_bit: Optional[int] = None
    hh_mesaj: Optional[str] = None
    imza_urun: Optional[str] = None
    imza_aciklama: Optional[str] = None
    pair_urun: Optional[str] = None
    pair_mesaj: Optional[str] = None
    ozel_etiket: Optional[str] = None
    ozel_mesaj: Optional[str] = None


@router.get("/api/tv-ayar")
def tv_ayar_oku():
    with db() as (conn, cur):
        _ensure_tablo(cur)
        a = _ayar_oku(cur)
    return {
        "one_cikan": a.get("one_cikan") or "", "one_cikan_oto": a.get("one_cikan_oto") == "1",
        "hh_aktif": a.get("hh_aktif") == "1", "hh_bas": int(a.get("hh_bas") or 14),
        "hh_bit": int(a.get("hh_bit") or 16), "hh_mesaj": a.get("hh_mesaj") or "Happy Hour",
        "imza_urun": a.get("imza_urun") or "", "imza_aciklama": a.get("imza_aciklama") or "",
        "pair_urun": a.get("pair_urun") or "", "pair_mesaj": a.get("pair_mesaj") or "",
        "ozel_etiket": a.get("ozel_etiket") or "", "ozel_mesaj": a.get("ozel_mesaj") or "",
    }


@router.post("/api/tv-ayar")
def tv_ayar_yaz(a: AyarModel):
    kv = {}
    if a.one_cikan is not None:
        kv["one_cikan"] = a.one_cikan.strip()
    if a.one_cikan_oto is not None:
        kv["one_cikan_oto"] = "1" if a.one_cikan_oto else "0"
    if a.hh_aktif is not None:
        kv["hh_aktif"] = "1" if a.hh_aktif else "0"
    if a.hh_bas is not None:
        kv["hh_bas"] = str(int(a.hh_bas))
    if a.hh_bit is not None:
        kv["hh_bit"] = str(int(a.hh_bit))
    if a.hh_mesaj is not None:
        kv["hh_mesaj"] = a.hh_mesaj.strip()
    if a.imza_urun is not None:
        kv["imza_urun"] = a.imza_urun.strip()
    if a.imza_aciklama is not None:
        kv["imza_aciklama"] = a.imza_aciklama.strip()
    if a.pair_urun is not None:
        kv["pair_urun"] = a.pair_urun.strip()
    if a.pair_mesaj is not None:
        kv["pair_mesaj"] = a.pair_mesaj.strip()
    if a.ozel_etiket is not None:
        kv["ozel_etiket"] = a.ozel_etiket.strip()
    if a.ozel_mesaj is not None:
        kv["ozel_mesaj"] = a.ozel_mesaj.strip()
    with db() as (conn, cur):
        _ensure_tablo(cur)
        for k, v in kv.items():
            cur.execute(
                "INSERT INTO tv_ayar (anahtar,deger) VALUES (%s,%s) "
                "ON CONFLICT (anahtar) DO UPDATE SET deger=EXCLUDED.deger", (k, v))
    return {"success": True}


@router.get("/tv-menu/logo")
def tv_menu_logo():
    for p in ("src/assets/tulipi-logo.jpg",):
        if os.path.exists(p):
            return FileResponse(p, media_type="image/jpeg")
    # statik hash'li kopya fallback
    import glob
    g = glob.glob("static/assets/tulipi-logo*.jpg")
    if g:
        return FileResponse(g[0], media_type="image/jpeg")
    raise HTTPException(404, "logo yok")


@router.get("/tv-menu/clip/{name}")
def tv_menu_clip(name: str):
    """Coffee Story gerçek video klipleri (Mixkit Free, ticari kullanım serbest)."""
    if name not in ("bean", "latte", "cup", "dessert", "cold", "brew", "froth"):
        raise HTTPException(404, "klip yok")
    # Prod: Vite public/ -> static/tv'ye kopyalar. Dev: public/tv veya src/assets/tv.
    for base in ("static/tv", "public/tv", "src/assets/tv"):
        p = os.path.join(base, name + ".mp4")
        if os.path.exists(p):
            return FileResponse(p, media_type="video/mp4")
    raise HTTPException(404, "klip dosyası yok")


@router.get("/tv-menu", response_class=HTMLResponse)
def tv_menu_html():
    """TAM EKRAN TV PANOSU — /api/tv-menu'den canlı çeker, otomatik döner,
    offline cache'li. TV tarayıcısında aç → F11 tam ekran."""
    return HTMLResponse(_TV_HTML)


_TV_HTML = r"""<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TULİPİ — menu</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,ital,wght@9..144,0,300;9..144,0,400;9..144,0,500;9..144,1,400&display=swap" rel="stylesheet">
<style>
*{margin:0;box-sizing:border-box}html,body{height:100%;overflow:hidden;background:#0e0b09;cursor:none;font-family:'Fraunces',serif;color:#EFE6D6}
@keyframes pgIn{from{opacity:0;transform:translateY(28px) scale(.985);filter:blur(7px)}to{opacity:1;transform:none;filter:none}}
@keyframes rowIn{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
@keyframes titleIn{from{opacity:0;transform:translateY(-18px);letter-spacing:.32em}to{opacity:1;transform:none;letter-spacing:.02em}}
@keyframes flo{0%,100%{transform:translateY(0)}50%{transform:translateY(-.7vw)}}
@keyframes halo{0%,100%{opacity:.28;transform:translate(-50%,-50%) scale(.9)}50%{opacity:.62;transform:translate(-50%,-50%) scale(1.13)}}
@keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
@keyframes sweep{0%,55%{transform:translateX(-130%) skewX(-18deg)}100%{transform:translateX(250%) skewX(-18deg)}}
@keyframes steam{0%{opacity:0;transform:translateY(.4vw) scaleY(.5)}35%{opacity:.6}100%{opacity:0;transform:translateY(-1.7vw) scaleY(1.4)}}
@keyframes bean{0%{transform:translateY(0) rotate(0);opacity:0}12%{opacity:.45}88%{opacity:.45}100%{transform:translateY(-16vh) rotate(50deg);opacity:0}}
@keyframes glow{0%,100%{transform:translate(-8%,-5%) scale(1);opacity:.45}50%{transform:translate(7%,6%) scale(1.18);opacity:.8}}
@keyframes live{0%,100%{opacity:.8}50%{opacity:1}}
@keyframes ice{0%,100%{opacity:.12;transform:translateY(0)}50%{opacity:.38;transform:translateY(-.7vw)}}
#stage{width:100vw;height:100vh;position:relative;overflow:hidden}
#dots{position:absolute;top:2.2vh;left:0;right:0;display:flex;justify-content:center;gap:.6vw;z-index:6}
#dots i{width:.55vw;height:.55vw;border-radius:50%;background:#EFE6D622;transition:.5s}#dots i.on{background:#3E8E5A;width:1.7vw;border-radius:.3vw}
.pg{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;padding:6vh 6vw;text-align:center}
.pg.cat{justify-content:flex-start;padding-top:7vh}  /* menü sayfaları yukarı sabit (kısa listede üst boşluk olmasın) */
.pg.on{display:flex;animation:pgIn .95s cubic-bezier(.2,.8,.2,1)}
.pg.on .row{animation:rowIn .55s cubic-bezier(.2,.7,.2,1) both}
.pg.on .gT{animation:titleIn .8s cubic-bezier(.2,.8,.2,1) both}
.bg{position:absolute;inset:0;overflow:hidden;z-index:0;pointer-events:none}
.drift{position:absolute;top:18%;left:28%;width:52vw;height:52vw;border-radius:50%;background:radial-gradient(circle,#2a1c12,transparent 64%);animation:glow 15s ease-in-out infinite}
.bean{position:absolute;width:.7vw;height:.5vw;border-radius:50%;border:.09vw solid #6a533a;animation:bean linear infinite}
.ring{position:absolute;top:46%;left:50%;width:30vw;height:30vw;border-radius:50%;border:1px solid #3E8E5A1f;border-top-color:#3E8E5A66;border-right-color:#3E8E5A40;animation:spin 17s linear infinite}
.halo{position:absolute;top:46%;left:50%;width:42vw;height:42vw;border-radius:50%;background:radial-gradient(circle,#1c5235,#11321f 46%,transparent 70%);animation:halo 6s ease-in-out infinite}
.logoBox{position:relative;z-index:2;overflow:hidden;border-radius:1vw}
.logo{width:22vw;display:block;mix-blend-mode:screen;opacity:0;transition:opacity .9s ease;animation:flo 6s ease-in-out infinite}
.sweep{position:absolute;top:0;left:0;width:42%;height:100%;background:linear-gradient(90deg,transparent,#ffffff2b,transparent);animation:sweep 5s ease-in-out infinite;pointer-events:none}
.steam{position:absolute;z-index:3}
.q{position:relative;z-index:2;font-style:italic;font-size:2.2vw;color:#B89B80;margin-top:2.4vh;letter-spacing:.1vw}
.gT{font-size:3.6vw;font-weight:400;font-style:italic;color:#3E8E5A;letter-spacing:.1vw;margin-bottom:.4vh}
.gH{font-size:1.1vw;letter-spacing:.4vw;color:#7d7065;margin-bottom:3vh}
.menu{width:100%;max-width:62vw}
.menu.one{max-width:40vw}
.hdr{display:grid;grid-template-columns:1fr 6vw 6vw 6vw;gap:1.4vw;font-size:1.1vw;letter-spacing:.1vw;color:#7d7065;margin-bottom:.8vh}.hdr span{text-align:center}
.row{display:grid;grid-template-columns:1fr 6vw 6vw 6vw;gap:1.4vw;align-items:baseline;padding:1.1vh 0;border-top:1px solid #ffffff0c}
.row.one{grid-template-columns:1fr auto}
.nm{font-size:1.9vw;text-align:left;white-space:nowrap}.nm small{font-size:1vw;color:#B89B80;font-style:italic;margin-left:.6vw}
.pr{font-size:1.8vw;font-weight:500;text-align:center}.pr.d{color:#ffffff22}
.ice{position:absolute;width:.5vw;height:.5vw;border-radius:50%;background:#a9dccd;animation:ice 4.5s ease-in-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(62,142,90,.45)}70%{box-shadow:0 0 0 1.5vw rgba(62,142,90,0)}100%{box-shadow:0 0 0 0 rgba(62,142,90,0)}}
.spotTag{position:relative;z-index:2;font-size:1vw;letter-spacing:.32vw;color:#3E8E5A;text-transform:uppercase}
.spotCup{position:relative;z-index:2;animation:flo 4s ease-in-out infinite;margin:1.5vh 0 .5vh}
.spotName{position:relative;z-index:2;font-size:4.2vw;font-weight:500;margin:1.2vh 0 .6vh;letter-spacing:.02vw}
.spotDesc{position:relative;z-index:2;font-size:1.5vw;color:#B89B80;font-style:italic;max-width:38vw;line-height:1.5;margin-bottom:2.6vh}
.spotPrice{position:relative;z-index:2;display:inline-block;background:#3E8E5A;color:#0e0b09;font-weight:700;font-size:2.4vw;padding:1.3vh 3.4vw;border-radius:50px;animation:pulse 2.2s infinite}
/* gerçek video arka plan — öneri & tatlı kombo sahnelerinde (sinematik, göz yormaz: opacity düşük + degrade) */
.bgvid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:.5;filter:saturate(1.25) contrast(1.1) brightness(.82)}
.bggrade{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,#0e0b09cc 0,#0e0b0966 28%,#0e0b0966 70%,#0e0b09e6 100%)}
.comboTitle{position:relative;z-index:2;font-size:3vw;font-style:italic;color:#EFE6D6;margin-top:1.2vh;text-shadow:0 .3vw 1.5vw #000}
/* FAZ 7 — Perfect Pair upsell */
.pair{position:relative;z-index:2;margin-top:2.8vh;display:flex;flex-direction:column;align-items:center;gap:.7vh;animation:pairIn 1s ease 1.1s both}
.pairTag{font-size:.85vw;letter-spacing:.32vw;color:#0e0b09;background:#B89B80;padding:.5vh 1.5vw;border-radius:40px;text-transform:uppercase}
.pairTxt{font-family:'Fraunces',serif;font-size:1.9vw;color:#EFE6D6}
.pairSub{font-size:1.1vw;color:#B89B80;font-style:italic}
@keyframes pairIn{from{opacity:0;transform:translateY(1.6vh)}to{opacity:1;transform:none}}
.foot{position:absolute;bottom:2vh;left:0;right:0;text-align:center;z-index:6}
.foot #live{font-size:1.25vw;letter-spacing:.15vw;color:#7fae93;transition:opacity .5s}
.err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7d7065;font-size:1.4vw}
/* FAZ 5 — TEK TUVAL: 3 ekran ortak sanal duvar (menü ÖNDE, dünya ARKADA) */
#wall{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.wbean{position:absolute;width:1.5vw;height:2vw;border-radius:50%;background:radial-gradient(circle at 38% 30%,#7a4a26,#3a1f0e 68%,#160b04);box-shadow:0 .2vw .5vw #00000088;opacity:0;will-change:transform,opacity,left}
.wbean::after{content:"";position:absolute;left:46%;top:14%;width:8%;height:72%;background:#160b04;border-radius:40%}
.wlight{position:absolute;top:-25%;width:46vw;height:150%;border-radius:50%;background:radial-gradient(circle,#ffe0b033,transparent 62%);filter:blur(4vw);opacity:0;transform:translateX(-50%);will-change:left,opacity}
.wsteam{position:absolute;width:7vw;height:11vw;border-radius:50%;background:radial-gradient(ellipse at 50% 68%,#ffffff,transparent 66%);filter:blur(2.2vw);opacity:0;mix-blend-mode:screen;will-change:transform,opacity,left,top}
.wchoc{position:absolute;top:-0.4vw;width:2.2vw;height:3.6vw;border-radius:0 0 45% 45%;background:linear-gradient(#3a1d0e,#160b04);box-shadow:0 .3vw .6vw #00000088;opacity:0;transform:translateX(-50%);will-change:left,opacity}
.wdrop{position:absolute;width:1vw;height:1.5vw;border-radius:50% 50% 50% 50%/38% 38% 62% 62%;background:radial-gradient(circle at 40% 28%,#6a3c1e,#160b04);box-shadow:0 0 .3vw #0006;opacity:0;will-change:transform,opacity,left,top}
/* FAZ 6 — MİKRO-SİNEMATİK takeover (her ~2.5dk, 11sn, 3 ekran triptik) */
#cine{position:absolute;inset:0;z-index:30;opacity:0;pointer-events:none;background:#000;transition:opacity 1.1s ease}
#cine.on{opacity:1}
#cine video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(1.32) contrast(1.12) brightness(1.14)}
#cine .cgrade{position:absolute;inset:0;background:linear-gradient(180deg,#0009 0,transparent 24%,transparent 72%,#000b 100%)}
#cine .ccap{position:absolute;left:0;right:0;bottom:13%;text-align:center}
#cine .ct{font-family:'Fraunces',serif;font-size:4.2vw;font-weight:500;letter-spacing:.3vw;color:#EFE6D6;text-shadow:0 .4vw 2vw #000;opacity:0;transform:translateY(2.2vh);transition:.9s ease .35s}
#cine .cs{font-size:1.4vw;letter-spacing:.55vw;color:#5fbf86;text-transform:uppercase;opacity:0;transform:translateY(2vh);transition:.9s ease .6s}
#cine.on .ct,#cine.on .cs{opacity:1;transform:none}
#season{position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden}
/* FAZ 8 — zaman atmosferi (saat renk sıcaklığı, kenar-ağırlıklı → menü merkezi temiz) */
#tod{position:absolute;inset:0;pointer-events:none;z-index:2;opacity:.55;transition:background 4s ease,opacity 4s ease;mix-blend-mode:soft-light}
#tod.sabah{background:linear-gradient(180deg,#bfe3ff66,transparent 45%)}
#tod.ogle{background:radial-gradient(120% 70% at 50% 0%,#ffe9c255,transparent 60%)}
#tod.aksam{background:linear-gradient(0deg,#ff8a3d66,transparent 50%)}
#tod.gece{background:radial-gradient(120% 100% at 50% 60%,#13204d77,transparent 70%)}
/* FAZ 8 — Today's Favorite rozeti */
#fav{position:absolute;top:2.3vh;right:2.6vw;z-index:6;display:none;align-items:center;gap:.5vw;background:#3E8E5A22;border:1px solid #3E8E5A55;color:#cfe8d8;padding:.6vh 1.3vw;border-radius:40px;font-size:1vw;letter-spacing:.08vw}
#fav.on{display:flex}
#fav b{color:#EFE6D6;font-family:'Fraunces',serif;font-weight:500;margin-left:.3vw}
#season span{position:absolute;top:-10vh;animation:sfall linear infinite;will-change:transform}
@keyframes sfall{0%{transform:translateY(-10vh) translateX(0) rotate(0)}100%{transform:translateY(112vh) translateX(5vw) rotate(220deg)}}
/* 🎬 COFFEE STORY — sinematik ara sahne (çekirdek→espresso→latte art→fincanda doğan fiyat) */
.pg.story{background:#050302}
.pg.story.on{animation:none}
.story .stsc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
/* GERÇEK VİDEO sahneleri (crossfade): çekirdek → latte art → buharlı fincan */
.story .vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:0;filter:saturate(1.32) contrast(1.12) brightness(1.14)}
.story .v1{animation:csVid1 18s ease-in-out infinite}
.story .v2{animation:csVid2 18s ease-in-out infinite}
.story .v3{animation:csVid3 18s ease-in-out infinite}
/* sinematik katmanlar: bokeh derinlik + renklendirme/letterbox + film grain */
.story .bok{position:absolute;border-radius:50%;filter:blur(3.4vw);pointer-events:none;mix-blend-mode:screen;opacity:.5}
.story .grade{position:absolute;inset:0;z-index:6;pointer-events:none;background:linear-gradient(180deg,#0009 0,transparent 22%,transparent 74%,#000b 100%)}
.story .grain{position:absolute;inset:-25%;z-index:8;pointer-events:none;opacity:.07;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");background-size:150px 150px;animation:csGrain .5s steps(3) infinite}
.story .stTag{align-items:flex-start;padding-top:5vh;font-size:1vw;letter-spacing:.7vw;color:#3E8E5A;z-index:7;animation:csTag 22s linear infinite}
.story .stBean{animation:csBean 22s ease-in-out infinite}
.story .stPour{opacity:0;animation:csPour 22s ease-in-out infinite}
.story .stCrema{opacity:0;animation:csCrema 22s ease-in-out infinite}
.story .cremaC{width:60vh;height:60vh;border-radius:50%;position:relative;overflow:hidden;background:radial-gradient(circle at 37% 27%,#c5894f 0%,#9a5a30 20%,#683a1d 47%,#3a200f 77%,#1a0d05 100%);box-shadow:inset 0 0 12vh #000000b0,inset 0 1.4vh 3vh #ffffff22,0 3vh 9vh #000a}
.story .cremaTex{position:absolute;inset:0;opacity:.45;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='m'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.05' numOctaves='3'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23m)'/%3E%3C/svg%3E");background-size:cover}
.story .cremaHi{position:absolute;top:-8%;left:-4%;width:62%;height:60%;border-radius:50%;background:radial-gradient(circle,#ffe6c2cc,transparent 62%);filter:blur(2.6vw)}
.story .stBub{opacity:0;animation:csBub 22s ease-in-out infinite}
.story .stArt{opacity:0;animation:csArt 22s ease-in-out infinite}
.story .artBase{width:60vh;height:60vh;border-radius:50%;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(circle at 37% 28%,#b07a48,#6a3c1e 50%,#2f1a0c 100%);box-shadow:inset 0 0 12vh #000000b0,0 3vh 9vh #000a}
.story .milk{filter:drop-shadow(0 .3vw .6vw #00000055) blur(.25vw)}
.story .steamW{z-index:3;align-items:flex-end;padding-bottom:16vh;filter:blur(.5vw);opacity:0;animation:csSteamWin 22s ease-in-out infinite}
.story .stPriceWrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:5;opacity:0;animation:csPrice 22s ease-in-out infinite}
.story .stpn{font-size:6vw;letter-spacing:.5vw;color:#EFE6D6;text-transform:uppercase;text-shadow:0 .4vw 2.5vw #000,0 0 4vw #00000088}
.story .stpl{width:5vw;height:1px;background:#3E8E5A;margin:2.2vh 0;box-shadow:0 0 1vw #3E8E5A}
.story .stpp{font-size:4.6vw;font-weight:600;color:#5fbf86;text-shadow:0 0 3.5vw #3E8E5A99,0 0 1.2vw #3E8E5Acc}
/* sahne ritmi: belir → BEKLE (net, Ken Burns yavaş zoom) → kaybol. blur YOK. */
@keyframes csGrain{0%{background-position:0 0}33%{background-position:-80px 50px}66%{background-position:70px -60px}100%{background-position:-50px -40px}}
@keyframes csVid1{0%{opacity:0}5%{opacity:1}30%{opacity:1}38%{opacity:0}100%{opacity:0}}
@keyframes csVid2{0%,34%{opacity:0}42%{opacity:1}62%{opacity:1}70%{opacity:0}100%{opacity:0}}
@keyframes csVid3{0%,66%{opacity:0}74%{opacity:1}100%{opacity:1}}
@keyframes csBok1{0%,100%{transform:translate(0,0) scale(1)}50%{transform:translate(4vw,3vh) scale(1.15)}}
@keyframes csBok2{0%,100%{transform:translate(0,0) scale(1.1)}50%{transform:translate(-3vw,-2vh) scale(1)}}
@keyframes csWisp{0%{opacity:0;transform:translateY(2vh) scaleY(.7)}40%{opacity:.5}100%{opacity:0;transform:translateY(-5vh) scaleY(1.3)}}
@keyframes csSteamWin{0%,40%{opacity:0}48%{opacity:1}80%{opacity:1}84%{opacity:0}100%{opacity:0}}
@keyframes csTag{0%,4%{opacity:0}9%,87%{opacity:.55}93%,100%{opacity:0}}
@keyframes csBean{0%{opacity:0;transform:scale(.34) rotate(-10deg)}7%{opacity:1;transform:scale(.52) rotate(-4deg)}16%{opacity:1;transform:scale(.66) rotate(3deg)}21%{opacity:0;transform:scale(.72) rotate(5deg)}100%{opacity:0}}
@keyframes csPour{0%,17%{opacity:0;transform:translateY(-3vh) scale(.96)}24%{opacity:1;transform:translateY(0) scale(1)}35%{opacity:1;transform:scale(1.04)}40%{opacity:0}100%{opacity:0}}
@keyframes csCrema{0%,35%{opacity:0;transform:scale(.84)}43%{opacity:1;transform:scale(1)}56%{opacity:1;transform:scale(1.08)}61%{opacity:0;transform:scale(1.11)}100%{opacity:0}}
@keyframes csBub{0%,40%{opacity:0}48%{opacity:.5}55%{opacity:0}100%{opacity:0}}
@keyframes csArt{0%,53%{opacity:0;transform:scale(.9)}61%{opacity:1;transform:scale(1)}79%{opacity:1;transform:scale(1.05)}84%{opacity:0;transform:scale(1.08)}100%{opacity:0}}
@keyframes csPrice{0%,79%{opacity:0;transform:translateY(2.6vh) scale(.96)}87%{opacity:1;transform:translateY(0) scale(1)}97%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0}}
</style></head>
<body><div id="stage">
<div class="bg" id="bg"><div class="drift"></div></div>
<div id="tod"></div>
<div id="wall"></div>
<div id="season"></div>
<div id="fav"></div>
<div id="dots"></div>
<div class="foot"><span id="live">TÜM FİYATLAR TL · TULİPİ COFFEE</span></div>
<div id="cine"><video muted loop playsinline preload="auto"></video><div class="cgrade"></div><div class="ccap"><div class="ct"></div><div class="cs"></div></div></div></div>
<script>
var API="/api/tv-menu", SIG="/api/tv-signals", CACHE="tulipi_tv_menu";
function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
function priceRow(u,three,i){
  var dly=' style="animation-delay:'+(0.18+(i||0)*0.055).toFixed(2)+'s"';
  if(three){
    function cell(v){return '<span class="pr'+(v==null?' d':'')+'">'+(v==null?'–':v)+'</span>';}
    return '<div class="row"'+dly+'><span class="nm">'+u.ad+(u.aciklama?'<small>'+u.aciklama+'</small>':'')+'</span>'+cell(u.f8)+cell(u.f14)+cell(u.fice)+'</div>';
  }
  var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);
  return '<div class="row one"'+dly+'><span class="nm">'+u.ad+'</span><span class="pr">'+(v==null?'–':v)+'</span></div>';
}
function storyProduct(data){
  if(window._encok&&window._encok.ad)return window._encok;            // günün ürünü (Evo en-çok) öncelikli
  if(data.imza&&data.imza.ad&&data.imza.fiyat!=null)return {ad:data.imza.ad,fiyat:data.imza.fiyat};
  var found=null,first=null;
  (data.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);
    if(v!=null){if(!first)first={ad:u.ad,fiyat:v};if(/latte/i.test(u.ad)&&!found)found={ad:u.ad,fiyat:v};}
  });});
  return found||first||{ad:"COFFEE",fiyat:null};
}
function findPrice(name){var r=null;if(!window._tvData||!name)return null;
  (window._tvData.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(name).toLowerCase()){var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);if(v!=null)r=v;}});});
  return r;}
function buildStory(data){
  var sp=storyProduct(data);window._story=sp;
  var st=el("div","pg story");st.dataset.t=18000;st.dataset.roles="2";
  function vid(cls,src){return '<video class="vid '+cls+'" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+src+'"></video>';}
  st.innerHTML=vid("v1","bean")+vid("v2","latte")+vid("v3","cup")
    +'<div class="grade"></div><div class="grain"></div>'
    +'<div class="stPriceWrap"><div class="stpn" id="storyName">'+sp.ad+'</div><div class="stpl"></div><div class="stpp" id="storyPrice">'+(sp.fiyat!=null?sp.fiyat+' TL':'')+'</div></div>'
    +'<div class="stsc stTag">TULİPİ · COFFEE STORY</div>';
  // PERF: SADECE görünen videoyu oynat, gizlileri duraklat (3 decode→1 → donma/takılma biter)
  Array.prototype.forEach.call(st.querySelectorAll("video"),function(v){v.muted=true;});
  clearInterval(window._storyVidInt);
  window._storyVidInt=setInterval(function(){
    Array.prototype.forEach.call(st.querySelectorAll("video"),function(v){
      var op=parseFloat(getComputedStyle(v).opacity)||0;
      if(op>0.06){ if(v.paused){var p=v.play();if(p&&p.catch)p.catch(function(){});} }
      else if(!v.paused){ try{v.pause();}catch(e){} }
    });
  },450);
  return st;
}
function build(data,sig){
  window._tvData=data;
  var stage=document.getElementById("stage");
  Array.prototype.slice.call(stage.querySelectorAll(".pg")).forEach(function(p){p.remove()});
  var dots=document.getElementById("dots");dots.innerHTML="";
  var pages=[];
  // Hero — dönen halka + shimmer + buhar
  var hero=el("div","pg");hero.dataset.t=6000;hero.dataset.roles="1,2,3";
  hero.appendChild(el("div","ring"));
  hero.appendChild(el("div","halo"));
  var img=el("img","logo");img.alt="TULİPİ";img.onload=function(){img.style.opacity=1;};hero.appendChild(img);img.src="/tv-menu/logo";if(img.complete)img.style.opacity=1;
  var steam=el("div","steam");steam.style.zIndex=3;
  steam.innerHTML='<svg width="6vw" viewBox="0 0 60 40"><g fill="none" stroke="#EFE6D6" stroke-width="1.4" stroke-linecap="round"><path d="M22 34 q-3 -7 1 -13" style="animation:steam 3s ease-in-out infinite"/><path d="M31 33 q3 -7 -1 -13" style="animation:steam 3s ease-in-out 1s infinite"/><path d="M40 34 q-3 -7 1 -13" style="animation:steam 3s ease-in-out 2s infinite"/></g></svg>';
  hero.appendChild(el("div","q","Crafted Every Day"));
  pages.push(hero);
  // 🎬 COFFEE STORY — sinematik ara sahne (her döngüde günün ürünü fincanda doğar)
  pages.push(buildStory(data));
  // İMZA SPOTLIGHT — panelden seçilen öne çıkan ürün (float + buhar + nabız fiyat)
  if(data.imza && data.imza.ad){
    var sp=el("div","pg");sp.dataset.t=10000;sp.dataset.roles="2,3";
    sp.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/froth"></video><div class="bggrade"></div>';
    sp.appendChild(el("div","halo"));
    var cup='<svg width="14vw" viewBox="0 0 200 200" style="width:14vw;height:14vw">'
      +'<g fill="none" stroke="#B89B80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
      +'<ellipse cx="100" cy="158" rx="58" ry="9"/><ellipse cx="100" cy="110" rx="40" ry="9"/>'
      +'<path d="M62 110 Q66 146 100 148 Q134 146 138 110"/><path d="M138 118 Q164 120 159 138 Q157 149 141 146"/></g>'
      +'<ellipse cx="100" cy="110" rx="36" ry="7.5" fill="#0e0b09"/>'
      +'<g fill="none" stroke="#3E8E5A" stroke-width="1.5" stroke-linecap="round" opacity=".95"><path d="M100 104 V117 M100 107 q-9 2 -14 6 M100 107 q9 2 14 6 M100 111 q-6 3 -10 6 M100 111 q6 3 10 6"/></g>'
      +'<g fill="none" stroke="#EFE6D6" stroke-width="1.5" stroke-linecap="round">'
      +'<path d="M86 100 q-4 -8 1 -15" style="animation:steam 3s ease-in-out infinite"/>'
      +'<path d="M100 98 q4 -9 -1 -17" style="animation:steam 3s ease-in-out 1s infinite"/>'
      +'<path d="M114 100 q-4 -8 1 -15" style="animation:steam 3s ease-in-out 2s infinite"/></g></svg>';
    var inner='<div class="spotTag">Bugünün İmzası</div><div class="spotCup">'+cup+'</div>'
      +'<div class="spotName">'+data.imza.ad+'</div>'
      +(data.imza.aciklama?'<div class="spotDesc">'+data.imza.aciklama+'</div>':'')
      +(data.imza.fiyat!=null?'<div class="spotPrice">'+data.imza.fiyat+' TL</div>':'')
      +((data.pair&&data.pair.ad)?'<div class="pair"><span class="pairTag">PERFECT PAIR</span>'
        +'<span class="pairTxt">+ '+data.pair.ad+(data.pair.fiyat!=null?' · '+data.pair.fiyat+' TL':'')+'</span>'
        +(data.pair.mesaj?'<span class="pairSub">'+data.pair.mesaj+'</span>':'')+'</div>':'');
    sp.innerHTML+=inner;
    pages.push(sp);
  }
  // Kategoriler
  (data.kategoriler||[]).forEach(function(k){
    var three=k.urunler.some(function(u){return u.f14!=null||u.fice!=null;});
    var pg=el("div","pg cat");pg.dataset.t=12000;pg.dataset.roles="1,3";
    pg.appendChild(el("div","gT",k.kategori));
    if(k.alt)pg.appendChild(el("div","gH",k.alt));
    var m=el("div","menu"+(three?"":" one"));
    if(three)m.innerHTML='<div class="hdr"><span style="text-align:left"></span><span>8oz</span><span>14oz</span><span>ICE</span></div>';
    m.innerHTML+=k.urunler.map(function(u,i){return priceRow(u,three,i);}).join("");
    pg.appendChild(m);
    if(/(iced|cold|so.uk)/i.test(k.kategori)){for(var i=0;i<10;i++){var s=el("span","ice");s.style.left=(8+Math.random()*84)+"%";s.style.top=(22+Math.random()*54)+"%";s.style.animationDelay=(Math.random()*4.5)+"s";pg.appendChild(s);}}
    pages.push(pg);
  });
  // 💡 ÖNERİ SAHNESİ — az satılan ama saate/mevsime uygun vitrin ürünü, ayrı slayt (en-çok'tan ayrı)
  // Gerçek video arka plan: Mocktail/Milkshake → soğuk içecek görüntüsü, diğerleri → demleme/buhar görüntüsü
  if(sig && sig.oneri && sig.oneri.ad){
    var op=findPrice(sig.oneri.ad);if(op==null)op=sig.oneri.fiyat;
    var os=el("div","pg");os.dataset.t=9000;os.dataset.roles="2,3";
    var clip=/(mocktail|milkshake)/i.test(sig.oneri.kategori||"")?"cold":"brew";
    os.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+clip+'"></video><div class="bggrade"></div>';
    os.innerHTML+='<div class="spotTag">💡 '+(sig.oneri.neden||"Bugün Dene")+'</div>'
      +'<div class="spotName">'+sig.oneri.ad+'</div>'
      +(sig.oneri.kategori?'<div class="spotDesc">'+sig.oneri.kategori+'</div>':'')
      +(op!=null?'<div class="spotPrice">'+op+' TL</div>':'');
    pages.push(os);
  }
  // 🍰 TATLI KOMBO — kahve+tatlı eşleşmesi, gerçek video arka plan (Perfect Pair varsa onu vurgular)
  var combo=el("div","pg");combo.dataset.t=9000;combo.dataset.roles="2,3";
  combo.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/dessert"></video><div class="bggrade"></div>'
    +'<div class="spotTag">PERFECT PAIR</div>'
    +'<div class="spotName">'+((data.pair&&data.pair.ad)?data.pair.ad:"Kahve + Tatlı")+'</div>'
    +'<div class="comboTitle">Birlikte daha güzel</div>'
    +((data.pair&&data.pair.fiyat!=null)?'<div class="spotPrice">'+data.pair.fiyat+' TL</div>':'');
  pages.push(combo);
  // 🔥 EN ÇOK TERCİH EDİLEN — top 3, ayrı sahne (öneriyle karışmaz, gerçek satış sırası)
  if(sig && sig.top3 && sig.top3.length){
    var t3=el("div","pg cat");t3.dataset.t=9000;t3.dataset.roles="1,2,3";
    t3.appendChild(el("div","gT","Bugün En Çok Tercih Edilen"));
    var medals=["🥇","🥈","🥉"];
    var m3=el("div","menu one");
    m3.innerHTML=sig.top3.map(function(it,i){
      return '<div class="row one" style="animation-delay:'+(0.18+i*0.1).toFixed(2)+'s"><span class="nm">'+(medals[i]||"")+' '+it.ad+'</span></div>';
    }).join("");
    t3.appendChild(m3);
    pages.push(t3);
  }
  // FAZ 4 — 3 EKRAN MODU: ?ekran=1 MENÜ · ?ekran=2 DENEYİM(video) · ?ekran=3 MARKA+CANLI
  var ekran=(new URLSearchParams(location.search)).get("ekran");
  if(ekran){var f=pages.filter(function(p){return (p.dataset.roles||"").split(",").indexOf(ekran)>=0;});if(f.length)pages=f;}
  pages.forEach(function(p){stage.insertBefore(p,document.querySelector(".foot"));dots.appendChild(el("i"));});
  var di=dots.children,idx=0;
  function show(i){pages.forEach(function(p,k){p.classList.toggle("on",k===i);di[k].classList.toggle("on",k===i);});
    var fv=document.getElementById("fav");if(fv)fv.classList.toggle("on",!!(window._favName&&pages[i]&&pages[i].classList.contains("cat")));}
  // EKRAN SENKRONU — wall-clock: tüm TV'ler ortak saate göre döner (sürüklenme yok, reload sıçramaz, aynı rol senkron)
  function syncShow(){
    var durs=pages.map(function(p){return parseInt(p.dataset.t,10)||9000;});
    var total=durs.reduce(function(a,b){return a+b;},0)||1;
    var t=Date.now()%total,acc=0,i=0;
    for(var k=0;k<durs.length;k++){if(t<acc+durs[k]){i=k;break;}acc+=durs[k];}
    show(i);clearTimeout(window._tvt);window._tvt=setTimeout(syncShow,(acc+durs[i]-t)+40);
  }
  if(pages.length)syncShow();
}
function load(){
  Promise.all([
    fetch(API).then(function(r){return r.json();}),
    fetch(SIG).then(function(r){return r.json();}).catch(function(){return null;})
  ]).then(function(arr){
    var d=arr[0],s=arr[1];
    if(d&&d.kategoriler&&d.kategoriler.length){
      localStorage.setItem(CACHE,JSON.stringify(d));
      localStorage.setItem(CACHE+"_sig",JSON.stringify(s||{}));
      build(d,s);
    }else throw 0;
  }).catch(function(){
    var c=localStorage.getItem(CACHE),cs=localStorage.getItem(CACHE+"_sig");
    if(c){build(JSON.parse(c),cs?JSON.parse(cs):null);}
    else{document.getElementById("stage").insertBefore(el("div","err","Menü yükleniyor…"),document.querySelector(".foot"));}
  });
}
// Ambient — uçuşan kahve çekirdekleri
(function beans(){var bg=document.getElementById("bg");if(!bg)return;for(var i=0;i<14;i++){var b=document.createElement("span");b.className="bean";b.style.left=(Math.random()*100)+"%";b.style.bottom=(Math.random()*8)+"%";var d=10+Math.random()*10;b.style.animationDuration=d+"s";b.style.animationDelay=(-Math.random()*d)+"s";bg.appendChild(b);}})();
load();
setInterval(load,60000);
// FAZ 2 — yaşayan menü canlı şeridi (saat-modu / en-çok / yeni / happy hour)
var liveArr=["TÜM FİYATLAR TL · TULİPİ COFFEE"], liveI=0;
function loadSig(){fetch(SIG).then(function(r){return r.json();}).then(function(s){
  if(s&&s.seritler&&s.seritler.length){liveArr=s.seritler.concat(["TÜM FİYATLAR TL"]);}
  // Günün ürünü (Evo en-çok) story sahnesindeki "fincanda doğan fiyat"ı besler
  if(s&&s.en_cok){var pp=findPrice(s.en_cok);
    if(pp!=null){window._encok={ad:s.en_cok,fiyat:pp};
      var nm=document.getElementById("storyName"),pe=document.getElementById("storyPrice");
      if(nm){nm.textContent=s.en_cok;pe.textContent=pp+" TL";}}}
  // FAZ 3 mevsim DÜŞEN YILDIZ efekti kaldırıldı (kullanıcı: gereksiz). Mevsim bilgisi alt şeritte kalır.
  if(s&&s.saat_modu)applyTimeOfDay(s.saat_modu.mod);       // FAZ 8 — zaman atmosferi
  updateFav(s&&s.en_cok);                                  // FAZ 8 — Today's Favorite
}).catch(function(){});}
function applyTimeOfDay(mod){var e=document.getElementById("tod");if(!e)return;e.className="";if(mod)e.classList.add(mod);}
function updateFav(name){window._favName=name||"";var e=document.getElementById("fav");if(!e)return;if(name){e.innerHTML="⭐ Today's Favorite<b>"+name+"</b>";}var on=document.querySelector(".pg.on");e.classList.toggle("on",!!(name&&on&&on.classList.contains("cat")));}
// MEVSİM GÖRSELİ — kış kar / sonbahar yaprak / ilkbahar çiçek / yaz serin parıltı
function applySeason(ad){
  var box=document.getElementById("season");if(!box||box.dataset.s===ad)return;box.dataset.s=ad;box.innerHTML="";
  var g={kis:"❄",sonbahar:"🍂",ilkbahar:"🌸",yaz:"✦"}[ad];if(!g)return;
  var n=ad==="yaz"?9:18;
  for(var i=0;i<n;i++){var s=document.createElement("span");s.textContent=g;
    s.style.left=(Math.random()*100)+"%";var d=7+Math.random()*9;
    s.style.animationDuration=d+"s";s.style.animationDelay=(-Math.random()*d)+"s";
    s.style.fontSize=(1+Math.random()*1.7)+"vw";
    s.style.opacity=ad==="yaz"?0.35:0.6;if(ad==="yaz")s.style.color="#a9dccd";
    box.appendChild(s);}
}
function rotLive(){var e=document.getElementById("live");if(!e||liveArr.length<2)return;
  e.style.opacity=0;setTimeout(function(){liveI=(liveI+1)%liveArr.length;e.textContent=liveArr[liveI];e.style.opacity=1;},500);}
loadSig();setInterval(loadSig,60000);setInterval(rotLive,7000);
// FAZ 5 — TEK TUVAL motoru: 3 ekran ortak sanal duvar (wall-clock + deterministik → bezel kaybolur)
(function wall(){
  var box=document.getElementById("wall");if(!box||window._wallInit)return;window._wallInit=1;
  var ek=(new URLSearchParams(location.search)).get("ekran");
  var N=ek?3:1, SI=ek?Math.max(0,parseInt(ek,10)-1):0, SPAN=N+1;
  function rnd(s){s=Math.sin(s*127.1+311.7)*43758.5453;return s-Math.floor(s);}
  var beans=[];
  for(var i=0;i<N*2;i++){
    var el=document.createElement("div");el.className="wbean";box.appendChild(el);
    var depth=rnd(i*2+1);
    beans.push({el:el,y:6+rnd(i*2+3)*80,depth:depth,v:0.02+rnd(i*2+5)*0.03,ph:rnd(i*2+7)*SPAN,
      sz:(N>1?0.8:1)+(1-depth)*1.4,rs:(rnd(i*2+9)-0.5)*30});
  }
  var light=document.createElement("div");light.className="wlight";box.appendChild(light);
  // BUHAR — ekranlar arası süzülen + yükselen kolonlar (bezeli geçer)
  var steam=[];
  for(var j=0;j<N+1;j++){
    var se=document.createElement("div");se.className="wsteam";box.appendChild(se);
    steam.push({el:se,vh:0.008+rnd(j*3+2)*0.012,ph:rnd(j*3+4)*SPAN,vr:0.05+rnd(j*3+6)*0.05,cph:rnd(j*3+8),sw:0.8+rnd(j*3+9)*0.9});
  }
  // ÇİKOLATA — duvar boyunca yavaş gezen kaynak + düşen damla (ekran 3→2→1 sürer)
  var choc=document.createElement("div");choc.className="wchoc";box.appendChild(choc);
  var drop=document.createElement("div");drop.className="wdrop";box.appendChild(drop);
  function frame(){
    var t=Date.now()/1000;
    for(var i=0;i<beans.length;i++){var b=beans[i];
      var lx=((b.ph+t*b.v)%SPAN)-SI;
      if(lx<-0.25||lx>1.25){b.el.style.opacity=0;continue;}
      b.el.style.left=(lx*100)+"%";b.el.style.top=b.y+"%";
      b.el.style.opacity=(0.24+(1-b.depth)*0.4).toFixed(2);
      b.el.style.filter="blur("+(b.depth*0.8).toFixed(2)+"vw)";
      b.el.style.transform="translate(-50%,-50%) scale("+b.sz.toFixed(2)+") rotate("+((t*b.rs)%360).toFixed(0)+"deg)";
    }
    var llx=((t*0.025)%SPAN)-SI;
    light.style.left=(llx*100)+"%";light.style.opacity=(llx>-0.4&&llx<1.4)?0.5:0;
    // buhar
    for(var k=0;k<steam.length;k++){var s=steam[k];
      var slx=((s.ph+t*s.vh)%SPAN)-SI;
      if(slx<-0.3||slx>1.3){s.el.style.opacity=0;continue;}
      var cyc=((t*s.vr+s.cph)%1);
      s.el.style.left=(slx*100)+"%";s.el.style.top=(78-cyc*64)+"%";
      s.el.style.opacity=(Math.sin(cyc*3.14159)*0.27).toFixed(3);
      s.el.style.transform="translate(-50%,-50%) scale("+(s.sw*(0.6+cyc*0.9)).toFixed(2)+")";
    }
    // çikolata gezen kaynak + düşen damla
    var clx=((t*0.014)%SPAN)-SI;
    if(clx>-0.2&&clx<1.2){choc.style.left=(clx*100)+"%";choc.style.opacity=0.85;
      var dcyc=((t*0.35)%1);
      drop.style.left=(clx*100)+"%";drop.style.top=(3.5+dcyc*96)+"%";
      drop.style.opacity=(dcyc<0.92?0.85*(dcyc<0.08?dcyc*12.5:1):0).toFixed(2);
      drop.style.transform="translate(-50%,0) scale("+(1-dcyc*0.3).toFixed(2)+")";
    }else{choc.style.opacity=0;drop.style.opacity=0;}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
// FAZ 6 — MİKRO-SİNEMATİK: her ~2.5dk menüyü duraklat, 11sn sinematik (wall-clock senkron, 3 ekran triptik)
(function cine(){
  var c=document.getElementById("cine");if(!c||window._cineInit)return;window._cineInit=1;
  var ek=(new URLSearchParams(location.search)).get("ekran");
  var CYCLE=150, DUR=11, names=["bean","latte","cup"];
  var caps={bean:["TAZE KAVRULDU","Freshly Roasted"],latte:["LATTE ART","El Yapımı"],cup:["SICACIK","Freshly Brewed"]};
  var vid=c.querySelector("video"),ct=c.querySelector(".ct"),cs=c.querySelector(".cs"),active=false,curName="";
  function pick(occ){return ek?names[Math.max(0,parseInt(ek,10)-1)%3]:names[occ%3];}
  if(ek){curName=pick(0);vid.src="/tv-menu/clip/"+curName;}
  function tick(){
    var now=Date.now()/1000,inWin=(now%CYCLE)<DUR,name=pick(Math.floor(now/CYCLE));
    if(inWin&&!active){active=true;
      if(curName!==name){curName=name;vid.src="/tv-menu/clip/"+name;}
      ct.textContent=caps[name][0];cs.textContent=caps[name][1];
      c.classList.add("on");vid.muted=true;try{vid.currentTime=0;}catch(e){}
      var p=vid.play();if(p&&p.catch)p.catch(function(){});
    }else if(!inWin&&active){active=false;c.classList.remove("on");
      setTimeout(function(){try{vid.pause();}catch(e){}},1300);}
    setTimeout(tick,500);
  }
  tick();
})();
</script></body></html>"""
