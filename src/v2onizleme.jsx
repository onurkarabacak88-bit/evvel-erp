// SADECE GELİŞTİRME — v2 kabuğunun görsel doğrulama tezgâhı.
//
// Uygulama şifre kapısının arkasında olduğu için pilot ekranlar burada sahte
// veriyle ayağa kaldırılır: `npm run dev` → /v2onizleme.html
// Üretim derlemesine GİRMEZ (Vite yalnızca index.html'i derler).
// Kalan modüller v2'ye geçirilirken aynı tezgâh kullanılacak.
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import TasarimV2 from './pages/v2/TasarimV2';

const SUBELER = ['Zafer', 'Köyceğiz', 'Gazze', 'Alsancak'];
const AGIRLIK = { Zafer: 1.0, 'Köyceğiz': 0.78, Gazze: 0.62, Alsancak: 0.44 };

// Tarih tuzağı TEZGÂHTA DA geçerli: toISOString UTC'dir — TR'de gece 00:00-03:00
// arasında "bugün"ü bir gün geri kaydırır, modüllerin yerel-bugün'üyle eşleşmez.
const yerelISO = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function ciroUret() {
  const satir = [];
  const bugun = new Date();
  for (let g = 29; g >= 0; g--) {
    const d = new Date(bugun);
    d.setDate(d.getDate() - g);
    const tarih = yerelISO(d);
    const dalga = 1 + Math.sin(g / 3) * 0.16 + (d.getDay() === 0 || d.getDay() === 6 ? 0.22 : 0);
    SUBELER.forEach((s, i) => {
      const taban = 26000 * AGIRLIK[s] * dalga;
      const nakit = Math.round(taban * 0.38);
      const pos = Math.round(taban * 0.52);
      const online = Math.round(taban * 0.10);
      satir.push({
        id: `${tarih}-${i}`, tarih, sube_id: `s${i}`, sube_adi: s,
        nakit, pos, online, toplam: nakit + pos + online,
      });
    });
  }
  return satir.reverse();
}

const SAHTE = {
  '/api/panel': {
    // kasa = KANONİK alan (motors.guncel_kasa) — v2 kabuk kutusu BUNU okur;
    // genel_* toplamları farklı agregalardır, kasa yerine kullanılmaz (sahip dersi).
    kasa: 2533389,
    genel_nakit_toplam: 312400,
    genel_kart_toplam: 273910,
    bu_ay_sadece_ciro: 2184500,
    bu_ay_nakit: 830110,
    bu_ay_pos: 1136000,
    bu_ay_online: 218390,
    bu_ay_online_kesinti: 14200,
    bugun_odemeler: [
      { tip: 'degisken', gun_farki: 0, tutar: 68400, ad: 'Kahve Dünyası' },
      { tip: 'sabit', gun_farki: -1, tutar: 41250, ad: 'Sütaş Bölge' },
    ],
    ciro_eksik_gunler: [
      { sube_adi: 'Gazze', tarih: '2026-07-24' },
    ],
    oneriler: [
      { baslik: 'Vadesi geçen 2 tedarikçi ödemesi', aciklama: 'çekirdek + süt · gecikirse tedarik riski', renk: 'KIRMIZI', tavsiye_tutar: 109650, odeme_id: 'x1' },
      { baslik: 'Süt fiyatı %9 arttı — reçeteler güncel değil', aciklama: '42 → 46 ₺/L · latte maliyeti +1,4 ₺', renk: 'TURUNCU', tavsiye_tutar: 21400, odeme_id: 'x2' },
      { baslik: 'Alsancak sayımı eksik', aciklama: 'dün 23:40 kapanış · 6 kalem girilmedi', renk: 'SARI', tavsiye_tutar: 0 },
    ],
  },
  '/api/subeler': SUBELER.map((s, i) => ({ id: `s${i}`, ad: s })),
  '/api/onay-kuyrugu': [
    { id: 'ok1', islem_turu: 'ANLIK_GIDER', kaynak_tablo: 'anlik_giderler', aciklama: 'Kadıköy — cam silme hizmeti', tutar: 1800, tarih: '2026-07-25', durum: 'bekliyor' },
    { id: 'ok2', islem_turu: 'PERSONEL_AVANS', kaynak_tablo: 'personel', aciklama: 'Elif Kaya avans talebi', tutar: 4000, tarih: '2026-07-27', durum: 'bekliyor' },
    { id: 'ok3', islem_turu: 'FIRE', kaynak_tablo: 'fire_bildirim', aciklama: 'Gazze — 6 dilim cheesecake fire', tutar: 950, tarih: '2026-07-28', durum: 'bekliyor' },
    { id: 'ok4', islem_turu: 'KASA_FARK', kaynak_tablo: 'kasa', aciklama: 'Zafer kasa sayım farkı', tutar: 230, tarih: '2026-07-26', durum: 'bekliyor' },
    { id: 'ok5', islem_turu: 'STOK_DUZELTME', kaynak_tablo: 'envanter_duzeltme', aciklama: 'Merkez depo — 2 kg çekirdek düzeltme', tutar: 2000, tarih: '2026-07-24', durum: 'bekliyor' },
  ],
  // rozet sayaç uçları
  '/api/ciro-taslak': [
    { id: 'ct1', sube_id: 's2', sube_adi: 'Gazze', tarih: '2026-07-28', nakit: 6100, pos: 9800, online: 1900, aciklama: 'akşam vardiyası', durum: 'bekliyor' },
    { id: 'ct2', sube_id: 's1', sube_adi: 'Köyceğiz', tarih: '2026-07-28', nakit: 7400, pos: 11200, online: 2100, aciklama: null, durum: 'bekliyor' },
  ],
  '/api/is-basvurusu/ozet': { yeni: 2 },
  '/api/stok-sayim/bekleyen-onay': { toplam: 5 },
  '/api/ops/truth/gunluk-rapor': { subeler: [{ anomali_sayisi: 2 }, { anomali_sayisi: 1 }] },
};

const CIRO = ciroUret();

// ── Kartlar & Borç modülü sahte verisi ──────────────────────────────────────
const K = [
  { id: 'k1', kart_adi: 'Garanti Bonus İşletme', banka: 'Garanti', sahip: 'İşletme', limit_tutar: 250000, guncel_borc: 184300, faiz_orani: 52, kesim_gunu: 12, gun_kaldi: -2, asgari_odeme: 90760, asgari_karsilandi: false, ekstre_gercek: true, gelecek_taksit_anapara: 42600, toplam_borc_taksitli: 226900, son_odeme_tarihi: '2026-07-22', aktif_son_odeme: '2026-07-22' },
  { id: 'k2', kart_adi: 'Yapı Kredi World', banka: 'Yapı Kredi', sahip: 'Onur K.', limit_tutar: 150000, guncel_borc: 96800, faiz_orani: 58, kesim_gunu: 8, gun_kaldi: 0, asgari_odeme: 43680, asgari_karsilandi: false, ekstre_gercek: true, gelecek_taksit_anapara: 12400, toplam_borc_taksitli: 109200, son_odeme_tarihi: '2026-07-28', aktif_son_odeme: '2026-07-28' },
  { id: 'k3', kart_adi: 'İş Bankası Maximum', banka: 'İş Bankası', sahip: 'Onur K.', limit_tutar: 120000, guncel_borc: 54200, faiz_orani: 49, kesim_gunu: 26, gun_kaldi: 9, asgari_odeme: 16260, asgari_karsilandi: false, ekstre_gercek: false, gelecek_taksit_anapara: 0, toplam_borc_taksitli: 54200, son_odeme_tarihi: '2026-08-06', aktif_son_odeme: '2026-08-06' },
  { id: 'k4', kart_adi: 'Akbank Axess', banka: 'Akbank', sahip: 'İşletme', limit_tutar: 90000, guncel_borc: 31900, faiz_orani: 45, kesim_gunu: 2, gun_kaldi: 14, asgari_odeme: 9570, asgari_karsilandi: true, ekstre_gercek: true, gelecek_taksit_anapara: 8900, toplam_borc_taksitli: 40800, son_odeme_tarihi: '2026-08-11', aktif_son_odeme: '2026-08-11' },
  { id: 'k5', kart_adi: 'Ziraat Bankkart', banka: 'Ziraat', sahip: 'Onur K.', limit_tutar: 50000, guncel_borc: 12400, faiz_orani: 0, kesim_gunu: 18, gun_kaldi: 21, asgari_odeme: 3720, asgari_karsilandi: false, ekstre_gercek: true, gelecek_taksit_anapara: 0, toplam_borc_taksitli: 12400, son_odeme_tarihi: '2026-08-18', aktif_son_odeme: '2026-08-18' },
];

const KART_UC = {
  '/api/kartlar': K,
  '/api/kartlar/borc-faiz-ozet': {
    toplam_borc: 379600, toplam_taksit: 63900, toplam_borc_taksitli: 443500,
    toplam_odenen_faiz: 34020, kart_adet: 5, bu_ay_eksik_ekstre: 1,
    kartlar: K.map((k, i) => ({
      kart_id: k.id, kart_adi: k.kart_adi, sahip: k.sahip, limit: k.limit_tutar,
      guncel_borc: k.guncel_borc, gelecek_taksit_anapara: k.gelecek_taksit_anapara,
      toplam_borc_taksitli: k.toplam_borc_taksitli,
      toplam_odenen_faiz: [18400, 9100, 3200, 2400, 920][i],
      bu_ay_ekstre_var: k.ekstre_gercek,
    })),
  },
  '/api/kartlar/harcama-ozet': {
    genel: { isletme: 114700, sahsi: 8340, belirsiz: 16340, toplam: 139380 },
    kartlar: [],
  },
  '/api/kartlar/analiz': {
    aylik: [
      { donem: '2026-03-01', borc: 476654, faiz: 15272 },
      { donem: '2026-05-01', borc: 1203910, faiz: 41393 },
      { donem: '2026-06-01', borc: 2427886, faiz: 53545 },
      { donem: '2026-07-01', borc: 2469341, faiz: 86214 },
    ],
    kategori: [
      { kategori: 'Diğer', tutar: 749585, adet: 166 },
      { kategori: 'Faturalar', tutar: 110262, adet: 24 },
      { kategori: 'Market', tutar: 100040, adet: 40 },
      { kategori: 'Online Alışveriş', tutar: 76971, adet: 66 },
      { kategori: 'Vergi & SGK', tutar: 40934, adet: 5 },
    ],
  },
  '/api/kartlar/ekstre-arsiv': {
    kartlar: [{
      kart_id: 'k1', kart_adi: 'Axess 6616', banka: 'Axess',
      donemler: [
        { donem: '2026-07-01', kesim_tarihi: '2026-07-06', son_odeme_tarihi: '2026-07-16', donem_borcu: 38883, donem_harcama: 9124, donem_odeme: 10098, donem_faizi: 1496 },
        { donem: '2026-06-01', kesim_tarihi: '2026-06-06', son_odeme_tarihi: '2026-06-16', donem_borcu: 38361, donem_harcama: 12400, donem_odeme: 8200, donem_faizi: 1310 },
      ],
    }],
  },
  '/api/kart-hareketleri': [
    { id: 'h1', tarih: '2026-07-27', kart_adi: 'Garanti Bonus İşletme', islem_turu: 'HARCAMA', tutar: 68400, aciklama: 'Kahve Dünyası — çekirdek alımı', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 68400, faiz_tutari: 0 },
    { id: 'h2', tarih: '2026-07-26', kart_adi: 'Yapı Kredi World', islem_turu: 'HARCAMA', tutar: 16340, aciklama: 'Market — açıklama yok', harcama_tipi: 'belirsiz', taksit_sayisi: 1, ana_para: 16340, faiz_tutari: 0 },
    { id: 'h3', tarih: '2026-07-25', kart_adi: 'Akbank Axess', islem_turu: 'ODEME', tutar: 9570, aciklama: 'Asgari ödeme', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 9570, faiz_tutari: 0 },
    { id: 'h4', tarih: '2026-07-24', kart_adi: 'Garanti Bonus İşletme', islem_turu: 'FAIZ', tutar: 9832, aciklama: 'Dönem faizi (KKDF/BSMV dahil)', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 0, faiz_tutari: 9832 },
    { id: 'h5', tarih: '2026-07-22', kart_adi: 'Yapı Kredi World', islem_turu: 'HARCAMA', tutar: 8340, aciklama: 'Kişisel — restoran', harcama_tipi: 'sahsi', taksit_sayisi: 3, ana_para: 8340, faiz_tutari: 0 },
  ],
};

