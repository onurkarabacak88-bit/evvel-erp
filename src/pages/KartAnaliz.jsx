import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

export default function KartAnaliz() {
  const [kartlar, setKartlar] = useState([]);
  const [forecast, setForecast] = useState({}); // {kart_id: [{ay, ekstre_toplam,...}]}
  const [aylar, setAylar] = useState(6);
  const [senaryo, setSenaryo] = useState('odenir');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/kartlar').then(d => { setKartlar(d); setLoading(false); });
  }, []);

  useEffect(() => {
    api(`/kartlar/ekstre-forecast?aylar=${aylar}&senaryo=${senaryo}`)
      .then(r => setForecast(r.kartlar || {}))
      .catch(() => setForecast({}));
  }, [aylar, senaryo]);

  if (loading) return <div className="loading"><div className="spinner"/>Yükleniyor...</div>;

  const toplamBorc = kartlar.reduce((s,k)=>s+(k.guncel_borc||0),0);
  const toplamLimit = kartlar.reduce((s,k)=>s+(parseFloat(k.limit_tutar)||0),0);
  const toplamEkstre = kartlar.reduce((s,k)=>s+(k.bu_ekstre||0),0);
  const toplamTaksit = kartlar.reduce((s,k)=>s+(k.aylik_taksit||0),0);

  // Aylık takvim — forecast'in ilk kart sırasından ay etiketlerini al
  const sample = Object.values(forecast)[0] || [];
  const ayEtiketleri = sample.map(d => d.ay);

  // Her ay için tüm kartları topla
  const aylikToplam = ayEtiketleri.map((ay, i) => {
    let tek = 0, taksit = 0, anapara = 0, faiz = 0, ekstre = 0, asgari = 0;
    Object.values(forecast).forEach(donemler => {
      const d = donemler[i];
      if (!d) return;
      tek += d.tek_cekim_bilinen || 0;
      taksit += d.taksit_payi || 0;
      anapara += d.devreden_anapara || 0;
      faiz += d.devreden_faiz || 0;
      ekstre += d.ekstre_toplam || 0;
      asgari += d.asgari_tahmini || 0;
    });
    return { ay, tek, taksit, anapara, faiz, ekstre, asgari };
  });

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

      {/* Ekstre Forecast — gelecek N ay tahmini */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:24,marginBottom:12,flexWrap:'wrap',gap:8}}>
        <h3 style={{fontSize:14,fontWeight:600,margin:0}}>🔮 Ekstre Forecast — Banka Kesmeden Önce Tahmin</h3>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{fontSize:12,color:'var(--text3)'}}>Senaryo:</label>
          <select value={senaryo} onChange={e=>setSenaryo(e.target.value)} style={{padding:'4px 8px',fontSize:12}}>
            <option value="tam">Tam ödeme (faiz yok)</option>
            <option value="odenir">Asgari ödenir (akdi faiz)</option>
            <option value="odenmez">Hiç ödenmez (gecikme)</option>
          </select>
          <label style={{fontSize:12,color:'var(--text3)',marginLeft:8}}>Ay:</label>
          <select value={aylar} onChange={e=>setAylar(parseInt(e.target.value))} style={{padding:'4px 8px',fontSize:12}}>
            {[3,6,9,12].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {/* Aylık özet kartları */}
      <div style={{display:'flex',gap:10,overflowX:'auto',paddingBottom:8,marginBottom:16}}>
        {aylikToplam.map((m, i) => {
          const renk = m.ekstre > 500000 ? 'var(--red)' : m.ekstre > 200000 ? 'var(--yellow)' : 'var(--green)';
          return (
            <div key={i} style={{minWidth:170,background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:8,padding:'12px 14px'}}>
              <div style={{fontSize:11,color:'var(--text3)',marginBottom:6,textAlign:'center',fontWeight:600}}>{m.ay}</div>
              <div style={{fontSize:18,fontWeight:700,color:renk,textAlign:'center',marginBottom:8}}>{fmt(m.ekstre)}</div>
              <div style={{fontSize:10,color:'var(--text3)',display:'grid',gap:2}}>
                <div className="flex items-center justify-between"><span>Tek çekim:</span><span className="mono">{fmt(m.tek)}</span></div>
                <div className="flex items-center justify-between"><span>Taksit:</span><span className="mono">{fmt(m.taksit)}</span></div>
                <div className="flex items-center justify-between"><span>Devreden anapara:</span><span className="mono" style={{color:m.anapara>0?'var(--orange)':'inherit'}}>{fmt(m.anapara)}</span></div>
                <div className="flex items-center justify-between"><span>Faiz (KKDF/BSMV dahil):</span><span className="mono" style={{color:m.faiz>0?'var(--red)':'inherit'}}>{fmt(m.faiz)}</span></div>
                <div className="flex items-center justify-between" style={{borderTop:'1px dashed var(--border)',marginTop:4,paddingTop:4}}>
                  <span>Asgari:</span><span className="mono" style={{color:'var(--yellow)'}}>{fmt(m.asgari)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Kart başına detay tablo */}
      {ayEtiketleri.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Kart</th>
              {ayEtiketleri.map(ay => <th key={ay} style={{textAlign:'right'}}>{ay}</th>)}
            </tr></thead>
            <tbody>
              {kartlar.map(k => {
                const donemler = forecast[k.id] || [];
                return (
                  <tr key={k.id}>
                    <td style={{fontWeight:600}}>{k.kart_adi}<div style={{fontSize:10,color:'var(--text3)'}}>{k.banka}</div></td>
                    {donemler.map(d => (
                      <td key={d.ay} style={{textAlign:'right'}}
                          title={`Kesim: ${d.kesim_tarihi}\nSon Ödeme: ${d.son_odeme_tarihi}\nTek çekim: ${fmt(d.tek_cekim_bilinen)}\nTaksit: ${fmt(d.taksit_payi)}\nDevreden anapara: ${fmt(d.devreden_anapara)}\nDevreden faiz (KKDF/BSMV dahil): ${fmt(d.devreden_faiz)}\nAsgari: ${fmt(d.asgari_tahmini)}`}>
                        <div className="mono" style={{fontSize:13,color:d.ekstre_toplam>0?'var(--text)':'var(--text3)'}}>
                          {fmt(d.ekstre_toplam)}
                        </div>
                        <div style={{fontSize:9,color:'var(--text3)'}}>
                          {d.durum === 'gecmis' && '✓ kapandı'}
                          {d.durum === 'acik' && '⏳ açık'}
                          {d.durum === 'gelecek' && '🔮 tahmin'}
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{fontSize:11,color:'var(--text3)',marginTop:8,padding:'8px 12px',background:'var(--bg3)',borderRadius:6}}>
        💡 <b>Forecast nasıl çalışır:</b> Bilinen geçmiş tek çekimler + aktif taksit kalemlerinin o aya düşen payı + önceki dönemden devreden <b>anapara</b> + onun üzerinde işleyen <b>akdi/gecikme faizi (KKDF %15 + BSMV %5 dahil)</b>.
        Gelecek aylarda henüz yapılmamış tek çekimler bilinmez (0). Asgari/akdi/gecikme oranları her kartın kendi ayarından alınır.
      </div>
    </div>
  );
}
