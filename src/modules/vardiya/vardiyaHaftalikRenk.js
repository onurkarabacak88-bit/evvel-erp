/**
 * Tulipi tarzı haftalık tablo: şube / saat / izin hücre renkleri.
 * Hücrede başka şube adı yazıldığında o şubenin paleti uygulanır (PDF’deki gibi).
 */

/** Aktif şubeler sırasıyla aynı renk indeksini alır (haftadan haftaya tutarlı). */
export const SUBE_PALETTES = [
  { bg: 'hsl(210, 75%, 90%)', accent: 'hsl(210, 65%, 45%)' },
  { bg: 'hsl(38, 90%, 88%)', accent: 'hsl(32, 85%, 42%)' },
  { bg: 'hsl(145, 55%, 88%)', accent: 'hsl(145, 50%, 34%)' },
  { bg: 'hsl(330, 65%, 90%)', accent: 'hsl(330, 55%, 48%)' },
  { bg: 'hsl(275, 45%, 90%)', accent: 'hsl(275, 40%, 45%)' },
  { bg: 'hsl(175, 50%, 88%)', accent: 'hsl(175, 45%, 36%)' },
  { bg: 'hsl(25, 85%, 90%)', accent: 'hsl(25, 75%, 42%)' },
  { bg: 'hsl(265, 60%, 90%)', accent: 'hsl(265, 50%, 45%)' },
  { bg: 'hsl(85, 50%, 88%)', accent: 'hsl(85, 45%, 32%)' },
  { bg: 'hsl(350, 70%, 92%)', accent: 'hsl(350, 60%, 46%)' },
];

function normTr(s) {
  return (s || '').toLocaleUpperCase('tr-TR').replace(/\s+/g, ' ').trim();
}

/** rehber: [{ id, ad }] */
export function subeRenkIndeksi(subeAdi, rehber) {
  const n = normTr(subeAdi);
  if (!n || n === '—') return null;
  const i = (rehber || []).findIndex((r) => normTr(r.ad) === n);
  if (i < 0) return null;
  return i % SUBE_PALETTES.length;
}

export function subeSatirStili(subeAdi, rehber) {
  const idx = subeRenkIndeksi(subeAdi, rehber);
  if (idx == null) {
    return {
      className: 'vardiya-haftalik-sube vardiya-sube-td vardiya-sube-td--bilinmeyen',
    };
  }
  const p = SUBE_PALETTES[idx];
  return {
    className: 'vardiya-haftalik-sube vardiya-sube-td vardiya-sube-td--renkli',
    style: {
      backgroundColor: p.bg,
      borderLeft: `3px solid ${p.accent}`,
    },
  };
}

/**
 * Hücre metni: İZİNLİ, saat aralığı, yalnız şube adı (başka lokasyonda çalışma).
 */
export function classifyHucre(raw, rehber) {
  const t = (raw || '').trim();
  if (!t) return { kind: 'empty' };
  const upper = t.toLocaleUpperCase('tr-TR');
  if (upper.includes('İZİN')) return { kind: 'izin' };

  const compact = t.replace(/\s/g, '');
  if (
    /\d{1,2}\s*[.:]\s*\d{2}\s*[-–]\s*\d{1,2}\s*[.:]\s*\d{2}/.test(t) ||
    /^\d{1,2}[.:]\d{2}([.:]\d{2})+$/.test(compact)
  ) {
    return { kind: 'saat' };
  }

  const ads = [...(rehber || [])]
    .map((r) => (r.ad || '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const ad of ads) {
    if (normTr(t) === normTr(ad)) return { kind: 'sube', ad };
  }
  for (const ad of ads) {
    const nu = normTr(ad);
    if (nu.length >= 3 && upper.includes(nu)) return { kind: 'sube', ad };
  }

  return { kind: 'other' };
}

export function hucreTdProps(raw, rehber) {
  const c = classifyHucre(raw, rehber);
  if (c.kind === 'empty') {
    return { className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--bos' };
  }
  if (c.kind === 'izin') {
    return { className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--izin' };
  }
  if (c.kind === 'saat') {
    return { className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--saat' };
  }
  if (c.kind === 'sube' && c.ad) {
    const idx = subeRenkIndeksi(c.ad, rehber);
    if (idx != null) {
      const p = SUBE_PALETTES[idx];
      return {
        className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--sube',
        style: {
          backgroundColor: p.bg,
          borderLeft: `3px solid ${p.accent}`,
        },
      };
    }
  }
  return { className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--diger' };
}

/** Yansıma hücresi: köken şube rengi (← kart şubesi). */
export function mirrorHucreTdProps(homeSubeAd, rehber) {
  const idx = subeRenkIndeksi(homeSubeAd, rehber);
  if (idx == null) {
    return {
      className:
        'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--yansima vardiya-hucre--diger',
    };
  }
  const p = SUBE_PALETTES[idx];
  return {
    className: 'vardiya-haftalik-cell vardiya-hucre vardiya-hucre--yansima',
    style: {
      backgroundColor: p.bg,
      borderLeft: `3px solid ${p.accent}`,
    },
  };
}
