// ── EVVEL · CEP ───────────────────────────────────────────────────────────────
// İşletme sahibinin (Onur + kardeşi) telefondan, herhangi bir yerden eriştiği
// MOBİL KABUK. Masaüstü ERP'ye dokunmaz — ayrı bir kabuk (codex + plan kararı):
//   PC'de: analiz, rapor, veri girişi.   Telefonda: bak, onayla, unutma, müdahale.
//
// Faz 1 (bu dosya):
//   - Cihazda "beni hatırla" oturumu → her açılışta şifre sormaz (30 gün).
//   - Kart ızgarası ana ekran (sığ) → karta dokun → telefona uygun derin ekran.
//   - Onaylar TAM çalışır (telefondan onayla / reddet).
//   - Hatırlatmalar = var olan olaylardan türeyen "dikkat akışı" (YENİ tablo YOK).
//   - Şubeler & Denetim: günlük denetim raporundan okunur özet.
// Faz 2 (sonra): PIN + kritik aksiyonda tekrar doğrulama + uzaktan oturum kapatma.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../utils/api';

// ── Cihaz oturumu (frontend "beni hatırla") ─────────────────────────────────
// Not: Bu demo/iç kullanım için yeterli. Gerçek (uzaktan iptal edilebilir) token
// + PIN Faz 2'de eklenecek — güvenlik geçişi kullanıcı kararıyla ertelendi.
const CEP_KEY = 'cep_oturum';
const CEP_GUN = 30;
function tokenGecerli() {
  try {
    const r = JSON.parse(localStorage.getItem(CEP_KEY) || 'null');
    return !!(r && r.exp && Date.now() < r.exp);
  } catch { return false; }
}
function tokenYaz() {
  try {
    localStorage.setItem(CEP_KEY, JSON.stringify({
      ts: Date.now(), exp: Date.now() + CEP_GUN * 24 * 3600 * 1000,
    }));
  } catch { /* ignore */ }
}
function tokenSil() { try { localStorage.removeItem(CEP_KEY); } catch { /* ignore */ } }

const C = {
  bg: 'var(--bg1, #0f1117)',
  bg2: 'var(--bg2, #1a1d24)',
  bg3: 'var(--bg3, #22262f)',
  border: 'var(--border, #2a2d35)',
  t1: 'var(--text1, #e8e9ec)',
  t2: 'var(--text2, #a8acb8)',
  t3: 'var(--text3, #6b6f7a)',
  marka: '#C8956A',
  yesil: '#22c55e',
  kirmizi: '#ef4444',
  sari: '#f59e0b',
  mavi: '#3b82f6',
};

const bugunTR = () =>
  new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

// ── Giriş kapısı (mobil) ─────────────────────────────────────────────────────
function CepGiris({ onGiris }) {
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);

  const girisYap = async (e) => {
    e.preventDefault();
    setHata(''); setYukleniyor(true);
    try {
      const res = await api('/admin-giris', { method: 'POST', body: { sifre } });
      if (res?.ok) { tokenYaz(); onGiris(); }
    } catch (e2) {
      setHata(e2.message || 'Şifre yanlış');
    } finally { setYukleniyor(false); }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', background: C.bg,
      padding: 24, fontFamily: 'Instrument Sans, system-ui, sans-serif',
    }}>
      <div style={{ fontSize: 30, marginBottom: 6 }}>📱</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.t1, letterSpacing: 0.5 }}>EVVEL · CEP</div>
      <div style={{ fontSize: 13, color: C.t3, marginBottom: 28, marginTop: 4 }}>
        Telefondan kontrol paneli
      </div>
      <form onSubmit={girisYap} style={{ width: '100%', maxWidth: 360 }}>
        <input
          type="password" autoFocus value={sifre}
          onChange={e => setSifre(e.target.value)} placeholder="Şifre"
          style={{
            width: '100%', padding: '16px 16px', borderRadius: 12, marginBottom: 12,
            border: `1px solid ${C.border}`, background: C.bg2, color: C.t1,
            fontSize: 17, boxSizing: 'border-box', textAlign: 'center',
          }}
        />
        {hata && <div style={{ fontSize: 13, color: C.kirmizi, marginBottom: 12, textAlign: 'center' }}>{hata}</div>}
        <button type="submit" disabled={yukleniyor || !sifre} style={{
          width: '100%', padding: '16px', borderRadius: 12, border: 'none',
          background: C.marka, color: '#fff', fontWeight: 800, fontSize: 16,
          cursor: 'pointer', opacity: (yukleniyor || !sifre) ? 0.6 : 1,
        }}>
          {yukleniyor ? '…' : 'Giriş Yap'}
        </button>
        <div style={{ fontSize: 11, color: C.t3, textAlign: 'center', marginTop: 14 }}>
          🔒 Bu cihazda 30 gün açık kalır — tekrar şifre sorulmaz.
        </div>
      </form>
    </div>
  );
}