// ── Ödeme Merkezi modülü sahte verisi ───────────────────────────────────────
const bugunISO = yerelISO(new Date());
const gunEkleISO = (n) => { const d = new Date(bugunISO + 'T00:00:00'); d.setDate(d.getDate() + n); return yerelISO(d); };

const ODEME_UC = {
  '/api/odeme-plani/bugun': [
    { id: 'p1', baslik: 'Kahve Dünyası Çekirdek', tip: 'Vadeli Alım', kaynak_tablo: 'vadeli_alimlar', tutar: 68400, asgari: null, tarih: gunEkleISO(-2), gecikmis: true, gun_gecikme: 2, tedarikci: 'Kahve Dünyası' },
    { id: 'p2', baslik: 'Sütaş Bölge Dağıtım', tip: 'Vadeli Alım', kaynak_tablo: 'vadeli_alimlar', tutar: 41250, asgari: null, tarih: bugunISO, gecikmis: false, gun_gecikme: 0, tedarikci: 'Sütaş' },
    { id: 'p3', baslik: 'Doğan Emlak — kira', tip: 'Sabit Gider', kaynak_tablo: 'sabit_giderler', tutar: 96000, asgari: null, tarih: gunEkleISO(2), gecikmis: false, gun_gecikme: 0 },
    { id: 'p4', baslik: 'Paper Cup Co.', tip: 'Vadeli Alım', kaynak_tablo: 'vadeli_alimlar', tutar: 33800, asgari: null, tarih: gunEkleISO(3), gecikmis: false, gun_gecikme: 0, tedarikci: 'Paper Cup Co.' },
    { id: 'p5', baslik: 'Garanti Bonus İşletme', tip: 'Kredi Kartı', kaynak_tablo: 'kartlar', tutar: 90760, asgari: 90760, tarih: gunEkleISO(5), gecikmis: false, gun_gecikme: 0 },
    { id: 'p6', baslik: 'Enerjisa', tip: 'Sabit Gider', kaynak_tablo: 'sabit_giderler', tutar: 22640, asgari: null, tarih: gunEkleISO(9), gecikmis: false, gun_gecikme: 0 },
    { id: 'fatura_x', sabit_gider_id: 'sg9', baslik: '🧾 Su faturası — fatura tutarı girilmedi (≈2.400 ₺ tahmini)', tip: 'Fatura (tutar bekleniyor)', kaynak_tablo: 'sabit_giderler', tutar: 0, tahmini_tutar: 2400, asgari: null, tarih: null, gecikmis: true, gun_gecikme: 3, tutar_girilmedi: true },
  ],
  '/api/odeme-plani/kokpit': {
    kasa: 586310, gecikmis_toplam: 68400, gecikmis_adet: 1,
    ciro_gunluk_tahmin: 74000, en_dusuk_bakiye: 218400, en_dusuk_tarih: gunEkleISO(5), projeksiyon: [],
  },
  '/api/fatura/cari-ozet': {
    toplam_hesaplanan_acik: 364790, toplam_bekleyen_vade: 352790, toplam_beyan_bakiye: 371000,
    tedarikciler: [
      { tedarikci: 'Kahve Dünyası', hesaplanan_acik: 68400, beyan_bakiye: 68400, beyan_hesap_farki: 0, bekleyen_vade_toplam: 68400, fatura_adet_6ay: 24, fatura_toplam_6ay: 1620000, son_fatura: gunEkleISO(-1), en_yakin_vade: gunEkleISO(-2), odeme_izi_var: true, devir: 0 },
      { tedarikci: 'Doğan Emlak', hesaplanan_acik: 96000, beyan_bakiye: null, beyan_hesap_farki: null, bekleyen_vade_toplam: 96000, fatura_adet_6ay: 6, fatura_toplam_6ay: 576000, son_fatura: gunEkleISO(-27), en_yakin_vade: gunEkleISO(2), odeme_izi_var: true, devir: 0 },
      { tedarikci: 'Sütaş', hesaplanan_acik: 41250, beyan_bakiye: 96880, beyan_hesap_farki: 55630, bekleyen_vade_toplam: 41250, fatura_adet_6ay: 31, fatura_toplam_6ay: 1090000, son_fatura: bugunISO, en_yakin_vade: bugunISO, odeme_izi_var: true, devir: 111260 },
      { tedarikci: 'Paper Cup Co.', hesaplanan_acik: 33800, beyan_bakiye: 33800, beyan_hesap_farki: 0, bekleyen_vade_toplam: 33800, fatura_adet_6ay: 9, fatura_toplam_6ay: 243000, son_fatura: gunEkleISO(-4), en_yakin_vade: gunEkleISO(3), odeme_izi_var: true, devir: 0 },
      { tedarikci: 'ESHİM', hesaplanan_acik: 40800, beyan_bakiye: 40800, beyan_hesap_farki: 0, bekleyen_vade_toplam: 0, fatura_adet_6ay: 2, fatura_toplam_6ay: 40800, son_fatura: gunEkleISO(-40), en_yakin_vade: null, odeme_izi_var: false, devir: 0 },
      { tedarikci: 'Enerjisa', hesaplanan_acik: 22640, beyan_bakiye: 22640, beyan_hesap_farki: 0, bekleyen_vade_toplam: 22640, fatura_adet_6ay: 6, fatura_toplam_6ay: 134000, son_fatura: gunEkleISO(-8), en_yakin_vade: gunEkleISO(9), odeme_izi_var: true, devir: 0 },
    ],
  },
  '/api/ledger': [
    { id: 'l1', tarih: gunEkleISO(-2), islem_turu: 'FATURA_ODEMESI', tutar: -39800, aciklama: 'Sütaş Bölge Dağıtım', kaynak_tablo: 'vadeli_alimlar' },
    { id: 'l2', tarih: gunEkleISO(-4), islem_turu: 'KART_ODEME', tutar: -28400, aciklama: 'Paper Cup Co.', kaynak_tablo: 'kart_hareketleri' },
    { id: 'l3', tarih: gunEkleISO(-7), islem_turu: 'FATURA_ODEMESI', tutar: -64200, aciklama: 'Kahve Dünyası Çekirdek', kaynak_tablo: 'vadeli_alimlar' },
    { id: 'l4', tarih: gunEkleISO(-10), islem_turu: 'PERSONEL_MAAS', tutar: -184000, aciklama: 'Temmuz maaş ödemesi', kaynak_tablo: 'personel' },
    { id: 'l5', tarih: gunEkleISO(-27), islem_turu: 'FATURA_ODEMESI', tutar: -96000, aciklama: 'Doğan Emlak kira', kaynak_tablo: 'sabit_giderler' },
    { id: 'l6', tarih: gunEkleISO(-3), islem_turu: 'CIRO', tutar: 74000, aciklama: 'Günlük ciro', kaynak_tablo: 'ciro' },
  ],
};

