# Handoff: Evvel ERP — Kahve Zinciri Yönetim Sistemi (v2)

> Dil notu: Arayüz tamamen **Türkçe**. Tüm etiketler, başlıklar ve mikro-kopya bu dokümanda birebir verilmiştir; çeviri yapılmayacak.

## Overview

Evvel ERP, 4 şubeli bir kahve zincirini (Tulipi) tek ekrandan yöneten bir işletme yönetim sistemidir. Sahip/işletmeci için tasarlanmıştır ve dört soruya cevap verir: *bugün ne oldu, neyi onaylamam gerekiyor, param nereye gidiyor, batıyor muyum?*

Ürün 14 modül ve ~50 ekrandan oluşur. Merkezî etkileşim deseni: **liste/tablo/kart → tıkla → sağdan detay çekmecesi** (özet + bağlı belgeler + değişmez işlem izi). Para hareketi doğuran işlemler ayrıca bir **onay modalı** üzerinden geçer.

## About the Design Files

Bu pakette bulunan `Evvel ERP v2.dc.html` bir **tasarım referansıdır** — HTML ile üretilmiş, hedeflenen görünümü ve davranışı gösteren yüksek çözünürlüklü bir prototiptir. **Doğrudan production'a kopyalanacak kod değildir.**

Görev: bu tasarımı hedef kod tabanının kendi ortamında (React, Vue, SwiftUI, native — hangisi kullanılıyorsa) o ortamın yerleşik desenleri, state yönetimi ve bileşen kütüphanesiyle **yeniden inşa etmek**. Henüz bir ortam yoksa, proje için en uygun framework seçilip tasarım orada hayata geçirilmelidir.

Prototipteki tüm veriler **kurgusaldır** (statik sabitler). Gerçek implementasyonda bunların yerine API/veritabanı katmanı gelecektir — bu dokümandaki sayılar yalnızca *biçim, ölçek ve mertebe* referansıdır (ör. tutarların `1.234.567,89 ₺` biçiminde, tabular hizalı gösterilmesi).

### Prototipte kasıtlı olarak eksik bırakılanlar

Bunlar tasarım kararıyla dışarıda bırakıldı, implementasyonda ele alınmalı:

- Kimlik doğrulama, yetki/rol matrisi (prototipte tek kullanıcı: "Ayşe Demir · işletmeci")
- Gerçek veri kalıcılığı, offline davranışı, çakışma çözümü
- Sunucu tarafı doğrulama ve hata yanıtları (form validasyonu prototipte yok)
- Çok dilli destek (yalnız Türkçe)
- Gerçek dosya yükleme / PDF render (Belgeler sekmesindeki önizleme alanı yer tutucudur)

## Fidelity

**Yüksek çözünürlük (hi-fi).** Renkler, tipografi, boşluklar, radius, gölge ve geçişler nihaidir. Geliştirici UI'ı, hedef kod tabanının kütüphaneleriyle **piksel düzeyinde** yeniden üretmelidir. Bu dokümandaki tüm hex ve px değerleri bağlayıcıdır.

---

## Design Tokens

### Renk — zeminler (koyu tema)

| Rol | Değer |
|---|---|
| Uygulama zemini | `#16100A` + `radial-gradient(1100px 620px at 68% -12%, rgba(64,45,24,.55), transparent)` |
| Modül rayı (sol, en koyu) | `#120C07` |
| Görünüm kolonu (2. sütun) | `#1A1209` |
| Kart yüzeyi (elev 1) | `linear-gradient(168deg,#2B2014,#20170B)` |
| Kart içi iç yüzey (elev 0) | `#251B0F` |
| Girdi / segment zemini | `#1F160D` |
| Çekmece zemini | `linear-gradient(180deg,#241A10,#1B1309)` |
| Modal / palet zemini | `linear-gradient(168deg,#2E2216,#211809)` |
| Toast / seçim çubuğu | `linear-gradient(168deg,#33261A,#241A0E)` |
| Başlık çubuğu (yapışkan) | `rgba(22,16,10,.86)` + `backdrop-filter: blur(16px) saturate(1.2)` |

### Renk — kenarlıklar

| Rol | Değer |
|---|---|
| Kart kenarlığı | `rgba(243,233,220,.075)` |
| Kart içi kenarlık | `rgba(243,233,220,.08)` |
| Yapısal ayırıcı (kolon/panel) | `#2C2016` |
| Kart içi ayırıcı çizgi | `#33251A` |
| Girdi / buton kenarlığı | `#3A2C1E` |
| Vurgulu kenarlık (koyu yüzeyde) | `#4A3826` |
| Tablo satır alt çizgisi | `#2A1E13` |

### Renk — metin

| Rol | Değer |
|---|---|
| Ana metin | `#F3EADC` |
| Vurgulu gövde (bilgi kutusu) | `#E7DCCB` |
| İkincil metin | `#C4B5A2` |
| Üçüncül / etiket | `#9B8A75` |
| Sönük / meta | `#8B7B67` |
| En sönük / ipucu | `#6E6052` |
| Blok başlığı (rayda) | `#5E5142` |

### Renk — bakır vurgu (marka)

| Rol | Değer |
|---|---|
| Bakır (ikon, aktif, link) | `#D29A5B` |
| Bakır hover / aktif metin | `#E5B27A` |
| Birincil buton dolgusu | `linear-gradient(150deg,#E0A559,#AF6C29)` |
| Birincil buton metni | `#1C1309` |
| Aktif zemin (rayda/segmentte) | `rgba(217,154,78,.14)` – `.18` |
| Aktif halka | `inset 0 0 0 1px rgba(217,154,78,.30)` |
| Odak halkası | `0 0 0 3px rgba(217,154,78,.12)` |
| Bilgi kutusu (bakır) | zemin `rgba(217,154,78,.09)`, kenar `rgba(217,154,78,.28)` |

