import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import GorevPersonelSayfasi from './GorevPersonelSayfasi';
import tulipiLogo from '../assets/tulipi-logo.jpg';

// Marka rozeti — logoyu koyu yuvarlak rozete oturt (siyah zemin kasıtlı dursun)
function MarkaLogo({ size = 56 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: '#000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 2px 10px rgba(200,149,106,0.25)', flexShrink: 0,
    }}>
      <img src={tulipiLogo} alt="TuliPi Coffee" style={{ width: size * 0.78, height: size * 0.78, objectFit: 'contain' }} />
    </div>
  );
}

// Saate göre selamlama + o anki vardiya bağlamı
function selamlamaBilgi() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11)  return { selam: 'Günaydın',     vardiya: 'Sabah vardiyası',   saat: '07:00 – 15:00' };
  if (h >= 11 && h < 16) return { selam: 'İyi günler',    vardiya: 'Ara vardiya',       saat: '11:00 – 19:00' };
  if (h >= 16 && h < 23) return { selam: 'İyi akşamlar',  vardiya: 'Kapanış vardiyası', saat: '15:00 – 23:00' };
  return { selam: 'İyi mesailer', vardiya: 'Gece', saat: '' };
}

// Kişi baş harf rozeti — addan üretilen renkli daire
const AVATAR_RENK = ['#C8956A', '#4a9eff', '#4caf84', '#e08a5c', '#9b7bd4', '#d4756b'];
function basHarf(ad) {
  const p = String(ad || '').trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}
function Avatar({ ad, size = 44 }) {
  const s = String(ad || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const renk = AVATAR_RENK[h % AVATAR_RENK.length];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: renk + '22',
      color: renk, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: 700, fontSize: size * 0.36, flexShrink: 0, border: `1.5px solid ${renk}55`,
    }}>{basHarf(ad)}</div>
  );
}

// ── Telefon oturumu — localStorage (QR'sız tekrar giriş) ───────────────────────
function bugunStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localOturumOku(subeId) {
  if (!subeId) return null;
  try {
    const raw = localStorage.getItem(`gorev_oturum_${subeId}`);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.tarih !== bugunStr()) return null;
    return obj;
  } catch { return null; }
}

function localOturumYaz(subeId, sonuc) {
  if (!subeId || !sonuc) return;
  try {
    localStorage.setItem(`gorev_oturum_${subeId}`, JSON.stringify({ ...sonuc, kayit_zamani: Date.now() }));
  } catch {}
}

function localOturumSil(subeId) {
  if (!subeId) return;
  try { localStorage.removeItem(`gorev_oturum_${subeId}`); } catch {}
}

/**
 * QR kod okutunca açılan sayfa: /gorev-giris/:subeId
 *
 * AKIŞ:
 *  A) Bekleyen devir varsa  → ad seç → "Devri Kabul Et" → içeri (PIN YOK)
 *  B) Devir yoksa           → PIN akışı (kapanış / tek kişi günü)
 *  C) /gorev-pin            → şube seç → sonra A veya B
 *
 * Telefon oturumu (PIN sonrası) localStorage'a kaydedilir — aynı gün içinde
 * sayfa tekrar açıldığında PIN tekrar istenmez, bekleyen devir onayları
 * otomatik kart olarak çıkar (QR'a gerek kalmaz).
 */
