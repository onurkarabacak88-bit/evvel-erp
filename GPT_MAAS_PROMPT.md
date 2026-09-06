# GPT'YE GÖNDERİLECEK PROMPT — kopyala/yapıştır

> Aşağıdaki metnin tamamını ChatGPT'ye yapıştırın. Kendi kendine yeter,
> kod erişimi gerektirmez.

---

Sen deneyimli bir ERP/bordro sistem mimarısın. Türkiye iş mevzuatını ve
küçük-orta işletme gerçeklerini bilen biri gibi cevap ver. Türkçe yaz.

Sana canlıda çalışan bir sistemin bordro alanını anlatacağım. Alan yamalarla
ayakta duruyor ve sahibi **yeniden kurmak** istiyor. Senden **mimari karar ve
yol haritası** istiyorum — "şunu da düşünebilirsiniz" değil, "şöyle kurulmalı,
şu sırayla, şu gerekçeyle".

## İŞLETME
4 şubeli kahve zinciri, ~30 personel. Şubeler: Zafer · Köyceğiz · Gazze · Alsancak.
Vergi yapısı karma: iki şube şahıs, iki şube şirket.
Yazılım: FastAPI + PostgreSQL + React. Tek geliştirici. Demo aşamasında ama
CANLI VERİ var, ödemeler gerçek para.

## İŞ KURALLARI (işletme sahibinin beyanı)
1. Personelle **aylık** anlaşılıyor: asgari ücret + **7.000 ₺ yemek ücreti**.
2. Saatlik çalışanlar **99 ₺/saat** — asgari ücret artmadıkça değişmiyor.
3. Tam zamanlı günlük çalışma **9,5 saat**.
4. Personel yemek molasına **zamanında giriş yapmazsa** yemek ücretinden
   kesinti yapılıyor (yönetim kararı). Giriş/çıkış QR ile kaydediliyor.
5. **Hafta izni kesinti değildir.** Normalde haftada 1 gün izin, ama bazen ayda
   5 gün izin oluyor.
6. İzinler **aynı gün verilmiyor** — kişiye göre değişiyor ve **aylara sarkıyor**.
   Aynı ay biri 25 biri 26 gün çalışabiliyor.
7. Aylar 28/30/31 çekiyor; anlaşma aylık olduğu için sonuç değişmemeli.
8. Ay bitmeden ayrılan tam yemek ücreti almamalı; işten ayrıldığı güne kadar
   hakediş çalışmalı.
9. Personel çıkıp geri girebiliyor (ayrı çalışma dönemleri, aynı kişi).
10. Bazı personellerle asgari ücretin **üstünde** anlaşma yapılabiliyor.

## BUGÜN SİSTEM NASIL ÇALIŞIYOR (ve neden yanlış)

**Hakediş kalıcı değil.** Maaş, her sorulduğunda o anki veriye ve o günkü koda
bakılarak yeniden hesaplanıyor. Hiçbir yere kalem kalem yazılmıyor; sadece bir
"net" sayısı saklanıyor. Sonuç: üç ayrı ekran üç farklı rakam söyleyebiliyor,
geçmiş ay bugünkü kuralla değişebiliyor, "bu 259 ₺ nereden çıktı" sorusunun
cevabı yok.

**Somut hata (gerçek vaka):** Bir personel Temmuz'da 25 gün çalıştı, 6 gün hafta
izni yaptı. 25 günün 25'inde de yemek molası kaydı var, hepsi limitin altında —
tek ihlal yok. Sistem yemeği şöyle hesaplıyordu:
`yemek = (7.000 / 30) × 25 gün = 5.833,33`
Yani **hafta iznini kesinti sayıyordu**. Doğrusu 7.000 olmalıydı; personel
1.166,67 ₺ eksik aldı. Aynı hata 9 kişide toplam 6.609 ₺.
Bu rakam personelin **kendi telefonundaki ekranda** da görünüyordu.

**Diğer ölçülmüş kusurlar:**
- Yemek formülü **üç ayrı yerde** farklı yazılmış (bordro motoru / yedek yol /
  maliyet paneli).
- Dönem oranı **iki farklı** şekilde hesaplanıyor (gün/30 vs gün/ayın takvim günü)
  → 15 gün çalışan 0,500 ya da 0,484 alıyor.
- Kesinti kuralı (mola limiti) tarihsiz bir ayarda tutuluyor → kural değişince
  **geçmiş aylar da değişiyor**.
- Bordroyu yazan **üç ayrı kod yolu** var, üçü de kendi kaydını yazıyor.
- Onaylanmış kayıt bir daha hesaplanmıyor → ücreti sonradan tanımlanan personelin
  maaşı **0'da dondu** ve fark edilmedi (2.470 ₺).
