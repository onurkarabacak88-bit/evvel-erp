import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot } from 'recharts';

export default function Panel({ onNavigate }) {
  const nav = onNavigate || (() => {});

  const [panel, setPanel] = useState(null);
  const [uyarilar, setUyarilar] = useState([]);
  const [onaylar, setOnaylar] = useState([]);
  const [anomali, setAnomali] = useState(null);
  const [loading, setLoading] = useState(true);
  const [odemeModal, setOdemeModal] = useState(null);
  const [hizliModal, setHizliModal] = useState(null);
  const [gecmisOverlay, setGecmisOverlay] = useState(null); // {baslik, endpoint}
  const [gecmisData, setGecmisData] = useState([]);
  const [topluUygula, setTopluUygula] = useState(false);
  const [loadingBtn, setLoadingBtn] = useState(false);
  const [manuelTutar, setManuelTutar] = useState('');
  const [msg, setMsg] = useState(null);
  const [sabitGiderOzet, setSabitGiderOzet] = useState({});
  const [sabitGiderUyarilar, setSabitGiderUyarilar] = useState([]);
  const [kiraModal, setKiraModal] = useState(null);
  const [kiraForm, setKiraForm] = useState({});
  const [kiraLoading, setKiraLoading] = useState(false);
  const [odenenGiderler, setOdenenGiderler] = useState([]);
  const [erteleModal, setErteleModal] = useState(null); // {odemeId, aciklama, mevcutTarih}
  const [acikOdemeler, setAcikOdemeler] = useState(new Set());
  const [yaklaşanAcik, setYaklaşanAcik] = useState(false);
  const [erteleTarih, setErteleTarih] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api('/panel'),
      api('/uyarilar'),
      api('/onay-kuyrugu'),
      api('/kasa-kontrol').catch(() => null),
      api('/sabit-giderler/odemeler').catch(() => null),
      api('/sabit-giderler/uyarilar').catch(() => null),
      api('/sabit-giderler/odenenler').catch(() => null),
    ]).then(([p, u, o, a, sg, su, og]) => {
      setPanel(p); setUyarilar(u || []); setOnaylar(o || []); setAnomali(a);
      setSabitGiderOzet(sg?.ozet || {});
      setSabitGiderUyarilar(su?.uyarilar || []);
      setOdenenGiderler(og || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // Ticker animasyon CSS
    const style = document.createElement('style');
    style.innerHTML = '@keyframes ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }';
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3500); };

  async function odemeOnayla(odemeId, tutar) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      const params = tutar ? `?tutar=${tutar}` : '';
      await api(`/odeme-plani/${odemeId}/ode${params}`, { method: 'POST' });
      const gosterilenTutar = tutar || odemeModal?.tutar;
      toast(`✓ Ödeme onaylandı${gosterilenTutar ? ` (${parseFloat(gosterilenTutar).toLocaleString('tr-TR')} ₺)` : ''} — kasadan düşüldü`);
      setOdemeModal(null); setManuelTutar(''); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  function odemeErteleAc(odemeId, aciklama, mevcutTarih) {
    // 7 gün sonrasını default olarak göster
    const d = new Date(mevcutTarih || new Date());
    d.setDate(d.getDate() + 7);
    setErteleTarih(d.toISOString().split('T')[0]);
    setErteleModal({ odemeId, aciklama, mevcutTarih });
  }

  async function odemeErteleOnayla() {
    if (loadingBtn || !erteleTarih) return;
    setLoadingBtn(true);
    try {
      await api(`/odeme-plani/${erteleModal.odemeId}/ertele?yeni_tarih=${erteleTarih}`, { method: 'POST' });
      toast(`Ödeme ${new Date(erteleTarih).toLocaleDateString('tr-TR')} tarihine ertelendi`);
      setErteleModal(null); setErteleTarih(''); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function onayKuyrukOnayla(oid) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      await api(`/onay-kuyrugu/${oid}/onayla`, { method: 'POST' });
      toast('✓ Onaylandı — kasadan düşüldü'); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function onayKuyrukReddet(oid) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      await api(`/onay-kuyrugu/${oid}/reddet`, { method: 'POST' });
      toast('Reddedildi', 'yellow'); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function planUret() {
    try {
      const r = await api('/odeme-plani/uret', { method: 'POST' });
      if (r.toplam === 0) {
        toast(`ℹ️ Yeni plan üretilmedi — bu ay için zaten üretilmiş veya aktif kayıt yok`, 'green');
      } else {
        toast(`✓ ${r.toplam} ödeme planı üretildi`);
      }
      if (r.atlanan && r.atlanan.length > 0) {
        console.log('Atlananlar:', r.atlanan);
      }
      load();
    } catch (e) { toast(e.message || 'Plan üretilemedi', 'red'); }
  }

  async function gecmisAc(baslik, endpoint) {
    setGecmisOverlay({ baslik, endpoint });
    try {
      const data = await api(endpoint);
      setGecmisData(Array.isArray(data) ? data.slice(0, 20) : []);
    } catch { setGecmisData([]); }
  }

  async function topluOnerUygula() {
    const uygulanabilir = (panel.oneriler || []).filter(o => o.odeme_id && o.tavsiye_tutar > 0);
    if (!uygulanabilir.length) return;
    const toplamTutar = uygulanabilir.reduce((s, o) => s + o.tavsiye_tutar, 0);
    const kasaSonrasi = kasa - toplamTutar;
    const uyari = kasaSonrasi < 0 ? `\n⚠️ UYARI: Kasa eksiye düşecek! (${kasaSonrasi.toLocaleString('tr-TR')} ₺)` : '';
    if (!confirm(`${uygulanabilir.length} ödeme tek seferde uygulanacak.\nToplam: ${toplamTutar.toLocaleString('tr-TR')} ₺\nİşlem sonrası kasa: ${kasaSonrasi.toLocaleString('tr-TR')} ₺${uyari}\n\nOnaylıyor musunuz?`)) return;
    setTopluUygula(true);
    try {
      // Tek transaction — biri başarısız olursa hepsi rollback
      const r = await api('/toplu-odeme', {
        method: 'POST',
        body: JSON.stringify({
          odemeler: uygulanabilir.map(o => ({ odeme_id: o.odeme_id, tutar: o.tavsiye_tutar }))
        })
      });
      toast(`✓ ${r.uygulanan}/${uygulanabilir.length} ödeme uygulandı`);
      load();
    } catch (e) {
      toast(`Toplu ödeme başarısız: ${e.message}`, 'red');
    } finally {
      setTopluUygula(false);
    }
  }

  async function hizliKaydet(tip, form) {
    try {
      const endpointMap = { ciro: '/ciro', gider: '/anlik-gider', dis_kaynak: '/dis-kaynak' };
      await api(endpointMap[tip], { method: 'POST', body: JSON.stringify(form) });
      const mesajMap = {
        ciro: `✓ Ciro kaydedildi (${((form.nakit||0)+(form.pos||0)+(form.online||0)).toLocaleString('tr-TR')} ₺)`,
        gider: `✓ Gider eklendi: ${form.aciklama || form.kategori} (${(form.tutar||0).toLocaleString('tr-TR')} ₺)`,
        dis_kaynak: `✓ Gelir kaydedildi (${(form.tutar||0).toLocaleString('tr-TR')} ₺)`,
      };
      toast(mesajMap[tip] || '✓ Kaydedildi');
      setHizliModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 12 }}>
      <div className="spinner" />
      <span style={{ fontSize: 13, color: 'var(--text3)' }}>Finans motoru çalışıyor...</span>
    </div>
  );

  if (!panel) return (
    <div className="empty">
      <p>Veri yüklenemedi</p>
      <button className="btn btn-primary" onClick={load}>Tekrar Dene</button>
    </div>
  );

  const durum = panel.genel_durum || 'SAGLIKLI';
  const kasa = parseFloat(panel.kasa) || 0;
  const serbest = parseFloat(panel.serbest_nakit) || 0;
  const yuk7 = parseFloat(panel.yuk_7) || 0;
  const yuk15 = parseFloat(panel.yuk_15) || 0;
  const yuk30 = parseFloat(panel.yuk_30) || 0;
  const netAkis = parseFloat(panel.net_akis_30) || 0;
  const kasDayan = parseInt(panel.kac_gun_dayanir) || 999;
  const buAyCiro = parseFloat(panel.bu_ay_ciro) || 0;
  const riskGunu = panel.risk_gunu;
  const gelir30 = parseFloat(panel.son_30_gelir) || 0;
  const gider30 = parseFloat(panel.son_30_gider) || 0;

  const DC = {
    KRITIK:   { renk: 'var(--red)',    bg: 'rgba(220,50,50,0.08)',  ikon: '🚨', label: 'KRİTİK' },
    UYARI:    { renk: 'var(--yellow)', bg: 'rgba(220,160,0,0.08)', ikon: '⚠️', label: 'UYARI' },
    SAGLIKLI: { renk: 'var(--green)',  bg: 'rgba(76,175,132,0.08)', ikon: '✅', label: 'SAĞLIKLI' },
  };
  const dc = DC[durum] || DC.SAGLIKLI;

  const kritikler = uyarilar.filter(u => u.seviye === 'KRITIK');
  const diger = uyarilar.filter(u => u.seviye !== 'KRITIK');
  const tumUyarilar = [...kritikler, ...diger];

  const simData = (panel.simulasyon || []).map(g => ({
    tarih: String(g.tarih || '').slice(5),
    tarihFull: g.tarih,
    mevcut: parseFloat(g.kasa_tahmini) || 0,
    onerili: parseFloat(g.kasa_tahmini_onerili) || 0,
    risk: g.risk,
  }));

  // Risk günü simülasyonda işaretle
  const riskDot = simData.find(g => g.risk);

  const riskBar = Math.min(100, yuk30 > 0 ? (yuk30 / Math.max(kasa, 1)) * 100 : 0);
  const riskRenk = kasa < yuk7 ? 'var(--red)' : kasa < yuk30 ? 'var(--yellow)' : 'var(--green)';

  return (
    <div className="page">
      {msg && (
        <div className={`alert-box ${msg.t}`} style={{ position: 'sticky', top: 0, zIndex: 20, marginBottom: 12 }}>
          {msg.m}
        </div>
      )}

      {/* ── KATMAN 1: DURUM & ALARM ── */}
      <div style={{
        background: dc.bg, border: `1px solid ${dc.renk}`,
        borderRadius: 10, padding: '14px 18px', marginBottom: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 28 }}>{dc.ikon}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: dc.renk }}>{dc.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              {panel.ozet?.kritik > 0 ? `${panel.ozet.kritik} kritik · ` : ''}
              {panel.ozet?.uyari > 0 ? `${panel.ozet.uyari} uyarı · ` : ''}
              {new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onaylar.length > 0 && (
            <span className="badge badge-yellow" style={{ cursor: 'pointer' }} onClick={() => nav('onay')}>
              🔔 {onaylar.length} onay bekliyor
            </span>
          )}
          {anomali?.sorunlu > 0 && (
            <span className="badge badge-red" style={{ cursor: 'pointer' }} onClick={() => nav('ledger')}>
              ⚠️ {anomali.sorunlu} kasa anomalisi
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={planUret}>⚙️ Plan Üret</button>
          <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
        </div>
      </div>

      {/* Kira/Sözleşme Uyarıları */}
      {sabitGiderUyarilar.length > 0 && (
        <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
          {sabitGiderUyarilar.map((u,i)=>{
            const kritik = u.seviye === 'KRITIK';
            const renk = kritik ? 'var(--red)' : 'var(--yellow)';
            const bgRenk = kritik ? 'rgba(220,50,50,0.07)' : 'rgba(220,160,0,0.07)';
            const btnLabel = u.aksiyon === 'TUTAR_GUNCELLE' ? '📈 Tutar Güncelle' : '🔄 Sözleşmeyi Uzat';
            return (
              <div key={i} style={{
                background: bgRenk, border: `1px solid ${renk}`,
                borderRadius:8, padding:'12px 16px',
                display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12
              }}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13,color:renk}}>{u.mesaj}</div>
                  {u.alt_mesaj && (
                    <div style={{fontSize:11,color:'var(--text2)',marginTop:4}}>{u.alt_mesaj}</div>
                  )}
                  <div style={{fontSize:11,color:'var(--text3)',marginTop:4}}>
                    <span style={{marginRight:6}}>
                      {u.aksiyon === 'TUTAR_GUNCELLE' ? '📈 Kira Artışı' : '📋 Sözleşme Bitişi'}
                    </span>
                    · Tarih: {u.tarih} ·{' '}
                    {u.gun_kalan >= 0
                      ? <span style={{color:'var(--yellow)'}}>{u.gun_kalan} gün kaldı</span>
                      : <span style={{color:'var(--red)',fontWeight:600}}>{Math.abs(u.gun_kalan)} gün geçti</span>
                    }
                    {u.durduruldu && (
                      <span style={{marginLeft:8,color:'var(--red)',fontWeight:700}}>
                        · ⛔ Plan durduruldu
                      </span>
                    )}
                  </div>
                </div>
                <button className="btn btn-sm" style={{
                  background:renk, color:'#fff', border:'none', whiteSpace:'nowrap', flexShrink:0
                }} onClick={()=>{
                  setKiraModal(u);
                  setKiraForm({
                    tutar: u.tutar || '',
                    gecerlilik_tarihi: new Date().toISOString().split('T')[0],
                    kira_artis_periyot: '',
                    sozlesme_sure_ay: '',
                  });
                }}>
                  {btnLabel}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Kira / Sözleşme Güncelleme Modal */}
      {kiraModal && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setKiraModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>
                {kiraModal.aksiyon==='TUTAR_GUNCELLE' ? '📈 Kira Tutarı Güncelle' : '🔄 Sözleşme Uzat / Yenile'}
              </h3>
              <button className="modal-close" onClick={()=>setKiraModal(null)}>✕</button>
            </div>
            <div className="modal-body">

              {/* Mevcut durum özeti */}
              <div style={{padding:'10px 14px',background:'rgba(220,50,50,0.07)',
                borderRadius:8,border:'1px solid var(--red)',marginBottom:16}}>
                <div style={{fontWeight:700,fontSize:14}}>{kiraModal.gider_adi}</div>
                <div style={{fontSize:12,color:'var(--text2)',marginTop:4,display:'flex',gap:16,flexWrap:'wrap'}}>
                  <span>Mevcut tutar: <strong>{parseInt(kiraModal.tutar).toLocaleString('tr-TR')} ₺</strong></span>
                  {kiraModal.aksiyon==='TUTAR_GUNCELLE'
                    ? <span style={{color:'var(--red)'}}>Artış tarihi: <strong>{kiraModal.tarih}</strong>
                        {kiraModal.gun_kalan < 0 && ` — ${Math.abs(kiraModal.gun_kalan)} gün geçti`}
                      </span>
                    : <span style={{color:'var(--red)'}}>Sözleşme bitişi: <strong>{kiraModal.tarih}</strong>
                        {kiraModal.gun_kalan < 0 && ` — ${Math.abs(kiraModal.gun_kalan)} gün geçti`}
                      </span>
                  }
                </div>
              </div>

              {/* INLINE FORM */}
              <div className="form-row cols-2">

                {/* Yeni tutar — her iki tipte de */}
                <div className="form-group">
                  <label>Yeni Tutar (₺) *</label>
                  <input type="number" value={kiraForm.tutar}
                    onChange={e=>setKiraForm({...kiraForm,tutar:e.target.value})}
                    placeholder={String(kiraModal.tutar)} />
                  {kiraForm.tutar && parseFloat(kiraForm.tutar) > parseFloat(kiraModal.tutar) && (
                    <span style={{fontSize:11,color:'var(--green)'}}>
                      ▲ +{parseInt(parseFloat(kiraForm.tutar)-parseFloat(kiraModal.tutar)).toLocaleString('tr-TR')} ₺ artış
                    </span>
                  )}
                </div>

                {/* Geçerlilik tarihi — zorunlu */}
                <div className="form-group">
                  <label>Hangi Aydan İtibaren? *</label>
                  <input type="date" value={kiraForm.gecerlilik_tarihi}
                    onChange={e=>setKiraForm({...kiraForm,gecerlilik_tarihi:e.target.value})} />
                  <span style={{fontSize:11,color:'var(--text3)'}}>Bu tarihten önce eski tutar geçerli kalır</span>
                </div>

                {/* Kira artış için: yeni periyot */}
                {kiraModal.aksiyon==='TUTAR_GUNCELLE' && (
                  <div className="form-group" style={{gridColumn:'1/-1'}}>
                    <label>Sonraki Artış Periyodu</label>
                    <select value={kiraForm.kira_artis_periyot}
                      onChange={e=>setKiraForm({...kiraForm,kira_artis_periyot:e.target.value})}>
                      <option value="">Seçin (opsiyonel)</option>
                      <option value="6ay">6 Aylık</option>
                      <option value="1yil">Yıllık</option>
                      <option value="2yil">2 Yıllık</option>
                      <option value="5yil">5 Yıllık</option>
                    </select>
                    {kiraForm.kira_artis_periyot && kiraForm.gecerlilik_tarihi && (()=>{
                      const ayMap={'6ay':6,'1yil':12,'2yil':24,'5yil':60};
                      const ay = ayMap[kiraForm.kira_artis_periyot];
                      if(!ay) return null;
                      const d = new Date(kiraForm.gecerlilik_tarihi);
                      d.setMonth(d.getMonth()+ay);
                      return <span style={{fontSize:11,color:'var(--yellow)'}}>
                        ⏰ Sonraki artış: {d.toLocaleDateString('tr-TR')}
                      </span>;
                    })()}
                  </div>
                )}

                {/* Sözleşme uzatma için: yeni süre */}
                {kiraModal.aksiyon==='SOZLESME_UZAT' && (
                  <div className="form-group" style={{gridColumn:'1/-1'}}>
                    <label>Yeni Sözleşme Süresi (Ay) *</label>
                    <input type="number" min={1} max={120}
                      value={kiraForm.sozlesme_sure_ay}
                      onChange={e=>setKiraForm({...kiraForm,sozlesme_sure_ay:e.target.value})}
                      placeholder="ör. 24" />
                    {kiraForm.sozlesme_sure_ay && kiraForm.gecerlilik_tarihi && (()=>{
                      const d = new Date(kiraForm.gecerlilik_tarihi);
                      d.setMonth(d.getMonth()+parseInt(kiraForm.sozlesme_sure_ay));
                      return <span style={{fontSize:11,color:'var(--text3)'}}>
                        Bitiş: {d.toLocaleDateString('tr-TR')}
                      </span>;
                    })()}
                  </div>
                )}

              </div>

              {kiraModal.gun_kalan < 0 && (
                <div style={{padding:'8px 12px',background:'rgba(220,50,50,0.07)',
                  borderRadius:6,fontSize:12,color:'var(--red)',fontWeight:600,marginTop:8}}>
                  ⛔ Kaydet'e bastıktan sonra ödeme planı yeniden üretilecek.
                </div>
              )}

            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={()=>setKiraModal(null)}>İptal</button>
              <button className="btn btn-primary"
                style={{flex:1,padding:'10px 0',fontSize:14,fontWeight:700}}
                disabled={kiraLoading || !kiraForm.tutar || !kiraForm.gecerlilik_tarihi}
                onClick={async()=>{
                  setKiraLoading(true);
                  try {
                    await api(`/sabit-giderler/${kiraModal.id}`, {
                      method: 'PUT',
                      body: {
                        // Mevcut alanlar — gider_adi ve kategori backend'den bilinmiyor
                        // PUT endpoint tüm alanları bekliyor, eksik olanı gider kaydından al
                        gider_adi: kiraModal.gider_adi,
                        kategori: kiraModal.tip === 'KIRA_ARTIS' ? 'Kira' : 'Abonelik',
                        tutar: parseFloat(kiraForm.tutar),
                        periyot: 'aylik',
                        odeme_gunu: 1,
                        gecerlilik_tarihi: kiraForm.gecerlilik_tarihi,
                        kira_artis_periyot: kiraForm.kira_artis_periyot || null,
                        sozlesme_sure_ay: kiraForm.sozlesme_sure_ay ? parseInt(kiraForm.sozlesme_sure_ay) : null,
                      }
                    });
                    toast('✅ Güncellendi — ödeme planı yeniden üretilecek');
                    setKiraModal(null);
                    load(); // Panel verilerini yenile
                  } catch(e) {
                    toast(e.message, 'red');
                  } finally {
                    setKiraLoading(false);
                  }
                }}>
                {kiraLoading ? '⏳ Kaydediliyor...' :
                  kiraModal.aksiyon==='TUTAR_GUNCELLE' ? '✅ Güncelle ve Kaydet' : '✅ Sözleşmeyi Uzat ve Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kritik uyarılar — uyari_motoru'ndan gelenler (ödeme aksiyonu var) */}
      {kritikler.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
          {kritikler.map((u, i) => (
            <div key={i} className={u.blink ? 'blink' : ''} style={{
              background: 'rgba(220,50,50,0.07)', border: '1px solid var(--red)',
              borderRadius: 8, padding: '12px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>🚨 {u.aciklama}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{u.mesaj}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {fmtDate(u.tarih)} · Tam: <strong>{fmt(u.tutar)}</strong> · Asgari: <strong>{fmt(u.asgari)}</strong>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" disabled={loadingBtn} onClick={() => { setOdemeModal(u); setManuelTutar(''); }}>✓ Ödendi</button>
                <button className="btn btn-secondary btn-sm" disabled={loadingBtn} onClick={() => odemeErteleAc(u.odeme_id, u.aciklama, u.tarih)}>⏳ Ertele</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Karar motoru uyarıları — akan yazı (ticker) */}
      {panel.kararlar?.filter(k => k.seviye === 'KRITIK' || k.seviye === 'UYARI').length > 0 && (() => {
        const kritikVar = panel.kararlar.some(k => k.seviye === 'KRITIK');
        const renk = kritikVar ? 'var(--red)' : 'var(--yellow)';
        const bg = kritikVar ? 'rgba(220,50,50,0.08)' : 'rgba(220,160,0,0.07)';
        const mesajlar = panel.kararlar
          .filter(k => k.seviye === 'KRITIK' || k.seviye === 'UYARI')
          .map(k => `${k.seviye === 'KRITIK' ? '🚨' : '⚠️'} ${k.baslik}: ${k.mesaj}`)
          .join('     ·     ');
        const tickerText = mesajlar + '     ·     ' + mesajlar;
        return (
          <div style={{
            background: bg,
            border: `1px solid ${renk}44`,
            borderLeft: `3px solid ${renk}`,
            borderRadius: 8,
            marginBottom: 14,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            height: 36,
          }}>
            <div style={{
              flexShrink: 0,
              padding: '0 12px',
              fontSize: 10,
              fontWeight: 700,
              color: renk,
              textTransform: 'uppercase',
              letterSpacing: '1px',
              borderRight: `1px solid ${renk}44`,
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
            }}>
              {kritikVar ? '🚨 KRİTİK' : '⚠️ UYARI'}
            </div>
            <div style={{ overflow: 'hidden', flex: 1 }}>
              <div style={{
                display: 'inline-block',
                whiteSpace: 'nowrap',
                fontSize: 12,
                fontWeight: 500,
                color: renk,
                animation: 'ticker 18s linear infinite',
                paddingLeft: '100%',
              }}>
                {tickerText}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── YAKLAŞAN ÖDEMELER (akan bant) ── */}
      {diger.length > 0 && (() => {
        const odemeMetni = diger
          .map(u => {
            const gun = u.gun_farki === 0 ? 'BUGÜN' : u.gun_farki < 0 ? `${Math.abs(u.gun_farki)}g gecikmiş` : `${u.gun_farki} gün`;
            return `📅 ${u.aciklama}  ${fmt(u.tutar)}  [${gun}]`;
          })
          .join('          ');
        const tickerOdeme = odemeMetni + '          ' + odemeMetni;
        return (
          <div style={{
            background: 'rgba(91,155,214,0.07)',
            border: '1px solid rgba(91,155,214,0.3)',
            borderLeft: '3px solid var(--blue)',
            borderRadius: 8,
            marginBottom: 14,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            height: 36,
            cursor: 'pointer',
          }} onClick={() => { if (diger[0]) { setOdemeModal(diger[0]); setManuelTutar(''); } }}>
            <div style={{
              flexShrink: 0,
              padding: '0 12px',
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--blue)',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              borderRight: '1px solid rgba(91,155,214,0.3)',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
            }}>
              📅 {diger.length} ÖDEME
            </div>
            <div style={{ overflow: 'hidden', flex: 1 }}>
              <div style={{
                display: 'inline-block',
                whiteSpace: 'nowrap',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--blue)',
                animation: 'ticker 22s linear infinite',
                paddingLeft: '100%',
              }}>
                {tickerOdeme}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── KATMAN 2: ÇEKİRDEK METRİKLER (drill-down) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
            { label: '💰 Güncel Kasa', value: fmt(kasa), sub: kasDayan < 999 ? `${kasDayan} gün dayanır` : 'Stabil', renk: kasa >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger', overlay: { baslik: 'Son Kasa Hareketleri', endpoint: '/kasa?limit=20' } },
          { label: '🆓 Serbest Nakit', value: fmt(serbest), sub: '7 günlük yük düşülmüş', renk: serbest >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger' },
          { label: '📊 Net Akış (30 gün)', value: fmt(netAkis), sub: netAkis >= 0 ? 'Pozitif ✓' : '⚠️ Negatif akış', renk: netAkis >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger' },
          { label: '📈 Bu Ay Ciro', value: fmt(buAyCiro), sub: new Date().toLocaleDateString('tr-TR', { month: 'long' }), renk: 'var(--text1)', page: 'ciro' },
          { label: '🔄 Geçen Ay Devir', value: fmt(panel.bu_ay_devir || 0), sub: panel.bu_ay_devir > 0 ? 'Devir aktarıldı ✓' : 'Devir yok', renk: panel.bu_ay_devir > 0 ? 'var(--yellow)' : 'var(--text3)', page: 'ledger' },
          { label: '💰 Dış Kaynak (Bu Ay)', value: fmt(panel.bu_ay_dis_kaynak || 0), sub: 'Ciro dışı gelir', renk: panel.bu_ay_dis_kaynak > 0 ? '#4a9eff' : 'var(--text3)', page: 'dis-kaynak' },
          { label: '💸 Bu Ay Gider', value: fmt(panel.bu_ay_anlik_gider || 0), sub: 'Anlık giderler toplamı', renk: panel.bu_ay_anlik_gider > 0 ? 'var(--red)' : 'var(--text3)', page: 'anlik-gider' },
          (() => {
            const durdurulmus = sabitGiderUyarilar.filter(u => u.durduruldu === true).length;
            const geciken = sabitGiderOzet.geciken_adet || 0;
            const sorunlu = durdurulmus + geciken;
            const subText = durdurulmus > 0
              ? `⛔ ${durdurulmus} gider durduruldu`
              : geciken > 0
              ? `⚠️ ${geciken} gecikmiş`
              : 'Tümü güncel ✓';
            const subRenk = durdurulmus > 0 ? 'var(--red)' : geciken > 0 ? 'var(--yellow)' : 'var(--text3)';
            return { label: '🏠 Sabit Gider (Ödenen)', value: fmt(sabitGiderOzet.toplam_odenen || 0), sub: subText, renk: subRenk, page: 'sabit-giderler' };
          })(),
        ].map(({ label, value, sub, renk, page, overlay }) => (
          <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}`, cursor: 'pointer' }}
            onClick={() => overlay ? gecmisAc(overlay.baslik, overlay.endpoint) : nav(page)}
            onContextMenu={e => { e.preventDefault(); nav(page); }}
            title={overlay ? 'Tıkla: son hareketler | Sağ tık: sayfa' : 'Detaya git →'}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 24, color: renk }}>{value}</div>
            <div className="metric-sub">{sub} <span style={{ color: 'var(--text3)', fontSize: 10 }}>→</span></div>
          </div>
        ))}

        {/* Ciro breakdown — nakit/POS/online */}
        {(panel.bu_ay_nakit > 0 || panel.bu_ay_pos > 0 || panel.bu_ay_online > 0) && (
          <div style={{
            gridColumn: '1 / -1',
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '10px 16px',
            display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap'
          }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Bu Ay Ciro Dağılımı:</span>
            {[
              { label: '💵 Nakit', val: panel.bu_ay_nakit || 0, renk: 'var(--green)' },
              { label: '💳 POS', val: panel.bu_ay_pos || 0, renk: '#4a9eff' },
              { label: '🌐 Online', val: panel.bu_ay_online || 0, renk: 'var(--yellow)' },
            ].map(({ label, val, renk }) => (
              <div key={label} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{label}:</span>
                <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>{fmt(val)}</span>
                <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {(panel.bu_ay_nakit + panel.bu_ay_pos + panel.bu_ay_online) > 0
                    ? `%${((val / (panel.bu_ay_nakit + panel.bu_ay_pos + panel.bu_ay_online)) * 100).toFixed(0)}`
                    : ''}
                </span>
              </div>
            ))}
          </div>
        )}


      </div>

      {/* ── FİNANSMAN MALİYETİ ── */}
      {(panel.bu_ay_finansman_maliyeti > 0) && (
        <div style={{
          display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap',
          marginBottom: 16, padding: '12px 16px',
          background: 'rgba(220,50,50,0.06)', border: '1px solid rgba(220,50,50,0.3)',
          borderRadius: 8
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>🔥 Bu Ay Finansman Maliyeti</span>
          <div style={{ display: 'flex', gap: 20, flex: 1, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              💳 POS Kesintisi: <strong style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{fmt(panel.bu_ay_pos_kesinti || 0)}</strong>
            </span>
            {(panel.bu_ay_online_kesinti > 0) && (
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              🌐 Online Kesinti: <strong style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{fmt(panel.bu_ay_online_kesinti || 0)}</strong>
            </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              📈 Kart Faizi: <strong style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)' }}>{fmt(panel.bu_ay_kart_faizi || 0)}</strong>
            </span>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>
              🔥 Toplam Yanan: <strong style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 14 }}>{fmt(panel.bu_ay_finansman_maliyeti)}</strong>
            </span>
            {panel.bu_ay_sadece_ciro > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                Ciroya oranı: <strong style={{ color: 'var(--yellow)' }}>
                  %{((panel.bu_ay_finansman_maliyeti / panel.bu_ay_sadece_ciro) * 100).toFixed(1)}
                </strong>
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── HIZLI AKSİYON BARI ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, padding: '10px 14px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text3)', alignSelf: 'center', marginRight: 4 }}>Hızlı:</span>
        <button className="btn btn-secondary btn-sm" onClick={() => setHizliModal('ciro')}>➕ Ciro Gir</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setHizliModal('gider')}>➖ Gider Gir</button>
        <button className="btn btn-secondary btn-sm" onClick={() => nav('kart-hareketleri')}>💳 Kart Hareketi</button>
        <button className="btn btn-secondary btn-sm" onClick={() => nav('dis-kaynak')}>💰 Dış Kaynak</button>
        <button className="btn btn-secondary btn-sm" onClick={() => nav('onay')}>✅ Onay Kuyruğu</button>
        <button className="btn btn-secondary btn-sm" onClick={() => nav('ledger')}>📒 Ledger</button>
      </div>

      {/* ── KATMAN 3: RİSK & BASKI ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>⚡ Ödeme Baskısı</h3>
          {riskGunu && (
            <span style={{
              fontSize: 11, color: 'var(--red)',
              background: 'rgba(220,50,50,0.12)', padding: '4px 10px',
              borderRadius: 4, fontWeight: 700, cursor: 'pointer'
            }} onClick={() => nav('ledger')}>
              💣 {riskGunu} — kasa sıfır
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {[
            { gun: '7 gün', tutar: yuk7 },
            { gun: '15 gün', tutar: yuk15 },
            { gun: '30 gün', tutar: yuk30 },
          ].map(({ gun, tutar }) => {
            const yetersiz = kasa < tutar;
            return (
              <div key={gun} style={{
                background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', textAlign: 'center',
                borderLeft: `3px solid ${yetersiz ? 'var(--red)' : 'var(--border)'}`
              }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{gun}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: yetersiz ? 'var(--red)' : 'var(--text1)' }}>{fmt(tutar)}</div>
                <div style={{ fontSize: 10, color: yetersiz ? 'var(--red)' : 'var(--text3)', marginTop: 3 }}>
                  {yetersiz ? '⚠️ Yetersiz' : tutar > 0 ? `%${((tutar / Math.max(kasa, 1)) * 100).toFixed(0)} kasa` : '—'}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ height: 8, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 4, width: `${Math.min(100, riskBar)}%`, background: riskRenk, transition: 'width 0.6s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)', marginTop: 5 }}>
          <span>Kasa: <strong style={{ color: riskRenk }}>{fmt(kasa)}</strong></span>
          <span>Baskı: <strong style={{ color: riskRenk }}>{riskBar.toFixed(0)}%</strong></span>
          <span>30 gün yük: <strong>{fmt(yuk30)}</strong></span>
        </div>
      </div>

      {/* ── KATMAN 4: KARAR ALANI ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

        {/* SOL: ÖDEMELER */}
        <div className="card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>📅 Yaklaşan Ödemeler</h3>
          {tumUyarilar.length === 0 ? (
            <div className="empty"><p>Yaklaşan ödeme yok</p></div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
              {tumUyarilar.map((u, i) => (
                <div key={i} style={{
                  padding: '10px 12px', borderRadius: 6,
                  background: u.seviye === 'KRITIK' ? 'rgba(220,50,50,0.06)' : u.seviye === 'UYARI' ? 'rgba(220,160,0,0.06)' : 'var(--bg3)',
                  borderLeft: `3px solid ${u.seviye === 'KRITIK' ? 'var(--red)' : u.seviye === 'UYARI' ? 'var(--yellow)' : 'var(--border)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{u.aciklama}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                        {fmtDate(u.tarih)} · {u.gun_farki === 0 ? '🔴 BUGÜN' : u.gun_farki < 0 ? `${Math.abs(u.gun_farki)} gün gecikmiş` : `${u.gun_farki} gün kaldı`}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmt(u.tutar)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>asgari: {fmt(u.asgari)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11 }}
                      onClick={() => { setOdemeModal(u); setManuelTutar(''); }}>✓ Ödendi</button>
                    <button className="btn btn-secondary btn-sm" style={{ flex: 1, fontSize: 11 }}
                      onClick={() => odemeErteleAc(u.odeme_id, u.aciklama, u.tarih)}>⏳ Ertele</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SAĞ: KART RİSK */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>💳 Kart Riskleri</h3>
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} onClick={() => nav('kart-merkez')}>Merkeze Git →</button>
          </div>
          {!panel.kart_analiz?.length ? (
            <div className="empty"><p>Kart tanımlanmamış</p>
              <button className="btn btn-primary btn-sm" onClick={() => nav('kartlar')}>Kart Ekle</button>
            </div>
          ) : (() => {
            // Avalanche: faiz × bakiye skoru
            const sirali = [...panel.kart_analiz]
              .filter(k => (k.guncel_borc || 0) > 0)
              .sort((a, b) => (b.faiz_orani * b.guncel_borc) - (a.faiz_orani * a.guncel_borc));
            const oncelikli = sirali[0];
            const toplamAylikFaiz = panel.kart_analiz.reduce((s, k) =>
              s + (parseFloat(k.guncel_borc) || 0) * (parseFloat(k.faiz_orani) || 0) / 100 / 12, 0);
            const enYakin = [...panel.kart_analiz]
              .filter(k => (k.guncel_borc || 0) > 0)
              .sort((a, b) => (a.gun_kaldi || 99) - (b.gun_kaldi || 99))[0];

            return (
              <div>
                {/* Kart özet satırı */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
                  <div style={{ background: 'rgba(220,50,50,0.08)', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>🎯 Önce Kapat</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>{oncelikli?.kart_adi || '—'}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>%{oncelikli?.faiz_orani} faiz</div>
                  </div>
                  <div style={{ background: 'rgba(220,50,50,0.08)', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>💸 Aylık Faiz</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>{fmt(toplamAylikFaiz)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>tüm kartlar</div>
                  </div>
                  <div style={{ background: enYakin?.gun_kaldi <= 3 ? 'rgba(220,50,50,0.08)' : 'var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2 }}>📅 En Yakın</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: enYakin?.gun_kaldi <= 3 ? 'var(--red)' : 'var(--text1)' }}>
                      {enYakin ? (enYakin.gun_kaldi <= 0 ? 'BUGÜN' : `${enYakin.gun_kaldi} gün`) : '—'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{enYakin?.kart_adi}</div>
                  </div>
                </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {panel.kart_analiz.map(k => {
                const d = parseFloat(k.limit_doluluk) || 0;
                const renk = d > 0.85 ? 'var(--red)' : d > 0.65 ? 'var(--yellow)' : 'var(--green)';
                return (
                  <div key={k.kart_adi} className={k.blink ? 'blink' : ''} style={{
                    background: 'var(--bg3)', borderRadius: 8, padding: '12px 14px',
                    borderLeft: `3px solid ${renk}`, cursor: 'pointer'
                  }} onClick={() => nav('kart-analiz')}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>{k.kart_adi}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 6 }}>{k.banka}</span>
                        {k.blink && <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 10 }}>SON GÜN</span>}
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: renk }}>{fmt(k.guncel_borc)}</span>
                    </div>
                    <div className="progress-bar" style={{ marginBottom: 6 }}>
                      <div className={`progress-fill ${d > 0.85 ? 'red' : d > 0.65 ? 'yellow' : 'green'}`} style={{ width: `${Math.min(100, d * 100)}%` }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
                      <span>Asgari: <strong style={{ color: renk }}>{fmt(k.asgari_odeme)}</strong></span>
                      <span style={{ color: renk, fontWeight: 700 }}>{(d * 100).toFixed(0)}% dolu</span>
                      <span>{k.gun_kaldi <= 0 ? '🔴 BUGÜN' : `${k.gun_kaldi} gün`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── GERÇEKLEŞMİŞ SABİT GİDERLER ── */}
      {odenenGiderler.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>✅ Bu Ay Ödenen Sabit Giderler</h3>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--red)' }}>
              -{parseInt(odenenGiderler.reduce((s,g) => s + parseFloat(g.odenen_tutar||g.odenecek_tutar||0), 0)).toLocaleString('tr-TR')} ₺
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }}>
            {odenenGiderler.map((g, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '7px 12px', borderRadius: 6, background: 'var(--bg3)'
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12 }}>{g.gider_adi}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {g.kategori} · {g.odeme_tarihi?.slice(0,10) || '—'}
                  </div>
                </div>
                <div style={{ fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  -{parseInt(g.odenen_tutar||g.odenecek_tutar||0).toLocaleString('tr-TR')} ₺
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SİMÜLASYON GRAFİĞİ ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>📉 30 Günlük Kasa Projeksiyonu — Ne zaman batıyorum?</h3>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text3)' }}>
            <span><span style={{ color: 'var(--green)' }}>━</span> Mevcut</span>
            <span><span style={{ color: 'var(--yellow)' }}>╌</span> Önerili</span>
            <span><span style={{ color: 'var(--red)' }}>╌</span> Sıfır hattı</span>
          </div>
        </div>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={simData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="kasaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4caf84" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#4caf84" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="tarih" tick={{ fill: 'var(--text3)', fontSize: 10 }} />
              <YAxis tick={{ fill: 'var(--text3)', fontSize: 10 }} tickFormatter={v => (v / 1000).toFixed(0) + 'K'} width={45} />
              <Tooltip
                contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
                formatter={(v, n) => [fmt(v), n === 'mevcut' ? 'Mevcut' : 'Önerili']}
                labelFormatter={l => `📅 ${l}`}
              />
              <ReferenceLine y={0} stroke="var(--red)" strokeDasharray="3 3" strokeOpacity={0.7} label={{ value: 'Sıfır', fill: 'var(--red)', fontSize: 10 }} />
              <Area type="monotone" dataKey="mevcut" stroke="#4caf84" fill="url(#kasaGrad)" strokeWidth={2} dot={false} name="mevcut" />
              <Area type="monotone" dataKey="onerili" stroke="#f0c040" fill="none" strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="onerili" />
              {riskDot && (
                <ReferenceDot x={riskDot.tarih} y={riskDot.mevcut} r={5} fill="var(--red)" stroke="none" label={{ value: '⚠️', position: 'top', fontSize: 12 }} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── STRATEJİ ÖNERİLERİ ── */}
      {panel.oneriler?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>🧠 Strateji Motoru</h3>
            {panel.oneriler.filter(o => o.odeme_id && o.tavsiye_tutar > 0).length > 1 && (
              <button className="btn btn-primary btn-sm" disabled={topluUygula}
                onClick={topluOnerUygula}
                title="Tüm önerileri tek tıkla uygula">
                {topluUygula ? '⏳ Uygulanıyor...' : `⚡ Tümünü Uygula (${panel.oneriler.filter(o => o.odeme_id && o.tavsiye_tutar > 0).length})`}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {panel.oneriler.map((o, i) => {
              const renk = o.renk === 'KIRMIZI' ? 'var(--red)' : o.renk === 'TURUNCU' ? '#f07040' : o.renk === 'SARI' ? 'var(--yellow)' : 'var(--text3)';
              // Kasa etkisi hesapla
              const kasaEtkisi = o.tavsiye_tutar > 0 ? -(o.tavsiye_tutar) : null;
              const kasaSonrasi = kasaEtkisi ? kasa + kasaEtkisi : null;
              return (
                <div key={i} style={{
                  padding: '10px 14px', borderRadius: 6, background: 'var(--bg3)',
                  borderLeft: `3px solid ${renk}`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: renk }}>{o.baslik}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{o.aciklama}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      {o.tavsiye_tutar > 0 && (
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}>{fmt(o.tavsiye_tutar)}</div>
                          {kasaSonrasi !== null && (
                            <div style={{ fontSize: 10, color: kasaSonrasi >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              Kasa → {fmt(kasaSonrasi)}
                            </div>
                          )}
                        </div>
                      )}
                      {o.odeme_id && o.tavsiye_tutar > 0 && (
                        <button className="btn btn-primary btn-sm"
                          onClick={() => { setOdemeModal({ ...o, tutar: o.tavsiye_tutar, asgari: o.tavsiye_tutar * 0.4 }); setManuelTutar(''); }}>
                          Uygula
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── ONAY MERKEZİ ── */}
      {onaylar.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--yellow)' }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--yellow)', marginBottom: 12 }}>
            🔔 Onay Merkezi — {onaylar.length} bekleyen işlem
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {onaylar.map(o => (
              <div key={o.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', borderRadius: 6,
                background: o.seviye === 'KRITIK' ? 'rgba(220,50,50,0.07)' : 'var(--bg3)',
                borderLeft: `3px solid ${o.seviye === 'KRITIK' ? 'var(--red)' : o.seviye === 'UYARI' ? 'var(--yellow)' : 'var(--border)'}`
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {({'SABIT_GIDER':'Sabit Gider','KART_ODEME':'Kart Ödemesi','ANLIK_GIDER':'Anlık Gider',
                       'PERSONEL_MAAS':'Personel Maaşı','VADELI_ODEME':'Vadeli Ödeme',
                       'DIS_KAYNAK':'Dış Kaynak','CIRO':'Ciro Girişi','ODEME_PLANI':'Ödeme Planı',
                       'KART_FAIZ':'Kart Faizi'})[o.islem_turu] || o.islem_turu}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{o.aciklama} · {fmtDate(o.tarih)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700 }}>{fmt(o.tutar)}</span>
                  <button className="btn btn-primary btn-sm" onClick={() => onayKuyrukOnayla(o.id)}>✓ Onayla</button>
                  <button className="btn btn-danger btn-sm" onClick={() => onayKuyrukReddet(o.id)}>✕ Reddet</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── KASA DETAY ── */}
      {(gelir30 > 0 || gider30 > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600 }}>🔍 Kasa Detay (30 gün)</h3>
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} onClick={() => nav('ledger')}>Ledger →</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { label: '↑ Toplam Gelir', value: gelir30, renk: 'var(--green)' },
              { label: '↓ Toplam Gider', value: gider30, renk: 'var(--red)' },
              { label: '= Net', value: netAkis, renk: netAkis >= 0 ? 'var(--green)' : 'var(--red)' },
            ].map(({ label, value, renk }) => (
              <div key={label} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>{fmt(value)}</div>
              </div>
            ))}
          </div>
          {anomali?.sorunlu > 0 && (
            <div style={{
              marginTop: 10, padding: '10px 14px',
              background: 'rgba(220,50,50,0.1)', border: '1px solid var(--red)',
              borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>
                🚨 {anomali.sorunlu} ciro kaydının kasa karşılığı eksik!
              </span>
              <button className="btn btn-danger btn-sm" onClick={() => nav('ledger')}>İncele →</button>
            </div>
          )}
        </div>
      )}

      {/* ── ÖDEME ONAY MODALI ── */}
      {odemeModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setOdemeModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>💳 Ödeme Onayla</h3>
              <button className="modal-close" onClick={() => setOdemeModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{odemeModal.aciklama}</div>
                <div style={{ display: 'flex', gap: 20, fontSize: 12, color: 'var(--text3)', flexWrap: 'wrap' }}>
                  <span>Son gün: <strong style={{ color: 'var(--text1)' }}>{fmtDate(odemeModal.tarih)}</strong></span>
                  <span>Tam: <strong style={{ color: 'var(--text1)' }}>{fmt(odemeModal.tutar)}</strong></span>
                  <span>Asgari: <strong style={{ color: 'var(--yellow)' }}>{fmt(odemeModal.asgari)}</strong></span>
                </div>
              </div>
              <div className="form-group">
                <label>Ödenen Tutar (₺) — boş bırakırsan tam tutar</label>
                <input type="number" value={manuelTutar}
                  onChange={e => setManuelTutar(e.target.value)}
                  placeholder={`Tam tutar: ${odemeModal.tutar}`} autoFocus />
                {manuelTutar && parseFloat(manuelTutar) < (odemeModal.asgari || 0) && (
                  <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>
                    ⚠️ Asgari ödemenin altında ({fmt(odemeModal.asgari)})
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
                Kasadan düşülecek: <strong style={{ color: 'var(--red)', fontSize: 15 }}>
                  {fmt(parseFloat(manuelTutar) || odemeModal.tutar)}
                </strong>
                {kasa - (parseFloat(manuelTutar) || odemeModal.tutar) < 0 && (
                  <span style={{ color: 'var(--red)', fontSize: 11, marginLeft: 8 }}>⚠️ Kasa eksiye düşer!</span>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setOdemeModal(null); setManuelTutar(''); }}>Vazgeç</button>
              <button className="btn btn-primary" onClick={() => odemeOnayla(odemeModal.odeme_id, manuelTutar || null)}>
                ✓ Ödendi — Onayla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── HIZLI AKSİYON MODALİ ── */}
      {/* ── ERTELE MODAL ── */}
      {erteleModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setErteleModal(null)}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h3>⏳ Ödeme Ertele</h3>
              <button className="modal-close" onClick={() => setErteleModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{erteleModal.aciklama}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                  Mevcut tarih: <strong>{erteleModal.mevcutTarih}</strong>
                </div>
              </div>
              <div className="form-group">
                <label>Yeni Ödeme Tarihi</label>
                <input
                  type="date"
                  value={erteleTarih}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={e => setErteleTarih(e.target.value)}
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setErteleModal(null)}>İptal</button>
              <button className="btn btn-primary" disabled={loadingBtn || !erteleTarih} onClick={odemeErteleOnayla}>
                ✓ Ertele
              </button>
            </div>
          </div>
        </div>
      )}

      {hizliModal && (
        <HizliAksiyonModal tip={hizliModal} onKapat={() => setHizliModal(null)} onKaydet={hizliKaydet} />
      )}

      {/* ── GEÇMİŞ OVERLAY ── */}
      {gecmisOverlay && (
        <GecmisOverlay baslik={gecmisOverlay.baslik} data={gecmisData}
          onKapat={() => { setGecmisOverlay(null); setGecmisData([]); }} />
      )}
    </div>
  );
}

// İşlem geçmişi overlay
function GecmisOverlay({ baslik, data, onKapat }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>📋 {baslik}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          {data.length === 0 ? (
            <div className="empty" style={{ padding: 32 }}><p>Kayıt yok</p></div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {data.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px', borderBottom: '1px solid var(--border)'
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{r.islem_turu || r.aciklama || r.kategori || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{r.tarih} {r.aciklama && r.islem_turu ? `· ${r.aciklama}` : ''}</div>
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700,
                    color: (parseFloat(r.tutar) || parseFloat(r.toplam) || 0) >= 0 ? 'var(--green)' : 'var(--red)'
                  }}>
                    {r.tutar !== undefined
                      ? ((parseFloat(r.tutar) >= 0 ? '+' : '') + parseFloat(r.tutar).toLocaleString('tr-TR') + ' ₺')
                      : r.toplam
                        ? ('+' + parseFloat(r.toplam).toLocaleString('tr-TR') + ' ₺')
                        : '—'
                    }
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Hızlı aksiyon modal bileşeni
function HizliAksiyonModal({ tip, onKapat, onKaydet }) {
  const bugun = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    tarih: bugun, tutar: '', aciklama: '', kategori: 'Genel',
    nakit: '', pos: '', online: '', sube_id: 'sube-merkez'
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const tipConfig = {
    ciro: { title: '📈 Hızlı Ciro Girişi', label: 'Nakit / POS / Online' },
    gider: { title: '💸 Hızlı Gider Girişi', label: 'Tutar' },
  };
  const cfg = tipConfig[tip] || { title: 'Kayıt', label: 'Tutar' };

  function handleKaydet() {
    if (tip === 'ciro') {
      const nakit = parseFloat(form.nakit) || 0;
      const pos = parseFloat(form.pos) || 0;
      const online = parseFloat(form.online) || 0;
      if (nakit + pos + online <= 0) { alert('En az bir tutar girilmeli'); return; }
      const toplam = nakit + pos + online;
      onKaydet('ciro', { tarih: form.tarih, nakit, pos, online, aciklama: form.aciklama || `Ciro ${toplam.toLocaleString('tr-TR')} ₺`, sube_id: form.sube_id });
    } else if (tip === 'gider') {
      const tutar = parseFloat(form.tutar);
      if (!tutar || tutar <= 0) { alert('Geçerli bir tutar girin'); return; }
      if (!form.aciklama?.trim() && form.kategori === 'Genel') { alert('Açıklama veya kategori girin'); return; }
      onKaydet('gider', { tarih: form.tarih, tutar, aciklama: form.aciklama || form.kategori, kategori: form.kategori });
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal">
        <div className="modal-header">
          <h3>{cfg.title}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Tarih</label>
            <input type="date" value={form.tarih} onChange={e => set('tarih', e.target.value)} />
          </div>
          {tip === 'ciro' ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {['nakit', 'pos', 'online'].map(k => (
                  <div className="form-group" key={k}>
                    <label style={{ textTransform: 'capitalize' }}>{k} (₺)</label>
                    <input type="number" value={form[k]} onChange={e => set(k, e.target.value)} placeholder="0" />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="form-group">
                <label>Tutar (₺)</label>
                <input type="number" value={form.tutar} onChange={e => set('tutar', e.target.value)} placeholder="0" autoFocus />
              </div>
              <div className="form-group">
                <label>Kategori</label>
                <input value={form.kategori} onChange={e => set('kategori', e.target.value)} placeholder="Genel" />
              </div>
            </>
          )}
          <div className="form-group">
            <label>Açıklama</label>
            <input value={form.aciklama} onChange={e => set('aciklama', e.target.value)} placeholder="İsteğe bağlı" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onKapat}>Vazgeç</button>
          <button className="btn btn-primary" onClick={handleKaydet}>✓ Kaydet</button>
        </div>
      </div>
    </div>
  );
}
