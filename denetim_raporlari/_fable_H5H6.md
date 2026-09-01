# FABLE — HALKA 5-6 (belge talebi → fatura → borç)

### H56-1 | P0 | SÖZ KAPISI SIZDIRIYOR — kapı yalnız gece taramasında; yükleme/OCR yolu HÂLÂ söz üretiyor
fatura_api.py:953 (kapı), 822-935 (motorda kapı YOK), 2113 · 2435 · 4952 · 5568 (kapısız çağıranlar)
SOZ_DEFTERI_URETIMI_ACIK=False yalnız /kuyruk-tara girişinde okunuyor; _fatura_kuyruk_uret'in kendisinde kapı yok.
OCR bitince (2113) ve yükle-pdf FAZ A'da (2435) motor DOĞRUDAN çağrılıyor → main.vadeli_ekle ile YENİ vadeli_alimlar sözü doğuyor.
SAHİP KARARI ("söz mantığı devre dışı, ödenecekler cariden türetilir") yalnız gece yoluna uygulanmış — ölü defter fatura yüklendikçe kendini dolduruyor.
SONUÇ: aynı borç İKİ TEMSİLLE yaşıyor (cari türetimi + söz), ap_mutabakat her gece "kuyruk ≠ cari" sapması basıyor.
ÖNERİ: kapı kontrolünü _fatura_kuyruk_uret'in İLK SATIRINA taşı (tek merkez).

### H56-2 | P0 | SAVEPOINT'SİZ AUDIT — bağ kurma/çözme "ok" der ama COMMIT sessizce ROLLBACK olur
belge_talep_api.py:1632-1641 (fatura-bagla), 1457-1466 (geri-al); kasa_service.py:105-114
Koddaki "audit düşse de bağ kurulmuş kalır" yorumu YANLIŞ: audit düşerse bağ da düşer, ekran kurulmuş sanır.
SENARYO: geri-al çağrılır → UPDATE geçer → audit_log INSERT patlar → except yutar → COMMIT=ROLLBACK → yanıt "Bağ çözüldü" → bağ yerinde durur → sonra 409 "zaten bağlı", sebep anlaşılmaz.

### H56-3 | P1 | GERİ ALMA ASİMETRİSİ — bağ çözülür ama siparis_talep_id damgası KALIR, "KESİN eşleşme" olarak DİRİLİR
belge_talep_api.py:1447-1453 (geri-al yalnız belge_talep tarafını siler), 2434-2440 (yükleme damgalar), 1321-1338 (KESİN=siparis_talep_id); fatura_api.py:7220-7229, 7353-7359
Çelişkide DAMGA kazanıyor: /gecmis-eslestir aynı faturayı "Aynı sipariş talebinden doğmuş — başka kanıt gerekmez" diye KESİN listeye geri koyuyor → yanlış bağ döngüde yeniden kuruluyor.

### H56-4 | P1 | KANITSIZ 'FATURA' KAPANIŞI — boş gövdeli /kapat, faturasız kaydı fatura-kanıtlı gibi kapatıyor
belge_talep_api.py:2186-2211. tip = "fatura" if durum=="pdf_geldi" else "manuel"; fatura dalında ne fatura_id ne açıklama şartı var.
Tek POST ile GRNI (belgesiz borç tahakkuku) düşer, kayıt kapanis_tipi='fatura' ama bağlı fatura YOK.

### H56-5 | P1 | GERÇEK TUTAR HİÇ GELMİYOR — asenkron OCR yolunda kapanış tutarsız kalır, sapma denetimi KÖR
belge_talep_api.py:2483-2492, 2507, 2529-2540; fatura_api.py:2107-2116 (OCR sonrası belge_talep'e geri yazım YOK)
fatura-yukle talebi ANINDA kapatıyor ama toplam_tutar o an NULL (OCR arka planda) → fatura_tutar_tl boş kalıyor, sonradan dolduran YAZICI YOK.
tutar_fark_tl doğmuyor → acik-teslimat sapma denetimi (2124-2144) bu kayıtları HİÇ görmüyor.
Ayrıca çoklu-faturalı PDF'te SUM(hepsi) tek talebe yazılırken bağ yalnız fatura_idler[0]'a kuruluyor → kalan faturalar bağsız, başka teslimata da bağlanabilir.

### H56-6 | P2 | FATURA SİLİNİNCE SÖZÜ ÖKSÜZ KALIR — belge bağı çözülür ama vadeli_alimlar kaydı YAŞAR
fatura_api.py:2460-2517 (silme), 979-987 (ters yön hijyeni var, bu yön yok). kuyruk_vadeli_id'nin işaret ettiği satıra dokunulmuyor.

### H56-7 | P2 | ÇOKLU-ADAY GUARD'I BEKLENEN BOŞKEN KÖR — fren sessizce devre dışı
belge_talep_api.py:1568-1592. Bant ABS(tutar-beklenen) <= GREATEST(1, beklenen*0.15); beklenen 0/NULL ise bant ±1 ₺'ye iner, hiçbir rakip yakalanmaz.
En korumaya muhtaç kayıt (tutarı bilinmeyen teslimat) EN AZ korunan kayıt oluyor.

### H56-8 | P2 | GRNI DOĞUMU TEK TETİK + HATA-YUTAR — doğmayan kayıt "borç yok" görünür
belge_talep_api.py:265-321, 337-356 (telafi salt-okur, gun<=730), 615-646.
Telafi var ama İNSAN ÇAĞIRMALI. Canlıda tam bu halde 7 gönderim 72-75 gün görünmez kaldı (koddaki ölçüm notu).

### ZİNCİR HÜKMÜ
Bir lira İKİ KEZ sayılır: her yeni fatura hem cari türetimine hem sızdıran söz defterine girer (H56-1); silinen faturanın sözü arkada yaşar (H56-6).
Bir lira ÜÇ YERDE kaybolur: boş gövdeli /kapat GRNI'yi kanıtsız düşürür (H56-4) · tetiği kaçan teslimat hiç borç doğurmaz (H56-8) · savepoint'siz audit "ok" der ama commit rollback olur (H56-2).
İYİ KURULMUŞ: kanıt sıralaması (kalem 35 > ad 30 > tarih 25 > tutar 10, tarih-yönü guard'lı) — yalnız-tutara dayanan yol KAPATILMIŞ.
Zayıf nokta artık puanlama değil, geri almanın damgayı temizlememesi (H56-3).
