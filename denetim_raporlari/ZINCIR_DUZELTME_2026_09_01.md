# ✅ SİPARİŞ ZİNCİRİ — DÜZELTME RAPORU
**Tarih:** 2026-09-01 · **Dal:** prod-denetim · **Kaynak:** `ZINCIR_DENETIMI_2026_09_01.md`

Denetimde bulunan ~70 madde sırayla düzeltildi. Aşağıda ne yapıldığı, kanıtı ve
bilinçli sapmalar var. **Hiçbir madde "yapıldı" diye işaretlenip atlanmadı** —
uygulanmayanlar ayrı başlıkta gerekçesiyle yazılı.

---

## A — ŞU AN CANLIDA KIRIK OLANLAR (hepsi kapandı)

| # | Bulgu | Yapılan | Kanıt |
|---|---|---|---|
| A-1 | `g_adlar` tanımsız → aktif devir varken `/cari-ozet` **500** | Tanım devir döngüsünün üstüne alındı (tek tanım) | `pyflakes fatura_api.py` temiz |
| A-2 | `logger` tanımsız → toptancı teslim kabulü **500** ve tamamı rollback | `import logging` + modül seviyesinde `logger` | `pyflakes sube_panel.py` temiz |
| A-3 | `yedek_zamani` her zaman `null` | `dt_now_tr().isoformat()` | — |
| **+A-4** | **`main.py:104/110` `logger` modül yüklenirken kullanılıyor** — izole router import'u patlarsa **uygulama hiç açılmıyordu** | `logger` router kayıtlarından ÖNCEye alındı | `pyflakes main.py` temiz |
| ~~+A-5~~ | ~~`/cari-odenecekler` rota gölgelenmesi~~ | ❌ **YANLIŞ ALARM — geri alındı** (aşağıda) | canlı ölçüm: uç zaten 200 dönüyordu |
| **+A-6** | `duyu_omurga.py` `date` importsuz · `k1_kart_odeme_tani.py` `logger` tanımsız | İkisi de eklendi | `pyflakes` temiz |

> A-4 ve A-6 denetim listesinde YOKTU — düzeltme sırasında `pyflakes` tüm
> repoya uygulanınca çıktı. **A-5 ise yanlış alarmdı** (aşağıya bakın).

---

## ❌ A-5 GERİ ALINDI — kendi yanlış alarmım

**İddia:** `/cari-odenecekler`, `/{fatura_id}` tarafından yutuluyor; ödeme
ekranının okuduğu uç 404 dönüyor.

