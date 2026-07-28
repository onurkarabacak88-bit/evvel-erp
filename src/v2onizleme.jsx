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
  const yol = u.split('?')[0];
  if (u.includes('/api/kartlar/borc-kocu')) govde = borcKocu(u);
  else if (KART_UC[yol]) govde = KART_UC[yol];
  else if (u.includes('/api/ciro')) govde = CIRO;
  else if (u.includes('/api/onay-kuyrugu')) govde = SAHTE['/api/onay-kuyrugu'];
  else if (u.includes('/api/subeler')) govde = SAHTE['/api/subeler'];
  else if (u.includes('/api/panel')) govde = SAHTE['/api/panel'];
  await new Promise(r => setTimeout(r, 120));
  return { ok: govde != null, status: govde != null ? 200 : 404, statusText: 'OK', json: async () => govde ?? { detail: 'yok' } };
};

createRoot(document.getElementById('root')).render(<TasarimV2 onGit={(h) => console.log('köprü →', h)} />);