// ── Operasyon modülü sahte verisi ───────────────────────────────────────────
const OPS_KALEM = (ozet) => ozet.map(([ad, adet], i) => ({ urun_id: `u${i}`, urun_ad: ad, adet }));
const OPS_UC = {
  '/api/ops/siparis/kontrol-kulesi': {
    ozet: { bekliyor: 2, depoda: 1, yolda: 1, toptanci_bekliyor: 1, uyumsuzluk: 1, tamamlandi: 1, iptal: 0, gonderilmedi: 0 },
    satirlar: [
      { id: 't1', sube_adi: 'Köyceğiz', tarih: bugunISO, asama: 'bekliyor', asama_metni: 'Merkezde sırada — depo yönlendirmesi bekleniyor', hedef_depo_sube_adi: null, kalemler: OPS_KALEM([['Süt 3.5%', 40], ['Karton bardak 8 oz', 2000]]), kalem_sayisi: 2040, personel_ad: 'Elif K.' },
      { id: 't2', sube_adi: 'Gazze', tarih: bugunISO, asama: 'bekliyor', asama_metni: 'Merkezde sırada — depo yönlendirmesi bekleniyor', hedef_depo_sube_adi: null, kalemler: OPS_KALEM([['Çekirdek harman', 12]]), kalem_sayisi: 12, personel_ad: 'Can D.' },
      { id: 't3', sube_adi: 'Alsancak', tarih: bugunISO, asama: 'depoda', asama_metni: 'Depoda hazırlanıyor', hedef_depo_sube_id: 's0', hedef_depo_sube_adi: 'Zafer', sevkiyat_durum: 'depoda_hazirlaniyor', kalemler: OPS_KALEM([['Süt 3.5%', 80], ['Vanilya şurup', 6], ['Peçete (paket)', 20]]), kalem_durumlari: [], kalem_sayisi: 106, personel_ad: 'Sude Y.' },
      { id: 't4', sube_adi: 'Köyceğiz', tarih: gunEkleISO(-1), asama: 'yolda', asama_metni: 'Depodan çıktı — talep şubesinde kabul bekleniyor', hedef_depo_sube_adi: 'Zafer', sevkiyat_ts: `${gunEkleISO(-1)} 18:30:00`, kalemler: OPS_KALEM([['Karton bardak 8 oz', 2400]]), kalem_sayisi: 2400 },
      { id: 't5', sube_adi: 'Gazze', tarih: gunEkleISO(-1), asama: 'toptanci_bekliyor', asama_metni: 'Toptancıya yönlendirildi — şube teslim alımı bekleniyor', hedef_depo_sube_adi: null, kalemler: OPS_KALEM([['Cheesecake (dilim)', 24]]), kalem_sayisi: 24 },
      { id: 't6', sube_adi: 'Alsancak', tarih: gunEkleISO(-2), asama: 'uyumsuzluk', asama_metni: 'Kabul uyumsuzluğu — merkez müdahalesi gerekli', hedef_depo_sube_adi: 'Zafer', kalemler: OPS_KALEM([['Süt 3.5%', 60]]), kalem_sayisi: 60 },
      { id: 't7', sube_adi: 'Zafer', tarih: gunEkleISO(-2), asama: 'tamamlandi', asama_metni: 'Teslim alındı (tamamlandı)', hedef_depo_sube_adi: 'Zafer', kalemler: OPS_KALEM([['Peçete (paket)', 30]]), kalem_sayisi: 30 },
    ],
  },
  '/api/ops/siparis/sevkiyat-listesi': {
    satirlar: [
      {
        id: 't3', sube_adi: 'Alsancak', tarih: bugunISO,
        hedef_depo_sube_id: 's0', hedef_depo_sube_adi: 'Zafer',
        sevkiyat_durum: 'depoda_hazirlaniyor', personel_ad: 'Sude Y.',
        kalemler: OPS_KALEM([['Süt 3.5%', 80], ['Vanilya şurup', 6], ['Peçete (paket)', 20]]),
        kalem_durumlari: [], sevkiyat_notu: '',
      },
      {
        id: 't8', sube_adi: 'Köyceğiz', tarih: bugunISO,
        hedef_depo_sube_id: 's0', hedef_depo_sube_adi: 'Zafer',
        sevkiyat_durum: 'kismi_hazirlandi', personel_ad: 'Elif K.',
        kalemler: OPS_KALEM([['Çekirdek harman', 20], ['Karton bardak 8 oz', 1200]]),
        kalem_durumlari: [{ urun_id: 'u0', urun_ad: 'Çekirdek harman', durum: 'kismi', gonderilen_adet: 12, not_aciklama: 'depoda 12 kg var' }],
        sevkiyat_notu: 'kalan çekirdek perşembe',
      },
    ],
  },
  '/api/ops/siparis/sevkiyat-guncelle': { ok: true },
  // Tedarik & Sinyal (ops-merkez P3 sekmeleri)
  '/api/ops/toptanci-teslimler': {
    gun: 14, toplam_sube: 2,
    subeler: [
      { sube_id: 's0', sube_adi: 'ZAFER', toplam: 4, son_tarih: bugunISO },
      { sube_id: 's1', sube_adi: 'KÖYCEĞİZ', toplam: 2, son_tarih: bugunISO },
    ],
  },
  '/api/ops/sube-notlar': {
    satirlar: [
      { id: 'n1', sube_adi: 'ZAFER', tarih: bugunISO, metin: 'Klima arızası, akşam serviste sıkıntı oldu.' },
      { id: 'n2', sube_adi: 'KÖYCEĞİZ', tarih: bugunISO, metin: '[YARIM_ISLEM_BILDIRIM] URUN_AC taslak olarak kaldı' },
    ],
  },
  '/api/ops/stok-tahmin': {
    gun: 14,
    tahminler: [
      { urun_ad: 'plastik kapak', ort_gunluk_tuketim: 126.9, gozlem_gun: 13, tahmin_7gun: 888.5, kalan_gun: 4 },
      { urun_ad: 'süt 3.5%', ort_gunluk_tuketim: 18.4, gozlem_gun: 12, tahmin_7gun: 128.8, kalan_gun: 12 },
    ],
  },
  '/api/ops/kpi-delta': {
    donem: 'ay', gun: 30,
    kpilar: [
      { anahtar: 'ciro', etiket: 'Ciro', simdi: 1172830, onceki: 1159635, delta_pct: 1.14, yon: 'iyi' },
      { anahtar: 'food_cost', etiket: 'Food cost', simdi: 34.2, onceki: 31.8, delta_pct: 7.5, yon: 'kotu' },
    ],
  },
  // Vardiya gün planlayıcı (yerli atama akışı)
  '/api/vardiya/v2/gun': {
    tarih: bugunISO, haftanin_gunu: 4,
    subeler: [
      {
        sube_id: 's0', sube_ad: 'ZAFER', atanan_benzersiz_kisi: 2,
        slotlar: [
          { slot: { id: 'sl1', ad: 'Sabah', baslangic_saat: '08:00:00', bitis_saat: '16:00:00', min_personel: 2, ideal_personel: 2 },
            atamalar: [{ id: 'at1', ad_soyad: 'Elif Kaya', kapanis: false }], atanan_personel: 1, eksik: 1 },
          { slot: { id: 'sl2', ad: 'Akşam · kapanış', baslangic_saat: '16:00:00', bitis_saat: '23:59:00', min_personel: 1, ideal_personel: 2 },
            atamalar: [{ id: 'at2', ad_soyad: 'Mert Can', kapanis: true }], atanan_personel: 1, eksik: 0 },
        ],
      },
      {
        sube_id: 's1', sube_ad: 'KÖYCEĞİZ', atanan_benzersiz_kisi: 0,
        slotlar: [
          { slot: { id: 'sl3', ad: 'Serbest', baslangic_saat: '10:30:00', bitis_saat: '23:59:00', min_personel: 0, ideal_personel: 1 },
            atamalar: [], atanan_personel: 0, eksik: 0 },
        ],
      },
    ],
  },
  '/api/vardiya/v2/atama/check': { cakisma_var: false, override_gerekir: false, uyarilar: [] },
  '/api/vardiya/v2/assign': { ok: true },
  '/api/vardiya/v2/gun-kopyala': { ok: true },
  '/api/vardiya/v2/gun-temizle': { ok: true },
  // Personel Denetimi (ops-merkez P2 sekmeleri)
  '/api/ops/personel-davranis-analiz': {
    gun_sayi: 45,
    personel_ozet: [
      { personel_id: 'pd1', personel_ad: 'Elif Kaya', sube_adi: 'ZAFER', vardiya_sayisi: 22, gecikme_dk: 18, kasa_fark: 0 },
      { personel_id: 'pd2', personel_ad: 'Mert Can', sube_adi: 'KÖYCEĞİZ', vardiya_sayisi: 19, gecikme_dk: 62, kasa_fark: -340 },
    ],
  },
  '/api/ops/sube-personel-puan': {
    personeller: [
      { personel_id: 'pp1', ad_soyad: 'DENİZ KÜÇÜKKIRLI', puan: 100, tamam: 34, gecikti: 0 },
      { personel_id: 'pp2', ad_soyad: 'Mert Can', puan: 68, tamam: 21, gecikti: 6 },
    ],
  },
  '/api/ops/gec-kalan-personel': {
    year_month: bugunISO.slice(0, 7), gecikme_dk: 5, kritik_dk: 15,
    toplam_personel: 6, gecikme_toplam_adet: 23, kritik_personel_sayisi: 2,
    satirlar: [
      { personel_id: 'g1', ad_soyad: 'Mert Can', sube_adi: 'KÖYCEĞİZ', gecikme_adet: 6, toplam_gecikme_dk: 62, kritik: true },
      { personel_id: 'g2', ad_soyad: 'Elif Kaya', sube_adi: 'ZAFER', gecikme_adet: 3, toplam_gecikme_dk: 18, kritik: false },
    ],
  },
  '/api/ops/kasa-acik-analiz': {
    personeller: [{ personel_id: 'ka1', ad_soyad: 'Mert Can', sube_adi: 'KÖYCEĞİZ', vardiya_sayisi: 19, toplam_fark: -340 }],
  },
  '/api/ops/kasiyer-karne': {
    karne: [
      { personel_id: 'kr1', ad_soyad: 'Elif Kaya', vardiya: 22, temiz: 22 },
      { personel_id: 'kr2', ad_soyad: 'Mert Can', vardiya: 19, temiz: 16 },
    ],
  },
  // Merkez Denetim (ops-merkez P1 sekmeleri)
  '/api/ops/urun-uyumsuzluk': {
    tarih: bugunISO, gun_toplam: 2, gun_bekleyen: 1, gun_cozuldu: 1,
    liste: [
      { id: 'u1', sube_adi: 'ZAFER', tip: 'URUN_AC_UYUMSUZLUK', urun_ad: 'Plastik bardak', fark: -18, cozuldu: false },
      { id: 'u2', sube_adi: 'KÖYCEĞİZ', tip: 'SAYIM_FARK', urun_ad: 'Süt 3.5%', fark: 4, cozuldu: true },
    ],
  },
  '/api/ops/fire-bildirimler': {
    tarih: bugunISO, gun_toplam: 1, toplam_adet_gun: 3,
    kayitlar: [{ id: 'f1', sube_ad: 'ZAFER', tarih: bugunISO, urun_ad: 'Cheesecake', adet: 3, sebep: 'son kullanma' }],
    son_kayitlar: [],
  },
  '/api/ops/gider-fis-bekleyen': {
    kayitlar: [
      { id: 'g1', aciklama: 'Market alışverişi', tarih: bugunISO, sube_adi: 'MERKEZ', tutar: 1240 },
      { id: 'g2', aciklama: 'Kargo ödemesi', tarih: bugunISO, sube_adi: 'ZAFER', tutar: 380 },
    ],
  },
  '/api/ops/kontrol-ozet': {
    subeler: [
      { sube_id: 's0', sube_adi: 'ZAFER', tamam: 8, toplam: 8 },
      { sube_id: 's1', sube_adi: 'KÖYCEĞİZ', tamam: 6, toplam: 8 },
    ],
  },
  '/api/ops/stok-kayip-analiz': {
    kalemler: [{ id: 'k1', kalem_adi: 'Plastik bardak', sube_adi: 'ZAFER', kayip: 698, not: 'kayıtsız çıkış şüphesi' }],
  },
  // Bar Akışı (ops-merkez P0 sekmeleri)
  '/api/ops/acilis-kasa-takip': {
    tarih: bugunISO, is_gunu_tr: bugunISO,
    satirlar: [
      { sube_id: 's0', sube_adi: 'ZAFER', acilis_durum: 'tamam', acilis_tamam: true, acilis_ts: bugunISO + ' 08:12:00', personel_ad: 'Elif Kaya', acilis_kasa_tl: 3200, beklenen_devir_tl: 3200, fark_tl: 0 },
      { sube_id: 's1', sube_adi: 'KÖYCEĞİZ', acilis_durum: 'tamam', acilis_tamam: true, acilis_ts: bugunISO + ' 08:41:00', personel_ad: 'Mert Can', acilis_kasa_tl: 2800, beklenen_devir_tl: 3000, fark_tl: -200 },
      { sube_id: 's2', sube_adi: 'ALSANCAK', acilis_durum: 'bekliyor', acilis_tamam: false, acilis_ts: '', personel_ad: '', acilis_kasa_tl: null, beklenen_devir_tl: null, fark_tl: null },
    ],
  },
  '/api/ops/kapanis-takip': {
    tarih: bugunISO, kapanis_son_teslim_saat: 2,
    satirlar: [
      { sube_id: 's0', sube_adi: 'ZAFER', acildi: true, kapanis_tamam: true, kapanis_ts: bugunISO + ' 23:48:00', kapanis_personel: 'Elif Kaya', kasa_sayim: 21400, devir: 3200, teslim_kasa_tl: 18200, taslak_var: true, taslak_durum: 'onay bekliyor' },
      { sube_id: 's1', sube_adi: 'KÖYCEĞİZ', acildi: true, kapanis_tamam: true, kapanis_ts: bugunISO + ' 23:12:00', kapanis_personel: 'Mert Can', kasa_sayim: 15600, devir: 3000, teslim_kasa_tl: 0, taslak_var: false, taslak_durum: '' },
      { sube_id: 's2', sube_adi: 'ALSANCAK', acildi: false, kapanis_tamam: false, kapanis_ts: '', kapanis_personel: '', kasa_sayim: 0, devir: 0, teslim_kasa_tl: 0, taslak_var: false, taslak_durum: '' },
    ],
  },
  '/api/ops/v2/urun-ac-akis': {
    tarih: bugunISO, toplam_islem: 3, toplam_adet: 14,
    kayitlar: [
      { id: 'ua1', sube_adi: 'ZAFER', zaman: bugunISO + ' 09:20:00', personel_ad: 'Elif Kaya', urun_ad: 'Süt 3.5%', adet: 6 },
      { id: 'ua2', sube_adi: 'ZAFER', zaman: bugunISO + ' 13:05:00', personel_ad: 'Elif Kaya', urun_ad: 'Plastik bardak', adet: 5 },
      { id: 'ua3', sube_adi: 'KÖYCEĞİZ', zaman: bugunISO + ' 15:40:00', personel_ad: 'Mert Can', urun_ad: 'Karamel şurup', adet: 3 },
    ],
  },
  '/api/ops/bar-ozet': {
    satirlar: [
      { sube_id: 's0', sube_adi: 'ZAFER', tarih: bugunISO, kapanis_gercek: true, satilan: { bardak_kucuk: 48, bardak_buyuk: 62, bardak_plastik: 35, sut_litre: 18, su_adet: 22 } },
      { sube_id: 's1', sube_adi: 'KÖYCEĞİZ', tarih: bugunISO, kapanis_gercek: false, satilan: { bardak_kucuk: 31, bardak_buyuk: 44, bardak_plastik: 19, sut_litre: 12, su_adet: 14 } },
    ],
  },
  '/api/ops/subeler/depolar': { satirlar: [{ id: 's1', ad: 'Zafer (Merkez Depo)' }, { id: 's2', ad: 'Köyceğiz' }] },
  '/api/kasa-teslim-alici': { alicilar: [{ id: 'a1', ad: 'Fethi Bey', unvan: 'sahip', sube_id: '', sube_adi: '' }, { id: 'a2', ad: 'Ayşe Hanım', unvan: 'muhasebe', sube_id: 's1', sube_adi: 'Zafer' }] },
  '/api/ops/siparis/sevkiyata-gonder': { ok: true },
  '/api/ops/bulgu-izi': { ok: true, id: 'iz1' },
  '/api/import-izi': {
    kayitlar: [
      { dosya_adi: 'garanti_ekstre_temmuz.xlsx', kaynak: 'excel-import', toplam_eklenen: 142, hata_sayisi: 3, detay: { ciro: { eklenen: 142, hata: 3 } }, olusturma: `${gunEkleISO(-1)} 21:14` },
      { dosya_adi: 'pos_haziran.xlsx', kaynak: 'excel-import', toplam_eklenen: 96, hata_sayisi: 0, detay: {}, olusturma: `${gunEkleISO(-12)} 18:02` },
    ],
    toplam: 2,
  },
  '/api/ops/vade-disiplini': {
    kesit_gun: 90, odenen_plan: 42, ort_gecikme_gun: 1.8,
    erken: 9, zamaninda: 21, hafif_gec: 8, gec: 4, gec_orani_yuzde: 9.5,
    en_gecler: [
      { aciklama: 'KOC FINANS ARAC — Kredi taksiti', vade: gunEkleISO(-27), odeme: gunEkleISO(-24), gecikme_gun: 3, tutar: 208116 },
      { aciklama: 'Sütaş Bölge Dağıtım', vade: gunEkleISO(-9), odeme: gunEkleISO(-3), gecikme_gun: 6, tutar: 41250 },
    ],
    not: 'GÖZLEMDİR',
  },
  '/api/ops/bulgu-izi/ozet': {
    kesit_gun: 30, isaretli_bulgu: 9, goruldu: 2, cozulen: 6, yanlis_alarm: 1,
    yanlis_alarm_orani_yuzde: 14.3, ort_cozum_saat: 4.2,
    isaretli_refler: [{ ref: `truth:s3:${bugunISO}:UYUMLU`, karar: 'cozuldu' }],
    not: 'append-only',
  },
  '/api/ops/para-yolda': {
    kesit_gun: 14, kapanis_adet: 38, eslesen_adet: 35, bekleyen_adet: 3, gecikmis_adet: 1,
    ort_teslim_saat: 13.4, medyan_teslim_saat: 12.1,
    bekleyenler: [
      { sube: 'Köyceğiz', tarih: gunEkleISO(-2), kapanis_saat: '23:41', gecen_saat: 39.2, gecikmis: true, beklenen_tutar: 18400 },
      { sube: 'Zafer', tarih: gunEkleISO(-1), kapanis_saat: '23:52', gecen_saat: 11.6, gecikmis: false, beklenen_tutar: 31200 },
      { sube: 'Gazze', tarih: bugunISO, kapanis_saat: '00:14', gecen_saat: 9.8, gecikmis: false, beklenen_tutar: null },
    ],
    not: 'GÖZLEMDİR',
  },
  '/api/ops/siparis/sevkiyat-hiz': {
    kesit_gun: 30, teslim_adet: 14, ort_saat: 6.4, medyan_saat: 5.2,
    hazirlik_ort_saat: 3.1, yol_ort_saat: 2.8,
    depolar: [
      { depo_adi: 'Zafer', teslim: 11, ort_saat: 5.8 },
      { depo_adi: 'Köyceğiz', teslim: 3, ort_saat: 9.6 },
    ],
    son_teslimler: [],
    not: 'GÖZLEMDİR',
  },
  '/api/ops/siparis/sevkiyat-subeler-ozet': {
    satirlar: [
      { depo_sube_id: 's0', depo_sube_adi: 'Zafer', sube_tipi: 'depo', toplam: 9, hazirlikta: 2, gonderildi: 1, teslim_edildi: 6, son_talep_tarih: bugunISO },
      { depo_sube_id: 's1', depo_sube_adi: 'Köyceğiz', sube_tipi: 'normal', toplam: 2, hazirlikta: 0, gonderildi: 0, teslim_edildi: 2, son_talep_tarih: gunEkleISO(-6) },
      { depo_sube_id: 's2', depo_sube_adi: 'Gazze', sube_tipi: 'normal', toplam: 0, hazirlikta: 0, gonderildi: 0, teslim_edildi: 0, son_talep_tarih: null },
    ],
  },
  '/api/ops/depo-stok': {
    subeler: SUBELER.map((s, i) => ({ id: `s${i}`, ad: s })),
    kalemler: [
      { kalem_kodu: 'k1', kalem_adi: 'Yeşil çekirdek (harman)', kategori: 'Kahve', min_stok: 40, adetler: { s0: 8, s1: 2, s2: 1, s3: 1 }, toplam: 12 },
      { kalem_kodu: 'k2', kalem_adi: 'Karton bardak 8 oz', kategori: 'Ambalaj', min_stok: 8000, adetler: { s0: 4000, s1: 1200, s2: 800, s3: 400 }, toplam: 6400 },
      { kalem_kodu: 'k3', kalem_adi: 'Süt 3.5%', kategori: 'Süt & Krema', min_stok: 180, adetler: { s0: 180, s1: 60, s2: 50, s3: 30 }, toplam: 320 },
      { kalem_kodu: 'k4', kalem_adi: 'Vanilya şurup', kategori: 'Şurup', min_stok: 8, adetler: { s0: 8, s1: 3, s2: 2, s3: 1 }, toplam: 14 },
      { kalem_kodu: 'k5', kalem_adi: 'Peçete (paket)', kategori: 'Sarf', min_stok: 15, adetler: { s0: 22, s1: 8, s2: 6, s3: 4 }, toplam: 40 },
    ],
  },
  '/api/stok-sayim/bekleyen-onay': {
    toplam: 2,
    gorevler: [
      { id: 'g1', sube_adi: 'Zafer', personel_ad: 'Okan B.', mod: 'KONTROL', kapsam_tip: 'bardak', kalem_sayisi: 8, fark_sayisi: 5, tamamlama_ts: `${gunEkleISO(-1)} 23:40:00` },
      { id: 'g2', sube_adi: 'Gazze', personel_ad: 'Elif K.', mod: 'KONTROL', kapsam_tip: 'tam', kalem_sayisi: 14, fark_sayisi: 0, tamamlama_ts: `${bugunISO} 09:10:00` },
    ],
  },
  '/api/stok-sayim/duzeltme-iz': {
    toplam_iz: 12, ezilen_kalem: 3, degismeyen: 9, karar_sayim: 10, karar_sistem: 2, toplam_mutlak_delta: 46,
    ornekler: [
      { sube_id: 's0', kalem_adi: 'Karton bardak 8 oz', eski_adet: 4200, sayilan_adet: 4160, yeni_adet: 4160, delta: -40, karar: 'sayim', olusturma: `${gunEkleISO(-1)} 23:52:00` },
      { sube_id: 's0', kalem_adi: 'Yeşil çekirdek (harman)', eski_adet: 14, sayilan_adet: 12, yeni_adet: 12, delta: -2, karar: 'sayim', olusturma: `${gunEkleISO(-1)} 23:51:00` },
      { sube_id: 's2', kalem_adi: 'Vanilya şurup', eski_adet: 2, sayilan_adet: 6, yeni_adet: 2, delta: 0, karar: 'sistem', olusturma: `${gunEkleISO(-3)} 22:14:00` },
    ],
  },
  '/api/stok-sayim/gorev/g1': {
    id: 'g1', sube_adi: 'Zafer', personel_ad: 'Okan B.', mod: 'KONTROL', kapsam_tip: 'bardak',
    durum: 'tamamlandi', not_aciklama: 'küçük boy bardak kolisi açılmamıştı, saydım',
    tamamlama_ts: `${gunEkleISO(-1)} 23:40:00`,
    satirlar: [
      { kalem_kodu: 'k2', kalem_adi: 'Karton bardak 8 oz', sistem_adet: 4200, sayilan_adet: 4160, fark: -40 },
      { kalem_kodu: 'k1', kalem_adi: 'Yeşil çekirdek (harman)', sistem_adet: 14, sayilan_adet: 12, fark: -2 },
      { kalem_kodu: 'k3', kalem_adi: 'Süt 3.5%', sistem_adet: 180, sayilan_adet: 180, fark: 0 },
      { kalem_kodu: 'k4', kalem_adi: 'Vanilya şurup', sistem_adet: 8, sayilan_adet: 9, fark: 1 },
      { kalem_kodu: 'k5', kalem_adi: 'Peçete (paket)', sistem_adet: 22, sayilan_adet: 22, fark: 0 },
    ],
  },
  '/api/stok-sayim/gorev/g2': {
    id: 'g2', sube_adi: 'Gazze', personel_ad: 'Elif K.', mod: 'KONTROL', kapsam_tip: 'tam',
    durum: 'tamamlandi', not_aciklama: '',
    tamamlama_ts: `${bugunISO} 09:10:00`,
    satirlar: [
      { kalem_kodu: 'k3', kalem_adi: 'Süt 3.5%', sistem_adet: 50, sayilan_adet: 50, fark: 0 },
      { kalem_kodu: 'k5', kalem_adi: 'Peçete (paket)', sistem_adet: 6, sayilan_adet: 6, fark: 0 },
    ],
  },
  '/api/ops/stok-hareketleri': {
    satirlar: [
      { id: 'h1', zaman: `${bugunISO} 08:40:00`, sube_ad: 'Zafer', kalem_adi: 'Yeşil çekirdek (harman)', hareket_turu: 'GIRIS', miktar: 120, onceki_miktar: 12, sonraki_miktar: 132, kaynak_tip: 'toptanci_kabul', personel_ad: 'Okan B.' },
      { id: 'h2', zaman: `${bugunISO} 08:15:00`, sube_ad: 'Zafer', kalem_adi: 'Süt 3.5%', hareket_turu: 'GIRIS', miktar: 400, onceki_miktar: 180, sonraki_miktar: 580, kaynak_tip: 'toptanci_kabul', personel_ad: 'Okan B.' },
      { id: 'h3', zaman: `${gunEkleISO(-1)} 18:30:00`, sube_ad: 'Zafer', kalem_adi: 'Süt 3.5%', hareket_turu: 'SEVK_CIKIS', miktar: -80, onceki_miktar: 260, sonraki_miktar: 180, kaynak_tip: 'sevkiyat', personel_ad: 'Okan B.' },
      { id: 'h4', zaman: `${gunEkleISO(-1)} 21:05:00`, sube_ad: 'Köyceğiz', kalem_adi: 'Cheesecake (dilim)', hareket_turu: 'FIRE', miktar: -6, onceki_miktar: 22, sonraki_miktar: 16, kaynak_tip: 'fire_kaydi', personel_ad: 'Can D.' },
      { id: 'h5', zaman: `${gunEkleISO(-1)} 23:52:00`, sube_ad: 'Zafer', kalem_adi: 'Karton bardak 8 oz', hareket_turu: 'SAYIM_DUZELTME', miktar: -40, onceki_miktar: 4200, sonraki_miktar: 4160, kaynak_tip: 'stok_sayim', personel_ad: 'Okan B.' },
    ],
  },
};