export default function GorevGiris({ subeId: subeIdProp }) {
  const [subeId, setSubeId]         = useState(subeIdProp || null);
  const [subeBilgi, setSubeBilgi]   = useState(null);
  const [subeler, setSubeler]       = useState([]);
  const [personelListe, setPersonelListe] = useState([]);

  // Adımlar: sube-sec | devir-kabul | pin-giris | vardiya-sec | gorevler
  const [adim, setAdim] = useState(subeIdProp ? 'yukleniyor' : 'sube-sec');

  const [bekleyenDevir, setBekleyenDevir] = useState(null);       // akşamcı için (bekliyor)
  const [sabahDevirYap, setSabahDevirYap] = useState(null);       // sabahçı için (form_kaydedildi)
  const [bekleyenKapanis, setBekleyenKapanis] = useState([]);
  const [seciliPersonel, setSeciliPersonel] = useState(null);

  // PIN akışı state
  const [pin, setPin]         = useState('');
  const [hata, setHata]       = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);
  const [pinDogruOturum, setPinDogruOturum] = useState(null);

  const [oturum, setOturum] = useState(null);
  const [konum, setKonum]   = useState(null);
  const [cikisUyari, setCikisUyari] = useState(null);  // "çıkış yapmayı unuttun" (otomatik kapatma)

  // Şube listesi (QR'sız mod)
  useEffect(() => {
    if (subeIdProp) return;
    api('/subeler').then(d => {
      const liste = Array.isArray(d) ? d : d.subeler || [];
      setSubeler(liste.filter(s => s.aktif !== false));
    }).catch(() => {});
  }, []);

  // Şube yüklenince: personel + bekleyen devir
  useEffect(() => {
    if (!subeId) return;
    setAdim('yukleniyor');
    Promise.all([
      api(`/gorev/sube-personel/${subeId}`),
      api(`/subeler`).catch(() => null),
      api(`/gorev/devir-bekleyen?sube_id=${subeId}`).catch(() => null),
      api(`/gorev/kapanis-bekleyen?sube_id=${subeId}`).catch(() => null),
    ]).then(([personeller, subelerRes, devirBilgi, kapanisBilgi]) => {
      setPersonelListe(personeller || []);

      if (subelerRes) {
        const s = (Array.isArray(subelerRes) ? subelerRes : subelerRes.subeler || [])
          .find(x => x.id === subeId);
        setSubeBilgi(s || null);
        // Konum arka planda al
        if (s?.lat && s?.lng && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            p => setKonum({ lat: p.coords.latitude, lng: p.coords.longitude }),
            () => {},
            { enableHighAccuracy: true, timeout: 10000 }
          );
        }
      }

      setBekleyenKapanis(kapanisBilgi?.bekleyen || []);
      const localOturum = localOturumOku(subeId);

      if (devirBilgi?.bekliyor) {
        setBekleyenDevir(devirBilgi);
        setAdim('devir-kabul');
      } else if (devirBilgi?.sabah_onay_bekliyor) {
        setSabahDevirYap(devirBilgi);
        if (localOturum && String(localOturum.personel_id) === String(devirBilgi.devreden_id)) {
          // Telefon zaten oturum açmış — PIN tekrar istenmeden devir onay kartını göster
          setPinDogruOturum(localOturum);
          setAdim('devir-yap');
        } else {
          setAdim('pin-giris');
        }
      } else if (localOturum) {
        // Bekleyen onay yok — telefon oturumu varsa direkt görevlere geç (PIN'siz)
        setOturum(localOturum);
        setAdim('gorevler');
      } else {
        setAdim('pin-giris');
      }
    }).catch(() => setAdim('pin-giris'));
  }, [subeId]);

  // Bekleyen onay kartlarının otomatik çıkması için polling (PIN/oturum öncesi)
  useEffect(() => {
    if (!subeId) return;
    if (!['pin-giris', 'devir-kabul'].includes(adim)) return;
    const t = setInterval(() => {
      Promise.all([
        api(`/gorev/devir-bekleyen?sube_id=${subeId}`).catch(() => null),
        api(`/gorev/kapanis-bekleyen?sube_id=${subeId}`).catch(() => null),
      ]).then(([devirBilgi, kapanisBilgi]) => {
        setBekleyenKapanis(kapanisBilgi?.bekleyen || []);
        const localOturum = localOturumOku(subeId);
        if (devirBilgi?.bekliyor) {
          setBekleyenDevir(devirBilgi);
          if (adim === 'pin-giris' && !seciliPersonel) setAdim('devir-kabul');
        } else if (devirBilgi?.sabah_onay_bekliyor) {
          setSabahDevirYap(devirBilgi);
          if (localOturum && String(localOturum.personel_id) === String(devirBilgi.devreden_id) && adim === 'pin-giris' && !seciliPersonel) {
            setPinDogruOturum(localOturum);
            setAdim('devir-yap');
          }
        }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [subeId, adim, seciliPersonel]);

  // ── Akış fonksiyonları ───────────────────────────────────────────────────────

  const subeSec = (sube) => {
    setSubeId(sube.id);
    setSubeBilgi(sube);
  };

  // Sabahçı devir onayı (telefondan)
  const devirYap = async () => {
    if (!sabahDevirYap || !pinDogruOturum) return;
    setYukleniyor(true);
    setHata('');
    try {
      await api('/gorev/devir-sabah-onayla', {
        method: 'POST',
        body: {
          sube_id: subeId,
          personel_id: pinDogruOturum.personel_id,
          devir_id: sabahDevirYap.devir_id,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      // Mesai bitti — çıkış ekranı göster
      localOturumSil(subeId);
      setAdim('devir-yap-tamam');
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) setHata('📍 ' + msg.split('|')[1]);
      else setHata(msg || 'Hata oluştu');
    } finally {
      setYukleniyor(false);
    }
  };

  // Devir kabul (PIN YOK — ad seçimiyle)
  const devirKabulEt = async (personel) => {
    if (!bekleyenDevir) return;
    setYukleniyor(true);
    setHata('');
    try {
      const sonuc = await api('/gorev/devir-giris', {
        method: 'POST',
        body: {
          sube_id: subeId,
          personel_id: personel.id,
          devir_id: bekleyenDevir.devir_id,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      localOturumYaz(subeId, sonuc);
      setOturum(sonuc);
      setAdim('gorevler');
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) setHata('📍 ' + msg.split('|')[1]);
      else setHata(msg || 'Hata oluştu');
    } finally {
      setYukleniyor(false);
    }
  };

  // PIN akışı (kapanış / tek kişi)
  const pinGir = (k) => {
    if (k === 'sil') { setPin(p => p.slice(0, -1)); return; }
    if (pin.length >= 4) return;
    const yeni = pin + k;
    setPin(yeni);
    if (yeni.length === 4) girisYap(yeni);
  };

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
      setCikisUyari(sonuc?.cikis_unutuldu_uyari || null);
      localOturumYaz(subeId, sonuc);

      // Sabahçı devir onayı bekliyor mu? — anlık kontrol (state bayatlamış olabilir)
      const taze = await api(`/gorev/devir-bekleyen?sube_id=${subeId}`).catch(() => null);
      const devirHedefi = taze !== null ? taze : sabahDevirYap;
      if (devirHedefi?.sabah_onay_bekliyor && String(sonuc.personel_id) === String(devirHedefi.devreden_id)) {
        setSabahDevirYap(devirHedefi);
        setAdim('devir-yap');
      } else if (bekleyenKapanis.some(kp => String(kp.personel_id) === String(sonuc.personel_id))) {
        // Kendine ait, mühürlenmemiş bir kapanış kaydı var — sadece kendisi mühürleyebilir
        setOturum(sonuc);
        setAdim('kapanis-onay-self');
      } else {
        setOturum(sonuc);
        setAdim('gorevler');
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) setHata('📍 ' + msg.split('|')[1]);
      else if (msg.startsWith('konum_gerekli|')) setHata('📍 ' + msg.split('|')[1]);
      else setHata(msg || 'PIN hatalı');
      setPin('');
    } finally {
      setYukleniyor(false);
    }
  };

  // Kişi PIN ile kendini doğruladıktan sonra, kendi açık kapanışını mühürler
  const kapanisMuhurleSelf = async () => {
    if (!oturum) return;
    setYukleniyor(true);
    try {
      await api('/gorev/kapanis-muhurle', {
        method: 'POST',
        body: {
          sube_id: subeId,
          personel_id: oturum.personel_id,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
    } catch (e) {
      // "zaten mühürlü" gibi hatalar akışı bozmasın
    } finally {
      setYukleniyor(false);
      setAdim('gorevler');
    }
  };

  const vardiyaSec = (vt) => {
    const yeniOturum = { ...pinDogruOturum, vardiya_tip: vt };
    localOturumYaz(subeId, yeniOturum);
    setOturum(yeniOturum);
    setAdim('gorevler');
  };

  const cikis = () => {
    localOturumSil(subeId);
    setAdim(subeIdProp ? (bekleyenDevir ? 'devir-kabul' : 'pin-giris') : 'sube-sec');
    setSeciliPersonel(null);
    setPin('');
    setOturum(null);
    setHata('');
    if (!subeIdProp) { setSubeId(null); setSubeBilgi(null); setPersonelListe([]); setBekleyenDevir(null); }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (adim === 'gorevler' && oturum) {
    return <GorevPersonelSayfasi oturum={oturum} subeBilgi={subeBilgi} onCikis={cikis} />;
  }

  const PAGE = {
    minHeight: '100vh', background: '#F4EFE9', color: '#2A241E',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24, fontFamily: 'Instrument Sans, sans-serif',
  };
  const KART = {
    width: '100%', maxWidth: 380, background: '#FFFFFF',
    border: '1px solid #E6DED4', borderRadius: 20, padding: 28,
    boxShadow: '0 8px 30px rgba(120,90,60,0.10)',
  };

  return (
    <div style={PAGE}>
      <div style={KART}>

        {/* "Çıkış yapmayı unuttun" uyarısı — önceki mesai otomatik kapatıldıysa */}
        {cikisUyari && (
          <div
            onClick={() => setCikisUyari(null)}
            style={{
              background: 'rgba(245,158,11,0.15)',
              border: '1px solid rgba(245,158,11,0.5)',
              borderRadius: 12,
              padding: '14px 16px',
              marginBottom: 16,
              cursor: 'pointer',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <div style={{ fontSize: 22, flexShrink: 0 }}>🕒</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--orange)', marginBottom: 2 }}>
                Çıkış yapmayı unutmuşsun
              </div>
              <div style={{ fontSize: 13, color: '#6B5E50', lineHeight: 1.4 }}>{cikisUyari}</div>
              <div style={{ fontSize: 11, color: '#9C8E7E', marginTop: 6 }}>(kapatmak için dokun)</div>
            </div>
          </div>
        )}

        {/* Başlık */}
        <div style={{ textAlign: 'center', marginBottom: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ marginBottom: 10 }}><MarkaLogo size={58} /></div>
          <div style={{ fontSize: 19, fontWeight: 700, color: '#2A241E' }}>
            {subeBilgi?.ad || 'TuliPi Coffee'}
          </div>
          <div style={{ fontSize: 12, color: '#9C8E7E', marginTop: 4 }}>
            {adim === 'kapanis-onay-self' ? 'Kapanış Mührü'
            : adim === 'devir-kabul' ? 'Vardiya Devri'
            : adim === 'devir-yap' ? 'Devir Onayı'
            : adim === 'devir-yap-tamam' ? 'Mesain Bitti'
            : 'Vardiya Girişi'}
          </div>
          {(() => { const sb = selamlamaBilgi(); return (
            <div style={{ marginTop: 12, width: '100%', background: 'rgba(200,149,106,0.10)', border: '1px solid rgba(200,149,106,0.28)', borderRadius: 12, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#8a5a32' }}>{sb.selam} 👋</div>
                <div style={{ fontSize: 11, color: '#9C8E7E', marginTop: 1 }}>Şu an: {sb.vardiya}{sb.saat ? ` · ${sb.saat}` : ''}</div>
              </div>
            </div>
          ); })()}
        </div>

        {/* ── Şube Seç (QR'sız mod) ── */}
        {adim === 'sube-sec' && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6B5E50', marginBottom: 12 }}>
              Hangi şube?
            </div>
            {subeler.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#9C8E7E' }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
              </div>
            ) : subeler.map(s => (
              <button key={s.id} onClick={() => subeSec(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '14px 16px', borderRadius: 12,
                  marginBottom: 8, cursor: 'pointer', background: '#F7F2EC',
                  border: '1px solid #E6DED4', color: '#2A241E', fontSize: 15,
                  fontWeight: 600, textAlign: 'left',
                }}>
                <span style={{ width: 26, height: 26, borderRadius: 8, background: 'rgba(200,149,106,0.16)', color: '#C8956A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>☕</span>
                {s.ad}
              </button>
            ))}
          </div>
        )}

        {/* ── Yükleniyor ── */}
        {adim === 'yukleniyor' && (
          <div style={{ textAlign: 'center', padding: 20, color: '#9C8E7E' }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Kontrol ediliyor…
          </div>
        )}

        {/* ── KAPANIŞ MÜHRÜ — PIN ile kimlik doğrulandı, sadece kendi açık kaydını mühürleyebilir ── */}
        {adim === 'kapanis-onay-self' && oturum && (
          <div>
            <div style={{
              padding: '14px', borderRadius: 10, marginBottom: 20,
              background: 'rgba(200,149,106,0.08)', border: '1px solid rgba(200,149,106,0.35)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#C8956A', marginBottom: 4 }}>
                🌙 Açık Kapanış Kaydın Var
              </div>
              <div style={{ fontSize: 11, color: '#9C8E7E', lineHeight: 1.6 }}>
                {oturum.ad_soyad} — bugünkü kapanışını şimdi mühürlemek ister misin?
              </div>
            </div>

            <button
              onClick={kapanisMuhurleSelf}
              disabled={yukleniyor}
              style={{
                display: 'block', width: '100%', padding: '14px 16px', borderRadius: 10,
                marginBottom: 8, cursor: 'pointer', background: 'rgba(200,149,106,0.1)',
                border: '1px solid rgba(200,149,106,0.4)', color: '#2A241E',
                fontSize: 15, fontWeight: 600, textAlign: 'left',
              }}>
              {yukleniyor ? '…' : '🔒 Kapanışımı Mühürle'}
            </button>

            <button
              onClick={() => setAdim('gorevler')}
              disabled={yukleniyor}
              style={{
                width: '100%', padding: '10px', borderRadius: 8,
                border: '1px solid #E6DED4', background: 'none',
                color: '#9C8E7E', cursor: 'pointer', fontSize: 12,
              }}>
              Hayır, devam et
            </button>
          </div>
        )}

        {/* ── DEVİR YAP — Sabahçı telefondan onaylar ── */}
        {adim === 'devir-yap' && sabahDevirYap && pinDogruOturum && (
          <div>
            <div style={{
              padding: '16px', borderRadius: 10, marginBottom: 16,
              background: 'rgba(74,158,255,0.08)', border: '1px solid rgba(74,158,255,0.35)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>💼</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#4a9eff', marginBottom: 4 }}>
                Devri Onayla ve Mesaini Bitir
              </div>
              <div style={{ fontSize: 12, color: '#6B5E50', lineHeight: 1.6 }}>
                Merhaba <strong style={{ color: '#2A241E' }}>{pinDogruOturum.ad_soyad}</strong>,<br />
                panel ekranında doldurduğun bilgiler kaydedildi.
              </div>
            </div>
            {sabahDevirYap.form_ozet && (
              <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 16, background: '#F7F2EC', border: '1px solid #E6DED4' }}>
                <div style={{ fontSize: 11, color: '#9C8E7E', marginBottom: 8, fontWeight: 600 }}>DEVİR ÖZETİ</div>
                {[
                  ['💰 Kasadaki Nakit', sabahDevirYap.form_ozet.teslim + ' ₺'],
                  ['🥤 Küçük Bardak', sabahDevirYap.form_ozet.bardak_kucuk],
                  ['☕ Büyük Bardak', sabahDevirYap.form_ozet.bardak_buyuk],
                  ['🧊 Plastik', sabahDevirYap.form_ozet.bardak_plastik],
                  ['🎂 Pasta', sabahDevirYap.form_ozet.pasta_adet],
                  ['💧 Su', sabahDevirYap.form_ozet.su_adet],
                ].map(([lbl, val]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #E6DED4' }}>
                    <span style={{ color: '#6B5E50' }}>{lbl}</span>
                    <span style={{ color: '#2A241E', fontWeight: 700 }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
            {hata && <div style={{ color: '#e05c5c', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>{hata}</div>}
            <button onClick={devirYap} disabled={yukleniyor} style={{
              display: 'block', width: '100%', padding: '18px', borderRadius: 12,
              cursor: 'pointer', background: yukleniyor ? '#F7F2EC' : 'rgba(74,158,255,0.15)',
              border: '2px solid #4a9eff', color: '#4a9eff', fontSize: 17, fontWeight: 800,
            }}>
              {yukleniyor ? '⏳ Kaydediliyor…' : '✅ Devri Yap + Mesaimi Bitir'}
            </button>
            <div style={{ fontSize: 11, color: '#9C8E7E', textAlign: 'center', marginTop: 10 }}>
              📍 Konumun doğrulanacak — şubede olman gerekiyor
            </div>
          </div>
        )}

        {/* ── DEVİR YAP TAMAM ── */}
        {adim === 'devir-yap-tamam' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#4caf84', marginBottom: 8 }}>Devir Tamamlandı</div>
            <div style={{ fontSize: 13, color: '#6B5E50', lineHeight: 1.7 }}>
              Mesain sona erdi.<br />Akşamcı devralmayı bekliyor.<br />İyi dinlenmeler! ☕
            </div>
          </div>
        )}

        {/* ── DEVİR KABUL — Ad seç, PIN yok ── */}
        {adim === 'devir-kabul' && bekleyenDevir && (
          <div>
            {/* Devir bilgi kartı */}
            <div style={{
              padding: '14px', borderRadius: 10, marginBottom: bekleyenDevir.form_ozet ? 12 : 20,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 20, marginBottom: 6 }}>🔄</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--orange)', marginBottom: 4 }}>
                Devir Seni Bekliyor
              </div>
              <div style={{ fontSize: 12, color: '#6B5E50', lineHeight: 1.6 }}>
                <strong style={{ color: '#2A241E' }}>{bekleyenDevir.devreden_ad}</strong>{' '}
                vardiyayı sana devretti.
              </div>
              {bekleyenDevir.not_aciklama && (
                <div style={{
                  marginTop: 8, padding: '6px 10px', borderRadius: 8,
                  background: 'rgba(255,255,255,0.04)', fontSize: 12,
                  color: '#2A241E', textAlign: 'left',
                }}>
                  📝 {bekleyenDevir.not_aciklama}
                </div>
              )}
            </div>

            {/* Devir özeti */}
            {bekleyenDevir.form_ozet && (
              <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 16, background: '#F7F2EC', border: '1px solid #E6DED4' }}>
                <div style={{ fontSize: 11, color: '#9C8E7E', marginBottom: 8, fontWeight: 600 }}>DEVREDİLEN DEĞERLER</div>
                {[
                  ['💰 Kasa Nakiti', bekleyenDevir.form_ozet.teslim + ' ₺'],
                  ['🥤 Küçük Bardak', bekleyenDevir.form_ozet.bardak_kucuk],
                  ['☕ Büyük Bardak', bekleyenDevir.form_ozet.bardak_buyuk],
                  ['🧊 Plastik', bekleyenDevir.form_ozet.bardak_plastik],
                  ['🎂 Pasta', bekleyenDevir.form_ozet.pasta_adet],
                  ['💧 Su', bekleyenDevir.form_ozet.su_adet],
                ].map(([lbl, val]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #E6DED4' }}>
                    <span style={{ color: '#6B5E50' }}>{lbl}</span>
                    <span style={{ color: '#2A241E', fontWeight: 700 }}>{val}</span>
                  </div>
                ))}
              </div>
            )}

            {hata && (
              <div style={{ color: '#e05c5c', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
                {hata}
              </div>
            )}

            {bekleyenDevir.devralan_id ? (
              /* Devir hedefi belli — sadece o kişi kabul edebilir */
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#6B5E50', marginBottom: 10, textAlign: 'center' }}>
                  Bu devir <strong style={{ color: '#2A241E' }}>{bekleyenDevir.devralan_ad}</strong> için bırakıldı.
                </div>
                {(() => {
                  const hedef = personelListe.find(p => String(p.id) === String(bekleyenDevir.devralan_id));
                  return (
                    <button
                      onClick={() => hedef ? devirKabulEt(hedef) : setHata('Hedef personel bulunamadı.')}
                      disabled={yukleniyor}
                      style={{
                        width: '100%', padding: '16px', borderRadius: 10, cursor: 'pointer',
                        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
                        color: 'var(--orange)', fontSize: 15, fontWeight: 700,
                        opacity: yukleniyor ? 0.6 : 1,
                      }}>
                      {yukleniyor ? '…' : `✅ Ben ${bekleyenDevir.devralan_ad} — Kabul Ediyorum`}
                    </button>
                  );
                })()}
                <div style={{ marginTop: 10, fontSize: 11, color: '#9C8E7E', textAlign: 'center' }}>
                  Bu sen değilsen, hiçbir şeye dokunma — ekranı kapatabilirsin.
                </div>
              </div>
            ) : (
              <div>
                {/* Kim geldi? — ad seç (eski/açık devir akışı) */}
                <div style={{ fontSize: 13, fontWeight: 600, color: '#6B5E50', marginBottom: 10 }}>
                  Sen kimsin?
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {personelListe.map(p => (
                    <button key={p.id}
                      onClick={() => devirKabulEt(p)}
                      disabled={yukleniyor}
                      style={{
                        padding: '15px 16px', borderRadius: 10, cursor: 'pointer',
                        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
                        color: 'var(--orange)', fontSize: 15, fontWeight: 700, textAlign: 'left',
                        opacity: yukleniyor ? 0.6 : 1,
                      }}>
                      ✅ {p.ad_soyad}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Devir yoksa PIN ile geç (yönetici / istisnai) */}
            <button onClick={() => setAdim('pin-giris')}
              style={{
                marginTop: 14, width: '100%', padding: '9px', borderRadius: 8,
                border: '1px solid #E6DED4', background: 'none',
                color: '#9C8E7E', fontSize: 12, cursor: 'pointer',
              }}>
              🔐 PIN ile giriş (kapanış / yönetici)
            </button>
          </div>
        )}

        {/* ── PIN GİRİŞ — kapanış / tek kişi ── */}
        {adim === 'pin-giris' && !seciliPersonel && (
          <div>
            {bekleyenDevir && (
              <button onClick={() => setAdim('devir-kabul')}
                style={{
                  marginBottom: 12, background: 'rgba(245,158,11,0.08)',
                  border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8,
                  color: 'var(--orange)', fontSize: 12, cursor: 'pointer', padding: '7px 12px',
                  width: '100%',
                }}>
                ← Devir Kabul ekranına dön
              </button>
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#6B5E50', marginBottom: 12 }}>
              Sen kimsin?
            </div>
            {personelListe.map(p => (
              <button key={p.id}
                onClick={() => { setSeciliPersonel(p); setPin(''); setHata(''); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', borderRadius: 12,
                  marginBottom: 8, cursor: 'pointer', background: '#F7F2EC',
                  border: '1px solid #E6DED4', color: '#2A241E', fontSize: 15,
                  fontWeight: 600, textAlign: 'left',
                }}>
                <Avatar ad={p.ad_soyad} size={38} />
                <span style={{ flex: 1 }}>{p.ad_soyad}</span>
                {!p.pin_tanimli && (
                  <span style={{ fontSize: 10, color: '#e05c5c' }}>PIN yok</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* PIN tuş takımı */}
        {adim === 'pin-giris' && seciliPersonel && (
          <div>
            <button onClick={() => { setSeciliPersonel(null); setPin(''); setHata(''); }}
              style={{ background: 'none', border: 'none', color: '#9C8E7E', cursor: 'pointer', fontSize: 13, marginBottom: 16, padding: 0 }}>
              ← Geri
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
              <div style={{ marginBottom: 8 }}><Avatar ad={seciliPersonel.ad_soyad} size={54} /></div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#2A241E' }}>Merhaba, {seciliPersonel.ad_soyad}</div>
              <div style={{ fontSize: 12, color: '#9C8E7E', marginTop: 4 }}>4 haneli PIN'ini gir</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{
                  width: 14, height: 14, borderRadius: '50%',
                  background: pin.length > i ? '#C8956A' : '#E6DED4',
                  border: `2px solid ${pin.length > i ? '#C8956A' : '#9C8E7E'}`,
                  transition: 'all 0.15s',
                }} />
              ))}
            </div>
            {hata && (
              <div style={{ textAlign: 'center', color: '#e05c5c', fontSize: 12, marginBottom: 16 }}>
                {hata}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {['1','2','3','4','5','6','7','8','9','','0','sil'].map((k, i) => (
                k === '' ? <div key={i} /> :
                <button key={i} onClick={() => pinGir(k)} disabled={yukleniyor}
                  style={{
                    padding: '18px 0', borderRadius: 10, fontSize: k === 'sil' ? 18 : 22,
                    fontWeight: 600, cursor: 'pointer', background: '#F7F2EC',
                    border: '1px solid #E6DED4', color: k === 'sil' ? '#9C8E7E' : '#2A241E',
                  }}>
                  {k === 'sil' ? '⌫' : k}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Vardiya Seç (PIN'den sonra, plan yoksa) ── */}
        {adim === 'vardiya-sec' && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Hangi vardiya?</div>
              <div style={{ fontSize: 12, color: '#9C8E7E', marginTop: 4 }}>{pinDogruOturum?.ad_soyad}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { id: 'sabahci',     label: '🌅 Sabahçı',    alt: 'Açılış ve sabah görevleri',     renk: '#4a9eff' },
                { id: 'ara_vardiya', label: '☀️ Ara Vardiya', alt: 'Depo, stok ve tuvalet',          renk: 'var(--orange)' },
                { id: 'kapanis',     label: '🌙 Kapanış',    alt: 'Temizlik ve kapanış görevleri',  renk: '#C8956A' },
              ].map(vt => (
                <button key={vt.id} onClick={() => vardiyaSec(vt.id)}
                  style={{
                    padding: '16px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    background: '#F7F2EC', border: `1px solid ${vt.renk}33`,
                  }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: vt.renk }}>{vt.label}</div>
                  <div style={{ fontSize: 11, color: '#9C8E7E', marginTop: 3 }}>{vt.alt}</div>
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
