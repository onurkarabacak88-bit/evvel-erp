"""
🔐 ADMIN OTURUM — jeton üretimi/doğrulaması TEK MERKEZ.

NEDEN AYRI DOSYA (2026-09-02):
  Jeton mantığı `main.py` içindeydi. Bir router'a kapı koymak isteyen modül
  (`is_basvuru_api` gibi) `main`i import edemez — `main` zaten o router'ı
  import ediyor, döngü olur. İki seçenek vardı: mantığı KOPYALAMAK ya da
  ortak bir yere almak. Kopya, gün gelir ayrışır ve o gün kapı sessizce
  açılır ("aynı metrik iki yerde ayrı hesaplanmaz" kuralının güvenlik hâli).

ŞEMA:
    jeton = "<bitiş_zamanı>.<HMAC(ADMIN_SIFRE, bitiş_zamanı)>"
  Gizli anahtar ADMIN_SIFRE'nin kendisi olduğu için ŞİFRE DEĞİŞİNCE tüm eski
  oturumlar kendiliğinden geçersizleşir — ayrı bir iptal listesi gerekmez.

⚠️ DÜRÜST SINIR: bu kapı, halka açık YÜZEYDEKİ yönetim uçlarını kapatır.
   Sistemin geri kalanındaki API'ler hâlâ açıktır (bkz. güvenlik backlog'u,
   sahip kararı: proje bitiminde). Burada kapatılan şey dar ve nettir:
   iş başvurusu FORMU herkese açık kalmalı, ama başvuruları OKUMA/İŞE ALMA/
   SİLME uçları herkese açık kalmamalı.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Optional, Tuple

from fastapi import Header, HTTPException

ADMIN_SIFRE = os.environ.get("ADMIN_SIFRE", "evvel2026")
ADMIN_OTURUM_GUN = 30
# Tarayıcı bu başlıkla taşır (src/utils/api.js her isteğe ekler).
OTURUM_BASLIK = "X-Evvel-Oturum"


def jeton_uret(gun: int = ADMIN_OTURUM_GUN) -> str:
    bitis = int(time.time()) + gun * 86400
    imza = hmac.new(ADMIN_SIFRE.encode("utf-8"), str(bitis).encode("ascii"),
                    hashlib.sha256).hexdigest()[:32]
    return f"{bitis}.{imza}"


def jeton_gecerli(jeton: str) -> Tuple[bool, int]:
    """(gecerli_mi, kalan_saniye) — biçim/imza/süre üçünü de doğrular."""
    try:
        bitis_s, imza = (jeton or "").split(".", 1)
        bitis = int(bitis_s)
    except Exception:
        return False, 0
    beklenen = hmac.new(ADMIN_SIFRE.encode("utf-8"), str(bitis).encode("ascii"),
                        hashlib.sha256).hexdigest()[:32]
    # compare_digest: imza karşılaştırması zamanlama sızdırmasın.
    if not hmac.compare_digest(imza, beklenen):
        return False, 0
    kalan = bitis - int(time.time())
    return (kalan > 0), max(0, kalan)


def admin_kapisi(x_evvel_oturum: Optional[str] = Header(default=None)) -> bool:
    """FastAPI bağımlılığı — geçersiz/eksik jetonda 401.

    Kullanım:
        @router.get("", dependencies=[Depends(admin_kapisi)])

    ⚠️ Hata mesajı NE OLDUĞUNU söyler ama NEDEN olduğunu söylemez
    (jeton yok mu, süresi mi doldu, imza mı tutmadı) — ayrıntı saldırgana
    bilgi verir; kullanıcı için tek eylem aynıdır: yeniden giriş.
    """
    gecerli, _ = jeton_gecerli(x_evvel_oturum or "")
    if not gecerli:
        raise HTTPException(401, "Oturum gerekli — yönetim paneline giriş yapın.")
    return True


def aktor_bilgisi(jeton: Optional[str]) -> Tuple[Optional[str], str]:
    """(aktor_adi, kaynak) — KAPI DEĞİL, yalnız KİMLİK OKUYUCU.

    Denetim defterine "kim yaptı" yazabilmek için kullanılır (SYS-AUDIT).
    Geçersiz/eksik jetonda 401 ATMAZ: bu fonksiyonun işi erişimi kesmek değil,
    aktörün BİLİNİP BİLİNMEDİĞİNİ dürüstçe işaretlemektir.

    Dönen kaynak:
      'oturum' → geçerli yönetim jetonu vardı, kayıt bir oturuma bağlanabilir
      'anonim' → jeton yok/geçersiz; defterde "kim" sorusu CEVAPSIZ kalır
    ⚠️ 'anonim' bir hata değil, bir GERÇEKTİR — ve defterde öyle görünmelidir.
    Boş bırakıp "bilinmiyor"u gizlemek, yanlış isim yazmakla aynı kapıya çıkar.
    """
    gecerli, _ = jeton_gecerli(jeton or "")
    return ("yönetim (oturum)", "oturum") if gecerli else (None, "anonim")
