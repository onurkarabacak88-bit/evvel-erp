import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

export default function Rapor() {
  const bugun = new Date();
  const [yil, setYil] = useState(bugun.getFullYear());
  const [ay, setAy] = useState(bugun.getMonth() + 1);
  const [rapor, setRapor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3500); };

  async function yukle() {
    setLoading(true);
    try {
      const r = await api(`/rapor/aylik?yil=${yil}&ay=${ay}`);
      setRapor(r);
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoading(false); }
  }

  useEffect(() => { yukle(); }, [yil, ay]);

  async function excelIndir() {
    setExcelLoading(true);
    try {
      const resp = await fetch(`/api/rapor/aylik/excel?yil=${yil}&ay=${ay}`);
      if (!resp.ok) throw new Error('Excel oluşturulamadı');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `evvel-rapor-${yil}-${String(ay).padStart(2,'0')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast('✓ Excel indirildi');
    } catch (e) { toast(e.message, 'red'); }
    finally { setExcelLoading(false); }
  }

  const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                 'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

  const yillar = Array.from({length: 3}, (_, i) => bugun.getFullYear() - i);

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between" style={{ marginBottom: 20 }}>
        <div>
          <h2>📊 Aylık Finansal Rapor</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>Dönem bazlı analiz ve Excel çıktısı</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={ay} onChange={e => setAy(+e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}>
            {AYLAR.map((a, i) => <option key={i} value={i+1}>{a}</option>)}
          </select>
          <select value={yil} onChange={e => setYil(+e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}>
            {yillar.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn btn-primary" onClick={excelIndir} disabled={excelLoading || !rapor}>
            {excelLoading ? '⏳ Hazırlanıyor...' : '⬇ Excel İndir'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>
      ) : !rapor ? null : (
        <>
          {/* ÖZET KARTLARI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: '↑ Toplam Gelir', val: rapor.ozet.toplam_gelir, renk: 'var(--green)' },
              { label: '↓ Toplam Gider', val: rapor.ozet.toplam_gider, renk: 'var(--red)' },
              { label: '= Net Kar/Zarar', val: rapor.ozet.toplam_gelir - rapor.ozet.toplam_gider, renk: (rapor.ozet.toplam_gelir - rapor.ozet.toplam_gider) >= 0 ? 'var(--green)' : 'var(--red)' },
              { label: '🏦 Ay Sonu Kasa', val: rapor.ozet.net_kasa, renk: 'var(--text1)' },
            ].map(({ label, val, renk }) => (
              <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
                <div className="metric-label">{label}</div>
                <div className="metric-value" style={{ fontSize: 22, color: renk }}>{fmt(val)}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

            {/* GELİR DAĞILIMI */}
            <div className="card">
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📈 Gelir Dağılımı</h3>
              {[
                { label: 'Ciro', val: rapor.ozet.ciro_toplam, renk: 'var(--green)' },
                { label: 'Dış Kaynak', val: rapor.ozet.dis_kaynak_toplam, renk: '#4a9eff' },
                { label: 'Devir (Önceki Ay)', val: rapor.ozet.devir_toplam, renk: 'var(--yellow)' },
              ].map(({ label, val, renk }) => {
                const oran = rapor.ozet.toplam_gelir > 0 ? (val / rapor.ozet.toplam_gelir) * 100 : 0;
                return (
                  <div key={label} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: 'var(--text2)' }}>{label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmt(val)}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 4 }}>
                      <div style={{ height: '100%', width: `${oran}%`, background: renk, borderRadius: 4 }} />
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>%{oran.toFixed(1)}</div>
                  </div>
                );
              })}
            </div>

            {/* GİDER DAĞILIMI */}
            <div className="card">
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📉 Gider Dağılımı</h3>
              {[
                { label: 'Kart Ödemeleri', val: rapor.ozet.kart_odeme_toplam },
                { label: 'Anlık Giderler', val: rapor.ozet.anlik_gider_toplam },
                { label: 'Vadeli Ödemeler', val: rapor.ozet.vadeli_toplam },
                { label: 'Personel Maaşları', val: rapor.ozet.maas_toplam },
                { label: 'Sabit Giderler', val: rapor.ozet.sabit_toplam },
              ].map(({ label, val }) => {
                const oran = rapor.ozet.toplam_gider > 0 ? (val / rapor.ozet.toplam_gider) * 100 : 0;
                return val > 0 ? (
                  <div key={label} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: 'var(--text2)' }}>{label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{fmt(val)}</span>
                    </div>
                    <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 4 }}>
                      <div style={{ height: '100%', width: `${oran}%`, background: 'var(--red)', borderRadius: 4, opacity: 0.7 }} />
                    </div>
                  </div>
                ) : null;
              })}
            </div>
          </div>

          {/* ŞUBE CİRO */}
          {rapor.sube_ciro?.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🏪 Şube Bazlı Ciro</h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg3)' }}>
                      {['Şube', 'Toplam Ciro', 'Nakit', 'POS', 'Online', 'İşlem'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: h === 'Şube' ? 'left' : 'right', fontWeight: 600, color: 'var(--text2)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rapor.sube_ciro.map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                          {s.sube}
                          {rapor.en_karli_sube?.sube === s.sube && <span className="badge badge-green" style={{ marginLeft: 6, fontSize: 10 }}>En Yüksek</span>}
                        </td>
                        {['ciro','nakit','pos','online'].map(k => (
                          <td key={k} style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmt(s[k])}</td>
                        ))}
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{s.islem_sayisi}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* GİDER KATEGORİLER */}
          {rapor.gider_kategoriler?.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🗂 Gider Kategorileri</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rapor.gider_kategoriler.map((g, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg3)', borderRadius: 6 }}>
                    <span style={{ fontSize: 12 }}>{g.kategori}</span>
                    <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>{g.adet} işlem</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{fmt(g.toplam)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* KART ÖDEMELERİ */}
          {rapor.kart_odemeler?.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>💳 Kart Ödemeleri</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rapor.kart_odemeler.map((k, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--bg3)', borderRadius: 6 }}>
                    <div>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{k.kart_adi}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 6 }}>{k.banka}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                      <span style={{ color: 'var(--text3)' }}>{k.adet} ödeme</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{fmt(k.odenen)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
