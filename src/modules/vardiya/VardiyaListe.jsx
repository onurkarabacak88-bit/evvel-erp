import { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';

function tipBadgeClass(tip) {
  if (tip === 'ACILIS') return 'vardiya-tip-acilis';
  if (tip === 'ARA') return 'vardiya-tip-ara';
  if (tip === 'KAPANIS') return 'vardiya-tip-kapanis';
  return 'badge-gray';
}

/**
 * @param {Object} props
 * @param {string} props.tarih - YYYY-MM-DD
 * @param {number} props.refreshTrigger - artınca yeniden yükler
 */
export default function VardiyaListe({ tarih, refreshTrigger = 0 }) {
  const [loading, setLoading] = useState(true);
  const [hata, setHata] = useState(null);
  const [vardiyalar, setVardiyalar] = useState([]);

  const yukle = useCallback(async () => {
    if (!tarih) {
      setVardiyalar([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setHata(null);
    try {
      const res = await api(`/vardiya?tarih=${encodeURIComponent(tarih)}`);
      setVardiyalar(Array.isArray(res.vardiyalar) ? res.vardiyalar : []);
    } catch (e) {
      setHata(e.message || 'Liste alınamadı.');
      setVardiyalar([]);
    } finally {
      setLoading(false);
    }
  }, [tarih]);

  useEffect(() => {
    yukle();
  }, [yukle, refreshTrigger]);

  return (
    <div className="vardiya-card">
      <h3>Vardiya listesi</h3>
      <p className="sub">
        {tarih
          ? `${tarih} tarihli kayıtlar`
          : 'Tarih seçin'}
      </p>

      {hata && <div className="alert-box red mb-16">{hata}</div>}

      {loading ? (
        <div className="loading" style={{ padding: '40px 20px' }}>
          <div className="spinner" />
          <span>Yükleniyor…</span>
        </div>
      ) : vardiyalar.length === 0 ? (
        <div className="empty" style={{ padding: '32px 16px' }}>
          <div className="icon">📋</div>
          <p>Bu tarih için vardiya kaydı yok.</p>
          <p style={{ fontSize: 12, marginTop: 8, color: 'var(--text3)' }}>
            Sol taraftan &quot;Vardiya Oluştur&quot; ile üretebilirsiniz.
          </p>
        </div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Personel</th>
                <th>Şube</th>
                <th>Tip</th>
                <th>Saat aralığı</th>
              </tr>
            </thead>
            <tbody>
              {vardiyalar.map((v) => (
                <tr key={v.id}>
                  <td style={{ fontWeight: 500 }}>{v.personel_adi}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{v.sube_adi}</td>
                  <td>
                    <span className={`badge ${tipBadgeClass(v.tip)}`}>{v.tip}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 13 }}>
                    {v.saat_araligi || `${v.bas_saat}–${v.bit_saat}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
