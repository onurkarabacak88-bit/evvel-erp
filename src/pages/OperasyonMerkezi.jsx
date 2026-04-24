import { useState, useEffect, useCallback, useRef } from 'react';
import { api, fmt } from '../utils/api';
import { computeOpsKartVurgu } from '../utils/opsVurgu';
import { publishGlobalDataRefresh, subscribeGlobalDataRefresh } from '../utils/globalDataRefresh';

/** Backend’in statik şube paneli (`GET /sube-panel/{id}`) — API ile aynı kök (VITE_API_URL). */
function subePanelHariciUrl(subeId) {
  const sid = String(subeId || '').trim();
  if (!sid) return '';
  const raw = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  const origin = raw || (typeof window !== 'undefined' ? String(window.location.origin || '').replace(/\/+$/, '') : '');
  if (!origin) return '';
  return `${origin}/sube-panel/${encodeURIComponent(sid)}`;
}

/** Mağaza depo katalog — şube paneli `siparisNormalize` ile aynı mantık (ayrı dosya Docker’da eksik kalmasın diye burada). */
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
  { id: 'ciro-onay', label: '💳 Bekleyen Ciro Onayları' },
  { id: 'kasa-uyumsuzluk', label: '🔴 Kasa Uyumsuzluğu' },
  { id: 'urun-uyumsuzluk', label: '🧪 Ürün Uyumsuzlukları' },
  { id: 'magaza-kartlari', label: '🏪 Depo stokları' },
  { id: 'kontrol', label: '🔍 Kontrol' },
  { id: 'metrics', label: '📊 Metrikler' },
  { id: 'stok-kayip', label: '📉 Stok Kayıp' },
  { id: 'personel-davranis', label: '👤 Personel Davranış' },
  { id: 'fis', label: '🧾 Fiş Kontrol' },
  { id: 'defter', label: 'Defter Kayıtları' },
  { id: 'sayim', label: 'Açılış Sayımları' },
  { id: 'siparis', label: '📦 Sipariş katalog' },
  { id: 'siparis-kabul-takip', label: '📥 Sipariş kabul takibi' },
  { id: 'toptanci-siparisleri', label: '🚚 Toptancı siparişleri' },
  { id: 'mesaj', label: '📩 Merkez Mesajı' },
  { id: 'puan', label: '⭐ Personel Puan' },
  { id: 'stok-disiplin', label: '🔴 Stok Disiplin' },
];

/** Modül penceresi içi başlık sekmeleri (CFO kart drill-down benzeri) */
const OPS_MODUL_BOLUM = {
  canli: [
    { id: 'ozet', label: 'Özet' },
    { id: 'subeler', label: 'Şubeler' },
    { id: 'karsilastirma', label: 'Karşılaştırma' },
  ],
  'urun-ac': [{ id: 'icerik', label: 'Günlük akış' }],
  'gec-acilan-subeler': [{ id: 'icerik', label: 'Günlük akış' }],
  'gec-kalan-personel': [{ id: 'icerik', label: 'Aylık analiz' }],
  'kullanilan-urunler': [{ id: 'icerik', label: 'Günlük akış' }],
  'ciro-onay': [{ id: 'icerik', label: 'Onay akışı' }],
  'kasa-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'urun-uyumsuzluk': [{ id: 'icerik', label: 'Günlük akış' }],
  'magaza-kartlari': [{ id: 'icerik', label: 'Şubeler' }],
  metrics: [
    { id: 'personel', label: 'Personel verimlilik' },
    { id: 'sube', label: 'Şube operasyon' },
    { id: 'finans', label: 'Finans özet' },
    { id: 'stok', label: 'Stok & tedarik' },
  ],
  kontrol: [{ id: 'icerik', label: 'Kontrol özeti' }],
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
  mesaj: [{ id: 'icerik', label: 'Mesajlar' }],
  puan: [{ id: 'icerik', label: 'Puan listesi' }],
  'stok-disiplin': [{ id: 'icerik', label: 'Disiplin Merkezi' }],
};

const OPS_HUB_RENK = {
  canli: '#4a9eff',
  'urun-ac': '#2db573',
  'gec-acilan-subeler': '#f97316',
  'gec-kalan-personel': '#0ea5a4',
  'kullanilan-urunler': '#f59e0b',
  'ciro-onay': '#d946b8',
  'kasa-uyumsuzluk': '#e85d5d',
  'urun-uyumsuzluk': '#8b5cf6',
  'magaza-kartlari': '#7c6fdc',
  kontrol: '#e85d5d',
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
  mesaj: '#8899aa',
  puan: '#ffc14d',
  'stok-disiplin': '#e85d5d',
};

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
  for (const k of list) {
    const haystack = magazaAdNorm(k.sube_adi || k.sube_id || '');
    for (const key of magazaRow.keys) {
      if (haystack.includes(magazaAdNorm(key))) return k;
    }
  }
  return null;
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
  return { saat, adet };
}

const URUN_AC_SUBE_ONCELIK = ['zafer', 'koycegiz', 'alsancak', 'tema'];
const KULLANILAN_URUN_KEYS = ['su_adet', 'sut_litre', 'redbull_adet', 'soda_adet', 'cookie_adet', 'pasta_adet'];
const KULLANILAN_URUN_LABEL = {
  su_adet: 'Su',
  sut_litre: 'Süt',
  redbull_adet: 'Redbull',
  soda_adet: 'Soda',
  cookie_adet: 'Cookie',
  pasta_adet: 'Pasta',
};

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

