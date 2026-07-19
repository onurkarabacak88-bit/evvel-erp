import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';

// ── Helpers ──────────────────────────────────────────────────────────────────
function toTR(s) {
  if (!s) return '';
  const [y, m, g] = s.split('-');
  return `${g}.${m}.${y}`;
}

function fmtTL(n) {
  return Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

// ── Constants ─────────────────────────────────────────────────────────────────
const GRUP_RENK = {
  'Ice': '#3b82f6', '14 Oz': 'var(--orange)', '8 Oz': '#10b981',
  'Su': '#6366f1', 'Maden Suyu': '#14b8a6',
  'Redbull': '#8b5cf6', 'Pasta': '#ec4899', 'ÇAY': 'var(--red)',
};

const MALZEME_RENK = {
  'Plastik Bardak': '#3b82f6', '14oz Karton Bardak': 'var(--orange)',
  '8oz Karton Bardak': '#10b981', 'Su Şişesi': '#6366f1',
  'Çay Bardağı': 'var(--red)', 'Pasta Tabağı': '#ec4899',
  'Kutu (Redbull)': '#8b5cf6', 'Maden Suyu Şişesi': '#14b8a6',
};

const URUN_MALZEME = {
  'ICE': 'Plastik Bardak', 'FROZEN': 'Plastik Bardak', 'BUZLU': 'Plastik Bardak',
  '14 OZ': '14oz Karton Bardak', '8 OZ': '8oz Karton Bardak',
  'SU': 'Su Şişesi', 'REDBULL': 'Kutu', 'ÇAY': 'Çay Bardağı',
  'PASTA': 'Pasta Tabağı', 'MADEN': 'Maden Suyu Şişesi',
};

const ANIM_CSS = `
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes barFill { from { width: 0; } }
  @keyframes skeletonPulse {
    0%, 100% { opacity: 0.3; }
    50%       { opacity: 0.65; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes tabFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

// ── Skeleton components ───────────────────────────────────────────────────────
function Sk({ w = '100%', h = 16, r = 5, style = {} }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: r,
      background: 'var(--bg3)',
      animation: 'skeletonPulse 1.5s ease-in-out infinite',
      flexShrink: 0,
      ...style,
    }} />
  );
}

function SkCard() {
  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <Sk w="50%" h={10} />
      <Sk w="70%" h={24} />
      <Sk w="40%" h={10} />
    </div>
  );
}

// ── Metric card ───────────────────────────────────────────────────────────────
function MetrikKart({ label, value, sub, renk, delay = 0 }) {
  return (
    <div className="card" style={{ padding: 14, animation: 'fadeSlideUp 0.28s ease both', animationDelay: `${delay}ms` }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 800, color: renk || 'var(--text)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function EvoSatis() {
  const bugun = new Date().toISOString().slice(0, 10);
  const [tarih1, setTarih1] = useState(bugun);
  const [tarih2, setTarih2] = useState(bugun);

  // Ürün satışları
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);

  // Şube analiz
  const [subeAnaliz, setSubeAnaliz] = useState(null);
  const [subeYukleniyor, setSubeYukleniyor] = useState(false);
  const [subeHata, setSubeHata] = useState(null);
  const [secilenSube, setSecilenSube] = useState(null);
  const [subeUrunler, setSubeUrunler] = useState(null);

  // UI state
  const [tokenDurumu, setTokenDurumu] = useState('bilinmiyor');
  const [tokenGuncelModal, setTokenGuncelModal] = useState(false);
  const [popupBekle, setPopupBekle] = useState(false);
  const [sonGuncelleme, setSonGuncelleme] = useState(null);
  const [aktifSekme, setAktifSekme] = useState('urun'); // 'urun' | 'sube'
  const [tabAnimKey, setTabAnimKey] = useState(0);
  const [perSyncYukleniyor, setPerSyncYukleniyor] = useState(false);
  const [perSyncSonuc, setPerSyncSonuc] = useState(null);
  const [isimDuzenle, setIsimDuzenle] = useState(null); // {personel_id, gecici_ad}
  const [isimKayitYukleniyor, setIsimKayitYukleniyor] = useState(false);

  const popupRef = useRef(null);
  const pollRef = useRef(null);

  const RAILWAY_URL = window.location.origin;
  const bookmarkletKod = `javascript:(function(){var t=localStorage.getItem('evo_token');if(!t){alert('Token bulunamadı. Önce evobulut.com\\'a giriş yapın.');return;}fetch('${RAILWAY_URL}/api/evo/set-web-token?token='+encodeURIComponent(t)).then(function(r){return r.json();}).then(function(d){if(window.opener||window.name==='evobulut_token'){window.close();}else{alert('✅ Token güncellendi! Evvel ERP\\'ye dönün.');}}).catch(function(e){alert('Hata: '+e.message);});})();`;

  // ─── Data loading ─────────────────────────────────────────────────────────
  async function veriYukle() {
    setYukleniyor(true);
    setHata(null);
    try {
      const r = await api(`/evo/hs-rapor?tarih1=${toTR(tarih1)}&tarih2=${toTR(tarih2)}`);
      setVeri(r);
      setTokenDurumu('ok');
      setSonGuncelleme(r.son_cekim_ts ? new Date(r.son_cekim_ts) : new Date());
    } catch (e) {
      const mesaj = e.message || String(e);
      if (mesaj.includes('503') || mesaj.toLowerCase().includes('token') || mesaj.toLowerCase().includes('web_token')) {
        setTokenDurumu('yok');
        setHata('token_yok');
      } else {
        setTokenDurumu('bilinmiyor');
        setHata(mesaj);
      }
    } finally {
      setYukleniyor(false);
    }
  }

  function _subeUrunlerFromAnaliz(analiz, subeAdi) {
    const s = analiz?.subeler?.[subeAdi];
    if (!s) return;
    setSubeUrunler({
      sube_adi: subeAdi,
      evo_sube_id: s.evo_sube_id,
      toplam_fis: s.fatura_sayisi,
      ciro: s.ciro_toplam,
      nakit: s.nakit,
      kart: s.kart,
      iskonto: s.iskonto_toplam,
      gruplar: s.gruplar,
      urunler: (s.cok_satilan || []).map(u => ({
        urun: u.ad, adet: u.adet, ciro: u.ciro, grup: u.grup, stok_kodu: u.stok_kodu,
      })),
      personel: s.personel_satislar || [],
    });
  }

  async function subeAnalızYukle() {
    setSubeYukleniyor(true);
    setSubeHata(null);
    try {
      const r = await api(`/evo/sube-grup-detay?bastar=${tarih1}&bittar=${tarih2}`);
      setSubeAnaliz(r);
      setTokenDurumu('ok');
      if (r.son_cekim_ts) setSonGuncelleme(new Date(r.son_cekim_ts));
      if (r.subeler) {
        const hedef = secilenSube && r.subeler[secilenSube]
          ? secilenSube
          : Object.keys(r.subeler)[0];
        if (hedef) {
          setSecilenSube(hedef);
          _subeUrunlerFromAnaliz(r, hedef);
        }
      }
    } catch (e) {
      const mesaj = e.message || String(e);
      if (mesaj.includes('503') || mesaj.toLowerCase().includes('token')) {
        setTokenDurumu('yok');
        setSubeHata('token_yok');
      } else {
        setSubeHata(mesaj);
      }
    } finally {
      setSubeYukleniyor(false);
    }
  }

  function subeSecOlayı(ad) {
    setSecilenSube(ad);
    _subeUrunlerFromAnaliz(subeAnaliz, ad);
  }

  async function perSyncCalistir() {
    setPerSyncYukleniyor(true);
    setPerSyncSonuc(null);
    try {
      const r = await api('/evo/personel-sync?gunler=14', { method: 'POST' });
      setPerSyncSonuc({ ok: true, mesaj: `✅ ${r.cache_boyutu} personel kaydı güncellendi` });
      subeAnalızYukle();
    } catch (e) {
      setPerSyncSonuc({ ok: false, mesaj: `Hata: ${e.message || e}` });
    } finally {
      setPerSyncYukleniyor(false);
    }
  }

  async function isimKaydet(personelId, yeniAd) {
    if (!yeniAd?.trim()) return;
    setIsimKayitYukleniyor(true);
    try {
      await api('/evo/personel-isim-gir', {
        method: 'POST',
        body: JSON.stringify({ personel_id: personelId, ad: yeniAd.trim() }),
      });
      setIsimDuzenle(null);
      subeAnalızYukle();
    } catch (e) {
      alert(`Kayıt hatası: ${e.message || e}`);
    } finally {
      setIsimKayitYukleniyor(false);
    }
  }

  function handleTabSwitch(key) {
    setAktifSekme(key);
    setTabAnimKey(k => k + 1);
  }

  // ─── Effects ──────────────────────────────────────────────────────────────
  useEffect(() => { veriYukle(); }, [tarih1, tarih2]);
  useEffect(() => { if (aktifSekme === 'sube') subeAnalızYukle(); }, [tarih1, tarih2, aktifSekme]);

  useEffect(() => {
    if (!popupBekle) return;
    let sayac = 0;
    pollRef.current = setInterval(() => {
      sayac++;
      if (popupRef.current?.closed) {
        clearInterval(pollRef.current);
        setPopupBekle(false);
        setTokenGuncelModal(false);
        setTimeout(() => veriYukle(), 800);
      }
      if (sayac > 60) { clearInterval(pollRef.current); setPopupBekle(false); }
    }, 1000);
    return () => clearInterval(pollRef.current);
  }, [popupBekle]);

  function evoAc() {
    const popup = window.open(
      'https://web.evobulut.com/hizli/hs_rapor.html',
      'evobulut_token',
      'width=900,height=650,left=100,top=80,resizable=yes,scrollbars=yes'
    );
    if (!popup) { setHata('Popup engelleyici aktif. Lütfen popup izni verin.'); return; }
    popupRef.current = popup;
    setPopupBekle(true);
  }

  // ─── Derived ─────────────────────────────────────────────────────────────
  const urunler = veri?.urunler ? Object.entries(veri.urunler) : [];
  const toplamAdet = urunler.reduce((s, [, a]) => s + Number(a || 0), 0);
  const yukleme = yukleniyor || subeYukleniyor;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <style>{ANIM_CSS}</style>

      {/* ══ HEADER ══ */}
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700 }}>☕ Ürün Satışları</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--muted)' }}>
            Evobulut · hs_rapor
            {sonGuncelleme && (
              <span>
                {' · son veri çekimi: '}
                {sonGuncelleme.toLocaleDateString('tr-TR')}
                {' '}
                {sonGuncelleme.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Status dot */}
          <span style={{
            display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
            color: tokenDurumu === 'ok' ? 'var(--green)' : tokenDurumu === 'yok' ? 'var(--red)' : 'var(--muted)',
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: tokenDurumu === 'ok' ? 'var(--green)' : tokenDurumu === 'yok' ? 'var(--red)' : 'var(--muted)',
            }} />
            {tokenDurumu === 'ok'
              ? (veri?.kaynak === 'rest_api_fallback' ? 'REST fallback' : 'Bağlı')
              : tokenDurumu === 'yok' ? 'Token yok' : ''}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => setTokenGuncelModal(true)}>🔄 Token</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={aktifSekme === 'sube' ? subeAnalızYukle : veriYukle}
            disabled={yukleme}
          >
            <span style={yukleme ? { animation: 'spin 0.7s linear infinite', display: 'inline-block' } : {}}>↺</span>
            {' '}Yenile
          </button>
        </div>
      </div>

      {/* ══ STALE DATA UYARISI ══ */}
      {((aktifSekme === 'urun' && veri?.canli === false) || (aktifSekme === 'sube' && subeAnaliz?.canli === false)) && (
        <div className="alert-box" style={{
          marginBottom: 14, fontSize: 12, padding: '8px 14px',
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderLeft: '3px solid var(--amber, #f59e0b)', borderRadius: 6,
          color: 'var(--muted)',
        }}>
          ⚠️ Şu anda Evo'dan canlı veri alınamadı — aşağıdaki veriler{' '}
          <strong style={{ color: 'var(--text)' }}>
            {sonGuncelleme
              ? `${sonGuncelleme.toLocaleDateString('tr-TR')} ${sonGuncelleme.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
              : 'önceki'}
          </strong>{' '}tarihli son başarılı çekime ait.
        </div>
      )}

      {/* ══ DATE PICKER ══ */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap',
        background: 'var(--bg2)', borderRadius: 8, padding: '8px 12px', border: '1px solid var(--border)',
      }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Başlangıç</label>
        <input type="date" className="input" value={tarih1} onChange={e => setTarih1(e.target.value)}
          style={{ width: 140, fontSize: 12 }} />
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>Bitiş</label>
        <input type="date" className="input" value={tarih2} onChange={e => setTarih2(e.target.value)}
          style={{ width: 140, fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
          {[
            { label: 'Bugün', fn: () => { setTarih1(bugun); setTarih2(bugun); } },
            { label: 'Dün', fn: () => { const d = new Date(); d.setDate(d.getDate() - 1); const s = d.toISOString().slice(0, 10); setTarih1(s); setTarih2(s); } },
            { label: 'Bu Hafta', fn: () => { const d = new Date(); const gun = d.getDay() || 7; d.setDate(d.getDate() - gun + 1); setTarih1(d.toISOString().slice(0, 10)); setTarih2(bugun); } },
          ].map(({ label, fn }) => (
            <button key={label} className="btn btn-secondary btn-sm" onClick={fn} style={{ fontSize: 11, padding: '3px 8px' }}>{label}</button>
          ))}
        </div>
      </div>

      {/* ══ TABS ══ */}
      <div style={{ display: 'flex', marginBottom: 22, borderBottom: '2px solid var(--border)' }}>
        {[
          { key: 'urun', label: '📊 Ürün Satışları' },
          { key: 'sube', label: '🏪 Şube Analiz' },
        ].map(s => (
          <button key={s.key} onClick={() => handleTabSwitch(s.key)} style={{
            padding: '9px 22px', fontSize: 13,
            fontWeight: aktifSekme === s.key ? 700 : 500,
            border: 'none',
            borderBottom: aktifSekme === s.key ? '2px solid var(--accent)' : '2px solid transparent',
            background: 'none', cursor: 'pointer',
            color: aktifSekme === s.key ? 'var(--accent)' : 'var(--muted)',
            marginBottom: -2,
            transition: 'color .15s, border-color .15s',
          }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ══ TAB CONTENT (re-animates on switch) ══ */}
      <div key={tabAnimKey} style={{ animation: 'tabFadeIn 0.2s ease both' }}>

        {/* ─── ÜRÜN SATIŞLARI ─── */}
        {aktifSekme === 'urun' && (
          <div>
            {hata === 'token_yok' && (
              <div className="alert-box red" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>⚠️ Evobulut bağlantısı yok — token gerekiyor.</span>
                <button className="btn btn-primary btn-sm" onClick={() => setTokenGuncelModal(true)}>Bağlan →</button>
              </div>
            )}
            {hata && hata !== 'token_yok' && (
              <div className="alert-box red" style={{ marginBottom: 14 }}>{hata}</div>
            )}

            {/* Skeleton */}
            {yukleniyor && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                  <Sk w={130} h={14} /><Sk w={70} h={14} style={{ marginLeft: 'auto' }} />
                </div>
                {[...Array(9)].map((_, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '11px 20px',
                    borderBottom: '1px solid var(--border)',
                    animation: 'skeletonPulse 1.5s ease-in-out infinite',
                    animationDelay: `${i * 80}ms`,
                  }}>
                    <Sk w={22} h={13} r={3} />
                    <Sk w="44%" h={13} r={3} />
                    <Sk w={44} h={13} r={3} style={{ marginLeft: 'auto' }} />
                    <Sk w={36} h={13} r={3} />
                    <Sk w={100} h={6} r={3} />
                  </div>
                ))}
              </div>
            )}

            {/* Table */}
            {!yukleniyor && veri && urunler.length > 0 && (
              <div className="card" style={{ padding: 0 }}>
                <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>
                    {veri.urun_sayisi} ürün
                    <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)', marginLeft: 8 }}>
                      {toTR(tarih1)}{tarih1 !== tarih2 ? ` – ${toTR(tarih2)}` : ''}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                    {Math.round(toplamAdet)} adet
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      {['#', 'ÜRÜN', 'ADET', 'ORAN', ''].map((h, i) => (
                        <th key={i} style={{
                          padding: '8px 16px', fontSize: 10, fontWeight: 700,
                          textAlign: i >= 2 ? 'right' : 'left',
                          color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px',
                          width: i === 4 ? 130 : i === 0 ? 40 : 'auto',
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {urunler.map(([ad, adet], i) => {
                      const pct = toplamAdet > 0 ? (Number(adet) / toplamAdet) * 100 : 0;
                      const renk = i === 0 ? '#f5a623' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : 'var(--accent)';
                      const delay = `${Math.min(i * 28, 420)}ms`;
                      return (
                        <tr key={ad}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            animation: 'fadeSlideUp 0.2s ease both',
                            animationDelay: delay,
                            transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <td style={{ padding: '10px 16px', color: 'var(--muted)', fontSize: 12 }}>
                            {i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}
                          </td>
                          <td style={{ padding: '10px 16px', fontWeight: i < 3 ? 700 : 400 }}>{ad}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                            {Math.round(Number(adet))}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', color: 'var(--muted)', fontSize: 12 }}>
                            %{pct.toFixed(1)}
                          </td>
                          <td style={{ padding: '10px 16px', width: 130 }}>
                            <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{
                                height: '100%', width: `${pct}%`, background: renk, borderRadius: 3,
                                animation: 'barFill 0.55s ease both',
                                animationDelay: `${Math.min(i * 28, 420) + 80}ms`,
                              }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!yukleniyor && veri && urunler.length === 0 && (
              <div style={{ textAlign: 'center', padding: 64, color: 'var(--muted)', animation: 'fadeSlideUp 0.3s ease' }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
                Bu tarih aralığında satış verisi yok.
              </div>
            )}
          </div>
        )}

        {/* ─── ŞUBE ANALİZ ─── */}
        {aktifSekme === 'sube' && (
          <div>
            {subeHata === 'token_yok' && (
              <div className="alert-box red" style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>⚠️ Evobulut bağlantısı yok — token gerekiyor.</span>
                <button className="btn btn-primary btn-sm" onClick={() => setTokenGuncelModal(true)}>Bağlan →</button>
              </div>
            )}
            {subeHata && subeHata !== 'token_yok' && (
              <div className="alert-box red" style={{ marginBottom: 14 }}>{subeHata}</div>
            )}

            {/* Skeleton */}
            {subeYukleniyor && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
                  {[...Array(5)].map((_, i) => <SkCard key={i} />)}
                </div>
                <div className="card" style={{ padding: 14, marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[...Array(7)].map((_, i) => <Sk key={i} w={90} h={56} r={8} />)}
                </div>
              </div>
            )}

            {!subeYukleniyor && subeAnaliz && (() => {
              const subeler = Object.values(subeAnaliz.subeler || {});
              const subeAdlari = Object.keys(subeAnaliz.subeler || {}).sort();
              if (subeler.length === 0) return null;

              const top = subeler.reduce((a, s) => ({
                ciro:    a.ciro    + (Number(s.ciro_toplam || s.ciro) || 0),
                nakit:   a.nakit   + (Number(s.nakit) || 0),
                kart:    a.kart    + (Number(s.kart) || 0),
                fis:     a.fis     + (Number(s.fatura_sayisi || s.fis_sayisi) || 0),
                iskonto: a.iskonto + (Number(s.iskonto_toplam) || 0),
              }), { ciro: 0, nakit: 0, kart: 0, fis: 0, iskonto: 0 });

              const grupTop = {};
              subeler.forEach(s => {
                Object.entries(s.gruplar || {}).forEach(([g, v]) => {
                  if (!grupTop[g]) grupTop[g] = { adet: 0, ciro: 0 };
                  grupTop[g].adet += Number(v.adet || 0);
                  grupTop[g].ciro += Number(v.ciro || 0);
                });
              });

              return (
                <>
                  {/* Summary metrics */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 14 }}>
                    <MetrikKart label="Toplam Ciro" value={fmtTL(top.ciro)} sub={`${top.fis} fiş · ${subeler.length} şube`} renk="var(--green)" delay={0} />
                    <MetrikKart label="💵 Nakit" value={fmtTL(top.nakit)} sub={`${top.ciro > 0 ? Math.round(top.nakit / top.ciro * 100) : 0}% nakit`} renk="#86efac" delay={55} />
                    <MetrikKart label="💳 Kart" value={fmtTL(top.kart)} sub={`${top.ciro > 0 ? Math.round(top.kart / top.ciro * 100) : 0}% kart`} renk="#93c5fd" delay={110} />
                    <MetrikKart label="İskonto" value={fmtTL(top.iskonto)} sub={`${top.ciro > 0 ? ((top.iskonto / top.ciro) * 100).toFixed(2) : 0}%`} renk={top.iskonto > 0 ? '#fbbf24' : undefined} delay={165} />
                    <MetrikKart label="Ort. Fiş" value={fmtTL(top.fis > 0 ? top.ciro / top.fis : 0)} delay={220} />
                  </div>

                  {/* Group totals */}
                  {Object.keys(grupTop).length > 0 && (
                    <div className="card" style={{ padding: '10px 14px', marginBottom: 14, animation: 'fadeSlideUp 0.3s ease both', animationDelay: '160ms' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        🥤 Grup Toplamları — tüm şubeler
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(grupTop).sort((a, b) => b[1].adet - a[1].adet).map(([g, v], i) => {
                          const r = GRUP_RENK[g] || '#94a3b8';
                          return (
                            <div key={g} style={{
                              padding: '8px 14px', borderRadius: 8, minWidth: 88,
                              background: r + '1a', border: `1px solid ${r}44`,
                              animation: 'fadeSlideUp 0.2s ease both',
                              animationDelay: `${i * 40}ms`,
                            }}>
                              <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px' }}>{g}</div>
                              <div style={{ fontSize: 19, fontWeight: 800, color: r, lineHeight: 1.2 }}>{Math.round(v.adet)}</div>
                              <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtTL(v.ciro)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Branch selector — pill buttons */}
                  <div style={{ marginBottom: 14, animation: 'fadeSlideUp 0.3s ease both', animationDelay: '190ms' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
                      Şube Seç
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {Object.entries(subeAnaliz.subeler || {})
                        .sort((a, b) => (Number(b[1].ciro_toplam || b[1].ciro) || 0) - (Number(a[1].ciro_toplam || a[1].ciro) || 0))
                        .map(([ad, bilgi]) => {
                          const ciro = Number(bilgi.ciro_toplam || bilgi.ciro) || 0;
                          const fis = Number(bilgi.fatura_sayisi || bilgi.fis_sayisi) || 0;
                          const isAktif = secilenSube === ad;
                          return (
                            <button key={ad} onClick={() => subeSecOlayı(ad)} style={{
                              padding: '8px 16px', borderRadius: 8, textAlign: 'left',
                              border: isAktif ? '2px solid var(--accent)' : '2px solid var(--border)',
                              background: isAktif ? 'rgba(99,102,241,0.1)' : 'var(--bg2)',
                              cursor: 'pointer',
                              transition: 'border-color .14s, background .14s',
                            }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: isAktif ? 'var(--accent)' : 'var(--text)', marginBottom: 2 }}>
                                🏪 {ad}
                              </div>
                              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                                {fmtTL(ciro)}
                              </div>
                              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>{fis} fiş</div>
                            </button>
                          );
                        })}
                    </div>
                  </div>

                  {/* Selected branch detail */}
                  {secilenSube && subeUrunler && (
                    <div className="card" style={{ padding: 0, marginBottom: 16, animation: 'fadeSlideUp 0.22s ease both' }}>
                      <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontSize: 14 }}>🏪 {secilenSube} — Ürün Detayı</span>
                        {!subeUrunler.hata && (
                          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
                            {subeUrunler.toplam_fis} fiş · {fmtTL(subeUrunler.ciro)}
                            {subeUrunler.evo_sube_id && <span style={{ color: 'var(--muted)' }}> · Evo {subeUrunler.evo_sube_id}</span>}
                          </span>
                        )}
                      </div>

                      {/* Grup dağılımı */}
                      {subeUrunler.gruplar && Object.keys(subeUrunler.gruplar).length > 0 && (
                        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.015)' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Grup Dağılımı &nbsp;·&nbsp; Nakit {fmtTL(subeUrunler.nakit)} · Kart {fmtTL(subeUrunler.kart)} · İskonto {fmtTL(subeUrunler.iskonto)}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {Object.entries(subeUrunler.gruplar).map(([g, v], i) => {
                              const r = GRUP_RENK[g] || '#94a3b8';
                              return (
                                <div key={g} style={{
                                  padding: '7px 12px', borderRadius: 8, minWidth: 88,
                                  background: r + '1a', border: `1px solid ${r}44`,
                                  animation: 'fadeSlideUp 0.18s ease both',
                                  animationDelay: `${i * 35}ms`,
                                }}>
                                  <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 700 }}>{g}</div>
                                  <div style={{ fontSize: 17, fontWeight: 800, color: r }}>{Math.round(v.adet)}</div>
                                  <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtTL(v.ciro)}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Personel */}
                      {subeUrunler.personel?.length > 0 && (
                        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span>👤 Personel Satışları</span>
                            <button
                              onClick={perSyncCalistir}
                              disabled={perSyncYukleniyor}
                              title="Evo'dan personel isimlerini güncelle (son 14 gün)"
                              style={{
                                padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                                background: 'var(--bg3)', border: '1px solid var(--border)',
                                color: 'var(--text2)', cursor: perSyncYukleniyor ? 'wait' : 'pointer',
                                opacity: perSyncYukleniyor ? 0.6 : 1,
                              }}
                            >
                              {perSyncYukleniyor ? '⏳' : '🔄'} İsimleri Güncelle
                            </button>
                            {perSyncSonuc && (
                              <span style={{ fontSize: 10, color: perSyncSonuc.ok ? 'var(--green)' : 'var(--red)', fontWeight: 400 }}>
                                {perSyncSonuc.mesaj}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {subeUrunler.personel.map((p, i) => {
                              const sayisalMi = /^\d+$/.test(p.ad);
                              const duzenlemede = isimDuzenle?.personel_id === p.personel_id;
                              return (
                                <div key={p.personel_id} style={{
                                  padding: '6px 10px', borderRadius: 6, fontSize: 12,
                                  background: sayisalMi ? 'var(--bg3)' : 'var(--bg2)',
                                  border: sayisalMi ? '1px dashed var(--border)' : '1px solid var(--border)',
                                  animation: 'fadeSlideUp 0.18s ease both',
                                  animationDelay: `${i * 28}ms`,
                                }}>
                                  {duzenlemede ? (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <input
                                        autoFocus
                                        defaultValue=""
                                        placeholder="Personel adı..."
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') isimKaydet(p.personel_id, e.target.value);
                                          if (e.key === 'Escape') setIsimDuzenle(null);
                                        }}
                                        style={{
                                          fontSize: 12, padding: '2px 6px', borderRadius: 4,
                                          border: '1px solid var(--accent)', background: 'var(--bg1)',
                                          color: 'var(--text1)', width: 110,
                                        }}
                                      />
                                      <button
                                        onClick={e => {
                                          const inp = e.currentTarget.parentElement.querySelector('input');
                                          isimKaydet(p.personel_id, inp?.value);
                                        }}
                                        disabled={isimKayitYukleniyor}
                                        style={{
                                          padding: '2px 6px', borderRadius: 4, fontSize: 10,
                                          background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
                                        }}
                                      >✓</button>
                                      <button
                                        onClick={() => setIsimDuzenle(null)}
                                        style={{
                                          padding: '2px 4px', borderRadius: 4, fontSize: 10,
                                          background: 'var(--bg3)', color: 'var(--text2)', border: 'none', cursor: 'pointer',
                                        }}
                                      >✕</button>
                                    </span>
                                  ) : (
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                      <strong style={{ color: sayisalMi ? 'var(--text3)' : 'var(--text1)' }}>
                                        {sayisalMi ? `#${p.ad}` : p.ad}
                                      </strong>
                                      {sayisalMi && (
                                        <span
                                          onClick={() => setIsimDuzenle({ personel_id: p.personel_id })}
                                          title="İsim gir"
                                          style={{ cursor: 'pointer', fontSize: 10, opacity: 0.6 }}
                                        >✏️</span>
                                      )}
                                      <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                                        {p.fis_sayisi} fiş · {fmtTL(p.ciro)}
                                      </span>
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {subeUrunler.hata && (
                        <div style={{ padding: 16, color: 'var(--red)' }}>{subeUrunler.hata}</div>
                      )}

                      {/* Ürün listesi + malzeme */}
                      {subeUrunler.urunler?.length > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                          <div style={{ borderRight: '1px solid var(--border)' }}>
                            <div style={{ padding: '7px 14px', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                              Ürün Satışları
                            </div>
                            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <tbody>
                                  {subeUrunler.urunler.map((u, i) => (
                                    <tr key={i}
                                      style={{
                                        borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                                        animation: 'fadeSlideUp 0.17s ease both',
                                        animationDelay: `${Math.min(i * 22, 280)}ms`,
                                        transition: 'background 0.1s',
                                      }}
                                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                                      <td style={{ padding: '7px 14px', color: 'var(--muted)', width: 26, fontSize: 11 }}>
                                        {i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}
                                      </td>
                                      <td style={{ padding: '7px 14px', fontWeight: i < 3 ? 600 : 400 }}>{u.urun}</td>
                                      <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                        {Math.round(u.adet)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                          <div>
                            <div style={{ padding: '7px 14px', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                              Tahmini Malzeme
                            </div>
                            {(() => {
                              const malzeme = {};
                              for (const u of subeUrunler.urunler) {
                                const adUpper = u.urun.toUpperCase();
                                for (const [kw, m] of Object.entries(URUN_MALZEME)) {
                                  if (adUpper.includes(kw)) { malzeme[m] = (malzeme[m] || 0) + u.adet; break; }
                                }
                              }
                              return (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                  <tbody>
                                    {Object.entries(malzeme).sort((a, b) => b[1] - a[1]).map(([mal, adet], i) => (
                                      <tr key={i} style={{
                                        borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                                        animation: 'fadeSlideUp 0.17s ease both',
                                        animationDelay: `${Math.min(i * 32, 250)}ms`,
                                      }}>
                                        <td style={{ padding: '8px 14px' }}>
                                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: MALZEME_RENK[mal] || '#94a3b8', marginRight: 7 }} />
                                          {mal}
                                        </td>
                                        <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                          {Math.round(adet)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              );
                            })()}
                          </div>
                        </div>
                      )}

                      {subeUrunler.urunler?.length === 0 && (
                        <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                          Bu şubede ürün detayı bulunamadı.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Cross-branch × product matrix */}
                  {(() => {
                    if (subeAdlari.length === 0) return null;
                    const sb = subeAnaliz.subeler || {};
                    const urunMap = {};
                    subeAdlari.forEach(sad => {
                      (sb[sad]?.cok_satilan || []).forEach(u => {
                        const k = u.stok_kodu || u.ad;
                        if (!urunMap[k]) urunMap[k] = { stok_kodu: u.stok_kodu, ad: u.ad, grup: u.grup, toplam: 0, toplam_ciro: 0, subeler: {} };
                        urunMap[k].toplam += Number(u.adet || 0);
                        urunMap[k].toplam_ciro += Number(u.ciro || 0);
                        urunMap[k].subeler[sad] = (urunMap[k].subeler[sad] || 0) + Number(u.adet || 0);
                      });
                    });
                    const urunList = Object.values(urunMap).sort((a, b) => b.toplam - a.toplam);
                    if (urunList.length === 0) return null;

                    return (
                      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16, animation: 'fadeSlideUp 0.3s ease both', animationDelay: '210ms' }}>
                        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 13 }}>📊 Şube × Ürün Karşılaştırma</strong>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>({urunList.length} ürün, sıralı: toplam adet)</span>
                        </div>
                        <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead style={{ background: 'rgba(255,255,255,0.03)', position: 'sticky', top: 0 }}>
                              <tr>
                                {['#', 'Ürün', 'Grup', '✦ Toplam', ...subeAdlari.map(s => s.replace(' Şubesi', ''))].map((h, i) => (
                                  <th key={i} style={{
                                    padding: '7px 10px',
                                    textAlign: i >= 3 ? 'right' : i === 2 ? 'center' : 'left',
                                    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px',
                                    color: i === 3 ? 'var(--green)' : 'var(--muted)',
                                    borderRight: i === 3 ? '2px solid var(--border)' : undefined,
                                  }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {urunList.slice(0, 100).map((u, i) => {
                                const grpRenk = GRUP_RENK[u.grup] || '#94a3b8';
                                const maks = Math.max(...subeAdlari.map(s => u.subeler[s] || 0));
                                return (
                                  <tr key={u.stok_kodu || u.ad}
                                    style={{ borderTop: '1px solid rgba(255,255,255,0.04)', transition: 'background 0.1s' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                                    <td style={{ padding: '5px 10px', color: 'var(--muted)', fontSize: 10, width: 28 }}>{i + 1}</td>
                                    <td style={{ padding: '5px 10px', fontWeight: i < 5 ? 700 : 400 }}>
                                      {u.ad}
                                      {u.stok_kodu && <span style={{ marginLeft: 5, fontSize: 9, color: 'var(--muted)', fontFamily: 'monospace' }}>{u.stok_kodu}</span>}
                                    </td>
                                    <td style={{ padding: '5px 10px', textAlign: 'center' }}>
                                      {u.grup && (
                                        <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, background: grpRenk + '22', color: grpRenk, border: `1px solid ${grpRenk}44` }}>
                                          {u.grup}
                                        </span>
                                      )}
                                    </td>
                                    <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, color: 'var(--green)', borderRight: '2px solid var(--border)' }}>
                                      {Math.round(u.toplam)}
                                      <div style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}>{fmtTL(u.toplam_ciro)}</div>
                                    </td>
                                    {subeAdlari.map(sad => {
                                      const v = u.subeler[sad] || 0;
                                      const yogunluk = maks > 0 ? v / maks : 0;
                                      return (
                                        <td key={sad} style={{
                                          padding: '5px 10px', textAlign: 'right', fontFamily: 'monospace',
                                          background: v === 0 ? 'transparent' : `rgba(34,197,94,${0.05 + yogunluk * 0.18})`,
                                          color: v === 0 ? 'var(--muted)' : 'inherit',
                                          fontWeight: v === maks && v > 0 ? 700 : 400,
                                        }}>
                                          {v === 0 ? '—' : Math.round(v)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {urunList.length > 100 && (
                          <div style={{ padding: '6px 14px', fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
                            … {urunList.length - 100} ürün daha (ilk 100 gösteriliyor)
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Kategori + En çok satılan */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20, animation: 'fadeSlideUp 0.3s ease both', animationDelay: '230ms' }}>
                    <div className="card" style={{ padding: 0 }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13 }}>
                        🧃 Kategori &amp; Malzeme
                        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>tüm şubeler</span>
                      </div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--bg2)' }}>
                            {['Kategori', 'Adet', 'Malzeme', 'Ciro'].map((h, i) => (
                              <th key={h} style={{ padding: '7px 12px', textAlign: i === 1 ? 'center' : i === 3 ? 'right' : 'left', fontSize: 9, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(subeAnaliz.grup_pasta || []).map((g, i) => (
                            <tr key={i}
                              style={{ borderTop: '1px solid var(--border)', transition: 'background 0.1s' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                              onMouseLeave={e => e.currentTarget.style.background = ''}>
                              <td style={{ padding: '8px 12px', fontWeight: 600 }}>{g.kategori}</td>
                              <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                                <span style={{
                                  display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                                  background: (MALZEME_RENK[g.malzeme] || '#94a3b8') + '22',
                                  color: MALZEME_RENK[g.malzeme] || 'var(--text)', fontWeight: 700,
                                }}>{Math.round(g.adet)}</span>
                              </td>
                              <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)' }}>
                                <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: MALZEME_RENK[g.malzeme] || '#94a3b8', marginRight: 5 }} />
                                {g.malzeme}
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: 'var(--muted)' }}>{fmtTL(g.ciro)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg2)' }}>
                            <td colSpan={4} style={{ padding: '7px 12px', fontSize: 10, color: 'var(--muted)', fontStyle: 'italic' }}>
                              💡 Adet = o kategoriden satılan → kullanılan malzeme tahmini
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    <div className="card" style={{ padding: 0 }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13 }}>
                        🏆 En Çok Satılan
                        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>ilk 20</span>
                      </div>
                      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <tbody>
                            {(subeAnaliz.cok_satilan || []).map((u, i) => (
                              <tr key={i}
                                style={{
                                  borderTop: i > 0 ? '1px solid var(--border)' : undefined,
                                  animation: 'fadeSlideUp 0.17s ease both',
                                  animationDelay: `${Math.min(i * 22, 380)}ms`,
                                  transition: 'background 0.1s',
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                                onMouseLeave={e => e.currentTarget.style.background = ''}>
                                <td style={{ padding: '7px 12px', width: 28, fontSize: 11 }}>
                                  {i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}
                                </td>
                                <td style={{ padding: '7px 12px', fontWeight: i < 3 ? 700 : 400 }}>{u.urun}</td>
                                <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{Math.round(u.adet)}</td>
                                <td style={{ padding: '7px 12px', textAlign: 'right', fontSize: 11, color: 'var(--muted)' }}>{fmtTL(u.ciro)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {/* Kasa / Banka */}
                  {((subeAnaliz.kasa || []).length > 0 || (subeAnaliz.banka || []).length > 0) && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, animation: 'fadeSlideUp 0.3s ease both', animationDelay: '250ms' }}>
                      {[
                        { baslik: '💵 Nakit Kasalar', rows: subeAnaliz.kasa },
                        { baslik: '💳 POS / Banka', rows: subeAnaliz.banka },
                      ].map(({ baslik, rows }) => (
                        <div key={baslik} className="card" style={{ padding: 0 }}>
                          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13 }}>{baslik}</div>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <tbody>
                              {(rows || []).map((k, i) => (
                                <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}>
                                  <td style={{ padding: '8px 14px' }}>{k.ad}</td>
                                  <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                                    {fmtTL(k.tutar)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

      </div>{/* end tab content */}

      {/* ══ TOKEN MODAL ══ */}
      {tokenGuncelModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          animation: 'fadeSlideUp 0.18s ease',
        }} onClick={e => { if (e.target === e.currentTarget) { setTokenGuncelModal(false); setPopupBekle(false); } }}>
          <div className="card" style={{ width: 480, maxWidth: '95vw', padding: 28 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700 }}>🔗 Evobulut Bağlantısı</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--muted)' }}>
              Evobulut'taki satış verilerini çekmek için tarayıcı oturumu gerekir.
            </p>

            {/* Bookmark kurulumu */}
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>📌 İlk kez: Bookmark kur (1 kez yeterli)</div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
                Aşağıdaki butonu sürükleyip tarayıcının <strong>yer imleri çubuğuna</strong> bırak.
              </p>
              <a href={bookmarkletKod} style={{
                display: 'inline-block', padding: '8px 16px',
                background: 'var(--accent)', color: '#fff', borderRadius: 6,
                fontSize: 13, fontWeight: 600, textDecoration: 'none', cursor: 'grab', userSelect: 'none',
              }} onClick={e => e.preventDefault()}>
                ⭐ Evvel → Evobulut Token
              </a>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>
                💡 Sürükle → Yer imleri çubuğuna bırak.
              </p>
            </div>

            {/* Otomatik sync */}
            <div style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', marginBottom: 6 }}>🤖 Otomatik Token (PC Zamanlayıcı)</div>
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                PC'de <strong style={{ color: '#e2e8f0' }}>Görev Zamanlayıcı</strong> kuruldu — her 2 saatte bir token otomatik yenilenir.<br />
                PC açık ve <strong style={{ color: '#e2e8f0' }}>Chrome (Evvel ERP)</strong> kısayoluyla başlatılmışsa el atmana gerek yok.
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
                📂 Log: <code style={{ fontSize: 10, background: '#1e293b', padding: '1px 5px', borderRadius: 3 }}>Desktop\YAPALIM\evvel_token_sync.log</code>
              </div>
            </div>

            {/* Manuel güncelle */}
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>🚀 Manuel: Tek tıkla güncelle</div>
              {!popupBekle ? (
                <>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
                    Aşağıdaki butona bas → Evobulut küçük pencerede açılır →
                    Yer imlerinden <strong>"Evvel → Evobulut Token"</strong> butonuna tıkla → Bitti!
                  </p>
                  <button className="btn btn-primary" onClick={evoAc} style={{ width: '100%' }}>
                    🔓 Evobulut'u Aç ve Token Gönder
                  </button>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>
                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>↺</span>
                  </div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Evobulut penceresi açık</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                    Açılan pencerede yer imlerindeki<br />
                    <strong>"⭐ Evvel → Evobulut Token"</strong> butonuna tıkla.<br />
                    Pencere kapanınca veriler otomatik yüklenir.
                  </div>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'var(--accent)', color: '#fff',
                    padding: '6px 14px', borderRadius: 20, fontSize: 13,
                  }}>
                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                    Bekleniyor...
                  </div>
                  <br />
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
                    onClick={() => { setPopupBekle(false); clearInterval(pollRef.current); }}>
                    İptal
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setTokenGuncelModal(false); setPopupBekle(false); clearInterval(pollRef.current); }}>
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
