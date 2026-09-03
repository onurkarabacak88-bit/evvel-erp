# 🧪 SİPARİŞ ZİNCİRİ — VARYASYON SİMÜLASYONU

**Tarih:** 2026-09-03 · **Dal:** `prod-denetim` · **HEAD:** `c671517`
**Yöntem:** kâğıt üstü simülasyon (kod okuyarak) + canlı salt-okuma ölçümü.
**Kod DEĞİŞTİRİLMEDİ. Canlıya yazan istek atılmadı.**

**Araçlar:** 3 Fable ajanı (halka 1-2-3 · 4-5 · 6-7) + Codex (bağımsız doğrulama, ayrı model)
**Kapsam:** ~130 varyasyon hükme bağlandı · 215 uçluk zincir

---

## ÇAPRAZ DOĞRULAMA — iki model çelişti, çözdüm

Codex'e Fable'ın 5 kritik iddiasını verdim (kod parçalarıyla, dosya okutmadan).

| İddia | Fable | Codex | **Benim hükmüm** |
|---|---|---|---|
| P1-A · `toptanci-geri-al` koşulsuz reset | KUSURLU | **DOĞRULANDI** | ✅ Kusur gerçek |
| P1-B · ts-iptal aynı delik | KUSURLU | ❌ ÇÜRÜTÜLDÜ | ✅ **Fable haklı** — Codex yanlış parçaya baktı (benim çıkarma hatam) |
| P1-C · `lower()` vs `ad_anahtar` | KUSURLU | Yetersiz kanıt | ⏳ Parça eksikti, doğrulanmadı |
| P1-D · çift teslim | KUSURLU | **DOĞRULANDI** | ✅ Kendim de okudum, kusur gerçek |
| P1-E · sevk tavanı | KUSURLU | Yetersiz kanıt | ⏳ Parça eksikti |

**Ders:** iki modeli çalıştırmanın değeri buradaydı — biri diğerini çürüttü, ben
üçüncü kaynak olarak kodu okuyup çözdüm. Codex'in çürütmesi **benim verdiğim
parçanın yanlış olmasından** kaynaklandı (arama çapası "zombi" kelimesinin ilk
geçtiği yeri aldı, o da başka bir uçtu). Ajanın hükmü değil, benim girdi hazırlığım
hatalıydı.

---

## 🔴 P0 — ÇİFT STOK (en ağır)

**Nerede:** `sube_panel.py:3377`
**Ne:** Toptancı teslim kabulünde `toptanci_siparis` durum kapısı YALNIZ `'iptal'`
reddediyor; `'teslim_alindi'` reddetmiyor.

```python
if str(dict(_ts_chk).get("durum") or "") == "iptal":
    raise HTTPException(400, "Bu toptancı siparişi iptal edilmiş — teslim alınamaz.")
```

**Tetik:** Aynı talepte birden çok tedarikçi varsa (ya da eksik teslim olduysa) talep
`teslim_edildi` olmaz — açık kalır. Talep-seviyesi kapı (`:3385`) yalnız
`teslim_edildi`/`iptal` bakar, geçer. `istek_izi` tekrar koruması yalnız
**siparişsiz** dalda (`if not siparis_talep_id`). Sonuç: aynı teslim ikinci kez
işlenir, `sube_depo_stok` koşulsuz toplar → **stok iki kez artar**, `belge_talep`
`ON CONFLICT DO NOTHING` ile tek kalır, hiçbir iz kalmaz.

⚠️ Kodun kendi yorumu bunu **itiraf ediyor**: `operasyon_merkez_api.py:11572`
docstring'i "API'den ikinci teslim… stoğu MÜKERRER artırıyor" diyor — kapı
kapatılmamış.

**Önerilen (Fable, savunulan):** `UPDATE toptanci_siparis SET durum='teslim_alindi'
… WHERE id=%s AND durum='gonderildi'` + `rowcount==0 → 409`. Atomik, yarış-güvenli,
oku-sonra-yaz değil.

