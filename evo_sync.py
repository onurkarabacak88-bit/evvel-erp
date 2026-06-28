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
import threading
import unicodedata
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

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
# EVO RAPOR CACHE — son başarılı çekim (canlı veri gelmezse fallback)
# ─────────────────────────────────────────────

def _evo_cache_yaz(anahtar: str, bastar: date, bittar: date, veri: Dict[str, Any]) -> None:
    """Son başarılı Evo rapor sonucunu (tarih aralığı bazlı) cache'e yazar."""
    try:
        with db() as (conn, cur):
            cur.execute(
                """
                INSERT INTO evo_rapor_cache (anahtar, bastar, bittar, veri_json, cekim_ts)
                VALUES (%s, %s, %s, %s::jsonb, NOW())
                ON CONFLICT (anahtar, bastar, bittar)
                DO UPDATE SET veri_json = EXCLUDED.veri_json, cekim_ts = NOW()
                """,
                (anahtar, bastar, bittar, json.dumps(veri, default=str)),
            )
    except Exception as e:
        log.warning("evo_cache_yaz hata (%s): %s", anahtar, e)


def _evo_cache_oku(anahtar: str, bastar: date, bittar: date) -> Optional[Dict[str, Any]]:
    """Verilen tarih aralığı için en son cache'lenmiş Evo rapor sonucunu döndürür."""
    try:
        with db() as (conn, cur):
            cur.execute(
                """
                SELECT veri_json, cekim_ts FROM evo_rapor_cache
                WHERE anahtar=%s AND bastar=%s AND bittar=%s
                """,
                (anahtar, bastar, bittar),
            )
            r = cur.fetchone()
            return dict(r) if r else None
    except Exception as e:
        log.warning("evo_cache_oku hata (%s): %s", anahtar, e)
        return None


def hs_rapor_sube_bazli_cached(bastar: date, bittar: date) -> Dict[str, Any]:
    """hs_rapor_sube_bazli'yi çalıştırır; canlı veri gelmezse son başarılı
    çekimi (evo_rapor_cache) döndürür. Sonuca her zaman "canli" ve
    "son_cekim_ts" alanları eklenir. Hem /sube-grup-detay endpoint'i hem de
    evo_bar_adet_by_sube_id (Kullanılan Ürünler / bardak eşleştirme) bu
    fonksiyonu kullanır, böylece ikisi de aynı "son veri çekimi" hafızasını
    paylaşır."""
    sonuc = hs_rapor_sube_bazli(bastar, bittar)
    if sonuc.get("subeler"):
        _evo_cache_yaz("sube-grup-detay", bastar, bittar, sonuc)
        sonuc["canli"] = True
        sonuc["son_cekim_ts"] = datetime.now().isoformat()
        return sonuc

    # Canlı veri gelmedi (tüm şube çekimleri başarısız) → son başarılı çekimi göster
    cache = _evo_cache_oku("sube-grup-detay", bastar, bittar)
    if cache:
        veri = dict(cache["veri_json"])
        veri["kaynak"] = "cache"
        veri["canli"] = False
        veri["son_cekim_ts"] = cache["cekim_ts"].isoformat()
        return veri

    sonuc["canli"] = False
    sonuc["son_cekim_ts"] = None
    return sonuc

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
# 1c. PERSONEL ADI CACHE
# a_per_id → SATIS_PER (isim) eşleşmesini bellekte + DB'de tutar.
# Evo'da ortak kasa hesabı kullanıldığında SATIS_PER boş gelir.
# Personel en az bir kez kendi hesabıyla giriş yaptığında isim
# cache'e düşer; sonraki ortak-hesap satışlarında da aynı isim gösterilir.
# ─────────────────────────────────────────────
_per_ad_cache: Dict[str, str] = {}       # personel_id → ad
_per_ad_lock  = threading.Lock()
_per_ad_cache_loaded = False


def _personel_cache_yukle() -> None:
    """DB'deki evo_personel_cache'i belleğe yükler. Bir kez çalışır."""
    global _per_ad_cache_loaded
    if _per_ad_cache_loaded:
        return
    try:
        with db() as (conn, cur):
            cur.execute("SELECT personel_id, ad FROM evo_personel_cache")
            rows = cur.fetchall()
        with _per_ad_lock:
            for r in rows:
                if r["personel_id"] and r["ad"]:
                    _per_ad_cache[r["personel_id"]] = r["ad"]
        _per_ad_cache_loaded = True
        log.info("evo_personel_cache: %d kayıt yüklendi", len(_per_ad_cache))
    except Exception as exc:
        log.warning("evo_personel_cache yüklenemedi: %s", exc)


def _per_ad_bul(pid: str, satis_per: str) -> str:
    """
    Personel adını döndürür.
    Öncelik: SATIS_PER (canlı) → DB cache → pid sayısı (fallback).
    """
    if satis_per and satis_per != pid:
        return satis_per
    if not _per_ad_cache_loaded:
        _personel_cache_yukle()
    with _per_ad_lock:
        return _per_ad_cache.get(pid, pid)


def _per_ad_guncelle(yeni: Dict[str, str]) -> None:
    """
    Yeni pid→ad eşleşmelerini bellek cache'e ve DB'ye yazar.
    Thread-safe; arka planda çağrılabilir.
    """
    if not yeni:
        return
    with _per_ad_lock:
        _per_ad_cache.update(yeni)
    try:
        with db() as (conn, cur):
            for pid, pad in yeni.items():
                cur.execute("""
                    INSERT INTO evo_personel_cache (personel_id, ad, guncelleme)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (personel_id) DO UPDATE
                        SET ad = EXCLUDED.ad, guncelleme = NOW()
                """, (pid, pad))
        log.info("evo_personel_cache: %d ad güncellendi", len(yeni))
    except Exception as exc:
        log.warning("evo_personel_cache DB yazma hatası: %s", exc)


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
    """Fatura detay cevabından satır kalemlerini çıkarır.
    Evobulut farklı anahtar isimleri kullanabilir: Detay (HS POS), Det, Satirlar..."""
    for key in ("Detay", "detay", "Det", "det", "Satirlar", "satirlar", "Satir", "satir"):
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


def faturajq_satis_ve_ikram(bastar: date, bittar: date) -> Dict[str, Dict[str, float]]:
    """
    Evo POS satışlarını **ücretli satış** ve **ikram (0₺ / tam iskonto)** olarak AYIRARAK döner.

    Akıllı Denetim için kritik: gerçek ikram POS'a 0₺ veya %100 iskonto olarak düşer.
    İkram olarak işaretlenmiş satış ≠ kayıt dışı kullanım (zimmet/sweethearting).

    İkram tespiti (sıralı kural):
      1. Satır birim fiyatı 0 veya çok düşük (< 1₺) → ikram
      2. İskonto tutarı ≈ brüt tutar (≥ %99 indirim) → ikram
      3. Açıklamada "ikram" / "hediye" / "promosyon" geçiyorsa → ikram

    Returns:
        {urun_adi: {"satis": float, "ikram": float, "toplam": float}}
    """
    faturalar = faturajq_listesi(bastar, bittar, tur=34)
    log.info("faturajq_satis_ve_ikram: %d adet Satış Fişi", len(faturalar))

    sonuc: Dict[str, Dict[str, float]] = {}
    IKRAM_KELIMELER = ("ikram", "hediye", "promosyon", "promo", "iade-ikram", "tadim")

    def _ikram_mi(s: Dict[str, Any]) -> bool:
        # 1. Birim fiyat ≤ 0.99
        try:
            br_fiyat = float(s.get("a_brm_fiyat") or s.get("birim_fiyat") or s.get("a_fiyat") or 0)
        except (TypeError, ValueError):
            br_fiyat = 0.0
        if br_fiyat < 1.0:
            try:
                tutar = float(s.get("a_tutar") or s.get("toplam") or 0)
            except (TypeError, ValueError):
                tutar = 0.0
            if tutar < 1.0:
                return True
        # 2. Tam iskonto (≥ %99)
        try:
            brut = float(s.get("a_brut") or s.get("a_brut_tut") or 0)
            iskonto = float(s.get("a_isk_tut") or s.get("iskonto") or 0)
        except (TypeError, ValueError):
            brut, iskonto = 0.0, 0.0
        if brut > 0 and iskonto > 0 and (iskonto / brut) >= 0.99:
            return True
        # 3. Açıklamada anahtar kelime
        ack = str(s.get("a_ack") or s.get("aciklama") or "").lower()
        if any(k in ack for k in IKRAM_KELIMELER):
            return True
        return False

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
            if not ad or mik <= 0:
                continue
            kayit = sonuc.setdefault(ad, {"satis": 0.0, "ikram": 0.0, "toplam": 0.0})
            if _ikram_mi(s):
                kayit["ikram"] += mik
            else:
                kayit["satis"] += mik
            kayit["toplam"] += mik

    return sonuc


