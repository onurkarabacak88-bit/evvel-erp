import { useState, useEffect, useCallback } from 'react';
import { api, fmt } from '../utils/api';
import { computeOpsKartVurgu } from '../utils/opsVurgu';
import { publishGlobalDataRefresh, subscribeGlobalDataRefresh } from '../utils/globalDataRefresh';

const FILTRELER = [
  { id: 'all',     label: 'Tümü' },
  { id: 'kritik',  label: '🔴 Kritik' },
  { id: 'geciken', label: '🟠 Geciken' },
  { id: 'fark',    label: '⚠️ Fark / Uyarı' },
  { id: 'guvenlik', label: '🔐 Güvenlik alarmı' },
  { id: 'stok', label: '📦 Stok / KONTROL' },
];

const UST_SEKMELER = [
  { id: 'canli', label: 'Canlı Operasyon' },
  { id: 'kontrol', label: '🔍 Kontrol' },
  { id: 'metrics', label: '📊 Metrikler' },
  { id: 'stok-kayip', label: '📉 Stok Kayıp' },
  { id: 'personel-davranis', label: '👤 Personel Davranış' },
  { id: 'fis', label: '🧾 Fiş Kontrol' },
  { id: 'onay', label: 'Onay merkezi' },
  { id: 'defter', label: 'Defter Kayıtları' },
  { id: 'sayim', label: 'Açılış Sayımları' },
  { id: 'siparis', label: '📦 Sipariş katalog' },
  { id: 'mesaj', label: '📩 Merkez Mesajı' },
  { id: 'puan', label: '⭐ Personel Puan' },
];

const ONAY_TURU_LABEL = {
  SABIT_GIDER: 'Sabit gider',
  KART_ODEME: 'Kart ödemesi',
  ANLIK_GIDER: 'Anlık gider',
  PERSONEL_MAAS: 'Personel maaşı',
  VADELI_ODEME: 'Vadeli ödeme',
  DIS_KAYNAK: 'Dış kaynak',
  CIRO: 'Ciro',
  ODEME_PLANI: 'Ödeme planı',
  KART_FAIZ: 'Kart faizi',
  BORC_TAKSIT: 'Borç taksidi',
  FATURA_ODEMESI: 'Fatura',
};

function fmtHHMM(rawTs) {
  if (!rawTs) return '—';
  const s = String(rawTs);
  const tPos = s.indexOf('T');
  if (tPos >= 0 && s.length >= tPos + 6) return s.slice(tPos + 1, tPos + 6);
  if (s.length >= 16 && s[10] === ' ') return s.slice(11, 16);
  return '—';
}

function operasyonTipOzeti(kart, tip) {
  const events = kart?.operasyon?.events || [];
  const adaylar = events.filter((e) => String(e?.tip || '').toUpperCase() === tip);
  if (!adaylar.length) return null;
  const sirali = [...adaylar].sort((a, b) => {
    const aTs = String(a?.cevap_ts || a?.sistem_slot_ts || '');
    const bTs = String(b?.cevap_ts || b?.sistem_slot_ts || '');
    return aTs.localeCompare(bTs);
  });
  const e = sirali[sirali.length - 1] || {};
  const durum = String(e?.durum || '').toLowerCase();
  const saat = fmtHHMM(e?.cevap_ts || e?.sistem_slot_ts);
  if (durum === 'tamamlandi') return { text: `${saat} ✅`, badge: 'badge-green' };
  if (durum === 'gecikti') return { text: `${saat} ⚠️`, badge: 'badge-red' };
  if (durum === 'bekliyor' || durum === 'devam' || durum === 'aktif') return { text: '⏳', badge: 'badge-yellow' };
  return { text: '—', badge: 'badge-gray' };
}

