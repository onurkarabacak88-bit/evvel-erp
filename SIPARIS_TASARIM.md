# 📦 EVVEL YENİ · SİPARİŞ + ÜRÜN KATALOĞU — Birleşik Tasarım (Codex + Fable) · REVİZYON 2

> Sahip: "Eski sistemden daha mantıklı ama kullanımı kolay; alt başlıklar; en ince ayrıntısına kadar." · "Katalog örüntüsü ile depo örüntüsü
> AYNI MANTIKTA olmalı; yeni Evvel'in altyapısını YOK SAYMA." · "Yetkilendirmeyi en sonda kullanıcı tanımında netleştireceğiz."
> Kaynaklar: tmp/codex_siparis_tasarim.txt, tmp/fable_siparis_tasarim.txt (1. tur) · tmp/codex_siparis_revizyon.txt, tmp/fable_siparis_revizyon.txt (revizyon).

## 0. Ana kural
Sipariş, **mevcut Depo ve Toptancılar altyapısının ÜZERİNE** bir talep/yönlendirme katmanıdır. **Ayrı stok bakiyesi, ayrı "yolda" defteri,
ayrı teslim defteri, ayrı fiyat alanı, ayrı ürün eşleme KURULMAZ.** Gerçekleşen her şey (sevk, kabul, giriş, fire, fark) mevcut Depo
hareket defterine (ey_stok_hareket) ve mevcut toptancı teslim kaydına (ey_toptanci_teslim) yazılır.

## 1. Ürün kataloğu — yeni "urun" modülü (Depo ile aynı mantık)
- **Bugün ürünü BEŞ ayrı yer kendi başına çözüyor:** Depo `_urun_haritasi` (id/kod/ad), Toptancılar `_anahtar` + `_tahmin`, Bar `_kod_anahtar/_anahtar_ad`,
  Gider (siparis_urun JOIN), Satış `_urun_ad`. Hepsi eski siparis_urun tablosunu okuyor. Katalog bunların **YERİNE** geçer (altıncı yapı olmaz).
