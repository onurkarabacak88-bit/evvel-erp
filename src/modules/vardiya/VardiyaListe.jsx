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
 * @param {() => void} [props.onListeDegisti] - silme sonrası üst bileşen yenilemesi
 */
export default function VardiyaListe({ tarih, refreshTrigger = 0, onListeDegisti }) {
  const [loading, setLoading] = useState(true);
  const [hata, setHata] = useState(null);
  const [vardiyalar, setVardiyalar] = useState([]);
  const [silinenId, setSilinenId] = useState(null);
  const [gunSiliniyor, setGunSiliniyor] = useState(false);

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

  const yenile = useCallback(() => {
    yukle();
    if (typeof onListeDegisti === 'function') onListeDegisti();
  }, [yukle, onListeDegisti]);

  const tekSil = async (vid) => {
    if (!window.confirm('Bu vardiya satırını silmek istiyor musunuz?')) return;
    setHata(null);
    setSilinenId(vid);
    try {
      await api(`/vardiya?id=${encodeURIComponent(vid)}`, { method: 'DELETE' });
      yenile();
    } catch (e) {
      setHata(e.message || 'Silinemedi.');
    } finally {
      setSilinenId(null);
    }
  };

  const gunuBosalt = async () => {
    if (!tarih) return;
    if (
      !window.confirm(
        `${tarih} tarihindeki tüm vardiya kayıtları silinecek. Emin misiniz?`,
      )
    )
      return;
    setHata(null);
    setGunSiliniyor(true);
    try {
      await api(`/vardiya?tarih=${encodeURIComponent(tarih)}`, { method: 'DELETE' });
      yenile();
    } catch (e) {
      setHata(e.message || 'Gün silinemedi.');
    } finally {
      setGunSiliniyor(false);
    }
  };

  return (
    <div className="vardiya-card">
      <div className="vardiya-liste-baslik">
        <div>
          <h3>Vardiya listesi</h3>
          <p className="sub">
            {tarih
              ? `${tarih} tarihli kayıtlar`
              : 'Tarih seçin'}
          </p>
        </div>
        {tarih && vardiyalar.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm vardiya-btn-gun-sil"
            disabled={gunSiliniyor || loading}
            onClick={gunuBosalt}
          >
            {gunSiliniyor ? 'Siliniyor…' : 'Bu günü temizle'}
          </button>
        )}
      </div>

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
                <th style={{ width: 88 }}> </th>
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
                  <td>
                    <button
                      type="button"
                      className="vardiya-btn-sil"
                      disabled={silinenId === v.id || gunSiliniyor}
                      onClick={() => tekSil(v.id)}
                      title="Satırı sil"
                    >
                      {silinenId === v.id ? '…' : 'Sil'}
                    </button>
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
