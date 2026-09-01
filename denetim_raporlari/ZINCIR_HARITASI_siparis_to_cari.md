# 🔗 SİPARİŞ ZİNCİRİ HARİTASI — şube panelinden toptancı cari hesabına

Ölçüm: 2026-09-01, dal `prod-denetim`. Bütün satır numaraları canlı koddan okundu.

## Zincirin omurgası (tek cümle)
Şube panelinde PIN'le onaylanan talep → merkezde iki kola ayrılır (DEPO ya da TOPTANCI)
→ mal şubede kabul edilir → stok artar → belge talebi doğar (fatura kovalanır)
→ fatura bağlanınca borç yazılır → borç ödenince toptancının cari bakiyesi kapanır.

## HALKA 0 — KAPI (talep doğmadan önce)
| Kural | Yer |
|---|---|
| Günlük kasa PIN'le açılmadan sipariş YOK | sube_panel.py:5429 · 5568 · 5684 |
| Şube açılışı tamamlanmadan sipariş YOK | sube_panel.py:5431 · 5570 · 5686 |
| PIN doğrulama (4 hane) | dogrula_personel_panel_pin — sube_panel.py:5433 |

## HALKA 1 — TALEP DOĞUŞU (şube paneli)
| Kapı (uç) | Ne yapar | Yer |
|---|---|---|
| POST /{sube}/siparis-onay | Yeni talep açar; açık talep varsa 409 uyarısı | sube_panel.py:5683 |
| POST /{sube}/siparis-kalem-ekle | Açık talebe kalem EKLER (birleştirir), yoksa yeni açar | sube_panel.py:5530 |
| POST /{sube}/siparis-ozel-talep | Katalogda olmayan ürün — ayrı tabloya, merkez onayına | sube_panel.py:5407 |
| POST /{sube}/siparis-yoklama | QR yoklama oturumuyla sipariş (PIN'siz yol) | sube_panel.py:5815 |
| GET /{sube}/siparis-katalog, /siparis-akisi | Şubenin gördüğü liste | sube_panel.py:4900 · 5004 |

**Yazılan tablo:** `siparis_talep` (kalemler JSONB, durum='bekliyor') · `siparis_ozel_talep`
**Yan defter:** operasyon_defter (SIPARIS_ONAY_PIN) + operasyon_stok_motor.siparis_olustu_kaydet (davranış uyarıları)

## HALKA 2 — MERKEZ KUYRUĞU ve YÖNLENDİRME
| Kapı | Ne yapar | Yer |
|---|---|---|
| GET /ops/siparis/kontrol-kulesi | Kadife ekranın ana listesi | operasyon_merkez_api.py:14083 |
| GET /ops/v2/bekleyen-siparisler | v2 bekleyenler | :20891 |
| POST /ops/siparis/sevkiyata-gonder | **DEPO kolu** — hedef_depo_sube_id / sevkiyat_sube_id damgalanır | :9849 |
| POST /ops/siparis/toptanciya-yolla | **TOPTANCI kolu** — toptanci_siparis satırı + WhatsApp | :10491 |
| POST /ops/siparis/kalem-iptal · merkez-iptal · akisi-iptal | Kalem/talep iptali | :10226 · :10193 · :10393 |
| POST /ops/siparis/birlestir | İki talebi tek talebe indirir | :21132 |

**Çatal burada:** `siparis_talep.kalem_durumlari` (JSONB) her kalemin hangi kola gittiğini tutar.
`kalemler` = şubenin istediği · `kalem_durumlari` = merkezin yaptığı → **iki ayrı gerçek**.

## HALKA 3a — TOPTANCI KOLU
| Kapı | Yer |
|---|---|
| toptanci_siparis satırı (durum='gonderildi', wa_mesaj_id) | database.py:3646 |
| POST /ops/siparis/{talep_id}/toptanci-geri-al | operasyon_merkez_api.py:10949 |
| POST /ops/siparis/toptanci-siparis/{ts_id}/iptal · whatsapp-yeniden-gonder | :11265 · :11556 |
| GET /ops/siparis/toptanci-listesi · toptanci-teslimler · tedarik-dosyasi/{id} | :11860 · :12129 · :11681 |

**Cari hesaba giden kritik alan:** `toptanci_siparis.tedarikci_id` — boş kalırsa zincir burada kopar.

## HALKA 3b — DEPO / SEVKİYAT KOLU
| Kapı | Yer |
|---|---|
| GET /ops/siparis/sevkiyat-listesi · depo-bekleyen · sevkiyat-uyumsuzluklar | :12831 · :12989 · :13082 |
| POST /ops/siparis/sevkiyat-uyumsuzluk-coz · talep-tahsis-uyumsuzluk-coz · sevkiyat-guncelle | :13132 · :13340 · :13491 |
| POST /ops/v2/siparis/{id}/tahsis · sevk-cikti (kadife uçları) | :13939 · :13957 |
| POST /{sube}/siparis-depo-sevkiyat-kaydet (depo şubesi çıkışı yazar) | sube_panel.py:5372 |

**Tablolar:** `sube_depo_stok` (düşer/artar) · `siparis_sevk_eksik` (eksik gelen)

## HALKA 4 — TESLİM KABUL → STOK
| Kapı | Yer |
|---|---|
| POST /{sube}/siparis-teslim-kabul | sube_panel.py:5258 |
| POST /ops/v2/siparis/{id}/kabul (kadife) | operasyon_merkez_api.py:13976 |
| POST /ops/siparis/{talep_id}/kabul-uyusmazligi-coz | :11149 |
| Stok artışı motoru | operasyon_stok_motor.py |

## HALKA 5 — BELGE TALEBİ (fatura kovalama)
| Kapı | Yer |
|---|---|
| `belge_talep` satırı teslim anında doğar | fatura_api.py:6875 (açıklama) |
| GET /belge-talep/acik-teslimat · bekleyen | belge_talep_api.py:2026 · 615 |
| POST /belge-talep/{id}/fatura-bagla · fatura-bagla-geri-al | :1475 · :1406 |
| POST /belge-talep/{id}/fatura-yukle · kapat · kapanis-geri-al | :2359 · :2180 · :2296 |
| GET /belge-talep/zincir-izi | :2575 |

## HALKA 6 — FATURA → BORÇ
| Kapı | Yer |
|---|---|
| `tedarikci_fatura` (+ `tedarikci_fatura_kalem`) | fatura_api.py:90 |
| `vadeli_alimlar` (vadeye yazılan borç) | database.py:3062 |
| POST /fatura-ode · fatura-vadeye-yaz (kadife ÖdemeModülü) | OdemeModulu.jsx |
| odeme_plani (taksit/plan) | odeme_plani_api.py |

## HALKA 7 — TOPTANCI CARİ HESABI (zincirin sonu)
| Kapı | Ne yapar | Yer |
|---|---|---|
| GET /fatura/cari-ozet | Toptancı bazında bakiye özeti | fatura_api.py:6648 |
| GET /fatura/cari-ekstre | Firma ekstresi (borç/alacak satırları) | :6916 |
| GET /fatura/cari-devir · POST · DELETE · geri-al | Devir ÇİZGİSİ | :6773 · :6786 · :6810 · :6839 |
| GET /fatura/cari-odenecekler · POST /fatura/cari-ode | Ödeme | :8153 · :8238 |
| GET /fatura/odenecek-kuyruk · cari-tahsis-onizle · cari-tahsis-uygula | Kuyruk + FIFO tahsis | :1095 · :1324 · :1582 |
| POST /fatura/cari-ode-geri-al | :1654 |
| `_faturasiz_teslimat_ozet` (GRNI: mal geldi fatura yok) | :6872 |

**Tablolar:** `cari_devir` · `cari_odeme` · `cari_odeme_tahsis` · `tedarikciler`

## Kadife (v2) ekranların zincire bakan yüzü
| Ekran | Dosya | Zincirin hangi halkası |
|---|---|---|
| Ops Modülü | src/pages/v2/OpsModulu.jsx (7809 satır) | Halka 2-3-4 (kontrol kulesi, sevkiyat, toptancı) |
| Belge Modülü | src/pages/v2/BelgeModulu.jsx | Halka 5 + cari-ekstre |
| Ödeme Modülü | src/pages/v2/OdemeModulu.jsx | Halka 6-7 |
| Eşleşme Modülü | src/pages/v2/EslesmeModulu.jsx | Fatura-ödeme eşleşme kararları |
