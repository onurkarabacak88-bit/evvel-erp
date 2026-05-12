import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { api, fmt } from '../utils/api';
import { computeOpsKartVurgu } from '../utils/opsVurgu';
import { publishGlobalDataRefresh, subscribeGlobalDataRefresh } from '../utils/globalDataRefresh';

/** Backend'in statik şube paneli (`GET /sube-panel/{id}`) — API ile aynı kök (VITE_API_URL). */
function subePanelHariciUrl(subeId) {
  const sid = String(subeId || '').trim();
  if (!sid) return '';
  const raw = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  const origin = raw || (typeof window !== 'undefined' ? String(window.location.origin || '').replace(/\/+$/, '') : '');
  if (!origin) return '';
  return `${origin}/sube-panel/${encodeURIComponent(sid)}`;
}

/** Mağaza depo katalog — şube paneli `siparisNormalize` ile aynı mantık (ayrı dosya Docker'da eksik kalmasın diye burada). */
function magazaDepoSlugifyTr(s) {
  return String(s || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\u0307/g, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '') || 'urun';
}

function magazaAktifUrunSayisi(kat) {
  const items = Array.isArray(kat?.items) ? kat.items : [];
  return items.filter((it) => it && it.aktif !== false).length;
}

/** Katalog API sayıları (JSON sayı veya "1.234,56" metni). */
function magazaKatalogSayi(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function magazaIlkSayi(it, keys) {
  if (!it || typeof it !== 'object') return null;
  for (const key of keys) {
    const n = magazaKatalogSayi(it[key]);
    if (n != null) return n;
  }
  return null;
}

function magazaUrunStokVeFiyat(it) {
  if (!it || typeof it !== 'object') {
    return { stok: null, birim_fiyat: null, toplam_stok_degeri: null };
  }
  const stok = magazaIlkSayi(it, ['stok', 'depo_stok', 'miktar', 'stok_miktari']);
  const birim_fiyat = magazaIlkSayi(it, ['birim_fiyat_tl', 'birim_fiyat', 'fiyat', 'fiyat_tl', 'alis_fiyat', 'unit_fiyat']);
  const toplam = stok != null && birim_fiyat != null ? stok * birim_fiyat : null;
  return { stok, birim_fiyat, toplam_stok_degeri: toplam };
}

function magazaFmtStok(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(n);
}

function magazaFmtBirimFiyat(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 }).format(n);
}

/** Bardak ürün/kategorisi: stok bu değerin altına düşünce uyarı (sipariş kataloğu ile uyumlu). */
const MAGAZA_BARDAK_MIN_ESIK = 50;

/** Backend `STOK_KEYS` ile aynı — depo havuzu önerileri (uuid veya bu sabitler). */
const MAGAZA_DEPO_STOK_ANAHTARLARI = [
  'bardak_kucuk',
  'bardak_buyuk',
  'bardak_plastik',
  'su_adet',
  'redbull_adet',
  'soda_adet',
  'cookie_adet',
  'pasta_adet',
  'sut_litre',
  'surup_adet',
  'kahve_paket',
  'karton_bardak',
  'kapak_adet',
  'pecete_paket',
  'diger_sarf',
];

/** Havuz satırında «çilek» gibi kısa ad yerine ne tür kalem olduğu okunsun (backend STOK_KEYS ile uyumlu). */
const MAGAZA_DEPO_HAVUZ_ETIKET_TR = {
  bardak_kucuk: 'Küçük bardak (genel havuz)',
  bardak_buyuk: 'Büyük bardak (genel havuz)',
  bardak_plastik: 'Plastik bardak (genel havuz)',
  su_adet: 'Su — adet (genel havuz)',
  redbull_adet: 'Red Bull — adet (genel havuz)',
  soda_adet: 'Soda — adet (genel havuz)',
  cookie_adet: 'Kurabiye — adet (genel havuz)',
  pasta_adet: 'Pasta — adet (genel havuz)',
  sut_litre: 'Süt — litre (genel havuz)',
  surup_adet: 'Şurup / aromatik — adet (genel havuz)',
  kahve_paket: 'Kahve paket (genel havuz)',
  karton_bardak: 'Karton bardak (genel havuz)',
  kapak_adet: 'Kapak — adet (genel havuz)',
  pecete_paket: 'Peçete — paket (genel havuz)',
  diger_sarf: 'Diğer sarf (genel havuz)',
};

/**
 * Canlı depo API satırını sipariş kataloğu / havuz ile zenginleştirir — başlık + alt açıklama.
 * @returns {{ baslik: string, alt: string|null, kod: string }}
 */
function magazaCanliDepoSatirMeta(st, kategoriler) {
  const kk = String(st?.kalem_kodu || '').trim();
  const kadiDepo = String(st?.kalem_adi || '').trim();
  if (!kk) {
    return { baslik: kadiDepo || '—', alt: null, kod: '' };
  }
  const kats = Array.isArray(kategoriler) ? kategoriler : [];
  for (let ki = 0; ki < kats.length; ki += 1) {
    const kat = kats[ki];
    const items = Array.isArray(kat.items) ? kat.items : [];
    const it = items.find((x) => String(x?.id || '') === kk);
    if (it) {
      const katEtiket = String(kat.label || kat.ad || '').trim() || String(kat.id || '').trim();
      const katalogAd = String(it.ad || '').trim();
      const baslik = katalogAd || kadiDepo || kk;
      const altParca = [];
      if (katEtiket) altParca.push(`Kategori: ${katEtiket}`);
      if (kadiDepo && katalogAd && kadiDepo !== katalogAd) {
        altParca.push(`Depo satır adı: ${kadiDepo}`);
      } else if (kadiDepo && !katalogAd) {
        altParca.push(`Depo adı: ${kadiDepo}`);
      }
      return {
        baslik,
        alt: altParca.length ? altParca.join(' · ') : null,
        kod: kk,
      };
    }
  }
  if (MAGAZA_DEPO_HAVUZ_ETIKET_TR[kk]) {
    const baslik = MAGAZA_DEPO_HAVUZ_ETIKET_TR[kk];
    const alt = kadiDepo ? `Kabul/etiket notu: ${kadiDepo}` : null;
    return { baslik, alt, kod: kk };
  }
  const baslik = kadiDepo || kk;
  const alt = kk.length >= 12
    ? `Kalem kodu: ${kk.length > 28 ? `${kk.slice(0, 10)}…${kk.slice(-6)}` : kk}`
    : null;
  return { baslik, alt, kod: kk };
}

function magazaDepoMetinBardakMi(s) {
  const n = magazaAdNorm(String(s || ''));
  return n.includes('bardak');
}

/**
 * Depo satırı kritik mi? (Operasyon Merkezi «Depo uyarıları» + API alarm_sayisi ile uyumlu)
 * - Bardak (kategori veya ürün adında «bardak»): mevcut &lt; 50 → uyarı (sıfır dahil).
 * - Diğer kalemler: mevcut ≤ 0 → uyarı (sıfır stoklu her satır kapsamda).
 */
function magazaDepoSatirKritik(st, ctx) {
  if (!st || typeof st !== 'object') return false;
  const rawM = st.mevcut_adet;
  const mevcut = Number(rawM === '' || rawM === undefined || rawM === null ? 0 : rawM);
  const kk = String(ctx?.kategoriKod || st.kategori_kod || '').toLocaleLowerCase('tr-TR');
  const kl = String(ctx?.kategoriLabel || '').toLocaleLowerCase('tr-TR');
  const ua = String(ctx?.urunAd || '').toLocaleLowerCase('tr-TR');
  const bardak =
    kk.includes('bardak')
    || kl.includes('bardak')
    || ua.includes('bardak')
    || magazaDepoMetinBardakMi(st.kalem_adi)
    || magazaDepoMetinBardakMi(st.kalem_kodu);
  if (!Number.isFinite(mevcut)) return false;
  if (bardak) return mevcut < MAGAZA_BARDAK_MIN_ESIK;
  return mevcut <= 0;
}

/** Canlı depo satırlarından TL envanter değeri (mevcut × birim). */
function magazaDepoCanliToplamDeger(stokRows) {
  const rows = Array.isArray(stokRows) ? stokRows : [];
  let t = 0;
  rows.forEach((st) => {
    const m = Number(st?.mevcut_adet || 0);
    const f = Number(st?.alis_fiyati_tl ?? st?.birim_fiyat ?? 0);
    if (Number.isFinite(m) && Number.isFinite(f)) t += m * f;
  });
  return t;
}

function magazaKatalogUrunAramaEslesir(it, aramaHam) {
  const raw = String(aramaHam || '').trim();
  if (!raw) return true;
  const idParca = raw.toLocaleLowerCase('tr-TR');
  const idOk = String(it?.id || '').toLowerCase().includes(idParca);
  const adNorm = magazaAdNorm(it?.ad || '');
  const qNorm = magazaAdNorm(raw);
  const adOk = qNorm && adNorm.includes(qNorm);
  return idOk || adOk;
}

/** Hub kartı varsa şube id; yoksa mağaza slug ile yerel anahtar (aynı depo ekranında elle stok). */
function magazaSubeDepoAnahtar(k, m) {
  const sid = k?.sube_id;
  if (sid) return String(sid);
  return `slug:${m.slug}`;
}

function magazaStokGirdiOku(stokMap, sid, urunId, apiStok) {
  const key = `${sid}::${urunId}`;
  if (stokMap && Object.prototype.hasOwnProperty.call(stokMap, key)) return stokMap[key];
  if (apiStok != null) return String(apiStok);
  return '';
}

function magazaUrunEfektifBirimFiyat(it, fiyatMap) {
  if (!it || typeof it !== 'object') return null;
  const urunId = String(it.id || '').trim();
  if (urunId && fiyatMap && Object.prototype.hasOwnProperty.call(fiyatMap, urunId)) {
    const overrideFiyat = magazaKatalogSayi(fiyatMap[urunId]);
    if (overrideFiyat != null && overrideFiyat >= 0) return overrideFiyat;
  }
  return it.birim_fiyat != null && Number.isFinite(it.birim_fiyat) ? it.birim_fiyat : null;
}

function magazaKategoriStokDegerToplamSube(kat, sid, stokMap, fiyatMap) {
  const items = Array.isArray(kat?.items) ? kat.items : [];
  let t = 0;
  let any = false;
  for (const it of items) {
    const raw = magazaStokGirdiOku(stokMap, sid, it.id, it.stok);
    const stok = magazaKatalogSayi(raw);
    const bp = magazaUrunEfektifBirimFiyat(it, fiyatMap);
    if (stok != null && bp != null && Number.isFinite(bp)) {
      t += stok * bp;
      any = true;
    }
  }
  return any ? t : null;
}

function siparisKatalogLikeSubePanelNormalize(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((k, ki) => {
    const items = Array.isArray(k.items) ? k.items : [];
    const nItems = items.map((it, i) => {
      if (typeof it === 'string') {
        const ad = it.trim();
        return {
          id: `${magazaDepoSlugifyTr(ad)}_${i}`,
          ad,
          aktif: true,
          stok: null,
          birim_fiyat: null,
          toplam_stok_degeri: null,
        };
      }
      const ad = String((it && it.ad) || '').trim() || `Ürün ${i + 1}`;
      const { stok, birim_fiyat, toplam_stok_degeri } = magazaUrunStokVeFiyat(it);
      return {
        id: String((it && it.id) || '').trim() || `${magazaDepoSlugifyTr(ad)}_${i}`,
        ad,
        aktif: it && it.aktif !== false,
        stok,
        birim_fiyat,
        toplam_stok_degeri,
      };
    });
    return {
      id: String(k.id || k.kod || '').trim() || `kat_${ki}`,
      label: String(k.label || k.ad || '').trim() || 'Kategori',
      ad: k.ad,
      items: nItems,
    };
  });
}

/** Tam hub; başarısızsa alarm satırları hesaplanmayan hafif istek (ağır sorgu / proxy 502 sonrası). */
async function fetchHubOzet() {
  try {
    return await api('/ops/hub-ozet');
  } catch (firstErr) {
    try {
      return await api('/ops/hub-ozet?skip_alarms=1');
    } catch {
      throw firstErr;
    }
  }
}

const FILTRELER = [
  { id: 'all',     label: 'Tümü' },
  { id: 'kritik',  label: '🔴 Kritik' },
  { id: 'geciken', label: '🟠 Geciken' },
  { id: 'fark',    label: '⚠️ Fark / Uyarı' },
  { id: 'guvenlik', label: '🔐 Güvenlik alarmı' },
  { id: 'stok', label: '📦 Stok / KONTROL' },
];

const UST_SEKMELER = [
  { id: 'canli', label: 'Canlı Operasyon' },
  { id: 'urun-ac', label: '🟢 Ürün Aç Akışı' },
  { id: 'gec-acilan-subeler', label: '⏰ Geç Açılan Şubeler' },
  { id: 'gec-kalan-personel', label: '👤 Geç Kalan Personel' },
  { id: 'kullanilan-urunler', label: '🟠 Kullanılan Ürünler' },
  { id: 'kapanis-takip', label: '📊 Kapanış Takip' },
  { id: 'ciro-onay', label: '💳 Bekleyen Ciro Onayları' },
  { id: 'kasa-uyumsuzluk', label: '🔴 Kasa Uyumsuzluğu' },
  { id: 'personel-vardiya-uyumsuzluk', label: '⚠️ Personel Uyumsuzluğu' },
  { id: 'urun-uyumsuzluk', label: '🧪 Ürün Uyumsuzlukları' },
  { id: 'sevkiyat-uyumsuzluk', label: '🚚 Sevkiyat uyumsuzlukları' },
  { id: 'magaza-kartlari', label: '🏪 Depo stokları' },
  { id: 'kontrol', label: '🔍 Kontrol' },
  { id: 'guvenlik-alarmlar', label: '🚨 Güvenlik Alarmları' },
  { id: 'metrics', label: '📊 KPI Paneli' },
  { id: 'stok-kayip', label: '📉 Stok Kayıp' },
  { id: 'personel-davranis', label: '👤 Personel Davranış' },
  { id: 'fis', label: '🧾 Fiş Kontrol' },
  { id: 'defter', label: 'Defter Kayıtları' },
  { id: 'sayim', label: 'Açılış Sayımları' },
  { id: 'siparis', label: '📦 Sipariş katalog' },
  { id: 'siparis-kabul-takip', label: '📥 Sipariş kabul takibi' },
  { id: 'toptanci-siparisleri', label: '🚚 Toptancı siparişleri' },
  { id: 'toptanci-teslimler', label: '📦 Toptancıdan Gelenler' },
  { id: 'analitik', label: '📈 Şube Analitik' },
  { id: 'stok-tahmin', label: '🔮 Stok Tahmin' },
  { id: 'mesaj', label: '📩 Merkez Mesajı' },
  { id: 'puan', label: '⭐ Personel Puan' },
  { id: 'stok-disiplin', label: '🔴 Stok Disiplin' },
  { id: 'siparis-gecmis', label: '📋 Sipariş Geçmişi' },
];

/** Modül penceresi içi başlık sekmeleri (CFO kart drill-down benzeri) */
const OPS_MODUL_BOLUM = {
  canli: [{ id: 'icerik', label: 'Genel Bakış' }],
  'urun-ac': [{ id: 'icerik', label: 'Günlük akış' }],
  'gec-acilan-subeler': [{ id: 'icerik', label: 'Günlük akış' }],
  'gec-kalan-personel': [{ id: 'icerik', label: 'Aylık analiz' }],
  'kullanilan-urunler': [{ id: 'icerik', label: 'Günlük akış' }],
  'kapanis-takip': [{ id: 'icerik', label: 'Günlük özet' }],
  'ciro-onay': [{ id: 'icerik', label: 'Onay akışı' }],
  'kasa-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'personel-vardiya-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'urun-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'sevkiyat-uyumsuzluk': [{ id: 'icerik', label: 'Liste' }],
  'magaza-kartlari': [{ id: 'icerik', label: 'Şubeler' }],
  metrics: [
    { id: 'personel', label: 'Personel verimlilik' },
    { id: 'sube', label: 'Şube operasyon' },
    { id: 'finans', label: 'Finans özet' },
    { id: 'stok', label: 'Stok & tedarik' },
  ],
  kontrol: [{ id: 'icerik', label: 'Kontrol özeti' }],
  'guvenlik-alarmlar': [{ id: 'icerik', label: 'Aktif alarmlar' }],
  'stok-kayip': [{ id: 'icerik', label: 'Özet tablo' }],
  'personel-davranis': [{ id: 'icerik', label: 'Davranış analizi' }],
  fis: [{ id: 'icerik', label: 'Bekleyen fişler' }],
  onay: [{ id: 'icerik', label: 'Onay kuyruğu' }],
  defter: [{ id: 'icerik', label: 'Kayıtlar' }],
  sayim: [
    { id: 'acilis', label: 'Açılış Sayımları' },
    { id: 'bar-ozet', label: 'Bar Günlük Özet' },
  ],
  siparis: [{ id: 'icerik', label: 'Sipariş katalogu' }],
  'siparis-kabul-takip': [{ id: 'icerik', label: 'Kabul listesi' }],
  'toptanci-siparisleri': [{ id: 'icerik', label: 'Liste' }],
  'toptanci-teslimler': [{ id: 'icerik', label: 'Şube bazlı' }],
  analitik: [{ id: 'icerik', label: 'Genel özet' }],
  'stok-tahmin': [{ id: 'icerik', label: 'Tahminler' }],
  mesaj: [{ id: 'icerik', label: 'Mesajlar' }],
  puan: [{ id: 'icerik', label: 'Puan listesi' }],
  'stok-disiplin': [{ id: 'icerik', label: 'Disiplin Merkezi' }],
  'siparis-gecmis': [{ id: 'icerik', label: 'Geçmiş' }],
};

const OPS_HUB_RENK = {
  canli: '#4a9eff',
  'urun-ac': '#2db573',
  'gec-acilan-subeler': '#f97316',
  'gec-kalan-personel': '#0ea5a4',
  'kullanilan-urunler': '#f59e0b',
  'kapanis-takip': '#22c55e',
  'ciro-onay': '#d946b8',
  'kasa-uyumsuzluk': '#e85d5d',
  'personel-vardiya-uyumsuzluk': '#be185d',
  'urun-uyumsuzluk': '#8b5cf6',
  'sevkiyat-uyumsuzluk': '#ea580c',
  'magaza-kartlari': '#7c6fdc',
  kontrol: '#e85d5d',
  'guvenlik-alarmlar': '#be185d',
  metrics: '#2db573',
  'stok-kayip': '#f08040',
  'personel-davranis': '#c9a227',
  fis: '#5ab0c4',
  onay: '#d946b8',
  defter: 'var(--text3)',
  sayim: 'var(--green)',
  siparis: '#4a9eff',
  'siparis-kabul-takip': '#2db573',
  'toptanci-siparisleri': '#0ea5a4',
  'toptanci-teslimler': '#f59e0b',
  analitik: '#6366f1',
  'stok-tahmin': '#10b981',
  mesaj: '#8899aa',
  puan: '#ffc14d',
  'stok-disiplin': '#e85d5d',
  'siparis-gecmis': '#94a3b8',
};

/** 29 eski tab → 7 Dünya standardı modül (kahve zinciri / hizmet sektörü mantığı) */
const MODULLER = [
  {
    id: 'canli-ops',
    label: '📡 Canlı Operasyon',
    renk: '#4a9eff',
    desc: 'Anlık şube durumu, açılma, kapanış, personel takibi ve merkez direktifleri',
    tabs: ['canli', 'gec-acilan-subeler', 'kapanis-takip', 'gec-kalan-personel', 'mesaj'],
  },
  {
    id: 'envanter',
    label: '📦 Envanter',
    renk: '#f08040',
    desc: 'Stok sayımı, tüketim takibi, fire & kayıp analizi ve ürün uyumsuzlukları',
    tabs: ['magaza-kartlari', 'sayim', 'kullanilan-urunler', 'urun-ac', 'stok-kayip', 'urun-uyumsuzluk'],
  },
  {
    id: 'siparis-tedarik',
    label: '🚚 Sipariş & Tedarik',
    renk: '#0ea5a4',
    desc: 'Sipariş disiplini, kabul takibi, toptancı ve sevkiyat yönetimi',
    tabs: ['siparis', 'stok-disiplin', 'siparis-kabul-takip', 'toptanci-siparisleri', 'toptanci-teslimler', 'sevkiyat-uyumsuzluk', 'siparis-gecmis'],
  },
  {
    id: 'finans-kasa',
    label: '💳 Finans & Kasa',
    renk: '#e85d5d',
    desc: 'Günlük ciro onayı, kasa uyumsuzluğu ve fiş kontrol',
    tabs: ['ciro-onay', 'kasa-uyumsuzluk', 'fis'],
  },
  {
    id: 'personel',
    label: '👤 Personel',
    renk: '#c9a227',
    desc: 'Davranış analizi, vardiya uyumsuzluğu ve puan sistemi',
    tabs: ['personel-davranis', 'personel-vardiya-uyumsuzluk', 'puan'],
  },
  {
    id: 'denetim-uyum',
    label: '🔐 Denetim & Uyum',
    renk: '#be185d',
    desc: 'Kontrol özeti, güvenlik alarmları ve operasyonel kayıtlar',
    tabs: ['kontrol', 'guvenlik-alarmlar', 'defter'],
  },
  {
    id: 'analitik-planlama',
    label: '📊 Analitik & Planlama',
    renk: '#6366f1',
    desc: 'KPI paneli, şube performans analizi ve stok tahmin/planlama',
    tabs: ['metrics', 'analitik', 'stok-tahmin'],
  },
];

const ONAY_TURU_LABEL = {
  SABIT_GIDER: 'Sabit gider',
  KART_ODEME: 'Kart ödemesi',
  ANLIK_GIDER: 'Anlık gider',
  PERSONEL_MAAS: 'Personel maaşı',
  VADELI_ODEME: 'Vadeli ödeme',
  DIS_KAYNAK: 'Dış kaynak',
  CIRO: 'Ciro',
  ODEME_PLANI: 'Ödeme planı',
  KART_FAIZ: 'Kart faizi',
  BORC_TAKSIT: 'Borç taksidi',
  FATURA_ODEMESI: 'Fatura',
};

/** Hub kartlarından dört mağaza şubesini ada göre eşleştirir (depo bu sekmede yok). */
const MAGAZA_DORT_SUBE = [
  { slug: 'alsancak', keys: ['alsancak'], label: 'Alsancak', depoBaslik: 'Alsancak Depo' },
  { slug: 'koycegiz', keys: ['köyceğiz', 'koycegiz', 'köycegiz'], label: 'Köyceğiz', depoBaslik: 'Köyceğiz Depo' },
  { slug: 'tema', keys: ['tema'], label: 'Tema', depoBaslik: 'Tema Depo' },
  { slug: 'zafer', keys: ['zafer'], label: 'Zafer', depoBaslik: 'Zafer Depo' },
];

function magazaAdNorm(s) {
  return String(s || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\u0307/g, '')
    .replace(/ı/g, 'i');
}

function magazaKartBul(kartlar, magazaRow) {
  const list = Array.isArray(kartlar) ? kartlar : [];
  const wantSid = String(magazaRow?.sube_id || '').trim();
  if (wantSid) {
    const hit = list.find((k) => String(k?.sube_id || '').trim() === wantSid);
    if (hit) return hit;
  }
  for (const k of list) {
    const haystack = magazaAdNorm(k.sube_adi || k.sube_id || '');
    for (const key of magazaRow.keys || []) {
      if (haystack.includes(magazaAdNorm(key))) return k;
    }
  }
  return null;
}

/** Hub `kartlar` listesinden aktif şubeler — yeni şube açılınca kod değişmeden kart üretilir. */
function magazaDepoSubelerFromHub(kartlar) {
  const list = Array.isArray(kartlar) ? kartlar : [];
  const byId = new Map();
  const slugCounts = new Map();
  list.forEach((k) => {
    const sid = String(k?.sube_id || '').trim();
    if (!sid || byId.has(sid)) return;
    const label = String(k?.sube_adi || sid).trim() || sid;
    let slug = magazaDepoSlugifyTr(label) || `sube_${sid.slice(0, 8)}`;
    const c = (slugCounts.get(slug) || 0) + 1;
    slugCounts.set(slug, c);
    if (c > 1) slug = `${slug}_${c}`;
    byId.set(sid, {
      slug,
      sube_id: sid,
      keys: [label],
      label,
      depoBaslik: `${label} Depo`,
    });
  });
  const out = Array.from(byId.values());
  out.sort((a, b) => a.label.localeCompare(b.label, 'tr'));
  return out;
}

function magazaDepoEtkinSubeler(kartlar) {
  const hub = magazaDepoSubelerFromHub(kartlar);
  if (hub.length) return hub;
  return MAGAZA_DORT_SUBE.map((m) => ({ ...m, sube_id: '' }));
}

function fmtHHMM(rawTs) {
  if (!rawTs) return '—';
  const s = String(rawTs);
  const tPos = s.indexOf('T');
  if (tPos >= 0 && s.length >= tPos + 6) return s.slice(tPos + 1, tPos + 6);
  if (s.length >= 16 && s[10] === ' ') return s.slice(11, 16);
  return '—';
}

function bugunIsoTarih() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** İstanbul: 00:00–02:00 arası bir önceki takvim günü (backend `tr_saat.is_gunu_tr` ile uyumlu). */
function isGunuIsoIstanbul() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const y = parseInt(parts.find((p) => p.type === 'year')?.value, 10);
    const mo = parseInt(parts.find((p) => p.type === 'month')?.value, 10);
    const da = parseInt(parts.find((p) => p.type === 'day')?.value, 10);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    let yy = y;
    let mm = mo;
    let dd = da;
    if (Number.isFinite(h) && h < 2) {
      const t = new Date(Date.UTC(y, mo - 1, da));
      t.setUTCDate(t.getUTCDate() - 1);
      yy = t.getUTCFullYear();
      mm = t.getUTCMonth() + 1;
      dd = t.getUTCDate();
    }
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  } catch {
    return bugunIsoTarih();
  }
}

/** `YYYY-MM-DD` ± gün (yerel saat). */
function isoTariheGunEkle(isoTarih, gunDelta) {
  const p = String(isoTarih || '').trim().split('-').map((x) => parseInt(x, 10));
  if (p.length !== 3 || !p.every((n) => Number.isFinite(n))) return bugunIsoTarih();
  const dt = new Date(p[0], p[1] - 1, p[2]);
  if (Number.isNaN(dt.getTime())) return bugunIsoTarih();
  dt.setDate(dt.getDate() + (Number(gunDelta) || 0));
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Haftalık geç açılan / açılmayan özet satırı için kısa şube adı listesi. */
function gecAcilanIsimOzet(gecKayitlar, acilListe, maxHer = 5) {
  const gecIsim = (Array.isArray(gecKayitlar) ? gecKayitlar : []).map((k) => String(k?.sube_adi || k?.sube_id || '').trim()).filter(Boolean);
  const acilIsim = (Array.isArray(acilListe) ? acilListe : []).map((k) => String(k?.sube_adi || k?.sube_id || '').trim()).filter(Boolean);
  const par = [];
  if (gecIsim.length) {
    const g = gecIsim.slice(0, maxHer).join(', ');
    par.push(`Geç açılan: ${g}${gecIsim.length > maxHer ? ` (+${gecIsim.length - maxHer})` : ''}`);
  }
  if (acilIsim.length) {
    const g = acilIsim.slice(0, maxHer).join(', ');
    par.push(`Henüz açılmamış: ${g}${acilIsim.length > maxHer ? ` (+${acilIsim.length - maxHer})` : ''}`);
  }
  return par.join(' · ');
}

/** Planlı şube ama o gün ACILIS satırı hiç oluşmamış — haftalık özet için. */
function gecPlanKayitsizIsimOzet(planListe, maxHer = 6) {
  const isim = (Array.isArray(planListe) ? planListe : []).map((x) => String(x?.sube_adi || x?.sube_id || '').trim()).filter(Boolean);
  if (!isim.length) return '';
  const g = isim.slice(0, maxHer).join(', ');
  return `Operasyon kaydı yok: ${g}${isim.length > maxHer ? ` (+${isim.length - maxHer})` : ''}`;
}

function urunAcZirveSaat(akis) {
  const kayitlar = Array.isArray(akis?.kayitlar) ? akis.kayitlar : [];
  if (!kayitlar.length) return null;
  const saatMap = {};
  kayitlar.forEach((k) => {
    const raw = String(k?.saat || '').trim();
    const saat = raw.length >= 2 ? raw.slice(0, 2) : '';
    const saatAnahtar = /^\d{2}$/.test(saat) ? `${saat}:00` : null;
    if (!saatAnahtar) return;
    const adet = Number(k?.adet_toplam || 0);
    saatMap[saatAnahtar] = (saatMap[saatAnahtar] || 0) + (Number.isFinite(adet) ? adet : 0);
  });
  const entries = Object.entries(saatMap);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], 'tr');
  });
  const [saat, adet] = entries[0];
  if (!adet) return null;
  return { saat, adet };
}

const URUN_AC_SUBE_ONCELIK = ['zafer', 'koycegiz', 'alsancak', 'tema'];
// Detay tablosunda sıralı gösterilecek temel kalemler — pasta_* anahtarlar dinamik eklenir
const KULLANILAN_BAZE_KEYS = [
  'bardak_kucuk','bardak_buyuk','bardak_plastik','karton_bardak',
  'su_adet','sut_litre','soda_adet','redbull_adet',
  'cookie_adet','pasta_adet','surup_adet','kahve_paket',
  'kapak_adet','pecete_paket','diger_sarf',
];
const KULLANILAN_LABEL = {
  bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', bardak_plastik:'Plastik', karton_bardak:'Karton Bardak',
  su_adet:'Su', sut_litre:'Süt', soda_adet:'Soda', redbull_adet:'Redbull',
  cookie_adet:'Cookie', pasta_adet:'Pasta (toplam)', surup_adet:'Şurup', kahve_paket:'Kahve Pkt',
  kapak_adet:'Kapak', pecete_paket:'Peçete', diger_sarf:'Diğer',
  pasta_porsiyon_sade:'San Sebastian (Porsiyon)', pasta_porsiyon_antep:'Antep Fıstıklı San Sebastian (Porsiyon)', pasta_porsiyon_cik:'Çikolatalı San Sebastian (Porsiyon)',
  pasta_mag_cilek:'Magnolya Çilekli', pasta_mag_lotus:'Magnolya Lotuslu',
  pasta_buyuk_tart:'Büyük Tart', pasta_kucuk_tart:'Küçük Tart', pasta_snickers:'Snickers',
  pasta_malaga:'Malaga', pasta_latte:'Latte Pasta', pasta_muzlu_rulo:'Muzlu Rulo',
  pasta_cik_rulo:'Çikolatalı Rulo', pasta_meyveli_rulo:'Meyveli Beyaz Çikolatalı Rulo',
  pasta_browni:'Browni', pasta_dilim_ss_sade:'Dilim Sade San Sebastian',
  pasta_cream_puff:'Cream Puff', pasta_kavala:'Kavala Kurabiye',
  pasta_cup_limon:'Limonlu Cup', pasta_cup_yerfistik:'Yer Fıstıklı Cup',
  pasta_cup_cilek:'Çilekli Cup', pasta_cup_karamel:'Karamelli Cup',
  pasta_cup_lotus:'Lotuslu Cup', pasta_cup_antep:'Antep Fıstıklı Cup',
  pasta_cup_hindistan:'Hindistan Cevizli Cup', pasta_profiterol:'Profiterol',
  pasta_kare_cik:'Kare Cheesecake Çikolatalı', pasta_kare_yerfistik:'Kare Cheesecake Yer Fıstıklı Karamelli',
  pasta_kare_karamel:'Kare Cheesecake Karamelli', pasta_kare_limon:'Kare Cheesecake Limonlu',
  pasta_dilim_sade:'Dilim San Sebastian Sade', pasta_dilim_antep:'Dilim San Sebastian Antep Fıstıklı',
  pasta_dilim_cik:'Dilim San Sebastian Çikolatalı', pasta_dilim_yaban:'Dilim San Sebastian Yaban Mersinli',
};

function _sumSatilan(satilan) {
  return Object.values(satilan || {}).reduce((sum, v) => {
    const n = Number(v ?? 0);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

function kullanilanSatirToplamAdet(row) {
  return _sumSatilan(row?.satilan);
}

function kullanilanRowKeys(r) {
  const extra = Object.keys({ ...r?.acilis, ...r?.urun_ac, ...r?.kapanis, ...r?.satilan })
    .filter((k) => !KULLANILAN_BAZE_KEYS.includes(k));
  return [...KULLANILAN_BAZE_KEYS, ...extra];
}

/** Haftalık özet ve detayda şube adına göre sabit sıra (karışık listelenmesin). */
function kullanilanSatirlariSubeyeGoreSirala(satirlar) {
  return [...(Array.isArray(satirlar) ? satirlar : [])].sort((a, b) => {
    const la = String(a?.sube_adi || a?.sube_id || 'Ö').trim() || 'Ö';
    const lb = String(b?.sube_adi || b?.sube_id || 'Ö').trim() || 'Ö';
    return la.localeCompare(lb, 'tr');
  });
}

function urunAcSubeAnahtar(raw) {
  const s = String(raw || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
  for (const k of URUN_AC_SUBE_ONCELIK) {
    if (s.includes(k)) return k;
  }
  return s;
}

function urunAcSubeGruplari(kayitlar) {
  const rows = Array.isArray(kayitlar) ? kayitlar : [];
  const map = new Map();
  rows.forEach((k) => {
    const label = String(k?.sube_adi || k?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(label) || label;
    const prev = map.get(key);
    if (prev) {
      prev.kayitlar.push(k);
      prev.toplamIslem += 1;
      prev.toplamAdet += Number(k?.adet_toplam || 0) || 0;
    } else {
      map.set(key, {
        key,
        baslik: label,
        kayitlar: [k],
        toplamIslem: 1,
        toplamAdet: Number(k?.adet_toplam || 0) || 0,
      });
    }
  });
  const out = Array.from(map.values());
  out.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return String(a.baslik || '').localeCompare(String(b.baslik || ''), 'tr');
  });
  return out;
}

/** İstanbul saati — kapanış uyarılarını öğleden sonra göstermek için. */
function hubLocalHourTr() {
  try {
    const parts = new Intl.DateTimeFormat('tr-TR', {
      hour: 'numeric',
      hour12: false,
      timeZone: 'Europe/Istanbul',
    }).formatToParts(new Date());
    const hp = parts.find((p) => p.type === 'hour');
    const n = hp ? parseInt(hp.value, 10) : NaN;
    return Number.isFinite(n) ? n : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

/** Dashboard kartlarından bugünkü ACILIS/KAPANIS özet bucket'ı (sube_operasyon_event özetleri). */
function hubAcilisKapanisBucket(kartlar) {
  const list = Array.isArray(kartlar) ? kartlar : [];
  const h = hubLocalHourTr();
  // 15:00 sonrası veya gece 02:00 öncesi: kapanış hâlâ «aynı iş günü» kabul edilir (kasa girişi gecikebilir).
  const aksamKapanisListe = h >= 15 || h < 2;

  const acilisBekliyor = [];
  const acilisGecikti = [];
  const kapanisBekliyor = [];
  const kapanisGecikti = [];

  for (const k of list) {
    const oz = k.ozet || {};
    const ad = String(k.sube_adi || k.sube_id || '').trim() || String(k.sube_id || '');
    const sid = k.sube_id;
    if (!oz.acilis_tamam) {
      if (oz.acilis_gecikti) acilisGecikti.push({ sid, ad });
      else acilisBekliyor.push({ sid, ad });
    }
    if (!oz.kapanis_tamam) {
      if (oz.kapanis_gecikti) kapanisGecikti.push({ sid, ad });
      else if (aksamKapanisListe || !k.sube_acik) kapanisBekliyor.push({ sid, ad });
    }
  }

  const sorunSayisi = acilisBekliyor.length + acilisGecikti.length + kapanisBekliyor.length + kapanisGecikti.length;

  return {
    saatTr: h,
    aksamKapanisListe,
    acilisBekliyor,
    acilisGecikti,
    kapanisBekliyor,
    kapanisGecikti,
    sorunSayisi,
    subeSayisi: list.length,
  };
}

function hubScrollToSubeKart(subeId) {
  const sid = String(subeId || '').trim();
  if (!sid || typeof document === 'undefined') return;
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(sid) : sid.replace(/"/g, '\\"');
  const el = document.querySelector(`[data-ops-sube-id="${esc}"]`);
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function HubGunlukAcilisKapanisCard({ bucket }) {
  if (!bucket || bucket.subeSayisi === 0) return null;

  const chip = (row) => (
    <button
      key={String(row.sid)}
      type="button"
      className="btn btn-secondary btn-sm"
      style={{ padding: '2px 8px', fontSize: 11 }}
      onClick={(e) => {
        e.preventDefault();
        hubScrollToSubeKart(row.sid);
      }}
    >
      {row.ad}
    </button>
  );

  const blok = (baslik, rows, renk, aciklama) => {
    if (!rows.length) return null;
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: renk, marginBottom: 6 }}>{baslik}</div>
        <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 6px', lineHeight: 1.45 }}>{aciklama}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rows.map(chip)}
        </div>
      </div>
    );
  };

  const tamam = bucket.sorunSayisi === 0;

  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        padding: '12px 14px',
        borderLeft: `4px solid ${tamam ? '#22c55e' : '#ea580c'}`,
        background: tamam ? 'var(--bg2)' : 'rgba(234, 88, 12, 0.06)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>Bugün · Açılış / kapanış özeti</h3>
          <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text3)' }}>Saat ~{bucket.saatTr}:00 itibarıyla</p>
        </div>
        {tamam ? (
          <span className="badge badge-green" style={{ flexShrink: 0 }}>Eksik adım yok</span>
        ) : (
          <span className="badge badge-red" style={{ flexShrink: 0 }}>{bucket.sorunSayisi} şube</span>
        )}
      </div>

      {tamam ? (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text2)' }}>
          Tüm aktif şubelerde bugünkü özet alanlarında açılış tamam ve (veya beklenen koşullarda) kapanış için kritik eksik görünmüyor.
        </p>
      ) : (
        <div style={{ marginTop: 10 }}>
          {blok(
            '🌅 Açılış bekliyor',
            bucket.acilisBekliyor,
            '#ca8a04',
            'ACILIS henüz tamamlanmamış (slot içi).',
          )}
          {blok(
            '🚨 Açılış gecikti',
            bucket.acilisGecikti,
            '#dc2626',
            'ACILIS süresi aşıldı — şube panelinde önceliklidir.',
          )}
          {blok(
            '🌙 Kapanış bekliyor',
            bucket.kapanisBekliyor,
            '#ea580c',
            'KAPANIS henüz tamamlanmamış (akşam penceresi veya şube kapalı sinyali sonrası listelenir).',
          )}
          {blok(
            '🚨 Kapanış gecikti',
            bucket.kapanisGecikti,
            '#dc2626',
            'Kapanış penceresi kaçmış olabilir.',
          )}
        </div>
      )}
    </div>
  );
}

function operasyonTipOzeti(kart, tip) {
  const events = kart?.operasyon?.events || [];
  const adaylar = events.filter((e) => String(e?.tip || '').toUpperCase() === tip);
  if (!adaylar.length) return null;
  const sirali = [...adaylar].sort((a, b) => {
    const aTs = String(a?.cevap_ts || a?.sistem_slot_ts || '');
    const bTs = String(b?.cevap_ts || b?.sistem_slot_ts || '');
    return aTs.localeCompare(bTs);
  });
  const e = sirali[sirali.length - 1] || {};
  const durum = String(e?.durum || '').toLowerCase();
  const saat = fmtHHMM(e?.cevap_ts || e?.sistem_slot_ts);
  if (durum === 'tamamlandi') return { text: `${saat} ✅`, badge: 'badge-green' };
  if (durum === 'gecikti') return { text: `${saat} ⚠️`, badge: 'badge-red' };
  if (durum === 'bekliyor' || durum === 'devam' || durum === 'aktif') return { text: '⏳', badge: 'badge-yellow' };
  return { text: '—', badge: 'badge-gray' };
}

const OPS_TIP_IKON  = { ACILIS: '🌅', KONTROL: '🔍', KAPANIS: '🌙', CIKIS: '🚪' };
const OPS_TIP_LABEL = { ACILIS: 'Açılış', KONTROL: 'Kontrol', KAPANIS: 'Kapanış', CIKIS: 'Çıkış' };
const insancaDk = dk => { const sa = Math.floor(dk / 60); const kdk = dk % 60; return sa > 0 ? (kdk > 0 ? `${sa}sa ${kdk}dk` : `${sa}sa`) : `${dk}dk`; };
const temizMesaj = m => (m || '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/\{[^}]*\}/g, '').replace(/\s{2,}/g, ' ').trim();

function SubeKart({ k, onDetay, personelRisk }) {
  const b   = k.bayraklar || {};
  const o   = k.ozet || {};
  const op  = k.operasyon || {};
  const aktif = op.aktif;
  const vurgu = computeOpsKartVurgu(k);
  const satisTahminToplam = Number(k.satis_tahmin_toplam || k.satis_tahmini_toplam || 0);

  // Kart rengi
  let borderColor = 'var(--border)';
  if (b.kritik)       borderColor = 'var(--red)';
  else if (b.geciken) borderColor = '#f08040';

  // Operasyon olaylarının durumu
  const allEv = op.events || [];
  const displayEv = allEv.slice(0, 5);
  const acilisEv = allEv.filter(e => e.tip === 'ACILIS');
  const digerDisplay = vurgu.mode === 'acilis'
    ? displayEv.filter(e => e.tip !== 'ACILIS')
    : displayEv;

  const uyarilar = k.uyarilar || [];
  const g = k.guvenlik || {};
  const ad = g.alarm_durum;

  // Açılış zamanlaması — vardiya planı vs gerçek
  const bekSaati  = k.beklenen_acilis_saati || '';   // "08:30"
  const gerSaati  = (k.acilis_saat || '').slice(0, 5); // "09:10"
  const acilisZamanlama = (() => {
    if (!bekSaati && !gerSaati) return null;
    if (bekSaati && gerSaati) {
      const [bh, bm] = bekSaati.split(':').map(Number);
      const [gh, gm] = gerSaati.split(':').map(Number);
      const gecDk = (gh * 60 + gm) - (bh * 60 + bm);
      if (gecDk > 2)  return { tip: 'gec',   dk: gecDk,          metin: `Açıldı ${gerSaati} · Beklenen ${bekSaati} · +${gecDk}dk gecikme` };
      if (gecDk < -2) return { tip: 'erken', dk: Math.abs(gecDk), metin: `Açıldı ${gerSaati} · Beklenen ${bekSaati} · ${Math.abs(gecDk)}dk erken` };
      return { tip: 'tamam', dk: 0, metin: `Açıldı ${gerSaati} · Zamanında (Beklenen ${bekSaati})` };
    }
    if (bekSaati && !gerSaati) return { tip: 'bekliyor', dk: 0, metin: `Beklenen açılış: ${bekSaati}${k.beklenen_acilis_personel ? ' · ' + k.beklenen_acilis_personel : ''}` };
    return { tip: 'acildi', dk: 0, metin: `Açıldı: ${gerSaati}` };
  })();

  const eventChip = e => {
    const renk = e.durum === 'tamamlandi' ? 'var(--green)' : e.durum === 'gecikti' ? 'var(--red)' : 'var(--text3)';
    return (
      <span key={e.id} style={{ fontSize: 11, color: renk, display: 'flex', alignItems: 'center', gap: 3 }}>
        {OPS_TIP_IKON[e.tip] || '○'} {OPS_TIP_LABEL[e.tip] || e.tip}
        {e.durum === 'gecikti' && op.aktif_gecikme_dk != null && e.id === aktif?.id
          ? ` (${insancaDk(op.aktif_gecikme_dk)})` : ''}
      </span>
    );
  };

  return (
    <div
      data-ops-sube-id={k.sube_id || ''}
      className={vurgu.mode === 'card' ? 'ops-pulse-card' : undefined}
      style={{
        background: 'var(--bg2)',
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: b.kritik ? '0 0 0 1px rgba(224,92,92,.25)' : 'none',
        cursor: 'pointer',
        transition: 'border-color .2s',
      }}
      onClick={() => onDetay(k)}
    >
      {/* Başlık */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{k.sube_adi || k.sube_id}</span>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {b.kritik   && <span className="badge badge-red">KRİTİK</span>}
          {!b.kritik && b.geciken && <span className="badge badge-yellow">Gecikme</span>}
          {b.fark_var && <span className="badge badge-yellow">Fark</span>}
          {b.guvenlik_alarm && <span className="badge badge-red">Güvenlik</span>}
          {!!personelRisk?.adet && (
            <span className={`badge ${personelRisk.maxSkor >= 45 ? 'badge-red' : 'badge-yellow'}`}>
              👤 Riskli personel: {personelRisk.adet}
            </span>
          )}
        </div>
      </div>

      {/* Durum satırı */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className={`badge ${k.kasa_acik ? 'badge-green' : 'badge-gray'}`}>
          {k.kasa_acik ? 'Kasa açık' : 'Kasa kilitli'}
        </span>
        <span className={`badge ${k.sube_acik ? 'badge-green' : 'badge-gray'}`}>
          {k.sube_acik ? 'Şube açık' : 'Şube kapalı'}
        </span>
        {vurgu.mode === 'ciro_text' ? (
          <span className="badge badge-yellow ops-pulse-text-only" title="Kapanış tamam; onaylı ciro veya bekleyen taslak yok">
            Kapanış yapıldı — kanıt ciro yok
          </span>
        ) : (
          <span className={`badge ${k.ciro_girildi ? 'badge-green' : k.ciro_taslak_bekliyor ? 'badge-yellow' : 'badge-gray'}`}>
            {k.ciro_girildi ? '✓ Ciro' : k.ciro_taslak_bekliyor ? '⏳ Onayda' : 'Ciro yok'}
          </span>
        )}
        {k.ciro_taslak_gecikti && !k.ciro_girildi && (
          <span className="badge badge-yellow" title="Ciro taslağı 6 saatten uzun süredir onay bekliyor">
            ⚠️ Taslak gecikiyor
          </span>
        )}
        {satisTahminToplam > 0 && (
          <span className="badge badge-yellow">📉 Satış açığı var</span>
        )}
      </div>


      {/* Operasyon events */}
      {displayEv.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vurgu.mode === 'acilis' && acilisEv.length > 0 && (
            <div className="ops-pulse-acilis-wrap" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text3)', width: '100%' }}>Açılış (gecikerek tamamlandı)</span>
              {acilisEv.map(eventChip)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {digerDisplay.map(eventChip)}
          </div>
        </div>
      )}

      {/* Vardiya + özet bayraklar — tek satır */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: k.vardiya_devri_tamam ? 'var(--green)' : k.vardiya_devri_basladi ? 'var(--yellow)' : 'var(--text3)' }}>
          {k.vardiya_devri_tamam ? '✓ Vardiya' : k.vardiya_devri_basladi ? '⏳ Vardiya' : '— Vardiya'}
        </span>
        {(o.alarm_sayisi_toplam || 0) > 0 && (
          <span className="badge badge-red" title="Güvenlik alarmı — detay için tıkla">
            🔐 {o.alarm_sayisi_toplam} güvenlik
          </span>
        )}
        {uyarilar.filter(u => u.seviye === 'kritik').length > 0 && (
          <span
            className="badge badge-red"
            title={uyarilar.filter(u => u.seviye === 'kritik').map(u => temizMesaj(u.mesaj)).join('\n')}
          >
            🚨 {uyarilar.filter(u => u.seviye === 'kritik').length} kritik
          </span>
        )}
        {uyarilar.filter(u => u.seviye !== 'kritik').length > 0 && (
          <span
            className="badge badge-yellow"
            title={uyarilar.filter(u => u.seviye !== 'kritik').map(u => temizMesaj(u.mesaj)).join('\n')}
          >
            ⚠️ {uyarilar.filter(u => u.seviye !== 'kritik').length} uyarı
          </span>
        )}
        {b.guvenlik_alarm && !ad && (
          <span className="badge badge-red" title={g.mesaj || 'Güvenlik alarmı aktif'}>🔐 Alarm aktif</span>
        )}
        {ad && (
          <span className="badge badge-gray" title={`Son işlem: ${ad.durum}`}>🔐 {ad.durum === 'susturuldu' ? 'Susturuldu' : 'Okundu'}</span>
        )}
      </div>
    </div>
  );
}

function DetayModal({ kart, onKapat, filtre, onYenileDetay }) {
  if (!kart) return null;
  const b  = kart.bayraklar || {};
  const o  = kart.ozet || {};
  const op = kart.operasyon || {};
  const g  = kart.guvenlik || {};
  const ad = g.alarm_durum;

  const [alarmNot, setAlarmNot] = useState('');
  const [alarmPid, setAlarmPid] = useState('');
  const [susturDk, setSusturDk] = useState(120);
  const [alarmBusy, setAlarmBusy] = useState(false);

  const alarmBody = () => {
    const notu = (alarmNot || '').trim();
    const personel_id = (alarmPid || '').trim();
    return {
      ...(personel_id ? { personel_id } : {}),
      ...(notu ? { notu } : {}),
    };
  };

  const okundu = async (e) => {
    e?.stopPropagation?.();
    setAlarmBusy(true);
    try {
      await api(`/ops/guvenlik-alarmlar/${encodeURIComponent(kart.sube_id)}/okundu`, {
        method: 'POST',
        body: alarmBody(),
      });
      if (onYenileDetay) await onYenileDetay(kart.sube_id, filtre);
    } catch (err) {
      window.alert(err.message || 'İşlem başarısız');
    } finally {
      setAlarmBusy(false);
    }
  };

  const sustur = async (e) => {
    e?.stopPropagation?.();
    setAlarmBusy(true);
    try {
      await api(`/ops/guvenlik-alarmlar/${encodeURIComponent(kart.sube_id)}/sustur`, {
        method: 'POST',
        body: { ...alarmBody(), sustur_dk: Math.max(5, Math.min(1440, Number(susturDk) || 120)) },
      });
      if (onYenileDetay) await onYenileDetay(kart.sube_id, filtre);
    } catch (err) {
      window.alert(err.message || 'İşlem başarısız');
    } finally {
      setAlarmBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <div className="modal-header">
          <h3>{kart.sube_adi}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Bayraklar */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge ${kart.kasa_acik ? 'badge-green' : 'badge-gray'}`}>{kart.kasa_acik ? 'Kasa açık' : 'Kasa kilitli'}</span>
            <span className={`badge ${kart.sube_acik ? 'badge-green' : 'badge-gray'}`}>{kart.sube_acik ? 'Şube açık' : 'Şube kapalı'}</span>
            <span className={`badge ${kart.ciro_girildi ? 'badge-green' : kart.ciro_taslak_bekliyor ? 'badge-yellow' : 'badge-red'}`}>
              {kart.ciro_girildi ? '✓ Ciro onaylı' : kart.ciro_taslak_bekliyor ? '⏳ Ciro onayda' : '✕ Ciro yok'}
            </span>
            {kart.ciro_taslak_gecikti && !kart.ciro_girildi && (
              <span className="badge badge-yellow" title="Ciro taslağı 6 saatten fazladır onay bekliyor">⚠️ Taslak gecikiyor</span>
            )}
            {b.kritik    && <span className="badge badge-red">KRİTİK</span>}
            {b.fark_var  && <span className="badge badge-yellow">Kasa farkı: {b.fark_tl?.toFixed(0)} ₺</span>}
          </div>

          {/* Açılış zamanlaması — vardiya planı vs gerçek */}
          {(kart.beklenen_acilis_saati || kart.acilis_saat) && (() => {
            const bek = kart.beklenen_acilis_saati || '';
            const ger = (kart.acilis_saat || '').slice(0, 5);
            let renk = 'var(--text3)'; let ikon = '⏰'; let satir = '';
            if (bek && ger) {
              const gecDk = (parseInt(ger.split(':')[0])*60 + parseInt(ger.split(':')[1])) - (parseInt(bek.split(':')[0])*60 + parseInt(bek.split(':')[1]));
              if (gecDk > 2)  { renk = 'var(--red)';   ikon = '⚠️'; satir = `Açıldı ${ger} · Beklenen ${bek} · +${gecDk}dk gecikme`; }
              else if (gecDk < -2) { renk = 'var(--green)'; ikon = '✅'; satir = `Açıldı ${ger} · Beklenen ${bek} · ${Math.abs(gecDk)}dk erken`; }
              else            { renk = 'var(--green)'; ikon = '✅'; satir = `Açıldı ${ger} · Zamanında (Beklenen ${bek})`; }
            } else if (bek) { renk = '#f59e0b'; ikon = '⏰'; satir = `Beklenen açılış: ${bek}${kart.beklenen_acilis_personel ? ' · ' + kart.beklenen_acilis_personel : ''}`; }
            else             { renk = 'var(--green)'; ikon = '✅'; satir = `Açıldı: ${ger}`; }
            return (
              <div style={{ padding: '8px 12px', background: 'var(--bg3)', borderRadius: 7, fontSize: 12, color: renk, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span>{ikon}</span>
                <span style={{ flex: 1 }}>{satir}</span>
                {kart.beklened_acilis_personel && bek && ger && (
                  <span style={{ color: 'var(--text3)', fontSize: 11 }}>Planlı: {kart.beklenen_acilis_personel}</span>
                )}
              </div>
            );
          })()}

          {/* Operasyon events */}
          {(op.events || []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Operasyon Olayları</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {op.events.map(e => {
                  const renk = e.durum === 'tamamlandi' ? 'var(--green)' : e.durum === 'gecikti' ? 'var(--red)' : 'var(--yellow)';
                  const saat = (e.sistem_slot_ts || '').substring(11, 16);
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--bg3)', borderRadius: 6, fontSize: 13 }}>
                      <span>{OPS_TIP_IKON[e.tip] || '○'} {OPS_TIP_LABEL[e.tip] || e.tip} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({saat})</span></span>
                      <span style={{ color: renk, fontWeight: 500 }}>
                        {e.durum === 'tamamlandi' ? 'Tamamlandı' : e.durum === 'gecikti' ? `Gecikti${op.aktif_gecikme_dk ? ` · ${insancaDk(op.aktif_gecikme_dk)}` : ''}` : 'Bekliyor'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ozet */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            {[
              ['Açılış op', o.acilis_tamam ? '✓ Tamamlandı' : o.acilis_gecikti ? '! Gecikti' : 'Henüz başlamadı'],
              ['Kapanış op', o.kapanis_tamam ? '✓ Tamamlandı' : o.kapanis_gecikti ? '! Gecikti' : 'Henüz başlamadı'],
              ['Kontrol bekleyen', o.kontrol_bekleyen ?? 'Yok'],
              ['Alarm sayısı', o.alarm_sayisi_toplam ?? 0],
              ['Vardiya devri', kart.vardiya_devri_tamam ? 'Tamamlandı' : kart.vardiya_devri_basladi ? 'Devam ediyor' : 'Başlamadı'],
            ].map(([label, val]) => (
              <div key={label} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ color: 'var(--text3)', marginBottom: 3 }}>{label}</div>
                <div style={{ fontWeight: 500 }}>{String(val)}</div>
              </div>
            ))}
          </div>

          {/* Ürün Açma Uyumsuzluğu */}
          {(kart.uyarilar || []).filter(u => u.tip === 'URUN_AC_UYUMSUZLUK').length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#f87171', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🚨</span> Ürün Açma Uyumsuzluğu
              </div>
              {(kart.uyarilar || []).filter(u => u.tip === 'URUN_AC_UYUMSUZLUK').map((u, i) => (
                <div key={i} style={{
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.4)',
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 12,
                  color: 'var(--text2)',
                  marginBottom: 5,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  <span>{temizMesaj(u.mesaj)}</span>
                  {u.fark_tl != null && (
                    <span style={{ whiteSpace: 'nowrap', color: '#fca5a5', fontWeight: 700 }}>
                      +{Number(u.fark_tl).toFixed(0)} adet
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Genel Uyarılar (URUN_AC_UYUMSUZLUK hariç) */}
          {(kart.uyarilar || []).filter(u => u.tip !== 'URUN_AC_UYUMSUZLUK').length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Uyarılar</div>
              {(kart.uyarilar || []).filter(u => u.tip !== 'URUN_AC_UYUMSUZLUK').map((u, i) => (
                <div key={i} className={`alert-box ${u.seviye === 'kritik' ? 'red' : 'yellow'}`} style={{ marginBottom: 6 }}>
                  <strong>{u.seviye?.toUpperCase()}</strong> {temizMesaj(u.mesaj)}
                  {u.fark_tl != null && <span style={{ marginLeft: 6, opacity: .7 }}>Fark: {u.fark_tl?.toFixed(0)} ₺</span>}
                </div>
              ))}
            </div>
          )}

          {/* Güvenlik alarmı (Faz 6–7) */}
          {(g.alarm || ad || g.mesaj) && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                Güvenlik alarmı
              </div>
              {g.mesaj && (
                <div className="alert-box red" style={{ marginBottom: 10 }}>
                  {g.mesaj}
                  {g.seviye && <span style={{ marginLeft: 8, opacity: 0.85 }}>({g.seviye})</span>}
                </div>
              )}
              {ad && (
                <div style={{ fontSize: 13, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                  <div><strong>Durum:</strong> {ad.durum}</div>
                  {ad.islem_ts && (
                    <div className="mono" style={{ marginTop: 4 }}>
                      <strong>İşlem saati:</strong> {String(ad.islem_ts).replace('T', ' ').slice(0, 19)}
                    </div>
                  )}
                  {ad.sustur_bitis_ts && (
                    <div className="mono" style={{ marginTop: 4 }}>
                      <strong>Susturma bitiş:</strong> {String(ad.sustur_bitis_ts).replace('T', ' ').slice(0, 19)}
                    </div>
                  )}
                  {ad.islem_notu && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text3)' }}>Not: {ad.islem_notu}</div>}
                  {ad.islem_personel_id && (
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text3)' }}>Personel: {ad.islem_personel_id}</div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  İşlemi yapan personel ID (opsiyonel)
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 4 }}
                    value={alarmPid}
                    onChange={(e) => setAlarmPid(e.target.value)}
                    placeholder="personel uuid"
                  />
                </label>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Not (opsiyonel)
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 4 }}
                    value={alarmNot}
                    onChange={(e) => setAlarmNot(e.target.value)}
                    placeholder="Kısa açıklama"
                  />
                </label>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Susturma süresi (dk, 5–1440)
                  <input
                    type="number"
                    className="input"
                    style={{ width: 120, marginTop: 4, display: 'block' }}
                    min={5}
                    max={1440}
                    value={susturDk}
                    onChange={(e) => setSusturDk(Number(e.target.value))}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={alarmBusy} onClick={okundu}>
                  Okundu
                </button>
                <button type="button" className="btn btn-sm" disabled={alarmBusy} onClick={sustur}>
                  Sustur
                </button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, marginBottom: 0 }}>
                Okundu: kayıt + işlem saati. Sustur: belirtilen süre boyunca alarm kartta gizlenir (bitiş saati yukarıda).
              </p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onKapat}>Kapat</button>
        </div>
      </div>
    </div>
  );
}

// ─── STOK KAYIP PANELİ ───────────────────────────────────────────────────────

const RISK_CFG = {
  yuksek: { label: 'Yüksek Risk', renk: '#ef4444', bg: 'rgba(239,68,68,0.1)', icon: '🔴' },
  orta:   { label: 'Orta Risk',   renk: '#f97316', bg: 'rgba(249,115,22,0.1)', icon: '🟠' },
  dusuk:  { label: 'Düşük',       renk: '#94a3b8', bg: 'rgba(148,163,184,0.1)', icon: '⚪' },
};

function StokKayipPanel({ veri }) {
  if (!veri) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>📦</div>
        <div style={{ fontSize: 14 }}>Analiz yükleniyor…</div>
      </div>
    );
  }

  const subeOzet       = veri.sube_ozet || [];
  const riskPersonel   = veri.surekli_acik_personel || [];
  const veriEksik      = veri.veri_eksik_gun_sayisi || 0;
  const gun            = veri.gun_sayi || 45;
  const toplamKayip    = subeOzet.reduce((a, s) => a + (s.toplam_acik || 0), 0);
  const yuksekRisk     = riskPersonel.filter((p) => p.risk_seviyesi === 'yuksek');
  const ortaRisk       = riskPersonel.filter((p) => p.risk_seviyesi === 'orta');
  const toplamRiskUyari = yuksekRisk.length > 0
    ? `🔴 ${yuksekRisk.length} yüksek risk${ortaRisk.length > 0 ? ` · 🟠 ${ortaRisk.length} orta risk` : ''} — HR veya mağaza müdürü bilgilendirilmeli.`
    : ortaRisk.length > 0 ? `🟠 ${ortaRisk.length} orta riskli personel — yakından izlenmeli.` : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── ÖZET STAT BARI ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Sapma Tespit Edilen Şube', val: subeOzet.length, renk: subeOzet.length > 0 ? '#ef4444' : '#22c55e', icon: '🏪' },
          { label: 'Toplam Açıklanamayan Birim', val: toplamKayip, renk: toplamKayip > 0 ? '#f97316' : '#22c55e', icon: '📦' },
          { label: 'Risk Altında Personel', val: riskPersonel.length, renk: riskPersonel.length > 0 ? '#f97316' : '#94a3b8', icon: '👤' },
          { label: 'Veri Eksik Gün', val: veriEksik, renk: veriEksik > 0 ? '#eab308' : '#94a3b8', icon: '⚠️' },
        ].map((st) => (
          <div key={st.label} style={{
            flex: '1 1 140px',
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 14px',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{st.icon} {st.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: st.renk }}>{st.val}</div>
          </div>
        ))}
      </div>

      {/* ── VERİ EKSİK UYARISI ── */}
      {veriEksik > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.35)',
        }}>
          <span style={{ fontSize: 16 }}>⚠️</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#eab308' }}>
              {veriEksik} günde açılış kaydı eksik
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
              Bu günlere ait kapanış verileri analiz dışında tutuldu. Şube personelinin açılış formunu doldurduğundan emin olun.
            </div>
          </div>
        </div>
      )}

      {/* ── RİSK PERSONELİ ── */}
      {riskPersonel.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14 }}>🚨</span>
            <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text1)' }}>Tekrarlı Kayıp — Personel İzleme</span>
            <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>Son {gun} gün · Exception-Based Reporting</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {riskPersonel.map((p, i) => {
              const rc = RISK_CFG[p.risk_seviyesi] || RISK_CFG.dusuk;
              return (
                <div key={`${p.personel_id || p.personel_ad}-${i}`} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px',
                  borderBottom: i < riskPersonel.length - 1 ? '1px solid var(--border)' : 'none',
                  background: rc.bg,
                }}>
                  {/* Risk badge */}
                  <span style={{
                    flex: '0 0 auto',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: rc.renk + '22', color: rc.renk,
                    border: `1px solid ${rc.renk}55`,
                    borderRadius: 20, padding: '2px 9px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                  }}>
                    {rc.icon} {rc.label}
                  </span>
                  {/* İsim + şube */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>
                      {p.personel_ad || p.personel_id || '—'}
                      {p.cok_sube && (
                        <span style={{ marginLeft: 6, fontSize: 10, background: '#7c3aed22', color: '#7c3aed', borderRadius: 4, padding: '1px 6px', fontWeight: 700 }}>
                          ÇOK ŞUBE
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>{p.sube_adi || p.sube_id}</div>
                  </div>
                  {/* Sayılar */}
                  <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: rc.renk }}>{p.toplam_acik} birim</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>{p.acik_gun_sayisi} günde · {p.acik_kalem} kalem</div>
                  </div>
                </div>
              );
            })}
          </div>
          {toplamRiskUyari && (
            <div style={{ padding: '8px 14px', background: yuksekRisk.length > 0 ? 'rgba(239,68,68,0.06)' : 'rgba(249,115,22,0.06)', borderTop: '1px solid var(--border)', fontSize: 12, color: yuksekRisk.length > 0 ? '#ef4444' : '#f97316' }}>
              {toplamRiskUyari}
            </div>
          )}
        </div>
      )}

      {/* ── ŞUBE BAZLI SAPMA TABLOSU ── */}
      {subeOzet.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Son {gun} günde açıklanamayan stok sapması yok</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
            📉 Şube Bazlı Sapma — Son {gun} Gün
          </div>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Şube</th>
                  <th style={{ textAlign: 'right' }}>Açık Birim</th>
                  <th style={{ textAlign: 'right' }}>Kalem</th>
                  <th style={{ textAlign: 'right' }}>Gün Sayısı</th>
                  <th style={{ textAlign: 'right' }}>Günlük Ort.</th>
                </tr>
              </thead>
              <tbody>
                {subeOzet.map((s, i) => {
                  const ort = s.acik_gun_sayisi > 0 ? (s.toplam_acik / s.acik_gun_sayisi).toFixed(1) : '—';
                  const yuksek = s.toplam_acik >= 20 || s.acik_gun_sayisi >= 5;
                  return (
                    <tr key={`${s.sube_id}-${i}`} style={yuksek ? { background: 'rgba(239,68,68,0.06)' } : {}}>
                      <td style={{ fontWeight: 600 }}>
                        {s.sube_adi || s.sube_id}
                        {yuksek && <span style={{ marginLeft: 6, fontSize: 10, color: '#ef4444' }}>●</span>}
                      </td>
                      <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: s.toplam_acik > 0 ? '#f97316' : 'inherit' }}>
                        {s.toplam_acik}
                      </td>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--text3)' }}>{s.acik_kalem}</td>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--text3)' }}>{s.acik_gun_sayisi}</td>
                      <td className="mono" style={{ textAlign: 'right', color: 'var(--text3)' }}>{ort}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'right' }}>
        Formül: Açılış stoku + Eklenen − Kapanış stoku = Açıklanamayan fark.
        İş günü sınırı {veri.is_gunu_siniri_saat || 6}:00 (gece geçişi düzeltmesi aktif).
      </div>
    </div>
  );
}

// ─── SİPARİŞ GEÇMİŞİ ────────────────────────────────────────────────────────

const DURUM_LABEL = {
  bekliyor:       { label: 'Bekliyor',       renk: '#4a9eff', icon: '🕐' },
  teslim_edildi:  { label: 'Teslim Edildi',  renk: '#22c55e', icon: '✅' },
  iptal:          { label: 'İptal',          renk: '#94a3b8', icon: '✕' },
  gonderilmedi:   { label: 'Gönderilmedi',   renk: '#f97316', icon: '⚠️' },
};

function gorececTarih(tarihStr) {
  if (!tarihStr) return '—';
  const bugun = new Date();
  bugun.setHours(0, 0, 0, 0);
  const fark = Math.round((bugun - new Date(String(tarihStr).slice(0, 10))) / 86400000);
  if (fark === 0) return 'Bugün';
  if (fark === 1) return 'Dün';
  if (fark < 7) return `${fark} gün önce`;
  if (fark < 30) return `${Math.round(fark / 7)} hafta önce`;
  return `${Math.round(fark / 30)} ay önce`;
}

function kalemOzet(kalemler) {
  if (!Array.isArray(kalemler) || !kalemler.length) return null;
  return kalemler
    .filter((k) => k && parseInt(k.adet || 0) > 0)
    .slice(0, 3)
    .map((k) => `${k.urun_adi || k.kalem_kodu || '?'}: ${k.adet}`)
    .join(' · ');
}

function SiparisGecmisPanel() {
  const [veri, setVeri]               = useState(null);
  const [yukleniyor, setYukleniyor]   = useState(false);
  const [gun, setGun]                 = useState(90);
  const [durumFiltre, setDurumFiltre] = useState('');
  const [subeFiltre, setSubeFiltre]   = useState('');
  const [acikSatir, setAcikSatir]     = useState(null);
  const [yenidenAcBusy, setYenidenAcBusy] = useState(null);

  const yukle = useCallback(async (opts = {}) => {
    const g = opts.gun      ?? gun;
    const d = opts.durum    ?? durumFiltre;
    const s = opts.sube     ?? subeFiltre;
    setYukleniyor(true);
    try {
      const q = new URLSearchParams({ gun: g });
      if (d) q.set('durum', d);
      if (s.trim()) q.set('sube_arama', s.trim());
      const r = await api(`/ops/siparis/gecmis?${q}`);
      setVeri(r);
    } catch (e) {
      alert(e.message || 'Geçmiş yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { yukle({}); }, []); // eslint-disable-line

  const getir = () => { setAcikSatir(null); yukle({ gun, durum: durumFiltre, sube: subeFiltre }); };

  const yenidenAc = useCallback(async (talep_id) => {
    if (!window.confirm('Bu siparişi tekrar kuyruğa almak istediğinizden emin misiniz?')) return;
    setYenidenAcBusy(talep_id);
    try {
      await api(`/ops/siparis/gecmis/${encodeURIComponent(talep_id)}/yeniden-ac`, { method: 'POST' });
      setAcikSatir(null);
      yukle({ gun, durum: durumFiltre, sube: subeFiltre });
    } catch (e) {
      alert(e.message || 'Yeniden açma başarısız');
    } finally {
      setYenidenAcBusy(null);
    }
  }, [yukle, gun, durumFiltre, subeFiltre]);

  const ozet   = veri?.ozet   || {};
  const satirlar = veri?.satirlar || [];
  const toplamKayit = Object.values(ozet).reduce((a, b) => a + b, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── ÜST BAR: arama + zaman ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160, maxWidth: 300 }}>
          <input
            className="input"
            style={{ width: '100%', paddingRight: 28 }}
            placeholder="🔍  Şube adıyla ara…"
            value={subeFiltre}
            onChange={(e) => setSubeFiltre(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && getir()}
          />
          {subeFiltre && (
            <button
              type="button"
              onClick={() => { setSubeFiltre(''); }}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', fontSize: 14, lineHeight: 1 }}
            >✕</button>
          )}
        </div>

        {/* Zaman seçici — pill butonlar */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[7, 30, 90, 180, 365].map((g) => (
            <button
              key={g}
              type="button"
              className="btn btn-sm"
              style={{
                padding: '4px 10px',
                fontSize: 12,
                background: gun === g ? 'var(--accent)' : 'var(--bg3)',
                color: gun === g ? '#fff' : 'var(--text2)',
                border: 'none',
                borderRadius: 20,
                fontWeight: gun === g ? 700 : 400,
              }}
              onClick={() => setGun(g)}
            >
              {g < 30 ? `${g}g` : g < 365 ? `${Math.round(g/30)}ay` : '1yıl'}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={getir}
          disabled={yukleniyor}
          style={{ whiteSpace: 'nowrap' }}
        >
          {yukleniyor ? '…' : '↻ Getir'}
        </button>
      </div>

      {/* ── DURUM FİLTRE PİLLLERI (Stripe / Linear tarzı) ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            borderRadius: 20,
            padding: '4px 12px',
            fontSize: 12,
            background: !durumFiltre ? 'var(--accent)' : 'var(--bg3)',
            color: !durumFiltre ? '#fff' : 'var(--text2)',
            border: 'none',
            fontWeight: !durumFiltre ? 700 : 400,
          }}
          onClick={() => setDurumFiltre('')}
        >
          Tümü {toplamKayit > 0 && <span style={{ opacity: 0.7, fontSize: 11 }}>({toplamKayit})</span>}
        </button>
        {Object.entries(DURUM_LABEL).map(([k, v]) => {
          const adet = ozet[k] || 0;
          const aktif = durumFiltre === k;
          return (
            <button
              key={k}
              type="button"
              className="btn btn-sm"
              style={{
                borderRadius: 20,
                padding: '4px 12px',
                fontSize: 12,
                background: aktif ? v.renk : 'var(--bg3)',
                color: aktif ? '#fff' : adet > 0 ? v.renk : 'var(--text3)',
                border: aktif ? 'none' : `1px solid ${adet > 0 ? v.renk + '55' : 'transparent'}`,
                fontWeight: aktif ? 700 : 400,
                opacity: adet === 0 && !aktif ? 0.4 : 1,
              }}
              onClick={() => setDurumFiltre(aktif ? '' : k)}
            >
              {v.icon} {v.label} {adet > 0 && <span style={{ opacity: 0.8, fontSize: 11 }}>({adet})</span>}
            </button>
          );
        })}
      </div>

      {/* ── YÜKLEME ── */}
      {yukleniyor && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3].map((i) => (
            <div key={i} style={{ height: 52, borderRadius: 10, background: 'var(--bg3)', opacity: 0.5, animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      )}

      {/* ── BOŞ DURUM ── */}
      {!yukleniyor && satirlar.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text3)' }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {durumFiltre ? `"${DURUM_LABEL[durumFiltre]?.label}" durumunda sipariş yok` : 'Bu aralıkta sipariş kaydı yok'}
          </div>
          {durumFiltre && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDurumFiltre('')} style={{ marginTop: 8 }}>
              Filtreyi kaldır
            </button>
          )}
        </div>
      )}

      {/* ── SİPARİŞ KARTI LİSTESİ (Shopify tarzı) ── */}
      {!yukleniyor && satirlar.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {satirlar.map((s) => {
            const dl = DURUM_LABEL[s.durum] || { label: s.durum, renk: 'var(--text3)', icon: '?' };
            const acik = acikSatir === s.id;
            const gonderilmedi = s.durum === 'gonderilmedi';
            const oz = kalemOzet(s.kalemler);
            return (
              <div
                key={s.id}
                style={{
                  borderRadius: 10,
                  border: gonderilmedi
                    ? '1px solid rgba(249,115,22,0.4)'
                    : '1px solid var(--border)',
                  background: gonderilmedi
                    ? 'rgba(249,115,22,0.05)'
                    : 'var(--bg2)',
                  overflow: 'hidden',
                  transition: 'box-shadow 0.15s',
                }}
              >
                {/* Ana satır — tıklanabilir */}
                <div
                  role="button"
                  tabIndex={0}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer' }}
                  onClick={() => setAcikSatir(acik ? null : s.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setAcikSatir(acik ? null : s.id)}
                >
                  {/* Sol: tarih + şube */}
                  <div style={{ flex: '0 0 auto', minWidth: 80 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>
                      {gorececTarih(s.tarih)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                      {String(s.tarih || '').slice(0, 10)}
                    </div>
                  </div>

                  {/* Orta: şube + özet */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.sube_adi || s.sube_id}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {oz || (s.kalem_adet_toplam ? `${s.kalem_adet_toplam} adet` : 'İçerik yok')}
                      {s.personel_ad ? ` · ${s.personel_ad}` : ''}
                    </div>
                  </div>

                  {/* Sağ: durum + adet */}
                  <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
                    <span style={{
                      display: 'inline-block',
                      background: dl.renk + '22',
                      color: dl.renk,
                      border: `1px solid ${dl.renk}55`,
                      borderRadius: 20,
                      padding: '2px 10px',
                      fontSize: 11,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}>
                      {dl.icon} {dl.label}
                    </span>
                    {s.kalem_adet_toplam > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>
                        {s.kalem_adet_toplam} adet
                      </div>
                    )}
                  </div>

                  <div style={{ color: 'var(--text3)', fontSize: 12, flex: '0 0 16px' }}>
                    {acik ? '▲' : '▼'}
                  </div>
                </div>

                {/* Açılır detay */}
                {acik && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', background: 'var(--bg1)' }}>

                    {/* Kalemler */}
                    {Array.isArray(s.kalemler) && s.kalemler.filter((k) => parseInt(k?.adet || 0) > 0).length > 0 ? (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Sipariş İçeriği
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {s.kalemler
                            .filter((k) => parseInt(k?.adet || 0) > 0)
                            .map((k, i) => (
                              <span key={i} style={{
                                background: 'var(--bg3)',
                                borderRadius: 6,
                                padding: '3px 9px',
                                fontSize: 12,
                                color: 'var(--text2)',
                              }}>
                                {k.urun_adi || k.kalem_kodu || '?'}
                                <span style={{ fontWeight: 700, color: 'var(--text1)', marginLeft: 5 }}>×{k.adet}</span>
                              </span>
                            ))}
                        </div>
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Kalem detayı yok.</p>
                    )}

                    {/* Not */}
                    {s.not_aciklama && (
                      <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text2)', background: 'var(--bg3)', borderRadius: 6, padding: '6px 10px' }}>
                        💬 {s.not_aciklama}
                      </div>
                    )}

                    {/* Gönderilmedi uyarısı + yeniden aç */}
                    {gonderilmedi && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: '8px 12px', background: 'rgba(249,115,22,0.1)', borderRadius: 8, border: '1px solid rgba(249,115,22,0.3)' }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#f97316' }}>
                            ⚠️ Bu sipariş 7 günde işleme alınmadığı için otomatik kapatıldı
                          </div>
                          {s.gonderilmedi_ts && (
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                              Kapatılma: {String(s.gonderilmedi_ts).slice(0, 16).replace('T', ' ')}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ background: '#f97316', color: '#fff', border: 'none', fontWeight: 700, borderRadius: 8, whiteSpace: 'nowrap' }}
                          disabled={yenidenAcBusy === s.id}
                          onClick={() => yenidenAc(s.id)}
                        >
                          {yenidenAcBusy === s.id ? 'İşleniyor…' : '↩ Yeniden Kuyruğa Al'}
                        </button>
                      </div>
                    )}

                    {/* Meta bilgi */}
                    <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
                      {s.personel_ad && <span>👤 {s.personel_ad}</span>}
                      {s.olusturma && <span>🕐 {String(s.olusturma).slice(0, 16).replace('T', ' ')}</span>}
                      {s.hedef_depo_sube_adi && <span>🏪 Depo: {s.hedef_depo_sube_adi}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function OperasyonMerkezi() {
  const varsayilanAy = new Date().toISOString().slice(0, 7);
  const [aktifSekme, setAktifSekme] = useState('');
  const [aktifModul, setAktifModul] = useState('');
  const [opsMerkezPencere, setOpsMerkezPencere] = useState(false);
  const [opsIcBolum, setOpsIcBolum] = useState('icerik');
  const [filtre,    setFiltre]    = useState('all');
  const [kartlar,   setKartlar]   = useState([]);
  const [defter,    setDefter]    = useState([]);
  const [sayimlar,  setSayimlar]  = useState([]);
  const [barOzet,   setBarOzet]   = useState([]);
  const [barOzetTarih, setBarOzetTarih] = useState(bugunIsoTarih());
  const [barOzetSeciliSubeKey, setBarOzetSeciliSubeKey] = useState('all');
  const [stokKayip, setStokKayip] = useState(null);
  // Stok Disiplin v2
  const [disiplinPanel, setDisiplinPanel] = useState('kuyruk'); // kuyruk | kritik | akis | davranis | skor
  const [kritikStok, setKritikStok] = useState(null);
  const [kritikFiltre, setKritikFiltre] = useState('tumu'); // tumu | kriz | merkez | sube
  const [kritikAcikGruplar, setKritikAcikGruplar] = useState({}); // grup key → bool
  const [siparisAkis, setSiparisAkis] = useState(null);
  const [akisFiltre, setAkisFiltre] = useState('tumu');
  const [akisAcikId, setAkisAcikId] = useState(null);
  const [subeDavranis, setSubeDavranis] = useState(null);
  const [subeSkor, setSubeSkor] = useState(null);
  const [bekleyenSiparisler, setBekleyenSiparisler] = useState(null);
  const [disiplinYukleniyor, setDisiplinYukleniyor] = useState(false);
  const [timelineAcik, setTimelineAcik] = useState(null); // siparis_id
  const [kuyrukDepoSecim, setKuyrukDepoSecim] = useState({}); // talep_id → depo_sube_id
  const [kuyrukTalimat, setKuyrukTalimat] = useState({}); // talep_id → operasyon talimat metni
  const [kuyrukDepolar, setKuyrukDepolar] = useState([]);
  const [kuyrukBusy, setKuyrukBusy] = useState(null);
  const [kuyrukAsama, setKuyrukAsama] = useState({}); // talep_id -> detay | depo | toptanci
  const [kuyrukToptanciTedarikci, setKuyrukToptanciTedarikci] = useState({}); // talep_id -> tedarikci_ad
  const [kuyrukToptanciNot, setKuyrukToptanciNot] = useState({}); // talep_id -> not
  const [kuyrukToptanciKalemDeger, setKuyrukToptanciKalemDeger] = useState({}); // `${talep_id}::${kalem}` -> adet
  const [toptanciSiparisListe, setToptanciSiparisListe] = useState({ gun: 30, toplam_kayit: 0, satirlar: [] });
  const [toptanciSiparisGun, setToptanciSiparisGun] = useState(30);
  const [toptanciTeslimGun, setToptanciTeslimGun] = useState(30);
  const [toptanciTeslimListe, setToptanciTeslimListe] = useState(null);
  const [toptanciTeslimAcikSube, setToptanciTeslimAcikSube] = useState(null);
  const [analitikGun, setAnalitikGun] = useState(30);
  const [analitikVeri, setAnalitikVeri] = useState(null);
  const [stokTahminGun, setStokTahminGun] = useState(14);
  const [stokTahminSube, setStokTahminSube] = useState('');
  const [stokTahminVeri, setStokTahminVeri] = useState(null);
  const [personelDavranis, setPersonelDavranis] = useState(null);
  const [skor,      setSkor]      = useState(null);
  const [haftalikKarsilastirma, setHaftalikKarsilastirma] = useState(null);
  const [ozet,      setOzet]      = useState(null);
  const [ayFiltre,  setAyFiltre]  = useState(varsayilanAy);
  const [gunFiltre, setGunFiltre] = useState('');
  const [yukleniyor,setYukleniyor]= useState(true);
  const [detay,     setDetay]     = useState(null);
  const [msg,       setMsg]       = useState(null);
  const [sonYenileme, setSonYenileme] = useState(null);
  const [subeOnayFiltre, setSubeOnayFiltre] = useState('');
  const [bekleyenPaket, setBekleyenPaket] = useState(null);
  const [notlarListe, setNotlarListe] = useState([]);
  const [subeListeAdmin, setSubeListeAdmin] = useState([]);
  const [onayBusyId, setOnayBusyId] = useState(null);
  const [mesajListe, setMesajListe] = useState([]);
  const [mesajForm, setMesajForm] = useState({ sube_id: '', mesaj: '', oncelik: 'normal', ttl_saat: 72 });
  const [mesajBusy, setMesajBusy] = useState(false);
  /** Tek istekte tüm aktif şubelere aynı metni gönder (arka arkaya POST). */
  const [mesajTumSubeler, setMesajTumSubeler] = useState(false);
  const [puanListe, setPuanListe] = useState([]);
  const [puanSubeFiltre, setPuanSubeFiltre] = useState('');
  const [takipMap, setTakipMap] = useState({});
  const [riskModal, setRiskModal] = useState(null);
  const [sipKat, setSipKat] = useState([]);
  const [sipYeniUrun, setSipYeniUrun] = useState({ kategori_kod: '', urun_adi: '' });
  const [sipYeniKat, setSipYeniKat] = useState({ ad: '', emoji: '📦' });
  const [sipOzelBekleyen, setSipOzelBekleyen] = useState([]);
  const [sipOzelNotMap, setSipOzelNotMap] = useState({});
  const [sipOzelBusyId, setSipOzelBusyId] = useState(null);
  const [depoSevkiyatRaporlari, setDepoSevkiyatRaporlari] = useState([]);
  const [siparisKabulTakip, setSiparisKabulTakip] = useState({ gun: 7, satirlar: [] });
  const [siparisKabulTakipGun, setSiparisKabulTakipGun] = useState(14);
  const [siparisKabulTakipSube, setSiparisKabulTakipSube] = useState('');
  /** Mağaza depo sekmesi: şube paneliyle aynı normalize edilmiş sipariş kataloğu (+ ileride fiyat/depo alanları) */
  const [magazaDepoKatalogState, setMagazaDepoKatalogState] = useState({ yukleniyor: false, kategoriler: [] });
  const [magazaDepoKatAcik, setMagazaDepoKatAcik] = useState({});
  const [magazaUrunEkleAcik, setMagazaUrunEkleAcik] = useState(false);
  const [magazaUrunEkleForm, setMagazaUrunEkleForm] = useState({
    kategori_kod: '',
    urun_adi: '',
    aciklama: '',
    fiyat_tl: '',
    adet: '',
  });
  const [magazaFiyatGuncelleAcik, setMagazaFiyatGuncelleAcik] = useState(false);
  const [magazaFiyatGuncelleForm, setMagazaFiyatGuncelleForm] = useState({
    kategori_kod: '',
    urun_id: '',
    yeni_fiyat_tl: '',
  });
  /** ürün bazlı global override fiyat: urun_id -> birim fiyat */
  const [magazaGlobalFiyatMap, setMagazaGlobalFiyatMap] = useState({});
  /** kategori içi hızlı fiyat düzenleme taslakları: urun_id -> metin fiyat */
  const [magazaFiyatHizliTaslak, setMagazaFiyatHizliTaslak] = useState({});
  /** `${subeId|slug:slug}::${urunId}` → elle girilen stok metni (şube + katalog ürünü başına). */
  const [magazaSubeStokInput, setMagazaSubeStokInput] = useState({});
  /** sube_id -> /ops/v2/sube/{id}/depo canlı depo stok satırları */
  const [magazaDepoCanliStok, setMagazaDepoCanliStok] = useState({});
  /** slug -> { alarm_sayisi, durum: 'ok'|'hub_yok'|'api_hata' } — GET …/depo meta */
  const [magazaDepoDepoMeta, setMagazaDepoDepoMeta] = useState({});
  /** Katalog ağacında metin arama + kritik filtresi (tüm şube kartlarında ortak). */
  const [magazaKatalogArama, setMagazaKatalogArama] = useState('');
  const [magazaKatalogSadeceKritik, setMagazaKatalogSadeceKritik] = useState(false);
  /** depo kartı iç görünüm: katalog | uyari | canli */
  const [magazaDepoAltSekme, setMagazaDepoAltSekme] = useState({});
  /** `${subeKey}::${urunId}` -> onay bekleyen stok değişikliği */
  const [magazaStokOnayBekleyen, setMagazaStokOnayBekleyen] = useState({});
  /** `${subeKey}::${urunId}` -> onay API çağrısı in-flight */
  const [magazaStokOnayBusy, setMagazaStokOnayBusy] = useState({});
  /** Katalog ürünü depo havuzu taslak metni `urun_id` → string (sunucudan farklıysa düzenleniyor). */
  const [magazaDepoHavuzTaslak, setMagazaDepoHavuzTaslak] = useState({});
  /** `urun_id` → havuz kodu kaydı API bekliyor */
  const [magazaDepoHavuzBusy, setMagazaDepoHavuzBusy] = useState({});
  /** Şube anahtarı → katalog dışı manuel satırlar (yerel; API yok). */
  const [magazaManuelSatirlar, setMagazaManuelSatirlar] = useState({});
  /** Depo stokları: üst seviye — şube kartları | genel depo özeti (GET /ops/v2/depo-ozet). */
  const [magazaDepoUstSekme, setMagazaDepoUstSekme] = useState('subeler');
  const [magazaDepoOzet, setMagazaDepoOzet] = useState(null);
  const [magazaDepoOzetGun, setMagazaDepoOzetGun] = useState(30);
  const [magazaDepoOzetYukleniyor, setMagazaDepoOzetYukleniyor] = useState(false);
  /** Depo stokları → Şube depoları: null = tüm şubeler ızgarada; slug = yalnızca o şube tam genişlikte */
  const [magazaDepoOdakSlug, setMagazaDepoOdakSlug] = useState(null);
  const magazaDepoUstSekmeRef = useRef(magazaDepoUstSekme);
  const magazaDepoOzetGunRef = useRef(magazaDepoOzetGun);
  useEffect(() => { magazaDepoUstSekmeRef.current = magazaDepoUstSekme; }, [magazaDepoUstSekme]);
  useEffect(() => { magazaDepoOzetGunRef.current = magazaDepoOzetGun; }, [magazaDepoOzetGun]);
  const [mPersonelVerimlilik, setMPersonelVerimlilik] = useState(null);
  const magazaDepoSubeler = useMemo(() => magazaDepoEtkinSubeler(kartlar), [kartlar]);
  const magazaDepoGosterimSubeler = useMemo(() => {
    if (!magazaDepoOdakSlug) return magazaDepoSubeler;
    const fil = magazaDepoSubeler.filter((x) => x.slug === magazaDepoOdakSlug);
    return fil.length > 0 ? fil : magazaDepoSubeler;
  }, [magazaDepoSubeler, magazaDepoOdakSlug]);
  const [mSubeOperasyonKalite, setMSubeOperasyonKalite] = useState(null);
  const [mFinansOzet, setMFinansOzet] = useState(null);
  const [mStokTedarik, setMStokTedarik] = useState(null);
  const [kontrolData, setKontrolData] = useState(null);
  const [kontrolKategori, setKontrolKategori] = useState('');
  const [kontrolSadeceAlarmlar, setKontrolSadeceAlarmlar] = useState(false);
  const [kontrolDetaySube, setKontrolDetaySube] = useState('');
  const [fisBekleyen, setFisBekleyen] = useState([]);
  const [fisBusyId, setFisBusyId] = useState(null);
  const [opsOzet, setOpsOzet] = useState(null);
  const siparisBekleyenGunPenceresi = Math.max(1, Number(opsOzet?.siparis_bekleyen_gun_penceresi || 7));
  /** hub-ozet alarm kartı genişletilmiş satır id */
  const [hubAlarmAcikId, setHubAlarmAcikId] = useState(null);
  /** Hub: gelen sipariş kartında operasyon özet satırları (alarm listesi) */
  const [hubOperasyonDetayAcik, setHubOperasyonDetayAcik] = useState(false);
  /** Yeni sipariş düştüğünde gelen kutusu + hub «Şube sipariş» kartı çerçeve vurgusu */
  const [hubYeniSiparisVurgu, setHubYeniSiparisVurgu] = useState(false);
  /** Hub üst kart: bugün açılan ürünler */
  const [urunAcBugun, setUrunAcBugun] = useState({ tarih: '', toplam_islem: 0, toplam_adet: 0, kayitlar: [] });
  const [urunAcBugunYukleniyor, setUrunAcBugunYukleniyor] = useState(false);
  const [urunAcDetayAcik, setUrunAcDetayAcik] = useState(false);
  const [urunAcAramaTarih, setUrunAcAramaTarih] = useState(bugunIsoTarih());
  const [urunAcAramaYukleniyor, setUrunAcAramaYukleniyor] = useState(false);
  const [urunAcAramaSonuc, setUrunAcAramaSonuc] = useState({ tarih: '', toplam_islem: 0, toplam_adet: 0, kayitlar: [] });
  const [urunAcSeciliSubeKey, setUrunAcSeciliSubeKey] = useState('all');
  const [urunAcHaftaSatirlari, setUrunAcHaftaSatirlari] = useState([]);
  const [urunAcHaftaYukleniyor, setUrunAcHaftaYukleniyor] = useState(false);
  const [gecAcilanBugun, setGecAcilanBugun] = useState({
    tarih: '',
    toplam: 0,
    kayitlar: [],
    acilmayan_subeler: [],
    acilmayan_toplam: 0,
    plan_kayitsiz_subeler: [],
    plan_kayitsiz_toplam: 0,
  });
  const [gecAcilanBugunYukleniyor, setGecAcilanBugunYukleniyor] = useState(false);
  const [gecAcilanAramaTarih, setGecAcilanAramaTarih] = useState(bugunIsoTarih());
  const [gecAcilanAramaYukleniyor, setGecAcilanAramaYukleniyor] = useState(false);
  const [gecAcilanAramaSonuc, setGecAcilanAramaSonuc] = useState({
    tarih: '',
    toplam: 0,
    kayitlar: [],
    acilmayan_subeler: [],
    acilmayan_toplam: 0,
    plan_kayitsiz_subeler: [],
    plan_kayitsiz_toplam: 0,
  });
  const [gecAcilanSeciliSubeKey, setGecAcilanSeciliSubeKey] = useState('all');
  /** Geç açılan kartı içi: operasyon akışı vs planlı ama ACILIS oluşmamış. */
  const [gecAcilanKartSekme, setGecAcilanKartSekme] = useState('akis');
  const [gecAcilanHaftaSatirlari, setGecAcilanHaftaSatirlari] = useState([]);
  const [gecAcilanHaftaYukleniyor, setGecAcilanHaftaYukleniyor] = useState(false);
  const [gecKalanPersonelBugun, setGecKalanPersonelBugun] = useState({
    year_month: varsayilanAy,
    gecikme_dk: 5,
    kritik_dk: 15,
    toplam_personel: 0,
    gecikme_toplam_adet: 0,
    kritik_personel_sayisi: 0,
    satirlar: [],
  });
  const [gecKalanPersonelBugunYukleniyor, setGecKalanPersonelBugunYukleniyor] = useState(false);
  const [gecKalanPersonelAy, setGecKalanPersonelAy] = useState(varsayilanAy);
  const [gecKalanPersonelAramaYukleniyor, setGecKalanPersonelAramaYukleniyor] = useState(false);
  const [gecKalanPersonelAramaSonuc, setGecKalanPersonelAramaSonuc] = useState({
    year_month: varsayilanAy,
    gecikme_dk: 5,
    kritik_dk: 15,
    toplam_personel: 0,
    gecikme_toplam_adet: 0,
    kritik_personel_sayisi: 0,
    satirlar: [],
  });
  const [gecKalanPersonelAcikKey, setGecKalanPersonelAcikKey] = useState('');
  const [kullanilanBugun, setKullanilanBugun] = useState({ tarih: '', toplam_islem: 0, toplam_adet: 0, satirlar: [] });
  const [kullanilanBugunYukleniyor, setKullanilanBugunYukleniyor] = useState(false);
  const [kullanilanDetayAcik, setKullanilanDetayAcik] = useState(false);
  const [kullanilanAramaTarih, setKullanilanAramaTarih] = useState(bugunIsoTarih());
  const [kullanilanAramaYukleniyor, setKullanilanAramaYukleniyor] = useState(false);
  const [kullanilanAramaSonuc, setKullanilanAramaSonuc] = useState({ tarih: '', toplam_islem: 0, toplam_adet: 0, satirlar: [] });
  const [kullanilanSeciliSubeKey, setKullanilanSeciliSubeKey] = useState('all');
  const [kullanilanHaftaSatirlari, setKullanilanHaftaSatirlari] = useState([]);
  const [kullanilanHaftaYukleniyor, setKullanilanHaftaYukleniyor] = useState(false);
  const [kapanisTakip, setKapanisTakip] = useState(null);
  const [kapanisTakipYukleniyor, setKapanisTakipYukleniyor] = useState(false);
  const [kapanisTakipTarih, setKapanisTakipTarih] = useState(isGunuIsoIstanbul());
  const [kapanisTakipSonGuncelleme, setKapanisTakipSonGuncelleme] = useState(null);
  const kapanisTakipIntervalRef = useRef(null);
  const [ciroOnayBugun, setCiroOnayBugun] = useState({ tarih: '', toplam: 0, toplam_tutar: 0, kayitlar: [] });
  const [ciroOnayBugunYukleniyor, setCiroOnayBugunYukleniyor] = useState(false);
  const [ciroOnayAramaTarih, setCiroOnayAramaTarih] = useState(isGunuIsoIstanbul());
  const [ciroOnayAramaYukleniyor, setCiroOnayAramaYukleniyor] = useState(false);
  const [ciroOnayAramaSonuc, setCiroOnayAramaSonuc] = useState({ tarih: '', toplam: 0, toplam_tutar: 0, kayitlar: [] });
  const [ciroOnaySeciliSubeKey, setCiroOnaySeciliSubeKey] = useState('all');
  const [kasaUyumBugun, setKasaUyumBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [kasaUyumBugunYukleniyor, setKasaUyumBugunYukleniyor] = useState(false);
  const [kasaUyumAramaTarih, setKasaUyumAramaTarih] = useState(bugunIsoTarih());
  const [kasaUyumAramaYukleniyor, setKasaUyumAramaYukleniyor] = useState(false);
  const [kasaUyumAramaSonuc, setKasaUyumAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [kasaUyumSeciliSubeKey, setKasaUyumSeciliSubeKey] = useState('all');
  /** Bugünden geriye 7 gün: çözüm bekleyen kasa uyarısı özeti (API yalnızca okundu=false döner). */
  const [kasaUyumHaftaSatirlari, setKasaUyumHaftaSatirlari] = useState([]);
  const [kasaUyumHaftaYukleniyor, setKasaUyumHaftaYukleniyor] = useState(false);
  const [personelVardiyaUyumBugun, setPersonelVardiyaUyumBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [personelVardiyaUyumBugunYukleniyor, setPersonelVardiyaUyumBugunYukleniyor] = useState(false);
  const [personelVardiyaUyumAramaTarih, setPersonelVardiyaUyumAramaTarih] = useState(bugunIsoTarih());
  const [personelVardiyaUyumAramaYukleniyor, setPersonelVardiyaUyumAramaYukleniyor] = useState(false);
  const [personelVardiyaUyumAramaSonuc, setPersonelVardiyaUyumAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [personelVardiyaUyumSeciliSubeKey, setPersonelVardiyaUyumSeciliSubeKey] = useState('all');
  const [personelVardiyaUyumHaftaSatirlari, setPersonelVardiyaUyumHaftaSatirlari] = useState([]);
  const [personelVardiyaUyumHaftaYukleniyor, setPersonelVardiyaUyumHaftaYukleniyor] = useState(false);
  const [urunUyumBugun, setUrunUyumBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [urunUyumBugunYukleniyor, setUrunUyumBugunYukleniyor] = useState(false);
  const [urunUyumAramaTarih, setUrunUyumAramaTarih] = useState(bugunIsoTarih());
  const [urunUyumAramaYukleniyor, setUrunUyumAramaYukleniyor] = useState(false);
  const [urunUyumAramaSonuc, setUrunUyumAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [urunUyumSeciliSubeKey, setUrunUyumSeciliSubeKey] = useState('all');
  /** Depo sevk vs şube kabul farkı — merkez API: /ops/siparis/sevkiyat-uyumsuzluklar */
  const [sevkiyatUyumOzet, setSevkiyatUyumOzet] = useState({ adet: 0 });
  const [sevkiyatUyumOzetYukleniyor, setSevkiyatUyumOzetYukleniyor] = useState(false);
  const [sevkiyatUyumDetay, setSevkiyatUyumDetay] = useState({ gun: 30, satirlar: [] });
  const [sevkiyatUyumGun, setSevkiyatUyumGun] = useState(30);
  const [sevkiyatUyumCozBusy, setSevkiyatUyumCozBusy] = useState('');
  const [sevkiyatUyumCozInputs, setSevkiyatUyumCozInputs] = useState({});

  /** Yeni sipariş toast: gördüğümüz talep id'leri (tekrar uyarı yok) */
  const hubSiparisGorulduRef = useRef(new Set());
  const hubOzetIlkYuklemeRef = useRef(true);
  const hubOncekiBekleyenSayiRef = useRef(null);
  const hubVurguTimerRef = useRef(null);
  /** Hub görünümünde (`!opsMerkezPencere`) şube sipariş listeleri yüklensin — interval/toast ile senkron */
  const opsHubGorunurRef = useRef(true);

  const toast = useCallback((m, t = 'red') => {
    setMsg({ m, t });
    window.setTimeout(() => setMsg(null), 4000);
  }, []);

  /** hub-ozet yanıtı: state + yeni sipariş geldiğinde bildirim */
  const hubOzetIsle = useCallback((r) => {
    if (!r) return;
    setOpsOzet(r);
    const bek = Number(r.siparis_bekleyen ?? 0);
    const alarms = r.alarm_satirlari || [];
    const sipAlarms = alarms.filter(
      (a) => a?.tip === 'siparis_merkez_bekliyor' && a.meta?.talep_id,
    );
    const seen = hubSiparisGorulduRef.current;

    if (hubOzetIlkYuklemeRef.current) {
      sipAlarms.forEach((a) => seen.add(String(a.meta.talep_id)));
      hubOzetIlkYuklemeRef.current = false;
      hubOncekiBekleyenSayiRef.current = bek;
      if (bek > 0) setHubOperasyonDetayAcik(true);
      return;
    }

    const prevBek = hubOncekiBekleyenSayiRef.current;
    const yeniler = sipAlarms.filter((a) => !seen.has(String(a.meta.talep_id)));
    yeniler.forEach((a) => seen.add(String(a.meta.talep_id)));

    if (yeniler.length === 1) {
      const a = yeniler[0];
      const txt = `${a.baslik || '📬 Yeni sipariş'}${a.ozet ? ` — ${a.ozet}` : ''}`.trim();
      toast(txt.length > 320 ? `${txt.slice(0, 317)}…` : txt, 'green');
    } else if (yeniler.length > 1) {
      toast(`📬 ${yeniler.length} yeni sipariş talebi — Operasyon özeti kartlarına bakın.`, 'green');
    } else if (
      prevBek !== null
      && bek > prevBek
    ) {
      toast(
        `📬 Bekleyen sipariş sayısı arttı (${prevBek} → ${bek}).`,
        'green',
      );
    }
    if (
      prevBek !== null
      && bek > 0
      && prevBek === 0
    ) {
      setHubOperasyonDetayAcik(true);
    }
    const vurguTetik = yeniler.length > 0 || (prevBek !== null && bek > prevBek);
    if (vurguTetik) {
      setHubYeniSiparisVurgu(true);
      if (hubVurguTimerRef.current) window.clearTimeout(hubVurguTimerRef.current);
      hubVurguTimerRef.current = window.setTimeout(() => setHubYeniSiparisVurgu(false), 4200);
    }
    hubOncekiBekleyenSayiRef.current = bek;
  }, [toast]);

  useEffect(() => () => {
    if (hubVurguTimerRef.current) window.clearTimeout(hubVurguTimerRef.current);
  }, [toast]);

  const metricText = (v, fallback = 'veri yok') => {
    if (v == null) return fallback;
    if (typeof v === 'string') {
      const s = v.trim();
      return s || fallback;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
      const mesaj = String(v.mesaj || v.message || '').trim();
      const durum = String(v.durum || v.status || '').trim();
      if (durum && (durum === 'tamam' || durum === 'ok') && mesaj) return mesaj;
      if (durum && mesaj) return `${durum}: ${mesaj}`;
      if (mesaj) return mesaj;
      if (durum) return durum;
      return fallback;
    }
    return String(v);
  };
  const metricNum = (v, digits = 2, fallback = 'veri yok') => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return n.toFixed(digits);
  };

  const urunAcGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const r = await api(`/ops/v2/urun-ac-akis?tarih=${encodeURIComponent(hedef)}&limit=80`);
    return {
      tarih: String(r?.tarih || hedef),
      toplam_islem: Number(r?.toplam_islem || 0),
      toplam_adet: Number(r?.toplam_adet || 0),
      kayitlar: Array.isArray(r?.kayitlar) ? r.kayitlar : [],
    };
  }, []);

  const yukleUrunAcBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setUrunAcBugunYukleniyor(true);
    try {
      const data = await urunAcGunYukle(bugunIsoTarih());
      setUrunAcBugun(data);
      if (!urunAcDetayAcik) {
        setUrunAcAramaTarih(data.tarih || bugunIsoTarih());
        setUrunAcAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Açılan ürünler yüklenemedi');
    } finally {
      setUrunAcBugunYukleniyor(false);
    }
  }, [toast, urunAcDetayAcik, urunAcGunYukle]);

  const urunAcAramaYap = useCallback(async () => {
    const hedef = (urunAcAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setUrunAcAramaYukleniyor(true);
    try {
      const data = await urunAcGunYukle(hedef);
      setUrunAcAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Açılan ürün araması yapılamadı');
    } finally {
      setUrunAcAramaYukleniyor(false);
    }
  }, [urunAcAramaTarih, urunAcGunYukle]);

  const urunAcHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const sonuclar = await Promise.all(
      gunlerDesc.map((t) => urunAcGunYukle(t).catch(() => ({
        tarih: t,
        toplam_islem: 0,
        toplam_adet: 0,
        kayitlar: [],
      }))),
    );
    return gunlerDesc.map((t, idx) => {
      const r = sonuclar[idx] || {};
      const ti = Number(r.toplam_islem || 0);
      const ta = Number(r.toplam_adet || 0);
      return {
        tarih: t,
        toplam_islem: ti,
        toplam_adet: ta,
        listeSiniri: ti >= 80,
      };
    });
  }, [urunAcGunYukle]);

  const gecAcilanGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const r = await api(`/ops/gec-acilan-subeler?tarih=${encodeURIComponent(hedef)}&limit=260`);
    const ac = Array.isArray(r?.acilmayan_subeler) ? r.acilmayan_subeler : [];
    const pk = Array.isArray(r?.plan_kayitsiz_subeler) ? r.plan_kayitsiz_subeler : [];
    return {
      tarih: String(r?.tarih || hedef),
      toplam: Number(r?.toplam || 0),
      kayitlar: Array.isArray(r?.kayitlar) ? r.kayitlar : [],
      acilmayan_subeler: ac,
      acilmayan_toplam: Number(r?.acilmayan_toplam ?? ac.length ?? 0),
      plan_kayitsiz_subeler: pk,
      plan_kayitsiz_toplam: Number(r?.plan_kayitsiz_toplam ?? pk.length ?? 0),
    };
  }, []);

  const yukleGecAcilanBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setGecAcilanBugunYukleniyor(true);
    try {
      const data = await gecAcilanGunYukle(bugunIsoTarih());
      setGecAcilanBugun(data);
      if (aktifSekme !== 'gec-acilan-subeler') {
        setGecAcilanAramaTarih(data.tarih || bugunIsoTarih());
        setGecAcilanAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Geç açılan şubeler yüklenemedi');
    } finally {
      setGecAcilanBugunYukleniyor(false);
    }
  }, [aktifSekme, gecAcilanGunYukle, toast]);

  const gecAcilanAramaYap = useCallback(async () => {
    const hedef = (gecAcilanAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setGecAcilanAramaYukleniyor(true);
    try {
      const data = await gecAcilanGunYukle(hedef);
      setGecAcilanAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Geç açılan şubeler getirilemedi');
    } finally {
      setGecAcilanAramaYukleniyor(false);
    }
  }, [gecAcilanAramaTarih, gecAcilanGunYukle, toast]);

  const gecAcilanHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const sonuclar = await Promise.all(
      gunlerDesc.map((t) => gecAcilanGunYukle(t).catch(() => ({
        tarih: t,
        toplam: 0,
        kayitlar: [],
        acilmayan_subeler: [],
        acilmayan_toplam: 0,
        plan_kayitsiz_subeler: [],
        plan_kayitsiz_toplam: 0,
      }))),
    );
    return gunlerDesc.map((t, idx) => {
      const d = sonuclar[idx] || {};
      const k = Array.isArray(d.kayitlar) ? d.kayitlar : [];
      const ac = Array.isArray(d.acilmayan_subeler) ? d.acilmayan_subeler : [];
      const pk = Array.isArray(d.plan_kayitsiz_subeler) ? d.plan_kayitsiz_subeler : [];
      const gecTop = Number(d.toplam || 0);
      const acTop = Number(d.acilmayan_toplam ?? ac.length ?? 0);
      const planTop = Number(d.plan_kayitsiz_toplam ?? pk.length ?? 0);
      return {
        tarih: t,
        gec_toplam: gecTop,
        acilmayan_toplam: acTop,
        ozetMetin: gecAcilanIsimOzet(k, ac),
        plan_kayitsiz_toplam: planTop,
        planOzetMetin: gecPlanKayitsizIsimOzet(pk),
      };
    });
  }, [gecAcilanGunYukle]);

  const gecKalanPersonelAyYukle = useCallback(async (ym) => {
    const hedefAy = String(ym || varsayilanAy).trim() || varsayilanAy;
    const r = await api(`/ops/gec-kalan-personel?year_month=${encodeURIComponent(hedefAy)}&gecikme_dk=5&kritik_dk=15&limit=500`);
    return {
      year_month: String(r?.year_month || hedefAy),
      gecikme_dk: Number(r?.gecikme_dk || 5),
      kritik_dk: Number(r?.kritik_dk ?? 15),
      toplam_personel: Number(r?.toplam_personel || 0),
      gecikme_toplam_adet: Number(r?.gecikme_toplam_adet || 0),
      kritik_personel_sayisi: Number(r?.kritik_personel_sayisi || 0),
      satirlar: Array.isArray(r?.satirlar) ? r.satirlar : [],
    };
  }, [varsayilanAy]);

  const yukleGecKalanPersonelBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setGecKalanPersonelBugunYukleniyor(true);
    try {
      const data = await gecKalanPersonelAyYukle(varsayilanAy);
      setGecKalanPersonelBugun(data);
      if (aktifSekme !== 'gec-kalan-personel') {
        setGecKalanPersonelAy(data.year_month || varsayilanAy);
        setGecKalanPersonelAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Geç kalan personel yüklenemedi');
    } finally {
      setGecKalanPersonelBugunYukleniyor(false);
    }
  }, [aktifSekme, gecKalanPersonelAyYukle, toast, varsayilanAy]);

  const gecKalanPersonelAramaYap = useCallback(async () => {
    const hedefAy = String(gecKalanPersonelAy || varsayilanAy).trim() || varsayilanAy;
    if (!/^\d{4}-\d{2}$/.test(hedefAy)) {
      toast('Ay formatı YYYY-MM olmalı');
      return;
    }
    setGecKalanPersonelAramaYukleniyor(true);
    try {
      const data = await gecKalanPersonelAyYukle(hedefAy);
      setGecKalanPersonelAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Geç kalan personel listesi getirilemedi');
    } finally {
      setGecKalanPersonelAramaYukleniyor(false);
    }
  }, [gecKalanPersonelAy, gecKalanPersonelAyYukle, toast, varsayilanAy]);

  const kullanilanGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/bar-ozet?year_month=${encodeURIComponent(ym)}&gun=${encodeURIComponent(hedef)}&limit=180`);
    const satirlar = Array.isArray(r?.satirlar) ? r.satirlar : [];
    const toplamAdet = satirlar.reduce((sum, row) => sum + _sumSatilan(row?.satilan), 0);
    return {
      tarih: hedef,
      toplam_islem: satirlar.length,
      toplam_adet: toplamAdet,
      satirlar,
    };
  }, []);

  const yukleKullanilanBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setKullanilanBugunYukleniyor(true);
    try {
      const data = await kullanilanGunYukle(bugunIsoTarih());
      setKullanilanBugun(data);
      if (!kullanilanDetayAcik) {
        setKullanilanAramaTarih(data.tarih || bugunIsoTarih());
        setKullanilanAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Kullanılan ürünler yüklenemedi');
    } finally {
      setKullanilanBugunYukleniyor(false);
    }
  }, [toast, kullanilanDetayAcik, kullanilanGunYukle]);

  const kullanilanAramaYap = useCallback(async () => {
    const hedef = (kullanilanAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setKullanilanAramaYukleniyor(true);
    try {
      const data = await kullanilanGunYukle(hedef);
      setKullanilanAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Kullanılan ürün araması yapılamadı');
    } finally {
      setKullanilanAramaYukleniyor(false);
    }
  }, [kullanilanAramaTarih, kullanilanGunYukle, toast]);

  const kullanilanHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const sonuclar = await Promise.all(
      gunlerDesc.map((t) => kullanilanGunYukle(t).catch(() => ({
        tarih: t,
        toplam_islem: 0,
        toplam_adet: 0,
        satirlar: [],
      }))),
    );
    return gunlerDesc.map((t, idx) => {
      const d = sonuclar[idx] || {};
      const sat = Array.isArray(d.satirlar) ? d.satirlar : [];
      const subeOzetleri = kullanilanSatirlariSubeyeGoreSirala(sat).map((r) => ({
        sube_id: r.sube_id,
        sube_adi: r.sube_adi,
        toplam_adet: kullanilanSatirToplamAdet(r),
      }));
      return {
        tarih: t,
        toplam_islem: Number(d.toplam_islem || 0),
        toplam_adet: Number(d.toplam_adet || 0),
        subeOzetleri,
      };
    });
  }, [kullanilanGunYukle]);

  const yukleKapanisTakip = useCallback(async (tarih, { silent = false } = {}) => {
    const hedef = (tarih || isGunuIsoIstanbul()).trim();
    if (!silent) setKapanisTakipYukleniyor(true);
    try {
      const r = await api(`/ops/kapanis-takip?tarih=${encodeURIComponent(hedef)}`);
      setKapanisTakip(r);
      setKapanisTakipSonGuncelleme(new Date());
    } catch (e) {
      if (!silent) toast(e.message || 'Kapanış takip yüklenemedi');
    } finally {
      if (!silent) setKapanisTakipYukleniyor(false);
    }
  }, [toast]);

  const ciroOnayGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || isGunuIsoIstanbul()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/bekleyen-merkez?year_month=${encodeURIComponent(ym)}`);
    const satirlar = Array.isArray(r?.ciro_taslaklari) ? r.ciro_taslaklari : [];
    const kayitlar = satirlar.filter((t) => String(t?.tarih || '').slice(0, 10) === hedef);
    const toplamTutar = kayitlar.reduce((sum, t) => {
      const nakit = Number(t?.nakit || 0);
      const pos = Number(t?.pos || 0);
      const online = Number(t?.online || 0);
      return sum + (Number.isFinite(nakit) ? nakit : 0) + (Number.isFinite(pos) ? pos : 0) + (Number.isFinite(online) ? online : 0);
    }, 0);
    return {
      tarih: hedef,
      toplam: kayitlar.length,
      toplam_tutar: toplamTutar,
      kayitlar,
    };
  }, []);

  const yukleCiroOnayBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setCiroOnayBugunYukleniyor(true);
    try {
      const data = await ciroOnayGunYukle(isGunuIsoIstanbul());
      setCiroOnayBugun(data);
      if (aktifSekme !== 'ciro-onay') {
        setCiroOnayAramaTarih(data.tarih || isGunuIsoIstanbul());
        setCiroOnayAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Bekleyen ciro onayları yüklenemedi');
    } finally {
      setCiroOnayBugunYukleniyor(false);
    }
  }, [aktifSekme, ciroOnayGunYukle, toast]);

  const ciroOnayAramaYap = useCallback(async () => {
    const hedef = (ciroOnayAramaTarih || isGunuIsoIstanbul()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setCiroOnayAramaYukleniyor(true);
    try {
      const data = await ciroOnayGunYukle(hedef);
      setCiroOnayAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Bekleyen ciro onayları getirilemedi');
    } finally {
      setCiroOnayAramaYukleniyor(false);
    }
  }, [ciroOnayAramaTarih, ciroOnayGunYukle, toast]);

  const kasaUyumGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/bekleyen-merkez?year_month=${encodeURIComponent(ym)}`);
    const tum = Array.isArray(r?.kasa_uyumsuzluklar) ? r.kasa_uyumsuzluklar : [];
    const kayitlar = tum.filter((u) => String(u?.tarih || '').slice(0, 10) === hedef);
    const eksikKapanis = hedef === isGunuIsoIstanbul()
      ? (Array.isArray(r?.eksik_kapanis_bugun) ? r.eksik_kapanis_bugun : [])
      : [];
    return {
      tarih: hedef,
      toplam: kayitlar.length,
      kayitlar,
      eksik_kapanis: eksikKapanis,
    };
  }, []);

  const yukleKasaUyumBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setKasaUyumBugunYukleniyor(true);
    try {
      const data = await kasaUyumGunYukle(bugunIsoTarih());
      setKasaUyumBugun(data);
      setKasaUyumAramaTarih(data.tarih || bugunIsoTarih());
      setKasaUyumAramaSonuc(data);
    } catch (e) {
      if (!silent) toast(e.message || 'Kasa uyumsuzluk verisi yüklenemedi');
    } finally {
      setKasaUyumBugunYukleniyor(false);
    }
  }, [kasaUyumGunYukle, toast]);

  const kasaUyumAramaYap = useCallback(async () => {
    const hedef = (kasaUyumAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setKasaUyumAramaYukleniyor(true);
    try {
      const data = await kasaUyumGunYukle(hedef);
      setKasaUyumAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Kasa uyumsuzluk araması yapılamadı');
    } finally {
      setKasaUyumAramaYukleniyor(false);
    }
  }, [kasaUyumAramaTarih, kasaUyumGunYukle, toast]);

  const kasaUyumHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const yms = [...new Set(gunlerDesc.map((t) => t.slice(0, 7)))];
    const responses = await Promise.all(
      yms.map((ym) => api(`/ops/bekleyen-merkez?year_month=${encodeURIComponent(ym)}`).catch(() => null)),
    );
    const tum = [];
    responses.forEach((r) => {
      if (r && Array.isArray(r.kasa_uyumsuzluklar)) tum.push(...r.kasa_uyumsuzluklar);
    });
    const byGun = new Map();
    gunlerDesc.forEach((t) => byGun.set(t, []));
    tum.forEach((u) => {
      const t = String(u?.tarih || '').slice(0, 10);
      if (byGun.has(t)) byGun.get(t).push(u);
    });
    return gunlerDesc.map((tarih) => {
      const kayitlar = byGun.get(tarih) || [];
      let maxAbs = 0;
      kayitlar.forEach((u) => {
        const a = Math.abs(Number(u?.fark_tl || 0));
        if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
      });
      return { tarih, adet: kayitlar.length, maxAbsFark: maxAbs };
    });
  }, []);

  const personelVardiyaUyumGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/personel-vardiya-uyumsuzluk?year_month=${encodeURIComponent(ym)}`);
    const tum = Array.isArray(r?.kayitlar) ? r.kayitlar : [];
    const kayitlar = tum.filter((u) => String(u?.tarih || '').slice(0, 10) === hedef);
    return {
      tarih: hedef,
      toplam: kayitlar.length,
      kayitlar,
    };
  }, []);

  const yuklePersonelVardiyaUyumBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setPersonelVardiyaUyumBugunYukleniyor(true);
    try {
      const data = await personelVardiyaUyumGunYukle(bugunIsoTarih());
      setPersonelVardiyaUyumBugun(data);
      setPersonelVardiyaUyumAramaTarih(data.tarih || bugunIsoTarih());
      setPersonelVardiyaUyumAramaSonuc(data);
    } catch (e) {
      if (!silent) toast(e.message || 'Personel uyumsuzluk verisi yüklenemedi');
    } finally {
      setPersonelVardiyaUyumBugunYukleniyor(false);
    }
  }, [personelVardiyaUyumGunYukle, toast]);

  const personelVardiyaUyumAramaYap = useCallback(async () => {
    const hedef = (personelVardiyaUyumAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setPersonelVardiyaUyumAramaYukleniyor(true);
    try {
      const data = await personelVardiyaUyumGunYukle(hedef);
      setPersonelVardiyaUyumAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Personel uyumsuzluk araması yapılamadı');
    } finally {
      setPersonelVardiyaUyumAramaYukleniyor(false);
    }
  }, [personelVardiyaUyumAramaTarih, personelVardiyaUyumGunYukle, toast]);

  const personelVardiyaUyumHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const yms = [...new Set(gunlerDesc.map((t) => t.slice(0, 7)))];
    const responses = await Promise.all(
      yms.map((ym) => api(`/ops/personel-vardiya-uyumsuzluk?year_month=${encodeURIComponent(ym)}`).catch(() => null)),
    );
    const tum = [];
    responses.forEach((r) => {
      if (r && Array.isArray(r.kayitlar)) tum.push(...r.kayitlar);
    });
    const byGun = new Map();
    gunlerDesc.forEach((t) => byGun.set(t, []));
    tum.forEach((u) => {
      const t = String(u?.tarih || '').slice(0, 10);
      if (byGun.has(t)) byGun.get(t).push(u);
    });
    return gunlerDesc.map((tarih) => ({
      tarih,
      adet: (byGun.get(tarih) || []).length,
    }));
  }, []);

  const urunUyumGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/bar-ozet?year_month=${encodeURIComponent(ym)}&gun=${encodeURIComponent(hedef)}&limit=180`);
    const satirlar = Array.isArray(r?.satirlar) ? r.satirlar : [];
    const keys = ['bardak_kucuk','bardak_buyuk','bardak_plastik','karton_bardak','su_adet','sut_litre','redbull_adet','soda_adet','cookie_adet','pasta_adet','surup_adet','kahve_paket','kapak_adet','pecete_paket','diger_sarf','pasta_porsiyon_sade','pasta_porsiyon_antep','pasta_porsiyon_cik','pasta_mag_cilek','pasta_mag_lotus','pasta_buyuk_tart','pasta_kucuk_tart','pasta_snickers','pasta_malaga','pasta_latte','pasta_muzlu_rulo','pasta_cik_rulo','pasta_meyveli_rulo','pasta_browni','pasta_dilim_ss_sade','pasta_cream_puff','pasta_kavala','pasta_cup_limon','pasta_cup_yerfistik','pasta_cup_cilek','pasta_cup_karamel','pasta_cup_lotus','pasta_cup_antep','pasta_cup_hindistan','pasta_profiterol','pasta_kare_cik','pasta_kare_yerfistik','pasta_kare_karamel','pasta_kare_limon','pasta_dilim_sade','pasta_dilim_antep','pasta_dilim_cik','pasta_dilim_yaban'];
    const kayitlar = satirlar
      .map((x) => {
        const sat = x?.satilan || {};
        const uyumsuzGunIci = keys.filter((k) => Number(sat?.[k] || 0) < 0);
        const dk = Array.isArray(x?.devir_uyumsuz_kalemleri) ? x.devir_uyumsuz_kalemleri : [];
        const kapYok = !!x?.onceki_kapanis_yok;
        const birlesik = new Set([...uyumsuzGunIci, ...dk]);
        const uyumsuzlar = keys.filter((k) => birlesik.has(k));
        let uyumsuz_adet = uyumsuzlar.length;
        if (kapYok && uyumsuz_adet === 0) uyumsuz_adet = 1;
        return {
          ...x,
          uyumsuz_urunler: uyumsuzlar,
          uyumsuz_gun_ici_keys: uyumsuzGunIci,
          uyumsuz_devir_keys: dk,
          uyumsuz_adet,
        };
      })
      .filter((x) => x.uyumsuz_adet > 0);
    return { tarih: hedef, toplam: kayitlar.length, kayitlar };
  }, []);

  const yukleUrunUyumBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setUrunUyumBugunYukleniyor(true);
    try {
      const data = await urunUyumGunYukle(bugunIsoTarih());
      setUrunUyumBugun(data);
      setUrunUyumAramaTarih(data.tarih || bugunIsoTarih());
      setUrunUyumAramaSonuc(data);
    } catch (e) {
      if (!silent) toast(e.message || 'Ürün uyumsuzluk verisi yüklenemedi');
    } finally {
      setUrunUyumBugunYukleniyor(false);
    }
  }, [urunUyumGunYukle, toast]);

  const urunUyumAramaYap = useCallback(async () => {
    const hedef = (urunUyumAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setUrunUyumAramaYukleniyor(true);
    try {
      const data = await urunUyumGunYukle(hedef);
      setUrunUyumAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Ürün uyumsuzluk araması yapılamadı');
    } finally {
      setUrunUyumAramaYukleniyor(false);
    }
  }, [urunUyumAramaTarih, urunUyumGunYukle, toast]);

  const yukleSevkiyatUyumOzet = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setSevkiyatUyumOzetYukleniyor(true);
    try {
      const r = await api('/ops/siparis/sevkiyat-uyumsuzluklar?gun=30&limit=300');
      const n = Array.isArray(r?.satirlar) ? r.satirlar.length : 0;
      setSevkiyatUyumOzet({ adet: n });
    } catch (e) {
      if (!silent) toast(e.message || 'Sevkiyat uyumsuzluk özeti yüklenemedi');
      setSevkiyatUyumOzet({ adet: 0 });
    } finally {
      setSevkiyatUyumOzetYukleniyor(false);
    }
  }, [toast]);

  const sevkiyatUyumDetayYukle = useCallback(async () => {
    const g = Math.max(1, Math.min(120, Number(sevkiyatUyumGun) || 30));
    const r = await api(`/ops/siparis/sevkiyat-uyumsuzluklar?gun=${g}&limit=300`);
    setSevkiyatUyumDetay({
      gun: Number(r?.gun || g),
      satirlar: Array.isArray(r?.satirlar) ? r.satirlar : [],
    });
  }, [sevkiyatUyumGun]);

  const yukleSevkiyatUyumBugun = useCallback(
    (opts = {}) => yukleSevkiyatUyumOzet({ silent: !!opts.silent }),
    [yukleSevkiyatUyumOzet],
  );

  const sevkiyatUyumsuzlukCoz = useCallback(async (stokYoldaId, cozumAdet, notu) => {
    const yid = String(stokYoldaId || '').trim();
    if (!yid) return;
    setSevkiyatUyumCozBusy(yid);
    try {
      await api('/ops/siparis/sevkiyat-uyumsuzluk-coz', {
        method: 'POST',
        body: { stok_yolda_id: yid, cozum_adet: cozumAdet, notu: notu ? String(notu).trim().slice(0, 500) : null },
      });
      toast('Sevkiyat satırı uzlaştırıldı.', 'green');
      publishGlobalDataRefresh('ops-sevkiyat-uyumsuzluk-cozuldu');
      await yukleSevkiyatUyumOzet({ silent: true });
      await sevkiyatUyumDetayYukle();
    } catch (e) {
      toast(e.message || 'Uzlaştırma kaydedilemedi');
    } finally {
      setSevkiyatUyumCozBusy('');
    }
  }, [toast, yukleSevkiyatUyumOzet, sevkiyatUyumDetayYukle]);

  const yukleSiparisMerkez = useCallback(async () => {
    try {
      const [cat, subeler, dr, ozel] = await Promise.all([
        api('/ops/siparis/katalog'),
        api('/subeler').catch(() => []),
        api('/ops/siparis/depo-sevkiyat-raporlari?gun=21&limit=40').catch(() => ({ raporlar: [] })),
        api('/ops/siparis/ozel-bekleyen').catch(() => ({ talepler: [] })),
      ]);
      setSipKat(cat.kategoriler || []);
      setDepoSevkiyatRaporlari(dr?.raporlar || []);
      setSipOzelBekleyen(Array.isArray(ozel?.talepler) ? ozel.talepler : []);
      if (Array.isArray(subeler)) {
        setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
      }
    } catch (e) {
      toast(e.message || 'Sipariş verisi yüklenemedi');
    }
  }, [toast]);

  async function siparisOzelIslemYap(talep, islem) {
    const tid = String(talep?.id || '').trim();
    if (!tid) return;
    setSipOzelBusyId(`${tid}:${islem}`);
    try {
      const notAciklama = String(sipOzelNotMap[tid] || '').trim();
      await api('/ops/siparis/ozel-islem', {
        method: 'POST',
        body: {
          talep_id: tid,
          islem,
          not_aciklama: notAciklama || null,
        },
      });
      if (islem === 'katalog') toast('Ozel talep kataloga alindi.', 'green');
      else if (islem === 'tek_sefer') toast('Ozel talep tek seferlik siparise cevrildi.', 'green');
      else toast('Ozel talep reddedildi.', 'green');
      setSipOzelNotMap((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, tid)) return prev;
        const next = { ...prev };
        delete next[tid];
        return next;
      });
      await yukleSiparisMerkez();
      fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => {});
    } catch (e) {
      toast(e.message || 'Ozel talep islemi basarisiz');
    } finally {
      setSipOzelBusyId(null);
    }
  }

  const yukleSiparisKabulTakip = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      q.set('gun', String(Math.max(1, Number(siparisKabulTakipGun || 14))));
      q.set('limit', '180');
      if (String(siparisKabulTakipSube || '').trim()) q.set('sube_id', String(siparisKabulTakipSube).trim());
      const [r, subeler] = await Promise.all([
        api('/ops/siparis/kabul-takip?' + q.toString()),
        api('/subeler').catch(() => []),
      ]);
      setSiparisKabulTakip({ gun: Number(r?.gun || 14), satirlar: Array.isArray(r?.satirlar) ? r.satirlar : [] });
      if (Array.isArray(subeler)) {
        setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
      }
    } catch (e) {
      toast(e.message || 'Sipariş kabul takibi yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [siparisKabulTakipGun, siparisKabulTakipSube]);

  const yukleToptanciSiparisleri = useCallback(async () => {
    const seciliGun = Math.max(1, Number(toptanciSiparisGun || 30));
    try {
      const q = new URLSearchParams();
      q.set('gun', String(seciliGun));
      q.set('limit', '1200');
      const r = await api('/ops/siparis/toptanci-listesi?' + q.toString());
      setToptanciSiparisListe({
        gun: Number(r?.gun || seciliGun),
        toplam_kayit: Number(r?.toplam_kayit || 0),
        satirlar: Array.isArray(r?.satirlar) ? r.satirlar : [],
      });
    } catch (e) {
      toast(e.message || 'Toptancı sipariş listesi yüklenemedi');
      setToptanciSiparisListe({ gun: seciliGun, toplam_kayit: 0, satirlar: [] });
    } finally {
      setYukleniyor(false);
    }
  }, [toast, toptanciSiparisGun]);

  const yukleToptanciTeslimler = useCallback(async () => {
    const seciliGun = Math.max(1, Number(toptanciTeslimGun || 30));
    try {
      const r = await api(`/ops/toptanci-teslimler?gun=${seciliGun}`);
      setToptanciTeslimListe({
        gun: Number(r?.gun || seciliGun),
        toplam_sube: Number(r?.toplam_sube || 0),
        subeler: Array.isArray(r?.subeler) ? r.subeler : [],
      });
    } catch (e) {
      toast(e.message || 'Toptancı teslimat listesi yüklenemedi');
      setToptanciTeslimListe({ gun: seciliGun, toplam_sube: 0, subeler: [] });
    } finally {
      setYukleniyor(false);
    }
  }, [toast, toptanciTeslimGun]);

  const yukleAnalitik = useCallback(async () => {
    try {
      const r = await api(`/ops/analitik-ozet?gun=${analitikGun}`);
      setAnalitikVeri(r);
    } catch (e) {
      toast(e.message || 'Analitik yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [toast, analitikGun]);

  const yukleStokTahmin = useCallback(async () => {
    try {
      const qs = stokTahminSube ? `gun=${stokTahminGun}&sube_id=${encodeURIComponent(stokTahminSube)}` : `gun=${stokTahminGun}`;
      const r = await api(`/ops/stok-tahmin?${qs}`);
      setStokTahminVeri(r);
    } catch (e) {
      toast(e.message || 'Stok tahmin yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [toast, stokTahminGun, stokTahminSube]);

  const yukleOnayMerkez = useCallback(async () => {
    try {
      const qs = `year_month=${encodeURIComponent(ayFiltre)}`;
      const sq = subeOnayFiltre ? `&sube_id=${encodeURIComponent(subeOnayFiltre)}` : '';
      const [b, n, subeler] = await Promise.all([
        api(`/ops/bekleyen-merkez?${qs}${sq}`),
        api(`/ops/sube-notlar?${qs}${sq}&limit=200`),
        api('/subeler'),
      ]);
      setBekleyenPaket(b);
      setNotlarListe(n?.satirlar || []);
      if (Array.isArray(subeler)) {
        setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
      }
    } catch (e) {
      toast(e.message || 'Onay merkezi yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [ayFiltre, subeOnayFiltre]);

  const yukleMetrics = useCallback(async () => {
    try {
      const [pv, sk, fo, st] = await Promise.all([
        api('/ops/metrics/personel-verimlilik?gun=30').catch((e) => { console.warn('personel-verimlilik:', e?.message); return null; }),
        api('/ops/metrics/sube-operasyon-kalite?gun=30').catch((e) => { console.warn('sube-operasyon-kalite:', e?.message); return null; }),
        api('/ops/metrics/finans-ozet?gun=30').catch((e) => { console.warn('finans-ozet:', e?.message); return null; }),
        api('/ops/metrics/stok-tedarik?gun=30').catch((e) => { console.warn('stok-tedarik:', e?.message); return null; }),
      ]);
      setMPersonelVerimlilik(pv);
      setMSubeOperasyonKalite(sk);
      setMFinansOzet(fo);
      setMStokTedarik(st);
    } catch (e) {
      console.error('yukleMetrics hata:', e);
    } finally {
      setYukleniyor(false);
    }
  }, []);

  const yukleKontrolOzet = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kontrolSadeceAlarmlar) params.set('sadece_alarmlar', 'true');
      if (kontrolKategori) params.set('kategori', kontrolKategori);
      const payload = await api('/ops/kontrol-ozet?' + params.toString());
      setKontrolData(payload || null);
    } catch (e) {
      toast(e.message || 'Kontrol özeti yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [kontrolSadeceAlarmlar, kontrolKategori]);

  const yukleFisBekleyen = useCallback(async () => {
    try {
      const r = await api('/ops/gider-fis-bekleyen?gun=7');
      setFisBekleyen(r?.satirlar || []);
    } catch (e) {
      toast(e.message || 'Fiş listesi yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  const yukleDisiplin = useCallback(async () => {
    setDisiplinYukleniyor(true);
    const hatalar = [];
    const safe = (label, p) => p.catch((e) => { hatalar.push(label); console.warn(`[disiplin] ${label}:`, e?.message); return null; });
    try {
      const [kr, ak, dav, sk, bek, dep] = await Promise.all([
        safe('kritik-stok',        api('/ops/v2/kritik-stok')),
        safe('siparis-akis',       api('/ops/v2/siparis-akis?limit=50')),
        safe('sube-davranis',      api('/ops/v2/sube-davranis?gun=30')),
        safe('sube-skor',          api('/ops/v2/sube-skor')),
        safe('bekleyen-siparisler',api('/ops/v2/bekleyen-siparisler?gun=7')),
        safe('depolar',            api('/ops/subeler/depolar')),
      ]);
      if (kr)  setKritikStok(kr);
      if (ak)  setSiparisAkis(ak);
      if (dav) setSubeDavranis(dav);
      if (sk)  setSubeSkor(sk);
      if (bek) setBekleyenSiparisler(bek);
      if (dep) setKuyrukDepolar(dep.satirlar || []);
      if (hatalar.length) toast(`Stok Disiplin: ${hatalar.join(', ')} yüklenemedi`, 'warn');
    } catch (e) {
      toast(e.message || 'Disiplin verisi yüklenemedi');
    } finally {
      setDisiplinYukleniyor(false);
      setYukleniyor(false);
    }
  }, [toast]);

  const yukle = useCallback(async (f = filtre) => {
    try {
      const q = `year_month=${encodeURIComponent(ayFiltre)}${gunFiltre ? `&gun=${encodeURIComponent(gunFiltre)}` : ''}`;
      const calls = [api(`/ops/dashboard?filtre=${f}`)];
      if (aktifSekme === 'canli') {
        calls.push(api('/ops/skor').catch(() => null));
      } else if (aktifSekme === 'stok-kayip') {
        calls.push(api('/ops/stok-kayip-analiz?gun=45').catch(() => null));
      } else if (aktifSekme === 'personel-davranis') {
        calls.push(api('/ops/personel-davranis-analiz?gun=45').catch(() => null));
      } else if (aktifSekme === 'defter') {
        calls.push(api(`/ops/defter?limit=300&${q}`));
      } else if (aktifSekme === 'sayim') {
        calls.push(
          Promise.all([
            api(`/ops/sayimlar?limit=300&${q}`).catch(() => ({ satirlar: [] })),
            api(`/ops/bar-ozet?limit=120&${q}`).catch(() => ({ satirlar: [] })),
          ])
        );
      } else {
        calls.push(Promise.resolve({ satirlar: [] }));
      }
      const [dash, extra] = await Promise.all(calls);
      setKartlar(dash.kartlar || []);
      setOzet(dash);
      if (aktifSekme === 'canli') {
        setSkor(extra);
      } else if (aktifSekme === 'stok-kayip') {
        setStokKayip(extra || null);
      } else if (aktifSekme === 'personel-davranis') {
        setPersonelDavranis(extra || null);
      } else if (aktifSekme === 'defter') {
        setDefter(extra?.satirlar || []);
      } else if (aktifSekme === 'sayim') {
        const [sayimRes, barRes] = Array.isArray(extra) ? extra : [extra, null];
        setSayimlar(sayimRes?.satirlar || []);
        setBarOzet(barRes?.satirlar || []);
      }
      setSonYenileme(new Date().toLocaleTimeString('tr-TR'));
      return dash;
    } catch (e) {
      toast(e.message || 'Yükleme hatası');
      return null;
    } finally {
      setYukleniyor(false);
    }
  }, [filtre, aktifSekme, ayFiltre, gunFiltre]);

  const magazaDepoTamYenile = useCallback(async () => {
    setYukleniyor(true);
    setMagazaDepoKatalogState((s) => ({ ...s, yukleniyor: true }));
    try {
      const dash = await yukle(filtre);
      const catRes = await api('/ops/siparis/katalog').catch(() => ({ kategoriler: [] }));
      setMagazaDepoKatalogState({
        yukleniyor: false,
        kategoriler: siparisKatalogLikeSubePanelNormalize(catRes?.kategoriler || []),
      });
      const liveKartlar = Array.isArray(dash?.kartlar) ? dash.kartlar : [];
      const subeler = magazaDepoEtkinSubeler(liveKartlar);
      const canliReq = subeler.map(async (m) => {
        let sid = String(m.sube_id || '').trim();
        if (!sid) {
          const kk = magazaKartBul(liveKartlar, m);
          sid = String(kk?.sube_id || '').trim();
        }
        const slug = m.slug;
        if (!sid) return [slug, [], { alarm_sayisi: 0, durum: 'hub_yok' }];
        try {
          const r = await api(`/ops/v2/sube/${encodeURIComponent(sid)}/depo`);
          const stok = Array.isArray(r?.stok) ? r.stok : [];
          const alarm_sayisi = Number(r?.alarm_sayisi ?? 0);
          return [slug, stok, { alarm_sayisi: Number.isFinite(alarm_sayisi) ? alarm_sayisi : 0, durum: 'ok' }];
        } catch {
          return [slug, [], { alarm_sayisi: 0, durum: 'api_hata' }];
        }
      });
      const canliPairs = await Promise.all(canliReq);
      const canliMap = {};
      const metaMap = {};
      canliPairs.forEach((trip) => {
        const [slug, stok, meta] = trip;
        canliMap[slug] = stok;
        metaMap[slug] = meta;
      });
      setMagazaDepoCanliStok(canliMap);
      setMagazaDepoDepoMeta(metaMap);
      if (magazaDepoUstSekmeRef.current === 'genel-ozet' || magazaDepoUstSekmeRef.current === 'katalog-sube-stok') {
        const g = Math.max(1, Math.min(366, Number(magazaDepoOzetGunRef.current) || 30));
        try {
          const oz = await api(`/ops/v2/depo-ozet?gun=${g}`);
          setMagazaDepoOzet(oz || null);
        } catch {
          setMagazaDepoOzet(null);
        }
      }
    } catch {
      setMagazaDepoKatalogState({ yukleniyor: false, kategoriler: [] });
      setMagazaDepoCanliStok({});
      setMagazaDepoDepoMeta({});
    }
  }, [filtre, yukle]);

  const magazaStokOnayBekleyenAdet = Object.keys(magazaStokOnayBekleyen || {}).length;
  const oncekiSekmeRef = useRef(aktifSekme);

  const magazaStokKalemOnayla = useCallback(async ({
    slug,
    subeDepoKey,
    subeId,
    kalemKodu,
    kalemAdi,
    mevcutAdet,
    minStok,
    alisFiyatiTl,
  }) => {
    const sid = String(subeId || '').trim();
    const kk = String(kalemKodu || '').trim();
    const draftKey = `${subeDepoKey}::${kk}`;
    if (!sid || !kk) {
      toast('Bu depo kartında şube/kalem bilgisi eksik.', 'red');
      return;
    }
    setMagazaStokOnayBusy((prev) => ({ ...prev, [draftKey]: true }));
    try {
      await api('/ops/v2/sube-depo/guncelle', {
        method: 'POST',
        body: {
          sube_id: sid,
          kalem_kodu: kk,
          kalem_adi: String(kalemAdi || kk),
          mevcut_adet: Math.max(0, Number(mevcutAdet || 0)),
          min_stok: Math.max(0, Number(minStok || 0)),
          alis_fiyati_tl: Math.max(0, Number(alisFiyatiTl || 0)),
          giris_nedeni: 'sayim_duzeltme',
        },
      });
      setMagazaDepoCanliStok((prev) => {
        const rows = Array.isArray(prev?.[slug]) ? [...prev[slug]] : [];
        const i = rows.findIndex((r) => String(r?.kalem_kodu || '') === kk);
        const nextRow = i >= 0 ? { ...rows[i] } : { kalem_kodu: kk, kalem_adi: String(kalemAdi || kk) };
        nextRow.kalem_adi = String(kalemAdi || nextRow.kalem_adi || kk);
        nextRow.mevcut_adet = Math.max(0, Number(mevcutAdet || 0));
        nextRow.min_stok = Math.max(0, Number(minStok || 0));
        nextRow.alis_fiyati_tl = Math.max(0, Number(alisFiyatiTl || 0));
        if (i >= 0) rows[i] = nextRow;
        else rows.push(nextRow);
        return { ...prev, [slug]: rows };
      });
      setMagazaSubeStokInput((prev) => {
        const n = { ...prev };
        delete n[draftKey];
        return n;
      });
      setMagazaStokOnayBekleyen((prev) => {
        const n = { ...prev };
        delete n[draftKey];
        return n;
      });
      toast(`${String(kalemAdi || kk)} depoya işlendi ✓`, 'green');
    } catch (e) {
      toast(e?.message || 'Depo stok onayı başarısız.', 'red');
    } finally {
      setMagazaStokOnayBusy((prev) => {
        const n = { ...prev };
        delete n[draftKey];
        return n;
      });
    }
  }, [toast]);

  const magazaDepoHavuzKaydet = useCallback(
    async ({ kategoriKod, urunId, depoStokKalemKoduRaw }) => {
      const uid = String(urunId || '').trim();
      const kk = String(kategoriKod || '').trim();
      if (!uid || !kk) {
        toast('Kategori / ürün bilgisi eksik.', 'red');
        return;
      }
      setMagazaDepoHavuzBusy((prev) => ({ ...prev, [uid]: true }));
      try {
        const r = await api('/ops/siparis/urun-depo-kalem', {
          method: 'POST',
          body: {
            kategori_kod: kk,
            urun_id: uid,
            depo_stok_kalem_kodu: String(depoStokKalemKoduRaw ?? '').trim() || null,
          },
        });
        const saved = r?.depo_stok_kalem_kodu != null && String(r.depo_stok_kalem_kodu).trim()
          ? String(r.depo_stok_kalem_kodu).trim()
          : null;
        setMagazaDepoKatalogState((prev) => {
          const cats = Array.isArray(prev.kategoriler)
            ? prev.kategoriler.map((c) => ({
              ...c,
              items: (c.items || []).map((it) => {
                if (String(it?.id || '') !== uid) return it;
                return { ...it, depo_stok_kalem_kodu: saved };
              }),
            }))
            : [];
          return { ...prev, kategoriler: cats };
        });
        setMagazaDepoHavuzTaslak((prev) => {
          const n = { ...prev };
          delete n[uid];
          return n;
        });
        toast('Depo havuz kodu kaydedildi ✓', 'green');
      } catch (e) {
        toast(e?.message || 'Depo havuz kodu kaydedilemedi.', 'red');
      } finally {
        setMagazaDepoHavuzBusy((prev) => {
          const n = { ...prev };
          delete n[uid];
          return n;
        });
      }
    },
    [toast],
  );

  const yenileDetayKart = useCallback(
    async (subeId, f = filtre) => {
      const dash = await yukle(f);
      const guncel = (dash?.kartlar || []).find((k) => k.sube_id === subeId);
      if (guncel) setDetay(guncel);
      else setDetay(null);
    },
    [yukle, filtre],
  );

  useEffect(() => {
    if (!aktifSekme) return;
    if (aktifSekme === 'onay' || aktifSekme === 'siparis' || aktifSekme === 'siparis-kabul-takip' || aktifSekme === 'toptanci-siparisleri' || aktifSekme === 'urun-ac' || aktifSekme === 'gec-acilan-subeler' || aktifSekme === 'gec-kalan-personel' || aktifSekme === 'kullanilan-urunler' || aktifSekme === 'ciro-onay' || aktifSekme === 'kasa-uyumsuzluk' || aktifSekme === 'personel-vardiya-uyumsuzluk' || aktifSekme === 'urun-uyumsuzluk' || aktifSekme === 'sevkiyat-uyumsuzluk' || aktifSekme === 'magaza-kartlari' || aktifSekme === 'metrics' || aktifSekme === 'kontrol' || aktifSekme === 'stok-disiplin') return;
    yukle(filtre);
  }, [filtre, aktifSekme, ayFiltre, gunFiltre, yukle]);

  useEffect(() => {
    if (aktifSekme !== 'onay') return;
    setYukleniyor(true);
    yukleOnayMerkez();
  }, [aktifSekme, ayFiltre, subeOnayFiltre, yukleOnayMerkez]);

  useEffect(() => {
    if (aktifSekme !== 'mesaj') return;
    api('/ops/merkez-mesajlar?limit=100')
      .then((r) => setMesajListe(r.satirlar || []))
      .catch(() => {});
    api('/subeler')
      .then((subeler) => {
        if (Array.isArray(subeler)) {
          setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
        }
      })
      .catch(() => {});
  }, [aktifSekme]);

  useEffect(() => {
    if (aktifSekme !== 'puan') return;
    const q = puanSubeFiltre ? `?sube_id=${encodeURIComponent(puanSubeFiltre)}&gun=30` : '?gun=30';
    api(`/ops/sube-personel-puan${q}`)
      .then(r => setPuanListe(r.personeller || []))
      .catch(() => {});
    api('/ops/personel-takip')
      .then(r => {
        const m = {};
        (r?.satirlar || []).forEach((t) => { if (t?.personel_id) m[t.personel_id] = t; });
        setTakipMap(m);
      })
      .catch(() => {});
  }, [aktifSekme, puanSubeFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'siparis') return;
    setYukleniyor(true);
    yukleSiparisMerkez().finally(() => setYukleniyor(false));
  }, [aktifSekme, yukleSiparisMerkez]);

  useEffect(() => {
    if (aktifSekme !== 'siparis-kabul-takip') return;
    setYukleniyor(true);
    yukleSiparisKabulTakip();
  }, [aktifSekme, yukleSiparisKabulTakip]);

  useEffect(() => {
    if (aktifSekme !== 'toptanci-siparisleri') return;
    setYukleniyor(true);
    yukleToptanciSiparisleri();
  }, [aktifSekme, yukleToptanciSiparisleri]);

  useEffect(() => {
    if (aktifSekme !== 'toptanci-teslimler') return;
    setYukleniyor(true);
    yukleToptanciTeslimler();
  }, [aktifSekme, yukleToptanciTeslimler]);

  useEffect(() => {
    if (aktifSekme !== 'analitik') return;
    setYukleniyor(true);
    yukleAnalitik();
  }, [aktifSekme, yukleAnalitik]);

  useEffect(() => {
    if (aktifSekme !== 'stok-tahmin') return;
    setYukleniyor(true);
    yukleStokTahmin();
  }, [aktifSekme, yukleStokTahmin]);

  useEffect(() => {
    if (!opsMerkezPencere) return;
    if ((toptanciSiparisListe?.satirlar || []).length > 0) return;
    yukleToptanciSiparisleri();
  }, [opsMerkezPencere, toptanciSiparisListe?.satirlar, yukleToptanciSiparisleri]);

  useEffect(() => {
    if (aktifSekme !== 'urun-ac') return;
    setYukleniyor(true);
    setUrunAcHaftaYukleniyor(true);
    urunAcHaftaYukle()
      .then(setUrunAcHaftaSatirlari)
      .catch(() => {})
      .finally(() => setUrunAcHaftaYukleniyor(false));
    urunAcGunYukle(bugunIsoTarih())
      .then((data) => {
        setUrunAcAramaTarih(data.tarih || bugunIsoTarih());
        setUrunAcAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Ürün aç akışı yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, urunAcGunYukle, urunAcHaftaYukle]);

  useEffect(() => {
    if (aktifSekme !== 'gec-acilan-subeler') return;
    setYukleniyor(true);
    setGecAcilanHaftaYukleniyor(true);
    gecAcilanHaftaYukle()
      .then(setGecAcilanHaftaSatirlari)
      .catch(() => {})
      .finally(() => setGecAcilanHaftaYukleniyor(false));
    gecAcilanGunYukle(bugunIsoTarih())
      .then((data) => {
        setGecAcilanAramaTarih(data.tarih || bugunIsoTarih());
        setGecAcilanAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Geç açılan şubeler yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, gecAcilanGunYukle, gecAcilanHaftaYukle]);

  useEffect(() => {
    if (aktifSekme === 'gec-acilan-subeler') return;
    setGecAcilanKartSekme('akis');
  }, [aktifSekme]);

  useEffect(() => {
    if (aktifSekme !== 'gec-kalan-personel') return;
    setYukleniyor(true);
    gecKalanPersonelAyYukle(varsayilanAy)
      .then((data) => {
        setGecKalanPersonelAy(data.year_month || varsayilanAy);
        setGecKalanPersonelAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Geç kalan personel yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, gecKalanPersonelAyYukle, varsayilanAy]);

  useEffect(() => {
    if (aktifSekme !== 'kullanilan-urunler') return;
    setYukleniyor(true);
    setKullanilanHaftaYukleniyor(true);
    kullanilanHaftaYukle()
      .then(setKullanilanHaftaSatirlari)
      .catch(() => {})
      .finally(() => setKullanilanHaftaYukleniyor(false));
    kullanilanGunYukle(bugunIsoTarih())
      .then((data) => {
        setKullanilanAramaTarih(data.tarih || bugunIsoTarih());
        setKullanilanAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Kullanılan ürünler yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, kullanilanGunYukle, kullanilanHaftaYukle]);

  useEffect(() => {
    if (aktifSekme !== 'kapanis-takip') {
      if (kapanisTakipIntervalRef.current) {
        clearInterval(kapanisTakipIntervalRef.current);
        kapanisTakipIntervalRef.current = null;
      }
      return;
    }
    yukleKapanisTakip(kapanisTakipTarih);
    // Bugünkü görünümde 2 dakikada bir otomatik yenile
    if (kapanisTakipTarih === isGunuIsoIstanbul()) {
      kapanisTakipIntervalRef.current = setInterval(() => {
        yukleKapanisTakip(kapanisTakipTarih, { silent: true });
      }, 120_000);
    }
    return () => {
      if (kapanisTakipIntervalRef.current) {
        clearInterval(kapanisTakipIntervalRef.current);
        kapanisTakipIntervalRef.current = null;
      }
    };
  }, [aktifSekme, yukleKapanisTakip, kapanisTakipTarih]);

  useEffect(() => {
    if (aktifSekme !== 'ciro-onay') return;
    setYukleniyor(true);
    ciroOnayGunYukle(isGunuIsoIstanbul())
      .then((data) => {
        setCiroOnayAramaTarih(data.tarih || isGunuIsoIstanbul());
        setCiroOnayAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Bekleyen ciro onayları yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, ciroOnayGunYukle, toast]);

  useEffect(() => {
    if (aktifSekme !== 'kasa-uyumsuzluk') return;
    setYukleniyor(true);
    setKasaUyumHaftaYukleniyor(true);
    kasaUyumHaftaYukle()
      .then(setKasaUyumHaftaSatirlari)
      .catch(() => {})
      .finally(() => setKasaUyumHaftaYukleniyor(false));
    kasaUyumGunYukle(bugunIsoTarih())
      .then((data) => {
        setKasaUyumAramaTarih(data.tarih || bugunIsoTarih());
        setKasaUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Kasa uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, kasaUyumGunYukle, kasaUyumHaftaYukle]);

  useEffect(() => {
    if (aktifSekme !== 'personel-vardiya-uyumsuzluk') return;
    setYukleniyor(true);
    setPersonelVardiyaUyumHaftaYukleniyor(true);
    personelVardiyaUyumHaftaYukle()
      .then(setPersonelVardiyaUyumHaftaSatirlari)
      .catch(() => {})
      .finally(() => setPersonelVardiyaUyumHaftaYukleniyor(false));
    personelVardiyaUyumGunYukle(bugunIsoTarih())
      .then((data) => {
        setPersonelVardiyaUyumAramaTarih(data.tarih || bugunIsoTarih());
        setPersonelVardiyaUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Personel uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, personelVardiyaUyumGunYukle, personelVardiyaUyumHaftaYukle]);

  useEffect(() => {
    if (aktifSekme !== 'urun-uyumsuzluk') return;
    setYukleniyor(true);
    urunUyumGunYukle(bugunIsoTarih())
      .then((data) => {
        setUrunUyumAramaTarih(data.tarih || bugunIsoTarih());
        setUrunUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Ürün uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, urunUyumGunYukle]);

  useEffect(() => {
    if (aktifSekme !== 'sevkiyat-uyumsuzluk') return;
    setYukleniyor(true);
    sevkiyatUyumDetayYukle()
      .catch((e) => toast(e.message || 'Sevkiyat uyumsuzlukları yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, sevkiyatUyumGun, sevkiyatUyumDetayYukle, toast]);

  useEffect(() => {
    if (aktifSekme !== 'magaza-kartlari') return;
    magazaDepoTamYenile();
  }, [aktifSekme, filtre, magazaDepoTamYenile]);

  useEffect(() => {
    if (aktifSekme !== 'magaza-kartlari') return undefined;
    if (magazaDepoUstSekme !== 'genel-ozet' && magazaDepoUstSekme !== 'katalog-sube-stok') return undefined;
    let cancelled = false;
    const g = Math.max(1, Math.min(366, Number(magazaDepoOzetGun) || 30));
    setMagazaDepoOzetYukleniyor(true);
    api(`/ops/v2/depo-ozet?gun=${g}`)
      .then((r) => {
        if (!cancelled) setMagazaDepoOzet(r || null);
      })
      .catch(() => {
        if (!cancelled) setMagazaDepoOzet(null);
      })
      .finally(() => {
        if (!cancelled) setMagazaDepoOzetYukleniyor(false);
      });
    return () => { cancelled = true; };
  }, [aktifSekme, magazaDepoUstSekme, magazaDepoOzetGun]);

  useEffect(() => {
    if (magazaStokOnayBekleyenAdet <= 0) return undefined;
    const onBeforeUnload = (ev) => {
      ev.preventDefault();
      ev.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [magazaStokOnayBekleyenAdet]);

  useEffect(() => {
    const onceki = oncekiSekmeRef.current;
    if (
      onceki === 'magaza-kartlari'
      && aktifSekme !== 'magaza-kartlari'
      && magazaStokOnayBekleyenAdet > 0
    ) {
      toast('Depo stoklarında onay bekleyen değişiklik var. Onay yapmadan çıkıyorsunuz.', 'yellow');
      setAktifSekme('magaza-kartlari');
      return;
    }
    oncekiSekmeRef.current = aktifSekme;
  }, [aktifSekme, magazaStokOnayBekleyenAdet, toast]);

  useEffect(() => {
    if (aktifSekme !== 'metrics') return;
    setYukleniyor(true);
    yukleMetrics();
  }, [aktifSekme, yukleMetrics]);

  useEffect(() => {
    if (aktifSekme !== 'kontrol') return;
    setYukleniyor(true);
    yukleKontrolOzet();
  }, [aktifSekme, yukleKontrolOzet]);

  useEffect(() => {
    if (aktifSekme !== 'fis') return;
    setYukleniyor(true);
    yukleFisBekleyen();
  }, [aktifSekme, yukleFisBekleyen]);

  useEffect(() => {
    if (aktifSekme !== 'stok-disiplin') return;
    setYukleniyor(true);
    yukleDisiplin();
  }, [aktifSekme, yukleDisiplin]);

  useEffect(() => {
    const unsub = subscribeGlobalDataRefresh(() => {
      fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => {});
      if (aktifSekme === 'onay') {
        setYukleniyor(true);
        yukleOnayMerkez();
      } else if (aktifSekme === 'urun-ac') {
        setYukleniyor(true);
        setUrunAcHaftaYukleniyor(true);
        urunAcHaftaYukle()
          .then(setUrunAcHaftaSatirlari)
          .catch(() => {})
          .finally(() => setUrunAcHaftaYukleniyor(false));
        urunAcAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'gec-acilan-subeler') {
        setYukleniyor(true);
        setGecAcilanHaftaYukleniyor(true);
        gecAcilanHaftaYukle()
          .then(setGecAcilanHaftaSatirlari)
          .catch(() => {})
          .finally(() => setGecAcilanHaftaYukleniyor(false));
        gecAcilanAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'gec-kalan-personel') {
        setYukleniyor(true);
        gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'kullanilan-urunler') {
        setYukleniyor(true);
        setKullanilanHaftaYukleniyor(true);
        kullanilanHaftaYukle()
          .then(setKullanilanHaftaSatirlari)
          .catch(() => {})
          .finally(() => setKullanilanHaftaYukleniyor(false));
        kullanilanAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'ciro-onay') {
        setYukleniyor(true);
        ciroOnayAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'kasa-uyumsuzluk') {
        setYukleniyor(true);
        setKasaUyumHaftaYukleniyor(true);
        kasaUyumHaftaYukle()
          .then(setKasaUyumHaftaSatirlari)
          .catch(() => {})
          .finally(() => setKasaUyumHaftaYukleniyor(false));
        kasaUyumAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'personel-vardiya-uyumsuzluk') {
        setYukleniyor(true);
        setPersonelVardiyaUyumHaftaYukleniyor(true);
        personelVardiyaUyumHaftaYukle()
          .then(setPersonelVardiyaUyumHaftaSatirlari)
          .catch(() => {})
          .finally(() => setPersonelVardiyaUyumHaftaYukleniyor(false));
        personelVardiyaUyumAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'urun-uyumsuzluk') {
        setYukleniyor(true);
        urunUyumAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'sevkiyat-uyumsuzluk') {
        setYukleniyor(true);
        yukleSevkiyatUyumOzet({ silent: true }).catch(() => {});
        sevkiyatUyumDetayYukle().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'siparis') {
        setYukleniyor(true);
        yukleSiparisMerkez().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'siparis-kabul-takip') {
        setYukleniyor(true);
        yukleSiparisKabulTakip();
      } else if (aktifSekme === 'toptanci-siparisleri') {
        setYukleniyor(true);
        yukleToptanciSiparisleri();
      } else if (aktifSekme === 'toptanci-teslimler') {
        setYukleniyor(true);
        yukleToptanciTeslimler();
      } else if (aktifSekme === 'analitik') {
        setYukleniyor(true);
        yukleAnalitik();
      } else if (aktifSekme === 'stok-tahmin') {
        setYukleniyor(true);
        yukleStokTahmin();
      } else if (aktifSekme === 'magaza-kartlari') {
        magazaDepoTamYenile();
      } else if (aktifSekme === 'metrics') {
        setYukleniyor(true);
        yukleMetrics();
      } else if (aktifSekme === 'kontrol') {
        setYukleniyor(true);
        yukleKontrolOzet();
      } else if (aktifSekme === 'fis') {
        setYukleniyor(true);
        yukleFisBekleyen();
      } else if (aktifSekme === 'stok-disiplin') {
        setYukleniyor(true);
        yukleDisiplin();
      } else if (aktifSekme) {
        yukle(filtre);
      }
    });
    return unsub;
  }, [aktifSekme, filtre, hubOzetIsle, yukle, yukleOnayMerkez, urunAcAramaYap, urunAcHaftaYukle, gecAcilanAramaYap, gecAcilanHaftaYukle, gecKalanPersonelAramaYap, kullanilanAramaYap, kullanilanHaftaYukle, ciroOnayAramaYap, kasaUyumAramaYap, kasaUyumHaftaYukle, personelVardiyaUyumAramaYap, personelVardiyaUyumHaftaYukle, urunUyumAramaYap, yukleSevkiyatUyumOzet, sevkiyatUyumDetayYukle, yukleSiparisMerkez, yukleSiparisKabulTakip, yukleToptanciSiparisleri, toptanciSiparisListe?.gun, yukleToptanciTeslimler, magazaDepoTamYenile, yukleMetrics, yukleKontrolOzet, yukleFisBekleyen, yukleDisiplin]);


  // Haftalık karşılaştırma — sadece ilgili sekme açıkken yükle
  useEffect(() => {
    if (aktifSekme !== 'canli') return;
    api('/ops/haftalik-karsilastirma')
      .then(setHaftalikKarsilastirma)
      .catch(() => {});
  }, [aktifSekme]);

  const toplamGecikme = skor?.son_30_gun?.reduce((s, r) => s + (r.gecikme_adet || 0), 0) || 0;
  const kritikSayi    = kartlar.filter(k => k.bayraklar?.kritik).length;
  const gecikSayi     = kartlar.filter(k => k.bayraklar?.geciken).length;
  const guvenlikSayi  = kartlar.filter(k => k.bayraklar?.guvenlik_alarm).length;
  const karsilastirmaKartlar = [...kartlar].sort((a, b) => String(a?.sube_adi || '').localeCompare(String(b?.sube_adi || ''), 'tr'));
  const hubAcKapBucket = useMemo(() => hubAcilisKapanisBucket(kartlar), [kartlar]);
  const riskliPersonelSubeMap = (personelDavranis?.surekli_riskli_personel || []).reduce((acc, p) => {
    const sid = p?.sube_id || '';
    if (!sid) return acc;
    if (!acc[sid]) acc[sid] = { adet: 0, maxSkor: 0 };
    acc[sid].adet += 1;
    const rs = Number(p?.davranis_risk_skoru || 0);
    if (rs > acc[sid].maxSkor) acc[sid].maxSkor = rs;
    return acc;
  }, {});
  const anlikGiderOnaylari = (bekleyenPaket?.onay_kuyrugu || []).filter(
    (o) => String(o?.islem_turu || '').toUpperCase() === 'ANLIK_GIDER',
  );
  const depoYetersizBildirimler = ((siparisAkis?.siparis_akis || []).flatMap((s) => {
    const satirlar = Array.isArray(s?.tahsis) ? s.tahsis : [];
    return satirlar
      .filter((t) => {
        const d = String(t?.durum || '').trim().toLowerCase();
        const ist = Number(t?.istenen_adet || t?.talep_adet || 0);
        const gon = Number(t?.gonderilen_adet || 0);
        if (d === 'yok' || d === 'kismi') return true;
        return d === 'var' && ist > 0 && gon < ist;
      })
      .map((t) => {
        const ist = Number(t?.istenen_adet || t?.talep_adet || 0);
        const gon = Number(t?.gonderilen_adet || 0);
        const eksik = Math.max(0, ist - gon);
        return {
          talep_id: String(s?.id || ''),
          sube_adi: s?.sube_adi || s?.sube_id || '—',
          urun_ad: t?.urun_ad || t?.kalem_adi || t?.urun_id || t?.kalem_kodu || 'Kalem',
          istenen_adet: ist,
          gonderilen_adet: gon,
          eksik_adet: eksik,
          sevkiyat_durum: s?.durum || '—',
          kalem_durum: String(t?.durum || '').trim().toLowerCase(),
        };
      });
  }) || []).sort((a, b) => b.eksik_adet - a.eksik_adet);
  const depoYetersizAktifSayi = depoYetersizBildirimler.filter((x) => String(x?.sevkiyat_durum || '') !== 'teslim_edildi').length;
  const urunAcBugunZirveSaat = urunAcZirveSaat(urunAcBugun);
  const urunAcAramaZirveSaat = urunAcZirveSaat(urunAcAramaSonuc);
  const urunAcSubeBloklari = urunAcSubeGruplari(urunAcAramaSonuc?.kayitlar || []);
  const urunAcGorunenSubeBloklari = urunAcSeciliSubeKey === 'all'
    ? urunAcSubeBloklari
    : urunAcSubeBloklari.filter((g) => g.key === urunAcSeciliSubeKey);
  const gecAcilanSubeSekmeleri = (() => {
    const m = new Map();
    const add = (row, deltaGec, deltaAc) => {
      const baslik = String(row?.sube_adi || row?.sube_id || 'Diğer').trim() || 'Diğer';
      const key = urunAcSubeAnahtar(baslik) || baslik;
      const cur = m.get(key) || { key, baslik, gec: 0, ac: 0 };
      cur.gec += deltaGec;
      cur.ac += deltaAc;
      m.set(key, cur);
    };
    (gecAcilanAramaSonuc?.kayitlar || []).forEach((r) => add(r, 1, 0));
    (gecAcilanAramaSonuc?.acilmayan_subeler || []).forEach((a) => add(a, 0, 1));
    return Array.from(m.values()).map((x) => ({
      key: x.key,
      baslik: x.baslik,
      adet: x.gec + x.ac,
      gecSayi: x.gec,
      acSayi: x.ac,
    }));
  })();
  gecAcilanSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const gecAcilanGorunenKayitlar = gecAcilanSeciliSubeKey === 'all'
    ? (gecAcilanAramaSonuc?.kayitlar || [])
    : (gecAcilanAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === gecAcilanSeciliSubeKey;
    });
  const gecAcilanAcilmayanGorunen = gecAcilanSeciliSubeKey === 'all'
    ? (gecAcilanAramaSonuc?.acilmayan_subeler || [])
    : (gecAcilanAramaSonuc?.acilmayan_subeler || []).filter((a) => {
      const label = String(a?.sube_adi || a?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === gecAcilanSeciliSubeKey;
    });
  const gecKalanPersonelSatirlari = Array.isArray(gecKalanPersonelAramaSonuc?.satirlar) ? gecKalanPersonelAramaSonuc.satirlar : [];
  const kullanilanSubeSekmeleri = (kullanilanAramaSonuc?.satirlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) {
      bulunan.adet += 1;
    } else {
      acc.push({ key, baslik, adet: 1 });
    }
    return acc;
  }, []);
  kullanilanSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const kullanilanGorunenSatirlar = kullanilanSeciliSubeKey === 'all'
    ? (kullanilanAramaSonuc?.satirlar || [])
    : (kullanilanAramaSonuc?.satirlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === kullanilanSeciliSubeKey;
    });
  const kullanilanGorunenSatirlarSirali = kullanilanSatirlariSubeyeGoreSirala(kullanilanGorunenSatirlar);
  const ciroOnaySubeSekmeleri = (ciroOnayAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const sid = String(r?.sube_id || '').trim();
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = sid ? `id:${sid}` : (urunAcSubeAnahtar(baslik) || baslik);
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  ciroOnaySubeSekmeleri.sort((a, b) => a.baslik.localeCompare(b.baslik, 'tr'));
  const ciroOnayGorunenKayitlar = ciroOnaySeciliSubeKey === 'all'
    ? (ciroOnayAramaSonuc?.kayitlar || [])
    : (ciroOnayAramaSonuc?.kayitlar || []).filter((r) => {
      const sid = String(r?.sube_id || '').trim();
      if (sid && String(ciroOnaySeciliSubeKey || '').startsWith('id:')) {
        return `id:${sid}` === ciroOnaySeciliSubeKey;
      }
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === ciroOnaySeciliSubeKey;
    });
  const barOzetTarihSatirlari = (barOzet || []).filter((r) => String(r?.tarih || '').slice(0, 10) === barOzetTarih);
  const barOzetSubeSekmeleri = barOzetTarihSatirlari.reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) {
      bulunan.adet += 1;
    } else {
      acc.push({ key, baslik, adet: 1 });
    }
    return acc;
  }, []);
  barOzetSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const barOzetGorunenSatirlar = barOzetSeciliSubeKey === 'all'
    ? barOzetTarihSatirlari
    : barOzetTarihSatirlari.filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === barOzetSeciliSubeKey;
    });
  const kasaUyumSubeSekmeleri = (kasaUyumAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  kasaUyumSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const kasaUyumGorunenKayitlar = kasaUyumSeciliSubeKey === 'all'
    ? (kasaUyumAramaSonuc?.kayitlar || [])
    : (kasaUyumAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === kasaUyumSeciliSubeKey;
    });
  const personelVardiyaUyumSubeSekmeleri = (personelVardiyaUyumAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  personelVardiyaUyumSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const personelVardiyaUyumGorunenKayitlar = personelVardiyaUyumSeciliSubeKey === 'all'
    ? (personelVardiyaUyumAramaSonuc?.kayitlar || [])
    : (personelVardiyaUyumAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === personelVardiyaUyumSeciliSubeKey;
    });
  const urunUyumSubeSekmeleri = (urunUyumAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  urunUyumSubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const urunUyumGorunenKayitlar = urunUyumSeciliSubeKey === 'all'
    ? (urunUyumAramaSonuc?.kayitlar || [])
    : (urunUyumAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === urunUyumSeciliSubeKey;
    });

  useEffect(() => {
    if (!urunAcSubeBloklari.length) {
      if (urunAcSeciliSubeKey !== 'all') setUrunAcSeciliSubeKey('all');
      return;
    }
    if (urunAcSeciliSubeKey === 'all') return;
    if (!urunAcSubeBloklari.some((g) => g.key === urunAcSeciliSubeKey)) {
      setUrunAcSeciliSubeKey('all');
    }
  }, [urunAcSeciliSubeKey, urunAcSubeBloklari]);

  useEffect(() => {
    if (!gecAcilanSubeSekmeleri.length) {
      if (gecAcilanSeciliSubeKey !== 'all') setGecAcilanSeciliSubeKey('all');
      return;
    }
    if (gecAcilanSeciliSubeKey === 'all') return;
    if (!gecAcilanSubeSekmeleri.some((s) => s.key === gecAcilanSeciliSubeKey)) {
      setGecAcilanSeciliSubeKey('all');
    }
  }, [gecAcilanSeciliSubeKey, gecAcilanSubeSekmeleri]);

  useEffect(() => {
    if (!kullanilanSubeSekmeleri.length) {
      if (kullanilanSeciliSubeKey !== 'all') setKullanilanSeciliSubeKey('all');
      return;
    }
    if (kullanilanSeciliSubeKey === 'all') return;
    if (!kullanilanSubeSekmeleri.some((g) => g.key === kullanilanSeciliSubeKey)) {
      setKullanilanSeciliSubeKey('all');
    }
  }, [kullanilanSeciliSubeKey, kullanilanSubeSekmeleri]);

  useEffect(() => {
    if (!ciroOnaySubeSekmeleri.length) {
      if (ciroOnaySeciliSubeKey !== 'all') setCiroOnaySeciliSubeKey('all');
      return;
    }
    if (ciroOnaySeciliSubeKey === 'all') return;
    if (!ciroOnaySubeSekmeleri.some((s) => s.key === ciroOnaySeciliSubeKey)) {
      setCiroOnaySeciliSubeKey('all');
    }
  }, [ciroOnaySeciliSubeKey, ciroOnaySubeSekmeleri]);

  useEffect(() => {
    if (!kasaUyumSubeSekmeleri.length) {
      if (kasaUyumSeciliSubeKey !== 'all') setKasaUyumSeciliSubeKey('all');
      return;
    }
    if (kasaUyumSeciliSubeKey === 'all') return;
    if (!kasaUyumSubeSekmeleri.some((s) => s.key === kasaUyumSeciliSubeKey)) {
      setKasaUyumSeciliSubeKey('all');
    }
  }, [kasaUyumSeciliSubeKey, kasaUyumSubeSekmeleri]);

  useEffect(() => {
    if (!personelVardiyaUyumSubeSekmeleri.length) {
      if (personelVardiyaUyumSeciliSubeKey !== 'all') setPersonelVardiyaUyumSeciliSubeKey('all');
      return;
    }
    if (personelVardiyaUyumSeciliSubeKey === 'all') return;
    if (!personelVardiyaUyumSubeSekmeleri.some((s) => s.key === personelVardiyaUyumSeciliSubeKey)) {
      setPersonelVardiyaUyumSeciliSubeKey('all');
    }
  }, [personelVardiyaUyumSeciliSubeKey, personelVardiyaUyumSubeSekmeleri]);

  useEffect(() => {
    if (!urunUyumSubeSekmeleri.length) {
      if (urunUyumSeciliSubeKey !== 'all') setUrunUyumSeciliSubeKey('all');
      return;
    }
    if (urunUyumSeciliSubeKey === 'all') return;
    if (!urunUyumSubeSekmeleri.some((s) => s.key === urunUyumSeciliSubeKey)) {
      setUrunUyumSeciliSubeKey('all');
    }
  }, [urunUyumSeciliSubeKey, urunUyumSubeSekmeleri]);

  useEffect(() => {
    if (!barOzetSubeSekmeleri.length) {
      if (barOzetSeciliSubeKey !== 'all') setBarOzetSeciliSubeKey('all');
      return;
    }
    if (barOzetSeciliSubeKey === 'all') return;
    if (!barOzetSubeSekmeleri.some((s) => s.key === barOzetSeciliSubeKey)) {
      setBarOzetSeciliSubeKey('all');
    }
  }, [barOzetSeciliSubeKey, barOzetSubeSekmeleri]);

  useEffect(() => {
    const loadOzet = () => {
      fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => {});
      if (!opsMerkezPencere) {
        yukleUrunAcBugun({ silent: true }).catch(() => {});
        yukleGecAcilanBugun({ silent: true }).catch(() => {});
        yukleGecKalanPersonelBugun({ silent: true }).catch(() => {});
        yukleKullanilanBugun({ silent: true }).catch(() => {});
        yukleCiroOnayBugun({ silent: true }).catch(() => {});
        yukleKasaUyumBugun({ silent: true }).catch(() => {});
        yuklePersonelVardiyaUyumBugun({ silent: true }).catch(() => {});
        yukleUrunUyumBugun({ silent: true }).catch(() => {});
        yukleSevkiyatUyumBugun({ silent: true }).catch(() => {});
      }
    };
    loadOzet();
    const id = setInterval(loadOzet, 25000);
    const onVis = () => {
      if (document.visibilityState === 'visible') loadOzet();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [hubOzetIsle, opsMerkezPencere, yukleUrunAcBugun, yukleGecAcilanBugun, yukleGecKalanPersonelBugun, yukleKullanilanBugun, yukleCiroOnayBugun, yukleKasaUyumBugun, yuklePersonelVardiyaUyumBugun, yukleUrunUyumBugun, yukleSevkiyatUyumBugun]);

  const acOpsModul = useCallback((id, modulId) => {
    const bolumler = OPS_MODUL_BOLUM[id] || [{ id: 'icerik', label: 'İçerik' }];
    setAktifSekme(id);
    setOpsIcBolum(bolumler[0].id);
    if (modulId !== undefined) setAktifModul(modulId);
    setOpsMerkezPencere(true);
    setYukleniyor(true);
  }, []);

  /** Modül içinde sekme değişimi — yukleniyor tetikler, veri useEffect ile yüklenir */
  const acModulTab = useCallback((tabId) => {
    const bolumler = OPS_MODUL_BOLUM[tabId] || [{ id: 'icerik', label: 'İçerik' }];
    setAktifSekme(tabId);
    setOpsIcBolum(bolumler[0].id);
    setYukleniyor(true);
  }, []);

  /** Hub alarm kartından ilgili modüle git (stok disiplin alt panel dahil) */
  const alarmHedefeGit = useCallback((a) => {
    const m = a?.meta || {};
    let sek = m.hedef_sekme;
    if (!sek) return;
    if (sek === 'siparis') {
      sek = 'stok-disiplin';
      setDisiplinPanel('kuyruk');
      if (m.talep_id) {
        try {
          sessionStorage.setItem('ops_siparis_vurgula_talep', String(m.talep_id));
        } catch (_) {}
      }
    } else if (sek === 'onay') {
      // Legacy hedefleri yeni tek onay kartına yönlendir.
      sek = 'ciro-onay';
    }
    const bolumler = OPS_MODUL_BOLUM[sek] || [{ id: 'icerik', label: 'İçerik' }];
    setAktifSekme(sek);
    setOpsIcBolum(bolumler[0].id);
    const modul = MODULLER.find((m) => m.tabs.includes(sek));
    if (modul) setAktifModul(modul.id);
    setOpsMerkezPencere(true);
    setYukleniyor(true);
    if (sek === 'stok-disiplin' && m.hedef_panel) {
      setDisiplinPanel(String(m.hedef_panel));
    }
    setHubAlarmAcikId(null);
  }, []);

  useEffect(() => {
    if (aktifSekme !== 'stok-disiplin' || !opsMerkezPencere || disiplinPanel !== 'kuyruk') return;
    let tid;
    try {
      tid = sessionStorage.getItem('ops_siparis_vurgula_talep');
      if (!tid) return;
      sessionStorage.removeItem('ops_siparis_vurgula_talep');
    } catch (_) {
      return;
    }
    const safeId = tid.replace(/"/g, '');
    const run = () => {
      const el = document.querySelector(`[data-ops-siparis-talep="${safeId}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    const t1 = window.setTimeout(run, 450);
    const t2 = window.setTimeout(run, 1600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [aktifSekme, opsMerkezPencere, disiplinPanel, bekleyenSiparisler]);

  useEffect(() => {
    if (aktifSekme !== 'onay') return;
    // Eski sekme seçili geldiyse otomatik yeni karta taşı.
    setAktifSekme('ciro-onay');
    setOpsIcBolum('icerik');
    setYukleniyor(true);
  }, [aktifSekme]);

  const kapatOpsModul = useCallback(() => {
    setOpsMerkezPencere(false);
    setAktifSekme('');
    setAktifModul('');
    setDetay(null);
    setYukleniyor(false);
  }, []);

  async function ciroTaslakOnayla(tid) {
    setOnayBusyId(`c:${tid}`);
    try {
      await api(`/ciro-taslak/${encodeURIComponent(tid)}/onayla`, { method: 'POST', body: {} });
      toast('Ciro taslağı onaylandı; kasa ve ciro girişine işlendi.', 'green');
      publishGlobalDataRefresh('ops-onay-ciro');
      await Promise.all([
        ciroOnayAramaYap(),
        yukleCiroOnayBugun({ silent: true }),
      ]);
    } catch (e) {
      toast(e.message || 'Onay başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function ciroTaslakReddet(tid) {
    const neden = window.prompt('Red nedeni (boş bırakılabilir):');
    if (neden === null) return;
    setOnayBusyId(`cr:${tid}`);
    try {
      await api(`/ciro-taslak/${encodeURIComponent(tid)}/reddet`, {
        method: 'POST',
        body: { neden: (neden || '').trim() || 'Reddedildi' },
      });
      toast('Ciro taslağı reddedildi.', 'green');
      publishGlobalDataRefresh('ops-onay-ciro-reddet');
      await Promise.all([
        ciroOnayAramaYap(),
        yukleCiroOnayBugun({ silent: true }),
      ]);
    } catch (e) {
      toast(e.message || 'Red başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kuyrukOnayla(oid, islemTuru = '') {
    setOnayBusyId(`o:${oid}`);
    try {
      await api(`/onay-kuyrugu/${encodeURIComponent(oid)}/onayla`, { method: 'POST' });
      const tur = String(islemTuru || '').toUpperCase();
      if (tur === 'ANLIK_GIDER') {
        toast('Anlık gider onaylandı; gider kaydı aktifleşti ve kuyruktan düştü.', 'green');
      } else {
        toast('Kuyruk kaydı onaylandı.', 'green');
      }
      publishGlobalDataRefresh('ops-onay-kuyruk');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Onay başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kuyrukReddet(oid, islemTuru = '') {
    setOnayBusyId(`or:${oid}`);
    try {
      await api(`/onay-kuyrugu/${encodeURIComponent(oid)}/reddet`, {
        method: 'POST',
        body: { neden: 'hata' },
      });
      const tur = String(islemTuru || '').toUpperCase();
      if (tur === 'ANLIK_GIDER') {
        toast('Anlık gider talebi reddedildi ve kuyruktan düşürüldü.', 'green');
      } else {
        toast('Kuyruk kaydı reddedildi.', 'green');
      }
      publishGlobalDataRefresh('ops-onay-kuyruk-reddet');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Red başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kasaUyumsuzlukCoz(uid) {
    const neden = window.prompt('Çözüm notu (opsiyonel):') ?? '';
    setOnayBusyId(`ku:${uid}`);
    try {
      await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uid)}/coz`, {
        method: 'POST',
        body: { notu: (neden || '').trim() },
      });
      toast('Kasa uyumsuzluk kaydı çözüldü olarak işaretlendi.', 'green');
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-cozuldu');
      kasaUyumHaftaYukle().then(setKasaUyumHaftaSatirlari).catch(() => {});
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Kayıt çözülemedi');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function personelVardiyaUyumsuzlukCoz(uid) {
    const neden = window.prompt('Çözüm notu (opsiyonel):') ?? '';
    setOnayBusyId(`pv:${uid}`);
    try {
      await api(`/ops/personel-vardiya-uyumsuzluk/${encodeURIComponent(uid)}/coz`, {
        method: 'POST',
        body: { notu: (neden || '').trim() },
      });
      toast('Personel uyumsuzluk kaydı çözüldü olarak işaretlendi.', 'green');
      publishGlobalDataRefresh('ops-personel-vardiya-uyumsuzluk-cozuldu');
      personelVardiyaUyumHaftaYukle().then(setPersonelVardiyaUyumHaftaSatirlari).catch(() => {});
      fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => {});
      const hedefTarih = (personelVardiyaUyumAramaTarih || bugunIsoTarih()).trim();
      const [bugunData, detayData] = await Promise.all([
        personelVardiyaUyumGunYukle(bugunIsoTarih()),
        personelVardiyaUyumGunYukle(hedefTarih),
      ]);
      setPersonelVardiyaUyumBugun(bugunData);
      setPersonelVardiyaUyumAramaSonuc(detayData);
    } catch (e) {
      toast(e.message || 'Kayıt çözülemedi');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function fisKontrolIsle(giderId, durum) {
    const notu = window.prompt('Not (opsiyonel):') ?? '';
    setFisBusyId(`${durum}:${giderId}`);
    try {
      await api('/ops/gider-fis-kontrol', { method: 'POST', body: { gider_id: giderId, durum, notu: (notu || '').trim() || null } });
      toast('Fiş kontrol kaydedildi.', 'green');
      await yukleFisBekleyen();
    } catch (e) {
      toast(e.message || 'İşlem başarısız');
    } finally {
      setFisBusyId(null);
    }
  }

  /** Geç Açılan Şubeler: tarih + getir + özet sayılar (her iki kart sekmesinde üstte gösterilir). */
  const gecAcilanTarihSecimPaneli = (
    <div
      className="card"
      style={{
        padding: '14px 16px',
        borderRadius: 10,
        border: '1px solid rgba(249, 115, 22, 0.4)',
        background: 'linear-gradient(165deg, rgba(249, 115, 22, 0.12) 0%, var(--bg) 55%)',
        boxShadow: '0 4px 18px rgba(0, 0, 0, 0.07)',
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 800,
          color: 'var(--text)',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span aria-hidden>📅</span>
        Tarih seçerek detay
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>— şube listesi ve tablolar</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ margin: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
          <input
            type="date"
            className="input"
            value={gecAcilanAramaTarih}
            onChange={(e) => setGecAcilanAramaTarih(e.target.value || bugunIsoTarih())}
          />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ alignSelf: 'flex-end' }}
          onClick={() => gecAcilanAramaYap()}
        >
          {gecAcilanAramaYukleniyor ? '…' : 'Tarihi getir'}
        </button>
        <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
          {gecAcilanAramaSonuc?.tarih || gecAcilanAramaTarih}
          {gecAcilanKartSekme === 'akis' ? (
            <>
              {' · '}
              {gecAcilanAramaSonuc?.toplam || 0} geç açılış
              {' · '}
              {Number(gecAcilanAramaSonuc?.acilmayan_toplam ?? (gecAcilanAramaSonuc?.acilmayan_subeler || []).length ?? 0)} henüz açılmamış
            </>
          ) : (
            <>
              {' · '}
              {Number(gecAcilanAramaSonuc?.plan_kayitsiz_toplam ?? (gecAcilanAramaSonuc?.plan_kayitsiz_subeler || []).length ?? 0)} şube (planlı, ACILIS yok)
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      {Number(ozet?.yarim_urun_ac_oturum_sayisi || 0) > 0 && (
        <div className="alert-box yellow mb-16" style={{ padding: '12px 16px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            ⚠️ Yarım Kalan Ürün Aç Oturumları
            <span style={{ background: 'rgba(245,158,11,0.25)', borderRadius: 12, padding: '1px 10px', fontSize: 13 }}>
              {Number(ozet?.yarim_urun_ac_oturum_sayisi || 0)} şube
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
            Personel PIN girmeden işlemi terk etti — ürün açma tamamlanmadı.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(ozet?.yarim_urun_ac_oturumlar || []).map((x, i) => (
              <div key={i} style={{ background: 'rgba(0,0,0,0.18)', borderRadius: 8, padding: '8px 12px', border: '1px solid rgba(245,158,11,0.3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>🏪 {x.sube_adi}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {x.guncelleme ? (() => {
                      const d = new Date(x.guncelleme);
                      const now = new Date();
                      const dakika = Math.floor((now - d) / 60000);
                      const saatStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                      return dakika < 60
                        ? `${saatStr} · ${dakika} dk önce`
                        : `${saatStr} · ${Math.floor(dakika / 60)} sa ${dakika % 60} dk önce`;
                    })() : '—'}
                  </span>
                </div>
                {x.personel_id && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>
                    👤 Personel: {x.personel_id}
                  </div>
                )}
                {Array.isArray(x.kalemler) && x.kalemler.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                    {x.kalemler.map((k, j) => (
                      <span key={j} style={{ background: 'rgba(245,158,11,0.2)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                        {k.urun_ad}{k.aciklama ? ` (${k.aciklama})` : ''} × {k.adet}
                      </span>
                    ))}
                  </div>
                )}
                {x.not_aciklama && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, fontStyle: 'italic' }}>
                    Not: {x.not_aciklama}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(ozet?.kasa_devir_listesi || []).length > 0 && (
        <div className="alert-box mb-16" style={{ padding: '12px 16px', background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.3)', color: 'var(--text)' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            💼 Kasa Devri
            <span style={{ background: 'rgba(59,130,246,0.25)', borderRadius: 12, padding: '1px 10px', fontSize: 13 }}>
              {(ozet.kasa_devir_listesi || []).length} şube
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(ozet.kasa_devir_listesi || []).map((x, i) => {
              const tamamlandi = x.durum === 'tamamlandi';
              const saatStr = x.sabah_ts ? (() => {
                const d = new Date(x.sabah_ts);
                return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
              })() : '—';
              return (
                <div key={i} style={{ background: 'rgba(0,0,0,0.18)', borderRadius: 8, padding: '8px 12px', border: `1px solid ${tamamlandi ? 'rgba(34,197,94,0.4)' : 'rgba(245,158,11,0.4)'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>🏪 {x.sube_adi}</span>
                    <span style={{ fontSize: 11, borderRadius: 8, padding: '2px 8px', background: tamamlandi ? 'rgba(34,197,94,0.2)' : 'rgba(245,158,11,0.2)', color: tamamlandi ? '#4ade80' : '#fbbf24', fontWeight: 600 }}>
                      {tamamlandi ? '✓ Tamamlandı' : '⏳ Akşamcı bekliyor'}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                    {x.sabahci_adi && <span>👤 Sabahçı: <strong style={{ color: 'var(--text)' }}>{x.sabahci_adi}</strong></span>}
                    {x.aksamci_adi && <span style={{ marginLeft: 12 }}>🌙 Akşamcı: <strong style={{ color: 'var(--text)' }}>{x.aksamci_adi}</strong></span>}
                    {saatStr !== '—' && <span style={{ marginLeft: 12 }}>⏰ {saatStr}</span>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12, marginBottom: (x.devir_stok || []).length > 0 ? 6 : 0 }}>
                    <span style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 6, padding: '2px 8px' }}>
                      Teslim Kasa: <strong>{Number(x.teslim || 0).toLocaleString('tr-TR')} ₺</strong>
                    </span>
                    <span style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 6, padding: '2px 8px' }}>
                      Devir: <strong>{Number(x.devir || 0).toLocaleString('tr-TR')} ₺</strong>
                    </span>
                  </div>
                  {(x.devir_stok || []).length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3 }}>📦 Devir stok sayımı:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {(x.devir_stok || []).map((s, si) => (
                          <span key={si} style={{ background: 'rgba(59,130,246,0.15)', borderRadius: 5, padding: '1px 7px', fontSize: 11 }}>
                            {s.label}: <strong>{s.adet}</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="page-header flex items-center justify-between">
        <div>
          {(ozet?.kapanis_ozet_listesi || []).length > 0 && (
            <div className="alert-box green mb-16" style={{ padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                🏁 Bugün Kapanış Yapan Şubeler
                <span style={{ background: 'rgba(76,175,132,0.25)', borderRadius: 12, padding: '1px 10px', fontSize: 13 }}>
                  {(ozet.kapanis_ozet_listesi || []).length} şube
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(ozet.kapanis_ozet_listesi || []).map((x, i) => {
                  const saatStr = x.olay_ts ? new Date(x.olay_ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—';
                  return (
                    <div key={i} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '7px 12px', border: '1px solid rgba(76,175,132,0.3)', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, minWidth: 120 }}>✅ {x.sube_adi}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>⏰ {saatStr}</span>
                      {x.personel_adi && <span style={{ fontSize: 11, color: 'var(--text3)' }}>👤 {x.personel_adi}</span>}
                      <span style={{ fontSize: 12, background: 'rgba(76,175,132,0.15)', borderRadius: 6, padding: '1px 8px' }}>Kasa: <strong>{Number(x.kasa_sayim || 0).toLocaleString('tr-TR')} ₺</strong></span>
                      <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '1px 8px' }}>Teslim: <strong>{Number(x.teslim || 0).toLocaleString('tr-TR')} ₺</strong></span>
                      <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '1px 8px' }}>Devir: <strong>{Number(x.devir || 0).toLocaleString('tr-TR')} ₺</strong></span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Kasa Teslim Hareketleri ── */}
          {(ozet?.kasa_teslim_bugun_listesi || []).length > 0 && (
            <div className="alert-box mb-16" style={{ padding: '12px 16px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', color: 'var(--text)', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                💵 Kasa teslim (son 14 gün — ara + gün sonu)
                <span style={{ background: 'rgba(245,158,11,0.25)', borderRadius: 12, padding: '1px 10px', fontSize: 13 }}>
                  {(ozet.kasa_teslim_bugun_listesi || []).length} hareket
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                İş günü tarihine göre son 14 gün; satırda işlem günü + saat. Gün sonu ve ara teslim aynı listede.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(ozet.kasa_teslim_bugun_listesi || []).map((x, i) => {
                  const saatStr = x.ts ? new Date(x.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—';
                  const turEtiketi = x.teslim_turu === 'gun_sonu' ? '🌙 Gün Sonu' : '🔄 Ara Teslim';
                  const gunSaat = x.tarih ? `${x.tarih} · ${saatStr}` : saatStr;
                  return (
                    <div key={i} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 8, padding: '7px 12px', border: '1px solid rgba(245,158,11,0.25)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, minWidth: 110 }}>🏪 {x.sube_adi}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)' }} className="mono">⏰ {gunSaat}</span>
                      <span style={{ fontSize: 11, background: 'rgba(245,158,11,0.18)', borderRadius: 6, padding: '1px 7px' }}>{turEtiketi}</span>
                      <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '1px 8px' }}>
                        💰 <strong>{Number(x.tutar || 0).toLocaleString('tr-TR')} ₺</strong>
                      </span>
                      {x.teslim_eden_ad && <span style={{ fontSize: 11, color: 'var(--text3)' }}>👤 {x.teslim_eden_ad}</span>}
                      {x.teslim_alan_ad  && <span style={{ fontSize: 11, color: 'var(--text3)' }}>➡ {x.teslim_alan_ad}</span>}
                      {x.aciklama        && <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>{x.aciklama}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Kasa Uyumsuzlukları (devir ≠ açılış) ── */}
          {(ozet?.kasa_uyumsuzluk_listesi || []).length > 0 && (
            <div className="alert-box red mb-16" style={{ padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                ⚠️ Kasa Uyumsuzluğu — Devir ≠ Açılış
                <span style={{ background: 'rgba(239,68,68,0.3)', borderRadius: 12, padding: '1px 10px', fontSize: 13 }}>
                  {(ozet.kasa_uyumsuzluk_listesi || []).length} şube
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                Dünkü kapanış <strong>devri</strong> ile bugünkü <strong>açılış kasa</strong> sayımı eşleşmiyor.
                Pozitif fark: açılışta devre göre <strong>fazla</strong> nakit; negatif fark: devre göre <strong>eksik</strong>.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(ozet.kasa_uyumsuzluk_listesi || []).map((x, i) => {
                  const fark = Number(x.fark || 0);
                  const farkStr = (fark >= 0 ? '+' : '') + fark.toLocaleString('tr-TR') + ' ₺';
                  const farkRenk = fark > 0 ? '#4ade80' : '#f87171';
                  /** fark = bugün açılış kasa − dün kapanış devri */
                  const farkAciklama = fark > 0
                    ? 'Bugün açılış kasası dün devrinden yüksek (fazla sayım / düşük devir şüphesi).'
                    : fark < 0
                      ? 'Bugün açılış kasası dün devrinden düşük (eksik nakit / yüksek devir şüphesi).'
                      : 'Eşleşme.';
                  const farkEtiket = fark > 0 ? 'Açılışta fazla' : fark < 0 ? 'Açılışta eksik' : '—';
                  return (
                    <div key={i} style={{ background: 'rgba(0,0,0,0.18)', borderRadius: 8, padding: '7px 12px', border: '1px solid rgba(239,68,68,0.35)', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, fontSize: 13, minWidth: 110 }}>🏪 {x.sube_adi}</span>
                      <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '1px 8px' }}>
                        Dün Devir: <strong>{Number(x.dun_devir || 0).toLocaleString('tr-TR')} ₺</strong>
                      </span>
                      <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '1px 8px' }}>
                        Bugün Açılış: <strong>{Number(x.acilis_kasa || 0).toLocaleString('tr-TR')} ₺</strong>
                      </span>
                      <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} title={farkAciklama}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: farkRenk }}>Fark: {farkStr}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text2)', letterSpacing: '0.02em' }}>{farkEtiket}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <h2>📡 Operasyon Merkezi</h2>
          <p>
            {aktifSekme
              ? <>{ozet?.tarih} · {kartlar.length} şube</>
              : <>Modül kartından bir alan seçerek başlayın.</>}
            {aktifSekme === 'canli' && kritikSayi > 0 && <span className="badge badge-red" style={{ marginLeft: 8 }}>{kritikSayi} kritik</span>}
            {aktifSekme === 'canli' && gecikSayi > 0 && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>{gecikSayi} gecikmiş</span>}
            {aktifSekme === 'canli' && guvenlikSayi > 0 && <span className="badge badge-red" style={{ marginLeft: 6 }}>{guvenlikSayi} güvenlik</span>}
            {aktifSekme && sonYenileme && <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 10 }}>Son: {sonYenileme}</span>}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            if (!opsMerkezPencere) {
              fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => toast('Özet yenilenemedi', 'red'));
              yukleUrunAcBugun().catch(() => {});
              yukleGecAcilanBugun().catch(() => {});
              yukleGecKalanPersonelBugun().catch(() => {});
              yukleKullanilanBugun().catch(() => {});
              yukleKasaUyumBugun().catch(() => {});
              yukleUrunUyumBugun().catch(() => {});
              yukleSevkiyatUyumBugun().catch(() => {});
              return;
            }
            if (!aktifSekme) {
              toast('Modül seçilmedi.', 'yellow');
              return;
            }
            setYukleniyor(true);
            if (aktifSekme === 'onay') yukleOnayMerkez();
            else if (aktifSekme === 'siparis') {
              yukleSiparisMerkez().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'siparis-kabul-takip') {
              yukleSiparisKabulTakip();
            }
            else if (aktifSekme === 'toptanci-siparisleri') {
              yukleToptanciSiparisleri();
            }
            else if (aktifSekme === 'toptanci-teslimler') {
              yukleToptanciTeslimler();
            }
            else if (aktifSekme === 'analitik') {
              setYukleniyor(true); yukleAnalitik();
            }
            else if (aktifSekme === 'stok-tahmin') {
              setYukleniyor(true); yukleStokTahmin();
            }
            else if (aktifSekme === 'urun-ac') {
              setUrunAcHaftaYukleniyor(true);
              urunAcHaftaYukle()
                .then(setUrunAcHaftaSatirlari)
                .catch(() => {})
                .finally(() => setUrunAcHaftaYukleniyor(false));
              urunAcAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'gec-acilan-subeler') {
              setGecAcilanHaftaYukleniyor(true);
              gecAcilanHaftaYukle()
                .then(setGecAcilanHaftaSatirlari)
                .catch(() => {})
                .finally(() => setGecAcilanHaftaYukleniyor(false));
              gecAcilanAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'gec-kalan-personel') {
              gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'kullanilan-urunler') {
              setKullanilanHaftaYukleniyor(true);
              kullanilanHaftaYukle()
                .then(setKullanilanHaftaSatirlari)
                .catch(() => {})
                .finally(() => setKullanilanHaftaYukleniyor(false));
              kullanilanAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'kasa-uyumsuzluk') {
              setKasaUyumHaftaYukleniyor(true);
              kasaUyumHaftaYukle()
                .then(setKasaUyumHaftaSatirlari)
                .catch(() => {})
                .finally(() => setKasaUyumHaftaYukleniyor(false));
              kasaUyumAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'personel-vardiya-uyumsuzluk') {
              setPersonelVardiyaUyumHaftaYukleniyor(true);
              personelVardiyaUyumHaftaYukle()
                .then(setPersonelVardiyaUyumHaftaSatirlari)
                .catch(() => {})
                .finally(() => setPersonelVardiyaUyumHaftaYukleniyor(false));
              personelVardiyaUyumAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'urun-uyumsuzluk') {
              urunUyumAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'magaza-kartlari') magazaDepoTamYenile();
            else if (aktifSekme === 'metrics') yukleMetrics();
            else if (aktifSekme === 'kontrol') yukleKontrolOzet();
            else if (aktifSekme === 'fis') yukleFisBekleyen();
            else if (aktifSekme === 'stok-disiplin') yukleDisiplin();
            else yukle(filtre);
          }}
        >
          ↻ Yenile
        </button>
      </div>

      {!opsMerkezPencere && (
        <>
          {(((opsOzet?.siparis_bekleyen || 0) > 0) || ((opsOzet?.alarm_satirlari || []).length > 0)) && (
            <section
              className={`card${hubYeniSiparisVurgu ? ' ops-hub-yeni-siparis-flash' : ''}`}
              style={{
                padding: '14px 16px',
                marginBottom: 16,
                borderRadius: 12,
                border: (opsOzet?.siparis_bekleyen || 0) > 0 ? '2px solid rgba(74, 158, 255, 0.45)' : '1px solid var(--border)',
                background: (opsOzet?.siparis_bekleyen || 0) > 0
                  ? 'linear-gradient(145deg, rgba(74, 158, 255, 0.1), rgba(30, 58, 138, 0.06))'
                  : 'var(--bg2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: (opsOzet?.siparis_bekleyen || 0) > 0 ? 12 : 8 }}>
                <div
                  role="button"
                  tabIndex={0}
                  className={
                    (opsOzet?.siparis_bekleyen || 0) > 0 && !hubOperasyonDetayAcik
                      ? 'ops-hub-gelen-siparis'
                      : ''
                  }
                  style={{
                    flex: '1 1 220px',
                    minWidth: 0,
                    cursor: 'pointer',
                    padding: '10px 12px',
                    margin: '-10px -12px',
                    borderRadius: 10,
                    border:
                      (opsOzet?.siparis_bekleyen || 0) > 0
                        ? '1px solid rgba(74, 158, 255, 0.45)'
                        : '1px dashed var(--border)',
                    background:
                      (opsOzet?.siparis_bekleyen || 0) > 0
                        ? 'rgba(15, 23, 42, 0.35)'
                        : 'transparent',
                    outline: 'none',
                  }}
                  onClick={() => setHubOperasyonDetayAcik((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setHubOperasyonDetayAcik((v) => !v);
                    }
                  }}
                >
                  {(opsOzet?.siparis_bekleyen || 0) > 0 ? (
                    <>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          letterSpacing: '0.07em',
                          color: '#93c5fd',
                          textTransform: 'uppercase',
                          marginBottom: 6,
                        }}
                      >
                        Gelen sipariş — şube talepleri
                      </div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text1)', lineHeight: 1.15 }}>
                        {opsOzet.siparis_bekleyen}{' '}
                        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text2)' }}>bekleyen talep</span>
                      </div>
                      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                        İşlem için <strong>Stok Disiplin › Sipariş kuyruğu</strong> kullanılır; buradaki sayı hub özetiyle aynı kaynaktır.
                      </p>
                      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                        Son <strong>{siparisBekleyenGunPenceresi} gun</strong> icindeki kuyruk izlenir; bu sayi Stok Disiplin ekranindaki ayni pencereyle eslesir.
                      </p>
                      {(Number(opsOzet?.siparis_ozel_bekleyen) || 0) > 0 && (
                        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#facc15', lineHeight: 1.45 }}>
                          Ayrica <strong>{Number(opsOzet?.siparis_ozel_bekleyen) || 0} ozel urun talebi</strong> Siparis katalog ekraninda karar bekliyor.
                        </p>
                      )}
                      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text3)', lineHeight: 1.45 }}>
                        {hubOperasyonDetayAcik ? '▼ Özet satırlarını gizlemek için tekrar tıklayın.' : '▶ Alarm satırları — detay için tıklayın.'}
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>📌 Operasyon uyarıları</h3>
                      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text3)' }}>
                        Bekleyen sipariş yok; özet uyarılar için {hubOperasyonDetayAcik ? 'tekrar tıklayıp daraltın' : 'tıklayın'}.
                      </p>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', flexShrink: 0 }}>
                  {(opsOzet?.siparis_bekleyen || 0) > 0 && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDisiplinPanel('kuyruk');
                        acOpsModul('stok-disiplin');
                      }}
                    >
                      Stok Disiplin · sipariş kuyruğu →
                    </button>
                  )}
                  {(Number(opsOzet?.siparis_ozel_bekleyen) || 0) > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        acOpsModul('siparis');
                      }}
                    >
                      Siparis katalog - ozel talepler →
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 11 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchHubOzet().then((r) => hubOzetIsle(r)).catch(() => {});
                    }}
                  >
                    ↻ Özet yenile
                  </button>
                </div>
              </div>

              {hubOperasyonDetayAcik && (opsOzet?.alarm_satirlari || []).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(opsOzet.alarm_satirlari || []).map((a) => {
                    const acik = hubAlarmAcikId === a.id;
                    const sev = a.seviye === 'kritik' ? 'var(--red)' : a.seviye === 'uyari' ? 'var(--yellow)' : 'var(--text3)';
                    const bg = a.seviye === 'kritik' ? 'rgba(220,50,50,0.08)' : a.seviye === 'uyari' ? 'rgba(220,160,0,0.07)' : 'var(--bg3)';
                    return (
                      <div
                        key={a.id}
                        style={{
                          border: `1px solid ${sev}44`,
                          borderLeft: `4px solid ${sev}`,
                          borderRadius: 8,
                          background: bg,
                          overflow: 'hidden',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setHubAlarmAcikId(acik ? null : a.id)}
                          style={{
                            width: '100%', textAlign: 'left', padding: '10px 12px',
                            background: 'transparent', border: 'none', cursor: 'pointer',
                            color: 'var(--text1)',
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{a.baslik}</div>
                          <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.45 }}>{a.ozet}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
                            {acik ? '▲ Daralt' : '▼ Detay'}
                            {a.meta?.hedef_sekme && (
                              <span style={{ marginLeft: 10 }}>
                                →{' '}
                                {a.meta.hedef_sekme === 'siparis'
                                  ? 'Stok Disiplin · Sipariş kuyruğu'
                                  : (UST_SEKMELER.find((x) => x.id === a.meta.hedef_sekme)?.label || a.meta.hedef_sekme)}
                              </span>
                            )}
                          </div>
                        </button>
                        {acik && (
                          <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
                            {a.tip === 'siparis_merkez_bekliyor' && (a.meta?.kalemler || []).length > 0 && (
                              <div className="table-wrap" style={{ marginTop: 8, fontSize: 11 }}>
                                <table>
                                  <thead>
                                    <tr>
                                      <th>Ürün</th>
                                      <th style={{ textAlign: 'center' }}>Adet</th>
                                      <th style={{ textAlign: 'center' }}>Şube depo</th>
                                      <th style={{ textAlign: 'center' }}>Merkez</th>
                                      <th style={{ textAlign: 'center' }}>Min</th>
                                      <th style={{ textAlign: 'center' }}>Kalır</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(a.meta.kalemler || []).filter((k) => k && typeof k === 'object').map((k, i) => (
                                      <tr key={i}>
                                        <td>{k.urun_ad || k.kalem_kodu || '—'}{k.aciklama ? ` (${k.aciklama})` : ''}</td>
                                        <td className="mono" style={{ textAlign: 'center' }}>{k.adet ?? 0}</td>
                                        <td style={{ textAlign: 'center' }}>{k.sube_depo_mevcut ?? 0}</td>
                                        <td style={{ textAlign: 'center' }}>{k.merkez_mevcut < 0 ? '?' : k.merkez_mevcut}</td>
                                        <td style={{ textAlign: 'center' }}>{k.merkez_min_stok ?? '—'}</td>
                                        <td style={{ textAlign: 'center', fontWeight: 600, color: k.alarm_merkez ? 'var(--red)' : 'var(--green)' }}>
                                          {k.kalan_gonderince == null ? '—' : k.kalan_gonderince}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {(a.meta?.davranis_uyarilari || []).length > 0 && (
                              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text2)' }}>
                                {(a.meta.davranis_uyarilari || []).map((u, ui) => (
                                  <div key={ui} style={{ marginBottom: 4 }}>
                                    <strong>{u.kural}</strong> (+{u.puan}p): {u.mesaj}
                                  </div>
                                ))}
                              </div>
                            )}
                            {a.meta?.cift_siparis_bilgi_notu && (
                              <div
                                style={{
                                  marginTop: 10,
                                  padding: '10px 12px',
                                  borderRadius: 8,
                                  fontSize: 11,
                                  lineHeight: 1.45,
                                  background: 'rgba(74, 158, 255, 0.08)',
                                  border: '1px solid rgba(74, 158, 255, 0.3)',
                                }}
                              >
                                <strong style={{ color: 'var(--blue)' }}>Bilgi — çift sipariş:</strong>{' '}
                                {a.meta.cift_siparis_bilgi_notu}
                              </div>
                            )}
                            {a.meta?.hedef_sekme && (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                style={{ marginTop: 10 }}
                                onClick={() => alarmHedefeGit(a)}
                              >
                                İlgili modüle git →
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {hubOperasyonDetayAcik && (opsOzet?.alarm_satirlari || []).length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--text3)', margin: '8px 0 0' }}>
                  Sunucu şu an özet satırı döndürmedi; «Özet yenile» ile tekrar deneyin veya hub'daki «Şube sipariş» kartından kuyruğu açın.
                </p>
              )}
            </section>
          )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 20 }}>
          {MODULLER.map((modul) => {
            const ozt = opsOzet || {};
            let alertSayisi = 0;
            let descSatir = modul.desc;

            if (modul.id === 'canli-ops') {
              const gecAlert = Number(gecAcilanBugun?.toplam || 0) + Number(gecAcilanBugun?.acilmayan_toplam || 0);
              const personelAlert = Number(gecKalanPersonelBugun?.kritik_personel_sayisi || 0);
              const kapanisEksik = Array.isArray(kapanisTakip?.satirlar) ? kapanisTakip.satirlar.filter((r) => !r.kapanis_tamam).length : 0;
              alertSayisi = gecAlert + personelAlert + kapanisEksik;
              const aktifSubeAdet = ozt.aktif_sube ?? kartlar.filter((k) => k.sube_acik).length;
              descSatir = `${aktifSubeAdet} şube aktif${alertSayisi > 0 ? ` · ${alertSayisi} uyarı` : ' · sorun yok ✓'}`;
            } else if (modul.id === 'envanter') {
              alertSayisi = Number(ozt.stok_kayip_sube || 0) + Number(ozt.stok_alarm_bekleyen || 0) + Number(urunUyumBugun?.toplam || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} kayıp/uyarı — envanter kontrol gerekli` : 'Envanter normal · kayıp tespit edilmedi ✓';
            } else if (modul.id === 'siparis-tedarik') {
              alertSayisi = Number(ozt.siparis_gonderilmedi_toplam || 0) + Number(sevkiyatUyumOzet?.adet || 0) + Number(ozt.siparis_bekleyen || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} bekleyen/uyumsuz sipariş` : 'Tüm siparişler takipte ✓';
            } else if (modul.id === 'finans-kasa') {
              alertSayisi = Number(kasaUyumBugun?.toplam || 0) + Number(ciroOnayBugun?.toplam || 0) + Number(ozt.fis_bekleyen || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} onay/uyumsuzluk bekliyor` : 'Kasa dengede · onay kuyruğu boş ✓';
            } else if (modul.id === 'personel') {
              alertSayisi = Number(personelVardiyaUyumBugun?.toplam || 0) + Number(gecKalanPersonelBugun?.kritik_personel_sayisi || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} uyumsuz vardiya / geç kalan` : 'Personel durumu normal ✓';
            } else if (modul.id === 'denetim-uyum') {
              const guvenlikAlarmSayi = kartlar.filter((k) => k.bayraklar?.guvenlik_alarm).length;
              alertSayisi = Number(ozt.kontrol_gecikti || 0) + guvenlikAlarmSayi;
              descSatir = alertSayisi > 0
                ? `${guvenlikAlarmSayi > 0 ? `${guvenlikAlarmSayi} güvenlik alarmı · ` : ''}${Number(ozt.kontrol_gecikti || 0) > 0 ? `${ozt.kontrol_gecikti} kontrol gecikti` : 'denetim gerekli'}`
                : 'Kontrol tamamlandı · Güvenlik normal ✓';
            } else if (modul.id === 'analitik-planlama') {
              const u30 = Number(ozt.uyari_30d || 0);
              descSatir = u30 > 0 ? `Son 30 günde ${u30} uyarı/kritik kaydı` : modul.desc;
            }

            return (
              <div
                key={modul.id}
                className="metric-card"
                style={{
                  borderTop: `4px solid ${alertSayisi > 0 ? modul.renk : 'var(--border)'}`,
                  cursor: 'pointer',
                  padding: '16px 18px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  minHeight: 120,
                  position: 'relative',
                }}
                onClick={() => {
                  const firstTab = modul.tabs[0];
                  setAktifModul(modul.id);
                  if (firstTab === 'gec-acilan-subeler') {
                    setGecAcilanAramaTarih(bugunIsoTarih());
                    setGecAcilanAramaSonuc(gecAcilanBugun);
                  } else if (firstTab === 'kasa-uyumsuzluk') {
                    setKasaUyumAramaTarih(bugunIsoTarih());
                    setKasaUyumAramaSonuc(kasaUyumBugun);
                  } else if (firstTab === 'ciro-onay') {
                    setCiroOnayAramaTarih(isGunuIsoIstanbul());
                    setCiroOnayAramaSonuc(ciroOnayBugun);
                  } else if (firstTab === 'magaza-kartlari') {
                    setDisiplinPanel('kuyruk');
                  }
                  acOpsModul(firstTab);
                }}
                title={`${modul.label} — ${modul.desc}`}
              >
                {alertSayisi > 0 && (
                  <div style={{
                    position: 'absolute', top: 10, right: 12,
                    background: modul.renk, color: '#fff',
                    borderRadius: 12, padding: '2px 9px',
                    fontSize: 12, fontWeight: 700, lineHeight: 1.6,
                  }}>
                    {alertSayisi}
                  </div>
                )}
                <div style={{ fontSize: 14, fontWeight: 700, color: alertSayisi > 0 ? modul.renk : 'var(--text)', paddingRight: alertSayisi > 0 ? 40 : 0 }}>
                  {modul.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.4 }}>
                  {descSatir}
                </div>
                <div style={{ marginTop: 'auto', fontSize: 10, color: 'var(--text3)', display: 'flex', gap: 5, flexWrap: 'wrap', paddingTop: 4 }}>
                  {modul.tabs.map((tabId) => {
                    const sekme = UST_SEKMELER.find((s) => s.id === tabId);
                    return sekme ? (
                      <span key={tabId} style={{ background: 'rgba(128,128,128,0.1)', borderRadius: 4, padding: '2px 5px' }}>
                        {sekme.label.replace(/^[^\w\sğüşöçı]+\s*/u, '')}
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {opsMerkezPencere && !!aktifSekme && (
        <div style={{ marginTop: 4 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, marginBottom: 8, flexWrap: 'wrap',
            borderBottom: `2px solid ${(aktifModul ? MODULLER.find((m) => m.id === aktifModul)?.renk : null) || OPS_HUB_RENK[aktifSekme] || 'var(--border)'}`,
            paddingBottom: 10,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {aktifModul && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3, letterSpacing: '0.01em' }}>
                  {MODULLER.find((m) => m.id === aktifModul)?.label}
                </div>
              )}
              <h3 style={{ margin: 0, fontSize: 17, color: 'var(--text)' }}>
                {UST_SEKMELER.find((x) => x.id === aktifSekme)?.label || aktifSekme}
              </h3>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setYukleniyor(true);
                  if (aktifSekme === 'onay') yukleOnayMerkez();
                  else if (aktifSekme === 'siparis') {
                    yukleSiparisMerkez().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'siparis-kabul-takip') {
                    yukleSiparisKabulTakip();
                  }
                  else if (aktifSekme === 'toptanci-siparisleri') {
                    yukleToptanciSiparisleri();
                  }
                  else if (aktifSekme === 'urun-ac') {
                    setUrunAcHaftaYukleniyor(true);
                    urunAcHaftaYukle()
                      .then(setUrunAcHaftaSatirlari)
                      .catch(() => {})
                      .finally(() => setUrunAcHaftaYukleniyor(false));
                    urunAcAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'gec-acilan-subeler') {
                    setGecAcilanHaftaYukleniyor(true);
                    gecAcilanHaftaYukle()
                      .then(setGecAcilanHaftaSatirlari)
                      .catch(() => {})
                      .finally(() => setGecAcilanHaftaYukleniyor(false));
                    gecAcilanAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'gec-kalan-personel') {
                    gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'kullanilan-urunler') {
                    setKullanilanHaftaYukleniyor(true);
                    kullanilanHaftaYukle()
                      .then(setKullanilanHaftaSatirlari)
                      .catch(() => {})
                      .finally(() => setKullanilanHaftaYukleniyor(false));
                    kullanilanAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'kapanis-takip') {
                    yukleKapanisTakip(kapanisTakipTarih).finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'ciro-onay') {
                    ciroOnayAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'kasa-uyumsuzluk') {
                    setKasaUyumHaftaYukleniyor(true);
                    kasaUyumHaftaYukle()
                      .then(setKasaUyumHaftaSatirlari)
                      .catch(() => {})
                      .finally(() => setKasaUyumHaftaYukleniyor(false));
                    kasaUyumAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'personel-vardiya-uyumsuzluk') {
                    setPersonelVardiyaUyumHaftaYukleniyor(true);
                    personelVardiyaUyumHaftaYukle()
                      .then(setPersonelVardiyaUyumHaftaSatirlari)
                      .catch(() => {})
                      .finally(() => setPersonelVardiyaUyumHaftaYukleniyor(false));
                    personelVardiyaUyumAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'urun-uyumsuzluk') {
                    urunUyumAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'sevkiyat-uyumsuzluk') {
                    yukleSevkiyatUyumOzet({ silent: true }).catch(() => {});
                    sevkiyatUyumDetayYukle().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'magaza-kartlari') magazaDepoTamYenile();
                  else if (aktifSekme === 'metrics') yukleMetrics();
                  else if (aktifSekme === 'kontrol') yukleKontrolOzet();
                  else if (aktifSekme === 'fis') yukleFisBekleyen();
                  else if (aktifSekme === 'stok-disiplin') yukleDisiplin();
                  else yukle(filtre);
                }}
              >
                ↻ Yenile
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={kapatOpsModul}>
                ← Modüller
              </button>
            </div>
          </div>
          {(() => {
            const _modul = aktifModul ? MODULLER.find((m) => m.id === aktifModul) : null;
            if (!_modul || _modul.tabs.length <= 1) return null;
            return (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, marginBottom: 4, flexWrap: 'wrap', overflowX: 'auto', position: 'sticky', top: 0, zIndex: 3, background: 'var(--bg)', paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                {_modul.tabs.map((tabId) => {
                  const sekme = UST_SEKMELER.find((s) => s.id === tabId);
                  return sekme ? (
                    <button
                      key={tabId}
                      type="button"
                      className={`tab-pill ${aktifSekme === tabId ? 'active' : ''}`}
                      style={{ whiteSpace: 'nowrap', fontSize: 12 }}
                      onClick={() => acModulTab(tabId)}
                    >
                      {sekme.label}
                    </button>
                  ) : null;
                })}
              </div>
            );
          })()}
          <div style={{ paddingTop: 8 }}>
              {(OPS_MODUL_BOLUM[aktifSekme] || []).length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', position: 'sticky', top: 44, zIndex: 2, background: 'var(--bg)', paddingBottom: 6 }}>
                  {(OPS_MODUL_BOLUM[aktifSekme] || []).map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className={`tab-pill ${opsIcBolum === b.id ? 'active' : ''}`}
                      onClick={() => setOpsIcBolum(b.id)}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}

      {(aktifSekme === 'defter' || aktifSekme === 'sayim') && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ay</span>
            <input type="month" value={ayFiltre} onChange={(e) => { setYukleniyor(true); setAyFiltre(e.target.value || varsayilanAy); }} />
          </label>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün (opsiyonel)</span>
            <input type="date" value={gunFiltre} onChange={(e) => { setYukleniyor(true); setGunFiltre(e.target.value || ''); }} />
          </label>
        </div>
      )}

      {aktifSekme === 'onay' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ay</span>
            <input type="month" value={ayFiltre} onChange={(e) => { setYukleniyor(true); setAyFiltre(e.target.value || varsayilanAy); }} />
          </label>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube (opsiyonel)</span>
            <select
              className="input"
              style={{ minWidth: 200, padding: '8px 10px' }}
              value={subeOnayFiltre}
              onChange={(e) => { setYukleniyor(true); setSubeOnayFiltre(e.target.value); }}
            >
              <option value="">Tüm şubeler</option>
              {subeListeAdmin.map((s) => (
                <option key={s.id} value={s.id}>{s.ad || s.id}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => { setYukleniyor(true); yukleOnayMerkez(); }}>
            ↻ Yenile
          </button>
        </div>
      )}

      {aktifSekme === 'kontrol' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Kategori</span>
            <select
              className="input"
              style={{ minWidth: 210, padding: '8px 10px' }}
              value={kontrolKategori}
              onChange={(e) => { setYukleniyor(true); setKontrolKategori(e.target.value); }}
            >
              <option value="">Tümü</option>
              <option value="KASA">Kasa</option>
              <option value="CIRO">Ciro</option>
              <option value="ZAMAN">Zaman</option>
              <option value="STOK">Stok</option>
              <option value="GIDER">Gider</option>
              <option value="GUVENLIK">Güvenlik</option>
            </select>
          </label>
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', alignSelf: 'flex-end', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={kontrolSadeceAlarmlar}
              onChange={(e) => { setYukleniyor(true); setKontrolSadeceAlarmlar(e.target.checked); }}
            />
            Sadece alarmlar
          </label>
        </div>
      )}

      {aktifSekme === 'fis' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukleFisBekleyen(); }}>
            ↻ Yenile
          </button>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Fiş gönderilmedi işaretlenen giderler (kontrol bekliyor)
          </span>
        </div>
      )}

      {aktifSekme === 'canli' && (() => {
        const gecAlert = Number(gecAcilanBugun?.toplam || 0) + Number(gecAcilanBugun?.acilmayan_toplam || 0);
        const kapanmayanSayi = Array.isArray(kapanisTakip?.satirlar) ? kapanisTakip.satirlar.filter((r) => !r.kapanis_tamam).length : 0;
        const toplamUyari = kritikSayi + gecikSayi + gecAlert + kapanmayanSayi + guvenlikSayi;
        const uyariParcalar = [
          gecAlert > 0 && `${gecAlert} geç açılış`,
          kapanmayanSayi > 0 && `${kapanmayanSayi} kapanmayan`,
          guvenlikSayi > 0 && `${guvenlikSayi} güvenlik`,
          kritikSayi > 0 && `${kritikSayi} kritik`,
          gecikSayi > 0 && `${gecikSayi} geciken`,
        ].filter(Boolean);
        return (
          <>
            {/* Ciro giriş durumu — operasyonel tamamlanma oranı */}
            {(() => {
              const ciroGiren = kartlar.filter(k => k.ciro_girildi).length;
              const ciroOnayda = kartlar.filter(k => !k.ciro_girildi && k.ciro_taslak_bekliyor).length;
              const ciroYok = kartlar.length - ciroGiren - ciroOnayda;
              const hepsiGirdi = ciroGiren === kartlar.length && kartlar.length > 0;
              if (kartlar.length === 0) return null;
              return (
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 14px', background: 'var(--bg2)', borderRadius: 8, border: `1px solid ${hepsiGirdi ? 'var(--green)' : ciroYok > 0 ? 'rgba(224,92,92,.3)' : 'var(--border)'}`, cursor: 'pointer' }}
                  onClick={() => acOpsModul('ciro-onay', 'finans-kasa')}
                  title="Finans & Kasa — Ciro Onay sayfasına git"
                >
                  <span style={{ fontSize: 12, color: 'var(--text3)' }}>Ciro girişi</span>
                  <span style={{ fontWeight: 700, fontSize: 15, color: hepsiGirdi ? 'var(--green)' : ciroYok > 0 ? 'var(--red)' : 'var(--yellow)' }}>
                    {ciroGiren} / {kartlar.length} şube
                  </span>
                  {ciroOnayda > 0 && <span style={{ fontSize: 11, color: 'var(--yellow)' }}>{ciroOnayda} onayda</span>}
                  {ciroYok > 0 && <span style={{ fontSize: 11, color: 'var(--red)' }}>{ciroYok} girilmedi</span>}
                  <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>Finans & Kasa →</span>
                </div>
              );
            })()}

            {/* 6 canlı alert kartı */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
              <div className="metric-card" style={{ borderTop: `3px solid ${kartlar.filter(k => k.sube_acik).length === kartlar.length && kartlar.length > 0 ? 'var(--green)' : '#4a9eff'}` }}>
                <div className="metric-label">🏢 Aktif Şube</div>
                <div className="metric-value" style={{ color: '#4a9eff' }}>{kartlar.filter(k => k.sube_acik).length} / {kartlar.length || '—'}</div>
                <div className="metric-sub">Şu an açık / toplam</div>
              </div>
              <div
                className="metric-card"
                style={{ borderTop: `3px solid ${gecAlert > 0 ? 'var(--red)' : 'var(--text3)'}`, cursor: gecAlert > 0 ? 'pointer' : 'default' }}
                onClick={() => gecAlert > 0 && acModulTab('gec-acilan-subeler')}
                title={gecAlert > 0 ? 'Detay için tıkla' : ''}
              >
                <div className="metric-label">⏰ Geç / Açılmayan</div>
                <div className="metric-value" style={{ color: gecAlert > 0 ? 'var(--red)' : 'var(--text3)' }}>{gecAlert}</div>
                <div className="metric-sub">{Number(gecAcilanBugun?.toplam || 0)} geç · {Number(gecAcilanBugun?.acilmayan_toplam || 0)} açılmadı{gecAlert > 0 ? ' →' : ''}</div>
              </div>
              <div
                className="metric-card"
                style={{ borderTop: `3px solid ${kapanmayanSayi > 0 ? '#f08040' : 'var(--text3)'}`, cursor: kapanmayanSayi > 0 ? 'pointer' : 'default' }}
                onClick={() => kapanmayanSayi > 0 && acModulTab('kapanis-takip')}
                title={kapanmayanSayi > 0 ? 'Detay için tıkla' : ''}
              >
                <div className="metric-label">🔒 Kapanmayan</div>
                <div className="metric-value" style={{ color: kapanmayanSayi > 0 ? '#f08040' : 'var(--text3)' }}>{kapanmayanSayi}</div>
                <div className="metric-sub">Kapanış tamamlanmayan{kapanmayanSayi > 0 ? ' →' : ''}</div>
              </div>
              <div
                className="metric-card"
                style={{ borderTop: `3px solid ${guvenlikSayi > 0 ? '#be185d' : 'var(--text3)'}`, cursor: guvenlikSayi > 0 ? 'pointer' : 'default' }}
                onClick={() => guvenlikSayi > 0 && acOpsModul('guvenlik-alarmlar', 'denetim-uyum')}
                title={guvenlikSayi > 0 ? 'Detay için tıkla' : ''}
              >
                <div className="metric-label">🔐 Güvenlik Alarmı</div>
                <div className="metric-value" style={{ color: guvenlikSayi > 0 ? '#be185d' : 'var(--text3)' }}>{guvenlikSayi}</div>
                <div className="metric-sub">Aktif PIN / kilit alarmı{guvenlikSayi > 0 ? ' →' : ''}</div>
              </div>
              <div
                className="metric-card"
                style={{ borderTop: `3px solid ${kartlar.filter(k => !k.ciro_girildi && !k.ciro_taslak_bekliyor).length > 0 ? 'var(--red)' : 'var(--green)'}`, cursor: 'pointer' }}
                onClick={() => acOpsModul('ciro-onay', 'finans-kasa')}
                title="Finans & Kasa — Ciro Onay sayfasına git"
              >
                <div className="metric-label">📋 Ciro Girişi</div>
                <div className="metric-value" style={{ color: kartlar.filter(k => k.ciro_girildi).length === kartlar.length && kartlar.length > 0 ? 'var(--green)' : 'var(--yellow)' }}>
                  {kartlar.filter(k => k.ciro_girildi).length} / {kartlar.length}
                </div>
                <div className="metric-sub">Şube girdi · Finans →</div>
              </div>
              <div className="metric-card" style={{ borderTop: `3px solid ${toplamUyari > 0 ? 'var(--red)' : 'var(--green)'}` }}>
                <div className="metric-label">🚨 Toplam Uyarı</div>
                <div className="metric-value" style={{ fontSize: 22, color: toplamUyari > 0 ? 'var(--red)' : 'var(--green)' }}>{toplamUyari}</div>
                <div className="metric-sub">{toplamUyari === 0 ? 'Tüm şubeler normal ✓' : uyariParcalar.join(' · ')}</div>
              </div>
            </div>

            {/* Açılış/Kapanış özet kartı */}
            <HubGunlukAcilisKapanisCard bucket={hubAcKapBucket} />

            {/* Şube filtresi */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
              {FILTRELER.map(f => (
                <button key={f.id} className={`tab-pill ${filtre === f.id ? 'active' : ''}`} onClick={() => setFiltre(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>

            {/* Canlı durum tablosu */}
            {karsilastirmaKartlar.length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--text2)' }}>Şube durum tablosu</h3>
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Şube</th>
                        <th>Açılış</th>
                        <th>Kontrol</th>
                        <th>Kapanış</th>
                        <th>Vardiya devri</th>
                        <th>Ciro durumu</th>
                      </tr>
                    </thead>
                    <tbody>
                      {karsilastirmaKartlar.map((k) => {
                        const acilisDurum = operasyonTipOzeti(k, 'ACILIS') || { text: '—', badge: 'badge-gray' };
                        const kontrolDurum = operasyonTipOzeti(k, 'KONTROL');
                        const kapanisDurum = operasyonTipOzeti(k, 'KAPANIS');
                        const vardiyaDurum = k?.vardiya_devri_tamam
                          ? { text: 'Tamamlandı', badge: 'badge-green' }
                          : k?.vardiya_devri_basladi
                            ? { text: 'Devam ediyor', badge: 'badge-yellow' }
                            : { text: 'Başlamadı', badge: 'badge-gray' };
                        const gecikme = Number(k?.kontrol_gecikme_dk || 0);
                        const kontrolCell = kontrolDurum
                          ? (gecikme > 0 ? { text: `⚠️ ${insancaDk(gecikme)} geç`, badge: gecikme >= 30 ? 'badge-red' : 'badge-yellow' } : kontrolDurum)
                          : { text: '⏳', badge: 'badge-yellow' };
                        const kapanisCell = kapanisDurum || { text: '⏳', badge: 'badge-yellow' };
                        const ciroDurum = k?.ciro_girildi
                          ? { text: '✓ Girdi', badge: 'badge-green' }
                          : k?.ciro_taslak_bekliyor
                            ? { text: '⏳ Onayda', badge: 'badge-yellow' }
                            : { text: '✕ Girilmedi', badge: 'badge-red' };
                        return (
                          <tr key={`cmp-${k.sube_id}`} onClick={() => setDetay(k)} style={{ cursor: 'pointer' }} title="Detay için tıkla">
                            <td style={{ fontWeight: 500, fontSize: 13 }}>{k.sube_adi || k.sube_id || '—'}</td>
                            <td><span className={`badge ${acilisDurum.badge}`}>{acilisDurum.text}</span></td>
                            <td><span className={`badge ${kontrolCell.badge}`}>{kontrolCell.text}</span></td>
                            <td><span className={`badge ${kapanisCell.badge}`}>{kapanisCell.text}</span></td>
                            <td><span className={`badge ${vardiyaDurum.badge}`}>{vardiyaDurum.text}</span></td>
                            <td><span className={`badge ${ciroDurum.badge}`}>{ciroDurum.text}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Şube kartları grid */}
            {yukleniyor ? (
              <div className="loading" style={{ marginBottom: 16 }}><div className="spinner" />Yükleniyor…</div>
            ) : kartlar.length === 0 ? (
              <div className="empty"><div className="icon">✅</div><p>Seçili filtrede gösterilecek şube bulunamadı</p></div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
                {kartlar.map((k) => (
                  <SubeKart key={k.sube_id || k.sube_adi} k={k} onDetay={setDetay} personelRisk={riskliPersonelSubeMap[k.sube_id]} />
                ))}
              </div>
            )}
          </>
        );
      })()}

      {aktifSekme === 'magaza-kartlari' && (
        <>
        <div className="card" style={{ padding: '18px 20px' }}>
          {magazaStokOnayBekleyenAdet > 0 && (
            <div style={{
              position: 'sticky',
              top: 0,
              zIndex: 12,
              marginBottom: 12,
              padding: '10px 12px',
              background: 'rgba(232, 160, 61, 0.18)',
              border: '1px solid rgba(232, 160, 61, 0.45)',
              borderRadius: 8,
              fontSize: 12,
              color: '#b45309',
              fontWeight: 600,
              boxShadow: '0 2px 8px rgba(0,0,0,.08)',
            }}>
              Onay bekliyor: <strong>{magazaStokOnayBekleyenAdet}</strong> kalem — başka sekmeye geçmeden önce onaylayın veya değişikliği tamamlayın.
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <button
              type="button"
              className={`btn btn-sm ${magazaDepoUstSekme === 'subeler' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMagazaDepoUstSekme('subeler')}
            >
              Şube depoları
            </button>
            <button
              type="button"
              className={`btn btn-sm ${magazaDepoUstSekme === 'genel-ozet' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMagazaDepoUstSekme('genel-ozet')}
            >
              Genel depo özeti
            </button>
            <button
              type="button"
              className={`btn btn-sm ${magazaDepoUstSekme === 'katalog-sube-stok' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setMagazaDepoUstSekme('katalog-sube-stok')}
            >
              Katalog · şube stok
            </button>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>
              Özet API: <code style={{ fontSize: 10 }}>/ops/v2/depo-ozet</code>
            </span>
          </div>
          {magazaDepoUstSekme === 'genel-ozet' ? (
            <div style={{ marginBottom: 8 }}>
              {magazaDepoOzetYukleniyor && (
                <div className="loading" style={{ padding: 16, fontSize: 12 }}><div className="spinner" />Depo özeti yükleniyor…</div>
              )}
              {!magazaDepoOzetYukleniyor && !magazaDepoOzet && (
                <p style={{ fontSize: 12, color: 'var(--text3)' }}>Özet verisi alınamadı.</p>
              )}
              {!magazaDepoOzetYukleniyor && magazaDepoOzet && (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                    <label style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      Gün penceresi
                      <select
                        className="input"
                        style={{ width: 90, padding: '4px 8px', fontSize: 12 }}
                        value={magazaDepoOzetGun}
                        onChange={(e) => setMagazaDepoOzetGun(Math.max(1, Math.min(366, Number(e.target.value) || 30)))}
                      >
                        {[7, 14, 30, 45, 90].map((g) => (
                          <option key={g} value={g}>{g} gün</option>
                        ))}
                      </select>
                    </label>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                      {magazaDepoOzet.tarih_baslangic} → {magazaDepoOzet.tarih_bitis}
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => magazaDepoTamYenile()}>
                      Şube stoklarını da yenile
                    </button>
                  </div>
                  <div style={{
                    marginBottom: 14,
                    padding: '10px 12px',
                    fontSize: 11,
                    color: 'var(--text2)',
                    lineHeight: 1.5,
                    background: 'var(--bg2)',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                  }}>
                    <strong>Merkez vs şube depo:</strong>{' '}
                    Sipariş ve sevkiyat ekranlarında stok hesabı bazen <code style={{ fontSize: 10 }}>merkez_stok_kart</code> (merkez rezerv / ürün kartı),
                    bazen <code style={{ fontSize: 10 }}>sube_depo_stok</code> (bu sayfadaki şube canlı depo) üzerinden yapılır.
                    Hangi kaynağın geçerli olduğunu ilgili ekrandaki uyarı rozetleri ve «hedef depo» seçimi belirler; şüphede önce o ekranın seçili depo / kaynak bilgisine bakın.
                  </div>
                  {(() => {
                    const oz = magazaDepoOzet.ozet || {};
                    const subeRows = Array.isArray(magazaDepoOzet.subeler) ? magazaDepoOzet.subeler : [];
                    const subeAd = (id) => subeRows.find((s) => String(s.id) === String(id))?.ad || id;
                    const subeBasi = oz.sube_basi && typeof oz.sube_basi === 'object' ? oz.sube_basi : {};
                    return (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 14 }}>
                          <div className="card" style={{ padding: 10, fontSize: 12 }}>
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Toplam stok değeri</div>
                            <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(oz.toplam_stok_deger || 0)} ₺</div>
                          </div>
                          <div className="card" style={{ padding: 10, fontSize: 12 }}>
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Harcama (pencere)</div>
                            <div style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(oz.toplam_harcama_deger || 0)} ₺</div>
                          </div>
                          <div className="card" style={{ padding: 10, fontSize: 12 }}>
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Kritik kalem</div>
                            <div style={{ fontWeight: 800, color: '#e8a03d' }}>{oz.kritik_kalem_sayisi ?? 0}</div>
                          </div>
                          <div className="card" style={{ padding: 10, fontSize: 12 }}>
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Sıfır stok kalem</div>
                            <div style={{ fontWeight: 800, color: '#e85d5d' }}>{oz.sifir_kalem_sayisi ?? 0}</div>
                          </div>
                          <div className="card" style={{ padding: 10, fontSize: 12 }}>
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Ürün satırı</div>
                            <div style={{ fontWeight: 800 }}>{oz.urun_sayisi ?? 0}</div>
                          </div>
                        </div>
                        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>Şube bazlı özet</h4>
                        <div style={{ overflow: 'auto', marginBottom: 16, border: '1px solid var(--border)', borderRadius: 8 }}>
                          <table className="table" style={{ fontSize: 11, margin: 0, minWidth: 520 }}>
                            <thead>
                              <tr>
                                <th>Şube</th>
                                <th style={{ textAlign: 'right' }}>Stok ₺</th>
                                <th style={{ textAlign: 'right' }}>Harcama ₺</th>
                                <th style={{ textAlign: 'right' }}>Kritik</th>
                                <th style={{ textAlign: 'right' }}>Sıfır</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(subeBasi).map(([sid, row]) => (
                                <tr key={`oz-sub-${sid}`}>
                                  <td>{subeAd(sid)}</td>
                                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(row?.stok_deger || 0)}</td>
                                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(row?.harcama_deger || 0)}</td>
                                  <td style={{ textAlign: 'right' }}>{row?.kritik ?? 0}</td>
                                  <td style={{ textAlign: 'right' }}>{row?.sifir ?? 0}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <h4 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>Ürün pivot (ilk 60, değer azalan)</h4>
                        <div style={{ overflow: 'auto', maxHeight: 360, border: '1px solid var(--border)', borderRadius: 8 }}>
                          <table className="table" style={{ fontSize: 10, margin: 0, minWidth: 480 }}>
                            <thead>
                              <tr>
                                <th>Kalem</th>
                                <th style={{ textAlign: 'right' }}>Adet</th>
                                <th style={{ textAlign: 'right' }}>Değer ₺</th>
                                <th style={{ textAlign: 'right' }}>Harc.</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(Array.isArray(magazaDepoOzet.urunler) ? magazaDepoOzet.urunler : []).slice(0, 60).map((u) => (
                                <tr key={`oz-ur-${u.kalem_kodu}`}>
                                  <td>
                                    <div style={{ fontWeight: 600 }}>{u.kalem_adi || u.kalem_kodu}</div>
                                    <div className="mono" style={{ color: 'var(--text3)', fontSize: 9 }}>{u.kalem_kodu}</div>
                                  </td>
                                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.toplam_adet ?? 0}</td>
                                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(u.toplam_deger || 0)}</td>
                                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{u.toplam_harcanan ?? 0}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          ) : magazaDepoUstSekme === 'subeler' ? (
          <>
          {/* ════════ BÖLÜM 1: KATALOG YÖNETİMİ ════════ */}
          <div style={{
            marginBottom: 18,
            paddingBottom: 14,
            borderBottom: '2px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>🛠 Katalog Yönetimi</h3>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text3)' }}>
                  Tüm şube depolarını etkileyen ürün/fiyat işlemleri
                </p>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setMagazaUrunEkleAcik((a) => {
                      const ac = !a;
                      if (ac) setMagazaFiyatGuncelleAcik(false);
                      return ac;
                    });
                  }}
                  style={magazaUrunEkleAcik ? { boxShadow: '0 0 0 1px rgba(45, 181, 115, 0.45)' } : undefined}
                >
                  {magazaUrunEkleAcik ? 'Ürün eklemeyi kapat' : '＋ Ürün ekle'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setMagazaFiyatGuncelleAcik((a) => {
                      const ac = !a;
                      if (ac) setMagazaUrunEkleAcik(false);
                      return ac;
                    });
                  }}
                  style={magazaFiyatGuncelleAcik ? { boxShadow: '0 0 0 1px rgba(200, 124, 26, 0.55)' } : undefined}
                >
                  {magazaFiyatGuncelleAcik ? 'Fiyat güncellemeyi kapat' : 'Fiyat güncelle'}
                </button>
              </div>
            </div>
          </div>

          {magazaUrunEkleAcik && (
            <div
              className="card"
              style={{
                marginBottom: 16,
                padding: '14px 16px',
                borderLeft: '4px solid #2db573',
                background: 'var(--bg2)',
              }}
            >
              <h4 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>Kataloga ürün (ön form)</h4>
              <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.45 }}>
                Ürün merkez kataloga eklenir ve tüm şube depolarına aynı katalog ürünü olarak düşer.
                Ek olarak <strong>birim fiyat (TL)</strong> kaydedilir; <strong>adet</strong> girerseniz depo kartlarında bu yeni ürün için başlangıç stokuna ön-yazım yapılır.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, alignItems: 'end' }}>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Kategori (kod)</span>
                  <select
                    className="input"
                    value={magazaUrunEkleForm.kategori_kod}
                    onChange={(e) => setMagazaUrunEkleForm((p) => ({ ...p, kategori_kod: e.target.value }))}
                  >
                    <option value="">Seçin</option>
                    {(magazaDepoKatalogState.kategoriler || []).map((kat) => (
                      <option key={`mag-ek-${kat.id}`} value={kat.id}>{kat.label || kat.ad || kat.id}</option>
                    ))}
                  </select>
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ürün adı</span>
                  <input
                    className="input"
                    value={magazaUrunEkleForm.urun_adi}
                    onChange={(e) => setMagazaUrunEkleForm((p) => ({ ...p, urun_adi: e.target.value }))}
                    placeholder="Örn: Vanilya"
                  />
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Açıklama (tür/çeşit)</span>
                  <input
                    className="input"
                    value={magazaUrunEkleForm.aciklama}
                    onChange={(e) => setMagazaUrunEkleForm((p) => ({ ...p, aciklama: e.target.value }))}
                    placeholder="Örn: Toz, Şurup, 1L"
                  />
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Birim fiyat (TL)</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={magazaUrunEkleForm.fiyat_tl}
                    onChange={(e) => setMagazaUrunEkleForm((p) => ({ ...p, fiyat_tl: e.target.value }))}
                    placeholder="0,00"
                  />
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Adet</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={magazaUrunEkleForm.adet}
                    onChange={(e) => setMagazaUrunEkleForm((p) => ({ ...p, adet: e.target.value }))}
                    placeholder="0"
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setMagazaUrunEkleForm({ kategori_kod: '', urun_adi: '', aciklama: '', fiyat_tl: '', adet: '' });
                    }}
                  >
                    Temizle
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={
                      !String(magazaUrunEkleForm.kategori_kod || '').trim()
                      || !String(magazaUrunEkleForm.urun_adi || '').trim()
                    }
                    onClick={async () => {
                      const kategoriKod = String(magazaUrunEkleForm.kategori_kod || '').trim();
                      const urunAdi = String(magazaUrunEkleForm.urun_adi || '').trim();
                      const aciklama = String(magazaUrunEkleForm.aciklama || '').trim() || null;
                      if (!kategoriKod || !urunAdi) return;
                      try {
                        const r = await api('/ops/siparis/urun', {
                          method: 'POST',
                          body: { kategori_kod: kategoriKod, urun_adi: urunAdi, aciklama },
                        });
                        const urunId = String(r?.urun_id || '').trim();
                        const fiyatParsed = magazaKatalogSayi(magazaUrunEkleForm.fiyat_tl);
                        if (urunId && fiyatParsed != null && fiyatParsed >= 0) {
                          await api('/ops/siparis/urun-fiyat', {
                            method: 'POST',
                            body: {
                              kategori_kod: kategoriKod,
                              urun_id: urunId,
                              birim_fiyat_tl: fiyatParsed,
                            },
                          });
                          setMagazaGlobalFiyatMap((prev) => ({ ...prev, [urunId]: fiyatParsed }));
                        }
                        const adetText = String(magazaUrunEkleForm.adet || '').trim();
                        if (urunId && adetText) {
                          setMagazaSubeStokInput((prev) => {
                            const next = { ...prev };
                            magazaDepoSubeler.forEach((m) => {
                              const kk = magazaKartBul(kartlar, m);
                              const sid = magazaSubeDepoAnahtar(kk, m);
                              next[`${sid}::${urunId}`] = adetText;
                            });
                            return next;
                          });
                        }
                        await magazaDepoTamYenile();
                        toast('Ürün eklendi ve tüm şube depolarına tanımlandı.', 'green');
                        setMagazaUrunEkleForm({ kategori_kod: '', urun_adi: '', aciklama: '', fiyat_tl: '', adet: '' });
                      } catch (e) {
                        toast(`Ürün eklenemedi: ${e.message}`, 'red');
                      }
                    }}
                  >
                    Tüm depolara ekle
                  </button>
                </div>
              </div>
            </div>
          )}

          {magazaFiyatGuncelleAcik && (
            <div
              className="card"
              style={{
                marginBottom: 16,
                padding: '14px 16px',
                borderLeft: '4px solid #c97c1a',
                background: 'var(--bg2)',
              }}
            >
              <h4 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px' }}>Birim fiyat güncelle (hızlı düzenleme)</h4>
              <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.45 }}>
                Kategori ve ürün seçip fiyatı hızlıca güncelleyin. <strong>Uygula</strong> tıklanınca seçilen ürünün fiyatı aynı katalog kaynağını kullanan
                <strong> tüm şube depo kartlarına</strong> anında yansıtılır.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, alignItems: 'end', marginBottom: 10 }}>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Kategori</span>
                  <select
                    className="input"
                    value={magazaFiyatGuncelleForm.kategori_kod}
                    onChange={(e) => {
                      const v = e.target.value;
                      const kat = (magazaDepoKatalogState.kategoriler || []).find((k) => k.id === v);
                      const items = (Array.isArray(kat?.items) ? kat.items : []).filter((it) => it && it.aktif !== false);
                      const taslak = {};
                      items.forEach((it) => {
                        const efektifFiyat = magazaUrunEfektifBirimFiyat(it, magazaGlobalFiyatMap);
                        taslak[it.id] = efektifFiyat != null ? String(efektifFiyat) : '';
                      });
                      const seciliUrunId = items[0] ? String(items[0].id || '') : '';
                      setMagazaFiyatGuncelleForm({
                        kategori_kod: v,
                        urun_id: seciliUrunId,
                        yeni_fiyat_tl: seciliUrunId ? (taslak[seciliUrunId] ?? '') : '',
                      });
                      setMagazaFiyatHizliTaslak(taslak);
                    }}
                  >
                    <option value="">Seçin</option>
                    {(magazaDepoKatalogState.kategoriler || []).map((kat) => (
                      <option key={`mag-fg-${kat.id}`} value={kat.id}>{kat.label || kat.ad || kat.id}</option>
                    ))}
                  </select>
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ürün</span>
                  <select
                    className="input"
                    value={magazaFiyatGuncelleForm.urun_id}
                    onChange={(e) => {
                      const urunId = e.target.value;
                      setMagazaFiyatGuncelleForm((prev) => ({
                        ...prev,
                        urun_id: urunId,
                        yeni_fiyat_tl: String(magazaFiyatHizliTaslak[urunId] ?? ''),
                      }));
                    }}
                    disabled={!String(magazaFiyatGuncelleForm.kategori_kod || '').trim()}
                  >
                    <option value="">Seçin</option>
                    {(() => {
                      const kod = String(magazaFiyatGuncelleForm.kategori_kod || '').trim();
                      const kat = (magazaDepoKatalogState.kategoriler || []).find((k) => k.id === kod);
                      const items = (Array.isArray(kat?.items) ? kat.items : []).filter((it) => it && it.aktif !== false);
                      return items.map((it) => (
                        <option key={`mag-fg-urun-${it.id}`} value={it.id}>{it.ad || it.id}</option>
                      ));
                    })()}
                  </select>
                </label>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Yeni fiyat (TL)</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={magazaFiyatGuncelleForm.yeni_fiyat_tl}
                    onChange={(e) => {
                      const v = e.target.value;
                      const urunId = String(magazaFiyatGuncelleForm.urun_id || '').trim();
                      setMagazaFiyatGuncelleForm((prev) => ({ ...prev, yeni_fiyat_tl: v }));
                      if (!urunId) return;
                      setMagazaFiyatHizliTaslak((prev) => ({ ...prev, [urunId]: v }));
                    }}
                    placeholder="0,00"
                    disabled={!String(magazaFiyatGuncelleForm.urun_id || '').trim()}
                  />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setMagazaFiyatGuncelleForm({ kategori_kod: '', urun_id: '', yeni_fiyat_tl: '' });
                      setMagazaFiyatHizliTaslak({});
                    }}
                  >
                    Temizle
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={
                      !String(magazaFiyatGuncelleForm.kategori_kod || '').trim()
                      || !String(magazaFiyatGuncelleForm.urun_id || '').trim()
                    }
                    onClick={async () => {
                      const urunId = String(magazaFiyatGuncelleForm.urun_id || '').trim();
                      if (!urunId) {
                        toast('Önce bir ürün seçin.', 'yellow');
                        return;
                      }
                      const parsed = magazaKatalogSayi(magazaFiyatGuncelleForm.yeni_fiyat_tl);
                      if (parsed == null || parsed < 0) {
                        toast('Fiyat 0 veya daha büyük sayısal bir değer olmalı.', 'yellow');
                        return;
                      }
                      try {
                        await api('/ops/siparis/urun-fiyat', {
                          method: 'POST',
                          body: {
                            kategori_kod: String(magazaFiyatGuncelleForm.kategori_kod || '').trim(),
                            urun_id: urunId,
                            birim_fiyat_tl: parsed,
                          },
                        });
                        setMagazaGlobalFiyatMap((prev) => ({ ...prev, [urunId]: parsed }));
                        await magazaDepoTamYenile();
                        toast('Fiyat güncellendi ve tüm depo kartlarına yansıtıldı.', 'green');
                      } catch (e) {
                        toast(`Fiyat güncellenemedi: ${e.message}`, 'red');
                      }
                    }}
                  >
                    Seçili ürünü tüm depolara uygula
                  </button>
                </div>
              </div>
              {String(magazaFiyatGuncelleForm.kategori_kod || '').trim() && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', background: 'var(--bg)' }}>
                  {(() => {
                    const kod = String(magazaFiyatGuncelleForm.kategori_kod || '').trim();
                    const urunId = String(magazaFiyatGuncelleForm.urun_id || '').trim();
                    const kat = (magazaDepoKatalogState.kategoriler || []).find((k) => k.id === kod);
                    const items = (Array.isArray(kat?.items) ? kat.items : []).filter((it) => it && it.aktif !== false);
                    const seciliUrun = items.find((it) => String(it.id || '') === urunId);
                    if (!seciliUrun) {
                      return <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu kategoride aktif ürün yok.</div>;
                    }
                    const sistemFiyat = seciliUrun.birim_fiyat;
                    const efektifFiyat = magazaUrunEfektifBirimFiyat(seciliUrun, magazaGlobalFiyatMap);
                    return (
                      <div style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                        <strong style={{ fontSize: 13 }}>{seciliUrun.ad}</strong>
                        <span style={{ color: 'var(--text3)' }}>Mevcut / Sistem fiyatı: {magazaFmtBirimFiyat(sistemFiyat)}</span>
                        <span style={{ color: 'var(--text2)' }}>Geçerli efektif fiyat: {magazaFmtBirimFiyat(efektifFiyat)}</span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* ════════ BÖLÜM 2: ŞUBE ERİŞİM ÖZETİ ════════ */}
          <div style={{
            marginBottom: 18,
            paddingBottom: 14,
            borderBottom: '2px solid var(--border)',
          }}>
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>⚡ Şube Erişim Özeti</h3>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
                Her şubeye hızlı atla — alarm ve onay sayıları aşağıda.{' '}
                Aynı katalog kaynağı (<code style={{ fontSize: 11 }}>/ops/siparis/katalog</code>) tüm depolarda paylaşılır;
                satır bazlı <strong>Onay</strong> ile şube canlı depo (<code style={{ fontSize: 11 }}>/ops/v2/sube/…/depo</code>) stoğuna işlenir.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {magazaDepoSubeler.map((m) => {
              const k = magazaKartBul(kartlar, m);
              const sidKey = magazaSubeDepoAnahtar(k, m);
              const canli = Array.isArray(magazaDepoCanliStok[m.slug]) ? magazaDepoCanliStok[m.slug] : [];
              const depoMeta = magazaDepoDepoMeta[m.slug];
              const alarmClient = canli.filter((st) => magazaDepoSatirKritik(st)).length;
              const kritikSayi = depoMeta?.durum === 'ok' ? Number(depoMeta.alarm_sayisi ?? 0) : alarmClient;
              const bekleyen = Object.keys(magazaStokOnayBekleyen || {}).filter((kk) => kk.startsWith(`${sidKey}::`)).length;
              return (
                <button
                  key={`ozet-${m.slug}`}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{
                    ...(kritikSayi > 0 ? { boxShadow: 'inset 0 0 0 1px rgba(239,68,68,0.35)' } : {}),
                    ...(magazaDepoOdakSlug === m.slug
                      ? { boxShadow: '0 0 0 2px rgba(74, 158, 255, 0.65)', background: 'rgba(74, 158, 255, 0.12)' }
                      : {}),
                  }}
                  onClick={() => {
                    setMagazaDepoOdakSlug(m.slug);
                    setMagazaDepoAltSekme((prev) => ({
                      ...prev,
                      [m.slug]: kritikSayi > 0 ? 'uyari' : 'katalog',
                    }));
                    requestAnimationFrame(() => {
                      const el = document.getElementById(`magaza-depo-kart-${m.slug}`);
                      if (el && typeof el.scrollIntoView === 'function') {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }
                    });
                  }}
                >
                  <span>{m.depoBaslik}</span>
                  {kritikSayi > 0 ? (
                    <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>{kritikSayi} kritik</span>
                  ) : (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text3)' }}>0 kritik</span>
                  )}
                  {bekleyen > 0 ? (
                    <span className="badge badge-yellow" style={{ marginLeft: 6, fontSize: 10 }}>{bekleyen} onay</span>
                  ) : null}
                </button>
              );
            })}
            </div>
          </div>

          {/* ════════ BÖLÜM 3: ŞUBE DEPOLARI (DETAY) ════════ */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.2 }}>🏪 Şube Depoları</h3>
              {magazaDepoOdakSlug ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setMagazaDepoOdakSlug(null)}
                >
                  Tüm şubeleri göster
                </button>
              ) : null}
            </div>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              Her şubenin canlı stok kartı — katalog / uyarı / canlı alt sekmeleri ile.
              {' '}
              <strong>Kart başlığına</strong> tıklayarak yalnız o şubeyi tam genişlikte açabilirsiniz; üstteki «Şube erişim» şubeleri de aynı odak modunu açar.
              {' '}
              <strong>Merkez vs şube:</strong> sipariş–sevkiyat hesaplarında geçerli kaynak ekrandaki «hedef depo» ve rozetlerle seçilir;
              merkez ürün kartı (<code style={{ fontSize: 10 }}>merkez_stok_kart</code>) ile bu sayfadaki şube depo (<code style={{ fontSize: 10 }}>sube_depo_stok</code>) aynı değildir.
            </p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <input
              type="search"
              className="input"
              autoComplete="off"
              style={{ minWidth: 0, flex: '1 1 220px', maxWidth: 420 }}
              placeholder="Katalogda ürün adı veya ID ara…"
              value={magazaKatalogArama}
              onChange={(e) => setMagazaKatalogArama(e.target.value)}
            />
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={magazaKatalogSadeceKritik}
                onChange={(e) => setMagazaKatalogSadeceKritik(e.target.checked)}
              />
              Yalnızca kritik (depo satırı)
            </label>
          </div>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: 4 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: magazaDepoOdakSlug
              ? 'minmax(0, 1fr)'
              : 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: 12,
            minWidth: 0,
          }}>
            {magazaDepoGosterimSubeler.map((m) => {
              const k = magazaKartBul(kartlar, m);
              const risk = k ? riskliPersonelSubeMap[k.sube_id] : null;
              const katList = magazaDepoKatalogState.kategoriler || [];
              const subeDepoKey = magazaSubeDepoAnahtar(k, m);
              const manuelListe = Array.isArray(magazaManuelSatirlar[subeDepoKey]) ? magazaManuelSatirlar[subeDepoKey] : [];
              const canliStokSatirlari = Array.isArray(magazaDepoCanliStok[m.slug]) ? magazaDepoCanliStok[m.slug] : [];
              const depoMeta = magazaDepoDepoMeta[m.slug];
              const canliUyarilar = canliStokSatirlari.filter((st) => magazaDepoSatirKritik(st));
              const kritikRapor = depoMeta?.durum === 'ok' ? Number(depoMeta.alarm_sayisi ?? 0) : null;
              const kritikGoster = kritikRapor != null ? kritikRapor : canliUyarilar.length;
              const depoToplamTl = magazaDepoCanliToplamDeger(canliStokSatirlari);
              const panelSekme = magazaDepoAltSekme[m.slug] || 'katalog';
              const bekleyenOnayAdet = Object.keys(magazaStokOnayBekleyen || {}).filter((kk) => kk.startsWith(`${subeDepoKey}::`)).length;
              return (
                <div
                  key={m.slug}
                  id={`magaza-depo-kart-${m.slug}`}
                  className="card"
                  data-magaza-slug={m.slug}
                  data-sube-id={k?.sube_id || ''}
                  style={{
                    padding: '14px 16px',
                    borderLeft: k ? '4px solid #4a9eff' : '4px solid var(--border)',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    minWidth: 0,
                    outline: magazaDepoOdakSlug === m.slug ? '2px solid rgba(74, 158, 255, 0.45)' : undefined,
                    outlineOffset: magazaDepoOdakSlug === m.slug ? 2 : undefined,
                  }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMagazaDepoOdakSlug((prev) => (prev === m.slug ? null : m.slug))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setMagazaDepoOdakSlug((prev) => (prev === m.slug ? null : m.slug));
                      }
                    }}
                    title={magazaDepoOdakSlug === m.slug ? 'Tıklayın: tüm şubeleri tekrar göster' : 'Tıklayın: yalnız bu şubeyi tam genişlikte aç'}
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 8,
                      cursor: 'pointer',
                      borderRadius: 8,
                      margin: '-6px -6px 0 -6px',
                      padding: '6px 6px 4px 6px',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg3)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>{m.depoBaslik}</span>
                        {kritikGoster > 0 ? (
                          <span className="badge badge-red" style={{ fontSize: 11 }}>{kritikGoster} kritik</span>
                        ) : (
                          <span className="badge badge-green" style={{ fontSize: 10 }}>Kritik yok</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{m.label} · slug: {m.slug}</div>
                    </div>
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: 'var(--text2)',
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: 'var(--bg2)',
                    border: '1px solid var(--border)',
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: 1.45,
                  }}>
                    <strong>{canliStokSatirlari.length}</strong> depo kalem ·{' '}
                    <strong>{magazaFmtBirimFiyat(depoToplamTl)}</strong> stok değeri ·{' '}
                    <strong style={{ color: kritikGoster > 0 ? '#dc2626' : undefined }}>{kritikGoster}</strong> kritik
                  </div>
                  {!k && depoMeta?.durum !== 'hub_yok' && (
                    <p style={{ fontSize: 12, color: '#b45309', margin: 0, padding: '8px 10px', background: 'rgba(232,160,61,.12)', borderRadius: 6, border: '1px solid rgba(232,160,61,.35)' }}>
                      Hub'da bu şube eşleşmedi — operasyon dashboard'unda şube kartı yok veya isim filtresi eşleşmiyor.
                    </p>
                  )}
                  {depoMeta?.durum === 'hub_yok' && (
                    <p style={{ fontSize: 12, color: '#b45309', margin: 0, padding: '8px 10px', background: 'rgba(232,160,61,.1)', borderRadius: 6 }}>
                      <strong>Depo verisi yok:</strong> şube ID üretilemedi; istek gönderilmedi. Hub'da aktif şube kartı ve <strong>sube_id</strong> eşleşmesi gerekir.
                    </p>
                  )}
                  {depoMeta?.durum === 'api_hata' && (
                    <p style={{ fontSize: 12, color: '#dc2626', margin: 0, padding: '8px 10px', background: 'rgba(239,68,68,.08)', borderRadius: 6, border: '1px solid rgba(239,68,68,.25)' }}>
                      Depo API yanıt vermedi (liste boş görünür). Ağı veya sunucuyu kontrol edip yenileyin.
                    </p>
                  )}
                  {k && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                      <span className="mono">{k.sube_id}</span>
                      {' · '}
                      {k.sube_adi || '—'}
                      {risk ? <span className="badge badge-yellow" style={{ marginLeft: 8 }}>Personel riski</span> : null}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className={`btn btn-sm ${panelSekme === 'katalog' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setMagazaDepoAltSekme((prev) => ({ ...prev, [m.slug]: 'katalog' }))}
                    >
                      Katalog
                      {bekleyenOnayAdet > 0 ? ` (${bekleyenOnayAdet} onay)` : ''}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${panelSekme === 'uyari' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setMagazaDepoAltSekme((prev) => ({ ...prev, [m.slug]: 'uyari' }))}
                    >
                      <span>Depo uyarıları</span>
                      {kritikGoster > 0 ? (
                        <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>{kritikGoster}</span>
                      ) : (
                        <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text3)' }}>({canliUyarilar.length})</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${panelSekme === 'canli' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setMagazaDepoAltSekme((prev) => ({ ...prev, [m.slug]: 'canli' }))}
                    >
                      Canlı depo ({canliStokSatirlari.length})
                    </button>
                  </div>
                  {panelSekme === 'katalog' && (
                  <div
                    data-magaza-depo-katalog-root
                    style={{ borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 2 }}
                  >
                    <datalist id="magaza-depo-havuz-datalist-global">
                      {MAGAZA_DEPO_STOK_ANAHTARLARI.map((opt) => (
                        <option key={opt} value={opt} />
                      ))}
                    </datalist>
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.45,
                        color: 'var(--text2)',
                        marginBottom: 10,
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'rgba(91, 143, 216, 0.08)',
                        border: '1px solid rgba(91, 143, 216, 0.35)',
                      }}
                    >
                      <strong style={{ display: 'block', marginBottom: 4, fontSize: 11 }}>Şube deposunda otomatik ve elle ne demek?</strong>
                      <span style={{ color: 'var(--text3)', fontSize: 10 }}>
                        <strong style={{ color: 'var(--text2)' }}>Havuz (Alan «otomatik»)</strong>
                        {' — Boş bırakılırsa sistem ürün adına ve katalogdaki ayara göre depo kalemini kendisi seçer; listeden anahtar yazarsanız o havuzda birleştirirsiniz. '}
                        <strong style={{ color: 'var(--text2)' }}>Elle stok</strong>
                        {' — Bu şube için yazdığınız hedef adettir; depoyu güncellemek için satırdaki '}
                        <strong>Onay</strong>
                        {' gerekir. '}
                        <strong style={{ color: 'var(--text2)' }}>Canlı depo</strong>
                        {' sekmesi gerçek kayıtlı stoğu gösterir (sipariş teslimi, ürün aç, sayım düzeltmesi vb.). '}
                        <strong style={{ color: 'var(--text2)' }}>Depo uyarıları</strong>
                        {' ise mevcudu sıfır olan her depo satırını ve bardaklarda eşik altını listeler.'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>
                      Katalog + şube bazlı elle stok
                      <span className="mono" style={{ fontWeight: 500, marginLeft: 6, fontSize: 10, color: 'var(--text3)' }}>{subeDepoKey}</span>
                    </div>
                    {magazaDepoKatalogState.yukleniyor && (
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Katalog yükleniyor…</div>
                    )}
                    {!magazaDepoKatalogState.yukleniyor && katList.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kategori / ürün listesi boş.</div>
                    )}
                    {!magazaDepoKatalogState.yukleniyor && katList.map((kat) => {
                      const kk = `${m.slug}::${kat.id}`;
                      const acik = magazaDepoKatAcik[kk] === true;
                      const filteredItems = (kat.items || []).filter((it) => {
                        const canliSatir = canliStokSatirlari.find((st) => String(st?.kalem_kodu || '') === String(it.id || ''));
                        const kritikCtx = {
                          kategoriKod: kat.id,
                          kategoriLabel: kat.label || kat.ad,
                          urunAd: it.ad,
                        };
                        if (magazaKatalogSadeceKritik && (!canliSatir || !magazaDepoSatirKritik(canliSatir, kritikCtx))) return false;
                        return magazaKatalogUrunAramaEslesir(it, magazaKatalogArama);
                      });
                      if (filteredItems.length === 0) return null;
                      const nAktif = filteredItems.filter((it) => it && it.aktif !== false).length;
                      const katDeger = magazaKategoriStokDegerToplamSube(kat, subeDepoKey, magazaSubeStokInput, magazaGlobalFiyatMap);
                      return (
                        <div key={kk} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 6 }}>
                          <button
                            type="button"
                            onClick={() => setMagazaDepoKatAcik((prev) => ({ ...prev, [kk]: !prev[kk] }))}
                            style={{
                              width: '100%',
                              background: 'var(--bg2)',
                              border: 'none',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '7px 10px',
                              cursor: 'pointer',
                              color: 'var(--text)',
                              fontSize: 12,
                              fontWeight: 600,
                            }}
                          >
                            <span style={{ textAlign: 'left' }}>{kat.label}</span>
                            <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, marginLeft: 8, textAlign: 'right' }}>
                              <span>
                                {nAktif} ürün {acik ? '▲' : '▼'}
                              </span>
                              {katDeger != null ? (
                                <span style={{ display: 'block', marginTop: 2, color: 'var(--text2)' }}>
                                  Kategori toplam: {magazaFmtBirimFiyat(katDeger)}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          {acik && (
                            <div style={{ background: 'var(--bg)', overflowX: 'auto' }}>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(0,1fr) 92px 70px 78px 64px',
                                  gap: 6,
                                  alignItems: 'start',
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: 'var(--text3)',
                                  padding: '6px 10px 4px',
                                  borderBottom: '1px solid var(--border)',
                                  minWidth: 480,
                                }}
                              >
                                <span>Ürün (depo havuzu)</span>
                                <span style={{ textAlign: 'center' }}>Elle stok</span>
                                <span style={{ textAlign: 'right' }}>Fiyat</span>
                                <span style={{ textAlign: 'right' }}>Toplam</span>
                                <span style={{ textAlign: 'right' }}>Onay</span>
                              </div>
                              <ul style={{ margin: 0, padding: '0 10px 8px', listStyle: 'none', fontSize: 11, background: 'var(--bg)', minWidth: 480 }}>
                                {filteredItems.map((it) => {
                                  const mapKey = `${subeDepoKey}::${it.id}`;
                                  const canliSatir = canliStokSatirlari.find((st) => String(st?.kalem_kodu || '') === String(it.id || ''));
                                  const referansHam = canliSatir ? canliSatir.mevcut_adet : it.stok;
                                  const referansSayi = String(referansHam ?? '').trim() === '' ? 0 : (magazaKatalogSayi(referansHam) ?? 0);
                                  const stokRaw = magazaStokGirdiOku(magazaSubeStokInput, subeDepoKey, it.id, referansHam);
                                  const stokSayi = String(stokRaw).trim() === '' ? null : magazaKatalogSayi(stokRaw);
                                  const efektifBirimFiyat = magazaUrunEfektifBirimFiyat(it, magazaGlobalFiyatMap);
                                  const onayGerekli = stokSayi != null && stokSayi !== referansSayi;
                                  const onayBusy = !!magazaStokOnayBusy[mapKey];
                                  const satirToplam = stokSayi != null && efektifBirimFiyat != null && Number.isFinite(efektifBirimFiyat)
                                    ? stokSayi * efektifBirimFiyat
                                    : null;
                                  const havuzDb = it.depo_stok_kalem_kodu ? String(it.depo_stok_kalem_kodu).trim() : '';
                                  const havuzTaslakHam = magazaDepoHavuzTaslak[it.id];
                                  const havuzInput = havuzTaslakHam !== undefined ? havuzTaslakHam : havuzDb;
                                  const havuzKaydetGerekli = String(havuzInput || '').trim() !== havuzDb;
                                  const havuzBusy = !!magazaDepoHavuzBusy[it.id];
                                  return (
                                    <li
                                      key={`${kk}-${it.id}`}
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'minmax(0,1fr) 92px 70px 78px 64px',
                                        gap: 6,
                                        alignItems: 'start',
                                        padding: '5px 0',
                                        borderBottom: '1px solid var(--border)',
                                        color: it.aktif === false ? 'var(--text3)' : 'var(--text)',
                                        textDecoration: it.aktif === false ? 'line-through' : 'none',
                                      }}
                                    >
                                      <div style={{ minWidth: 0 }}>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }} title={it.ad}>{it.ad}</span>
                                        {it.stok != null ? (
                                          <span style={{ fontSize: 9, color: 'var(--text3)' }}>Sistem: {magazaFmtStok(it.stok)}</span>
                                        ) : (
                                          <span style={{ fontSize: 9, color: 'var(--text3)' }}>Sistem verisi yok</span>
                                        )}
                                        <div
                                          style={{
                                            marginTop: 6,
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: 6,
                                            alignItems: 'center',
                                          }}
                                          title="Boş = otomatik havuz (ürün adı). Sabit havuz veya başka ürün UUID."
                                        >
                                          <span style={{ fontSize: 9, color: 'var(--text3)', flexShrink: 0 }}>Havuz</span>
                                          <input
                                            type="text"
                                            className="input"
                                            list="magaza-depo-havuz-datalist-global"
                                            placeholder="otomatik"
                                            value={havuzInput}
                                            disabled={it.aktif === false}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              setMagazaDepoHavuzTaslak((prev) => {
                                                if (String(v).trim() === havuzDb) {
                                                  const n = { ...prev };
                                                  delete n[it.id];
                                                  return n;
                                                }
                                                return { ...prev, [it.id]: v };
                                              });
                                            }}
                                            style={{
                                              fontSize: 10,
                                              padding: '2px 6px',
                                              minWidth: 0,
                                              flex: '1 1 100px',
                                              maxWidth: 220,
                                            }}
                                          />
                                          <button
                                            type="button"
                                            className={`btn btn-sm ${havuzKaydetGerekli ? 'btn-primary' : 'btn-secondary'}`}
                                            disabled={it.aktif === false || !havuzKaydetGerekli || havuzBusy}
                                            title={havuzKaydetGerekli ? 'Depo havuz kodunu kaydet' : 'Değişiklik yok'}
                                            onClick={() => magazaDepoHavuzKaydet({
                                              kategoriKod: kat.id,
                                              urunId: it.id,
                                              depoStokKalemKoduRaw: havuzInput,
                                            })}
                                            style={{ padding: '2px 8px', fontSize: 10 }}
                                          >
                                            {havuzBusy ? '…' : (havuzKaydetGerekli ? 'Kaydet' : '✓')}
                                          </button>
                                        </div>
                                      </div>
                                      <input
                                        type="text"
                                        className="input"
                                        inputMode="decimal"
                                        placeholder="Stok"
                                        value={stokRaw}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          setMagazaSubeStokInput((prev) => ({ ...prev, [mapKey]: v }));
                                          const parsed = String(v).trim() === '' ? null : magazaKatalogSayi(v);
                                          setMagazaStokOnayBekleyen((prev) => {
                                            const n = { ...prev };
                                            if (parsed == null || parsed === referansSayi) {
                                              delete n[mapKey];
                                            } else {
                                              n[mapKey] = {
                                                slug: m.slug,
                                                sube_id: String(k?.sube_id || ''),
                                                kalem_kodu: String(it.id || ''),
                                                kalem_adi: it.ad,
                                                mevcut_adet: parsed,
                                              };
                                            }
                                            return n;
                                          });
                                        }}
                                        style={{ fontSize: 11, padding: '4px 6px', width: '100%', minWidth: 0 }}
                                      />
                                      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{magazaFmtBirimFiyat(efektifBirimFiyat)}</span>
                                      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{magazaFmtBirimFiyat(satirToplam)}</span>
                                      <button
                                        type="button"
                                        className={`btn btn-sm ${onayGerekli ? 'btn-primary' : 'btn-secondary'}`}
                                        disabled={!k?.sube_id || stokSayi == null || !onayGerekli || onayBusy}
                                        title={onayGerekli ? 'Bu satırı depoya işle' : 'Onay gerektiren değişiklik yok'}
                                        onClick={() => {
                                          if (!k?.sube_id || stokSayi == null) return;
                                          magazaStokKalemOnayla({
                                            slug: m.slug,
                                            subeDepoKey,
                                            subeId: String(k.sube_id || ''),
                                            kalemKodu: String(it.id || ''),
                                            kalemAdi: it.ad,
                                            mevcutAdet: stokSayi,
                                            minStok: Number(canliSatir?.min_stok || 0),
                                            alisFiyatiTl: Number(efektifBirimFiyat || 0),
                                          });
                                        }}
                                        style={{ padding: '3px 6px', fontSize: 11, minWidth: 58 }}
                                      >
                                        {onayBusy ? '…' : (onayGerekli ? 'Onay' : '✓')}
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {!magazaDepoKatalogState.yukleniyor && katList.length > 0 && (() => {
                      const hasAny = katList.some((kat) => (kat.items || []).some((it) => {
                        const canliSatir = canliStokSatirlari.find((st) => String(st?.kalem_kodu || '') === String(it.id || ''));
                        const kritikCtx = {
                          kategoriKod: kat.id,
                          kategoriLabel: kat.label || kat.ad,
                          urunAd: it.ad,
                        };
                        if (magazaKatalogSadeceKritik && (!canliSatir || !magazaDepoSatirKritik(canliSatir, kritikCtx))) return false;
                        return magazaKatalogUrunAramaEslesir(it, magazaKatalogArama);
                      }));
                      if (hasAny) return null;
                      return (
                        <div style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 0 10px' }}>
                          Arama veya «yalnızca kritik» ile eşleşen ürün yok.
                        </div>
                      );
                    })()}
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Manuel ürün (katalog dışı)</div>
                      <p style={{ fontSize: 10, color: 'var(--text3)', margin: '0 0 8px', lineHeight: 1.4 }}>
                        Bu depo / şube anahtarı için ek satırlar. Uyumsuzluk veya katalogda olmayan ürünleri burada tutabilirsiniz; veri yalnızca tarayıcıda (yenileyince gider).
                      </p>
                      {manuelListe.map((row) => {
                        const st = String(row.stok || '').trim() === '' ? null : magazaKatalogSayi(row.stok);
                        const fp = String(row.fiyat || '').trim() === '' ? null : magazaKatalogSayi(row.fiyat);
                        const lineTot = st != null && fp != null ? st * fp : null;
                        return (
                          <div
                            key={row.lid}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0,1fr) 72px 72px 78px 34px',
                              gap: 6,
                              marginBottom: 6,
                              alignItems: 'center',
                            }}
                          >
                            <input
                              type="text"
                              className="input"
                              placeholder="Ürün adı"
                              value={row.ad}
                              onChange={(e) => {
                                const v = e.target.value;
                                setMagazaManuelSatirlar((prev) => {
                                  const arr = [...(prev[subeDepoKey] || [])];
                                  const i = arr.findIndex((r) => r.lid === row.lid);
                                  if (i < 0) return prev;
                                  arr[i] = { ...arr[i], ad: v };
                                  return { ...prev, [subeDepoKey]: arr };
                                });
                              }}
                              style={{ fontSize: 11, padding: '4px 6px', minWidth: 0 }}
                            />
                            <input
                              type="text"
                              className="input"
                              inputMode="decimal"
                              placeholder="Stok"
                              value={row.stok}
                              onChange={(e) => {
                                const v = e.target.value;
                                setMagazaManuelSatirlar((prev) => {
                                  const arr = [...(prev[subeDepoKey] || [])];
                                  const i = arr.findIndex((r) => r.lid === row.lid);
                                  if (i < 0) return prev;
                                  arr[i] = { ...arr[i], stok: v };
                                  return { ...prev, [subeDepoKey]: arr };
                                });
                              }}
                              style={{ fontSize: 11, padding: '4px 6px', minWidth: 0 }}
                            />
                            <input
                              type="text"
                              className="input"
                              inputMode="decimal"
                              placeholder="Birim ₺"
                              value={row.fiyat}
                              onChange={(e) => {
                                const v = e.target.value;
                                setMagazaManuelSatirlar((prev) => {
                                  const arr = [...(prev[subeDepoKey] || [])];
                                  const i = arr.findIndex((r) => r.lid === row.lid);
                                  if (i < 0) return prev;
                                  arr[i] = { ...arr[i], fiyat: v };
                                  return { ...prev, [subeDepoKey]: arr };
                                });
                              }}
                              style={{ fontSize: 11, padding: '4px 6px', minWidth: 0 }}
                            />
                            <span style={{ fontSize: 10, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                              {magazaFmtBirimFiyat(lineTot)}
                            </span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              title="Satırı sil"
                              onClick={() => {
                                setMagazaManuelSatirlar((prev) => ({
                                  ...prev,
                                  [subeDepoKey]: (prev[subeDepoKey] || []).filter((r) => r.lid !== row.lid),
                                }));
                              }}
                              style={{ padding: '2px 6px', fontSize: 14, lineHeight: 1 }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const lid = `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                          setMagazaManuelSatirlar((prev) => ({
                            ...prev,
                            [subeDepoKey]: [...(prev[subeDepoKey] || []), { lid, ad: '', stok: '', fiyat: '' }],
                          }));
                        }}
                      >
                        ＋ Manuel satır ekle
                      </button>
                    </div>
                  </div>
                  )}
                  {panelSekme === 'uyari' && (
                      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Depo uyarıları</span>
                          <span className={canliUyarilar.length > 0 ? 'badge badge-red' : 'badge badge-green'}>
                            {canliUyarilar.length > 0 ? `${canliUyarilar.length} alarm` : 'Alarm yok'}
                          </span>
                        </div>
                        {canliUyarilar.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
                            Bu şube deposunda sıfır stok alarmı yok; bardak kalemlerinde de eşik altı uyarı yok.
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                            {canliUyarilar.map((st) => {
                              const mevcut = Number(st?.mevcut_adet || 0);
                              const min = Number(st?.min_stok || 0);
                              const kriz = mevcut <= 0;
                              const metaU = magazaCanliDepoSatirMeta(st, katList);
                              return (
                                <div
                                  key={`${m.slug}-uyari-${st.kalem_kodu}`}
                                  style={{
                                    border: `1px solid ${kriz ? 'rgba(239,68,68,.35)' : 'rgba(245,158,11,.35)'}`,
                                    background: kriz ? 'rgba(239,68,68,.08)' : 'rgba(245,158,11,.08)',
                                    borderRadius: 8,
                                    padding: '6px 8px',
                                    fontSize: 11,
                                    lineHeight: 1.35,
                                  }}
                                >
                                  <div style={{ fontWeight: 700 }}>{metaU.baslik}</div>
                                  {metaU.alt ? (
                                    <div style={{ color: 'var(--text2)', fontSize: 10, marginTop: 2 }}>{metaU.alt}</div>
                                  ) : null}
                                  <div style={{ color: 'var(--text2)', marginTop: 2 }}>
                                    Mevcut: {magazaFmtStok(mevcut)} · Min: {magazaFmtStok(min)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {panelSekme === 'canli' && (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                        Canlı depo stok kaydı (şube paneli ürün kabul)
                      </div>
                      <p style={{ fontSize: 10, color: 'var(--text3)', margin: '0 0 8px', lineHeight: 1.4 }}>
                        Şube panelinde <strong>ürün teslim/kabul</strong> ile depoya eklenen kalemler burada tutulur.
                        Katalog eşleşen satırlarda tam ürün adı + kategori; şurup/kahve gibi havuz satırlarında tür (ör. şurup havuzu) ve kısa etiket ayrı gösterilir.
                      </p>
                      {canliStokSatirlari.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>Bu şube için depo kayıt satırı yok.</div>
                      ) : (
                        <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflow: 'auto', paddingRight: 2 }}>
                          {canliStokSatirlari.map((st) => {
                            const metaC = magazaCanliDepoSatirMeta(st, katList);
                            return (
                              <div
                                key={`${m.slug}-canli-${st.kalem_kodu}`}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(0,1fr) auto',
                                  gap: 8,
                                  alignItems: 'start',
                                  padding: '6px 0',
                                  borderBottom: '1px dashed var(--border)',
                                  fontSize: 11,
                                }}
                              >
                                <div style={{ minWidth: 0 }}>
                                  <div
                                    style={{ fontWeight: 700, lineHeight: 1.3 }}
                                    title={`${metaC.baslik}${metaC.alt ? ` — ${metaC.alt}` : ''}`}
                                  >
                                    {metaC.baslik}
                                  </div>
                                  {metaC.alt ? (
                                    <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 3, lineHeight: 1.35 }}>
                                      {metaC.alt}
                                    </div>
                                  ) : null}
                                  <div className="mono" style={{ fontSize: 9, color: 'var(--text3)', marginTop: 2 }}>
                                    {metaC.kod}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, paddingTop: 2 }}>
                                  {magazaFmtStok(st.mevcut_adet)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    )}
                </div>
              );
            })}
          </div>
          </div>
          </>
          ) : magazaDepoUstSekme === 'katalog-sube-stok' ? (
            <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0', lineHeight: 1.45 }}>
              Şube bazlı katalog adet tablosu <strong>hemen alttaki ayrı kartta</strong>; gün seçimi ve yenileme de orada.
            </p>
          ) : null}
        </div>
        {magazaDepoUstSekme === 'katalog-sube-stok' && (
          <div className="card" style={{ marginTop: 14, padding: '18px 20px', borderLeft: '4px solid #5b8fd8' }}>
            {magazaDepoOzetYukleniyor && (
              <div className="loading" style={{ padding: 16, fontSize: 12 }}><div className="spinner" />Katalog stokları yükleniyor…</div>
            )}
            {!magazaDepoOzetYukleniyor && !magazaDepoOzet && (
              <p style={{ fontSize: 12, color: 'var(--text3)' }}>Veri alınamadı.</p>
            )}
            {!magazaDepoOzetYukleniyor && magazaDepoOzet && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    Gün penceresi
                    <select
                      className="input"
                      style={{ width: 90, padding: '4px 8px', fontSize: 12 }}
                      value={magazaDepoOzetGun}
                      onChange={(e) => setMagazaDepoOzetGun(Math.max(1, Math.min(366, Number(e.target.value) || 30)))}
                    >
                      {[7, 14, 30, 45, 90].map((g) => (
                        <option key={g} value={g}>{g} gün</option>
                      ))}
                    </select>
                  </label>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {magazaDepoOzet.tarih_baslangic} → {magazaDepoOzet.tarih_bitis}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => magazaDepoTamYenile()}>
                    Şube stoklarını da yenile
                  </button>
                </div>
                <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 800 }}>Sipariş kataloğu — şube depo adetleri</h3>
                <p style={{ margin: '0 0 14px', fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                  Yalnızca <code style={{ fontSize: 10 }}>siparis_urun</code> içinde aktif olan kalemler.
                  Kategori altında ürün satırları; her sütunda ilgili şubenin deposundaki mevcut adet (yoksa 0).
                </p>
                {(() => {
                  const subeRows = Array.isArray(magazaDepoOzet.subeler) ? magazaDepoOzet.subeler : [];
                  const katalogListe = Array.isArray(magazaDepoOzet.urunler_katalog_aktif)
                    ? magazaDepoOzet.urunler_katalog_aktif
                    : [];
                  if (katalogListe.length === 0) {
                    return (
                      <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
                        Aktif katalog ürünü veya veri bulunamadı.
                      </p>
                    );
                  }
                  const grup = {};
                  for (const u of katalogListe) {
                    const kat = String(u.kategori_ad || u.kategori_kod || 'Diğer').trim() || 'Diğer';
                    if (!grup[kat]) grup[kat] = [];
                    grup[kat].push(u);
                  }
                  const katKeys = Object.keys(grup).sort((a, b) => a.localeCompare(b, 'tr'));
                  const subeCols = subeRows;
                  return (
                    <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, maxHeight: 'min(560px, 70vh)' }}>
                      <table className="table" style={{ fontSize: 10, margin: 0, minWidth: Math.max(360, 120 + subeCols.length * 72) }}>
                        <thead>
                          <tr>
                            <th style={{ minWidth: 160, position: 'sticky', left: 0, background: 'var(--bg)', zIndex: 1, boxShadow: '1px 0 0 var(--border)' }}>
                              Ürün
                            </th>
                            {subeCols.map((s) => (
                              <th key={`kk2-sub-h-${s.id}`} style={{ textAlign: 'right', whiteSpace: 'nowrap', minWidth: 64 }}>
                                {s.ad || s.id}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {katKeys.map((kat) => (
                            <Fragment key={kat}>
                              <tr>
                                <td
                                  colSpan={1 + subeCols.length}
                                  style={{
                                    fontWeight: 800,
                                    fontSize: 11,
                                    background: 'var(--bg2)',
                                    borderTop: '1px solid var(--border)',
                                    paddingTop: 8,
                                    paddingBottom: 4,
                                  }}
                                >
                                  {kat}
                                </td>
                              </tr>
                              {grup[kat].map((u) => (
                                <tr key={`kk2-u-${u.kalem_kodu}`}>
                                  <td
                                    style={{
                                      position: 'sticky',
                                      left: 0,
                                      background: 'var(--bg)',
                                      zIndex: 1,
                                      boxShadow: '1px 0 0 var(--border)',
                                      verticalAlign: 'top',
                                    }}
                                  >
                                    <div style={{ fontWeight: 600 }}>{u.kalem_adi || u.kalem_kodu}</div>
                                    <div className="mono" style={{ color: 'var(--text3)', fontSize: 9 }}>{u.kalem_kodu}</div>
                                  </td>
                                  {subeCols.map((s) => {
                                    const sid = String(s.id);
                                    const mevcut = u.subeler?.[sid]?.mevcut ?? u.subeler?.[Number(s.id)]?.mevcut ?? 0;
                                    return (
                                      <td
                                        key={`kk2-c-${u.kalem_kodu}-${sid}`}
                                        style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', verticalAlign: 'middle' }}
                                      >
                                        {mevcut}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}
      </>
      )}

      {aktifSekme === 'metrics' && (
        yukleniyor && !mPersonelVerimlilik && !mSubeOperasyonKalite && !mFinansOzet && !mStokTedarik
          ? <div className="loading"><div className="spinner" />Metrik veriler yükleniyor…</div>
          : (
          <>
            {opsIcBolum === 'personel' && (
            <div className="card">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Personel verimlilik</h3>
              {mPersonelVerimlilik ? (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Açılış sapma ort.: <strong>{metricNum(mPersonelVerimlilik.acilis_sapma_ort_dk, 2)} dk</strong><br />
                  Kontrol cevap ort.: <strong>{metricNum(mPersonelVerimlilik.kontrol_cevap_ort_dk, 2)} dk</strong><br />
                  Kasa fark frekansı: <strong>{metricNum(mPersonelVerimlilik.kasa_fark_frekans, 2)}%</strong>
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--text3)' }}>Veri yüklenemedi veya yeterli kayıt yok.</div>}
            </div>
            )}
            {opsIcBolum === 'sube' && (
            <div className="card">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Şube operasyon kalite</h3>
              {mSubeOperasyonKalite ? (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Vardiya eksik oranı: <strong>{metricNum(mSubeOperasyonKalite.vardiya_eksik_oran, 2)}%</strong><br />
                  Not/gün ort.: <strong>{metricNum(mSubeOperasyonKalite.not_gonderim_gunluk_ort, 2)}</strong><br />
                  Sipariş çevrim (gün): <strong>{metricNum(mSubeOperasyonKalite.siparis_cevrim_sure_gun, 2)}</strong>
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--text3)' }}>Veri yüklenemedi veya yeterli kayıt yok.</div>}
            </div>
            )}
            {opsIcBolum === 'finans' && (
            <div className="card">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Finans özet</h3>
              {mFinansOzet ? (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Ciro / gider oranı: <strong>{metricNum(mFinansOzet.ciro_gider_orani_ozet, 3)}</strong><br />
                  Kart faiz yükü: <strong>{metricNum(mFinansOzet.kart_faiz_yuku_orani, 3)}</strong><br />
                  POS kaynaklı yanan para: <strong>{metricNum(mFinansOzet.pos_yanan_para_orani, 3)}</strong><br />
                  Toplam kart maliyeti: <strong>{metricNum(mFinansOzet.toplam_kart_maliyeti_orani, 3)}</strong><br />
                  Nakit akış doğruluğu: <strong>{metricText(mFinansOzet.nakit_akis_tahmin_dogrulugu)}</strong>
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--text3)' }}>Veri yüklenemedi veya yeterli kayıt yok.</div>}
            </div>
            )}
            {opsIcBolum === 'stok' && (
            <div className="card">
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Stok & tedarik</h3>
              {mStokTedarik ? (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Bardak kullanım/gün: <strong>{metricNum(mStokTedarik.gunluk_bardak_kullanim, 2)}</strong><br />
                  Depo bekletme (gün): <strong>{metricNum(mStokTedarik.depo_bekletme_sure_gun, 2)}</strong><br />
                  Açıklanamayan eksilme: <strong>{metricNum(mStokTedarik.aciklanamayan_stok_eksilmesi, 2)}</strong>
                </div>
              ) : <div style={{ fontSize: 12, color: 'var(--text3)' }}>Veri yüklenemedi veya yeterli kayıt yok.</div>}
            </div>
            )}
          </>
        )
      )}

      {aktifSekme === 'kontrol' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge badge-red">Kritik: {Number(kontrolData?.kritik_toplam || 0)}</span>
            <span className="badge badge-yellow">Uyarı: {Number(kontrolData?.uyari_toplam || 0)}</span>
            <span className="badge badge-gray">Şube: {Number(kontrolData?.sube_sayisi || 0)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
            {(kontrolData?.subeler || []).map((s) => {
              const kritik = Number(s?.kritik_adet || 0);
              const uyari = Number(s?.uyari_adet || 0);
              const temiz = !!s?.temiz;
              const borderColor = kritik > 0 ? 'var(--red)' : uyari > 0 ? 'var(--yellow)' : 'var(--green)';
              return (
                <button
                  key={s.sube_id}
                  type="button"
                  className="card"
                  style={{ textAlign: 'left', borderLeft: `4px solid ${borderColor}`, cursor: 'pointer' }}
                  onClick={() => setKontrolDetaySube((p) => (p === s.sube_id ? '' : s.sube_id))}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.sube_adi || s.sube_id}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className={`badge ${temiz ? 'badge-green' : 'badge-gray'}`}>{temiz ? 'Temiz' : 'Kontrol var'}</span>
                    <span className="badge badge-red">Kritik: {kritik}</span>
                    <span className="badge badge-yellow">Uyarı: {uyari}</span>
                  </div>
                  {kontrolDetaySube === s.sube_id && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(s.sonuclar || []).length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>Açık kontrol bulunmuyor.</div>
                      ) : (
                        (s.sonuclar || []).map((k, i) => (
                          <div key={`${k.kontrol}-${i}`} style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                              <span className={`badge ${
                                k.seviye === 'kritik' ? 'badge-red' : k.seviye === 'uyari' ? 'badge-yellow' : 'badge-green'
                              }`}>{k.seviye}</span>
                              <span className="mono" style={{ fontSize: 11 }}>{k.kontrol}</span>
                            </div>
                            <div>{k.mesaj}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {yukleniyor ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : (kontrolData?.subeler || []).length === 0 ? (
            <div className="empty"><p>Kontrol sonucu yok.</p></div>
          ) : null}
        </div>
      )}

      {aktifSekme === 'fis' && (
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Bekleyen fiş kontrolleri ({fisBekleyen.length})
          </h3>
          {yukleniyor && fisBekleyen.length === 0 ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : fisBekleyen.length === 0 ? (
            <div className="empty"><p>Bekleyen fiş kontrolü yok.</p></div>
          ) : (
            <>
            {/* Şube bazlı özet */}
            {fisBekleyen.length > 0 && (() => {
              const subeOzet = {};
              fisBekleyen.forEach(g => {
                const k = g.sube || '';
                if (!subeOzet[k]) subeOzet[k] = { sube_adi: g.sube_adi || k, toplam: 0, kritik: 0, tutar: 0 };
                subeOzet[k].toplam++;
                if (g.oncelik === 'kritik') subeOzet[k].kritik++;
                subeOzet[k].tutar += Number(g.tutar || 0);
              });
              const ozList = Object.values(subeOzet).filter(o => o.toplam > 0).sort((a, b) => b.kritik - a.kritik);
              return (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {ozList.map(o => (
                    <span key={o.sube_adi} style={{
                      padding: '3px 10px', borderRadius: 12, fontSize: 12,
                      background: o.kritik > 0 ? '#fee2e2' : '#f3f4f6',
                      color: o.kritik > 0 ? '#b91c1c' : '#374151',
                      border: `1px solid ${o.kritik > 0 ? '#fca5a5' : '#e5e7eb'}`
                    }}>
                      {o.sube_adi} · {o.toplam} kayıt{o.kritik > 0 ? ` · ${o.kritik} kritik` : ''} · {fmt(o.tutar)}
                    </span>
                  ))}
                </div>
              );
            })()}
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Tarih / SLA</th>
                    <th>Şube</th>
                    <th>Personel</th>
                    <th>Kategori</th>
                    <th>Tutar</th>
                    <th>Açıklama</th>
                    <th>Fiş</th>
                  </tr>
                </thead>
                <tbody>
                  {fisBekleyen.map((g) => (
                    <tr key={g.id} style={{ background: g.oncelik === 'kritik' ? '#fff5f5' : undefined }}>
                      <td className="mono" style={{ fontSize: 11 }}>
                        <div>{g.tarih}</div>
                        {(g.gecikme_gun || 0) > 0 && (
                          <span style={{
                            display: 'inline-block', marginTop: 2,
                            padding: '1px 6px', borderRadius: 8, fontSize: 10,
                            background: g.oncelik === 'kritik' ? '#fee2e2' : '#fef9c3',
                            color: g.oncelik === 'kritik' ? '#b91c1c' : '#92400e',
                          }}>
                            {g.gecikme_gun} gün geçti
                          </span>
                        )}
                      </td>
                      <td>{g.sube_adi || g.sube}</td>
                      <td style={{ fontSize: 12 }}>{g.personel_ad || g.personel_id || '—'}</td>
                      <td style={{ fontSize: 12 }}>{g.kategori}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{fmt(g.tutar || 0)}</td>
                      <td style={{ fontSize: 12, maxWidth: 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {g.aciklama || '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'geldi')}
                          >
                            {fisBusyId === `geldi:${g.id}` ? '…' : 'Geldi ✓'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'gelmedi')}
                          >
                            {fisBusyId === `gelmedi:${g.id}` ? '…' : 'Gelmedi ✗'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'muaf')}
                          >
                            {fisBusyId === `muaf:${g.id}` ? '…' : 'Muaf'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}

      {aktifSekme === 'stok-kayip' && (
        <StokKayipPanel veri={stokKayip} />
      )}

      {aktifSekme === 'personel-davranis' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Personel açılış davranışı (son {personelDavranis?.gun_sayi || 45} gün)
          </h3>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Personel</th>
                  <th>Şube</th>
                  <th>Açılış</th>
                  <th>Kasa Fark</th>
                  <th>Bardak Düşük</th>
                  <th>Vardiya Eksik</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {(personelDavranis?.personel_ozet || []).map((p, i) => (
                  <tr key={`${p.personel_id || p.personel_ad}-${i}`}>
                    <td>{p.personel_ad || p.personel_id || '—'}</td>
                    <td>{p.sube_adi || p.sube_id || '—'}</td>
                    <td className="mono">{p.acilis_sayisi || 0}</td>
                    <td className="mono">{p.acilis_kasa_fark_adet || 0}</td>
                    <td className="mono">{p.bardak_dusuk_toplam || 0}</td>
                    <td className="mono">{p.vardiya_eksik_adet || 0}</td>
                    <td className="mono">{p.davranis_risk_skoru || 0}</td>
                  </tr>
                ))}
                {(personelDavranis?.personel_ozet || []).length === 0 && (
                  <tr><td colSpan={7}><div className="empty"><p>Personel davranış verisi yok</p></div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {aktifSekme === 'guvenlik-alarmlar' && (
        <div>
          {(() => {
            const alarmliKartlar = kartlar.filter((k) => k.bayraklar?.guvenlik_alarm);
            if (!alarmliKartlar.length) {
              return (
                <div className="empty">
                  <p>Aktif güvenlik alarmı yok ✓</p>
                  <p style={{ fontSize: 12, color: 'var(--text3)' }}>
                    Tüm şubelerde PIN kilit/hatalı deneme eşiğin altında.
                  </p>
                </div>
              );
            }
            const pencere = alarmliKartlar[0]?.guvenlik?.pencere_dk || 15;
            return (
              <>
                <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text3)' }}>
                  {alarmliKartlar.length} şubede aktif alarm · Son {pencere} dk penceresi
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {alarmliKartlar.map((k) => {
                    const g = k.guvenlik || {};
                    const ad = g.alarm_durum;
                    const sid = k.sube_id;
                    const islemYap = async (tur) => {
                      try {
                        await api(`/ops/guvenlik-alarmlar/${encodeURIComponent(sid)}/${tur}`, { method: 'POST', body: {} });
                        yukle(filtre);
                      } catch (e) { window.alert(e.message || 'İşlem başarısız'); }
                    };
                    return (
                      <div key={sid} style={{
                        padding: '12px 16px', borderRadius: 8,
                        border: `1px solid ${g.seviye === 'kritik' ? 'rgba(190,24,93,0.4)' : 'rgba(245,158,11,0.35)'}`,
                        background: g.seviye === 'kritik' ? 'rgba(190,24,93,0.06)' : 'rgba(245,158,11,0.05)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                          <strong style={{ fontSize: 14 }}>{k.sube_adi || sid}</strong>
                          <span className={`badge ${g.seviye === 'kritik' ? 'badge-red' : 'badge-yellow'}`}>
                            {g.seviye === 'kritik' ? 'KRİTİK' : 'UYARI'}
                          </span>
                          {ad?.durum === 'susturuldu' && (
                            <span className="badge" style={{ background: 'rgba(128,128,128,0.15)', color: 'var(--text3)', fontSize: 11 }}>
                              Susturuldu{ad.sustur_bitis_ts ? ` → ${String(ad.sustur_bitis_ts).slice(11, 16)}` : ''}
                            </span>
                          )}
                        </div>
                        {g.mesaj && (
                          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>{g.mesaj}</div>
                        )}
                        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text3)', marginBottom: 10, flexWrap: 'wrap' }}>
                          <span>PIN Kilit: <strong style={{ color: (g.pin_kilit_adet || 0) > 0 ? 'var(--red)' : 'inherit' }}>{g.pin_kilit_adet || 0}</strong></span>
                          <span>Hatalı Deneme: <strong style={{ color: (g.pin_hatali_adet || 0) > 0 ? 'var(--yellow)' : 'inherit' }}>{g.pin_hatali_adet || 0}</strong></span>
                          <span>Kilitliyken Deneme: <strong>{g.pin_kilitte_deneme_adet || 0}</strong></span>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => islemYap('okundu')}>
                            ✓ Okundu
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => islemYap('sustur')}>
                            🔇 Sustur (2 saat)
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {aktifSekme === 'defter' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Saat</th>
                <th>Şube</th>
                <th>Etiket</th>
                <th>Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {defter.length === 0 ? (
                <tr><td colSpan={5}><div className="empty"><p>Seçilen filtrede defter kaydı yok</p></div></td></tr>
              ) : defter.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{(r.tarih || '').substring(0, 10)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{(r.olay_ts || '').substring(11, 19)}</td>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                  <td><span className="badge badge-blue">{r.etiket || '—'}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{(r.aciklama || '').slice(0, 130)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Sayım: Açılış Sayımları ── */}
      {aktifSekme === 'sayim' && opsIcBolum === 'acilis' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th rowSpan={2}>Tarih</th>
                <th rowSpan={2}>Saat</th>
                <th rowSpan={2}>Şube</th>
                <th rowSpan={2}>Personel</th>
                <th colSpan={3} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>Bardaklar</th>
                <th colSpan={6} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>Ürünler</th>
              </tr>
              <tr>
                {['Küçük','Büyük','Plastik','Su','Süt','Redbull','Soda','Cookie','Pasta'].map(l => (
                  <th key={l} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sayimlar.length === 0 ? (
                <tr><td colSpan={13}><div className="empty"><p>Seçilen filtrede açılış sayımı yok</p></div></td></tr>
              ) : sayimlar.map(r => {
                const s = r.stok_sayim || {};
                const cell = (val) => <td className="mono" style={{ fontSize: 12, textAlign: 'center' }}>{val || 0}</td>;
                return (
                  <tr key={r.event_id}>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.tarih || '').substring(0, 10)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.cevap_ts || '').substring(11, 19) || (r.bildirim_saati || '')}</td>
                    <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                    <td style={{ fontSize: 12 }}>{r.personel_ad || r.personel_id || '—'}</td>
                    {cell(s.bardak_kucuk)}{cell(s.bardak_buyuk)}{cell(s.bardak_plastik)}
                    {cell(s.su_adet)}{cell(s.sut_litre)}{cell(s.redbull_adet)}{cell(s.soda_adet)}{cell(s.cookie_adet)}{cell(s.pasta_adet)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Sayım: Bar Günlük Özet ── */}
      {aktifSekme === 'sayim' && opsIcBolum === 'bar-ozet' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
            Formül: <strong>Satılan = Açılış + Ürün Aç − Kapanış</strong> · Negatif satır = fire/eksiklik.
            Kapanış yapılmamış günler açık görünür.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={barOzetTarih}
                onChange={(e) => {
                  const val = e.target.value || bugunIsoTarih();
                  setBarOzetTarih(val);
                  const ay = val.slice(0, 7);
                  if (ay && ay !== ayFiltre) {
                    setYukleniyor(true);
                    setAyFiltre(ay);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => setBarOzetTarih(bugunIsoTarih())}
            >
              Bugün
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {barOzetTarih} · {barOzetGorunenSatirlar.length} şube kaydı
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setBarOzetSeciliSubeKey('all')}
              style={{
                border: barOzetSeciliSubeKey === 'all' ? '1px solid #2db573' : '1px solid var(--border)',
                background: barOzetSeciliSubeKey === 'all' ? 'rgba(45, 181, 115, 0.2)' : 'var(--bg2)',
                color: barOzetSeciliSubeKey === 'all' ? '#86efac' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {barOzetSubeSekmeleri.map((s) => (
              <button
                key={`bar-sekme-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setBarOzetSeciliSubeKey(s.key)}
                style={{
                  border: barOzetSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: barOzetSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: barOzetSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>
          {barOzetGorunenSatirlar.length === 0 ? (
            <div className="empty"><p>Seçilen filtrede bar özeti yok</p></div>
          ) : barOzetGorunenSatirlar.map((r) => {
            const keys = ['bardak_kucuk','bardak_buyuk','bardak_plastik','karton_bardak','su_adet','sut_litre','soda_adet','redbull_adet','cookie_adet','pasta_adet','surup_adet','kahve_paket','kapak_adet','pecete_paket','diger_sarf'];
            const labels = { bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', bardak_plastik:'Plastik', karton_bardak:'Karton Bardak', su_adet:'Su', sut_litre:'Süt', soda_adet:'Soda', redbull_adet:'Redbull', cookie_adet:'Cookie', pasta_adet:'Pasta', surup_adet:'Şurup', kahve_paket:'Kahve Pkt', kapak_adet:'Kapak', pecete_paket:'Peçete', diger_sarf:'Diğer' };
            const hasFark = r.fark_var;
            const kapanisYok = !r.kapanis_var;
            return (
              <div key={`${r.sube_id}-${r.tarih}`} className="card" style={{
                borderLeft: `4px solid ${hasFark ? 'var(--red)' : kapanisYok ? 'var(--yellow)' : 'var(--green)'}`,
                padding: '14px 16px',
              }}>
                {/* Başlık */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{r.sube_adi}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{r.tarih}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {hasFark && <span className="badge badge-red">Fark var</span>}
                    {kapanisYok && <span className="badge badge-yellow">Kapanış yok</span>}
                    {!hasFark && !kapanisYok && <span className="badge badge-green">Normal</span>}
                  </div>
                </div>
                {/* Tablo */}
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--bg2)' }}>
                        <th style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, fontSize: 11 }}>Ürün</th>
                        <th style={{ padding: '5px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600, fontSize: 11 }}>Açılış</th>
                        <th style={{ padding: '5px 8px', textAlign: 'center', color: '#86efac', fontWeight: 600, fontSize: 11 }}>Ürün Aç</th>
                        <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600, fontSize: 11 }}>Kapanış</th>
                        <th style={{ padding: '5px 8px', textAlign: 'center', color: '#e2e8f0', fontWeight: 700, fontSize: 11 }}>Satılan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k) => {
                        const ac   = r.acilis?.[k]  ?? 0;
                        const ua   = r.urun_ac?.[k] ?? 0;
                        const kap  = r.kapanis?.[k] ?? 0;
                        const sat  = r.satilan?.[k] ?? 0;
                        const neg  = sat < 0;
                        // Hiç hareket yoksa satırı gizle
                        if (ac === 0 && ua === 0 && kap === 0) return null;
                        return (
                          <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 8px', color: 'var(--text2)' }}>{labels[k] || k}</td>
                            <td className="mono" style={{ padding: '5px 8px', textAlign: 'center' }}>{ac}</td>
                            <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: ua > 0 ? '#86efac' : 'var(--text3)' }}>{ua > 0 ? `+${ua}` : ua}</td>
                            <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: kap > 0 ? '#fbbf24' : 'var(--text3)' }}>{kap > 0 ? `-${kap}` : '—'}</td>
                            <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, color: neg ? 'var(--red)' : sat > 0 ? '#86efac' : 'var(--text3)' }}>
                              {neg ? sat : sat}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {aktifSekme === 'urun-ac' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--text3)',
              opacity: 0.88,
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
            }}
          >
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Ürün Aç nedir?</strong>{' '}
            Şubede personelin <strong style={{ color: 'var(--text2)' }}>ürün / sarf açtığı</strong> her işlem, operasyon defterine{' '}
            <strong style={{ color: 'var(--text2)' }}>URUN_AC</strong> kaydı olarak düşer (hangi şube, hangi saat, kim, hangi kalemler ve adetler).
            Bu ekran o kayıtları <strong style={{ color: 'var(--text2)' }}>gün bazında</strong> özetler; merkez yoğunluğu ve şube bazlı tekrarları izlemek içindir.
            Liste <strong style={{ color: 'var(--text2)' }}>defter satırının ``tarih``</strong> alanına göre filtrelenir (takvim günü); gece 00:00–02:00 bandındaki işlemler bazen ertesi takvim gününe yazılabilir — yoğun analizde iş günü ile çapraz kontrol edin.
            API güvenlik için günde en fazla <strong style={{ color: 'var(--text2)' }}>80 satır</strong> döndürür — yoğun günlerde satır sayısı 80'e dayanıyorsa aşağıdaki liste eksik kalabilir, o gün satırı sarı ile uyarılır.
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
              Son 7 gün — günlük özet {urunAcHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500 }}>(yükleniyor…)</span> : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {urunAcHaftaYukleniyor && urunAcHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (urunAcHaftaSatirlari.length ? urunAcHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                toplam_islem: 0,
                toplam_adet: 0,
                listeSiniri: false,
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const siniri = !!s.listeSiniri;
                const hareket = Number(s.toplam_islem || 0) > 0;
                return (
                  <button
                    key={`urun-ac-hafta-${s.tarih}`}
                    type="button"
                    onClick={async () => {
                      setUrunAcAramaTarih(s.tarih);
                      setUrunAcAramaYukleniyor(true);
                      try {
                        const data = await urunAcGunYukle(s.tarih);
                        setUrunAcAramaSonuc(data);
                        setUrunAcSeciliSubeKey('all');
                      } catch (e) {
                        toast(e.message || 'Ürün aç akışı yüklenemedi');
                      } finally {
                        setUrunAcAramaYukleniyor(false);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: siniri
                        ? '1px solid rgba(234, 179, 8, 0.65)'
                        : !hareket
                          ? '1px solid var(--border)'
                          : '1px solid rgba(45, 181, 115, 0.45)',
                      background: siniri
                        ? 'rgba(234, 179, 8, 0.12)'
                        : !hareket
                          ? 'rgba(148, 163, 184, 0.06)'
                          : 'rgba(45, 181, 115, 0.08)',
                      boxShadow: siniri ? '0 0 0 1px rgba(234, 179, 8, 0.2)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 12, color: hareket || siniri ? 'var(--text)' : 'var(--text3)' }}>
                      <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                      {s.tarih === bugunStr ? (
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span>
                      ) : null}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {siniri ? (
                        <span className="badge badge-yellow" style={{ fontWeight: 700 }}>80 satır limiti — eksik olabilir</span>
                      ) : null}
                      {!hareket && !siniri ? (
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500 }}>Kayıt yok</span>
                      ) : (
                        <>
                          <span className="badge badge-green" style={{ fontWeight: 700 }}>
                            {s.toplam_islem} işlem · {s.toplam_adet} adet
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Detay ↓</span>
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text3)', opacity: 0.85, margin: '8px 0 0' }}>
              Satıra tıklayınca aşağıdaki detay alanı o güne yüklenir. Yeşil: o gün en az bir URUN_AC kaydı var. Sarı çerçeve: tam 80 işlem satırı — liste kesilmiş olabilir, gerekirse veritabanı / rapor tarafından doğrulayın.
            </p>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginTop: 4 }}>Tarih seçerek detay</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={urunAcAramaTarih}
                onChange={(e) => setUrunAcAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => urunAcAramaYap()}
            >
              {urunAcAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {urunAcAramaSonuc?.tarih || urunAcAramaTarih} · {urunAcAramaSonuc?.toplam_islem || 0} işlem · {urunAcAramaSonuc?.toplam_adet || 0} adet
              {urunAcAramaZirveSaat ? ` · zirve ${urunAcAramaZirveSaat.saat} (${urunAcAramaZirveSaat.adet})` : ''}
            </div>
          </div>
          {(urunAcAramaSonuc?.kayitlar || []).length === 0 ? (
            <div className="empty"><p>Bu tarihte ürün aç kaydı yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflow: 'auto' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setUrunAcSeciliSubeKey('all')}
                  style={{
                    border: urunAcSeciliSubeKey === 'all' ? '1px solid #2db573' : '1px solid var(--border)',
                    background: urunAcSeciliSubeKey === 'all' ? 'rgba(45, 181, 115, 0.2)' : 'var(--bg2)',
                    color: urunAcSeciliSubeKey === 'all' ? '#86efac' : 'var(--text2)',
                    padding: '6px 10px',
                    fontWeight: 700,
                  }}
                >
                  Tümü · {urunAcAramaSonuc?.toplam_islem || 0} işlem / {urunAcAramaSonuc?.toplam_adet || 0} adet
                </button>
                {urunAcSubeBloklari.map((g) => (
                  <button
                    key={`tab-${g.key}`}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setUrunAcSeciliSubeKey(g.key)}
                    style={{
                      border: urunAcSeciliSubeKey === g.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                      background: urunAcSeciliSubeKey === g.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                      color: urunAcSeciliSubeKey === g.key ? '#e6f7ff' : 'var(--text2)',
                      padding: '6px 10px',
                      fontWeight: 700,
                    }}
                  >
                    {g.baslik} · {g.toplamIslem} / {g.toplamAdet}
                  </button>
                ))}
              </div>
              {urunAcGorunenSubeBloklari.map((g) => (
                <section key={g.key} className="card" style={{ padding: '10px 12px', borderLeft: '4px solid #2db573' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{g.baslik}</div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>
                      {g.toplamIslem} işlem · {g.toplamAdet} adet
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {g.kayitlar.map((k, gi) => (
                      <div key={k.id || `${g.key}-${k.saat || '00:00'}-${gi}`} className="card" style={{ padding: '10px 12px', border: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ fontSize: 13 }}>
                            <strong>{k.personel_ad || '—'}</strong>
                          </div>
                          <div className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>
                            {(k.saat || '—').slice(0, 5)} · {k.adet_toplam || 0} adet
                          </div>
                        </div>
                        {(k.urunler || []).length > 0 && (
                          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {(k.urunler || []).map((u, ui) => (
                              <span
                                key={ui}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '4px 8px',
                                  borderRadius: 999,
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: '#e6f7ff',
                                  background: 'rgba(74, 158, 255, 0.2)',
                                  border: '1px solid rgba(74, 158, 255, 0.45)',
                                  boxShadow: '0 0 0 1px rgba(74, 158, 255, 0.15) inset',
                                }}
                              >
                                {u.urun_ad}: {u.adet}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'kullanilan-urunler' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--text3)',
              opacity: 0.88,
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
            }}
          >
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Ne gösterilir?</strong>{' '}
            Kaynak <strong style={{ color: 'var(--text2)' }}>/ops/bar-ozet</strong>: her şube için{' '}
            <strong style={{ color: 'var(--text2)' }}>Satılan ≈ Açılış sayımı + gün içi Ürün Aç − Kapanış sayımı</strong> (bardak, su, soda, redbull, pasta toplamı vb.).
            Kapanış girilmemiş günlerde satılan sütunu eksik kalabilir. Tarih, operasyon <strong style={{ color: 'var(--text2)' }}>ACILIS/KAPANIS</strong> olayının takvim günüdür; gece yarısı sonrası hareketlerde «Kapanış Takip» ile aynı iş günü seçimine dikkat edin.
            Haftalık bölümde günler <strong style={{ color: 'var(--text2)' }}>bugünden geriye</strong> sıralanır; şubeler <strong style={{ color: 'var(--text2)' }}>ada göre (A–Z)</strong> listelenir.
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
              Son 7 gün (gün → şube sıralı) {kullanilanHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500 }}>(yükleniyor…)</span> : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {kullanilanHaftaYukleniyor && kullanilanHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (kullanilanHaftaSatirlari.length ? kullanilanHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                toplam_islem: 0,
                toplam_adet: 0,
                subeOzetleri: [],
              }))).map((gun) => {
                const bugunStr = bugunIsoTarih();
                const dolu = (gun.subeOzetleri || []).length > 0;
                return (
                  <div
                    key={`kul-hafta-${gun.tarih}`}
                    className="card"
                    style={{
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      background: dolu ? 'var(--bg2)' : 'var(--bg)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        setKullanilanAramaTarih(gun.tarih);
                        setKullanilanAramaYukleniyor(true);
                        try {
                          const data = await kullanilanGunYukle(gun.tarih);
                          setKullanilanAramaSonuc(data);
                          setKullanilanSeciliSubeKey('all');
                        } catch (e) {
                          toast(e.message || 'Kullanılan ürünler yüklenemedi');
                        } finally {
                          setKullanilanAramaYukleniyor(false);
                        }
                      }}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 8,
                        width: '100%',
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        marginBottom: dolu ? 8 : 0,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                        <span className="mono">{gun.tarih}</span>
                        {gun.tarih === bugunStr ? (
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span>
                        ) : null}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {gun.toplam_islem || 0} şube · {gun.toplam_adet || 0} adet · <span style={{ color: '#f59e0b' }}>Detay ↓</span>
                      </span>
                    </button>
                    {dolu ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 4, borderLeft: '2px solid rgba(245, 158, 11, 0.35)' }}>
                        {(gun.subeOzetleri || []).map((z) => (
                          <div
                            key={`${gun.tarih}-${z.sube_id || z.sube_adi}`}
                            style={{
                              fontSize: 12,
                              padding: '4px 0 4px 10px',
                              color: 'var(--text2)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              gap: 10,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{z.sube_adi || z.sube_id}</span>
                            <span className="mono" style={{ color: 'var(--text3)' }}>{z.toplam_adet} adet</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--text3)', paddingLeft: 4 }}>Bu gün için özet satırı yok</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginTop: 4 }}>Tarih seçerek detay</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={kullanilanAramaTarih}
                onChange={(e) => setKullanilanAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => kullanilanAramaYap()}
            >
              {kullanilanAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {kullanilanAramaSonuc?.tarih || kullanilanAramaTarih} · {kullanilanAramaSonuc?.toplam_islem || 0} şube · {kullanilanAramaSonuc?.toplam_adet || 0} adet
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setKullanilanSeciliSubeKey('all')}
              style={{
                border: kullanilanSeciliSubeKey === 'all' ? '1px solid #2db573' : '1px solid var(--border)',
                background: kullanilanSeciliSubeKey === 'all' ? 'rgba(45, 181, 115, 0.2)' : 'var(--bg2)',
                color: kullanilanSeciliSubeKey === 'all' ? '#86efac' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {kullanilanSubeSekmeleri.map((s) => (
              <button
                key={`kul-sekme-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setKullanilanSeciliSubeKey(s.key)}
                style={{
                  border: kullanilanSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: kullanilanSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: kullanilanSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>
          {kullanilanGorunenSatirlarSirali.length === 0 ? (
            <div className="empty"><p>Bu tarihte kullanılan ürün kaydı yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflow: 'auto' }}>
              {kullanilanGorunenSatirlarSirali.map((r) => {
                const keys = kullanilanRowKeys(r);
                const labels = KULLANILAN_LABEL;
                const hasFark = r.fark_var;
                const kapanisYok = !r.kapanis_var;
                return (
                  <div key={`${r.sube_id}-${r.tarih}`} className="card" style={{
                    borderLeft: `4px solid ${hasFark ? 'var(--red)' : kapanisYok ? 'var(--yellow)' : 'var(--green)'}`,
                    padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.sube_adi}</span>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{r.tarih}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {hasFark && <span className="badge badge-red">Fark var</span>}
                        {kapanisYok && <span className="badge badge-yellow">Kapanış yok</span>}
                        {!hasFark && !kapanisYok && <span className="badge badge-green">Normal</span>}
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)' }}>
                            <th style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, fontSize: 11 }}>Ürün</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600, fontSize: 11 }}>Açılış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#86efac', fontWeight: 600, fontSize: 11 }}>Ürün Aç</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600, fontSize: 11 }}>Kapanış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#e2e8f0', fontWeight: 700, fontSize: 11 }}>Satılan</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((k) => {
                            const ac = r.acilis?.[k] ?? 0;
                            const ua = r.urun_ac?.[k] ?? 0;
                            const kap = r.kapanis?.[k] ?? 0;
                            const sat = r.satilan?.[k] ?? 0;
                            const neg = sat < 0;
                            if (ac === 0 && ua === 0 && kap === 0) return null;
                            return (
                              <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '5px 8px', color: 'var(--text2)' }}>{labels[k] || k}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center' }}>{ac}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: ua > 0 ? '#86efac' : 'var(--text3)' }}>{ua > 0 ? `+${ua}` : ua}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: kap > 0 ? '#fbbf24' : 'var(--text3)' }}>{kap > 0 ? `-${kap}` : '—'}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, color: neg ? 'var(--red)' : sat > 0 ? '#86efac' : 'var(--text3)' }}>
                                  {sat}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'kapanis-takip' && (() => {
        const kt = kapanisTakip;
        const tumSatirlar = Array.isArray(kt?.satirlar) ? kt.satirlar : [];

        // Öncelik sırası: 0=kapanmadı (en acil), 1=ciro yok, 2=onay bekliyor, 3=tamam
        const _oncelik = (r) => {
          if (!r.kapanis_tamam) return 0;
          if (!r.ciro_onaylandi && !r.taslak_var) return 1;
          if (r.taslak_var && r.taslak_durum === 'bekliyor') return 2;
          return 3;
        };
        const satirlar = [...tumSatirlar].sort((a, b) =>
          _oncelik(a) - _oncelik(b) || (a.sube_adi || '').localeCompare(b.sube_adi || '', 'tr')
        );

        const eksikKapanisSayisi  = satirlar.filter(r => !r.kapanis_tamam).length;
        const eksikCiroSayisi     = satirlar.filter(r => !r.ciro_onaylandi && !r.taslak_var).length;
        const bekleyenSayisi      = satirlar.filter(r => r.taslak_var && r.taslak_durum === 'bekliyor').length;
        const tamamSayisi         = satirlar.filter(r => r.ciro_onaylandi).length;

        const topNakit  = satirlar.reduce((s, r) => s + (r.nakit  || 0), 0);
        const topPos    = satirlar.reduce((s, r) => s + (r.pos    || 0), 0);
        const topOnline = satirlar.reduce((s, r) => s + (r.online || 0), 0);
        const topCiro   = satirlar.reduce((s, r) => s + (r.ciro_tutar > 0 ? r.ciro_tutar : r.nakit + r.pos + r.online), 0);
        const topSabah  = satirlar.reduce((s, r) => s + (Number(r.sabah_kasa_tl) || 0), 0);
        const topTeslim = satirlar.reduce((s, r) => s + (Number(r.teslim_kasa_tl) || 0), 0);
        const topDevir  = satirlar.reduce((s, r) => s + (Number(r.devir) || 0), 0);
        const topAgider = satirlar.reduce((s, r) => s + (Number(r.anlik_gider_nakit_tl) || 0), 0);

        const fmt  = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });
        const fmtFark = (v) => {
          if (v == null || Number.isNaN(Number(v))) return null;
          const x = Number(v);
          const s = x.toLocaleString('tr-TR', { maximumFractionDigits: 0 });
          return x > 0 ? `+${s}` : s;
        };
        /** Nakit Δ: açık (+) kırmızı, fazla (−) yeşil, dengede (≈0) nötr — ekstra renk yok. */
        const farkStil = (v) => {
          if (v == null || Number.isNaN(Number(v))) return { color: 'var(--text3)', fontWeight: 600 };
          const x = Number(v);
          if (Math.abs(x) <= 0.5) return { color: 'var(--text2)', fontWeight: 600 };
          if (x > 0.5) return { color: '#e85d5d', fontWeight: 800 };
          return { color: '#22c55e', fontWeight: 800 };
        };
        /** Nakit Δ: yalnızca açılış+kapanış tamam ise tutar; değilse açık uyarı metni (şube paneli değil, merkez tablosu). */
        const nakitDeltaHucre = (r) => {
          const ac = !!r.acildi;
          const kap = !!r.kapanis_tamam;
          const fark = r.nakit_kasa_fark_tl;
          const tam = r.nakit_denkleme_tam === true || (ac && kap);
          if (tam && fark != null && !Number.isNaN(Number(fark))) {
            const fs = fmtFark(fark);
            if (fs != null) {
              const fv = Number(fark);
              const buyuk = Math.abs(fv) > 0.5;
              /** İş kuralı (API): + → kasa açığı, − → kasa fazlası (denge formülü fazla/eksik nakit). */
              const etiket = !buyuk
                ? 'Dengede'
                : fv > 0
                  ? 'Kasa açığı'
                  : 'Kasa fazlası';
              const title =
                'Nakit denge: sabah kasa + ciro nakit − teslim − devir − nakit anlık gider. '
                + (buyuk
                  ? (fv > 0
                    ? 'Pozitif: denkleme göre kasada tutması gerekenden az nakit (açık).'
                    : 'Negatif: denkleme göre kasada tutması gerekenden fazla nakit (fazla).')
                  : 'Mutlak değer küçük; pratikte dengeli.');
              const etiketRenk = !buyuk ? 'var(--text3)' : fv > 0 ? '#e85d5d' : '#22c55e';
              return (
                <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }} title={title}>
                  <span style={farkStil(fark)}>{fs} ₺</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: etiketRenk, whiteSpace: 'nowrap' }}>{etiket}</span>
                </span>
              );
            }
          }
          const st = { fontSize: 11, fontWeight: 700, lineHeight: 1.35, textAlign: 'right', color: '#e85d5d' };
          if (!ac && !kap) {
            return <span style={st} title="Nakit denge için açılış ve kapanış tamamlanmalı">Açılış ve kapanış yapılmadı</span>;
          }
          if (!ac) {
            return <span style={st} title="Sabah kasa sayımı yok">Açılış yapılmadı</span>;
          }
          if (!kap) {
            return <span style={st} title="Teslim/devir için kapanış tamamlanmalı">Kapanış yapılmadı</span>;
          }
          return <span style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Δ hesaplanamadı</span>;
        };
        const eksikUyariStil = { fontSize: 11, fontWeight: 700, color: '#e85d5d', lineHeight: 1.3, textAlign: 'right' };
        const saat = (ts) => {
          if (!ts) return null;
          try { return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
          catch { return null; }
        };
        const bugunMu = kapanisTakipTarih === isGunuIsoIstanbul();

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ── Üst bar: tarih + yenile + son güncelleme ── */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>Tarih</span>
                <input
                  type="date"
                  value={kapanisTakipTarih}
                  onChange={(e) => setKapanisTakipTarih(e.target.value)}
                  style={{ fontSize: 13, padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }}
                />
              </div>
              <button
                onClick={() => yukleKapanisTakip(kapanisTakipTarih)}
                disabled={kapanisTakipYukleniyor}
                className="btn btn-sm"
                style={{ height: 32 }}
              >
                {kapanisTakipYukleniyor ? '⏳' : '🔄'} Yenile
              </button>
              {bugunMu && (
                <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>
                  Her 2 dk otomatik güncellenir
                </span>
              )}
              {kapanisTakipSonGuncelleme && (
                <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto', alignSelf: 'center' }}>
                  Son güncelleme: {kapanisTakipSonGuncelleme.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
              Varsayılan tarih <strong>iş günü</strong> (İstanbul'da gece 02:00'ye kadar önceki takvim günü). Kapanış son teslim: ertesi gün{' '}
              {Number(kt?.kapanis_son_teslim_saat) === 2 || kt?.kapanis_son_teslim_saat == null ? '02:00' : `${String(kt?.kapanis_son_teslim_saat)}:00`}.
              {kt?.takvim_tr && kt?.is_gunu_tr && String(kt.takvim_tr) !== String(kt.is_gunu_tr) ? (
                <span> Takvim: <span className="mono">{kt.takvim_tr}</span> · İş günü: <span className="mono">{kt.is_gunu_tr}</span></span>
              ) : null}
            </p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
              <strong>Nakit denge (Δ):</strong> aynı iş günü <em>sabah kasa</em> (açılış sayımı) + <em>ciro nakit</em> (yapılan iş) − <em>teslim</em> − <em>devir</em> (kasada kalan) − <em>onaylı nakit anlık gider</em>.
              Teslim zorunlu değilse satırda 0 görünebilir. Kapanış satırı şube başına <strong>en son tamamlanan KAPANIS</strong> olayından gelir (vardiya + son kapanış ayrımı karışmaz).
              Yalnızca hem açılış hem kapanış tamamlanmış şubelerde Δ tutar gösterilir. Tabloda: <span style={{ color: '#e85d5d' }}>+</span> kasa açığı, <span style={{ color: '#22c55e' }}>−</span> kasa fazlası, ≈0 nötr.
              Adım adım kasa / X uyumsuzluk kayıtları için <strong>Kasa uyumsuzluk</strong> sekmesine bakın.
            </p>

            {/* ── Özet metrik kartları ── */}
            {kt && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                {[
                  { label: 'Kapanış yapan', val: `${kt.kapanis_yapan_adet} / ${kt.sube_sayisi}`, color: eksikKapanisSayisi > 0 ? '#e85d5d' : '#22c55e', bg: eksikKapanisSayisi > 0 ? 'rgba(232,93,93,0.12)' : 'rgba(34,197,94,0.12)', border: eksikKapanisSayisi > 0 ? 'rgba(232,93,93,0.4)' : 'rgba(34,197,94,0.4)' },
                  { label: 'Ciro onaylı',   val: `${tamamSayisi} şube`, color: tamamSayisi === kt.sube_sayisi ? '#22c55e' : '#f59e0b', bg: 'rgba(99,102,241,0.10)', border: 'rgba(99,102,241,0.3)' },
                  { label: 'Onay bekleyen', val: bekleyenSayisi > 0 ? `${bekleyenSayisi} şube` : '—', color: bekleyenSayisi > 0 ? '#fbbf24' : 'var(--text3)', bg: bekleyenSayisi > 0 ? 'rgba(245,158,11,0.10)' : 'var(--bg2)', border: bekleyenSayisi > 0 ? 'rgba(245,158,11,0.35)' : 'var(--border)' },
                  { label: 'Ciro eksik',    val: eksikCiroSayisi > 0 ? `${eksikCiroSayisi} şube` : 'Yok', color: eksikCiroSayisi > 0 ? '#e85d5d' : '#22c55e', bg: eksikCiroSayisi > 0 ? 'rgba(232,93,93,0.10)' : 'rgba(34,197,94,0.07)', border: eksikCiroSayisi > 0 ? 'rgba(232,93,93,0.35)' : 'rgba(34,197,94,0.25)' },
                ].map((m, i) => (
                  <div key={i} style={{ background: m.bg, border: `1px solid ${m.border}`, borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: m.color }}>{m.val}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Yükleniyor / boş durum ── */}
            {kapanisTakipYukleniyor && !kt && (
              <div style={{ textAlign: 'center', padding: 50, color: 'var(--text3)' }}>Yükleniyor...</div>
            )}
            {!kapanisTakipYukleniyor && !kt && (
              <div style={{ textAlign: 'center', padding: 50, color: 'var(--text3)' }}>
                Yenile düğmesine basın veya tarih seçin.
              </div>
            )}
            {kt && satirlar.length === 0 && (
              <div style={{ textAlign: 'center', padding: 50, color: 'var(--text3)' }}>
                Bu tarihte aktif şube kaydı bulunamadı.
              </div>
            )}

            {/* ── Ana tablo ── */}
            {satirlar.length > 0 && (
              <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      {['Şube', 'Kapanış', 'Saat', 'Kapanış Personeli', 'Ciro Durumu', 'Gönderen', 'Nakit', 'POS', 'Online', 'Toplam', 'Sabah kasa', 'Teslim', 'Devir', 'A.gider (N)', 'Nakit Δ (açık / fazla)'].map((h, i) => (
                        <th key={i} style={{ padding: '8px 10px', textAlign: i >= 6 ? 'right' : i >= 1 ? 'center' : 'left', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {satirlar.map((r) => {
                      const onc = _oncelik(r);
                      const rowBg = onc === 0
                        ? 'rgba(232,93,93,0.09)'
                        : onc === 1
                        ? 'rgba(232,93,93,0.05)'
                        : onc === 2
                        ? 'rgba(245,158,11,0.06)'
                        : 'transparent';
                      const toplam = r.ciro_tutar > 0 ? r.ciro_tutar : (r.nakit + r.pos + r.online);
                      const kapanisSaat = saat(r.kapanis_ts);
                      return (
                        <tr key={r.sube_id} style={{ background: rowBg, transition: 'background 0.15s' }}>
                          {/* Şube */}
                          <td style={{ padding: '8px 10px', fontWeight: 700, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                            🏪 {r.sube_adi}
                          </td>
                          {/* Kapanış */}
                          <td style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                            {r.kapanis_tamam
                              ? <span style={{ color: '#22c55e', fontWeight: 700 }}>✅ Kapandı</span>
                              : r.acildi
                              ? <span style={{ color: '#e85d5d', fontWeight: 700 }}>🔴 Kapanmadı</span>
                              : <span style={{ color: 'var(--text3)', fontStyle: 'italic', fontSize: 12 }}>Açılmadı</span>}
                          </td>
                          {/* Saat */}
                          <td style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border)', color: 'var(--text3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {kapanisSaat || '—'}
                          </td>
                          {/* Personel */}
                          <td style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                            {r.kapanis_personel || '—'}
                          </td>
                          {/* Ciro durumu */}
                          <td style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                            {r.ciro_onaylandi
                              ? <span style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>✓ Onaylı</span>
                              : r.taslak_var && r.taslak_durum === 'bekliyor'
                              ? <span style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>⏳ Onayda</span>
                              : r.kapanis_tamam
                              ? <span style={{ background: 'rgba(232,93,93,0.15)', color: '#e85d5d', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>❌ Ciro Yok</span>
                              : <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>}
                          </td>
                          {/* Gönderen */}
                          <td style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                            {r.gonderen_ad || '—'}
                          </td>
                          {/* Nakit */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {r.nakit > 0 ? <strong>{fmt(r.nakit)} ₺</strong> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* POS */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {r.pos > 0 ? <strong>{fmt(r.pos)} ₺</strong> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Online */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {r.online > 0 ? <strong>{fmt(r.online)} ₺</strong> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Toplam */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {toplam > 0
                              ? <span style={{ fontWeight: 800, fontSize: 14, color: r.ciro_onaylandi ? '#22c55e' : 'var(--text)' }}>{fmt(toplam)} ₺</span>
                              : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Sabah kasa */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontSize: 12, maxWidth: 120 }}>
                            {r.acildi ? <span style={{ whiteSpace: 'nowrap' }}>{fmt(r.sabah_kasa_tl)} ₺</span> : <span style={eksikUyariStil}>Açılış yapılmadı</span>}
                          </td>
                          {/* Teslim */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontSize: 12, maxWidth: 120 }}>
                            {r.kapanis_tamam ? <span style={{ whiteSpace: 'nowrap' }}>{fmt(r.teslim_kasa_tl)} ₺</span> : <span style={eksikUyariStil}>Kapanış yapılmadı</span>}
                          </td>
                          {/* Devir (kasada kalan) */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontSize: 12, maxWidth: 120 }}>
                            {r.kapanis_tamam ? <span style={{ whiteSpace: 'nowrap' }}>{fmt(r.devir)} ₺</span> : <span style={eksikUyariStil}>Kapanış yapılmadı</span>}
                          </td>
                          {/* Anlık gider nakit */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: 12 }}>
                            {(r.anlik_gider_nakit_tl || 0) > 0 ? <span>{fmt(r.anlik_gider_nakit_tl)} ₺</span> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Nakit denge farkı */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontSize: 12, maxWidth: 160 }}>
                            {nakitDeltaHucre(r)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Toplam satırı */}
                  {satirlar.length > 0 && (
                    <tfoot>
                      <tr style={{ background: 'var(--bg2)' }}>
                        <td colSpan={6} style={{ padding: '9px 10px', borderTop: '2px solid var(--border)', fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>
                          TOPLAM · {satirlar.filter(r => r.ciro_tutar > 0 || r.nakit > 0 || r.pos > 0 || r.online > 0).length} şube
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 13 }}>
                          {fmt(topNakit)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 13 }}>
                          {fmt(topPos)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 13 }}>
                          {fmt(topOnline)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 15, color: '#22c55e' }}>
                          {fmt(topCiro)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12, color: 'var(--text2)' }}>
                          {fmt(topSabah)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12, color: 'var(--text2)' }}>
                          {fmt(topTeslim)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12, color: 'var(--text2)' }}>
                          {fmt(topDevir)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12, color: 'var(--text2)' }}>
                          {fmt(topAgider)} ₺
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                          —
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {/* Alt not */}
            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
              Sıralama: önce kapanmayan şubeler, sonra ciro eksik, sonra onay bekleyenler, en altta tamamlananlar.
              Nakit/POS/Online tutarlar ciro taslağından gelir; kırmızı satır = acil aksiyon gerektiriyor.
              {bugunMu && ' · Tablo 2 dakikada bir otomatik yenilenir.'}
            </div>

          </div>
        );
      })()}

      {aktifSekme === 'ciro-onay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
            <strong>Ciro onayı:</strong> Şube panelinde kapanışta girilen <strong>X nakit / POS / online</strong> tutarları aynen{' '}
            <code className="mono">ciro_taslak</code> satırına düşer; burada onayladığınızda CFO cirosu ve kasa hareketine (net ciro) yansır.
            <strong> Teslim kasa, devir, kasada sayılan toplam ve kime teslim</strong> ciro taslağına yazılmaz; bunlar{' '}
            <strong>Kapanış Takip</strong> tablosunda ve <strong>kasa teslim</strong> kayıtlarında (ayrı tablo) izlenir.
            Taslak tarihi iş günüdür (<code className="mono">is_gunu_tr</code>).
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={ciroOnayAramaTarih}
                onChange={(e) => setCiroOnayAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => ciroOnayAramaYap()}
            >
              {ciroOnayAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {ciroOnayAramaSonuc?.tarih || ciroOnayAramaTarih} · {ciroOnayAramaSonuc?.toplam || 0} bekleyen · {fmt(ciroOnayAramaSonuc?.toplam_tutar || 0)}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setCiroOnaySeciliSubeKey('all')}
              style={{
                border: ciroOnaySeciliSubeKey === 'all' ? '1px solid #d946b8' : '1px solid var(--border)',
                background: ciroOnaySeciliSubeKey === 'all' ? 'rgba(217, 70, 184, 0.2)' : 'var(--bg2)',
                color: ciroOnaySeciliSubeKey === 'all' ? '#f5d0fe' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {ciroOnaySubeSekmeleri.map((s) => (
              <button
                key={`ciro-onay-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setCiroOnaySeciliSubeKey(s.key)}
                style={{
                  border: ciroOnaySeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: ciroOnaySeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: ciroOnaySeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>

          {ciroOnayGorunenKayitlar.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte bekleyen ciro onayı yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 460, overflow: 'auto' }}>
              {ciroOnayGorunenKayitlar.map((t) => (
                <div
                  key={t.id}
                  className="card"
                  style={{ padding: '12px 14px', borderLeft: '4px solid #d946b8' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {t.sube_adi || t.sube_id}
                        <span className="badge" style={{ marginLeft: 8, background: 'rgba(217, 70, 184, 0.18)', color: '#f5d0fe', border: '1px solid rgba(217, 70, 184, 0.4)' }}>
                          Toplam {fmt(Number(t?.nakit || 0) + Number(t?.pos || 0) + Number(t?.online || 0))}
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                        {t.tarih} · Nakit {fmt(t.nakit)} · POS {fmt(t.pos)} · Online {fmt(t.online)}
                      </div>
                      {t.aciklama && <div style={{ fontSize: 12, marginTop: 6 }}>{t.aciklama}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!!onayBusyId}
                        onClick={() => ciroTaslakOnayla(t.id)}
                      >
                        {onayBusyId === `c:${t.id}` ? '…' : 'Onayla → ciro'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={!!onayBusyId}
                        onClick={() => ciroTaslakReddet(t.id)}
                      >
                        {onayBusyId === `cr:${t.id}` ? '…' : 'Reddet'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'gec-acilan-subeler' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setGecAcilanKartSekme('akis')}
              style={{
                padding: '8px 14px',
                fontWeight: 700,
                border: gecAcilanKartSekme === 'akis' ? '1px solid #f97316' : '1px solid var(--border)',
                background: gecAcilanKartSekme === 'akis' ? 'rgba(249, 115, 22, 0.22)' : 'var(--bg2)',
                color: gecAcilanKartSekme === 'akis' ? '#fed7aa' : 'var(--text2)',
              }}
            >
              Geç / bekleyen açılış
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setGecAcilanKartSekme('plan_kayitsiz')}
              style={{
                padding: '8px 14px',
                fontWeight: 700,
                border: gecAcilanKartSekme === 'plan_kayitsiz' ? '1px solid #64748b' : '1px solid var(--border)',
                background: gecAcilanKartSekme === 'plan_kayitsiz' ? 'rgba(100, 116, 139, 0.25)' : 'var(--bg2)',
                color: gecAcilanKartSekme === 'plan_kayitsiz' ? '#e2e8f0' : 'var(--text2)',
              }}
            >
              Planlı · operasyon kaydı yok
            </button>
          </div>

          {gecAcilanKartSekme === 'akis' && (
          <>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--text3)',
              opacity: 0.88,
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
            }}
          >
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Ne listelenir?</strong>{' '}
            <strong style={{ color: 'var(--text2)' }}>Geç açılan</strong>: o gün operasyon <strong style={{ color: 'var(--text2)' }}>ACILIS</strong> tamamlanmış ama cevap zamanı{' '}
            <strong style={{ color: 'var(--text2)' }}>vardiya planındaki en erken slottan</strong> (varsa) veya yoksa <strong style={{ color: 'var(--text2)' }}>sistem slotundan</strong> sonradır.{' '}
            <strong style={{ color: '#fbbf24' }}>Uyarı</strong>: 1–15 dk gecikme; <strong style={{ color: '#f87171' }}>Kritik</strong>: 15 dk üzeri.{' '}
            <strong style={{ color: 'var(--text2)' }}>Henüz açılmamış</strong>: aynı gün için ACILIS kaydı oluşmuş fakat henüz tamamlanmamış şubeler (bekliyor / gecikti / cevap yok);
            bu şubeler aşağıda ayrı blokta <strong style={{ color: 'var(--text2)' }}>isimleriyle</strong> yazılır. Hiç ACILIS satırı oluşmamış planlı şubeler için üstteki{' '}
            <strong style={{ color: 'var(--text2)' }}>«Planlı · operasyon kaydı yok»</strong> sekmesine geçin.
          </div>

          {gecAcilanTarihSecimPaneli}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setGecAcilanSeciliSubeKey('all')}
              style={{
                border: gecAcilanSeciliSubeKey === 'all' ? '1px solid #f97316' : '1px solid var(--border)',
                background: gecAcilanSeciliSubeKey === 'all' ? 'rgba(249, 115, 22, 0.2)' : 'var(--bg2)',
                color: gecAcilanSeciliSubeKey === 'all' ? '#fed7aa' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {gecAcilanSubeSekmeleri.map((s) => (
              <button
                key={`gec-acilis-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setGecAcilanSeciliSubeKey(s.key)}
                style={{
                  border: gecAcilanSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: gecAcilanSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: gecAcilanSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} (
                {(() => {
                  const g = Number(s.gecSayi || 0);
                  const ac = Number(s.acSayi || 0);
                  const p = [];
                  if (g > 0) p.push(`${g} geç`);
                  if (ac > 0) p.push(`${ac} bekleyen`);
                  return p.length ? p.join(' · ') : '0';
                })()}
                )
              </button>
            ))}
          </div>

          {gecAcilanAcilmayanGorunen.length > 0 && (
            <div className="card" style={{ padding: '12px 14px', borderLeft: '4px solid var(--red)' }}>
              <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, color: 'var(--text)' }}>
                Henüz operasyon açılışı tamamlanmamış şubeler ({gecAcilanAcilmayanGorunen.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text2)', lineHeight: 1.7 }}>
                {gecAcilanAcilmayanGorunen.map((a) => (
                  <li key={`acil-${String(a?.sube_id || '')}-${String(a?.durum || '')}`}>
                    <strong>{a.sube_adi || a.sube_id}</strong>
                    {a.durum != null && String(a.durum).trim() !== '' && (
                      <span style={{ color: 'var(--text3)', marginLeft: 6 }} className="mono">({String(a.durum)})</span>
                    )}
                    {a.beklenen_saat && (
                      <span style={{ color: '#fbbf24', marginLeft: 6 }}>⏰ {a.beklenen_saat}</span>
                    )}
                    {a.beklened_personel && (
                      <span style={{ color: 'var(--text3)', marginLeft: 6 }}>· {a.beklened_personel}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {gecAcilanGorunenKayitlar.length === 0 && gecAcilanAcilmayanGorunen.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte geç açılış veya bekleyen açılış kaydı yok</p></div>
          ) : null}

          {gecAcilanGorunenKayitlar.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', marginBottom: 6 }}>Geç tamamlanan açılışlar</div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)' }}>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Şube</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: '#93c5fd', fontWeight: 600 }}>Planlı Personel</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Açan Personel</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600 }}>Planlanan</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600 }}>Açılış</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700 }}>Gecikme</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--text3)', fontWeight: 600 }}>Seviye</th>
                  </tr>
                </thead>
                <tbody>
                  {gecAcilanGorunenKayitlar.map((r, idx) => (
                    <tr key={r.event_id || `${r.sube_id}-${r.tarih}-${idx}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 600 }}>{r.sube_adi || r.sube_id}</td>
                      <td style={{ padding: '7px 8px', color: '#93c5fd', fontSize: 11 }}>{r.beklened_personel || '—'}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text2)' }}>{r.personel_ad || r.personel_id || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center' }}>{r.planlanan_saat || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center' }}>{r.acilis_saat || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--red)', fontWeight: 700 }}>
                        +{Number(r.gecikme_dk || 0).toFixed(1)} dk
                      </td>
                      <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 700, fontSize: 11 }}>
                        {String(r.gecikme_seviye || '') === 'kritik' ? (
                          <span style={{ color: '#f87171' }}>Kritik</span>
                        ) : (
                          <span style={{ color: '#fbbf24' }}>Uyarı</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div
            className="card"
            style={{
              marginTop: 4,
              padding: '14px 16px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg2)',
              boxShadow: '0 2px 10px rgba(0, 0, 0, 0.04)',
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: 'var(--text)',
                marginBottom: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span aria-hidden>📊</span>
              Son 7 gün özeti
              {gecAcilanHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500, fontSize: 12 }}>(yükleniyor…)</span> : null}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>— hızlı gün seçimi</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gecAcilanHaftaYukleniyor && gecAcilanHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (gecAcilanHaftaSatirlari.length ? gecAcilanHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                gec_toplam: 0,
                acilmayan_toplam: 0,
                ozetMetin: '',
                plan_kayitsiz_toplam: 0,
                planOzetMetin: '',
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const gec = Number(s.gec_toplam || 0);
                const ac = Number(s.acilmayan_toplam || 0);
                const dikkat = gec > 0 || ac > 0;
                const kritikAc = ac > 0;
                return (
                  <button
                    key={`gec-hafta-${s.tarih}`}
                    type="button"
                    title={s.ozetMetin || undefined}
                    onClick={async () => {
                      setGecAcilanAramaTarih(s.tarih);
                      setGecAcilanAramaYukleniyor(true);
                      try {
                        const data = await gecAcilanGunYukle(s.tarih);
                        setGecAcilanAramaSonuc(data);
                        setGecAcilanSeciliSubeKey('all');
                      } catch (e) {
                        toast(e.message || 'Geç açılan şubeler yüklenemedi');
                      } finally {
                        setGecAcilanAramaYukleniyor(false);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 6,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: kritikAc
                        ? '1px solid rgba(220, 38, 38, 0.55)'
                        : gec > 0
                          ? '1px solid rgba(249, 115, 22, 0.5)'
                          : '1px solid var(--border)',
                      background: kritikAc
                        ? 'rgba(220, 38, 38, 0.1)'
                        : gec > 0
                          ? 'rgba(249, 115, 22, 0.08)'
                          : 'var(--bg)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: dikkat ? 'var(--text)' : 'var(--text3)' }}>
                        <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                        {s.tarih === bugunStr ? (
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span>
                        ) : null}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {gec > 0 ? (
                          <span className="badge badge-yellow" style={{ fontWeight: 700 }}>{gec} geç</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Geç yok</span>
                        )}
                        {ac > 0 ? (
                          <span className="badge badge-red" style={{ fontWeight: 700 }}>{ac} açılmamış</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Bekleyen yok</span>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>Detay ↑</span>
                      </span>
                    </div>
                    {s.ozetMetin ? (
                      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45, opacity: 0.95 }}>
                        {s.ozetMetin}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text3)', opacity: 0.88, margin: '10px 0 0' }}>
              Satıra tıklayınca üstteki detay paneli o güne yüklenir. Tam şube listesi için satırın üzerine gelin (tooltip) veya tablodan okuyun.
            </p>
          </div>
          </>
          )}

          {gecAcilanKartSekme === 'plan_kayitsiz' && (
          <>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--text3)',
              opacity: 0.88,
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
            }}
          >
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Planlı · operasyon kaydı yok nedir?</strong>{' '}
            <strong style={{ color: 'var(--text2)' }}>Aktif</strong> ve <strong style={{ color: 'var(--text2)' }}>vardiya/operasyon takibi açık</strong> (
            <code style={{ fontSize: 11 }}>vardiya_yazilsin</code>
            ) şubelerde, seçilen gün için veritabanında <strong style={{ color: 'var(--text2)' }}>hiç ACILIS event satırı oluşmamış</strong> olanlar listelenir.
            Bu genelde şube panelinin / operasyon motorunun o gün o şube için hiç çalışmadığını gösterir (ilk yüklemede ACILIS satırı oluşturulur). Geç veya yarım kalmış açılışlar bir üst sekmededir.
          </div>

          {gecAcilanTarihSecimPaneli}

          {(gecAcilanAramaSonuc?.plan_kayitsiz_subeler || []).length === 0 ? (
            <div className="empty"><p>Seçilen tarihte bu kritere uyan şube yok (tüm planlı şubelerde ACILIS satırı var)</p></div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', marginBottom: 6 }}>Vardiya planı var ama ACILIS eventi henüz oluşmamış</div>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)' }}>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Şube</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600 }}>Planlanan Açılış</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: '#93c5fd', fontWeight: 600 }}>Planlı Personel</th>
                  </tr>
                </thead>
                <tbody>
                  {(gecAcilanAramaSonuc?.plan_kayitsiz_subeler || []).map((row) => (
                    <tr key={`pk-${row.sube_id}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 600 }}>{row.sube_adi || row.sube_id}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center' }}>{row.plan_acilis_saati || '—'}</td>
                      <td style={{ padding: '7px 8px', color: '#93c5fd', fontSize: 11 }}>{row.beklened_personel || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div
            className="card"
            style={{
              marginTop: 4,
              padding: '14px 16px',
              borderRadius: 10,
              border: '1px solid rgba(100, 116, 139, 0.45)',
              background: 'linear-gradient(165deg, rgba(100, 116, 139, 0.1) 0%, var(--bg2) 55%)',
              boxShadow: '0 2px 10px rgba(0, 0, 0, 0.04)',
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: 'var(--text)',
                marginBottom: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span aria-hidden>📊</span>
              Son 7 gün — planlı ama ACILIS yok
              {gecAcilanHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500, fontSize: 12 }}>(yükleniyor…)</span> : null}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>— hızlı gün seçimi</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gecAcilanHaftaYukleniyor && gecAcilanHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (gecAcilanHaftaSatirlari.length ? gecAcilanHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                plan_kayitsiz_toplam: 0,
                planOzetMetin: '',
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const pt = Number(s.plan_kayitsiz_toplam || 0);
                const vurgu = pt > 0;
                return (
                  <button
                    key={`gec-plan-hafta-${s.tarih}`}
                    type="button"
                    title={s.planOzetMetin || undefined}
                    onClick={async () => {
                      setGecAcilanAramaTarih(s.tarih);
                      setGecAcilanAramaYukleniyor(true);
                      try {
                        const data = await gecAcilanGunYukle(s.tarih);
                        setGecAcilanAramaSonuc(data);
                      } catch (e) {
                        toast(e.message || 'Veri yüklenemedi');
                      } finally {
                        setGecAcilanAramaYukleniyor(false);
                      }
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 6,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: vurgu ? '1px solid rgba(100, 116, 139, 0.65)' : '1px solid var(--border)',
                      background: vurgu ? 'rgba(100, 116, 139, 0.14)' : 'var(--bg)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: vurgu ? 'var(--text)' : 'var(--text3)' }}>
                        <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                        {s.tarih === bugunStr ? (
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span>
                        ) : null}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {pt > 0 ? (
                          <span className="badge badge-yellow" style={{ fontWeight: 700, background: 'rgba(100,116,139,0.35)', borderColor: '#94a3b8' }}>{pt} şube</span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Kayıt tam</span>
                        )}
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>Detay ↑</span>
                      </span>
                    </div>
                    {s.planOzetMetin ? (
                      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45, opacity: 0.95 }}>
                        {s.planOzetMetin}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text3)', opacity: 0.88, margin: '10px 0 0' }}>
              Satıra tıklayınca üstteki detay ve tablo o güne yüklenir. Gelecek tarihlerde tüm şubeler “kayıtsız” görünebilir; geçmiş günlerde kalan satır genelde anlamlıdır.
            </p>
          </div>
          </>
          )}
        </div>
      )}

      {aktifSekme === 'gec-kalan-personel' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.5 }}>
            Aylık bazda personel geç açılış tekrarları burada izlenir. Gecikme dakikası <strong>Geç Açılan Şubeler</strong> ile aynıdır: önce vardiya planı (MIN başlangıç), yoksa operasyon <code className="mono">sistem_slot_ts</code>.
            Listeye girmek için en az <strong>5 dk</strong> gecikme; satırda <strong>kritik</strong> sayımı <strong>15 dk+</strong> olaylar içindir.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ay</span>
              <input
                type="month"
                className="input"
                value={gecKalanPersonelAy}
                onChange={(e) => setGecKalanPersonelAy(e.target.value || varsayilanAy)}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => gecKalanPersonelAramaYap()}
            >
              {gecKalanPersonelAramaYukleniyor ? '…' : 'Ayı getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {gecKalanPersonelAramaSonuc?.year_month || gecKalanPersonelAy} · {gecKalanPersonelAramaSonuc?.toplam_personel || 0} personel · {gecKalanPersonelAramaSonuc?.kritik_personel_sayisi || 0} kritik
            </div>
          </div>

          {gecKalanPersonelSatirlari.length === 0 ? (
            <div className="empty"><p>Bu ay geç kalan personel kaydı yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 520, overflow: 'auto' }}>
              {gecKalanPersonelSatirlari.map((p, idx) => {
                const pKey = `${p.personel_id || 'anon'}-${p.personel_ad || '—'}-${idx}`;
                const acik = gecKalanPersonelAcikKey === pKey;
                const detaylar = Array.isArray(p?.detaylar) ? p.detaylar : [];
                const kritik = !!p?.kritik;
                return (
                  <div key={pKey} className="card" style={{ padding: '12px 14px', borderLeft: `4px solid ${kritik ? 'var(--red)' : '#0ea5a4'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>
                          {p.personel_ad || p.personel_id || 'Bilinmiyor'}
                          <span
                            className={`badge ${kritik ? 'badge-red' : ''}`}
                            style={kritik ? { marginLeft: 8 } : { marginLeft: 8, background: 'rgba(14, 165, 164, 0.18)', color: '#99f6e4', border: '1px solid rgba(14, 165, 164, 0.35)' }}
                          >
                            {p.gecikme_adet || 0} gecikme
                          </span>
                          {kritik && <span className="badge badge-red" style={{ marginLeft: 6 }}>Kritik</span>}
                        </div>
                        <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                          Toplam geç kalma: {Number(p?.gecikme_adet || 0)} · Kritik geç kalma: {Number(p?.kritik_gecikme_adet || 0)} · Toplam gecikme: {Number(p?.toplam_gecikme_dk || 0).toFixed(1)} dk · Olay sayısı: {Array.isArray(p?.detaylar) ? p.detaylar.length : 0}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setGecKalanPersonelAcikKey(acik ? '' : pKey)}
                      >
                        {acik ? 'Detayı gizle' : 'Detayı göster'}
                      </button>
                    </div>

                    {acik && (
                      <div style={{ marginTop: 10, overflowX: 'auto' }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg2)' }}>
                              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Tarih</th>
                              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Şube</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600 }}>Planlanan</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600 }}>Açılış</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700 }}>Gecikme</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detaylar.map((d, di) => (
                              <tr key={d.event_id || `${d.tarih}-${d.sube_id}-${di}`} style={{ borderTop: '1px solid var(--border)' }}>
                                <td className="mono" style={{ padding: '6px 8px' }}>{d.tarih || '—'}</td>
                                <td style={{ padding: '6px 8px' }}>{d.sube_adi || d.sube_id || '—'}</td>
                                <td className="mono" style={{ padding: '6px 8px', textAlign: 'center' }}>{d.planlanan_saat || '—'}</td>
                                <td className="mono" style={{ padding: '6px 8px', textAlign: 'center' }}>{d.acilis_saat || '—'}</td>
                                <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--red)', fontWeight: 700 }}>
                                  +{Number(d.gecikme_dk || 0).toFixed(1)} dk
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'kasa-uyumsuzluk' && (() => {
        const kuGunGit = async (yeniTarih) => {
          setKasaUyumAramaTarih(yeniTarih);
          setKasaUyumAramaYukleniyor(true);
          try {
            const data = await kasaUyumGunYukle(yeniTarih);
            setKasaUyumAramaSonuc(data);
            setKasaUyumSeciliSubeKey('all');
          } catch (e) { toast(e.message || 'Veri yüklenemedi'); }
          finally { setKasaUyumAramaYukleniyor(false); }
        };
        const kuGunEkle = (tarih, gun) => {
          const d = new Date(tarih + 'T00:00:00'); d.setDate(d.getDate() + gun);
          return d.toISOString().slice(0, 10);
        };
        const bugunStr = bugunIsoTarih();
        const secilenTarih = kasaUyumAramaTarih || bugunStr;
        const tumKayitlar = Array.isArray(kasaUyumAramaSonuc?.kayitlar) ? kasaUyumAramaSonuc.kayitlar : [];
        const kritikAdet = tumKayitlar.filter(u => Math.abs(Number(u.fark_tl || 0)) >= 200).length;
        const normalAdet = tumKayitlar.filter(u => Math.abs(Number(u.fark_tl || 0)) < 200).length;
        const eksikList = secilenTarih === bugunStr
          ? (kasaUyumAramaSonuc?.eksik_kapanis || kasaUyumBugun?.eksik_kapanis || [])
          : [];
        const haftaRows = kasaUyumHaftaSatirlari.length
          ? kasaUyumHaftaSatirlari
          : Array.from({ length: 7 }, (_, i) => ({ tarih: kuGunEkle(bugunStr, -i), adet: 0, maxAbsFark: 0 }));

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* ── NAVİGASYON ÇUBUĞU ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
              <button type="button" className="btn btn-sm" style={{ padding: '5px 10px', fontSize: 16, lineHeight: 1 }}
                onClick={() => kuGunGit(kuGunEkle(secilenTarih, -1))}>‹</button>
              <input
                type="date"
                className="input"
                value={secilenTarih}
                style={{ fontSize: 13, padding: '5px 9px', flex: '0 0 auto' }}
                onChange={(e) => e.target.value && kuGunGit(e.target.value)}
              />
              <button type="button" className="btn btn-sm" style={{ padding: '5px 10px', fontSize: 16, lineHeight: 1 }}
                disabled={secilenTarih >= bugunStr}
                onClick={() => kuGunGit(kuGunEkle(secilenTarih, 1))}>›</button>
              {secilenTarih !== bugunStr && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => kuGunGit(bugunStr)}>Bugün</button>
              )}
              <span style={{ marginLeft: 4, fontSize: 12, color: 'var(--text3)' }}>
                {kasaUyumAramaYukleniyor ? '⏳ yükleniyor…' : `${tumKayitlar.length} kayıt`}
              </span>
              {/* Özet çipler */}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {kritikAdet > 0 && <span className="badge badge-red" style={{ fontWeight: 700 }}>🔴 {kritikAdet} kritik</span>}
                {normalAdet > 0 && <span className="badge badge-yellow" style={{ fontWeight: 700 }}>🟡 {normalAdet} normal</span>}
                {eksikList.length > 0 && <span className="badge badge-red" style={{ fontWeight: 700, background: 'rgba(220,38,38,0.2)' }}>⛔ {eksikList.length} eksik kapanış</span>}
                {tumKayitlar.length === 0 && !kasaUyumAramaYukleniyor && <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 600 }}>✓ Sorun yok</span>}
              </div>
            </div>

            {/* ── EKSİK KAPANIŞ UYARISI ── */}
            {eksikList.length > 0 && (
              <div style={{ background: 'rgba(220,38,38,0.09)', border: '1px solid rgba(220,38,38,0.35)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#fca5a5', marginBottom: 6 }}>
                  ⛔ Dünkü kapanışı eksik — bugün açılış yapan {eksikList.length} şube
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {eksikList.map((e) => (
                    <span key={e.sube_id} style={{ background: 'rgba(220,38,38,0.15)', borderRadius: 5, padding: '2px 9px', fontSize: 12, color: '#fca5a5', fontWeight: 600 }}>
                      {e.sube_adi}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* ── ŞUBE FİLTRESİ ── */}
            {kasaUyumSubeSekmeleri.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm"
                  onClick={() => setKasaUyumSeciliSubeKey('all')}
                  style={{ padding: '4px 12px', fontWeight: 700,
                    background: kasaUyumSeciliSubeKey === 'all' ? 'rgba(232,93,93,0.2)' : 'var(--bg2)',
                    border: kasaUyumSeciliSubeKey === 'all' ? '1px solid #e85d5d' : '1px solid var(--border)',
                    color: kasaUyumSeciliSubeKey === 'all' ? '#fecaca' : 'var(--text2)' }}>
                  Tümü ({tumKayitlar.length})
                </button>
                {kasaUyumSubeSekmeleri.map((s) => (
                  <button key={`ku-${s.key}`} type="button" className="btn btn-sm"
                    onClick={() => setKasaUyumSeciliSubeKey(s.key)}
                    style={{ padding: '4px 12px', fontWeight: 600,
                      background: kasaUyumSeciliSubeKey === s.key ? 'rgba(74,158,255,0.18)' : 'var(--bg2)',
                      border: kasaUyumSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                      color: kasaUyumSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)' }}>
                    {s.baslik}
                  </button>
                ))}
              </div>
            )}

            {/* ── UYUMSUZLUK KARTLARI ── */}
            {kasaUyumGorunenKayitlar.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text3)' }}>
                {kasaUyumAramaYukleniyor ? '⏳ Yükleniyor…' : '✓ Bu tarihte çözüm bekleyen kasa uyumsuzluğu yok'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {kasaUyumGorunenKayitlar.map((u) => {
                  const fark = Number(u?.fark_tl || 0);
                  const absFark = Math.abs(fark);
                  const kritik = absFark >= 200;
                  const kapanis_tarih = u.kapanis_tarih || kuGunEkle(u.tarih, -1);
                  const kapanis_yapildi = u.kapanis_yapildi !== false;
                  return (
                    <div key={u.id} style={{
                      borderRadius: 10,
                      border: `1px solid ${kritik ? 'rgba(220,38,38,0.4)' : 'rgba(234,179,8,0.35)'}`,
                      background: kritik ? 'rgba(220,38,38,0.05)' : 'rgba(234,179,8,0.04)',
                      overflow: 'hidden',
                    }}>
                      {/* Kart başlık şeridi */}
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 10, flexWrap: 'wrap',
                        padding: '10px 14px',
                        borderBottom: `1px solid ${kritik ? 'rgba(220,38,38,0.2)' : 'rgba(234,179,8,0.2)'}`,
                        background: kritik ? 'rgba(220,38,38,0.08)' : 'rgba(234,179,8,0.07)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{u.sube_adi || u.sube_id}</span>
                          <span style={{
                            background: kritik ? 'rgba(220,38,38,0.25)' : 'rgba(234,179,8,0.25)',
                            color: kritik ? '#fca5a5' : '#fde68a',
                            borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 800,
                          }}>
                            {fark > 0 ? '+' : ''}{fmt(fark)}
                          </span>
                          {!kapanis_yapildi && (
                            <span style={{ background: 'rgba(220,38,38,0.3)', color: '#fca5a5', borderRadius: 5, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                              Kapanış yapılmamış
                            </span>
                          )}
                        </div>
                        <button type="button" className="btn btn-sm"
                          style={{ padding: '4px 14px', background: 'rgba(74,158,255,0.15)', border: '1px solid rgba(74,158,255,0.4)', color: '#93c5fd', fontWeight: 600 }}
                          disabled={!!onayBusyId}
                          onClick={() => kasaUyumsuzlukCoz(u.id)}>
                          {onayBusyId === `ku:${u.id}` ? '…' : '✓ Çözüldü'}
                        </button>
                      </div>
                      {/* Kart detay */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                        {/* Kapanış kutusu */}
                        <div style={{ padding: '12px 14px', borderRight: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                            Kapanış deviri · {kapanis_tarih}
                          </div>
                          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace', marginBottom: 6 }}>
                            {fmt(u.beklenen_tl || 0)}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 18, lineHeight: 1 }}>👤</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: u.kapanis_personel_ad ? 'var(--text)' : 'var(--text3)' }}>
                              {u.kapanis_personel_ad || '—'}
                            </span>
                          </div>
                        </div>
                        {/* Açılış kutusu */}
                        <div style={{ padding: '12px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                            Açılış sayımı · {u.tarih}
                          </div>
                          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace', marginBottom: 6 }}>
                            {fmt(u.gercek_tl || 0)}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 18, lineHeight: 1 }}>👤</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: u.acilis_personel_ad ? 'var(--text)' : 'var(--text3)' }}>
                              {u.acilis_personel_ad || '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── SON 7 GÜN ŞERIDI ── */}
            <div style={{ marginTop: 4, padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10 }}>
                Son 7 gün {kasaUyumHaftaYukleniyor && <span style={{ fontWeight: 400, color: 'var(--text3)' }}>yükleniyor…</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                {haftaRows.slice(0, 7).reverse().map((s) => {
                  const secili = s.tarih === secilenTarih;
                  const bugun = s.tarih === bugunStr;
                  const dikkat = s.adet > 0;
                  const kritik = dikkat && s.maxAbsFark >= 200;
                  return (
                    <button key={`ku7-${s.tarih}`} type="button"
                      onClick={() => kuGunGit(s.tarih)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        padding: '7px 4px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                        border: secili ? '2px solid #4a9eff' : kritik ? '1px solid rgba(220,38,38,0.5)' : dikkat ? '1px solid rgba(234,179,8,0.4)' : '1px solid var(--border)',
                        background: secili ? 'rgba(74,158,255,0.15)' : kritik ? 'rgba(220,38,38,0.1)' : dikkat ? 'rgba(234,179,8,0.08)' : 'transparent',
                        transition: 'all .15s',
                      }}>
                      <span style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 2 }}>
                        {new Date(s.tarih + 'T00:00:00').toLocaleDateString('tr-TR', { weekday: 'short' })}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: secili ? '#93c5fd' : bugun ? 'var(--text)' : 'var(--text2)', fontFamily: 'monospace' }}>
                        {s.tarih.slice(8)}
                      </span>
                      <span style={{ marginTop: 4, fontSize: 13 }}>
                        {kritik ? '🔴' : dikkat ? '🟡' : '✓'}
                      </span>
                      {dikkat && (
                        <span style={{ fontSize: 9, color: kritik ? '#fca5a5' : '#fde68a', fontWeight: 700, marginTop: 1 }}>
                          {s.adet} şube
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
        );
      })()}

      {aktifSekme === 'personel-vardiya-uyumsuzluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--text3)',
              opacity: 0.88,
              margin: 0,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
            }}
          >
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Bu kart ne işe yarar?</strong>{' '}
            Vardiya planında o güne <strong style={{ color: 'var(--text2)' }}>açılış</strong> için atanmış personel ile şube panelinde açılışı PIN ile
            onaylayan personel farklı olduğunda sistem uyarı üretir. Burada yalnızca merkez tarafından henüz{' '}
            <strong style={{ color: 'var(--text2)' }}>«Çözüldü»</strong> işaretlenmemiş kayıtlar listelenir.
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
              Son 7 gün — çözüm bekleyen kayıtlar {personelVardiyaUyumHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500 }}>(yükleniyor…)</span> : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {personelVardiyaUyumHaftaYukleniyor && personelVardiyaUyumHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (personelVardiyaUyumHaftaSatirlari.length ? personelVardiyaUyumHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                adet: 0,
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const dikkat = s.adet > 0;
                return (
                  <button
                    key={`pv-hafta-${s.tarih}`}
                    type="button"
                    onClick={async () => {
                      setPersonelVardiyaUyumAramaTarih(s.tarih);
                      setPersonelVardiyaUyumAramaYukleniyor(true);
                      try {
                        const data = await personelVardiyaUyumGunYukle(s.tarih);
                        setPersonelVardiyaUyumAramaSonuc(data);
                        setPersonelVardiyaUyumSeciliSubeKey('all');
                      } catch (e) {
                        toast(e.message || 'Personel uyumsuzluk verisi yüklenemedi');
                      } finally {
                        setPersonelVardiyaUyumAramaYukleniyor(false);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      border: dikkat ? '1px solid rgba(190, 24, 93, 0.45)' : '1px solid var(--border)',
                      background: dikkat ? 'rgba(190, 24, 93, 0.1)' : 'var(--bg2)',
                      boxShadow: dikkat ? '0 0 0 1px rgba(190, 24, 93, 0.12)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 12, color: dikkat ? 'var(--text)' : 'var(--text3)' }}>
                      <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                      {s.tarih === bugunStr ? (
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span>
                      ) : null}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                      {dikkat ? (
                        <>
                          <span className="badge badge-red" style={{ fontWeight: 700 }}>
                            {s.adet} kayıt
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Detay ↓</span>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500 }}>Bekleyen yok</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginTop: 4 }}>Tarih seçerek detay</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={personelVardiyaUyumAramaTarih}
                onChange={(e) => setPersonelVardiyaUyumAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => personelVardiyaUyumAramaYap()}
            >
              {personelVardiyaUyumAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {personelVardiyaUyumAramaSonuc?.tarih || personelVardiyaUyumAramaTarih} · {personelVardiyaUyumAramaSonuc?.toplam || 0} kayıt
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPersonelVardiyaUyumSeciliSubeKey('all')}
              style={{
                border: personelVardiyaUyumSeciliSubeKey === 'all' ? '1px solid #be185d' : '1px solid var(--border)',
                background: personelVardiyaUyumSeciliSubeKey === 'all' ? 'rgba(190, 24, 93, 0.2)' : 'var(--bg2)',
                color: personelVardiyaUyumSeciliSubeKey === 'all' ? '#fbcfe8' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {personelVardiyaUyumSubeSekmeleri.map((s) => (
              <button
                key={`pv-uyum-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setPersonelVardiyaUyumSeciliSubeKey(s.key)}
                style={{
                  border: personelVardiyaUyumSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: personelVardiyaUyumSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: personelVardiyaUyumSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>

          {personelVardiyaUyumGorunenKayitlar.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte bekleyen personel uyumsuzluğu yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflow: 'auto' }}>
              {personelVardiyaUyumGorunenKayitlar.map((u) => (
                <div key={u.id} className="card" style={{ padding: '12px 14px', borderLeft: '4px solid #be185d' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {u.sube_adi || u.sube_id}
                        <span style={{ marginLeft: 8 }} className="badge badge-red">{String(u.seviye || 'kritik')}</span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                        {u.tarih}
                        {u.acilis_personel_ad ? ` · Onaylayan: ${u.acilis_personel_ad}` : ''}
                      </div>
                      {u.mesaj && <div style={{ fontSize: 12, marginTop: 6 }}>{u.mesaj}</div>}
                    </div>
                    <div>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!!onayBusyId}
                        onClick={() => personelVardiyaUyumsuzlukCoz(u.id)}
                      >
                        {onayBusyId === `pv:${u.id}` ? '…' : 'Çözüldü işaretle'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'urun-uyumsuzluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
            <strong>Aynı gün (bar içi):</strong> Açılış + Ürün Aç − Kapanış = mantıksal satış; negatif kalem gün içi stoğu tutmuyor demektir.
            <br />
            <strong>Günler arası (devir):</strong> Bir önceki günün <em>kapanış</em> stok sayımı ile aynı günün <em>sabah açılış</em> sayımı kalem kalem eşleştirilir; fark varsa veya önceki gün kapanışı yoksa bu listede görünür.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={urunUyumAramaTarih}
                onChange={(e) => setUrunUyumAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => urunUyumAramaYap()}
            >
              {urunUyumAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {urunUyumAramaSonuc?.tarih || urunUyumAramaTarih} · {urunUyumAramaSonuc?.toplam || 0} uyumsuzluk
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setUrunUyumSeciliSubeKey('all')}
              style={{
                border: urunUyumSeciliSubeKey === 'all' ? '1px solid #8b5cf6' : '1px solid var(--border)',
                background: urunUyumSeciliSubeKey === 'all' ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg2)',
                color: urunUyumSeciliSubeKey === 'all' ? '#ddd6fe' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {urunUyumSubeSekmeleri.map((s) => (
              <button
                key={`urun-uyum-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setUrunUyumSeciliSubeKey(s.key)}
                style={{
                  border: urunUyumSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: urunUyumSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: urunUyumSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>

          {urunUyumGorunenKayitlar.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte ürün uyumsuzluğu yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflow: 'auto' }}>
              {urunUyumGorunenKayitlar.map((r) => {
                const keys = ['bardak_kucuk','bardak_buyuk','bardak_plastik','karton_bardak','su_adet','sut_litre','redbull_adet','soda_adet','cookie_adet','pasta_adet','surup_adet','kahve_paket','kapak_adet','pecete_paket','diger_sarf','pasta_porsiyon_sade','pasta_porsiyon_antep','pasta_porsiyon_cik','pasta_mag_cilek','pasta_mag_lotus','pasta_buyuk_tart','pasta_kucuk_tart','pasta_snickers','pasta_malaga','pasta_latte','pasta_muzlu_rulo','pasta_cik_rulo','pasta_meyveli_rulo','pasta_browni','pasta_dilim_ss_sade','pasta_cream_puff','pasta_kavala','pasta_cup_limon','pasta_cup_yerfistik','pasta_cup_cilek','pasta_cup_karamel','pasta_cup_lotus','pasta_cup_antep','pasta_cup_hindistan','pasta_profiterol','pasta_kare_cik','pasta_kare_yerfistik','pasta_kare_karamel','pasta_kare_limon','pasta_dilim_sade','pasta_dilim_antep','pasta_dilim_cik','pasta_dilim_yaban'];
                const labels = { bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', bardak_plastik:'Plastik', karton_bardak:'Karton Bardak', su_adet:'Su', sut_litre:'Süt', redbull_adet:'Redbull', soda_adet:'Soda', cookie_adet:'Cookie', pasta_adet:'Pasta', surup_adet:'Şurup', kahve_paket:'Kahve Pkt', kapak_adet:'Kapak', pecete_paket:'Peçete', diger_sarf:'Diğer' };
                return (
                  <div key={`${r.sube_id}-${r.tarih}`} className="card" style={{ borderLeft: '4px solid #8b5cf6', padding: '14px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.sube_adi || r.sube_id}</span>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{r.tarih}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="badge badge-red">{r.uyumsuz_adet || 0} kalem uyumsuz</span>
                        {!r.kapanis_var && <span className="badge badge-yellow">Bugün kapanış yok</span>}
                        {r.onceki_kapanis_yok && (
                          <span className="badge badge-yellow" title={r.onceki_kapanis_tarihi || ''}>
                            Önceki gün kapanışı yok ({r.onceki_kapanis_tarihi || '—'})
                          </span>
                        )}
                        {(r.uyumsuz_devir_keys || []).length > 0 && !r.onceki_kapanis_yok && (
                          <span className="badge badge-blue">Devir (dün kap ≠ bugün aç)</span>
                        )}
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)' }}>
                            <th style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, fontSize: 11 }}>Ürün</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#c4b5fd', fontWeight: 600, fontSize: 11 }} title="Bir önceki gün tamamlanmış kapanış sayımı">Önceki kapanış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600, fontSize: 11 }}>Bugün açılış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#86efac', fontWeight: 600, fontSize: 11 }}>Ürün Aç</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600, fontSize: 11 }}>Bugün kapanış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700, fontSize: 11 }}>Gün içi fark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((k) => {
                            const ac = Number(r?.acilis?.[k] || 0);
                            const ua = Number(r?.urun_ac?.[k] || 0);
                            const kap = Number(r?.kapanis?.[k] || 0);
                            const fark = Number(r?.satilan?.[k] || 0);
                            const dunKap = r?.dun_kapanis && typeof r.dun_kapanis === 'object' ? Number(r.dun_kapanis[k] || 0) : null;
                            const uyumsuzGunIci = fark < 0;
                            const uyumsuzDevir = (r.uyumsuz_devir_keys || []).includes(k)
                              || (r.onceki_kapanis_yok && dunKap === null);
                            const uyumsuz = uyumsuzGunIci || uyumsuzDevir;
                            return (
                              <tr key={k} style={{ borderTop: '1px solid var(--border)', background: uyumsuz ? 'rgba(220, 38, 38, 0.07)' : 'transparent' }}>
                                <td style={{ padding: '5px 8px', color: uyumsuz ? '#fecaca' : 'var(--text2)' }}>{labels[k] || k}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: dunKap === null ? 'var(--text3)' : '#ddd6fe' }}>
                                  {dunKap === null ? '—' : dunKap}
                                </td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center' }}>{ac}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: ua > 0 ? '#86efac' : 'var(--text3)' }}>{ua > 0 ? `+${ua}` : ua}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: kap > 0 ? '#fbbf24' : 'var(--text3)' }}>{kap > 0 ? kap : '—'}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, color: uyumsuzGunIci ? 'var(--red)' : 'var(--text3)' }}>
                                  {fark}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'sevkiyat-uyumsuzluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
            <strong style={{ color: 'var(--text2)' }}>Depo çıkış (sevk)</strong> ile{' '}
            <strong style={{ color: 'var(--text2)' }}>talep şubesi kabul</strong> adetleri farklı olan kayıtlar.
            <br />
            <span style={{ fontSize: 12, opacity: 0.95 }}>
              Bu ekran <strong>Ürün Uyumsuzlukları</strong> (bar gün içi + dün kapanış / bugün açılış devir) ile aynı değildir;
              depo sevkiyat / şube kabul farkı yalnızca bu listede ve operasyon defterinde izlenir.
            </span>
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Sipariş tarihi — geriye gün</span>
              <select
                className="input"
                value={String(Math.max(1, Math.min(120, Number(sevkiyatUyumGun) || 30)))}
                onChange={(e) => setSevkiyatUyumGun(Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 30)))}
                style={{ minWidth: 130, padding: '8px 10px' }}
              >
                {[7, 14, 21, 30, 60, 90, 120].map((g) => (
                  <option key={g} value={g}>{g} gün</option>
                ))}
              </select>
            </label>
            <div style={{ fontSize: 12, color: 'var(--text3)', paddingBottom: 8 }}>
              Liste: <strong>{(sevkiyatUyumDetay?.satirlar || []).length}</strong> satır
              {sevkiyatUyumDetay?.gun ? (
                <span className="mono" style={{ marginLeft: 8 }}>· pencere {sevkiyatUyumDetay.gun} gün</span>
              ) : null}
            </div>
          </div>

          {(sevkiyatUyumDetay?.satirlar || []).length === 0 ? (
            <div className="empty"><p>Bu aralıkta bekleyen sevkiyat uyumsuzluğu yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 560, overflow: 'auto' }}>
              {(sevkiyatUyumDetay?.satirlar || []).map((row) => {
                const yid = String(row.stok_yolda_id || '');
                const draft = sevkiyatUyumCozInputs[yid] || {};
                const sevk = Number(row.sevk_adet || 0);
                const kabul = Number(row.kabul_adet || 0);
                const fark = row.fark_adet != null ? Number(row.fark_adet) : sevk - kabul;
                const busy = sevkiyatUyumCozBusy === yid;
                return (
                  <div key={yid || row.siparis_talep_id} className="card" style={{ padding: '12px 14px', borderLeft: '4px solid #ea580c' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{row.kalem_adi || row.kalem_kodu || 'Kalem'}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                          Talep: <span className="mono">{String(row.siparis_talep_id || '').slice(0, 8)}…</span>
                          {' · '}
                          Stok yolda: <span className="mono">{yid.slice(0, 8)}…</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
                          <strong>{row.hedef_sube_adi || row.hedef_sube_id}</strong>
                          {' ← '}
                          {row.kaynak_depo_sube_adi || row.kaynak_depo_sube_id || 'Depo'}
                        </div>
                        <div style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                          <span>Sevk: <strong className="mono">{sevk}</strong></span>
                          <span>Kabul: <strong className="mono">{kabul}</strong></span>
                          <span style={{ color: fark !== 0 ? 'var(--red)' : 'var(--text2)' }}>
                            Fark: <strong className="mono">{fark >= 0 ? '+' : ''}{fark}</strong>
                          </span>
                          {row.durum ? <span className="badge badge-yellow">{String(row.durum)}</span> : null}
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                          Sipariş tarihi {row.tarih || '—'} · Sevk {String(row.sevk_ts || '').replace('T', ' ').slice(0, 16)}
                          {row.kabul_ts ? ` · Kabul ${String(row.kabul_ts).replace('T', ' ').slice(0, 16)}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', minWidth: 200 }}>
                        <label style={{ margin: 0, fontSize: 11, color: 'var(--text3)' }}>
                          Uzlaşılan adet (tek doğru sayı)
                          <input
                            type="number"
                            min={0}
                            className="input"
                            disabled={busy}
                            placeholder="Örn. 5"
                            value={draft.cozum_adet != null ? draft.cozum_adet : ''}
                            onChange={(e) => setSevkiyatUyumCozInputs((prev) => ({
                              ...prev,
                              [yid]: { ...prev[yid], cozum_adet: e.target.value },
                            }))}
                            style={{ width: '100%', marginTop: 4, padding: '6px 8px' }}
                          />
                        </label>
                        <label style={{ margin: 0, fontSize: 11, color: 'var(--text3)' }}>
                          Not (opsiyonel)
                          <input
                            type="text"
                            className="input"
                            disabled={busy}
                            value={draft.notu != null ? draft.notu : ''}
                            onChange={(e) => setSevkiyatUyumCozInputs((prev) => ({
                              ...prev,
                              [yid]: { ...prev[yid], notu: e.target.value },
                            }))}
                            style={{ width: '100%', marginTop: 4, padding: '6px 8px' }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: 4 }}
                          disabled={busy || !yid}
                          onClick={() => {
                            const d = sevkiyatUyumCozInputs[yid] || {};
                            const raw = String(d.cozum_adet != null ? d.cozum_adet : '').trim();
                            const coz = parseInt(raw.replace(/\D/g, ''), 10);
                            if (Number.isNaN(coz) || coz < 0) {
                              toast('Geçerli uzlaşılan adet girin (0 veya pozitif tam sayı).', 'yellow');
                              return;
                            }
                            sevkiyatUyumsuzlukCoz(yid, coz, d.notu);
                          }}
                        >
                          {busy ? 'Kaydediliyor…' : 'Uzlaştır ve stokları düzelt'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'siparis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Bu sekmede <strong>sipariş kataloğu</strong> yönetilir (kategori, ürün ekleme ve aktif / pasif).
            Şubelerden gelen bekleyen siparişleri işlemek için hub'daki <strong>Şube sipariş</strong> kartına veya{' '}
            <strong>Stok Disiplin › Sipariş kuyruğu</strong> ekranına gidin; sevkiyat ve depo yönlendirme orada yapılır.
          </p>

          <section className="card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div>
                <h3 style={{ fontSize: 14, marginBottom: 6 }}>Ozel urun talepleri</h3>
                <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
                  Sube katalogda bulamadigi urunleri burada merkeze iletir. <strong>Kataloga al</strong> kalici urun ekler;
                  <strong> Tek sefer siparis</strong> ise katalog degistirmeden sadece bu talebi kuyruga cevirir.
                </p>
              </div>
              <span className={`badge ${(sipOzelBekleyen || []).length > 0 ? 'badge-yellow' : 'badge-green'}`}>
                {(sipOzelBekleyen || []).length > 0 ? `${(sipOzelBekleyen || []).length} bekliyor` : 'Bekleyen yok'}
              </span>
            </div>

            {(sipOzelBekleyen || []).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                Bekleyen ozel urun talebi yok.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(sipOzelBekleyen || []).map((t) => {
                  const kategori = (sipKat || []).find((k) => String(k?.id || '') === String(t?.kategori_kod || ''));
                  const kartBusy = String(sipOzelBusyId || '').startsWith(`${t.id}:`);
                  const talepNotu = String(t?.not_aciklama || '').trim();
                  return (
                    <div
                      key={t.id}
                      className="card"
                      style={{
                        padding: '12px 14px',
                        border: '1px solid var(--border)',
                        background: 'rgba(250, 204, 21, 0.04)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <div style={{ fontSize: 14, fontWeight: 700 }}>
                            {t.urun_adi || 'Adsiz urun'}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                            {t.sube_adi || t.sube_id || 'Sube bilinmiyor'}
                            {t.adet ? ` · ${t.adet} adet` : ''}
                            {kategori ? ` · ${kategori.label || kategori.ad}` : (t.kategori_kod ? ` · ${t.kategori_kod}` : '')}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                            {t.tarih || 'Tarih yok'}
                            {t.bildirim_saati ? ` · ${t.bildirim_saati}` : ''}
                            {t.personel_ad ? ` · ${t.personel_ad}` : ''}
                          </div>
                        </div>
                        <span className="badge badge-yellow">Karar bekliyor</span>
                      </div>

                      {talepNotu ? (
                        <div
                          style={{
                            marginTop: 10,
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--border)',
                            background: 'rgba(15, 23, 42, 0.24)',
                            fontSize: 12,
                            lineHeight: 1.45,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          <span style={{ color: 'var(--text3)', fontWeight: 600 }}>Sube notu: </span>
                          {talepNotu}
                        </div>
                      ) : null}

                      <label style={{ margin: '10px 0 0', display: 'block' }}>
                        <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Merkez notu</span>
                        <textarea
                          className="input"
                          rows={2}
                          disabled={!!sipOzelBusyId}
                          placeholder="Katalog karari, tek sefer notu veya red nedeni..."
                          style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
                          value={sipOzelNotMap[t.id] || ''}
                          onChange={(e) => setSipOzelNotMap((prev) => ({ ...prev, [t.id]: e.target.value }))}
                        />
                      </label>

                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!!sipOzelBusyId}
                          onClick={() => siparisOzelIslemYap(t, 'katalog')}
                        >
                          {sipOzelBusyId === `${t.id}:katalog` ? 'Kaydediliyor...' : 'Kataloga al'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!!sipOzelBusyId}
                          onClick={() => siparisOzelIslemYap(t, 'tek_sefer')}
                        >
                          {sipOzelBusyId === `${t.id}:tek_sefer` ? 'Kuyruga aktariliyor...' : 'Tek sefer siparis'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!!sipOzelBusyId}
                          style={{ borderColor: 'rgba(239, 68, 68, 0.45)', color: '#fca5a5' }}
                          onClick={() => siparisOzelIslemYap(t, 'red')}
                        >
                          {sipOzelBusyId === `${t.id}:red` ? 'Reddediliyor...' : 'Reddet'}
                        </button>
                        {kartBusy && (
                          <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center' }}>
                            Islem tamamlaninca liste ve hub otomatik yenilenir.
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {(depoSevkiyatRaporlari || []).length > 0 && (
            <section
              className="card"
              style={{
                padding: '14px 16px',
                borderLeft: '4px solid #ea580c',
                background: 'rgba(234, 88, 12, 0.06)',
              }}
            >
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                📋 Depo kalem raporu (isten / gönderilen)
              </h3>
              <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0, marginBottom: 12 }}>
                Şube deposu kalemleri işlediğinde otomatik özet yazılır. Eksik veya kısmi satırlarda hub uyarısı da oluşur.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflow: 'auto' }}>
                {(depoSevkiyatRaporlari || []).map((r) => (
                  <div
                    key={r.id}
                    className="card"
                    style={{
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      fontSize: 12,
                      lineHeight: 1.45,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      {r.talep_sube_adi || r.sube_id}
                      {r.depo_personel_ad ? (
                        <span style={{ fontWeight: 500, color: 'var(--text3)', marginLeft: 8 }}>
                          · {r.depo_personel_ad}
                        </span>
                      ) : null}
                      <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: 8 }}>
                        {(r.depo_sevkiyat_rapor_ts || '').substring(0, 16)}
                      </span>
                      {r.depo_sevkiyat_rapor_uyari ? (
                        <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
                          Eksik/kısmi
                        </span>
                      ) : (
                        <span className="badge badge-green" style={{ marginLeft: 8 }}>
                          Kayıtlı özet
                        </span>
                      )}
                    </div>
                    <div>{r.depo_sevkiyat_rapor_metni || '—'}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <section className="card" style={{ padding: '14px 16px' }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Kataloga ürün ekle</h3>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Kategori (kod)</label>
                <select
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniUrun.kategori_kod}
                  onChange={(e) => setSipYeniUrun({ ...sipYeniUrun, kategori_kod: e.target.value })}
                >
                  <option value="">Seçin</option>
                  {sipKat.map((k) => (
                    <option key={k.id} value={k.id}>{k.label || k.ad}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Ürün adı</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniUrun.urun_adi}
                  onChange={(e) => setSipYeniUrun({ ...sipYeniUrun, urun_adi: e.target.value })}
                  placeholder="Örn: Pil"
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!sipYeniUrun.kategori_kod || !sipYeniUrun.urun_adi.trim()}
                onClick={async () => {
                  try {
                    await api('/ops/siparis/urun', { method: 'POST', body: sipYeniUrun });
                    toast('Ürün eklendi', 'green');
                    setSipYeniUrun({ kategori_kod: '', urun_adi: '' });
                    await yukleSiparisMerkez();
                  } catch (e) { toast(e.message || 'Hata'); }
                }}
              >Ekle / aktif et</button>
            </section>

            <section className="card" style={{ padding: '14px 16px' }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Yeni kategori</h3>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Kategori adı</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniKat.ad}
                  onChange={(e) => setSipYeniKat({ ...sipYeniKat, ad: e.target.value })}
                  placeholder="Örn: Elektronik"
                />
              </div>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Emoji (opsiyonel)</label>
                <input
                  className="input"
                  style={{ width: 100 }}
                  value={sipYeniKat.emoji}
                  onChange={(e) => setSipYeniKat({ ...sipYeniKat, emoji: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!sipYeniKat.ad.trim()}
                onClick={async () => {
                  try {
                    await api('/ops/siparis/kategori', { method: 'POST', body: sipYeniKat });
                    toast('Kategori oluşturuldu', 'green');
                    setSipYeniKat({ ad: '', emoji: '📦' });
                    await yukleSiparisMerkez();
                  } catch (e) { toast(e.message || 'Hata'); }
                }}
              >Kategori tanımla</button>
            </section>
          </div>

          <section className="card" style={{ padding: '14px 16px' }}>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Ürün aktif / pasif</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0 }}>Kategori seçip ürün satırında durumu değiştirin.</p>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {sipKat.map((k) => (
                <div key={k.id} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{k.label || k.ad}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(k.items || []).map((it) => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                        <span>{it.ad} {it.aktif === false ? <span className="badge badge-gray">pasif</span> : <span className="badge badge-green">aktif</span>}</span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={async () => {
                            try {
                              await api('/ops/siparis/urun-durum', {
                                method: 'POST',
                                body: { kategori_kod: k.id, urun_id: it.id, aktif: !it.aktif },
                              });
                              toast('Güncellendi', 'green');
                              await yukleSiparisMerkez();
                            } catch (e) { toast(e.message || 'Hata'); }
                          }}
                        >{it.aktif === false ? 'Aktif et' : 'Pasif et'}</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {aktifSekme === 'siparis-kabul-takip' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şube panelinde yapılan ürün teslim/kabul kayıtları burada izlenir. Satırlar operasyon defterindeki{' '}
            <code style={{ fontSize: 11 }}>URUN_SEVK</code> kayıtlarından üretilir.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</span>
              <select
                className="input"
                value={String(siparisKabulTakipGun)}
                onChange={(e) => setSiparisKabulTakipGun(Number(e.target.value || 14))}
              >
                <option value="1">Son 1 gün</option>
                <option value="3">Son 3 gün</option>
                <option value="7">Son 7 gün</option>
                <option value="14">Son 14 gün</option>
                <option value="30">Son 30 gün</option>
              </select>
            </label>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube</span>
              <select
                className="input"
                value={siparisKabulTakipSube}
                onChange={(e) => setSiparisKabulTakipSube(e.target.value)}
              >
                <option value="">Tümü</option>
                {(subeListeAdmin || []).map((s) => (
                  <option key={`sk-sub-${s.id}`} value={s.id}>{s.ad || s.id}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukleSiparisKabulTakip(); }}>
              Filtreyi uygula
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            Son {Number(siparisKabulTakip?.gun || 14)} gün · {Array.isArray(siparisKabulTakip?.satirlar) ? siparisKabulTakip.satirlar.length : 0} kayıt
          </div>
          {!Array.isArray(siparisKabulTakip?.satirlar) || siparisKabulTakip.satirlar.length === 0 ? (
            <div className="empty"><p>Kabul kaydı yok.</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 520, overflow: 'auto' }}>
              {siparisKabulTakip.satirlar.map((r) => (
                <div
                  key={r.id}
                  className="card"
                  style={{ padding: '12px 14px', borderLeft: '4px solid #2db573' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {r.sube_adi || r.sube_id}
                        <span className="badge badge-green" style={{ marginLeft: 8 }}>
                          {Number(r?.toplam_adet || 0)} adet
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>
                        {(r.tarih || '—')} {(r.saat || '—')} · {r.personel_ad || r.personel_id || 'Personel ?'}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text2)', textAlign: 'right' }}>
                      {r.ozet || '—'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'toptanci-siparisleri' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Bu liste operasyon defterindeki <code style={{ fontSize: 11 }}>SIPARIS_TOPTANCI_YONLENDIRME</code> kayıtlarından üretilir ve kategori/ürün bazında gruplanır.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</span>
              <select
                className="input"
                value={String(toptanciSiparisGun)}
                onChange={(e) => setToptanciSiparisGun(Number(e.target.value || 30))}
              >
                <option value="7">Son 7 gün</option>
                <option value="14">Son 14 gün</option>
                <option value="30">Son 30 gün</option>
                <option value="60">Son 60 gün</option>
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukleToptanciSiparisleri(); }}>
              Filtreyi uygula
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const rows = Array.isArray(toptanciSiparisListe?.satirlar) ? toptanciSiparisListe.satirlar : [];
                const tsv = [
                  ['Kategori', 'Ürün', 'Toplam adet'].join('\t'),
                  ...rows.map((r) => [
                    String(r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || ''),
                    String(r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || ''),
                    String(Number(r?.toplam_adet || r?.adet || r?.miktar || 0)),
                  ].join('\t')),
                ].join('\n');
                const blob = new Blob([`﻿${tsv}`], { type: 'application/vnd.ms-excel;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `toptanci_siparisleri_son_${Number(toptanciSiparisListe?.gun || toptanciSiparisGun || 30)}_gun.xls`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }}
            >
              Excel indir
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const rows = Array.isArray(toptanciSiparisListe?.satirlar) ? toptanciSiparisListe.satirlar : [];
                const w = window.open('', '_blank', 'noopener,noreferrer,width=900,height=700');
                if (!w) {
                  toast('PDF penceresi açılamadı.');
                  return;
                }
                const esc = (v) => String(v ?? '')
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#39;');
                const bodyRows = rows.map((r) => (
                  `<tr><td>${esc(r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || '')}</td><td>${esc(r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || '')}</td><td style="text-align:right;">${esc(Number(r?.toplam_adet || r?.adet || r?.miktar || 0))}</td></tr>`
                )).join('');
                w.document.write(`<!doctype html><html><head><meta charset="utf-8" /><title>Toptancı Siparişleri</title><style>body{font-family:Arial,sans-serif;padding:20px;color:#111}h1{font-size:18px;margin:0 0 12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d0d0d0;padding:8px;font-size:12px;text-align:left}th{background:#f5f5f5}</style></head><body><h1>Toptancı Siparişleri (Son ${esc(Number(toptanciSiparisListe?.gun || toptanciSiparisGun || 30))} gün)</h1><table><thead><tr><th>Kategori</th><th>Ürün</th><th>Toplam adet</th></tr></thead><tbody>${bodyRows || '<tr><td colspan="3">Kayıt yok</td></tr>'}</tbody></table></body></html>`);
                w.document.close();
                w.focus();
                w.print();
              }}
            >
              PDF indir
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            Son {Number(toptanciSiparisListe?.gun || toptanciSiparisGun || 30)} gün · {Number(toptanciSiparisListe?.toplam_kayit || 0)} kayıt · {Array.isArray(toptanciSiparisListe?.satirlar) ? toptanciSiparisListe.satirlar.length : 0} ürün satırı
          </div>
          {!Array.isArray(toptanciSiparisListe?.satirlar) || toptanciSiparisListe.satirlar.length === 0 ? (
            <div className="empty"><p>Kategori bazlı toptancı sipariş satırı yok.</p></div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ maxHeight: 520, overflow: 'auto' }}>
                <table className="table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Kategori</th>
                      <th>Ürün</th>
                      <th style={{ textAlign: 'right' }}>Toplam adet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toptanciSiparisListe.satirlar.map((r, idx) => (
                      <tr key={`${String(r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || 'kat')}-${String(r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || idx)}-${idx}`}>
                        <td>{r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || '—'}</td>
                        <td>{r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{Number(r?.toplam_adet || r?.adet || r?.miktar || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'toptanci-teslimler' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şubelerin tedarikçi/toptancıdan teslim aldığı ürünler — şube panelindeki <strong>Ürün Teslim Al → Toptancı/Tedarikçi</strong> formu kayıtları.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</span>
              <select
                className="input"
                value={String(toptanciTeslimGun)}
                onChange={(e) => setToptanciTeslimGun(Number(e.target.value || 30))}
              >
                <option value="7">Son 7 gün</option>
                <option value="14">Son 14 gün</option>
                <option value="30">Son 30 gün</option>
                <option value="60">Son 60 gün</option>
                <option value="90">Son 90 gün</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setYukleniyor(true); yukleToptanciTeslimler(); }}
            >
              Filtreyi uygula
            </button>
          </div>
          {toptanciTeslimListe && (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Son {toptanciTeslimListe.gun} gün · {toptanciTeslimListe.toplam_sube} şube
            </div>
          )}
          {!toptanciTeslimListe || toptanciTeslimListe.subeler.length === 0 ? (
            <div className="empty"><p>Bu dönemde tedarikçi teslimi kayıtlı şube yok.</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {toptanciTeslimListe.subeler.map((sube) => {
                const isAcik = toptanciTeslimAcikSube === sube.sube_id;
                return (
                  <div
                    key={sube.sube_id}
                    className="card"
                    style={{ padding: 0, overflow: 'hidden' }}
                  >
                    <button
                      type="button"
                      style={{
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '12px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        textAlign: 'left',
                        borderBottom: isAcik ? '1px solid var(--border)' : 'none',
                      }}
                      onClick={() => setToptanciTeslimAcikSube(isAcik ? null : sube.sube_id)}
                    >
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text1)' }}>
                          {sube.sube_adi}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>
                          {sube.toplam} teslim · son: {sube.son_tarih || '—'}
                        </span>
                      </div>
                      <span style={{ fontSize: 16, color: 'var(--text3)', flexShrink: 0 }}>
                        {isAcik ? '▲' : '▼'}
                      </span>
                    </button>
                    {isAcik && (
                      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {(sube.teslimler || []).length === 0 ? (
                          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>Teslim kaydı yok.</p>
                        ) : (
                          (sube.teslimler || []).map((t, ti) => (
                            <div
                              key={t.id || ti}
                              style={{
                                background: 'var(--bg2)',
                                borderRadius: 8,
                                padding: '10px 12px',
                                borderLeft: `3px solid ${t.teslim_durumu === 'eksik_var' ? '#f59e0b' : '#22c55e'}`,
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <div>
                                  <span style={{ fontWeight: 700, fontSize: 13 }}>{t.tedarikci}</span>
                                  {t.teslim_durumu === 'eksik_var' && (
                                    <span style={{ marginLeft: 8, fontSize: 11, background: 'rgba(245,158,11,.2)', color: '#f59e0b', borderRadius: 4, padding: '1px 6px' }}>
                                      eksik var
                                    </span>
                                  )}
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                                  {t.olay_ts || t.tarih}
                                </span>
                              </div>
                              {t.kalemler.length > 0 ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                                  {t.kalemler.map((k, ki) => (
                                    <span key={ki} style={{ fontSize: 12, color: 'var(--text2)' }}>
                                      {k.ad} <strong>×{k.adet}</strong>
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span style={{ fontSize: 12, color: 'var(--text3)' }}>Kalem detayı yok</span>
                              )}
                            </div>
                          ))
                        )}
                        {sube.toplam > 5 && (
                          <p style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>
                            Son 5 teslim gösteriliyor · toplam {sube.toplam} teslim bu dönemde
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'onay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
              Bu ekranda yalnızca şube kaynaklı iki ana onay akışı tutulur: <strong>ciro onayları</strong> ve <strong>anlık gider onayları</strong>.
              Anlık gider onaylandığında talep kuyruktan düşer; ciro onaylandığında kayıt resmi ciro + kasa akışına yazılır.
            </p>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 20, padding: '3px 12px', fontSize: 12, color: 'var(--text2)',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              📅 {ayFiltre} görüntüleniyor
            </span>
          </div>

          {yukleniyor && !bekleyenPaket ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : (
            <>
              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Şube onaylamaları · Ciro onayı (bekleyen) — {bekleyenPaket?.ozet?.ciro_taslak ?? 0}</h3>
                {(bekleyenPaket?.ciro_taslaklari || []).length === 0 ? (
                  <div className="empty"><p>Bekleyen ciro taslağı yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.ciro_taslaklari.map((t) => (
                      <div
                        key={t.id}
                        className="card"
                        style={{ padding: '12px 14px', borderLeft: '4px solid var(--yellow)' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{t.sube_adi || t.sube_id}</div>
                            <div className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>
                              {t.tarih} · Nakit {fmt(t.nakit)} · POS {fmt(t.pos)} · Online {fmt(t.online)}
                            </div>
                            {t.aciklama && <div style={{ fontSize: 12, marginTop: 4 }}>{t.aciklama}</div>}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => ciroTaslakOnayla(t.id)}
                            >
                              {onayBusyId === `c:${t.id}` ? '…' : 'Onayla → ciro'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => ciroTaslakReddet(t.id)}
                            >
                              {onayBusyId === `cr:${t.id}` ? '…' : 'Reddet'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>
                  Kasa uyumsuzlukları (çözüm bekleyen) · {bekleyenPaket?.ozet?.kasa_uyumsuzluk ?? 0}
                </h3>
                {(bekleyenPaket?.kritik_kasa_personelleri || []).length > 0 && (
                  <div className="alert-box red" style={{ marginBottom: 10 }}>
                    Kritik personel izleme ({bekleyenPaket?.ozet?.kritik_kasa_personel ?? 0}):{' '}
                    {(bekleyenPaket?.kritik_kasa_personelleri || [])
                      .slice(0, 6)
                      .map((p) => `${p.personel_ad || p.personel_id} (${p.aylik_hata_adet})`)
                      .join(' · ')}
                  </div>
                )}
                {(bekleyenPaket?.kasa_uyumsuzluklar || []).length === 0 ? (
                  <div className="empty"><p>Çözüm bekleyen kasa uyumsuzluğu yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.kasa_uyumsuzluklar.map((u) => {
                      const fark = Number(u.fark_tl || 0);
                      const farkPozitif = fark >= 0;
                      return (
                        <div
                          key={u.id}
                          className="card"
                          style={{ padding: '12px 14px', borderLeft: `4px solid ${Math.abs(fark) >= 200 ? 'var(--red)' : 'var(--yellow)'}` }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {u.sube_adi || u.sube_id}
                                <span style={{ marginLeft: 8 }} className={`badge ${Math.abs(fark) >= 200 ? 'badge-red' : 'badge-yellow'}`}>
                                  {farkPozitif ? '+' : ''}{fmt(fark)}
                                </span>
                                {u.kritik_personel_var && (
                                  <span style={{ marginLeft: 6 }} className="badge badge-red">Kritik personel</span>
                                )}
                              </div>
                              <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                                {u.tarih} · Beklenen: {fmt(u.beklenen_tl || 0)} · Açılış Sayım: {fmt(u.gercek_tl || 0)}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                                Açılış: {u.acilis_personel_ad || u.acilis_personel_id || '—'}
                                {!!u.acilis_personel_aylik_hata_adet && (
                                  <span className={`badge ${u.acilis_personel_aylik_hata_adet >= 2 ? 'badge-red' : 'badge-gray'}`} style={{ marginLeft: 6 }}>
                                    Ay içi hata: {u.acilis_personel_aylik_hata_adet}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                                Önceki kapanış: {u.kapanis_personel_ad || u.kapanis_personel_id || '—'}
                                {!!u.kapanis_personel_aylik_hata_adet && (
                                  <span className={`badge ${u.kapanis_personel_aylik_hata_adet >= 2 ? 'badge-red' : 'badge-gray'}`} style={{ marginLeft: 6 }}>
                                    Ay içi hata: {u.kapanis_personel_aylik_hata_adet}
                                  </span>
                                )}
                              </div>
                              {u.mesaj && <div style={{ fontSize: 12, marginTop: 6 }}>{u.mesaj}</div>}
                            </div>
                            <div>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={!!onayBusyId}
                                onClick={() => kasaUyumsuzlukCoz(u.id)}
                              >
                                {onayBusyId === `ku:${u.id}` ? '…' : 'Çözüldü işaretle'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>
                  Anlık gider onayları (bekleyen)
                  {subeOnayFiltre ? ' — sadece bu şube' : ' — tüm şubeler'}
                  {' · '}
                  {anlikGiderOnaylari.length}
                </h3>
                {anlikGiderOnaylari.length === 0 ? (
                  <div className="empty"><p>Bekleyen anlık gider onayı yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {anlikGiderOnaylari.map((o) => (
                      <div
                        key={o.id}
                        className="card"
                        style={{
                          padding: '12px 14px',
                          borderLeft: '4px solid var(--yellow)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {ONAY_TURU_LABEL[o.islem_turu] || o.islem_turu}
                              {o.sube_adi && (
                                <span style={{ fontWeight: 500, color: 'var(--text3)', marginLeft: 8 }}>{o.sube_adi}</span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{o.aciklama}</div>
                            <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>{fmt(o.tutar)} · {o.tarih}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => kuyrukOnayla(o.id, o.islem_turu)}
                            >
                              {onayBusyId === `o:${o.id}` ? '…' : 'Onayla'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => kuyrukReddet(o.id, o.islem_turu)}
                            >
                              {onayBusyId === `or:${o.id}` ? '…' : 'Reddet'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Şube notları (iade, sorun, bilgi)</h3>
                {notlarListe.length === 0 ? (
                  <div className="empty"><p>Bu filtrede not yok</p></div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Zaman</th>
                          <th>Şube</th>
                          <th>Personel</th>
                          <th>Not</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notlarListe.map((n) => (
                          <tr key={n.id}>
                            <td className="mono" style={{ fontSize: 11 }}>{(n.olusturma || '').replace('T', ' ').slice(0, 19)}</td>
                            <td>{n.sube_adi || n.sube_id}</td>
                            <td style={{ fontSize: 12 }}>{n.personel_ad || n.personel_id || '—'}</td>
                            <td style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{n.metin}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}

      {/* ANALİTİK SEKMESİ */}
      {aktifSekme === 'analitik' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text3)' }}>Son</span>
            {[14, 30, 60, 90].map(g => (
              <button key={g}
                className={`btn btn-sm${analitikGun === g ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => { setAnalitikGun(g); setYukleniyor(true); }}
              >{g} gün</button>
            ))}
          </div>
          {!analitikVeri ? (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>Yükleniyor…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 12 }}>
                {[
                  { label: 'Başarı Oranı', val: analitikVeri.basari_orani + '%', color: analitikVeri.basari_orani >= 80 ? '#22c55e' : analitikVeri.basari_orani >= 60 ? '#f59e0b' : '#ef4444' },
                  { label: 'Toplam Sipariş', val: analitikVeri.toplam_siparis, color: '#6366f1' },
                  { label: 'Tamamlandı', val: analitikVeri.tamamlandi, color: '#22c55e' },
                  { label: 'Uyuşmazlık', val: analitikVeri.uyusmazlik, color: '#ef4444' },
                  { label: 'İptal', val: analitikVeri.iptal, color: '#94a3b8' },
                  { label: 'Ort. Süre (saat)', val: analitikVeri.ort_sure_saat, color: '#0ea5e9' },
                ].map(({ label, val, color }) => (
                  <div key={label} className="card" style={{ padding: '12px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{label}</div>
                  </div>
                ))}
              </div>
              {(analitikVeri.sube_performans || []).length > 0 && (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Şube Performansı</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {analitikVeri.sube_performans.map((s, i) => {
                      const oran = s.toplam > 0 ? Math.round(s.basarili / s.toplam * 100) : 0;
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px 50px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                          <span style={{ fontWeight: 600 }}>{s.sube_adi || s.sube_id}</span>
                          <span style={{ color: 'var(--text3)' }}>Top: {s.toplam}</span>
                          <span style={{ color: '#22c55e' }}>✓ {s.basarili}</span>
                          <span style={{ color: '#ef4444' }}>⚠ {s.uyusmazlik}</span>
                          <span style={{ fontWeight: 700, color: oran >= 80 ? '#22c55e' : oran >= 60 ? '#f59e0b' : '#ef4444' }}>{oran}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {(analitikVeri.tedarikciler || []).length > 0 && (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Tedarikçi Teslimat Sayısı</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {analitikVeri.tedarikciler.map((t, i) => (
                      <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 12px', fontSize: 12 }}>
                        <strong>{t.tedarikci}</strong> <span style={{ color: 'var(--text3)' }}>× {t.teslimat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* STOK TAHMİN SEKMESİ */}
      {aktifSekme === 'stok-tahmin' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text3)' }}>Analiz periyodu</span>
            {[7, 14, 30].map(g => (
              <button key={g}
                className={`btn btn-sm${stokTahminGun === g ? ' btn-primary' : ' btn-ghost'}`}
                onClick={() => { setStokTahminGun(g); setYukleniyor(true); }}
              >{g} gün</button>
            ))}
          </div>
          {!stokTahminVeri ? (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>Yükleniyor…</div>
          ) : stokTahminVeri.tahminler.length === 0 ? (
            <div className="card" style={{ padding: 14, color: 'var(--text3)', fontSize: 13 }}>Yeterli tüketim verisi bulunamadı. Daha uzun periyot seçin veya şubeler ürün aç kaydı oluştursun.</div>
          ) : (
            <div className="card" style={{ padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>7 Günlük Stok Tahmini</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {stokTahminVeri.tahminler.map((t, i) => (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 80px 80px 80px 70px', gap: 8, alignItems: 'center', fontSize: 12,
                    padding: '6px 8px', borderRadius: 8,
                    background: t.uyari ? 'rgba(239,68,68,.08)' : 'var(--bg2)',
                    border: t.uyari ? '1px solid rgba(239,68,68,.3)' : '1px solid var(--border)',
                  }}>
                    <span style={{ fontWeight: 600 }}>{t.uyari ? '⚠️ ' : ''}{t.urun_ad}</span>
                    <span style={{ color: 'var(--text3)' }}>Ort: {t.ort_gunluk_tuketim}/gün</span>
                    <span style={{ color: '#6366f1' }}>7g: {t.tahmin_7gun}</span>
                    {t.mevcut_stok != null ? (
                      <span style={{ color: t.uyari ? '#ef4444' : '#22c55e' }}>Stok: {t.mevcut_stok}</span>
                    ) : <span />}
                    <span style={{ fontSize: 11, color: t.trend === 'artiyor' ? '#f59e0b' : t.trend === 'dusuyor' ? '#22c55e' : 'var(--text3)' }}>
                      {t.trend === 'artiyor' ? '↑ artıyor' : t.trend === 'dusuyor' ? '↓ düşüyor' : '→ sabit'}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10 }}>Güncelleme: {stokTahminVeri.guncelleme} · {stokTahminVeri.gun} günlük tüketim verisine dayalı tahmin.</div>
            </div>
          )}
        </div>
      )}

      {/* MERKEZ MESAJ SEKMESİ */}
      {aktifSekme === 'mesaj' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Şubeye Mesaj Gönder</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
              Gönderilen mesajlar şube panelinde yanıp söner. Personel PIN ile onaylayana kadar kapanış yapılamaz.
              <strong> Gösterim süresi</strong> dolunca mesaj şube listesinden kalkar (kayıt silinmez).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={mesajTumSubeler}
                  onChange={(e) => setMesajTumSubeler(e.target.checked)}
                />
                <span>
                  <strong>Tüm aktif şubelere gönder</strong>
                  <span style={{ color: 'var(--text3)', fontWeight: 400 }}>
                    {' '}
                    ({subeListeAdmin.length} şube — tek tek şube seçmek için kutuyu kapatın)
                  </span>
                </span>
              </label>
              <div className="form-group" style={{ margin: 0 }}>
                <label>{mesajTumSubeler ? 'Şube (tek gönderim için)' : 'Şube *'}</label>
                <select
                  value={mesajForm.sube_id}
                  disabled={mesajTumSubeler}
                  onChange={(e) => setMesajForm({ ...mesajForm, sube_id: e.target.value })}
                  style={mesajTumSubeler ? { opacity: 0.65 } : undefined}
                >
                  <option value="">Seçin</option>
                  {subeListeAdmin.map((s) => (
                    <option key={s.id} value={s.id}>{s.ad || s.id}</option>
                  ))}
                </select>
                {subeListeAdmin.length === 0 && (
                  <p style={{ fontSize: 11, color: '#b45309', margin: '6px 0 0' }}>
                    Şube listesi yüklenemedi veya kayıt yok. Sayfayı yenileyin; sorun sürerse <code style={{ fontSize: 10 }}>/api/subeler</code> erişimini kontrol edin.
                  </p>
                )}
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Öncelik</label>
                <select value={mesajForm.oncelik} onChange={e => setMesajForm({ ...mesajForm, oncelik: e.target.value })}>
                  <option value="normal">Normal</option>
                  <option value="kritik">Kritik 🚨</option>
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Şubede listelenme süresi (saat)</label>
                <input
                  type="number"
                  min={1}
                  max={8760}
                  value={mesajForm.ttl_saat}
                  onChange={e => setMesajForm({ ...mesajForm, ttl_saat: Math.max(1, Math.min(8760, parseInt(e.target.value, 10) || 72)) })}
                  style={{ width: 120, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', color: 'var(--text)', fontSize: 13 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>Oluşturulduktan sonra (varsayılan 72)</span>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Mesaj *</label>
                <textarea rows={3} value={mesajForm.mesaj} onChange={e => setMesajForm({ ...mesajForm, mesaj: e.target.value })} placeholder="Şubeye iletmek istediğiniz mesaj..." style={{ width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 12px', color: 'var(--text)', fontSize: 13 }} />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  mesajBusy
                  || !mesajForm.mesaj.trim()
                  || (!mesajTumSubeler && !mesajForm.sube_id)
                  || (mesajTumSubeler && subeListeAdmin.length === 0)
                }
                onClick={async () => {
                  const bodyBase = {
                    mesaj: mesajForm.mesaj,
                    oncelik: mesajForm.oncelik,
                    ttl_saat: mesajForm.ttl_saat,
                  };
                  setMesajBusy(true);
                  try {
                    if (mesajTumSubeler) {
                      const ids = subeListeAdmin.map((s) => String(s.id || '').trim()).filter(Boolean);
                      if (!ids.length) {
                        toast('Gönderilecek aktif şube yok.', 'red');
                        setMesajBusy(false);
                        return;
                      }
                      let ok = 0;
                      const hatalar = [];
                      for (const sid of ids) {
                        try {
                          await api('/ops/merkez-mesaj-gonder', { method: 'POST', body: { ...bodyBase, sube_id: sid } });
                          ok += 1;
                        } catch (e) {
                          hatalar.push(`${sid}: ${e?.message || 'hata'}`);
                        }
                      }
                      if (ok === ids.length) {
                        toast(`${ok} şubeye mesaj gönderildi`, 'green');
                      } else if (ok > 0) {
                        toast(`${ok}/${ids.length} şube tamam; bazıları başarısız: ${hatalar.slice(0, 2).join('; ')}`, 'red');
                      } else {
                        toast(hatalar[0] || 'Hiçbir şubeye gönderilemedi', 'red');
                      }
                    } else {
                      await api('/ops/merkez-mesaj-gonder', { method: 'POST', body: mesajForm });
                      toast('Mesaj gönderildi', 'green');
                    }
                    setMesajForm({ sube_id: '', mesaj: '', oncelik: 'normal', ttl_saat: 72 });
                    const r = await api('/ops/merkez-mesajlar?limit=100');
                    setMesajListe(r.satirlar || []);
                  } catch (e) {
                    toast(e.message || 'Hata');
                  }
                  setMesajBusy(false);
                }}
              >
                {mesajBusy ? '…' : mesajTumSubeler ? 'Tüm şubelere gönder' : 'Gönder'}
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zaman</th>
                  <th>Şube</th>
                  <th>Öncelik</th>
                  <th>Mesaj</th>
                  <th>Süre (sa)</th>
                  <th>Durum</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mesajListe.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty"><p>Henüz mesaj gönderilmedi</p></div></td></tr>
                ) : mesajListe.map(m => (
                  <tr key={m.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{(m.olusturma || '').slice(0, 16)}</td>
                    <td style={{ fontWeight: 500 }}>{m.sube_adi || m.sube_id}</td>
                    <td>{m.oncelik === 'kritik' ? <span className="badge badge-red">Kritik</span> : <span className="badge badge-gray">Normal</span>}</td>
                    <td style={{ fontSize: 12, maxWidth: 300 }}>{m.mesaj}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{m.ttl_saat != null ? m.ttl_saat : '—'}</td>
                    <td>{m.okundu
                      ? <span className="badge badge-green">✓ Okundu — {m.okuyan_ad || '?'}</span>
                      : <span className="badge badge-yellow">Bekliyor</span>}
                    </td>
                    <td>
                      <button type="button" className="btn btn-danger btn-sm" onClick={async () => {
                        try {
                          await api(`/ops/merkez-mesaj/${m.id}`, { method: 'DELETE' });
                          const r = await api('/ops/merkez-mesajlar?limit=100');
                          setMesajListe(r.satirlar || []);
                        } catch (e) { toast(e.message || 'Silinemedi'); }
                      }}>Kaldır</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PERSONEL PUAN SEKMESİ */}
      {aktifSekme === 'puan' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube</span>
              <select
                style={{ padding: '8px 10px', minWidth: 200, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontSize: 13 }}
                value={puanSubeFiltre}
                onChange={e => setPuanSubeFiltre(e.target.value)}
              >
                <option value="">Tüm şubeler</option>
                {subeListeAdmin.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Personel</th>
                  <th>Şube</th>
                  <th style={{ textAlign: 'center' }}>Puan</th>
                  <th style={{ textAlign: 'center' }}>Zamanında</th>
                  <th style={{ textAlign: 'center' }}>Gecikti</th>
                </tr>
              </thead>
              <tbody>
                {puanListe.length === 0 ? (
                  <tr><td colSpan={6}><div className="empty"><p>Veri yok</p></div></td></tr>
                ) : puanListe.map((p, i) => {
                  const puan = p.puan;
                  const renk = puan == null ? 'var(--text3)' : puan >= 90 ? 'var(--green)' : puan >= 75 ? 'var(--blue)' : puan >= 55 ? 'var(--yellow)' : 'var(--red)';
                  const takip = takipMap?.[p.personel_id];
                  return (
                    <tr key={p.personel_id}>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>
                        {p.ad_soyad}
                        {takip && (
                          <button
                            type="button"
                            className={`badge ${takip.takip_seviyesi === 'kritik' ? 'badge-red' : takip.takip_seviyesi === 'uyari' ? 'badge-yellow' : 'badge-gray'}`}
                            style={{ marginLeft: 8, cursor: 'pointer', border: 'none' }}
                            onClick={async () => {
                              try {
                                const r = await api(`/ops/personel-risk-sinyal?personel_id=${encodeURIComponent(p.personel_id)}&gun=30`);
                                setRiskModal(r);
                              } catch (e) { toast(e.message || 'Sinyal geçmişi yüklenemedi'); }
                            }}
                          >
                            Takip: {takip.takip_seviyesi}
                          </button>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{p.sube_id || '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {puan != null
                          ? <span style={{ fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)' }}>{puan}</span>
                          : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'center' }} className="mono">{p.tamam}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="mono" style={{ color: p.gecikti > 0 ? 'var(--red)' : 'var(--text3)' }}>{p.gecikti}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

          </div>
        </div>
      )}

      {riskModal && (
        <div className="modal-overlay" onClick={() => setRiskModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div style={{ fontWeight: 800 }}>Personel risk sinyalleri</div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  {riskModal.personel_id} · son {riskModal.gun_sayi} gün
                  {riskModal.takip?.takip_seviyesi && (
                    <span className="badge badge-red" style={{ marginLeft: 8 }}>
                      Takip: {riskModal.takip.takip_seviyesi}
                    </span>
                  )}
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setRiskModal(null)}>Kapat</button>
            </div>
            <div className="modal-body">
              {(riskModal.satirlar || []).length === 0 ? (
                <div className="empty"><p>Sinyal yok</p></div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Tür</th>
                        <th>Ağırlık</th>
                        <th>Açıklama</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(riskModal.satirlar || []).map((s) => (
                        <tr key={s.id}>
                          <td className="mono" style={{ fontSize: 11 }}>{s.tarih}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.sinyal_turu}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.agirlik}</td>
                          <td style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{s.aciklama}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ SİPARİŞ GEÇMİŞİ PANELİ ═══════════════ */}
      {aktifSekme === 'siparis-gecmis' && (
        <SiparisGecmisPanel />
      )}

      {/* ═══════════════ STOK DİSİPLİN PANELİ ═══════════════ */}
      {aktifSekme === 'stok-disiplin' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Alt panel seçici */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { id: 'kuyruk',   label: `📬 Sipariş Kuyruğu${(bekleyenSiparisler?.toplam || 0) > 0 ? ` (${bekleyenSiparisler.toplam})` : ''}` },
              { id: 'kritik',   label: '🔴 Kritik Stok' },
              { id: 'akis',     label: '🟡 Sipariş Akışı' },
              { id: 'davranis', label: '🔵 Şube Davranış' },
              { id: 'skor',     label: '🟣 Skor Tablosu' },
            ].map(p => (
              <button
                key={p.id}
                type="button"
                className={`btn btn-sm ${disiplinPanel === p.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setDisiplinPanel(p.id)}
              >{p.label}</button>
            ))}
          </div>

          {disiplinYukleniyor && <div className="loading"><div className="spinner" />Yükleniyor…</div>}

          {/* 0. SİPARİŞ KUYRUĞU */}
          {disiplinPanel === 'kuyruk' && !disiplinYukleniyor && (() => {
            const siparisler = bekleyenSiparisler?.siparisler || [];
            const gonderilenleIlgiliDepoyaGonder = async (talep_id) => {
              const depo = kuyrukDepoSecim[talep_id] || '';
              if (!depo) { toast('Önce bir depo şubesi seçin'); return; }
              const talimatRaw = (kuyrukTalimat[talep_id] || '').trim();
              const body = { talep_id, hedef_depo_sube_id: depo };
              if (talimatRaw) body.operasyon_yonlendirme_talimati = talimatRaw;
              setKuyrukBusy(talep_id);
              try {
                await api('/ops/siparis/sevkiyata-gonder', {
                  method: 'POST',
                  body,
                });
                toast('Sipariş depoya yönlendirildi ✓');
                yukleDisiplin();
              } catch (e) {
                toast(e.message || 'Yönlendirme hatası');
              } finally {
                setKuyrukBusy(null);
              }
            };
            const merkezSiparisIptal = async (talep_id, subeAd) => {
              if (!talep_id) return;
              if (!window.confirm(`Bu sipariş talebini merkezden iptal etmek istiyor musunuz?\n${subeAd || ''}`)) return;
              const aciklama = window.prompt('İptal nedeni (isteğe bağlı):', '') || '';
              setKuyrukBusy(talep_id);
              try {
                await api('/ops/siparis/merkez-iptal', {
                  method: 'POST',
                  body: { talep_id, aciklama: aciklama.trim() || undefined },
                });
                toast('Sipariş merkezden iptal edildi', 'green');
                yukleDisiplin();
              } catch (e) {
                toast(e.message || 'İptal edilemedi');
              } finally {
                setKuyrukBusy(null);
              }
            };
            const gonderilenleIlgiliToptanciyaYolla = async (sip) => {
              const talepId = String(sip?.id || '').trim();
              if (!talepId) return;
              const rows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
              const kalemler = rows.map((k, i) => {
                const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                const key = `${talepId}::${kk}`;
                const adetRaw = kuyrukToptanciKalemDeger[key];
                const adet = Math.max(0, parseInt(String(adetRaw ?? k?.istenen_adet ?? 0), 10) || 0);
                return {
                  urun_ad: String(k?.urun_ad || k?.ad || kk),
                  adet,
                  kalem_kodu: kk,
                  kategori_kod: String(k?.kategori_kod || k?.kategori || k?.kategori_id || '').trim() || null,
                };
              }).filter((x) => x.adet > 0);
              if (!kalemler.length) {
                toast('Toptancı formunda en az 1 kalem için adet girin.');
                return;
              }
              setKuyrukBusy(talepId);
              try {
                await api('/ops/siparis/toptanciya-yolla', {
                  method: 'POST',
                  body: {
                    talep_id: talepId,
                    tedarikci_ad: (kuyrukToptanciTedarikci[talepId] || '').trim() || null,
                    not_aciklama: (kuyrukToptanciNot[talepId] || '').trim() || null,
                    kalemler,
                  },
                });
                toast('Talep toptancı formuna aktarıldı ✓', 'green');
                yukleDisiplin();
              } catch (e) {
                toast(e.message || 'Toptancıya gönderim hatası');
              } finally {
                setKuyrukBusy(null);
              }
            };
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>📬 Bekleyen Sipariş Kuyruğu</span>
                    <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>Son 7 gün — onay bekleyen talepler</span>
                  </div>
                  <button className="btn btn-sm btn-secondary" onClick={yukleDisiplin}>↺ Yenile</button>
                </div>

                <div
                  className="card"
                  style={{
                    padding: '10px 12px',
                    border: depoYetersizAktifSayi > 0 ? '1.5px solid #e8a03d' : '1px solid var(--border)',
                    background: depoYetersizAktifSayi > 0 ? 'rgba(232,160,61,0.08)' : 'var(--bg2)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      📦 Depo yetersiz / yok bildirimleri
                    </div>
                    <span className={`badge ${depoYetersizAktifSayi > 0 ? 'badge-yellow' : 'badge-green'}`}>
                      {depoYetersizAktifSayi > 0 ? `${depoYetersizAktifSayi} aktif uyarı` : 'Aktif yetersizlik yok'}
                    </span>
                  </div>
                  {depoYetersizBildirimler.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
                      Depo şubelerden “kısmi / yok” bildirimi gelmedi.
                    </div>
                  ) : (
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Talep şube</th>
                            <th>Ürün</th>
                            <th style={{ textAlign: 'center' }}>İstenen</th>
                            <th style={{ textAlign: 'center' }}>Gönderilen</th>
                            <th style={{ textAlign: 'center' }}>Eksik</th>
                            <th>Durum</th>
                            <th className="mono">Talep</th>
                          </tr>
                        </thead>
                        <tbody>
                          {depoYetersizBildirimler.slice(0, 18).map((it, idx) => (
                            <tr key={`${it.talep_id}-${it.urun_ad}-${idx}`}>
                              <td>{it.sube_adi}</td>
                              <td>{it.urun_ad}</td>
                              <td style={{ textAlign: 'center' }}>{it.istenen_adet}</td>
                              <td style={{ textAlign: 'center' }}>{it.gonderilen_adet}</td>
                              <td style={{ textAlign: 'center', fontWeight: 700, color: it.eksik_adet > 0 ? '#e8a03d' : 'var(--text3)' }}>
                                {it.eksik_adet}
                              </td>
                              <td>
                                {it.kalem_durum === 'yok' ? (
                                  <span className="badge badge-red">Yok</span>
                                ) : (
                                  <span className="badge badge-yellow">Kısmi</span>
                                )}
                              </td>
                              <td className="mono">{String(it.talep_id || '').slice(0, 8)}…</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {siparisler.length === 0 && (
                  <div className="card empty" style={{ padding: 32 }}><p>Bekleyen sipariş yok ✓</p></div>
                )}

                {siparisler.map((sip) => {
                  const talepId = String(sip?.id || '');
                  const asama = kuyrukAsama[talepId] || 'detay';
                  const detayRows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
                  const depoOpsiyonlari = Array.isArray(kuyrukDepolar) ? kuyrukDepolar : [];
                  return (
                  <div key={sip.id} data-ops-siparis-talep={sip.id} className="card" style={{
                    padding: 0, overflow: 'hidden',
                    border: sip.stok_alarm_var ? '1.5px solid #e85d5d'
                      : sip.barem_risk_var ? '1.5px solid #c9a227'
                      : sip.gereksiz_var ? '1.5px solid #e8a03d' : '1px solid var(--border)',
                  }}>
                    {/* Başlık */}
                    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>🏪 {sip.sube_adi}</span>
                        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{sip.tarih} · {sip.personel_ad || '—'}</span>
                        {sip.not_aciklama && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>· {sip.not_aciklama}</span>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {sip.stok_alarm_var && (
                          <span className="badge badge-red">
                            {sip.stok_hesap_kaynagi === 'hedef_depo' ? '⚠️ Depo yetmez!' : '⚠️ Merkez biter!'}
                          </span>
                        )}
                        {sip.barem_risk_var && (
                          <span className="badge badge-yellow">
                            {sip.stok_hesap_kaynagi === 'hedef_depo' ? '📊 Depo barem' : '📊 Barem risk'}
                          </span>
                        )}
                        {sip.merkez_kayit_eksik_var && <span className="badge badge-yellow">❓ Kart eksik</span>}
                        {sip.gereksiz_var    && <span className="badge" style={{ background: '#3a2a0a', color: '#e8a03d' }}>⚠️ Şubede var</span>}
                        {sip.uyari_var       && <span className="badge" style={{ background: '#2a1a3a', color: '#c084fc' }}>🚨 Davranış uyarısı</span>}
                        <button
                          type="button"
                          className="btn btn-sm"
                          style={{ marginLeft: 'auto', borderColor: '#e85d5d', color: '#e85d5d' }}
                          disabled={kuyrukBusy === talepId}
                          title="Yalnızca merkez sırasındaki talepler (bekliyor / tahsis onayı); depoya gidenler iptal edilemez."
                          onClick={() => merkezSiparisIptal(talepId, sip.sube_adi)}
                        >
                          {kuyrukBusy === talepId ? '…' : 'Merkezden iptal'}
                        </button>
                      </div>
                    </div>

                    <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {[
                        { id: 'detay', label: 'Detay' },
                        { id: 'depo', label: 'Depo / sevk' },
                        { id: 'toptanci', label: 'Toptancıya yolla' },
                      ].map((a) => (
                        <button
                          key={`${talepId}-asama-${a.id}`}
                          type="button"
                          className={`btn btn-sm ${asama === a.id ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => setKuyrukAsama((prev) => ({ ...prev, [talepId]: a.id }))}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>

                    {asama === 'detay' && (
                      <div style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>Şubenin talep detayı (ürün adı + adet)</div>
                        {detayRows.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kalem bulunamadı.</div>
                        ) : (
                          <div style={{ display: 'grid', gap: 6 }}>
                            {detayRows.map((k, ki) => (
                              <div key={`${talepId}-det-${ki}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: '1px dashed var(--border)', paddingBottom: 4 }}>
                                <span style={{ fontSize: 13 }}>{k.urun_ad || k.ad || k.kalem_kodu || 'Kalem'}</span>
                                <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{Number(k.istenen_adet || 0)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Kalem tablosu */}
                    {asama === 'depo' && (
                    <div className="table-wrap" style={{ margin: 0 }}>
                      <table>
                        <thead><tr>
                          <th>Ürün</th>
                          <th style={{ textAlign: 'center' }}>İstenen</th>
                          <th style={{ textAlign: 'center' }}>Şube deposu</th>
                          <th style={{ textAlign: 'center' }}>
                            {sip.stok_hesap_kaynagi === 'hedef_depo' ? 'Sevkiyat deposu' : 'Merkez mevcut'}
                          </th>
                          <th style={{ textAlign: 'center' }}>
                            {sip.stok_hesap_kaynagi === 'hedef_depo' ? 'Depo min' : 'Merkez min'}
                          </th>
                          <th style={{ textAlign: 'center' }}>Göndersen kalır</th>
                          <th style={{ textAlign: 'center' }}>Barem</th>
                        </tr></thead>
                        <tbody>
                          {(sip.kalemler || []).map((k, ki) => {
                            const kg = k.kalan_gonderince;
                            const kalanRenk = k.alarm_merkez ? '#e85d5d' : (kg != null && kg <= 3) ? '#e8a03d' : 'var(--green)';
                            const depoHesap = sip.stok_hesap_kaynagi === 'hedef_depo';
                            return (
                              <tr key={ki} style={{
                                background: k.alarm_merkez ? 'rgba(232,93,93,0.05)'
                                  : k.merkez_barem_risk ? 'rgba(232,197,71,0.06)' : 'transparent',
                              }}>
                                <td>
                                  <span style={{ fontWeight: 500 }}>{k.urun_ad}</span>
                                  {k.sube_zaten_var && (
                                    <span style={{ marginLeft: 6, fontSize: 11, color: '#e8a03d' }}>⚠️ şubede zaten {k.sube_depo_mevcut} adet var</span>
                                  )}
                                </td>
                                <td style={{ textAlign: 'center', fontWeight: 700 }}>{k.istenen_adet}</td>
                                <td style={{ textAlign: 'center', color: k.sube_zaten_var ? '#e8a03d' : 'var(--text)' }}>
                                  {k.sube_depo_mevcut > 0 ? `${k.sube_depo_mevcut} adet` : <span style={{ color: 'var(--text3)' }}>—</span>}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  {depoHesap ? (
                                          <>
                                            <span>{k.hedef_depo_mevcut != null ? `${k.hedef_depo_mevcut} adet` : '—'}</span>
                                            {(k.hedef_depo_rezerve || 0) > 0 && (
                                              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Rez: {k.hedef_depo_rezerve}</div>
                                            )}
                                      {k.merkez_mevcut != null && k.merkez_mevcut >= 0 && (
                                        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>Kart: {k.merkez_mevcut}</div>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      {k.merkez_mevcut < 0 ? (
                                        <span style={{ color: 'var(--text3)' }}>kayıt yok</span>
                                      ) : (
                                        <>
                                          {k.merkez_mevcut} adet
                                          {(k.merkez_rezerve || 0) > 0 && (
                                            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text3)' }}>
                                              (rez: {k.merkez_rezerve})
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </>
                                  )}
                                </td>
                                <td style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                                  {depoHesap
                                    ? (k.hedef_depo_min_stok != null ? k.hedef_depo_min_stok : '—')
                                    : (k.merkez_min_stok != null ? k.merkez_min_stok : '—')}
                                </td>
                                <td style={{ textAlign: 'center', fontWeight: 700, color: kalanRenk }}>
                                  {k.kalan_gonderince === null ? '—' :
                                   k.kalan_gonderince <= 0 ? `${k.kalan_gonderince} ❌` : `${k.kalan_gonderince} adet`}
                                </td>
                                <td style={{ textAlign: 'center', fontSize: 12 }}>
                                  {k.merkez_barem_risk ? <span style={{ color: '#e8a03d', fontWeight: 700 }}>Uyarı</span> : <span style={{ color: 'var(--text3)' }}>—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    )}

                    {asama === 'depo' && (
                      <>
                        {/* Davranış uyarıları */}
                        {(sip.davranis_uyarilari || []).length > 0 && (
                          <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {sip.davranis_uyarilari.map((u, ui) => (
                              <span key={ui} style={{ fontSize: 12, background: '#2a1a3a', color: '#c084fc', borderRadius: 6, padding: '2px 8px' }}>
                                {u.kural} (+{u.puan}p) — {u.mesaj}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Depo atama */}
                        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {sip.operasyon_yonlendirme_talimati && (
                            <div style={{ fontSize: 12, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'rgba(59,130,246,0.08)', whiteSpace: 'pre-wrap' }}>
                              <span style={{ color: 'var(--text3)', fontWeight: 600 }}>Kayıtlı operasyon talimatı: </span>
                              {sip.operasyon_yonlendirme_talimati}
                            </div>
                          )}
                          <label style={{ fontSize: 11, color: 'var(--text3)', margin: 0 }}>Operasyon talimatı (isteğe bağlı)</label>
                          <textarea
                            className="input"
                            rows={2}
                            placeholder="Dağıtım / öncelik notu — depo ve talep şubesi panelinde görünür."
                            style={{ width: '100%', maxWidth: 520, resize: 'vertical', fontSize: 12 }}
                            value={kuyrukTalimat[sip.id] || ''}
                            onChange={(e) => setKuyrukTalimat((prev) => ({ ...prev, [sip.id]: e.target.value }))}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, color: 'var(--text3)', flexShrink: 0 }}>Hedef hazırlık şubesi:</span>
                              <select
                                className="input"
                                style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
                                value={kuyrukDepoSecim[sip.id] || ''}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setKuyrukDepoSecim((p) => ({ ...p, [sip.id]: v }));
                                }}
                              >
                                <option value="">— Şube seçin (siparis_talep.hedef_depo_sube_id) —</option>
                                {depoOpsiyonlari.map(d => (
                                  <option key={d.id} value={d.id}>{d.ad} ({d.sube_tipi})</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={!kuyrukDepoSecim[sip.id]}
                                title="Seçili şubenin panelini yeni sekmede açar"
                                onClick={() => {
                                  const u = subePanelHariciUrl(kuyrukDepoSecim[sip.id]);
                                  if (u) window.open(u, '_blank', 'noopener,noreferrer');
                                  else toast('Şube paneli adresi oluşturulamadı (VITE_API_URL?)');
                                }}
                              >
                                Şube paneli
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={!kuyrukDepoSecim[sip.id]}
                                title="Ana uygulamada Sevkiyat Hazırlama sayfasını bu şube filtresiyle açar"
                                onClick={() => {
                                  const sid = String(kuyrukDepoSecim[sip.id] || '').trim();
                                  if (!sid) return;
                                  try {
                                    sessionStorage.setItem('ops_sevkiyat_hazirlama_sube_id', sid);
                                  } catch (_) {}
                                  window.location.hash = 'sevkiyat-hazirlama';
                                }}
                              >
                                Sevkiyat hazırlama
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={!kuyrukDepoSecim[sip.id] || kuyrukBusy === sip.id}
                                onClick={() => gonderilenleIlgiliDepoyaGonder(sip.id)}
                              >
                                {kuyrukBusy === sip.id ? '…' : 'Talebi bu depoya yönlendir'}
                              </button>
                            </div>
                            {depoOpsiyonlari.length === 0 && (
                              <div style={{ fontSize: 11, color: '#e8a03d' }}>
                                Aktif şube bulunamadı (liste tüm <code style={{ fontSize: 10 }}>aktif=TRUE</code> şubelerden gelir).
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                              <strong>Yönlendir</strong> sonrası talep <code style={{ fontSize: 10 }}>hedef_depo_sube_id</code> ile işlenir;
                              hazırlık kalemleri <strong>Sevkiyat Hazırlama</strong> ekranında bu şube filtresiyle görünür (şube deposundan çıkış).
                              Şube paneli ise teslim/kabul ve günlük operasyon içindir.
                            </div>
                          </div>
                        </div>
                      </>
                    )}

                    {asama === 'toptanci' && (
                      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                          Toptancı sipariş formu kartı — süt, kahve vb. kalemleri ayrı ayrı gönderebilirsiniz.
                        </div>
                        <label style={{ margin: 0 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Toptancı / tedarikçi</span>
                          <input
                            className="input"
                            style={{ maxWidth: 320 }}
                            placeholder="Örn: ABC Toptan Gıda"
                            value={kuyrukToptanciTedarikci[sip.id] || ''}
                            onChange={(e) => setKuyrukToptanciTedarikci((prev) => ({ ...prev, [sip.id]: e.target.value }))}
                          />
                        </label>
                        <div style={{ display: 'grid', gap: 6, maxWidth: 560 }}>
                          {detayRows.map((k, ki) => {
                            const kk = String(k?.kalem_kodu || k?.urun_id || `k_${ki}`);
                            const key = `${sip.id}::${kk}`;
                            const val = kuyrukToptanciKalemDeger[key] ?? String(Number(k?.istenen_adet || 0));
                            return (
                              <div key={`${sip.id}-topf-${kk}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px', gap: 8, alignItems: 'center' }}>
                                <div style={{ fontSize: 13 }}>{k.urun_ad || k.ad || kk}</div>
                                <input
                                  className="input"
                                  inputMode="numeric"
                                  value={val}
                                  onChange={(e) => {
                                    const v = String(e.target.value || '').replace(/[^\d]/g, '');
                                    setKuyrukToptanciKalemDeger((prev) => ({ ...prev, [key]: v }));
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                        <label style={{ margin: 0 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Not</span>
                          <textarea
                            className="input"
                            rows={2}
                            style={{ width: '100%', maxWidth: 560, resize: 'vertical', fontSize: 12 }}
                            placeholder="Toptancı sipariş notu..."
                            value={kuyrukToptanciNot[sip.id] || ''}
                            onChange={(e) => setKuyrukToptanciNot((prev) => ({ ...prev, [sip.id]: e.target.value }))}
                          />
                        </label>
                        <div>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={kuyrukBusy === sip.id}
                            onClick={() => gonderilenleIlgiliToptanciyaYolla(sip)}
                          >
                            {kuyrukBusy === sip.id ? '…' : '⇢ Toptancıya yolla'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
                })}
              </div>
            );
          })()}

          {/* 1. KRİTİK STOK PANELİ — gruplu görünüm */}
          {disiplinPanel === 'kritik' && !disiplinYukleniyor && (() => {
            const tumAlarmlar = kritikStok?.alarmlar || [];
            // Filtrele
            const filtreliAlarmlar = tumAlarmlar.filter((a) => {
              if (kritikFiltre === 'kriz')   return a.mevcut === 0;
              if (kritikFiltre === 'merkez') return a.kaynak === 'merkez';
              if (kritikFiltre === 'sube')   return a.kaynak !== 'merkez';
              return true;
            });
            // Grupla: merkez ayrı, şubeler kendi başlıkları
            const grupMap = {};
            for (const a of filtreliAlarmlar) {
              const key = a.kaynak === 'merkez' ? '__merkez__' : (a.sube_id || 'diger');
              if (!grupMap[key]) grupMap[key] = { key, label: a.kaynak === 'merkez' ? 'Merkez Depo' : (a.sube_adi || a.sube_id || 'Şube'), isMerkez: a.kaynak === 'merkez', items: [] };
              grupMap[key].items.push(a);
            }
            // Sıra: merkez önce, sonra şubeler ada göre
            const gruplar = Object.values(grupMap).sort((a, b) => {
              if (a.isMerkez) return -1;
              if (b.isMerkez) return 1;
              return a.label.localeCompare(b.label, 'tr');
            });
            const seviyeRenk = (s) => s === 'KRIZ' ? { bg: '#5a1a1a', fg: '#ff6060' } : s === 'KRITIK' ? { bg: '#3a2a1a', fg: '#f08040' } : { bg: '#2a2a2a', fg: '#aaa' };
            const toplamKriz   = tumAlarmlar.filter((a) => a.mevcut === 0).length;
            const toplamKritik = tumAlarmlar.filter((a) => a.mevcut === 1).length;
            const toplamDusuk  = tumAlarmlar.filter((a) => a.mevcut > 1).length;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Üst bar: özet + filtreler */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {[
                      { id: 'tumu',   label: `Tümü (${tumAlarmlar.length})` },
                      { id: 'kriz',   label: `🔴 Sıfır (${toplamKriz})` },
                      { id: 'merkez', label: `🏭 Merkez (${tumAlarmlar.filter(a => a.kaynak === 'merkez').length})` },
                      { id: 'sube',   label: `🏪 Şubeler (${tumAlarmlar.filter(a => a.kaynak !== 'merkez').length})` },
                    ].map((f) => (
                      <button key={f.id} type="button" onClick={() => setKritikFiltre(f.id)}
                        style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8, border: `1px solid ${kritikFiltre === f.id ? '#e85d5d' : 'var(--border)'}`, background: kritikFiltre === f.id ? 'rgba(232,93,93,0.15)' : 'var(--bg2)', color: kritikFiltre === f.id ? '#ff8080' : 'var(--text2)', cursor: 'pointer' }}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span className="badge badge-red" style={{ fontSize: 11 }}>KRİZ {toplamKriz}</span>
                    <span className="badge" style={{ background: '#3a2a1a', color: '#f08040', fontSize: 11 }}>KRİTİK {toplamKritik}</span>
                    {toplamDusuk > 0 && <span className="badge badge-gray" style={{ fontSize: 11 }}>DÜŞÜK {toplamDusuk}</span>}
                  </div>
                </div>

                {filtreliAlarmlar.length === 0 ? (
                  <div className="empty" style={{ padding: 28 }}><p>Filtre sonucu boş ✓</p></div>
                ) : gruplar.map((grup) => {
                  const acik = kritikAcikGruplar[grup.key] !== false; // default açık
                  const grKriz   = grup.items.filter((a) => a.mevcut === 0).length;
                  const grKritik = grup.items.filter((a) => a.mevcut === 1).length;
                  return (
                    <div key={grup.key} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                      {/* Grup başlığı — tıklanabilir */}
                      <button type="button"
                        onClick={() => setKritikAcikGruplar((prev) => ({ ...prev, [grup.key]: !acik }))}
                        style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--bg2)', border: 'none', borderBottom: acik ? '1px solid var(--border)' : 'none', cursor: 'pointer', textAlign: 'left', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                            {grup.isMerkez ? '🏭' : '🏪'} {grup.label}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{grup.items.length} kalem</span>
                        </div>
                        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                          {grKriz > 0   && <span className="badge badge-red"    style={{ fontSize: 11 }}>🔴 {grKriz} sıfır</span>}
                          {grKritik > 0 && <span className="badge" style={{ background: '#3a2a1a', color: '#f08040', fontSize: 11 }}>⚠ {grKritik} kritik</span>}
                          <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>{acik ? '▲' : '▼'}</span>
                        </div>
                      </button>
                      {/* Tablo — collapse */}
                      {acik && (
                        <div className="table-wrap" style={{ margin: 0 }}>
                          <table style={{ fontSize: 12 }}>
                            <thead><tr>
                              <th style={{ width: '40%' }}>Ürün</th>
                              <th style={{ textAlign: 'center' }}>Mevcut</th>
                              {grup.isMerkez && <th style={{ textAlign: 'center' }}>Rezerve</th>}
                              <th style={{ textAlign: 'center' }}>Min</th>
                              <th>Seviye</th>
                              {grup.isMerkez && <th style={{ textAlign: 'center' }}>Bkl. Sipariş</th>}
                            </tr></thead>
                            <tbody>
                              {grup.items.map((a, i) => {
                                const { bg, fg } = seviyeRenk(a.seviye);
                                return (
                                  <tr key={i} style={{ background: a.mevcut === 0 ? 'rgba(232,93,93,0.07)' : 'transparent' }}>
                                    <td style={{ fontWeight: a.mevcut === 0 ? 700 : 500 }}>{a.kalem_adi || a.kalem_kodu}</td>
                                    <td className="mono" style={{ textAlign: 'center', fontWeight: 700, color: a.mevcut === 0 ? '#e85d5d' : a.mevcut === 1 ? '#f08040' : 'var(--text)' }}>{a.mevcut}</td>
                                    {grup.isMerkez && <td className="mono" style={{ textAlign: 'center', color: 'var(--text3)' }}>{a.rezerve || 0}</td>}
                                    <td className="mono" style={{ textAlign: 'center', color: 'var(--text3)' }}>{a.min_stok || '—'}</td>
                                    <td><span className="badge" style={{ background: bg, color: fg, fontSize: 10 }}>{a.seviye}</span></td>
                                    {grup.isMerkez && <td className="mono" style={{ textAlign: 'center', color: a.bekleyen_siparis > 0 ? '#c9a227' : 'var(--text3)' }}>{a.bekleyen_siparis || 0}</td>}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* 2. SİPARİŞ AKIŞ — görsel adım akışı */}
          {disiplinPanel === 'akis' && !disiplinYukleniyor && (() => {
            const fmtTs = (ts) => { const s = String(ts || ''); return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : null; };
            const fmtSaat = (ts) => { const s = String(ts || ''); return s.length >= 16 ? s.slice(11, 16) : null; };
            const FILTRELER = [
              { key: 'tumu', label: 'Tümü' },
              { key: 'bekliyor', label: '⏳ Bekliyor' },
              { key: 'sevkiyatta', label: '🚚 Sevkiyatta' },
              { key: 'teslim', label: '✅ Tamamlandı' },
              { key: 'uyumsuzluk', label: '⚠ Uyumsuzluk' },
            ];
            const tumAkis = siparisAkis?.siparis_akis || [];
            const filtreliAkis = tumAkis.filter((s) => {
              if (akisFiltre === 'bekliyor') return !s.tahsis_ts && s.durum !== 'teslim_edildi';
              if (akisFiltre === 'sevkiyatta') return s.sevkiyat_durumu === 'gonderildi' && !s.kabul_durum;
              if (akisFiltre === 'teslim') return s.kabul_durum === 'kabul_tam' || s.durum === 'teslim_edildi';
              if (akisFiltre === 'uyumsuzluk') return s.kabul_durum === 'kabul_uyusmazlik';
              return true;
            });
            const getAdimlar = (s) => [
              { key: 'talep',  label: 'Talep',  done: true,
                ts: fmtSaat(s.olusturma), tarih: fmtTs(s.olusturma),
                bilgi: '', renk: '#22c55e', uyari: '' },
              { key: 'tahsis', label: 'Tahsis', done: !!s.tahsis_durum,
                ts: fmtSaat(s.tahsis_ts), tarih: fmtTs(s.tahsis_ts),
                bilgi: s.tahsis_yapan_ad || '',
                renk: s.tahsis_durum === 'tam' ? '#22c55e' : s.tahsis_durum === 'kismi' ? '#f59e0b' : s.tahsis_durum === 'yok' ? '#ef4444' : '#6b7280',
                uyari: s.tahsis_durum === 'yok' ? 'Stok yok' : s.tahsis_durum === 'kismi' ? 'Kısmi' : '' },
              { key: 'sevk',   label: 'Sevk',   done: s.sevkiyat_durumu === 'gonderildi',
                ts: fmtSaat(s.sevkiyat_ts), tarih: fmtTs(s.sevkiyat_ts),
                bilgi: s.sevkiyat_personel_ad || (s.sevk_sube_adi && s.sevk_sube_adi !== s.sube_adi ? s.sevk_sube_adi : ''),
                renk: s.sevkiyat_durumu === 'gonderildi' ? '#3b82f6' : '#6b7280', uyari: '' },
              { key: 'kabul',  label: 'Kabul',  done: ['kabul_tam','kabul_kismi'].includes(s.kabul_durum),
                ts: fmtSaat(s.kabul_ts), tarih: fmtTs(s.kabul_ts),
                bilgi: '',
                renk: s.kabul_durum === 'kabul_tam' ? '#22c55e' : s.kabul_durum === 'kabul_uyusmazlik' ? '#ef4444' : s.kabul_durum === 'kabul_kismi' ? '#f59e0b' : '#6b7280',
                uyari: s.kabul_durum === 'kabul_uyusmazlik' ? 'Uyumsuzluk' : s.kabul_durum === 'kabul_kismi' ? 'Kısmi' : '' },
            ];
            return (
              <div>
                {/* Filtre + başlık */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, marginRight: 4 }}>🔄 Sipariş Akışı</span>
                  {FILTRELER.map((f) => (
                    <button key={f.key} type="button"
                      className={'btn btn-sm ' + (akisFiltre === f.key ? 'btn-primary' : 'btn-secondary')}
                      style={{ fontSize: 11, padding: '3px 10px' }}
                      onClick={() => setAkisFiltre(f.key)}>
                      {f.label}
                    </button>
                  ))}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{filtreliAkis.length} / {tumAkis.length} sipariş</span>
                  <button type="button" className="btn btn-sm btn-secondary" style={{ fontSize: 11 }} onClick={yukleDisiplin}>↺ Yenile</button>
                </div>

                {filtreliAkis.length === 0 ? (
                  <div className="empty"><p>Bu filtrede sipariş yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filtreliAkis.map((s) => {
                      const adimlar = getAdimlar(s);
                      const acik = akisAcikId === s.id;
                      const kd = s.kabul_durum;
                      const bordRenk = kd === 'kabul_tam' ? '#22c55e'
                        : kd === 'kabul_uyusmazlik' ? '#ef4444'
                        : s.sevkiyat_durumu === 'gonderildi' ? '#3b82f6'
                        : s.tahsis_durum ? '#f59e0b'
                        : 'var(--border)';
                      const tamamlandi = kd === 'kabul_tam' || s.durum === 'teslim_edildi';
                      return (
                        <div key={s.id} style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderLeft: `3px solid ${bordRenk}`, borderRadius: 10, overflow: 'hidden' }}>

                          {/* Kart başlığı */}
                          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 10 }}
                            onClick={() => setAkisAcikId(acik ? null : s.id)}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{s.sube_adi || s.sube_id}</span>
                              {s.sevk_sube_adi && s.sevk_sube_adi !== s.sube_adi && (
                                <span style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                                  <span>→ 🏭</span><span>{s.sevk_sube_adi}</span>
                                </span>
                              )}
                              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.tarih}</span>
                              <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'monospace', opacity: 0.5 }}>#{String(s.id || '').slice(-6)}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.kalem_sayisi} kalem</span>
                              {kd === 'kabul_uyusmazlik' && <span className="badge badge-red" style={{ fontSize: 10 }}>Uyumsuzluk</span>}
                              {tamamlandi && kd !== 'kabul_uyusmazlik' && <span className="badge badge-green" style={{ fontSize: 10 }}>Tamamlandı</span>}
                              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{acik ? '▲' : '▼'}</span>
                            </div>
                          </div>

                          {/* 4 adımlı görsel akış */}
                          <div style={{ padding: '6px 14px 12px', display: 'flex', alignItems: 'flex-start' }}>
                            {adimlar.map((a, i) => (
                              <React.Fragment key={a.key}>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 64 }}>
                                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: a.done ? a.renk : 'var(--bg3)', border: `2px solid ${a.done ? a.renk : 'var(--border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>
                                    {a.done ? (a.uyari ? <span style={{ fontSize: 12 }}>⚠</span> : <span style={{ fontSize: 13, color: '#fff' }}>✓</span>) : <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700 }}>{i + 1}</span>}
                                  </div>
                                  <div style={{ fontSize: 11, fontWeight: 600, marginTop: 4, color: a.done ? 'var(--text)' : 'var(--text3)', textAlign: 'center' }}>{a.label}</div>
                                  {a.ts && <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>{a.ts}</div>}
                                  {a.uyari && <div style={{ fontSize: 10, color: a.renk, textAlign: 'center', fontWeight: 600 }}>{a.uyari}</div>}
                                  {!a.uyari && a.bilgi && <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.bilgi}</div>}
                                </div>
                                {i < adimlar.length - 1 && (
                                  <div style={{ height: 2, width: 16, background: adimlar[i + 1].done ? '#3b82f6' : 'var(--border)', marginTop: 14, flexShrink: 0 }} />
                                )}
                              </React.Fragment>
                            ))}
                          </div>

                          {/* Genişletilmiş detay */}
                          {acik && (
                            <div style={{ padding: '10px 14px 14px', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
                              {/* Zaman damgaları özeti */}
                              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10, fontSize: 11, color: 'var(--text3)' }}>
                                {adimlar[0].tarih && <span>📝 Talep: {adimlar[0].tarih}</span>}
                                {adimlar[1].tarih && <span>🏭 Tahsis: {adimlar[1].tarih}{s.tahsis_yapan_ad ? ' · ' + s.tahsis_yapan_ad : ''}</span>}
                                {adimlar[2].tarih && <span>🚚 Sevk: {adimlar[2].tarih}{s.sevkiyat_personel_ad ? ' · ' + s.sevkiyat_personel_ad : ''}{s.sevk_sube_adi && s.sevk_sube_adi !== s.sube_adi ? ' · ' + s.sevk_sube_adi : ''}</span>}
                                {adimlar[3].tarih && <span>✅ Kabul: {adimlar[3].tarih}</span>}
                              </div>
                              {/* Kalem listesi */}
                              {(s.yolda || []).length > 0 ? (
                                <div>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Kalemler</div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    {(s.yolda || []).map((y, idx) => {
                                      const yd = String(y.durum || '').toLowerCase();
                                      const kabulRenk = yd === 'kabul_edildi' || yd === 'uzlasildi' ? '#22c55e' : yd === 'kabul_uyusmazlik' ? '#ef4444' : 'var(--text3)';
                                      const fark = y.kabul_adet != null && y.sevk_adet != null ? Number(y.kabul_adet) - Number(y.sevk_adet) : null;
                                      return (
                                        <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                                          <span style={{ flex: 1, color: 'var(--text)' }}>{y.kalem_adi || y.kalem_kodu}</span>
                                          <span className="mono" style={{ color: 'var(--text3)', minWidth: 60 }}>Sevk: <strong>{y.sevk_adet ?? '—'}</strong></span>
                                          <span className="mono" style={{ color: kabulRenk, minWidth: 60 }}>Kabul: <strong>{y.kabul_adet ?? '—'}</strong></span>
                                          {fark !== null && fark !== 0 && <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>Δ{fark > 0 ? '+' : ''}{fark}</span>}
                                          {(yd === 'uzlasildi') && <span className="badge badge-green" style={{ fontSize: 9 }}>Uzlaşı</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : (s.tahsis || []).length > 0 ? (
                                <div>
                                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tahsis Kararı</div>
                                  {(s.tahsis || []).map((t, idx) => (
                                    <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, padding: '4px 0' }}>
                                      <span style={{ flex: 1 }}>{t.kalem_adi || t.kalem_kodu}</span>
                                      <span className="mono" style={{ color: 'var(--text3)' }}>Talep: {t.talep_adet}</span>
                                      <span className="mono" style={{ color: 'var(--text3)' }}>Tahsis: {t.tahsis_adet}</span>
                                      <span className="badge" style={{ fontSize: 10 }}>{t.durum}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Henüz sevkiyat kaydı yok.</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* 3. ŞUBE DAVRANIŞ PANELİ */}
          {disiplinPanel === 'davranis' && !disiplinYukleniyor && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Son 30 günde şube ihlalleri. Kırmızı = acil müdahale.</div>
              {(subeDavranis?.subeler || []).length === 0 ? (
                <div className="empty"><p>İhlal kaydı yok ✓</p></div>
              ) : (
                (subeDavranis?.subeler || []).map(s => {
                  const DURUM_RENK = { normal: '#2db573', dikkat: '#c9a227', problemli: '#e85d5d' };
                  const renk = DURUM_RENK[s.durum] || 'var(--text3)';
                  const KURAL_LABEL = { GEREKSIZ_SIPARIS: 'Gereksiz sipariş', EKSIK_KULLANIM: 'Eksik kullanım girişi', FAZLA_FREKANS: 'Fazla sipariş frekansı', KABUL_FARKI: 'Kabul / sevk farkı' };
                  return (
                    <div key={s.sube_id} className="card" style={{ padding: '14px 16px', borderLeft: `3px solid ${renk}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{s.sube_adi || s.sube_id}</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: renk }}>{s.toplam_puan}</span>
                          <span className="badge" style={{ background: 'transparent', border: `1px solid ${renk}`, color: renk, fontSize: 11 }}>{s.durum}</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {(s.ihlaller || []).map((ih, i) => (
                          <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
                            <span style={{ color: 'var(--text3)' }}>{KURAL_LABEL[ih.kural] || ih.kural}</span>
                            <span className="mono" style={{ color: renk, fontWeight: 700, marginLeft: 6 }}>+{ih.puan}p</span>
                            <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 4 }}>({ih.ihlal_sayisi}x)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* 4. SKOR TABLOSU */}
          {disiplinPanel === 'skor' && !disiplinYukleniyor && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>🟣 Şube Skor Tablosu</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Bu ay kümülatif davranış puanları. 0–3 normal | 4–6 dikkat | 7+ problemli</div>
              </div>
              {(subeSkor?.skorlar || []).length === 0 ? (
                <div className="empty" style={{ padding: 32 }}><p>Skor verisi yok henüz</p></div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead><tr>
                      <th>#</th><th>Şube</th><th>Toplam Puan</th><th>Durum</th>
                      <th style={{ color: 'var(--text3)', fontSize: 11 }}>Gereksiz Sip.</th>
                      <th style={{ color: 'var(--text3)', fontSize: 11 }}>Eksik Kullanım</th>
                      <th style={{ color: 'var(--text3)', fontSize: 11 }}>Fazla Frekans</th>
                      <th style={{ color: 'var(--text3)', fontSize: 11 }}>Kabul Farkı</th>
                    </tr></thead>
                    <tbody>
                      {(subeSkor?.skorlar || []).map((s, i) => {
                        const DURUM_RENK = { normal: '#2db573', dikkat: '#c9a227', problemli: '#e85d5d' };
                        const renk = DURUM_RENK[s.durum] || 'var(--text3)';
                        const d = s.detay || {};
                        return (
                          <tr key={s.sube_id}>
                            <td style={{ color: 'var(--text3)', width: 30 }}>{i + 1}</td>
                            <td style={{ fontWeight: 500 }}>{s.sube_adi || s.sube_id}</td>
                            <td className="mono" style={{ fontSize: 18, fontWeight: 700, color: renk }}>{s.toplam_puan}</td>
                            <td><span className="badge" style={{ background: 'transparent', border: `1px solid ${renk}`, color: renk, fontSize: 11 }}>{s.durum}</span></td>
                            <td className="mono" style={{ color: 'var(--text3)' }}>{d.GEREKSIZ_SIPARIS?.puan ?? 0}</td>
                            <td className="mono" style={{ color: 'var(--text3)' }}>{d.EKSIK_KULLANIM?.puan ?? 0}</td>
                            <td className="mono" style={{ color: 'var(--text3)' }}>{d.FAZLA_FREKANS?.puan ?? 0}</td>
                            <td className="mono" style={{ color: 'var(--text3)' }}>{d.KABUL_FARKI?.puan ?? 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {/* Detay modal */}
      {detay && (
        <DetayModal
          kart={detay}
          filtre={filtre}
          onKapat={() => setDetay(null)}
          onYenileDetay={yenileDetayKart}
        />
      )}
    </div>
  );
}
