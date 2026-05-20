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
  YETERSIZ_VERI:         { renk: 'var(--text3)', bg: 'rgba(120,120,120,0.10)', bord: 'rgba(120,120,120,0.30)', emoji: '⚪' },
};

const BOYUT_ETIKET = {
  kasa:           '💰 Kasa',
  bardak_plastik: '🥤 Plastik Bardak',
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

  useEffect(() => { durumYukle(); }, [durumYukle]);
  useEffect(() => { kararlariYukle(); }, [kararlariYukle]);
  useEffect(() => { gunlukYukle(); }, [gunlukYukle]);

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
        // Otomatik kasa baskını tetiklenmişse net bilgi
        if (r.baskin_tetik?.baslatildi) {
          mesaj += ` · 🚨 KASA BASKINI BAŞLATILDI (id: ${(r.baskin_tetik.id || '').slice(0, 8)}) — ${(r.baskin_tetik.tani || []).join(', ')}`;
        } else if (r.baskin_tetik?.oneri) {
          mesaj += ` · ⚠️ Kasa baskını ÖNERİSİ (mod=read_only, ${(r.baskin_tetik.tani || []).join(', ')})`;
        }
        setInfo(mesaj);
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
    <div style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
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
                ⚠️ Railway env: <code className="mono">EVVEL_TRUTH_MOTOR_ENABLED=1</code> ayarla
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
              display: 'grid', gridTemplateColumns: '170px 200px 1fr auto', gap: 12, alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.sube_ad}</div>
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
                  {calistirilmadi ? '⚪ Çalıştırılmadı' : `${e.emoji} ${r.ana_tani}`}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)' }}>
                {r.anomali_sayisi > 0 ? (
                  <span>
                    <strong style={{ color: '#fbbf24' }}>{r.anomali_sayisi}</strong> anomali:&nbsp;
                    {(r.boyut_ozet || []).slice(0, 3).map((b) => (
                      <span key={b.boyut} style={{ marginRight: 8 }}>
                        {BOYUT_ETIKET[b.boyut]?.split(' ')[1] || b.boyut}
                        <span style={{ color: b.fark > 0 ? '#86efac' : '#fca5a5' }}>
                          {b.fark != null ? ` ${b.fark > 0 ? '+' : ''}${b.fark.toFixed(1)}` : ''}
                        </span>
                      </span>
                    ))}
                    {(r.boyut_ozet || []).length > 3 && (
                      <span style={{ color: 'var(--text3)' }}>… +{r.boyut_ozet.length - 3}</span>
                    )}
                  </span>
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
          <SekmeBilgi
            icon="📋"
            baslik="Genel — Açık görevler ve takip"
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
          <PersonelDavranis />
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
  }, [subeler, secSubeId]);

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
  }, [subeler, secSubeId]);

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
            style={{ background: '#f59e0b', borderColor: '#f59e0b' }}>
            {busy ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetayModal({ sube_id, sube_ad, tarih, onKapat, onGorevAcildi }) {
  const [kararlar, setKararlar] = useState([]);
  const [izler, setIzler] = useState({});  // karar_id → en yeni iz
  const [yukleniyor, setYukleniyor] = useState(true);
  const [gorevBusy, setGorevBusy] = useState('');

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const d = await fetchJson(`${API}/api/ops/truth/kararlar?sube_id=${sube_id}&tarih=${tarih}&limit=20`);
      const krs = d?.kayitlar || [];
      setKararlar(krs);
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
                    </div>
                  </div>
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
  const [id, setId] = useState('');
  const [mod, setMod] = useState('read_only');
  return (
    <div className="card" style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong style={{ fontSize: 12 }}>Yeni şube ayarı:</strong>
      <input
        className="input"
        placeholder="şube ID (UUID)"
        value={id}
        onChange={(e) => setId(e.target.value)}
        style={{ fontSize: 12, padding: '4px 8px', flex: 1, minWidth: 200 }}
      />
      <select className="input" value={mod} onChange={(e) => setMod(e.target.value)} style={{ fontSize: 12 }}>
        <option value="read_only">read_only</option>
        <option value="apply">apply</option>
      </select>
      <button
        className="btn btn-sm"
        disabled={!id.trim() || busy}
        onClick={() => { onEkle(id.trim(), true, mod); setId(''); }}
        style={{ fontSize: 11, padding: '4px 10px' }}
      >
        Ekle ve Aktive Et
      </button>
    </div>
  );
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
