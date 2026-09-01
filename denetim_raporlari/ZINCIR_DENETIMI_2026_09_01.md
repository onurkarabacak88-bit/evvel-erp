# 🔗 SİPARİŞ ZİNCİRİ DENETİMİ — şube panelinden toptancı cari hesabına
**Tarih:** 2026-09-01 · **Dal:** prod-denetim · **HEAD:** 8f9678a

## Denetim kadrosu
| Denetçi | Kapsam | Bulgu |
|---|---|---|
| **Codex** (gpt-5.4, xhigh) | 10 ardışık satır-aralığı, kod-kod | 52 |
| **Fable** (mantık denetçisi) | 4 halka, durum makinesi + para aritmetiği | 34 |
| **Claude** (ölçüm + doğrulama) | pyflakes · eslint no-undef · AST taraması · canlı kod okuma | 5 |
| **TOPLAM (mükerrer ayıklandıktan sonra)** | | **~70 ayrık bulgu** |

Kapsanan dosyalar: `sube_panel.py` · `operasyon_merkez_api.py` · `operasyon_stok_motor.py` ·
`siparis_kontrol_kulesi.py` · `sevkiyat_helpers.py` · `belge_talep_api.py` · `fatura_api.py` ·
`odeme_plani_api.py` · `src/pages/v2/OpsModulu.jsx` · `OdemeModulu.jsx` · `BelgeModulu.jsx` · `EslesmeModulu.jsx`

---

# BÖLÜM A — 🔴 ŞU AN CANLIDA KIRIK (kanıtlı, ölçülmüş)

## A-1 | `g_adlar` TANIMSIZ — aktif devir varken `/cari-ozet` 500 veriyor
**fatura_api.py:6399-6400** (kullanım) ↔ **6423** (tanım) · **HEAD commit 8f9678a getirdi**

`devir_top` bloğu, alias listesi `g_adlar`ı 24 satır ÖNCE kullanıyor.
- **İlk grup iterasyonu:** `g_adlar` bağlanmamış → `UnboundLocalError` → **500**.
- **Sonraki iterasyonlar:** ÖNCEKİ grubun alias listesiyle eşleştiriyor → **devir yanlış tedarikçiye yapışıyor**; `_atandi` bayrağı yüzünden doğru sahibine bir daha gidemiyor.

**KANIT (ölçüm):** `python -m pyflakes fatura_api.py` → `6399:64 undefined name 'g_adlar'`

**ETKİ ALANI:** `cari-ozet` · `odenecek-kuyruk` · `ap-mutabakat` · `ap-selfheal` · `odeme_plani/cari-uyumsuzluk` — hepsi bu fonksiyona bağlı. Zincirin SONU kör.

**DÜZELTME:** `g_adlar = _es_adlari(g["tedarikci"])` satırı devir döngüsünün ÜSTÜNE alınır (tek satır taşıma).

> Bu, sahibin kendi **"Tanımsız Değişken Kapısı"** dersinin Python tarafındaki birebir tekrarıdır — `vite build` gibi Python da yakalamaz, tek koruma `pyflakes`.

## A-2 | `logger` TANIMSIZ — toptancı teslim kabulü, belge talebi açılamadığında 500 patlıyor
**sube_panel.py:3356** (`sube_urun_sevk`, POST `/{sube_id}/urun-sevk`)

`sube_panel.py`'de **hiç `logging` importu ve `logger` tanımı yok.** `belge_talep_olustur_izole` hata verince except gövdesi `logger.warning(...)` çağırıyor → `NameError` → **except'in kendisi patlıyor**, dışarı kaçıyor.

Blok, kodun kendi sözünü çürütüyor:
> `# teslim-al akışı bozulmamalı — o söz duruyor.`

Söz durmuyor: hata anında `UPDATE toptanci_siparis SET durum='teslim_alindi'` ile **aynı transaction** olduğu için teslim kabulünün TAMAMI geri alınıyor ve şube 500 görüyor.

**KANIT:** `pyflakes sube_panel.py` → `3356:21 undefined name 'logger'`
**DÜZELTME:** dosyaya `import logging` + `logger = logging.getLogger(__name__)` eklenir.