### Renk — anlamsal (finansal)

| Rol | Değer | Notu |
|---|---|---|
| Olumlu / kâr | `#4ADE80` | gradyan bitişi `#22C55E`, üstündeki metin `#052E14` |
| Olumsuz / borç / hata | `#F87171` | gradyan bitişi `#EF4444` |
| Uyarı | `#FBBF24` | |
| Bilgi | `#60A5FA` | bilgi kutusu: zemin `rgba(96,165,250,.09)`, kenar `rgba(96,165,250,.26)` |
| Nötr / sönük veri | `#9B8A75` | |

**Kural:** yeşil/kırmızı/sarı **yalnızca finansal veya durum anlamı** taşır — dekoratif kullanılmaz. Rozet zeminleri anlam renginin `+ '22'` veya `+ '26'` alfa ekiyle üretilir (ör. `#4ADE8022`).

### Tipografi

Google Fonts: `Instrument Sans` (400,500,600,700) · `Fraunces` (opsz 9–144, ağırlık 500,600,700) · `JetBrains Mono` (400,500,600,700)

| Kullanım | Font | Boyut / ağırlık |
|---|---|---|
| Sayfa başlığı (H1) | Fraunces | 23px / 600, line-height 1.2 |
| Çekmece başlığı | Fraunces | 20px / 600, lh 1.25 |
| Modal başlığı | Fraunces | 19px / 600 |
| Kart bölüm başlığı | Fraunces | 15.5–16px / 600 |
| Modül adı (2. kolon) | Fraunces | 17px / 600 |
| Logo "E." | Fraunces | 22px / 600 |
| Gövde | Instrument Sans | 14px / 400, lh 1.5 |
| Liste satırı başlığı | Instrument Sans | 13.5px / 600 |
| Tablo hücresi | Instrument Sans | 12.5px / 400 (kalın: 700) |
| İkincil açıklama | Instrument Sans | 11.5–12px / 400 |
| Bölüm etiketi (ÜST ETİKET) | Instrument Sans | 10–11px / 700, `letter-spacing:.6–1px`, `text-transform:uppercase` |
| Ray blok etiketi | Instrument Sans | 7.5px / 700, ls .7px, uppercase |
| Ray modül kısaltması | Instrument Sans | 8.5px / 700, ls .5px, uppercase |
| Hero rakamı | JetBrains Mono | 44px / 700, `letter-spacing:-2px`, lh 1 |
| Modal tutarı | JetBrains Mono | 28px / 700, ls -1px |
| KPI değeri | JetBrains Mono | 22px / 700, ls -.6px |
| Çekmece KPI değeri | JetBrains Mono | 16px / 700 |
| Tablo/liste tutarı | JetBrains Mono | 12.5–13px / 700 |
| Meta / kayıt no | JetBrains Mono | 10–11px / 400–700 |

**Zorunlu global kural:** `font-variant-numeric: tabular-nums` gövdede tanımlı — tüm arayüzde sayılar sütun hizalı. Parasal değerlerde `white-space: nowrap`.

**Para biçimi:** `tr-TR` — binlik ayırıcı `.`, ondalık `,`, simge sonda boşlukla: `1.234.567,89 ₺`. Negatif için tipografik eksi `−` (U+2212), pozitif vurgu için `+`. Yüzde önde: `%22,4`.

### Boşluk ölçeği

8pt tabanlı, ara adımlarla: **2 · 3 · 5 · 7 · 9 · 12 · 14 · 16 · 18 · 22 · 26 · 34 px**

| Kullanım | Değer |
|---|---|
| İçerik alanı padding | `26px 34px 72px` |
| Başlık çubuğu padding | `14px 34px 13px` |
| Kart padding (büyük) | `22px 24px` |
| Kart padding (KPI) | `14px 16px` |
| Çekmece gövde padding | `18px 22px 22px` |
| Kart ızgara boşluğu | `12px` |
| Liste satır boşluğu | `7px` |
| Bölüm alt boşluğu | `16px` |

### Radius ölçeği

**6 · 8 · 10 · 12 · 14 · 16 · 20 · 99(pill)**

| Kullanım | Değer |
|---|---|
| Modal, hero kartı | 20px |
| Kart, palet, tablo kabı | 16px |
| Ray modül düğmesi | 12px |
| KPI kartı, seçim çubuğu, liste satırı | 14px |
| İç yüzey, bilgi kutusu, toast | 12px |
| Buton, girdi, segment kabı | 10px |
| Küçük buton, rozet kabı, sekme, satır | 8px |
| Segment içi aktif dilim | 6px |
| Rozet, çip, ilerleme çubuğu | 99px |

### Gölge ölçeği

