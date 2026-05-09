import { useState, useEffect, useMemo } from 'react';
import { api } from '../utils/api';

export default function SubePanelPinleri() {
  const [liste, setListe] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [pinGuncelle, setPinGuncelle] = useState(null);
  const [yeniPin, setYeniPin] = useState('');
  const [onayPersonelId, setOnayPersonelId] = useState('');
  const [onayPin, setOnayPin] = useState('');
  const [merkezMutasyonKey, setMerkezMutasyonKey] = useState('');

  const yoneticiVar = useMemo(() => liste.some((p) => p.yonetici), [liste]);
  const yoneticiler = useMemo(() => liste.filter((p) => p.yonetici), [liste]);

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

  useEffect(() => {
    try {
      const v = (localStorage.getItem('evvelMerkezMutasyonKey') || '').trim();
      setMerkezMutasyonKey(v);
    } catch {
      setMerkezMutasyonKey('');
    }
  }, []);

  function merkezAnahtarKaydet() {
    try {
      const v = (merkezMutasyonKey || '').trim();
      if (v) localStorage.setItem('evvelMerkezMutasyonKey', v);
      else localStorage.removeItem('evvelMerkezMutasyonKey');
      toast(v ? 'Merkez mutasyon anahtarı tarayıcıda saklandı' : 'Anahtar silindi', 'green');
    } catch {
      toast('localStorage kullanılamıyor', 'red');
    }
  }

  function onayGovdesi() {
    if (!yoneticiVar) return {};
    const pid = (onayPersonelId || '').trim();
    const pin = (onayPin || '').trim().replace(/\s/g, '');
    return { onaylayan_personel_id: pid, onaylayan_pin: pin };
  }

  function onayKontrol() {
    if (!yoneticiVar) return true;
    const pid = (onayPersonelId || '').trim();
    const pin = (onayPin || '').trim().replace(/\s/g, '');
    if (!pid || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      toast('Panel yöneticisi seçin ve 4 haneli onay PIN girin', 'red');
      return false;
    }
    return true;
  }

  async function pinKaydet() {
    if (!pinGuncelle) return;
    const pin = (yeniPin || '').trim();
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      toast('4 haneli PIN girin', 'red');
      return;
    }
    if (!onayKontrol()) return;
    try {
      await api(
        `/sube-panel/merkez/personel/${encodeURIComponent(pinGuncelle.id)}/panel-pin`,
        { method: 'PUT', body: { pin, ...onayGovdesi() } }
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
    if (!onayKontrol()) return;
    try {
      await api(
        `/sube-panel/merkez/personel/${encodeURIComponent(p.id)}/panel-yonetici`,
        { method: 'PUT', body: { yonetici, ...onayGovdesi() } }
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

      <details style={{ marginBottom: 20, fontSize: 13, color: '#475569' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Faz 3 — sunucu mutasyon anahtarı (isteğe bağlı)</summary>
        <p style={{ marginTop: 10, marginBottom: 8 }}>
          Üretimde <code style={{ fontSize: 12 }}>EVVEL_MERKEZ_MUTASYON_ANAHTARI</code> tanımlıysa PIN / yönetici
          değişiklikleri için <code style={{ fontSize: 12 }}>X-Evvel-Merkez-Key</code> başlığı gerekir. Değeri
          buraya yazıp kaydedin; tarayıcı yalnızca bu cihazda saklar.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input
            type="password"
            autoComplete="off"
            placeholder="Sunucu ile aynı anahtar"
            value={merkezMutasyonKey}
            onChange={(e) => setMerkezMutasyonKey(e.target.value)}
            style={{ flex: '1 1 220px', padding: '8px 10px', minWidth: 180 }}
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={merkezAnahtarKaydet}>
            Kaydet / temizle
          </button>
        </div>
      </details>

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

      {yoneticiVar && (
        <section
          style={{
            marginBottom: 20,
            padding: 16,
            borderRadius: 10,
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
          }}
        >
          <h2 style={{ fontSize: 15, margin: '0 0 10px' }}>Panel yöneticisi onayı</h2>
          <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 12px' }}>
            En az bir yönetici tanımlıyken PIN veya yönetici rolü değişiklikleri için bir yöneticinin
            kimliği ve PIN&apos;i gerekir.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
              <span style={{ fontSize: 12, color: '#475569' }}>Onaylayan yönetici</span>
              <select
                className="btn btn-secondary btn-sm"
                style={{ padding: '8px 10px', minWidth: 200 }}
                value={onayPersonelId}
                onChange={(e) => setOnayPersonelId(e.target.value)}
              >
                <option value="">Seçin</option>
                {yoneticiler.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.ad_soyad}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: '#475569' }}>Yönetici PIN</span>
              <input
                placeholder="••••"
                maxLength={4}
                inputMode="numeric"
                value={onayPin}
                onChange={(e) => setOnayPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ padding: '8px 12px', letterSpacing: '0.2em', width: 120 }}
              />
            </label>
          </div>
        </section>
      )}

      {!yoneticiVar && liste.length > 0 && (
        <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
          İlk kurulum: henüz panel yöneticisi yok; PIN ve yönetici atamaları onaysız yapılabilir.
          En az bir yöneticiyi işaretledikten sonra değişiklikler için yönetici onayı istenir.
        </p>
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
