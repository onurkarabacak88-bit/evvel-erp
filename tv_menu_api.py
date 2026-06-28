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
        return {"marka": "TULİPİ", "guncelleme": datetime.now().isoformat(), "kategoriler": kats, "imza": imza}
    except Exception as e:
        logger.warning("tv-menu json hata: %s", e)
        return {"marka": "TULİPİ", "kategoriler": [], "hata": str(e)}


@router.get("/api/tv-menu/liste")
def tv_menu_liste():
    with db() as (conn, cur):
        _ensure_tablo(cur)
        cur.execute("SELECT * FROM tv_menu ORDER BY kategori, sira, ad")
        return [dict(r) for r in (cur.fetchall() or [])]


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


@router.get("/api/tv-signals")
def tv_signals():
    """FAZ 2 — yaşayan menü sinyalleri (saat-modu / en-çok / yeni / happy hour)."""
    yeni = []
    ayar = {}
    try:
        with db() as (conn, cur):
            _ensure_tablo(cur)
            ayar = _ayar_oku(cur)
            cur.execute("SELECT ad FROM tv_menu WHERE aktif=TRUE AND yeni=TRUE ORDER BY sira, ad")
            yeni = [r["ad"] for r in (cur.fetchall() or [])]
    except Exception as e:
        logger.warning("tv-signals hata: %s", e)
    sm = _saat_modu()
    en_cok = _en_cok(ayar)
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
    mv = _mevsim()
    if mv["oneri"]:
        seritler.append(mv["etiket"] + " · " + mv["oneri"])
    return {"saat_modu": sm, "mevsim": mv, "en_cok": en_cok, "yeni": yeni, "happy_hour": hh, "seritler": seritler}