| Seviye | Değer |
|---|---|
| Kart (elev 1) | `inset 0 1px 0 rgba(255,241,224,.045), 0 10px 28px -10px rgba(0,0,0,.66)` |
| KPI kartı | `inset 0 1px 0 rgba(255,241,224,.045), 0 8px 22px -10px rgba(0,0,0,.6)` |
| Hero / yükseltilmiş kart | `inset 0 1px 0 rgba(255,241,224,.05), 0 14px 36px -12px rgba(0,0,0,.7)` |
| Kart hover | `0 14px 30px -10px rgba(0,0,0,.7)` |
| Birincil buton | `0 6px 18px -4px rgba(217,154,78,.45), inset 0 1px 0 rgba(255,240,220,.35)` |
| Birincil buton hover | `0 10px 24px -6px rgba(217,154,78,.55), inset 0 1px 0 rgba(255,240,220,.45)` |
| Çekmece | `-24px 0 60px rgba(0,0,0,.5)` |
| Modal | `0 30px 70px -20px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,241,224,.07)` |
| Komut paleti | `0 34px 80px -24px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,241,224,.07)` |
| Toast / seçim çubuğu | `0 20px 44px -14px rgba(0,0,0,.8)` |
| Aktif ray düğmesi | `inset 0 0 0 1px rgba(217,154,78,.32), 0 8px 20px -8px rgba(217,154,78,.5)` |

**Kural:** gölgeler negatif yayılımlı (`-10px`…`-24px`) — koyu temada odaklı derinlik verir, "çamurlanma" yapmaz. Her kartın üstünde 1px iç ışık çizgisi (`inset 0 1px 0 rgba(255,241,224,.045)`) vardır; malzeme hissini bu verir.

### Kâğıt dokusu (marka dokunuşu)

Tüm arayüzün üstünde, tıklamayı engellemeyen ince bir grain katmanı:

```
position: fixed; inset: 0; z-index: 200; pointer-events: none;
opacity: .05; mix-blend-mode: overlay;
background-image: SVG feTurbulence(type=fractalNoise, baseFrequency=0.85, numOctaves=3, stitchTiles=stitch), 160×160 döşeme
```

### Animasyon

| Ad | Tanım | Kullanım |
|---|---|---|
| `yuksel` | `translateY(12px)→0`, opacity 0→1 | içerik girişi (.28s), toast (.22s), seçim çubuğu (.2s) — `cubic-bezier(.22,1,.36,1)` |
| `belir` | opacity 0→1 | katman perdeleri (.14–.2s ease) |
| `kay` | `translateX(52px)→0`, opacity .3→1 | çekmece girişi (.42s `cubic-bezier(.4,0,.2,1)`) |
| `buyu` | `scale(.96) translateY(10px)→0` | modal (.26s), palet (.2s) `cubic-bezier(.4,0,.2,1)` |
| `cizim` | `stroke-dashoffset: 640→0` | grafik çizgisi (1.1s, .12s gecikme) |
| `cizgiAc` | `scaleX(0)→1` | logo altı bakır çizgi (.8s, .2s gecikme) |

Geçişler: hover `.14–.18s`, renk/zemin `.16s`, buton `transform .18s cubic-bezier(.2,.8,.2,1)`.
`@media (prefers-reduced-motion: reduce)` → tüm animasyon ve geçişler kapalı.

### Kaydırma çubuğu

`10px` genişlik, şeffaf iz, thumb `#3A2C1E` + `2px solid #16100A` kenar, radius 5px, hover `rgba(210,154,91,.5)`.

### Seçim ve odak

- `::selection` → zemin `rgba(217,154,78,.32)`, metin `#FFF6E9`
- `:focus-visible` → `2px solid #D29A5B`, `outline-offset: 2px`, `border-radius: 4px`

---

## Layout — Kabuk

Üç sütunlu sabit kabuk, `height: 100vh; overflow: hidden`:

```
┌────┬──────────┬───────────────────────────────────────┐
│ 74 │   222    │  main (flex:1, overflow-y:auto)       │
│ ray│ görünüm  │  ┌─ header (sticky, z-30) ─────────┐  │
│    │ kolonu   │  ├─ içerik (max-w 1420, ortalı) ───┤  │
│    │          │  └───────────────────────────────────  │
└────┴──────────┴───────────────────────────────────────┘
                                    → çekmece 448px (sağdan, z-90)
                                    → modal 466px (ortada, z-120)
                                    → palet 580px (üstten %12, z-150)
```

### 1. Modül rayı — 74px

- Zemin `#120C07`, sağ kenar `1px solid #2C2016`, dikey kaydırılabilir
- Üstte logo: Fraunces "E" + bakır "." , altında 26×2px bakır çizgi (`cizgiAc` animasyonlu)
- 14 modül düğmesi: 52px genişlik, `padding: 9px 0 7px`, radius 12px, dikey flex (21px ikon + 8.5px kısaltma), gap 6px
- **4 blok** halinde gruplu; her blok başında 44px genişliğinde üst kenarlıklı blok etiketi (7.5px uppercase `#5E5142`)
- Modülde kritik kayıt varsa sağ üstte 6px kırmızı nokta (`#F87171`)
- Aktif: zemin `rgba(217,154,78,.15)`, metin `#E5B27A`, `inset 0 0 0 1px rgba(217,154,78,.32)` + bakır ışıma
- Altta kullanıcı avatarı: 34px daire, `linear-gradient(150deg,#D29A5B,#96602C)`, metin `#1C1309`

### 2. Görünüm kolonu — 222px

- Zemin `#1A1209`, sağ kenar `1px solid #2C2016`
- Üst blok (`padding: 20px 18px 14px`, alt kenarlık): modül adı (Fraunces 17px) + alt açıklama (10.5px uppercase `#8B7B67`)
- Görünüm listesi: satır `padding: 9px 11px`, radius 8px, 12.5px metin, sol 2px şeffaf kenarlık
  - Hover: zemin `rgba(243,233,220,.045)`
  - Aktif: zemin `rgba(217,154,78,.12)`, metin `#E5B27A`, sol kenarlık `#D29A5B`, ağırlık 600
  - Rozet: pill, min 20px, `padding: 2px 7px`, JetBrains Mono 10px/700, zemin anlam rengi + `26` alfa
