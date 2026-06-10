import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import GorevPersonelSayfasi from './GorevPersonelSayfasi';

// Kapanış onay butonu — QR okutunca karşılaşılan mühürleme ekranı
function KapaниsOnayButonu({ kp, subeId, konum }) {
  const [durum, setDurum] = useState(null); // null | 'yukleniyor' | 'tamam' | 'hata'
  const [hata, setHata] = useState('');

  const muhurle = async () => {
    setDurum('yukleniyor');
    try {
      await api('/gorev/kapanis-muhurle', {
        method: 'POST',
        body: {
          sube_id: subeId,
          personel_id: kp.personel_id,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      setDurum('tamam');
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('zaten')) { setDurum('tamam'); return; }
      setHata(msg || 'Hata oluştu');
      setDurum('hata');
    }
  };

  if (durum === 'tamam') return (
    <div style={{
      padding: '14px 16px', borderRadius: 10, marginBottom: 8,
      background: 'rgba(76,175,132,0.1)', border: '1px solid rgba(76,175,132,0.3)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 18 }}>🔒</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#4caf84' }}>Kapanış Mühürlendi</div>
        <div style={{ fontSize: 11, color: '#6b6f7a' }}>{kp.ad_soyad}</div>
      </div>
    </div>
  );

  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={muhurle}
        disabled={durum === 'yukleniyor'}
        style={{
          display: 'block', width: '100%', padding: '14px 16px', borderRadius: 10,
          cursor: 'pointer', background: 'rgba(200,149,106,0.1)',
          border: '1px solid rgba(200,149,106,0.4)', color: '#e8e9ec',
          fontSize: 15, fontWeight: 600, textAlign: 'left',
        }}>
        {durum === 'yukleniyor' ? '…' : `🔒 ${kp.ad_soyad} — Kapanışı Mühürle`}
      </button>
      {durum === 'hata' && (
        <div style={{ fontSize: 11, color: '#e05c5c', marginTop: 4, paddingLeft: 4 }}>{hata}</div>
      )}
    </div>
  );
}

/**
 * QR kod okutunca açılan sayfa: /gorev-giris/:subeId
 *
 * AKIŞ:
 *  A) Bekleyen devir varsa  → ad seç → "Devri Kabul Et" → içeri (PIN YOK)
 *  B) Devir yoksa           → PIN akışı (kapanış / tek kişi günü)
 *  C) /gorev-pin            → şube seç → sonra A veya B
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

      const kapanisBekleyenler = kapanisBilgi?.bekleyen || [];

      if (kapanisBekleyenler.length > 0) {
        setBekleyenKapanis(kapanisBekleyenler);
        setAdim('kapanis-onay');
      } else if (devirBilgi?.bekliyor) {
        setBekleyenDevir(devirBilgi);
        setAdim('devir-kabul');
      } else if (devirBilgi?.sabah_onay_bekliyor) {
        // Sabahçı devir onayı bekliyor — PIN ile giriş yaptıktan sonra kontrol edilecek
        setSabahDevirYap(devirBilgi);
        setAdim('pin-giris');
      } else {
        setAdim('pin-giris');
      }
    }).catch(() => setAdim('pin-giris'));
  }, [subeId]);

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
      // Sabahçı devir onayı bekliyor mu? Personel eşleşiyor mu?
      if (sabahDevirYap && String(sonuc.personel_id) === String(sabahDevirYap.devreden_id)) {
        setAdim('devir-yap');
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

  const vardiyaSec = (vt) => {
    setOturum({ ...pinDogruOturum, vardiya_tip: vt });
    setAdim('gorevler');
  };

  const cikis = () => {
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
    minHeight: '100vh', background: '#0f1117', color: '#e8e9ec',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 24, fontFamily: 'Instrument Sans, sans-serif',
  };
  const KART = {
    width: '100%', maxWidth: 380, background: '#1a1d24',
    border: '1px solid #2a2d35', borderRadius: 16, padding: 28,
  };

  return (
    <div style={PAGE}>
      <div style={KART}>

        {/* Başlık */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>☕</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {subeBilgi?.ad || 'Evvel Cafe'}
          </div>
          <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>
            {adim === 'kapanis-onay' ? 'Kapanış Onayı'
            : adim === 'devir-kabul' ? 'Vardiya Devri'
            : adim === 'devir-yap' ? 'Devir Onayı'
            : adim === 'devir-yap-tamam' ? 'Mesain Bitti'
            : 'Vardiya Girişi'}
          </div>
        </div>

        {/* ── Şube Seç (QR'sız mod) ── */}
        {adim === 'sube-sec' && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#b0b3bc', marginBottom: 12 }}>
              Hangi şube?
            </div>
            {subeler.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: '#6b6f7a' }}>
                <div className="spinner" style={{ margin: '0 auto 12px' }} />
              </div>
            ) : subeler.map(s => (
              <button key={s.id} onClick={() => subeSec(s)}
                style={{
                  display: 'block', width: '100%', padding: '14px 16px', borderRadius: 10,
                  marginBottom: 8, cursor: 'pointer', background: '#22262f',
                  border: '1px solid #2a2d35', color: '#e8e9ec', fontSize: 15,
                  fontWeight: 600, textAlign: 'left',
                }}>
                ☕ {s.ad}
              </button>
            ))}
          </div>
        )}

        {/* ── Yükleniyor ── */}
        {adim === 'yukleniyor' && (
          <div style={{ textAlign: 'center', padding: 20, color: '#6b6f7a' }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Kontrol ediliyor…
          </div>
        )}

        {/* ── KAPANIŞ ONAY — QR okutuldu, mühürle ── */}
        {adim === 'kapanis-onay' && (
          <div>
            <div style={{
              padding: '14px', borderRadius: 10, marginBottom: 20,
              background: 'rgba(200,149,106,0.08)', border: '1px solid rgba(200,149,106,0.35)',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#C8956A', marginBottom: 4 }}>
                🌙 Kapanış Onayı
              </div>
              <div style={{ fontSize: 11, color: '#6b6f7a', lineHeight: 1.6 }}>
                Bu şubede kapanış bekleyen personel var.<br />
                Adına tıkla → kapanış mühürlenir.
              </div>
            </div>

            {bekleyenKapanis.map(kp => (
              <KapaниsOnayButonu
                key={kp.personel_id}
                kp={kp}
                subeId={subeId}
                konum={konum}
              />
            ))}

            <button
              onClick={() => setAdim('pin-giris')}
              style={{
                marginTop: 16, width: '100%', padding: '10px', borderRadius: 8,
                border: '1px solid #2a2d35', background: 'none',
                color: '#6b6f7a', cursor: 'pointer', fontSize: 12,
              }}>
              Ben kapanış değilim, giriş yap
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
              <div style={{ fontSize: 12, color: '#b0b3bc', lineHeight: 1.6 }}>
                Merhaba <strong style={{ color: '#e8e9ec' }}>{pinDogruOturum.ad_soyad}</strong>,<br />
                panel ekranında doldurduğun bilgiler kaydedildi.
              </div>
            </div>
            {sabahDevirYap.form_ozet && (
              <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 16, background: '#22262f', border: '1px solid #2a2d35' }}>
                <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 8, fontWeight: 600 }}>DEVİR ÖZETİ</div>
                {[
                  ['💰 Kasadaki Nakit', sabahDevirYap.form_ozet.teslim + ' ₺'],
                  ['🥤 Küçük Bardak', sabahDevirYap.form_ozet.bardak_kucuk],
                  ['☕ Büyük Bardak', sabahDevirYap.form_ozet.bardak_buyuk],
                  ['🧊 Plastik', sabahDevirYap.form_ozet.bardak_plastik],
                  ['🎂 Pasta', sabahDevirYap.form_ozet.pasta_adet],
                  ['💧 Su', sabahDevirYap.form_ozet.su_adet],
                ].map(([lbl, val]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #2a2d35' }}>
                    <span style={{ color: '#b0b3bc' }}>{lbl}</span>
                    <span style={{ color: '#e8e9ec', fontWeight: 700 }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
            {hata && <div style={{ color: '#e05c5c', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>{hata}</div>}
            <button onClick={devirYap} disabled={yukleniyor} style={{
              display: 'block', width: '100%', padding: '18px', borderRadius: 12,
              cursor: 'pointer', background: yukleniyor ? '#22262f' : 'rgba(74,158,255,0.15)',
              border: '2px solid #4a9eff', color: '#4a9eff', fontSize: 17, fontWeight: 800,
            }}>
              {yukleniyor ? '⏳ Kaydediliyor…' : '✅ Devri Yap + Mesaimi Bitir'}
            </button>
            <div style={{ fontSize: 11, color: '#6b6f7a', textAlign: 'center', marginTop: 10 }}>
              📍 Konumun doğrulanacak — şubede olman gerekiyor
            </div>
          </div>
        )}

        {/* ── DEVİR YAP TAMAM ── */}
        {adim === 'devir-yap-tamam' && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#4caf84', marginBottom: 8 }}>Devir Tamamlandı</div>
            <div style={{ fontSize: 13, color: '#b0b3bc', lineHeight: 1.7 }}>
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
              <div style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b', marginBottom: 4 }}>
                Devir Seni Bekliyor
              </div>
              <div style={{ fontSize: 12, color: '#b0b3bc', lineHeight: 1.6 }}>
                <strong style={{ color: '#e8e9ec' }}>{bekleyenDevir.devreden_ad}</strong>{' '}
                vardiyayı sana devretti.
              </div>
              {bekleyenDevir.not_aciklama && (
                <div style={{
                  marginTop: 8, padding: '6px 10px', borderRadius: 8,
                  background: 'rgba(255,255,255,0.04)', fontSize: 12,
                  color: '#e8e9ec', textAlign: 'left',
                }}>
                  📝 {bekleyenDevir.not_aciklama}
                </div>
              )}
            </div>

            {/* Devir özeti */}
            {bekleyenDevir.form_ozet && (
              <div style={{ padding: '12px 14px', borderRadius: 10, marginBottom: 16, background: '#22262f', border: '1px solid #2a2d35' }}>
                <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 8, fontWeight: 600 }}>DEVREDİLEN DEĞERLER</div>
                {[
                  ['💰 Kasa Nakiti', bekleyenDevir.form_ozet.teslim + ' ₺'],
                  ['🥤 Küçük Bardak', bekleyenDevir.form_ozet.bardak_kucuk],
                  ['☕ Büyük Bardak', bekleyenDevir.form_ozet.bardak_buyuk],
                  ['🧊 Plastik', bekleyenDevir.form_ozet.bardak_plastik],
                  ['🎂 Pasta', bekleyenDevir.form_ozet.pasta_adet],
                  ['💧 Su', bekleyenDevir.form_ozet.su_adet],
                ].map(([lbl, val]) => (
                  <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid #2a2d35' }}>
                    <span style={{ color: '#b0b3bc' }}>{lbl}</span>
                    <span style={{ color: '#e8e9ec', fontWeight: 700 }}>{val}</span>
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
                <div style={{ fontSize: 13, fontWeight: 600, color: '#b0b3bc', marginBottom: 10, textAlign: 'center' }}>
                  Bu devir <strong style={{ color: '#e8e9ec' }}>{bekleyenDevir.devralan_ad}</strong> için bırakıldı.
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
                        color: '#f59e0b', fontSize: 15, fontWeight: 700,
                        opacity: yukleniyor ? 0.6 : 1,
                      }}>
                      {yukleniyor ? '…' : `✅ Ben ${bekleyenDevir.devralan_ad} — Kabul Ediyorum`}
                    </button>
                  );
                })()}
                <div style={{ marginTop: 10, fontSize: 11, color: '#6b6f7a', textAlign: 'center' }}>
                  Bu sen değilsen, hiçbir şeye dokunma — ekranı kapatabilirsin.
                </div>
              </div>
            ) : (
              <div>
                {/* Kim geldi? — ad seç (eski/açık devir akışı) */}
                <div style={{ fontSize: 13, fontWeight: 600, color: '#b0b3bc', marginBottom: 10 }}>
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
                        color: '#f59e0b', fontSize: 15, fontWeight: 700, textAlign: 'left',
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
                border: '1px solid #2a2d35', background: 'none',
                color: '#6b6f7a', fontSize: 12, cursor: 'pointer',
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
                  color: '#f59e0b', fontSize: 12, cursor: 'pointer', padding: '7px 12px',
                  width: '100%',
                }}>
                ← Devir Kabul ekranına dön
              </button>
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: '#b0b3bc', marginBottom: 12 }}>
              Sen kimsin?
            </div>
            {personelListe.map(p => (
              <button key={p.id}
                onClick={() => { setSeciliPersonel(p); setPin(''); setHata(''); }}
                style={{
                  display: 'block', width: '100%', padding: '14px 16px', borderRadius: 10,
                  marginBottom: 8, cursor: 'pointer', background: '#22262f',
                  border: '1px solid #2a2d35', color: '#e8e9ec', fontSize: 15,
                  fontWeight: 600, textAlign: 'left',
                }}>
                {p.ad_soyad}
                {!p.pin_tanimli && (
                  <span style={{ fontSize: 10, color: '#e05c5c', marginLeft: 8 }}>PIN yok</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* PIN tuş takımı */}
        {adim === 'pin-giris' && seciliPersonel && (
          <div>
            <button onClick={() => { setSeciliPersonel(null); setPin(''); setHata(''); }}
              style={{ background: 'none', border: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 13, marginBottom: 16, padding: 0 }}>
              ← Geri
            </button>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Merhaba, {seciliPersonel.ad_soyad}</div>
              <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>4 haneli PIN'ini gir</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{
                  width: 14, height: 14, borderRadius: '50%',
                  background: pin.length > i ? '#C8956A' : '#2a2d35',
                  border: `2px solid ${pin.length > i ? '#C8956A' : '#6b6f7a'}`,
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
                    fontWeight: 600, cursor: 'pointer', background: '#22262f',
                    border: '1px solid #2a2d35', color: k === 'sil' ? '#6b6f7a' : '#e8e9ec',
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
              <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 4 }}>{pinDogruOturum?.ad_soyad}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { id: 'sabahci',     label: '🌅 Sabahçı',    alt: 'Açılış ve sabah görevleri',     renk: '#4a9eff' },
                { id: 'ara_vardiya', label: '☀️ Ara Vardiya', alt: 'Depo, stok ve tuvalet',          renk: '#f59e0b' },
                { id: 'kapanis',     label: '🌙 Kapanış',    alt: 'Temizlik ve kapanış görevleri',  renk: '#C8956A' },
              ].map(vt => (
                <button key={vt.id} onClick={() => vardiyaSec(vt.id)}
                  style={{
                    padding: '16px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    background: '#22262f', border: `1px solid ${vt.renk}33`,
                  }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: vt.renk }}>{vt.label}</div>
                  <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 3 }}>{vt.alt}</div>
                </button>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