**Gerçek:** Uç canlıda **çalışıyordu.** `curl` ile ölçüldü: 200 ve doğru gövde
(FEZ'in 3 açık faturası).

**Hatanın kaynağı:** Rota sırasını **satır numarasından** çıkarmıştım. Oysa
`fatura_api.py` dosyanın sonunda zaten küresel bir koruma taşıyor:

```python
router.routes.sort(key=lambda _r: 1 if "{" in getattr(_r, "path", "") else 0)
```

Parametreli yollar en sona alınıyor. Yani gerçek sıra satırdan okunamaz —
modül **yüklendikten sonra** `router.routes` okunmalıdır.

**Yapılan:** Eklediğim gereksiz sarmalayıcı geri alındı (yanlış gerekçeli bir
yorum bırakmak, fazladan koddan daha zararlıdır). Kapının 2. sınıfı **statik
tahminden çalışma zamanı ölçümüne** çevrildi.

**Yeni ölçüm — 23 router modülü, `router.routes` okunarak:**

```
TOPLAM CANLI GOLGELENME: 0
```

Bu sınıf sistemde **hiç yok**. Statik sürüm 1 hayalet üretmişti.

> **Ders:** bu denetimin kendi kuralı bana da işledi — *kendi rakamını sorgula,
> ölç*. Bir sınıfı "kapattım" demeden önce canlıda bakmak, listeye bakmaktan
> daha güvenilirdir.

---

## B — P0 (para / adet yanlış)

| # | Yapılan |
|---|---|
| B-1 | **SAVEPOINT: 64 → 0 riskli blok.** Yazan fonksiyon içindeki savepoint'siz yutulan SQL blokları `with savepoint(cur, …)` içine alındı; `siparis_olustu_kaydet` ×3, `eksik_kullanim_kontrol`, 10 defter/duyu bloğu dahil. Kalan 12 blok **kendi `with db()`'sini açıyor** (izole — zehirlenme imkânsız), ölçülerek doğrulandı. `siparis_kontrol_kulesi.py`'ye `savepoint` importu eklendi. |
| B-2 | **`/cari-ode` artık bakiyeye işleniyor.** Ödeme izi evrenine 4. kanal `cari_odeme (iptal=FALSE)` eklendi — hem `cari_ozet` hem `cari_ekstre`'ye (iki uç aynı evreni okur). `_cift_kanal_tekille` sistem kaydı kümesine `cari_odeme` eklendi (ekstre inince çift düşmesin). Tablo garantisi (`_ensure_cari_odeme_tablolar`) sorgudan önce. **Yeni ölçüm ucu: `GET /api/fatura/cari-ode-kanal-etkisi`** — hangi ödemelerin artık düştüğü tedarikçi başına listelenir (kuru çalıştırma karşılığı). |
| B-3 | **`/cari-ode` tek atomik akış.** Sıra değiştirildi: `odeme_plani + cari_odeme + cari_odeme_tahsis` **aynı transaction'da, PARADAN ÖNCE**; sonra `odeme_yap`. Hata yakalama `except HTTPException` → `except Exception` ve temizlik tahsis satırlarını da siliyor. Artık "para çıktı, fatura açık kaldı" hâli üretilemez. |
| B-4 | **Fazla kapama kapandı.** Tedarikçi bazlı `pg_advisory_xact_lock`; elle tahsiste kalan istek içinde düşülüyor (`_yerel_kalan`); geçersiz `fatura_id` / `tutar<=0` artık **400** (eskiden sessizce avansa dönüyordu). |
| B-5 | **Ekstre firma seçimi daraltıldı.** Düz alt-dize ve çift yönlü alt-küme kapıları kaldırıldı; tek ölçüt kelime-sınırlı `_odeme_eslesir` (çift yön korundu). "FEZ ⊂ FEZA GIDA" ve "{atalay} ⊂ ATALAY TEKSTİL" artık eşleşmiyor. |
| B-6 | **Kadife (v2) sevk ucu klasikle eşitlendi.** İstenen tavanı artık **motorda, talebin kendi kaydından** türüyor (`kalem_durumlari.istenen_adet`) — hangi uç çağırırsa çağırsın çalışır; **ilk sevkte de** tavan uygulanıyor (eskiden yalnız ikinci partide). `ValueError → 409`, sevk sonrası `durum='gonderildi'` + `sevkiyat_ts` yazılıyor. v2 kabul ucuna durum kapısı + yabancı kalem reddi + `ValueError → 409` eklendi; v2 tahsis ucuna da `ValueError → 409`. |
| B-7 | **`kalem_durumlari.urun_ad` senkronu.** `sync-urun-adlari` ve `urun-ad` artık **iki JSONB'yi birlikte** günceller. Ekran tarafı (kadife `OpsModulu.jsx` + klasik `SevkiyatHazirlama.jsx`) eşleşmeyi **önce kimlik, sonra Türkçe-duyarlı normalize ad** ile yapıyor. Ayrıca **motorda son savunma**: `depo_disi` damgalı kalem sevk edilirse `ValueError`. |
| B-8 | `sevkiyata-gonder`e **yoldaki mal freni**: talebin `stok_yolda` 'yolda' satırı varsa 409. |
| B-9 | Uyumsuzluk çözümündeki kapanış sayacı artık **'yolda' satırları da** sayıyor — zombi mal üretilemez. |
| B-10 | **Söz kapısı tek merkeze taşındı**: `SOZ_DEFTERI_URETIMI_ACIK` kontrolü `_fatura_kuyruk_uret`in ilk satırında. OCR ve yükle-pdf yolları artık kapıdan geçiyor. `zorla` parametresi çağrıdan motora geçiriliyor. |
| B-11 | Çoklu-faturalı PDF: `belge_talep.fatura_idler` (JSONB) eklendi, **tüm** faturalar teslimata damgalanıyor, bağ tekillik kontrolü çoklu listeyi de okuyor. |
| B-12 | **Bağ kanıtına kimlik eklendi**: tedarikçi adı uyuşmazsa 422; fatura başka talebe damgalıysa 422. (b) Çoklu-aday guard'ı beklenen tutar boşken tutar şartını **düşürüyor** (eskiden ±1 ₺'ye inip kör kalıyordu). |
| B-13 | Toptancı aggregate sorgusuna `durum <> 'iptal'` eklendi — geri alınan sevk hayalet olarak sayılmıyor. |
| B-14 | **Kalem iptali rezervi iade ediyor**: yeni `tahsis_rezerv_iade()` (operasyon_stok_motor) — `kalem_durumlari` damgalanır, rezerv depo/merkez kartından düşülür, yanıtta `iade_edilen_rezerv` döner. |
| B-15 | Tahsis okuma ve rezerv taşıma anahtarı **simetrik**: `kalem_kodu → urun_id → normalize ad`. `urun_id`'siz kalemin rezervi artık kaybolmuyor. |
| B-16 | Uzlaştırma **stok üretemiyor**: kaynak yetersizse `GREATEST(0,…)` ile sessizce kırpmak yerine 409 + gerçek rakamlar. |
| B-17 | `durum='var'` + boş `gonderilen_adet` normalizasyonu **her iki görünümde** aynı (aynı kalem hem "gönderildi" hem "tamamı eksik" görünemez). |
| B-18 | Türkçe-İ tuzağı üç yerde kapandı: `_kalem_merge` (yeni `_ad_anahtar_tr`), kalem-durum eşleşmesi, kalem-iptal `_cikmis` kümesi (`ad_anahtar`). `_kalem_merge` artık **hem kimlik hem normalize ad** ile indeksliyor — id'li ve id'siz kayıt birleşiyor (4 senaryo birim testiyle doğrulandı). |
| B-19 | `odeme_tarihi` NULL olan `'odendi'` satırlar **ödeme izi sayılmıyor** (2 sorguda). Tarihi bilinmeyen ödeme, ödeme izi değildir. |
| B-20 | Negatif bakiye sıfıra kesilmiyor: `ham_bakiye` + `cari_alacak` alanları ve `toplam_cari_alacak` özeti eklendi. |

