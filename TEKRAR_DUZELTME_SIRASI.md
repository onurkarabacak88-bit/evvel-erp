# EVVEL YENİ · TEKRAR (MÜKERRER) DENETİMİ — DÜZELTME SIRASI (20 Eki)
Kaynak: tmp/TEKRAR_FABLE_1.md (69) + tmp/TEKRAR_CODEX_1.md (87) · 2. tur çapraz: Fable→Codex raporu (83 doğru, 4 kısmen, 0 yanlış, +11 kaçırılan) · bağımsız Fable→Fable raporu (63 doğru, 6 kısmen, 0 yanlış, +14 kaçırılan). Codex 17:06'da Fable raporunu ayrıca doğrulayacak.
Kural: her dalga = kod → Fable + Codex → deneme → yayın. Bulgu numaraları: F# = Fable raporu, C-Tx-## = Codex raporu, K# = kaçırılan.

## DALGA 1 — ŞİMDİDEN YANLIŞ SONUÇ (para / maaş) 🔴
1. C-T1-01 · Ödeme'den ücret tanımı saatlik ücret + yolu SIFIRLIYOR → yarı zamanlı maaş 0 · tek sahip Tanımlar `ucret_yaz`; Ödeme'nin ikinci DDL'i ve `_ucret` okuyucusu kalkar
2. C-T1-02 + C-T1-09 · Kart teyidi son 40 hareketten (sahte banka farkı) + kart kalanı özet/takvimde iki kural · tek sahip Kart `kullanilabilir_hesapla(tarih)` + `ekstre_durumu`
3. C-T1-29 · İptal edilen ekstre satırı "yeni" görünüyor ama yeniden yazılamıyor (sessiz)
4. C-T1-34 · "Fethi" teslimi bir yoldan hesap:fethi, diğerinden ev:fethi cebine · tek patron/teslim hedefi listesi (Tanımlar)
5. C-T1-08 · Kira eski+yeni ödemeyi TOPLUYOR (çift sayım), Kart/Kredi max alıyor · tek geçiş kuralı (kimlikle)
6. C-T1-16 · Eksik kapanış günü 3 yerde → aynı gün için iki Bekleyen iş · tek sahip Gelir `eksik_kapanislar`
7. F#54 · Panelde 409 "zaten" yanıtı bazı ekranlarda başarı sayılıp formu siliyor → farklı içerikli yeniden gönderimde SESSİZ kalem kaybı · tek `panelGonder()`
8. C-T1-11 · "Gecikti / kısmi" kuralı Mülk'te farklı

## DALGA 2 — 1 KASIM KESİM ENGELLERİ 🟠 (eski tablo kalkınca kırılan / iki takvim)
9. F#38 · Toptancı `urun_fiyat_gir` eski siparis_urun'u kapısız okuyor → Ürün fiyatı girişi 500
10. C-T3-04 · Kasa: eski sayım tablosu düşünce YENİ açılış sayımı da okunmuyor (erken dönüş)
11. C-T3-13 · Maaş eski `vardiya_takip`'i yeni aylarda da çağırıyor
12. C-T3-17 · Avans tamamen eski tablolarda (yeni tablo yok)
13. C-T3-19 + C-T3-21 · Satış fire + devir defteri eski tablolarda (= 1 Kasım listesi madde 4)
14. F#1 + F#23 + K1 + C-T1-17 + kaçırılan "dört başlangıç" · "1 Kasım geldi mi" 12 yerde, iş günü/takvim günü karışık (00–02 boş evren), aynı ad `_bugun` iki anlam, dört ayrı başlangıç tarihi · tek: çekirdek `deneme_mi(gun)` + `yeni_donem` iş gününe + tek başlangıç ayarı
15. C-T1-03/04/05 + C-T3-02 · Eski panelin kapanış/teslim kancaları Kasa'ya korumasız yazıyor (1 Kasım'a kadar canlı risk; sonra SİLİNİR)
16. F#13 · tanim_hazirla çağıranın işlemine savepoint'siz `SET LOCAL lock_timeout` sızdırıyor + kolon varken ALTER kilidi; kodda iki zıt DDL doktrini (C-T1-30 aynı)

## DALGA 3 — TEK SAHİP (başka modülün tablosuna uzanma) 🟡
17. F#18 + C-T1-13 · Fiyat: Toptancı tahmini, Ürün fiyatları ekranı ve Gider üç ayrı kural → tek `fiyat_bilgi(urun, gun, toptanci)`
18. F#31 + C-T2-05/06/07 · Yoklama/Kira/Toptancı/Kart, Tanımlar'ın tablolarına KOLON ekliyor/yazıyor → Tanımlar PUBLIC + modül yan tabloları
19. F#25 + C-T2-13 · Panel olay tablosuna ham SQL (5 yer, 2 UPDATE) → olay PUBLIC
20. F#35 + C-T2-03 + K(Codex)#7 · Tanımlar, Kasa'nın cep tablosuna yazıyor; pasif şube cebi kapanmıyor
21. C-T2-01/02/08/12 · Ödeme Kasa'nın özel fonksiyonlarını ve tablosunu kullanıyor
22. F#26, F#27, F#28 kalan, F#33, F#34, F#36, C-T2-04/09/10/11 · diğer modüller arası doğrudan okumalar
23. K(Codex)#1 · Kasa kayıtlarını 6 modül kendi süzgeciyle tarıyor → Ödeme `konu_odemeleri` tek kapı

## DALGA 4 — ÇEKİRDEK ORTAK YARDIMCILAR (aynı küçük iş çok yerde) ⚪
24. Kuruş/TL çevirimi (F#5, C-T1-18/19/20/21) — yuvarla vs reddet ayrışmış
25. Tarih/saat biçimleme (F#4, C-T1-23, K10)
26. Merkez oturum kapısı (F#2), modül açık mı (F#3), tablo var mı (F#14), _Kuru (F#21)
27. İstek tekrarı kalıpları (F#15, K2 yoklama 7 kopya), adet ayrıştırma (F#17), kalem doğrulama (F#22)
28. Ad normalizasyonu (F#6), bardak/pasta/sayılan ürün kuralları (F#7/8/9), müdür kuralı (F#10), gün kapalı (F#11/12)
29. Bar hesap döngüsü iki kopya (K3), personel_kilidi iki kez (F#20), açılış/kapanış sayım zorunluluğu (F#19)

## DALGA 5 — ÖN YÜZ ORTAK PARÇALAR ⚪
30. Panel: Kişi+PIN (F#48), kategori kartları + ürün satırı + koli yardımcısı (F#49–52), taslak (F#53), QR onay akışı (F#55), diğerleri (F#56–66, K11–12)
31. Merkez: tutar ayrıştırıcı (C-T4-01 — Kredi/Mülk'te "1.250,50" → 0 sessiz! → Dalga 1'e alınabilir), UTC tarih (C-T4-02 Mülk/Kredi), modal/alan/takvim/tema kopyaları (C-T4-03…16, F#67–69)
