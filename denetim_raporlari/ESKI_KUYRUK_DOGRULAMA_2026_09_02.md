# ESKİ DÜZELTME KUYRUĞU — TAM DOĞRULAMA SWEEP'İ
**Tarih:** 2026-09-02 · **Kaynak defter:** `project_denetim_duzeltme_sirasi.md` (2026-08-11)
**Yöntem:** 10 parça, paralel bağımsız doğrulama. Codex kotası 1 parçadan sonra doldu;
kalan 9 parça Fable ajanlarıyla yürütüldü. Her hüküm DOSYA:SATIR + KANIT ile verildi.

## ⚠️ SAYIM DÜRÜSTLÜĞÜ
Defterde **156 satır** vardı; doğrulayıcılar **170 hüküm bloğu** üretti.
Fark üç sebepten: (a) bazı ID'ler birlikte hükme bağlandı (`RAPOR-001/009`),
(b) bazıları ayrıştı (`PERS-006/007`), (c) bir yeni bulgu eklendi (`SYS-AUDIT`).
Bu **yeni bulgu değil, aynı evrenin farklı granülasyonu** — tek tek ID bazında izlenebilir.

## ÖZET

| Durum | Adet | Oran |
|---|---:|---:|
| 🔴 **AÇIK** — hiç dokunulmamış | **94** | %55 |
| 🟡 **KISMEN** — bir yarısı kapandı | **48** | %28 |
| ✅ **KAPALI** — doğrulandı | **27** | %16 |
| ⚖️ **SAHİP KARARI** | **1** | %1 |

**Yorum:** kuyruğun %16'sı kapanmış. Ama "kapalı"ların çoğu bu oturumdaki zincir
denetiminden değil, aradaki günlerde yapılan işlerden geliyor — yani defter zaten
kısmen eskimişti. 48 "KISMEN" en tehlikeli sınıf: **bir yarısı kapalı olduğu için
"halloldu" sanılıyor.**

## MODÜL DAĞILIMI (açık+kısmen'e göre sıralı)

| Modül | AÇIK | KISMEN | KAPALI |
|---|---:|---:|---:|
| OPS (operasyon) | 21 | 5 | 3 |
| PERSONEL | 10 | 3 | 2 |
| RAPOR + VERİ | 13 | 8 | 1 |
| TANIM + ONAY + MALİYET | 13 | 4 | 1 |
| TRUTH (akıllı denetim) | 8 | 2 | 1 |
| ŞUBE + CEP + ENTEGRASYON | 11 | 11 | 1 |
| BORÇ + KART | 3 | 8 | 5 |
| PANEL | 6 | 2 | 4 |
| PARA | 4 | 3 | 5 |
| BAŞVURU | 5 | 2 | 4 |

Borç/Kart ve Para en olgun alanlar (çok "kapalı"), OPS ve Rapor/Veri en ham.

---

# 🔴 FAZ 0 — PARA YANLIŞI (sessiz, canlı, geri alınamaz)

Bunlar rakamı BUGÜN yanlış gösteriyor ya da parayı sessizce kaybediyor.

| ID | Ne oluyor | Yer |
|---|---|---|
| **PARA-011** | Ağ retry'ı borcu **sessizce İKİYE KATLIYOR** — aynı tedarikçide tek açık borç varsa POST onay sormadan tutarı üstüne topluyor | main.py:12015 |
| **PARA-010** | Ciro düzeltmesi net tutarı değiştirmiyorsa `ON CONFLICT` sessiz yutuyor: eski kayıt iptal, yenisi yazılmamış → **kasa etkisi kayboluyor** | main.py:9435 |
| **BORC-001** | `kart_gelecek_ay_yuk` yıllık faizi aylık gibi kullanıyor → **12 kat şişkin faiz** | main.py:6615 |
| **BORC-004** | Ödeme planı taksidi anlık borcun üstüne ekleniyor → **çift sayım** | main.py:6588 |
| **RAPOR-006** | Kart faizi hem `kart_toplam` içinde hem ayrı satır → raporda **çift sayım** | main.py:14407 |
| **KART-013** | Negatif tutarlı HARCAMA kart borcunu **DÜŞÜRÜR** (kasa bacağı korunmuş, kart defteri korunmamış) | main.py:5833 |
| **PERS-011** | Toplu ödeme personel maaş onay guard'ını **atlıyor** — onaysız maaş kapatılabiliyor | main.py:14275 |

# 🔒 FAZ 1 — KORUMASIZ YIKICI UÇ / AÇIK PII

| ID | Ne oluyor | Yer |
|---|---|---|
| **VERI-002 / 011 / 012** | `/api/sistem-sifirla`'nın tek koruması istemcinin gönderdiği `onay:'EVET_SIL'` sabiti. PIN yok, yedek yok, audit yok. `kasa_teslim` ve **`audit_log` bile silinebilir listede** | main.py:15427 |
| **ONAY-002** | Onay/red/toplu-onay **para** uçlarında hiçbir guard yok (guard var ama main.py import bile etmiyor) | main.py:9119 |
| **CEP-004** | `/api/gorev/sube-personel/{id}` tüm personelin **telefonunu** auth'suz döndürüyor | gorev_api.py:203 |
| **ENT-008 / 009** | Günlük WhatsApp özeti personel adlarını ve maaş kalemlerini tek gruba gönderiyor, redaksiyon yok | whatsapp_bildirim.py:340 |
| **SYS-AUDIT** | `audit_log`'da **aktör kolonu yok** — hiçbir kayıt "kim yaptı" bilgisini taşıyamıyor | database.py:4048 |

