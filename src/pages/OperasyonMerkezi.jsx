import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import { computeOpsKartVurgu } from '../utils/opsVurgu';

const FILTRELER = [
  { id: 'all',     label: 'Tümü' },
  { id: 'kritik',  label: '🔴 Kritik' },
  { id: 'geciken', label: '🟠 Geciken' },
  { id: 'fark',    label: '⚠️ Fark / Uyarı' },
];

function SubeKart({ k, onDetay }) {
  const b   = k.bayraklar || {};
  const o   = k.ozet || {};
  const op  = k.operasyon || {};
  const aktif = op.aktif;
  const vurgu = computeOpsKartVurgu(k);

  // Kart rengi
  let borderColor = 'var(--border)';
  if (b.kritik)       borderColor = 'var(--red)';
  else if (b.geciken) borderColor = '#f08040';

  // Operasyon olaylarının durumu
  const tipIkon = { ACILIS: '🌅', KONTROL: '🔍', KAPANIS: '🌙', CIKIS: '🚪' };
  const allEv = op.events || [];
  const displayEv = allEv.slice(0, 5);
  const acilisEv = allEv.filter(e => e.tip === 'ACILIS');
  const digerDisplay = vurgu.mode === 'acilis'
    ? displayEv.filter(e => e.tip !== 'ACILIS')
    : displayEv;

  const uyarilar = (k.uyarilar || []).slice(0, 2);

  const eventChip = e => {
    const renk = e.durum === 'tamamlandi' ? 'var(--green)' : e.durum === 'gecikti' ? 'var(--red)' : 'var(--text3)';
    return (
      <span key={e.id} style={{ fontSize: 11, color: renk, display: 'flex', alignItems: 'center', gap: 3 }}>
        {tipIkon[e.tip] || '○'} {e.tip}
        {e.durum === 'gecikti' && op.aktif_gecikme_dk != null && e.id === aktif?.id
          ? ` (${op.aktif_gecikme_dk}dk)` : ''}
      </span>
    );
  };

  return (
    <div
      className={vurgu.mode === 'card' ? 'ops-pulse-card' : undefined}
      style={{
        background: 'var(--bg2)',
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: b.kritik ? '0 0 0 1px rgba(224,92,92,.25)' : 'none',
        cursor: 'pointer',
        transition: 'border-color .2s',
      }}
      onClick={() => onDetay(k)}
    >
      {/* Başlık */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{k.sube_adi || k.sube_id}</span>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {b.kritik   && <span className="badge badge-red">KRİTİK</span>}
          {!b.kritik && b.geciken && <span className="badge badge-yellow">Gecikme</span>}
          {b.fark_var && <span className="badge badge-yellow">Fark</span>}
        </div>
      </div>

      {/* Durum satırı */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className={`badge ${k.kasa_acik ? 'badge-green' : 'badge-gray'}`}>
          {k.kasa_acik ? 'Kasa açık' : 'Kasa kilitli'}
        </span>
        <span className={`badge ${k.sube_acik ? 'badge-green' : 'badge-gray'}`}>
          {k.sube_acik ? 'Şube açık' : 'Şube kapalı'}
        </span>
        {vurgu.mode === 'ciro_text' ? (
          <span className="badge badge-yellow ops-pulse-text-only" title="Kapanış tamam; onaylı ciro veya bekleyen taslak yok">
            Kapanış yapıldı — kanıt ciro yok
          </span>
        ) : (
          <span className={`badge ${k.ciro_girildi ? 'badge-green' : k.ciro_taslak_bekliyor ? 'badge-yellow' : 'badge-gray'}`}>
            {k.ciro_girildi ? '✓ Ciro' : k.ciro_taslak_bekliyor ? '⏳ Onayda' : 'Ciro yok'}
          </span>
        )}
      </div>

      {/* Operasyon events */}
      {displayEv.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vurgu.mode === 'acilis' && acilisEv.length > 0 && (
            <div className="ops-pulse-acilis-wrap" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text3)', width: '100%' }}>Açılış (gecikerek tamamlandı)</span>
              {acilisEv.map(eventChip)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {digerDisplay.map(eventChip)}
          </div>
        </div>
      )}

      {/* Vardiya */}
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
        Vardiya devri:{' '}
        <span style={{ color: k.vardiya_devri_tamam ? 'var(--green)' : k.vardiya_devri_basladi ? 'var(--yellow)' : 'var(--text3)' }}>
          {k.vardiya_devri_tamam ? 'Tamamlandı' : k.vardiya_devri_basladi ? 'Devam ediyor' : '—'}
        </span>
        {' · '}
        Alarm: <span style={{ color: (o.alarm_sayisi_toplam || 0) > 0 ? 'var(--yellow)' : 'var(--text3)' }}>
          {o.alarm_sayisi_toplam || 0}
        </span>
      </div>

      {/* Uyarılar */}
      {uyarilar.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {uyarilar.map((u, i) => (
            <div key={i} style={{
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: 5,
              background: u.seviye === 'kritik' ? 'rgba(224,92,92,.1)' : 'rgba(232,197,71,.1)',
              color: u.seviye === 'kritik' ? 'var(--red)' : 'var(--yellow)',
              borderLeft: `2px solid ${u.seviye === 'kritik' ? 'var(--red)' : 'var(--yellow)'}`,
            }}>
              {(u.mesaj || '').slice(0, 90)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetayModal({ kart, onKapat }) {
  if (!kart) return null;
  const b  = kart.bayraklar || {};
  const o  = kart.ozet || {};
  const op = kart.operasyon || {};

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <div className="modal-header">
          <h3>{kart.sube_adi}</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Bayraklar */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`badge ${kart.kasa_acik ? 'badge-green' : 'badge-gray'}`}>{kart.kasa_acik ? 'Kasa açık' : 'Kasa kilitli'}</span>
            <span className={`badge ${kart.sube_acik ? 'badge-green' : 'badge-gray'}`}>{kart.sube_acik ? 'Şube açık' : 'Şube kapalı'}</span>
            <span className={`badge ${kart.ciro_girildi ? 'badge-green' : kart.ciro_taslak_bekliyor ? 'badge-yellow' : 'badge-red'}`}>
              {kart.ciro_girildi ? '✓ Ciro onaylı' : kart.ciro_taslak_bekliyor ? '⏳ Ciro onayda' : '✕ Ciro yok'}
            </span>
            {b.kritik    && <span className="badge badge-red">KRİTİK</span>}
            {b.fark_var  && <span className="badge badge-yellow">Kasa farkı: {b.fark_tl?.toFixed(0)} ₺</span>}
          </div>

          {/* Operasyon events */}
          {(op.events || []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Operasyon Olayları</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {op.events.map(e => {
                  const renk = e.durum === 'tamamlandi' ? 'var(--green)' : e.durum === 'gecikti' ? 'var(--red)' : 'var(--yellow)';
                  const saat = (e.sistem_slot_ts || '').substring(11, 16);
                  return (
                    <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--bg3)', borderRadius: 6, fontSize: 13 }}>
                      <span>{e.tip} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({saat})</span></span>
                      <span style={{ color: renk, fontWeight: 500 }}>
                        {e.durum === 'tamamlandi' ? 'Tamamlandı' : e.durum === 'gecikti' ? `Gecikti${op.aktif_gecikme_dk ? ` · ${op.aktif_gecikme_dk}dk` : ''}` : 'Bekliyor'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ozet */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            {[
              ['Açılış op', o.acilis_tamam ? '✓ Tamamlandı' : o.acilis_gecikti ? '! Gecikti' : '—'],
              ['Kapanış op', o.kapanis_tamam ? '✓ Tamamlandı' : o.kapanis_gecikti ? '! Gecikti' : '—'],
              ['Kontrol bekleyen', o.kontrol_bekleyen ?? '—'],
              ['Alarm sayısı', o.alarm_sayisi_toplam ?? 0],
              ['Vardiya devri', kart.vardiya_devri_tamam ? 'Tamamlandı' : kart.vardiya_devri_basladi ? 'Devam ediyor' : '—'],
            ].map(([label, val]) => (
              <div key={label} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
                <div style={{ color: 'var(--text3)', marginBottom: 3 }}>{label}</div>
                <div style={{ fontWeight: 500 }}>{String(val)}</div>
              </div>
            ))}
          </div>

          {/* Uyarılar */}
          {(kart.uyarilar || []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Uyarılar</div>
              {kart.uyarilar.map((u, i) => (
                <div key={i} className={`alert-box ${u.seviye === 'kritik' ? 'red' : 'yellow'}`} style={{ marginBottom: 6 }}>
                  <strong>{u.seviye?.toUpperCase()}</strong> {u.mesaj}
                  {u.fark_tl != null && <span style={{ marginLeft: 6, opacity: .7 }}>Fark: {u.fark_tl?.toFixed(0)} ₺</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onKapat}>Kapat</button>
        </div>
      </div>
    </div>
  );
}

export default function OperasyonMerkezi() {
  const [filtre,    setFiltre]    = useState('all');
  const [kartlar,   setKartlar]   = useState([]);
  const [defter,    setDefter]    = useState([]);
  const [skor,      setSkor]      = useState(null);
  const [ozet,      setOzet]      = useState(null);
  const [yukleniyor,setYukleniyor]= useState(true);
  const [detay,     setDetay]     = useState(null);
  const [msg,       setMsg]       = useState(null);
  const [sonYenileme, setSonYenileme] = useState(null);

  const toast = (m, t = 'red') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 4000); };

  const yukle = useCallback(async (f = filtre) => {
    try {
      const [dash, def, sk] = await Promise.all([
        api(`/ops/dashboard?filtre=${f}`),
        api('/ops/defter?limit=60'),
        api('/ops/skor'),
      ]);
      setKartlar(dash.kartlar || []);
      setOzet(dash);
      setDefter(def.satirlar || []);
      setSkor(sk);
      setSonYenileme(new Date().toLocaleTimeString('tr-TR'));
    } catch (e) {
      toast(e.message || 'Yükleme hatası');
    } finally {
      setYukleniyor(false);
    }
  }, [filtre]);

  useEffect(() => { yukle(filtre); }, [filtre]);

  // 25 saniyede bir otomatik yenile
  useEffect(() => {
    const t = setInterval(() => yukle(filtre), 25000);
    return () => clearInterval(t);
  }, [filtre, yukle]);

  const toplamGecikme = skor?.son_30_gun?.reduce((s, r) => s + (r.gecikme_adet || 0), 0) || 0;
  const kritikSayi    = kartlar.filter(k => k.bayraklar?.kritik).length;
  const gecikSayi     = kartlar.filter(k => k.bayraklar?.geciken).length;

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header flex items-center justify-between">
        <div>
          <h2>📡 Operasyon Merkezi</h2>
          <p>
            {ozet?.tarih} · {kartlar.length} şube
            {kritikSayi > 0 && <span className="badge badge-red" style={{ marginLeft: 8 }}>{kritikSayi} kritik</span>}
            {gecikSayi  > 0 && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>{gecikSayi} gecikmiş</span>}
            {sonYenileme && <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 10 }}>Son: {sonYenileme}</span>}
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukle(filtre); }}>
          ↻ Yenile
        </button>
      </div>

      {/* Özet metrikler */}
      <div className="metrics" style={{ marginBottom: 16 }}>
        <div className="metric-card">
          <div className="metric-label">Aktif Şube</div>
          <div className="metric-value">{kartlar.filter(k => k.sube_acik).length} / {kartlar.length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Ciro Onaylı</div>
          <div className="metric-value green">{kartlar.filter(k => k.ciro_girildi).length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Ciro Onayda</div>
          <div className="metric-value yellow">{kartlar.filter(k => k.ciro_taslak_bekliyor).length}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">30g Gecikme</div>
          <div className="metric-value">{toplamGecikme}</div>
          <div className="metric-sub">{skor?.uyari_sayisi_uyari_kritik || 0} uyarı/kritik kayıt</div>
        </div>
      </div>

      {/* Filtreler */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTRELER.map(f => (
          <button
            key={f.id}
            className={`tab-pill ${filtre === f.id ? 'active' : ''}`}
            onClick={() => setFiltre(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Kartlar */}
      {yukleniyor ? (
        <div className="loading"><div className="spinner" />Yükleniyor…</div>
      ) : kartlar.length === 0 ? (
        <div className="empty">
          <div className="icon">✅</div>
          <p>Bu filtrede şube yok</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 24 }}>
          {kartlar.map(k => (
            <SubeKart key={k.sube_id} k={k} onDetay={setDetay} />
          ))}
        </div>
      )}

      {/* Operasyon defteri */}
      <div>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
          Son Defter Kayıtları
        </h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Saat</th>
                <th>Şube</th>
                <th>Etiket</th>
                <th>Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {defter.length === 0 ? (
                <tr><td colSpan={4}><div className="empty"><p>Defter kaydı yok</p></div></td></tr>
              ) : defter.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{(r.olay_ts || '').substring(11, 19)}</td>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                  <td><span className="badge badge-blue">{r.etiket || '—'}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{(r.aciklama || '').slice(0, 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 30 günlük skor tablosu */}
      {skor?.son_30_gun?.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            30 Günlük Şube Performansı
          </h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Şube</th>
                  <th style={{ textAlign: 'right' }}>Toplam Olay</th>
                  <th style={{ textAlign: 'right' }}>Tamamlanan</th>
                  <th style={{ textAlign: 'right' }}>Gecikme</th>
                  <th>Başarı Oranı</th>
                </tr>
              </thead>
              <tbody>
                {skor.son_30_gun.map(r => {
                  const oran = r.toplam_olay > 0 ? Math.round(r.tamam_adet / r.toplam_olay * 100) : 0;
                  const renk = oran >= 90 ? 'var(--green)' : oran >= 70 ? 'var(--yellow)' : 'var(--red)';
                  return (
                    <tr key={r.sube_id}>
                      <td style={{ fontWeight: 500 }}>{r.sube_adi || r.sube_id}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{r.toplam_olay}</td>
                      <td style={{ textAlign: 'right', color: 'var(--green)' }} className="mono">{r.tamam_adet}</td>
                      <td style={{ textAlign: 'right', color: r.gecikme_adet > 0 ? 'var(--red)' : 'var(--text3)' }} className="mono">{r.gecikme_adet}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="progress-bar" style={{ width: 80 }}>
                            <div style={{ height: '100%', width: `${oran}%`, background: renk, borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, color: renk }}>%{oran}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detay modal */}
      {detay && <DetayModal kart={detay} onKapat={() => setDetay(null)} />}
    </div>
  );
}
