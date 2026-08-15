// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — "kadife koyu" tasarım dili
// Kaynak: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html (Cloud Design v2)
//
// Bu dosya SADECE v2 kabuğunda (#tasarim-v2) kullanılır. index.css token'larına
// dokunmaz — mevcut açık-krem tema canlıda olduğu gibi kalır. Tasarım paketi
// bütün modüllere yayılıp onaylanınca token'lar index.css'e taşınacak.
// ─────────────────────────────────────────────────────────────────────────────

export const R = {
  // zeminler
  zemin: '#16100A',
  ray: '#120C07',
  sutun: '#1A1209',
  girinti: '#1F160D',
  // kart yüzeyleri (gradient uçları)
  kart1: '#2A2015',
  kart2: '#221809',
  kartUst1: '#2E2317',
  kartUst2: '#231909',
  // çizgiler
  cizgi: '#2C2016',
  cizgi2: '#33251A',
  cizgi3: '#3A2C1E',
  // metin
  krem: '#F3EADC',
  metin2: '#C4B5A2',
  not: '#9B8A75',
  // not2 de sistematik taramada bir kademe açıldı: kart yüzeyinde 3,75→4,17:1
  // (hiyerarşi: not'tan soluk, not3'ten koyu kalır).
  not2: '#93836E',
  // ui-ux-pro-max kontrast denetimi (2026-08-14): #6E6052 kart yüzeyinde 2,53:1
  // idi (WCAG 4,5:1 altı — küçük punto yardımcı metin okunmuyordu). Aynı ton
  // ailesinde bir kademe açıldı: kartta 3,4:1 / zeminde 4,2:1. Hiyerarşi korunur
  // (not2'den hâlâ soluk). Tam AA istenirse punto büyütme sahiple konuşulmalı.
  not3: '#847460',
  // marka + durum
  bakir: '#D29A5B',
  bakirAcik: '#E5B27A',
  bakirKoyu: '#96602C',
  yesil: '#4ADE80',
  kirmizi: '#F87171',
  amber: '#FBBF24',
  mavi: '#60A5FA',
};

export const F = {
  baslik: "'Fraunces', Georgia, serif",
  govde: "'Instrument Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', monospace",
};

/** Kart yüzeyi — tasarımdaki standart panel dolgusu. */
export const kartYuzey = {
  background: `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`,
  border: '1px solid rgba(243,233,220,.1)',
  borderRadius: 18,
  boxShadow: '0 14px 32px rgba(0,0,0,.32)',
};

/** Tier → renk. Duyu/öneri listelerinde kullanılır. */
export const TIER_RENK = {
  kritik: R.kirmizi,
  uyari: R.amber,
  bilgi: R.mavi,
  iyi: R.yesil,
};

// ─── İkonlar (lucide çizim dili, stroke-width 1.7) ───────────────────────────
export const IK = {
  gosterge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  radar: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  banknot: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M5.5 12h.01M18.5 12h.01"/>',
  para: '<circle cx="8" cy="8" r="5.5"/><path d="M18.6 9.4a5.5 5.5 0 1 1-9.2 9.2"/><path d="M8 5.5v5M5.5 8h5"/>',
  ekip: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="3.75"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.4a3.75 3.75 0 0 1 0 7.2"/>',
  grafik: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M8 16.5v-5M13 16.5V8M18 16.5v-3"/>',
  kart: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  pusula: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3Z"/>',
  banka: '<path d="M3 21.5h18"/><path d="M5.5 18v-8M10 18v-8M14 18v-8M18.5 18v-8"/><path d="m3 7 9-4.5L21 7v3H3Z"/>',
  islemci: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  onay: '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  kahve: '<path d="M17 9h1.5a3.5 3.5 0 1 1 0 7H17"/><path d="M3.5 9H17v7.5a4 4 0 0 1-4 4h-5.5a4 4 0 0 1-4-4Z"/><path d="M7 5.5V3.5M10.5 5.5v-2M14 5.5v-2"/>',
  klasor: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  anahtar: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>',
  dosya: '<path d="M14.5 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7.5Z"/><path d="M14.5 2.5v5h5"/><path d="M9 13h6M9 16.5h6"/>',
  // ── EK İKONLAR (2026-08-16, Bakış yeniden-düzeni) ──────────────────────────
  // Karar alanında emoji kullanılıyordu (🔴 📅 🧠 ☀️ 🔔). Emoji platformdan
  // platforma farklı çizilir, stroke kalınlığı/rengi tasarım diline uymaz.
  // Aşağıdakiler AYNI lucide çizim dili (24x24, stroke 1.7) — mevcut anahtarların
  // hiçbiri değişmedi, yalnız EKLENDİ (diğer modüller etkilenmez).
  uyari: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.3v5.4"/><path d="M12 16.4h.01"/>',
  takvim: '<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M3 10h18"/><path d="M8 2.5v4M16 2.5v4"/>',
  asagiOk: '<path d="m6 9.5 6 6 6-6"/>',
  kule: '<path d="M12 2.5v19"/><path d="M12 5.5 20 8v3l-8-2.5Z"/><path d="M12 12 4 14.5v3L12 15Z"/>',
};