// ── Üst başlık (geri butonlu) ───────────────────────────────────────────────
function Baslik({ baslik, onGeri, sag }) {
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 30, background: C.bg,
      borderBottom: `1px solid ${C.border}`, padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      {onGeri && (
        <button onClick={onGeri} style={{
          background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10,
          color: C.t1, width: 40, height: 40, fontSize: 18, cursor: 'pointer',
          flexShrink: 0,
        }}>←</button>
      )}
      <div style={{ fontSize: 17, fontWeight: 800, color: C.t1, flex: 1 }}>{baslik}</div>
      {sag}
    </div>
  );
}

// ── Ana ekran: kart ızgarası ────────────────────────────────────────────────
function CepHome({ sayac, onAc, onCikis, yenile }) {
  const KARTLAR = [
    { id: 'hatirlatmalar', ikon: '🔔', baslik: 'Hatırlatmalar', renk: C.sari,
      sayi: sayac.dikkat, alt: 'Bugün dikkat isteyen' },
    { id: 'onaylar', ikon: '✅', baslik: 'Onaylar', renk: C.yesil,
      sayi: sayac.onay, alt: 'Bekleyen onay' },
    { id: 'denetim', ikon: '🧠', baslik: 'Denetim', renk: C.kirmizi,
      sayi: sayac.anomali, alt: 'Bugün uyarı' },
    { id: 'subeler', ikon: '🏪', baslik: 'Şubeler', renk: C.mavi,
      sayi: null, alt: 'Durum özeti' },
  ];

  return (
    <div style={{ paddingBottom: 28 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 16px 10px',
      }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: C.t1 }}>EVVEL · CEP</div>
          <div style={{ fontSize: 13, color: C.t3, marginTop: 2, textTransform: 'capitalize' }}>{bugunTR()}</div>
        </div>
        <button onClick={onCikis} title="Çıkış" style={{
          background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10,
          color: C.t2, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
        }}>Çıkış</button>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '4px 14px',
      }}>
        {KARTLAR.map(k => (
          <button key={k.id} onClick={() => onAc(k.id)} style={{
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 16,
            padding: 16, minHeight: 124, textAlign: 'left', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            position: 'relative',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 30 }}>{k.ikon}</span>
              {k.sayi != null && k.sayi > 0 && (
                <span style={{
                  minWidth: 26, height: 26, padding: '0 8px', borderRadius: 999,
                  background: k.renk, color: '#fff', fontSize: 14, fontWeight: 800,
                  lineHeight: '26px', textAlign: 'center',
                }}>{k.sayi}</span>
              )}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, color: C.t1 }}>{k.baslik}</div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>
                {k.sayi != null ? `${k.sayi} ${k.alt.toLowerCase()}` : k.alt}
              </div>
            </div>
          </button>
        ))}
      </div>

      <button onClick={yenile} style={{
        margin: '18px auto 0', display: 'block', background: 'none', border: 'none',
        color: C.t3, fontSize: 13, cursor: 'pointer',
      }}>↻ Yenile</button>
    </div>
  );
}