## A-3 | `yedek_zamani` alanı HER ZAMAN null (P2)
**operasyon_merkez_api.py:513** — `_now_iso() if "_now_iso" in globals() else None`; `_now_iso` bu dosyada hiç tanımlı değil → alan hep `None`. Yedeğin ne zaman alındığı hiçbir zaman görünmüyor.

---

# BÖLÜM B — 🔴 P0: PARA / ADET YANLIŞ

## B-1 | SAVEPOINT'siz yutulan yazım → API "success:true" der, veritabanı HİÇBİR ŞEY yazmaz
**sube_panel.py:5665 · 5791 · 5797 · 5890** · **operasyon_merkez_api.py:10156** ve 63 yer daha

Zincir kodda doğrulandı:
1. `except Exception: pass` içindeki `cur.execute` patlar,
2. PostgreSQL transaction'ı **aborted** yapar,
3. `database.py:147`'deki `conn.commit()` abort'lu transaction'da **sessizce ROLLBACK**'e döner (psycopg2 hata fırlatmaz),
4. uç `{"success": true, "talep_id": ...}` döndürmüştür.

**Sonuç: şube "sipariş verildi" görür, merkez kuyruğunda talep YOKTUR.**

**ÖLÇÜM (AST taraması, bu oturumda yapıldı):**

| Dosya | Yazan fonksiyon içinde, SAVEPOINT'siz, yutulan SQL bloğu |
|---|---|
| operasyon_merkez_api.py | 22 |
| fatura_api.py | 15 |
| operasyon_stok_motor.py | 13 |
| belge_talep_api.py | 5 |
| siparis_kontrol_kulesi.py | 5 |
| sube_panel.py | 4 |
| **TOPLAM** | **64** |

Ayrıca **6 "dolaylı yazar" çağrısı** aynı desende: `siparis_olustu_kaydet` ×3, `eksik_kullanim_kontrol`, `belge_talep_olustur_izole`, `operasyon_defter_ekle` ×7.

`database.savepoint()` aleti **database.py:75'te hazır duruyor**; `sube_panel.py`'de 0 kez, `fatura_api.py`'de 0 kez kullanılmış.

**En kritik noktalar:** `sube_kabul_kaydet` · `sevk_cikti_kaydet` · `sube_depo_stok_depo_cikis_dus` · `sube_depo_stok_depo_giris_ekle` · `fatura_bagla_uygula` · iki "uyumsuzluk-çöz" ucu · `audit()` (kasa_service.py:105-114).

## B-2 | `/cari-ode` ödemesi cari bakiyeye HİÇ işlenmiyor — borç düşmez, ikinci kez ödenir
**fatura_api.py:8325-8328** · ödeme evreni **6270-6296** · şart **68-78**

`hesaplanan_acik`ın ödeme tarafı **yalnız 3 kanaldan** okunuyor:
`vadeli_alimlar durum='odendi'` · `anlik_giderler kaynak_id IS NULL` · `kart_hareketleri (kaynak_id IS NULL OR ekstre_import)`

`/cari-ode` ise:
- **nakitte** → `kasa_hareketleri`'ne yazar (hiçbir kanal değil),
- **kartta** → `kaynak_tablo='cari_odeme'`, `kaynak_id` DOLU satır yazar → **`KART_ODEME_IZI_SARTI` tarafından ELENİR**,
- `cari_odeme` tablosunu **hiçbir bakiye ucu okumaz**.

**Sistemin kanonik cari ödeme kapısı, cari bakiyeyi düşürmeyen tek ödeme yolu.**
Nakit **kalıcı** görünmez; kart, banka ekstresi inene kadar görünmez.

**DÜZELTME:** ödeme izi evrenine 4. kanal `cari_odeme (iptal=FALSE)` eklenir, ekstre gelince `_cift_kanal_tekille` ile tekilleştirilir.

## B-3 | `/cari-ode` üç ayrı transaction — para çıkar, fatura açık kalır
**fatura_api.py:8306-8346**

`odeme_plani + cari_odeme` **commit** → `odeme_yap` (kasa) → **ayrı** `with db()` içinde `cari_odeme_tahsis`.
Temizlik yalnız `except HTTPException` için var. Tahsis INSERT'i patlarsa: kasada para çıkmış, planda ödeme var, **fatura hâlâ açık**.

## B-4 | Aynı fatura fazla kapatılabiliyor — kilitsiz havuz + düşülmeyen kalan
**fatura_api.py:8277 · 8282-8291**