- **Tek kimlik:** eski siparis_urun kimlikleri BİR KEZ, Tanımlar'ın kopya deseniyle aynen korunarak kopyalanır (Depo ve Toptancı kayıtları bu kimlikleri kullanıyor → köprü gerekmez).
- **Değişiklik izi (Depo deseni):** ürünün güncel kartı + her değişiklik bir kayıt (kim, ne zaman, alan, eski → yeni, kaynak_ref tekil, iptal). Silme yok: pasif + iz.
- **Alanlar:** ad · kategori · sayım birimi (tek; ilk sürümde ADET — kg/lt mevcut tam sayı miktar zinciri dönüştürülünce açılır) · koli içi adet (mevcut
  `koli_ic_adet`; ikizi `koli_adet` kopyada tek kolona indirilir) · KDV (eski kalem_kdv_oran'dan taşınır) · aktif · **takma adlar** (eski depo kodu + fatura adları).
- **Fiyat katalogda DEĞİL:** mevcut Ürün fiyatları altyapısında kalır. Bugün Gider ile Toptancılar'ın fiyat/KDV hesabı FARKLI → **tek fiyat kuralına** bağlanır.
- **Toptancı bağı:** mevcut "öğrenilen fiyat" kaydından (ey_toptanci_fiyat) türer; varsayılan toptancı yalnız istisna için elle.
- **Birim kilidi:** hareket görmüş ürünün birimi değişmez (Depo, kullanılan ürünü kayıt defterine bildirir; katalog Depo'yu tanımaz).
- **PUBLIC servis:** `urun_haritasi` (id / takma ad / ad → ürün, birim, koli) · `katalog` (kategori + ürün) · `urun_ad`. Depo, Toptancılar, Bar, Gider, Satış ve panel
  yalnız bunu okur; eski siparis_urun'a doğrudan okuma kalmaz.
- **İkiz "ürün aç" çözücüsü** (Bar ve Gider'de iki farklı kopya): tek PUBLIC servise birleşir; eşleşmeyen satır KAYBOLMAZ → Bekleyen işler.
- **Şube tanımına "depo" bayrağı** (Tema): bugün Depo, merkez depoyu eski tablodan tahmin ediyor.
- Koli yardımcısı: "2 koli × 12 + 3 = 27 adet" — kayda 27 gider, kullanılan katsayı işlemde saklanır. Koli içi adedi tanımsızsa koli kutusu görünmez.

## 2. Sipariş akışı (yeni olan yalnız: talep + kalem + yönlendirme + sevk partisi başlığı)
- **Yeni tablolar (en az):** sipariş (şube, kim, not, acil) · kalem (ürün, istenen adet, koli katsayısı, "hazır" bilgisi) · yönlendirme (kalem, kaynak depo/toptancı X,
  adet, durum) · sevk partisi BAŞLIĞI (kaynak depo, hedef şube, kim — adet tutmaz; Depo hareketleri ona bağlanır; bugünkü eski "stok_yolda" bağı böyle kesilir).
1. **Şube talebi (panel):** sepet, koli yardımcısı, "zaten bekliyor/yolda" bilgisi, katalog dışı ürün = öneri.
2. **Merkez yönlendirme:** kalem kalem; "varsayılanları uygula"; aynı kalem bölünebilir (bir kısmı depodan, kalanı toptancıdan). Stok/borç oluşturmaz.
3. **Depo hazırlık (Tema):** "hazır" yalnız sipariş kalemi bilgisidir; stok = Depo defteri toplamı.
4. **Sevk:** Depo'ya yeni PUBLIC "hareket yaz" servisi (bugün Depo'nun yazma ucu yalnız sayım/kabul/fark). Konum kilidi (sayım deseni) + **güncel bakiye kontrolü →
   hayalet sevk YASAK** (geçici modda bile). Tür `sevk` (depo:Tema → yolda).
   **KİLİTLEMEZ — karar bekliyor (Codex: sevk ekranında Teslim al / Sayım formu · Fable: sevk HİÇ sorgulanmaz, eksi bakiye = Bekleyen iş "kaynağı eksik"; öneri Fable).**
   Ortak önlemler: açılış sayımı yoksa sevk serbest + tek uyarı "sayım yap" · "aynı teslim iki kez mi?" (aynı toptancı + ürün + yakın tarih → silinmez, Bekleyen işler) ·
   sayım düzeltmesi "rafta toplam kaç adet" + ürün başına ayda 1 + kişi sayacı · sevk servisinde konum kilidi · kısmi kabullü sevkte merkez kabulü düzeltilir.
   **Bu uyarı ve işlerin HİÇBİRİ şube paneline gitmez** (sahip): personel sevk/teslimde soru görmez; hepsi yalnız Evvel Yeni (merkez) Bekleyen işler › Tedarik & depo ve Depo › Uyarılar.
5. **Kabul — MEVCUT:** `kabul` (yolda → depo:şube), fazla → askıda, fark çöz (kayıp / iade / fazla onay / fazla ret), 2 gün → merkez adına kabul, Bekleyen işler.
   **Yeni yalnız "hasarlı"** (yolda → askıda) + karar "hasar → fire / iade". Sıfır kabul gerçek kayıttır.
6. **Toptancı teslimi — MEVCUT kayıt:** bugün aynı panel teslimi iki yere ayrı ayrı yazılıyor (toptancı teslimi kancası + Depo girişi köprüyle sonradan). Hedef: **tek işlem**
   (teslim kaydı + Depo girişi aynı anda, aynı kaynak_ref tabanı), kalem yönlendirmesine bağlı. Fatura mevcut "teslim tutarı" ile kesinleşir. Bugünkü kanca hatayı yutuyor → düzeltilir.
7. **Kapanış:** kalemler karşılandı / gerekçeyle iptal / farklar çözüldü → talep kendiliğinden kapanır. Kayıp/fire karşılanmış sayılmaz.

## 3. Ekranlar
- **Sipariş (yeni bölüm):** Takip · Yeni talep · Yönlendirme · Toptancıdan bekleniyor · Geçmiş · Uyarılar.
- **Depo:** Yoldakiler · Sevk farkları · Nerede? · Sayım **MEVCUT**; yalnız **Hazırlık** yeni.
- **Tanımlar:** Ürünler · Kategoriler (yeni "urun" modülü); Şube tanımında depo bayrağı.
- **Bekleyen işler › Tedarik & depo:** mevcut kayıt defteri genişler (`grup=tedarik`). **Panel:** Sipariş Ver · Siparişlerim · Teslim Al.

## 4. Yetki — TASLAK (kullanıcı tanımındaki yetki altyapısında netleşecek; bu fazda yetki kodu YAZILMAZ)
Veri/uç kuralı şimdiden: her satır şube, ürün ve alan adıyla ayrı döner → ileride rol × alt sekme × alan × şube süzmesi sunucuda eklenebilir.
Önceki taslak tablo (sahip, muhasebe, depo sorumlusu, şube müdürü, personel) yalnız başlangıç önerisidir.

## 5. Çıkacak / geçiş
- **Çıkar (eski):** sipariş kontrol kulesi, öneri/davranış motoru, rezerv denklemi, kalem_durumlari JSON, sıfıra kırpan stok çıkışı (hayalet), birden çok stok motoru, eski birim/koli uçları.
- **Çıkar (Evvel Yeni'nin kendi geçici parçaları):** ad üzerinden eşleme yedekleri (Depo, Toptancılar, Bar), ikiz "ürün aç" çözücüsü, merkez depo tahmini, eski stok_yolda bağı (merkez kabul), senkron köprüsü (kesimde).
- **Geçiş sırası:** (1) katalog kopya + "urun" modülü + 5 okuyucunun geçişi → (2) panel siparişi çift yazar, merkez Yönlendirme → (3) sevk/kabul Depo "hareket yaz"a, sevk partisi bağıyla
  → (4) toptancı teslimi tek işlem → (5) eski okuyucular taşınıp kaynak_ref bazında miktar/tutar mutabakatı tamamlanmadan köprüler KESİLMEZ; sonra eski uçlar kapanır.

## 6. Fazlar · riskler
- **Faz 1:** "urun" modülü + değişiklik izi + 5 okuyucu geçişi + tek ürün-aç çözücüsü + şube depo bayrağı + tek fiyat kuralı → sipariş/kalem/yönlendirme → Depo "hareket yaz" + hayalet freni + Hazırlık → hasarlı kabul → toptancı teslimi tek işlem.
- **Faz 2:** haftalık şablon, acil, WhatsApp listesi, minimum stok. **Faz 3:** kullanıcı tanımı + yetki (giriş kapısıyla), eski uçların kesimi.
- **Riskler:** yanlış koli katsayısı · açılış sayımı yokken sevk (hayalet freni geçici modda da sert) · çift sevk/teslim/borç (tek işlem kimliği + kilit) · açık işin kaybolması (tarihsiz liste) · okuyucu geçişinde ürün kaybolması (eşleşmeyen → Bekleyen işler).
- Her adım Codex + Fable denetimli; kabul senaryoları: karışık kaynaklı talep, iki partili sevk, 0/eksik/fazla/hasarlı kabul, eşzamanlı işlem, çift yazım.
