import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../utils/api';

const VT_ETIKET = {
  sabahci:     { label: 'Sabahçı',    renk: '#4a9eff' },
  ara_vardiya: { label: 'Ara Vardiya', renk: '#f59e0b' },
  kapanis:     { label: 'Kapanış',    renk: '#C8956A' },
};

// ── Mobil Sipariş Ekranı ─────────────────────────────────────────────────────
function SiparisEkrani({ oturum, subeBilgi, onKapat }) {
  const [katalog, setKatalog] = useState(null);
  const [sepet, setSepet] = useState({}); // urun_id → {urun_ad, kategori_id, adet}
  const [not, setNot] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [gonderiyor, setGonderiyor] = useState(false);
  const [sonuc, setSonuc] = useState(null); // 'ok' | 'hata' | 'cift'
  const [hataMsg, setHataMsg] = useState('');
  const [acikKat, setAcikKat] = useState(null);

  useEffect(() => {
    api(`/sube-panel/${oturum.sube_id}/siparis-katalog`)
      .then(d => {
        setKatalog(d.kategoriler || []);
        if (d.kategoriler?.length) setAcikKat(d.kategoriler[0].id);
      })
      .catch(() => setKatalog([]))
      .finally(() => setYukleniyor(false));
  }, []);

  const ayarla = (kat_db_id, urun, delta) => {
    setSepet(prev => {
      const key = urun.id;
      const mevcut = prev[key]?.adet || 0;
      const yeni = Math.max(0, mevcut + delta);
      if (yeni === 0) {
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: { urun_ad: urun.ad, kategori_id: kat_db_id, urun_id: urun.id, adet: yeni } };
    });
  };

  // Mutlak değer ata (çift-tıkla rakam girişi — 50 kez +'a basma derdi olmasın)
  const ayarlaMutlak = (kat_db_id, urun, deger) => {
    const n = Math.max(0, parseInt(deger, 10) || 0);
    setSepet(prev => {
      const key = urun.id;
      if (n === 0) { const { [key]: _, ...rest } = prev; return rest; }
      return { ...prev, [key]: { urun_ad: urun.ad, kategori_id: kat_db_id, urun_id: urun.id, adet: n } };
    });
  };
  const sipTapRef = useRef({ key: '', ts: 0 });
  const adetCiftTik = (kat_db_id, urun, mevcut) => {
    // Çift-tık (350ms) → rakam sor (kaza ile değişmesin)
    const now = Date.now();
    const r = sipTapRef.current;
    if (r.key === urun.id && now - r.ts < 350) {
      sipTapRef.current = { key: '', ts: 0 };
      const g = window.prompt(`${urun.ad} — adet gir:`, String(mevcut));
      if (g !== null) ayarlaMutlak(kat_db_id, urun, g);
    } else {
      sipTapRef.current = { key: urun.id, ts: now };
    }
  };

  const sepetSayisi = Object.values(sepet).reduce((s, x) => s + x.adet, 0);

  const gonder = async (force = false) => {
    const kalemler = Object.values(sepet);
    if (!kalemler.length) return;
    setGonderiyor(true);
    try {
      await api(`/sube-panel/${oturum.sube_id}/siparis-yoklama`, {
        method: 'POST',
        body: {
          personel_id: oturum.personel_id,
          kalemler,
          not_aciklama: not || null,
          force_cift_siparis: force,
        },
      });
      setSonuc('ok');
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('CIFT_SIPARIS') || msg.includes('Tamamlanmamış')) {
        setSonuc('cift');
        setHataMsg(msg || 'Açık sipariş var.');
      } else {
        setSonuc('hata');
        setHataMsg(msg || 'Hata oluştu.');
      }
    } finally {
      setGonderiyor(false);
    }
  };

  const S = {
    page: { minHeight: '100vh', background: '#0f1117', color: '#e8e9ec', fontFamily: 'Instrument Sans, sans-serif' },
    hdr: { padding: '14px 16px', borderBottom: '1px solid #2a2d35', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, background: '#0f1117', zIndex: 10 },
    btn: (renk) => ({ padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 14, background: renk, color: '#fff' }),
  };

  if (sonuc === 'ok') return (
    <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Sipariş Gönderildi!</div>
        <div style={{ fontSize: 13, color: '#6b6f7a', marginBottom: 24 }}>Merkez siparişini aldı.</div>
        <button onClick={onKapat} style={S.btn('#C8956A')}>Görevlere Dön</button>
      </div>
    </div>
  );

  if (sonuc === 'cift') return (
    <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: 32, maxWidth: 340 }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Açık Sipariş Var</div>
        <div style={{ fontSize: 13, color: '#6b6f7a', marginBottom: 24, lineHeight: 1.6 }}>{hataMsg}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button onClick={() => setSonuc(null)} style={{ ...S.btn('#2a2d35'), color: '#e8e9ec' }}>Geri Dön</button>
          <button onClick={() => { setSonuc(null); gonder(true); }} style={S.btn('#f59e0b')}>Yine de Gönder</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.hdr}>
        <button onClick={onKapat} style={{ background: 'none', border: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 20, padding: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>📦 Sipariş Ver</div>
          <div style={{ fontSize: 11, color: '#6b6f7a' }}>{subeBilgi?.ad} · {oturum.ad_soyad}</div>
        </div>
        {sepetSayisi > 0 && (
          <div style={{ background: '#C8956A', borderRadius: 20, padding: '3px 10px', fontSize: 12, fontWeight: 700 }}>
            {sepetSayisi} ürün
          </div>
        )}
      </div>

      {yukleniyor ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#6b6f7a' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Katalog yükleniyor…
        </div>
      ) : !katalog?.length ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#6b6f7a' }}>Katalog bulunamadı.</div>
      ) : (
        <div style={{ paddingBottom: 120 }}>
          {/* Kategori sekmeler */}
          <div style={{ display: 'flex', gap: 8, padding: '12px 16px', overflowX: 'auto', borderBottom: '1px solid #2a2d35' }}>
            {katalog.map(kat => {
              const seciliSayisi = (kat.items || []).reduce((s, u) => s + (sepet[u.id]?.adet || 0), 0);
              return (
                <button key={kat.id} onClick={() => setAcikKat(kat.id)}
                  style={{
                    padding: '7px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', position: 'relative',
                    background: acikKat === kat.id ? '#C8956A' : '#22262f',
                    color: acikKat === kat.id ? '#fff' : '#b0b3bc',
                  }}>
                  {kat.label || kat.ad}
                  {seciliSayisi > 0 && (
                    <span style={{
                      marginLeft: 6, background: acikKat === kat.id ? 'rgba(255,255,255,0.3)' : '#C8956A',
                      borderRadius: 10, padding: '1px 6px', fontSize: 10, fontWeight: 800, color: '#fff',
                    }}>{seciliSayisi}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Ürünler */}
          <div style={{ padding: '8px 16px' }}>
            {katalog.filter(k => k.id === acikKat).map(kat =>
              (kat.items || []).filter(u => u.aktif !== false).map(urun => {
                const adet = sepet[urun.id]?.adet || 0;
                return (
                  <div key={urun.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '13px 0', borderBottom: '1px solid #1e2028',
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: adet > 0 ? 700 : 400, color: adet > 0 ? '#e8e9ec' : '#b0b3bc' }}>
                        {urun.ad}
                      </div>
                      {urun.aciklama && <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 2 }}>{urun.aciklama}</div>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {adet > 0 && (
                        <>
                          <button onClick={() => ayarla(kat.db_kategori_id || kat.id, urun, -1)}
                            style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid #2a2d35', background: '#22262f', color: '#e8e9ec', fontSize: 20, cursor: 'pointer', fontWeight: 700 }}>−</button>
                          <span onClick={() => adetCiftTik(kat.db_kategori_id || kat.id, urun, adet)}
                            title="Çift dokun → rakam gir"
                            style={{ fontSize: 18, fontWeight: 800, minWidth: 28, textAlign: 'center', color: '#C8956A', cursor: 'pointer', userSelect: 'none' }}>{adet}</span>
                        </>
                      )}
                      <button onClick={() => ayarla(kat.db_kategori_id || kat.id, urun, +1)}
                        style={{ width: 40, height: 40, borderRadius: 8, border: 'none', background: adet > 0 ? '#C8956A' : '#2a2d35', color: '#fff', fontSize: 20, cursor: 'pointer', fontWeight: 700 }}>+</button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Not alanı */}
          {sepetSayisi > 0 && (
            <div style={{ padding: '0 16px 12px' }}>
              <textarea
                value={not} onChange={e => setNot(e.target.value)}
                placeholder="Not ekle (opsiyonel)…"
                rows={2}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8, fontSize: 13,
                  background: '#1a1d24', border: '1px solid #2a2d35', color: '#e8e9ec',
                  resize: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Alt buton */}
      {sepetSayisi > 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          padding: '12px 16px', background: '#0f1117', borderTop: '1px solid #2a2d35',
        }}>
          {sonuc === 'hata' && (
            <div style={{ fontSize: 12, color: '#e05c5c', marginBottom: 8, textAlign: 'center' }}>{hataMsg}</div>
          )}
          <button
            onClick={() => gonder(false)}
            disabled={gonderiyor}
            style={{
              width: '100%', padding: '15px', borderRadius: 10, border: 'none',
              background: '#C8956A', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer',
            }}
          >
            {gonderiyor ? 'Gönderiliyor…' : `Siparişi Gönder (${sepetSayisi} ürün)`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Mesai Çıkış Butonu ───────────────────────────────────────────────────────
function MesaiCikisButon({ oturum, isDevreden }) {
  const [durum, setDurum] = useState(null); // null | 'qr-onay' | 'onaylandi'
  const [mesaj, setMesaj] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);
  const [onayModal, setOnayModal] = useState(false);
  const [konum, setKonum] = useState(null);
  const [subeQrUrl, setSubeQrUrl] = useState(null);

  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      p => setKonum({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  const cikisYap = async (tip) => {
    setYukleniyor(true);
    setOnayModal(false);
    try {
      const res = await api('/gorev/mesai-cikis', {
        method: 'POST',
        body: {
          sube_id: oturum.sube_id,
          personel_id: oturum.personel_id,
          cikis_tip: tip,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      try { localStorage.removeItem(`gorev_oturum_${oturum.sube_id}`); } catch {}
      if (tip === 'kapalis') {
        // Kapanış → QR onay ekranı göster
        const origin = window.location.origin;
        setSubeQrUrl(`${origin}/api/gorev/qr/${oturum.sube_id}`);
        setMesaj(res.mesaj || '✅ Kapanış kaydedildi');
        setDurum('qr-onay');
      } else {
        setMesaj(res.mesaj || '✅ Çıkış kaydedildi');
        setDurum('onaylandi');
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) setMesaj('📍 ' + msg.split('|')[1]);
      else if (msg.startsWith('konum_gerekli|')) setMesaj('📍 Konum izni gerekli.');
      else setMesaj(msg || 'Hata oluştu');
    } finally {
      setYukleniyor(false);
    }
  };

  // Çıkış sonrası QR onay ekranı
  if (durum === 'qr-onay') return (
    <div style={{
      margin: '8px 16px', padding: '16px', borderRadius: 12,
      background: '#1a1d24', border: '1px solid rgba(200,149,106,0.4)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#C8956A', marginBottom: 4 }}>
        🔒 Çıkışın Onaylandı
      </div>
      <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 12, lineHeight: 1.6 }}>
        Şube QR kodunu okut — onay verildi
      </div>
      {subeQrUrl && (
        <img src={subeQrUrl} alt="Şube QR" style={{ width: 140, height: 140, borderRadius: 8, marginBottom: 12 }} />
      )}
      <div style={{ fontSize: 11, color: '#4caf84', fontWeight: 600 }}>
        ✅ {mesaj}
      </div>
      <button onClick={() => setDurum('onaylandi')}
        style={{
          marginTop: 12, padding: '8px 20px', borderRadius: 8, fontSize: 12,
          background: 'none', border: '1px solid #2a2d35', color: '#6b6f7a', cursor: 'pointer',
        }}>
        Kapat
      </button>
    </div>
  );

  if (durum === 'onaylandi') return (
    <div style={{
      margin: '8px 16px', padding: '10px 14px', borderRadius: 10,
      background: 'rgba(76,175,132,0.08)', border: '1px solid rgba(76,175,132,0.3)',
      fontSize: 13, color: '#4caf84', fontWeight: 600,
    }}>
      {mesaj}
    </div>
  );

  // Sabahçı VE kasa devrini devreden bu kişiyse: vardiyası kasa devri panelden
  // onaylandığında otomatik biter — burada ayrıca "Vardiyamı Bitir" gösterip
  // yanlış kullanım (devirsiz çıkış) riskini açmıyoruz.
  // Aynı sabah vardiyasında devri yapmayan başka sabahçı(lar) için normal
  // "Mesaimi Bitir" butonu gösterilir (aksi halde mesaileri hiç bitmiyordu).
  if (oturum.vardiya_tip === 'sabahci' && isDevreden) return (
    <div style={{
      margin: '8px 16px', padding: '12px 14px', borderRadius: 10,
      background: 'rgba(74,158,255,0.06)', border: '1px solid rgba(74,158,255,0.2)',
      fontSize: 12, color: '#6b6f7a', textAlign: 'center', lineHeight: 1.6,
    }}>
      ℹ️ Vardiyan, panelden kasa devrini onayladığında otomatik olarak sona erecek.
    </div>
  );

  return (
    <div style={{ margin: '8px 16px' }}>
      {mesaj && (
        <div style={{ fontSize: 12, color: '#e05c5c', marginBottom: 6, textAlign: 'center' }}>{mesaj}</div>
      )}

      {onayModal ? (
        <div style={{
          padding: '14px', borderRadius: 10, background: '#1a1d24',
          border: '1px solid #2a2d35',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#e8e9ec', marginBottom: 4, textAlign: 'center' }}>
            Vardiyandan çıkış yapıyorsun
          </div>
          <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 12, textAlign: 'center' }}>
            Görevlerini tamamladıysan çıkışını onaylayabilirsin.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => cikisYap('kapalis')} disabled={yukleniyor}
              style={{
                flex: 1, padding: '15px 8px', borderRadius: 8, cursor: 'pointer',
                background: 'rgba(200,149,106,0.15)', color: '#C8956A', fontWeight: 800, fontSize: 15,
                border: '1px solid rgba(200,149,106,0.4)',
              }}>
              {yukleniyor ? '…' : '✅ Çıkışımı Onayla'}
            </button>
            <button onClick={() => setOnayModal(false)} disabled={yukleniyor}
              style={{ padding: '12px', borderRadius: 8, border: '1px solid #2a2d35', background: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 13 }}>
              ✕
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setOnayModal(true)} disabled={yukleniyor} style={{
          width: '100%', padding: '12px', borderRadius: 10,
          background: 'rgba(224,92,92,0.08)', border: '1px solid rgba(224,92,92,0.25)',
          color: '#e05c5c', fontWeight: 700, fontSize: 14, cursor: 'pointer',
        }}>
          {yukleniyor ? '…' : '🏁 Vardiyamı Bitir'}
        </button>
      )}
    </div>
  );
}

// ── Yemek Molası Butonu ──────────────────────────────────────────────────────
function YemekMolasiButon({ oturum }) {
  const [durum, setDurum] = useState(null); // null | 'devam' | 'bitti'
  const [sure, setSure] = useState(null);
  const [ucretHakki, setUcretHakki] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [mesaj, setMesaj] = useState('');
  const [konum, setKonum] = useState(null);

  // Konum arka planda al
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      (pos) => setKonum({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    api(`/gorev/yemek-durum?sube_id=${oturum.sube_id}&personel_id=${oturum.personel_id}`)
      .then(d => {
        setDurum(d.durum);
        if (d.sure_dk) setSure(d.sure_dk);
        if (d.ucret_hakki !== null) setUcretHakki(d.ucret_hakki);
      }).catch(() => {});
  }, []);

  const tikla = async () => {
    setYukleniyor(true);
    setMesaj('');
    try {
      const endpoint = durum === 'devam' ? '/gorev/yemek-bitis' : '/gorev/yemek-baslat';
      const res = await api(endpoint, {
        method: 'POST',
        body: {
          sube_id: oturum.sube_id,
          personel_id: oturum.personel_id,
          lat: konum?.lat ?? null,
          lng: konum?.lng ?? null,
        },
      });
      if (durum === 'devam') {
        setDurum('bitti');
        setSure(res.sure_dk);
        setUcretHakki(res.ucret_hakki);
        setMesaj(res.mesaj);
      } else {
        setDurum('devam');
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.startsWith('sube_disinda|')) {
        setMesaj('📍 ' + msg.split('|')[1]);
      } else if (msg.startsWith('konum_gerekli|')) {
        setMesaj('📍 Konum izni gerekli — tarayıcı ayarlarından izin ver.');
      } else {
        setMesaj(msg || 'Hata oluştu');
      }
    } finally {
      setYukleniyor(false);
    }
  };

  if (durum === 'bitti') return (
    <div style={{
      margin: '10px 16px', padding: '10px 14px', borderRadius: 10,
      background: ucretHakki ? 'rgba(76,175,132,0.08)' : 'rgba(224,92,92,0.08)',
      border: `1px solid ${ucretHakki ? 'rgba(76,175,132,0.3)' : 'rgba(224,92,92,0.3)'}`,
      fontSize: 13,
    }}>
      🍽️ Yemek molası: <strong>{Math.round(sure)} dk</strong>
      <span style={{ marginLeft: 8, color: ucretHakki ? '#4caf84' : '#e05c5c', fontWeight: 700 }}>
        {ucretHakki ? '✅ Yemek ücreti hakkı kazanıldı' : '❌ Yemek ücreti ödenmez'}
      </span>
    </div>
  );

  return (
    <div style={{ margin: '10px 16px' }}>
      <button onClick={tikla} disabled={yukleniyor} style={{
        width: '100%', padding: '12px', borderRadius: 10, border: 'none', cursor: 'pointer',
        background: durum === 'devam' ? 'rgba(245,158,11,0.15)' : 'rgba(74,158,255,0.1)',
        border: `1px solid ${durum === 'devam' ? 'rgba(245,158,11,0.4)' : 'rgba(74,158,255,0.3)'}`,
        color: durum === 'devam' ? '#f59e0b' : '#4a9eff',
        fontWeight: 700, fontSize: 14,
      }}>
        {yukleniyor ? '…' : durum === 'devam' ? '🍽️ Yemekten Döndüm' : '🍽️ Yemeğe Gidiyorum'}
      </button>
      {durum === 'devam' && (
        <div style={{ fontSize: 11, color: '#6b6f7a', textAlign: 'center', marginTop: 6 }}>
          Mola sayacı çalışıyor — dönünce tekrar bas
        </div>
      )}
      {mesaj && <div style={{ fontSize: 12, marginTop: 6, textAlign: 'center', color: '#6b6f7a' }}>{mesaj}</div>}
    </div>
  );
}

// ── Vardiyam Ekranı ──────────────────────────────────────────────────────────
function VardiyamEkrani({ oturum }) {
  const [bugun, setBugun] = useState(null);
  const [aylik, setAylik] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    const simdi = new Date();
    const yil = simdi.getFullYear();
    const ay = simdi.getMonth() + 1;
    Promise.all([
      api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}&personel_id=${oturum.personel_id}`).catch(() => null),
    ]).then(([takip]) => {
      const kisi = takip?.personeller?.[0];
      if (kisi) {
        const bugunVeri = kisi.gunler?.find(g => g.tarih === oturum.tarih);
        setBugun(bugunVeri || null);
        setAylik(kisi);
      }
    }).finally(() => setYukleniyor(false));
  }, []);

  const PAGE = { minHeight: '100vh', background: '#0f1117', color: '#e8e9ec', fontFamily: 'Instrument Sans, sans-serif' };

  const K = ({ label, val, renk, alt }) => (
    <div style={{
      background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 12,
      padding: '14px 16px', flex: 1, minWidth: 100,
    }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: renk || '#e8e9ec' }}>{val}</div>
      <div style={{ fontSize: 11, color: '#b0b3bc', marginTop: 3 }}>{label}</div>
      {alt && <div style={{ fontSize: 10, color: '#6b6f7a', marginTop: 2 }}>{alt}</div>}
    </div>
  );

  if (yukleniyor) return (
    <div style={{ ...PAGE, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="spinner" />
    </div>
  );

  const fmtDk = (dk) => {
    if (!dk) return '0 dk';
    const h = Math.floor(dk / 60), m = Math.round(dk % 60);
    return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  };

  return (
    <div style={{ ...PAGE, paddingBottom: 40 }}>
      {/* Bugün */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #2a2d35' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#6b6f7a', marginBottom: 10, letterSpacing: 1 }}>
          BUGÜN · {new Date(oturum.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' })}
        </div>
        {bugun ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <K label="Planlanan" val={`${bugun.planlanan_saat?.toFixed(1)}s`} renk="#4a9eff" />
            <K label="Gecikme"
               val={bugun.gecikme_dk > 0 ? fmtDk(bugun.gecikme_dk) : '✓ Zamanında'}
               renk={bugun.gecikme_dk > 0 ? '#e05c5c' : '#4caf84'} />
            <K label="Fazla Mesai"
               val={bugun.fazla_mesai_saat > 0 ? `+${bugun.fazla_mesai_saat.toFixed(1)}s` : '—'}
               renk={bugun.fazla_mesai_saat > 0 ? '#f59e0b' : '#6b6f7a'} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#6b6f7a' }}>Bugün için vardiya kaydı bulunamadı.</div>
        )}
        {bugun?.part_tam_uyari && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
            color: '#f59e0b',
          }}>
            ⚠️ Part-time kaydınız var ama bugün tam mesai (9.5 saat) yazılmış.
          </div>
        )}
      </div>

      {/* Bu ay */}
      {aylik && (
        <div style={{ padding: '16px 20px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b6f7a', marginBottom: 10, letterSpacing: 1 }}>
            BU AY
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <K label="Toplam Mesai" val={`${aylik.toplam_planlanan_saat?.toFixed(1)}s`} renk="#4a9eff" />
            <K label="Fazla Mesai" val={aylik.toplam_fazla_mesai_saat > 0 ? `+${aylik.toplam_fazla_mesai_saat.toFixed(1)}s` : '—'} renk={aylik.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : '#6b6f7a'} />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <K label="Toplam Gecikme" val={fmtDk(aylik.toplam_gecikme_dk)} renk={aylik.toplam_gecikme_dk > 30 ? '#e05c5c' : '#6b6f7a'} />
            <K label="Yemek Ücreti" val={`${aylik.yemek_ucret_gun} gün`} renk="#4caf84"
               alt={aylik.yemek_ucret_tutari > 0 ? `${aylik.yemek_ucret_tutari.toLocaleString('tr-TR')} ₺` : null} />
          </div>

          {/* Net Hakediş ve Yemek Ücreti */}
          {aylik.ucret_detay && (() => {
            const d = aylik.ucret_detay;
            const fmt2 = n => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 }).format(n) + ' ₺';
            const gecenGun = d.gecen_gun ?? 0;
            const ayGun = d.ay_gun ?? 30;
            const ilerleme = ayGun > 0 ? Math.min(100, Math.round((gecenGun / ayGun) * 100)) : 0;
            // Toplam aylık tahmini (her şey hak kazanılırsa)
            const aylikToplam = d.aylik_toplam_tahmini
              ?? ((d.taban_maas ?? 0) + (d.yemek_ucret ?? 0) + (d.yol_ucret_aylik ?? d.yol_ucret ?? 0));
            // Bu aya kadar kaç gün yemek molası değerlendirildi ve kaçı hak kazandı
            const degerlendirilenGunler = (aylik.gunler || []).filter(g => g.yemek_sure_dk != null);
            const yemekKaybiGun = degerlendirilenGunler.filter(g => !g.yemek_ucret_hakki).length;
            return (
              <div style={{
                marginTop: 14, borderRadius: 14, overflow: 'hidden',
                border: '1px solid rgba(76,175,132,0.25)',
                background: 'linear-gradient(145deg, rgba(76,175,132,0.10), rgba(76,175,132,0.02))',
              }}>
                {/* Üst: büyük "şu ana kadar hak edilen" */}
                <div style={{ padding: '16px 18px 14px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#6b6f7a', letterSpacing: 1, marginBottom: 6 }}>
                    💰 ŞU ANA KADAR HAK ETTİĞİN
                  </div>
                  <div style={{ fontSize: 30, fontWeight: 800, color: '#4caf84', lineHeight: 1.1 }}>
                    {fmt2(d['net_hakediş'])}
                  </div>
                  {!d.ay_tamam && (
                    <>
                      <div style={{ marginTop: 10, height: 6, borderRadius: 4, background: '#2a2d35', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${ilerleme}%`, borderRadius: 4,
                          background: 'linear-gradient(90deg, #4caf84, #6fd4a8)', transition: 'width 0.3s' }} />
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11, color: '#6b6f7a' }}>
                        Ayın {gecenGun}. günü / {ayGun} gün
                        {d.taban_maas != null && (
                          <> · Aylık maaşının <strong style={{ color: '#b0b3bc' }}>{fmt2(aylikToplam)}</strong>'sini tamamlarsan ay sonu hakedişin bu olacak</>
                        )}
                      </div>
                    </>
                  )}
                  {d.ay_tamam && d.taban_maas != null && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#6b6f7a' }}>
                      Bu ay tamamlandı · Aylık maaşın: <strong style={{ color: '#b0b3bc' }}>{fmt2(d.taban_maas)}</strong>
                    </div>
                  )}
                </div>

                {/* Detay döküm */}
                <div style={{ padding: '12px 18px 16px', borderTop: '1px solid rgba(76,175,132,0.15)',
                  display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {d.taban_maas != null && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#b0b3bc' }}>
                        Taban Maaş {!d.ay_tamam ? `(${gecenGun}/${Math.round(ayGun)} gün)` : '(tam ay)'}
                      </span>
                      <span style={{ color: '#e8e9ec', fontWeight: 600 }}>
                        {fmt2(d.kazanilan_taban ?? d.taban_maas)}
                      </span>
                    </div>
                  )}
                  {d.calisma_saati != null && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#b0b3bc' }}>Çalışma ({d.calisma_saati}s)</span>
                      <span style={{ color: '#e8e9ec', fontWeight: 600 }}>{fmt2(d.normal_ucret)}</span>
                    </div>
                  )}
                  {d.fazla_mesai_saat > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#b0b3bc' }}>Fazla Mesai ({d.fazla_mesai_saat}s)</span>
                      <span style={{ color: '#f59e0b', fontWeight: 600 }}>+{fmt2(d.fazla_mesai_ucret)}</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#b0b3bc' }}>🍽️ Yemek ({aylik.yemek_ucret_gun} gün hak kazanıldı)</span>
                    <span style={{ color: aylik.yemek_ucret_tutari > 0 ? '#4caf84' : '#6b6f7a', fontWeight: 600 }}>
                      {aylik.yemek_ucret_tutari > 0 ? '+' + fmt2(aylik.yemek_ucret_tutari) : '0 ₺'}
                    </span>
                  </div>
                  {(d.yol_ucret > 0 || d.yol_ucret_aylik > 0) && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span style={{ color: '#b0b3bc' }}>
                        🚌 Yol {!d.ay_tamam ? `(${gecenGun}/${Math.round(ayGun)} gün)` : ''}
                      </span>
                      <span style={{ color: '#e8e9ec', fontWeight: 600 }}>+{fmt2(d.yol_ucret)}</span>
                    </div>
                  )}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    borderTop: '1px solid rgba(76,175,132,0.2)', paddingTop: 8, marginTop: 4,
                  }}>
                    <span style={{ fontWeight: 800, fontSize: 14, color: '#e8e9ec' }}>ŞU ANA KADAR TOPLAM</span>
                    <span style={{ fontWeight: 800, fontSize: 17, color: '#4caf84' }}>{fmt2(d['net_hakediş'])}</span>
                  </div>
                </div>

                {/* Yemek ücreti hakkı kaybı uyarısı */}
                {yemekKaybiGun > 0 && (
                  <div style={{
                    margin: '0 18px 16px', padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                    fontSize: 12, color: '#f59e0b', lineHeight: 1.5,
                  }}>
                    ⚠️ Bu ay <strong>{yemekKaybiGun} gün</strong> yemek molası hakkın kazanılmadı
                    (mola süresi limit dışı kaldı) — bu günler için yemek ücreti eklenmedi.
                  </div>
                )}
              </div>
            );
          })()}

          {aylik.haftalik_izin_kullanilmadi > 0 && (
            <div style={{
              marginTop: 12, padding: '12px 14px', borderRadius: 10,
              background: 'rgba(224,92,92,0.08)', border: '1px solid rgba(224,92,92,0.3)',
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 700, color: '#e05c5c', marginBottom: 4 }}>
                🔴 Haftalık İzin Alacağın Var
              </div>
              <div style={{ color: '#b0b3bc', fontSize: 12, lineHeight: 1.6 }}>
                Bu ay <strong style={{ color: '#e8e9ec' }}>{aylik.haftalik_izin_kullanilmadi} hafta</strong> boyunca
                haftalık izin kullanmadın. Her çalışanın haftada en az 1 gün dinlenme hakkı var.
                Yöneticinle konuş.
              </div>
            </div>
          )}

          {(aylik.izin_bildirimleri || []).length > 0 && (
            <div style={{
              marginTop: 12, padding: '12px 14px', borderRadius: 10,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>
                ℹ️ Geriye Dönük İzin / Devamsızlık Kaydı
              </div>
              {aylik.izin_bildirimleri.map((b, i) => (
                <div key={i} style={{ color: '#b0b3bc', fontSize: 12, lineHeight: 1.6, marginBottom: i < aylik.izin_bildirimleri.length - 1 ? 6 : 0 }}>
                  <strong style={{ color: '#e8e9ec' }}>
                    {new Date(b.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}
                  </strong> tarihinde vardiyan olduğu halde yoklama kaydın bulunmadığı için
                  bu gün{' '}
                  <strong style={{ color: b.tip === 'ucretsiz' ? '#e05c5c' : '#f59e0b' }}>
                    {b.tip === 'ucretsiz' ? 'devamsız' : 'izinli'}
                  </strong> olarak işlendi. Bir yanlışlık olduğunu düşünüyorsan yöneticinle konuş.
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Kapanış Mühür Bandı (sadece kapanış vardiyası için) ──────────────────────
function KapanisMuhurBandi({ oturum }) {
  // durum: null | 'kontrol' | 'qr-goster' | 'muhürlendi'
  const [durum, setDurum] = useState('kontrol'); // mount'ta önce kontrol et
  const [manuelYukleniyor, setManuelYukleniyor] = useState(false);
  const [hata, setHata] = useState('');
  const pollRef = useRef(null);

  // Mount'ta: zaten mühürlenmiş mi kontrol et
  useEffect(() => {
    api(`/gorev/kapanis-bekleyen?sube_id=${oturum.sube_id}`)
      .then(res => {
        const benimKayit = (res.bekleyen || []).find(b => b.personel_id === oturum.personel_id);
        // Listede yoksa → zaten mühürlendi; varsa → henüz bekliyor
        setDurum(benimKayit ? null : 'muhürlendi');
      })
      .catch(() => setDurum(null)); // hata varsa normal göster
  }, []); // eslint-disable-line

  // QR gösterilince: 3 saniyede bir kapanis-bekleyen'i kontrol et
  useEffect(() => {
    if (durum !== 'qr-goster') {
      clearInterval(pollRef.current);
      return;
    }
    const kontrol = async () => {
      try {
        const res = await api(`/gorev/kapanis-bekleyen?sube_id=${oturum.sube_id}`);
        const benimKayit = (res.bekleyen || []).find(b => b.personel_id === oturum.personel_id);
        if (!benimKayit) {
          // Yoklama kapandı → mühürlendi
          clearInterval(pollRef.current);
          setDurum('muhürlendi');
        }
      } catch { /* sessiz */ }
    };
    pollRef.current = setInterval(kontrol, 3000);
    return () => clearInterval(pollRef.current);
  }, [durum, oturum.sube_id, oturum.personel_id]);

  // Manuel mühürleme (QR yoksa fallback)
  const manuelMuhurle = async () => {
    setManuelYukleniyor(true);
    setHata('');
    try {
      await api('/gorev/kapanis-muhurle', {
        method: 'POST',
        body: { sube_id: oturum.sube_id, personel_id: oturum.personel_id },
      });
      setDurum('muhürlendi');
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('zaten')) setDurum('muhürlendi');
      else setHata(msg || 'Hata oluştu');
    } finally {
      setManuelYukleniyor(false);
    }
  };

  if (durum === 'kontrol') return (
    <div style={{
      padding: '10px 20px',
      background: 'rgba(200,149,106,0.04)', borderBottom: '1px solid rgba(200,149,106,0.15)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <div className="spinner" style={{ width: 14, height: 14 }} />
      <span style={{ fontSize: 11, color: '#6b6f7a' }}>Kapanış durumu kontrol ediliyor…</span>
    </div>
  );

  if (durum === 'muhürlendi') return (
    <div style={{
      padding: '14px 20px',
      background: 'rgba(76,175,132,0.1)', borderBottom: '1px solid rgba(76,175,132,0.3)',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 20 }}>🔒</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#4caf84' }}>Kapanış Mühürlendi</div>
        <div style={{ fontSize: 11, color: '#6b6f7a' }}>Sistem kapanışı kaydetti · {oturum.ad_soyad}</div>
      </div>
    </div>
  );

  if (durum === 'qr-goster') {
    const qrUrl = `${window.location.origin}/api/gorev/qr/${oturum.sube_id}`;
    return (
      <div style={{
        padding: '16px 20px',
        background: 'rgba(200,149,106,0.08)', borderBottom: '1px solid rgba(200,149,106,0.3)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#C8956A', marginBottom: 4 }}>
          🔲 Şube QR'ını Okut
        </div>
        <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 12, lineHeight: 1.6 }}>
          Telefonunla bu QR'ı okut → kapanış otomatik mühürlenir
        </div>
        <div style={{
          display: 'inline-block', background: '#fff', borderRadius: 10, padding: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,0.2)', marginBottom: 12,
        }}>
          <img src={qrUrl} alt="Şube QR" style={{ width: 160, height: 160, display: 'block' }} />
        </div>
        <div style={{ fontSize: 11, color: '#6b6f7a', marginBottom: 10 }}>
          Bekleniyor<span style={{ animation: 'none' }}>…</span>
        </div>
        {hata && <div style={{ fontSize: 12, color: '#e05c5c', marginBottom: 8 }}>{hata}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button onClick={manuelMuhurle} disabled={manuelYukleniyor} style={{
            padding: '7px 14px', borderRadius: 7, border: '1px solid #2a2d35',
            background: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 11,
          }}>
            {manuelYukleniyor ? '…' : 'QR yok, manuel onayla'}
          </button>
          <button onClick={() => setDurum(null)} style={{
            padding: '7px 14px', borderRadius: 7, border: '1px solid #2a2d35',
            background: 'none', color: '#6b6f7a', cursor: 'pointer', fontSize: 11,
          }}>
            İptal
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: '10px 20px',
      background: 'rgba(200,149,106,0.06)', borderBottom: '1px solid rgba(200,149,106,0.25)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#C8956A' }}>🌙 Kapanış Vardiyası</div>
        <div style={{ fontSize: 11, color: '#6b6f7a' }}>Görevleri tamamla, sonra kapanışı mühürle</div>
      </div>
      <button onClick={() => setDurum('qr-goster')} style={{
        padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
        background: '#C8956A', color: '#fff', fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap',
      }}>
        🔲 Kapanışı Yap
      </button>
    </div>
  );
}

// ── Zorunlu Stok Sayımı (TAM KİLİT) ──────────────────────────────────────────
// Ekran sayım bitene kadar tek aksiyona kilitli. Ürün ÜRÜN sıralı, her ürün
// saymadan diğerine geçilmez. Kutuya ÇİFT-TIK → rakam tuş takımı açılır.
function StokSayimKilit({ oturum, subeBilgi, gorev, onBitti }) {
  const kalemler = gorev.kalemler || [];
  // Taslaktan geri yükle (sayfa yenilenince personelin yazdıkları kaybolmasın)
  const [degerler, setDegerler] = useState(() => {
    const init = {};
    (gorev.sayim_sonuc || []).forEach((x) => {
      if (x && x.kalem_kodu != null) init[String(x.kalem_kodu)] = { val: String(x.sayilan_adet ?? ''), girildi: true };
    });
    return init;
  });
  const [idx, setIdx] = useState(() => {
    const girilenler = new Set((gorev.sayim_sonuc || []).map((x) => String(x.kalem_kodu)));
    const i = (gorev.kalemler || []).findIndex((k) => !girilenler.has(String(k.kalem_kodu)));
    return i >= 0 ? i : 0;
  });
  const [keypadAcik, setKeypadAcik] = useState(false);
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [hata, setHata] = useState('');
  const sonTikRef = useRef(0);
  const freezeRef = useRef(false);

  // Görevi 'basladi' durumuna geçir (durum makinesi)
  useEffect(() => {
    api(`/stok-sayim/gorev/${gorev.id}/basla`, { method: 'POST' }).catch(() => {});
  }, [gorev.id]);

  // İlk rakam girildiği an FREEZE'i bildir → şube 'ürün aç' alanı kilitlenir
  const freezeBildir = () => {
    if (freezeRef.current) return;
    freezeRef.current = true;
    api(`/stok-sayim/gorev/${gorev.id}/sayim-aktif`, { method: 'POST' }).catch(() => {});
  };

  // Taslak kaydet: her değişimde (800ms debounce) girilen kalemleri arka plana yaz
  // → sayfa yenilense bile kaybolmasın. İlk render'da (henüz giriş yok) yazma.
  const taslakRef = useRef(null);
  const taslakIlkRef = useRef(true);
  useEffect(() => {
    if (taslakIlkRef.current) { taslakIlkRef.current = false; return; }
    const girilenler = Object.entries(degerler).filter(([, v]) => v.girildi);
    if (!girilenler.length) return;
    clearTimeout(taslakRef.current);
    taslakRef.current = setTimeout(() => {
      const sayim_sonuc = girilenler.map(([kk, v]) => ({ kalem_kodu: kk, sayilan_adet: parseInt(v.val || '0', 10) || 0 }));
      api(`/stok-sayim/gorev/${gorev.id}/taslak-kaydet`, { method: 'POST', body: { sayim_sonuc } }).catch(() => {});
    }, 800);
    return () => clearTimeout(taslakRef.current);
  }, [degerler, gorev.id]);

  const aktif = kalemler[idx];
  const aktifKod = aktif ? String(aktif.kalem_kodu) : '';
  const aktifDeger = degerler[aktifKod] || { val: '', girildi: false };
  const toplam = kalemler.length;
  const sayilanAdet = Object.values(degerler).filter((d) => d.girildi).length;
  const sonUrun = idx >= toplam - 1;

  // Kategori geçiş efekti: aktif ürünün kategorisi + kategori içi konum + motive yazı
  const aktifKat = (aktif?.kategori_ad || '').trim();
  let katToplam = 0, katSira = 0;
  kalemler.forEach((k, i) => {
    if ((k.kategori_ad || '').trim() === aktifKat) { katToplam += 1; if (i <= idx) katSira += 1; }
  });
  const MOTIV = ['sen yaparsın 💪', 'harika gidiyorsun 🔥', 'böyle devam ✨', 'odaklan 🎯', 'az kaldı 👏', 'süpersin 🌟'];
  const motiv = MOTIV[(aktifKat.length + idx) % MOTIV.length];

  const kutuTik = () => {
    // Çift-tık (350ms içinde 2 dokunuş) → rakam girişi açılır (kaza ile değişmesin)
    const now = Date.now();
    if (now - sonTikRef.current < 350) setKeypadAcik(true);
    sonTikRef.current = now;
  };

  // +/− adım: rakamı tek dokunuşla artır/azalt (girildi sayılır → ileri gidebilir).
  // Tuş takımı VEYA +/− — iki yolla da girilebilir.
  const adim = (delta) => {
    freezeBildir();
    setDegerler((m) => {
      const cur = parseInt(m[aktifKod]?.val || '0', 10) || 0;
      const yeni = Math.max(0, cur + delta);
      return { ...m, [aktifKod]: { val: String(yeni), girildi: true } };
    });
  };

  const tusBas = (t) => {
    if (t !== 'sil') freezeBildir();
    setDegerler((m) => {
      const cur = m[aktifKod]?.val || '';
      let yeni = cur;
      if (t === 'sil') yeni = cur.slice(0, -1);
      else if (cur.length < 5) yeni = (cur === '0' ? '' : cur) + t;
      // Rakam yazılınca direkt GİRİLDİ sayılır → "Sonraki Ürün" hemen yeşile döner
      // ("Tamam" zorunlu değil). Hepsi silinirse girilmemiş olur.
      return { ...m, [aktifKod]: { val: yeni, girildi: yeni !== '' } };
    });
  };

  const onayla = () => {
    // 0 dahil her sayı geçerli; ama boşsa "saymadan geçilemez"
    setDegerler((m) => {
      const cur = m[aktifKod]?.val;
      if (cur === undefined || cur === '') return m;
      return { ...m, [aktifKod]: { val: cur, girildi: true } };
    });
    setKeypadAcik(false);
  };

  const ileri = () => {
    setHata('');
    if (!aktifDeger.girildi) { setHata('Önce bu ürünü say (kutuya çift dokun).'); return; }
    if (!sonUrun) { setIdx(idx + 1); return; }
    tamamla();
  };

  const tamamla = async () => {
    setKaydediliyor(true);
    setHata('');
    try {
      const sayim_sonuc = kalemler.map((k) => ({
        kalem_kodu: k.kalem_kodu,
        sayilan_adet: parseInt(degerler[String(k.kalem_kodu)]?.val || '0', 10) || 0,
      }));
      await api(`/stok-sayim/gorev/${gorev.id}/kaydet`, { method: 'POST', body: { sayim_sonuc } });
      onBitti();
    } catch (e) {
      setHata(e.message || 'Kayıt başarısız');
      setKaydediliyor(false);
    }
  };

  const modBilgi = gorev.mod === 'kalibrasyon'
    ? { renk: '#C8956A', metin: '🎯 İLK SAYIM — doğru stoğu sen kuruyorsun' }
    : { renk: '#4caf84', metin: '🔍 KONTROL — sistemle karşılaştırılacak' };

  const PAGE = { minHeight: '100vh', background: '#0f1117', color: '#e8e9ec', fontFamily: 'Instrument Sans, sans-serif' };
  const KEY = {
    fontSize: 28, fontWeight: 800, padding: '18px 0', borderRadius: 14,
    background: '#1a1d24', border: '1px solid #2a2d35', color: '#e8e9ec', cursor: 'pointer',
  };

  return (
    <div style={PAGE}>
      <style>{`@keyframes ssKatGiris{from{opacity:0;transform:translateY(-10px) scale(.97)}to{opacity:1;transform:none}}`}</style>
      {/* Kilit başlığı — çıkış yok, başka sekme yok */}
      <div style={{ padding: '16px 20px', borderBottom: '1px solid #2a2d35', position: 'sticky', top: 0, background: '#0f1117', zIndex: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
          🔒 ZORUNLU STOK SAYIMI
        </div>
        <div style={{ fontSize: 12, color: '#6b6f7a', marginTop: 3 }}>
          {subeBilgi?.ad || 'Şube'} · {oturum.ad_soyad} · bitmeden başka işlem yapılamaz
        </div>
        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: modBilgi.renk }}>{modBilgi.metin}</div>
      </div>

      {/* İlerleme */}
      <div style={{ padding: '14px 20px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b6f7a', marginBottom: 6 }}>
          <span>Ürün {idx + 1} / {toplam}</span>
          <span>{sayilanAdet} sayıldı</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: '#1a1d24', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.round((sayilanAdet / toplam) * 100)}%`, background: modBilgi.renk, transition: 'width .2s' }} />
        </div>
      </div>

      <div style={{ padding: '14px 20px 20px' }}>
        {/* Kategori geçiş bannerı — EN ÜSTTE (kategori değişince yeniden animasyon) */}
        {aktifKat && (
          <div key={aktifKat} style={{
            animation: 'ssKatGiris .38s ease', marginBottom: 14,
            background: 'linear-gradient(135deg, rgba(200,149,106,0.18), rgba(76,175,132,0.12))',
            border: '1px solid rgba(200,149,106,0.35)', borderRadius: 14, padding: '14px 16px',
          }}>
            <div style={{ fontSize: 18, fontWeight: 800 }}>Şimdi <span style={{ color: '#C8956A' }}>{aktifKat}</span> sayalım!</div>
            <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>{motiv} · {aktifKat} {katSira}/{katToplam}</div>
          </div>
        )}

        {/* Gezinme — bannerın altında */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          {idx > 0 && (
            <button onClick={() => { setIdx(idx - 1); setKeypadAcik(false); setHata(''); }} style={{
              flex: '0 0 auto', padding: '14px 16px', borderRadius: 12, background: 'none',
              border: '1px solid #2a2d35', color: '#6b6f7a', fontSize: 14, cursor: 'pointer',
            }}>← Önceki</button>
          )}
          <button
            onClick={ileri}
            disabled={kaydediliyor || !aktifDeger.girildi}
            style={{
              flex: 1, padding: '15px', borderRadius: 12, border: 'none', fontSize: 16, fontWeight: 800,
              cursor: (kaydediliyor || !aktifDeger.girildi) ? 'not-allowed' : 'pointer',
              background: (kaydediliyor || !aktifDeger.girildi) ? '#2a2d35' : (sonUrun ? '#4caf84' : '#C8956A'),
              color: (kaydediliyor || !aktifDeger.girildi) ? '#6b6f7a' : '#fff',
            }}
          >
            {kaydediliyor ? 'Kaydediliyor…' : sonUrun ? '✓ Sayımı Tamamla' : 'Sonraki Ürün →'}
          </button>
        </div>

        {/* Aktif ürün kartı */}
        <div style={{ background: '#15181f', border: '1px solid #2a2d35', borderRadius: 16, padding: '20px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{aktif?.kalem_adi || '—'}</div>
          <div style={{ fontSize: 12, color: '#6b6f7a', marginBottom: 16 }}>Kaç adet? +/− ile say ya da kutuya çift dokun</div>
          {/* [−] [sayı kutusu] [+] — iki yolla da girilebilir */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
            <button onClick={() => adim(-1)} style={{
              width: 56, height: 56, borderRadius: 14, border: '1px solid #2a2d35',
              background: '#22262f', color: '#e8e9ec', fontSize: 28, fontWeight: 800, cursor: 'pointer', flex: '0 0 auto',
            }}>−</button>
            <div
              onClick={kutuTik}
              style={{
                flex: 1, fontSize: 44, fontWeight: 900, padding: '14px', borderRadius: 14, cursor: 'pointer',
                background: keypadAcik ? 'rgba(200,149,106,0.12)' : '#0f1117',
                border: `2px solid ${aktifDeger.girildi ? '#4caf84' : keypadAcik ? '#C8956A' : '#2a2d35'}`,
                color: aktifDeger.val === '' ? '#3a3d45' : '#fff',
              }}
            >
              {aktifDeger.val === '' ? '—' : aktifDeger.val}{aktifDeger.girildi ? ' ✓' : ''}
            </div>
            <button onClick={() => adim(1)} style={{
              width: 56, height: 56, borderRadius: 14, border: 'none',
              background: '#C8956A', color: '#fff', fontSize: 28, fontWeight: 800, cursor: 'pointer', flex: '0 0 auto',
            }}>+</button>
          </div>
        </div>

        {/* Rakam tuş takımı (çift-tıkla açılır) */}
        {keypadAcik && (
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {['1','2','3','4','5','6','7','8','9'].map((t) => (
              <button key={t} onClick={() => tusBas(t)} style={KEY}>{t}</button>
            ))}
            <button onClick={() => tusBas('sil')} style={{ ...KEY, fontSize: 22 }}>⌫</button>
            <button onClick={() => tusBas('0')} style={KEY}>0</button>
            <button onClick={onayla} style={{ ...KEY, background: '#4caf84', border: 'none', color: '#fff', fontSize: 18 }}>Tamam</button>
          </div>
        )}

        {hata && <div style={{ marginTop: 14, color: '#e57373', fontSize: 13, textAlign: 'center' }}>{hata}</div>}
      </div>
    </div>
  );
}

// ── Ana Görev Sayfası ────────────────────────────────────────────────────────
export default function GorevPersonelSayfasi({ oturum, subeBilgi, onCikis }) {
  const [data, setData] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [islem, setIslem] = useState({});
  const [siparisAcik, setSiparisAcik] = useState(false);
  const [sekme, setSekme] = useState('gorevler'); // 'gorevler' | 'vardiyam'
  const [kapanisUygun, setKapanisUygun] = useState(false);
  const [isDevreden, setIsDevreden] = useState(false);
  const [kasaMuhurlu, setKasaMuhurlu] = useState(false);
  const [mesaimAcik, setMesaimAcik] = useState(true);
  // Zorunlu stok sayımı: atanmışsa ekran TAM KİLİTLENİR (sayım dışı her şey kapalı).
  const [sayimGorev, setSayimGorev] = useState(null);

  // Personelin aktif zorunlu sayım görevi var mı? (en yüksek öncelikli kilit)
  const sayimYukle = useCallback(() => {
    if (!oturum?.sube_id || !oturum?.personel_id) return;
    api(`/stok-sayim/personel-gorev?sube_id=${encodeURIComponent(oturum.sube_id)}&personel_id=${encodeURIComponent(oturum.personel_id)}`)
      .then((r) => setSayimGorev(r?.var ? r.gorev : null))
      .catch(() => {});
  }, [oturum?.sube_id, oturum?.personel_id]);
  // Sahip uzaktan görev atayınca personel sayfayı yenilemeden kilit gelsin:
  // 15 sn'de bir yokla (aktif sayım yokken). Aktif sayım varsa kilit ekranı
  // kendi içinde çalışır; yoklama onu bozmaz (kalemler sabit).
  useEffect(() => {
    sayimYukle();
    const t = setInterval(sayimYukle, 15000);
    return () => clearInterval(t);
  }, [sayimYukle]);

  // Kapanış mühür bandı: kapanış vardiyasında her zaman, diğer vardiyalarda
  // SADECE bugün için bekleyen/devam eden bir kasa devri yoksa (yani kişi
  // tek başına açılışı da kapanışı da yapıyorsa) göster.
  // Ayrıca: aynı sabah vardiyasında BİRDEN FAZLA "sabahçı" varsa, sadece
  // kasa devrini yapan kişinin (devreden_id) vardiyası devir onayıyla otomatik
  // bitsin — diğer sabahçı(lar) "Mesaimi Bitir" butonunu normal görmeli.
  useEffect(() => {
    if (oturum.vardiya_tip === 'kapanis') { setKapanisUygun(true); return; }
    api(`/gorev/devir-bekleyen?sube_id=${oturum.sube_id}`)
      .then(res => {
        // Bugün hiç devir süreci yok/olmadıysa → tek başına açıp-kapatan kişi.
        // Bugün bir devir süreci VARSA (tamamlanmış olsa bile) → bu kişi tek
        // başına değildir, kapanış mührü yerine normal "Mesaimi Bitir" görmeli.
        if (!res?.bekliyor && !res?.sabah_onay_bekliyor && !res?.devir_tamamlandi_bugun) setKapanisUygun(true);
        if (res?.devreden_id && String(res.devreden_id) === String(oturum.personel_id)) {
          setIsDevreden(true);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line

  // Şubenin bugünkü kasa kapanışı (mühürleme) tamamlandı mı?
  // Devir akışında kapanışı yapan devralan dışındaki personel için de
  // kasa mühürlendiyse "Mesaimi Bitir" dışındaki alanlar kilitlenir.
  useEffect(() => {
    api(`/gorev/kapanis-durum?sube_id=${oturum.sube_id}`)
      .then(r => setKasaMuhurlu(!!r?.kapanis_tamamlandi_bugun))
      .catch(() => {});
  }, []); // eslint-disable-line

  // Kasa mühürlendiyse VE bu kişi kendi kapanış mühür bandını görmüyorsa
  // (kapanisUygun=false → tek başına açıp-kapatan kişi değil), bu kişinin
  // mesaisi hâlâ açık mı kontrol et.
  useEffect(() => {
    if (!kasaMuhurlu || kapanisUygun) return;
    api(`/gorev/kapanis-bekleyen?sube_id=${oturum.sube_id}`)
      .then(res => {
        const benim = (res.bekleyen || []).some(b => String(b.personel_id) === String(oturum.personel_id));
        setMesaimAcik(benim);
      })
      .catch(() => {});
  }, [kasaMuhurlu, kapanisUygun]); // eslint-disable-line

  const load = () => {
    const { tarih, sube_id, vardiya_tip, personel_id } = oturum;
    api(`/gorev/personel-vardiya?tarih=${tarih}&sube_id=${sube_id}&vardiya_tip=${vardiya_tip}&personel_id=${personel_id}`)
      .then(setData).catch(console.error).finally(() => setYukleniyor(false));
  };

  useEffect(() => { load(); }, []);

  const toggle = async (g) => {
    if (islem[g.id]) return;
    setIslem(m => ({ ...m, [g.id]: true }));
    try {
      await api('/gorev/tamamla', {
        method: 'POST',
        body: {
          tarih: oturum.tarih,
          sube_id: oturum.sube_id,
          sablon_id: g.id,
          tamamlandi: !g.tamamlandi,
          personel_id: oturum.personel_id,
        },
      });
      setData(d => {
        if (!d) return d;
        const gorevler = d.gorevler.map(x =>
          x.id === g.id ? { ...x, tamamlandi: !x.tamamlandi } : x
        );
        const tamamlanan = gorevler.filter(x => x.tamamlandi).length;
        return { ...d, gorevler, tamamlanan, eksik: gorevler.length - tamamlanan };
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIslem(m => ({ ...m, [g.id]: false }));
    }
  };

  // EN YÜKSEK ÖNCELİK: zorunlu stok sayımı atanmışsa ekran TAM KİLİTLENİR.
  // Sayım bitene (veya sahip uzaktan açana) kadar başka hiçbir şey görünmez.
  if (sayimGorev) return (
    <StokSayimKilit
      oturum={oturum}
      subeBilgi={subeBilgi}
      gorev={sayimGorev}
      onBitti={() => { setSayimGorev(null); sayimYukle(); }}
    />
  );

  if (siparisAcik) return (
    <SiparisEkrani
      oturum={oturum}
      subeBilgi={subeBilgi}
      onKapat={() => setSiparisAcik(false)}
    />
  );

  const vt = VT_ETIKET[oturum.vardiya_tip] || { label: oturum.vardiya_tip, renk: '#6b6f7a' };
  const tamamYuzde = data ? Math.round((data.tamamlanan / data.toplam) * 100) : 0;

  const PAGE = {
    minHeight: '100vh', background: '#0f1117', color: '#e8e9ec',
    fontFamily: 'Instrument Sans, sans-serif',
  };

  // Kasa bugün için mühürlendi VE bu kişi kendi kapanış mührünü görmüyor
  // (devir akışında kapanışı yapan kişi başkası) → "Mesaimi Bitir" dışındaki
  // tüm alanlar kilitlenir.
  if (kasaMuhurlu && !kapanisUygun) {
    return (
      <div style={PAGE}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #2a2d35',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, background: '#0f1117', zIndex: 10,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>
              {subeBilgi?.ad || 'Şube'} · {vt.label}
            </div>
            <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 2 }}>
              {oturum.ad_soyad} · {oturum.tarih}
            </div>
          </div>
          <button onClick={onCikis} style={{
            background: 'none', border: '1px solid #2a2d35', borderRadius: 8,
            color: '#6b6f7a', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
          }}>
            Çıkış
          </button>
        </div>

        <div style={{
          margin: '16px 20px', padding: '16px', borderRadius: 12,
          background: 'rgba(76,175,132,0.08)', border: '1px solid rgba(76,175,132,0.3)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 22 }}>🔒</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#4caf84' }}>Bugünün Kasası Mühürlendi</div>
            <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 2, lineHeight: 1.6 }}>
              Kapanış kasayı kapattı — bugün için işlem yapılamaz.
              {mesaimAcik ? ' Sadece kendi mesaini bitirebilirsin.' : ''}
            </div>
          </div>
        </div>

        {mesaimAcik ? (
          <MesaiCikisButon oturum={oturum} isDevreden={isDevreden} />
        ) : (
          <div style={{
            margin: '8px 20px', padding: '12px 14px', borderRadius: 10,
            background: '#1a1d24', border: '1px solid #2a2d35',
            fontSize: 12, color: '#6b6f7a', textAlign: 'center', lineHeight: 1.6,
          }}>
            ✅ Mesain de tamamlandı. İyi günler!
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={PAGE}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #2a2d35',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, background: '#0f1117', zIndex: 10,
      }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {subeBilgi?.ad || 'Şube'} · {vt.label}
          </div>
          <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 2 }}>
            {oturum.ad_soyad} · {oturum.tarih}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setSiparisAcik(true)} style={{
            background: 'rgba(200,149,106,0.12)', border: '1px solid var(--accent-border, rgba(200,149,106,0.3))',
            borderRadius: 8, color: '#C8956A', padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
          }}>
            📦 Sipariş
          </button>
          <button onClick={onCikis} style={{
            background: 'none', border: '1px solid #2a2d35', borderRadius: 8,
            color: '#6b6f7a', padding: '6px 12px', cursor: 'pointer', fontSize: 12,
          }}>
            Çıkış
          </button>
        </div>
      </div>

      {/* Kapanış Mühür Bandı — kapanış vardiyasında her zaman; diğer vardiyalarda
          sadece tek başına açıp-kapatan (devir süreci olmayan) personel için */}
      {kapanisUygun && (
        <KapanisMuhurBandi oturum={oturum} />
      )}

      {/* İlerleme */}
      {data && (
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #2a2d35' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
            <span style={{ color: '#b0b3bc' }}>Tamamlanan</span>
            <span style={{ fontWeight: 700, color: data.eksik === 0 ? '#4caf84' : vt.renk }}>
              {data.tamamlanan}/{data.toplam}
              {data.eksik === 0 ? ' · Tamamlandı ✓' : ` · ${data.eksik} kaldı`}
            </span>
          </div>
          <div style={{ height: 6, background: '#2a2d35', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${tamamYuzde}%`,
              background: data.eksik === 0 ? '#4caf84' : vt.renk,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* Sekmeler */}
      <div style={{ display: 'flex', borderBottom: '1px solid #2a2d35' }}>
        {[['gorevler','✅ Görevlerim'], ['vardiyam','⏱️ Vardiyam']].map(([id, label]) => (
          <button key={id} onClick={() => setSekme(id)} style={{
            flex: 1, padding: '12px', border: 'none', cursor: 'pointer',
            background: 'transparent', fontSize: 13, fontWeight: sekme === id ? 700 : 500,
            color: sekme === id ? '#C8956A' : '#6b6f7a',
            borderBottom: sekme === id ? '2px solid #C8956A' : '2px solid transparent',
            transition: 'all 0.15s',
          }}>{label}</button>
        ))}
      </div>

      {/* Vardiyam sekmesi */}
      {sekme === 'vardiyam' && <VardiyamEkrani oturum={oturum} />}

      {/* Yemek Molası + Mesai Çıkış */}
      {sekme === 'gorevler' && (
        <>
          {oturum.yemek_mola_hakki !== false && <YemekMolasiButon oturum={oturum} />}
          {/* Kapanış vardiyasında (veya tek başına kapanış yapan personelde) üstteki
              mühür bandı kullanılır, çıkış butonu tekrar gösterilmez */}
          {oturum.vardiya_tip !== 'kapanis' && !kapanisUygun && <MesaiCikisButon oturum={oturum} isDevreden={isDevreden} />}
        </>
      )}

      {/* Görev listesi — sadece görevlerim sekmesinde */}
      {sekme !== 'gorevler' ? null : <div style={{ padding: '12px 16px', paddingBottom: 80 }}>
        {yukleniyor ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b6f7a' }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />
            Görevler yükleniyor…
          </div>
        ) : !data?.gorevler?.length ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b6f7a' }}>
            Bu vardiya için görev bulunamadı.
          </div>
        ) : (
          data.gorevler.map((g) => (
            <div key={g.id}
              onClick={() => toggle(g)}
              style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 12px', borderRadius: 10, marginBottom: 8,
                background: g.tamamlandi ? 'rgba(76,175,132,0.06)' : '#1a1d24',
                border: `1px solid ${g.tamamlandi ? 'rgba(76,175,132,0.25)' : '#2a2d35'}`,
                cursor: islem[g.id] ? 'wait' : 'pointer',
                transition: 'all 0.15s',
                opacity: islem[g.id] ? 0.6 : 1,
              }}
            >
              <div style={{
                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                border: `2px solid ${g.tamamlandi ? '#4caf84' : '#6b6f7a'}`,
                background: g.tamamlandi ? '#4caf84' : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}>
                {g.tamamlandi && <span style={{ color: '#fff', fontSize: 14, lineHeight: 1 }}>✓</span>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 14, fontWeight: 500,
                  color: g.tamamlandi ? '#6b6f7a' : '#e8e9ec',
                  textDecoration: g.tamamlandi ? 'line-through' : 'none',
                  lineHeight: 1.35,
                }}>
                  {g.gorev}
                </div>
                <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 3 }}>
                  <span style={{ background: '#22262f', borderRadius: 4, padding: '1px 6px', marginRight: 6 }}>{g.alan}</span>
                  {g.siklik}
                </div>
              </div>
              <span style={{ fontSize: 11, color: '#2a2d35', fontWeight: 700, flexShrink: 0 }}>{g.sira}</span>
            </div>
          ))
        )}
      </div>}

      {/* Alt bant */}
      {sekme === 'gorevler' && data?.eksik === 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: 'rgba(76,175,132,0.15)', borderTop: '1px solid rgba(76,175,132,0.3)',
          padding: '14px 20px', textAlign: 'center',
          fontSize: 14, fontWeight: 700, color: '#4caf84',
        }}>
          ✅ Tüm görevler tamamlandı!
        </div>
      )}
    </div>
  );
}