function SubeKart({ k, onDetay, personelRisk }) {
  const b   = k.bayraklar || {};
  const o   = k.ozet || {};
  const op  = k.operasyon || {};
  const aktif = op.aktif;
  const vurgu = computeOpsKartVurgu(k);
  const satisTahminToplam = Number(k.satis_tahmin_toplam || 0);

  // Ciro trendi (sparkline) — backend generate_series ile her zaman 7 eleman döner.
  const ciroTrend      = k.ciro_trend || [];
  const ciroTrendMax   = Math.max(...ciroTrend.map(t => t.ciro || 0), 1);
  const CIRO_BAR_H     = 28;   // px — maksimum bar yüksekliği
  const CIRO_GUN_ADI   = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

  // Kart rengi
  let borderColor = 'var(--border)';
  if (b.kritik)       borderColor = 'var(--red)';
  else if (b.geciken) borderColor = '#f08040';

  // Operasyon olaylarının durumu
  const tipIkon = { ACILIS: '🌅', KONTROL: '🔍', KAPANIS: '🌙', CIKIS: '🚪' };
  const allEv = op.events || [];
  const displayEv = allEv.slice(0, 5);
  const acilisEv = allEv.filter(e => e.tip === 'ACILIS');
  const digerDisplay = vurgu.mode === 'acilis'
    ? displayEv.filter(e => e.tip !== 'ACILIS')
    : displayEv;

  const uyarilar = (k.uyarilar || []).slice(0, 2);
  const g = k.guvenlik || {};
  const ad = g.alarm_durum;

  const eventChip = e => {
    const renk = e.durum === 'tamamlandi' ? 'var(--green)' : e.durum === 'gecikti' ? 'var(--red)' : 'var(--text3)';
    return (
      <span key={e.id} style={{ fontSize: 11, color: renk, display: 'flex', alignItems: 'center', gap: 3 }}>
        {tipIkon[e.tip] || '○'} {e.tip}
        {e.durum === 'gecikti' && op.aktif_gecikme_dk != null && e.id === aktif?.id
          ? ` (${op.aktif_gecikme_dk}dk)` : ''}
      </span>
    );
  };

  return (
    <div
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
        {(k.anlik_gider_bekleyen || 0) > 0 && (
          <span className="badge badge-yellow">💸 Gider bekliyor: {k.anlik_gider_bekleyen}</span>
        )}
        {(k.gunluk_not_adet || 0) > 0 && (
          <span className="badge badge-gray">📝 Günlük not: {k.gunluk_not_adet}</span>
        )}
        {satisTahminToplam !== 0 && (
          <span className={`badge ${satisTahminToplam > 0 ? 'badge-yellow' : 'badge-green'}`}>
            📉 Tahmini açık: {satisTahminToplam > 0 ? '+' : ''}{fmt(satisTahminToplam)}
          </span>
        )}
      </div>

      {/* 7 Günlük Ciro Trendi (sparkline) */}
      {ciroTrend.length === 7 && (
        <div style={{ padding: '6px 8px', background: 'var(--bg3)', borderRadius: 7 }}>
          {/* Başlık satırı: etiket sol, bugünkü tutar sağ */}
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 5, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>7 Günlük Ciro</span>
            {(k.bugun_ciro_tutar || 0) > 0 && (
              <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: 11 }}>
                Bugün: {fmt(k.bugun_ciro_tutar)} ₺
              </span>
            )}
          </div>
          {/* Bar chart — flex sütunlar, alignItems: flex-end = barlar tabandan yukarı büyür */}
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: CIRO_BAR_H + 14 }}>
            {ciroTrend.map((t, i) => {
              const barH   = Math.max(2, Math.round((t.ciro / ciroTrendMax) * CIRO_BAR_H));
              const isBugun = i === 6;
              const d      = new Date(t.tarih + 'T00:00:00');
              const wd     = d.getDay();   // 0=Pazar … 6=Cumartesi
              const gunAdi = isBugun ? 'Bug.' : (CIRO_GUN_ADI[wd === 0 ? 6 : wd - 1] || '—');
              const barRenk = isBugun
                ? (t.ciro > 0 ? 'var(--green)' : 'var(--red)')
                : (t.ciro > 0 ? '#4f8ef7' : 'var(--bg2)');
              return (
                <div
                  key={t.tarih}
                  title={`${gunAdi}: ${Number(t.ciro || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, cursor: 'default' }}
                >
                  <div style={{ width: '100%', height: barH, background: barRenk, borderRadius: '2px 2px 0 0' }} />
                  <span style={{ fontSize: 8, color: isBugun ? 'var(--green)' : 'var(--text3)', marginTop: 2, lineHeight: 1 }}>
                    {gunAdi}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Teorik / Gerçek Satış Verimliliği */}
      {(() => {
        const sv = k.satis_verimlilik;
        if (!sv || !sv.yeterli_veri || sv.teorik_ciro == null) return null;
        const yuzde = sv.yuzde != null ? Number(sv.yuzde) : null;
        const renk = yuzde == null ? 'var(--text3)'
          : yuzde >= 90 ? 'var(--green)'
          : yuzde >= 70 ? '#f59e0b'
          : 'var(--red)';
        const etiket = yuzde == null ? '—'
          : yuzde >= 90 ? 'Normal'
          : yuzde >= 70 ? 'Düşük'
          : 'Fire Riski';
        return (
          <div style={{ background: 'var(--bg3)', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Satış Verimliliği</span>
              <span style={{ color: renk, fontWeight: 700, fontSize: 13 }}>
                {yuzde != null ? `%${yuzde.toFixed(0)}` : '—'}
                <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 4, opacity: 0.8 }}>{etiket}</span>
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text2)' }}>
              <span>Beklenen: <strong>{Number(sv.teorik_ciro).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺</strong></span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span>Gerçek: <strong style={{ color: renk }}>{Number(sv.gercek_ciro).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺</strong></span>
            </div>
            {yuzde != null && yuzde < 90 && (
              <div style={{ marginTop: 4, height: 4, borderRadius: 2, background: 'var(--bg2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, yuzde)}%`, background: renk, borderRadius: 2, transition: 'width .4s' }} />
              </div>
            )}
          </div>
        );
      })()}

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

      {/* Vardiya */}
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
        Vardiya devri:{' '}
        <span style={{ color: k.vardiya_devri_tamam ? 'var(--green)' : k.vardiya_devri_basladi ? 'var(--yellow)' : 'var(--text3)' }}>
          {k.vardiya_devri_tamam ? 'Tamamlandı' : k.vardiya_devri_basladi ? 'Devam ediyor' : '—'}
        </span>
        {' · '}
        Alarm: <span style={{ color: (o.alarm_sayisi_toplam || 0) > 0 ? 'var(--yellow)' : 'var(--text3)' }}>
          {o.alarm_sayisi_toplam || 0}
        </span>
      </div>

      {(g.alarm || ad) && (
        <div style={{ fontSize: 11, color: 'var(--text3)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
          {g.mesaj && <div style={{ color: b.guvenlik_alarm ? 'var(--red)' : 'var(--text3)', marginBottom: 4 }}>{g.mesaj}</div>}
          {ad && (
            <div>
              Son işlem: <strong>{ad.durum}</strong>
              {ad.islem_ts && <span className="mono" style={{ marginLeft: 6 }}>{String(ad.islem_ts).replace('T', ' ').slice(0, 19)}</span>}
              {ad.sustur_bitis_ts && (
                <span style={{ display: 'block', marginTop: 2 }}>Susturma bitiş: {String(ad.sustur_bitis_ts).replace('T', ' ').slice(0, 19)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Uyarılar */}
      {uyarilar.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {uyarilar.map((u, i) => (
            <div key={i} style={{
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: 5,
              background: u.seviye === 'kritik' ? 'rgba(224,92,92,.1)' : 'rgba(232,197,71,.1)',
              color: u.seviye === 'kritik' ? 'var(--red)' : 'var(--yellow)',
              borderLeft: `2px solid ${u.seviye === 'kritik' ? 'var(--red)' : 'var(--yellow)'}`,
            }}>
              {(u.mesaj || '').slice(0, 90)}
            </div>
          ))}
        </div>
      )}
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
                      <span>{e.tip} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({saat})</span></span>
                      <span style={{ color: renk, fontWeight: 500 }}>
                        {e.durum === 'tamamlandi' ? 'Tamamlandı' : e.durum === 'gecikti' ? `Gecikti${op.aktif_gecikme_dk ? ` · ${op.aktif_gecikme_dk}dk` : ''}` : 'Bekliyor'}
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
              ['Açılış op', o.acilis_tamam ? '✓ Tamamlandı' : o.acilis_gecikti ? '! Gecikti' : '—'],
              ['Kapanış op', o.kapanis_tamam ? '✓ Tamamlandı' : o.kapanis_gecikti ? '! Gecikti' : '—'],
              ['Kontrol bekleyen', o.kontrol_bekleyen ?? '—'],
              ['Alarm sayısı', o.alarm_sayisi_toplam ?? 0],
              ['Vardiya devri', kart.vardiya_devri_tamam ? 'Tamamlandı' : kart.vardiya_devri_basladi ? 'Devam ediyor' : '—'],
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
                  <span>{u.mesaj}</span>
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
                  <strong>{u.seviye?.toUpperCase()}</strong> {u.mesaj}
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

export default function OperasyonMerkezi() {
  const varsayilanAy = new Date().toISOString().slice(0, 7);
  const [aktifSekme, setAktifSekme] = useState('');
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
  const [siparisAkis, setSiparisAkis] = useState(null);
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
  /** depo kartı iç görünüm: katalog | uyari | canli */
  const [magazaDepoAltSekme, setMagazaDepoAltSekme] = useState({});
  /** `${subeKey}::${urunId}` -> onay bekleyen stok değişikliği */
  const [magazaStokOnayBekleyen, setMagazaStokOnayBekleyen] = useState({});
  /** `${subeKey}::${urunId}` -> onay API çağrısı in-flight */
  const [magazaStokOnayBusy, setMagazaStokOnayBusy] = useState({});
  /** Şube anahtarı → katalog dışı manuel satırlar (yerel; API yok). */
  const [magazaManuelSatirlar, setMagazaManuelSatirlar] = useState({});
  const [mPersonelVerimlilik, setMPersonelVerimlilik] = useState(null);
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
  const [gecAcilanBugun, setGecAcilanBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [gecAcilanBugunYukleniyor, setGecAcilanBugunYukleniyor] = useState(false);
  const [gecAcilanAramaTarih, setGecAcilanAramaTarih] = useState(bugunIsoTarih());
  const [gecAcilanAramaYukleniyor, setGecAcilanAramaYukleniyor] = useState(false);
  const [gecAcilanAramaSonuc, setGecAcilanAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [gecAcilanSeciliSubeKey, setGecAcilanSeciliSubeKey] = useState('all');
  const [gecKalanPersonelBugun, setGecKalanPersonelBugun] = useState({
    year_month: varsayilanAy,
    gecikme_dk: 5,
    kritik_dk: 30,
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
    kritik_dk: 30,
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
  const [ciroOnayBugun, setCiroOnayBugun] = useState({ tarih: '', toplam: 0, toplam_tutar: 0, kayitlar: [] });
  const [ciroOnayBugunYukleniyor, setCiroOnayBugunYukleniyor] = useState(false);
  const [ciroOnayAramaTarih, setCiroOnayAramaTarih] = useState(bugunIsoTarih());
  const [ciroOnayAramaYukleniyor, setCiroOnayAramaYukleniyor] = useState(false);
  const [ciroOnayAramaSonuc, setCiroOnayAramaSonuc] = useState({ tarih: '', toplam: 0, toplam_tutar: 0, kayitlar: [] });
  const [ciroOnaySeciliSubeKey, setCiroOnaySeciliSubeKey] = useState('all');
  const [kasaUyumBugun, setKasaUyumBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [kasaUyumBugunYukleniyor, setKasaUyumBugunYukleniyor] = useState(false);
  const [kasaUyumAramaTarih, setKasaUyumAramaTarih] = useState(bugunIsoTarih());
  const [kasaUyumAramaYukleniyor, setKasaUyumAramaYukleniyor] = useState(false);
  const [kasaUyumAramaSonuc, setKasaUyumAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [kasaUyumSeciliSubeKey, setKasaUyumSeciliSubeKey] = useState('all');
  const [urunUyumBugun, setUrunUyumBugun] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [urunUyumBugunYukleniyor, setUrunUyumBugunYukleniyor] = useState(false);
  const [urunUyumAramaTarih, setUrunUyumAramaTarih] = useState(bugunIsoTarih());
  const [urunUyumAramaYukleniyor, setUrunUyumAramaYukleniyor] = useState(false);
  const [urunUyumAramaSonuc, setUrunUyumAramaSonuc] = useState({ tarih: '', toplam: 0, kayitlar: [] });
  const [urunUyumSeciliSubeKey, setUrunUyumSeciliSubeKey] = useState('all');

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

  const gecAcilanGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const r = await api(`/ops/gec-acilan-subeler?tarih=${encodeURIComponent(hedef)}&limit=260`);
    return {
      tarih: String(r?.tarih || hedef),
      toplam: Number(r?.toplam || 0),
      kayitlar: Array.isArray(r?.kayitlar) ? r.kayitlar : [],
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

  const gecKalanPersonelAyYukle = useCallback(async (ym) => {
    const hedefAy = String(ym || varsayilanAy).trim() || varsayilanAy;
    const r = await api(`/ops/gec-kalan-personel?year_month=${encodeURIComponent(hedefAy)}&gecikme_dk=5&kritik_dk=30&limit=500`);
    return {
      year_month: String(r?.year_month || hedefAy),
      gecikme_dk: Number(r?.gecikme_dk || 5),
      kritik_dk: Number(r?.kritik_dk || 30),
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
    const toplamAdet = satirlar.reduce((sum, row) => {
      const satilan = row?.satilan || {};
      return sum + KULLANILAN_URUN_KEYS.reduce((s, key) => {
        const v = Number(satilan?.[key] || 0);
        return s + (Number.isFinite(v) && v > 0 ? v : 0);
      }, 0);
    }, 0);
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

  const ciroOnayGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
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
      const data = await ciroOnayGunYukle(bugunIsoTarih());
      setCiroOnayBugun(data);
      if (aktifSekme !== 'ciro-onay') {
        setCiroOnayAramaTarih(data.tarih || bugunIsoTarih());
        setCiroOnayAramaSonuc(data);
      }
    } catch (e) {
      if (!silent) toast(e.message || 'Bekleyen ciro onayları yüklenemedi');
    } finally {
      setCiroOnayBugunYukleniyor(false);
    }
  }, [aktifSekme, ciroOnayGunYukle, toast]);

  const ciroOnayAramaYap = useCallback(async () => {
    const hedef = (ciroOnayAramaTarih || bugunIsoTarih()).trim();
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
    return {
      tarih: hedef,
      toplam: kayitlar.length,
      kayitlar,
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

  const urunUyumGunYukle = useCallback(async (tarih) => {
    const hedef = (tarih || bugunIsoTarih()).trim();
    const ym = hedef.slice(0, 7);
    const r = await api(`/ops/bar-ozet?year_month=${encodeURIComponent(ym)}&gun=${encodeURIComponent(hedef)}&limit=180`);
    const satirlar = Array.isArray(r?.satirlar) ? r.satirlar : [];
    const keys = ['bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet','sut_litre','redbull_adet','soda_adet','cookie_adet','pasta_adet'];
    const kayitlar = satirlar
      .map((x) => {
        const sat = x?.satilan || {};
        const uyumsuzlar = keys.filter((k) => Number(sat?.[k] || 0) < 0);
        return {
          ...x,
          uyumsuz_urunler: uyumsuzlar,
          uyumsuz_adet: uyumsuzlar.length,
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
    try {
      const [kr, ak, dav, sk, bek, dep] = await Promise.all([
        api('/ops/v2/kritik-stok').catch(() => null),
        api('/ops/v2/siparis-akis?limit=50').catch(() => null),
        api('/ops/v2/sube-davranis?gun=30').catch(() => null),
        api('/ops/v2/sube-skor').catch(() => null),
        api('/ops/v2/bekleyen-siparisler?gun=7').catch(() => null),
        api('/ops/subeler/depolar').catch(() => null),
      ]);
      if (kr)  setKritikStok(kr);
      if (ak)  setSiparisAkis(ak);
      if (dav) setSubeDavranis(dav);
      if (sk)  setSubeSkor(sk);
      if (bek) setBekleyenSiparisler(bek);
      if (dep) setKuyrukDepolar(dep.satirlar || []);
    } catch (e) {
      toast(e.message || 'Disiplin verisi yüklenemedi');
    } finally {
      setDisiplinYukleniyor(false);
      setYukleniyor(false);
    }
  }, []);

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
      const canliReq = MAGAZA_DORT_SUBE.map(async (m) => {
        const k = magazaKartBul(liveKartlar, m);
        const sid = String(k?.sube_id || '').trim();
        if (!sid) return [m.slug, []];
        try {
          const r = await api(`/ops/v2/sube/${encodeURIComponent(sid)}/depo`);
          const stok = Array.isArray(r?.stok) ? r.stok : [];
          return [m.slug, stok];
        } catch {
          return [m.slug, []];
        }
      });
      const canliPairs = await Promise.all(canliReq);
      const canliMap = {};
      canliPairs.forEach(([slug, stok]) => { canliMap[slug] = stok; });
      setMagazaDepoCanliStok(canliMap);
    } catch {
      setMagazaDepoKatalogState({ yukleniyor: false, kategoriler: [] });
      setMagazaDepoCanliStok({});
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
    if (aktifSekme === 'onay' || aktifSekme === 'siparis' || aktifSekme === 'siparis-kabul-takip' || aktifSekme === 'toptanci-siparisleri' || aktifSekme === 'urun-ac' || aktifSekme === 'gec-acilan-subeler' || aktifSekme === 'gec-kalan-personel' || aktifSekme === 'kullanilan-urunler' || aktifSekme === 'ciro-onay' || aktifSekme === 'kasa-uyumsuzluk' || aktifSekme === 'urun-uyumsuzluk' || aktifSekme === 'magaza-kartlari' || aktifSekme === 'metrics' || aktifSekme === 'kontrol' || aktifSekme === 'stok-disiplin') return;
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
      .then(r => setMesajListe(r.satirlar || []))
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
    if (!opsMerkezPencere) return;
    if ((toptanciSiparisListe?.satirlar || []).length > 0) return;
    yukleToptanciSiparisleri();
  }, [opsMerkezPencere, toptanciSiparisListe?.satirlar, yukleToptanciSiparisleri]);

  useEffect(() => {
    if (aktifSekme !== 'urun-ac') return;
    setYukleniyor(true);
    urunAcGunYukle(bugunIsoTarih())
      .then((data) => {
        setUrunAcAramaTarih(data.tarih || bugunIsoTarih());
        setUrunAcAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Ürün aç akışı yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, urunAcGunYukle]);

  useEffect(() => {
    if (aktifSekme !== 'gec-acilan-subeler') return;
    setYukleniyor(true);
    gecAcilanGunYukle(bugunIsoTarih())
      .then((data) => {
        setGecAcilanAramaTarih(data.tarih || bugunIsoTarih());
        setGecAcilanAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Geç açılan şubeler yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, gecAcilanGunYukle]);

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
    kullanilanGunYukle(bugunIsoTarih())
      .then((data) => {
        setKullanilanAramaTarih(data.tarih || bugunIsoTarih());
        setKullanilanAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Kullanılan ürünler yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, kullanilanGunYukle]);

  useEffect(() => {
    if (aktifSekme !== 'ciro-onay') return;
    setYukleniyor(true);
    ciroOnayGunYukle(bugunIsoTarih())
      .then((data) => {
        setCiroOnayAramaTarih(data.tarih || bugunIsoTarih());
        setCiroOnayAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Bekleyen ciro onayları yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, ciroOnayGunYukle, toast]);

  useEffect(() => {
    if (aktifSekme !== 'kasa-uyumsuzluk') return;
    setYukleniyor(true);
    kasaUyumGunYukle(bugunIsoTarih())
      .then((data) => {
        setKasaUyumAramaTarih(data.tarih || bugunIsoTarih());
        setKasaUyumAramaSonuc(data);
      })
      .catch((e) => toast(e.message || 'Kasa uyumsuzluk verisi yüklenemedi'))
      .finally(() => setYukleniyor(false));
  }, [aktifSekme, toast, kasaUyumGunYukle]);

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
    if (aktifSekme !== 'magaza-kartlari') return;
    magazaDepoTamYenile();
  }, [aktifSekme, filtre, magazaDepoTamYenile]);

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
        urunAcAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'gec-acilan-subeler') {
        setYukleniyor(true);
        gecAcilanAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'gec-kalan-personel') {
        setYukleniyor(true);
        gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'kullanilan-urunler') {
        setYukleniyor(true);
        kullanilanAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'ciro-onay') {
        setYukleniyor(true);
        ciroOnayAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'kasa-uyumsuzluk') {
        setYukleniyor(true);
        kasaUyumAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'urun-uyumsuzluk') {
        setYukleniyor(true);
        urunUyumAramaYap().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'siparis') {
        setYukleniyor(true);
        yukleSiparisMerkez().finally(() => setYukleniyor(false));
      } else if (aktifSekme === 'siparis-kabul-takip') {
        setYukleniyor(true);
        yukleSiparisKabulTakip();
      } else if (aktifSekme === 'toptanci-siparisleri') {
        setYukleniyor(true);
        yukleToptanciSiparisleri();
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
  }, [aktifSekme, filtre, hubOzetIsle, yukle, yukleOnayMerkez, urunAcAramaYap, gecAcilanAramaYap, gecKalanPersonelAramaYap, kullanilanAramaYap, ciroOnayAramaYap, kasaUyumAramaYap, urunUyumAramaYap, yukleSiparisMerkez, yukleSiparisKabulTakip, yukleToptanciSiparisleri, toptanciSiparisListe?.gun, magazaDepoTamYenile, yukleMetrics, yukleKontrolOzet, yukleFisBekleyen, yukleDisiplin]);


  // Haftalık karşılaştırma — sadece ilgili sekme açıkken yükle
  useEffect(() => {
    if (opsIcBolum !== 'karsilastirma') return;
    api('/ops/haftalik-karsilastirma')
      .then(setHaftalikKarsilastirma)
      .catch(() => {});
  }, [opsIcBolum]);

  const toplamGecikme = skor?.son_30_gun?.reduce((s, r) => s + (r.gecikme_adet || 0), 0) || 0;
  const kritikSayi    = kartlar.filter(k => k.bayraklar?.kritik).length;
  const gecikSayi     = kartlar.filter(k => k.bayraklar?.geciken).length;
  const guvenlikSayi  = kartlar.filter(k => k.bayraklar?.guvenlik_alarm).length;
  const karsilastirmaKartlar = [...kartlar].sort((a, b) => String(a?.sube_adi || '').localeCompare(String(b?.sube_adi || ''), 'tr'));
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
  const gecAcilanSubeSekmeleri = (gecAcilanAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
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
  const ciroOnaySubeSekmeleri = (ciroOnayAramaSonuc?.kayitlar || []).reduce((acc, r) => {
    const baslik = String(r?.sube_adi || r?.sube_id || 'Diğer').trim() || 'Diğer';
    const key = urunAcSubeAnahtar(baslik) || baslik;
    const bulunan = acc.find((x) => x.key === key);
    if (bulunan) bulunan.adet += 1;
    else acc.push({ key, baslik, adet: 1 });
    return acc;
  }, []);
  ciroOnaySubeSekmeleri.sort((a, b) => {
    const ai = URUN_AC_SUBE_ONCELIK.indexOf(a.key);
    const bi = URUN_AC_SUBE_ONCELIK.indexOf(b.key);
    const ao = ai >= 0 ? ai : 99;
    const bo = bi >= 0 ? bi : 99;
    if (ao !== bo) return ao - bo;
    return a.baslik.localeCompare(b.baslik, 'tr');
  });
  const ciroOnayGorunenKayitlar = ciroOnaySeciliSubeKey === 'all'
    ? (ciroOnayAramaSonuc?.kayitlar || [])
    : (ciroOnayAramaSonuc?.kayitlar || []).filter((r) => {
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
        yukleUrunUyumBugun({ silent: true }).catch(() => {});
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
  }, [hubOzetIsle, opsMerkezPencere, yukleUrunAcBugun, yukleGecAcilanBugun, yukleGecKalanPersonelBugun, yukleKullanilanBugun, yukleCiroOnayBugun, yukleKasaUyumBugun, yukleUrunUyumBugun]);

  const acOpsModul = useCallback((id) => {
    const bolumler = OPS_MODUL_BOLUM[id] || [{ id: 'icerik', label: 'İçerik' }];
    setAktifSekme(id);
    setOpsIcBolum(bolumler[0].id);
    setOpsMerkezPencere(true);
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
      await yukleOnayMerkez();
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

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

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
            else if (aktifSekme === 'urun-ac') {
              urunAcAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'gec-acilan-subeler') {
              gecAcilanAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'gec-kalan-personel') {
              gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'kullanilan-urunler') {
              kullanilanAramaYap().finally(() => setYukleniyor(false));
            }
            else if (aktifSekme === 'kasa-uyumsuzluk') {
              kasaUyumAramaYap().finally(() => setYukleniyor(false));
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
                                        <td>{k.urun_ad || k.kalem_kodu || '—'}</td>
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
                  Sunucu şu an özet satırı döndürmedi; «Özet yenile» ile tekrar deneyin veya hub’daki «Şube sipariş» kartından kuyruğu açın.
                </p>
              )}
            </section>
          )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
          {UST_SEKMELER.filter((s) => s.id !== 'sayim').map((s) => {
            const renk = OPS_HUB_RENK[s.id] || 'var(--border)';
            // Her sekme için özet veri
            let val = null;
            let sub = 'Modülü aç';
            if (s.id === 'urun-ac') {
              val = urunAcBugun?.toplam_islem ?? 0;
              sub = urunAcBugunZirveSaat
                ? `Bugün zirve ${urunAcBugunZirveSaat.saat} (${urunAcBugunZirveSaat.adet})`
                : 'Bugün ürün aç kaydı yok';
            } else if (s.id === 'gec-acilan-subeler') {
              val = gecAcilanBugun?.toplam ?? 0;
              sub = gecAcilanBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (gecAcilanBugun?.toplam || 0) > 0
                ? `${gecAcilanBugun?.toplam || 0} şube geç açıldı`
                : 'Geç açılan şube yok';
            } else if (s.id === 'gec-kalan-personel') {
              val = gecKalanPersonelBugun?.kritik_personel_sayisi ?? 0;
              sub = gecKalanPersonelBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (gecKalanPersonelBugun?.kritik_personel_sayisi || 0) > 0
                ? `${gecKalanPersonelBugun?.kritik_personel_sayisi || 0} personel kritik`
                : 'Kritik gecikme yok';
            } else if (s.id === 'kullanilan-urunler') {
              val = kullanilanBugun?.toplam_adet ?? 0;
              sub = kullanilanBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (kullanilanBugun?.toplam_islem || 0) > 0
                ? `Bugün ${kullanilanBugun?.toplam_islem || 0} şube kaydı`
                : 'Bugün kullanılan ürün kaydı yok';
            } else if (s.id === 'ciro-onay') {
              val = ciroOnayBugun?.toplam ?? 0;
              sub = ciroOnayBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (ciroOnayBugun?.toplam || 0) > 0
                ? `${ciroOnayBugun?.toplam || 0} bekleyen · ${fmt(ciroOnayBugun?.toplam_tutar || 0)}`
                : 'Bugün bekleyen ciro onayı yok';
            } else if (s.id === 'kasa-uyumsuzluk') {
              val = kasaUyumBugun?.toplam ?? 0;
              sub = kasaUyumBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (kasaUyumBugun?.toplam || 0) > 0
                ? `${kasaUyumBugun?.toplam || 0} uyumsuzluk var`
                : 'Uyumsuzluk yok';
            } else if (s.id === 'urun-uyumsuzluk') {
              val = urunUyumBugun?.toplam ?? 0;
              sub = urunUyumBugunYukleniyor
                ? 'Güncel veri yükleniyor…'
                : (urunUyumBugun?.toplam || 0) > 0
                ? `${urunUyumBugun?.toplam || 0} uyumsuzluk var`
                : 'Uyumsuzluk yok';
            }
            if (opsOzet) {
              if (s.id === 'canli') {
                val = opsOzet.aktif_sube;
                sub = 'Aktif şube';
              } else if (s.id === 'siparis') {
                val = opsOzet.siparis_katalog_urun ?? 0;
                sub = 'Katalog ürün — şube sipariş akışı Stok Disiplin kuyruğunda';
              } else if (s.id === 'onay') {
                val = opsOzet.onay_bekleyen;
                sub = opsOzet.onay_bekleyen > 0 ? 'Onay bekliyor' : 'Kuyruk boş ✓';
              } else if (s.id === 'fis') {
                val = opsOzet.fis_bekleyen;
                sub = opsOzet.fis_bekleyen > 0 ? 'Son 7 gün bekleyen' : 'Tümü kontrol edildi ✓';
              } else if (s.id === 'mesaj') {
                val = opsOzet.mesaj_aktif;
                sub = opsOzet.mesaj_aktif > 0 ? 'Aktif mesaj' : 'Mesaj yok';
              } else if (s.id === 'defter') {
                val = opsOzet.defter_bugun;
                sub = 'Bugün kayıt';
              } else if (s.id === 'sayim') {
                val = opsOzet.sayim_bugun;
                sub = 'Bugün tamamlanan';
              } else if (s.id === 'magaza-kartlari') {
                const eslesen = MAGAZA_DORT_SUBE.filter((m) => magazaKartBul(kartlar, m)).length;
                val = eslesen;
                sub = `${eslesen}/4 mağaza hub’da eşleşti`;
              } else if (s.id === 'kontrol') {
                val = opsOzet.kontrol_gecikti;
                sub = opsOzet.kontrol_gecikti > 0 ? 'Bugün gecikme var ⚠️' : 'Bugün sorun yok ✓';
              } else if (s.id === 'metrics') {
                val = opsOzet.uyari_30d;
                sub = '30 günde uyarı/kritik';
              } else if (s.id === 'stok-kayip') {
                val = opsOzet.stok_kayip_sube;
                sub = '7 günde kapanış kaydı olan şube';
              } else if (s.id === 'personel-davranis') {
                val = opsOzet.davranis_personel;
                sub = '30 günde aktif personel';
              } else if (s.id === 'puan') {
                val = opsOzet.aktif_personel;
                sub = 'Aktif personel';
              } else if (s.id === 'stok-disiplin') {
                const sa = opsOzet.stok_alarm_bekleyen || 0;
                val = sa > 0 ? sa : null;
                sub = sa > 0
                  ? `${sa} okunmamış depo alarmı`
                  : 'Stok & sipariş disiplin merkezi';
              } else if (s.id === 'toptanci-siparisleri') {
                val = Array.isArray(toptanciSiparisListe?.satirlar) ? toptanciSiparisListe.satirlar.length : 0;
                sub = 'Kategori bazlı ürün listesi';
              }
            }
            const valRenk = val != null && val > 0 ? renk : 'var(--text3)';
            return (
              <div
                key={s.id}
                className="metric-card"
                style={{
                  borderTop: `3px solid ${renk}`,
                  cursor: 'pointer',
                }}
                onClick={() => {
                  if (s.id === 'urun-ac') {
                    setUrunAcDetayAcik(true);
                    setUrunAcAramaTarih(bugunIsoTarih());
                    setUrunAcAramaSonuc(urunAcBugun);
                  } else if (s.id === 'gec-acilan-subeler') {
                    setGecAcilanAramaTarih(bugunIsoTarih());
                    setGecAcilanAramaSonuc(gecAcilanBugun);
                  } else if (s.id === 'gec-kalan-personel') {
                    setGecKalanPersonelAy(varsayilanAy);
                    setGecKalanPersonelAramaSonuc(gecKalanPersonelBugun);
                    setGecKalanPersonelAcikKey('');
                  } else if (s.id === 'kullanilan-urunler') {
                    setKullanilanDetayAcik(true);
                    setKullanilanAramaTarih(bugunIsoTarih());
                    setKullanilanAramaSonuc(kullanilanBugun);
                  } else if (s.id === 'ciro-onay') {
                    setCiroOnayAramaTarih(bugunIsoTarih());
                    setCiroOnayAramaSonuc(ciroOnayBugun);
                  } else if (s.id === 'kasa-uyumsuzluk') {
                    setKasaUyumAramaTarih(bugunIsoTarih());
                    setKasaUyumAramaSonuc(kasaUyumBugun);
                  } else if (s.id === 'urun-uyumsuzluk') {
                    setUrunUyumAramaTarih(bugunIsoTarih());
                    setUrunUyumAramaSonuc(urunUyumBugun);
                  }
                  acOpsModul(s.id);
                }}
                title={s.label + ' modülünü aç →'}
              >
                <div className="metric-label">{s.label}</div>
                {val != null
                  ? <div className="metric-value" style={{ fontSize: 24, color: valRenk }}>{val}</div>
                  : <div className="metric-value" style={{ fontSize: 20, color: renk }}>—</div>
                }
                <div className="metric-sub">
                  {sub} <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span>
                </div>
              </div>
            );
          })}
          {opsOzet && (
            <div
              key="siparis-sube-bekleyen"
              className={`metric-card${hubYeniSiparisVurgu ? ' ops-hub-yeni-siparis-flash' : ''}`}
              style={{
                borderTop: `3px solid ${(Number(opsOzet.siparis_bekleyen) || 0) > 0 ? '#4a9eff' : 'var(--green)'}`,
                cursor: 'pointer',
              }}
              onClick={() => {
                setDisiplinPanel('kuyruk');
                acOpsModul('stok-disiplin');
              }}
              title={`Bekleyen sube siparisleri - son ${siparisBekleyenGunPenceresi} gun - Stok Disiplin > Siparis kuyrugu`}
            >
              <div className="metric-label">🏪 Şube sipariş</div>
              <div
                className="metric-value"
                style={{
                  fontSize: 24,
                  color: (Number(opsOzet.siparis_bekleyen) || 0) > 0 ? '#4a9eff' : 'var(--text3)',
                }}
              >
                {Number(opsOzet.siparis_bekleyen) || 0}
              </div>
              <div className="metric-sub">
                {(Number(opsOzet.siparis_bekleyen) || 0) > 0
                  ? `Son ${siparisBekleyenGunPenceresi} gun - kuyruga git`
                  : `Son ${siparisBekleyenGunPenceresi} gun bos`}
                <span style={{ color: 'var(--text3)', fontSize: 10 }}> →</span>
              </div>
            </div>
          )}
        </div>
        </>
      )}

      {opsMerkezPencere && !!aktifSekme && (
        <div style={{ marginTop: 4 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, marginBottom: 16, flexWrap: 'wrap',
            borderBottom: `2px solid ${OPS_HUB_RENK[aktifSekme] || 'var(--border)'}`,
            paddingBottom: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
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
                    urunAcAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'gec-acilan-subeler') {
                    gecAcilanAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'gec-kalan-personel') {
                    gecKalanPersonelAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'kullanilan-urunler') {
                    kullanilanAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'ciro-onay') {
                    ciroOnayAramaYap().finally(() => setYukleniyor(false));
                  }
                  else if (aktifSekme === 'kasa-uyumsuzluk') {
                    kasaUyumAramaYap().finally(() => setYukleniyor(false));
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
              <button type="button" className="btn btn-secondary btn-sm" onClick={kapatOpsModul}>
                ← Modüller
              </button>
            </div>
          </div>
          <div style={{ paddingTop: 4 }}>
              {(OPS_MODUL_BOLUM[aktifSekme] || []).length > 1 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', paddingBottom: 6 }}>
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

      {aktifSekme === 'canli' && (
        <>
          {opsIcBolum === 'ozet' && (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
            <div className="metric-card" style={{ borderTop: '3px solid #4a9eff' }}>
              <div className="metric-label">🏢 Aktif Şube</div>
              <div className="metric-value" style={{ color: '#4a9eff' }}>{kartlar.filter(k => k.sube_acik).length} / {kartlar.length || '—'}</div>
              <div className="metric-sub">Açık / toplam <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
            <div className="metric-card" style={{ borderTop: '3px solid var(--green)' }}>
              <div className="metric-label">✓ Ciro Onaylı</div>
              <div className="metric-value" style={{ color: 'var(--green)' }}>{kartlar.filter(k => k.ciro_girildi).length}</div>
              <div className="metric-sub">Onaylı kayıt <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
            <div className="metric-card" style={{ borderTop: '3px solid var(--yellow)' }}>
              <div className="metric-label">⏳ Ciro Onayda</div>
              <div className="metric-value" style={{ color: 'var(--yellow)' }}>{kartlar.filter(k => k.ciro_taslak_bekliyor).length}</div>
              <div className="metric-sub">Taslak bekliyor <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
            <div className="metric-card" style={{ borderTop: `3px solid ${toplamGecikme > 0 ? 'var(--red)' : 'var(--text3)'}` }}>
              <div className="metric-label">⚠️ 30g Gecikme</div>
              <div className="metric-value" style={{ color: toplamGecikme > 0 ? 'var(--red)' : 'var(--text3)' }}>{toplamGecikme}</div>
              <div className="metric-sub">{skor?.uyari_sayisi_uyari_kritik || 0} uyarı/kritik kayıt <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
            <div className="metric-card" style={{ borderTop: '3px solid var(--green)' }}>
              <div className="metric-label">📉 Tahmini Satış (açık)</div>
              <div className="metric-value" style={{ color: 'var(--green)' }}>{fmt(Number(ozet?.satis_tahmin_toplam || 0))}</div>
              <div className="metric-sub">Teorik − gerçek <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
            <div className="metric-card" style={{ borderTop: `3px solid ${kritikSayi > 0 ? 'var(--red)' : gecikSayi > 0 ? '#f08040' : 'var(--text3)'}` }}>
              <div className="metric-label">🚨 Kritik / Gecikme</div>
              <div className="metric-value" style={{ fontSize: 22, color: kritikSayi > 0 ? 'var(--red)' : 'var(--text3)' }}>{kritikSayi}</div>
              <div className="metric-sub">{gecikSayi} geciken şube · {guvenlikSayi} güvenlik <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
            {FILTRELER.map(f => (
              <button
                key={f.id}
                className={`tab-pill ${filtre === f.id ? 'active' : ''}`}
                onClick={() => setFiltre(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          </>
          )}

          {opsIcBolum === 'subeler' && (
          <>
          {yukleniyor ? (
            <div className="loading" style={{ marginBottom: 16 }}><div className="spinner" />Yükleniyor…</div>
          ) : kartlar.length === 0 ? (
            <div className="empty" style={{ marginBottom: 16 }}>
              <div className="icon">✅</div>
              <p>Bu filtrede şube yok</p>
            </div>
          ) : (
            <div style={{ marginBottom: 18 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 10px 0', color: 'var(--text1)' }}>Şube kartları</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                {kartlar.map((k) => (
                  <SubeKart
                    key={k.sube_id || k.sube_adi}
                    k={k}
                    onDetay={setDetay}
                    personelRisk={riskliPersonelSubeMap[k.sube_id]}
                  />
                ))}
              </div>
            </div>
          )}
          </>
          )}

          {opsIcBolum === 'karsilastirma' && (
          <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Şubeler arası canlı karşılaştırma</h3>
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Şube</th>
                    <th>Açılış</th>
                    <th>Kontrol</th>
                    <th>Kapanış</th>
                    <th>Vardiya devri</th>
                    <th>Ciro</th>
                    <th>Not</th>
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
                        : { text: '—', badge: 'badge-gray' };
                    const gecikme = Number(k?.kontrol_gecikme_dk || 0);
                    const kontrolCell = kontrolDurum
                      ? (gecikme > 0
                        ? { text: `⚠️ ${gecikme} dk geç`, badge: gecikme >= 30 ? 'badge-red' : 'badge-yellow' }
                        : kontrolDurum)
                      : { text: '⏳', badge: 'badge-yellow' };
                    const kapanisCell = kapanisDurum || { text: '⏳', badge: 'badge-yellow' };
                    const ciro = Number(k?.bugun_ciro_tutar || 0);
                    const notAdet = Number(k?.gunluk_not_adet || 0);
                    return (
                      <tr
                        key={`cmp-${k.sube_id}`}
                        onClick={() => setDetay(k)}
                        style={{ cursor: 'pointer' }}
                        title="Detay için tıkla"
                      >
                        <td style={{ fontWeight: 500, fontSize: 13 }}>{k.sube_adi || k.sube_id || '—'}</td>
                        <td><span className={`badge ${acilisDurum.badge}`}>{acilisDurum.text}</span></td>
                        <td><span className={`badge ${kontrolCell.badge}`}>{kontrolCell.text}</span></td>
                        <td><span className={`badge ${kapanisCell.badge}`}>{kapanisCell.text}</span></td>
                        <td><span className={`badge ${vardiyaDurum.badge}`}>{vardiyaDurum.text}</span></td>
                        <td className="mono">{fmt(ciro)}</td>
                        <td className="mono">{notAdet}</td>
                      </tr>
                    );
                  })}
                  {karsilastirmaKartlar.length === 0 && (
                    <tr><td colSpan={7}><div className="empty"><p>Karşılaştırma için şube verisi yok</p></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 7 Günlük Ciro Karşılaştırması */}
          {haftalikKarsilastirma && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>7 Günlük Ciro Karşılaştırması</h3>
                <div style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', gap: 16 }}>
                  <span>Bu hafta: <strong style={{ color: 'var(--green)' }}>{fmt(haftalikKarsilastirma.toplam_bu_hafta)} ₺</strong></span>
                  <span>Geçen hafta: <strong>{fmt(haftalikKarsilastirma.toplam_gecen_hafta)} ₺</strong></span>
                  {haftalikKarsilastirma.genel_degisim_pct != null && (
                    <span style={{ color: haftalikKarsilastirma.genel_degisim_pct >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                      {haftalikKarsilastirma.genel_degisim_pct >= 0 ? '▲' : '▼'} %{Math.abs(haftalikKarsilastirma.genel_degisim_pct)}
                    </span>
                  )}
                </div>
              </div>
              <div className="table-wrap" style={{ margin: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>#</th>
                      <th>Şube</th>
                      <th style={{ textAlign: 'right' }}>Bu Hafta</th>
                      <th style={{ textAlign: 'right' }}>Geçen Hafta</th>
                      <th style={{ textAlign: 'center' }}>Değişim</th>
                      <th style={{ width: 100 }}>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(haftalikKarsilastirma.subeler || []).map((s) => {
                      const trendMax = Math.max(...(s.trend || []).map(t => t.ciro || 0), 1);
                      const pct = s.degisim_pct;
                      return (
                        <tr key={s.sube_id}>
                          <td style={{ fontWeight: 700, color: s.sira === 1 ? 'var(--yellow)' : 'var(--text3)', fontSize: 13 }}>
                            {s.sira === 1 ? '🥇' : s.sira === 2 ? '🥈' : s.sira === 3 ? '🥉' : s.sira}
                          </td>
                          <td style={{ fontWeight: 500, fontSize: 13 }}>{s.sube_adi || s.sube_id}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--green)' }}>{fmt(s.bu_hafta)} ₺</td>
                          <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{fmt(s.gecen_hafta)} ₺</td>
                          <td style={{ textAlign: 'center' }}>
                            {pct == null ? (
                              <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
                            ) : (
                              <span className={`badge ${pct >= 0 ? 'badge-green' : 'badge-red'}`} style={{ fontSize: 11 }}>
                                {pct >= 0 ? '▲' : '▼'} %{Math.abs(pct)}
                              </span>
                            )}
                          </td>
                          <td>
                            {/* Mini sparkline — 7 çubuk */}
                            <div style={{ display: 'flex', gap: 1, alignItems: 'flex-end', height: 18 }}>
                              {(s.trend || []).map((t, i) => {
                                const h = Math.max(2, Math.round((t.ciro / trendMax) * 16));
                                const isToday = i === (s.trend.length - 1);
                                return (
                                  <div key={t.tarih}
                                    title={`${t.tarih}: ${Number(t.ciro || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺`}
                                    style={{ flex: 1, height: h, background: isToday ? 'var(--green)' : (t.ciro > 0 ? '#4f8ef7' : 'var(--bg2)'), borderRadius: '1px 1px 0 0' }} />
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {(haftalikKarsilastirma.subeler || []).length === 0 && (
                      <tr><td colSpan={6}><div className="empty"><p>Henüz ciro verisi yok</p></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </>
          )}

        </>
      )}

      {aktifSekme === 'magaza-kartlari' && (
        <div className="card" style={{ padding: '18px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
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
                    placeholder="Örn: Vanilya şurubu"
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
                      setMagazaUrunEkleForm({ kategori_kod: '', urun_adi: '', fiyat_tl: '', adet: '' });
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
                      if (!kategoriKod || !urunAdi) return;
                      try {
                        const r = await api('/ops/siparis/urun', {
                          method: 'POST',
                          body: { kategori_kod: kategoriKod, urun_adi: urunAdi },
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
                            MAGAZA_DORT_SUBE.forEach((m) => {
                              const kk = magazaKartBul(kartlar, m);
                              const sid = magazaSubeDepoAnahtar(kk, m);
                              next[`${sid}::${urunId}`] = adetText;
                            });
                            return next;
                          });
                        }
                        await magazaDepoTamYenile();
                        toast('Ürün eklendi ve tüm şube depolarına tanımlandı.', 'green');
                        setMagazaUrunEkleForm({ kategori_kod: '', urun_adi: '', fiyat_tl: '', adet: '' });
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

          <div style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>Dört mağaza deposu — hub + katalog iskeleti</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0, lineHeight: 1.5 }}>
              Aynı katalog kaynağı (<code style={{ fontSize: 11 }}>/ops/siparis/katalog</code>). Her depo kartında, şube başına{' '}
              <strong>elle stok</strong> alanı ve satır bazlı <strong>Onay</strong> ile depo stoğuna işleme vardır.
              Onaylanmayan satırlar bekleyen değişiklik olarak tutulur.
            </p>
            {magazaStokOnayBekleyenAdet > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#e8a03d' }}>
                ⚠️ {magazaStokOnayBekleyenAdet} stok satırı onay bekliyor.
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {MAGAZA_DORT_SUBE.map((m) => {
              const k = magazaKartBul(kartlar, m);
              const sidKey = magazaSubeDepoAnahtar(k, m);
              const canli = Array.isArray(magazaDepoCanliStok[m.slug]) ? magazaDepoCanliStok[m.slug] : [];
              const alarmAdet = canli.filter((st) => Number(st?.mevcut_adet || 0) <= Math.max(1, Number(st?.min_stok || 0))).length;
              const bekleyen = Object.keys(magazaStokOnayBekleyen || {}).filter((kk) => kk.startsWith(`${sidKey}::`)).length;
              return (
                <button
                  key={`ozet-${m.slug}`}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setMagazaDepoAltSekme((prev) => ({
                      ...prev,
                      [m.slug]: alarmAdet > 0 ? 'uyari' : 'katalog',
                    }));
                    const el = document.querySelector(`[data-magaza-slug="${m.slug}"]`);
                    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {m.depoBaslik} · {alarmAdet} alarm · {bekleyen} onay
                </button>
              );
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12 }}>
            {MAGAZA_DORT_SUBE.map((m) => {
              const k = magazaKartBul(kartlar, m);
              const risk = k ? riskliPersonelSubeMap[k.sube_id] : null;
              const katList = magazaDepoKatalogState.kategoriler || [];
              const subeDepoKey = magazaSubeDepoAnahtar(k, m);
              const manuelListe = Array.isArray(magazaManuelSatirlar[subeDepoKey]) ? magazaManuelSatirlar[subeDepoKey] : [];
              const canliStokSatirlari = Array.isArray(magazaDepoCanliStok[m.slug]) ? magazaDepoCanliStok[m.slug] : [];
              const canliUyarilar = canliStokSatirlari.filter((st) => {
                const mevcut = Number(st?.mevcut_adet || 0);
                const min = Number(st?.min_stok || 0);
                return mevcut <= Math.max(1, min);
              });
              const panelSekme = magazaDepoAltSekme[m.slug] || 'katalog';
              const bekleyenOnayAdet = Object.keys(magazaStokOnayBekleyen || {}).filter((kk) => kk.startsWith(`${subeDepoKey}::`)).length;
              return (
                <div
                  key={m.slug}
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
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>{m.depoBaslik}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>{m.label} · slug: {m.slug}</div>
                  </div>
                  {!k && (
                    <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
                      Hub şube listesinde bu ada göre eşleşen kart yok (filtre veya isim yazımını kontrol edin).
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
                      Depo uyarıları ({canliUyarilar.length})
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm ${panelSekme === 'canli' ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setMagazaDepoAltSekme((prev) => ({ ...prev, [m.slug]: 'canli' }))}
                    >
                      Canlı depo kaydı ({canliStokSatirlari.length})
                    </button>
                  </div>
                  {panelSekme === 'katalog' && (
                  <div
                    data-magaza-depo-katalog-root
                    style={{ borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 2 }}
                  >
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
                      const nAktif = magazaAktifUrunSayisi(kat);
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
                            <div style={{ background: 'var(--bg)' }}>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'minmax(0,1fr) 92px 70px 78px 64px',
                                  gap: 6,
                                  alignItems: 'center',
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: 'var(--text3)',
                                  padding: '6px 10px 4px',
                                  borderBottom: '1px solid var(--border)',
                                }}
                              >
                                <span>Ürün</span>
                                <span style={{ textAlign: 'center' }}>Elle stok</span>
                                <span style={{ textAlign: 'right' }}>Fiyat</span>
                                <span style={{ textAlign: 'right' }}>Toplam</span>
                                <span style={{ textAlign: 'right' }}>Onay</span>
                              </div>
                              <ul style={{ margin: 0, padding: '0 10px 8px', listStyle: 'none', fontSize: 11, background: 'var(--bg)' }}>
                                {(kat.items || []).map((it) => {
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
                                  return (
                                    <li
                                      key={`${kk}-${it.id}`}
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'minmax(0,1fr) 92px 70px 78px 64px',
                                        gap: 6,
                                        alignItems: 'center',
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
                            Bu depo kartında kritik/min altı stok alarmı yok.
                          </div>
                        ) : (
                          <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                            {canliUyarilar.map((st) => {
                              const mevcut = Number(st?.mevcut_adet || 0);
                              const min = Number(st?.min_stok || 0);
                              const kriz = mevcut <= 0;
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
                                  <div style={{ fontWeight: 700 }}>{st.kalem_adi || st.kalem_kodu}</div>
                                  <div style={{ color: 'var(--text2)' }}>
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
                      </p>
                      {canliStokSatirlari.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>Bu şube için depo kayıt satırı yok.</div>
                      ) : (
                        <div style={{ display: 'grid', gap: 4, maxHeight: 180, overflow: 'auto', paddingRight: 2 }}>
                          {canliStokSatirlari.map((st) => (
                            <div
                              key={`${m.slug}-canli-${st.kalem_kodu}`}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0,1fr) auto',
                                gap: 8,
                                alignItems: 'center',
                                padding: '4px 0',
                                borderBottom: '1px dashed var(--border)',
                                fontSize: 11,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={st.kalem_adi || st.kalem_kodu}>
                                  {st.kalem_adi || st.kalem_kodu}
                                </div>
                                <div className="mono" style={{ fontSize: 9, color: 'var(--text3)' }}>{st.kalem_kodu}</div>
                              </div>
                              <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                                {magazaFmtStok(st.mevcut_adet)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Stok kayıp tahmini (son {stokKayip?.gun_sayi || 45} gün)</h3>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Şube</th>
                  <th>Açık Toplam</th>
                  <th>Açık Kalem</th>
                  <th>Açık Gün</th>
                </tr>
              </thead>
              <tbody>
                {(stokKayip?.sube_ozet || []).map((s, i) => (
                  <tr key={`${s.sube_id}-${i}`}>
                    <td>{s.sube_adi || s.sube_id}</td>
                    <td className="mono">{s.toplam_acik || 0}</td>
                    <td className="mono">{s.acik_kalem || 0}</td>
                    <td className="mono">{s.acik_gun_sayisi || 0}</td>
                  </tr>
                ))}
                {(stokKayip?.sube_ozet || []).length === 0 && (
                  <tr><td colSpan={4}><div className="empty"><p>Stok kayıp verisi yok</p></div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
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
            const keys = ['bardak_kucuk','bardak_buyuk','su_adet','sut_litre','soda_adet','redbull_adet','cookie_adet','pasta_adet'];
            const labels = { bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', su_adet:'Su', sut_litre:'Süt', soda_adet:'Soda', redbull_adet:'Redbull', cookie_adet:'Cookie', pasta_adet:'Pasta' };
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
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şube panelindeki <strong>Ürün Aç</strong> işlemleri saat/sorumlu bazında bu listede izlenir.
          </p>
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
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şubelerin günlük <strong>kullanılan ürün</strong> özeti bu listede izlenir (Açılış + Ürün Aç − Kapanış).
          </p>
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
          {kullanilanGorunenSatirlar.length === 0 ? (
            <div className="empty"><p>Bu tarihte kullanılan ürün kaydı yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflow: 'auto' }}>
              {kullanilanGorunenSatirlar.map((r) => {
                const keys = ['bardak_kucuk','bardak_buyuk','su_adet','sut_litre','soda_adet','redbull_adet','cookie_adet','pasta_adet'];
                const labels = { bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', su_adet:'Su', sut_litre:'Süt', soda_adet:'Soda', redbull_adet:'Redbull', cookie_adet:'Cookie', pasta_adet:'Pasta' };
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

      {aktifSekme === 'ciro-onay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Akşam kapanıştan gelen <strong>ciro taslakları</strong> burada şube/tarih bazında doğrulanır. Onaylanan kayıt CFO panelindeki ciro girişine otomatik işlenir; reddedilen kayıt yazılmaz.
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
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şubelerin plan saatine göre <strong>geç açılış</strong> kayıtları bu kartta izlenir.
          </p>
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
              {gecAcilanAramaSonuc?.tarih || gecAcilanAramaTarih} · {gecAcilanAramaSonuc?.toplam || 0} geç açılış
            </div>
          </div>

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
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>

          {gecAcilanGorunenKayitlar.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte geç açılan şube yok</p></div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg2)' }}>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Şube</th>
                    <th style={{ padding: '7px 8px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>Personel</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#93c5fd', fontWeight: 600 }}>Planlanan</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#fbbf24', fontWeight: 600 }}>Açılış</th>
                    <th style={{ padding: '7px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700 }}>Gecikme</th>
                  </tr>
                </thead>
                <tbody>
                  {gecAcilanGorunenKayitlar.map((r, idx) => (
                    <tr key={r.event_id || `${r.sube_id}-${r.tarih}-${idx}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 8px', fontWeight: 600 }}>{r.sube_adi || r.sube_id}</td>
                      <td style={{ padding: '7px 8px', color: 'var(--text2)' }}>{r.personel_ad || r.personel_id || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center' }}>{r.planlanan_saat || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center' }}>{r.acilis_saat || '—'}</td>
                      <td className="mono" style={{ padding: '7px 8px', textAlign: 'center', color: 'var(--red)', fontWeight: 700 }}>
                        +{Number(r.gecikme_dk || 0).toFixed(1)} dk
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'gec-kalan-personel' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Aylık bazda personel geç açılış tekrarları burada izlenir. Geç açılış eşiği: <strong>5 dk+</strong>, kritik eşik: <strong>30 dk+</strong>.
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

      {aktifSekme === 'kasa-uyumsuzluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Dün kapanış kasası ile bugün açılış kasası farkları bu ekranda izlenir.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tarih</span>
              <input
                type="date"
                className="input"
                value={kasaUyumAramaTarih}
                onChange={(e) => setKasaUyumAramaTarih(e.target.value || bugunIsoTarih())}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ alignSelf: 'flex-end' }}
              onClick={() => kasaUyumAramaYap()}
            >
              {kasaUyumAramaYukleniyor ? '…' : 'Tarihi getir'}
            </button>
            <div style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'flex-end' }}>
              {kasaUyumAramaSonuc?.tarih || kasaUyumAramaTarih} · {kasaUyumAramaSonuc?.toplam || 0} uyumsuzluk
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setKasaUyumSeciliSubeKey('all')}
              style={{
                border: kasaUyumSeciliSubeKey === 'all' ? '1px solid #e85d5d' : '1px solid var(--border)',
                background: kasaUyumSeciliSubeKey === 'all' ? 'rgba(232, 93, 93, 0.2)' : 'var(--bg2)',
                color: kasaUyumSeciliSubeKey === 'all' ? '#fecaca' : 'var(--text2)',
                padding: '6px 10px',
                fontWeight: 700,
              }}
            >
              Tümü
            </button>
            {kasaUyumSubeSekmeleri.map((s) => (
              <button
                key={`kasa-uyum-${s.key}`}
                type="button"
                className="btn btn-sm"
                onClick={() => setKasaUyumSeciliSubeKey(s.key)}
                style={{
                  border: kasaUyumSeciliSubeKey === s.key ? '1px solid #4a9eff' : '1px solid var(--border)',
                  background: kasaUyumSeciliSubeKey === s.key ? 'rgba(74, 158, 255, 0.2)' : 'var(--bg2)',
                  color: kasaUyumSeciliSubeKey === s.key ? '#e6f7ff' : 'var(--text2)',
                  padding: '6px 10px',
                  fontWeight: 700,
                }}
              >
                {s.baslik} ({s.adet})
              </button>
            ))}
          </div>

          {kasaUyumGorunenKayitlar.length === 0 ? (
            <div className="empty"><p>Seçilen tarihte kasa uyumsuzluğu yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 480, overflow: 'auto' }}>
              {kasaUyumGorunenKayitlar.map((u) => {
                const fark = Number(u?.fark_tl || 0);
                const absFark = Math.abs(fark);
                const farkPozitif = fark >= 0;
                return (
                  <div key={u.id} className="card" style={{ padding: '12px 14px', borderLeft: `4px solid ${absFark >= 200 ? 'var(--red)' : 'var(--yellow)'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {u.sube_adi || u.sube_id}
                          <span style={{ marginLeft: 8 }} className={`badge ${absFark >= 200 ? 'badge-red' : 'badge-yellow'}`}>
                            {farkPozitif ? '+' : ''}{fmt(fark)}
                          </span>
                        </div>
                        <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                          {u.tarih} · Dün kapanış: {fmt(u.beklenen_tl || 0)} · Bugün açılış: {fmt(u.gercek_tl || 0)}
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
        </div>
      )}

      {aktifSekme === 'urun-uyumsuzluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Dün kapanış ile bugünkü tüketim/akış arasında ürün bazlı uyumsuzluklar izlenir.
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
                const keys = ['bardak_kucuk','bardak_buyuk','bardak_plastik','su_adet','sut_litre','redbull_adet','soda_adet','cookie_adet','pasta_adet'];
                const labels = { bardak_kucuk:'K.Bardak', bardak_buyuk:'B.Bardak', bardak_plastik:'Plastik', su_adet:'Su', sut_litre:'Süt', redbull_adet:'Redbull', soda_adet:'Soda', cookie_adet:'Cookie', pasta_adet:'Pasta' };
                return (
                  <div key={`${r.sube_id}-${r.tarih}`} className="card" style={{ borderLeft: '4px solid #8b5cf6', padding: '14px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>{r.sube_adi || r.sube_id}</span>
                        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{r.tarih}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span className="badge badge-red">{r.uyumsuz_adet || 0} kalem uyumsuz</span>
                        {!r.kapanis_var && <span className="badge badge-yellow">Kapanış yok</span>}
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
                            <th style={{ padding: '5px 8px', textAlign: 'center', color: '#fca5a5', fontWeight: 700, fontSize: 11 }}>Fark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {keys.map((k) => {
                            const ac = Number(r?.acilis?.[k] || 0);
                            const ua = Number(r?.urun_ac?.[k] || 0);
                            const kap = Number(r?.kapanis?.[k] || 0);
                            const fark = Number(r?.satilan?.[k] || 0);
                            const uyumsuz = fark < 0;
                            return (
                              <tr key={k} style={{ borderTop: '1px solid var(--border)', background: uyumsuz ? 'rgba(220, 38, 38, 0.07)' : 'transparent' }}>
                                <td style={{ padding: '5px 8px', color: uyumsuz ? '#fecaca' : 'var(--text2)' }}>{labels[k] || k}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center' }}>{ac}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: ua > 0 ? '#86efac' : 'var(--text3)' }}>{ua > 0 ? `+${ua}` : ua}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', color: kap > 0 ? '#fbbf24' : 'var(--text3)' }}>{kap > 0 ? `-${kap}` : '—'}</td>
                                <td className="mono" style={{ padding: '5px 8px', textAlign: 'center', fontWeight: 700, color: uyumsuz ? 'var(--red)' : 'var(--text3)' }}>
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

      {aktifSekme === 'siparis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Bu sekmede <strong>sipariş kataloğu</strong> yönetilir (kategori, ürün ekleme ve aktif / pasif).
            Şubelerden gelen bekleyen siparişleri işlemek için hub’daki <strong>Şube sipariş</strong> kartına veya{' '}
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

      {aktifSekme === 'onay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Bu ekranda yalnızca şube kaynaklı iki ana onay akışı tutulur: <strong>ciro onayları</strong> ve <strong>anlık gider onayları</strong>.
            Anlık gider onaylandığında talep kuyruktan düşer; ciro onaylandığında kayıt resmi ciro + kasa akışına yazılır.
          </p>

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
              <div className="form-group" style={{ margin: 0 }}>
                <label>Şube *</label>
                <select value={mesajForm.sube_id} onChange={e => setMesajForm({ ...mesajForm, sube_id: e.target.value })}>
                  <option value="">Seçin</option>
                  {subeListeAdmin.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
                </select>
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
                disabled={mesajBusy || !mesajForm.sube_id || !mesajForm.mesaj.trim()}
                onClick={async () => {
                  setMesajBusy(true);
                  try {
                    await api('/ops/merkez-mesaj-gonder', { method: 'POST', body: mesajForm });
                    toast('Mesaj gönderildi', 'green');
                    setMesajForm({ sube_id: '', mesaj: '', oncelik: 'normal', ttl_saat: 72 });
                    const r = await api('/ops/merkez-mesajlar?limit=100');
                    setMesajListe(r.satirlar || []);
                  } catch (e) { toast(e.message || 'Hata'); }
                  setMesajBusy(false);
                }}
              >
                {mesajBusy ? '…' : 'Gönder'}
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
                  const entegreDepolar = (kuyrukDepolar || []).filter((d) => {
                    const adNorm = magazaAdNorm(d?.ad || '');
                    return MAGAZA_DORT_SUBE.some((m) => m.keys.some((k) => adNorm.includes(magazaAdNorm(k))));
                  });
                  const depoOpsiyonlari = entegreDepolar.length > 0 ? entegreDepolar : (kuyrukDepolar || []);
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
                              <span style={{ fontSize: 13, color: 'var(--text3)', flexShrink: 0 }}>Hedef depo şubesi:</span>
                              <select
                                className="input"
                                style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
                                value={kuyrukDepoSecim[sip.id] || ''}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  const prev = kuyrukDepoSecim[sip.id] || '';
                                  setKuyrukDepoSecim((p) => ({ ...p, [sip.id]: v }));
                                  if (v && v !== prev) {
                                    const url = subePanelHariciUrl(v);
                                    if (url) window.open(url, '_blank', 'noopener,noreferrer');
                                  }
                                }}
                              >
                                <option value="">— Depo şubesi seçin —</option>
                                {depoOpsiyonlari.map(d => (
                                  <option key={d.id} value={d.id}>{d.ad} ({d.sube_tipi})</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={!kuyrukDepoSecim[sip.id]}
                                title="Seçili depo şubesinin panelini yeni sekmede açar"
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
                                className="btn btn-sm btn-primary"
                                disabled={!kuyrukDepoSecim[sip.id] || kuyrukBusy === sip.id}
                                onClick={() => gonderilenleIlgiliDepoyaGonder(sip.id)}
                              >
                                {kuyrukBusy === sip.id ? '…' : 'Talebi bu depoya yönlendir'}
                              </button>
                            </div>
                            {depoOpsiyonlari.length === 0 && (
                              <div style={{ fontSize: 11, color: '#e8a03d' }}>
                                Aktif depo şubesi bulunamadı. Depo listesi `subeler` tablosunda
                                `sube_tipi` (depo/karma/sevkiyat/merkez) ve `aktif=TRUE` kayıtlarından gelir.
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
                              Depo seçince ilgili şubenin paneli yeni sekmede açılır; talebi sıraya almak için <strong>Talebi bu depoya yönlendir</strong> kullanın.
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

          {/* 1. KRİTİK STOK PANELİ */}
          {disiplinPanel === 'kritik' && !disiplinYukleniyor && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>🔴 Kritik Stok</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Merkez ve şube depolarında alarm seviyesine düşen stoklar</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span className="badge badge-red">KRİZ = 0 adet</span>
                  <span className="badge" style={{ background: '#5a1a1a', color: '#ff8080' }}>KRİTİK = 1 adet</span>
                  <span className="badge badge-gray">DÜŞÜK ≤ min</span>
                </div>
              </div>
              {(kritikStok?.alarmlar || []).length === 0 ? (
                <div className="empty" style={{ padding: 32 }}><p>Stok alarmı yok ✓</p></div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead><tr>
                      <th>Kaynak</th><th>Ürün</th><th>Mevcut</th><th>Rezerve</th><th>Min Stok</th><th>Seviye</th><th>Bekleyen Sipariş</th>
                    </tr></thead>
                    <tbody>
                      {(kritikStok?.alarmlar || []).map((a, i) => (
                        <tr key={i} style={{ background: a.seviye === 'KRIZ' ? 'rgba(232,93,93,0.08)' : a.seviye === 'KRITIK' ? 'rgba(232,93,93,0.04)' : 'transparent' }}>
                          <td><span className="badge" style={{ background: a.kaynak === 'merkez' ? '#1a3a5c' : '#1a3a2a', color: a.kaynak === 'merkez' ? '#4a9eff' : '#2db573', fontSize: 11 }}>{a.kaynak === 'merkez' ? '🏭 Merkez' : `🏪 ${a.sube_adi || a.sube_id}`}</span></td>
                          <td style={{ fontWeight: 500 }}>{a.kalem_adi || a.kalem_kodu}</td>
                          <td className="mono" style={{ color: a.mevcut === 0 ? '#e85d5d' : a.mevcut === 1 ? '#f08040' : 'var(--text)', fontWeight: 700 }}>{a.mevcut}</td>
                          <td className="mono" style={{ color: 'var(--text3)' }}>{a.rezerve || 0}</td>
                          <td className="mono" style={{ color: 'var(--text3)' }}>{a.min_stok}</td>
                          <td><span className="badge" style={{ background: a.seviye === 'KRIZ' ? '#5a1a1a' : a.seviye === 'KRITIK' ? '#3a2a1a' : '#2a2a2a', color: a.seviye === 'KRIZ' ? '#ff6060' : a.seviye === 'KRITIK' ? '#f08040' : 'var(--text3)', fontSize: 11 }}>{a.seviye}</span></td>
                          <td className="mono" style={{ color: a.bekleyen_siparis > 0 ? '#c9a227' : 'var(--text3)' }}>{a.bekleyen_siparis || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 2. SİPARİŞ AKIŞ TABLOSU */}
          {disiplinPanel === 'akis' && !disiplinYukleniyor && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>🟡 Sipariş Akışı</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Şube → Tahsis → Sevk → Kabul zinciri</div>
              </div>
              {(siparisAkis?.siparis_akis || []).length === 0 ? (
                <div className="empty" style={{ padding: 32 }}><p>Sipariş verisi yok</p></div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead><tr>
                      <th>Şube</th><th>Tarih</th><th>Kalem</th><th>Son Olay</th><th>Durum</th><th>Timeline</th>
                    </tr></thead>
                    <tbody>
                      {(siparisAkis?.siparis_akis || []).map(s => {
                        const OLAY_RENK = { SIPARIS_OLUSTU: '#6b6f7a', TAHSIS_TAM: '#2db573', TAHSIS_KISMI: '#c9a227', TAHSIS_YOK: '#e85d5d', SEVK_CIKTI: '#4a9eff', KABUL_TAM: '#2db573', KABUL_EKSIK: '#f08040', URUN_AC: '#a78bfa', KULLANIM: '#7c6fdc' };
                        const DURUM_RENK = { bekliyor: '#c9a227', onaylandi: '#2db573', gonderildi: '#4a9eff', teslim_edildi: '#2db573', iptal: '#e85d5d' };
                        const yoldaSatirlari = Array.isArray(s?.yolda) ? s.yolda : [];
                        const aktifUyumsuzVar = yoldaSatirlari.some((y) => {
                          const sevk = Number(y?.sevk_adet || 0);
                          const kabul = y?.kabul_adet == null ? null : Number(y.kabul_adet || 0);
                          const d = String(y?.durum || '').trim().toLowerCase();
                          if (d === 'uzlasildi') return false;
                          if (d === 'kabul_uyusmazlik') return true;
                          return kabul != null && sevk !== kabul;
                        });
                        const uzlasiTamam = yoldaSatirlari.length > 0
                          && yoldaSatirlari.every((y) => String(y?.durum || '').trim().toLowerCase() === 'uzlasildi');
                        return (
                          <tr key={s.id}>
                            <td style={{ fontWeight: 500 }}>{s.sube_adi || s.sube_id}</td>
                            <td style={{ color: 'var(--text3)', fontSize: 12 }}>{s.tarih}</td>
                            <td className="mono" style={{ color: 'var(--text3)' }}>{s.kalem_sayisi} kalem</td>
                            <td><span style={{ fontSize: 11, color: OLAY_RENK[s.son_olay] || 'var(--text3)', fontWeight: 600 }}>{s.son_olay || '—'}</span><div style={{ fontSize: 10, color: 'var(--text3)' }}>{s.son_olay_ts ? s.son_olay_ts.slice(0, 16).replace('T', ' ') : ''}</div></td>
                            <td>
                              <span className="badge" style={{ fontSize: 11, background: 'transparent', border: `1px solid ${DURUM_RENK[s.durum] || 'var(--border)'}`, color: DURUM_RENK[s.durum] || 'var(--text3)' }}>{s.durum}</span>
                              {aktifUyumsuzVar && (
                                <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>Sevkiyat blokajı</span>
                              )}
                              {uzlasiTamam && (
                                <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 10 }}>Uzlaşı tamam · blokaj kalktı</span>
                              )}
                            </td>
                            <td><button type="button" className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setTimelineAcik(timelineAcik === s.id ? null : s.id)}>📋</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {/* Timeline detay */}
              {timelineAcik && (() => {
                const s = (siparisAkis?.siparis_akis || []).find(x => x.id === timelineAcik);
                if (!s) return null;
                const OLAY_IKON = { SIPARIS_OLUSTU: '📝', TAHSIS_TAM: '✅', TAHSIS_KISMI: '⚠️', TAHSIS_YOK: '❌', SEVK_CIKTI: '🚚', KABUL_TAM: '✅', KABUL_EKSIK: '⚠️', URUN_AC: '📤', KULLANIM: '📦' };
                return (
                  <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>📋 {s.sube_adi} — {s.tarih}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(s.tahsis || []).map((t, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                          <span style={{ color: 'var(--text3)', minWidth: 120 }}>{t.kalem_adi || t.kalem_kodu}</span>
                          <span className="mono">Talep: {t.talep_adet}</span>
                          <span className="mono">Tahsis: {t.tahsis_adet}</span>
                          <span className="badge" style={{ fontSize: 10 }}>{t.durum}</span>
                          {(s.yolda || []).filter(y => y.kalem_kodu === t.kalem_kodu).map((y, j) => (
                            <span key={j} className="mono" style={{ color: 'var(--text3)' }}>
                              Sevk: {y.sevk_adet} | Kabul: {y.kabul_adet ?? '—'}
                              {String(y?.durum || '').trim().toLowerCase() === 'uzlasildi' && (
                                <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 10 }}>Uzlaşı tamam</span>
                              )}
                              {String(y?.durum || '').trim().toLowerCase() === 'kabul_uyusmazlik' && (
                                <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>Uyumsuzluk</span>
                              )}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

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
