import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';

// Renk anahtarı (motor 'yesil/sari/turuncu/kirmizi' döndürür)
const RENK = {
  yesil:   'var(--green)',
  sari:    'var(--yellow)',
  turuncu: 'var(--orange)',
  kirmizi: 'var(--red)',
};

const ANIM = `
  @keyframes bnFade { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  .bn-card { animation: bnFade .3s cubic-bezier(.22,.61,.36,1) both; }
  .bn-kpi { transition: transform .15s ease, box-shadow .15s ease; }
  .bn-kpi:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.18); }
`;

function Gauge({ skor, renk }) {
  // 0-100 yarım daire gösterge
  const r = 70, cx = 90, cy = 90;
  const a = Math.PI * (1 - skor / 100); // 180° → 0°
  const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
  const big = skor > 50 ? 1 : 0;
  return (
    <svg viewBox="0 0 180 110" style={{ width: '100%', maxWidth: 220 }}>
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--bg3)" strokeWidth="14" strokeLinecap="round" />
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 ${big} 1 ${x} ${y}`} fill="none" stroke={RENK[renk] || 'var(--text2)'} strokeWidth="14" strokeLinecap="round" />
      <text x={cx} y={cy - 8} textAnchor="middle" style={{ fontSize: 34, fontWeight: 800, fill: RENK[renk] || 'var(--text1)' }}>{Math.round(skor)}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text3)' }}>/ 100</text>
    </svg>
  );
}

export default function BorcNavigasyon() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);

  const yukle = () => {
    setYukleniyor(true); setErr('');
    api('/borc-nav/ozet')
      .then(setD)
      .catch(e => setErr(e.message || 'Yüklenemedi'))
      .finally(() => setYukleniyor(false));
  };
  useEffect(() => { yukle(); }, []);

  if (yukleniyor && !d) return <div style={{ padding: 40, color: 'var(--text3)' }}>Borç navigasyonu hesaplanıyor…</div>;
  if (err) return <div style={{ padding: 40, color: 'var(--red)' }}>⚠️ {err}</div>;
  if (!d) return null;

  const k = d.kpi;
  const bbe = k.borc_baski_endeksi;
  const acik = k.tahmini_acik;
  const ay_sonu_negatif = acik.ay_sonu > 0;     // pozitif değer = AÇIK
  const card = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px' };

  return (
    <div style={{ padding: '16px 18px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{ANIM}</style>

      {/* Başlık */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>🧭 Borç Navigasyonu</h2>
        <button onClick={yukle} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text2)', padding: '5px 12px', cursor: 'pointer', fontSize: 13 }}>↻ Yenile</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
        {d.guncel_ay} · "Bu ay batıyor muyum?" — 30 saniyelik durum. ABEK = işletmenin borca ayırabildiği aylık serbest nakit.
      </div>

      {/* Sürdürülemezlik alarmı */}
      {d.surdurulemez && (
        <div className="bn-card" style={{ ...card, borderColor: 'var(--red)', background: 'rgba(239,68,68,0.10)', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ fontSize: 22 }}>🔴</span>
          <div>
            <div style={{ fontWeight: 800, color: 'var(--red)', fontSize: 15 }}>Sürdürülemez — borç çevriliyor ama kapanmıyor</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 3 }}>
              Aylık serbest nakit (ABEK <b>{fmt(d.abek.deger)}</b>) zorunlu yükten (<b>{fmt(d.borc.zorunlu_yuk)}</b>) düşük. Finansal sarmal — yapısal müdahale gerekir (gelir artışı + borç yapılandırma).
            </div>
          </div>
        </div>
      )}

      {/* ── 5 KPI ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12, marginBottom: 16 }}>
        {/* 1. Borç Baskı Endeksi */}
        <div className="bn-card bn-kpi" style={{ ...card, gridColumn: 'span 1', textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, marginBottom: 4 }}>BORÇ BASKI ENDEKSİ</div>
          <Gauge skor={bbe.skor} renk={bbe.renk} />
          <div style={{ fontSize: 15, fontWeight: 800, color: RENK[bbe.renk] }}>{bbe.durum}</div>
        </div>

        {/* 2. Tahmini Açık */}
        <div className="bn-card bn-kpi" style={{ ...card, borderLeft: `4px solid ${ay_sonu_negatif ? 'var(--red)' : 'var(--green)'}` }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>TAHMİNİ {ay_sonu_negatif ? 'AÇIK' : 'FAZLA'} (AY SONU)</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-mono)', color: ay_sonu_negatif ? 'var(--red)' : 'var(--green)' }}>
            {ay_sonu_negatif ? '−' : '+'}{fmt(Math.abs(acik.ay_sonu))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
            Bugün: <b style={{ color: 'var(--text2)' }}>{fmt(acik.bugun)}</b> açık<br />
            Her ay biriken: <b style={{ color: 'var(--text2)' }}>{fmt(acik.aylik_yapisal)}</b>
          </div>
        </div>

        {/* 3. Runway */}
        <div className="bn-card bn-kpi" style={{ ...card, borderLeft: `4px solid ${RENK[k.runway_renk]}` }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>RUNWAY (KAÇ AY DAYANIR)</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-mono)', color: RENK[k.runway_renk] }}>
            {k.runway_ay === null ? '∞' : `${k.runway_ay} ay`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{k.runway_durum}</div>
        </div>

        {/* 4. Zorunlu Yük */}
        <div className="bn-card bn-kpi" style={{ ...card }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>GELECEK AY ZORUNLU YÜK</div>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--text1)' }}>{fmt(k.zorunlu_yuk)}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
            Kart asgari {fmt(d.borc.kart_asgari)} + 🏦 kredi {fmt(d.borc.kredi_taksiti)}
          </div>
        </div>

        {/* 5. Hedef Ciro */}
        <div className="bn-card bn-kpi" style={{ ...card, borderLeft: '4px solid var(--accent)' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>HEDEF CİRO (BORÇ BÜYÜMESİN)</div>
          {k.hedef_ciro_borc_sabit != null ? (
            <>
              <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{fmt(k.hedef_ciro_borc_sabit)}<span style={{ fontSize: 12, color: 'var(--text3)' }}>/ay</span></div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>Şu an ~{fmt(d.abek.ciro_ay)} → bu seviyeye çıkmalı</div>
            </>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 6 }}>Nakit marj ≤ 0 → ciro tek başına yetmez, önce maliyet/gelir yapısı.</div>
          )}
        </div>
      </div>

      {/* ── ABEK + Borç tablosu ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12, marginBottom: 16 }}>
        {/* ABEK */}
        <div className="bn-card" style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>💧 ABEK — Aylık Borç Emme Kapasitesi</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)', color: d.abek.deger >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(d.abek.deger)}<span style={{ fontSize: 13, color: 'var(--text3)' }}>/ay</span></div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.7 }}>
            Aylık operasyonel ciro: <b style={{ color: 'var(--text2)' }}>{fmt(d.abek.ciro_ay)}</b><br />
            Nakit marj: <b style={{ color: 'var(--text2)' }}>%{d.abek.nakit_marj_pct}</b><br />
            <span style={{ color: 'var(--text3)' }}>(ağırlık: %70 son ay {fmt(d.abek.son_ay)} + %30 son 3 ay ort {fmt(d.abek.son3_ort)})</span>
          </div>
        </div>

        {/* Borç tablosu */}
        <div className="bn-card" style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>🏦 Toplam Borç</div>
          <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--red)' }}>{fmt(d.borc.toplam)}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, lineHeight: 1.7 }}>
            💳 Kart toplam: <b style={{ color: 'var(--text2)' }}>{fmt(d.borc.kart_toplam)}</b><br />
            🏦 Kredi kalan anapara: <b style={{ color: 'var(--text2)' }}>{fmt(d.borc.kredi_kalan)}</b>
          </div>
        </div>
      </div>

      {/* ── Hedef ciro 3 senaryo ── */}
      <div className="bn-card" style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>🎯 Hedef Ciro — 3 Senaryo</div>
        {d.hedef_ciro.marj_pozitif ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ color: 'var(--text3)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Hedef</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Gerekli Aylık Ciro</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Gerekli Günlük Ciro</th>
              </tr></thead>
              <tbody>
                {[
                  ['Borç BÜYÜMESİN (sabit kalsın)', d.hedef_ciro.borc_sabit, 'var(--text1)'],
                  ['Borç yılda %25 AZALSIN', d.hedef_ciro.yil_25_azal, 'var(--orange)'],
                  ['Borç 24 ayda BİTSİN', d.hedef_ciro.ay24_bitir, 'var(--red)'],
                ].map(([ad, val, c]) => (
                  <tr key={ad} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{ad}</td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: c }}>{fmt(val)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>{fmt(val / 30)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>Şu anki aylık ciro ~{fmt(d.abek.ciro_ay)} · nakit marj %{d.abek.nakit_marj_pct} üzerinden hesaplandı.</div>
          </div>
        ) : (
          <div style={{ color: 'var(--red)', fontSize: 13 }}>⚠️ Nakit marj ≤ 0 olduğu için ciro hedefi anlamsız — daha çok satmak daha çok zarar demek. Önce maliyet/fiyat yapısı düzeltilmeli.</div>
        )}
      </div>

      {/* ── BBE bileşenleri ── */}
      <div className="bn-card" style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>📊 Borç Baskı Endeksi — Bileşenler</div>
        {d.bbe_bilesenler.map((b, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
              <span style={{ color: 'var(--text2)' }}>{b.ad} <span style={{ color: 'var(--text3)' }}>(×{b.agirlik})</span></span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{b.skor}</span>
            </div>
            <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${b.skor}%`, height: '100%', background: b.skor > 60 ? 'var(--red)' : b.skor > 40 ? 'var(--orange)' : b.skor > 20 ? 'var(--yellow)' : 'var(--green)' }} />
            </div>
          </div>
        ))}
      </div>

      {/* Notlar */}
      {d.notlar && d.notlar.length > 0 && (
        <div className="bn-card" style={{ ...card, background: 'var(--bg3)' }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6, color: 'var(--text2)' }}>📌 Notlar</div>
          {d.notlar.map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>• {n}</div>)}
        </div>
      )}
    </div>
  );
}
