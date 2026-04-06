/**
 * Ana şube satırında başka şube adı yazıldığında, o hedef şubenin bloğunda
 * otomatik yansıma satırı (PDF’deki çift görünürlük).
 */

import { classifyHucre } from './vardiyaHaftalikRenk';

function normTr(s) {
  return (s || '').toLocaleUpperCase('tr-TR').replace(/\s+/g, ' ').trim();
}

export function canonicalSubeAd(ad, rehber) {
  const n = normTr(ad);
  const r = (rehber || []).find((x) => normTr(x.ad) === n);
  return r ? String(r.ad).trim() : String(ad || '').trim();
}

/**
 * @returns {{ home: object, hedefAd: string, hucreler: Record<string,string> }[]}
 */
export function buildYansimaListesi(satirlar, gunler, subeRehber) {
  const map = new Map();
  for (const s of satirlar) {
    const homeAd = (s.sube_adi || '').trim();
    for (const g of gunler) {
      const t = g.tarih;
      const raw = (s.hucreler[t] ?? '').trim();
      if (!raw) continue;
      const c = classifyHucre(raw, subeRehber);
      if (c.kind !== 'sube' || !c.ad) continue;
      const hedefCanon = canonicalSubeAd(c.ad, subeRehber);
      if (!hedefCanon || normTr(hedefCanon) === normTr(homeAd)) continue;
      const key = `${s.personel_id}\t${normTr(hedefCanon)}`;
      if (!map.has(key)) {
        map.set(key, { home: s, hedefAd: hedefCanon, hucreler: {} });
      }
      map.get(key).hucreler[t] = `← ${homeAd}`;
    }
  }
  return Array.from(map.values());
}

function mergeSubeOrder(rehber, satirlar, yansimalar) {
  const out = [];
  const seen = new Set();
  const push = (ad) => {
    const can = canonicalSubeAd(ad, rehber);
    const n = normTr(can);
    if (!n || n === '—') return;
    if (seen.has(n)) return;
    seen.add(n);
    out.push(can);
  };
  for (const r of rehber || []) push(r.ad);
  for (const s of satirlar) push(s.sube_adi);
  for (const m of yansimalar) push(m.hedefAd);
  return out;
}

/**
 * Tabloda gösterilecek sıra: şube blokları, her blokta önce kart şubesi eşleşen satırlar, sonra yansımalar.
 * @returns {({ kind: 'native', row: object } | { kind: 'mirror', mirror: object })[]}
 */
export function buildHaftalikGorunumSirasi(satirlar, gunler, subeRehber) {
  const yansimalar = buildYansimaListesi(satirlar, gunler, subeRehber);
  const sira = mergeSubeOrder(subeRehber, satirlar, yansimalar);
  const out = [];
  for (const subeBlok of sira) {
    const natives = satirlar
      .filter((s) => normTr(s.sube_adi) === normTr(subeBlok))
      .sort((a, b) => (a.ad_soyad || '').localeCompare(b.ad_soyad || '', 'tr'));
    for (const row of natives) {
      out.push({ kind: 'native', row });
    }
    const mirrors = yansimalar
      .filter((m) => normTr(m.hedefAd) === normTr(subeBlok))
      .sort((a, b) =>
        (a.home.ad_soyad || '').localeCompare(b.home.ad_soyad || '', 'tr'),
      );
    for (const m of mirrors) {
      out.push({ kind: 'mirror', mirror: m });
    }
  }
  return out;
}
