import { useState, useEffect, useMemo } from 'react';
import { api, fmt } from '../utils/api';

/** Takvim günü Europe/Istanbul (YYYY-MM-DD) — UTC `toISOString` ile iş günü kayması olmaz */
function tarihTrISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** ISO tarihinden yaklaşık N gün önce (İstanbul takvimi; varsayılan liste penceresi) */
function tarihTrISOGunOnce(iso, gun) {
  const s = String(iso || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return tarihTrISO(new Date(Date.now() - gun * 86400000));
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() - gun);
  return tarihTrISO(t);
}

const TUR_LABEL = {
  ara: { label: 'Ara Teslim', renk: '#BA7517', bg: 'rgba(186,117,23,.10)' },
  gun_sonu: { label: 'Gün Sonu', renk: 'var(--color-text-primary)', bg: 'var(--color-background-secondary)' },
};

export default function KasaTeslim() {
  const [satirlar, setSatirlar] = useState([]);
  /** Filtre + tarih aralığında satır yoksa: tarih kısıtı olmadan en son hareketler */
  const [fallbackSatirlar, setFallbackSatirlar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [alicilar, setAlicilar] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  // Filtreler
  const [subeFiltre, setSubeFiltre] = useState('');
  const [turFiltre, setTurFiltre] = useState('');
  const [aliciFiltre, setAliciFiltre] = useState('');
  const [edenFiltre, setEdenFiltre] = useState('');
  const [tarihBas, setTarihBas] = useState(() => tarihTrISOGunOnce(tarihTrISO(), 13));
  const [tarihBit, setTarihBit] = useState(() => tarihTrISO());

  // Teslim alıcı yönetimi
  const [aliciModal, setAliciModal] = useState(false);
  const [aliciForm, setAliciForm] = useState({ ad: '', unvan: '', sube_id: '' });
  const [aliciDuzId, setAliciDuzId] = useState(null);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  const load = () => {
    setLoading(true);
    setFallbackSatirlar([]);
    const qs = new URLSearchParams();
    if (subeFiltre) qs.set('sube_id', subeFiltre);
    if (turFiltre) qs.set('teslim_turu', turFiltre);
    if (aliciFiltre) qs.set('teslim_alan_id', aliciFiltre);
    if (edenFiltre) qs.set('teslim_eden_ad', edenFiltre);
    if (tarihBas) qs.set('tarih_baslangic', tarihBas);
    if (tarihBit) qs.set('tarih_bitis', tarihBit);
    qs.set('limit', '500');
    api(`/kasa-teslim?${qs}`)
      .then(async (r) => {
        const rows = r.satirlar || [];
        setSatirlar(rows);
        if (rows.length === 0) {
          const qs2 = new URLSearchParams();
          if (subeFiltre) qs2.set('sube_id', subeFiltre);
          if (turFiltre) qs2.set('teslim_turu', turFiltre);
          if (aliciFiltre) qs2.set('teslim_alan_id', aliciFiltre);
          if (edenFiltre) qs2.set('teslim_eden_ad', edenFiltre);
          qs2.set('limit', '200');
          try {
            const r2 = await api(`/kasa-teslim?${qs2}`);
            setFallbackSatirlar(r2.satirlar || []);
          } catch {
            setFallbackSatirlar([]);
          }
        }
      })
      .catch((e) => toast(e.message, 'red'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    api('/subeler').then((r) => setSubeler(r || []));
    api('/kasa-teslim-alici').then((r) => setAlicilar(r.alicilar || []));
  }, []);

  useEffect(() => {
    load();
  }, [subeFiltre, turFiltre, aliciFiltre, edenFiltre, tarihBas, tarihBit]);

  const gosterilen = satirlar.length > 0 ? satirlar : fallbackSatirlar;
  const fallbackModu = satirlar.length === 0 && fallbackSatirlar.length > 0;

  // Özet: tabloda görünen satırlara göre (fallback modunda da kartlar dolu olsun)
  const ozet = useMemo(() => {
    const ara = gosterilen.filter((s) => s.teslim_turu === 'ara');
    const gunSonu = gosterilen.filter((s) => s.teslim_turu === 'gun_sonu');
    return {
      ara_adet: ara.length,
      ara_toplam: ara.reduce((a, s) => a + s.tutar, 0),
      sonu_adet: gunSonu.length,
      sonu_toplam: gunSonu.reduce((a, s) => a + s.tutar, 0),
      genel_toplam: gosterilen.reduce((a, s) => a + s.tutar, 0),
    };
  }, [gosterilen]);

  /** Şube bazında toplam — CFO "hangi şube ne kadar teslim etti" görünümü */
  const subeOzet = useMemo(() => {
    const m = new Map();
    gosterilen.forEach((s) => {
      const ad = s.sube_adi || '—';
      const cur = m.get(ad) || { ad, toplam: 0, adet: 0 };
      cur.toplam += Number(s.tutar) || 0;
      cur.adet += 1;
      m.set(ad, cur);
    });
    return [...m.values()].sort((a, b) => b.toplam - a.toplam);
  }, [gosterilen]);

  /** Tarih bazında toplam — tabloda gün ayıracı için */
  const gunToplam = useMemo(() => {
    const m = {};
    gosterilen.forEach((s) => {
      m[s.tarih] = (m[s.tarih] || 0) + (Number(s.tutar) || 0);
    });
    return m;
  }, [gosterilen]);

  async function aliciKaydet() {
    if (!aliciForm.ad.trim()) {
      toast('Ad zorunlu', 'red');
      return;
    }
    try {
      if (aliciDuzId) {
        await api(`/kasa-teslim-alici/${aliciDuzId}`, { method: 'PUT', body: aliciForm });
        toast('Güncellendi');
      } else {
        await api('/kasa-teslim-alici', { method: 'POST', body: aliciForm });
        toast('Eklendi');
      }
      setAliciModal(false);
      setAliciForm({ ad: '', unvan: '', sube_id: '' });
      setAliciDuzId(null);
      api('/kasa-teslim-alici').then((r) => setAlicilar(r.alicilar || []));
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  async function aliciSil(id) {
    if (!confirm('Pasife almak istiyor musunuz?')) return;
    try {
      await api(`/kasa-teslim-alici/${id}`, { method: 'DELETE' });
      toast('Pasife alındı', 'yellow');
      api('/kasa-teslim-alici').then((r) => setAlicilar(r.alicilar || []));
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>💰 Kasa Teslim</h2>
          <p>Şubelerden yapılan ara ve gün sonu kasa teslimlerinin merkez tablosu</p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={() => {
            setAliciModal(true);
            setAliciDuzId(null);
            setAliciForm({ ad: '', unvan: '', sube_id: '' });
          }}
        >
          + Teslim Alıcı Tanımla
        </button>
      </div>

      {/* Özet kartlar — tıklanabilir filtre */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
        {[
          { ikon: '🔄', etiket: 'Ara Teslim', tag: 'ara', tutar: ozet.ara_toplam, adet: ozet.ara_adet, renk: '#BA7517', bg: 'rgba(186,117,23,.10)', border: 'rgba(186,117,23,.30)', ring: '#BA7517' },
          { ikon: '🌙', etiket: 'Gün Sonu', tag: 'gun_sonu', tutar: ozet.sonu_toplam, adet: ozet.sonu_adet, renk: 'var(--color-text-primary)', bg: 'var(--color-background-secondary)', border: 'var(--color-border-tertiary)', ring: 'var(--color-text-primary)' },
          { ikon: '💰', etiket: 'Genel Toplam', tag: '', tutar: ozet.genel_toplam, adet: ozet.ara_adet + ozet.sonu_adet, renk: 'var(--color-text-success)', bg: 'rgba(34,197,94,.08)', border: 'rgba(34,197,94,.28)', ring: 'rgb(34,197,94)' },
        ].map((c) => {
          const aktif = turFiltre === c.tag;
          return (
            <div
              key={c.etiket}
              onClick={() => setTurFiltre((prev) => (prev === c.tag ? '' : c.tag))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setTurFiltre((prev) => (prev === c.tag ? '' : c.tag)); }}
              style={{
                background: aktif ? 'rgba(34,197,94,.12)' : c.bg,
                border: `1px solid ${aktif ? 'rgb(34,197,94)' : c.border}`,
                borderRadius: 12,
                padding: '14px 16px',
                cursor: 'pointer',
                transition: 'box-shadow .12s, transform .12s, border-color .12s, background .12s',
                boxShadow: aktif ? '0 0 0 2px rgb(34,197,94) inset' : 'none',
                transform: aktif ? 'translateY(-1px)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>{c.ikon}</span>
                <span style={{ fontSize: 12, color: aktif ? 'rgb(22,163,74)' : 'var(--color-text-secondary)', fontWeight: 600 }}>{c.etiket}</span>
                {aktif && (
                  <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: 'rgb(22,163,74)' }}>
                    ✓
                  </span>
                )}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: c.renk, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{fmt(c.tutar)} ₺</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 3 }}>{c.adet} teslim</div>
            </div>
          );
        })}
      </div>

      {/* Şube bazında kırılım */}
      {subeOzet.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Şube bazında · {subeOzet.length} şube
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {subeOzet.map((s) => (
              <div key={s.ad} style={{ display: 'flex', flexDirection: 'column', minWidth: 130, padding: '9px 13px', borderRadius: 10, background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-tertiary)' }}>
                <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>🏪 {s.ad}</span>
                <span style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{fmt(s.toplam)} ₺</span>
                <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>{s.adet} teslim</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filtreler — kompakt araç çubuğu */}
      {(() => {
        const fld = { display: 'flex', flexDirection: 'column', gap: 3 };
        const lbl = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)' };
        const ctrl = { height: 34, padding: '0 9px', fontSize: 13, borderRadius: 8, border: '1px solid var(--color-border-tertiary)', background: 'var(--color-background-primary)', color: 'var(--color-text-primary)' };
        const filtreVar = subeFiltre || turFiltre || aliciFiltre || edenFiltre;
        return (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              gap: 10,
              marginBottom: 16,
              padding: '12px 14px',
              borderRadius: 12,
              background: 'var(--color-background-secondary)',
              border: '1px solid var(--color-border-tertiary)',
            }}
          >
            <div style={fld}>
              <span style={lbl}>Başlangıç</span>
              <input type="date" value={tarihBas} onChange={(e) => setTarihBas(e.target.value)} style={ctrl} />
            </div>
            <div style={fld}>
              <span style={lbl}>Bitiş</span>
              <input type="date" value={tarihBit} onChange={(e) => setTarihBit(e.target.value)} style={ctrl} />
            </div>
            <div style={fld}>
              <span style={lbl}>Şube</span>
              <select value={subeFiltre} onChange={(e) => setSubeFiltre(e.target.value)} style={{ ...ctrl, minWidth: 130 }}>
                <option value="">Tüm Şubeler</option>
                {subeler.map((s) => (
                  <option key={s.id} value={s.id}>{s.ad}</option>
                ))}
              </select>
            </div>
            <div style={fld}>
              <span style={lbl}>Tür</span>
              <select value={turFiltre} onChange={(e) => setTurFiltre(e.target.value)} style={{ ...ctrl, minWidth: 120 }}>
                <option value="">Tümü</option>
                <option value="ara">Ara Teslim</option>
                <option value="gun_sonu">Gün Sonu</option>
              </select>
            </div>
            <div style={fld}>
              <span style={lbl}>Teslim Alan</span>
              <select value={aliciFiltre} onChange={(e) => setAliciFiltre(e.target.value)} style={{ ...ctrl, minWidth: 140 }}>
                <option value="">Tümü</option>
                {alicilar.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.ad}{a.unvan ? ` — ${a.unvan}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div style={fld}>
              <span style={lbl}>Teslim Eden</span>
              <input value={edenFiltre} onChange={(e) => setEdenFiltre(e.target.value)} placeholder="İsim ara…" style={{ ...ctrl, minWidth: 130 }} />
            </div>
            {filtreVar && (
              <button
                onClick={() => { setSubeFiltre(''); setTurFiltre(''); setAliciFiltre(''); setEdenFiltre(''); }}
                style={{ ...ctrl, cursor: 'pointer', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 5 }}
              >
                ✕ Temizle
              </button>
            )}
          </div>
        );
      })()}

      {/* Tablo */}
      {loading ? (
        <div className="loading">
          <div className="spinner" />
          Yükleniyor…
        </div>
      ) : gosterilen.length === 0 ? (
        <div className="empty">
          <p>Kayıt bulunamadı</p>
        </div>
      ) : (
        <div className="table-wrap" style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid var(--color-border-tertiary)' }}>
          {fallbackModu && (
            <div
              className="alert-box yellow"
              style={{ padding: '10px 14px', fontSize: 13, margin: 0, borderRadius: 0 }}
            >
              Seçili tarih ve filtrelerde kayıt yok; <strong>en son kasa teslim hareketleri</strong> (tarih filtresi
              dışında, son 200) listeleniyor.
            </div>
          )}
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                {['Tarih', 'Saat', 'Şube', 'Tür', 'Teslim Eden', 'Teslim Alan'].map((h) => (
                  <th key={h} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '10px 12px', borderBottom: '2px solid var(--color-border-tertiary)' }}>{h}</th>
                ))}
                <th style={{ textAlign: 'right', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '10px 12px', borderBottom: '2px solid var(--color-border-tertiary)' }}>Tutar</th>
                <th style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '10px 12px', borderBottom: '2px solid var(--color-border-tertiary)' }}>Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const out = [];
                let sonTarih = null;
                gosterilen.forEach((s) => {
                  if (s.tarih !== sonTarih) {
                    sonTarih = s.tarih;
                    out.push(
                      <tr key={`gun-${s.tarih}`} style={{ background: 'var(--color-background-secondary)' }}>
                        <td colSpan={6} style={{ padding: '7px 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', borderTop: '2px solid var(--color-border-tertiary)' }}>
                          📅 {s.tarih}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 12, color: 'rgb(22,163,74)', borderTop: '2px solid var(--color-border-tertiary)' }}>
                          {fmt(gunToplam[s.tarih])} ₺
                        </td>
                        <td style={{ borderTop: '2px solid var(--color-border-tertiary)' }} />
                      </tr>
                    );
                  }
                  const tur = TUR_LABEL[s.teslim_turu] || TUR_LABEL.gun_sonu;
                  const saat = s.olusturma
                    ? new Date(s.olusturma).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
                    : '—';
                  out.push(
                    <tr
                      key={s.id}
                      style={{ background: tur.bg, transition: 'background .1s', borderBottom: '1px solid var(--color-border-tertiary)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-background-secondary)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = tur.bg; }}
                    >
                      <td className="mono" style={{ fontSize: 12, padding: '9px 12px' }}>
                        {s.tarih}
                      </td>
                      <td className="mono" style={{ fontSize: 12, padding: '9px 12px' }}>
                        {saat}
                      </td>
                      <td style={{ fontWeight: 500, padding: '9px 12px' }}>🏪 {s.sube_adi}</td>
                      <td>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 600,
                            background: s.teslim_turu === 'ara' ? 'rgba(186,117,23,.15)' : 'var(--color-background-secondary)',
                            color: tur.renk,
                            border: `1px solid ${
                              s.teslim_turu === 'ara' ? 'rgba(186,117,23,.3)' : 'var(--color-border-tertiary)'
                            }`,
                          }}
                        >
                          {s.teslim_turu === 'ara' ? '🔄' : '🌙'} {tur.label}
                        </span>
                      </td>
                      <td style={{ fontSize: 13, padding: '9px 12px' }}>{s.teslim_eden_ad || '—'}</td>
                      <td style={{ fontSize: 13, padding: '9px 12px' }}>{s.teslim_alan_ad || '—'}</td>
                      <td style={{ textAlign: 'right', padding: '9px 12px' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            fontFamily: 'var(--font-mono)',
                            fontWeight: 800,
                            fontVariantNumeric: 'tabular-nums',
                            fontSize: 13,
                            color: 'rgb(22,163,74)',
                            background: 'rgba(34,197,94,.12)',
                            border: '1px solid rgba(34,197,94,.30)',
                            borderRadius: 8,
                            padding: '3px 10px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {fmt(s.tutar)} ₺
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{s.aciklama || '—'}</td>
                    </tr>
                  );
                });
                return out;
              })()}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 500 }}>
                <td colSpan={6} style={{ textAlign: 'right', paddingRight: 12, fontSize: 13 }}>
                  Toplam
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'rgb(22,163,74)' }}>{fmt(ozet.genel_toplam)} ₺</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Teslim Alıcı Yönetim Modalı */}
      {aliciModal && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setAliciModal(false)}>
          <div className="modal">
            <div className="modal-header">
              <h3>Teslim Alıcı Tanımları</h3>
              <button className="modal-close" onClick={() => setAliciModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {/* Mevcut alıcılar */}
              {alicilar.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>Tanımlı alıcılar</div>
                  {alicilar.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 10px',
                        borderRadius: 6,
                        marginBottom: 4,
                        background: 'var(--color-background-secondary)',
                        border: '0.5px solid var(--color-border-tertiary)',
                        fontSize: 13,
                      }}
                    >
                      <span>
                        <strong>{a.ad}</strong>
                        {a.unvan && <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>— {a.unvan}</span>}
                        {a.sube_adi && (
                          <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6, fontSize: 11 }}>({a.sube_adi})</span>
                        )}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setAliciForm({ ad: a.ad, unvan: a.unvan || '', sube_id: a.sube_id || '' });
                            setAliciDuzId(a.id);
                          }}
                        >
                          ✏️
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => aliciSil(a.id)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* Yeni / Düzenle formu */}
              <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  {aliciDuzId ? 'Düzenle' : 'Yeni Alıcı Ekle'}
                </div>
                <div className="form-group">
                  <label>Ad *</label>
                  <input
                    value={aliciForm.ad}
                    onChange={(e) => setAliciForm({ ...aliciForm, ad: e.target.value })}
                    placeholder="Onur, Fatma, Fethi..."
                  />
                </div>
                <div className="form-group">
                  <label>Unvan</label>
                  <input
                    value={aliciForm.unvan}
                    onChange={(e) => setAliciForm({ ...aliciForm, unvan: e.target.value })}
                    placeholder="Müdür, Kasiyer..."
                  />
                </div>
                <div className="form-group">
                  <label>Şube (boş = tüm şubeler)</label>
                  <select value={aliciForm.sube_id} onChange={(e) => setAliciForm({ ...aliciForm, sube_id: e.target.value })}>
                    <option value="">Tüm Şubeler</option>
                    {subeler.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.ad}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setAliciDuzId(null);
                  setAliciForm({ ad: '', unvan: '', sube_id: '' });
                }}
              >
                Temizle
              </button>
              <button className="btn btn-primary" onClick={aliciKaydet} disabled={!aliciForm.ad.trim()}>
                Kaydet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

