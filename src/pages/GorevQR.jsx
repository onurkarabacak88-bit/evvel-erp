import { useState, useEffect } from 'react';
import { api } from '../utils/api';

function KonumAyar({ sube }) {
  const [acik, setAcik] = useState(false);
  const [lat, setLat] = useState(sube.lat ?? '');
  const [lng, setLng] = useState(sube.lng ?? '');
  const [radius, setRadius] = useState(sube.konum_radius_m ?? 150);
  const [kayit, setKayit] = useState(null); // 'yukleniyor' | 'ok' | 'hata'

  const konumAl = () => {
    if (!navigator.geolocation) { setKayit('hata'); return; }
    setKayit('yukleniyor');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(7));
        setLng(pos.coords.longitude.toFixed(7));
        setKayit(null);
      },
      () => setKayit('gps-hata'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Google Maps'ten yapıştırılan koordinat metnini parse et
  // Desteklenen format: "37.1234567, 28.9876543"
  const [yapistir, setYapistir] = useState('');
  const yapistirParse = (val) => {
    setYapistir(val);
    const m = val.match(/([-\d.]+)[,\s]+([-\d.]+)/);
    if (m) { setLat(m[1].trim()); setLng(m[2].trim()); }
  };

  const kaydet = async () => {
    setKayit('yukleniyor');
    try {
      await api(`/gorev/sube-konum/${sube.sube_id}`, {
        method: 'PUT',
        body: { lat: parseFloat(lat), lng: parseFloat(lng), konum_radius_m: parseInt(radius) },
      });
      setKayit('ok');
      setTimeout(() => setKayit(null), 2000);
    } catch {
      setKayit('hata');
    }
  };

  const tanimliMi = sube.lat && sube.lng;

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <button
        onClick={() => setAcik(p => !p)}
        style={{
          width: '100%', padding: '7px 12px', borderRadius: 7, fontSize: 12,
          fontWeight: 600, cursor: 'pointer', textAlign: 'left',
          background: tanimliMi ? 'rgba(72,187,120,0.08)' : 'rgba(200,149,106,0.08)',
          border: `1px solid ${tanimliMi ? 'rgba(72,187,120,0.3)' : 'var(--accent-border)'}`,
          color: tanimliMi ? '#48bb78' : 'var(--accent)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        <span>📍</span>
        <span style={{ flex: 1 }}>
          {tanimliMi ? `Konum tanımlı (±${sube.konum_radius_m ?? 150}m)` : 'Konum henüz tanımlı değil'}
        </span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>{acik ? '▲' : '▼'}</span>
      </button>

      {acik && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Yöntem 1: Google Maps'ten yapıştır (önerilen) */}
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(74,158,255,0.06)', border: '1px solid rgba(74,158,255,0.2)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#4a9eff', marginBottom: 6 }}>
              📌 Google Maps'ten yapıştır (önerilen)
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8, lineHeight: 1.5 }}>
              maps.google.com'da şubeye sağ tıkla → koordinatı kopyala → aşağıya yapıştır
            </div>
            <input
              value={yapistir}
              onChange={e => yapistirParse(e.target.value)}
              placeholder='Örn: 37.1234567, 28.9876543'
              style={{
                width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 12,
                background: 'var(--bg3)', border: '1px solid rgba(74,158,255,0.3)',
                color: 'var(--text1)', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Yöntem 2: GPS */}
          <button
            onClick={konumAl}
            disabled={kayit === 'yukleniyor'}
            style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', background: 'var(--bg3)', border: '1px solid var(--border)',
              color: 'var(--text2)',
            }}
          >
            {kayit === 'yukleniyor' ? '…' : '📡 Şu anki GPS konumumu al'}
          </button>
          {kayit === 'gps-hata' && (
            <div style={{ fontSize: 11, color: '#e05c5c', lineHeight: 1.5 }}>
              Tarayıcı konum iznini reddetti. Yukarıdaki Google Maps yöntemini kullan.
            </div>
          )}

          {/* Koordinat göstergesi */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div>
              <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>Enlem (lat)</label>
              <input
                value={lat}
                onChange={e => setLat(e.target.value)}
                placeholder="37.123456"
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
                  background: 'var(--bg3)', border: '1px solid var(--border)',
                  color: 'var(--text1)', boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>Boylam (lng)</label>
              <input
                value={lng}
                onChange={e => setLng(e.target.value)}
                placeholder="28.987654"
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
                  background: 'var(--bg3)', border: '1px solid var(--border)',
                  color: 'var(--text1)', boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 10, color: 'var(--text3)', display: 'block', marginBottom: 3 }}>
              İzin verilen mesafe (metre)
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range" min="50" max="500" step="25"
                value={radius}
                onChange={e => setRadius(e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', minWidth: 40 }}>
                {radius}m
              </span>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
              Küçük şubeler için 100m, büyük için 200m önerilir
            </div>
          </div>

          <button
            onClick={kaydet}
            disabled={!lat || !lng || kayit === 'yukleniyor'}
            style={{
              padding: '9px 12px', borderRadius: 7, fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
              background: kayit === 'ok' ? 'rgba(72,187,120,0.15)' : 'var(--accent)',
              border: `1px solid ${kayit === 'ok' ? '#48bb78' : 'var(--accent)'}`,
              color: kayit === 'ok' ? '#48bb78' : '#fff',
            }}
          >
            {kayit === 'yukleniyor' ? 'Kaydediliyor…' : kayit === 'ok' ? '✓ Kaydedildi' : kayit === 'hata' ? '✗ Hata' : 'Kaydet'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function GorevQR() {
  const [subeler, setSubeler] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/gorev/qr-liste'),
      api('/subeler').catch(() => []),
    ]).then(([qrListe, subeDetaylar]) => {
      // lat/lng/radius bilgisini qr listesine ekle
      const detayMap = Object.fromEntries((subeDetaylar || []).map(s => [s.id, s]));
      setSubeler(qrListe.map(s => ({
        ...s,
        lat: detayMap[s.sube_id]?.lat ?? null,
        lng: detayMap[s.sube_id]?.lng ?? null,
        konum_radius_m: detayMap[s.sube_id]?.konum_radius_m ?? 150,
      })));
    })
    .catch(console.error)
    .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 12 }}>
      <div className="spinner" />
      <span style={{ fontSize: 13, color: 'var(--text3)' }}>QR kodlar hazırlanıyor…</span>
    </div>
  );

  const tanimliSayisi = subeler.filter(s => s.lat && s.lng).length;

  return (
    <div className="page">
      <div className="page-header">
        <h2>📱 Şube QR Kodları</h2>
        <p>Her şubenin kasasına asın. Personel okutunca görev listesine direkt ulaşır.</p>
      </div>

      {tanimliSayisi < subeler.length && (
        <div style={{
          marginBottom: 20, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(200,149,106,0.08)', border: '1px solid var(--accent-border)',
          fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
        }}>
          ⚠️ <strong>{subeler.length - tanimliSayisi} şube</strong> için konum tanımlı değil.
          Konum tanımlı olmayan şubelerde personel herhangi bir yerden giriş yapabilir.
          Her kartın altındaki <strong>Konum Ayarı</strong>'ndan şube koordinatını girin.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 20 }}>
        {subeler.map(s => (
          <div key={s.sube_id} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 20, textAlign: 'center',
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text1)', marginBottom: 16 }}>
              {s.sube_ad}
            </div>

            <div style={{
              background: '#fff', borderRadius: 10, padding: 12,
              display: 'inline-block', marginBottom: 14,
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            }}>
              <img
                src={s.qr_url}
                alt={`${s.sube_ad} QR`}
                style={{ width: 180, height: 180, display: 'block' }}
              />
            </div>

            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14, lineHeight: 1.5 }}>
              Personel bu kodu okutunca<br />
              görev listesine ulaşır
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <a
                href={s.qr_url}
                download={`${s.sube_ad}_qr.png`}
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  background: 'var(--accent-dim)', color: 'var(--accent)',
                  border: '1px solid var(--accent-border)', textDecoration: 'none',
                  cursor: 'pointer',
                }}
              >
                İndir
              </a>
              <a
                href={s.giris_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  background: 'var(--bg3)', color: 'var(--text2)',
                  border: '1px solid var(--border)', textDecoration: 'none',
                }}
              >
                Önizle
              </a>
            </div>

            <KonumAyar sube={s} />
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 24, padding: '12px 16px', borderRadius: 10,
        background: 'rgba(200,149,106,0.08)', border: '1px solid var(--accent-border)',
        fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
      }}>
        💡 <strong>Nasıl kullanılır?</strong> Her şube için QR kodu indirin, A4 kağıda yazdırın ve kasanın yanına asın.
        Personel sabah vardiyasına gelince telefonuyla okutur, adını seçer ve görevlerini görür.
        Konum tanımlıysa sistem personelin şubede olup olmadığını doğrular.
      </div>

      <div style={{
        marginTop: 12, padding: '12px 16px', borderRadius: 10,
        background: 'rgba(74,158,255,0.06)', border: '1px solid rgba(74,158,255,0.2)',
        fontSize: 12, color: 'var(--text2)', lineHeight: 1.8,
      }}>
        📱 <strong>QR'sız giriş:</strong> Personel QR taramadan da girebilir.
        Aşağıdaki linki telefona kaydetin veya paylaşın:
        <div style={{ marginTop: 8 }}>
          <a
            href={`${window.location.origin}/gorev-pin`}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-block', padding: '7px 14px', borderRadius: 8,
              background: 'rgba(74,158,255,0.12)', border: '1px solid rgba(74,158,255,0.3)',
              color: '#4a9eff', fontWeight: 700, fontSize: 12, textDecoration: 'none',
            }}
          >
            🔗 {window.location.origin}/gorev-pin
          </a>
        </div>
      </div>
    </div>
  );
}
