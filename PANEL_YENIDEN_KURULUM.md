# 🧾 ŞUBE PANELİ — YENİDEN KURULUM ŞABLONU (eski panel ESAS)

> ## ⭐ ANA KURAL (sahip 2026-10-19, ÜSTÜN): "Paneli AYNEN al, sadece geliştirdiğin QR sistemini uygula — yoksa çok karışacak."
> Eski panelin TÜM ekranları, adımları, alanları, yazıları, uyarıları, PIN'li onayları AYNEN. Tek değişiklik: eskiden QR olan yerler (kasa öncesi personel girişi, vardiya giriş kartı, yemek molası, kasa devri telefon onayları, kapanış QR mühür) → yeni QR sistemi (bir kez bağlı telefon + dakikada dönen QR + konum) ve açılış 5. adım QR onay (R1). Bu kuralla "sahibe sor" maddeleri ESKİ PANEL LEHİNE kapandı (bip/uyarılar, ürün aç bandı, eksik ürünler, EKSİK VAR kartı, mühürsüz gönder, dünkü kapanış kartı, kasa devri 5 adım — KALIR). **YALNIZ 3 İSTİSNA (sahip: "sadece 4, 9 ve 10 önerine göre kurgula"):** 4 Kullanımda/Bitti KALKAR (açılınca gider) · 9 kapanışta "mesaisini kapat" KALKAR (çıkışsız → merkez Bekleyen işler) · 10 merkez kasa denetimi (KONTROL) ekranı YOK. Kayıt arka planda Evvel Yeni defterlerine (sahibin göreceği fark değil).


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
Eski AYNEN: hero · "📄 Fatura fotoğrafını çek" (telefona QR) · bekleyen toptancı siparişleri kartları ("Teslim al") · kategori kartları → ürün modalı (− adet +) · sağ sabit panel: tedarikçi (zorunlu) · özet · **🧾 FATURA GELDİ Mİ? (zorunlu; EVET → tutar zorunlu + no · HAYIR → "kâğıtta (irsaliye/fiş) tutar yazıyorsa ₺ — yazmıyorsa BOŞ")** (Codex) · not · ad + PIN (S3) · "📦 Teslim al ve kaydet" · sipariş modu (beklenen dolu, fark notu, eksik → merkez kuyruğu) · teslimden sonra "Faturayı yükleyelim mi?". **Ek (S):** koli yardımcısı ("2 koli × 12 + 3"). Kayıt: toptancı teslimi + Depo girişi tek işlem.

## 6. Depodan gelen — Teslim al
Eski AYNEN: paket kartları · kalem kalem **kör sayım** (beklenen gösterilmez, kutular boş, basılı tutunca hızlanan ±) · ilerleme çubuğu · ad + PIN (S3) · "✓ Paketi kabul et" · eksikte "sipariş kapanmadı, merkeze döndü". Gün kapalıyken de açık. Kayıt: Depo `kabul` (hasarlı → askıda).

## 7. Sipariş ver · 8. Sipariş takip · 9. Gönderilecek (depo)
Eski AYNEN (SIPARIS_TASARIM ile): yolda bandı · merkez tek seferlik · onay bekleyen · kategori → modal · not · sabit onay bandı → ad + PIN (S3) → özet → gönder · çift sipariş uyarısı (409 → "yine de") · katalog dışı özel talep · **Takip:** son 21 gün, filtreler, 4 adımlı çizgi Talep → Tahsis → Sevk → Kabul · **Gönderilecek:** 3 adımlı tam ekran sihirbaz (Hazırlık listesi → VAR/KISMİ/YOK kalem girişi → Özet + "🚚 Yola çıkar" / "Hazırlığı kaydet"), bayat pencere kilidi. Kayıt: EY sipariş tabloları + Depo `sevk` (hayalet sevk yasak). = Sipariş kontrol kulesinin işlevi (D21).

## 10. Ürün aç
> **Sahip (2026-10-19): "Ürün aç'ta 3–4 ürün bırakmışsın — hayır, BÜTÜN MEKANİZMA olması lazım."** Yeni panelde Ürün Aç yalnız takip='açılınca' 6 ürünü gösteriyordu (128'in 6'sı). Eski gibi: **BÜTÜN aktif katalog** kategori kartlarıyla + "Pasifleri göster" + modal (− adet +) + özet + not + onay. Kurgu sorusu (Codex+Fable): sayımla takip edilen ürün (bardak, su…) açılırsa günlük sayım düşüşüyle ÇİFT gider olmaması — açılan her ürün nasıl gidere/depoya yazılır.
Eski: kategori kartları → modal (− adet +) · özet · not · sabit onay bandı → ad + PIN (S3) → özet → kaydet · sunucu taslağı (800 ms) + "taslağı temizle" · 45 sn çift gönderim koruması · başarıda bip + flaş · stok sayımında dondurma. **Kalkan:** Kullanımda / Bitti (§4 ②.5). **Düzelt:** taslak mesajındaki ham HTML hatası.

## 11. Fire
Eski 3 adımlı sihirbaz AYNEN: sebep kartları (9) → sebebe göre hazır ürün karoları / katalog araması → onay (özet, adet, ad + PIN (S3), "Diğer" açıklama ≥10). İade dalı 4 adım (iade sebebi 6 kart, müşteri telefonu maskeli, fiş no + iade zamanı zorunlu, **müşteri adı isteğe bağlı** (Codex)). Yanlış ürün dalı (senaryo + fire ürünü). Fotoğraf 2. faz.

## 12. Kasa devri
Eski 5 adım: 1 kasa · 2 bardak · 3 ürün · 4 pasta · 5 "sayımı doğruladım" + devreden / devralan → telefon onayları (S8; yeni QR). **Düzelt:** pasta 0 gidiyordu; süt alanı yoktu (bar listesi katalogdan S5).

