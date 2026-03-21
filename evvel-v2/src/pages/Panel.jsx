import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

const SEV_RENK = { KRITIK: 'red', UYARI: 'yellow', SAGLIKLI: 'green' };
const SEV_IKON = { KRITIK: '🚨', UYARI: '⚠️', SAGLIKLI: '✅' };

export default function Panel() {
  const [panel, setPanel] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/panel').then(d => { setPanel(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><div className="spinner"/> Yükleniyor...</div>;
  if (!panel) return <div className="empty"><p>Veri yüklenemedi</p></div>;

  const durum = panel.genel_durum;
  const renkClass = SEV_RENK[durum] || 'green';

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>CFO Kontrol Paneli</h2>
          <p>EVVEL ERP V2 · {new Date().toLocaleDateString('tr-TR')}</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>↻ Yenile</button>
      </div>

      {/* Genel durum bandı */}
      <div className={`alert-box ${renkClass} mb-24`} style={{ marginBottom: 20 }}>
        <span style={{ fontSize: 20 }}>{SEV_IKON[durum]}</span>
        <div style={{ flex: 1 }}>
          <strong>Sistem Durumu: {durum}</strong>
          <span style={{ marginLeft: 12, fontSize: 12, opacity: .8 }}>
            {panel.ozet?.kritik > 0 ? `${panel.ozet.kritik} kritik uyarı` : 'Kritik uyarı yok'}
          </span>
        </div>
        {panel.bekleyen_onay?.sayi > 0 && (
          <span className="badge badge-yellow">
            {panel.bekleyen_onay.sayi} onay bekliyor
          </span>
        )}
      </div>

      {/* Ana metrikler */}
      <div className="metrics">
        <div className={`metric-card ${panel.kasa >= 0 ? 'green' : 'red'}`}>
          <div className="metric-label">Güncel Kasa</div>
          <div className={`metric-value ${panel.kasa >= 0 ? 'green' : 'red'}`}>{fmt(panel.kasa)}</div>
          <div className="metric-sub">Merkez kasa</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">7 Gün Ödeme</div>
          <div className={`metric-value ${panel.odeme_ozet?.t7 > panel.kasa ? 'red' : 'yellow'}`}>
            {fmt(panel.odeme_ozet?.t7)}
          </div>
          <div className="metric-sub">Yaklaşan yükümlülük</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">15 Gün Ödeme</div>
          <div className="metric-value yellow">{fmt(panel.odeme_ozet?.t15)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">30 Gün Ödeme</div>
          <div className="metric-value">{fmt(panel.odeme_ozet?.t30)}</div>
        </div>
      </div>

      {/* Kararlar + Simülasyon */}
      <div className="grid-2">
        {/* Kararlar */}
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>🧠 Erken Uyarı Sistemi</h3>
          {!panel.kararlar?.length ? (
            <div className="empty"><div className="icon">✅</div><p>Kritik durum yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {panel.kararlar.map((k, i) => (
                <div key={i} className={`alert-box ${SEV_RENK[k.seviye] || 'yellow'} ${k.blink ? 'blink' : ''}`}>
                  <span>{k.seviye === 'KRITIK' ? '🚨' : '⚠️'}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{k.baslik}</div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>{k.mesaj}</div>
                    {k.aksiyon && <div style={{ fontSize: 11, marginTop: 4, opacity: .8 }}>→ {k.aksiyon}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Simülasyon grafik */}
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>📉 15 Günlük Kasa Projeksiyonu</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={panel.simulasyon}>
                <defs>
                  <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4caf84" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#4caf84" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d35"/>
                <XAxis dataKey="tarih" tick={{ fill: '#6b6f7a', fontSize: 10 }} tickFormatter={d => d?.slice(5)}/>
                <YAxis tick={{ fill: '#6b6f7a', fontSize: 10 }} tickFormatter={v => (v/1000).toFixed(0)+'K'}/>
                <Tooltip contentStyle={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 6, fontSize: 12 }}
                  formatter={v => [fmt(v)]}/>
                <Area type="monotone" dataKey="kasa_tahmini" stroke="#4caf84" fill="url(#cg)" strokeWidth={2} dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Vadeli alım hatırlatmaları */}
      {panel.kararlar?.filter(k => k.kural === 6).length > 0 && (
        <div className="card" style={{ borderTop: '2px solid var(--yellow)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>📦 Vadeli Alım Hatırlatmaları</h3>
          {panel.kararlar.filter(k => k.kural === 6).map((k, i) => (
            <div key={i} className="alert-box orange">{k.mesaj}</div>
          ))}
        </div>
      )}
    </div>
  );
}
