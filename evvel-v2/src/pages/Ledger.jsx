import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const TUR_RENK = {
  CIRO:'green', ANLIK_GIDER:'red', KART_ODEME:'blue',
  SABIT_GIDER:'yellow', VADELI_ODEME:'yellow', CIRO_IPTAL:'red',
  ANLIK_GIDER_IPTAL:'green', BANKA_TAKSIT:'purple'
};

export default function Ledger() {
  const [rows, setRows] = useState([]);
  const [filtre, setFiltre] = useState('');
  const [kasa, setKasa] = useState(0);

  useEffect(() => {
    api('/ledger?limit=500').then(setRows);
    api('/kasa').then(d => setKasa(d.guncel_bakiye));
  }, []);

  const filtered = filtre ? rows.filter(r=>r.islem_turu===filtre) : rows;
  const turler = [...new Set(rows.map(r=>r.islem_turu))];

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>İşlem Defteri</h2>
          <p>Tüm kasa hareketleri · Güncel bakiye: <strong style={{color:'var(--green)'}}>{fmt(kasa)}</strong></p>
        </div>
      </div>

      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
        <button className={`tab-pill ${!filtre?'active':''}`} onClick={()=>setFiltre('')}>Tümü</button>
        {turler.map(t=>(
          <button key={t} className={`tab-pill ${filtre===t?'active':''}`} onClick={()=>setFiltre(t)}>{t}</button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>İşlem Türü</th><th>Açıklama</th><th style={{textAlign:'right'}}>Tutar</th></tr></thead>
          <tbody>
            {!filtered.length ? (<tr><td colSpan={4}><div className="empty"><p>Kayıt yok</p></div></td></tr>) :
            filtered.map(r=>{
              const renk = TUR_RENK[r.islem_turu]||'gray';
              const pozitif = ['CIRO','ANLIK_GIDER_IPTAL','CIRO_IPTAL'].includes(r.islem_turu) ? false : true;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{fontSize:12}}>{fmtDate(r.tarih)}</td>
                  <td><span className={`badge badge-${renk}`}>{r.islem_turu}</span></td>
                  <td style={{fontSize:12,color:'var(--text3)'}}>{r.aciklama||'---'}</td>
                  <td style={{textAlign:'right'}} className={r.islem_turu==='CIRO'?'amount-pos':'amount-neg'}>{fmt(r.tutar)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
