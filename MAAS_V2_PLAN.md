# MAAŞ V2 — BİRLEŞİK PLAN
*Fable (mimari + yol haritası) + GPT (ücret modeli + hukuk) + sahip kararları · 2026-09-06*

---

## 0 · SAHİP KARARLARI (bağlayıcı)

1. **V2 kurulacak, V1 TAMAMEN kaldırılacak.** Paralel yaşatma yok.
2. **Deniz vakası V2'de doğrulanacak.** → `scripts/test_bordro_kabul.py`
   V2, `kabul_bordro.json` vakalarını **kuruşu kuruşuna** üretemeden V1 silinmez.
3. **Yemek = KOŞULLU HAK, kesinti DEĞİL.** Sözleşme lafzı: *"molasına zamanında
   giren personele yemek ücreti ödenir."* → İş K. m.38 (ücret kesme cezası)
   kapsamı DIŞINDA.
4. Tam zamanlı günlük **9,5 saat**; saatlik **99 ₺** (= net asgari / 285).
5. Asgari ücret **tek yerden** değişince herkese uygulanmalı; asgari üstü
   bireysel anlaşmalar bozulmamalı.

---

## 1 · FABLE ile GPT NEREDE ANLAŞIYOR (tasarım kapandı)

| konu | ortak hüküm |
|---|---|
| Karar | Çekirdek **yeniden yazılır**, kanıt tabloları (vardiya/yoklama/mola/izin/ödeme) **kalır** |
| Ölçek | Modüler monolit. Mikroservis / event sourcing 30 kişi için **aşırı** |
| Defter | Net değil **KALEM** saklanır; her kalem kaynak + kural sürümü + kanıt taşır |
| Ücret | **Tarih aralıklı** (effective-dated); geçmiş dönem eski tutarla |
| Geçmiş | Kapanmış dönem **yeniden yazılmaz**; fark açık döneme düzeltme kalemi |
| Veri yokluğu | **Missing data ≠ zero entitlement.** Kanıt yoksa kesinti yok |
| Fren | Veri girmemek **parayla değil görünürlükle** engellenir |
| İlk iş | Kod değil — **golden/kabul veri seti** (GPT: *"bu vakaları kuruşu kuruşuna üretemiyorsa canlıya çıkamaz"*) |

**→ Tasarım tartışması bitti. İkisi bağımsız çalışıp aynı yere vardı.**

---

## 2 · ÜÇ AYRIM — hangisini alıyoruz

### 2.1 Ücret modeli → **GPT'nin ayrımı + Fable'ın tablosu**
GPT dört tip öneriyor, Fable iki mod. GPT'ninki daha açık; Fable'ın tablosuna
oturuyor:

```sql
ucret_tanim(kapsam, personel_id, tur, mod, tutar, fark, gecerli_bas, gecerli_bit)
```
| GPT tipi | `mod` | `tutar` / `fark` |
|---|---|---|
| `MINIMUM_WAGE` | `ASGARIYE_BAGLI` | fark = 0 |
| `MINIMUM_PLUS_FIXED` | `ASGARIYE_BAGLI` | fark = +4.000 |
| `FIXED_MONTHLY` | `SABIT` | tutar = 38.000 |
| `HOURLY` | `SABIT` (tur=SAATLIK) | tutar = 99 |

⚠️ **99 ₺ TÜRETİLMİŞ olmalı**, sabit değil: `net_asgari / (9,5 × 30)` = 98,51.
Bugün koda gömülü — asgari artınca kendiliğinden artmıyor.

### 2.2 Müdür → **GPT'nin iki boyutu**
Fable tek alan (`hakedis_modeli`) öneriyor; GPT iki boyut:
```
pay_basis         : MONTHLY | HOURLY | DAILY
attendance_policy : SHIFT_BASED | ATTENDANCE_BASED | MANAGERIAL
```
GPT'ninki tercih edilir: *ücret nasıl hesaplanır* ile *devam nasıl ölçülür*
farklı sorular. Müdür = `MONTHLY` + `MANAGERIAL` → "vardiya yok = maaş yok"
bağımlılığı yapısal olarak biter.

### 2.3 V1 kaldırma → **sahip kararı, Fable'ın adımıyla**
GPT uzun shadow mode istiyor; sahip paralel yaşatma istemiyor.
Fable'ın Adım 5'i (gölge hesap, para eski yoldan) **kısa bir shadow**dur ve
Adım 6 kesimdir. Uzlaşma: gölge **1 gece senkron** koşar, 4 ay 0 fark
görülür, sonra kesim.