# ─────────────────────────────────────────────
# 2b. HS_RAPOR — Hızlı Satış en çok satılan ürünler
# ─────────────────────────────────────────────

def _hs_web_token_al() -> str:
    """
    Web localStorage token'ı döndürür.
    Öncelik sırası:
      1. Bellekteki cache
      2. DB'deki kayıtlı token (evo_web_token)
      3. REST API (EVO_KULLANICI/EVO_SIFRE) ile otomatik UID token alma
    """
    global _hs_web_token
    # 1. Bellekteki cache
    if _hs_web_token:
        return _hs_web_token
    # 2. DB'den dene
    try:
        with db() as (conn, cur):
            cur.execute("SELECT deger FROM ayarlar WHERE anahtar='evo_web_token'")
            row = cur.fetchone()
            if row and row["deger"]:
                _hs_web_token = row["deger"]
                return _hs_web_token
    except Exception:
        pass
    # 3. REST API ile otomatik token al (EVO_KULLANICI + EVO_SIFRE)
    if EVO_USER and EVO_PASS:
        try:
            token = _token_al()  # ws.evobulut.com REST API UID
            _hs_web_token = token
            log.info("hs_rapor: REST API UID token otomatik alındı (%s...)", token[:8])
            # Önbellekle (DB'ye kaydetme — REST token kısa ömürlü, her seferinde alınır)
            return token
        except Exception as e:
            log.warning("hs_rapor: REST API otomatik token alınamadı: %s", e)
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


def _hs_cok_satilan(bastar: date, bittar: date) -> List[Dict]:
    """hs_rapor.ashx → Cok_Satilan ham listesi (fiyat alanlarını içerir)."""
    token = _hs_web_token_al()
    url = f"{EVO_WEB}/hizli/hs_rapor.ashx?evo_token={token}&evo_server=web.evobulut.com"
    body = {
        "komut": "FORM_LOAD",
        "tarih1": bastar.strftime("%d.%m.%Y 00:00:00"),
        "tarih2": bittar.strftime("%d.%m.%Y 23:59:59"),
        "personel": "0", "sube": "0",
    }
    headers = {"X-Requested-With": "XMLHttpRequest", "Referer": f"{EVO_WEB}/hizli/hs_rapor.html"}
    r = requests.post(url, data=body, headers=headers, timeout=20)
    if r.status_code != 200:
        return []
    try:
        d = r.json()
    except Exception:
        return []
    if str(d.get("Statu") or "").strip().upper() != "OK":
        _hs_web_token_temizle()
        return []
    return d.get("Cok_Satilan", []) or []


def evo_urun_fiyatlari(bastar: date, bittar: date, max_fatura: int = 80) -> Dict[str, float]:
    """Ürün adı → güncel birim SATIŞ fiyatı. Fatura detayı bloklu olduğundan
    hs_rapor Cok_Satilan'dan türetir: birim fiyat alanı ya da tutar/adet."""
    out: Dict[str, float] = {}
    for item in _hs_cok_satilan(bastar, bittar):
        ad = str(item.get("a_adi") or "").strip()
        if not ad:
            continue
        try:
            mik = float(item.get("satis_mik") or 0)
        except (ValueError, TypeError):
            mik = 0.0
        fiyat = None
        for kf in ("a_fiyat", "satis_fiyat", "birim_fiyat", "brm_fiyat", "a_brm_fiyat", "fiyat", "a_satis_fiyat", "ort_fiyat"):
            v = item.get(kf)
            try:
                if v not in (None, "", 0, "0") and float(v) >= 1:
                    fiyat = float(v); break
            except (ValueError, TypeError):
                pass
        if fiyat is None and mik > 0:
            for kt in ("satis_tutar", "tutar", "a_tutar", "toplam", "ciro", "satis_top", "a_satis_tutar", "net_tutar"):
                v = item.get(kt)
                try:
                    if v not in (None, "", 0, "0"):
                        fiyat = float(v) / mik; break
                except (ValueError, TypeError):
                    pass
        if fiyat and fiyat >= 1:
            out[ad] = round(fiyat, 2)
    return out


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
            # Token yok, REST API credentials da yok → cache'e düş
            cache = _evo_cache_oku("hs-rapor", bastar, bittar)
            if cache:
                veri = dict(cache["veri_json"])
                veri["kaynak"] = "cache"
                veri["canli"] = False
                veri["son_cekim_ts"] = cache["cekim_ts"].isoformat()
                return veri
            raise HTTPException(
                503,
                "EVO_WEB_TOKEN tanımlı değil. /api/evo/set-web-token ile token girin."
            )

    if not sonuc:
        # Canlı veri gelmedi (boş sonuç) → son başarılı çekimi göster
        cache = _evo_cache_oku("hs-rapor", bastar, bittar)
        if cache:
            veri = dict(cache["veri_json"])
            veri["kaynak"] = "cache"
            veri["canli"] = False
            veri["son_cekim_ts"] = cache["cekim_ts"].isoformat()
            return veri

    sonuc_dict = {
        "bastar": str(bastar),
        "bittar": str(bittar),
        "urun_sayisi": len(sonuc),
        "kaynak": kaynak,
        "urunler": dict(sorted(sonuc.items(), key=lambda x: -x[1])),
    }
    if sonuc:
        _evo_cache_yaz("hs-rapor", bastar, bittar, sonuc_dict)
        sonuc_dict["canli"] = True
        sonuc_dict["son_cekim_ts"] = datetime.now().isoformat()
    return sonuc_dict


# ─── Malzeme (bardak/kap) eşleme tablosu ───────────────────────────────────
# Grup_Pasta kategori adı → kullanılan malzeme
_MALZEME_MAP: Dict[str, str] = {
    "Ice":         "Plastik Bardak",
    "14 Oz":       "14oz Karton Bardak",
    "8 Oz":        "8oz Karton Bardak",
    "Su":          "Su Şişesi",
    "Redbull":     "Kutu (Redbull)",
    "Pasta":       "Pasta Tabağı",
    "ÇAY":         "Çay Bardağı",
    "Maden Suyu":  "Maden Suyu Şişesi",
}


def _hs_rapor_ham_veri(bastar: date, bittar: date, sube_id: str = "0") -> Dict:
    """
    hs_rapor.ashx'ten ham JSON döndürür: S, Cok_Satilan, Grup_Pasta, kasa, banka.
    sube_id='0' tüm şubeler; herhangi bir Evo şube ID'si verilirse filtreleme uygular.
    Web token geçersizse otomatik yenileme dener (REST API UID ile).
    """
    def _cek_token(token: str) -> Dict:
        url = f"{EVO_WEB}/hizli/hs_rapor.ashx?evo_token={token}&evo_server=web.evobulut.com"
        body = {
            "komut":    "FORM_LOAD",
            "tarih1":   bastar.strftime("%d.%m.%Y 00:00:00"),
            "tarih2":   bittar.strftime("%d.%m.%Y 23:59:59"),
            "personel": "0",
            "sube":     str(sube_id or "0"),
        }
        headers = {"X-Requested-With": "XMLHttpRequest", "Referer": f"{EVO_WEB}/hizli/hs_rapor.html"}
        r = requests.post(url, data=body, headers=headers, timeout=20)
        if r.status_code != 200:
            raise HTTPException(502, f"hs_rapor.ashx HTTP {r.status_code}")
        return r.json()

    # 1. Önce mevcut token ile dene
    try:
        token = _hs_web_token_al()
        d = _cek_token(token)
        statu = str(d.get("Statu") or "").strip().upper()
        if statu in _EVO_AUTH_HATA or statu != "OK":
            _hs_web_token_temizle()
            raise HTTPException(503, "token_gecersiz")
        # Token çalıştı ama S boşsa REST API UID denemesi yap
        if d.get("S") or d.get("Cok_Satilan"):
            return d
    except HTTPException:
        pass

    # 2. REST API UID token ile dene (EVO_KULLANICI/EVO_SIFRE)
    if EVO_USER and EVO_PASS:
        try:
            rest_token = _token_al()
            d2 = _cek_token(rest_token)
            statu2 = str(d2.get("Statu") or "").strip().upper()
            if statu2 == "OK" and (d2.get("S") or d2.get("Cok_Satilan")):
                return d2
        except Exception:
            pass

    raise HTTPException(503, "hs_rapor verisi alınamadı — token yenileyin veya EVO_KULLANICI/EVO_SIFRE kontrol edin")


