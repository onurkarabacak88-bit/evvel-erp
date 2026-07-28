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

function ciroUret() {
  const satir = [];
  const bugun = new Date();
  for (let g = 29; g >= 0; g--) {
    const d = new Date(bugun);
    d.setDate(d.getDate() - g);
    const tarih = d.toISOString().slice(0, 10);
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
  '/api/onay-kuyrugu': [{ id: 1 }, { id: 2 }, { id: 3 }],
  // rozet sayaç uçları
  '/api/ciro-taslak': [{ id: 1 }, { id: 2 }],
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
  '/api/kart-hareketleri': [
    { id: 'h1', tarih: '2026-07-27', kart_adi: 'Garanti Bonus İşletme', islem_turu: 'HARCAMA', tutar: 68400, aciklama: 'Kahve Dünyası — çekirdek alımı', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 68400, faiz_tutari: 0 },
    { id: 'h2', tarih: '2026-07-26', kart_adi: 'Yapı Kredi World', islem_turu: 'HARCAMA', tutar: 16340, aciklama: 'Market — açıklama yok', harcama_tipi: 'belirsiz', taksit_sayisi: 1, ana_para: 16340, faiz_tutari: 0 },
    { id: 'h3', tarih: '2026-07-25', kart_adi: 'Akbank Axess', islem_turu: 'ODEME', tutar: 9570, aciklama: 'Asgari ödeme', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 9570, faiz_tutari: 0 },
    { id: 'h4', tarih: '2026-07-24', kart_adi: 'Garanti Bonus İşletme', islem_turu: 'FAIZ', tutar: 9832, aciklama: 'Dönem faizi (KKDF/BSMV dahil)', harcama_tipi: 'isletme', taksit_sayisi: 1, ana_para: 0, faiz_tutari: 9832 },
    { id: 'h5', tarih: '2026-07-22', kart_adi: 'Yapı Kredi World', islem_turu: 'HARCAMA', tutar: 8340, aciklama: 'Kişisel — restoran', harcama_tipi: 'sahsi', taksit_sayisi: 3, ana_para: 8340, faiz_tutari: 0 },
  ],
};

// ── Ödeme Merkezi modülü sahte verisi ───────────────────────────────────────
const bugunISO = new Date().toISOString().slice(0, 10);
const gunEkleISO = (n) => { const d = new Date(bugunISO + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

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
  const TUM = { ...SAHTE, ...KART_UC, ...ODEME_UC, ...OPS_UC, '/api/ciro': CIRO };
  if (u.includes('/api/kartlar/borc-kocu')) govde = borcKocu(u);
  else if (Object.prototype.hasOwnProperty.call(TUM, yol)) govde = TUM[yol];
  await new Promise(r => setTimeout(r, 120));
  return { ok: govde != null, status: govde != null ? 200 : 404, statusText: 'OK', json: async () => govde ?? { detail: 'yok' } };
};

createRoot(document.getElementById('root')).render(<TasarimV2 onGit={(h) => console.log('köprü →', h)} />);