---

## 🔴 P1 — ZOMBİ TALEP (iki uçta aynı delik)

**Nerede:** `operasyon_merkez_api.py:11449-11460` (geri-al) ve `:11798-11807` (ts-iptal)

```sql
UPDATE siparis_talep SET durum='bekliyor', sevkiyat_durumu='bekliyor', ...
WHERE id=%s AND durum NOT IN ('teslim_edildi','iptal')
```

Koşul yalnız talebin **kendi** durumuna bakıyor; **depo koluna (`stok_yolda`) hiç
bakmıyor.**

**Tetik:** Talep hem depoya hem toptancıya ayrılmış. Depo malı yola çıkmış
(`stok_yolda.durum='yolda'`). Toptancı gönderimi geri alınır/iptal edilir → talep
`bekliyor`a düşer → şube kabul kapısı `gonderildi/hazirlaniyor/kabul_uyusmazlik`
istediği için **malı reddeder**. Mal fiziksel olarak gelmiş, sisteme girilemiyor.

⚠️ İronisi: `toptanciya-yolla`'nın **kısmi** dalında bu tam olarak düzeltilmiş
(`:11215` `CASE WHEN durum='bekliyor' THEN 'bekliyor' ELSE durum END`) ve yorumunda
"DEPO AYAĞI VARSA DURUM GERİ ÇEKİLMEZ" yazıyor. **Aynı ders iki uçta uygulanmamış.**

---

## 🔴 P1 — PARA / MUHASEBE İHLALLERİ

| # | Kusur | Yer | Zarar |
|---|---|---|---|
| 1 | **GRNI sipariş adediyle hesaplanıyor** | `belge_talep_olustur_izole` ts.kalemler okuyor | Eksik teslimde borç ŞİŞİK, fazlada EKSİK; `tutar_fark_tl` ters yön ("fatura ucuz" der, gerçekte tam) |
| 2 | **Ürün-aç: gider yazılıyor, stok düşmüyor** | `sube_panel.py:≈4228` defter, stok döngüsünden ÖNCE ve atlananlar DAHİL yazılıyor | `urun_id` boş kalem COGS'a ve indirilecek KDV'ye giriyor, stoktan düşmüyor. Gider ↔ stok iki ayrı kaynak |
| 3 | **GRNI ↔ bağsız fatura çift sayım** | şube foto yolu `belge_talep`e bağ kurmuyor | Fatura `fat_top`ta, aynı teslimat GRNI'de → `gercek_borc` ÇİFT (insan onayına kadar) |
| 4 | **Kart damgası manşet bakiyeye işlemiyor** | `fatura_api.py:6437` yalnız `aciklama` metnine bakıyor | Sahip bir kart çekimini "bu FEZ'in ödemesi" diye damgalasa, ekstre düşüyor ama **özet ve ödenecek-kuyruk düşmüyor** |
| 5 | **Kartla yapılan cari ödeme geri alınamıyor** | plan `kart_id=NULL` yazılıyor → geri-al kasa arıyor, bulamıyor | Bakiye doğru döner ama **kart HARCAMA satırı aktif kalır** → kart borcu/limit şişik; ikinci deneme aynı yerde düşer |
| 6 | **`kart-izi-onayla` tahsis yazıyor, geri-al çözmüyor** | `≈4864` kilitsiz; `odeme_id` = kart hareketi kimliği | Ekstreden gelen satırda cast patlıyor → sessizce yutuluyor. Aynı işlem iki farklı sonuç. Geri alınca tahsis kalıyor → BAĞLAMA ≠ KAPATMA ihlali |
| 7 | **Avans sonraki faturaya hiç mahsup edilmiyor** | havuz avansı görmüyor | Fazla ödeme bakiyeyi eksiye çeker ama yeni fatura tam açık görünür; kodun kendi notu "sonraki faturalara mahsup edilir" diyor — **doğru değil** |
| 8 | **Siparişli yanlış teslimi geri alan uç YOK** | üç kapı birbirine yönlendiriyor | `urun-sevk-geri-al` → "Merkez'den yapın"; `toptanci-geri-al` → 409; ts-iptal → "önce teslimi geri alın". **Dairesel.** Stok fazla + sahte GRNI borcu kalıcı |

