import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const VT_ETIKET = { sabahci: 'Sabahçı', ara_vardiya: 'Ara Vardiya', kapanis: 'Kapanış' };

export default function GorevListesi({ subeId, vardiyaTip, tarih, personelId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    if (!subeId || !vardiyaTip || !tarih) return;
    setLoading(true);
    api(`/gorev/vardiya?tarih=${tarih}&sube_id=${encodeURIComponent(subeId)}&vardiya_tip=${vardiyaTip}`)
      .then(setData).catch(console.error).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [subeId, vardiyaTip, tarih]);

  const toggle = async (sablonId, current) => {
    await api('/gorev/tamamla', {
      method: 'POST',
      body: { tarih, sube_id: subeId, sablon_id: sablonId, tamamlandi: !current, personel_id: personelId || null }
    });
    load();
  };

  if (loading) return <div className="spinner" style={{ margin: '20px auto' }} />;
  if (!data) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)' }}>
          {VT_ETIKET[vardiyaTip] || vardiyaTip} Görevleri
        </div>
        <div style={{ fontSize: 11, color: data.eksik > 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
          {data.tamamlanan}/{data.toplam}
          {data.eksik > 0 ? ` · ${data.eksik} eksik` : ' · Tamamlandı ✓'}
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {data.gorevler.map((g, i) => (
          <div key={g.id}
            onClick={() => toggle(g.id, g.tamamlandi)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', cursor: 'pointer',
              borderBottom: i < data.gorevler.length - 1 ? '1px solid var(--border)' : 'none',
              background: g.tamamlandi ? 'rgba(76,175,132,0.05)' : 'var(--bg2)',
              transition: 'background 0.12s',
            }}
          >
            <div style={{
              width: 18, height: 18, borderRadius: 4, flexShrink: 0,
              border: `2px solid ${g.tamamlandi ? 'var(--green)' : 'var(--border)'}`,
              background: g.tamamlandi ? 'var(--green)' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {g.tamamlandi && <span style={{ color: '#fff', fontSize: 11, lineHeight: 1 }}>✓</span>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 12, fontWeight: 500,
                color: g.tamamlandi ? 'var(--text3)' : 'var(--text1)',
                textDecoration: g.tamamlandi ? 'line-through' : 'none',
              }}>
                {g.gorev}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>
                {g.alan}{g.siklik ? ` · ${g.siklik}` : ''}
              </div>
            </div>
            <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 600 }}>{g.sira}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
