import { useState, useCallback } from 'react';
import { today } from '../../utils/api';
import VardiyaOlustur from './VardiyaOlustur';
import VardiyaListe from './VardiyaListe';
import './vardiya.css';

/**
 * Vardiya planlama modülü — üstte tarih, altta oluştur + liste.
 */
export default function VardiyaPanel() {
  const [tarih, setTarih] = useState(today());
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleOlusturSuccess = useCallback(() => {
    setRefreshTrigger((n) => n + 1);
  }, []);

  return (
    <div className="page vardiya-module">
      <div className="page-header">
        <h2>Vardiya planlama</h2>
        <p>Aktif personel için günlük vardiya şablonu (ACILIS · ARA · KAPANIS)</p>
      </div>

      <div className="vardiya-date-bar">
        <div className="form-group">
          <label htmlFor="vardiya-tarih">Tarih</label>
          <input
            id="vardiya-tarih"
            type="date"
            value={tarih}
            onChange={(e) => setTarih(e.target.value)}
          />
        </div>
      </div>

      <div className="vardiya-layout">
        <VardiyaOlustur tarih={tarih} onSuccess={handleOlusturSuccess} />
        <VardiyaListe tarih={tarih} refreshTrigger={refreshTrigger} />
      </div>
    </div>
  );
}
