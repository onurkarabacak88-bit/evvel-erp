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
EVO_WEB   = "https://web.evobulut.com"

# Hızlı Satış web token — env var ile verilir, /api/evo/set-web-token ile güncellenir
_hs_web_token: str = os.environ.get("EVO_WEB_TOKEN", "")

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
_web_http: Any = None   # requests.Session — cookie'leri taşır


def _web_giris() -> tuple[str, str]:
    """
    Web app'e Session ile giriş yapar.
    DEVRE DIŞI — evobulut tek web oturumu destekler, kullanıcıyı atar.
    """
    raise HTTPException(503, "web-session devre dışı: kullanıcı oturumunu korumak için.")

    global _web_http
    now = datetime.utcnow()
    if _web_session.get("token") and _web_session.get("expires", now) > now:
        return _web_session["token"], _web_session["sunucu"]

    if not EVO_USER or not EVO_PASS:
        raise HTTPException(500, "EVO_KULLANICI veya EVO_SIFRE env değişkeni eksik")

    _web_http = requests.Session()
    _web_http.headers.update({
        "Referer":          f"{EVO_WEB}/login.html",
        "Origin":           EVO_WEB,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })

    r = _web_http.post(
        f"{EVO_WEB}/ashx/login.ashx?komut=login&evo_server=web.evobulut.com",
        data={"user_code": EVO_USER, "user_pass": EVO_PASS, "evo_server": "web.evobulut.com"},
        allow_redirects=False,
        timeout=15,
    )

    if r.status_code == 302:
        raise HTTPException(502, f"evobulut web login 302: {r.headers.get('Location')} — IP/CSRF engeli")
    if r.status_code != 200:
        raise HTTPException(502, f"evobulut web login HTTP {r.status_code}: {r.text[:200]}")

    try:
        payload = r.json()
    except Exception:
        raise HTTPException(502, f"evobulut web login JSON hata: {r.text[:300]}")

    res = payload[0].get("RES", "")
    if res != "OK":
        mesajlar = {
            "NO":  "Hatalı kullanıcı adı veya şifre",
            "NO1": "Kullanım süresi dolmuş",
            "NO2": "Çalışma saatleri dışında",
            "NO3": "IP FireWall ihlali",
            "NO5": "API kullanıcısı — web girişi yasak",
        }
        raise HTTPException(502, f"evobulut web login: {mesajlar.get(res, res)}")

    sunucu = payload[0].get("sunucu") or "web.evobulut.com"
    if not sunucu.startswith("http"):
        sunucu = f"https://{sunucu}"

    _web_session["token"]   = payload[0]["token"]
    _web_session["sunucu"]  = sunucu
    _web_session["expires"] = now + timedelta(hours=8)
    log.info("evobulut web token alındı, sunucu: %s | cookies: %s",
             sunucu, list(_web_http.cookies.keys()))
    return _web_session["token"], _web_session["sunucu"]


