# TV Menu Collab Hub

Bu klasor, `/tv-menu` icin ortak calisma alani olarak tasarlandi.

Amac:
- local + cloud/paralel calisan ajanlarin ayni hedefe hizalanmasi
- veri akisini bozmadan tasarim ve layout kararlarini koordine etmek
- brief, karar, gorev ve dogrulama bilgisini tek yerde toplamak

## Bu hub neyi cozer

- "Kim neyi degistiriyor?" belirsizligini azaltir
- buyuk tasarim revizyonunu kontrolsuz refactor'a cevirmeden ilerletir
- ekran rolleri, veri sinirlari ve deploy risklerini herkes icin gorunur kilar

## Kaynak Gercekler

- Birincil route: `/tv-menu`
- Ekran parametresi: `?ekran=1`, `?ekran=2`, `?ekran=3`
- Ana veri uclari:
  - `/api/tv-menu`
  - `/api/tv-signals`
- Ana kod dosyasi:
  - `tv_menu_api.py`
- Yonetim paneli:
  - `src/pages/TvMenuYonetim.jsx`
- Router include:
  - `main.py`

## Hedef Ekran Rolleri

- `ekran=1`: marka + hero + top seller
- `ekran=2`: ana kahve menu omurgasi
- `ekran=3`: upsell + soguk icecek + tatli + kombin onerileri

## Non-Negotiables

- Fiyatlari hardcode etme
- Var olan route mantigini bozma
- `/api/tv-menu` ve `/api/tv-signals` veri akisini kirma
- Railway deploy uyumlulugunu bozma
- Gereksiz framework degisikligi yapma
- Buyuk mimari yikim yapma

## Calisma Protokolu

1. Buyuk bir alan degistirmeden once `TASK_BOARD.md` icinde niyet yaz.
2. Karar alindiginda `DECISIONS.md` icine isle.
3. Teknik durum degisince `STATE.json` guncelle.
4. Sorular veya el degisimleri icin `MESSAGES.md` kullan.
5. Dogrulama yapildiysa `TASK_BOARD.md` altindaki validation alanina ekle.

## Oncelikli Is

Mevcut ekran rolleri ile hedef brief birebir ortusmuyor. Ilk buyuk hedef, veri yapisini bozmadan ekran rollerini yeniden hizalamak ve premium digital signage kalitesinde layout kurmak.