// ─── Modül ağacı ─────────────────────────────────────────────────────────────
// `hedef` = mevcut uygulamadaki hash rotası. v2'de henüz karşılığı yazılmamış
// görünümler oraya köprülenir; böylece kabuk baştan gezilebilir olur.
//
// `rozet` = CANLI sayaç anahtarı (tasarımdaki sabit demo sayıları değil —
// TasarimV2.jsx rozetleri gerçek veriden hesaplar). Sayacı henüz bağlanmamış
// anahtarlar rozet göstermez; ilgili modül v2'ye yazılırken bağlanır.
// `renk` = tasarımdaki rozet rengi; #F87171 (kırmızı) olan bir görünüm varsa
// modülün ray ikonunda kırmızı nokta belirir.
/** Üst çubuktaki "Gün Sonu Takibi" YALNIZ günlük operasyon modüllerinde çıkar.
 *  Kural (yeni handoff): başlıktaki birincil eylem içerikle ilgisizse render
 *  edilmez — TV menüsü düzenlerken ya da borç takvimine bakarken orada durması
 *  kullanıcıyı yanlış yönlendirir. */
export const GUN_SONU_MODULLERI = ['panel', 'para', 'odeme', 'ops', 'onaylar'];

/** TARİH GEZGİNİ BEYAZ LİSTESİ — 'modul.gorunum' biçiminde.
 *
 *  ⚠️ HANDOFF'UN KRİTİK KURALI: gezgin, GÜN KAVRAMI OLMAYAN ekranda render
 *  EDİLMEZ. Aksi hâlde arayüz YANLIŞ TARİH İDDİA EDER — sarı bant "29 Temmuz
 *  kapanışıdır" derken ekran başka bir günün sabit verisini gösterir. Finansal
 *  üründe bu doğrudan yanlış bilgidir.
 *
 *  Bu yüzden liste DAR tutulur; bir ekran ancak İKİ şartı da sağlarsa girer:
 *    1. gerçekten gün-kapsamlı (aylık/kümülatif/master-data DEĞİL), ve
 *    2. o günün verisini GERÇEKTEN getirebiliyoruz (uydurma ölçekleme yok).
 *
 *  Bilinçli DIŞARIDA kalanlar:
 *   · panel.ay · panel.subeler · maliyet.ozet · rapor.aylik  → AYLIK
 *   · ops.depo · odeme.tedarikci · borc.takvim              → KÜMÜLATİF/ANLIK
 *   · tanim.* · sistem.*                                     → MASTER DATA
 *   · ops.bar · ekip.gorev · ekip.maas · ekip.takip          → KENDİ gün/ay
 *     seçicileri var; ikinci bir kontrol "tek eylem tek yer" kuralını çiğner
 *   · panel.risk · panel.strateji · denetim.*                → uçları tarih
 *     parametresi almıyor; gezgin koyarsak tarih yalanı olur (uç eklenince girer)
 */
export const TARIH_GEZGINI_EKRANLARI = ['panel.bugun'];

