import { useState, useCallback } from 'react';
import { api } from '../../utils/api';

/**
 * Günlük veya haftalık (Pzt–Pa) vardiya üretir.
 * @param {Object} props
 * @param {string} props.tarih - YYYY-MM-DD
 * @param {(res?: object) => void} [props.onSuccess] - API yanıtı ile (liste + motor logu / hafta özeti)
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

  const olusturHafta = useCallback(async () => {
    if (!tarih) {
      setMesaj({ tur: 'hata', metin: 'Önce bir tarih seçin.' });
      return;
    }
    setLoading(true);
    setMesaj(null);
    try {
      const res = await api('/vardiya/olustur-hafta', {
        method: 'POST',
        body: { tarih },
      });
      setMesaj({
        tur: 'ok',
        metin:
          res.mesaj ||
          `Haftalık: ${res.toplam_olusturulan ?? 0} kayıt (${res.hafta_baslangic ?? ''} – ${res.hafta_bitis ?? ''}).`,
      });
      if (onSuccess) onSuccess(res);
    } catch (e) {
      setMesaj({
        tur: 'hata',
        metin: e.message || 'Haftalık vardiya oluşturulamadı.',
      });
    } finally {
      setLoading(false);
    }
  }, [tarih, onSuccess]);

  return (
    <div className="vardiya-card">
      <h3>Vardiya oluştur</h3>
      <p className="sub">
        Seçili günün (veya haftanın her gününün) planı silinir; şube ve personel kuralları,
        izinler ve şube bağlantılarına göre motor yeni ACILIS / ARA / KAPANIS atar. Haftalık
        işlem, seçilen tarihin düştüğü haftanın pazartesisinden pazara kadar 7 günü sırayla
        üretir.
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={olustur}
          disabled={loading || !tarih}
        >
          {loading ? (
            <span className="vardiya-spinner-inline">
              <span className="spinner" />
              Oluşturuluyor…
            </span>
          ) : (
            'Bu günü oluştur'
          )}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={olusturHafta}
          disabled={loading || !tarih}
        >
          Bu haftayı oluştur (Pzt–Pa)
        </button>
      </div>
    </div>
  );
}
