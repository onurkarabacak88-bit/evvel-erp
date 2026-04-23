import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';
import { publishGlobalDataRefresh, subscribeGlobalDataRefresh } from '../utils/globalDataRefresh';

export function Strateji() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const load = () => { setLoading(true); api('/strateji').then(d=>{setData(d);setLoading(false);}); };
  useEffect(()=>{load();},[]);
  const toast = (m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function tumunuUygula() {
    if (!data?.oneriler?.length) return;
    const uygulanabilir = data.oneriler.filter(o => o.oneri_turu !== 'ERTELE' && o.odeme_id && o.tavsiye_tutar > 0);
    if (!uygulanabilir.length) { toast('Uygulanabilir öneri yok', 'yellow'); return; }
    try {
      // Tek transaction — biri başarısız olursa hepsi rollback
      const r = await api('/toplu-odeme', {
        method: 'POST',
        body: { odemeler: uygulanabilir.map(o => ({ odeme_id: o.odeme_id, tutar: o.tavsiye_tutar })) }
      });
      toast(`✓ ${r.uygulanan}/${uygulanabilir.length} ödeme uygulandı`);
      load();
    } catch (e) { toast(e.message, 'red'); }
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
  const [reddetModal, setReddetModal] = useState(null);
  const [gorunum, setGorunum] = useState('bekliyor'); // bekliyor | gecmis
  const [secili, setSecili] = useState(new Set());
  const [topluYukleniyor, setTopluYukleniyor] = useState(false);
  const load = () => {
    api(`/onay-kuyrugu?durum=${gorunum}&limit=400`).then(d => {
      setListe(d || []);
      if (gorunum !== 'bekliyor') setSecili(new Set());
    });
  };
  useEffect(()=>{load();},[gorunum]);
  useEffect(() => {
    const unsub = subscribeGlobalDataRefresh(() => load());
    return unsub;
  }, [gorunum]);
  const toast = (m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};
  async function onayla(id) {
    try { await api(`/onay-kuyrugu/${id}/onayla`,{method:'POST'}); toast('Onaylandı, kasadan düşüldü'); publishGlobalDataRefresh('onay-kuyrugu'); load(); }
    catch(e){toast(e.message,'red');}
  }

  function toggleSecim(id) {
    setSecili(prev => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }

  function tumunuSec() {
    if (secili.size === liste.length) setSecili(new Set());
    else setSecili(new Set(liste.map(o => o.id)));
  }

  async function topluOnayla() {
    if (!secili.size) return;
    setTopluYukleniyor(true);
    try {
      const r = await api('/onay-kuyrugu/toplu-onayla', {
        method: 'POST',
        body: { ids: [...secili] }
      });
      toast(`✅ ${r.onaylanan}/${r.toplam} onaylandı${r.hata > 0 ? ` · ${r.hata} hata` : ''}`);
      if (r.onaylanan > 0) publishGlobalDataRefresh('onay-kuyrugu-toplu');
      load();
    } catch(e) { toast(e.message, 'red'); }
    finally { setTopluYukleniyor(false); }
  }

  async function reddetGonder(neden) {
    try {
      await api(`/onay-kuyrugu/${reddetModal.id}/reddet`,{method:'POST', body:{neden}});
      const mesaj = neden === 'surec_bitti'
        ? 'Reddedildi — kaynak kapatıldı, plan üretilmeyecek'
        : 'Reddedildi — bu plan iptal edildi, kaynak aktif';
      toast(mesaj, 'yellow');
      publishGlobalDataRefresh('onay-kuyrugu-reddet');
      setReddetModal(null);
      load();
    } catch(e){toast(e.message,'red');}
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>✅ Onay Kuyruğu</h2>
          <p>{liste.length} {gorunum === 'bekliyor' ? 'bekleyen işlem' : 'geçmiş işlem'}</p>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <button
            className={`btn btn-sm ${gorunum==='bekliyor'?'btn-primary':'btn-ghost'}`}
            onClick={()=>setGorunum('bekliyor')}
          >
            Bekleyen
          </button>
          <button
            className={`btn btn-sm ${gorunum==='gecmis'?'btn-primary':'btn-ghost'}`}
            onClick={()=>setGorunum('gecmis')}
          >
            Geçmiş
          </button>
        </div>
        {gorunum === 'bekliyor' && liste.length > 0 && (
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            {secili.size > 0 && (
              <span style={{fontSize:12,color:'var(--text3)'}}>{secili.size} seçili</span>
            )}
            <button className="btn btn-ghost btn-sm" onClick={tumunuSec}>
              {secili.size === liste.length ? '☐ Seçimi Kaldır' : '☑ Tümünü Seç'}
            </button>
            {secili.size > 0 && (
              <button className="btn btn-primary" onClick={topluOnayla} disabled={topluYukleniyor}>
                {topluYukleniyor ? '⏳...' : `✓ ${secili.size} Onayla`}
              </button>
            )}
          </div>
        )}
      </div>
      {!liste.length ? (
        <div className="empty"><div className="icon">✅</div><p>{gorunum === 'bekliyor' ? 'Bekleyen onay yok' : 'Geçmiş kayıt yok'}</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              {gorunum === 'bekliyor' && <th style={{width:36}}></th>}
              <th>İşlem Türü</th><th>Açıklama</th>
              <th style={{textAlign:'right'}}>Tutar</th>
              <th>Tarih</th>
              {gorunum === 'gecmis' && <th>Durum</th>}
              {gorunum === 'gecmis' && <th>İşlem Zamanı</th>}
              <th></th>
            </tr></thead>
            <tbody>
              {liste.map(o=>(
                <tr key={o.id} style={{background: secili.has(o.id) ? 'rgba(74,158,255,0.06)' : ''}}>
                  {gorunum === 'bekliyor' && (
                    <td style={{textAlign:'center'}}>
                      <input type="checkbox" checked={secili.has(o.id)}
                        onChange={()=>toggleSecim(o.id)}
                        style={{cursor:'pointer',width:15,height:15}}/>
                    </td>
                  )}
                  <td><span className="badge badge-yellow">{o.islem_turu}</span></td>
                  <td>{o.aciklama}</td>
                  <td style={{textAlign:'right'}} className="amount-neg">{o.tutar ? `${parseInt(o.tutar).toLocaleString('tr-TR')} ₺` : '---'}</td>
                  <td className="mono" style={{fontSize:12}}>{o.tarih}</td>
                  {gorunum === 'gecmis' && (
                    <td>
                      <span className={`badge ${o.durum === 'onaylandi' ? 'badge-green' : 'badge-red'}`}>
                        {o.durum === 'onaylandi' ? 'Onaylandı' : 'Reddedildi'}
                      </span>
                    </td>
                  )}
                  {gorunum === 'gecmis' && (
                    <td className="mono" style={{fontSize:12}}>{String(o.onay_tarihi || '').slice(0, 19).replace('T', ' ') || '—'}</td>
                  )}
                  <td>
                    {gorunum === 'bekliyor' ? (
                      <div className="flex gap-8">
                        <button className="btn btn-primary btn-sm" onClick={()=>onayla(o.id)}>✓ Onayla</button>
                        <button className="btn btn-danger btn-sm" onClick={()=>setReddetModal({id:o.id, aciklama:o.aciklama})}>✕ Reddet</button>
                      </div>
                    ) : (
                      <span style={{fontSize:11,color:'var(--text3)'}}>Tamamlandı</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ret Sebebi Modalı */}
      {reddetModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setReddetModal(null)}>
          <div className="modal" style={{maxWidth:420}}>
            <div className="modal-header">
              <h3>✕ Reddetme Sebebi</h3>
              <button className="modal-close" onClick={()=>setReddetModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{marginBottom:16,color:'var(--text2)',fontSize:13}}>{reddetModal.aciklama}</p>
              <div style={{display:'flex',flexDirection:'column',gap:12}}>
                <button className="btn btn-ghost" style={{textAlign:'left',padding:'14px 16px',border:'1px solid var(--border)',borderRadius:8}}
                  onClick={()=>reddetGonder('hata')}>
                  <div style={{fontWeight:600,marginBottom:4}}>🔧 Hata</div>
                  <div style={{fontSize:12,color:'var(--text3)'}}>Plan yanlış oluştu. Kaynak aktif kalır, gelecek ay tekrar üretilir.</div>
                </button>
                <button className="btn btn-ghost" style={{textAlign:'left',padding:'14px 16px',border:'1px solid var(--red)',borderRadius:8}}
                  onClick={()=>reddetGonder('surec_bitti')}>
                  <div style={{fontWeight:600,marginBottom:4,color:'var(--red)'}}>🚫 Süreç Bitti</div>
                  <div style={{fontSize:12,color:'var(--text3)'}}>İlişki kesildi. Kaynak kapatılır, bir daha plan üretilmez, simülasyondan çıkar.</div>
                </button>
              </div>
            </div>
          </div>
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
  const [hatalar, setHatalar] = useState({});
  const [gecmisModal, setGecmisModal] = useState(null); // {borc} objesi
  const [gecmisData, setGecmisData] = useState(null);
  const [gecmisYukleniyor, setGecmisYukleniyor] = useState(false);
  const load = ()=>api('/borclar').then(setListe);
  useEffect(()=>{load();},[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function gecmisAc(borc) {
    setGecmisModal(borc);
    setGecmisData(null);
    setGecmisYukleniyor(true);
    try {
      const r = await api(`/borclar/${borc.id}/gecmis`);
      setGecmisData(r);
    } catch(e) { toast(e.message, 'red'); setGecmisModal(null); }
    finally { setGecmisYukleniyor(false); }
  }

  async function kaydet(){
    const yeniHatalar = {};
    if(!form.kurum) yeniHatalar.kurum = 'Zorunlu';
    if(!form.aylik_taksit || isNaN(parseFloat(form.aylik_taksit))) yeniHatalar.aylik_taksit = 'Geçerli tutar giriniz';
    if(Object.keys(yeniHatalar).length > 0){ setHatalar(yeniHatalar); return; }
    setHatalar({});
    // Sayısal alanları dönüştür — backend float/int bekliyor
    const body = {
      ...form,
      aylik_taksit: parseFloat(form.aylik_taksit),
      toplam_borc: form.toplam_borc ? parseFloat(form.toplam_borc) : null,
      kalan_vade: form.kalan_vade ? parseInt(form.kalan_vade) : null,
      toplam_vade: form.toplam_vade ? parseInt(form.toplam_vade) : null,
      odeme_gunu: parseInt(form.odeme_gunu) || 1,
      baslangic_tarihi: form.baslangic_tarihi || null,
    };
    try{
      if(duzenleId) await api(`/borclar/${duzenleId}`,{method:'PUT',body});
      else await api('/borclar',{method:'POST',body});
      toast('Kaydedildi'); setShowModal(false); setDuzenleId(null); setHatalar({}); load();
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
                    <button className="btn btn-ghost btn-sm" onClick={()=>gecmisAc(b)}>📋 Geçmiş</button>
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
                <div className="form-group">
                  <label>Kurum *</label>
                  <input value={form.kurum} onChange={e=>setForm({...form,kurum:e.target.value})}
                    style={{borderColor:hatalar.kurum?'var(--red)':''}}/>
                  {hatalar.kurum && <span style={{color:'var(--red)',fontSize:11}}>⚠️ {hatalar.kurum}</span>}
                </div>
                <div className="form-group">
                  <label>Tür</label>
                  <select value={form.borc_turu} onChange={e=>setForm({...form,borc_turu:e.target.value})}>
                    <option>Kredi</option><option>Mortgage</option><option>İşletme Kredisi</option><option>Diğer</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Toplam Borç (₺)</label>
                  <input type="number" value={form.toplam_borc} onChange={e=>setForm({...form,toplam_borc:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Aylık Taksit (₺) *</label>
                  <input type="number" value={form.aylik_taksit} onChange={e=>setForm({...form,aylik_taksit:e.target.value})}
                    style={{borderColor:hatalar.aylik_taksit?'var(--red)':''}}/>
                  {hatalar.aylik_taksit && <span style={{color:'var(--red)',fontSize:11}}>⚠️ {hatalar.aylik_taksit}</span>}
                </div>
                <div className="form-group">
                  <label>Kalan Vade (Ay)</label>
                  <input type="number" value={form.kalan_vade} onChange={e=>setForm({...form,kalan_vade:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Ödeme Günü</label>
                  <input type="number" min={1} max={31} value={form.odeme_gunu} onChange={e=>setForm({...form,odeme_gunu:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Başlangıç Tarihi</label>
                  <input type="date" value={form.baslangic_tarihi} onChange={e=>setForm({...form,baslangic_tarihi:e.target.value})}/>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.kurum||!form.aylik_taksit}>Kaydet</button>
            </div>
          </div>
        </div>
      )}

      {/* ÖDEME GEÇMİŞİ MODAL */}
      {gecmisModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setGecmisModal(null)}>
          <div className="modal" style={{maxWidth:680,width:'95%'}}>
            <div className="modal-header">
              <div>
                <h3>📋 {gecmisModal.kurum} — Ödeme Geçmişi</h3>
                <p style={{fontSize:12,color:'var(--text3)',marginTop:2}}>
                  {gecmisModal.borc_turu} · Aylık {parseInt(gecmisModal.aylik_taksit).toLocaleString('tr-TR')} ₺
                </p>
              </div>
              <button className="modal-close" onClick={()=>setGecmisModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {gecmisYukleniyor && <div style={{textAlign:'center',padding:40}}><div className="spinner"/></div>}
              {gecmisData && (<>
                {/* ÖZET KARTLAR */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,marginBottom:16}}>
                  {[
                    {label:'Toplam Ödenen', val: gecmisData.ozet.toplam_odenen, renk:'var(--green)'},
                    {label:'Kalan Borç',    val: gecmisData.ozet.kalan_borc,    renk:'var(--red)'},
                    {label:'İlerleme',      val: null, extra: `${gecmisData.ozet.gecen_taksit}/${gecmisData.borc.toplam_vade||'?'} taksit · %${gecmisData.ozet.ilerleme_pct}`, renk:'var(--blue)'},
                  ].map(({label,val,extra,renk})=>(
                    <div key={label} style={{background:'var(--bg3)',borderRadius:8,padding:'10px 14px',borderTop:`3px solid ${renk}`}}>
                      <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>{label}</div>
                      {val !== null
                        ? <div style={{fontSize:18,fontWeight:700,color:renk,fontFamily:'var(--font-mono)'}}>{parseInt(val).toLocaleString('tr-TR')} ₺</div>
                        : <div style={{fontSize:14,fontWeight:600,color:renk}}>{extra}</div>
                      }
                    </div>
                  ))}
                </div>

                {/* İLERLEME ÇUBUĞU */}
                <div style={{marginBottom:16}}>
                  <div style={{height:8,background:'var(--bg3)',borderRadius:4,overflow:'hidden'}}>
                    <div style={{height:'100%',width:`${gecmisData.ozet.ilerleme_pct}%`,background:'var(--green)',borderRadius:4,transition:'width .4s'}}/>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--text3)',marginTop:4}}>
                    <span>Başlangıç: {gecmisData.borc.baslangic||'—'}</span>
                    <span>%{gecmisData.ozet.ilerleme_pct} tamamlandı</span>
                    <span>Kalan: {gecmisData.ozet.kalan_taksit} taksit</span>
                  </div>
                </div>

                {/* BEKLEYEN ÖDEMELER */}
                {gecmisData.bekleyenler.length > 0 && (<>
                  <h4 style={{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:8}}>⏳ Bekleyen Ödemeler ({gecmisData.bekleyenler.length})</h4>
                  <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:14}}>
                    {gecmisData.bekleyenler.map((o,i)=>(
                      <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                        padding:'7px 12px',background:'rgba(255,200,0,0.08)',borderRadius:6,border:'1px solid rgba(255,200,0,0.2)'}}>
                        <span style={{fontSize:12,color:'var(--text2)'}}>{o.tarih}</span>
                        <span style={{fontSize:12,color:'var(--text3)'}}>{o.aciklama}</span>
                        <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--yellow)'}}>
                          {parseInt(o.tutar).toLocaleString('tr-TR')} ₺
                        </span>
                      </div>
                    ))}
                  </div>
                </>)}

                {/* ÖDENEN TAKSİTLER */}
                {gecmisData.odenenler.length > 0 ? (<>
                  <h4 style={{fontSize:12,fontWeight:600,color:'var(--text2)',marginBottom:8}}>✅ Ödenen Taksitler ({gecmisData.odenenler.length})</h4>
                  <div style={{maxHeight:280,overflowY:'auto',display:'flex',flexDirection:'column',gap:4}}>
                    {gecmisData.odenenler.map((o,i)=>(
                      <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                        padding:'7px 12px',background:'var(--bg3)',borderRadius:6}}>
                        <span style={{fontSize:12,color:'var(--text3)'}}>{o.tarih}</span>
                        <span style={{fontSize:12,color:'var(--text3)',flex:1,marginLeft:12}}>{o.aciklama}</span>
                        <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--green)'}}>
                          {parseInt(o.tutar).toLocaleString('tr-TR')} ₺
                        </span>
                      </div>
                    ))}
                  </div>
                </>) : (
                  <div style={{textAlign:'center',padding:20,color:'var(--text3)',fontSize:13}}>
                    Henüz ödeme kaydı yok
                  </div>
                )}
              </>)}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setGecmisModal(null)}>Kapat</button>
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
  const [kartlar, setKartlar] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({gider_adi:'',kategori:'Kira',tip:'sabit',tutar:'',periyot:'aylik',odeme_gunu:1,baslangic_tarihi:'',sube_id:'',gecerlilik_tarihi:'',sozlesme_sure_ay:'',kira_artis_periyot:'',odeme_yontemi:'nakit',kart_id:''});
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [sekme, setSekme] = useState('tanimli');
  const [odemeler, setOdemeler] = useState({odenenler:[],bekleyenler:[],ozet:{}});
  const [hatalar, setHatalar] = useState({});
  const [faturaModal, setFaturaModal] = useState(null); // {gider_id, gider_adi}
  const [faturaForm, setFaturaForm] = useState({tutar:'', tarih: new Date().toISOString().split('T')[0], odeme_yontemi:'nakit', kart_id:''});
  const [faturaGecmis, setFaturaGecmis] = useState([]);
  const [sabitGecmisModal, setSabitGecmisModal] = useState(null);
  const [sabitGecmisData, setSabitGecmisData] = useState(null);
  const [faturaKartOneri, setFaturaKartOneri] = useState(null);
  const [faturaKartYukleniyor, setFaturaKartYukleniyor] = useState(false);
  const ZORUNLU_KATEGORILER = ['Kira'];

  const load=()=>{
    api('/sabit-giderler').then(setListe);
    api('/subeler').then(setSubeler);
    api('/kartlar').then(setKartlar);
    api('/sabit-giderler/odemeler').then(setOdemeler);
  };
  useEffect(()=>{
    load();
    // Panel'den yönlendirme ile gelindiyse ilgili kaydı direkt düzenleme modunda aç
    const hedefId = sessionStorage.getItem('sabit_gider_duzenle');
    const faturaId = sessionStorage.getItem('sabit_gider_fatura_id');
    if(hedefId){
      sessionStorage.removeItem('sabit_gider_duzenle');
      api('/sabit-giderler').then(data=>{
        const g = data.find(x=>x.id===hedefId);
        if(g){
          setForm({gider_adi:g.gider_adi,kategori:g.kategori,tip:g.tip||'sabit',tutar:g.tutar,periyot:g.periyot,
            odeme_gunu:g.odeme_gunu,baslangic_tarihi:g.baslangic_tarihi?.slice(0,10)||'',
            sube_id:g.sube_id||'',gecerlilik_tarihi:'',sozlesme_sure_ay:g.sozlesme_sure_ay||'',
            kira_artis_periyot:g.kira_artis_periyot||'',
            odeme_yontemi:g.odeme_yontemi||'nakit',kart_id:g.kart_id||''});
          setDuzenleId(g.id);
          setHatalar({});
          setShowModal(true);
        }
      });
    }
    if(faturaId){
      sessionStorage.removeItem('sabit_gider_fatura_id');
      // Panel'den "Fatura Öde" ile gelindiyse ilgili giderin fatura modalını aç
      api('/sabit-giderler').then(data=>{
        const g = data.find(x=>x.id===faturaId && x.tip==='degisken');
        if(g) faturaOdeAc(g);
      });
    }
  },[]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  function validateForm(){
    const yeniHatalar = {};
    // Degisken tipte sadece gider_adi ve odeme_gunu zorunlu
    const degisken = form.tip === 'degisken';
    const zorunlu = !degisken && ZORUNLU_KATEGORILER.includes(form.kategori);
    if(!form.gider_adi) yeniHatalar.gider_adi = 'Zorunlu';
    if(!degisken && (!form.tutar || parseFloat(form.tutar) <= 0)) yeniHatalar.tutar = 'Geçerli bir tutar girin';
    if(!form.odeme_gunu) yeniHatalar.odeme_gunu = 'Zorunlu';
    if(zorunlu && !form.baslangic_tarihi && !duzenleId) yeniHatalar.baslangic_tarihi = 'Zorunlu';
    if(zorunlu && !form.sube_id) yeniHatalar.sube_id = 'Şube seçimi zorunlu';
    if(duzenleId && zorunlu && !form.gecerlilik_tarihi) yeniHatalar.gecerlilik_tarihi = 'Hangi aydan itibaren geçerli?';
    setHatalar(yeniHatalar);
    return Object.keys(yeniHatalar).length === 0;
  }

  async function kaydet(){
    if(!validateForm()) return;
    try{
      // Boş string olan opsiyonel alanlar backend'de 422'ye yol açar — null'a çevir
      const body = {
        gider_adi:           form.gider_adi,
        kategori:            form.kategori,
        tip:                 form.tip || 'sabit',
        tutar:               form.tip === 'degisken' ? (parseFloat(form.tutar) || 0) : (parseFloat(form.tutar) || 0),
        periyot:             form.periyot || 'aylik',
        odeme_gunu:          parseInt(form.odeme_gunu) || 1,
        odeme_yontemi:       form.tip === 'degisken' ? 'nakit' : (form.odeme_yontemi || 'nakit'),
        sube_id:             form.sube_id             || null,
        kart_id:             form.tip === 'degisken' ? null : (form.kart_id || null),
        baslangic_tarihi:    form.baslangic_tarihi    || null,
        gecerlilik_tarihi:   form.gecerlilik_tarihi   || null,
        sozlesme_sure_ay:    form.sozlesme_sure_ay    ? parseInt(form.sozlesme_sure_ay)   : null,
        kira_artis_periyot:  form.kira_artis_periyot  || null,
        kira_artis_tarihi:   form.kira_artis_tarihi   || null,
        sozlesme_bitis_tarihi: form.sozlesme_bitis_tarihi || null,
      };
      if(duzenleId) await api(`/sabit-giderler/${duzenleId}`,{method:'PUT',body});
      else await api('/sabit-giderler',{method:'POST',body});
      toast('Kaydedildi'); setShowModal(false); setDuzenleId(null); setHatalar({}); load();
    }catch(e){toast(e.message,'red');}
  }
  async function faturaOdeAc(g) {
    setFaturaModal({gider_id: g.id, gider_adi: g.gider_adi});
    setFaturaKartOneri(null);
    // Geçmiş ödemeleri yükle — son tutarı otomatik öneri olarak kullan (tekrarlılık şablonu)
    const gecmis = await api(`/fatura-gecmis/${g.id}`).catch(() => []);
    setFaturaGecmis(gecmis);
    const sonTutar = gecmis?.[0]?.tutar;
    setFaturaForm({
      tutar: sonTutar ? String(Math.round(Number(sonTutar))) : '',
      tarih: new Date().toISOString().split('T')[0],
      odeme_yontemi: 'nakit',
      kart_id: '',
    });
  }

  async function faturaOdeKaydet() {
    if (!faturaForm.tutar || parseFloat(faturaForm.tutar) <= 0) { toast('Tutar giriniz', 'red'); return; }
    if (faturaForm.odeme_yontemi === 'kart' && !faturaForm.kart_id) { toast('Kart seçiniz', 'red'); return; }
    try {
      await api('/fatura-ode', { method:'POST', body:{
        sabit_gider_id: faturaModal.gider_id,
        tutar: parseFloat(faturaForm.tutar),
        tarih: faturaForm.tarih,
        odeme_yontemi: faturaForm.odeme_yontemi,
        kart_id: faturaForm.odeme_yontemi === 'kart' ? faturaForm.kart_id : null,
        aciklama: `Fatura: ${faturaModal.gider_adi}`,
      }});
      toast(`${faturaModal.gider_adi} faturası ödendi`);
      setFaturaModal(null);
      sessionStorage.setItem('panel_yenile', '1'); // Panel bir sonraki görünümde yenilensin
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function sil(id){
    if(!confirm('Bu gideri kapat? İlişkili TÜM bekleyen ödeme planları iptal edilecek ve simülasyondan çıkarılacaktır.'))return;
    try{
      const res = await api(`/sabit-giderler/${id}`,{method:'DELETE'});
      const msg = res.iptal_edilen_plan > 0
        ? `Kapatıldı. ${res.iptal_edilen_plan} bekleyen plan iptal edildi.`
        : 'Kapatıldı.';
      toast(msg); load();
    }catch(e){toast(e.message,'red');}
  }

  const toplamAylik = liste.filter(g=>g.aktif&&g.periyot==='aylik').reduce((s,g)=>s+(parseFloat(g.tutar)||0),0);
  const fmt = v => parseInt(v||0).toLocaleString('tr-TR');
  const ozet = odemeler.ozet || {};

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Sabit Giderler</h2><p>Aylık toplam: {fmt(toplamAylik)} ₺</p></div>
        <button className="btn btn-primary" onClick={()=>{setForm({gider_adi:'',kategori:'Kira',tutar:'',periyot:'aylik',odeme_gunu:1,baslangic_tarihi:'',sube_id:'',sozlesme_sure_ay:'',kira_artis_periyot:'',odeme_yontemi:'nakit',kart_id:''});setDuzenleId(null);setShowModal(true);}}>+ Gider Ekle</button>
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
          <thead><tr><th>Tip</th><th>Gider Adı</th><th>Kategori</th><th style={{textAlign:'right'}}>Tutar</th><th>Periyot</th><th>Ödeme Günü</th><th>Ödeme Yöntemi</th><th>Şube</th><th>Durum</th><th></th></tr></thead>
          <tbody>
            {liste.map(g=>(
              <tr key={g.id}>
                <td>
                  {g.tip === 'degisken'
                    ? <span className="badge badge-yellow">📄 Değişken</span>
                    : <span className="badge badge-blue">📌 Sabit</span>
                  }
                </td>
                <td style={{fontWeight:500}}>{g.gider_adi}</td>
                <td><span className="badge badge-gray">{g.kategori}</span></td>
                <td style={{textAlign:'right'}} className={g.tip==='degisken'?'':'amount-neg'}>
                  {g.tip==='degisken' && (!g.tutar || g.tutar==0)
                    ? <span style={{color:'var(--text3)',fontSize:11}}>— bekleniyor</span>
                    : parseInt(g.tutar).toLocaleString('tr-TR') + ' ₺'
                  }
                </td>
                <td style={{fontSize:12}}>{g.periyot}</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>Her ayın {g.odeme_gunu}. günü</td>
                <td>
                  {g.tip==='degisken'
                    ? <span className="badge badge-gray">— hatırlatma</span>
                    : g.odeme_yontemi === 'kart'
                      ? <span className="badge badge-blue">💳 Kart</span>
                      : <span className="badge badge-gray">💵 Nakit</span>
                  }
                </td>
                <td style={{fontSize:12}}>{g.sube_adi||'---'}</td>
                <td><span className={`badge ${g.aktif?'badge-green':'badge-gray'}`}>{g.aktif?'Aktif':'Pasif'}</span></td>
                <td>
                  <div className="flex gap-8">
                    {g.tip === 'degisken' && (
                      <button className="btn btn-primary btn-sm" onClick={()=>faturaOdeAc(g)}>💰 Fatura Öde</button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={async()=>{
                      setSabitGecmisModal(g); setSabitGecmisData(null);
                      const r = await api(`/sabit-giderler/${g.id}/gecmis`).catch(()=>null);
                      setSabitGecmisData(r);
                    }}>📋 Geçmiş</button>
                    <button className="btn btn-ghost btn-sm" onClick={()=>{setForm({gider_adi:g.gider_adi,kategori:g.kategori,tip:g.tip||'sabit',tutar:g.tutar,periyot:g.periyot,odeme_gunu:g.odeme_gunu,baslangic_tarihi:g.baslangic_tarihi?.slice(0,10)||'',sube_id:g.sube_id||'',gecerlilik_tarihi:'',sozlesme_sure_ay:g.sozlesme_sure_ay||'',kira_artis_periyot:g.kira_artis_periyot||'',odeme_yontemi:g.odeme_yontemi||'nakit',kart_id:g.kart_id||''});setDuzenleId(g.id);setHatalar({});setShowModal(true);}}>✏️</button>
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

      {/* FATURA ÖDEME MODALI */}
      {faturaModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setFaturaModal(null)}>
          <div className="modal" style={{maxWidth:480}}>
            <div className="modal-header">
              <h3>💰 Fatura Öde — {faturaModal.gider_adi}</h3>
              <button className="modal-close" onClick={()=>setFaturaModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group">
                  <label>Fatura Tutarı (₺) *</label>
                  <input type="number" value={faturaForm.tutar}
                    onChange={e=>setFaturaForm({...faturaForm,tutar:e.target.value})}
                    placeholder="0" autoFocus/>
                  {faturaGecmis.length > 0 && (
                    <div style={{fontSize:11,color:'var(--text3)',marginTop:3}}>
                      📋 Son ödeme: {parseInt(faturaGecmis[0].tutar||0).toLocaleString('tr-TR')} ₺
                      {faturaGecmis[0].tarih ? ` (${String(faturaGecmis[0].tarih).slice(0,10)})` : ''}
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Ödeme Tarihi *</label>
                  <input type="date" value={faturaForm.tarih}
                    onChange={e=>setFaturaForm({...faturaForm,tarih:e.target.value})}/>
                </div>
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Ödeme Yöntemi</label>
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button type="button"
                      className={`btn btn-sm ${faturaForm.odeme_yontemi==='nakit'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>{ setFaturaForm({...faturaForm,odeme_yontemi:'nakit',kart_id:''}); setFaturaKartOneri(null); }}>
                      💵 Nakit
                    </button>
                    <button type="button"
                      className={`btn btn-sm ${faturaForm.odeme_yontemi==='kart'?'btn-primary':'btn-ghost'}`}
                      onClick={async () => {
                        setFaturaForm({...faturaForm, odeme_yontemi:'kart', kart_id:''});
                        if (!faturaKartOneri) {
                          setFaturaKartYukleniyor(true);
                          try {
                            const tutar = parseFloat(faturaForm.tutar) || 0;
                            const data = await api(`/anlik-gider-kart-oneri?tutar=${tutar}`);
                            setFaturaKartOneri(data);
                            const oneri = data.find(k => k.oneri && k.uygun);
                            if (oneri) setFaturaForm(f => ({...f, odeme_yontemi:'kart', kart_id: oneri.kart_id}));
                          } catch(e) { console.error(e); }
                          finally { setFaturaKartYukleniyor(false); }
                        }
                      }}>
                      💳 Kart
                    </button>
                  </div>
                </div>
                {faturaForm.odeme_yontemi === 'kart' && (
                  <div className="form-group" style={{gridColumn:'1/-1'}}>
                    <label>Kart Seç *</label>
                    {faturaKartYukleniyor ? (
                      <div style={{padding:'12px 0',fontSize:12,color:'var(--text3)'}}>Kartlar yükleniyor...</div>
                    ) : faturaKartOneri ? (
                      <div style={{display:'flex',flexDirection:'column',gap:6,marginTop:4}}>
                        {faturaKartOneri.map(k=>(
                          <button key={k.kart_id}
                            disabled={!k.uygun}
                            onClick={()=>{ if(k.uygun) setFaturaForm(f=>({...f,kart_id:k.kart_id})); }}
                            style={{
                              textAlign:'left', padding:'10px 12px', borderRadius:8,
                              cursor: k.uygun?'pointer':'not-allowed',
                              border:`2px solid ${faturaForm.kart_id===k.kart_id?'var(--primary)':'var(--border)'}`,
                              background: faturaForm.kart_id===k.kart_id?'rgba(99,102,241,0.07)':k.uygun?'var(--bg2)':'var(--bg3)',
                              opacity: k.uygun?1:0.55,
                            }}>
                            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                              <div>
                                <span style={{fontWeight:600,fontSize:13}}>{k.banka}</span>
                                <span style={{fontSize:12,color:'var(--text3)',marginLeft:8}}>{k.kart_adi}</span>
                                {k.oneri && k.uygun && <span className="badge badge-green" style={{marginLeft:8,fontSize:10}}>⭐ Önerilen</span>}
                              </div>
                              <div style={{textAlign:'right',fontSize:12}}>
                                <div style={{color:'var(--green)',fontWeight:600}}>{parseInt(k.kalan_limit).toLocaleString('tr-TR')} ₺ limit</div>
                                <div style={{color:'var(--text3)'}}>%{k.faiz_orani} faiz</div>
                              </div>
                            </div>
                            {k.uygun ? (
                              <div style={{marginTop:4,fontSize:11,color:'var(--text3)',display:'flex',gap:14}}>
                                <span>Kesim: {k.kesim_uzakligi} gün sonra</span>
                                <span>Doluluk: %{Math.round(k.limit_doluluk*100)}</span>
                              </div>
                            ) : (
                              <div style={{marginTop:3,fontSize:11,color:'var(--red)'}}>{k.uygun_degil_neden}</div>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <select value={faturaForm.kart_id}
                        onChange={e=>setFaturaForm({...faturaForm,kart_id:e.target.value})}>
                        <option value="">-- Kart seçin --</option>
                        {kartlar.map(k=>(
                          <option key={k.id} value={k.id}>{k.banka} — {k.kart_adi}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
              {faturaGecmis.length > 0 && (
                <div style={{marginTop:12}}>
                  <div style={{fontSize:11,color:'var(--text3)',marginBottom:6,fontWeight:600}}>SON ÖDEMELER</div>
                  {faturaGecmis.slice(0,4).map((f,i)=>(
                    <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:12,padding:'4px 0',borderBottom:'1px solid var(--border)'}}>
                      <span>{f.tarih?.slice(0,10)}</span>
                      <span style={{fontWeight:600}}>{parseInt(f.tutar).toLocaleString('tr-TR')} ₺</span>
                      <span style={{color:'var(--text3)'}}>{f.yontem==='kart'?`💳 ${f.banka||''}`:'💵 Nakit'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setFaturaModal(null)}>İptal</button>
              <button className="btn btn-primary" onClick={faturaOdeKaydet}>💰 Öde</button>
            </div>
          </div>
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
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Gider Tipi *</label>
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button
                      className={`btn btn-sm ${form.tip==='sabit'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,tip:'sabit'})}>
                      📌 Sabit <span style={{fontSize:10,opacity:0.7}}>— tutar belli, her ay aynı</span>
                    </button>
                    <button
                      className={`btn btn-sm ${form.tip==='degisken'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,tip:'degisken',odeme_yontemi:'nakit',kart_id:''})}>
                      📄 Değişken <span style={{fontSize:10,opacity:0.7}}>— elektrik, su, doğalgaz vb.</span>
                    </button>
                  </div>
                  {form.tip==='degisken' && (
                    <div style={{marginTop:6,fontSize:11,color:'var(--yellow)',background:'rgba(220,160,0,0.08)',padding:'6px 10px',borderRadius:6,border:'1px solid rgba(220,160,0,0.3)'}}>
                      ⚡ Değişken gider hatırlatmadır — ödeme geldiğinde tutarı Anlık Gider olarak girersiniz. Kasaya etki etmez.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Kategori</label>
                  <select value={form.kategori} onChange={e=>setForm({...form,kategori:e.target.value,hatalar:{}})}>
                    <option>Kira</option><option>Fatura</option><option>Abonelik</option><option>Ulaşım</option><option>Diğer</option>
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

                {/* ÖDEME YÖNTEMİ — sadece sabit giderde göster */}
                {form.tip !== 'degisken' && <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Ödeme Yöntemi</label>
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button type="button"
                      className={`btn btn-sm ${form.odeme_yontemi==='nakit'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,odeme_yontemi:'nakit',kart_id:''})}>
                      💵 Nakit
                    </button>
                    <button type="button"
                      className={`btn btn-sm ${form.odeme_yontemi==='kart'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,odeme_yontemi:'kart'})}>
                      💳 Kart Talimatı
                    </button>
                  </div>
                  {form.odeme_yontemi === 'kart' && (
                    <p style={{fontSize:11,color:'var(--text3)',marginTop:4}}>
                      Her ay otomatik olarak seçilen karta harcama olarak işlenir.
                    </p>
                  )}
                </div>}

                {/* KART SEÇİMİ — sadece sabit tipte göster */}
                {form.tip !== 'degisken' && form.odeme_yontemi === 'kart' && (
                  <div className="form-group" style={{gridColumn:'1/-1'}}>
                    <label>Kart Seç *</label>
                    <select value={form.kart_id} onChange={e=>setForm({...form,kart_id:e.target.value})}
                      style={{borderColor:!form.kart_id?'var(--yellow)':''}}>
                      <option value="">-- Kart seçin --</option>
                      {kartlar.map(k=>(
                        <option key={k.id} value={k.id}>
                          {k.banka} — {k.kart_adi} (Limit: {parseInt(k.limit_tutar||0).toLocaleString('tr-TR')} ₺)
                        </option>
                      ))}
                    </select>
                    <div style={{marginTop:6,padding:'8px 12px',background:'rgba(74,158,255,0.08)',border:'1px solid rgba(74,158,255,0.3)',borderRadius:6,fontSize:12}}>
                      💳 Her ay ödeme günü geldiğinde bu karta otomatik HARCAMA yazılır. Limit yetersizse panel uyarı verir.
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.gider_adi||(form.tip!=='degisken'&&!form.tutar)}>Kaydet</button>
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
  const [gorunum, setGorunum] = useState('bekliyor'); // bekliyor | odendi
  const [gecmisModal, setGecmisModal] = useState(false);
  const [gecmisData, setGecmisData] = useState(null);
  const [gecmisYukleniyor, setGecmisYukleniyor] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({aciklama:'',tutar:'',vade_tarihi:'',tedarikci:''});
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [dupUyari, setDupUyari] = useState(null);
  /** Aynı tedarikçi açık borç — Kaydet sonrası Birleştir / Birleştirme seçimi */
  const [borcKararModal, setBorcKararModal] = useState(null);
  const [borcKararSecimId, setBorcKararSecimId] = useState('');

  // Ödeme modal state — hem "Ödendi" hem "Kısmi" için ortak
  // tip: 'tam' | 'kismi'
  const [odemeModal, setOdemeModal] = useState(null); // {id, aciklama, tutar, tip}
  const [odemeAdim, setOdemeAdim] = useState(1); // 1=yöntem, 2=kart seç, 3=tutar/tarih (kismi)
  const [odemeYontemi, setOdemeYontemi] = useState('nakit'); // 'nakit' | 'kart'
  const [kartOneri, setKartOneri] = useState(null); // backend'den gelen kart listesi
  const [kartOneriYukleniyor, setKartOneriYukleniyor] = useState(false);
  const [seciliKartId, setSeciliKartId] = useState('');
  const [kismiTutar, setKismiTutar] = useState('');
  const [kismiTarih, setKismiTarih] = useState('');

  const load=()=>api(`/vadeli-alimlar?durum=${gorunum}&gun=30`).then(setListe);
  useEffect(()=>{load();},[gorunum]);
  useEffect(() => {
    const unsub = subscribeGlobalDataRefresh(() => load());
    return unsub;
  }, [gorunum]);
  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function vadeliGecmisAc() {
    setGecmisModal(true);
    setGecmisData(null);
    setGecmisYukleniyor(true);
    try {
      const r = await api('/vadeli-alimlar/gecmis?limit=160');
      setGecmisData(r);
    } catch (e) {
      toast(e.message, 'red');
      setGecmisModal(false);
    } finally {
      setGecmisYukleniyor(false);
    }
  }

  function odemeModalAc(v, tip) {
    setOdemeModal({id:v.id, aciklama:v.aciklama, tutar:parseFloat(v.tutar), tip});
    setOdemeAdim(1);
    setOdemeYontemi('nakit');
    setKartOneri(null);
    setSeciliKartId('');
    setKismiTutar('');
    setKismiTarih('');
  }
  function odemeModalKapat() {
    setOdemeModal(null);
    setKartOneri(null);
  }

  async function yontemSec(yontem) {
    setOdemeYontemi(yontem);
    if (yontem === 'kart') {
      setKartOneriYukleniyor(true);
      try {
        const data = await api(`/vadeli-alimlar/${odemeModal.id}/kart-oneri`);
        setKartOneri(data);
        // Önerilen kartı otomatik seç
        const oneri = data.kartlar.find(k=>k.oneri && k.uygun);
        if (oneri) setSeciliKartId(oneri.kart_id);
      } catch(e) {
        toast('Kart bilgileri alınamadı: ' + e.message, 'red');
      } finally {
        setKartOneriYukleniyor(false);
      }
      setOdemeAdim(2);
    } else {
      // Nakit — kısmi ise tutar/tarih adımına, tam ise direkt onayla
      if (odemeModal.tip === 'kismi') {
        setOdemeAdim(3);
      } else {
        setOdemeAdim(3); // tam nakit için de onay adımı
      }
    }
  }

  async function odemeOnayla() {
    try {
      if (odemeModal.tip === 'tam') {
        await api(`/vadeli-alimlar/${odemeModal.id}/ode`, {
          method: 'POST',
          body: { odeme_yontemi: odemeYontemi, kart_id: odemeYontemi==='kart' ? seciliKartId : null }
        });
        const mesaj = odemeYontemi === 'kart'
          ? 'Kart harcamasına eklendi — kasa etkilenmedi'
          : 'Ödeme kaydedildi, kasadan düşüldü';
        toast(mesaj);
      } else {
        // Kısmi
        const odenen = parseFloat(kismiTutar);
        if (!odenen || odenen <= 0) { toast('Geçerli tutar girin', 'red'); return; }
        if (!kismiTarih) { toast('Yeni vade tarihi girin', 'red'); return; }
        if (odenen >= odemeModal.tutar) { toast('Tam ödeme için "Ödendi" butonunu kullanın', 'red'); return; }
        await api(`/vadeli-alimlar/${odemeModal.id}/kismi-ode`, {
          method: 'POST',
          body: {
            odenen_tutar: odenen,
            kalan_vade_tarihi: kismiTarih,
            odeme_yontemi: odemeYontemi,
            kart_id: odemeYontemi==='kart' ? seciliKartId : null
          }
        });
        const kalan = odemeModal.tutar - odenen;
        const mesaj = odemeYontemi === 'kart'
          ? `${odenen.toLocaleString('tr-TR')} ₺ karta eklendi, ${kalan.toLocaleString('tr-TR')} ₺ yeni vadeye aktarıldı`
          : `${odenen.toLocaleString('tr-TR')} ₺ ödendi, ${kalan.toLocaleString('tr-TR')} ₺ ${new Date(kismiTarih).toLocaleDateString('tr-TR')} tarihine aktarıldı`;
        toast(mesaj);
      }
      odemeModalKapat();
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function kaydet(force=false){
    setDupUyari(null);
    try{
      if(duzenleId){
        await api(`/vadeli-alimlar/${duzenleId}`,{method:'PUT',body:{
          aciklama:form.aciklama,tutar:form.tutar,vade_tarihi:form.vade_tarihi,tedarikci:form.tedarikci
        }});
        toast('Kaydedildi');
      } else {
        const body = {...form, force};
        const res = await api('/vadeli-alimlar',{method:'POST',body});
        if (res.warning && res.kod === 'TEDARIKCI_ACIK_BAKIYE') {
          const rows = res.mevcut_borc || [];
          setBorcKararSecimId(rows[0]?.id || '');
          setBorcKararModal({ mevcut_borc: rows, mesaj: res.mesaj });
          return;
        }
        if (res.warning) { setDupUyari(res.mesaj); return; }
        if(res.birlestirildi){
          toast(`Birleştirildi — yeni toplam ${Number(res.yeni_toplam).toLocaleString('tr-TR')} ₺`);
        } else toast('Kaydedildi');
      }
      setShowModal(false); setDuzenleId(null); load();
    }catch(e){toast(e.message,'red');}
  }

  async function borcKararUygula(mod) {
    const rows = borcKararModal?.mevcut_borc || [];
    try {
      const base = { ...form, force: false };
      let body = { ...base };
      if (mod === 'ayri') {
        body.tedarikci_karari = 'ayri';
      } else {
        if (rows.length === 1) {
          body.tedarikci_karari = 'ilave';
        } else {
          if (!borcKararSecimId) {
            toast('Hangi borca ekleneceğini seçin', 'red');
            return;
          }
          body.birlestir_vadeli_id = borcKararSecimId;
        }
      }
      const res = await api('/vadeli-alimlar', { method: 'POST', body });
      if (res.warning && res.kod === 'TEDARIKCI_ACIK_BAKIYE') {
        toast('İşlem tamamlanamadı — tekrar deneyin', 'red');
        return;
      }
      if (res.warning) {
        setDupUyari(res.mesaj);
        setBorcKararModal(null);
        return;
      }
      setBorcKararModal(null);
      if (res.birlestirildi) {
        toast(`Birleştirildi — yeni toplam ${Number(res.yeni_toplam).toLocaleString('tr-TR')} ₺`);
      } else {
        toast(mod === 'ayri' ? 'Ayrı borç satırı olarak kaydedildi' : 'Kaydedildi');
      }
      setShowModal(false);
      setDuzenleId(null);
      load();
    } catch (e) {
      toast(e.message, 'red');
    }
  }
  async function sil(id){
    if(!confirm('İptal et?'))return;
    try{await api(`/vadeli-alimlar/${id}`,{method:'DELETE'}); toast('İptal edildi'); load();}
    catch(e){toast(e.message,'red');}
  }

  const adimBaslik = () => {
    if (odemeAdim === 1) return odemeModal?.tip === 'tam' ? 'Ödeme Yöntemi' : '✂ Kısmi Ödeme — Yöntem';
    if (odemeAdim === 2) return 'Kart Seç';
    if (odemeAdim === 3) return odemeYontemi === 'kart' ? 'Kart ile Onayla' : 'Nakit ile Onayla';
    return '';
  };

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>Vadeli Alımlar</h2>
          <p>{gorunum === 'bekliyor' ? '7 gün içinde yaklaşanlar panelde gösterilir' : 'Son 30 günde ödenen vadeli alımlar'}</p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button
            className={`btn btn-sm ${gorunum==='bekliyor'?'btn-primary':'btn-ghost'}`}
            onClick={()=>setGorunum('bekliyor')}
          >
            Bekleyenler
          </button>
          <button
            className={`btn btn-sm ${gorunum==='odendi'?'btn-primary':'btn-ghost'}`}
            onClick={()=>setGorunum('odendi')}
          >
            Ödenenler (30 gün)
          </button>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-ghost" onClick={vadeliGecmisAc}>📋 Ödeme Geçmişi</button>
          {gorunum === 'bekliyor' && (
            <button className="btn btn-primary" onClick={()=>{setForm({aciklama:'',tutar:'',vade_tarihi:'',tedarikci:''});setDuzenleId(null);setShowModal(true);}}>+ Vadeli Alım Ekle</button>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Açıklama</th><th>Tedarikçi</th><th style={{textAlign:'right'}}>Tutar</th><th>Vade Tarihi</th><th>{gorunum === 'bekliyor' ? 'Kalan' : 'Ödeme'}</th><th></th></tr></thead>
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
                  <td>
                    {gorunum === 'bekliyor' ? (
                      <span className={`badge ${gun<=0?'badge-red':gun<=7?'badge-yellow':'badge-gray'}`}>{gun<=0?'BUGÜN':gun+' gün'}</span>
                    ) : (
                      <span className="badge badge-green">
                        {v.odeme_tarihi ? fmtDate(v.odeme_tarihi) : 'Ödendi'}
                      </span>
                    )}
                  </td>
                  <td>
                    {gorunum === 'bekliyor' ? (
                      <div className="flex gap-8">
                        <button className="btn btn-primary btn-sm" onClick={()=>odemeModalAc(v,'tam')}>Ödendi</button>
                        <button className="btn btn-ghost btn-sm" onClick={()=>odemeModalAc(v,'kismi')}>✂ Kısmi</button>
                        <button className="btn btn-ghost btn-sm" onClick={()=>{setForm({aciklama:v.aciklama,tutar:v.tutar,vade_tarihi:v.vade_tarihi,tedarikci:v.tedarikci||''});setDuzenleId(v.id);setShowModal(true);}}>✏️</button>
                        <button className="btn btn-danger btn-sm" onClick={()=>sil(v.id)}>✕</button>
                      </div>
                    ) : (
                      <span style={{fontSize:11,color:'var(--text3)'}}>Kapanmış kayıt</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Kayıt ekleme/düzenleme modalı — değişmedi */}
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>{duzenleId?'Düzenle':'Vadeli Alım Ekle'}</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Açıklama * <span style={{fontSize:11,color:'var(--text3)'}}>— kart ödemelerinde eşleştirme için kritik</span></label>
                  <input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})}
                    placeholder="Ör: Ahmet Tedarikçi Mal Alımı"
                    style={{borderColor: !form.aciklama ? 'var(--yellow)' : ''}}/>
                  {!form.aciklama && <span style={{fontSize:11,color:'var(--yellow)'}}>⚠️ Zorunlu alan</span>}
                </div>
                <div className="form-group">
                  <label>Tutar (₺) *</label>
                  <input type="number" value={form.tutar} onChange={e=>setForm({...form,tutar:e.target.value})}
                    placeholder="0"
                    style={{borderColor: !form.tutar ? 'var(--yellow)' : ''}}/>
                  {!form.tutar && <span style={{fontSize:11,color:'var(--yellow)'}}>⚠️ Zorunlu alan</span>}
                </div>
                <div className="form-group">
                  <label>Vade Tarihi *</label>
                  <input type="date" value={form.vade_tarihi} onChange={e=>setForm({...form,vade_tarihi:e.target.value})}
                    style={{borderColor: !form.vade_tarihi ? 'var(--yellow)' : ''}}/>
                  {!form.vade_tarihi && <span style={{fontSize:11,color:'var(--yellow)'}}>⚠️ Zorunlu alan</span>}
                </div>
                <div className="form-group">
                  <label>Tedarikçi * <span style={{fontSize:11,color:'var(--text3)'}}>— kart takibinde kullanılır</span></label>
                  <input value={form.tedarikci} onChange={e=>setForm({...form,tedarikci:e.target.value})}
                    placeholder="Tedarikçi adı"
                    style={{borderColor: !form.tedarikci ? 'var(--yellow)' : ''}}/>
                  {!form.tedarikci && <span style={{fontSize:11,color:'var(--yellow)'}}>⚠️ Zorunlu alan</span>}
                </div>
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
              <button className="btn btn-primary" onClick={()=>kaydet(false)} disabled={!form.aciklama||!form.tutar||!form.vade_tarihi||!form.tedarikci}>Kaydet</button>
            </div>
          </div>
        </div>
      )}

      {borcKararModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setBorcKararModal(null)}>
          <div className="modal" style={{maxWidth:440}}>
            <div className="modal-header">
              <h3>Aynı tedarikçide açık borç</h3>
              <button type="button" className="modal-close" onClick={()=>setBorcKararModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{fontSize:14,marginBottom:12,color:'var(--text2)'}}>
                {borcKararModal.mesaj || 'Bu tutarı mevcut bakiyeye mi ekleyelim, yoksa ayrı bir vadeli satırı mı açılsın?'}
              </p>
              <ul style={{margin:0,paddingLeft:18,fontSize:13,color:'var(--text3)'}}>
                {(borcKararModal.mevcut_borc||[]).map(r=>(
                  <li key={r.id} style={{marginBottom:6}}>
                    <strong>{parseInt(r.tutar).toLocaleString('tr-TR')} ₺</strong>
                    {' · '}{r.aciklama||'—'}{' · vade '}{r.vade_tarihi}
                  </li>
                ))}
              </ul>
              {(borcKararModal.mevcut_borc||[]).length > 1 && (
                <div className="form-group" style={{marginTop:14}}>
                  <label style={{fontSize:12}}>Birleştirme: hangi satıra eklensin?</label>
                  <select
                    value={borcKararSecimId}
                    onChange={e=>setBorcKararSecimId(e.target.value)}
                    style={{width:'100%',padding:'8px 10px',borderRadius:8,border:'1px solid var(--border)'}}
                  >
                    {(borcKararModal.mevcut_borc||[]).map(r=>(
                      <option key={r.id} value={r.id}>
                        {parseInt(r.tutar).toLocaleString('tr-TR')} ₺ — {r.aciklama?.slice(0,36) || r.id}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer" style={{flexWrap:'wrap',gap:8}}>
              <button type="button" className="btn btn-secondary" onClick={()=>setBorcKararModal(null)}>Vazgeç</button>
              <button type="button" className="btn btn-ghost" onClick={()=>borcKararUygula('ayri')}>Birleştirme — ayrı borç</button>
              <button type="button" className="btn btn-primary" onClick={()=>borcKararUygula('ilave')}>Birleştir</button>
            </div>
          </div>
        </div>
      )}

      {gecmisModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setGecmisModal(false)}>
          <div className="modal" style={{maxWidth:760,width:'95%'}}>
            <div className="modal-header">
              <div>
                <h3>📋 Vadeli Ödeme Geçmişi</h3>
                <p style={{fontSize:12,color:'var(--text3)',marginTop:2}}>
                  Nakit + kart üzerinden kapanan vadeli ödemeler
                </p>
              </div>
              <button className="modal-close" onClick={()=>setGecmisModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              {gecmisYukleniyor && <div style={{textAlign:'center',padding:40}}><div className="spinner"/></div>}
              {gecmisData && (
                <>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:10,marginBottom:14}}>
                    <div style={{background:'var(--bg3)',borderRadius:8,padding:'10px 14px'}}>
                      <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>Kayıt</div>
                      <div style={{fontSize:18,fontWeight:700,color:'var(--text1)'}}>{gecmisData?.ozet?.adet || 0}</div>
                    </div>
                    <div style={{background:'var(--bg3)',borderRadius:8,padding:'10px 14px'}}>
                      <div style={{fontSize:11,color:'var(--text3)',marginBottom:4}}>Toplam Ödenen</div>
                      <div style={{fontSize:18,fontWeight:700,color:'var(--green)'}}>{fmt(gecmisData?.ozet?.toplam || 0)}</div>
                    </div>
                  </div>
                  {!gecmisData?.satirlar?.length ? (
                    <div className="empty"><p>Ödeme geçmişi bulunamadı</p></div>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Tarih</th><th>Açıklama</th><th>Tedarikçi</th><th>Yöntem</th><th style={{textAlign:'right'}}>Tutar</th></tr></thead>
                        <tbody>
                          {gecmisData.satirlar.map((r, i) => (
                            <tr key={`${r.vadeli_id || 'yok'}-${r.tarih}-${i}`}>
                              <td className="mono" style={{fontSize:12}}>{fmtDate(r.tarih)}</td>
                              <td>{r.vadeli_aciklama || r.aciklama || '—'}</td>
                              <td style={{fontSize:12,color:'var(--text3)'}}>{r.tedarikci || '—'}</td>
                              <td>
                                <span className={`badge ${r.odeme_yontemi === 'kart' ? 'badge-blue' : 'badge-gray'}`}>
                                  {r.odeme_yontemi === 'kart' ? '💳 Kart' : '💵 Nakit'}
                                </span>
                              </td>
                              <td style={{textAlign:'right'}} className="amount-neg">{fmt(r.tutar)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setGecmisModal(false)}>Kapat</button>
            </div>
          </div>
        </div>
      )}

      {/* Ödeme modalı — Nakit/Kart akışı */}
      {odemeModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&odemeModalKapat()}>
          <div className="modal" style={{maxWidth:480}}>
            <div className="modal-header">
              <div>
                <h3>{adimBaslik()}</h3>
                <div style={{fontSize:11,color:'var(--text3)',marginTop:2}}>{odemeModal.aciklama} · {parseInt(odemeModal.tutar).toLocaleString('tr-TR')} ₺</div>
              </div>
              <button className="modal-close" onClick={odemeModalKapat}>✕</button>
            </div>
            <div className="modal-body">

              {/* ADIM 1: Nakit mi Kart mı */}
              {odemeAdim === 1 && (
                <div style={{display:'flex',flexDirection:'column',gap:10}}>
                  <button
                    className={`btn btn-ghost`}
                    style={{textAlign:'left',padding:'14px 16px',border:`2px solid ${odemeYontemi==='nakit'?'var(--primary)':'var(--border)'}`,borderRadius:8}}
                    onClick={()=>yontemSec('nakit')}>
                    <div style={{fontWeight:600,marginBottom:3}}>Nakit / Havale</div>
                    <div style={{fontSize:12,color:'var(--text3)'}}>Kasadan düşer, anında ledger'a yansır</div>
                  </button>
                  <button
                    className={`btn btn-ghost`}
                    style={{textAlign:'left',padding:'14px 16px',border:`2px solid ${odemeYontemi==='kart'?'var(--primary)':'var(--border)'}`,borderRadius:8}}
                    onClick={()=>yontemSec('kart')}>
                    <div style={{fontWeight:600,marginBottom:3}}>Kredi Kartı</div>
                    <div style={{fontSize:12,color:'var(--text3)'}}>Kasaya yansımaz — kart borcuna eklenir, ödeme günü düşer</div>
                  </button>
                </div>
              )}

              {/* ADIM 2: Kart seç */}
              {odemeAdim === 2 && (
                <div>
                  {kartOneriYukleniyor && <div style={{textAlign:'center',padding:24,color:'var(--text3)'}}>Kartlar yükleniyor...</div>}
                  {kartOneri && (
                    <div style={{display:'flex',flexDirection:'column',gap:8}}>
                      {kartOneri.kartlar.map(k=>(
                        <button key={k.kart_id}
                          disabled={!k.uygun}
                          onClick={()=>{ if(k.uygun){ setSeciliKartId(k.kart_id); setOdemeAdim(3); }}}
                          style={{
                            textAlign:'left', padding:'12px 14px', borderRadius:8, cursor: k.uygun?'pointer':'not-allowed',
                            border: `2px solid ${seciliKartId===k.kart_id?'var(--primary)': k.uygun?'var(--border)':'var(--border)'}`,
                            background: k.uygun ? 'var(--bg2)' : 'var(--bg3)',
                            opacity: k.uygun ? 1 : 0.5,
                          }}>
                          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                            <div>
                              <span style={{fontWeight:600,fontSize:13}}>{k.banka}</span>
                              <span style={{fontSize:12,color:'var(--text3)',marginLeft:8}}>{k.kart_adi}</span>
                              {k.oneri && k.uygun && <span className="badge badge-green" style={{marginLeft:8,fontSize:10}}>Önerilen</span>}
                            </div>
                            <div style={{textAlign:'right',fontSize:12}}>
                              <div style={{color:'var(--green)',fontWeight:600}}>{parseInt(k.kalan_limit).toLocaleString('tr-TR')} ₺ limit</div>
                              <div style={{color:'var(--text3)'}}>%{k.faiz_orani} faiz</div>
                            </div>
                          </div>
                          {k.uygun ? (
                            <div style={{marginTop:6,fontSize:11,color:'var(--text3)',display:'flex',gap:16}}>
                              <span>Kesim: {k.kesim_uzakligi} gün sonra</span>
                              <span>Son ödeme: {k.son_odeme_uzakligi} gün sonra</span>
                              <span>Doluluk: %{Math.round(k.limit_doluluk*100)}</span>
                            </div>
                          ) : (
                            <div style={{marginTop:4,fontSize:11,color:'var(--red)'}}>{k.uygun_degil_neden}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{marginTop:12}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setOdemeAdim(1)}>← Geri</button>
                  </div>
                </div>
              )}

              {/* ADIM 3: Kısmi tutar/tarih VEYA tam ödeme onayı */}
              {odemeAdim === 3 && (
                <div>
                  {/* Seçilen yöntem özeti */}
                  <div style={{background:'var(--bg3)',borderRadius:8,padding:'10px 14px',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{fontWeight:600,fontSize:12}}>{odemeYontemi==='kart'?'Kredi Kartı':'Nakit / Havale'}</div>
                      {odemeYontemi==='kart' && kartOneri && (
                        <div style={{fontSize:11,color:'var(--text3)',marginTop:2}}>
                          {kartOneri.kartlar.find(k=>k.kart_id===seciliKartId)?.banka} — {kartOneri.kartlar.find(k=>k.kart_id===seciliKartId)?.kart_adi}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setOdemeAdim(odemeYontemi==='kart'?2:1)}>Değiştir</button>
                  </div>

                  {/* Kısmi ödeme: tutar + tarih */}
                  {odemeModal.tip === 'kismi' && (
                    <>
                      <div className="form-group">
                        <label>Şimdi Ödenecek Tutar (₺)</label>
                        <input type="number" value={kismiTutar} onChange={e=>setKismiTutar(e.target.value)}
                          placeholder={`0 - ${parseInt(odemeModal.tutar)} arası`} autoFocus/>
                        {kismiTutar && <div style={{fontSize:11,color:'var(--text3)',marginTop:4}}>
                          Kalan: <strong>{(odemeModal.tutar - parseFloat(kismiTutar||0)).toLocaleString('tr-TR')} ₺</strong>
                        </div>}
                      </div>
                      <div className="form-group">
                        <label>Kalan Borcun Yeni Vadesi</label>
                        <input type="date" value={kismiTarih} min={new Date().toISOString().split('T')[0]} onChange={e=>setKismiTarih(e.target.value)}/>
                      </div>
                    </>
                  )}

                  {/* Tam ödeme: sadece özet */}
                  {odemeModal.tip === 'tam' && (
                    <div style={{textAlign:'center',padding:'8px 0 4px'}}>
                      <div style={{fontSize:22,fontWeight:700,color:'var(--red)'}}>
                        {parseInt(odemeModal.tutar).toLocaleString('tr-TR')} ₺
                      </div>
                      <div style={{fontSize:12,color:'var(--text3)',marginTop:4}}>
                        {odemeYontemi==='kart'
                          ? 'Bu tutar kart borcuna eklenecek, kasadan düşmeyecek.'
                          : 'Bu tutar kasadan düşecek ve ledger\'a yansıyacak.'}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer — sadece adım 3'te göster */}
            {odemeAdim === 3 && (
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={odemeModalKapat}>İptal</button>
                <button className="btn btn-primary"
                  disabled={odemeModal.tip==='kismi' && (!kismiTutar||!kismiTarih)}
                  onClick={odemeOnayla}>
                  ✓ Onayla
                </button>
              </div>
            )}
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

  useEffect(() => {
    try {
      const kid = sessionStorage.getItem('kart_hareket_odeme_kart_id');
      const open = sessionStorage.getItem('kart_hareket_odeme_modal');
      if (!kid && open !== '1') return;
      setForm((f) => ({
        ...f,
        ...(kid ? {
          kart_id: kid,
          islem_turu: 'ODEME',
          tutar: '',
          aciklama: 'Panel — asgari / kart borcu ödemesi',
        } : {}),
      }));
      if (open === '1') setShowModal(true);
      sessionStorage.removeItem('kart_hareket_odeme_kart_id');
      sessionStorage.removeItem('kart_hareket_odeme_modal');
    } catch (_) {}
  }, []);

  const toast=(m,t='green')=>{setMsg({m,t});setTimeout(()=>setMsg(null),3000);};

  async function kaydet(){
    try{
      await api('/kart-hareketleri',{method:'POST',body:form});
      publishGlobalDataRefresh('kart-hareketleri');
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
          <thead><tr><th>Tarih</th><th>Şube</th><th style={{textAlign:'right'}}>Nakit</th><th style={{textAlign:'right'}}>POS</th><th style={{textAlign:'right'}}>Online</th><th style={{textAlign:'right'}}>Toplam</th><th style={{textAlign:'right',color:'var(--red)'}}>🔥 Yanan</th><th></th></tr></thead>
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
                <td style={{textAlign:'right'}}>{
                  parseFloat(c.toplam_yanan||0) > 0
                    ? <span style={{color:'var(--red)',fontSize:12,fontFamily:'var(--font-mono)',fontWeight:600}}>
                        -{parseInt(c.toplam_yanan).toLocaleString('tr-TR')} ₺
                      </span>
                    : <span style={{color:'var(--text3)',fontSize:11}}>—</span>
                }</td>
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

              {/* Anlık yanan para hesabı */}
              {(() => {
                const sube = subeler.find(s => s.id === form.sube_id);
                const pos = parseFloat(form.pos) || 0;
                const online = parseFloat(form.online) || 0;
                const posOran = parseFloat(sube?.pos_oran) || 0;
                const onlineOran = parseFloat(sube?.online_oran) || 0;
                const posKesinti = pos * posOran / 100;
                const onlineKesinti = online * onlineOran / 100;
                const toplamYanan = posKesinti + onlineKesinti;
                if (toplamYanan <= 0) return null;
                return (
                  <div style={{margin:'0 0 4px', padding:'10px 14px', background:'rgba(220,50,50,0.07)', border:'1px solid rgba(220,50,50,0.25)', borderRadius:8}}>
                    <div style={{fontSize:12, fontWeight:700, color:'var(--red)', marginBottom:6}}>🔥 Finansman Maliyeti</div>
                    <div style={{display:'flex', gap:20, flexWrap:'wrap', fontSize:12}}>
                      {posKesinti > 0 && (
                        <span style={{color:'var(--text2)'}}>
                          💳 POS Kesinti (%{posOran}): <strong style={{color:'var(--red)',fontFamily:'var(--font-mono)'}}>{parseInt(posKesinti).toLocaleString('tr-TR')} ₺</strong>
                        </span>
                      )}
                      {onlineKesinti > 0 && (
                        <span style={{color:'var(--text2)'}}>
                          🌐 Online Kesinti (%{onlineOran}): <strong style={{color:'var(--red)',fontFamily:'var(--font-mono)'}}>{parseInt(onlineKesinti).toLocaleString('tr-TR')} ₺</strong>
                        </span>
                      )}
                      <span style={{color:'var(--text2)'}}>
                        🔥 Toplam Yanan: <strong style={{color:'var(--red)',fontFamily:'var(--font-mono)',fontSize:13}}>{parseInt(toplamYanan).toLocaleString('tr-TR')} ₺</strong>
                      </span>
                    </div>
                  </div>
                );
              })()}
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
