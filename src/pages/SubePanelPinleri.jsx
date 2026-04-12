import { useState, useEffect } from 'react';
import { api } from '../utils/api';

export default function SubePanelPinleri() {
  const [liste, setListe] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [pinGuncelle, setPinGuncelle] = useState(null);
  const [yeniPin, setYeniPin] = useState('');

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = () => {
    setLoading(true);
    api('/sube-panel/merkez/personel-panel-pin')
      .then((rows) => setListe(Array.isArray(rows) ? rows : []))
      .catch(() => {
        setListe([]);
        toast('Liste alınamadı', 'red');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  async function pinKaydet() {
    if (!pinGuncelle) return;
    const pin = (yeniPin || '').trim();
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      toast('4 haneli PIN girin', 'red');
      return;
    }
    try {
      await api(
        `/sube-panel/merkez/personel/${encodeURIComponent(pinGuncelle.id)}/panel-pin`,
        { method: 'PUT', body: { pin } }
      );
      toast('PIN kaydedildi — tüm şube panellerinde geçerlidir');
      setPinGuncelle(null);
      setYeniPin('');
      load();
    } catch (e) {
      toast(e.message || 'Kayıt başarısız', 'red');
    }
  }

  async function yoneticiToggle(p, yonetici) {
    try {
      await api(
        `/sube-panel/merkez/personel/${encodeURIComponent(p.id)}/panel-yonetici`,
        { method: 'PUT', body: { yonetici } }
      );
      toast(yonetici ? 'Yönetici işaretlendi' : 'Yönetici kaldırıldı');
      load();
    } catch (e) {
      toast(e.message || 'İşlem başarısız', 'red');
    }
  }

  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto', padding: '1rem' }}>
      <h1 style={{ marginBottom: 8 }}>Personel panel PIN</h1>
      <p style={{ color: '#64748b', marginBottom: 24, fontSize: 14 }}>
        Aynı PIN tüm şube panellerinde (kasa kilidi, kapanış onayı, vardiya devri) geçerlidir. Tanım
        şube seçimine bağlı değildir; personel hangi şubede olursa olsun merkezden atanır.
      </p>

      {msg && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 16,
            background: msg.t === 'red' ? '#fee2e2' : '#dcfce7',
            color: msg.t === 'red' ? '#991b1b' : '#166534',
          }}
        >
          {msg.m}
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          ↻ Yenile
        </button>
      </div>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Aktif personel</h2>
        {loading ? (
          <p>Yükleniyor…</p>
        ) : liste.length === 0 ? (
          <p style={{ color: '#64748b' }}>Aktif personel kaydı yok.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
                <th style={{ padding: '8px 6px' }}>Ad soyad</th>
                <th style={{ padding: '8px 6px' }}>Şube (kayıt)</th>
                <th style={{ padding: '8px 6px' }}>PIN</th>
                <th style={{ padding: '8px 6px' }}>Yönetici</th>
                <th style={{ padding: '8px 6px' }} />
              </tr>
            </thead>
            <tbody>
              {liste.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 6px' }}>{p.ad_soyad}</td>
                  <td style={{ padding: '10px 6px' }}>{p.sube_adi || '—'}</td>
                  <td style={{ padding: '10px 6px' }}>
                    {p.panel_pin_tanimli ? (
                      <span style={{ color: '#166534' }}>Tanımlı</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>Yok</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 6px' }}>{p.yonetici ? 'Evet' : 'Hayır'}</td>
                  <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ marginRight: 8 }}
                      onClick={() => {
                        setPinGuncelle({ id: p.id, ad: p.ad_soyad });
                        setYeniPin('');
                      }}
                    >
                      PIN ata / değiştir
                    </button>
                    {p.yonetici ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => yoneticiToggle(p, false)}
                      >
                        Yönetici kaldır
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => yoneticiToggle(p, true)}
                      >
                        Yönetici yap
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {pinGuncelle && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            style={{
              background: '#fff',
              padding: 24,
              borderRadius: 12,
              minWidth: 300,
              boxShadow: '0 20px 50px rgba(0,0,0,0.15)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Panel PIN — {pinGuncelle.ad}</h3>
            <p style={{ fontSize: 13, color: '#64748b' }}>Bu PIN tüm şubelerdeki panel işlemlerinde kullanılır.</p>
            <input
              placeholder="4 haneli PIN"
              maxLength={4}
              inputMode="numeric"
              value={yeniPin}
              onChange={(e) => setYeniPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              style={{ width: '100%', padding: '10px 12px', marginBottom: 16, letterSpacing: '0.2em' }}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPinGuncelle(null)}>
                İptal
              </button>
              <button type="button" onClick={pinKaydet}>
                Kaydet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
