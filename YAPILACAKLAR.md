# 📋 YAPILACAK İŞLER — Evvel Yeni YOL HARİTASI (canlı liste)

> Sahip (2026-10-18): "Bütün işlemler bitince yarım kalan işleri tamamen baştan sona listele, eksiksiz." ·
> "İş sıralamasında dağılırsak yönümüzü kaybederiz; yapalım bütün gerekenleri ama **geri dönebilmeyi unutmayalım**."
> Kural: her yan işe dalarken aşağıdaki **📍 ŞU AN** satırı güncellenir; yan iş bitince **↩ DÖNÜŞ** satırındaki yere dönülür.
> Her iş bitince ✅ ile işaretlenir, silinmez. Tasarımlar: SUBE_PANELI_TASARIM.md · YOKLAMA_QR_TASARIM.md · SIPARIS_TASARIM.md ·
> ESKI_OZELLIK_ENVANTERI.md · KESIM_LISTESI.md.

## 📍 ŞU AN / ↩ DÖNÜŞ

| | |
|---|---|
| **Ana yol** | Sipariş Faz 1 (A) → adım **1b** "okuyucular yeni kataloğa" |
| **1b'den dalınan yan yol** | Yeni Şube Paneli (B) — çünkü eski panel eski kimlik yazıyor; okuyucuların yeni kataloğa geçmesi panelin yeni sisteme yazmasını gerektirdi |
| **📍 Şu an** | B4 — QR telefon / yoklama modülü (Y0) |
| **↩ B bitince dönüş** | B14 (okuyucular yeni panel verisine — 1b'nin asıl işi) → A 1d/1e (sipariş tabloları + merkez "Sevk et") → C listesindeki "Bende" işleri → D1 envanter 21. madde |

## A. ANA YOL — Sipariş Faz 1

| Adım | İş | Durum |
|---|---|---|
| **1a** | Ürün kataloğu (sıfırdan, 128 ürün, birim/koli/fatura çevrimi/takip, fatura kanıtlı fiyatlar, KDV düzeltmeleri) | ✅ bitti |
| **1b** | Beş okuyucunun (Depo, Toptancılar, Bar, Gider, Satış) yeni kataloğa bağlanması | 🟡 **sürüyor** → B üzerinden (B14'te tamamlanır) |
| **1c** | İkiz "ürün aç" çözücüsü · şube tanımına depo işareti | 🟡 depo işareti ✅; çözücü okuyucular yeni olaya geçince silinecek (B14) |
| 1d | Sipariş tabloları (talep · kalem · yönlendirme · sevk partisi) | ⏳ |
| 1e | Depo "hareket yaz" + hayalet sevk freni + merkez **"Sevk et"** + Hazırlık | 🟡 hareket_yaz ✅ · Sevk et ⏳ (**1 Kasım'dan önce şart**) |
| 1f | Hasarlı kabul · toptancı teslimi tek işlem | ⏳ (panel "Teslim al" ile, B9) |

## B. YENİ ŞUBE PANELİ (1b'nin içinden) — 1 Kasım'da şubeler geçer

| # | İş | Durum |
|---|---|---|
| B1 | Faz 0 altyapı: ey_ayar, şube depo işareti, Depo/Toptancı/Kasa PUBLIC servisleri | ✅ |
| B2 | Faz 1: açılış · kapanış · kasa devri · ara teslim · ürün aç · fire (deneme modunda yayında) | ✅ |
| B3 | Sahip kararları D2/D6/D7/D9/D10 + kapanış kaybolmasın (deneme kaydı + geç kapanış) | ✅ yayında — son düzeltme Codex'e tekrar gösterilecek |
| B4 | **QR telefon / yoklama modülü** Y0: şube koordinatı + telefon bağlama linki + giriş/çıkış + dönen QR + panel QR kapısı + "Bugün girenler" | 🟡 **📍 yazılıyor** |
| B5 | Y1: yemek molası + merkez "Yemek molaları" sekmesi + 61. dk / molasız gün hak yok + maaş yemek kalemi + merkez elle hak verir | ⏳ |
| B6 | Y2: kasa devri çift onay (iki telefon) · "tutmuyor" → merkez | ⏳ |
| B7 | Konum muafiyeti (yönetici) + erken açılış izni — Tanımlar › Personel'de işaret | ⏳ |
| B8 | **Telefon sayfası yeniden kurulacak** (avans talebi buradan; puan + geri bildirim buraya) | ⏳ |
| B9 | Panel faz 2: Teslim al (+ fatura çek QR, eksik geldi) · Depodan gelen · Anlık gider (fiş var/yok) · Not/Mesaj | ⏳ |
| B10 | Panel küçükler (sahip: "sen bitir"): büyük sayı tuş takımı · ürün aç notu · ara teslim açıklaması · online = nakit+POS kontrolü | ⏳ |
| B11 | Panel "geri al" (yalnız son kayıt) · merkez bildirimleri: fiyatı eksik ürün açıldı / stok eksiye düştü / saat dışı | ⏳ |
| B12 | Toptancılar › Ürün fiyatları yeni katalogdan · fiyat geçmişi teslim kaynaklı | ⏳ |
| B13 | Toptancı açılış borcu dönemle (1 Kasım öncesi sayılmaz) | ⏳ |
| B14 | Merkez okuyucuları yeni panel verisine: Depo (senkron köprüsü kalkar), Bar, Satış/Devir defteri, Gider, Kasa köprüleri — **1b'nin asıl işi** | ⏳ |
| B15 | 31 Ekim: eski sistemde açık sevklerin kapatılması · personel telefonlarının bağlanması · tabletlerin kaydı · Zafer'de gerçek cihaz provası | ⏳ |
| B16 | **1 Kasım**: /donem + her şubede para + ürün açılış sayımı · panel deneme modundan çıkar · eski panel ve eski QR yazımı kapanır | ⏳ |
| B17 | Devirde 3 bardak katalog rolüyle sabitlensin · geçersiz form (422) deneme kaydına | ⏳ |

## C. 17 EKİM'DEKİ "YARIM KALANLAR" LİSTESİ (18 madde)

| # | İş | Kimde | Durum |
|---|---|---|---|
| 1 | Tema 15 Ekim 9.000 ₺ — teslim kaydı olmadan çıkmış; kim aldı? | Sahip | ⏳ cevap bekliyor |
| 2 | Dükkân farkları (Tema, Alsancak 5.565 ₺) teslim mi? Söylenmezse sabah sayımı "başlangıç farkı" kapattı | Sahip | ⏳ kontrol edilecek |
| 3 | Panel çift yazım ölçümü (yeni alana doğru yazılıyor mu) | Ben | ⏳ ölçülecek |
| 4 | İlk panel teslimi: "fatura geldi mi" + toptancı borcu kontrolü | Ben | ⏳ ölçülecek |
| 5 | Kartlar: kullanılabilir limit, yeni ekstre tutarı, son ödeme | Sahip | ⏳ |
| 6 | Kiralar: Zafer kirası, artış ayları, Tema Ağustos 180.000 | Sahip | 🟡 Ekim kiraları işlendi; diğerleri ⏳ |
| 7 | Toptancılar: vade günü ve açılış borcu | Sahip | ⏳ (1 Kasım net bakiyeyle) |
| 8 | Ürün fiyatı olmayan 1 ürün | — | ✅ yeni katalogda 128/128 fiyatlı |
| 9 | Bankalar: Eylül ekstreleri; Merve'nin VakıfBank ekstresi | Sahip | ⏳ |
| 10 | Zafer 13 Ekim gerçek POS rakamı | Sahip | ⏳ |
| 11 | Köyceğiz online komisyonu %0 doğru mu | Sahip | ⏳ |
| 12 | Alsancak paneli ve QR'ı kullanacak mı | Sahip | ⏳ (1 Kasım'da yeni panel) |
| 13 | 9 Ekim "2 paket sigara" 240 ₺ Onur'a yazılı — doğru mu | Sahip | ⏳ |
| 14 | 1 Kasım: evlerdeki nakit sayılacak (Onur, Fatma) | Sahip | ⏳ |
| 15 | Panel → yeni alan geçişi | Ben | 🟡 Yeni Şube Paneli ile (B) |
| 16 | Eski sistemin kaldırılması (1 Kasım sonrası) | Ben | ⏳ |
| 17 | Kasım maaşı: yeni hesap 1 Kasım'da başlıyor, sonunda kontrol | Ben | ⏳ (yemek kuralı değişti — B5) |
| 18 | Sipariş alanı | Ben | 🟡 A bölümü |

**Sonra ayrıntılandırılacaklar (17 Ekim):** Gider alanı · Toptancılar (iade, ekstreyle teyit, "fatura keser mi", FIFO, KDV ayrıştırma) · Günlük yoklama (geç kalma toleransı, vardiya planı) · Kasa devir defteri zincir uyarısı · kart / kira hatırlatmaları.

## D. ENVANTER / KESİM / YETKİ

| # | İş |
|---|---|
| D1 | ESKI_OZELLIK_ENVANTERI.md — **21. maddeden itibaren** kararlar (sahip) + verilen kararların uygulanması (KESIM_LISTESI) |
| D2 | Eski sistem sökümü (sube_panel, sube_operasyon, fire_bildirim, operasyon_defter, stok_yolda, siparis_urun …) — 1 Kasım sonrası |
| D3 | Giriş kapısı + kullanıcı tanımında yetki (rol × alt sekme × şube) — EN SON |
| D4 | Kira hesabı: evlerin tanımı |
