import { useState, useEffect, useMemo } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

export default function TeslimKayit() {
  const now = new Date();
  const [yil, setYil] = useState(now.getFullYear());
  const [ay, setAy] = useState(now.getMonth() + 1);
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    kayit_tarihi: now.toISOString().split('T')[0],
    teslim_eden: '',
    teslim_alan: '',
    tutar: '',
    notlar: '',
  });

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  const load = () =>
    api(`/bilgi-teslim-kayitlari?yil=${yil}&ay=${ay}`).then(setData);

  useEffect(() => {
    load().catch(e => toast(String(e.message || e), 'red'));
  }, [yil, ay]);

  const ayAdlari = useMemo(
    () => ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'],
    []
  );

  const yilSecenekleri = useMemo(() => {
    const y = now.getFullYear();
    return [y - 2, y - 1, y, y + 1];
  }, [now]);

  async function kaydet() {
    const tutar = parseFloat(String(form.tutar).replace(',', '.'));
    if (!form.teslim_eden.trim() || !form.teslim_alan.trim()) {
      toast('Teslim eden ve teslim alan zorunlu', 'red');
      return;
    }
    if (Number.isNaN(tutar) || tutar < 0) {
      toast('Geçerli bir tutar girin', 'red');
      return;
    }
    try {
      await api('/bilgi-teslim-kayitlari', {
        method: 'POST',
        body: {
          kayit_tarihi: form.kayit_tarihi,
          teslim_eden: form.teslim_eden.trim(),
          teslim_alan: form.teslim_alan.trim(),
          tutar,
          notlar: form.notlar.trim() || null,
        },
      });
      toast('Kayıt eklendi — kasa değişmedi');
      setShowModal(false);
      setForm({
        kayit_tarihi: new Date().toISOString().split('T')[0],
        teslim_eden: '',
        teslim_alan: '',
        tutar: '',
        notlar: '',
      });
      load();
    } catch (e) {
      toast(String(e.message || e), 'red');
    }
  }

  async function sil(id) {
    if (!confirm('Bu kaydı silmek istiyor musunuz?')) return;
    try {
      await api(`/bilgi-teslim-kayitlari/${id}`, { method: 'DELETE' });
      toast('Silindi');
      load();
    } catch (e) {
      toast(String(e.message || e), 'red');
    }
  }

  const liste = data?.kayitlar || [];
  const toplam = data?.toplam ?? 0;
  const adet = data?.adet ?? 0;

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>🤝 El Teslim Kaydı</h2>
          <p>
            Yalnızca kayıt; kasa ve motorlara yansımaz · Seçili ay: <strong>{ayAdlari[ay]} {yil}</strong>
            {' · '}
            Toplam: <strong className="mono" style={{ color: '#a855f7' }}>{fmt(toplam)}</strong>
            {' '}({adet} kayıt)
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowModal(true)}>
          + Yeni kayıt
        </button>
      </div>

      <div className="form-row cols-2" style={{ maxWidth: 360, marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Yıl</label>
          <select value={yil} onChange={e => setYil(parseInt(e.target.value, 10))}>
            {yilSecenekleri.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>Ay</label>
          <select value={ay} onChange={e => setAy(parseInt(e.target.value, 10))}>
            {ayAdlari.slice(1).map((ad, i) => (
              <option key={i + 1} value={i + 1}>{ad}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Teslim eden</th>
              <th>Teslim alan</th>
              <th style={{ textAlign: 'right' }}>Tutar</th>
              <th>Not</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {liste.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty">
                    <p>Bu ay için kayıt yok</p>
                  </div>
                </td>
              </tr>
            ) : (
              liste.map(row => (
                <tr key={row.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtDate(row.kayit_tarihi)}</td>
                  <td>{row.teslim_eden}</td>
                  <td>{row.teslim_alan}</td>
                  <td style={{ textAlign: 'right' }} className="amount amount-pos">{fmt(row.tutar)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)', maxWidth: 220 }}>{row.notlar || '—'}</td>
                  <td>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => sil(row.id)}>Sil</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>Yeni el teslim kaydı</h3>
              <button type="button" className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert-box yellow mb-16">
                Bu kayıt finans hesaplarına eklenmez; yalnızca bu listede ve panel kartında özetlenir.
              </div>
              <div className="form-row cols-2">
                <div className="form-group">
                  <label>Kayıt tarihi</label>
                  <input
                    type="date"
                    value={form.kayit_tarihi}
                    onChange={e => setForm({ ...form, kayit_tarihi: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Verilen tutar (₺) *</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.tutar}
                    onChange={e => setForm({ ...form, tutar: e.target.value })}
                    placeholder="0"
                  />
                </div>
                <div className="form-group">
                  <label>Teslim eden *</label>
                  <input
                    value={form.teslim_eden}
                    onChange={e => setForm({ ...form, teslim_eden: e.target.value })}
                    placeholder="Ad veya ünvan"
                  />
                </div>
                <div className="form-group">
                  <label>Teslim alan *</label>
                  <input
                    value={form.teslim_alan}
                    onChange={e => setForm({ ...form, teslim_alan: e.target.value })}
                    placeholder="Ad veya ünvan"
                  />
                </div>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Not (isteğe bağlı)</label>
                  <input
                    value={form.notlar}
                    onChange={e => setForm({ ...form, notlar: e.target.value })}
                    placeholder="Kısa açıklama"
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>İptal</button>
              <button type="button" className="btn btn-primary" onClick={kaydet}>Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
