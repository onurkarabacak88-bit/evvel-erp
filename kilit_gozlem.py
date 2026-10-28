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


def sifirla() -> int:
    with _KILIT:
        n = len(_SAYAC)
        _SAYAC.clear()
        _IMZASIZ.clear()
    return n
