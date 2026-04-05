import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

export default function KartAnaliz() {
  const [kartlar, setKartlar] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/kartlar').then(d => { setKartlar(d); setLoading(false); });
  }, []);

  if (loading) return <div className="loading"><div className="spinner"/>Yükleniyor...</div>;

  const toplamBorc = kartlar.reduce((s,k)=>s+(k.guncel_borc||0),0);
  const toplamLimit = kartlar.reduce((s,k)=>s+(parseFloat(k.limit_tutar)||0),0);
  const toplamEkstre = kartlar.reduce((s,k)=>s+(k.bu_ekstre||0),0);
  const toplamTaksit = kartlar.reduce((s,k)=>s+(k.aylik_taksit||0),0);

  return (
    <div className="page">
      <div className="page-header">
        <h2>📊 Kart Analiz Motoru</h2>
        <p>Ekstre · Gelecek ekstre · Taksit yükü · Limit doluluk</p>
      </div>

      <div className="metrics">
        <div className="metric-card red"><div className="metric-label">Toplam Kart Borcu</div><div className="metric-value red">{fmt(toplamBorc)}</div><div className="metric-sub">Kart ledger</div></div>
        <div className="metric-card"><div className="metric-label">Toplam Limit</div><div className="metric-value">{fmt(toplamLimit)}</div></div>
        <div className="metric-card yellow"><div className="metric-label">Bu Dönem Ekstre</div><div className="metric-value yellow">{fmt(toplamEkstre)}</div><div className="metric-sub">Kesim gününe kadar</div></div>
        <div className="metric-card"><div className="metric-label">Aylık Taksit Yükü</div><div className="metric-value">{fmt(toplamTaksit)}</div></div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>Kart</th><th>Banka</th>
            <th style={{textAlign:'right'}}>Güncel Borç</th>
            <th style={{textAlign:'right'}}>Bu Ekstre</th>
            <th style={{textAlign:'right'}}>Gelecek Ekstre</th>
            <th style={{textAlign:'right'}}>Aylık Taksit</th>
            <th style={{textAlign:'right'}}>Asgari Ödeme</th>
            <th style={{textAlign:'right'}}>Kullanılabilir</th>
            <th>Limit Doluluk</th>
            <th>Son Ödeme</th>
          </tr></thead>
          <tbody>
            {kartlar.map(k => {
              const doluluk = k.limit_doluluk || 0;
              const risk = doluluk > 0.9 ? 'red' : doluluk > 0.7 ? 'yellow' : 'green';
              return (
                <tr key={k.id} className={k.blink ? 'blink' : ''}>
                  <td style={{fontWeight:600}}>{k.kart_adi}</td>
                  <td style={{fontSize:12,color:'var(--text3)'}}>{k.banka}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{fmt(k.guncel_borc)}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{fmt(k.bu_ekstre)}</td>
                  <td style={{textAlign:'right',color:'var(--text3)'}}>{fmt(k.gelecek_ekstre)}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{fmt(k.aylik_taksit)}</td>
                  <td style={{textAlign:'right',color:'var(--yellow)'}}>{fmt(k.asgari_odeme)}</td>
                  <td style={{textAlign:'right',color:'var(--green)'}}>{fmt(k.kalan_limit)}</td>
                  <td>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <div className="progress-bar" style={{width:80}}>
                        <div className={`progress-fill ${risk}`} style={{width:`${Math.min(100,doluluk*100)}%`}}/>
                      </div>
                      <span className={`risk-${risk}`} style={{fontSize:12}}>{(doluluk*100).toFixed(0)}%</span>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${k.gun_kaldi<=0?'badge-red':k.gun_kaldi<=3?'badge-yellow':'badge-green'}`}>
                      {k.gun_kaldi<=0?'BUGÜN':k.gun_kaldi<=3?`${k.gun_kaldi} gün`:`${k.gun_kaldi}. gün`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Kart Borç Takvimi - gelecek 6 ay */}
      <h3 style={{fontSize:14,fontWeight:600,marginBottom:12,marginTop:24}}>📅 Kart Borç Takvimi (Gelecek 6 Ay)</h3>
      <div style={{display:'flex',gap:10,overflowX:'auto',paddingBottom:8}}>
        {Array.from({length:6},(_,i)=>{
          const d = new Date();
          d.setMonth(d.getMonth()+i);
          const ay = d.toLocaleDateString('tr-TR',{month:'long',year:'numeric'});
          const toplamYuk = kartlar.reduce((s,k)=>{
            const ekstre = i===0 ? (k.bu_ekstre||0) : (k.gelecek_ekstre||0);
            const taksit = k.aylik_taksit||0;
            return s + (i===0 ? ekstre : taksit);
          },0);
          return (
            <div key={i} style={{minWidth:130,background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,padding:'12px 14px',textAlign:'center'}}>
              <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>{ay}</div>
              <div style={{fontSize:16,fontWeight:700,color:toplamYuk>500000?'var(--red)':toplamYuk>200000?'var(--yellow)':'var(--green)'}}>
                {fmt(toplamYuk)}
              </div>
              <div style={{fontSize:10,color:'var(--text3)',marginTop:2}}>{i===0?'Bu dönem ekstre':'Tahmini taksit'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
