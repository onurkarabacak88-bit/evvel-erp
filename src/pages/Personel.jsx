import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const BOSH = {
  ad_soyad:'', gorev:'', calisma_turu:'surekli', maas:'', saatlik_ucret:'',
  yemek_ucreti:'', yol_ucreti:'', odeme_gunu:28, baslangic_tarihi:'', sube_id:'', notlar:''
};

const AY_ADLARI = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                   'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

export default function Personel() {
  const bugun = new Date();
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

  // Aylık kayıt
  const [maasTab, setMaasTab] = useState('liste'); // 'liste' | 'aylik'
  const [aylikYil, setAylikYil] = useState(bugun.getFullYear());
  const [aylikAy, setAylikAy] = useState(bugun.getMonth() + 1);
  const [aylikData, setAylikData] = useState(null);
  const [aylikLoading, setAylikLoading] = useState(false);
  const [kayitForm, setKayitForm] = useState({});  // {personel_id: {calisma_saati, fazla_mesai_saat, ...}}
  const [gecmisModal, setGecmisModal] = useState(null);
  const [gecmisData, setGecmisData] = useState([]);

  const load = () => {
    api('/personel?aktif=true').then(setAktif);
    api('/personel?aktif=false').then(setPasif);
    api('/subeler').then(setSubeler);
  };

  const loadAylik = () => {
    setAylikLoading(true);
    api(`/personel-aylik?yil=${aylikYil}&ay=${aylikAy}`)
      .then(data => {
        setAylikData(data);
        // Form başlangıç değerlerini set et
        const f = {};
        data.personeller.forEach(p => {
          f[p.personel_id] = {
            calisma_saati: p.calisma_saati || '',
            fazla_mesai_saat: p.fazla_mesai_saat || '',
            eksik_gun: p.eksik_gun || '',
            raporlu_gun: p.raporlu_gun || '',
            rapor_kesinti: p.rapor_kesinti || false,
            manuel_duzeltme: p.manuel_duzeltme || '',
            not_aciklama: p.not_aciklama || '',
          };
        });
        setKayitForm(f);
      })
      .catch(() => toast('Veri yüklenemedi', 'red'))
      .finally(() => setAylikLoading(false));
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (maasTab === 'aylik') loadAylik(); }, [maasTab, aylikYil, aylikAy]);

  const toast = (m, t='green') => { setMsg({m,t}); setTimeout(()=>setMsg(null),3500); };

  async function kaydet() {
    const body = {
      ad_soyad: form.ad_soyad,
      gorev: form.gorev || null,
      calisma_turu: form.calisma_turu,
      maas: parseFloat(form.maas) || 0,
      saatlik_ucret: parseFloat(form.saatlik_ucret) || 0,
      yemek_ucreti: parseFloat(form.yemek_ucreti) || 0,
      yol_ucreti: parseFloat(form.yol_ucreti) || 0,
      odeme_gunu: parseInt(form.odeme_gunu) || 28,
      sube_id: form.sube_id ? parseInt(form.sube_id) : null,
      baslangic_tarihi: form.baslangic_tarihi || null,
      notlar: form.notlar || null,
    };
    try {
      if (duzenleId) await api(`/personel/${duzenleId}`, { method:'PUT', body });
      else await api('/personel', { method:'POST', body });
      toast(duzenleId ? 'Güncellendi' : 'Personel eklendi');
      setShowModal(false); setForm(BOSH); setDuzenleId(null); load();
    } catch(e) { toast(e.message,'red'); }
  }

  async function cikisYap() {
    try {
      await api(`/personel/${cikisModal.id}/cikis?neden=${encodeURIComponent(cikisNeden)}`, { method:'POST' });
      toast('Çıkış yapıldı — bekleyen maaş planları iptal edildi');
      setCikisModal(null); setCikisNeden(''); load();
    } catch(e) { toast(e.message,'red'); }
  }

  async function sil(id) {
    if (!confirm('Personeli kalıcı olarak silmek istiyor musunuz?')) return;
    try { await api(`/personel/${id}`, { method:'DELETE' }); toast('Silindi'); load(); }
    catch(e) { toast(e.message,'red'); }
  }

  async function maasKaydet(pid) {
    const f = kayitForm[pid] || {};
    const body = {
      calisma_saati: parseFloat(f.calisma_saati) || 0,
      fazla_mesai_saat: parseFloat(f.fazla_mesai_saat) || 0,
      eksik_gun: parseFloat(f.eksik_gun) || 0,
      raporlu_gun: parseFloat(f.raporlu_gun) || 0,
      rapor_kesinti: f.rapor_kesinti || false,
      manuel_duzeltme: parseFloat(f.manuel_duzeltme) || 0,
      not_aciklama: f.not_aciklama || null,
    };
    try {
      const res = await api(`/personel-aylik/${pid}?yil=${aylikYil}&ay=${aylikAy}`, { method:'POST', body });
      toast(`Kaydedildi — Net: ${parseInt(res.hesaplanan_net).toLocaleString('tr-TR')} ₺`);
      loadAylik();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function maasOnayla(pid) {
    if (!confirm('Maaş kaydını onaylıyor musunuz? Onaylanan kayıt değiştirilemez.')) return;
    try {
      await api(`/personel-aylik/${pid}/onayla?yil=${aylikYil}&ay=${aylikAy}`, { method:'POST' });
      toast('Onaylandı');
      loadAylik();
    } catch(e) { toast(e.message, 'red'); }
  }

  async function gecmisAc(p) {
    setGecmisModal(p);
    const data = await api(`/personel-aylik/${p.personel_id}/gecmis`).catch(() => []);
    setGecmisData(data);
  }

  function duzenleAc(p) {
    setForm({
      ad_soyad:p.ad_soyad, gorev:p.gorev||'', calisma_turu:p.calisma_turu,
      maas:p.maas, saatlik_ucret:p.saatlik_ucret, yemek_ucreti:p.yemek_ucreti,
      yol_ucreti:p.yol_ucreti, odeme_gunu:p.odeme_gunu,
      baslangic_tarihi:p.baslangic_tarihi?.slice(0,10)||'',
      sube_id:p.sube_id||'', notlar:p.notlar||''
    });
    setDuzenleId(p.id); setShowModal(true);
  }

  const liste = tab === 'aktif' ? aktif : pasif;
  const toplamTahmini = aktif.reduce((s,p) =>
    s + (parseFloat(p.maas)||0) + (parseFloat(p.yemek_ucreti)||0) + (parseFloat(p.yol_ucreti)||0), 0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between">
        <div>
          <h2>Personel</h2>
          <p>{aktif.length} aktif · tahmini aylık yük: {fmt(toplamTahmini)}</p>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-primary" onClick={()=>{setForm(BOSH);setDuzenleId(null);setShowModal(true);}}>+ Personel Ekle</button>
        </div>
      </div>

      {/* Ana sekmeler */}
      <div className="tabs" style={{marginBottom:16}}>
        <div className={`tab ${maasTab==='liste'?'active':''}`} onClick={()=>setMaasTab('liste')}>Personel Listesi</div>
        <div className={`tab ${maasTab==='aylik'?'active':''}`} onClick={()=>setMaasTab('aylik')}>💰 Aylık Maaş Kayıt</div>
      </div>

      {/* ── PERSONEL LİSTESİ ── */}
      {maasTab === 'liste' && (<>
        <div className="tabs" style={{marginBottom:12}}>
          <div className={`tab ${tab==='aktif'?'active':''}`} onClick={()=>setTab('aktif')}>Aktif ({aktif.length})</div>
          <div className={`tab ${tab==='pasif'?'active':''}`} onClick={()=>setTab('pasif')}>Ayrılanlar ({pasif.length})</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Ad Soyad</th><th>Görev</th><th>Tür</th>
              <th style={{textAlign:'right'}}>Maaş / Saat</th>
              <th style={{textAlign:'right'}}>Yan Haklar</th>
              <th style={{textAlign:'right'}}>Toplam Yük</th>
              <th>Ödeme Günü</th><th>Şube</th><th></th>
            </tr></thead>
            <tbody>
              {liste.length === 0 ? (
                <tr><td colSpan={9}><div className="empty"><p>Kayıt yok</p></div></td></tr>
              ) : liste.map(p => {
                const yanHak = (parseFloat(p.yemek_ucreti)||0) + (parseFloat(p.yol_ucreti)||0);
                const toplam = p.calisma_turu==='surekli'
                  ? (parseFloat(p.maas)||0) + yanHak : yanHak;
                return (
                  <tr key={p.id}>
                    <td style={{fontWeight:500}}>{p.ad_soyad}</td>
                    <td style={{color:'var(--text3)',fontSize:12}}>{p.gorev||'---'}</td>
                    <td><span className={`badge ${p.calisma_turu==='surekli'?'badge-green':'badge-yellow'}`}>
                      {p.calisma_turu==='surekli'?'Sürekli':'Part-Time'}
                    </span></td>
                    <td style={{textAlign:'right'}} className="amount">
                      {p.calisma_turu==='surekli' ? fmt(p.maas) : `${fmt(p.saatlik_ucret)}/saat`}
                    </td>
                    <td style={{textAlign:'right',fontSize:12,color:'var(--text3)'}}>
                      {yanHak > 0 ? `${fmt(yanHak)}` : '—'}
                    </td>
                    <td style={{textAlign:'right',fontWeight:600}} className={toplam>0?'amount-neg':''}>
                      {p.calisma_turu==='surekli' ? fmt(toplam) : <span style={{color:'var(--text3)',fontSize:11}}>Saat girilince</span>}
                    </td>
                    <td style={{fontSize:12,color:'var(--text3)'}}>Her ayın {p.odeme_gunu}. günü</td>
                    <td><span className="badge badge-blue">{p.sube_adi||'---'}</span></td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      </>)}

      {/* ── AYLIK MAAŞ KAYIT ── */}
      {maasTab === 'aylik' && (
        <div>
          {/* Ay/Yıl seçimi */}
          <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:16,flexWrap:'wrap'}}>
            <select value={aylikAy} onChange={e=>setAylikAy(parseInt(e.target.value))}
              style={{padding:'6px 12px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg2)'}}>
              {AY_ADLARI.slice(1).map((_,i)=>(
                <option key={i+1} value={i+1}>{AY_ADLARI[i+1]}</option>
              ))}
            </select>
            <select value={aylikYil} onChange={e=>setAylikYil(parseInt(e.target.value))}
              style={{padding:'6px 12px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg2)'}}>
              {[bugun.getFullYear()-1, bugun.getFullYear(), bugun.getFullYear()+1].map(y=>(
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            {aylikData && (
              <div style={{marginLeft:'auto',fontSize:13,color:'var(--text3)'}}>
                Toplam tahmin: <strong style={{color:'var(--text1)'}}>{fmt(aylikData.toplam_tahmini)}</strong>
              </div>
            )}
          </div>

          {aylikLoading ? (
            <div style={{textAlign:'center',padding:40,color:'var(--text3)'}}>Yükleniyor...</div>
          ) : aylikData && (
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              {aylikData.personeller.map(p => {
                const f = kayitForm[p.personel_id] || {};
                const durum = p.durum;
                const onaylandi = durum === 'onaylandi';
                return (
                  <div key={p.personel_id} style={{
                    background:'var(--bg2)',border:`1px solid ${onaylandi?'var(--green)':'var(--border)'}`,
                    borderRadius:10,padding:'14px 16px'
                  }}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                      <div>
                        <span style={{fontWeight:700,fontSize:14}}>{p.ad_soyad}</span>
                        <span style={{fontSize:11,color:'var(--text3)',marginLeft:8}}>{p.gorev}</span>
                        <span className={`badge ${p.calisma_turu==='surekli'?'badge-green':'badge-yellow'}`}
                          style={{marginLeft:8,fontSize:10}}>
                          {p.calisma_turu==='surekli'?'Sürekli':'Part-Time'}
                        </span>
                      </div>
                      <div style={{display:'flex',gap:8,alignItems:'center'}}>
                        <span style={{
                          fontSize:11,padding:'3px 8px',borderRadius:4,fontWeight:600,
                          background: onaylandi?'rgba(0,200,100,0.15)': durum==='taslak'?'rgba(250,200,0,0.15)':'rgba(150,150,150,0.15)',
                          color: onaylandi?'var(--green)': durum==='taslak'?'var(--yellow)':'var(--text3)'
                        }}>
                          {onaylandi?'✓ Onaylandı': durum==='taslak'?'Kaydedildi':'Girilmedi'}
                        </span>
                        <button className="btn btn-ghost btn-sm" onClick={()=>gecmisAc(p)}>📋 Geçmiş</button>
                      </div>
                    </div>

                    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:10}}>
                      {p.calisma_turu === 'surekli' ? (<>
                        <div>
                          <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Eksik Gün</label>
                          <input type="number" min={0} max={31} step={0.5}
                            value={f.eksik_gun ?? ''} disabled={onaylandi}
                            onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,eksik_gun:e.target.value}}))}
                            style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                              background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}/>
                        </div>
                        <div>
                          <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Raporlu Gün</label>
                          <input type="number" min={0} max={31} step={0.5}
                            value={f.raporlu_gun ?? ''} disabled={onaylandi}
                            onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,raporlu_gun:e.target.value}}))}
                            style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                              background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}/>
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:6,paddingTop:18}}>
                          <input type="checkbox" checked={f.rapor_kesinti||false} disabled={onaylandi}
                            onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,rapor_kesinti:e.target.checked}}))}
                            id={`rapor_${p.personel_id}`}/>
                          <label htmlFor={`rapor_${p.personel_id}`} style={{fontSize:11,color:'var(--text3)',cursor:'pointer'}}>
                            Rapordan kesinti
                          </label>
                        </div>
                      </>) : (<>
                        <div>
                          <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Çalışma Saati *</label>
                          <input type="number" min={0} step={0.5}
                            value={f.calisma_saati ?? ''} disabled={onaylandi}
                            onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,calisma_saati:e.target.value}}))}
                            style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                              background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}/>
                          <span style={{fontSize:10,color:'var(--text3)'}}>{fmt(p.saatlik_ucret)}/saat</span>
                        </div>
                      </>)}

                      <div>
                        <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Fazla Mesai (saat)</label>
                        <input type="number" min={0} step={0.5}
                          value={f.fazla_mesai_saat ?? ''} disabled={onaylandi}
                          onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,fazla_mesai_saat:e.target.value}}))}
                          style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                            background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}/>
                        <span style={{fontSize:10,color:'var(--text3)'}}>×1.5 ücret</span>
                      </div>

                      <div>
                        <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Manuel Düzeltme (₺)</label>
                        <input type="number" step={1}
                          value={f.manuel_duzeltme ?? ''} disabled={onaylandi}
                          onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,manuel_duzeltme:e.target.value}}))}
                          style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                            background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}
                          placeholder="+/- tutar"/>
                      </div>

                      <div>
                        <label style={{fontSize:11,color:'var(--text3)',display:'block',marginBottom:3}}>Not</label>
                        <input value={f.not_aciklama ?? ''} disabled={onaylandi}
                          onChange={e=>setKayitForm(prev=>({...prev,[p.personel_id]:{...f,not_aciklama:e.target.value}}))}
                          style={{width:'100%',padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',
                            background:onaylandi?'var(--bg3)':'var(--bg1)',color:'var(--text1)'}}/>
                      </div>
                    </div>

                    {/* Net hesap özeti */}
                    <div style={{
                      marginTop:12,padding:'10px 12px',
                      background:'var(--bg3)',borderRadius:6,
                      display:'flex',justifyContent:'space-between',alignItems:'center'
                    }}>
                      <div style={{fontSize:12,color:'var(--text3)'}}>
                        {p.calisma_turu==='surekli'
                          ? `Baz: ${fmt(p.maas)} · Yan: ${fmt(p.yemek_ucreti+p.yol_ucreti)}`
                          : `Saatlik: ${fmt(p.saatlik_ucret)} · Yan: ${fmt(p.yemek_ucreti+p.yol_ucreti)}`
                        }
                      </div>
                      <div style={{fontSize:16,fontWeight:700,color:'#4a9eff'}}>
                        Net: {fmt(p.hesaplanan_net)}
                        {durum === 'tahmini' && <span style={{fontSize:10,color:'var(--text3)',marginLeft:4}}>TAHMİNİ</span>}
                      </div>
                      {!onaylandi && (
                        <div style={{display:'flex',gap:8}}>
                          <button className="btn btn-primary btn-sm" onClick={()=>maasKaydet(p.personel_id)}>
                            💾 Kaydet
                          </button>
                          {durum === 'taslak' && (
                            <button className="btn btn-secondary btn-sm" onClick={()=>maasOnayla(p.personel_id)}>
                              ✓ Onayla
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

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
                  <label>Yemek Ücreti (₺/ay)</label>
                  <input type="number" value={form.yemek_ucreti} onChange={e=>setForm({...form,yemek_ucreti:e.target.value})}/>
                </div>
                <div className="form-group">
                  <label>Yol Ücreti (₺/ay)</label>
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
                <strong>{cikisModal.ad_soyad}</strong> pasife alınacak.
                Bekleyen maaş planları iptal edilecek.
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

      {/* Geçmiş Modal */}
      {gecmisModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setGecmisModal(null)}>
          <div className="modal" style={{maxWidth:500}}>
            <div className="modal-header">
              <h3>📋 {gecmisModal.ad_soyad} — Maaş Geçmişi</h3>
              <button className="modal-close" onClick={()=>setGecmisModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {gecmisData.length === 0 ? (
                <p style={{color:'var(--text3)',textAlign:'center',padding:20}}>Henüz kayıt yok</p>
              ) : (
                <table style={{width:'100%',fontSize:12}}>
                  <thead>
                    <tr style={{borderBottom:'1px solid var(--border)'}}>
                      <th style={{padding:'6px 8px',textAlign:'left'}}>Dönem</th>
                      <th style={{padding:'6px 8px',textAlign:'right'}}>Net Maaş</th>
                      <th style={{padding:'6px 8px',textAlign:'center'}}>Fazla Mesai</th>
                      <th style={{padding:'6px 8px',textAlign:'center'}}>Eksik</th>
                      <th style={{padding:'6px 8px',textAlign:'center'}}>Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gecmisData.map((r,i) => (
                      <tr key={i} style={{borderBottom:'1px solid var(--border)'}}>
                        <td style={{padding:'6px 8px'}}>{AY_ADLARI[r.ay]} {r.yil}</td>
                        <td style={{padding:'6px 8px',textAlign:'right',fontWeight:600,color:'#4a9eff'}}>
                          {fmt(r.hesaplanan_net)}
                        </td>
                        <td style={{padding:'6px 8px',textAlign:'center',color:'var(--text3)'}}>
                          {r.fazla_mesai_saat > 0 ? `${r.fazla_mesai_saat} saat` : '—'}
                        </td>
                        <td style={{padding:'6px 8px',textAlign:'center',color:r.eksik_gun>0?'var(--red)':'var(--text3)'}}>
                          {r.eksik_gun > 0 ? `${r.eksik_gun} gün` : '—'}
                        </td>
                        <td style={{padding:'6px 8px',textAlign:'center'}}>
                          <span style={{
                            fontSize:10,padding:'2px 6px',borderRadius:4,
                            background:r.durum==='onaylandi'?'rgba(0,200,100,0.15)':'rgba(250,200,0,0.15)',
                            color:r.durum==='onaylandi'?'var(--green)':'var(--yellow)'
                          }}>
                            {r.durum==='onaylandi'?'Onaylı':'Taslak'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