// ── Maliyet modülü sahte verisi ─────────────────────────────────────────────
const MALIYET_GUNLER = (() => {
  const out = [];
  for (let g = 29; g >= 0; g--) {
    const d = new Date(); d.setDate(d.getDate() - g);
    const t = d.toISOString().slice(0, 10);
    const ciro = 82000 + Math.sin(g / 3) * 9000;
    const fc = 0.30 + (g < 8 ? 0.04 : 0) + Math.sin(g / 5) * 0.015; // son hafta norm üstü
    out.push({ tarih: t, sube_adi: 'Zafer', sube_id: 's0', ciro_tl: Math.round(ciro), teorik_maliyet_tl: Math.round(ciro * fc * 0.96), gercek_maliyet_tl: Math.round(ciro * fc), food_cost_pct: Math.round(fc * 1000) / 10, shrinkage_tl: g % 6 === 0 ? 1400 : 0 });
  }
  return out;
})();
const MALIYET_UC = {
  '/api/ops/maliyet/ozet': {
    alis_fiyat_sayisi: 41, recete_sayisi: 75, stok_degeri_tl: 284600,
    gun_satirlari: MALIYET_GUNLER,
  },
  '/api/ops/maliyet/recete-listesi': {
    receteler: [
      { urun_id: 'latte', urun_adi: 'Latte', hammaddeler: [
        { hammadde_kodu: 'k3', hammadde_adi: 'Süt 3.5%', miktar: 0.25, birim: 'L' },
        { hammadde_kodu: 'k1', hammadde_adi: 'Espresso çekirdek', miktar: 0.018, birim: 'kg' },
        { hammadde_kodu: 'k2', hammadde_adi: 'Karton bardak 8 oz', miktar: 1, birim: 'adet' },
      ]},
      { urun_id: 'filtre', urun_adi: 'Filtre Kahve', hammaddeler: [
        { hammadde_kodu: 'k1', hammadde_adi: 'Espresso çekirdek', miktar: 0.02, birim: 'kg' },
        { hammadde_kodu: 'k2', hammadde_adi: 'Karton bardak 8 oz', miktar: 1, birim: 'adet' },
      ]},
      { urun_id: 'vanilya-latte', urun_adi: 'Vanilya Latte', hammaddeler: [
        { hammadde_kodu: 'k3', hammadde_adi: 'Süt 3.5%', miktar: 0.25, birim: 'L' },
        { hammadde_kodu: 'k1', hammadde_adi: 'Espresso çekirdek', miktar: 0.018, birim: 'kg' },
        { hammadde_kodu: 'k9', hammadde_adi: 'Vanilya şurup', miktar: 0.03, birim: 'L' },
      ]},
    ],
    toplam: 3,
  },
  '/api/ops/maliyet/alis-fiyatlari': {
    satirlar: [
      { id: 'f1', kalem_kodu: 'k3', kalem_adi: 'Süt 3.5%', birim: 'L', birim_maliyet_tl: 46, gecerli_baslangic: gunEkleISO(-10), gecerli_bitis: null, tedarikci: 'Sütaş' },
      { id: 'f2', kalem_kodu: 'k1', kalem_adi: 'Espresso çekirdek', birim: 'kg', birim_maliyet_tl: 940, gecerli_baslangic: gunEkleISO(-30), gecerli_bitis: null, tedarikci: 'Kahve Dünyası' },
      { id: 'f3', kalem_kodu: 'k2', kalem_adi: 'Karton bardak 8 oz', birim: 'adet', birim_maliyet_tl: 3.8, gecerli_baslangic: gunEkleISO(-20), gecerli_bitis: null, tedarikci: 'Paper Cup Co.' },
      // k9 vanilya şurup BİLEREK fiyatsız — "fiyatsız hammadde" riski test edilsin
    ],
    toplam: 3,
  },
  '/api/ops/fiyat-zam-alarmlari': {
    esik_yuzde: 15,
    alarmlar: [
      { id: 'z1', kalem_kodu: 'k3', kalem_adi: 'Süt 3.5%', tedarikci: 'Sütaş', eski_fiyat: 42, yeni_fiyat: 46, artis_yuzde: 9.5, goruldu: false, olusturma: `${gunEkleISO(-10)} 09:12` },
      { id: 'z2', kalem_kodu: 'k1', kalem_adi: 'Espresso çekirdek', tedarikci: 'Kahve Dünyası', eski_fiyat: 720, yeni_fiyat: 940, artis_yuzde: 30.6, goruldu: false, olusturma: `${gunEkleISO(-30)} 14:40` },
      { id: 'z3', kalem_kodu: 'k2', kalem_adi: 'Karton bardak 8 oz', tedarikci: 'Paper Cup Co.', eski_fiyat: 3.1, yeni_fiyat: 3.8, artis_yuzde: 22.6, goruldu: true, olusturma: `${gunEkleISO(-20)} 11:05` },
    ],
    toplam: 3,
  },
  '/api/ops/fiyat-zam-alarmlari/goruldu': { success: true },
  // Reçete eşleştirme (v2 yerli onay ekranı — köprü kaldırma turu)
  '/api/recete/eslestirmeler': {
    eslestirmeler: [
      { id: 'e1', tip: 'urun', kaynak_ad: 'ice cookie latte', hedef_ad: 'Cookie Latte Ice', benzerlik: 1.0, durum: 'oneri' },
      { id: 'e2', tip: 'urun', kaynak_ad: 'mocha 8 oz', hedef_ad: 'White Mocha 8 Oz', benzerlik: 0.75, durum: 'oneri' },
      { id: 'e3', tip: 'malzeme', kaynak_ad: 'kakao tozu', hedef_ad: 'Kakao', hedef_kod: 'STK-KAKAO', benzerlik: 0.66, durum: 'oneri' },
      { id: 'e4', tip: 'urun', kaynak_ad: 'espresso', hedef_ad: 'Espresso', benzerlik: 1.0, durum: 'onayli' },
      { id: 'e5', tip: 'urun', kaynak_ad: 'ice latte', hedef_ad: 'Latte Ice', benzerlik: 1.0, durum: 'onayli' },
      { id: 'e6', tip: 'malzeme', kaynak_ad: 'sut', hedef_ad: 'Süt 3.5%', hedef_kod: 'STK-SUT', benzerlik: 1.0, durum: 'onayli' },
    ],
  },
  '/api/recete/eslestirme-adaylar': {
    recete_urunler: ['Taro Latte', 'Pop Latte', 'Velvet Latte', 'Madagaskar Latte'],
    recete_malzemeler: ['taro tozu', 'kakao tozu', 'madagaskar vanilya'],
    evo_adlar: ['Taro Latte 14 Oz', 'Pop Latte Ice', 'RED VELVET', 'Espresso'],
    depo_kalemler: [{ kalem_kodu: 'STK-TARO', kalem_adi: 'Taro Tozu' }, { kalem_kodu: 'STK-KAKAO', kalem_adi: 'Kakao' }],
  },
  '/api/recete/eslestirme-karar': { ok: true },
  '/api/recete/eslestirme-ekle': { ok: true },
  '/api/recete/eslestirme-oner': { ok: true, yeni_oneri: 3 },
  '/api/recete/kontrol': {
    kesit_gun: 7, onayli_urun_es: 42, onayli_malzeme_es: 18,
    kiyas: [
      // SÜT: kalıcı tek yönlü fazla kullanım (3 gün +%18..%24) — kırmızı senaryo
      { malzeme: 'süt', birim: 'ml', gun: gunEkleISO(-3), beklenen_miktar: 41200, gercek_miktar: 48700, fark: 7500, fark_yuzde: 18.2, kaynak: 'bar_sayim_devirli' },
      { malzeme: 'süt', birim: 'ml', gun: gunEkleISO(-2), beklenen_miktar: 39800, gercek_miktar: 49300, fark: 9500, fark_yuzde: 23.9, bildirilen_fire: 1000, fark_fire_sonrasi: 8500, fark_yuzde_fire_sonrasi: 21.4 },
      { malzeme: 'süt', birim: 'ml', gun: gunEkleISO(-1), beklenen_miktar: 44100, gercek_miktar: 52600, fark: 8500, fark_yuzde: 19.3, kapanis_gecici: true },
      // ÇEKİRDEK: uyumlu — yeşil senaryo
      { malzeme: 'espresso çekirdek', birim: 'g', gun: gunEkleISO(-3), beklenen_miktar: 6100, gercek_miktar: 6300, fark: 200, fark_yuzde: 3.3 },
      { malzeme: 'espresso çekirdek', birim: 'g', gun: gunEkleISO(-2), beklenen_miktar: 5900, gercek_miktar: 5750, fark: -150, fark_yuzde: -2.5 },
      { malzeme: 'espresso çekirdek', birim: 'g', gun: gunEkleISO(-1), beklenen_miktar: 6400, gercek_miktar: 6550, fark: 150, fark_yuzde: 2.3, ambalaj_varsayim: true },
      // VANİLYA ŞURUP: ambalaj tanımsız — dürüst boşluk senaryosu
      { malzeme: 'vanilya şurup', birim: 'ml', gun: gunEkleISO(-2), beklenen_miktar: 840, acilan_ambalaj: 2, fark: null, eksik: 'ambalaj_icerigi_tanimsiz' },
      { malzeme: 'vanilya şurup', birim: 'ml', gun: gunEkleISO(-1), beklenen_miktar: 910, acilan_ambalaj: 1, fark: null, eksik: 'ambalaj_icerigi_tanimsiz' },
      // BARDAK: tek gün fazla — amber senaryo
      { malzeme: 'karton bardak 8 oz', birim: 'adet', gun: gunEkleISO(-2), beklenen_miktar: 1180, gercek_miktar: 1420, fark: 240, fark_yuzde: 20.3 },
      { malzeme: 'karton bardak 8 oz', birim: 'adet', gun: gunEkleISO(-1), beklenen_miktar: 1240, gercek_miktar: 1265, fark: 25, fark_yuzde: 2.0 },
    ],
    not: 'GÖZLEMDİR, hüküm değil.',
  },
};

