import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

export default function Subeler() {
  const [subeler, setSubeler] = useState([]);
  const [msg, setMsg] = useState(null);
  const [duzenle, setDuzenle] = useState({});

  const load = () => api('/subeler').then(setSubeler);
  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3000); };

  async function kaydet(sid) {
    try {
      await api(`/subeler/${sid}`, {
        method: 'PUT',
        body: JSON.stringify({ pos_oran: parseFloat(duzenle[sid] || 0) })
      });
      toast('✓ POS oranı güncellendi');
      load();
    } catch (e) { toast(e.message, 'red'); }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header">
        <h2>🏪 Şube POS Oranları</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)' }}>
          POS kesinti oranını bir kez gir, ciro girişlerinde otomatik hesaplanır
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 500 }}>
        {subeler.map(s => (
          <div key={s.id} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '16px 20px'
          }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>🏪 {s.ad}</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                  POS Kesinti Oranı (%)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="10"
                  defaultValue={s.pos_oran || 0}
                  onChange={e => setDuzenle(d => ({ ...d, [s.id]: e.target.value }))}
                  style={{
                    width: '100%', padding: '8px 12px',
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 6, color: 'var(--text1)', fontSize: 14
                  }}
                />
              </div>
              <button className="btn btn-primary" style={{ marginTop: 20 }}
                onClick={() => kaydet(s.id)}>
                Kaydet
              </button>
            </div>
            {s.pos_oran > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text3)' }}>
                Örnek: 10.000 ₺ POS → <strong style={{ color: 'var(--red)' }}>
                  {fmt(10000 * s.pos_oran / 100)} kesinti
                </strong>, kasaya <strong style={{ color: 'var(--green)' }}>
                  {fmt(10000 - 10000 * s.pos_oran / 100)} girer
                </strong>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
