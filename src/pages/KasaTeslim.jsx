import { useState, useEffect, useMemo } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

const TUR_LABEL = {
  ara: { label: 'Ara Teslim', renk: '#BA7517', bg: 'rgba(186,117,23,.10)' },
  gun_sonu: { label: 'Gün Sonu', renk: 'var(--color-text-primary)', bg: 'var(--color-background-secondary)' },
};

export default function KasaTeslim() {
  const bugun = new Date().toISOString().split('T')[0];
  const [satirlar, setSatirlar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [alicilar, setAlicilar] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  // Filtreler
  const [subeFiltre, setSubeFiltre] = useState('');
  const [turFiltre, setTurFiltre] = useState('');
  const [aliciFiltre, setAliciFiltre] = useState('');
  const [edenFiltre, setEdenFiltre] = useState('');
  const [tarihBas, setTarihBas] = useState(bugun);
  const [tarihBit, setTarihBit] = useState(bugun);

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
    const qs = new URLSearchParams();
    if (subeFiltre) qs.set('sube_id', subeFiltre);
    if (turFiltre) qs.set('teslim_turu', turFiltre);
    if (aliciFiltre) qs.set('teslim_alan_id', aliciFiltre);
    if (edenFiltre) qs.set('teslim_eden_ad', edenFiltre);
    if (tarihBas) qs.set('tarih_baslangic', tarihBas);
    if (tarihBit) qs.set('tarih_bitis', tarihBit);
    qs.set('limit', '500');
    api(`/kasa-teslim?${qs}`)
      .then((r) => setSatirlar(r.satirlar || []))
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

  // Özet hesapla
  const ozet = useMemo(() => {
    const ara = satirlar.filter((s) => s.teslim_turu === 'ara');
    const gunSonu = satirlar.filter((s) => s.teslim_turu === 'gun_sonu');
    return {
      ara_adet: ara.length,
      ara_toplam: ara.reduce((a, s) => a + s.tutar, 0),
      sonu_adet: gunSonu.length,
      sonu_toplam: gunSonu.reduce((a, s) => a + s.tutar, 0),
      genel_toplam: satirlar.reduce((a, s) => a + s.tutar, 0),
    };
  }, [satirlar]);

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

      {/* Özet kartlar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
        <div className="metric-card">
          <div className="metric-label">Ara Teslim</div>
          <div className="metric-val" style={{ color: '#BA7517' }}>
            {fmt(ozet.ara_toplam)}
            <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>({ozet.ara_adet} adet)</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Gün Sonu</div>
          <div className="metric-val">
            {fmt(ozet.sonu_toplam)}
            <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>({ozet.sonu_adet} adet)</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Genel Toplam</div>
          <div className="metric-val" style={{ color: 'var(--color-text-success)' }}>
            {fmt(ozet.genel_toplam)}
          </div>
        </div>
      </div>

      {/* Filtreler */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 16 }}>
        <div className="form-group">
          <label>Tarih Başlangıç</label>
          <input type="date" value={tarihBas} onChange={(e) => setTarihBas(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Tarih Bitiş</label>
          <input type="date" value={tarihBit} onChange={(e) => setTarihBit(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Şube</label>
          <select value={subeFiltre} onChange={(e) => setSubeFiltre(e.target.value)}>
            <option value="">Tüm Şubeler</option>
            {subeler.map((s) => (
              <option key={s.id} value={s.id}>
                {s.ad}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Tür</label>
          <select value={turFiltre} onChange={(e) => setTurFiltre(e.target.value)}>
            <option value="">Tümü</option>
            <option value="ara">Ara Teslim</option>
            <option value="gun_sonu">Gün Sonu</option>
          </select>
        </div>
        <div className="form-group">
          <label>Teslim Alan</label>
          <select value={aliciFiltre} onChange={(e) => setAliciFiltre(e.target.value)}>
            <option value="">Tümü</option>
            {alicilar.map((a) => (
              <option key={a.id} value={a.id}>
                {a.ad}
                {a.unvan ? ` — ${a.unvan}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Teslim Eden</label>
          <input value={edenFiltre} onChange={(e) => setEdenFiltre(e.target.value)} placeholder="İsim ara..." />
        </div>
      </div>

      {/* Tablo */}
      {loading ? (
        <div className="loading">
          <div className="spinner" />
          Yükleniyor…
        </div>
      ) : satirlar.length === 0 ? (
        <div className="empty">
          <p>Kayıt bulunamadı</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Saat</th>
                <th>Şube</th>
                <th>Tür</th>
                <th>Teslim Eden</th>
                <th>Teslim Alan</th>
                <th style={{ textAlign: 'right' }}>Tutar</th>
                <th>Açıklama</th>
              </tr>
            </thead>
            <tbody>
              {satirlar.map((s) => {
                const tur = TUR_LABEL[s.teslim_turu] || TUR_LABEL.gun_sonu;
                const saat = s.olusturma
                  ? new Date(s.olusturma).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
                  : '—';
                return (
                  <tr key={s.id} style={{ background: tur.bg }}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {s.tarih}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {saat}
                    </td>
                    <td style={{ fontWeight: 500 }}>{s.sube_adi}</td>
                    <td>
                      <span
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 500,
                          background: s.teslim_turu === 'ara' ? 'rgba(186,117,23,.15)' : 'var(--color-background-secondary)',
                          color: tur.renk,
                          border: `1px solid ${
                            s.teslim_turu === 'ara' ? 'rgba(186,117,23,.3)' : 'var(--color-border-tertiary)'
                          }`,
                        }}
                      >
                        {tur.label}
                      </span>
                    </td>
                    <td style={{ fontSize: 13 }}>{s.teslim_eden_ad || '—'}</td>
                    <td style={{ fontSize: 13 }}>{s.teslim_alan_ad || '—'}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{fmt(s.tutar)}</td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{s.aciklama || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 500 }}>
                <td colSpan={6} style={{ textAlign: 'right', paddingRight: 12, fontSize: 13 }}>
                  Toplam
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmt(ozet.genel_toplam)}</td>
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

