"""
🪪 PERSONEL KİMLİK — "bu işi kim yaptı" sorusunun TEK cevap yeri.

NEDEN VAR (FAZ 4, 2026-09-02):
  Denetimde 17 ayrı bulgunun kökü aynı çıktı: **aktör istemci beyanı.**
  Uçlar `personel_id`'yi gövdeden alıyor ve DOĞRULAMADAN deftere yazıyordu.
  Bazılarında `pin` alanı bile vardı ama yalnız BİÇİMİ kontrol ediliyordu
  ("4 hane mi") — kimseye karşı doğrulanmıyordu. Biçim kontrolü, kapı
  görüntüsü verip kapı işi görmez; en tehlikelisi budur, çünkü ekranda
  "PIN'li işlem" yazar.

BU MODÜLÜN İLKESİ — kimliği REDDETMEK değil, KANIT SEVİYESİNİ SÖYLEMEK:
  Sistem hâlâ demo/geçiş aşamasında ve bazı akışlar (QR yoklama ile sipariş,
  görev girişi) bilinçli olarak PIN'siz tasarlandı. Bu uçları topluca PIN'e
  bağlamak işi durdururdu. Bunun yerine her çağrı, kimliğin NEYE dayandığını
  öğrenir ve deftere o seviyeyi yazar:

      'pin'      → PIN doğrulandı. En güçlü kanıt.
      'yoklama'  → Kişi o gün o şubede QR ile giriş yapmış (sunucu kaydı).
      'beyan'    → Yalnız istemci söyledi. DOĞRULANMADI.
      'yok'      → Kimlik hiç verilmedi.

  ⚠️ 'beyan' bir hata değil, bir GERÇEKTİR — ve defterde öyle görünmelidir.
  Doğrulanmış kimlikle beyan edilen kimliğin aynı görünmesi, denetimi
  kendi kendini kandırır hâle getirir.

Bağlantılı: [[feedback_kanonik_kimlik_kaynakta]] · [[design_kapanis_sorumlusu_modeli]]
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException

log = logging.getLogger(__name__)

# Kanıt seviyeleri — güçlüden zayıfa. Sıra ANLAMLIDIR: bir uç "en az yoklama"
# isteyebilsin diye kıyaslanabilir tutuluyor.
KANIT_SIRASI = ("pin", "yoklama", "beyan", "yok")


def kanit_yeterli(kaynak: str, en_az: str) -> bool:
    """`kaynak` kanıtı, `en_az` seviyesini karşılıyor mu?"""
    try:
        return KANIT_SIRASI.index(kaynak) <= KANIT_SIRASI.index(en_az)
    except ValueError:
        return False


def personel_coz(
    cur: Any,
    personel_id: Optional[str],
    *,
    sube_id: Optional[str] = None,
    pin: Optional[str] = None,
    tarih: Optional[str] = None,
) -> Dict[str, Any]:
    """Kimliği çözer ve KANIT SEVİYESİNİ döner. Asla exception atmaz.

    Dönen sözlük:
      {"personel_id", "ad_soyad", "kaynak", "dogrulandi", "not"}

    ⚠️ Bu fonksiyon KAPI DEĞİLDİR — hiçbir isteği reddetmez. Kapı kurmak
    isteyen uç, `kimlik_kapisi()` kullanır ya da dönen `kaynak`a kendisi bakar.
    Ayrımın sebebi: kimlik ÖLÇMEK ile erişim KESMEK farklı işlerdir; ikisini
    birleştirmek, "kimliği ölçmek istiyorum ama isteği kesmek istemiyorum"
    durumunu imkânsız kılar (denetim uçlarının tam ihtiyacı budur).
    """
    pid = (str(personel_id or "")).strip()
    sonuc = {"personel_id": pid or None, "ad_soyad": None,
             "kaynak": "yok", "dogrulandi": False, "not": ""}
    if not pid:
        sonuc["not"] = "personel kimliği gönderilmedi"
        return sonuc

    # 1) PIN — en güçlü kanıt.
    _pin = (str(pin or "")).replace(" ", "")
    if _pin:
        try:
            from personel_panel_auth import dogrula_personel_panel_pin
            p = dogrula_personel_panel_pin(cur, pid, _pin)
            return {"personel_id": pid, "ad_soyad": (p or {}).get("ad_soyad"),
                    "kaynak": "pin", "dogrulandi": True, "not": ""}
        except HTTPException as e:
            # PIN GÖNDERİLDİ ama TUTMADI — bu beyandan da kötüdür, çünkü
            # doğrulama denendi ve BAŞARISIZ oldu. Sessizce beyana düşmek,
            # yanlış PIN'i "kimlik yok" ile aynı kefeye koyardı.
            sonuc["not"] = f"PIN doğrulanamadı: {getattr(e, 'detail', e)}"
            sonuc["pin_denendi_tutmadi"] = True
        except Exception as e:  # noqa: BLE001
            log.warning("personel_coz PIN doğrulama hatası (%s): %s", pid, e)
            sonuc["not"] = "PIN doğrulaması yapılamadı"

    # 2) Ad + aktiflik — kimliğin VAR olduğunu en azından bilelim.
    try:
        from database import savepoint
        with savepoint(cur, "sp_kimlik_ad"):
            cur.execute(
                "SELECT ad_soyad, COALESCE(aktif, FALSE) AS aktif, sube_id::text AS sube_id "
                "FROM personel WHERE id=%s", (pid,))
            r = cur.fetchone()
        if not r:
            sonuc["not"] = "personel kaydı bulunamadı"
            return sonuc
        r = dict(r)
        sonuc["ad_soyad"] = r.get("ad_soyad")
        if not r.get("aktif"):
            sonuc["not"] = "personel PASİF"
            return sonuc
    except Exception as e:  # noqa: BLE001
        log.warning("personel_coz ad okuma hatası (%s): %s", pid, e)

    # 3) Yoklama — o gün o şubede QR ile giriş yapmış mı? Sunucu kaydı olduğu
    #    için istemci beyanından güçlüdür: kişi fiziksel olarak oradaydı.
    if sube_id:
        try:
            from database import savepoint
            with savepoint(cur, "sp_kimlik_yoklama"):
                cur.execute(
                    """SELECT 1 FROM gorev_yoklama
                       WHERE sube_id=%s AND personel_id=%s
                         AND tarih = COALESCE(%s::date, CURRENT_DATE)
                       LIMIT 1""",
                    (sube_id, pid, tarih))
                var = cur.fetchone() is not None
            if var:
                sonuc.update({"kaynak": "yoklama", "dogrulandi": True,
                              "not": sonuc["not"] or "o gün o şubede QR girişi var"})
                return sonuc
        except Exception as e:  # noqa: BLE001
            log.warning("personel_coz yoklama kontrolü hatası (%s): %s", pid, e)

    sonuc["kaynak"] = "beyan"
    sonuc["dogrulandi"] = False
    if not sonuc["not"]:
        sonuc["not"] = "kimlik yalnız istemci beyanı — doğrulanmadı"
    return sonuc


def kimlik_kapisi(
    cur: Any,
    personel_id: Optional[str],
    *,
    sube_id: Optional[str] = None,
    pin: Optional[str] = None,
    en_az: str = "yoklama",
    islem: str = "bu işlem",
) -> Dict[str, Any]:
    """`personel_coz` + KAPI: kanıt yetmezse 403.

    Kullanım:
        kimlik = kimlik_kapisi(cur, body.personel_id, sube_id=sid,
                               pin=body.pin, en_az="pin", islem="açılış geri alma")
    """
    k = personel_coz(cur, personel_id, sube_id=sube_id, pin=pin)
    if not kanit_yeterli(k["kaynak"], en_az):
        _ne = {"pin": "PIN doğrulaması",
               "yoklama": "PIN ya da o güne ait QR yoklama kaydı"}.get(en_az, "kimlik kanıtı")
        raise HTTPException(403, f"{islem} için {_ne} gerekli. ({k.get('not') or 'kanıt yok'})")
    return k
