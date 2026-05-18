/**
 * raporCache.js — Frontend cache-first hibrit yardımcıları
 *
 * Pattern: önce hızlı cache'ten okuyup ekrana bas, ardından canlı veriyi
 * arka planda çek. Veri gelince ekranı sessizce güncelle.
 *
 * Cache freshness mantığı (Toast/Lightspeed/Oracle standardı):
 *   - 🟢 GÜNCEL  (<2 dk)   → yeşil, "Canlı"
 *   - 🟡 ESKİYOR (2-15 dk) → sarı, "X dk önce"
 *   - 🟠 ESKİ    (15-60 dk)→ turuncu, "Eski veri"
 *   - 🔴 ÇOK ESKİ (>60 dk) → kırmızı, "Çok eski — yenileyin"
 *   - ⚫ YOK      → gri, "Cache yok"
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';

/**
 * Cache freshness seviyesi hesapla
 * @param {Date|null} guncelleme - Son güncelleme zamanı
 * @returns {object} { seviye, dakika, renk, bg, border, label, icon }
 */
export function cacheFreshness(guncelleme) {
  if (!guncelleme) {
    return {
      seviye: 'yok',
      dakika: null,
      renk: '#94a3b8',
      bg: 'rgba(148,163,184,0.12)',
      border: 'rgba(148,163,184,0.35)',
      label: 'Cache yok',
      icon: '⚫',
    };
  }
  const dt = guncelleme instanceof Date ? guncelleme : new Date(guncelleme);
  const dakika = Math.floor((Date.now() - dt.getTime()) / 60000);
  if (dakika < 2) {
    return {
      seviye: 'guncel',
      dakika,
      renk: '#22c55e',
      bg: 'rgba(34,197,94,0.12)',
      border: 'rgba(34,197,94,0.35)',
      label: 'Canlı',
      icon: '🟢',
    };
  }
  if (dakika < 15) {
    return {
      seviye: 'eskiyor',
      dakika,
      renk: '#eab308',
      bg: 'rgba(234,179,8,0.12)',
      border: 'rgba(234,179,8,0.35)',
      label: `${dakika} dk önce`,
      icon: '🟡',
    };
  }
  if (dakika < 60) {
    return {
      seviye: 'eski',
      dakika,
      renk: '#f97316',
      bg: 'rgba(249,115,22,0.12)',
      border: 'rgba(249,115,22,0.35)',
      label: 'Eski veri',
      icon: '🟠',
    };
  }
  return {
    seviye: 'cok_eski',
    dakika,
    renk: '#dc2626',
    bg: 'rgba(220,38,38,0.12)',
    border: 'rgba(220,38,38,0.35)',
    label: 'Çok eski',
    icon: '🔴',
  };
}

/**
 * useRaporCache — cache-first hibrit data hook
 *
 * Davranış:
 *   1) Sayfa ilk açıldığında cache'ten oku (50-100ms — anında ekran dolar)
 *   2) Aynı anda canlı endpoint'i çağır (1-2sn — sessizce gelir)
 *   3) Canlı veri geldikten sonra state'i değiştir (UI sessiz update olur)
 *   4) Canlı çağrı başarısızsa cache veriyi göstermeye devam et
 *
 * @param {object} options
 *   - cachePath: cache endpoint path (örn. '/ops/rapor-cache/gunluk')
 *   - cacheParams: { key: value } query params (cache çağrısı için)
 *   - livePath: canlı endpoint path (örn. '/ops/kapanis-takip')
 *   - liveParams: { key: value } query params (live çağrısı için)
 *   - autoRefreshMs: otomatik yenileme aralığı (varsayılan: yok)
 *   - cacheTransform: cache cevabını state formatına çevirme fonksiyonu (opsiyonel)
 *   - liveTransform: live cevabını state formatına çevirme (opsiyonel)
 *   - enabled: hook aktif mi (false ise hiçbir şey yapmaz; örn. sekme kapalıysa)
 *
 * @returns {object} { data, yukleniyor, hata, kaynak, sonGuncelleme, yenile, cacheGuncelleme }
 *   - data: en güncel veri (cache ya da live)
 *   - yukleniyor: sadece ilk yüklemede true; refresh sırasında false (sessiz)
 *   - hata: en son hata mesajı (null = sorun yok)
 *   - kaynak: 'cache' | 'live' | null (verinin nereden geldiği)
 *   - sonGuncelleme: en son veri ne zaman geldi (Date)
 *   - cacheGuncelleme: cache'in DB'deki guncelleme alanı (Date, varsa)
 *   - yenile(opts): manuel refresh (live çağrı tetikler)
 */