## 13. Günü kapat — kapanış
Eski 5 adım AYNEN: 1 X raporu ciro (nakit/POS/online) + **kör** çekmece toplamı → teslim → bırakılan + kime teslim · 2 bardak · 3 ürün + **"ürün aç kaydı yok" kontrolü (sahibe sor)** · 4 değirmen 4 sayaç (isteğe bağlı; **değirmen kaydı başarısız olsa da kapanışı ENGELLEMEZ** — Codex) + pasta · 5 ☑ X raporu gönderildi + **📱 QR ile mühürle** (S2; okutan = kapanışçı, telefon onayı) · açık mesaisi kalanlar listesi + "mesaisini kapat (yönetici)" · "mühürsüz gönder" kaçış yolu (**sahibe sor**: yeni sistemde mühür = telefon onayı) · online = nakit+POS koruması · taslak 18 saat · uyarılı kayıtta sarı "EKSİK VAR" / hatada kırmızı tam ekran kart (**"EKSİK VAR" sahibe sor**). Kayıt: Kasa kapanış + teslim + Depo günlük sayım + olay.

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

## DENETİM 1 (2026-10-19) — Fable (tam) + Codex (kota doldu, 3 ayrıntı işlendi)
**Çelişkiler (eski panel ↔ sahibin önceki yeni panel kararları) → sahibe soruldu:** kasa devrinde ürün/pasta (eski 5 adım ↔ D2 "yalnız 3 bardak") · kapanışta açık mesai listesi + "mesaisini kapat" (↔ D3 yönetici kapatma yok) · geri al işletme onayı tablette PIN (↔ D5a kimlik telefonda) · KONTROL ekranı (↔ D1 "olmasın") · dünkü kapanış eksik kartı (↔ "personele uyarı yok") · kapanış teslim alıcısı (↔ A4-2 yalnız Onur/Fethi/Fatma).
**Kaynak yok / köprü riski:** sipariş tabloları + merkez Yönlendirme/Hazırlık EY'de yok (1 Kasım'a sığmayabilir) · X raporu OCR, Puanım, geri bildirim, merkez→şube mesaj yazarı EY'de yok · Depo'da şube kabul ucu yok (yalnız merkez kabul) · PIN doğrulama hiç yok.
**Atlananlar (eklenecek):** sipariş modunda eksik kategori + açıklama zorunlu · depodan gelen fazla/eksik/hasarlı/2 gün merkez kabul · ana sayfada son okutanlar + mola hak kuralı · ürün aç bandı pencereleri 12:00–12:59 / 16:00–16:59 / 20:00–20:59 · sağ panel sekmeleri kullanımda · deneme: panel kuru + yoklama gerçek (kapanış→çıkış kuru modda yazılmaz).
**Basamak 0 (ön koşul):** katalog panel_sayim tam · PIN göçü + 5 yanlış kilidi · telefon onay sayfası · şube PC kayıtları + telefon bağlama.
**Merkez basamakları:** "Sevk et" (C1 bloker) · merkez mesaj gönderme · 31 Ekim açık sevklerin kapatılması · /donem + açılış sayımı · eski uçların kesimi · 28–30 Ekim prova.
**Sıra önerisi (Fable):** Depodan gelen kasa devrinin hemen ardına; sipariş "eski akış" kararına bağlı; X raporu/Puanım/geri bildirim 1 Kasım sonrası.

## SAHİP KARARLARI — şablon soruları (2026-10-19)
| # | Karar |
|---|---|
| S9 (soru 11) | **Hatalı teslimi geri alma** yalnız merkezin YETKİ verdiği personel: Tanımlar › Personel'de "teslim geri alabilir" yetkisi. Yetkisi olmayan düğmeyi görmez / sunucu reddeder. (Sabit "Merve Karabacak" kalkar.) Sahip: "Hatalı teslime personel, yetkisi olmayan, merkez tarafından atanmamış müdahale edemesin." |
| S10 (soru 13) | **Kasa teslim alıcısı:** Onur · Fethi · Fatma + merkezin "teslim alabilir" yetkisi tanımladığı personel. Sahip: "13'te de bu üçü ve yetki tanımlanırsa personel." |
| S11 (sahip "önerin +", 2026-10-19) | 1 bip + uyarı kutucukları KALIR · 2 ürün aç hatırlatma bandı KALIR (12/16/20 pencereleri) · 3 eksik ürünler + stok uyarısı + red listesi KALIR · 4 Kullanımda/Bitti KALKAR (açılınca gider) · 5 kapanış "ürün aç kaydı yok" + "EKSİK VAR" kartı KALIR · 6 mühürsüz gönder KALIR + merkeze bildirim · 8 **kasa devri = eski 5 adım: kasa · bardak · ürün · pasta · onay** (sahip düzeltti: "Hayır, 5 sayılsın" — D2 "yalnız 3 bardak" kararının yerine; sunucudaki "devirde yalnız bardak" kuralı değişir; eski hata: pasta 0 gidiyordu → düzeltilir) · 9 "mesaisini kapat" KALKAR (çıkışsız → merkez Bekleyen işler) · 10 KONTROL ekranı YOK (D1) · 12 "dünkü kapanış yapılmadı" kartı KALIR · 14 1 Kasım öncesi Depodan gelen + merkez Sevk et; Sipariş ver/takip/gönderilecek Kasım 1. hafta · 15 X raporu / Puanım / geri bildirim 1 Kasım sonrası · 16 PIN eski sistemden bir kez kopya + 5 yanlış kilit · 17 telefonu olmayan → başka girişli personel kendi telefonuyla onaylar + merkeze bildirim |

