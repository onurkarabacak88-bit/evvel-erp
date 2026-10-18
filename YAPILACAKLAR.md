# 📋 YAPILACAK İŞLER — Evvel Yeni (canlı liste)

> Sahip (2026-10-18): "Bütün işlemler bitince yarım kalan işleri tamamen baştan sona listele, eksiksiz." Bu dosya o listenin kaynağıdır;
> her iş bitince ✅ ile işaretlenir, silinmez. Ayrıntılı tasarımlar: SUBE_PANELI_TASARIM.md · YOKLAMA_QR_TASARIM.md · SIPARIS_TASARIM.md ·
> ESKI_OZELLIK_ENVANTERI.md · KESIM_LISTESI.md.

## 🔴 1 Kasım'dan ÖNCE bitmesi gerekenler (geçiş şartı)

| # | İş | Durum |
|---|---|---|
| 1 | **Yeni Şube Paneli** faz 1: açılış · kapanış · kasa devri · ara teslim · ürün aç · fire (deneme modunda yayında) | 🟡 yayında (deneme) |
| 2 | Panel sahip kararları D2/D6/D7/D9/D10 + "kapanış kaybolmasın" (deneme kaydı + geç kapanış) | 🟡 yazıldı, Codex denetiminde |
| 3 | **QR telefon / yoklama modülü** — Y0 şube koordinatı (eski içerik bir kez) + telefon bağlama linki + giriş/çıkış + dönen QR + panel QR kapısı + "Bugün girenler" | ⏳ |
| 4 | Y1 yemek molası (telefon) + merkez **Personel › Yemek molaları** sekmesi + ≤60 dk hak kazanılır · **61. dk'dan itibaren** merkez "uzun" bildirimi + telefonda "hak kazanılamadı" + **maaşta o günün yemek hakkı düşer** · merkez gerekirse elle hak verir (izli) | ⏳ |
| 5 | Y2 **kasa devri çift onay** (devreden + devralan kendi telefonunda), devir = devredenin çıkışı, "tutmuyor" → merkez | ⏳ |
| 6 | Konum muafiyeti (yönetici işareti) — eski içerik bir kez | ⏳ |
| 7 | **Eski telefon sayfası YENİDEN KURULACAK** (avans talebi buradan; görev listesi / stok sayım görevi / puan bu kurguda karar) | ⏳ |
| 8 | Panel faz 2: **Teslim al** (toptancı teslimi + depo girişi tek işlem, koli yardımcısı) · **Depodan gelen** (sevk kabul) · **Anlık gider** (fiş var/yok) · **Not / Mesaj** | ⏳ |
| 9 | Merkez **"Sevk et"** (Depo sevk, yeni ürün kimliğiyle) — 1 Kasım'dan önce sevk YALNIZ yeni yoldan (Codex C1, sahip onayı) | ⏳ |
| 10 | **Toptancılar › Ürün fiyatları** ekranı yeni katalogdan (yeni ürünlerin fiyatı ekrandan görülsün / girilsin) | ⏳ |
| 11 | Toptancı **açılış borcu** dönemle (1 Kasım öncesi teslim/ödeme sayılmaz — Codex C2) + 1 Kasım net bakiyeler (sahip verecek) | ⏳ |
| 12 | Merkez okuyucuları yeni panel verisine geçer: Depo (senkron köprüsü kalkar), Bar, Satış / Devir defteri, Gider, Kasa köprüleri (faz 3) | ⏳ |
| 13 | 31 Ekim akşamı eski sistemde açık sevklerin kapatılması (kesim şartı) | ⏳ |
| 14 | **1 Kasım**: `/donem` + her şubede para + ürün açılış sayımı; panel deneme modundan çıkar; eski panel kapanır | ⏳ |
| 15 | Personel telefonlarının bağlanması (25–31 Ekim, herkes) | ⏳ |

## 🟠 Panel / ürün — sonraki faz

| # | İş |
|---|---|
| 16 | Panel: X rapor okuma (OCR) · fire / fatura fotoğrafı · personel puanı · operasyon geri bildirimi · ekranın kendiliğinden yenilenmesi |
| 17 | Panel: "geri al" (personel aynı gün, yalnız son kayıt — Codex C3 sayım çıpası) |
| 18 | Panel merkez sinyalleri: fiyatı eksik ürün açıldı · stok eksiye düştü · saat dışı / geç kapanış (Bekleyen işler) |
| 19 | Fiyat geçmişi teslim kaynaklı (Codex C5) — `ey_toptanci_fiyat` ezilmesin |
| 20 | Ürün kataloğu: hareket görmüş ürünün sayım birimi kilidi (Depo kataloğa bağlanınca) |
| 21 | Sipariş modülü (SIPARIS_TASARIM.md): sipariş / kalem / yönlendirme / sevk partisi · hasarlı kabul · toptancı teslimi tek işlem |

## 🟡 Envanter / eski sistem kesimi

| # | İş |
|---|---|
| 22 | ESKI_OZELLIK_ENVANTERI.md — 21. maddeden itibaren kararlar (sahip) ve verilen kararların uygulanması (KESIM_LISTESI) |
| 23 | Eski sistem sökümü (sube_panel, sube_operasyon, fire_bildirim, operasyon_defter, stok_yolda, siparis_urun …) — 1 Kasım sonrası |
| 24 | Giriş kapısı + kullanıcı tanımında yetki (rol × alt sekme × şube) — EN SON |

## 🟢 Veri (sahip)

| # | İş |
|---|---|
| 25 | 1 Kasım net kasa / banka bakiyeleri · toptancı açılış bakiyeleri |
| 26 | Kira hesabı: evlerin tanımı |
