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


# FAZ — ANALYTICS ENGINE (Adım 1: Gösterim Sayacı). İZOLE tablo, kendi ensure
# fonksiyonu, hata-yutar (TV ekranı log atamazsa bile sahne akışı asla bozulmaz).
_GOSTERIM_TABLO_HAZIR = False


def _ensure_gosterim_tablo(cur):
    global _GOSTERIM_TABLO_HAZIR
    if _GOSTERIM_TABLO_HAZIR:
        return
    cur.execute(
        """CREATE TABLE IF NOT EXISTS tv_gosterim (
            id TEXT PRIMARY KEY,
            ts TIMESTAMPTZ DEFAULT NOW(),
            ekran TEXT,
            sahne TEXT,
            urun_ad TEXT
        )"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tv_gosterim_ts ON tv_gosterim (ts)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tv_gosterim_urun ON tv_gosterim (urun_ad)")
    _GOSTERIM_TABLO_HAZIR = True


class GosterimModel(BaseModel):
    ekran: Optional[str] = None
    sahne: Optional[str] = None
    urun_ad: Optional[str] = None


@router.post("/api/tv-gosterim")
def tv_gosterim_log(g: GosterimModel):
    """Bir sahne TV'de gerçekten gösterildiğinde frontend bunu loglar (fire-and-forget).
    Analytics Engine'in temeli: hangi ürün hangi sahnede, hangi ekranda, ne zaman gösterildi."""
    if not (g.urun_ad or "").strip():
        return {"success": False, "neden": "urun_ad yok"}
    try:
        with db() as (conn, cur):
            _ensure_gosterim_tablo(cur)
            cur.execute(
                "INSERT INTO tv_gosterim (id,ekran,sahne,urun_ad) VALUES (%s,%s,%s,%s)",
                (str(uuid.uuid4()), (g.ekran or "").strip() or None, (g.sahne or "").strip() or None, g.urun_ad.strip()),
            )
        return {"success": True}
    except Exception as e:
        logger.warning("tv-gosterim log hata: %s", e)
        return {"success": False}


@router.get("/api/tv-gosterim/ozet")
def tv_gosterim_ozet(gun: int = 7):
    """Son N günde ürün başına gösterim sayısı — Analytics Engine'in ilk raporu.
    Sonraki adım (attribution): bunu Evo satış verisiyle ilişkilendirmek."""
    from datetime import timedelta
    try:
        with db() as (conn, cur):
            _ensure_gosterim_tablo(cur)
            bas = datetime.now() - timedelta(days=max(1, gun))
            cur.execute(
                """SELECT urun_ad, sahne, COUNT(*) AS n FROM tv_gosterim
                   WHERE ts >= %s AND urun_ad IS NOT NULL
                   GROUP BY urun_ad, sahne ORDER BY n DESC""",
                (bas,),
            )
            rows = [dict(r) for r in (cur.fetchall() or [])]
        toplam = {}
        for r in rows:
            toplam[r["urun_ad"]] = toplam.get(r["urun_ad"], 0) + r["n"]
        return {
            "gun": gun,
            "toplam_gosterim": sorted([{"urun_ad": k, "adet": v} for k, v in toplam.items()], key=lambda x: -x["adet"]),
            "detay_sahne": rows,
        }
    except Exception as e:
        logger.warning("tv-gosterim ozet hata: %s", e)
        return {"gun": gun, "toplam_gosterim": [], "detay_sahne": []}


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


def _en_cok(ayar, top3=None):
    """Manuel öne çıkan öncelikli; oto açıksa top3 (_satis_30gun) İLE AYNI veri kaynağı kullanılır.
    ÖNEMLİ: Eskiden burada ayrı bir 'bugün' Evo çekimi vardı — top3 ile FARKLI pencere kullandığı
    için iki ekranda çelişen 'en çok satan' bilgisi gösterilebiliyordu (Ekran2 vs Ekran1 Top-3).
    Artık TEK kaynak: top3[0]. Aynı veri, farklı ekranlarda farklı sunum — asla çelişmez."""
    manuel = (ayar.get("one_cikan") or "").strip()
    if manuel:
        return manuel
    if str(ayar.get("one_cikan_oto") or "") == "1" and top3:
        return top3[0]["ad"]
    return None


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


def _top3(satis, rows=None):
    """Bugün/son 30 günde en çok tercih edilen 3 ürün — SADECE TV menüsünde gösterilen
    ürünler arasından (Su/Çay gibi menüde olmayan jenerik kalemler hariç, gösterişli+anlamlı kalsın)."""
    if rows:
        norm = lambda s: re.sub(r"\s+", " ", str(s).strip().lower())
        menu_adlari = {norm(r["ad"]) for r in rows}
        satis = {a: c for a, c in satis.items() if norm(a) in menu_adlari}
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
    satis = _satis_30gun()
    top3 = _top3(satis, rows)
    en_cok = _en_cok(ayar, top3)
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


@router.get("/tv-menu/cup/{name}")
def tv_menu_cup(name: str):
    """Gerçek TULİPİ bardak fotoğrafları — imza silüet (her sahnede aynı kare, marka hafızası).
    Prod: Vite public/ -> static/'ye kopyalar. Dev: public/tv veya src/assets/tv."""
    if name not in ("hot", "iced", "mocktail"):
        raise HTTPException(404, "bardak yok")
    eski = {"hot": "cup_hot_green.jpeg", "iced": "cup_iced_latte.jpeg", "mocktail": "cup_mocktail_green.jpeg"}[name]
    for p in (
        os.path.join("static/tv", "cup_" + name + ".jpeg"),
        os.path.join("public/tv", "cup_" + name + ".jpeg"),
        os.path.join("src/assets/tv", eski),
    ):
        if os.path.exists(p):
            return FileResponse(p, media_type="image/jpeg")
    raise HTTPException(404, "bardak dosyası yok")


@router.get("/tv-menu/clip/{name}")
def tv_menu_clip(name: str):
    """Coffee Story gerçek video klipleri (Mixkit Free, ticari kullanım serbest)."""
    if name not in ("dessert", "mocktail", "lifestyle", "craft", "musteri",
                     "espresso", "greenmocktail", "frozen", "kahverengi"):
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
.steam{position:absolute;z-index:3}
/* KÖŞE LOGO — sürekli görünen sabit rozet, artık ayrı bir "Hero" sahnesi yok */
#logoBadge{position:absolute;top:2.2vh;left:2.6vw;z-index:7;width:6vh;opacity:.88;pointer-events:none}
/* GOLDEN TRIANGLE — fiyat/ürün hep aynı sabit köşede (göz "ürün→fiyat" yörüngesini öğrenir) */
#priceCorner{position:absolute;top:2.2vh;right:2.6vw;z-index:7;display:none;flex-direction:column;align-items:flex-end;text-align:right;transition:opacity .4s ease}
#priceCorner.on{display:flex}
#priceCorner .pcName{font-size:1.7vh;color:#B89B80;font-style:italic;letter-spacing:.03vw;max-width:30vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#priceCorner .pcPrice{font-size:2.6vh;font-weight:700;color:#3E8E5A}
/* BARDAK AÇILIŞ — ilk 3sn sade gerçek bardak fotoğrafı (Ken Burns yavaş zoom), metin/fiyat sonra belirir */
@keyframes kenBurns{0%{transform:scale(1.04)}100%{transform:scale(1.16)}}
@keyframes bardakReveal{0%,38%{opacity:0;transform:translateY(1.6vh)}55%,100%{opacity:1;transform:none}}
.bardakBg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;animation:kenBurns 7s ease-out forwards;filter:saturate(1.12) contrast(1.06) brightness(.86)}
.bardakInfo{position:relative;z-index:2;opacity:0;animation:bardakReveal 7s ease forwards}
/* mikro cross-sell şeridi — her kategori sayfasının altında tekrar eden Perfect Pair hatırlatması */
.pairStrip{position:absolute;bottom:2vh;left:0;right:0;z-index:5;display:flex;align-items:center;justify-content:center;gap:.8vw;font-size:1.6vh;color:#B89B80}
.pairStrip b{color:#EFE6D6;font-style:normal;font-family:'Fraunces',serif}
.pairStrip span.tag{background:#3E8E5A;color:#0e0b09;font-weight:700;padding:.25vh 1vw;border-radius:30px;font-size:.85em;text-transform:uppercase;letter-spacing:.05vw}
.q{position:relative;z-index:2;font-style:italic;font-size:2.6vh;color:#B89B80;margin-top:2.4vh;letter-spacing:.1vw}
.gT{font-size:4.2vh;font-weight:400;font-style:italic;color:#3E8E5A;letter-spacing:.1vw;margin-bottom:.4vh}
.gH{font-size:1.5vh;letter-spacing:.4vw;color:#7d7065;margin-bottom:3vh}
.menu{width:100%;max-width:92vw;font-size:2.4vh}
.menu.one{max-width:84vw}
.hdr{display:grid;grid-template-columns:1fr 3.2em 3.2em 3.2em;gap:.8em;font-size:.6em;letter-spacing:.1vw;color:#7d7065;margin-bottom:.8vh}.hdr span{text-align:center}
.row{display:grid;grid-template-columns:1fr 3.2em 3.2em 3.2em;gap:.8em;align-items:baseline;padding:1.1vh 0;border-top:1px solid #ffffff0c}
.row.one{grid-template-columns:1fr auto}
.nm{font-size:1em;text-align:left;white-space:nowrap}.nm small{font-size:.55em;color:#B89B80;font-style:italic;margin-left:.6vw}
.pr{font-size:.95em;font-weight:500;text-align:center}.pr.d{color:#ffffff22}
/* ANCHORING — 8oz sönük (küçük tetikleyici), Ice/14oz aksan-yeşil+büyük (asıl hedef bedef) */
.pr.sec{color:#7d7065;font-size:.78em}
.pr.acc{color:#5fbf86;font-weight:700;font-size:1.12em;text-shadow:0 0 1.2vh #3E8E5A55}
.ice{position:absolute;width:.5vw;height:.5vw;border-radius:50%;background:#a9dccd;animation:ice 4.5s ease-in-out infinite}
/* Fiyat rozeti — ÖZ-ELEŞTİRİ: sürekli pulse "dikkat çekmeye çalışıyor" hissi verir (ucuzluk sinyali,
   Apple/Tesla/Starbucks Reserve hiçbiri fiyatı sürekli animasyonla titretmez). Bir kere belirir, durur. */
@keyframes priceSettle{from{opacity:0;transform:translateY(.6vh) scale(.97)}to{opacity:1;transform:none}}
.spotTag{position:relative;z-index:2;font-size:1.5vh;letter-spacing:.32vw;color:#3E8E5A;text-transform:uppercase}
.spotTag.fire{color:#ffb347}
.spotPrice.fire{background:#ffb347;color:#2a1200}
.halo.fire{background:radial-gradient(circle,#5a3512,#321c08 46%,transparent 70%)}
/* "Keşfet" teması — algoritmik öneri, kürate İmza'nın yeşil/premium statüsünü ÇALMAZ */
.spotTag.discover{color:#6cb6e8}
.spotPrice.discover{background:#6cb6e8;color:#0e2230}
.halo.discover{background:radial-gradient(circle,#163a52,#0c2030 46%,transparent 70%)}
.gT.fire{color:#ffb347}
.gT.discover{color:#6cb6e8}
/* Özel Gün — kendi dokusu: sıcak altın degrade (Happy Hour'un video bg'sinden, Launch'ın siyah spot'undan ayrı) */
.ozelPg{background:radial-gradient(120% 90% at 50% 30%,#5a3f12,#2a1c08 55%,#0e0b09 100%)}
.spotCup{position:relative;z-index:2;animation:flo 4s ease-in-out infinite;margin:1.5vh 0 .5vh}
.spotName{position:relative;z-index:2;font-size:5.6vh;font-weight:500;margin:1.2vh 0 .6vh;letter-spacing:.02vw}
.spotDesc{position:relative;z-index:2;font-size:2.1vh;color:#B89B80;font-style:italic;max-width:84vw;line-height:1.5;margin-bottom:2.6vh}
.spotPrice{position:relative;z-index:2;display:inline-block;background:#3E8E5A;color:#0e0b09;font-weight:700;font-size:3.4vh;padding:1.3vh 6vw;border-radius:50px;animation:priceSettle .6s ease .3s both}
/* gerçek video arka plan — öneri & tatlı kombo sahnelerinde (sinematik, göz yormaz: opacity düşük + degrade) */
.bgvid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:.5;filter:saturate(1.25) contrast(1.1) brightness(.82)}
.bggrade{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,#0e0b09cc 0,#0e0b0966 28%,#0e0b0966 70%,#0e0b09e6 100%)}
.comboTitle{position:relative;z-index:2;font-size:3.6vh;font-style:italic;color:#EFE6D6;margin-top:1.2vh;text-shadow:0 .3vw 1.5vw #000}
/* 🔥 TOP-3 — gösterişli sosyal kanıt: glow rank, animasyonlu yüzde barı, gerçek video arka plan */
.t3wrap{position:relative;z-index:2;width:90vw;max-width:90vw}
.t3row{display:flex;align-items:center;gap:1.4vw;margin:1.6vh 0;animation:rowIn .6s cubic-bezier(.2,.7,.2,1) both}
.t3rank{font-size:5vh;font-weight:700;color:#3E8E5A;width:1.6em;text-align:center;text-shadow:0 0 2vh #3E8E5A99,0 0 .6vh #3E8E5A;flex-shrink:0}
.t3body{flex:1;min-width:0}
.t3name{font-size:2.6vh;color:#EFE6D6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:.6vh}
.t3name small{font-size:.7em;color:#5fbf86;font-style:normal}
.t3barBg{height:1.3vh;border-radius:1vh;background:#ffffff14;overflow:hidden}
.t3barBg i{display:block;height:100%;background:linear-gradient(90deg,#2c6b43,#5fbf86);border-radius:1vh;box-shadow:0 0 1.2vh #3E8E5A77;animation:t3barIn 1.4s cubic-bezier(.16,.8,.2,1) both}
@keyframes t3barIn{from{width:0}}
.t3count{flex-shrink:0;font-size:1.7vh;color:#7fae93;letter-spacing:.05vw;white-space:nowrap}
/* EKRAN 3 — MARKA + CANLI: Yeni Ürün Lansmanı (siyah + spot ışığı) */
.launchPg{background:#040302}
.spotCone{position:absolute;top:-15%;left:50%;width:55vw;height:130vh;transform:translateX(-50%);background:radial-gradient(ellipse at 50% 0%,#ffffff26,transparent 62%);pointer-events:none;z-index:1}
@keyframes launchPulse{0%,100%{opacity:.9;text-shadow:0 0 4vh #ffffff44}50%{opacity:1;text-shadow:0 0 7vh #ffffff88}}
.launchBig{position:relative;z-index:2;font-size:9vh;font-weight:700;letter-spacing:.25vw;color:#EFE6D6;animation:launchPulse 2.2s ease-in-out infinite}
.launchSub{position:relative;z-index:2;font-size:3.4vh;color:#3E8E5A;margin-top:1.6vh;letter-spacing:.05vw}
.launchTag{position:relative;z-index:2;font-size:2vh;color:#B89B80;font-style:italic;margin-top:1.2vh}
/* EKRAN 3 — Happy Hour rozeti */
.hhWrap{position:relative;z-index:2}
.hhClock{font-size:7vh}
.hhRange{font-size:4.4vh;font-weight:700;color:#3E8E5A;margin-top:1vh}
.hhMsg{font-size:2.2vh;color:#EFE6D6;font-style:italic;margin-top:1vh}
/* EKRAN 3 — Marka silüet altyazı (bardak rotasyonu) */
.brandLabel{position:relative;z-index:2;font-size:2.4vh;letter-spacing:.5vw;color:#EFE6D6;text-transform:uppercase;margin-top:1.2vh;text-shadow:0 .3vw 1.5vw #000}
/* SAAT/MEVSİM SİNEMATİK kartları (Ekran 2) + düz tipografik kartlar (Ekran 1) — gerçek sig verisiyle */
.bigEmoji{position:relative;z-index:2;font-size:8vh;margin-bottom:.6vh}
.bigEtiket{position:relative;z-index:2;font-size:4.6vh;font-weight:500;color:#EFE6D6;letter-spacing:.15vw;text-shadow:0 .3vw 1.5vw #000}
.bigOneri{position:relative;z-index:2;font-size:2.2vh;color:#5fbf86;font-style:italic;margin-top:1vh;letter-spacing:.05vw}
.flatCard .gT{margin-bottom:1.4vh}
.flatCard .spotPrice{margin-top:.8vh}
.musteriTag{position:relative;z-index:2;font-size:3vh;font-style:italic;color:#EFE6D6;text-shadow:0 .3vw 1.5vw #000;margin-top:1.4vh}
/* gerçek TULİPİ bardak fotoğrafı — imza silüet, her sahnede aynı kare (marka hafızası) */
.cupShot{position:relative;z-index:2;width:20vh;border-radius:1.4vh;box-shadow:0 1.8vh 4.5vh #000c;animation:flo 4s ease-in-out infinite;margin:1.2vh 0 .6vh}
/* FAZ 7 — Perfect Pair upsell */
.pair{position:relative;z-index:2;margin-top:2.8vh;display:flex;flex-direction:column;align-items:center;gap:.7vh;animation:pairIn 1s ease 1.1s both}
.pairTag{font-size:1.3vh;letter-spacing:.32vw;color:#0e0b09;background:#B89B80;padding:.5vh 1.5vw;border-radius:40px;text-transform:uppercase}
.pairTxt{font-family:'Fraunces',serif;font-size:2.4vh;color:#EFE6D6}
.pairSub{font-size:1.5vh;color:#B89B80;font-style:italic}
@keyframes pairIn{from{opacity:0;transform:translateY(1.6vh)}to{opacity:1;transform:none}}
.foot{position:absolute;bottom:2vh;left:0;right:0;text-align:center;z-index:6}
.foot #live{font-size:1.7vh;letter-spacing:.15vw;color:#7fae93;transition:opacity .5s}
.err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7d7065;font-size:2vh}
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
#cine .ct{font-family:'Fraunces',serif;font-size:5.4vh;font-weight:500;letter-spacing:.3vw;color:#EFE6D6;text-shadow:0 .4vw 2vw #000;opacity:0;transform:translateY(2.2vh);transition:.9s ease .35s}
#cine .cs{font-size:1.9vh;letter-spacing:.55vw;color:#5fbf86;text-transform:uppercase;opacity:0;transform:translateY(2vh);transition:.9s ease .6s}
#cine.on .ct,#cine.on .cs{opacity:1;transform:none}
#season{position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden}
/* FAZ 8 — zaman atmosferi (saat renk sıcaklığı, kenar-ağırlıklı → menü merkezi temiz) */
#tod{position:absolute;inset:0;pointer-events:none;z-index:2;opacity:.55;transition:background 4s ease,opacity 4s ease;mix-blend-mode:soft-light}
#tod.sabah{background:linear-gradient(180deg,#bfe3ff66,transparent 45%)}
#tod.ogle{background:radial-gradient(120% 70% at 50% 0%,#ffe9c255,transparent 60%)}
#tod.aksam{background:linear-gradient(0deg,#ff8a3d66,transparent 50%)}
#tod.gece{background:radial-gradient(120% 100% at 50% 60%,#13204d77,transparent 70%)}
/* FAZ 8 — Today's Favorite rozeti */
#fav{position:absolute;top:2.3vh;right:2.6vw;z-index:6;display:none;align-items:center;gap:.5vw;background:#3E8E5A22;border:1px solid #3E8E5A55;color:#cfe8d8;padding:.6vh 1.3vw;border-radius:40px;font-size:1.6vh;letter-spacing:.08vw}
#fav.on{display:flex}
#fav b{color:#EFE6D6;font-family:'Fraunces',serif;font-weight:500;margin-left:.3vw}
#season span{position:absolute;top:-10vh;animation:sfall linear infinite;will-change:transform}
@keyframes sfall{0%{transform:translateY(-10vh) translateX(0) rotate(0)}100%{transform:translateY(112vh) translateX(5vw) rotate(220deg)}}
/* 🎬 COFFEE STORY — sinematik ara sahne (çekirdek→espresso→latte art→fincanda doğan fiyat) */
.pg.story{background:#050302}
.pg.story.on{animation:none}
.story .stsc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
/* GERÇEK TULİPİ ÇEKİMİ — tek sürekli video (eski 3-klip crossfade emekli edildi) */
.story .vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:1;filter:saturate(1.18) contrast(1.08) brightness(1.06)}
/* sinematik katmanlar: bokeh derinlik + renklendirme/letterbox + film grain */
.story .grade{position:absolute;inset:0;z-index:6;pointer-events:none;background:linear-gradient(180deg,#0009 0,transparent 22%,transparent 74%,#000b 100%)}
.story .grain{position:absolute;inset:-25%;z-index:8;pointer-events:none;opacity:.07;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");background-size:150px 150px;animation:csGrain .5s steps(3) infinite}
.story .stTag{align-items:flex-start;padding-top:5vh;font-size:1.5vh;letter-spacing:.7vw;color:#3E8E5A;z-index:7;animation:csTag 12s linear infinite}
.story .stPriceWrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:5;opacity:0;animation:csPrice 12s ease-in-out infinite}
.story .stpn{font-size:6.4vh;letter-spacing:.5vw;color:#EFE6D6;text-transform:uppercase;text-shadow:0 .4vw 2.5vw #000,0 0 4vw #00000088}
.story .stpl{width:5vw;height:1px;background:#3E8E5A;margin:2.2vh 0;box-shadow:0 0 1vw #3E8E5A}
.story .stpp{font-size:5vh;font-weight:600;color:#5fbf86;text-shadow:0 0 3.5vw #3E8E5A99,0 0 1.2vw #3E8E5Acc}
@keyframes csGrain{0%{background-position:0 0}33%{background-position:-80px 50px}66%{background-position:70px -60px}100%{background-position:-50px -40px}}
@keyframes csTag{0%,4%{opacity:0}9%,87%{opacity:.55}93%,100%{opacity:0}}
@keyframes csPrice{0%,55%{opacity:0;transform:translateY(2.6vh) scale(.96)}65%{opacity:1;transform:translateY(0) scale(1)}95%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0}}
</style></head>
<body><div id="stage">
<div class="bg" id="bg"><div class="drift"></div></div>
<div id="tod"></div>
<div id="wall"></div>
<div id="season"></div>
<div id="fav"></div>
<img id="logoBadge" src="/tv-menu/logo" alt="">
<div id="priceCorner"><div class="pcName"></div><div class="pcPrice"></div></div>
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
function cupShotFor(name,kategori){
  var n=(name||"").toLowerCase(),k=(kategori||"").toLowerCase();
  if(/mocktail|milkshake/.test(k))return "mocktail";
  if(/ice|buz|cold|iced/.test(n))return "iced";
  return "hot";
}
function findPrice(name){var r=null;if(!window._tvData||!name)return null;
  (window._tvData.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(name).toLowerCase()){var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);if(v!=null)r=v;}});});
  return r;}
function findKategori(name){var r="";if(!window._tvData||!name)return r;
  (window._tvData.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(name).toLowerCase())r=k.kategori;});});
  return r;}
function buildSpotlight(opts){
  // tek tip "parlatma" kurgusu: halo + bardak silüeti + video arka plan + glow fiyat — Kahraman Ürün & En Çok Satılan ortak kullanır
  var sp=el("div","pg");sp.dataset.t=opts.dur||10000;sp.dataset.roles="2";
  sp.dataset.name=opts.ad;if(opts.fiyat!=null)sp.dataset.price=opts.fiyat+" TL";sp.dataset.sahne=opts.sahne||"spotlight";
  var theme=opts.theme||"";  // "", "fire" (en çok satılan), "discover" (öneri motoru)
  var tcls=theme?(" "+theme):"";
  var clip=/(mocktail|milkshake)/i.test(opts.kategori||"")?"mocktail":"craft";
  sp.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+clip+'"></video><div class="bggrade"></div>';
  sp.appendChild(el("div","halo"+tcls));
  var cup='<img class="cupShot" src="/tv-menu/cup/'+cupShotFor(opts.ad,opts.kategori)+'" alt="">';
  var inner='<div class="spotTag'+tcls+'">'+opts.tag+'</div><div class="spotCup">'+cup+'</div>'
    +'<div class="spotName">'+opts.ad+'</div>'
    +(opts.aciklama&&opts.aciklama!==opts.kategori?'<div class="spotDesc">'+opts.aciklama+'</div>':'')
    +(opts.fiyat!=null?'<div class="spotPrice'+tcls+'">'+opts.fiyat+' TL</div>':'');
  sp.innerHTML+=inner;
  return sp;
}
function buildStory(data){
  // GERÇEK TULİPİ ÇEKİMİ — Mixkit stok video emekli edildi (GPT önerisi): espresso akışı → süt → karamel finish → logo.
  // Tek sürekli gerçek klip, crossfade/3-video performans hack'i gerekmiyor (artık tek video var).
  var sp=storyProduct(data);window._story=sp;
  var st=el("div","pg story");st.dataset.t=12000;st.dataset.roles="2";
  st.dataset.name=sp.ad;if(sp.fiyat!=null)st.dataset.price=sp.fiyat+" TL";st.dataset.sahne="story";
  st.innerHTML='<video class="vid v1" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/espresso" style="opacity:1"></video>'
    +'<div class="grade"></div><div class="grain"></div>'
    +'<div class="stPriceWrap"><div class="stpn" id="storyName">'+sp.ad+'</div><div class="stpl"></div><div class="stpp" id="storyPrice">'+(sp.fiyat!=null?sp.fiyat+' TL':'')+'</div></div>'
    +'<div class="stsc stTag">TULİPİ · COFFEE STORY</div>';
  return st;
}
function bardakImgFor(mod){
  if(mod==="ogle")return "mocktail";
  if(mod==="aksam")return "iced";
  return "hot";
}
function heroProduct(data,sig){
  // Kahraman Ürün: panelden manuel imza > otomatik öneri motoru > yok
  // ÖZ-ELEŞTİRİ: İmza (kürate/premium) ile Öneri (algoritmik, az-satanı-it) AYNI yeşil temayı
  // paylaşıyordu — müşteri "bu markanın gurur duyduğu seçim" ile "satmadığı için ittiği ürün"
  // arasındaki farkı göremiyordu. Öneri artık ayrı "keşfet" (mavi) temada.
  if(data.imza&&data.imza.ad)return {ad:data.imza.ad,fiyat:data.imza.fiyat,aciklama:data.imza.aciklama,kategori:"",tag:"Bugünün İmzası",theme:""};
  if(sig&&sig.oneri&&sig.oneri.ad){var op=findPrice(sig.oneri.ad);if(op==null)op=sig.oneri.fiyat;
    return {ad:sig.oneri.ad,fiyat:op,aciklama:sig.oneri.kategori||"",kategori:sig.oneri.kategori||"",tag:(sig.oneri.neden||"Bugün Dene"),theme:"discover"};}
  return null;
}
function build(data,sig){
  window._tvData=data;
  var stage=document.getElementById("stage");
  Array.prototype.slice.call(stage.querySelectorAll(".pg")).forEach(function(p){p.remove()});
  var dots=document.getElementById("dots");dots.innerHTML="";
  var heroPages=[],ekran1Pages=[],ekran3Pages=[];

  // 1) BARDAK AÇILIŞ — gerçek bardak fotoğrafı, ilk ~2.5sn TAMAMEN sade (metin yok), sonra marka satırı + fiyat ipucu belirir
  var bOpen=el("div","pg");bOpen.dataset.t=7000;bOpen.dataset.roles="2";
  var bImg=bardakImgFor(sig&&sig.saat_modu&&sig.saat_modu.mod);
  var minFy=null;
  (data.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);
    if(v!=null&&(minFy==null||v<minFy))minFy=v;
  });});
  bOpen.innerHTML='<img class="bardakBg" src="/tv-menu/cup/'+bImg+'" alt="">'
    +'<div class="bggrade"></div>'
    +'<div class="bardakInfo"><div class="q" style="margin-top:0">Crafted Every Day</div>'
    +(minFy!=null?'<div class="bigOneri" style="margin-top:1vh">'+minFy+' TL\'den başlayan fiyatlar</div>':'')+'</div>';
  heroPages.push(bOpen);

  // ÖZ-ELEŞTİRİ — KONSOLİDASYON: Saat/Mevsim verisi eskiden 3 ekranda (Ekran1 Saat Kartı,
  // Ekran2 Saat Sinematik+Mevsim Sinematik, Ekran3 ŞİMDİ kartı) TEKRAR ediliyordu. Üç ekranı
  // art arda gören müşteri "GÜNAYDIN" mesajını 2-3 kez görüyordu. Saat sinyali artık SADECE
  // Ekran 3'te (ŞİMDİ kartı, "canlı" rolüne uygun); Mevsim sinyali SADECE Ekran 1'de (yavaş
  // değişen veri, "referans" ekranına uygun). Ekran 2'nin kazandığı süre gerçek ürün sahnelerine.
  function clipForMod(mod){return mod==="sabah"?"espresso":mod==="ogle"?"mocktail":mod==="aksam"?"dessert":"lifestyle";}

  // 2) 🎬 COFFEE STORY — sinematik (her döngüde günün ürünü fincanda doğar)
  heroPages.push(buildStory(data));

  // 3) 🔥 EN ÇOK SATILAN SPOTLIGHT — gerçek satış lideri, Kahraman Ürün'le AYNI parlatma kurgusunda (ateş temalı)
  var ecAd=sig&&sig.en_cok;
  var hp0=heroProduct(data,sig);  // çakışma kontrolü için önce bak (aynı ürünü 2 kez parlatma)
  if(ecAd&&(!hp0||hp0.ad!==ecAd)){
    var ecKat=findKategori(ecAd),ecFy=findPrice(ecAd);
    heroPages.push(buildSpotlight({tag:"En Çok Satılan",ad:ecAd,fiyat:ecFy,aciklama:ecKat,kategori:ecKat,dur:9000,theme:"fire",sahne:"en_cok"}));
  }

  // 4) KAHRAMAN ÜRÜN — İmza (manuel) veya Öneri motoru (oto), aynı parlatma kurgusu (yeşil tema)
  var hp=hp0;
  if(hp)heroPages.push(buildSpotlight({tag:hp.tag,ad:hp.ad,fiyat:hp.fiyat,aciklama:hp.aciklama,kategori:hp.kategori,dur:10000,theme:hp.theme,sahne:"kahraman"}));

  // 4.2) CRAFT MOCKTAIL — gerçek barista çekimi: jigger → süzgeç → yeşil akış (barista ustalığı, ayrı/kendi sahnesi)
  // Kahraman Ürün AYNI greenmocktail klibini kullanmışsa burada farklı klip seç (çakışma önleme)
  var craftClip=(hp&&/(mocktail|milkshake)/i.test(hp.kategori||""))?"mocktail":"greenmocktail";
  var craftM=el("div","pg");craftM.dataset.t=8000;craftM.dataset.roles="2";
  craftM.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+craftClip+'" style="opacity:.95"></video><div class="bggrade"></div>'
    +'<div class="spotTag">CRAFT MOCKTAIL</div><div class="comboTitle">El Yapımı, Anında Hazır</div>';
  heroPages.push(craftM);

  // 5) 🍰 TATLI KOMBO — Perfect Pair'i sahneler (Peak: merkez ekranın son/en güçlü sahnesi)
  // ÖZ-ELEŞTİRİ: dessert.mp4 (stok Mixkit kek videosu) tüm sistemdeki TEK kalan stok-gerçek
  // uyumsuzluğuydu. Gerçek Desserts çekimi yok, o yüzden gerçek kahve çekimine (craft) geçildi —
  // "Kahve + Tatlı" eşleşmesinde kahve tarafı gerçek, jenerik stok kekten daha tutarlı.
  var combo=el("div","pg");combo.dataset.t=9000;combo.dataset.roles="2";
  combo.dataset.name=(data.pair&&data.pair.ad)?data.pair.ad:"Kahve + Tatlı";combo.dataset.sahne="kombo";
  if(data.pair&&data.pair.fiyat!=null)combo.dataset.price=data.pair.fiyat+" TL";
  combo.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/craft"></video><div class="bggrade"></div>'
    +'<div class="spotTag">PERFECT PAIR</div>'
    +'<div class="spotName">'+((data.pair&&data.pair.ad)?data.pair.ad:"Kahve + Tatlı")+'</div>'
    +'<div class="comboTitle">Birlikte daha güzel</div>'
    +((data.pair&&data.pair.fiyat!=null)?'<div class="spotPrice">'+data.pair.fiyat+' TL</div>':'');
  heroPages.push(combo);

  // 5.5) EKRAN 1 — düz tipografik kartlar (video YOK, "sabit/okunabilir" ethos), kategori listesinden önce
  // Mevsim Kartı — saat sinyali artık SADECE Ekran 3'te (konsolidasyon notuna bkz)
  if(sig&&sig.mevsim){
    var mvC=el("div","pg flatCard");mvC.dataset.t=6000;mvC.dataset.roles="1";
    mvC.innerHTML='<div class="gT">'+sig.mevsim.etiket+'</div>'+(sig.mevsim.oneri?'<div class="gH" style="margin-bottom:0">'+sig.mevsim.oneri+'</div>':'');
    ekran1Pages.push(mvC);
  }
  // Bugünün Önerisi Kartı — ürün GÖRSELİ+yapılışı (gerçek video, hafif opak) + isim + fiyat aynı kartta
  // (kategori listeleri okunabilirlik için düz kalır, ama bu vitrin kartı artık "sadece yazı" değil)
  if(hp){
    var hpClip=/(mocktail|milkshake)/i.test(hp.kategori||"")?"greenmocktail":"craft";
    var hpTcls=hp.theme?(" "+hp.theme):"";
    var hpC=el("div","pg flatCard");hpC.dataset.t=7000;hpC.dataset.roles="1";
    hpC.dataset.name=hp.ad;if(hp.fiyat!=null)hpC.dataset.price=hp.fiyat+" TL";hpC.dataset.sahne="oneri-flat";  // #priceCorner artık Ekran1'de de tutarlı
    hpC.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+hpClip+'" style="opacity:.4"></video><div class="bggrade"></div>'
      +'<div class="gT'+hpTcls+'" style="position:relative;z-index:2">'+hp.tag+'</div><div class="spotName" style="font-size:4vh;position:relative;z-index:2">'+hp.ad+'</div>'
      +(hp.fiyat!=null?'<div class="spotPrice'+hpTcls+'" style="position:relative;z-index:2">'+hp.fiyat+' TL</div>':'');
    ekran1Pages.push(hpC);
  }
  // Perfect Pair Kartı — ayrı/büyük (alttaki mikro-şeritten farklı, kendi sahnesi)
  if(data.pair&&data.pair.ad){
    var pairC=el("div","pg flatCard");pairC.dataset.t=7000;pairC.dataset.roles="1";
    pairC.dataset.name=data.pair.ad;if(data.pair.fiyat!=null)pairC.dataset.price=data.pair.fiyat+" TL";pairC.dataset.sahne="pair-flat";
    pairC.innerHTML='<div class="gT">Perfect Pair</div><div class="spotName" style="font-size:3.6vh;position:relative;z-index:2">'+data.pair.ad+'</div>'
      +(data.pair.mesaj?'<div class="spotDesc" style="position:relative;z-index:2">'+data.pair.mesaj+'</div>':'')
      +(data.pair.fiyat!=null?'<div class="spotPrice" style="position:relative;z-index:2">'+data.pair.fiyat+' TL</div>':'');
    ekran1Pages.push(pairC);
  }

  // 6) KATEGORİLER (DESTEK EKRAN) — decision fatigue: sahne başına max 8 satır, taşan ikinci sayfaya bölünür
  // Her sayfanın altında sabit Perfect Pair mikro-şeridi tekrar eder (cross-sell sürekli hatırlatılır)
  var pairHtml=(data.pair&&data.pair.ad)?('<div class="pairStrip"><span class="tag">Perfect Pair</span> <b>'+data.pair.ad+'</b>'+(data.pair.mesaj?(' · '+data.pair.mesaj):'')+'</div>'):'';
  function buildKatPage(k,chunk,pi,totalParts){
    var three=chunk.some(function(u){return u.f14!=null||u.fice!=null;});
    var pg=el("div","pg cat");pg.dataset.t=12000;pg.dataset.roles="1";
    pg.appendChild(el("div","gT",k.kategori+(totalParts>1?" ("+(pi+1)+"/"+totalParts+")":"")));
    if(k.alt&&pi===0)pg.appendChild(el("div","gH",k.alt));
    var m=el("div","menu"+(three?"":" one"));
    if(three)m.innerHTML='<div class="hdr"><span style="text-align:left"></span><span>8oz</span><span>14oz</span><span>ICE</span></div>';
    m.innerHTML+=chunk.map(function(u,i){return priceRow(u,three,i);}).join("");
    pg.appendChild(m);
    if(/(iced|cold|so.uk)/i.test(k.kategori)){for(var i=0;i<10;i++){var s=el("span","ice");s.style.left=(8+Math.random()*84)+"%";s.style.top=(22+Math.random()*54)+"%";s.style.animationDelay=(Math.random()*4.5)+"s";pg.appendChild(s);}}
    if(pairHtml)pg.innerHTML+=pairHtml;
    return pg;
  }
  var AGIRLIKLI_KAT=["Classic Coffees","Signature Coffees"];  // en çok satılan kategoriler — döngüde 2 kez görünür
  var agirlikliTekrar=[];
  (data.kategoriler||[]).forEach(function(k){
    var CHUNK=8,parts=[];
    for(var i=0;i<k.urunler.length;i+=CHUNK)parts.push(k.urunler.slice(i,i+CHUNK));
    parts.forEach(function(chunk,pi){
      ekran1Pages.push(buildKatPage(k,chunk,pi,parts.length));
    });
    if(AGIRLIKLI_KAT.indexOf(k.kategori)>=0&&parts.length)agirlikliTekrar.push(buildKatPage(k,parts[0],0,1));
  });
  // ÖZ-ELEŞTİRİ: kategori sayfaları eskiden eşit ağırlıklı görünüyordu (Desserts 4 ürün = Signature
  // 14 ürün, aynı 1 geçiş). En çok satılan kategoriler döngü sonunda (Top3'ten önce) bir kez daha
  // görünerek daha fazla "ekran zamanı" alır — gerçek satış ağırlığına göre yerleşim.
  agirlikliTekrar.forEach(function(pg){ekran1Pages.push(pg);});

  // 7) 🔥 EN ÇOK TERCİH EDİLEN — Peak-End: destek ekranın en SON/en güçlü sahnesi, gösterişli sosyal kanıt
  if(sig && sig.top3 && sig.top3.length){
    var t3=el("div","pg cat top3pg");t3.dataset.t=9000;t3.dataset.roles="1";
    t3.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/espresso" style="opacity:.32"></video><div class="bggrade"></div>';
    t3.appendChild(el("div","gT","Bugün En Çok Tercih Edilen"));
    var maxAdet=Math.max.apply(null,sig.top3.map(function(it){return it.adet;}));
    var wrap=el("div","t3wrap");
    wrap.innerHTML=sig.top3.map(function(it,i){
      var pct=Math.max(8,Math.round((it.adet/maxAdet)*100));
      var fy=findPrice(it.ad);
      return '<div class="t3row" style="animation-delay:'+(0.15+i*0.15).toFixed(2)+'s">'
        +'<div class="t3rank">'+(i+1)+'</div>'
        +'<div class="t3body"><div class="t3name">'+it.ad+(fy!=null?' <small>· '+fy+' TL</small>':'')+'</div><div class="t3barBg"><i style="width:'+pct+'%;animation-delay:'+(0.4+i*0.15).toFixed(2)+'s"></i></div></div>'
        +'<div class="t3count">'+Math.round(it.adet)+' kez</div></div>';
    }).join("");
    t3.appendChild(wrap);
    ekran1Pages.push(t3);
  }

  // 8) EKRAN 3 — MARKA + CANLI: lifestyle, bardak rotasyonu, happy hour, yeni ürün lansmanı, özel gün
  // Marka/Yaşam Tarzı — gerçek vitrin+müşteri çekimi
  var brandPg=el("div","pg");brandPg.dataset.t=8000;brandPg.dataset.roles="3";
  brandPg.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/lifestyle" style="opacity:.85"></video><div class="bggrade"></div>'
    +'<div class="brandLabel">Her An Yanında</div>';
  ekran3Pages.push(brandPg);
  // "ŞİMDİ" kartı — saat+mevsim TEK kompakt sinyalde (Ekran 2'nin ayrı/büyük sinematik kartlarından farklı, hızlı bilgi katmanı)
  if(sig&&sig.saat_modu){
    var nowPg=el("div","pg");nowPg.dataset.t=7000;nowPg.dataset.roles="3";
    nowPg.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+clipForMod(sig.saat_modu.mod)+'" style="opacity:.55"></video><div class="bggrade"></div>'
      +'<div class="spotTag">ŞİMDİ</div><div class="bigEtiket" style="font-size:3.6vh">'+sig.saat_modu.etiket+(sig.mevsim?(' · '+sig.mevsim.etiket):'')+'</div>'
      +(sig.saat_modu.oneri?'<div class="bigOneri">'+sig.saat_modu.oneri+'</div>':'');
    ekran3Pages.push(nowPg);
  }
  // Müşteri Anı — gerçek TULİPİ müşteri görüntüsü (Ekran 2'den farklı mesaj, marka samimiyeti)
  var mus3=el("div","pg");mus3.dataset.t=7000;mus3.dataset.roles="3";
  mus3.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/musteri" style="opacity:.9"></video><div class="bggrade"></div>'
    +'<div class="musteriTag">Mutluluk Burada</div>';
  ekran3Pages.push(mus3);
  // Bardak rotasyonu + çeşitlilik + frozen — ÖZ-ELEŞTİRİ: eskiden sıcak→buzlu→mocktail→kahverengi→
  // frozen sırası 1 sıcak + 4 soğuk art arda veriyordu ("mocktail galerisi" anti-pattern'i — GPT'nin
  // uyardığı "yine içecek" hissi). Şimdi sıcak/soğuk alternansı: soğuk-soğuk-SICAK-soğuk-soğuk yerine
  // sıcağı ortaya alıp soğuk kümesini ikiye böldük (2-1-2), tek-nota tekrar hissini kırıyor.
  var photoPg=function(name,label){var cp=el("div","pg");cp.dataset.t=4000;cp.dataset.roles="3";
    cp.innerHTML='<img class="bardakBg" src="/tv-menu/cup/'+name+'" alt=""><div class="bggrade"></div><div class="brandLabel">'+label+'</div>';
    return cp;};
  ekran3Pages.push(photoPg("iced","Buzlu Lezzetler"));
  var kahveC=el("div","pg");kahveC.dataset.t=6000;kahveC.dataset.roles="3";
  kahveC.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/kahverengi" style="opacity:1"></video><div class="bggrade"></div><div class="brandLabel">Yeni Tatlar</div>';
  ekran3Pages.push(kahveC);
  ekran3Pages.push(photoPg("hot","Sıcak Kahveler"));
  ekran3Pages.push(photoPg("mocktail","Mocktail Dünyası"));
  // 🍓 FROZEN VİTRİN — tek başına satabilecek kadar güçlü, tatlı kombo arkasına gizlenmiyor (GPT önerisi: %100 ekran, kendi sahnesi)
  // ÖZ-ELEŞTİRİ: "YENİ" rozeti eskiden HER ZAMAN gösteriliyordu — eğer Frozen panelde de yeni=true
  // işaretliyse, müşteri Launch sahnesinde de "YENİ" görüp tekrar karşılaşıyordu (sinyal enflasyonu).
  // Artık sadece sig.yeni listesinde gerçekten "frozen" geçen bir ürün varsa rozet gösteriliyor.
  var frozenYeni=!!(sig&&sig.yeni&&sig.yeni.some(function(n){return /frozen/i.test(n);}));
  var frozenPg=el("div","pg");frozenPg.dataset.t=7000;frozenPg.dataset.roles="3";
  frozenPg.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/frozen" style="opacity:1"></video><div class="bggrade"></div>'
    +(frozenYeni?'<div class="spotTag fire">YENİ</div>':'')+'<div class="musteriTag">Serinleten Lezzet</div>';
  ekran3Pages.push(frozenPg);
  // Happy Hour — aktifse büyük rozet
  if(sig && sig.happy_hour && sig.happy_hour.aktif){
    var hh=el("div","pg");hh.dataset.t=7000;hh.dataset.roles="3";
    hh.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/mocktail" style="opacity:.4"></video><div class="bggrade"></div>'
      +'<div class="hhWrap"><div class="hhClock">⏰</div><div class="hhRange">'+sig.happy_hour.bas+':00–'+sig.happy_hour.bit+':00</div>'
      +'<div class="hhMsg">'+sig.happy_hour.mesaj+'</div></div>';
    ekran3Pages.push(hh);
  }
  // 🆕 Yeni Ürün Lansmanı — siyah ekran + spot ışığı (yeni=true ürünler varsa)
  if(sig && sig.yeni && sig.yeni.length){
    var ln=el("div","pg launchPg");ln.dataset.t=7000;ln.dataset.roles="3";
    ln.innerHTML='<div class="spotCone"></div>'
      +'<div class="launchBig">YENİ</div>'
      +'<div class="launchSub">'+sig.yeni.slice(0,2).join(" · ")+'</div>'
      +'<div class="launchTag">İlk Sen Dene</div>';
    ekran3Pages.push(ln);
  }
  // Özel Gün — ÖZ-ELEŞTİRİ: Happy Hour (video bg+rozet) ve Launch (siyah+spot ışığı) farklı şablonlardı
  // ama Özel Gün ikisiyle de aynı "ortalanmış metin" kalıbını paylaşıyordu. Artık kendi kimliği var:
  // sıcak altın degrade tam ekran (ne video ne siyah spot — üçüncü bir doku).
  if(sig && sig.ozel){
    var oz=el("div","pg ozelPg");oz.dataset.t=7000;oz.dataset.roles="3";
    oz.innerHTML='<div class="spotTag" style="position:relative;z-index:2">'+sig.ozel.etiket+'</div><div class="comboTitle" style="position:relative;z-index:2;font-size:4.2vh">'+sig.ozel.mesaj+'</div>';
    ekran3Pages.push(oz);
  }

  // FAZ 4 — 3 EKRAN: merkez(2)=sinema/kahraman · sol(1)=fiyat kartı (sabit, video yok) · sağ(3)=marka+canlı sinyal
  var ekran=(new URLSearchParams(location.search)).get("ekran");
  var pages;
  if(ekran==="2")pages=heroPages;
  else if(ekran==="1")pages=ekran1Pages;
  else if(ekran==="3")pages=ekran3Pages;
  else pages=heroPages.concat(ekran1Pages).concat(ekran3Pages);  // ekran param yoksa (tek TV testi) hepsi
  pages.forEach(function(p){stage.insertBefore(p,document.querySelector(".foot"));dots.appendChild(el("i"));});
  var di=dots.children;
  var pc=document.getElementById("priceCorner");
  // KRİTİK FIX: display:none içindeyken <video autoplay> tarayıcıda sessizce başlamaz —
  // sahne görünür/gizli olduğunda videoyu EXPLICIT play()/pause() etmek gerekiyor (tüm bgvid sahneleri için)
  function syncVideos(p,on){
    var vids=p.querySelectorAll("video");
    for(var j=0;j<vids.length;j++){
      if(on){ if(vids[j].paused){var pr=vids[j].play();if(pr&&pr.catch)pr.catch(function(){});} }
      else if(!vids[j].paused){ try{vids[j].pause();}catch(e){} }
    }
  }
  // ANALYTICS ENGINE — Adım 1 (Gösterim Sayacı): bir ürün adlı sahne gerçekten ekrana gelince
  // fire-and-forget logla. Sahne akışını ASLA bloklamaz/bozmaz (hata sessizce yutulur).
  var lastLogIdx=-1;
  function logGosterim(p){
    if(!p||!p.dataset.name)return;
    try{
      fetch("/api/tv-gosterim",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ekran:(new URLSearchParams(location.search)).get("ekran")||"tek",sahne:p.dataset.sahne||"",urun_ad:p.dataset.name})
      }).catch(function(){});
    }catch(e){}
  }
  function show(i){pages.forEach(function(p,k){var on=k===i;p.classList.toggle("on",on);di[k].classList.toggle("on",on);syncVideos(p,on);});
    var cur=pages[i];
    if(i!==lastLogIdx){lastLogIdx=i;logGosterim(cur);}
    var fv=document.getElementById("fav");if(fv)fv.classList.toggle("on",!!(window._favName&&cur&&cur.classList.contains("cat")));
    if(pc){
      if(cur&&cur.dataset.price){pc.querySelector(".pcName").textContent=cur.dataset.name||"";pc.querySelector(".pcPrice").textContent=cur.dataset.price;pc.classList.add("on");}
      else pc.classList.remove("on");
    }
  }
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
// ÖZ-ELEŞTİRİ: uçuşan dekoratif çekirdek parçacıkları kaldırıldı — "tek hareket kaynağı" kuralını
// ihlal ediyordu (gerçek video zaten hareketliyken, üzerine sahte CSS hareketi eklemek dikkati böler).
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
      if(nm){nm.textContent=s.en_cok;pe.textContent=pp+" TL";
        var stp=nm.closest(".pg");if(stp){stp.dataset.name=s.en_cok;stp.dataset.price=pp+" TL";}}}}
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
  // GERÇEK TULİPİ çekimleri (stok bean/latte/cup emekli edildi — kopukluk yaratıyordu, marka tutarlılığı için)
  var CYCLE=150, DUR=11, names=["espresso","craft","musteri","lifestyle"];
  var caps={espresso:["TAZE DEMLENDİ","Freshly Brewed"],craft:["EL YAPIMI","Handcrafted"],musteri:["MUTLULUK","Her Gülüşte"],lifestyle:["TULİPİ","Her An Yanında"]};
  var vid=c.querySelector("video"),ct=c.querySelector(".ct"),cs=c.querySelector(".cs"),active=false,curName="";
  function pick(occ){return ek?names[Math.max(0,parseInt(ek,10)-1)%names.length]:names[occ%names.length];}
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
