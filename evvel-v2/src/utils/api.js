const BASE = import.meta.env.VITE_API_URL || '';

export async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) },
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
