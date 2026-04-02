import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const KATEGORILER = ['Nakit Alım','Market','Fatura','Kargo','Yemek','Yakıt','Bakım','Diğer'];

export default function AnlikGider() {
  const [liste, setListe] = useState([]);
  const [kartlar, setKartlar] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({tarih: new Date().toISOString().split('T')[0], kategori:'Diğer', tutar:'', aciklama:'', sube:'MERKEZ', odeme_yontemi:'nakit', kart_id:''});
  const [msg, setMsg] = useState(null);
  const [dupUyari, setDupUyari] = useState(null);

  const load = () => api('/anlik-gider').then(setListe);
  useEffect(() => {
    load();
    api('/kartlar').then(setKartlar);
  }, []);
  const toast = (m, t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),3000); };

  async function kaydet(force=false) {
    setDupUyari(null);
    if (form.odeme_yontemi === 'kart' && !form.kart_id) {
      toast('Kart seçimi zorunlu', 'red'); return;
    }
    try {
      const body = { ...form, force };
      if (form.odeme_yontemi === 'nakit') { delete body.kart_id; }
      const res = await api('/anlik-gider', { method:'POST', body });
      if (res.warning) { setDupUyari(res.mesaj); return; }
      const mesaj = form.odeme_yontemi === 'kart'
        ? 'Gider kaydedildi — kart borcuna eklendi'
        : 'Gider kaydedildi — kasadan düşüldü';
      toast(mesaj);
      setShowModal(false);
      setForm({tarih: new Date().toISOString().split('T')[0], kategori:'Diğer', tutar:'', aciklama:'', sube:'MERKEZ', odeme_yontemi:'nakit', kart_id:''});
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function sil(id) {
    const g = liste.find(x => x.id === id);
    const mesaj = g?.odeme_yontemi === 'kart'
      ? 'Bu gideri iptal et? Kart borcundan düşülecek.'
      : 'Bu gideri iptal et? Kasaya geri yüklenecek.';
    if (!confirm(mesaj)) return;
    try {
      await api(`/anlik-gider/${id}`, { method:'DELETE' });
      toast(g?.odeme_yontemi === 'kart' ? 'İptal edildi — kart borcundan düşüldü' : 'İptal edildi — kasaya iade edildi', 'yellow');
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  const toplamBugün = liste.filter(g => g.tarih === new Date().toISOString().split('T')[0]).reduce((s,g)=>s+parseFloat(g.tutar),0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>Anlık Gider</h2>
          <p>Beklenmeyen giderler · Bugün: {fmt(toplamBugün)}</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setShowModal(true)}>+ Gider Ekle</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>Kategori</th><th>Açıklama</th><th>Şube</th><th>Ödeme</th><th style={{textAlign:'right'}}>Tutar</th><th></th></tr></thead>
          <tbody>
            {!liste.length ? (<tr><td colSpan={7}><div className="empty"><p>Anlık gider yok</p></div></td></tr>) :
            liste.map(g => (
              <tr key={g.id}>
                <td className="mono" style={{fontSize:12}}>{fmtDate(g.tarih)}</td>
                <td><span className="badge badge-yellow">{g.kategori}</span></td>
                <td style={{fontSize:12,color:'var(--text3)'}}>{g.aciklama||'---'}</td>
                <td style={{fontSize:12}}>{g.sube}</td>
                <td>
                  {g.odeme_yontemi === 'kart'
                    ? <span className="badge badge-blue">💳 {g.kart_adi || 'Kart'}</span>
                    : <span className="badge badge-gray">💵 Nakit</span>
                  }
                </td>
                <td style={{textAlign:'right'}} className="amount-neg">{fmt(g.tutar)}</td>
                <td><button className="btn btn-danger btn-sm" onClick={()=>sil(g.id)}>İptal</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header"><h3>Anlık Gider Ekle</h3><button className="modal-close" onClick={()=>setShowModal(false)}>✕</button></div>
            <div className="modal-body">
              {dupUyari && (
                <div className="alert-box red mb-16">
                  <strong>⚠️ Benzer kayıt bulundu!</strong> {dupUyari}
                  <div style={{marginTop:8,display:'flex',gap:8}}>
                    <button className="btn btn-danger btn-sm" onClick={()=>kaydet(true)}>Yine de Kaydet</button>
                    <button className="btn btn-secondary btn-sm" onClick={()=>setDupUyari(null)}>Vazgeç</button>
                  </div>
                </div>
              )}
              <div className="form-row cols-2">
                <div className="form-group"><label>Tarih</label><input type="date" value={form.tarih} onChange={e=>setForm({...form,tarih:e.target.value})}/></div>
                <div className="form-group"><label>Kategori</label>
                  <select value={form.kategori} onChange={e=>setForm({...form,kategori:e.target.value})}>
                    {KATEGORILER.map(k=><option key={k}>{k}</option>)}
                  </select>
                </div>
                <div className="form-group"><label>Tutar (₺) *</label><input type="number" value={form.tutar} onChange={e=>setForm({...form,tutar:e.target.value})}/></div>
                <div className="form-group"><label>Şube</label>
                  <select value={form.sube} onChange={e=>setForm({...form,sube:e.target.value})}>
                    {['MERKEZ','TEMA','ZAFER','ALSANCAK','KOYCEGIZ'].map(s=><option key={s}>{s}</option>)}
                  </select>
                </div>

                {/* ÖDEME YÖNTEMİ */}
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Ödeme Yöntemi</label>
                  <div style={{display:'flex',gap:8,marginTop:4}}>
                    <button
                      className={`btn btn-sm ${form.odeme_yontemi==='nakit'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,odeme_yontemi:'nakit',kart_id:''})}>
                      💵 Nakit
                    </button>
                    <button
                      className={`btn btn-sm ${form.odeme_yontemi==='kart'?'btn-primary':'btn-ghost'}`}
                      onClick={()=>setForm({...form,odeme_yontemi:'kart'})}>
                      💳 Kart
                    </button>
                  </div>
                </div>

                {/* KART SEÇİMİ */}
                {form.odeme_yontemi === 'kart' && (
                  <div className="form-group" style={{gridColumn:'1/-1'}}>
                    <label>Kart Seç *</label>
                    <select value={form.kart_id} onChange={e=>setForm({...form,kart_id:e.target.value})}
                      style={{borderColor:!form.kart_id?'var(--yellow)':''}}>
                      <option value="">-- Kart seçin --</option>
                      {kartlar.map(k=>(
                        <option key={k.id} value={k.id}>
                          {k.banka} — {k.kart_adi} (Kalan: {parseInt(k.kalan_limit||0).toLocaleString('tr-TR')} ₺)
                        </option>
                      ))}
                    </select>
                    {form.kart_id && (() => {
                      const k = kartlar.find(x=>x.id===form.kart_id);
                      const tutar = parseFloat(form.tutar)||0;
                      if (!k || tutar <= 0) return null;
                      const kalan = parseFloat(k.kalan_limit||0);
                      if (tutar > kalan) return <span style={{fontSize:11,color:'var(--red)'}}>⚠️ Limit yetersiz! Kalan: {kalan.toLocaleString('tr-TR')} ₺</span>;
                      if (kalan > 0 && (kalan - tutar) / parseFloat(k.limit_tutar) < 0.2) return <span style={{fontSize:11,color:'var(--yellow)'}}>⚠️ Kart doluluk kritik seviyeye yaklaşıyor</span>;
                      return null;
                    })()}
                  </div>
                )}

                {form.odeme_yontemi === 'nakit' && (
                  <div className="alert-box yellow mb-0" style={{gridColumn:'1/-1',fontSize:12,padding:'8px 12px'}}>
                    ❗ Nakit ödeme onay beklemez — direkt kasadan düşer.
                  </div>
                )}
                {form.odeme_yontemi === 'kart' && (
                  <div className="alert-box" style={{gridColumn:'1/-1',fontSize:12,padding:'8px 12px',background:'rgba(74,158,255,0.08)',border:'1px solid rgba(74,158,255,0.3)'}}>
                    💳 Kart borcuna harcama olarak eklenir — kasadan çıkmaz.
                  </div>
                )}

                <div className="form-group" style={{gridColumn:'1/-1'}}><label>Açıklama</label><input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})} placeholder="Ne için ödendi?"/></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={()=>kaydet(false)} disabled={!form.tutar || (form.odeme_yontemi==='kart' && !form.kart_id)}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
