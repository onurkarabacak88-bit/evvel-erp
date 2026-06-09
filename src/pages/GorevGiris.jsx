import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import GorevPersonelSayfasi from './GorevPersonelSayfasi';

/**
 * QR kod okutunca açılan sayfa: /gorev-giris/:subeId
 * Sidebar/nav yok — tam ekran, mobil öncelikli.
 */
export default function GorevGiris({ subeId }) {
  const [adim, setAdim] = useState('personel-sec'); // personel-sec | pin-gir | vardiya-sec | gorevler
  const [subeBilgi, setSubeBilgi] = useState(null);
  const [personelListe, setPersonelListe] = useState([]);
  const [seciliPersonel, setSeciliPersonel] = useState(null);
  const [pin, setPin] = useState('');
  const [hata, setHata] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [oturum, setOturum] = useState(null);
  const [konum, setKonum] = useState(null); // { lat, lng } | null
  const [konumHata, setKonumHata] = useState(null);

  // Sayfa açılır açılmaz konum iste
  useEffect(() => {
    if (!navigator.geolocation) {
      setKonumHata('Tarayıcın konum desteklemiyor.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setKonum({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setKonumHata('Konum izni reddedildi. Şubeye giriş için konum gereklidir.'),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  useEffect(() => {
    if (!subeId) return;
    Promise.all([
      api(`/gorev/sube-personel/${subeId}`),
      api(`/subeler`).catch(() => null),
    ]).then(([personeller, subeler]) => {
      setPersonelListe(personeller || []);
      if (subeler) {
        const s = (Array.isArray(subeler) ? subeler : subeler.subeler || [])
          .find(x => x.id === subeId);
        setSubeBilgi(s || null);
      }
    }).catch(console.error).finally(() => setYukleniyor(false));
  }, [subeId]);

  const pinGir = (k) => {
    if (k === 'sil') { setPin(p => p.slice(0, -1)); return; }
    if (pin.length >= 4) return;
    const yeni = pin + k;
    setPin(yeni);
    if (yeni.length === 4) girisYap(yeni);
  };

  const [pinDogruOturum, setPinDogruOturum] = useState(null);

  const girisYap = async (pinVal) => {
    setHata('');
    setYukleniyor(true);
    try {
      const sonuc = await api('/gorev/pin-giris', {
        method: 'POST',
        body: {
          sube_id: subeId,
          personel_id: seciliPersonel.id,
          pin: pinVal,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      setPinDogruOturum(sonuc);
      setAdim('vardiya-sec');
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) {
        setHata('📍 ' + msg.split('|')[1]);
      } else if (msg.startsWith('konum_gerekli|')) {
        setHata('📍 ' + msg.split('|')[1]);
      } else {
        setHata(msg || 'PIN hatalı');
      }
      setPin('');
    } finally {
      setYukleniyor(false);
    }
  };

  const vardiyaSec = (vt) => {
    setOturum({ ...pinDogruOturum, vardiya_tip: vt });
    setAdim('gorevler');
  };

  const cikis = () => {
    setAdim('personel-sec');
    setSeciliPersonel(null);
    setPin('');
    setOturum(null);
    setHata('');
  };

  // ── Görevler ekranı ──
  if (adim === 'gorevler' && oturum) {
    return (
      <GorevPersonelSayfasi
        oturum={oturum}
        subeBilgi={subeBilgi}
        onCikis={cikis}
      />
    );
  }

  // ── Stil sabitleri (mobil) ──
  const PAGE = {
    minHeight: '100vh', background: '#0f1117', color: '#e8e9ec',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24, fontFamily: 'Instrument Sans, sans-serif',
  };
  const KART = {
    width: '100%', maxWidth: 380, background: '#1a1d24',
    border: '1px solid #2a2d35', borderRadius: 16, padding: 28,
  };

  if (yukleniyor) return (
    <div style={PAGE}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>☕</div>
      <div style={{ fontSize: 14, color: '#6b6f7a' }}>Yükleniyor…</div>
    </div>
  );

  // Konum izni reddedildiyse engelle
  if (konumHata) return (
    <div style={PAGE}>
      <div style={{ ...KART, textAlign: 'center' }}>
        <div style={{ fontSize: 36, marginBottom: 16 }}>📍</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#e8e9ec', marginBottom: 8 }}>
          Konum İzni Gerekli
        </div>
        <div style={{ fontSize: 13, color: '#6b6f7a', lineHeight: 1.6 }}>
          {konumHata}
        </div>
        <div style={{ fontSize: 12, color: '#4a5568', marginTop: 16 }}>
          Tarayıcı ayarlarından konum iznini açıp sayfayı yenile.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 20, padding: '12px 24px', borderRadius: 10, cursor: 'pointer',
            background: '#C8956A', border: 'none', color: '#fff', fontWeight: 700, fontSize: 14,
          }}
        >
          Yenile
        </button>
      </div>
    </div>
  );

  return (
    <div style={PAGE}>
      <div style={KART}>
        {/* Başlık */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>☕</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#e8e9ec' }}>
            {subeBilgi?.ad || 'Evvel Cafe'}
          </div>
          <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>
            Görev Listesi
          </div>
        </div>

        {/* Adım 1: Personel seç */}
        {adim === 'personel-sec' && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#b0b3bc', marginBottom: 12 }}>
              Sen kimsin?
            </div>
            {personelListe.length === 0 ? (
              <div style={{ fontSize: 13, color: '#6b6f7a', textAlign: 'center', padding: 20 }}>
                Bu şube için personel tanımlı değil.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {personelListe.map(p => (
                  <button key={p.id}
                    onClick={() => { setSeciliPersonel(p); setAdim('pin-gir'); setPin(''); setHata(''); }}
                    style={{
                      padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                      background: '#22262f', border: '1px solid #2a2d35',
                      color: '#e8e9ec', fontSize: 15, fontWeight: 600, textAlign: 'left',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = '#2a2d35'}
                    onMouseLeave={e => e.currentTarget.style.background = '#22262f'}
                  >
                    {p.ad_soyad}
                    {!p.pin_tanimli && (
                      <span style={{ fontSize: 10, color: '#e05c5c', marginLeft: 8 }}>PIN yok</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Adım 2.5: Vardiya seç */}
        {adim === 'vardiya-sec' && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#e8e9ec' }}>
                Hangi vardiya?
              </div>
              <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>
                {pinDogruOturum?.ad_soyad}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { id: 'sabahci',     label: '🌅 Sabahçı',     alt: 'Açılış ve sabah görevleri',  renk: '#4a9eff' },
                { id: 'ara_vardiya', label: '☀️ Ara Vardiya',  alt: 'Depo, stok ve tuvalet',       renk: '#f59e0b' },
                { id: 'kapanis',     label: '🌙 Kapanış',     alt: 'Temizlik ve kapanış görevleri', renk: '#C8956A' },
              ].map(vt => (
                <button key={vt.id} onClick={() => vardiyaSec(vt.id)}
                  style={{
                    padding: '16px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    background: '#22262f', border: `1px solid ${vt.renk}33`,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#2a2d35'}
                  onMouseLeave={e => e.currentTarget.style.background = '#22262f'}
                >
                  <div style={{ fontSize: 15, fontWeight: 700, color: vt.renk }}>{vt.label}</div>
                  <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 3 }}>{vt.alt}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Adım 2: PIN gir */}
        {adim === 'pin-gir' && (
          <div>
            <button onClick={() => { setAdim('personel-sec'); setPin(''); setHata(''); }}
              style={{ background: 'none', border: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 13, marginBottom: 16, padding: 0 }}>
              ← Geri
            </button>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#e8e9ec' }}>
                Merhaba, {seciliPersonel?.ad_soyad}
              </div>
              <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>4 haneli PIN'ini gir</div>
            </div>

            {/* PIN göstergesi */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{
                  width: 14, height: 14, borderRadius: '50%',
                  background: pin.length > i ? '#C8956A' : '#2a2d35',
                  border: '2px solid',
                  borderColor: pin.length > i ? '#C8956A' : '#6b6f7a',
                  transition: 'all 0.15s',
                }} />
              ))}
            </div>

            {/* Hata */}
            {hata && (
              <div style={{ textAlign: 'center', color: '#e05c5c', fontSize: 12, marginBottom: 16 }}>
                {hata}
              </div>
            )}

            {/* Tuş takımı */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {['1','2','3','4','5','6','7','8','9','','0','sil'].map((k, i) => (
                k === '' ? <div key={i} /> :
                <button key={i} onClick={() => pinGir(k)}
                  disabled={yukleniyor}
                  style={{
                    padding: '18px 0', borderRadius: 10, fontSize: k === 'sil' ? 18 : 22,
                    fontWeight: 600, cursor: 'pointer',
                    background: k === 'sil' ? '#22262f' : '#22262f',
                    border: '1px solid #2a2d35', color: k === 'sil' ? '#6b6f7a' : '#e8e9ec',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#2a2d35'}
                  onMouseLeave={e => e.currentTarget.style.background = '#22262f'}
                >
                  {k === 'sil' ? '⌫' : k}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
