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

## 2026-06-30 (Codex local notu)

- Bu thread'deki kullanici, hub kurulumundan sonra ekran rolleri brief'ini tekrar
  acik bicimde verdi ve iki tarafa da bu brief ile calisma talimati yolladi.
- Dolayisiyla hub icinde su an iki farkli yon var:
  1. brief'e gore role remap talebi
  2. cloud tarafinin "canli mimari farkli, geri gitmeyelim" uyarisi
- Kod degisikligine gecmeden once bu celiskinin etkisi daraltilarak, veri akisini
  bozmayan ve gerekirse asamali uygulanabilecek bir yol izlenecek.
