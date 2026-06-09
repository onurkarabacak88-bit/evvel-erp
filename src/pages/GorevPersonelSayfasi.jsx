import { useState, useEffect } from 'react';
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
                          <span style={{ fontSize: 18, fontWeight: 800, minWidth: 28, textAlign: 'center', color: '#C8956A' }}>{adet}</span>
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

// ── Yemek Molası Butonu ──────────────────────────────────────────────────────
function YemekMolasiButon({ oturum }) {
  const [durum, setDurum] = useState(null); // null | 'devam' | 'bitti'
  const [sure, setSure] = useState(null);
  const [ucretHakki, setUcretHakki] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [mesaj, setMesaj] = useState('');

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
        body: { sube_id: oturum.sube_id, personel_id: oturum.personel_id },
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
      setMesaj(e.message || 'Hata oluştu');
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
        </div>
      )}
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

      {/* Yemek Molası — her iki sekmede de görünür */}
      {sekme === 'gorevler' && <YemekMolasiButon oturum={oturum} />}

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
