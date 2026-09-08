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


# 🆔 JETON ARTIK KİMLİK TAŞIYABİLİR (2026-09-08, sahip: kişiye şifre)
#   eski biçim: "<bitis>.<imza>"              → kim olduğu BİLİNMEZ
#   yeni biçim: "<bitis>.<kullanici_id>.<imza>"
# İmza her iki biçimde de GÖVDENİN TAMAMINI kapsar, yani kimlik kısmı
# kurcalanamaz. Eski biçim ÇALIŞMAYA DEVAM EDER: tek ADMIN_SIFRE ile girenler
# kapıda kalmasın diye (geçiş güvenliği). Kimliksiz jeton "sahip (ortak şifre)"
# sayılır ve denetim defterinde ÖYLE görünür — uydurma isim yazılmaz.
def _imzala(govde: str) -> str:
    return hmac.new(ADMIN_SIFRE.encode("utf-8"), govde.encode("utf-8"),
                    hashlib.sha256).hexdigest()[:32]


def jeton_uret(gun: int = ADMIN_OTURUM_GUN, kullanici_id: Optional[str] = None) -> str:
    bitis = int(time.time()) + gun * 86400
    if kullanici_id:
        govde = f"{bitis}.{kullanici_id}"
        return f"{govde}.{_imzala(govde)}"
    # ⚠️ Kimliksiz jetonun imzası ESKİSİYLE BİREBİR aynı hesaplanır — bugün
    # tarayıcılarda duran jetonlar geçersizleşmesin.
    return f"{bitis}.{_imzala(str(bitis))}"


def jeton_coz(jeton: str) -> Tuple[bool, int, Optional[str]]:
    """(gecerli_mi, kalan_saniye, kullanici_id) — biçim/imza/süre üçünü doğrular.

    Kimliksiz eski jetonda `kullanici_id` None döner; bu bir HATA DEĞİL,
    "ortak şifreyle girilmiş" gerçeğidir.
    """
    parcalar = (jeton or "").split(".")
    if len(parcalar) == 2:
        bitis_s, imza = parcalar
        kid = None
        govde = bitis_s
    elif len(parcalar) == 3:
        bitis_s, kid, imza = parcalar
        govde = f"{bitis_s}.{kid}"
    else:
        return False, 0, None
    try:
        bitis = int(bitis_s)
    except ValueError:
        return False, 0, None
    # compare_digest: imza karşılaştırması zamanlama sızdırmasın.
    if not hmac.compare_digest(imza, _imzala(govde)):
        return False, 0, None
    kalan = bitis - int(time.time())
    return (kalan > 0), max(0, kalan), (kid or None)


def jeton_gecerli(jeton: str) -> Tuple[bool, int]:
    """(gecerli_mi, kalan_saniye). Geriye uyum — kimliği umursamayan çağıranlar."""
    g, k, _ = jeton_coz(jeton)
    return g, k


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
