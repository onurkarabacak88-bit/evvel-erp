# FABLE — HALKA 7 (toptancı cari hesabı)

### H7-01 | P0 | Devir ataması TANIMSIZ `g_adlar` ile yapılıyor → cari-ozet 500 / devir YANLIŞ tedarikçiye
fatura_api.py:6396-6403 (kullanım) ↔ 6423 (tanım). HEAD commit 8f9678a devir atamasını son6'dan öncesine taşımış ama alias listesi 20 satır AŞAĞIDA tanımlı.
İlk grup iterasyonu: g_adlar bağlanmamış → aktif en az bir devir varsa cari_ozet() UnboundLocalError → 500.
Sonraki iterasyonlar: ÖNCEKİ grubun alias listesiyle eşleştirir → devir yanlış tedarikçiye yapışır; _atandi bayrağı yüzünden doğru sahibine bir daha gidemez.
Zincirin tamamı bu fonksiyona bağlı: odenecek-kuyruk · ap-mutabakat · ap-selfheal · odeme_plani_cari_uyumsuzluk.

### H7-02 | P0 | /cari-ode ödemesi bakiye aritmetiğine HİÇ girmiyor — borç düşmez, İKİNCİ KEZ ödenir
fatura_api.py:8325-8328, 6270-6296 (3 kanal), 68-78 (KART_ODEME_IZI_SARTI); main.py:8619-8625, 1613-1620
hesaplanan_acik'ın ödeme tarafı YALNIZ 3 kanaldan okunuyor: vadeli_alimlar 'odendi' · anlik_giderler kaynak_id IS NULL · kart_hareketleri (kaynak_id IS NULL OR ekstre_import).
/cari-ode ise NAKİTTE kasa_hareketleri'ne (hiçbir kanal değil), KARTTA kaynak_tablo='cari_odeme' + kaynak_id DOLU satıra (ŞART tarafından ELENİR) yazıyor. cari_odeme tablosunu HİÇBİR bakiye ucu okumuyor.
Sistemin KANONİK cari ödeme ucu, cari bakiyeyi düşürmeyen TEK ödeme yolu.
ÖNERİ: ödeme izi evrenine 4. kanal olarak cari_odeme (iptal=FALSE) eklensin, ekstre gelince _cift_kanal_tekille ile tekilleştirilsin.

### H7-03 | P1 | Devir çizgisi elemesi ÜÇ uçta ÜÇ farklı doktrin — METRO düzeltmesi ekstreye işlenmemiş
fatura_api.py:7135-7139, 7157 (ekstre: KOŞULSUZ kesit) ↔ 6404-6414 (ozet: devir varsa) ↔ 8184-8192 (odenecekler: devir varsa)
Devirsiz + sistem-öncesi faturalı tedarikçide (METRO deseni) ozet borcu TAM sayar, ekstre EKSİK sayar → aynı tedarikçiye iki farklı hesaplanan_acik.
cari-kuyruk-hizala-onizle ve cari-tahsis-onizle hedefi EKSTREDEN okuyor → hizalama küçük (yanlış) hedefe kuruluyor.

### H7-04 | P1 | Ekstre fatura seçimi ALT-DİZE + çift yönlü alt-küme → başka firmanın faturası havuza ve TAHSİSE karışır
fatura_api.py:6967, 6969-6971. `ara.lower() in ad.lower()` düz alt-dize ("FEZ" ⊂ "FEZA GIDA"); `_ara_tok <= ft or ft <= _ara_tok` çift yönlü alt-küme ("ATALAY KAHVE" → {atalay} ⊂ "ATALAY TEKSTİL").
Bu liste cari-odenecekler FIFO havuzunu ve /cari-ode tahsisini BESLİYOR → yanlış eşleşme görüntü değil PARA hatası.

### H7-05 | P1 | FIFO havuzu YALNIZ tahsis defterini düşer — 3-kanal ödeme izleri ve iadeler havuzu küçültmez
fatura_api.py:8193-8212. kalan = tutar − cari_odeme_tahsis toplamı. Kartla ödenmiş fatura havuzda TAM tutarıyla açık durur → yeni para FIFO ile "zaten ödenmiş" faturaya tahsis edilir.
acik_toplam ≠ hesaplanan_acik sonsuza dek ayrışır.

### H7-06 | P2 | Fazla ödemenin "avansı" hiçbir deftere yazılmıyor — yalnız yanıt JSON'unda yaşıyor
fatura_api.py:8281-8300, 8359. avans_kalan tek satır; kalıcı kayıt yok. H7-02 ile birleşince bakiye eksiye de düşmez → "tedarikçide alacağımız var" bilgisi hiçbir ekrandan sorgulanamaz.

### H7-07 | P2 | Geri alma "tamamlandı" işareti bırakmıyor — bitmiş geri almanın 2. çağrısı 3. adımı TEKRAR koşturur
fatura_api.py:1689-1699, 1727-1746. Başarılı geri almadan sonra iptal=TRUE ve plan_id DOLU kalıyor → ikinci çağrı _yarim_tamamla dalına girip odeme_plani_sil'i tekrar uyguluyor.

### H7-08 | P2 | Eleme asimetrisi TERS yönde de var — fatura penceresiz, ödeme pencereli
fatura_api.py:6413-6414 (fatura: fl tamamı) ↔ 6280-6296 (ödeme: tarih >= kesit_6ay)
Devirsiz tedarikçide çizgi öncesi fatura sayılıyor ama onu ödeyen çizgi öncesi iz sayılmıyor → borç olduğundan BÜYÜK görünüyor.

### H7-09 | P2 | Tek çapraz ölçüm (gece ap-mutabakat) TAMAMEN susturuldu
fatura_api.py:6748-6763. SOZ_DEFTERI_URETIMI_ACIK=False iken 'atlandi' dönüyor. Gerekçe tutarlı ama H7-02'nin ürettiği "cari düşmüyor" sapmasını yakalayacak OTOMATİK hiçbir kıyas kalmadı.
OLUMLU BULGU: ap_mutabakat farkı gerçekten iki bağımsız kaynaktan ölçüyor — denkleştirme yaması / sahte 0,00 YOK.

### ZİNCİR HÜKMÜ
Bakiye en yüksek sesle /cari-ode'nin KENDİSİNDE yalan söylüyor: resmî ödeme kapısından çıkan para hesaplanan_acik'a hiç işlenmiyor (H7-02).
İkinci yalan "kaç gerçek var": cari-ozet bir sayı · cari-ekstre (devir doktrini işlenmemiş) başka sayı · cari-odenecekler (yalnız tahsis defteri) üçüncü sayı (H7-03, H7-05).
Bugün itibarıyla aktif devir varken cari_ozet tanımsız g_adlar yüzünden HİÇ konuşamıyor (H7-01).
ÇİFT DÜŞÜM BULUNMADI; sahte-0,00 denkleştirme yaması YOK. Asıl tehlike tersi: SIFIR düşüm, kaybolan avans, susturulmuş gece mutabakatı.
