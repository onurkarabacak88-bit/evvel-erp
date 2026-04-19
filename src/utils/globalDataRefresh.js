const GLOBAL_REFRESH_KEY = 'global_data_refresh_tick';
const GLOBAL_REFRESH_EVENT = 'global-data-updated';

export function publishGlobalDataRefresh(kaynak = 'unknown') {
  try {
    const ts = String(Date.now());
    localStorage.setItem(GLOBAL_REFRESH_KEY, ts);
    window.dispatchEvent(new CustomEvent(GLOBAL_REFRESH_EVENT, { detail: { ts, kaynak } }));
  } catch (_) {
    // ignore
  }
}

export function subscribeGlobalDataRefresh(onRefresh) {
  if (typeof window === 'undefined' || typeof onRefresh !== 'function') {
    return () => {};
  }

  const handleGlobal = (e) => onRefresh(e?.detail || null);
  const handleStorage = (e) => {
    if (e.key === GLOBAL_REFRESH_KEY && e.newValue) {
      onRefresh({ ts: e.newValue, kaynak: 'storage' });
    }
  };

  window.addEventListener(GLOBAL_REFRESH_EVENT, handleGlobal);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(GLOBAL_REFRESH_EVENT, handleGlobal);
    window.removeEventListener('storage', handleStorage);
  };
}
