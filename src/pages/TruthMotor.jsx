// TRUTH MOTOR Panel — izole tanı motoru kontrol merkezi
// Mevcut akıştan veri okur, kendi içinde sağıltır (üçgenleme), karar üretir.
// Şubeler bazında aç/kapat + manuel çalıştır + geçmiş kararlar.
import React, { useEffect, useMemo, useState, useCallback } from 'react';

const API = '';  // same-origin

const TANI_ETIKET = {
  UYUMLU:                { renk: '#86efac', bg: 'rgba(34,197,94,0.10)',  bord: 'rgba(34,197,94,0.35)',  emoji: '✅' },
  IKRAM_EVO_TEYIT:       { renk: '#86efac', bg: 'rgba(34,197,94,0.10)',  bord: 'rgba(34,197,94,0.35)',  emoji: '🎁✓' },
  IKRAM_UNUTULDU:        { renk: '#fbbf24', bg: 'rgba(245,158,11,0.10)', bord: 'rgba(245,158,11,0.35)', emoji: '🎁' },
  SWEETHEARTING_SINYAL:  { renk: '#fca5a5', bg: 'rgba(220,38,38,0.10)',  bord: 'rgba(220,38,38,0.40)',  emoji: '🚨' },
  STOK_KACAGI_BEYANSIZ:  { renk: '#fca5a5', bg: 'rgba(220,38,38,0.10)',  bord: 'rgba(220,38,38,0.40)',  emoji: '📦❓' },
  ZIMMET_NAKIT_CEPTE:    { renk: '#f87171', bg: 'rgba(239,68,68,0.15)',  bord: 'rgba(239,68,68,0.45)',  emoji: '👋💰' },
  IKRAM_SURDURULEN:      { renk: '#93c5fd', bg: 'rgba(59,130,246,0.10)', bord: 'rgba(59,130,246,0.35)', emoji: '🎁📅' },
  SABAH_HATALI:          { renk: '#fbbf24', bg: 'rgba(245,158,11,0.10)', bord: 'rgba(245,158,11,0.35)', emoji: '🌅' },
  AKSAM_HATALI:          { renk: '#fbbf24', bg: 'rgba(245,158,11,0.10)', bord: 'rgba(245,158,11,0.35)', emoji: '🌙' },
  SABAH_TOPYEKUN:        { renk: '#fbbf24', bg: 'rgba(245,158,11,0.15)', bord: 'rgba(245,158,11,0.40)', emoji: '🌅🌅' },
  AKSAM_TOPYEKUN:        { renk: '#fbbf24', bg: 'rgba(245,158,11,0.15)', bord: 'rgba(245,158,11,0.40)', emoji: '🌙🌙' },
  KAOS:                  { renk: '#f87171', bg: 'rgba(239,68,68,0.10)',  bord: 'rgba(239,68,68,0.35)',  emoji: '🌀' },
  COZULMEDI:             { renk: '#a78bfa', bg: 'rgba(139,92,246,0.10)', bord: 'rgba(139,92,246,0.35)', emoji: '🔄' },
  POS_SYNC_HATA:         { renk: '#f87171', bg: 'rgba(239,68,68,0.10)',  bord: 'rgba(239,68,68,0.35)',  emoji: '⚙️' },
  POS_BYPASS:            { renk: '#fca5a5', bg: 'rgba(220,38,38,0.10)',  bord: 'rgba(220,38,38,0.40)',  emoji: '🚫' },
  AKSAM_ZIMMET_SINYALI:  { renk: '#f87171', bg: 'rgba(239,68,68,0.15)',  bord: 'rgba(239,68,68,0.45)',  emoji: '🌙💸' },
  YETERSIZ_VERI:         { renk: 'var(--text3)', bg: 'rgba(120,120,120,0.10)', bord: 'rgba(120,120,120,0.30)', emoji: '⚪', etiket: 'Veri yok' },
};

const BOYUT_ETIKET = {
  kasa:           '💰 Kasa',
  bardak_plastik: '🥤 Plastik Bardak',
  bardak_buyuk:   '☕ 14oz Bardak',
  bardak_kucuk:   '☕ 8oz Bardak',
  bardak_karton:  '☕ Karton Bardak',
  redbull_soda:   '🥫 Redbull/Soda',
  pasta:          '🍰 Pasta',
};

