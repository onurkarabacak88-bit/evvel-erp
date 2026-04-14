import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const KATEGORILER = ['Gıda', 'İçecek', 'Ambalaj', 'Temizlik', 'Kırtasiye', 'Teknik', 'Diğer'];

const BOSH = { ad: '', kategori: '', telefon: '', aciklama: '' };

export default function Tedarikciler() {
  const [liste, setListe] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BOSH);
  const [duzenleId, setDuzenleId] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = () => {
    setLoading(true);
    api('/tedarikciler?aktif=true')
      .then(r => setListe(r.tedarikciler || []))
      .catch(e => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  async function kaydet() {
    if (!form.ad.trim()) { toast('Tedarikçi adı zorunlu', 'red'); return; }
    try {
      if (duzenleId) {
        await api(`/tedarikciler/${duzenleId}`, { method: 'PUT', body: form });
        toast('Güncellendi');
      } else {
        await api('/tedarikciler', { method: 'POST', body: form });
        toast('Tedarikçi eklendi');
      }
      setShowModal(false);
      setForm(BOSH);
      setDuzenleId(null);
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function sil(id, ad) {
    if (!confirm(`"${ad}" tedarikçisini pasife almak istiyor musunuz?`)) return;
    try {
      await api(`/tedarikciler/${id}`, { method: 'DELETE' });
      toast('Pasife alındı', 'yellow');
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  function duzenle(t) {
    setForm({ ad: t.ad, kategori: t.kategori || '', telefon: t.telefon || '', aciklama: t.aciklama || '' });
    setDuzenleId(t.id);
    setShowModal(true);
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between">
        <div>
          <h2>🚚 Tedarikçiler</h2>
          <p>Şube panelinde ürün teslim alımında seçilen tedarikçi listesi — buradan yönetilir.</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setForm(BOSH); setDuzenleId(null); setShowModal(true); }}
        >
          + Tedarikçi Ekle
        </button>
      </div>

      <div className="alert-box green mb-16" style={{ fontSize: 13 }}>
        ℹ️ Bu listeye eklediğiniz tedarikçiler, şube personelinin <strong>Ürün Teslim Al</strong> formunda
        dropdown olarak görünür. Personel serbest metin giremez; sadece buradan seçer.
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" />Yükleniyor…</div>
      ) : liste.length === 0 ? (
        <div className="empty">
          <div className="icon">🚚</div>
          <p>Henüz tedarikçi eklenmedi</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>Ekle butonuna tıklayarak başlayın</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tedarikçi Adı</th>
                <th>Kategori</th>
                <th>Telefon</th>
                <th>Açıklama</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {liste.map(t => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.ad}</td>
                  <td>
                    {t.kategori
                      ? <span className="badge badge-blue">{t.kategori}</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{t.telefon || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)', maxWidth: 200 }}>{t.aciklama || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" style={{ marginRight: 6 }} onClick={() => duzenle(t)}>✏️</button>
                    <button className="btn btn-danger btn-sm" onClick={() => sil(t.id, t.ad)}>Pasife Al</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{duzenleId ? 'Tedarikçi Düzenle' : 'Yeni Tedarikçi Ekle'}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Tedarikçi Adı *</label>
                <input
                  value={form.ad}
                  onChange={e => setForm({ ...form, ad: e.target.value })}
                  placeholder="ör. Metro Grossmarket, Coca-Cola Dağıtım"
                  autoFocus
                />
              </div>
              <div className="form-row cols-2">
                <div className="form-group">
                  <label>Kategori</label>
                  <select value={form.kategori} onChange={e => setForm({ ...form, kategori: e.target.value })}>
                    <option value="">— Seçin —</option>
                    {KATEGORILER.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Telefon</label>
                  <input
                    value={form.telefon}
                    onChange={e => setForm({ ...form, telefon: e.target.value })}
                    placeholder="0212 xxx xx xx"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Açıklama</label>
                <input
                  value={form.aciklama}
                  onChange={e => setForm({ ...form, aciklama: e.target.value })}
                  placeholder="Opsiyonel not"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.ad.trim()}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
