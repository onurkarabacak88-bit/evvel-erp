import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const TUR_RENK = {
  CIRO: 'green',
  DIS_KAYNAK: 'green',
  KASA_GIRIS: 'green',
  ANLIK_GIDER: 'red',
  ANLIK_GIDER_IPTAL: 'green',
  KART_ODEME: 'blue',
  KART_FAIZ: 'red',
  SABIT_GIDER: 'yellow',
  VADELI_ODEME: 'yellow',
  PERSONEL_MAAS: 'yellow',
  POS_KESINTI: 'red',
  ONLINE_KESINTI: 'red',
  CIRO_IPTAL: 'red',
  CIRO_DUZELTME: 'yellow',
  KASA_DUZELTME: 'yellow',
  BANKA_TAKSIT: 'purple',
};

const TUR_ETIKET = {
  CIRO: 'Ciro',
  DIS_KAYNAK: 'Dış Kaynak',
  KASA_GIRIS: 'Kasa Girişi',
  ANLIK_GIDER: 'Anlık Gider',
  ANLIK_GIDER_IPTAL: 'Gider İptal',
  KART_ODEME: 'Kart Ödeme',
  KART_FAIZ: 'Kart Faiz',
  SABIT_GIDER: 'Sabit Gider',
  VADELI_ODEME: 'Vadeli Ödeme',
  PERSONEL_MAAS: 'Personel Maaş',
  POS_KESINTI: 'POS Kesinti',
  ONLINE_KESINTI: 'Online Kesinti',
  CIRO_IPTAL: 'Ciro İptal',
  CIRO_DUZELTME: 'Ciro Düzeltme',
  KASA_DUZELTME: 'Kasa Düzeltme',
  BANKA_TAKSIT: 'Banka Taksit',
};

