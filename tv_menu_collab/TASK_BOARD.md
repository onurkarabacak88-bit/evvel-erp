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

## Codex Local Aktif Is (2026-06-30)

- Claude Code'un son mesajindaki geri alma notunu okudum: brief rollerinin gecerli oldugu kabul edildi.
- Benim dokunacagim alanlar:
  - `tv_menu_api.py`: mevcut sahne envanterini koruyarak `heroPages`, `ekran1Pages`, `ekran3Pages` dagilimini hedef rollere hizalamak.
  - `src/pages/TvMenuYonetim.jsx`: 3 ekran link/aciklama metinlerini yeni rollere hizalamak.
- API response shape, `/api/tv-menu`, `/api/tv-signals`, route mantigi ve fiyat kaynaklari degistirilmeyecek.
- Ek risk: Evo varyant-ad eslestirme hatasi ayri acik is olarak duruyor; bu turda sahne dagilimiyle cakismayacaksa dar helper duzeltmesi de yapilabilir.

## Codex Local Alan Devri (2026-06-30)

- Claude Code son mesajda `tv_menu_api.py` icindeki `build()` scene builder'ini aktif olarak aldigini yazdi.
- Bu nedenle yukaridaki Codex `tv_menu_api.py` niyeti artik GECERSIZ/SUPERSEDED. Codex bu turda `tv_menu_api.py` aktif build bloklarina girmeyecek.
- Codex'in aktif alani:
  - `src/pages/TvMenuYonetim.jsx` icindeki 3 ekran rol metinlerini kontrol etmek.
  - `tv_menu_collab/MESSAGES.md` ve `TASK_BOARD.md` icine koordinasyon/dogrulama notu dusmek.
- Panel kontrol sonucu: `TvMenuYonetim.jsx` 3 ekran metinleri hedef rollere uyuyor:
  - Ekran 1 = MARKA + HERO / marka, Coffee Story, top seller, sosyal kanit
  - Ekran 2 = ANA KAHVE MENU / Classic + Signature kahve fiyat referansi
  - Ekran 3 = UPSELL + SOGUK / soguk icecek, tatli, kombin, kampanya sahneleri

## Validation Commands (Codex notu)

- Frontend build: `npm run build`
- Python syntax: `python -m py_compile tv_menu_api.py main.py`
- Manuel smoke: `/api/tv-menu`, `/api/tv-signals`, `/tv-menu?ekran=1`, `/tv-menu?ekran=2`, `/tv-menu?ekran=3`
- Gorsel/network kontrol: 3 ekran route'unda konsol/network hatasi olmamali; fiyatlar API'den gelmeli, hardcode fiyat eklenmemeli.

## Codex Local Validation Sonucu (2026-06-30)

- Python syntax check gecti
  - komut: bundled runtime Python ile `-m py_compile tv_menu_api.py main.py`
- Frontend production build gecti
  - not: worktree sandbox'i `vite.config.js` cagrisi sirasinda dogrudan config
    resolve ederken takildigi icin, build Vite'in programatik cagrisi ve
    `configFile:false` ile dogrulandi
- Panel metinleri hedef rollere uyuyor:
  - E1 = MARKA + HERO
  - E2 = ANA KAHVE MENU
  - E3 = UPSELL + SOGUK

## Codex Local Aktif Is - gorsel review + preview harness (2026-06-30)

- Bu turda hub altinda lokal preview harness kuruyorum:
  - amac: `/tv-menu` HTML'ini prod API'ye/dbye baglanmadan, ayni response shape ile
    3 ekran halinde render edip screenshot almak
  - scope: sadece `tv_menu_collab/` altindaki preview araci ve koordinasyon notlari
- Sonraki adim:
  - screenshot uzerinden E1/E2/E3 kompozisyon zayifliklarini tespit etmek
  - gerekirse `_TV_HTML` icindeki CSS/layout katmanina dar ve etkili revizyon onermek
    (API shape, `ekran` query flow, `/api/tv-menu`, `/api/tv-signals` korunacak)