---

## C — P1 (veri bozulur / iz kaybolur)

| # | Yapılan |
|---|---|
| C-1 | Devir çizgisi **tek doktrin**: ekstre de artık "eleme YALNIZ devri varsa" kuralını uyguluyor. Yanıt `devir_cizgisi_uygulandi` + `devir_cizgisi` alanlarıyla hangi kuralın çalıştığını söylüyor. |
| C-2 | FIFO havuzu ile kanal aritmetiğinin farkı **raporlanıyor**: `kanal_hesaplanan_acik`, `defter_farki`, `defter_farki_notu`. (Kanal izleri fatura seviyesinde bağlanamaz — fark gizlenmiyor, adıyla gösteriliyor.) Kıyas `defter_kiyas=0` ile kapatılabiliyor; `/cari-ode` içinden **kapalı** çağrılıyor (havuz tükenmesi dersi). |
| C-3 | Bağ geri alınınca `tedarikci_fatura.siparis_talep_id` damgası da temizleniyor — yanlış bağ "KESİN eşleşme" olarak dirilemiyor. |
| C-4 | `fatura-bagla-geri-al`daki `audit()` **savepoint içinde** — "ok" deyip commit'i rollback'e çeviren yol kapandı. |
| C-5 | Kanıtsız fatura kapanışı yasak: `/kapat` `kapanis_tipi='fatura'` için **bağlı fatura şartı** arıyor; kadife ekrandan "Fatura geldi" seçeneği kaldırıldı (fatura kapanışı yalnız yükle/bağla ile). |
| C-6 | **OCR sonrası gerçek tutar geri yazılıyor**: `belge_talep.fatura_tutar_tl` + `tutar_fark_tl` dolduruluyor — sapma denetimi artık en çok kullanılan yolda da görüyor. |
| C-7 | `talep-tahsis-uyumsuzluk-coz` **istenen adedi ezmiyor** (`uzlasma_adet` ayrı alan); `talep_adet` çıpası korunuyor; durum `tam/kismi` gerçeğe göre; **rezerv deltası** aynı transaction'da uygulanıyor. |
| C-8 | Bozuk JSON artık `[]` yazmıyor — **409** ile durup kaydı olduğu gibi bırakıyor (tüm kalemleri silme yolu kapandı). |
| C-9 | `yeniden-ac`: `FOR UPDATE` + koşullu UPDATE + **açık sevk varsa 409**; sevkiyat damgaları sıfırlanıyor. |
| C-10 | Eksik teslim: `siparis_sevk_eksik.eksik_kalemler` (JSONB) eklendi — kalem/adet yapılandırılmış yazılıyor; talep bağı **tahmin değil** gövdeden gelen `siparis_talep_id`. |
| C-11 | WhatsApp başarısızsa yanıt `wa_uyari` ile açıkça söylüyor. **Bilinçli sapma:** iş durumu (`durum`) değiştirilmedi — yeni bir durum değeri şubenin "beklenen teslimat" listesinden kaydı düşürürdü. |
| C-12 | `toptanciya-yolla` için **`tedarikci_id` zorunlu** (cari hesaba giden anahtar ilk satırda kopmasın). Kadife ekran zaten gönderiyor — regresyon yok. |
| C-13 | Toptancı sevkinde `kalem_durumlari` `toptanciya_gitti` ile damgalanıyor; geri almada **aynı kapsamda** temizleniyor (hâlâ açık gönderime ait kalemler korunuyor). |
| C-14 | Kısmi geri almada talep durumu **zorlanmıyor** (yorum bunu söylüyordu, kod tersini yapıyordu). |
| C-15 | `toptanci-geri-al` adayları `FOR UPDATE` ile kilitleniyor + UPDATE koşulunda `teslim_alindi` dışlanıyor. |
| C-16 | `/siparis-kalem-ekle` `kalem_surum`u artırıyor — bayat pencere kilidi artık delinemiyor. |
| C-17 | Depo "kalan" listesi `toptanciya_gitti`/`merkez_iptal`/`depoya_yonlendirilmedi` kalemleri saymıyor. |
| C-18 | `/siparis-yoklama` kasa-açık + şube-açık kapılarından geçiyor (QR yolu artık PIN yolundan zayıf değil). |
| C-19 | Teslim kabulünde mükerrer `yolda_id` **400**; talep bazlı advisory lock + `FOR UPDATE`. |
| C-20 | Devir yeniden beyan edilirken önceki tutar/iptal nedeni açıklamaya damgalanıyor — beyan tarihçesi kaybolmuyor. |
| C-21 | `DELETE /cari-devir/{id}` hiç satır bulmazsa **404** (no-op artık başarı sayılmıyor). |
| C-22 | Fatura silinince ondan doğmuş `vadeli_alimlar` sözü **iptal ediliyor** (silinmiyor — append-only), yanıtta sayısı dönüyor. |
| C-23 | `cari_odeme.geri_alma_tamam` damgası eklendi; ikinci çağrı **409** (3. adım bir daha koşmuyor). |
| C-24 | Mutabakat toleransı **karar değil gözlem**: `uyumlu` artık sıfır fark demek; `esik_icinde` + `esik` ayrı alan, özet `esik_icinde_fark_adedi` sayıyor. |

