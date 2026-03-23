import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const KATEGORILER = [
  'Aile Desteği',
  'Banka Kredisi',
  'Ortak Sermayesi',
  'Kişisel Borç',
  'Devlet Desteği',
  'Diğer Gelir',
];

export default function DisKaynak() {
  const [liste, setListe] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    tarih: new Date().toISOString().split('T')[0],
    kategori: 'Aile Desteği',
    tutar: '',
    aciklama: '',
  });
  const [msg, setMsg] = useState(null);

  const load = () => api('/dis-kaynak').then(setListe);
  useEffect(() => { load(); }, []);
  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3000); };

  async function kaydet() {
    try {
      await api('/dis-kaynak', { method: 'POST', body: form });
      toast('Gelir kaydedildi, kasaya eklendi');
      setShowModal(false);
      setForm({ tarih: new Date().toISOString().split('T')[0], kategori: 'Aile Desteği', tutar: '', aciklama: '' });
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  async function sil(id) {
    if (!confirm('Bu geliri iptal et? Kasadan geri alınacak.')) return;
    try {
      await api(`/dis-kaynak/${id}`, { method: 'DELETE' });
      toast('İptal edildi, kasadan düşüldü', 'yellow');
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  const toplam = liste.reduce((s, g) => s + parseFloat(g.tutar || 0), 0);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>💰 Dış Kaynak Geliri</h2>
          <p>Ciro dışı nakit girişleri — aile, kredi, ortak, vb. · Toplam: {fmt(toplam)}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Gelir Ekle</button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Kategori</th>
              <th>Açıklama</th>
              <th style={{ textAlign: 'right' }}>Tutar</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {!liste.length ? (
              <tr><td colSpan={5}><div className="empty"><p>Dış kaynak girişi yok</p></div></td></tr>
            ) : liste.map(g => (
              <tr key={g.id}>
                <td className="mono" style={{ fontSize: 12 }}>{fmtDate(g.tarih)}</td>
                <td><span className="badge badge-green">{g.aciklama?.split(':')[0] || 'Gelir'}</span></td>
                <td style={{ fontSize: 12, color: 'var(--text3)' }}>{g.aciklama || '---'}</td>
                <td style={{ textAlign: 'right' }} className="amount-pos">{fmt(g.tutar)}</td>
                <td><button className="btn btn-danger btn-sm" onClick={() => sil(g.id)}>İptal</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>Dış Kaynak Geliri Ekle</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert-box green mb-16">✅ Bu gelir kasaya direkt eklenir ve panelde "Toplam Gelir"e yansır.</div>
              <div className="form-row cols-2">
                <div className="form-group">
                  <label>Tarih</label>
                  <input type="date" value={form.tarih} onChange={e => setForm({ ...form, tarih: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Kaynak Türü</label>
                  <select value={form.kategori} onChange={e => setForm({ ...form, kategori: e.target.value })}>
                    {KATEGORILER.map(k => <option key={k}>{k}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Tutar (₺) *</label>
                  <input type="number" value={form.tutar} onChange={e => setForm({ ...form, tutar: e.target.value })} placeholder="0" />
                </div>
                <div className="form-group">
                  <label>Açıklama</label>
                  <input value={form.aciklama} onChange={e => setForm({ ...form, aciklama: e.target.value })} placeholder="Örn: Anneden destek - Mart ayı" />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>İptal</button>
              <button className="btn btn-primary" onClick={kaydet} disabled={!form.tutar}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
