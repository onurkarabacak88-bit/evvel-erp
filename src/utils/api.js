const BASE = import.meta.env.VITE_API_URL || '';

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
  const res = await fetch(`${BASE}/api${path}`, {
    headers,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
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

export const today = () => new Date().toISOString().split('T')[0];
