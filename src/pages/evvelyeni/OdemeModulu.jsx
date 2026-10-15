// ─────────────────────────────────────────────────────────────────────────────
// 🧾 EVVEL YENİ · ÖDEME / GİDER GİRİŞİ — tek form, hepsi listeden seçilir
//
// Sahip (2026-10-15): "Seçmeli ödeme gir: nakit mi, havale mi, kart mı?" · "Kirada
// şubelerin isimlerini seçmeliyiz; toptancıda kayıtlı toptancı; personelde isimler,
// yemek ücreti mesela." Etkiler sunucuda türetilir (kasa, kart, gider, kimin).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, fmt, tl, tKisa } from './KasaModulu';

export const ODEME_SAYFALAR = [
  { id: 'odemeler', ad: 'Ödeme / gider gir', alt: 'Nakit · havale · kart' },
];

const alan = {
  width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)',
  color: 'var(--pi-ink)', font: 'inherit', fontSize: 15, minWidth: 0,
};
const ayBugun = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const gunBugun = () => { const d = new Date(); return `${ayBugun()}-${String(d.getDate()).padStart(2, '0')}`; };

function Etiket({ ad, children, ipucu }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13, fontWeight: 600, color: R.metin2, minWidth: 0 }}>
      {ad}{children}{ipucu && <span style={{ fontWeight: 400, color: R.not, fontSize: 12 }}>{ipucu}</span>}
    </label>
  );
}

const BOS = { konu: '', tarih: gunBugun(), ait_ay: ayBugun(), parcalar: [{ yontem: 'nakit', cep: '', kart_id: '', tutar: '' }] };