- `acik` havuzu kilitsiz okunuyor, tahsis öncesi yeniden doğrulanmıyor → **eşzamanlı iki ödeme aynı faturayı iki kez kapatır**.
- Elle tahsiste aynı `fatura_id` iki satırla gelirse `a["kalan"]` hiç azaltılmıyor → **tek istekte fazla kapama** (kalan 100 iken 60+60 = 120 kapanır).
- Geçersiz `fatura_id` satırları sessizce `continue` ile atlanıp yine `ok:True` dönüyor → kullanıcının "şu faturayı kapat" niyeti sessizce avansa dönüşüyor.

## B-5 | Cari ekstre BAŞKA FİRMANIN faturasını havuza ve TAHSİSE sokuyor
**fatura_api.py:6967 · 6969-6971**

- `ara.lower() in ad.lower()` — düz alt-dize: **"FEZ" ⊂ "FEZA GIDA"**
- `_ara_tok <= ft or ft <= _ara_tok` — çift yönlü alt-küme: **{atalay} ⊂ "ATALAY TEKSTİL"**

Bu liste `cari-odenecekler` FIFO havuzunu ve `/cari-ode` tahsisini **besliyor** → yanlış eşleşme görüntü değil **para tahsisi hatası**: FEZ'in parasıyla FEZA'nın faturası "kapatıldı" yazılır.

**Ek:** damgasız ödeme satırları yalnız **açıklama metniyle** (`_es_es(aciklama)`) bu cariye yazılıyor (**7044**) → not alanında geçen bir ad başka firmanın hareketini bu ekstreye sokar.

## B-6 | 🎨 KADİFE (v2) SEVK UCU KLASİKTEN ZAYIF — istenen tavanı YOK
**operasyon_merkez_api.py:13958-13971** (`SevkItem` 13885-13894) ↔ klasik **siparis_sevkiyat_islem.py:355-470**

| Kural | Klasik hat | v2 kadife ucu |
|---|---|---|
| İstenen adedi talepten doğrula | ✅ | ❌ (`SevkItem`de `istenen_adet` alanı YOK) |
| `gonderilen_adet`i tavana kırp | ✅ | ❌ (ilk sevkte fren hiç çalışmaz) |
| `kalem_surum` bayat-pencere kilidi | ✅ | ❌ |
| Sevk sonrası `durum='gonderildi'` + `sevkiyat_ts` | ✅ | ❌ (sevkiyat-hız duyusu bu teslimi HİÇ ölçmez) |
| `ValueError → 409` | ✅ | ❌ (yakalanmıyor → 500) |

**SENARYO:** kadife ekrandan, istenen 5 iken `sevk_adet=500` → 500 düşer, 500 yola çıkar, hiçbir fren çalışmaz. Klasikte 409 olurdu.

**Aynı asimetri kabul ucunda da var** (13977-14016): PIN yok · kasa-açık kapısı yok · şube sahipliği yok · durum kapısı yok · `ValueError` → 500.

## B-7 | 🎨 `kalem_durumlari.urun_ad` KAYIYOR — kadife ekranda "depo dışı" kalem "var" olarak diriliyor
**operasyon_merkez_api.py:9682-9745** (`sync-urun-adlari`) · **9486-9515** (`urun-ad`)
ekran eşleşmesi: **src/pages/v2/OpsModulu.jsx:1783** ve **src/pages/SevkiyatHazirlama.jsx:114**

İki yeniden-adlandırma ucu da `siparis_talep.kalemler[].urun_ad`'ı güncelliyor ama **`kalem_durumlari[].urun_ad`'a hiçbir kod dokunmuyor** (grep: 0 sonuç).

Ekran ise iki JSONB'yi **hem id HEM ad birebir eşit** olacak şekilde eşleştiriyor:
`findIndex((k) => (k.urun_id||'') === (d.urun_id||'') && (k.urun_ad||'') === (d.urun_ad||''))`

Ad kayınca `findIndex` **-1** döner → kaydedilmiş hazırlık **sessizce atılır** ve kalem varsayılana düşer: `durum:'var'`, `gonderilen_adet: adet`.

**Sonuç: `toptanciya_gitti` / `merkez_iptal` damgalı kalem depocuya "var, tam adet" görünür ve İKİNCİ KEZ sevk edilir** — toptancıdan da gelir, depodan da. Fatura toptancının cari hesabına yazılır, mal iki kez gelir.