---

## D — P2 (dayanıklılık / sahte yeşil / sessiz kesme)

| # | Yapılan |
|---|---|
| D-1 | `depo_kalan_kalemleri`: `depo_kalan_talep_toplam` + `depo_kalan_kesildi` |
| D-2 | Sevkiyat uyumsuzluk listesi: `donen` + `kesildi` |
| D-3 | Geçmiş listesi: `toplam` artık **gerçek toplam** (durum özetinden), `donen` + `kesildi` ayrı |
| D-4 | Geçersiz `durum` filtresi **400** (sessizce yok sayılmıyor) |
| D-5 | Cari ekstre: `hareket_toplam_adet` + `hareketler_kisaltildi` |
| D-6 | GRNI sorgusu düşerse `adet/toplam_tl = None` + `olculemedi: true` — sıfır ile "ölçemedim" ayrıldı |
| D-7 | Uyumsuzluk listesinden 'yolda' satırları çıkarıldı (hepsi sahte uyumsuzluktu); **kaybolmadılar** — `kabul_bekleyen` kovasında yaşlarıyla dönüyorlar |
| D-10 | Gece zincirine `belge_telafi_gozlem` halkası eklendi — belge talebi açılmamış teslimatlar duyu olayı olarak yüzeye çıkıyor (uygulama yine insan onayıyla) |
| D-12 | İptal edilen kalem özette `adet=0` + `iptal:true` + `istenen_adet` ile dönüyor |
| D-13 | Merge hedefine **2 günlük tarih penceresi** — günler önceki unutulmuş talebe sessiz ekleme kapandı |
| D-14 | `/odenecek-kuyruk`: `pencere` + `pencere_baslangic` alanları, `hesap` metninde pencere yazılı |

