import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from 'react';
import { api, fmt } from '../utils/api';
import { listeyiCsvIndir } from '../utils/csvExport';
import { computeOpsKartVurgu } from '../utils/opsVurgu';
import { publishGlobalDataRefresh, subscribeGlobalDataRefresh } from '../utils/globalDataRefresh';
import { cacheFreshness, cacheTooltip } from '../utils/raporCache';
import CacheFreshnessBadge from '../components/CacheFreshnessBadge';
import SiparisKontrolKulesi from './SiparisKontrolKulesi';
import UrunUyumsuzlukPanel from '../components/UrunUyumsuzlukPanel';
import FireBildirimPanel from '../components/FireBildirimPanel';

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
  bardak_kucuk: '8oz Bardak (genel havuz)',
  bardak_buyuk: '14oz Bardak (genel havuz)',
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
    const it = items.find(
      (x) => String(x?.id || '') === kk
        || String(x?.depo_stok_kalem_kodu || '').trim() === kk
        || magazaDepoKalemKodu(x) === kk,
    );
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

/** Canlı depo satırının katalog kategorisi (eşleşmezse havuz / diğer). */
function magazaCanliDepoSatirKategori(st, kategoriler) {
  const kk = String(st?.kalem_kodu || '').trim();
  const kats = Array.isArray(kategoriler) ? kategoriler : [];
  for (let ki = 0; ki < kats.length; ki += 1) {
    const kat = kats[ki];
    const katId = String(kat.id || '').trim();
    if (!katId) continue;
    const items = Array.isArray(kat.items) ? kat.items : [];
    const it = items.find(
      (x) => String(x?.id || '') === kk
        || String(x?.depo_stok_kalem_kodu || '').trim() === kk
        || magazaDepoKalemKodu(x) === kk,
    );
    if (it) {
      return {
        katId,
        katLabel: String(kat.label || kat.ad || katId).trim() || katId,
      };
    }
  }
  if (MAGAZA_DEPO_HAVUZ_ETIKET_TR[kk]) {
    return { katId: '__havuz__', katLabel: 'Genel havuz' };
  }
  return { katId: '__diger__', katLabel: 'Diğer' };
}

/** Canlı depo satırlarını kategori sekmeleri için gruplar (katalog sırasına göre). */
function magazaCanliDepoKategoriGruplari(satirlar, kategoriler) {
  const gruplar = new Map();
  (satirlar || []).forEach((st) => {
    const { katId, katLabel } = magazaCanliDepoSatirKategori(st, kategoriler);
    if (!gruplar.has(katId)) {
      gruplar.set(katId, { katId, katLabel, satirlar: [] });
    }
    gruplar.get(katId).satirlar.push(st);
  });
  const ordered = [];
  const kats = Array.isArray(kategoriler) ? kategoriler : [];
  kats.forEach((kat) => {
    const kid = String(kat.id || '').trim();
    if (kid && gruplar.has(kid)) ordered.push(gruplar.get(kid));
  });
  ['__havuz__', '__diger__'].forEach((kid) => {
    if (gruplar.has(kid)) ordered.push(gruplar.get(kid));
  });
  gruplar.forEach((g, id) => {
    if (!ordered.some((x) => x.katId === id)) ordered.push(g);
  });
  return ordered;
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

/** Panel açılış havuzu — backend ``operasyon_stok_motor._stok_key_from_urun_ad`` ile uyumlu. */
function magazaStokKeyFromUrunAd(ad) {
  const n = magazaAdNorm(ad || '');
  if (!n) return null;
  if (n.includes('bardak')) {
    if (n.includes('plastik')) return 'bardak_plastik';
    if (n.includes('karton')) return 'karton_bardak';
    if (n.includes('14') && n.includes('oz')) return 'bardak_buyuk';
    if (n.includes('8') && n.includes('oz')) return 'bardak_kucuk';
    if (n.includes('kucuk') || n.includes('küçük') || n.includes('small')) return 'bardak_kucuk';
    if (n.includes('buyuk') || n.includes('büyük') || n.includes('large') || n.includes('orta')) return 'bardak_buyuk';
    return null;
  }
  if (n.includes('kucuk bardak') || n.includes('küçük bardak')) return 'bardak_kucuk';
  if (n.includes('buyuk bardak') || n.includes('büyük bardak')) return 'bardak_buyuk';
  if (n.includes('plastik bardak')) return 'bardak_plastik';
  if (n.includes('karton bardak')) return 'karton_bardak';
  if (n.includes('sut') || n.includes('süt')) {
    if (n === 'sut' || n === 'süt' || n === 'sut litre' || n === 'sut_litre') return 'sut_litre';
    const cesit = ['yagli', 'yağlı', 'yagsiz', 'yağsız', 'yarim', 'yarım', 'laktoz', 'badem', 'soya', 'yulaf', 'hindistan', 'findik', 'fındık', 'cevizi', 'vegan'];
    if (cesit.some((t) => n.includes(t))) return null;
    if (n.length > 5) return null;
    return 'sut_litre';
  }
  if (n.includes('kahve')) return 'kahve_paket';
  if (n === 'su' || n === 'su adet' || n === 'su_adet' || n === 'su sisesi' || n === 'su şişesi') return 'su_adet';
  if (n.includes(' su ') && !n.includes('bardak') && n.length <= 15) return 'su_adet';
  if (n.includes('redbull')) return 'redbull_adet';
  if (n.includes('soda')) return 'soda_adet';
  if (n.includes('cookie')) return 'cookie_adet';
  if (n.includes('pasta')) return 'pasta_adet';
  if (n.includes('surup') || n.includes('şurup')) return 'surup_adet';
  if (n.includes('kapak')) return 'kapak_adet';
  if (n.includes('pecete') || n.includes('peçete')) {
    if (n.startsWith('z ') || n.startsWith('z pecete') || n.startsWith('z peçete')) return null;
    if (n.includes('baskili') || n.includes('baskılı')) return null;
    return 'pecete_paket';
  }
  return null;
}

/** ``sube_depo_stok.kalem_kodu`` — backend ``depo_kalem_kodu_resolve`` ile aynı öncelik.
 *
 *  Öncelik:
 *  1. fiziksel havuz kodu (depo_stok_kalem_kodu ∈ bardak_buyuk, sut_litre, …)
 *  2. ürün adından fiziksel havuz eşleşmesi
 *  3. UUID katalog öğesi (1-to-1 migration satır garantisi)
 *  4. kalan havuz / slug fallback
 */
const _DEPO_FIZIKSEL_HAVUZ = new Set([
  'bardak_kucuk', 'bardak_buyuk', 'bardak_plastik', 'su_adet',
  'redbull_adet', 'soda_adet', 'cookie_adet', 'pasta_adet',
  'sut_litre', 'surup_adet', 'kahve_paket', 'karton_bardak',
  'kapak_adet', 'pecete_paket', 'diger_sarf',
]);
const _UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function magazaDepoKalemKodu(it) {
  if (!it || typeof it !== 'object') return '';
  const uid = String(it.id || '').trim();
  // ── Havuz mantığı kaldırıldı ──
  // Ürünün KENDİ UUID'si HER ZAMAN önceliklidir. Aksi halde isim grubu
  // (kapak, bardak, kahve…) aynı fiziksel havuz koduna çöker ve birine
  // yazılan değer hepsinde görünür. Backend depo_kalem_kodu_resolve ile aynı.
  if (_UUID_PATTERN.test(uid)) return uid;
  const havuz = it.depo_stok_kalem_kodu ? String(it.depo_stok_kalem_kodu).trim() : '';
  if (_UUID_PATTERN.test(havuz)) return havuz;
  // UUID değil (eski non-UUID kayıt) — geriye dönük havuz çözümü
  if (havuz && _DEPO_FIZIKSEL_HAVUZ.has(havuz)) return havuz;
  const sk = magazaStokKeyFromUrunAd(it.ad);
  if (sk && _DEPO_FIZIKSEL_HAVUZ.has(sk)) return sk;
  if (havuz) return havuz;
  if (sk && sk !== 'kahve_paket') return sk;
  // Eski / özel kod: slug
  const slug = magazaDepoSlugifyTr(it.ad);
  if (slug && slug !== 'urun') return slug;
  return uid;
}

function magazaCanliDepoSatirBul(canliStokSatirlari, it) {
  const rows = Array.isArray(canliStokSatirlari) ? canliStokSatirlari : [];
  const kod = magazaDepoKalemKodu(it);
  const uid = String(it?.id || '').trim();
  const havuz = it?.depo_stok_kalem_kodu ? String(it.depo_stok_kalem_kodu).trim() : '';
  const sk = magazaStokKeyFromUrunAd(it?.ad);
  const adaylar = [kod, havuz, sk, uid].filter(Boolean);
  for (const k of adaylar) {
    const hit = rows.find((st) => String(st?.kalem_kodu || '') === k);
    if (hit) return hit;
  }
  return undefined;
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
  { id: 'acilis-takip', label: '⏰ Açılış Takip' },
  { id: 'kullanilan-urunler', label: '🟠 Kullanılan Ürünler' },
  { id: 'kapanis-takip', label: '📊 Kapanış Takip' },
  { id: 'acilis-kasa-takip', label: '💰 Açılış Takip' },
  { id: 'ciro-onay', label: '💳 Bekleyen Ciro Onayları' },
  { id: 'kasa-uyumsuzluk', label: '🔴 Kasa Uyumsuzluğu' },
  { id: 'kasa-personel-takip', label: '👥 Personel Kasa Takibi' },
  { id: 'personel-vardiya-uyumsuzluk', label: '⚠️ Personel Uyumsuzluğu' },
  { id: 'urun-uyumsuzluk', label: '🧪 Ürün Uyumsuzlukları' },
  { id: 'fire-bildirim', label: '🔥 Fire Bildirimleri' },
  { id: 'siparis-kontrol', label: '📡 Sipariş Kontrol Kulesi' },
  { id: 'magaza-kartlari', label: '🏪 Depo stokları' },
  { id: 'stok-hareketi', label: '📋 Stok Hareketi' },
  { id: 'food-cost-ozet', label: '💰 Food Cost Özeti' },
  { id: 'alis-fiyatlari', label: '🏷 Alış Fiyatları' },
  { id: 'recete', label: '📐 Reçete' },
  { id: 'shrinkage', label: '📉 Shrinkage' },
  { id: 'kontrol', label: '🔍 Kontrol' },
  { id: 'guvenlik-alarmlar', label: '🚨 Güvenlik Alarmları' },
  { id: 'metrics', label: '📊 KPI Paneli' },
  { id: 'stok-kayip', label: '📉 Stok Kayıp' },
  { id: 'personel-davranis', label: '👤 Personel Davranış' },
  { id: 'fis', label: '🧾 Fiş Kontrol' },
  { id: 'defter', label: 'Defter Kayıtları' },
  { id: 'sayim', label: 'Açılış Sayımları' },
  { id: 'siparis', label: '📦 Sipariş katalog' },
  { id: 'toptanci-siparisleri', label: '🚚 Toptancı siparişleri' },
  { id: 'toptanci-teslimler', label: '📦 Toptancıdan Gelenler' },
  { id: 'analitik', label: '📈 Şube Analitik' },
  { id: 'stok-tahmin', label: '🔮 Stok Tahmin' },
  { id: 'mesaj', label: '📩 Merkez Mesajı' },
  { id: 'sube-notlar', label: '📝 Şube Notları' },
  { id: 'puan', label: '⭐ Personel Puan' },
  { id: 'gec-acan-personel', label: '⏰ Geç Açan Personel' },
];

/** Modül penceresi içi başlık sekmeleri (CFO kart drill-down benzeri) */
const OPS_MODUL_BOLUM = {
  canli: [{ id: 'icerik', label: 'Genel Bakış' }],
  'urun-ac': [{ id: 'icerik', label: 'Günlük akış' }],
  'acilis-takip': [{ id: 'icerik', label: 'Açılış & Personel' }],
  'kullanilan-urunler': [{ id: 'icerik', label: 'Günlük akış' }],
  'kapanis-takip': [{ id: 'icerik', label: 'Günlük özet' }],
  'acilis-kasa-takip': [{ id: 'icerik', label: 'Açılış kasası' }],
  'ciro-onay': [{ id: 'icerik', label: 'Onay akışı' }],
  'kasa-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'kasa-personel-takip': [{ id: 'icerik', label: 'Takip Raporu' }],
  'personel-vardiya-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'urun-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'fire-bildirim': [{ id: 'icerik', label: 'Günlük akış' }],
  'siparis-kontrol': [{ id: 'icerik', label: 'Kontrol kulesi' }],
  'magaza-kartlari': [{ id: 'icerik', label: 'Şubeler' }],
  'stok-hareketi': [{ id: 'icerik', label: 'Hareket Defteri' }],
  'food-cost-ozet': [{ id: 'icerik', label: 'Özet' }],
  'alis-fiyatlari': [{ id: 'icerik', label: 'Fiyat Listesi' }],
  'recete': [{ id: 'icerik', label: 'Reçete Tanımları' }],
  'shrinkage': [{ id: 'icerik', label: 'Shrinkage Raporu' }],
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
  'toptanci-siparisleri': [{ id: 'icerik', label: 'Liste' }],
  'toptanci-teslimler': [{ id: 'icerik', label: 'Şube bazlı' }],
  analitik: [{ id: 'icerik', label: 'Genel özet' }],
  'stok-tahmin': [{ id: 'icerik', label: 'Tahminler' }],
  mesaj: [{ id: 'icerik', label: 'Mesajlar' }],
  'sube-notlar': [{ id: 'icerik', label: 'Gelen notlar' }],
  puan: [{ id: 'icerik', label: 'Puan listesi' }],
  'gec-acan-personel': [{ id: 'icerik', label: 'Aylık analiz' }],
};

const OPS_HUB_RENK = {
  canli: '#4a9eff',
  'urun-ac': '#2db573',
  'acilis-takip': '#f97316',
  'kullanilan-urunler': '#f59e0b',
  'kapanis-takip': '#22c55e',
  'acilis-kasa-takip': '#f97316',
  'ciro-onay': '#d946b8',
  'kasa-uyumsuzluk': '#e85d5d',
  'personel-vardiya-uyumsuzluk': '#be185d',
  'urun-uyumsuzluk': '#8b5cf6',
  'fire-bildirim': '#ef4444',
  'siparis-kontrol': '#0ea5a4',
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
  'toptanci-siparisleri': '#0ea5a4',
  'toptanci-teslimler': '#f59e0b',
  analitik: '#6366f1',
  'stok-tahmin': '#10b981',
  mesaj: '#8899aa',
  'sube-notlar': '#3b82f6',
  puan: '#ffc14d',
  'gec-acan-personel': '#0ea5a4',
  'stok-hareketi': '#64748b',
  'food-cost-ozet': '#16a34a',
  'alis-fiyatlari': '#15803d',
  'recete': '#166534',
  'shrinkage': '#dc2626',
};

/** 29 eski tab → 7 Dünya standardı modül (kahve zinciri / hizmet sektörü mantığı) */
const MODULLER = [
  {
    id: 'canli-ops',
    label: '📡 Canlı Operasyon',
    renk: '#4a9eff',
    desc: 'Anlık şube durumu, açılma takibi ve merkez direktifleri',
    tabs: ['canli', 'acilis-takip', 'mesaj', 'sube-notlar'],
  },
  {
    id: 'envanter',
    label: '📦 Envanter',
    renk: '#f08040',
    desc: 'Stok sayımı, ürün açma, fire & kayıp analizi',
    tabs: ['magaza-kartlari', 'stok-hareketi', 'sayim', 'urun-ac', 'stok-kayip', 'fire-bildirim'],
  },
  {
    id: 'siparis-tedarik',
    label: '🚚 Sipariş & Tedarik',
    renk: '#0ea5a4',
    desc: 'Sipariş kontrol kulesi, katalog ve toptancı tedarik',
    tabs: ['siparis-kontrol', 'siparis', 'toptanci-siparisleri', 'toptanci-teslimler'],
  },
  {
    id: 'finans-kasa',
    label: '💳 Finans & Kasa',
    renk: '#e85d5d',
    desc: 'Açılış/kapanış kasası, kullanılan ürünler, ciro, kasa & stok uyumsuzlukları, fiş kontrol',
    tabs: ['acilis-kasa-takip', 'kapanis-takip', 'kullanilan-urunler', 'ciro-onay', 'kasa-uyumsuzluk', 'urun-uyumsuzluk', 'kasa-personel-takip', 'fis'],
  },
  {
    id: 'personel',
    label: '👤 Personel',
    renk: '#c9a227',
    desc: 'Davranış analizi, vardiya uyumsuzluğu ve puan sistemi',
    tabs: ['kasa-personel-takip', 'personel-davranis', 'personel-vardiya-uyumsuzluk', 'gec-acan-personel', 'puan'],
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
  {
    id: 'maliyet-cfo',
    label: '💰 Maliyet & Food Cost',
    renk: '#16a34a',
    desc: 'Food cost %, alış fiyatları, reçete maliyeti ve shrinkage analizi — CFO izleme merkezi',
    tabs: ['food-cost-ozet', 'alis-fiyatlari', 'recete', 'shrinkage'],
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
  bardak_kucuk:'8oz', bardak_buyuk:'14oz', bardak_plastik:'Plastik', karton_bardak:'Karton Bardak',
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

const KULLANILAN_PASTA_KEYS = Object.keys(KULLANILAN_LABEL).filter((k) => k.startsWith('pasta_'));

/** Negatif satılan = Ürün Aç paneline girilmemiş (stok_bar_uyum.GUN_ICI_DENETIM_KEYS ile uyumlu) */
const KULLANILAN_URUN_AC_DENETIM = new Set([
  'bardak_kucuk', 'bardak_buyuk', 'bardak_plastik',
  'su_adet', 'sut_litre', 'redbull_adet', 'soda_adet', 'pasta_adet',
  ...KULLANILAN_PASTA_KEYS,
]);

function kullanilanUrunAcEksikVar(r) {
  if (r?.urun_ac_eksik_var === true) return true;
  const sat = r?.satilan || {};
  return [...KULLANILAN_URUN_AC_DENETIM].some((k) => Number(sat[k] ?? 0) < 0);
}

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

/** Kullanılan ürünler tablosu — görünen kalemlerin sütun toplamları + Evo özet. */
function kullanilanTabloOzet(r, keys, labels) {
  let tDun = 0;
  let tAc = 0;
  let tUa = 0;
  let tKap = 0;
  let tSat = 0;
  let satirSay = 0;
  const evoSatirlar = [];
  (keys || []).forEach((k) => {
    const dun = Number(r?.dun_kapanis?.[k] ?? 0);
    const ac = Number(r?.acilis?.[k] ?? 0);
    const ua = Number(r?.urun_ac?.[k] ?? 0);
    const kap = Number(r?.kapanis?.[k] ?? 0);
    const sat = Number(r?.satilan?.[k] ?? 0);
    const evoLbl = r?.evo_etiket?.[k] || '';
    if (ac === 0 && ua === 0 && kap === 0 && dun === 0 && sat === 0 && !evoLbl) return;
    satirSay += 1;
    if (!r?.onceki_kapanis_yok) tDun += dun;
    tAc += ac;
    tUa += ua;
    tKap += kap;
    tSat += sat;
    if (evoLbl) {
      evoSatirlar.push(`${labels?.[k] || k}: ${evoLbl.replace(/^Evo · /, '')}`);
    }
  });
  return { tDun, tAc, tUa, tKap, tSat, satirSay, evoSatirlar };
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

/** Ürün uyumsuzluk sekmeleri: dört mağaza her zaman; adet o günkü kayıt sayısı. */
function urunUyumSubeSekmeleriOlustur(kayitlar) {
  const rows = Array.isArray(kayitlar) ? kayitlar : [];
  const sayim = rows.reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  const map = new Map();
  MAGAZA_DORT_SUBE.forEach((m) => {
    map.set(m.slug, { key: m.slug, baslik: m.label, adet: 0 });
  });
  sayim.forEach((s) => {
    const prev = map.get(s.key);
    if (prev) prev.adet = s.adet;
    else map.set(s.key, s);
  });
  const out = Array.from(map.values());
  out.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  return out;
}

function urunUyumSubeBaslik(key) {
  const hit = MAGAZA_DORT_SUBE.find((m) => m.slug === key);
  return hit?.label || key;
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
  const aksamKapanisListe = h >= 15 || h < 2;
  const simdi = Date.now();

  const acilisBekliyor  = [];
  const acilisGecikti   = []; // hâlâ açılmadı + gecikti
  const acilisGecAcildi = []; // geç açıldı ama nihayetinde açıldı
  const kapanisBekliyor = [];
  const kapanisGecikti  = [];

  const sonEv = (events, tip) =>
    (Array.isArray(events) ? events : [])
      .filter(e => String(e?.tip || '').toUpperCase() === tip)
      .sort((a, b) => String(a?.cevap_ts || a?.sistem_slot_ts || '').localeCompare(String(b?.cevap_ts || b?.sistem_slot_ts || '')))
      .at(-1);

  const gecMs = (ts) => { try { const d = new Date(ts).getTime(); return Number.isFinite(d) ? Math.round((simdi - d) / 60000) : null; } catch (_) { return null; } };
  const araMs = (ts1, ts2) => { try { const d1 = new Date(ts1).getTime(); const d2 = new Date(ts2).getTime(); return Number.isFinite(d1) && Number.isFinite(d2) ? Math.round((d2 - d1) / 60000) : null; } catch (_) { return null; } };

  for (const k of list) {
    const oz  = k.ozet || {};
    const op  = k.operasyon || {};
    const ad  = String(k.sube_adi || k.sube_id || '').trim() || String(k.sube_id || '');
    const sid = k.sube_id;
    const events = Array.isArray(op.events) ? op.events : [];

    // --- AÇILIŞ ---
    const acilisEv = sonEv(events, 'ACILIS');
    if (!oz.acilis_tamam) {
      if (oz.acilis_gecikti) {
        const gecikme_dk = typeof op.aktif_gecikme_dk === 'number'
          ? op.aktif_gecikme_dk
          : gecMs(acilisEv?.sistem_slot_ts);
        acilisGecikti.push({ sid, ad, gecikme_dk: gecikme_dk != null && gecikme_dk > 0 ? gecikme_dk : null });
      } else {
        acilisBekliyor.push({ sid, ad });
      }
    } else if (acilisEv?.cevap_ts && acilisEv?.sistem_slot_ts) {
      // Açıldı — geç açıldı mı?
      const gecikme_dk = araMs(acilisEv.sistem_slot_ts, acilisEv.cevap_ts);
      if (gecikme_dk != null && gecikme_dk >= 5) {
        acilisGecAcildi.push({ sid, ad, gecikme_dk });
      }
    }

    // --- KAPANIŞ ---
    const kapanisEv = sonEv(events, 'KAPANIS');
    if (!oz.kapanis_tamam) {
      if (oz.kapanis_gecikti) {
        const gecikme_dk = gecMs(kapanisEv?.sistem_slot_ts);
        kapanisGecikti.push({ sid, ad, gecikme_dk: gecikme_dk != null && gecikme_dk > 0 ? gecikme_dk : null });
      } else if (aksamKapanisListe || !k.sube_acik) {
        kapanisBekliyor.push({ sid, ad });
      }
    }
  }

  const sorunSayisi = acilisBekliyor.length + acilisGecikti.length + kapanisBekliyor.length + kapanisGecikti.length;

  return {
    saatTr: h,
    aksamKapanisListe,
    acilisBekliyor,
    acilisGecikti,
    acilisGecAcildi,
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

  const tamam = bucket.sorunSayisi === 0;

  const gecStr = (dk) => {
    if (!dk || dk <= 0) return '';
    const sa = Math.floor(dk / 60); const kdk = Math.round(dk % 60);
    return ' +' + (sa > 0 ? (kdk > 0 ? `${sa}sa ${kdk}dk` : `${sa}sa`) : `${kdk}dk`);
  };

  const h = bucket.saatTr;
  const kapanisZamani = h >= 22 || h < 2;

  const parcalar = [];
  // Hâlâ açılmamış + gecikmiş → her zaman kritik
  if (bucket.acilisGecikti.length)
    parcalar.push(`🚨 AÇILMIYOR: ${bucket.acilisGecikti.map(r => r.ad + gecStr(r.gecikme_dk)).join(' · ')}`);
  // Gecikerek açıldı → gün boyunca göster (farkındalık)
  if (bucket.acilisGecAcildi.length)
    parcalar.push(`⚠️ Gecikerek açıldı: ${bucket.acilisGecAcildi.map(r => r.ad + gecStr(r.gecikme_dk)).join(' · ')}`);
  // Kapanış bilgileri yalnızca 22:00 sonrası
  if (kapanisZamani) {
    if (bucket.kapanisGecikti.length)
      parcalar.push(`🚨 Kapanış gecikti: ${bucket.kapanisGecikti.map(r => r.ad + gecStr(r.gecikme_dk)).join(' · ')}`);
    if (bucket.kapanisBekliyor.length)
      parcalar.push(`🌙 Kapanış bekleyen: ${bucket.kapanisBekliyor.map(r => r.ad).join(' · ')}`);
  }
  if (!parcalar.length)
    parcalar.push('✅  Tüm şubelerde açılış normal' + (kapanisZamani ? ' · Kapanış tamamlandı' : ''));

  const goruntulenenSorun = bucket.acilisGecikti.length + bucket.acilisGecAcildi.length
    + (kapanisZamani ? bucket.kapanisGecikti.length + bucket.kapanisBekliyor.length : 0);
  const tickerMetni = (parcalar.join('   ·   ') + '      ').repeat(3);
  const renk = goruntulenenSorun === 0 ? '#22c55e' : '#ea580c';
  const hiz = Math.max(12, tickerMetni.length * 0.18);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        marginBottom: 12,
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${tamam ? 'rgba(34,197,94,0.25)' : 'rgba(234,88,12,0.3)'}`,
        background: tamam ? 'rgba(34,197,94,0.07)' : 'rgba(234,88,12,0.07)',
        height: 34,
      }}
    >
      {/* Sol etiket */}
      <div style={{
        flexShrink: 0,
        padding: '0 10px',
        fontSize: 11,
        fontWeight: 800,
        color: renk,
        background: goruntulenenSorun === 0 ? 'rgba(34,197,94,0.15)' : 'rgba(234,88,12,0.15)',
        borderRight: `1px solid ${goruntulenenSorun === 0 ? 'rgba(34,197,94,0.25)' : 'rgba(234,88,12,0.3)'}`,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        letterSpacing: '0.03em',
      }}>
        {goruntulenenSorun === 0 ? '✔ DURUM' : `⚠ ${goruntulenenSorun} ŞUBE`}
      </div>
      {/* Kayan metin */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', height: '100%' }}>
        <style>{`
          @keyframes ops-ticker { from { transform: translateX(0); } to { transform: translateX(-33.333%); } }
        `}</style>
        <div style={{
          display: 'inline-block',
          whiteSpace: 'nowrap',
          fontSize: 12,
          color: tamam ? '#86efac' : '#fdba74',
          fontWeight: 600,
          lineHeight: '34px',
          animation: `ops-ticker ${hiz}s linear infinite`,
          paddingLeft: 12,
        }}>
          {tickerMetni}
        </div>
      </div>
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

function SubeKart({ k, onDetay, personelRisk, haftaTrend }) {
  // Uyarı filtre toggle: default 'bugun', tıklanırsa 'hepsi'
  const [uyariFiltre, setUyariFiltre] = useState('bugun');  // 'bugun' | 'hepsi'
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

  // Uyarı filtre: bugün (default) vs hepsi (geçmiş tüm)
  const tumUyarilar = k.uyarilar || [];
  const bugunIso = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const bugunUyarilar = tumUyarilar.filter(u => {
    const ts = String(u.olusturma || u.tarih || '');
    return ts.startsWith(bugunIso);
  });
  const uyarilar = uyariFiltre === 'hepsi' ? tumUyarilar : bugunUyarilar;
  const eskiSayi = tumUyarilar.length - bugunUyarilar.length;
  const kritikler = uyarilar.filter(u => u.seviye === 'kritik');
  const digerUyarilar = uyarilar.filter(u => u.seviye !== 'kritik');
  const g = k.guvenlik || {};
  const ad = g.alarm_durum;

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{k.sube_adi || k.sube_id}</span>
          {haftaTrend && haftaTrend.degisim_pct != null && (() => {
            const pct = Number(haftaTrend.degisim_pct);
            const yukari = pct >= 0;
            return (
              <span
                title={`Bu hafta ${fmt(haftaTrend.bu_hafta)} · geçen hafta ${fmt(haftaTrend.gecen_hafta)}`}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
                  background: yukari ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
                  color: yukari ? '#4ade80' : '#fca5a5',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {yukari ? '↑' : '↓'}%{Math.abs(pct)}
              </span>
            );
          })()}
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!b.kritik && b.geciken && <span className="badge badge-yellow">Gecikme</span>}
          {b.fark_var && <span className="badge badge-yellow">Fark</span>}
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

      {/* ŞU AN VARDİYADA — kim var? */}
      {Array.isArray(k.vardiya_su_an) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: 'var(--text3)' }}>👥 Vardiyada:</span>
          {k.vardiya_su_an.length === 0 ? (
            <span style={{ color: 'var(--text3)', fontStyle: 'italic' }}>şu an kayıtlı kimse yok</span>
          ) : (
            k.vardiya_su_an.map((v, i) => (
              <span key={i} className="badge badge-green" title={v.bas ? `${v.bas}–${v.bit}` : ''}>
                {v.ad}{v.bas ? ` · ${v.bas}–${v.bit}` : ''}
              </span>
            ))
          )}
        </div>
      )}

      {/* Vardiya devri + özet bayraklar — tek satır */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: k.vardiya_devri_tamam ? 'var(--green)' : k.vardiya_devri_basladi ? 'var(--yellow)' : 'var(--text3)' }}>
          {k.vardiya_devri_tamam ? '✓ Devir' : k.vardiya_devri_basladi ? '⏳ Devir' : '— Devir'}
        </span>
        {(b.kritik || kritikler.length > 0) && (
          <span className="badge badge-red" title={kritikler.map(u => temizMesaj(u.mesaj)).join('\n')}>
            🚨 {kritikler.length > 0 ? `${kritikler.length} kritik` : 'kritik'}
            {uyariFiltre === 'bugun' && kritikler.length > 0 && <span style={{ opacity: 0.7, marginLeft: 4 }}>(bugün)</span>}
          </span>
        )}
        {(o.alarm_sayisi_toplam || 0) > 0 && (
          <span className="badge badge-red" title="Operasyon eventlerinde biriken alarm sayacı (bugün)">
            🔐 {o.alarm_sayisi_toplam} alarm <span style={{ opacity: 0.7 }}>(bugün)</span>
          </span>
        )}
        {digerUyarilar.length > 0 && (
          <span className="badge badge-yellow" title={digerUyarilar.map(u => temizMesaj(u.mesaj)).join('\n')}>
            ⚠️ {digerUyarilar.length} uyarı{uyariFiltre === 'bugun' ? ' (bugün)' : ''}
          </span>
        )}
        {/* Bugün/Hepsi toggle — sadece geçmişten eski uyarı varsa görünür */}
        {eskiSayi > 0 && (
          <span
            onClick={(e) => { e.stopPropagation(); setUyariFiltre(uyariFiltre === 'bugun' ? 'hepsi' : 'bugun'); }}
            style={{
              fontSize: 11, fontWeight: 700, cursor: 'pointer',
              padding: '3px 10px', borderRadius: 999,
              background: uyariFiltre === 'hepsi' ? 'rgba(99,102,241,0.28)' : 'rgba(99,102,241,0.14)',
              color: uyariFiltre === 'hepsi' ? '#c7d2fe' : '#a5b4fc',
              border: `1px solid ${uyariFiltre === 'hepsi' ? '#6366f1' : 'rgba(99,102,241,0.40)'}`,
              userSelect: 'none',
            }}
            title={uyariFiltre === 'bugun'
              ? `Hepsini göster — kritik + uyarı sayıları geçmişe dahil olur (toplam ${tumUyarilar.length})`
              : 'Sadece bugünü göster'}
          >
            {uyariFiltre === 'hepsi'
              ? `📅 Hepsi · Bugüne dön`
              : `📅 Hepsi (${tumUyarilar.length})`}
          </span>
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

      {(subeOzet.length > 0 || riskPersonel.length > 0) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => listeyiCsvIndir(
              subeOzet,
              [
                { key: 'sube', baslik: 'Şube', fn: (s) => s.sube_adi || s.sube_id },
                { key: 'toplam_acik', baslik: 'Toplam Açık Birim', fn: (s) => s.toplam_acik || 0 },
                { key: 'gun_sayisi', baslik: 'Sapma Gün', fn: (s) => s.sapma_gun_sayisi ?? s.gun_sayisi ?? '' },
              ],
              'stok_kayip'
            )}
          >
            ⬇️ CSV
          </button>
        </div>
      )}

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
  const [oncekiSekme, setOncekiSekme] = useState('');
  const [aktifModul, setAktifModul] = useState('');
  const [opsMerkezPencere, setOpsMerkezPencere] = useState(false);
  const [opsIcBolum, setOpsIcBolum] = useState('icerik');
  const [filtre,    setFiltre]    = useState('all');
  const [kartlar,   setKartlar]   = useState([]);
  const [alertDrawerAcik, setAlertDrawerAcik] = useState(false);
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
  const [kuyrukToptanciTedarikci, setKuyrukToptanciTedarikci] = useState({}); // talep_id -> aktif toptancı adı
  const [kuyrukToptanciNot, setKuyrukToptanciNot] = useState({}); // talep_id -> not
  const [kuyrukToptanciKalemDeger, setKuyrukToptanciKalemDeger] = useState({}); // `${talep_id}::${kk}` -> adet override
  const [kuyrukToptanciKalemTedarikci, setKuyrukToptanciKalemTedarikci] = useState({}); // legacy
  const [toptanciSecili, setToptanciSecili] = useState({});    // `${talep_id}::${kk}` -> bool
  const [toptanciAtanmis, setToptanciAtanmis] = useState({});  // `${talep_id}::${kk}` -> listeNo
  const [toptanciListeler, setToptanciListeler] = useState({}); // talep_id -> [{listeNo,toptanciAd,kalemler,ts}]
  const [toptanciSiparisListe, setToptanciSiparisListe] = useState({
    gun: 30,
    donem: 'gun_30',
    filtre_etiket: 'Son 30 gün',
    toplam_kayit: 0,
    satirlar: [],
    gonderimler: [],
  });
  const [toptanciSiparisDonem, setToptanciSiparisDonem] = useState('gun_30');
  const [toptanciSiparisTarih, setToptanciSiparisTarih] = useState(() => bugunIsoTarih());
  const [toptanciSiparisSirala, setToptanciSiparisSirala] = useState('en_son');
  const [toptanciSiparisGorunum, setToptanciSiparisGorunum] = useState('gonderim');
  const [toptanciOnUrun, setToptanciOnUrun] = useState(null); // stok-tahmin'den gelen ön-seçili ürün ipucu
  const [toptanciTeslimGun, setToptanciTeslimGun] = useState(30);
  const [toptanciTeslimListe, setToptanciTeslimListe] = useState(null);
  const [toptanciTeslimAcikSube, setToptanciTeslimAcikSube] = useState(null);
  const [analitikGun, setAnalitikGun] = useState(30);
  const [analitikVeri, setAnalitikVeri] = useState(null);
  // Şube Analitik için aylık food cost cache (rapor_aylik_food_cost'tan)
  const [aylikFoodCostCache, setAylikFoodCostCache] = useState(null);
  const yukleAylikFoodCost = useCallback(async () => {
    try {
      const r = await api('/ops/rapor-cache/aylik-food-cost');
      setAylikFoodCostCache(r);
    } catch {
      setAylikFoodCostCache(null);
    }
  }, []);
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
  const [magazaUrunAdGuncelleAcik, setMagazaUrunAdGuncelleAcik] = useState(false);
  const [magazaUrunAdForm, setMagazaUrunAdForm] = useState({ kategori_kod: '', urun_id: '', yeni_ad: '' });
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
  /** Canlı depo sekmesi: slug → kategori id (katalog kat.id | __havuz__ | __diger__) */
  const [magazaDepoCanliKatSekme, setMagazaDepoCanliKatSekme] = useState({});
  /** `${subeKey}::${urunId}` -> onay bekleyen stok değişikliği */
  const [magazaStokOnayBekleyen, setMagazaStokOnayBekleyen] = useState({});
  /** `${subeKey}::${urunId}` -> onay API çağrısı in-flight */
  const [magazaStokOnayBusy, setMagazaStokOnayBusy] = useState({});
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
  /** Hub üst kart: yalnızca gelen (bekleyen) katalog sipariş alarm satırları */
  const hubGelenSiparisAlarmlari = useMemo(
    () => (opsOzet?.alarm_satirlari || []).filter((a) => a?.tip === 'siparis_merkez_bekliyor'),
    [opsOzet?.alarm_satirlari],
  );
  const hubGelenSiparisGoster =
    (Number(opsOzet?.siparis_bekleyen) || 0) > 0 || hubGelenSiparisAlarmlari.length > 0;
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
  /** acilis-takip içi sekme: canli | gec-acilis | plan-kayitsiz | personel */
  const [acilisTakipSekme, setAcilisTakipSekme] = useState('canli');
  /** Geç Açılış iç sekme: son7gun | tarih */
  const [gecDetaySekme, setGecDetaySekme] = useState('son7gun');
  /** Plansız Şube iç sekme: son7gun | tarih */
  const [planDetaySekme, setPlanDetaySekme] = useState('son7gun');
  const acilisTakipPersonelAcik = acilisTakipSekme === 'personel';
  const setAcilisTakipPersonelAcik = (v) => setAcilisTakipSekme(v ? 'personel' : 'canli');
  const acilisTakipAlt = acilisTakipSekme === 'personel' ? 'gec-personel' : 'gec-acilis';
  const setAcilisTakipAlt = (v) => setAcilisTakipSekme(v === 'gec-personel' ? 'personel' : 'gec-acilis');
  const gecAcilanKartSekme = acilisTakipSekme === 'plan-kayitsiz' ? 'plan_kayitsiz' : 'akis';
  const setGecAcilanKartSekme = (v) => setAcilisTakipSekme(v === 'plan_kayitsiz' ? 'plan-kayitsiz' : 'gec-acilis');
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
  const [kullanilanEvoYenileniyor, setKullanilanEvoYenileniyor] = useState(false);
  const kullanilanEvoPollRef = useRef(null);
  const [kapanisTakip, setKapanisTakip] = useState(null);
  const [kapanisTakipYukleniyor, setKapanisTakipYukleniyor] = useState(false);
  const [kapanisTakipTarih, setKapanisTakipTarih] = useState(isGunuIsoIstanbul());
  const [kapanisTakipSonGuncelleme, setKapanisTakipSonGuncelleme] = useState(null);
  const [kapanisTakipKaynak, setKapanisTakipKaynak] = useState(null);  // 'cache' | 'live'
  const [kapanisTakipSubeSec, setKapanisTakipSubeSec] = useState(null);  // seçili şube_id | null (tümü)
  const kapanisTakipIntervalRef = useRef(null);
  const [acilisKasaTakip, setAcilisKasaTakip] = useState(null);
  const [acilisKasaTakipYukleniyor, setAcilisKasaTakipYukleniyor] = useState(false);
  const [acilisKasaTakipTarih, setAcilisKasaTakipTarih] = useState(isGunuIsoIstanbul());
  const [acilisKasaTakipSonGuncelleme, setAcilisKasaTakipSonGuncelleme] = useState(null);
  const acilisKasaTakipIntervalRef = useRef(null);

  // Sekme bazlı son güncelleme map'i — her sekmenin freshness rozeti bundan beslenir
  // Helper: markGuncel('sekme-adi') → state günceller, badge yenilenir
  const [sekmeSonGuncelleme, setSekmeSonGuncelleme] = useState({});
  const markGuncel = useCallback((sekme) => {
    setSekmeSonGuncelleme((prev) => ({ ...prev, [sekme]: new Date() }));
  }, []);

  // Sekme açıldığında otomatik mark — loader paralel çalışır, badge anında doğru
  // Loader bittikten sonra ilgili fonksiyon zaten markGuncel çağırır (override eder)
  useEffect(() => {
    if (aktifSekme) {
      setSekmeSonGuncelleme((prev) => ({ ...prev, [aktifSekme]: new Date() }));
    }
  }, [aktifSekme]);
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
  /** all | bekleyen | cozuldu — çözülen kayıtlar varsayılan listede kaybolmasın */
  const [kasaUyumDurumFiltre, setKasaUyumDurumFiltre] = useState('all');
  /** Bugünden geriye 7 gün: çözüm bekleyen kasa uyarısı özeti (API yalnızca okundu=false döner). */
  const [kasaUyumHaftaSatirlari, setKasaUyumHaftaSatirlari] = useState([]);
  const [kasaUyumHaftaYukleniyor, setKasaUyumHaftaYukleniyor] = useState(false);
  const [kasaAcikAnaliz, setKasaAcikAnaliz] = useState({ takip_listesi: [], acik_listesi: [] });
  const [kasaAcikAnalizYukleniyor, setKasaAcikAnalizYukleniyor] = useState(false);
  const [kasiyerKarne, setKasiyerKarne] = useState([]);

  // Kasa Farkı Kaynak Düzeltme Modal
  const [kkDuzeltModal, setKkDuzeltModal] = useState(null); // { uyari, sebep, payload }
  // Tarihçe modal: { uyari, tarihce: [], yukleniyor: bool, geriAlBusyId: string|null }
  const [kkTarihceModal, setKkTarihceModal] = useState(null);
  const [tahsisCozModal, setTahsisCozModal] = useState(null); // { talep_id, urun_id, kalem_adi, talep_adet, tahsis_adet }
  const [tahsisCozBusy, setTahsisCozBusy] = useState(false);
  const [kkDuzeltBusy, setKkDuzeltBusy] = useState(false);

  // Stok Hareketi
  const [stokHareket, setStokHareket] = useState({ satirlar: [], tur_ozet: [], sube_ozet: [], toplam: 0 });
  const [stokHareketYukleniyor, setStokHareketYukleniyor] = useState(false);
  const [stokHareketGun, setStokHareketGun] = useState(30);
  const [stokHareketSubeFiltre, setStokHareketSubeFiltre] = useState('');
  const [stokHareketTurFiltre, setStokHareketTurFiltre] = useState('');

  // Maliyet & Food Cost
  const [maliyetOzet, setMaliyetOzet] = useState(null);
  const [maliyetYukleniyor, setMaliyetYukleniyor] = useState(false);
  const [maliyetGun, setMaliyetGun] = useState(30);
  const [foodCostHesaplaYukleniyor, setFoodCostHesaplaYukleniyor] = useState(false);
  const [foodCostHesaplaSonuc, setFoodCostHesaplaSonuc] = useState(null);
  const [foodCostHesaplaTarih, setFoodCostHesaplaTarih] = useState(() => new Date().toISOString().slice(0, 10));
  const [alisFiyatlari, setAlisFiyatlari] = useState([]);
  const [receteler, setReceteler] = useState([]);

  // Alış Fiyatı Formu
  const [alisFormGoster, setAlisFormGoster] = useState(false);
  const [alisFormKayit, setAlisFormKayit] = useState(false);
  const [alisForm, setAlisForm] = useState({ kalem_kodu: '', kalem_adi: '', birim: 'kg', birim_maliyet_tl: '', tedarikci: '', notlar: '' });

  // Reçete Formu
  const [receteFormGoster, setReceteFormGoster] = useState(false);
  const [receteFormKayit, setReceteFormKayit] = useState(false);
  const [receteDuzenle, setReceteDuzenle] = useState(null); // null = yeni, string = urun_id
  const [receteForm, setReceteForm] = useState({ urun_id: '', urun_adi: '', hammaddeler: [{ hammadde_kodu: '', hammadde_adi: '', miktar: '', birim: 'kg' }] });
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
  const [urunUyumDurumFiltre, setUrunUyumDurumFiltre] = useState('all');
  const [urunUyumHaftaSatirlari, setUrunUyumHaftaSatirlari] = useState([]);
  const [urunUyumHaftaYukleniyor, setUrunUyumHaftaYukleniyor] = useState(false);
  const [fireBugun, setFireBugun] = useState({ gun_toplam: 0, kayitlar: [] });
  const [fireAramaTarih, setFireAramaTarih] = useState(bugunIsoTarih());
  const [fireAramaYukleniyor, setFireAramaYukleniyor] = useState(false);
  const [fireAramaSonuc, setFireAramaSonuc] = useState({ tarih: '', gun_toplam: 0, kayitlar: [] });
  const [fireSeciliSubeKey, setFireSeciliSubeKey] = useState('all');
  const [fireSebepFiltre, setFireSebepFiltre] = useState('');
  const [fireHaftaSatirlari, setFireHaftaSatirlari] = useState([]);
  const [fireHaftaYukleniyor, setFireHaftaYukleniyor] = useState(false);
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
      if (aktifSekme !== 'acilis-takip') {
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
      if (aktifSekme !== 'acilis-takip') {
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

  const kullanilanGunYukle = useCallback(async (tarih, { evoYenile = false } = {}) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const evoQs = evoYenile ? '&evo_yenile=1' : '';
    const r = await api(
      `/ops/bar-ozet?year_month=${encodeURIComponent(ym)}&gun=${encodeURIComponent(hedef)}&limit=180&kapanis_fallback=false${evoQs}`,
    );
    const ham = Array.isArray(r?.satirlar) ? r.satirlar : [];
    const satirlar = ham.filter((row) => row?.kapanis_var === true);
    const toplamAdet = satirlar.reduce((sum, row) => sum + _sumSatilan(row?.satilan), 0);
    return {
      tarih: hedef,
      toplam_islem: satirlar.length,
      toplam_adet: toplamAdet,
      satirlar,
      kapanis_eksik_sube: ham.filter((row) => row?.kapanis_var !== true).length,
      evo_veri_geldi: r?.evo_veri_geldi,
      evo_mesaj: r?.evo_mesaj || null,
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

  const kullanilanAramaYap = useCallback(async (opts = {}) => {
    const evoYenile = !!opts.evoYenile;
    const hedef = (kullanilanAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    if (evoYenile) setKullanilanEvoYenileniyor(true);
    else setKullanilanAramaYukleniyor(true);
    try {
      const data = await kullanilanGunYukle(hedef, { evoYenile });
      setKullanilanAramaSonuc(data);
      if (hedef === bugunIsoTarih()) setKullanilanBugun(data);
      if (evoYenile && data.evo_veri_geldi) {
        toast('Evo verisi güncellendi', 'green');
      }
    } catch (e) {
      toast(e.message || 'Kullanılan ürün araması yapılamadı');
    } finally {
      if (evoYenile) setKullanilanEvoYenileniyor(false);
      else setKullanilanAramaYukleniyor(false);
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

  // Cache → satır formatına dönüştür (kapanis-takip satır formatıyla uyumlu)
  const _cacheToKapanisTakipSatirlar = useCallback((cacheRes) => {
    const k = Array.isArray(cacheRes?.kayitlar) ? cacheRes.kayitlar : [];
    if (k.length === 0) return null;
    const satirlar = k.map((row) => ({
      sube_id: row.sube_id,
      sube_adi: row.sube_id,  // gerçek ad live'da gelecek; cache'ten geçici
      // Açılış
      acildi: !!row.acilis_yapildi,
      sabah_kasa_tl: Number(row.kasa_acilis || 0),
      // Kapanış
      kapanis_tamam: !!row.kapanis_yapildi,
      teslim_kasa_tl: Number(row.kasa_teslim || 0),
      devir: Number(row.kasa_devir || 0),
      ara_teslim_tl: Number(row.ara_teslim || 0),
      kapanis_personel: row.kapanis_personel || '',
      // Ciro
      ciro_onaylandi: row.ciro_durum === 'onaylandi',
      taslak_var: row.ciro_durum === 'taslak',
      taslak_durum: row.ciro_durum === 'taslak' ? 'bekliyor' : '',
      nakit: Number(row.ciro_nakit || 0),
      pos: Number(row.ciro_pos || 0),
      online: Number(row.ciro_online || 0),
      ciro_tutar: Number(row.ciro_toplam || 0),
      // Gider + kasa fark
      anlik_gider_nakit_tl: Number(row.anlik_gider_nakit || 0),
      nakit_kasa_fark_tl: row.kasa_fark_tl,
      nakit_denkleme_tam: row.kasa_fark_durum != null,
      // Meta
      _cache: true,  // bu satır cache'ten geldi işareti
    }));
    return {
      tarih: cacheRes?.bastar || cacheRes?.bittar || null,
      satirlar,
      sube_sayisi: satirlar.length,
      kapanis_yapan_adet: satirlar.filter((r) => r.kapanis_tamam).length,
      ciro_onaylanan_adet: satirlar.filter((r) => r.ciro_onaylandi).length,
      taslak_bekleyen_adet: satirlar.filter((r) => r.taslak_var && r.taslak_durum === 'bekliyor').length,
      eksik_kapanis_adet: satirlar.filter((r) => !r.kapanis_tamam).length,
      eksik_ciro_adet: satirlar.filter((r) => !r.ciro_onaylandi && !r.taslak_var).length,
      _cache: true,
    };
  }, []);

  const yukleKapanisTakip = useCallback(async (tarih, { silent = false, cacheFirst = false } = {}) => {
    const hedef = (tarih || isGunuIsoIstanbul()).trim();
    if (!silent) setKapanisTakipYukleniyor(true);

    // CACHE-FIRST: önce hızlı cache'ten oku (sadece ilk yüklemede), anında ekrana bas
    if (cacheFirst) {
      try {
        const cr = await api(`/ops/rapor-cache/gunluk?bastar=${hedef}&bittar=${hedef}`);
        const cacheData = _cacheToKapanisTakipSatirlar(cr);
        if (cacheData) {
          setKapanisTakip(cacheData);
          setKapanisTakipKaynak('cache');
          setKapanisTakipSonGuncelleme(new Date());
          // Cache geldi — yükleniyor spinner'ı kaldır (kullanıcı veriyi gördü)
          if (!silent) setKapanisTakipYukleniyor(false);
        }
      } catch {
        // Cache hatası sessiz, live devam etsin
      }
    }

    // LIVE: kesin doğru veri (cache üzerine yazar)
    try {
      const r = await api(`/ops/kapanis-takip?tarih=${encodeURIComponent(hedef)}`);
      setKapanisTakip(r);
      setKapanisTakipKaynak('live');
      setKapanisTakipSonGuncelleme(new Date());
    } catch (e) {
      if (!silent) toast(e.message || 'Kapanış takip yüklenemedi');
    } finally {
      if (!silent) setKapanisTakipYukleniyor(false);
    }
  }, [toast, _cacheToKapanisTakipSatirlar]);

  const yukleAcilisKasaTakip = useCallback(async (tarih, { silent = false } = {}) => {
    const hedef = (tarih || isGunuIsoIstanbul()).trim();
    if (!silent) setAcilisKasaTakipYukleniyor(true);
    try {
      const r = await api(`/ops/acilis-kasa-takip?tarih=${encodeURIComponent(hedef)}`);
      setAcilisKasaTakip(r);
      setAcilisKasaTakipSonGuncelleme(new Date());
    } catch (e) {
      if (!silent) toast(e.message || 'Açılış takip yüklenemedi');
    } finally {
      if (!silent) setAcilisKasaTakipYukleniyor(false);
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
      markGuncel('ciro-onay');
    } catch (e) {
      if (!silent) toast(e.message || 'Bekleyen ciro onayları yüklenemedi');
    } finally {
      setCiroOnayBugunYukleniyor(false);
    }
  }, [aktifSekme, ciroOnayGunYukle, toast, markGuncel]);

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

  const kasaUyumGunYukle = useCallback(async (tarih, opts = {}) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const durum = opts.durum || 'all';
    let url = `/ops/kasa-uyumsuzluk?tarih=${encodeURIComponent(hedef)}`;
    if (durum === 'bekleyen') url += '&sadece_bekleyen=true';
    else if (durum === 'cozuldu') url += '&sadece_cozuldu=true';
    else url += '&sadece_bekleyen=false&sadece_cozuldu=false';
    const r = await api(url);
    const kayitlar = Array.isArray(r?.liste) ? r.liste : [];
    return {
      tarih: hedef,
      toplam: r?.toplam ?? kayitlar.length,
      gun_toplam: r?.gun_toplam ?? kayitlar.length,
      gun_bekleyen: r?.gun_bekleyen ?? kayitlar.filter((u) => !u.cozuldu).length,
      gun_cozuldu: r?.gun_cozuldu ?? kayitlar.filter((u) => u.cozuldu).length,
      kayitlar,
      eksik_kapanis: [],
    };
  }, []);

  const yukleKasaUyumBugun = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    setKasaUyumBugunYukleniyor(true);
    try {
      const data = await kasaUyumGunYukle(bugunIsoTarih(), { durum: 'bekleyen' });
      setKasaUyumBugun(data);
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
      const data = await kasaUyumGunYukle(hedef, { durum: kasaUyumDurumFiltre });
      setKasaUyumAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Kasa uyumsuzluk araması yapılamadı');
    } finally {
      setKasaUyumAramaYukleniyor(false);
    }
  }, [kasaUyumAramaTarih, kasaUyumDurumFiltre, kasaUyumGunYukle, toast]);

  const kasaUyumHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) {
      gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    }
    const responses = await Promise.all(
      gunlerDesc.map((t) => api(`/ops/kasa-uyumsuzluk?tarih=${encodeURIComponent(t)}&sadece_bekleyen=false`).catch(() => null)),
    );
    return gunlerDesc.map((tarih, i) => {
      const r = responses[i];
      const kayitlar = Array.isArray(r?.liste) ? r.liste : [];
      let maxAbs = 0;
      kayitlar.forEach((u) => {
        const a = Math.abs(Number(u?.fark_tl || 0));
        if (Number.isFinite(a) && a > maxAbs) maxAbs = a;
      });
      return {
        tarih,
        adet: Number(r?.gun_toplam ?? kayitlar.length) || 0,
        bekleyenAdet: Number(r?.gun_bekleyen ?? 0) || 0,
        cozulduAdet: Number(r?.gun_cozuldu ?? 0) || 0,
        maxAbsFark: maxAbs,
      };
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

  const urunUyumGunYukle = useCallback(async (tarih, opts = {}) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const durum = opts.durum || 'all';
    let url = `/ops/urun-uyumsuzluk?tarih=${encodeURIComponent(hedef)}`;
    if (durum === 'bekleyen') url += '&sadece_bekleyen=true';
    else if (durum === 'cozuldu') url += '&sadece_cozuldu=true';
    else url += '&sadece_bekleyen=false&sadece_cozuldu=false';
    const r = await api(url);
    const kayitlar = Array.isArray(r?.liste) ? r.liste : [];
    return {
      tarih: hedef,
      toplam: r?.toplam ?? kayitlar.length,
      gun_toplam: r?.gun_toplam ?? kayitlar.length,
      gun_bekleyen: r?.gun_bekleyen ?? kayitlar.filter((u) => !u.cozuldu).length,
      gun_cozuldu: r?.gun_cozuldu ?? kayitlar.filter((u) => u.cozuldu).length,
      kayitlar,
    };
  }, []);

  const urunUyumHaftaYukle = useCallback(async () => {
    const bugun = bugunIsoTarih();
    const gunlerDesc = [];
    for (let i = 0; i < 7; i += 1) gunlerDesc.push(isoTariheGunEkle(bugun, -i));
    setUrunUyumHaftaYukleniyor(true);
    try {
      const sonuclar = await Promise.all(
        gunlerDesc.map((t) => api(`/ops/urun-uyumsuzluk?tarih=${encodeURIComponent(t)}&sadece_bekleyen=false&sadece_cozuldu=false`).catch(() => null)),
      );
      setUrunUyumHaftaSatirlari(
        gunlerDesc.map((t, i) => ({
          tarih: t,
          adet: Number(sonuclar[i]?.gun_toplam ?? sonuclar[i]?.toplam ?? 0),
        })),
      );
    } finally {
      setUrunUyumHaftaYukleniyor(false);
    }
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
      const data = await urunUyumGunYukle(hedef, { durum: urunUyumDurumFiltre });
      setUrunUyumAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Ürün uyumsuzluk araması yapılamadı');
    } finally {
      setUrunUyumAramaYukleniyor(false);
    }
  }, [urunUyumAramaTarih, urunUyumDurumFiltre, urunUyumGunYukle, toast]);

  const fireGunYukle = useCallback(async (tarih, opts = {}) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    let url = `/ops/fire-bildirimler?tarih=${encodeURIComponent(hedef)}`;
    const sebep = opts.sebep != null ? opts.sebep : fireSebepFiltre;
    if (sebep) url += `&sebep_kodu=${encodeURIComponent(sebep)}`;
    return api(url);
  }, [fireSebepFiltre]);

  const fireHaftaYukle = useCallback(async () => {
    setFireHaftaYukleniyor(true);
    try {
      const gunlerDesc = [];
      for (let i = 0; i < 7; i += 1) gunlerDesc.push(isoTariheGunEkle(bugunIsoTarih(), -i));
      const sonuclar = await Promise.all(
        gunlerDesc.map((t) => api(`/ops/fire-bildirimler?tarih=${encodeURIComponent(t)}`).catch(() => null)),
      );
      const satirlar = gunlerDesc.map((t, idx) => {
        const r = sonuclar[idx];
        return {
          tarih: t,
          toplam: Number(r?.gun_toplam ?? (r?.kayitlar || []).length),
          adet: Number(r?.toplam_adet_gun ?? (r?.kayitlar || []).reduce((s, k) => s + (k.toplam_adet || 0), 0)),
        };
      });
      setFireHaftaSatirlari(satirlar);
    } catch (e) {
      toast(e.message || 'Fire hafta özeti yüklenemedi');
    } finally {
      setFireHaftaYukleniyor(false);
    }
  }, [toast]);

  const fireAramaYap = useCallback(async () => {
    const hedef = (fireAramaTarih || bugunIsoTarih()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hedef)) {
      toast('Tarih formatı YYYY-MM-DD olmalı');
      return;
    }
    setFireAramaYukleniyor(true);
    try {
      const data = await fireGunYukle(hedef, { sebep: fireSebepFiltre });
      setFireAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'Fire bildirimleri yüklenemedi');
    } finally {
      setFireAramaYukleniyor(false);
    }
  }, [fireAramaTarih, fireSebepFiltre, fireGunYukle, toast]);

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
    const donem = String(toptanciSiparisDonem || 'gun_30');
    try {
      const q = new URLSearchParams();
      q.set('donem', donem);
      q.set('sirala', String(toptanciSiparisSirala || 'en_son'));
      q.set('limit', '1200');
      if (donem === 'tarih') {
        q.set('tarih', String(toptanciSiparisTarih || bugunIsoTarih()).trim().slice(0, 10));
      } else if (donem.startsWith('gun_')) {
        q.set('gun', String(donem.split('_')[1] || '30'));
      }
      const r = await api('/ops/siparis/toptanci-listesi?' + q.toString());
      setToptanciSiparisListe({
        gun: Number(r?.gun || 30),
        donem: r?.donem || donem,
        filtre_etiket: r?.filtre_etiket || '',
        tarih_bas: r?.tarih_bas,
        tarih_bit: r?.tarih_bit,
        sirala: r?.sirala || toptanciSiparisSirala,
        toplam_kayit: Number(r?.toplam_kayit || 0),
        toplam_satir: Number(r?.toplam_satir || 0),
        satirlar: Array.isArray(r?.satirlar) ? r.satirlar : [],
        gonderimler: Array.isArray(r?.gonderimler) ? r.gonderimler : [],
      });
    } catch (e) {
      toast(e.message || 'Toptancı sipariş listesi yüklenemedi');
      setToptanciSiparisListe({
        gun: 30,
        donem,
        filtre_etiket: '',
        toplam_kayit: 0,
        satirlar: [],
        gonderimler: [],
      });
    } finally {
      setYukleniyor(false);
    }
  }, [toast, toptanciSiparisDonem, toptanciSiparisTarih, toptanciSiparisSirala]);

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
      // Paralel: aylık food cost cache (hızlı, sadece çekiyoruz)
      yukleAylikFoodCost();
      markGuncel('analitik');
    } catch (e) {
      toast(e.message || 'Analitik yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [toast, analitikGun, markGuncel, yukleAylikFoodCost]);

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

  const yukleSubeNotlar = useCallback(async () => {
    try {
      const qs = `year_month=${encodeURIComponent(ayFiltre)}`;
      const sq = subeOnayFiltre ? `&sube_id=${encodeURIComponent(subeOnayFiltre)}` : '';
      const n = await api(`/ops/sube-notlar?${qs}${sq}&limit=200`);
      setNotlarListe(n?.satirlar || []);
    } catch (e) {
      toast(e.message || 'Şube notları yüklenemedi');
    }
  }, [ayFiltre, subeOnayFiltre, toast]);

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
      markGuncel('metrics');
    } catch (e) {
      console.error('yukleMetrics hata:', e);
    } finally {
      setYukleniyor(false);
    }
  }, [markGuncel]);

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

  const magazaDepoTamYenile = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setYukleniyor(true);
      setMagazaDepoKatalogState((s) => ({ ...s, yukleniyor: true }));
    }
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
      // Sessiz (otomatik) yenilemede geçici hata olursa mevcut veriyi silme —
      // sadece elle/sekme yüklemesinde temiz boş duruma düş.
      if (!silent) {
        setMagazaDepoKatalogState({ yukleniyor: false, kategoriler: [] });
        setMagazaDepoCanliStok({});
        setMagazaDepoDepoMeta({});
      }
    }
  }, [filtre, yukle]);

  const magazaStokOnayBekleyenAdet = Object.keys(magazaStokOnayBekleyen || {}).length;
  const oncekiSekmeRef = useRef(aktifSekme);

  const magazaStokKalemOnayla = useCallback(async ({
    slug,
    subeDepoKey,
    subeId,
    mapKey,
    kalemKodu,
    kalemAdi,
    mevcutAdet,
    minStok,
    alisFiyatiTl,
  }) => {
    const sid = String(subeId || '').trim();
    const kk = String(kalemKodu || '').trim();
    const draftKey = String(mapKey || '').trim() || `${subeDepoKey}::${kk}`;
    if (!sid || !kk) {
      toast('Bu depo kartında şube/kalem bilgisi eksik.', 'red');
      return;
    }
    setMagazaStokOnayBusy((prev) => ({ ...prev, [draftKey]: true }));
    try {
      const res = await api('/ops/v2/sube-depo/guncelle', {
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
      const resolvedKk = String(res?.kalem_kodu || kk).trim() || kk;
      try {
        const depoRes = await api(`/ops/v2/sube/${encodeURIComponent(sid)}/depo`);
        const stok = Array.isArray(depoRes?.stok) ? depoRes.stok : [];
        const alarmSayi = Number(depoRes?.alarm_sayisi ?? 0);
        setMagazaDepoCanliStok((prev) => ({ ...prev, [slug]: stok }));
        setMagazaDepoDepoMeta((prev) => ({
          ...prev,
          [slug]: {
            alarm_sayisi: Number.isFinite(alarmSayi) ? alarmSayi : 0,
            durum: 'ok',
          },
        }));
      } catch {
        setMagazaDepoCanliStok((prev) => {
          const rows = Array.isArray(prev?.[slug]) ? [...prev[slug]] : [];
          const i = rows.findIndex((r) => String(r?.kalem_kodu || '') === resolvedKk);
          const nextRow = i >= 0 ? { ...rows[i] } : { kalem_kodu: resolvedKk, kalem_adi: String(kalemAdi || kk) };
          nextRow.kalem_adi = String(kalemAdi || nextRow.kalem_adi || kk);
          nextRow.mevcut_adet = Math.max(0, Number(mevcutAdet || 0));
          nextRow.min_stok = Math.max(0, Number(minStok || 0));
          nextRow.alis_fiyati_tl = Math.max(0, Number(alisFiyatiTl || 0));
          if (i >= 0) rows[i] = nextRow;
          else rows.push(nextRow);
          return { ...prev, [slug]: rows };
        });
      }
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
      publishGlobalDataRefresh('depo-stok');
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
    if (aktifSekme === 'onay' || aktifSekme === 'siparis' || aktifSekme === 'siparis-kontrol' || aktifSekme === 'toptanci-siparisleri' || aktifSekme === 'urun-ac' || aktifSekme === 'acilis-takip' || aktifSekme === 'kullanilan-urunler' || aktifSekme === 'ciro-onay' || aktifSekme === 'acilis-kasa-takip' || aktifSekme === 'kasa-uyumsuzluk' || aktifSekme === 'personel-vardiya-uyumsuzluk' || aktifSekme === 'urun-uyumsuzluk' || aktifSekme === 'fire-bildirim' || aktifSekme === 'magaza-kartlari' || aktifSekme === 'metrics' || aktifSekme === 'kontrol') return;
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
    if (aktifSekme !== 'sube-notlar') return;
    setYukleniyor(true);
    api('/subeler')
      .then((subeler) => {
        if (Array.isArray(subeler)) {
          setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
        }
      })
      .catch(() => {});
    yukleSubeNotlar().finally(() => setYukleniyor(false));
  }, [aktifSekme, ayFiltre, subeOnayFiltre, yukleSubeNotlar]);

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
    // Stok tahmin sekmesinden gelen ön-seçili ürün ipucunu yakala
    try {
      const ham = sessionStorage.getItem('ops_siparis_on_urun');
      if (ham) {
        sessionStorage.removeItem('ops_siparis_on_urun');
        setToptanciOnUrun(JSON.parse(ham));
      }
    } catch (_) {}
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
    if ((toptanciSiparisListe?.gonderimler || []).length > 0 || (toptanciSiparisListe?.satirlar || []).length > 0) return;
    yukleToptanciSiparisleri();
  }, [opsMerkezPencere, toptanciSiparisListe?.gonderimler, toptanciSiparisListe?.satirlar, yukleToptanciSiparisleri]);

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
    if (aktifSekme !== 'acilis-takip') return;
    setAcilisTakipAlt('gec-acilis');
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
    if (aktifSekme === 'acilis-takip') return;
    setGecAcilanKartSekme('akis');
  }, [aktifSekme]);

  useEffect(() => {
    if (aktifSekme !== 'gec-acan-personel') return;
    if (gecKalanPersonelAramaSonuc?.satirlar?.length) return; // zaten yüklendi
    setYukleniyor(true);
    gecKalanPersonelAyYukle(varsayilanAy)
      .then((data) => {
        setGecKalanPersonelAy(data.year_month || varsayilanAy);
        setGecKalanPersonelAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Geç kalan personel yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, gecKalanPersonelAyYukle, varsayilanAy, gecKalanPersonelAramaSonuc?.satirlar?.length]);

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
    if (aktifSekme !== 'kullanilan-urunler') {
      if (kullanilanEvoPollRef.current) {
        clearInterval(kullanilanEvoPollRef.current);
        kullanilanEvoPollRef.current = null;
      }
      return;
    }
    if (kullanilanAramaSonuc?.evo_veri_geldi !== false) {
      if (kullanilanEvoPollRef.current) {
        clearInterval(kullanilanEvoPollRef.current);
        kullanilanEvoPollRef.current = null;
      }
      return;
    }
    const hedef = (kullanilanAramaTarih || bugunIsoTarih()).trim();
    const poll = async () => {
      try {
        const data = await kullanilanGunYukle(hedef, { evoYenile: true });
        setKullanilanAramaSonuc(data);
        if (hedef === bugunIsoTarih()) setKullanilanBugun(data);
      } catch {
        /* sessiz — bir sonraki turda tekrar dene */
      }
    };
    kullanilanEvoPollRef.current = setInterval(poll, 45_000);
    return () => {
      if (kullanilanEvoPollRef.current) {
        clearInterval(kullanilanEvoPollRef.current);
        kullanilanEvoPollRef.current = null;
      }
    };
  }, [aktifSekme, kullanilanAramaSonuc?.evo_veri_geldi, kullanilanAramaTarih, kullanilanGunYukle]);

  useEffect(() => {
    if (aktifSekme !== 'kapanis-takip') {
      if (kapanisTakipIntervalRef.current) {
        clearInterval(kapanisTakipIntervalRef.current);
        kapanisTakipIntervalRef.current = null;
      }
      return;
    }
    // Cache-first: ilk yüklemede hızlı cache + paralel live
    yukleKapanisTakip(kapanisTakipTarih, { cacheFirst: true });
    // Bugünkü görünümde 2 dakikada bir otomatik yenile
    if (kapanisTakipTarih === isGunuIsoIstanbul()) {
      kapanisTakipIntervalRef.current = setInterval(() => {
        if (document.hidden) return;  // arka plan sekmesinde boşa istek/yazma yapma
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
    if (aktifSekme !== 'acilis-kasa-takip') {
      if (acilisKasaTakipIntervalRef.current) {
        clearInterval(acilisKasaTakipIntervalRef.current);
        acilisKasaTakipIntervalRef.current = null;
      }
      return;
    }
    yukleAcilisKasaTakip(acilisKasaTakipTarih);
    if (acilisKasaTakipTarih === isGunuIsoIstanbul()) {
      acilisKasaTakipIntervalRef.current = setInterval(() => {
        if (document.hidden) return;  // arka plan sekmesinde boşa istek yapma
        yukleAcilisKasaTakip(acilisKasaTakipTarih, { silent: true });
      }, 120_000);
    }
    return () => {
      if (acilisKasaTakipIntervalRef.current) {
        clearInterval(acilisKasaTakipIntervalRef.current);
        acilisKasaTakipIntervalRef.current = null;
      }
    };
  }, [aktifSekme, yukleAcilisKasaTakip, acilisKasaTakipTarih]);

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
    kasaUyumGunYukle(bugunIsoTarih(), { durum: kasaUyumDurumFiltre })
      .then((data) => {
        setKasaUyumAramaTarih(data.tarih || bugunIsoTarih());
        setKasaUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Kasa uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, kasaUyumGunYukle, kasaUyumHaftaYukle, kasaUyumDurumFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'kasa-personel-takip') return;
    setYukleniyor(true);
    setKasaAcikAnalizYukleniyor(true);
    api('/ops/kasa-acik-analiz?gun_sayi=30')
      .then(setKasaAcikAnaliz)
      .catch((e) => toast(e.message || 'Personel kasa analizi yüklenemedi'))
      .finally(() => { setKasaAcikAnalizYukleniyor(false); setYukleniyor(false); });
    api('/ops/kasiyer-karne?gun=30')
      .then((d) => setKasiyerKarne(d.karne || []))
      .catch(() => setKasiyerKarne([]));
  }, [aktifSekme, toast]);

  useEffect(() => {
    if (!['food-cost-ozet', 'alis-fiyatlari', 'recete', 'shrinkage'].includes(aktifSekme)) return;
    setMaliyetYukleniyor(true);
    Promise.all([
      api(`/ops/maliyet/ozet?gun=${maliyetGun}`),
      api('/ops/maliyet/alis-fiyatlari'),
      api('/ops/maliyet/recete-listesi'),
    ])
      .then(([ozet, fiyatlar, rec]) => {
        setMaliyetOzet(ozet || null);
        setAlisFiyatlari(fiyatlar?.satirlar || []);
        setReceteler(rec?.receteler || []);
      })
      .catch((e) => toast(e.message || 'Maliyet verisi yüklenemedi'))
      .finally(() => setMaliyetYukleniyor(false));
  }, [aktifSekme, maliyetGun, toast]);

  useEffect(() => {
    if (aktifSekme !== 'stok-hareketi') return;
    setStokHareketYukleniyor(true);
    const q = new URLSearchParams({ gun: stokHareketGun, limit: 500 });
    if (stokHareketSubeFiltre) q.set('sube_id', stokHareketSubeFiltre);
    if (stokHareketTurFiltre) q.set('hareket_turu', stokHareketTurFiltre);
    api(`/ops/stok-hareketleri?${q}`)
      .then(setStokHareket)
      .catch((e) => toast(e.message || 'Stok hareketi yüklenemedi'))
      .finally(() => setStokHareketYukleniyor(false));
  }, [aktifSekme, stokHareketGun, stokHareketSubeFiltre, stokHareketTurFiltre, toast]);

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
    urunUyumHaftaYukle().catch(() => {});
    urunUyumGunYukle(bugunIsoTarih(), { durum: urunUyumDurumFiltre })
      .then((data) => {
        setUrunUyumBugun(data);
        setUrunUyumAramaTarih(data.tarih || bugunIsoTarih());
        setUrunUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Ürün uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, urunUyumGunYukle, urunUyumHaftaYukle, urunUyumDurumFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'fire-bildirim') return;
    setYukleniyor(true);
    fireHaftaYukle().catch(() => {});
    fireGunYukle(bugunIsoTarih(), { sebep: fireSebepFiltre })
      .then((data) => {
        setFireAramaTarih(data.tarih || bugunIsoTarih());
        setFireAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Fire bildirimleri yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, fireGunYukle, fireHaftaYukle, fireSebepFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'sevkiyat-uyumsuzluk') return;
    setYukleniyor(true);
    sevkiyatUyumDetayYukle()
      .catch((e) => toast(e.message || 'Sevkiyat uyumsuzlukları yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, sevkiyatUyumGun, sevkiyatUyumDetayYukle, toast]);

  // Sipariş & Tedarik modülü açıkken sevkiyat uyumsuzluk sayısını sürekli güncel tut
  // (kullanıcı diğer sekmelerdeyken de tab pill üzerinde rozet görsün)
  useEffect(() => {
    if (aktifModul !== 'siparis-tedarik') return;
    yukleSevkiyatUyumOzet({ silent: true }).catch(() => {});
  }, [aktifModul, aktifSekme, yukleSevkiyatUyumOzet]);

  useEffect(() => {
    if (aktifSekme !== 'magaza-kartlari') return;
    magazaDepoTamYenile();
  }, [aktifSekme, filtre, magazaDepoTamYenile]);

  // Şube Depoları sekmesi açıkken canlı depoyu otomatik tazele —
  // şube panelinden kabul/teslim yapılınca admin sayfayı yenilemeden görür.
  // Sekme görünür değilken (başka tab) boşa istek atmamak için durdurulur.
  useEffect(() => {
    if (aktifSekme !== 'magaza-kartlari') return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      magazaDepoTamYenile({ silent: true });
    }, 20000);
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        magazaDepoTamYenile({ silent: true });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [aktifSekme, magazaDepoTamYenile]);

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
      } else if (aktifSekme === 'acilis-takip') {
        setYukleniyor(true);
        if (acilisTakipAlt === 'gec-acilis') {
          setGecAcilanHaftaYukleniyor(true);
          gecAcilanHaftaYukle()
            .then(setGecAcilanHaftaSatirlari)
            .catch(() => {})
            .finally(() => setGecAcilanHaftaYukleniyor(false));
          gecAcilanAramaYap().finally(() => setYukleniyor(false));
        } else {
          gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
        }
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
      } else if (aktifSekme === 'fire-bildirim') {
        setYukleniyor(true);
        fireAramaYap().finally(() => setYukleniyor(false));
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
  }, [aktifSekme, acilisTakipAlt, filtre, hubOzetIsle, yukle, yukleOnayMerkez, urunAcAramaYap, urunAcHaftaYukle, gecAcilanAramaYap, gecAcilanHaftaYukle, gecKalanPersonelAramaYap, kullanilanAramaYap, kullanilanHaftaYukle, ciroOnayAramaYap, kasaUyumAramaYap, kasaUyumHaftaYukle, personelVardiyaUyumAramaYap, personelVardiyaUyumHaftaYukle, urunUyumAramaYap, fireAramaYap, yukleSevkiyatUyumOzet, sevkiyatUyumDetayYukle, yukleSiparisMerkez, yukleSiparisKabulTakip, yukleToptanciSiparisleri, toptanciSiparisDonem, toptanciSiparisTarih, toptanciSiparisSirala, yukleToptanciTeslimler, magazaDepoTamYenile, yukleMetrics, yukleKontrolOzet, yukleFisBekleyen, yukleDisiplin]);


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
  const haftaTrendSubeMap = useMemo(() => {
    const liste = Array.isArray(haftalikKarsilastirma) ? haftalikKarsilastirma : (haftalikKarsilastirma?.subeler || []);
    const m = {};
    (liste || []).forEach((s) => { if (s?.sube_id != null) m[String(s.sube_id)] = s; });
    return m;
  }, [haftalikKarsilastirma]);
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
  const urunUyumSubeSekmeleri = urunUyumSubeSekmeleriOlustur(urunUyumAramaSonuc?.kayitlar);
  const urunUyumGorunenKayitlar = urunUyumSeciliSubeKey === 'all'
    ? (urunUyumAramaSonuc?.kayitlar || [])
    : (urunUyumAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === urunUyumSeciliSubeKey;
    });
  const fireSubeSekmeleriRaw = urunUyumSubeSekmeleriOlustur(
    (fireAramaSonuc?.kayitlar || []).map((r) => ({ sube_adi: r.sube_ad, sube_id: r.sube_id })),
  );
  const fireSubeSekmeleri = [
    { key: 'all', label: 'Tümü', adet: (fireAramaSonuc?.kayitlar || []).length },
    ...fireSubeSekmeleriRaw.map((s) => ({ key: s.key, label: s.baslik, adet: s.adet })),
  ];
  const fireGorunenKayitlar = fireSeciliSubeKey === 'all'
    ? (fireAramaSonuc?.kayitlar || [])
    : (fireAramaSonuc?.kayitlar || []).filter((r) => {
      const label = String(r?.sube_ad || r?.sube_id || 'Diğer').trim() || 'Diğer';
      return (urunAcSubeAnahtar(label) || label) === fireSeciliSubeKey;
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
        yukleSevkiyatUyumOzet({ silent: true }).catch(() => {});
        fireGunYukle(bugunIsoTarih(), { sebep: '' })
          .then((d) => setFireBugun({ gun_toplam: Number(d?.gun_toplam || (d?.kayitlar || []).length || 0), kayitlar: d?.kayitlar || [] }))
          .catch(() => {});
      }
    };
    loadOzet();
    const id = setInterval(() => { if (!document.hidden) loadOzet(); }, 25000);
    const onVis = () => {
      if (document.visibilityState === 'visible') loadOzet();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [hubOzetIsle, opsMerkezPencere, yukleUrunAcBugun, yukleGecAcilanBugun, yukleGecKalanPersonelBugun, yukleKullanilanBugun, yukleCiroOnayBugun, yukleKasaUyumBugun, yuklePersonelVardiyaUyumBugun, yukleUrunUyumBugun, yukleSevkiyatUyumBugun, yukleSevkiyatUyumOzet, fireGunYukle]);

  const acOpsModul = useCallback((id, modulId) => {
    const bolumler = OPS_MODUL_BOLUM[id] || [{ id: 'icerik', label: 'İçerik' }];
    setAktifSekme(id);
    setOpsIcBolum(bolumler[0].id);
    if (modulId !== undefined) setAktifModul(modulId);
    setOpsMerkezPencere(true);
    setYukleniyor(id !== 'siparis-kontrol');
  }, []);

  useEffect(() => {
    try {
      const sek = sessionStorage.getItem('ops_merkez_ac_sekme');
      if (!sek) return;
      sessionStorage.removeItem('ops_merkez_ac_sekme');
      const modul = MODULLER.find((m) => m.tabs.includes(sek));
      acOpsModul(sek, modul?.id);
    } catch (_) {}
  }, [acOpsModul]);

  /** Modül içinde sekme değişimi — yukleniyor tetikler, veri useEffect ile yüklenir */
  const acModulTab = useCallback((tabId) => {
    const bolumler = OPS_MODUL_BOLUM[tabId] || [{ id: 'icerik', label: 'İçerik' }];
    const modul = MODULLER.find((m) => m.tabs.includes(tabId));
    if (modul) setAktifModul(modul.id);
    setOncekiSekme((prev) => (prev !== tabId ? (aktifSekme || prev) : prev));
    setAktifSekme(tabId);
    setOpsIcBolum(bolumler[0].id);
    setYukleniyor(true);
  }, [aktifSekme]);

  /** Hub alarm kartından ilgili modüle git (stok disiplin alt panel dahil) */
  const alarmHedefeGit = useCallback((a) => {
    const m = a?.meta || {};
    let sek = m.hedef_sekme;
    if (!sek) return;
    if (sek === 'siparis' || sek === 'stok-disiplin' || sek === 'siparis-gecmis' || sek === 'siparis-kabul-takip' || sek === 'sevkiyat-uyumsuzluk') {
      sek = 'siparis-kontrol';
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
    setHubAlarmAcikId(null);
  }, []);

  useEffect(() => {
    if (aktifSekme !== 'siparis-kontrol' || !opsMerkezPencere) return;
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
  }, [aktifSekme, opsMerkezPencere]);

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

  async function kasaUyumsuzlukCoz(uid, orijinalFark) {
    // Önce düzeltme tutarını sor (boş bırakılırsa orijinal fark geçerli kalır)
    const orijinalStr = (orijinalFark != null && Number.isFinite(Number(orijinalFark)))
      ? Number(orijinalFark).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
    const duzStr = window.prompt(
      `Düzeltilen fark tutarı (₺) — opsiyonel\n\n` +
      `Orijinal fark: ${orijinalStr} ₺\n\n` +
      `• Boş bırak: orijinal tutar geçerli kalır\n` +
      `• Yeni tutar gir: bundan sonraki hesaplar bu tutarla devam eder\n` +
      `• Negatif yazılabilir (örn. -25.50)`,
      ''
    );
    if (duzStr === null) return; // İptal
    let duzeltilen = null;
    const trim = String(duzStr).trim().replace(',', '.');
    if (trim !== '') {
      const n = Number(trim);
      if (!Number.isFinite(n)) {
        toast('Geçerli bir sayı girin (örn. -25.50 veya 100)', 'yellow');
        return;
      }
      duzeltilen = n;
    }
    const neden = window.prompt('Çözüm notu (opsiyonel):') ?? '';
    setOnayBusyId(`ku:${uid}`);
    try {
      await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uid)}/coz`, {
        method: 'POST',
        body: {
          notu: (neden || '').trim(),
          duzeltilen_fark_tl: duzeltilen,
        },
      });
      toast(
        duzeltilen != null
          ? `Çözüldü — düzeltilmiş tutar: ${Number(duzeltilen).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`
          : 'Çözüldü — orijinal tutar (değişmedi) geçerli',
        'green'
      );
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-cozuldu');
      const hedefKu = (kasaUyumAramaTarih || bugunIsoTarih()).trim();
      const [haftaData, gunData] = await Promise.all([
        kasaUyumHaftaYukle().catch(() => []),
        kasaUyumGunYukle(hedefKu, { durum: kasaUyumDurumFiltre }).catch(() => null),
      ]);
      setKasaUyumHaftaSatirlari(haftaData);
      if (gunData) setKasaUyumAramaSonuc(gunData);
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Kayıt çözülemedi');
    } finally {
      setOnayBusyId(null);
    }
  }

  // Kasa farkını canlı veriyle yeniden hesapla (kaynağı değiştirmez — bayat dökümü tazeler)
  async function kkYenidenHesapla(uid) {
    setOnayBusyId(`kuyh:${uid}`);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uid)}/yeniden-hesapla`, { method: 'POST' });
      const yeni = Number(r?.yeni_fark ?? 0);
      toast(
        r?.otomatik_cozuldu
          ? '🔄 Yeniden hesaplandı — fark eşik altına düştü, çözüldü.'
          : `🔄 Yeniden hesaplandı — güncel fark: ${yeni.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`,
        'green'
      );
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-yeniden-hesap');
      const hedefKu = (kasaUyumAramaTarih || bugunIsoTarih()).trim();
      const [haftaData, gunData] = await Promise.all([
        kasaUyumHaftaYukle().catch(() => []),
        kasaUyumGunYukle(hedefKu, { durum: kasaUyumDurumFiltre }).catch(() => null),
      ]);
      setKasaUyumHaftaSatirlari(haftaData);
      if (gunData) setKasaUyumAramaSonuc(gunData);
    } catch (e) {
      toast(e.message || 'Yeniden hesaplanamadı');
    } finally {
      setOnayBusyId(null);
    }
  }

  // Kasa farkı kaynak düzeltme — modal açar
  function kkDuzeltModalAc(uyari) {
    const tip = String(uyari?.tip || '');
    const varsayilanSebep = tip === 'ACILIS_KASA_FARK' ? 'acilis_yanlis' : 'ciro_yanlis';
    setKkDuzeltModal({
      uyari,
      sebep: varsayilanSebep,
      payload: {},
    });
  }

  function kkDuzeltPayloadDogrula(sebep, payload, uyariTip) {
    const p = payload || {};
    if (sebep === 'ciro_yanlis') {
      if (uyariTip === 'ACILIS_KASA_FARK') {
        return 'Devir uyumsuzluğu için ciro düzeltmesi uygun değil.';
      }
      if (p.yeni_nakit == null && p.yeni_pos == null && p.yeni_online == null) {
        return 'En az bir ciro alanı girin (nakit, POS veya online).';
      }
    }
    if (sebep === 'acilis_yanlis') {
      // Boş input → 0 değil, undefined olmalı; ayrıca >= 0 koşulu
      if (p.yeni_acilis_kasa == null || !Number.isFinite(Number(p.yeni_acilis_kasa)) || Number(p.yeni_acilis_kasa) < 0) {
        return 'Yeni açılış kasa sayımı (₺) zorunlu — 0 veya pozitif sayı girin.';
      }
    }
    if (sebep === 'devir_yanlis') {
      if (p.yeni_teslim == null && p.yeni_devir == null) {
        return 'Teslim veya devir alanından en az birini girin.';
      }
    }
    if (sebep === 'gider_eksik') {
      if (uyariTip === 'ACILIS_KASA_FARK') {
        return 'Devir uyumsuzluğu için gider eklenemez.';
      }
      if (p.tutar == null || !Number.isFinite(Number(p.tutar)) || Number(p.tutar) <= 0) {
        return 'Gider tutarı 0\'dan büyük olmalı.';
      }
    }
    if (sebep === 'ciro_fazla') {
      if (uyariTip === 'ACILIS_KASA_FARK') {
        return 'Devir uyumsuzluğu için ciro fazla eklenemez.';
      }
      if (p.tutar == null || !Number.isFinite(Number(p.tutar)) || Number(p.tutar) <= 0) {
        return 'Ciroya eklenecek tutar 0\'dan büyük olmalı.';
      }
    }
    // 'gercek_acik' validate gerek yok — sadece bilgilendirme, kaynak değişmez
    return null;
  }

  async function kkDuzeltGonder() {
    if (!kkDuzeltModal) return;
    const { uyari, sebep, payload } = kkDuzeltModal;
    const uyariTip = String(uyari?.tip || '');
    const hata = kkDuzeltPayloadDogrula(sebep, payload, uyariTip);
    if (hata) {
      toast(hata, 'red');
      return;
    }
    if (!uyari?.id) {
      toast('Uyarı kaydı bulunamadı — listeyi yenileyin', 'red');
      return;
    }
    const { _notu, ...apiPayload } = payload || {};
    // #2 Yetki: mali kayıt değiştirilecek → işletme (Merve Karabacak) PIN onayı
    const onayPin = (window.prompt('İşletme onayı — Merve Karabacak PIN (4 hane):') || '').trim();
    if (!onayPin) { toast('İşletme onayı iptal edildi', 'red'); return; }
    setKkDuzeltBusy(true);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uyari.id)}/kaynak-duzelt`, {
        method: 'POST',
        body: {
          sebep,
          payload: apiPayload,
          notu: (_notu || '').trim() || null,
          onay_pin: onayPin,
        },
      });
      const eski = Number(r?.eski_fark || 0);
      const yeni = Number(r?.yeni_fark || 0);
      const fmt = (n) => n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const onayDurum = r?.onay_durumu_yeni
        ? ` · Onay kuyruğu: ${r.onay_durumu_yeni}`
        : '';
      // Cascade bilgisi — diğer günleri etkilediyse kullanıcıya bildir
      const cascade = Array.isArray(r?.cascade) ? r.cascade : [];
      let cascadeMsg = '';
      if (cascade.length > 0) {
        const cozulen = cascade.filter(c => c?.otomatik_cozuldu).length;
        const acik = cascade.length - cozulen;
        const parts = [];
        if (cozulen > 0) parts.push(`${cozulen} cascade çözüldü`);
        if (acik > 0) parts.push(`${acik} cascade hala açık`);
        cascadeMsg = ` · 🔗 Bağlı uyarılar: ${parts.join(', ')}`;
      }
      toast(
        r?.otomatik_cozuldu
          ? `✅ Düzeltildi, fark sıfırlandı (eski ${fmt(eski)}₺ → 0₺)${onayDurum}${cascadeMsg}`
          : `🔧 Düzeltildi: ${fmt(eski)}₺ → ${fmt(yeni)}₺${onayDurum}${cascadeMsg}`,
        'green'
      );
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-cozuldu');
      const hedefKu = (kasaUyumAramaTarih || bugunIsoTarih()).trim();
      const [haftaData, gunData] = await Promise.all([
        kasaUyumHaftaYukle().catch(() => []),
        kasaUyumGunYukle(hedefKu, { durum: kasaUyumDurumFiltre }).catch(() => null),
      ]);
      setKasaUyumHaftaSatirlari(haftaData);
      if (gunData) setKasaUyumAramaSonuc(gunData);
      await yukleOnayMerkez();
      setKkDuzeltModal(null);
    } catch (e) {
      toast(e.message || 'Düzeltme başarısız', 'red');
    } finally {
      setKkDuzeltBusy(false);
    }
  }

  // ─── Tarihçe modal: audit listesi + geri al ───────────────────────────
  async function kkTarihceModalAc(uyari) {
    if (!uyari?.id) return;
    setKkTarihceModal({ uyari, tarihce: [], yukleniyor: true, geriAlBusyId: null, hata: null });
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uyari.id)}/duzeltme-tarihce`);
      setKkTarihceModal({
        uyari,
        tarihce: Array.isArray(r?.tarihce) ? r.tarihce : [],
        yukleniyor: false,
        geriAlBusyId: null,
        hata: null,
      });
    } catch (e) {
      // Modal'ı KAPATMA — hata içeride göster, kullanıcı tekrar deneyebilsin
      setKkTarihceModal((prev) => prev ? {
        ...prev,
        yukleniyor: false,
        hata: e.message || 'Tarihçe yüklenemedi',
      } : prev);
    }
  }

  async function kkTarihceGeriAl(auditKayit) {
    if (!auditKayit?.id) return;
    if (auditKayit.geri_alindi_mi) {
      toast('Bu düzeltme zaten geri alınmış', 'yellow');
      return;
    }
    const eskiFark = Number(auditKayit.eski_fark_tl || 0);
    const yeniFark = Number(auditKayit.yeni_fark_tl || 0);
    const fmt = (n) => n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const onayMsg = `Bu düzeltmeyi geri almak istediğinden emin misin?\n\n` +
      `Sebep: ${auditKayit.sebep}\n` +
      `Fark: ${fmt(eskiFark)}₺ → ${fmt(yeniFark)}₺ (geri alınca: ${fmt(eskiFark)}₺)\n` +
      `Hedef: ${auditKayit.hedef_tablo || '(kaynak değişmedi)'}\n\n` +
      `İşlem: ilgili tabloda eski değerler RESTORE edilir, fark yeniden hesaplanır.`;
    if (!window.confirm(onayMsg)) return;
    const notu = window.prompt('Geri alma sebebi (opsiyonel):') ?? '';
    // #2 Yetki: geri alma mali kaydı geri yazar → işletme (Merve) PIN onayı
    const onayPin = (window.prompt('İşletme onayı — Merve Karabacak PIN (4 hane):') || '').trim();
    if (!onayPin) { toast('İşletme onayı iptal edildi', 'red'); return; }

    setKkTarihceModal((prev) => prev ? { ...prev, geriAlBusyId: auditKayit.id } : prev);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/duzeltme/${encodeURIComponent(auditKayit.id)}/geri-al`, {
        method: 'POST',
        body: { notu: notu.trim() || null, onay_pin: onayPin },
      });
      const yfFmt = fmt(Number(r?.yeni_fark || 0));
      toast(
        r?.otomatik_cozuldu
          ? `↶ Geri alındı, fark sıfırlandı (yeni: 0₺) · ${r?.restore || ''}`
          : `↶ Geri alındı, yeni fark: ${yfFmt}₺ · ${r?.restore || ''}`,
        'green'
      );
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-geri-alindi');
      // Tarihçeyi yenile
      const tarihce = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(kkTarihceModal?.uyari?.id)}/duzeltme-tarihce`);
      setKkTarihceModal((prev) => prev ? {
        ...prev,
        tarihce: Array.isArray(tarihce?.tarihce) ? tarihce.tarihce : [],
        geriAlBusyId: null,
      } : prev);
      // Hafta + gün verisini de yenile
      const hedefKu = (kasaUyumAramaTarih || bugunIsoTarih()).trim();
      const [haftaData, gunData] = await Promise.all([
        kasaUyumHaftaYukle().catch(() => []),
        kasaUyumGunYukle(hedefKu, { durum: kasaUyumDurumFiltre }).catch(() => null),
      ]);
      setKasaUyumHaftaSatirlari(haftaData);
      if (gunData) setKasaUyumAramaSonuc(gunData);
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Geri alma başarısız', 'red');
      setKkTarihceModal((prev) => prev ? { ...prev, geriAlBusyId: null } : prev);
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
      {msg && (
        <div
          className={`alert-box ${msg.t}`}
          style={{
            position: 'fixed',
            top: 20,
            right: 20,
            zIndex: 99999,
            maxWidth: 480,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            cursor: 'pointer',
          }}
          onClick={() => setMsg(null)}
          role="alert"
        >
          {msg.m}
        </div>
      )}
      <div className="page-header flex items-center justify-between">
        <div>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {(() => {
          // Birleşik bildirim çanı — mevcut sayı state'lerinden besle
          const canKasa = Number(kasaUyumBugun?.toplam || 0);
          const canUrun = Number(urunUyumBugun?.toplam || 0);
          const canBildirim = kritikSayi + guvenlikSayi + canKasa + canUrun;
          if (canBildirim <= 0) return null;
          // Alert drawer yalnızca hub/canlı görünümde render edilir; o görünüme götür + drawer aç.
          const drawerAcilabilir = aktifSekme === 'canli';
          return (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              title={`${kritikSayi} kritik · ${guvenlikSayi} güvenlik · ${canKasa} kasa uyumsuzluk · ${canUrun} ürün uyumsuzluk${drawerAcilabilir ? '' : ' — canlı panele dön'}`}
              style={{ position: 'relative', fontSize: 16, padding: '4px 10px' }}
              onClick={() => {
                if (drawerAcilabilir) {
                  setAlertDrawerAcik(true);
                } else {
                  acModulTab('canli');
                  setTimeout(() => setAlertDrawerAcik(true), 0);
                }
              }}
            >
              🔔
              <span style={{
                position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18,
                borderRadius: 9, background: 'var(--red)', color: '#fff',
                fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 4px',
              }}>{canBildirim > 99 ? '99+' : canBildirim}</span>
            </button>
          );
        })()}
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
            else if (aktifSekme === 'acilis-takip') {
              if (acilisTakipAlt === 'gec-acilis') {
                setGecAcilanHaftaYukleniyor(true);
                gecAcilanHaftaYukle()
                  .then(setGecAcilanHaftaSatirlari)
                  .catch(() => {})
                  .finally(() => setGecAcilanHaftaYukleniyor(false));
                gecAcilanAramaYap().finally(() => setYukleniyor(false));
              } else {
                gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
              }
            }
            else if (aktifSekme === 'kullanilan-urunler') {
              setKullanilanHaftaYukleniyor(true);
              kullanilanHaftaYukle()
                .then(setKullanilanHaftaSatirlari)
                .catch(() => {})
                .finally(() => setKullanilanHaftaYukleniyor(false));
              kullanilanAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'acilis-kasa-takip') {
              yukleAcilisKasaTakip(acilisKasaTakipTarih).finally(() => setYukleniyor(false));
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
            else if (aktifSekme === 'fire-bildirim') {
              fireAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'magaza-kartlari') magazaDepoTamYenile();
            else if (aktifSekme === 'metrics') yukleMetrics();
            else if (aktifSekme === 'kontrol') yukleKontrolOzet();
            else if (aktifSekme === 'fis') yukleFisBekleyen();
            else if (aktifSekme === 'siparis-kontrol') { /* SiparisKontrolKulesi kendi yükler */ }
            else yukle(filtre);
          }}
        >
          ↻ Yenile
        </button>
        </div>
      </div>

      {!opsMerkezPencere && (
        <>
          {hubGelenSiparisGoster && (
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
                        {Number(opsOzet?.siparis_bekleyen) || hubGelenSiparisAlarmlari.length}{' '}
                        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text2)' }}>bekleyen talep</span>
                      </div>
                      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                        Yalnızca şube katalog siparişleri; depo, fiş veya vardiya uyarıları bu alanda gösterilmez.
                      </p>
                      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                        Son <strong>{siparisBekleyenGunPenceresi} gün</strong> · işlem için <strong>Sipariş kontrol kulesi</strong>.
                      </p>
                      {(Number(opsOzet?.siparis_ozel_bekleyen) || 0) > 0 && (
                        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#facc15', lineHeight: 1.45 }}>
                          Ayrica <strong>{Number(opsOzet?.siparis_ozel_bekleyen) || 0} ozel urun talebi</strong> Siparis katalog ekraninda karar bekliyor.
                        </p>
                      )}
                      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text3)', lineHeight: 1.45 }}>
                        {hubOperasyonDetayAcik ? '▼ Talep satırlarını gizlemek için tekrar tıklayın.' : '▶ Talep detayları için tıklayın.'}
                      </p>
                  </>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', flexShrink: 0 }}>
                  {(opsOzet?.siparis_bekleyen || 0) > 0 && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        acOpsModul('siparis-kontrol');
                      }}
                    >
                      Sipariş kontrol kulesi →
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

              {hubOperasyonDetayAcik && hubGelenSiparisAlarmlari.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {hubGelenSiparisAlarmlari.map((a) => {
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

              {hubOperasyonDetayAcik && hubGelenSiparisAlarmlari.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--text3)', margin: '8px 0 0' }}>
                  Bekleyen talep satırı yüklenemedi; «Özet yenile» ile tekrar deneyin.
                </p>
              )}
            </section>
          )}

        {/* Operasyon Merkezi ana sayfa — modül kartları üst freshness barı */}
        {!opsMerkezPencere && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>
              Modül kartları canlı veri · alt sayfalar açıldığında cache devreye girer
            </span>
            <CacheFreshnessBadge
              guncelleme={sonYenileme}
              kaynak="live"
              kompakt
            />
          </div>
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
              alertSayisi = Number(ozt.stok_kayip_sube || 0) + Number(ozt.stok_alarm_bekleyen || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} kayıp/uyarı — envanter kontrol gerekli` : 'Envanter normal · kayıp tespit edilmedi ✓';
            } else if (modul.id === 'siparis-tedarik') {
              alertSayisi = Number(ozt.siparis_gonderilmedi_toplam || 0) + Number(sevkiyatUyumOzet?.adet || 0) + Number(ozt.siparis_bekleyen || 0);
              descSatir = alertSayisi > 0 ? `${alertSayisi} bekleyen/uyumsuz sipariş` : 'Tüm siparişler takipte ✓';
            } else if (modul.id === 'finans-kasa') {
              alertSayisi = Number(kasaUyumBugun?.toplam || 0) + Number(urunUyumBugun?.toplam || 0) + Number(ciroOnayBugun?.toplam || 0) + Number(ozt.fis_bekleyen || 0);
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
                  if (firstTab === 'acilis-takip') {
                    setGecAcilanAramaTarih(bugunIsoTarih());
                    setGecAcilanAramaSonuc(gecAcilanBugun);
                  } else if (firstTab === 'kasa-uyumsuzluk') {
                    setKasaUyumAramaTarih(bugunIsoTarih());
                    setKasaUyumAramaSonuc(kasaUyumBugun);
                  } else if (firstTab === 'urun-uyumsuzluk') {
                    setUrunUyumAramaTarih(bugunIsoTarih());
                    setUrunUyumAramaSonuc(urunUyumBugun);
                  } else if (firstTab === 'ciro-onay') {
                    setCiroOnayAramaTarih(isGunuIsoIstanbul());
                    setCiroOnayAramaSonuc(ciroOnayBugun);
                  } else if (firstTab === 'kullanilan-urunler') {
                    setKullanilanAramaTarih(bugunIsoTarih());
                    setKullanilanAramaSonuc(kullanilanBugun);
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
              <h3 style={{ margin: 0, fontSize: 17, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {UST_SEKMELER.find((x) => x.id === aktifSekme)?.label || aktifSekme}
                {aktifSekme === 'sevkiyat-uyumsuzluk' && Number(sevkiyatUyumOzet?.adet || 0) > 0 && (
                  <span style={{
                    background: '#ea580c', color: '#fff',
                    padding: '2px 10px', borderRadius: 999,
                    fontSize: 13, fontWeight: 700, lineHeight: 1.4,
                  }}>
                    {Number(sevkiyatUyumOzet.adet)} uyumsuzluk
                  </span>
                )}
                {/* Global cache freshness rozeti — aktif sekmenin son güncelleme zamanı */}
                {sekmeSonGuncelleme[aktifSekme] && (
                  <CacheFreshnessBadge
                    guncelleme={sekmeSonGuncelleme[aktifSekme]}
                    kaynak={aktifSekme === 'kapanis-takip' ? kapanisTakipKaynak : aktifSekme === 'acilis-kasa-takip' ? 'live' : 'live'}
                    kompakt
                  />
                )}
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
                  else if (aktifSekme === 'acilis-takip') {
                    if (acilisTakipAlt === 'gec-acilis') {
                      setGecAcilanHaftaYukleniyor(true);
                      gecAcilanHaftaYukle()
                        .then(setGecAcilanHaftaSatirlari)
                        .catch(() => {})
                        .finally(() => setGecAcilanHaftaYukleniyor(false));
                      gecAcilanAramaYap().finally(() => setYukleniyor(false));
                    } else {
                      gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
                    }
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
                  else if (aktifSekme === 'acilis-kasa-takip') {
                    yukleAcilisKasaTakip(acilisKasaTakipTarih).finally(() => setYukleniyor(false));
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
                  else if (aktifSekme === 'fire-bildirim') {
                    fireAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'sevkiyat-uyumsuzluk') {
                    yukleSevkiyatUyumOzet({ silent: true }).catch(() => {});
                    sevkiyatUyumDetayYukle().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'magaza-kartlari') magazaDepoTamYenile();
                  else if (aktifSekme === 'metrics') yukleMetrics();
                  else if (aktifSekme === 'kontrol') yukleKontrolOzet();
                  else if (aktifSekme === 'fis') yukleFisBekleyen();
                  else if (aktifSekme === 'siparis-kontrol') { /* SiparisKontrolKulesi kendi yükler */ }
                  else yukle(filtre);
                }}
              >
                ↻ Yenile
              </button>
              {oncekiSekme && oncekiSekme !== aktifSekme && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => acModulTab(oncekiSekme)}
                  title={`Geri: ${UST_SEKMELER.find((x) => x.id === oncekiSekme)?.label || oncekiSekme}`}
                >
                  ← Geri
                </button>
              )}
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
                  let tabBekleyen = 0;
                  let tabBekleyenRenk = '#d946b8';
                  if (tabId === 'ciro-onay') {
                    tabBekleyen = Number(ciroOnayBugun?.toplam || 0);
                  } else if (tabId === 'kasa-uyumsuzluk') {
                    tabBekleyen = Number(kasaUyumBugun?.toplam || 0);
                    tabBekleyenRenk = '#e85d5d';
                  } else if (tabId === 'urun-uyumsuzluk') {
                    tabBekleyen = Number(urunUyumBugun?.toplam || 0);
                    tabBekleyenRenk = '#8b5cf6';
                  } else if (tabId === 'sevkiyat-uyumsuzluk') {
                    tabBekleyen = Number(sevkiyatUyumOzet?.adet || 0);
                    tabBekleyenRenk = '#ea580c';
                  }
                  return sekme ? (
                    <button
                      key={tabId}
                      type="button"
                      className={`tab-pill ${aktifSekme === tabId ? 'active' : ''}`}
                      style={{ whiteSpace: 'nowrap', fontSize: 12, position: 'relative', paddingRight: tabBekleyen > 0 ? 30 : undefined }}
                      onClick={() => acModulTab(tabId)}
                    >
                      {sekme.label}
                      {tabBekleyen > 0 && (
                        <span style={{
                          position: 'absolute', top: -6, right: -6,
                          minWidth: 18, height: 18, padding: '0 5px',
                          borderRadius: 999, background: tabBekleyenRenk, color: '#fff',
                          fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                        }}>
                          {tabBekleyen}
                        </span>
                      )}
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
        const subeAcikSayi = kartlar.filter(k => k.sube_acik).length;
        const ciroGiren = kartlar.filter(k => k.ciro_girildi).length;
        const ciroOnayda = kartlar.filter(k => !k.ciro_girildi && k.ciro_taslak_bekliyor).length;
        const ciroYok = kartlar.length - ciroGiren - ciroOnayda;
        const hepsiGirdi = ciroGiren === kartlar.length && kartlar.length > 0;
        const devirFarkSayi = kasaUyumBugun?.toplam || 0;
        const devirFarkMaxAbs = Math.max(0, ...((kasaUyumBugun?.kayitlar || []).map(u => Math.abs(Number(u?.fark_tl || 0)))));
        // 3 stok sinyali — hepsi aynı kaynaktan (urunUyumBugun.kayitlar), şube bazında ayrı pill
        const _stokKayit = (urunUyumBugun?.kayitlar || []).filter(u => !u.cozuldu);
        const urunDevirSube = new Set(_stokKayit.filter(u => u.tip === 'STOK_BAR_DEVIR_FARK').map(u => u.sube_id)).size;
        const kayitsizSube = new Set(_stokKayit.filter(u => u.tip === 'STOK_BAR_GUN_ICI_FARK').map(u => u.sube_id)).size;
        const karsiliksizSube = new Set(_stokKayit.filter(u => u.tip === 'URUN_AC_UYUMSUZLUK').map(u => u.sube_id)).size;
        // Sevkiyat / Personel vardiya / Fire — kart detayında vardı, artık üst rozet
        const sevkiyatUyumSayi = Number(sevkiyatUyumOzet?.adet || 0);
        const personelVardiyaSayi = Number(personelVardiyaUyumBugun?.toplam || 0);
        const fireSayi = Number(fireBugun?.gun_toplam || 0);
        const toplamUyari = kritikSayi + gecikSayi + gecAlert + kapanmayanSayi + guvenlikSayi + devirFarkSayi;
        const uyariParcalar = [
          gecAlert > 0 && `${gecAlert} geç açılış`,
          kapanmayanSayi > 0 && `${kapanmayanSayi} kapanmayan`,
          guvenlikSayi > 0 && `${guvenlikSayi} güvenlik`,
          kritikSayi > 0 && `${kritikSayi} kritik`,
          gecikSayi > 0 && `${gecikSayi} geciken`,
        ].filter(Boolean);
        return (
          <>
            {/* 6 canlı alert pill'i */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {/* Aktif Şube */}
              <div
                className="tab-pill"
                style={{ borderColor: subeAcikSayi === kartlar.length && kartlar.length > 0 ? 'var(--green)' : '#4a9eff', color: '#4a9eff', cursor: 'default' }}
                title="Şu an açık / toplam şube"
              >
                🏢 Aktif Şube&nbsp;
                <span style={{ fontWeight: 800 }}>{subeAcikSayi}/{kartlar.length || '—'}</span>
              </div>
              {/* Geç / Açılmayan */}
              <button
                type="button"
                className="tab-pill"
                style={{ borderColor: gecAlert > 0 ? 'var(--red)' : undefined, color: gecAlert > 0 ? 'var(--red)' : undefined }}
                onClick={() => acModulTab('acilis-takip')}
                title={`${Number(gecAcilanBugun?.toplam || 0)} geç · ${Number(gecAcilanBugun?.acilmayan_toplam || 0)} açılmadı`}
              >
                ⏰ Geç/Açılmayan&nbsp;
                <span style={{ fontWeight: 800 }}>{gecAlert}</span>
              </button>
              {/* Kapanmayan */}
              <button
                type="button"
                className="tab-pill"
                style={{ borderColor: kapanmayanSayi > 0 ? '#f08040' : undefined, color: kapanmayanSayi > 0 ? '#f08040' : undefined }}
                onClick={() => acOpsModul('kapanis-takip', 'finans-kasa')}
                title="Kapanış tamamlanmayan şubeler"
              >
                🔒 Kapanmayan&nbsp;
                <span style={{ fontWeight: 800 }}>{kapanmayanSayi}</span>
              </button>
              {/* Güvenlik */}
              <button
                type="button"
                className="tab-pill"
                style={{ borderColor: guvenlikSayi > 0 ? '#be185d' : undefined, color: guvenlikSayi > 0 ? '#be185d' : undefined }}
                onClick={() => acOpsModul('guvenlik-alarmlar', 'denetim-uyum')}
                title="Aktif PIN / kilit alarmı"
              >
                🔐 Güvenlik&nbsp;
                <span style={{ fontWeight: 800 }}>{guvenlikSayi}</span>
              </button>
              {/* Ciro Girişi */}
              <button
                type="button"
                className="tab-pill"
                style={{ borderColor: ciroYok > 0 ? 'var(--red)' : hepsiGirdi ? 'var(--green)' : 'var(--yellow)', color: hepsiGirdi ? 'var(--green)' : ciroYok > 0 ? 'var(--red)' : 'var(--yellow)' }}
                onClick={() => kartlar.length > 0 && acOpsModul('ciro-onay', 'finans-kasa')}
                title={hepsiGirdi ? 'Tüm ciro girildi' : `${ciroOnayda} onayda · ${ciroYok} girilmedi`}
              >
                📋 Ciro&nbsp;
                <span style={{ fontWeight: 800 }}>{ciroGiren}/{kartlar.length}</span>
              </button>
              {/* 💰 Devir Farkı */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: devirFarkSayi === 0 ? 'var(--green)' : devirFarkMaxAbs >= 200 ? 'var(--red)' : '#f08040',
                  color: devirFarkSayi === 0 ? 'var(--green)' : devirFarkMaxAbs >= 200 ? 'var(--red)' : '#f08040',
                  fontWeight: devirFarkSayi > 0 ? 800 : undefined,
                  animation: devirFarkMaxAbs >= 200 ? 'pulse 1.2s infinite' : undefined,
                }}
                title={
                  devirFarkSayi === 0
                    ? 'Kasa (para) açılış-kapanış farkı yok'
                    : `${devirFarkSayi} şubede kasa (para) farkı · max ${devirFarkMaxAbs.toFixed(0)}₺`
                }
                onClick={() => acOpsModul('kasa-uyumsuzluk', 'finans-kasa')}
              >
                💰 Kasa Farkı&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {devirFarkSayi > 0 ? `${devirFarkSayi} şube` : '✓'}
                </span>
              </button>
              {/* 📦 Ürün Devir Farkı — açılış↔kapanış stok sayımı (STOK_BAR_DEVIR_FARK) */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: urunDevirSube === 0 ? 'var(--green)' : '#f08040',
                  color: urunDevirSube === 0 ? 'var(--green)' : '#f08040',
                  fontWeight: urunDevirSube > 0 ? 800 : undefined,
                }}
                title={
                  urunDevirSube === 0
                    ? 'Ürün devir sayımları eşleşti (akşam kapanış = sabah açılış)'
                    : `${urunDevirSube} şubede ürün devir farkı (akşam ≠ sabah sayım)`
                }
                onClick={() => acOpsModul('urun-uyumsuzluk', 'finans-kasa')}
              >
                📦 Ürün Devir&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {urunDevirSube > 0 ? `${urunDevirSube} şube` : '✓'}
                </span>
              </button>
              {/* 📋 Kayıtsız Kullanım — gün içi, ürün aç girilmeden çekilmiş (STOK_BAR_GUN_ICI_FARK) */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: kayitsizSube === 0 ? 'var(--green)' : '#a78bfa',
                  color: kayitsizSube === 0 ? 'var(--green)' : '#a78bfa',
                  fontWeight: kayitsizSube > 0 ? 800 : undefined,
                }}
                title={
                  kayitsizSube === 0
                    ? 'Kayıtsız kullanım yok (ürün aç kayıtları tutarlı)'
                    : `${kayitsizSube} şubede ürün aç kaydı eksik (çekilmiş ama girilmemiş)`
                }
                onClick={() => acOpsModul('urun-uyumsuzluk', 'finans-kasa')}
              >
                📋 Kayıtsız Kullanım&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {kayitsizSube > 0 ? `${kayitsizSube} şube` : '✓'}
                </span>
              </button>
              {/* ⚠️ Depoda Yok, Açılmış — karşılıksız açma (URUN_AC_UYUMSUZLUK) */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: karsiliksizSube === 0 ? 'var(--green)' : 'var(--red)',
                  color: karsiliksizSube === 0 ? 'var(--green)' : 'var(--red)',
                  fontWeight: karsiliksizSube > 0 ? 800 : undefined,
                  animation: karsiliksizSube > 0 ? 'pulse 1.2s infinite' : undefined,
                }}
                title={
                  karsiliksizSube === 0
                    ? 'Karşılıksız açma yok (depo stoğu tutarlı)'
                    : `${karsiliksizSube} şubede depoda olmayan ürün açılmış`
                }
                onClick={() => acOpsModul('urun-uyumsuzluk', 'finans-kasa')}
              >
                ⚠️ Depoda Yok&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {karsiliksizSube > 0 ? `${karsiliksizSube} şube` : '✓'}
                </span>
              </button>
              {/* 🚚 Sevkiyat Uyumsuzluğu — sipariş ≠ kabul (son 30 gün) */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: sevkiyatUyumSayi === 0 ? 'var(--green)' : '#f08040',
                  color: sevkiyatUyumSayi === 0 ? 'var(--green)' : '#f08040',
                  fontWeight: sevkiyatUyumSayi > 0 ? 800 : undefined,
                }}
                title={
                  sevkiyatUyumSayi === 0
                    ? 'Sevkiyat uyumsuzluğu yok (sipariş = kabul)'
                    : `${sevkiyatUyumSayi} sevk satırı uzlaştırılmamış (sipariş ≠ kabul)`
                }
                onClick={() => acOpsModul('sevkiyat-uyumsuzluk', 'siparis-kontrol')}
              >
                🚚 Sevkiyat&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {sevkiyatUyumSayi > 0 ? sevkiyatUyumSayi : '✓'}
                </span>
              </button>
              {/* 👥 Personel Vardiya Uyumsuzluğu */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: personelVardiyaSayi === 0 ? 'var(--green)' : '#be185d',
                  color: personelVardiyaSayi === 0 ? 'var(--green)' : '#be185d',
                  fontWeight: personelVardiyaSayi > 0 ? 800 : undefined,
                }}
                title={
                  personelVardiyaSayi === 0
                    ? 'Vardiya planı ile gerçekleşen uyumlu'
                    : `${personelVardiyaSayi} personel vardiya uyumsuzluğu (plan ≠ gerçek)`
                }
                onClick={() => acOpsModul('personel-vardiya-uyumsuzluk', 'personel')}
              >
                👥 Vardiya&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {personelVardiyaSayi > 0 ? personelVardiyaSayi : '✓'}
                </span>
              </button>
              {/* 🔥 Fire Tespiti — bugün bildirilen fire kayıtları */}
              <button
                type="button"
                className="tab-pill"
                style={{
                  borderColor: fireSayi === 0 ? 'var(--green)' : '#f59e0b',
                  color: fireSayi === 0 ? 'var(--green)' : '#f59e0b',
                  fontWeight: fireSayi > 0 ? 800 : undefined,
                }}
                title={
                  fireSayi === 0
                    ? 'Bugün fire bildirimi yok'
                    : `${fireSayi} fire kaydı bildirildi (bugün)`
                }
                onClick={() => acOpsModul('fire-bildirim', 'envanter')}
              >
                🔥 Fire&nbsp;
                <span style={{ fontWeight: 800 }}>
                  {fireSayi > 0 ? fireSayi : '✓'}
                </span>
              </button>
              {/* Toplam Uyarı — tıklanabilir, drawer açar */}
              <button
                type="button"
                className="tab-pill"
                style={{ borderColor: toplamUyari > 0 ? 'var(--red)' : 'var(--green)', color: toplamUyari > 0 ? 'var(--red)' : 'var(--green)' }}
                title={toplamUyari === 0 ? 'Tüm şubeler normal — tıkla' : uyariParcalar.join(' · ')}
                onClick={() => setAlertDrawerAcik(true)}
              >
                🚨 Uyarı&nbsp;
                <span style={{ fontWeight: 800 }}>{toplamUyari}</span>
              </button>
            </div>

            {/* ════ ALERT DRAWER ════ */}
            {alertDrawerAcik && (() => {
              // Tüm uyarıları topla
              const tumUyarilar = [];

              // 1) Geç / açılmayan şubeler
              const gecSubeler = [
                ...(gecAcilanBugun?.subeler || []).map(s => ({
                  _sube: s.sube_adi || s.sube_id,
                  _sube_id: s.sube_id,
                  _seviye: 'kritik',
                  _tip: '⏰ Geç Açılış',
                  _mesaj: `${s.gecikme_dk != null ? s.gecikme_dk + ' dk geç' : 'Gecikme var'}`,
                  _sekme: 'acilis-takip',
                })),
                ...(gecAcilanBugun?.acilmayan_subeler || []).map(s => ({
                  _sube: s.sube_adi || s.sube_id,
                  _sube_id: s.sube_id,
                  _seviye: 'kritik',
                  _tip: '🚫 Açılmadı',
                  _mesaj: 'Bugün hiç açılmadı',
                  _sekme: 'acilis-takip',
                })),
              ];
              tumUyarilar.push(...gecSubeler);

              // 2) Kapanmayan şubeler
              const kapanmayanlar = (kapanisTakip?.satirlar || [])
                .filter(r => !r.kapanis_tamam && r.acildi)
                .map(r => ({
                  _sube: r.sube_adi || r.sube_id,
                  _sube_id: r.sube_id,
                  _seviye: 'uyari',
                  _tip: '🔒 Kapanmadı',
                  _mesaj: 'Kapanış tamamlanmadı',
                  _sekme: 'kapanis-takip',
                }));
              tumUyarilar.push(...kapanmayanlar);

              // 3) Şube kartlarındaki uyarılar
              for (const k of kartlar) {
                for (const u of (k.uyarilar || [])) {
                  const tipLabel = u.tip === 'DAVRANIS' ? '📦 Stok Davranışı'
                    : u.tip === 'KASA_FARK' ? '💰 Kasa Farkı'
                    : u.tip === 'ACILIS_KASA_FARK' ? '💰 Devir Farkı'
                    : u.tip === 'KAPANIS_KASA_FARK' ? '🔍 Kapanış Kasa Açığı'
                    : u.tip === 'URUN_AC_UYUMSUZLUK' ? '📋 Ürün Aç'
                    : u.tip === 'ACILIS_VARDIYA_PERSONEL' ? '👤 Vardiya'
                    : u.tip || 'Uyarı';
                  tumUyarilar.push({
                    _sube: k.sube_adi,
                    _sube_id: k.sube_id,
                    _seviye: u.seviye || 'uyari',
                    _tip: tipLabel,
                    _mesaj: u.mesaj || '',
                    _sekme: null,
                  });
                }
              }

              // Sırala: kritik önce
              const seviyeSkor = { kritik: 0, uyari: 1, bilgi: 2 };
              tumUyarilar.sort((a, b) => (seviyeSkor[a._seviye] ?? 3) - (seviyeSkor[b._seviye] ?? 3));

              // Grupla
              const kritikler = tumUyarilar.filter(u => u._seviye === 'kritik');
              const uyarilar2  = tumUyarilar.filter(u => u._seviye === 'uyari');
              const bilgiler   = tumUyarilar.filter(u => u._seviye !== 'kritik' && u._seviye !== 'uyari');

              const seviyeRenk = { kritik: 'var(--red)', uyari: '#f08040', bilgi: 'var(--text3)' };

              const UyariSatir = ({ u }) => (
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr auto', gap: 6,
                  padding: '8px 10px', borderRadius: 6,
                  background: 'var(--bg)', marginBottom: 4,
                  borderLeft: `3px solid ${seviyeRenk[u._seviye] || 'var(--border)'}`,
                }}>
                  <div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: seviyeRenk[u._seviye] }}>{u._tip}</span>
                      <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>· {u._sube}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.4 }}>{u._mesaj}</div>
                  </div>
                  {u._sekme && (
                    <button type="button" className="btn btn-secondary btn-sm"
                      style={{ fontSize: 11, padding: '3px 8px', alignSelf: 'center' }}
                      onClick={() => { acModulTab(u._sekme); setAlertDrawerAcik(false); }}>
                      Git →
                    </button>
                  )}
                </div>
              );

              const Grup = ({ baslik, liste, renk }) => liste.length === 0 ? null : (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: renk, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
                    {baslik} ({liste.length})
                  </div>
                  {liste.map((u, i) => <UyariSatir key={i} u={u} />)}
                </div>
              );

              return (
                <>
                  {/* Overlay */}
                  <div
                    onClick={() => setAlertDrawerAcik(false)}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1200 }}
                  />
                  {/* Drawer */}
                  <div style={{
                    position: 'fixed', top: 0, right: 0, bottom: 0, width: 380,
                    background: 'var(--bg2)', borderLeft: '2px solid var(--border)',
                    zIndex: 1201, overflowY: 'auto', padding: '20px 16px',
                    boxShadow: '-4px 0 24px rgba(0,0,0,0.3)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>🚨 Aktif Uyarılar</h3>
                        <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text3)' }}>{tumUyarilar.length} aktif · bugün</p>
                      </div>
                      <button type="button" className="btn btn-secondary btn-sm"
                        onClick={() => setAlertDrawerAcik(false)}>✕ Kapat</button>
                    </div>

                    {tumUyarilar.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--green)', fontSize: 14 }}>
                        ✅ Tüm şubeler normal
                      </div>
                    ) : (
                      <>
                        <Grup baslik="🔴 KRİTİK" liste={kritikler} renk="var(--red)" />
                        <Grup baslik="🟠 UYARI" liste={uyarilar2} renk="#f08040" />
                        <Grup baslik="ℹ️ BİLGİ" liste={bilgiler} renk="var(--text3)" />
                      </>
                    )}
                  </div>
                </>
              );
            })()}

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

            {/* Şube kartları grid */}
            {yukleniyor ? (
              <div className="loading" style={{ marginBottom: 16 }}><div className="spinner" />Yükleniyor…</div>
            ) : kartlar.length === 0 ? (
              <div className="empty"><div className="icon">✅</div><p>Seçili filtrede gösterilecek şube bulunamadı</p></div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
                {kartlar.map((k) => (
                  <SubeKart key={k.sube_id || k.sube_adi} k={k} onDetay={setDetay} personelRisk={riskliPersonelSubeMap[k.sube_id]} haftaTrend={haftaTrendSubeMap[String(k.sube_id)]} />
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
                  className="btn btn-secondary btn-sm"
                  title="siparis_urun.ad alanlarini depo stok kanonik adlariyla esitler — tek seferlik calistir"
                  onClick={async () => {
                    try {
                      const r = await api('/ops/siparis/sync-urun-adlari', { method: 'POST' });
                      toast(`Senkronizasyon tamamlandi — ${r.urun_guncellenen_adet} urun adi, ${r.talep_guncellenen_adet} gecmis talep guncellendi.`, 'green');
                      await magazaDepoTamYenile();
                    } catch (e) {
                      toast(`Senkronizasyon hatasi: ${e.message}`, 'red');
                    }
                  }}
                >
                  🔄 Adlari depoya esitle
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setMagazaUrunAdGuncelleAcik((a) => {
                      const ac = !a;
                      if (ac) { setMagazaUrunEkleAcik(false); setMagazaFiyatGuncelleAcik(false); }
                      return ac;
                    });
                  }}
                  style={magazaUrunAdGuncelleAcik ? { boxShadow: '0 0 0 1px rgba(90, 140, 220, 0.6)' } : undefined}
                >
                  {magazaUrunAdGuncelleAcik ? 'Adı güncellemeyi kapat' : '✏️ Adı güncelle'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setMagazaUrunEkleAcik((a) => {
                      const ac = !a;
                      if (ac) { setMagazaFiyatGuncelleAcik(false); setMagazaUrunAdGuncelleAcik(false); }
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
                      if (ac) { setMagazaUrunEkleAcik(false); setMagazaUrunAdGuncelleAcik(false); }
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

          {magazaUrunAdGuncelleAcik && (
            <div
              className="card"
              style={{ marginBottom: 16, padding: '14px 16px', borderLeft: '4px solid #5a8cdc', background: 'var(--bg2)' }}
            >
              <h4 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 6px' }}>✏️ Ürün adını güncelle</h4>
              <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.45 }}>
                Katalog ürününün adını değiştir. Geçmiş sipariş kayıtlarındaki ad da otomatik güncellenir.
              </p>
              <div style={{ display: 'grid', gap: 10 }}>
                <label style={{ margin: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Kategori</span>
                  <select
                    className="input"
                    value={magazaUrunAdForm.kategori_kod}
                    onChange={(e) => setMagazaUrunAdForm((p) => ({ ...p, kategori_kod: e.target.value, urun_id: '', yeni_ad: '' }))}
                  >
                    <option value="">— Kategori seç —</option>
                    {(magazaDepoKatalogState.kategoriler || []).map((k) => (
                      <option key={k.id} value={k.id}>{k.label || k.ad}</option>
                    ))}
                  </select>
                </label>
                {magazaUrunAdForm.kategori_kod && (
                  <label style={{ margin: 0 }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ürün</span>
                    <select
                      className="input"
                      value={magazaUrunAdForm.urun_id}
                      onChange={(e) => {
                        const uid = e.target.value;
                        const kat = (magazaDepoKatalogState.kategoriler || []).find((k) => k.id === magazaUrunAdForm.kategori_kod);
                        const urun = (kat?.items || []).find((it) => it.id === uid);
                        setMagazaUrunAdForm((p) => ({ ...p, urun_id: uid, yeni_ad: urun?.ad || '' }));
                      }}
                    >
                      <option value="">— Ürün seç —</option>
                      {(() => {
                        const kat = (magazaDepoKatalogState.kategoriler || []).find((k) => k.id === magazaUrunAdForm.kategori_kod);
                        return (kat?.items || []).map((it) => (
                          <option key={it.id} value={it.id}>{it.ad}</option>
                        ));
                      })()}
                    </select>
                  </label>
                )}
                {magazaUrunAdForm.urun_id && (
                  <label style={{ margin: 0 }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Yeni ad</span>
                    <input
                      className="input"
                      value={magazaUrunAdForm.yeni_ad}
                      onChange={(e) => setMagazaUrunAdForm((p) => ({ ...p, yeni_ad: e.target.value }))}
                      placeholder="Ürün adı"
                    />
                  </label>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-secondary btn-sm"
                    onClick={() => setMagazaUrunAdForm({ kategori_kod: '', urun_id: '', yeni_ad: '' })}>
                    Temizle
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!magazaUrunAdForm.urun_id || !String(magazaUrunAdForm.yeni_ad || '').trim()}
                    onClick={async () => {
                      const yeniAd = String(magazaUrunAdForm.yeni_ad || '').trim();
                      if (!yeniAd) return;
                      try {
                        const r = await api('/ops/siparis/urun-ad', {
                          method: 'POST',
                          body: {
                            kategori_kod: magazaUrunAdForm.kategori_kod,
                            urun_id: magazaUrunAdForm.urun_id,
                            yeni_ad: yeniAd,
                          },
                        });
                        toast(`"${yeniAd}" olarak güncellendi. Geçmiş talep güncellenen: ${r.talep_guncellenen_adet}`, 'green');
                        setMagazaUrunAdForm({ kategori_kod: '', urun_id: '', yeni_ad: '' });
                        await magazaDepoTamYenile();
                      } catch (e) {
                        toast(`Ad güncellenemedi: ${e.message}`, 'red');
                      }
                    }}
                  >
                    Adı güncelle
                  </button>
                </div>
              </div>
            </div>
          )}

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
                        const canliSatir = magazaCanliDepoSatirBul(canliStokSatirlari, it);
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
                                  const etkinSubeId = String(k?.sube_id || m?.sube_id || '').trim();
                                  const canliSatir = magazaCanliDepoSatirBul(canliStokSatirlari, it);
                                  const referansHam = canliSatir ? canliSatir.mevcut_adet : it.stok;
                                  const referansSayi = String(referansHam ?? '').trim() === '' ? 0 : (magazaKatalogSayi(referansHam) ?? 0);
                                  const stokRaw = magazaStokGirdiOku(magazaSubeStokInput, subeDepoKey, it.id, referansHam);
                                  const stokSayi = String(stokRaw).trim() === '' ? null : magazaKatalogSayi(stokRaw);
                                  const efektifBirimFiyat = magazaUrunEfektifBirimFiyat(it, magazaGlobalFiyatMap);
                                  const onayGerekli = stokSayi != null && stokSayi !== referansSayi;
                                  const onayBusy = !!magazaStokOnayBusy[mapKey];
                                  const kalemKoduKayit = magazaDepoKalemKodu(it);
                                  const satirToplam = stokSayi != null && efektifBirimFiyat != null && Number.isFinite(efektifBirimFiyat)
                                    ? stokSayi * efektifBirimFiyat
                                    : null;
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
                                        {canliSatir != null ? (
                                          <span style={{ fontSize: 9, color: 'var(--text3)' }}>
                                            Depoda: {magazaFmtStok(canliSatir.mevcut_adet)}
                                            <span className="mono" style={{ marginLeft: 4, opacity: 0.85 }}>({magazaDepoKalemKodu(it)})</span>
                                          </span>
                                        ) : it.stok != null ? (
                                          <span style={{ fontSize: 9, color: 'var(--text3)' }}>Sistem: {magazaFmtStok(it.stok)}</span>
                                        ) : (
                                          <span style={{ fontSize: 9, color: 'var(--text3)' }}>Depoda kayıt yok</span>
                                        )}
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
                                                kalem_kodu: magazaDepoKalemKodu(it),
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
                                        disabled={!etkinSubeId || stokSayi == null || !onayGerekli || onayBusy}
                                        title={
                                          !etkinSubeId
                                            ? 'Şube bağlantısı yok — canlı operasyon kartı yüklenene kadar bekleyin'
                                            : stokSayi == null
                                              ? 'Geçerli bir sayı girin'
                                              : onayGerekli
                                                ? `Depoya işle (havuz: ${kalemKoduKayit})`
                                                : 'Onay gerektiren değişiklik yok'
                                        }
                                        onClick={() => {
                                          if (!etkinSubeId || stokSayi == null) return;
                                          magazaStokKalemOnayla({
                                            slug: m.slug,
                                            subeDepoKey,
                                            subeId: etkinSubeId,
                                            mapKey,
                                            kalemKodu: kalemKoduKayit,
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
                        const canliSatir = magazaCanliDepoSatirBul(canliStokSatirlari, it);
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
                    {panelSekme === 'canli' && (() => {
                      const canliGruplar = magazaCanliDepoKategoriGruplari(canliStokSatirlari, katList);
                      const varsayilanKat = canliGruplar[0]?.katId || '';
                      const aktifKat = magazaDepoCanliKatSekme[m.slug] ?? varsayilanKat;
                      const aktifGrup = canliGruplar.find((g) => g.katId === aktifKat) || canliGruplar[0];
                      const gosterilenSatirlar = aktifGrup?.satirlar || [];
                      const aktifToplam = gosterilenSatirlar.reduce(
                        (s, st) => s + Number(st?.mevcut_adet || 0),
                        0,
                      );
                      return (
                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4 }}>
                            Canlı depo stok kaydı (şube paneli ürün kabul)
                          </div>
                          <p style={{ fontSize: 10, color: 'var(--text3)', margin: '0 0 8px', lineHeight: 1.4 }}>
                            Şube panelinde <strong>ürün teslim/kabul</strong> ile depoya eklenen kalemler burada tutulur.
                            Kategoriler arasında geçmek için üstteki sekmeleri kullanın.
                          </p>
                          {canliStokSatirlari.length === 0 ? (
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>Bu şube için depo kayıt satırı yok.</div>
                          ) : (
                            <>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  flexWrap: 'nowrap',
                                  overflowX: 'auto',
                                  WebkitOverflowScrolling: 'touch',
                                  paddingBottom: 4,
                                  marginBottom: 8,
                                }}
                              >
                                {canliGruplar.map((gr) => {
                                  const secili = aktifKat === gr.katId;
                                  return (
                                    <button
                                      key={`${m.slug}-canli-kat-${gr.katId}`}
                                      type="button"
                                      className={`btn btn-sm ${secili ? 'btn-primary' : 'btn-secondary'}`}
                                      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                                      onClick={() => setMagazaDepoCanliKatSekme((prev) => ({ ...prev, [m.slug]: gr.katId }))}
                                    >
                                      {gr.katLabel}
                                      <span style={{ marginLeft: 6, opacity: 0.85, fontSize: 10 }}>
                                        ({gr.satirlar.length})
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                              {aktifGrup ? (
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: 'var(--text3)',
                                    marginBottom: 6,
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span>
                                    <strong style={{ color: 'var(--text2)' }}>{aktifGrup.katLabel}</strong>
                                    {' · '}
                                    {gosterilenSatirlar.length} kalem
                                  </span>
                                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                                    Toplam adet: <strong>{magazaFmtStok(aktifToplam)}</strong>
                                  </span>
                                </div>
                              ) : null}
                              <div
                                style={{
                                  display: 'grid',
                                  gap: 6,
                                  maxHeight: magazaDepoOdakSlug === m.slug ? 420 : 260,
                                  overflow: 'auto',
                                  paddingRight: 2,
                                }}
                              >
                                {gosterilenSatirlar.map((st) => {
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
                            </>
                          )}
                        </div>
                      );
                    })()}
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
              <CacheFreshnessBadge
                guncelleme={sekmeSonGuncelleme['metrics']}
                kaynak="live"
                onYenile={() => yukleMetrics()}
                yenileniyor={yukleniyor}
              />
            </div>
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
                <>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Vardiya eksik oranı: <strong>{metricNum(mSubeOperasyonKalite.vardiya_eksik_oran, 2)}%</strong><br />
                  Not/gün ort.: <strong>{metricNum(mSubeOperasyonKalite.not_gonderim_gunluk_ort, 2)}</strong><br />
                  Sipariş çevrim (gün): <strong>{metricNum(mSubeOperasyonKalite.siparis_cevrim_sure_gun, 2)}</strong>
                </div>
                {(() => {
                  // Şube kırılımı: mevcut payload'daki per-sube dizilerini birleştir
                  const vardiya = mSubeOperasyonKalite.vardiya_devri_eksik_tik_orani || [];
                  const notlar = mSubeOperasyonKalite.not_gonderme_sikligi || [];
                  const merged = {};
                  vardiya.forEach((v) => {
                    const k = String(v.sube_id);
                    merged[k] = merged[k] || { sube_id: v.sube_id, sube_adi: v.sube_adi };
                    merged[k].eksik_tik_orani_pct = v.eksik_tik_orani_pct;
                    merged[k].toplam_devri = v.toplam_devri;
                  });
                  notlar.forEach((n) => {
                    const k = String(n.sube_id);
                    merged[k] = merged[k] || { sube_id: n.sube_id, sube_adi: n.sube_adi };
                    merged[k].gunluk_ortalama_not = n.gunluk_ortalama_not;
                  });
                  const rows = Object.values(merged);
                  if (rows.length === 0) return null;
                  return (
                    <div className="table-wrap" style={{ margin: '12px 0 0' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                        🏪 Şube kırılımı
                      </div>
                      <table>
                        <thead>
                          <tr>
                            <th>Şube</th>
                            <th style={{ textAlign: 'right' }}>Vardiya Eksik Tik %</th>
                            <th style={{ textAlign: 'right' }}>Devir Sayısı</th>
                            <th style={{ textAlign: 'right' }}>Not/gün</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.sube_id}>
                              <td style={{ fontWeight: 600 }}>{r.sube_adi || r.sube_id}</td>
                              <td className="mono" style={{ textAlign: 'right', color: (r.eksik_tik_orani_pct || 0) > 0 ? 'var(--orange)' : 'var(--green)' }}>
                                {r.eksik_tik_orani_pct != null ? `${metricNum(r.eksik_tik_orani_pct, 1)}%` : '—'}
                              </td>
                              <td className="mono" style={{ textAlign: 'right' }}>{r.toplam_devri ?? '—'}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{r.gunluk_ortalama_not != null ? metricNum(r.gunluk_ortalama_not, 2) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                        Önceki dönem trendi backend'de per-şube döndürülmüyor (yalnızca kontrol gecikme trendi mevcut). Delta gösterimi için ek endpoint gerekir.
                      </div>
                    </div>
                  );
                })()}
                </>
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>
              Personel açılış davranışı (son {personelDavranis?.gun_sayi || 45} gün)
            </h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={(personelDavranis?.personel_ozet || []).length === 0}
              onClick={() => listeyiCsvIndir(
                personelDavranis?.personel_ozet || [],
                [
                  { key: 'personel', baslik: 'Personel', fn: (p) => p.personel_ad || p.personel_id },
                  { key: 'sube', baslik: 'Şube', fn: (p) => p.sube_adi || p.sube_id },
                  { key: 'acilis_sayisi', baslik: 'Açılış', fn: (p) => p.acilis_sayisi || 0 },
                  { key: 'acilis_kasa_fark_adet', baslik: 'Kasa Fark', fn: (p) => p.acilis_kasa_fark_adet || 0 },
                  { key: 'bardak_dusuk_toplam', baslik: 'Bardak Düşük', fn: (p) => p.bardak_dusuk_toplam || 0 },
                  { key: 'vardiya_eksik_adet', baslik: 'Vardiya Eksik', fn: (p) => p.vardiya_eksik_adet || 0 },
                  { key: 'davranis_risk_skoru', baslik: 'Risk', fn: (p) => p.davranis_risk_skoru || 0 },
                ],
                'personel_davranis'
              )}
            >
              ⬇️ CSV
            </button>
          </div>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={defter.length === 0}
              onClick={() => listeyiCsvIndir(
                defter,
                [
                  { key: 'tarih', baslik: 'Tarih', fn: (r) => (r.tarih || '').substring(0, 10) },
                  { key: 'saat', baslik: 'Saat', fn: (r) => (r.olay_ts || '').substring(11, 19) },
                  { key: 'sube', baslik: 'Şube', fn: (r) => r.sube_adi || r.sube_id },
                  { key: 'etiket', baslik: 'Etiket' },
                  { key: 'aciklama', baslik: 'Açıklama' },
                ],
                'islem_defteri'
              )}
            >
              ⬇️ CSV
            </button>
          </div>
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
            const labels = { bardak_kucuk:'8oz', bardak_buyuk:'14oz', bardak_plastik:'Plastik', karton_bardak:'Karton Bardak', su_adet:'Su', sut_litre:'Süt', soda_adet:'Soda', redbull_adet:'Redbull', cookie_adet:'Cookie', pasta_adet:'Pasta', surup_adet:'Şurup', kahve_paket:'Kahve Pkt', kapak_adet:'Kapak', pecete_paket:'Peçete', diger_sarf:'Diğer' };
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
            Kaynak <strong style={{ color: 'var(--text2)' }}>/ops/bar-ozet</strong> (yalnızca tamamlanmış <strong style={{ color: 'var(--text2)' }}>KAPANIS</strong> eventi; vardiya devir sayımı kullanılmaz):{' '}
            <strong style={{ color: 'var(--text2)' }}>Satılan = Açılış + Ürün Aç − Kapanış</strong> (8oz, 14oz, plastik bardak, su, süt, soda, redbull, pasta vb.).
            <strong style={{ color: 'var(--text2)' }}> Pozitif satılan</strong> = normal tüketim. <strong style={{ color: '#fca5a5' }}>Negatif satılan</strong> = Ürün Aç paneline girilmemiş (depo stok hatası) — Ürün Uyumsuzlukları sekmesinde denetlenir.
            Tabloda <strong style={{ color: 'var(--text2)' }}>Dün kapanış</strong> sütunu bir önceki günün kapanış sayımını gösterir (devir; ürün aç ile karıştırılmaz).
            <strong style={{ color: 'var(--text2)' }}> Satılan</strong> sütununun altında Evo Hızlı Satış’tan gelen malzeme adedi (ör. redbull, 14oz karton bardak) yazılır.
            Kapanış yapılmamış şubeler bu listede görünmez. Tarih, operasyon olayının takvim günüdür.
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
          {kullanilanAramaSonuc?.evo_veri_geldi === false && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(239,68,68,.08)',
                border: '1px solid rgba(239,68,68,.35)',
                fontSize: 12,
                color: '#fca5a5',
                lineHeight: 1.5,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: '1 1 240px' }}>
                <strong style={{ color: '#f87171' }}>⚠ Evo veri gelmedi</strong>
                {' — '}
                {kullanilanAramaSonuc?.evo_mesaj || 'Satılan sütununda Evo karşılaştırması gösterilemez. EVO_WEB_TOKEN veya EVO_KULLANICI/EVO_SIFRE kontrol edin.'}
                <div style={{ marginTop: 6, fontSize: 11, color: '#fdba74' }}>
                  Veri akışı başladıysa <strong>Evo yenile</strong> ile tekrar deneyin; bu sekme açıkken otomatik olarak ~45 sn’de bir yeniden sorgulanır.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={kullanilanEvoYenileniyor || kullanilanAramaYukleniyor}
                onClick={() => kullanilanAramaYap({ evoYenile: true })}
                style={{
                  alignSelf: 'center',
                  whiteSpace: 'nowrap',
                  background: 'rgba(245,158,11,0.15)',
                  border: '1px solid rgba(245,158,11,0.45)',
                  color: '#fde68a',
                  fontWeight: 700,
                }}
              >
                {kullanilanEvoYenileniyor ? '⏳ Evo yenileniyor…' : '🔄 Evo yenile'}
              </button>
            </div>
          )}
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
                const ozet = kullanilanTabloOzet(r, keys, labels);
                const urunAcEksik = kullanilanUrunAcEksikVar(r);
                const kapanisYok = !r.kapanis_var;
                const evoYok = r.evo_veri_geldi === false;
                const evoMesaj = r.evo_mesaj || kullanilanAramaSonuc?.evo_mesaj || 'Evo veri gelmedi';
                return (
                  <div key={`${r.sube_id}-${r.tarih}`} className="card" style={{
                    borderLeft: `4px solid ${urunAcEksik ? 'var(--red)' : kapanisYok ? 'var(--yellow)' : 'var(--green)'}`,
                    padding: '14px 16px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.sube_adi}</span>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{r.tarih}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {urunAcEksik && <span className="badge badge-red" title="Açılış + Ürün Aç − Kapanış negatif — Ürün Aç paneline eksik kayıt">Ürün aç eksik</span>}
                        {kapanisYok && <span className="badge badge-yellow">Kapanış yok</span>}
                        {!urunAcEksik && !kapanisYok && <span className="badge badge-green">Normal</span>}
                        {evoYok && (
                          <span className="badge badge-red" title={evoMesaj} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            Evo veri gelmedi
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)' }}>
                            <th style={{ padding: '5px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, fontSize: 11 }}>Ürün</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#c4b5fd', fontWeight: 600, fontSize: 11 }} title={r.onceki_kapanis_tarihi ? `Önceki gün: ${r.onceki_kapanis_tarihi}` : ''}>
                              Dün kapanış{r.onceki_kapanis_tarihi ? ` (${String(r.onceki_kapanis_tarihi).slice(5)})` : ''}
                            </th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600, fontSize: 11 }}>Açılış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#86efac', fontWeight: 600, fontSize: 11 }}>Ürün Aç</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600, fontSize: 11 }}>Kapanış</th>
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#e2e8f0', fontWeight: 700, fontSize: 11 }}>Satılan</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((k) => {
                            const dun = r.dun_kapanis?.[k] ?? 0;
                            const ac = r.acilis?.[k] ?? 0;
                            const ua = r.urun_ac?.[k] ?? 0;
                            const kap = r.kapanis?.[k] ?? 0;
                            const sat = r.satilan?.[k] ?? 0;
                            const evoLbl = r.evo_etiket?.[k] || '';
                            const neg = sat < 0 && KULLANILAN_URUN_AC_DENETIM.has(k);
                            if (ac === 0 && ua === 0 && kap === 0 && dun === 0 && sat === 0 && !evoLbl) return null;
                            const devirFark = dun > 0 && ac > 0 && dun !== ac;
                            return (
                              <tr key={k} style={{ borderTop: '1px solid var(--border)' }}>
                                <td style={{ padding: '5px 8px', color: 'var(--text2)' }}>{labels[k] || k}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: devirFark ? '#fdba74' : dun > 0 ? '#c4b5fd' : 'var(--text3)' }}>
                                  {r.onceki_kapanis_yok ? '—' : dun}
                                </td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center' }}>{ac}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: ua > 0 ? '#86efac' : 'var(--text3)' }}>{ua > 0 ? `+${ua}` : ua}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: kap > 0 ? '#fbbf24' : 'var(--text3)' }}>{kap > 0 ? `-${kap}` : '—'}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, color: neg ? 'var(--red)' : sat > 0 ? '#86efac' : 'var(--text3)' }}
                                  title={neg ? `Ürün Aç paneline ≈${Math.abs(sat)} ad girilmemiş (depo stok hatası)` : undefined}>
                                  <div>{sat}</div>
                                  {evoLbl ? (
                                    <div style={{ fontSize: 10, fontWeight: 500, color: '#93c5fd', marginTop: 3, lineHeight: 1.35 }}>
                                      {evoLbl}
                                    </div>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                          {ozet.satirSay > 0 && (
                            <tr style={{ borderTop: '2px solid var(--border)', background: 'rgba(245,158,11,.06)' }}>
                              <td style={{ padding: '6px 8px', fontWeight: 800, fontSize: 11, color: '#fbbf24' }}>Toplam</td>
                              <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700, color: '#c4b5fd' }}>
                                {r.onceki_kapanis_yok ? '—' : ozet.tDun}
                              </td>
                              <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700 }}>{ozet.tAc}</td>
                              <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700, color: '#86efac' }}>{ozet.tUa > 0 ? `+${ozet.tUa}` : ozet.tUa}</td>
                              <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 700, color: '#fbbf24' }}>{ozet.tKap > 0 ? `-${ozet.tKap}` : '—'}</td>
                              <td className="mono" style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 800, color: ozet.tSat < 0 ? 'var(--red)' : '#86efac' }}>
                                <div>{ozet.tSat}</div>
                                {ozet.evoSatirlar.length > 0 ? (
                                  <div style={{ fontSize: 10, fontWeight: 500, color: '#93c5fd', marginTop: 4, lineHeight: 1.4, textAlign: 'left' }}>
                                    {ozet.evoSatirlar.map((line, i) => (
                                      <div key={i}>{line}</div>
                                    ))}
                                  </div>
                                ) : evoYok ? (
                                  <div style={{ fontSize: 10, fontWeight: 600, color: '#fca5a5', marginTop: 4, lineHeight: 1.4, textAlign: 'left' }}>
                                    {evoMesaj}
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          )}
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

        // Seçili şube varsa kart/toplam alanları yalnız o şubeye göre hesaplanır.
        const subeSecili = kapanisTakipSubeSec != null
          && satirlar.some(r => String(r.sube_id) === String(kapanisTakipSubeSec))
          ? String(kapanisTakipSubeSec) : null;
        const aktifSatirlar = subeSecili
          ? satirlar.filter(r => String(r.sube_id) === subeSecili)
          : satirlar;

        const ktOnlineCift = (r) => {
          const n = Number(r.nakit) || 0;
          const p = Number(r.pos) || 0;
          const o = Number(r.online) || 0;
          return r.online_cift_kayit === true
            || (o > 0 && n > 0 && p > 0 && Math.abs(o - (n + p)) < 0.5);
        };
        const ktOnlineNet = (r) => (ktOnlineCift(r) ? 0 : (Number(r.online) || 0));
        const ktCiroToplam = (r) => {
          const n = Number(r.nakit) || 0;
          const p = Number(r.pos) || 0;
          const o = ktOnlineNet(r);
          if (r.ciro_tutar > 0) {
            return ktOnlineCift(r) && r.ciro_tutar > n + p + 0.5 ? n + p : r.ciro_tutar;
          }
          return n + p + o;
        };
        const topNakit  = aktifSatirlar.reduce((s, r) => s + (r.nakit  || 0), 0);
        const topPos    = aktifSatirlar.reduce((s, r) => s + (r.pos    || 0), 0);
        const topOnline = aktifSatirlar.reduce((s, r) => s + ktOnlineNet(r), 0);
        const topCiro   = aktifSatirlar.reduce((s, r) => s + ktCiroToplam(r), 0);
        const topSabah  = aktifSatirlar.reduce((s, r) => s + (Number(r.sabah_kasa_tl) || 0), 0);
        const topTeslim = aktifSatirlar.reduce((s, r) => s + (Number(r.teslim_kasa_tl) || 0), 0);
        const topDevir  = aktifSatirlar.reduce((s, r) => s + (Number(r.devir) || 0), 0);
        const topAraTeslim = aktifSatirlar.reduce((s, r) => s + (Number(r.ara_teslim_tl) || 0), 0);
        const topAgider = aktifSatirlar.reduce((s, r) => s + (Number(r.anlik_gider_nakit_tl) || 0), 0);

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
          const kismi = r.nakit_denkleme_kismi === true;
          const tam = r.nakit_denkleme_tam === true || (ac && kap);
          const nakitX = Number(r.nakit) || 0;
          const giderN = Number(r.anlik_gider_nakit_tl) || 0;
          if ((tam || kismi) && fark != null && !Number.isNaN(Number(fark))) {
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
                (kismi && !tam
                  ? `Kısmi: sabah kasa + X nakit (${fmt(nakitX)}) − gider (${fmt(giderN)}) − ara teslim. `
                  : `Tam: sabah kasa + X nakit (${fmt(nakitX)}) − teslim − devir − ara teslim − gider (${fmt(giderN)}). `)
                + (buyuk
                  ? (fv > 0
                    ? 'Pozitif: denkleme göre kasada tutması gerekenden az nakit (açık).'
                    : 'Negatif: denkleme göre kasada tutması gerekenden fazla nakit (fazla).')
                  : 'Mutlak değer küçük; pratikte dengeli.');
              const etiketRenk = !buyuk ? 'var(--text3)' : fv > 0 ? '#e85d5d' : '#22c55e';
              return (
                <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }} title={title}>
                  <span style={farkStil(fark)}>{fs} ₺</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: etiketRenk, whiteSpace: 'nowrap' }}>
                    {kismi && !tam ? 'Kısmi Δ' : etiket}
                  </span>
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
              <button
                className="btn btn-sm"
                style={{ height: 32, borderColor: 'var(--orange)', color: 'var(--orange)' }}
                title="Seçili şubenin bu günkü mühürlü kapanışını geri al (İşletme PIN gerekir)"
                onClick={async () => {
                  const sid = kapanisTakipSubeSec;
                  if (!sid) { toast('Önce alttan bir şube seç, sonra Kapanışı Geri Al.', 'red'); return; }
                  const satir = tumSatirlar.find(r => String(r.sube_id) === String(sid));
                  const ad = satir?.sube_adi || sid;
                  if (!window.confirm(`${ad} — ${kapanisTakipTarih}\n\nKapanışı GERİ AL?\nBekleyen ciro taslağı iptal edilir, şube kapanışı yeniden yapabilir. Kasaya dokunmaz.`)) return;
                  const pin = window.prompt('İşletme onayı — Merve Karabacak 4 haneli PIN:');
                  if (!pin) return;
                  try {
                    const r = await api(`/sube-panel/${sid}/kapanis-geri-al`, { method: 'POST', body: { onay_pin: pin, tarih: kapanisTakipTarih, sebep: 'Merkez: hatalı/erken kapanış geri alındı' } });
                    const g = r.geri_alindi || {};
                    toast(`✓ ${ad} kapanışı geri alındı (taslak ${g.ciro_taslak_iptal||0}, kayıt ${g.kapanis_kayit_iptal||0}). Şube yeniden kapanış yapabilir.`, 'green');
                    yukleKapanisTakip(kapanisTakipTarih);
                  } catch (e) { toast(e.message || 'Geri alınamadı', 'red'); }
                }}
              >
                🔓 Kapanışı Geri Al
              </button>
              {bugunMu && (
                <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>
                  Her 2 dk otomatik güncellenir
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CacheFreshnessBadge
                  guncelleme={kapanisTakipSonGuncelleme}
                  kaynak={kapanisTakipKaynak}
                  onYenile={() => yukleKapanisTakip(kapanisTakipTarih)}
                  yenileniyor={kapanisTakipYukleniyor}
                />
              </div>
            </div>
            {kt?.takvim_tr && kt?.is_gunu_tr && String(kt.takvim_tr) !== String(kt.is_gunu_tr) ? (
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                Takvim: <span className="mono">{kt.takvim_tr}</span> · İş günü: <span className="mono">{kt.is_gunu_tr}</span>
              </div>
            ) : null}
            <details style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--text2)' }}>ℹ️ Bu ekran nasıl okunur?</summary>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4 }}>
                <p style={{ margin: 0 }}>
                  Varsayılan tarih <strong>iş günü</strong> (İstanbul'da gece 02:00'ye kadar önceki takvim günü). Kapanış son teslim: ertesi gün{' '}
                  {Number(kt?.kapanis_son_teslim_saat) === 2 || kt?.kapanis_son_teslim_saat == null ? '02:00' : `${String(kt?.kapanis_son_teslim_saat)}:00`}.
                </p>
                <p style={{ margin: 0 }}>
                  <strong>Ciro:</strong> kapanış yapılmış şubede panelde girilen <strong>Nakit / POS / Online</strong> (Toplam = üçünün toplamı).
                  Online satış yoksa 0 görünür; yanlışlıkla nakit+POS toplamı online'a yazılırsa düzeltilir.
                </p>
                <p style={{ margin: 0 }}>
                  <strong>Para akışı / Nakit Δ:</strong> sabah kasa + <em>Nakit (X)</em> − teslim − devir − ara teslim − <em>anlık gider (nakit)</em>.
                  Pozitif Δ = kasa açığı, negatif Δ = kasa fazlası. POS ve online Δ'ye dahil değildir.
                </p>
              </div>
            </details>

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

            {/* ── Şube seçici çipler ── tıklayınca alttaki kartlar + toplamlar o şubeye odaklanır */}
            {satirlar.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>Şube</span>
                <button
                  onClick={() => setKapanisTakipSubeSec(null)}
                  style={{
                    cursor: 'pointer', borderRadius: 999, padding: '5px 14px', fontSize: 12, fontWeight: 700,
                    background: subeSecili == null ? 'rgba(99,102,241,0.15)' : 'var(--bg2)',
                    color: subeSecili == null ? '#818cf8' : 'var(--text2)',
                    border: `1px solid ${subeSecili == null ? '#818cf8' : 'var(--border)'}`,
                  }}
                >
                  Tümü · {satirlar.length}
                </button>
                {satirlar.map((r) => {
                  const sec = subeSecili === String(r.sube_id);
                  const acc = !r.kapanis_tamam ? '#e85d5d' : !r.ciro_onaylandi && !r.taslak_var ? '#f97316' : r.taslak_var && r.taslak_durum === 'bekliyor' ? '#fbbf24' : '#22c55e';
                  return (
                    <button
                      key={r.sube_id}
                      onClick={() => setKapanisTakipSubeSec((prev) => (String(prev) === String(r.sube_id) ? null : String(r.sube_id)))}
                      style={{
                        cursor: 'pointer', borderRadius: 999, padding: '5px 14px', fontSize: 12, fontWeight: 700,
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: sec ? 'rgba(99,102,241,0.15)' : 'var(--bg2)',
                        color: sec ? 'var(--text)' : 'var(--text2)',
                        border: `1px solid ${sec ? '#818cf8' : 'var(--border)'}`,
                      }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: acc, flexShrink: 0 }} />
                      {r.sube_adi}
                    </button>
                  );
                })}
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

            {/* ── Şube kartları (varsayılan görünüm) ── */}
            {satirlar.length > 0 && (() => {
              const oncAksan = (r) => { const o = _oncelik(r); return o === 0 ? '#e85d5d' : o === 1 ? '#f97316' : o === 2 ? '#fbbf24' : '#22c55e'; };
              const rozet = (c) => ({ background: 'var(--bg2)', color: c, border: `1px solid ${c}`, borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' });
              const durumRozetleri = (r) => {
                const out = [];
                out.push(
                  r.kapanis_tamam
                    ? <span key="k" style={rozet('#22c55e')}>✅ Kapandı</span>
                    : r.acildi
                    ? <span key="k" style={rozet('#e85d5d')}>🔴 Kapanmadı</span>
                    : <span key="k" style={rozet('var(--text3)')}>Açılmadı</span>
                );
                if (r.ciro_onaylandi) out.push(<span key="c" style={rozet('#22c55e')}>✓ Ciro onaylı</span>);
                else if (r.taslak_var && r.taslak_durum === 'bekliyor') out.push(<span key="c" style={rozet('#fbbf24')}>⏳ Onayda</span>);
                else if (r.kapanis_tamam) out.push(<span key="c" style={rozet('#e85d5d')}>❌ Ciro yok</span>);
                return out;
              };
              const akisSerit = (r) => {
                if (!r.kapanis_tamam) {
                  return (
                    <div style={{ fontSize: 12, fontWeight: 700, color: r.acildi ? '#e85d5d' : 'var(--text3)', padding: '8px 0' }}>
                      {r.acildi ? '⛔ Kapanış yapılmadı — kasa hareketi henüz yok' : '○ Şube bugün açılmadı'}
                    </div>
                  );
                }
                const adimlar = [
                  { e: 'Sabah kasa', v: Number(r.sabah_kasa_tl) || 0, s: '', c: 'var(--text2)' },
                  { e: 'Nakit (X)', v: Number(r.nakit) || 0, s: '+', c: '#22c55e' },
                  { e: 'Teslim', v: Number(r.teslim_kasa_tl) || 0, s: '−', c: '#e85d5d' },
                  { e: 'Devir', v: Number(r.devir) || 0, s: '−', c: '#60a5fa' },
                ];
                if ((Number(r.ara_teslim_tl) || 0) > 0) adimlar.push({ e: 'Ara teslim', v: Number(r.ara_teslim_tl), s: '−', c: '#e85d5d' });
                if ((Number(r.anlik_gider_nakit_tl) || 0) > 0) adimlar.push({ e: 'Gider (N)', v: Number(r.anlik_gider_nakit_tl), s: '−', c: '#f59e0b' });
                return (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 6 }}>
                    {adimlar.map((a, i) => (
                      <div key={i} style={{ display: 'flex', flexDirection: 'column', minWidth: 62, padding: '5px 9px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
                        <span style={{ fontSize: 9, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{a.e}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: a.c, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{a.s}{fmt(a.v)} ₺</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: 18, color: 'var(--text3)', fontWeight: 700 }}>=</div>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 88, padding: '5px 11px', borderRadius: 8, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.3)' }}>
                      <span style={{ fontSize: 9, color: 'var(--text3)' }}>Nakit Δ</span>
                      {nakitDeltaHucre(r)}
                    </div>
                  </div>
                );
              };
              const kart = (r) => {
                const toplam = ktCiroToplam(r);
                const onlineNet = ktOnlineNet(r);
                return (
                  <div key={r.sube_id} style={{ border: '1px solid var(--border)', borderLeft: `4px solid ${oncAksan(r)}`, borderRadius: 12, padding: '14px 16px', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 16, fontWeight: 800 }}>🏪 {r.sube_adi}</span>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>{durumRozetleri(r)}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 18, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>Toplam ciro</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: r.ciro_onaylandi ? '#22c55e' : 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{toplam > 0 ? `${fmt(toplam)} ₺` : '—'}</div>
                      </div>
                      <div style={{ display: 'flex', gap: 16 }}>
                        {[['Nakit', Number(r.nakit) || 0], ['POS', Number(r.pos) || 0], ['Online', onlineNet]].map(([e, v]) => (
                          <div key={e}>
                            <div style={{ fontSize: 9, color: 'var(--text3)' }}>{e}</div>
                            <div style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v > 0 ? `${fmt(v)} ₺` : '—'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {akisSerit(r)}
                    <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 14, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                      <span>🕐 {saat(r.kapanis_ts) || '—'}</span>
                      <span>👤 {r.kapanis_personel || '—'}</span>
                      {r.gonderen_ad ? <span>📤 {r.gonderen_ad}</span> : null}
                    </div>
                  </div>
                );
              };
              const grid = (arr) => (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(390px, 1fr))', gap: 12 }}>
                  {arr.map(kart)}
                </div>
              );
              const grupBaslik = (txt, renk, sayi) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: renk, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{txt}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {sayi} şube</span>
                </div>
              );
              const aksiyonlar = aktifSatirlar.filter((r) => _oncelik(r) < 3);
              const tamamlar = aktifSatirlar.filter((r) => _oncelik(r) === 3);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {aksiyonlar.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {grupBaslik('Aksiyon bekleyen', '#e85d5d', aksiyonlar.length)}
                      {grid(aksiyonlar)}
                    </div>
                  )}
                  {tamamlar.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {grupBaslik('Tamamlanan', '#22c55e', tamamlar.length)}
                      {grid(tamamlar)}
                    </div>
                  )}
                  {/* Gün toplamı şeridi */}
                  <div style={{ borderTop: '2px solid var(--border)', paddingTop: 12, marginTop: 2 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                    {subeSecili ? `${aktifSatirlar[0]?.sube_adi || 'Şube'} toplamı` : 'Gün toplamı · tüm şubeler'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: 10 }}>
                    {[
                      ['Toplam ciro', topCiro, '#22c55e'],
                      ['Sabah kasa', topSabah, 'var(--text)'],
                      ['Teslim', topTeslim, 'var(--text)'],
                      ['Devir', topDevir, 'var(--text)'],
                      ['Ara teslim', topAraTeslim, 'var(--text)'],
                      ['Gider (N)', topAgider, 'var(--text)'],
                    ].map(([e, v, c]) => (
                      <div key={e} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>{e}</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: c, fontVariantNumeric: 'tabular-nums' }}>{fmt(v)} ₺</div>
                      </div>
                    ))}
                  </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Detaylı tablo (açılır) ── */}
            {satirlar.length > 0 && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--text2)', padding: '6px 2px' }}>📋 Detaylı tablo — tüm sütunlar</summary>
              <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)', marginTop: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      {['Şube', 'Kapanış', 'Saat', 'Kapanış Personeli', 'Ciro Durumu', 'Gönderen', 'Nakit', 'POS', 'Online', 'Toplam', 'Sabah kasa', 'Teslim', 'Devir', 'Ara teslim', 'A.gider (N)', 'Nakit Δ'].map((h, i) => (
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
                      const nakitN = Number(r.nakit) || 0;
                      const posN = Number(r.pos) || 0;
                      const onlineCiftKayit = ktOnlineCift(r);
                      const onlineNet = ktOnlineNet(r);
                      const toplam = ktCiroToplam(r);
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
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {r.nakit > 0 ? <strong>{fmt(r.nakit)} ₺</strong> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* POS */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {r.pos > 0 ? <strong>{fmt(r.pos)} ₺</strong> : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Online — panelde girilmediyse boş; nakit+POS çift kayıt gösterilmez */}
                          <td
                            style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                            title={onlineCiftKayit
                              ? 'Online satış yok; yanlışlıkla nakit+POS toplamı yazılmış — düzeltildi (0).'
                              : 'X raporu: yalnızca online kanal satışı.'}
                          >
                            {onlineNet > 0 ? (
                              <strong>{fmt(onlineNet)} ₺</strong>
                            ) : onlineCiftKayit ? (
                              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                                <span style={{ color: 'var(--text3)' }}>—</span>
                                <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b', maxWidth: 110, textAlign: 'right', lineHeight: 1.2 }}>
                                  Online yok (çift kayıt düzeltildi)
                                </span>
                              </span>
                            ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                          </td>
                          {/* Toplam = nakit + pos + online (çift kayıt düşülmüş) */}
                          <td
                            style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
                            title={`Toplam ciro (Nakit ${fmt(nakitN)} + POS ${fmt(posN)}${onlineNet > 0 ? ` + Online ${fmt(onlineNet)}` : ''})`}
                          >
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
                          {/* Ara teslim (gün içi) */}
                          <td style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {(r.ara_teslim_tl || 0) > 0 ? <span>{fmt(r.ara_teslim_tl)} ₺</span> : <span style={{ color: 'var(--text3)' }}>—</span>}
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
                          {fmt(topAraTeslim)} ₺
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
              </details>
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

      {aktifSekme === 'acilis-kasa-takip' && (() => {
        const akt = acilisKasaTakip;
        const satirlar = Array.isArray(akt?.satirlar) ? akt.satirlar : [];
        const fmt = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });
        const fmtFark = (v) => {
          if (v == null || Number.isNaN(Number(v))) return '—';
          const x = Number(v);
          const s = x.toLocaleString('tr-TR', { maximumFractionDigits: 0 });
          return x > 0 ? `+${s}` : s;
        };
        const saat = (ts, fallback) => {
          if (ts) {
            try { return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }
            catch { /* fall through */ }
          }
          return fallback || '—';
        };
        const farkStil = (sev, fark) => {
          if (fark == null || Math.abs(Number(fark)) <= 0.01) return { color: 'var(--text2)', fontWeight: 600 };
          if (sev === 'kritik' || Math.abs(Number(fark)) >= 200) return { color: '#e85d5d', fontWeight: 800 };
          if (sev === 'uyari' || Math.abs(Number(fark)) >= 50) return { color: '#f59e0b', fontWeight: 800 };
          return { color: 'var(--text2)', fontWeight: 600 };
        };
        const durumHucre = (r) => {
          if (r.acilis_tamam) {
            return (
              <span style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>
                ✓ Açıldı
              </span>
            );
          }
          const d = String(r.acilis_durum || '').toLowerCase();
          if (d === 'gecikti') {
            return (
              <span style={{ background: 'rgba(232,93,93,0.15)', color: '#e85d5d', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>
                ⏳ Gecikiyor
              </span>
            );
          }
          if (d && d !== 'yok') {
            return (
              <span style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>
                Bekliyor
              </span>
            );
          }
          return (
            <span style={{ background: 'rgba(232,93,93,0.12)', color: '#e85d5d', borderRadius: 6, padding: '2px 8px', fontWeight: 700, fontSize: 12 }}>
              Açılmadı
            </span>
          );
        };
        const topAcilis = satirlar.reduce((s, r) => s + (Number(r.acilis_kasa_tl) || 0), 0);
        const topBeklenen = satirlar.reduce((s, r) => s + (Number(r.beklenen_devir_tl) || 0), 0);
        const acilisSayisi = satirlar.filter((r) => r.acilis_tamam).length;
        const bekleyenSayisi = satirlar.length - acilisSayisi;
        const farkSayisi = Number(akt?.fark_uyari_adet || 0);
        const uyumBekleyen = Number(akt?.uyumsuzluk_bekleyen_adet || 0);
        const bugunMu = acilisKasaTakipTarih === isGunuIsoIstanbul();

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>Tarih</span>
                <input
                  type="date"
                  value={acilisKasaTakipTarih}
                  onChange={(e) => setAcilisKasaTakipTarih(e.target.value)}
                  style={{ fontSize: 13, padding: '5px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }}
                />
              </div>
              <button
                onClick={() => yukleAcilisKasaTakip(acilisKasaTakipTarih)}
                disabled={acilisKasaTakipYukleniyor}
                className="btn btn-sm"
                style={{ height: 32 }}
              >
                {acilisKasaTakipYukleniyor ? '⏳' : '🔄'} Yenile
              </button>
              {bugunMu && (
                <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>
                  Her 2 dk otomatik güncellenir
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                <CacheFreshnessBadge
                  guncelleme={acilisKasaTakipSonGuncelleme}
                  kaynak="live"
                  onYenile={() => yukleAcilisKasaTakip(acilisKasaTakipTarih)}
                  yenileniyor={acilisKasaTakipYukleniyor}
                />
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
              Şube panelinde sayımlı açılışta girilen <strong>sabah kasa</strong> tutarları burada listelenir.
              <strong> Beklenen devir</strong> = bir önceki gün ({akt?.dunku_kapanis_tarih || '—'}) kapanışında kasada bırakılan tutar.
              Fark ±50 TL uyarı, ±200 TL kritik. Detaylı çözüm için <strong>Kasa Uyumsuzluğu</strong> sekmesine bakın.
            </p>

            {akt && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
                {[
                  { label: 'Açılış yapan', val: `${acilisSayisi} / ${akt.sube_sayisi}`, color: bekleyenSayisi > 0 ? '#f59e0b' : '#22c55e', bg: bekleyenSayisi > 0 ? 'rgba(245,158,11,0.10)' : 'rgba(34,197,94,0.12)', border: bekleyenSayisi > 0 ? 'rgba(245,158,11,0.35)' : 'rgba(34,197,94,0.4)' },
                  { label: 'Açılmayan', val: bekleyenSayisi > 0 ? `${bekleyenSayisi} şube` : 'Yok', color: bekleyenSayisi > 0 ? '#e85d5d' : '#22c55e', bg: bekleyenSayisi > 0 ? 'rgba(232,93,93,0.10)' : 'rgba(34,197,94,0.07)', border: bekleyenSayisi > 0 ? 'rgba(232,93,93,0.35)' : 'rgba(34,197,94,0.25)' },
                  { label: 'Kasa farkı (≥50₺)', val: farkSayisi > 0 ? `${farkSayisi} şube` : 'Yok', color: farkSayisi > 0 ? '#f59e0b' : 'var(--text3)', bg: farkSayisi > 0 ? 'rgba(245,158,11,0.10)' : 'var(--bg2)', border: farkSayisi > 0 ? 'rgba(245,158,11,0.35)' : 'var(--border)' },
                  { label: 'Uyumsuzluk bekleyen', val: uyumBekleyen > 0 ? `${uyumBekleyen} kayıt` : '—', color: uyumBekleyen > 0 ? '#e85d5d' : 'var(--text3)', bg: uyumBekleyen > 0 ? 'rgba(232,93,93,0.10)' : 'var(--bg2)', border: uyumBekleyen > 0 ? 'rgba(232,93,93,0.35)' : 'var(--border)' },
                ].map((m, i) => (
                  <div key={i} style={{ background: m.bg, border: `1px solid ${m.border}`, borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: m.color }}>{m.val}</div>
                  </div>
                ))}
              </div>
            )}

            {acilisKasaTakipYukleniyor && !akt && (
              <div style={{ textAlign: 'center', padding: 50, color: 'var(--text3)' }}>Yükleniyor...</div>
            )}
            {!acilisKasaTakipYukleniyor && !akt && (
              <div style={{ textAlign: 'center', padding: 50, color: 'var(--text3)' }}>
                Yenile düğmesine basın veya tarih seçin.
              </div>
            )}

            {akt && satirlar.length > 0 && (
              <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid var(--border)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 980 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      {['Şube', 'Durum', 'Saat', 'Sabahçı', 'Dün devir (beklenen)', 'Sayılan kasa', 'Fark', 'Uyumsuzluk'].map((h) => (
                        <th key={h} style={{ padding: '9px 10px', textAlign: h === 'Şube' || h === 'Durum' || h === 'Sabahçı' ? 'left' : 'right', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {satirlar.map((r) => {
                      const fark = r.fark_tl;
                      const rowBg = !r.acilis_tamam
                        ? 'rgba(232,93,93,0.06)'
                        : r.uyumsuzluk_bekliyor
                          ? 'rgba(245,158,11,0.06)'
                          : 'transparent';
                      return (
                        <tr key={r.sube_id} style={{ background: rowBg }}>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            {r.sube_adi || r.sube_id}
                            {r.panel_acilis && (
                              <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text3)', fontWeight: 600 }} title="Şube paneli sayımlı açılış">📱</span>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>{durumHucre(r)}</td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {saat(r.acilis_ts, r.personel_saat)}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)', maxWidth: 140 }}>
                            {r.personel_ad || '—'}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {r.beklenen_devir_tl != null ? (
                              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                                <span>{fmt(r.beklenen_devir_tl)} ₺</span>
                                {r.dunku_kapanis_personel && (
                                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>👤 {r.dunku_kapanis_personel}</span>
                                )}
                              </span>
                            ) : <span style={{ color: 'var(--text3)', fontSize: 12 }}>Dün kapanış yok</span>}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: r.acilis_tamam ? 800 : 400 }}>
                            {r.acilis_kasa_tl != null ? `${fmt(r.acilis_kasa_tl)} ₺` : '—'}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {fark != null ? (
                              <span style={farkStil(r.fark_seviye, fark)}>{fmtFark(fark)} ₺</span>
                            ) : '—'}
                          </td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {r.uyumsuzluk_bekliyor ? (
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ padding: '3px 8px', fontSize: 11, background: 'rgba(232,93,93,0.12)', border: '1px solid rgba(232,93,93,0.35)', color: '#fca5a5' }}
                                onClick={() => acOpsModul('kasa-uyumsuzluk', 'finans-kasa')}
                              >
                                Çözüm bekliyor →
                              </button>
                            ) : r.uyumsuzluk_cozuldu ? (
                              <span style={{ fontSize: 11, color: '#22c55e', fontWeight: 700 }}>✓ Çözüldü</span>
                            ) : (
                              <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: 'var(--bg2)' }}>
                      <td colSpan={4} style={{ padding: '9px 10px', borderTop: '2px solid var(--border)', fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>
                        TOPLAM · {acilisSayisi} açılış
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(topBeklenen)} ₺
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', borderTop: '2px solid var(--border)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(topAcilis)} ₺
                      </td>
                      <td colSpan={2} style={{ padding: '9px 10px', borderTop: '2px solid var(--border)' }} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
              Sıralama: önce açılmayan / bekleyen şubeler, sonra çözüm bekleyen kasa farkları.
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
            <div style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}>
              <CacheFreshnessBadge
                guncelleme={sekmeSonGuncelleme['ciro-onay']}
                kaynak="live"
                onYenile={() => yukleCiroOnayBugun()}
                yenileniyor={ciroOnayBugunYukleniyor}
              />
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

      {aktifSekme === 'acilis-takip' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* ── SEKME ÇUBUĞU ── */}
          <div style={{ display: 'flex', gap: 2, borderBottom: '2px solid var(--border)', marginBottom: 18 }}>
            <button
              type="button"
              onClick={() => setAcilisTakipSekme('canli')}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                background: acilisTakipSekme === 'canli' ? 'rgba(249,115,22,0.12)' : 'transparent',
                borderBottom: acilisTakipSekme === 'canli' ? '2px solid #f97316' : '2px solid transparent',
                color: acilisTakipSekme === 'canli' ? '#fb923c' : 'var(--text3)',
                marginBottom: -2, borderRadius: '6px 6px 0 0', border: 'none',
                borderBottomWidth: 2, borderBottomStyle: 'solid',
                borderBottomColor: acilisTakipSekme === 'canli' ? '#f97316' : 'transparent',
              }}
            >
              📡 Canlı Durum
              {(() => {
                const kz = hubAcKapBucket.saatTr >= 22 || hubAcKapBucket.saatTr < 2;
                const sorun = hubAcKapBucket.acilisGecikti.length + (kz ? hubAcKapBucket.kapanisGecikti.length : 0);
                return sorun > 0 ? (
                  <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center' }}>{sorun}</span>
                ) : <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: 'rgba(74,222,128,0.2)', color: '#4ade80', fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center' }}>✓</span>;
              })()}
            </button>
            <button
              type="button"
              onClick={() => { setAcilisTakipSekme('gec-acilis'); setGecDetaySekme('son7gun'); }}
              style={{
                padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                background: acilisTakipSekme === 'gec-acilis' ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: acilisTakipSekme === 'gec-acilis' ? '#93c5fd' : 'var(--text3)',
                marginBottom: -2, borderRadius: '6px 6px 0 0', border: 'none',
                borderBottomWidth: 2, borderBottomStyle: 'solid',
                borderBottomColor: acilisTakipSekme === 'gec-acilis' ? '#3b82f6' : 'transparent',
              }}
            >
              📅 Geç Açılış
            </button>
            <button
              type="button"
              onClick={() => { setAcilisTakipSekme('plan-kayitsiz'); setPlanDetaySekme('son7gun'); }}
              style={{
                padding: '10px 18px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                background: acilisTakipSekme === 'plan-kayitsiz' ? 'rgba(100,116,139,0.18)' : 'transparent',
                color: acilisTakipSekme === 'plan-kayitsiz' ? '#e2e8f0' : 'var(--text3)',
                marginBottom: -2, borderRadius: '6px 6px 0 0', border: 'none',
                borderBottomWidth: 2, borderBottomStyle: 'solid',
                borderBottomColor: acilisTakipSekme === 'plan-kayitsiz' ? '#64748b' : 'transparent',
              }}
            >
              📋 Plansız Şube
            </button>
          </div>

          {/* ── SEKME: CANLI DURUM ── */}
          {acilisTakipSekme === 'canli' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {hubAcKapBucket.saatTr != null && (
              <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 500 }}>TR {hubAcKapBucket.saatTr}:xx itibarıyla</div>
            )}
            {/* Per-şube açılış kartları — kapanış takip ile aynı tasarım dili */}
            {(() => {
              const gecMap = new Map(hubAcKapBucket.acilisGecikti.map(r => [String(r.sid), r]));
              const gecAcMap = new Map(hubAcKapBucket.acilisGecAcildi.map(r => [String(r.sid), r]));
              const bekSet = new Set(hubAcKapBucket.acilisBekliyor.map(r => String(r.sid)));
              const list = (Array.isArray(kartlar) ? kartlar : []).map((k) => {
                const sid = String(k.sube_id);
                const oz = k.ozet || {};
                let durum, acc;
                if (gecMap.has(sid)) { durum = 'acilmadi'; acc = '#e85d5d'; }
                else if (gecAcMap.has(sid)) { durum = 'gec'; acc = '#f97316'; }
                else if (oz.acilis_tamam) { durum = 'acildi'; acc = '#22c55e'; }
                else { durum = 'bekliyor'; acc = '#94a3b8'; }
                const g = gecMap.get(sid) || gecAcMap.get(sid);
                return { k, sid, durum, acc, gecikme: g?.gecikme_dk, bek: bekSet.has(sid) };
              });
              const ord = { acilmadi: 0, gec: 1, bekliyor: 2, acildi: 3 };
              list.sort((a, b) => (ord[a.durum] - ord[b.durum]) || String(a.k.sube_adi || '').localeCompare(String(b.k.sube_adi || ''), 'tr'));
              if (!list.length) return <div className="empty"><p>Kartlar yükleniyor…</p></div>;
              const rozet = (c) => ({ background: 'var(--bg2)', color: c, border: `1px solid ${c}`, borderRadius: 999, padding: '2px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' });
              const durumRozet = (d) => d === 'acildi' ? <span style={rozet('#22c55e')}>✅ Açıldı</span>
                : d === 'gec' ? <span style={rozet('#f97316')}>🟡 Geç açıldı</span>
                : d === 'acilmadi' ? <span style={rozet('#e85d5d')}>🔴 Açılmadı</span>
                : <span style={rozet('#94a3b8')}>⏳ Bekliyor</span>;
              return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
                  {list.map(({ k, sid, durum, acc, gecikme }) => (
                    <div key={`acd-${sid}`} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `4px solid ${acc}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{k.sube_adi || sid}</span>
                        {durumRozet(durum)}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {k.acilis_saat && <span style={rozet('var(--text2)')}>⏰ {String(k.acilis_saat).slice(0, 5)}</span>}
                        {k.beklenen_acilis_saati && <span style={rozet('var(--text3)')}>plan {k.beklenen_acilis_saati}</span>}
                        {gecikme > 0 && <span style={rozet('#f97316')}>+{Math.round(gecikme)} dk</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {k.acilis_personel_ad
                          ? `👤 ${k.acilis_personel_ad}`
                          : (k.beklenen_acilis_personel ? `👤 plan: ${k.beklenen_acilis_personel}` : '—')}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {(hubAcKapBucket.saatTr >= 22 || hubAcKapBucket.saatTr < 2) && (
              <>
                {hubAcKapBucket.kapanisGecikti.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#f87171', marginBottom: 6 }}>🔴 KAPANIŞ GECİKİYOR ({hubAcKapBucket.kapanisGecikti.length})</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {hubAcKapBucket.kapanisGecikti.map(r => (
                        <div key={`cd-kapgec-${r.sid}`} style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, background: 'rgba(220,38,38,0.18)', border: '1px solid rgba(220,38,38,0.5)', color: '#fca5a5' }}>
                          {r.ad}{r.gecikme_dk ? ` +${Math.round(r.gecikme_dk)}dk` : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {hubAcKapBucket.kapanisBekliyor.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd', marginBottom: 6 }}>🌙 KAPANIŞ BEKLİYOR ({hubAcKapBucket.kapanisBekliyor.length})</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {hubAcKapBucket.kapanisBekliyor.map(r => (
                        <div key={`cd-kapbek-${r.sid}`} style={{ padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.3)', color: '#c4b5fd' }}>
                          {r.ad}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {hubAcKapBucket.subeSayisi === 0 && (
              <div className="empty"><p>Kartlar yükleniyor…</p></div>
            )}
          </div>
          )}

          {/* ── SEKME: GEÇ AÇILIŞ ── */}
          {acilisTakipSekme === 'gec-acilis' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* İç sekme çubuğu */}
          <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 2 }}>
            <button type="button" onClick={() => setGecDetaySekme('son7gun')} style={{
              padding: '7px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer',
              background: gecDetaySekme === 'son7gun' ? 'rgba(59,130,246,0.12)' : 'transparent',
              color: gecDetaySekme === 'son7gun' ? '#93c5fd' : 'var(--text3)',
              marginBottom: -1, borderRadius: '5px 5px 0 0', border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
              borderBottomColor: gecDetaySekme === 'son7gun' ? '#3b82f6' : 'transparent',
            }}>📊 Son 7 Gün Özeti</button>
            <button type="button" onClick={() => setGecDetaySekme('tarih')} style={{
              padding: '7px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer',
              background: gecDetaySekme === 'tarih' ? 'rgba(249,115,22,0.10)' : 'transparent',
              color: gecDetaySekme === 'tarih' ? '#fb923c' : 'var(--text3)',
              marginBottom: -1, borderRadius: '5px 5px 0 0', border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
              borderBottomColor: gecDetaySekme === 'tarih' ? '#f97316' : 'transparent',
            }}>🔍 Tarih Seçerek Detay</button>
          </div>

          {/* İç sekme: Son 7 Gün Özeti */}
          {gecDetaySekme === 'son7gun' && (
          <div className="card" style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg2)' }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span aria-hidden>📊</span>
              Son 7 gün özeti
              {gecAcilanHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500, fontSize: 12 }}>(yükleniyor…)</span> : null}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>— satıra tıklayınca tarih detayına geçer</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gecAcilanHaftaYukleniyor && gecAcilanHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (gecAcilanHaftaSatirlari.length ? gecAcilanHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i),
                gec_toplam: 0, acilmayan_toplam: 0, ozetMetin: '', plan_kayitsiz_toplam: 0, planOzetMetin: '',
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const gec = Number(s.gec_toplam || 0);
                const ac = Number(s.acilmayan_toplam || 0);
                const dikkat = gec > 0 || ac > 0;
                const kritikAc = ac > 0;
                return (
                  <button key={`gec-hafta-${s.tarih}`} type="button" title={s.ozetMetin || undefined}
                    onClick={async () => {
                      setGecAcilanAramaTarih(s.tarih);
                      setGecAcilanAramaYukleniyor(true);
                      setGecDetaySekme('tarih');
                      try {
                        const data = await gecAcilanGunYukle(s.tarih);
                        setGecAcilanAramaSonuc(data);
                        setGecAcilanSeciliSubeKey('all');
                      } catch (e) { toast(e.message || 'Geç açılan şubeler yüklenemedi'); }
                      finally { setGecAcilanAramaYukleniyor(false); }
                    }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6,
                      width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                      border: kritikAc ? '1px solid rgba(220,38,38,0.55)' : gec > 0 ? '1px solid rgba(249,115,22,0.5)' : '1px solid var(--border)',
                      background: kritikAc ? 'rgba(220,38,38,0.1)' : gec > 0 ? 'rgba(249,115,22,0.08)' : 'var(--bg)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: dikkat ? 'var(--text)' : 'var(--text3)' }}>
                        <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                        {s.tarih === bugunStr ? <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span> : null}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {gec > 0 ? <span className="badge badge-yellow" style={{ fontWeight: 700 }}>{gec} geç</span> : <span style={{ fontSize: 11, color: 'var(--text3)' }}>Geç yok</span>}
                        {ac > 0 ? <span className="badge badge-red" style={{ fontWeight: 700 }}>{ac} açılmamış</span> : <span style={{ fontSize: 11, color: 'var(--text3)' }}>Bekleyen yok</span>}
                        <span style={{ fontSize: 11, color: '#60a5fa' }}>Detay →</span>
                      </span>
                    </div>
                    {s.ozetMetin ? <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45, opacity: 0.95 }}>{s.ozetMetin}</div> : null}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* İç sekme: Tarih Seçerek Detay */}
          {gecDetaySekme === 'tarih' && (
          <>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text3)', opacity: 0.88, margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Ne listelenir?</strong>{' '}
            <strong style={{ color: 'var(--text2)' }}>Geç açılan</strong>: o gün operasyon <strong style={{ color: 'var(--text2)' }}>ACILIS</strong> tamamlanmış ama cevap zamanı{' '}
            <strong style={{ color: 'var(--text2)' }}>vardiya planındaki en erken slottan</strong> (varsa) veya yoksa <strong style={{ color: 'var(--text2)' }}>sistem slotundan</strong> sonradır.{' '}
            <strong style={{ color: '#fbbf24' }}>Uyarı</strong>: 1–15 dk gecikme; <strong style={{ color: '#f87171' }}>Kritik</strong>: 15 dk üzeri.{' '}
            <strong style={{ color: 'var(--text2)' }}>Henüz açılmamış</strong>: aynı gün için ACILIS kaydı oluşmuş fakat henüz tamamlanmamış şubeler;
            hiç ACILIS satırı oluşmamış planlı şubeler için <strong style={{ color: 'var(--text2)' }}>«Plansız Şube»</strong> sekmesine geçin.
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

          </>
          )}
          </div>
          )}

          {/* ── SEKME: PLANSIZ ŞUBE ── */}
          {acilisTakipSekme === 'plan-kayitsiz' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* İç sekme çubuğu */}
          <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 2 }}>
            <button type="button" onClick={() => setPlanDetaySekme('son7gun')} style={{
              padding: '7px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer',
              background: planDetaySekme === 'son7gun' ? 'rgba(100,116,139,0.18)' : 'transparent',
              color: planDetaySekme === 'son7gun' ? '#e2e8f0' : 'var(--text3)',
              marginBottom: -1, borderRadius: '5px 5px 0 0', border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
              borderBottomColor: planDetaySekme === 'son7gun' ? '#64748b' : 'transparent',
            }}>📊 Son 7 Gün Özeti</button>
            <button type="button" onClick={() => setPlanDetaySekme('tarih')} style={{
              padding: '7px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer',
              background: planDetaySekme === 'tarih' ? 'rgba(100,116,139,0.14)' : 'transparent',
              color: planDetaySekme === 'tarih' ? '#cbd5e1' : 'var(--text3)',
              marginBottom: -1, borderRadius: '5px 5px 0 0', border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
              borderBottomColor: planDetaySekme === 'tarih' ? '#94a3b8' : 'transparent',
            }}>🔍 Tarih Seçerek Detay</button>
          </div>

          {/* İç sekme: Son 7 Gün Özeti */}
          {planDetaySekme === 'son7gun' && (
          <div className="card" style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid rgba(100,116,139,0.45)', background: 'linear-gradient(165deg, rgba(100,116,139,0.1) 0%, var(--bg2) 55%)' }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span aria-hidden>📊</span>
              Son 7 gün — planlı ama ACILIS yok
              {gecAcilanHaftaYukleniyor ? <span style={{ color: 'var(--text3)', fontWeight: 500, fontSize: 12 }}>(yükleniyor…)</span> : null}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)' }}>— satıra tıklayınca tarih detayına geçer</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gecAcilanHaftaYukleniyor && gecAcilanHaftaSatirlari.length === 0 ? (
                <div className="empty" style={{ padding: '14px 12px' }}><p style={{ margin: 0 }}>Haftalık özet yükleniyor…</p></div>
              ) : (gecAcilanHaftaSatirlari.length ? gecAcilanHaftaSatirlari : Array.from({ length: 7 }, (_, i) => ({
                tarih: isoTariheGunEkle(bugunIsoTarih(), -i), plan_kayitsiz_toplam: 0, planOzetMetin: '',
              }))).map((s) => {
                const bugunStr = bugunIsoTarih();
                const pt = Number(s.plan_kayitsiz_toplam || 0);
                const vurgu = pt > 0;
                return (
                  <button key={`gec-plan-hafta-${s.tarih}`} type="button" title={s.planOzetMetin || undefined}
                    onClick={async () => {
                      setGecAcilanAramaTarih(s.tarih);
                      setGecAcilanAramaYukleniyor(true);
                      setPlanDetaySekme('tarih');
                      try {
                        const data = await gecAcilanGunYukle(s.tarih);
                        setGecAcilanAramaSonuc(data);
                      } catch (e) { toast(e.message || 'Veri yüklenemedi'); }
                      finally { setGecAcilanAramaYukleniyor(false); }
                    }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6,
                      width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                      border: vurgu ? '1px solid rgba(100,116,139,0.65)' : '1px solid var(--border)',
                      background: vurgu ? 'rgba(100,116,139,0.14)' : 'var(--bg)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: vurgu ? 'var(--text)' : 'var(--text3)' }}>
                        <span className="mono" style={{ fontWeight: 700 }}>{s.tarih}</span>
                        {s.tarih === bugunStr ? <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>(bugün)</span> : null}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {pt > 0 ? <span className="badge badge-yellow" style={{ fontWeight: 700, background: 'rgba(100,116,139,0.35)', borderColor: '#94a3b8' }}>{pt} şube</span> : <span style={{ fontSize: 11, color: 'var(--text3)' }}>Kayıt tam</span>}
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>Detay →</span>
                      </span>
                    </div>
                    {s.planOzetMetin ? <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45, opacity: 0.95 }}>{s.planOzetMetin}</div> : null}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* İç sekme: Tarih Seçerek Detay */}
          {planDetaySekme === 'tarih' && (
          <>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text3)', opacity: 0.88, margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--border)' }}>
            <strong style={{ color: 'var(--text2)', fontWeight: 600 }}>Planlı · operasyon kaydı yok nedir?</strong>{' '}
            <strong style={{ color: 'var(--text2)' }}>Aktif</strong> ve <strong style={{ color: 'var(--text2)' }}>vardiya/operasyon takibi açık</strong> (<code style={{ fontSize: 11 }}>vardiya_yazilsin</code>) şubelerde,
            seçilen gün için veritabanında <strong style={{ color: 'var(--text2)' }}>hiç ACILIS event satırı oluşmamış</strong> olanlar listelenir.
            Bu genelde şube panelinin / operasyon motorunun o gün o şube için hiç çalışmadığını gösterir. Geç veya yarım kalmış açılışlar <strong style={{ color: 'var(--text2)' }}>«Geç Açılış»</strong> sekmesindedir.
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
          </>
          )}
          </div>
          )}

        </div>
      )}

      {aktifSekme === 'gec-acan-personel' && (
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
              {gecKalanPersonelAramaYukleniyor ? '...' : 'Ayi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {gecKalanPersonelAramaSonuc?.year_month || gecKalanPersonelAy} · {gecKalanPersonelAramaSonuc?.toplam_personel || 0} personel · {gecKalanPersonelAramaSonuc?.kritik_personel_sayisi || 0} kritik
            </div>
          </div>

          {gecKalanPersonelSatirlari.length === 0 ? (
            <div className="empty"><p>Bu ay gec kalan personel kaydi yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 520, overflow: 'auto' }}>
              {gecKalanPersonelSatirlari.map((p, idx) => {
                const pKey = `${p.personel_id || 'anon'}-${p.personel_ad || ''}-${idx}`;
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
                          Toplam gec kalma: {Number(p?.gecikme_adet || 0)} · Kritik gec kalma: {Number(p?.kritik_gecikme_adet || 0)} · Toplam gecikme: {Number(p?.toplam_gecikme_dk || 0).toFixed(1)} dk · Olay sayisi: {Array.isArray(p?.detaylar) ? p.detaylar.length : 0}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setGecKalanPersonelAcikKey(acik ? '' : pKey)}
                      >
                        {acik ? 'Detayi gizle' : 'Detayi goster'}
                      </button>
                    </div>

                    {acik && (
                      <div style={{ marginTop: 10, overflowX: 'auto' }}>
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: 'var(--bg2)' }}>
                              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Tarih</th>
                              <th style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Sube</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600 }}>Planlanan</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600 }}>Acilis</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700 }}>Gecikme</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detaylar.map((d, di) => (
                              <tr key={d.event_id || `${d.tarih}-${d.sube_id}-${di}`} style={{ borderTop: '1px solid var(--border)' }}>
                                <td className="mono" style={{ padding: '6px 8px' }}>{d.tarih || '-'}</td>
                                <td style={{ padding: '6px 8px' }}>{d.sube_adi || d.sube_id || '-'}</td>
                                <td className="mono" style={{ padding: '6px 8px', textAlign: 'center' }}>{d.planlanan_saat || '-'}</td>
                                <td className="mono" style={{ padding: '6px 8px', textAlign: 'center' }}>{d.acilis_saat || '-'}</td>
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
        const kuGunGit = async (yeniTarih, durumOverride) => {
          setKasaUyumAramaTarih(yeniTarih);
          setKasaUyumAramaYukleniyor(true);
          const durum = durumOverride || kasaUyumDurumFiltre;
          try {
            const data = await kasaUyumGunYukle(yeniTarih, { durum });
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
        const kuDurumDegistir = async (yeniDurum) => {
          setKasaUyumDurumFiltre(yeniDurum);
          await kuGunGit(secilenTarih, yeniDurum);
        };
        const gunToplam = Number(kasaUyumAramaSonuc?.gun_toplam ?? 0);
        const gunBekleyen = Number(kasaUyumAramaSonuc?.gun_bekleyen ?? 0);
        const gunCozuldu = Number(kasaUyumAramaSonuc?.gun_cozuldu ?? 0);
        const tumKayitlar = Array.isArray(kasaUyumAramaSonuc?.kayitlar) ? kasaUyumAramaSonuc.kayitlar : [];

        // İki tip ayrı listeler
        const devirFarkKayitlar = tumKayitlar.filter(u => u.tip === 'ACILIS_KASA_FARK');
        const kasaAcigiKayitlar  = tumKayitlar.filter(u => u.tip === 'KAPANIS_KASA_FARK');

        const haftaRows = kasaUyumHaftaSatirlari.length
          ? kasaUyumHaftaSatirlari
          : Array.from({ length: 7 }, (_, i) => ({ tarih: kuGunEkle(bugunStr, -i), adet: 0, maxAbsFark: 0 }));

        // Seviye renkleri
        const sevRenk = (absFark) => absFark >= 200
          ? { border: 'rgba(220,38,38,0.45)', bg: 'rgba(220,38,38,0.06)', hdr: 'rgba(220,38,38,0.1)', sep: 'rgba(220,38,38,0.2)', badge: 'rgba(220,38,38,0.25)', badgeTxt: '#fca5a5' }
          : absFark >= 50
          ? { border: 'rgba(240,128,64,0.4)', bg: 'rgba(240,128,64,0.04)', hdr: 'rgba(240,128,64,0.09)', sep: 'rgba(240,128,64,0.2)', badge: 'rgba(240,128,64,0.25)', badgeTxt: '#fdba74' }
          : { border: 'rgba(234,179,8,0.35)', bg: 'rgba(234,179,8,0.04)', hdr: 'rgba(234,179,8,0.08)', sep: 'rgba(234,179,8,0.18)', badge: 'rgba(234,179,8,0.25)', badgeTxt: '#fde68a' };

        // Personel satırı
        const PersonelSatir = ({ ad }) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>👤</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: ad ? 'var(--text)' : 'var(--text3)' }}>{ad || '—'}</span>
          </div>
        );

        // #3 Kişi-patern rozeti: tutar küçük olsa da AYNI KİŞİDE tekrar = dikkat
        const PersonelPaternRozet = ({ p }) => {
          if (!p || !p.kronik) return null;
          const yon = p.hep_acik ? ' · hep açık' : '';
          return (
            <span title={`Sorumlu personel son 30 günde ${p.son_30g_adet} kasa farkı (açık ${p.acik_adet} / fazla ${p.fazla_adet})`}
              style={{ background: 'rgba(234,88,12,0.18)', color: '#fdba74', borderRadius: 5, padding: '2px 8px', fontSize: 10, fontWeight: 800 }}>
              ⚠️ Bu kişi: {p.son_30g_adet}× / 30 gün{yon}
            </span>
          );
        };

        // Kronik rozet
        const KronikRozet = ({ adet }) => adet >= 3 ? (
          <span title={`Bu şubede son 7 günde (çözülenler dahil) ${adet} kasa uyarısı`} style={{ background: 'rgba(220,38,38,0.2)', color: '#fca5a5', borderRadius: 5, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
            📈 {adet}× / 7 gün (şube)
          </span>
        ) : null;

        const CozulduRozet = ({ u } = {}) => {
          const duz = u?.cozum_duzeltilen_tl;
          const showDuz = duz != null && Number.isFinite(Number(duz));
          return (
            <span
              style={{
                background: 'rgba(34,197,94,0.2)', color: '#4ade80',
                borderRadius: 5, padding: '1px 8px', fontSize: 10, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
              title={showDuz
                ? `Düzeltilmiş tutar: ${Number(duz).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺ — bundan sonraki hesaplar bu değere göre`
                : 'Orijinal tutar geçerli (düzeltme yapılmadı)'}
            >
              ✓ Çözüldü
              {showDuz && (
                <span style={{ background: 'rgba(34,197,94,0.35)', borderRadius: 4, padding: '0 5px', fontFamily: 'monospace', fontSize: 11 }}>
                  → {Number(duz).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}₺
                </span>
              )}
            </span>
          );
        };

        // Devir farkı kartı — akşamcı ne bıraktı vs sabahçı ne saydı
        const DevirFarkKart = ({ u }) => {
          const fark = Number(u?.fark_tl || 0);
          const absFark = Math.abs(fark);
          const r = sevRenk(absFark);
          const kapTarih = u.kapanis_tarih || kuGunEkle(u.tarih, -1);
          const cozuldu = !!u.cozuldu;
          return (
            <div style={{ borderRadius: 10, border: `1px solid ${r.border}`, background: r.bg, overflow: 'hidden', opacity: cozuldu ? 0.85 : 1 }}>
              {/* Başlık */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderBottom: `1px solid ${r.sep}`, background: r.hdr }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 13 }}>💰 {u.sube_adi || u.sube_id}</span>
                  <span style={{ background: r.badge, color: r.badgeTxt, borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 800, fontFamily: 'monospace' }}>
                    {fark > 0 ? '+' : ''}{fmt(fark)}
                  </span>
                  <KronikRozet adet={u.son_7g_adet} />
                  <PersonelPaternRozet p={u.personel_patern} />
                  {cozuldu ? <CozulduRozet u={u} /> : (
                    <span style={{ fontSize: 10, color: 'var(--text3)', padding: '1px 7px', border: '1px solid var(--border)', borderRadius: 4 }}>
                      Devir uyumsuzluğu — çözüm bekliyor
                    </span>
                  )}
                </div>
                {!cozuldu && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#86efac', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Kaynağı değiştirmeden güncel veriyle yeniden hesapla — donmuş/bayat dökümü tazeler"
                      onClick={() => kkYenidenHesapla(u.id)}>
                      {onayBusyId === `kuyh:${u.id}` ? '…' : '🔄 Yeniden Hesapla'}
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Sebebi bul, kaynağı düzelt, fark otomatik yeniden hesaplanır"
                      onClick={() => kkDuzeltModalAc(u)}>
                      🔧 Kaynağı Düzelt
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#c4b5fd', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Yapılan düzeltme tarihçesi - Geri Al seçeneği"
                      onClick={() => kkTarihceModalAc(u)}>
                      📜 Tarihçe
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 12px', background: 'rgba(74,158,255,0.15)', border: '1px solid rgba(74,158,255,0.4)', color: '#93c5fd', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId}
                      onClick={() => kasaUyumsuzlukCoz(u.id, u.fark_tl)}>
                      {onayBusyId === `ku:${u.id}` ? '…' : 'Çözüldü işaretle'}
                    </button>
                  </div>
                )}
              </div>
              {/* İki kutu */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                <div style={{ padding: '12px 14px', borderRight: `1px solid ${r.sep}` }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                    Akşamcı — bıraktığı devir
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>{kapTarih} kapanış</div>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{fmt(u.beklenen_tl ?? 0)}</div>
                  <PersonelSatir ad={u.kapanis_personel_ad} />
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>
                    Sabahçı — saydığı kasa
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>{u.tarih} açılış</div>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{fmt(u.gercek_tl ?? 0)}</div>
                  <PersonelSatir ad={u.acilis_personel_ad} />
                </div>
              </div>
            </div>
          );
        };

        // Kasa açığı kartı — mutabakat formülü: açılış + Z nakit − gider − teslim − devir = 0
        const KasaAcigiKart = ({ u }) => {
          const cozuldu = !!u.cozuldu;
          const fark = Number(u?.fark_tl || 0);
          const absFark = Math.abs(fark);
          const r = sevRenk(absFark);
          const d = u.detay_json || {};
          const acilisKasa   = Number(d.acilis_kasa    ?? 0);
          const zNakit       = Number(d.z_nakit        ?? 0);
          const nakitGider   = Number(d.nakit_giderler ?? 0);
          const araTeslim    = Number(d.ara_teslim     ?? 0);
          const teslim       = Number(d.teslim         ?? 0);
          const devir        = Number(d.devir          ?? 0);
          const hasDetay     = !!u.detay_json;

          // "TALHA TOPAL" -> "Talha T." formatına çevir (ad + soyad ilk harfi)
          const kisaAd = (tamAd) => {
            if (!tamAd) return null;
            const parts = String(tamAd).trim().split(/\s+/);
            if (parts.length === 1) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
            const ad = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
            const soyadHarf = parts[parts.length - 1].charAt(0).toUpperCase();
            return `${ad} ${soyadHarf}.`;
          };

          const KutuLabel = ({ txt }) => (
            <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>{txt}</div>
          );
          const KutuTutar = ({ val, renk }) => (
            <div style={{ fontSize: 19, fontWeight: 800, fontFamily: 'monospace', color: renk || 'inherit' }}>{fmt(val)}</div>
          );
          const KutuPersonel = ({ ad }) => ad ? (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, fontStyle: 'italic' }}
                 title={`Bu değeri giren: ${ad}`}>
              👤 {kisaAd(ad)}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, fontStyle: 'italic', opacity: 0.5 }}>
              👤 —
            </div>
          );
          const Kutu = ({ label, val, renk, sep, personel }) => (
            <div style={{ padding: '10px 12px', borderRight: sep ? `1px solid ${r.sep}` : 'none' }}>
              <KutuLabel txt={label} />
              <KutuTutar val={val} renk={renk} />
              <KutuPersonel ad={personel} />
            </div>
          );

          return (
            <div style={{ borderRadius: 10, border: `1px solid ${r.border}`, background: r.bg, overflow: 'hidden', opacity: cozuldu ? 0.85 : 1 }}>
              {/* Başlık */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderBottom: `1px solid ${r.sep}`, background: r.hdr }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 13 }}>🔍 {u.sube_adi || u.sube_id}</span>
                  <span style={{ background: r.badge, color: r.badgeTxt, borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 800, fontFamily: 'monospace' }}>
                    {fark > 0 ? '+' : ''}{fmt(fark)}
                  </span>
                  <KronikRozet adet={u.son_7g_adet} />
                  <PersonelPaternRozet p={u.personel_patern} />
                  {cozuldu ? <CozulduRozet u={u} /> : (
                    <span style={{ fontSize: 10, color: 'var(--text3)', padding: '1px 7px', border: '1px solid var(--border)', borderRadius: 4 }}>
                      Kasa mutabakat farkı — çözüm bekliyor
                    </span>
                  )}
                </div>
                {!cozuldu && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#86efac', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Kaynağı değiştirmeden güncel veriyle yeniden hesapla — donmuş/bayat dökümü tazeler"
                      onClick={() => kkYenidenHesapla(u.id)}>
                      {onayBusyId === `kuyh:${u.id}` ? '…' : '🔄 Yeniden Hesapla'}
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Sebebi bul, kaynağı düzelt, fark otomatik yeniden hesaplanır"
                      onClick={() => kkDuzeltModalAc(u)}>
                      🔧 Kaynağı Düzelt
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 10px', background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.4)', color: '#c4b5fd', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId || kkDuzeltBusy}
                      title="Yapılan düzeltme tarihçesi - Geri Al seçeneği"
                      onClick={() => kkTarihceModalAc(u)}>
                      📜 Tarihçe
                    </button>
                    <button type="button" className="btn btn-sm"
                      style={{ padding: '4px 12px', background: 'rgba(74,158,255,0.15)', border: '1px solid rgba(74,158,255,0.4)', color: '#93c5fd', fontWeight: 600, fontSize: 12 }}
                      disabled={!!onayBusyId}
                      onClick={() => kasaUyumsuzlukCoz(u.id, u.fark_tl)}>
                      {onayBusyId === `ku:${u.id}` ? '…' : 'Çözüldü işaretle'}
                    </button>
                  </div>
                )}
              </div>

              {hasDetay ? (
                <>
                  {/* Formül satırı: Açılış + Z Nakit − Gider − Teslim − Devir = Fark */}
                  <div style={{ padding: '8px 14px 4px', fontSize: 10, color: 'var(--text3)', borderBottom: `1px solid ${r.sep}` }}>
                    <span style={{ fontFamily: 'monospace', letterSpacing: '0.03em' }}>
                      Açılış Kasası + Z Nakit − Nakit Gider{araTeslim > 0 ? ' − Ara Teslim' : ''} − Teslim − Devir = 0 (beklenen)
                    </span>
                  </div>
                  {/* 5 kutu grid — her tutarın yanında veriyi giren personel */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', borderBottom: `1px solid ${r.sep}` }}>
                    <Kutu label="Açılış Kasası" val={acilisKasa} renk="#86efac" sep
                          personel={u.acilis_personel_ad} />
                    <Kutu label="Z Nakit Ciro"  val={zNakit}    renk="#86efac" sep
                          personel={u.kapanis_personel_ad} />
                    <Kutu label={`Nakit Gider${araTeslim > 0 ? ' + Ara Teslim' : ''}`}
                               val={nakitGider + araTeslim} renk="#fca5a5" sep />
                    <Kutu label="Müdüre Teslim" val={teslim}    renk="#fca5a5" sep
                          personel={u.kapanis_personel_ad} />
                    <Kutu label="Kasada Devir"  val={devir}     renk="#fca5a5"
                          personel={u.kapanis_personel_ad} />
                  </div>
                  {/* Sonuç satırı */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', padding: '10px 14px', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>
                        Fark (0 olmalıydı)
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: fark > 0 ? '#fca5a5' : fark < 0 ? '#86efac' : 'var(--text2)' }}>
                        {fark > 0 ? '+' : ''}{fmt(fark)}
                      </div>
                      {Math.abs(fark) > 0.5 && (
                        <div style={{ fontSize: 10, fontWeight: 700, marginTop: 4, color: fark > 0 ? '#fca5a5' : '#86efac' }}>
                          {fark > 0 ? 'Kasa açığı (+ eksik nakit)' : 'Kasa fazlası (− fazla nakit)'}
                        </div>
                      )}
                    </div>
                    <PersonelSatir ad={u.kapanis_personel_ad} />
                  </div>
                </>
              ) : (
                /* Eski format (detay_json yoksa) */
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                  <div style={{ padding: '12px 14px', borderRight: `1px solid ${r.sep}` }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Sistem beklentisi</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>kasa_sayım − teslim − ara teslimler</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{fmt(u.beklenen_tl ?? 0)}</div>
                  </div>
                  <div style={{ padding: '12px 14px' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>Kasiyerin beyanı</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>{u.tarih} kapanış</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace' }}>{fmt(u.gercek_tl ?? 0)}</div>
                    <PersonelSatir ad={u.kapanis_personel_ad} />
                  </div>
                </div>
              )}
            </div>
          );
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* ── NAVİGASYON ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
              <button type="button" className="btn btn-sm" style={{ padding: '5px 10px', fontSize: 16, lineHeight: 1 }}
                onClick={() => kuGunGit(kuGunEkle(secilenTarih, -1))}>‹</button>
              <input type="date" className="input" value={secilenTarih}
                style={{ fontSize: 13, padding: '5px 9px', flex: '0 0 auto' }}
                onChange={(e) => e.target.value && kuGunGit(e.target.value)} />
              <button type="button" className="btn btn-sm" style={{ padding: '5px 10px', fontSize: 16, lineHeight: 1 }}
                disabled={secilenTarih >= bugunStr}
                onClick={() => kuGunGit(kuGunEkle(secilenTarih, 1))}>›</button>
              {secilenTarih !== bugunStr && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => kuGunGit(bugunStr)}>Bugün</button>
              )}
              <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 4 }}>
                {kasaUyumAramaYukleniyor
                  ? '⏳ yükleniyor…'
                  : `Gösterilen: ${tumKayitlar.length} · Gün toplamı: ${gunToplam} (${gunBekleyen} bekleyen, ${gunCozuldu} çözüldü)`}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {devirFarkKayitlar.length > 0 && <span className="badge" style={{ background: 'rgba(240,128,64,0.2)', color: '#fdba74', fontWeight: 700 }}>💰 {devirFarkKayitlar.length} devir farkı</span>}
                {kasaAcigiKayitlar.length > 0  && <span className="badge" style={{ background: 'rgba(74,158,255,0.15)', color: '#93c5fd', fontWeight: 700 }}>🔍 {kasaAcigiKayitlar.length} kasa açığı</span>}
                {gunToplam === 0 && !kasaUyumAramaYukleniyor && <span style={{ fontSize: 12, color: '#4ade80', fontWeight: 600 }}>✓ Bu gün sorun yok</span>}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={tumKayitlar.length === 0}
                  onClick={() => listeyiCsvIndir(
                    tumKayitlar,
                    [
                      { key: 'tarih', baslik: 'Tarih', fn: (u) => (u.tarih || '').substring(0, 10) },
                      { key: 'sube', baslik: 'Şube', fn: (u) => u.sube_adi || u.sube_id },
                      { key: 'tip', baslik: 'Tip', fn: (u) => u.tip === 'ACILIS_KASA_FARK' ? 'Devir Farkı' : 'Kasa Açığı' },
                      { key: 'fark_tl', baslik: 'Fark (TL)' },
                      { key: 'beklenen_tl', baslik: 'Beklenen (TL)' },
                      { key: 'gercek_tl', baslik: 'Gerçek (TL)' },
                      { key: 'cozuldu', baslik: 'Durum', fn: (u) => u.cozuldu ? 'Çözüldü' : 'Bekliyor' },
                    ],
                    `kasa_uyumsuzluk_${secilenTarih}`
                  )}
                >
                  ⬇️ CSV
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {[
                { id: 'all', label: `Tümü (${gunToplam})` },
                { id: 'bekleyen', label: `Çözüm bekleyen (${gunBekleyen})` },
                { id: 'cozuldu', label: `Çözüldü (${gunCozuldu})` },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => kuDurumDegistir(f.id)}
                  style={{
                    padding: '4px 12px',
                    fontWeight: kasaUyumDurumFiltre === f.id ? 700 : 500,
                    border: kasaUyumDurumFiltre === f.id ? '1px solid #4a9eff' : '1px solid var(--border)',
                    background: kasaUyumDurumFiltre === f.id ? 'rgba(74,158,255,0.15)' : 'var(--bg2)',
                    color: kasaUyumDurumFiltre === f.id ? '#93c5fd' : 'var(--text2)',
                  }}
                >
                  {f.label}
                </button>
              ))}
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>Çözülen kayıtlar listeden silinmez.</span>
            </div>

            {!kasaUyumAramaYukleniyor && tumKayitlar.length === 0 && gunToplam > 0 && (
              <div style={{ padding: '16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, color: 'var(--text3)', textAlign: 'center' }}>
                Bu filtrede kayıt yok.
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 8 }} onClick={() => kuDurumDegistir('all')}>Tümünü göster</button>
              </div>
            )}
            {!kasaUyumAramaYukleniyor && gunToplam === 0 && (
              <div style={{ padding: '20px 16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 13, color: '#4ade80', fontWeight: 600, textAlign: 'center' }}>
                ✓ Bu gün kasa farkı veya devir uyumsuzluğu yok
              </div>
            )}

            {/* ── DEVİR UYUMSUZLUĞU — sadece kayıt varsa göster ── */}
            {devirFarkKayitlar.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#fdba74', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    💰 Devir Uyumsuzluğu
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>Akşamcının bıraktığı ≠ Sabahçının saydığı — nedeni açıklanmalı</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{devirFarkKayitlar.length} kayıt</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {devirFarkKayitlar.map(u => <DevirFarkKart key={u.id} u={u} />)}
                </div>
              </div>
            )}

            {/* ── KASA AÇIĞI — sadece kayıt varsa göster ── */}
            {kasaAcigiKayitlar.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#93c5fd', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    🔍 Kasa Açığı
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>Kasiyerin beyanı ≠ Sistem beklentisi — takip et, kronikleşirse harekete geç</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{kasaAcigiKayitlar.length} kayıt</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {kasaAcigiKayitlar.map(u => <KasaAcigiKart key={u.id} u={u} />)}
                </div>
              </div>
            )}

            {/* ── Tip bilgisi gelmeyen kayıtlar (fallback) ── */}
            {!kasaUyumAramaYukleniyor && tumKayitlar.length > 0 && devirFarkKayitlar.length === 0 && kasaAcigiKayitlar.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tumKayitlar.map(u => <DevirFarkKart key={u.id} u={u} />)}
              </div>
            )}

            {/* ── SON 7 GÜN ── */}
            <div style={{ marginTop: 4, padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10 }}>
                Son 7 gün {kasaUyumHaftaYukleniyor && <span style={{ fontWeight: 400, color: 'var(--text3)' }}>yükleniyor…</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                {haftaRows.slice(0, 7).reverse().map((s) => {
                  const secili = s.tarih === secilenTarih;
                  const bugun2 = s.tarih === bugunStr;
                  const dikkat = s.adet > 0;
                  const kritik = dikkat && s.maxAbsFark >= 200;
                  return (
                    <button key={`ku7-${s.tarih}`} type="button" onClick={() => kuGunGit(s.tarih)}
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
                      <span style={{ fontSize: 11, fontWeight: 700, color: secili ? '#93c5fd' : bugun2 ? 'var(--text)' : 'var(--text2)', fontFamily: 'monospace' }}>
                        {s.tarih.slice(8)}
                      </span>
                      <span style={{ marginTop: 4, fontSize: 13 }}>{kritik ? '🔴' : dikkat ? '🟡' : '✓'}</span>
                      {dikkat && (
                        <span style={{ fontSize: 9, color: kritik ? '#fca5a5' : '#fde68a', fontWeight: 700, marginTop: 1 }}>
                          {s.adet} kayıt{s.bekleyenAdet != null && s.bekleyenAdet < s.adet ? ` (${s.bekleyenAdet} açık)` : ''}
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

      {aktifSekme === 'kasa-personel-takip' && (() => {
        const takipList = kasaAcikAnaliz?.takip_listesi || [];
        const acikList  = kasaAcikAnaliz?.acik_listesi  || [];
        const durumCfg = {
          kritik:       { renk: '#fca5a5', bg: 'rgba(220,38,38,0.15)',  border: 'rgba(220,38,38,0.4)',  etiket: '🔴 Kritik',        aciklama: '4+ açık / ay veya tek >200₺ → resmi inceleme' },
          aksiyona_gec: { renk: '#fdba74', bg: 'rgba(240,128,64,0.12)', border: 'rgba(240,128,64,0.4)', etiket: '🟠 Harekete Geç',  aciklama: '3+ açık / ay veya >150₺ tek açık' },
          izleme:       { renk: '#fde68a', bg: 'rgba(234,179,8,0.1)',   border: 'rgba(234,179,8,0.35)', etiket: '🟡 İzleme',        aciklama: '2+ kez >50₺ açık / 30 gün' },
        };
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ── AÇIKLAMA BAŞLIĞI ── */}
            <div style={{ padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--text3)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--text2)' }}>Personel Kasa Takibi</strong> — Son 30 günde kapanış kör sayımında
              {' '}<strong style={{ color: '#fde68a' }}>2'den fazla kez 50₺+ açık</strong> veren kasiyerler otomatik takip listesine düşer.
              Durum seviyesi <strong style={{ color: '#fdba74' }}>harekete geç</strong>'e ulaşırsa birebir görüşme,
              {' '}<strong style={{ color: '#fca5a5' }}>kritik</strong>'te resmi inceleme protokolü devreye girer. <em style={{ fontSize: 11 }}>(NRF / McDonald's / Starbucks Cash Accountability standardı)</em>
            </div>

            {/* ── KASİYER KARNESİ (özensizlik ≠ şüphe) ── */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <span style={{ fontSize: 14, fontWeight: 800 }}>🪪 Kasiyer Karnesi</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Son 30 gün · özensizlik ≠ hırsızlık ayrımı</span>
              </div>
              {kasiyerKarne.length === 0 ? (
                <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 13, color: '#4ade80', fontWeight: 600 }}>
                  ✓ Son 30 günde kasa sinyali olan kasiyer yok
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12 }}>
                  {kasiyerKarne.map((k, i) => {
                    const renk = k.profil === 'incele' ? '#fca5a5' : k.profil === 'izle' ? '#fde68a' : k.profil === 'disiplin' ? '#fdba74' : '#4ade80';
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, borderLeft: `4px solid ${renk}` }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{k.personel_emoji || k.profil_emoji} {k.personel_ad}</div>
                          <div style={{ fontSize: 11, color: renk, fontWeight: 600 }}>{k.profil_metin}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {k.gercek_acik > 0 && <span style={{ fontSize: 11, background: 'rgba(220,38,38,0.18)', color: '#fca5a5', borderRadius: 100, padding: '2px 9px', fontWeight: 700 }}>🔴 gerçek açık {k.gercek_acik}</span>}
                          {k.ham_kasa_fark > 0 && <span style={{ fontSize: 11, background: 'rgba(234,179,8,0.15)', color: '#fde68a', borderRadius: 100, padding: '2px 9px', fontWeight: 700 }}>🟡 çözülmemiş fark {k.ham_kasa_fark}</span>}
                          {k.ozensizlik > 0 && <span style={{ fontSize: 11, background: 'rgba(240,128,64,0.15)', color: '#fdba74', borderRadius: 100, padding: '2px 9px', fontWeight: 700 }}>🟠 özensizlik {k.ozensizlik}</span>}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                    🟠 Özensizlik = düzeltilince fark 0 (dürüst ama dikkatsiz) · 🔴 Gerçek açık = onaylanmış kayıp · 🟡 = henüz çözülmemiş kasa farkı. Özensizlik şüphe/hırsızlık paternine SAYILMAZ.
                  </div>
                </div>
              )}
            </div>

            {/* ── PERSONEL TAKİP TABLOSU ── */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <span style={{ fontSize: 14, fontWeight: 800 }}>👥 Personel Takip Listesi</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Son 30 gün</span>
                {kasaAcikAnalizYukleniyor && <span style={{ fontSize: 11, color: 'var(--text3)' }}>⏳ yükleniyor…</span>}
                {takipList.some(p => p.durum === 'kritik') && (
                  <span style={{ marginLeft: 'auto', background: 'rgba(220,38,38,0.2)', color: '#fca5a5', borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>
                    🔴 {takipList.filter(p => p.durum === 'kritik').length} KRİTİK
                  </span>
                )}
              </div>

              {takipList.length === 0 ? (
                <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: '#4ade80', fontWeight: 600 }}>
                  ✓ Son 30 günde takip gerektiren kasiyer yok
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)', background: 'var(--bg)' }}>
                        {[['Personel', 'left'], ['Şube', 'left'], ['50₺+ açık', 'center'], ['Toplam açık', 'right'], ['En yüksek', 'right'], ['Son', 'center'], ['Durum', 'center']].map(([h, a]) => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: a, fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {takipList.map((p, i) => {
                        const cfg = durumCfg[p.durum] || durumCfg.izleme;
                        return (
                          <tr key={`pt-${p.personel_id || i}`} style={{ borderBottom: '1px solid var(--border)', background: cfg.bg }}>
                            <td style={{ padding: '10px 12px', fontWeight: 700 }}>{p.personel_ad}</td>
                            <td style={{ padding: '10px 12px', color: 'var(--text2)' }}>{p.sube_adi}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 800, fontSize: 16, fontFamily: 'monospace', color: cfg.renk }}>{p.elli_ustu_adet}×</td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--text2)' }}>{fmt(p.toplam_abs_fark)}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--text2)' }}>{fmt(p.max_tek_fark)}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'center', fontSize: 11, color: 'var(--text3)', fontFamily: 'monospace' }}>{p.son_tarih?.slice(5)}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                              <span title={cfg.aciklama} style={{ background: 'rgba(0,0,0,0.2)', color: cfg.renk, border: `1px solid ${cfg.border}`, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'help', whiteSpace: 'nowrap' }}>
                                {cfg.etiket}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {/* Eşik kılavuzu */}
                  <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                    {Object.entries(durumCfg).map(([k, v]) => (
                      <span key={k} style={{ fontSize: 10, color: 'var(--text3)' }}>
                        {v.etiket}: <span style={{ color: v.renk }}>{v.aciklama}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── KASA AÇIKLARI LOGU ── */}
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                <span style={{ fontSize: 14, fontWeight: 800 }}>📋 Kasa Açıkları Logu</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Son 30 gün · 20₺ üstü tüm kayıtlar</span>
                {acikList.length > 0 && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>{acikList.length} kayıt</span>}
              </div>
              {acikList.length === 0 ? (
                <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: '#4ade80', fontWeight: 600 }}>
                  ✓ Son 30 günde 20₺+ kasa açığı kaydı yok
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)', background: 'var(--bg)' }}>
                        {[['Tarih','left'],['Şube','left'],['Kasiyer','left'],['Sistem beklentisi','right'],['Kasiyer beyanı','right'],['Açık','right'],['Seviye','center']].map(([h,a]) => (
                          <th key={h} style={{ padding: '7px 10px', textAlign: a, fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {acikList.map((a, i) => {
                        const abs = Math.abs(Number(a.fark_tl || 0));
                        const renkTxt = abs >= 200 ? '#fca5a5' : abs >= 50 ? '#fdba74' : '#fde68a';
                        const sevBg = abs >= 200 ? 'rgba(220,38,38,0.15)' : abs >= 50 ? 'rgba(240,128,64,0.15)' : 'rgba(234,179,8,0.12)';
                        return (
                          <tr key={`al-${a.id||i}`} style={{ borderBottom: '1px solid var(--border)', background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                            <td style={{ padding: '7px 10px', color: 'var(--text3)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{a.tarih}</td>
                            <td style={{ padding: '7px 10px', fontWeight: 600 }}>{a.sube_adi}</td>
                            <td style={{ padding: '7px 10px' }}>{a.personel_ad}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--text3)' }}>{fmt(a.beklenen_tl ?? 0)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', color: 'var(--text2)' }}>{fmt(a.gercek_tl ?? 0)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, color: renkTxt }}>{Number(a.fark_tl)>0?'+':''}{fmt(a.fark_tl ?? 0)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'center' }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: renkTxt, background: sevBg, borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                                {abs >= 200 ? '🔴 Kritik' : abs >= 50 ? '🟠 Uyarı' : '🟡 Normal'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        );
      })()}

      {['food-cost-ozet', 'alis-fiyatlari', 'recete', 'shrinkage'].includes(aktifSekme) && (() => {
        const durum = maliyetOzet?.altyapi_durum || {};
        const benchmark = maliyetOzet?.benchmark || {};
        const gunSatirlari = maliyetOzet?.gun_satirlari || [];
        const stokDegeri = maliyetOzet?.stok_degeri_tl || 0;
        const alisCount = maliyetOzet?.alis_fiyat_sayisi || 0;
        const receteCount = maliyetOzet?.recete_sayisi || 0;
        const eksikler = durum?.eksikler || [];

        // Hesaplanmış metrikler
        const avgFoodCost = gunSatirlari.length > 0
          ? gunSatirlari.filter(r => r.food_cost_pct).reduce((s, r) => s + Number(r.food_cost_pct || 0), 0) / gunSatirlari.filter(r => r.food_cost_pct).length
          : null;
        const avgShrinkage = gunSatirlari.length > 0
          ? gunSatirlari.filter(r => r.shrinkage_pct).reduce((s, r) => s + Number(r.shrinkage_pct || 0), 0) / gunSatirlari.filter(r => r.shrinkage_pct).length
          : null;

        const fcRenk = avgFoodCost == null ? 'var(--text3)'
          : avgFoodCost > benchmark.food_cost_max_pct ? '#ef4444'
          : avgFoodCost < benchmark.food_cost_min_pct ? '#f59e0b'
          : '#22c55e';

        const shrinkRenk = avgShrinkage == null ? 'var(--text3)'
          : avgShrinkage > benchmark.shrinkage_sorusturma_pct ? '#ef4444'
          : avgShrinkage > benchmark.shrinkage_izleme_pct ? '#f97316'
          : '#22c55e';

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Başlık + açıklama */}
            <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(22,163,74,.08)', border: '1px solid rgba(22,163,74,.25)', fontSize: 12, color: 'var(--text2)', lineHeight: 1.6 }}>
              <strong style={{ display: 'block', fontSize: 13, marginBottom: 4, color: '#16a34a' }}>💰 Maliyet & Food Cost — CFO İzleme Merkezi</strong>
              Kahve zinciri CFO standardı: <strong>Food Cost % = Tüketim TL / Ciro TL</strong>.
              Benchmark <strong>%{benchmark.food_cost_min_pct}–{benchmark.food_cost_max_pct}</strong> arası sağlıklı.
              Alış fiyatları ve reçete tanımlandıkça bu kart otomatik dolar.
            </div>

            {/* Altyapı durum banner */}
            {eksikler.length > 0 && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.3)', fontSize: 12 }}>
                <strong style={{ color: '#b45309' }}>⚙️ Altyapı hazır — şu adımlar tamamlandıkça hesaplamalar aktif olur:</strong>
                <ul style={{ margin: '6px 0 0 16px', padding: 0, color: 'var(--text2)' }}>
                  {eksikler.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {/* 4 ana metrik kartı */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {[
                {
                  baslik: 'Food Cost %',
                  deger: avgFoodCost != null ? `%${avgFoodCost.toFixed(1)}` : '—',
                  alt: avgFoodCost != null ? `Benchmark %${benchmark.food_cost_min_pct}–${benchmark.food_cost_max_pct}` : 'Alış fiyatı ve reçete gerekli',
                  renk: fcRenk, ikon: '🍽',
                },
                {
                  baslik: 'Canlı Stok Değeri',
                  deger: stokDegeri > 0 ? `₺${Number(stokDegeri).toLocaleString('tr-TR', { maximumFractionDigits: 0 })}` : '—',
                  alt: stokDegeri > 0 ? `${maliyetOzet?.stok_kalem_sayisi || 0} kalem` : 'Alış fiyatı girilmeli',
                  renk: stokDegeri > 0 ? '#16a34a' : 'var(--text3)', ikon: '📦',
                },
                {
                  baslik: 'Shrinkage %',
                  deger: avgShrinkage != null ? `%${avgShrinkage.toFixed(2)}` : '—',
                  alt: avgShrinkage != null ? (avgShrinkage > benchmark.shrinkage_sorusturma_pct ? '⚠️ Soruştur' : avgShrinkage > benchmark.shrinkage_izleme_pct ? '👁 İzle' : '✓ Normal') : 'Hesaplanmadı',
                  renk: shrinkRenk, ikon: '📉',
                },
                {
                  baslik: 'Tanımlı Reçete',
                  deger: receteCount > 0 ? `${receteCount} ürün` : '—',
                  alt: alisCount > 0 ? `${alisCount} fiyat tanımlı` : 'Fiyat girilmeli',
                  renk: receteCount > 0 ? '#16a34a' : 'var(--text3)', ikon: '📐',
                },
              ].map((m, i) => (
                <div key={i} style={{ padding: '14px 16px', borderRadius: 10, border: `1px solid ${m.renk}30`, background: `${m.renk}08` }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>{m.ikon} {m.baslik}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: m.renk, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{m.deger}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5 }}>{m.alt}</div>
                </div>
              ))}
            </div>

            {/* Benchmark referans şeridi */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { label: 'Food Cost %28–35', aciklama: 'Sağlıklı aralık', renk: '#22c55e' },
                { label: 'FC >%35', aciklama: 'Maliyet soruştur', renk: '#f97316' },
                { label: 'Shrinkage <%2', aciklama: 'Normal kayıp', renk: '#22c55e' },
                { label: 'Shrinkage %2–5', aciklama: 'İzle', renk: '#f97316' },
                { label: 'Shrinkage >%5', aciklama: 'Soruştur', renk: '#ef4444' },
              ].map((b, i) => (
                <div key={i} style={{ padding: '4px 10px', borderRadius: 20, border: `1px solid ${b.renk}40`, background: `${b.renk}10`, fontSize: 11 }}>
                  <span style={{ fontWeight: 700, color: b.renk }}>{b.label}</span>
                  <span style={{ color: 'var(--text3)', marginLeft: 4 }}>→ {b.aciklama}</span>
                </div>
              ))}
            </div>

            {/* Sekme içerikleri */}
            {aktifSekme === 'food-cost-ozet' && (() => {
              const hesaplaGunluk = () => {
                setFoodCostHesaplaYukleniyor(true);
                setFoodCostHesaplaSonuc(null);
                api('/ops/maliyet/food-cost-hesapla', {
                  method: 'POST',
                  body: JSON.stringify({ tarih: foodCostHesaplaTarih }),
                })
                  .then(d => {
                    setFoodCostHesaplaSonuc(d);
                    toast(`✅ ${d.hesaplanan_satir} şube hesaplandı`);
                    // Özet kartlarını yenile
                    return Promise.all([
                      api(`/ops/maliyet/ozet?gun=${maliyetGun}`),
                      api('/ops/maliyet/alis-fiyatlari'),
                      api('/ops/maliyet/recete-listesi'),
                    ]);
                  })
                  .then(([ozet, fiyatlar, rec]) => {
                    if (ozet) setMaliyetOzet(ozet);
                    if (fiyatlar) setAlisFiyatlari(fiyatlar?.satirlar || []);
                    if (rec) setReceteler(rec?.receteler || []);
                  })
                  .catch(e => toast(e.message || 'Hesaplama hatası'))
                  .finally(() => setFoodCostHesaplaYukleniyor(false));
              };

              // Tabloda gösterilecek kayıtlar: hesaplama sonucu varsa onu, yoksa DB geçmişi
              const gosterilecekler = foodCostHesaplaSonuc?.satirlar?.length
                ? foodCostHesaplaSonuc.satirlar
                : gunSatirlari;
              const kaynakHesaplama = !!foodCostHesaplaSonuc?.satirlar?.length;

              return (
                <div>
                  {/* Hesaplama Paneli */}
                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 10, color: '#16a34a' }}>🔄 Manuel Hesaplama</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Tarih</div>
                        <input
                          type="date"
                          value={foodCostHesaplaTarih}
                          onChange={e => setFoodCostHesaplaTarih(e.target.value)}
                          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }}
                        />
                      </div>
                      <button
                        disabled={foodCostHesaplaYukleniyor}
                        onClick={hesaplaGunluk}
                        style={{ padding: '7px 18px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', opacity: foodCostHesaplaYukleniyor ? .6 : 1 }}
                      >{foodCostHesaplaYukleniyor ? '⏳ Hesaplanıyor…' : '▶ Hesapla'}</button>
                      <div style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>
                        Seçili güne ait açılış/kapanış stok ve ciro verilerinden teorik maliyet hesaplar → tabloya yazar.
                      </div>
                    </div>
                    {foodCostHesaplaSonuc && (
                      <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 7, background: foodCostHesaplaSonuc.uyari ? 'rgba(234,179,8,.1)' : 'rgba(22,163,74,.08)', border: `1px solid ${foodCostHesaplaSonuc.uyari ? 'rgba(234,179,8,.4)' : 'rgba(22,163,74,.25)'}`, fontSize: 11 }}>
                        {foodCostHesaplaSonuc.uyari
                          ? `⚠️ ${foodCostHesaplaSonuc.uyari}`
                          : `✅ ${foodCostHesaplaSonuc.hesaplanan_satir} şube · ${foodCostHesaplaSonuc.hesaplanan_gun} gün hesaplandı ve tabloya yazıldı.`}
                      </div>
                    )}
                  </div>

                  {/* Tablo */}
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                    📅 {kaynakHesaplama ? 'Hesaplama Sonucu' : `Son ${maliyetGun} Günlük Food Cost Geçmişi`}
                  </div>
                  {gosterilecekler.length === 0 ? (
                    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                      {maliyetYukleniyor ? 'Yükleniyor…' : 'Kayıt yok. Tarih seç → Hesapla butonuna bas.'}
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border)' }}>
                            {['Tarih', 'Şube', 'Ciro', 'Teorik Maliyet', 'Food Cost %', 'Stok Değeri', 'Alış Fiyatlı Kalem'].map(h => (
                              <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {gosterilecekler.map((r, i) => {
                            // DB kayıtları food_cost_pct decimal (0.32), hesaplama sonucu % (32.0)
                            const fcRaw = kaynakHesaplama ? Number(r.food_cost_pct || 0) : Number(r.food_cost_pct || 0) * 100;
                            const fcR = fcRaw > 35 ? '#ef4444' : fcRaw > 0 && fcRaw < 28 ? '#f59e0b' : fcRaw > 0 ? '#22c55e' : 'var(--text3)';
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i%2===0?'transparent':'var(--bg2)' }}>
                                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text3)' }}>{r.tarih}</td>
                                <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.sube_adi || r.sube_id}</td>
                                <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>₺{Number(r.ciro_tl||0).toLocaleString('tr-TR',{maximumFractionDigits:0})}</td>
                                <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>₺{Number(r.teorik_maliyet_tl||0).toLocaleString('tr-TR',{maximumFractionDigits:0})}</td>
                                <td style={{ padding: '6px 10px', fontWeight: 700, color: fcR }}>{fcRaw > 0 ? `%${fcRaw.toFixed(1)}` : '—'}</td>
                                <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums', color: 'var(--text3)' }}>
                                  {r.stok_degeri_tl != null ? `₺${Number(r.stok_degeri_tl).toLocaleString('tr-TR',{maximumFractionDigits:0})}` : '—'}
                                </td>
                                <td style={{ padding: '6px 10px', textAlign: 'center', color: 'var(--text3)' }}>
                                  {r.fiyatli_kalem_sayisi != null ? r.fiyatli_kalem_sayisi : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {aktifSekme === 'alis-fiyatlari' && (
              <div>
                {/* Başlık + Ekle butonu */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>🏷 Alış Fiyat Listesi</div>
                  <button
                    onClick={() => { setAlisFormGoster(v => !v); setAlisForm({ kalem_kodu: '', kalem_adi: '', birim: 'kg', birim_maliyet_tl: '', tedarikci: '', notlar: '' }); }}
                    style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: alisFormGoster ? 'var(--bg2)' : '#16a34a', color: alisFormGoster ? 'var(--text)' : '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                  >{alisFormGoster ? '✕ Kapat' : '+ Fiyat Ekle'}</button>
                </div>

                {/* Fiyat Giriş Formu */}
                {alisFormGoster && (
                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 10, color: '#16a34a' }}>Yeni Alış Fiyatı</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 120px', gap: 8, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Kalem Kodu *</div>
                        <input
                          value={alisForm.kalem_kodu}
                          onChange={e => setAlisForm(f => ({ ...f, kalem_kodu: e.target.value }))}
                          placeholder="ör: arabica_kg"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Kalem Adı</div>
                        <input
                          value={alisForm.kalem_adi}
                          onChange={e => setAlisForm(f => ({ ...f, kalem_adi: e.target.value }))}
                          placeholder="ör: Arabica Kahve"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Birim</div>
                        <select
                          value={alisForm.birim}
                          onChange={e => setAlisForm(f => ({ ...f, birim: e.target.value }))}
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }}
                        >
                          {['kg', 'lt', 'adet', 'gram', 'ml', 'paket', 'kutu', 'çuval'].map(b => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Birim Maliyet (₺) *</div>
                        <input
                          type="number" min="0" step="0.01"
                          value={alisForm.birim_maliyet_tl}
                          onChange={e => setAlisForm(f => ({ ...f, birim_maliyet_tl: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                        />
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Tedarikçi</div>
                        <input
                          value={alisForm.tedarikci}
                          onChange={e => setAlisForm(f => ({ ...f, tedarikci: e.target.value }))}
                          placeholder="Tedarikçi adı"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Notlar</div>
                        <input
                          value={alisForm.notlar}
                          onChange={e => setAlisForm(f => ({ ...f, notlar: e.target.value }))}
                          placeholder="İsteğe bağlı not"
                          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                        />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        disabled={alisFormKayit || !alisForm.kalem_kodu.trim() || !alisForm.birim_maliyet_tl}
                        onClick={() => {
                          setAlisFormKayit(true);
                          api('/ops/maliyet/alis-fiyat-kaydet', {
                            method: 'POST',
                            body: JSON.stringify({
                              kalem_kodu: alisForm.kalem_kodu.trim(),
                              kalem_adi: alisForm.kalem_adi.trim() || alisForm.kalem_kodu.trim(),
                              birim: alisForm.birim,
                              birim_maliyet_tl: parseFloat(alisForm.birim_maliyet_tl) || 0,
                              tedarikci: alisForm.tedarikci.trim() || null,
                              notlar: alisForm.notlar.trim() || null,
                            }),
                          })
                            .then(() => {
                              toast('✅ Fiyat kaydedildi');
                              setAlisFormGoster(false);
                              return api('/ops/maliyet/alis-fiyatlari');
                            })
                            .then(d => setAlisFiyatlari(d?.satirlar || []))
                            .catch(e => toast(e.message || 'Kayıt hatası'))
                            .finally(() => setAlisFormKayit(false));
                        }}
                        style={{ padding: '6px 18px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', opacity: alisFormKayit ? .6 : 1 }}
                      >{alisFormKayit ? 'Kaydediliyor…' : '💾 Kaydet'}</button>
                      <button onClick={() => setAlisFormGoster(false)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>İptal</button>
                    </div>
                  </div>
                )}

                {/* Açıklama */}
                <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(234,179,8,.07)', border: '1px solid rgba(234,179,8,.3)', fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
                  Fiyat değiştiğinde yeni kayıt ekle — eski kayıt arşivlenir, geçmiş analizler bozulmaz.
                </div>

                {/* Tablo */}
                {alisFiyatlari.length === 0 ? (
                  <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                    Henüz fiyat girilmemiş — "Fiyat Ekle" ile başla.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border)' }}>
                          {['Kalem', 'Birim', 'Birim Maliyet', 'Geçerlilik', 'Tedarikçi', 'Notlar'].map(h => (
                            <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {alisFiyatlari.map((r, i) => (
                          <tr key={r.id || i} style={{ borderBottom: '1px solid var(--border)', background: i%2===0?'transparent':'var(--bg2)' }}>
                            <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.kalem_adi || r.kalem_kodu}<br/><span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text3)' }}>{r.kalem_kodu}</span></td>
                            <td style={{ padding: '6px 10px', color: 'var(--text3)' }}>{r.birim}</td>
                            <td style={{ padding: '6px 10px', fontWeight: 700, color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>₺{Number(r.birim_maliyet_tl||0).toFixed(4)}</td>
                            <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)' }}>{r.gecerli_baslangic}{r.gecerli_bitis ? ` → ${r.gecerli_bitis}` : ' → günümüze'}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text3)' }}>{r.tedarikci || '—'}</td>
                            <td style={{ padding: '6px 10px', color: 'var(--text3)', fontSize: 11 }}>{r.notlar || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {aktifSekme === 'recete' && (() => {
              const acHammadde = () => setReceteForm(f => ({ ...f, hammaddeler: [...f.hammaddeler, { hammadde_kodu: '', hammadde_adi: '', miktar: '', birim: 'kg' }] }));
              const silHammadde = idx => setReceteForm(f => ({ ...f, hammaddeler: f.hammaddeler.filter((_, i) => i !== idx) }));
              const setHammadde = (idx, key, val) => setReceteForm(f => {
                const hs = [...f.hammaddeler];
                hs[idx] = { ...hs[idx], [key]: val };
                return { ...f, hammaddeler: hs };
              });
              const aciklaReceteFormu = (r) => {
                if (r) {
                  setReceteForm({ urun_id: r.urun_id, urun_adi: r.urun_adi || r.urun_id, hammaddeler: (r.hammaddeler || []).map(h => ({ hammadde_kodu: h.hammadde_kodu, hammadde_adi: h.hammadde_adi || '', miktar: String(h.miktar), birim: h.birim || 'kg' })) });
                  setReceteDuzenle(r.urun_id);
                } else {
                  setReceteForm({ urun_id: '', urun_adi: '', hammaddeler: [{ hammadde_kodu: '', hammadde_adi: '', miktar: '', birim: 'kg' }] });
                  setReceteDuzenle(null);
                }
                setReceteFormGoster(true);
              };
              const kaydetRecete = () => {
                const gecerli = receteForm.hammaddeler.filter(h => h.hammadde_kodu.trim() && h.miktar);
                if (!receteForm.urun_id.trim()) return toast('Ürün ID zorunlu');
                if (!gecerli.length) return toast('En az 1 hammadde satırı gerekli');
                setReceteFormKayit(true);
                api('/ops/maliyet/recete-kaydet', {
                  method: 'POST',
                  body: JSON.stringify({
                    urun_id: receteForm.urun_id.trim(),
                    urun_adi: receteForm.urun_adi.trim() || receteForm.urun_id.trim(),
                    hammaddeler: gecerli.map(h => ({ hammadde_kodu: h.hammadde_kodu.trim(), hammadde_adi: h.hammadde_adi.trim() || h.hammadde_kodu.trim(), miktar: parseFloat(h.miktar) || 0, birim: h.birim })),
                  }),
                })
                  .then(() => { toast('✅ Reçete kaydedildi'); setReceteFormGoster(false); return api('/ops/maliyet/recete-listesi'); })
                  .then(d => setReceteler(d?.receteler || []))
                  .catch(e => toast(e.message || 'Kayıt hatası'))
                  .finally(() => setReceteFormKayit(false));
              };
              const silRecete = (urun_id) => {
                if (!window.confirm(`"${urun_id}" reçetesi silinsin mi?`)) return;
                api(`/ops/maliyet/recete-sil/${encodeURIComponent(urun_id)}`, { method: 'DELETE' })
                  .then(() => { toast('🗑 Reçete silindi'); return api('/ops/maliyet/recete-listesi'); })
                  .then(d => setReceteler(d?.receteler || []))
                  .catch(e => toast(e.message || 'Silme hatası'));
              };
              return (
                <div>
                  {/* Başlık + Ekle */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>📐 Ürün Reçeteleri</div>
                    <button
                      onClick={() => receteFormGoster ? setReceteFormGoster(false) : aciklaReceteFormu(null)}
                      style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: receteFormGoster ? 'var(--bg2)' : '#166534', color: receteFormGoster ? 'var(--text)' : '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                    >{receteFormGoster ? '✕ Kapat' : '+ Reçete Ekle'}</button>
                  </div>

                  {/* Açıklama */}
                  <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(22,163,74,.07)', border: '1px solid rgba(22,163,74,.25)', fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
                    Her satılan ürün için hammadde tüketimi tanımlanır. <strong>Reçete × satış adedi = teorik maliyet.</strong> Gerçek stok düşüşünden fazlası shrinkage.
                  </div>

                  {/* Reçete Formu */}
                  {receteFormGoster && (
                    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 10, color: '#166534' }}>
                        {receteDuzenle ? `✏️ Düzenleniyor: ${receteDuzenle}` : 'Yeni Reçete'}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Ürün ID / Kodu *</div>
                          <input
                            value={receteForm.urun_id}
                            onChange={e => setReceteForm(f => ({ ...f, urun_id: e.target.value }))}
                            disabled={!!receteDuzenle}
                            placeholder="ör: flat_white, latte_buyuk"
                            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: receteDuzenle ? 'var(--bg)' : 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box', opacity: receteDuzenle ? .7 : 1 }}
                          />
                        </div>
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Ürün Adı</div>
                          <input
                            value={receteForm.urun_adi}
                            onChange={e => setReceteForm(f => ({ ...f, urun_adi: e.target.value }))}
                            placeholder="ör: Flat White, Büyük Latte"
                            style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }}
                          />
                        </div>
                      </div>

                      {/* Hammadde Satırları */}
                      <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--text2)', marginBottom: 6 }}>Hammaddeler</div>
                      {receteForm.hammaddeler.map((h, idx) => (
                        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 80px 32px', gap: 6, marginBottom: 6, alignItems: 'end' }}>
                          <div>
                            {idx === 0 && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3 }}>Hammadde Kodu *</div>}
                            <input
                              value={h.hammadde_kodu}
                              onChange={e => setHammadde(idx, 'hammadde_kodu', e.target.value)}
                              placeholder="ör: arabica_kg"
                              style={{ width: '100%', padding: '5px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11, boxSizing: 'border-box' }}
                            />
                          </div>
                          <div>
                            {idx === 0 && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3 }}>Hammadde Adı</div>}
                            <input
                              value={h.hammadde_adi}
                              onChange={e => setHammadde(idx, 'hammadde_adi', e.target.value)}
                              placeholder="ör: Arabica Kahve"
                              style={{ width: '100%', padding: '5px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11, boxSizing: 'border-box' }}
                            />
                          </div>
                          <div>
                            {idx === 0 && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3 }}>Miktar *</div>}
                            <input
                              type="number" min="0" step="0.001"
                              value={h.miktar}
                              onChange={e => setHammadde(idx, 'miktar', e.target.value)}
                              placeholder="0.018"
                              style={{ width: '100%', padding: '5px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11, boxSizing: 'border-box' }}
                            />
                          </div>
                          <div>
                            {idx === 0 && <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 3 }}>Birim</div>}
                            <select
                              value={h.birim}
                              onChange={e => setHammadde(idx, 'birim', e.target.value)}
                              style={{ width: '100%', padding: '5px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 11 }}
                            >
                              {['kg', 'lt', 'adet', 'gram', 'ml', 'paket'].map(b => <option key={b} value={b}>{b}</option>)}
                            </select>
                          </div>
                          <div style={{ paddingTop: idx === 0 ? 16 : 0 }}>
                            {receteForm.hammaddeler.length > 1 && (
                              <button onClick={() => silHammadde(idx)} style={{ padding: '5px 7px', borderRadius: 5, border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.07)', color: '#ef4444', fontSize: 11, cursor: 'pointer', width: '100%' }}>✕</button>
                            )}
                          </div>
                        </div>
                      ))}
                      <button onClick={acHammadde} style={{ padding: '4px 10px', borderRadius: 5, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text3)', fontSize: 11, cursor: 'pointer', marginBottom: 12 }}>+ Hammadde Ekle</button>

                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          disabled={receteFormKayit}
                          onClick={kaydetRecete}
                          style={{ padding: '6px 18px', borderRadius: 6, border: 'none', background: '#166534', color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', opacity: receteFormKayit ? .6 : 1 }}
                        >{receteFormKayit ? 'Kaydediliyor…' : '💾 Kaydet'}</button>
                        <button onClick={() => setReceteFormGoster(false)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12, cursor: 'pointer' }}>İptal</button>
                      </div>
                    </div>
                  )}

                  {/* Mevcut Reçeteler */}
                  {receteler.length === 0 ? (
                    <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                      Henüz reçete tanımlanmamış — "Reçete Ekle" ile başla.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {receteler.map((r) => (
                        <div key={r.urun_id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                            <div>
                              <span style={{ fontWeight: 700, fontSize: 13 }}>{r.urun_adi || r.urun_id}</span>
                              <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8 }}>{r.urun_id}</span>
                              <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 8 }}>{(r.hammaddeler || []).length} hammadde</span>
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => aciklaReceteFormu(r)} style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 11, cursor: 'pointer' }}>✏️ Düzenle</button>
                              <button onClick={() => silRecete(r.urun_id)} style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.07)', color: '#ef4444', fontSize: 11, cursor: 'pointer' }}>🗑 Sil</button>
                            </div>
                          </div>
                          <div style={{ padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            {(r.hammaddeler || []).map((h, i) => (
                              <div key={i} style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(22,163,74,.08)', border: '1px solid rgba(22,163,74,.2)', fontSize: 11 }}>
                                <span style={{ fontWeight: 600 }}>{h.hammadde_adi || h.hammadde_kodu}</span>
                                <span style={{ color: 'var(--text3)', marginLeft: 6 }}>{Number(h.miktar).toFixed(4)} {h.birim}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {aktifSekme === 'shrinkage' && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>📉 Shrinkage Raporu</div>
                <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(220,38,38,.07)', border: '1px solid rgba(220,38,38,.25)', fontSize: 12, color: 'var(--text2)', marginBottom: 12 }}>
                  <strong>Shrinkage = Teorik Tüketim − Gerçek Stok Düşüşü.</strong> Pozitif = fire/hırsızlık/ölçüm hatası.
                  NRF standardı: %2 altı normal, %2–5 izle, %5 üstü soruştur.
                </div>
                <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                  Alış fiyatları ve reçete tanımlandıktan sonra shrinkage otomatik hesaplanacak.
                </div>
              </div>
            )}

          </div>
        );
      })()}

      {aktifSekme === 'stok-hareketi' && (() => {
        const TUR_ETIKET = {
          SEVK_GIRIS:      { label: 'Sevk Girişi',      renk: '#22c55e', ikon: '📦' },
          SEVK_CIKIS:      { label: 'Sevk Çıkışı',      renk: '#f97316', ikon: '🚚' },
          SEVK_UZLASMA:    { label: 'Sevk Uzlaşma',     renk: '#f59e0b', ikon: '🔄' },
          KULLANIM:        { label: 'Kullanım',          renk: '#a78bfa', ikon: '☕' },
          SAYIM_DUZELTME:  { label: 'Sayım Düzeltme',   renk: '#60a5fa', ikon: '📊' },
          FIRE:            { label: 'Fire / Zayi',       renk: '#ef4444', ikon: '🗑' },
          IADE:            { label: 'İade',              renk: '#94a3b8', ikon: '↩️' },
          TRANSFER_GIRIS:  { label: 'Transfer Girişi',   renk: '#34d399', ikon: '➡️' },
          TRANSFER_CIKIS:  { label: 'Transfer Çıkışı',  renk: '#fb923c', ikon: '⬅️' },
          MANUEL:          { label: 'Manuel Düzeltme',   renk: '#a1a1aa', ikon: '✏️' },
        };
        const satirlar = stokHareket?.satirlar || [];
        const turOzet  = stokHareket?.tur_ozet || [];
        const subeOzet = stokHareket?.sube_ozet || [];
        const subeler  = [...new Set(satirlar.map(s => s.sube_id).filter(Boolean))];
        const turler   = [...new Set(satirlar.map(s => s.hareket_turu).filter(Boolean))];
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Header + açıklama */}
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(91,143,216,.08)', border: '1px solid rgba(91,143,216,.25)', fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>
              <strong style={{ display: 'block', marginBottom: 4 }}>📋 Stok Hareket Defteri — Inventory Ledger</strong>
              Her stok değişimi (sevkiyat kabulü, kullanım, sayım, fire) buraya yazılır. Aylık/yıllık sorgulama,
              şube bazında karşılaştırma ve kaçak/fire tespiti bu veriden yapılır.
              Starbucks/McDonald's standardı: teorik tüketim (reçete × satış) ile gerçek stok düşüşü farkı izlenir;
              {' '}<strong>%2 üstü shrinkage → inceleme, %5 üstü → soruşturma</strong>.
            </div>

            {/* Filtreler */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={stokHareketGun}
                onChange={e => setStokHareketGun(Number(e.target.value))}
                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12 }}
              >
                {[7, 14, 30, 60, 90, 180, 365].map(g => (
                  <option key={g} value={g}>Son {g} gün</option>
                ))}
              </select>
              <select
                value={stokHareketSubeFiltre}
                onChange={e => setStokHareketSubeFiltre(e.target.value)}
                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12 }}
              >
                <option value=''>Tüm şubeler</option>
                {subeler.map(sid => {
                  const satir = satirlar.find(s => s.sube_id === sid);
                  return <option key={sid} value={sid}>{satir?.sube_ad || sid}</option>;
                })}
              </select>
              <select
                value={stokHareketTurFiltre}
                onChange={e => setStokHareketTurFiltre(e.target.value)}
                style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12 }}
              >
                <option value=''>Tüm hareket türleri</option>
                {Object.entries(TUR_ETIKET).map(([k, v]) => (
                  <option key={k} value={k}>{v.ikon} {v.label}</option>
                ))}
              </select>
              {stokHareketYukleniyor && <span style={{ fontSize: 11, color: 'var(--text3)' }}>Yükleniyor…</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{stokHareket.toplam} kayıt</span>
            </div>

            {/* Şube + Tür özet kartları */}
            {turOzet.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Hareket Türü Özeti</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {turOzet.map(t => {
                    const meta = TUR_ETIKET[t.hareket_turu] || { label: t.hareket_turu, renk: '#888', ikon: '•' };
                    return (
                      <div key={t.hareket_turu} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${meta.renk}40`, background: `${meta.renk}10`, minWidth: 140 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: meta.renk }}>{meta.ikon} {meta.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                          {t.adet} hareket · <span style={{ color: '#22c55e' }}>+{Number(t.toplam_giris || 0).toFixed(1)}</span> / <span style={{ color: '#ef4444' }}>−{Number(t.toplam_cikis || 0).toFixed(1)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Şube özet */}
            {subeOzet.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>Şube Bazlı Özet</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {subeOzet.map(s => (
                    <div key={s.sube_id} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', minWidth: 160 }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>🏪 {s.sube_ad || s.sube_id}</div>
                      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
                        {s.hareket_adet} hareket · <span style={{ color: '#22c55e' }}>+{Number(s.toplam_giris || 0).toFixed(1)}</span> / <span style={{ color: '#ef4444' }}>−{Number(s.toplam_cikis || 0).toFixed(1)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ana tablo */}
            {satirlar.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
                {stokHareketYukleniyor ? 'Yükleniyor…' : 'Bu dönemde henüz kayıt yok. Sevkiyat kabulü, sayım veya manuel güncelleme yapıldıkça burası dolacak.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border)' }}>
                      {['Zaman', 'Şube', 'Kalem', 'Tür', 'Miktar', 'Önce → Sonra', 'Kaynak', 'Açıklama'].map(h => (
                        <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {satirlar.map((s, i) => {
                      const meta  = TUR_ETIKET[s.hareket_turu] || { label: s.hareket_turu, renk: '#888', ikon: '•' };
                      const pozitif = Number(s.miktar || 0) >= 0;
                      const zaman = s.zaman ? new Date(s.zaman).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
                      return (
                        <tr key={s.id || i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--text3)', fontSize: 11 }}>{zaman}</td>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontWeight: 600 }}>{s.sube_ad || s.sube_id || '—'}</td>
                          <td style={{ padding: '6px 10px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.kalem_kodu}>{s.kalem_adi || s.kalem_kodu || '—'}</td>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: `${meta.renk}18`, color: meta.renk, border: `1px solid ${meta.renk}30` }}>
                              {meta.ikon} {meta.label}
                            </span>
                          </td>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontWeight: 700, color: pozitif ? '#22c55e' : '#ef4444', fontVariantNumeric: 'tabular-nums' }}>
                            {pozitif ? '+' : ''}{Number(s.miktar || 0).toFixed(1)}
                          </td>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--text3)', fontSize: 11 }}>
                            {s.onceki_miktar != null ? Number(s.onceki_miktar).toFixed(1) : '?'} → {s.sonraki_miktar != null ? Number(s.sonraki_miktar).toFixed(1) : '?'}
                          </td>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--text3)' }}>
                            {s.kaynak_tip ? <span style={{ padding: '1px 5px', borderRadius: 3, background: 'var(--bg3)', fontFamily: 'monospace', fontSize: 10 }}>{s.kaynak_tip}</span> : '—'}
                            {s.kaynak_belge_no && <span style={{ marginLeft: 4 }}>#{s.kaynak_belge_no}</span>}
                          </td>
                          <td style={{ padding: '6px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 11 }} title={s.aciklama}>{s.aciklama || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Boş durum bilgi kutusu */}
            {satirlar.length === 0 && !stokHareketYukleniyor && (
              <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.3)', fontSize: 12, color: 'var(--text2)' }}>
                <strong>⚠️ Geçmişe dönük kayıt yok</strong> — Bu özellik bugünden itibaren aktif.
                Bundan sonra yapılan her sevkiyat kabulü, manuel stok güncellemesi ve sayım düzeltmesi buraya yazılacak.
              </div>
            )}
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
        <UrunUyumsuzlukPanel
          api={api}
          toast={toast}
          bugunIsoTarih={bugunIsoTarih}
          isoTariheGunEkle={isoTariheGunEkle}
          aramaSonuc={urunUyumAramaSonuc}
          setAramaSonuc={setUrunUyumAramaSonuc}
          aramaTarih={urunUyumAramaTarih}
          setAramaTarih={setUrunUyumAramaTarih}
          aramaYukleniyor={urunUyumAramaYukleniyor || yukleniyor}
          setAramaYukleniyor={setUrunUyumAramaYukleniyor}
          durumFiltre={urunUyumDurumFiltre}
          setDurumFiltre={setUrunUyumDurumFiltre}
          gunYukle={urunUyumGunYukle}
          haftaYukle={urunUyumHaftaYukle}
          haftaSatirlari={urunUyumHaftaSatirlari}
          haftaYukleniyor={urunUyumHaftaYukleniyor}
          seciliSubeKey={urunUyumSeciliSubeKey}
          setSeciliSubeKey={setUrunUyumSeciliSubeKey}
          subeSekmeleri={urunUyumSubeSekmeleri}
          gorunenKayitlar={urunUyumGorunenKayitlar}
          onayBusyId={onayBusyId}
          setOnayBusyId={setOnayBusyId}
          onRefreshHub={async () => {
            // Çözüm sonrası HEM onay merkezini HEM de canlı operasyon ürün-uyum
            // rozetlerini (📦/📋/⚠️ → urunUyumBugun) tazele ki sayı anında düşsün.
            try { await yukleOnayMerkez(); } catch (_) {}
            try { await yukleUrunUyumBugun({ silent: true }); } catch (_) {}
          }}
        />
      )}

      {aktifSekme === 'fire-bildirim' && (
        <FireBildirimPanel
          api={api}
          toast={toast}
          bugunIsoTarih={bugunIsoTarih}
          isoTariheGunEkle={isoTariheGunEkle}
          aramaSonuc={fireAramaSonuc}
          setAramaSonuc={setFireAramaSonuc}
          aramaTarih={fireAramaTarih}
          setAramaTarih={setFireAramaTarih}
          aramaYukleniyor={fireAramaYukleniyor || yukleniyor}
          setAramaYukleniyor={setFireAramaYukleniyor}
          sebepFiltre={fireSebepFiltre}
          setSebepFiltre={setFireSebepFiltre}
          gunYukle={fireGunYukle}
          haftaYukle={fireHaftaYukle}
          haftaSatirlari={fireHaftaSatirlari}
          haftaYukleniyor={fireHaftaYukleniyor}
          seciliSubeKey={fireSeciliSubeKey}
          setSeciliSubeKey={setFireSeciliSubeKey}
          subeSekmeleri={fireSubeSekmeleri}
          gorunenKayitlar={fireGorunenKayitlar}
          onayBusyId={onayBusyId}
          setOnayBusyId={setOnayBusyId}
        />
      )}

      {false && aktifSekme === 'sevkiyat-uyumsuzluk' && (
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
              {(sevkiyatUyumDetay?.satirlar || []).map((row, idx) => {
                const yid = String(row.stok_yolda_id || '').trim();
                const stableKey = yid || `${row.siparis_talep_id || 'notalep'}__${row.kalem_kodu || row.kalem_adi || 'nokalem'}__${idx}`;
                const inputKey = yid || stableKey;
                const draft = sevkiyatUyumCozInputs[inputKey] || {};
                const sevk = Number(row.sevk_adet || 0);
                const kabul = Number(row.kabul_adet || 0);
                const fark = row.fark_adet != null ? Number(row.fark_adet) : sevk - kabul;
                const busy = sevkiyatUyumCozBusy === yid;
                return (
                  <div key={stableKey} className="card" style={{ padding: '12px 14px', borderLeft: '4px solid #ea580c' }}>
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
                        <div style={{ fontSize: 12, marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span>Sevk: <strong className="mono">{sevk}</strong></span>
                          <span>Kabul: <strong className="mono">{kabul}</strong></span>
                          <span style={{ color: fark !== 0 ? 'var(--red)' : 'var(--text2)' }}>
                            Fark: <strong className="mono">{fark >= 0 ? '+' : ''}{fark}</strong>
                          </span>
                          {row.durum ? <span className="badge badge-yellow">{String(row.durum)}</span> : null}
                          {row.siparis_iptal && (
                            <span className="badge" style={{ background: '#dc2626', color: '#fff', fontWeight: 700 }}>
                              ⛔ Sipariş İptal
                            </span>
                          )}
                          {row.kabul_yok && !row.siparis_iptal && (
                            <span className="badge" style={{ background: '#f59e0b', color: '#fff' }}>
                              ⏳ Kabul Bekliyor
                            </span>
                          )}
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
                              [inputKey]: { ...prev[inputKey], cozum_adet: e.target.value },
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
                              [inputKey]: { ...prev[inputKey], notu: e.target.value },
                            }))}
                            style={{ width: '100%', marginTop: 4, padding: '6px 8px' }}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: 4, background: row.siparis_iptal ? '#dc2626' : undefined, borderColor: row.siparis_iptal ? '#dc2626' : undefined }}
                          disabled={busy || !yid}
                          title={!yid ? 'Bu satırın stok_yolda_id bilgisi eksik — sayfayı yenileyin' : (row.siparis_iptal ? 'Sipariş iptal — 0 girip uzlaştırarak stoku geri al' : undefined)}
                          onClick={() => {
                            if (!yid) {
                              toast('Bu satırın kimliği eksik. Listeyi yenile.', 'yellow');
                              return;
                            }
                            const d = sevkiyatUyumCozInputs[inputKey] || {};
                            const raw = String(d.cozum_adet != null ? d.cozum_adet : (row.siparis_iptal ? '0' : '')).trim();
                            const coz = parseInt(raw.replace(/\D/g, ''), 10);
                            if (Number.isNaN(coz) || coz < 0) {
                              toast('Geçerli uzlaşılan adet girin (0 veya pozitif tam sayı). İptal sipariş için 0 yazabilirsin.', 'yellow');
                              return;
                            }
                            sevkiyatUyumsuzlukCoz(yid, coz, d.notu);
                          }}
                        >
                          {busy ? 'Kaydediliyor…' : (row.siparis_iptal ? '⛔ İptal — Stoku geri al' : 'Uzlaştır ve stokları düzelt')}
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

      {false && aktifSekme === 'siparis-kabul-takip' && (
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
          {toptanciOnUrun && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 8,
              background: 'rgba(14,165,164,.08)', border: '1px solid rgba(14,165,164,.35)',
            }}>
              <span style={{ fontSize: 16 }}>📦</span>
              <span style={{ fontSize: 13, color: 'var(--text2)' }}>
                Stok tahmininden geldiniz — <strong>{toptanciOnUrun.urun_ad}</strong> stoğu yetersiz
                {toptanciOnUrun.tahmin_7gun != null ? ` (7 günlük tahmin: ${toptanciOnUrun.tahmin_7gun})` : ''}.
                Aşağıdan toptancı siparişini oluşturabilirsiniz.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
                onClick={() => setToptanciOnUrun(null)}>Kapat</button>
            </div>
          )}
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Kontrol kulesinden toptancıya yönlendirilen gönderimler. <strong>Gönderilenler</strong> tek tek kayıt;
            <strong> Ürün özeti</strong> kategori/ürün toplamı.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { id: 'gonderim', label: '📤 Gönderilenler' },
              { id: 'ozet', label: '📊 Ürün özeti' },
            ].map((g) => (
              <button
                key={g.id}
                type="button"
                className={`btn btn-sm ${toptanciSiparisGorunum === g.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setToptanciSiparisGorunum(g.id)}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Dönem</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { id: 'bugun', label: 'Bugün' },
                { id: 'dun', label: 'Dün' },
                { id: 'gun_7', label: 'Son 7 gün' },
                { id: 'gun_14', label: 'Son 14 gün' },
                { id: 'gun_30', label: 'Son 30 gün' },
                { id: 'gun_60', label: 'Son 60 gün' },
                { id: 'tarih', label: 'Tarih seç' },
              ].map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`btn btn-sm ${toptanciSiparisDonem === d.id ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setToptanciSiparisDonem(d.id)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {toptanciSiparisDonem === 'tarih' && (
              <label style={{ margin: 0, maxWidth: 200 }}>
                <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
                <input
                  type="date"
                  className="input"
                  value={toptanciSiparisTarih}
                  onChange={(e) => setToptanciSiparisTarih(e.target.value || bugunIsoTarih())}
                />
              </label>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Sırala</span>
              <select
                className="input"
                value={toptanciSiparisSirala}
                onChange={(e) => setToptanciSiparisSirala(e.target.value)}
              >
                <option value="en_son">En son gönderilen</option>
                <option value="eski">En eski</option>
                <option value="adet_azalan">Adet (yüksek → düşük)</option>
                <option value="urun">Ürün adı (A→Z)</option>
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukleToptanciSiparisleri(); }}>
              Filtreyi uygula
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const gonderimMod = toptanciSiparisGorunum === 'gonderim';
                const rows = gonderimMod
                  ? (Array.isArray(toptanciSiparisListe?.gonderimler) ? toptanciSiparisListe.gonderimler : [])
                  : (Array.isArray(toptanciSiparisListe?.satirlar) ? toptanciSiparisListe.satirlar : []);
                const tsv = gonderimMod
                  ? [
                      ['Tarih', 'Saat', 'Şube', 'Toptancı', 'Kalemler', 'Adet'].join('\t'),
                      ...rows.map((g) => [
                        String(g?.tarih || ''),
                        String(g?.saat || '').slice(0, 5),
                        String(g?.sube_adi || ''),
                        String(g?.tedarikci_ad || ''),
                        String(g?.kalemler_ozet || ''),
                        String(Number(g?.toplam_adet || 0)),
                      ].join('\t')),
                    ].join('\n')
                  : [
                      ['Kategori', 'Ürün', 'Toplam adet', 'Son gönderim'].join('\t'),
                      ...rows.map((r) => [
                        String(r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || ''),
                        String(r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || ''),
                        String(Number(r?.toplam_adet || r?.adet || r?.miktar || 0)),
                        String(r?.son_tarih || ''),
                      ].join('\t')),
                    ].join('\n');
                const blob = new Blob([`﻿${tsv}`], { type: 'application/vnd.ms-excel;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `toptanci_siparisleri_${String(toptanciSiparisListe?.filtre_etiket || 'liste').replace(/\s+/g, '_')}.xls`;
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
                w.document.write(`<!doctype html><html><head><meta charset="utf-8" /><title>Toptancı Siparişleri</title><style>body{font-family:Arial,sans-serif;padding:20px;color:#111}h1{font-size:18px;margin:0 0 12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d0d0d0;padding:8px;font-size:12px;text-align:left}th{background:#f5f5f5}</style></head><body><h1>Toptancı Siparişleri (${esc(toptanciSiparisListe?.filtre_etiket || 'liste')})</h1><table><thead><tr><th>Kategori</th><th>Ürün</th><th>Toplam adet</th></tr></thead><tbody>${bodyRows || '<tr><td colspan="3">Kayıt yok</td></tr>'}</tbody></table></body></html>`);
                w.document.close();
                w.focus();
                w.print();
              }}
            >
              PDF indir
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {toptanciSiparisListe?.filtre_etiket || '—'}
            {toptanciSiparisListe?.tarih_bas && toptanciSiparisListe?.tarih_bit
              && toptanciSiparisListe.tarih_bas !== toptanciSiparisListe.tarih_bit
              ? ` (${toptanciSiparisListe.tarih_bas} – ${toptanciSiparisListe.tarih_bit})`
              : ''}
            {' · '}{Number(toptanciSiparisListe?.toplam_kayit || 0)} gönderim · {Number(toptanciSiparisListe?.toplam_satir || 0)} ürün satırı (özet)
          </div>
          {toptanciSiparisGorunum === 'gonderim' ? (
            !Array.isArray(toptanciSiparisListe?.gonderimler) || toptanciSiparisListe.gonderimler.length === 0 ? (
              <div className="empty"><p>Seçilen dönemde toptancıya gönderim kaydı yok.</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ maxHeight: 560, overflow: 'auto' }}>
                  <table className="table" style={{ margin: 0 }}>
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Saat</th>
                        <th>Şube</th>
                        <th>Toptancı</th>
                        <th>Kalemler</th>
                        <th style={{ textAlign: 'right' }}>Adet</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {toptanciSiparisListe.gonderimler.map((g) => (
                        <tr key={g.id}>
                          <td className="mono" style={{ whiteSpace: 'nowrap' }}>{g.tarih || '—'}</td>
                          <td className="mono">{g.saat ? String(g.saat).slice(0, 5) : '—'}</td>
                          <td>{g.sube_adi || '—'}</td>
                          <td>{g.tedarikci_ad || '—'}</td>
                          <td style={{ fontSize: 12, maxWidth: 280 }} title={g.not_aciklama || ''}>
                            {g.kalemler_ozet || '—'}
                            {g.not_aciklama ? (
                              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{g.not_aciklama}</div>
                            ) : null}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(g.toplam_adet || 0)}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: 4 }}>
                              {(() => {
                                const _toptanciHtmlAc = (yazdirMi) => {
                                  const kalemler = Array.isArray(g.kalemler) ? g.kalemler : [];
                                  if (!kalemler.length) { toast('Bu kayıtta kalem detayı yok.'); return; }
                                  const satirlar = kalemler.map((k, idx) =>
                                    `<tr><td style="padding:12px 14px;font-size:18px;border-bottom:1px solid #e0e0e0">${idx + 1}. ${k.urun_ad || k.ad || '—'}</td><td style="padding:12px 16px;font-size:22px;font-weight:900;text-align:right;border-bottom:1px solid #e0e0e0">× ${k.adet || 0}</td></tr>`
                                  ).join('');
                                  const subeAd = String(g.sube_adi || '').trim() || 'Şube';
                                  const tarihStr = String(g.tarih || '').slice(0, 10);
                                  const saatStr = g.saat ? String(g.saat).slice(0, 5) : '';
                                  const notAciklama = String(g.not_aciklama || '').trim();
                                  const printScript = yazdirMi ? `<script>window.onload=function(){window.print()};<\/script>` : '';
                                  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${g.tedarikci_ad || 'Toptancı'} — ${subeAd}</title>
                                    <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#fff;font-family:Arial,sans-serif}@media print{@page{margin:12mm}}</style>
                                    </head><body><div style="padding:40px 44px;max-width:640px">
                                    <div style="border-bottom:3px solid #111;padding-bottom:16px;margin-bottom:24px">
                                      <div style="font-size:11px;color:#888;letter-spacing:0.1em;margin-bottom:8px">TOPTANCI SİPARİŞ LİSTESİ</div>
                                      <div style="font-size:26px;font-weight:900">${subeAd}</div>
                                      <div style="font-size:20px;font-weight:800;margin-top:8px">▸ ${g.tedarikci_ad || '—'}</div>
                                      <div style="font-size:13px;color:#666;margin-top:10px">📅 ${tarihStr}${saatStr ? ' · ' + saatStr : ''}</div>
                                    </div>
                                    <table style="width:100%;border-collapse:collapse">${satirlar}</table>
                                    ${notAciklama ? `<div style="margin-top:24px;padding:12px 14px;background:#f5f5f5;border-radius:8px;font-size:13px;color:#555">Not: ${notAciklama}</div>` : ''}
                                    <div style="margin-top:28px;border-top:1px solid #ccc;padding-top:12px;font-size:12px;color:#aaa">
                                      ${kalemler.length} kalem · ${kalemler.reduce((a, k) => a + (k.adet || 0), 0)} toplam adet
                                    </div></div>
                                    ${printScript}</body></html>`;
                                  const w = window.open('', '_blank', 'width=700,height=920');
                                  if (!w) { toast('Popup engellendi.'); return; }
                                  w.document.write(html); w.document.close();
                                };
                                return (<>
                                  <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }}
                                    onClick={() => _toptanciHtmlAc(false)}>
                                    👁 Detay
                                  </button>
                                  <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, padding: '3px 10px' }}
                                    onClick={() => _toptanciHtmlAc(true)}>
                                    🖨️ Yazdır
                                  </button>
                                </>);
                              })()}

                              {g.talep_id && (
                                <button className="btn btn-sm" style={{ fontSize: 11, padding: '3px 10px', background: '#fff3f3', color: '#c62828', border: '1px solid #ffcdd2' }}
                                  onClick={async () => {
                                    if (!window.confirm(`"${g.tedarikci_ad || 'Toptancı'}" siparişini geri alıp kuyruğa döndür?`)) return;
                                    try {
                                      await api(`/ops/siparis/${encodeURIComponent(g.talep_id)}/toptanci-geri-al`, { method: 'POST' });
                                      toast('↩ Sipariş kuyruğa geri alındı — Sipariş Kontrol Kulesi\'nde görünür.');
                                      yukleToptanciSiparisleri();
                                    } catch (e) {
                                      toast(e.message || 'Geri alma hatası', 'red');
                                    }
                                  }}>
                                  ↩ Kuyruğa Al
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : !Array.isArray(toptanciSiparisListe?.satirlar) || toptanciSiparisListe.satirlar.length === 0 ? (
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
                      <th>Son gönderim</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toptanciSiparisListe.satirlar.map((r, idx) => (
                      <tr key={`${String(r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || 'kat')}-${String(r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || idx)}-${idx}`}>
                        <td>{r?.kategori_kod || r?.kategori || r?.kat || r?.kategori_id || '—'}</td>
                        <td>{r?.urun_ad || r?.urun || r?.ad || r?.urun_adi || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{Number(r?.toplam_adet || r?.adet || r?.miktar || 0)}</td>
                        <td className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>{r?.son_tarih || '—'}</td>
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
                          {sube.toplam} teslim · son:{' '}
                          <strong style={{ color: 'var(--text2)' }}>
                            {sube.son_olay_ts || sube.son_tarih || '—'}
                          </strong>
                        </span>
                        {/* Aynı gün birden fazla teslim varsa vurgu */}
                        {(() => {
                          const gunSayim = {};
                          (sube.teslimler || []).forEach((t) => {
                            const g = String(t.tarih || '').slice(0, 10);
                            if (g) gunSayim[g] = (gunSayim[g] || 0) + 1;
                          });
                          const cokluGunler = Object.entries(gunSayim).filter(([, n]) => n > 1);
                          if (cokluGunler.length === 0) return null;
                          return (
                            <span
                              style={{
                                marginLeft: 8, fontSize: 10, fontWeight: 700,
                                background: 'rgba(245,158,11,0.20)', color: '#fbbf24',
                                padding: '2px 7px', borderRadius: 4,
                              }}
                              title={cokluGunler.map(([g, n]) => `${g}: ${n} ayrı teslim`).join('\n')}
                            >
                              ⏰ {cokluGunler.length} günde çoklu teslim
                            </span>
                          );
                        })()}
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
                                <span style={{
                                  fontSize: 11, fontWeight: 700,
                                  color: 'var(--text2)',
                                  whiteSpace: 'nowrap',
                                  background: 'rgba(99,102,241,0.12)',
                                  border: '1px solid rgba(99,102,241,0.25)',
                                  padding: '2px 8px', borderRadius: 4,
                                }}
                                title={t.olay_ts ? 'Teslim alındığı tarih + saat' : 'Sadece tarih'}>
                                  📅 {t.olay_ts || t.tarih}
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
                            <div style={{ display: 'flex', gap: 6, flexDirection: 'column' }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                style={{ background: '#f59e0b', color: '#fff', border: 'none' }}
                                disabled={!!onayBusyId || kkDuzeltBusy}
                                title="Sebebi bul, kaynağı düzelt"
                                onClick={() => kkDuzeltModalAc(u)}
                              >
                                🔧 Kaynağı Düzelt
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={!!onayBusyId}
                                onClick={() => kasaUyumsuzlukCoz(u.id, u.fark_tl)}
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
            <div style={{ marginLeft: 'auto' }}>
              <CacheFreshnessBadge
                guncelleme={sekmeSonGuncelleme['analitik']}
                kaynak="live"
                onYenile={() => { setYukleniyor(true); yukleAnalitik(); }}
                yenileniyor={yukleniyor}
              />
            </div>
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

              {/* Aylık Food Cost — cache'ten (anında, ms düzeyi) */}
              {aylikFoodCostCache && Array.isArray(aylikFoodCostCache.kayitlar) && aylikFoodCostCache.kayitlar.length > 0 && (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>💰 Aylık Food Cost — Şube Bazlı</div>
                    <span style={{
                      background: 'rgba(99,102,241,0.18)', color: '#a5b4fc',
                      borderRadius: 4, padding: '1px 6px', fontSize: 9, fontWeight: 700,
                    }}>⚡ CACHE</span>
                    <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 'auto' }}>
                      Cache'ten ms düzeyinde okundu
                    </span>
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {aylikFoodCostCache.kayitlar.map((k) => {
                      const pct = k.food_cost_pct;
                      const renk = pct == null ? '#94a3b8' : pct <= 30 ? '#22c55e' : pct <= 45 ? '#f59e0b' : '#ef4444';
                      return (
                        <div key={k.sube_id + k.year_month} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px 60px 60px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                          <span style={{ fontWeight: 600 }}>{k.sube_id} <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: 10 }}>· {k.year_month}</span></span>
                          <span style={{ color: 'var(--text3)' }}>Ciro: {fmt(k.toplam_ciro || 0)}</span>
                          <span style={{ color: 'var(--text3)' }}>Gider: {fmt(k.toplam_gider || 0)}</span>
                          <span style={{ color: 'var(--text3)' }}>Fiş: {k.fis_sayisi || 0}</span>
                          <span style={{ fontWeight: 700, color: renk }}>{pct != null ? `%${pct}` : '—'}</span>
                        </div>
                      );
                    })}
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 10, color: 'var(--text3)' }}>
                    Renk: yeşil ≤30%, sarı ≤45%, kırmızı &gt;45%. Otomatik gece güncellenir + olay-tetikli.
                  </p>
                </div>
              )}

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
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 80px 80px 80px 70px 120px', gap: 8, alignItems: 'center', fontSize: 12,
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
                    {t.uyari ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ padding: '4px 8px', fontSize: 11, background: 'rgba(14,165,164,.15)', border: '1px solid rgba(14,165,164,.4)', color: '#5eead4', fontWeight: 600 }}
                        title="Bu ürünü toptancı sipariş ekranında aç"
                        onClick={() => {
                          try {
                            sessionStorage.setItem('ops_siparis_on_urun', JSON.stringify({
                              urun_ad: t.urun_ad,
                              urun_id: t.urun_id ?? null,
                              sube_id: t.sube_id ?? null,
                              tahmin_7gun: t.tahmin_7gun ?? null,
                              mevcut_stok: t.mevcut_stok ?? null,
                              kaynak: 'stok-tahmin',
                            }));
                          } catch (_) {}
                          acModulTab('toptanci-siparisleri');
                        }}
                      >
                        📦 Sipariş
                      </button>
                    ) : <span />}
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

      {aktifSekme === 'sube-notlar' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
            Şubelerin <strong>Merkez Notu</strong> ile gönderdiği mesajlar (iade, sorun, bilgi). Bu ekran <em>merkezden şubeye</em> giden
            «Merkez Mesajı» sekmesinden farklıdır — orası sizin şubeye yazdığınız mesajlardır.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
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
            <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => { setYukleniyor(true); yukleSubeNotlar().finally(() => setYukleniyor(false)); }}>
              ↻ Yenile
            </button>
          </div>
          {notlarListe.length === 0 ? (
            <div className="empty"><p>Bu filtrede şube notu yok</p></div>
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
      {aktifSekme === 'siparis-kontrol' && (
        <SiparisKontrolKulesi />
      )}

      {/* Eski paneller birleştirildi — SiparisKontrolKulesi */}
      {false && aktifSekme === 'stok-disiplin' && (
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
            // Tek liste için temiz yazdırma penceresi
            const _yazdirTekListe = (liste, subeAd, tarih, not_aciklama) => {
              const satirlar = liste.kalemler.map((k, idx) =>
                `<tr><td style="padding:12px 14px;font-size:18px;border-bottom:1px solid #e0e0e0">${idx + 1}. ${k.urun_ad}</td><td style="padding:12px 16px;font-size:22px;font-weight:900;text-align:right;border-bottom:1px solid #e0e0e0">× ${k.adet}</td></tr>`
              ).join('');
              const tarihStr = String(tarih || '').slice(0, 10) || new Date().toLocaleDateString('tr-TR');
              const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
                <title>${liste.toptanciAd} — ${subeAd}</title>
                <style>*{box-sizing:border-box;margin:0;padding:0}body{background:#fff;font-family:Arial,sans-serif}@media print{@page{margin:12mm}}</style>
                </head><body>
                <div style="padding:40px 44px;max-width:640px">
                  <div style="border-bottom:3px solid #111;padding-bottom:16px;margin-bottom:24px">
                    <div style="font-size:11px;color:#888;letter-spacing:0.1em;margin-bottom:8px">TOPTANCI SİPARİŞ LİSTESİ · Liste #${liste.listeNo}</div>
                    <div style="font-size:26px;font-weight:900">${subeAd}</div>
                    <div style="font-size:20px;font-weight:800;margin-top:8px">▸ ${liste.toptanciAd}</div>
                    <div style="font-size:13px;color:#666;margin-top:10px">📅 ${tarihStr} · ${liste.ts || ''}</div>
                  </div>
                  <table style="width:100%;border-collapse:collapse">${satirlar}</table>
                  ${not_aciklama ? `<div style="margin-top:24px;padding:12px 14px;background:#f5f5f5;border-radius:8px;font-size:13px;color:#555">Not: ${not_aciklama}</div>` : ''}
                  <div style="margin-top:28px;border-top:1px solid #ccc;padding-top:12px;font-size:12px;color:#aaa">
                    ${liste.kalemler.length} kalem · ${liste.kalemler.reduce((a, k) => a + k.adet, 0)} toplam adet
                  </div>
                </div>
                <script>window.onload=function(){window.print()};<\/script></body></html>`;
              const w = window.open('', '_blank', 'width=700,height=920');
              if (!w) { toast('Popup engellendi — tarayıcı izin ayarlarını kontrol edin.'); return; }
              w.document.write(html); w.document.close();
            };

            // Seçili kalemleri toptancı listesine ekle + ekrandan kaldır
            const listeOlustur = (sip) => {
              const talepId = String(sip?.id || '');
              const toptanciAd = (kuyrukToptanciTedarikci[talepId] || '').trim();
              if (!toptanciAd) { toast('Önce toptancı adını girin.'); return; }
              const rows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
              const kalemler = [];
              rows.forEach((k, i) => {
                const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                const key = `${talepId}::${kk}`;
                if (!toptanciSecili[key]) return;
                if (toptanciAtanmis[key]) return;
                const adetRaw = kuyrukToptanciKalemDeger[key] ?? String(k?.istenen_adet || 0);
                const adet = Math.max(0, parseInt(String(adetRaw), 10) || 0);
                if (adet <= 0) { toast(`${k.urun_ad || kk} için adet 0 — atlandı.`); return; }
                kalemler.push({ urun_ad: String(k?.urun_ad || k?.ad || kk), adet, kalem_kodu: kk, kategori_kod: String(k?.kategori_kod || '').trim() || null });
              });
              if (!kalemler.length) { toast('Hiç kalem seçilmedi ya da adetler 0.'); return; }
              const listeNo = (toptanciListeler[talepId] || []).length + 1;
              const yeniListe = { listeNo, toptanciAd, kalemler, ts: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
              setToptanciListeler(prev => ({ ...prev, [talepId]: [...(prev[talepId] || []), yeniListe] }));
              // Atanmış olarak işaretle
              setToptanciAtanmis(prev => {
                const next = { ...prev };
                kalemler.forEach(k => { next[`${talepId}::${k.kalem_kodu}`] = listeNo; });
                return next;
              });
              // Seçimi temizle
              setToptanciSecili(prev => {
                const next = { ...prev };
                kalemler.forEach(k => { next[`${talepId}::${k.kalem_kodu}`] = false; });
                return next;
              });
              // Toptancı adı inputunu temizle
              setKuyrukToptanciTedarikci(prev => ({ ...prev, [talepId]: '' }));
              // Otomatik yazdır
              _yazdirTekListe(yeniListe, sip.sube_adi || 'Şube', sip.tarih || '', (kuyrukToptanciNot[talepId] || '').trim());
            };

            // Son adım: tüm listeler sisteme kaydedilir, şubeye bildirim gider
            const toptanciyaYollaVeKapat = async (sip) => {
              const talepId = String(sip?.id || '').trim();
              const listeler = toptanciListeler[talepId] || [];
              if (!listeler.length) { toast('Önce en az bir liste oluşturun.'); return; }
              setKuyrukBusy(talepId);
              try {
                for (const liste of listeler) {
                  await api('/ops/siparis/toptanciya-yolla', {
                    method: 'POST',
                    body: {
                      talep_id: talepId,
                      tedarikci_ad: liste.toptanciAd,
                      not_aciklama: (kuyrukToptanciNot[talepId] || '').trim() || null,
                      kalemler: liste.kalemler,
                    },
                  });
                }
                const adlar = listeler.map(l => l.toptanciAd).join(', ');
                toast(`✓ ${listeler.length} toptancıya yönlendirildi — Şubeye bildirildi (${adlar})`, 'green');
                yukleDisiplin();
              } catch (e) {
                toast(e.message || 'Gönderim hatası');
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
                      Depo şubelerden "kısmi / yok" bildirimi gelmedi.
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
                                  try {
                                    sessionStorage.setItem('ops_kontrol_kulesi_gorunum', 'depo');
                                    sessionStorage.setItem('ops_kontrol_kulesi_depo', sid);
                                  } catch (_) {}
                                  window.location.hash = 'ops-merkez';
                                  acOpsModul('siparis-kontrol', 'siparis-tedarik');
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

                    {asama === 'toptanci' && (() => {
                      const talepId = String(sip.id || '');
                      const listeler = toptanciListeler[talepId] || [];
                      const rows = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
                      const atanmamisRows = rows.filter((k, i) => !toptanciAtanmis[`${talepId}::${String(k?.kalem_kodu || k?.urun_id || 'k_' + i)}`]);
                      const seciliSayisi = atanmamisRows.filter((k, i) => toptanciSecili[`${talepId}::${String(k?.kalem_kodu || k?.urun_id || 'k_' + i)}`]).length;
                      const hepsiAtandi = atanmamisRows.length === 0 && rows.length > 0;
                      return (
                        <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 14 }}>

                          {/* Başlık */}
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <div>
                              <span style={{ fontWeight: 700, fontSize: 13 }}>🚚 Toptancı Ayırma</span>
                              <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 10 }}>
                                Kalem seç → toptancı yaz → Liste Oluştur → fotoğrafla → tekrarla
                              </span>
                            </div>
                            {listeler.length > 0 && (
                              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ok)' }}>✓ {listeler.length} liste oluşturuldu</span>
                            )}
                          </div>

                          {/* Oluşturulan listeler */}
                          {listeler.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Oluşturulan Listeler</div>
                              {listeler.map((liste) => (
                                <div key={liste.listeNo} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8 }}>
                                  <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--ok)', flexShrink: 0 }}>#{liste.listeNo}</span>
                                  <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{liste.toptanciAd}</span>
                                  <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{liste.kalemler.length} kalem · {liste.kalemler.reduce((a, k) => a + k.adet, 0)} adet</span>
                                  <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, padding: '3px 10px', flexShrink: 0 }}
                                    onClick={() => _yazdirTekListe(liste, sip.sube_adi || 'Şube', sip.tarih || '', (kuyrukToptanciNot[talepId] || '').trim())}>
                                    🖨️ Tekrar Yazdır
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Kalan kalemler */}
                          {hepsiAtandi ? (
                            <div style={{ padding: '12px 14px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.28)', borderRadius: 10, fontSize: 13, color: 'var(--ok)', fontWeight: 700 }}>
                              ✅ Tüm kalemler toptancılara atandı — aşağıdan gönderebilirsiniz
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                                  Kalan Kalemler ({atanmamisRows.length})
                                </span>
                                {atanmamisRows.length > 1 && (
                                  <button className="btn btn-sm btn-secondary" style={{ fontSize: 11, padding: '2px 10px' }}
                                    onClick={() => {
                                      const next = { ...toptanciSecili };
                                      rows.forEach((k, i) => {
                                        const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                                        if (!toptanciAtanmis[`${talepId}::${kk}`]) next[`${talepId}::${kk}`] = true;
                                      });
                                      setToptanciSecili(next);
                                    }}>
                                    Tümünü Seç
                                  </button>
                                )}
                              </div>

                              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                                {atanmamisRows.map((k, i) => {
                                  const kk = String(k?.kalem_kodu || k?.urun_id || `k_${i}`);
                                  const key = `${talepId}::${kk}`;
                                  const secili = !!toptanciSecili[key];
                                  const adetVal = kuyrukToptanciKalemDeger[key] ?? String(k?.istenen_adet || 0);
                                  const subeIstedi = Number(k?.istened_adet || k?.istenen_adet || 0);
                                  const gonderilecek = parseInt(String(adetVal || '0'), 10) || 0;
                                  const farkli = gonderilecek > 0 && gonderilecek !== subeIstedi;
                                  return (
                                    <div key={key}
                                      style={{ display: 'grid', gridTemplateColumns: '32px 1fr 72px 80px', alignItems: 'center', gap: 8, padding: '8px 12px',
                                        borderBottom: i < atanmamisRows.length - 1 ? '1px solid var(--border)' : 'none',
                                        background: secili ? 'rgba(59,130,246,0.08)' : 'transparent', cursor: 'pointer' }}
                                      onClick={() => setToptanciSecili(prev => ({ ...prev, [key]: !prev[key] }))}>
                                      <input type="checkbox" checked={secili} readOnly style={{ width: 18, height: 18, accentColor: 'var(--accent)', cursor: 'pointer' }} />
                                      <span style={{ fontSize: 13, fontWeight: secili ? 700 : 400 }}>{k.urun_ad || k.ad || kk}</span>
                                      <span style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>× {subeIstedi}</span>
                                      <input className="input" inputMode="numeric" value={adetVal}
                                        style={{ width: 72, textAlign: 'center', fontSize: 13, fontWeight: 700,
                                          borderColor: farkli ? 'var(--warn)' : undefined, color: farkli ? 'var(--warn)' : undefined }}
                                        onClick={e => e.stopPropagation()}
                                        onChange={(e) => {
                                          const v = String(e.target.value || '').replace(/[^\d]/g, '');
                                          setKuyrukToptanciKalemDeger(prev => ({ ...prev, [key]: v }));
                                        }} />
                                    </div>
                                  );
                                })}
                              </div>

                              {/* Seçili kalemler → toptancı adı → liste oluştur */}
                              {seciliSayisi > 0 && (
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', whiteSpace: 'nowrap' }}>{seciliSayisi} kalem seçili →</span>
                                  <input className="input" list={`toptanci-dl-${talepId}`} placeholder="Toptancı adı…"
                                    value={kuyrukToptanciTedarikci[talepId] || ''}
                                    style={{ flex: 1, minWidth: 140, fontSize: 13 }}
                                    onChange={(e) => setKuyrukToptanciTedarikci(prev => ({ ...prev, [talepId]: e.target.value }))} />
                                  <datalist id={`toptanci-dl-${talepId}`}>
                                    {(toptanciSiparisListe?.gonderimler || []).map(g => (g.tedarikci_ad || '').trim()).filter(Boolean)
                                      .filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 20).map(v => <option key={v} value={v} />)}
                                  </datalist>
                                  <button className="btn btn-sm btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => listeOlustur(sip)}>
                                    📋 Liste Oluştur & Yazdır
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Not + Final */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <textarea className="input" rows={2} style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
                              placeholder="Genel not (listelerde görünür)…"
                              value={kuyrukToptanciNot[talepId] || ''}
                              onChange={(e) => setKuyrukToptanciNot(prev => ({ ...prev, [talepId]: e.target.value }))} />
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <button className="btn btn-sm btn-primary"
                                disabled={kuyrukBusy === talepId || listeler.length === 0}
                                style={{ opacity: listeler.length === 0 ? 0.45 : 1 }}
                                onClick={() => toptanciyaYollaVeKapat(sip)}>
                                {kuyrukBusy === talepId ? '…' : `⇢ Toptancıya Yolla & Şubeye Bildir (${listeler.length} liste)`}
                              </button>
                              {listeler.length === 0 && <span style={{ fontSize: 11, color: 'var(--text3)' }}>Önce en az bir liste oluşturun</span>}
                            </div>
                          </div>

                        </div>
                      );
                    })()}
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
            const uyumsuzlukSayisi = tumAkis.filter((s) => s.kabul_durum === 'kabul_uyusmazlik').length;
            return (
              <div>
                {/* 🚨 Kör denetim uyuşmazlık uyarı banner — görünür, merkez gözden kaçıramaz */}
                {uyumsuzlukSayisi > 0 && (
                  <div
                    onClick={() => setAkisFiltre('uyumsuzluk')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      background: 'rgba(239,68,68,0.14)', border: '1.5px solid rgba(239,68,68,0.55)',
                      borderRadius: 10, padding: '10px 14px', marginBottom: 12, cursor: 'pointer',
                      animation: 'pulse 1.6s ease-in-out infinite',
                    }}>
                    <span style={{ fontSize: 20 }}>🚨</span>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 13, color: '#fca5a5' }}>
                        {uyumsuzlukSayisi} teslim kabulü uyumsuzluğu — şube sayımı ile depo gönderimi eşleşmiyor
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                        Kör denetim sonucu otomatik tespit edildi. Şube personeli detayları göremiyor. Tıkla → detay.
                      </div>
                    </div>
                    <span style={{
                      marginLeft: 'auto', background: '#ef4444', color: '#fff',
                      borderRadius: 999, padding: '2px 9px', fontSize: 12, fontWeight: 800, flexShrink: 0,
                    }}>{uyumsuzlukSayisi}</span>
                  </div>
                )}
                {/* Filtre + başlık */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, marginRight: 4 }}>🔄 Sipariş Akışı</span>
                  {FILTRELER.map((f) => {
                    const fSayisi = f.key === 'uyumsuzluk' ? uyumsuzlukSayisi : 0;
                    return (
                      <button key={f.key} type="button"
                        className={'btn btn-sm ' + (akisFiltre === f.key ? 'btn-primary' : 'btn-secondary')}
                        style={{
                          fontSize: 11, padding: '3px 10px', position: 'relative',
                          ...(f.key === 'uyumsuzluk' && fSayisi > 0 && akisFiltre !== 'uyumsuzluk'
                            ? { borderColor: '#ef4444', color: '#fca5a5' } : {}),
                        }}
                        onClick={() => setAkisFiltre(f.key)}>
                        {f.label}
                        {fSayisi > 0 && (
                          <span style={{
                            position: 'absolute', top: -6, right: -6,
                            background: '#ef4444', color: '#fff', borderRadius: 999,
                            minWidth: 16, height: 16, fontSize: 10, fontWeight: 800,
                            lineHeight: '16px', textAlign: 'center', padding: '0 4px',
                          }}>{fSayisi}</span>
                        )}
                      </button>
                    );
                  })}
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
                                  {(s.tahsis || []).map((t, idx) => {
                                    const tlp = Number(t.talep_adet || 0);
                                    const ths = Number(t.tahsis_adet || 0);
                                    const fark = tlp !== ths;
                                    const uzlasildi = !!t.uzlasildi;
                                    return (
                                      <div key={idx} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, padding: '4px 0' }}>
                                        <span style={{ flex: 1 }}>{t.kalem_adi || t.kalem_kodu}</span>
                                        <span className="mono" style={{ color: 'var(--text3)' }}>Talep: {tlp}</span>
                                        <span className="mono" style={{ color: 'var(--text3)' }}>Tahsis: {ths}</span>
                                        <span className="badge" style={{ fontSize: 10 }}>{t.durum}</span>
                                        {fark && !uzlasildi && (
                                          <button
                                            type="button"
                                            onClick={() => setTahsisCozModal({
                                              talep_id: s.id || s.talep_id,
                                              urun_id: t.kalem_kodu || t.urun_id,
                                              kalem_adi: t.kalem_adi || t.kalem_kodu,
                                              talep_adet: tlp,
                                              tahsis_adet: ths,
                                              cozum_adet: ths,
                                              notu: '',
                                            })}
                                            style={{
                                              fontSize: 10, padding: '2px 8px', borderRadius: 4,
                                              background: '#f59e0b', borderColor: '#f59e0b',
                                              color: '#000', border: '1px solid #f59e0b', cursor: 'pointer',
                                            }}
                                            title="Sipariş-Tahsis uyumsuzluğunu uzlaştır"
                                          >
                                            ⚙ Düzelt
                                          </button>
                                        )}
                                        {uzlasildi && (
                                          <span style={{ fontSize: 10, color: '#86efac' }}>✓ Uzlaşıldı</span>
                                        )}
                                      </div>
                                    );
                                  })}
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

      {/* Sipariş-Tahsis Uyumsuzluk Çöz Modal */}
      {tahsisCozModal && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !tahsisCozBusy) setTahsisCozModal(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
          <div className="card" style={{ width: 480, maxWidth: '95vw', padding: 22 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>
              ⚙ Sipariş ↔ Tahsis Uzlaşması
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text3)' }}>
              <strong>{tahsisCozModal.kalem_adi}</strong><br />
              Talep: <span className="mono">{tahsisCozModal.talep_adet}</span> ·
              Tahsis: <span className="mono">{tahsisCozModal.tahsis_adet}</span> ·
              Fark: <strong style={{ color: '#fbbf24' }}>{tahsisCozModal.talep_adet - tahsisCozModal.tahsis_adet}</strong>
            </p>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 10 }}>
              Uzlaşma adedi
              <input
                type="number" min="0" step="1" className="input"
                disabled={tahsisCozBusy}
                value={tahsisCozModal.cozum_adet}
                onChange={(e) => setTahsisCozModal((prev) => ({ ...prev, cozum_adet: Number(e.target.value) }))}
                style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
              />
            </label>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 14 }}>
              Not (opsiyonel)
              <textarea
                className="input" rows={2}
                disabled={tahsisCozBusy}
                value={tahsisCozModal.notu || ''}
                onChange={(e) => setTahsisCozModal((prev) => ({ ...prev, notu: e.target.value }))}
                placeholder="örn. Stok yetersiz, kalan adet iptal kabul edildi."
                style={{ width: '100%', marginTop: 3, padding: '6px 8px', resize: 'vertical' }}
              />
            </label>

            <p style={{ fontSize: 10, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.5 }}>
              💡 Uzlaşma adedi hem talep hem tahsisin yeni değeri olur. Kalem "tam" duruma geçer ve audit'e yazılır.
            </p>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button type="button" className="btn btn-secondary"
                disabled={tahsisCozBusy}
                onClick={() => setTahsisCozModal(null)}>İptal</button>
              <button type="button" className="btn btn-primary"
                disabled={tahsisCozBusy}
                onClick={async () => {
                  setTahsisCozBusy(true);
                  try {
                    const resp = await fetch('/api/ops/siparis/talep-tahsis-uyumsuzluk-coz', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        talep_id: tahsisCozModal.talep_id,
                        urun_id:  tahsisCozModal.urun_id,
                        cozum_adet: tahsisCozModal.cozum_adet,
                        notu: tahsisCozModal.notu,
                      }),
                    });
                    const data = await resp.json().catch(() => null);
                    if (!resp.ok) {
                      const msg = data?.detail || data?.message || `HTTP ${resp.status}`;
                      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
                    }
                    setTahsisCozModal(null);
                    // Sayfayı yenile (mevcut yenile fonksiyonu varsa kullanılabilir)
                    if (typeof yenile === 'function') yenile();
                    else window.location.reload();
                  } catch (err) {
                    alert('Uzlaşma kaydedilemedi: ' + (err.message || err));
                  } finally {
                    setTahsisCozBusy(false);
                  }
                }}
                style={{ background: '#f59e0b', borderColor: '#f59e0b' }}>
                {tahsisCozBusy ? 'Kaydediliyor…' : 'Uzlaş ve Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kasa Farkı Kaynak Düzeltme Modal */}
      {kkDuzeltModal && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !kkDuzeltBusy) setKkDuzeltModal(null); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
          <div className="card" style={{ width: 540, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', padding: 24 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 700 }}>
              🔧 Kasa Farkı — Kaynak Düzeltme
            </h3>
            <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text3)' }}>
              {kkDuzeltModal.uyari?.sube_adi} · {kkDuzeltModal.uyari?.tarih} · Mevcut fark:{' '}
              <strong className="mono" style={{ color: (() => {
                const fn = Number(kkDuzeltModal.uyari?.fark_tl || 0);
                const acik = kkDuzeltModal.uyari?.tip === 'ACILIS_KASA_FARK' ? fn < 0 : fn > 0;
                return acik ? '#fca5a5' : fn === 0 ? 'var(--text2)' : '#86efac';
              })() }}>
                {Number(kkDuzeltModal.uyari?.fark_tl || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺
              </strong>
              <span style={{ display: 'block', marginTop: 4, fontSize: 11 }}>
                {kkDuzeltModal.uyari?.tip === 'ACILIS_KASA_FARK'
                  ? 'Devir: + sabah fazla saydı, − sabah eksik saydı'
                  : 'Kapanış: + kasa açığı (eksik nakit), − kasa fazlası'}
              </span>
            </p>

            {/* ── Onaysız ciro uyarısı (z_nakit=0 + KAPANIS) ── */}
            {kkDuzeltModal.uyari?.tip === 'KAPANIS_KASA_FARK' &&
              (kkDuzeltModal.uyari?.detay_json?.z_nakit ?? -1) === 0 &&
              Math.abs(Number(kkDuzeltModal.uyari?.fark_tl || 0)) > 50 && (
              <div style={{
                background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)',
                borderRadius: 8, padding: '10px 13px', marginBottom: 16,
                display: 'flex', gap: 10, alignItems: 'flex-start',
              }}>
                <span style={{ fontSize: 18, lineHeight: 1.2, flexShrink: 0 }}>⚠️</span>
                <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                  <strong style={{ color: '#fbbf24', display: 'block', marginBottom: 2 }}>
                    Z Nakit 0₺ görünüyor — önce ciro onayını kontrol et
                  </strong>
                  <span style={{ color: 'var(--text3)' }}>
                    Şube ciro girişi henüz onaylanmamış olabilir. Ciro onaylanırsa fark otomatik kapanır — buradaki düzeltmeye gerek kalmaz.
                  </span>
                  <button
                    onClick={() => { setKkDuzeltModal(null); acOpsModul('ciro-onay', 'finans-kasa'); }}
                    style={{
                      display: 'inline-block', marginTop: 7, padding: '4px 10px',
                      fontSize: 11, fontWeight: 600, borderRadius: 5, cursor: 'pointer',
                      background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.4)',
                      color: '#fbbf24',
                    }}>
                    → Bekleyen Ciro Onayları'na git
                  </button>
                </div>
              </div>
            )}

            {/* ── Devir uyumsuzluğu için de z_nakit kontrolü — ACILIS ── */}
            {kkDuzeltModal.uyari?.tip === 'ACILIS_KASA_FARK' && (
              <div style={{
                background: 'rgba(99,179,237,0.08)', border: '1px solid rgba(99,179,237,0.25)',
                borderRadius: 8, padding: '9px 13px', marginBottom: 16,
                fontSize: 11, color: 'var(--text3)', lineHeight: 1.55,
              }}>
                💡 <strong style={{ color: 'var(--text2)' }}>Devir uyumsuzluğu:</strong>{' '}
                Sabahçı az saydıysa → <em>Sabahçı sayımı yanlış</em> seç, doğru tutarı gir.
                Akşamcı yanlış bıraktıysa → <em>Akşamcı devir/teslim yanlış</em> seç.
                Emin değilsen önce <em>Gerçek açık</em>'ı seç ve notu yaz.
              </div>
            )}

            {/* 🔢 DEĞERİ DÜZELT — yanlış kutuyu değiştir, sistem otomatik algılar */}
            {(() => {
              const dj = kkDuzeltModal.uyari?.detay_json || {};
              const tip = kkDuzeltModal.uyari?.tip;
              const kutular = [{ label: '🌅 Açılış kasası', sebep: 'acilis_yanlis', pkey: 'yeni_acilis_kasa', val: dj.acilis_kasa }];
              if (tip === 'KAPANIS_KASA_FARK') kutular.push({ label: '📝 Nakit ciro (Z)', sebep: 'ciro_yanlis', pkey: 'yeni_nakit', val: dj.z_nakit });
              kutular.push({ label: '💵 Müdüre teslim', sebep: 'devir_yanlis', pkey: 'yeni_teslim', val: dj.teslim });
              kutular.push({ label: '🌙 Kasada kalan (devir)', sebep: 'devir_yanlis', pkey: 'yeni_devir', val: dj.devir });
              const fmtMev = (v) => (v != null && Number.isFinite(Number(v))) ? Number(v).toLocaleString('tr-TR') : '—';
              const fark = Number(kkDuzeltModal.uyari?.fark_tl || 0);
              const gercekFazla = (tip === 'ACILIS_KASA_FARK' ? fark > 0 : fark < 0);
              return (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.5 }}>
                    Sadece <strong>yanlış olan kutuyu</strong> değiştir; sistem hangisini değiştirdiğini otomatik anlar, gerçek kaydı düzeltip farkı yeniden hesaplar.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {kutular.map((k) => {
                      const editVal = (kkDuzeltModal.sebep === k.sebep) ? kkDuzeltModal.payload?.[k.pkey] : undefined;
                      const aktif = editVal != null;
                      return (
                        <label key={k.pkey} style={{ fontSize: 11, color: 'var(--text3)' }}>
                          {k.label} <span style={{ color: 'var(--text2)' }}>· mevcut {fmtMev(k.val)}</span>
                          <input
                            type="number" step="0.01" className="input" disabled={kkDuzeltBusy}
                            value={editVal ?? (k.val ?? '')}
                            onChange={(e) => {
                              const v = e.target.value === '' ? undefined : Number(e.target.value);
                              setKkDuzeltModal((prev) => ({ ...prev, gelismis: false, sebep: k.sebep, payload: { [k.pkey]: v } }));
                            }}
                            style={{ width: '100%', marginTop: 3, padding: '7px 9px', borderColor: aktif ? 'var(--accent)' : undefined, fontWeight: aktif ? 700 : undefined }}
                          />
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button" disabled={kkDuzeltBusy}
                    onClick={() => setKkDuzeltModal((prev) => ({ ...prev, gelismis: false, sebep: 'gercek_acik', payload: {} }))}
                    style={{ marginTop: 10, width: '100%', padding: '8px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
                      background: kkDuzeltModal.sebep === 'gercek_acik' ? 'rgba(220,38,38,0.18)' : 'var(--bg2)',
                      border: '1px solid ' + (kkDuzeltModal.sebep === 'gercek_acik' ? 'rgba(220,38,38,0.5)' : 'var(--border)'),
                      color: kkDuzeltModal.sebep === 'gercek_acik' ? '#fca5a5' : 'var(--text2)', fontWeight: kkDuzeltModal.sebep === 'gercek_acik' ? 700 : 500 }}>
                    ⚠️ Veri doğru, fark gerçek {gercekFazla ? 'fazla' : 'açık'} (kaynak değişmez, çözüldü işaretle)
                  </button>
                  <button
                    type="button" disabled={kkDuzeltBusy}
                    onClick={() => setKkDuzeltModal((prev) => ({ ...prev, gelismis: !prev.gelismis }))}
                    style={{ marginTop: 8, fontSize: 11, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', textDecoration: 'underline' }}>
                    {kkDuzeltModal.gelismis ? '▲ Gelişmişi gizle' : '⚙️ Gelişmiş (eksik gider / Z fazla / sebep seç)'}
                  </button>
                </div>
              );
            })()}

            {kkDuzeltModal.gelismis && (<>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Sebep</label>
            <select
              className="input"
              value={kkDuzeltModal.sebep}
              disabled={kkDuzeltBusy}
              onChange={(e) => setKkDuzeltModal((prev) => ({ ...prev, sebep: e.target.value, payload: {} }))}
              style={{ width: '100%', marginBottom: 16, padding: '8px 10px' }}
            >
              {(() => {
                const farkNum = Number(kkDuzeltModal.uyari?.fark_tl || 0);
                const isDevir = kkDuzeltModal.uyari?.tip === 'ACILIS_KASA_FARK';
                const fazla = isDevir ? farkNum > 0 : farkNum < 0;
                if (isDevir) {
                  return (
                    <>
                      <option value="acilis_yanlis">🌅 Sabahçı kasa sayımı yanlış (bugünkü açılış)</option>
                      <option value="devir_yanlis">🌙 Akşamcı devir/teslim yanlış (önceki gün kapanış)</option>
                      <option value="gercek_acik">
                        {fazla ? '⚠️ Gerçek fazla — kaynak değişmez' : '⚠️ Gerçek açık — kaynak değişmez'}
                      </option>
                    </>
                  );
                }
                return (
                  <>
                    <option value="ciro_yanlis">📝 Ciro yanlış (nakit / POS / online)</option>
                    {fazla ? (
                      <option value="ciro_fazla">💰 Z eksik basılmış — nakit ciroya ekle</option>
                    ) : (
                      <option value="gider_eksik">💸 Eksik nakit gider (anlık gidere ekle)</option>
                    )}
                    <option value="devir_yanlis">🌙 Kapanış teslim / devir yanlış (aynı gün)</option>
                    <option value="acilis_yanlis">🌅 Açılış kasa sayımı yanlış</option>
                    <option value="gercek_acik">
                      {fazla ? '⚠️ Gerçek fazla — kaynak değişmez' : '⚠️ Gerçek açık — kaynak değişmez'}
                    </option>
                  </>
                );
              })()}
            </select>

            {/* Sebebe göre dinamik form */}
            {kkDuzeltModal.sebep === 'ciro_yanlis' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                {['yeni_nakit', 'yeni_pos', 'yeni_online'].map((k) => (
                  <label key={k} style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {k.replace('yeni_', '').toUpperCase()} (₺)
                    <input
                      type="number" step="0.01" className="input"
                      placeholder="Boş = değiştirme"
                      disabled={kkDuzeltBusy}
                      value={kkDuzeltModal.payload[k] ?? ''}
                      onChange={(e) => setKkDuzeltModal((prev) => ({
                        ...prev,
                        payload: { ...prev.payload, [k]: e.target.value === '' ? undefined : Number(e.target.value) },
                      }))}
                      style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                    />
                  </label>
                ))}
              </div>
            )}

            {kkDuzeltModal.sebep === 'acilis_yanlis' && (
              <label style={{ fontSize: 12, display: 'block', marginBottom: 14 }}>
                Yeni açılış kasa sayımı (₺)
                <input
                  type="number" step="0.01" min="0" className="input"
                  disabled={kkDuzeltBusy}
                  value={kkDuzeltModal.payload.yeni_acilis_kasa ?? ''}
                  onChange={(e) => setKkDuzeltModal((prev) => ({
                    ...prev,
                    payload: { ...prev.payload, yeni_acilis_kasa: e.target.value === '' ? undefined : Number(e.target.value) },
                  }))}
                  style={{ width: '100%', marginTop: 4, padding: '8px 10px' }}
                  required
                />
              </label>
            )}

            {kkDuzeltModal.sebep === 'devir_yanlis' && (() => {
              const _dj = kkDuzeltModal.uyari?.detay_json || {};
              const _mevTeslim = _dj.teslim != null ? Number(_dj.teslim) : null;
              const _mevDevir  = _dj.devir  != null ? Number(_dj.devir)  : null;
              const _fmtMev = (v) => v != null
                ? `Mevcut: ${v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺ — boş bırakırsan korunur`
                : 'Boş bırakırsan değişmez';
              return (
                <>
                  {kkDuzeltModal.uyari?.tip === 'ACILIS_KASA_FARK' && (
                    <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 10px', lineHeight: 1.45 }}>
                      Devir uyumsuzluğu: düzeltme <strong>önceki günün kapanış</strong> teslim/devir kaydına yazılır.
                    </p>
                  )}
                  <div style={{
                    background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.25)',
                    borderRadius: 7, padding: '7px 11px', marginBottom: 12, fontSize: 11, color: '#fde68a', lineHeight: 1.5,
                  }}>
                    ⚠️ <strong>Dikkat:</strong> 0 (sıfır) girersen o alan sıfırlanır — değiştirmek istemediğin alanı boş bırak.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                    {[
                      { k: 'yeni_teslim', label: 'Müdüre teslim (₺)', mev: _mevTeslim },
                      { k: 'yeni_devir',  label: 'Kasada kalan / devir (₺)', mev: _mevDevir },
                    ].map(({ k, label, mev }) => (
                      <label key={k} style={{ fontSize: 11, color: 'var(--text3)' }}>
                        {label}
                        {mev != null && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(251,191,36,.7)', fontWeight: 600 }}>
                            (şu an: {mev.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺)
                          </span>
                        )}
                        <input
                          type="number" step="0.01" className="input"
                          placeholder={_fmtMev(mev)}
                          disabled={kkDuzeltBusy}
                          value={kkDuzeltModal.payload[k] ?? ''}
                          onChange={(e) => setKkDuzeltModal((prev) => ({
                            ...prev,
                            payload: { ...prev.payload, [k]: e.target.value === '' ? undefined : Number(e.target.value) },
                          }))}
                          style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                        />
                      </label>
                    ))}
                  </div>
                </>
              );
            })()}

            {kkDuzeltModal.sebep === 'gider_eksik' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Kategori
                  <input
                    type="text" className="input"
                    disabled={kkDuzeltBusy}
                    value={kkDuzeltModal.payload.kategori ?? ''}
                    onChange={(e) => setKkDuzeltModal((prev) => ({
                      ...prev,
                      payload: { ...prev.payload, kategori: e.target.value },
                    }))}
                    placeholder="örn. Mutfak"
                    style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                  />
                </label>
                <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                  Tutar (₺)
                  <input
                    type="number" step="0.01" min="0" className="input"
                    disabled={kkDuzeltBusy}
                    value={kkDuzeltModal.payload.tutar ?? ''}
                    onChange={(e) => setKkDuzeltModal((prev) => ({
                      ...prev,
                      payload: { ...prev.payload, tutar: e.target.value === '' ? undefined : Number(e.target.value) },
                    }))}
                    placeholder={Math.abs(Number(kkDuzeltModal.uyari?.fark_tl||0)).toFixed(2)}
                    style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                  />
                </label>
                <label style={{ fontSize: 11, color: 'var(--text3)', gridColumn: '1 / -1' }}>
                  Açıklama (opsiyonel)
                  <input
                    type="text" className="input"
                    disabled={kkDuzeltBusy}
                    value={kkDuzeltModal.payload.aciklama ?? ''}
                    onChange={(e) => setKkDuzeltModal((prev) => ({
                      ...prev,
                      payload: { ...prev.payload, aciklama: e.target.value },
                    }))}
                    style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                  />
                </label>
              </div>
            )}

            {kkDuzeltModal.sebep === 'ciro_fazla' && (() => {
              const farkAbs = Math.abs(Number(kkDuzeltModal.uyari?.fark_tl || 0));
              return (
                <>
                  <div style={{
                    background: 'rgba(34,197,94,0.10)',
                    border: '1px solid rgba(34,197,94,0.35)',
                    borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 11,
                    color: '#86efac', lineHeight: 1.5,
                  }}>
                    <strong>Kasa fazlası → Ciroya nakit ekle</strong> —
                    Z raporu eksik basılmış olabilir; kasada beklenenden{' '}
                    <strong>{farkAbs.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}₺</strong>
                    {' '}fazla var. Bu tutar mevcut nakit ciroya <strong>eklenir</strong> (Cash Over =
                    bildirilmemiş satış). POS/online dokunulmaz.
                  </div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 14 }}>
                    Ciroya eklenecek nakit (₺)
                    <input
                      type="number" step="0.01" min="0" className="input"
                      disabled={kkDuzeltBusy}
                      value={kkDuzeltModal.payload.tutar ?? ''}
                      onChange={(e) => setKkDuzeltModal((prev) => ({
                        ...prev,
                        payload: { ...prev.payload, tutar: e.target.value === '' ? undefined : Number(e.target.value) },
                      }))}
                      placeholder={farkAbs.toFixed(2)}
                      style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}
                    />
                  </label>
                </>
              );
            })()}

            {kkDuzeltModal.sebep === 'gercek_acik' && (() => {
              const farkNum = Number(kkDuzeltModal.uyari?.fark_tl || 0);
              const fazla = farkNum > 0;
              return (
                <div style={{
                  background: fazla ? 'rgba(34,197,94,0.10)' : 'rgba(220,38,38,0.10)',
                  border: `1px solid ${fazla ? 'rgba(34,197,94,0.30)' : 'rgba(220,38,38,0.30)'}`,
                  borderRadius: 6, padding: 12, marginBottom: 14, fontSize: 12,
                  color: fazla ? '#86efac' : '#fca5a5', lineHeight: 1.5,
                }}>
                  Bu seçim ile kaynak veriler (ciro/açılış/gider) <strong>değişmez</strong>.
                  Mevcut {fazla ? 'fazla' : 'açık'} olduğu gibi kalır, kayıt "çözüldü" olarak
                  işaretlenir; {fazla
                    ? 'fazla tutar muhasebede ayrıca raporlanır (Cash Over).'
                    : 'kasa açığı personele/şubeye yansır.'}
                </div>
              );
            })()}
            </>)}

            {/* Not */}
            <label style={{ display: 'block', fontSize: 12, marginBottom: 18 }}>
              Çözüm notu (opsiyonel)
              <textarea
                className="input"
                rows={2}
                disabled={kkDuzeltBusy}
                value={kkDuzeltModal.payload._notu ?? ''}
                onChange={(e) => setKkDuzeltModal((prev) => ({
                  ...prev,
                  payload: { ...prev.payload, _notu: e.target.value },
                }))}
                placeholder="örn. Açılış sayımında 200₺ atlanmış, kasiyer doğrulandı."
                style={{ width: '100%', marginTop: 4, padding: '8px 10px', resize: 'vertical' }}
              />
            </label>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <button
                type="button" className="btn btn-secondary"
                disabled={kkDuzeltBusy}
                onClick={() => setKkDuzeltModal(null)}
              >
                İptal
              </button>
              <button
                type="button" className="btn btn-primary"
                disabled={kkDuzeltBusy}
                onClick={kkDuzeltGonder}
                style={{ background: '#f59e0b', borderColor: '#f59e0b' }}
              >
                {kkDuzeltBusy ? 'Düzeltiliyor…' : '🔧 Düzelt ve Yeniden Hesapla'}
              </button>
            </div>

            <p style={{ fontSize: 10, color: 'var(--text3)', margin: '14px 0 0', lineHeight: 1.5 }}>
              💡 Kaynak güncellenecek → kasa formülü otomatik yeniden hesaplanır → onay kuyruğundaki KASA_FARK kaydı
              senkronize olur. Yeni fark 0₺ olursa kayıt otomatik "çözüldü" işaretlenir ve onay iptal edilir.
            </p>
          </div>
        </div>
      )}

      {/* ─── TARİHÇE MODAL — düzeltme audit + geri al ─────────────────────── */}
      {kkTarihceModal && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setKkTarihceModal(null); }}
        >
          <div className="card" style={{ width: 720, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                📜 Düzeltme Tarihçesi
              </h3>
              <button
                type="button" className="btn btn-sm"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setKkTarihceModal(null)}
              >
                ✕ Kapat
              </button>
            </div>
            <p style={{ margin: '0 0 18px', fontSize: 12, color: 'var(--text3)' }}>
              {kkTarihceModal.uyari?.sube_adi} · {kkTarihceModal.uyari?.tarih}
              {' · '}
              <span style={{ color: 'var(--text2)' }}>
                {kkTarihceModal.tarihce?.length || 0} düzeltme
              </span>
            </p>

            {kkTarihceModal.yukleniyor && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Yükleniyor…</div>
            )}

            {!kkTarihceModal.yukleniyor && kkTarihceModal.hata && (
              <div style={{
                padding: '14px 16px', textAlign: 'left',
                background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.40)',
                borderRadius: 8, fontSize: 13, color: '#fca5a5', marginBottom: 12,
              }}>
                <strong>⚠ Tarihçe yüklenemedi:</strong><br />
                {kkTarihceModal.hata}
                <button
                  type="button" className="btn btn-sm"
                  style={{ marginTop: 10, padding: '4px 12px', fontSize: 12 }}
                  onClick={() => kkTarihceModalAc(kkTarihceModal.uyari)}
                >
                  ↺ Tekrar dene
                </button>
              </div>
            )}

            {!kkTarihceModal.yukleniyor && !kkTarihceModal.hata && (!kkTarihceModal.tarihce || kkTarihceModal.tarihce.length === 0) && (
              <div style={{
                padding: 20, textAlign: 'center', color: 'var(--text3)',
                background: 'rgba(100,116,139,0.08)', border: '1px dashed var(--border)',
                borderRadius: 8, fontSize: 13,
              }}>
                Bu uyarı için henüz kaynak düzeltmesi yapılmamış.
              </div>
            )}

            {!kkTarihceModal.yukleniyor && kkTarihceModal.tarihce && kkTarihceModal.tarihce.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {kkTarihceModal.tarihce.map((a) => {
                  const fmtN = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                  const olusma = a.olusturma ? String(a.olusturma).slice(0, 16).replace('T', ' ') : '—';
                  const geriAlindi = !!a.geri_alindi_mi;
                  const busy = kkTarihceModal.geriAlBusyId === a.id;
                  return (
                    <div key={a.id} style={{
                      background: geriAlindi ? 'rgba(100,116,139,0.08)' : 'rgba(34,197,94,0.04)',
                      border: `1px solid ${geriAlindi ? 'var(--border)' : 'rgba(34,197,94,0.25)'}`,
                      borderRadius: 10,
                      padding: '12px 14px',
                      opacity: geriAlindi ? 0.7 : 1,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <span style={{
                              background: geriAlindi ? 'rgba(148,163,184,0.2)' : 'rgba(245,158,11,0.18)',
                              color: geriAlindi ? '#94a3b8' : '#fcd34d',
                              padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                            }}>
                              {a.sebep}
                            </span>
                            {geriAlindi && (
                              <span style={{
                                background: 'rgba(239,68,68,0.15)', color: '#fca5a5',
                                padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                              }}>
                                ↶ GERİ ALINDI
                              </span>
                            )}
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{olusma}</span>
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>
                            <strong className="mono">Fark:</strong>{' '}
                            <span className="mono">{fmtN(a.eski_fark_tl)}₺</span>
                            {' → '}
                            <span className="mono" style={{ color: Math.abs(Number(a.yeni_fark_tl||0)) < 0.01 ? '#86efac' : '#fcd34d' }}>
                              {fmtN(a.yeni_fark_tl)}₺
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            <strong>Hedef:</strong> {a.hedef_tablo || '(kaynak değişmedi)'}
                            {a.personel_ad && <> · <strong>Yapan:</strong> {a.personel_ad}</>}
                          </div>
                          {a.notu && (
                            <div style={{ marginTop: 6, padding: '6px 10px', background: 'var(--bg2)', borderRadius: 6, fontSize: 11, color: 'var(--text2)', fontStyle: 'italic' }}>
                              💬 {a.notu}
                            </div>
                          )}
                          {geriAlindi && a.geri_alma_ts && (
                            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text3)' }}>
                              Geri alındı: {String(a.geri_alma_ts).slice(0, 16).replace('T', ' ')}
                              {a.geri_alan_personel_ad && <> · {a.geri_alan_personel_ad}</>}
                            </div>
                          )}
                        </div>
                        {!geriAlindi && (
                          <button
                            type="button" className="btn btn-sm"
                            style={{
                              padding: '6px 12px', background: 'rgba(239,68,68,0.15)',
                              border: '1px solid rgba(239,68,68,0.4)', color: '#fca5a5',
                              fontSize: 12, fontWeight: 700, flexShrink: 0,
                            }}
                            disabled={busy || !!kkTarihceModal.geriAlBusyId}
                            onClick={() => kkTarihceGeriAl(a)}
                          >
                            {busy ? '…' : '↶ Geri Al'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p style={{ fontSize: 10, color: 'var(--text3)', margin: '16px 0 0', lineHeight: 1.5 }}>
              💡 Geri Al: ilgili tabloda eski değerler restore edilir, kasa farkı yeniden hesaplanır. Audit kaydı silinmez,
              "geri alındı" olarak işaretlenir (her şey log'da kalır).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