**Kendi ek ölçümüm:** `DELETE`/`TRUNCATE` içeren 42 POST/DELETE ucundan **23'ünde
hiçbir koruma yok** (PIN/kapı/audit/yedek). Telafi silmeleri ayıklandı, bu sayı gerçek
kullanıcı verisi silen uçlar.

# 🟢 FAZ 2 — SAHTE YEŞİL / YANLIŞ TANI

| ID | Ne oluyor |
|---|---|
| **TRUTH-012** | Motor o gün hiç çalışmamışsa kontrol **"ok" (yeşil)** basıyor |
| **TRUTH-011** | KAOS = "belirsiz" tanımlı ama **hırsızlık anlatısına** eşlenmiş ("kasa baskını + hukuki süreç") |
| **TRUTH-013** | Zimmet şüphesi sonraki katmanda **sayım hatasına** dönüşüyor — sinyal kayboluyor |
| **TRUTH-001** | Hardcode fiyatla %85 uyumda **kesin ZİMMET** tanısı; "olası" etiketi yok |
| **TRUTH-007** | 4 sprint çıplak `except pass` — eksik boyut sessizce "temiz" sayılıyor |
| **TRUTH-004** | Aynı günlük fark hem sabahçıya hem akşamcıya sayılıyor (çifte suçlama) |
| **TRUTH-009** | "Doğru Tespit" düğmesi modelin **kendi tahminini** gerçek etiket yazıyor |
| **PANEL-013** | Çıplak `except pass` → ödenmiş plan **sahte gecikmiş** görünüyor |
| **OPS-014** | `hub-ozet` fallback'i her sayacı 0 döndürüyor, degraded bayrağı yok |

# 📏 FAZ 3 — AYNI METRİK İKİ FARKLI TANIMLA

| ID | Çelişki |
|---|---|
| **OPS-008** | Aylık food cost: `toplam_gider/ciro` (cache) vs `ürün-aç COGS/ciro` (motor) |
| **OPS-007 / 018** | Food cost kartı ×100'süz + truthy filtre %0 günleri düşürüyor |
| **RAPOR-002 / 003** | Ledger özeti ve aylık rapor iki farklı gider formülü; ikisi de cache okumuyor |
| **PERS-002** | İşçilik böleni **225**, bordro böleni **285** |
| **BORC-002** | `/ozet` ve `/takvim` iki farklı kart borcu tanımı |
| **MALIYET-012** | Fire kırılımda var, toplamda yok → kırılım toplamı `genel_toplam`'ı aşıyor |
| **OPS-017** | Pivot fiyat **MAX**'a terfi ediyor → stok değeri şişkin |
| **OPS-002** | Kronik kart: adet bir evrenden, tutar başka evrenden |

# 🔑 FAZ 4 — KİMLİK / YETKİ

SUBE-001/002/003/008 · PERS-004/010 · OPS-021/025 · CEP-001 · ONAY-005/006 ·
BASVURU-002/003/009/010 · ENT-001/005

Ortak desen: **aktör istemci beyanı**. `personel_id` gövdeden geliyor, doğrulanmıyor.
PIN alanı var ama yalnız biçimi kontrol ediliyor (OPS-021).

# ⚙️ FAZ 5 — VERSİYON / İZ / TARİH ÇIPASI

TANIM-001/002/004/005/006/007 · OPS-023/027 · PARA-012 · MALIYET-013/014 ·
TRUTH-006 · RAPOR-011 · PANEL-008/010 · PARA-006

Ortak desen: **yerinde UPDATE + CURRENT_DATE çıpası.** Geçmiş yeniden üretilemiyor.
(Bu, hafızadaki *Kayan Pencere ≠ Çıpa* dersinin aynısı — başka modüllerde.)

# 🧹 FAZ 6 — DAYANIKLILIK / PERFORMANS / EKRAN

VERİ-003/006/007/008/009/010 · SUBE-004/005/006/007/009 · CEP-002/003 ·
ENT-003/004/006/007/011 · OPS-001/005/016/022/024/026/029/030 ·
PANEL-001/009/011/012 · RAPOR-004/007/008/010/012/013 · PERS-003/005/006/007/014/015/016/017 ·
MALIYET-007 · ONAY-001/003/004 · KART-003/007/009/011/012 · BORC-005/010 ·
BASVURU-007/008/011 · TRUTH-003/010 · OPS-003/004/009b/010/011/012/015 · SUBE-... · PARA-002/005/013

---

## ⚖️ SAHİP KARARI BEKLEYEN

**KART-002** — ekstre bulanık eşleşmesi (tutar+tip+tarih ±3 gün, açıklama umursanmaz).
Kod bunu gerekçeli bilinçli tasarım olarak ilan ediyor ve her sistem kaydının en fazla
bir ekstre satırınca tüketilmesiyle sınırlıyor. **Sahip imzalı bir karar kaydı yok** —
hüküm yalnız kod yorumundaki tasarım beyanına dayanıyor.

## KAPANDIĞI DOĞRULANANLAR (27)

OPS-013/019/020 · PANEL-002/003/005/007 · TRUTH-002 ·
PARA-001/003/004/008/009 · BORC-003/006/011 · KART-001/004 ·
PERS-012/013 · BASVURU-001/004/005/006 · RAPOR-005 · MALIYET-011 · ENT-002

## HAM ÇIKTILAR
`tmp/eski_denetim/out_*.txt` (10 koşu) · istemler `tmp/eski_denetim/p_*.txt`
