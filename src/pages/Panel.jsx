import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot } from 'recharts';

// ── Küçük yardımcı bileşenler ──────────────────────────────────────────────

function SectionHead({ children, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '1.1px' }}>
        {children}
      </span>
      {action}
    </div>
  );
}

function StatPill({ label, value, color = 'var(--text2)' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.6px', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>{value}</span>
    </div>
  );
}

// ── Ana bileşen ────────────────────────────────────────────────────────────

export default function Panel({ onNavigate }) {
  const nav = onNavigate || (() => {});

  const [panel, setPanel] = useState(null);
  const [uyarilar, setUyarilar] = useState([]);
  const [onaylar, setOnaylar] = useState([]);
  const [anomali, setAnomali] = useState(null);
  const [loading, setLoading] = useState(true);
  const [odemeModal, setOdemeModal] = useState(null);
  const [hizliModal, setHizliModal] = useState(null);
  const [gecmisOverlay, setGecmisOverlay] = useState(null);
  const [gecmisData, setGecmisData] = useState([]);
  const [topluUygula, setTopluUygula] = useState(false);
  const [loadingBtn, setLoadingBtn] = useState(false);
  const [manuelTutar, setManuelTutar] = useState('');
  const [msg, setMsg] = useState(null);
  const [sabitGiderOzet, setSabitGiderOzet] = useState({});
  const [sabitGiderUyarilar, setSabitGiderUyarilar] = useState([]);
  const [acikOdemeler, setAcikOdemeler] = useState(new Set());
  const [yaklaşanAcik, setYaklaşanAcik] = useState(false);
  const [kiraModal, setKiraModal] = useState(null);
  const [kiraForm, setKiraForm] = useState({});
  const [kiraLoading, setKiraLoading] = useState(false);
  const [odenenGiderler, setOdenenGiderler] = useState([]);

  const load = () => {
    setLoading(true);
    Promise.all([
      api('/panel'),
      api('/uyarilar'),
      api('/onay-kuyrugu'),
      api('/kasa-kontrol').catch(() => null),
      api('/sabit-giderler/odemeler').catch(() => null),
      api('/sabit-giderler/uyarilar').catch(() => null),
      api('/sabit-giderler/odenenler').catch(() => null),
    ]).then(([p, u, o, a, sg, su, og]) => {
      setPanel(p); setUyarilar(u || []); setOnaylar(o || []); setAnomali(a);
      setSabitGiderOzet(sg?.ozet || {});
      setSabitGiderUyarilar(su?.uyarilar || []);
      setOdenenGiderler(og || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 3500); };

  async function odemeOnayla(odemeId, tutar) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      const params = tutar ? `?tutar=${tutar}` : '';
      await api(`/odeme-plani/${odemeId}/ode${params}`, { method: 'POST' });
      toast(`✓ Ödeme onaylandı — kasadan düşüldü`);
      setOdemeModal(null); setManuelTutar(''); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function odemeErtele(odemeId) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      await api(`/odeme-plani/${odemeId}/ertele`, { method: 'POST' });
      toast('Ödeme 7 gün ertelendi'); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function onayKuyrukOnayla(oid) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      await api(`/onay-kuyrugu/${oid}/onayla`, { method: 'POST' });
      toast('✓ Onaylandı — kasadan düşüldü'); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function onayKuyrukReddet(oid) {
    if (loadingBtn) return;
    setLoadingBtn(true);
    try {
      await api(`/onay-kuyrugu/${oid}/reddet`, { method: 'POST' });
      toast('Reddedildi', 'yellow'); load();
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoadingBtn(false); }
  }

  async function gecmisAc(baslik, endpoint) {
    setGecmisOverlay({ baslik, endpoint });
    try {
      const data = await api(endpoint);
      setGecmisData(Array.isArray(data) ? data.slice(0, 20) : []);
    } catch { setGecmisData([]); }
  }

  async function topluOnerUygula() {
    const uygulanabilir = (panel.oneriler || []).filter(o => o.odeme_id && o.tavsiye_tutar > 0);
    if (!uygulanabilir.length) return;
    const toplamTutar = uygulanabilir.reduce((s, o) => s + o.tavsiye_tutar, 0);
    const kasaSonrasi = kasa - toplamTutar;
    const uyari = kasaSonrasi < 0 ? `\n⚠️ UYARI: Kasa eksiye düşecek! (${kasaSonrasi.toLocaleString('tr-TR')} ₺)` : '';
    if (!confirm(`${uygulanabilir.length} ödeme uygulanacak.\nToplam: ${toplamTutar.toLocaleString('tr-TR')} ₺${uyari}\n\nOnaylıyor musunuz?`)) return;
    setTopluUygula(true);
    try {
      const r = await api('/toplu-odeme', {
        method: 'POST',
        body: JSON.stringify({ odemeler: uygulanabilir.map(o => ({ odeme_id: o.odeme_id, tutar: o.tavsiye_tutar })) })
      });
      toast(`✓ ${r.uygulanan}/${uygulanabilir.length} ödeme uygulandı`);
      load();
    } catch (e) {
      toast(`Toplu ödeme başarısız: ${e.message}`, 'red');
    } finally {
      setTopluUygula(false);
    }
  }

  async function hizliKaydet(tip, form) {
    try {
      const endpointMap = { ciro: '/ciro', gider: '/anlik-gider', dis_kaynak: '/dis-kaynak' };
      await api(endpointMap[tip], { method: 'POST', body: JSON.stringify(form) });
      const mesajMap = {
        ciro: `✓ Ciro kaydedildi (${((form.nakit||0)+(form.pos||0)+(form.online||0)).toLocaleString('tr-TR')} ₺)`,
        gider: `✓ Gider eklendi: ${form.aciklama || form.kategori} (${(form.tutar||0).toLocaleString('tr-TR')} ₺)`,
        dis_kaynak: `✓ Gelir kaydedildi (${(form.tutar||0).toLocaleString('tr-TR')} ₺)`,
      };
      toast(mesajMap[tip] || '✓ Kaydedildi');
      setHizliModal(null); load();
    } catch (e) { toast(e.message, 'red'); }
  }

  // ── LOADING ──
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 14 }}>
      <div className="spinner" style={{ width: 24, height: 24 }} />
      <span style={{ fontSize: 12, color: 'var(--text3)', letterSpacing: '.5px' }}>FİNANS MOTORU ÇALIŞIYOR</span>
    </div>
  );

  if (!panel) return (
    <div className="empty">
      <p>Veri yüklenemedi</p>
      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={load}>Tekrar Dene</button>
    </div>
  );

  // ── HESAPLAMALAR ──
  const durum = panel.genel_durum || 'SAGLIKLI';
  const kasa = parseFloat(panel.kasa) || 0;
  const serbest = parseFloat(panel.serbest_nakit) || 0;
  const yuk7 = parseFloat(panel.yuk_7) || 0;
  const yuk15 = parseFloat(panel.yuk_15) || 0;
  const yuk30 = parseFloat(panel.yuk_30) || 0;
  const netAkis = parseFloat(panel.net_akis_30) || 0;
  const kasDayan = parseInt(panel.kac_gun_dayanir) || 999;
  const buAyCiro = parseFloat(panel.bu_ay_ciro) || 0;
  const riskGunu = panel.risk_gunu;
  const gelir30 = parseFloat(panel.son_30_gelir) || 0;
  const gider30 = parseFloat(panel.son_30_gider) || 0;

  const DC = {
    KRITIK:   { renk: 'var(--red)',    bg: 'rgba(245,101,101,.06)', ikon: '🚨', label: 'KRİTİK DURUM' },
    UYARI:    { renk: 'var(--yellow)', bg: 'rgba(246,201,14,.05)',  ikon: '⚠️', label: 'UYARI' },
    SAGLIKLI: { renk: 'var(--green)',  bg: 'rgba(62,207,142,.05)',  ikon: '✓',  label: 'SAĞLIKLI' },
  };
  const dc = DC[durum] || DC.SAGLIKLI;

  const kritikler = uyarilar.filter(u => u.seviye === 'KRITIK');
  const diger = uyarilar.filter(u => u.seviye !== 'KRITIK');
  const tumUyarilar = [...kritikler, ...diger];

  const simData = (panel.simulasyon || []).map(g => ({
    tarih: String(g.tarih || '').slice(5),
    tarihFull: g.tarih,
    mevcut: parseFloat(g.kasa_tahmini) || 0,
    onerili: parseFloat(g.kasa_tahmini_onerili) || 0,
    risk: g.risk,
  }));
  const riskDot = simData.find(g => g.risk);

  const riskBar = Math.min(100, yuk30 > 0 ? (yuk30 / Math.max(kasa, 1)) * 100 : 0);
  const riskRenk = kasa < yuk7 ? 'var(--red)' : kasa < yuk30 ? 'var(--yellow)' : 'var(--green)';

  // ── RENDER ──
  return (
    <div className="page">
      {/* TOAST */}
      {msg && (
        <div className={`alert-box ${msg.t}`} style={{ position: 'sticky', top: 0, zIndex: 20, marginBottom: 14 }}>
          {msg.m}
        </div>
      )}

      {/* ── DURUM BAŞLIĞI ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 22,
        padding: '16px 20px',
        background: dc.bg,
        border: `1px solid ${dc.renk}22`,
        borderLeft: `3px solid ${dc.renk}`,
        borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            background: `${dc.renk}18`,
            border: `1px solid ${dc.renk}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 17,
          }}>
            {dc.ikon}
          </div>
          <div>
            <div style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15, color: dc.renk, letterSpacing: '.5px' }}>
              {dc.label}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
              {panel.ozet?.kritik > 0 && <span style={{ color: 'var(--red)', marginRight: 8 }}>{panel.ozet.kritik} kritik</span>}
              {panel.ozet?.uyari > 0 && <span style={{ color: 'var(--yellow)', marginRight: 8 }}>{panel.ozet.uyari} uyarı</span>}
              {new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {onaylar.length > 0 && (
            <span className="badge badge-yellow" style={{ cursor: 'pointer', gap: 5 }} onClick={() => nav('onay')}>
              🔔 {onaylar.length} onay bekliyor
            </span>
          )}
          {(anomali?.sorunlu > 0 || anomali?.alarm_var) && (
            <span className="badge badge-red" style={{ cursor: 'pointer' }}
              onClick={() => nav('ledger')}
              title={anomali?.alarmlar?.map(a => a.mesaj).join(' | ') || ''}>
              ⚠️ {anomali?.sorunlu > 0 ? `${anomali.sorunlu} kasa anomalisi` : 'Kasa uyarısı'}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={load} style={{ fontSize: 11 }}>↻ Yenile</button>
        </div>
      </div>

      {/* ── KİRA / SÖZLEŞME UYARILARI ── */}
      {sabitGiderUyarilar.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {sabitGiderUyarilar.map((u, i) => {
            const kritik = u.seviye === 'KRITIK';
            const renk = kritik ? 'var(--red)' : 'var(--yellow)';
            return (
              <div key={i} className={u.blink ? 'blink' : ''} style={{
                background: kritik ? 'rgba(245,101,101,.06)' : 'rgba(246,201,14,.05)',
                border: `1px solid ${renk}22`, borderLeft: `3px solid ${renk}`,
                borderRadius: 'var(--radius)',
                padding: '12px 16px',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: renk }}>{u.mesaj}</div>
                  {u.alt_mesaj && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{u.alt_mesaj}</div>}
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>{u.aksiyon === 'TUTAR_GUNCELLE' ? '📈 Kira Artışı' : '📋 Sözleşme Bitişi'}</span>
                    <span>Tarih: {u.tarih}</span>
                    {u.gun_kalan >= 0
                      ? <span style={{ color: 'var(--yellow)' }}>{u.gun_kalan} gün kaldı</span>
                      : <span style={{ color: 'var(--red)', fontWeight: 600 }}>{Math.abs(u.gun_kalan)} gün geçti</span>
                    }
                    {u.durduruldu && <span style={{ color: 'var(--red)', fontWeight: 700 }}>⛔ Durduruldu</span>}
                  </div>
                </div>
                <button className="btn btn-sm" style={{ background: renk, color: '#fff', border: 'none', flexShrink: 0 }}
                  onClick={() => {
                    setKiraModal(u);
                    setKiraForm({ tutar: u.tutar || '', gecerlilik_tarihi: new Date().toISOString().split('T')[0], kira_artis_periyot: '', sozlesme_sure_ay: '' });
                  }}>
                  {u.aksiyon === 'TUTAR_GUNCELLE' ? '📈 Güncelle' : '🔄 Uzat'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── ACİL ÖDEMELER ── */}
      {kritikler.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {kritikler.map((u, i) => (
            <div key={i} className="blink" style={{
              background: 'rgba(245,101,101,.07)', border: '1px solid rgba(245,101,101,.3)',
              borderLeft: '3px solid var(--red)',
              borderRadius: 'var(--radius)', padding: '12px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--red)' }}>🚨 {u.aciklama}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{fmtDate(u.tarih)} · {fmt(u.tutar)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn btn-primary btn-sm" disabled={loadingBtn}
                  onClick={() => { setOdemeModal(u); setManuelTutar(''); }}>✓ Ödendi</button>
                <button className="btn btn-secondary btn-sm" disabled={loadingBtn}
                  onClick={() => odemeErtele(u.odeme_id)}>⏳ Ertele</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── YAKLAŞAN ÖDEMELER (accordion) ── */}
      {tumUyarilar.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <button onClick={() => setYaklaşanAcik(v => !v)} style={{
            width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 16px', borderRadius: 'var(--radius)',
            background: 'var(--bg2)', border: '1px solid var(--border)',
            cursor: 'pointer', color: 'inherit',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>📅 Yaklaşan Ödemeler</span>
              <span className="badge badge-gray">{tumUyarilar.length}</span>
              {kritikler.length > 0 && <span className="badge badge-red">{kritikler.length} acil</span>}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{yaklaşanAcik ? '▲' : '▼'}</span>
          </button>
          {yaklaşanAcik && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6, maxHeight: 380, overflowY: 'auto', paddingRight: 2 }}>
              {tumUyarilar.map((u, i) => {
                const renk = u.seviye === 'KRITIK' ? 'var(--red)' : u.renk === 'TURUNCU' ? 'var(--orange)' : 'var(--yellow)';
                const acik = u.seviye === 'KRITIK' || acikOdemeler.has(i);
                return (
                  <div key={i} className={u.blink ? 'blink' : ''} style={{
                    borderRadius: 'var(--radius-sm)', border: `1px solid ${renk}22`,
                    background: 'var(--bg2)', overflow: 'hidden',
                    cursor: u.seviye === 'KRITIK' ? 'default' : 'pointer',
                  }}>
                    <div onClick={() => { if (u.seviye === 'KRITIK') return; setAcikOdemeler(prev => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; }); }}
                      style={{ padding: '9px 13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderLeft: `3px solid ${renk}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.aciklama}</div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                          {fmtDate(u.tarih)} ·{' '}
                          <span style={{ color: renk, fontWeight: 600 }}>
                            {u.gun_farki === 0 ? 'BUGÜN' : u.gun_farki < 0 ? `${Math.abs(u.gun_farki)}g gecikmiş` : `${u.gun_farki} gün`}
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>{fmt(u.tutar)}</span>
                        {u.seviye !== 'KRITIK' && <span style={{ fontSize: 10, color: 'var(--text3)' }}>{acik ? '▲' : '▼'}</span>}
                      </div>
                    </div>
                    {acik && (
                      <div style={{ padding: '8px 13px 10px', borderTop: `1px solid ${renk}18`, background: 'var(--bg3)' }}>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                          Tam: <strong>{fmt(u.tutar)}</strong> · Asgari: <strong>{fmt(u.asgari)}</strong>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11 }}
                            onClick={e => { e.stopPropagation(); setOdemeModal(u); setManuelTutar(''); }}>✓ Ödendi</button>
                          <button className="btn btn-secondary btn-sm" style={{ flex: 1, fontSize: 11 }}
                            onClick={e => { e.stopPropagation(); odemeErtele(u.odeme_id); }}>⏳ Ertele</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── METRİK KARTLAR ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[
          { label: 'Güncel Kasa', value: fmt(kasa), sub: kasDayan < 999 ? `${kasDayan} gün` : 'Stabil', renk: kasa >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger', overlay: { baslik: 'Son Kasa Hareketleri', endpoint: '/kasa?limit=20' } },
          { label: 'Serbest Nakit', value: fmt(serbest), sub: '7g yük düşülmüş', renk: serbest >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger' },
          { label: 'Net Akış 30G', value: fmt(netAkis), sub: netAkis >= 0 ? 'Pozitif ✓' : '⚠ Negatif', renk: netAkis >= 0 ? 'var(--green)' : 'var(--red)', page: 'ledger' },
          { label: 'Bu Ay Ciro', value: fmt(buAyCiro), sub: new Date().toLocaleDateString('tr-TR', { month: 'long' }), renk: 'var(--text)', page: 'ciro' },
          { label: 'Geçen Ay Devir', value: fmt(panel.bu_ay_devir || 0), sub: panel.bu_ay_devir > 0 ? 'Devir ✓' : 'Devir yok', renk: panel.bu_ay_devir > 0 ? 'var(--yellow)' : 'var(--text3)', page: 'ledger' },
          { label: 'Dış Kaynak', value: fmt(panel.bu_ay_dis_kaynak || 0), sub: 'Ciro dışı gelir', renk: panel.bu_ay_dis_kaynak > 0 ? 'var(--blue)' : 'var(--text3)', page: 'dis-kaynak' },
          { label: 'Bu Ay Gider', value: fmt(panel.bu_ay_anlik_gider || 0), sub: 'Anlık giderler', renk: panel.bu_ay_anlik_gider > 0 ? 'var(--red)' : 'var(--text3)', page: 'anlik-gider' },
          (() => {
            const durdurulmus = sabitGiderUyarilar.filter(u => u.durduruldu === true).length;
            const geciken = sabitGiderOzet.geciken_adet || 0;
            const sub = durdurulmus > 0 ? `⛔ ${durdurulmus} durduruldu` : geciken > 0 ? `⚠ ${geciken} gecikmiş` : 'Tümü güncel ✓';
            const renk = durdurulmus > 0 ? 'var(--red)' : geciken > 0 ? 'var(--yellow)' : 'var(--text3)';
            return { label: 'Sabit Gider', value: fmt(sabitGiderOzet.toplam_odenen || 0), sub, renk, page: 'sabit-giderler' };
          })(),
        ].map(({ label, value, sub, renk, page, overlay }) => (
          <div key={label} style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderTop: `2px solid ${renk}`,
            borderRadius: 'var(--radius)',
            padding: '14px 16px',
            cursor: 'pointer',
            transition: 'transform .12s, border-color .12s, box-shadow .12s',
          }}
            onClick={() => overlay ? gecmisAc(overlay.baslik, overlay.endpoint) : nav(page)}
            onContextMenu={e => { e.preventDefault(); nav(page); }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,.4)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
          >
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: 8 }}>{label}</div>
            <div style={{ fontSize: 19, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk, letterSpacing: '-.5px' }}>{value}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 5, display: 'flex', justifyContent: 'space-between' }}>
              <span>{sub}</span>
              <span style={{ color: 'var(--border2)' }}>→</span>
            </div>
          </div>
        ))}
      </div>

      {/* Ciro dağılımı */}
      {(panel.bu_ay_nakit > 0 || panel.bu_ay_pos > 0 || panel.bu_ay_online > 0) && (
        <div style={{
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          padding: '12px 18px', marginBottom: 18,
          display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '1px' }}>Ciro Dağılımı</span>
          {[
            { label: 'Nakit', val: panel.bu_ay_nakit || 0, renk: 'var(--green)' },
            { label: 'POS', val: panel.bu_ay_pos || 0, renk: 'var(--blue)' },
            { label: 'Online', val: panel.bu_ay_online || 0, renk: 'var(--yellow)' },
          ].map(({ label, val, renk }) => {
            const toplam = (panel.bu_ay_nakit || 0) + (panel.bu_ay_pos || 0) + (panel.bu_ay_online || 0);
            const pct = toplam > 0 ? ((val / toplam) * 100).toFixed(0) : '0';
            return (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: renk }} />
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</span>
                <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>{fmt(val)}</span>
                <span style={{ fontSize: 10, color: 'var(--text3)' }}>%{pct}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── FİNANSMAN MALİYETİ ── */}
      {panel.bu_ay_finansman_maliyeti > 0 && (
        <div style={{
          background: 'rgba(245,101,101,.05)', border: '1px solid rgba(245,101,101,.15)',
          borderLeft: '3px solid var(--red)',
          borderRadius: 'var(--radius)', padding: '12px 18px', marginBottom: 18,
          display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '1px' }}>🔥 Finansman Maliyeti</span>
          <StatPill label="POS Kesintisi" value={fmt(panel.bu_ay_pos_kesinti || 0)} color="var(--red)" />
          {panel.bu_ay_online_kesinti > 0 && <StatPill label="Online Kesinti" value={fmt(panel.bu_ay_online_kesinti)} color="var(--red)" />}
          <StatPill label="Kart Faizi" value={fmt(panel.bu_ay_kart_faizi || 0)} color="var(--red)" />
          <div style={{ borderLeft: '1px solid var(--border)', paddingLeft: 20 }}>
            <StatPill label="Toplam Yanan" value={fmt(panel.bu_ay_finansman_maliyeti)} color="var(--red)" />
          </div>
          {panel.bu_ay_sadece_ciro > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>
              Ciroya oranı: <strong style={{ color: 'var(--yellow)' }}>%{((panel.bu_ay_finansman_maliyeti / panel.bu_ay_sadece_ciro) * 100).toFixed(1)}</strong>
            </span>
          )}
        </div>
      )}

      {/* ── HIZLI AKSİYON ── */}
      <div style={{
        display: 'flex', gap: 6, marginBottom: 22, padding: '10px 14px',
        background: 'var(--bg2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
        flexWrap: 'wrap', alignItems: 'center',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '1px', marginRight: 4 }}>Hızlı</span>
        {[
          { label: '+ Ciro', fn: () => setHizliModal('ciro') },
          { label: '− Gider', fn: () => setHizliModal('gider') },
          { label: '💳 Kart', fn: () => nav('kart-hareketleri') },
          { label: '💰 Dış Kaynak', fn: () => nav('dis-kaynak') },
          { label: '✅ Onay', fn: () => nav('onay') },
          { label: '📒 Ledger', fn: () => nav('ledger') },
        ].map(({ label, fn }) => (
          <button key={label} className="btn btn-secondary btn-sm" onClick={fn}>{label}</button>
        ))}
      </div>

      {/* ── ÖDEME BASKISI ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <SectionHead action={
          riskGunu && (
            <span style={{
              fontSize: 11, color: 'var(--red)',
              background: 'rgba(245,101,101,.1)', padding: '3px 10px',
              borderRadius: 4, fontWeight: 700, cursor: 'pointer',
            }} onClick={() => nav('ledger')}>
              💣 {riskGunu} — kasa sıfır
            </span>
          )
        }>
          ⚡ Ödeme Baskısı
        </SectionHead>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          {[
            { gun: '7 gün', tutar: yuk7 },
            { gun: '15 gün', tutar: yuk15 },
            { gun: '30 gün', tutar: yuk30 },
          ].map(({ gun, tutar }) => {
            const yetersiz = kasa < tutar;
            return (
              <div key={gun} style={{
                background: 'var(--bg3)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', textAlign: 'center',
                borderTop: `2px solid ${yetersiz ? 'var(--red)' : 'var(--border)'}`,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>{gun}</div>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: 'var(--font-mono)', color: yetersiz ? 'var(--red)' : 'var(--text)' }}>{fmt(tutar)}</div>
                <div style={{ fontSize: 10, color: yetersiz ? 'var(--red)' : 'var(--text3)', marginTop: 4, fontWeight: yetersiz ? 600 : 400 }}>
                  {yetersiz ? '⚠ Yetersiz' : tutar > 0 ? `%${((tutar / Math.max(kasa, 1)) * 100).toFixed(0)} kasa` : '—'}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ height: 4, background: 'var(--bg4)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ height: '100%', borderRadius: 2, width: `${Math.min(100, riskBar)}%`, background: riskRenk, transition: 'width .6s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
          <span>Kasa: <strong style={{ color: riskRenk, fontFamily: 'var(--font-mono)' }}>{fmt(kasa)}</strong></span>
          <span>Baskı: <strong style={{ color: riskRenk }}>{riskBar.toFixed(0)}%</strong></span>
          <span>30g yük: <strong style={{ fontFamily: 'var(--font-mono)' }}>{fmt(yuk30)}</strong></span>
        </div>
      </div>

      {/* ── KARAR ALANI: Ödemeler + Kart ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>

        {/* Bu Ay Ödemeler */}
        <div className="card">
          <SectionHead>📅 Bu Ay Ödemeler</SectionHead>
          {tumUyarilar.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}><p style={{ fontSize: 12 }}>Yaklaşan ödeme yok ✓</p></div>
          ) : (
            <div>
              <div style={{ fontSize: 12, marginBottom: 10 }}>
                <span style={{ fontWeight: 700 }}>{tumUyarilar.length}</span>
                <span style={{ color: 'var(--text3)' }}> ödeme · </span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--red)', fontWeight: 700 }}>
                  {fmt(tumUyarilar.reduce((s, u) => s + (u.tutar || 0), 0))}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>↑ Üstteki listeden yönetin</div>
            </div>
          )}
        </div>

        {/* Kart Riskleri */}
        <div className="card">
          <SectionHead action={
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={() => nav('kart-merkez')}>Merkez →</button>
          }>
            💳 Kart Riskleri
          </SectionHead>
          {!panel.kart_analiz?.length ? (
            <div className="empty" style={{ padding: 24 }}>
              <p style={{ fontSize: 12 }}>Kart tanımlanmamış</p>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => nav('kartlar')}>Kart Ekle</button>
            </div>
          ) : (() => {
            const sirali = [...panel.kart_analiz].filter(k => (k.guncel_borc || 0) > 0).sort((a, b) => (b.faiz_orani * b.guncel_borc) - (a.faiz_orani * a.guncel_borc));
            const oncelikli = sirali[0];
            const toplamAylikFaiz = panel.kart_analiz.reduce((s, k) => s + (parseFloat(k.guncel_borc) || 0) * (parseFloat(k.faiz_orani) || 0) / 100 / 12, 0);
            const enYakin = [...panel.kart_analiz].filter(k => (k.guncel_borc || 0) > 0).sort((a, b) => (a.gun_kaldi || 99) - (b.gun_kaldi || 99))[0];
            return (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 12 }}>
                  {[
                    { label: '🎯 Önce Kapat', val: oncelikli?.kart_adi || '—', sub: oncelikli ? `%${oncelikli.faiz_orani} faiz` : '' },
                    { label: '💸 Aylık Faiz', val: fmt(toplamAylikFaiz), sub: 'tüm kartlar' },
                    { label: '📅 En Yakın', val: enYakin ? (enYakin.gun_kaldi <= 0 ? 'BUGÜN' : `${enYakin.gun_kaldi} gün`) : '—', sub: enYakin?.kart_adi || '' },
                  ].map(({ label, val, sub }) => (
                    <div key={label} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{val}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>{sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {panel.kart_analiz.map(k => {
                    const d = parseFloat(k.limit_doluluk) || 0;
                    const renk = d > 0.85 ? 'var(--red)' : d > 0.65 ? 'var(--yellow)' : 'var(--green)';
                    return (
                      <div key={k.kart_adi} className={k.blink ? 'blink' : ''} style={{
                        background: 'var(--bg3)', borderRadius: 'var(--radius-sm)', padding: '10px 12px',
                        borderLeft: `2px solid ${renk}`, cursor: 'pointer',
                      }} onClick={() => nav('kart-analiz')}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                          <div>
                            <span style={{ fontWeight: 600, fontSize: 12 }}>{k.kart_adi}</span>
                            <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 6 }}>{k.banka}</span>
                            {k.blink && <span className="badge badge-red" style={{ marginLeft: 6, fontSize: 9 }}>SON GÜN</span>}
                          </div>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: renk }}>{fmt(k.guncel_borc)}</span>
                        </div>
                        <div className="progress-bar" style={{ marginBottom: 6 }}>
                          <div className={`progress-fill ${d > 0.85 ? 'red' : d > 0.65 ? 'yellow' : 'green'}`} style={{ width: `${Math.min(100, d * 100)}%` }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text3)' }}>
                          <span>Asgari: <strong style={{ color: renk }}>{fmt(k.asgari_odeme)}</strong></span>
                          <span style={{ color: renk, fontWeight: 700 }}>{(d * 100).toFixed(0)}%</span>
                          <span>{k.gun_kaldi <= 0 ? '🔴 BUGÜN' : `${k.gun_kaldi} gün`}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── ÖDENEN SABİT GİDERLER ── */}
      {odenenGiderler.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <SectionHead action={
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>
              −{parseInt(odenenGiderler.reduce((s, g) => s + parseFloat(g.odenen_tutar || g.odenecek_tutar || 0), 0)).toLocaleString('tr-TR')} ₺
            </span>
          }>
            ✅ Bu Ay Ödenen Sabit Giderler
          </SectionHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
            {odenenGiderler.map((g, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg3)',
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: 12 }}>{g.gider_adi}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>{g.kategori} · {g.odeme_tarihi?.slice(0, 10) || '—'}</div>
                </div>
                <div style={{ fontWeight: 700, color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  −{parseInt(g.odenen_tutar || g.odenecek_tutar || 0).toLocaleString('tr-TR')} ₺
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SİMÜLASYON GRAFİĞİ ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <SectionHead action={
          <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text3)' }}>
            <span><span style={{ color: 'var(--green)', fontWeight: 700 }}>—</span> Mevcut</span>
            <span><span style={{ color: 'var(--yellow)', fontWeight: 700 }}>- -</span> Önerili</span>
          </div>
        }>
          📉 30 Günlük Kasa Projeksiyonu
        </SectionHead>
        <div className="chart-container">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={simData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="kasaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3ecf8e" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3ecf8e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="tarih" tick={{ fill: 'var(--text3)', fontSize: 10 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: 'var(--text3)', fontSize: 10 }} tickFormatter={v => (v / 1000).toFixed(0) + 'K'} width={42} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11, boxShadow: '0 4px 16px rgba(0,0,0,.4)' }}
                formatter={(v, n) => [fmt(v), n === 'mevcut' ? 'Mevcut' : 'Önerili']}
                labelFormatter={l => `📅 ${l}`}
              />
              <ReferenceLine y={0} stroke="var(--red)" strokeDasharray="4 3" strokeOpacity={0.5} />
              <Area type="monotone" dataKey="mevcut" stroke="#3ecf8e" fill="url(#kasaGrad)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="onerili" stroke="var(--yellow)" fill="none" strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
              {riskDot && (
                <ReferenceDot x={riskDot.tarih} y={riskDot.mevcut} r={5} fill="var(--red)" stroke="var(--bg2)" strokeWidth={2} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── STRATEJİ ÖNERİLERİ ── */}
      {panel.oneriler?.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <SectionHead action={
            panel.oneriler.filter(o => o.odeme_id && o.tavsiye_tutar > 0).length > 1 && (
              <button className="btn btn-primary btn-sm" disabled={topluUygula} onClick={topluOnerUygula}>
                {topluUygula ? '⏳ Uygulanıyor...' : `⚡ Tümünü Uygula (${panel.oneriler.filter(o => o.odeme_id && o.tavsiye_tutar > 0).length})`}
              </button>
            )
          }>
            🧠 Strateji Motoru
          </SectionHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {panel.oneriler.map((o, i) => {
              const renk = o.renk === 'KIRMIZI' ? 'var(--red)' : o.renk === 'TURUNCU' ? 'var(--orange)' : o.renk === 'SARI' ? 'var(--yellow)' : 'var(--text3)';
              const kasaSonrasi = o.tavsiye_tutar > 0 ? kasa - o.tavsiye_tutar : null;
              return (
                <div key={i} style={{
                  padding: '11px 14px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg3)', borderLeft: `3px solid ${renk}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: renk }}>{o.baslik}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{o.aciklama}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                      {o.tavsiye_tutar > 0 && (
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}>{fmt(o.tavsiye_tutar)}</div>
                          {kasaSonrasi !== null && (
                            <div style={{ fontSize: 10, color: kasaSonrasi >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              → {fmt(kasaSonrasi)}
                            </div>
                          )}
                        </div>
                      )}
                      {o.odeme_id && o.tavsiye_tutar > 0 && (
                        <button className="btn btn-primary btn-sm"
                          onClick={() => { setOdemeModal({ ...o, tutar: o.tavsiye_tutar, asgari: o.tavsiye_tutar * 0.4 }); setManuelTutar(''); }}>
                          Uygula
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── ONAY MERKEZİ ── */}
      {onaylar.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--yellow)' }}>
          <SectionHead>🔔 Onay Merkezi — {onaylar.length} bekleyen</SectionHead>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {onaylar.map(o => (
              <div key={o.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                background: o.seviye === 'KRITIK' ? 'rgba(245,101,101,.06)' : 'var(--bg3)',
                borderLeft: `2px solid ${o.seviye === 'KRITIK' ? 'var(--red)' : o.seviye === 'UYARI' ? 'var(--yellow)' : 'var(--border)'}`,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {({ SABIT_GIDER: 'Sabit Gider', KART_ODEME: 'Kart Ödemesi', ANLIK_GIDER: 'Anlık Gider', PERSONEL_MAAS: 'Maaş', VADELI_ODEME: 'Vadeli', DIS_KAYNAK: 'Dış Kaynak', CIRO: 'Ciro', ODEME_PLANI: 'Ödeme Planı', KART_FAIZ: 'Kart Faizi' })[o.islem_turu] || o.islem_turu}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{o.aciklama} · {fmtDate(o.tarih)}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700 }}>{fmt(o.tutar)}</span>
                  <button className="btn btn-primary btn-sm" onClick={() => onayKuyrukOnayla(o.id)}>✓</button>
                  <button className="btn btn-danger btn-sm" onClick={() => onayKuyrukReddet(o.id)}>✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── KASA DETAY ── */}
      {(gelir30 > 0 || gider30 > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <SectionHead action={
            <button className="btn btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={() => nav('ledger')}>Ledger →</button>
          }>
            🔍 Kasa Özeti (30 Gün)
          </SectionHead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { label: '↑ Gelir', value: gelir30, renk: 'var(--green)' },
              { label: '↓ Gider', value: gider30, renk: 'var(--red)' },
              { label: '= Net', value: netAkis, renk: netAkis >= 0 ? 'var(--green)' : 'var(--red)' },
            ].map(({ label, value, renk }) => (
              <div key={label} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', textAlign: 'center' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>{fmt(value)}</div>
              </div>
            ))}
          </div>
          {(anomali?.sorunlu > 0 || anomali?.alarm_var) && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(245,101,101,.07)', border: '1px solid rgba(245,101,101,.2)', borderRadius: 'var(--radius-sm)' }}>
              {anomali?.sorunlu > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>🚨 {anomali.sorunlu} kayıt eksik kasa karşılığı!</span>
                  <button className="btn btn-danger btn-sm" onClick={() => nav('ledger')}>İncele →</button>
                </div>
              )}
              {anomali?.alarmlar?.filter(a => a.seviye === 'KRITIK' || a.seviye === 'UYARI').map((a, i) => (
                <div key={i} style={{ fontSize: 12, color: a.seviye === 'KRITIK' ? 'var(--red)' : 'var(--yellow)', fontWeight: 600, marginTop: 4 }}>
                  {a.seviye === 'KRITIK' ? '🚨' : '⚠'} {a.mesaj}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MODALLER ── */}

      {/* Kira Modal */}
      {kiraModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setKiraModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>{kiraModal.aksiyon === 'TUTAR_GUNCELLE' ? '📈 Kira Tutarı Güncelle' : '🔄 Sözleşme Uzat'}</h3>
              <button className="modal-close" onClick={() => setKiraModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ padding: '10px 14px', background: 'rgba(245,101,101,.06)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(245,101,101,.2)', marginBottom: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{kiraModal.gider_adi}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4, display: 'flex', gap: 14 }}>
                  <span>Mevcut: <strong>{parseInt(kiraModal.tutar).toLocaleString('tr-TR')} ₺</strong></span>
                  <span style={{ color: 'var(--red)' }}>Tarih: <strong>{kiraModal.tarih}</strong></span>
                </div>
              </div>
              <div className="form-row cols-2">
                <div className="form-group">
                  <label>Yeni Tutar (₺) *</label>
                  <input type="number" value={kiraForm.tutar}
                    onChange={e => setKiraForm({ ...kiraForm, tutar: e.target.value })}
                    placeholder={String(kiraModal.tutar)} />
                </div>
                <div className="form-group">
                  <label>Hangi Aydan İtibaren? *</label>
                  <input type="date" value={kiraForm.gecerlilik_tarihi}
                    onChange={e => setKiraForm({ ...kiraForm, gecerlilik_tarihi: e.target.value })} />
                </div>
                {kiraModal.aksiyon === 'TUTAR_GUNCELLE' && (
                  <div className="form-group" style={{ gridColumn: '1/-1' }}>
                    <label>Sonraki Artış Periyodu</label>
                    <select value={kiraForm.kira_artis_periyot} onChange={e => setKiraForm({ ...kiraForm, kira_artis_periyot: e.target.value })}>
                      <option value="">Seçin</option>
                      <option value="6ay">6 Aylık</option>
                      <option value="1yil">Yıllık</option>
                      <option value="2yil">2 Yıllık</option>
                      <option value="5yil">5 Yıllık</option>
                    </select>
                  </div>
                )}
                {kiraModal.aksiyon === 'SOZLESME_UZAT' && (
                  <div className="form-group" style={{ gridColumn: '1/-1' }}>
                    <label>Yeni Sözleşme Süresi (Ay) *</label>
                    <input type="number" min={1} max={120} value={kiraForm.sozlesme_sure_ay}
                      onChange={e => setKiraForm({ ...kiraForm, sozlesme_sure_ay: e.target.value })} placeholder="ör. 24" />
                  </div>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setKiraModal(null)}>İptal</button>
              <button className="btn btn-primary" disabled={kiraLoading || !kiraForm.tutar || !kiraForm.gecerlilik_tarihi}
                onClick={async () => {
                  setKiraLoading(true);
                  try {
                    await api(`/sabit-giderler/${kiraModal.id}`, { method: 'PUT', body: { gider_adi: kiraModal.gider_adi, kategori: kiraModal.tip === 'KIRA_ARTIS' ? 'Kira' : 'Abonelik', tutar: parseFloat(kiraForm.tutar), periyot: 'aylik', odeme_gunu: 1, gecerlilik_tarihi: kiraForm.gecerlilik_tarihi, kira_artis_periyot: kiraForm.kira_artis_periyot || null, sozlesme_sure_ay: kiraForm.sozlesme_sure_ay ? parseInt(kiraForm.sozlesme_sure_ay) : null } });
                    toast('✅ Güncellendi');
                    setKiraModal(null); load();
                  } catch (e) { toast(e.message, 'red'); }
                  finally { setKiraLoading(false); }
                }}>
                {kiraLoading ? '⏳ Kaydediliyor...' : kiraModal.aksiyon === 'TUTAR_GUNCELLE' ? '✅ Güncelle' : '✅ Uzat ve Kaydet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ödeme Modal */}
      {odemeModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setOdemeModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>💳 Ödeme Onayla</h3>
              <button className="modal-close" onClick={() => setOdemeModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{odemeModal.aciklama}</div>
                <div style={{ display: 'flex', gap: 20, fontSize: 11, color: 'var(--text3)', flexWrap: 'wrap' }}>
                  <span>Son gün: <strong style={{ color: 'var(--text)' }}>{fmtDate(odemeModal.tarih)}</strong></span>
                  <span>Tam: <strong style={{ color: 'var(--text)' }}>{fmt(odemeModal.tutar)}</strong></span>
                  <span>Asgari: <strong style={{ color: 'var(--yellow)' }}>{fmt(odemeModal.asgari)}</strong></span>
                </div>
              </div>
              <div className="form-group">
                <label>Ödenen Tutar — boş bırakırsan tam tutar</label>
                <input type="number" value={manuelTutar} onChange={e => setManuelTutar(e.target.value)}
                  placeholder={`Tam tutar: ${odemeModal.tutar}`} autoFocus />
                {manuelTutar && parseFloat(manuelTutar) < (odemeModal.asgari || 0) && (
                  <div style={{ fontSize: 11, color: 'var(--yellow)', marginTop: 4 }}>⚠ Asgari ödemenin altında ({fmt(odemeModal.asgari)})</div>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
                Kasadan düşülecek: <strong style={{ color: 'var(--red)', fontSize: 14, fontFamily: 'var(--font-mono)' }}>
                  {fmt(parseFloat(manuelTutar) || odemeModal.tutar)}
                </strong>
                {kasa - (parseFloat(manuelTutar) || odemeModal.tutar) < 0 && (
                  <span style={{ color: 'var(--red)', fontSize: 11, marginLeft: 8 }}>⚠ Kasa eksiye düşer!</span>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => { setOdemeModal(null); setManuelTutar(''); }}>Vazgeç</button>
              <button className="btn btn-primary" onClick={() => odemeOnayla(odemeModal.odeme_id, manuelTutar || null)}>✓ Ödendi — Onayla</button>
            </div>
          </div>
        </div>
      )}

      {hizliModal && <HizliAksiyonModal tip={hizliModal} onKapat={() => setHizliModal(null)} onKaydet={hizliKaydet} />}
      {gecmisOverlay && <GecmisOverlay baslik={gecmisOverlay.baslik} data={gecmisData} onKapat={() => { setGecmisOverlay(null); setGecmisData([]); }} />}
    </div>
  );
}

// ── GEÇMİŞ OVERLAY ──
function GecmisOverlay({ baslik, data, onKapat }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3>📋 {baslik}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          {data.length === 0 ? (
            <div className="empty" style={{ padding: 32 }}><p>Kayıt yok</p></div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {data.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 18px', borderBottom: '1px solid var(--border)',
                }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{r.islem_turu || r.aciklama || r.kategori || '—'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{r.tarih}{r.aciklama && r.islem_turu ? ` · ${r.aciklama}` : ''}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: (parseFloat(r.tutar) || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {r.tutar !== undefined
                      ? ((parseFloat(r.tutar) >= 0 ? '+' : '') + parseFloat(r.tutar).toLocaleString('tr-TR') + ' ₺')
                      : r.toplam ? '+' + parseFloat(r.toplam).toLocaleString('tr-TR') + ' ₺' : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── HIZLI AKSİYON MODAL ──
function HizliAksiyonModal({ tip, onKapat, onKaydet }) {
  const bugun = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ tarih: bugun, tutar: '', aciklama: '', kategori: 'Genel', nakit: '', pos: '', online: '', sube_id: 'sube-merkez' });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const titles = { ciro: '📈 Hızlı Ciro Girişi', gider: '💸 Hızlı Gider Girişi' };

  function handleKaydet() {
    if (tip === 'ciro') {
      const nakit = parseFloat(form.nakit) || 0, pos = parseFloat(form.pos) || 0, online = parseFloat(form.online) || 0;
      if (nakit + pos + online <= 0) { alert('En az bir tutar girilmeli'); return; }
      onKaydet('ciro', { tarih: form.tarih, nakit, pos, online, aciklama: form.aciklama || `Ciro ${(nakit+pos+online).toLocaleString('tr-TR')} ₺`, sube_id: form.sube_id });
    } else if (tip === 'gider') {
      const tutar = parseFloat(form.tutar);
      if (!tutar || tutar <= 0) { alert('Geçerli bir tutar girin'); return; }
      onKaydet('gider', { tarih: form.tarih, tutar, aciklama: form.aciklama || form.kategori, kategori: form.kategori });
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal">
        <div className="modal-header">
          <h3>{titles[tip] || 'Kayıt'}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Tarih</label>
            <input type="date" value={form.tarih} onChange={e => set('tarih', e.target.value)} />
          </div>
          {tip === 'ciro' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {['nakit', 'pos', 'online'].map(k => (
                <div className="form-group" key={k}>
                  <label style={{ textTransform: 'capitalize' }}>{k} (₺)</label>
                  <input type="number" value={form[k]} onChange={e => set(k, e.target.value)} placeholder="0" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="form-group">
                <label>Tutar (₺)</label>
                <input type="number" value={form.tutar} onChange={e => set('tutar', e.target.value)} placeholder="0" autoFocus />
              </div>
              <div className="form-group">
                <label>Kategori</label>
                <input value={form.kategori} onChange={e => set('kategori', e.target.value)} placeholder="Genel" />
              </div>
            </>
          )}
          <div className="form-group">
            <label>Açıklama</label>
            <input value={form.aciklama} onChange={e => set('aciklama', e.target.value)} placeholder="İsteğe bağlı" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onKapat}>Vazgeç</button>
          <button className="btn btn-primary" onClick={handleKaydet}>✓ Kaydet</button>
        </div>
      </div>
    </div>
  );
}
