import { bugunTR } from './trTarih';
const BASE = import.meta.env.VITE_API_URL || '';

/** FastAPI / Starlette: detail string | object | array — kullanıcıya okunur metin */
function detailToMessage(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && typeof x.msg === 'string') return x.msg;
        try {
          return JSON.stringify(x);
        } catch {
          return String(x);
        }
      })
      .filter(Boolean)
      .join('; ');
  }
  if (typeof detail === 'object') {
    if (typeof detail.mesaj === 'string') return detail.mesaj;
    if (typeof detail.hata === 'string') return detail.hata;
    if (typeof detail.detail === 'string') return detail.detail;
    if (typeof detail.msg === 'string') return detail.msg;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

// ─── İSTEK HATASI DUYUSU (yeni handoff: "sessiz .catch yasak") ───────────────
// Sorun: v2'de 100+ `.catch(() => [])` var. Bir uç düştüğünde ekran sessizce
// "kayıt yok" diyordu — bu YANLIŞ BİLGİ ("veri yok" ≠ "sistem bozuk").
// Her catch'i tek tek yamamak yerine TEK BOĞAZ NOKTASINA duyu koyuyoruz:
// api() zaten hepsinin geçtiği yer. Başarısız GET'ler burada biriktirilir,
// kabuk bunu okuyup kanonik hata bandını doğurur. Yutan catch akışı bozmaz,
// ama artık SESSİZ değil — iz kalır.
const _hatalar = new Map();          // yol → { yol, mesaj, kod, adet, zaman }
const _dinleyiciler = new Set();

function _hataYaz(yol, mesaj, kod) {
  const onceki = _hatalar.get(yol);
  _hatalar.set(yol, {
    yol,
    mesaj: String(mesaj || '').slice(0, 160),
    kod: kod || null,
    adet: (onceki?.adet || 0) + 1,
    zaman: new Date().toISOString(),
  });
  _dinleyiciler.forEach((f) => { try { f(); } catch { /* dinleyici çökerse akış yaşar */ } });
}

/** Kabuk buradan okur: o an açık ekranda başarısız olan istekler. */
export function istekHatalari() {
  return [..._hatalar.values()];
}

/** Görünüm değişince / kullanıcı 'tekrar dene' deyince defter temizlenir. */
export function istekHatalariniTemizle() {
  if (_hatalar.size === 0) return;
  _hatalar.clear();
  _dinleyiciler.forEach((f) => { try { f(); } catch { /* yut */ } });
}

export function istekHatasiDinle(fn) {
  _dinleyiciler.add(fn);
  return () => _dinleyiciler.delete(fn);
}

export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  try {
    const mut =
      typeof localStorage !== 'undefined'
        ? (localStorage.getItem('evvelMerkezMutasyonKey') || '').trim()
        : '';
    if (mut && ['PUT', 'POST', 'PATCH', 'DELETE'].includes(method)) {
      headers['X-Evvel-Merkez-Key'] = mut;
    }
  } catch {
    /* ignore */
  }
  // 🔐 ADMIN OTURUM JETONU (2026-09-02) — her istege eklenir.
  // Sunucu tarafinda halka acik yuzeydeki yonetim uclari artik bu jetonu
  // istiyor (is-basvurusu: liste/okuma/ise-al/silme). Jeton yoksa baslik da
  // yok: halka acik uclar (basvuru formu) etkilenmez.
  try {
    const jeton =
      typeof localStorage !== 'undefined'
        ? (localStorage.getItem('evvel_oturum') || '').trim()
        : '';
    if (jeton) headers['X-Evvel-Oturum'] = jeton;
  } catch {
    /* ignore */
  }
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      headers,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // Ağ seviyesinde düşüş (bağlantı yok / CORS / iptal)
    if (method === 'GET') _hataYaz(path, e?.message || 'ağa ulaşılamadı', 'AG_HATASI');
    throw e;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const msg = detailToMessage(err.detail);
    // YALNIZ okuma istekleri deftere yazılır: yazma hataları zaten kullanıcıya
    // toast/modal ile dönüyor, ikinci kez bant açmak gürültü olur.
    if (method === 'GET') _hataYaz(path, msg || res.statusText, `HTTP_${res.status}`);
    throw new Error(msg || res.statusText || 'İstek başarısız');
  }
  // Uç düzelirse kendi izini siler — bant asılı kalmaz
  if (method === 'GET' && _hatalar.has(path)) {
    _hatalar.delete(path);
    _dinleyiciler.forEach((f) => { try { f(); } catch { /* yut */ } });
  }
  return res.json();
}

export const fmt = (n) => {
  if (n == null || isNaN(n)) return '---';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(n) + ' ₺';
};

export const fmtDate = (d) => {
  if (!d) return '---';
  return new Date(d).toLocaleDateString('tr-TR');
};

export const today = () => bugunTR();