---

## Uygulanmayanlar (gerekçeli)

| # | Neden |
|---|---|
| **CE-03 / damgasız ödeme** | Damgasız satırları bakiyeden çıkarmak **borcu bir anda büyütür** — bu sahibin kararıdır, tek taraflı değiştirilmedi. Bunun yerine her ödeme satırı artık kanıtını taşıyor: `kanit: "damga"｜"aciklama"` + `damgasiz` bayrağı. Sahip zayıf eşleşmeleri görüp damgalayabilir. |
| **D-8 / rezerv tahsise bakmadan düşüyor** | Düzeltmesi rezerv modelinin talep-bazlı yeniden kurgusunu gerektiriyor (sevk ↔ tahsis arasında denklem yok). Denetimde P2; tek başına yapılırsa mevcut sevk akışını kilitleme riski var. **Ayrı iş olarak bırakıldı.** |
| **D-9 / HAYALET_STOK** | Zaten **bilinçli sapma** (sahip kararı: "sistem çalışsın, stok düzeltmesi sonra"). Alarm üretiliyor. Karar sahibin. |
| **D-11 / timeline snapshot karışımı** | Kozmetik; append-only olay ile anlık durumu ayırmak ayrı bir görünüm işi. |
| **tv_menu_api.py tanımsız 3 ad** | Zincir kapsamı dışında (TV menü). Gerçek bir kusur — `_satis_taban_map` ve `_urun_taban_key` hiç tanımlı değil, o uç çöküyor. **Ayrıca ele alınmalı.** |

---

## Doğrulama

```
python -m compileall -q *.py                → tüm modüller derlendi
python -m pyflakes *.py | grep undefined    → zincirde 0 (yalnız tv_menu, kapsam dışı)
python tmp/zincir_denetim/yutulan2.py       → 64 → 12 (kalan 12 izole transaction)
python tmp/zincir_denetim/rota2.py          → 0 gölgelenme
npm run build                               → ✓ built
her modül tek tek import edildi             → hata yok
_kalem_merge birim testi (4 senaryo)        → 4/4 geçti
```

**Değişen:** 19 dosya · +2960 / −1922 satır.

> ⚠️ **Deploy öncesi:** B-2 (4. ödeme kanalı) canlıda tedarikçi bakiyelerini
> DÜŞÜRECEK. Deploy sonrası ilk iş `GET /api/fatura/cari-ode-kanal-etkisi`
> okunmalı: hangi ödemenin ne kadar düştüğü tedarikçi başına yazılı.
> Sahibin kuralı: *kapattıktan sonra YENİ rakamı da ölç.*

