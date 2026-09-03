# 🔗 SİPARİŞ ZİNCİRİ ŞEMASI — şube siparişinden toptancı carisine

**Ölçüm:** 2026-09-03, dal `prod-denetim`, HEAD `c671517`.
Bütün satır numaraları bugün canlı koddan okundu (2026-09-01 haritasındakiler kaymıştı).

**Kapsam ölçüsü:** zincire dokunan **215 uç** (110 yazan · 105 okuyan).

---

## Tek cümlelik omurga

Şube panelinde PIN'le onaylanan talep → merkezde **iki kola** ayrılır (DEPO ya da TOPTANCI)
→ mal şubede kabul edilir → **stok artar** → belge talebi doğar (fatura kovalanır)
→ fatura bağlanınca **borç yazılır** → borç ödenince toptancının **cari bakiyesi** kapanır.

⚠️ **Gider, teslimde DEĞİL tüketimde doğar.** Teslim yalnız stok taşır; COGS ve
indirilecek KDV `urun-ac` anında yazılır. Zincirin en sık yanlış anlaşılan yeri burası.

---

## Akış

```
┌─ HALKA 0 · KAPI ────────────────────────────────────────────────┐
│ Günlük kasa PIN'le AÇIK olmalı · Şube açılışı TAMAM olmalı      │
│ 4 haneli personel PIN'i (dogrula_personel_panel_pin)            │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─ HALKA 1 · TALEP DOĞUŞU ── sube_panel.py ───────────────────────┐
│ POST /{sube}/siparis-onay             :6038   yeni talep        │
│ POST /{sube}/siparis-kalem-ekle       :5871   açığa BİRLEŞTİRİR │
│ POST /{sube}/siparis-ozel-talep       :5708   katalog dışı      │
│ POST /{sube}/siparis-yoklama          :6175   QR yolu (PIN'siz) │
│ GET  /{sube}/siparis-katalog :5162 · siparis-akisi :5266        │
│ ↳ siparis_talep (kalemler JSONB, durum='bekliyor')              │
│ ↳ siparis_ozel_talep                                            │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─ HALKA 2 · MERKEZ ÇATALI ── operasyon_merkez_api.py ────────────┐
│ GET  /siparis/kontrol-kulesi          :14845                    │
│ POST /siparis/sevkiyata-gonder        :10053  ─┐ DEPO kolu      │
│ POST /siparis/toptanciya-yolla        :10773  ─┘ TOPTANCI kolu  │
│ POST /siparis/kalem-iptal :10481 · merkez-iptal :10448          │
│ POST /siparis/akisi-iptal :10675 · birlestir :22098             │
│                                                                 │
│ ⚠️ İKİ AYRI GERÇEK:                                             │
│    kalemler        = şubenin İSTEDİĞİ                           │
│    kalem_durumlari = merkezin YAPTIĞI                           │
└───────────┬─────────────────────────────────┬───────────────────┘
            ▼                                 ▼
┌─ 3a · TOPTANCI KOLU ──────────┐  ┌─ 3b · DEPO / SEVKİYAT KOLU ──┐
│ toptanci_siparis satırı       │  │ GET  sevkiyat-listesi :13327 │
│  (durum='gonderildi', wa_id)  │  │ GET  depo-bekleyen    :13485 │
│ POST toptanci-geri-al  :11313 │  │ GET  sevkiyat-uyumsuz :13578 │
│ GET  toptanci-listesi  :12310 │  │ POST talep-tahsis-…   :13902 │
│ GET  toptanci-teslimler:12610 │  │ POST v2/…/tahsis      :14630 │
│ GET  tedarik-dosyasi   :12080 │  │ POST v2/…/sevk-cikti  :14654 │
│                               │  │ POST siparis-depo-sevkiyat-  │
│ 🔴 tedarikci_id BOŞSA zincir  │  │      kaydet (şube)     :5673 │
│    cari hesapta KOPAR         │  │ ↳ sube_depo_stok · stok_yolda│
└───────────┬───────────────────┘  └──────────┬───────────────────┘
            └──────────────┬──────────────────┘
                           ▼
┌─ HALKA 4 · TESLİM KABUL → STOK ─────────────────────────────────┐
│ POST /{sube}/urun-sevk               :3183  ← toptancının ASIL  │
│      (istek_izi ile tekrar koruması :3280 · :3737)     kapısı   │
│ POST /{sube}/urun-sevk-geri-al       :3839                      │
│ POST /{sube}/siparis-teslim-kabul    :5538                      │
│ POST /v2/siparis/{id}/kabul          :14695  (kadife)           │
│ POST /siparis/{id}/kabul-uyusmazligi-coz :11572                 │
│ ↳ STOK ARTAR · operasyon_defter · belge_talep DOĞAR             │
│ ↳ ⛔ GİDER YAZILMAZ                                             │
│                                                                 │
│ POST /{sube}/urun-ac                 :4152  ← TÜKETİM           │
│ ↳ 💰 COGS + indirilecek KDV BURADA doğar                        │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─ HALKA 5 · BELGE TALEBİ (fatura kovalama) ── belge_talep_api ───┐
│ GET  /bekleyen               :669   · /acik-teslimat    :2166   │
│ GET  /telafi-adaylari        :349   · POST /telafi-uygula :463  │
│ POST /elle                   :559                               │
│ POST /{id}/fatura-bagla      :1560  · fatura-bagla-geri-al:1460 │
│ POST /{id}/fatura-yukle      :2529                              │
│ POST /{id}/kapat             :2321  · kapanis-geri-al   :2466   │
│ GET  /zincir-izi             :2768                              │
│                                                                 │
│ 📊 GRNI = belge_talep WHERE durum='bekliyor' AND fatura_id NULL │
│    (mal geldi, fatura yok, para çıkmadı)                        │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─ HALKA 6 · FATURA → BORÇ ── fatura_api.py ──────────────────────┐
│ tedarikci_fatura (+ tedarikci_fatura_kalem)                     │
│ vadeli_alimlar (vadeye yazılan söz) · odeme_plani (taksit)      │
│ POST /kuyruk-tara :988  ← SÖZ KAPISI (SOZ_DEFTERI_URETIMI_ACIK) │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─ HALKA 7 · TOPTANCI CARİ HESABI — zincirin sonu ────────────────┐
│ GET  /cari-ozet              :6823  · /cari-ekstre      :7195   │
│ GET  /cari-devir :7018 · POST :7031 · DELETE /{id}      :7075   │
│ GET  /cari-odenecekler       :8521  · POST /cari-ode    :8651   │
│ POST /cari-ode-geri-al       :1697  · GET kanal-etkisi  :6828   │
│ GET  /odenecek-kuyruk        :1129                              │
│ GET  /cari-tahsis-onizle     :1367  · POST uygula       :1625   │
│ ↳ cari_devir · cari_odeme · cari_odeme_tahsis · tedarikciler    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Durum değerleri (kod genelinde ölçüldü)

| Alan | Aldığı değerler |
|---|---|
| `durum` (genel) | aktif · bekliyor · iptal · odendi · tamamlandi · onay_bekliyor · onaylandi · yolda · reddedildi · gonderildi · kabul_uyusmazlik · kabul_edildi · gecikti · acildi |
| `sevkiyat_durumu` | bekliyor · kismi_hazirlandi · toptanciya_yonlendirildi · depoda_hazirlaniyor · teslim_edildi · iptal · gonderildi |
| `sevkiyat_durum` | bekliyor · toptanciya_yonlendirildi · teslim_edildi · iptal · hazirlaniyor · gonderildi |
| `fis_kontrol_durumu` | bekliyor · geldi · gelmedi · muaf |

---

## İKİZ ALAN — ilk hükmüm YANLIŞTI, düzeltildi

`siparis_talep` tablosunda aynı kavram için iki sütun var (`sevkiyat_durum` 39 yer,
`sevkiyat_durumu` 121 yer). İlk bakışta bunu "kaza eseri ikiz alan, en sık kök kusur"
diye işaretledim. **Yanlıştı.**

Gerçeği: `sevkiyat_helpers.py` adında **bilinçli bir geçiş katmanı** var ve işini
yapıyor:

| Ne yapıyor | Nerede |
|---|---|
| Okuma her zaman COALESCE'ten (`SD_T`, `SD_ST`, `SD_NOALIAS`) | `sevkiyat_helpers.py:90-110` |
| Yazım **her iki kolona** (`sevkiyat_durumu_guncelle_params`) | `:113-127` |
| Legacy değer eşlemesi (`hazirlaniyor → depoda_hazirlaniyor`) | `:65-67` |
| Geçerli durum kümesi tek merkezde | `:55-62` |

Katmanı **6 dosya** kullanıyor: `operasyon_merkez_api` · `operasyon_stok_motor` ·
`siparis_kontrol_kulesi` · `siparis_sevkiyat_islem` · `sube_panel` · helper'ın kendisi.

### Kaçak taraması — katmanı atlayan var mı?

| Bulgu | Adet | Hüküm |
|---|---|---|
| Tek kolona yazım | 2 | ❌ Yanlış alarm — ikisi de **yorum satırı** |
| COALESCE'siz filtre | 3 | 2'si tek seferlik onarım göçü (ikisine de yazıyor) · **1'i canlı** |

**Tek gerçek kaçak:** `operasyon_merkez_api.py:1170` — operasyon panosundaki
"bekleyen sevkiyat" rozetini besleyen sayaç (`/api/ops/dashboard`,
`/api/ops/sube/{id}/canli`). `sevkiyat_durumu IN (...)` diye COALESCE'siz süzüyor.
`sevkiyat_durumu` boş ama legacy `sevkiyat_durum='hazirlaniyor'` olan bir satır varsa
rozet onu SAYMAZ; COALESCE'li kardeşi `/siparis/depo-bekleyen` (`:13503`) sayar.

**Canlı ölçüm (2026-09-03, salt okuma, 7 günlük pencere):**

| Şube | Rozet (COALESCE'siz) | depo-bekleyen (COALESCE'li) | Fark |
|---|---|---|---|
| ALSANCAK · KÖYCEĞİZ · TEMA · ZAFER | 0 | 0 | **0** |

Yani kusur kodda var ama **bugün ölçülebilir etkisi yok** — o durumda satır kalmamış.
Legacy-only bir satır doğarsa rozet eksik gösterir. Düşük öncelik, ama kayda geçti.

**Ders:** "iki sütun var" bir kusur değildir; kusur, ikisini uzlaştıran katmanın
olmaması ya da atlanmasıdır. Katman burada var ve neredeyse eksiksiz uygulanmış.

---

## Zincirin değişmezleri (simülasyonun ölçtüğü)

| # | Değişmez | Neden |
|---|---|---|
| I1 | Kabul edilen her teslim stoğu **tam bir kez** artırır | retry/çift tık çift saymamalı |
| I2 | GRNI **tam bir kez** sayılır | hem GRNI'de hem borçta olamaz; ikisinde birden yok da olamaz |
| I3 | Gider **tüketimde** doğar, teslimde değil | teslim yalnız stok taşır |
| I4 | Her ödeme cari bakiyeden **tam bir kez** düşer | 4 kanal: kasa · kart · cari_odeme · vadeli_alimlar |
| I5 | `kalemler` ≠ `kalem_durumlari` olabilir | her okuyucu hangisine baktığını bilmeli |
| I6 | İptal **yetim bırakmaz** | kaynaksız stok, teslimsiz belge talebi, faturasız borç olmamalı |

---

## 🟢 CANLI DOĞRULAMA — 2026-09-03, salt okuma

Kâğıt üstü simülasyonun yanında, zincirin sonundaki değişmezleri **canlı veriyle**
ölçtüm. Hiçbir yazan istek atılmadı.

### I2 — GRNI tam bir kez sayılıyor mu? ✅ TUTUYOR

```
hesaplanan_acik      727.209,25 ₺
faturasiz_teslimat    42.578,40 ₺   (GRNI: mal geldi, fatura yok)
                     ─────────────
