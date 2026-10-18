# 📱 EVVEL YENİ · YOKLAMA / QR TELEFON — Tasarım (kod yazılmadı) · Sürüm 2

> Fable · 2026-10-18 (S2: sahip kararları K1–K7 işlendi + Codex bulguları çözüldü, §D). Bağlayıcı kararlar: `SUBE_PANELI_TASARIM.md` §D (D3, D4, D5, D5a, D8) + bu dosya §C. Eski sistem incelendi: `gorev_api.py` (pin-giris :289, yemek :682-768, mesai-cikis :779, devir :852-1260, mühür :1498-1590, oto-kapat :1400-1495), `personel_panel_auth.py`, `src/pages/GorevGiris.jsx`, `GorevPersonelSayfasi.jsx`, `sube_panel.html`. EY tarafı: `evvel_yeni_moduller.py` (`DURUM` :62), `evvel_yeni_cekirdek.py` (`is_gunu` :39, `bekleyen_is_kaydet` :180), `evvel_yeni_panel_api.py`, `evvel_yeni_maas_api.py` (yemek :266, `_gecen_gun` :166, takvim :418, günlük yoklama :622), `evvel_yeni_tanim_api.py` (eski kopya örüntüsü :60-106, `erken_acilis` :101).
> Kural: sıfırdan, EY içinde, **yeni tak-çıkar modül `yoklama`**; eski `gorev_yoklama` / `kasa_devir_onay` / `yemek_molasi` / `personel_panel_auth` / `vardiya_atama` tablolarına köprü YOK (içerik kopyası bir kez: şube koordinatı, yönetici işareti). Uyarı personele gitmez (tek istisna K7: "yemek hakkı kazanılamadı" bilgi satırı). Giriş kapısı / yetki EN SONDA — ama telefon ve tablet kimliği şimdi lazım (B4).

---

## A. SAHİP BÖLÜMÜ (1 sayfa)

### A1. Ne değişiyor — eski → yeni

