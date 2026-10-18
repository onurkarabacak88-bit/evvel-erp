// 📱 CİHAZ KİMLİĞİ — telefon / tablet imzalı istek (YOKLAMA_QR_TASARIM.md §B4; sunucu: evvel_yeni_yoklama_api.cihaz_coz)
// PIN yok. Cihaz bir kez bağlanır: WebCrypto ECDSA P-256 anahtar ÇIKARILAMAZ (extractable:false), IndexedDB'de CryptoKey olarak
// durur — localStorage'a özel anahtar YAZILMAZ (kopyalama saldırısı kapanır). Her istek: zaman + tek kullanımlık nonce + imza.
// Geri düşüş (crypto.subtle / IndexedDB yoksa): ≥32 karakter rastgele jeton → `X-Evvel-Cihaz-Jeton` (merkez "zayıf bağ" görür).
// Telefon ve tablet AYNI tarayıcıda olabilir → her tür kendi anahtarı / kimliği (tur = 'telefon' | 'tablet').
const BASE = import.meta.env.VITE_API_URL || '';
const DB_AD = 'evvel_cihaz';
const DEPO = 'anahtar';
const _bellek = {};   // IndexedDB / localStorage yoksa oturumluk yedek

const subtle = () => (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) || null;
const kimlikAnahtari = (tur) => `ey_cihaz_id:${tur}`;
const jetonAnahtari = (tur) => `ey_cihaz_jeton:${tur}`;

// ── IndexedDB (CryptoKey saklanabilir; structured clone) ──
function idbAc() {
  return new Promise((cozdu, red) => {
    try {
      if (typeof window.indexedDB === 'undefined') { red(new Error('IndexedDB yok')); return; }
      const r = window.indexedDB.open(DB_AD, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DEPO)) r.result.createObjectStore(DEPO); };
      r.onsuccess = () => cozdu(r.result);
      r.onerror = () => red(r.error || new Error('IndexedDB açılamadı'));
      r.onblocked = () => red(new Error('IndexedDB kilitli'));
    } catch (e) { red(e); }
  });
}
function idbIslem(mod, fn) {
  return idbAc().then((db) => new Promise((cozdu, red) => {
    const t = db.transaction(DEPO, mod);
    const r = fn(t.objectStore(DEPO));
    t.oncomplete = () => { db.close(); cozdu(r && r.result !== undefined ? r.result : undefined); };
    t.onerror = () => { db.close(); red(t.error || new Error('IndexedDB hatası')); };
    t.onabort = () => { db.close(); red(t.error || new Error('IndexedDB iptal')); };
  }));
}
const idbOku = (k) => idbIslem('readonly', (s) => s.get(k));
const idbYaz = (k, v) => idbIslem('readwrite', (s) => s.put(v, k));
const idbSil = (k) => idbIslem('readwrite', (s) => s.delete(k));

// ── küçük saklama (yalnız kimlik + zayıf-bağ jetonu; özel anahtar ASLA burada değil) ──
function lsOku(k) { try { return localStorage.getItem(k) || _bellek[k] || ''; } catch { return _bellek[k] || ''; } }
function lsYaz(k, v) { _bellek[k] = v; try { localStorage.setItem(k, v); } catch { /* yok say */ } }
function lsSil(k) { delete _bellek[k]; try { localStorage.removeItem(k); } catch { /* yok say */ } }

const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]); return window.btoa(s); };
const hex = (buf) => Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
function rastgele(n) {
  const b = new Uint8Array(n);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
  else for (let i = 0; i < n; i += 1) b[i] = Math.floor(Math.random() * 256);
  return hex(b.buffer);
}
export const yeniIstekId = () => (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : rastgele(16)).slice(0, 60);

/** Bu tarayıcıda o tür cihaz bağlı mı → cihaz_id (eşzamanlı; yalnız kimlik). */
export function cihazId(tur) { return lsOku(kimlikAnahtari(tur)); }

/** Bağı bu cihazdan sil (yeni davet için). Sunucudaki iptal merkezden. */
export async function cihazUnut(tur) {
  lsSil(kimlikAnahtari(tur)); lsSil(jetonAnahtari(tur));
  try { await idbSil(`anahtar:${tur}`); } catch { /* yok */ }
}

