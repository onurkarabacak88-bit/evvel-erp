import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

export default function Panel() {
  const [panel, setPanel] = useState(null);
  const [uyarilar, setUyarilar] = useState([]);
  const [loading, setLoading] = useState(true);
  const [odemeModal, setOdemeModal] = useState(null);
  const [manuelTutar, setManuelTutar] = useState('');
  const [msg, setMsg] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([api('/panel'), api('/uyarilar')])
      .then(([p, u]) => { setPanel(p); setUyarilar(u || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  async function odemeOnayla(odemeId, tutar) {
    try {
      const params = tutar ? `?manuel_tutar=${tutar}` : '';
      await api(`/odeme-plani/${odemeId}/odendi${params}`, { method: 'POST' });
      toast('✓ Ödeme onaylandı — kasadan düşüldü');
      setOdemeModal(null);
      setManuelTutar('');
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function odemeErtele(odemeId) {
    try {
      await api(`/odeme-plani/${odemeId}/ertele`, { method: 'POST' });
      toast('Ödeme 7 gün ertelendi');
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function planUret() {
    try {
      const r = await api('/odeme-plani/uret', { method: 'POST' });
      toast(`✓ ${r.toplam} ödeme planı üretildi`);
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 12 }}>
      <div className="spinner" />
      <span style={{ fontSize: 13, color: 'var(--text3)' }}>Finans motoru çalışıyor...</span>
    </div>
  );

  if (!panel) return (
    <div className="empty">
      <p>Veri yüklenemedi</p>
      <button className="btn btn-primary" onClick={load}>Tekrar Dene</button>
    </div>
  );

  const durum = panel.genel_durum || 'SAGLIKLI';
  const kasa = parseFloat(panel.kasa) || 0;
  const serbest = parseFloat(panel.serbest_nakit) || 0;
  const yuk7 = parseFloat(panel.yuk_7) || 0;
  const yuk15 = parseFloat(panel.yuk_15) || 0;
  const yuk30 = parseFloat(panel.yuk_30) || 0;
  const netAkis = parseFloat(panel.net_akis_30) || 0;
  const kasDayan = parseInt(panel.kac_gun_dayanir) || 999;
  const buAyCiro = parseFloat(panel.bu_ay_ciro) || 0;
  const riskGunu = panel.risk_gunu;

  const DC = {
    KRITIK: { renk: 'var(--red)', bg: 'rgba(220,50,50,0.08)', ikon: '🚨', label: 'KRİTİK' },
    UYARI:  { renk: 'var(--yellow)', bg: 'rgba(220,160,0,0.08)', ikon: '⚠️', label: 'UYARI' },
    SAGLIKLI: { renk: 'var(--green)', bg: 'rgba(76,175,132,0.08)', ikon: '✅', label: 'SAĞLIKLI' },
  };
  const dc = DC[durum] || DC.SAGLIKLI;

  const kritikler = uyarilar.filter(u => u.seviye === 'KRITIK');
  const diger = uyarilar.filter(u => u.seviye !== 'KRITIK');
  const tumUyarilar = [...kritikler, ...diger];

  const simData = (panel.simulasyon || []).map(g => ({
    tarih: String(g.tarih || '').slice(5),
    mevcut: parseFloat(g.kasa_tahmini) || 0,
    onerili: parseFloat(g.kasa_tahmini_onerili) || 0,
  }));

  const riskBar = Math.min(100, yuk30 > 0 ? (yuk30 / Math.max(kasa, 1)) * 100 : 0);
  const riskRenk = kasa < yuk7 ? 'var(--red)' : kasa < yuk30 ? 'var(--yellow)' : 'var(--green)';

  return (
    <div className="page">
      {/* TOAST */}
      {msg && (
        <div className={`alert-box ${msg.t}`} style={{ position: 'sticky', top: 0, zIndex: 20, marginBottom: 12 }}>
          {msg.m}
        </div>
      )}

      {/* ── 1. DURUM BAŞLIĞI ── */}
      <div style={{
        background: dc.bg, border: `1px solid ${dc.renk}`,
        borderRadius: 10, padding: '14px 18px', marginBottom: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 24 }}>{dc.ikon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: dc.renk }}>{dc.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              {panel.ozet?.kritik > 0 ? `${panel.ozet.kritik} kritik · ` : ''}
              {new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={planUret}>⚙️ Plan Üret</button>
          <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
        </div>
      </div>

      {/* ── 2. KRİTİK UYARILAR ── */}
      {kritikler.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {kritikler.map((u, i) => (
            <div key={i} className={u.blink ? 'blink' : ''} style={{
              background: 'rgba(220,50,50,0.07)', border: '1px solid var(--red)',
              borderRadius: 8, padding: '12px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>
                  🚨 {u.aciklama}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{u.mesaj}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {fmtDate(u.tarih)} · Tam: <strong>{fmt(u.tutar)}</strong> · Asgari: <strong>{fmt(u.asgari)}</strong>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" onClick={() => { setOdemeModal(u); setManuelTutar(''); }}>✓ Ödendi</button>
                <button className="btn btn-secondary btn-sm" onClick={() => odemeErtele(u.odeme_id)}>⏳ Ertele</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── 3. 4 ANA METRİK ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {[
          {
            label: '💰 Güncel Kasa',
            value: fmt(kasa),
            sub: kasDayan < 999 ? `${kasDayan} gün dayanır` : 'Stabil',
            renk: kasa >= 0 ? 'var(--green)' : 'var(--red)',
          },
          {
            label: '🆓 Serbest Nakit',
            value: fmt(serbest),
            sub: '7 günlük yük düşülmüş',
            renk: serbest >= 0 ? 'var(--green)' : 'var(--red)',
          },
          {
            label: '📊 Net Akış (30 gün)',
            value: fmt(netAkis),
            sub: netAkis >= 0 ? 'Pozitif ✓' : '⚠️ Negatif akış',
            renk: netAkis >= 0 ? 'var(--green)' : 'var(--red)',
          },
          {
            label: '📈 Bu Ay Ciro',
            value: fmt(buAyCiro),
            sub: new Date().toLocaleDateString('tr-TR', { month: 'long' }),
            renk: 'var(--text1)',
          },
        ].map(({ label, value, sub, renk }) => (
          <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 24, color: renk }}>{value}</div>
            <div className="metric-sub">{sub}</div>
          </div>
        ))}
      </div>

      {/* ── 4. ÖDEME BASKISI ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>⚡ Ödeme Baskısı</h3>
          {riskGunu && (
            <span style={{ fontSize: 11, color: 'var(--red)', background: 'rgba(220,50,50,0.1)', padding: '3px 8px', borderRadius: 4 }}>
              ⚠️ Risk günü: {fmtDate(riskGunu)}
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {[
            { gun: '7 gün', tutar: yuk7 },
            { gun: '15 gün', tutar: yuk15 },
            { gun: '30 gün', tutar: yuk30 },
          ].map(({ gun, tutar }) => {
            const yetersiz = kasa < tutar;
            return (
              <div key={gun} style={{
                background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', textAlign: 'center',
                borderLeft: `3px solid ${yetersiz ? 'var(--red)' : 'var(--border)'}`
              }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{gun}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: yetersiz ? 'var(--red)' : 'var(--text1)' }}>
                  {fmt(tutar)}
                </div>
                <div style={{ fontSize: 10, color: yetersiz ? 'var(--red)' : 'var(--text3)', marginTop: 3 }}>
                  {yetersiz ? '⚠️ Yetersiz kasa' : tutar > 0 ? `${((tutar / Math.max(kasa, 1)) * 100).toFixed(0)}% kasa` : '—'}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 4, transition: 'width 0.6s ease',
            width: `${Math.min(100, riskBar)}%`,
            background: riskRenk,
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', marginTop: 5 }}>
          <span>Kasa: <strong style={{ color: riskRenk }}>{fmt(kasa)}</strong></span>
          <span>Baskı: <strong style={{ color: riskRenk }}>{riskBar.toFixed(0)}%</strong></span>
          <span>30 gün yük: <strong>{fmt(yuk30)}</strong></span>
        </div>
      </div>

      {/* ── 5. ANA GÖVDE: ÖDEMELER + KARTLAR ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* SOL: ÖDEMELER */}
        <div className="card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>📅 Yaklaşan Ödemeler</h3>
          {tumUyarilar.length === 0 ? (
            <div className="empty"><p>Yaklaşan ödeme yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {tumUyarilar.map((u, i) => (
                <div key={i} style={{
                  padding: '10px 12px', borderRadius: 6,
                  background: u.seviye === 'KRITIK' ? 'rgba(220,50,50,0.06)' : u.seviye === 'UYARI' ? 'rgba(220,160,0,0.06)' : 'var(--bg3)',
                  borderLeft: `3px solid ${u.seviye === 'KRITIK' ? 'var(--red)' : u.seviye === 'UYARI' ? 'var(--yellow)' : 'var(--border)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{u.aciklama}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                        {fmtDate(u.tarih)} · {u.gun_farki === 0 ? '🔴 BUGÜN' : u.gun_farki < 0 ? `${Math.abs(u.gun_farki)} gün gecikmiş` : `${u.gun_farki} gün kaldı`}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmt(u.tutar)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>asgari: {fmt(u.asgari)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11 }}
                      onClick={() => { setOdemeModal(u); setManuelTutar(''); }}>
                      ✓ Ödendi
                    </button>
                    <button className="btn btn-secondary btn-sm" style={{ flex: 1, fontSize: 11 }}
                      onClick={() => odemeErtele(u.odeme_id)}>
                      ⏳ Ertele
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SAĞ: KART RİSK */}
        <div className="card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>💳 Kart Riskleri</h3>
          {!panel.kart_analiz?.length ? (
            <div className="empty"><p>Kart tanımlanmamış</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {panel.kart_analiz.map(k => {
                const d = parseFloat(k.limit_doluluk) || 0;
                const renk = d > 0.85 ? 'var(--red)' : d > 0.65 ? 'var(--yellow)' : 'var(--green)';
                return (
                  <div key={k.kart_adi} className={k.blink ? 'blink' : ''} style={{
                    background: 'var(--bg3)', borderRadius: 8, padding: '12px 14px',
                    borderLeft: `3px solid ${renk}`
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{k.kart_adi}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 6 }}>{k.banka}</span>
                        {k.blink && <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>SON GÜN</span>}
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: renk }}>
                        {fmt(k.guncel_borc)}
                      </span>
                    </div>
                    <div className="progress-bar" style={{ marginBottom: 6 }}>
                      <div className={`progress-fill ${d > 0.85 ? 'red' : d > 0.65 ? 'yellow' : 'green'}`}
                        style={{ width: `${Math.min(100, d * 100)}%` }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
                      <span>Limit: {fmt(k.limit_tutar)}</span>
                      <span style={{ color: renk, fontWeight: 700 }}>{(d * 100).toFixed(0)}% dolu</span>
                      <span>{k.gun_kaldi <= 0 ? '🔴 BUGÜN SON GÜN' : `${k.gun_kaldi} gün kaldı`}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 6, color: 'var(--text3)' }}>
                      <span>Ekstre: {fmt(k.bu_ekstre)}</span>
                      <span>Asgari: <strong style={{ color: renk }}>{fmt(k.asgari_odeme)}</strong></span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── 6. SİMÜLASYON GRAFİĞİ ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>📉 30 Günlük Kasa Projeksiyonu</h3>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text3)' }}>
            <span><span style={{ color: 'var(--green)' }}>━</span> Mevcut seyir</span>
            <span><span style={{ color: 'var(--yellow)' }}>╌</span> Önerili ödemelerle</span>
            <span><span style={{ color: 'var(--red)' }}>╌</span> Sıfır hattı</span>
          </div>
        </div>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={simData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="kasaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4caf84" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#4caf84" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="tarih" tick={{ fill: 'var(--text3)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text3)', fontSize: 10 }} tickFormatter={v => (v / 1000).toFixed(0) + 'K'} width={45} />
              <Tooltip
                contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                formatter={(v, n) => [fmt(v), n === 'mevcut' ? 'Mevcut seyir' : 'Önerili']}
              />
              <ReferenceLine y={0} stroke="var(--red)" strokeDasharray="3 3" strokeOpacity={0.6} />
              <Area type="monotone" dataKey="mevcut" stroke="#4caf84" fill="url(#kasaGrad)" strokeWidth={2} dot={false} name="mevcut" />
              <Area type="monotone" dataKey="onerili" stroke="#f0c040" fill="none" strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="onerili" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── 7. STRATEJİ ÖNERİLERİ ── */}
      {panel.oneriler?.filter(o => o.tavsiye_tutar > 0 || o.oneri_turu === 'KRITIK_NAKIT').length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🧠 Motor Önerileri</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {panel.oneriler.map((o, i) => {
              const renk = o.renk === 'KIRMIZI' ? 'var(--red)' : o.renk === 'TURUNCU' ? '#f07040' : o.renk === 'SARI' ? 'var(--yellow)' : 'var(--text3)';
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', borderRadius: 6, background: 'var(--bg3)',
                  borderLeft: `3px solid ${renk}`
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: renk }}>{o.baslik}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{o.aciklama}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {o.tavsiye_tutar > 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700 }}>{fmt(o.tavsiye_tutar)}</span>
                    )}
                    {o.odeme_id && o.tavsiye_tutar > 0 && (
                      <button className="btn btn-primary btn-sm"
                        onClick={() => { setOdemeModal({ ...o, tutar: o.tavsiye_tutar, asgari: o.tavsiye_tutar * 0.4 }); setManuelTutar(''); }}>
                        Uygula
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 8. ÖDEME ONAY MODALI ── */}
      {odemeModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setOdemeModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>💳 Ödeme Onayla</h3>
              <button className="modal-close" onClick={() => setOdemeModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{odemeModal.aciklama}</div>
                <div style={{ display: 'flex', gap: 24, fontSize: 12, color: 'var(--text3)' }}>
                  <span>Son gün: <strong style={{ color: 'var(--text1)' }}>{fmtDate(odemeModal.tarih)}</strong></span>
                  <span>Tam tutar: <strong style={{ color: 'var(--text1)' }}>{fmt(odemeModal.tutar)}</strong></span>
                  <span>Asgari: <strong style={{ color: 'var(--yellow)' }}>{fmt(odemeModal.asgari)}</strong></span>
                </div>
              </div>
              <div className="form-group">
                <label>Ödenen Tutar (₺)</label>
                <input
                  type="number"
                  value={manuelTutar}
                  onChange={e => setManuelTutar(e.target.value)}
                  placeholder={`Boş bırakırsan tam tutar: ${odemeModal.tutar}`}
                  autoFocus
                />
                {manuelTutar && parseFloat(manuelTutar) < (odemeModal.asgari || 0) && (
                  <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>
                    ⚠️ Girilen tutar asgari ödemenin altında ({fmt(odemeModal.asgari)})
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
                Kasadan düşülecek: <strong style={{ color: 'var(--red)', fontSize: 14 }}>
                  {fmt(parseFloat(manuelTutar) || odemeModal.tutar)}
                </strong>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setOdemeModal(null); setManuelTutar(''); }}>Vazgeç</button>
              <button className="btn btn-primary" onClick={() => odemeOnayla(odemeModal.odeme_id, manuelTutar || null)}>
                ✓ Ödendi — Onayla
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