// ── Personel & Vardiya modülü sahte verisi ──────────────────────────────────
const PERSONEL = [
  { id: 'e1', ad_soyad: 'Elif Kaya', gorev: 'barista', sube_id: 's0', sube_adi: 'Zafer', calisma_turu: 'surekli', maas: 31200, baslangic_tarihi: '2025-01-10', aktif: true },
  { id: 'e2', ad_soyad: 'Mert Solak', gorev: 'barista', sube_id: 's0', sube_adi: 'Zafer', calisma_turu: 'surekli', maas: 29800, baslangic_tarihi: '2025-09-01', aktif: true },
  { id: 'e3', ad_soyad: 'Zeynep Ar', gorev: 'vardiya sorumlusu', sube_id: 's1', sube_adi: 'Köyceğiz', calisma_turu: 'surekli', maas: 38400, baslangic_tarihi: '2024-06-15', aktif: true },
  { id: 'e4', ad_soyad: 'Can Demir', gorev: 'barista', sube_id: 's2', sube_adi: 'Gazze', calisma_turu: 'surekli', maas: 28600, baslangic_tarihi: '2026-04-02', aktif: true },
  { id: 'e5', ad_soyad: 'Sude Yalın', gorev: 'barista', sube_id: 's3', sube_adi: 'Alsancak', calisma_turu: 'part', maas: 0, saatlik_ucret: 190, baslangic_tarihi: '2026-06-20', aktif: true },
  { id: 'e6', ad_soyad: 'Okan Bal', gorev: 'depo & sevk', sube_id: null, sube_adi: null, calisma_turu: 'surekli', maas: 34000, baslangic_tarihi: '2023-12-01', aktif: true },
];

const TAKIP = PERSONEL.map((p, i) => ({
  personel_id: p.id, ad_soyad: p.ad_soyad, calisma_turu: p.calisma_turu, aktif: true,
  toplam_planlanan_saat: [176, 168, 184, 192, 160, 180][i],
  toplam_gecikme_dk: [0, 6, 0, 42, 0, 0][i],
  toplam_fazla_mesai_saat: [0, 0, 2, 14, 0, 1][i],
}));

const BORDRO = PERSONEL.map((p, i) => ({
  personel_id: p.id, ad_soyad: p.ad_soyad, gorev: p.gorev, maas: p.maas,
  calisma_saati: [176, 168, 184, 192, 160, 180][i],
  fazla_mesai_saat: [0, 0, 2, 14, 0, 1][i],
  avans_mahsup: [4000, 0, 0, 0, 0, 0][i],
  mahsup_devir: 0, eksik_gun: 0, manuel_duzeltme: 0, not_aciklama: null,
  hesaplanan_net: [26480, 25640, 33100, 28940, 22800, 29180][i],
  durum: ['onayli', 'onayli', 'taslak', 'taslak', 'taslak', 'odendi'][i],
}));

const HAFTA_PZT = (() => {
  const d = new Date(bugunISO + 'T00:00:00Z');
  const g = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (g === 0 ? -6 : 1 - g));
  return d.toISOString().slice(0, 10);
})();
const HAFTA_GUNLER = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(HAFTA_PZT + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
});

