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

window.fetch = async (url) => {
  const u = String(url);
  let govde = null;
  if (u.includes('/api/ciro')) govde = CIRO;
  else if (u.includes('/api/onay-kuyrugu')) govde = SAHTE['/api/onay-kuyrugu'];
  else if (u.includes('/api/subeler')) govde = SAHTE['/api/subeler'];
  else if (u.includes('/api/panel')) govde = SAHTE['/api/panel'];
  await new Promise(r => setTimeout(r, 120));
  return { ok: govde != null, status: govde != null ? 200 : 404, statusText: 'OK', json: async () => govde ?? { detail: 'yok' } };
};

createRoot(document.getElementById('root')).render(<TasarimV2 onGit={(h) => console.log('köprü →', h)} />);