gercek_borc          769.787,65 ₺   ← birebir eşit
```

GRNI **ayrı bir terim**; borca ayrıca eklenmiyor, borçtan da düşmüyor. Hem GRNI'de
hem borçta görünen para YOK. Değişmez tutuyor.

### Devir çizgisi doktrini ✅ TUTUYOR
`pencere_baslangic = 2026-06-01` · `pencere_kayar_mi = False` ·
`pencere_anlami = devir_cizgisinden_bugune_tamami`.
Kayan pencere değil, ÇİZGİ. Doğru.

### Aynı gerçeği sayan üç uç hemfikir mi? ✅ ARTIK EVET
| Uç | Sayı |
|---|---|
| `/belge-talep/bekleyen` | 3 |
| `/belge-talep/acik-teslimat` | 3 |
| `cari-ozet.faturasiz_teslimat_adet` | 3 |

**Eski bulgu kapandı:** 2026-08-09'da `acik-teslimat` 0 derken `bekleyen` 6 diyordu.
Bugün üçü de aynı sayıyı veriyor.

### I4 — her ödeme bakiyeden tam bir kez düşüyor mu? 🟢 AKTİF KORUMA VAR

`cari-ozet` her tedarikçi için `cift_kanal_elenen_adet` / `cift_kanal_elenen_tl`
döndürüyor: aynı ödemeyi birden fazla kanalda görüp **tekilleştirdiği** tutar.

| Tedarikçi | Elenen |
|---|---|
| FEZ KAHVE | 70.000,00 ₺ |
| MEHMET ATALAY | 50.000,00 ₺ |
| redbull | 21.482,10 ₺ |
| **TOPLAM** | **141.482,10 ₺ · 3 ödeme** |

Yani koruma çalışıyor ve **gerçek parayı** yakalıyor. ⚠️ Kalan risk: tekilleştirici
±3 günlük pencereyle eşleştiriyor. Aynı ödemenin iki kanala 3 günden uzun aralıkla
işlendiği bir durum elenmez → çift düşer. Bu, halka 6-7 simülasyonunun ölçtüğü konu.

### GRNI'si olan tedarikçiler (kırılım okunabiliyor ✅)
Sütaş 35.078,40 ₺ (2 teslimat) · MEHMET ATALAY 7.500,00 ₺ (1 teslimat).

---

## Yöntem

- **Şema + envanter + durum makinesi:** bu oturumda kod taranarak çıkarıldı.
- **Varyasyon simülasyonu:** üç Fable ajanı (halka 1-2-3 · 4-5 · 6-7), kâğıt üstünde,
  canlıya hiç dokunmadan.
- **Bağımsız kod-yolu doğrulaması:** Codex (ikiz alan + 6 değişmez), ayrı model,
  çapraz kontrol için aynı sorular.
- **Kod DEĞİŞTİRİLMEDİ.** Düzeltme varyasyonları öneri olarak toplanıyor.
