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
    }


def sifirla() -> int:
    with _KILIT:
        n = len(_SAYAC)
        _SAYAC.clear()
    return n
