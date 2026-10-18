# 🧾 ŞUBE PANELİ — YENİDEN KURULUM ŞABLONU (eski panel ESAS)

> Sahip (2026-10-19): "Paneli baştan sona kuralım gerekirse" · "Her değişikliği denemede kontrol ederek gidelim, her basamakta Codex ve Fable ile konuşalım" ·
> "Bir kere telefon ve QR'ın sürekli değişmesi mantığı çok hoşuma gitti".
> Kaynak: eski panel `sube_panel.html` (15.102 satır) ekran ekran envanteri (2026-10-19). Hazırlayan: Claude · Denetim: Codex + Fable.
> **Kural:** Eski paneldeki her ekran / adım / alan / kural AYNEN kurulur. Değişiklik YALNIZ (S) sahip kararı olan yerlerde.
> (Ö) = Claude önerisi → **sahip onayı olmadan uygulanmaz**. Görünüş: eski panelin koyu lacivert teması, 3 kolon (sol 220 · orta · sağ 280), alt bar, 108/72 px dokunmatik düğmeler, global sayı tuş takımı. Kayıtlar Evvel Yeni defterlerine (kasa · depo · olay · yoklama) — eski tablolara köprü yok.

## 0. Sabit parçalar (sahip kararları)
| # | Karar | Kaynak |
|---|---|---|
| S1 | Telefon bir kez bağlanır + dakikada bir dönen QR (yalnız kayıtlı panel PC'si) + konum — giriş/çıkış/mola/devir/onay bu mekanizmayla | sahip 18–19 Eki |
| S2 | **Açılış 5. adım = QR ile onay** (PIN yerine); **Kapanış 5. adım = QR ile mühür** (eskisi gibi) | R1 |
| S3 | **Sık işlemler** (ürün aç, fire, ara teslim, anlık gider, teslim al, depodan gelen, sipariş, merkez notu, mesaj okudum): ekranda yalnız **QR ile giriş yapmış** personelin adları → seç + **PIN** | R1b |
| S4 | Kasa kilidi (PIN) ve "Adını seç" listesi kalkar — kapı QR girişi | R1 |
| S5 | Pasta yalnız toplam adet · bar sayımı katalogdaki "panelde sayılır" ürünler · değirmen 4 sayaç kalır | panel kararları |
| S6 | Deneme modu 1 Kasım'a kadar (kayıt kuru) · taslak + internet kuyruğu · gün kapandı kilidi · 07:00 açılış (kişisel erken açılış izni) · 22:30 kapanış | D2–D10 |
| S7 | Kapanış hatırlatma mesajı (WhatsApp) gitmez | D10 |
| S8 | Kasa devri: panel başlatır → devreden ve devralan kendi telefonundan onaylar ("Tutmuyor" + not → merkez) | D5, B6 |

## 1. Kapı sırası (açılış öncesi)
| Eski | Yeni | Kaynak |
|---|---|---|
| (a) QR yoklama "Personel girişi gerekli" → (b) Kasa kilidi personel + PIN → (c) Açılış sihirbazı → (d) zorunlu operasyon | (a) aynı ekran, yeni QR (S1) → (b) **yok** (S4) → (c) açılış sihirbazı → (d) aşağıda §1d | S1, S4 |
| **Açılış sihirbazı 5 adım** (tam ekran, kapatılamaz, ilerleme noktaları, kayma animasyonu, canlı saat): 1 💰 Kasa sayımı (kör) · 2 🥤 Bardak (küçük/büyük/plastik) · 3 📦 Ürün (su/süt/redbull/soda/cookie) · 4 🍰 Pasta toplam · 5 🔐 Personel + PIN "Onayla ve Şubeyi Aç" | Aynı 4 adım AYNEN (bar listesi katalogdan S5) · **5 📱 QR ile onay**: ekranda QR, personel okutur, telefonda özet → ONAYLA → "✅ Şube açıldı" | S2, S5 |
| 07:00 bandı + kişiye göre uyarı ("erken açılış izni yok — merkezden verilir") | aynı (izin Tanımlar › Personel'de) | S6 |
| **1d Zorunlu operasyon overlay** (KONTROL kasa sayımı, ÇIKIŞ sayımı; ekranı kilitler, 8 sn bip, alarm artırma) | **(Ö)** merkez "Kasa denetimi başlat" dediğinde aynı kilitli ekran: kasa sayımı + ad seç + PIN (S3). Bip personele uyarı sayılır mı? → **sahibe sor** | sor |

## 2. Ana çerçeve
| Eski | Yeni | Kaynak |
|---|---|---|
| Üst bar (logo · şube · saat) · 3 kolon · alt bar (Ana · Gider · Not · Mesaj + okunmamış rozeti) · mobil tek kolon | aynı | eski |
| Global sayı tuş takımı (sağdan kayar, Enter/Esc/Tab, 8 tam + 2 ondalık) | aynı | eski (B10) |
| İşlem sonucu kartı 10 sn · uyarı toast + 3 tonlu bip + masaüstü bildirimi (öncelik: zorunlu > sevkiyat > mesaj > depo > stok) | işlem sonucu kartı aynı · **toast/bip → sahibe sor** (kural: "personele uyarı gitmez") | sor |
| Ürün Aç hatırlatma bandı (12/13/16/20, 4 saat susturma) | **sahibe sor** | sor |
| Gönderilecek kayan şerit (depo rolü) | aynı (sipariş akışıyla, §9) | eski |
| Stok sayımı sürerken Ürün Aç dondurma | aynı (EY Depo sayım kilidi) | eski |
| Şube bulunamazsa sessizce Zafer | **düzelt:** adres şubesiz açılırsa şube seçtir | hata |

## 3. Sol menü (aynı sıra)
🏠 Ana · **STOK İŞLEMLERİ**: 📦 Tedarikçiden gelen · 🚚 Depodan gelen (yolda rozeti) · 🛒 Sipariş ver (rozet) · 📊 Sipariş takip (rozet) · 🔓 Ürün aç · 🔥 Fire · 📤 Gönderilecek (depo) · Eksik ürünler (açılır) · **GÜN SONU**: 💵 Kasa devri kartı (durum çipi) · 🌙 Günü kapat kartı (5 adım / zamanı geldi / gecikti / mühürlendi) · 💵 Ara teslim · **HIZLI ERİŞİM**: 📷 X raporu · 🧠 Operasyon geri bildirimi · ⭐ Puanım. Rozetler aynı. **Eksik ürünler listesi → sahibe sor** (stok uyarısı personele).

## 4. Ana sayfa
| Eski blok | Yeni | Kaynak |
|---|---|---|
| ⓪ Vardiyaya giriş kartı: küçük QR (büyür) + bugün girenler (☀️ sabahçı / 🌤 aracı / 🌙 kapanış, giriş–çıkış saatleri) | aynı, yeni QR + yoklama (vardiya türü planla gelir — B7a) | S1 |
| ① Gün çizgisi AÇILIŞ · KONTROL · KAPANIŞ (noktalar, yapan kişi, saat) | aynı | eski |
| ② 5 hızlı kart: 🔥 Fire · 🔓 Ürün aç · 💸 Anlık gider · 📝 Merkez notu · 🍽️ Yemek molası QR | aynı (mola yeni QR ile) | eski |
| ②.5 Kullanımda + "Bitti ✓" (🪣 bitince düşen ürünler) | **kalkar** — sahip kararı: ürün "açılınca" gider (D23) · **teyit sor** | S/teyit |
| ③ Durum çipleri (bekleyen sipariş · stok uyarısı · merkez mesajı) · ④ sipariş red listesi · ⑤ merkez mesajları kutusu (kritik kayan şerit, arşiv) · ⑥ son teslim/kabul (+ "Hatalı? Geri al" çift imza) | aynı · stok uyarısı/red listesi **sahibe sor** · geri al: ad+PIN + işletme onayı (sabit "Merve Karabacak" yerine **(Ö)** Tanımlar'dan "işletme onaycısı") | eski/sor/Ö |
| Dünkü kapanış eksik kartı (günde 1, "kör say") · kritik merkez mesajı penceresi (ad+PIN "Okudum") | aynı (S3) | eski |

## 5. Tedarikçiden gelen — Teslim al
Eski AYNEN: hero · "📄 Fatura fotoğrafını çek" (telefona QR) · bekleyen toptancı siparişleri kartları ("Teslim al") · kategori kartları → ürün modalı (− adet +) · sağ sabit panel: tedarikçi (zorunlu) · özet · **🧾 FATURA GELDİ Mİ? (zorunlu; EVET → tutar zorunlu + no)** · not · ad + PIN (S3) · "📦 Teslim al ve kaydet" · sipariş modu (beklenen dolu, fark notu, eksik → merkez kuyruğu) · teslimden sonra "Faturayı yükleyelim mi?". **Ek (S):** koli yardımcısı ("2 koli × 12 + 3"). Kayıt: toptancı teslimi + Depo girişi tek işlem.

## 6. Depodan gelen — Teslim al
Eski AYNEN: paket kartları · kalem kalem **kör sayım** (beklenen gösterilmez, kutular boş, basılı tutunca hızlanan ±) · ilerleme çubuğu · ad + PIN (S3) · "✓ Paketi kabul et" · eksikte "sipariş kapanmadı, merkeze döndü". Gün kapalıyken de açık. Kayıt: Depo `kabul` (hasarlı → askıda).

## 7. Sipariş ver · 8. Sipariş takip · 9. Gönderilecek (depo)
Eski AYNEN (SIPARIS_TASARIM ile): yolda bandı · merkez tek seferlik · onay bekleyen · kategori → modal · not · sabit onay bandı → ad + PIN (S3) → özet → gönder · çift sipariş uyarısı (409 → "yine de") · katalog dışı özel talep · **Takip:** son 21 gün, filtreler, 4 adımlı çizgi Talep → Tahsis → Sevk → Kabul · **Gönderilecek:** 3 adımlı tam ekran sihirbaz (Hazırlık listesi → VAR/KISMİ/YOK kalem girişi → Özet + "🚚 Yola çıkar" / "Hazırlığı kaydet"), bayat pencere kilidi. Kayıt: EY sipariş tabloları + Depo `sevk` (hayalet sevk yasak). = Sipariş kontrol kulesinin işlevi (D21).

## 10. Ürün aç
Eski: kategori kartları → modal (− adet +) · özet · not · sabit onay bandı → ad + PIN (S3) → özet → kaydet · sunucu taslağı (800 ms) + "taslağı temizle" · 45 sn çift gönderim koruması · başarıda bip + flaş · stok sayımında dondurma. **Kalkan:** Kullanımda / Bitti (§4 ②.5). **Düzelt:** taslak mesajındaki ham HTML hatası.

## 11. Fire
Eski 3 adımlı sihirbaz AYNEN: sebep kartları (9) → sebebe göre hazır ürün karoları / katalog araması → onay (özet, adet, ad + PIN (S3), "Diğer" açıklama ≥10). İade dalı 4 adım (iade sebebi 6 kart, müşteri telefonu maskeli, fiş no + iade zamanı zorunlu). Yanlış ürün dalı (senaryo + fire ürünü). Fotoğraf 2. faz.

## 12. Kasa devri
Eski 5 adım: 1 kasa · 2 bardak · 3 ürün · 4 pasta · 5 "sayımı doğruladım" + devreden / devralan → telefon onayları (S8; yeni QR). **Düzelt:** pasta 0 gidiyordu; süt alanı yoktu (bar listesi katalogdan S5).

## 13. Günü kapat — kapanış
Eski 5 adım AYNEN: 1 X raporu ciro (nakit/POS/online) + **kör** çekmece toplamı → teslim → bırakılan + kime teslim · 2 bardak · 3 ürün + **"ürün aç kaydı yok" kontrolü (sahibe sor)** · 4 değirmen 4 sayaç + pasta · 5 ☑ X raporu gönderildi + **📱 QR ile mühürle** (S2; okutan = kapanışçı, telefon onayı) · açık mesaisi kalanlar listesi + "mesaisini kapat (yönetici)" · "mühürsüz gönder" kaçış yolu (**sahibe sor**: yeni sistemde mühür = telefon onayı) · online = nakit+POS koruması · taslak 18 saat · uyarılı kayıtta sarı "EKSİK VAR" / hatada kırmızı tam ekran kart (**"EKSİK VAR" sahibe sor**). Kayıt: Kasa kapanış + teslim + Depo günlük sayım + olay.

## 14. Ara teslim · 15. Anlık gider · 16. Merkez notu · 17. Mesajlar
Eski AYNEN, onay ad + PIN (S3). Ara teslim: tutar kartı · teslim alan · açıklama. Anlık gider: kategori · tutar · açıklama ≥3 · **(S) fişi var/yok** → Kasa ödeme + Fiş kontrol. Merkez notu ≥3. Mesaj: "Okudum, onaylıyorum".

## 18. Operasyon geri bildirimi · 19. Puanım · 20. X raporu · 21. Yemek molası QR
Geri bildirim (7/14/30 gün) aynen. Puanım: ad + PIN → puan (D38: telefon sayfasına da). X raporu fotoğraftan okuma: aynen, **(Ö)** okunan değerler kapanış 1. adımına aktarılsın (eskide işlevsizdi). Yemek molası: ana sayfa kartı → yeni QR (B5 canlı).

## Atılacak ölü kod / düzeltilecek hatalar
Ölü: mesai çıkış QR overlay, eski fire formu, ana sayfa sipariş hatırlat, depo stok listesi, kullanılmayan sağ sekme, eski depo accordion, X raporu "taslağa aktar" (işlevsiz), gizli ara teslim tablosu.
Hata: kasa devrinde pasta 0 · ürün aç taslak düğmesi ham HTML · süt doğrulaması tutarsız · pasta yeri tutarsız · şubesiz adreste sessizce Zafer · Puanım PIN'i kasa kilidi ucuyla doğruluyor.

## SAHİBE SORULACAKLAR (R3)
1. Toast + bip + masaüstü bildirimi (sevkiyat, mesaj, stok) kalsın mı? (kural "personele uyarı gitmez")
2. Ürün Aç hatırlatma bandı (12/13/16/20) kalsın mı?
3. Eksik ürünler listesi + stok uyarısı çipi + sipariş red listesi panelde kalsın mı?
4. Kullanımda / Bitti kalkıyor (ürün açılınca gider) — teyit?
5. Kapanışta "ürün aç kaydı yok" kontrolü ve "EKSİK VAR" sarı kartı kalsın mı?
6. "Mühürsüz gönder" kaçış yolu kalsın mı (telefonu olmayan kapanışçı için)?
7. Merkezden "kasa denetimi" (KONTROL) ekran kilidi + bip kalsın mı?

## Kurulum sırası (her basamak: Codex+Fable kurgu → kod → DENEMEDE ekranda dene → sahibe görüntü → yayın)
1. Çerçeve + kapı (QR giriş) + ana sayfa iskeleti · 2. Açılış sihirbazı (5. adım QR onay) · 3. Kapanış (5. adım QR mühür) · 4. Kasa devri · 5. Ürün aç · 6. Fire · 7. Ara teslim · 8. Tedarikçiden teslim al · 9. Depodan gelen · 10. Sipariş ver/takip/gönderilecek · 11. Anlık gider · 12. Merkez notu / mesajlar · 13. Geri bildirim / Puanım / X raporu.
