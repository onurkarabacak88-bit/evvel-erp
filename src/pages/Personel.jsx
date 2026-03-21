import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const BOSH = { ad_soyad:'',gorev:'',calisma_turu:'surekli',maas:'',saatlik_ucret:'',
  yemek_ucreti:'',yol_ucreti:'',odeme_gunu:28,baslangic_tarihi:'',sube_id:'',notlar:'' };

export default function Personel() {
  const [aktif, setAktif] = useState([]);
  const [pasif, setPasif] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [tab, setTab] = useState('aktif');
  const [showModal, setShowModal] = useState(false);
  const [duzenleId, setDuzenleId] = useState(null);
  const [form, setForm] = useState(BOSH);
  const [cikisModal, setCikisModal] = useState(null);
  const [cikisNeden, setCikisNeden] = useState('');
  const [msg, setMsg] = useState(null);

  const load = () => {
    api('/personel?aktif=true').then(setAktif);
    api('/personel?aktif=false').then(setPasif);
    api('/subeler').then(setSubeler);
  };
  useEffect(() => { load(); }, []);

  const toast = (m, t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),3000); };

  async function kaydet() {
    try {
      if (duzenleId) await api(`/personel/${duzenleId}`, { method:'PUT', body:form });
      else await api('/personel', { method:'POST', body:form });
      toast(duzenleId ? 'Güncellendi' : 'Personel eklendi');
      setShowModal(false); setForm(BOSH); setDuzenleId(null); load();
    } catch(e) { toast(e.message,'red'); }
  }

  async function cikisYap() {
    try {
      await api(`/personel/${cikisModal.id}/cikis?neden=${encodeURIComponent(cikisNeden)}`, { method:'POST' });
      toast('Çıkış yapıldı');
      setCikisModal(null); setCikisNeden(''); load();
    } catch(e) { toast(e.message,'red'); }
  }

  async function sil(id) {
    if (!confirm('Personeli kalıcı olarak silmek istiyor musunuz?')) return;
    try { await api(`/personel/${id}`, { method:'DELETE' }); toast('Silindi'); load(); }
    catch(e) { toast(e.message,'red'); }
  }

  function duzenleAc(p) {
    setForm({ ad_soyad:p.ad_soyad, gorev:p.gorev||'', calisma_turu:p.calisma_turu,
      maas:p.maas, saatlik_ucret:p.saatlik_ucret, yemek_ucreti:p.yemek_ucreti,
      yol_ucreti:p.yol_ucreti, odeme_gunu:p.odeme_gunu, baslangic_tarihi:p.baslangic_tarihi?.slice(0,10)||'',
      sube_id:p.sube_id||'', notlar:p.notlar||'' });
    setDuzenleId(p.id); setShowModal(true);
  }

  const liste = tab === 'aktif' ? aktif : pasif;
  const toplamMaas = aktif.reduce((s,p) => s + (parseFloat(p.maas)||0), 0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>Personel</h2>
          <p>{aktif.length} aktif · aylık maaş yükü: {fmt(toplamMaas)}</p>
        </div>
        <button className="btn btn-primary" onClick={()=>{setForm(BOSH);setDuzenleId(null);setShowModal(true);}}>+ Personel Ekle</button>
      </div>

      <div className="tabs">
        <div className={`tab ${tab==='aktif'?'active':''}`} onClick={()=>setTab('aktif')}>Aktif ({aktif.length})</div>
        <div className={`tab ${tab==='pasif'?'active':''}`} onClick={()=>setTab('pasif')}>Ayrılanlar ({pasif.length})</div>
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>Ad Soyad</th><th>Görev</th><th>Tür</th>
            <th style={{textAlign:'right'}}>Maaş / Saat</th>
            <th style={{textAlign:'right'}}>Yemek</th>
            <th style={{textAlign:'right'}}>Yol</th>
            <th>Ödeme Günü</th><th>Şube</th><th>Başlangıç</th>
            <th></th>
          </tr></thead>
          <tbody>
            {liste.length === 0 ? (
              <tr><td colSpan={10}><div className="empty"><p>Kayıt yok</p></div></td></tr>
            ) : liste.map(p => (
              <tr key={p.id}>
                <td style={{fontWeight:500}}>{p.ad_soyad}</td>
                <td style={{color:'var(--text3)',fontSize:12}}>{p.gorev||'---'}</td>
                <td><span className={`badge ${p.calisma_turu==='surekli'?'badge-green':'badge-yellow'}`}>
                  {p.calisma_turu==='surekli'?'Sürekli':'Part-Time'}
                </span></td>
                <td style={{textAlign:'right'}} className="amount">
                  {p.calisma_turu==='surekli' ? fmt(p.maas) : `${fmt(p.saatlik_ucret)}/saat`}
                </td>
                <td style={{textAlign:'right',fontSize:12}} className="amount">{fmt(p.yemek_ucreti)}</td>
                <td style={{textAlign:'right',fontSize:12}} className="amount">{fmt(p.yol_ucreti)}</td>
                <td style={{fontSize:12,color:'var(--text3)'}}>Her ayın {p.odeme_gunu}. günü</td>
                <td><span className="badge badge-blue">{p.sube_adi||'---'}</span></td>
                <td className="mono" style={{fontSize:12}}>{fmtDate(p.baslangic_tarihi)}</td>
                <td>
                  <div className="flex gap-8">
                    <button className="btn btn-ghost btn-sm" onClick={()=>duzenleAc(p)}>✏️</button>
                    {tab==='aktif' && (
                      <button className="btn btn-secondary btn-sm" onClick={()=>setCikisModal(p)}>Çıkış</button>
                    )}
                    <button className="btn btn-danger btn-sm" onClick={()=>sil(p.id)}>🗑️</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Ekle/Düzenle Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{duzenleId?'Personel Düzenle':'Yeni Personel'}</h3>
              <button className="modal-close" onClick={()=>setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Ad Soyad *</label>
                  <input value={form.ad_soyad} onChange={e=>setForm({...form,ad_soyad:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Görev</label>
                  <input placeholder="Kasiyer, Müdür..." value={form.gorev} onChange={e=>setForm({...form,gorev:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Çalışma Türü</label>
                  <select value={form.calisma_turu} onChange={e=>setForm({...form,calisma_turu:e.target.value})}>
                    <option value="surekli">Sürekli (Aylık Maaş)</option>
                    <option value="part_time">Part-Time (Saatlik)</option>
                  </select>
                </div>
                {form.calisma_turu==='surekli' ? (
                  <div className="form-group">
                    <label>Aylık Maaş (₺)</label>
                    <input type="number" value={form.maas} onChange={e=>setForm({...form,maas:e.target.value})}/>
                  </div>
                ) : (
                  <div className="form-group">
                    <label>Saatlik Ücret (₺)</label>
                    <input type="number" value={form.saatlik_ucret} onChange={e=>setForm({...form,saatlik_ucret:e.target.value})}/>
                  </div>
                )}
                <div className="form-group">
                  <label>Yemek Ücreti (₺/gün)</label>
                  <input type="number" value={form.yemek_ucreti} onChange={e=>setForm({...form,yemek_ucreti:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Yol Ücreti (₺/gün)</label>
                  <input type="number" value={form.yol_ucreti} onChange={e=>setForm({...form,yol_ucreti:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Ödeme Günü</label>
                  <input type="number" min={1} max={31} value={form.odeme_gunu} onChange={e=>setForm({...form,odeme_gunu:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Şube</label>
                  <select value={form.sube_id} onChange={e=>setForm({...form,sube_id:e.target.value})}>
                    <option value="">Şube seçin</option>
                    {subeler.map(s=><option key={s.id} value={s.id}>{s.ad}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Başlangıç Tarihi</label>
                  <input type="date" value={form.baslangic_tarihi} onChange={e=>setForm({...form,baslangic_tarihi:e.target.value})}/>
                </div>
                <div className="form-group" style={{gridColumn:'1/-1'}}>
                  <label>Notlar</label>
                  <input value={form.notlar} onChange={e=>setForm({...form,notlar:e.target.value})}/>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.ad_soyad}>Kaydet</button>
            </div>
          </div>
        </div>
      )}

      {/* Çıkış Modal */}
      {cikisModal && (
        <div className="modal-overlay">
          <div className="modal" style={{maxWidth:400}}>
            <div className="modal-header">
              <h3>Personel Çıkışı</h3>
              <button className="modal-close" onClick={()=>setCikisModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{marginBottom:16,color:'var(--text2)'}}>
                <strong>{cikisModal.ad_soyad}</strong> pasife alınacak. Veriler silinmez.
              </p>
              <div className="form-group">
                <label>Çıkış Nedeni</label>
                <input placeholder="İstifa, İşten çıkarma..." value={cikisNeden} onChange={e=>setCikisNeden(e.target.value)}/>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setCikisModal(null)}>İptal</button>
              <button className="btn btn-danger" onClick={cikisYap}>Çıkışı Onayla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
