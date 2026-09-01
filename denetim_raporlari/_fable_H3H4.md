# FABLE — HALKA 3-4 (sevkiyat/depo → teslim kabul → stok)

### SEVK-P0-1 | P0 | Uyumsuzluk çözümü YOLDAKİ paketi ölü doğuruyor (zombi mal)
operasyon_merkez_api.py:13278-13300
sevkiyat-uyumsuzluk-coz sonrası "kalan uyumsuz var mı" sayacı `kabul_ts IS NOT NULL` filtresiyle kuruluyor; hâlâ 'yolda' olan satırların kabul_ts NULL → sayaç GÖRMEZ → talep koşulsuz 'teslim_edildi'.
Sonra şube kapısı 400, motor "kabul zaten işlendi" der → yoldaki paket ASLA kabul edilemez; kaynaktan düşülmüş adet deftere giremez.
ÖNERİ: sayaca durum='yolda' satırlarını da kat.

### V2-P0-2 | P0 | v2 (KADİFE) sevk-çıktı ucu klasikten ZAYIF kurallarla aynı tabloyu yazıyor
operasyon_merkez_api.py:13958-13971 (SevkItem 13885-13894) vs siparis_sevkiyat_islem.py:355-470
Klasik hat: istenen adedi talepten doğrular · gonderilen_adet'i TAVANA kırpar · kalem_surum bayat-pencere kilidi · sevk sonrası durum+sevkiyat_ts güncellemesi · ValueError→409.
v2 ucu: HİÇBİRİ YOK. SevkItem modeli istenen_adet bile taşımıyor → ilk sevkte tavan hiç çalışmaz; talep 'gonderildi'ye geçmez; sevkiyat_ts yazılmaz (sevkiyat-hız duyusu bu teslimi hiç ölçmez).
SENARYO: kadife ekrandan istenen 5 iken sevk_adet=500 → 500 düşer, 500 yola çıkar, fren yok. Klasikte 409 olurdu.
ÖNERİ: v2 sevk ucunu klasik motora köprüle.

### V2-P1-3 | P1 | v2 kabul ucu klasik kapıların HİÇBİRİNDEN geçmiyor + ValueError 500 patlıyor
operasyon_merkez_api.py:13977-14016 vs sube_panel.py:5258-5370
Klasik: PIN + kasa-açık + şube sahipliği + durum kapısı + yabancı yolda_id reddi + ValueError→409/404.
v2: yalnız SELECT sube_id, sonra doğrudan sube_kabul_kaydet. İki arayüz aynı işleme FARKLI cevap veriyor.

### SAVEPOINT-P1-4 | P1 | İki "coz" ucunun defter bloğu SAVEPOINT'siz → stok düzeltmesi sessiz ROLLBACK, yanıt success
operasyon_merkez_api.py:13312-13325 ve 13458-13476
operasyon_defter_ekle çok-adımlı SQL + advisory lock + HMAC zinciri; patlarsa transaction zehirlenir, pass yutar, COMMIT=ROLLBACK.
Ekran "uzlaştırıldı" der; ertesi gün aynı satır yine uyumsuzluk listesinde.

### TAHSIS-P1-5 | P1 | talep-tahsis "çözümü" DÜZELTMİYOR, tarihi EZİYOR (istenen adet siliniyor, rezerv düzeltilmiyor)
operasyon_merkez_api.py:13340-13470
k["adet"]=cozum; k["istenen_adet"]=cozum; kd["tahsis_adet"]=cozum → şubenin GERÇEKTE ne istediği tablodan silinir; tüm türev denetimler ezilmiş sayıyla çalışır.
rezerve_adet'e hiç dokunulmuyor → merkez_tahsis_yap delta'yı yanlış hesaplar, rezerv kalıcı sürüklenir.

### EKSIK-P1-6 | P1 | Toptancı eksik teslimi: kalem/adet YAZILMIYOR + talep bağı "bugünün en son talebi" TAHMİNİ
sube_panel.py:3505-3547
siparis_sevk_eksik'e yalnız kategori + serbest metin; hangi kalemden kaç adet eksik hiçbir yapılandırılmış alana girmiyor.
Kayıt `tarih=CURRENT_DATE ORDER BY olusturma DESC LIMIT 1` ile bulunan EN SON talebe iliştiriliyor → sabah A, öğlen B siparişi verilmişse A'nın eksiği B'ye yazılır.

### REZERV-P2-7 | P2 | Sevk çıkışı rezervi TAHSİSE BAKMADAN düşüyor → tahsissiz sevk BAŞKA talebin rezervini yiyor
operasyon_stok_motor.py:3399-3407, 3556-3564
rezerve_adet = GREATEST(0, rezerve_adet - sevk_adet) — bu sevkin tahsisli olup olmadığına bakmıyor; GREATEST(0,..) taşmayı yutuyor, iz kalmıyor.

### UYUM-P2-8 | P2 | "Uyumsuzluklar" listesi YOLDAKİ her paketi uyumsuz sayıyor (sahte kalabalık)
operasyon_merkez_api.py:13098-13130 — 'yolda' satırında kabul_adet NULL→0, sevk>0 olan her paket uyumsuzluk satırı olur. 30 yolda + 2 gerçek fark = 32 satır; gerçek farklar boğulur.

### SEVK-P2-9 | P2 (bilinçli sapma) | Kaynak düşmeden hedefin artabildiği yol — alarm var, DENKLEM yok
operasyon_stok_motor.py:3433-3475 (STOK_DUSME_HATASI), 3480-3520 (HAYALET_STOK)
rowcount==0 veya yetersiz stokta sevk yine geçer; hedef +72, kaynak −0 → şebeke stoğu şişer. Düzeltme insana kalır.

### ZİNCİR HÜKMÜ
İstenen `kalemler`de · tahsis `kalem_durumlari`+`rezerve_adet`te · sevk `stok_yolda.sevk_adet`te · kabul `kabul_adet`te yaşıyor.
Klasik hatta İKİ denklem gerçekten zorlanıyor (toplam sevk ≤ istenen; deftere ≤ LEAST(kabul,sevk)) — ama TAHSİS↔SEVK arasında hiçbir denklem yok ve v2 sevk ucu istenen tavanını taşımadığı için ilk sevkte SINIRSIZ.
Çift tık tarafı bu halkanın EN SAĞLAM yeri (durum='yolda' filtresi + islenen_yolda + idempotans kapısı).
Öncelik: SEVK-P0-1 ve V2-P0-2 hemen; sonra SAVEPOINT-P1-4 ve TAHSIS-P1-5.
