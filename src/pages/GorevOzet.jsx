import { useState, useEffect } from 'react';
import { bugunTR } from '../utils/trTarih';
import { api, fmt } from '../utils/api';

const VT_ETIKET = { sabahci: 'Sabahçı', ara_vardiya: 'Ara Vardiya', kapanis: 'Kapanış' };
const VT_RENK   = { sabahci: 'var(--clr-personel)', ara_vardiya: 'var(--yellow)', kapanis: 'var(--accent)' };

function YuzdeBar({ tamamlanan, toplam }) {
  const pct = toplam > 0 ? Math.round((tamamlanan / toplam) * 100) : 0;
  const renk = pct === 100 ? 'var(--green)' : pct >= 60 ? 'var(--yellow)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg3)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: renk, borderRadius: 3, transition: 'width .3s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)', minWidth: 32 }}>
        {pct}%
      </span>
    </div>
  );
}

export default function GorevOzet() {
  const bugun = bugunTR();
  const [tarih, setTarih] = useState(bugun);
  const [ozet, setOzet] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    setYukleniyor(true);
    api(`/gorev/ozet?tarih=${tarih}`)
      .then(setOzet)
      .catch(console.error)
      .finally(() => setYukleniyor(false));
  }, [tarih]);

  // Şube bazlı grupla
  const subeMap = {};
  ozet.forEach(r => {
    if (!subeMap[r.sube_id]) subeMap[r.sube_id] = { ad: r.sube_adi, vardiyalar: {} };
    subeMap[r.sube_id].vardiyalar[r.vardiya_tip] = {
      toplam: parseInt(r.toplam),
      tamamlanan: parseInt(r.tamamlanan),
    };
  });
  const subeler = Object.entries(subeMap);

  // Genel toplamlar
  const genelToplam    = ozet.reduce((s, r) => s + parseInt(r.toplam), 0);
  const genelTamamlanan = ozet.reduce((s, r) => s + parseInt(r.tamamlanan), 0);

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>✅ Görev Takibi</h2>
          <p>Şube bazlı günlük görev tamamlanma durumu</p>
        </div>
        <input type="date" value={tarih} onChange={e => setTarih(e.target.value)}
          style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 10px', color: 'var(--text)', fontSize: 13 }} />
      </div>

      {/* Genel özet */}
      {!yukleniyor && genelToplam > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
          marginBottom: 20,
        }}>
          {[
            { label: 'Toplam Görev',    value: genelToplam,                   renk: 'var(--text1)' },
            { label: 'Tamamlanan',      value: genelTamamlanan,               renk: 'var(--green)' },
            { label: 'Eksik',           value: genelToplam - genelTamamlanan,  renk: genelToplam - genelTamamlanan > 0 ? 'var(--red)' : 'var(--green)' },
          ].map(({ label, value, renk }) => (
            <div key={label} className="metric-card" style={{ textAlign: 'center' }}>
              <div className="metric-label">{label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: renk, fontFamily: 'var(--font-mono)' }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {yukleniyor ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <div className="spinner" />
        </div>
      ) : subeler.length === 0 ? (
        <div className="empty" style={{ padding: 40 }}>
          <p>Bu tarih için görev kaydı yok</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {subeler.map(([sid, s]) => {
            const vardiyalar = ['sabahci', 'ara_vardiya', 'kapanis'];
            const subeToplam     = vardiyalar.reduce((a, vt) => a + (s.vardiyalar[vt]?.toplam    || 0), 0);
            const subeTamamlanan = vardiyalar.reduce((a, vt) => a + (s.vardiyalar[vt]?.tamamlanan || 0), 0);
            return (
              <div key={sid} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                {/* Şube başlık */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text1)' }}>{s.ad}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                      {subeTamamlanan}/{subeToplam}
                    </span>
                    <div style={{ width: 120 }}>
                      <YuzdeBar tamamlanan={subeTamamlanan} toplam={subeToplam} />
                    </div>
                  </div>
                </div>
                {/* Vardiya kırılımı */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  {vardiyalar.map((vt, i) => {
                    const vd = s.vardiyalar[vt] || { toplam: 0, tamamlanan: 0 };
                    const renk = VT_RENK[vt];
                    return (
                      <div key={vt} style={{
                        padding: '10px 14px',
                        borderRight: i < 2 ? '1px solid var(--border)' : 'none',
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: renk, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>
                          {VT_ETIKET[vt]}
                        </div>
                        {vd.toplam === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>—</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
                              {vd.tamamlanan}/{vd.toplam}
                            </div>
                            <YuzdeBar tamamlanan={vd.tamamlanan} toplam={vd.toplam} />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
