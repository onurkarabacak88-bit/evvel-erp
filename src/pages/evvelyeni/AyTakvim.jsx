// 📅 ORTAK AY TAKVİMİ IZGARASI — satır × 12 ay (kredi · kart ödeme · KİRA takvimi). Dalga 5 (T4-08): Kira ayrı kopya tutuyordu;
// hücre vurgusu (kira artış ayı) ve ek durumlar (mülk bizim / tanımsız) buraya eklendi.
// Yalnız dizer; rakamlar ve durum sunucudan. Hiçbir modülü tanımaz (ortak UI kiti).
import React from 'react';
import { R, kart, num, Dugme, fmt } from './KasaModulu';

export { AY_KISA as AY, AY_UZUN } from '../../utils/trTarih';   // ay adları TEK kaynak (T4-03)
import { AY_KISA as AY, AY_UZUN } from '../../utils/trTarih';
const GRI = 'var(--pi-ink3, #7F6C57)';
export const DURUM = {
  odendi: { renk: R.yesil, ad: 'ödendi', ikon: '✓' },
  kismi: { renk: R.amber, ad: 'kısmi', ikon: '◐' },
  odeme_var: { renk: R.amber, ad: 'ödeme var · ekstre bilinmiyor', ikon: '?' },
  gecikti: { renk: R.kirmizi, ad: 'gecikti', ikon: '!' },
  yaklasiyor: { renk: '#D9822B', ad: 'yaklaşıyor', ikon: '⏰' },
  gelecek: { renk: GRI, ad: 'gelecek', ikon: '' },
  once: { renk: GRI, ad: 'Evvel Yeni öncesi', ikon: '·' },
  yok: { renk: GRI, ad: '—', ikon: '' },
  tanimsiz: { renk: GRI, ad: 'kira tanımsız', ikon: '—' },
  mulk: { renk: GRI, ad: 'mülk bizim', ikon: '🏠' },
};
const SADE = new Set(['gelecek', 'once', 'yok', 'tanimsiz', 'mulk']);

export function YilSecici({ yil, setYil }) {
  return (
    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
      <Dugme kucuk onClick={() => setYil(yil - 1)}>‹ {yil - 1}</Dugme><b style={{ fontSize: 18 }}>{yil}</b><Dugme kucuk onClick={() => setYil(yil + 1)}>{yil + 1} ›</Dugme>
    </span>
  );
}

// ek: [{ ad, renk }] — ekrana özgü işaret (ör. kira artış ayı, çerçeveli)
export function Lejant({ ek = [] }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>
      {['odendi', 'kismi', 'gecikti', 'yaklasiyor', 'gelecek'].map((k) => (
        <span key={k}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: DURUM[k].renk, marginRight: 5 }} />{DURUM[k].ad}</span>
      ))}
      {ek.map((x) => <span key={x.ad}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, border: `2px solid ${x.renk}`, background: `${x.renk}33`, marginRight: 5 }} />{x.ad}</span>)}
    </div>
  );
}

// satirlar: [{ id, baslik, alt, aylar: [{ay, durum, ust (büyük rakam), alt (küçük satır), vurgu (çerçeve rengi), etiket (üst satır)}], sag, sagAlt }]
export function AyIzgara({ satirlar, onHucre, ilkBaslik = '' }) {
  const hucre = { padding: '6px 4px', textAlign: 'center', borderTop: '1px solid var(--pi-line)', fontSize: 12 };
  return (
    <div style={{ ...kart, overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
        <thead><tr style={{ fontSize: 12, color: R.metin2 }}>
          <th style={{ ...hucre, textAlign: 'left', borderTop: 'none', padding: '8px 10px' }}>{ilkBaslik}</th>
          {AY.map((a) => <th key={a} style={{ ...hucre, borderTop: 'none' }}>{a}</th>)}
          <th style={{ ...hucre, borderTop: 'none', textAlign: 'right', padding: '8px 10px' }}>Yıl</th>
        </tr></thead>
        <tbody>{satirlar.map((s) => (
          <tr key={s.id}>
            <td style={{ ...hucre, textAlign: 'left', padding: '8px 10px', whiteSpace: 'nowrap' }}>
              <b style={{ fontSize: 14 }}>{s.baslik}</b><div style={{ color: R.not, fontSize: 11.5 }}>{s.alt}</div>
            </td>
            {s.aylar.map((a, i) => {
              const d = DURUM[a.durum] || DURUM.gelecek;
              const sade = SADE.has(a.durum);
              return (
                <td key={a.ay} style={{ ...hucre, padding: 3 }}>
                  {a.durum === 'yok' ? <span style={{ color: R.not }}>—</span> : (
                    <button type="button" onClick={() => onHucre?.(s, a, i)} title={`${AY_UZUN[i]} · ${d.ad}`} style={{
                      width: '100%', minHeight: 48, borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 11.5, lineHeight: 1.25, padding: '4px 2px',
                      border: a.vurgu ? `2px solid ${a.vurgu}` : `1px solid ${sade ? 'var(--pi-line)' : d.renk}`,
                      background: a.vurgu ? `${a.vurgu}22` : sade ? 'transparent' : `color-mix(in srgb, ${d.renk} 16%, transparent)`, color: 'var(--pi-ink)',
                    }}>
                      {a.etiket && <div style={{ color: a.vurgu || R.not, fontWeight: 800 }}>{a.etiket}</div>}
                      <div style={{ ...num, fontWeight: 700, color: d.renk }}>{d.ikon} {a.ust}</div>
                      {a.alt && <div style={{ color: R.not }}>{a.alt}</div>}
                    </button>
                  )}
                </td>
              );
            })}
            <td style={{ ...hucre, textAlign: 'right', padding: '8px 10px', whiteSpace: 'nowrap', ...num }}><b>{s.sag}</b><div style={{ color: R.not, fontSize: 11 }}>{s.sagAlt}</div></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function Pencere({ baslik, children, onKapat }) {
  return (
    <div onClick={onKapat} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
      <div style={{ ...kart, padding: 18, width: 'min(460px, 100%)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
        <b style={{ fontSize: 17 }}>{baslik}</b>
        {children}
        <div style={{ textAlign: 'right' }}><Dugme kucuk onClick={onKapat}>Kapat</Dugme></div>
      </div>
    </div>
  );
}

export const tutarYaz = (n) => (n == null ? '—' : fmt(n));