---

# 🔬 CANLI DOĞRULAMA (2026-09-02, deploy sonrası)

Deploy `03094e8` ile indi. Ölçümler production'a `curl` ile yapıldı.

## Kırık olan iki uç artık ayakta

| Uç | Öncesi | Sonrası |
|---|---|---|
| `GET /api/fatura/cari-ozet` | **500** `UnboundLocalError: g_adlar` | **200** |
| `GET /api/tv-gosterim/etki` | **çöküyordu** (`_satis_taban_map` tanımsız) | **200** |

`cari-ozet`'in 500 gövdesi deploy inmeden önce birebir yakalandı — teşhis
tahmin değildi:

```
UnboundLocalError: cannot access local variable 'g_adlar'
  File "/app/fatura_api.py", line 6399, in cari_ozet
```

## 4. ödeme kanalının etkisi — ölçüldü

`GET /api/fatura/cari-ode-kanal-etkisi`:

| Tedarikçi | Adet | Toplam | Nakit | Kart |
|---|---:|---:|---:|---:|
| FEZ | 1 | 70.000,00 ₺ | 0 | 70.000,00 |
| MEHMET ATALAY | 1 | 50.000,00 ₺ | 0 | 50.000,00 |
| **TOPLAM** | **2** | **120.000,00 ₺** | | |

Bu 120.000 ₺, düzeltmeden önce **hiçbir bakiye ucunda görünmüyordu.**

**Çift düşüm kontrolü (kritik):** İkisi de kart ödemesi olduğu için "banka
ekstresi aynı çekimi zaten getirdiyse iki kez düşer mi?" sorusu soruldu.
Cari ekstre satır satır okundu:

```
FEZ            27.07  70.000,00  kanit=aciklama  anlik_gider
               30.08  70.000,00  kanit=damga     cari_odeme     ← yeni kanal
MEHMET ATALAY  27.07 108.459,87  kanit=damga     kart
               30.08  50.000,00  kanit=damga     cari_odeme     ← yeni kanal
```

Aynı tutarlı FEZ satırları **34 gün arayla** — tekilleştirici ±3 gün
kullanıyor, doğru davranıp birleştirmedi. Bunlar iki ayrı gerçek ödeme.
**Çift düşüm yok.**

Deploy sonrası bakiyeler: FEZ 66.965,49 ₺ · MEHMET ATALAY 44.825,43 ₺ ·
toplam cari açık 727.209,25 ₺.

## Duman testi — dokunulan 14 uç

Hepsi **200**: `cari-ozet` · `cari-odenecekler` · `odenecek-kuyruk` ·
`ap-mutabakat` · `cari-devir` · `acik-teslimat` · `belge-talep/bekleyen` ·
`telafi-adaylari` · `kontrol-kulesi` · `sevkiyat-uyumsuzluklar` ·
`siparis/gecmis` · `v2/siparis-akis` · `toptanci-teslimler` · `tv-gosterim/etki`

## Dürüst not: iki düzeltmenin bugün etkisi yok

| Düzeltme | Canlı sonuç | Yorum |
|---|---|---|
| **C-24** tolerans artık karar değil gözlem | `esik_icinde_fark_adedi: 0` | Bugün eşik bandında saklanan tedarikçi **yok** — kural doğru ama bugünkü veride yeni bir şey açığa çıkarmadı |
| **D-7** yoldakiler ayrı kovaya | `kabul_bekleyen: 0`, gerçek uyumsuzluk 16 | Şu an yolda paket yok; liste zaten temizdi. Fark, yolda paket olduğu günlerde görülecek |

Bu ikisi "yaptım ve şu kadar kazandırdı" diye sunulmamalı — **doğru ama
bugün ölçülebilir etkisi olmayan** düzeltmelerdir.

## GRNI durumu

`telafi-adaylari: 0` — şu an belge talebi açılmamış teslimat **yok**.
Gece gözlem halkası (D-10) bu sayı sıfırdan büyüdüğünde duyu olayı basacak.

