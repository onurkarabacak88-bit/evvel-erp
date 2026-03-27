import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const TUR_RENK = {
  CIRO: 'green',
  DIS_KAYNAK: 'green',
  KASA_GIRIS: 'green',
  ANLIK_GIDER: 'red',
  ANLIK_GIDER_IPTAL: 'green',
  KART_ODEME: 'blue',
  KART_FAIZ: 'red',
  SABIT_GIDER: 'yellow',
  VADELI_ODEME: 'yellow',
  PERSONEL_MAAS: 'yellow',
  POS_KESINTI: 'red',
  ONLINE_KESINTI: 'red',
  CIRO_IPTAL: 'red',
  CIRO_DUZELTME: 'yellow',
  KASA_DUZELTME: 'yellow',
  BANKA_TAKSIT: 'purple',
};

const TUR_ETIKET = {
  CIRO: 'Ciro',
  DIS_KAYNAK: 'Dış Kaynak',
  KASA_GIRIS: 'Kasa Girişi',
  ANLIK_GIDER: 'Anlık Gider',
  ANLIK_GIDER_IPTAL: 'Gider İptal',
  KART_ODEME: 'Kart Ödeme',
  KART_FAIZ: 'Kart Faiz',
  SABIT_GIDER: 'Sabit Gider',
  VADELI_ODEME: 'Vadeli Ödeme',
  PERSONEL_MAAS: 'Personel Maaş',
  POS_KESINTI: 'POS Kesinti',
  ONLINE_KESINTI: 'Online Kesinti',
  CIRO_IPTAL: 'Ciro İptal',
  CIRO_DUZELTME: 'Ciro Düzeltme',
  KASA_DUZELTME: 'Kasa Düzeltme',
  BANKA_TAKSIT: 'Banka Taksit',
};

export default function Ledger() {
  const [rows, setRows] = useState([]);
  const [filtre, setFiltre] = useState('');
  const [kasa, setKasa] = useState(0);

  useEffect(() => {
    api('/ledger?limit=500').then(setRows);
    api('/kasa').then(d => setKasa(d.guncel_bakiye));
  }, []);

  const filtered = filtre ? rows.filter(r => r.islem_turu === filtre) : rows;
  const turler = [...new Set(rows.map(r => r.islem_turu))];

  // Özet hesapla
  const toplamGelir = rows.filter(r => r.tutar > 0).reduce((s, r) => s + r.tutar, 0);
  const toplamGider = rows.filter(r => r.tutar < 0).reduce((s, r) => s + Math.abs(r.tutar), 0);

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>📒 İşlem Defteri</h2>
          <p>Tüm kasa hareketleri · Güncel bakiye: <strong style={{ color: 'var(--green)' }}>{fmt(kasa)}</strong></p>
        </div>
      </div>

      {/* Özet kartlar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { label: '🏦 Güncel Bakiye', val: kasa, renk: kasa >= 0 ? 'var(--green)' : 'var(--red)', sub: 'Tüm zamanlar' },
          { label: '↑ Görünen Gelir', val: toplamGelir, renk: 'var(--green)', sub: `${rows.length} kayıt` },
          { label: '↓ Görünen Gider', val: toplamGider, renk: 'var(--red)', sub: `${rows.length} kayıt` },
          { label: '= Görünen Net', val: toplamGelir - toplamGider, renk: (toplamGelir - toplamGider) >= 0 ? 'var(--green)' : 'var(--red)', sub: 'Listelenen kayıtlar' },
        ].map(({ label, val, renk, sub }) => (
          <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 18, color: renk }}>{fmt(val)}</div>
            <div className="metric-sub" style={{ fontSize: 10, color: 'var(--text3)' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Filtre butonları */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <button className={`tab-pill ${!filtre ? 'active' : ''}`} onClick={() => setFiltre('')}>Tümü</button>
        {turler.map(t => (
          <button key={t} className={`tab-pill ${filtre === t ? 'active' : ''}`} onClick={() => setFiltre(t)}>
            {TUR_ETIKET[t] || t}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>İşlem Türü</th>
              <th>Açıklama</th>
              <th style={{ textAlign: 'right' }}>Tutar</th>
            </tr>
          </thead>
          <tbody>
            {!filtered.length ? (
              <tr><td colSpan={4}><div className="empty"><p>Kayıt yok</p></div></td></tr>
            ) : filtered.map(r => {
              const renk = TUR_RENK[r.islem_turu] || 'gray';
              const pozitif = r.tutar > 0;
              return (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.tarih)}</td>
                  <td><span className={`badge badge-${renk}`}>{TUR_ETIKET[r.islem_turu] || r.islem_turu}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{r.aciklama || '---'}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600, color: pozitif ? 'var(--green)' : 'var(--red)' }}>
                    {pozitif ? '+' : ''}{fmt(r.tutar)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