export function useRaporCache({
  cachePath,
  cacheParams = {},
  livePath,
  liveParams = {},
  autoRefreshMs = null,
  cacheTransform,
  liveTransform,
  enabled = true,
}) {
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [kaynak, setKaynak] = useState(null); // 'cache' | 'live'
  const [sonGuncelleme, setSonGuncelleme] = useState(null);
  const [cacheGuncelleme, setCacheGuncelleme] = useState(null);
  const intervalRef = useRef(null);
  const ilkYukleme = useRef(true);

  // Query string oluşturucu
  const qs = (params) => {
    const e = Object.entries(params).filter(([, v]) => v != null && v !== '');
    return e.length ? '?' + e.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  };

  const cacheUrl = cachePath ? cachePath + qs(cacheParams) : null;
  const liveUrl = livePath ? livePath + qs(liveParams) : null;
  const cacheKey = JSON.stringify(cacheParams);
  const liveKey = JSON.stringify(liveParams);

  // CACHE FETCH (hızlı, anında göster)
  const cacheFetch = useCallback(async () => {
    if (!cacheUrl) return null;
    try {
      const r = await api(cacheUrl);
      const transformed = cacheTransform ? cacheTransform(r) : r;
      if (transformed != null) {
        setData(transformed);
        setKaynak('cache');
        setSonGuncelleme(new Date());
        // Cache içinden guncelleme alanı varsa onu da kaydet (DB freshness)
        const ilkKayit = Array.isArray(r?.kayitlar) && r.kayitlar.length > 0 ? r.kayitlar[0] : null;
        if (ilkKayit?.guncelleme) {
          setCacheGuncelleme(new Date(ilkKayit.guncelleme));
        }
        return transformed;
      }
    } catch {
      // Cache hatası sessiz — live tarafı devam etsin
      return null;
    }
    return null;
  }, [cacheUrl, cacheKey, cacheTransform]);

  // LIVE FETCH (yavaş, kesin doğru)
  const liveFetch = useCallback(async (silent = false) => {
    if (!liveUrl) return null;
    if (!silent && ilkYukleme.current) setYukleniyor(true);
    setHata(null);
    try {
      const r = await api(liveUrl);
      const transformed = liveTransform ? liveTransform(r) : r;
      setData(transformed);
      setKaynak('live');
      setSonGuncelleme(new Date());
      return transformed;
    } catch (e) {
      setHata(e.message || 'Veri yüklenemedi');
      return null;
    } finally {
      if (!silent) setYukleniyor(false);
      ilkYukleme.current = false;
    }
  }, [liveUrl, liveKey, liveTransform]);

  // İlk yükleme: cache + live paralel; cache hızlı dönerse hemen göster
  useEffect(() => {
    if (!enabled) return;
    ilkYukleme.current = true;
    // Önce cache (hızlı, varsa anında göster)
    cacheFetch();
    // Hemen live (cache'in üstüne yazacak)
    liveFetch(false);
  }, [enabled, cacheUrl, liveUrl]); // params değişirse yeniden yükle

  // Auto-refresh
  useEffect(() => {
    if (!enabled || !autoRefreshMs) return;
    intervalRef.current = setInterval(() => {
      liveFetch(true); // silent refresh
    }, autoRefreshMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, autoRefreshMs, liveFetch]);

  // Manuel refresh
  const yenile = useCallback(async (opts = {}) => {
    const silent = !!opts.silent;
    return liveFetch(silent);
  }, [liveFetch]);

  return {
    data,
    yukleniyor,
    hata,
    kaynak,
    sonGuncelleme,
    cacheGuncelleme,
    yenile,
  };
}

/**
 * Cache durumunu insan diline çevir (tooltip için detay).
 */
export function cacheTooltip(kaynak, sonGuncelleme, cacheGuncelleme) {
  const parts = [];
  if (kaynak === 'cache') parts.push('⚡ Cache\'ten hızlı yüklendi');
  else if (kaynak === 'live') parts.push('🌐 Canlı veri');
  if (sonGuncelleme) {
    const dt = sonGuncelleme instanceof Date ? sonGuncelleme : new Date(sonGuncelleme);
    parts.push(`Ekrana geldi: ${dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  }
  if (cacheGuncelleme) {
    const dt = cacheGuncelleme instanceof Date ? cacheGuncelleme : new Date(cacheGuncelleme);
    parts.push(`Cache'teki kayıt: ${dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`);
  }
  return parts.join('\n');
}
