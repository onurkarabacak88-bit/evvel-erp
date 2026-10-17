# ✂️ EVVEL YENİ — ESKİ SİSTEM KESİM LİSTESİ

> Sahip (2026-10-17): "Eski sistemi kaldırdığımda köprü ve bağımlılık kalmasın."
> Kural: Eski Evvel ancak bu listedeki HER satır ✅ olunca kaldırılır.
> Durum: ❌ köprüyle eskiden okuyor · 🟡 çift yazım var (panel hem eskiye hem yeniye yazıyor) ama okuyucu henüz eskide · ✅ koptu
> Kesim yolu (her satır için): **köprü okur → panel çift yazar → okuyucu yeni deftere geçer → köprü kodu SİLİNİR → eski tablo arşiv**

## 0. Önce bilinmesi gereken
- **Şube paneli (sube_panel.html + sube_panel.py + sube_operasyon.py + gorev_api.py) teknik olarak ESKİ sistemin parçası.** Şubeler her gün kullanıyor.
  Eski sistem kaldırılırken panel KALIR; ama arka ucu yalnız Evvel Yeni defterlerine (ey_*, para_izi_*) yazacak hâle getirilmeli.
  Panel taşınmadan "eski sistemi kaldırmak" = eski MERKEZ ekranlarını ve eski hesap motorlarını kaldırmak demektir.
- **Giriş (oturum):** Evvel Yeni, Evvel'in oturum jetonunu kullanıyor (`admin_oturum`, `kullanici`). Kendi kullanıcı/oturum tanımı yok.

## 1. Modül modül bağımlılıklar

