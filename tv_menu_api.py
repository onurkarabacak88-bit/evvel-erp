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
        return {"marka": "TULİPİ", "guncelleme": datetime.now().isoformat(), "kategoriler": kats}
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
    return {"saat_modu": sm, "en_cok": en_cok, "yeni": yeni, "happy_hour": hh, "seritler": seritler}


class AyarModel(BaseModel):
    one_cikan: Optional[str] = None
    one_cikan_oto: Optional[bool] = None
    hh_aktif: Optional[bool] = None
    hh_bas: Optional[int] = None
    hh_bit: Optional[int] = None
    hh_mesaj: Optional[str] = None


@router.get("/api/tv-ayar")
def tv_ayar_oku():
    with db() as (conn, cur):
        _ensure_tablo(cur)
        a = _ayar_oku(cur)
    return {
        "one_cikan": a.get("one_cikan") or "", "one_cikan_oto": a.get("one_cikan_oto") == "1",
        "hh_aktif": a.get("hh_aktif") == "1", "hh_bas": int(a.get("hh_bas") or 14),
        "hh_bit": int(a.get("hh_bit") or 16), "hh_mesaj": a.get("hh_mesaj") or "Happy Hour",
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
.logo{width:22vw;display:block;mix-blend-mode:screen;animation:flo 6s ease-in-out infinite}
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
.foot{position:absolute;bottom:2vh;left:0;right:0;text-align:center;z-index:6}
.foot #live{font-size:1.25vw;letter-spacing:.15vw;color:#7fae93;transition:opacity .5s}
.err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7d7065;font-size:1.4vw}
</style></head>
<body><div id="stage">
<div class="bg" id="bg"><div class="drift"></div></div>
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
function build(data){
  var stage=document.getElementById("stage");
  Array.prototype.slice.call(stage.querySelectorAll(".pg")).forEach(function(p){p.remove()});
  var dots=document.getElementById("dots");dots.innerHTML="";
  var pages=[];
  // Hero — dönen halka + shimmer + buhar
  var hero=el("div","pg");hero.dataset.t=6000;
  hero.appendChild(el("div","ring"));
  hero.appendChild(el("div","halo"));
  var img=el("img","logo");img.src="/tv-menu/logo";img.alt="TULİPİ";hero.appendChild(img);
  var steam=el("div","steam");steam.style.zIndex=3;
  steam.innerHTML='<svg width="6vw" viewBox="0 0 60 40"><g fill="none" stroke="#EFE6D6" stroke-width="1.4" stroke-linecap="round"><path d="M22 34 q-3 -7 1 -13" style="animation:steam 3s ease-in-out infinite"/><path d="M31 33 q3 -7 -1 -13" style="animation:steam 3s ease-in-out 1s infinite"/><path d="M40 34 q-3 -7 1 -13" style="animation:steam 3s ease-in-out 2s infinite"/></g></svg>';
  hero.appendChild(el("div","q","Crafted Every Day"));
  pages.push(hero);
  // Kategoriler
  (data.kategoriler||[]).forEach(function(k){
    var three=k.urunler.some(function(u){return u.f14!=null||u.fice!=null;});
    var pg=el("div","pg");pg.dataset.t=12000;
    pg.appendChild(el("div","gT",k.kategori));
    if(k.alt)pg.appendChild(el("div","gH",k.alt));
    var m=el("div","menu"+(three?"":" one"));
    if(three)m.innerHTML='<div class="hdr"><span style="text-align:left"></span><span>8oz</span><span>14oz</span><span>ICE</span></div>';
    m.innerHTML+=k.urunler.map(function(u,i){return priceRow(u,three,i);}).join("");
    pg.appendChild(m);
    if(/(iced|cold|so.uk)/i.test(k.kategori)){for(var i=0;i<10;i++){var s=el("span","ice");s.style.left=(8+Math.random()*84)+"%";s.style.top=(22+Math.random()*54)+"%";s.style.animationDelay=(Math.random()*4.5)+"s";pg.appendChild(s);}}
    pages.push(pg);
  });
  pages.forEach(function(p){stage.insertBefore(p,document.querySelector(".foot"));dots.appendChild(el("i"));});
  var di=dots.children,idx=0;
  function show(i){pages.forEach(function(p,k){p.classList.toggle("on",k===i);di[k].classList.toggle("on",k===i);});var t=parseInt(pages[i].dataset.t,10)||9000;clearTimeout(window._tvt);window._tvt=setTimeout(function(){idx=(idx+1)%pages.length;show(idx);},t);}
  if(pages.length)show(0);
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
}).catch(function(){});}
function rotLive(){var e=document.getElementById("live");if(!e||liveArr.length<2)return;
  e.style.opacity=0;setTimeout(function(){liveI=(liveI+1)%liveArr.length;e.textContent=liveArr[liveI];e.style.opacity=1;},500);}
loadSig();setInterval(loadSig,60000);setInterval(rotLive,7000);
</script></body></html>"""
