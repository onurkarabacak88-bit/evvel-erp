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
  '/api/personel-aylik': BORDRO,
  '/api/avans/ozet': { toplam: 4000, adet: 1 },
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
  const TUM = { ...SAHTE, ...KART_UC, ...ODEME_UC, ...OPS_UC, ...MALIYET_UC, ...EKIP_UC, ...KUCUK_UC, '/api/ciro': CIRO };
  if (u.includes('/api/kartlar/borc-kocu')) govde = borcKocu(u);
  else if (Object.prototype.hasOwnProperty.call(TUM, yol)) govde = TUM[yol];
  await new Promise(r => setTimeout(r, 120));
  return { ok: govde != null, status: govde != null ? 200 : 404, statusText: 'OK', json: async () => govde ?? { detail: 'yok' } };
};

createRoot(document.getElementById('root')).render(<TasarimV2 onGit={(h) => console.log('köprü →', h)} />);