**Not:** sunucu tarafı `ad_anahtar()` normalizasyonu kullanıyor; **ekran ondan katı** — asimetri buradan doğuyor.

## B-8 | 'gonderildi' talep geriye çekilip İKİNCİ KEZ sevk edilebiliyor
**operasyon_merkez_api.py:9897 · 10040-10041 · 10111-10126**

Durum kapısı `('bekliyor','hazirlaniyor','gonderildi')` — mal **fiilen yolda** iken yeniden yönlendirme serbest. Uç `kalem_durumlari`yı sıfırdan kuruyor, her kaleme `gonderilen_adet: 0` yazıyor. Çift-kanal freni yalnız `toptanci_siparis`e bakıyor, **`stok_yolda`ya HİÇ bakmıyor**.

**SENARYO:** Gazze deposu 5 Süt yola çıkardı → operatör aynı talebi Köyceğiz'e yollar → Köyceğiz 5 Süt daha çıkarır → şube 10 alır, kayıt 5 der.

## B-9 | Uyumsuzluk çözümü YOLDAKİ paketi ölü doğuruyor (zombi mal)
**operasyon_merkez_api.py:13278-13300**

"Kalan uyumsuz var mı" sayacı `kabul_ts IS NOT NULL` filtresiyle kuruluyor; hâlâ `durum='yolda'` olan satırların `kabul_ts` NULL olduğu için sayaç **görmez** → sayaç 0 → talep koşulsuz `teslim_edildi`.

Sonra şube kapısı 400 verir, motor "kabul zaten işlendi" der → **yoldaki paket ASLA kabul edilemez**; kaynaktan düşülmüş adet deftere hiç giremez.

## B-10 | Söz kapısı SIZDIRIYOR — sahibin "söz mantığı devre dışı" kararı yalnız gece yolunda uygulanmış
**fatura_api.py:953** (kapı) · **822-935** (motorda kapı YOK) · kapısız çağıranlar: **2113 · 2435 · 4952 · 5568**

`SOZ_DEFTERI_URETIMI_ACIK = False` yalnız `/kuyruk-tara` girişinde okunuyor. OCR bitince ve yükle-pdf FAZ A'da `_fatura_kuyruk_uret` **doğrudan** çağrılıyor → `main.vadeli_ekle` ile **yeni `vadeli_alimlar` sözü doğuyor.**

**Sonuç:** aynı borç iki temsille yaşıyor (cari türetimi + söz); `ap_mutabakat` her gece "kuyruk ≠ cari" sapması basıyor.

**DÜZELTME:** kapı kontrolü `_fatura_kuyruk_uret`in İLK SATIRINA taşınır (tek merkez).

## B-11 | Çoklu-faturalı PDF'te artık faturalar İKİNCİ KEZ sayılabiliyor
**belge_talep_api.py:2487**

Bir PDF'den N `tedarikci_fatura` doğduğunda hepsinin toplamı tek teslimatın `fatura_tutar_tl`ine yazılıyor ama `belge_talep.fatura_id` olarak **yalnız ilki** kaydediliyor → kalan faturalar "bağlı değil" görünüp **başka teslimata da bağlanabiliyor**. Aynı 150 ₺ iki kez sayılır.

## B-12 | Bağ kanıtı tedarikçi ve kalem kimliğini DOĞRULAMIYOR
**belge_talep_api.py:1542** — manuel bağda seçilen faturadan yalnız `id`, `tutar`, `tarih`, `fatura_no` okunuyor; `tedarikci_ad` / `siparis_talep_id` / kalem örtüşmesi hiç doğrulanmıyor. Yanlış `fatura_id` girilirse **başka tedarikçinin faturası** bağlanır.

**Ek (B-12b):** çoklu-aday guard'ı `beklenen_tutar_tl` boş/0 olan teslimatta ±1 ₺ bandına iniyor → **en korumaya muhtaç kayıt en az korunan** (belge_talep_api.py:1568-1592).

## B-13 | İptal edilmiş toptancı gönderimi aggregate'e HAYALET gibi giriyor
**operasyon_merkez_api.py:10793** — `SELECT kalemler FROM toptanci_siparis WHERE talep_id=%s` **durum filtresi YOK**. `toptanci-geri-al` satırı yalnız `durum='iptal'` yapıp yerinde bırakıyor → geri alınan sevk yeniden sayılıyor → talep `tam_gonderildi` kapanıp **kuyruktan düşüyor**, aktif sevki olmadığı hâlde.