---

## 3 · 🔴 FABLE'IN PLANINDA DÜZELTİLECEK NOKTA

Fable hâlâ `YEMEK_KESINTI` diye **negatif kalem** öneriyor
(Bölüm 2.4, Adım 7). Sahip lafzı doğruladı: **hak doğmaması.**

```
❌ YEMEK 7.000 (+) · YEMEK_KESINTI −269 (−)      → bordroda "kesinti" görünür
✅ YEMEK = hak DOĞAN günlerden toplanır (tek +)   → kalem yok, kanıtta gerekçe
```
`bordro_kalem.tur` listesinden `YEMEK_KESINTI` **çıkar**.
Kanıt JSONB: `{"hak_dogan_gun":24, "hak_dogmayan":{"2026-09-03":"mola_asim"},
"sozlesme_maddesi":"<madde>"}`
`bordro_kural.gerekce` = **sözleşme maddesinin metni** ("yönetim kararı" değil).

*(Matematik aynı; değişen kayıt biçimi ve hukuki duruş.)*

---

## 4 · FABLE'IN BULDUĞU YENİ CANLI HATALAR

| # | hata | bugün ne oluyor |
|---|---|---|
| 1 | **Bayram + fazla mesai aynı gün → ÇİFTE ÖDEME** | Sahip bayram saatini elle ×2 girer; plan >9,5 ise aynı saat FM ×1 olarak DA eklenir |
| 2 | **Devamsızlıkta fazla mesai ödeniyor** | Gelmediği gün plandan FM üretiliyor |
| 3 | **Plansız çalışma oranı bozuyor** | Yoklama var/vardiya yok → yemek oranı >1 olabilir |
| 4 | **Çıkışta kalan avans kayboluyor** | `mahsup_devir` sonraki döneme yazılır; sonraki dönem yoksa alacak yok olur |
| 5 | **Geriye dönük çıkış tarihi** | Ödenmiş ay dokunulmaz → fazla ödeme sessiz kalır |
| 6 | **Ölü dal** | "1-9 Haziran 2025" dalı hiç çalışmıyor (sistem 2026-06-01 başlıyor) |
| 7 | ~~`personel_maliyet.py` ölü~~ **ÖLÜ DEĞİL** (Adım 0'da ölçüldü) | `operasyon_merkez_api.py:27,16266` + `borc_navigasyon_api.py:315` çağırıyor — **üçüncü yemek formülü CANLI**, V2 kapsamına giriyor |
| 8 | **Part-time tam gün eşiği iki farklı** | 9,4 vs 9,5 |

---

## 5 · YOL HARİTASI (11 adım · ~12 gün · 8-9 deploy)

| # | adım | değer | risk | kapı |
|---|---|---|---|---|
| ~~0~~ | ✅ **Golden dondurma + 4 ölçüm** — BİTTİ (`2df2339`) (ücretsiz izin sayısı · müdür adayları · Eylül kayıt-yok günleri) | sonraki her adımın çıpası | yok | — |
| ~~1~~ | ✅ **Şema açılışı** — BİTTİ (`9057d14`) 4 tablo + 7 kolon, boş açıldı | — | düşük | golden 0,00 ✅ |
| ~~2~~ | ✅ **`ucret_tanim` çözücü + uç + kuru backfill** — BİTTİ (`bb7ef4a`) | **asgari merkezî olur** | düşük | golden 0,00 ✅ |
| 3 | `bordro_kural` tohum + çözücü | 9,5/30/5,5 koddan çıkar | düşük | — |
| 4 | Kanıt toplayıcı + `mola_durum` 5 hal + hakediş modeli | **Eylül'de kimin belgesiz olduğu görünür** | düşük-orta | — |
| 5 | Saf motor + **GÖLGE hesap** (para eski yoldan) | kalem defteri okunabilir | orta | golden 0 fark |
| **6** | **KESİM: net = Σ kalem · V1 SİLİNİR** | tek beyin | orta | ★ TEK YÖNLÜ |
| **7** | Kural değişikliği **VERİ olarak** (kayıt-yok ≠ ihlal · payda · ücretsiz izin) | **Eylül'de 3 kişinin yemeği** | yüksek (para) | ★ TEK YÖNLÜ |
| **8** | Durum makinesi + onaylı-sapma + düzeltme defteri | **Temmuz farkı yasal yoldan kapanır** | orta | ★ TEK YÖNLÜ |
| 9 | `odeme_plani.bordro_id` + backfill | kilit çakışması biter | düşük | — |
| 10 | Ekranlar (kalem paneli · ücret/kural sekmesi · personel telefonu) | sahip ve personel kanıtı görür | düşük | — |
| 11 | Temizlik + devir notu | — | yok | — |

**Her adımda:** kuru çalıştırma → `kapi_kontrol.py` → `test_bordro_kabul.py` →
deploy → canlı ölçüm. Üç tek yönlü kapının üçü de kuru liste + golden 0-fark +
kabul testi arkasında.

**V1 silinmeden önce kabul testi 3 → 9 vakaya çıkar** (GPT'nin şartı).

---

## 5b · ADIM 0 SONUÇLARI (2026-09-06, `2df2339`)

Çıpa: 4 dönem · 46 kişi · `--karsilastir` **0,00 fark** ✅
```
2026-06  18 kişi  252.957,02      2026-08   9 kişi  172.743,27
2026-07  11 kişi  228.622,82      2026-09   8 kişi   47.581,06
```
| ölçüm | sonuç |
|---|---|
| Ücretsiz izin | **0 kayıt** → kusur LATENT, bugüne kadar fazla ödeme yok. (86 mazeret izni, hepsi 1 günlük) |
| AYLIK_SABIT adayı | **2 kişi — sahip ONAYLADI**: `mehmet ucak` (MÜDÜR 35.000) · `MERVE KARABACAK` (MÜDÜR+yönetici 32.000) |
| Eylül mola kaydı yok | **5 kişi**: emir efe eraydın 6/6 · ersan kazan 5/5 · gökçe değirmenci 5/5 · naz dal 5/5 → yemek **0,00**; MERVE AKTA 2/5 → 840,00 |
| `personel_maliyet.py` | ❌ **ÖLÜ DEĞİL** — Fable yanılmış; iki canlı çağıran var, V2 kapsamına GİRİYOR |

---

## 5c · ADIM 2 TAMAMLANDI (2026-09-06)

`ucret_tanim` DOLDU — **56 satır**, `ayna_kalan = 0`, `hazir = true`.
Golden 0,00 × 4 · kabul 3/3 korundu (hiçbir rakam değişmedi).

| karar | sahip | uygulama |
|---|---|---|
| Asgari ücret | **28.075 ₺** | GENEL/ASGARI, `gecerli_bas 2026-06-01` |
| Ayrılanlar | "TALHA VE YILMAZ ZATEN AYRILDILAR AMA MAAŞLARI BUYDU" | pasif personel HER ZAMAN `SABIT` (donuk) — 22 kişi |
| Aktif + tam asgari | "bir kere değiştiğinde HEPSİNE BİRDEN uygulanmalı" | `ASGARIYE_BAGLI` fark 0 — SILA AKBAY, gökçe değirmenci |
| Diğer tutarlar | "4 KİŞİNİN MAAŞLAR DOĞRU" | kart tutarı birebir `SABIT` |
| MERVE KARABACAK | "MERVE MAAŞ 35 SADECE" | **32.000 → 35.000, 1 Eylül'den** |

**Zaman çizgisi ilk kez gerçek bir vakada kanıtlandı** — Merve Karabacak:
```
2026-06-15 → 32.000    2026-08-15 → 32.000
2026-07-15 → 32.000    2026-09-15 → 35.000
```
Zam geçmişi kaydırmadı. Haziran/Temmuz 32.000 olarak ödenmişti; eski sistemde
kartı 35.000 yapmak bu iki ayı da 35.000 gösterir, 6.000 ₺ sahte borç doğururdu.

### 🔴 ADIM 2'DE ÇIKAN YENİ CANLI BULGU — kayıtlı satır canlı hesabı EZİYOR

`main.py:10601` → `if kayit: net = kayit['hesaplanan_net']`. `personel_aylik`
satırı varsa canlı hesap YOK SAYILIR. Kart değişince bordro kendiliğinden
yenilenmiyor; `POST /api/personel-aylik/vardiya-sync` elle çağrılmadıkça eski
rakam ödenir. Eylül 2026 ölçümü (hepsi `taslak`, henüz ödenmedi):

| kişi | kayıtlı | canlı | fark | neden |
|---|---|---|---|---|
| MERVE KARABACAK | 6.400,00 | 7.636,00 | +1.236,00 | zam işlenmemiş |
| mehmet ucak | 7.000,00 | 8.400,00 | +1.400,00 | **yemek düzeltmesi işlenmemiş** |
| SILA AKBAY | 6.548,33 | 7.015,00 | +466,67 | yemek düzeltmesi işlenmemiş |
| MERVE AKTA | 6.066,67 | 6.440,00 | +373,33 | yemek düzeltmesi işlenmemiş |
| **TOPLAM** | | | **+3.476,00** | |

⚠️ `1034202`/`b17457c` yemek düzeltmeleri KAYITLI SATIRLARA ULAŞMAMIŞ. Eylül bu
hâliyle ödenirse **3.040 ₺ eksik** ödenir. Ödeme öncesi senkron ŞART.
⏳ SAHİP KARARI: Eylül senkronu çalıştırılsın mı.

---

## 5d · ADIM 5 (ÜCRET EKSENİ) TAMAMLANDI (2026-09-06, `b33f5bf`)

Motor artık ücreti **hesaplanan DÖNEMİN tarihine göre** çözüyor
(`gorev_api.vardiya_takip` → `bordro_ucret.sozlesme_coz`, savepoint içinde).
Çıktı `ucret_kaynagi` + `ucret_tarihi` taşıyor.

**Canlı kanıt — MERVE KARABACAK Ağustos 2026:**
```
Adım 5 öncesi   taban 35.000  → net 38.180   ❌ (Eylül zammı Ağustos'a sızmış)
Adım 5 sonrası  taban 32.000  → net 35.180   ✅
```
Diğer 6 kişinin tabanı DEĞİŞMEDİ; hepsinin kaynağı artık `ucret_tanim`.
Golden 0,00 × 4 · kabul 3/3.

⚠️ **Adım 5'in bu parçası ücret eksenidir.** Planın "saf motor + kalem defteri
+ gölge hesap" parçası HENÜZ YAPILMADI — `bordro_kalem` hâlâ boş.

### ⛔ AĞUSTOS 2026 SENKRONLANAMAZ — kalan sapmalar ÖLÇÜM kaynaklı

| kişi | kayıtlı | canlı | fark | engel |
|---|---|---|---|---|
| MERVE AKTA | 3.733,33 | 32.000,00 | +28.266,67 | kayıt **ONAYLANMIŞ** · planlı 7 gün |
| DENİZ KÜÇÜKKIRLI | 57.550,00 | 35.075,00 | −22.475,00 | ayrılmış · planlı 6 gün |
| nisanur bolat | 14.511,70 | **0,00** | −14.511,70 | part-time, vardiya/saat yok → **sıfırlanır** |
| YAĞIZ ERKEK | 15.162,00 | 7.015,00 | −8.147,00 | ayrılmış · planlı 0 gün |
| SILA AKBAY | 17.988,33 | 24.988,33 | +7.000,00 | yemek düzeltmesi (gerçek) |
| YAREN BEŞLİ | 24.795,83 | 29.229,17 | +4.433,34 | yemek düzeltmesi (gerçek) |
| MEHMET EFE | 3.743,33 | 7.015,00 | +3.271,67 | kayıt **ONAYLANMIŞ** · ayrılmış |
| MERVE KARABACAK | 32.000,00 | 35.180,00 | +3.180,00 | yemek düzeltmesi (gerçek) |

Toplu senkron: iki onaylı kaydı ezer, bir part-time'ı sıfırlar, ayrılanların
son dönem hakedişini bozar. **Yapılmamalı.** Bunlar Adım 4 (kanıt toplayıcı +
çıkış tarihi + part-time saat kaynağı) ve Adım 8 (düzeltme defteri) işidir.

Eylül'de bu tehlike yoktu: hepsi `taslak`, ölçümleri tutarlı, senkron öncesi
kişi kişi ölçüldü, sonrası tahminle **birebir** uyuştu (+3.476,00).

---

## 5e · ADIM 4 TAMAMLANDI (2026-09-06, `8217c6b`)

Yemek hakkı artık **evet/hayır** değil, **NEDEN**. Beş hal:
`hak_dogdu` · `ihlal` · `belirsiz` · `kayit_yok` · `sozlesme_disi` (+ `vardiya_yok`).
Çıktı: gün bazında `mola_durum`, kişi bazında `mola_ozet` + `yemek_belgesiz_gun`.
Golden 0,00 × 4 · kabul 3/3 — **paraya dokunmadı**, kararı etiketledi.

### 🔴 EYLÜL 2026 — ÖLÇÜM SONUCU: İHLAL SIFIR

| kişi | planlı | hak doğdu | **ihlal** | kayıt yok | aldığı | kaybettiği |
|---|---|---|---|---|---|---|
| emir efe eraydın | 6 | 0 | **0** | 6 | 0,00 | 0,00 (sözleşmede yemek yok) |
| ersan kazan | 5 | 0 | **0** | 5 | 0,00 | 0,00 (sözleşmede yemek yok) |
| gökçe değirmenci | 5 | 0 | **0** | 5 | 0,00 | **1.400,00** |
| naz dal | 5 | 0 | **0** | 5 | 0,00 | **1.400,00** |
| MERVE AKTA | 5 | 3 | **0** | 2 | 840,00 | **560,00** |
| SILA AKBAY | 5 | 5 | **0** | 0 | 1.400,00 | 0,00 |
| | | | **0** | | | **3.360,00** |

**Hiç kimse mola kuralını ihlal etmemiş.** Kaybedilen her yemek günü bir KARAR
değil, KAYIT BOŞLUĞU. Eski sistem ikisini aynı gösterdiği için 3.360 ₺ sessizce
ödenmiyordu.

⏳ SAHİP KARARI (Adım 7'nin girdisi): mola kaydı olmayan gün ne sayılsın —
(a) hak doğmaz (bugünkü davranış) · (b) hak doğar, vardiya varsa çalışılmış
kabul edilir · (c) askıya alınır, sahip gün gün onaylar.
`emir efe eraydın` ve `ersan kazan` sözleşmesinde yemek kalemi olmadığı için
bu karardan etkilenmez.

---

## 5f · ADIM 7 TAMAMLANDI (2026-09-06, `77d69cc`) — KURAL ARTIK VERİ

Sahip önce **B** dedi (kayıt yoksa hak doğar), sonra kendisi düzeltti:
> "AMA MANTIKLISI SANKİ C GİBİ"

Haklı. **B kanıtsız para öder** — "vardiya var, o hâlde molasını da kullanmıştır"
bir VARSAYIMdır ve `UYDURMA YOK` doktrinine aykırıdır. Denetimde "bu 1.400 ₺ neye
dayanıyor?" sorusunun cevabı "sistem öyle varsaydı" olurdu.
**C'de sistem bilmediğini söyler, para bekler, sahip karar verir, karar iz bırakır.**

`bordro_kural` ilk gerçek satırını aldı — kural artık KODDA DEĞİL, VERİDE:
```
GENEL · mola_kayit_yok = 'askida' · gecerli_bas 2026-09-01 · id 4bf28bb7
2026-09-15 sorulunca → askida      (tablodan)
2026-07-15 sorulunca → hak_dogmaz  (varsayılan — GEÇMİŞ DOKUNULMADI)
```
Haziran–Ağustos ödenmiş/kapanmış olduğu için kural 1 Eylül'den geçerli.

### EYLÜL 2026 ONAY KUYRUĞU (canlı)

| kişi | planlı | askıda | gün ₺ | toplam ₺ | günler |
|---|---|---|---|---|---|
| gökçe değirmenci | 5 | 5 | 280,00 | **1.400,00** | 1, 2, 4, 5, 6 |
| naz dal | 5 | 5 | 280,00 | **1.400,00** | 1, 3, 4, 5, 6 |
| MERVE AKTA | 5 | 2 | 280,00 | **560,00** | 1, 2 |
| emir efe eraydın | 6 | 6 | 0,00 | 0,00 | sözleşmesinde yemek yok |
| ersan kazan | 5 | 5 | 0,00 | 0,00 | sözleşmesinde yemek yok |
| | | **23** | | **3.360,00** | |

Golden 0,00 × 4 · kabul 3/3 — **para hâlâ değişmedi**; hak kaybolmadı, KUYRUĞA
girdi. Onay verildiğinde `bordro_kalem`'e `eksen='KARAR'` satırı yazılır
(kim · ne zaman · hangi gerekçe); geri alma SİLMEZ, `durum='eski'` yapar.

Uçlar: `GET /api/ucret/mola-askida?yil=&ay=` · `POST /api/ucret/mola-onay`
(gerekçe ZORUNLU, varsayılan `kuru=true`).

### ✅ ONAY VERİLDİ (2026-09-06) — sahip: "3 KİŞİYİ BUGÜNE KADAR ONAYLAYABİLİRSİN"

12 gün onaylandı, `bordro_kalem`'e `eksen='KARAR'` · `kanit_sinifi='beyan'`
satırı olarak yazıldı (onaylayan: Fethi Karabacak).

| kişi | onaylanan gün | yemek önce | yemek sonra |
|---|---|---|---|
| gökçe değirmenci | 1,2,4,5,6 | 0,00 | **1.400,00** |
| naz dal | 1,3,4,5,6 | 0,00 | **1.400,00** |
| MERVE AKTA | 1,2 | 840,00 | **1.400,00** |
| | **12** | | **+3.360,00** |

Bekleyen: emir efe eraydın (6 gün) + ersan kazan (5 gün) — **0,00 ₺**,
sözleşmelerinde yemek kalemi yok, onay para üretmez.

Eylül `personel-aylik` senkronlandı: **51.057,06 → 54.417,06**. Senkron öncesi
kişi kişi ölçüldü, sonrası tahminle **birebir** uyuştu (+3.360,00). Ödeme planı
da güncellendi. Golden yeniden donduruldu; kabul testi 3/3.


---

## 5g · AĞUSTOS 2026 MUTABAKATI (2026-09-06) — banka ↔ sahip defteri ↔ Evvel

13 banka ekstresi (10 hesap) çözüldü; Ziraat'in 3 taranmış PDF'i `fitz` ile
PNG'ye çevrilip GÖZLE okundu (makinede OCR yok). Ayrıştırıcı, gözle okunan
sayfalarla **kuruşu kuruşuna** doğrulandı.

### Ödeme kaynağı
| kişi | sahip defteri | bankadan | elden |
|---|---|---|---|
| MERVE AKTA | 36.454 | 36.454,50 | — |
| DENİZ KÜÇÜKKIRLI | 33.912 | 33.911,50 | — |
| SILA AKBAY | 25.381 | 25.381,00 | — |
| YAREN BEŞLİ | 22.218 | 22.215,00 | — |
| MERT ALİ AKAR | 15.442 | 14.037,00 | 1.405,00 |
| NİSANUR BOLAT | 5.415 | 0 | 5.415,00 |
| EMİR EFE ERAYDIN | 4.320 | 0 | 4.320,00 |
| NAZ DAL | 1.170 | 0 | 1.170,00 |
| ERSAN KAZAN | 1.170 | 0 | 1.170,00 |
| | **145.482** | **131.999,00** | **13.480,00** |

Elden 5 kalem `anlik_giderler`'de: 2'sini bu oturum girdi (`elden` damgalı),
3'ü zaten vardı (`nakit` = belirsiz, damgası düzeltilmeli).

### Evvel Ağustos'ta düzeltilenler
| kişi | önce | sonra | ne yapıldı |
|---|---|---|---|
| MERT ALİ AKAR | 3.258,75 | **15.442,02** | saat 32,92 → 155,98 (ödenen ÷ 99,00), `elle` damgalı |
| nisanur bolat | 14.511,70 | **5.414,83** | saat 146,14 → 54,53 (ödenen ÷ 99,30) |
| SILA AKBAY | 17.988,33 | **20.988,33** | canlıya hizalandı; hakediş 24.988,33 − 4.000 avans |
| MERVE AKTA | 3.733,33 | **36.454,50** | gönderilen tutara hizalandı; kayıt taslağa düştü |

⚠️ MERVE AKTA'nın 4.454,50 ₺'lik düzeltmesinin **1.454,50 ₺'si açıklanamadı** —
denkleştirme kalemidir, gerekçesi bulununca ayrı kalem olmalı
([[feedback-dairesel-mutabakat-tuzagi]]).

### 🔴 KOD HATASI BULUNDU VE DÜZELTİLDİ (`0c41fd3`)
`POST /api/personel/{id}/cikis` → `cikis_tarihi = bugun_tr()`, **tarih parametresi
YOKTU**. Kaydedilen şey İŞLEMİN YAPILDIĞI GÜN, kişinin son çalıştığı gün değil.
Sahip: "SİSTEMDE AYRILMA TARİHİ DİYE BİR ALAN YOK, BAZEN GEÇ ÇIKIŞ YAPABİLİYORUZ."
Canlı bedeli: YAREN BEŞLİ çıkışı 25.08 damgalı → 29.229,17 ₺; sahip defteri
22.218 ₺ (≈19 gün) → **~7.000 ₺ fazla ödeme riski**.
Artık `tarih` parametresi var (fiilî son gün), başlangıçtan önce reddedilir,
mevcut yanlış tarih düzeltilebilir, eski/yeni değer audit izine yazılır.

### ⏳ AÇIK KALANLAR
- **YAREN BEŞLİ** fiilî son çalışma günü? (paradan ≈ 19 Ağustos)
- **DENİZ KÜÇÜKKIRLI** çıkışı 31.08 yazılı → 35.075; sahip defteri 33.912
- **naz dal · ersan kazan · emir efe eraydın** Ağustos'ta çalıştı ama kartlarında
  başlangıç **1 Eylül** → sistem onları Ağustos'ta HİÇ görmüyor
- 3 elden kaydın ödeme yöntemi `nakit` → `elden` damgalanmalı
- **Part-time hakedişi PLANLANAN vardiyadan türüyor**: CELİLE IŞIK 7 Eylül'de
  başlıyor ama 6 Eylül'de 18,98 saat / 1.869,86 ₺ görünüyor (durum
  `vardiya_tahmini`, henüz ödenmez ama ekranda kazanç gibi duruyor)

---

## 5h · AĞUSTOS KAPANDI + 7 KOD HATASI (2026-09-06 akşamı)

Ağustos 2026 artık sahibin defteriyle **kuruş farkıyla** örtüşüyor:

| kişi | sahip defteri | Evvel | durum |
|---|---|---|---|
| MERVE AKTA | 36.454,50 | **36.454,50** | ✅ onaylandı |
| DENİZ KÜÇÜKKIRLI | 33.912 | 33.911,50 | −0,50 |
| SILA AKBAY | 25.381 | 20.988,33 | hakediş 24.988,33 − 4.000 avans |
| YAREN BEŞLİ | 22.218 | 22.214,17 | −3,83 |
| MERT ALİ AKAR | 15.442 | 15.442,02 | +0,02 |
| nisanur bolat | 5.415 | 5.414,83 | −0,17 |

Elden ödenenler `anlik_giderler`'de, üçü `elden` damgalandı (6.660 ₺).

### Bugün bulunan ve kapatılan KOD hataları

| # | hata | canlı bedeli | commit |
|---|---|---|---|
| 1 | `cikis_tarihi = bugun_tr()` — işlem günü, son çalışma günü değil | YAREN 7.015 ₺ fazla ödeme riski | `0c41fd3` |
| 2 | Dönem oranında ÜÇ ayrı formül (30 vs takvim günü) | Ağustos %48,4 / Şubat %50 sapma | `bae9c95` |
| 3 | Kural parametrelerinin 8'i ÖLÜ, kapsam kör | kişi/şube kuralı hiç çalışmıyordu | `4756800` |
| 4 | Yemek paydası veri seyrekliğine bağlı | aynı ihlal 280 ↔ 1.166,67 ₺ | `b147fcf` |
| 5 | **GELECEK vardiya yemek paydasını şişiriyor** | SILA 763,64 ₺, ölçüm sırasında oldu | `4f995b7` |
| 6 | **Part-time GELECEK saat hakedişe giriyor** | CELİLE 5.755,68 ₺, işe başlamadan | `c609061` |
| 7 | **Kural satırları birleşmiyor, yenisi eskisini siliyor** | Eylül `askida` kuralı sessizce kayboldu | `94c220e` |
| + | `belirsiz` mola günü onaylanamıyordu | MERVE AKTA 1.000 ₺ | `c609061` |
| + | Avans tavanı kartı okuyordu, çizgiyi değil | geçmiş ayın tavanı zamla büyüyordu | `c24600d` |

**#5, #6 ve #7 aynı sınıf:** ölçüm sırasında, canlıda, kendi gözümüzün önünde
gerçekleşti. #7'yi kendi elimle yaptım (yeni kural yazarken öncekini sildim),
fark edip yapının kendisini düzelttim.

### Kural çizgisi (canlı)
```
GENEL · 2026-09-01 · mola_kayit_yok = askida
                     yemek_paydasi  = beklenen_gun
Ağustos ve öncesi → VARSAYILAN (hak_dogmaz · planli_gun)
```
`beklenen_gun` geriye uygulansaydı ihlali olan kayıtlarda Haziran–Ağustos
**+11.621,76 ₺** yeni borç doğardı → bilinçli olarak 1 Eylül'den başlatıldı.

### Personel ekranı doğrulaması
`GorevPersonelSayfasi.jsx:737` doğrudan `/api/gorev/vardiya-takip` çağırıyor,
kendi formülü YOK. Bugünkü düzeltmeler personelin telefonuna doğrudan yansıdı;
arayüz yeniden derlenmedi. Personel ekranda `yemek_ucret_gun`, `yemek_ucret_tutari`
ve gün gün `mola_durum` görüyor — yani #5 düzeltilmeseydi çalışan yemeğinin
sebepsiz üçte iki düştüğünü GÖRECEKTİ.

⏳ AÇIK: naz dal · ersan kazan · emir efe eraydın kartlarında başlangıç 1 Eylül
yazıyor ama Ağustos'ta çalıştılar (paraları elden kayıtlı, bordroda görünmüyor).

---

## 6 · KAPSAM DIŞI (bilinçli)
- Banka ekstre satırı + eşleşme → ayrı proje (`project_banka_mutabakat_2026_09`);
  banka PDF ayrıştırıcısı **yok**, Merve VakıfBank ekstresi bekleniyor
- Kıdem/ihbar tazminatı (GPT'nin listesinde var, ayrı final settlement)
- Fazla mesainin ölçüme geçişi → kural parametresi olarak kapı açık

---

## 7 · AÇIK KALAN ÜÇ SORU

1. ~~**28.075 asgari ücret mi?**~~ → ✅ **SAHİP TEYİT ETTİ (2026-09-06): 28.075 ₺.**
   `ucret_tanim` GENEL/ASGARI satırı yazıldı, `gecerli_bas = 2026-06-01`
   (id `14a6a977`). Golden 0,00 × 4 · kabul 3/3 korundu.
   ⏳ **Hâlâ açık:** hangi kişiler `ASGARIYE_BAGLI`, hangileri `SABIT`.
   Kuru liste (canlı, 2026-09-06): 54 satır · 14 kişi tam 28.075 (bağlanabilir) ·
   4 kişi asgari ÜSTÜ (mehmet ucak 35.000 · MERVE KARABACAK 32.000 ·
   RAMAZAN YILMAZ 30.500 · TALHA TUYGUN 30.500) → sabit mi, fark korunarak
   birlikte mi artsın.
   🔴 **BULGU:** 5 kişi 28.000 ₺ — asgariden 75 ₺ EKSİK. Mayıs'ta başlayanlar
   (SILA AKBAY · RÜMEYSA · irem) için "zamdan önceki tutar" olabilir; ama
   **MERVE AKTA (17.07)** ve **naz dal (01.09)** zamdan SONRA başlamış ve hâlâ
   28.000 → muhtemelen yazım eksiği, sahip teyidi gerekiyor.
2. **Kesinti paydası** — Fable 26 öneriyor (6 gün × 4,33). Sahip 30 diyebilir.
   Adım 7 kuru listesi iki seçeneği yan yana gösterecek.
3. ~~Temmuz'da ~9.000 ₺ açıklanamıyor~~ → **BÖYLE BİR AÇIK YOK (doğrulandı).**
   Fable 9 SÜREKLİ kişinin toplamını 11 KİŞİLİK gerçekle kıyaslamış; iki
   part-time (MERT ALİ AKAR 13.500,30 + nisanur bolat 1.337,24) sayıma girmemiş.
   Doğru hesap:
   ```
   Evvel yeni formülle   228.622,82 + 6.609,04 = 235.231,86
   Banka + sahip defteri 210.111,00 + 25.117,00 = 235.228,00
   FARK                                              3,86 ₺
   ```
   **Temmuz KAPALI.** Yemek düzeltmesi açığın tamamını kapatıyor.
   ⚠️ DERS: başka ajanın rakamını doğrulamadan aktarma.

---

## İLK ADIM — yarın sabah
**ADIM 0.** Hiçbir şey yazmaz, deploy istemez, yarım günde biter.
Haziran–Eylül dört ayın çıktısını dondur + üç ölçümü al.
Golden olmadan Adım 5-6'nın "0 fark" iddiası ölçülemez —
bu projede canlı `ciro` tablosu tam böyle silinmişti.
