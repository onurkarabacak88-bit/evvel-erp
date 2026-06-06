import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

export default function KartMerkez({ onNavigate }) {
  const nav = onNavigate || (() => {});
  const [kartlar, setKartlar] = useState([]);
  const [kasa, setKasa] = useState(0);
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

  // Manuel faiz girişi kaldırıldı — sistem her gece her kart için kesim/son_odeme
  // döngüsüne göre faizi otomatik yazar (akdi vs gecikme ayrımıyla).
  // Manuel tetikleme için yukarıdaki "Ekstre Faizi Üret" butonu yeterli.

  useEffect(() => {
    Promise.all([api('/kartlar'), api('/kasa')])
      .then(([k, ks]) => {
        setKartlar(k.filter(x => x.aktif));
        setKasa(parseFloat(ks.kasa) || 0);
        setLoading(false);
      });
  }, []);

  // Strateji sekmesine girilince otomatik yükle (manuel "Üret" gerektirmesin)
  useEffect(() => {
    if (aktifTab === 'strateji' && !strateji && !stratejiLoading) stratejiYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aktifTab]);

  // ── HESAPLAMALAR ──────────────────────────────────────────────
  // (Çığ/kartopu borç motoru kaldırıldı → tek motor "Borç Koçu" sekmesinde, backend hesaplı.)

  const toplamBorc = kartlar.reduce((s, k) => s + (parseFloat(k.guncel_borc) || 0), 0);
  const toplamLimit = kartlar.reduce((s, k) => s + (parseFloat(k.limit_tutar) || 0), 0);
  const toplamAsgari = kartlar.reduce((s, k) => s + (parseFloat(k.asgari_odeme) || 0), 0);
  const toplamEkstre = kartlar.reduce((s, k) => s + (parseFloat(k.bu_ekstre) || 0), 0);
  const bosLimit = toplamLimit - toplamBorc;

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

  // Aciliyet/sıklık sırası: günlük bakılan + zaman-kritik üstte, analiz altta.
  // Öncelik Sırası + Kapanış Planı KALDIRILDI → tek borç motoru "Borç Koçu" sekmesinde
  // (çığ/kartopu + kurtuluş projeksiyonu, backend hesaplı). Tekrar/iki motor tutarsızlığı bitti.
  const TABS = [
    { id: 'genel', label: '📊 Genel Durum' },
    { id: 'takvim', label: '📅 Ödeme Takvimi' },
    { id: 'strateji', label: '🤖 Strateji Motoru' },
  ];

  return (
    <div className="page">
      <div className="page-header flex items-center justify-between" style={{ marginBottom: 16 }}>
        <div>
          <h2>💳 Kart Kontrol Merkezi</h2>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>{kartlar.length} aktif kart · Kullanım: <strong style={{ color: toplamLimit > 0 && toplamBorc / toplamLimit > 0.85 ? 'var(--red)' : 'var(--text2)' }}>%{toplamLimit > 0 ? Math.round(toplamBorc / toplamLimit * 100) : 0}</strong></p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-primary btn-sm" onClick={faizUret} title="Son ödemesi geçen kartlara eksik faizi hesaplayıp yazar (otomatik scheduler her gece de çalışır)">💰 Eksik Faizi Hesapla</button>
          <button className="btn btn-secondary btn-sm" onClick={() => nav('kartlar')}>⚙️ Kart Tanımları</button>
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

      {/* TABS — segment kontrol (kabuktaki kart yönetimi tasarım diliyle tutarlı) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', gap: 3, background: 'var(--bg3)', borderRadius: 9, padding: 3 }}>
          {TABS.map(t => (
            <button key={t.id} type="button" onClick={() => setAktifTab(t.id)}
              style={{
                padding: '7px 13px', fontSize: 12.5, fontWeight: aktifTab === t.id ? 700 : 500,
                border: 'none', borderRadius: 6, cursor: 'pointer',
                background: aktifTab === t.id ? 'var(--primary)' : 'transparent',
                color: aktifTab === t.id ? '#fff' : 'var(--text2)', transition: 'background .15s',
              }}>
              {t.label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
          🧭 Borç kapatma planı (çığ/kartopu) için üstteki <strong style={{ color: 'var(--purple)' }}>Borç Koçu</strong> sekmesi
        </span>
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
                  <div style={{ background: 'var(--bg3)', borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}
                    title={k.devreden_faiz > 0
                      ? `Tek çekim: ${fmt(k.tek_cekim)} + Taksit: ${fmt(k.aylik_taksit)} + Devreden faiz: ${fmt(k.devreden_faiz)}`
                      : `Tek çekim: ${fmt(k.tek_cekim)} + Taksit: ${fmt(k.aylik_taksit)}`}>
                    <div style={{ color: 'var(--text3)' }}>Bu Ekstre {k.devreden_faiz > 0 && <span style={{color:'var(--red)'}}>⚠</span>}</div>
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

    </div>
  );
}
