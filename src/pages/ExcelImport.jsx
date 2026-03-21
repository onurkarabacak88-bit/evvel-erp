import { useState, useRef } from 'react';
import { api, fmt } from '../utils/api';

export default function ExcelImport() {
  const fileRef = useRef();
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [msg, setMsg] = useState(null);

  const toast = (m,t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),4000); };

  async function yukle(file) {
    if (!file) return;
    setLoading(true);
    setSonuc(null);
    const fd = new FormData();
    fd.append('dosya', file);
    try {
      const res = await fetch('/api/excel-import', { method:'POST', body:fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail||'Hata');
      setSonuc(data);
      toast(`${data.toplam} satır işlendi`, 'green');
    } catch(e) {
      toast(e.message, 'red');
    }
    setLoading(false);
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header">
        <h2>📊 Excel Import</h2>
        <p>EVVEL şablon formatında Excel dosyası yükle — veriler otomatik aktarılır</p>
      </div>

      <div style={{maxWidth:600}}>
        <div
          style={{border:`2px dashed ${drag?'var(--green)':'var(--border)'}`,borderRadius:12,padding:40,textAlign:'center',cursor:'pointer',background:drag?'rgba(76,175,132,0.05)':'var(--bg2)',transition:'all .2s'}}
          onDragOver={e=>{e.preventDefault();setDrag(true)}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)yukle(f);}}
          onClick={()=>fileRef.current?.click()}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{display:'none'}}
            onChange={e=>e.target.files[0]&&yukle(e.target.files[0])}/>
          {loading ? (
            <><div className="spinner" style={{margin:'0 auto 12px'}}/><p>Yükleniyor ve işleniyor...</p></>
          ) : (
            <>
              <div style={{fontSize:48,marginBottom:12}}>📊</div>
              <h3 style={{marginBottom:8}}>Excel Dosyası Yükle</h3>
              <p style={{color:'var(--text3)',fontSize:13}}>Sürükleyip bırakın veya tıklayın</p>
              <p style={{color:'var(--text3)',fontSize:12,marginTop:8}}>Desteklenen sekmeler: ciro · kartlar · kart_hareketleri · borclar · personel · sabit_giderler · vadeli_alimlar</p>
            </>
          )}
        </div>

        {sonuc && (
          <div className="card" style={{marginTop:20}}>
            <h3 style={{marginBottom:16,fontSize:14,fontWeight:600}}>✅ İşlem Sonucu</h3>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {Object.entries(sonuc.detay||{}).map(([tablo, bilgi]) => (
                <div key={tablo} style={{display:'flex',justifyContent:'space-between',padding:'8px 12px',background:'var(--bg3)',borderRadius:6,fontSize:13}}>
                  <span style={{fontWeight:500}}>{tablo}</span>
                  <span style={{color:bilgi.hata>0?'var(--yellow)':'var(--green)'}}>
                    ✓ {bilgi.eklenen} eklendi {bilgi.hata>0?`· ${bilgi.hata} hata`:''}
                  </span>
                </div>
              ))}
              <div style={{marginTop:8,padding:'12px',background:'rgba(76,175,132,0.1)',borderRadius:8,textAlign:'center',fontSize:14,fontWeight:600}}>
                Toplam {sonuc.toplam} satır işlendi
              </div>
            </div>
          </div>
        )}

        <div className="card" style={{marginTop:20}}>
          <h4 style={{marginBottom:12,fontSize:13,color:'var(--text2)'}}>📋 Şablon Formatı</h4>
          <div style={{display:'flex',flexDirection:'column',gap:6,fontSize:12,color:'var(--text3)'}}>
            <div>✦ <strong style={{color:'var(--text2)'}}>ciro</strong> — tarih, sube, nakit, pos, online, aciklama</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>kartlar</strong> — kart_adi, banka, limit_tutar, kesim_gunu, son_odeme_gunu, faiz_orani</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>kart_hareketleri</strong> — kart_adi, tarih, islem_turu (HARCAMA/ODEME), tutar, taksit_sayisi</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>borclar</strong> — kurum, borc_turu, toplam_borc, aylik_taksit, kalan_vade, odeme_gunu</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>personel</strong> — ad_soyad, gorev, calisma_turu, maas, yemek_ucreti, yol_ucreti, odeme_gunu, sube</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>sabit_giderler</strong> — gider_adi, kategori, tutar, periyot, odeme_gunu, sube</div>
            <div>✦ <strong style={{color:'var(--text2)'}}>vadeli_alimlar</strong> — aciklama, tutar, vade_tarihi, tedarikci</div>
          </div>
        </div>
      </div>
    </div>
  );
}
