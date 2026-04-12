import { useState, useEffect } from 'react';
import { api } from '../utils/api';

export default function SubePanelPinleri() {
  const [subeler, setSubeler] = useState([]);
  const [subeId, setSubeId] = useState('');
  const [liste, setListe] = useState([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ ad: '', pin: '', personel_id: '' });
  const [pinGuncelle, setPinGuncelle] = useState(null); // { id, ad }
  const [yeniPin, setYeniPin] = useState('');
  const [personeller, setPersoneller] = useState([]);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 4000);
  };

  useEffect(() => {
    api('/subeler')
      .then((rows) => {
        setSubeler(Array.isArray(rows) ? rows : []);
        if (rows?.length && !subeId) setSubeId(rows[0].id);
      })
      .catch(() => toast('Şubeler yüklenemedi', 'red'));
  }, []);

  useEffect(() => {
    if (!subeId) return;
    setLoading(true);
    api(`/sube-panel/merkez/${encodeURIComponent(subeId)}/panel-pin-kullanicilar`)
      .then((rows) => setListe(Array.isArray(rows) ? rows : []))
      .catch(() => {
        setListe([]);
        toast('Liste alınamadı', 'red');
      })
      .finally(() => setLoading(false));
  }, [subeId]);

  useEffect(() => {
    api('/personel?aktif=true')
      .then((p) => setPersoneller(Array.isArray(p) ? p : []))
      .catch(() => setPersoneller([]));
  }, []);

  const personelBuSube = (p) => !p.sube_id || p.sube_id === subeId;

  async function yeniKayit() {
    const ad = (form.ad || '').trim();
    const pin = (form.pin || '').trim();
    if (!ad || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      toast('Ad ve 4 haneli PIN girin', 'red');
      return;
    }
    try {
      await api(`/sube-panel/${encodeURIComponent(subeId)}/panel-kullanici`, {
        method: 'POST',
        body: {
          ad,
          pin,
          personel_id: form.personel_id || null,
        },
      });
      toast('Panel kullanıcısı eklendi');
      setForm({ ad: '', pin: '', personel_id: '' });
      const rows = await api(
        `/sube-panel/merkez/${encodeURIComponent(subeId)}/panel-pin-kullanicilar`
      );
      setListe(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast(e.message || 'Kayıt başarısız', 'red');
    }
  }

  async function pinKaydet() {
    if (!pinGuncelle) return;
    const pin = (yeniPin || '').trim();
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      toast('4 haneli PIN girin', 'red');
      return;
    }
    try {
      await api(
        `/sube-panel/merkez/${encodeURIComponent(subeId)}/panel-kullanici/${encodeURIComponent(pinGuncelle.id)}/pin`,
        { method: 'PUT', body: { pin } }
      );
      toast('PIN güncellendi');
      setPinGuncelle(null);
      setYeniPin('');
      const rows = await api(
        `/sube-panel/merkez/${encodeURIComponent(subeId)}/panel-pin-kullanicilar`
      );
      setListe(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast(e.message || 'Güncelleme başarısız', 'red');
    }
  }

  return (
    <div className="page" style={{ maxWidth: 920, margin: '0 auto', padding: '1rem' }}>
      <h1 style={{ marginBottom: 8 }}>Şube panel PIN</h1>
      <p style={{ color: '#64748b', marginBottom: 24, fontSize: 14 }}>
        Şube açılışında günlük kasa kilidini açmak için kullanılan panel kullanıcıları ve 4 haneli PIN
        buradan tanımlanır. Şube ekranında personel kendini seçip PIN girer.
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

      <div style={{ marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          Şube{' '}
          <select
            value={subeId}
            onChange={(e) => setSubeId(e.target.value)}
            style={{ marginLeft: 8, padding: '6px 10px' }}
          >
            {subeler.map((s) => (
              <option key={s.id} value={s.id}>
                {s.ad}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          padding: 20,
          marginBottom: 24,
          background: '#fafafa',
        }}
      >
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Yeni panel kullanıcısı</h2>
        <div style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
          <input
            placeholder="Görünen ad (örn. Sabah sorumlusu)"
            value={form.ad}
            onChange={(e) => setForm({ ...form, ad: e.target.value })}
            style={{ padding: '8px 12px' }}
          />
          <select
            value={form.personel_id}
            onChange={(e) => setForm({ ...form, personel_id: e.target.value })}
            style={{ padding: '8px 12px' }}
          >
            <option value="">Personel eşlemesi (isteğe bağlı)</option>
            {personeller.filter(personelBuSube).map((p) => (
              <option key={p.id} value={p.id}>
                {p.ad_soyad}
                {p.sube_id ? '' : ' (şubesiz)'}
              </option>
            ))}
          </select>
          <input
            placeholder="4 haneli PIN"
            maxLength={4}
            inputMode="numeric"
            value={form.pin}
            onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
            style={{ padding: '8px 12px', letterSpacing: '0.2em' }}
          />
          <button type="button" onClick={yeniKayit} style={{ padding: '10px 16px', cursor: 'pointer' }}>
            Kaydet
          </button>
        </div>
      </section>

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Kayıtlı kullanıcılar</h2>
        {loading ? (
          <p>Yükleniyor…</p>
        ) : liste.length === 0 ? (
          <p style={{ color: '#64748b' }}>Bu şubede henüz panel kullanıcısı yok.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
                <th style={{ padding: '8px 6px' }}>Ad</th>
                <th style={{ padding: '8px 6px' }}>Personel</th>
                <th style={{ padding: '8px 6px' }}>Durum</th>
                <th style={{ padding: '8px 6px' }} />
              </tr>
            </thead>
            <tbody>
              {liste.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 6px' }}>{u.ad}</td>
                  <td style={{ padding: '10px 6px' }}>
                    {u.personel_ad_soyad || '—'}
                  </td>
                  <td style={{ padding: '10px 6px' }}>{u.aktif ? 'Aktif' : 'Pasif'}</td>
                  <td style={{ padding: '10px 6px' }}>
                    <button
                      type="button"
                      disabled={!u.aktif}
                      onClick={() => {
                        setPinGuncelle({ id: u.id, ad: u.ad });
                        setYeniPin('');
                      }}
                      style={{ padding: '6px 12px', cursor: u.aktif ? 'pointer' : 'not-allowed' }}
                    >
                      PIN sıfırla
                    </button>
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
            <h3 style={{ marginTop: 0 }}>Yeni PIN — {pinGuncelle.ad}</h3>
            <input
              placeholder="4 haneli yeni PIN"
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