## B-14 | Kalem iptali tahsisi GERİ ALMIYOR ve iki JSONB'yi ayırıyor
**operasyon_merkez_api.py:10364** — yalnız `kalemler` güncelleniyor; `kalem_durumlari`, tahsis alanları ve rezerv iadesi bu kolda hiç güncellenmiyor → iptal edilen kalemin adedi **stokta rezerve kalmaya devam ediyor**.

## B-15 | `urun_id`'siz kalemde tahsis SESSİZCE kayboluyor
**operasyon_merkez_api.py:10026** — eski tahsis yalnız `urun_id` ile geri okunuyor; `kalem_kodu`/`urun_ad` ile tutulan tahsisler eşitlenmiyor ve rezerv yeni depoya taşınmıyor → **rezerv eski kaynakta asılı kalıyor**.

## B-16 | Uzlaştırma stoktan ADET ÜRETİYOR
**operasyon_merkez_api.py:13187** — kaynakta `GREATEST(0, mevcut - delta)` ile kırpıyor ama hedefe farkı **tam** ekliyor → fiziksel olmayan adet sistemde üretiliyor (kaynak 1, sevk 5, çözüm 10 → net +4 hayalet).

## B-17 | Aynı kalem hem "gönderildi" hem "tamamı eksik" görünebiliyor
**sube_panel.py:4614** — `durum='var'` + boş `gonderilen_adet`, normal görünümde `istenen_adet`e tamamlanıyor, "kalan" görünümünde tamamlanmıyor → operatör aynı 10 adedi **ikinci kez sevke çıkarabiliyor**.

## B-18 | Ad eşleşmesi Türkçe-İ'de kalemi kaybettiriyor (üç ayrı yer)
- **sube_panel.py:4604** — birebir `kd_ad == uad` (normalizasyon yok)
- **sube_panel.py:5503-5527** — `_kalem_merge`: anahtar `urun_id` **veya** `urun_ad.lower()`; id'li ve id'siz kalem hiç kesişmez, `'İ'.lower()` = `i` + U+0307
- **operasyon_merkez_api.py:10299** — düz `.lower()`, `ad_anahtar` kullanılmıyor → yollanmış kalem "gönderilmemiş" sanılıp **iptal ediliyor**

## B-19 | `vade_tarihi` ödeme tarihi gibi sayılıyor
**fatura_api.py:6999** — `COALESCE(odeme_tarihi, vade_tarihi)`; `durum='odendi'` ama `odeme_tarihi` NULL olan satır, **vade gününde ödenmiş** sayılıp borcu düşürüyor.

## B-20 | Negatif devir/alacak mutabakatta SIFIRA kesiliyor
**fatura_api.py:6663** — `acik = max(0.0, hesaplanan_acik)`. Avans/alacak bakiyesi rapordan **sessizce düşüyor**; satır `uyumlu=true`, toplam cari açık 0 görünüyor.

---

# BÖLÜM C — 🟠 P1: VERİ BOZULUR / İZ KAYBOLUR