export default function Ledger() {
  const [rows, setRows] = useState([]);
  const [filtre, setFiltre] = useState('');
  const [kasa, setKasa] = useState(0);
  const [ozet, setOzet] = useState({});
  const [sekme, setSekme] = useState('hareketler'); // 'hareketler' | 'breakdown'
  const [breakdown, setBreakdown] = useState(null);

  useEffect(() => {
    api('/ledger?limit=500').then(data => {
      if (Array.isArray(data)) { setRows(data); }
      else { setRows(data.rows || []); setOzet(data.ozet || {}); }
    });
    api('/kasa').then(d => setKasa(d.guncel_bakiye));
    api('/kasa-detay').then(setBreakdown).catch(() => {});
  }, []);

  const filtered = filtre ? rows.filter(r => r.islem_turu === filtre) : rows;
  const turler = [...new Set(rows.map(r => r.islem_turu))];

  // Toplam backend'den — limit bağımsız
  const toplamGelir = parseFloat(ozet.toplam_gelir || 0);
  const toplamGider = parseFloat(ozet.toplam_gider || 0);
  const toplamIptal = parseFloat(ozet.toplam_iptal || 0);

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>📒 İşlem Defteri</h2>
          <p>Tüm kasa hareketleri · Güncel bakiye: <strong style={{ color: 'var(--green)' }}>{fmt(kasa)}</strong></p>
        </div>
      </div>

      {/* Özet kartlar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: '🏦 Güncel Bakiye', val: kasa, renk: kasa >= 0 ? 'var(--green)' : 'var(--red)', sub: 'Gerçek kasa' },
          { label: '↑ Toplam Gelir', val: toplamGelir, renk: 'var(--green)', sub: 'Tüm zamanlar' },
          { label: '↓ Toplam Gider', val: toplamGider, renk: 'var(--red)', sub: toplamIptal > 0 ? `+${fmt(toplamIptal)} iptal ayrı` : 'Tüm zamanlar' },
          { label: toplamIptal > 0 ? '🔄 İptal Edilen' : '= Net', val: toplamIptal > 0 ? toplamIptal : toplamGelir - toplamGider, renk: 'var(--yellow)', sub: toplamIptal > 0 ? 'Gelir iptali' : 'Gelir − Gider' },
        ].map(({ label, val, renk, sub }) => (
          <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 18, color: renk }}>{fmt(val)}</div>
            <div className="metric-sub" style={{ fontSize: 10, color: 'var(--text3)' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Sekme seçici */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        <button className={`tab-pill ${sekme === 'hareketler' ? 'active' : ''}`} onClick={() => setSekme('hareketler')}>📒 Hareketler</button>
        <button className={`tab-pill ${sekme === 'breakdown' ? 'active' : ''}`} onClick={() => setSekme('breakdown')}>📊 Kasa dağılımı</button>
      </div>

      {/* HAREKETLER SEKMESİ */}
      {sekme === 'hareketler' && (<>
      {/* Filtre butonları */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className={`tab-pill ${!filtre ? 'active' : ''}`} onClick={() => setFiltre('')}>Tümü</button>
        {turler.map(t => (
          <button key={t} className={`tab-pill ${filtre === t ? 'active' : ''}`} onClick={() => setFiltre(t)}>
            {TUR_ETIKET[t] || t}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>İşlem Türü</th>
              <th>Açıklama</th>
              <th style={{ textAlign: 'right' }}>Tutar</th>
            </tr>
          </thead>
          <tbody>
            {!filtered.length ? (
              <tr><td colSpan={4}><div className="empty"><p>Kayıt yok</p></div></td></tr>
            ) : filtered.map(r => {
              const renk = TUR_RENK[r.islem_turu] || 'gray';
              const pozitif = r.tutar > 0;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.tarih)}</td>
                  <td><span className={`badge badge-${renk}`}>{TUR_ETIKET[r.islem_turu] || r.islem_turu}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{r.aciklama || '---'}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: pozitif ? 'var(--green)' : 'var(--red)' }}>
                    {pozitif ? '+' : ''}{fmt(r.tutar)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>)}

      {/* BREAKDOWN SEKMESİ */}
      {sekme === 'breakdown' && (
        <div>
          {!breakdown ? (
            <div style={{textAlign:'center',padding:40}}><div className="spinner"/></div>
          ) : (<>
            {/* Gelir / Gider özet */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:20}}>
              {[
                {
                  label: '↑ Toplam Gelir Kalemleri',
                  renk: 'var(--green)',
                  satirlar: breakdown.detay.filter(r => parseFloat(r.toplam) > 0),
                },
                {
                  label: '↓ Toplam Gider Kalemleri',
                  renk: 'var(--red)',
                  satirlar: breakdown.detay.filter(r => parseFloat(r.toplam) < 0),
                },
              ].map(({label, renk, satirlar}) => (
                <div key={label} className="card">
                  <h3 style={{fontSize:13,fontWeight:600,marginBottom:12,color:renk}}>{label}</h3>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {satirlar.length === 0
                      ? <div style={{color:'var(--text3)',fontSize:12}}>Kayıt yok</div>
                      : satirlar.map((r,i) => {
                          const toplam = Math.abs(parseFloat(r.toplam));
                          const grubToplam = satirlar.reduce((s,x) => s + Math.abs(parseFloat(x.toplam)), 0);
                          const pct = grubToplam > 0 ? Math.round(toplam / grubToplam * 100) : 0;
                          return (
                            <div key={i} style={{marginBottom:4}}>
                              <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:2}}>
                                <span style={{fontWeight:500}}>{TUR_ETIKET[r.islem_turu] || r.islem_turu}</span>
                                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                                  <span style={{color:'var(--text3)',fontSize:11}}>{r.adet} işlem · %{pct}</span>
                                  <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:renk}}>
                                    {parseInt(toplam).toLocaleString('tr-TR')} ₺
                                  </span>
                                </div>
                              </div>
                              <div style={{height:4,background:'var(--bg3)',borderRadius:2}}>
                                <div style={{height:'100%',width:`${pct}%`,background:renk,borderRadius:2,opacity:0.7}}/>
                              </div>
                            </div>
                          );
                        })
                    }
                  </div>
                </div>
              ))}
            </div>

            {/* Net kasa */}
            <div style={{
              padding:'14px 20px',borderRadius:10,
              background: parseFloat(breakdown.net_kasa) >= 0 ? 'rgba(0,200,100,0.08)' : 'rgba(220,50,50,0.08)',
              border: `1px solid ${parseFloat(breakdown.net_kasa) >= 0 ? 'rgba(0,200,100,0.2)' : 'rgba(220,50,50,0.2)'}`,
              display:'flex',justifyContent:'space-between',alignItems:'center'
            }}>
              <span style={{fontWeight:600,fontSize:14}}>Net Kasa (Ledger Toplamı)</span>
              <span style={{
                fontFamily:'var(--font-mono)',fontWeight:700,fontSize:20,
                color: parseFloat(breakdown.net_kasa) >= 0 ? 'var(--green)' : 'var(--red)'
              }}>
                {parseInt(breakdown.net_kasa).toLocaleString('tr-TR')} ₺
              </span>
            </div>
          </>)}
        </div>
      )}
    </div>
  );
}