- Alt blok (üst kenarlıklı): "KASA + BANKA" etiketi, `586.310 ₺` (Mono 17px/700 yeşil), 5px ilerleme çubuğu (%64, yeşil gradyan), açıklama satırı

### 3. Başlık çubuğu (sticky)

- `padding: 14px 34px 13px`, `flex-wrap: wrap`, gap 16px, alt kenarlık `#2C2016`
- Sol: üst etiket (modül adı, 10.5px uppercase, tek satır + ellipsis) + H1 görünüm adı (Fraunces 23px, tek satır + ellipsis). Kap: `flex: 1 1 220px; min-width: 0`
- Sağ (`flex-wrap: wrap; justify-content: flex-end`):
  1. **Dönem seçici** — Gün / Hafta / Ay segment kontrolü (yalnız dönem duyarlı modüllerde görünür)
  2. **Arama tetikleyici** — `width: clamp(160px,18vw,230px)`, salt-okunur; tıklama komut paletini açar; sağda `⌘K` ipucu
  3. **"Gün Sonu Kapat"** — birincil bakır buton, `white-space: nowrap`

---

## Modüller ve ekranlar (bilgi mimarisi)

14 modül, 4 anlamsal blok. Ray bu blokları etiketle ayırır.

### Blok 1 — KARAR

**Yönetim & Karar** (`panel`) · alt: "CFO görünümleri"
| Ekran | Amaç | Ana bileşen |
|---|---|---|
| Bugün | Günün tek ekran özeti | 4 KPI + hero grafik (saatlik kümülatif ciro) + 4 şube kartı |
| Ay Özeti | Kâr nasıl oluştu | KPI + şelale grafiği (Kâr nasıl oluştu) |
| Şube Karnesi | Şube kıyaslaması | KPI + 9 kolonlu tablo (finansal + operasyonel) |
| Riskler `5` | Bugün karar gerektirenler | KPI + şiddet katmanlı liste |
| Strateji Önerileri `4` | Motor önerileri | KPI + aksiyonlu liste |

**Denetim & Zekâ** (`denetim`) · alt: "13 tanı motoru · duyu"
| Ekran | Amaç |
|---|---|
| Bugünkü Bulgular `5` | Tüm motor bulguları, şiddet sıralı tek liste |
| Tanı Motorları · 13 | Motor kaydı, kapsam, son koşu, durum |
| Duyu Mutabakatı `1` | 5 finansal alanın mutabakatı, açık farklar |
| Sinyal İzleme · 24 sinyal | İzlenen sinyaller, yeşil/sarı/kırmızı bant |
| Bağ Defteri | Neden→sonuç zincirleri + dilek defteri |

**Rapor & Defter** (`rapor`)
| Ekran | Amaç |
|---|---|
| Aylık Rapor | 6 aylık ciro/kâr trend tablosu |
| İşlem Defteri | Değişmez kayıt defteri, ters kayıtlar |

### Blok 2 — GÜNLÜK İŞ

**Operasyon** (`ops`) · alt: "Sipariş · depo · sevk"
| Ekran | Amaç | Ana bileşen |
|---|---|---|
| Sipariş Akışı `5` | Şube siparişlerini ilerlet | 4 kolonlu kanban |
| Sevkiyat Hazırlama `2` | Kalem kalem sevk kararı | Kalem listesi + tam/kısmi/yok seçimi |
| Teslimat Zinciri `2` | 4-nokta eşleşme (sipariş/teslim/fatura/ödeme) | Tablo |
| Depo Stok `2` | Kritik seviye takibi | Tablo |
| Bardak & Ürün Sayımı `5` | Fiziksel sayım girişi | Sayım kartları (− / adet / +, fark) |
| Stok Hareketi | Giriş/çıkış/düzeltme defteri | Tablo |

**Gelir & Kasa** (`para`) · alt: "Ciro · satış · kasa"
| Ekran | Amaç |
|---|---|
| Ciro Girişi | Şube bazlı günlük nakit/kart/fiş formu |
| Ürün Satışları | Ürün bazlı satış tablosu |
| Kasa Teslim `1` | Şube→merkez nakit teslimi |
| Dış Kaynak Geliri | Ciro dışı gelir (kiralama, eğitim, toptan) |

**Ödeme Merkezi** (`odeme`) · alt: "Vade · gider · bakiye"
| Ekran | Amaç |
|---|---|
| Bekleyen Ödemeler `8` | Öde / ertele kararı → onay modalı |
| Vade Takvimi | 14 günlük ödeme takvimi ısı ızgarası |
| Sabit Giderler `6` | Kira, enerji, bakım — tekrarlayan ödemeler |
| Anlık Gider | Plan dışı harcama kaydı formu |
| Tedarikçi Bakiyesi | Çapraz cari bakiye listesi |
| Ödeme Geçmişi | Kapanmış ödemeler |

**Onay Kuyruğu** (`onaylar`) · alt: "Bekleyen kararlar"
| Ekran | Amaç |
|---|---|
| Bekleyen Kararlar `5` | Gider/avans/fire/tanım onayları — toplu seçim destekli |
| Ciro Onayı `2` | Kasa–POS karşılaştırmalı ciro onayı |

