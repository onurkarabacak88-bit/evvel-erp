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
| **+A-5** | **`/cari-odenecekler` rota gölgelenmesi** — `/{fatura_id}` yutuyordu, ödeme ekranının okuduğu uç 404 dönüyordu | Statik rota parametreli yoldan öncede kaydedildi (ince sarmalayıcı) | çalışma zamanı sıra ölçüldü: 41 < 56 |
| **+A-6** | `duyu_omurga.py` `date` importsuz · `k1_kart_odeme_tani.py` `logger` tanımsız | İkisi de eklendi | `pyflakes` temiz |

> A-4, A-5, A-6 denetim listesinde YOKTU — düzeltme sırasında aynı sınıf tarama
> (`pyflakes`, rota sıralaması) tüm repoya uygulanınca çıktı.

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