function SubeKart({ k, onDetay, personelRisk }) {
  const b   = k.bayraklar || {};
  const o   = k.ozet || {};
  const op  = k.operasyon || {};
  const aktif = op.aktif;
  const vurgu = computeOpsKartVurgu(k);
  const satisTahminToplam = Number(k.satis_tahmin_toplam || 0);

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
  const g = k.guvenlik || {};
  const ad = g.alarm_durum;

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
          {b.guvenlik_alarm && <span className="badge badge-red">Güvenlik</span>}
          {!!personelRisk?.adet && (
            <span className={`badge ${personelRisk.maxSkor >= 45 ? 'badge-red' : 'badge-yellow'}`}>
              👤 Riskli personel: {personelRisk.adet}
            </span>
          )}
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
        {(k.siparis_bekleyen || 0) > 0 && (
          <span className="badge badge-yellow">🛒 Sipariş: {k.siparis_bekleyen}</span>
        )}
        {(k.siparis_ozel_bekleyen || 0) > 0 && (
          <span className="badge badge-red">📦 Özel talep: {k.siparis_ozel_bekleyen}</span>
        )}
        {(k.anlik_gider_bekleyen || 0) > 0 && (
          <span className="badge badge-yellow">💸 Gider bekliyor: {k.anlik_gider_bekleyen}</span>
        )}
        {(k.gunluk_not_adet || 0) > 0 && (
          <span className="badge badge-gray">📝 Günlük not: {k.gunluk_not_adet}</span>
        )}
        {satisTahminToplam !== 0 && (
          <span className={`badge ${satisTahminToplam > 0 ? 'badge-yellow' : 'badge-green'}`}>
            📉 Tahmini açık: {satisTahminToplam > 0 ? '+' : ''}{fmt(satisTahminToplam)}
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

      {(g.alarm || ad) && (
        <div style={{ fontSize: 11, color: 'var(--text3)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
          {g.mesaj && <div style={{ color: b.guvenlik_alarm ? 'var(--red)' : 'var(--text3)', marginBottom: 4 }}>{g.mesaj}</div>}
          {ad && (
            <div>
              Son işlem: <strong>{ad.durum}</strong>
              {ad.islem_ts && <span className="mono" style={{ marginLeft: 6 }}>{String(ad.islem_ts).replace('T', ' ').slice(0, 19)}</span>}
              {ad.sustur_bitis_ts && (
                <span style={{ display: 'block', marginTop: 2 }}>Susturma bitiş: {String(ad.sustur_bitis_ts).replace('T', ' ').slice(0, 19)}</span>
              )}
            </div>
          )}
        </div>
      )}

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

function DetayModal({ kart, onKapat, filtre, onYenileDetay }) {
  if (!kart) return null;
  const b  = kart.bayraklar || {};
  const o  = kart.ozet || {};
  const op = kart.operasyon || {};
  const g  = kart.guvenlik || {};
  const ad = g.alarm_durum;

  const [alarmNot, setAlarmNot] = useState('');
  const [alarmPid, setAlarmPid] = useState('');
  const [susturDk, setSusturDk] = useState(120);
  const [alarmBusy, setAlarmBusy] = useState(false);

  const alarmBody = () => {
    const notu = (alarmNot || '').trim();
    const personel_id = (alarmPid || '').trim();
    return {
      ...(personel_id ? { personel_id } : {}),
      ...(notu ? { notu } : {}),
    };
  };

  const okundu = async (e) => {
    e?.stopPropagation?.();
    setAlarmBusy(true);
    try {
      await api(`/ops/guvenlik-alarmlar/${encodeURIComponent(kart.sube_id)}/okundu`, {
        method: 'POST',
        body: alarmBody(),
      });
      if (onYenileDetay) await onYenileDetay(kart.sube_id, filtre);
    } catch (err) {
      window.alert(err.message || 'İşlem başarısız');
    } finally {
      setAlarmBusy(false);
    }
  };

  const sustur = async (e) => {
    e?.stopPropagation?.();
    setAlarmBusy(true);
    try {
      await api(`/ops/guvenlik-alarmlar/${encodeURIComponent(kart.sube_id)}/sustur`, {
        method: 'POST',
        body: { ...alarmBody(), sustur_dk: Math.max(5, Math.min(1440, Number(susturDk) || 120)) },
      });
      if (onYenileDetay) await onYenileDetay(kart.sube_id, filtre);
    } catch (err) {
      window.alert(err.message || 'İşlem başarısız');
    } finally {
      setAlarmBusy(false);
    }
  };

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

          {/* Güvenlik alarmı (Faz 6–7) */}
          {(g.alarm || ad || g.mesaj) && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                Güvenlik alarmı
              </div>
              {g.mesaj && (
                <div className="alert-box red" style={{ marginBottom: 10 }}>
                  {g.mesaj}
                  {g.seviye && <span style={{ marginLeft: 8, opacity: 0.85 }}>({g.seviye})</span>}
                </div>
              )}
              {ad && (
                <div style={{ fontSize: 13, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                  <div><strong>Durum:</strong> {ad.durum}</div>
                  {ad.islem_ts && (
                    <div className="mono" style={{ marginTop: 4 }}>
                      <strong>İşlem saati:</strong> {String(ad.islem_ts).replace('T', ' ').slice(0, 19)}
                    </div>
                  )}
                  {ad.sustur_bitis_ts && (
                    <div className="mono" style={{ marginTop: 4 }}>
                      <strong>Susturma bitiş:</strong> {String(ad.sustur_bitis_ts).replace('T', ' ').slice(0, 19)}
                    </div>
                  )}
                  {ad.islem_notu && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text3)' }}>Not: {ad.islem_notu}</div>}
                  {ad.islem_personel_id && (
                    <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text3)' }}>Personel: {ad.islem_personel_id}</div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  İşlemi yapan personel ID (opsiyonel)
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 4 }}
                    value={alarmPid}
                    onChange={(e) => setAlarmPid(e.target.value)}
                    placeholder="personel uuid"
                  />
                </label>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Not (opsiyonel)
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 4 }}
                    value={alarmNot}
                    onChange={(e) => setAlarmNot(e.target.value)}
                    placeholder="Kısa açıklama"
                  />
                </label>
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Susturma süresi (dk, 5–1440)
                  <input
                    type="number"
                    className="input"
                    style={{ width: 120, marginTop: 4, display: 'block' }}
                    min={5}
                    max={1440}
                    value={susturDk}
                    onChange={(e) => setSusturDk(Number(e.target.value))}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary btn-sm" disabled={alarmBusy} onClick={okundu}>
                  Okundu
                </button>
                <button type="button" className="btn btn-sm" disabled={alarmBusy} onClick={sustur}>
                  Sustur
                </button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 10, marginBottom: 0 }}>
                Okundu: kayıt + işlem saati. Sustur: belirtilen süre boyunca alarm kartta gizlenir (bitiş saati yukarıda).
              </p>
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
  const varsayilanAy = new Date().toISOString().slice(0, 7);
  const [aktifSekme, setAktifSekme] = useState('canli');
  const [filtre,    setFiltre]    = useState('all');
  const [kartlar,   setKartlar]   = useState([]);
  const [defter,    setDefter]    = useState([]);
  const [sayimlar,  setSayimlar]  = useState([]);
  const [stokKayip, setStokKayip] = useState(null);
  const [merkezStokKart, setMerkezStokKart] = useState(null);
  const [personelDavranis, setPersonelDavranis] = useState(null);
  const [skor,      setSkor]      = useState(null);
  const [ozet,      setOzet]      = useState(null);
  const [ayFiltre,  setAyFiltre]  = useState(varsayilanAy);
  const [gunFiltre, setGunFiltre] = useState('');
  const [yukleniyor,setYukleniyor]= useState(true);
  const [detay,     setDetay]     = useState(null);
  const [msg,       setMsg]       = useState(null);
  const [sonYenileme, setSonYenileme] = useState(null);
  const [subeOnayFiltre, setSubeOnayFiltre] = useState('');
  const [bekleyenPaket, setBekleyenPaket] = useState(null);
  const [notlarListe, setNotlarListe] = useState([]);
  const [subeListeAdmin, setSubeListeAdmin] = useState([]);
  const [onayBusyId, setOnayBusyId] = useState(null);
  const [mesajListe, setMesajListe] = useState([]);
  const [mesajForm, setMesajForm] = useState({ sube_id: '', mesaj: '', oncelik: 'normal', ttl_saat: 72 });
  const [mesajBusy, setMesajBusy] = useState(false);
  const [puanListe, setPuanListe] = useState([]);
  const [puanSubeFiltre, setPuanSubeFiltre] = useState('');
  const [takipMap, setTakipMap] = useState({});
  const [riskModal, setRiskModal] = useState(null);
  const [sipOzel, setSipOzel] = useState([]);
  const [sipKat, setSipKat] = useState([]);
  const [sipSevkEksik, setSipSevkEksik] = useState([]);
  const [sipBusyId, setSipBusyId] = useState(null);
  const [sipYeniUrun, setSipYeniUrun] = useState({ kategori_kod: '', urun_adi: '' });
  const [sipYeniKat, setSipYeniKat] = useState({ ad: '', emoji: '📦' });
  const [sipSevkiyatHedef, setSipSevkiyatHedef] = useState({});
  const [mPersonelVerimlilik, setMPersonelVerimlilik] = useState(null);
  const [mSubeOperasyonKalite, setMSubeOperasyonKalite] = useState(null);
  const [mFinansOzet, setMFinansOzet] = useState(null);
  const [mStokTedarik, setMStokTedarik] = useState(null);
  const [kontrolData, setKontrolData] = useState(null);
  const [kontrolKategori, setKontrolKategori] = useState('');
  const [kontrolSadeceAlarmlar, setKontrolSadeceAlarmlar] = useState(false);
  const [fisBekleyen, setFisBekleyen] = useState([]);
  const [fisBusyId, setFisBusyId] = useState(null);

  const toast = (m, t = 'red') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 4000); };

  const yukleSiparisMerkez = useCallback(async () => {
    try {
      const [oz, cat, eksik] = await Promise.all([
        api('/ops/siparis/ozel-bekleyen'),
        api('/ops/siparis/katalog'),
        api('/ops/siparis/sevk-eksik?gun=7'),
      ]);
      setSipOzel(oz.talepler || []);
      setSipKat(cat.kategoriler || []);
      setSipSevkEksik(eksik.kayitlar || []);
    } catch (e) {
      toast(e.message || 'Sipariş verisi yüklenemedi');
    }
  }, []);

  const yukleOnayMerkez = useCallback(async () => {
    try {
      const qs = `year_month=${encodeURIComponent(ayFiltre)}`;
      const sq = subeOnayFiltre ? `&sube_id=${encodeURIComponent(subeOnayFiltre)}` : '';
      const [b, n, subeler] = await Promise.all([
        api(`/ops/bekleyen-merkez?${qs}${sq}`),
        api(`/ops/sube-notlar?${qs}${sq}&limit=200`),
        api('/subeler'),
      ]);
      setBekleyenPaket(b);
      setNotlarListe(n?.satirlar || []);
      if (Array.isArray(subeler)) {
        setSubeListeAdmin(subeler.filter((s) => s.aktif !== false));
      }
    } catch (e) {
      toast(e.message || 'Onay merkezi yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [ayFiltre, subeOnayFiltre]);

  const yukleMetrics = useCallback(async () => {
    try {
      const [pv, sk, fo, st] = await Promise.all([
        api('/ops/metrics/personel-verimlilik?gun=30').catch(() => null),
        api('/ops/metrics/sube-operasyon-kalite?gun=30').catch(() => null),
        api('/ops/metrics/finans-ozet?gun=30').catch(() => null),
        api('/ops/metrics/stok-tedarik?gun=30').catch(() => null),
      ]);
      setMPersonelVerimlilik(pv);
      setMSubeOperasyonKalite(sk);
      setMFinansOzet(fo);
      setMStokTedarik(st);
    } catch (_) {
      // her endpoint kendi catch'inde izole edildi
    } finally {
      setYukleniyor(false);
    }
  }, []);

  const yukleKontrolOzet = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (kontrolSadeceAlarmlar) params.set('sadece_alarmlar', 'true');
      if (kontrolKategori) params.set('kategori', kontrolKategori);
      const payload = await api('/ops/kontrol-ozet?' + params.toString());
      setKontrolData(payload || null);
    } catch (e) {
      toast(e.message || 'Kontrol özeti yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, [kontrolSadeceAlarmlar, kontrolKategori]);

  const yukleFisBekleyen = useCallback(async () => {
    try {
      const r = await api('/ops/gider-fis-bekleyen?gun=7');
      setFisBekleyen(r?.satirlar || []);
    } catch (e) {
      toast(e.message || 'Fiş listesi yüklenemedi');
    } finally {
      setYukleniyor(false);
    }
  }, []);

  const yukle = useCallback(async (f = filtre) => {
    try {
      const q = `year_month=${encodeURIComponent(ayFiltre)}${gunFiltre ? `&gun=${encodeURIComponent(gunFiltre)}` : ''}`;
      const calls = [api(`/ops/dashboard?filtre=${f}`)];
      if (aktifSekme === 'canli') {
        calls.push(api('/ops/skor').catch(() => null));
        calls.push(api('/ops/stok-kayip-analiz?gun=45').catch(() => null));
        calls.push(api('/ops/personel-davranis-analiz?gun=45').catch(() => null));
        calls.push(api('/ops/merkez-stok-kart').catch(() => null));
      } else if (aktifSekme === 'stok-kayip') {
        calls.push(api('/ops/stok-kayip-analiz?gun=45').catch(() => null));
      } else if (aktifSekme === 'personel-davranis') {
        calls.push(api('/ops/personel-davranis-analiz?gun=45').catch(() => null));
      } else if (aktifSekme === 'defter') {
        calls.push(api(`/ops/defter?limit=300&${q}`));
      } else if (aktifSekme === 'sayim') {
        calls.push(api(`/ops/sayimlar?limit=300&${q}`));
      } else {
        calls.push(Promise.resolve({ satirlar: [] }));
      }
      const [dash, extra, extra2, extra3, extra4] = await Promise.all(calls);
      setKartlar(dash.kartlar || []);
      setOzet(dash);
      if (aktifSekme === 'canli') {
        setSkor(extra);
        setStokKayip(extra2 || null);
        setPersonelDavranis(extra3 || null);
        setMerkezStokKart(extra4 || null);
      } else if (aktifSekme === 'stok-kayip') {
        setStokKayip(extra || null);
      } else if (aktifSekme === 'personel-davranis') {
        setPersonelDavranis(extra || null);
      } else if (aktifSekme === 'defter') {
        setDefter(extra?.satirlar || []);
      } else if (aktifSekme === 'sayim') {
        setSayimlar(extra?.satirlar || []);
      }
      setSonYenileme(new Date().toLocaleTimeString('tr-TR'));
      return dash;
    } catch (e) {
      toast(e.message || 'Yükleme hatası');
      return null;
    } finally {
      setYukleniyor(false);
    }
  }, [filtre, aktifSekme, ayFiltre, gunFiltre]);

  const yenileDetayKart = useCallback(
    async (subeId, f = filtre) => {
      const dash = await yukle(f);
      const guncel = (dash?.kartlar || []).find((k) => k.sube_id === subeId);
      if (guncel) setDetay(guncel);
      else setDetay(null);
    },
    [yukle, filtre],
  );

  useEffect(() => {
    if (aktifSekme === 'onay' || aktifSekme === 'metrics' || aktifSekme === 'kontrol') return;
    yukle(filtre);
  }, [filtre, aktifSekme, ayFiltre, gunFiltre, yukle]);

  useEffect(() => {
    if (aktifSekme !== 'onay') return;
    setYukleniyor(true);
    yukleOnayMerkez();
  }, [aktifSekme, ayFiltre, subeOnayFiltre, yukleOnayMerkez]);

  useEffect(() => {
    if (aktifSekme !== 'mesaj') return;
    api('/ops/merkez-mesajlar?limit=100')
      .then(r => setMesajListe(r.satirlar || []))
      .catch(() => {});
  }, [aktifSekme]);

  useEffect(() => {
    if (aktifSekme !== 'puan') return;
    const q = puanSubeFiltre ? `?sube_id=${encodeURIComponent(puanSubeFiltre)}&gun=30` : '?gun=30';
    api(`/ops/sube-personel-puan${q}`)
      .then(r => setPuanListe(r.personeller || []))
      .catch(() => {});
    api('/ops/personel-takip')
      .then(r => {
        const m = {};
        (r?.satirlar || []).forEach((t) => { if (t?.personel_id) m[t.personel_id] = t; });
        setTakipMap(m);
      })
      .catch(() => {});
  }, [aktifSekme, puanSubeFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'siparis') return;
    yukleSiparisMerkez();
  }, [aktifSekme, yukleSiparisMerkez]);

  useEffect(() => {
    if (aktifSekme !== 'metrics') return;
    setYukleniyor(true);
    yukleMetrics();
  }, [aktifSekme, yukleMetrics]);

  useEffect(() => {
    if (aktifSekme !== 'kontrol') return;
    setYukleniyor(true);
    yukleKontrolOzet();
  }, [aktifSekme, yukleKontrolOzet]);

  useEffect(() => {
    if (aktifSekme !== 'fis') return;
    setYukleniyor(true);
    yukleFisBekleyen();
  }, [aktifSekme, yukleFisBekleyen]);

  useEffect(() => {
    const unsub = subscribeGlobalDataRefresh(() => {
      if (aktifSekme === 'onay') {
        setYukleniyor(true);
        yukleOnayMerkez();
      } else if (aktifSekme === 'metrics') {
        setYukleniyor(true);
        yukleMetrics();
      } else if (aktifSekme === 'kontrol') {
        setYukleniyor(true);
        yukleKontrolOzet();
      } else if (aktifSekme === 'fis') {
        setYukleniyor(true);
        yukleFisBekleyen();
      } else {
        yukle(filtre);
      }
    });
    return unsub;
  }, [aktifSekme, filtre, yukle, yukleOnayMerkez, yukleMetrics, yukleKontrolOzet, yukleFisBekleyen]);

  // 30 saniyede bir otomatik yenile
  useEffect(() => {
    if (aktifSekme === 'onay') return undefined;
    if (aktifSekme === 'metrics') {
      const t = setInterval(() => yukleMetrics(), 30000);
      return () => clearInterval(t);
    }
    if (aktifSekme === 'kontrol') {
      const t = setInterval(() => yukleKontrolOzet(), 30000);
      return () => clearInterval(t);
    }
    if (aktifSekme === 'fis') {
      const t = setInterval(() => yukleFisBekleyen(), 30000);
      return () => clearInterval(t);
    }
    const t = setInterval(() => yukle(filtre), 30000);
    return () => clearInterval(t);
  }, [filtre, yukle, aktifSekme, yukleMetrics, yukleKontrolOzet, yukleFisBekleyen]);

  const toplamGecikme = skor?.son_30_gun?.reduce((s, r) => s + (r.gecikme_adet || 0), 0) || 0;
  const kritikSayi    = kartlar.filter(k => k.bayraklar?.kritik).length;
  const gecikSayi     = kartlar.filter(k => k.bayraklar?.geciken).length;
  const guvenlikSayi  = kartlar.filter(k => k.bayraklar?.guvenlik_alarm).length;
  const karsilastirmaKartlar = [...kartlar].sort((a, b) => String(a?.sube_adi || '').localeCompare(String(b?.sube_adi || ''), 'tr'));
  const riskliPersonelSubeMap = (personelDavranis?.surekli_riskli_personel || []).reduce((acc, p) => {
    const sid = p?.sube_id || '';
    if (!sid) return acc;
    if (!acc[sid]) acc[sid] = { adet: 0, maxSkor: 0 };
    acc[sid].adet += 1;
    const rs = Number(p?.davranis_risk_skoru || 0);
    if (rs > acc[sid].maxSkor) acc[sid].maxSkor = rs;
    return acc;
  }, {});

  async function ciroTaslakOnayla(tid) {
    setOnayBusyId(`c:${tid}`);
    try {
      await api(`/ciro-taslak/${encodeURIComponent(tid)}/onayla`, { method: 'POST', body: {} });
      toast('Ciro taslağı onaylandı; kasa ve ciro girişine işlendi.', 'green');
      publishGlobalDataRefresh('ops-onay-ciro');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Onay başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function ciroTaslakReddet(tid) {
    const neden = window.prompt('Red nedeni (boş bırakılabilir):');
    if (neden === null) return;
    setOnayBusyId(`cr:${tid}`);
    try {
      await api(`/ciro-taslak/${encodeURIComponent(tid)}/reddet`, {
        method: 'POST',
        body: { neden: (neden || '').trim() || 'Reddedildi' },
      });
      toast('Ciro taslağı reddedildi.', 'green');
      publishGlobalDataRefresh('ops-onay-ciro-reddet');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Red başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kuyrukOnayla(oid) {
    setOnayBusyId(`o:${oid}`);
    try {
      await api(`/onay-kuyrugu/${encodeURIComponent(oid)}/onayla`, { method: 'POST' });
      toast('Kuyruk kaydı onaylandı.', 'green');
      publishGlobalDataRefresh('ops-onay-kuyruk');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Onay başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kuyrukReddet(oid) {
    setOnayBusyId(`or:${oid}`);
    try {
      await api(`/onay-kuyrugu/${encodeURIComponent(oid)}/reddet`, {
        method: 'POST',
        body: { neden: 'hata' },
      });
      toast('Kuyruk kaydı reddedildi.', 'green');
      publishGlobalDataRefresh('ops-onay-kuyruk-reddet');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Red başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function kasaUyumsuzlukCoz(uid) {
    const neden = window.prompt('Çözüm notu (opsiyonel):') ?? '';
    setOnayBusyId(`ku:${uid}`);
    try {
      await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uid)}/coz`, {
        method: 'POST',
        body: { notu: (neden || '').trim() },
      });
      toast('Kasa uyumsuzluk kaydı çözüldü olarak işaretlendi.', 'green');
      publishGlobalDataRefresh('ops-kasa-uyumsuzluk-cozuldu');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Kayıt çözülemedi');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function siparisSevkiyataGonder(talepId) {
    const hedef = (sipSevkiyatHedef?.[talepId] || '').trim();
    if (!hedef) {
      toast('Önce sevkiyat şubesi seçin');
      return;
    }
    setOnayBusyId(`sg:${talepId}`);
    try {
      await api('/ops/siparis/sevkiyata-gonder', {
        method: 'POST',
        body: { talep_id: talepId, hedef_depo_sube_id: hedef },
      });
      toast('Sipariş sevkiyat şubesine gönderildi.', 'green');
      publishGlobalDataRefresh('ops-siparis-sevkiyata-gonder');
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Sevkiyata gönderme başarısız');
    } finally {
      setOnayBusyId(null);
    }
  }

  async function fisKontrolIsle(giderId, durum) {
    const notu = window.prompt('Not (opsiyonel):') ?? '';
    setFisBusyId(`${durum}:${giderId}`);
    try {
      await api('/ops/gider-fis-kontrol', { method: 'POST', body: { gider_id: giderId, durum, notu: (notu || '').trim() || null } });
      toast('Fiş kontrol kaydedildi.', 'green');
      await yukleFisBekleyen();
    } catch (e) {
      toast(e.message || 'İşlem başarısız');
    } finally {
      setFisBusyId(null);
    }
  }

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
            {guvenlikSayi > 0 && <span className="badge badge-red" style={{ marginLeft: 6 }}>{guvenlikSayi} güvenlik</span>}
            {sonYenileme && <span style={{ color: 'var(--text3)', fontSize: 11, marginLeft: 10 }}>Son: {sonYenileme}</span>}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            setYukleniyor(true);
            if (aktifSekme === 'onay') yukleOnayMerkez();
            else if (aktifSekme === 'metrics') yukleMetrics();
            else if (aktifSekme === 'kontrol') yukleKontrolOzet();
            else yukle(filtre);
          }}
        >
          ↻ Yenile
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {UST_SEKMELER.map(s => (
          <button
            key={s.id}
            className={`tab-pill ${aktifSekme === s.id ? 'active' : ''}`}
            onClick={() => { setYukleniyor(true); setAktifSekme(s.id); }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {(aktifSekme === 'defter' || aktifSekme === 'sayim') && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ay</span>
            <input type="month" value={ayFiltre} onChange={(e) => { setYukleniyor(true); setAyFiltre(e.target.value || varsayilanAy); }} />
          </label>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün (opsiyonel)</span>
            <input type="date" value={gunFiltre} onChange={(e) => { setYukleniyor(true); setGunFiltre(e.target.value || ''); }} />
          </label>
        </div>
      )}

      {aktifSekme === 'onay' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Ay</span>
            <input type="month" value={ayFiltre} onChange={(e) => { setYukleniyor(true); setAyFiltre(e.target.value || varsayilanAy); }} />
          </label>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube (opsiyonel)</span>
            <select
              className="input"
              style={{ minWidth: 200, padding: '8px 10px' }}
              value={subeOnayFiltre}
              onChange={(e) => { setYukleniyor(true); setSubeOnayFiltre(e.target.value); }}
            >
              <option value="">Tüm şubeler</option>
              {subeListeAdmin.map((s) => (
                <option key={s.id} value={s.id}>{s.ad || s.id}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => { setYukleniyor(true); yukleOnayMerkez(); }}>
            ↻ Yenile
          </button>
        </div>
      )}

      {aktifSekme === 'kontrol' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{ margin: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Kategori</span>
            <select
              className="input"
              style={{ minWidth: 210, padding: '8px 10px' }}
              value={kontrolKategori}
              onChange={(e) => { setYukleniyor(true); setKontrolKategori(e.target.value); }}
            >
              <option value="">Tümü</option>
              <option value="KASA">Kasa</option>
              <option value="CIRO">Ciro</option>
              <option value="ZAMAN">Zaman</option>
              <option value="STOK">Stok</option>
              <option value="GIDER">Gider</option>
              <option value="GUVENLIK">Güvenlik</option>
            </select>
          </label>
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', alignSelf: 'flex-end', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={kontrolSadeceAlarmlar}
              onChange={(e) => { setYukleniyor(true); setKontrolSadeceAlarmlar(e.target.checked); }}
            />
            Sadece alarmlar
          </label>
        </div>
      )}

      {aktifSekme === 'fis' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setYukleniyor(true); yukleFisBekleyen(); }}>
            ↻ Yenile
          </button>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Fiş gönderilmedi işaretlenen giderler (kontrol bekliyor)
          </span>
        </div>
      )}

      {aktifSekme === 'canli' && (
        <>
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
            <div className="metric-card">
              <div className="metric-label">Tahmini Satış</div>
              <div className="metric-value green">{ozet?.satis_tahmin_toplam || 0}</div>
              <div className="metric-sub">Kapanış formülü: teorik - gerçek</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Şubeler arası canlı karşılaştırma</h3>
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Şube</th>
                    <th>Açılış</th>
                    <th>Kontrol</th>
                    <th>Kapanış</th>
                    <th>Vardiya devri</th>
                    <th>Ciro</th>
                    <th>Not</th>
                  </tr>
                </thead>
                <tbody>
                  {karsilastirmaKartlar.map((k) => {
                    const acilisDurum = operasyonTipOzeti(k, 'ACILIS') || { text: '—', badge: 'badge-gray' };
                    const kontrolDurum = operasyonTipOzeti(k, 'KONTROL');
                    const kapanisDurum = operasyonTipOzeti(k, 'KAPANIS');
                    const vardiyaDurum = k?.vardiya_devri_tamam
                      ? { text: 'Tamamlandı', badge: 'badge-green' }
                      : k?.vardiya_devri_basladi
                        ? { text: 'Devam ediyor', badge: 'badge-yellow' }
                        : { text: '—', badge: 'badge-gray' };
                    const gecikme = Number(k?.kontrol_gecikme_dk || 0);
                    const kontrolCell = kontrolDurum
                      ? (gecikme > 0
                        ? { text: `⚠️ ${gecikme} dk geç`, badge: gecikme >= 30 ? 'badge-red' : 'badge-yellow' }
                        : kontrolDurum)
                      : { text: '⏳', badge: 'badge-yellow' };
                    const kapanisCell = kapanisDurum || { text: '⏳', badge: 'badge-yellow' };
                    const ciro = Number(k?.bugun_ciro_tutar || 0);
                    const notAdet = Number(k?.gunluk_not_adet || 0);
                    return (
                      <tr
                        key={`cmp-${k.sube_id}`}
                        onClick={() => setDetay(k)}
                        style={{ cursor: 'pointer' }}
                        title="Detay için tıkla"
                      >
                        <td style={{ fontWeight: 500, fontSize: 13 }}>{k.sube_adi || k.sube_id || '—'}</td>
                        <td><span className={`badge ${acilisDurum.badge}`}>{acilisDurum.text}</span></td>
                        <td><span className={`badge ${kontrolCell.badge}`}>{kontrolCell.text}</span></td>
                        <td><span className={`badge ${kapanisCell.badge}`}>{kapanisCell.text}</span></td>
                        <td><span className={`badge ${vardiyaDurum.badge}`}>{vardiyaDurum.text}</span></td>
                        <td className="mono">{fmt(ciro)}</td>
                        <td className="mono">{notAdet}</td>
                      </tr>
                    );
                  })}
                  {karsilastirmaKartlar.length === 0 && (
                    <tr><td colSpan={7}><div className="empty"><p>Karşılaştırma için şube verisi yok</p></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!!merkezStokKart && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Merkez stok kartı</h3>
              <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                Sipariş + sevk + son kapanış kalanları birleştirilerek hesaplanır.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <span className="badge badge-gray">Sipariş: {fmt(merkezStokKart?.ozet?.siparis_toplam || 0)}</span>
                <span className="badge badge-blue">Sevk: {fmt(merkezStokKart?.ozet?.sevk_toplam || 0)}</span>
                <span className="badge badge-yellow">Kullanılan: {fmt(merkezStokKart?.ozet?.kullanilan_toplam || 0)}</span>
                <span className="badge badge-green">Kalan: {fmt(merkezStokKart?.ozet?.kalan_toplam || 0)}</span>
              </div>
              <div className="table-wrap" style={{ margin: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Kalem</th>
                      <th>Sipariş</th>
                      <th>Sevk</th>
                      <th>Kullanılan</th>
                      <th>Kalan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(merkezStokKart?.satirlar || []).map((r) => (
                      <tr key={r.kalem_kodu}>
                        <td>{r.kalem_adi || r.kalem_kodu}</td>
                        <td className="mono">{fmt(r.siparis_adet || 0)}</td>
                        <td className="mono">{fmt(r.sevk_adet || 0)}</td>
                        <td className="mono">{fmt(r.kullanilan_adet || 0)}</td>
                        <td className="mono">{fmt(r.kalan_adet || 0)}</td>
                      </tr>
                    ))}
                    {(merkezStokKart?.satirlar || []).length === 0 && (
                      <tr><td colSpan={5}><div className="empty"><p>Merkez stok kartı verisi yok</p></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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

          {!!stokKayip && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Stok kayıp tahmini (son {stokKayip.gun_sayi || 45} gün)</h3>
              <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                Formül: Açılış + (Ürün Ekle + Ürün Aç) - Kapanış. Sürekli açık veren personeller ve şubeler aşağıda özetlenir.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Sürekli açık veren personel</div>
                  {(stokKayip.surekli_acik_personel || []).slice(0, 6).map((p, i) => (
                    <div key={`${p.personel_id || p.personel_ad}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0' }}>
                      <span>{p.personel_ad || p.personel_id || '—'} <span style={{ color: 'var(--text3)' }}>({p.sube_adi || p.sube_id || '—'})</span></span>
                      <strong style={{ color: 'var(--yellow)' }}>+{p.toplam_acik}</strong>
                    </div>
                  ))}
                  {(stokKayip.surekli_acik_personel || []).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>Belirgin sürekli açık yok.</div>
                  )}
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Şube bazlı toplam açık</div>
                  {(stokKayip.sube_ozet || []).slice(0, 6).map((s, i) => (
                    <div key={`${s.sube_id}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '4px 0' }}>
                      <span>{s.sube_adi || s.sube_id} <span style={{ color: 'var(--text3)' }}>({s.acik_gun_sayisi} gün)</span></span>
                      <strong style={{ color: 'var(--yellow)' }}>+{s.toplam_acik}</strong>
                    </div>
                  ))}
                  {(stokKayip.sube_ozet || []).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>Şube açık verisi yok.</div>
                  )}
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Haftalık tekrar paterni</div>
                  {(stokKayip.haftalik_pattern || []).slice(0, 6).map((w, i) => (
                    <div key={`${w.sube_id}-${w.urun}-${w.hafta_gun}-${i}`} style={{ fontSize: 12, padding: '4px 0' }}>
                      <strong>{w.sube_adi || w.sube_id}</strong> · {w.urun_ad} · {w.hafta_gun}
                      <span style={{ color: 'var(--yellow)', marginLeft: 6 }}>~{w.ortalama_acik}</span>
                    </div>
                  ))}
                  {(stokKayip.haftalik_pattern || []).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>Patern verisi yok.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {!!personelDavranis && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
                Personel açılış davranışı (son {personelDavranis.gun_sayi || 45} gün)
              </h3>
              <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                Kasa farkı, bardak düşük başlatma ve vardiya devrini adım-1'de bırakma metrikleriyle risk skoru.
              </p>
              <div className="table-wrap" style={{ margin: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Personel</th>
                      <th>Şube</th>
                      <th>Açılış</th>
                      <th>Kasa fark</th>
                      <th>Bardak düşük</th>
                      <th>Vardiya eksik</th>
                      <th>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(personelDavranis.personel_ozet || []).slice(0, 10).map((p, i) => (
                      <tr key={`${p.personel_id || p.personel_ad}-${i}`}>
                        <td>{p.personel_ad || p.personel_id || '—'}</td>
                        <td>{p.sube_adi || p.sube_id || '—'}</td>
                        <td className="mono">{p.acilis_sayisi || 0}</td>
                        <td className="mono">{p.acilis_kasa_fark_adet || 0} / {p.acilis_kasa_fark_toplam || 0}</td>
                        <td className="mono">{p.bardak_dusuk_adet || 0} / {p.bardak_dusuk_toplam || 0}</td>
                        <td className="mono">{p.vardiya_eksik_adet || 0}</td>
                        <td>
                          <span className={`badge ${Number(p.davranis_risk_skoru || 0) >= 35 ? 'badge-red' : Number(p.davranis_risk_skoru || 0) >= 20 ? 'badge-yellow' : 'badge-gray'}`}>
                            {p.davranis_risk_skoru || 0}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {(personelDavranis.personel_ozet || []).length === 0 && (
                      <tr><td colSpan={7}><div className="empty"><p>Davranış analizi için yeterli veri yok</p></div></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {(personelDavranis.surekli_riskli_personel || []).length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--yellow)' }}>
                  Sürekli açık veren takip listesi: {(personelDavranis.surekli_riskli_personel || []).slice(0, 5).map((p) => p.personel_ad || p.personel_id).join(', ')}
                </div>
              )}
            </div>
          )}

          {yukleniyor ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : kartlar.length === 0 ? (
            <div className="empty">
              <div className="icon">✅</div>
              <p>Bu filtrede şube yok</p>
            </div>
          ) : null}
        </>
      )}

      {aktifSekme === 'metrics' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 12 }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Personel verimlilik</h3>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Açılış sapma ort.: <strong>{Number(mPersonelVerimlilik?.acilis_sapma_ort_dk || 0).toFixed(2)} dk</strong><br />
              Kontrol cevap ort.: <strong>{Number(mPersonelVerimlilik?.kontrol_cevap_ort_dk || 0).toFixed(2)} dk</strong><br />
              Kasa fark frekansı: <strong>{Number(mPersonelVerimlilik?.kasa_fark_frekans || 0).toFixed(2)}%</strong>
            </div>
          </div>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Şube operasyon kalite</h3>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Vardiya eksik oranı: <strong>{Number(mSubeOperasyonKalite?.vardiya_eksik_oran || 0).toFixed(2)}%</strong><br />
              Not/gün ort.: <strong>{Number(mSubeOperasyonKalite?.not_gonderim_gunluk_ort || 0).toFixed(2)}</strong><br />
              Sipariş çevrim (gün): <strong>{Number(mSubeOperasyonKalite?.siparis_cevrim_sure_gun || 0).toFixed(2)}</strong>
            </div>
          </div>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Finans özet</h3>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Ciro / gider oranı: <strong>{Number(mFinansOzet?.ciro_gider_orani || 0).toFixed(3)}</strong><br />
              Kart faiz yükü: <strong>{Number(mFinansOzet?.kart_faiz_yuku_orani || 0).toFixed(3)}</strong><br />
              Nakit akış doğruluğu: <strong>{mFinansOzet?.nakit_akis_tahmin_dogrulugu ?? 'veri yok'}</strong>
            </div>
          </div>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Stok & tedarik</h3>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              Bardak kullanım/gün: <strong>{Number(mStokTedarik?.gunluk_bardak_kullanim || 0).toFixed(2)}</strong><br />
              Depo bekletme (gün): <strong>{Number(mStokTedarik?.depo_bekletme_sure_gun || 0).toFixed(2)}</strong><br />
              Açıklanamayan eksilme: <strong>{Number(mStokTedarik?.aciklanamayan_stok_eksilmesi || 0).toFixed(2)}</strong>
            </div>
          </div>
        </div>
      )}

      {aktifSekme === 'kontrol' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge badge-red">Kritik: {Number(kontrolData?.kritik_toplam || 0)}</span>
            <span className="badge badge-yellow">Uyarı: {Number(kontrolData?.uyari_toplam || 0)}</span>
            <span className="badge badge-gray">Şube: {Number(kontrolData?.sube_sayisi || 0)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
            {(kontrolData?.subeler || []).map((s) => {
              const kritik = Number(s?.kritik_adet || 0);
              const uyari = Number(s?.uyari_adet || 0);
              const temiz = !!s?.temiz;
              const borderColor = kritik > 0 ? 'var(--red)' : uyari > 0 ? 'var(--yellow)' : 'var(--green)';
              return (
                <button
                  key={s.sube_id}
                  type="button"
                  className="card"
                  style={{ textAlign: 'left', borderLeft: `4px solid ${borderColor}`, cursor: 'pointer' }}
                  onClick={() => setKontrolDetaySube((p) => (p === s.sube_id ? '' : s.sube_id))}
                >
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.sube_adi || s.sube_id}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className={`badge ${temiz ? 'badge-green' : 'badge-gray'}`}>{temiz ? 'Temiz' : 'Kontrol var'}</span>
                    <span className="badge badge-red">Kritik: {kritik}</span>
                    <span className="badge badge-yellow">Uyarı: {uyari}</span>
                  </div>
                  {kontrolDetaySube === s.sube_id && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {(s.sonuclar || []).length === 0 ? (
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>Açık kontrol bulunmuyor.</div>
                      ) : (
                        (s.sonuclar || []).map((k, i) => (
                          <div key={`${k.kontrol}-${i}`} style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 8, padding: '7px 9px' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                              <span className={`badge ${
                                k.seviye === 'kritik' ? 'badge-red' : k.seviye === 'uyari' ? 'badge-yellow' : 'badge-green'
                              }`}>{k.seviye}</span>
                              <span className="mono" style={{ fontSize: 11 }}>{k.kontrol}</span>
                            </div>
                            <div>{k.mesaj}</div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {yukleniyor ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : (kontrolData?.subeler || []).length === 0 ? (
            <div className="empty"><p>Kontrol sonucu yok.</p></div>
          ) : null}
        </div>
      )}

      {aktifSekme === 'fis' && (
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Bekleyen fiş kontrolleri ({fisBekleyen.length})
          </h3>
          {yukleniyor && fisBekleyen.length === 0 ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : fisBekleyen.length === 0 ? (
            <div className="empty"><p>Bekleyen fiş kontrolü yok.</p></div>
          ) : (
            <div className="table-wrap" style={{ margin: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Şube</th>
                    <th>Personel</th>
                    <th>Kategori</th>
                    <th>Tutar</th>
                    <th>Açıklama</th>
                    <th>Fiş</th>
                  </tr>
                </thead>
                <tbody>
                  {fisBekleyen.map((g) => (
                    <tr key={g.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{g.tarih}</td>
                      <td>{g.sube_adi || g.sube}</td>
                      <td style={{ fontSize: 12 }}>{g.personel_ad || g.personel_id || '—'}</td>
                      <td style={{ fontSize: 12 }}>{g.kategori}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{fmt(g.tutar || 0)}</td>
                      <td style={{ fontSize: 12, maxWidth: 360, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {g.aciklama || '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'geldi')}
                          >
                            {fisBusyId === `geldi:${g.id}` ? '…' : 'Geldi ✓'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'gelmedi')}
                          >
                            {fisBusyId === `gelmedi:${g.id}` ? '…' : 'Gelmedi ✗'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={!!fisBusyId}
                            onClick={() => fisKontrolIsle(g.id, 'muaf')}
                          >
                            {fisBusyId === `muaf:${g.id}` ? '…' : 'Muaf'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {aktifSekme === 'stok-kayip' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Stok kayıp tahmini (son {stokKayip?.gun_sayi || 45} gün)</h3>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Şube</th>
                  <th>Açık Toplam</th>
                  <th>Açık Kalem</th>
                  <th>Açık Gün</th>
                </tr>
              </thead>
              <tbody>
                {(stokKayip?.sube_ozet || []).map((s, i) => (
                  <tr key={`${s.sube_id}-${i}`}>
                    <td>{s.sube_adi || s.sube_id}</td>
                    <td className="mono">{s.toplam_acik || 0}</td>
                    <td className="mono">{s.acik_kalem || 0}</td>
                    <td className="mono">{s.acik_gun_sayisi || 0}</td>
                  </tr>
                ))}
                {(stokKayip?.sube_ozet || []).length === 0 && (
                  <tr><td colSpan={4}><div className="empty"><p>Stok kayıp verisi yok</p></div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {aktifSekme === 'personel-davranis' && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Personel açılış davranışı (son {personelDavranis?.gun_sayi || 45} gün)
          </h3>
          <div className="table-wrap" style={{ margin: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Personel</th>
                  <th>Şube</th>
                  <th>Açılış</th>
                  <th>Kasa Fark</th>
                  <th>Bardak Düşük</th>
                  <th>Vardiya Eksik</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {(personelDavranis?.personel_ozet || []).map((p, i) => (
                  <tr key={`${p.personel_id || p.personel_ad}-${i}`}>
                    <td>{p.personel_ad || p.personel_id || '—'}</td>
                    <td>{p.sube_adi || p.sube_id || '—'}</td>
                    <td className="mono">{p.acilis_sayisi || 0}</td>
                    <td className="mono">{p.acilis_kasa_fark_adet || 0}</td>
                    <td className="mono">{p.bardak_dusuk_toplam || 0}</td>
                    <td className="mono">{p.vardiya_eksik_adet || 0}</td>
                    <td className="mono">{p.davranis_risk_skoru || 0}</td>
                  </tr>
                ))}
                {(personelDavranis?.personel_ozet || []).length === 0 && (
                  <tr><td colSpan={7}><div className="empty"><p>Personel davranış verisi yok</p></div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {aktifSekme === 'defter' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Saat</th>
                <th>Şube</th>
                <th>Etiket</th>
                <th>Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {defter.length === 0 ? (
                <tr><td colSpan={5}><div className="empty"><p>Seçilen filtrede defter kaydı yok</p></div></td></tr>
              ) : defter.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 11 }}>{(r.tarih || '').substring(0, 10)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{(r.olay_ts || '').substring(11, 19)}</td>
                  <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                  <td><span className="badge badge-blue">{r.etiket || '—'}</span></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{(r.aciklama || '').slice(0, 130)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aktifSekme === 'sayim' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th rowSpan={2}>Tarih</th>
                <th rowSpan={2}>Saat</th>
                <th rowSpan={2}>Şube</th>
                <th rowSpan={2}>Personel</th>
                <th colSpan={3} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>Bardaklar</th>
                <th colSpan={5} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>Ürünler</th>
              </tr>
              <tr>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Küçük</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Büyük</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Plastik</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Su</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Redbull</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Soda</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Cookie</th>
                <th style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)' }}>Pasta</th>
              </tr>
            </thead>
            <tbody>
              {sayimlar.length === 0 ? (
                <tr><td colSpan={12}><div className="empty"><p>Seçilen filtrede açılış sayımı yok</p></div></td></tr>
              ) : sayimlar.map(r => {
                const s = r.stok_sayim || {};
                const cell = (val) => (
                  <td className="mono" style={{ fontSize: 12, textAlign: 'center' }}>
                    {val || 0}
                  </td>
                );
                return (
                  <tr key={r.event_id}>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.tarih || '').substring(0, 10)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.cevap_ts || '').substring(11, 19) || (r.bildirim_saati || '')}</td>
                    <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                    <td style={{ fontSize: 12 }}>{r.personel_ad || r.personel_id || '—'}</td>
                    {cell(s.bardak_kucuk)}
                    {cell(s.bardak_buyuk)}
                    {cell(s.bardak_plastik)}
                    {cell(s.su_adet)}
                    {cell(s.redbull_adet)}
                    {cell(s.soda_adet)}
                    {cell(s.cookie_adet)}
                    {cell(s.pasta_adet)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {aktifSekme === 'siparis' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şubelerden gelen <strong>özel ürün talepleri</strong> (katalogda olmayan) burada işlenir.
            <strong> Kataloga al</strong> derseniz ürün tüm şubelerin sipariş / teslim / aç formlarında görünür;
            <strong> Tek sefer</strong> ile kataloga eklemeden yalnızca bir sipariş kaydı oluşur; <strong> Red</strong> talebi kapatır.
          </p>

          <section className="card" style={{ padding: '14px 16px' }}>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Eksik teslim bildirimleri (son 7 gün)</h3>
            {sipSevkEksik.length === 0 ? (
              <div className="empty"><p>Eksik teslim bildirimi yok</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto' }}>
                {sipSevkEksik.map((r) => {
                  const siparisteVardi = r.eksik_kategori === 'sipariste_vardi';
                  return (
                    <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 13 }}>
                          <strong>{r.sube_adi || r.sube_id}</strong>
                          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{r.tedarikci_ad || 'Tedarikçi yok'}</span>
                        </div>
                        <span className={`badge ${siparisteVardi ? 'badge-yellow' : 'badge-red'}`}>
                          {siparisteVardi ? 'Siparişte vardı ama eksik geldi' : 'Siparişte yoktu / yazılmadı'}
                        </span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12 }}>{r.eksik_aciklama || '—'}</div>
                      <div className="mono" style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)' }}>
                        Bildiren: {r.bildiren_personel_ad || '—'} · {String(r.olusturma || '').replace('T', ' ').slice(0, 16)}
                      </div>
                      {!siparisteVardi && (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#f87171', fontWeight: 700 }}>
                          Son sipariş formu personeli: {r.siparis_personel_ad || 'Kayıt bulunamadı'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="card" style={{ padding: '14px 16px' }}>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Bekleyen özel talepler ({sipOzel.length})</h3>
            {sipOzel.length === 0 ? (
              <div className="empty"><p>Bekleyen özel ürün talebi yok</p></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {sipOzel.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 10,
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ fontSize: 13 }}>
                      <strong>{t.sube_adi || t.sube_id}</strong>
                      <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{t.kategori_kod}</span>
                      <div style={{ marginTop: 4 }}>
                        <strong>{t.urun_adi}</strong> × {t.adet}
                      </div>
                      {t.not_aciklama && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{t.not_aciklama}</div>}
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                        {t.personel_ad} · {t.olusturma?.replace('T', ' ').slice(0, 16)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!!sipBusyId}
                        onClick={async () => {
                          setSipBusyId(t.id);
                          try {
                            await api('/ops/siparis/ozel-islem', { method: 'POST', body: { talep_id: t.id, islem: 'katalog' } });
                            toast('Ürün kataloga eklendi', 'green');
                            await yukleSiparisMerkez();
                          } catch (e) { toast(e.message || 'Hata'); }
                          setSipBusyId(null);
                        }}
                      >Kataloga al</button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!!sipBusyId}
                        onClick={async () => {
                          setSipBusyId(t.id);
                          try {
                            await api('/ops/siparis/ozel-islem', { method: 'POST', body: { talep_id: t.id, islem: 'tek_sefer' } });
                            toast('Tek seferlik sipariş oluşturuldu', 'green');
                            await yukleSiparisMerkez();
                          } catch (e) { toast(e.message || 'Hata'); }
                          setSipBusyId(null);
                        }}
                      >Tek sefer</button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={!!sipBusyId}
                        onClick={async () => {
                          setSipBusyId(t.id);
                          try {
                            await api('/ops/siparis/ozel-islem', { method: 'POST', body: { talep_id: t.id, islem: 'red' } });
                            toast('Talep reddedildi', 'green');
                            await yukleSiparisMerkez();
                          } catch (e) { toast(e.message || 'Hata'); }
                          setSipBusyId(null);
                        }}
                      >Red</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <section className="card" style={{ padding: '14px 16px' }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Kataloga ürün ekle</h3>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Kategori (kod)</label>
                <select
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniUrun.kategori_kod}
                  onChange={(e) => setSipYeniUrun({ ...sipYeniUrun, kategori_kod: e.target.value })}
                >
                  <option value="">Seçin</option>
                  {sipKat.map((k) => (
                    <option key={k.id} value={k.id}>{k.label || k.ad}</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Ürün adı</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniUrun.urun_adi}
                  onChange={(e) => setSipYeniUrun({ ...sipYeniUrun, urun_adi: e.target.value })}
                  placeholder="Örn: Pil"
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!sipYeniUrun.kategori_kod || !sipYeniUrun.urun_adi.trim()}
                onClick={async () => {
                  try {
                    await api('/ops/siparis/urun', { method: 'POST', body: sipYeniUrun });
                    toast('Ürün eklendi', 'green');
                    setSipYeniUrun({ kategori_kod: '', urun_adi: '' });
                    await yukleSiparisMerkez();
                  } catch (e) { toast(e.message || 'Hata'); }
                }}
              >Ekle / aktif et</button>
            </section>

            <section className="card" style={{ padding: '14px 16px' }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>Yeni kategori</h3>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Kategori adı</label>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  value={sipYeniKat.ad}
                  onChange={(e) => setSipYeniKat({ ...sipYeniKat, ad: e.target.value })}
                  placeholder="Örn: Elektronik"
                />
              </div>
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Emoji (opsiyonel)</label>
                <input
                  className="input"
                  style={{ width: 100 }}
                  value={sipYeniKat.emoji}
                  onChange={(e) => setSipYeniKat({ ...sipYeniKat, emoji: e.target.value })}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!sipYeniKat.ad.trim()}
                onClick={async () => {
                  try {
                    await api('/ops/siparis/kategori', { method: 'POST', body: sipYeniKat });
                    toast('Kategori oluşturuldu', 'green');
                    setSipYeniKat({ ad: '', emoji: '📦' });
                    await yukleSiparisMerkez();
                  } catch (e) { toast(e.message || 'Hata'); }
                }}
              >Kategori tanımla</button>
            </section>
          </div>

          <section className="card" style={{ padding: '14px 16px' }}>
            <h3 style={{ fontSize: 14, marginBottom: 10 }}>Ürün aktif / pasif</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0 }}>Kategori seçip ürün satırında durumu değiştirin.</p>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {sipKat.map((k) => (
                <div key={k.id} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{k.label || k.ad}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(k.items || []).map((it) => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                        <span>{it.ad} {it.aktif === false ? <span className="badge badge-gray">pasif</span> : <span className="badge badge-green">aktif</span>}</span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={async () => {
                            try {
                              await api('/ops/siparis/urun-durum', {
                                method: 'POST',
                                body: { kategori_kod: k.id, urun_id: it.id, aktif: !it.aktif },
                              });
                              toast('Güncellendi', 'green');
                              await yukleSiparisMerkez();
                            } catch (e) { toast(e.message || 'Hata'); }
                          }}
                        >{it.aktif === false ? 'Aktif et' : 'Pasif et'}</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {aktifSekme === 'onay' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>
            Şube panelinden gelen <strong>anlık gider</strong> artık doğrudan kasaya yazılmaz; burada veya CFO onay kuyruğunda onaylanınca <code>anlik_giderler</code> aktif olur ve kasaya düşer.
            Ciro taslağı onayı sonrası kayıt resmi ciro + kasa akışına girer.
          </p>

          {yukleniyor && !bekleyenPaket ? (
            <div className="loading"><div className="spinner" />Yükleniyor…</div>
          ) : (
            <>
              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Ciro taslağı (bekleyen) — {bekleyenPaket?.ozet?.ciro_taslak ?? 0}</h3>
                {(bekleyenPaket?.ciro_taslaklari || []).length === 0 ? (
                  <div className="empty"><p>Bekleyen ciro taslağı yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.ciro_taslaklari.map((t) => (
                      <div
                        key={t.id}
                        className="card"
                        style={{ padding: '12px 14px', borderLeft: '4px solid var(--yellow)' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{t.sube_adi || t.sube_id}</div>
                            <div className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>
                              {t.tarih} · Nakit {fmt(t.nakit)} · POS {fmt(t.pos)} · Online {fmt(t.online)}
                            </div>
                            {t.aciklama && <div style={{ fontSize: 12, marginTop: 4 }}>{t.aciklama}</div>}
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => ciroTaslakOnayla(t.id)}
                            >
                              {onayBusyId === `c:${t.id}` ? '…' : 'Onayla → ciro'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => ciroTaslakReddet(t.id)}
                            >
                              {onayBusyId === `cr:${t.id}` ? '…' : 'Reddet'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>
                  Kasa uyumsuzlukları (çözüm bekleyen) · {bekleyenPaket?.ozet?.kasa_uyumsuzluk ?? 0}
                </h3>
                {(bekleyenPaket?.kritik_kasa_personelleri || []).length > 0 && (
                  <div className="alert-box red" style={{ marginBottom: 10 }}>
                    Kritik personel izleme ({bekleyenPaket?.ozet?.kritik_kasa_personel ?? 0}):{' '}
                    {(bekleyenPaket?.kritik_kasa_personelleri || [])
                      .slice(0, 6)
                      .map((p) => `${p.personel_ad || p.personel_id} (${p.aylik_hata_adet})`)
                      .join(' · ')}
                  </div>
                )}
                {(bekleyenPaket?.kasa_uyumsuzluklar || []).length === 0 ? (
                  <div className="empty"><p>Çözüm bekleyen kasa uyumsuzluğu yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.kasa_uyumsuzluklar.map((u) => {
                      const fark = Number(u.fark_tl || 0);
                      const farkPozitif = fark >= 0;
                      return (
                        <div
                          key={u.id}
                          className="card"
                          style={{ padding: '12px 14px', borderLeft: `4px solid ${Math.abs(fark) >= 200 ? 'var(--red)' : 'var(--yellow)'}` }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {u.sube_adi || u.sube_id}
                                <span style={{ marginLeft: 8 }} className={`badge ${Math.abs(fark) >= 200 ? 'badge-red' : 'badge-yellow'}`}>
                                  {farkPozitif ? '+' : ''}{fmt(fark)}
                                </span>
                                {u.kritik_personel_var && (
                                  <span style={{ marginLeft: 6 }} className="badge badge-red">Kritik personel</span>
                                )}
                              </div>
                              <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                                {u.tarih} · Beklenen: {fmt(u.beklenen_tl || 0)} · Açılış Sayım: {fmt(u.gercek_tl || 0)}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                                Açılış: {u.acilis_personel_ad || u.acilis_personel_id || '—'}
                                {!!u.acilis_personel_aylik_hata_adet && (
                                  <span className={`badge ${u.acilis_personel_aylik_hata_adet >= 2 ? 'badge-red' : 'badge-gray'}`} style={{ marginLeft: 6 }}>
                                    Ay içi hata: {u.acilis_personel_aylik_hata_adet}
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                                Önceki kapanış: {u.kapanis_personel_ad || u.kapanis_personel_id || '—'}
                                {!!u.kapanis_personel_aylik_hata_adet && (
                                  <span className={`badge ${u.kapanis_personel_aylik_hata_adet >= 2 ? 'badge-red' : 'badge-gray'}`} style={{ marginLeft: 6 }}>
                                    Ay içi hata: {u.kapanis_personel_aylik_hata_adet}
                                  </span>
                                )}
                              </div>
                              {u.mesaj && <div style={{ fontSize: 12, marginTop: 6 }}>{u.mesaj}</div>}
                            </div>
                            <div>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={!!onayBusyId}
                                onClick={() => kasaUyumsuzlukCoz(u.id)}
                              >
                                {onayBusyId === `ku:${u.id}` ? '…' : 'Çözüldü işaretle'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>
                  Onay kuyruğu (bekleyen)
                  {subeOnayFiltre ? ' — sadece bu şubenin anlık gider talepleri' : ' — tüm türler'}
                  {' · '}
                  {bekleyenPaket?.ozet?.onay_satir ?? 0}
                </h3>
                {(bekleyenPaket?.onay_kuyrugu || []).length === 0 ? (
                  <div className="empty"><p>Bekleyen kuyruk kaydı yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.onay_kuyrugu.map((o) => (
                      <div
                        key={o.id}
                        className="card"
                        style={{
                          padding: '12px 14px',
                          borderLeft: `4px solid ${o.islem_turu === 'ANLIK_GIDER' ? 'var(--yellow)' : 'var(--border)'}`,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {ONAY_TURU_LABEL[o.islem_turu] || o.islem_turu}
                              {o.sube_adi && (
                                <span style={{ fontWeight: 500, color: 'var(--text3)', marginLeft: 8 }}>{o.sube_adi}</span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{o.aciklama}</div>
                            <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>{fmt(o.tutar)} · {o.tarih}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => kuyrukOnayla(o.id)}
                            >
                              {onayBusyId === `o:${o.id}` ? '…' : 'Onayla'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={!!onayBusyId}
                              onClick={() => kuyrukReddet(o.id)}
                            >
                              {onayBusyId === `or:${o.id}` ? '…' : 'Reddet'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>
                  Sipariş talepleri (bekleyen) · {bekleyenPaket?.ozet?.siparis_talep ?? 0}
                </h3>
                {(bekleyenPaket?.siparis_talepleri || []).length === 0 ? (
                  <div className="empty"><p>Bekleyen sipariş talebi yok</p></div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {bekleyenPaket.siparis_talepleri.map((s) => (
                      <div
                        key={s.id}
                        className="card"
                        style={{ padding: '12px 14px', borderLeft: '4px solid var(--blue)' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {s.sube_adi || s.sube_id}
                              <span style={{ fontWeight: 500, color: 'var(--text3)', marginLeft: 8 }}>
                                {s.kalem_adet_toplam || 0} adet kalem
                              </span>
                            </div>
                            <div className="mono" style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
                              {s.tarih} · {(s.bildirim_saati || '—')} · {s.personel_ad || '—'}
                            </div>
                            {s.not_aciklama && <div style={{ fontSize: 12, marginTop: 6 }}>{s.not_aciklama}</div>}
                            {(s.kalemler || []).length > 0 && (
                              <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text2)' }}>
                                {(s.kalemler || []).slice(0, 6).map((k) => `${k?.urun_ad || 'Ürün'} x${k?.adet || 0}`).join(' · ')}
                                {(s.kalemler || []).length > 6 ? ` · +${(s.kalemler || []).length - 6} kalem` : ''}
                              </div>
                            )}
                            {(s.sevkiyat_durum || '') !== 'bekliyor' && (
                              <div style={{ marginTop: 6 }}>
                                <span className={`badge ${
                                  s.sevkiyat_durum === 'teslim_edildi' ? 'badge-green'
                                    : s.sevkiyat_durum === 'gonderildi' ? 'badge-blue'
                                      : 'badge-yellow'
                                }`}>
                                  Sevkiyat: {s.sevkiyat_durum}
                                </span>
                                {s.sevkiyat_sube_adi && (
                                  <span style={{ marginLeft: 8, color: 'var(--text3)', fontSize: 12 }}>
                                    Hedef: {s.sevkiyat_sube_adi}
                                  </span>
                                )}
                              </div>
                            )}
                            {(s.sevkiyat_durum || 'bekliyor') === 'bekliyor' && (
                              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                <select
                                  className="input"
                                  style={{ minWidth: 220, padding: '6px 8px' }}
                                  value={sipSevkiyatHedef[s.id] || ''}
                                  onChange={(e) => setSipSevkiyatHedef((p) => ({ ...p, [s.id]: e.target.value }))}
                                >
                                  <option value="">Sevkiyat şubesi seç</option>
                                  {subeListeAdmin
                                    .filter((sb) => ['depo', 'karma', 'sevkiyat', 'merkez'].includes(String(sb?.sube_tipi || 'normal')))
                                    .map((sb) => (
                                      <option key={sb.id} value={sb.id}>{sb.ad || sb.id}</option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  disabled={!!onayBusyId}
                                  onClick={() => siparisSevkiyataGonder(s.id)}
                                >
                                  {onayBusyId === `sg:${s.id}` ? '…' : 'Sevkiyata Gönder'}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 style={{ fontSize: 14, marginBottom: 10 }}>Şube notları (iade, sorun, bilgi)</h3>
                {notlarListe.length === 0 ? (
                  <div className="empty"><p>Bu filtrede not yok</p></div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Zaman</th>
                          <th>Şube</th>
                          <th>Personel</th>
                          <th>Not</th>
                        </tr>
                      </thead>
                      <tbody>
                        {notlarListe.map((n) => (
                          <tr key={n.id}>
                            <td className="mono" style={{ fontSize: 11 }}>{(n.olusturma || '').replace('T', ' ').slice(0, 19)}</td>
                            <td>{n.sube_adi || n.sube_id}</td>
                            <td style={{ fontSize: 12 }}>{n.personel_ad || n.personel_id || '—'}</td>
                            <td style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{n.metin}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}

      {/* MERKEZ MESAJ SEKMESİ */}
      {aktifSekme === 'mesaj' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Şubeye Mesaj Gönder</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
              Gönderilen mesajlar şube panelinde yanıp söner. Personel PIN ile onaylayana kadar kapanış yapılamaz.
              <strong> Gösterim süresi</strong> dolunca mesaj şube listesinden kalkar (kayıt silinmez).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Şube *</label>
                <select value={mesajForm.sube_id} onChange={e => setMesajForm({ ...mesajForm, sube_id: e.target.value })}>
                  <option value="">Seçin</option>
                  {subeListeAdmin.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Öncelik</label>
                <select value={mesajForm.oncelik} onChange={e => setMesajForm({ ...mesajForm, oncelik: e.target.value })}>
                  <option value="normal">Normal</option>
                  <option value="kritik">Kritik 🚨</option>
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Şubede listelenme süresi (saat)</label>
                <input
                  type="number"
                  min={1}
                  max={8760}
                  value={mesajForm.ttl_saat}
                  onChange={e => setMesajForm({ ...mesajForm, ttl_saat: Math.max(1, Math.min(8760, parseInt(e.target.value, 10) || 72)) })}
                  style={{ width: 120, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 10px', color: 'var(--text)', fontSize: 13 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>Oluşturulduktan sonra (varsayılan 72)</span>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Mesaj *</label>
                <textarea rows={3} value={mesajForm.mesaj} onChange={e => setMesajForm({ ...mesajForm, mesaj: e.target.value })} placeholder="Şubeye iletmek istediğiniz mesaj..." style={{ width: '100%', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '8px 12px', color: 'var(--text)', fontSize: 13 }} />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={mesajBusy || !mesajForm.sube_id || !mesajForm.mesaj.trim()}
                onClick={async () => {
                  setMesajBusy(true);
                  try {
                    await api('/ops/merkez-mesaj-gonder', { method: 'POST', body: mesajForm });
                    toast('Mesaj gönderildi', 'green');
                    setMesajForm({ sube_id: '', mesaj: '', oncelik: 'normal', ttl_saat: 72 });
                    const r = await api('/ops/merkez-mesajlar?limit=100');
                    setMesajListe(r.satirlar || []);
                  } catch (e) { toast(e.message || 'Hata'); }
                  setMesajBusy(false);
                }}
              >
                {mesajBusy ? '…' : 'Gönder'}
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zaman</th>
                  <th>Şube</th>
                  <th>Öncelik</th>
                  <th>Mesaj</th>
                  <th>Süre (sa)</th>
                  <th>Durum</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {mesajListe.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty"><p>Henüz mesaj gönderilmedi</p></div></td></tr>
                ) : mesajListe.map(m => (
                  <tr key={m.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{(m.olusturma || '').slice(0, 16)}</td>
                    <td style={{ fontWeight: 500 }}>{m.sube_adi || m.sube_id}</td>
                    <td>{m.oncelik === 'kritik' ? <span className="badge badge-red">Kritik</span> : <span className="badge badge-gray">Normal</span>}</td>
                    <td style={{ fontSize: 12, maxWidth: 300 }}>{m.mesaj}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{m.ttl_saat != null ? m.ttl_saat : '—'}</td>
                    <td>{m.okundu
                      ? <span className="badge badge-green">✓ Okundu — {m.okuyan_ad || '?'}</span>
                      : <span className="badge badge-yellow">Bekliyor</span>}
                    </td>
                    <td>
                      <button type="button" className="btn btn-danger btn-sm" onClick={async () => {
                        try {
                          await api(`/ops/merkez-mesaj/${m.id}`, { method: 'DELETE' });
                          const r = await api('/ops/merkez-mesajlar?limit=100');
                          setMesajListe(r.satirlar || []);
                        } catch (e) { toast(e.message || 'Silinemedi'); }
                      }}>Kaldır</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* PERSONEL PUAN SEKMESİ */}
      {aktifSekme === 'puan' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ margin: 0 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Şube</span>
              <select
                style={{ padding: '8px 10px', minWidth: 200, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontSize: 13 }}
                value={puanSubeFiltre}
                onChange={e => setPuanSubeFiltre(e.target.value)}
              >
                <option value="">Tüm şubeler</option>
                {subeListeAdmin.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Personel</th>
                  <th>Şube</th>
                  <th style={{ textAlign: 'center' }}>Puan</th>
                  <th style={{ textAlign: 'center' }}>Zamanında</th>
                  <th style={{ textAlign: 'center' }}>Gecikti</th>
                </tr>
              </thead>
              <tbody>
                {puanListe.length === 0 ? (
                  <tr><td colSpan={6}><div className="empty"><p>Veri yok</p></div></td></tr>
                ) : puanListe.map((p, i) => {
                  const puan = p.puan;
                  const renk = puan == null ? 'var(--text3)' : puan >= 90 ? 'var(--green)' : puan >= 75 ? 'var(--blue)' : puan >= 55 ? 'var(--yellow)' : 'var(--red)';
                  const takip = takipMap?.[p.personel_id];
                  return (
                    <tr key={p.personel_id}>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>
                        {p.ad_soyad}
                        {takip && (
                          <button
                            type="button"
                            className={`badge ${takip.takip_seviyesi === 'kritik' ? 'badge-red' : takip.takip_seviyesi === 'uyari' ? 'badge-yellow' : 'badge-gray'}`}
                            style={{ marginLeft: 8, cursor: 'pointer', border: 'none' }}
                            onClick={async () => {
                              try {
                                const r = await api(`/ops/personel-risk-sinyal?personel_id=${encodeURIComponent(p.personel_id)}&gun=30`);
                                setRiskModal(r);
                              } catch (e) { toast(e.message || 'Sinyal geçmişi yüklenemedi'); }
                            }}
                          >
                            Takip: {takip.takip_seviyesi}
                          </button>
                        )}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{p.sube_id || '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        {puan != null
                          ? <span style={{ fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)' }}>{puan}</span>
                          : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'center' }} className="mono">{p.tamam}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="mono" style={{ color: p.gecikti > 0 ? 'var(--red)' : 'var(--text3)' }}>{p.gecikti}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {riskModal && (
        <div className="modal-overlay" onClick={() => setRiskModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <div style={{ fontWeight: 800 }}>Personel risk sinyalleri</div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  {riskModal.personel_id} · son {riskModal.gun_sayi} gün
                  {riskModal.takip?.takip_seviyesi && (
                    <span className="badge badge-red" style={{ marginLeft: 8 }}>
                      Takip: {riskModal.takip.takip_seviyesi}
                    </span>
                  )}
                </div>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setRiskModal(null)}>Kapat</button>
            </div>
            <div className="modal-body">
              {(riskModal.satirlar || []).length === 0 ? (
                <div className="empty"><p>Sinyal yok</p></div>
              ) : (
                <div className="table-wrap" style={{ margin: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Tür</th>
                        <th>Ağırlık</th>
                        <th>Açıklama</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(riskModal.satirlar || []).map((s) => (
                        <tr key={s.id}>
                          <td className="mono" style={{ fontSize: 11 }}>{s.tarih}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.sinyal_turu}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.agirlik}</td>
                          <td style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{s.aciklama}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detay modal */}
      {detay && (
        <DetayModal
          kart={detay}
          filtre={filtre}
          onKapat={() => setDetay(null)}
          onYenileDetay={yenileDetayKart}
        />
      )}
    </div>
  );
}