| # | Modül | Eskiden okuduğu | Ne için | Yerine | Durum |
|---|---|---|---|---|---|
| 1 | **Kasa** | ciro, ciro_taslak, sube_operasyon_event | kapanış nakdi/POS | panel kapanışı → ey_sube_olay (çift yazım VAR) | 🟡 |
| 2 | Kasa | kasa_teslim | şube → patron teslimi | panel teslimi → ey_sube_olay | 🟡 |
| 3 | Kasa | anlik_giderler | dükkân gideri | panel gideri → ey_sube_olay | 🟡 |
| 4 | Kasa | personel_avans | elden avans | avans → ey_sube_olay | 🟡 |
| 5 | Kasa | kasa_hareketleri, kullanici, personel | eski aktarım, kişi adları | ey_personel + ey_* | ❌ |
| 6 | **Gider** | operasyon_defter (ürün aç), urun_alis_fiyat, kalem_kdv_oran, siparis_urun | mal gideri = ürün aç × fiyat | ürün aç → ey_sube_olay (VAR); fiyat → Evvel Yeni ürün fiyatı (ey_urun_fiyat VAR, son alış eski) | 🟡 |
| 7 | Gider | stok_yolda, siparis_talep, merkez_stok_sevk | depodan sevk bedeli | Depo defteri (ey_stok_hareket) | ❌ |
| 8 | Gider | sube_operasyon_event | kapanış kesin mi | ey_sube_olay | 🟡 |
| 9 | **Depo** | operasyon_defter (URUN_SEVK, URUN_AC, KULLANIMA_AL, IPTAL) | giriş, tüketim | panel → ey_stok_hareket doğrudan | ❌ |
| 10 | Depo | stok_yolda | sevk / kabul | sevk/kabul ekranları → ey_stok_hareket | ❌ |
| 11 | Depo | sube_fire_bildirim | fire | fire → ey_stok_hareket | ❌ |
| 12 | Depo | sube_depo_stok | yalnız "eski sistem diyor" | SİLİNECEK | ❌ |
| 13 | **Ürün kataloğu** (Depo, Fiyatlar, Bar, Satış) | siparis_urun, siparis_kategori | ürün adı, kategori, birim | Evvel Yeni ürün tanımı (Tanımlar → Ürünler) — YOK, kurulacak | ❌ |
| 14 | **Bar** | sube_operasyon_event (açılış/kapanış stok sayımı), operasyon_defter, stok_yolda, ciro_taslak | bar sayımı, gece giren | ey_sube_olay (sayım meta'sı VAR) + ey_stok_hareket | 🟡 |
| 15 | **Satış kontrolü / Devir defteri** | sube_operasyon_event, ciro_taslak, kapanis_kayit, kasa_teslim, anlik_giderler, sube_fire_bildirim | kör sayım, devir, vardiya devri, teslim | ey_sube_olay (kapanış/açılış/teslim VAR; vardiya devri YOK) | 🟡 |
| 16 | **Maaş** | personel_aylik, odeme_plani | Ekim ve öncesi eski hesap + ödenen | Kasım'dan itibaren yeni hesap; eski aylar arşiv (salt okunur rapor) | 🟡 |
| 17 | Maaş / Takvim / Yoklama | gorev_yoklama, vardiya_atama, vardiya_slot | QR girişi, vardiya planı | panel QR + vardiya planı → ey tablosu (vardiya çift yazımı YOK) | ❌ |
| 18 | **Tanımlar** | subeler, personel, kartlar, tedarikciler | ilk kopya (bir kez) | kopya kodu SİLİNECEK (veri zaten ey_*'de) | 🟡 |
| 19 | **Kartlar** | kartlar, kart_ekstre_donem | ilk çıpa (bir kez) | çıpa kodu SİLİNECEK | 🟡 |
| 20 | **Kiralar** | sabit_giderler, odeme_plani, kasa_hareketleri | ilk kira tanımı + eski ödenen geçmiş | tanım ey_sube_kira'da; eski ödenenler arşiv | 🟡 |
| 21 | **Toptancılar** | urun_alis_fiyat, kalem_kdv_oran, siparis_urun | tahmini borç fiyatı | Evvel Yeni ürün fiyatı | 🟡 |
| 22 | Toptancılar | (panel /urun-sevk kancası yazıyor) | teslim → borç | panel taşınınca doğrudan | 🟡 |
| 23 | **Olay kontrolü** | anlik_giderler, kasa_teslim, operasyon_defter, sube_operasyon_event | eski ↔ yeni karşılaştırma | kesimde SİLİNECEK | — |
| 25 | **Avans talepleri** (2026-10-17) | personel_avans + avans_service (onay/ret) | personelin QR talebi, onay | ⚠ 1 KASIM ÖNCESİ (envanter 35): Kasım'dan EY maaşı eski personel_avans'ı OKUMAZ → havale avansı EY Ödeme'ye (Personel/Avans, banka) yazılmalı; QR talebi doğrudan EY'ye | ❌ |
| 26 | **Fiş kontrol / Kredi / Kart takvimi köprüleri** (2026-10-17) | anlik_giderler (personel adı, kart/havale giderleri), odeme_plani (eski ödenen taksit/kart), borc_envanteri (bir kez kopya) | geçiş | panel doğrudan EY'ye; eski ödemeler arşiv | ❌ |
| 24 | **Gelir, Kazanç, Ödeme** | — | — | eski bağımlılık yok | ✅ |

## 2. Eski koddan Evvel Yeni'ye yazan kancalar (panel taşınınca ANA yazar olacak)
- sube_operasyon.py (açılış/kapanış → ey_sube_olay; operasyon_deneme)
- sube_panel.py (ara teslim, dükkân gideri, kapanış geri al, urun-sevk → toptancı teslimi)
- kasa_teslim_api.py (teslim), avans_service.py (avans), operasyon_defter.py (ürün aç / stok ekle / fire)
- sube_kapanis_dual.py (panel_kapanis_yaz), gorev_api.py (mühür bilgisi)

## 3. Kesim sırası (öneri)
1. **Ürün kataloğu Evvel Yeni'ye** (madde 13) — Depo, Fiyat, Bar, Satış, Gider buna bağlı.
2. **Depo çift yazımı** (9–11) — panel teslim al / ürün aç / fire / sevk / kabul → ey_stok_hareket.
3. **Vardiya ve QR çift yazımı** (17) ve vardiya devri (15).
4. **Okuyucuları yeni deftere çevir** (1–8, 14–15): ey_sube_olay ile eski tablo birebir tutunca (olay kontrolü ✓) köprüler kapatılır.
5. **Tek seferlik kopya/çıpa kodlarını sil** (18–20).
6. **Eski merkez ekranları + hesap motorları kaldırılır**; panel arka ucu yalnız ey_*'ye yazar; eski tablolar arşiv.
7. Bu listede ❌/🟡 kalmayınca eski Evvel kapatılır.