def _web_ashx(ashx_yol: str, data: dict, qs: dict | None = None) -> Any:
    """
    Internal evobulut .ashx endpoint'ini session cookie + token ile çağırır.
    NON_AUTHENTICATED_USER alınırsa oturumu temizleyip bir kez retry yapar.
    """
    global _web_http

    def _build_url(token: str, sunucu: str) -> str:
        data["evo_token"] = token
        data["token"]     = token
        if "?" in ashx_yol:
            base_yol, qs_str = ashx_yol.split("?", 1)
            url = f"{sunucu}/ashx/{base_yol}?{qs_str}"
        else:
            url = f"{sunucu}/ashx/{ashx_yol}"
        if qs:
            sep = "&" if "?" in url else "?"
            url += sep + "&".join(f"{k}={v}" for k, v in qs.items())
        return url

    def _do_post(url: str) -> Any:
        r = _web_http.post(url, data=data, timeout=20)
        if r.status_code != 200:
            raise HTTPException(502, f"evobulut /{ashx_yol} HTTP {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except Exception:
            raise HTTPException(502, f"evobulut /{ashx_yol} JSON hata ({r.status_code}): {r.text[:300]}")

    # İlk deneme
    token, sunucu = _web_giris()
    url = _build_url(token, sunucu)
    result = _do_post(url)

    # NON_AUTHENTICATED_USER → oturumu temizle ve bir kez daha dene
    def _auth_hata(res) -> bool:
        if isinstance(res, list) and res:
            return res[0].get("RES") == "NON_AUTHENTICATED_USER"
        return False

    if _auth_hata(result):
        log.warning("evobulut session hatası — yeniden giriş yapılıyor")
        _web_session.clear()
        token, sunucu = _web_giris()
        url = _build_url(token, sunucu)
        result = _do_post(url)
        if _auth_hata(result):
            raise HTTPException(502, "evobulut oturum yenilemesi başarısız — lütfen tekrar deneyin")

    return result


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


def faturajq_listesi(bastar: date, bittar: date, tur: int = 34) -> List[Dict]:
    """
    faturajq.ashx endpoint'i üzerinden fatura listesini çeker.
    Browser'ın kullandığı aynı endpoint — tarih filtresi uygular.
    tur=34 → Satış Fişi (HızlıSatış/POS), tur=31 → Satış Faturası
    """
    bas_str = _tarih_fmt(bastar)   # DD.MM.YYYY
    bit_str = _tarih_fmt(bittar)

    body = {
        "a_caller":       "1054",
        "profil":         "",
        "modul":          "",
        "grp":            "",
        "kos":            "|||||grup_icerir^1^1|",
        "veri":           "",
        "export":         "view",
        "groupscount":    "0",
        "Full_Text":      "",
        "gnm":            "jqxgrid_mod1054",
        "fts":            "|G.a_sbelge_seri_no|G.a_tarih|CARI_ADI|G.a_ack|TBL_STOK_DEPO.a_adi|G.a_isk_tut|G.a_kdv_tut|Kalan|G.a_tutar|TBL_DOV.a_adi|G.a_cdate|TBL_ONAY.a_adi|G.a_vtarih|PERSONELADI",
        # Tarih filtresi
        "filterscount":   "2",
        "filtervalue0":   bas_str,
        "filtercondition0": "GREATER_THAN_OR_EQUAL",
        "filterdatafield0": "G.a_tarih",
        "filterdatatype0":  "date",
        "filteroperator0":  "0",
        "filtervalue1":   bit_str,
        "filtercondition1": "LESS_THAN_OR_EQUAL",
        "filterdatafield1": "G.a_tarih",
        "filterdatatype1":  "date",
        "filteroperator1":  "0",
        "pagenum":        "0",
        "pagesize":       "1000",
        "recordstartindex": "1",
        "recordendindex": "1000",
        "sortdatafield":  "G.a_tarih",
        "sortorder":      "desc",
    }

    # Web login YAPMADAN dene: REST token'ı POST body'e ekle
    # (evobulut bazı endpoint'lerde token-only auth kabul eder)
    try:
        token = _token_al()
        body["evo_token"] = token
        body["token"]     = token
        url = f"{EVO_WEB}/ashx/faturajq.ashx?Tur={tur}&evo_server=web.evobulut.com"
        r = requests.post(url, data=body, timeout=20,
                          headers={"X-Requested-With": "XMLHttpRequest",
                                   "Referer": f"{EVO_WEB}/ajax/fatura.html?t={tur}"})
        if r.status_code == 200:
            result = r.json()
        else:
            log.warning("faturajq.ashx HTTP %d: %s", r.status_code, r.text[:200])
            return []
    except Exception as e:
        log.warning("faturajq.ashx hatası: %s", e)
        return []

    # Cevap formatı: {"TotalRows": N, "Rows": [...]}  veya {"rows": [...]}
    if isinstance(result, dict):
        rows = result.get("Rows") or result.get("rows") or result.get("data") or []
        if not rows and isinstance(result.get("TotalRows"), int):
            log.info("faturajq.ashx toplam %d kayıt, Rows boş", result["TotalRows"])
        return rows
    if isinstance(result, list):
        return result
    return []


def faturajq_urun_bazli_satis(bastar: date, bittar: date) -> Dict[str, float]:
    """
    faturajq.ashx → fatura listesi, sonra her fatura için detay çek.
    Ürün adı → toplam satılan adet döndürür.
    """
    faturalar = faturajq_listesi(bastar, bittar, tur=34)
    log.info("faturajq: %d adet Satış Fişi bulundu", len(faturalar))

    urun_toplam: Dict[str, float] = {}
    for f in faturalar:
        fid = str(f.get("G.a_id") or f.get("a_id") or f.get("id") or "").strip()
        if not fid:
            continue
        detay   = evo_fatura_detay(fid)
        satirlar = _satirlari_coz(detay)
        for s in satirlar:
            ad = str(
                s.get("a_stok_adi") or s.get("stok_adi") or
                s.get("a_adi")     or s.get("urun_adi") or ""
            ).strip()
            try:
                mik = float(s.get("a_miktar") or s.get("miktar") or 0)
            except (ValueError, TypeError):
                mik = 0.0
            if ad and mik > 0:
                urun_toplam[ad] = urun_toplam.get(ad, 0) + mik

    return urun_toplam


# ─────────────────────────────────────────────
# 2b. HS_RAPOR — Hızlı Satış en çok satılan ürünler
# ─────────────────────────────────────────────

def _hs_web_token_al() -> str:
    """Web localStorage token'ı döndürür. Env var veya DB'den alınır."""
    global _hs_web_token
    # Önce bellekteki cache
    if _hs_web_token:
        return _hs_web_token
    # DB'den dene
    try:
        with db() as (conn, cur):
            cur.execute("SELECT deger FROM ayarlar WHERE anahtar='evo_web_token'")
            row = cur.fetchone()
            if row and row["deger"]:
                _hs_web_token = row["deger"]
                return _hs_web_token
    except Exception:
        pass
    raise HTTPException(503, "EVO_WEB_TOKEN tanımlı değil. /api/evo/set-web-token ile token girin.")


def _hs_web_token_temizle() -> None:
    """Geçersiz/süresi dolmuş token'ı bellekten ve DB'den temizler."""
    global _hs_web_token
    _hs_web_token = ""
    try:
        with db() as (conn, cur):
            cur.execute("DELETE FROM ayarlar WHERE anahtar='evo_web_token'")
    except Exception:
        pass
    log.info("hs_rapor web token temizlendi (geçersiz/süresi dolmuş)")


# Kimlik doğrulama hatası gösteren evobulut cevap anahtarları
_EVO_AUTH_HATA = {"NON_AUTHENTICATED_USER", "HATA", "ERR", "LOGIN", "NOTOKEN"}


def hs_rapor_urun_satis(bastar: date, bittar: date) -> Dict[str, float]:
    """
    hs_rapor.ashx → Cok_Satilan listesinden ürün adı → adet döndürür.
    Web localStorage token gerektirir (EVO_WEB_TOKEN env var veya DB).
    Token geçersizse belleği temizler ve 503 fırlatır (fallback tetiklenir).
    """
    token = _hs_web_token_al()
    url = (
        f"{EVO_WEB}/hizli/hs_rapor.ashx"
        f"?evo_token={token}&evo_server=web.evobulut.com"
    )
    body = {
        "komut":    "FORM_LOAD",
        "tarih1":   bastar.strftime("%d.%m.%Y 00:00:00"),
        "tarih2":   bittar.strftime("%d.%m.%Y 23:59:59"),
        "personel": "0",
        "sube":     "0",
    }
    headers = {
        "X-Requested-With": "XMLHttpRequest",
        "Referer":          f"{EVO_WEB}/hizli/hs_rapor.html",
    }
    r = requests.post(url, data=body, headers=headers, timeout=20)
    if r.status_code != 200:
        raise HTTPException(502, f"hs_rapor.ashx HTTP {r.status_code}")

    try:
        d = r.json()
    except Exception:
        raise HTTPException(502, f"hs_rapor.ashx JSON hatası: {r.text[:200]}")

    statu = str(d.get("Statu") or "").strip().upper()

    # Token süresi dolmuş / kimlik hatası → token'ı temizle, 503 fırlat (fallback devreye girer)
    if statu in _EVO_AUTH_HATA or statu != "OK":
        _hs_web_token_temizle()
        raise HTTPException(
            503,
            f"hs_rapor web token geçersiz (Statu={statu}) — token yenileyin veya REST API kullanılıyor"
        )

    cok = d.get("Cok_Satilan", [])
    if not cok:
        log.warning("hs_rapor Cok_Satilan boş — veri yok")
        return {}

    urun_toplam: Dict[str, float] = {}
    for item in cok:
        ad  = str(item.get("a_adi") or "").strip()
        try:
            mik = float(item.get("satis_mik") or 0)
        except (ValueError, TypeError):
            mik = 0.0
        if ad and mik > 0:
            urun_toplam[ad] = urun_toplam.get(ad, 0) + mik

    log.info("hs_rapor: %d ürün, %s→%s", len(urun_toplam), bastar, bittar)
    return urun_toplam


def evo_urun_bazli_satis(bastar: date, bittar: date) -> Dict[str, float]:
    """
    Tarih aralığında ürün adı → toplam satılan adet.
    Önce hs_rapor.ashx dener (en doğru), sonra faturajq, sonra REST API.
    """
    # 1. hs_rapor.ashx — en doğru kaynak
    try:
        sonuc = hs_rapor_urun_satis(bastar, bittar)
        if sonuc:
            log.info("hs_rapor yöntemi başarılı: %d ürün", len(sonuc))
            return sonuc
    except HTTPException as e:
        if e.status_code == 503:
            log.info("hs_rapor token yok, faturajq deneniyor")
        else:
            log.warning("hs_rapor başarısız: %s", e.detail)
    except Exception as e:
        log.warning("hs_rapor başarısız: %s", e)

    # 2. faturajq.ashx (web app)
    try:
        sonuc = faturajq_urun_bazli_satis(bastar, bittar)
        if sonuc:
            log.info("faturajq yöntemi başarılı: %d ürün", len(sonuc))
            return sonuc
    except Exception as e:
        log.warning("faturajq yöntemi başarısız, REST API'ye geçiliyor: %s", e)

    # Yedek: REST API (ws.evobulut.com)
    try:
        tum_faturalar = evo_fatura_listesi(bastar, bittar, tip=0)
    except HTTPException as e:
        log.warning("Fatura listesi alınamadı: %s", e.detail)
        tum_faturalar = []

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
    with db() as (conn, cur):
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


@router.api_route("/set-web-token", methods=["GET", "POST"])
def evo_set_web_token(token: str = Query(..., description="Browser localStorage'dan evo_token değeri")):
    """
    Hızlı Satış web token'ını günceller.
    GET veya POST — bookmarklet ile çağrılabilir.
    """
    global _hs_web_token
    _hs_web_token = token.strip()
    # DB'ye kaydet (restart'ta kaybolmasın)
    try:
        with db() as (conn, cur):
            cur.execute(
                "INSERT INTO ayarlar (anahtar, deger) VALUES ('evo_web_token', %s) "
                "ON CONFLICT(anahtar) DO UPDATE SET deger=EXCLUDED.deger, guncelle=NOW()",
                (_hs_web_token,)
            )
    except Exception as e:
        log.warning("Token DB'ye kaydedilemedi: %s", e)
    log.info("Web token güncellendi: %s...", _hs_web_token[:8])
    return {"durum": "ok", "mesaj": "Token güncellendi ✅", "token_baslangic": _hs_web_token[:8] + "..."}


@router.get("/hs-rapor")
def evo_hs_rapor(
    tarih1: str = Query(None, description="DD.MM.YYYY — başlangıç (boş=bugün)"),
    tarih2: str = Query(None, description="DD.MM.YYYY — bitiş (boş=bugün)"),
):
    """
    Ürün bazlı satış — Hızlı Satış raporu.
    Öncelik: hs_rapor.ashx (web token) → REST API fatura (EVO_KULLANICI/EVO_SIFRE).
    Web token süresi dolmuşsa otomatik temizler ve REST API'ye düşer.
    """
    from datetime import date as _date
    bugun = bugun_tr()
    if tarih1:
        bastar = datetime.strptime(tarih1, "%d.%m.%Y").date()
    else:
        bastar = bugun
    if tarih2:
        bittar = datetime.strptime(tarih2, "%d.%m.%Y").date()
    else:
        bittar = bugun

    kaynak = "hs_rapor"
    sonuc: Dict[str, float] = {}

    # 1. hs_rapor.ashx (web token — en doğru kaynak)
    try:
        sonuc = hs_rapor_urun_satis(bastar, bittar)
        if sonuc:
            log.info("hs_rapor başarılı: %d ürün", len(sonuc))
    except HTTPException as e:
        if e.status_code in (503,):
            # Token yok veya geçersiz → REST API'ye geç
            log.info("hs_rapor token geçersiz, REST API deneniyor: %s", e.detail)
            kaynak = "rest_api_fallback"
        else:
            log.warning("hs_rapor hatası (%d): %s", e.status_code, e.detail)
            kaynak = "rest_api_fallback"
    except Exception as e:
        log.warning("hs_rapor hatası: %s", e)
        kaynak = "rest_api_fallback"

    # 2. REST API fallback (EVO_KULLANICI + EVO_SIFRE ile)
    if not sonuc and kaynak == "rest_api_fallback":
        if EVO_USER and EVO_PASS:
            try:
                tum_faturalar = evo_fatura_listesi(bastar, bittar, tip=0)
                faturalar = [
                    f for f in tum_faturalar
                    if str(f.get("G.a_tur") or f.get("a_tur") or "") in ("31", "34", "")
                ]
                urun_toplam: Dict[str, float] = {}
                for f in faturalar:
                    fid = str(f.get("G.a_id") or f.get("a_id") or f.get("id") or "").strip()
                    if not fid:
                        continue
                    detay = evo_fatura_detay(fid)
                    satirlar = _satirlari_coz(detay)
                    for s in satirlar:
                        ad = str(
                            s.get("a_stok_adi") or s.get("stok_adi") or
                            s.get("a_adi") or s.get("urun_adi") or ""
                        ).strip()
                        try:
                            mik = float(s.get("a_miktar") or s.get("miktar") or 0)
                        except (ValueError, TypeError):
                            mik = 0.0
                        if ad and mik > 0:
                            urun_toplam[ad] = urun_toplam.get(ad, 0) + mik
                sonuc = urun_toplam
                log.info("REST API fallback başarılı: %d ürün", len(sonuc))
            except Exception as e:
                log.warning("REST API fallback başarısız: %s", e)
        else:
            # Token yok, REST API credentials da yok → 503
            raise HTTPException(
                503,
                "EVO_WEB_TOKEN tanımlı değil. /api/evo/set-web-token ile token girin."
            )

    return {
        "bastar": str(bastar),
        "bittar": str(bittar),
        "urun_sayisi": len(sonuc),
        "kaynak": kaynak,
        "urunler": dict(sorted(sonuc.items(), key=lambda x: -x[1])),
    }


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

    # Dashboard.ashx → grafik_satis_getir komutu (dashboard JS'den doğrulandı)
    sube_id = 0  # 0 = tüm şubeler
    data = _web_ashx("Dashboard.ashx", {
        "komut":          "grafik_satis_getir",
        "sube_id":        str(sube_id),
        "satis_tarih_bas": _tarih_fmt(b),
        "satis_tarih_bit": _tarih_fmt(e),
    })
    return {
        "bastar":  bastar,
        "bittar":  bittar,
        "kaynak":  "Dashboard.ashx/grafik_satis_getir",
        "veri":    data,
    }


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


@router.get("/debug-web-ashx")
def evo_debug_web(
    ashx:   str = Query("hizlisatis.ashx"),
    komut:  str = Query(...),
    bas:    str = Query("14.05.2026"),
    son:    str = Query("14.05.2026"),
    ekstra: str = Query("", description="key=val,key2=val2 formatında ek parametre"),
):
    """
    Web app internal .ashx endpoint'ini doğrudan çağırır (keşif için).
    Örn: /debug-web-ashx?ashx=hizlisatis.ashx&komut=satis_listesi&bas=14.05.2026
    """
    body: dict = {
        "komut":       komut,
        "bastar":      bas,
        "bittar":      son,
        "tarih_bas":   bas,
        "tarih_bit":   son,
        "satis_tarih_bas": bas,
        "satis_tarih_bit": son,
    }
    for pair in ekstra.split(","):
        if "=" in pair:
            k, v = pair.split("=", 1)
            body[k.strip()] = v.strip()

    try:
        data = _web_ashx(ashx, body)
    except HTTPException as e:
        return {"hata": e.detail, "ashx": ashx, "komut": komut}

    # Boyutu kontrol et
    import json as _json
    raw = _json.dumps(data, ensure_ascii=False)
    return {
        "ashx":     ashx,
        "komut":    komut,
        "boyut":    len(raw),
        "tip":      type(data).__name__,
        "ilk_3000": raw[:3000],
    }


@router.get("/stok-analiz")
def evo_stok_analiz(
    tarih: str = Query("14.05.2026", description="DD.MM.YYYY"),
):
    """
    Tüm stok kalemleri için stok_hareketleri çağrısı yapar.
    O tarihte hareketi olan ürünleri ve miktarlarını döndürür.
    """
    import json as _json

    # 1) Stok listesini REST API'den al
    stok_data = _evo_post("stok", {
        "cmd": "jq_list",
        "sayfa": "0",
        "ara": "",
    })
    veri = stok_data.get("veri", {})
    if isinstance(veri, dict):
        stok_listesi = veri.get("Ana") or []
    elif isinstance(veri, list):
        stok_listesi = veri
    else:
        stok_listesi = []

    if not stok_listesi:
        raise HTTPException(502, "Stok listesi alınamadı")

    # 2) Her stok için hareket sorgula
    sonuclar = []
    ICERIK_DENE = ["", "0", "1", "2", tarih]

    for stok in stok_listesi[:50]:  # max 50 stok
        stok_id = str(stok.get("a_id") or "").strip()
        stok_adi = str(stok.get("a_adi") or "").strip()
        if not stok_id:
            continue

        for icerik in ICERIK_DENE:
            try:
                data = _web_ashx("stok.ashx", {
                    "komut":    "stok_hareketleri",
                    "stok_id":  stok_id,
                    "icerik":   icerik,
                    "modul":    "",
                    "musteri":  "",
                    "cari_id":  "",
                })
            except HTTPException:
                continue

            if not isinstance(data, list) or not data:
                continue

            # tarih filtresi (DD.MM.YYYY ile başlayanlar)
            tarih_gun = tarih[:10]  # DD.MM.YYYY
            hareketler = [
                h for h in data
                if str(h.get("a_tarih") or "").startswith(tarih_gun)
            ]
            if hareketler:
                toplam_cikan = sum(
                    float(h.get("miktar") or 0)
                    for h in hareketler
                    if float(h.get("miktar") or 0) < 0  # cikis = negatif
                )
                toplam_giren = sum(
                    float(h.get("miktar") or 0)
                    for h in hareketler
                    if float(h.get("miktar") or 0) > 0
                )
                sonuclar.append({
                    "stok_id":  stok_id,
                    "stok_adi": stok_adi,
                    "icerik":   icerik,
                    "hareket_sayisi": len(hareketler),
                    "toplam_cikan": abs(toplam_cikan),
                    "toplam_giren": toplam_giren,
                    "ornek": data[:2],
                })
                break  # bu stok için bulundu, sonrakine geç

    return {
        "tarih": tarih,
        "stok_sayisi": len(stok_listesi),
        "hareket_var": len(sonuclar),
        "sonuclar": sonuclar,
    }


@router.get("/urun-probe")
def evo_urun_probe(
    bas: str = Query("14.05.2026"),
    son: str = Query("14.05.2026"),
):
    """
    Ürün bazlı satış verisini bulmak için çeşitli endpoint/param kombinasyonlarını dener.
    İlk çalışan kombinasyonu ve sonucunu döndürür.
    """
    import json as _json
    sonuclar = []

    # ISO tarih formatı da dene
    try:
        from datetime import datetime as _dt
        bas_iso = _dt.strptime(bas, "%d.%m.%Y").strftime("%Y-%m-%d")
        son_iso = _dt.strptime(son, "%d.%m.%Y").strftime("%Y-%m-%d")
    except Exception:
        bas_iso = bas
        son_iso = son

    # Denenecek kombinasyonlar
    denemeler = [
        # (ashx, body)
        ("Dashboard.ashx", {"komut": "urun_satis_getir", "sube_id": "0",
                             "satis_tarih_bas": bas, "satis_tarih_bit": son}),
        ("Dashboard.ashx", {"komut": "urun_satis_getir", "sube_id": "0",
                             "bastar": bas, "bittar": son}),
        ("Dashboard.ashx", {"komut": "urun_satis_getir", "sube_id": "0",
                             "satis_tarih_bas": bas_iso, "satis_tarih_bit": son_iso}),
        ("Dashboard.ashx", {"komut": "urun_satis_getir", "sube_id": "0",
                             "bastar": bas_iso, "bittar": son_iso}),
        ("Dashboard.ashx", {"komut": "urun_satis_getir", "sube_id": "0", "tip": "34",
                             "satis_tarih_bas": bas, "satis_tarih_bit": son}),
        ("stok_hareket.ashx", {"komut": "jq_list", "a_tarih_bas": bas, "a_tarih_son": son,
                                "sayfa": "0", "ara": "", "a_tur": "34"}),
        ("stok_hareket.ashx", {"komut": "jq_list", "a_tarih_bas": bas, "a_tarih_son": son,
                                "sayfa": "0", "ara": ""}),
        ("stok_hareket.ashx", {"komut": "jq_list", "bastar": bas, "bittar": son,
                                "sayfa": "0", "ara": "", "modul": "34"}),
        ("stok_hareket.ashx", {"komut": "jq_list", "tarih_bas": bas, "tarih_bit": son,
                                "sayfa": "0", "ara": ""}),
        ("stok_hareket.ashx", {"komut": "liste", "bastar": bas, "bittar": son}),
        ("stok_hareket.ashx", {"komut": "satis_listesi", "bastar": bas, "bittar": son}),
        # faturajq.ashx ?Tur= URL querystring ile çalışır
        ("faturajq.ashx?Tur=34", {"bastar": bas, "bittar": son, "sayfa": "0", "ara": ""}),
        ("faturajq.ashx?Tur=34", {"a_tarih_bas": bas, "a_tarih_son": son, "sayfa": "0"}),
        ("faturajq.ashx?Tur=0",  {"bastar": bas, "bittar": son, "sayfa": "0"}),
    ]

    def _gecerli(data) -> bool:
        """Gerçek veri mi? (hata ve boş response'ları eler)"""
        if isinstance(data, list):
            if not data:
                return False
            if data[0].get("Sonuc") == "HATA" or data[0].get("sonuc") == "ERR":
                return False
        if isinstance(data, dict):
            if data.get("sonuc") == "ERR" or data.get("Sonuc") == "HATA":
                return False
            # S/S1 boş grid response
            if set(data.keys()) <= {"S", "S1", "yetkili"} and not data.get("S") and not data.get("S1"):
                return False
        return True

    for ashx, body in denemeler:
        try:
            data = _web_ashx(ashx, body)
            raw = _json.dumps(data, ensure_ascii=False)
            gecerli = _gecerli(data)
            sonuclar.append({
                "ashx": ashx,
                "body_keys": list(body.keys()),
                "boyut": len(raw),
                "gecerli": gecerli,
                "ilk_300": raw[:300],
            })
            if gecerli:
                return {
                    "durum": "bulundu",
                    "ashx": ashx,
                    "body": body,
                    "boyut": len(raw),
                    "veri": data,
                }
        except HTTPException as e:
            sonuclar.append({"ashx": ashx, "body_keys": list(body.keys()), "hata": e.detail})
        except Exception as e:
            sonuclar.append({"ashx": ashx, "body_keys": list(body.keys()), "hata": str(e)})

    return {"durum": "bulunamadi", "denemeler": sonuclar}


@router.get("/debug-kullanici")
def evo_debug_kullanici():
    """Kullanıcı adını döndürür."""
    return {"kullanici": EVO_USER}


@router.get("/debug-token")
def evo_debug_token():
    """Geliştirme: evo_token değerini döndürür (browser enjeksiyonu için)."""
    token, sunucu = _web_giris()
    return {"evo_token": token, "sunucu": sunucu}


@router.get("/debug-html-page")
def evo_debug_html_page(
    sayfa: str = Query("fatura.html"),
    qs:    str = Query("t=34"),
):
    """Web app sayfasının HTML içeriğini oturum ile çeker (ashx URL'lerini bulmak için)."""
    global _web_http
    token, sunucu = _web_giris()
    url = f"{sunucu}/{sayfa}?{qs}" if qs else f"{sunucu}/{sayfa}"
    r = _web_http.get(url, timeout=20)
    html = r.text
    # İlginç kısımları bul
    import re
    ashx_refs  = re.findall(r'ashx/[^"\'<>\s]+', html)
    js_refs    = re.findall(r'js/[^"\'<>\s?]+\.js', html)
    # Grid init URL'leri
    grid_urls  = re.findall(r'"url"\s*:\s*"([^"]+)"', html)
    grid_sayfa = re.findall(r"Sayfa\s*[:=]\s*['\"]([^'\"]+)['\"]", html, re.I)
    grid_proje = re.findall(r"Proje\s*[:=]\s*['\"]([^'\"]+)['\"]", html, re.I)
    # ashx load patterns
    evo_data   = re.findall(r"evo_data\([^)]{0,200}\)", html)
    grid_inits = re.findall(r"evo_grid[^(]*\([^)]{0,200}\)", html)
    # Inline script içindeki ashx referansları
    scripts    = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL | re.I)
    inline_ashx = []
    inline_grid_urls = []
    for s in scripts:
        inline_ashx += re.findall(r'ashx/[^"\'<>\s]+', s)
        inline_grid_urls += re.findall(r"[\"']url[\"']\s*:\s*[\"']([^\"']+)[\"']", s)
        inline_grid_urls += re.findall(r'datatype\s*:\s*["\']json["\'][^}]{0,300}url\s*:\s*["\']([^"\']+)["\']', s)

    return {
        "status": r.status_code,
        "boyut": len(html),
        "ashx_refs":        list(set(ashx_refs + inline_ashx))[:30],
        "js_refs":          list(set(js_refs))[:20],
        "grid_urls":        list(set(grid_urls + inline_grid_urls))[:20],
        "grid_sayfa":       list(set(grid_sayfa))[:10],
        "grid_proje":       list(set(grid_proje))[:5],
        "evo_data_calls":   list(set(evo_data))[:10],
        "inline_scripts_n": len(scripts),
        "ilk_500":          html[:500],
    }


