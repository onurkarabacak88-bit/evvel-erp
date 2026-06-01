import { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { api, fmt } from '../utils/api';

const RENKLER = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#c084fc',
];

export default function KartEkstreAnaliz() {
  const [d, setD] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    api('/kartlar/analiz').then(setD).catch(() => setD(null)).finally(() => setYukleniyor(false));
  }, []);

  if (yukleniyor) return <div className="page"><div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}><span className="spinner" /> Yükleniyor…</div></div>;

  const bosVeri = !d || !d.veri_var;

  return (
    <div className="page">
      <div className="page-header">
        <h2>📂 Ekstre Analizi</h2>
        <p>İçe aktarılmış kart verisinden kategori, trend ve dağılım. <strong>Yükleme “Ekstre Yükle” sekmesinden yapılır.</strong></p>
      </div>

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
                  <Bar dataKey="Borç" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Faiz" fill="#f59e0b" radius={[4, 4, 0, 0]} />
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
    </div>
  );
}