export default function OdemeModulu({ onToast }) {
  const [L, setL] = useState(null);
  const [f, setF] = useState(BOS);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [ay, setAy] = useState(ayBugun());
  const [liste, setListe] = useState(null);

  const listeYukle = useCallback(() => api(`/evvel-yeni/odeme/liste?ay=${ay}`).then(setListe).catch(() => setListe({ odemeler: [], hata: true })), [ay]);
  useEffect(() => { api('/evvel-yeni/odeme/listeler').then(setL).catch((e) => setHata(e?.message || 'Listeler okunamadı')); }, []);
  useEffect(() => { listeYukle(); }, [listeYukle]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const parcaSet = (i, k, v) => setF((x) => ({ ...x, parcalar: x.parcalar.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));

  const gonder = async () => {
    setHata(''); setMesgul(true);
    try {
      const body = { ...f, parcalar: f.parcalar.filter((p) => Number(p.tutar) > 0).map((p) => ({ yontem: p.yontem, cep: p.cep || null, kart_id: p.kart_id || null, tutar: Number(p.tutar) })) };
      const r = await api('/evvel-yeni/odeme', { method: 'POST', body });
      onToast?.(r.mesaj);
      setF({ ...BOS, tarih: f.tarih });
      api('/evvel-yeni/odeme/listeler').then(setL).catch(() => {});
      listeYukle();
    } catch (e) { setHata(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };

  if (!L) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: hata ? R.kirmizi : R.not }}>{hata || 'Form hazırlanıyor…'}</div></div>;

  const toplam = f.parcalar.reduce((a, p) => a + (Number(p.tutar) || 0), 0);   // yalnız giriş geri bildirimi
  const konuObj = L.konular.find((k) => k.kod === f.konu);
  const izgara = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>Ödeme / gider gir</h1></div>

      <div style={{ ...kart, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 1 · NE İÇİN */}
        <div>
          <div style={{ ...etiketStil, marginBottom: 8 }}>1 · Ne için ödendi?</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {L.konular.map((k) => (
              <button key={k.kod} type="button" onClick={() => setF((x) => ({ ...BOS, tarih: x.tarih, konu: k.kod }))} style={{
                padding: '10px 16px', borderRadius: 12, font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${f.konu === k.kod ? 'var(--pi-accent)' : 'var(--pi-line)'}`,
                background: f.konu === k.kod ? 'var(--pi-accent)' : 'var(--pi-paper)', color: f.konu === k.kod ? 'var(--pi-on-accent)' : R.krem,
              }}>{k.ad}</button>
            ))}
          </div>
        </div>

        {f.konu && (<>
          {/* 2 · AYRINTI — hepsi listeden */}
          <div style={izgara}>
            {f.konu === 'toptanci' && (
              <Etiket ad="Toptancı"><select style={alan} value={f.toptanci_id || ''} onChange={(e) => set('toptanci_id', e.target.value)}>
                <option value="">Seç…</option>{L.toptancilar.map((t) => <option key={t.id} value={t.id}>{t.ad}{t.kategori ? ` · ${t.kategori}` : ''}</option>)}
              </select></Etiket>
            )}
            {['kira', 'fatura', 'anlik'].includes(f.konu) && (
              <Etiket ad="Hangi şube"><select style={alan} value={f.sube_id || ''} onChange={(e) => set('sube_id', e.target.value)}>
                <option value="">Seç…</option>{L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'fatura' && (
              <Etiket ad="Fatura türü"><select style={alan} value={f.fatura_turu || ''} onChange={(e) => set('fatura_turu', e.target.value)}>
                <option value="">Seç…</option>{L.fatura_turleri.map((t) => <option key={t}>{t}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'personel' && (<>
              <Etiket ad="Personel"><select style={alan} value={f.personel_id || ''} onChange={(e) => set('personel_id', e.target.value)}>
                <option value="">Seç…</option>{L.personel.map((p) => <option key={p.id} value={p.id}>{p.ad}{p.sube_ad ? ` · ${p.sube_ad}` : ''}</option>)}
              </select></Etiket>
              <Etiket ad="Ne ödendi"><select style={alan} value={f.personel_kalemi || ''} onChange={(e) => set('personel_kalemi', e.target.value)}>
                <option value="">Seç…</option>{L.personel_kalemleri.map((k) => <option key={k}>{k}</option>)}
              </select></Etiket>
            </>)}
            {f.konu === 'kart_borcu' && (
              <Etiket ad="Hangi kartın borcu"><select style={alan} value={f.kimin || ''} onChange={(e) => set('kimin', e.target.value)}>
                <option value="">Seç…</option>{L.kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad}{k.banka ? ` · ${k.banka}` : ''}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'diger' && (
              <Etiket ad="Kimin gideri"><select style={alan} value={f.kimin || ''} onChange={(e) => set('kimin', e.target.value)}>
                <option value="">Seç…</option>{L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                <option value="ortak">Ortak (şubelere dağıtılmaz)</option><option value="patron">Patron şahsi (gider değil)</option>
              </select></Etiket>
            )}
            {['kira', 'fatura', 'personel'].includes(f.konu) && (
              <Etiket ad="Ait olduğu ay" ipucu="Gider bu aya yazılır (ödendiği güne değil)"><input type="month" style={alan} value={f.ait_ay} onChange={(e) => set('ait_ay', e.target.value)} /></Etiket>
            )}
            <Etiket ad="Ödeme günü"><input type="date" style={alan} value={f.tarih} max={gunBugun()} onChange={(e) => set('tarih', e.target.value)} /></Etiket>
            <Etiket ad={['anlik', 'diger'].includes(f.konu) ? 'Ne alındı / açıklama' : 'Not (isteğe bağlı)'}>
              <input style={alan} value={f.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder={f.konu === 'anlik' ? 'ör. bulaşık deterjanı' : ''} />
            </Etiket>
          </div>

          {/* 3 · NASIL ÖDENDİ */}
          <div>
            <div style={{ ...etiketStil, marginBottom: 8 }}>2 · Nasıl ödendi?</div>
            {f.parcalar.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(180px,1fr) 150px auto', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[['nakit', 'Nakit'], ['havale', 'Havale'], ['kart', 'Kart']].map(([k, a]) => (
                    <button key={k} type="button" onClick={() => setF((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, yontem: k, cep: '', kart_id: '' } : q)) }))} style={{
                      padding: '9px 12px', borderRadius: 10, font: 'inherit', fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${p.yontem === k ? 'var(--pi-accent)' : 'var(--pi-line)'}`,
                      background: p.yontem === k ? 'var(--pi-accent)' : 'var(--pi-paper)', color: p.yontem === k ? 'var(--pi-on-accent)' : R.krem,
                    }}>{a}</button>
                  ))}
                </div>
                {p.yontem === 'kart' ? (
                  <select style={alan} value={p.kart_id} onChange={(e) => parcaSet(i, 'kart_id', e.target.value)}>
                    <option value="">Hangi kart…</option>{L.kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad}{k.banka ? ` · ${k.banka}` : ''}</option>)}
                  </select>
                ) : (
                  <select style={alan} value={p.cep} onChange={(e) => parcaSet(i, 'cep', e.target.value)}>
                    <option value="">{p.yontem === 'nakit' ? 'Hangi nakit…' : 'Hangi banka…'}</option>
                    {(p.yontem === 'nakit' ? L.nakit_cepler : L.banka_cepler).map((c) => <option key={c.id} value={c.id} disabled={c.bakiye <= 0}>{c.ad} · {fmt(c.bakiye)} ₺</option>)}
                  </select>
                )}
                <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Tutar" style={alan} value={p.tutar} onChange={(e) => parcaSet(i, 'tutar', e.target.value)} />
                {f.parcalar.length > 1 ? <Dugme kucuk onClick={() => setF((x) => ({ ...x, parcalar: x.parcalar.filter((_, j) => j !== i) }))}>Sil</Dugme> : <span />}
              </div>
            ))}
            <Dugme kucuk onClick={() => setF((x) => ({ ...x, parcalar: [...x.parcalar, { yontem: 'havale', cep: '', kart_id: '', tutar: '' }] }))}>+ Başka yolla da ödendi</Dugme>
          </div>

          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--pi-bg)', fontSize: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Toplam <b style={num}>{fmt(toplam)}</b> ₺</span>
            {konuObj && (konuObj.gider && f.kimin !== 'patron'
              ? <Cip tur="sari">şube/ortak GİDERİ olarak yazılacak</Cip>
              : <Cip>gider DEĞİL — {f.konu === 'toptanci' ? 'toptancı borcunu kapatır' : f.konu === 'kart_borcu' ? 'kart borcunu kapatır' : f.konu === 'kredi' ? 'patronun borcu' : 'patron çekişi'}</Cip>)}
            {f.parcalar.some((p) => p.yontem === 'kart') && <Cip>kart kısmı kasadan düşmez, kart borcu olur</Cip>}
          </div>
          {hata && <div style={{ color: R.kirmizi, fontWeight: 600 }}>{hata}</div>}
          <div><button type="button" onClick={gonder} disabled={mesgul || !toplam} style={{
            padding: '13px 26px', borderRadius: 12, border: 'none', background: 'var(--pi-accent)', color: 'var(--pi-on-accent)',
            font: 'inherit', fontSize: 16, fontWeight: 700, cursor: mesgul || !toplam ? 'not-allowed' : 'pointer', opacity: mesgul || !toplam ? 0.5 : 1,
          }}>{mesgul ? 'Kaydediliyor…' : 'Ödemeyi kaydet'}</button></div>
        </>)}
      </div>

      {/* AYIN ÖDEMELERİ */}
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--pi-line)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>Ödemeler</b>
          {liste && <span style={{ color: R.not, fontSize: 13 }}>toplam {fmt(liste.toplam)} ₺ · gider sayılan {fmt(liste.gider_toplam)} ₺</span>}
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)} style={{ ...alan, width: 'auto', padding: '6px 9px', fontSize: 13, marginLeft: 'auto' }} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="pi-tablo pi-excel">
            <thead><tr><th>Gün</th><th style={{ textAlign: 'left' }}>Ne için</th><th style={{ textAlign: 'left' }}>Açıklama</th><th style={{ textAlign: 'left' }}>Kimin</th><th style={{ textAlign: 'left' }}>Nasıl</th><th>Tutar</th><th style={{ textAlign: 'left' }}>Gider mi</th></tr></thead>
            <tbody>
              {(liste?.odemeler || []).map((x) => (
                <tr key={x.id}>
                  <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(x.tarih)}</td>
                  <td style={{ textAlign: 'left' }}>{x.konu}</td>
                  <td style={{ textAlign: 'left' }}>{x.aciklama}</td>
                  <td style={{ textAlign: 'left' }}>{x.kimin || '—'}</td>
                  <td style={{ textAlign: 'left', fontSize: 12 }}>{[...x.nakit.map((n) => `${n.ad} ${fmt(n.tutar)}`), ...x.kart.map((k) => `💳 ${k.ad} ${fmt(k.tutar)}`)].join(' + ')}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{fmt(x.toplam)}</td>
                  <td style={{ textAlign: 'left' }}>{x.gider ? <Cip tur="sari">gider{x.ait_ay ? ` · ${x.ait_ay}` : ''}</Cip> : <span style={{ color: R.not }}>—</span>}</td>
                </tr>
              ))}
              {liste && !liste.odemeler.length && <tr><td colSpan={7} style={{ textAlign: 'center', color: R.not }}>Bu ay ödeme yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export { tl };