| Konu | Eski (gorev_api) | Yeni (EY `yoklama` modülü) | Kazanç |
|---|---|---|---|
| Telefon kimliği | Telefonda ad seç + **4 haneli PIN** (5 yanlış → 15 dk kilit) | **Telefon bir kez kişiye bağlanır**: merkez link üretir (K1) → personel linki **şubede, tabletteki QR'ı okutarak** açar → telefon "Ayşe'nin telefonu" olur. Sonra yazı yok: QR okut → düğme | PIN yok; kopyalanamayan cihaz anahtarı (B4); yetki fazında aynı bağ oturum olur |
| QR | Şube başına **sabit** QR | **Dönen QR**: 60 sn'de bir değişir, **60–120 sn** geçerli, şubeye bağlı, yalnız **kayıtlı şube tableti** üretebilir | Ekran görüntüsü / uzaktan QR çekme kapanır |
| Konum | ≤150 m (yönetici muaf) | ≤150 m (ey_sube koordinatı; **4 şube eski karttan bir kez kopyalanır**, K3); **yönetici işaretli kişi muaf** (K2, eski işaret bir kez kopyalanır) | Aynı güvence; mesafe her kayda yazılır, merkez görür |
| Giriş | PIN + konum → `gorev_yoklama` | QR + konum → `ey_yoklama`; kişinin aynı anda **tek açık** girişi olur | Panelin ad listesi = bugün girenler (D4) |
| Çıkış | Telefondan ya da 60 dk sonra **otomatik** | Telefondan QR çıkış; **kasa devri = devredenin çıkışı, kapanış = kapanışçının çıkışı**. Otomatik YOK → çıkışsız kişi merkez Bekleyen işler'de **çözülene kadar** kalır (D3) | Uydurma çıkış saati yok |
| Yemek molası | Telefondan başlat/bitir, günde 1, ücret hakkı | Aynı akış (`ey_mola`), **kişi başı iş gününde 1**. **K7:** ≤60 dk → yemek hakkı kazanılır; 61. dk'dan itibaren merkezde "uzun" + telefonda "Bugün yemek hakkı kazanılamadı" + o günün yemek hakkı maaşta düşer; merkez gerekirse elle hak verir (izli). Çıkış/devir/kapanış açık molayı da kapatır | Kural tek yerde; bordroda kesinti satırı değil, hak doğan gün sayısı |
| Kasa devri | Panelde form → telefon onayları (PIN'li) | Panelde **para + 3 bardak** → devreden telefondan **"Devrediyorum"** → devralan telefondan **"Kabul ediyorum" / "Tutmuyor"** (ikisi de devri tamamlar, K5); onay **formun o anki sürümüne** bağlı; devralan henüz girmediyse kabul = girişi | İki imza telefonda; sürüm değişirse onay geçersiz |
| Kapanış mührü | QR mühür + "mühürsüz gönder" | **Yok.** Kapanış = kapanışçının çıkışı; açık kalanlar → Bekleyen işler | 1 adım kısalır |
| Eski telefon sayfası | giriş/çıkış/mola/devir + görev listesi/avans/sayım/puan | **K6:** yoklama işleri 1 Kasım'da sunucuda kapanır (410); sayfa görev/avans/sayım/puan için **yeniden kurulacak** (ayrı iş), avans talebi oradan | Yoklama tek yerde, diğer işler kendi kurgusunda |

### A2. Telefon ekranı (tek sayfa, duruma göre tek büyük düğme)

| Durum | Telefonda görünen | Düğme |
|---|---|---|
| Telefon bağlı değil | "Bu telefon tanımlı değil — merkezden bağlantı iste" | — |
| Bağlantı linki açıldı | "Ayşe'nin telefonu olarak bağlanacak — tabletteki QR'ı okut" | **QR OKUT → BAĞLA** |
| QR okuttu, açık giriş yok | "Zafer · 18 Ekim · Ayşe · konum ✓" (muaf: "konum: yönetici") | **GİRİŞ YAP** |
| Girdi | "Giriş 08:02" | **Yemek molası başlat** · **Çıkış yap** |
| Molada | "Mola 12:30'dan beri · 18 dk" | **Molayı bitir** |
| Mola 60 dk'yı geçti | "Mola 74 dk — Bugün yemek hakkı kazanılamadı" (K7, tek satır) | **Molayı bitir** |
| Devir bekliyor, ben devredenim | "Kasa: 1.250 ₺ · bardak 40/30/20 → Mehmet" | **DEVREDİYORUM** |
| Devreden onayladı, ben devralanım | aynı kart (+ "girişin bununla açılır" henüz girmediyse) | **KABUL EDİYORUM** · **Tutmuyor** |
| Çıktı | "Çıkış 17:05 kaydedildi. İyi akşamlar." | — |

Hata tek cümle: "Şubeden uzaksın (320 m)" · "QR süresi doldu — tekrar okut" · "Konum izni gerekli" · "Devir formu değişti — tekrar bak". Başka uyarı yok.

### A3. Panel ve merkez ne görür

| Yer | Ne |
|---|---|
| Panel açılışı | Bugün QR girişi yoksa **tam ekran QR** (30 sn'de yenilenir; yalnız kayıtlı tablet alır). Giriş düşünce kapanır. Ad listesi = bugün girmiş ve çıkmamış kişiler |
| Panel ana sayfa | **"Bugün girenler"** kartı: ad · giriş · çıkış ✓ / molada 🍽 · altında **"Son okutanlar"** (son 2 dk: ad + kaç sn önce) · köşede küçük QR (büyüt) |
| Panel kasa devri | Para + 3 bardak + devralan (bugün girenler **+ henüz girmemiş aktif personel**, işaretli) → "Devri başlat" → "devreden onaylasın" → "devralan kabul etsin" → ✓ |
| Merkez Personel › Takvim / Günlük yoklama | 1 Kasım'dan `ey_yoklama`; Ekim eski tablodan salt okunur. Plan sütunu EY'de plan kaynağı gelene kadar "—" (eski `vardiya_atama` okunmaz) |
| Merkez Personel › **Yemek molaları** (yeni) | gün gün kim · şube · başlangıç–bitiş · süre · **hak ✓/✗** · "bitiş saati yaz" · "**hakkı elle ver**" (izli) |
| Merkez Personel › **Cihazlar** (yeni, küçük) | kişi → telefon var/yok/zayıf bağ · "Bağlantı linki üret" · "İptal et"; şube → tablet kayıtlı/değil |
| Bekleyen işler | 🚪 Çıkış yok · 🍽 Mola bitmedi · ⏱ Mola uzun (hak düştü) · 🔁 Devir tamamlanmadı · ⚠ Devir "tutmuyor" · 📱 Telefonu bağlı olmayan personel · 📟 Tableti kayıtsız şube · 📍 Koordinatı olmayan şube — **çözülene kadar kalır** |

### A4. Takvim

| Faz | İş | Hedef |
|---|---|---|
| Y0 | Şube koordinatı + yönetici işareti kopyası · tablet kaydı · telefon bağlama (cihaz anahtarı) · giriş/çıkış · dönen QR · panel QR kapısı + Bugün girenler + Son okutanlar | 23 Ekim |
| Y1 | Yemek molası + K7 hak kuralı + merkez sekmesi · kapanış→çıkış · Bekleyen işler · merkez düzeltme uçları | 27 Ekim |
| Y2 | Kasa devri çift onay (sürümlü) + olay `vardiya` + kapanış sorumlusu | 30 Ekim |
| Prova | 28–30 Ekim: Zafer'de gerçek tablet + 3 gerçek telefonla tam gün (giriş, mola, devir, kapanış, 02:00 sınırı) | 30 Ekim |
| Y3 | **1 Kasım 02:00**: eski yoklama yazım uçları sunucuda kapanır; Maaş/Takvim/Günlük yoklama yeni tablodan; geri dönüş anahtarı hazır | 1 Kasım |
| Önce | 25–31 Ekim: her personel şubede telefonunu bağlar; 4 tablet kayıtlı; Bekleyen işler'de 📱📟📍 = 0 | 31 Ekim |

### A5. Sahibin vereceği YENİ kararlar (K1–K7 §C'de kararlaştı)

| # | Soru | Öneri |
|---|---|---|
| K8 | O gün **hiç mola başlatmayan** kişi: yemek hakkı kazanılır mı? (K7 yalnız "60 dk'yı geçen" molayı düşürür) | **Kazanılır** (ihlal yok; eski "molaya zamanında girmeyen" kesintisi EY'ye taşınmaz) |
| K9 | Telefon bağlama **şubede, tabletteki QR'la** yapılır (kendi telefonu + fiziksel varlık kanıtı). Uzaktan bağlama istisnası olsun mu? | **Olmasın**; 25–31 Ekim'de herkes şubede bağlar |
| K10 | Şube Wi-Fi çıkış IP'si ikinci sinyal olarak tanımlansın mı (eşleşmeyen kayıt engellenmez, merkez görür)? | **Tanımlansın** (Tanımlar › Şube'ye tek alan; 4 şube, 10 dk) |
| K11 | Aynı anda iki şubede açık giriş **olmaz** (önce çıkış, sonra diğer şubede giriş). Takvim yine "iki şube" gösterir. Uygun mu? | **Uygun** (Codex: tek açık giriş kuralı) |

---

## B. TEKNİK EK

### B1. Eski sistemden öğrenilenler (niyet)

| Mekanizma | Eski gerçek | Yeniye taşınan niyet |
|---|---|---|
| Kimlik | `personel.panel_pin_hash/salt`; kilit `panel_pin_guvenlik`; `localStorage gorev_oturum_{sube}`; cihaz jetonu YOK | Kimlik = **cihaz anahtarı** (`ey_cihaz`, B4); PIN tablosu kurulmaz |
| QR | `/api/gorev/qr/{sube}` sabit PNG, herkese açık | HMAC'li 60 sn dilim jetonu; yalnız kayıtlı tablet alır (B5) |
| Konum | `subeler.lat/lng/konum_radius_m`, haversine; `personel.panel_yonetici` muaf | `ey_sube.lat/lng/yaricap_m` (bir kez kopya); `ey_personel.konum_muaf` (bir kez kopya, K2) |
| Giriş | `gorev_yoklama` UNIQUE(tarih, sube, personel, vardiya_tip); vardiya tipi; "çıkış unuttun" | `ey_yoklama`, kişi başına **tek açık** satır (kısmi UNIQUE); vardiya tipi yok; uyarı yok |
| Çıkış | manuel/kasa_devri/kapanış + `otomatik_mesai_kapat` | QR / devir / kapanış / merkez; otomatik YOK (D3) |
| Mola | `yemek_molasi` 1/gün, `ucret_hakki = süre ≤ limit` | `ey_mola` 1/kişi/iş günü; `yemek_hakki` = süre ≤ `mola_limit_dk` (K7); merkez elle hak (izli) |
| Devir | `kasa_devir_onay` form → bekliyor → onaylandi; `subeler.aktif_kapanis_sorumlusu` | `ey_devir` hazir → devreden_onayladi → tamam / tutmuyor / iptal / merkez_kapatti; sürümlü onay; sorumlu `ey_devir`'den |
| Mühür | `kapanis-bekleyen`, override | Yok |
| Vardiya planı | `vardiya_atama` × QR | EY'de plan kaynağı yok → Günlük yoklama plansız çalışır; plan EY `vardiya` modülü gelince eklenir (ayrı madde) |

### B2. Modül: `yoklama` (tak-çıkar)

- Manifest: `{"kod":"yoklama","ad":"Yoklama","ikon":"📱","sektor":"genel","gerekir":["tanim","olay"],"menu":False,"aciklama":"telefon QR giriş/çıkış, yemek molası + hak, kasa devri onayı, cihaz kaydı; Personel sekmeleri buradan okur"}`. `panel` manifesti `gerekir` += `"yoklama"`. `maas` yoklamayı **gerektirmez**: `evvel_yeni_moduller.DURUM.get("yoklama") == "yuklendi"` ise PUBLIC servisi çağırır; değilse eski formül + "yoklama modülü kapalı" uyarısı (try/import ile değil — kapalı modül `DURUM`'da `kapali`/`eksik:` görünür).
- Dosya `evvel_yeni_yoklama_api.py`, `router prefix=/api/evvel-yeni/yoklama`; `yoklama_hazirla()` uygulama açılışında (`lock_timeout 3s`, DDL panel işleminde değil).
- Ön yüz: telefon `src/pages/telefon/TelefonSayfasi.jsx` — `/q/{sube_id}/{token}` (QR), `/q` (salt durum), `/q/bagla/{davet}`. Panel kabuğu `src/pages/subepanel/`: QR kapısı + Bugün girenler + Son okutanlar + devir adımları + tablet kaydı ekranı. Merkez: `MaasModulu.jsx`'e `YemekMolalari`, `Cihazlar` görünümleri.
- PUBLIC servisler (panel/maaş yalnız bunları çağırır):

| Servis | Ne yapar |
|---|---|
| `qr_jeton(sube_id, dilim=None)` · `qr_dogrula(sube_id, tok) -> dilim|None` | HMAC jeton (B5) |
| `konum_kontrol(cur, sube_id, personel_id, lat, lng) -> {mesafe_m, muaf, ip_disi}` | 403 dışarıdaysa; muaf kişi/koordinatsız şube → mesafe None |
| `bugun_girenler(cur, sube_id, gun)` · `son_okutanlar(cur, sube_id, sn=120)` | panel kartı + ad listesi |
| `acik_mi(cur, sube_id, personel_id)` | panel `_personel` kapısı |
| `cikis_yaz(cur, personel_id, tur, ts=None, mesafe=None, kim=None)` | açık satırı kapatır; **açık molayı da kapatır** (aynı tur); zaten çıkmışsa sessiz |
| `devir_ac(cur, sube_id, gun, devreden_id, devralan_id, sayilan_kurus, bardak, istek_id) -> {devir_id, surum}` | `hazir` varsa günceller, `surum` yeniler |
| `devir_durum(cur, sube_id, gun)` · `kapanis_sorumlusu(cur, sube_id, gun)` | sorumlu = son `tamam` **veya `tutmuyor`** devrin devralanı |
| `gun_yoklama(cur, bas, son)` · `molalar(cur, bas, son)` · `son_giris_gunu(cur, pid)` | Takvim / Günlük yoklama / Yemek molaları |
| `yemek_hak_gunleri(cur, personel_id, ay) -> {calisilan_gun, hak_gun, dusen:[{gun, sure_dk, elle_verildi}]}` | **Maaş yemek kalemi** (B9) |
| `cihaz_coz(request) -> {cihaz_id, personel_id|None, sube_id|None, tur}` | imzalı istek kapısı (B4); 403 `cihaz_yok` |

### B3. Veri modeli (hepsi `ey_` ön ekli; eski tabloya FK yok)

| Tablo | Sütunlar | Kurallar |
|---|---|---|
| `ey_sube` (+4) | `lat`, `lng`, `yaricap_m INT DEFAULT 150`, `ip_listesi TEXT[]` (K10) | Tanımlar › Şube kartı. **Bir kez kopya** (`tanim_hazirla` örüntüsü, ayar `sube_konum_kopya`): `subeler.lat/lng/konum_radius_m` → yalnız boş olanlara (K3) |
| `ey_personel` (+1) | `konum_muaf BOOLEAN DEFAULT FALSE` | `ALTER … IF NOT EXISTS` (erken_acilis örüntüsü :101); ayar `konum_muaf_kopya` ile `personel.panel_yonetici=TRUE` → bir kez (K2). Tanımlar › Personel'de kutu |
| `ey_cihaz` | `id TEXT PK`, `tur` (telefon/tablet), `personel_id`, `sube_id`, `acik_anahtar JSONB` (P-256 JWK), `jeton_hash TEXT` (yalnız zayıf bağ), `guc` (anahtar/jeton), `etiket`, `durum` (davet/aktif/iptal), `davet_hash`, `davet_son`, `bagla_mesafe_m`, `bagla_qr_dilim`, `olusturma`, `son_kullanim`, `olusturan`, `iptal_zaman` | Telefon: `personel_id`; tablet: `sube_id`. Kişi başına birden çok aktif olabilir |
| `ey_cihaz_nonce` | `cihaz_id`, `nonce TEXT`, `zaman` — PK(cihaz_id, nonce) | tekrar-oynatma kilidi; 10 dk'dan eskiler silinir |
| `ey_qr_kullanim` | `sube_id`, `dilim BIGINT`, `personel_id`, `islem`, `zaman` — **UNIQUE(sube_id, dilim, personel_id, islem)** | aynı jetonla aynı kişi aynı işlemi iki kez yapamaz; "son okutanlar" buradan |
| `ey_yoklama` | `id`, `sube_id`, `personel_id`, `is_gunu`, `giris_ts`, `giris_mesafe_m`, `giris_muaf`, `giris_ip_disi`, `giris_cihaz_id`, `cikis_ts`, `cikis_tur` (qr/devir/kapanis/merkez), `cikis_mesafe_m`, `cikis_cihaz_id`, `istek_id UNIQUE`, `degistiren`, `zaman` | **Kısmi UNIQUE `(personel_id) WHERE cikis_ts IS NULL`** → kişinin tek açık girişi (K11). Giriş: `SELECT … FOR UPDATE` açık satır varsa onu döner; çıkmışsa K4 yeni satır. İndeks `(sube_id, is_gunu)` |
| `ey_mola` | `id`, `personel_id`, `is_gunu`, `yoklama_id`, `baslangic_ts`, `baslangic_mesafe_m`, `bitis_ts`, `bitis_mesafe_m`, `bitis_tur` (qr/devir/kapanis/merkez), `sure_dk`, `yemek_hakki BOOLEAN` (bitişte: `sure_dk <= mola_limit_dk`), `hak_elle BOOLEAN DEFAULT FALSE`, `hak_veren`, `hak_zaman`, `hak_aciklama`, `istek_id UNIQUE`, `degistiren`, `zaman` | **UNIQUE(personel_id, is_gunu)** → kişi başı iş gününde 1 (K4 ikinci giriş ikinci mola açmaz). Merkez "hakkı elle ver": `hak_elle=TRUE` + iz `ey_sube_olay` tur=`yemek_hak_elle` |
| `ey_devir` | `id`, `sube_id`, `is_gunu`, `devreden_id`, `devralan_id`, `sayilan_kurus`, `bardak JSONB`, `surum TEXT` (sha256: devreden·devralan·sayilan·bardak), `durum` (hazir/devreden_onayladi/tamam/tutmuyor/iptal/**merkez_kapatti**), `panel_ts`, `devreden_ts`, `devreden_mesafe_m`, `devreden_surum`, `devralan_ts`, `devralan_mesafe_m`, `devralan_surum`, `devralan_not`, `merkez_sonuc`, `merkez_kim`, `merkez_aciklama`, `olay_id`, `istek_id UNIQUE`, `zaman` | **Kısmi UNIQUE `(sube_id, is_gunu) WHERE durum IN ('hazir','devreden_onayladi')`** → tek açık devir. Her geçiş `FOR UPDATE`. `tamam`/`tutmuyor` anında olay `vardiya` |
| `ey_ayar` | `mola_limit_dk` (60), `qr_dilim_sn` (60), `donem_baslangic` (2026-11-01), `yoklama_kesim` (eski uçlar kapalı mı) | mevcut ayar defteri |

Silme yok; düzeltme = sütun + `degistiren='merkez: <ad>'` + `ey_sube_olay` tur=`yoklama_duzeltme`, kok `yoklama:duzelt:{id}`. Telefonun **her yazan ucu** `istek_id` taşır (UUID, telefonda üretilir, yanıt gelene kadar saklanır); aynı `istek_id` → önceki sonuç döner.

### B4. Cihaz kimliği (PIN'siz, kopyalanamaz) ve yetki fazına uyumu

1. **Anahtar**: Telefon/tablet ilk açılışta WebCrypto ile **ECDSA P-256, `extractable:false`** anahtar çifti üretir, IndexedDB'de saklar (anahtar tarayıcıdan dışarı çıkarılamaz → localStorage kopyalama saldırısı kapanır). Açık anahtar sunucuya gider.
2. **Bağlama (K1 + K9)**: Merkez Personel › Cihazlar › "Bağlantı linki üret" → `POST /yoklama/cihaz/davet {personel_id | sube_id}` → `{APP_URL}/q/bagla/{davet}` (48 saat, tek kullanım), WhatsApp'tan elle gönderilir. Personel linki **şubede** açar → sayfa "tabletteki QR'ı okut" der → `POST /yoklama/cihaz-bagla {davet, acik_anahtar, qr, lat, lng, etiket}`: sunucu davet ✓ + **QR ✓ (B5) + konum ✓** → `ey_cihaz` aktif (`bagla_mesafe_m`, `bagla_qr_dilim` yazılır). Linki açmak tek başına kanıt değil; **tabletin önünde olmak** kanıt. Tablet kaydı aynı yol: merkez `sube_id` için davet üretir, tablette açılır, QR adımı yerine merkez onayı (Bekleyen iş `tablet_onay`, "Bu tablet Zafer'in mi?" → Onayla).
3. **Her istek imzalı**: başlıklar `X-Evvel-Cihaz: {cihaz_id}`, `X-Evvel-Zaman: {unix}`, `X-Evvel-Nonce: {uuid}`, `X-Evvel-Imza: base64(ECDSA(cihaz_id|zaman|nonce|METHOD|path|sha256(gövde)))`. Sunucu: cihaz aktif ✓, `|zaman − now| ≤ 120 sn`, nonce `ey_cihaz_nonce`'a ilk kez giriyor ✓, imza açık anahtarla ✓ → `cihaz_coz`. `personel_id` gövdede gönderilmez. İmza yardımcıları tek dosya `src/lib/cihazImza.js` (telefon + tablet + ileride merkez).
4. **Geri düşüş (`guc='jeton'`)**: WebCrypto/IndexedDB yoksa (çok eski iOS) 32 baytlık rastgele jeton (sha256 hash sunucuda, düz jeton localStorage). Cihazlar listesinde "zayıf bağ" etiketi; merkez bilir. Varsayılan değil, istisna.
5. **İptal / yeniden davet**: merkez "İptal et" (`durum='iptal'`, anahtar artık geçersiz); yeni telefon / tarayıcı verisi silindi = yeni davet (şubede, QR'la). Kaybolan telefon 1 dk'da ölü.
6. **Tablet** artık kimlik taşır (`tur='tablet'`, `sube_id`): QR üretim ucu yalnız imzalı tablet isteğine açılır (B5). Diğer panel uçları şimdilik açık (mevcut durum); yetki fazında aynı imza panele de şart koşulur — aynı tablo, aynı kütüphane, yeni kod yok.
7. **Yetki fazı**: `ey_cihaz` = "kişi + cihaz" kimliği. Giriş kapısı gelince merkez ekranları da aynı imzayı kabul eder, `ey_personel.rol` eklenir, panel uçları role bağlanır. PIN/şifre gerekmez.

### B5. QR jeton düzeni (dönen, şubeye bağlı, 60–120 sn)

- `dilim = int(sunucu_zamani // qr_dilim_sn)`; `jeton = base32(hmac_sha256(GIZ, f"{sube_id}:{dilim}"))[:10]`. `GIZ` = env `EVVEL_QR_GIZ` (yoksa `ADMIN_SIFRE`'den türetilir; üretimde ayrı değer).
- Doğrulama `dilim` ve `dilim-1` → **ömür 60–120 sn** (dilim başında okutulan 120 sn'ye yakın, sonunda 60 sn'ye yakın yaşar). Üretim ve doğrulama **sunucu saatiyle**; tablet/telefon saati önemsiz. Sınır testi: dilim sonunda okutulup 59 sn sonra gönderilen ✓, 121 sn sonra 409.
- **Üretim ucu kapalı**: `GET /panel/{sube}/qr.png` ve `/qr` yalnız o şubeye kayıtlı tabletin imzalı isteğine cevap verir (B4.3); başka istek 403 `tablet_degil`. Uzaktan "güncel QR'ı çek" kapanır.
- QR içeriği `{APP_URL}/q/{sube_id}/{jeton}`. Panel 30 sn'de bir yeniler. Telefon işlemde `qr`'ı gövdede gönderir; sunucu sırası: cihaz imzası ✓ → QR ✓ → `ey_qr_kullanim` (aynı kişi + aynı dilim + aynı işlem ikinci kez → 409 `qr_kullanildi`) → konum ✓ → iş.
- **Kalan risk (dürüst)**: 60–120 sn içinde QR fotoğrafı WhatsApp'tan gönderilip konum taklidiyle (Chrome DevTools, sahte GPS uygulaması) uzaktan giriş **yazılabilir**. Ucuz ek kontroller: (1) jeton + kişi + işlem tek kullanım; (2) panelde **"Son okutanlar"** canlı listesi — şubedeki ekip yabancı adı anında görür; (3) K10 şube IP'si tanımlıysa eşleşmeyen istek `ip_disi=TRUE` damgalı (engel değil, merkez görür; Takvim hücresinde 📶 işareti); (4) merkez Günlük yoklama'da mesafe + ip_disi + cihaz görünür. Tam kanıt (NFC/BLE) kurulmaz — sadelik.
- Tablet çevrimdışıysa QR yenilenmez → telefonda "QR süresi doldu" (yoklamada çevrimdışı kuyruk YOK; kimlik sunucusuz doğrulanmaz).

### B6. Konum kontrolü

- `konum_kontrol`: `ey_personel.konum_muaf` → mesafe hesaplanmaz, `muaf=TRUE` damgası (K2; lat/lng geldiyse yine kaydedilir). Şube `lat/lng` yoksa → None + Bekleyen iş `sube_konum_yok` (K3; 4 şube kopyalandığı için 1 Kasım'da görünmemeli). Varsa `lat/lng` zorunlu (403 `konum_gerekli`), haversine > `yaricap_m` → 403 `sube_disinda|Şubeden uzaksın ({m} m)`. `ip_listesi` doluysa istemci IP karşılaştırılır → `ip_disi`. Mesafe/muaf/ip_disi her kayda yazılır — merkez görür, personel görmez.
- Telefon: `getCurrentPosition({enableHighAccuracy:true, timeout:10000, maximumAge:30000})` sayfa açılınca; 10 sn sonra "Konum izni gerekli" + tekrar dene. Muaf kişide konum beklenmez. HTTPS şart (var).
- Merkez düzeltme uçları konum istemez (`x_evvel_oturum`).

### B7. Telefon uçları (hepsi imzalı, B4.3; yazanlar `istek_id` + `qr` taşır)

| Uç | Gövde | Yaptığı |
|---|---|---|
| `GET /yoklama/ben?sube=&qr=` | — | `{kisi, sube, gun, konum_gerekli, muaf, giris, cikis, mola:{…, hak_dustu}, devir:{…, surum}, yapabilir:[…]}` |
| `POST /yoklama/giris` | `{sube, qr, lat, lng, istek_id}` | açık satır `FOR UPDATE`; varsa onu döner; yoksa yeni (K4). Başka şubede açık → 409 `baska_subede_acik|Önce {şube}'den çıkış yap` (K11) |
| `POST /yoklama/cikis` | aynı | `cikis_yaz(tur='qr')`; açık mola bitis_tur='qr' ile kapanır, hak hesaplanır |
| `POST /yoklama/mola-baslat` · `/mola-bitir` | aynı | giriş yoksa 403; aynı iş gününde ikinci → 409 `mola_var`; bitişte `sure_dk`, `yemek_hakki`; `> limit` → yanıt `hak_dustu:true` (telefon tek satır gösterir, K7) |
| `POST /yoklama/devir/{id}/devret` | `{sube, qr, lat, lng, istek_id, surum}` | yalnız `devreden_id`; `surum` ≠ kayıt → 409 `devir_degisti`; `hazir → devreden_onayladi` (`devreden_surum`) |
| `POST /yoklama/devir/{id}/kabul` | `{…, surum, tutuyor, not}` | yalnız `devralan_id`; `surum` ≠ → 409; `tutuyor` → `tamam`, değilse `tutmuyor` (K5). Aynı işlemde: olay `vardiya` (`kok=panel:vardiya:{sube}:{devir_id}`, veri={devreden, devralan, sayilan, bardak, tutuyor, not, surum}) + `cikis_yaz(devreden,'devir')` + devralan açık değilse **giriş satırı açılır** (QR+konum zaten doğrulandı) |
| `POST /yoklama/cihaz-bagla` | `{davet, acik_anahtar, qr, lat, lng, etiket}` (imzasız; davet tek kullanım) | B4.2 |

Panel uçları (`evvel_yeni_panel_api.py`): `GET /{sube}/durum` += `qr_gerekli`, `bugun_girenler`, `son_okutanlar`, `devir`, `kapanis_sorumlusu`, `tablet_kayitli`; `personel` listesi = `acik_mi`. `GET /{sube}/qr(.png)` yalnız tablet imzasıyla. `POST /{sube}/devir` → `devir_ac` (`hazir`; `surum` döner); devralan listesi bugün girenler + girmemiş aktif personel. `POST /{sube}/devir-iptal` yalnız `hazir`. `kapanis` → `cikis_yaz(kapanışçı,'kapanis')` aynı işlemde (açık molası da kapanır). `_personel` → `acik_mi` değilse 400. Panel yalnız QR kapısı/devir beklerken 5 sn yoklar.

Merkez uçları (`x_evvel_oturum`) — Bekleyen işler'deki **her düğmenin ucu** burada:

| Uç | İş |
|---|---|
| `GET /yoklama/gunler?bas&son` · `GET /yoklama/molalar?bas&son` · `GET /yoklama/devirler?bas&son` · `GET /yoklama/cihazlar` | okuma |
| `POST /yoklama/duzelt {yoklama_id, cikis_saat, aciklama}` | çıkış yaz (tur merkez) + açık mola aynı saatte kapanır + iz |
| `POST /yoklama/mola/{id}/duzelt {bitis_saat, aciklama}` | bitiş yaz + hak hesaplanır + iz |
| `POST /yoklama/mola/{id}/hak-ver {aciklama}` | `hak_elle=TRUE` (K7 "ödemesini yaparız") + iz |
| `POST /yoklama/devir/{id}/merkez-kapat {sonuc: iptal|kapandi, aciklama}` | `durum='merkez_kapatti'`, `merkez_sonuc`; `kapandi` ise olay `vardiya` veri `merkez_istisna=TRUE` + devreden çıkışı; ekranda **"merkez kapattı"** — asla kişi onayı gibi görünmez |
| `POST /yoklama/devir/{id}/gorundu` | ⚠ tutmuyor satırı kapanır (`ey_sube_olay` tur=`yoklama_gorundu`) |
| `POST /yoklama/cihaz/davet {personel_id|sube_id}` · `POST /yoklama/cihaz/{id}/iptal` · `POST /yoklama/cihaz/{id}/onayla` (tablet) | cihaz yönetimi |

### B8. Devir durum makinesi

```
panel "Devri başlat" ──► hazir (surum v1) ──(devreden: devret, surum=v1)──► devreden_onayladi ──(devralan: kabul tutuyor, surum=v1)──► tamam
      │  panel formu değişir → surum v2 (hazir'da)          │ form kilitli                                                └► olay vardiya + devreden çıkış + devralan giriş(yoksa) + sorumlu=devralan
      │(panel iptal, yalnız hazir)                           └──(devralan: tutmuyor + not, surum=v1)──► tutmuyor  (aynı yan etkiler + sorumlu=devralan + ⚠ Bekleyen iş)
      ▼                                                      └──(merkez: merkez-kapat)──► merkez_kapatti (istisna; iptal → yan etki yok · kapandi → olay vardiya merkez_istisna + devreden çıkışı)
    iptal
```
- `surum` = formun özeti; telefon `ben`'den aldığı `surum`'u onayla geri gönderir; tutmazsa 409 "Devir formu değişti — tekrar bak" (yarış kapanır). `devreden_onayladi` sonrası form kilitli; değişiklik = merkez-kapat(iptal) → yeniden.
- Devreden = bugün girmiş; devralan = bugün girmiş **veya** henüz girmemiş aktif personel (kabulle girişi açılır); aynı kişi olamaz.
- `kapanis_sorumlusu` = şube+gün son `tamam`/`tutmuyor`/`merkez_kapatti(kapandi)` devrin devralanı.
- Gün sonu hâlâ `hazir`/`devreden_onayladi` → Bekleyen iş `devir_tamamlanmadi` (merkez-kapat).

### B9. Maaş / Personel modülü nasıl okur

- Kaynak seçimi `personel_takvim` (:418) ve `gunluk_yoklama` (:622): `gun >= ey_ayar.donem_baslangic` → `DURUM["yoklama"]=="yuklendi"` ise `yoklama.gun_yoklama`; değilse boş + "yoklama modülü kapalı". Öncesi → eski `gorev_yoklama` okuyucusu (salt okunur, Aralık sökümünde silinir). Yeni kaynakta ad eşleme (`ey_ids`/`yabanci`) gerekmez.
- **Vardiya planı okunmaz** (`vardiya_atama` sorgusu :644 kaldırılır): Günlük yoklama durumları `girdi / girmedi(aktif personel) / çıkış yok`; "zamanında/geç" plan EY'ye gelince (ayrı madde) eklenir.
- **Yemek kalemi (K7)** — `:266` değişir, tek POZİTİF kalem kalır (kesinti satırı YOK — yemek kuralı belleği):
  ```
  gun            = _gecen_gun(…)                       # dönem oranı aynen (ay ortası giren/ayrılan tam almaz)
  h              = yemek_hak_gunleri(cur, pid, ay)     # calisilan_gun = DISTINCT is_gunu FROM ey_yoklama (giriş var)
  payda          = h.calisilan_gun                     # kişiye/aya özel payda (plan yok → QR ile çalışılan gün)
  hak_gun        = payda − |dusen| (dusen: mola.yemek_hakki=FALSE AND hak_elle=FALSE; K8: molasız gün hak kazanır)
  yemek          = aylik × gun/30 × hak_gun/payda      # payda 0 → aylik × gun/30 (tam hak, kaynak 'yoklama_yok')
  kalem ad       = "Yemek: aylık × 26/30 × 24/25 gün"  # kanıt: ek.yemek_dusen = [{gun, sure_dk}] (Takvim hücresinde 🍽✗)
  ```
  Bir gün hak düşünce etki = `aylik × gun/30 / payda` (7.000/25 = 280 ₺). `yemek_hak` alanı ve öneri bölüşümü (:288) aynen. Onaylı ay dondurulmuş kalemlerden okur (:270) → sonradan "hakkı elle ver" onaylı ayı değiştirmez; merkez onayı kaldırıp yeniden onaylar (mevcut akış).
- Modül kapalıysa: `yemek = aylik × gun/30` + uyarı "yoklama modülü kapalı — yemek tam sayıldı".
- `takvim_karar` "ayrıldı → son QR günü" (:608): `son_giris_gunu(cur, pid)`; 1 Kasım öncesi eski tablo.

### B10. Bekleyen işler sağlayıcısı (`bekleyen_is_kaydet("yoklama", …)`, grup `personel`) — **çözülene kadar kalır**

| tur | Koşul | Satır / düğme → uç |
|---|---|---|
| `yoklama_cikis_yok` | `cikis_ts` NULL ve `is_gunu` < bugün (tarih sınırı yok) | "🚪 Ayşe — Zafer 17.10 çıkış yok" → "Çıkış saati yaz" → `duzelt` |
| `mola_bitmedi` | `bitis_ts` NULL, iş günü geçti | "🍽 Mola bitmedi" → "Bitiş saati yaz" → `mola/{id}/duzelt` |
| `mola_uzun` | `yemek_hakki=FALSE`, `hak_elle=FALSE`, merkez görmedi | "⏱ Ayşe mola 74 dk — yemek hakkı düştü" → "Gördüm" / "Hakkı elle ver" → `hak-ver` |
| `devir_tamamlanmadi` | `hazir`/`devreden_onayladi`, gün geçti ya da 2 saat | "🔁 Devir tamamlanmadı" → "Kapat (iptal / kapandı say)" → `merkez-kapat` |
| `devir_tutmuyor` | `durum='tutmuyor'`, görülmedi | "⚠ Devir tutmuyor: Mehmet — 'çekmecede 1.180 ₺'" → "Gördüm" → `gorundu` |
| `cihaz_yok` | aktif personelin aktif telefonu yok | "📱 Telefonu bağlı değil" → "Bağlantı linki üret" → `cihaz/davet` |
| `tablet_yok` / `tablet_onay` | aktif şubenin aktif tableti yok / davet onay bekliyor | "📟 Tablet kayıtsız" → davet · "Bu tablet Zafer'in mi?" → `cihaz/{id}/onayla` |
| `sube_konum_yok` | aktif şube lat/lng NULL | "📍 Koordinat yok" → Tanımlar › Şube |

Hiçbiri panele/telefona gitmez (K7 bilgi satırı telefonda `ben` cevabından çizilir, bildirim değil).

### B11. Merkez "Yemek molaları" sekmesi (Personel › Yemek molaları)

- Üst: tarih aralığı, şube, "yalnız bitmeyen", "yalnız hakkı düşen".
- Tablo: Tarih · Kişi · Şube · Başlangıç · Bitiş · Süre · Durum (bitti / sürüyor / bitmedi / merkez yazdı / çıkışla kapandı) · **Yemek hakkı** (✓ / ✗ / ✓ elle: kim, ne zaman) · Mesafe · Düzelt / Hakkı ver.
- Alt özet (ay): kişi → çalışılan gün, mola günü, ortalama süre, hak düşen gün, elle verilen (Maaş kalemiyle aynı sayılar — `yemek_hak_gunleri`).

### B12. 1 Kasım geçişi (sunucu kesimi + prova + geri dönüş)

| Ne | Ekim (deneme) | 1 Kasım 02:00 | Aralık |
|---|---|---|---|
| Yoklama yazımı | `yoklama` modülü gerçek yazar (deneme verisi faydalı); eski sistem de yazar | yalnız yeni | — |
| Eski uçlar (`gorev_api`: pin-giris, mesai-cikis, yemek, devir*, mühür, qr) | açık | **sunucuda kapalı**: `ey_ayar.yoklama_kesim` dolu → 410 `yeni_sisteme_gecildi` (sayfa kapatmak yetmez; API de kapanır) | sökülür |
| Eski telefon sayfası | sürer | yoklama/mola/devir düğmeleri "Yeni sisteme geçildi — paneldeki QR'ı okut" + `/q` köprüsü; sayfa K6 kurgusunda yeniden kurulur (görev/avans/sayım/puan) | — |
| Maaş okuma | eski `gorev_yoklama` | `donem_baslangic`'tan yeni (yemek K7 kuralıyla) | eski okuyucu silinir |
| 02:00 sınırı | — | Kesim `is_gunu` değişiminde: 31 Ekim iş günü (02:00'ye kadar) eski sistemde biter; 31 Ekim gecesi eski sistemde açık kalanlar eski oto-kapat ile **son kez** kapanır; 1 Kasım 02:00 sonrası ilk giriş yeni tabloya. Her yerde `cekirdek.is_gunu()` | — |
| **Geri dönüş** | — | `yoklama_kesim` ayarı silinir → eski uçlar 1 dk'da açılır, Maaş `donem_baslangic` ileri alınır; yeni tablo durur, veri kaybı yok. Karar penceresi: 1–3 Kasım | — |

**Kabul listesi (31 Ekim 23:00, kesim öncesi; biri eksikse kesim ertelenir):**
- [ ] 4 şube `ey_sube.lat/lng` dolu (kopya + Tanımlar'da göz kontrolü) → `sube_konum_yok` = 0
- [ ] Tüm aktif personel `ey_cihaz` aktif, `guc='anahtar'` (zayıf bağ listesi sahibe gösterilir) → `cihaz_yok` = 0
- [ ] 4 tablet kayıtlı ve onaylı → `tablet_yok` = 0; her tablette QR 30 sn'de yenileniyor
- [ ] Prova (28–30 Ekim, Zafer, gerçek cihazlar): giriş · 200 m dışı 403 · 3 dk önceki QR 409 · aynı QR ikinci işlem 409 · mola 61 dk → telefonda satır + Bekleyen iş · devir çift onay + sürüm değişikliği 409 · kapanış → çıkış · 02:00 sonrası giriş doğru güne
- [ ] `kapi_kontrol.py` + Codex + Fable; yayın 23:45–00:15 dışında (kesim ayarı 1 Kasım 02:05'te elle açılır)

Ekim verisi taşınmaz (içerik kopyası yalnız şube koordinatı + yönetici işareti).

### B13. Riskler

| Risk | Karşılık |
|---|---|
| GPS kapalı mekânda 50-150 m sapar | 150 m yarıçap; mesafe kaydedilir; engel yalnız gerçekten uzaksa |
| QR fotoğrafı + sahte konum (60–120 sn) | B5 kalan risk: tek kullanım + Son okutanlar + ip_disi damgası + merkez görür; tam engel yok, **kabul edilen risk** |
| localStorage/jeton kopyalama | Cihaz anahtarı dışarı çıkarılamaz (B4.1); zayıf bağ yalnız istisna ve etiketli |
| iOS Safari konum izni her açılışta | "Ana ekrana ekle" ipucu; IndexedDB ana ekran kabında ayrı → bağlama o kaptan yapılır (tek cümle ipucu) |
| Tarayıcı verisi silinir → bağ kopar | yeni davet, şubede QR'la (K9); Bekleyen iş `cihaz_yok` |
| Telefon ödünç verilir | kimlik = telefon; QR + konum + Son okutanlar + merkez düzeltme |
| Tablet/sunucu saat farkı | jeton sunucu saatiyle; imza zaman payı ±120 sn; tablet 30 sn'de yeni PNG |
| Devreden onaylamadan gider | `hazir` kalır → Bekleyen iş → merkez-kapat; kapanış devir şartı değil |
| Kapanışçı QR girişi yapmadı | sunucu 400; kişi QR okutur, sonra kapanır |
| Aynı anda iki şubede giriş | kısmi UNIQUE engeller (K11): önce çıkış |
| 02:00 iş günü sınırı | `cekirdek.is_gunu()`; 01:30 girişi önceki güne; kesim 02:00'de |
| `olay_yaz` 503 | devir tamam/tutmuyor tek işlem; olay yazılamazsa durum değişmez, telefon "tekrar dene" (aynı `istek_id`) |
| Yemek paydası küçük (3 gün çalışan, 1 ihlal) | sahip bilinen açık madde (yemek kuralı belleği); merkez elle hak verebilir |

### B14. Boyut / kabul

| Faz | Boyut | Kabul ölçütü |
|---|---|---|
| Y0 | ~600 py + ~600 jsx (imza kütüphanesi dahil) | şubede QR'la bağlanan telefon giriş yapar; kopyalanan localStorage ile ikinci cihaz 403; 200 m dışı 403 (muaf kişi geçer); 3 dk önceki QR 409; aynı QR ikinci giriş 409; kayıtsız tablet QR alamaz; panel QR kapısı girişle kapanır; Son okutanlar 2 sn içinde |
| Y1 | ~300 py + ~350 jsx | mola başlat/bitir; aynı iş günü ikinci mola 409; 61 dk → `yemek_hakki=FALSE` + telefon satırı + Bekleyen iş; çıkış/kapanış açık molayı kapatır; merkez "hakkı ver" izli; Maaş kalemi `24/25` doğru |
| Y2 | ~350 py + ~350 jsx | devir: onay yalnız doğru cihazdan; sürüm değişince 409; tamam/tutmuyor → 1 olay + devreden çıkış + sorumlu devralan (tutmuyor dahil); merkez-kapat ekranda "merkez kapattı" |
| Y3 | ~120 py | eski uçlar 410; geri dönüş anahtarı denendi; Takvim/Günlük yoklama 1 Kasım'dan yeni; 31 Ekim ↔ 1 Kasım kişi sayıları tutarlı |

---

## C. SAHİP KARARLARI (2026-10-18) — KARARLAŞTI
| # | Karar |
|---|---|
| K1 | ✅ Telefon bağlama: **merkez kişiye özel tek kullanımlık link** (48 saat) üretir, WhatsApp'tan gönderilir |
| K2 | ✅ (sahip düzeltti) Konum muafiyeti **KALIR**: yönetici olarak işaretli kişi konumsuz giriş/çıkış yapabilir (ey_personel'de işaret; eski içerik bir kez) |
| K3 | ✅ Koordinatsız şube: giriş serbest + merkez "koordinat eksik". **4 şubenin koordinatı sistemde VAR** (eski şube kartı) → ey_sube'ye içerik olarak bir kez kopyalanır |
| K4 | ✅ Aynı gün ikinci giriş **açılır** (ayrı satır, süreler toplanır) |
| K5 | ✅ "Tutmuyor": devir **tamamlanır** + merkez "⚠ Devir tutmuyor" |
| K6 | ✅ (sahip) **Eski telefon sayfası YENİDEN KURULACAK** (yapılacak işler listesinde); **avans talebi oradan yapılır**; görev listesi / stok sayım görevi / puan o kurguda ele alınır |
| K7 | ✅ (sahip düzeltti) Mola **60 dk'yı geçerse**: merkezde "uzun" bildirimi + **personelin telefonunda "Bugün yemek hakkı kazanılamadı"** + **maaş hesabında o günün yemek ücreti hakkı düşer** (aylık 7.000 ₺'nin o güne düşen payı; Maaş modülü bu işareti okur) |

Bekleyen: **K8–K11** (§A5).

---

## D. CODEX BULGULARI → ÇÖZÜM (`tmp/codex_panelA_out.txt` §2)

| # | Codex bulgusu | Çözüm (bölüm) |
|---|---|---|
| D1 BLOKER | QR üretim uçları açık; uzaktan QR alınabilir; fotoğraf + sahte konum | QR ucu yalnız **kayıtlı tabletin imzalı isteğine** (B4.6, B5); jeton+kişi+işlem tek kullanım (`ey_qr_kullanim`); panel **Son okutanlar**; K10 şube IP `ip_disi` damgası; kalan risk açıkça kabul (B5, B13) |
| D2 BLOKER | localStorage jetonu kopyalanır; davet linki "kendi telefonu" kanıtı değil | **Cihaza bağlı anahtar** (WebCrypto P-256, çıkarılamaz, IndexedDB; sunucuda açık anahtar; her istek nonce+zaman imzalı, tekrar-oynatma kilidi); zayıf-bağ istisnası etiketli; iptal/yeniden davet; bağlama **şubede tablet QR + konumla** (B4) |
| D3 | Zaman damgalı UNIQUE iki açık girişi engellemez; devir onayında `istek_id` yok; form↔onay yarışı | Kısmi UNIQUE `(personel_id) WHERE cikis_ts IS NULL`; `FOR UPDATE`; her telefon yazımında `istek_id UNIQUE` (devret/kabul dahil); devir `surum` özeti — onay sürüme bağlı, değişince 409 (B3, B7, B8) |
| D4 | Sorumlu yalnız `tamam`'dan; K5 `tutmuyor` dışarıda; girmemiş devralan seçilemiyor | `kapanis_sorumlusu` = `tamam` **veya** `tutmuyor` (veya merkez kapandı); devralan listesi = girenler + girmemiş aktif; **kabul = giriş** (B2, B7, B8) |
| D5 | Merkez "Tamam say" kişi onayı yerine geçer | Ayrı durum `merkez_kapatti` + `merkez_sonuc/kim/aciklama`; olay verisi `merkez_istisna=TRUE`; ekranda "merkez kapattı" (B7, B8) |
| D6 | Mola/yoklama satırı → K4 ile günde iki mola; çıkışın molayı kapatması tanımsız | `ey_mola` UNIQUE(personel_id, is_gunu); `cikis_yaz` (qr/devir/kapanış/merkez) açık molayı aynı anda kapatır, süre+hak o anda hesaplanır (B2, B3, B7) |
| D7 | Canlı `vardiya_atama` bağı köprü; `try/import` kapalı modülü algılamaz | `vardiya_atama` okunmaz, plan sütunu EY plan kaynağı gelene kadar "—"; modül denetimi `moduller.DURUM["yoklama"]=="yuklendi"` (B1, B2, B9) |
| D8 | Çıkışsız kayıt 7 gün sonra kaybolur; bazı merkez düğmelerinin ucu yok | Bekleyen işler çözülene kadar kalır (tarih sınırı yok); her düğme → tanımlı uç tablosu (B7 merkez, B10) |
| D9 | 1 Kasım: sayfa kapatmak API yazımını durdurmaz; 02:00, gece açık kayıtlar, geri dönüş, K6 eksik | `ey_ayar.yoklama_kesim` → eski yazım uçları 410; kesim 02:00 `is_gunu` sınırında; eski oto-kapat son kez; geri dönüş anahtarı + pencere; gerçek cihaz provası 28–30 Ekim; kabul listesi (koordinat, telefon, tablet) (A4, B12) |
| D10 KÜÇÜK | Ömür "2 dk" değil 60–120 sn; saat eşitlemesi | Metin 60–120 sn; sınır testi (59 sn ✓ / 121 sn ✗); üretim+doğrulama+imza zamanı **sunucu saati** (B5) |

## E. SAHİP KARARLARI — 2. tur (2026-10-18)
| # | Karar |
|---|---|
| K8 | ✅ (maaş etkisi sahip onaylı 2026-10-18: 1 Kasım'dan yemek ücreti = yalnız mola kullanılan ≤60 dk günler) **Molasız gün yemek hakkı KAZANILMAZ** — hak yalnız mola kullanılan (≤60 dk) günlerde; 61. dk'dan itibaren de yok (merkez elle verebilir, izli) |
| K9 | ✅ Telefon bağlama **uzaktan da olur** — merkezin linkini açmak yeterli (şubede tablet QR şartı YOK) |
| K10 | ✅ Şube Wi-Fi/IP **kullanılmaz** — yalnız konum |
| K11 | ✅ Aynı anda iki şubede girişli olunamaz — önce çıkış; aynı gün ikinci şubeye giriş serbest |