function fetchJson(url, opts) {
  return fetch(url, opts).then(async (r) => {
    const txt = await r.text();
    let body = null;
    try { body = txt ? JSON.parse(txt) : null; } catch (_) {}
    if (!r.ok) {
      const msg = (body && (body.detail || body.message)) || `HTTP ${r.status}`;
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return body;
  });
}

function bugunStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function TruthMotor() {
  const [durum, setDurum] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [kararlar, setKararlar] = useState([]);
  const [gunluk, setGunluk] = useState({ tarih: bugunStr(), subeler: [] });
  const [tarih, setTarih] = useState(bugunStr());
  const [detay, setDetay] = useState(null);  // {sube_id, sube_ad}
  const [aktifSekme, setAktifSekme] = useState('genel');  // genel|vardiya|tani|mali|gelismis
  const [filtre, setFiltre] = useState({ sadece_anomali: true, sube_id: '', tani: '' });
  const [busy, setBusy] = useState('');
  const [hata, setHata] = useState('');
  const [info, setInfo] = useState('');
  const [sonRapor, setSonRapor] = useState(null);  // son çalıştırmanın AI raporu
  const [aiYorumGecmisi, setAiYorumGecmisi] = useState([]);  // WhatsApp AI yorum arşivi

  const durumYukle = useCallback(async () => {
    setYukleniyor(true);
    setHata('');
    try {
      const d = await fetchJson(`${API}/api/ops/truth/durum`);
      setDurum(d || { global_aktif: false, subeler: [] });
    } catch (e) {
      setHata(String(e.message || e));
    } finally {
      setYukleniyor(false);
    }
  }, []);

  const kararlariYukle = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (filtre.sadece_anomali) q.set('sadece_anomali', 'true');
      if (filtre.sube_id) q.set('sube_id', filtre.sube_id);
      if (filtre.tani) q.set('tani', filtre.tani);
      q.set('limit', '150');
      const d = await fetchJson(`${API}/api/ops/truth/kararlar?${q.toString()}`);
      setKararlar(d?.kayitlar || []);
    } catch (e) {
      setHata(String(e.message || e));
    }
  }, [filtre]);

  const gunlukYukle = useCallback(async () => {
    try {
      const d = await fetchJson(`${API}/api/ops/truth/gunluk-rapor?tarih=${tarih}`);
      setGunluk(d || { tarih, subeler: [] });
    } catch (e) {
      // sessiz hata — sayfa diğer kısımları çalışsın
    }
  }, [tarih]);

  const aiYorumGecmisiYukle = useCallback(async () => {
    try {
      const d = await fetchJson(`${API}/api/ops/truth/ai-yorum-gecmis?limit=30`);
      setAiYorumGecmisi(d?.kayitlar || []);
    } catch (e) {
      // sessiz hata — sayfa diğer kısımları çalışsın
    }
  }, []);

  useEffect(() => { durumYukle(); }, [durumYukle]);
  useEffect(() => { kararlariYukle(); }, [kararlariYukle]);
  useEffect(() => { gunlukYukle(); }, [gunlukYukle]);
  useEffect(() => { aiYorumGecmisiYukle(); }, [aiYorumGecmisiYukle]);

  const subeAyar = async (sube_id, aktif, mod) => {
    setBusy(`ayar-${sube_id}`);
    setHata(''); setInfo('');
    try {
      await fetchJson(`${API}/api/ops/truth/ayar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sube_id, aktif, mod: mod || 'read_only' }),
      });
      setInfo(`${sube_id}: ${aktif ? 'aktif' : 'pasif'} (${mod || 'read_only'})`);
      await durumYukle();
    } catch (e) {
      setHata(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  const calistir = async (sube_id) => {
    setBusy(`run-${sube_id}`);
    setHata(''); setInfo('');
    try {
      const r = await fetchJson(`${API}/api/ops/truth/calistir/${sube_id}/${tarih}`, {
        method: 'POST',
      });
      if (!r?.calisti) {
        setHata(r?.sebep || 'Motor çalışmadı');
      } else {
        const anomali = (r.taniler || []).filter((t) => !['UYUMLU', 'YETERSIZ_VERI'].includes(t.tani));
        let mesaj = `${sube_id}: ${r.kaydedildi} karar, ${anomali.length} anomali (mod=${r.mod})`;
        if (r.baskin_tetik?.baslatildi) {
          mesaj += ` · 🚨 KASA BASKINI BAŞLATILDI (id: ${(r.baskin_tetik.id || '').slice(0, 8)}) — ${(r.baskin_tetik.tani || []).join(', ')}`;
        } else if (r.baskin_tetik?.oneri) {
          mesaj += ` · ⚠️ Kasa baskını ÖNERİSİ (mod=read_only, ${(r.baskin_tetik.tani || []).join(', ')})`;
        }
        setInfo(mesaj);
        // Motor zaten yorum_metni döndürüyor — ayrı API çağrısı yok
        if (r.yorum_metni) {
          setSonRapor({
            sube_id,
            proaktif_alarm: r.alarm || 'orta',
            yorum_metni: r.yorum_metni,
            onlemler: (r.anomali_boyutlar || []).map(b => ({
              aciliyet: r.alarm || 'orta',
              aciklama: `${b.boyut}: ${b.tani} (güven %${(b.guven||0).toFixed(0)})`,
            })),
          });
        }
        await Promise.all([kararlariYukle(), gunlukYukle()]);
      }
    } catch (e) {
      setHata(String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  const stats = useMemo(() => {
    const s = { toplam: kararlar.length, anomali: 0, sweethearting: 0, cozulmedi: 0, sistemik: 0 };
    for (const k of kararlar) {
      if (!['UYUMLU', 'YETERSIZ_VERI'].includes(k.tani)) s.anomali++;
      if (k.tani === 'SWEETHEARTING_SINYAL') s.sweethearting++;
      if (k.tani === 'COZULMEDI') s.cozulmedi++;
      if (k.tani === 'SISTEMIK_HATA') s.sistemik++;
    }
    return s;
  }, [kararlar]);

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto', minWidth: 0, overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>🧠 Akıllı Denetim</h2>
        <button className="btn btn-secondary" onClick={() => { durumYukle(); kararlariYukle(); }}>
          ↻ Yenile
        </button>
      </div>
      <p style={{ margin: '4px 0 20px', fontSize: 12, color: 'var(--text3)', lineHeight: 1.5 }}>
        Akşamcı beyanı + sabahcı kör sayım + Evo POS gerçeği üçgenlenir.
        5 boyut (kasa + 4 ürün) paralel analiz edilir, çapraz örüntüler tanılanır.
        Bu motor <strong>izoledir</strong> — global env var veya şube ayarı ile tamamen kapatılabilir.
      </p>

      {/* GLOBAL DURUM + KPI ÖZETİ */}
      {(() => {
        const bugunAnomali = (gunluk?.subeler || []).reduce((s, r) => s + (Number(r.anomali_sayisi) || 0), 0);
        const calistirilan = (gunluk?.subeler || []).filter(r => r.calistirildi).length;
        const aktifSube = (durum?.subeler || []).filter(s => s.aktif).length;
        return (
          <div className="card" style={{ padding: 12, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Durum</div>
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700, marginTop: 2,
                  background: durum?.global_aktif ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                  color: durum?.global_aktif ? '#86efac' : '#fca5a5',
                }}>{durum?.global_aktif ? 'AKTİF' : 'KAPALI'}</span>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Bugün Anomali</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: bugunAnomali > 0 ? '#fca5a5' : '#86efac' }}>
                  {bugunAnomali}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Çalıştırıldı</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{calistirilan}/{gunluk?.subeler?.length || 0}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Aktif Motor</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{aktifSube}/{durum?.subeler?.length || 0}</div>
              </div>
              <div>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Tarih</div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace' }}>{tarih}</div>
              </div>
            </div>
            {!durum?.global_aktif && (
              <div style={{ marginTop: 10, fontSize: 11, color: '#fca5a5' }}>
                ⚠️ Motor kapatılmış. Aktif etmek için Railway env'da{' '}
                <code className="mono">EVVEL_TRUTH_MOTOR_ENABLED</code>'ı sil veya{' '}
                <code className="mono">=1</code> yap (varsayılan: açık).
              </div>
            )}
          </div>
        );
      })()}

      {/* HATA / INFO */}
      {hata && (
        <div style={{
          background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
          borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 12, color: '#fca5a5',
        }}>⚠️ {hata}</div>
      )}
      {info && (
        <div style={{
          background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
          borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 12, color: '#86efac',
        }}>✓ {info}</div>
      )}

      {/* AI Denetim Raporu — son çalıştırma sonucu */}
      {sonRapor && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>
              SON ÇALIŞTIRMA RAPORU — {sonRapor.sube_id}
            </span>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 10, padding: '2px 8px' }}
              onClick={() => setSonRapor(null)}
            >✕ Kapat</button>
          </div>
          <DenetimRaporuKarti proaktifData={sonRapor} />
        </div>
      )}

      {/* GÜNLÜK RAPOR MATRİSİ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '20px 0 8px', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>📋 Günlük Denetim Raporu</h3>
        <input
          type="date" value={tarih} onChange={(e) => setTarih(e.target.value)}
          className="input" style={{ fontSize: 12, padding: '3px 8px' }}
        />
        <button className="btn btn-sm" onClick={() => setTarih(bugunStr())} style={{ fontSize: 11 }}>
          Bugün
        </button>
        <button
          className="btn btn-sm"
          disabled={!durum?.global_aktif || !!busy}
          onClick={async () => {
            const aktif = (durum?.subeler || []).filter(s => s.aktif);
            if (aktif.length === 0) { setHata('Aktif şube yok'); return; }
            setInfo(''); setHata('');
            for (const s of aktif) {
              setBusy(`tum-${s.sube_id}`);
              try {
                await fetchJson(`${API}/api/ops/truth/calistir/${s.sube_id}/${tarih}`, { method: 'POST' });
              } catch (e) {
                // sessiz hata — sonraki şubeye geç
              }
            }
            setBusy('');
            setInfo(`${aktif.length} şube için motor çalıştırıldı`);
            await Promise.all([gunlukYukle(), kararlariYukle()]);
          }}
          title={!durum?.global_aktif ? 'Global flag kapalı' : 'Tüm aktif şubeler için motoru çalıştır'}
          style={{
            fontSize: 11, padding: '4px 10px',
            background: '#10b981', borderColor: '#10b981', color: '#fff', fontWeight: 600,
          }}>
          {busy?.startsWith('tum-') ? `⏳ ${busy.slice(4, 12)}…` : '▶▶ Hepsini Çalıştır'}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
          {gunluk?.subeler?.length || 0} şube
        </span>
      </div>

      <div style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
        {(gunluk?.subeler || []).map((r) => {
          const e = TANI_ETIKET[r.ana_tani] || TANI_ETIKET.UYUMLU;
          const calistirilmadi = !r.calistirildi;
          return (
            <div key={r.sube_id} className="card" style={{
              padding: '10px 14px',
              borderLeft: `4px solid ${e.bord}`,
              display: 'grid',
              gridTemplateColumns: 'minmax(120px, 180px) minmax(140px, 200px) minmax(0, 1fr) auto',
              gap: 12, alignItems: 'start', overflow: 'hidden',
            }}>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{r.sube_ad}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {r.motor_aktif ? `motor • ${r.motor_mod}` : 'motor kapalı'}
                </div>
              </div>
              <div>
                <span style={{
                  padding: '3px 8px', borderRadius: 3, fontSize: 11, fontWeight: 600,
                  background: calistirilmadi ? 'rgba(120,120,120,0.15)' : e.bg,
                  border: `1px solid ${calistirilmadi ? 'rgba(120,120,120,0.30)' : e.bord}`,
                  color: calistirilmadi ? 'var(--text3)' : e.renk,
                }}>
                  {calistirilmadi ? '⚪ Çalıştırılmadı'
                    : r.ana_tani === 'YETERSIZ_VERI' ? '⚪ Veri yok'
                    : `${e.emoji} ${r.ana_tani}`}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                {r.anomali_sayisi > 0 ? (
                  <div>
                    <div style={{ marginBottom: 4 }}>
                      <strong style={{ color: '#fbbf24' }}>{r.anomali_sayisi}</strong> anomali:&nbsp;
                      {(r.boyut_ozet || []).slice(0, 3).map((b, i) => (
                        <span key={`${b.boyut}-${i}`} style={{ marginRight: 8 }}>
                          {b.ozet || b.boyut}
                        </span>
                      ))}
                      {(r.boyut_ozet || []).length > 3 && (
                        <span style={{ color: 'var(--text3)' }}>… +{(r.boyut_ozet || []).length - 3}</span>
                      )}
                    </div>
                    {/* Zekâ özeti — denetçi kararı */}
                    {r.yorum_metni && (
                      <div style={{
                        marginTop: 6, padding: '6px 10px', borderRadius: 4,
                        background: r.alarm === 'kritik' ? 'rgba(239,68,68,0.10)'
                                  : r.alarm === 'yuksek' ? 'rgba(245,158,11,0.10)'
                                  : r.alarm === 'orta'   ? 'rgba(59,130,246,0.08)'
                                  : 'rgba(34,197,94,0.06)',
                        border: r.alarm === 'kritik' ? '1px solid rgba(239,68,68,0.30)'
                              : r.alarm === 'yuksek' ? '1px solid rgba(245,158,11,0.30)'
                              : r.alarm === 'orta'   ? '1px solid rgba(59,130,246,0.25)'
                              : '1px solid rgba(34,197,94,0.20)',
                        fontSize: 11, whiteSpace: 'pre-line', lineHeight: 1.65,
                        color: r.alarm === 'kritik' ? '#fca5a5'
                             : r.alarm === 'yuksek' ? '#fbbf24'
                             : r.alarm === 'orta'   ? '#93c5fd'
                             : '#86efac',
                      }}>
                        {r.yorum_metni}
                      </div>
                    )}
                  </div>
                ) : r.ana_tani === 'YETERSIZ_VERI' ? (
                  <span style={{ color: 'var(--text3)' }}>Veri yok (sayım veya satış kaydı eksik)</span>
                ) : r.calistirildi ? (
                  <span style={{ color: '#86efac' }}>✓ Tüm boyutlar uyumlu</span>
                ) : (
                  <span style={{ color: 'var(--text3)' }}>Bu gün için motor çalıştırılmadı</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => setDetay({ sube_id: r.sube_id, sube_ad: r.sube_ad })}
                  disabled={!r.calistirildi}
                  style={{ fontSize: 11, padding: '3px 8px' }}
                >
                  Detay
                </button>
                <button
                  className="btn btn-sm"
                  disabled={!r.motor_aktif || !durum?.global_aktif || busy === `run-${r.sube_id}`}
                  onClick={() => calistir(r.sube_id)}
                  style={{
                    fontSize: 11, padding: '3px 8px',
                    background: 'var(--accent)', borderColor: 'var(--accent)',
                  }}
                  title={!durum?.global_aktif ? 'Global flag kapalı' : !r.motor_aktif ? 'Şube motoru pasif' : 'Bu tarih için motoru çalıştır'}
                >
                  {busy === `run-${r.sube_id}` ? '…' : '▶'}
                </button>
              </div>
            </div>
          );
        })}
        {(gunluk?.subeler || []).length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            Şube yok
          </div>
        )}
      </div>

      {/* AI YORUM GEÇMİŞİ — WhatsApp günlük özetine eklenen Akıllı Denetim yorumları */}
      <AiYorumGecmisi kayitlar={aiYorumGecmisi} />

      {/* SEKMELER */}
      <div style={{
        display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.1)',
        margin: '20px 0 16px', overflowX: 'auto',
      }}>
        {[
          { id: 'genel',     label: '📋 Genel',          icon: '' },
          { id: 'vardiya',   label: '🕒 Vardiya & Personel', icon: '' },
          { id: 'tani',      label: '🧬 Akıllı Tanı',    icon: '' },
          { id: 'mali',      label: '💳 Mali Çapraz',    icon: '' },
          { id: 'gelismis',  label: '⚙️ Geçmiş & Ayar', icon: '' },
        ].map(s => (
          <button
            key={s.id}
            onClick={() => setAktifSekme(s.id)}
            style={{
              padding: '8px 14px', border: 'none', background: 'transparent',
              borderBottom: aktifSekme === s.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: aktifSekme === s.id ? 'var(--accent)' : 'var(--text2)',
              fontSize: 13, fontWeight: aktifSekme === s.id ? 700 : 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* ========== GENEL ========== */}
      {aktifSekme === 'genel' && (
        <>
          <GunlukTeyitKarti tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <OlayOzeti tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <SekmeBilgi
            icon="📋"
            baslik="Açık Görevler ve Takip"
            metin="Akıllı Denetim'in bulduğu anomaliler için açtığın görevlerin takibi. Görev aç → ata → çöz → kapat."
          />
          <AcikGorevler refreshKey={`${tarih}-${Object.keys(detay || {}).join('')}`} />
        </>
      )}

      {/* ========== VARDIYA & PERSONEL ========== */}
      {aktifSekme === 'vardiya' && (
        <>
          <SekmeBilgi
            icon="🕒"
            baslik="Vardiya Bazlı + Personel Davranış"
            metin="Sabahcı, öğlenci, kapanışçı her vardiyada kasa açığı/fazlası kime ait belli olur. Personel başına saatlik satış velocity, ortalama fiş tutarı sapması ve iskonto pattern'i analiz edilir."
          />
          <VardiyaPL tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <VardiyaBardakPNL tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <AksamBardakSisirme tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <PersonelDavranis />
          <PersonelRiskSkorlari />
        </>
      )}

      {/* ========== AKILLI TANI (Pattern + BOM + Heatmap) ========== */}
      {aktifSekme === 'tani' && (
        <>
          <SekmeBilgi
            icon="🧬"
            baslik="Akıllı Tanı — NRF pattern + BOM reçete + saat heatmap"
            metin="Yuvarlak sayı bias (zimmet işareti), kapanış telaşı, aykırı şube cluster'ı, sistemik POS sync sinyali. Ürün-bardak reçetesinden teorik tüketim ile fiziksel azalma karşılaştırılır. Saat × şube anomali yoğunluk haritası ile 'hangi saatlerde kayıt dışı satış kümeleniyor' bulunur."
          />
          <KucukTutarBirikim />
          <PatternDetect />
          <BomVaryans tarih={tarih} subeler={(durum?.subeler || []).map(s => ({ id: s.sube_id, ad: s.sube_ad }))} />
          <SaatHeatmap />
        </>
      )}

      {/* ========== MALI ÇAPRAZ ========== */}
      {aktifSekme === 'mali' && (
        <>
          <SekmeBilgi
            icon="💳"
            baslik="Mali Çapraz Kontrol"
            metin="Z raporu kart toplamı ile gerçek kart slip toplamı çapraz kontrol edilir (uyumsuz = fişsiz satış veya kayıt eksik). Gider kategorisi pattern — aynı personel sürekli aynı kategoriye girmişse şüpheli. Z'de iade var ama stok'a dönüş yok → sahte iade tespiti."
          />
          <MaliCapraz />
        </>
      )}

      {/* ========== GEÇMİŞ & AYAR (Personel Skor + Şube Ayarları + Karar Tablosu) ========== */}
      {aktifSekme === 'gelismis' && (
        <>
          <SekmeBilgi
            icon="⚙️"
            baslik="Geçmiş & Ayarlar"
            metin="3 aylık personel Z-skor (anomali bazlı), motor başına şube açma/kapama, geçmiş tüm tanılar tablosu."
          />
          <PersonelSkor />
        </>
      )}

      {/* ŞUBE KARTLARI — sadece Geçmiş & Ayar sekmesinde */}
      {aktifSekme === 'gelismis' && (
      <>
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '20px 0 8px' }}>Şube Ayarları</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, marginBottom: 24 }}>
        {(durum?.subeler || []).length === 0 && (
          <div style={{ gridColumn: '1/-1', padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
            Henüz ayar yok — Operasyon Merkezi'nden bir şubenin ID'sini alıp aşağıdaki "Yeni Şube Ayarı" ile ekleyin.
          </div>
        )}
        {(durum?.subeler || []).map((s) => (
          <div key={s.sube_id} className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>{s.sube_ad}</strong>
              <span style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 3,
                background: s.aktif ? 'rgba(34,197,94,0.15)' : 'rgba(120,120,120,0.15)',
                color: s.aktif ? '#86efac' : 'var(--text3)',
              }}>
                {s.aktif ? `aktif • ${s.mod}` : 'pasif'}
              </span>
            </div>
            <p style={{ margin: '2px 0 8px', fontSize: 10, color: 'var(--text3)' }}>
              Son çalışma: {s.son_calisma ? new Date(s.son_calisma).toLocaleString('tr-TR') : '—'}
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className="btn btn-sm"
                disabled={busy === `ayar-${s.sube_id}`}
                onClick={() => subeAyar(s.sube_id, !s.aktif, s.mod || 'read_only')}
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                {s.aktif ? 'Kapat' : 'Aç'}
              </button>
              <select
                className="input"
                value={s.mod || 'read_only'}
                disabled={busy === `ayar-${s.sube_id}` || !s.aktif}
                onChange={(e) => subeAyar(s.sube_id, s.aktif, e.target.value)}
                style={{ fontSize: 11, padding: '3px 6px' }}
              >
                <option value="read_only">read_only</option>
                <option value="apply">apply</option>
              </select>
              <button
                className="btn btn-sm"
                disabled={!s.aktif || !durum?.global_aktif || busy === `run-${s.sube_id}`}
                onClick={() => calistir(s.sube_id)}
                style={{ fontSize: 11, padding: '4px 8px', background: 'var(--accent)', borderColor: 'var(--accent)' }}
                title={!durum?.global_aktif ? 'Global flag kapalı' : !s.aktif ? 'Şube pasif' : 'Bugün için motoru çalıştır'}
              >
                {busy === `run-${s.sube_id}` ? '…' : '▶ Çalıştır'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* YENİ ŞUBE EKLE */}
      <YeniSubeAyari onEkle={subeAyar} busy={busy === 'ayar-yeni'} />

      {/* STAT KARTLAR */}
      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '24px 0 8px' }}>Karar Özeti (filtreli)</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        <StatKart label="Toplam Karar" deger={stats.toplam} />
        <StatKart label="Anomali" deger={stats.anomali} renk="#fbbf24" />
        <StatKart label="Sweethearting Sinyali" deger={stats.sweethearting} renk="#fca5a5" />
        <StatKart label="Çözülmedi (Truth Walk)" deger={stats.cozulmedi} renk="#a78bfa" />
      </div>

      {/* FİLTRE */}
      <div className="card" style={{ padding: 10, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={filtre.sadece_anomali}
            onChange={(e) => setFiltre((p) => ({ ...p, sadece_anomali: e.target.checked }))} />
          Sadece anomaliler
        </label>
        <select className="input" value={filtre.tani}
          onChange={(e) => setFiltre((p) => ({ ...p, tani: e.target.value }))}
          style={{ fontSize: 12, padding: '4px 8px' }}>
          <option value="">Tüm tanılar</option>
          {Object.keys(TANI_ETIKET).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select className="input" value={filtre.sube_id}
          onChange={(e) => setFiltre((p) => ({ ...p, sube_id: e.target.value }))}
          style={{ fontSize: 12, padding: '4px 8px' }}>
          <option value="">Tüm şubeler</option>
          {(durum?.subeler || []).map((s) => (
            <option key={s.sube_id} value={s.sube_id}>{s.sube_ad}</option>
          ))}
        </select>
      </div>

      {detay && (
        <DetayModal
          sube_id={detay.sube_id}
          sube_ad={detay.sube_ad}
          tarih={tarih}
          onKapat={() => setDetay(null)}
        />
      )}

      {/* KARARLAR TABLOSU */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
            <tr>
              <th style={th}>Tarih</th>
              <th style={th}>Şube</th>
              <th style={th}>Boyut</th>
              <th style={th}>Tanı</th>
              <th style={{ ...th, textAlign: 'right' }}>N1 (akşam)</th>
              <th style={{ ...th, textAlign: 'right' }}>N2 (sabah)</th>
              <th style={{ ...th, textAlign: 'right' }}>N3 (Evo)</th>
              <th style={{ ...th, textAlign: 'right' }}>Fark</th>
              <th style={{ ...th, textAlign: 'right' }}>Güven</th>
            </tr>
          </thead>
          <tbody>
            {kararlar.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Kayıt yok</td></tr>
            )}
            {kararlar.map((k) => {
              const e = TANI_ETIKET[k.tani] || TANI_ETIKET.YETERSIZ_VERI;
              return (
                <tr key={k.id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={td}>{k.tarih}</td>
                  <td style={td}>{k.sube_ad}</td>
                  <td style={td}>{BOYUT_ETIKET[k.boyut] || k.boyut}</td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                      background: e.bg, border: `1px solid ${e.bord}`, color: e.renk,
                    }}>
                      {e.emoji} {k.tani}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{fmt(k.n1_aksam)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{fmt(k.n2_sabah)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{fmt(k.n3_evo)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: k.fark_n1_n2 > 0 ? '#86efac' : k.fark_n1_n2 < 0 ? '#fca5a5' : 'inherit' }}>
                    {k.fark_n1_n2 != null ? (k.fark_n1_n2 > 0 ? '+' : '') + k.fark_n1_n2.toFixed(2) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>%{(k.guven_skoru || 0).toFixed(0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  AI YORUM GEÇMİŞİ — gece 00:30 WhatsApp özetine eklenen Akıllı Denetim yorumları
// ════════════════════════════════════════════════════════════════════════════

function AiYorumGecmisi({ kayitlar }) {
  const [acik, setAcik] = useState(false);
  const [secili, setSecili] = useState(null);  // tarih -> detay aç/kapa

  if (!kayitlar || kayitlar.length === 0) return null;

  const KAYNAK_ETIKET = { claude: 'Claude', openai: 'OpenAI', '': 'Özet' };

  return (
    <div className="card" style={{ padding: 0, marginBottom: 24, overflow: 'hidden' }}>
      <div
        onClick={() => setAcik(a => !a)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          🔍 Akıllı Denetim — AI Yorum Geçmişi (WhatsApp)
        </span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{kayitlar.length} kayıt</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>{acik ? '▲' : '▼'}</span>
      </div>
      {acik && (
        <div style={{ padding: '0 14px 14px', display: 'grid', gap: 8 }}>
          {kayitlar.map((k) => {
            const detayAcik = secili === k.tarih;
            return (
              <div key={k.tarih} style={{
                borderRadius: 6, background: 'rgba(59,130,246,0.06)',
                border: '1px solid rgba(59,130,246,0.20)', overflow: 'hidden',
              }}>
                <div
                  onClick={() => setSecili(s => s === k.tarih ? null : k.tarih)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                    cursor: 'pointer', flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace' }}>{k.tarih}</span>
                  <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
                    background: 'rgba(255,255,255,0.06)', color: 'var(--text3)',
                  }}>
                    {KAYNAK_ETIKET[k.kaynak || ''] || k.kaynak}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {k.yorum}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>{detayAcik ? '▲' : '▼'}</span>
                </div>
                {detayAcik && (
                  <div style={{
                    padding: '8px 10px 12px', borderTop: '1px solid rgba(59,130,246,0.20)',
                    background: 'rgba(0,0,0,0.08)', fontSize: 12, lineHeight: 1.7,
                    whiteSpace: 'pre-line', color: 'var(--text1)',
                  }}>
                    {k.yorum}
                    {Array.isArray(k.ozetler) && k.ozetler.length > 0 && (
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(255,255,255,0.10)' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Ham özet (motor)
                        </div>
                        {k.ozetler.map((o, i) => (
                          <div key={i} style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 2 }}>
                            {{ kritik: '🔴', yuksek: '🟠', orta: '🟡' }[o.alarm] || '⚪'} {o.sube}: {o.ozet}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  GÜNLÜK TEYİT + BULGU KARTI — Tüm kontroller tek bakışta, sade Türkçe
// ════════════════════════════════════════════════════════════════════════════

const TEYIT_STIL = {
  ok:     { bg: 'rgba(34,197,94,0.07)',   bord: 'rgba(34,197,94,0.25)',   renk: '#86efac' },
  uyari:  { bg: 'rgba(245,158,11,0.09)',  bord: 'rgba(245,158,11,0.35)',  renk: '#fbbf24' },
  kritik: { bg: 'rgba(239,68,68,0.11)',   bord: 'rgba(239,68,68,0.40)',   renk: '#fca5a5' },
};

// Çapraz korelasyon satırı (expandable)
function KorelasyonSatiri({ kor }) {
  const [acik, setAcik] = useState(false);
  const hasDetail = kor.anlam || (kor.nedenler && kor.nedenler.length > 0) || kor.aksiyon;

  const SEVIYE_STIL = {
    kritik: { bord: 'rgba(239,68,68,0.50)',   bg: 'rgba(239,68,68,0.08)',  renk: '#fca5a5' },
    uyari:  { bord: 'rgba(245,158,11,0.45)',  bg: 'rgba(245,158,11,0.08)', renk: '#fbbf24' },
    bilgi:  { bord: 'rgba(34,197,94,0.35)',   bg: 'rgba(34,197,94,0.06)',  renk: '#86efac' },
  };
  const ss = SEVIYE_STIL[kor.seviye] || SEVIYE_STIL.bilgi;

  return (
    <div style={{
      borderRadius: 6,
      background: ss.bg,
      borderLeft: `3px solid ${ss.bord}`,
      overflow: 'hidden',
    }}>
      {/* Ana satır */}
      <div
        onClick={() => hasDetail && setAcik(a => !a)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', cursor: hasDetail ? 'pointer' : 'default',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 13, flex: '0 0 auto' }}>{kor.ikon || '🔗'}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: ss.renk, flex: 1 }}>
          {kor.baslik}
        </span>
        {hasDetail && (
          <span style={{ fontSize: 10, color: 'var(--text3)', flex: '0 0 auto' }}>
            {acik ? '▲' : '▼'}
          </span>
        )}
      </div>

      {/* Expandable detay */}
      {acik && hasDetail && (
        <div style={{
          padding: '10px 12px 12px 36px',
          borderTop: `1px solid ${ss.bord}`,
          background: 'rgba(0,0,0,0.08)',
        }}>
          {kor.anlam && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Ne anlama geliyor?
              </div>
              <div style={{ fontSize: 12, color: 'var(--text1)', lineHeight: 1.65 }}>{kor.anlam}</div>
            </div>
          )}
          {kor.nedenler && kor.nedenler.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Olası nedenler
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: 'var(--text2)', lineHeight: 1.8 }}>
                {kor.nedenler.map((n, ni) => <li key={ni}>{n}</li>)}
              </ul>
            </div>
          )}
          {kor.aksiyon && (
            <div style={{
              marginTop: 6, padding: '6px 10px', borderRadius: 4,
              background: ss.bg, borderLeft: `2px solid ${ss.bord}`,
              fontSize: 11, color: ss.renk, fontWeight: 600,
            }}>
              ⚡ {kor.aksiyon}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Tek bir kontrol satırı (expandable)
function TeyitSatiri({ k }) {
  const [acik, setAcik] = useState(false);
  const ks = TEYIT_STIL[k.durum] || TEYIT_STIL.ok;
  const hasDetail = k.anlam || (k.nedenler && k.nedenler.length > 0) || k.aksiyon;

  return (
    <div style={{
      borderRadius: 6,
      background: k.durum === 'ok' ? 'transparent' : ks.bg,
      borderLeft: k.durum !== 'ok' ? `3px solid ${ks.bord}` : '3px solid transparent',
      overflow: 'hidden',
    }}>
      {/* Ana satır — tıklanabilir */}
      <div
        onClick={() => hasDetail && setAcik(a => !a)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px',
          cursor: hasDetail ? 'pointer' : 'default',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 13, minWidth: 18 }}>{k.ikon}</span>
        <span style={{
          fontSize: 12, fontWeight: k.durum !== 'ok' ? 700 : 500,
          color: 'var(--text1)', minWidth: 190, flex: '0 0 auto',
        }}>
          {k.ad}
        </span>
        {k.deger && (
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: k.durum !== 'ok' ? ks.renk : 'var(--text1)',
            minWidth: 48, flex: '0 0 auto',
          }}>
            {k.deger}
          </span>
        )}
        <span style={{ fontSize: 11, color: k.durum !== 'ok' ? ks.renk : 'var(--text2)', flex: 1 }}>
          {k.detay}
        </span>
        {k.personel && (
          <span style={{
            fontSize: 10, color: 'var(--text3)', padding: '1px 6px',
            borderRadius: 3, background: 'rgba(120,120,120,0.12)',
            flex: '0 0 auto',
          }}>
            {k.personel}
          </span>
        )}
        {hasDetail && (
          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4, flex: '0 0 auto' }}>
            {acik ? '▲' : '▼'}
          </span>
        )}
      </div>

      {/* Expandable detay */}
      {acik && hasDetail && (
        <div style={{
          padding: '10px 12px 12px 36px',
          borderTop: `1px solid ${ks.bord}`,
          background: 'rgba(0,0,0,0.08)',
        }}>
          {/* Ne anlama geliyor */}
          {k.anlam && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Ne anlama geliyor?
              </div>
              <div style={{ fontSize: 12, color: 'var(--text1)', lineHeight: 1.6 }}>{k.anlam}</div>
            </div>
          )}
          {/* Olası nedenler */}
          {k.nedenler && k.nedenler.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Olası nedenler
              </div>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: 'var(--text2)', lineHeight: 1.8 }}>
                {k.nedenler.map((n, ni) => <li key={ni}>{n}</li>)}
              </ul>
            </div>
          )}
          {/* Aksiyon */}
          {k.aksiyon && (
            <div style={{
              marginTop: 6, padding: '6px 10px', borderRadius: 4,
              background: k.durum === 'ok' ? 'rgba(34,197,94,0.08)' : ks.bg,
              borderLeft: `2px solid ${ks.bord}`,
              fontSize: 11, color: ks.renk, fontWeight: 600,
            }}>
              ⚡ {k.aksiyon}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GunlukTeyitKarti({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [veri, setVeri]           = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata]           = useState('');

  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const [gbYukleniyor, setGbYukleniyor] = useState(false);
  const [gbMesaj, setGbMesaj]           = useState('');

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true); setHata(''); setGbMesaj('');
    try {
      // tam-analiz: teyit + senaryo + CFO + sinyal_vektor hepsini döner
      const d = await fetchJson(`${API}/api/ops/truth/tam-analiz/${secSubeId}/${tarih}`);
      setVeri(d);
    } catch (e) {
      // fallback: eski endpoint
      try {
        const d = await fetchJson(`${API}/api/ops/truth/gunluk-teyit/${secSubeId}/${tarih}`);
        setVeri(d);
      } catch (e2) {
        setHata(String(e2.message || e2));
        setVeri(null);
      }
    } finally { setYukleniyor(false); }
  }, [secSubeId, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const geriBildirimGonder = useCallback(async (kategori, gercekSenaryo = null) => {
    if (!secSubeId || !tarih) return;
    setGbYukleniyor(true); setGbMesaj('');
    try {
      const r = await fetchJson(`${API}/api/ops/truth/geri-bildirim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sube_id: secSubeId, tarih, kategori, gercek_senaryo: gercekSenaryo }),
      });
      setGbMesaj(r?.mesaj || 'Kaydedildi ✓');
    } catch (e) {
      setGbMesaj('Hata: ' + String(e.message || e));
    } finally { setGbYukleniyor(false); }
  }, [secSubeId, tarih]);

  const genel      = veri?.genel_durum || 'ok';
  const kontroller = veri?.kontroller  || [];
  const korelasyon = veri?.korelasyon  || [];
  const ozet       = veri?.ozet        || '';
  const gecelSayi  = veri?.gecen_sayi  ?? 0;
  const toplamSayi = veri?.toplam_sayi ?? 0;
  const kritikSayi = veri?.kritik_sayi ?? 0;
  const uyariSayi  = veri?.uyari_sayi  ?? 0;
  const genelStil  = TEYIT_STIL[genel] || TEYIT_STIL.ok;

  // Senaryo + CFO verisi
  const senaryo   = veri?.senaryo   || null;
  const cfo       = veri?.cfo       || null;

  return (
    <div style={{ margin: '0 0 20px' }}>
      {/* Başlık */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>📊 Günlük Teyit Kartı</h3>
        <select className="input" value={secSubeId} onChange={e => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)', fontStyle: 'italic' }}>satıra tıkla → açıklama</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {hata && <div className="card" style={{ padding: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ {hata}</div>}
      {yukleniyor && <div className="card" style={{ padding: 14, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Kontroller yükleniyor…</div>}

      {!yukleniyor && veri && (
        <div className="card" style={{ padding: '14px 18px', borderLeft: `4px solid ${genelStil.bord}` }}>

          {/* Özet satırı */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
            paddingBottom: 10, borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 13, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
              background: genelStil.bord, color: genel === 'ok' ? '#052e16' : '#fff',
            }}>
              {genel === 'ok' ? '✅' : genel === 'kritik' ? '🚨' : '⚠️'} {gecelSayi}/{toplamSayi}
            </span>
            {kritikSayi > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#fca5a5' }}>🚨 {kritikSayi} kritik</span>}
            {uyariSayi  > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>⚠️ {uyariSayi} uyarı</span>}
            <span style={{ fontSize: 12, color: 'var(--text2)', flex: 1 }}>{ozet}</span>
          </div>

          {/* Kontrol satırları — expandable */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {kontroller.map((k, i) => <TeyitSatiri key={i} k={k} />)}
          </div>

          {/* Çapraz korelasyon bölümü */}
          {korelasyon.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                🔗 Çapraz Analiz — <span style={{ fontWeight: 400, textTransform: 'none' }}>satıra tıkla → açıklama</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {korelasyon.map((kor, ki) => <KorelasyonSatiri key={ki} kor={kor} />)}
              </div>
            </div>
          )}

          {/* Senaryo Olasılıkları */}
          {senaryo?.olasiliklar && Object.keys(senaryo.olasiliklar).length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                🧠 Senaryo Motoru — Ne Olmuş Olabilir?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {Object.entries(senaryo.olasiliklar)
                  .sort((a, b) => b[1].yuzde - a[1].yuzde)
                  .map(([key, s]) => {
                    const enYuksek = key === senaryo.en_senaryo;
                    const yuzde    = s.yuzde || 0;
                    const barRenk  = enYuksek
                      ? (yuzde >= 50 ? 'rgba(239,68,68,0.75)' : 'rgba(245,158,11,0.75)')
                      : 'rgba(100,116,139,0.35)';
                    return (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 180, fontSize: 11, color: enYuksek ? 'var(--text1)' : 'var(--text3)', fontWeight: enYuksek ? 700 : 400, flexShrink: 0 }}>
                          {enYuksek ? '▶ ' : '  '}{s.ad}
                        </div>
                        <div style={{ flex: 1, height: 10, background: 'rgba(255,255,255,0.06)', borderRadius: 5, overflow: 'hidden' }}>
                          <div style={{ width: `${yuzde}%`, height: '100%', background: barRenk, borderRadius: 5, transition: 'width 0.4s ease' }} />
                        </div>
                        <div style={{ width: 34, fontSize: 11, textAlign: 'right', color: enYuksek ? 'var(--text1)' : 'var(--text3)', fontWeight: enYuksek ? 700 : 400 }}>
                          %{yuzde}
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* CFO Anlatısı */}
          {cfo?.anlati && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                💬 CFO Analizi
              </div>
              {/* Başlık satırı (ilk satır) + gövde ayrı renklendir */}
              {(() => {
                const satirlar = (cfo.anlati || '').split('\n');
                const baslik   = satirlar[0] || '';
                const govde    = satirlar.length > 1 ? satirlar.slice(1).join('\n').trim() : '';
                return (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text1)', marginBottom: 6 }}>
                      {baslik}
                    </div>
                    {govde && (
                      <div style={{
                        fontSize: 12, color: 'var(--text2)', lineHeight: 1.65,
                        background: 'rgba(255,255,255,0.04)', borderRadius: 6,
                        padding: '10px 12px', whiteSpace: 'pre-wrap',
                      }}>
                        {govde}
                      </div>
                    )}
                  </>
                );
              })()}
              {/* Aksiyon kutusu */}
              {cfo.aksiyon && (
                <div style={{
                  marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 12,
                  background: 'rgba(245,158,11,0.10)', borderLeft: '3px solid rgba(245,158,11,0.5)',
                  color: '#fbbf24',
                }}>
                  ⚡ <strong>Aksiyon:</strong> {cfo.aksiyon}
                </div>
              )}
            </div>
          )}

          {/* Geri Bildirim Butonları */}
          {senaryo?.en_senaryo && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                📝 Bu Analizi Değerlendir
                <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: 6 }}>— Motor buradan öğrenir</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  className="btn btn-sm"
                  disabled={gbYukleniyor}
                  onClick={() => geriBildirimGonder('onaylandi', senaryo.en_senaryo)}
                  style={{ fontSize: 11, background: 'rgba(34,197,94,0.15)', borderColor: 'rgba(34,197,94,0.4)', color: '#86efac' }}
                >
                  ✅ Doğru Tespit
                </button>
                <button
                  className="btn btn-sm"
                  disabled={gbYukleniyor}
                  onClick={() => geriBildirimGonder('yanlis_alarm')}
                  style={{ fontSize: 11, background: 'rgba(100,116,139,0.15)', borderColor: 'rgba(100,116,139,0.4)', color: 'var(--text3)' }}
                >
                  ❌ Yanlış Alarm
                </button>
                <button
                  className="btn btn-sm"
                  disabled={gbYukleniyor}
                  onClick={() => geriBildirimGonder('arastirildi')}
                  style={{ fontSize: 11, background: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.4)', color: '#fbbf24' }}
                >
                  🔍 Soruşturma Başlatıldı
                </button>
                {gbYukleniyor && <span style={{ fontSize: 11, color: 'var(--text3)' }}>kaydediliyor…</span>}
                {gbMesaj && <span style={{ fontSize: 11, color: '#86efac' }}>{gbMesaj}</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════════════════════
//  OLAY ÖZETİ — Tüm sprint bulgularını tek anlatıda birleştir
// ════════════════════════════════════════════════════════════════════════════

function OlayOzeti({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true); setHata('');
    try {
      const d = await fetchJson(`${API}/api/ops/truth/olay-ozeti/${secSubeId}/${tarih}`);
      setVeri(d);
    } catch (e) {
      setHata(String(e.message || e));
      setVeri(null);
    } finally { setYukleniyor(false); }
  }, [secSubeId, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const alarm  = veri?.alarm || 'normal';
  const stil   = ALARM_STIL[alarm] || ALARM_STIL.dusuk;
  const anlatı = veri?.anlatı || '';
  const kisi   = (veri?.personeller || []).join(', ');
  const aksiyon = veri?.aksiyon || '';
  const normal = alarm === 'normal' || alarm === 'dusuk';

  // Anlatı satırlarını paragraf + bold desteğiyle render et
  const AnlatıMetni = ({ text }) => {
    if (!text) return null;
    return (
      <div style={{ fontSize: 12, lineHeight: 1.8, whiteSpace: 'pre-line', color: 'var(--text1)' }}>
        {text.split('\n').map((satir, i) => {
          // **bold** dönüşümü
          const parcalar = satir.split(/(\*\*[^*]+\*\*)/g);
          return (
            <div key={i} style={{ marginBottom: satir.trim() === '' ? 4 : 0 }}>
              {parcalar.map((p, j) =>
                p.startsWith('**') && p.endsWith('**')
                  ? <b key={j} style={{ color: alarm === 'kritik' ? '#fca5a5' : alarm === 'yuksek' ? '#fbbf24' : 'var(--text1)' }}>{p.slice(2, -2)}</b>
                  : <span key={j}>{p}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ margin: '0 0 20px' }}>
      {/* Başlık satırı */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>🧠 Olay Özeti — Ne Oldu?</h3>
        <select className="input" value={secSubeId} onChange={e => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {hata && <div className="card" style={{ padding: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ {hata}</div>}
      {yukleniyor && <div className="card" style={{ padding: 14, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Analiz ediliyor…</div>}

      {!yukleniyor && veri && (
        <div className="card" style={{
          padding: '14px 18px',
          borderLeft: `4px solid ${stil.bord}`,
          background: normal ? 'rgba(34,197,94,0.06)' : stil.bg,
        }}>
          {/* Alarm badge + kişi */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 4,
              background: stil.bord, color: normal ? '#fff' : stil.renk,
            }}>{stil.etiket}</span>
            {kisi && (
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                Şüpheli: <b style={{ color: alarm === 'kritik' ? '#fca5a5' : '#fbbf24' }}>{kisi}</b>
              </span>
            )}
          </div>

          {/* Ana anlatı */}
          <AnlatıMetni text={anlatı} />

          {/* Aksiyon */}
          {aksiyon && !normal && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 6,
              background: 'rgba(0,0,0,0.15)', borderLeft: `3px solid ${stil.bord}`,
              fontSize: 11, color: stil.renk, fontWeight: 600,
            }}>
              ⚡ Aksiyon: {aksiyon}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  SPRINT A — VARDIYA P&L + PERSONEL DAVRANIŞ SİNYALİ
// ════════════════════════════════════════════════════════════════════════════

function VardiyaPL({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [vData, setVData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  // İlk şubeyi otomatik seç
  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true); setHata('');
    try {
      const d = await fetchJson(`${API}/api/ops/truth/vardiya-pl/${secSubeId}/${tarih}`);
      setVData(d);
    } catch (e) {
      setHata(String(e.message || e));
      setVData(null);
    } finally {
      setYukleniyor(false);
    }
  }, [secSubeId, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const vardiyalar = vData?.vardiyalar || [];

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🕒 Vardiya Bazlı Kasa P&L</h3>
        <select className="input" value={secSubeId} onChange={(e) => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        {vData?.event_sayisi != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
            {vData.event_sayisi} event · {vardiyalar.length} vardiya
          </span>
        )}
      </div>

      {hata && <div className="card" style={{ padding: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ {hata}</div>}
      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Yükleniyor…</div>}

      {!yukleniyor && vardiyalar.length === 0 && (
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          {vData?.uyari || 'Vardiya verisi yok'}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {vardiyalar.map((v) => {
          const tani = v.tani || 'UYUMLU';
          const renk = tani === 'UYUMLU' ? '#86efac'
                     : tani === 'YETERSIZ_VERI' ? 'var(--text3)'
                     : tani === 'VARDIYA_KASA_FAZLA' ? '#fbbf24'
                     : '#fca5a5';
          const bg = tani === 'UYUMLU' ? 'rgba(34,197,94,0.08)'
                   : tani === 'YETERSIZ_VERI' ? 'rgba(120,120,120,0.08)'
                   : tani === 'VARDIYA_KASA_FAZLA' ? 'rgba(245,158,11,0.10)'
                   : 'rgba(220,38,38,0.10)';
          return (
            <div key={v.no} className="card" style={{
              padding: '10px 14px', background: bg, borderLeft: `4px solid ${renk}`,
              display: 'grid', gridTemplateColumns: '130px 180px 1fr 200px', gap: 12, alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>Vardiya #{v.no}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>{v.tip_dilimi} · {v.sure_dk}dk</div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{v.personel_ad || v.personel_id || '?'}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                  {v.baslangic_ts ? v.baslangic_ts.slice(11, 16) : '—'} → {v.bitis_ts ? v.bitis_ts.slice(11, 16) : '—'}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 11 }}>
                <PLCell label="Baş Kasa" deger={v.baslangic_kasa} />
                <PLCell label="Bit Kasa" deger={v.bitis_kasa} />
                <PLCell label="Evo Nakit" deger={v.evo_nakit_satis} />
                <PLCell label="Fiş" deger={v.evo_fis_sayisi} para={false} />
                <PLCell label="Gider" deger={v.giderler} />
                <PLCell label="Ara Teslim" deger={v.ara_teslim} />
                <PLCell label="Teslim" deger={v.teslim} />
                <PLCell label="Devir" deger={v.devir} />
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>Beklenen / Fark</div>
                <div style={{ fontSize: 11, fontFamily: 'monospace' }}>
                  {Number(v.beklenen_kasa || 0).toFixed(2)} ₺
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: renk, fontFamily: 'monospace' }}>
                  {v.fark_kasa != null ? (v.fark_kasa > 0 ? '+' : '') + Number(v.fark_kasa).toFixed(2) : '—'} ₺
                </div>
                <div style={{ fontSize: 10, fontWeight: 600, color: renk }}>{tani}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Personel özet */}
      {vData?.personel_ozet && Object.keys(vData.personel_ozet).length > 0 && (
        <div className="card" style={{ marginTop: 10, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>
            👥 Personel Özet (bu gün)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
            {Object.entries(vData.personel_ozet).map(([pid, po]) => {
              const fark = Number(po.kasa_fark_toplam || 0);
              const farkRenk = Math.abs(fark) < 1 ? '#86efac' : fark < 0 ? '#fca5a5' : '#fbbf24';
              return (
                <div key={pid} style={{ padding: 8, borderRadius: 4, background: 'rgba(255,255,255,0.03)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{po.ad}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    {po.vardiya_sayisi} vardiya · {po.fis_sayisi} fiş · {po.anomali_sayisi} anomali
                  </div>
                  <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: farkRenk, marginTop: 2 }}>
                    {fark > 0 ? '+' : ''}{fark.toFixed(2)} ₺
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PLCell({ label, deger, para = true }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>
        {deger == null ? '—' : (para ? Number(deger).toFixed(2) + ' ₺' : String(deger))}
      </div>
    </div>
  );
}

// ── Sprint H (C Bendi) — Akşam Vardiyası Bardak P&L ────────────────────────
function VardiyaBardakPNL({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true); setHata('');
    try {
      const d = await fetchJson(`${API}/api/ops/truth/vardiya-bardak-pnl/${secSubeId}/${tarih}`);
      setVeri(d);
    } catch (e) {
      setHata(String(e.message || e));
      setVeri(null);
    } finally { setYukleniyor(false); }
  }, [secSubeId, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const tani      = veri?.tani || null;
  const anomali   = tani === 'AKSAM_VARDIYA_BARDAK_ACIK';
  const uyumlu    = tani === 'UYUMLU';
  const renk      = anomali ? '#fca5a5' : uyumlu ? '#86efac' : 'var(--text3)';
  const bg        = anomali ? 'rgba(220,38,38,0.10)' : uyumlu ? 'rgba(34,197,94,0.08)' : 'rgba(120,120,120,0.06)';
  const border    = anomali ? 'var(--red)' : uyumlu ? 'var(--green)' : '#555';

  const BardakHucre = ({ label, fiziksel, evo, acik, anomaliFlag }) => {
    const acikRenk = acik > 0 ? (anomaliFlag ? '#fca5a5' : '#fbbf24') : '#86efac';
    return (
      <div style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 6, padding: '8px 12px', flex: 1 }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Fiziksel</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{fiziksel ?? '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Evo Tahmin</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{evo != null ? Number(evo).toFixed(0) : '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Fark</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: acik > 2 ? acikRenk : 'var(--text2)' }}>
              {acik != null ? (acik > 0 ? '+' : '') + Number(acik).toFixed(0) : '—'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ margin: '16px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>📦 Akşam Vardiyası Bardak P&L (Devir→Kapanış)</h3>
        <select className="input" value={secSubeId} onChange={(e) => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {hata && <div className="card" style={{ padding: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ {hata}</div>}
      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Yükleniyor…</div>}

      {!yukleniyor && !veri && !hata && (
        <div className="card" style={{ padding: 14, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Vardiya devir kaydı bulunamadı — bu gün sabah→akşam devir yapılmamış.
        </div>
      )}

      {!yukleniyor && veri && (
        <div className="card" style={{ padding: '12px 16px', borderLeft: `4px solid ${border}`, background: bg }}>

          {/* Başlık + tanı badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: renk }}>
              {anomali ? '🚨' : uyumlu ? '✅' : '⚪'} {tani || 'VERİ YETERSİZ'}
            </span>
            {veri.aksamci_ad && (
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                Akşamcı: <b>{veri.aksamci_ad}</b>
              </span>
            )}
            {veri.devir_ts && (
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                Devir: {String(veri.devir_ts).slice(11, 16)}
              </span>
            )}
            {veri.aksam_fis_count > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto' }}>
                {veri.aksam_fis_count} akşam fişi · %{((veri.aksam_oran || 0) * 100).toFixed(0)} gün oranı
              </span>
            )}
          </div>

          {/* Devir / Kapanis sayım satırı */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12, fontSize: 11 }}>
            {[
              { l: 'Devir Karton',    v: veri.devir_karton },
              { l: 'Devir Plastik',   v: veri.devir_plastik },
              { l: 'Kapanis Karton',  v: veri.kapanis_karton },
              { l: 'Kapanis Plastik', v: veri.kapanis_plastik },
            ].map(({ l, v }) => (
              <div key={l} style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 4, padding: '6px 8px' }}>
                <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase' }}>{l}</div>
                <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{v ?? '—'}</div>
              </div>
            ))}
          </div>

          {/* Fiziksel vs Evo analizi */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <BardakHucre
              label="Karton Bardak (14oz + 8oz)"
              fiziksel={veri.aksam_karton_kullanim}
              evo={veri.evo_aksam_karton_est}
              acik={veri.karton_acik}
              anomaliFlag={veri.karton_anomali}
            />
            <BardakHucre
              label="Plastik Bardak (Ice)"
              fiziksel={veri.aksam_plastik_kullanim}
              evo={veri.evo_aksam_plastik_est}
              acik={veri.plastik_acik}
              anomaliFlag={veri.plastik_anomali}
            />
          </div>

          {/* Detay metni */}
          {veri.detay && (
            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
              {veri.detay}
            </div>
          )}

          {/* Güven skoru */}
          <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text3)' }}>
            Güven: <b style={{ color: renk }}>{veri.guven?.toFixed(0)}%</b>
            {veri.urun_ac_karton_aksam > 0 && (
              <span style={{ marginLeft: 8 }}>
                (+{veri.urun_ac_karton_aksam?.toFixed(0)} karton stok açılımı dahil)
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonelDavranis() {
  const [gun, setGun] = useState(30);
  const [rows, setRows] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/personel-davranis?gun=${gun}`);
      setRows(d?.personeller || []);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);
  useEffect(() => { yukle(); }, [yukle]);

  if (!yukleniyor && rows.length === 0) {
    return (
      <div style={{ margin: '24px 0' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>📊 Personel Davranış Sinyali (Sprint A)</h3>
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Son {gun} günde vardiya verisi yok
        </div>
      </div>
    );
  }
  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>📊 Personel Davranış Sinyali</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={7}>Son 7 gün</option>
          <option value={14}>Son 14 gün</option>
          <option value={30}>Son 30 gün</option>
          <option value={60}>Son 60 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{rows.length} personel</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
            <tr>
              <th style={th}>Personel</th>
              <th style={th}>Seviye</th>
              <th style={{ ...th, textAlign: 'right' }}>Vardiya</th>
              <th style={{ ...th, textAlign: 'right' }}>Fiş</th>
              <th style={{ ...th, textAlign: 'right' }}>Ort. Fiş ₺</th>
              <th style={{ ...th, textAlign: 'right' }}>İskonto %</th>
              <th style={{ ...th, textAlign: 'right' }}>Ort. Kasa Fark</th>
              <th style={{ ...th, textAlign: 'right' }}>Anomali %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const sevR = r.anomali_seviye === 'kritik' ? '#fca5a5'
                         : r.anomali_seviye === 'yuksek' ? '#fbbf24' : 'var(--text3)';
              const farkR = Math.abs(r.ortalama_kasa_fark || 0) < 5 ? 'inherit'
                          : r.ortalama_kasa_fark < 0 ? '#fca5a5' : '#fbbf24';
              return (
                <tr key={r.personel_id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={td}><strong>{r.ad}</strong></td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                      background: r.anomali_seviye === 'kritik' ? 'rgba(239,68,68,0.15)'
                                : r.anomali_seviye === 'yuksek' ? 'rgba(245,158,11,0.15)'
                                : 'rgba(120,120,120,0.10)',
                      color: sevR,
                    }}>{r.anomali_seviye}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.vardiya_sayisi}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.fis_sayisi}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{Number(r.ortalama_fis_tutari || 0).toFixed(0)}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: (r.iskonto_orani_yuzde || 0) > 5 ? '#fbbf24' : 'inherit' }}>
                    {Number(r.iskonto_orani_yuzde || 0).toFixed(1)}%
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: farkR }}>
                    {(r.ortalama_kasa_fark > 0 ? '+' : '') + Number(r.ortalama_kasa_fark || 0).toFixed(2)}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: sevR }}>
                    {Number(r.anomali_oran_yuzde || 0).toFixed(0)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
        💡 <strong>Kritik</strong> = anomali oranı ≥%50 veya ort. kasa fark &gt; 50₺ ·
        <strong>Yüksek</strong> = anomali ≥%25 veya iskonto &gt; %5 ·
        Vardiya = ACILIS → KONTROL/KAPANIS arası dilim
      </p>
    </div>
  );
}

function PersonelRiskSkorlari() {
  const [gun, setGun] = useState(90);
  const [rows, setRows] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [acik, setAcik] = useState(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/personel-risk-skorlari?gun=${gun}`);
      setRows(d?.skorlar || []);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);
  useEffect(() => { yukle(); }, [yukle]);

  if (!yukleniyor && rows.length === 0) {
    return (
      <div style={{ margin: '24px 0' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>🎯 Personel Risk Skorları (Akıllı Denetim)</h3>
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Son {gun} günde sinyal yok
        </div>
      </div>
    );
  }
  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🎯 Personel Risk Skorları (Akıllı Denetim)</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={30}>Son 30 gün</option>
          <option value={60}>Son 60 gün</option>
          <option value={90}>Son 90 gün</option>
          <option value={180}>Son 180 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{rows.length} personel</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
            <tr>
              <th style={th}>Personel</th>
              <th style={{ ...th, textAlign: 'right' }}>Risk Skoru</th>
              <th style={{ ...th, textAlign: 'right' }}>Sinyal Sayısı</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const renk = r.skor >= 30 ? '#fca5a5' : r.skor >= 15 ? '#fbbf24' : 'var(--text3)';
              const acikMi = acik === r.personel_id;
              return (
                <React.Fragment key={r.personel_id}>
                  <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
                    onClick={() => setAcik(acikMi ? null : r.personel_id)}>
                    <td style={td}><strong>{r.ad_soyad}</strong></td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: renk, fontWeight: 700 }}>{r.skor}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.sinyal_sayisi}</td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--text3)' }}>{acikMi ? '▲' : '▼'}</td>
                  </tr>
                  {acikMi && (
                    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <td colSpan={4} style={{ ...td, background: 'rgba(255,255,255,0.02)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {(r.son_sinyaller || []).map((s, i) => (
                            <div key={i} style={{ display: 'flex', gap: 10, fontSize: 11, color: 'var(--text3)' }}>
                              <span style={{ minWidth: 80, fontFamily: 'monospace' }}>{s.tarih}</span>
                              <span style={{ minWidth: 80 }}>{s.sube_ad || '—'}</span>
                              <span style={{ minWidth: 140 }}>{s.sinyal_turu}</span>
                              <span style={{ minWidth: 30, fontFamily: 'monospace' }}>+{s.agirlik}</span>
                              <span>{s.aciklama}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
        💡 Truth Motor anomali tanılarından (güven ≥%65, sorumlu personel tespit edilebilenler) ve fotoğraf
        kanıt sisteminden (tekrar yüklenen fotoğraflar) üretilen sinyallerin zaman-ağırlıklı toplamı.
        Bu görünüm sadece CFO/operasyon panelindedir — personelin kendi ekranlarına eklenmemiştir.
      </p>
    </div>
  );
}

function SekmeBilgi({ icon, baslik, metin }) {
  return (
    <div style={{
      padding: '10px 14px', marginBottom: 14,
      background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)',
      borderRadius: 6, display: 'flex', gap: 12, alignItems: 'flex-start',
    }}>
      <div style={{ fontSize: 20 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd', marginBottom: 2 }}>{baslik}</div>
        <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>{metin}</div>
      </div>
    </div>
  );
}

function MaliCapraz() {
  const [gun, setGun] = useState(7);
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/mali-capraz?gun=${gun}`);
      setData(d);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);
  useEffect(() => { yukle(); }, [yukle]);

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>💳 Mali Çapraz Kontrol (Sprint D)</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={3}>Son 3 gün</option>
          <option value={7}>Son 7 gün</option>
          <option value={14}>Son 14 gün</option>
          <option value={30}>Son 30 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)' }}>Yükleniyor…</div>}

      {data && (
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Z vs Kart Slip */}
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
              🔢 Z Raporu POS ↔ Kart Slip Toplamı
              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)' }}>
                {data.z_kart_slip?.uyumsuzluk_sayisi || 0} uyumsuzluk
              </span>
            </div>
            {(data.z_kart_slip?.kayitlar || []).length === 0 && (
              <div style={{ fontSize: 11, color: '#86efac' }}>✓ Tüm günler uyumlu</div>
            )}
            {(data.z_kart_slip?.kayitlar || []).length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={th}>Tarih</th>
                    <th style={th}>Şube</th>
                    <th style={{ ...th, textAlign: 'right' }}>Z POS</th>
                    <th style={{ ...th, textAlign: 'right' }}>Slip</th>
                    <th style={{ ...th, textAlign: 'right' }}>Fark</th>
                    <th style={th}>Tanı</th>
                  </tr>
                </thead>
                <tbody>
                  {data.z_kart_slip.kayitlar.slice(0, 10).map((r, i) => (
                    <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={td}>{r.tarih}</td>
                      <td style={td}>{r.sube_id?.slice(0, 8)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.z_pos.toFixed(2)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.slip.toFixed(2)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: r.fark < 0 ? '#fca5a5' : '#fbbf24', fontWeight: 700 }}>
                        {r.fark > 0 ? '+' : ''}{r.fark.toFixed(2)}
                      </td>
                      <td style={{ ...td, fontSize: 10, color: '#fbbf24' }}>{r.tani}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Gider kategori anomalisi */}
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
              📋 Gider Kategori Anomalisi
              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)' }}>
                {(data.gider_kategori?.kayitlar || []).length} pattern
              </span>
            </div>
            {(data.gider_kategori?.kayitlar || []).length === 0 && (
              <div style={{ fontSize: 11, color: '#86efac' }}>✓ Tekrarlanan anormal pattern yok</div>
            )}
            {(data.gider_kategori?.kayitlar || []).slice(0, 10).map((r, i) => (
              <div key={i} style={{ padding: '6px 0', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none', fontSize: 11 }}>
                <strong>{r.personel_id?.slice(0, 8) || '?'}</strong> · {r.kategori} ·
                <span style={{ marginLeft: 6, color: '#fbbf24' }}>{r.adet}×</span> ·
                <span style={{ marginLeft: 6, fontFamily: 'monospace' }}>{r.tutar_top.toFixed(0)}₺</span>
                <span style={{ marginLeft: 8, fontSize: 10, color: '#fca5a5' }}>{r.sebepler.join(' · ')}</span>
              </div>
            ))}
          </div>

          {/* Sahte iade */}
          <div className="card" style={{ padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
              ↩️ Z Raporu İade Tespiti
              <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)' }}>
                {data.sahte_iade?.iade_gunleri || 0} gün
              </span>
            </div>
            {(data.sahte_iade?.kayitlar || []).length === 0 && (
              <div style={{ fontSize: 11, color: '#86efac' }}>Z raporunda iade kaydı yok</div>
            )}
            {(data.sahte_iade?.kayitlar || []).slice(0, 5).map((r, i) => (
              <div key={i} style={{ padding: '6px 0', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none', fontSize: 11 }}>
                {r.tarih} · {r.sube_id?.slice(0, 8)} ·
                <span style={{ marginLeft: 6, fontFamily: 'monospace', color: '#fbbf24' }}>-{r.iade_tutari.toFixed(2)}₺</span>
                <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text3)' }}>{r.not}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BomVaryans({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/bom-varyans/${secSubeId}/${tarih}`);
      setData(d);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [secSubeId, tarih]);
  useEffect(() => { yukle(); }, [yukle]);

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🧪 BOM Reçete Varyansı</h3>
        <select className="input" value={secSubeId} onChange={(e) => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)' }}>Yükleniyor…</div>}

      {!yukleniyor && data && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr>
                <th style={th}>Sarf Malzemesi</th>
                <th style={{ ...th, textAlign: 'right' }}>Açılış</th>
                <th style={{ ...th, textAlign: 'right' }}>Açılan Paket</th>
                <th style={{ ...th, textAlign: 'right' }}>Kapanış</th>
                <th style={{ ...th, textAlign: 'right' }}>Fiziksel Sarf</th>
                <th style={{ ...th, textAlign: 'right' }}>Teorik (Evo)</th>
                <th style={{ ...th, textAlign: 'right' }}>Varyans</th>
                <th style={th}>Durum</th>
              </tr>
            </thead>
            <tbody>
              {(data.recete_sonuclari || []).map(r => {
                const drm = r.durum;
                const renk = drm === 'uyumlu' ? '#86efac'
                           : drm === 'kayit_disi_kullanim' ? '#fca5a5'
                           : drm === 'satis_disi_olusum' ? '#fbbf24'
                           : 'var(--text3)';
                const lbl = drm === 'uyumlu' ? '✓ Uyumlu'
                          : drm === 'kayit_disi_kullanim' ? '🚨 Kayıt dışı kullanım'
                          : drm === 'satis_disi_olusum' ? '⚠️ Satışsız oluşum'
                          : '⚪ Kapanış bekleniyor';
                return (
                  <tr key={r.sarf} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={td}><strong>{r.sarf}</strong></td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.acilis}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.urun_ac}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.kapanis ?? '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                      {r.fiziksel ?? '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.teorik_evo}</td>
                    <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: renk, fontWeight: 700 }}>
                      {r.varyans == null ? '—' : (r.varyans > 0 ? '+' : '') + r.varyans}
                    </td>
                    <td style={{ ...td, color: renk }}>{lbl}</td>
                  </tr>
                );
              })}
              {(data.recete_sonuclari || []).length === 0 && (
                <tr><td colSpan={8} style={{ padding: 16, textAlign: 'center', color: 'var(--text3)' }}>
                  Evo satış verisi yok veya BOM uyumsuz
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
        💡 Teorik = Evo'da satılan ürünün BOM reçetesi ile beklenen sarf · Fiziksel = (açılış + URUN_AC − kapanış)
        · <strong>Varyans &gt; 0</strong> = kayıt dışı kullanım · <strong>Varyans &lt; 0</strong> = POS'a girip ürün vermemiş
      </p>
    </div>
  );
}

function SaatHeatmap() {
  const [gun, setGun] = useState(14);
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/saat-heatmap?gun=${gun}`);
      setData(d);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);
  useEffect(() => { yukle(); }, [yukle]);

  if (!data || Object.keys(data.matris || {}).length === 0) {
    return (
      <div style={{ margin: '24px 0' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>🔥 Saat × Şube Anomali Heatmap</h3>
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          {yukleniyor ? 'Yükleniyor…' : 'Saatlik anomali verisi yok'}
        </div>
      </div>
    );
  }

  // Maks değer (renk skala için)
  let maks = 0;
  Object.values(data.matris).forEach(saatler => {
    Object.values(saatler).forEach(v => { if (v > maks) maks = v; });
  });

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🔥 Saat × Şube Anomali Heatmap</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={7}>Son 7 gün</option>
          <option value={14}>Son 14 gün</option>
          <option value={30}>Son 30 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      <div className="card" style={{ padding: 12, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ padding: '4px 8px', textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg)' }}>Şube</th>
              {data.saatler.map(s => <th key={s} style={{ padding: '4px 6px', textAlign: 'center', minWidth: 28 }}>{s}</th>)}
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.matris).map(([sube, saatler]) => (
              <tr key={sube}>
                <td style={{ padding: '4px 8px', fontWeight: 600, position: 'sticky', left: 0, background: 'var(--bg)' }}>{sube}</td>
                {data.saatler.map(s => {
                  const v = saatler[s] || 0;
                  const ratio = maks > 0 ? v / maks : 0;
                  const bg = v === 0 ? 'rgba(255,255,255,0.02)'
                                     : `rgba(239,68,68,${0.15 + ratio * 0.55})`;
                  return (
                    <td key={s} style={{
                      padding: '4px 6px', textAlign: 'center', background: bg,
                      color: ratio > 0.5 ? '#fff' : 'inherit', fontFamily: 'monospace',
                      borderRadius: 2, minWidth: 28,
                    }}>{v || ''}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
        💡 Hücre = saatte tespit edilen anomali sayısı · Koyu kırmızı = yoğun saat (sweethearting/zimmet pattern'i orada kümeleniyor olabilir)
      </p>
    </div>
  );
}

// ── Sprint J — Cross-day Bardak Devamlılık Kontrolü (Akşamcı Bardak Şişirme) ─
function AksamBardakSisirme({ tarih, subeler }) {
  const [secSubeId, setSecSubeId] = useState('');
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  useEffect(() => {
    if (!secSubeId && subeler.length > 0) setSecSubeId(subeler[0].id);
  }, [subeler]);

  const yukle = useCallback(async () => {
    if (!secSubeId || !tarih) return;
    setYukleniyor(true); setHata('');
    try {
      const d = await fetchJson(`${API}/api/ops/truth/bardak-sisirme/${secSubeId}/${tarih}`);
      setVeri(d);
    } catch (e) {
      setHata(String(e.message || e));
      setVeri(null);
    } finally { setYukleniyor(false); }
  }, [secSubeId, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const tani    = veri?.tani || null;
  const sisirdi = tani === 'AKSAM_BARDAK_SISIRDI';
  const uyumlu  = tani === 'UYUMLU';
  const renk    = sisirdi ? '#fca5a5' : uyumlu ? '#86efac' : 'var(--text3)';
  const bg      = sisirdi ? 'rgba(220,38,38,0.10)' : uyumlu ? 'rgba(34,197,94,0.08)' : 'rgba(120,120,120,0.06)';
  const border  = sisirdi ? 'var(--red)' : uyumlu ? 'var(--green)' : '#555';

  // Sayım kutusu helper
  const SayimKutu = ({ label, dun, bugun, kaybi }) => {
    const kaybiRenk = kaybi > 3 ? '#fca5a5' : kaybi > 0 ? '#fbbf24' : '#86efac';
    return (
      <div style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 6, padding: '8px 12px', flex: 1 }}>
        <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Dün KAPANIS</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{dun ?? '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Bugün ACILIS</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{bugun ?? '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text3)' }}>Gece Kaybı</div>
            <div style={{ fontFamily: 'monospace', fontWeight: 700, color: kaybi > 3 ? kaybiRenk : 'var(--text2)' }}>
              {kaybi != null ? (kaybi > 0 ? '+' : '') + kaybi : '—'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ margin: '16px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🌙 Cross-day Bardak Devamlılık (Dün Kapanış → Bugün Açılış)</h3>
        <select className="input" value={secSubeId} onChange={e => setSecSubeId(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{tarih}</span>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {/* Açıklama */}
      <div className="card" style={{ padding: '8px 12px', marginBottom: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        🌙 <b>Gece bardak kaybolmaz.</b> Dün akşamcı KAPANIS'ta bardağı şişirdiyse sabahçı
        bugün kör sayımda gerçeği bulur. <b>Dün KAPANIS &gt; Bugün ACILIS</b> → fark = akşamcının şişirmesi.
        Cross-sinyal: Aynı gün kasa açığı da varsa → akşamcı hem kasa hem bardak şişirdi.
      </div>

      {hata && <div className="card" style={{ padding: 10, color: '#fca5a5', fontSize: 12 }}>⚠️ {hata}</div>}
      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Yükleniyor…</div>}

      {!yukleniyor && !veri && !hata && (
        <div className="card" style={{ padding: 14, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Dün KAPANIS veya bugün ACILIS verisi bulunamadı.
        </div>
      )}

      {!yukleniyor && veri && (
        <div className="card" style={{ padding: '12px 16px', borderLeft: `4px solid ${border}`, background: bg }}>

          {/* Başlık + tanı + akşamcı */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: renk }}>
              {sisirdi ? '🚨' : uyumlu ? '✅' : '⚪'} {tani || 'VERİ YETERSİZ'}
            </span>
            {veri.aksamci_ad && (
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>
                Akşamcı: <b>{veri.aksamci_ad}</b>
              </span>
            )}
            {veri.guven > 0 && (
              <span style={{ fontSize: 11, color: sisirdi ? renk : 'var(--text3)' }}>
                Güven: %{Number(veri.guven).toFixed(0)}
              </span>
            )}
            {veri.kasada_acik && (
              <span style={{ fontSize: 11, background: 'rgba(220,38,38,0.18)', color: '#fca5a5', borderRadius: 4, padding: '2px 8px', fontWeight: 600 }}>
                💰 Kasa açığı da var — çift sinyal!
              </span>
            )}
          </div>

          {/* Karton + Plastik sayım kutuları */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
            <SayimKutu
              label="Karton Bardak (Küçük+Büyük)"
              dun={veri.dun_karton}
              bugun={veri.bugun_karton}
              kaybi={veri.gece_karton_kaybi}
            />
            <SayimKutu
              label="Plastik Bardak"
              dun={veri.dun_plastik}
              bugun={veri.bugun_plastik}
              kaybi={veri.gece_plastik_kaybi}
            />
          </div>

          {/* ── İki senaryo + hakem kararı ──────────────────────────────── */}
          {sisirdi && veri.senaryo_a && veri.senaryo_b && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6 }}>
                Sistem Analizi — Kim Suçlu?
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {/* Senaryo A */}
                {[veri.senaryo_a, veri.senaryo_b].map(s => {
                  const isMuhtemel = s.muhtemel;
                  const sRenk = isMuhtemel
                    ? (s.harf === 'B' ? '#fca5a5' : '#fbbf24')
                    : 'var(--text3)';
                  const sBg = isMuhtemel
                    ? (s.harf === 'B' ? 'rgba(220,38,38,0.12)' : 'rgba(245,158,11,0.10)')
                    : 'rgba(0,0,0,0.12)';
                  const sBorder = isMuhtemel
                    ? (s.harf === 'B' ? 'var(--red)' : 'var(--orange)')
                    : '#444';
                  return (
                    <div key={s.harf} style={{
                      borderRadius: 6, padding: '10px 12px',
                      background: sBg, border: `1px solid ${sBorder}`,
                      opacity: isMuhtemel ? 1 : 0.65,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: sRenk }}>
                          Senaryo {s.harf}: {s.baslik}
                        </span>
                        {isMuhtemel && (
                          <span style={{ fontSize: 10, background: sBorder, color: '#fff', borderRadius: 3, padding: '1px 6px', fontWeight: 700 }}>
                            DAHA MUHTEMEL
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>
                        {s.aciklama}
                      </div>
                      {(s.kanitlar || []).map((k, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#86efac', marginTop: 4 }}>✓ {k}</div>
                      ))}
                      {(s.zayiflatanlar || []).map((z, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#fca5a5', marginTop: 4 }}>✗ {z}</div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* Hakem kararı */}
              {veri.karar_ozeti && (
                <div style={{
                  marginTop: 10, padding: '10px 14px', borderRadius: 6,
                  background: veri.olasi_senaryo === 'B'
                    ? 'rgba(220,38,38,0.14)'
                    : veri.olasi_senaryo === 'A'
                    ? 'rgba(245,158,11,0.10)'
                    : 'rgba(100,100,100,0.12)',
                  border: `1px solid ${veri.olasi_senaryo === 'B' ? 'var(--red)' : veri.olasi_senaryo === 'A' ? 'var(--orange)' : '#555'}`,
                  fontSize: 12, lineHeight: 1.6,
                  color: veri.olasi_senaryo === 'B' ? '#fca5a5' : veri.olasi_senaryo === 'A' ? '#fbbf24' : 'var(--text2)',
                }}>
                  {veri.karar_ozeti}
                </div>
              )}
            </div>
          )}

          {/* UYUMLU: sadece karar özeti göster */}
          {uyumlu && veri.karar_ozeti && (
            <div style={{ fontSize: 11, color: '#86efac', lineHeight: 1.5, marginBottom: 8, padding: '8px 12px', background: 'rgba(34,197,94,0.06)', borderRadius: 6 }}>
              {veri.karar_ozeti}
            </div>
          )}

          {/* Detay metni */}
          {veri.detay && (
            <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
              {veri.detay}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sprint I (D Bendi) — Küçük Tutarlı Günlük Kasa Eksilmesi ───────────────
function KucukTutarBirikim() {
  const [gun, setGun] = useState(30);
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/kucuk-tutar-birikim?gun=${gun}`);
      setVeri(d);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);

  useEffect(() => { yukle(); }, [yukle]);

  const liste = veri?.riskli_personeller || [];

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
          📉 Küçük Tutarlı Günlük Birikim (D Bendi)
        </h3>
        <select className="input" value={gun} onChange={e => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          {[14, 21, 30, 60, 90].map(g => <option key={g} value={g}>Son {g} gün</option>)}
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        {veri && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
            {veri.tespit_sayisi} riskli personel tespit edildi
          </span>
        )}
      </div>

      {/* Açıklama */}
      <div className="card" style={{ padding: '8px 12px', marginBottom: 10, fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        🔍 <b>D Bendi:</b> Her gün 10-50₺ götüren personeli tespit eder.
        Tek güne bakıldığında "tolerans farkı" gibi görünür — geçer.
        30 günde bakıldığında: aynı kişi, aynı yön, benzer miktar → sistematik.
        Kriter: Çalışılan günlerin <b>&gt;%55'inde</b> kasa farkı negatif + ortalama <b>-4₺~-80₺</b> + toplam &lt; -80₺.
      </div>

      {yukleniyor && (
        <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Yükleniyor…
        </div>
      )}

      {!yukleniyor && liste.length === 0 && (
        <div className="card" style={{ padding: 14, textAlign: 'center', color: '#86efac', fontSize: 12 }}>
          ✅ Son {gun} günde küçük tutarlı birikim tespiti yok — tüm personel normal sınırda.
        </div>
      )}

      {!yukleniyor && liste.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {liste.map((p, i) => {
            const ciddiyetRenk = p.guven >= 90 ? '#fca5a5'
                               : p.guven >= 80 ? '#fbbf24'
                               : '#fdba74';
            const ciddiyetBg  = p.guven >= 90 ? 'rgba(220,38,38,0.10)'
                               : p.guven >= 80 ? 'rgba(245,158,11,0.10)'
                               : 'rgba(249,115,22,0.08)';
            return (
              <div key={i} className="card" style={{
                padding: '12px 16px',
                borderLeft: `4px solid ${ciddiyetRenk}`,
                background: ciddiyetBg,
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 220px', gap: 12, alignItems: 'center' }}>

                  {/* Personel */}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.personel_ad || '?'}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                      {p.rol === 'sabahci' ? '🌅 Sabahçı' : '🌆 Akşamcı'}
                    </div>
                    <div style={{ fontSize: 10, color: ciddiyetRenk, fontWeight: 600, marginTop: 4 }}>
                      KUCUK_TUTAR_BIRIKIM · Güven %{p.guven?.toFixed(0)}
                    </div>
                  </div>

                  {/* İstatistikler */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 11 }}>
                    <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 4, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text3)' }}>ÇALIŞTIĞI GÜN</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{p.gun_sayisi}</div>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 4, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text3)' }}>EKSİ GÜN</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700, color: ciddiyetRenk }}>
                        {p.eksi_gun} <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(%{((p.eksi_oran || 0)*100).toFixed(0)})</span>
                      </div>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 4, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text3)' }}>GÜN ORT.</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700, color: ciddiyetRenk }}>
                        {Number(p.ort_fark || 0).toFixed(1)} ₺
                      </div>
                    </div>
                    <div style={{ background: 'rgba(0,0,0,0.12)', borderRadius: 4, padding: '6px 8px' }}>
                      <div style={{ fontSize: 9, color: 'var(--text3)' }}>ARD. SERİ</div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{p.maks_seri} gün</div>
                    </div>
                  </div>

                  {/* Toplam + Aksiyon */}
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>Kümülatif Kayıp</div>
                    <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: ciddiyetRenk }}>
                      {Number(p.toplam_fark || 0).toFixed(0)} ₺
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                      Son {gun} günde birikim
                    </div>
                  </div>
                </div>

                {/* Detay */}
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                  {p.detay}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PatternDetect() {
  const [gun, setGun] = useState(30);
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/pattern-detect?gun=${gun}`);
      setData(d);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);
  useEffect(() => { yukle(); }, [yukle]);

  if (!data && !yukleniyor) return null;
  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🧬 Pattern Detection (NRF Zekası)</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={14}>Son 14 gün</option>
          <option value={30}>Son 30 gün</option>
          <option value={60}>Son 60 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
      </div>

      {yukleniyor && <div className="card" style={{ padding: 12, textAlign: 'center', color: 'var(--text3)' }}>Yükleniyor…</div>}

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
          {/* 1. Yuvarlak sayı */}
          <PatternCard
            baslik="🎯 Yuvarlak Sayı Bias"
            anomali={data.round_number?.anomali}
            metrik={`%${data.round_number?.yuvarlak_oran_yuzde || 0}`}
            altMetrik={`${data.round_number?.yuvarlak_sayisi || 0}/${data.round_number?.toplam_kasa_fark || 0} açık yuvarlak`}
            yorum={data.round_number?.yorum}
          />
          {/* 2. End of shift */}
          <PatternCard
            baslik="🌙 Kapanış Telaşı Etkisi"
            anomali={data.end_of_shift?.anomali}
            metrik={`${data.end_of_shift?.aksam_gun_orani || 0}x`}
            altMetrik={`Akşam ort: ${data.end_of_shift?.aksam_ort_abs_fark || 0}₺ · Gün içi: ${data.end_of_shift?.gun_ici_ort_abs_fark || 0}₺`}
            yorum={data.end_of_shift?.yorum}
          />
          {/* 3. Sube cluster */}
          <PatternCard
            baslik="🏪 Şube Cluster Anomalisi"
            anomali={data.sube_cluster?.aykiri_subeler?.length > 0}
            metrik={data.sube_cluster?.aykiri_subeler?.length > 0
              ? data.sube_cluster.aykiri_subeler.join(', ')
              : 'Hepsi normal'}
            altMetrik={`Ort. anomali oranı: %${data.sube_cluster?.ort_anomali_oran || 0}`}
            yorum={data.sube_cluster?.yorum}
          />
          {/* 4. Coklu sube */}
          <PatternCard
            baslik="🌐 Çoklu Şube Korelasyonu (Bugün)"
            anomali={(data.coklu_sube?.korelasyonlar || []).length > 0}
            metrik={(data.coklu_sube?.korelasyonlar || []).length === 0 ? 'Yok' :
              `${data.coklu_sube.korelasyonlar.length} pattern`}
            altMetrik={(data.coklu_sube?.korelasyonlar || []).slice(0, 2).map(k =>
              `${k.boyut} ${k.tani} (${k.sube_sayisi} şube)`).join(' · ')}
            yorum={(data.coklu_sube?.korelasyonlar || []).length >= 1 &&
              data.coklu_sube.korelasyonlar[0].sube_sayisi >= 3
              ? '3+ şube benzer anomali — sistemik (POS/Evo) muhtemel'
              : 'Yerel (şubeye özgü) anomaliler'}
          />
        </div>
      )}

      {/* Şube cluster detay tablo */}
      {data?.sube_cluster?.subeler?.length > 0 && (
        <div className="card" style={{ marginTop: 10, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
              <tr>
                <th style={th}>Şube</th>
                <th style={{ ...th, textAlign: 'right' }}>Vardiya</th>
                <th style={{ ...th, textAlign: 'right' }}>Anomali</th>
                <th style={{ ...th, textAlign: 'right' }}>Anomali %</th>
                <th style={{ ...th, textAlign: 'right' }}>Ort. Fark</th>
                <th style={{ ...th, textAlign: 'right' }}>Z-skor</th>
              </tr>
            </thead>
            <tbody>
              {data.sube_cluster.subeler.map(s => (
                <tr key={s.ad} style={{ borderTop: '1px solid rgba(255,255,255,0.05)',
                  background: s.aykiri ? 'rgba(245,158,11,0.08)' : 'transparent' }}>
                  <td style={td}><strong>{s.ad}</strong>{s.aykiri && ' ⚠️'}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{s.vardiya || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{s.anomali || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{s.anomali_oran || 0}%</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{s.ort_fark_abs || 0}₺</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: s.aykiri ? '#fbbf24' : 'inherit' }}>
                    {s.z_skor || 0}
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

function PatternCard({ baslik, anomali, metrik, altMetrik, yorum }) {
  const renk = anomali ? '#fca5a5' : '#86efac';
  const bg = anomali ? 'rgba(220,38,38,0.10)' : 'rgba(34,197,94,0.08)';
  return (
    <div className="card" style={{ padding: 14, borderLeft: `4px solid ${renk}`, background: bg }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{baslik}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: renk, fontFamily: 'monospace' }}>{metrik}</div>
      {altMetrik && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{altMetrik}</div>}
      {yorum && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, lineHeight: 1.4 }}>{yorum}</div>}
    </div>
  );
}

function PersonelSkor() {
  const [gun, setGun] = useState(90);
  const [rows, setRows] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(false);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/personel-skor?gun=${gun}`);
      setRows(d?.kayitlar || []);
    } catch (_) {} finally { setYukleniyor(false); }
  }, [gun]);

  useEffect(() => { yukle(); }, [yukle]);

  if (!yukleniyor && rows.length === 0) {
    return (
      <div style={{ margin: '24px 0' }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px' }}>🎯 Personel Davranış Skoru</h3>
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Son {gun} günde anomali verisi yok — motor henüz yeterince çalıştırılmadı.
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>🎯 Personel Davranış Skoru</h3>
        <select className="input" value={gun} onChange={(e) => setGun(Number(e.target.value))}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value={30}>Son 30 gün</option>
          <option value={60}>Son 60 gün</option>
          <option value={90}>Son 90 gün</option>
          <option value={180}>Son 180 gün</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{rows.length} personel</span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'rgba(255,255,255,0.04)' }}>
            <tr>
              <th style={th}>Personel</th>
              <th style={{ ...th, textAlign: 'right' }}>Toplam</th>
              <th style={{ ...th, textAlign: 'right' }}>Z-skor</th>
              <th style={th}>Seviye</th>
              <th style={{ ...th, textAlign: 'right' }}>Sabah</th>
              <th style={{ ...th, textAlign: 'right' }}>Akşam</th>
              <th style={{ ...th, textAlign: 'right' }}>Sweethearting</th>
              <th style={{ ...th, textAlign: 'right' }}>Zimmet</th>
              <th style={{ ...th, textAlign: 'right' }}>Kaos</th>
              <th style={{ ...th, textAlign: 'right' }}>Şube</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sev = r.anomali_seviye === 'kritik' ? '#fca5a5'
                       : r.anomali_seviye === 'yuksek' ? '#fbbf24' : 'var(--text3)';
              return (
                <tr key={r.personel_id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={td}><strong>{r.personel_ad || r.personel_id?.slice(0, 8)}</strong></td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{r.toplam_anomali}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: sev }}>{r.z_skor?.toFixed(2)}</td>
                  <td style={{ ...td }}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                      background: r.anomali_seviye === 'kritik' ? 'rgba(239,68,68,0.15)'
                                : r.anomali_seviye === 'yuksek' ? 'rgba(245,158,11,0.15)'
                                : 'rgba(120,120,120,0.10)',
                      color: sev,
                    }}>{r.anomali_seviye}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.sabah_hata || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.aksam_hata || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: r.sweethearting > 0 ? '#fca5a5' : 'inherit' }}>{r.sweethearting || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: r.zimmet > 0 ? '#fca5a5' : 'inherit' }}>{r.zimmet || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace' }}>{r.kaos || 0}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: 'monospace', color: 'var(--text3)' }}>{r.sube_sayisi}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6 }}>
        💡 Z-skor ≥ 2.0 = istatistiksel anomali (eğitim/soruşturma adayı). SABAH_* tanıları sabahcıya, AKSAM_* akşamcıya yazılır.
        SWEETHEARTING ve ZIMMET sinyalleri her iki personele yansır.
      </p>
    </div>
  );
}

const ONCELIK_ETIKET = {
  kritik:  { renk: '#fca5a5', bg: 'rgba(239,68,68,0.15)',  bord: 'rgba(239,68,68,0.40)',  emoji: '🚨' },
  yuksek:  { renk: '#fbbf24', bg: 'rgba(245,158,11,0.15)', bord: 'rgba(245,158,11,0.35)', emoji: '⚠️' },
  orta:    { renk: '#93c5fd', bg: 'rgba(59,130,246,0.15)', bord: 'rgba(59,130,246,0.35)', emoji: '🔵' },
  dusuk:   { renk: 'var(--text3)', bg: 'rgba(120,120,120,0.10)', bord: 'rgba(120,120,120,0.30)', emoji: '⚪' },
};

const DURUM_ETIKET = {
  bekliyor:   { renk: '#fbbf24', label: 'Bekliyor' },
  inceleme:   { renk: '#93c5fd', label: 'İnceleme' },
  cozuldu:    { renk: '#86efac', label: 'Çözüldü' },
  sorusturma: { renk: '#fca5a5', label: 'Soruşturma' },
  iptal:      { renk: 'var(--text3)', label: 'İptal' },
};

function AcikGorevler({ refreshKey }) {
  const [gorevler, setGorevler] = useState([]);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [filtre, setFiltre] = useState('acik');  // acik | tum | bekliyor | inceleme | cozuldu
  const [duzenle, setDuzenle] = useState(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const q = new URLSearchParams({ limit: '100' });
      if (filtre === 'acik') q.set('sadece_acik', 'true');
      else if (['bekliyor', 'inceleme', 'cozuldu', 'sorusturma'].includes(filtre)) {
        q.set('durum', filtre); q.set('sadece_acik', 'false');
      } else q.set('sadece_acik', 'false');
      const d = await fetchJson(`${API}/api/ops/truth/iz/listele?${q.toString()}`);
      setGorevler(d?.kayitlar || []);
    } catch (e) {
      // sessiz
    } finally {
      setYukleniyor(false);
    }
  }, [filtre]);

  useEffect(() => { yukle(); }, [yukle, refreshKey]);

  return (
    <div style={{ margin: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>📋 Açık Görevler / Takip</h3>
        <select className="input" value={filtre} onChange={(e) => setFiltre(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px' }}>
          <option value="acik">Sadece açık</option>
          <option value="tum">Tümü</option>
          <option value="bekliyor">Bekliyor</option>
          <option value="inceleme">İnceleme</option>
          <option value="cozuldu">Çözüldü</option>
          <option value="sorusturma">Soruşturma</option>
        </select>
        <button className="btn btn-sm" onClick={yukle} style={{ fontSize: 11 }}>↻</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
          {gorevler.length} görev
        </span>
      </div>

      {yukleniyor && <div style={{ padding: 12, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Yükleniyor…</div>}

      {!yukleniyor && gorevler.length === 0 && (
        <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          Bu filtrede görev yok
        </div>
      )}

      <div style={{ display: 'grid', gap: 6 }}>
        {gorevler.map((g) => {
          const o = ONCELIK_ETIKET[g.oncelik] || ONCELIK_ETIKET.orta;
          const dt = DURUM_ETIKET[g.durum] || DURUM_ETIKET.bekliyor;
          const t = TANI_ETIKET[g.tani] || TANI_ETIKET.UYUMLU;
          return (
            <div key={g.id} className="card" style={{
              padding: '10px 14px',
              borderLeft: `3px solid ${o.bord}`,
              display: 'grid', gridTemplateColumns: '90px 200px 1fr auto auto', gap: 10, alignItems: 'center',
            }}>
              <span style={{
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: o.bg, color: o.renk, border: `1px solid ${o.bord}`, textAlign: 'center',
              }}>
                {o.emoji} {g.oncelik}
              </span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{g.sube_ad}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>{g.tarih} · {BOYUT_ETIKET[g.boyut] || g.boyut}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: t.renk, fontWeight: 600 }}>
                  {t.emoji} {g.tani}
                </div>
                {g.fark_n1_n2 != null && (
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'monospace' }}>
                    Fark: {g.fark_n1_n2 > 0 ? '+' : ''}{g.fark_n1_n2.toFixed(2)} ·
                    güven %{(g.guven_skoru || 0).toFixed(0)}
                  </div>
                )}
                {g.cozum_notu && (
                  <div style={{ fontSize: 10, color: 'var(--text3)', fontStyle: 'italic', marginTop: 2 }}>
                    💬 {g.cozum_notu}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11, color: dt.renk, fontWeight: 600 }}>{dt.label}</span>
              <button className="btn btn-sm" onClick={() => setDuzenle(g)} style={{ fontSize: 11, padding: '3px 10px' }}>
                Güncelle
              </button>
            </div>
          );
        })}
      </div>

      {duzenle && (
        <GorevDuzenleModal
          gorev={duzenle}
          onKapat={() => setDuzenle(null)}
          onKaydet={async () => { await yukle(); setDuzenle(null); }}
        />
      )}
    </div>
  );
}

function GorevDuzenleModal({ gorev, onKapat, onKaydet }) {
  const [durum, setDurum] = useState(gorev.durum);
  const [cozumNotu, setCozumNotu] = useState(gorev.cozum_notu || '');
  const [atananAd, setAtananAd] = useState(gorev.atanan_ad || '');
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState('');

  const kaydet = async () => {
    if (durum === 'cozuldu' && !cozumNotu.trim()) {
      setHata('Çözüm notu zorunlu');
      return;
    }
    setBusy(true); setHata('');
    try {
      await fetchJson(`${API}/api/ops/truth/iz/${gorev.id}/durum`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durum, cozum_notu: cozumNotu, atanan_ad: atananAd }),
      });
      onKaydet();
    } catch (e) {
      setHata(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) onKapat(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ width: 500, maxWidth: '95vw', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>📋 Görev Güncelle</h3>
        <p style={{ margin: '0 0 16px', fontSize: 11, color: 'var(--text3)' }}>
          {gorev.sube_ad} · {gorev.tarih} · {BOYUT_ETIKET[gorev.boyut] || gorev.boyut} ·
          {' '}{TANI_ETIKET[gorev.tani]?.emoji} {gorev.tani}
        </p>

        <label style={{ display: 'block', fontSize: 12, marginBottom: 10 }}>
          Durum
          <select className="input" value={durum} onChange={(e) => setDurum(e.target.value)}
            disabled={busy} style={{ width: '100%', marginTop: 3, padding: '6px 8px' }}>
            <option value="bekliyor">Bekliyor</option>
            <option value="inceleme">İnceleme başladı</option>
            <option value="cozuldu">Çözüldü</option>
            <option value="sorusturma">Soruşturma</option>
            <option value="iptal">İptal (yanlış alarm)</option>
          </select>
        </label>

        <label style={{ display: 'block', fontSize: 12, marginBottom: 10 }}>
          Atanan (opsiyonel)
          <input type="text" className="input" value={atananAd}
            onChange={(e) => setAtananAd(e.target.value)} disabled={busy}
            placeholder="örn. Talha T. / CFO"
            style={{ width: '100%', marginTop: 3, padding: '6px 8px' }} />
        </label>

        <label style={{ display: 'block', fontSize: 12, marginBottom: 16 }}>
          {durum === 'cozuldu' ? 'Çözüm notu (zorunlu)' : 'Not (opsiyonel)'}
          <textarea className="input" value={cozumNotu} rows={3}
            onChange={(e) => setCozumNotu(e.target.value)} disabled={busy}
            placeholder="örn. Sabahcı yeniden saydı, 3 bardak değil 6 bardak çıktı. Z raporu doğrulandı."
            style={{ width: '100%', marginTop: 3, padding: '6px 8px', resize: 'vertical' }} />
        </label>

        {hata && (
          <div style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: 6, padding: 8, marginBottom: 12, fontSize: 11, color: '#fca5a5' }}>⚠️ {hata}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <button className="btn btn-secondary" onClick={onKapat} disabled={busy}>İptal</button>
          <button className="btn btn-primary" onClick={kaydet} disabled={busy}
            style={{ background: 'var(--orange)', borderColor: 'var(--orange)' }}>
            {busy ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}

const ALARM_STIL = {
  kritik: { bg: 'rgba(239,68,68,0.12)',  bord: 'rgba(239,68,68,0.40)',  renk: '#fca5a5', etiket: '🔴 KRİTİK'    },
  yuksek: { bg: 'rgba(245,158,11,0.12)', bord: 'rgba(245,158,11,0.40)', renk: '#fbbf24', etiket: '🟠 YÜKSEK RİSK' },
  orta:   { bg: 'rgba(59,130,246,0.10)', bord: 'rgba(59,130,246,0.35)', renk: '#93c5fd', etiket: '🟡 ORTA RİSK'  },
  dusuk:  { bg: 'rgba(34,197,94,0.08)',  bord: 'rgba(34,197,94,0.30)',  renk: '#86efac', etiket: '🟢 Normal'     },
};

function DenetimRaporuKarti({ proaktifData }) {
  if (!proaktifData) return null;
  const alarm = proaktifData.proaktif_alarm || proaktifData.alarm_seviyesi || 'dusuk';
  const stil = ALARM_STIL[alarm] || ALARM_STIL.dusuk;
  const yorum = proaktifData.yorum_metni || '';
  const onlemler = proaktifData.onlemler || [];
  const kritikOnlemler = onlemler.filter(o => ['kritik','yuksek'].includes(o.aciliyet));

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 8, marginBottom: 16,
      background: stil.bg, border: `1px solid ${stil.bord}`,
    }}>
      {/* Başlık satırı */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: stil.renk }}>🧠 AI Denetim Raporu</strong>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
          background: stil.bord, color: stil.renk,
        }}>{stil.etiket}</span>
      </div>

      {/* Yorum metni — her satır ayrı paragraf */}
      {yorum && (
        <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text1)', whiteSpace: 'pre-line', marginBottom: kritikOnlemler.length ? 12 : 0 }}>
          {yorum}
        </div>
      )}

      {/* Kritik aksiyonlar kutusu */}
      {kritikOnlemler.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${stil.bord}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: stil.renk, marginBottom: 6 }}>⚡ Aksiyon Listesi</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {onlemler.map((o, i) => {
              const acs = ALARM_STIL[o.aciliyet] || ALARM_STIL.dusuk;
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
                  <span style={{ fontWeight: 700, color: acs.renk, minWidth: 52 }}>{acs.etiket.split(' ')[0]} {o.aciliyet}</span>
                  <span style={{ color: 'var(--text1)' }}>{o.aciklama}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DetayModal({ sube_id, sube_ad, tarih, onKapat, onGorevAcildi }) {
  const [kararlar, setKararlar] = useState([]);
  const [izler, setIzler] = useState({});  // karar_id → en yeni iz
  const [yukleniyor, setYukleniyor] = useState(true);
  const [gorevBusy, setGorevBusy] = useState('');
  const [walkData, setWalkData] = useState({});  // boyut → walk sonucu
  const [walkBusy, setWalkBusy] = useState('');
  const [proaktifData, setProaktifData] = useState(null);  // AI raporu

  const walkBaslat = async (boyut) => {
    setWalkBusy(boyut);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/walk/${sube_id}/${tarih}/${boyut}`);
      setWalkData(prev => ({ ...prev, [boyut]: d }));
    } catch (e) {
      setWalkData(prev => ({ ...prev, [boyut]: { hata: String(e.message || e) } }));
    } finally {
      setWalkBusy('');
    }
  };

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      // Kararlar + proaktif AI raporu paralel çek
      const [d, pr] = await Promise.allSettled([
        fetchJson(`${API}/api/ops/truth/kararlar?sube_id=${sube_id}&tarih=${tarih}&limit=20`),
        fetchJson(`${API}/api/ops/truth/proaktif/${sube_id}/${tarih}`),
      ]);
      const krs = d.status === 'fulfilled' ? (d.value?.kayitlar || []) : [];
      setKararlar(krs);
      if (pr.status === 'fulfilled' && pr.value) setProaktifData(pr.value);
      // Her karar için izleri çek
      const izMap = {};
      await Promise.all(krs.map(async (k) => {
        try {
          const ir = await fetchJson(`${API}/api/ops/truth/iz/karar/${k.id}`);
          const acik = (ir?.kayitlar || []).find((x) => !['cozuldu', 'iptal'].includes(x.durum));
          if (acik) izMap[k.id] = acik;
        } catch (_) {}
      }));
      setIzler(izMap);
    } finally {
      setYukleniyor(false);
    }
  }, [sube_id, tarih]);

  useEffect(() => { yukle(); }, [yukle]);

  const gorevAc = async (karar_id, oncelik) => {
    setGorevBusy(karar_id);
    try {
      await fetchJson(`${API}/api/ops/truth/iz/ac`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ karar_id, oncelik, acan_ad: 'CFO' }),
      });
      await yukle();
      if (onGorevAcildi) onGorevAcildi();
    } catch (e) {
      alert('Görev açılamadı: ' + (e.message || e));
    } finally {
      setGorevBusy('');
    }
  };

  // En yeni karar her boyut için
  const boyutKararlari = useMemo(() => {
    const m = {};
    for (const k of kararlar) {
      if (!m[k.boyut]) m[k.boyut] = k;
    }
    return Object.values(m);
  }, [kararlar]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onKapat(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
      <div className="card" style={{ width: 720, maxWidth: '95vw', maxHeight: '88vh', overflowY: 'auto', padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            🔍 {sube_ad} — Akıllı Denetim Detayı
          </h3>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{tarih}</span>
        </div>
        <p style={{ margin: '4px 0 18px', fontSize: 11, color: 'var(--text3)' }}>
          5 boyutta üçgenleme sonuçları + eylem önerileri (her boyut: akşam ↔ sabah ↔ Evo POS)
        </p>

        {yukleniyor && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Yükleniyor…</div>}

        {/* AI Denetim Raporu — yorum_metni + aksiyon listesi */}
        {!yukleniyor && <DenetimRaporuKarti proaktifData={proaktifData} />}

        {!yukleniyor && boyutKararlari.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>
            Bu tarih için karar yok — motoru çalıştırın
          </div>
        )}

        <div style={{ display: 'grid', gap: 10 }}>
          {boyutKararlari.map((k) => {
            const e = TANI_ETIKET[k.tani] || TANI_ETIKET.UYUMLU;
            const eylem = k.detay_json?.eylem || {};
            const iz = izler[k.id];
            const anomali = !['UYUMLU', 'YETERSIZ_VERI'].includes(k.tani);
            // Tanı türüne göre otomatik öncelik
            const oncelikOto = ['AKSAM_ZIMMET_SINYALI', 'SWEETHEARTING_SINYAL'].includes(k.tani) ? 'kritik'
                            : ['KAOS', 'SABAH_TOPYEKUN', 'AKSAM_TOPYEKUN', 'POS_BYPASS'].includes(k.tani) ? 'yuksek'
                            : anomali ? 'orta' : 'dusuk';
            return (
              <div key={k.boyut} style={{
                padding: 12, borderRadius: 6,
                background: e.bg, border: `1px solid ${e.bord}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>{BOYUT_ETIKET[k.boyut] || k.boyut}</strong>
                  <span style={{ fontSize: 11, color: e.renk, fontWeight: 600 }}>
                    {e.emoji} {k.tani} · güven %{(k.guven_skoru || 0).toFixed(0)}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8, fontSize: 11, marginBottom: 8 }}>
                  <KaynakCell label="N1 Akşamcı"     deger={k.n1_aksam} />
                  <KaynakCell label="N2 Sabahcı"     deger={k.n2_sabah} />
                  <KaynakCell
                    label="N3 Evo POS"
                    deger={k.n3_evo}
                    altLabel={k.n3_evo_ikram > 0 ? `+ ikram ${k.n3_evo_ikram.toFixed(0)}` : null}
                  />
                  <KaynakCell label="Fark (N2-N1)"   deger={k.fark_n1_n2} renk={k.fark_n1_n2 > 0 ? '#86efac' : k.fark_n1_n2 < 0 ? '#fca5a5' : ''} />
                </div>
                {k.detay_json?.capraz && (
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 6, fontStyle: 'italic' }}>
                    💡 {k.detay_json.capraz}
                  </div>
                )}
                {eylem.oto && (
                  <div style={{ display: 'flex', gap: 16, fontSize: 11, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap' }}>
                    <div><strong style={{ color: 'var(--text3)' }}>Otomatik:</strong> <code className="mono">{eylem.oto}</code></div>
                    <div><strong style={{ color: 'var(--text3)' }}>İnsan:</strong> {eylem.insan}</div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{
                        padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                        background: eylem.alarm === 'kritik' ? 'rgba(239,68,68,0.20)'
                                  : eylem.alarm === 'yuksek' ? 'rgba(245,158,11,0.20)'
                                  : eylem.alarm === 'orta'   ? 'rgba(59,130,246,0.20)'
                                  : 'rgba(120,120,120,0.15)',
                        color: eylem.alarm === 'kritik' ? '#fca5a5'
                             : eylem.alarm === 'yuksek' ? '#fbbf24'
                             : eylem.alarm === 'orta'   ? '#93c5fd'
                             : 'var(--text3)',
                      }}>alarm: {eylem.alarm || 'yok'}</span>
                      {anomali && (iz ? (
                        <span style={{
                          padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                          background: 'rgba(59,130,246,0.15)', color: '#93c5fd',
                          border: '1px solid rgba(59,130,246,0.30)',
                        }}>📋 Görev #{(iz.id || '').slice(0, 6)} · {iz.durum}</span>
                      ) : (
                        <button
                          className="btn btn-sm"
                          disabled={gorevBusy === k.id}
                          onClick={() => gorevAc(k.id, oncelikOto)}
                          style={{
                            fontSize: 10, padding: '3px 8px',
                            background: 'var(--accent)', borderColor: 'var(--accent)',
                          }}
                          title={`Bu kararı takip için aç (öncelik: ${oncelikOto})`}
                        >
                          {gorevBusy === k.id ? '…' : `📋 Görev Aç`}
                        </button>
                      ))}
                      {/* Adaptive Truth Walk butonu — anomali olan her boyutta */}
                      {anomali && (
                        <button
                          className="btn btn-sm"
                          disabled={walkBusy === k.boyut}
                          onClick={() => walkBaslat(k.boyut)}
                          style={{
                            fontSize: 10, padding: '3px 8px',
                            background: '#10b981', borderColor: '#10b981', color: '#fff', fontWeight: 600,
                          }}
                          title="Evo verisi ile matematiksel kanıt zinciri kur (akşamcı mı sabahcı mı hatalı)"
                        >
                          {walkBusy === k.boyut ? '⏳ Walk…' : '🔍 Truth Walk'}
                        </button>
                      )}
                      {/* Kasa boyutu için Operasyon Merkezi shortcut */}
                      {anomali && k.boyut === 'kasa' && (
                        <a
                          href="#ops-merkez"
                          onClick={() => {
                            try {
                              sessionStorage.setItem('ops_merkez_ac_sekme', 'kasa-uyumsuzlugu');
                            } catch (_) {}
                          }}
                          style={{
                            fontSize: 10, padding: '3px 8px',
                            background: 'var(--orange)', color: '#000', borderRadius: 4,
                            textDecoration: 'none', fontWeight: 600,
                          }}
                          title="Operasyon Merkezi'nde kaynak düzelt akışını aç"
                        >
                          ⚙ Kaynağı Düzelt →
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {/* Walk sonucu paneli */}
                {walkData[k.boyut] && (
                  <WalkSonucu data={walkData[k.boyut]} onKapat={() => setWalkData(prev => { const n = {...prev}; delete n[k.boyut]; return n; })} />
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-secondary" onClick={onKapat}>Kapat</button>
        </div>
      </div>
    </div>
  );
}

function WalkSonucu({ data, onKapat }) {
  if (data.hata) {
    return (
      <div style={{
        marginTop: 8, padding: 10, background: 'rgba(220,38,38,0.10)',
        border: '1px solid rgba(220,38,38,0.30)', borderRadius: 4, fontSize: 11,
      }}>
        ⚠️ Walk hatası: {data.hata}
        <button onClick={onKapat} style={{ marginLeft: 8, fontSize: 10 }}>Kapat</button>
      </div>
    );
  }

  const KARAR_RENK = {
    UYUMLU:                 { renk: '#86efac', bg: 'rgba(34,197,94,0.12)', label: '✅ Her şey uyumlu' },
    SABAHCI_HATALI:         { renk: '#fbbf24', bg: 'rgba(245,158,11,0.12)', label: '🌅 SABAHCI hatalı (akşamcı doğru)' },
    AKSAMCI_HATALI:         { renk: '#fbbf24', bg: 'rgba(245,158,11,0.12)', label: '🌙 AKŞAMCI hatalı (sabahcı doğru)' },
    IKISI_DE_HATALI:        { renk: '#fca5a5', bg: 'rgba(220,38,38,0.12)', label: '🌀 Her iki taraf da hatalı' },
    EVO_DESTEKLI_HIRSIZLIK: { renk: '#f87171', bg: 'rgba(239,68,68,0.15)', label: '🚨 Hırsızlık sinyali (Evo destekli)' },
    IKRAM_DESTEKLI:         { renk: '#93c5fd', bg: 'rgba(59,130,246,0.10)', label: '🎁 İkram olabilir' },
    TRUTH_WALK_COZULMEDI:   { renk: '#a78bfa', bg: 'rgba(139,92,246,0.10)', label: '🔄 Çözülmedi — 3. kişi sayım' },
  };
  const r = KARAR_RENK[data.karar] || KARAR_RENK.TRUTH_WALK_COZULMEDI;

  return (
    <div style={{
      marginTop: 10, padding: 12, background: r.bg, border: `1px solid ${r.renk}55`,
      borderRadius: 6, fontSize: 11,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <strong style={{ color: r.renk, fontSize: 12 }}>{r.label}</strong>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>güven %{Number(data.guven || 0).toFixed(0)}</span>
        <button
          onClick={onKapat}
          style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', background: 'transparent', border: '1px solid var(--text3)', color: 'var(--text2)', borderRadius: 3, cursor: 'pointer' }}>
          Kapat
        </button>
      </div>

      <div style={{ marginBottom: 8, fontSize: 11, lineHeight: 1.5 }}>{data.ozet}</div>

      {/* Kanıt zinciri */}
      <details style={{ marginBottom: 8 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 11, color: 'var(--text2)' }}>
          📐 Kanıt zinciri ({(data.kanit_zinciri || []).length} adım)
        </summary>
        <table style={{ marginTop: 6, width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <tbody>
            {(data.kanit_zinciri || []).map((k, i) => (
              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '4px 6px', color: 'var(--text2)', whiteSpace: 'nowrap' }}>{k.adim}</td>
                <td style={{ padding: '4px 6px', fontFamily: 'monospace', textAlign: 'right', fontWeight: 600 }}>
                  {typeof k.deger === 'number' ? k.deger.toFixed(2) : k.deger}
                </td>
                <td style={{ padding: '4px 6px', color: 'var(--text3)', fontSize: 9 }}>
                  {k.aciklama || k.kaynak}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {/* Öneriler */}
      {(data.oneriler || []).length > 0 && (
        <div style={{ background: 'rgba(255,255,255,0.04)', padding: 8, borderRadius: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text2)', marginBottom: 4 }}>Önerilen aksiyonlar:</div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.5 }}>
            {data.oneriler.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function KaynakCell({ label, deger, renk, altLabel }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--text3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontFamily: 'monospace', fontSize: 13, color: renk || 'inherit' }}>
        {deger == null ? '—' : (deger > 0 ? '+' : '') + Number(deger).toFixed(2)}
      </div>
      {altLabel && (
        <div style={{ fontSize: 9, color: '#93c5fd', fontFamily: 'monospace', marginTop: 1 }}>
          {altLabel}
        </div>
      )}
    </div>
  );
}

function YeniSubeAyari({ onEkle, busy }) {
  // Form artık gizli — şubeler /truth/durum endpoint'inden otomatik geliyor.
  // Bu component yine de çağrılıyor olabilir; null döndür.
  return null;
}

function StatKart({ label, deger, renk = 'var(--text)' }) {
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: renk, marginTop: 2 }}>{deger}</div>
    </div>
  );
}

const th = { padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' };
const td = { padding: '8px 10px', fontSize: 12 };

function fmt(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
