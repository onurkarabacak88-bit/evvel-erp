# 📱 EVVEL YENİ · YOKLAMA / QR TELEFON — Tasarım (kod yazılmadı)

> Fable · 2026-10-18 · Bağlayıcı kararlar: `SUBE_PANELI_TASARIM.md` §D (D3, D4, D5, D5a, D8). Eski sistem incelendi: `gorev_api.py` (pin-giris :289, yemek :682-768, mesai-cikis :779, devir :852-1260, mühür :1498-1590, oto-kapat :1400-1495), `personel_panel_auth.py`, `src/pages/GorevGiris.jsx`, `GorevPersonelSayfasi.jsx`, `sube_panel.html` (:5556-5660, :13949-14083). EY tarafı: `evvel_yeni_moduller.py`, `evvel_yeni_cekirdek.py`, `evvel_yeni_panel_api.py`, `evvel_yeni_maas_api.py` (:418-475 takvim, :622-710 günlük yoklama), `evvel_yeni_tanim_api.py`, `evvel_yeni_olay.py`.
> Kural: sıfırdan, EY içinde, **yeni tak-çıkar modül `yoklama`**; eski `gorev_yoklama` / `kasa_devir_onay` / `yemek_molasi` / `personel_panel_auth` tablolarına köprü YOK. Uyarı personele gitmez. Giriş kapısı / yetki EN SONDA — ama telefon kimliği şimdi lazım (aşağıda çözüldü).

---

## A. SAHİP BÖLÜMÜ (1 sayfa)

### A1. Ne değişiyor — eski → yeni