---

## 🟢 CANLI DOĞRULANAN — bunlar ÇALIŞIYOR

| Değişmez | Ölçüm |
|---|---|
| **GRNI tam bir kez** | `gerçek borç 769.787,65 = açık 727.209,25 + GRNI 42.578,40` — birebir ✅ |
| **Devir çizgisi** | Pencere `2026-06-01`, `kayar_mi: False` — kayan pencere değil, çizgi ✅ |
| **Üç uç hemfikir** | `bekleyen` = `acik-teslimat` = `cari-ozet` = **3** (eski 0↔6 çelişkisi kapanmış) ✅ |
| **Çift kanal eleme** | **141.482,10 ₺ / 3 ödeme** tekilleştirilmiş: FEZ 70.000 · ATALAY 50.000 · redbull 21.482,10 ✅ |
| **Söz kapısı** | Kapı motorun içine alınmış; OCR ve yükle-pdf de oradan geçiyor ✅ |
| **Birleştirme ≠ mahsup** | Korunuyor ✅ |
| **Teslim gider yazmaz** | `urun-sevk` ve depo kabul yalnız stok — korunuyor ✅ |
| **İkiz sevkiyat kolonu** | `sevkiyat_helpers.py` geçiş katmanı; tek kaçak pano rozeti, canlı etkisi bugün **0** ✅ |

---

## ⚖️ KÖK KUSUR — tek cümle

> **Durum bir HESAP değil, bir YAZIM.** Her uç "talep şu an hangi durumda olmalı"
> sorusunu kendi bildiğince cevaplayıp yazıyor. Aynı soru zincirde **beş ayrı yerde
> beş ayrı formülle** cevaplanıyor (geri-al · ts-iptal · akisi-iptal · birlestir ·
> kabul). Zombi talep, erken kapanış, tavan aşımı — hepsi bunun türevleri.

**Fable'ın savunduğu çözüm:** `talep_durumu_hesapla(cur, talep_id)` — tek fonksiyon,
`stok_yolda` + `toptanci_siparis` + `kalem_durumlari` üçünü birden okuyup durumu
TÜRETİR; beş uç da onu çağırır. Bu tek değişiklik zombi, erken kapanış ve tavan
sorunlarını birden kapatır.

---

## İNCELENMEDİ (açıkça)

- P1-C (`lower()` vs `ad_anahtar`) ve P1-E (sevk tavanı) — Codex'e verdiğim kod
  parçaları eksikti, doğrulanamadı.
- Eşzamanlı iki merkez operatörünün aynı talebe farklı çatal uygulaması.
- `urun-sevk-geri-al` ucunun siparişli dalı (okunmadı).
- Ay devri / vade yaşlandırma ekseni.
- FE'nin `atlanan`/`uyari` alanlarını gösterip göstermediği.
- Canlı: damgalı kart satırlarının toplamı, yarım kalmış kart geri almaları, yetim
  `cari_odeme_tahsis` satırları (yazan istek gerektirmiyor ama ölçülmedi).

---

## SIRADAKİ ADIM — sahip kararı

Hiçbiri uygulanmadı; hepsi öneri. Öncelik sırası:

1. **P0 çift stok** — tek satırlık atomik kapı, riski yok.
2. **Zombi talep** — iki uçta, `toptanciya-yolla`'da zaten yazılmış düzeltmenin kopyası.
3. **Durum türetme fonksiyonu** — kök çözüm, daha büyük iş, 4 kusuru birden kapatır.
4. **Para tarafı** (GRNI adedi · ürün-aç defter/stok ayrışması · kart damgası) —
   her biri ayrı ölçüm ister; bazıları canlı rakamı DEĞİŞTİRİR, önce kuru çalıştırma.