---

# 🎨 KADİFE EKRAN AYAĞI (2026-09-02, deploy `0c7ff72`)

Zincir düzeltmeleri ~15 yeni yanıt alanı üretmişti ama **hiçbir ekran
okumuyordu**: veri var, gören yok. Bu, projenin daha önce denetlediği
"işlev boşluğu" deseninin ta kendisi. Altısı v2'ye bağlandı.

| Ekran | Alan | Ne değişti |
|---|---|---|
| **Ops** | `wa_uyari` | WhatsApp gidemezse **kalıcı** kırmızı uyarı ("Gördüm" ile kapanır). Eskiden telefon VARKEN gönderim düşerse toast **hiçbir şey demiyordu** — kayıt "yollandı", tedarikçi habersiz. |
| **Ops** | `kabul_bekleyen` | D-7 ile uyumsuzluk listesinden çıkarılan 'yolda' paketler **kendi kovasında**, yaşlarıyla. En eskisi 3 günü geçerse uyarı metni. |
| **Ops** | `kesildi` | **Çift kesme dürüstlüğü**: ekran ilk 40'ı gösteriyor, sunucu da LIMIT'e kesmiş olabilir — ikisi de yazılır. |
| **Ödeme** | `defter_farki` | FIFO tahsisinden **önce** uyarı: iki defter ayrışıyorsa tutarıyla söylenir. |
| **Belge** | `kanit` / `damgasiz` | Damgasız ödeme satırı `~ tahmin (damgasız)` olarak **amber** rozetle işaretlenir. Bakiyeden çıkarmak sahibin kararı; ama neye dayandığı görünür. |
| **Belge** | `devir_cizgisi_uygulandi`, `hareketler_kisaltildi` | Hangi doktrinin çalıştığı ve listenin kesilip kesilmediği yazılı. |

## 🔴 Ekran ayağı canlıda GERÇEK bir çatlak açığa çıkardı

`defter_farki` ölçümü (production):

| Tedarikçi | Tahsis defteri | Kanal aritmetiği | Fark |
|---|---:|---:|---:|
| FEZ | 104.574,46 | 66.965,49 | **+37.608,97** |
| BEYSU | 19.500,00 | 8.400,00 | **+11.100,00** |
| MEHMET ATALAY | 0,00 | 44.825,43 | **−44.825,43** |
| SÜTAŞ | 31.907,35 | 31.907,35 | **0,00** ✓ |

**SÜTAŞ'ın 0 çıkması kıyasın anlamlı olduğunu kanıtlıyor** — her yerde
ayrışmıyor, yani ölçüm gerçek bir şey ölçüyor.

**MEHMET ATALAY en tehlikelisi:** FIFO havuzu **boş**. Ödeme ekranı
"kapatacak açık fatura yok — avans/belgesiz" derdi; oysa kanal aritmetiğine
göre **44.825,43 ₺ borç var**. Artık uyarı çıkıyor.

**FEZ ve BEYSU'da ters yön:** havuz borcu **fazla** gösteriyor; bazı
faturalar kanaldan ödenmiş ama tahsis defteri bilmiyor. FIFO'ya bırakılırsa
para **zaten ödenmiş** faturalara yazılır.

> 🔴 **SAHİP AKSİYONU:** bu dört tedarikçinin farkı elle incelenmeli.
> Kanal ödemelerini fatura seviyesinde eşleştirmek (damgalamak) farkı kapatır.

## Doğrulama

- UI'nin okuduğu **her alan** canlı yanıtta var — `curl` ile tek tek teyit edildi.
- Canlı bundle yerel derlemeyle **birebir aynı** (indirilip karşılaştırıldı);
  altı yeni ekran metninin hepsi canlıda.
- ⚠️ **Görsel tur YAPILAMADI** — CFO paneli şifre kapılı. Doğrulama alan
  varlığı + bundle içeriği düzeyindedir, ekran görüntüsü değil.

