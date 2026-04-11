import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const BOSH = { kart_adi: '', banka: '', limit_tutar: '', kesim_gunu: 15, son_odeme_gunu: 25, faiz_orani: '', asgari_oran: 40 };

export default function Kartlar() {
  const [kartlar, setKartlar] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BOSH);
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = () => api('/kartlar').then(setKartlar);
  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3000); };

  async function kaydet() {
    try {
      if (duzenleId) await api(`/kartlar/${duzenleId}`, { method: 'PUT', body: form });
      else await api('/kartlar', { method: 'POST', body: form });
      toast(duzenleId ? 'Kart güncellendi' : 'Kart eklendi');
      setShowModal(false); setForm(BOSH); setDuzenleId(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function sil(id) {
    if (!confirm('Kartı pasife almak istiyor musunuz?')) return;
    try { await api(`/kartlar/${id}`, { method: 'DELETE' }); toast('Kart pasife alındı'); load(); }
    catch (e) { toast(e.message, 'red'); }
  }

  function duzenle(k) {
    setForm({ kart_adi: k.kart_adi, banka: k.banka, limit_tutar: k.limit_tutar,
      kesim_gunu: k.kesim_gunu, son_odeme_gunu: k.son_odeme_gunu, faiz_orani: k.faiz_orani,
      asgari_oran: k.asgari_oran != null ? k.asgari_oran : 40 });
    setDuzenleId(k.id); setShowModal(true);
  }

  const riskClass = (doluluk) => doluluk > 0.9 ? 'red' : doluluk > 0.7 ? 'yellow' : 'green';

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div><h2>Kartlar</h2><p>{kartlar.filter(k=>k.aktif).length} aktif kart</p></div>
        <button className="btn btn-primary" onClick={() => { setForm(BOSH); setDuzenleId(null); setShowModal(true); }}>+ Kart Ekle</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 14 }}>
        {kartlar.filter(k => k.aktif).map(k => {
          const risk = riskClass(k.limit_doluluk || 0);
          const donemAraligi = k.ekstre_donem_bas && k.ekstre_donem_bit
            ? `${fmtDate(k.ekstre_donem_bas)} – ${fmtDate(k.ekstre_donem_bit)}`
            : '---';
          const kesimKalan = k.kapanisa_kalan_gun != null ? `${k.kapanisa_kalan_gun} gün` : '---';
          const tahminiSonraki = k.gelecek_ekstre ?? k.tahmini_sonraki_kapanis_ekstre_simdi;
          return (
            <div key={k.id} className="card" style={{ borderTop: `3px solid var(--${risk})` }}>
              <div className="flex items-center justify-between mb-16">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}
                    className={k.blink ? 'blink' : ''}>
                    💳 {k.kart_adi}
                    {k.blink && <span className="badge badge-red" style={{ marginLeft: 6 }}>SON GÜN</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{k.banka}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className={`amount ${risk === 'red' ? 'amount-neg' : ''}`} style={{ fontSize: 18, fontWeight: 700 }}>
                    {fmt(k.guncel_borc)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>güncel borç</div>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 4, fontSize: 12 }}>
                  <span style={{ color: 'var(--text3)' }}>Limit Kullanımı</span>
                  <span className={`risk-${risk}`}>{((k.limit_doluluk||0)*100).toFixed(0)}%</span>
                </div>
                <div className="progress-bar">
                  <div className={`progress-fill ${risk}`} style={{ width: `${Math.min(100,(k.limit_doluluk||0)*100)}%` }}/>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
                {[
                  ['Limit', fmt(k.limit_tutar)],
                  ['Kullanılabilir', fmt(k.kalan_limit)],
                  ['Dönem borcu (faiz dahil)', fmt(k.donem_borcu ?? 0)],
                  ['Asgari ödeme', fmt(k.asgari_odeme)],
                  ['Bu dönem ekstre (harcama)', fmt(k.bu_ekstre ?? 0)],
                  ['Taksit yükü (aylık)', fmt(k.aylik_taksit ?? 0)],
                  ['Tahmini sonraki ekstre', fmt(tahminiSonraki ?? 0)],
                  ['Açık dönem', donemAraligi],
                  ['Kesime kalan', kesimKalan],
                  ['Asgari oranı', `%${k.asgari_oran ?? 40}`],
                  ['Faiz oranı', `%${k.faiz_orani}`],
                  ['Kesim günü', `${k.kesim_gunu}. gün`],
                  ['Son ödeme', `${k.son_odeme_gunu}. gün (${k.gun_kaldi} gün kaldı)`],
                ].map(([label, val]) => (
                  <div key={label} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '7px 10px' }}>
                    <div style={{ color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
                    <div className="mono">{val}</div>
                  </div>
                ))}
              </div>

              <div className="flex gap-8" style={{ marginTop: 12 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => duzenle(k)}>✏️ Düzenle</button>
                <button className="btn btn-danger btn-sm" onClick={() => sil(k.id)}>Pasife Al</button>
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{duzenleId ? 'Kart Düzenle' : 'Yeni Kart Ekle'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-row cols-2">
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label>Kart Adı *</label>
                  <input placeholder="GARANTI_BONUS_6020" value={form.kart_adi}
                    onChange={e => setForm({ ...form, kart_adi: e.target.value.toUpperCase() })}/>
                </div>
                <div className="form-group">
                  <label>Banka</label>
                  <input placeholder="Garanti, Yapıkredi..." value={form.banka}
                    onChange={e => setForm({ ...form, banka: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Limit (₺)</label>
                  <input type="number" value={form.limit_tutar} onChange={e => setForm({ ...form, limit_tutar: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Kesim Günü</label>
                  <input type="number" min={1} max={31} value={form.kesim_gunu} onChange={e => setForm({ ...form, kesim_gunu: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Son Ödeme Günü</label>
                  <input type="number" min={1} max={31} value={form.son_odeme_gunu} onChange={e => setForm({ ...form, son_odeme_gunu: e.target.value })}/>
                </div>
                <div className="form-group">
                  <label>Asgari ödeme oranı (%)</label>
                  <input type="number" step="0.5" min={1} max={100} value={form.asgari_oran}
                    onChange={e => setForm({ ...form, asgari_oran: e.target.value })}/>
                </div>
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label>Yıllık faiz oranı (% nominal)</label>
                  <input type="number" step="0.1" placeholder="42" value={form.faiz_orani}
                    onChange={e => setForm({ ...form, faiz_orani: e.target.value })}/>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Ödenmeyen ekstre üzerinden aylık faiz tahmini (yıllık ÷ 12); banka tarifesi farklı olabilir
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.kart_adi}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