const EKIP_UC = {
  '/api/personel': PERSONEL,
  '/api/gorev/vardiya-takip': TAKIP,
  '/api/gorev/izin-alacagi': {
    baslangic: gunEkleISO(-60), bitis: bugunISO,
    personeller: [
      { personel_id: 'p1', ad_soyad: 'AYŞENAZ DAL', borclu_hafta_sayisi: 0, verilen_izin_gun: 1, net_alacak_gun: 0, izinler: [], borclu_haftalar: [] },
      { personel_id: 'p2', ad_soyad: 'MEHMET YILMAZ', borclu_hafta_sayisi: 2, verilen_izin_gun: 0, net_alacak_gun: 2, izinler: [], borclu_haftalar: [] },
    ],
  },
  '/api/gorev/yoklama': [],
  '/api/personel-aylik': BORDRO,
  '/api/avans/ozet': { toplam: 4000, adet: 1 },
  // Son köprü turu (2026-07-30): QR + konum artık v2-yerlisi
  '/api/gorev/qr-liste': SUBELER.map((ad, i) => ({
    sube_id: `s${i}`, sube_ad: ad,
    qr_url: `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="#fff"/><text x="90" y="95" text-anchor="middle" font-size="14">QR</text></svg>')}`,
    giris_url: `https://ornek/gorev-giris/s${i}`,
  })),
  '/api/subeler': SUBELER.map((ad, i) => ({
    id: `s${i}`, ad, aktif: true,
    lat: i < 2 ? 37.12 + i / 100 : null,
    lng: i < 2 ? 28.98 + i / 100 : null,
    konum_radius_m: 150,
  })),
  '/api/vardiya/v2/hafta-sube-tablo': {
    pazartesi: HAFTA_PZT, pazar: HAFTA_GUNLER[6], gunler: HAFTA_GUNLER,
    subeler: SUBELER.map((ad, si) => ({
      sube_id: `s${si}`, sube_ad: ad,
      gunler: Object.fromEntries(HAFTA_GUNLER.map((g, gi) => {
        // Alsancak cumartesi akşamı BOŞ — tasarımdaki "açık slot" durumu
        if (si === 3 && gi === 5) return [g, []];
        if (si === 2 && gi === 6) return [g, []];
        const kisi = PERSONEL.filter(p => p.sube_id === `s${si}`).map(p => ({
          ad_soyad: p.ad_soyad, gorev: p.gorev,
          saat: gi % 2 ? '07:30-16:00' : '15:00-23:30',
          kapanis: gi % 2 === 0,
        }));
        return [g, kisi];
      })),
      toplam_atama: 0,
    })),
  },
  '/api/gorev/ozet': [
    { sube_id: 's0', sube_adi: 'Zafer', vardiya_tip: 'acilis', toplam: 12, tamamlanan: 12 },
    { sube_id: 's0', sube_adi: 'Zafer', vardiya_tip: 'kapanis', toplam: 8, tamamlanan: 7 },
    { sube_id: 's1', sube_adi: 'Köyceğiz', vardiya_tip: 'acilis', toplam: 12, tamamlanan: 12 },
    { sube_id: 's1', sube_adi: 'Köyceğiz', vardiya_tip: 'kapanis', toplam: 8, tamamlanan: 8 },
    { sube_id: 's2', sube_adi: 'Gazze', vardiya_tip: 'acilis', toplam: 12, tamamlanan: 6 },
    { sube_id: 's2', sube_adi: 'Gazze', vardiya_tip: 'kapanis', toplam: 8, tamamlanan: 2 },
    { sube_id: 's3', sube_adi: 'Alsancak', vardiya_tip: 'acilis', toplam: 12, tamamlanan: 11 },
    { sube_id: 's3', sube_adi: 'Alsancak', vardiya_tip: 'kapanis', toplam: 8, tamamlanan: 8 },
  ],
  '/api/is-basvurusu': [
    { id: 'bv1', ad_soyad: 'Deniz Yücel', pozisyon: 'barista', sube_tercihi: 'Gazze', deneyim: '2 yıl deneyim', durum: 'yeni', oncelik: 1, olusturma: '2026-07-27' },
    { id: 'bv2', ad_soyad: 'Baran Aksoy', pozisyon: 'depo & sevk', sube_tercihi: 'Alsancak', deneyim: 'B sınıfı ehliyet', durum: 'yeni', oncelik: 0, olusturma: '2026-07-28' },
    { id: 'bv3', ad_soyad: 'Selin Koç', pozisyon: 'barista', sube_tercihi: 'Zafer', deneyim: 'referans olumlu', durum: 'görüşme', oncelik: 0, olusturma: '2026-07-24' },
  ],
  '/api/sube-panel/merkez/personel-panel-pin': PERSONEL.map((p, i) => ({
    id: p.id, ad_soyad: p.ad_soyad, sube_id: p.sube_id, sube_adi: p.sube_adi,
    aktif: true, yonetici: i === 2, panel_pin_tanimli: i !== 4,
  })),
};

