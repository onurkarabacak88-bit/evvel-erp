import { useState, useEffect, useCallback } from 'react';
import { api, fmt } from '../utils/api';
import { computeOpsKartVurgu } from '../utils/opsVurgu';

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
  const [sipOzel, setSipOzel] = useState([]);
  const [sipKat, setSipKat] = useState([]);
  const [sipBusyId, setSipBusyId] = useState(null);
  const [sipYeniUrun, setSipYeniUrun] = useState({ kategori_kod: '', urun_adi: '' });
  const [sipYeniKat, setSipYeniKat] = useState({ ad: '', emoji: '📦' });

  const toast = (m, t = 'red') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 4000); };

  const yukleSiparisMerkez = useCallback(async () => {
    try {
      const [oz, cat] = await Promise.all([
        api('/ops/siparis/ozel-bekleyen'),
        api('/ops/siparis/katalog'),
      ]);
      setSipOzel(oz.talepler || []);
      setSipKat(cat.kategoriler || []);
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

  const yukle = useCallback(async (f = filtre) => {
    try {
      const q = `year_month=${encodeURIComponent(ayFiltre)}${gunFiltre ? `&gun=${encodeURIComponent(gunFiltre)}` : ''}`;
      const calls = [api(`/ops/dashboard?filtre=${f}`)];
      if (aktifSekme === 'canli') {
        calls.push(api('/ops/skor'));
      } else if (aktifSekme === 'defter') {
        calls.push(api(`/ops/defter?limit=300&${q}`));
      } else if (aktifSekme === 'sayim') {
        calls.push(api(`/ops/sayimlar?limit=300&${q}`));
      } else {
        calls.push(Promise.resolve({ satirlar: [] }));
      }
      const [dash, extra] = await Promise.all(calls);
      setKartlar(dash.kartlar || []);
      setOzet(dash);
      if (aktifSekme === 'canli') {
        setSkor(extra);
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
    if (aktifSekme === 'onay') return;
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
  }, [aktifSekme, puanSubeFiltre]);

  useEffect(() => {
    if (aktifSekme !== 'siparis') return;
    yukleSiparisMerkez();
  }, [aktifSekme, yukleSiparisMerkez]);

  // 25 saniyede bir otomatik yenile
  useEffect(() => {
    if (aktifSekme === 'onay') return undefined;
    const t = setInterval(() => yukle(filtre), 25000);
    return () => clearInterval(t);
  }, [filtre, yukle, aktifSekme]);

  const toplamGecikme = skor?.son_30_gun?.reduce((s, r) => s + (r.gecikme_adet || 0), 0) || 0;
  const kritikSayi    = kartlar.filter(k => k.bayraklar?.kritik).length;
  const gecikSayi     = kartlar.filter(k => k.bayraklar?.geciken).length;
  const guvenlikSayi  = kartlar.filter(k => k.bayraklar?.guvenlik_alarm).length;

  async function ciroTaslakOnayla(tid) {
    setOnayBusyId(`c:${tid}`);
    try {
      await api(`/ciro-taslak/${encodeURIComponent(tid)}/onayla`, { method: 'POST', body: {} });
      toast('Ciro taslağı onaylandı; kasa ve ciro girişine işlendi.', 'green');
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
      await yukleOnayMerkez();
    } catch (e) {
      toast(e.message || 'Red başarısız');
    } finally {
      setOnayBusyId(null);
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
          </div>

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
        </>
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
                <th>Tarih</th>
                <th>Saat</th>
                <th>Şube</th>
                <th>Personel</th>
                <th>Bardaklar (K/B/P)</th>
                <th>Ürünler (Su/Redbull/Soda/Cookie/Pasta)</th>
              </tr>
            </thead>
            <tbody>
              {sayimlar.length === 0 ? (
                <tr><td colSpan={6}><div className="empty"><p>Seçilen filtrede açılış sayımı yok</p></div></td></tr>
              ) : sayimlar.map(r => {
                const s = r.stok_sayim || {};
                return (
                  <tr key={r.event_id}>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.tarih || '').substring(0, 10)}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{(r.cevap_ts || '').substring(11, 19) || (r.bildirim_saati || '')}</td>
                    <td style={{ fontWeight: 500, fontSize: 13 }}>{r.sube_adi || r.sube_id}</td>
                    <td style={{ fontSize: 12 }}>{r.personel_ad || r.personel_id || '—'}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{`${s.bardak_kucuk || 0}/${s.bardak_buyuk || 0}/${s.bardak_plastik || 0}`}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{`${s.su_adet || 0}/${s.redbull_adet || 0}/${s.soda_adet || 0}/${s.cookie_adet || 0}/${s.pasta_adet || 0}`}</td>
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
                  return (
                    <tr key={p.personel_id}>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text3)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 500 }}>{p.ad_soyad}</td>
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
