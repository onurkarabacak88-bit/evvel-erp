# GPT'ye sorulacak görüş promptu — Karşılıksız stok çıkışı

> Aşağıdaki metnin tamamını kopyalayıp GPT'ye yapıştırın.

---

Sen kıdemli bir ERP / envanter muhasebesi mimarısın. Türkiye'de 4 şubeli bir kahve zincirinin kendi geliştirdiği ERP'sinde canlı bir kusur ölçüldü. Senden **mimari hüküm** istiyorum — kod değil. Somut karar ver, "duruma göre değişir" deme.

## 1. Sistem nedir

- FastAPI + PostgreSQL + React. 4 şube. Gerçek para, canlı veri.
- Bir şube (TEMA) fiilen **merkez depo** görevi görüyor; diğer şubelere mal sevk ediyor.
- Stok iki katmanlı: **depo** (`sube_depo_stok`) ve **bar**. Depodan bara geçiş "ÜRÜN AÇ" hareketi.
- Şubeler arası mal **`stok_yolda`** tablosunda "yolda" duruyor: sevk anında kaynaktan düşülür, alıcı **kabul edince** hedefe eklenir. Kabul edilene kadar mal hiçbir şubenin defterinde değildir.
- Her stok hareketi `sube_depo_stok_hareket` defterine yazılır: `hareket_turu`, `miktar` (işaretli), `onceki_miktar`, `sonraki_miktar`.

## 2. Ölçülen kusur (canlı, son 90 gün, 1.000 hareket)

Defterin tutması gereken kural: **`sonraki_miktar − onceki_miktar = miktar`**.

| Hareket türü | Toplam | Kuralı BOZAN | Oran | Karşılıksız adet |
|---|---:|---:|---:|---:|
| ÜRÜN AÇ (depo→bar) | 645 | 120 | %18,6 | **3.815** |
| SEVK ÇIKIŞ (şubeye) | 139 | 20 | %14,4 | **509** |
| FİRE | 12 | 6 | %50,0 | 18 |
| SEVK GİRİŞ | 129 | 0 | %0 | 0 |
| TESLİM GİRİŞ | 75 | 0 | %0 | 0 |
| **TOPLAM** | | **146** | | **4.342** |

**Bütün sızıntı ÇIKIŞ yönünde. Girişler tertemiz.**

### Mekanizma
Her çıkış şu SQL ile yazılıyor:
```sql
UPDATE sube_depo_stok
SET mevcut_adet = GREATEST(0, COALESCE(mevcut_adet,0) - %s)
WHERE sube_id=%s AND kalem_kodu=%s
```
`GREATEST(0, …)` stoğu **sıfırda tabanlıyor**. Depoda 0 varken 12 adet çıkış yazılabiliyor: defter 0'da kalıyor ama hareket satırı `miktar=−12, onceki=0, sonraki=0` diyor — **aritmetiği kendi içinde yalanlayan bir satır.**

### Somut vaka
TEMA kendi deposundan kendi barına 4 kalem istedi (19.08 sipariş, 09.09 sevk). Deftere **42 adet** "sevk edildi" yazıldı, depodan gerçekten düşen **9**. Mango 12 yazıldı/0 düştü, Orman Meyvesi 12/0, Çilek Püre 6/0, Ananas Püre 12/9. Talep eden ve sevk eden **aynı kişi**. 5 gündür "kabul bekliyor".

### Tespit zaten VAR, görünürlük YOK
Sistem bu durumu `HAYALET_STOK` diye zaten yakalıyor: log yazıyor, `sube_operasyon_uyari` tablosuna kritik uyarı basıyor, olay omurgasına olay düşüyor, siparişin kaydında uyarı duruyor. **Hiçbir ekran bunu iş olarak göstermiyor.** 90 gündür kimse görmedi. Kodda şu yorum var: *"Sevke ENGEL OLMA (kullanıcı kararı) — sadece BİLDİR ki depo sayımı düzeltilsin."*

## 3. ⚠️ Kolay cevabı bozan kritik bağlam

Aynı sistemde ayrı bir ölçüm var: **stok girişlerinin yalnız %13,7'si tedarikçi zincirine bağlanabiliyor (114/830); 63 giriş hiçbir zincire bağlanamıyor.**

Yani **depo defteri büyük olasılıkla OLDUĞUNDAN AZ gösteriyor** — mal fiziken giriyor ama kaydı düşmüyor. 72 adet Redbull fiilen sevk edildiyse depoda fiziken vardı; yanlış olan defterdi.

**Sonuç:** "stok yetmiyorsa çıkışı blokla" dersen, depocu fiziken elinde olan malı gönderemez ve **günlük operasyon durur.** Bu bir muhasebe zarafeti sorunu değil, işletmeyi kilitleme riski.

## 4. Sistemin diğer gerçekleri (hükmünü bunlara göre ver)

- Sahip **kod bilmiyor**. Kararın gerekçesi sade Türkçe anlatılabilmeli.
- Sevk, merkez operasyon ekranından yapılıyor (React). **Şube paneli ayrı bir HTML ve kimlik taşımıyor**; oraya karmaşık yeni akış koymak zor.
- API'de kimlik doğrulama yok (sahip kararı: proje sonunda eklenecek). Yani "yetkili kullanıcı onaylasın" türü çözümler şu an dayanaksız.
- Proje ilkesi: duyular **öneri-only**, alarm üretir ama iş akışını kilitlemez. Para/stok değiştiren toplu işlem önce kuru çalışır.
- **Kabul tarafında tavan freni zaten var**: şube sevkten fazla kabul etse bile deftere sevk kadarı yazılıyor.
- Uzlaştırma ucunda bu kırpma **zaten kapatıldı** (409 "Uzlaştırma stok üretemez"). Kapatılmayan yer: sevk anı, ürün-aç ve fire.
- Ürünlerde **birim/koli tanımı neredeyse boş** (132 üründen 14'ünde koli adedi var) — sayımlarda koli/adet karışıklığı ayrı bir gürültü kaynağı.

## 5. Sana sorularım

1. **Dünya pratiği:** Bu problem sınıfı (negative inventory, goods-in-transit ownership, unrecorded receipts) SAP / Oracle / NetSuite / Odoo gibi sistemlerde nasıl ele alınır? "Negatif stoğa izin ver" ile "çıkışı blokla" arasındaki tercih hangi koşulda hangisi olur? `in-transit` malın sahipliği muhasebede nereye yazılır?

2. **Bu sistem için hüküm:** Madde 3'teki kritik bağlamı (defter eksik gösteriyor) göz önüne alarak hangi davranış doğru — sert blok, negatif stok, gerekçeli geçiş (override), yoksa başka bir şey? **Neden?** Üç türü (sevk / ürün-aç / fire) aynı kurala mı bağlamalı, ayrı mı?

3. **Sıralama:** Ürün-aç 3.815 adetle sevkten 7 kat büyük. Hangisinden başlanmalı ve neden?

4. **Geçiş riski:** Seçtiğin davranış canlıya alınırsa mevcut 146 karşılıksız kayda ve günlük operasyona ne olur? Geriye dönük düzeltme gerekir mi? Gerekiyorsa çıpası ne olmalı?

5. **Tek rakamlık başarı ölçüsü:** Düzeltmenin işe yaradığını hangi TEK sayıyla anlarız? O sayı bugün kaç, hedefi ne olmalı?

6. **Kör nokta:** Bu tabloyu okurken benim sormadığım ama sorulması gereken soru ne?

Türkçe yaz. Somut ol, karar ver.