| # | Bulgu | Yer |
|---|---|---|
| C-1 | Devir çizgisi elemesi **üç uçta üç doktrin** — METRO düzeltmesi ekstreye işlenmemiş; hizalama küçük (yanlış) hedefe kuruluyor | fatura_api.py:7135-7157 ↔ 6404-6414 ↔ 8184-8192 |
| C-2 | FIFO havuzu **yalnız tahsis defterini** düşüyor; kartla ödenmiş fatura havuzda tam tutarla açık duruyor | fatura_api.py:8193-8212 |
| C-3 | Geri alma asimetrisi: bağ çözülür ama `tedarikci_fatura.siparis_talep_id` damgası KALIR → yanlış bağ "KESİN — başka kanıt gerekmez" etiketiyle **dirilir** | belge_talep_api.py:1447-1453 ↔ 1321-1338 |
| C-4 | `fatura-bagla-geri-al` yalnız `belge_talep` tarafını çözüyor; `tedarikci_fatura`/`vadeli_alimlar`/`odeme_plani` için karşı-işlem yok → **yarım rollback** | belge_talep_api.py:1448 |
| C-5 | Kanıtsız 'fatura' kapanışı: boş gövdeli `/kapat` GRNI'yi fatura-kanıtlı gibi düşürüyor (`fatura_id` istenmiyor) | belge_talep_api.py:2186-2211 |
| C-6 | Gerçek tutar hiç gelmiyor: `fatura-yukle` talebi ANINDA kapatıyor, OCR sonrası `belge_talep.fatura_tutar_tl` **geri yazılmıyor** → sapma denetimi kör | belge_talep_api.py:2483-2492; fatura_api.py:2107-2116 |
| C-7 | `talep-tahsis-uyumsuzluk-coz` düzeltmiyor, **tarihi eziyor**: `istenen_adet = cozum` → şubenin gerçekte ne istediği siliniyor; rezerv hiç düzeltilmiyor | operasyon_merkez_api.py:13340-13470 |
| C-8 | JSON parse hatası yutulup `[]` yazılıyor → **siparişteki tüm kalemler silinebiliyor** | operasyon_merkez_api.py:13378 |
| C-9 | `yeniden-ac` kilitsiz ve kısmi: yalnız 3 alan güncelleniyor, stok/belge/fatura izleri için ters kayıt yok | operasyon_merkez_api.py:13831 |
| C-10 | Toptancı eksik teslimi: **kalem/adet yazılmıyor**; kayıt "bugünün EN SON talebi"ne tahminle iliştiriliyor | sube_panel.py:3505-3547 |
| C-11 | WhatsApp başarısızken gönderim **yine başarılı** sayılıyor (`durum='gonderildi'` doğuyor, yanıt `success:true`) | operasyon_merkez_api.py:10735 |
| C-12 | `tedarikci_id` zorunlu değil → `toptanci_siparis` NULL kimlikle yazılıyor; **cari hesaba giden anahtar daha ilk satırda yok** | operasyon_merkez_api.py:10513 |
| C-13 | `kalem_durumlari` toptancı sevkinde **hiç güncellenmiyor** → `toptanci_siparis` ile talebin per-kalem izi farklı gerçek söylüyor | operasyon_merkez_api.py:10635 |
| C-14 | Kısmi geri alma, kalan açık sevk varken talebi zorla `bekliyor`a düşürüyor | operasyon_merkez_api.py:11047 |
| C-15 | `toptanci-geri-al` iptal adaylarını kilitlemiyor → **teslim alınmış satır** iptale basılabiliyor | operasyon_merkez_api.py:10995 |
| C-16 | `/siparis-kalem-ekle` `kalem_surum`u ARTIRMIYOR → bayat pencere kilidi delinir, eklenen kalem `depoya_yonlendirilmedi` çukuruna düşer | sube_panel.py:5600-5616 |
| C-17 | Depo "eksik kalan" listesi `toptanciya_gitti`/`merkez_iptal` kalemleri de "kalan" sayıyor → **aynı mal iki kanaldan** | sube_panel.py:4632-4695 |
| C-18 | `/siparis-yoklama` kasa-açık + şube-açık kapılarını TÜMÜYLE atlıyor (QR yolu PIN yolundan zayıf) | sube_panel.py:5815-5852 |
| C-19 | Teslim kabulünde aynı `yolda_id` iki kez geçebiliyor (`set` ile doğrulanıyor) + önkontrol kilitsiz | sube_panel.py:5309 · 5277 |
| C-20 | Devir yeniden açılınca iptal izi ve eski beyan aynı satırda **siliniyor** | fatura_api.py:6802 |
| C-21 | `DELETE /cari-devir/{id}` hiç satır bulmasa bile `ok:true` dönüyor | fatura_api.py:6834 |
| C-22 | Fatura silinince ondan doğmuş `vadeli_alimlar` sözü **öksüz kalıyor** | fatura_api.py:2460-2517 |
| C-23 | `cari-ode-geri-al` bitişi işaretlemiyor → 2. çağrı 3. adımı tekrar koşturuyor | fatura_api.py:1689-1746 |
| C-24 | Mutabakat gerçek farkı **500 ₺ / %5 toleransla** "uyumlu" sayıyor; `saglikli` bayrağı buna bağlı | fatura_api.py:6668 |

---

