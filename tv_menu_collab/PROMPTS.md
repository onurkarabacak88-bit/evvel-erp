# Shared Prompts

Bu dosya, local Codex + cloud/paralel ajan icin ortak prompt setidir.

## 1. Ortak Master Prompt

Bunu her iki tarafa da verebilirsin:

```text
TV menu modulu uzerinde paralel calisiyorsunuz. Tek hedef, veri yapisini bozmadan `/tv-menu` deneyimini premium 3 ekranli digital signage seviyesine cikarmak.

Ortak calisma merkezi:
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\README.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\STATE.json`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\TASK_BOARD.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\DECISIONS.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\MESSAGES.md`

Kurallar:
- Fiyatlari hardcode etmeyin
- `/api/tv-menu` ve `/api/tv-signals` veri yapisini bozmayin
- `ekran` query mantigini koruyun
- Railway deploy uyumunu bozmayin
- Gereksiz buyuk refactor yapmayin
- Buyuk degisiklikten once TASK_BOARD'a niyet yazin
- Karar alininca DECISIONS'a isleyin
- Teknik durum degisince STATE.json'i guncelleyin
- Kisa el degisimleri ve sorular icin MESSAGES.md kullanin

Hedef ekran rolleri:
- ekran=1: marka + hero + top seller
- ekran=2: ana kahve menu omurgasi
- ekran=3: upsell + soguk icecek + tatli + kombin onerileri

Ana dosyalar:
- `tv_menu_api.py`
- `src/pages/TvMenuYonetim.jsx`
- `main.py`

Mevcut tasarim zayifsa kucuk polish yapmayin; veri yapisini bozmadan layout, hiyerarsi, spacing, tipografi ve ekran kompozisyonunu ciddi bicimde yeniden kurun.
```

## 2. Cloud Tarafina Ozel Prompt

```text
Bu alanin paralel calisan cloud ajani sensin. Local Codex ile ayni hedefe calisiyorsun. Once su hub dosyalarini oku:

- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\README.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\STATE.json`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\TASK_BOARD.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\DECISIONS.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\MESSAGES.md`

Ardindan:
1. TASK_BOARD.md icine hangi dosyaya girecegini ve neyi degistirecegini kisa yaz.
2. Local Codex ile cakismamak icin dokunacagin alani netlestir.
3. Degisiklikleri veri akisini bozmadan yap.
4. Bittiginde DECISIONS.md ve MESSAGES.md icine ne yaptigini yaz.

Oncelik:
- TV menu ekran rollerini hedef brief ile hizalamak
- premium signage kalitesinde layout kurmak
- gereksiz mimari yikimdan kacmak
```

## 3. Local Codex Icin Prompt

```text
Sen local Codex'sin. Cloud ajan ile ayni hub uzerinden koordineli calis. Once su dosyalari oku:

- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\README.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\STATE.json`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\TASK_BOARD.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\DECISIONS.md`
- `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\MESSAGES.md`

Kurallar:
- Cloud ajanla ayni dosya bolumunde gereksiz cakisma yaratma
- Buyuk tasarim kararlari alirken DECISIONS.md guncelle
- Teknik durumu STATE.json ve TASK_BOARD.md ile gorunur tut
- Veri akisini, query param mantigini ve deploy uyumlulugunu koru
```

## 4. Sana En Kolay Kopyala-Yapistir Prompt

Eger tek prompt vermek istiyorsan bunu kullan:

```text
Ikiniz de `C:\Users\SONY\Desktop\YAPALIM\.claude\worktrees\nifty-bassi-3bff39\tv_menu_collab\` altindaki hub ile calisin. Ilk is olarak README, STATE, TASK_BOARD, DECISIONS ve MESSAGES dosyalarini okuyun. Birbirinizle dogrudan degil bu hub uzerinden koordinasyon kurun: neyi degistirecekseniz once TASK_BOARD'a yazin, karar alip yon degistirdiyseniz DECISIONS'a yazin, kisa not/handoff gerekiyorsa MESSAGES'a yazin. Hedef ekran rolleri sabit: ekran1 marka+hero+top seller, ekran2 ana kahve menu, ekran3 upsell+soguk+tatli+kombin. Veri yapisini, route mantigini, `/api/tv-menu` ve `/api/tv-signals` akisini bozmayin. Tasarim zayifsa kucuk polish yapmayin; layout, spacing, tipografi ve kompozisyonu ciddi bicimde yeniden kurun ama gereksiz buyuk refactor yapmayin.
```
