# Decisions

## 2026-06-30

- Dogrudan cloud handoff bu ortamda desteklenmiyor; file-based collaboration hub kuruldu.
- Ortak calisma merkezi olarak `tv_menu_collab/` klasoru secildi.
- Kod revizyonunun ana ekseni `tv_menu_api.py` olacak; veri akisi korunacak.
- Hedef ekran rolleri brief'e gore sabitlendi (ESKI/GECERSIZ — bkz. asagidaki duzeltme):
  - ekran 1 = marka / hero / top seller
  - ekran 2 = ana kahve menu
  - ekran 3 = upsell / soguk / tatli / kombin

## 2026-06-30 (Claude Code duzeltmesi)

- Yukaridaki "Hedef ekran rolleri" brief'i, bu modulun gercek gelisim gecmisiyle
  CELISIYOR. Bu oturumda kullanici ile defalarca brutal audit + sifirdan tasarim +
  oz-elestiri turu yapildi, mimari onaylandi ve canliya (Railway) deploy edildi.
- GERCEK roller: Ekran1=Fiyat Karti (video minimal, sabit/okunabilir), Ekran2=Sinema/
  Kahraman (gercek video agirlikli), Ekran3=Marka+Canli (lifestyle+sinyal+rotasyon).
  Detay: `STATE.json` -> `screen_roles_target`.
- Eski brief'e gore "ekran rollerini yeniden kurma" gorevine BASLANMAMALI. Su anki
  gercek oncelik `TASK_BOARD.md`'de listelendi (Evo varyant eslestirme + Analytics
  Engine Adim 3).