@router.get("/debug-rest-raw")
def evo_debug_rest_raw(
    modul: str = Query("fatura"),
    cmd:   str = Query("jq_list"),
    bas:   str = Query("01.01.2026"),
    son:   str = Query("15.05.2026"),
):
    """Ham REST API cevabını döndürür — parsing olmadan."""
    import json as _json
    token = _token_al()
    body = {
        "cmd": cmd, "sayfa": "0", "ara": "",
        "a_tarih_bas": bas, "a_tarih_son": son,
        "bastar": bas, "bittar": son,
        "UID": token,
    }
    r = requests.post(f"{EVO_API}/{modul}/base/", json=body, timeout=20)
    raw = r.text
    try:
        parsed = r.json()
    except Exception:
        parsed = None
    return {
        "status_code": r.status_code,
        "ham_boyut": len(raw),
        "ham_ilk_2000": raw[:2000],
        "parsed_keys": list(parsed.keys()) if isinstance(parsed, dict) else type(parsed).__name__,
    }


@router.get("/debug-fatura-jq")
def evo_debug_fatura_jq(
    bas: str = Query("14.05.2026", description="DD.MM.YYYY"),
    son: str = Query("14.05.2026", description="DD.MM.YYYY"),
    tur: int = Query(34, description="34=Satış Fişi, 31=Satış Faturası"),
):
    """
    faturajq.ashx endpoint'ini test eder. Browser'ın kullandığı gerçek endpoint.
    """
    import json as _json
    from datetime import datetime as _dt
    try:
        b = _dt.strptime(bas, "%d.%m.%Y").date()
        s = _dt.strptime(son, "%d.%m.%Y").date()
    except ValueError:
        raise HTTPException(400, "Tarih formatı DD.MM.YYYY olmalı")

    rows = faturajq_listesi(b, s, tur=tur)
    raw  = _json.dumps(rows, ensure_ascii=False)
    ilk  = rows[0] if rows else {}
    return {
        "tur":         tur,
        "bas":         bas,
        "son":         son,
        "toplam_satir": len(rows),
        "kolonlar":    list(ilk.keys()) if ilk else [],
        "ilk_3":       rows[:3],
        "ham_boyut":   len(raw),
    }


