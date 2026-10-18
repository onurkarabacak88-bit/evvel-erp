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
| **↩ B bitince dönüş** | B14 (okuyucular yeni panel verisine — 1b'nin asıl işi) → A 1d/1e (sipariş tabloları + merkez "Sevk et") → C listesindeki "Bende" işleri → D "olmalı mı?" sorgulaması (⏳ olanlar) |

## 🔗 İLİŞKİ HARİTASI — bölümler birbirine nasıl bağlı (sahip: "alanları birbiriyle ilişkilendir, kaybolmayalım")

```
                         ┌──────────── 1 KASIM (B16) ─────────────┐
                         │  her şey buraya akar: panel açılır,     │
                         │  eski sistem yazmayı bırakır, sıfırdan  │
                         └────────────────────────────────────────┘
   A. SİPARİŞ FAZ 1                B. YENİ ŞUBE PANELİ                 C. 17 EKİM 18 MADDE         D. "OLMALI MI?"
   1a Katalog ✅ ──────────────►  B2 panel ürünleri katalogdan         C8 fiyatsız ürün ✅         D20 Sipariş → A
   1b Okuyucular ──(gerektirdi)─► B (yeni panel) ── B14 ──► 1b biter   C15 panel geçişi = B        D22 Depo → B14
   1c Ürün-aç çözücü ◄──────────── B14'te silinir                      C17 Kasım maaşı ◄── B5      D23 Ürün aç → B2 ✅
   1e Sevk et ◄──── şart ──────── B9 "Depodan gelen" + B15             C18 Sipariş = A             D25 Fire → B3 ✅
   1f Teslim tek işlem ◄────────── B9 "Teslim al"                      C7 toptancı açılış ◄── B13  D26 değirmen → B2 ✅
                                   B4–B6 QR/yoklama ──────────────────►C12 Alsancak QR             D28 fiyatlar → B12
                                   B8 telefon sayfası ◄──── D35 avans · D38 puan · D24 sayım görevi · D37 görev listesi
                                   B10/B11 küçükler                    C14/C9 1 Kasım bakiyeleri   D36 vardiya planı → B4 (plan)
                                   B12 fiyat ekranı ◄──── 1a fiyatlar  ──► B16                     D40 risk → KONTROL yok ✅
                                                                                                    D44 WhatsApp → D10 ✅
```

| Bağ | Neden önemli |
|---|---|
| **A 1b ⇄ B** | Okuyucular (Depo/Bar/Gider/Satış/Toptancı) yeni kataloğa ancak panel yeni kimlikle yazınca geçebilir → B14 = 1b'nin bitişi |
| **A 1e "Sevk et" ⇄ B9 "Depodan gelen"** | Codex C1: 1 Kasım'dan sonra eski sevk yeni depoya ulaşmaz → ikisi BİRLİKTE, 1 Kasım öncesi |
| **B4–B6 QR ⇄ B5 maaş ⇄ C17 Kasım maaşı** | Yemek ücreti artık mola kaydından (K7/K8) → Kasım maaşı yeni QR kayıtlarına bağlı |
| **B8 telefon sayfası ⇄ D35/D38/D24/D37** | Avans, puan, sayım görevi, görev listesi kararları telefon sayfası kurgusunda birlikte verilir |
| **B12/B13 ⇄ C7, C14, C9** | Toptancı açılışı ve 1 Kasım net bakiyeler sahipten gelecek → B16 açılışının girdisi |
| **D "olmalı mı?" ⇄ E1 söküm** | Her ÇIKAR kararı eski kodun ve gece zinciri adımının sökümüne dönüşür (D59) |

**1 Kasım'a kritik yol (sıra):** B4 QR (Y0) → B5 mola → B6 devir onay → B9 teslim/depodan gelen **+ A 1e Sevk et** → B12 fiyat ekranı → B13 toptancı açılışı → B14 okuyucular (= **A 1b biter**) → B15 provalar → **B16 1 Kasım**. Sonra: A 1d sipariş tabloları → C "Bende" işleri → D sorgulaması (⏳) → E söküm → E2 yetki.

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
| B4 | **QR telefon / yoklama modülü** Y0 (yerleşim denetimi F1–F10: 5 mevcut okuyucunun KAYNAĞI değişir, ikinci okuyucu yok): şube koordinatı + telefon bağlama linki + giriş/çıkış + dönen QR + panel QR kapısı + "Bugün girenler" | 🟡 **📍 yazılıyor** |
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

## D. "EVVEL YENİ'DE OLMALI MI?" SORGULAMASI (ESKI_OZELLIK_ENVANTERI — 59 madde)

**1–20: karara bağlandı** (karar tablosu dosyanın sonunda; 20 = Sipariş zinciri TAŞI → A bölümü).
**21–59:** aşağıda. "Panelde verildi" = Yeni Şube Paneli konuşulurken sahip kararı çıktı; dosyaya resmî karar olarak işlenecek.

| # | Özellik | Durum |
|---|---|---|
| 21 | Sipariş kontrol kulesi | ⏳ sorulacak (öneri: Ç) |
| 22 | Depo stoğu | 🟡 EY Depo var — yeni panel verisine geçiş (B14) |
| 23 | Ürün aç / kullanılan ürün | ✅ panelde verildi: TAŞINDI (yeni panel, açılınca gider; "kullanımda/bitti" ÇIKAR) |
| 24 | Stok sayım görevi, demirbaş, arıza | ⏳ sorulacak (telefon sayfası kurgusunda — B8) |
| 25 | Fire bildirimi | ✅ panelde verildi: TAŞINDI (sebep kartları + iade; foto faz 2) |
| 26 | Reçete & değirmen sayacı | 🟡 değirmen sayacı KALIR (panelde verildi); reçete ⏳ sorulacak |
| 27 | Kâr & maliyet (P&L) | ⏳ sorulacak (öneri: Ç → Şube kazancı) |
| 28 | Alış fiyatları & zam takibi | 🟡 Ürün fiyatları yeni katalogda (B12); zam takibi ⏳ |
| 29 | Tedarikçi tanımları & sözleşmeler | ⏳ sorulacak (öneri: Ç → Tanımlar) |
| 30 | Fatura & belge merkezi | ⏳ sorulacak (öneri: D — teslimde fatura foto) |
| 31 | Belge talep | ⏳ sorulacak (öneri: Ç) |
| 32 | Tedarik mutabakatı | ⏳ sorulacak (öneri: Ç) |
| 33 | Stok tahmin & kayıp | ⏳ sorulacak (öneri: Ç) |
| 34 | Personel, maaş, bordro | 🟡 EY Personel; yemek kuralı değişti (B5) |
| 35 | Avans | ✅ TAŞINDI (EY Avans); talep yeni telefon sayfasından (B8) |
| 36 | Vardiya planlama | ⏳ sorulacak |
| 37 | Görev & QR yoklama | ✅ panelde verildi: YENİDEN KURULUYOR (B4–B6); görev listesi ⏳ (B8) |
| 38 | Personel puan defteri | 🟡 panelde verildi: telefon sayfasına (B8) — kurgu ⏳ |
| 39 | Kimlik birleştirme | ⏳ sorulacak (öneri: Ç → Tanımlar) |
| 40 | Personel davranış / risk skoru | 🟡 KONTROL olmasın (panelde verildi); geç kalma yoklamada; risk skoru ⏳ |
| 41 | İş başvurusu | ⏳ sorulacak |
| 42 | Şube paneli | ✅ YENİ ŞUBE PANELİ (B) |
| 43 | Operasyon Merkezi (40+ sekme) | ⏳ sorulacak (öneri: Ç) |
| 44 | WhatsApp bildirimleri | 🟡 kapanış hatırlatması YOK (panelde verildi, D10); gece özeti ⏳ |
| 45 | Evo | ✅ ÇIKAR |
| 46 | TV menü | ⏳ sorulacak |
| 47 | Ev / dükkân tasarımı | ⏳ sorulacak |
| 48 | Akıllı Denetim (Truth motor) | ⏳ sorulacak (öneri: Ç) |
| 49 | Duyular | ⏳ sorulacak (öneri: Ç) |
| 50 | Evvel Beyni | ⏳ sorulacak (öneri: Ç) |
| 51 | CFO Panel / Kadife v2 / Strateji | ⏳ sorulacak (öneri: Ç) |
| 52 | Aylık rapor | ⏳ sorulacak (öneri: Ç → Gelir/Gider/Kazanç) |
| 53 | Denetim izi / mutabakat merkezi | ⏳ sorulacak (öneri: Ç) |
| 54 | Ekran ölçümü & arama | ⏳ sorulacak (öneri: Ç) |
| 55 | Cep (/cep) | ⏳ sorulacak (öneri: Ç) |
| 56 | Kullanıcılar & giriş | ⏳ EN SON (yetki) |
| 57 | Excel import / sistem sıfırla | ⏳ sorulacak (öneri: Ç) |
| 58 | Veritabanı & ortak yardımcılar | KALIR |
| 59 | Gece zinciri | her ÇIKAR kararında ilgili gece adımı sökülür |

## E. KESİM / YETKİ

| # | İş |
|---|---|
| E1 | Verilen kararların uygulanması (KESIM_LISTESI) + eski sistem sökümü (sube_panel, sube_operasyon, fire_bildirim, operasyon_defter, stok_yolda, siparis_urun …) — 1 Kasım sonrası |
| E2 | Giriş kapısı + kullanıcı tanımında yetki (rol × alt sekme × şube) — EN SON |
| E3 | Kira hesabı: evlerin tanımı |
