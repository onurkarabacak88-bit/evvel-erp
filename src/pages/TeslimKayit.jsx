import { useEffect, useState } from 'react';
import { api } from '../utils/api';

export default function TeslimKayit() {
  const [kayitlar, setKayitlar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [subeId, setSubeId] = useState('');
  const [gun, setGun] = useState(30);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const toast = (m, t = 'red') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({
        gun: String(gun || 30),
        limit: '500',
      });
      if (subeId) q.set('sube_id', subeId);
      const [k, s] = await Promise.all([
        api(`/bilgi-teslim-kayitlari?${q.toString()}`),
        api('/subeler').catch(() => []),
      ]);
      setKayitlar(k?.satirlar || []);
      setSubeler(Array.isArray(s) ? s.filter((x) => x?.aktif !== false) : []);
    } catch (e) {
      toast(e.message || 'Teslim kayıtları yüklenemedi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [subeId, gun]);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>📦 Bilgi Teslim Kayıtları</h2>
          <p>Şubelerin merkeze ilettiği not/bilgi teslim kayıtları.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ margin: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube</span>
          <select className="input" style={{ minWidth: 220 }} value={subeId} onChange={(e) => setSubeId(e.target.value)}>
            <option value="">Tüm şubeler</option>
            {subeler.map((s) => (
              <option key={s.id} value={s.id}>{s.ad || s.id}</option>
            ))}
          </select>
        </label>
        <label style={{ margin: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</span>
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            value={gun}
            onChange={(e) => setGun(Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
            style={{ width: 110 }}
          />
        </label>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" />Yükleniyor…</div>
      ) : kayitlar.length === 0 ? (
        <div className="empty"><p>Kayıt bulunamadı</p></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Zaman</th>
                <th>Şube</th>
                <th>Personel</th>
                <th>Kayıt</th>
              </tr>
            </thead>
            <tbody>
              {kayitlar.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{String(r.olusturma || '').replace('T', ' ').slice(0, 19)}</td>
                  <td>{r.sube_adi || r.sube_id || '—'}</td>
                  <td style={{ fontSize: 12 }}>{r.personel_ad || r.personel_id || '—'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{r.metin || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
