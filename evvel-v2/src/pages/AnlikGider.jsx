import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const KATEGORILER = ['Nakit Alım','Market','Fatura','Kargo','Yemek','Yakıt','Bakım','Diğer'];

export default function AnlikGider() {
  const [liste, setListe] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({tarih: new Date().toISOString().split('T')[0], kategori:'Diğer', tutar:'', aciklama:'', sube:'MERKEZ'});
  const [msg, setMsg] = useState(null);

  const load = () => api('/anlik-gider').then(setListe);
  useEffect(() => { load(); }, []);
  const toast = (m, t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),3000); };

  async function kaydet() {
    try {
      await api('/anlik-gider', { method:'POST', body: form });
      toast('Gider kaydedildi, kasadan düşüldü');
      setShowModal(false);
      setForm({tarih: new Date().toISOString().split('T')[0], kategori:'Diğer', tutar:'', aciklama:'', sube:'MERKEZ'});
      load();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function sil(id) {
    if (!confirm('Bu gideri iptal et? Kasaya geri yüklenecek.')) return;
    try { await api(`/anlik-gider/${id}`, { method:'DELETE' }); toast('İptal edildi, kasaya iade edildi', 'yellow'); load(); }
    catch(e) { toast(e.message, 'red'); }
  }

  const toplamBugün = liste.filter(g => g.tarih === new Date().toISOString().split('T')[0]).reduce((s,g)=>s+parseFloat(g.tutar),0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>Anlık Gider</h2>
          <p>Beklenmeyen giderler — direkt kasadan düşer · Bugün: {fmt(toplamBugün)}</p>
        </div>
        <button className="btn btn-primary" onClick={()=>setShowModal(true)}>+ Gider Ekle</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarih</th><th>Kategori</th><th>Açıklama</th><th>Şube</th><th style={{textAlign:'right'}}>Tutar</th><th></th></tr></thead>
          <tbody>
            {!liste.length ? (<tr><td colSpan={6}><div className="empty"><p>Anlık gider yok</p></div></td></tr>) :
            liste.map(g => (
              <tr key={g.id}>
                <td className="mono" style={{fontSize:12}}>{fmtDate(g.tarih)}</td>
                <td><span className="badge badge-yellow">{g.kategori}</span></td>
                <td style={{fontSize:12,color:'var(--text3)'}}>{g.aciklama||'---'}</td>
                <td style={{fontSize:12}}>{g.sube}</td>
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
              <div className="alert-box yellow mb-16">❗ Bu gider onay beklemez — direkt kasadan düşer.</div>
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
                <div className="form-group" style={{gridColumn:'1/-1'}}><label>Açıklama</label><input value={form.aciklama} onChange={e=>setForm({...form,aciklama:e.target.value})} placeholder="Ne için ödendi?"/></div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.tutar}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
