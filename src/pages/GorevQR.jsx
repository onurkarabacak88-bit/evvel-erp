import { useState, useEffect } from 'react';
import { api } from '../utils/api';

export default function GorevQR() {
  const [subeler, setSubeler] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/gorev/qr-liste')
      .then(setSubeler)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 12 }}>
      <div className="spinner" />
      <span style={{ fontSize: 13, color: 'var(--text3)' }}>QR kodlar hazırlanıyor…</span>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h2>📱 Şube QR Kodları</h2>
        <p>Her şubenin kasasına asın. Personel okutunca görev listesine direkt ulaşır.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20 }}>
        {subeler.map(s => (
          <div key={s.sube_id} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 20, textAlign: 'center',
          }}>
            {/* Şube adı */}
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text1)', marginBottom: 16 }}>
              {s.sube_ad}
            </div>

            {/* QR görüntüsü */}
            <div style={{
              background: '#fff', borderRadius: 10, padding: 12,
              display: 'inline-block', marginBottom: 14,
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            }}>
              <img
                src={s.qr_url}
                alt={`${s.sube_ad} QR`}
                style={{ width: 180, height: 180, display: 'block' }}
              />
            </div>

            {/* Bilgi */}
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14, lineHeight: 1.5 }}>
              Personel bu kodu okutunca<br />
              görev listesine ulaşır
            </div>

            {/* Butonlar */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <a
                href={s.qr_url}
                download={`${s.sube_ad}_qr.png`}
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  background: 'var(--accent-dim)', color: 'var(--accent)',
                  border: '1px solid var(--accent-border)', textDecoration: 'none',
                  cursor: 'pointer',
                }}
              >
                İndir
              </a>
              <a
                href={s.giris_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  background: 'var(--bg3)', color: 'var(--text2)',
                  border: '1px solid var(--border)', textDecoration: 'none',
                }}
              >
                Önizle
              </a>
            </div>
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 24, padding: '12px 16px', borderRadius: 10,
        background: 'rgba(200,149,106,0.08)', border: '1px solid var(--accent-border)',
        fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
      }}>
        💡 <strong>Nasıl kullanılır?</strong> Her şube için QR kodu indirin, A4 kağıda yazdırın ve kasanın yanına asın.
        Personel sabah vardiyasına gelince telefonuyla okutur, adını seçer ve görevlerini görür.
      </div>
    </div>
  );
}
