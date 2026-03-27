import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

export function Strateji() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const load = () => { setLoading(true); api('/strateji').then(d=>{setData(d);setLoading(false);}); };
  useEffect(()=>{load();},[]);
  const toast = (m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function tumunuUygula() {
    if (!data?.oneriler?.length) return;
    const uygulanabilir = data.oneriler.filter(o=>o.oneri_turu!=='ERTELE'&&o.odeme_id);
    let basarili = 0, hatali = 0;
    for (const o of uygulanabilir) {
      try { await api(`/odeme-plani/${o.odeme_id}/ode`, { method:'POST' }); basarili++; }
      catch(e) { hatali++; console.warn('Ödeme hatası:', o.odeme_id, e.message); }
    }
    if (hatali > 0)
      toast(`⚠️ ${basarili} onaylandı, ${hatali} başarısız`, 'yellow');
    else
      toast(`✓ ${basarili} ödeme onay kuyruğuna alındı`);
    load();
  }

  if (loading) return <div className="loading"><div className="spinner"/>Analiz ediliyor...</div>;

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>🧠 Ödeme Strateji Motoru</h2><p>Faiz + nakit + vade bazlı otomatik öneri</p></div>
        <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
      </div>

      <div className="metrics">
        <div className="metric-card"><div className="metric-label">Güncel Kasa</div><div className="metric-value green">{fmt(data?.kasa)}</div></div>
        <div className="metric-card"><div className="metric-label">Kullanılabilir</div><div className="metric-value yellow">{fmt(data?.kullanilabilir_nakit)}</div><div className="metric-sub">Zorunlu giderler ayrıldı</div></div>
        <div className="metric-card"><div className="metric-label">Zorunlu Giderler</div><div className="metric-value red">{fmt(data?.zorunlu_giderler)}</div><div className="metric-sub">Maaş + kira + taksit</div></div>
        <div className="metric-card"><div className="metric-label">Önerilen Toplam</div><div className="metric-value">{fmt(data?.toplam_oneri_tutari)}</div></div>
      </div>

      <div className="flex items-center justify-between mb-16">
        <h3 style={{fontSize:14,fontWeight:600}}>Öneriler</h3>
        {data?.oneriler?.filter(o=>o.oneri_turu!=='ERTELE').length > 0 && (
          <button className="btn btn-primary btn-sm" onClick={tumunuUygula}>✓ Tüm Önerileri Uygula</button>
        )}
      </div>

      {!data?.oneriler?.length ? (
        <div className="empty"><div className="icon">✅</div><p>Bekleyen ödeme yok</p></div>
      ) : (
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {data.oneriler.map((o,i) => {
            const renkMap = {KIRMIZI:'red',TURUNCU:'orange',SARI:'yellow',GRI:'gray'};
            const r = renkMap[o.renk]||'yellow';
            return (
              <div key={i} className={`alert-box ${r} ${o.blink?'blink':''}`}
                style={{justifyContent:'space-between',alignItems:'center'}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:600}}>{o.baslik}</div>
                  <div style={{fontSize:12,marginTop:2}}>{o.aciklama}</div>
                </div>
                <div style={{textAlign:'right',marginLeft:16}}>
                  {o.tavsiye_tutar > 0 && (
                    <div className="mono" style={{fontWeight:700,fontSize:15}}>{fmt(o.tavsiye_tutar)}</div>
                  )}
                  {o.odeme_id && o.oneri_turu !== 'ERTELE' && (
                    <button className="btn btn-primary btn-sm" style={{marginTop:4}}
                      onClick={async()=>{
                        try { await api(`/odeme-plani/${o.odeme_id}/ode`,{method:'POST'}); toast('Ödeme onaylandı'); load(); }
                        catch(e){toast(e.message,'red');}
                      }}>Öde</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// OnayKuyrugu.jsx
export function OnayKuyrugu() {
  const [liste, setListe] = useState([]);
  const [msg, setMsg] = useState(null);
  const load = () => api('/onay-kuyrugu').then(setListe);
  useEffect(()=>{load();},[]);
  const toast = (m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function onayla(id) {
    try { await api(`/onay-kuyrugu/${id}/onayla`,{method:'POST'}); toast('Onaylandı, kasadan düşüldü'); load(); }
    catch(e){toast(e.message,'red');}
  }
  async function reddet(id) {
    try { await api(`/onay-kuyrugu/${id}/reddet`,{method:'POST'}); toast('Reddedildi','yellow'); load(); }
    catch(e){toast(e.message,'red');}
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header"><h2>✅ Onay Kuyruğu</h2><p>{liste.length} bekleyen işlem</p></div>
      {!liste.length ? (
        <div className="empty"><div className="icon">✅</div><p>Bekleyen onay yok</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>İşlem Türü</th><th>Açıklama</th><th style={{textAlign:'right'}}>Tutar</th><th>Tarih</th><th></th></tr></thead>
            <tbody>
              {liste.map(o=>(
                <tr key={o.id}>
                  <td><span className="badge badge-yellow">{o.islem_turu}</span></td>
                  <td>{o.aciklama}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{o.tutar ? `${parseInt(o.tutar).toLocaleString('tr-TR')} ₺` : '---'}</td>
                  <td className="mono" style={{fontSize:12}}>{o.tarih}</td>
                  <td>
                    <div className="flex gap-8">
                      <button className="btn btn-primary btn-sm" onClick={()=>onayla(o.id)}>✓ Onayla</button>
                      <button className="btn btn-danger btn-sm" onClick={()=>reddet(o.id)}>✕ Reddet</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Borclar.jsx
export function Borclar() {
  const [liste, setListe] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({kurum:'',borc_turu:'Kredi',toplam_borc:'',aylik_taksit:'',kalan_vade:'',toplam_vade:'',baslangic_tarihi:'',odeme_gunu:1});
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = ()=>api('/borclar').then(setListe);
  useEffect(()=>{load();},[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function kaydet(){
    try{
      if(duzenleId) await api(`/borclar/${duzenleId}`,{method:'PUT',body:form});
      else await api('/borclar',{method:'POST',body:form});
      toast('Kaydedildi'); setShowModal(false); setDuzenleId(null); load();
    }catch(e){toast(e.message,'red');}
  }
  async function sil(id){
    if(!confirm('Pasife al?'))return;
    try{await api(`/borclar/${id}`,{method:'DELETE'}); toast('Pasife alındı'); load();}
    catch(e){toast(e.message,'red');}
  }

  const aktifler = liste.filter(b=>b.aktif);
  const toplamTaksit = aktifler.reduce((s,b)=>s+(parseFloat(b.aylik_taksit)||0),0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Borç Envanteri</h2><p>Aylık taksit: {parseInt(toplamTaksit).toLocaleString('tr-TR')} ₺</p></div>
        <button className="btn btn-primary" onClick={()=>{setForm({kurum:'',borc_turu:'Kredi',toplam_borc:'',aylik_taksit:'',kalan_vade:'',toplam_vade:'',baslangic_tarihi:'',odeme_gunu:1});setDuzenleId(null);setShowModal(true);}}>+ Borç Ekle</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Kurum</th><th>Tür</th><th style={{textAlign:'right'}}>Aylık Taksit</th><th>Vade</th><th>Ödeme Günü</th><th>Durum</th><th></th></tr></thead>
          <tbody>
            {liste.map(b=>(
              <tr key={b.id}>
                <td style={{fontWeight:500}}>{b.kurum}</td>
                <td><span className="badge badge-blue">{b.borc_turu}</span></td>
                <td style={{textAlign:'right'}} className="amount-neg">{parseInt(b.aylik_taksit).toLocaleString('tr-TR')} ₺</td>
                <td style={{fontSize:12}}>{b.kalan_vade||'?'} / {b.toplam_vade||'?'} ay</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>Her ayın {b.odeme_gunu}. günü</td>
                <td><span className={`badge ${b.aktif?'badge-green':'badge-gray'}`}>{b.aktif?'Aktif':'Kapandı'}</span></td>
                <td>
                  <div className="flex gap-8">
                    <button className="btn btn-ghost btn-sm" onClick={()=>{setForm({kurum:b.kurum,borc_turu:b.borc_turu,toplam_borc:b.toplam_borc,aylik_taksit:b.aylik_taksit,kalan_vade:b.kalan_vade,toplam_vade:b.toplam_vade,baslangic_tarihi:b.baslangic_tarihi?.slice(0,10)||'',odeme_gunu:b.odeme_gunu});setDuzenleId(b.id);setShowModal(true);}}>✏️</button>
                    <button className="btn btn-danger btn-sm" onClick={()=>sil(b.id)}>Kapat</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>{duzenleId?'Borç Düzenle':'Yeni Borç'}</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group"><label>Kurum *</label><input value={form.kurum} onChange={e=>setForm({...form,kurum:e.target.value})}/></div>
                <div className="form-group"><label>Tür</label><select value={form.borc_turu} onChange={e=>setForm({...form,borc_turu:e.target.value})}><option>Kredi</option><option>Mortgage</option><option>İşletme Kredisi</option><option>Diğer</option></select></div>
                <div className="form-group"><label>Toplam Borç (₺)</label><input type="number" value={form.toplam_borc} onChange={e=>setForm({...form,toplam_borc:e.target.value})}/></div>
                <div className="form-group"><label>Aylık Taksit (₺) *</label><input type="number" value={form.aylik_taksit} onChange={e=>setForm({...form,aylik_taksit:e.target.value})}/></div>
                <div className="form-group"><label>Kalan Vade (Ay)</label><input type="number" value={form.kalan_vade} onChange={e=>setForm({...form,kalan_vade:e.target.value})}/></div>
                <div className="form-group"><label>Ödeme Günü</label><input type="number" min={1} max={31} value={form.odeme_gunu} onChange={e=>setForm({...form,odeme_gunu:e.target.value})}/></div>
                <div className="form-group"><label>Başlangıç Tarihi</label><input type="date" value={form.baslangic_tarihi} onChange={e=>setForm({...form,baslangic_tarihi:e.target.value})}/></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.kurum||!form.aylik_taksit}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// SabitGiderler.jsx
export function SabitGiderler() {
  const [liste, setListe] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({gider_adi:'',kategori:'Kira',tutar:'',periyot:'aylik',odeme_gunu:1,baslangic_tarihi:'',sube_id:'',gecerlilik_tarihi:'',sozlesme_sure_ay:'',kira_artis_periyot:''});
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [sekme, setSekme] = useState('tanimli');
  const [odemeler, setOdemeler] = useState({odenenler:[],bekleyenler:[],ozet:{}});
  const [hatalar, setHatalar] = useState({});
  const ZORUNLU_KATEGORILER = ['Kira', 'Personel'];

  const load=()=>{
    api('/sabit-giderler').then(setListe);
    api('/subeler').then(setSubeler);
    api('/sabit-giderler/odemeler').then(setOdemeler);
  };
  useEffect(()=>{
    load();
    // Panel'den yönlendirme ile gelindiyse ilgili kaydı direkt düzenleme modunda aç
    const hedefId = sessionStorage.getItem('sabit_gider_duzenle');
    if(hedefId){
      sessionStorage.removeItem('sabit_gider_duzenle');
      // Veri yüklenince ilgili kaydı bul ve modalı aç
      api('/sabit-giderler').then(data=>{
        const g = data.find(x=>x.id===hedefId);
        if(g){
          setForm({gider_adi:g.gider_adi,kategori:g.kategori,tutar:g.tutar,periyot:g.periyot,
            odeme_gunu:g.odeme_gunu,baslangic_tarihi:g.baslangic_tarihi?.slice(0,10)||'',
            sube_id:g.sube_id||'',gecerlilik_tarihi:'',sozlesme_sure_ay:g.sozlesme_sure_ay||'',
            kira_artis_periyot:g.kira_artis_periyot||''});
          setDuzenleId(g.id);
          setHatalar({});
          setShowModal(true);
        }
      });
    }
  },[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  function validateForm(){
    const yeniHatalar = {};
    const zorunlu = ZORUNLU_KATEGORILER.includes(form.kategori);
    if(!form.gider_adi) yeniHatalar.gider_adi = 'Zorunlu';
    if(!form.tutar) yeniHatalar.tutar = 'Zorunlu';
    if(zorunlu && !form.odeme_gunu) yeniHatalar.odeme_gunu = 'Zorunlu';
    if(zorunlu && !form.baslangic_tarihi && !duzenleId) yeniHatalar.baslangic_tarihi = 'Zorunlu';
    if(zorunlu && !form.sube_id) yeniHatalar.sube_id = 'Şube seçimi zorunlu';
    if(duzenleId && zorunlu && !form.gecerlilik_tarihi) yeniHatalar.gecerlilik_tarihi = 'Hangi aydan itibaren geçerli?';
    setHatalar(yeniHatalar);
    return Object.keys(yeniHatalar).length === 0;
  }

  async function kaydet(){
    if(!validateForm()) return;
    try{
      if(duzenleId) await api(`/sabit-giderler/${duzenleId}`,{method:'PUT',body:form});
      else await api('/sabit-giderler',{method:'POST',body:{...form, sube_id: form.sube_id||null}});
      toast('Kaydedildi'); setShowModal(false); setDuzenleId(null); setHatalar({}); load();
    }catch(e){toast(e.message,'red');}
  }
  async function sil(id){
    if(!confirm('Pasife al?'))return;
    try{await api(`/sabit-giderler/${id}`,{method:'DELETE'}); toast('Pasife alındı'); load();}
    catch(e){toast(e.message,'red');}
  }

  const toplamAylik = liste.filter(g=>g.aktif&&g.periyot==='aylik').reduce((s,g)=>s+(parseFloat(g.tutar)||0),0);
  const fmt = v => parseInt(v||0).toLocaleString('tr-TR');
  const ozet = odemeler.ozet || {};

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Sabit Giderler</h2><p>Aylık toplam: {fmt(toplamAylik)} ₺</p></div>
        <button className="btn btn-primary" onClick={()=>{setForm({gider_adi:'',kategori:'Kira',tutar:'',periyot:'aylik',odeme_gunu:1,baslangic_tarihi:'',sube_id:'',sozlesme_sure_ay:'',kira_artis_periyot:''});setDuzenleId(null);setShowModal(true);}}>+ Gider Ekle</button>
      </div>

      {/* Özet Kartlar */}
      <div className="flex gap-16 mb-16" style={{flexWrap:'wrap'}}>
        <div className="stat-card" style={{flex:1,minWidth:160}}>
          <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>ÖDENEN</div>
          <div style={{fontSize:20,fontWeight:700,color:'var(--green)'}}>{fmt(ozet.toplam_odenen)} ₺</div>
        </div>
        <div className="stat-card" style={{flex:1,minWidth:160}}>
          <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>BEKLEYEN</div>
          <div style={{fontSize:20,fontWeight:700,color:'var(--yellow)'}}>{fmt(ozet.toplam_bekleyen)} ₺</div>
        </div>
        <div className="stat-card" style={{flex:1,minWidth:160}}>
          <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>GECİKEN</div>
          <div style={{fontSize:20,fontWeight:700,color:'var(--red)'}}>{ozet.geciken_adet||0} adet / {fmt(ozet.geciken_tutar)} ₺</div>
        </div>
      </div>

      {/* Sekmeler */}
      <div className="flex gap-8 mb-16">
        <button className={`btn ${sekme==='tanimli'?'btn-primary':'btn-ghost'}`} onClick={()=>setSekme('tanimli')}>Tanımlı Giderler</button>
        <button className={`btn ${sekme==='odenenler'?'btn-primary':'btn-ghost'}`} onClick={()=>setSekme('odenenler')}>Ödenmiş Giderler</button>
        <button className={`btn ${sekme==='bekleyenler'?'btn-primary':'btn-ghost'}`} onClick={()=>setSekme('bekleyenler')}>Bekleyen / Geciken</button>
      </div>

      {/* Tanımlı Giderler Tablosu — orijinal */}
      {sekme==='tanimli' && <div className="table-wrap">
        <table>
          <thead><tr><th>Gider Adı</th><th>Kategori</th><th style={{textAlign:'right'}}>Tutar</th><th>Periyot</th><th>Ödeme Günü</th><th>Artış Periyodu</th><th>Şube</th><th>Durum</th><th></th></tr></thead>
          <tbody>
            {liste.map(g=>(
              <tr key={g.id}>
                <td style={{fontWeight:500}}>{g.gider_adi}</td>
                <td><span className="badge badge-gray">{g.kategori}</span></td>
                <td style={{textAlign:'right'}} className="amount-neg">{parseInt(g.tutar).toLocaleString('tr-TR')} ₺</td>
                <td style={{fontSize:12}}>{g.periyot}</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>Her ayın {g.odeme_gunu}. günü</td>
                <td style={{fontSize:12,color:'var(--yellow)'}}>
                  {({'6ay':'6 Ay','1yil':'1 Yıl','2yil':'2 Yıl','5yil':'5 Yıl'})[g.kira_artis_periyot]||'—'}
                </td>
                <td style={{fontSize:12}}>{g.sube_adi||'---'}</td>
                <td><span className={`badge ${g.aktif?'badge-green':'badge-gray'}`}>{g.aktif?'Aktif':'Pasif'}</span></td>
                <td>
                  <div className="flex gap-8">
                    <button className="btn btn-ghost btn-sm" onClick={()=>{setForm({gider_adi:g.gider_adi,kategori:g.kategori,tutar:g.tutar,periyot:g.periyot,odeme_gunu:g.odeme_gunu,baslangic_tarihi:g.baslangic_tarihi?.slice(0,10)||'',sube_id:g.sube_id||'',gecerlilik_tarihi:'',sozlesme_sure_ay:g.sozlesme_sure_ay||'',kira_artis_periyot:g.kira_artis_periyot||''});setDuzenleId(g.id);setHatalar({});setShowModal(true);}}>✏️</button>
                    <button className="btn btn-danger btn-sm" onClick={()=>sil(g.id)}>Kapat</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}

      {/* Ödenmiş Giderler */}
      {sekme==='odenenler' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tarih</th><th>Gider Adı</th><th>Kategori</th><th style={{textAlign:'right'}}>Tutar</th><th>Durum</th></tr></thead>
            <tbody>
              {(odemeler.odenenler||[]).map((r,i)=>(
                <tr key={i}>
                  <td style={{fontSize:12}}>{r.tarih?.slice(0,10)}</td>
                  <td style={{fontWeight:500}}>{r.gider_adi||r.aciklama}</td>
                  <td><span className="badge badge-gray">{r.kategori||'—'}</span></td>
                  <td style={{textAlign:'right'}} className="amount-neg">{parseInt(r.tutar||0).toLocaleString('tr-TR')} ₺</td>
                  <td><span className="badge badge-green">✓ Ödendi</span></td>
                </tr>
              ))}
              {(odemeler.odenenler||[]).length===0 && <tr><td colSpan={5} style={{textAlign:'center',color:'var(--text3)',padding:24}}>Henüz ödeme yok</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Bekleyen / Geciken */}
      {sekme==='bekleyenler' && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vade</th><th>Gider Adı</th><th>Kategori</th><th style={{textAlign:'right'}}>Tutar</th><th>Durum</th></tr></thead>
            <tbody>
              {(odemeler.bekleyenler||[]).map((r,i)=>(
                <tr key={i}>
                  <td style={{fontSize:12,color:r.durum==='gecikti'?'var(--red)':'inherit'}}>{r.tarih?.slice(0,10)}</td>
                  <td style={{fontWeight:500}}>{r.gider_adi||r.aciklama}</td>
                  <td><span className="badge badge-gray">{r.kategori||'—'}</span></td>
                  <td style={{textAlign:'right'}} className="amount-neg">{parseInt(r.tutar||0).toLocaleString('tr-TR')} ₺</td>
                  <td><span className={`badge ${r.durum==='gecikti'?'badge-red':'badge-yellow'}`}>{r.durum==='gecikti'?'⚠ Gecikti':'⏳ Bekliyor'}</span></td>
                </tr>
              ))}
              {(odemeler.bekleyenler||[]).length===0 && <tr><td colSpan={5} style={{textAlign:'center',color:'var(--text3)',padding:24}}>Bekleyen ödeme yok</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>{duzenleId?'Düzenle':'Yeni Sabit Gider'}</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Gider Adı *</label>
                  <input value={form.gider_adi} onChange={e=>setForm({...form,gider_adi:e.target.value})} style={{borderColor:hatalar.gider_adi?'var(--red)':''}}/>
                  {hatalar.gider_adi && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.gider_adi}</span>}
                </div>
                <div className="form-group">
                  <label>Kategori</label>
                  <select value={form.kategori} onChange={e=>setForm({...form,kategori:e.target.value,hatalar:{}})}>
                    <option>Kira</option><option>Personel</option><option>Fatura</option><option>Abonelik</option><option>Ulaşım</option><option>Diğer</option>
                  </select>
                  {ZORUNLU_KATEGORILER.includes(form.kategori) && <span style={{fontSize:10,color:'var(--yellow)'}}>⚠ Tüm alanlar zorunlu</span>}
                </div>
                <div className="form-group">
                  <label>Tutar (₺) *</label>
                  <input type="number" value={form.tutar} onChange={e=>setForm({...form,tutar:e.target.value})} style={{borderColor:hatalar.tutar?'var(--red)':''}}/>
                  {hatalar.tutar && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.tutar}</span>}
                </div>
                <div className="form-group">
                  <label>Periyot</label>
                  <select value={form.periyot} onChange={e=>setForm({...form,periyot:e.target.value})}>
                    <option value="aylik">Aylık</option><option value="yillik">Yıllık</option><option value="haftalik">Haftalık</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Ödeme Günü {ZORUNLU_KATEGORILER.includes(form.kategori)?'*':''}</label>
                  <input type="number" min={1} max={31} value={form.odeme_gunu} onChange={e=>setForm({...form,odeme_gunu:e.target.value})} style={{borderColor:hatalar.odeme_gunu?'var(--red)':''}}/>
                  {hatalar.odeme_gunu && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.odeme_gunu}</span>}
                </div>
                <div className="form-group">
                  <label>Şube {ZORUNLU_KATEGORILER.includes(form.kategori)?'*':''}</label>
                  <select value={form.sube_id} onChange={e=>setForm({...form,sube_id:e.target.value})} style={{borderColor:hatalar.sube_id?'var(--red)':''}}>
                    <option value="">Seçin...</option>{subeler.map(s=><option key={s.id} value={s.id}>{s.ad}</option>)}
                  </select>
                  {hatalar.sube_id && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.sube_id}</span>}
                </div>
                {!duzenleId && (
                  <div className="form-group">
                    <label>Başlangıç Tarihi {ZORUNLU_KATEGORILER.includes(form.kategori)?'*':''}</label>
                    <input type="date" value={form.baslangic_tarihi} onChange={e=>setForm({...form,baslangic_tarihi:e.target.value})} style={{borderColor:hatalar.baslangic_tarihi?'var(--red)':''}}/>
                    {hatalar.baslangic_tarihi && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.baslangic_tarihi}</span>}
                  </div>
                )}
                {duzenleId && ZORUNLU_KATEGORILER.includes(form.kategori) && (
                  <div className="form-group" style={{gridColumn:'1/-1',background:'rgba(255,200,0,0.08)',padding:'12px',borderRadius:8,border:'1px solid var(--yellow)'}}>
                    <label>📅 Hangi Aydan İtibaren Geçerli? *</label>
                    <input type="date" value={form.gecerlilik_tarihi} onChange={e=>setForm({...form,gecerlilik_tarihi:e.target.value})} style={{borderColor:hatalar.gecerlilik_tarihi?'var(--red)':''}}/>
                    {hatalar.gecerlilik_tarihi && <span style={{color:'var(--red)',fontSize:11}}>{hatalar.gecerlilik_tarihi}</span>}
                    <p style={{fontSize:11,color:'var(--text3)',marginTop:4}}>Eski kayıt kapatılır, bu tarihten itibaren yeni tutar geçerli olur.</p>
                  </div>
                )}
                {['Kira','Abonelik'].includes(form.kategori) && (
                  <>
                    <div className="form-group">
                      <label>📋 Sözleşme Süresi (Ay)</label>
                      <input type="number" min={1} max={120} placeholder="ör. 12" value={form.sozlesme_sure_ay} onChange={e=>setForm({...form,sozlesme_sure_ay:e.target.value})}/>
                      {form.baslangic_tarihi && form.sozlesme_sure_ay && (
                        <span style={{fontSize:11,color:'var(--text3)'}}>
                          Bitiş: {new Date(new Date(form.baslangic_tarihi||form.gecerlilik_tarihi).setMonth(new Date(form.baslangic_tarihi||form.gecerlilik_tarihi).getMonth()+parseInt(form.sozlesme_sure_ay))).toLocaleDateString('tr-TR')}
                        </span>
                      )}
                    </div>
                    <div className="form-group">
                      <label>📈 Kira Artış Periyodu</label>
                      <select value={form.kira_artis_periyot} onChange={e=>setForm({...form,kira_artis_periyot:e.target.value})}>
                        <option value="">Seçin (opsiyonel)</option>
                        <option value="6ay">6 Aylık</option>
                        <option value="1yil">Yıllık</option>
                        <option value="2yil">2 Yıllık</option>
                        <option value="5yil">5 Yıllık</option>
                      </select>
                      {form.kira_artis_periyot && (form.baslangic_tarihi||form.gecerlilik_tarihi) && (()=>{
                        const base = form.gecerlilik_tarihi||form.baslangic_tarihi;
                        const ayMap = {'6ay':6,'1yil':12,'2yil':24,'5yil':60};
                        const ay = ayMap[form.kira_artis_periyot];
                        if(!ay) return null;
                        const d = new Date(base);
                        d.setMonth(d.getMonth()+ay);
                        return <span style={{fontSize:11,color:'var(--yellow)'}}>⏰ Sonraki artış: {d.toLocaleDateString('tr-TR')} — 15 gün öncesinde uyarı gelir</span>;
                      })()}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.gider_adi||!form.tutar}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// VadeliAlimlar.jsx
export function VadeliAlimlar() {
  const [liste, setListe] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({aciklama:'',tutar:'',vade_tarihi:'',tedarikci:''});
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [dupUyari, setDupUyari] = useState(null);

  const load=()=>api('/vadeli-alimlar').then(setListe);
  useEffect(()=>{load();},[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function kaydet(force=false){
    setDupUyari(null);
    try{
      if(duzenleId){
        await api(`/vadeli-alimlar/${duzenleId}`,{method:'PUT',body:form});
      } else {
        const res = await api('/vadeli-alimlar',{method:'POST',body:{...form,force}});
        if(res.warning){setDupUyari(res.mesaj);return;}
      }
      toast('Kaydedildi'); setShowModal(false); setDuzenleId(null); load();
    }catch(e){toast(e.message,'red');}
  }
  async function sil(id){
    if(!confirm('İptal et?'))return;
    try{await api(`/vadeli-alimlar/${id}`,{method:'DELETE'}); toast('İptal edildi'); load();}
    catch(e){toast(e.message,'red');}
  }
  async function ode(id){
    try{await api(`/vadeli-alimlar/${id}/ode`,{method:'POST'}); toast('Ödendi, kasadan düşüldü'); load();}
    catch(e){toast(e.message,'red');}
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Vadeli Alımlar</h2><p>7 gün içinde yaklaşanlar panel'de gösterilir</p></div>
        <button className="btn btn-primary" onClick={()=>{setForm({aciklama:'',tutar:'',vade_tarihi:'',tedarikci:''});setDuzenleId(null);setShowModal(true);}}>+ Vadeli Alım Ekle</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Açıklama</th><th>Tedarikçi</th><th style={{textAlign:'right'}}>Tutar</th><th>Vade Tarihi</th><th>Kalan</th><th></th></tr></thead>
          <tbody>
            {!liste.length?(<tr><td colSpan={6}><div className="empty"><p>Vadeli alım yok</p></div></td></tr>):
            liste.map(v=>{
              const gun = v.gun_kaldi;
              const renk = gun <= 0 ? 'red' : gun <= 3 ? 'yellow' : gun <= 7 ? 'orange' : '';
              return (
                <tr key={v.id}>
                  <td style={{fontWeight:500}} className={renk?`risk-${renk==='orange'?'mid':'high'}`:''}>{v.aciklama}</td>
                  <td style={{fontSize:12,color:'var(--text3)'}}>{v.tedarikci||'---'}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{parseInt(v.tutar).toLocaleString('tr-TR')} ₺</td>
                  <td className="mono" style={{fontSize:12}}>{v.vade_tarihi}</td>
                  <td><span className={`badge ${gun<=0?'badge-red':gun<=7?'badge-yellow':'badge-gray'}`}>{gun<=0?'BUGÜN':gun+' gün'}</span></td>
                  <td>
                    <div className="flex gap-8">
                      <button className="btn btn-primary btn-sm" onClick={()=>ode(v.id)}>Ödendi</button>
                      <button className="btn btn-ghost btn-sm" onClick={()=>{setForm({aciklama:v.aciklama,tutar:v.tutar,vade_tarihi:v.vade_tarihi,tedarikci:v.tedarikci||''});setDuzenleId(v.id);setShowModal(true);}}>✏️</button>
                      <button className="btn btn-danger btn-sm" onClick={()=>sil(v.id)}>✕</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>{duzenleId?'Düzenle':'Vadeli Alım Ekle'}</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{gridColumn:'1/-1'}}><label>Açıklama *</label><input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})}/></div>
                <div className="form-group"><label>Tutar (₺) *</label><input type="number" value={form.tutar} onChange={e=>setForm({...form,tutar:e.target.value})}/></div>
                <div className="form-group"><label>Vade Tarihi *</label><input type="date" value={form.vade_tarihi} onChange={e=>setForm({...form,vade_tarihi:e.target.value})}/></div>
                <div className="form-group"><label>Tedarikçi</label><input value={form.tedarikci} onChange={e=>setForm({...form,tedarikci:e.target.value})}/></div>
              </div>
            </div>
            {dupUyari && (
              <div className="alert-box red" style={{margin:'0 12px 12px'}}>
                <strong>⚠️ Benzer kayıt var!</strong> {dupUyari}
                <div style={{marginTop:8,display:'flex',gap:8}}>
                  <button className="btn btn-danger btn-sm" onClick={()=>kaydet(true)}>Yine de Kaydet</button>
                  <button className="btn btn-secondary btn-sm" onClick={()=>setDupUyari(null)}>Vazgeç</button>
                </div>
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={()=>kaydet(false)} disabled={!form.aciklama||!form.tutar||!form.vade_tarihi}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// KartHareketleri.jsx
export function KartHareketleri() {
  const [hareketler, setHareketler] = useState([]);
  const [kartlar, setKartlar] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({kart_id:'',tarih:new Date().toISOString().split('T')[0],islem_turu:'HARCAMA',tutar:'',taksit_sayisi:1,aciklama:''});
  const [msg, setMsg] = useState(null);

  const load=()=>{api('/kart-hareketleri').then(setHareketler);api('/kartlar').then(setKartlar);};
  useEffect(()=>{load();},[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function kaydet(){
    try{
      await api('/kart-hareketleri',{method:'POST',body:form});
      toast(form.islem_turu==='ODEME'?'Ödeme onay kuyruğuna alındı':'Harcama kaydedildi');
      setShowModal(false); load();
    }catch(e){toast(e.message,'red');}
  }
  async function iptal(id){
    if(!confirm('Bu kaydı iptal et?'))return;
    try{await api(`/kart-hareketleri/${id}`,{method:'DELETE'}); toast('İptal edildi'); load();}
    catch(e){toast(e.message,'red');}
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Kart Hareketleri</h2><p>❗ Harcama kasayı etkilemez · Ödeme onay bekler</p></div>
        <button className="btn btn-primary" onClick={()=>setShowModal(true)}>+ Hareket Ekle</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>Kart</th><th>İşlem</th><th style={{textAlign:'right'}}>Tutar</th><th>Taksit</th><th>Açıklama</th><th></th></tr></thead>
          <tbody>
            {!hareketler.length?(<tr><td colSpan={7}><div className="empty"><p>Hareket yok</p></div></td></tr>):
            hareketler.map(h=>(
              <tr key={h.id}>
                <td className="mono" style={{fontSize:12}}>{h.tarih}</td>
                <td style={{fontSize:12}}>{h.kart_adi}</td>
                <td><span className={`badge ${h.islem_turu==='HARCAMA'?'badge-yellow':'badge-blue'}`}>{h.islem_turu}</span></td>
                <td style={{textAlign:'right'}} className={h.islem_turu==='HARCAMA'?'amount-neg':'amount-pos'}>{parseInt(h.tutar).toLocaleString('tr-TR')} ₺</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>{h.taksit_sayisi>1?`${h.taksit_sayisi} taksit`:'Tek çekim'}</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>{h.aciklama||'---'}</td>
                <td><button className="btn btn-danger btn-sm" onClick={()=>iptal(h.id)}>İptal</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Kart Hareketi Ekle</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="alert-box yellow mb-16" style={{marginBottom:14}}>
                ❗ HARCAMA kasayı etkilemez. ÖDEME onay kuyruğuna gider.
              </div>
              <div className="form-row cols-2">
                <div className="form-group"><label>Kart *</label><select value={form.kart_id} onChange={e=>setForm({...form,kart_id:e.target.value})}><option value="">Kart seçin</option>{kartlar.map(k=><option key={k.id} value={k.id}>{k.kart_adi}</option>)}</select></div>
                <div className="form-group"><label>İşlem Türü</label><select value={form.islem_turu} onChange={e=>setForm({...form,islem_turu:e.target.value})}><option value="HARCAMA">HARCAMA</option><option value="ODEME">ÖDEME</option></select></div>
                <div className="form-group"><label>Tutar (₺) *</label><input type="number" value={form.tutar} onChange={e=>setForm({...form,tutar:e.target.value})}/></div>
                <div className="form-group"><label>Tarih</label><input type="date" value={form.tarih} onChange={e=>setForm({...form,tarih:e.target.value})}/></div>
                {form.islem_turu==='HARCAMA'&&<div className="form-group"><label>Taksit Sayısı</label><input type="number" min={1} value={form.taksit_sayisi} onChange={e=>setForm({...form,taksit_sayisi:e.target.value})}/></div>}
                <div className="form-group" style={{gridColumn:'1/-1'}}><label>Açıklama</label><input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})}/></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.kart_id||!form.tutar}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Ciro.jsx
export function Ciro() {
  const [liste, setListe] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({tarih:new Date().toISOString().split('T')[0],sube_id:'',nakit:0,pos:0,online:0,aciklama:''});
  const [msg, setMsg] = useState(null);
  const [dupUyari, setDupUyari] = useState(null);

  const load=()=>{api('/ciro').then(setListe);api('/subeler').then(setSubeler);};
  useEffect(()=>{load();},[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function kaydet(force=false){
    setDupUyari(null);
    try{
      const res = await api('/ciro',{method:'POST',body:{...form,force}});
      if(res.warning){setDupUyari(res.mesaj);return;}
      toast('Ciro kaydedildi, kasaya eklendi'); setShowModal(false); load();
    }catch(e){toast(e.message,'red');}
  }
  async function sil(id){
    if(!confirm('Ciro girişini iptal et? Kasadan geri iade edilecek.'))return;
    try{
      await api(`/ciro/${id}`,{method:'DELETE'});
      toast('İptal edildi, kasaya iade edildi','yellow');
      setListe(prev => prev.filter(c => c.id !== id));
      load();
    }
    catch(e){ toast(e.message||'Bir hata oluştu','red'); }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Ciro Girişi</h2><p>Ciro girildiğinde otomatik merkez kasaya eklenir</p></div>
        <button className="btn btn-primary" onClick={()=>setShowModal(true)}>+ Ciro Gir</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>Şube</th><th style={{textAlign:'right'}}>Nakit</th><th style={{textAlign:'right'}}>POS</th><th style={{textAlign:'right'}}>Online</th><th style={{textAlign:'right'}}>Toplam</th><th></th></tr></thead>
          <tbody>
            {!liste.length?(<tr><td colSpan={7}><div className="empty"><p>Ciro kaydı yok</p></div></td></tr>):
            liste.map(c=>(
              <tr key={c.id}>
                <td className="mono" style={{fontSize:12}}>{c.tarih}</td>
                <td><span className="badge badge-blue">{c.sube_adi||'---'}</span></td>
                <td style={{textAlign:'right'}} className="mono">{parseInt(c.nakit).toLocaleString('tr-TR')} ₺</td>
                <td style={{textAlign:'right'}} className="mono">{parseInt(c.pos).toLocaleString('tr-TR')} ₺</td>
                <td style={{textAlign:'right'}} className="mono">{parseInt(c.online).toLocaleString('tr-TR')} ₺</td>
                <td style={{textAlign:'right'}} className="amount-pos">{parseInt(c.toplam).toLocaleString('tr-TR')} ₺</td>
                <td><button className="btn btn-danger btn-sm" onClick={()=>sil(c.id)}>İptal</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Ciro Gir</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group"><label>Tarih</label><input type="date" value={form.tarih} onChange={e=>setForm({...form,tarih:e.target.value})}/></div>
                <div className="form-group"><label>Şube *</label><select value={form.sube_id} onChange={e=>setForm({...form,sube_id:e.target.value})}><option value="">Seçin</option>{subeler.map(s=><option key={s.id} value={s.id}>{s.ad}</option>)}</select></div>
                <div className="form-group"><label>Nakit (₺)</label><input type="number" value={form.nakit} onChange={e=>setForm({...form,nakit:e.target.value})}/></div>
                <div className="form-group"><label>POS (₺)</label><input type="number" value={form.pos} onChange={e=>setForm({...form,pos:e.target.value})}/></div>
                <div className="form-group"><label>Online (₺)</label><input type="number" value={form.online} onChange={e=>setForm({...form,online:e.target.value})}/></div>
                <div className="form-group"><label>Açıklama</label><input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})}/></div>
              </div>
            </div>
            {dupUyari && (
              <div className="alert-box red" style={{margin:'0 12px 12px'}}>
                <strong>⚠️ Benzer kayıt var!</strong> {dupUyari}
                <div style={{marginTop:8,display:'flex',gap:8}}>
                  <button className="btn btn-danger btn-sm" onClick={()=>kaydet(true)}>Yine de Kaydet</button>
                  <button className="btn btn-secondary btn-sm" onClick={()=>setDupUyari(null)}>Vazgeç</button>
                </div>
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={()=>kaydet(false)} disabled={!form.sube_id}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
