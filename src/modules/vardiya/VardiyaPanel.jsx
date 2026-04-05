import { useState, useCallback, useEffect } from 'react';
import { today, api } from '../../utils/api';
import VardiyaOlustur from './VardiyaOlustur';
import VardiyaListe from './VardiyaListe';
import './vardiya.css';

/**
 * Vardiya planlama — üstte tarih, oluştur + liste; izin özeti ve motor günlüğü.
 */
export default function VardiyaPanel({ onNavigate }) {
  const [tarih, setTarih] = useState(today());
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [izinliPersonel, setIzinliPersonel] = useState([]);
  const [izinLoading, setIzinLoading] = useState(false);
  const [motorLog, setMotorLog] = useState([]);

  const handleOlusturSuccess = useCallback((res) => {
    setRefreshTrigger((n) => n + 1);
    if (res && Array.isArray(res.log)) setMotorLog(res.log);
    else setMotorLog([]);
  }, []);

  useEffect(() => {
    if (!tarih) {
      setIzinliPersonel([]);
      return;
    }
    let cancelled = false;
    setIzinLoading(true);
    api('/personel-izin?durum=onaylandi')
      .then((res) => {
        if (cancelled) return;
        const izinliler = (res || []).filter(
          (iz) =>
            String(iz.baslangic_tarih).slice(0, 10) <= tarih &&
            String(iz.bitis_tarih).slice(0, 10) >= tarih,
        );
        setIzinliPersonel(izinliler);
      })
      .catch(() => {
        if (!cancelled) setIzinliPersonel([]);
      })
      .finally(() => {
        if (!cancelled) setIzinLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tarih]);

  return (
    <div className="page vardiya-module">
      <div
        className="page-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h2>Vardiya planlama</h2>
          <p>
            Önce <strong>Vardiya kuralları</strong>nda şube ve personel tiklerini tanımlayın; günlük
            planda motor bu sınırlara uyar (kaydırma sadece işaretli şube çiftlerinde).
          </p>
        </div>
        {typeof onNavigate === 'function' && (
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigate('vardiya-haftalik')}
            >
              Haftalık liste (Tulipi)
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigate('vardiya-ayar')}
            >
              Kurallar ve izinler
            </button>
          </span>
        )}
      </div>

      <div className="vardiya-date-bar">
        <div className="form-group">
          <label htmlFor="vardiya-tarih">Tarih</label>
          <input
            id="vardiya-tarih"
            type="date"
            value={tarih}
            onChange={(e) => {
              setTarih(e.target.value);
              setMotorLog([]);
            }}
          />
        </div>
      </div>

      {!izinLoading && izinliPersonel.length > 0 && (
        <div className="vardiya-izin-uyari">
          <div className="vardiya-izin-baslik">
            Bu tarihte {izinliPersonel.length} personel onaylı izinli — vardiya motorunda
            dışlanır
          </div>
          <div className="vardiya-izin-chips">
            {izinliPersonel.map((iz) => (
              <span key={iz.id} className="vardiya-izin-chip">
                {iz.ad_soyad}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="vardiya-layout">
        <VardiyaOlustur tarih={tarih} onSuccess={handleOlusturSuccess} />
        <VardiyaListe tarih={tarih} refreshTrigger={refreshTrigger} />
      </div>

      {motorLog.length > 0 && (
        <div className="vardiya-motor-log">
          <h4>Son çalıştırma özeti</h4>
          <ul>
            {motorLog.slice(0, 40).map((satir, i) => (
              <li key={i}>
                <span className="mono">{satir.kural}</span>
                {satir.sube && ` · ${satir.sube}`}
                {satir.personel && ` · ${satir.personel}`}
                {satir.tip && ` · ${satir.tip}`}
                {satir.detay && ` — ${satir.detay}`}
              </li>
            ))}
          </ul>
          {motorLog.length > 40 && (
            <p className="sub" style={{ marginTop: 8 }}>
              … ve {motorLog.length - 40} satır daha (tam liste API yanıtında).
            </p>
          )}
        </div>
      )}
    </div>
  );
}