### Blok 3 — FİNANS

**Kâr & Maliyet** (`maliyet`) · alt: "Marj · reçete · fiyat"
| Ekran | Amaç |
|---|---|
| Marj Özeti | KPI + hero grafik (brüt marj trendi) |
| Ürün Marjı | 34 ürünün marj tablosu |
| Reçeteler | Ürün başına maliyet kırılım kartları |
| Fiyat Zinciri `4` | Tedarikçi zammının etki günlüğü (zaman çizelgesi) |

**Borç & Kredi** (`kart`) · alt: "Kart · kredi · faiz"
| Ekran | Amaç |
|---|---|
| Borç & Faiz Özeti `1` | Kart durum şeridi + KPI |
| Kart Dosyaları | 5 kartın limit/faiz/borç tablosu |
| Banka Kredileri | 4 kredinin taksit/bitiş tablosu |
| Borç Koçu | Çığ/kartopu stratejisi + ödeme önerisi tablosu |
| Kart Hareketleri `2` | İşletme/şahsi sınıflandırma |
| Ekstre Durumu `1` | Yüklenen/eksik ekstre listesi |

**Finansal Sağlık** (`borc`) · alt: "BBE · ABEK · runway"
| Ekran | Amaç |
|---|---|
| Bu Ay Batıyor Muyum? `!` | Borç baskı endeksi göstergesi + runway kartları |
| Borç Takvimi · 36 ay | Aylık zorunlu yük eğrisi + ABEK çizgisi |
| Hedef Ciro & Ölçek | Senaryo tablosu |
| Şube Katkısı | Çift yönlü katkı grafiği (besleyen/boşaltan) |

### Blok 4 — KAYIT & KURULUM

**Personel & Vardiya** (`ekip`) — Kadro · Vardiya Planı `1` · Vardiya Takip · Görev Takibi `3` · Maaş & Avans `2` · İş Başvuruları `2` · Panel PIN & Görev QR

**Belge Merkezi** (`belge`) — Belge Kapsama `%71` · Fatura Arşivi · FTS · Fatura İstek · wa.me `4` · Mükerrer & Parmak İzi `2` · Cari Ekstre · Alış Fiyat Bandı · KDV Kanıt Paketi

**Tanımlar** (`tanim`) — Tedarikçiler · Tedarikçi Sözleşmeleri `1` · TV Menü Yönetimi

**Veri & Sistem** (`sistem`) — Excel Import · Bilgi Teslim `1` · Veri Temizle

### IA kuralları (implementasyonda korunmalı)

Bu yapı bilinçli bir temizlik turundan geçti; şu kurallar bozulmamalı:

1. **Tek entity → tek ekran.** Aynı varlığı iki ekranda listelemek yasak (Şube Karnesi ve Kontrol Kulesi bu yüzden birleştirildi; Bugünkü Bulgular ve Olay Yelpazesi bu yüzden birleştirildi).
2. **Tek sayı → tek ad.** Aynı rakam her yerde aynı etiketi taşır: `Açık cari bakiye` (364.790 ₺), `Toplam finansal borç` (1.575.900 ₺), `Toplam kart borcu` (443.500 ₺).
3. **Modül adı görünüm adını tekrarlamaz.** ("Onay Bekleyenler › Onay Kuyruğu" değil → "Onay Kuyruğu › Bekleyen Kararlar")
4. **Gelir ve gider ayrı modüllerde.** Gelir & Kasa yalnız gelen parayı, Ödeme Merkezi yalnız gideni tutar.
5. **Master data yalnız Tanımlar'da.** Sözleşme, fiyat listesi, tedarikçi kaydı operasyon modüllerine sızmaz.
6. **Tedarikçi üç ayrı eksende:** Tanımlar (kim) · Tanımlar › Sözleşmeler (hangi şartla) · Ödeme Merkezi (ne kadar borç).

---

## Bileşen kataloğu

Her görünüm, içerik tanımındaki bayraklara göre bu bloklardan bir alt kümeyi render eder.

### KPI kartı (`kpi`)

4'lük ızgara, `repeat(auto-fit, minmax(178px, 1fr))`, gap 12px.

```
┌──────────────────────────┐
│ ETİKET (10px caps)    ↗  │  ← yön oku: yeşil ↗ / kırmızı ↘
│ 78.420 ₺                 │  ← Mono 22px/700, ls -.6px
│ alt açıklama    ╭─╮      │  ← 11px + 74×24px sparkline
└──────────────────────────┘
```

- Sparkline: 14 noktalı, deterministik (etiket+değer'den seed'lenen sözde-rastgele seri, 3-nokta yumuşatma). Çizgi 1.6px `vector-effect: non-scaling-stroke`, altında `%14` alfa alan dolgusu.
- Sparkline rengi kartın anlam rengini izler; nötr kartlarda bakır (`#D29A5B`).
- Yön oku serinin ilk/son değerini karşılaştırır.

### Hero kartı (`hero`)

`1.5fr 1fr` ızgara. Solda: üst etiket, dev rakam (Mono 44px), delta pill'i (yeşil/kırmızı gradyan), açıklama, altında **etkileşimli alan grafiği**. Sağda: 4 tıklanabilir ikincil kart (dikey stack, hover'da `translateY(-2px)`).

Kart radius 20px, `padding: 22px 24px 0`, ek gölge `0 0 70px rgba(217,154,78,.07)` (bakır hâle).

### Etkileşimli grafik (hero + borç eğrisi)

