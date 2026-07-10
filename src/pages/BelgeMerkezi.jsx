import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

// 🧾 BELGE MERKEZİ (2026-07-10) — sahip: "faturaları toptancı toptancı, ay ay,
// gün gün görebildiğim; işletme harcamalarından faturası OLMAYANLARI direkt
// gördüğüm mekanizma". Kaynak: /api/fatura/belge-merkezi (salt-okur).
const DURUM_RENK = { ocr_bekliyor: '#f59e0b', incelendi: '#22c55e', onaylandi: '#22c55e' };

export default function BelgeMerkezi() {
  const bugunAy = new Date().toISOString().slice(0, 7);
  const [ay, setAy] = useState(bugunAy);
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [acikToptanci, setAcikToptanci] = useState(null);
  // BM-8: tam metin arama
  const [q, setQ] = useState('');
  const [araSonuc, setAraSonuc] = useState(null);
  async function ara() {
    if (q.trim().length < 2) return;
    try { setAraSonuc(await api(`/fatura/ara?q=${encodeURIComponent(q.trim())}`)); }
    catch (e) { setAraSonuc({ hata: e?.message || 'arama hatası' }); }
  }

  useEffect(() => {
    setD(null); setHata('');
    api(`/fatura/belge-merkezi?ay=${ay}`).then(setD)
      .catch(e => setHata(e?.message || 'Yüklenemedi'));
  }, [ay]);

  const k = d?.kapsama || {};
  const oran = k.oran_yuzde;

  return (
    <div style={{ padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>🧾 Belge Merkezi</h2>
        <input type="month" value={ay} onChange={e => setAy(e.target.value)}
          style={{ background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>
          Fatura arşivi · faturasız harcamalar · gün gün kapsama
        </span>
      </div>
      {/* BM-8 — arama */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ara()}
          placeholder="🔍 Fatura ara: tedarikçi, fatura no, belge içeriği, ürün adı…"
          style={{ flex: 1, background: 'var(--bg2)', color: 'var(--text)',
                   border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }} />
        <button className="btn btn-secondary" onClick={ara}>Ara</button>
        {araSonuc && <button className="btn btn-secondary" onClick={() => { setAraSonuc(null); setQ(''); }}>✕</button>}
      </div>
      {araSonuc && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>🔍 Arama: "{araSonuc.q}" — {araSonuc.adet ?? 0} sonuç</div>
          {araSonuc.hata && <div style={{ color: 'var(--red)' }}>{araSonuc.hata}</div>}
          {(araSonuc.sonuclar || []).map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{s.tarih || '—'} · <b>{s.tedarikci_ad || '?'}</b> · {s.fatura_no || 'no yok'}
                {s.gib_dogrulama === 'dogrulandi' && ' · ✅GİB'}
                {s.gib_dogrulama === 'supheli' && ' · ⚠️GİB'}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{fmt(s.tutar)} <a href={s.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎</a>{' '}
                <a href="https://ebelge.gib.gov.tr/earsivsorgula.html" target="_blank" rel="noreferrer" title="GİB e-Arşiv sorgula (sonucu sistemde damgala)" style={{ color: 'var(--text3)' }}>🏛️</a></span>
            </div>
          ))}
        </div>
      )}
      {hata && <div className="card" style={{ padding: 14, color: 'var(--red)' }}>{hata}</div>}
      {!d && !hata && <div style={{ color: 'var(--text3)' }}>Yükleniyor…</div>}
      {d && (
        <>
          {/* KAPSAMA BARI */}
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontWeight: 800 }}>Belge Kapsama — {d.ay}</div>
              <div style={{ fontSize: 13, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>💳 İşletme kart harcaması: <b>{fmt(k.isletme_kart_harcamasi || 0)}</b></span>
                <span style={{ color: 'var(--green)' }}>🧾 Faturalı: <b>{fmt(k.faturali_eslesen || 0)}</b></span>
                <span style={{ color: 'var(--red)' }}>⚠ Faturasız: <b>{fmt(k.faturasiz || 0)}</b></span>
              </div>
            </div>
            <div style={{ marginTop: 10, height: 14, borderRadius: 999, background: 'rgba(239,68,68,.25)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, oran || 0)}%`, height: '100%', background: 'var(--green)' }} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
              Kapsama: {oran != null ? `%${oran}` : '—'} · faturasız kısım = belge isteme adayı (KDV indirimi + gider kanıtı)
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 14 }}>
            {/* TOPTANCILAR */}
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>🏪 Toptancı Toptancı ({(d.toptancilar || []).length})</div>
              {(d.toptancilar || []).length === 0 && <div style={{ color: 'var(--text3)', fontSize: 13 }}>Bu ay arşivde fatura yok.</div>}
              {(d.toptancilar || []).map(t => (
                <div key={t.toptanci} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }}
                       onClick={() => setAcikToptanci(a => a === t.toptanci ? null : t.toptanci)}>
                    <span style={{ fontWeight: 700 }}>{t.toptanci} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({t.adet} fatura)</span></span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(t.toplam)}</span>
                  </div>
                  {acikToptanci === t.toptanci && (
                    <div style={{ marginTop: 6 }}>
                      {(d.fatura_arsivi || []).filter(f => (f.tedarikci_ad || '(tedarikçi belirsiz)').trim() === t.toptanci || ((f.tedarikci_ad || '').trim() === '' && t.toptanci === '(tedarikçi belirsiz)')).map(f => (
                        <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                          <span>{f.tarih || '—'} · <span style={{ color: DURUM_RENK[f.durum] || 'var(--text3)' }}>{f.durum}</span></span>
                          <span>
                            {fmt(f.tutar)}{' '}
                            <a href={f.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎 gör</a>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* FATURASIZ HARCAMALAR */}
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontWeight: 800, marginBottom: 8, color: 'var(--red)' }}>
                ⚠ Faturası Olmayan İşletme Harcamaları ({(d.faturasiz_harcamalar || []).length})
              </div>
              {(d.faturasiz_harcamalar || []).length === 0 && <div style={{ color: 'var(--green)', fontSize: 13 }}>Hepsi eşleşti 🎉</div>}
              <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                {(d.faturasiz_harcamalar || []).map((h, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                    <span>{h.tarih} · {(h.kart || '').slice(0, 16)} · {h.aciklama}{h.tip === 'belirsiz' ? ' · ❓' : ''}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmt(h.tutar)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* GÜN GÜN */}
          <div className="card" style={{ padding: 16, marginTop: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>📅 Gün Gün</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Gün</th><th style={{ textAlign: 'right' }}>Fatura (adet)</th><th style={{ textAlign: 'right' }}>Fatura toplamı</th><th style={{ textAlign: 'right' }}>Faturasız harcama</th></tr></thead>
                <tbody>
                  {(d.gun_gun || []).map(g => (
                    <tr key={g.gun}>
                      <td>{g.gun}</td>
                      <td style={{ textAlign: 'right' }}>{g.fatura_adet}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(g.fatura_toplam)}</td>
                      <td style={{ textAlign: 'right', color: g.faturasiz_harcama > 0 ? 'var(--red)' : 'var(--text3)' }}>{fmt(g.faturasiz_harcama)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>{d.not}</div>
        </>
      )}
    </div>
  );
}
