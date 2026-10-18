# 🧾 YENİ ŞUBE PANELİ — TASARIM (Evvel Yeni · 1 Kasım 2026 geçişi)

> **Sahip (bağlayıcı):** "Başla ama panelde öyle köklü değişiklikler yapma ve şu anda kurduğumuz sistemin de önemli bir parçasını atlama." ·
> "Kalite artacaksa panelin tasarımında revizyon olabilir — köklü değişiklik için dedim."
> → Varsayılan: personel **aynı akışı** görür (aynı sol menü, aynı düğmeler, aynı sıra). Her değişiklik **eski → yeni → somut kazanç** olarak yazılır;
> kazancı yazılamayan değişiklik yapılmaz. Hiçbir önemli parça (eski panelin günlük işlevleri + kurulu EY merkez modülleri) atlanmaz (A2 kontrol listesi).
> "Çıkar" yalnız ESKI_OZELLIK_ENVANTERI.md'deki sahip kararına atıfla; atıf yoksa "taşınır".
> Diğer kurallar: sıfırdan (eski tabloya köprü yok, ürün = ey_urun kimliği) · personele soru/uyarı yok (uyarılar yalnız merkez Bekleyen işler) · tak-çıkar modül ·
> EY altyapısının ÜZERİNE · giriş/yetki EN SONDA.
> Kaynaklar: sube_panel.html (15.102 satır; `/sube-panel/{id}`), sube_panel.py + sube_operasyon.py (`/api/sube-panel`), fire_bildirim.py, gorev_api.py, operasyon_defter.py,
> evvel_yeni_* (kasa/depo/toptanci/urun/bar/satis/gider/fis/avans/olay/cekirdek/moduller), ESKI_OZELLIK_ENVANTERI.md, KESIM_LISTESI.md, SIPARIS_TASARIM.md, memory/design_pos_ekran.md.

---

## A. SAHİP BÖLÜMÜ (1 sayfa)

### A1. Ekran ekran: eski → yeni → kazanç