`viewBox="0 0 640 120"`, `preserveAspectRatio="none"`, kapsayıcı `position: relative; cursor: crosshair`.

- `onMouseMove` → kapsayıcı genişliğine göre `t ∈ [0,1]`; en yakın veri noktası indeksi seçilir
- Crosshair: kesikli dikey çizgi `rgba(229,178,122,.45)`, `4 4` desen
- Nokta: `r=7`, dolgu `#E5B27A`, 4px zemin renkli çeper, `non-scaling-stroke`
- Tooltip: mutlak konumlu kart (radius 10px, bakır kenarlık); grafiğin sağ %38'inde otomatik sola döner (taşma engelleme). İçerik: `etiket · seri adı` (10px caps) + değer (Mono 14px/700). Borç eğrisinde ek satır: ABEK çizgisinin üstünde mi altında mı.
- **Değer, çizginin gerçek `y` koordinatından türetilir** (`min + (1 − y/120) × (max − min)`) — grafikle sayı her zaman tutarlı, ayrı veri seti tutulmaz.

### Tablo (`tablo`)

Kap: radius 16px, `overflow: hidden`. Başlık satırı: Fraunces 15.5px + sağda 11px ipucu.

- `<th>`: `padding: 10px 20px`, 10px/700 uppercase `#8B7B67`, alt kenarlık `#33251A`, **tıklanabilir**
- **Sıralama:** 1. tık artan (↑), 2. tık azalan (↓), 3. tık sıfırlar. Aktif kolon `#E5B27A` + ok. Modül/görünüm değişince sıfırlanır.
- Sıralama tipi otomatik: `tr-TR` sayı çözümü başarılıysa sayısal, değilse `localeCompare(…, 'tr')`. Oran ifadeleri (`4 / 5`) metin sayılır.
- `<td>`: `padding: 12px 20px`, 12.5px, alt kenarlık `#2A1E13`. Varyantlar: düz · mono (nowrap) · kalın · sağa dayalı · renkli · **rozet** (pill) · **bar** (82×6px ray + değer)
- Satır: `cursor: pointer`, hover `rgba(217,154,78,.07)`, tıklama → çekmece
- Yatay kaydırma: `min-width: 720px`

### Liste (`liste`)

Dikey stack, gap 7px. Satır: `padding: 13px 16px`, radius 14px, `align-items: center`, gap 15px.

Şiddet katmanı (`tier`) satırın kenarlık + zeminini belirler:

| tier | Kenarlık | Zemin | Şerit |
|---|---|---|---|
| `kritik` | `rgba(248,113,113,.32)` | `linear-gradient(165deg,rgba(248,113,113,.09),#221809)` | `#F87171` |
| `uyari` | `rgba(251,191,36,.30)` | `linear-gradient(165deg,rgba(251,191,36,.07),#221809)` | `#FBBF24` |
| `bilgi` | `rgba(243,233,220,.10)` | `linear-gradient(168deg,#2B2014,#20170B)` | `#3A2C1E` |

Yapı: 3×34px şerit → *(seçim kutusu)* → başlık + alt açıklama → tutar (Mono) → aksiyon butonları (Öde/Ertele · Onayla/Reddet · özel aksiyon · durum rozeti).

### Toplu seçim

Onay ve ödeme listelerinde:
- Liste başında "Tümünü seç" satırı (16px kutu + "karar bekleyen N kayıt")
- Her uygun satırda 18px kutu, radius 5px; işaretli: zemin `#D29A5B`, `✓` `#1C1309`
- Seçim varken **yüzen çubuk** (alt orta, z-205): sayı (Mono 15px `#E5B27A`) · "kayıt seçildi" · ayırıcı · **Tümünü onayla** (yeşil) · **Reddet** (kırmızı çerçeve) · **Temizle**
- Toplu işlem sonrası toast'ta **Geri al** (5.2s)

### Boş durum

Kuyruk boşaldığında: kesikli çerçeve (radius 16px), 38px bakır çerçeveli daire içinde `✓`, Fraunces 17px başlık, 12.5px açıklama (max 380px, ortalı).

### Diğer özel bloklar

| Blok | Açıklama |
|---|---|
`gauge` | Borç baskı endeksi — SVG yarım daire, 15px kalınlık, kırmızı yay + merkezde Mono 38px skor, altında 4 bileşen çubuğu |
`egri` | 36 aylık zorunlu yük eğrisi + yeşil kesikli ABEK çizgisi (y=58) + sarı zirve noktası + kredi bitiş çipleri |
`selale` | "Kâr nasıl oluştu" — `190px 1fr 140px` ızgara, 20px yatay çubuklar, satır tıklanabilir |
`katki` | Şube katkısı — merkez ekseni etrafında çift yönlü çubuklar |
`strateji` | Borç koçu — çığ/kartopu seçimi + öncelik kartı + 7 kolonlu öneri ızgarası |
`kanban` | 4 kolon, min-height 280px; kart hover `translateY(-2px)`; kartta "sonraki aşama" butonu |
`takvim` | 7 kolonlu ızgara, min-height 84px hücreler, tutara göre renklenir |
`vardiya` | `104px + repeat(7, minmax(112px,1fr))` ızgara; boş slotlar kesikli sarı çerçeve |
`recete` | `minmax(330px,1fr)` kartlar; noktalı satır dolgusu, marj rozeti |
`zincir` | Zaman çizelgesi — 22px nokta kolonu + dikey çizgi + değişim/etki metni |
`sayim` | `minmax(250px,1fr)` kartlar; − / adet / + kontrolü, fark satırı (0 yeşil, − kırmızı, + sarı) |
`sevkiyat` | Kalem listesi + kalem başına tam/kısmi/yok seçenekleri |
`form` | `1.3fr 1fr` — solda 2 kolonlu form, sağda son kayıtlar + bilgi kutusu |
`dropzone` | Kesikli bakır çerçeve, `padding: 44px 24px`, ortalı |
`tvOnizleme` | 3 ekran mock'u, `aspect-ratio: 16/10`, noktalı fiyat listesi |
`serit` | Yatay durum çipleri |
`kapsamaBar` | Tek yığılmış çubuk (16px, yeşil/kırmızı) + oran açıklamaları |
`arama` | FTS arama çubuğu + dizin sayısı |

