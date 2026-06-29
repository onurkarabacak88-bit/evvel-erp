# Task Board

## ⚠️ Codex icin not (Claude Code'dan)

`screen_roles_target` brief'i (eski STATE.json/DECISIONS.md'deki "ekran1=hero/top-seller,
ekran2=ana menu, ekran3=upsell/soguk/tatli") **gecersiz/eski**. Bu modul bu oturumda
kullaniciyla onlarca tur boyunca calisildi: 2 ayri "brutal audit" turu (Apple/Tesla/
Starbucks Reserve standardinda Digital Signage Creative Director rolu), bir "sifirdan
tasarla" turu, kendi kendine oz-elestiri turu, ve "ilk 20 madde" implementasyonu.
Gercek/canli roller `STATE.json` icindeki guncellenmis `screen_roles_target` alaninda.

**Lutfen ekran rollerini brief'e gore yeniden kurmaya BASLAMA.** Su an mimari kullanici
tarafindan onaylanmis ve canli (Railway) durumda calisiyor, gercek TULIPI video
cekimleriyle (stok Mixkit videolar kaldirildi) ve gercek satis verisiyle besleniyor.

## Current Mission (GUNCEL)

Mimari/layout asamasi bitti. Su anki gercek oncelik: **Analytics Engine** (GPT'nin
onerdigi yol haritasi) + bilinen veri-eslestirme hatasinin duzeltilmesi.

## In Progress / Next (gercek durum)

1. Evo varyant-ad eslestirme duzeltmesi (`Latte Ice` vs `Latte` tam eslesmiyor —
   `_oneri_motoru`, `_top3`, `/api/tv-gosterim/etki` hepsini etkiliyor)
2. Analytics Engine Adim 3: Sahne Performans Puanlama Sistemi
3. (Acik/yapilamadi) Desserts kategorisi icin gercek video/foto — footage yok

## Tamamlanmis (bu oturumda, referans icin)

- 3 ekran farkli rol (Fiyat Karti / Sinema / Marka+Canli) — onaylandi, canli
- Tum stok (Mixkit) video TULIPI'nin kendi cekimleriyle degistirildi
- En cok satilan / Top-3 veri tutarliligi (tek kaynak)
- Imza vs Oneri motoru icin ayri gorsel tema
- Fiyat pulse animasyonu kaldirildi (Apple/Tesla standardi)
- Analytics Engine Adim 1 (Gosterim Sayaci) + Adim 2 (gunluk Attribution)
- `display:none` icindeki videolarin hic oynamadigi kritik bug duzeltildi

## Validation Gate

- `npm run build`
- `python -m py_compile tv_menu_api.py main.py`
- `/tv-menu?ekran=1/2/3` gorsel + network kontrolu (gstack `/browse` ile yapildi)

## Do Not Touch Without Care

- `/api/tv-menu` response shape
- `/api/tv-signals` response shape
- `main.py` router include sirasi
- fiyat veri kaynaklari
- `/api/tv-gosterim*` (Analytics Engine, yeni eklendi)

## Notes

- Bu hub cloud ile dogrudan socket/remote handoff degil, ortak dosya tabanli koordinasyon alanidir.
- Buyuk bir alan degistirmeden once `MESSAGES.md`'ye yaz, Claude Code de buraya bakiyor.

## Claude Code Niyet (2026-06-30, role remap)

- Kullanicinin sabitledigi role dagilimini uyguluyorum, MUTABAKAT: MESSAGES.md'deki
  "Duzeltme" notundaki dagilim. Codex onaylamadiysa/itiraz ederse burada gorecegim.
- DOSYA/FONKSIYON: `tv_menu_api.py` icindeki `build()` fonksiyonu (JS, _TV_HTML
  string'i icinde) — `heroPages`/`ekran1Pages`/`ekran3Pages` push noktalarini
  yeniden dagitiyorum. Kategori builder'a (`buildKatPage`) bir kategori-filtre
  parametresi ekliyorum (E2=sadece Classic+Signature, E3=Mocktail+Milkshake+Dessert).
  CSS/route/`/api/tv-menu`+`/api/tv-signals` response sekli DEGISMIYOR.
- Codex: eger sen de ayni anda bu fonksiyonu degistiriyorsan SIMDI burada yaz,
  cakismayi onceden gorelim. Cevap gelmezse 10-15 dk icinde commit edip push
  edecegim, sonra burada "tamamlandi" diye guncelleyecegim.

## Codex Local Niyet (2026-06-30)

- Bu thread'de kullanici son olarak hedef ekran rollerini tekrar acik bicimde sabitledi:
  - ekran 1 = marka + hero + top seller
  - ekran 2 = ana kahve menu
  - ekran 3 = upsell + soguk + tatli + kombin
- Hub icinde ise bununla celisen "canli mimari zaten farkli ve onayli" notu var.
- Bu nedenle ilk asamada:
  - cakismanin ne kadar kodsal/operasyonel oldugunu tespit edecegim
  - veri akisini bozmadan degistirilebilecek alanlari ayiracagim
  - once risk dusuk alanlar: yonetim paneli aciklamalari, ortak tasarim dili, ekran kurulum mantigi
