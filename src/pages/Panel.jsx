import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from 'recharts';

export default function Panel() {
  const [panel, setPanel] = useState(null);
  const [strateji, setStrateji] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    Promise.all([api('/panel'), api('/strateji')])
      .then(([p, s]) => { setPanel(p); setStrateji(s); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="loading"><div className="spinner"/>Yükleniyor...</div>;
  if (!panel) return <div className="empty"><p>Veri yüklenemedi</p></div>;

  const durum = panel.genel_durum || 'SAGLIKLI';
  const durumRenk = durum === 'KRITIK' ? 'red' : durum === 'UYARI' ? 'yellow' : 'green';
  const kasa = panel.kasa || 0;
  const t7 = panel.odeme_ozet?.t7 || 0;

  return (
    <div className="page">

      {panel && panel.aksiyonlar && panel.aksiyonlar.length > 0 && (
        <div style={{
          background:"#1a1a1a",
          padding:16,
          borderRadius:10,
          marginBottom:20
        }}>
          <h3>📌 Bugün Yapılacaklar</h3>

          {panel.aksiyonlar.map((a,i)=>(
            <div key={i} style={{
              padding:10,
              marginTop:8,
              borderRadius:6,
              background:
                a.tip==="kritik" ? "#3a0000" :
                a.tip==="uyari" ? "#3a2a00" :
                "#002a2a"
            }}>
              {a.mesaj}
            </div>
          ))}
        </div>
      )}

      <div className="page-header flex items-center justify-between">
        <div><h2>CFO Kontrol Paneli</h2><p>EVVEL ERP V2 · {new Date().toLocaleDateString('tr-TR')}</p></div>
        <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
      </div>

      {/* Sistem durumu bandı */}
      <div className={`alert-box ${durumRenk} mb-16`} style={{alignItems:'center'}}>
        <span style={{fontSize:20}}>{durum==='KRITIK'?'🚨':durum==='UYARI'?'⚠️':'✅'}</span>
        <div style={{flex:1}}>
          <strong>Sistem: {durum}</strong>
          <span style={{marginLeft:12,fontSize:12,opacity:.8}}>
            {panel.ozet?.kritik>0?`${panel.ozet.kritik} kritik uyarı`:'Kritik uyarı yok'}
          </span>
        </div>
        {panel.bekleyen_onay?.sayi>0 && (
          <span className="badge badge-yellow">{panel.bekleyen_onay.sayi} onay bekliyor · {fmt(panel.bekleyen_onay.toplam)}</span>
        )}
      </div>

      {/* Ana KPI'lar */}
      <div className="metrics">
        <div className={`metric-card ${kasa>=0?'green':'red'}`} style={{borderTop:`3px solid var(--${kasa>=0?'green':'red'})`}}>
          <div className="metric-label">💰 Güncel Kasa</div>
          <div className={`metric-value ${kasa>=0?'green':'red'}`} style={{fontSize:28}}>{fmt(kasa)}</div>
          <div className="metric-sub">Merkez kasa bakiyesi</div>
        </div>
        <div className={`metric-card ${t7>kasa?'red':'yellow'}`}>
          <div className="metric-label">⚡ 7 Gün Ödeme</div>
          <div className={`metric-value ${t7>kasa?'red':'yellow'}`}>{fmt(t7)}</div>
          <div className="metric-sub" style={{color:t7>kasa?'var(--red)':undefined}}>{t7>kasa?'⚠️ Kasadan fazla!':'Yaklaşan yük'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">📅 15 Gün Ödeme</div>
          <div className="metric-value">{fmt(panel.odeme_ozet?.t15)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">📆 30 Gün Ödeme</div>
          <div className="metric-value">{fmt(panel.odeme_ozet?.t30)}</div>
        </div>
        <div className="metric-card green">
          <div className="metric-label">📈 Toplam Gelir</div>
          <div className="metric-value green">{fmt(panel.toplam_gelir)}</div>
        </div>
        <div className="metric-card red">
          <div className="metric-label">📉 Toplam Gider</div>
          <div className="metric-value red">{fmt(panel.toplam_gider)}</div>
        </div>
      </div>

      <div className="grid-2">
        {/* Erken uyarı sistemi */}
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>🧠 Erken Uyarı Sistemi</h3>
          {!panel.kararlar?.length ? (
            <div className="empty"><div className="icon">✅</div><p>Kritik durum yok</p></div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:300,overflowY:'auto'}}>
              {panel.kararlar.map((k,i) => (
                <div key={i} className={`alert-box ${k.seviye==='KRITIK'?'red':'orange'} ${k.blink?'blink':''}`}>
                  <span>{k.seviye==='KRITIK'?'🚨':'⚠️'}</span>
                  <div>
                    <div style={{fontWeight:600}}>{k.baslik}</div>
                    <div style={{fontSize:12,marginTop:2}}>{k.mesaj}</div>
                    {k.aksiyon&&<div style={{fontSize:11,marginTop:4,opacity:.8}}>→ {k.aksiyon}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Kart risk paneli */}
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>💳 Kart Risk Paneli</h3>
          {!panel.kart_analiz?.length ? (
            <div className="empty"><div className="icon">💳</div><p>Kart tanımlanmamış</p></div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:10}}>
              {panel.kart_analiz.map(k => {
                const d = k.limit_doluluk||0;
                const renk = d>0.9?'var(--red)':d>0.7?'var(--yellow)':'var(--green)';
                return (
                  <div key={k.kart_adi} style={{background:'var(--bg3)',borderRadius:8,padding:'10px 14px',borderLeft:`3px solid ${renk}`}} className={k.blink?'blink':''}>
                    <div className="flex items-center justify-between" style={{marginBottom:6}}>
                      <div>
                        <span style={{fontWeight:600,fontSize:13}}>💳 {k.kart_adi}</span>
                        <span style={{fontSize:11,color:'var(--text3)',marginLeft:6}}>{k.banka}</span>
                        {k.blink&&<span className="badge badge-red" style={{marginLeft:6}}>SON GÜN</span>}
                      </div>
                      <span style={{fontFamily:'var(--font-mono)',fontSize:14,fontWeight:700,color:renk}}>{fmt(k.guncel_borc)}</span>
                    </div>
                    <div className="progress-bar" style={{marginBottom:4}}>
                      <div className={`progress-fill ${d>0.9?'red':d>0.7?'yellow':'green'}`} style={{width:`${Math.min(100,d*100)}%`}}/>
                    </div>
                    <div className="flex items-center justify-between" style={{fontSize:11,color:'var(--text3)'}}>
                      <span>Limit: {fmt(k.limit_tutar)}</span>
                      <span style={{color:renk,fontWeight:600}}>{(d*100).toFixed(0)}%</span>
                      <span>Son öd: {k.gun_kaldi<=0?'BUGÜN':`${k.gun_kaldi} gün`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>📉 15 Günlük Kasa Projeksiyonu</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={panel.simulasyon}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d35"/>
                <XAxis dataKey="tarih"/>
                <YAxis/>
                <Tooltip/>
                <Area dataKey="kasa_tahmini"/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>📊 Aylık Ciro</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[...(panel.aylik_ciro||[])].reverse()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d35"/>
                <XAxis dataKey="ay"/>
                <YAxis/>
                <Tooltip/>
                <Bar dataKey="ciro" fill="#4caf84"/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