---

## Detay çekmecesi (448px, sağdan)

Herhangi bir kart/satır/hücre tıklamasında açılır. `max-width: 92vw`. Arkasında `rgba(10,6,2,.6)` + `blur(3px)` perde (perde **kardeş** eleman — içeriğe tıklama kapatmaz).

**Yapı:**

1. **Başlık** (`padding: 20px 22px 16px`, alt kenarlık): kayıt tipi (10px caps) · başlık (Fraunces 20px) · alt satır (12px) · sağda 30px kapatma butonu
2. **Sekme kontrolü** (`margin: 14px 22px 0`): **Özet · Belgeler · İz** — segment stili, her açılışta Özet'e döner
3. **Gövde** (kaydırılabilir, `padding: 18px 22px 22px`, gap 18px):
   - **Özet:** 2×2 KPI ızgarası (iç yüzey `#2A2015`, radius 12px) → başlıklı detay listesi → bakır karar notu
   - **Belgeler:** bağlı dosya listesi (34px uzantı ikonu `PDF`/`JPG` bakır çerçeveli, ad + boyut, doğrulama rozeti) + altında kesikli PDF önizleme alanı
   - **İz:** *İşlem izi* — 4 halkalı zaman çizelgesi (Sistem → doğrulama → denetim motoru → bekleyen onay). Her halka 9px, renk kodlu, `0 0 0 3px` hâle; son halka içi boş (`inset 0 0 0 1.5px`) = "bekliyor". Başlıkta "değişmez kayıt · geri alınamaz". Altında *Dosya bilgisi* — kayıt no (Mono), kaynak modül, son güncelleme, dosya sahibi
4. **Alt bar** (üst kenarlık, `rgba(18,12,7,.5)`): birincil aksiyon (esnek) · **Not ekle** · **Esc**

---

## Onay modalı (466px)

Para hareketi doğuran işlemler için. Perde `rgba(10,6,2,.7)` + `blur(5px)`; **diyalog gövdesi `stopPropagation` yapar** — içine tıklamak kapatmaz, yalnız perde/Vazgeç/Esc kapatır.

1. **Başlık:** işlem tipi (10px caps) · "Ödemeyi onayla" (Fraunces 19px) · tedarikçi + kalem satırı
2. **Tutar:** sol etiket / sağda Mono 28px/700
3. **Ödeme kaynağı:** 3 kolonlu seçim — Kasa / Garanti / Yapı Kredi, her biri ad + bakiye (Mono 10.5px). Seçili: bakır kenarlık `.6` alfa + `rgba(217,154,78,.12)` zemin
4. **Özet satırları:** valör tarihi · *seçilen kaynağın* ödeme sonrası bakiyesi (yeşil, seçime göre canlı değişir) · cari bakiye kapanış durumu
5. **Bilgi kutusu (mavi):** "Kayıt işlem defterine yazılır… silme yoktur, ters kayıt gerekir"
6. **Alt bar:** solda "Enter ile onayla · Esc ile vazgeç" · **Vazgeç** · **Öde ve kaydet**

---

## Komut paleti (580px)

`⌘K` / `Ctrl+K` / `/` ile veya başlıktaki arama alanına tıklayarak açılır. Üstten `12vh`, z-150.

- **Arama alanı:** bakır arama ikonu + 15px girdi ("Modül, ekran veya kayıt ara…") + sağda `esc`
- **Sonuçlar** (`max-height: 46vh`, `overflow-x: hidden`): 14 modülün tüm ekranları (40+ kayıt). Satır: 74px blok etiketi (9px caps) · ekran adı (13.5px/600) + modül adı (11px) · rozet · seçiliyse `↵`
- **Türkçe karakter duyarsız arama** — `çğıöşüâîû` → ASCII karşılığına indirgenir; `maas` → "Maaş & Avans" bulur
- **Boş durum:** "Eşleşen ekran yok" + aranan terim
- **Alt bar:** `↑↓ gez · ↵ aç · esc kapat` · sağda toplam ekran sayısı
- `↑↓` seçim, `Enter` git, hover da seçimi taşır

---

## Etkileşim ve davranış

### Dönem seçici (Gün / Hafta / Ay)

- Yalnız dönem duyarlı modüllerde görünür: `panel`, `para`, `odeme`, `maliyet`, `rapor`, `borc`
- Katsayılar: Gün ×1, Hafta ×6.4, Ay ×27.8
- **Tüm `₺` değerlerini gerçekten ölçekler** (KPI + hero) — `tr-TR` biçimini koruyarak, regex ile sayıyı ayıklayıp yeniden biçimlendirir
- Gün dışındaki dönemlerde içeriğin üstünde mavi bilgi şeridi: *"Rakamlar bu ay dönemine ölçeklendi — günlük kesin veri için Gün sekmesi"*