async function anahtarUret() {
  const s = subtle();
  if (!s) return null;
  const cift = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);   // özel anahtar çıkarılamaz
  const jwk = await s.exportKey('jwk', cift.publicKey);
  return { ozel: cift.privateKey, acik: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

/**
 * Merkezin linkini açınca: anahtar üret → POST /cihaz-bagla → cihaz_id'yi sakla (sunucunun döndürdüğü türe göre).
 * Dönüş: { cihaz_id, tur, durum, ad, guc, mesaj }. Hata: Error (mesaj Türkçe, .status).
 */
export async function cihazBagla(davet, etiket) {
  let anahtar = null;
  let kayitli = false;
  try {
    anahtar = await anahtarUret();
    if (anahtar) { await idbYaz('anahtar:_yeni', anahtar); kayitli = true; }   // IndexedDB çalışıyor mu? (çıkarılamaz anahtar sadece burada yaşar)
  } catch { kayitli = false; }
  const govde = { davet, etiket: (etiket || '').slice(0, 60) || null };
  let jeton = '';
  if (anahtar && kayitli) govde.acik_anahtar = anahtar.acik;
  else { jeton = rastgele(24); govde.jeton = jeton; }   // zayıf bağ (48 karakter)
  const r = await fetch(`${BASE}/api/evvel-yeni/yoklama/cihaz-bagla`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(_mesaj(d.detail) || 'Bağlanamadı'); e.status = r.status; throw e; }
  const tur = d.tur || 'telefon';
  if (anahtar && kayitli) { await idbYaz(`anahtar:${tur}`, anahtar); try { await idbSil('anahtar:_yeni'); } catch { /* yok */ } }
  else lsYaz(jetonAnahtari(tur), jeton);
  lsYaz(kimlikAnahtari(tur), d.cihaz_id);
  return d;
}

function _mesaj(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((x) => (typeof x === 'string' ? x : x?.msg || '')).filter(Boolean).join('; ');
  return detail.mesaj || detail.detail || detail.msg || '';
}

/**
 * İmzalı istek. url: '/api/evvel-yeni/yoklama/ben?sube=…' gibi (BASE öne eklenir). bodyObj varsa TEK KEZ JSON.stringify edilir;
 * aynı baytlar hem sha256'ya hem gövdeye gider. İmzalanan: `${cihaz_id}|${zaman}|${nonce}|${METHOD}|${path}|${sha256hex(gövde)}`
 * (path = sorgu dizesi HARİÇ yol). Dönüş: ham Response (qr.png blob için). JSON için imzaliJson.
 */
export async function imzaliFetch(tur, method, url, bodyObj) {
  const cid = cihazId(tur);
  if (!cid) { const e = new Error('Bu cihaz tanımlı değil — merkezden bağlantı linki iste'); e.status = 403; e.cihaz_yok = true; throw e; }
  const M = String(method || 'GET').toUpperCase();
  const govdeStr = bodyObj === undefined || bodyObj === null ? '' : JSON.stringify(bodyObj);
  const tam = `${BASE}${url}`;
  const headers = { 'X-Evvel-Cihaz': cid };
  if (govdeStr) headers['Content-Type'] = 'application/json';
  let anahtar = null;
  try { anahtar = await idbOku(`anahtar:${tur}`); } catch { anahtar = null; }
  const s = subtle();
  if (anahtar && anahtar.ozel && s) {
    const path = new URL(tam, window.location.origin).pathname;
    const zaman = Math.floor(Date.now() / 1000);
    const nonce = yeniIstekId();
    const enc = new window.TextEncoder();
    const hashHex = hex(await s.digest('SHA-256', enc.encode(govdeStr)));
    const mesaj = `${cid}|${zaman}|${nonce}|${M}|${path}|${hashHex}`;
    const imza = await s.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, anahtar.ozel, enc.encode(mesaj));   // r||s 64 bayt
    headers['X-Evvel-Zaman'] = String(zaman);
    headers['X-Evvel-Nonce'] = nonce;
    headers['X-Evvel-Imza'] = b64(imza);
  } else {
    const j = lsOku(jetonAnahtari(tur));
    if (!j) { const e = new Error('Cihaz anahtarı bulunamadı — merkezden yeni bağlantı linki iste'); e.status = 403; e.cihaz_yok = true; throw e; }
    headers['X-Evvel-Cihaz-Jeton'] = j;
  }
  return fetch(tam, { method: M, headers, body: govdeStr || undefined, cache: 'no-store' });
}

/** imzaliFetch + JSON; hata → Error(mesaj Türkçe, .status). Ağ düşüşü TypeError olarak gelir (çağıran 'tekrar dene' verir). */
export async function imzaliJson(tur, method, url, bodyObj) {
  const r = await imzaliFetch(tur, method, url, bodyObj);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(_mesaj(d.detail) || r.statusText || 'İstek başarısız'); e.status = r.status; throw e; }
  return d;
}
