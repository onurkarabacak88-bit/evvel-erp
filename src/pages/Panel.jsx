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
        {/* Simülasyon grafik */}
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>📉 15 Günlük Kasa Projeksiyonu</h3>
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
                <XAxis dataKey="tarih" tick={{fill:'#6b6f7a',fontSize:10}} tickFormatter={d=>d?.slice(5)}/>
                <YAxis tick={{fill:'#6b6f7a',fontSize:10}} tickFormatter={v=>(v/1000).toFixed(0)+'K'}/>
                <Tooltip contentStyle={{background:'#1a1d24',border:'1px solid #2a2d35',borderRadius:6,fontSize:12}} formatter={v=>[fmt(v)]}/>
                <Area type="monotone" dataKey="kasa_tahmini" stroke="#4caf84" fill="url(#cg)" strokeWidth={2} dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Aylık ciro */}
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>📊 Aylık Ciro</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[...( panel.aylik_ciro||[])].reverse()}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d35"/>
                <XAxis dataKey="ay" tick={{fill:'#6b6f7a',fontSize:10}}/>
                <YAxis tick={{fill:'#6b6f7a',fontSize:10}} tickFormatter={v=>(v/1000).toFixed(0)+'K'}/>
                <Tooltip contentStyle={{background:'#1a1d24',border:'1px solid #2a2d35',borderRadius:6,fontSize:12}} formatter={v=>[fmt(v)]}/>
                <Bar dataKey="ciro" name="Ciro" fill="#4caf84" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Strateji önerileri */}
      {strateji?.oneriler?.length>0 && (
        <div className="card" style={{borderTop:'2px solid var(--yellow)'}}>
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:12}}>🧠 Strateji Önerileri</h3>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {strateji.oneriler.slice(0,3).map((o,i)=>(
              <div key={i} className={`alert-box ${o.renk==='KIRMIZI'?'red':o.renk==='SARI'?'yellow':'orange'} ${o.blink?'blink':''}`}
                style={{justifyContent:'space-between',alignItems:'center'}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600,fontSize:13}}>{o.baslik}</div>
                  <div style={{fontSize:12,marginTop:2}}>{o.aciklama}</div>
                </div>
                {o.tavsiye_tutar>0&&<div className="mono" style={{fontWeight:700,marginLeft:16}}>{fmt(o.tavsiye_tutar)}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Vadeli alım hatırlatmaları */}
      {panel.kararlar?.filter(k=>k.kural===6).length>0&&(
        <div className="card" style={{borderTop:'2px solid var(--yellow)'}}>
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:12}}>📦 Vadeli Alım Hatırlatmaları</h3>
          {panel.kararlar.filter(k=>k.kural===6).map((k,i)=>(
            <div key={i} className="alert-box orange">{k.mesaj}</div>
          ))}
        </div>
      )}
    </div>
  );
}