- **Ücretsiz izin hiç kesilmiyor** — ücretsiz izin alan tam maaş alıyor.
- Vardiya verisi girilmezse bazı kalemler 0 çıkıyordu (4 ay boyunca 9 kayıtta
  hiç vardiya girilmemiş).
- Ödeme ile bordro arasında **kimlik bağı yok**, sadece tarih aritmetiği var.

## ÇÖZÜLMESİ GEREKEN YENİ GEREKSİNİMLER

1. **Asgari ücret merkezî olmalı.** Bugün her personelin kartında elle yazılı;
   asgari ücret artınca 30 kartı tek tek güncellemek gerekiyor. Tek yerden
   değiştiğinde herkese uygulanmalı — AMA asgari üstü bireysel anlaşmalar
   etkilenmemeli. Ayrıca **yıllık artış ve ara zamlar** var; geçmiş dönemler
   eski tutarla hesaplanmaya devam etmeli.
2. **Müdürlere vardiya tanımlanamıyor.** Bir müdür dört ay üst üste "vardiyası
   yok" göründü ve yemeği 0 çıktı. Yönetici kadrosunun hakediş ekseni ne olmalı?
3. **Her işletmenin mesai kavramı farklı.** Fazla mesai eşiği kodda sabit 9,5 saat.
4. **Veri girilmediğinde sistem çökmemeli** — maaş yine doğru hesaplanmalı.
   Ama veri girmemek de ödüllendirilmemeli.
5. **Personel kendi hakedişini canlı görüyor** (telefon ekranı) — bu ekran da
   aynı çekirdekten beslenmeli.

## SANA SORULARIM

**A. Karar:** Bu alan yamalanmalı mı, yeniden mi kurulmalı? 30 kişi/4 şube
ölçeğinde ve tek geliştiriciyle. Hangi parça kalır, hangisi yeniden yazılır?

**B. Alan modeli:** Hangi kavramlar KALICI olmalı (tablo), hangileri türetilmeli?
"Dönem", "hakediş kalemi", "kesinti", "kanıt", "ödeme", "alacak", "kural"
nasıl ayrışmalı? Bordro sistemlerinin bilinen desenlerinden (payroll run,
earning/deduction lines, effective-dated rules, retro adjustment) hangileri bu
ölçeğe oturur, hangileri aşırıdır?

**C. Ücret ve zam modeli:** Asgari ücret + bireysel anlaşma + yıllık artış +
ara zam nasıl modellenir ki geçmiş dönemler bozulmasın? Tarih aralıklı ücret
kaydı mı, versiyonlu sözleşme mi, başka bir şey mi?

**D. Veri eksikliği:** Vardiya/yoklama/mola kaydı girilmediğinde hakediş nasıl
hesaplanmalı? "Kanıt yoksa kesinti yok" doğru bir kural mı? Bu, veri girmemeyi
ödüllendirir mi — ödüllendirirse **kesinti dışında** hangi mekanizmayla
frenlenir?

**E. Geçmiş düzeltme:** Onaylanmış/ödenmiş bir dönemde hata bulunursa ne yapılır?
Geçmişi yeniden yazmak mı, farkı sonraki döneme taşımak mı? Muhasebe ve iş
hukuku açısından hangisi doğru?

**F. Yönetici kadrosu:** Vardiyası olmayan (müdür gibi) personelin hakedişi
nasıl kurgulanır? Sabit mi, farklı bir ölçüm ekseni mi?

**G. Yol haritası:** Canlı sistemi düşürmeden hedef mimariye nasıl gidilir?
Adım adım, her adım tek başına değer üretecek şekilde. Hangi adımlar geri
alınabilir, hangileri tek yönlü kapı?

**H. Bizim düşünmediğimiz varyasyonlar:** Maaşla ilgili başka hangi durumlar
yaşanabilir? (ay ortası zam · şube değişikliği · aynı ay iki şubede çalışma ·
avans devri · raporlu gün · bayram mesaisi çakışması · doğum/ölüm izni · kıdem
tazminatı · eksik gün bildirimi vs.) Her biri için bu mimari ne yapmalı?

**I. Türkiye mevzuatı:** İş Kanunu açısından dikkat etmemiz gereken noktalar?
Özellikle: ücret kesintisi (md. 62), aylık ücretin ay uzunluğundan bağımsızlığı,
yemek/yol yardımının hukuki niteliği, bordro saklama yükümlülüğü.

## İSTEDİĞİM ÇIKTI BİÇİMİ
Her soru için: **KARAR** (tek cümle) → **GEREKÇE** → **SOMUT KARŞILIK**
(hangi tablo/alan/kural). Sonunda numaralı bir yol haritası ve
"EN RİSKLİ VARSAYIM" başlığıyla kendi önerinin en kırılgan yeri.

Genel geçer tavsiye verme; bu işletmenin ölçeğine ve anlatılan kusurlara özgü
ol. Emin olmadığın yeri "emin değilim" diye yaz.