# BÖLÜM D — 🟡 P2: DAYANIKLILIK / SAHTE YEŞİL / SESSİZ KESME

| # | Bulgu | Yer |
|---|---|---|
| D-1 | `depo_kalan_kalemleri` LIMIT'e kesiliyor, `has_more` yok | sube_panel.py:4650 |
| D-2 | Sevkiyat uyumsuzluk listesi LIMIT'e kesiliyor, toplam yok | operasyon_merkez_api.py:13114 |
| D-3 | Geçmiş listesi `toplam` alanına **dönen satır sayısını** yazıyor (gerçek toplam değil) | operasyon_merkez_api.py:13772 |
| D-4 | Geçersiz `durum` filtresi sessizce yok sayılıyor (400 yerine tüm kayıtlar) | operasyon_merkez_api.py:13728 |
| D-5 | Cari ekstre `hareketler` listesi **son 80 satıra** kesiliyor, bayrak yok | fatura_api.py:7159 |
| D-6 | GRNI sorgu hatası yutulup ekstre "başarıyla" dönüyor (`adet:0, toplam:0`) | fatura_api.py:6896 |
| D-7 | "Uyumsuzluklar" listesi **yoldaki her paketi** uyumsuz sayıyor → sahte kalabalık, gerçek farklar boğuluyor | operasyon_merkez_api.py:13098-13130 |
| D-8 | Sevk çıkışı rezervi **tahsise bakmadan** düşüyor → tahsissiz sevk başka talebin rezervini yiyor | operasyon_stok_motor.py:3399-3407 |
| D-9 | Kaynak düşmeden hedefin artabildiği yol (HAYALET_STOK) — alarm var, **denklem yok** (bilinçli sapma) | operasyon_stok_motor.py:3433-3520 |
| D-10 | GRNI doğumu tek tetik + hata-yutar; telafi taraması **insan çağırmalı**, `gun ≤ 730` | belge_talep_api.py:265-356 |
| D-11 | Timeline gerçek olay kaydıyla anlık snapshot'ı karıştırıyor | operasyon_merkez_api.py:14145 |
| D-12 | İptal işaretli kalem şube özetinde hâlâ "istenmiş" görünüyor; merge yolu davranış denetimini atlıyor | sube_panel.py:4541-4561 · 5585-5637 |
| D-13 | 409 ile sessiz merge çelişkisi; merge hedefinde **tarih filtresi yok** (günler önceki unutulmuş talebe eklenir, şube göremez) | sube_panel.py:5479-5500 ↔ 4952-4967 |
| D-14 | `/odenecek-kuyruk` formülü sessizce **6 aylık pencereye** bağlı gösteriliyor | fatura_api.py:1138-1144 |
| D-15 | Gece `ap-mutabakat` tamamen susturulmuş → "cari düşmüyor" sapmasını yakalayacak **otomatik göz kalmadı** | fatura_api.py:6748-6763 |

---

# BÖLÜM E — ✅ SAĞLAM BULUNAN YERLER (denetim olumlu)

- **Kabul tarafı çift-tık koruması güçlü:** `durum='yolda'` filtresi + `islenen_yolda` + durum-idempotans kapısı.
- **Klasik sevk hattında iki denklem gerçekten zorlanıyor:** toplam sevk ≤ istenen; deftere ≤ `LEAST(kabul, sevk)`.
- **Eşleştirme kanıt sıralaması doğru kurulmuş:** kalem 35 > ad 30 > tarih 25 > tutar 10, tarih-yönü guard'lı. **Yalnız-tutara dayanan yol kapatılmış.**
- **`ap_mutabakat` farkı iki bağımsız kaynaktan ölçüyor** — denkleştirme yaması / sahte 0,00 **yok**.
- **`_cari_devirler` okuma hatasını yutmuyor** (503 ile "ölçülemedi" der) — "temiz hesap kılığına giren hata" kapatılmış.
- **v2 kadife ekranlarda `no-undef` ihlali yok** (eslint flat-config ile tarandı).
- **Kayan pencere kullanımı yok** — çıpa sabit (`EVVEL_SISTEM_BASLANGIC`); "Kayan Pencere ≠ Çıpa" dersi tutmuş.

---

# BÖLÜM F — ZİNCİR HÜKMÜ: bir adet / bir lira nerede kaybolur

