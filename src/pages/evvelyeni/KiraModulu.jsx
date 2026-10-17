// ─────────────────────────────────────────────────────────────────────────────
// 🏠 EVVEL YENİ · KİRA TAKVİMİ — şube × 12 ay
//
// Sahip (2026-10-16): "Ay ay ödenen kiraların listesi yıllıkta ay ay tutulsun — takvim mantığı!" ·
// "Kira artış periyotları takvimde ayı farklı renk olsun."
// Rakamlar /api/evvel-yeni/kira/takvim'den; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, fmt, tKisa } from './KasaModulu';

const AY = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const AY_UZUN = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const MOR = '#7B4FB8';
const DURUM = {
  odendi: { renk: R.yesil, ad: 'ödendi', ikon: '✓' },
  kismi: { renk: R.amber, ad: 'kısmi', ikon: '◐' },
  gecikti: { renk: R.kirmizi, ad: 'gecikti', ikon: '!' },
  yaklasiyor: { renk: '#D9822B', ad: 'yaklaşıyor', ikon: '⏰' },
  gelecek: { renk: 'var(--pi-ink3, #7F6C57)', ad: 'gelecek', ikon: '' },
  tanimsiz: { renk: 'var(--pi-ink3, #7F6C57)', ad: 'kira tanımsız', ikon: '—' },
  mulk: { renk: 'var(--pi-ink3, #7F6C57)', ad: 'mülk bizim', ikon: '🏠' },
};

export function KiraTakvim() {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sec, setSec] = useState(null);   // {sube, ay}
  const no = useRef(0);
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/kira/takvim?yil=${yil}`).then((r) => { if (n === no.current) { setV(r); setHata(null); } })
      .catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  }, [yil]);

  const hucre = { padding: '6px 4px', textAlign: 'center', borderTop: '1px solid var(--pi-line)', fontSize: 12 };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>Kira takvimi</h1></div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Dugme kucuk onClick={() => setYil(yil - 1)}>‹ {yil - 1}</Dugme><b style={{ fontSize: 18 }}>{yil}</b><Dugme kucuk onClick={() => setYil(yil + 1)}>{yil + 1} ›</Dugme>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>
        {['odendi', 'kismi', 'gecikti', 'yaklasiyor', 'gelecek'].map((k) => <span key={k}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: DURUM[k].renk, marginRight: 5 }} />{DURUM[k].ad}</span>)}
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, border: `2px solid ${MOR}`, background: `${MOR}33`, marginRight: 5 }} />📈 kira artış ayı</span>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Takvim hazırlanıyor…</div>}
      {v && (
        <div style={{ ...kart, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
            <thead><tr style={{ fontSize: 12, color: R.metin2 }}>
              <th style={{ ...hucre, textAlign: 'left', borderTop: 'none', padding: '8px 10px' }}>Şube</th>
              {AY.map((a) => <th key={a} style={{ ...hucre, borderTop: 'none' }}>{a}</th>)}
              <th style={{ ...hucre, borderTop: 'none', textAlign: 'right', padding: '8px 10px' }}>Yıl</th>
            </tr></thead>
            <tbody>{v.subeler.map((s) => (
              <tr key={s.sube_id}>
                <td style={{ ...hucre, textAlign: 'left', padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <b style={{ fontSize: 14 }}>{s.ad}</b>
                  <div style={{ color: R.not, fontSize: 11.5 }}>{s.kira_yok ? 'mülk bizim — kira yok' : s.kira != null ? `${fmt(s.kira)} ₺/ay` : 'kira tanımsız'}{s.odeme_gunu ? ` · ${s.odeme_gunu}'i` : ''}{s.artis_ayi ? ` · artış ${AY_UZUN[s.artis_ayi - 1]}` : ''}</div>
                </td>
                {s.aylar.map((a, i) => {
                  const d = DURUM[a.durum];
                  const artis = a.artis_ayi || a.artis;
                  return (
                    <td key={a.ay} style={{ ...hucre, padding: 3 }}>
                      <button type="button" onClick={() => setSec({ s, a, i })} title={`${AY_UZUN[i]} · ${d.ad}`} style={{
                        width: '100%', minHeight: 52, borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 11.5, lineHeight: 1.25, padding: '4px 2px',
                        border: artis ? `2px solid ${MOR}` : `1px solid ${a.durum === 'gelecek' || a.durum === 'tanimsiz' ? 'var(--pi-line)' : d.renk}`,
                        background: artis ? `${MOR}22` : a.durum === 'gelecek' || a.durum === 'tanimsiz' ? 'transparent' : `color-mix(in srgb, ${d.renk} 16%, transparent)`,
                        color: 'var(--pi-ink)',
                      }}>
                        {artis && <div style={{ color: MOR, fontWeight: 800 }}>📈{a.artis ? ' artış' : ''}</div>}
                        <div style={{ ...num, fontWeight: 700, color: d.renk }}>{d.ikon} {a.odenen > 0 ? fmt(a.odenen) : a.beklenen != null ? fmt(a.beklenen) : '—'}</div>
                        {a.durum === 'kismi' && <div style={{ color: R.not }}>kalan {fmt(a.kalan)}</div>}
                      </button>
                    </td>
                  );
                })}
                <td style={{ ...hucre, textAlign: 'right', padding: '8px 10px', whiteSpace: 'nowrap', ...num }}>
                  <b>{fmt(s.yil_odenen)}</b><div style={{ color: R.not, fontSize: 11 }}>/ {fmt(s.yil_beklenen)}</div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {sec && (
        <div onClick={() => setSec(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div style={{ ...kart, padding: 18, width: 'min(440px, 100%)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: 17 }}>🏠 {sec.s.ad} · {AY_UZUN[sec.i]} {v.yil}</b>
            {(sec.a.artis_ayi || sec.a.artis) && <div style={{ color: MOR, fontWeight: 700 }}>📈 {sec.a.artis ? `Kira bu ay arttı: ${fmt(sec.a.onceki_tutar)} → ${fmt(sec.a.beklenen)} ₺` : 'Kira artış ayı — yeni tutarı Tanımlar → Şubeler\'den gir'}</div>}
            <div>Beklenen <b style={num}>{sec.a.beklenen != null ? fmt(sec.a.beklenen) : '—'}</b> ₺ · ödenen <b style={num}>{fmt(sec.a.odenen)}</b> ₺ · kalan <b style={num}>{fmt(sec.a.kalan)}</b> ₺</div>
            <div style={{ color: R.not, fontSize: 13 }}>Son ödeme günü {tKisa(sec.a.vade)} · durum: {DURUM[sec.a.durum].ad}</div>
            {sec.a.yeni_kayitlar.map((k) => <div key={k.id} style={{ fontSize: 13 }}>• {tKisa(k.tarih)} · {fmt(k.tutar)} ₺ · {k.aciklama}</div>)}
            {sec.a.eski_sistem > 0 && <div style={{ fontSize: 13 }}>• eski sistemde ödenmiş: {fmt(sec.a.eski_sistem)} ₺</div>}
            {sec.a.kalan > 0 && <div style={{ fontSize: 12.5, color: R.not }}>Ödemek için: Ödeme → Ödeme / gider gir → Kira → şube ve "ait olduğu ay" seç; tutar kendiliğinden gelir.</div>}
            <div style={{ textAlign: 'right' }}><Dugme kucuk onClick={() => setSec(null)}>Kapat</Dugme></div>
          </div>
        </div>
      )}
    </div>
  );
}