// ── Onaylar (tam çalışır) ───────────────────────────────────────────────────
function CepOnaylar({ onGeri, onDegisti }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [islemId, setIslemId] = useState(null);
  const [reddet, setReddet] = useState(null); // {id, aciklama}

  const yukle = useCallback(() => {
    setHata('');
    api('/onay-kuyrugu?durum=bekliyor&limit=400')
      .then(d => setListe(Array.isArray(d) ? d : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const onayla = async (id) => {
    setIslemId(id);
    try {
      await api(`/onay-kuyrugu/${id}/onayla`, { method: 'POST' });
      setListe(l => (l || []).filter(o => o.id !== id));
      onDegisti && onDegisti();
    } catch (e) { alert('Onaylanamadı: ' + (e.message || '')); }
    finally { setIslemId(null); }
  };

  const reddetGonder = async (neden) => {
    if (!reddet) return;
    const id = reddet.id;
    setReddet(null); setIslemId(id);
    try {
      await api(`/onay-kuyrugu/${id}/reddet`, { method: 'POST', body: { neden } });
      setListe(l => (l || []).filter(o => o.id !== id));
      onDegisti && onDegisti();
    } catch (e) { alert('Reddedilemedi: ' + (e.message || '')); }
    finally { setIslemId(null); }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="✅ Onaylar" onGeri={onGeri}
        sag={<button onClick={yukle} style={{
          background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer',
        }}>↻</button>} />

      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            Bekleyen onay yok.
          </div>
        )}
        {(liste || []).map(o => {
          const mesgul = islemId === o.id;
          const tutar = o.tutar != null
            ? `${parseFloat(o.tutar).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`
            : null;
          return (
            <div key={o.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
              padding: 14, marginBottom: 12, opacity: mesgul ? 0.55 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: C.sari, background: 'rgba(245,158,11,0.12)',
                  padding: '2px 8px', borderRadius: 6,
                }}>{o.islem_turu}</span>
                <span style={{ fontSize: 12, color: C.t3 }}>{o.tarih}</span>
              </div>
              <div style={{ fontSize: 15, color: C.t1, marginBottom: tutar ? 6 : 12, lineHeight: 1.4 }}>
                {o.aciklama || '—'}
              </div>
              {tutar && (
                <div style={{ fontSize: 18, fontWeight: 800, color: C.t1, marginBottom: 12 }}>{tutar}</div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button disabled={mesgul} onClick={() => onayla(o.id)} style={{
                  flex: 1, padding: '13px', borderRadius: 10, border: 'none',
                  background: C.yesil, color: '#fff', fontWeight: 800, fontSize: 15,
                  cursor: 'pointer',
                }}>✓ Onayla</button>
                <button disabled={mesgul} onClick={() => setReddet({ id: o.id, aciklama: o.aciklama })} style={{
                  padding: '13px 18px', borderRadius: 10, border: `1px solid ${C.kirmizi}`,
                  background: 'transparent', color: C.kirmizi, fontWeight: 700, fontSize: 15,
                  cursor: 'pointer',
                }}>✕</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reddet alt-sayfası — kritik aksiyon, ikinci onay */}
      {reddet && (
        <div onClick={e => e.target === e.currentTarget && setReddet(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
          display: 'flex', alignItems: 'flex-end',
        }}>
          <div style={{
            width: '100%', background: C.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20,
            padding: 18, borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.t1, marginBottom: 4 }}>Reddetme sebebi</div>
            <div style={{ fontSize: 13, color: C.t3, marginBottom: 16 }}>{reddet.aciklama}</div>
            <button onClick={() => reddetGonder('hata')} style={{
              width: '100%', textAlign: 'left', padding: 14, borderRadius: 12, marginBottom: 10,
              border: `1px solid ${C.border}`, background: C.bg, color: C.t1, cursor: 'pointer',
            }}>
              <div style={{ fontWeight: 700 }}>🔧 Hata</div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>Yanlış oluştu, kaynak aktif kalır.</div>
            </button>
            <button onClick={() => reddetGonder('surec_bitti')} style={{
              width: '100%', textAlign: 'left', padding: 14, borderRadius: 12, marginBottom: 10,
              border: `1px solid ${C.kirmizi}`, background: C.bg, color: C.t1, cursor: 'pointer',
            }}>
              <div style={{ fontWeight: 700, color: C.kirmizi }}>🚫 Süreç Bitti</div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>İlişki kesildi, kaynak kapatılır.</div>
            </button>
            <button onClick={() => setReddet(null)} style={{
              width: '100%', padding: 13, borderRadius: 12, border: 'none',
              background: C.bg3, color: C.t2, fontWeight: 700, cursor: 'pointer',
            }}>Vazgeç</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Denetim (günlük rapordan) ───────────────────────────────────────────────
function CepDenetim({ onGeri }) {
  const [data, setData] = useState(null);
  const [hata, setHata] = useState('');
  useEffect(() => {
    const bugun = new Date().toISOString().slice(0, 10);
    api(`/ops/truth/gunluk-rapor?tarih=${bugun}`)
      .then(d => setData(d?.subeler || []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setData([]); });
  }, []);

  const renkli = (s) => s.alarm === 'kritik' || s.anomali_sayisi >= 3
    ? C.kirmizi : (s.anomali_sayisi > 0 ? C.sari : C.yesil);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧠 Denetim · Bugün" onGeri={onGeri} />
      <div style={{ padding: 14 }}>
        {data === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {(data || []).map(s => (
          <div key={s.sube_id} style={{
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
            padding: 14, marginBottom: 12, borderLeft: `4px solid ${renkli(s)}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{s.sube_ad}</span>
              <span style={{ fontSize: 12, color: renkli(s), fontWeight: 700 }}>
                {s.anomali_sayisi > 0 ? `${s.anomali_sayisi} uyarı` : '✓ temiz'}
              </span>
            </div>
            {s.zeka_ozet && <div style={{ fontSize: 13, color: C.t2, marginTop: 6, lineHeight: 1.4 }}>{s.zeka_ozet}</div>}
            {Array.isArray(s.boyut_ozet) && s.boyut_ozet.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {s.boyut_ozet.map((b, i) => (
                  <span key={i} style={{
                    fontSize: 11, color: C.t2, background: C.bg3, padding: '3px 8px', borderRadius: 6,
                  }}>{b.ozet}</span>
                ))}
              </div>
            )}
            {!s.calistirildi && (
              <div style={{ fontSize: 12, color: C.t3, marginTop: 6 }}>Henüz çalışmadı / veri yok</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Şubeler (durum özeti — günlük rapordan) ─────────────────────────────────
function CepSubeler({ onGeri }) {
  const [data, setData] = useState(null);
  const [hata, setHata] = useState('');
  useEffect(() => {
    const bugun = new Date().toISOString().slice(0, 10);
    api(`/ops/truth/gunluk-rapor?tarih=${bugun}`)
      .then(d => setData(d?.subeler || []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setData([]); });
  }, []);

  const durum = (s) => {
    if (!s.calistirildi) return { t: '⏳ Veri yok', r: C.t3 };
    if (s.anomali_sayisi >= 3 || s.alarm === 'kritik') return { t: '🔴 Dikkat', r: C.kirmizi };
    if (s.anomali_sayisi > 0) return { t: '🟡 İzle', r: C.sari };
    return { t: '🟢 Normal', r: C.yesil };
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🏪 Şubeler" onGeri={onGeri} />
      <div style={{ padding: 14 }}>
        {data === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {(data || []).map(s => {
          const d = durum(s);
          return (
            <div key={s.sube_id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
              padding: 16, marginBottom: 12, display: 'flex', justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{s.sube_ad}</div>
                <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>
                  {s.anomali_sayisi > 0 ? `${s.anomali_sayisi} denetim uyarısı` : 'Uyarı yok'}
                </div>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: d.r }}>{d.t}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Hatırlatmalar = Dikkat Akışı (var olan olaylardan türer, YENİ tablo YOK) ──
function CepHatirlatmalar({ onGeri, onAc }) {
  const [akis, setAkis] = useState(null);

  useEffect(() => {
    const bugun = new Date().toISOString().slice(0, 10);
    Promise.allSettled([
      api('/onay-kuyrugu?durum=bekliyor&limit=400'),
      api('/ciro-taslak?durum=bekliyor'),
      api(`/ops/truth/gunluk-rapor?tarih=${bugun}`),
      api('/stok-sayim/bekleyen-onay'),
      api('/is-basvurusu/ozet'),
    ]).then(([onay, ciro, denetim, stok, basvuru]) => {
      const items = [];
      const sayi = (r) => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value.length : 0;

      const oNum = sayi(onay);
      if (oNum > 0) items.push({
        ikon: '✅', oncelik: 2, baslik: `${oNum} onay bekliyor`,
        detay: 'Şube giderleri / kasa onayları', git: 'onaylar', renk: C.yesil,
      });

      const cNum = sayi(ciro);
      if (cNum > 0) items.push({
        ikon: '📋', oncelik: 2, baslik: `${cNum} ciro onayı bekliyor`,
        detay: 'Şube ciro taslakları onay bekliyor', git: null, renk: C.mavi,
      });

      if (denetim.status === 'fulfilled') {
        const subeler = denetim.value?.subeler || [];
        const top = subeler.reduce((s, r) => s + (Number(r.anomali_sayisi) || 0), 0);
        const krit = subeler.filter(r => (r.anomali_sayisi || 0) > 0).map(r => r.sube_ad);
        if (top > 0) items.push({
          ikon: '🧠', oncelik: 3, baslik: `${top} denetim uyarısı`,
          detay: krit.length ? `Şube: ${krit.join(', ')}` : 'Bugünkü denetim', git: 'denetim', renk: C.kirmizi,
        });
      }

      const sNum = (stok.status === 'fulfilled') ? (Number(stok.value?.toplam) || 0) : 0;
      if (sNum > 0) items.push({
        ikon: '📋', oncelik: 1, baslik: `${sNum} stok sayımı onay bekliyor`,
        detay: 'Personel sayımları onayını bekliyor', git: null, renk: C.sari,
      });

      const bNum = (basvuru.status === 'fulfilled') ? (Number(basvuru.value?.yeni) || 0) : 0;
      if (bNum > 0) items.push({
        ikon: '💼', oncelik: 1, baslik: `${bNum} yeni iş başvurusu`,
        detay: 'Henüz incelenmedi', git: null, renk: C.mavi,
      });

      items.sort((a, b) => b.oncelik - a.oncelik);
      setAkis(items);
    });
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🔔 Hatırlatmalar" onGeri={onGeri} />
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: C.t3, marginBottom: 14, lineHeight: 1.5 }}>
          Sistem otomatik üretir — bugün dikkat isteyen işler. Üstte en önemlisi.
        </div>
        {akis === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {akis && akis.length === 0 && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✨</div>
            Her şey yolunda — bekleyen iş yok.
          </div>
        )}
        {(akis || []).map((it, i) => (
          <button key={i} onClick={() => it.git && onAc(it.git)} style={{
            width: '100%', textAlign: 'left', background: C.bg2, border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${it.renk}`, borderRadius: 14, padding: 14, marginBottom: 12,
            cursor: it.git ? 'pointer' : 'default', display: 'flex', gap: 12, alignItems: 'center',
          }}>
            <span style={{ fontSize: 26 }}>{it.ikon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.t1 }}>{it.baslik}</div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{it.detay}</div>
            </div>
            {it.git && <span style={{ color: C.t3, fontSize: 20 }}>›</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Kök bileşen ─────────────────────────────────────────────────────────────
export default function CepApp() {
  const [girisli, setGirisli] = useState(() => tokenGecerli());
  const [view, setView] = useState('home');
  const [sayac, setSayac] = useState({ onay: 0, anomali: 0, dikkat: 0 });

  const sayaclariYukle = useCallback(() => {
    const bugun = new Date().toISOString().slice(0, 10);
    Promise.allSettled([
      api('/onay-kuyrugu?durum=bekliyor&limit=400'),
      api('/ciro-taslak?durum=bekliyor'),
      api(`/ops/truth/gunluk-rapor?tarih=${bugun}`),
      api('/stok-sayim/bekleyen-onay'),
      api('/is-basvurusu/ozet'),
    ]).then(([onay, ciro, denetim, stok, basvuru]) => {
      const onayN = (onay.status === 'fulfilled' && Array.isArray(onay.value)) ? onay.value.length : 0;
      const ciroN = (ciro.status === 'fulfilled' && Array.isArray(ciro.value)) ? ciro.value.length : 0;
      const anomN = denetim.status === 'fulfilled'
        ? (denetim.value?.subeler || []).reduce((s, r) => s + (Number(r.anomali_sayisi) || 0), 0) : 0;
      const stokN = (stok.status === 'fulfilled') ? (Number(stok.value?.toplam) || 0) : 0;
      const basvN = (basvuru.status === 'fulfilled') ? (Number(basvuru.value?.yeni) || 0) : 0;
      // dikkat = kaç ayrı "dikkat satırı" var (sayıların toplamı değil)
      const dikkat = [onayN, ciroN, anomN, stokN, basvN].filter(n => n > 0).length;
      setSayac({ onay: onayN, anomali: anomN, dikkat });
    });
  }, []);

  useEffect(() => {
    if (!girisli) return;
    sayaclariYukle();
    const t = setInterval(sayaclariYukle, 60000);
    return () => clearInterval(t);
  }, [girisli, sayaclariYukle]);

  if (!girisli) return <CepGiris onGiris={() => setGirisli(true)} />;

  const cikis = () => { tokenSil(); setGirisli(false); setView('home'); };
  const geri = () => setView('home');

  if (view === 'onaylar')
    return <CepOnaylar onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'denetim')
    return <CepDenetim onGeri={geri} />;
  if (view === 'subeler')
    return <CepSubeler onGeri={geri} />;
  if (view === 'hatirlatmalar')
    return <CepHatirlatmalar onGeri={geri} onAc={setView} />;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Instrument Sans, system-ui, sans-serif' }}>
      <CepHome sayac={sayac} onAc={setView} onCikis={cikis} yenile={sayaclariYukle} />
    </div>
  );
}