## BASAMAK 3 — KAPANIŞ: Fable denetimi (2026-10-19; Codex kotası dolu — açılınca aynı istem)
Taslak: scratchpad kapanis_kurgu_taslak.md. Bulgular:
- **F1 🔴** Kapanış QR'ı (`?o=`) okutan herkes OnayIslem'e düşer: ÇIKIŞ düğmesi yok, yanlışlıkla ONAYLA'ya basan kapanışçı olur → OnayIslem'e "🚪 Sadece çıkış yap" + ONAYLA metninde "kapanışçı olarak {ad} kaydedilecek".
- **F2 🔴 fonksiyon kaybı:** online = nakit+POS ise RED (eski sube_operasyon:1267) yok · kör sayım ve bırakılan ZORUNLU değil · açık devir varken kapanış uyarısı yok · kasa farkı/uyarılı kapanış merkeze gitmiyor (olay `uyarilar[]` + Bekleyen işler "⚠ Uyarılı kapanış") · açılışsız kapanış uyarısı yok · ciro eskiden merkez onayına düşüyordu (ciro_taslak) — **sahibe soru**.
- **F3 🔴** Mühürsüz: PIN + içeride yetmez → ayrı uç `/kapanis-muhursuz`, `_onay_sart` muhursuz dalı (deneme kaydı), saat kuralı, kişinin aktif telefonu varsa kırmızı etiket, olay `muhursuz=true`, çıkış `kapanis_muhursuz`, Bekleyen işler "Mühürsüz kapanış — X".
- **S2** kapanışçı = okutan DOĞRU (eskide de "açık yoklaması olan herkes"); sorumlu≠kapatan → engel yok, olay + bilgi satırı.
- **S3** iki kişi: mühür ENGELLENMEZ (gece_kapat var, kilitlenme maliyeti yüksek); diğerinin /cikis'i yarışmaz; kapanıştan sonra QR görünür ve /cikis gün kilidine takılmaz ✓; olay verisine `iceride_kalanlar[]`.
- **Mola** kırık YOK; pürüz: mola-baslat'ta QR "bugün kullandın" kontrolünden önce harcanıyor → sıra değişir. Sahip gözlemi: giriş sonrası ekranda mola için "QR'ı tekrar okut" ipucu yok → eklenir.

### BASAMAK 3 — SAHİP KARARLARI (2026-10-19 akşam, Fable sonrası)
- **Ciro doğrudan Kasa'ya** (eski "merkez ciro onayı" YOK); uyarılı kapanış merkezde "⚠ Kapanış uyarılı — Gördüm".
- **Mühürsüz gönder YOK** (S11-6 kararının yerine): telefonu olmayan kapanışçı → içerideki BAŞKA personel kendi telefonuyla onaylar (kapanışçı o olur); kimse yoksa **"📨 Merkeze gönder"** (ad + PIN) → kayıt yazılmaz, ey_panel_deneme'ye girilen rakamlarla düşer → merkez Bekleyen işler'den tek tıkla **geç kapanış** (VAR OLAN yol, yeni kod yok).
- **Telefonda "🚪 Sadece çıkış yap"** düğmesi (kapanış onay ekranında); ONAYLA metni "kapanışçı olarak {ad} kaydedilecek".
- **KASA UYARISI PANELE VERİLMEZ** (sahip 19 Eki: kör sayım — personel tuttu mu bilmez): kör sağlama / kasa farkı yalnız merkez (olay `kasa_uyarilari` + Bekleyen işler "⚠ Kapanış uyarılı"); panel EKSİK VAR kartında yalnız kasa DIŞI uyarılar (açılış yok, devir bitmedi, ürün aç yok, X raporu, içeride kalan, sorumlu farkı).
- **Online koruması KALIR**: online>0 ∧ nakit>0 ∧ POS>0 ∧ online = nakit+POS → RED "Online satış yoksa 0 bırak".
- **Var mı kontrolü (sahibe gösterildi):** kör sayım sağlaması + kasa farkı = Satış `_kasa_mutabakat` (eski tablolardan) → yeni deftere çevrilip TEK servis, kapanış uyarısı ondan; uyarılı kapanış + Gördüm = Kasa `kapanis_uyarili` satırı yeniden kullanılır; onay, içeride kalanlar, sorumlu, devir durumu, cikis_yaz, olay tekrar koruması VAR.

