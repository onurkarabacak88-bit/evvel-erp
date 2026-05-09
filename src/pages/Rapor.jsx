import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api, fmt } from '../utils/api';

const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function pct(val, total) {
  if (!total || total === 0) return 0;
  return Math.round((val / total) * 100);
}

function degisim(yeni, eski) {
  if (!eski || eski === 0) return null;
  return ((yeni - eski) / Math.abs(eski)) * 100;
}

function BarMetre({ val, total, renk }) {
  const w = total > 0 ? Math.min(100, (val / total) * 100) : 0;
  return (
    <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 3, marginTop: 4 }}>
      <div style={{ height: '100%', width: `${w}%`, background: renk || 'var(--green)', borderRadius: 3, transition: 'width .4s' }} />
    </div>
  );
}

const GIDER_RENK = {
  'Kart Ödemeleri': '#e05252',
  'Anlık Giderler': '#e08020',
  'Personel Maaşları': '#9b59b6',
  'Sabit Giderler': '#3498db',
  'Vadeli Ödemeler': '#e67e22',
  'Kart Faizi': '#c0392b',
};

export default function Rapor() {
  const bugun = new Date();
  const [yil, setYil] = useState(bugun.getFullYear());
  const [ay, setAy] = useState(bugun.getMonth() + 1);
  const [rapor, setRapor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [excelLoading, setExcelLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [acik, setAcik] = useState({ sabit: false, personel: false, anlik: false, kart: false });

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3500); };
  const toggle = (k) => setAcik(p => ({ ...p, [k]: !p[k] }));

  async function yukle() {
    setLoading(true);
    try { const r = await api(`/rapor/aylik?yil=${yil}&ay=${ay}`); setRapor(r); }
    catch (e) { toast(e.message, 'red'); }
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
      a.href = url; a.download = `evvel-rapor-${yil}-${String(ay).padStart(2,'0')}.xlsx`;
      a.click(); URL.revokeObjectURL(url);
      toast('Excel indirildi');
    } catch (e) { toast(e.message, 'red'); }
    finally { setExcelLoading(false); }
  }

  const yillar = Array.from({ length: 3 }, (_, i) => bugun.getFullYear() - i);
  const o = rapor?.ozet || {};
  const onc = rapor?.onceki_ay || {};

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between" style={{ marginBottom: 20 }}>
        <div>
          <h2>Aylık Finansal Rapor</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>{rapor ? rapor.donem_label : '—'} · Gerçekleşen veriler</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={ay} onChange={e => setAy(+e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}>
            {AYLAR.map((a, i) => <option key={i} value={i + 1}>{a}</option>)}
          </select>
          <select value={yil} onChange={e => setYil(+e.target.value)}
            style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}>
            {yillar.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn btn-primary" onClick={excelIndir} disabled={excelLoading || !rapor}>
            {excelLoading ? '⏳...' : '⬇ Excel'}
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>
      ) : !rapor ? null : (<>

        {/* ÖZET KARTLARI */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
          {[
            { label: '↑ Toplam Gelir',    val: o.toplam_gelir,   renk: 'var(--green)',  eski: onc.gelir },
            { label: '↓ Toplam Gider',    val: o.toplam_gider,   renk: 'var(--red)',    eski: onc.gider },
            { label: '= Net Kar / Zarar', val: o.net_kar_zarar,  renk: o.net_kar_zarar >= 0 ? 'var(--green)' : 'var(--red)', eski: null },
            { label: '🏦 Ay Sonu Kasa',   val: o.bitis_kasa,     renk: 'var(--text1)',  eski: null, sub: `Başlangıç: ${fmt(o.baslangic_kasa)}` },
          ].map(({ label, val, renk, eski, sub }) => {
            const d = eski ? degisim(val, eski) : null;
            const pos = d !== null && d >= 0;
            return (
              <div key={label} className="stat-card" style={{ borderTop: `3px solid ${renk}` }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)' }}>{fmt(val)}</div>
                {d !== null && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, marginTop: 4, display: 'inline-block',
                    background: pos ? 'rgba(0,200,100,0.12)' : 'rgba(220,50,50,0.12)', color: pos ? 'var(--green)' : 'var(--red)' }}>
                    {pos ? '▲' : '▼'} %{Math.abs(d).toFixed(1)}
                  </span>
                )}
                {sub && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{sub}</div>}
              </div>
            );
          })}
        </div>

        {/* GELİR + GİDER DAĞILIMI */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div className="card">
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📈 Gelir Dağılımı</h3>
            {[
              { label: 'Nakit Ciro',      val: o.ciro_nakit,       renk: '#27ae60' },
              { label: 'POS Ciro',        val: o.ciro_pos,          renk: '#2ecc71' },
              { label: 'Online Ciro',     val: o.ciro_online,       renk: '#58d68d' },
              { label: 'Dış Kaynak',      val: o.dis_kaynak_toplam, renk: '#4a9eff' },
              { label: 'Devir (Önceki)',  val: o.devir_toplam,      renk: 'var(--yellow)' },
              { label: '↩ İptal Edilen Ciro', val: -(parseFloat(o.ciro_iptal_toplam||0)), renk: 'var(--red)' },
            ].filter(r => parseFloat(r.val||0) !== 0).map(({ label, val, renk }) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: 'var(--text2)' }}>{label}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--text3)', fontSize: 11 }}>%{pct(val, o.toplam_gelir)}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmt(val)}</span>
                  </div>
                </div>
                <BarMetre val={parseFloat(val||0)} total={parseFloat(o.toplam_gelir||0)} renk={renk} />
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)' }}>{o.ciro_islem || 0} ciro işlemi</span>
              <span style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(o.toplam_gelir)}</span>
            </div>
          </div>

          <div className="card">
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📉 Gider Dağılımı</h3>
            {[
              { label: 'Kart Ödemeleri',   val: o.kart_toplam },
              { label: 'Anlık Giderler',   val: o.anlik_toplam },
              { label: 'Personel Maaşları',val: o.maas_toplam },
              { label: 'Sabit Giderler',   val: o.sabit_toplam },
              { label: 'Vadeli Ödemeler',  val: o.vadeli_toplam },
              { label: 'Kart Faizi',       val: o.kart_faiz_toplam },
            ].filter(r => parseFloat(r.val||0) > 0).map(({ label, val }) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: 'var(--text2)' }}>{label}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ color: 'var(--text3)', fontSize: 11 }}>%{pct(val, o.toplam_gider)}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{fmt(val)}</span>
                  </div>
                </div>
                <BarMetre val={parseFloat(val||0)} total={parseFloat(o.toplam_gider||0)} renk={GIDER_RENK[label] || 'var(--red)'} />
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
              <span style={{ color: 'var(--text3)' }}>Toplam gider</span>
              <span style={{ fontWeight: 700, color: 'var(--red)' }}>{fmt(o.toplam_gider)}</span>
            </div>
          </div>
        </div>

        {/* GÜNLÜK KASA GRAFİĞİ */}
        {rapor.gunluk?.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📈 Günlük Kasa Seyri</h3>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={rapor.gunluk} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis dataKey="tarih" tick={{ fontSize: 10 }} tickFormatter={d => d?.slice(8)} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={v => (v/1000).toFixed(0)+'K'} width={45} />
                <Tooltip formatter={v => [fmt(v), 'Kasa']} labelFormatter={l => l}
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 11 }} />
                <Line type="monotone" dataKey="kasa" stroke="var(--green)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ÖNCEKI AY KARŞILAŞTIRMA */}
        {(parseFloat(onc.gelir||0) > 0 || parseFloat(onc.gider||0) > 0) && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🔄 Geçen Ay Karşılaştırması</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
              {[
                { label: 'Ciro',          bu: o.ciro_toplam,   onc: onc.ciro },
                { label: 'Toplam Gelir',  bu: o.toplam_gelir,  onc: onc.gelir },
                { label: 'Toplam Gider',  bu: o.toplam_gider,  onc: onc.gider },
              ].map(({ label, bu, onc: o2 }) => {
                const d = degisim(bu, o2);
                const pos = d !== null && d >= 0;
                return (
                  <div key={label} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmt(bu)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                      Önceki: {fmt(o2)}
                      {d !== null && (
                        <span style={{ marginLeft: 6, color: pos ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                          {pos ? '▲' : '▼'} %{Math.abs(d).toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ŞUBE CİRO */}
        {rapor.sube_ciro?.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🏪 Şube Bazlı Ciro</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: 'var(--bg3)' }}>
                {['Şube','Toplam','Nakit','POS','Online','İşlem'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h==='Şube'?'left':'right', fontWeight: 600, color: 'var(--text2)' }}>{h}</th>
                ))}
              </tr></thead>
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
        )}

        {/* DETAY BÖLÜMLER — açılır kapanır */}
        {[
          { key: 'sabit', icon: '🏠', label: 'Sabit Giderler', data: rapor.sabit_detay, toplam: rapor.sabit_detay?.reduce((s,r)=>s+parseFloat(r.odenen||0),0),
            render: (g, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12 }}>
                <div><span style={{fontWeight:500}}>{g.gider_adi}</span>{g.kategori&&<span style={{marginLeft:6,color:'var(--text3)',fontSize:11}}>{g.kategori}</span>}</div>
                <div style={{display:'flex',gap:12,alignItems:'center'}}>
                  <span style={{color:'var(--text3)',fontSize:11}}>{g.odeme_tarihi}</span>
                  <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--red)'}}>{fmt(g.odenen)}</span>
                </div>
              </div>
            )},
          { key: 'personel', icon: '👥', label: 'Personel Maaşları', data: rapor.personel_detay, toplam: rapor.personel_detay?.reduce((s,r)=>s+parseFloat(r.odenen||0),0),
            render: (p, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12 }}>
                <div><span style={{fontWeight:500}}>{p.ad_soyad}</span>{p.gorev&&<span style={{marginLeft:6,color:'var(--text3)',fontSize:11}}>{p.gorev}</span>}</div>
                <div style={{display:'flex',gap:12,alignItems:'center'}}>
                  <span style={{color:'var(--text3)',fontSize:11}}>{p.odeme_tarihi}</span>
                  <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--red)'}}>{fmt(p.odenen)}</span>
                </div>
              </div>
            )},
          { key: 'anlik', icon: '💸', label: 'Anlık Gider Kategorileri', data: rapor.anlik_kategoriler, toplam: parseFloat(o.anlik_toplam||0),
            render: (g, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12 }}>
                <span style={{fontWeight:500}}>{g.kategori}</span>
                <div style={{display:'flex',gap:12}}>
                  <span style={{color:'var(--text3)',fontSize:11}}>{g.adet} işlem</span>
                  <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--red)'}}>{fmt(g.toplam)}</span>
                </div>
              </div>
            )},
          { key: 'kart', icon: '💳', label: 'Kart Ödemeleri', data: rapor.kart_detay, toplam: parseFloat(o.kart_toplam||0),
            render: (k, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12 }}>
                <div><span style={{fontWeight:500}}>{k.kart_adi}</span><span style={{marginLeft:6,color:'var(--text3)',fontSize:11}}>{k.banka}</span></div>
                <div style={{display:'flex',gap:12}}>
                  <span style={{color:'var(--text3)',fontSize:11}}>{k.adet} ödeme</span>
                  <span style={{fontFamily:'var(--font-mono)',fontWeight:600,color:'var(--red)'}}>{fmt(k.anapara)}</span>
                </div>
              </div>
            )},
        ].filter(b => b.data?.length > 0).map(({ key, icon, label, data, toplam, render }) => (
          <div key={key} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', cursor:'pointer', marginBottom: acik[key] ? 12 : 0 }} onClick={() => toggle(key)}>
              <h3 style={{ fontSize:13, fontWeight:600 }}>
                {icon} {label} <span style={{fontWeight:400,color:'var(--text3)'}}>({data.length} kalem)</span>
                {' · '}<span style={{color:'var(--red)',fontFamily:'var(--font-mono)'}}>{fmt(toplam)}</span>
              </h3>
              <span style={{fontSize:12,color:'var(--text3)'}}>{acik[key] ? '▲ Kapat' : '▼ Detay'}</span>
            </div>
            {acik[key] && <div style={{display:'flex',flexDirection:'column',gap:4}}>{data.map(render)}</div>}
          </div>
        ))}

      </>)}
    </div>
  );
}
