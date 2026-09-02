import { useState, useEffect, Fragment } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { api, fmt } from '../utils/api';

const RENKLER = [
  '#6366f1', '#10b981', 'var(--orange)', 'var(--red)', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#c084fc',
];

const AY_TR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
function ayEtiket(donem) {
  if (!donem) return '—';
  const [y, m] = donem.slice(0, 7).split('-');
  const mi = parseInt(m, 10) - 1;
  return `${AY_TR[mi] || m} ${y}`;
}
function trTarih(s) {
  if (!s) return '—';
  const [y, m, g] = s.slice(0, 10).split('-');
  return `${g}.${m}.${y}`;
}

export default function KartEkstreAnaliz() {
  const [d, setD] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [arsiv, setArsiv] = useState(null);
  const [arsivYukleniyor, setArsivYukleniyor] = useState(true);
  const [acikKart, setAcikKart] = useState(null);
  const [msg, setMsg] = useState(null);

  const arsivYukle = () => {
    setArsivYukleniyor(true);
    api('/kartlar/ekstre-arsiv').then(setArsiv).catch(() => setArsiv(null)).finally(() => setArsivYukleniyor(false));
  };

  useEffect(() => {
    api('/kartlar/analiz').then(setD).catch(() => setD(null)).finally(() => setYukleniyor(false));
    arsivYukle();
  }, []);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  async function donemSil(kart_id, donem, kart_adi) {
    if (!window.confirm(`"${kart_adi}" — ${ayEtiket(donem)} dönemine ait ekstre hareketlerini silmek istediğine emin misin?\n\nBu işlem o aya ait harcama/faiz kayıtlarını siler (ödemelere dokunmaz). Sonra "Ekstre Yükle" sekmesinden doğru ekstreyi tekrar yükleyebilirsin.`)) return;
    try {
      const r = await api(`/kartlar/${kart_id}/ekstre-donem/${donem}`, { method: 'DELETE' });
      // KART-011: elle girilmiş satırlar artık korunuyor — kaçının korunduğu
      // söylenmezse sahip "hepsi silindi" sanar.
      const _kor = Number(r?.korunan_manuel_satir || 0);
      const _plan = Number(r?.iptal_odeme_plani || 0);
      setMsg({
        t: _kor ? 'yellow' : 'green',
        m: `✓ ${r.kart_adi} — ${ayEtiket(donem)} dönemi silindi (${r.silinen_hareket} ekstre satırı)`
          + (_plan ? ` · ${_plan} ödeme planı iptal edildi` : '')
          + (_kor ? ` · ⚠ ${_kor} elle girilmiş satır KORUNDU` : '')
          + `. Şimdi "Ekstre Yükle" ile tekrar yükleyebilirsin.`,
      });
      arsivYukle();
    } catch (e) {
      setMsg({ t: 'red', m: e.message || 'Silinemedi' });
    }
  }

  if (yukleniyor) return <div className="page"><div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}><span className="spinner" /> Yükleniyor…</div></div>;

  const bosVeri = !d || !d.veri_var;
  const arsivKartlar = arsiv?.kartlar || [];

  return (
    <div className="page">
      <style>{`
        .ea-row { cursor: pointer; transition: background .15s ease; }
        .ea-row:hover { background: var(--bg2); }
        .ea-plus { display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--border);
          background: var(--bg3); color: var(--text2); font-size: 15px; font-weight: 700;
          line-height: 1; transition: transform .2s cubic-bezier(.34,1.56,.64,1), background .15s ease; }
        .ea-row:hover .ea-plus { background: var(--accent); color: #fff; border-color: var(--accent); }
        .ea-plus.acik { transform: rotate(45deg); }
        .ea-detay { animation: eaFade .26s cubic-bezier(.22,.61,.36,1); }
        @keyframes eaFade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      `}</style>
      <div className="page-header">
        <h2>📂 Ekstre Analizi</h2>
        <p>İçe aktarılmış kart verisinden kategori, trend ve dağılım. <strong>Yükleme “Ekstre Yükle” sekmesinden yapılır.</strong></p>
      </div>

      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      {bosVeri ? (
        <div className="card" style={{ padding: 30, textAlign: 'center', color: 'var(--text3)' }}>
          <div style={{ fontSize: 34, marginBottom: 10 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)' }}>Henüz analiz verisi yok</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>
            <strong>Ekstre Yükle</strong> sekmesinden ekstre yükleyip işlemleri içe aktarın — kategori ve trendler burada görünecek.
          </div>
        </div>
      ) : (
        <>
          {d.aylik?.length > 0 && (
            <div className="card mb-16" style={{ padding: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>📉 Aylık Borç & Bankaya Ödenen Faiz</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={d.aylik.map(a => ({ ay: (a.donem || '').slice(0, 7), Borç: a.borc, Faiz: a.faiz }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="ay" tick={{ fontSize: 11, fill: 'var(--text3)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text3)' }} />
                  <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)' }} />
                  <Legend />
                  <Bar dataKey="Borç" fill="var(--red)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Faiz" fill="var(--orange)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 12 }}>
            {d.kategori?.length > 0 && (
              <div className="card" style={{ padding: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>🏷 Harcama Kategorileri</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={d.kategori} dataKey="tutar" nameKey="kategori" cx="50%" cy="50%" outerRadius={85} label={(e) => e.kategori}>
                      {d.kategori.map((e, i) => <Cell key={i} fill={RENKLER[i % RENKLER.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {d.kart_bazli?.length > 0 && (
              <div className="card" style={{ padding: 16 }}>
                <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>💳 Kart Bazlı Harcama</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={d.kart_bazli} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text3)' }} />
                    <YAxis type="category" dataKey="kart_adi" tick={{ fontSize: 10, fill: 'var(--text3)' }} width={110} />
                    <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)' }} />
                    <Bar dataKey="harcama" fill="#6366f1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {d.kategori?.length > 0 && (
            <div className="card" style={{ padding: 0, marginTop: 12 }}>
              <div style={{ padding: '12px 16px', fontWeight: 700 }}>📊 Kategori Özeti</div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Kategori</th><th style={{ textAlign: 'right' }}>Adet</th><th style={{ textAlign: 'right' }}>Tutar</th></tr></thead>
                  <tbody>
                    {d.kategori.map((k, i) => (
                      <tr key={i}>
                        <td><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: RENKLER[i % RENKLER.length], marginRight: 7 }} />{k.kategori}</td>
                        <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{k.adet}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmt(k.tutar)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── KART × AY EKSTRE ARŞİVİ (accordion) ── */}
      <div className="card" style={{ padding: 0, marginTop: 16 }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700 }}>🗂 Kart × Ay Ekstre Arşivi</div>
          {!arsivYukleniyor && arsivKartlar.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>
              {arsivKartlar.length} kart · ekstre saklanan aylar — bir karta tıklayıp <strong>+</strong> ile aylık geçmişi açın
            </div>
          )}
        </div>

        {arsivYukleniyor ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}><span className="spinner" /> Arşiv yükleniyor…</div>
        ) : arsivKartlar.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12.5 }}>
            Henüz arşivlenmiş ekstre yok. <strong>Ekstre Yükle</strong> sekmesinden ekstre yükleyince her kart ve her ay burada ay ay birikir.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th>Kart</th>
                  <th>Sahip</th>
                  <th style={{ textAlign: 'right' }}>Ay Sayısı</th>
                  <th>Son Ekstre</th>
                  <th style={{ textAlign: 'right' }}>Toplam Faiz</th>
                </tr>
              </thead>
              <tbody>
                {arsivKartlar.map((k) => {
                  const acik = acikKart === k.kart_id;
                  return (
                    <Fragment key={k.kart_id}>
                      <tr className="ea-row" onClick={() => setAcikKart(acik ? null : k.kart_id)}>
                        <td><span className={`ea-plus${acik ? ' acik' : ''}`}>+</span></td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{k.kart_adi}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            {k.banka}{k.son_dort_hane ? ` ····${k.son_dort_hane}` : ''}
                          </div>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text3)' }}>{k.sahip}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{k.donem_adet}</td>
                        <td style={{ fontSize: 12 }}>{ayEtiket(k.son_donem)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmt(k.toplam_faiz)}</td>
                      </tr>
                      {acik && (
                        <tr className="ea-detay">
                          <td colSpan={6} style={{ background: 'var(--bg2)', padding: '10px 16px 14px' }}>
                            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8, fontWeight: 600 }}>
                              {k.kart_adi} — Aylık Ekstre Geçmişi
                            </div>
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Dönem</th>
                                    <th>Kesim</th>
                                    <th>Son Ödeme</th>
                                    <th style={{ textAlign: 'right' }}>Dönem Borcu</th>
                                    <th style={{ textAlign: 'right' }}>Asgari</th>
                                    <th style={{ textAlign: 'right' }}>Faiz</th>
                                    <th style={{ textAlign: 'right' }}>Harcama</th>
                                    <th style={{ textAlign: 'right' }}>Ödeme</th>
                                    <th>Kaynak</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {k.donemler.map((s, j) => (
                                    <tr key={j}>
                                      <td style={{ fontWeight: 600 }}>{ayEtiket(s.donem)}</td>
                                      <td style={{ fontSize: 12 }}>{trTarih(s.kesim_tarihi)}</td>
                                      <td style={{ fontSize: 12 }}>{trTarih(s.son_odeme_tarihi)}</td>
                                      <td style={{ textAlign: 'right' }} className="mono">{fmt(s.donem_borcu)}</td>
                                      <td style={{ textAlign: 'right' }} className="mono">{fmt(s.asgari_tutar)}</td>
                                      <td style={{ textAlign: 'right' }} className="mono" >
                                        <span style={{ color: s.donem_faizi > 0 ? 'var(--red)' : 'var(--text3)' }}>{fmt(s.donem_faizi)}</span>
                                      </td>
                                      <td style={{ textAlign: 'right' }} className="mono">{s.donem_harcama ? fmt(s.donem_harcama) : '—'}</td>
                                      <td style={{ textAlign: 'right' }} className="mono">{s.donem_odeme ? fmt(s.donem_odeme) : '—'}</td>
                                      <td>
                                        <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 5, border: '1px solid var(--border)',
                                          color: s.kaynak === 'manuel' ? 'var(--orange)' : 'var(--text3)' }}>
                                          {s.kaynak === 'manuel' ? 'Manuel' : 'Ekstre'}
                                        </span>
                                      </td>
                                      <td>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); donemSil(k.kart_id, s.donem, k.kart_adi); }}
                                          title="Bu dönemin ekstre hareketlerini sil (yeniden yüklemek için)"
                                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--text3)', padding: 0, lineHeight: 1 }}
                                        >🗑️</button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
