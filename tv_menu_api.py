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


@router.get("/api/tv-gosterim/etki")
def tv_gosterim_etki():
    """Analytics Engine — Adım 2 (Attribution, KABA/GÜNLÜK versiyon).
    DÜRÜST NOT: Evo'nun fatura zaman damgasına (a_cdate) şu an token/auth sorunuyla
    erişilemiyor — bu yüzden 'gösterimden 15 dk sonra satış arttı mı' tarzı dakika-
    hassasiyetli attribution YAPILAMAZ (bunu yapmak ayrı bir token-debug işi gerektirir,
    burada uydurmadık). Bunun yerine GÜNLÜK korelasyon: bugün çok gösterilen bir ürünün
    bugünkü satışı, kendi 30-günlük günlük ortalamasının üstünde mi? Kaba ama gerçek ve
    hemen ölçülebilir bir sinyal."""
    try:
        with db() as (conn, cur):
            _ensure_gosterim_tablo(cur)
            cur.execute(
                """SELECT urun_ad, COUNT(*) AS n FROM tv_gosterim
                   WHERE ts >= CURRENT_DATE AND urun_ad IS NOT NULL
                   GROUP BY urun_ad ORDER BY n DESC"""
            )
            gosterim_bugun = {r["urun_ad"]: r["n"] for r in (cur.fetchall() or [])}
    except Exception as e:
        logger.warning("tv-gosterim etki hata: %s", e)
        return {"sonuc": [], "uyari": str(e)}
    if not gosterim_bugun:
        return {"sonuc": [], "uyari": "Bugün hiç gösterim loglanmadı"}
    try:
        from evo_sync import hs_rapor_urun_satis
        satis_bugun = hs_rapor_urun_satis(_date.today(), _date.today()) or {}
    except Exception as e:
        logger.warning("tv-gosterim etki Evo hata: %s", e)
        satis_bugun = {}
    ort_30 = _satis_30gun()  # 30 günlük TOPLAM adet — günlük ortalama için /30
    satis_norm = _satis_taban_map(satis_bugun)
    ort_norm = _satis_taban_map(ort_30)
    sonuc = []
    for ad, gosterim in gosterim_bugun.items():
        n = _urun_taban_key(ad)
        s_bugun = satis_norm.get(n, 0)
        ort_gunluk = (ort_norm.get(n, 0) or 0) / 30.0
        if ort_gunluk > 0.3:
            oran = round(s_bugun / ort_gunluk, 2)
            sinyal = "yüksek" if oran >= 1.3 else ("düşük" if oran < 0.7 else "normal")
        else:
            oran = None
            sinyal = "veri az (yeni/nadiren satılan ürün)"
        sonuc.append({
            "urun_ad": ad, "gosterim_bugun": gosterim, "satis_bugun": s_bugun,
            "ortalama_gunluk_30gun": round(ort_gunluk, 2), "oran": oran, "sinyal": sinyal,
        })
    sonuc.sort(key=lambda x: -x["gosterim_bugun"])
    return {"sonuc": sonuc, "not": "Günlük korelasyon — dakika-hassasiyetli attribution Evo token sorunu yüzünden henüz yapılamıyor"}


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
    # DUYU KANCASI (hata-yutar): fiyat değişimi omurgaya iz bırakır — zımni-fiyat
    # sapmalarının doğal açıklayıcısı (menu_fiyat_izi duyusu)
    try:
        from duyu_ozgun import fiyat_degisim_kaydet
        for d in degisti:
            fiyat_degisim_kaydet(d["ad"], d["kolon"], d.get("eski"), d.get("yeni"), "evo_sync")
    except Exception:
        pass
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
        cur.execute("SELECT id, ad, f8, f14, fice FROM tv_menu WHERE id=%s", (uid,))
        eski = cur.fetchone()
        if not eski:
            raise HTTPException(404, "Ürün bulunamadı")
        eski = dict(eski)
        cur.execute(
            """UPDATE tv_menu SET kategori=%s,ad=%s,aciklama=%s,f8=%s,f14=%s,fice=%s,
               sira=%s,aktif=%s,yeni=%s,guncelleme=NOW() WHERE id=%s""",
            (u.kategori, u.ad, u.aciklama, u.f8, u.f14, u.fice, (u.sira or 0), u.aktif, bool(u.yeni), uid),
        )
    # DUYU KANCASI (hata-yutar): elle fiyat değişimi de iz bırakır (menu_fiyat_izi)
    try:
        from duyu_ozgun import fiyat_degisim_kaydet
        for kol, yeni_v in (("f8", u.f8), ("f14", u.f14), ("fice", u.fice)):
            fiyat_degisim_kaydet(eski.get("ad") or u.ad, kol, eski.get(kol), yeni_v, "manuel")
    except Exception:
        pass
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


def _kategori_fav(satis, rows):
    """Kategori başına en çok satılan ürün (✦ en sevilen rozeti) — top3 tek kategoriye
    yığılabildiği için (yazın hepsi mocktail) her kategorinin KENDİ yıldızı buradan gelir.
    Evo adları boy/soğuk eki taşır ("Latte Ice", "Mocha 14oz") → ekler soyulup varyant
    satışları TOPLANIR, yoksa kahveler hiç eşleşmez (bilinen Evo isim tuzağı)."""
    fav = {}
    if not rows or not satis:
        return fav
    norm = lambda s: re.sub(r"\s+", " ", str(s).strip().lower())
    base = lambda s: re.sub(r"\s+(ice|buzlu|8\s*oz|14\s*oz)$", "", norm(s)).strip()
    toplam = {}
    for a, c in satis.items():
        b = base(a)
        toplam[b] = toplam.get(b, 0) + (c or 0)
    best = {}
    for r in rows:
        c = toplam.get(base(r["ad"]))
        if c and c > 0 and (r["kategori"] not in best or c > best[r["kategori"]][1]):
            best[r["kategori"]] = (r["ad"], c)
    for kat, (ad, _c) in best.items():
        fav[kat] = ad
    return fav


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
        # sosyal kanıt dili saat-modlu (GPT vizyonu, kullanıcı onaylı): rozetten daha canlı
        _fav_etiket = {"sabah": "Sabahın favorisi", "ogle": "Öğlenin favorisi",
                       "aksam": "Akşamın favorisi"}.get(sm.get("mod"), "Bugün en çok seçilen")
        seritler.append("☕ " + _fav_etiket + ": " + en_cok)
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
    # boy yükseltme fısıltısı + marka DNA sloganı (kullanıcı onaylı, 2026-07-03)
    seritler.append("Uzun içim sevenler 14 oz tercih ediyor.")
    seritler.append("Zincir gibi hızlı. Zanaat gibi özenli.")
    oz = _ozel_gun(ayar)
    if oz:
        seritler.insert(0, oz["etiket"] + " · " + oz["mesaj"])   # özel gün şeridi en başta
    return {"saat_modu": sm, "mevsim": mv, "ozel": oz, "en_cok": en_cok, "yeni": yeni,
            "happy_hour": hh, "top3": top3, "oneri": oneri, "seritler": seritler,
            "barista_notu": (ayar.get("barista_notu") or ""),
            "kategori_fav": _kategori_fav(satis, rows)}


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
    barista_notu: Optional[str] = None  # E2 kategori sayfası altı tek satır uzman fısıltısı


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
        "barista_notu": a.get("barista_notu") or "",
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
    if a.barista_notu is not None:
        kv["barista_notu"] = a.barista_notu.strip()
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


@router.get("/tv-menu/hero/{name}")
def tv_menu_hero(name: str):
    # opening = Sahne 1 PNG; ozen = Sahne 2 "Özen Katmanı" still hero (SAHNE2_PAKET/01, işlenmiş JPG)
    _heroes = {"opening": ("e1_opening_hero.png", "image/png"),
               "latte_cutout": ("e1_latte_cup_cutout.png", "image/png"),
               "paper_real": ("e1_real_paper_cup_cutout.png", "image/png"),
               "ozen": ("ozen_hero.jpg", "image/jpeg"),
               "sezon_yaz": ("sezon_yaz.png", "image/png"),
               "imza_bg": ("imza_bg.jpg", "image/jpeg"),
               "doku_tezgah": ("doku_tezgah.jpg", "image/jpeg")}
    if name not in _heroes:
        raise HTTPException(404, "hero yok")
    fname, mtype = _heroes[name]
    for p in (
        os.path.join("static/tv", fname),
        os.path.join("public/tv", fname),
    ):
        if os.path.exists(p):
            return FileResponse(p, media_type=mtype)
    raise HTTPException(404, "hero dosyasi yok")


@router.get("/tv-menu/cup/{name}")
def tv_menu_cup(name: str):
    """Gerçek TULİPİ bardak fotoğrafları — imza silüet (her sahnede aynı kare, marka hafızası).
    Prod: Vite public/ -> static/'ye kopyalar. Dev: public/tv veya src/assets/tv."""
    if name not in ("hot", "latte", "iced", "mocktail"):
        raise HTTPException(404, "bardak yok")
    eski = {
        "hot": "cup_hot_green.jpeg",
        "latte": "cup_hot_green.jpeg",
        "iced": "cup_iced_latte.jpeg",
        "mocktail": "cup_mocktail_green.jpeg",
    }[name]
    cutout = {
        "hot": "e1_real_paper_cup_cutout.png",
        # KULLANICI KARARI 2026-07-04: latte = YEŞİL KARTON bardak (sıcak servis).
        # e1_latte_cup_cutout.png plastik buzlu bardaktı — plastik sadece iced/mocktail'de.
        "latte": "e1_real_paper_cup_cutout.png",
        "iced": "cup_iced_cutout.png",
        "mocktail": "cup_mocktail_cutout.png",
    }[name]
    for p in (
        os.path.join("static/tv", cutout),
        os.path.join("public/tv", cutout),
        os.path.join("static/tv", "cup_" + name + ".jpeg"),
        os.path.join("public/tv", "cup_" + name + ".jpeg"),
        os.path.join("src/assets/tv", eski),
    ):
        if os.path.exists(p):
            return FileResponse(
                p,
                media_type="image/png" if p.endswith(".png") else "image/jpeg",
                headers={"Cache-Control": "no-store, max-age=0"},
            )
    raise HTTPException(404, "bardak dosyası yok")


@router.get("/tv-menu/clip/{name}")
def tv_menu_clip(name: str):
    """Coffee Story gerçek video klipleri (Mixkit Free, ticari kullanım serbest)."""
    if name not in ("dessert", "mocktail", "lifestyle", "craft", "musteri",
                     "espresso", "greenmocktail", "frozen", "kahverengi",
                     "zanaat", "hayat", "ozen",
                     # GERÇEK TULİPİ çekimleri (dikey 9:16, F1 2026-07-20) — Otancy galerisinden
                     "tulipi_latte", "tulipi_espresso", "tulipi_grind",
                     "tulipi_mekan", "tulipi_iced"):
        raise HTTPException(404, "klip yok")
    # Prod: Vite public/ -> static/tv'ye kopyalar. Dev: public/tv veya src/assets/tv.
    for base in ("static/tv", "public/tv", "src/assets/tv"):
        p = os.path.join(base, name + ".mp4")
        if os.path.exists(p):
            return FileResponse(p, media_type="video/mp4")
    raise HTTPException(404, "klip dosyası yok")


@router.get("/tv-portre", response_class=HTMLResponse)
def tv_portre_html():
    """DİKEY (9:16) FLAGSHIP — gerçek TULİPİ kliplerinden sinematik marka hikâyesi.
    Sahip kararı 2026-07-20: ekranlar portre. Mevcut yatay /tv-menu'ye DOKUNMAZ."""
    return HTMLResponse(_TV_PORTRE_HTML)


