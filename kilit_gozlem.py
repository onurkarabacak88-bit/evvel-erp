# -*- coding: utf-8 -*-
"""🔒 KİLİT GÖZLEMİ — kilit takmadan ÖNCE kimin jetonsuz geldiğini SAY.

🔴 NEDEN (sahip 2026-09-08: "kilitleri tak"):
API uçlarının çoğu auth'suz. Kilidi doğrudan takmak CANLI DÜKKÂNLARI
DURDURABİLİR: `/sube-panel` ayrı bir HTML sayfası (`sube_panel.html`) ve
yönetim jetonunu HİÇ taşımaz — PIN'le çalışır. QR ekranları, iş başvurusu
formu, fire fotoğrafı da öyle. Hangi ucun jetonsuz çağrıldığını TAHMİN ETMEK
yerine ÖLÇMEK gerekir ([[feedback-kuru-calistirma-kapisi]] — para değiştiren
toplu işlem önce kuru çalışır; kilit de öyle).

Bu modül HİÇBİR ŞEYİ ENGELLEMEZ. Yalnız sayar:
    (yöntem, yol kalıbı) → jetonlu kaç, jetonsuz kaç, ilk/son ne zaman
Birkaç gün gerçek çalışmadan sonra `/api/kilit-gozlem` okunur ve izin listesi
TAHMİNLE değil KANITLA kurulur.

⚠️ BELLEKTE tutulur, veritabanına yazmaz: her istekte DB'ye yazmak sıcak
yoldaki gecikmeyi artırırdı. Sunucu yeniden başlarsa sayaç sıfırlanır — bu bir
kayıp değil, gözlem penceresi yeniden başlar.
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any, Dict, Tuple

_KILIT = threading.Lock()
_SAYAC: Dict[Tuple[str, str], Dict[str, Any]] = {}
_TAVAN = 4000          # farklı kalıp sayısı tavanı — bellek şişmesin

# Yol kalıbı: değişken parçalar sabitlenir ki "/api/personel/<uuid>" ile
# "/api/personel/<başka uuid>" AYNI satırda toplansın.
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                   r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_SAYI = re.compile(r"^\d+$")


def yol_kalibi(yol: str) -> str:
    parcalar = []
    for p in (yol or "").split("/"):
        if not p:
            parcalar.append(p)
        elif _UUID.match(p) or _SAYI.match(p) or len(p) > 30:
            parcalar.append("{id}")
        else:
            parcalar.append(p)
    return "/".join(parcalar)


def kaydet(yontem: str, yol: str, jetonlu: bool, kaynak: str = "") -> None:
    """Tek bir isteği say. ASLA HATA FIRLATMAZ — gözlem, isteği bozamaz."""
    try:
        anahtar = (yontem or "?", yol_kalibi(yol))
        simdi = int(time.time())
        with _KILIT:
            if anahtar not in _SAYAC and len(_SAYAC) >= _TAVAN:
                return
            d = _SAYAC.setdefault(anahtar, {
                "jetonlu": 0, "jetonsuz": 0, "ilk": simdi, "son": simdi,
                "ornek_kaynak": "",
            })
            d["jetonlu" if jetonlu else "jetonsuz"] += 1
            d["son"] = simdi
            if not jetonlu and kaynak and not d["ornek_kaynak"]:
                # Jetonsuz geleni KİM çağırdı — izin listesi bunun üzerine kurulur.
                d["ornek_kaynak"] = kaynak[:120]
    except Exception:  # noqa: BLE001 — gözlem hiçbir koşulda isteği bozmaz
        pass


def ozet() -> Dict[str, Any]:
    with _KILIT:
        satirlar = [
            {"yontem": y, "yol": p, **v} for (y, p), v in _SAYAC.items()
        ]
    satirlar.sort(key=lambda r: (-r["jetonsuz"], -r["jetonlu"]))
    jetonsuz_uc = [r for r in satirlar if r["jetonsuz"] > 0]
    return {
        "kalip": len(satirlar),
        "jetonsuz_uc": len(jetonsuz_uc),
        "toplam_jetonlu": sum(r["jetonlu"] for r in satirlar),
        "toplam_jetonsuz": sum(r["jetonsuz"] for r in satirlar),
        "not": ("GÖZLEM MODU — hiçbir istek engellenmedi. Jetonsuz gelen uçlar "
                "kilit takılınca KIRILACAK olanlardır; izin listesi buradan "
                "kurulur. Sunucu yeniden başlarsa sayaç sıfırlanır."),
        "satirlar": satirlar,
        "imzasiz_okuma": sorted(({"yol": y, "sube_id": s, **v} for (y, s), v in list(_IMZASIZ.items())), key=lambda r: -r["adet"]),
    }


# ── 🔒 EVVEL YENİ KAPISI (Faz 2 · 28 Eki · Fable L4b): /api/evvel-yeni/* merkez oturumu ister ──────────────────────────────────
# Kanıt: frontend taraması — şube paneli (cihaz imzalı) yalnız /panel/, personel telefonu (cihaz imzalı) yalnız /yoklama/ ve
# /toptanci/teslim/{id}/belge-telefon, eski sube_panel.html yalnız /moduller/gecis/{şube}; merkez React her istekte X-Evvel-Oturum.
# Sayaç bellekte (deploy'da sıfırlanır) olduğu için gözlem verisi beklenmedi. Geri dönüş: ortam değişkeni EY_KAPI=gozlem.
EY_ONEK = "/api/evvel-yeni/"
_EY_IZIN_ONEK = ("/api/evvel-yeni/panel/", "/api/evvel-yeni/yoklama/", "/api/evvel-yeni/moduller/gecis")
_EY_BELGE_TEL = re.compile(r"^/api/evvel-yeni/toptanci/teslim/[^/]+/belge-telefon/?$")


def ey_kapi_izinli(yontem: str, yol: str) -> bool:
    """Oturumsuz geçebilen Evvel Yeni yolu mu (kendi cihaz imzası / tek kullanımlık bilgisi olanlar + dağıtım doğrulama listesi)."""
    if yontem == "OPTIONS":   # CORS ön sorgusu (CORSMiddleware içeride) — yutulmaz
        return True
    if yol.startswith(_EY_IZIN_ONEK) or _EY_BELGE_TEL.match(yol):
        return True
    return yontem in ("GET", "HEAD") and yol.rstrip("/") == "/api/evvel-yeni/moduller"   # yalnız modül listesi (pilot / kesim değil)


def engellendi(yontem: str, yol: str) -> None:
    """Kapının geri çevirdiği isteği say (gözlem modunda da: 'geçerdi ama kapı kapalı olsa 401')."""
    kaydet(yontem, yol, False)   # Fable L6: kapı DIŞ katman — 401 alan istek gözlem sayacına hiç uğramıyordu; önce say
    try:
        with _KILIT:
            d = _SAYAC.get((yontem or "?", yol_kalibi(yol)))
            if d is not None:
                d["engellendi"] = d.get("engellendi", 0) + 1
    except Exception:  # noqa: BLE001
        pass


# ── 🔒 PANEL OKUMA İMZASI GÖZLEMİ (IS 5bc · Fable L4b B, 28 Eki): gerçek kayıttaki şubede imzasız gelen panel OKUMASI şube bazlı
# sayılır (aşama 1). Sayaç sıfır kalınca ya da 1 Kasım sabahı Railway EY_PANEL_OKUMA=zorla → aynı istek 403 (deploy'suz).
_IMZASIZ: Dict[Tuple[str, str], Dict[str, Any]] = {}


def imzasiz_okuma(yol: str, sube_id: str) -> None:
    """ASLA HATA FIRLATMAZ — gözlem isteği bozamaz."""
    try:
        anahtar = (yol_kalibi(yol), str(sube_id or ""))
        simdi = int(time.time())
        with _KILIT:
            if anahtar not in _IMZASIZ and len(_IMZASIZ) >= _TAVAN:
                return
            d = _IMZASIZ.setdefault(anahtar, {"adet": 0, "ilk": simdi, "son": simdi})
            d["adet"] += 1
            d["son"] = simdi
    except Exception:  # noqa: BLE001
        pass


# ── 🚫 ESKİ YAZIM KAPISI (25 Kas · sahip "ben eskinin bir tane tablosu vs kalmasın" · Codex L4b A) ──────────────
# Eski sistemin tabloları SİLİNMEDEN ÖNCE ona YAZAN her şey susmalı (Codex: "tablo gidince hata verip geçer" güvenli
# değil — işlem geri alınır, kuyruk yeniden dener, yutulan hata kayıp yaratır). Yüzey çok geniş (yalnız odeme_plani'na
# yazan 53 fonksiyon) ve gece zincirinde KAPISIZ koşanlar var (fatura_api.gece_ap_selfheal / gece_ap_mutabakat …).
# Tek tek tahmin etmek yerine ÖLÇÜYORUZ — projenin iki kez işe yaramış örüntüsü (EY_KAPI, EY_PANEL_OKUMA):
#   gözlem (öntanımlı) → kim yazıyor SAYILIR, engel YOK   ·   Railway ESKI_YAZIM=zorla → yazma HATA verir.
# Sayaç YAZMA GİRİŞİMİNİ gösterir, commit edilen satırı değil (Codex).
_ESKI_TABLOLAR = frozenset("""
odeme_plani kart_ekstre_donem kart_hareketleri kartlar borc_envanteri sabit_giderler vadeli_alimlar
tedarikci_fatura tedarikci_fatura_kalem tedarikciler cari_odeme kasa_hareketleri kasa_teslim ciro ciro_taslak
anlik_giderler personel_avans personel_aylik personel vardiya_atama vardiya_slot gorev_yoklama
sube_operasyon_event sube_operasyon_uyari operasyon_defter sube_fire_bildirim sube_acilis kapanis_kayit
siparis_talep siparis_urun siparis_kategori stok_yolda sube_depo_stok sube_depo_stok_hareket merkez_stok_kart
merkez_stok_sevk urun_alis_fiyat subeler onay_kuyrugu stok_sayim_gorev toptanci_siparis belge_talep
truth_motor_kararlar duyu_olay para_izi_cep_eski sube_ici_borc
""".split())   # ⚠ ey_* ve Evvel Yeni'nin kendi tabloları (para_izi_hareket, is_basvuru) LİSTEDE YOK

# Mod AÇILIŞTA bir kez okunur (Codex: her sorguda ortam değişkeni okuma). Railway'de değiştirmek zaten yeniden başlatır.
ZORLA = (__import__("os").environ.get("ESKI_YAZIM") or "").strip().lower() == "zorla"

_YAZ_ON = re.compile(r"\b(insert|update|delete|truncate|merge)\b", re.I)   # ucuz ön filtre
# Codex L6: yorum ve METİN SABİTİ önce temizlenir — 'SELECT ...UPDATE odeme_plani...' bir YAZMA DEĞİLDİR (yanlış engel),
# '/*yorum*/ UPDATE x' ise yazmadır (kaçmamalı). Şema öneki (public. / "public"."x") ad sayılmaz.
_YORUM = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_METIN = re.compile(r"'(?:''|[^'])*'")
_HEDEF = re.compile(r"\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(?:only\s+)?((?:\w|\"|\.)+)", re.I)
_TRUNC = re.compile(r"\btruncate\s+(?:table\s+)?((?:(?:only\s+)?(?:\w|\"|\.)+\s*,?\s*)+)", re.I)
_SQL_BELLEK: Dict[str, frozenset] = {}
_SQL_TAVAN = 2000
_ESKI_YAZIM: Dict[Tuple[str, str], Dict[str, Any]] = {}


class EskiYazimEngellendi(Exception):
    """ESKI_YAZIM=zorla iken eski tabloya yazma denendi — YUTULMAZ (Codex: db() rollback'i çalışsın)."""


def _sade_ad(ham: str) -> str:
    """'"public"."odeme_plani"' -> 'odeme_plani' (şema öneki atılır, tırnak silinir)."""
    son = ham.replace('"', "").replace("'", "").strip().rstrip(";").split(".")[-1]
    return son.lower()


def hedef_tablolar(sql: str) -> frozenset:
    """SQL'in YAZDIĞI tabloların adı. 'WITH … UPDATE' gibi yazmaları da yakalar (ilk sözcüğe bakılmaz).
    Yorumlar ve metin sabitleri önce temizlenir: metnin içinde geçen 'UPDATE …' yazma SAYILMAZ (Codex L6).
    Çok tablolu TRUNCATE'in HEPSİ sayılır. Şema öneki ayıklanır."""
    if not sql:
        return frozenset()
    d = _SQL_BELLEK.get(sql)
    if d is not None:
        return d
    sade = _METIN.sub("''", _YORUM.sub(" ", sql))
    adlar = {_sade_ad(m.group(1)) for m in _HEDEF.finditer(sade)}
    for m in _TRUNC.finditer(sade):
        for parca in m.group(1).split(","):
            parca = re.sub(r"(?i)^\s*only\s+", "", parca).strip()
            if parca:
                adlar.add(_sade_ad(parca))
    d = frozenset(a for a in adlar if a and not a.isdigit())
    if len(_SQL_BELLEK) < _SQL_TAVAN:   # şablon sayısı sınırlı — bellek şişmesin
        _SQL_BELLEK[sql] = d
    return d


def _cagiran() -> str:
    """Eşleşme ANINDA (sıcak yolda değil) yığından ilk uygulama çağıranı: dosya:satır fonksiyon."""
    try:
        import sys as _sys
        f = _sys._getframe(2)
        atla = ("database.py", "kilit_gozlem.py")
        for _ in range(14):
            if f is None:
                break
            ad = (f.f_code.co_filename or "").replace("\\", "/").rsplit("/", 1)[-1]
            if ad not in atla and not ad.startswith("<"):
                return f"{ad}:{f.f_lineno} {f.f_code.co_name}"
            f = f.f_back
    except Exception:  # noqa: BLE001
        pass
    return "?"


def eski_yazim_dene(sql: str) -> None:
    """db() imleci her yazmadan ÖNCE çağırır. Gözlemde SAYAR, zorlada EskiYazimEngellendi fırlatır."""
    try:
        if not sql or not _YAZ_ON.search(sql):
            return
        vurgun = _ESKI_TABLOLAR & hedef_tablolar(sql)
        if not vurgun:
            return
        nereden = _cagiran()
        simdi = int(time.time())
        for t in sorted(vurgun):
            with _KILIT:
                anahtar = (t, nereden)
                if anahtar not in _ESKI_YAZIM and len(_ESKI_YAZIM) >= _TAVAN:
                    continue
                d = _ESKI_YAZIM.setdefault(anahtar, {"deneme": 0, "ilk": simdi, "son": simdi, "engellendi": 0})
                d["deneme"] += 1
                d["son"] = simdi
                if ZORLA:
                    d["engellendi"] += 1
    except EskiYazimEngellendi:
        raise
    except Exception as e:  # noqa: BLE001
        if ZORLA:   # Codex L6: zorlada denetim YAPILAMIYORSA sorgu GEÇMEZ (kapı açılmaz)
            raise EskiYazimEngellendi('Eski yazım denetimi çalışmadı — zorla modunda sorgu durduruldu: ' + str(e)[:120])
        return   # gözlemde gözlem işi bozamaz
    if ZORLA:
        raise EskiYazimEngellendi("Eski sistem tablosuna yazma kapalı (" + ", ".join(sorted(vurgun)) + ") — " + nereden)


def eski_yazim_ozet() -> dict:
    with _KILIT:
        satir = [{"tablo": t, "nereden": n, **v} for (t, n), v in _ESKI_YAZIM.items()]
    satir.sort(key=lambda x: -x["deneme"])
    return {"mod": "zorla" if ZORLA else "gozlem", "tablo_sayisi": len({x["tablo"] for x in satir}),
            "toplam_deneme": sum(x["deneme"] for x in satir), "satirlar": satir[:200]}


def sifirla() -> int:
    with _KILIT:
        n = len(_SAYAC)
        _SAYAC.clear()
        _IMZASIZ.clear()
        _ESKI_YAZIM.clear()
    return n