@router.get("/sube-analiz")
def evo_sube_analiz(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
):
    """
    Şube bazlı satış analizi:
    - Her şube için ciro + fiş sayısı (S dizisinden)
    - Grup_Pasta → kategori bazlı satış + malzeme hesabı
    - Cok_Satilan → en çok satan 20 ürün
    """
    try:
        bs = date.fromisoformat(bastar)
        bt = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Geçersiz tarih formatı (YYYY-MM-DD)")

    try:
        d = _hs_rapor_ham_veri(bs, bt)
        kaynak = "hs_rapor"
    except HTTPException as e:
        raise HTTPException(e.status_code, e.detail)

    # 1. Şube bazlı ciro (S dizisinden)
    sube_ciro: Dict[str, Dict] = {}
    for fis in d.get("S", []):
        ad = str(fis.get("a_sube_adi") or "").strip()
        if not ad:
            continue
        if ad not in sube_ciro:
            sube_ciro[ad] = {"ciro": 0.0, "fis_sayisi": 0}
        try:
            sube_ciro[ad]["ciro"] += float(fis.get("a_tutar") or 0)
        except (ValueError, TypeError):
            pass
        sube_ciro[ad]["fis_sayisi"] += 1

    # 2. Grup_Pasta → malzeme hesabı
    grup_pasta = []
    for g in d.get("Grup_Pasta", []):
        ad = str(g.get("a_adi") or "").strip()
        try:
            mik = float(g.get("satis_mik") or 0)
            tut = float(g.get("satis_tut") or 0)
        except (ValueError, TypeError):
            mik, tut = 0.0, 0.0
        grup_pasta.append({
            "kategori":  ad,
            "adet":      mik,
            "ciro":      round(tut, 2),
            "malzeme":   _MALZEME_MAP.get(ad, ad),
        })

    # 3. Cok_Satilan
    cok_satilan = []
    for u in d.get("Cok_Satilan", []):
        ad = str(u.get("a_adi") or "").strip()
        try:
            mik = float(u.get("satis_mik") or 0)
            tut = float(u.get("satis_tut") or 0)
        except (ValueError, TypeError):
            mik, tut = 0.0, 0.0
        cok_satilan.append({"urun": ad, "adet": mik, "ciro": round(tut, 2)})

    # 4. Kasa/banka özeti
    kasa_ozet = [{"ad": k.get("a_adi",""), "tutar": float(k.get("tutar",0))} for k in d.get("kasa",[])]
    banka_ozet = [{"ad": b.get("a_adi",""), "tutar": float(b.get("tutar",0))} for b in d.get("banka",[])]

    return {
        "bastar":     str(bs),
        "bittar":     str(bt),
        "kaynak":     kaynak,
        "toplam_fis": len(d.get("S", [])),
        "subeler":    sube_ciro,
        "grup_pasta": grup_pasta,
        "cok_satilan": cok_satilan,
        "kasa":       kasa_ozet,
        "banka":      banka_ozet,
    }


@router.get("/sube-urunler")
def evo_sube_urunler(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
    sube_adi: str = Query(..., description="Şube adı (örn: Zafer Şubesi)"),
    max_fatura: int = Query(30, ge=1, le=50, description="Maksimum işlenecek fatura sayısı"),
):
    """
    Belirli bir şubenin ürün bazlı satış detayları.
    hs_rapor S dizisinden o şubenin fatura ID'leri alınır,
    paralel REST API çağrılarıyla ürün kalemleri hesaplanır.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        bs = date.fromisoformat(bastar)
        bt = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Geçersiz tarih formatı (YYYY-MM-DD)")

    # hs_rapor'dan tüm veri
    try:
        ham = _hs_rapor_ham_veri(bs, bt)
    except HTTPException as e:
        raise HTTPException(e.status_code, e.detail)

    # Şubeye ait faturaları filtrele
    sube_faturalari = [
        f for f in ham.get("S", [])
        if str(f.get("a_sube_adi") or "").strip() == sube_adi.strip()
    ]

    if not sube_faturalari:
        return {
            "bastar": str(bs), "bittar": str(bt),
            "sube_adi": sube_adi, "toplam_fis": 0,
            "ciro": 0.0, "urunler": [],
            "uyari": "Bu şubede fiş bulunamadı",
        }

    toplam_fis = len(sube_faturalari)
    ciro = sum(float(f.get("a_tutar") or 0) for f in sube_faturalari)

    # İşlenecek fatura ID'leri (en yeni, max_fatura adet)
    fatura_ids = [str(f.get("a_id") or "") for f in sube_faturalari if f.get("a_id")]
    fatura_ids = fatura_ids[:max_fatura]

    # Paralel fatura detay çek
    urun_toplam: Dict[str, float] = {}

    def _cek(fid: str) -> Dict[str, float]:
        sonuc: Dict[str, float] = {}
        try:
            detay = evo_fatura_detay(fid)
            for s in _satirlari_coz(detay):
                ad = str(
                    s.get("a_stok_adi") or s.get("stok_adi") or
                    s.get("a_adi") or s.get("urun_adi") or ""
                ).strip()
                try:
                    mik = float(s.get("a_miktar") or s.get("miktar") or 0)
                except (ValueError, TypeError):
                    mik = 0.0
                if ad and mik > 0:
                    sonuc[ad] = sonuc.get(ad, 0) + mik
        except Exception:
            pass
        return sonuc

    with ThreadPoolExecutor(max_workers=8) as exe:
        futures = {exe.submit(_cek, fid): fid for fid in fatura_ids}
        for fut in as_completed(futures):
            for ad, mik in fut.result().items():
                urun_toplam[ad] = urun_toplam.get(ad, 0) + mik

    urunler = [
        {"urun": ad, "adet": mik}
        for ad, mik in sorted(urun_toplam.items(), key=lambda x: -x[1])
    ]

    return {
        "bastar":       str(bs),
        "bittar":       str(bt),
        "sube_adi":     sube_adi,
        "toplam_fis":   toplam_fis,
        "islenen_fis":  len(fatura_ids),
        "ciro":         round(ciro, 2),
        "urunler":      urunler,
        "uyari": (
            f"{toplam_fis} fişin {len(fatura_ids)} tanesi işlendi — tam veri için max_fatura artırın"
            if len(fatura_ids) < toplam_fis else None
        ),
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


# ════════════════════════════════════════════════════════════════════════════
#  KEŞİF ENDPOINT — Evo'da bardak/su/soda detayı var mı?
# ════════════════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════════════════
#  EVO GRUP TAKSONOMİSİ — hs_rapor Grup_Pasta'da gözüken gerçek gruplar
# ════════════════════════════════════════════════════════════════════════════
# Evobulut'un kendi "Grup_Pasta" çıktısı şu gruplar:
#   Ice, 14 Oz, 8 Oz, Su, Maden Suyu, Redbull, Pasta, ÇAY
#
# Bunları ürün adından geri-çıkarmak için pattern-match (büyük/küçük harf duyarsız).
# Hedef: bizim Akıllı Denetim boyutlarına ve TruthMotor'a sağlam mapping.
# ════════════════════════════════════════════════════════════════════════════
EVO_GRUPLARI = ("Ice", "14 Oz", "8 Oz", "Su", "Maden Suyu", "Redbull", "Pasta", "ÇAY")

# Evo dahili şube ID'leri → şube adı (test edilerek doğrulandı 2026-05-19)
# Yeni şube eklenirse buraya manuel ekleyin (ileride subeler.evo_sube_id kolonu ile otomatize).
EVO_SUBE_ID_MAP = {
    "2": "Zafer Şubesi",
    "3": "Alsancak Şubesi",
    "4": "Gazze Şubesi",
    "5": "Köyceğiz Şubesi",
}


def evo_grup_belirle(urun_adi: str) -> str:
    """Ürün adından Evo grup adını çıkar.
    Sıra önemli — özel öncelik (14 Oz, 8 Oz) Ice'tan önce kontrol edilir."""
    if not urun_adi:
        return ""
    a = str(urun_adi).strip().lower()
    # 14 Oz / 8 Oz öncelikli (boyut ürün adında geçtiğinde)
    if "14 oz" in a or "14oz" in a:
        return "14 Oz"
    if "8 oz" in a or "8oz" in a:
        return "8 Oz"
    # Ice / Iced / Frozen — soğuk içecek → plastik bardak grubu
    if "ice" in a or "iced" in a or "frozen" in a:
        return "Ice"
    # Su (önce Maden Suyu, sonra düz Su)
    if "maden" in a:
        return "Maden Suyu"
    if a == "su" or a.startswith("su ") or " su" == a[-3:] or "şişe su" in a or "sise su" in a:
        return "Su"
    # Redbull / Energy
    if "redbull" in a or "red bull" in a or "energy" in a:
        return "Redbull"
    # Pasta / kek / tatlı
    if "pasta" in a or "kek" in a or "tatlı" in a or "tatli" in a:
        return "Pasta"
    # Çay
    if "çay" in a or "cay" in a or "tea" in a:
        return "ÇAY"
    return ""  # bilinmeyen — grup dışı (örn. türk kahvesi, limonata, espresso vs.)


