import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

export default function KartMerkez({ onNavigate }) {
  const nav = onNavigate || (() => {});
  const [kartlar, setKartlar] = useState([]);
  const [kasa, setKasa] = useState(0);
  const [aylikButce, setAylikButce] = useState('');
  const [plan, setPlan] = useState(null);
  const [faizModal, setFaizModal] = useState(null);
  const [faizTutar, setFaizTutar] = useState('');
  const [faizDonem, setFaizDonem] = useState(new Date().toISOString().slice(0,7));
  const [loading, setLoading] = useState(true);
  const [aktifTab, setAktifTab] = useState('genel');
  const [strateji, setStrateji] = useState(null);
  const [stratejiLoading, setStratejiLoading] = useState(false);
  const [faizMsg, setFaizMsg] = useState(null);

  async function faizUret() {
    try {
      const r = await api('/kartlar/faiz-uret', { method: 'POST' });
      const yazilan = r.kartlar?.filter(k => k.durum === 'yazildi') || [];
      setFaizMsg(yazilan.length > 0
        ? `✅ ${yazilan.length} karta faiz yazıldı`
        : 'ℹ️ Faiz yazılacak kart yok (tam ödeme veya zaten yazılmış)');
      setTimeout(() => setFaizMsg(null), 5000);
    } catch (e) { setFaizMsg('Hata: ' + e.message); }
  }

  async function stratejiYukle() {
    setStratejiLoading(true);
    try {
      const r = await api('/strateji');
      setStrateji(r);
    } catch(e) {
      console.error(e);
      setStrateji({ oneriler: [], hata: e.message });
    }
    finally { setStratejiLoading(false); }
  }

  async function faizKaydet() {
    if (!faizTutar || parseFloat(faizTutar) <= 0) { alert('Tutar girin'); return; }
    try {
      await api('/kart-faiz', { method: 'POST', body: JSON.stringify({ kart_id: faizModal.id, tutar: parseFloat(faizTutar), donem: faizDonem }) });
      setFaizModal(null); setFaizTutar(''); alert('✓ Faiz kaydedildi');
    } catch (e) { alert(e.message); }
  }

  useEffect(() => {
    Promise.all([api('/kartlar'), api('/kasa')])
      .then(([k, ks]) => {
        setKartlar(k.filter(x => x.aktif));
        setKasa(parseFloat(ks.kasa) || 0);
        setLoading(false);
      });
  }, []);

  // ── HESAPLAMALAR ──────────────────────────────────────────────

  // Çığ kartopu — en yüksek faizli kartı önce öde (avalanche method)
  function avalanchePlan(kartlar, aylikOdeme) {
    if (!aylikOdeme || aylikOdeme <= 0) return null;
    let kartDurum = kartlar
      .filter(k => (k.guncel_borc || 0) > 0)
      .map(k => ({
        id: k.id,
        ad: k.kart_adi,
        banka: k.banka,
        borc: parseFloat(k.guncel_borc) || 0,
        faiz: parseFloat(k.faiz_orani) || 0,
        asgari: parseFloat(k.asgari_odeme) || 0,
      }))
      .sort((a, b) => b.faiz - a.faiz); // yüksek faiz önce

    const toplamAsgari = kartDurum.reduce((s, k) => s + k.asgari, 0);
    if (aylikOdeme < toplamAsgari) return { hata: `Aylık bütçe en az ${fmt(toplamAsgari)} olmalı (asgari ödemeler)` };

    let ay = 0;
    let toplamFaiz = 0;
    const maxAy = 120;
    const kapanisAylari = {};

    while (kartDurum.some(k => k.borc > 0) && ay < maxAy) {
      ay++;
      let kalanButce = aylikOdeme;

      // Önce tüm kartlara asgari öde
      for (let k of kartDurum) {
        if (k.borc <= 0) continue;
        const odeme = Math.min(k.asgari, k.borc);
        k.borc -= odeme;
        kalanButce -= odeme;
        // Faiz ekle
        if (k.borc > 0) {
          k.borc += k.borc * (k.faiz / 100 / 12);
          toplamFaiz += k.borc * (k.faiz / 100 / 12);
        }
        if (k.borc <= 0.01) {
          k.borc = 0;
          if (!kapanisAylari[k.id]) kapanisAylari[k.id] = ay;
        }
      }

      // Fazla parayı en yüksek faizliye ver
      const hedef = kartDurum.find(k => k.borc > 0);
      if (hedef && kalanButce > 0) {
        hedef.borc -= Math.min(kalanButce, hedef.borc);
        if (hedef.borc <= 0.01) {
          hedef.borc = 0;
          if (!kapanisAylari[hedef.id]) kapanisAylari[hedef.id] = ay;
        }
      }
    }

    return {
      toplamAy: ay,
      toplamFaiz,
      kapanisAylari,
      bitti: kartDurum.every(k => k.borc <= 0),
    };
  }

  async function topluFaizHesapla() {
    try {
      const r = await api('/kartlar/faiz-uret', { method: 'POST', body: JSON.stringify({}) });
      const faizliSayisi = (r.kartlar || []).filter(s => s.faiz > 0).length;
      setFaizMsg(`✅ ${faizliSayisi} kart için faiz hesaplandı`);
      setTimeout(() => setFaizMsg(null), 4000);
      api('/kartlar').then(k => setKartlar(k.filter(x => x.aktif)));
    } catch (e) { setFaizMsg('Hata: ' + e.message); }
  }

  const toplamBorc = kartlar.reduce((s, k) => s + (parseFloat(k.guncel_borc) || 0), 0);
  const toplamLimit = kartlar.reduce((s, k) => s + (parseFloat(k.limit_tutar) || 0), 0);
  const toplamAsgari = kartlar.reduce((s, k) => s + (parseFloat(k.asgari_odeme) || 0), 0);
  const toplamEkstre = kartlar.reduce((s, k) => s + (parseFloat(k.bu_ekstre) || 0), 0);
  const bosLimit = toplamLimit - toplamBorc;

  // Faiz × bakiye sıralaması
  const oncelikSirasi = [...kartlar]
    .filter(k => (k.guncel_borc || 0) > 0)
    .sort((a, b) => {
      const skorA = (parseFloat(a.faiz_orani) || 0) * (parseFloat(a.guncel_borc) || 0);
      const skorB = (parseFloat(b.faiz_orani) || 0) * (parseFloat(b.guncel_borc) || 0);
      return skorB - skorA;
    });

  // Takvim: bu ay son ödeme günleri
  const bugun = new Date();
  const takvim = [...kartlar]
    .filter(k => (k.guncel_borc || 0) > 0)
    .sort((a, b) => (a.gun_kaldi || 99) - (b.gun_kaldi || 99));

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
      <div className="spinner" />
    </div>
  );

  const TABS = [
    { id: 'genel', label: '📊 Genel Durum' },
    { id: 'strateji', label: '🤖 Strateji Motoru' },
    { id: 'oncelik', label: '🎯 Öncelik Sırası' },
    { id: 'takvim', label: '📅 Ödeme Takvimi' },
    { id: 'plan', label: '🗓 Kapanış Planı' },
  ];

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between" style={{ marginBottom: 16 }}>
        <div>
          <h2>💳 Kart Kontrol Merkezi</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>{kartlar.length} aktif kart · Toplam borç: <strong style={{ color: 'var(--red)' }}>{fmt(toplamBorc)}</strong></p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={topluFaizHesapla}>📊 Ay Sonu Faiz Hesapla</button>
            <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={faizUret}>💰 Ekstre Faizi Üret</button>
          <button className="btn btn-secondary btn-sm" onClick={() => nav('kartlar')}>⚙️ Kart Tanımları</button>
        </div>
          </div>
          {faizMsg && <div style={{ fontSize: 11, color: 'var(--green)' }}>{faizMsg}</div>}
        </div>
      </div>

      {faizMsg && (
        <div style={{ padding: '10px 16px', marginBottom: 12, borderRadius: 8,
          background: faizMsg.startsWith('✅') ? 'rgba(76,175,132,0.1)' : 'rgba(220,160,0,0.1)',
          border: `1px solid ${faizMsg.startsWith('✅') ? 'var(--green)' : 'var(--yellow)'}`,
          fontSize: 13 }}>{faizMsg}</div>
      )}

      {/* ÖZET METRİKLER */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: '💳 Toplam Borç', val: toplamBorc, renk: 'var(--red)' },
          { label: '🟢 Boş Limit', val: bosLimit, renk: bosLimit > 0 ? 'var(--green)' : 'var(--red)' },
          { label: '📋 Bu Ekstre', val: toplamEkstre, renk: 'var(--yellow)' },
          { label: '⚡ Asgari Toplam', val: toplamAsgari, renk: 'var(--text1)' },
          { label: '🏦 Toplam Limit', val: toplamLimit, renk: 'var(--text3)' },
        ].map(({ label, val, renk }) => (
          <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
            <div className="metric-label">{label}</div>
            <div className="metric-value" style={{ fontSize: 20, color: renk }}>{fmt(val)}</div>
          </div>
        ))}
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setAktifTab(t.id)}
            style={{
              padding: '8px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
              background: aktifTab === t.id ? 'var(--primary)' : 'transparent',
              color: aktifTab === t.id ? '#fff' : 'var(--text2)',
              borderRadius: '6px 6px 0 0',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* TAB: GENEL DURUM */}
      {aktifTab === 'genel' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {kartlar.map(k => {
            const borc = parseFloat(k.guncel_borc) || 0;
            const limit = parseFloat(k.limit_tutar) || 0;
            const d = limit > 0 ? borc / limit : 0;
            const renk = d > 0.85 ? 'var(--red)' : d > 0.65 ? 'var(--yellow)' : 'var(--green)';
            const bos = limit - borc;
            return (
              <div key={k.id} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', borderLeft: `4px solid ${renk}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{k.kart_adi}</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>{k.banka} · Faiz: %{k.faiz_orani}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)' }}>{fmt(borc)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>/ {fmt(limit)} limit</div>
                  </div>
                </div>
                <div className="progress-bar" style={{ marginBottom: 8 }}>
                  <div className={`progress-fill ${d > 0.85 ? 'red' : d > 0.65 ? 'yellow' : 'green'}`} style={{ width: `${Math.min(100, d * 100)}%` }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 11 }}>
                  <div style={{ background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text3)' }}>Boş Limit</div>
                    <div style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(bos)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text3)' }}>Bu Ekstre</div>
                    <div style={{ fontWeight: 700, color: 'var(--yellow)' }}>{fmt(k.bu_ekstre)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text3)' }}>Asgari</div>
                    <div style={{ fontWeight: 700 }}>{fmt(k.asgari_odeme)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text3)' }}>Son Ödeme</div>
                    <div style={{ fontWeight: 700, color: (k.gun_kaldi || 99) <= 3 ? 'var(--red)' : 'var(--text1)' }}>
                      {k.gun_kaldi <= 0 ? '🔴 BUGÜN' : `${k.gun_kaldi} gün`}
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: 'right', marginTop: 8 }}>
                  <button className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} onClick={() => { setFaizModal(k); setFaizTutar(''); }}>📈 Ekstre Faizi Gir</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* TAB: STRATEJİ MOTORU */}
      {aktifTab === 'strateji' && (
        <div>
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 12, color: 'var(--text2)' }}>
            🤖 <strong>Gerçek Karar Motoru:</strong> Kasa, yaklaşan ödemeler ve faiz oranları birlikte değerlendirilerek optimal ödeme dağılımı üretilir.
          </div>
          {stratejiLoading && <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></div>}
          {!stratejiLoading && !strateji && (
            <div className="empty">
              <p>Strateji henüz yüklenmedi</p>
              <button className="btn btn-primary btn-sm" onClick={stratejiYukle}>🤖 Strateji Üret</button>
            </div>
          )}
          {strateji && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
                {[
                  { label: '💰 Kasa', val: strateji.kasa, renk: strateji.kasa >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: '🆓 Kullanılabilir', val: strateji.kullanilabilir_nakit, renk: strateji.kullanilabilir_nakit >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: '⚡ Toplam Öneri', val: strateji.toplam_oneri_tutari, renk: 'var(--yellow)' },
                ].map(({ label, val, renk }) => (
                  <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
                    <div className="metric-label">{label}</div>
                    <div className="metric-value" style={{ fontSize: 20, color: renk }}>{fmt(val)}</div>
                  </div>
                ))}
              </div>
              {strateji.oneriler?.length === 0 ? (
                <div className="empty"><p>Bekleyen ödeme yok</p></div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {strateji.oneriler.map((o, i) => {
                    const renk = o.renk === 'KIRMIZI' ? 'var(--red)' : o.renk === 'TURUNCU' ? '#f07040' : o.renk === 'SARI' ? 'var(--yellow)' : 'var(--text3)';
                    return (
                      <div key={i} style={{ padding: '12px 16px', borderRadius: 8, background: o.blink ? 'rgba(220,50,50,0.07)' : 'var(--bg2)', border: `1px solid ${renk}` }} className={o.blink ? 'blink' : ''}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: renk }}>{o.baslik}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{o.aciklama}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{o.kart_adi} · Son gün: {o.tarih}</div>
                          </div>
                          {o.tavsiye_tutar > 0 && (
                            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk, flexShrink: 0 }}>
                              {fmt(o.tavsiye_tutar)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg3)', borderRadius: 8, fontSize: 12, color: 'var(--text2)' }}>
                <strong>Motor Yorumu:</strong> {
                  strateji.kullanilabilir_nakit < 0
                    ? `⚠️ Kasa yetersiz. Toplam öneri ${fmt(strateji.toplam_oneri_tutari)}.`
                    : `✅ Öneriler uygulanırsa ${fmt(strateji.kullanilabilir_nakit)} kullanılabilir kalır.`
                }
              </div>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={stratejiYukle}>↻ Yenile</button>
            </div>
          )}
        </div>
      )}

      {/* TAB: ÖNCELİK SIRASI */}
      {aktifTab === 'oncelik' && (
        <div>
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 12, color: 'var(--text2)' }}>
            🎯 <strong>Avalanche Yöntemi:</strong> Faiz × Bakiye skoruna göre sıralanmıştır. En yüksek skorlu kartı önce kapatmak toplam faiz yükünü minimuma indirir.
          </div>
          {oncelikSirasi.map((k, i) => {
            const skor = (parseFloat(k.faiz_orani) || 0) * (parseFloat(k.guncel_borc) || 0);
            const aylikFaiz = (parseFloat(k.guncel_borc) || 0) * (parseFloat(k.faiz_orani) || 0) / 100 / 12;
            return (
              <div key={k.id} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 16px', marginBottom: 8, borderRadius: 8,
                background: i === 0 ? 'rgba(220,50,50,0.08)' : 'var(--bg2)',
                border: `1px solid ${i === 0 ? 'var(--red)' : 'var(--border)'}`,
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: i === 0 ? 'var(--red)' : i === 1 ? 'var(--yellow)' : 'var(--bg3)',
                  color: i <= 1 ? '#fff' : 'var(--text2)', fontWeight: 700, fontSize: 14, flexShrink: 0
                }}>
                  {i + 1}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{k.kart_adi} <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>{k.banka}</span></div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                    Faiz: %{k.faiz_orani} · Aylık faiz maliyeti: <strong style={{ color: 'var(--red)' }}>{fmt(aylikFaiz)}</strong>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--red)' }}>{fmt(k.guncel_borc)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>Skor: {skor.toFixed(0)}</div>
                </div>
              </div>
            );
          })}
          {oncelikSirasi.length === 0 && (
            <div className="empty"><div className="icon">🎉</div><p>Tüm kartlar temiz!</p></div>
          )}
        </div>
      )}

      {/* TAB: ÖDEME TAKVİMİ */}
      {aktifTab === 'takvim' && (
        <div>
          <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 12, color: 'var(--text2)' }}>
            📅 Son ödeme tarihine göre sıralanmıştır. Asgari toplamı: <strong style={{ color: 'var(--yellow)' }}>{fmt(toplamAsgari)}</strong>
          </div>
          {takvim.map((k, i) => {
            const gecikti = (k.gun_kaldi || 99) < 0;
            const acil = (k.gun_kaldi || 99) <= 3;
            return (
              <div key={k.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', marginBottom: 8, borderRadius: 8,
                background: gecikti ? 'rgba(220,50,50,0.1)' : acil ? 'rgba(220,160,0,0.08)' : 'var(--bg2)',
                border: `1px solid ${gecikti ? 'var(--red)' : acil ? 'var(--yellow)' : 'var(--border)'}`,
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {gecikti && '🚨 '}{acil && !gecikti && '⚠️ '}{k.kart_adi}
                    <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400, marginLeft: 6 }}>{k.banka}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                    Son ödeme: {k.son_odeme_gunu}. gün ·
                    {gecikti ? ` ${Math.abs(k.gun_kaldi)} gün geçti` : k.gun_kaldi === 0 ? ' BUGÜN' : ` ${k.gun_kaldi} gün kaldı`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmt(k.bu_ekstre)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>asgari: {fmt(k.asgari_odeme)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* TAB: KAPANIŞ PLANI */}
      {aktifTab === 'plan' && (
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Aylık Ödeme Bütçeni Gir</h3>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input type="number" value={aylikButce}
                onChange={e => setAylikButce(e.target.value)}
                placeholder={`En az ${fmt(toplamAsgari)} (asgari)`}
                style={{ flex: 1, padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}
              />
              <button className="btn btn-primary" onClick={() => {
                const sonuc = avalanchePlan(kartlar, parseFloat(aylikButce));
                setPlan(sonuc);
              }}>Hesapla</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              Kasa: {fmt(kasa)} · Toplam borç: {fmt(toplamBorc)} · Asgari toplamı: {fmt(toplamAsgari)}
            </div>
          </div>

          {plan && (
            plan.hata ? (
              <div className="alert-box red">{plan.hata}</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                  <div className="metric-card" style={{ borderTop: '3px solid var(--green)' }}>
                    <div className="metric-label">⏱ Kapanış Süresi</div>
                    <div className="metric-value green" style={{ fontSize: 28 }}>{plan.toplamAy} ay</div>
                    <div className="metric-sub">{(plan.toplamAy / 12).toFixed(1)} yıl</div>
                  </div>
                  <div className="metric-card" style={{ borderTop: '3px solid var(--red)' }}>
                    <div className="metric-label">💸 Toplam Faiz</div>
                    <div className="metric-value red" style={{ fontSize: 28 }}>{fmt(plan.toplamFaiz)}</div>
                    <div className="metric-sub">Avalanche yöntemi</div>
                  </div>
                  <div className="metric-card" style={{ borderTop: '3px solid var(--yellow)' }}>
                    <div className="metric-label">💰 Toplam Ödeme</div>
                    <div className="metric-value" style={{ fontSize: 28 }}>{fmt(toplamBorc + plan.toplamFaiz)}</div>
                    <div className="metric-sub">Borç + faiz</div>
                  </div>
                </div>

                <div className="card">
                  <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Kart Kart Kapanış Tarihleri</h3>
                  {oncelikSirasi.map((k, i) => {
                    const kapanisAy = plan.kapanisAylari[k.id];
                    const kapanisTarih = kapanisAy ? (() => {
                      const d = new Date();
                      d.setMonth(d.getMonth() + kapanisAy);
                      return d.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
                    })() : '?';
                    return (
                      <div key={k.id} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '10px 12px', marginBottom: 6, borderRadius: 6,
                        background: i === 0 ? 'rgba(220,50,50,0.06)' : 'var(--bg3)',
                        borderLeft: `3px solid ${i === 0 ? 'var(--red)' : i === 1 ? 'var(--yellow)' : 'var(--border)'}`,
                      }}>
                        <div>
                          <span style={{ fontWeight: 600, fontSize: 12 }}>{i + 1}. {k.kart_adi}</span>
                          <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>%{k.faiz_orani} faiz</span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>🏁 {kapanisTarih}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)' }}>{kapanisAy} ay sonra · {fmt(k.guncel_borc)} borç</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          )}
        </div>
      )}
      {faizModal && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setFaizModal(null)}>
          <div className="modal">
            <div className="modal-header">
              <h3>📈 Ekstre Faizi — {faizModal.kart_adi}</h3>
              <button className="modal-close" onClick={() => setFaizModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group"><label>Dönem</label>
                <input type="month" value={faizDonem} onChange={e => setFaizDonem(e.target.value)} /></div>
              <div className="form-group"><label>Faiz Tutarı (₺)</label>
                <input type="number" value={faizTutar} onChange={e => setFaizTutar(e.target.value)} placeholder="0.00" autoFocus /></div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setFaizModal(null)}>Vazgeç</button>
              <button className="btn btn-primary" onClick={faizKaydet}>✓ Kaydet</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