export const MODULLER = [
  // ══════════════════ BLOK: KARAR ══════════════════
  // Sahip isteği (2026-07-31): "sol alanda PANELİN ÜSTÜNDE Genel Bakış yazsın;
  // klasik CFO panelindeki 13 bölüm / 20+ ucun kartları burada olsun."
  // Panel modülüne DOKUNULMADI — eski hâlinde kaldı.
  { id: 'genel', blok: 'Karar', ad: 'Genel Bakış', kisa: 'Bakış', alt: 'Klasik CFO kartları', ikon: IK.gosterge, gorunumler: [
    // ⚠️ ROZET ADI UYUŞMAZLIĞI (2026-08-08 denetimi): burada 'genelGecikmis'
    // yazıyordu ama TasarimV2 'genelAcik' besliyor (kritik kalem sayısı) →
    // rozet HİÇ görünmüyordu. Tanım koda uyduruldu (kod tek gerçek).
    { id: 'karar', ad: 'Karar Alanı', rozet: 'genelAcik', renk: '#F87171' },
    { id: 'akis', ad: 'Para Akışı & Kasa' },
    { id: 'bildirim', ad: 'Motor & Bildirimler', rozet: 'genelBildirim', renk: '#FBBF24' },
  ]},
  { id: 'panel', blok: 'Karar', ad: 'Yönetim & Karar', kisa: 'Panel', alt: 'CFO görünümleri', ikon: IK.gosterge, gorunumler: [
    { id: 'bugun', ad: 'Bugün' },
    { id: 'ay', ad: 'Ay Özeti' },
    { id: 'subeler', ad: 'Şube Karnesi' },
    { id: 'risk', ad: 'Riskler', rozet: 'risk', renk: '#F87171' },
    { id: 'strateji', ad: 'Strateji Önerileri' },
  ]},
  // Denetim & Zekâ: v2-YERLİ (DenetimModulu.jsx) — öneri-only; derin inceleme
  // Akıllı Denetim / Duyu Paneli ekranlarına köprüyle gider.
  { id: 'denetim', blok: 'Karar', ad: 'Denetim & Zekâ', kisa: 'Zekâ', alt: '13 tanı motoru · duyu', ikon: IK.islemci, gorunumler: [
    { id: 'anomali', ad: 'Bugünkü Bulgular', rozet: 'anomali', renk: '#F87171' },
    { id: 'motorlar', ad: 'Tanı Motorları · 13' },
    // ⭐ MUTABAKAT MERKEZİ (2026-08-08, sahip: "aradığın ve bulamadıklarının
    // listesi + yükleme yapılıp yapılmayacağını soracağın sistem"). Aynı soru
    // bugüne dek DÖRT ekrana dağılmıştı (Belge Merkezi · Duyu Mutabakatı ·
    // Teslimat Zinciri · Belge Talebi) ve hiçbiri "ne yapmalı" demiyordu.
    // Aşağıdaki 'Duyu Mutabakatı' DAR kapsamdır (tedarikçi bakiye ↔ ödeme aday
    // eşleşmesi) — silinmedi, bu geniş kapının altında kaldı.
    { id: 'mutabakatmerkezi', ad: 'Mutabakat Merkezi', rozet: 'mutabakatAcik', renk: '#F87171' },
    { id: 'mutabakat', ad: 'Duyu Mutabakatı', rozet: 'duyuMutabakat', renk: '#FBBF24' },
    { id: 'bag', ad: 'Bağ Defteri' },
    // 🩺 PARA ZİNCİRİ TEŞHİSİ (2026-08-08): fatura→borç→ödeme→cari sağlığını
    // ölçen yedi uç vardı, hiçbiri ekranda değildi.
    { id: 'parazinciri', ad: 'Para Zinciri Teşhisi' },
    { id: 'duyu', ad: 'Sinyal İzleme' },
  ]},
  { id: 'rapor', blok: 'Karar', ad: 'Rapor & Defter', kisa: 'Rapor', alt: 'Aylık · işlem izi', ikon: IK.grafik, gorunumler: [
    { id: 'aylik', ad: 'Aylık Rapor' },
    { id: 'defter', ad: 'İşlem Defteri' },
  ]},

  // ══════════════════ BLOK: GÜNLÜK İŞ ══════════════════
  // Operasyon: v2-YERLİ (OpsModulu.jsx) — hedef köprüleri kalktı.
  { id: 'ops', blok: 'Günlük iş', ad: 'Operasyon', kisa: 'Ops', alt: 'Sipariş · depo · sevk', ikon: IK.radar, gorunumler: [
    { id: 'akis', ad: 'Sipariş Akışı', rozet: 'opsAcikSiparis', renk: '#D29A5B' },
    { id: 'bar', ad: 'Bar Akışı · gün', rozet: 'barAcik', renk: '#FBBF24' },
    { id: 'denetim', ad: 'Merkez Denetim', rozet: 'opsDenetim', renk: '#F87171' },
    { id: 'uzlastir', ad: 'Uzlaştırma', rozet: 'opsUzlastir', renk: '#FBBF24' },
    { id: 'katalog', ad: 'Sipariş Kataloğu' },
    { id: 'tedarik', ad: 'Tedarik & Sinyal' },
    { id: 'sevkiyat', ad: 'Sevkiyat Hazırlama', rozet: 'opsSevkiyat', renk: '#60A5FA' },
    { id: 'zincir', ad: 'Teslimat Zinciri', rozet: 'teslimatZinciri', renk: '#FBBF24' },
    { id: 'depo', ad: 'Depo Stok', rozet: 'opsDepoKritik', renk: '#F87171' },
    { id: 'sayim', ad: 'Bardak & Ürün Sayımı', rozet: 'stokSayim', renk: '#FBBF24' },
    { id: 'hareket', ad: 'Stok Hareketi' },
    // Sahip kararı (2026-08-03, soru 1/9): kapanmış siparişler kanban penceresinden
    // çıkınca kayboluyordu — "geçen ay ne gönderdik" sorusu cevapsızdı.
    // AYRI görünüm istendi (sekme değil). Sevkiyat rapor tarihçesi de burada.
    { id: 'siparisarsiv', ad: 'Sipariş Arşivi' },
  ]},
  // Para Hareketleri: v2-YERLİ (ParaModulu.jsx). Ciro Girişi artık YERLİ kadife
  // form (2026-07-29, köprü kaldırma turu) — aynı guard'lı uca yazar (POST /ciro:
  // mükerrer+force, DELETE: kasa iadesi). Gider/dış-kaynak girişi hâlâ köprülü.
  // kasaTeslim rozeti BİLEREK bağlanmadı: sistemde "bekleyen teslim" kaydı yok
  // (kayıt teslimle doğar) — rozet uydurma anlam taşırdı.
  { id: 'para', blok: 'Günlük iş', ad: 'Gelir & Kasa', kisa: 'Gelir', alt: 'Ciro · satış · kasa', ikon: IK.kahve, gorunumler: [
    { id: 'girisi', ad: 'Ciro Girişi' },
    { id: 'satis', ad: 'Ürün Satışları' },
    // kasaTeslim rozeti GERİ geldi (duyu 2/6): artık uydurma değil — para-yolda
    // ucundan türetilen "teslim edilmemiş kapanış" sayısı.
    { id: 'kasa', ad: 'Kasa Teslim', rozet: 'kasaTeslim', renk: '#FBBF24' },
    { id: 'diskaynak', ad: 'Dış Kaynak Geliri' },
  ]},
  { id: 'odeme', blok: 'Günlük iş', ad: 'Ödeme Merkezi', kisa: 'Ödeme', alt: 'Vade · bakiye · geçmiş', ikon: IK.banknot, gorunumler: [
    { id: 'bekleyen', ad: 'Bekleyen Ödemeler', rozet: 'odemeBekleyen', renk: '#D29A5B' },
    { id: 'takvim', ad: 'Vade Takvimi' },
    { id: 'sabit', ad: 'Sabit Giderler', rozet: 'sabitGider', renk: '#D29A5B' },
    { id: 'gider', ad: 'Anlık Gider' },
    { id: 'tedarikci', ad: 'Tedarikçi Bakiyesi' },
    // 🔗 KART İZİ EŞLEŞTİRME (2026-08-08): otomatik eşleştirme motoru güven
    // skoruna göre "sahip onaylasın" diyordu ama onaylayacak EKRAN YOKTU —
    // öğrenme döngüsü kapalı kalıyordu. Bu görünüm döngüyü açar.
    { id: 'eslesme', ad: 'Kart İzi Eşleştirme' },
    { id: 'eslesmedefter', ad: 'Eşleşme Karar Defteri' },
    { id: 'gecmis', ad: 'Ödeme Geçmişi' },
  ]},
  { id: 'onaylar', blok: 'Günlük iş', ad: 'Onay Kuyruğu', kisa: 'Onay', alt: 'Bekleyen kararlar', ikon: IK.onay, gorunumler: [
    { id: 'kuyruk', ad: 'Bekleyen Kararlar', rozet: 'onay', renk: '#4ADE80' },
    { id: 'ciro', ad: 'Ciro Onayı', rozet: 'ciroOnay', renk: '#4ADE80' },
  ]},

  // ══════════════════ BLOK: FİNANS ══════════════════
  // Kâr & Maliyet: v2-YERLİ (MaliyetModulu.jsx). "Ürün Marjı" → "Ürün Maliyeti":
  // satış fiyatı sisteme bağlı değil, marj yüzdesi sahte olurdu (düz-dil kuralı).
  { id: 'maliyet', blok: 'Finans', ad: 'Kâr & Maliyet', kisa: 'Maliyet', alt: 'Maliyet · reçete · fiyat', ikon: IK.para, gorunumler: [
    { id: 'ozet', ad: 'Marj Özeti' },
    { id: 'urun', ad: 'Ürün Maliyeti' },
    { id: 'recete', ad: 'Reçeteler' },
    // Sahip isteği (2026-07-28): satış×reçete beklenen vs ürün-aç gerçek —
    // fazla kullanım saptama tasarıma geldi (recete_api.kontrol motoru, öneri-only)
    { id: 'tuketim', ad: 'Tüketim Kontrolü', rozet: 'tuketimFark', renk: '#F87171' },
    { id: 'fiyat', ad: 'Fiyat Zinciri' },
    // 📈 ZAM TAKİBİ (2026-08-15, sahip: "bu artışlar ayrı bir sekme gibi düşün" —
    // canlıda 9 alarm doğdu: FEZ püre %26,8, ATALAY espresso %16,7).
    // Alarm listesi 'Fiyat Zinciri'nden BURAYA TAŞINDI, KOPYALANMADI: orada
    // yerine tek satır köprü kaldı, iki ekran aynı listeyi göstermiyor.
    // 🔔 ROZET DE İÇERİKLE BİRLİKTE TAŞINDI: 'fiyatZinciri' sayacı
    // (TasarimV2.jsx:337 besler) artık listenin DURDUĞU satırda yanar — rozetin
    // bir sekmede, içeriğin başka sekmede olması sahibi yanlış yere götürürdü.
    // Anahtar adı korundu (besleyici tarafta değişiklik gerekmesin).
    { id: 'zam', ad: 'Zam Takibi', rozet: 'fiyatZinciri', renk: '#FBBF24' },
    // ⚠️ AYRI GÖRÜNÜM — Marj Özeti'ne KARIŞTIRILMADI. Sunucunun kendi tanımı:
    // "İZOLE KDV Pozisyonu (P&L DIŞI)". KDV ne gelir ne giderdir, devlet adına
    // tahsil/ödemedir; P&L tablosuna katmak modeli bozar. Vergi de aynı yerde:
    // şubeler KARMA (şahıs/şirket) olduğu için düz oran YANLIŞ — uç şube şube
    // vergi_tipi + yöntem + efektif oran döndürüyor.
    { id: 'vergi', ad: 'Vergi & KDV' },
  ]},
  // ✅ v2'ye yazıldı — köprü yok, görünümler yerli (KartModulu.jsx)
  { id: 'kart', blok: 'Finans', ad: 'Borç & Kredi', kisa: 'Borç', alt: 'Kart · kredi · faiz', ikon: IK.kart, gorunumler: [
    { id: 'ozet', ad: 'Borç & Faiz Özeti', rozet: 'kartGecikmis', renk: '#F87171' },
    { id: 'kartlar', ad: 'Kart Dosyaları' },
    { id: 'krediler', ad: 'Banka Kredileri' },
    { id: 'koc', ad: 'Borç Koçu' },
    { id: 'hareket', ad: 'Kart Hareketleri', rozet: 'hareketBelirsiz', renk: '#FBBF24' },
    { id: 'ekstre', ad: 'Ekstre Durumu', rozet: 'ekstreEksik', renk: '#FBBF24' },
  ]},
  { id: 'borc', blok: 'Finans', ad: 'Finansal Sağlık', kisa: 'Sağlık', alt: 'BBE · ABEK · runway', ikon: IK.pusula, gorunumler: [
    { id: 'durum', ad: 'Bu Ay Batıyor Muyum?', rozet: 'borcDurum', renk: '#F87171' },
    { id: 'takvim', ad: 'Borç Takvimi · 36 ay' },
    { id: 'projeksiyon', ad: 'Nakit Projeksiyonu · 12 ay' },
    { id: 'hedef', ad: 'Hedef Ciro & Ölçek' },
    { id: 'katki', ad: 'Şube Katkısı' },
  ]},

  // ══════════════════ BLOK: KAYIT & KURULUM ══════════════════
  // Personel & Vardiya: v2-YERLİ (EkipModulu.jsx). Maaş/vardiya YAZMAZ — salt-okur,
  // onay ve atama mevcut guard'lı ekranlardan yapılır.
  { id: 'ekip', blok: 'Kayıt & kurulum', ad: 'Personel & Vardiya', kisa: 'Ekip', alt: 'Kadro · plan · bordro', ikon: IK.ekip, gorunumler: [
    { id: 'kadro', ad: 'Kadro' },
    { id: 'vardiya', ad: 'Vardiya Planı', rozet: 'vardiyaAcik', renk: '#FBBF24' },
    { id: 'maas', ad: 'Maaş & Avans', rozet: 'maasBekleyen', renk: '#D29A5B' },
    { id: 'gorev', ad: 'Görev Takibi', rozet: 'gorevAcik', renk: '#60A5FA' },
    { id: 'takip', ad: 'Vardiya Takip · giriş-çıkış' },
    { id: 'denetim', ad: 'Personel Denetimi', rozet: 'ekipDenetim', renk: '#FBBF24' },
    { id: 'basvuru', ad: 'İş Başvuruları', rozet: 'basvuru', renk: '#4ADE80' },
    { id: 'pinqr', ad: 'Panel PIN & Görev QR' },
  ]},
  // Belge Merkezi: v2-YERLİ (BelgeModulu.jsx) — /fatura/belge-merkezi omurgası;
  // fatura isteme/onay yazmaları mevcut Belge Merkezi ekranında (köprü).
  { id: 'belge', blok: 'Kayıt & kurulum', ad: 'Belge Merkezi', kisa: 'Belge', alt: 'Fatura · kapsama · KDV', ikon: IK.dosya, gorunumler: [
    { id: 'kapsama', ad: 'Belge Kapsama', rozet: 'belgeKapsama', renk: '#FBBF24' },
    { id: 'arsiv', ad: 'Fatura Arşivi · FTS' },
    { id: 'istek', ad: 'Fatura İstek · wa.me', rozet: 'faturaIstek', renk: '#D29A5B' },
    { id: 'uyarilar', ad: 'Mükerrer & Parmak İzi', rozet: 'belgeMukerrer', renk: '#F87171' },
    { id: 'cari', ad: 'Cari Ekstre' },
    { id: 'fiyat', ad: 'Alış Fiyat Bandı' },
    { id: 'kdv', ad: 'KDV Kanıt Paketi' },
    // 🧾 VERGİ ETKİSİ (2026-08-08, sahip: "fatura varsa vergiden düşümde gider
    // olarak sayılmalı ki ödenecek vergiyi daha net belirlemiş oluruz")
    { id: 'vergi', ad: 'Vergi Etkisi · belgeli/belgesiz' },
  ]},
  { id: 'tanim', blok: 'Kayıt & kurulum', ad: 'Tanımlar', kisa: 'Tanım', alt: 'Tedarikçi · TV menü', ikon: IK.klasor, gorunumler: [
    { id: 'tedarikciler', ad: 'Tedarikçiler' },
    { id: 'dosya', ad: 'Tedarikçi Sözleşmeleri', rozet: 'tedarikDosyasi', renk: '#FBBF24' },
    // Kimlik birleştirme: aynı tedarikçinin farklı adlarını tek kimlikte toplama
    // (öneri + append-only karar defteri). Tanımlar modülüne ait — bir KAYIT işi.
    { id: 'birlestir', ad: 'Kimlik Birleştirme' },
    { id: 'tv', ad: 'TV Menü Yönetimi' },
  ]},
  { id: 'sistem', blok: 'Kayıt & kurulum', ad: 'Veri & Sistem', kisa: 'Sistem', alt: 'Import · teslim · temizlik', ikon: IK.anahtar, gorunumler: [
    { id: 'excel', ad: 'Excel Import' },
    { id: 'teslim', ad: 'Bilgi Teslim', rozet: 'bilgiTeslim', renk: '#60A5FA' },
    { id: 'temizle', ad: 'Veri Temizle' },
    // Emeklilik kapısı: klasik tasarım silinmedi, acil durumda buradan açılır.
    { id: 'klasik', ad: 'Klasik Tasarım' },
  ]},
];