# Evo grup → Akıllı Denetim boyutu mapping
EVO_GRUP_BOYUT = {
    "Ice":        "bardak_plastik",
    "14 Oz":      "bardak_karton",   # büyük karton
    "8 Oz":       "bardak_karton",   # küçük karton (aynı boyutta toplanır)
    "Su":         "su",
    "Maden Suyu": "su",              # soda alternatifine de düşülebilir; şimdilik su
    "Redbull":    "redbull_soda",
    "Pasta":      "pasta",
    "ÇAY":        "",                # boyut dışı (porselen kupa, sayım yok)
}


def evo_ikram_satir_mi(s: Dict[str, Any]) -> bool:
    """Detay satırının ikram olup olmadığı (0₺ veya %99+ iskonto veya 'ikram' anahtarı)."""
    try:
        br = float(s.get("a_brm_fiy") or s.get("a_fiy") or 0)
        tut = float(s.get("a_tutar") or 0)
    except (TypeError, ValueError):
        br, tut = 0.0, 0.0
    if br < 1.0 and tut < 1.0:
        return True
    try:
        brut = float(s.get("a_isk1_mat") or s.get("a_tutar_kdvh") or 0)
        isk = float(s.get("a_isk_tutar") or 0)
    except (TypeError, ValueError):
        brut, isk = 0.0, 0.0
    if brut > 0 and isk > 0 and (isk / brut) >= 0.99:
        return True
    ack = str(s.get("a_ack") or "").lower()
    return any(k in ack for k in ("ikram", "hediye", "promosyon", "promo", "tadim"))