> **Ölçüm dersi:** uzak dosyayı `curl | python` ile okumak Windows'ta UTF-8'i
> bozuyor ve "metin yok" yanılgısı üretti. Dosyaya indirip `encoding="utf-8"`
> ile okumak gerekti — ölçüm aracının kendisi de yanılabilir.

---

# ♻️ D-8 REZERV DENKLEMİ (2026-09-02, deploy `3b68d79`)

Denetimde "ayrı iş" diye bırakılmıştı; kuruldu.

## Değişmez kural (bugüne kadar hiçbir yerde zorlanmıyordu)

```
sube_depo_stok.rezerve_adet
    = o depo+kalem için AÇIK taleplerin kalem_durumlari[].tahsis_adet TOPLAMI
```

## İki kusur — biri tek başına yetmezdi

**1.** Sevk çıkışı rezervi `sevk_adet` kadar düşürüyordu, bu sevkin tahsisli olup
olmadığına **bakmadan**. Tahsissiz bir sevk, aynı depodaki **başka talebin**
rezervini yiyordu; `GREATEST(0,…)` taşmayı yuttuğu için iz de kalmıyordu.
→ Düşüm artık `min(sevk_adet, BU TALEBİN kalan tahsisi)`.

**2.** Sevk `kalem_durumlari`ya **hiç dokunmuyordu**; `tahsis_adet` sonsuza dek
eski değerinde kalıyordu. Yalnız (1) yapılsaydı **yeni bir kapı açılırdı**:
`merkez_tahsis_yap` bir sonraki çalışmasında delta'yı bayat değerden hesaplar
(0−5 = −5) ve rezervi **ikinci kez** düşürürdü — bu kez başkasından.
→ Tüketilen tahsis deftere yazılır (`tahsis_tuketilen` izi kalır).

## Birim testi iki kez KENDİ hatamı yakaladı

`scripts/test_rezerv_denklemi.py` — gerçek motora karşı, sahte imleçle, 6 senaryo.

| Yakalanan hata | Neydi |
|---|---|
| **Rastgele anahtar seçimi** | Harita aynı kalemi birden çok takma adla tutuyordu; sevk yalnız **birini** düşürüyordu ve hangisinin seçileceği `set` sırasına, yani **rastgeleye** bağlıydı → tek kanonik anahtar (sıra numarası) + takma ad indeksi |
| **Yazan ↔ okuyan asimetrisi** | Harita **ham adı** indeksliyor, arama **normalize adla** yapılıyordu. Kimliği olmayan kalemde eşleşme hiç tutmuyor, hem `istenen` tavanı hem rezerv denklemi **sessizce devre dışı** kalıyordu → ikisi de indeksleniyor |

**6/6 geçti.** Test repoda: `python scripts/test_rezerv_denklemi.py`

## 🔍 Canlı ölçüm — ve dürüst sonuç

Yeni uç: `GET /api/ops/v2/rezerv-denetimi` (salt-okur, düzeltmez).

```
rezervli satir  : 0
KAYAN satir     : 0
```

Kontrol kulesinden teyit: **55 talebin 32'sinde `kalem_durumlari` var ama
`tahsis_adet > 0` olan HİÇ kalem yok.**

> ### Bulgunun gerçek anlamı
> **Tahsis/rezerv alt sistemi canlıda tamamen ATIL.** Her sevk "tahsissiz"
> yapılıyor. Yani D-8'in hatası gerçekti ama **maruziyeti sıfırdı** — çalınacak
> rezerv yoktu. Yaptığım düzeltme **önleyicidir**, bugün bir şey kurtarmadı.
>
> Bunu "şu kadar adet kurtardım" diye sunmak yanlış olurdu.

**Asıl soru sahibe kalıyor:** `merkez_tahsis_yap` / rezerv mekanizması kurulmuş
ama **hiç kullanılmıyor**. İki yol var — ya kullanılmaya başlanır (artık denklemi
doğru, güvenli), ya da atıl alt sistem olarak kayda geçip sadeleştirilir.
Şu hâliyle bakım yükü var, faydası yok.
