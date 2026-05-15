"""
evobulut REST API entegrasyonu.
Günlük satış verisi çeker → bar-ozet fiziksel sayımıyla karşılaştırır → fark alarmı üretir.

evobulut REST API kuralları (dev.evobulut.com Postman collection'dan doğrulandı):
  - Tüm istekler POST'tur, URL: https://ws.evobulut.com/api/{modül}/base/
  - Token (UID) her isteğin JSON body'sinde gönderilir, header'da DEĞİL
  - Login: POST /api/index/base/ {"cmd":"euas","p1":user,"p2":pass,"app":"..."}
  - Token: response["veri"]["Ana"][0]["UID"]

Env değişkenleri:
    EVO_KULLANICI  → evobulut kullanıcı adı (e-posta)
    EVO_SIFRE      → evobulut şifresi
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Any, Dict, List

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

_token_cache: Dict[str, Any] = {}


def _token_al() -> str:
    """Token önbellekte geçerliyse döndür, yoksa yeni al."""
    now = datetime.utcnow()
    if _token_cache.get("token") and _token_cache.get("expires", now) > now:
        return _token_cache["token"]

    if not EVO_USER or not EVO_PASS:
        raise HTTPException(500, "EVO_KULLANICI veya EVO_SIFRE env değişkeni eksik")

    r = requests.post(
        f"{EVO_API}/index/base/",
        json={"cmd": "euas", "p1": EVO_USER, "p2": EVO_PASS, "app": "evvel-erp"},
        timeout=15,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut login başarısız: HTTP {r.status_code}")

    data = r.json()
    # Başarılı cevap: {"status":"OK","veri":{"Ana":[{"UID":"...","kullanici_kodu":"..."}]}}
    if data.get("status") not in ("OK", None):
        mesaj = ""
        try:
            mesaj = data["veri"]["Ana"][0].get("mesaj", "")
        except Exception:
            pass
        raise HTTPException(502, f"evobulut login hata: {mesaj or data}")

    try:
        token = data["veri"]["Ana"][0]["UID"]
    except (KeyError, IndexError, TypeError):
        raise HTTPException(502, f"evobulut token alınamadı: {data}")

    _token_cache["token"]   = token
    _token_cache["expires"] = now + timedelta(hours=8)
    log.info("evobulut token alındı, kullanıcı: %s", EVO_USER)
    return token


# ─────────────────────────────────────────────
# 1b. WEB APP SESSION (Hızlı Satış için)
# ─────────────────────────────────────────────

_web_session: Dict[str, Any] = {}
EVO_WEB = "https://web.evobulut.com"


def _web_giris() -> tuple[str, str]:
    """
    Web app'e giriş yaparak token ve sunucu URL'si alır.
    Hızlı Satış verileri sadece internal .ashx API ile çekilebilir.
    """
    now = datetime.utcnow()
    if _web_session.get("token") and _web_session.get("expires", now) > now:
        return _web_session["token"], _web_session["sunucu"]

    if not EVO_USER or not EVO_PASS:
        raise HTTPException(500, "EVO_KULLANICI veya EVO_SIFRE env değişkeni eksik")

    r = requests.post(
        f"{EVO_WEB}/ashx/login.ashx?komut=login",
        data={"user_code": EVO_USER, "user_pass": EVO_PASS},
        headers={
            "Content-Type":   "application/x-www-form-urlencoded",
            "Referer":        f"{EVO_WEB}/login.html",
            "Origin":         EVO_WEB,
            "X-Requested-With": "XMLHttpRequest",
        },
        allow_redirects=False,   # 302 redirect'i takip etme
        timeout=15,
    )
    # 302 redirect → header eksik → ham body'yi log'la
    if r.status_code not in (200, 302):
        raise HTTPException(502, f"evobulut web login HTTP {r.status_code}")
    if r.status_code == 302:
        raise HTTPException(502, f"evobulut web login 302 redirect: {r.headers.get('Location')} — CSRF/IP engeli")

    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, f"evobulut web login JSON parse hatası: {r.text[:200]}")
    res = data[0].get("RES", "")
    if res != "OK":
        mesajlar = {
            "NO":  "Hatalı kullanıcı adı veya şifre",
            "NO1": "Kullanım süresi dolmuş",
            "NO2": "Çalışma saatleri dışında",
            "NO3": "IP FireWall ihlali",
            "NO5": "Bu hesap API kullanıcısı — web girişi yapılamaz",
        }
        raise HTTPException(502, f"evobulut web login: {mesajlar.get(res, res)}")

    sunucu = data[0].get("sunucu") or "web.evobulut.com"
    if not sunucu.startswith("http"):
        sunucu = f"https://{sunucu}"

    _web_session["token"]   = data[0]["token"]
    _web_session["sunucu"]  = sunucu
    _web_session["expires"] = now + timedelta(hours=8)
    log.info("evobulut web token alındı, sunucu: %s", sunucu)
    return _web_session["token"], _web_session["sunucu"]


def _web_ashx(ashx_yol: str, data: dict) -> Any:
    """Internal evobulut .ashx endpoint'ini çağırır."""
    token, sunucu = _web_giris()
    data["token"] = token
    r = requests.post(
        f"{sunucu}/ashx/{ashx_yol}",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut /{ashx_yol} HTTP {r.status_code}")
    return r.json()


def _evo_post(modul: str, body: dict) -> dict:
    """
    evobulut REST API generic POST.
    Token'ı body'ye ekler, POST atar, status kontrolü yapar.
    """
    body["UID"] = _token_al()
    r = requests.post(
        f"{EVO_API}/{modul}/base/",
        json=body,
        timeout=20,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut /{modul} HTTP {r.status_code}")
    data = r.json()
    if isinstance(data, dict) and data.get("status") not in ("OK", None, ""):
        mesaj = ""
        try:
            mesaj = data["veri"]["Ana"][0].get("mesaj", "")
        except Exception:
            pass
        raise HTTPException(502, f"evobulut /{modul} hata: {mesaj or data.get('status')}")
    return data


# ─────────────────────────────────────────────
# 2. SATIŞ VERİSİ ÇEK
# ─────────────────────────────────────────────

def _tarih_fmt(d: date) -> str:
    """evobulut DD.MM.YYYY formatı."""
    return d.strftime("%d.%m.%Y")


def evo_fatura_listesi(bastar: date, bittar: date, tip: int = 0) -> List[Dict]:
    """
    Fatura listesini çeker.
    tip=0  → tüm fatüralar (filtre yok)
    tip=34 → Satış Fişi (hızlı satış / kasa)
    tip=31 → Satış Faturası
    Not: evobulut jq_list'te a_tur filtresi yok; tip client-side filtrelenir.
    """
    data = _evo_post("fatura", {
        "cmd":         "jq_list",
        "sayfa":       "0",
        "a_tarih_bas": _tarih_fmt(bastar),
        "a_tarih_son": _tarih_fmt(bittar),
        "a_onay":      "",
        "a_cari_id":   "",
        "a_stok_id":   "",
        "a_stok_ack":  "",
        "ara":         "",
    })
    veri = data.get("veri", {})
    ana: List[Dict] = []
    if isinstance(veri, dict):
        ana = veri.get("Ana") or []
    elif isinstance(veri, list):
        ana = veri

    # client-side tip filtresi ("G.a_tur" kolonuyla)
    if tip:
        ana = [f for f in ana if str(f.get("G.a_tur") or f.get("a_tur") or "") == str(tip)]
    return ana


def evo_fatura_detay(fatura_id: str) -> Dict:
    """Bir faturanın tam detayını (satır kalemleri dahil) çeker."""
    try:
        data = _evo_post("fatura", {
            "cmd":    "sql",
            "sql_id": fatura_id,
        })
    except HTTPException:
        return {}
    veri = data.get("veri", [])
    if isinstance(veri, list) and veri:
        return veri[0]
    if isinstance(veri, dict):
        return veri
    return {}


def _satirlari_coz(detay: Dict) -> List[Dict]:
    """Fatura detay cevabından satır kalemlerini çıkarır."""
    # evobulut satırları farklı key'lerde dönebilir
    for key in ("Det", "det", "Satirlar", "satirlar", "Satir", "satir"):
        val = detay.get(key)
        if val and isinstance(val, list):
            return val
    return []


def evo_urun_bazli_satis(bastar: date, bittar: date) -> Dict[str, float]:
    """
    Tarih aralığında ürün adı → toplam satılan adet.
    Satış fişleri (34) + satış faturaları (31) birleştirilir.
    """
    # tip=0 → tüm faturalar, client-side filtre uygulanır
    try:
        tum_faturalar = evo_fatura_listesi(bastar, bittar, tip=0)
    except HTTPException as e:
        log.warning("Fatura listesi alınamadı: %s", e.detail)
        tum_faturalar = []
    # Satış fişi (34) + satış faturası (31) → istenmeyen türleri dışla
    faturalar = [
        f for f in tum_faturalar
        if str(f.get("G.a_tur") or f.get("a_tur") or "") in ("31", "34", "")
    ]

    urun_toplam: Dict[str, float] = {}
    for f in faturalar:
        fid = str(f.get("G.a_id") or f.get("a_id") or f.get("id") or "").strip()
        if not fid:
            continue
        detay   = evo_fatura_detay(fid)
        satirlar = _satirlari_coz(detay)
        for s in satirlar:
            ad  = str(
                s.get("a_stok_adi") or s.get("stok_adi") or
                s.get("a_adi")     or s.get("urun_adi") or ""
            ).strip()
            mik = 0.0
            try:
                mik = float(s.get("a_miktar") or s.get("miktar") or s.get("Miktar") or 0)
            except (ValueError, TypeError):
                pass
            if ad and mik > 0:
                urun_toplam[ad] = urun_toplam.get(ad, 0) + mik

    return urun_toplam


# ─────────────────────────────────────────────
# 3. FİZİKSEL SAYIM vs POS KARŞILAŞTIRMA
# ─────────────────────────────────────────────

# evobulut ürün adı → sistemdeki bar_key eşlemesi
_URUN_MAP: Dict[str, str] = {
    "Su":            "su_adet",
    "Redbull":       "redbull_adet",
    "Sade Soda":     "soda_adet",
    "Elmalı Soda":   "soda_adet",
    "Limonata":      "soda_adet",
    "Limonlu Soda":  "soda_adet",
    "Pasta":         "pasta_adet",
    # kahve
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
    """
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

    # POS → bar_key
    pos_key: Dict[str, float] = {}
    for urun_adi, adet in evo_satis.items():
        key = _URUN_MAP.get(urun_adi)
        if key:
            pos_key[key] = pos_key.get(key, 0) + adet

    sonuclar = []
    for key, pos_adet in pos_key.items():
        a   = float(acilis.get(key)  or 0)
        k   = float(kapanis.get(key) or 0)
        fiz  = a - k
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
    """evobulut REST API bağlantısını test eder."""
    try:
        token = _token_al()
        return {"durum": "ok", "token_var": bool(token)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e))


@router.get("/web-login-test")
def evo_web_login_test():
    """evobulut web app girişini test eder (Hızlı Satış için)."""
    try:
        token, sunucu = _web_giris()
        return {"durum": "ok", "sunucu": sunucu, "token_var": bool(token)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e))


@router.get("/hizli-satis")
def evo_hizli_satis_endpoint(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
):
    """
    evobulut web app internal API ile hızlı satış (POS) verilerini çeker.
    Ürün adı → adet sözlüğü döndürür.
    """
    try:
        b = date.fromisoformat(bastar)
        e = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD olmalı")

    # İlk önce web token al, sonra satış verisini çek
    try:
        token, sunucu = _web_giris()
    except HTTPException as ex:
        raise HTTPException(502, f"Web giriş başarısız: {ex.detail}")

    # satisDetay.ashx ile dene
    try:
        data = _web_ashx("satisDetay.ashx", {
            "komut": "ARA_Bul",
            "bastar": _tarih_fmt(b),
            "bittar": _tarih_fmt(e),
        })
        return {"durum": "ok", "kaynak": "satisDetay.ashx", "veri": data}
    except Exception as e1:
        log.warning("satisDetay.ashx başarısız: %s", e1)

    # whoami ile sunucu doğrula
    try:
        who = _web_ashx("whoami.ashx", {"komut": "sen_kimsin"})
        return {"durum": "partial", "whoami": who, "sunucu": sunucu,
                "not": "satisDetay.ashx bulunamadı, endpoint keşfi devam ediyor"}
    except Exception as e2:
        return {"durum": "hata", "sunucu": sunucu, "hata1": str(e1), "hata2": str(e2)}


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
        "bastar":       bastar,
        "bittar":       bittar,
        "toplam_urun":  len(satis),
        "satislar":     satis,
    }


@router.get("/fatura-listesi-ham")
def evo_fatura_ham(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
    tip:    int = Query(34,  description="34=Satış Fişi, 31=Satış Faturası"),
):
    """Ham fatura listesini döndürür (field adlarını görmek için debug endpoint)."""
    try:
        b = date.fromisoformat(bastar)
        e = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD olmalı")
    faturalar = evo_fatura_listesi(b, e, tip=tip)
    ilk = faturalar[0] if faturalar else {}
    return {
        "toplam":      len(faturalar),
        "ilk_kayit":   ilk,
        "kolonlar":    list(ilk.keys()) if ilk else [],
    }


@router.get("/fatura-detay-ham")
def evo_detay_ham(fatura_id: str = Query(...)):
    """Tek fatura detayını döndürür (field adlarını görmek için debug endpoint)."""
    detay    = evo_fatura_detay(fatura_id)
    satirlar = _satirlari_coz(detay)
    ilk_sat  = satirlar[0] if satirlar else {}
    return {
        "detay_kolonlar":  list(detay.keys()),
        "satir_sayisi":    len(satirlar),
        "ilk_satir":       ilk_sat,
        "satir_kolonlari": list(ilk_sat.keys()) if ilk_sat else [],
    }


@router.get("/karsilastir")
def evo_karsilastir(
    sube_id: str = Query(...),
    tarih:   str = Query(..., description="YYYY-MM-DD"),
):
    """
    Bir şubenin belirtilen günü için evobulut POS vs fiziksel sayım karşılaştırması.
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


@router.get("/debug-modül")
def evo_debug_modul(
    modul: str = Query(..., description="Örn: stokhareket, gelirGider, stok"),
    cmd:   str = Query("jq_list"),
    bas:   str = Query("01.01.2026"),
    son:   str = Query("15.05.2026"),
):
    """
    Herhangi bir evobulut modülüne jq_list gönderir — hangi verinin nerede olduğunu bulmak için.
    Örn: /debug-modül?modul=StokHareket&cmd=jq_list
    """
    body: dict = {"cmd": cmd, "sayfa": "0"}
    # Ortak tarih field'ları dene
    for key in ("a_tarih_bas", "tarih_bas", "bastar"):
        body[key] = bas
    for key in ("a_tarih_son", "tarih_son", "bittar"):
        body[key] = son
    body["ara"] = ""

    try:
        data = _evo_post(modul, body)
    except HTTPException as e:
        return {"hata": e.detail}

    veri = data.get("veri", {})
    ana: list = []
    if isinstance(veri, dict):
        ana = veri.get("Ana") or []
    elif isinstance(veri, list):
        ana = veri

    ilk = ana[0] if ana else {}
    return {
        "modul":    modul,
        "toplam":   len(ana),
        "kolonlar": list(ilk.keys()) if ilk else [],
        "ilk_3":    ana[:3],
    }