class AyarModel(BaseModel):
    one_cikan: Optional[str] = None
    one_cikan_oto: Optional[bool] = None
    hh_aktif: Optional[bool] = None
    hh_bas: Optional[int] = None
    hh_bit: Optional[int] = None
    hh_mesaj: Optional[str] = None
    imza_urun: Optional[str] = None
    imza_aciklama: Optional[str] = None


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
    if name not in ("bean", "latte", "cup"):
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
.foot{position:absolute;bottom:2vh;left:0;right:0;text-align:center;z-index:6}
.foot #live{font-size:1.25vw;letter-spacing:.15vw;color:#7fae93;transition:opacity .5s}
.err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7d7065;font-size:1.4vw}
#season{position:absolute;inset:0;z-index:4;pointer-events:none;overflow:hidden}
#season span{position:absolute;top:-10vh;animation:sfall linear infinite;will-change:transform}
@keyframes sfall{0%{transform:translateY(-10vh) translateX(0) rotate(0)}100%{transform:translateY(112vh) translateX(5vw) rotate(220deg)}}
/* 🎬 COFFEE STORY — sinematik ara sahne (çekirdek→espresso→latte art→fincanda doğan fiyat) */
.pg.story{background:#050302}
.pg.story.on{animation:none}
.story .stsc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
/* GERÇEK VİDEO sahneleri (crossfade): çekirdek → latte art → buharlı fincan */
.story .vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;opacity:0}
.story .v1{animation:csVid1 18s ease-in-out infinite}
.story .v2{animation:csVid2 18s ease-in-out infinite}
.story .v3{animation:csVid3 18s ease-in-out infinite}
/* sinematik katmanlar: bokeh derinlik + renklendirme/letterbox + film grain */
.story .bok{position:absolute;border-radius:50%;filter:blur(3.4vw);pointer-events:none;mix-blend-mode:screen;opacity:.5}
.story .grade{position:absolute;inset:0;z-index:6;pointer-events:none;background:linear-gradient(180deg,#000 0,transparent 13%,transparent 86%,#000 100%),radial-gradient(125% 88% at 50% 44%,transparent 35%,#000d 100%)}
.story .grain{position:absolute;inset:-25%;z-index:8;pointer-events:none;opacity:.12;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");background-size:150px 150px;animation:csGrain .5s steps(3) infinite}
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
<div id="season"></div>
<div id="dots"></div>
<div class="foot"><span id="live">TÜM FİYATLAR TL · TULİPİ COFFEE</span></div></div>
<script>
var API="/api/tv-menu", CACHE="tulipi_tv_menu";
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
  // autoplay güvence (muted -> tarayıcı izin verir)
  setTimeout(function(){Array.prototype.forEach.call(st.querySelectorAll("video"),function(v){v.muted=true;var p=v.play();if(p&&p.catch)p.catch(function(){});});},60);
  return st;
}
function build(data){
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
    var sp=el("div","pg");sp.dataset.t=8000;sp.dataset.roles="2,3";
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
      +(data.imza.fiyat!=null?'<div class="spotPrice">'+data.imza.fiyat+' TL</div>':'');
    sp.innerHTML+=inner;
    pages.push(sp);
  }
  // Kategoriler
  (data.kategoriler||[]).forEach(function(k){
    var three=k.urunler.some(function(u){return u.f14!=null||u.fice!=null;});
    var pg=el("div","pg");pg.dataset.t=12000;pg.dataset.roles="1,3";
    pg.appendChild(el("div","gT",k.kategori));
    if(k.alt)pg.appendChild(el("div","gH",k.alt));
    var m=el("div","menu"+(three?"":" one"));
    if(three)m.innerHTML='<div class="hdr"><span style="text-align:left"></span><span>8oz</span><span>14oz</span><span>ICE</span></div>';
    m.innerHTML+=k.urunler.map(function(u,i){return priceRow(u,three,i);}).join("");
    pg.appendChild(m);
    if(/(iced|cold|so.uk)/i.test(k.kategori)){for(var i=0;i<10;i++){var s=el("span","ice");s.style.left=(8+Math.random()*84)+"%";s.style.top=(22+Math.random()*54)+"%";s.style.animationDelay=(Math.random()*4.5)+"s";pg.appendChild(s);}}
    pages.push(pg);
  });
  // FAZ 4 — 3 EKRAN MODU: ?ekran=1 MENÜ · ?ekran=2 DENEYİM(video) · ?ekran=3 MARKA+CANLI
  var ekran=(new URLSearchParams(location.search)).get("ekran");
  if(ekran){var f=pages.filter(function(p){return (p.dataset.roles||"").split(",").indexOf(ekran)>=0;});if(f.length)pages=f;}
  pages.forEach(function(p){stage.insertBefore(p,document.querySelector(".foot"));dots.appendChild(el("i"));});
  var di=dots.children,idx=0;
  function show(i){pages.forEach(function(p,k){p.classList.toggle("on",k===i);di[k].classList.toggle("on",k===i);});}
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
  fetch(API).then(function(r){return r.json();}).then(function(d){
    if(d&&d.kategoriler&&d.kategoriler.length){localStorage.setItem(CACHE,JSON.stringify(d));build(d);}
    else throw 0;
  }).catch(function(){
    var c=localStorage.getItem(CACHE);
    if(c){build(JSON.parse(c));}
    else{document.getElementById("stage").insertBefore(el("div","err","Menü yükleniyor…"),document.querySelector(".foot"));}
  });
}
// Ambient — uçuşan kahve çekirdekleri
(function beans(){var bg=document.getElementById("bg");if(!bg)return;for(var i=0;i<14;i++){var b=document.createElement("span");b.className="bean";b.style.left=(Math.random()*100)+"%";b.style.bottom=(Math.random()*8)+"%";var d=10+Math.random()*10;b.style.animationDuration=d+"s";b.style.animationDelay=(-Math.random()*d)+"s";bg.appendChild(b);}})();
load();
setInterval(load,60000);
// FAZ 2 — yaşayan menü canlı şeridi (saat-modu / en-çok / yeni / happy hour)
var SIG="/api/tv-signals", liveArr=["TÜM FİYATLAR TL · TULİPİ COFFEE"], liveI=0;
function loadSig(){fetch(SIG).then(function(r){return r.json();}).then(function(s){
  if(s&&s.seritler&&s.seritler.length){liveArr=s.seritler.concat(["TÜM FİYATLAR TL"]);}
  // Günün ürünü (Evo en-çok) story sahnesindeki "fincanda doğan fiyat"ı besler
  if(s&&s.en_cok){var pp=findPrice(s.en_cok);
    if(pp!=null){window._encok={ad:s.en_cok,fiyat:pp};
      var nm=document.getElementById("storyName"),pe=document.getElementById("storyPrice");
      if(nm){nm.textContent=s.en_cok;pe.textContent=pp+" TL";}}}
  if(s&&s.mevsim&&s.mevsim.ad)applySeason(s.mevsim.ad);   // FAZ 3 — mevsim görsel katmanı
}).catch(function(){});}
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
</script></body></html>"""