def hs_rapor_sube_bazli(bastar: date, bittar: date) -> Dict[str, Any]:
    """Her Evo şubesi için ayrı hs_rapor çağrısı → şube × grup × ciro matrisi.

    Veri kaynağı: hs_rapor.ashx sube=N parametresi (gerçek Evo şube ID).
    Fatura detayı çekilmez (yavaş + hatalı), doğrudan Grup_Pasta toplamı kullanılır.

    Returns:
      {
        "tarih_bas", "tarih_bit",
        "subeler": {
          "Zafer Şubesi": {
            "evo_sube_id": "2",
            "fatura_sayisi": N,
            "ciro_toplam": N,
            "iskonto_toplam": N,
            "nakit": N, "kart": N,
            "gruplar": {"Ice": {"adet": N, "ciro": N}, ...},
            "cok_satilan": [{stok_kodu, ad, grup, adet, ciro}],
            "personel_satislar": [{personel_id, ad, ciro, fis_sayisi}]
          }
        }
      }
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    sonuc_subeler: Dict[str, Any] = {}

    def _sube_cek(evo_id: str, ad: str) -> Dict[str, Any]:
        try:
            d = _hs_rapor_ham_veri(bastar, bittar, sube_id=evo_id)
        except Exception as e:
            log.warning("hs_rapor sube=%s hata: %s", evo_id, e)
            return None

        # Fatura toplamları
        s_list = d.get("S") or []
        ciro_top = 0.0
        iskonto_top = 0.0
        personel_map: Dict[str, Dict[str, Any]] = {}
        yeni_per_eslesme: Dict[str, str] = {}  # bu çekimde ilk kez görülen gerçek isimler
        for f in s_list:
            try:
                ciro_top += float(f.get("a_tutar") or 0)
                iskonto_top += float(f.get("a_isk_tut") or 0)
            except (TypeError, ValueError):
                pass
            pid = str(f.get("a_per_id") or "0")
            satis_per = str(f.get("SATIS_PER") or "").strip()

            # ── Gruplama anahtarı ──────────────────────────────────────────────
            # Hızlı Satış modunda a_per_id=0 gelir ama SATIS_PER ismi taşır.
            # Bu durumda herkesi "0" bucket'ında birleştirmek yerine ismi anahtar
            # olarak kullanıyoruz — böylece her personel ayrı satırda görünür.
            if pid == "0" and satis_per:
                gruplama_k = f"isim:{satis_per}"
                pad = satis_per
            else:
                gruplama_k = pid
                # Gerçek isim geldiyse cache'e ekle (a_per_id biliniyorsa)
                if satis_per and pid and pid != "0":
                    yeni_per_eslesme[pid] = satis_per
                pad = _per_ad_bul(pid, satis_per)

            p = personel_map.setdefault(gruplama_k, {"ad": pad, "personel_id": pid, "ciro": 0.0, "fis_sayisi": 0})
            # Eğer cache'den daha iyi bir isim geldiyse güncelle
            if pad != pid and p["ad"] == pid:
                p["ad"] = pad
            try:
                p["ciro"] += float(f.get("a_tutar") or 0)
            except (TypeError, ValueError):
                pass
            p["fis_sayisi"] += 1

        # Grup_Pasta — Evo'nun grup dağılımı
        gruplar = {g: {"adet": 0.0, "ciro": 0.0} for g in EVO_GRUPLARI}
        for g in (d.get("Grup_Pasta") or []):
            g_ad = str(g.get("a_adi") or "").strip()
            try:
                mik = float(g.get("satis_mik") or 0)
                tut = float(g.get("satis_tut") or 0)
            except (TypeError, ValueError):
                mik, tut = 0.0, 0.0
            if g_ad in gruplar:
                gruplar[g_ad]["adet"] += mik
                gruplar[g_ad]["ciro"] += tut

        # Cok_Satilan — ürün listesi (stok_kodu, ad, grup çıkarımı)
        cok = []
        for u in (d.get("Cok_Satilan") or []):
            u_ad = str(u.get("a_adi") or "").strip()
            try:
                mik = float(u.get("satis_mik") or 0)
                tut = float(u.get("satis_tut") or 0)
            except (TypeError, ValueError):
                mik, tut = 0.0, 0.0
            cok.append({
                "stok_kodu": str(u.get("a_kod") or ""),
                "ad": u_ad,
                "grup": evo_grup_belirle(u_ad),
                "adet": round(mik, 2),
                "ciro": round(tut, 2),
            })
        cok.sort(key=lambda x: -x["adet"])

        # kasa (nakit) — şube adı eşleşmesi
        nakit = 0.0
        kart = 0.0
        for k in (d.get("kasa") or []):
            k_ad = str(k.get("a_adi") or "")
            try:
                tut = float(k.get("tutar") or 0)
            except (TypeError, ValueError):
                tut = 0.0
            # bu şubenin kasa adı içeriyorsa say
            sube_kelime = ad.replace(" Şubesi", "").strip()
            if sube_kelime.lower() in k_ad.lower():
                nakit += tut
        for b in (d.get("banka") or []):
            b_ad = str(b.get("a_adi") or "")
            try:
                tut = float(b.get("tutar") or 0)
            except (TypeError, ValueError):
                tut = 0.0
            sube_kelime = ad.replace(" Şubesi", "").strip()
            if sube_kelime.lower() in b_ad.lower():
                kart += tut

        personel_listesi = [
            {"personel_id": p.get("personel_id", k), "ad": p["ad"],
             "ciro": round(p["ciro"], 2), "fis_sayisi": p["fis_sayisi"]}
            for k, p in personel_map.items() if p["fis_sayisi"] > 0
        ]
        personel_listesi.sort(key=lambda x: -x["ciro"])

        return {
            "evo_sube_id": evo_id,
            "fatura_sayisi": len(s_list),
            "ciro_toplam": round(ciro_top, 2),
            "iskonto_toplam": round(iskonto_top, 2),
            "nakit": round(nakit, 2),
            "kart": round(kart, 2),
            "gruplar": {g: {"adet": round(v["adet"], 2), "ciro": round(v["ciro"], 2)}
                        for g, v in gruplar.items() if v["adet"] > 0},
            "cok_satilan": cok[:50],
            "personel_satislar": personel_listesi,
            "_yeni_per": yeni_per_eslesme,  # iç kullanım: cache güncelleme
        }

    # Personel cache ilk istekte DB'den yüklensin
    _personel_cache_yukle()

    # Paralel çek — 4 şube
    tum_yeni_per: Dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=4) as exe:
        futures = {exe.submit(_sube_cek, eid, ad): (eid, ad)
                   for eid, ad in EVO_SUBE_ID_MAP.items()}
        for fut in as_completed(futures):
            eid, ad = futures[fut]
            res = fut.result()
            if res is not None:
                # Yeni eşleşmeleri topla
                tum_yeni_per.update(res.pop("_yeni_per", {}))
                sonuc_subeler[ad] = res

    # Yeni isim eşleşmeleri varsa cache + DB'ye yaz (arka planda)
    if tum_yeni_per:
        t = threading.Thread(target=_per_ad_guncelle, args=(tum_yeni_per,), daemon=True)
        t.start()

    return {
        "tarih_bas": str(bastar),
        "tarih_bit": str(bittar),
        "sube_sayisi": len(sonuc_subeler),
        "kaynak": "hs_rapor.sube",
        "subeler": sonuc_subeler,
    }


# Evo Grup_Pasta → bar-ozet / Kullanılan Ürünler satır etiketi
EVO_GRUP_BAR_OZET: Dict[str, tuple] = {
    "14 Oz": ("bardak_buyuk", "14oz karton bardak"),
    "8 Oz": ("bardak_kucuk", "8oz karton bardak"),
    "Ice": ("bardak_plastik", "plastik bardak"),
    "Su": ("su_adet", "su"),
    "Maden Suyu": ("soda_adet", "maden suyu"),
    "Redbull": ("redbull_adet", "redbull"),
    "Pasta": ("pasta_adet", "pasta"),
}


def _sube_ad_eslesme_anahtar(s: str) -> str:
    """Şube adı eşleşmesi için Türkçe-güvenli, aksandan arınmış anahtar.

    KÖYCEĞİZ vs «Köyceğiz Şubesi» neden tutmuyordu? Python'un default lower()'ı
    büyük «İ» (U+0130) harfini «i» + görünmez birleşik nokta (U+0307) yapar →
    'köyceği̇z' (9 harf) ≠ 'köyceğiz' (8 harf), substring eşleşmesi patlar.
    Çözüm: NFKD ile aksanları ayır, birleşik işaretleri (U+0307 vb.) at →
    her iki taraf da ASCII'ye iner: 'koycegiz'."""
    s = (s or "").replace("İ", "i").replace("I", "ı")  # TR büyük-İ/I tuzağı
    s = unicodedata.normalize("NFKD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.replace("subesi", "").strip()


# Evvel şube adı (normalize) → Evo'daki karşılığı(ları) (aynı fiziksel şube,
# farklı isim). TEMA (Evvel) = «Gazze Şubesi» (Evo) — kullanıcı doğruladı.
# İsimler harf paylaşmadığından substring eşleşmesi tutmaz; açık eşleme şart.
_SUBE_AD_ALIAS: Dict[str, List[str]] = {
    "tema": ["gazze"],
}


def _evvel_sube_evo_payload_eslestir(
    sube_adi_evvel: str,
    evo_subeler: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    evvel_key = _sube_ad_eslesme_anahtar(sube_adi_evvel)
    if not evvel_key:
        return None
    # Kendi anahtarı + takma adları (TEMA → gazze gibi)
    adaylar = [evvel_key, *_SUBE_AD_ALIAS.get(evvel_key, [])]
    for evo_ad, payload in (evo_subeler or {}).items():
        ekey = _sube_ad_eslesme_anahtar(str(evo_ad or ""))
        if not ekey:
            continue
        if any(a in ekey or ekey in a for a in adaylar):
            return payload
    return None


def evo_bar_adet_by_sube_id(cur: Any, hedef: date) -> Dict[str, Any]:
    """
    Tek gün için şube_id → bar_key → {adet, etiket, grup}.
    Kaynak: hs_rapor Grup_Pasta (Evo Hızlı Satış).

    Dönüş:
      by_sube — eşleşen şubeler
      evo_veri_geldi — en az bir şubede Evo adedi var mı
      evo_mesaj — veri yoksa kullanıcıya gösterilecek kısa metin
      canli — bu sonuç anlık mı yoksa önceki başarılı çekimden mi (cache)
      son_cekim_ts — verinin alındığı zaman (ISO)
    """
    out: Dict[str, Dict[str, Dict[str, Any]]] = {}
    evo_mesaj: Optional[str] = None
    try:
        evo = hs_rapor_sube_bazli_cached(hedef, hedef)
        evo_canli = bool(evo.get("canli"))
        evo_son_cekim_ts = evo.get("son_cekim_ts")
        evo_subeler = evo.get("subeler") or {}
        if not evo_subeler:
            return {
                "by_sube": {},
                "evo_veri_geldi": False,
                "evo_mesaj": "Evo veri gelmedi — hs_rapor boş (token veya bağlantı kontrol edin)",
                "canli": evo_canli,
                "son_cekim_ts": evo_son_cekim_ts,
            }
        cur.execute("SELECT id::text AS id, ad FROM subeler")
        eslesen = 0
        for row in cur.fetchall() or []:
            sid = str(row.get("id") or "")
            ad = str(row.get("ad") or "")
            payload = _evvel_sube_evo_payload_eslestir(ad, evo_subeler)
            if not payload:
                continue
            eslesen += 1
            by_bar: Dict[str, Dict[str, Any]] = {}
            for grup, (bkey, etiket) in EVO_GRUP_BAR_OZET.items():
                g = (payload.get("gruplar") or {}).get(grup) or {}
                adet = float(g.get("adet") or 0)
                if adet <= 0:
                    continue
                prev = by_bar.get(bkey)
                if prev:
                    prev["adet"] = float(prev.get("adet") or 0) + adet
                else:
                    by_bar[bkey] = {
                        "adet": adet,
                        "etiket": etiket,
                        "grup": grup,
                    }
            if by_bar:
                out[sid] = by_bar
        if out:
            mesaj = None
            if not evo_canli:
                ts_str = ""
                if evo_son_cekim_ts:
                    try:
                        ts_str = datetime.fromisoformat(str(evo_son_cekim_ts)).strftime("%d.%m %H:%M")
                    except Exception:
                        ts_str = str(evo_son_cekim_ts)
                mesaj = f"Evo canlı veri gelmedi — {ts_str} tarihli son başarılı çekim gösteriliyor".strip()
            return {
                "by_sube": out,
                "evo_veri_geldi": True,
                "evo_mesaj": mesaj,
                "canli": evo_canli,
                "son_cekim_ts": evo_son_cekim_ts,
            }
        if eslesen <= 0:
            evo_mesaj = "Evo veri gelmedi — şube adı eşleşmedi (EVO_SUBE_ID_MAP kontrol edin)"
        else:
            evo_mesaj = "Evo veri gelmedi — o gün için grup satışı (Grup_Pasta) boş"
    except Exception as e:
        log.warning("evo_bar_adet_by_sube_id: %s", e)
        evo_mesaj = "Evo veri gelmedi — hs_rapor hatası"
    return {
        "by_sube": out,
        "evo_veri_geldi": False,
        "evo_mesaj": evo_mesaj or "Evo veri gelmedi",
        "canli": False,
        "son_cekim_ts": None,
    }


def faturajq_sube_grup_detay(bastar: date, bittar: date,
                              max_fatura: int = 1000) -> Dict[str, Any]:
    """Şube × grup × {ucretli, ikram, ciro} matrisi + şube nakit/kart + personel × ürün.

    Veri yolu:
      1. faturajq_listesi(tur=34) → tüm fatura header (a_id, a_sube_adi, a_tutar, a_cdate)
      2. her fatura için paralel evo_fatura_detay → satır kalemleri
      3. her satır → a_sube_id eşlemesi (header a_sube_adi ile cross-check)
      4. ürün adından grup çıkarımı → şube × grup matrisi
      5. hs_rapor → kasa + banka dizilerinden şube bazlı nakit/kart toplamı

    Returns:
      {
        "tarih_bas": "...", "tarih_bit": "...",
        "subeler": {
          "Zafer Şubesi": {
            "fatura_sayisi": N, "ciro_toplam": N, "iskonto_toplam": N,
            "nakit": N, "kart": N,
            "gruplar": {"Ice": {"adet": N, "ikram_adet": N, "ciro": N}, ...},
            "urunler": [{"stok_kodu", "ad", "grup", "adet", "ikram_adet", "ciro"}],
            "personel_satislar": {"49671": {"ad": "?", "adet": N, "ciro": N}}
          }
        }
      }
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # 1. hs_rapor ile şube nakit/kart toplamı
    nakit_map: Dict[str, float] = {}
    kart_map: Dict[str, float] = {}
    ham: Dict[str, Any] = {}
    try:
        ham = _hs_rapor_ham_veri(bastar, bittar)
        for k in (ham.get("kasa") or []):
            ad = str(k.get("a_adi") or "").strip()
            try:
                tut = float(k.get("tutar") or 0)
            except (TypeError, ValueError):
                tut = 0.0
            # "Zafer Şubesi Nakit Kasa" → "Zafer Şubesi"
            sube_ad = ad.replace(" Nakit Kasa", "").replace(" Nakit", "").strip()
            if sube_ad:
                nakit_map[sube_ad] = nakit_map.get(sube_ad, 0) + tut
        for b in (ham.get("banka") or []):
            ad = str(b.get("a_adi") or "").strip()
            try:
                tut = float(b.get("tutar") or 0)
            except (TypeError, ValueError):
                tut = 0.0
            # "Zafer Pos" → "Zafer Şubesi" (manuel mapping)
            sube_ad = ad.replace(" Pos", "").strip()
            kart_map[sube_ad] = kart_map.get(sube_ad, 0) + tut
    except Exception as e:
        log.warning("hs_rapor kasa/banka cekilemedi: %s", e)

    # 2. Faturalar — önce hs_rapor.S (REST API fallback'li, sağlam),
    #               yoksa faturajq.ashx (web token).
    faturalar = ham.get("S") if ham else None
    kaynak = "hs_rapor.S"
    if not faturalar:
        log.info("sube-grup-detay: hs_rapor.S boş, faturajq dene")
        try:
            faturalar = faturajq_listesi(bastar, bittar, tur=34)
            kaynak = "faturajq"
        except Exception:
            faturalar = []
    if not faturalar:
        return {
            "tarih_bas": str(bastar), "tarih_bit": str(bittar),
            "fatura_islendi": 0, "subeler": {},
            "uyari": "Eşleşen fatura yok",
            "kaynak": kaynak,
        }

    # Sınır
    faturalar = faturalar[:max_fatura]

    # Fatura header bilgisi (a_id → {sube_adi, ciro, iskonto, tarih})
    fatura_meta: Dict[str, Dict[str, Any]] = {}
    for f in faturalar:
        fid = str(f.get("a_id") or f.get("G.a_id") or "").strip()
        if not fid:
            continue
        fatura_meta[fid] = {
            "sube_adi": str(f.get("a_sube_adi") or "").strip(),
            "ciro": float(f.get("a_tutar") or 0) if f.get("a_tutar") else 0.0,
            "iskonto": float(f.get("a_isk_tut") or 0) if f.get("a_isk_tut") else 0.0,
            "tarih": str(f.get("a_cdate") or f.get("a_tarih") or ""),
            "personel_id": str(f.get("a_per_id") or ""),
            "personel_ad": str(f.get("SATIS_PER") or "").strip() or None,
        }

    # 3. Detayları paralel çek
    sube_data: Dict[str, Any] = {}

    def _yeni_sube_kayit(ad: str) -> Dict[str, Any]:
        return {
            "fatura_sayisi": 0,
            "ciro_toplam": 0.0,
            "iskonto_toplam": 0.0,
            "nakit": nakit_map.get(ad, 0.0),
            "kart": kart_map.get(ad, 0.0),
            "gruplar": {g: {"adet": 0.0, "ikram_adet": 0.0, "ciro": 0.0}
                        for g in EVO_GRUPLARI},
            "urunler_map": {},  # stok_kodu → {ad, grup, adet, ikram, ciro}
            "personel_satislar": {},  # personel_id → {ad, adet, ciro}
            "bilinmeyen_urunler": {},  # grup dışı ürünler (debug)
        }

    detay_hata_sayisi = 0
    detay_bos_sayisi = 0
    detay_basari_sayisi = 0

    def _islem(fid: str):
        meta = fatura_meta.get(fid) or {}
        sube_ad = meta.get("sube_adi") or "?"
        satirlar = []
        hata = None
        try:
            detay = evo_fatura_detay(fid)
            satirlar = _satirlari_coz(detay)
        except Exception as e:
            hata = str(e)[:200]
        return fid, sube_ad, meta, satirlar, hata

    # max_workers=4 (token paralel istek limitlerini düşürmek için)
    with ThreadPoolExecutor(max_workers=4) as exe:
        futures = [exe.submit(_islem, fid) for fid in fatura_meta.keys()]
        for fut in as_completed(futures):
            fid, sube_ad, meta, satirlar, hata = fut.result()
            if hata:
                detay_hata_sayisi += 1
                if detay_hata_sayisi <= 3:
                    log.warning("sube-grup-detay detay hata fid=%s: %s", fid, hata)
            elif not satirlar:
                detay_bos_sayisi += 1
            else:
                detay_basari_sayisi += 1
            if sube_ad not in sube_data:
                sube_data[sube_ad] = _yeni_sube_kayit(sube_ad)
            d = sube_data[sube_ad]
            d["fatura_sayisi"] += 1
            d["ciro_toplam"] += meta.get("ciro", 0)
            d["iskonto_toplam"] += meta.get("iskonto", 0)
            pid = meta.get("personel_id") or "0"
            pad = meta.get("personel_ad") or pid
            if pid not in d["personel_satislar"]:
                d["personel_satislar"][pid] = {"ad": pad, "adet": 0.0, "ciro": 0.0}

            for s in satirlar:
                ad = str(s.get("a_stok_adi") or s.get("stok_adi") or "").strip()
                kod = str(s.get("a_kod") or "").strip()
                if not ad and not kod:
                    continue
                try:
                    mik = float(s.get("a_mik") or s.get("a_mik_cik") or 0)
                    tut = float(s.get("a_tutar") or 0)
                except (TypeError, ValueError):
                    mik, tut = 0.0, 0.0
                if mik <= 0:
                    continue
                ikram = evo_ikram_satir_mi(s)
                grup = evo_grup_belirle(ad)

                # Ürün kayıt
                urec = d["urunler_map"].setdefault(kod or ad, {
                    "stok_kodu": kod, "ad": ad, "grup": grup,
                    "adet": 0.0, "ikram_adet": 0.0, "ciro": 0.0,
                })
                urec["adet"] += mik
                urec["ciro"] += tut
                if ikram:
                    urec["ikram_adet"] += mik

                # Grup kayıt
                if grup:
                    g = d["gruplar"][grup]
                    g["adet"] += mik
                    if ikram:
                        g["ikram_adet"] += mik
                    g["ciro"] += tut
                else:
                    d["bilinmeyen_urunler"][ad] = d["bilinmeyen_urunler"].get(ad, 0) + mik

                # Personel kayıt
                d["personel_satislar"][pid]["adet"] += mik
                d["personel_satislar"][pid]["ciro"] += tut

    # 4. Çıktıyı temizle (urunler_map → list, vs.)
    sonuc_subeler = {}
    for ad, d in sube_data.items():
        urunler = sorted(d["urunler_map"].values(), key=lambda x: -x["adet"])
        for u in urunler:
            u["adet"] = round(u["adet"], 2)
            u["ikram_adet"] = round(u["ikram_adet"], 2)
            u["ciro"] = round(u["ciro"], 2)
        gruplar = {}
        for g, v in d["gruplar"].items():
            if v["adet"] > 0 or v["ikram_adet"] > 0:
                gruplar[g] = {
                    "adet": round(v["adet"], 2),
                    "ikram_adet": round(v["ikram_adet"], 2),
                    "ciro": round(v["ciro"], 2),
                }
        personel = []
        for pid, p in d["personel_satislar"].items():
            if p["adet"] > 0:
                personel.append({
                    "personel_id": pid, "ad": p["ad"],
                    "adet": round(p["adet"], 2), "ciro": round(p["ciro"], 2),
                })
        personel.sort(key=lambda x: -x["ciro"])
        sonuc_subeler[ad] = {
            "fatura_sayisi": d["fatura_sayisi"],
            "ciro_toplam": round(d["ciro_toplam"], 2),
            "iskonto_toplam": round(d["iskonto_toplam"], 2),
            "nakit": round(d["nakit"], 2),
            "kart": round(d["kart"], 2),
            "gruplar": gruplar,
            "urunler": urunler[:200],
            "personel_satislar": personel,
            "bilinmeyen_urunler": dict(sorted(
                d["bilinmeyen_urunler"].items(), key=lambda x: -x[1]
            )[:20]),
        }

    return {
        "tarih_bas": str(bastar), "tarih_bit": str(bittar),
        "fatura_islendi": len(fatura_meta),
        "fatura_toplam": len(faturalar),
        "sube_sayisi": len(sonuc_subeler),
        "kaynak": kaynak,
        "detay_basari": detay_basari_sayisi,
        "detay_bos": detay_bos_sayisi,
        "detay_hata": detay_hata_sayisi,
        "subeler": sonuc_subeler,
    }


@router.get("/sube-grup-detay")
def evo_sube_grup_detay(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
):
    """Şube × grup × nakit/kart × personel matrisi.
    Veri kaynağı: hs_rapor.ashx sube=N parametresi (her şubeye paralel çağrı).
    Akıllı Denetim ve EvoSatis sayfasının ana veri kaynağı."""
    try:
        bs = date.fromisoformat(bastar)
        bt = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD")

    return hs_rapor_sube_bazli_cached(bs, bt)


@router.post("/personel-sync")
def evo_personel_sync(gunler: int = Query(default=7, ge=1, le=30)):
    """
    Son N günün Evo verisini tarayarak personel ID → isim cache'ini günceller.
    Her /sube-grup-detay çağrısı zaten otomatik günceller; bu endpoint
    ilk kurulumda veya cache boşken geçmişe yönelik manuel tetiklemek içindir.
    """
    bugun = bugun_tr()
    bastar = bugun - timedelta(days=gunler - 1)
    _personel_cache_yukle()
    # hs_rapor_sube_bazli içinde otomatik cache yazma tetiklenir
    try:
        hs_rapor_sube_bazli(bastar, bugun)
    except Exception as exc:
        raise HTTPException(500, f"Evo veri çekme hatası: {exc}")
    with _per_ad_lock:
        cache_boyutu = len(_per_ad_cache)
    return {
        "durum": "ok",
        "taranan_gun": gunler,
        "tarih_bas": str(bastar),
        "tarih_bit": str(bugun),
        "cache_boyutu": cache_boyutu,
    }


@router.get("/personel-cache")
def evo_personel_cache_listesi():
    """Bellekteki personel ID → ad eşleşmelerini döndürür (debug/kontrol için)."""
    _personel_cache_yukle()
    with _per_ad_lock:
        kayitlar = [{"personel_id": k, "ad": v} for k, v in sorted(_per_ad_cache.items())]
    return {"toplam": len(kayitlar), "kayitlar": kayitlar}


class PersonelIsimBody(BaseModel):
    personel_id: str
    ad: str


@router.post("/personel-isim-gir")
def personel_isim_gir(body: PersonelIsimBody):
    """
    Elle personel ismi kaydet.
    Evo'da ortak kasa hesabı kullanan personelin ismi SATIS_PER'de gelmez;
    bu endpoint ile CFO sayısal ID → isim eşleşmesini manuel girebilir.
    """
    pid = body.personel_id.strip()
    ad  = body.ad.strip()
    if not pid or not ad:
        raise HTTPException(400, "personel_id ve ad boş olamaz")
    _per_ad_guncelle({pid: ad})
    return {"durum": "ok", "personel_id": pid, "ad": ad}


@router.get("/personel-evo-listesi")
def personel_evo_listesi():
    """
    Evo REST API personel modülünden tüm personel listesini çeker ve cache'e yazar.
    Başarılı olursa personel sayısını döner; başarısız olursa boş liste döner.
    """
    _personel_cache_yukle()
    try:
        data = _evo_post("personel", {"cmd": "jq_list", "ara": "", "sayfa": "0"})
    except Exception as exc:
        log.warning("Evo personel listesi çekilemedi: %s", exc)
        return {"durum": "hata", "mesaj": str(exc), "kayitlar": []}

    veri = data.get("veri") or {}
    ana: list = []
    if isinstance(veri, dict):
        ana = veri.get("Ana") or []
    elif isinstance(veri, list):
        ana = veri

    if not ana:
        return {"durum": "bos", "mesaj": "Evo personel listesi boş döndü", "kayitlar": []}

    # Evo'nun personel modülündeki olası alan adları — birini deneriz
    yeni: Dict[str, str] = {}
    for p in ana:
        pid = str(p.get("id") or p.get("a_id") or p.get("personel_id") or "").strip()
        ad  = (str(p.get("a_adi") or p.get("ad") or p.get("a_ad") or
                   p.get("personel_adi") or p.get("SATIS_PER") or "")).strip()
        if pid and pid != "0" and ad:
            yeni[pid] = ad

    if yeni:
        _per_ad_guncelle(yeni)

    with _per_ad_lock:
        kayitlar = [{"personel_id": k, "ad": v} for k, v in sorted(_per_ad_cache.items())]

    return {
        "durum": "ok",
        "evo_satir_sayisi": len(ana),
        "yeni_eslestirilen": len(yeni),
        "cache_toplam": len(kayitlar),
        "kayitlar": kayitlar,
        "ornek_ham": ana[:2],   # hangi alanlar geldiğini görmek için
    }


@router.get("/grup-pasta-ham")
def evo_grup_pasta_ham(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
    sube: str = Query("0", description="Evo şube ID (0=tüm)"),
):
    """KEŞİF — hs_rapor.ashx'in tüm cevap yapısını debug için döner.
    Şube parametresi ile çağrılırsa Grup_Pasta şubeye filtrelenip filtrelenmediği görülür."""
    try:
        bs = date.fromisoformat(bastar)
        bt = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD")
    d = _hs_rapor_ham_veri(bs, bt, sube_id=sube)
    return {
        "anahtarlar": list(d.keys()),
        "Grup_Pasta_tum": d.get("Grup_Pasta", []),
        "Grup_Pasta_ilk_alanlar": (
            list(d.get("Grup_Pasta", [{}])[0].keys()) if d.get("Grup_Pasta") else []
        ),
        "S_ilk_3": (d.get("S") or [])[:3],
        "S_ilk_alanlar": (
            list((d.get("S") or [{}])[0].keys()) if d.get("S") else []
        ),
        "S_toplam": len(d.get("S") or []),
        "Cok_Satilan_ilk_5": (d.get("Cok_Satilan") or [])[:5],
        "Cok_Satilan_ilk_alanlar": (
            list((d.get("Cok_Satilan") or [{}])[0].keys()) if d.get("Cok_Satilan") else []
        ),
        "kasa_toplam_satir": len(d.get("kasa") or []),
        "banka_toplam_satir": len(d.get("banka") or []),
        "kasa_ornek": (d.get("kasa") or [])[:3],
        "banka_ornek": (d.get("banka") or [])[:3],
    }


@router.get("/sube-tam-detay")
def evo_sube_tam_detay(
    bastar: str = Query(..., description="YYYY-MM-DD"),
    bittar: str = Query(..., description="YYYY-MM-DD"),
    sube_adi: Optional[str] = Query(None, description="Tek şube; boş = tüm şubeler"),
    max_fatura: int = Query(200, ge=1, le=1000, description="Maksimum fatura"),
):
    """
    KEŞİF amaçlı: tüm satır kalemlerini şube + ürün matrisi olarak döner.
    Bardak/su/soda/ICE/OZ pattern'lerini ayrı kategoride gösterir.

    Çıktı:
      {
        sube_adi: {
          "toplam_fis": N, "toplam_satir": M,
          "urunler": [{ad, adet, satis_tutar, iskonto_tutar, birim_fiyat_ort,
                       ikram_mi, kategori}],
          "bardak_satirlari": [filtre uygulanmış bardak/su/soda],
          "kategoriler": {bardak_oz: adet, bardak_ice: adet, su: adet, soda: adet,
                          redbull: adet, pasta: adet, kahve: adet, diger: adet}
        }
      }
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        bs = date.fromisoformat(bastar)
        bt = date.fromisoformat(bittar)
    except ValueError:
        raise HTTPException(400, "Tarih formatı YYYY-MM-DD")

    faturalar = faturajq_listesi(bs, bt, tur=34)
    log.info("sube-tam-detay: %d fatura cekildi", len(faturalar))

    # Şube filtresi (opsiyonel)
    if sube_adi:
        sad = sube_adi.strip().lower()
        faturalar = [f for f in faturalar
                     if sad in str(f.get("a_sube_adi") or "").strip().lower()]

    if not faturalar:
        return {"uyari": "Eşleşen fatura yok", "subeler": {}}

    # İlk N fatura ile sınırla
    faturalar = faturalar[:max_fatura]

    # Kategori pattern eşleştirme
    def _kategorize(ad: str) -> str:
        a = ad.lower()
        if any(k in a for k in ("ice", "iced", "14 oz", "14oz", "8 oz", "8oz", "16 oz", "16oz", "20 oz", "20oz")):
            return "bardak_oz_ice"
        if "bardak" in a or "kup" in a or "kutu" in a:
            return "bardak_diger"
        if "su" in a and ("şişe" in a or "sise" in a or "500" in a or "su -" in a or a.strip() == "su"):
            return "su"
        if "soda" in a:
            return "soda"
        if "redbull" in a or "red bull" in a or "energy" in a:
            return "redbull"
        if "pasta" in a or "kek" in a or "tatlı" in a or "tatli" in a:
            return "pasta"
        if any(k in a for k in ("kahve", "latte", "americano", "espresso", "mocha", "cappuccino", "filtre")):
            return "kahve"
        if "çay" in a or "cay" in a or "tea" in a:
            return "cay"
        return "diger"

    def _ikram_mi(s: Dict[str, Any]) -> bool:
        try:
            br_fiyat = float(s.get("a_brm_fiyat") or s.get("birim_fiyat") or s.get("a_fiyat") or 0)
        except (TypeError, ValueError):
            br_fiyat = 0.0
        if br_fiyat < 1.0:
            try:
                tutar = float(s.get("a_tutar") or 0)
            except (TypeError, ValueError):
                tutar = 0.0
            if tutar < 1.0:
                return True
        try:
            brut = float(s.get("a_brut") or 0)
            iskonto = float(s.get("a_isk_tut") or 0)
        except (TypeError, ValueError):
            brut, iskonto = 0.0, 0.0
        if brut > 0 and iskonto > 0 and (iskonto / brut) >= 0.99:
            return True
        ack = str(s.get("a_ack") or "").lower()
        return any(k in ack for k in ("ikram", "hediye", "promosyon", "promo", "tadim"))

    # Fatura → şube haritası
    fid_sube = {}
    for f in faturalar:
        fid = str(f.get("a_id") or f.get("G.a_id") or "").strip()
        sub = str(f.get("a_sube_adi") or "?").strip()
        if fid:
            fid_sube[fid] = sub

    # Şube başına aggregat
    sube_data: Dict[str, Dict[str, Any]] = {}
    for sub in set(fid_sube.values()):
        sube_data[sub] = {
            "toplam_fis": 0, "toplam_satir": 0,
            "urunler_map": {},   # ad → {adet, satis_tutar, iskonto, kategori, ikram_adet}
            "kategoriler": {},
        }

    # Paralel detay çek
    def _cek(fid: str):
        sub = fid_sube[fid]
        sonuc = []
        try:
            detay = evo_fatura_detay(fid)
            for s in _satirlari_coz(detay):
                ad = str(s.get("a_stok_adi") or s.get("stok_adi") or s.get("a_adi") or s.get("urun_adi") or "").strip()
                if not ad:
                    continue
                try:
                    mik = float(s.get("a_miktar") or s.get("miktar") or 0)
                    tut = float(s.get("a_tutar") or 0)
                    isk = float(s.get("a_isk_tut") or 0)
                    brm = float(s.get("a_brm_fiyat") or s.get("birim_fiyat") or 0)
                except (TypeError, ValueError):
                    mik, tut, isk, brm = 0.0, 0.0, 0.0, 0.0
                if mik <= 0:
                    continue
                ikram = _ikram_mi(s)
                sonuc.append((sub, ad, mik, tut, isk, brm, ikram))
        except Exception:
            pass
        return sonuc

    with ThreadPoolExecutor(max_workers=8) as exe:
        futures = [exe.submit(_cek, fid) for fid in fid_sube.keys()]
        for fut in as_completed(futures):
            for sub, ad, mik, tut, isk, brm, ikram in fut.result():
                if sub not in sube_data:
                    continue
                u_map = sube_data[sub]["urunler_map"]
                kat = _kategorize(ad)
                rec = u_map.setdefault(ad, {
                    "adet": 0.0, "satis_tutar": 0.0, "iskonto": 0.0,
                    "ikram_adet": 0.0, "kategori": kat, "birim_fiyat_son": 0.0,
                })
                rec["adet"] += mik
                rec["satis_tutar"] += tut
                rec["iskonto"] += isk
                if ikram:
                    rec["ikram_adet"] += mik
                if brm > 0:
                    rec["birim_fiyat_son"] = brm
                sube_data[sub]["toplam_satir"] += 1
                sube_data[sub]["kategoriler"][kat] = sube_data[sub]["kategoriler"].get(kat, 0.0) + mik

    # Fiş sayısı
    for sub in sube_data:
        sube_data[sub]["toplam_fis"] = sum(1 for v in fid_sube.values() if v == sub)

    # Map'leri liste yap, kategori bazlı sırala
    sonuc_subeler = {}
    for sub, d in sube_data.items():
        urunler = []
        for ad, r in d["urunler_map"].items():
            urunler.append({
                "ad": ad,
                "kategori": r["kategori"],
                "adet": round(r["adet"], 2),
                "satis_tutar": round(r["satis_tutar"], 2),
                "iskonto": round(r["iskonto"], 2),
                "ikram_adet": round(r["ikram_adet"], 2),
                "birim_fiyat_son": round(r["birim_fiyat_son"], 2),
            })
        urunler.sort(key=lambda x: -x["adet"])
        bardak_satirlari = [u for u in urunler if u["kategori"] in (
            "bardak_oz_ice", "bardak_diger", "su", "soda", "redbull"
        )]
        sonuc_subeler[sub] = {
            "toplam_fis": d["toplam_fis"],
            "toplam_satir": d["toplam_satir"],
            "urunler": urunler[:200],   # ilk 200 ürün (görsel sınır)
            "bardak_su_soda_satirlari": bardak_satirlari,
            "kategoriler": {k: round(v, 2) for k, v in d["kategoriler"].items()},
        }

    return {
        "bastar": str(bs), "bittar": str(bt),
        "fatura_islendi": len(fid_sube),
        "fatura_toplam": len(faturalar),
        "sube_sayisi": len(sonuc_subeler),
        "subeler": sonuc_subeler,
    }