### SAHİP KARARLARI — 2026-10-19 akşam
- **BİP SESİ YOK** (S11-1'in "bip" kısmı İPTAL). Uyarı kutucukları/bildirim yazısı kalır, ses çalınmaz.
- **ARA SAYIM (istisna 10'un yerine sade KONTROL):** günde BİR kez, açılıştan sonra RASTGELE saatte panel ara sayım ister.
  - Sayılan: **yalnız kasa, KÖR** (çekmecedeki nakit; beklenen ekranda gösterilmez) — sistem beklenenle karşılaştırır, fark kaydedilir.
  - Ekrana gelince **panel KİLİTLENİR, 15 dk süre**; yapılmazsa "yapılmadı" kaydedilir → merkez Bekleyen işler.
  - Onay: **telefonla QR** (açılış gibi; sayan kişi kendi telefonuyla okutur, kimlik telefondan).
  - Sistem kaydeder: istenme saati, yapılma saati, sayan, sayılan, beklenen, fark (olay defteri + Kasa'da kasa sayımı — "önce var mı" kontrolü: Kasa'nın mevcut `sayim` türü/fark motoru kullanılacak, yeni tablo açılmadan).
  - Eski örnek: sube_operasyon.py KONTROL (rastgele gecikme + cevap penceresi, kasa sayımı + PIN). Sıra: Kapanış'tan sonra.

## BASAMAK 0 — kurgu (Claude) → Codex + Fable
1. **PIN** (tanim modülü — personel tanımı): ey_personel `pin_salt`, `pin_hash`, `pin_yanlis`, `pin_kilit_bitis` · eski `personel.panel_pin_salt/hash` BİR KEZ kopya (aynı sha256(salt:pin) biçimi — personel yeniden PIN almaz) · Tanımlar › Personel'de "PIN (4 hane) — değiştirmek için yaz" · PUBLIC `pin_dogrula(cur, pid, pin)`: 5 yanlış → 15 dk kilit (eski panel_pin_limitleri) · PIN asla düz yazı saklanmaz/loglanmaz/deneme kaydına girmez.
2. **Yetkiler** (S9, S10): ey_personel `yetki_teslim_alma`, `yetki_geri_alma` (Tanımlar › Personel, evet/hayır). Teslim alıcı listesi = Onur/Fethi/Fatma + yetki_teslim_alma; geri al = yetki_geri_alma.
3. **Telefon onay sayfası**: QR `/q/{şube}/{jeton}?o={onay}` → telefonda "Açılış · Tema · kasa 1.250 ₺ …" + ONAYLA (sunucu R1 uçları hazır, yerel 5651928). Girişi yoksa önce GİRİŞ YAP, sonra ONAYLA. S17: onaylayan girişli herhangi bir personel olabilir (açılışı yapan değil, telefonu olan) → kayıt onaylayan adına + "onay başka personelden" izi.
4. **Panel PIN uçları**: sık işlemler gövdesine `pin`; `_personel` PIN'i doğrular (yoklama açıkken); onay yolu PIN istemez; deneme kaydına PIN yazılmaz (model_dump exclude).
5. **Katalog**: panelde sayılan ürünler = eski sabit liste (3 bardak + su, süt, redbull, soda, cookie) ile birebir mi — kontrol.
Sonra: denemede ekranda dene → sahibe görüntü → yayın.

> **Sahip (2026-10-19):** "Her şeyi detay detay al; Fable ile düzende ve kurguda azaltma, eksiltme yapma — ama daha sağlam yap, kırılım olmasın." Denetim yalnız SAĞLAMLIK içindir; ekran/adım/alan eksiltme önerisi uygulanmaz.

### Basamak 0 — Fable denetimi sonrası kesin kurgu
- **PIN kopyası:** `sha256(salt:pin)` aynen; eşleşme `personel.id::text = ey_personel.id`; tek seferlik `ayar(pin_kopya)`; yalnız `pin_hash IS NULL` satırlara; boş hash kopyalanmaz; eski deneme PIN'i taşınmaz.
- **Yanlış PIN sayacı:** ayrı `ey_pin_deneme` tablosu, AYRI bağlantıda atomik (+1 RETURNING) → işlem geri alınsa / deneme modu olsa da sayılır; 5 yanlış → 15 dk kilit; ey_personel satırına yazılmaz (Tanımlar izi kirlenmez).
- **PIN sızıntısı yok:** gövdede düz `pin: Optional[str]` (Pydantic kalıbı yok → 422'de pin görünmez); doğrulama `_personel(pin=…)` içinde 400; deneme kaydı `model_dump(exclude={"pin"})`; log yok.
- **PIN'li / QR'lı ayrımı:** PIN yalnız sık işlem gövdelerinde zorunlu; açılış/kapanış gövdesinde PIN alanı YOK, kimlik telefondan (onay yolu). "onayli" bayrağı gövdede taşınmaz (taklit edilemez). `_onay_ozet` ölü dalları silinir.
- **S17:** yalnız AÇILIŞTA başka girişli personel onaylayabilir (kayıt onaylayan adına, olay verisinde onay_id + cihaz_id). **Kapanışı kapanışçı kendi telefonuyla onaylar** (kapanış = onu çıkış yapar); telefonu yoksa "mühürsüz gönder" + merkeze bildirim.
- **Kasa devri 5 adım:** ürün + pasta sürüm özetine girer; Depo'ya yazmaz (ara ölçüm, yalnız olay); sürüm tek fonksiyondan.
- **Yetkiler:** `yetki_geri_alma` ey_personel'de (Tanımlar); eski `panel_yonetici` ile karışmaz. **`yetki_teslim_alma` — sahip kararı A (2026-10-19):** yetkili personel teslim alırsa para KENDİ cebinde görünür (Kasa'da kişiye bağlı cep "X'in elinde", tür ev benzeri, yetki verilince açılır); Onur/Fethi/Fatma'ya verince Kasa "Taşı" ile aktarılır; elde bekleyen para Kasa uyarılarında (gün sayısıyla) görünür. Kasa cebi kurgusu Kasa modülünde (PATRON_CEPLERI sabitine dokunmadan, tanımlı cepler gibi) — kasa devri/kapanış basamağında yazılır.

### Basamak 1 — kesin kurgu (Fable denetimi sonrası)
- **QR'lar:** eski QR KALKAR, aynı yere yeni QR (sahip: "birbirlerini ezecek değil, kaldır yerine yenisini ekle") — tek QR, tek yol.
- **Dünkü kapanış kartı: KALKTI** (sahip 2026-10-19: "Bunu panel söylemesine gerek yok, kaldır bence") — merkez Bekleyen işler'de "Kapanış YOK" zaten görünür. (4. istisna)
- **Kapı:** yalnız `!acilis_var` iken (gün ortasında herkes çıkınca kapanmaz). Panel PC'si kayıtsızsa kapı yerine tam ekran "Bu bilgisayar kayıtlı değil — merkezden bağlantı". Deneme düğmesi "Deneme: QR'sız geç" yalnız sunucu `kuru=true` iken; tercih saklanmaz (her yüklemede kapı yine görünür).
- **Yenileme:** eski gibi 15 sn; sekme gizliyken durur, öne gelince hemen; kapı/devir 5 sn; saat 10 sn; TabletQR 30 sn.
- **Ezmeme:** modal açıkken seçimler (kişi, devralan, alan) listeden düşse de korunur, sunucu karar verir; ANLADIM kartı açıkken yeni mesaj basılmaz; kişi seçimi yalnız "içeride" olanlar içinde geçerli (çıkış yapan sabah seçili kalmaz, localStorage'a yazılmaz).
- **Sayı tuş takımı:** React onChange yoluyla (native setter + input olayı) yazar; inputmode numeric/decimal alanlarda açılır; time/select hariç; 8 tam + 2 ondalık.
- **Dosya bölme:** ortak.jsx (tema, Modal, TabletQR, listeler, numpad, yardımcılar) · PanelBaglam (React context: d, gonder, ac, kapat, mesgul, yukle) · SubePaneli.jsx çerçeve · AnaSayfa.jsx · ekranlar ayrı; tek `<style>`; Kapanış taslağı davranışı taşınırken değişmez.
- **Durum çipleri:** kaynak yokken GİZLENMEZ, "—" gösterir (0 = yanlış bilgi, gizlemek = düzen kayar); red listesi ve mesaj kutusu yerinde, içi "Henüz … yok".
- **Kalanlar:** DENEME rozeti + "N kayıt internet bekliyor" kartı kalır (sağlamlık) · son okutanlar kalır · vardiya türü etiketi (☀️/🌤/🌙) vardiya planı (B7a) gelince · gün çizgisi boşken varsayılan saatler (07:00 / 22:30) · `/panel` şubesiz → şube seçtir · ürün aç hatırlatma bandının yeri açılır (içerik ürün aç basamağında).

### Basamak 1 — uygulama notu (2026-10-19)
- Çerçeve yazıldı: `ortak.jsx` (tema, Modal, TabletQR, listeler, sayı tuş takımı) · `AnaSayfa.jsx` (eski §4 sırası) · `SubePaneli.jsx` (üst bar, sol menü, sağ kartlar, alt bar, açılış öncesi QR kapısı, 15 sn yenileme).
- Üst bardaki "Adını seç" KALKTI. Sahip (2026-10-19): **kişi / PIN seçilen her yerde YALNIZ QR ile girmiş (şu an içeride) personelin adı** — tüm personel yedeği yok; tek kişi içerideyse kendiliğinden seçili.
- Codex B0 düzeltmeleri: `_onay_sart` — canlıda (1 Kasım sonrası) açılış/kapanış panelden doğrudan yazılamaz, YALNIZ telefon onayıyla. ⚠️ Bu yüzden Basamak 2 (açılış sihirbazı + QR onay) ve Basamak 3 (kapanış + QR mühür + mühürsüz gönder ucu) **1 Kasım'dan önce** bitmeli. Onay isteği yalnız doğrulanmış form alanlarını saklar (pin asla). PIN sayacı yarışı kapatıldı.

## BASAMAK 2 — Açılış sihirbazı (kurgu, Claude) → Codex + Fable
Eski: sube_panel.html `#acilisOverlay` (5660–5720), `buildAcilisWizFields` (9930–9998), `_awStepHdr` (9912), ileri/gönder (14363–14445), saat bandı `updateAcilisSaatUyariBanner` (6009).
- **Ne zaman:** `!acilis_var && !kapanis_var` iken içeride (QR girişli) biri olunca **kendiliğinden** açılır; tam ekran, **kapatılamaz** (eski gibi). Yalnız DENEME'de (kuru) "Deneme: kapat" bağlantısı (test için). Ana sayfadaki "☀️ Açılışı Yap" düğmesi de aynı sihirbazı açar.
- **Görünüş AYNEN:** marka başlığı (☕ Evvel ERP · Şube Açılış Protokolü · canlı saat) · 5 nokta ilerleme çizgisi (✓ / etkin / bekleyen) · adım başlığı (ikon + başlık + alt yazı) · kayma animasyonu (ileri/geri) · altta « Geri + İleri → (son adımda yeşil) · saat uyarı bandı · hata satırı.
- **Adımlar (eski metinlerle):** 1 💰 Kasa Sayımı — "🔒 KÖR SAYIM — önceki tutara bakma", "Kasadaki parayı bağımsız olarak say", Kasa Sayımı (₺) · 2 🥤 Bardak Stoku — katalogda "panelde sayılır" ve adı *bardak* olanlar (bugün: Plastik / 14oz / 8oz) · 3 📦 Ürün Stoku — panelde sayılan diğer ürünler (bugün: Süt, Redbull, Su, Maden suyu, Cookie) — liste katalogdan (S5), sabit değil · 4 🍰 Pasta Stoku — "Pasta (toplam adet)" tek kutu · 5 📱 **QR ile Onay** (eski "Personel & Onay" + PIN yerine, S2).
- **Zorunluluk AYNEN:** her alan dolu olmalı (0 yazılabilir; boş → "X adedini girin"); eksi / kesir yok; kasa ₺ 2 ondalık.
- **5. adım:** özet kartı (kasa, bardak, ürün, pasta) + büyük dönen QR (`?o=onay_id`) → personel kendi telefonuyla okutur → telefonda özet + ONAYLA (girişi yoksa önce GİRİŞ YAP, aynı QR). Panel 2 sn'de onay durumunu sorar: `onaylandi` → "✅ Şube açıldı" (eski başarı animasyonu ~1,9 sn) → panel yenilenir · `hata` (ör. saat kuralı 409) → mesaj gösterilir, QR yeniden istenebilir · `sure_doldu` (10 dk) / iptal → "Yeniden QR iste". « Geri basınca bekleyen onay **iptal** edilir (form durur, değişiklik sonrası yeni onay).
- **S17:** onaylayan, girişli HERHANGİ bir personel olabilir (telefonu olan) → kayıt onaylayanın adına (sunucu zaten telefondan alır).
- **Saat:** 07:00'dan önce bant: "Açılış saati 07:00 — erken açılış izni olan personel onaylayabilir (izin merkezden verilir)". Asıl karar sunucuda (kişiye göre); ret telefonda ve panelde görünür.
- **Taslak:** her tuşta tablete (iş gününe bağlı anahtar); sayfa yenilense de adım + değerler geri gelir; onay kimliği taslağa YAZILMAZ (yenilemede yeni QR istenir). Başarıda taslak silinir.
- **Kayıtsız PC:** 5. adımda QR çıkamaz → "Bu bilgisayar kayıtlı değil — merkezden bağlantı iste" (canlıda açılış yapılamaz — doğru davranış). DENEME'de ek düğme "Deneme: QR'sız kaydet" (doğrudan uç, kuru).
- **Sunucu değişmez** (AcilisBody + onay uçları hazır). Dosya: `src/pages/subepanel/AcilisSihirbazi.jsx` (tak-çıkar: yalnız props `d, subeId, tabletVar, kapatilabilir, kapat, bitti`); eski açılış modalı SubePaneli'nden SİLİNİR (tek yol).

## BASAMAK 4 — KASA DEVRİ yeni akış (sahip 2026-10-19, Tema denemesinden sonra) → Codex + Fable
Sahip: "Devri başlat dediğinde Mehmet QR okutup verileri TELEFONDA girmeli; devri onaylayıp gönderdiğinde PC ekranı bunu belleğine yazmalı ve karşı devri alana göstermeli, QR göstermeli; bu QR okutunca hem devri kabul yapmalı hem giriş yapmış olmalı."
Kurgu (Claude):
1. **Panel:** 💵 Kasa Devri → **Devri başlat** (form YOK, kişi seçimi YOK) → ekranda devir QR'ı (dönen QR + devir kimliği). Devir satırı açılır: durum `baslatildi`.
2. **Devreden (kendi telefonu):** QR okutur → kimlik telefondan, bu şubede İÇERİDE olmalı → telefonda eski 5 adım (S11): 💰 kasa sayımı (kör) · 🥤 bardak · 📦 ürün · 🍰 pasta · ✅ özet → **Devrediyorum** → durum `devreden_onayladi` (sürüm + istek kimliği; tekrar gönderim tek kayıt).
3. **Panel:** 2–5 sn'de bir sorar → devreden onaylayınca ekranda özet (devreden adı, saat, kasa, bardak, ürün, pasta) + "Devralan: QR'ı okut" + QR.
4. **Devralan (kendi telefonu):** QR okutur → özet → **Kabul ediyorum** ya da **Tutmuyor + not** → TEK işlemde: devir tamam + devralanın GİRİŞİ açılır (içeride değilse) + devredenin çıkışı "devir" ile yazılır + vardiya olayı (1 Kasım öncesi yazılmaz). Devralan = QR'ı okutan kişi (devredenden farklı olmalı); panelde önceden seçilmez.
5. **İptal:** devreden onaylamadan önce panelden "Devri iptal"; onaylandıktan sonra merkez kapatır (mevcut kural). Süre: başlatılan devir X dk içinde doldurulmazsa düşer.
6. **Tak-çıkar:** devir mantığı yoklama modülünde (PUBLIC devir_baslat / devir_durum); panel yalnız başlatır ve gösterir. Sunucu: telefon uçları `devir/{id}/doldur` (devreden) + mevcut `kabul`; QR resmi `?dv={devir_id}`.
Açık sorular (denetçilere): (a) devralan devredenin sayımını GÖRÜP mü onaylar, yoksa kendisi de KÖR sayıp sistem mi karşılaştırır (eski panel?) (b) devreden telefonda form doldururken panel ne gösterir (c) devir sırasında bir başkası QR'ı okutursa (d) devreden telefonu yoksa (S17 gibi başka girişli personel?) (e) offline / yarıda kalan durumlar, gün değişimi 02:00 (f) mevcut panel devir formu ve "devir hazır" akışı kalkar mı (tek yol).

### Basamak 4 — KESİN KURGU (Codex + Fable denetimi + sahip kararları 2026-10-19)
Eski panel karşılaştırması (Fable, sube_panel.html 13048–13231): eski 5 adım panelde · sabahçı ve akşamcı özeti GÖREREK onaylar · ikinci kör sayım yok · pasta 0 hatası vardı. Yeni: form TELEFONA taşınır (sahip), içerik AYNEN.
- **Sahip kararları:** QR bir kez okutulur + **15 dk devir penceresi** (göndermede konum yeniden) · devralan **görerek kabul**; "Tutmuyor" seçerse KENDİ saydığı kasa tutarı zorunlu → fark merkeze · devredenin telefonu yoksa **başka girişli personel kendi telefonuyla "X adına"** (iz + merkeze bildirim) · **ilk okutan içerideki kişi otomatik devreden** (soru yok; panelde adı görünür, panel iptal edebilir).
- **Akış:** Panel "Devri başlat" (form/kişi seçimi yok; kayıtlı PC imzası) → durum `baslatildi` + QR → ilk okutan içerideki kişi `dolduruluyor` (15 dk) → telefonda 5 adım: 💰 kasadaki nakit ("para kasada kalır, hesaplamalara girmez") · 🥤 bardaklar · 📦 ürünler (katalog, panelde sayılır) · 🍰 toplam pasta · ✅ özet + ☑ "Kasadaki nakit sayımını doğruladım" → **Devrediyorum** → `devreden_onayladi` → panel özeti + "Devralan: QR'ı okut" → devredenden farklı ilk okutan **Kabul ediyorum** / **Tutmuyor + saydığı tutar** → TEK işlem: devir tamam + devralan girişi (yoksa) + devreden çıkışı "devir" + kapanış sorumlusu + vardiya olayı (1 Kasım öncesi yazılmaz).
- **Süreler:** `baslatildi` 30 dk'da sessiz düşer · `dolduruluyor` 15 dk dolarsa telefon taslağı kalır, tekrar okutur · `devreden_onayladi` 2 saatte Bekleyen işler (mevcut).
- **Güvenlik:** kimlik telefondan; devir uçlarında konum mesafesi her zaman yazılır; şube koordinatsızsa devir 409; ürün katalog dışı / eksi / kesir → 400; devralan ≠ devreden sunucuda.
- **Tek yol:** panel devir formu, DevirBody, devralan_adaylari, "yoklama yoksa doğrudan vardiya olayı" dalı KALKAR.

## BASAMAK 5 — ÜRÜN AÇ (kurgu, Claude 2026-10-19) → Fable (Codex kotası 15:21'de açılınca)
Eski: sube_panel.html tab-ac (5363–5395), renderStokForms('ac') (11479–11560), acKatalogKartBlockHTML / acStokKatalogRowsHTML (10070–10120), wireStokBtn, stokPinModal.
- **Yer:** eski gibi orta alanda SEKME (modal değil). Sol menü / hızlı kart "Ürün Aç" → sekme.
- **Görünüş AYNEN:** hero "🔓 Ürün Aç — Aktif Kullanıma Al · Depodan bara/sahaya çıkan ürünleri sayın" · yapışkan onay çubuğu (seçim varken: "N kalem · M adet" + **Seçimleri Onayla**) · kategori kartları (renk tonları, seçili sayısı rozeti, "X aktif · Dokun → liste") · "Pasifleri göster" · kategoriye dokununca pencere: satır satır ad + − adet + · "Tamam" · seçim özeti · Not (isteğe bağlı).
- **Onay:** Seçimleri Onayla → pencere: **yalnız QR ile girmiş (içeride) personelin adı + 4 haneli PIN** (S3) → özet → Kaydet. Başarıda bip + yeşil flaş, form temizlenir.
- **Katalog:** BÜTÜN aktif ürünler (sahip: "bütün mekanizma"), pasifler "Pasifleri göster" ile.
- **ÇİFT GİDER kuralı (soru):** `takip='acilinca'` ürün → Depo 'ac' hareketi (depo:şube → dışarı:tüketim = gider). `takip='sayim'` ürün (bardak, su… günlük/dönem sayımıyla izlenen) → YALNIZ olay (iz) yazılır, Depo hareketi YAZILMAZ — tüketimi sayım farkı verir (aksi hâlde açınca defterden düşer, bar sayımında geri "fazla" çıkar → gürültü). Ürün açılınca Kullanımda/Bitti YOK (istisna 4).
- **Taslak:** her tuşta tablete (iş gününe bağlı); sayfa yenilense de seçimler kalır; "Taslağı temizle".
- **Çift gönderim:** istek kimliği (mevcut) + düğme kilidi.
- **Kalan:** "stok sayımı sürüyor — Ürün Aç kapalı" bandı (EY'de sayım kilidi kaynağı yok → kaynak gelince) · ürün aç hatırlatma bandı (Basamak 1'de var) · kapanışta "ürün aç kaydı yok" sorusu (Basamak 3).
- **Basamak 5 tasarım denetimi (Fable, 2026-10-19) uygulandı:** (A) işlev kaybı geri — sekmeden çıkış uyarısı, taslak sunucuda (ey_panel_taslak), pencerede "Pasifleri göster", son açan kişi hatırlanır, PIN'de Enter · (B) eski tasarım — 72 px −/+, 640 px pencere, yeşil hero, eski metinler. ⏳ "🔒 Stok sayımı sürüyor — Ürün Aç kapalı" bandı: EY'de sayım kilidi kaynağı gelince (kuyruk).

### Bağlantı — Gider + Bar (2026-10-19) · sahip kararı: açılış/kapanışta YALNIZ TEZGAH sayılır
- Her şubede iki konum: `depo:{şube}` (arka, kapalı koli) · `bar:{şube}` (tezgah). Panelde sayılan ürün (panel_sayim: bardak/süt/su/Redbull/cookie) Ürün Aç'ta depo→bar TAŞINIR (gider değil); açılış/kapanış sayımı `bar:{şube}`'e yazılır; tüketim = bar sayım farkı (eski formül açılış + ürün aç − kapanış ile aynı). Açılınca biten (acilinca) → depo→dışarı:tüketim (gider). Yalnız dönem sayımlı → yalnız olay.
- Gider (yeni dönem): mal = dışarı:tüketim hareketleri (ac + bar tüketimi) × fiyat_bilgi (KDV dahil, eklenmez); sevk bedeli = şubenin kabulü + toptancıdan doğrudan giriş; gün kesin = panel kapanış olayı. Depo kapalıysa boş + depo_kapali.
- Bar (yeni dönem): olay defteri (açılış/kapanış sayim + pasta_toplam, ürün aç olay saati) + pasta kabulü; kalemler = panel_sayim ürünleri + pasta; her kalemde `anahtar` (bardak_kucuk/buyuk/plastik…) → Satış kontrolü değişmeden çalışır.
- ⏳ Kalan: Satış günlük dökümünde FİRE hâlâ eski sube_fire_bildirim'den → Fire basamağında yeni olaya bağlanacak.

## BASAMAK 8 — TEDARİKÇİDEN TESLİM AL + TOPTANCI MEKANİZMASI (sahip onayı 2026-10-19)
**Var olan kurgu ESAS** (evvel_yeni_toptanci_api.py 16 Ekim: TEK KAYIT = TESLİM · borç teslimde · tahmini/kesin · fatura aynı kayda · ödeme Ödeme formundan) — hiçbir parçası yeniden kurgulanmaz. Eski sürümün kök hatası: fatura teslimden AYRI kayıt doğdu → eşleştirme motoru üstüne motor (Fable teşhisi). Sahibin hedefi: **📒 Toptancı Kitabı** — toptancı seç → borç · son teslim · teslimler sırayla · her teslimin faturası (foto/PDF) sayfa sayfa.
- **E4** Panel "Tedarikçiden teslim al" (TEK teslim kapısı; Tema = merkez depo da bu ekranla; süt/kahve/pasta doğrudan gelen şubeler de): kategori → ürün (− adet +, koli yardımcısı yalnız ekranda) · toptancı (ey_toptanci, kendiliğinden AÇILMAZ) · fatura geldi mi (EVET → tutar zorunlu, fatura no VARSA — sahip 19 Eki: numara her faturada gelmiyor; HAYIR → kâğıtta tutar varsa) · not · QR girişli kişi + PIN · gün kapalıysa yok · 3 dk aynı içerik kilidi · tek işlem: olay `teslim_al` + `teslim_yaz` + Depo `giris` (dışarı:toptanci → depo:şube). Sipariş modu + eksik bildirimi sipariş basamağıyla (ertelendi).
- **E5** Fiyat öğrenme yalnız merkez kesinleştirince (şube tutarından öğrenme yok).
- **E1** `ey_toptanci_belge` (teslime bağlı foto/PDF, küçültülmüş, BYTEA; OCR/eşleştirme YOK) — şube teslim sonrası QR → telefon; merkez PDF ekle.
- **E2** Eksik belge rozeti (fatura geldi ∧ belge yok) + 7 gün Bekleyen işler.
- **E3** Toptancılar ekranında kitap (sayfa çevirici) + "Belge ekle".
- Toplu fatura: yeni yapı YOK (Fable kararı) — merkez her teslime payını yazar, aynı fatura_no birden çok teslime; %30 sapma yanlış yazımı yakalar. Merkez /teslim ucu kalemsiz kalır (istisnalar). Merkez iptalinde depo girişi: konumda sonraki sayım varsa geri alınmaz (yalnız borç) — Depo PUBLIC hareket_iptal (E4 ile).
- Fatura fotoğrafı ölçümü: eski panelden son 30 günde 0; tedarikci_fatura 89 kayıt / 30 günde 2.


## Basamak 5 — Sevk et ⇄ Depodan gelen (+ pasta, sipariş) · 20 Eki
**Var mı (ben + Fable + Codex ayrı ayrı):** tek stok defteri, fark çöz, sevk bedeli (Gider), Bar pasta okuyucusu VAR · sevk yazma / yoldakiler / merkez adına kabul KISMİ (hedefi eski `stok_yolda`'dan okuyor) · şube kabulü, 0 kabul, hasarlı, panel listesi, merkez Sevk et ekranı, panel Depodan gelen ekranı, EY sipariş YOK. **Yeni stok defteri kurulmaz.**

**Sahip kararları (20 Eki):** P1 pasta **pastaneden alınır** (üretim yok; Tema'ya ya da şubeye doğrudan Tedarikçiden teslim al) · P2 stok görünmüyorsa sevk **yazılır + merkeze uyarı** (engellenmez) · P3 kabulde **"hasarlı" kutusu** → merkez Depo'da fire/iade kararı · P4 **Sipariş ver/takip + Gönderilecek de 1 Kasım'dan ÖNCE**.

**Bulgular (Fable F / Codex C):** 1 F+C hedef şube yok (merkez kabul 404) · 2 F+C şube kabulü + 0 kabul yazılamıyor · 3 F evren kapısı (deneme sevki görünmez; 1 Kasım'da eski açık sevkler listeden düşer) · 4 C köprü `yolda:%` yeni sevki iptal edebilir · 5 C merkez kabul/fark çöz eşzamanlı çift yazım · 6 F+C bag paket başına olursa ürün karışır · 7 F+C Bar yalnız `kabul` sayar (doğrudan gelen pasta girmez) · 8 F pasta depoda birikir görünür · 9 F kabul sonrası sevk iptali stoğu bozar · 10 F+C "stok eksiye düştü" işi yok · 11 C depo takvim günü ↔ panel iş günü (00–02) · 12 C panel Tema'nın depo olduğunu bilmiyor · 13 F talepsiz sevk siparişe bağlanabilir kalmalı · 14 C belge satırları eskimiş.

**Mekanizma (kurulacak sıra):**
- **S1 Depo servisi** (evvel_yeni_depo_api, PUBLIC): küçük başlık `ey_sevk_parti` (kaynak, hedef, kim, zaman, istek_id, not, iptal) · `sevk_yaz` → her ÜRÜN ayrı satır `bag = sevk:{parti}:{i}`, ref ailesi `sevk:` (köprünün `yolda:` ailesinden ayrı — #4) · `kabul_yaz(bag, sayilan, hasarli)` 0 da yazılır; fazla → askıda; hasarlı → askıda tür `hasar`; ikinci farklı kabul 409 · `/yolda` hedefi başlıktan + `evren` parametresi (#3) · merkez kabul başlıktan (#1) · kabul/fark çöz parti kilidiyle (#5) · kabul varsa sevk iptali 409 (#9) · "kaynak eksi" Bekleyen işi (#10, P2) · gün = iş günü (#11) · 1 Kasım öncesi DENEME.
- **S2 Merkez "Sevk et"** — Depo modülüne sekme (hedef şube + katalog + adet + koli yardımcısı + not).
- **S3 Panel "Depodan gelen"** — paket kartları, kalem kalem KÖR sayım (beklenen gösterilmez), hasarlı kutusu, kişi + PIN, gün kapalıyken de açık.
- **S4 Pasta** — Bar doğrudan gelen pastayı (`giris` dışarı:toptanci→depo:şube) da sayar (#7, P1); pasta depo bakiyesi kuralı (#8).
- **S5 Sipariş ver / takip / Gönderilecek** (P4) — SIPARIS_TASARIM tabloları; "Yola çıkar" S1 `sevk_yaz`'ı çağırır (#13). Ayrı "var mı" ile.

**Fable mekanizma onayı (20 Eki) — EVET, 6 ek:** F1 kabul/fazla/hasar/merkez_kabul/çöz ref'leri de `sevk:{parti}:{i}:…` (köprünün `yolda:%` iptali dokunmasın) · F2 kilit sırası sabit: konum kilidi ÖNCE, parti kilidi SONRA (her uçta) · F3 PUBLIC `yoldakiler(cur, hedef)` adet DÖNMEZ (kör) + `panel_durum` `depo_yolda` rozeti + `depo_kapali` · F4 "kaynak eksi" işi saklanmaz, `depo_isleri`'nde bakiyeden TÜRETİLİR · F5 parti iptali: kalemlerden biri kabul/hasar/fazla aldıysa 409 (yarım iptal yok) · F6 `panel_durum` `sube.depo` bayrağı (Gönderilecek). Başlık = `ey_sevk_parti` (Depo'nun kendi işi; olay bağımlılığı eklemez). **Pasta kuralı (öneri, sahip onayı):** katalogda takip `gununde` → depoya girdiği (giris/kabul) AN aynı bag'le `tuketim` yazılır; depo bakiyesi hep 0, Gider = alınan pasta × fiyat, Bar `kabul`+`giris` okur, `_PASTA_IZ` ad tahmini kalkar. Sıra: S1 (servis + okuyucular + evren + pasta kuralı + Bar satırı) → S2 → S3 → S5.
Sahip 20 Eki: pasta her şubeye DOĞRUDAN gelir → Sevk et'te pasta (gununde) seçilemez (400).
