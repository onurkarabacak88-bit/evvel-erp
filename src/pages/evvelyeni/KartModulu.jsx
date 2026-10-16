// ─────────────────────────────────────────────────────────────────────────────
// 💳 EVVEL YENİ · KARTLAR — sade: tek rakam KULLANILABİLİR LİMİT
//
// Sahip (2026-10-16): "Evvel'de sürekli hesaplama yapmak için çok çabalıyordu; ödeme alanından
// kartların limitlerinde hareketi arttırması yeterli — daha basit bir mantıkta kuralım."
// Son teyit (bankada yazan rakam) + Ödeme formunda kartla ödenenler (−) + kart borcu ödemeleri (+).
// Taksit / faiz / asgari yok. Bütün rakamlar /api/evvel-yeni/kart'tan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt, tUzun, tKisa } from './KasaModulu';

export const KART_SAYFALAR = [
  { id: 'kartlar', ad: 'Kartlar', alt: 'Kullanılabilir limit · son ödeme' },
];

const alan = {
  width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)',
  color: 'var(--pi-ink)', font: 'inherit', fontSize: 15, minWidth: 0,
};
const sayi = (x) => { const t = String(x ?? '').trim().replace(/\s/g, ''); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? n : NaN; };
const gunBugun = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export default function KartModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [teyit, setTeyit] = useState(null);   // {kart, kullanilabilir, ekstre_borc, son_odeme, tarih}
  const [acik, setAcik] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api('/evvel-yeni/kart/ozet'); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const kaydet = async () => {
    const k = sayi(teyit.kullanilabilir); const e = sayi(teyit.ekstre_borc);
    if (k == null || Number.isNaN(k)) { onToast?.('Bankada yazan kullanılabilir limiti yaz'); return; }
    if (Number.isNaN(e)) { onToast?.('Ekstre borcu: sayı yaz'); return; }
    setMesgul(true);
    try {
      const r = await api(`/evvel-yeni/kart/${teyit.kart.id}/teyit`, { method: 'POST', body: { kullanilabilir: k, ekstre_borc: e, son_odeme: teyit.son_odeme || null, tarih: teyit.tarih || null } });
      onToast?.(r.mesaj); setTeyit(null); yukle();
    } catch (x) { onToast?.(x?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Kartlar okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Kartlar hazırlanıyor…</div></div>;

  // ortak limitli kartlar tek kutuda
  const gruplar = [];
  for (const k of v.kartlar) {
    const g = k.grup ? gruplar.find((x) => x.grup && x.grup.ad === k.grup.ad) : null;
    if (g) g.kartlar.push(k); else gruplar.push({ grup: k.grup || null, kartlar: [k] });
  }

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Kartlar</div><h1 style={{ fontSize: 30 }}>Kartlar</h1></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <Kutu ad="Toplam limit" deger={fmt(v.toplam.limit)} />
        <Kutu ad="Kullanılabilir" deger={fmt(v.toplam.kullanilabilir)} renk={R.yesil} />
        <Kutu ad="7 gün içinde ödenecek" deger={fmt(v.toplam.son_odeme_kalan)} renk={v.toplam.son_odeme_kalan > 0 ? R.kirmizi : undefined} />
      </div>
      {v.yaklasan.length > 0 && (
        <div style={{ ...kart, padding: 12, borderLeft: `5px solid ${R.kirmizi}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <b>⏰ Son ödemesi yaklaşan</b>
          {v.yaklasan.map((y) => (
            <div key={y.id} style={{ fontSize: 13.5 }}><b>{y.ad}</b> · {tUzun(y.tarih)} ({y.gun_kaldi === 0 ? 'BUGÜN' : `${y.gun_kaldi} gün`})
              {y.kalan != null ? <> · kalan <b style={num}>{fmt(y.kalan)}</b> ₺ <span style={{ color: R.not }}>(ekstre {fmt(y.ekstre)}, ödenen {fmt(y.odenen)})</span></> : <span style={{ color: R.not }}> · ekstre tutarı girilmedi</span>}</div>
          ))}
          <div style={{ fontSize: 12, color: R.not }}>Ödeyince Ödeme bölümünden "Kart borcu" olarak gir — buradan kendiliğinden düşer.</div>
        </div>
      )}
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>

      {gruplar.map((g) => {
        const k0 = g.kartlar[0];
        const lim = k0.limit; const kul = k0.kullanilabilir;
        const oran = lim && kul != null ? Math.max(0, Math.min(1, (lim - kul) / lim)) : null;
        return (
          <div key={g.grup ? `g:${g.grup.ad}` : k0.id} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {g.grup && <Cip>ortak limit · {g.grup.ad} — {g.kartlar.length} kart aynı limiti kullanır</Cip>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 17 }}>{g.kartlar.map((k) => k.ad.trim()).join(' + ')}</div>
                <div style={{ fontSize: 12.5, color: R.not }}>{[k0.banka, k0.kimin].filter(Boolean).join(' · ')}{k0.kesim_gunu ? ` · kesim her ayın ${k0.kesim_gunu}'i` : ''}{k0.son_odeme_gunu ? ` · son ödeme ${k0.son_odeme_gunu}'i` : ''}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: R.not }}>Kullanılabilir</div>
                <div style={{ ...num, fontSize: 26, fontWeight: 800, color: kul != null && kul < 0 ? R.kirmizi : R.yesil }}>{kul != null ? fmt(kul) : '—'} ₺</div>
                <div style={{ fontSize: 12, color: R.not }}>limit {lim != null ? fmt(lim) : '—'}{k0.kullanilan != null ? ` · kullanılan ${fmt(k0.kullanilan)}` : ''}</div>
              </div>
            </div>
            {oran != null && <div style={{ height: 8, borderRadius: 99, background: 'var(--pi-line)', overflow: 'hidden' }}><div style={{ width: `${oran * 100}%`, height: '100%', background: oran > 0.9 ? R.kirmizi : oran > 0.7 ? R.amber : 'var(--pi-accent)' }} /></div>}
            {g.kartlar.map((k) => (
              <div key={k.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: g.kartlar.length > 1 ? '1px solid var(--pi-line)' : 'none', paddingTop: g.kartlar.length > 1 ? 8 : 0 }}>
                {g.kartlar.length > 1 && <b style={{ fontSize: 14 }}>{k.ad}</b>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  {k.cipa ? <span>Son teyit <b>{tKisa(k.cipa.tarih)}</b> ({k.teyit_gun_once} gün önce): {fmt(k.cipa.kullanilabilir)} ₺
                    {k.cipa.kaynak === 'eski_sistem' && <span style={{ color: R.amber }}> · {k.cipa.not}</span>}
                    {k.cipa.fark != null && (Math.abs(k.cipa.fark) < 1 ? <span style={{ color: R.yesil }}> · sistemle tuttu ✓</span>
                      : <span style={{ color: R.kirmizi }}> · bankayla fark {k.cipa.fark > 0 ? '+' : ''}{fmt(k.cipa.fark)}</span>)}</span>
                    : <span style={{ color: R.kirmizi }}>Hiç teyit yok — bankada yazan kullanılabilir limiti gir</span>}
                  {k.teyit_gun_once != null && k.teyit_gun_once > 35 && <Cip tur="sari">teyit eski</Cip>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {k.hareketler.length > 0 && <Dugme kucuk onClick={() => setAcik(acik === k.id ? null : k.id)}>{acik === k.id ? 'Gizle' : `${k.hareketler.length} hareket`}</Dugme>}
                    <Dugme ana kucuk onClick={() => setTeyit({ kart: k, kullanilabilir: '', ekstre_borc: '', son_odeme: '', tarih: gunBugun() })}>Bankadaki rakamı gir</Dugme>
                  </span>
                </div>
                {k.son_odeme && <div style={{ fontSize: 13 }}>Son ödeme <b>{tUzun(k.son_odeme.tarih)}</b> ({k.son_odeme.gun_kaldi === 0 ? 'BUGÜN' : `${k.son_odeme.gun_kaldi} gün`})
                  {k.son_odeme.eski ? <span style={{ color: R.not }}> · eski sistemden ekstre {fmt(k.son_odeme.ekstre)} — yeni ekstreyi girince takip başlar</span>
                    : k.son_odeme.kalan != null ? <> · ekstre {fmt(k.son_odeme.ekstre)} − ödenen {fmt(k.son_odeme.odenen)} = kalan <b style={{ ...num, color: k.son_odeme.kalan > 0 ? R.kirmizi : R.yesil }}>{fmt(k.son_odeme.kalan)}</b> ₺</> : <span style={{ color: R.not }}> · ekstre tutarı girilmedi</span>}</div>}
                {acik === k.id && (
                  <table style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}><tbody>
                    {k.hareketler.map((h, i) => (
                      <tr key={`${h.id}${i}`} style={{ borderTop: '1px solid var(--pi-line)' }}>
                        <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}>{tKisa(h.gun)}</td>
                        <td style={{ padding: '5px 6px' }}>{h.tur === 'harcama' ? '💳 harcama' : '✅ borç ödemesi'} · {h.aciklama}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', ...num, color: h.tutar < 0 ? R.kirmizi : R.yesil }}>{h.tutar > 0 ? '+' : ''}{fmt(h.tutar)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {teyit && (
        <div onClick={() => !mesgul && setTeyit(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div style={{ ...kart, padding: 18, width: 'min(440px, 100%)', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: 17 }}>🏦 {teyit.kart.ad} — bankadaki rakam</b>
            <div style={{ fontSize: 12.5, color: R.not }}>Bankanın uygulamasında yazanı gir. Sistem beklediğiyle karşılaştırır; fark varsa forma girilmemiş harcama/ödeme vardır. Bundan sonra bu rakamdan devam eder.</div>
            <Etiket ad="Kullanılabilir limit ₺ *"><input style={alan} inputMode="decimal" value={teyit.kullanilabilir} onChange={(e) => setTeyit({ ...teyit, kullanilabilir: e.target.value })} autoFocus /></Etiket>
            <Etiket ad="Ekstre borcu ₺ (ekstre geldiyse)"><input style={alan} inputMode="decimal" value={teyit.ekstre_borc} onChange={(e) => setTeyit({ ...teyit, ekstre_borc: e.target.value })} /></Etiket>
            <Etiket ad="Ekstrenin son ödeme tarihi"><input style={alan} type="date" value={teyit.son_odeme} onChange={(e) => setTeyit({ ...teyit, son_odeme: e.target.value })} /></Etiket>
            <Etiket ad="Bu rakam hangi günün"><input style={alan} type="date" value={teyit.tarih} max={gunBugun()} onChange={(e) => setTeyit({ ...teyit, tarih: e.target.value })} /></Etiket>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Dugme kucuk onClick={() => setTeyit(null)} disabled={mesgul}>Vazgeç</Dugme>
              <Dugme ana onClick={kaydet} disabled={mesgul}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</Dugme>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kutu({ ad, deger, renk }) {
  return (
    <div style={{ ...kart, padding: 12 }}>
      <div style={{ fontSize: 12, color: R.not }}>{ad}</div>
      <div style={{ ...num, fontSize: 22, fontWeight: 800, color: renk }}>{deger} ₺</div>
    </div>
  );
}

function Etiket({ ad, children }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13, fontWeight: 600, color: R.metin2 }}>{ad}{children}</label>;
}