### Klavye

| Tuş | Davranış |
|---|---|
| `⌘K` / `Ctrl+K` / `/` | Komut paletini aç |
| `Esc` | Katmanları sırayla kapat: palet → modal → çekmece → toplu seçim. Girdi içindeyse önce odağı bırakır |
| `Enter` | Modal açıkken onayla |
| `↑` `↓` | Palet içinde gez |
| `j` / `k` | Modül içinde bir sonraki / önceki görünüme geç |
| `Tab` | Ray, görünüm listesi, dönem seçici, liste satırları, seçim kutuları, sekmeler |
| `Enter` / `Space` | Odaklı öğeyi tetikle |

### Erişilebilirlik

- Tıklanabilir tüm `div`'lerde `role` (`button` / `checkbox` / `tab` / `option`) + `tabindex="0"` + `Enter`/`Space` işleyicisi
- Ray düğmelerinde `aria-label` (tam modül adı) ve `title`
- Grain katmanında `aria-hidden="true"`
- Görünür odak halkası: `2px solid #D29A5B`, offset 2px

### Duyarlı davranış

| Kırılım | Davranış |
|---|---|
| `≤ 1040px` | 222px görünüm kolonu gizlenir; yerine içerik üstünde yatay kaydırılabilir **çip satırı** gelir (pill çipler, aktif olan bakır çerçeveli + rozetli) |
| `≤ 720px` | Modül rayı 74px → 56px |

Başlık çubuğu `flex-wrap: wrap`; başlıklar tek satır + ellipsis; arama `clamp(160px,18vw,230px)`.

### Bildirim (toast)

Alt orta, z-210. Zemin `#312415`, bakır kenarlık, 7px bakır nokta + mesaj. Geri alınabilir işlemlerde **Geri al** butonu ve 5.2s ömür; diğerlerinde 2.6s.

---

## State yönetimi

Tek bileşende tutulan durum (implementasyonda store/context'e taşınabilir):

| Anahtar | Tip | Açıklama |
|---|---|---|
| `mod` | `string \| null` | Aktif modül id'si (null → ilk modül) |
| `view` | `string \| null` | Aktif görünüm id'si (null → modülün ilk görünümü) |
| `donem` | `'gun' \| 'hafta' \| 'ay'` | Dönem seçimi |
| `cekmece` | `{ tip, id } \| null` | Açık detay çekmecesi |
| `sekme` | `'ozet' \| 'belge' \| 'iz'` | Çekmece sekmesi |
| `modal` | `string \| null` | Onay modalındaki ödeme id'si |
| `modalKaynak` | `string` | Seçili ödeme kaynağı (varsayılan `garanti`) |
| `palet` | `boolean` | Komut paleti açık mı |
| `paletQ` | `string` | Palet arama terimi |
| `paletI` | `number` | Palet seçili satır indeksi |
| `sirala` | `{ kol, yon } \| null` | Tablo sıralaması (yon: 1 artan, −1 azalan) |
| `secili` | `Record<string, true>` | Toplu seçim |
| `onaylanan` | `Record<string, 'onay' \| 'red'>` | Onay kararları |
| `odenen` | `Record<string, true>` | Ödenen kayıtlar |
| `siparis` | `array` | Kanban sipariş aşamaları |
| `graf` | `{ ad, t } \| null` | Grafik hover konumu |
| `toast` | `string \| null` | Bildirim mesajı |
| `geriAlVar` | `boolean` | Toast'ta geri al butonu |
| `sirala` sıfırlanır | — | Modül/görünüm değişiminde `sirala` ve `secili` temizlenir, içerik en üste kaydırılır |

**Veri gereksinimleri (API):** modül/görünüm bazlı içerik (KPI seti, tablo, liste, özel blok verileri) · çekmece detayı (tip + id → özet, bağlı belgeler, işlem izi) · onay/ödeme/sevk mutasyonları · dönem parametreli sorgular.

---

## Assets

- **İkonlar:** 16 adet inline SVG, 24×24 viewBox, `stroke-width: 1.7`, `stroke-linecap/linejoin: round`, `fill: none`. Lucide tarzı; hedef kod tabanında mevcut ikon kütüphanesiyle eşleştirilebilir (gösterge, radar, banknot, para, ekip, grafik, kart, pusula, banka, işlemci, onay, kahve, klasör, anahtar, dosya).
- **Fontlar:** Google Fonts (Instrument Sans, Fraunces, JetBrains Mono) — production'da self-host önerilir.
- **Grain dokusu:** inline SVG `feTurbulence` data-URI — harici görsel yok.
- **Raster görsel yok.**

---

## Files

| Dosya | İçerik |
|---|---|
| `Evvel ERP v2.dc.html` | **Ana tasarım referansı** — koyu tema, 14 modül, tüm bileşenler ve etkileşimler. Tarayıcıda doğrudan açılır. |
| `Evvel ERP (acik tema v1).dc.html` | Önceki açık tema (krem/latte) sürümü — yalnız tarihsel referans, güncel değil. |

Ana dosyada tasarım verisi ve mantığı şu yapılarda toplanmıştır: `IK` (ikonlar) · `MODULLER` (IA ağacı, blok etiketleri) · `ICERIK` (`'modül.görünüm'` anahtarlı ekran tanımları) · `CEKMECE` (detay içerikleri) · `R` (renk sabitleri) · `GRAF` (grafik ölçekleri) · `IZ` (işlem izi şablonu) · yardımcılar `kpi() / th() / td() / liste()`.