| Eski panel ekranı | Yeni | Değişiklik (eski → yeni) | Somut kazanç |
|---|---|---|---|
| 🔒 **Kasa kilidi aç** (personel + PIN overlay) → sonra ☀️ **Açılış sihirbazı** (kasa → bardak → ürün → pasta → PIN) | ☀️ **Açılış** tek sihirbaz: personel seç → çekmece sayımı → bar sayımı → Kaydet | İki PIN'li katman tek akışa iner; PIN kalkar (yetki fazında geri gelir); süt litre kutusu kalkar | 2 ekran, 2 PIN az; litre (ondalık) hatası biter (süt zaten "ürün aç" ile izleniyor — Bar modülü kararı) |
| 🏠 **Ana sayfa** (gün çizgisi AÇILIŞ·KONTROL·KAPANIŞ, 4 düğme Fire/Ürün Aç/Gider/Not, dünkü kapanış bandı, stok alarmları, sipariş red listesi, alarm bip) | 🏠 Ana sayfa: aynı gün çizgisi + aynı 4 düğme + "Bugün kaydedilenler" listesi (geri al buradan) | Kırmızı bantlar, stok alarmı, bip/alarm sayacı kalkar; yerine bugünkü kayıt listesi | Personel soru/uyarı görmez (sahip kuralı; envanter karar 19 onay kuyruğu → Bekleyen işler); yanlış kaydı aynı yerden geri alır |
| 🌙 **Günü Kapat** (5 adım: X raporu/ciro → teslim+kör sayım+devir → ürün aç kontrolü (confirm) → bar sayımı → QR mühür; 22:30 kilidi; sonuç kartı "EKSİK VAR") | 🌙 Kapanış 4 adım: ciro (nakit/POS/online) → teslim (kime, kaç ₺) + çekmecede bırakılan → bar sayımı → Kaydet (personel seçili) | "Ürün aç kaydı yok" sorusu, QR mühür adımı, "eksik var" kartı, saat kilidi kalkar; kör sayım + bırakılan aynı adımda | 1 adım + 1 soru az; "MÜHÜRSÜZ" kapanışlar biter; eksikler merkez Bekleyen işler'de (mevcut `_eksik_kapanislar`); karar 1-a, 19, 45 |
| 💵 **Kasa Devri** (gorev devir formu: devreden/devralan + sayım; telefondan onay) + KONTROL/ÇIKIŞ kasa sayımı (PIN) | 💵 Kasa Devri: devreden → devralan → sayılan → Kaydet | Telefon onayı ve PIN kalkar; tek form | Devir 1 dakikaya iner; Satış › Devir defteri aynen okur |
| 💰 **Ara Teslim** (tutar, alıcı, PIN) | Aynı | PIN kalkar | — |
| 📦 **Tedarikçiden Gelen — Teslim Al** (POS kartları, +/−, tedarikçi, fatura geldi mi?, tutar/no, fatura foto, PIN) | Aynı ekran + **koli yardımcısı** ("2 koli × 12 + 3") | PIN kalkar; faturada koli/adet gelen ürün için çevrim kutusu | Koli/adet karışması (sipariş denetimi 09-14 KÖK NEDEN) kayda girmez; toptancı borcu + depo girişi tek işlemde |
| 🚚 **Depodan Gelen — Teslim Al** (kart kart +/−, Kabul) | Aynı | PIN kalkar | — |
| 🛒 Sipariş Ver · 📊 Sipariş Takip · 📤 Gönderilecek · Eksik Ürünler | Aynı ekranlar, **eski akışa yazmaya devam** (SIPARIS_TASARIM faz 2'ye kadar) | Yok | — |
| 🔓 **Ürün Aç** (kategori → ürün → adet; taslak otomatik kayıt; "kullanımda / bitti" listesi; PIN; 60 sn çift gönderim 409) | 🔓 Ürün Aç: yalnız "açılınca" takipli ürünler, büyük kartlar, +/− 72px, Kaydet | Taslak, "kullanımda/bitti" listesi, PIN kalkar | Aynı paket iki kez sayılmaz (Gider/Bar [BİTTİ] hariç tutuyordu); sahip 2026-10-18: "her açtığı pakette maliyet var" |
| 🔥 **Fire Bildirimi** (sebep → kalemler → açıklama → PIN; foto) | Aynı sıra; PIN kalkar; foto 2. faz | — | — |
| 💸 **Anlık Gider** (kategori, tutar, açıklama, PIN → "merkeze onaya gönder") | Aynı + **"fişi var / yok"** düğmesi | PIN ve "onay" sözü kalkar; fiş bilgisi eklenir | Fiş kontrol (kurulu EY modülü) personelin beyanıyla başlar; karar 6 |
| 📝 Merkez Notu · 📩 Mesajlar · Operasyon Geri Bildirimi · ⭐ Puanım · 📱 QR vardiya girişi | Aynı | Yok | — |
| 📷 X Raporu OCR | Kalır (eski uç) — ciro kutuları elle de girilebilir | Yok | — |

### A2. Kontrol listesi — hiçbir parça atlanmadı

| Mevcut özellik (eski panel / EY) | Yeni yeri | Durum |
|---|---|---|
| Kasa kilidi aç + açılış kasa sayımı | Panel Açılış → Kasa `sayim` | taşındı |
| Açılış bar sayımı (bardak, su, redbull, soda, cookie, pasta) | Panel Açılış → Depo sayım (katalog takip='sayim') | taşındı |
| Süt litre sayımı | — | çıkar (Bar modülü kararı 2026-10-16: süt sayılmaz, ürün aç ile; katalog birimi tam sayı) |
| Kapanış ciro nakit/POS/online | Kasa `kapanis` → Gelir | taşındı |
| Gün sonu teslim + ara teslim (alıcı Onur/Fethi/Fatma) | Kasa `teslim` (aynı gün kabul, 7 gün Düzelt — mevcut) | taşındı |
| Kör kasa sayımı + bırakılan (devir) | olay verisi; Satış › Kasa sağlaması (mevcut) | aynen |
| Kapanış mutabakat/fark hesabı | Satış › Kasa sağlaması + Bekleyen işler (personele gösterilmez) | taşındı merkeze (karar 1-a, 19) |
| KONTROL / ÇIKIŞ kasa sayımı + Kasa Devri formu | Panel Kasa Devri → olay vardiya; Satış › Devir defteri | taşındı |
| Kapanış QR mührü | personel seçimi; QR yoklama ayrı sayfada kalır | taşındı (sade) |
| 22:30 saat kilidi, 07:00 kuralı, alarm bip, geç kapanış toast | Bekleyen işler "geç kapanış" (mevcut gec-kapanis ucu) | taşındı merkeze (karar 19; uyarılar ayrı sekme kuralı) |
| Kapanış bar sayımı | Depo günlük sayım → Bar + Satış | taşındı |
| Ürün aç ("açılınca") | Depo `ac`; Gider = adet × güncel fiyat | taşındı |
| Kullanıma al / Bitti ("bitince" ürünler) | — | çıkar (sahip 2026-10-18 takip kararı: 'acilinca' = açılınca gider) |
| Ürün aç taslağı + SİSTEM notu | — | çıkar (sahip: karışıklık varsa kaldır; taslak = yarım kayıt kaynağı) |
| Stok ekle (URUN_STOK_EKLE) | — | çıkar (HTML'de çağrısı yok, ölü uç) |
| Tedarikçiden teslim al (fatura geldi mi, tutar, no) | ey_toptanci_teslim + Depo `giris` tek işlem | taşındı |
| Fatura fotoğrafı | ey_toptanci_teslim'e ek (faz 2) | taşınır (sonraya; envanter F30: foto/PDF kalır, OCR çıkar) |
| Teslim geri al (personel PIN + işletme PIN) | personel: aynı gün Geri al; merkez: Toptancılar › teslim iptal (mevcut) | taşındı |
| Depodan gelen kabul / fazla / eksik / hasarlı / merkez adına kabul | Depo `kabul` + askıda + fark çöz (mevcut) | aynen |
| Gönderilecek siparişler (Tema depo sevk) | eski akış; faz 2'de Depo `sevk` (SIPARIS_TASARIM) | sonraya (ekran kalır) |
| Sipariş Ver / Takip / özel talep / Eksik ürünler | eski akış, aynı ekranlar | sonraya (ekran kalır) |
| Fire (11 sebep, iade fiş no) | Depo `fire` (sebep olay verisinde) | taşındı |
| Fire fotoğrafı | — | taşınır (faz 2) |
| Anlık gider | Kasa `odeme` dukkan_gideri → Fiş kontrol | taşındı |
| Anlık gider onay kuyruğu | — | çıkar (karar 6, 19) |
| Avans (panelde yoktu; QR sayfası talep) | EY Avans modülü; talep doğrudan EY (KESIM 25) | aynen |
| Merkez notu / mesaj / okundu / geri bildirim / puan | ey_sube_olay not/mesaj; EY Bekleyen işler › İşletme | taşındı |
| QR yoklama · vardiya planı · yoklamadan kasa aç (bozuk uç) | ayrı sayfa, KESIM 17 ayrı taşıma | aynen |
| X raporu OCR | eski uç kalır, elle giriş de var | aynen |
| Değirmen sayacı (kapanış içinde) | — | sahip kararı bekliyor (envanter D-F26 reçete) |
| Sayım kilidi (merkez sayım sürerken panel donar) | Depo sayım konum kilidi (advisory) — panel donmaz | taşındı (sade) |
| PIN kimliği (personel_panel_auth) | ad seçimi; PIN/giriş yetki fazında | sonraya (sahip: en sonda) |
| Panel çift yazımı (ey_sube_olay) | tek yazım = yeni panel | aynen |
| EY merkez: Kasa, Gelir, Gider, Kazanç, Ödeme, Kart, Kredi, Kira, Mülk, Fatura dağıt, Toptancılar (teslim/fiyat), Depo (sayım/kabul/fark/yolda), Bar, Satış/Devir, Fiş kontrol, Avans, Maaş, Tanımlar, Ürünler, Bekleyen işler | dokunulmaz; okuma kaynağı yeni panele döner (B4) | aynen |

### A3. Takvim

| Faz | Ne | Ne zaman |
|---|---|---|
| 0 | Katalog tamam (her ürüne takip/birim/koli/fiyat) · şube "depo" bayrağı · PUBLIC servisler | 19–22 Ekim |
| 1 | Açılış · Kapanış · Kasa Devri · Ara teslim · Ürün Aç · Fire (eskiyle yan yana, aynı adres kalıbı) | 22–26 Ekim |
| 2 | Tedarikçiden / Depodan teslim al · Anlık gider · Not/Mesaj · merkez "Sevk et" | 26–29 Ekim |
| 3 | Merkez modülleri yalnız yeni defteri okur; köprüler kapanır | 30–31 Ekim |
| 4 | **1 Kasım sabah: para + ürün açılış sayımı → sıfırdan**; eski panel kapanır | 1 Kasım |
| 5 | Sipariş altı (faz 2) · giriş/yetki · eski kod sökümü · fatura/fire foto | Kasım |

### A4. Sahip kararları (2026-10-18 — KARARLAŞTI)
1. **Sayılan ürünlerin (bardak, peçete) gideri** → ✅ günlük sayım düşüşü (dünkü sayım + gelen − bugünkü sayım) × güncel fiyat.
2. **Teslim "kime"** → ✅ yalnız Onur / Fethi / Fatma.
3. **PIN** → ✅ yetki fazına kadar ad seçimi yeter.
4. **Bardak sayım birimi** → ✅ ADET (katalogda işli).
5. **Değirmen sayacı** → ✅ KALIR (sahip "sence" dedi; öneri: tek sayı, kahve kaçağı kontrolünün tek yolu, geçmişi kaybolmasın; reçete kararı F26 sonra).

---

## B. TEKNİK EK

### B1. Eski eylem → eski yazdığı → yeni yazdığı (Explore envanteri, sube_panel.py satırları)

| Eski eylem | Eski yazdığı | Yeni |
|---|---|---|
| kasa-kilit-ac (:862) + acilis (:1232) / event ACILIS (sube_operasyon:784) | sube_kasa_gun_acma, sube_acilis, sube_operasyon_event ACILIS (kasa_sayim, meta.acilis_stok_sayim), sube_operasyon_uyari, onay_kuyrugu, personel_risk_sinyal, defter ACILIS_TAMAM, olay acilis | olay acilis · Kasa `sayim` · Depo sayım |
| event KAPANIS (sube_operasyon:1146-1688) | ciro taslak (KAPANIS_TASLAK), event UPDATE, uyarılar, onay_kuyrugu, risk, kasa_teslim gun_sonu (otomatik!), panel_teslim_esle, stok motoru, olay kapanis | olay kapanis · Kasa `kapanis` + `teslim` · Depo günlük sayım |
| kapanis-geri-al (:653) | kapanis_kayit, kasa_teslim DELETE, olay iptal | Kasa iptal + Depo iptal + olay iptal (silme yok) |
| KONTROL/CIKIS (sube_operasyon:1065/1690), gorev devir-form (gorev_api:852) | event, kasa_devir_onay | olay vardiya |
| ara-kasa-teslim (:2703) | kasa_teslim ara, olay teslim, panel_teslim_esle | Kasa `teslim` |
| urun-ac (:4291), urun-bitti (:4691), urun-ac/taslak | sube_depo_stok, sube_kullanimda_urun, urun_ac_taslak, defter URUN_AC/URUN_KULLANIMA_AL, olay | Depo `ac` |
| urun-sevk (:3235) | defter URUN_SEVK, sube_depo_stok, toptanci_siparis, siparis_talep, merkez_stok_sevk, siparis_sevk_eksik, belge talebi, ey_toptanci_teslim (kanca, hata yutar) | ey_toptanci_teslim + Depo `giris` tek işlem |
| urun-sevk-geri-al (:3968) | defter URUN_SEVK_IPTAL, stok çıkış, teslim iptal | teslim iptal + hareket iptal |
| siparis-teslim-kabul (:5743) | stok_yolda, sube_depo_stok, siparis_talep | Depo `kabul` (mevcut) |
| fire-bildir (:3060) | sube_depo_stok(_hareket), sube_fire_bildirim, defter SUBE_FIRE, olay fire | Depo `fire` |
| anlik-gider (:2805) | anlik_giderler (onay_bekliyor), onay_kuyrugu, olay gider | Kasa `odeme` |
| merkez-not, merkez-mesaj/oku | sube_merkez_not/mesaj | olay not/mesaj |
| siparis-onay, siparis-ozel-talep, siparis-depo-sevkiyat-kaydet | siparis_* | eski akış (faz 2'ye kadar) |

### B2. Modül: `panel` (tak-çıkar)
- Manifest: `{"kod":"panel","ad":"Şube paneli","ikon":"🧾","sektor":"genel","gerekir":["kasa","tanim","urun","depo","toptanci","olay"],"menu":False}`.
- `evvel_yeni_panel_api.py` → `/api/evvel-yeni/panel/{sube_id}/*`. Eski tablo okumaz/yazmaz. Ham olay = **ey_sube_olay** (`olay_yaz`; `kaynak_tablo='panel'`), yeni tablo yok.
- Ön yüz `src/pages/subepanel/` (eski CSS/yerleşim taşınır, React'e bölünür), adres `/panel/{sube_id}` (eski `/sube-panel/{id}` kalıbı; `?sube=` de tanınır). EY menüsünde görünmez.
- Çekirdek: `bekleyen_is_kaydet("panel", …)` → bugün kapanış yok · fiyatı eksik ürün açıldı · stok eksiye düştü · geç kapanış. Personele gitmez.
- Eklenecek PUBLIC servisler (aynı örüntü): Depo `hareket_yaz`/`sayim_yaz`/`bakiye` · Toptancı `guncel_fiyat(cur, urun_id, gun)` (en yeni kesin teslim fiyatı → ey_urun_fiyat → None) · Kasa `kasa_yaz(cur, body)` (uçtaki doğrulama+kilit+yazma; `panel_kapanis_yaz`/`panel_teslim_esle` yerine) · Tanım `ey_sube.depo`.

### B3. Eylem bazlı veri modeli (tek transaction, aynı imleç, `cekirdek.kilit`)
Ortak: sube_id=ey_sube.id · urun_id=ey_urun.id · adet INT sayım biriminde · kuruş BIGINT · is_gunu=`bugun()` · kim=ey_personel (ad+id) · `istek_id` (tekrar gönderim ikinci kez yazılmaz; eski 60 sn 409 kalkar).

| Eylem | kaynak_ref | Yazılanlar |
|---|---|---|
| Açılış | `panel:acilis:{sube}:{gun}` | olay acilis(kasa_sayim, sayim[]) · Kasa `sayim` cep sube:{sube}, is_gunu gün−1, ref `sayim_acilis:{sube}:{gun}` (mevcut biçim; ilk = başlangıç) · Depo `sayim_yaz(depo:{sube}, tur='gunluk')` |
| Ürün aç | `panel:ac:{olay}:{i}` | olay urun_ac · Depo `ac` depo:{sube}→dışarı:tuketim. Fiyat yazılmaz; Gider `guncel_fiyat × adet` (yoksa "fiyatı eksik" → Bekleyen iş). Eksi bakiye engellenmez, uyarı merkeze |
| Tedarikçiden teslim | `panel:teslim:{olay}` | olay teslim_toptanci · `toptanci.teslim_yaz(kaynak_ref=taban, kalemler[{urun_id, adet}], kesin_tutar, fatura_geldi, fatura_no, teslim_alan)` · Depo `giris` `taban:{i}` dışarı:toptanci→depo:{sube}. Koli yardımcısı → sayım birimi. Hata → 503, hiçbiri yazılmaz |
| Depodan gelen | `yolda:{bag}:kabul` | Depo `kabul` (mevcut); fazla→askida; 0 kabul gerçek. `bag` = merkez "Sevk et" (`sevk` depo:sube-tema→yolda) ya da faz 2'ye kadar eski stok_yolda id |
| Fire | `panel:fire:{olay}:{i}` | olay fire(sebep, fis_no) · Depo `fire` |
| Anlık gider | `panel:gider:{olay}` | olay gider · Kasa `odeme` veri={aciklama, kimin, parcalar:[{cep:sube:{sube}, tutar}], kaynak:'dukkan_gideri', giren_id, giren, fis:bool} → `dukkan_giderleri` `panel:gider:` ön ekini sayar → Fiş kontrol |
| Ara teslim | `panel:ara:{olay}` | olay teslim · Kasa `teslim` sube→ev:{alan} |
| Kasa devri | `panel:vardiya:{olay}` | olay vardiya(devreden, devralan, sayılan, saat) |
| Kapanış | kök `panel:kapanis:{sube}:{gun}` (düzeltme = sürüm) | olay kapanis(nakit,pos,online,kor_sayim,teslimler,birakilan,sayim[]) · Kasa `kapanis` ref `kapanis:{sube}:{gun}` tutar=nakit veri{pos,online,kart,birakilan} bekliyor · Kasa `teslim` `{kök}:teslim:{i}` · Depo `sayim_yaz(tur='gunluk')`: takip='sayim' ürünler; **fark<0 → `tuketim`** depo→dışarı:tuketim (bardak satışı; Gider/Satış okur) · **fark>0 → `sayim`** dışarı:sayim→depo; sayılmayan 0 sayılmaz · kör sayım Kasa'ya yazılmaz (mevcut karar) |
| Geri al | `panel:iptal:{hedef_kok}` | olay iptal · Kasa `iptal` (sayım kilidi 409 → merkeze düşer) · Depo iptal=TRUE. Personel yalnız bugün/dün |

Ürün aç maliyeti tek kural: `guncel_fiyat` (kuruş / 1 sayım birimi, KDV dahil; fatura fiyatı `urun.birim_maliyet()` ile çevrilir); Gider okuma anında hesaplar. Şube stoğu tek konum `depo:{sube}`; Tema `depo:sube-tema` (mevcut).

### B4. 1 Kasım'dan merkez modülleri yalnız yeni veriyi okur

| Modül | Bugünkü eski okuma | 1 Kasım'dan | Ekim verisi |
|---|---|---|---|
| Depo | `senkron()`: operasyon_defter, stok_yolda, sube_fire_bildirim, siparis_urun, sube_depo_stok | senkron silinir; `urun.urun_haritasi`/`katalog`; "eski" sütunu kalkar | Ekim hareketleri `arsiv=TRUE`; 1 Kasım açılış sayımı |
| Toptancılar | siparis_urun, urun_alis_fiyat, kalem_kdv_oran | `guncel_fiyat` + ey_urun | teslimler kalır; açılış bakiyesi (karar 7) |
| Bar | sube_operasyon_event meta, operasyon_defter, stok_yolda, ciro_taslak | ey_stok_sayim(gunluk) + ey_stok_hareket(tuketim/ac/giris) + olay kapanis; KALEMLER → katalog takip='sayim' | Ekim eski okuyucu salt okunur, Aralık'ta silinir |
| Satış / Devir | bar_ozet + Kasa + sube_operasyon_event, anlik_giderler, kasa_teslim | tuketim hareketleri + Kasa + olay (birakilan, vardiya) | aynı |
| Gider | operasyon_defter, urun_alis_fiyat, stok_yolda | Σ(ac+tuketim)×guncel_fiyat; sevk bedeli = Depo `sevk`×fiyat | Ekim eski okuyucu salt okunur |
| Kasa | ciro_taslak, kasa_teslim, anlik_giderler, personel_avans, sube_operasyon_event | köprü/kanca fonksiyonları silinir; tek kapı `kasa_yaz` | `POST /donem` 1 Kasım (önce kuru); Ekim arşiv |
| Fiş kontrol / Avans | anlik_giderler / personel_avans köprüleri | silinir | — |

Tek geçiş ayarı: `para_izi_ayar` → çekirdeğe `ey_ayar` (`donem_baslangic=2026-11-01`); Depo/Bar/Gider/Satış öncesini okumaz.

### B5. Cihaz / UX
Şube tableti yatay, açık tema (eski panel renk dili korunur), Türkçe. POS kuralı: düğme ≥72px, +/− 72×72, adet 32px, kategori kartı 140px, iki kolon %65/%35, <680px tek kolon. Kimlik: cihaz→şube (URL), personel = ad seçimi (büyük düğme, son seçilen hatırlanır; vardiya başında bir kez, her kayıtta değiştirilebilir); her satır sube_id+personel_id taşır → yetki fazında süzme sunucuda. Çevrimdışı kuyruk: istek_id ile. Hata tek cümle: "Kaydedilemedi, tekrar deneyin".

### B6. Fazlı plan

| Faz | İş | Boyut | Risk | Kabul |
|---|---|---|---|---|
| 0 | Katalog tamam · ey_sube.depo · ey_ayar · Depo/Toptancı/Kasa PUBLIC servisleri | ~600 py | PUBLIC ayırınca mevcut uç değişmesin | mevcut uçlar aynı cevap (Codex/Fable diff) |
| 1 | panel modülü: Açılış · Kapanış · Kasa Devri · Ara teslim · Ürün Aç · Fire + React kabuk | ~900 py + ~1.800 jsx | kapanış ref çakışması | aynı kapanış 2× → 1 kayıt; düzelt → sürüm 2; geri al → iptal |
| 2 | Teslim al (tek işlem) · Depodan gelen · Anlık gider · Not/Mesaj · merkez "Sevk et" | ~700 py + ~1.000 jsx | eski kanca hata yutuyordu | Depo yazılamazsa borç da yazılmaz (503); fazla/0 kabul |
| 3 | Okuyucular + Kasa yeni deftere; köprüler silinir | −2.500 satır | ürün kaybı | 31 Ekim eski↔yeni gün toplamı adet/kuruş eşit |
| 4 | 1 Kasım `/donem` + açılış sayımları + toptancı açılış; eski panel kapanır | işletme günü | sayımsız ürün aç | panel çalışır, Bekleyen iş "sayım yok" |
| 5 | Sipariş altı · giriş/yetki · foto · eski sube_panel/sube_operasyon/fire_bildirim/operasyon_defter/stok_yolda sökümü | ayrı plan | — | — |

Her faz yayın öncesi Codex + Fable; 23:45–00:15 deploy yok; `python scripts/kapi_kontrol.py`.


---

## C. CODEX DENETİMİ (2026-10-18) — tasarıma işlenenler

| # | Bulgu | Karar / düzeltme |
|---|---|---|
| C1 | **BLOKER — sipariş/sevk:** sipariş eski akışta kalıp 1 Kasım'da `stok_yolda` senkronu kesilirse eski akıştan çıkan sevk yeni depoya ulaşmaz; eski kimliği yeni ürüne bağlamak köprü kuralına aykırı | Merkez **"Sevk et"** (Depo `sevk` depo:sube-tema→yolda, ey_urun) + panel **"Depodan gelen"** (Depo `kabul`) **1 Kasım'dan ÖNCE** (faz 2'de) biter. Şube talebi eski ekranda kalsa da sevk YALNIZ yeni yoldan yapılır. 31 Ekim akşamı açık eski sevkler kapatılır (kabul / fark çöz) — kesim şartı. ✅ **Sahip onayladı (2026-10-18).** |
| C2 | **BLOKER — toptancı açılış borcu çift sayılabilir:** hesap bütün teslim + ödemeleri toplar; 1 Kasım net açılışı girilince Ekim hareketleri ikinci kez sayılır | Toptancı hesabı `ey_ayar.donem_baslangic`'tan ÖNCEKİ teslim/ödemeyi saymaz (arşiv, salt okunur); açılış = 1 Kasım net bakiye. Faz 3'te. |
| C3 | Önceki sayımı geri almak sonraki sayımı bozar (100→80→60; ilk düşüş iptal → 80) | Personel yalnız **son** sayımı geri alabilir; daha eski sayım düzeltmesi merkezde, sonraki sayımlar yeniden hesaplanarak (çıpa korunur). |
| C4 | Tema konum anahtarı `depo:tema` ↔ kod `depo:sube-tema` | Bütün konumlar gerçek `ey_sube.id` ile: `depo:sube-tema` (belge düzeltildi). |
| C5 | Fiyat geçmişi yok (`ey_toptanci_fiyat` satırı eziliyor), teslim iptali öğrenilmiş fiyatı geri almıyor | Faz 2: fiyat, teslim kaynaklı geçmiş olarak tutulur (tarih + iptal); `guncel_fiyat` oradan seçer. |
| C6 | Yeni ürünün fiyatı arayüzden girilemiyor (Ürün fiyatları eski kataloğu listeliyor) | Faz 0 sonu: Toptancılar › Ürün fiyatları yeni katalogdan (ey_urun) listelenir. 128 ürünün başlangıç fiyatı 2026-10-18 faturalardan girildi. |
| C7 | Sayım/hareket kilidi, sayım girdisi, kategori kilidi, KDV sınırı, ey_ayar bayrağı, eski katalog yazıcıları, manifest bağımlılıkları | **Düzeltildi ve yayında** (2026-10-18). |


## D. ESKİ PANEL DERİN ENVANTERİ (Fable + Codex, 2026-10-18) — sahip kararları
Kaynak: tmp/eski_panel_envanter_fable.md, tmp/eski_panel_envanter_codex.txt (85 özellik; ~26 "tasarımda yok").
| # | Konu | Karar |
|---|---|---|
| D1 | KONTROL (rastgele kör kasa sayımı + aktivite pingi + kilit/bip/alarm) | ✅ **OLMASIN** (sahip; Fable + Codex: sayım hiçbir şeyle karşılaştırılmıyordu, yalnız cevap süresi ölçülüyordu; alarm kuralına aykırı). Şüphede merkez habersiz yerinde sayar. |
| D2 | Kasa devrinde ürün sayımı | ✅ **Yalnız 3 bardak** (küçük, büyük, plastik) tek ekranda; ürün/pasta yok. Ara ölçüm gider üretmez; vardiya farkı yalnız merkezde (Codex önerisi, sahip onayı). |
| D3 | Mesai çıkışı kaydı (QR) | ⏳ sahip kararı bekliyor |