@router.get("/debug-fatura-ashx")
def evo_debug_fatura_ashx(
    bas: str = Query("14.05.2026"),
    son: str = Query("14.05.2026"),
    komut: str = Query("jq_list"),
    tur: str = Query("34"),
):
    """
    fatura.ashx endpoint'ini farklı parametre kombinasyonlarıyla dener.
    HızlıSatış (Tur=34) fatura listesini almak için kullanılır.
    """
    import json as _json

    # Denenecek parametre setleri
    denemeler = [
        {"komut": komut, "Tur": tur, "a_tur": tur, "bas_tarih": bas, "son_tarih": son,
         "pagenum": "0", "pagesize": "50"},
        {"komut": komut, "Tur": tur, "tarih_bas": bas, "tarih_son": son,
         "pagenum": "0", "pagesize": "50"},
        {"komut": komut, "a_tur": tur, "a_tarih_bas": bas, "a_tarih_son": son,
         "pagenum": "0", "pagesize": "50"},
        {"komut": komut, "Tur": tur, "bastar": bas, "bittar": son,
         "pagenum": "0", "pagesize": "50"},
        {"komut": "jq_list", "a_tur": tur, "filtervalue0": bas, "filtercondition0": "GREATER_THAN_OR_EQUAL",
         "filterdatafield0": "a_tarih", "filterdatatype0": "date",
         "filtervalue1": son, "filtercondition1": "LESS_THAN_OR_EQUAL",
         "filterdatafield1": "a_tarih", "filterdatatype1": "date",
         "filteroperator0": "0", "filterscount": "2", "pagenum": "0", "pagesize": "50"},
    ]

    sonuclar = []
    for i, body in enumerate(denemeler):
        try:
            data = _web_ashx("fatura.ashx", body.copy())
            raw = _json.dumps(data, ensure_ascii=False)
            kayit_sayisi = 0
            if isinstance(data, list):
                kayit_sayisi = len(data)
            elif isinstance(data, dict):
                for k in ("S", "Ana", "rows", "data", "Records"):
                    if k in data and isinstance(data[k], list):
                        kayit_sayisi = len(data[k])
                        break
            sonuclar.append({
                "deneme": i + 1,
                "body_keys": list(body.keys()),
                "boyut": len(raw),
                "tip": type(data).__name__,
                "kayit_sayisi": kayit_sayisi,
                "cevap": raw[:1000],
            })
        except Exception as e:
            sonuclar.append({"deneme": i + 1, "hata": str(e)})

    return {"bas": bas, "son": son, "tur": tur, "denemeler": sonuclar}