// ── Küçük modüller (onaylar / yük / rapor / sistem / tanım) sahte verisi ────
const KUCUK_UC = {
  '/api/borclar': [
    { id: 'kr1', kurum: 'Ziraat — İşletme Kredisi', borc_turu: 'isletme', toplam_borc: 486000, aylik_taksit: 32400, kalan_vade: 15, toplam_vade: 36, baslangic_tarihi: '2024-05-01', odeme_gunu: 5, aktif: true },
    { id: 'kr2', kurum: 'Halkbank — Taşıt', borc_turu: 'tasit', toplam_borc: 128400, aylik_taksit: 12800, kalan_vade: 10, toplam_vade: 24, baslangic_tarihi: '2025-09-01', odeme_gunu: 12, aktif: true },
    { id: 'kr3', kurum: 'KOSGEB', borc_turu: 'destek', toplam_borc: 240000, aylik_taksit: 0, kalan_vade: 48, toplam_vade: 48, baslangic_tarihi: '2026-01-01', odeme_gunu: 20, aktif: true },
  ],
  '/api/sabit-giderler': [
    { id: 'sg1', gider_adi: 'Zafer kira', kategori: 'kira', tutar: 96000, periyot: 'aylik', odeme_gunu: 1, sube_adi: 'Zafer', odeme_yontemi: 'havale', aktif: true, bu_ay_odendi: true },
    { id: 'sg2', gider_adi: 'Köyceğiz kira', kategori: 'kira', tutar: 62000, periyot: 'aylik', odeme_gunu: 1, sube_adi: 'Köyceğiz', odeme_yontemi: 'havale', aktif: true, bu_ay_odendi: true },
    { id: 'sg3', gider_adi: 'Elektrik', kategori: 'enerji', tutar: 0, periyot: 'aylik', odeme_gunu: 15, sube_adi: null, odeme_yontemi: 'otomatik', aktif: true, bu_ay_odendi: false },
    { id: 'sg4', gider_adi: 'İnternet & POS hattı', kategori: 'abonelik', tutar: 4800, periyot: 'aylik', odeme_gunu: 8, sube_adi: null, odeme_yontemi: 'otomatik', aktif: true, bu_ay_odendi: false },
    { id: 'sg5', gider_adi: 'Muhasebe', kategori: 'hizmet', tutar: 14000, periyot: 'aylik', odeme_gunu: 10, sube_adi: null, odeme_yontemi: 'havale', aktif: true, bu_ay_odendi: false },
  ],
  '/api/rapor/aylik': {
    donem: bugunISO.slice(0, 7),
    trend12: [
      { ay: '2026-02', ay_kisa: 'Şub', ciro: 1712400, gelir: 1740000, gider: 1482300, net: 257700 },
      { ay: '2026-03', ay_kisa: 'Mar', ciro: 1792600, gelir: 1810400, gider: 1542400, net: 268000 },
      { ay: '2026-04', ay_kisa: 'Nis', ciro: 1812600, gelir: 1836900, gider: 1534300, net: 302600 },
      { ay: '2026-05', ay_kisa: 'May', ciro: 1938400, gelir: 1962800, gider: 1618900, net: 343900 },
      { ay: '2026-06', ay_kisa: 'Haz', ciro: 2041800, gelir: 2068400, gider: 1693100, net: 375300 },
      { ay: '2026-07', ay_kisa: 'Tem', ciro: 2184500, gelir: 2210300, gider: 1771640, net: 438660 },
    ],
  },
  '/api/ledger': [
    { id: 'l1', tarih: gunEkleISO(-1), islem_turu: 'CIRO', tutar: 74000, aciklama: 'Günlük ciro · 4 şube', kaynak_tablo: 'ciro' },
    { id: 'l2', tarih: gunEkleISO(-2), islem_turu: 'FATURA_ODEMESI', tutar: -39800, aciklama: 'Sütaş Bölge Dağıtım', kaynak_tablo: 'vadeli_alimlar' },
    { id: 'l3', tarih: gunEkleISO(-4), islem_turu: 'KART_ODEME', tutar: -28400, aciklama: 'Paper Cup Co.', kaynak_tablo: 'kart_hareketleri' },
    { id: 'l4', tarih: gunEkleISO(-10), islem_turu: 'PERSONEL_MAAS', tutar: -184000, aciklama: 'Temmuz maaş ödemesi', kaynak_tablo: 'personel' },
  ],
  '/api/teslim-bildirim/liste': {
    olaylar: [
      { anahtar: 't1', sube_adi: 'Zafer', baslik: '21 kalem / 214 adet depoya işlendi', detay: 'haftalık sipariş', zaman: bugunISO, tutar: 18900, gorildi: false },
      { anahtar: 't2', sube_adi: 'Gazze', baslik: '17 kalem / 168 adet teslim alındı', detay: 'görüldü işaretlendi', zaman: gunEkleISO(-1), tutar: 15600, gorildi: true },
    ],
  },
  '/api/ops/siparis/depo-akisi-kalinti': { toplam: 3, kayitlar: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  // Son köprü turu: şube→merkez bilgi teslim defteri artık v2-yerlisi
  '/api/bilgi-teslim-kayitlari': {
    satirlar: [
      { id: 'bt1', olusturma: `${gunEkleISO(-1)}T18:42:00`, sube_adi: 'Zafer', personel_ad: 'AYŞENAZ DAL', metin: 'Espresso makinesi 2 numaralı grup basınç düşürüyor, teknik servis çağrıldı.' },
      { id: 'bt2', olusturma: `${gunEkleISO(-3)}T09:15:00`, sube_adi: 'Gazze', personel_ad: 'MEHMET YILMAZ', metin: 'Süt teslimatı eksik geldi — 6 koli yerine 4 koli.' },
    ],
  },
  '/api/tedarikciler': [
    { id: 'td1', ad: 'Kahve Dünyası Çekirdek', kategori: 'çekirdek', telefon: '05321234567', aciklama: '12 ay fiyat kilidi', aktif: true },
    { id: 'td2', ad: 'Sütaş Bölge Dağıtım', kategori: 'süt & krema', telefon: '05339876543', aciklama: 'haftada 2 teslim', aktif: true },
    { id: 'td3', ad: 'Paper Cup Co.', kategori: 'ambalaj', telefon: null, aciklama: 'teklif alındı', aktif: true },
    { id: 'td4', ad: 'Monin Türkiye', kategori: 'şurup & sos', telefon: '02123334455', aciklama: 'yıllık anlaşma', aktif: true },
  ],
  '/api/ops/tedarik-dosyasi': {
    toplam: 4,
    dosyalar: [
      { talep_id: 'a1b2c3d4e5', sube_adi: 'Zafer', tarih: gunEkleISO(-2), durum: 'tamamlandi', kabul_durum: 'tam', tedarikciler: 'Kahve Dünyası', fatura_say: 1 },
      { talep_id: 'f6g7h8i9j0', sube_adi: 'Köyceğiz', tarih: gunEkleISO(-5), durum: 'tamamlandi', kabul_durum: 'uyumsuz', tedarikciler: 'Sütaş', fatura_say: 1 },
      { talep_id: 'k1l2m3n4o5', sube_adi: 'Gazze', tarih: gunEkleISO(-8), durum: 'tamamlandi', kabul_durum: 'tam', tedarikciler: 'Paper Cup', fatura_say: 0 },
      { talep_id: 'p6q7r8s9t0', sube_adi: 'Alsancak', tarih: gunEkleISO(-12), durum: 'tamamlandi', kabul_durum: 'tam', tedarikciler: 'Monin', fatura_say: 2 },
    ],
  },
  '/api/tv-menu/liste': [
    { id: 'tv1', ad: 'Filtre Kahve', kategori: 'Sıcak Kahveler', f8: 78, f14: 92, fice: 0, sira: 1, aktif: true, gorunur: true },
    { id: 'tv2', ad: 'Latte', kategori: 'Sıcak Kahveler', f8: 105, f14: 120, fice: 110, sira: 2, aktif: true, gorunur: true },
    { id: 'tv3', ad: 'Zebra Mocha', kategori: 'Hot Specials', f8: 128, f14: 142, fice: 0, sira: 3, aktif: true, gorunur: true },
    { id: 'tv4', ad: 'Tiramisu Latte', kategori: 'Hot Specials', f8: 0, f14: 0, fice: 0, sira: 4, aktif: false, gorunur: false },
  ],
};

// ── Borç Navigasyonu sahte verisi ───────────────────────────────────────────
const BORC_UC = {
  '/api/borc-nav/ozet': {
    guncel_ay: bugunISO.slice(0, 7),
    kpi: {
      borc_baski_endeksi: { skor: 72, durum: 'Sürdürülemez — borç çevriliyor ama kapanmıyor', renk: 'KIRMIZI' },
      tahmini_acik: { bugun: -12400, ay_sonu: -57800, aylik_yapisal: -57800 },
      runway_ay: 4.2, runway_renk: 'TURUNCU', runway_durum: 'dar',
      zorunlu_yuk: 244200, hedef_ciro_borc_sabit: 2560000,
    },
    abek: { deger: 186400, son_ay: 178200, son3_ort: 181000, ciro_ay: 2184500, nakit_marj_pct: 8.5 },
    borc: { toplam: 1575900, kart_toplam: 443500, kredi_kalan: 1132400, zorunlu_yuk: 244200, kart_asgari: 161600, kredi_taksiti: 82600 },
    nakit: { serbest: 586310, ortalama_aylik_odeme: 198400 },
    hedef_ciro: { marj_pozitif: true, borc_sabit: 2560000, yil_25_azal: 3180000, ay24_bitir: 4240000 },
    bbe_bilesenler: [
      { ad: 'Toplam borç / yıllık ABEK', skor: 70.4, agirlik: 0.35 },
      { ad: 'Zorunlu yük / ABEK', skor: 88.0, agirlik: 0.30 },
      { ad: 'Kart borcu / aylık ciro', skor: 61.0, agirlik: 0.15 },
      { ad: 'Nakit tamponu (düşük→kötü)', skor: 54.0, agirlik: 0.10 },
      { ad: 'Son 90 gün trend', skor: 66.0, agirlik: 0.10 },
    ],
    surdurulemez: true,
    notlar: ['KOSGEB kredisinin ödemesiz dönemi Ocak 27\'de bitiyor — aylık yük +19.400 ₺ artacak'],
  },
  '/api/borc-nav/takvim': (() => {
    const grid = [];
    const y0 = Number(bugunISO.slice(0, 4)); const m0 = Number(bugunISO.slice(5, 7));
    for (let i = 0; i < 36; i++) {
      const t = m0 - 1 + i; const y = y0 + Math.floor(t / 12); const m = (t % 12) + 1;
      // KOSGEB 6. aydan sonra devreye girer, taşıt kredisi 10. ayda biter
      const kredi = 82600 + (i >= 6 ? 19400 : 0) - (i >= 10 ? 12800 : 0) - (i >= 15 ? 32400 : 0);
      const kart = Math.max(40000, 161600 - i * 3200);
      const zorunlu = Math.max(0, kredi + kart);
      grid.push({
        ay: `${y}-${String(m).padStart(2, '0')}`,
        kredi_taksit: Math.max(0, kredi), kart_min: kart, zorunlu_yuk: zorunlu,
        abek: 186400, acik: Math.max(0, zorunlu - 186400),
        kredi_kalan_anapara: Math.max(0, 1132400 - i * 31000),
      });
    }
    const peak = grid.reduce((a, b) => (a.zorunlu_yuk > b.zorunlu_yuk ? a : b));
    return {
      uretildi: bugunISO, abek_aylik: 186400, finansal_borc: 1575900,
      toplam_gelecek_odeme: 2284600, peak,
      kredi_biten_takvim: [
        { ad: 'Halkbank Taşıt', ay: `${y0 + 1}-05` },
        { ad: 'Ziraat İşletme', ay: `${y0 + 1}-10` },
        { ad: 'KOSGEB', ay: `${y0 + 3}-01` },
      ],
      takvim: grid,
      not: 'Kredi tarafı kesin (amortisman). Kart tarafı yaklaşık (asgari sabit).',
    };
  })(),
  '/api/borc-nav/olcek-plani': {
    uretildi: bugunISO,
    parametreler: { mevcut_ciro: 2184500, mevcut_sube: 4, vergi_oran: 0.285 },
    zorunlu_yuk: 244200, toplam_borc: 1575900,
    senaryolar: {
      borc_sabit: { hedef_ciro: 2560000, carpan_mevcut: 1.17, sube_sayisi: 4, yeni_sube: 0, personel_maliyet: 612000, personel_sayisi: 25, uretilen_abek: 244500, ciro_sube_basi: 640000 },
      yil_25_azal: { hedef_ciro: 3180000, carpan_mevcut: 1.46, sube_sayisi: 5, yeni_sube: 1, personel_maliyet: 748000, personel_sayisi: 30, uretilen_abek: 318700, ciro_sube_basi: 636000 },
      ay24_bitir: { hedef_ciro: 4240000, carpan_mevcut: 1.94, sube_sayisi: 6, yeni_sube: 2, personel_maliyet: 928000, personel_sayisi: 38, uretilen_abek: 421000, ciro_sube_basi: 706667 },
    },
    kapasite_gerceklik: { mevcut_sube_max_ciro: 2840000, mevcut_sube_max_abek: 231000, zorunlu_yuk: 244200, yapilandirma_sart: true },
  },
  '/api/borc-nav/sube-katki': {
    gun: 30, uretildi: bugunISO,
    subeler: [
      { sube_id: 's0', sube_adi: 'Zafer', durum: 'aktif', son_ciro_gun: bugunISO, gun_since_ciro: 0, ciro_donem: 798246, kira_aylik: 96000, operasyonel_net_aylik: 92400, ileri_aylik_katki: 92400 },
      { sube_id: 's1', sube_adi: 'Köyceğiz', durum: 'aktif', son_ciro_gun: bugunISO, gun_since_ciro: 0, ciro_donem: 622631, kira_aylik: 62000, operasyonel_net_aylik: 61800, ileri_aylik_katki: 61800 },
      { sube_id: 's2', sube_adi: 'Gazze', durum: 'aktif', son_ciro_gun: bugunISO, gun_since_ciro: 0, ciro_donem: 494914, kira_aylik: 48000, operasyonel_net_aylik: 36200, ileri_aylik_katki: 36200 },
      { sube_id: 's3', sube_adi: 'Alsancak', durum: 'aktif', son_ciro_gun: bugunISO, gun_since_ciro: 0, ciro_donem: 351226, kira_aylik: 42000, operasyonel_net_aylik: -4000, ileri_aylik_katki: -4000 },
    ],
    havuz_besleyen_aylik: 190400, havuz_bosaltan_aylik: -4000, net_havuz_aylik: 186400,
    not: 'Krediler KOLEKTİF — şubeye paylaştırılmaz.',
  },
  // 12 aylık projeksiyon (v2 5. görünüm): sarmal senaryosu — ABEK faizi karşılamıyor
  '/api/borc-nav/projeksiyon': (() => {
    const bas = 1575900; const faiz = 0.041; const abek = 244500;
    const seri = []; let b = bas;
    for (let i = 1; i <= 12; i++) { b = Math.round(b * (1 + faiz) - abek); seri.push({ ay: i, toplam_borc: b }); }
    const son = seri[seri.length - 1].toplam_borc;
    return {
      seri, spiral: bas * faiz > abek,
      varsayim: { baslangic_borc: bas, abek_aylik: abek, efektif_aylik_faiz_pct: 4.1 },
      aylik_faiz_tl: Math.round(bas * faiz),
      abek_aciligi_faize_karsi: Math.max(0, Math.round(bas * faiz - abek)),
      ikiye_katlanma_ay: null,
      ay_sonu_borc: son,
      artis_pct: Math.round(((son - bas) / bas) * 100),
      borc_sabit_icin_gereken_aylik_odeme: Math.round(bas * faiz),
    };
  })(),
};

// ── Para Hareketleri modülü sahte verisi ────────────────────────────────────
const PARA_UC = {
  '/api/evo/sube-grup-detay': {
    subeler: {
      Zafer: { cok_satilan: [
        { ad: 'Latte', adet: 118, ciro: 21240, grup: 'SICAK KAHVE' },
        { ad: 'Iced Americano', adet: 84, ciro: 13020, grup: 'SOGUK KAHVE' },
        { ad: 'Filtre Kahve', adet: 76, ciro: 11020, grup: 'SICAK KAHVE' },
      ]},
      'Köyceğiz': { cok_satilan: [
        { ad: 'Latte', adet: 64, ciro: 11520, grup: 'SICAK KAHVE' },
        { ad: 'Çikolata Milkshake', adet: 41, ciro: 9430, grup: 'MILKSHAKE' },
      ]},
      Gazze: { cok_satilan: [
        { ad: 'Latte', adet: 36, ciro: 6480, grup: 'SICAK KAHVE' },
      ]},
    },
  },
  '/api/kasa-teslim': [
    { id: 'kt1', sube_id: 's0', tarih: bugunISO, tutar: 31200, teslim_turu: 'gun_sonu', teslim_eden_ad: 'Elif K.', teslim_alan_ad: 'ONUR — SAHİP' },
    { id: 'kt2', sube_id: 's1', tarih: bugunISO, tutar: 8410, teslim_turu: 'ara', teslim_eden_ad: 'Can D.', teslim_alan_ad: 'ONUR — SAHİP' },
    { id: 'kt3', sube_id: 's2', tarih: gunEkleISO(-1), tutar: 16230, teslim_turu: 'gun_sonu', teslim_eden_ad: 'Sude Y.', teslim_alan_ad: 'ONUR — SAHİP' },
  ],
  '/api/anlik-gider': {
    satirlar: [
      { id: 'ag1', tarih: bugunISO, tutar: 1840, aciklama: 'Espresso makinesi conta tamiri', sube_adi: 'Zafer' },
      { id: 'ag2', tarih: bugunISO, tutar: 1100, aciklama: 'Temizlik malzemesi', sube_adi: 'Gazze' },
      { id: 'ag3', tarih: gunEkleISO(-2), tutar: 700, aciklama: 'Nalbur — raf vidası', sube_adi: 'Köyceğiz' },
    ],
    ozet: { toplam: 41280 },
  },
  '/api/dis-kaynak': [
    { id: 'dk1', tarih: gunEkleISO(-4), tutar: 12000, aciklama: 'Barista eğitimi · kurumsal', durum: 'aktif', islem_turu: 'DIS_KAYNAK' },
    { id: 'dk2', tarih: gunEkleISO(-10), tutar: 16500, aciklama: 'Toptan çekirdek — komşu restoran', durum: 'aktif', islem_turu: 'DIS_KAYNAK' },
    { id: 'dk3', tarih: gunEkleISO(-19), tutar: 8000, aciklama: 'Mekân kiralama — kapanış sonrası etkinlik', durum: 'aktif', islem_turu: 'DIS_KAYNAK' },
  ],
};

// ── Denetim & Zekâ modülü sahte verisi ──────────────────────────────────────
const DENETIM_UC = {
  '/api/ops/truth/gunluk-rapor': {
    tarih: bugunISO,
    subeler: [
      { sube_id: 's0', sube_ad: 'ZAFER', tarih: bugunISO, motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30`, ana_tani: 'KASA_POS_FARKI', alarm: 'alarm', anomali_sayisi: 2, toplam_karar: 3, boyut_ozet: [{ boyut: 'kasa', durum: 'fark', deger: '−2.340 ₺' }, { boyut: 'stok', durum: 'temiz' }], zeka_ozet: 'Cuma akşamları tekrar eden kasa-POS farkı — vardiya kesişimi şüphesi.', yorum_metni: 'Son 3 cumada aynı yönde fark. Akşam vardiya devrinde sayım disiplinine bakılmalı.' },
      { sube_id: 's1', sube_ad: 'KÖYCEĞİZ', tarih: bugunISO, motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30`, ana_tani: 'UYUMLU', alarm: 'normal', anomali_sayisi: 1, toplam_karar: 1, boyut_ozet: [], zeka_ozet: 'Süt sarfiyatı reçete üstü seyrediyor.', yorum_metni: '' },
      { sube_id: 's2', sube_ad: 'GAZZE', tarih: bugunISO, motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30`, ana_tani: 'UYUMLU', alarm: 'normal', anomali_sayisi: 0, toplam_karar: 0, boyut_ozet: [], zeka_ozet: '', yorum_metni: '' },
      { sube_id: 's3', sube_ad: 'ALSANCAK', tarih: bugunISO, motor_aktif: false, motor_mod: 'read_only', son_calisma: `${gunEkleISO(-42)} 00:30`, ana_tani: 'UYUMLU', alarm: 'normal', anomali_sayisi: 0, toplam_karar: 0, boyut_ozet: [], zeka_ozet: '', yorum_metni: '' },
    ],
  },
  '/api/ops/truth/durum': {
    global_aktif: true,
    subeler: [
      { sube_id: 's0', sube_ad: 'ZAFER', motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30` },
      { sube_id: 's1', sube_ad: 'KÖYCEĞİZ', motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30` },
      { sube_id: 's2', sube_ad: 'GAZZE', motor_aktif: true, motor_mod: 'oneri', son_calisma: `${bugunISO} 00:30` },
      { sube_id: 's3', sube_ad: 'ALSANCAK', motor_aktif: false, motor_mod: 'read_only', son_calisma: `${gunEkleISO(-42)} 00:30` },
    ],
  },
  '/api/duyu/ozet': { toplam_olay: 1846, etiket_sayisi: 21, son_gun_tipleri: [], okuyucular: ['panel', 'beyin', 'whatsapp'] },
  '/api/duyu/gunluk-notlar': {
    notlar: [
      { gun: bugunISO, tip: 'kritik', baslik: 'Bebek kasa-POS farkı 3. kez aynı desende', metin: 'Cuma akşamları tekrarlıyor · kasa–POS motoru' },
      { gun: gunEkleISO(-1), tip: 'uyari', baslik: 'Aynı tutarlı iki fatura', metin: 'Paper Cup 28.400 ₺ · parmak izi farklı · mükerrer motoru' },
      { gun: gunEkleISO(-2), tip: 'bilgi', baslik: 'Ataşehir öğle düşüşü açıklandı', metin: 'plaza tadilatı · ciro ritmi motoru · kendiliğinden kapandı' },
    ],
    tipler: ['kasa', 'stok', 'ciro', 'belge'],
  },
  '/api/duyu/odeme-mutabakat': {
    kesit: 60,
    eslesen: 47,
    dusus_var_odeme_kaydi_yok: [
      { tarih: gunEkleISO(-3), aciklama: 'BORC_TAKSIT — açıklamasız düşüş', tutar: 20491 },
    ],
    odeme_var_dusus_gorulmedi: [
      { tarih: gunEkleISO(-6), aciklama: 'ESHİM ödeme kaydı', tutar: 40800 },
    ],
    not: 'çapa bağımsız',
  },
  '/api/beyin/gunluk': {
    toplam: 2,
    kayitlar: [
      { tip: 'gece_sentez', tarih: `${bugunISO} 06:00`, cevap: 'Dün Zafer cirosu hafta ortalamasının %8 üstünde kapandı; kasa-POS farkı yalnız cuma akşamları tekrarlıyor — vardiya kesişimi deseni güçleniyor. Süt tüketimi Köyceğiz\'de reçete beklentisinin üstünde seyretmeye devam etti.' },
      { tip: 'gece_sentez', tarih: `${gunEkleISO(-1)} 06:00`, cevap: 'Sipariş zinciri temiz; SÜTAŞ vadesi yaklaşırken kasa yeterliliği korunuyor.' },
    ],
  },
  '/api/beyin/bag-dilekleri': {
    dilekler: [
      { ref: 'c3b98577', occurred_at: null, payload_json: { dilek: 'Stok reçete farkı ile fire bildirimi arasında hazır bağ istendi — bağ defterinde yoktu.' } },
    ],
  },
  '/api/duyu/kural-karnesi': {
    ogrenme_aktif: true, n_esigi: 5,
    karne: [
      { kural: 'Geç kalma (grace bantlı)', durum: 'sağlıklı', gozlem: 118, not: 'nötr fark günü çapraz-gün' },
      { kural: 'Temiz hafta', durum: 'sağlıklı', gozlem: 12, not: '' },
      { kural: 'Cuma kasa kesişimi', durum: 'izlemede', gozlem: 3, not: 'B51 bulgusuna bağlı' },
    ],
  },
  '/api/duyu/sinapsler': { kesit: 14, sinaps_olaylari: 6, kase_canli: true, zincir_canli: true },
  '/api/strateji': {
    kasa: 586310, kullanilabilir_nakit: 218400, zorunlu_giderler: 367910, toplam_oneri_tutari: 109650,
    oneriler: [
      // Gerçek uç sözleşmesi: odeme_id + tavsiye_tutar + oneri_turu (ERTELE hariç uygulanabilir)
      { id: 'o1', odeme_id: 'op-101', oneri_turu: 'ODE', tavsiye_tutar: 74200, baslik: 'FEZ KAHVE vadesi geçen ödemesini kapat', aciklama: 'gecikirse tedarik riski', renk: 'KIRMIZI', tutar: 74200 },
      { id: 'o2', odeme_id: 'op-102', oneri_turu: 'ODE', tavsiye_tutar: 35450, baslik: 'SÜTAŞ asgari ödemesi', aciklama: 'faiz işlemeye başladı', renk: 'KIRMIZI', tutar: 35450 },
      { id: 'o3', odeme_id: 'op-103', oneri_turu: 'ERTELE', tavsiye_tutar: 0, baslik: 'Kırtasiye ödemesini 10 gün ertele', aciklama: 'nakit önceliği yüksek kalemlerde', renk: 'TURUNCU', tutar: 0 },
      { id: 'o4', baslik: 'Süt zammını latte grubuna yansıt', aciklama: 'reçete maliyeti +1,4 ₺/bardak', renk: 'TURUNCU', tutar: 0 },
    ],
  },
  '/api/toplu-odeme': { uygulanan: 2 },
};

// ── Belge Merkezi modülü sahte verisi ───────────────────────────────────────
const BELGE_UC = {
  '/api/fatura/belge-merkezi': {
    ay: bugunISO.slice(0, 7),
    kapsama: { isletme_kart_harcamasi: 522435, faturali_eslesen: 168153, kurumsal_otomatik: 30776, faturasiz: 323486, oran_yuzde: 38.1 },
    toptancilar: [
      { toptanci: 'KAHVE DÜNYASI ÇEKİRDEK A.Ş.', adet: 4, toplam: 258000, son_fatura: gunEkleISO(-1) },
      { toptanci: 'SÜTAŞ BÖLGE DAĞITIM', adet: 6, toplam: 187400, son_fatura: bugunISO },
      { toptanci: 'PAPER CUP CO.', adet: 2, toplam: 56800, son_fatura: gunEkleISO(-4) },
    ],
    faturasiz_harcamalar: [
      { tarih: gunEkleISO(-1), kart: 'Garanti 7015', tutar: 14200, aciklama: 'Teknoloji · tablet POS', tip: 'belirsiz' },
      { tarih: gunEkleISO(-2), kart: 'Akbank Axess', tutar: 3860, aciklama: 'Akaryakıt · servis aracı', tip: 'isletme' },
    ],
    fatura_arsivi: [
      { id: 'fa1', tedarikci_ad: 'KAHVE DÜNYASI ÇEKİRDEK A.Ş.', tarih: bugunISO, tutar: 68400, durum: 'ocr_tamam', goruntule: '' },
      { id: 'fa2', tedarikci_ad: 'SÜTAŞ BÖLGE DAĞITIM', tarih: gunEkleISO(-1), tutar: 41250, durum: 'ocr_tamam', goruntule: '' },
      { id: 'fa3', tedarikci_ad: 'FEZ KAHVE GIDA', tarih: gunEkleISO(-2), tutar: 35148, durum: 'ocr_hata', goruntule: '' },
    ],
    islenemeyen_foto: [{ id: 'if1' }],
    kdv_kanit: {
      ay: bugunISO.slice(0, 7),
      indirime_aday: { adet: 21, toplam: 486400 },
      inceleme: { adet: 6, toplam: 92300 },
      supheli: { adet: 1, toplam: 28400 },
      not: 'KDV TUTARI HESAPLANMAZ — hüküm muhasebecinin.',
    },
  },
  // Açık teslimat / belge talebi (v2 yerli akış — köprü kaldırma turu)
  '/api/belge-talep/bekleyen': {
    talepler: [
      { id: 'bt1', tedarikci_ad: 'FEZ KAHVE', tedarikci_tel: '5321234567', teslim_tarihi: gunEkleISO(-3), gelen_fatura_adet: 0, mesaj_gonderildi_ts: null },
      { id: 'bt2', tedarikci_ad: 'SÜTAŞ', tedarikci_tel: '5339876543', teslim_tarihi: gunEkleISO(-6), gelen_fatura_adet: 1, mesaj_gonderildi_ts: gunEkleISO(-1) },
      { id: 'bt3', tedarikci_ad: 'ATALAY KAHVE', tedarikci_tel: '', teslim_tarihi: gunEkleISO(-9), gelen_fatura_adet: 0, mesaj_gonderildi_ts: null },
    ],
  },
  '/api/belge-talep/elle': { ok: true },
  '/api/fatura-istek/liste': {
    acik_adet: 4, acik_toplam: 316530, kdv_riski: 63300,
    gruplar: [
      { tedarikci: 'ATALAY KAHVE', tel: '905551112233', adet: 2, toplam: 280000, kurumsal: false, istekler: [
        { id: 'i1', kaynak_tip: 'anlik_gider', tarih: gunEkleISO(-2), tutar: 180000, aciklama: 'Cari borç ödemesi — fatura bekleniyor' },
        { id: 'i2', kaynak_tip: 'teslim', tarih: gunEkleISO(-5), tutar: 100000, aciklama: 'Çekirdek teslimi' },
      ]},
      { tedarikci: 'BARISTA SERVİS', tel: null, adet: 2, toplam: 36530, kurumsal: false, istekler: [
        { id: 'i3', kaynak_tip: 'teslim', tarih: gunEkleISO(-3), tutar: 33330, aciklama: 'Makine bakım parçası' },
      ]},
    ],
  },
  '/api/fatura/fiyat-bandi': {
    urun_adet: 18, band_disi_adet: 2,
    band_disi: [
      { kod: 'k3', ad: 'Süt 3.5% (L)', birim: 'L', gozlem: 12, medyan: 42, aralik: [40.5, 43], son_fiyat: 46, son_tarih: gunEkleISO(-10), son_tedarikci: 'Sütaş' },
      { kod: 'k2', ad: 'Karton bardak 12 oz', birim: 'adet', gozlem: 7, medyan: 2.6, aralik: [2.45, 2.7], son_fiyat: 3.05, son_tarih: gunEkleISO(-6), son_tedarikci: 'Paper Cup' },
    ],
    bantlar: [],
  },
  '/api/fatura/cari-ekstre': {
    arama: 'KAHVE DÜNYASI', fatura_adet: 4,
    faturalar: [
      { id: 'cf1', fatura_no: 'KD2026-4471', tarih: bugunISO, tutar: 68400, bakiye_dahil: 129800, goruntule: '' },
      { id: 'cf2', fatura_no: 'KD2026-4402', tarih: gunEkleISO(-21), tutar: 61400, bakiye_dahil: 61400, goruntule: '' },
    ],
    beyan_bakiye: 129800, devir: 64200, devir_not: 'sistem öncesi beyan',
    fatura_toplam_6ay: 1620000, odeme_izi_toplam_6ay: 1490200, hesaplanan_acik: 129800,
    aylik: [],
  },
  '/api/fatura/ara': [
    { id: 'ar1', tedarikci_ad: 'SÜTAŞ BÖLGE DAĞITIM', tarih: gunEkleISO(-1), tutar: 41250, durum: 'ocr_tamam' },
  ],
};

function borcKocu(url) {
  const strateji = /kartopu/.test(url) ? 'kartopu' : 'cig';
  const nakit = Number((url.match(/nakit=(\d+)/) || [])[1] || 0);
  const satir = K.map(k => ({
    kart_id: k.id, kart_adi: k.kart_adi, sahip: k.sahip, borc: k.toplam_borc_taksitli,
    faiz_yillik: k.faiz_orani, aylik_faiz: Math.round(k.toplam_borc_taksitli * k.faiz_orani / 100 / 12),
    asgari: k.asgari_odeme, faiz_belirsiz: k.faiz_orani <= 0, onerilen_odeme: k.asgari_odeme,
  }));
  satir.sort((a, b) => (strateji === 'kartopu' ? a.borc - b.borc : b.faiz_yillik - a.faiz_yillik));
  const toplamAsgari = satir.reduce((s, k) => s + k.asgari, 0);
  const artan = Math.max(0, nakit - toplamAsgari);
  if (satir[0]) satir[0].onerilen_odeme += artan;
  return {
    strateji, nakit, toplam_borc: satir.reduce((s, k) => s + k.borc, 0),
    toplam_aylik_faiz: satir.reduce((s, k) => s + k.aylik_faiz, 0),
    toplam_asgari: toplamAsgari,
    asgari_karsilaniyor: nakit >= toplamAsgari,
    artan_nakit: artan, oncelik: satir[0], kartlar: satir,
  };
}

window.fetch = async (url) => {
  const u = String(url);
  let govde = null;
  // ⚠️ ÖNCE TAM YOL eşleşmesi: `u.includes('/api/ciro')` gibi gevşek kurallar
  // /api/ciro-taslak'ı da yakalıyordu ve rozet 2 yerine 120 çıkıyordu.
  const yol = u.split('?')[0];
  const TUM = { ...SAHTE, ...KART_UC, ...ODEME_UC, ...OPS_UC, ...MALIYET_UC, ...EKIP_UC, ...KUCUK_UC, ...BORC_UC, ...PARA_UC, ...DENETIM_UC, ...BELGE_UC, '/api/ciro': CIRO };
  if (u.includes('/api/kartlar/borc-kocu')) govde = borcKocu(u);
  else if (Object.prototype.hasOwnProperty.call(TUM, yol)) govde = TUM[yol];
  await new Promise(r => setTimeout(r, 120));
  return { ok: govde != null, status: govde != null ? 200 : 404, statusText: 'OK', json: async () => govde ?? { detail: 'yok' } };
};

createRoot(document.getElementById('root')).render(<TasarimV2 onGit={(h) => console.log('köprü →', h)} />);