| Konu | Eski (gorev_api) | Yeni (EY `yoklama` modülü) | Kazanç |
|---|---|---|---|
| Telefon kimliği | Telefonda ad seç + **4 haneli PIN** (merkezde PIN tanımı, 5 yanlış → 15 dk kilit) | **Telefon bir kez kişiye bağlanır** (merkez bağlantı linki gönderir → telefon "Ayşe'nin telefonu" olur). Sonra hiç yazı yazılmaz: QR okut → düğmeye bas | PIN yok, PIN yönetimi yok, kimse kimsenin şifresini görmez; yetki fazında aynı bağ "kişi oturumu" olur |
| QR | Şube başına **sabit** QR (ekran görüntüsü her yerden açar) | **Dönen QR**: her 60 sn değişir, 2 dk sonra ölür, şubeye bağlı; ekran görüntüsü işe yaramaz | "Evden QR okutma" kapanır |
| Konum | ≤150 m (yönetici muaf) | ≤150 m aynen (ey_sube koordinatı); muafiyet yok, düzeltme merkezde | Aynı güvence, daha az istisna |
| Giriş | PIN + konum → `gorev_yoklama` | QR + konum → `ey_yoklama` | Panelin ad listesi = bugün girenler (D4) |
| Çıkış | Telefondan "Mesai çıkışı" ya da 60 dk sonra **otomatik kapanıyordu** | Telefondan QR çıkış; **kasa devri = devredenin çıkışı, kapanış = kapanışçının çıkışı** (otomatik). Otomatik kapatma YOK → çıkışsız kişi merkez Bekleyen işler'e düşer, merkez saati yazar (D3) | Yoklama gerçek; uydurma çıkış saati yok |
| Yemek molası | Telefondan başlat/bitir, konumlu, günde 1, **ücret hakkı** hesaplıyordu | Aynı akış (`ey_mola`); **ücrete etkisi YOK** (aylık 7.000 ₺ sabit kuralı). Merkezde **Personel › Yemek molaları** sekmesi; bitmeyen mola → Bekleyen işler (D8) | Mola = bilgi, ceza değil |
| Kasa devri | Panelde form → sabahçı telefondan onay → akşamcı telefondan kabul (PIN'li) | Panelde **para + 3 bardak** → devreden kendi telefonundan **"Devrediyorum"** → devralan kendi telefonundan **"Kabul ediyorum" / "Tutmuyor"**; iki onayla devir tamam, devredenin çıkışı, devralan kapanış sorumlusu (D5) | Tablette PIN yok; iki imza telefonda |
| Kapanış mührü | QR mühür + "mühürsüz gönder" + yönetici "mesaisini kapat" | **Yok.** Kapanış kaydı = kapanışçının çıkışı; diğer açık kalanlar → Bekleyen işler | Kapanış 1 adım kısalır |

### A2. Telefon ekranı (tek sayfa, duruma göre tek büyük düğme)

| Durum | Telefonda görünen | Düğme |
|---|---|---|
| Telefon bağlı değil | "Bu telefon tanımlı değil — merkezden bağlantı iste" | — |
| QR okuttu, bugün giriş yok | "Zafer · 18 Ekim · Ayşe · konum ✓" | **GİRİŞ YAP** |
| Girdi | "Giriş 08:02" | **Yemek molası başlat** · **Çıkış yap** |
| Molada | "Mola 12:30'dan beri · 18 dk" | **Molayı bitir** |
| Devir bekliyor, ben devredenim | "Kasa: 1.250 ₺ · bardak 40/30/20 → Mehmet" | **DEVREDİYORUM** |
| Devreden onayladı, ben devralanım | aynı kart | **KABUL EDİYORUM** · **Tutmuyor** |
| Çıktı | "Çıkış 17:05 kaydedildi. İyi akşamlar." | — |

Hata tek cümle: "Şubeden uzaksın (320 m)" · "QR süresi doldu — tekrar okut" · "Konum izni gerekli". Başka uyarı yok.

### A3. Panel ve merkez ne görür

| Yer | Ne |
|---|---|
| Panel açılışı | Bugün QR girişi yoksa **tam ekran QR** (her 30 sn yenilenir). Giriş düşünce kapanır. Ad listesi = bugün girmiş ve çıkmamış kişiler; girmeyen kayıt yapamaz (sunucu da reddeder) |
| Panel ana sayfa | **"Bugün girenler"** kartı: ad · giriş saati · çıkış ✓ / molada 🍽 · köşede küçük QR (büyüt) · **Yemek Molası** düğmesi (QR büyütür) |
| Panel kasa devri | Para + 3 bardak + devralan → "Devri başlat" → QR + "devreden telefondan onaylasın" → "devralan kabul etsin" → ✓ |
| Merkez Personel › Takvim / Günlük yoklama | 1 Kasım'dan `ey_yoklama` okur (Ekim eski tablodan, salt okunur) |
| Merkez Personel › **Yemek molaları** (yeni) | gün gün kim · şube · başlangıç–bitiş · süre · bitirilmedi; "bitiş saati yaz" |
| Merkez Personel › **Telefonlar** (yeni, küçük) | kişi → bağlı telefon var/yok · "Bağlantı linki üret" · "Telefonu iptal et" |
| Bekleyen işler | 🚪 Çıkış yok (dün) · 🍽 Mola bitmedi · 🔁 Devir tamamlanmadı · ⚠ Devir "tutmuyor" · 📱 Telefonu bağlı olmayan personel · 📍 Koordinatı olmayan şube |

### A4. Takvim

| Faz | İş | Hedef |
|---|---|---|
| Y0 | Şube koordinatı · telefon bağlama · giriş/çıkış · dönen QR · panel QR kapısı + Bugün girenler | 23 Ekim |
| Y1 | Yemek molası + merkez sekmesi · kapanış→çıkış · Bekleyen işler sinyalleri · merkez düzeltme | 27 Ekim |
| Y2 | Kasa devri çift onay (telefon) + olay `vardiya` + kapanış sorumlusu | 30 Ekim |
| Y3 | **1 Kasım**: Maaş/Takvim/Günlük yoklama yeni tablodan; eski telefon sayfası "yeni sisteme geçildi" | 1 Kasım |
| Önce | 25–31 Ekim: her personelin telefonu bağlanır (WhatsApp'tan link, elle) — 1 Kasım'da Bekleyen işler'de "telefon yok" satırı KALMAMALI | 31 Ekim |

### A5. Sahibin vereceği kararlar

| # | Soru | Öneri |
|---|---|---|
| K1 | Telefon bağlama: merkez link üretir (WhatsApp'tan elle gönderir) **mi**, personel telefonda adını seçip merkez Bekleyen işler'den onaylar **mı**? | **Merkez link** (15-20 kişi, bir kez; sahte ad seçimi olmaz) |
| K2 | Konum muafiyeti (eski "yönetici muaf") kalsın mı? | **Kalmasın**; sahip/merkez şubede değilse zaten panel kullanmaz; düzeltme merkezden |
| K3 | Şubenin koordinatı yoksa giriş serbest mi, engel mi? | **Serbest + Bekleyen iş "koordinat yok"** (ilk gün şube kilitlenmesin) |
| K4 | Çıkış yaptıktan sonra aynı gün tekrar gelen kişi: telefondan ikinci giriş açılsın mı? | **Açılsın** (ikinci satır); Takvim gün bazında birleştirir |
| K5 | Devralan "Tutmuyor" derse: devir yine tamamlansın (çıkış işlensin) ama merkeze düşsün **mü**, devir açık kalsın **mı**? | **Tamamlansın + ⚠ Bekleyen iş** (kasa kimdeyse o sorumlu; akış tıkanmaz) |
| K6 | Eski telefon sayfasındaki diğer işler (görev listesi, avans talebi, stok sayım görevi, puan): 1 Kasım'da ne olacak? | Avans talebi → yeni telefon sayfasına **Y3'te** (Avans modülü ucu); görev listesi / sayım / puan **çıkar** (envanter kararı) |
| K7 | Mola uzunluk eşiği (merkez sekmesinde "uzun" işareti) | 60 dk (`ey_ayar.mola_limit_dk`), ücrete etkisiz |

---

## B. TEKNİK EK

### B1. Eski sistemden öğrenilenler (niyet)

| Mekanizma | Eski gerçek | Yeniye taşınan niyet |
|---|---|---|
| Kimlik | `personel.panel_pin_hash/salt`; `dogrula_personel_panel_pin`; kilit tablosu `panel_pin_guvenlik`; telefon oturumu `localStorage gorev_oturum_{sube}` (gün sonu düşer). Cihaz jetonu YOK | Kimlik = **cihaz bağı** (`ey_cihaz`), gün sonu düşmez; PIN tablosu hiç kurulmaz |
| QR | `/api/gorev/qr/{sube}` → `{APP_URL}/gorev-giris/{sube}` sabit PNG; rotasyon/anti-screenshot YOK | HMAC'li 60 sn dilim jetonu |
| Konum | `subeler.lat/lng/konum_radius_m` (150), haversine `_haversine_m`; `panel_yonetici` muaf; mola sabit 150 m | `ey_sube.lat/lng/yaricap_m`; tek `konum_kontrol` servisi, muafiyet yok (K2) |
| Giriş | `gorev_yoklama` UNIQUE(tarih, sube, personel, vardiya_tip); vardiya tipi plan+saat kuralıyla; `vardiya_disi`; "çıkış unuttun" uyarısı | `ey_yoklama` (vardiya tipi YOK — Takvim plan×QR'ı zaten eşleştiriyor); uyarı yok |
| Çıkış | `mesai-cikis` (manuel/kasa_devri/kapalis) + `otomatik_mesai_kapat` (plan bitiş+60 dk; tek kişi korumalı) + risk sinyali | QR / devir / kapanış / merkez; otomatik YOK (D3) |
| Mola | `yemek_molasi` 1/gün, `ucret_hakki = süre ≤ limit` | `ey_mola` 1/yoklama; süre bilgi; ücret kuralı dokunulmaz |
| Devir | `kasa_devir_onay` durumlar: form_kaydedildi → bekliyor (devreden_ts) → onaylandi (kabul_eden_id); `subeler.aktif_kapanis_sorumlusu`; `kasa_devir_adim1_kaydet` yan etkisi | `ey_devir` hazir → devreden_onayladi → tamam / tutmuyor / iptal; sorumlu `ey_devir`'den okunur; tamamda olay `vardiya` |
| Mühür | `kapanis-bekleyen` 3 sn yoklama, override | Yok |

### B2. Modül: `yoklama` (tak-çıkar)

- Manifest satırı: `{"kod":"yoklama","ad":"Yoklama","ikon":"📱","sektor":"genel","gerekir":["tanim","olay"],"menu":False,"aciklama":"telefon QR giriş/çıkış, yemek molası, kasa devri onayı; Personel sekmeleri buradan okur"}`. `panel` manifesti `gerekir` += `"yoklama"`. `maas` yoklamayı **gerektirmez**: PUBLIC servis import'u try içinde; modül kapalıysa Takvim "yoklama modülü kapalı" der.
- Dosya `evvel_yeni_yoklama_api.py`, `router prefix=/api/evvel-yeni/yoklama`; kurulum `yoklama_hazirla()` (uygulama açılışında, `lock_timeout 3s`, DDL panel işleminde değil — Codex kuralı).
- Ön yüz: telefon `src/pages/telefon/TelefonSayfasi.jsx` adres **`/q/{sube_id}/{token}`** (QR) ve `/q` (QR'sız: salt durum). Panel kabuğu `src/pages/subepanel/` içine QR kapısı + Bugün girenler + devir adımları. Merkez: `MaasModulu.jsx`'e `YemekMolalari`, `Telefonlar` görünümleri (`MAAS_SAYFALAR` iki satır).
- PUBLIC servisler (alt çizgisiz; panel/maaş yalnız bunları çağırır):

| Servis | Ne yapar |
|---|---|
| `qr_jeton(sube_id, dilim=None) -> str` · `qr_dogrula(sube_id, tok) -> bool` | HMAC jeton üret/doğrula (B5) |
| `konum_kontrol(cur, sube_id, lat, lng) -> int|None` | mesafe m; dışarıdaysa 403 `sube_disinda|…`; koordinat yoksa None (K3) |
| `bugun_girenler(cur, sube_id, gun) -> [{personel_id, ad, giris, cikis, molada}]` | panel kartı + ad listesi |
| `acik_mi(cur, sube_id, personel_id, gun) -> bool` | panel `_personel` kapısı: girmiş ve çıkmamış |
| `cikis_yaz(cur, sube_id, personel_id, gun, tur, mesafe=None, kim=None)` | devir/kapanış/merkez çıkışı; zaten çıkmışsa sessiz |
| `devir_ac(cur, sube_id, gun, devreden_id, devralan_id, sayilan_kurus, bardak:dict, istek_id) -> devir_id` | panel formu; açık `hazir` varsa günceller |
| `devir_durum(cur, sube_id, gun) -> dict|None` | panel 5 sn yoklar |
| `kapanis_sorumlusu(cur, sube_id, gun) -> personel_id|None` | son `tamam` devrin devralanı |
| `gun_yoklama(cur, bas, son) -> [rows]` · `molalar(cur, bas, son) -> [rows]` | Maaş Takvim / Günlük yoklama / Yemek molaları |
| `cihaz_coz(cur, jeton) -> {personel_id, ad, cihaz_id}` | telefon uçlarının kimlik kapısı (403 `cihaz_yok`) |

### B3. Veri modeli (yeni, minimal; hepsi `ey_` ön ekli, eski tabloya FK yok)

| Tablo | Sütunlar | Kurallar |
|---|---|---|
| `ey_sube` (+3 sütun) | `lat NUMERIC(9,6)`, `lng NUMERIC(9,6)`, `yaricap_m INT DEFAULT 150` | Tanımlar › Şube kartına girilir. **Tek seferlik kopya**: `tanim_hazirla` kopya örüntüsüyle `subeler.lat/lng/konum_radius_m` → yalnız boş olanlara (köprü değil, içerik kopyası) |
| `ey_cihaz` | `id TEXT PK`, `personel_id`, `jeton_hash TEXT UNIQUE` (sha256), `etiket` ("Ayşe'nin telefonu · Safari"), `durum` (davet/aktif/iptal), `davet_son TIMESTAMPTZ`, `olusturma`, `son_kullanim`, `olusturan`, `iptal_zaman` | Davet: `durum='davet'`, jeton = davet jetonu (tek kullanım, 48 saat). Bağlanınca **yeni** uzun jeton üretilir, davet jetonu silinir. Kişi başına birden çok aktif cihaz olabilir (yedek telefon) |
| `ey_yoklama` | `id`, `sube_id`, `personel_id`, `is_gunu DATE`, `giris_ts`, `giris_mesafe_m INT`, `giris_cihaz_id`, `cikis_ts`, `cikis_tur` (qr/devir/kapanis/merkez), `cikis_mesafe_m`, `cikis_cihaz_id`, `degistiren`, `zaman` | `UNIQUE(sube_id, personel_id, is_gunu, giris_ts)`; aynı gün **açık** kayıt varken ikinci giriş → aynı kaydı döner (idempotent); çıkmışsa K4'e göre yeni satır. İndeks `(sube_id, is_gunu)` |
| `ey_mola` | `id`, `yoklama_id UNIQUE`, `baslangic_ts`, `baslangic_mesafe_m`, `bitis_ts`, `bitis_mesafe_m`, `bitis_tur` (qr/merkez), `sure_dk INT`, `degistiren`, `zaman` | 1 mola / yoklama satırı (günde 1); giriş yoksa 403 |
| `ey_devir` | `id`, `sube_id`, `is_gunu`, `devreden_id`, `devralan_id`, `sayilan_kurus BIGINT`, `bardak JSONB {kucuk,buyuk,plastik}`, `durum` (hazir/devreden_onayladi/tamam/tutmuyor/iptal), `panel_ts`, `devreden_ts`, `devreden_mesafe_m`, `devralan_ts`, `devralan_mesafe_m`, `devralan_not`, `olay_id`, `istek_id`, `zaman` | Şube+gün için aynı anda tek açık (hazir/devreden_onayladi) devir; önceki `tamam` ise yenisi açılabilir (3 vardiya). `tamam`/`tutmuyor` anında olay `vardiya` yazılır (`olay_id`) |
| `ey_ayar` | `mola_limit_dk` (60), `qr_dilim_sn` (60) | mevcut ayar defteri |

Silme yok; düzeltme = ilgili sütun + `degistiren='merkez: <ad>'` (çıkış/mola bitişi için ayrıca `ey_sube_olay` tur=`yoklama_duzeltme` izi, kok `yoklama:duzelt:{id}`).

### B4. Telefon kimliği (PIN'siz) ve yetki fazına uyumu

1. **Bağlama** (K1 öneri): Merkez Personel › Telefonlar › "Bağlantı linki üret" → `POST /yoklama/cihaz/davet {personel_id}` → `{APP_URL}/q/bagla/{davet_jetonu}` (48 saat, tek kullanım). Merkez linki WhatsApp'tan elle gönderir (sistem mesaj atmaz). Personel linki telefonunda açar → "Bu telefonu Ayşe'ye bağla" → `POST /yoklama/cihaz-bagla {davet}` → sunucu 32 baytlık rastgele jeton üretir, hash'ini `ey_cihaz`'a yazar, düz jetonu **bir kez** döner; telefon `localStorage['ey_cihaz']`'a koyar. Sayfa "Ana ekrana ekle" ipucu gösterir (iOS Safari localStorage kalıcı; "ana ekrana ekle" ile ayrı kap olduğundan bağlama o kaptan yapılmalı — tek cümle ipucu).
2. **Her telefon isteği** `X-Evvel-Cihaz: <jeton>` başlığı taşır. `cihaz_coz` hash'leyip `ey_cihaz` (aktif, personel aktif) bulur; `son_kullanim` günceller. Yoksa 403 `cihaz_yok|Bu telefon tanımlı değil`. `personel_id` gövdede **gönderilmez**, cihazdan çözülür (eski CEP-001 dersi: istemci beyanı yazılmaz).
3. **Kaybolan telefon**: merkez "iptal et" (`durum='iptal'`); yeni telefon = yeni davet. Tarayıcı verisi silinirse aynı şey (davet yenilenir).
4. **Yetki fazına geçiş**: `ey_cihaz` zaten "kişi + cihaz" kimliğidir. Giriş kapısı gelince (a) merkez ekranları da aynı jetonu `X-Evvel-Cihaz` ya da oturum çerezi olarak kabul eder, (b) `ey_personel.rol` eklenir, (c) panel uçları `sube_id + personel_id` taşıdığından süzme sunucuda rol tablosuna bağlanır. PIN/şifre hiç gerekmez; sahip isterse yalnız merkez rolleri için ek şifre eklenir. Bugün hiçbir uç bu hazırlığı beklemez.
5. **Tablet** kimlik taşımaz (şube = URL). Panel uçları şimdilik açık (mevcut durum); yetki fazında tablet de "şube cihazı" olarak `ey_cihaz` (personel_id NULL, sube_id) ile bağlanır — aynı tablo, yeni satır türü.

### B5. QR jeton düzeni (dönen, şubeye bağlı, kısa ömürlü)

- `dilim = int(time.time() // qr_dilim_sn)` (60 sn). `jeton = base32(hmac_sha256(GIZ, f"{sube_id}:{dilim}"))[:10]` (50 bit). `GIZ` = env `EVVEL_QR_GIZ` (yoksa `ADMIN_SIFRE`'den türetilmiş sabit; üretimde ayrı değer önerilir).
- Doğrulama: `dilim` ve `dilim-1` kabul (en fazla 120 sn). Jeton **sunucu saatiyle** üretilir/doğrulanır; tablet saati önemsiz.
- QR içeriği: `{APP_URL}/q/{sube_id}/{jeton}`. Panel `GET /panel/{sube}/qr.png?t=` 30 sn'de bir yeniler (sunucu `qrcode` kütüphanesi mevcut); `GET /panel/{sube}/qr` `{url, kalan_sn}` da döner (yazıyla gösterim gerekmez).
- Telefon sayfası açılınca jetonu URL'den alır; işlem anında gövdede gönderir (`qr`). Sunucu: cihaz ✓ → QR ✓ → konum ✓ → iş. QR süresi dolduysa 409 `qr_eski|QR süresi doldu — tekrar okut`. Telefon sayfası salt-okur durumu QR'sız da gösterir; **yazan dört düğme QR ister**.
- Ekran görüntüsü / WhatsApp'tan paylaşılan QR: 2 dk içinde ve şube içinde olmak gerekir → anlamsız. Tablet çevrimdışıysa QR yenilenemez → telefonda "QR süresi doldu" (çevrimdışı kuyruk yoklamada YOK; sunucu olmadan kimlik doğrulanamaz).

### B6. Konum kontrolü

- `konum_kontrol`: `ey_sube.lat/lng` yoksa → None (K3; Bekleyen iş `sube_konum_yok`). Varsa `lat/lng` zorunlu (403 `konum_gerekli`), haversine > `yaricap_m` → 403 `sube_disinda|Şubeden uzaksın ({m} m)`. Mesafe her kayda yazılır (giriş/çıkış/mola/devir onayı) — merkez görür, personel görmez.
- Telefon: `navigator.geolocation.getCurrentPosition({enableHighAccuracy:true, timeout:10000, maximumAge:30000})` sayfa açılınca arka planda; düğme konum gelene kadar "konum alınıyor…" durumunda, 10 sn sonra "Konum izni gerekli" tek cümle + tekrar dene. HTTPS şart (var).
- Muafiyet yok (K2). Merkez düzeltme uçları konum istemez (yönetim oturumu `x_evvel_oturum`).

### B7. Telefon uçları (hepsi `X-Evvel-Cihaz` ister; `istek_id` ile tekrar yazılmaz)

| Uç | Gövde | Yaptığı |
|---|---|---|
| `GET /yoklama/ben?sube=&qr=` | — | `{kisi, sube, gun, konum_gerekli, giris, cikis, mola, devir, yapabilir:[giris|cikis|mola_baslat|mola_bitir|devret|kabul]}` — ekran bundan çizilir |
| `POST /yoklama/giris` | `{sube, qr, lat, lng, istek_id}` | `ey_yoklama` satırı; açık satır varsa onu döner |
| `POST /yoklama/cikis` | aynı | açık satıra `cikis_ts`, `cikis_tur='qr'`; açık mola varsa **mola da kapanır** (bitis_tur='qr') |
| `POST /yoklama/mola-baslat` · `/mola-bitir` | aynı | `ey_mola`; giriş yoksa 403 "Önce giriş yap"; ikinci mola 409 |
| `POST /yoklama/devir/{id}/devret` | `{sube, qr, lat, lng}` | yalnız `devreden_id` = cihaz kişisi; `hazir → devreden_onayladi` |
| `POST /yoklama/devir/{id}/kabul` | `{sube, qr, lat, lng, tutuyor: bool, not}` | yalnız `devralan_id`; `tutuyor` → `tamam`, değilse `tutmuyor` (K5: ikisi de kapanır). Tamam/tutmuyor anında: olay `vardiya` (`kok=panel:vardiya:{sube}:{devir_id}`, veri={devreden, devralan, sayilan, bardak, tutuyor, not}) + `cikis_yaz(devreden, tur='devir')` + devralan `acik_mi` değilse **devralan için giriş satırı açılır** (eski `devir-giris` niyeti: akşamcı devirle gelir) |
| `POST /yoklama/cihaz-bagla` | `{davet}` (başlıksız) | davet jetonu → aktif cihaz; düz jeton bir kez döner |

Panel uçları (tablet; `evvel_yeni_panel_api.py`): `GET /{sube}/durum` += `qr_gerekli` (bugün giren yok), `bugun_girenler`, `devir`, `kapanis_sorumlusu`; `personel` listesi = `acik_mi` olanlar. `POST /{sube}/devir` → artık olay yazmaz, `devir_ac` çağırır (`hazir`). `POST /{sube}/devir-iptal` yalnız `hazir` durumunda. `kapanis` → yazımdan sonra `cikis_yaz(kapanışçı, tur='kapanis')` aynı işlemde. `_personel` → `acik_mi` değilse 400 "Önce telefonundan QR ile giriş yap". Panel yalnız QR kapısı açıkken ve devir beklerken 5 sn yoklar (başka canlı yenileme yok — mevcut sadelik).

Merkez uçları (`x_evvel_oturum`): `GET /yoklama/gunler?bas&son`, `GET /yoklama/molalar?bas&son`, `POST /yoklama/duzelt {yoklama_id|mola_id, cikis_saat|bitis_saat, aciklama}`, `GET /yoklama/cihazlar`, `POST /yoklama/cihaz/davet`, `POST /yoklama/cihaz/{id}/iptal`, `GET /yoklama/devirler?bas&son`.

### B8. Devir durum makinesi

```
panel "Devri başlat" ──► hazir ──(devreden telefon: devret)──► devreden_onayladi ──(devralan: kabul tutuyor)──► tamam
                           │                                          │                                        └► olay vardiya + devreden çıkış + devralan giriş(yoksa) + sorumlu=devralan
                           │(panel iptal)                             └──(devralan: tutmuyor + not)──► tutmuyor  (aynı yan etkiler + ⚠ Bekleyen iş)
                           ▼
                         iptal
```
- `hazir` açıkken panel formu yeniden gönderirse aynı kayıt güncellenir; `devreden_onayladi` sonrası form kilitli (panel soluk; değişiklik = iptal → yeniden; iptali yalnız merkez yapar).
- Devreden/devralan = bugün girmiş kişiler; aynı kişi olamaz; devralan açık değilse (henüz QR girişi yok) **izin verilir** — kabulle giriş açılır (akşamcı gelir gelmez devir alır).
- Gün sonu (`is_gunu` değişti) hâlâ `hazir`/`devreden_onayladi` → Bekleyen iş `devir_tamamlanmadi`; merkez "iptal" ya da "tamam say".

### B9. Maaş / Personel modülü nasıl okur

- `personel_takvim` (`:418`) ve `gunluk_yoklama` (`:622`) kaynak seçimi: `gun >= ey_ayar.donem_baslangic (2026-11-01)` → `yoklama.gun_yoklama` (PUBLIC, try/import; modül yoksa boş + "yoklama modülü kapalı"); öncesi → eski `gorev_yoklama` okuyucusu (salt okunur, Aralık sökümünde silinir). Ad eşleme (`ey_ids`/`yabanci`) yeni kaynakta gerekmez: `ey_yoklama.personel_id` zaten `ey_personel`.
- Yemek ücreti: `aylık yemek × gün/30` **değişmez** (`:266`). `ey_mola` yalnız Yemek molaları sekmesi + Takvim gün hücresinde "🍽 42 dk" bilgi.
- `takvim_karar` "ayrıldı → son QR günü" (`:608`): `MAX(is_gunu) FROM ey_yoklama` (PUBLIC `son_giris_gunu(cur, pid)`), 1 Kasım öncesi eski tablo.
- Vardiya planı (`vardiya_atama`) eski sistemde kalıyor (ayrı madde); Günlük yoklama plan×QR eşlemesi aynen, yalnız QR kaynağı değişir.

### B10. Bekleyen işler sağlayıcısı (`bekleyen_is_kaydet("yoklama", …)`, grup `personel`)

| tur | Koşul | Satır / düğme |
|---|---|---|
| `yoklama_cikis_yok` | dün (ve önceki 7 gün) giriş var, `cikis_ts` NULL | "🚪 Ayşe — Zafer 17.10 çıkış yok" → "Çıkış saati yaz" |
| `mola_bitmedi` | `bitis_ts` NULL, gün geçti | "🍽 Mola bitmedi" → "Bitiş saati yaz" |
| `devir_tamamlanmadi` | `hazir`/`devreden_onayladi`, gün geçti ya da 2 saat | "🔁 Devir tamamlanmadı" → "İptal" / "Tamam say" |
| `devir_tutmuyor` | `durum='tutmuyor'`, merkez görmedi | "⚠ Devir tutmuyor: Mehmet — 'çekmecede 1.180 ₺'" → "Gördüm" (olay `yoklama_gorundu`) |
| `cihaz_yok` | aktif personelin aktif cihazı yok | "📱 Telefonu bağlı değil" → "Bağlantı linki üret" |
| `sube_konum_yok` | aktif şube lat/lng NULL | "📍 Koordinat yok" → Tanımlar › Şube |

Hiçbiri panele/telefona gitmez.

### B11. Merkez "Yemek molaları" sekmesi (Personel › Yemek molaları)

- Üst: tarih aralığı (bugün / 7 gün / ay), şube süzgeci, "yalnız bitmeyen" kutusu.
- Tablo: Tarih · Kişi · Şube · Başlangıç · Bitiş · Süre · Durum (bitti / sürüyor / **bitmedi** / merkez yazdı) · Mesafe (başl./bitiş, m) · Düzelt.
- Alt özet (ay): kişi → mola günü sayısı, ortalama süre, `> mola_limit_dk` sayısı (yalnız bilgi).
- Ücretle ilgili hiçbir sütun yok (sahip kuralı).

### B12. 1 Kasım geçişi

| Ne | Ekim (deneme) | 1 Kasım | Aralık |
|---|---|---|---|
| Yoklama yazımı | `yoklama` modülü **gerçek yazar** (para değil; deneme verisi faydalı); panel kuru modda kalır | aynı | — |
| Telefon sayfası | eski `/gorev-giris/{sube}` eski panelle sürer; yeni `/q/...` yeni panelle | eski sayfa tek ekran: "Yeni sisteme geçildi — paneldeki QR'ı okut" | eski sayfa + `gorev_api` yoklama/mola/devir uçları sökülür |
| Maaş okuma | eski `gorev_yoklama` | `donem_baslangic`'tan yeni | eski okuyucu silinir |
| Tablolar | eski tablolara dokunulmaz | yazılmaz | arşiv/sökümde kalkar |
| Kesim şartı | — | 31 Ekim 23:59: tüm aktif personel `ey_cihaz` aktif; 4 şube koordinatlı; Bekleyen işler'de `cihaz_yok`/`sube_konum_yok` = 0 | — |

Ekim verisi taşınmaz (içerik kopyası yalnız şube koordinatı). Kapanış saatinde (23:45–00:15) yayın yok; her faz Codex + Fable + `kapi_kontrol.py`.

### B13. Riskler

| Risk | Karşılık |
|---|---|
| GPS kapalı mekânda 50-150 m sapar | 150 m yarıçap (eski tecrübe); mesafe kaydedilir, merkez görür; engel yalnız gerçekten uzaksa |
| iOS Safari konum izni "bir kez" → her açılışta sorar | sayfa "Ana ekrana ekle" ipucu; izin "web sitesini kullanırken" seçilirse kalıcı |
| localStorage silinir → cihaz bağı kopar | davet linki yenilenir (merkez 10 sn); Bekleyen iş `cihaz_yok` görünür kılar |
| Telefon ödünç verilir | kimlik = telefon; QR + konum + merkez düzeltme; (yetki fazında istenirse merkez rolleri için şifre) |
| Tablet/sunucu saat farkı | jeton sunucu saatiyle; tablet 30 sn'de bir yeni PNG çeker |
| Devreden onaylamadan gider | devir `hazir` kalır → Bekleyen iş; panel akışı kilitlenmez (kapanış devir şartı değil) |
| Kapanışçı listede değil (QR girişi yapmadı) | sunucu 400; kişi QR okutur (10 sn), sonra kapanır |
| Aynı anda iki şubede giriş | ayrı satırlar; Takvim "iki şube" gösterir (sahip bunu istemişti) |
| 02:00 iş günü sınırı | her yerde `cekirdek.is_gunu()`; 01:30 girişi önceki güne |
| `olay_yaz` 503 | devir tamam/tutmuyor tek işlem: olay yazılamazsa durum da değişmez, telefon "tekrar dene" |

### B14. Boyut / kabul

| Faz | Boyut | Kabul ölçütü |
|---|---|---|
| Y0 | ~450 py + ~450 jsx | bağlı telefon QR okutup giriş yapar; 200 m dışından 403; 3 dk önceki QR 409; panel QR kapısı girişle kapanır; ad listesi = girenler; girmeyen kayıt → 400 |
| Y1 | ~250 py + ~350 jsx | mola başlat/bitir; ikinci mola 409; kapanış → kapanışçı `cikis_tur='kapanis'`; ertesi gün Bekleyen işler 4 satır doğru; merkez düzeltme iz bırakır |
| Y2 | ~300 py + ~350 jsx | devir: devreden onayı yalnız devreden cihazından; kabul yalnız devralan; tamamda 1 olay `vardiya` + devreden çıkış + sorumlu devralan; "tutmuyor" Bekleyen iş |
| Y3 | ~80 py | Takvim/Günlük yoklama 1 Kasım'dan yeni tablodan; eski telefon sayfası kapalı; 31 Ekim ↔ 1 Kasım kişi sayıları tutarlı |

---

## C. SAHİP KARARLARI (2026-10-18) — KARARLAŞTI
| # | Karar |
|---|---|
| K1 | ✅ Telefon bağlama: **merkez kişiye özel tek kullanımlık link** (48 saat) üretir, WhatsApp'tan gönderilir |
| K2 | ✅ Konum muafiyeti **kalkar**; herkes ≤150 m; zorunlu düzeltmeyi merkez yazar |
| K3 | ✅ Koordinatsız şube: giriş **serbest** + merkez Bekleyen işler "koordinat eksik" (1 Kasım öncesi 4 şube girilir) |
| K4 | ✅ Aynı gün ikinci giriş **açılır** (ayrı satır, süreler toplanır) |
| K5 | ✅ "Tutmuyor": devir **tamamlanır** + merkez "⚠ Devir tutmuyor" |
| K6 | ✅ Eski telefon sayfası: **avans taşınır**; görev listesi / stok sayım görevi / puan için ayrı envanter kararı (sonra) |
| K7 | ✅ Mola "uzun" eşiği **60 dk** (yalnız merkez işareti; ücrete etkisiz) |
