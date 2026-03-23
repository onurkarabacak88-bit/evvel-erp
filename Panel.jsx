import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from 'recharts';

export default function Panel() {
  const [panel, setPanel] = useState(null);
  const [onaylar, setOnaylar] = useState([]);
  const [loading, setLoading] = useState(true);
  const [senaryo, setSenaryo] = useState(null);
  const [senaryoTutar, setSenaryoTutar] = useState('');
  const [msg, setMsg] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([api('/panel'), api('/onay-kuyrugu')])
      .then(([p, o]) => { setPanel(p); setOnaylar(o); setLoading(false); })
      .catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toast = (m, t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),3000); };

  async function onayla(id) {
    try {
      await api(`/onay-kuyrugu/${id}/onayla`, { method:'POST' });
      toast('Onaylandı — kasadan düşüldü');
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function reddet(id) {
    try {
      await api(`/onay-kuyrugu/${id}/reddet`, { method:'POST' });
      toast('Reddedildi', 'yellow');
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  // TÜM AKSİYONLAR TEK NOKTADAN: /api/aksiyon
  async function aksiyonCalistir(tip, veri) {
    const mesajlar = {
      'hemen_ode': 'Bu ödemeyi onaylıyor musunuz? Kasadan düşülecek.',
      'odeme_ertele': 'Bu ödemeyi ertelemek istiyor musunuz?'
    };
    if (!confirm(mesajlar[tip] || 'Devam edilsin mi?')) return;
    try {
      const r = await api(`/aksiyon?tip=${tip}&kaynak_id=${veri?.odeme_id || ''}`, { method:'POST' });
      toast(r.mesaj || 'İşlem tamamlandı');
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function senaryoHesapla() {
    if (!senaryoTutar) return;
    try {
      const r = await api(`/senaryo?tutar=${senaryoTutar}&islem_turu=odeme`);
      setSenaryo(r);
    } catch(e) {}
  }

  if (loading) return <div className="loading"><div className="spinner"/>Yükleniyor...</div>;
  if (!panel) return <div className="empty"><p>Veri yüklenemedi</p></div>;

  const durum = panel.genel_durum || 'SAGLIKLI';
  const durumRenk = durum === 'KRITIK' ? 'red' : durum === 'UYARI' ? 'yellow' : 'green';
  const kasa = panel.kasa || 0;
  const t7 = panel.odeme_ozet?.t7 || 0;
  const t30 = panel.odeme_ozet?.t30 || 0;
  // CFO versiyon: (kasa - t7) / t30 — kısa vadeyi öne alır, daha gerçekçi
  const kasaNet = kasa - t7;  // 7 günlük yükü çıkarınca kalan nakit
  const riskOrani = Math.min(200, t30 > 0 ? (t30 / Math.max(kasaNet, 1)) * 100 : 0);
  const riskRenk = riskOrani > 100 ? 'var(--red)' : riskOrani > 70 ? 'var(--yellow)' : 'var(--green)';

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      {/* Bugün Yapılacaklar */}
      {panel.aksiyonlar?.length > 0 && (
        <div style={{background:'#1a1a1a',padding:16,borderRadius:10,marginBottom:16}}>
          <h3 style={{marginBottom:10,fontSize:14,fontWeight:600}}>📌 Bugün Yapılacaklar</h3>
          {panel.aksiyonlar.map((a,i) => (
            <div key={i} style={{
              padding:'10px 14px',marginTop:6,borderRadius:6,
              display:'flex',alignItems:'center',justifyContent:'space-between',
              background:a.tip==='kritik'?'#3a0000':a.tip==='uyari'?'#3a2a00':'#002a2a'
            }}>
              <span style={{fontSize:13,flex:1}}>{a.mesaj}</span>
              <div style={{display:'flex',gap:6,marginLeft:12}}>
                {a.aksiyon==='ciro' && <button className="btn btn-primary btn-sm" onClick={()=>window.dispatchEvent(new CustomEvent('navigate',{detail:'ciro'}))}>Ciro Gir</button>}
                {a.aksiyon==='odeme' && <button className="btn btn-primary btn-sm" onClick={()=>window.dispatchEvent(new CustomEvent('navigate',{detail:'onay'}))}>Ödemelere Git</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="page-header flex items-center justify-between">
        <div><h2>CFO Kontrol Paneli</h2><p>EVVEL ERP V2 · {new Date().toLocaleDateString('tr-TR')}</p></div>
        <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
      </div>

      {/* Sistem durumu */}
      <div className={`alert-box ${durumRenk} mb-16`} style={{alignItems:'center'}}>
        <span style={{fontSize:20}}>{durum==='KRITIK'?'🚨':durum==='UYARI'?'⚠️':'✅'}</span>
        <div style={{flex:1}}>
          <strong>Sistem: {durum}</strong>
          <span style={{marginLeft:12,fontSize:12,opacity:.8}}>
            {panel.ozet?.kritik>0?`${panel.ozet.kritik} kritik uyarı`:'Kritik uyarı yok'}
          </span>
        </div>
        {onaylar.length>0 && (
          <span className="badge badge-yellow">🔔 {onaylar.length} onay bekliyor</span>
        )}
      </div>

      {/* RİSK BARI */}
      <div className="card" style={{marginBottom:16,padding:'14px 20px'}}>
        <div className="flex items-center justify-between" style={{marginBottom:8}}>
          <span style={{fontSize:13,fontWeight:600}}>⚡ Ödeme Baskısı</span>
          <span style={{fontSize:12,color:'var(--text3)'}}>30 günlük ödeme / kasa</span>
        </div>
        <div style={{height:14,background:'var(--bg3)',borderRadius:6,overflow:'hidden',marginBottom:6}}>
          <div style={{
            height:'100%',borderRadius:6,transition:'width .5s',
            width:`${Math.min(100,riskOrani)}%`,
            background:riskRenk
          }}/>
        </div>
        <div className="flex items-center justify-between" style={{fontSize:12}}>
          <span style={{color:'var(--green)'}}>Kasa: <strong>{fmt(kasa)}</strong></span>
          <span style={{color:riskRenk,fontWeight:700}}>{riskOrani.toFixed(0)}% baskı</span>
          <span style={{color:'var(--red)'}}>30 gün ödeme: <strong>{fmt(t30)}</strong></span>
        </div>
        {/* Kasa gerçeği */}
        <div style={{marginTop:10,padding:'8px 12px',background:'var(--bg3)',borderRadius:6,fontSize:12,display:'flex',gap:24}}>
          <span>Bugün kasa: <strong style={{color:'var(--green)'}}>{fmt(kasa)}</strong></span>
          <span>7 gün sonra: <strong style={{color:kasa-t7<0?'var(--red)':'var(--green)'}}>{fmt(kasa-t7)}</strong> {kasa-t7<0&&'🔴'}</span>
          <span>30 gün sonra: <strong style={{color:kasa-t30<0?'var(--red)':'var(--yellow)'}}>{fmt(kasa-t30)}</strong> {kasa-t30<0&&'🔴'}</span>
        </div>
      </div>

      {/* KPI'lar */}
      <div className="metrics">
        <div className="metric-card" style={{borderTop:`3px solid var(--${kasa>=0?'green':'red'})`}}>
          <div className="metric-label">💰 Güncel Kasa</div>
          <div className={`metric-value ${kasa>=0?'green':'red'}`} style={{fontSize:28}}>{fmt(kasa)}</div>
          <div className="metric-sub">Merkez kasa bakiyesi</div>
        </div>
        <div className={`metric-card ${t7>kasa?'red':'yellow'}`}>
          <div className="metric-label">⚡ 7 Gün Ödeme</div>
          <div className={`metric-value ${t7>kasa?'red':'yellow'}`}>{fmt(t7)}</div>
          <div className="metric-sub">{t7>kasa?'⚠️ Kasadan fazla!':'Yaklaşan yük'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">📅 15 Gün</div>
          <div className="metric-value">{fmt(panel.odeme_ozet?.t15)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">📆 30 Gün</div>
          <div className="metric-value">{fmt(t30)}</div>
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

      {/* ONAY SİSTEMİ — panelin kalbi */}
      {onaylar.length > 0 && (
        <div className="card" style={{borderLeft:'4px solid var(--red)',marginBottom:16}}>
          <h3 style={{fontSize:14,fontWeight:700,color:'var(--red)',marginBottom:12}}>
            🔴 {onaylar.length} Ödeme Onay Bekliyor
          </h3>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {onaylar.map(o => (
              <div key={o.id} style={{
                display:'flex',alignItems:'center',justifyContent:'space-between',
                padding:'10px 14px',
                background: o.seviye==='KRITIK'?'rgba(220,50,50,0.1)':o.seviye==='UYARI'?'rgba(220,160,0,0.1)':'var(--bg3)',
                borderRadius:8,
                borderLeft: `3px solid ${o.seviye==='KRITIK'?'var(--red)':o.seviye==='UYARI'?'var(--yellow)':'var(--border)'}`
              }}>
                <div style={{flex:1}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span>{o.seviye==='KRITIK'?'🔴':o.seviye==='UYARI'?'🟡':'⚪'}</span>
                    <span style={{fontWeight:600,fontSize:13}}>{o.islem_turu}</span>
                    {o.seviye==='KRITIK'&&<span className="badge badge-red">BUGÜN</span>}
                  </div>
                  <div style={{fontSize:12,color:'var(--text3)',marginTop:2}}>{o.aciklama}</div>
                  <div style={{fontSize:11,color:'var(--text3)'}}>{o.tarih}</div>
                </div>
                <div style={{textAlign:'right',marginLeft:16}}>
                  <div style={{fontWeight:700,fontSize:15,
                    color:o.seviye==='KRITIK'?'var(--red)':o.seviye==='UYARI'?'var(--yellow)':'var(--text1)',
                    fontFamily:'var(--font-mono)'}}>
                    {fmt(o.tutar)}
                  </div>
                  <div style={{display:'flex',gap:6,marginTop:6,justifyContent:'flex-end'}}>
                    <button className="btn btn-primary btn-sm" onClick={()=>onayla(o.id)}>✓ Onayla</button>
                    <button className="btn btn-danger btn-sm" onClick={()=>reddet(o.id)}>✕ Reddet</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid-2">
        {/* Erken uyarı — aksiyon butonlu */}
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>🧠 Erken Uyarı Sistemi</h3>
          {!panel.kararlar?.length ? (
            <div className="empty"><div className="icon">✅</div><p>Kritik durum yok</p></div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:320,overflowY:'auto'}}>
              {panel.kararlar.map((k,i) => (
                <div key={i} className={`alert-box ${k.seviye==='KRITIK'?'red':'orange'} ${k.blink?'blink':''}`}>
                  <span>{k.seviye==='KRITIK'?'🚨':'⚠️'}</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600}}>{k.baslik}</div>
                    <div style={{fontSize:12,marginTop:2}}>{k.mesaj}</div>
                  </div>
                  {/* AKSİYON BUTONLARI */}
                  <div style={{display:'flex',gap:6,marginLeft:8}}>
                    {k.odeme_id && k.seviye==='KRITIK' && (
                      <button className="btn btn-primary btn-sm"
                        onClick={()=>aksiyonCalistir('hemen_ode', k)}>
                        Hemen Öde
                      </button>
                    )}
                    {k.odeme_id && (
                      <button className="btn btn-secondary btn-sm"
                        onClick={()=>aksiyonCalistir('odeme_ertele', k)}>
                        Ertele
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Kart risk */}
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
                      <span>{k.gun_kaldi<=0?'🔴 BUGÜN SON GÜN':`${k.gun_kaldi} gün kaldı`}</span>
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
        <div className="card">
          <h3 style={{fontSize:14,fontWeight:600,marginBottom:14}}>📊 Aylık Ciro</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[...(panel.aylik_ciro||[])].reverse()}>
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

      {/* SENARYO MOTORU */}
      <div className="card" style={{borderTop:'2px solid var(--yellow)'}}>
        <h3 style={{fontSize:14,fontWeight:600,marginBottom:12}}>🔮 Bu ödemeyi yaparsam ne olur?</h3>
        <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:12}}>
          <input type="number" placeholder="Tutar girin (₺)" value={senaryoTutar}
            onChange={e=>setSenaryoTutar(e.target.value)}
            style={{flex:1,padding:'8px 12px',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:6,color:'var(--text1)',fontSize:13}}/>
          <button className="btn btn-primary" onClick={senaryoHesapla}>Hesapla</button>
        </div>
        {senaryo && (
          <div className={`alert-box ${senaryo.risk==='KRITIK'?'red':senaryo.risk==='UYARI'?'yellow':'green'}`}>
            <span>{senaryo.risk==='KRITIK'?'🔴':senaryo.risk==='UYARI'?'🟡':'🟢'}</span>
            <div>
              <div style={{fontWeight:600}}>{senaryo.mesaj}</div>
              <div style={{fontSize:12,marginTop:4}}>Önceki: {fmt(senaryo.kasa_oncesi)} → Sonraki: {fmt(senaryo.kasa_sonrasi)}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
