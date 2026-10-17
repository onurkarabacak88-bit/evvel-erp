# 🗂️ ESKİ EVVEL — ÖZELLİK ENVANTERİ (TAŞI / DÜZELT / ÇIKAR)

> Sahip (2026-10-17): "Evvel'de kurgulanmış, hatalı bile olsa birçok şey vardı — sırayla revize ederek ya da çıkararak, daha sade."
> Kaynak: kod taraması (59 aile) + canlı veritabanı ölçümü (her ailenin tablolarına SON 30 GÜNDE yazılan kayıt).
> Ham ayrıntı (dosyalar, uçlar, tablolar): `tmp/eski_envanter_ham.md` · ölçüm: `tmp/eski_tablo_kullanim.json`
> ⚠️ "30 gün" sayısı = tabloya yazılan kayıt. 🤖 = çoğu GECE MOTORUNUN otomatik yazdığı (insan kullanımı değil).
> Karar: **T** taşı (sadeleşmiş, Evvel Yeni modülü) · **D** düzelt (fikir doğru, kurgu yeniden) · **Ç** çıkar · **K** kalır (dokunulmaz)

## A. Evvel Yeni'de karşılığı VAR → eski ekran/motor ÇIKAR (köprü kesilince)

| Kod | Aile | 30 gün | Yerine | Öneri | Sahip |
|---|---|---|---|---|---|
| F01 | Kasa defteri | 182 | Kasa | Ç | |
| F03 | Kasa teslim & banka yatırımı | 27 | Kasa | Ç | |
| F06 | Anlık gider | 22 | Ödeme (panelden gelen gider Kasa'ya düşüyor) | Ç | |
| F07 | Vadeli alımlar | 0 (Ağu) | Toptancılar | Ç | |
| F09 | Kredi kartı merkezi (47 uç) | 28 | Kartlar | Ç | |
| F12 | Tedarikçi ödeme olayları | 2 | Toptancılar | Ç | |
| F15 | Dış kaynak geliri | (kasa) | Kasa'ya elle giriş | Ç | |
| F16 | İşletmeci (şahsi harcama sahibi) | 0 | Ödeme › Patron harcamaları | Ç | |
| F17 | Para Nerede şelalesi | – | Kasa (Kasam) | Ç | |
| F22 | Merkez/şube depo stoğu | 212 | Depo | Ç | |
| F27 | Kâr & maliyet, P&L | 78 🤖 | Şube kazancı | Ç | |
| F28 | Alış fiyatları & zam takibi | 0 | Toptancılar › Ürün fiyatları | Ç | |
| F29 | Tedarikçi tanımları | 0 | Tanımlar › Toptancı | Ç | |
| F34 | Personel, maaş, bordro | 47 | Personel (Kasım'dan yeni hesap) | Ç | |
| F39 | Personel kimlik birleştirme | 9 | Tanımlar › Personel | Ç | |
| F52 | Aylık rapor & rapor önbelleği | 144 🤖 | Gelir / Gider / Şube kazancı | Ç | |

## B. KULLANILIYOR, karşılığı YOK ya da YARIM → TAŞI / DÜZELT

| Kod | Aile | 30 gün | Öneri | Neden / nasıl | Sahip |
|---|---|---|---|---|---|
| F02 | Ciro girişi & onayı | 271 | D | Ciro panel kapanışından geliyor; "onay" Gelir'e (Evo ile kurtarma YOK — Evo kullanılmıyor) | |
| F04 | Ödeme planı / vade takvimi | 369 🤖 | D | Planı gece motoru üretiyor; yeni modelde ödenecek = açık bakiye. Yalnız "vade takvimi" görünümü Ödeme'ye | |
| F05 | Sabit giderler (aidat, internet, muhasebe…) | 0 | D | Kira taşındı; diğer aylık sabitler Gider'e küçük "sabit gider" tanımı | |
| F08 | Banka kredileri & büyük borçlar | 0 (Haz) | T | Gerçek borç; Evvel Yeni'de yok. Sade "Krediler": taksit, kalan, Bekleyen işler'e son ödeme | |
| F19 | Onay kuyruğu | 115 | D | Panelin riskli işlemleri sahibe düşüyor; Evvel Yeni Bekleyen işler'e + yetkilendirmeyle | |
| F20 | Sipariş zinciri (katalog → sipariş → sevk → kabul) | 185 | T | Sahip: "sipariş ayrı alan". En büyük taşıma; ürün kataloğu ilk adım | |
| F23 | Ürün aç / kullanılan ürün | 1.163 | T | Panel her gün yazıyor; Depo defterine DOĞRUDAN yazsın, 5.366 satırlık motor çıkar | |
| F25 | Fire bildirimi (+foto) | 30 | T | Panel kullanıyor; Depo'ya fire hareketi doğrudan | |
| F30 | Fatura & belge merkezi (OCR, cari) | 40 | D | 12.300 satır. Sade: Toptancı teslimine fatura foto/PDF + tutar; OCR/cari motoru çıkar | |
| F35 | Avans | 2 | T | Kasa okuyor; girişi Evvel Yeni Personel/Ödeme'den | |
| F36 | Vardiya planlama | 716 | T | Panel okuyor; sade plan (kadro: Alsancak 1 tam + 1 part gibi) | |
| F37 | Görev / QR yoklama | 868 | T | Panel kalıyor; QR kaydı Evvel Yeni'ye çift yazım, Yoklama zaten okuyor | |
| F41 | İş başvurusu | 7 | T | Gerçek başvurular geliyor; olduğu gibi küçük modül | |
| F44 | WhatsApp bildirimleri | 🤖 | D | Kapanış hatırlatma KALSIN (Zafer dersi); gece özet mesajı çıkar | |
| F56 | Kullanıcılar & giriş | 0 | T | Yetkilendirme adımında (rol + şube kapsamı) | |

## C. KULLANILMIYOR ya da yalnız gece motoru yazıyor → ÇIKAR

| Kod | Aile | 30 gün | Not | Öneri | Sahip |
|---|---|---|---|---|---|
| F10 | Ekstre PDF okuma | 1 | Kartlar'da bankadaki rakam elle teyit | Ç | |
| F11 | Borç navigasyonu / projeksiyon | – (salt okur) | ileride Kasa'ya basit "önümüzdeki 30 gün" | Ç | |
| F13 | Şube içi borç & çekmece sayımı | 0 | | Ç | |
| F21 | Sipariş kontrol kulesi | 100 🤖 | | Ç | |
| F24 | Stok sayım görevi, demirbaş, arıza | 1 | sayım Depo + Bar'da | Ç | |
| F31 | Belge talep & fatura istek | 4 | | Ç | |
| F32 | Tedarik mutabakatı, bağsız giriş | 8 🤖 | | Ç | |
| F33 | Stok tahmin & kayıp | – | | Ç | |
| F40 | Personel davranış / risk skoru | 93 🤖 | geç kalma Yoklama'da | Ç | |
| F43 | Operasyon Merkezi (40+ sekme) | 0 | Evvel Yeni modülleri | Ç | |
| F48 | Akıllı Denetim (Truth motor) | 1.627 🤖 | 15.300 satır | Ç | |
| F49 | Duyu omurgası & duyular | 2.363 🤖 | | Ç | |
| F50 | Evvel Beyni (sohbet + gece anlatısı) | 117 🤖 | | Ç | |
| F51 | CFO Panel, Kadife v2, Strateji | – | | Ç | |
| F53 | Denetim izi / mutabakat merkezi | (audit) | Evvel Yeni her kayıtta kim/ne zaman tutuyor | Ç | |
| F54 | Ekran ölçümü & arama | 126 🤖 | | Ç | |
| F55 | Cep (/cep) | – | Evvel Yeni telefonda açılıyor | Ç | |
| F57 | Excel import / sistem sıfırla | 0 | ⚠️ "sistem sıfırla" tehlikeli | Ç | |
| F45 | Evo / Evobulut (POS) | 50 🤖 | Sahip 2026-10-17: "Evo artık kullanılmıyor" — gece senkronu da sökülür | Ç | ✅ Ç |

## D. SAHİBE SORULACAK (karar sizde)

| Kod | Aile | 30 gün | Soru | Sahip |
|---|---|---|---|---|
| F14 | Kiralık mülk defteri (kiracı, sözleşme, tahsilat) | 0 (Eyl) | TULİPİ'den ayrı defter — Evvel Yeni'ye ayrı "Mülk" modülü mü, şimdilik eskide mi kalsın? | |
| F18 | Vergi & KDV | 0 | Şimdi mi, sonra mı? | |
| F26 | Reçete (+değirmen sayacı) | 53 | Ürün maliyeti için gerekli — taşınsın mı? | |
| F38 | Personel puan defteri | 107 | Kullanıyor musunuz? | |
| F46 | TV menü | 0 (Ağu) | Ayrı ürün — Evvel Yeni dışında kalsın mı? | |
| F47 | Ev / dükkân tasarımı | 0 (Haz) | Çıkar mı? | |

## E. KALIR

| Kod | Aile | Not |
|---|---|---|
| F42 | Şube paneli | Her gün kullanılıyor; arka ucu zamanla yalnız Evvel Yeni'ye yazacak |
| F58 | Veritabanı & ortak yardımcılar | Ortak |
| F59 | Gece zinciri | Her ÇIKAR kararında o ailenin adımı zincirden de sökülür |

---
## ✅ SAHİP KARARLARI (sırayla)

| # | Karar | Not |
|---|---|---|
| 1 | Eski kasa defteri ÇIKAR | Panel yalnız EY'ye yazınca köprü kesilir. a) kişi bazlı kasa açığı: YOK. b) Kasa'ya "7 gün içinde kesin çıkışlar" kutusu: KURULACAK (kesin çıkış = kart son ödeme + kira + maaş; ciro tahmini yok; POS yolda ayrı satır) |
| 45 | Evo ÇIKAR | Evo kullanılmıyor |
| 2 | Eski ciro taslak / onay / fark defteri ÇIKAR | Ciro yalnız panel kapanışından (bugünkü EY hâli); onay yok; eksik gün Bekleyen işler. Panel ciroyu doğrudan EY'ye yazmaya geçer (panel taşımasının ilk adımı) |
| 3 | Eski teslim / alıcı / banka yatırımı ekranları ÇIKAR | Teslim panelden yalnız EY Kasa'ya. 3-b: teslim GİRİLDİĞİ GÜN alınmış sayılır ("aldım" yok); almadı/eksik → 7 gün içinde Düzelt |
