import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const VT_ETIKET = {
  sabahci:     { label: 'Sabahçı',    renk: '#4a9eff' },
  ara_vardiya: { label: 'Ara Vardiya', renk: '#f59e0b' },
  kapanis:     { label: 'Kapanış',    renk: '#C8956A' },
};

export default function GorevPersonelSayfasi({ oturum, subeBilgi, onCikis }) {
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islem, setIslem] = useState({}); // sablon_id → loading

  const load = () => {
    const { tarih, sube_id, vardiya_tip, personel_id } = oturum;
    api(`/gorev/personel-vardiya?tarih=${tarih}&sube_id=${sube_id}&vardiya_tip=${vardiya_tip}&personel_id=${personel_id}`)
      .then(setData).catch(console.error).finally(() => setYukleniyor(false));
  };

  useEffect(() => { load(); }, []);

  const toggle = async (g) => {
    if (islem[g.id]) return;
    setIslem(m => ({ ...m, [g.id]: true }));
    try {
      await api('/gorev/tamamla', {
        method: 'POST',
        body: {
          tarih: oturum.tarih,
          sube_id: oturum.sube_id,
          sablon_id: g.id,
          tamamlandi: !g.tamamlandi,
          personel_id: oturum.personel_id,
        },
      });
      setData(d => {
        if (!d) return d;
        const gorevler = d.gorevler.map(x =>
          x.id === g.id ? { ...x, tamamlandi: !x.tamamlandi } : x
        );
        const tamamlanan = gorevler.filter(x => x.tamamlandi).length;
        return { ...d, gorevler, tamamlanan, eksik: gorevler.length - tamamlanan };
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIslem(m => ({ ...m, [g.id]: false }));
    }
  };

  const vt = VT_ETIKET[oturum.vardiya_tip] || { label: oturum.vardiya_tip, renk: '#6b6f7a' };
  const tamamYuzde = data ? Math.round((data.tamamlanan / data.toplam) * 100) : 0;

  const PAGE = {
    minHeight: '100vh', background: '#0f1117', color: '#e8e9ec',
    fontFamily: 'Instrument Sans, sans-serif',
  };

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #2a2d35',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, background: '#0f1117', zIndex: 10,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {subeBilgi?.ad || 'Şube'} · {vt.label}
          </div>
          <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 2 }}>
            {oturum.ad_soyad} · {oturum.tarih}
          </div>
        </div>
        <button onClick={onCikis} style={{
          background: 'none', border: '1px solid #2a2d35', borderRadius: 8,
          color: '#6b6f7a', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
        }}>
          Çıkış
        </button>
      </div>

      {/* İlerleme */}
      {data && (
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2d35' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
            <span style={{ color: '#b0b3bc' }}>Tamamlanan</span>
            <span style={{ fontWeight: 700, color: data.eksik === 0 ? '#4caf84' : vt.renk }}>
              {data.tamamlanan}/{data.toplam}
              {data.eksik === 0 ? ' · Tamamlandı ✓' : ` · ${data.eksik} kaldı`}
            </span>
          </div>
          <div style={{ height: 6, background: '#2a2d35', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${tamamYuzde}%`,
              background: data.eksik === 0 ? '#4caf84' : vt.renk,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Görev listesi */}
      <div style={{ padding: '12px 16px', paddingBottom: 80 }}>
        {yukleniyor ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b6f7a' }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Görevler yükleniyor…
          </div>
        ) : !data?.gorevler?.length ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b6f7a' }}>
            Bu vardiya için görev bulunamadı.
          </div>
        ) : (
          data.gorevler.map((g, i) => (
            <div key={g.id}
              onClick={() => toggle(g)}
              style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 12px', borderRadius: 10, marginBottom: 8,
                background: g.tamamlandi ? 'rgba(76,175,132,0.06)' : '#1a1d24',
                border: `1px solid ${g.tamamlandi ? 'rgba(76,175,132,0.25)' : '#2a2d35'}`,
                cursor: islem[g.id] ? 'wait' : 'pointer',
                transition: 'all 0.15s',
                opacity: islem[g.id] ? 0.6 : 1,
              }}
            >
              {/* Checkbox */}
              <div style={{
                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                border: `2px solid ${g.tamamlandi ? '#4caf84' : '#6b6f7a'}`,
                background: g.tamamlandi ? '#4caf84' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}>
                {g.tamamlandi && <span style={{ color: '#fff', fontSize: 14, lineHeight: 1 }}>✓</span>}
              </div>

              {/* Görev içeriği */}
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 14, fontWeight: 500,
                  color: g.tamamlandi ? '#6b6f7a' : '#e8e9ec',
                  textDecoration: g.tamamlandi ? 'line-through' : 'none',
                  lineHeight: 1.35,
                }}>
                  {g.gorev}
                </div>
                <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 3 }}>
                  <span style={{
                    background: '#22262f', borderRadius: 4, padding: '1px 6px', marginRight: 6
                  }}>{g.alan}</span>
                  {g.siklik}
                </div>
              </div>

              {/* Sıra no */}
              <span style={{ fontSize: 11, color: '#2a2d35', fontWeight: 700, flexShrink: 0 }}>
                {g.sira}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Alt bant — tüm tamamlandıysa kutlama */}
      {data?.eksik === 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: 'rgba(76,175,132,0.15)', borderTop: '1px solid rgba(76,175,132,0.3)',
          padding: '14px 20px', textAlign: 'center',
          fontSize: 14, fontWeight: 700, color: '#4caf84',
        }}>
          ✅ Tüm görevler tamamlandı!
        </div>
      )}
    </div>
  );
}