_TV_PORTRE_HTML = r"""<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TULİPİ</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,ital,wght@9..144,0,300;9..144,0,400;9..144,0,500;9..144,0,600&display=swap" rel="stylesheet">
<style>
:root{--cream:#EFE6D6;--muted:#B89B80;--green:#3E8E5A;--bg:#0b0705}
*{margin:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:var(--bg);cursor:none;font-family:'Fraunces',serif;color:var(--cream)}
#stage{position:fixed;inset:0;background:var(--bg)}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .6s ease;will-change:opacity}
video.on{opacity:1}
#scrim{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(11,7,5,.28) 0%,transparent 26%,transparent 52%,rgba(11,7,5,.72) 100%)}
#txt{position:absolute;left:0;right:0;bottom:9vh;padding:0 8vw;text-align:center;z-index:3}
#kick{font-size:2.4vh;font-weight:500;letter-spacing:.42em;text-transform:uppercase;color:var(--green);opacity:0;transition:opacity .5s ease;margin-bottom:1.6vh}
#beat{font-size:6.2vh;line-height:1.08;font-weight:400;color:var(--cream);opacity:0;transition:opacity .55s ease;text-shadow:0 2px 24px rgba(0,0,0,.55)}
#brand{position:absolute;top:6vh;left:0;right:0;text-align:center;font-size:3.1vh;font-weight:600;letter-spacing:.34em;color:var(--cream);opacity:0;transition:opacity .6s ease;z-index:3}
#brand.on{opacity:.96}
#brand b{color:var(--green)}
.show{opacity:1 !important}
/* ── MENÜ SAYFASI — okunurluk kral: koyu zemin, Fraunces krem, tat notu ── */
#menu{position:absolute;inset:0;z-index:2;opacity:0;transition:opacity .6s ease;display:flex;flex-direction:column;padding:13vh 8vw 8vh;background:radial-gradient(72vw 60vw at 50% 18%,rgba(98,66,34,.22),transparent 64%),linear-gradient(180deg,#1b130f 0%,#0b0705 100%)}
#menu.on{opacity:1}
#mhead{text-align:center;margin-bottom:5.4vh}
#mkat{font-size:5.4vh;font-weight:500;color:var(--cream);line-height:1.05}
#mkat::after{content:"";display:block;width:8vw;height:2px;background:var(--green);margin:2vh auto 0;border-radius:2px}
#malt{font-size:2.1vh;color:var(--muted);letter-spacing:.16em;text-transform:uppercase;margin-top:2vh}
#mlist{display:flex;flex-direction:column;gap:2.7vh}
.mrow{display:flex;align-items:baseline;gap:1.6vw}
.mad{font-size:3.5vh;font-weight:500;color:var(--cream);white-space:nowrap}
.mnote{flex:1;font-size:2vh;font-style:italic;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform:translateY(-.3vh)}
.mdot{flex:1;border-bottom:1px dotted rgba(184,155,128,.30);transform:translateY(-.5vh);min-width:2vw}
.mfiyat{font-size:3.2vh;font-weight:500;color:var(--cream);white-space:nowrap;font-variant-numeric:tabular-nums}
/* ön-yükleme perdesi — hazır olana kadar */
#veil{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(60vw 60vw at 50% 38%,rgba(98,66,34,.30),transparent 66%),var(--bg);transition:opacity .8s ease}
#veil.gone{opacity:0;pointer-events:none}
#vbrand{font-size:5vh;font-weight:600;letter-spacing:.34em;color:var(--cream)}#vbrand b{color:var(--green)}
#vbar{margin-top:3.4vh;width:44vw;height:3px;background:rgba(239,230,214,.14);border-radius:2px;overflow:hidden}
#vfill{height:100%;width:0;background:var(--green);transition:width .35s ease}
#vpct{margin-top:1.8vh;font-size:1.9vh;letter-spacing:.3em;color:var(--muted)}
</style></head>
<body>
<div id="stage">
  <div id="scrim"></div>
  <div id="menu">
    <div id="mhead"><div id="mkat"></div><div id="malt"></div></div>
    <div id="mlist"></div>
  </div>
  <div id="brand">TULİ<b>P</b>İ</div>
  <div id="txt"><div id="kick"></div><div id="beat"></div></div>
  <div id="veil"><div id="vbrand">TULİ<b>P</b>İ</div><div id="vbar"><div id="vfill"></div></div><div id="vpct">HAZIRLANIYOR</div></div>
</div>
<script>
// ── STORYBOARD v2 — video hikâyesi + canlı menü sayfaları ────────────────
var SAHNE = [
  {tip:'video', klip:'tulipi_mekan',    kick:'TULİPİ',   beat:'Her gün taze.',                         sure:4200, marka:false},
  {tip:'video', klip:'tulipi_grind',    kick:'Zanaat',   beat:'Önce çekirdek.',                        sure:3000, marka:true},
  {tip:'video', klip:'tulipi_espresso', kick:'Zanaat',   beat:'Sonra ateş.',                           sure:4000, marka:true},
  {tip:'video', klip:'tulipi_latte',    kick:'Usta',     beat:'Elin son sözü.',                        sure:3000, marka:true},
  {tip:'menu',  sure:9000},
  {tip:'menu',  sure:9000},
  {tip:'video', klip:'tulipi_iced',     kick:'Serinlik', beat:'Ya da buzlu bir mola.',                 sure:4000, marka:true},
  {tip:'menu',  sure:9000},
  {tip:'video', klip:'tulipi_mekan',    kick:'',         beat:'Zincir gibi hızlı.\nZanaat gibi özenli.', sure:4600, marka:false}
];
var KLIPLER=[]; SAHNE.forEach(function(s){ if(s.klip && KLIPLER.indexOf(s.klip)<0) KLIPLER.push(s.klip); });

var stage=document.getElementById('stage'), veil=document.getElementById('veil'),
    vfill=document.getElementById('vfill'), vpct=document.getElementById('vpct'),
    kick=document.getElementById('kick'), beat=document.getElementById('beat'), brand=document.getElementById('brand'),
    menuEl=document.getElementById('menu'), mkat=document.getElementById('mkat'), malt=document.getElementById('malt'), mlist=document.getElementById('mlist');
var VID={};   // klip adi -> <video> (hepsi belleğe yüklü, hazır)
var aktif=null, i=-1;
var MENU=[], menuKat=0;   // canlı menü kategorileri (/api/tv-menu)

function fiyatMetni(u){
  if(u.f8!=null && u.f14!=null) return u.f8+' / '+u.f14;
  if(u.f8!=null) return ''+u.f8;
  if(u.f14!=null) return ''+u.f14;
  if(u.fice!=null) return u.fice+' buzlu';
  return '';
}
function menuGetir(){
  return fetch('/api/tv-menu').then(function(r){return r.json();}).then(function(d){
    MENU=(d && d.kategoriler)||[];
  }).catch(function(){ MENU=[]; });
}
function menuCiz(){
  if(!MENU.length){ return; }
  var k=MENU[menuKat % MENU.length]; menuKat++;
  mkat.textContent=k.kategori||'';
  malt.textContent=k.alt||((k.urunler||[]).length+' seçenek');
  var html='';
  (k.urunler||[]).slice(0,10).forEach(function(u){
    var f=fiyatMetni(u);
    html+='<div class="mrow"><span class="mad">'+(u.ad||'')+'</span>'
        + (u.aciklama?'<span class="mnote">'+u.aciklama+'</span>':'<span class="mdot"></span>')
        + '<span class="mfiyat">'+f+'</span></div>';
  });
  mlist.innerHTML=html;
}

// ── ÖN-BELLEK: her klibi blob olarak indir → objectURL → hazır <video> ──
// Sahne değişiminde AĞ/DECODE beklemesi olmaz → DONMA YOK (sahip kuralı).
function hazirla(){
  var toplam=KLIPLER.length, bitti=0;
  var ilerle=function(){ bitti++; var p=Math.round(bitti/toplam*100); vfill.style.width=p+'%'; vpct.textContent=p<100?('HAZIRLANIYOR · %'+p):'HAZIR'; };
  var isler=KLIPLER.map(function(n){
    return fetch('/tv-menu/clip/'+n).then(function(r){return r.blob();}).then(function(b){
      return new Promise(function(res){
        var v=document.createElement('video');
        v.muted=true; v.playsInline=true; v.preload='auto'; v.setAttribute('playsinline','');
        v.src=URL.createObjectURL(b);
        var ok=function(){ v.removeEventListener('canplaythrough',ok); try{v.currentTime=0;}catch(e){} ilerle(); res(); };
        v.addEventListener('canplaythrough',ok);
        v.addEventListener('error',function(){ ilerle(); res(); });
        stage.insertBefore(v, document.getElementById('scrim'));
        v.load(); VID[n]=v;
      });
    }).catch(function(){
      // ağ/blob patlarsa: doğrudan stream fallback (yine de çalışsın)
      var v=document.createElement('video'); v.muted=true; v.playsInline=true; v.preload='auto';
      v.setAttribute('playsinline',''); v.src='/tv-menu/clip/'+n;
      stage.insertBefore(v, document.getElementById('scrim')); VID[n]=v; ilerle();
    });
  });
  return Promise.all(isler);
}

function metinYaz(kickTxt, beatTxt){
  kick.classList.remove('show'); beat.classList.remove('show');
  setTimeout(function(){
    kick.textContent=kickTxt||''; beat.innerHTML=(beatTxt||'').replace(/\n/g,'<br>');
    if(kickTxt) kick.classList.add('show');
    if(beatTxt) beat.classList.add('show');
  },420);
}
function goster(s){
  if(s.tip==='menu' && MENU.length){
    // menü sayfası: videoları söndür, menüyü çiz+göster, alt beat'i kapat
    if(aktif){ aktif.classList.remove('on'); aktif=null; }
    menuCiz();
    menuEl.classList.add('on');
    metinYaz('','');
    brand.classList.add('on');
    return;
  }
  // video sahnesi
  menuEl.classList.remove('on');
  var v=VID[s.klip]; if(!v){ return; }
  try{ v.currentTime=0; }catch(e){}
  var pr=v.play(); if(pr&&pr.catch) pr.catch(function(){});
  v.classList.add('on');
  if(aktif && aktif!==v) aktif.classList.remove('on');
  aktif=v;
  metinYaz(s.kick, s.beat);
  if(s.marka) brand.classList.add('on'); else brand.classList.remove('on');
}
function dongu(){
  i=(i+1)%SAHNE.length; var s=SAHNE[i];
  // menü verisi yoksa menü sahnesini atla (video akışı bozulmasın)
  if(s.tip==='menu' && !MENU.length){ return dongu(); }
  goster(s); setTimeout(dongu, s.sure);
}

// TV hep açık; sekme geri gelince aktif video duraksadıysa devam
document.addEventListener('visibilitychange',function(){ if(!document.hidden && aktif && aktif.paused){ var p=aktif.play(); if(p&&p.catch)p.catch(function(){}); } });

// klipler belleğe + menü çekilince perdeyi kaldır ve başla
Promise.all([hazirla(), menuGetir()]).then(function(){
  setTimeout(function(){ veil.classList.add('gone'); dongu(); }, 400);
});
</script>
</body></html>"""


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
:root{--bg:#0e0b09;--bg-soft:#18110d;--panel:rgba(15,11,9,.72);--panel-strong:rgba(11,8,7,.84);--line:rgba(239,230,214,.12);--line-soft:rgba(239,230,214,.06);--cream:#EFE6D6;--muted:#B89B80;--green:#3E8E5A;--green-soft:#6fb786;--gold:#C9A46A}
*{margin:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:radial-gradient(85vw 80vh at 50% -10%,rgba(98,66,34,.28),transparent 62%),linear-gradient(180deg,#1b130f 0%,#110c09 42%,#090706 100%);cursor:none;font-family:'Fraunces',serif;color:var(--cream)}
body::before,body::after{content:"";position:fixed;inset:-12vh -14vw;pointer-events:none;z-index:0;transition:transform 1.1s ease,opacity 1.1s ease}
body::before{background:radial-gradient(58vw 58vw at 50% 24%,rgba(201,164,106,.18),transparent 62%),radial-gradient(72vw 78vw at 50% 82%,rgba(62,142,90,.12),transparent 70%);opacity:.78}
body::after{background:linear-gradient(90deg,transparent 0%,rgba(255,255,255,.05) 50%,transparent 100%);opacity:.25;mix-blend-mode:screen}
body[data-screen="1"]::before{transform:translateX(-16%)}
body[data-screen="2"]::before{transform:translateX(0)}
body[data-screen="3"]::before{transform:translateX(16%)}
body[data-screen="1"]::after{transform:translateX(-10%)}
body[data-screen="2"]::after{transform:translateX(0)}
body[data-screen="3"]::after{transform:translateX(10%)}
/* TV-perf + motion-design Premium arketipi: giriş = saf opacity, cubic-bezier(.4,0,.2,1), taşma yok
   (eski pgIn'in blur(7px)+transform animasyonu gerçek TV'de frame-drop riskiydi — son kalan perf borcu kapandı) */
@keyframes pgIn{from{opacity:0}to{opacity:1}}
/* TV-perf: rowIn/titleIn opacity-only (transform + letter-spacing animasyonu gerçek TV'de yük — tulipi-kurgu kuralı) */
@keyframes rowIn{from{opacity:0}to{opacity:1}}
@keyframes titleIn{from{opacity:0}to{opacity:1}}
@keyframes flo{0%,100%{transform:translateY(0)}50%{transform:translateY(-.7vw)}}
@keyframes halo{0%,100%{opacity:.28;transform:translate(-50%,-50%) scale(.9)}50%{opacity:.62;transform:translate(-50%,-50%) scale(1.13)}}
@keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
@keyframes steam{0%{opacity:0;transform:translateY(.4vw) scaleY(.5)}35%{opacity:.6}100%{opacity:0;transform:translateY(-1.7vw) scaleY(1.4)}}
@keyframes bean{0%{transform:translateY(0) rotate(0);opacity:0}12%{opacity:.45}88%{opacity:.45}100%{transform:translateY(-16vh) rotate(50deg);opacity:0}}
@keyframes glow{0%,100%{transform:translate(-8%,-5%) scale(1);opacity:.45}50%{transform:translate(7%,6%) scale(1.18);opacity:.8}}
@keyframes live{0%,100%{opacity:.8}50%{opacity:1}}
@keyframes ice{0%,100%{opacity:.12;transform:translateY(0)}50%{opacity:.38;transform:translateY(-.7vw)}}
#stage{width:100vw;height:100vh;position:relative;overflow:hidden;isolation:isolate}
#dots{position:absolute;top:8.4vh;left:0;right:0;display:flex;justify-content:center;gap:.6vw;z-index:8}
#dots i{width:.55vw;height:.55vw;border-radius:50%;background:#EFE6D622;transition:.5s}#dots i.on{background:#3E8E5A;width:1.7vw;border-radius:.3vw}
.pg{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;padding:7.5vh 5.6vw 11.5vh;text-align:center}
.pg.cat{justify-content:flex-start;align-items:stretch;padding:12vh 4.7vw 12vh;text-align:left}  /* menu sayfalari artik yapisal panel icinde hizalanir */
.pg.on{display:flex;animation:pgIn .55s cubic-bezier(.4,0,.2,1)}
.pg.on .row{animation:rowIn .55s cubic-bezier(.2,.7,.2,1) both}
.pg.on .gT{animation:titleIn .8s cubic-bezier(.2,.8,.2,1) both}
.bg{position:absolute;inset:0;overflow:hidden;z-index:0;pointer-events:none}
.drift{position:absolute;top:18%;left:28%;width:52vw;height:52vw;border-radius:50%;background:radial-gradient(circle,#2a1c12,transparent 64%);animation:glow 15s ease-in-out infinite}
.bean{position:absolute;width:.7vw;height:.5vw;border-radius:50%;border:.09vw solid #6a533a;animation:bean linear infinite}
.ring{position:absolute;top:46%;left:50%;width:30vw;height:30vw;border-radius:50%;border:1px solid #3E8E5A1f;border-top-color:#3E8E5A66;border-right-color:#3E8E5A40;animation:spin 17s linear infinite}
.halo{position:absolute;top:46%;left:50%;width:42vw;height:42vw;border-radius:50%;background:radial-gradient(circle,#1c5235,#11321f 46%,transparent 70%);animation:halo 6s ease-in-out infinite}
.steam{position:absolute;z-index:3}
/* KÖŞE LOGO — sürekli görünen sabit rozet, artık ayrı bir "Hero" sahnesi yok */
#logoBadge{position:absolute;top:2.6vh;left:3vw;z-index:9;width:6.2vh;opacity:.94;pointer-events:none;filter:drop-shadow(0 .6vh 1.8vh #0008)}
body.opening-active #logoBadge,body.opening-active #screenMeta{opacity:0}
body[data-screen="1"] #logoBadge,body[data-screen="1"] #screenMeta,body[data-screen="1"] #priceCorner,body[data-screen="1"] #fav,body[data-screen="1"] .foot{display:none!important}
body[data-screen="1"] #dots{top:auto;bottom:7vh;opacity:.42}
body[data-screen="2"] #screenMeta,body[data-screen="3"] #screenMeta{display:none!important}
/* GOLDEN TRIANGLE — fiyat/ürün hep aynı sabit köşede (göz "ürün→fiyat" yörüngesini öğrenir) */
#screenMeta{position:absolute;top:2.3vh;left:50%;transform:translateX(-50%);z-index:9;display:flex;align-items:center;gap:1vw;padding:.9vh 1.6vw;border-radius:999px;background:rgba(10,8,7,.46);border:1px solid var(--line-soft);backdrop-filter:blur(10px);box-shadow:0 1.6vh 3.6vh #0007}
#screenMeta .metaIdx{font-size:1.2vh;letter-spacing:.28vw;color:var(--green-soft);text-transform:uppercase}
#screenMeta .metaCopy{display:flex;flex-direction:column;align-items:flex-start;gap:.15vh}
#screenMeta .metaTitle{font-size:1.8vh;color:var(--cream);letter-spacing:.05vw;white-space:nowrap}
#screenMeta .metaSub{font-size:1.15vh;letter-spacing:.16vw;color:#8e8174;text-transform:uppercase}
#screenFrame{position:absolute;inset:1.7vh 1.25vw;z-index:5;border:1px solid var(--line-soft);border-radius:3.6vh;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02),inset 0 0 0 1.8vh rgba(0,0,0,.08),0 2.6vh 6vh #0008}
#screenFrame::before,#screenFrame::after{content:"";position:absolute;left:3.6vw;right:3.6vw;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent)}
#screenFrame::before{top:7.8vh}
#screenFrame::after{bottom:8.6vh}
#priceCorner{position:absolute;top:2.8vh;right:3vw;z-index:9;display:none;flex-direction:column;align-items:flex-end;text-align:right;transition:opacity .4s ease;padding:1vh 1.2vw;border-radius:2vh;background:rgba(10,8,7,.42);border:1px solid var(--line-soft);backdrop-filter:blur(10px);box-shadow:0 1.4vh 3.2vh #0006}
#priceCorner.on{display:flex}
#priceCorner .pcName{font-size:1.45vh;color:#B89B80;font-style:italic;letter-spacing:.03vw;max-width:28vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#priceCorner .pcPrice{font-size:2.45vh;font-weight:700;color:#3E8E5A}
/* BARDAK AÇILIŞ — ilk 3sn sade gerçek bardak fotoğrafı (Ken Burns yavaş zoom), metin/fiyat sonra belirir */
@keyframes kenBurns{0%{transform:scale(1.04)}100%{transform:scale(1.16)}}
@keyframes bardakReveal{0%,38%{opacity:0;transform:translateY(1.6vh)}55%,100%{opacity:1;transform:none}}
.bardakBg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;animation:kenBurns 7s ease-out forwards;filter:saturate(1.12) contrast(1.06) brightness(.86)}
.cupProductStage{position:absolute;inset:0;z-index:0;background:radial-gradient(62% 44% at 50% 42%,rgba(201,164,106,.14),transparent 62%),radial-gradient(64% 50% at 50% 76%,rgba(62,142,90,.11),transparent 70%),linear-gradient(180deg,#120c08 0,#070403 100%)}
.cupProduct{position:absolute;left:50%;top:47%;width:min(62vw,46vh);max-height:66vh;object-fit:contain;transform:translate(-50%,-50%) scale(1);filter:drop-shadow(0 3.1vh 5vh rgba(0,0,0,.72));animation:cupProductDrift 7s ease-out forwards;transform-origin:50% 50%}
.cupProductStage .bggrade{z-index:1}
@keyframes cupProductDrift{0%{transform:translate(-50%,-50%) scale(1)}100%{transform:translate(-50%,-50%) scale(1.06)}}
.bardakInfo{position:relative;z-index:2;opacity:0;animation:bardakReveal 7s ease forwards}
.openingBg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;animation:openingDrift 3s ease-out forwards;transform-origin:42% 54%;backface-visibility:hidden}
.openingShade{position:absolute;inset:0;z-index:1;background:linear-gradient(90deg,rgba(0,0,0,.05) 0%,rgba(0,0,0,.16) 44%,rgba(0,0,0,.44) 74%,rgba(0,0,0,.68) 100%)}
.openingCopy{position:absolute;z-index:2;right:7.8vw;top:14.5vh;width:40vw;display:flex;flex-direction:column;align-items:center;text-align:center;color:var(--cream)}
.openingLogo{width:11.8vw;max-height:20vh;object-fit:contain;opacity:0;mix-blend-mode:screen;filter:drop-shadow(0 1vh 2.8vh #000b);animation:openingLogoIn 3s ease forwards}
.openingTitle{margin-top:0;font-family:'Fraunces',serif;font-size:4.8vh;line-height:1.08;font-weight:400;letter-spacing:.01vw;color:#efe6d6;text-shadow:0 .45vh 2.4vh #000;opacity:0;animation:openingTitleIn 3s ease forwards}
.openingTitle span{display:block}
.openingSub{margin-top:1.8vh;font-size:1.75vh;letter-spacing:.32vw;color:#c9bba4;text-transform:uppercase;opacity:0;animation:openingSubIn 3s ease forwards}
@keyframes openingDrift{0%{transform:scale(1.02) translateX(-1.2vw)}100%{transform:scale(1.09) translateX(.4vw)}}
@keyframes openingLogoIn{0%,18%{opacity:0;transform:translateY(1.2vh)}36%,100%{opacity:.94;transform:none}}
@keyframes openingTitleIn{0%,34%{opacity:0;transform:translateY(1.6vh)}54%,100%{opacity:1;transform:none}}
@keyframes openingSubIn{0%,58%{opacity:0;transform:translateY(1vh)}76%,100%{opacity:.86;transform:none}}
/* EKRAN 1 — 12sn premium davet akışı: craft açılış → tek hero ürün → yaz/soğuk çağrı */
.e1Scene{background:#080503;overflow:hidden}
.e1Scene .bgvid{opacity:.8;animation:e1Push linear forwards;will-change:transform}
.e1HeroScene .bgvid{animation-duration:4s}
.e1Cold .bgvid{animation-duration:5s}
.e1Scene .bggrade{background:linear-gradient(180deg,#05030299 0,rgba(5,3,2,.32) 30%,rgba(5,3,2,.36) 66%,#050302e8 100%)}
.e1HeroScene{background:radial-gradient(70% 46% at 50% 38%,rgba(201,164,106,.18),transparent 62%),radial-gradient(80% 64% at 48% 82%,rgba(62,142,90,.12),transparent 70%),linear-gradient(180deg,#120c08 0,#070403 100%)}
.e1HeroScene .e1Studio{position:absolute;inset:0;z-index:0;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent 26%),radial-gradient(52% 32% at 50% 72%,rgba(255,225,174,.11),transparent 70%)}
.e1Cold{background:radial-gradient(58% 36% at 50% 35%,rgba(201,164,106,.16),transparent 64%),radial-gradient(72% 58% at 48% 75%,rgba(62,142,90,.12),transparent 72%),linear-gradient(180deg,#120c08 0,#070403 100%)}
.e1ColdStudio{position:absolute;inset:0;z-index:0;background:linear-gradient(180deg,rgba(255,255,255,.04),transparent 24%),radial-gradient(60% 22% at 50% 62%,rgba(255,228,184,.1),transparent 72%),linear-gradient(90deg,rgba(0,0,0,.28),transparent 34%,rgba(0,0,0,.34) 100%)}
.e1HeroScene .e1CupAura{position:absolute;z-index:1;left:50%;top:43%;width:54vw;height:54vw;max-width:42vh;max-height:42vh;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,rgba(201,164,106,.18),rgba(62,142,90,.08) 45%,transparent 72%);filter:blur(.2vh)}
.e1RealCup{position:absolute;z-index:2;left:50%;top:37%;width:min(58vw,43vh);max-height:60vh;object-fit:contain;transform:translate(-50%,-50%);opacity:0;filter:drop-shadow(0 3.2vh 5.4vh rgba(0,0,0,.72));animation:e1CupIn 4s ease both}
.e1ColdCup{position:absolute;z-index:2;left:50%;top:39%;width:min(55vw,40vh);max-height:58vh;object-fit:contain;transform:translate(-50%,-50%);opacity:.96;filter:drop-shadow(0 3vh 5vh rgba(0,0,0,.7));animation:e1ColdCupIn 5s ease both}
.e1Cold.e1NoCup .e1Block{bottom:24%;left:7vw;right:7vw}
.e1Cold.e1NoCup .e1Title{max-width:86vw}
.e1Cold.e1NoCup .e1ColdStudio{background:linear-gradient(180deg,rgba(255,255,255,.045),transparent 24%),radial-gradient(58% 22% at 50% 48%,rgba(255,228,184,.12),transparent 72%),radial-gradient(80% 54% at 48% 72%,rgba(62,142,90,.1),transparent 74%),linear-gradient(90deg,rgba(0,0,0,.3),transparent 34%,rgba(0,0,0,.36) 100%)}
.e1HeroScene .e1Block{align-items:center;text-align:center;bottom:13%;left:8vw;right:8vw}
.e1HeroScene .e1Desc{max-width:82vw}
.e1Block{position:absolute;z-index:3;left:7vw;right:7vw;bottom:18%;display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:1.15vh;color:var(--cream)}
.e1HeroScene .e1Block,.e1Cold .e1Block{opacity:0;animation:e1TextIn .72s ease .45s both}
.e1Kicker{font-size:1.45vh;letter-spacing:.34vw;color:#c9bba4;text-transform:uppercase}
.e1Title{font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:5.7vh;line-height:1.04;letter-spacing:0;color:#efe6d6;max-width:76vw}
.e1Desc{font-size:2vh;line-height:1.45;color:#bba98f;font-style:italic;max-width:70vw}
.e1Fade{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 35%,#000 100%);animation:e1Fade linear both}
.e1HeroScene .e1Fade{animation-duration:4s}
.e1Cold .e1Fade{animation-duration:5s}
@keyframes e1Push{from{transform:scale(1)}to{transform:scale(1.05)}}
@keyframes e1TextIn{from{opacity:0;transform:translateY(1vh)}to{opacity:1;transform:none}}
@keyframes e1CupIn{0%,12%{opacity:0;transform:translate(-50%,-48%) scale(.97)}28%,100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}
@keyframes e1Fade{0%,86%{opacity:0}100%{opacity:.72}}
/* EKRAN 3 — 12sn upsell/keşif akışı: yeni ürün → craft → sessiz öneri → tatlı eşleşmesi */
.e3Flow{background:#070403;overflow:hidden}
.e3Flow .bgvid{opacity:.82;animation:e1Push 3s linear forwards}
.e3Flow .bggrade{background:linear-gradient(180deg,#050302a3 0,rgba(5,3,2,.38) 35%,rgba(5,3,2,.5) 68%,#050302ef 100%)}
.e3Flow .e3Block{position:absolute;z-index:3;left:7vw;right:7vw;bottom:17%;display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:1.05vh;color:var(--cream);opacity:0;animation:e1TextIn .55s ease .25s both}
.e3Kicker{font-size:1.35vh;letter-spacing:.34vw;color:#c9bba4;text-transform:uppercase}
.e3Title{font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:5.35vh;line-height:1.04;color:#efe6d6;max-width:78vw}
.e3Desc{font-size:1.95vh;line-height:1.45;color:#bba98f;font-style:italic;max-width:72vw}
.e3Fade{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 35%,#000 100%);animation:e3Fade 3s linear both}
@keyframes e3Fade{0%,82%{opacity:0}100%{opacity:.72}}
/* mikro cross-sell şeridi — her kategori sayfasının altında tekrar eden Perfect Pair hatırlatması */
.pairStrip{position:absolute;bottom:2.2vh;left:1.7vw;right:1.7vw;z-index:5;display:flex;align-items:center;justify-content:center;gap:.8vw;font-size:1.45vh;color:#B89B80;padding:1vh 1.2vw;border-radius:2vh;background:rgba(13,10,8,.88);border:1px solid var(--line-soft)}
.pairStrip b{color:#EFE6D6;font-style:normal;font-family:'Fraunces',serif}
.pairStrip span.tag{background:#3E8E5A;color:#0e0b09;font-weight:700;padding:.25vh 1vw;border-radius:30px;font-size:.85em;text-transform:uppercase;letter-spacing:.05vw}
.q{position:relative;z-index:2;font-style:italic;font-size:2.6vh;color:#B89B80;margin-top:2.4vh;letter-spacing:.1vw}
/* E2 editoryal hiyerarşi: kicker yeşil fısıldar, BAŞLIK krem (yeşil başlık = marka bağırması, tulipi-kurgu revizyonu) */
.gT{font-size:4.8vh;font-weight:400;font-style:italic;color:var(--cream);letter-spacing:.06vw;margin-bottom:.5vh;line-height:1.02}
.gH{font-size:1.3vh;letter-spacing:.28vw;color:#7d7065;margin-bottom:0;text-transform:uppercase}
.menuShell{position:relative;z-index:2;display:flex;flex-direction:column;gap:1.8vh}
.menuHead{display:flex;align-items:flex-end;justify-content:space-between;gap:2vw;padding:0 .6vw}
.menuMeta{display:flex;flex-direction:column;gap:.6vh;min-width:0}
.menuKicker{font-size:1.25vh;letter-spacing:.34vw;color:var(--green-soft);text-transform:uppercase}
.menuRole{font-size:1.2vh;letter-spacing:.16vw;color:#908171;text-transform:uppercase}
.menuPageTag{flex-shrink:0;padding:.8vh 1vw;border-radius:999px;border:1px solid var(--line-soft);background:rgba(11,8,7,.46);font-size:1.18vh;letter-spacing:.18vw;color:#b8aa9a;text-transform:uppercase}
/* TV-perf: backdrop-filter kaldırıldı (arkada canlı duvar animasyonu varken sürekli GPU yükü) → opak degrade */
.menuPanel{position:relative;padding:2.35vh 1.8vw 2.8vh;border-radius:2.8vh;background:linear-gradient(180deg,rgba(16,12,10,.88),rgba(9,7,6,.94));border:1px solid rgba(239,230,214,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 2vh 4.4vh #0007;overflow:hidden}
.menuPanel::before{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:14vh;background:linear-gradient(180deg,rgba(255,255,255,.045),transparent);pointer-events:none}
.menu{position:relative;width:100%;max-width:none;font-size:2.08vh}
.menu.one{max-width:none}
/* kolon başlıkları: hap kutuları kalktı → sade harf-aralıklı caps + ince ayraç (editoryal sükunet) */
.hdr{display:grid;grid-template-columns:1fr 4.05em 4.05em 4.05em;gap:.9em;font-size:.56em;letter-spacing:.22vw;color:#9a8d80;margin-bottom:.4vh;padding:0 1vw .7vh;border-bottom:1px solid var(--line)}.hdr span{text-align:center}
.row{display:grid;grid-template-columns:1fr 4.05em 4.05em 4.05em;gap:.9em;align-items:center;padding:1.45vh 1vw;border-top:1px solid rgba(255,255,255,.075)}
.row:nth-child(even){background:rgba(255,255,255,.012)}
.row.one{grid-template-columns:1fr auto}
.nm{font-size:1em;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:.6vw}.nm small{display:block;font-size:.52em;color:#B89B80;font-style:italic;margin-left:0;margin-top:.35vh;letter-spacing:.03vw}
.pr{font-size:.95em;font-weight:500;text-align:center}.pr.d{color:#ffffff22}
/* 🎬 E2 GEÇİŞ KOREOGRAFİSİ (tulipi-kurgu): giriş opacity-only (pgIn'in blur+transform'u TV'de ağır),
   çıkışta alt-ağırlıklı kararma → sonraki sayfa karanlıktan doğar = yumuşak sözde-crossfade */
.pg.cat.on{animation:catIn .5s ease}
.pg.cat .catFade{position:absolute;inset:0;z-index:6;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 30%,#000d 100%);animation:catFade 12s linear both}
@keyframes catIn{from{opacity:0}to{opacity:1}}
@keyframes catFade{0%,94%{opacity:0}100%{opacity:.6}}
/* 🎬 E2 MENÜ KAPAĞI — 5sn nefes sahnesi: fiyatsız, loop'a ritim verir */
.pg.mcov{background:#0b0705}
.pg.mcov.on{animation:catIn .5s ease}
.mcov .mcovInner{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:2.2vh;text-align:center}
.mcov .mcovKick{font-size:1.5vh;letter-spacing:.55vw;color:var(--green-soft);text-transform:uppercase;opacity:0;animation:mcv1 5s ease both}
.mcov .mcovTitle{font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:6vh;color:var(--cream);line-height:1.15;max-width:80vw;opacity:0;animation:mcv2 5s ease both}
.mcov .mcovCats{font-size:1.7vh;letter-spacing:.3vw;color:#9c8d7c;text-transform:uppercase;opacity:0;animation:mcv3 5s ease both}
.mcov .mcovFade{position:absolute;inset:0;z-index:3;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 30%,#000d 100%);animation:mcv4 5s linear both}
/* 🎬 FAZ1 SATIŞ/KEŞİF KARTLARI — E1 "Günün Seçimi" (gsec) + E3 "Baristanın Sessiz Önerisi" (bsec).
   Fiyat rampanın ödülü: İLK KEZ burada, ama bağırmaz (krem, sade — eski yeşil hap/glow YOK).
   Halo STATİK, tüm girişler opacity-only (eski spotlight'ın halo/flo/priceSettle transformları TV yasağı). */
.pg.pick{background:#0b0705}
.pg.pick.on{animation:catIn .5s ease}
.pick .pHalo{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%);width:46vw;height:46vw;border-radius:50%;background:radial-gradient(circle,#1c523522,#11321f18 46%,transparent 70%)}
.pick.bsec .pHalo{background:radial-gradient(circle,#52401c22,#32270f18 46%,transparent 70%)}
.pick .pInner{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;text-align:center;gap:1.1vh}
.pick .pTag{font-size:1.5vh;letter-spacing:.4vw;color:var(--green-soft);text-transform:uppercase;opacity:0;animation:pk1 9s ease both}
.pick.bsec .pTag{color:var(--gold)}
.pick .pCup{width:min(42vw,28vh);max-height:37vh;object-fit:contain;filter:drop-shadow(0 2.2vh 4.2vh rgba(0,0,0,.72));opacity:0;animation:pk2 9s ease both}
.pick .pName{font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:5.6vh;color:var(--cream);opacity:0;animation:pk2 9s ease both}
.pick .pNote{font-size:2vh;color:#B89B80;font-style:italic;opacity:0;animation:pk3 9s ease both}
.pick .pPrice{margin-top:1vh;font-size:3vh;font-weight:600;color:#f2e6cf;opacity:0;animation:pk4 9s ease both}
.pick .pBridge{margin-top:1.6vh;padding-top:1.4vh;border-top:1px solid var(--line-soft);font-size:1.7vh;color:#B89B80;font-style:italic;opacity:0;animation:pk5 9s ease both}
.pick .pBridge b{color:#cfc3b2;font-weight:500;font-style:normal}
.pick .pFade{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 35%,#000d 100%);animation:pkF 9s linear both}
@keyframes pk1{0%,4%{opacity:0}11%,100%{opacity:.92}}
@keyframes pk2{0%,9%{opacity:0}18%,100%{opacity:1}}
@keyframes pk3{0%,16%{opacity:0}23%,100%{opacity:.95}}
@keyframes pk4{0%,24%{opacity:0}32%,100%{opacity:1}}
@keyframes pk5{0%,36%{opacity:0}44%,100%{opacity:.95}}
@keyframes pkF{0%,92%{opacity:0}100%{opacity:.6}}
/* 🎬 SEZON SAHNESİ (yaz: gün batımı mocktail atmosferi; fiyatsız — "kendi menünün içindeki reklam") */
.pg.szn{background:#0b0705}
.pg.szn.on{animation:catIn .5s ease}
.szn .e1ColdStudio{animation:e1Push 9s linear forwards}
.szn .sznCup{position:absolute;left:50%;top:42%;z-index:2;width:min(60vw,43vh);max-height:62vh;object-fit:contain;transform:translate(-50%,-50%);filter:drop-shadow(0 3.2vh 5.4vh rgba(0,0,0,.72));opacity:.96;animation:e1ColdCupIn 9s ease both}
.szn .sznShade{position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,#050302b8 0,rgba(5,3,2,.34) 36%,rgba(5,3,2,.5) 68%,#050302ee 100%)}
.szn .sznTxt{position:absolute;right:7vw;bottom:30%;z-index:2;text-align:right;font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:4.6vh;color:var(--cream);text-shadow:0 .3vh 1.8vh rgba(0,0,0,.6);opacity:0;animation:pk3 9s ease both}
.szn .sznSub{position:absolute;right:7vw;bottom:23%;z-index:2;text-align:right;font-size:1.8vh;letter-spacing:.2vw;color:#B89B80;text-transform:uppercase;opacity:0;animation:pk5 9s ease both}
@keyframes szBg{0%{opacity:0}8%,100%{opacity:1}}
@keyframes e1ColdCupIn{0%{opacity:.86;transform:translate(-50%,-48%) scale(.985)}18%,100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}
/* 🎬 MARKA İMZA SAHNESİ — loop kapanışı: logo + DNA sloganı (fiyatsız, 6sn nefes) */
.pg.imza{background:#080503}
.pg.imza.on{animation:catIn .5s ease}
.imza .imzaInner{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;text-align:center;gap:2.6vh}
.imza .imzaLogo{width:10vw;max-height:20vh;object-fit:contain;mix-blend-mode:screen;filter:drop-shadow(0 1vh 2.6vh #000b);opacity:0;animation:im1 6s ease both}
.imza .imzaTxt{font-family:'Fraunces',serif;font-style:italic;font-weight:400;font-size:4.4vh;line-height:1.3;color:var(--cream);opacity:0;animation:im2 6s ease both}
.imza .imzaTxt span{display:block}
.imza .imzaBg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.5;z-index:0}
.imza .imzaShade{position:absolute;inset:0;z-index:1;background:radial-gradient(90% 90% at 50% 45%,transparent 20%,#080503ee 78%)}
@keyframes im1{0%,8%{opacity:0}22%,100%{opacity:.96}}
@keyframes im2{0%,26%{opacity:0}42%,100%{opacity:1}}
/* .pick sahnelerine gerçek tezgâh dokusu (ambient katman — motion-design 3-katman ilkesi) */
.pick .pDoku{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.3;z-index:0}
.pick .pHalo{z-index:1}
/* EVRENSEL ÇIKIŞ KARARMASI — yüzde-bazlı keyframe + sahne süresi inline verilir → her sürede çalışır */
.exitFade{position:absolute;inset:0;z-index:9;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 35%,#000d 100%);animation:exF linear both}
@keyframes exF{0%,92%{opacity:0}100%{opacity:.6}}
/* 🎬 HAFTANIN FAVORİLERİ (sosyal kanıt listesi — kategori başına gerçek liderler) */
.pick .pList{display:flex;flex-direction:column;gap:2.2vh;margin-top:1vh}
.pick .pLi{opacity:0}
.pick .pLi .pLiKat{font-size:1.4vh;letter-spacing:.3vw;color:#9c8d7c;text-transform:uppercase}
.pick .pLi .pLiAd{font-family:'Fraunces',serif;font-style:italic;font-size:4vh;color:var(--cream)}
.pick .pLi:nth-child(1){animation:pk2 9s ease both}
.pick .pLi:nth-child(2){animation:pk3 9s ease both}
.pick .pLi:nth-child(3){animation:pk4 9s ease both}
@keyframes mcv1{0%,8%{opacity:0}20%,100%{opacity:.9}}
@keyframes mcv2{0%,18%{opacity:0}34%,100%{opacity:1}}
@keyframes mcv3{0%,34%{opacity:0}50%,100%{opacity:.92}}
@keyframes mcv4{0%,88%{opacity:0}100%{opacity:.65}}
/* ANCHORING — 8oz sönük (küçük tetikleyici), Ice/14oz aksan-yeşil+büyük (asıl hedef bedef) */
/* fiyat hiyerarşisi (menü mühendisliği): 14oz = "mantıklı seçim" tam vurgu (krem/altın tonu),
   ICE orta, 8oz sakin — rozet/patlama yok, sadece tipografik ağırlık */
.pr.sec{color:#9c8d7c;font-size:.82em;font-weight:400}
.pr.acc{color:#f2e6cf;font-weight:600;font-size:1.08em}
.pr.mid{color:#cfc3b2;font-size:.94em;font-weight:500}
.hdr span:nth-child(3){color:#d8cbb8}
/* ✦ en sevilen — kategori başına TEK ürün, Evo verisinden otomatik; küçük, italik, animasyonsuz */
.favTag{margin-left:.7vw;font-size:.5em;letter-spacing:.06vw;color:var(--gold);font-style:italic;white-space:nowrap}
/* Barista notu — panel altı tek satır uzman fısıltısı */
.bNote{margin-top:1.4vh;padding:1.1vh 1vw 0;border-top:1px solid var(--line-soft);font-size:1.5vh;color:#B89B80;font-style:italic;letter-spacing:.03vw}
.bNote b{color:#cfc3b2;font-style:normal;font-weight:500}
.pr.d{color:#ffffff22;font-weight:400}  /* boş hücre çizgisi soluk kalır (sec/mid/acc'i ezer) */
.heroPg{align-items:flex-start;text-align:left;justify-content:flex-end}
.heroPg .sceneInner{position:relative;z-index:2;max-width:70vw;display:flex;flex-direction:column;align-items:flex-start}
.heroPg .spotTag,.heroPg .q,.heroPg .brandLabel,.heroPg .musteriTag{margin-left:.4vw}
.heroPg .spotName{font-size:6.1vh;line-height:1.02;max-width:70vw}
.heroPg .spotDesc{max-width:66vw;margin-bottom:2.2vh}
.heroPg .spotPrice{padding:1.15vh 4.8vw}
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
.bgvid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:.5;transform:translateZ(0);backface-visibility:hidden;will-change:opacity}
.bggrade{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,#0e0b09cc 0,#0e0b0966 28%,#0e0b0966 70%,#0e0b09e6 100%)}
.comboTitle{position:relative;z-index:2;font-size:3.6vh;font-style:italic;color:#EFE6D6;margin-top:1.2vh;text-shadow:0 .3vw 1.5vw #000}
/* 🔥 TOP-3 — gösterişli sosyal kanıt: glow rank, animasyonlu yüzde barı, gerçek video arka plan */
.t3wrap{position:relative;z-index:2;width:90vw;max-width:90vw}
.top3pg .t3wrap{width:100%;max-width:none;padding:2vh 1.6vw 2.4vh;border-radius:3.2vh;background:linear-gradient(180deg,rgba(17,13,11,.72),rgba(9,7,6,.88));border:1px solid var(--line);box-shadow:0 2.2vh 5vh #0008;backdrop-filter:blur(10px)}
.top3pg .gT{margin-bottom:1.8vh}
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
.cupShot{position:relative;z-index:2;width:min(42vw,28vh);max-height:38vh;object-fit:contain;filter:drop-shadow(0 2.2vh 4.2vh rgba(0,0,0,.72));animation:flo 4s ease-in-out infinite;margin:1.2vh 0 .6vh}
/* FAZ 7 — Perfect Pair upsell */
.pair{position:relative;z-index:2;margin-top:2.8vh;display:flex;flex-direction:column;align-items:center;gap:.7vh;animation:pairIn 1s ease 1.1s both}
.pairTag{font-size:1.3vh;letter-spacing:.32vw;color:#0e0b09;background:#B89B80;padding:.5vh 1.5vw;border-radius:40px;text-transform:uppercase}
.pairTxt{font-family:'Fraunces',serif;font-size:2.4vh;color:#EFE6D6}
.pairSub{font-size:1.5vh;color:#B89B80;font-style:italic}
@keyframes pairIn{from{opacity:0;transform:translateY(1.6vh)}to{opacity:1;transform:none}}
.foot{position:absolute;bottom:2.8vh;left:0;right:0;text-align:center;z-index:8}
.foot #live{display:inline-flex;align-items:center;justify-content:center;min-width:46vw;padding:1.05vh 1.8vw;border-radius:999px;background:rgba(10,8,7,.56);border:1px solid var(--line-soft);font-size:1.45vh;letter-spacing:.15vw;color:#7fae93;transition:opacity .5s;backdrop-filter:blur(10px)}
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
#cine video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:translateZ(0);backface-visibility:hidden}
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
/* 🎬 SAHNE 2 — "ÖZEN KATMANI" (iç isim; 6.5sn, kullanıcı şartnamesi 2026-07-02).
   Görev: Sahne 1 premium hissini "özenle hazırlanıyor"a çevirir, Sahne 3 öne-çıkanlara rampa kurar.
   Omurga = still hero (video süs); mikro video tek oynar son karede donar (loop yok);
   TÜM animasyonlar opacity-only (Codex gerçek-TV bulgusu: transform/grain = frame drop). */
.pg.ozen{background:#0b0705}
.pg.ozen.on{animation:ozenIn .5s ease}
.ozen .ozHero{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.ozen .ozVid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;transform:translateZ(0);backface-visibility:hidden}
/* statik atmosfer katmanları: letterbox gradient + sıcak ambient ışık lekesi (animasyonsuz = bedava) */
.ozen .ozGrade{position:absolute;inset:0;z-index:2;pointer-events:none;background:linear-gradient(180deg,#000a 0,transparent 24%,transparent 70%,#000c 100%)}
.ozen .ozAmb{position:absolute;inset:0;z-index:2;pointer-events:none;background:radial-gradient(90% 60% at 30% 22%,#C8956A14,transparent 65%)}
/* metinler: sol-alt güvenli alan, krem, glow'suz, aynı anda tek satır */
.ozen .ozTxt{position:absolute;left:7vw;right:7vw;bottom:23%;z-index:3;text-align:left;font-family:'Fraunces',serif;font-weight:400;font-size:4.2vh;letter-spacing:.05vw;color:#EFE6D6;text-shadow:0 .3vh 1.8vh rgba(0,0,0,.65);opacity:0}
.ozen .ozT1{animation:ozT1 12s ease both}
.ozen .ozT2{animation:ozT2 12s ease both}
/* çıkış: son 1.2sn alt bölge hafif kararır — Sahne 3 kartlarına zemin, doğrudan gösterim YOK */
.ozen .ozExit{position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent 38%,#000d 100%);animation:ozExit 12s linear both}
@keyframes ozenIn{0%{opacity:0}100%{opacity:1}}
/* zaman çizelgesi (6.5sn): T1 1.5-3.2 / nefes 3.2-3.6 / T2 3.6-5.3 / zemin 5.3-6.5 */
@keyframes ozT1{0%,23%{opacity:0}31%{opacity:.96}45%{opacity:.96}51%,100%{opacity:0}}
@keyframes ozT2{0%,55%{opacity:0}63%{opacity:.96}81%{opacity:.96}91%,100%{opacity:0}}
@keyframes ozExit{0%,82%{opacity:0}100%{opacity:.65}}
</style></head>
<body><div id="stage">
<div class="bg" id="bg"><div class="drift"></div></div>
<div id="tod"></div>
<div id="wall"></div>
<div id="season"></div>
<div id="fav"></div>
<img id="logoBadge" src="/tv-menu/logo" alt="">
<div id="screenMeta"><div class="metaIdx"></div><div class="metaCopy"><div class="metaTitle"></div><div class="metaSub"></div></div></div>
<div id="screenFrame"></div>
<div id="priceCorner"><div class="pcName"></div><div class="pcPrice"></div></div>
<div id="dots"></div>
<div class="foot"><span id="live">TÜM FİYATLAR TL · TULİPİ COFFEE</span></div>
<div id="cine"><video muted loop playsinline preload="auto"></video><div class="cgrade"></div><div class="ccap"><div class="ct"></div><div class="cs"></div></div></div></div>
<script>
var API="/api/tv-menu", SIG="/api/tv-signals", CACHE="tulipi_tv_menu", LAST_BUILD_KEY="", CUP_ASSET_REV="20260704-cutout-v3";
function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
function priceRow(u,three,i,fav){
  // koreografi: başlık 0-0.5s → satırlar 0.30s'den itibaren 70ms kademe (motion-design stagger, opacity-only)
  var dly=' style="animation-delay:'+(0.30+(i||0)*0.07).toFixed(2)+'s"';
  var favHtml=fav?'<span class="favTag">✦ en sevilen</span>':'';
  if(three){
    // menü mühendisliği: 14oz tam vurgu (acc), ICE orta (mid), 8oz sakin (sec) — "mantıklı seçim" 14oz
    function cell(v,cls){return '<span class="pr '+cls+(v==null?' d':'')+'">'+(v==null?'–':v)+'</span>';}
    return '<div class="row"'+dly+'><span class="nm">'+u.ad+favHtml+(u.aciklama?'<small>'+u.aciklama+'</small>':'')+'</span>'+cell(u.f8,'sec')+cell(u.f14,'acc')+cell(u.fice,'mid')+'</div>';
  }
  var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);
  return '<div class="row one"'+dly+'><span class="nm">'+u.ad+favHtml+'</span><span class="pr acc">'+(v==null?'–':v)+'</span></div>';
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
  var all=n+" "+k;
  if(/mocktail|green|mojito|limonata|lemonade|cooler/.test(all))return "mocktail";
  if(/ice|iced|buz|cold|frozen|milkshake|frappe|smoothie/.test(all))return "iced";
  if(/latte|flat white|cappuccino|macchiato|mocha|sütlü|sutlu/.test(all))return "latte";
  return "hot";
}
function cupUrl(name){return "/tv-menu/cup/"+name+"?v="+CUP_ASSET_REV;}
function cupSrcFor(info){return cupUrl(cupShotFor(info&&info.ad,info&&info.kategori));}
function findPrice(name){var r=null;if(!window._tvData||!name)return null;
  (window._tvData.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(name).toLowerCase()){var v=u.f8!=null?u.f8:(u.f14!=null?u.f14:u.fice);if(v!=null)r=v;}});});
  return r;}
function findKategori(name){var r="";if(!window._tvData||!name)return r;
  (window._tvData.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(name).toLowerCase())r=k.kategori;});});
  return r;}
// 🍰 YAŞAYAN TATLI-KAHVE MATRİSİ (GPT vizyonu, kullanıcı onaylı 2026-07-03) — saat moduna göre
// eşleşme döner (7 dk'da bir aynı mod içinde alternatif). Manuel pair ayarı yerine bu birincil.
var TATLI_MATRIS={
  sabah:[{k:"Americano",t:"Croissant",c:"Güne sade başlayanlara."},
         {k:"Latte",t:"Cookie",c:"Yumuşak kahvenin yanına risksiz bir dokunuş."}],
  ogle: [{k:"Ice Latte",t:"San Sebastian",c:"Soğuk kahve, kremamsı bir eşlikçiyle daha iyi akar."},
         {k:"Ice Americano",t:"Brownie",c:"Sert kahve, yoğun kakaoyla dengelenir."}],
  aksam:[{k:"Flat White",t:"San Sebastian",c:"Daha yoğun kahve, daha yumuşak final."},
         {k:"Mocha",t:"Cookie",c:"Çikolata sevenler için çift katmanlı keyif."}]
};
function pairSec(sig){
  var mod=(sig&&sig.saat_modu&&sig.saat_modu.mod)||"";
  var liste=TATLI_MATRIS[mod]||TATLI_MATRIS.ogle;
  return liste[Math.floor(Date.now()/420000)%liste.length];
}
function productInfo(ad,data){
  var info={ad:ad||"",kategori:"",aciklama:""};
  (data.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){
    if(String(u.ad).toLowerCase()===String(ad).toLowerCase()){
      info={ad:u.ad,kategori:k.kategori||"",aciklama:u.aciklama||""};
    }
  });});
  return info;
}
function e1HeroProduct(data,sig){
  var ad=(sig&&sig.en_cok)||"";
  if(!ad&&data.imza&&data.imza.ad)ad=data.imza.ad;
  if(!ad&&sig&&sig.oneri&&sig.oneri.ad)ad=sig.oneri.ad;
  if(!ad){
    (data.kategoriler||[]).some(function(k){return (k.urunler||[]).some(function(u){
      if(/latte/i.test(u.ad)){ad=u.ad;return true;}return false;
    });});
  }
  if(!ad)return null;
  var info=productInfo(ad,data);if(!info.ad)info.ad=ad;
  return info;
}
function e1HeroNote(info){
  var n=(info.ad||"").toLowerCase(),a=(info.aciklama||"").trim();
  if(a&&a.length<=58)return a;
  if(/latte|flat white|cappuccino/.test(n))return "İpeksi süt, dengeli espresso.";
  if(/americano|filtre|brew|cold/.test(n))return "Net kahve karakteri, uzun içim.";
  if(/mocha|chocolate|çikolata/.test(n))return "Kakao dokusu, yumuşak kahve dengesi.";
  return "Yumuşak içim, karakterli bitiş.";
}
function e1ColdProduct(data,sig){
  var ad="";
  if(sig&&sig.yeni){for(var i=0;i<sig.yeni.length;i++){if(/ice|iced|cold|frozen|mocktail|buz/i.test(sig.yeni[i])){ad=sig.yeni[i];break;}}}
  if(!ad&&sig&&sig.kategori_fav)ad=sig.kategori_fav["Iced & Cold"]||sig.kategori_fav["Cold Drinks"]||"";
  if(!ad){
    (data.kategoriler||[]).some(function(k){return /(iced|cold|mocktail|milkshake|frozen|soğuk|soguk)/i.test(k.kategori||"")&&(k.urunler||[]).some(function(u){
      ad=u.ad;return true;
    });});
  }
  if(!ad)ad="Ice Latte";
  var info=productInfo(ad,data);if(!info.ad)info.ad=ad;
  return info;
}
function e1ColdClip(info){
  var n=((info&&info.ad)||"").toLowerCase(),k=((info&&info.kategori)||"").toLowerCase();
  if(/frozen|milkshake/.test(n+k))return "frozen";
  if(/mocktail|green/.test(n+k))return "mocktail";
  return "frozen";
}
function e1ColdCupName(info){
  var n=((info&&info.ad)||"").toLowerCase(),k=((info&&info.kategori)||"").toLowerCase(),all=n+" "+k;
  if(/milkshake|frozen|oreo|smoothie/.test(all))return "";
  if(/mocktail|mojito|limonata|lemonade|cooler/.test(all))return "mocktail";
  return "iced";
}
function e1ColdKicker(info){
  var n=((info&&info.ad)||"").toLowerCase(),k=((info&&info.kategori)||"").toLowerCase();
  if(/milkshake|frozen|oreo|smoothie/.test(n+k))return "Yaz burada soğuk lezzetle serinler.";
  return "Yaz burada kahveyle serinler.";
}
function buildE1HeroProduct(data,sig){
  var info=e1HeroProduct(data,sig);if(!info)return null;
  var tag=(sig&&sig.en_cok)?"Bu hafta en çok seçilen":(data.imza&&data.imza.ad===info.ad)?"TULİPİ imzası":"Bugünün fincanı";
  var st=el("div","pg e1Scene e1HeroScene");st.dataset.t=4000;st.dataset.roles="1";st.dataset.sahne="e1_tek_hero";st.dataset.name=info.ad;
  st.innerHTML='<div class="e1Studio"></div><div class="e1CupAura"></div><img class="e1RealCup" src="'+cupSrcFor(info)+'" alt="">'
    +'<div class="e1Block"><div class="e1Kicker">'+tag+'</div><div class="e1Title">'+info.ad+'</div>'
    +'<div class="e1Desc">'+e1HeroNote(info)+'</div></div><div class="e1Fade"></div>';
  return st;
}
function buildE1ColdCall(data,sig){
  var info=e1ColdProduct(data,sig);
  var cupName=e1ColdCupName(info);
  var st=el("div","pg e1Scene e1Cold"+(cupName?"":" e1NoCup"));st.dataset.t=5000;st.dataset.roles="1";st.dataset.sahne="e1_yaz_soguk";st.dataset.name=info.ad;
  st.innerHTML='<div class="e1ColdStudio"></div><div class="bggrade"></div>'
    +(cupName?'<img class="e1ColdCup" src="'+cupUrl(cupName)+'" alt="">':'')
    +'<div class="e1Block"><div class="e1Kicker">'+e1ColdKicker(info)+'</div><div class="e1Title">'+info.ad+'</div>'
    +'<div class="e1Desc">Ferah, buzlu, uzun içim.</div></div><div class="e1Fade"></div>';
  return st;
}
function e3NewProduct(data,sig){
  var info=e1ColdProduct(data,sig);
  if(sig&&sig.yeni&&sig.yeni.length){
    var picked=sig.yeni[0];
    for(var i=0;i<sig.yeni.length;i++){if(/frozen|mocktail|ice|iced|cold|buz/i.test(sig.yeni[i])){picked=sig.yeni[i];break;}}
    info=productInfo(picked,data);if(!info.ad)info.ad=picked;
  }
  return info;
}
function e3SilentProduct(data,sig){
  var o=sig&&sig.oneri&&sig.oneri.ad?productInfo(sig.oneri.ad,data):null;
  if(o&&o.ad)return o;
  if(data.imza&&data.imza.ad){o=productInfo(data.imza.ad,data);if(!o.ad)o.ad=data.imza.ad;return o;}
  return e1HeroProduct(data,sig)||{ad:"Tulipi Latte",kategori:"Signature Coffees",aciklama:""};
}
function e3Scene(cls,sahne,clip,kicker,title,desc,name){
  var st=el("div","pg e3Flow "+(cls||""));st.dataset.t=3000;st.dataset.roles="3";st.dataset.sahne=sahne;if(name)st.dataset.name=name;
  st.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+clip+'"></video><div class="bggrade"></div>'
    +'<div class="e3Block"><div class="e3Kicker">'+kicker+'</div><div class="e3Title">'+title+'</div><div class="e3Desc">'+desc+'</div></div><div class="e3Fade"></div>';
  return st;
}
function buildE3Flow(data,sig){
  // "TEK HİKÂYE, ÜÇ PERDE" — E3 = 60sn keşif→upsell yayı (E1 ile saniye-hizalı, bkz. build() notu):
  // 0-6 üçlü açılış (craft) · 6-18 YENİ keşif · 18-30 frozen/buzlu vitrin · 30-42 bilenin seçimi ·
  // 42-54 PERFECT PAIR (E1 'Günün Seçimi' fiyatı verirken E3 yanına tatlıyı koyar = satış zirvesi) ·
  // 54-60 üçlü marka kapanışı. Eski 3sn sahneler okunmuyordu (3 metre testi) — 12sn nefesli.
  var pages=[],nw=e3NewProduct(data,sig),silent=e3SilentProduct(data,sig),pr=pairSec(sig);
  var ac=e3Scene("e3Craft","e3_acilis","craft","TULİPİ","El yapımı, anında hazır","Sadece karıştırmıyoruz; kuruyoruz.");
  ac.dataset.t=6000;pages.push(ac);
  var sYeni=e3Scene("e3New","e3_yeni",e1ColdClip(nw),"YENİ",nw.ad,"Yaz için daha ferah, daha canlı.",nw.ad);
  sYeni.dataset.t=12000;pages.push(sYeni);
  var sFrozen=e3Scene("e3Frozen","e3_frozen","frozen","MILKSHAKE & FROZEN","Yazın en soğuk hali","Bardakta kısa bir yaz molası.");
  sFrozen.dataset.t=12000;pages.push(sFrozen);
  var sSilent=e3Scene("e3Silent","e3_sessiz_oneri","kahverengi","Baristanın sessiz önerisi",silent.ad,e1HeroNote(silent),silent.ad);
  sSilent.dataset.t=12000;pages.push(sSilent);
  var pairTitle=pr?(pr.k+" + "+pr.t):((data.pair&&data.pair.ad)?("Kahve + "+data.pair.ad):"Kahve + San Sebastian");
  var pairDesc=pr?pr.c:((data.pair&&data.pair.mesaj)?data.pair.mesaj:"Sütlü kahveyle kremamsı denge.");
  var pairName=pr?pr.t:((data.pair&&data.pair.ad)||"San Sebastian");
  var sPair=e3Scene("e3Pair","e3_pair","craft","Yanına iyi gider",pairTitle,pairDesc,pairName);
  sPair.dataset.t=12000;pages.push(sPair);
  var kap=buildMarkaImza();kap.dataset.roles="3";kap.dataset.sahne="e3_imza";
  pages.push(kap);
  return pages;
}
function buildGununSecimi(data,sig){
  // 🎬 E1 SAHNE 3 — "GÜNÜN SEÇİMİ": rampanın finali, fiyat İLK KEZ burada (Vaat→Kanıt→Duygu→SATIŞ).
  // Sosyal kanıt dili saat-modlu; alt köprü satırı matristen tatlıya bağlar (E3'e pas).
  var ad=sig&&sig.en_cok;if(!ad)return null;
  var fy=findPrice(ad),kat=findKategori(ad),nota="";
  (data.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){if(u.ad===ad&&u.aciklama)nota=u.aciklama;});});
  var mod=(sig.saat_modu&&sig.saat_modu.mod)||"";
  var tag=mod==="sabah"?"Sabahın favorisi":mod==="ogle"?"Öğlenin favorisi":mod==="aksam"?"Akşamın favorisi":"Bugünün seçimi";
  var pr=pairSec(sig);
  var st=el("div","pg pick gsec");st.dataset.t=9000;st.dataset.roles="1";st.dataset.sahne="gunun_secimi";st.dataset.name=ad;
  st.innerHTML='<img class="pDoku" src="/tv-menu/hero/doku_tezgah" alt=""><div class="pHalo"></div><div class="pInner">'
    +'<div class="pTag">'+tag+'</div>'
    +'<img class="pCup" src="'+cupUrl(cupShotFor(ad,kat))+'" alt="">'
    +'<div class="pName">'+ad+'</div>'
    +(nota?'<div class="pNote">'+nota+'</div>':'')
    +(fy!=null?'<div class="pPrice">'+fy+' TL</div>':'')
    +(pr?'<div class="pBridge">Yanına: <b>'+pr.t+'</b> · '+pr.c+'</div>':'')
    +'</div><div class="pFade"></div>';
  return st;
}
function buildBaristaOnerisi(sig){
  // 🎬 E3 — "BARİSTANIN SESSİZ ÖNERİSİ": az satan ürün "itilen ürün" değil "bilenin seçimi"
  // (öneri motoru zaten sessiz+saate uygun ürünü seçiyor; ilk kez sahnesi var).
  var o=sig&&sig.oneri;if(!o||!o.ad)return null;
  var fy=findPrice(o.ad),kat=findKategori(o.ad);
  var st=el("div","pg pick bsec");st.dataset.t=9000;st.dataset.roles="3";st.dataset.sahne="barista_onerisi";st.dataset.name=o.ad;
  st.innerHTML='<img class="pDoku" src="/tv-menu/hero/doku_tezgah" alt=""><div class="pHalo"></div><div class="pInner">'
    +'<div class="pTag">Baristanın sessiz önerisi</div>'
    +'<img class="pCup" src="'+cupUrl(cupShotFor(o.ad,kat))+'" alt="">'
    +'<div class="pName">'+o.ad+'</div>'
    +'<div class="pNote">Çok bilinmez; bilenlerin seçimi.</div>'
    +(fy!=null?'<div class="pPrice">'+fy+' TL</div>':'')
    +'</div><div class="pFade"></div>';
  return st;
}
function buildYeniUrun(data,sig){
  // 🎬 E1 — YENİ ÜRÜN (endüstri standardı "new item" sahnesi; sig.yeni panelden işaretlenir, yoksa kurulmaz)
  var ad=sig&&sig.yeni&&sig.yeni[0];if(!ad)return null;
  var fy=findPrice(ad),kat=findKategori(ad),nota="";
  (data.kategoriler||[]).forEach(function(k){(k.urunler||[]).forEach(function(u){if(u.ad===ad&&u.aciklama)nota=u.aciklama;});});
  var st=el("div","pg pick gsec");st.dataset.t=9000;st.dataset.roles="1";st.dataset.sahne="yeni_urun";st.dataset.name=ad;
  st.innerHTML='<img class="pDoku" src="/tv-menu/hero/doku_tezgah" alt=""><div class="pHalo"></div><div class="pInner">'
    +'<div class="pTag">✨ Yeni</div>'
    +'<img class="pCup" src="'+cupUrl(cupShotFor(ad,kat))+'" alt="">'
    +'<div class="pName">'+ad+'</div>'
    +(nota?'<div class="pNote">'+nota+'</div>':'<div class="pNote">Tanışmak isteyenlere.</div>')
    +(fy!=null?'<div class="pPrice">'+fy+' TL</div>':'')
    +'</div><div class="pFade"></div>';
  return st;
}
function buildHaftaninFavorileri(sig){
  // 🎬 E1 — SOSYAL KANIT LİSTESİ: kategori başına GERÇEK lider (kategori_fav) — "herkes bunları seçiyor"
  var kf=sig&&sig.kategori_fav;if(!kf)return null;
  var sira=["Classic Coffees","Signature Coffees","Mocktails"].filter(function(k){return kf[k];});
  if(sira.length<2)return null;
  var st=el("div","pg pick gsec");st.dataset.t=9000;st.dataset.roles="1";st.dataset.sahne="haftanin_favorileri";
  st.innerHTML='<img class="pDoku" src="/tv-menu/hero/doku_tezgah" alt=""><div class="pHalo"></div><div class="pInner">'
    +'<div class="pTag">Bu haftanın favorileri</div>'
    +'<div class="pList">'+sira.map(function(k){
      return '<div class="pLi"><div class="pLiKat">'+k+'</div><div class="pLiAd">'+kf[k]+'</div></div>';
    }).join("")+'</div>'
    +'<div class="pBridge">Gerçek seçimler · her gün güncellenir</div>'
    +'</div><div class="pFade"></div>';
  return st;
}
function buildSezon(sig){
  // 🎬 E1 — SEZON SAHNESİ (yalnız yazın; kış görseli gelince kış varyantı eklenir)
  if(!(sig&&sig.mevsim&&sig.mevsim.ad==="yaz"))return null;
  var st=el("div","pg szn");st.dataset.t=9000;st.dataset.roles="1";st.dataset.sahne="sezon_yaz";
  st.innerHTML='<div class="e1ColdStudio"></div>'
    +'<div class="sznShade"></div><img class="sznCup" src="'+cupUrl("iced")+'" alt="">'
    +'<div class="sznTxt">Yaz burada soğuk içilir.</div>'
    +'<div class="sznSub">Mocktail · Ice · Frozen</div>'
    +'<div class="pFade"></div>';
  return st;
}
function buildMarkaImza(){
  // 🎬 E1 — LOOP KAPANIŞI: logo + DNA sloganı (kullanıcı onaylı) — döngü hero'ya yumuşak bağlanır
  var st=el("div","pg imza");st.dataset.t=6000;st.dataset.roles="1";st.dataset.sahne="marka_imza";
  st.innerHTML='<img class="imzaBg" src="/tv-menu/hero/imza_bg" alt=""><div class="imzaShade"></div>'
    +'<div class="imzaInner"><img class="imzaLogo" src="/tv-menu/logo" alt="">'
    +'<div class="imzaTxt"><span>Zincir gibi hızlı.</span><span>Zanaat gibi özenli.</span></div></div>';
  return st;
}
function buildSessizSaat(sig){
  // 🎬 E3 — SAKİN SAAT (14:00-17:00): ritüel dili, indirim dili değil; matristen öğle çifti
  var h=new Date().getHours();if(h<14||h>=17)return null;
  var pr=(TATLI_MATRIS.ogle||[])[0];if(!pr)return null;
  var st=el("div","pg pick bsec");st.dataset.t=9000;st.dataset.roles="3";st.dataset.sahne="sessiz_saat";
  st.innerHTML='<img class="pDoku" src="/tv-menu/hero/doku_tezgah" alt=""><div class="pHalo"></div><div class="pInner">'
    +'<div class="pTag">Sakin saat seçimi</div>'
    +'<div class="pName">'+pr.k+' + '+pr.t+'</div>'
    +'<div class="pNote">Kalabalık geçmeden küçük bir kahve molası.</div>'
    +'</div><div class="pFade"></div>';
  return st;
}
function buildSpotlight(opts){
  // tek tip "parlatma" kurgusu: halo + bardak silüeti + video arka plan + glow fiyat — Kahraman Ürün & En Çok Satılan ortak kullanır
  var sp=el("div","pg heroPg");sp.dataset.t=opts.dur||10000;sp.dataset.roles="1";
  sp.dataset.name=opts.ad;if(opts.fiyat!=null)sp.dataset.price=opts.fiyat+" TL";sp.dataset.sahne=opts.sahne||"spotlight";
  var theme=opts.theme||"";  // "", "fire" (en çok satılan), "discover" (öneri motoru)
  var tcls=theme?(" "+theme):"";
  var clip=/(mocktail|milkshake)/i.test(opts.kategori||"")?"mocktail":"craft";
  sp.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+clip+'"></video><div class="bggrade"></div>';
  sp.appendChild(el("div","halo"+tcls));
  var cup='<img class="cupShot" src="'+cupUrl(cupShotFor(opts.ad,opts.kategori))+'" alt="">';
  var inner='<div class="sceneInner"><div class="spotTag'+tcls+'">'+opts.tag+'</div><div class="spotCup">'+cup+'</div>'
    +'<div class="spotName">'+opts.ad+'</div>'
    +(opts.aciklama&&opts.aciklama!==opts.kategori?'<div class="spotDesc">'+opts.aciklama+'</div>':'')
    +(opts.fiyat!=null?'<div class="spotPrice'+tcls+'">'+opts.fiyat+' TL</div>':'')+'</div>';
  sp.innerHTML+=inner;
  return sp;
}
function buildOzen(){
  // 🎬 SAHNE 2 — "ÖZEN KATMANI" (kullanıcı şartnamesi): fiyat/ürün adı/sürekli etiket YOK.
  // Katmanlar: still hero (omurga, video çökse de sahneyi taşır) → mikro video (2.2sn damla,
  // tek oynar son karede donar; son kare hero ile aynı dünya) → statik gradient/ambient →
  // Metin 1 "Özenle hazırlandı." → nefes → Metin 2 "Şimdi öne çıkan fincanlar." → çıkış kararması.
  var st=el("div","pg ozen");st.dataset.t=6500;st.dataset.roles="1";st.dataset.sahne="ozen";
  st.innerHTML='<img class="ozHero" src="/tv-menu/hero/ozen" alt="">'
    +'<video class="ozVid" muted autoplay playsinline preload="auto" src="/tv-menu/clip/ozen" onerror="this.style.display=\'none\'"></video>'
    +'<div class="ozGrade"></div><div class="ozAmb"></div>'
    +'<div class="ozTxt ozT1">Özenle hazırlandı.</div>'
    +'<div class="ozTxt ozT2">Şimdi öne çıkan fincanlar.</div>'
    +'<div class="ozExit"></div>';
  // Codex gerçek-TV bulgusu: görünür sahnede currentTime seek'i decoder'ı takıltır →
  // seek sahne GİZLİYKEN yapılır (pause+başa sar), sahne açılınca sadece play().
  try{new MutationObserver(function(){
    var v=st.querySelector("video");if(!v||v.style.display==="none")return;
    if(st.classList.contains("on")){var p=v.play();if(p&&p.catch)p.catch(function(){});}
    else{try{v.pause();v.currentTime=0;}catch(e){}}
  }).observe(st,{attributes:true,attributeFilter:["class"]});}catch(e){}
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
function screenRoleMeta(ekran){
  if(ekran==="1")return {idx:"SCREEN 01",title:"TULİPİ Coffee",sub:"Davet · Hero · Yaz"};
  if(ekran==="2")return {idx:"SCREEN 02",title:"Ana Kahve Menu",sub:"Espresso · Latte · Brewed"};
  if(ekran==="3")return {idx:"SCREEN 03",title:"Upsell · Soguk · Tatli",sub:"Cold drinks · Pairing · Dessert"};
  return {idx:"FULL LOOP",title:"Tulipi TV Menu",sub:"Tum sahneler tek akista"};
}
function applyScreenMeta(ekran){
  document.body.dataset.screen=ekran||"all";
  var meta=screenRoleMeta(ekran),box=document.getElementById("screenMeta");
  if(!box)return;
  box.querySelector(".metaIdx").textContent=meta.idx;
  box.querySelector(".metaTitle").textContent=meta.title;
  box.querySelector(".metaSub").textContent=meta.sub;
}
function build(data,sig){
  window._tvData=data;
  var ekran=(new URLSearchParams(location.search)).get("ekran");
  applyScreenMeta(ekran);
  var stage=document.getElementById("stage");
  Array.prototype.slice.call(stage.querySelectorAll(".pg")).forEach(function(p){p.remove()});
  var dots=document.getElementById("dots");dots.innerHTML="";
  var heroPages=[],ekran1Pages=[],ekran3Pages=[];

  // 1) EKRAN 1 — "TEK HİKÂYE, ÜÇ PERDE" (2026-07-04, kullanıcı: "hikâyeler birbirini tamamlasın"):
  // ÜÇ EKRAN ORTAK 60sn DÖNGÜ + 6/12sn RİTİM KİLİDİ. Wall-clock senkron (syncShow) sayesinde
  // aynı saniyede: 0-6 üçlü açılış nefesi · 6-42 rol sahneleri (vaat→duygu→ferahlık) ·
  // 42-54 SATIŞ ZİRVESİ (E1 fiyatı İLK KEZ verir, E3 aynı anda Perfect Pair'i koyar) ·
  // 54-60 üçlü marka kapanışı. Tüm sahne süreleri 6/12sn kuantum — menü büyürse E2 12'nin
  // katı kalır, sahne SINIRLARI yine hizalı düşer (duvar ritmi bozulmaz).
  var bOpen=el("div","pg heroPg openingPg");bOpen.dataset.t=6000;bOpen.dataset.roles="1";bOpen.dataset.sahne="e1_craft_acilis";
  bOpen.innerHTML='<img class="openingBg" src="/tv-menu/hero/opening" alt="">'
    +'<div class="openingShade"></div>'
    +'<div class="openingCopy">'
    +'<div class="openingTitle"><span>Kahve burada</span><span>hazır gelmez.</span></div>'
    +'<div class="openingSub">TULİPİ Coffee</div></div>';
  heroPages.push(bOpen);

  // ÖZ-ELEŞTİRİ — KONSOLİDASYON: Saat sinyali ayrı bir sahne olarak HİÇBİR ekranda yok artık —
  // alt-şerit ticker'da zaten metin olarak dönüyor (FAZ 2), ayrı "ŞİMDİ" kartı tekrar/doluluk
  // yaratıyordu (Codex 2. göz review notu). Mevsim sinyali Ekran 2'de (referans ekranı) kalıyor.

  // E1 perdeleri: hero (kanıt, fiyatsız) → özen (duygu) → soğuk çağrı (ferahlık) →
  // GÜNÜN SEÇİMİ (satış — fiyat rampanın ödülü) → marka imza (kapanış).
  var e1Hero=buildE1HeroProduct(data,sig);if(e1Hero){e1Hero.dataset.t=12000;heroPages.push(e1Hero);}
  var e1Ozen=buildOzen();e1Ozen.dataset.t=12000;heroPages.push(e1Ozen);
  var e1Cold=buildE1ColdCall(data,sig);e1Cold.dataset.t=12000;heroPages.push(e1Cold);
  var e1Sec=buildGununSecimi(data,sig);
  if(e1Sec){e1Sec.dataset.t=12000;heroPages.push(e1Sec);}
  else{var e1Fav=buildHaftaninFavorileri(sig);if(e1Fav){e1Fav.dataset.t=12000;heroPages.push(e1Fav);}}
  heroPages.push(buildMarkaImza());
  var hp=heroProduct(data,sig);  // Ekran 3 craft klip çakışma kontrolü hâlâ buna bakıyor

  // 4.2) CRAFT MOCKTAIL — gerçek barista çekimi: jigger → süzgeç → yeşil akış (barista ustalığı, ayrı/kendi sahnesi)
  // Kahraman Ürün AYNI greenmocktail klibini kullanmışsa burada farklı klip seç (çakışma önleme)
  var craftClip=(hp&&/(mocktail|milkshake)/i.test(hp.kategori||""))?"mocktail":"greenmocktail";
  var craftM=el("div","pg heroPg");craftM.dataset.t=8000;craftM.dataset.roles="3";
  craftM.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/'+craftClip+'" style="opacity:.95"></video><div class="bggrade"></div>'
    +'<div class="sceneInner"><div class="spotTag">CRAFT MOCKTAIL</div><div class="comboTitle">El Yapımı, Anında Hazır</div></div>';
  ekran3Pages.push(craftM);

  // 4.3) 🎬 BARİSTANIN SESSİZ ÖNERİSİ (FAZ1) — öneri motorunun ilk sahnesi (az satan → bilenin seçimi)
  var bsec=buildBaristaOnerisi(sig);if(bsec)ekran3Pages.push(bsec);
  // 4.4) 🎬 MILKSHAKE & FROZEN atmosferi — soğuk tatlı kategorisinin görsel reklamı (gerçek frozen çekimi)
  var frozenPg=el("div","pg heroPg");frozenPg.dataset.t=8000;frozenPg.dataset.roles="3";frozenPg.dataset.sahne="frozen_atmosfer";
  frozenPg.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/frozen" style="opacity:.92"></video><div class="bggrade"></div>'
    +'<div class="sceneInner"><div class="spotTag">MILKSHAKE & FROZEN</div><div class="comboTitle">Yazın En Soğuk Hali</div></div>';
  ekran3Pages.push(frozenPg);
  // 4.5) 🎬 SAKİN SAAT (14:00-17:00 koşullu) — sessiz saatleri ritüel diliyle canlandırma
  var ssaat=buildSessizSaat(sig);if(ssaat)ekran3Pages.push(ssaat);

  // 5) 🍰 TATLI KOMBO — Perfect Pair'i sahneler (Peak: merkez ekranın son/en güçlü sahnesi)
  // ÖZ-ELEŞTİRİ: dessert.mp4 (stok Mixkit kek videosu) tüm sistemdeki TEK kalan stok-gerçek
  // uyumsuzluğuydu. Gerçek Desserts çekimi yok, o yüzden gerçek kahve çekimine (craft) geçildi —
  // "Kahve + Tatlı" eşleşmesinde kahve tarafı gerçek, jenerik stok kekten daha tutarlı.
  var combo=el("div","pg heroPg");combo.dataset.t=9000;combo.dataset.roles="3";
  combo.dataset.name=(data.pair&&data.pair.ad)?data.pair.ad:"Kahve + Tatlı";combo.dataset.sahne="kombo";
  if(data.pair&&data.pair.fiyat!=null)combo.dataset.price=data.pair.fiyat+" TL";
  combo.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/craft"></video><div class="bggrade"></div>'
    +'<div class="sceneInner"><div class="spotTag">PERFECT PAIR</div>'
    +'<div class="spotName">'+((data.pair&&data.pair.ad)?data.pair.ad:"Kahve + Tatlı")+'</div>'
    +'<div class="comboTitle">Birlikte daha güzel</div>'
    +((data.pair&&data.pair.fiyat!=null)?'<div class="spotPrice">'+data.pair.fiyat+' TL</div>':'')+'</div>';
  ekran3Pages.push(combo);

  // 5.5) EKRAN 2 kahve referansi + EKRAN 3 upsell kartlari
  // E2 ana karar ekranı: mevsim/duygu kartı menü ritmini bozmasın diye burada gösterilmez.
  // ÖZ-ELEŞTİRİ (Codex 2. göz review): "Bugünün Önerisi" düz kartı eskiden E1'de Kahraman Ürün
  // spotlight'ıyla (yukarıda, 4. madde) AYNI ürünü iki farklı formatta art arda gösteriyordu —
  // "aynı şeyi iki kez söylüyor" hissi, premium değil tekrar. Tamamen kaldırıldı — spotlight zaten
  // bu işi (gerçek video+isim+fiyat) tam yapıyor, E1 akışı marka→duygu→tek ürün→kanıt olarak kalıyor.
  // Perfect Pair Kartı — ayrı/büyük (alttaki mikro-şeritten farklı, kendi sahnesi)
  // Perfect Pair kartı — yaşayan matristen (saat modlu); eski yeşil hap fiyat yerine sade krem satır
  var prA=pairSec(sig);
  if(prA){
    var prTatliFy=findPrice(prA.t);
    var pairC=el("div","pg flatCard heroPg");pairC.dataset.t=7000;pairC.dataset.roles="3";
    pairC.dataset.name=prA.t;pairC.dataset.sahne="pair-flat";
    pairC.innerHTML='<div class="sceneInner"><div class="gT">Perfect Pair</div>'
      +'<div class="spotName" style="font-size:3.6vh;position:relative;z-index:2">'+prA.k+' + '+prA.t+'</div>'
      +'<div class="spotDesc" style="position:relative;z-index:2">'+prA.c+'</div>'
      +(prTatliFy!=null?'<div style="position:relative;z-index:2;font-size:2.6vh;font-weight:600;color:#f2e6cf">'+prA.t+' · '+prTatliFy+' TL</div>':'')+'</div>';
    ekran3Pages.push(pairC);
  }

  // 6) KATEGORİLER (DESTEK EKRAN) — decision fatigue: sahne başına max 8 satır, taşan ikinci sayfaya bölünür
  // Perfect Pair şeridi artık YAŞAYAN MATRİSTEN (saat modlu, 7dk rotasyon); manuel data.pair yedek
  var pairAktif=pairSec(sig);
  var pairHtml=pairAktif?('<div class="pairStrip"><span class="tag">Perfect Pair</span> <b>'+pairAktif.k+' + '+pairAktif.t+'</b> · '+pairAktif.c+'</div>')
    :((data.pair&&data.pair.ad)?('<div class="pairStrip"><span class="tag">Perfect Pair</span> <b>'+data.pair.ad+'</b>'+(data.pair.mesaj?(' · '+data.pair.mesaj):'')+'</div>'):'');
  // ÖZ-ELEŞTİRİ (Codex 2. göz review): "Iced & Cold" E2'de (ana kahve menüsü) yer alıyordu ama
  // kullanıcının brief'i E3'ü "upsell+SOĞUK İÇECEK+tatlı+kombin" diye tanımlıyor — soğuk kahve
  // E3'e ait, E2/E3 sınırını netleştirmek için sadece Classic+Signature kaldı (sıcak kahve omurgası).
  function isCoffeeMenuCategory(kat){return /^(Classic Coffees|Signature Coffees)$/i.test(String(kat||"").trim());}
  function buildKatPage(k,chunk,pi,totalParts,role,withPair){
    var three=chunk.some(function(u){return u.f14!=null||u.fice!=null;});
    var pg=el("div","pg cat");pg.dataset.t=12000;pg.dataset.roles=role||"2";
    var shell=el("div","menuShell");
    var coffeeMode=(role||"2")==="2";
    var head=el("div","menuHead");
    head.innerHTML='<div class="menuMeta"><div class="menuKicker">'+(coffeeMode?'KAHVE MENÜSÜ':'SOĞUK & TATLI SEÇKİSİ')+'</div>'
      +'<div class="gT">'+k.kategori+(totalParts>1?' <span style="font-size:.42em;color:#8f816f;font-style:normal">('+(pi+1)+'/'+totalParts+')</span>':'')+'</div>'
      +(k.alt&&pi===0?'<div class="gH">'+k.alt+'</div>':'')
      +'<div class="menuRole">'+(coffeeMode?'Espresso · Latte · Brewed':'Cold drinks · Dessert · Pairing')+'</div></div>'
      +'<div class="menuPageTag">'+(totalParts>1?('Sayfa '+(pi+1)+' / '+totalParts):'Canlı Menü')+'</div>';
    shell.appendChild(head);
    var panel=el("div","menuPanel");
    var m=el("div","menu"+(three?"":" one"));
    if(three)m.innerHTML='<div class="hdr"><span style="text-align:left"></span><span>8oz</span><span>14oz</span><span>ICE</span></div>';
    // ✦ en sevilen: kategori başına TEK ürün (Evo top3'ten, favMap) — sosyal kanıt fısıltısı
    m.innerHTML+=chunk.map(function(u,i){return priceRow(u,three,i,favMap[k.kategori]===u.ad);}).join("");
    panel.appendChild(m);
    // Barista notu — kahve sayfalarının altında tek satır uzman fısıltısı (panelden yönetilir)
    if(coffeeMode&&sig&&sig.barista_notu)panel.insertAdjacentHTML("beforeend",'<div class="bNote"><b>Barista notu:</b> '+sig.barista_notu+'</div>');
    if(withPair&&pairHtml)panel.insertAdjacentHTML("beforeend",pairHtml);
    shell.appendChild(panel);
    pg.appendChild(shell);
    pg.appendChild(el("div","catFade"));  // çıkış kararması → sonraki sayfaya yumuşak köprü
    if(/(iced|cold|so.uk)/i.test(k.kategori)){for(var i=0;i<10;i++){var s=el("span","ice");s.style.left=(8+Math.random()*84)+"%";s.style.top=(22+Math.random()*54)+"%";s.style.animationDelay=(Math.random()*4.5)+"s";pg.appendChild(s);}}
    return pg;
  }
  // MENÜ MÜHENDİSLİĞİ VERİ KATMANI — top3 sıralaması: kategori içi görünmez yeniden sıralama
  // (primacy/recency) + kategori başına TEK "✦ en sevilen" (sosyal kanıt). Kampanya hissi YOK.
  var _rank={};if(sig&&sig.top3)sig.top3.forEach(function(it,ix){_rank[String(it.ad).toLowerCase()]=ix+1;});
  function _satisaGoreSirala(list){
    // kararlı bölümleme (eski TV tarayıcılarında Array.sort kararlılığı garantisiz → sort'a güvenme)
    var tops=[],rest=[];(list||[]).forEach(function(u){if(_rank[String(u.ad).toLowerCase()])tops.push(u);else rest.push(u);});
    tops.sort(function(a,b){return _rank[String(a.ad).toLowerCase()]-_rank[String(b.ad).toLowerCase()];});
    return tops.concat(rest);
  }
  // ✦ en sevilen: sunucunun kategori-bazlı haritası esas (top3 yazın tek kategoriye yığılıyor —
  // her kategorinin KENDİ yıldızı olsun); ad eşleşmesini menüdeki gerçek yazımla normalize et
  var favMap={};
  if(sig&&sig.kategori_fav){(data.kategoriler||[]).forEach(function(k){
    var favAd=sig.kategori_fav[k.kategori];if(!favAd)return;
    (k.urunler||[]).forEach(function(u){if(String(u.ad).toLowerCase()===String(favAd).toLowerCase())favMap[k.kategori]=u.ad;});
  });}

  // 0) 🎬 E2 MENÜ KAPAĞI — 5sn nefes sahnesi (fiyatsız): saat moduna göre karşılama fısıltısı
  var kahveKats=(data.kategoriler||[]).map(function(k){return k.kategori;}).filter(isCoffeeMenuCategory);
  var covMod=(sig&&sig.saat_modu&&sig.saat_modu.mod)||"";
  var covTitle=covMod==="sabah"?"Günaydın. İlk kahve burada."
    :covMod==="ogle"?"Serin bir mola."
    :covMod==="aksam"?"Yumuşak kapanış."
    :"Kahve Menüsü.";
  var mcov=el("div","pg mcov");mcov.dataset.t=6000;mcov.dataset.roles="2";mcov.dataset.sahne="menu_kapak";
  mcov.innerHTML='<div class="mcovInner"><div class="mcovKick">TULİPİ</div>'
    +'<div class="mcovTitle">'+covTitle+'</div>'
    +'<div class="mcovCats">'+(kahveKats.length?kahveKats.join(" · "):"Classic · Signature")+'</div></div>'
    +'<div class="mcovFade"></div>';
  ekran1Pages.push(mcov);
  var AGIRLIKLI_KAT=[];  // E2 öngörülebilir menü akışı: kategori tekrarları kapalı
  var agirlikliTekrar=[];
  var orderedKategoriler=(data.kategoriler||[]).slice().sort(function(a,b){
    var p={"Signature Coffees":0,"Classic Coffees":1};
    var pa=(p[a.kategori]!=null?p[a.kategori]:9),pb=(p[b.kategori]!=null?p[b.kategori]:9);
    return pa-pb;
  });
  orderedKategoriler.forEach(function(k){
    var urunler=_satisaGoreSirala(k.urunler);  // görünmez satış sıralaması (primacy)
    var coffeeRole=isCoffeeMenuCategory(k.kategori);
    var CHUNK=coffeeRole?6:8,parts=[];
    for(var i=0;i<urunler.length;i+=CHUNK)parts.push(urunler.slice(i,i+CHUNK));
    parts.forEach(function(chunk,pi){
      if(coffeeRole)ekran1Pages.push(buildKatPage(k,chunk,pi,parts.length,"2",true));  // Perfect Pair mikro şeridi E2'de de
      else ekran3Pages.push(buildKatPage(k,chunk,pi,parts.length,"3",true));
    });
    if(coffeeRole&&AGIRLIKLI_KAT.indexOf(k.kategori)>=0&&parts.length)agirlikliTekrar.push(buildKatPage(k,parts[0],0,1,"2",true));
  });
  // ÖZ-ELEŞTİRİ: kategori sayfaları eskiden eşit ağırlıklı görünüyordu (Desserts 4 ürün = Signature
  // 14 ürün, aynı 1 geçiş). En çok satılan kategoriler döngü sonunda (Top3'ten önce) bir kez daha
  // görünerek daha fazla "ekran zamanı" alır — gerçek satış ağırlığına göre yerleşim.
  agirlikliTekrar.forEach(function(pg){ekran1Pages.push(pg);});

  // E2 PERDE KAPANIŞI (6sn) — üç perde ritim kilidi: E1/E3 marka imzasıyla aynı pencerede
  // kapanış nefesi (şu an 6+4×12+6=60sn = E1/E3 ile tam faz; menü büyürse 12'nin katı kalır,
  // sahne sınırları yine hizalı düşer).
  var mout=el("div","pg mcov");mout.dataset.t=6000;mout.dataset.roles="2";mout.dataset.sahne="menu_kapanis";
  mout.innerHTML='<div class="mcovInner"><div class="mcovKick">TULİPİ</div>'
    +'<div class="mcovTitle">'+(covMod==="sabah"?"Güzel bir gün olsun.":covMod==="aksam"?"İyi akşamlar.":"Afiyet olsun.")+'</div>'
    +'<div class="mcovCats">Her Nesil Kahveci</div></div>'
    +'<div class="mcovFade"></div>';
  ekran1Pages.push(mout);

  // ⛔ 7) "En Çok Tercih Edilen" (top3), 8) Marka/Yaşam Tarzı ve Müşteri Anı sahneleri de E1'den
  // kaldırıldı (E1 sıfırlama, 2026-07-02): Ekran 1 = SADECE Sahne 1 açılış hero. Sahne 2+
  // kullanıcıyla sahne-sahne baştan kurgulanacak.
  // Bardak rotasyonu + çeşitlilik + frozen — ÖZ-ELEŞTİRİ: eskiden sıcak→buzlu→mocktail→kahverengi→
  // frozen sırası 1 sıcak + 4 soğuk art arda veriyordu ("mocktail galerisi" anti-pattern'i — GPT'nin
  // uyardığı "yine içecek" hissi). Şimdi sıcak/soğuk alternansı: soğuk-soğuk-SICAK-soğuk-soğuk yerine
  // sıcağı ortaya alıp soğuk kümesini ikiye böldük (2-1-2), tek-nota tekrar hissini kırıyor.
  var photoPg=function(name,label){var cp=el("div","pg");cp.dataset.t=4000;cp.dataset.roles="3";
    cp.innerHTML='<div class="cupProductStage"><img class="cupProduct" src="'+cupUrl(name)+'" alt=""><div class="bggrade"></div></div><div class="brandLabel">'+label+'</div>';
    return cp;};
  ekran3Pages.push(photoPg("iced","Buzlu Lezzetler"));
  var kahveC=el("div","pg");kahveC.dataset.t=6000;kahveC.dataset.roles="3";
  kahveC.innerHTML='<video class="bgvid" muted loop autoplay playsinline preload="auto" src="/tv-menu/clip/kahverengi" style="opacity:1"></video><div class="bggrade"></div><div class="brandLabel">Yeni Tatlar</div>';
  ekran3Pages.push(kahveC);
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

  // EKRAN 3 final rolü: sepet büyütme + keşif. Eski karma sahne havuzunu tek, okunur 12sn akışla değiştir.
  ekran3Pages=buildE3Flow(data,sig);

  // FAZ 4 — 3 EKRAN: 1=marka/hero/top seller · 2=ana kahve menu · 3=upsell/soguk/tatli/kombin
  var pages;
  if(ekran==="1")pages=heroPages;
  else if(ekran==="2")pages=ekran1Pages;
  else if(ekran==="3")pages=ekran3Pages;
  else pages=heroPages.concat(ekran1Pages).concat(ekran3Pages);  // ekran param yoksa (tek TV testi) hepsi
  pages.forEach(function(p){
    // evrensel çıkış kararması: kendi fade katmanı olmayan her sahneye süre-uyumlu exitFade eklenir
    if(!p.querySelector(".catFade,.pFade,.mcovFade,.ozExit,.exitFade")){
      var xf=el("div","exitFade");xf.style.animationDuration=((parseInt(p.dataset.t,10)||9000)/1000)+"s";p.appendChild(xf);
    }
    stage.insertBefore(p,document.querySelector(".foot"));dots.appendChild(el("i"));
  });
  var di=dots.children;
  var pc=document.getElementById("priceCorner");
  // KRİTİK FIX: display:none içindeyken <video autoplay> tarayıcıda sessizce başlamaz —
  // sahne görünür/gizli olduğunda videoyu EXPLICIT play()/pause() etmek gerekiyor (tüm bgvid sahneleri için)
  function syncVideos(p,on){
    var vids=p.querySelectorAll("video");
    for(var j=0;j<vids.length;j++){
      if(on){
        vids[j].dataset.keepPlaying="1";
        if(vids[j].paused){var pr=vids[j].play();if(pr&&pr.catch)pr.catch(function(){});}
      }else{
        vids[j].dataset.keepPlaying="";
        (function(v){setTimeout(function(){
          if(!v.dataset.keepPlaying&&!v.paused){try{v.pause();}catch(e){}}
        },900);})(vids[j]);
      }
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
    document.body.classList.toggle("opening-active",!!(cur&&cur.classList.contains("openingPg")));
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
      var key=JSON.stringify(d)+"|"+JSON.stringify(s||{});
      if(key===LAST_BUILD_KEY)return;
      LAST_BUILD_KEY=key;
      localStorage.setItem(CACHE,JSON.stringify(d));
      localStorage.setItem(CACHE+"_sig",JSON.stringify(s||{}));
      build(d,s);
    }else throw 0;
  }).catch(function(){
    var c=localStorage.getItem(CACHE),cs=localStorage.getItem(CACHE+"_sig");
    if(c){
      var key=c+"|"+(cs||"{}");
      if(key===LAST_BUILD_KEY)return;
      LAST_BUILD_KEY=key;
      build(JSON.parse(c),cs?JSON.parse(cs):null);
    }
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
  // Günün ürünü (Evo en-çok) önbelleği — story sahnesi artık ürünsüz sinematik, fiyat/ad güncellemesi kaldırıldı
  if(s&&s.en_cok){var pp=findPrice(s.en_cok);if(pp!=null)window._encok={ad:s.en_cok,fiyat:pp};}
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
  if(ek==="1")return;
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
