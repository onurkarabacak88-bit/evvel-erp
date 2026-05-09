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
    const msg = detailToMessage(err.detail);
    throw new Error(msg || res.statusText || 'İstek başarısız');
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
