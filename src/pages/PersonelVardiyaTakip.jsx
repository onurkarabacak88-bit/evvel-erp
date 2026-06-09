import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const AY_ADLARI = ['', 'Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                   'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function fmt(n, dk = false) {
  if (n == null || isNaN(n)) return '—';
  if (dk) {
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  }
  return Number(n).toFixed(1).replace('.', ',');
}

function Badge({ renk, label }) {
  const renkler = {
    sari: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)', text: '#f59e0b' },
    kirmizi: { bg: 'rgba(224,92,92,0.1)', border: 'rgba(224,92,92,0.3)', text: '#e05c5c' },
    yesil: { bg: 'rgba(76,175,132,0.1)', border: 'rgba(76,175,132,0.3)', text: '#4caf84' },
    mavi: { bg: 'rgba(74,158,255,0.1)', border: 'rgba(74,158,255,0.3)', text: '#4a9eff' },
  };
  const r = renkler[renk] || renkler.mavi;
  return (
    <span style={{
      padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      background: r.bg, border: `1px solid ${r.border}`, color: r.text,
    }}>{label}</span>
  );
}

function PersonelKart({ p, acik, onToggle }) {
  return (
    <div style={{
      marginBottom: 10, borderRadius: 12, overflow: 'hidden',
      border: '1px solid var(--border)', background: 'var(--bg2)',
    }}>
      {/* Özet satır */}
      <div onClick={onToggle} style={{
        padding: '14px 16px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text1)' }}>
            {p.ad_soyad}
            <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>
              {p.calisma_turu === 'surekli' ? 'Sürekli' : 'Part-time'}
            </span>
          </div>
        </div>

        {/* Özet metrikler */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: 'var(--text1)' }}>{fmt(p.toplam_planlanan_saat)}s</div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Plan</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: p.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : 'var(--text3)' }}>
              {fmt(p.toplam_fazla_mesai_saat)}s
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Fazla</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: p.toplam_gecikme_dk > 0 ? '#e05c5c' : 'var(--text3)' }}>
              {fmt(p.toplam_gecikme_dk, true)}
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Gecikme</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: '#4caf84' }}>{p.yemek_ucret_gun} gün</div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Yemek</div>
          </div>
          {p.part_tam_gun > 0 && <Badge renk="sari" label={`${p.part_tam_gun}g Part-Tam`} />}
        </div>

        <span style={{ color: 'var(--text3)', fontSize: 12 }}>{acik ? '▲' : '▼'}</span>
      </div>

      {/* Günlük detay */}
      {acik && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg3)' }}>
                {['Tarih','Plan','Gecikme','Fazla','Yemek','Uyarı'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(p.gunler || []).filter(g => g.planlanan_saat > 0).map((g, i) => (
                <tr key={g.tarih} style={{ borderTop: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg3)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>
                    {new Date(g.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' })}
                    {!g.giris_var && <span style={{ marginLeft: 6, color: '#e05c5c', fontSize: 10 }}>giriş yok</span>}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text1)', fontWeight: 600 }}>{fmt(g.planlanan_saat)}s</td>
                  <td style={{ padding: '8px 12px' }}>
                    {g.gecikme_dk > 0
                      ? <span style={{ color: '#e05c5c', fontWeight: 700 }}>{fmt(g.gecikme_dk, true)}</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {g.fazla_mesai_saat > 0
                      ? <span style={{ color: '#f59e0b', fontWeight: 700 }}>+{fmt(g.fazla_mesai_saat)}s</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {g.yemek_sure_dk != null
                      ? <span style={{ color: g.yemek_ucret_hakki ? '#4caf84' : '#e05c5c' }}>
                          {Math.round(g.yemek_sure_dk)}dk {g.yemek_ucret_hakki ? '✅' : '❌'}
                        </span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    {g.part_tam_uyari && <Badge renk="sari" label="Part-Tam" />}
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

export default function PersonelVardiyaTakip() {
  const bugun = new Date();
  const [yil, setYil] = useState(bugun.getFullYear());
  const [ay, setAy] = useState(bugun.getMonth() + 1);
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [aciklar, setAciklar] = useState({});

  const yukle = () => {
    setYukleniyor(true);
    api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}`)
      .then(setVeri).catch(console.error).finally(() => setYukleniyor(false));
  };

  useEffect(() => { yukle(); }, [yil, ay]);

  const toggle = (pid) => setAciklar(p => ({ ...p, [pid]: !p[pid] }));

  const personeller = veri?.personeller || [];
  const uyarilar = personeller.filter(p => p.part_tam_gun > 0 || p.toplam_gecikme_dk > 60);

  return (
    <div className="page">
      <div className="page-header">
        <h2>👥 Personel Vardiya Takip</h2>
        <p>Aylık mesai, gecikme, yemek molası ve part-tam uyarıları</p>
      </div>

      {/* Ay seçici */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <select value={yil} onChange={e => setYil(Number(e.target.value))}
          style={{ padding: '7px 10px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text1)', fontSize: 13 }}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={ay} onChange={e => setAy(Number(e.target.value))}
          style={{ padding: '7px 10px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text1)', fontSize: 13 }}>
          {AY_ADLARI.slice(1).map((ad, i) => <option key={i+1} value={i+1}>{ad}</option>)}
        </select>
        {yukleniyor && <div className="spinner" style={{ width: 16, height: 16 }} />}
      </div>

      {/* Uyarı özeti */}
      {uyarilar.length > 0 && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
          fontSize: 12, color: 'var(--text2)',
        }}>
          ⚠️ <strong>{uyarilar.length} personel</strong> dikkat gerektiriyor:
          {uyarilar.map(p => (
            <span key={p.personel_id} style={{ marginLeft: 8 }}>
              <strong>{p.ad_soyad}</strong>
              {p.part_tam_gun > 0 && ` · ${p.part_tam_gun}g part-tam`}
              {p.toplam_gecikme_dk > 60 && ` · ${fmt(p.toplam_gecikme_dk, true)} gecikme`}
            </span>
          ))}
        </div>
      )}

      {/* Genel özet */}
      {personeller.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Toplam Personel', val: personeller.length, renk: 'var(--text1)' },
            { label: 'Toplam Fazla Mesai', val: fmt(personeller.reduce((s,p)=>s+p.toplam_fazla_mesai_saat,0))+'s', renk: '#f59e0b' },
            { label: 'Part-Tam Uyarı', val: personeller.filter(p=>p.part_tam_gun>0).length + ' kişi', renk: '#f59e0b' },
            { label: 'Yemek Ücreti Toplam', val: new Intl.NumberFormat('tr-TR').format(personeller.reduce((s,p)=>s+p.yemek_ucret_tutari,0))+'₺', renk: '#4caf84' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: k.renk }}>{k.val}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Personel listesi */}
      {yukleniyor ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Yükleniyor…
        </div>
      ) : personeller.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          Bu ay için veri bulunamadı.
        </div>
      ) : (
        personeller.map(p => (
          <PersonelKart
            key={p.personel_id}
            p={p}
            acik={!!aciklar[p.personel_id]}
            onToggle={() => toggle(p.personel_id)}
          />
        ))
      )}
    </div>
  );
}