**Adet DÖRT deftere yazılıyor, hizalayan tek mekanizma yok:**
`kalemler` (şubenin niyeti) · `kalem_durumlari` (merkezin kararı) · `stok_yolda` (fiilî mal) · `operasyon_defter` (tarihçe).
Tahsis ile sevk arasında **hiçbir denklem yok**; v2 kadife sevk ucu istenen tavanını taşımadığı için ilk sevkte **sınırsız**.

**Adedin kaybolduğu / ikilendiği 5 nokta:**
1. **Doğumda** — SAVEPOINT'siz yutulan çağrı INSERT'i ROLLBACK'e götürür, ekran "success" yanar (B-1).
2. **Yönlendirmede** — `gonderildi` talebin yeniden yollanması `gonderilen_adet`i sıfırlar, aynı mal ikinci kez yola çıkar (B-8).
3. **Ad kaymasında** — `kalem_durumlari.urun_ad` güncellenmediği için kadife ekran "depo dışı" kalemi "var, tam adet" diriltir (B-7).
4. **Uzlaştırmada** — yoldaki paket dururken talep `teslim_edildi` olur; mal deftere bir daha giremez (B-9).
5. **Kırpmada** — `GREATEST(0, …)` kaynağı kırpar, hedefe tamamını ekler; şebeke stoğu şişer (B-16, D-9).

**Liranın İKİ KEZ sayıldığı 2 nokta:** her yeni fatura hem cari türetimine hem sızdıran söz defterine girer (B-10); çoklu-PDF'te artık faturalar bağsız kalıp ikinci teslimata bağlanır (B-11).

**Liranın kaybolduğu 3 nokta:** `/cari-ode` ödemesi bakiyeye hiç işlenmez (B-2); boş gövdeli `/kapat` GRNI'yi kanıtsız düşürür (C-5); tetiği kaçan teslimat hiç borç doğurmaz (D-10).

**Toptancının bakiyesi için "kaç gerçek var?" sorusu:** `cari-ozet` bir sayı · `cari-ekstre` (devir doktrini işlenmemiş) başka bir sayı · `cari-odenecekler` (yalnız tahsis defteri) üçüncü bir sayı. Hangisinin ekranda göründüğü **uca göre değişiyor**.

---

# BÖLÜM G — ÖNERİLEN DÜZELTME SIRASI

| Sıra | Bulgu | Neden önce | Büyüklük |
|---|---|---|---|
| 1 | **A-1** `g_adlar` | Zincirin sonu ŞU AN 500 veriyor; tek satır taşıma | 1 satır |
| 2 | **A-2** `logger` | Teslim kabulü, tam da korunmak istenen anda patlıyor | 2 satır |
| 3 | **B-2** `/cari-ode` 4. kanal | Resmî ödeme kapısı bakiyeyi düşürmüyor | orta |
| 4 | **B-10** söz kapısı tek merkeze | Sahip kararı delinmiş, borç iki temsille yaşıyor | küçük |
| 5 | **B-1** SAVEPOINT (önce 6 dolaylı yazar, sonra 64 blok) | Sessiz veri kaybı; alet hazır | orta |
| 6 | **B-6** v2 sevk ucunu klasik motora köprüle | Kadife ekran frensiz | orta |
| 7 | **B-7** `kalem_durumlari.urun_ad` senkronu **veya** ekran eşleşmesini `ad_anahtar`a indir | İki kanaldan mal | küçük |
| 8 | **B-8 / B-9** durum kapıları | Çift sevk + zombi mal | küçük |
| 9 | **B-4** cari-ode kilit + kalan düşümü | Fazla kapama | küçük |
| 10 | **B-5** ekstre seçimini `_odeme_eslesir`e indir | Yanlış firmaya tahsis | küçük |

> ⚠️ **Kuru çalıştırma kuralı:** 3, 5, 9, 10 numaralı düzeltmeler para değiştiriyor — uygulanmadan önce kuru çalıştırılıp listesi okunmalı.

---

## Ek dosyalar
- Zincir haritası: `denetim_raporlari/ZINCIR_HARITASI_siparis_to_cari.md`
- Fable ham çıktıları: `_fable_H1H2.md` · `_fable_H3H4.md` · `_fable_H5H6.md` · `_fable_H7.md`
- Codex ham çıktıları: `tmp/zincir_denetim/f_01.md` … `f_10.md`
