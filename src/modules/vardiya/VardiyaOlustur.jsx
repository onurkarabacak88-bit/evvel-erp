import { useState, useCallback } from 'react';
import { api } from '../../utils/api';

/**
 * Seçilen tarih için vardiya üretir (POST /api/vardiya/olustur).
 * @param {Object} props
 * @param {string} props.tarih - YYYY-MM-DD
 * @param {(res?: object) => void} [props.onSuccess] - API yanıtı ile (liste + motor logu)
 */
export default function VardiyaOlustur({ tarih, onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [mesaj, setMesaj] = useState(null);

  const olustur = useCallback(async () => {
    if (!tarih) {
      setMesaj({ tur: 'hata', metin: 'Önce bir tarih seçin.' });
      return;
    }
    setLoading(true);
    setMesaj(null);
    try {
      const res = await api('/vardiya/olustur', {
        method: 'POST',
        body: { tarih },
      });
      setMesaj({
        tur: 'ok',
        metin: res.mesaj || `${res.olusturulan ?? 0} vardiya kaydı oluşturuldu.`,
      });
      if (onSuccess) onSuccess(res);
    } catch (e) {
      setMesaj({
        tur: 'hata',
        metin: e.message || 'Vardiya oluşturulamadı.',
      });
    } finally {
      setLoading(false);
    }
  }, [tarih, onSuccess]);

  return (
    <div className="vardiya-card">
      <h3>Vardiya oluştur</h3>
      <p className="sub">
        Seçili günün planı silinir; şube ve personel kuralları, izinler ve şube bağlantılarına
        göre motor yeni ACILIS / ARA / KAPANIS atar.
      </p>

      {mesaj && (
        <div className={`alert-box ${mesaj.tur === 'ok' ? 'green' : 'red'} mb-16`}>
          {mesaj.metin}
        </div>
      )}

      <div className="form-group">
        <label>Hedef tarih</label>
        <input type="text" readOnly value={tarih || '—'} className="mono" />
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={olustur}
        disabled={loading || !tarih}
        style={{ marginTop: 8 }}
      >
        {loading ? (
          <span className="vardiya-spinner-inline">
            <span className="spinner" />
            Oluşturuluyor…
          </span>
        ) : (
          'Vardiya Oluştur'
        )}
      </button>
    </div>
  );
}
