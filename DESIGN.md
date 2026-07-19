# Evvel Tasarım Dili (Design Language)

Kaynak: Kâr & Maliyet yeniden yapılandırması (2026-07, Stripe/Mercury/Ramp/Linear
referanslı + Codex ikinci-göz). Tüm sayfalara **aynı gözle** uygulanır.
**Renk/tema ASLA değişmez** — espresso/bakır/krem koyu tema, Fraunces başlık,
`var(--*)` token'ları tek merkez (index.css). Yalnızca bilgi mimarisi + hiyerarşi.

## 13 Desen

1. **Hero-önce hiyerarşi** — Sayfanın ANA cevabı (tek büyük sayı/durum) en tepede,
   büyük ve baskın. İkincil metrikler altında, sakin. "Bir bakışta ne oldu?"
2. **Risk şeridi tepede** — Güveni etkileyen uyarılar (eksik veri, şişme riski,
   karar bekleyen) hero'nun ÜSTÜNDE. Asla en altta gömülü değil (Ramp exception-feed).
3. **Şelale, kart mozaiği değil** — Sıralı kırılım (A − B = C) tek akan liste; 6 eşit
   kart DEĞİL. Sonuç hero'ya AKAR, tekrar ETMEZ.
4. **Yoğun ikincil içerik alt-sekmede** — Aksiyon kuyrukları / detay tabloları
   sekme arkasında + **açık-iş rozeti** (ör. "🔎 İnceleme Gerekenler (88)").
   Hep-açık değil; üst özet kısa kalır.
5. **Sparkline/dekor disiplini** — Trend görseli yalnız hero'da; yarışan kartlarda yok.
6. **Tek ₺** — `fmt()` simgeyi kendi ekler; arkasına ikinci ₺ yazma. Yerel `fmt`
   (₺ eklemeyen) varsa scope-aware kontrol et.
7. **Düz dille etiket** — "yeni stok adedi", "adet/min" değil. Etiket alanın ÜSTÜNDE,
   placeholder-as-label değil (alan doluyken ne olduğu kaybolmasın).
8. **Kritik bağlam görünür** — Rozet/uyarı anlamı ekranda yazılı; yalnız hover'da
   değil (dokunmatikte hover yok).
9. **Sekmede sayı rozeti** — Bekleyen iş sayısı sekme etiketinde + turuncu vurgu;
   gizli ama kör nokta oluşturmaz.
10. **Toast geri bildirim** — Kayıt/hata görünür toast ("✅ Süt 42→46 ₺ kaydedildi"),
    sessiz kapanma veya çirkin alert değil.
11. **Hata/boş durum ayrımı** — "veri yok" ≠ "sistem bozuk"; kırmızı bant + "🔄
    Tekrar dene" (Linear). Sessiz `.catch` yasak.
12. **Detay default kapalı** — Drill-down'lar kapalı başlar (hero baskın kalsın),
    tıkla-aç. Güven skoru / para-nereye / kırılım hep-açık değil.
13. **Dokunmatik hedef** — Tıklanabilir öğe belli (shape/renk), min 44px; POS
    ekranında 72px buton / 140px tile / 16px+ font.

## Uygulama sırası (CFO'dan başla, tek tek)
CFO Panel → Operasyon Merkezi → Akıllı Denetim → Duyu Paneli → Ödeme Merkezi →
Tedarikçi Kontrol → Borç Navigasyonu → Onay Kuyruğu → Ciro Onayı → Kartlar →
Personel → Vardiya → Görev → Stok Sayım → Sabit Giderler → Tedarik Dosyası →
Rapor → (cep/QR ayrı tur).

## Kural
- Her sayfa: audit (bu 13 desen) → yeniden kurgu → derle → deploy → canlı doğrula.
- Atomik commit (mantıksal her değişiklik ayrı). Veri/iş mantığına dokunma.
- Kararsızlıkta Codex ikinci-göz (kullanıcı kuralı).