@router.get("/debug-fatura-js")
def evo_debug_fatura_js():
    """fatura.js ve fatura_part01.js dosyalarını session ile çeker, ashx ve komut referanslarını çıkarır."""
    global _web_http
    import re
    token, sunucu = _web_giris()

    sonuclar = {}
    for js_dosya in ["fatura.js", "fatura_part01.js"]:
        try:
            r = _web_http.get(f"{sunucu}/js/{js_dosya}", timeout=15)
            txt = r.text
            ashx_refs = re.findall(r'["\']([^"\']*ashx[^"\']*)["\']', txt)
            komut_refs = re.findall(r'komut["\s]*[:=]["\s]*["\']([^"\']+)["\']', txt, re.I)
            tur_refs = re.findall(r'[Tt]ur["\s]*[:=]["\s]*["\']?(\d+)["\']?', txt)
            veri_yukle = re.findall(r'Veri_Yukle[^;]{0,300}', txt)[:5]
            sonuclar[js_dosya] = {
                "status": r.status_code,
                "boyut": len(txt),
                "ashx_refs": list(set(ashx_refs))[:20],
                "komut_refs": list(set(komut_refs))[:20],
                "tur_refs": list(set(tur_refs))[:10],
                "veri_yukle_ornekleri": veri_yukle,
                "ilk_500": txt[:500],
            }
        except Exception as e:
            sonuclar[js_dosya] = {"hata": str(e)}

    return sonuclar


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
