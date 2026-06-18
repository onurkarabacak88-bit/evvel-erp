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
import { api, fmt } from '../../utils/api';

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

// Cep yalnızca GİDER onaylarını gösterir — kasa hataları (islem_turu'nde KASA geçen)
// buraya düşmez. Masaüstü Onay Kuyruğu'ndaki "Şube Giderleri" sekmesiyle aynı ayrım.
const giderOnayMi = (o) => !String(o?.islem_turu || '').toUpperCase().includes('KASA');

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

// ── Güncel Kasa hareketleri modalı (alt-sayfa) ──────────────────────────────
function CepKasaModal({ kasa, onKapat }) {
  const hareketler = kasa.hareketler || [];
  return (
    <div onClick={e => e.target === e.currentTarget && onKapat()} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50,
      display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        width: '100%', maxHeight: '85vh', background: C.bg2,
        borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTop: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>💰 Kasa Hareketleri</span>
            <button onClick={onKapat} style={{
              background: C.bg3, border: 'none', borderRadius: 10, color: C.t2,
              width: 36, height: 36, fontSize: 16, cursor: 'pointer',
            }}>✕</button>
          </div>
          <div style={{ fontSize: 13, color: C.t3, marginTop: 6 }}>
            Güncel bakiye: <b style={{ color: kasa.tutar >= 0 ? C.yesil : C.kirmizi }}>
              {kasa.tutar == null ? '…' : fmt(kasa.tutar)}
            </b>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '4px 16px 20px' }}>
          {hareketler.length === 0 && (
            <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Hareket yok.</div>
          )}
          {hareketler.slice(0, 30).map((h, i) => {
            const t = Number(h.tutar) || 0;
            return (
              <div key={h.id || i} style={{
                display: 'flex', justifyContent: 'space-between', gap: 10,
                padding: '11px 0', borderBottom: `1px solid ${C.border}`,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.4 }}>
                    {h.aciklama || h.islem_turu || '—'}
                  </div>
                  <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>
                    {h.islem_turu} · {String(h.tarih || '').slice(0, 10)}
                  </div>
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap',
                  color: t >= 0 ? C.yesil : C.kirmizi,
                }}>
                  {t >= 0 ? '+' : '−'}{fmt(Math.abs(t))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Ana ekran: kart ızgarası ────────────────────────────────────────────────
function CepHome({ sayac, kasa, onKasa, onAc, onCikis, yenile }) {
  const KARTLAR = [
    { id: 'odemeler', ikon: '💸', baslik: 'Bugün Ödemeler', renk: C.kirmizi,
      sayi: sayac.odeme,
      alt: sayac.odeme > 0 ? `${sayac.odeme} ödeme · ${fmt(sayac.odemeTutar)}` : 'Bugün ödeme yok' },
    { id: 'onaylar', ikon: '✅', baslik: 'Gider Onayı', renk: C.yesil,
      sayi: sayac.onay, alt: `${sayac.onay} bekleyen gider` },
    { id: 'depolar', ikon: '📦', baslik: 'Depolar', renk: C.mavi,
      sayi: null, alt: 'Tüm şube stokları' },
    // Denetim kartı şimdilik kapalı (kullanıcı kararı) — component/route dormant duruyor.
    { id: 'demirbas', ikon: '🛠️', baslik: 'Demirbaş & Arıza', renk: C.kirmizi,
      sayi: sayac.ariza, alt: sayac.ariza > 0 ? `${sayac.ariza} açık arıza` : 'Açık arıza yok' },
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

      {/* Güncel Kasa — CFO'daki gibi, tıkla → hareketler modalı */}
      <button onClick={onKasa} style={{
        display: 'block', width: 'calc(100% - 28px)', margin: '4px 14px 12px',
        textAlign: 'left', cursor: 'pointer', borderRadius: 16, padding: 18,
        background: 'linear-gradient(135deg, var(--bg2,#1a1d24), var(--bg3,#22262f))',
        border: `1px solid ${C.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: C.t3, fontWeight: 600 }}>💰 Güncel Kasa</span>
          <span style={{ fontSize: 12, color: C.t3 }}>Detay ›</span>
        </div>
        <div style={{
          fontSize: 30, fontWeight: 800, marginTop: 6,
          color: (kasa.tutar == null) ? C.t3 : (kasa.tutar >= 0 ? C.yesil : C.kirmizi),
        }}>
          {kasa.tutar == null ? '…' : fmt(kasa.tutar)}
        </div>
        {kasa.gun != null && kasa.gun < 999 && (
          <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{kasa.gun} gün dayanır</div>
        )}
      </button>

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
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{k.alt}</div>
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
      .then(d => setListe(Array.isArray(d) ? d.filter(giderOnayMi) : []))
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
      <Baslik baslik="✅ Gider Onayları" onGeri={onGeri}
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

// ── Şubeler (CANLI OPERASYON — açılış/kapanış, kasa farkı, ciro, geç giriş) ──
function CepSubeler({ onGeri }) {
  const [subeler, setSubeler] = useState(null);
  const [girisler, setGirisler] = useState([]);
  const [acilislar, setAcilislar] = useState([]);
  const [beklenenler, setBeklenenler] = useState([]);
  const [acilisKasa, setAcilisKasa] = useState([]);
  const [subeMeta, setSubeMeta] = useState([]); // /subeler — aktif + sezon_kapali
  const [hata, setHata] = useState('');
  const yukle = useCallback(() => {
    Promise.allSettled([
      api('/ops/kapanis-takip'),
      api('/ops/sube-giris-bugun'),
      api('/ops/acilis-kasa-takip'),
      api('/subeler'),
    ]).then(([kap, gir, ack, sub]) => {
      if (kap.status === 'fulfilled') setSubeler(kap.value?.satirlar || []);
      else { setHata('Yüklenemedi'); setSubeler([]); }
      if (gir.status === 'fulfilled') { setGirisler(gir.value?.girisler || []); setAcilislar(gir.value?.acilislar || []); setBeklenenler(gir.value?.beklenenler || []); }
      if (ack.status === 'fulfilled') setAcilisKasa(ack.value?.satirlar || []);
      if (sub.status === 'fulfilled') setSubeMeta(Array.isArray(sub.value) ? sub.value : []);
    });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  const kapaliSet = new Set(subeMeta.filter(s => s.sezon_kapali).map(s => s.id));

  const sezonToggle = async (sid, kapat) => {
    try {
      await api(`/subeler/${encodeURIComponent(sid)}/sezon`, { method: 'POST', body: { sezon_kapali: kapat } });
      yukle();
    } catch (e) { setHata(e.message || 'Hata'); }
  };

  const saat = (ts) => (ts ? String(ts).slice(11, 16) : null);
  const gecMetin = (dk) => dk == null ? null : (dk >= 1 ? `${dk} dk geç` : (dk <= -1 ? `${-dk} dk erken` : 'vaktinde'));

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🏪 Şubeler · Canlı" onGeri={onGeri} />
      <div style={{ padding: 14 }}>
        {subeler === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {(subeler || []).filter(s => !kapaliSet.has(s.sube_id)).map(s => {
          const ciro = (Number(s.nakit) || 0) + (Number(s.pos) || 0) + (Number(s.online) || 0);
          const fark = s.nakit_kasa_fark_tl;
          const subeGiris = girisler.filter(g => g.sube_id === s.sube_id);
          const gecler = subeGiris.filter(g => g.gecikme_dk != null && g.gecikme_dk >= 5);
          const acl = acilislar.find(a => a.sube_id === s.sube_id);
          const acilisGec = acl?.gecikme_dk;
          const acilisGecVar = acilisGec != null && acilisGec >= 5;
          const acilisRenk = !s.acildi ? C.t3 : (acilisGec != null && acilisGec >= 5 ? C.sari : C.yesil);
          // Vardiyası var ama girmemiş (no-show): vardiyası başlamış (dk_gecti>=5) ve hâlâ yok
          const girmeyenler = beklenenler.filter(b => b.sube_id === s.sube_id && b.dk_gecti != null && b.dk_gecti >= 5);
          const ak = acilisKasa.find(a => a.sube_id === s.sube_id);
          const akFarkVar = ak && ak.fark_tl != null && Math.abs(Number(ak.fark_tl)) > 1;
          const serit = (girmeyenler.length || akFarkVar || (fark && Math.abs(Number(fark)) > 1)) ? C.kirmizi
            : ((gecler.length || acilisGecVar) ? C.sari : C.yesil);
          return (
            <div key={s.sube_id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
              padding: 14, marginBottom: 12,
              borderLeft: `4px solid ${serit}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{s.sube_adi}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: acilisRenk }}>
                  {s.acildi ? `açıldı ${saat(s.acilis_ts) || ''}` : 'açılmadı'}{s.kapanis_tamam ? ' · kapandı' : ''}
                </span>
              </div>
              {/* Açılış: planlanan (ilk vardiya) vs fiili (11:00 → 11:05 = 5 dk geç) */}
              {acl?.planlanan && s.acildi && (
                <div style={{ fontSize: 12, marginBottom: 6, color: acilisGec >= 1 ? C.sari : C.yesil }}>
                  Açılış planı {acl.planlanan} · {acl.fiili_saat || saat(s.acilis_ts)} → <strong>{gecMetin(acilisGec) || 'vaktinde'}</strong>
                </div>
              )}
              {/* Açılış kasa uyumsuzluğu (sabah sayım vs dünkü devir) */}
              {(() => {
                const ak = acilisKasa.find(a => a.sube_id === s.sube_id);
                if (!ak || ak.fark_tl == null || Math.abs(Number(ak.fark_tl)) <= 1) return null;
                const f = Number(ak.fark_tl);
                return (
                  <div style={{ fontSize: 12, marginBottom: 8, color: C.kirmizi, fontWeight: 700 }}>
                    ⚠ Açılış kasa farkı: {f > 0 ? `${fmt(f)} fazla` : `${fmt(Math.abs(f))} eksik`}
                    <span style={{ color: C.t3, fontWeight: 400 }}> (sayım {fmt(ak.acilis_kasa_tl)} · devir {fmt(ak.beklenen_devir_tl)})</span>
                  </div>
                );
              })()}

              {/* Kasa farkı + ciro */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, background: C.bg3, borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: C.t3 }}>Kasa farkı</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: fark == null ? C.t3 : (Math.abs(Number(fark)) <= 1 ? C.yesil : (Number(fark) > 0 ? C.kirmizi : C.sari)) }}>
                    {fark == null ? '—' : (Number(fark) > 0 ? `${fmt(fark)} açık` : Number(fark) < 0 ? `${fmt(Math.abs(Number(fark)))} fazla` : '0 ✓')}
                  </div>
                </div>
                <div style={{ flex: 1, background: C.bg3, borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: C.t3 }}>Ciro</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{ciro > 0 ? fmt(ciro) : '—'}</div>
                </div>
              </div>

              {/* Geç girişler (isim · 09-18 · X dk geç) */}
              {subeGiris.length > 0 ? (
                <div style={{ marginTop: 4 }}>
                  {subeGiris.map((g, i) => {
                    const gec = g.gecikme_dk != null && g.gecikme_dk >= 5;
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: gec ? C.sari : C.t3 }}>
                        <span style={{ color: C.t2 }}>{g.personel_ad}{g.baslangic_saat ? ` · ${g.baslangic_saat}-${g.bitis_saat || ''}` : ''}</span>
                        <span style={{ fontWeight: gec ? 800 : 400 }}>
                          {g.gecikme_dk == null ? (g.giris_saat || '') : (g.gecikme_dk >= 5 ? `${g.gecikme_dk} dk geç` : (g.gecikme_dk <= -1 ? `${-g.gecikme_dk} dk erken` : 'vaktinde'))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: C.t3, marginTop: 4 }}>Henüz giriş yok</div>
              )}

              {/* Vardiyası var ama GİRMEMİŞ (no-show) */}
              {girmeyenler.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.kirmizi, marginBottom: 3 }}>⚠ Girmedi ({girmeyenler.length})</div>
                  {girmeyenler.map((b, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: C.kirmizi }}>
                      <span>{b.personel_ad}{b.baslangic_saat ? ` · ${b.baslangic_saat}-${b.bitis_saat || ''}` : ''}</span>
                      <span style={{ fontWeight: 800 }}>{b.dk_gecti} dk oldu, yok</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Sezon yönetimi — şubeyi sezonluk kapat/aç (kapalı = canlı listede gizli) */}
        {subeMeta.filter(s => s.aktif !== false).length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.t3, marginBottom: 8 }}>SEZON YÖNETİMİ</div>
            {subeMeta.filter(s => s.aktif !== false).map(s => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                <span style={{ fontSize: 14, color: s.sezon_kapali ? C.t3 : C.t1 }}>
                  {s.ad}{s.sezon_kapali ? ' · sezon kapalı' : ''}
                </span>
                <button onClick={() => sezonToggle(s.id, !s.sezon_kapali)} style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${s.sezon_kapali ? C.yesil : C.border}`,
                  background: s.sezon_kapali ? C.yesil : C.bg2,
                  color: s.sezon_kapali ? '#fff' : C.t2,
                }}>
                  {s.sezon_kapali ? 'Sezonu Aç' : 'Sezonu Kapat'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bugün Ödemeler (bugün + gecikmiş, tüm kaynaklar) ─────────────────────────
function CepOdemeler({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');

  useEffect(() => {
    api('/odeme-plani/bugun')
      .then(d => setListe(Array.isArray(d) ? d : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);

  const toplam = (liste || []).reduce((s, o) => s + (Number(o.tutar) || 0), 0);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="💸 Bugün Ödemeler" onGeri={onGeri} />

      {liste && liste.length > 0 && (
        <div style={{
          margin: 14, padding: 16, borderRadius: 14, background: C.bg2,
          border: `1px solid ${C.border}`, textAlign: 'center',
        }}>
          <div style={{ fontSize: 12, color: C.t3 }}>Bugün ödenecek toplam</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.t1, marginTop: 4 }}>{fmt(toplam)}</div>
        </div>
      )}

      <div style={{ padding: '0 14px 24px' }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            Bugün ödenecek bir şey yok.
          </div>
        )}
        {(liste || []).map(o => (
          <div key={o.id} style={{
            background: C.bg2, border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${o.gecikmis ? C.kirmizi : C.sari}`,
            borderRadius: 14, padding: 14, marginBottom: 12,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <span style={{
                fontSize: 11, fontWeight: 700, color: C.mavi, background: 'rgba(59,130,246,0.12)',
                padding: '2px 8px', borderRadius: 6,
              }}>{o.tip}</span>
              {o.gecikmis
                ? <span style={{ fontSize: 12, fontWeight: 700, color: C.kirmizi }}>⚠ {o.gun_gecikme} gün gecikmiş</span>
                : <span style={{ fontSize: 12, color: C.t3 }}>Bugün</span>}
            </div>
            <div style={{ fontSize: 15, color: C.t1, marginBottom: 8, lineHeight: 1.4 }}>{o.baslik}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.t1 }}>{fmt(o.tutar)}</div>
            {o.asgari != null && o.asgari > 0 && (
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>Asgari: {fmt(o.asgari)}</div>
            )}
          </div>
        ))}

        {liste && liste.length > 0 && (
          <div style={{ fontSize: 11, color: C.t3, textAlign: 'center', marginTop: 6, lineHeight: 1.5 }}>
            Bu ekran ödenecekleri gösterir. Ödeme işaretleme masaüstü panelden yapılır
            (telefondan ödeme Faz 2'de eklenecek).
          </div>
        )}
      </div>
    </div>
  );
}

// ── Demirbaş & Arıza (alt yapı — şimdilik açık arızalar; sonra zenginleşir) ──
function CepDemirbas({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  useEffect(() => {
    api('/stok-sayim/ariza/liste?durum=acik')
      .then(d => setListe(d?.arizalar || []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🛠️ Demirbaş & Arıza" onGeri={onGeri} />
      <div style={{ padding: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.t2, marginBottom: 10 }}>Açık arızalar</div>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            Açık arıza yok.
          </div>
        )}
        {(liste || []).map(a => (
          <div key={a.id} style={{
            background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${C.kirmizi}`,
            borderRadius: 14, padding: 14, marginBottom: 12,
          }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>
              {a.baslik}{a.kalem_ad ? <span style={{ color: C.t3, fontWeight: 400 }}> · {a.kalem_ad}</span> : null}
            </div>
            <div style={{ fontSize: 12, color: C.t3, marginTop: 3 }}>
              {a.sube_adi} · {a.alan === 'diger' ? 'Diğer' : 'Demirbaş'}{a.bildiren_ad ? ` · ${a.bildiren_ad}` : ''} · {String(a.olusturma).slice(0, 16)}
            </div>
            {a.aciklama && <div style={{ fontSize: 13, color: C.t2, marginTop: 5 }}>{a.aciklama}</div>}
          </div>
        ))}
        <div style={{ fontSize: 11, color: C.t3, textAlign: 'center', marginTop: 10, lineHeight: 1.5 }}>
          Alt yapı kuruldu. Demirbaş eksiklik özeti ve telefondan çözme sonraki adımda eklenecek.
        </div>
      </div>
    </div>
  );
}

// ── Depolar (tüm şube depo stoğu — şube seç / tümü karşılaştır / ara) ────────
function CepDepolar({ onGeri }) {
  const [data, setData] = useState(null);
  const [hata, setHata] = useState('');
  const [aktif, setAktif] = useState('tumu'); // 'tumu' | sube_id
  const [ara, setAra] = useState('');
  const [sonGuncel, setSonGuncel] = useState(null);
  const yukle = useCallback((sessiz) => {
    if (!sessiz) setHata('');
    api('/ops/depo-stok')
      .then(d => { setData(d); setSonGuncel(new Date()); })
      .catch(e => { if (!sessiz) { setHata(e.message || 'Yüklenemedi'); setData({ subeler: [], kalemler: [] }); } });
  }, []);
  // Canlı: aç açmaz çek + 45 sn'de bir sessiz tazele (stok düştükçe güncellensin)
  useEffect(() => {
    yukle();
    const t = setInterval(() => yukle(true), 45000);
    return () => clearInterval(t);
  }, [yukle]);

  const subeler = data?.subeler || [];
  const kisa = (ad) => (ad || '').slice(0, 3).toUpperCase();
  const q = ara.trim().toLocaleLowerCase('tr');
  let kalemler = (data?.kalemler || []).filter(k => !q || (k.kalem_adi || '').toLocaleLowerCase('tr').includes(q));
  // Tek şube modunda: sadece o depoda kaydı olan kalemler
  if (aktif !== 'tumu') kalemler = kalemler.filter(k => k.adetler && k.adetler[aktif] != null);

  // Özet
  const ozetAdet = kalemler.reduce((s, k) => s + (aktif === 'tumu' ? (k.toplam || 0) : (k.adetler[aktif] || 0)), 0);

  // Kategoriye grupla
  const gruplar = {};
  kalemler.forEach(k => { const g = k.kategori || 'Diğer'; (gruplar[g] = gruplar[g] || []).push(k); });

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="📦 Depolar" onGeri={onGeri} sag={
        <button onClick={() => yukle()} title="Yenile" style={{
          background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10,
          color: C.t2, padding: '8px 12px', fontSize: 14, cursor: 'pointer',
        }}>↻</button>
      } />
      {/* Şube chip'leri + arama — sticky */}
      <div style={{ position: 'sticky', top: 0, zIndex: 5, background: C.bg, padding: '10px 14px 8px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}>
          {[{ id: 'tumu', ad: 'Tümü' }, ...subeler].map(s => (
            <button key={s.id} onClick={() => setAktif(s.id)} style={{
              flex: '0 0 auto', padding: '7px 13px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${aktif === s.id ? C.mavi : C.border}`,
              background: aktif === s.id ? C.mavi : C.bg2, color: aktif === s.id ? '#fff' : C.t2, whiteSpace: 'nowrap',
            }}>{s.ad}</button>
          ))}
        </div>
        <input value={ara} onChange={e => setAra(e.target.value)} placeholder="🔍 Ürün ara…" style={{
          width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.bg2, color: C.t1, fontSize: 15, boxSizing: 'border-box',
        }} />
        <div style={{ fontSize: 11, color: C.t3, marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>{kalemler.length} kalem · {ozetAdet} adet</span>
          {sonGuncel && <span>🟢 canlı · {sonGuncel.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      </div>

      <div style={{ padding: '8px 14px 28px' }}>
        {data === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {data && kalemler.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>Kalem bulunamadı.</div>
        )}
        {Object.entries(gruplar).map(([kat, items]) => (
          <div key={kat} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.t3, padding: '8px 2px 4px' }}>{kat} <span style={{ color: C.border }}>({items.length})</span></div>
            {items.map(k => {
              if (aktif === 'tumu') {
                return (
                  <div key={k.kalem_kodu} style={{ padding: '9px 2px', borderTop: `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.t1, flex: 1 }}>{k.kalem_adi}</span>
                      <span style={{ fontSize: 14, fontWeight: 800, color: C.t1 }}>{k.toplam}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {subeler.map(s => {
                        const adet = k.adetler?.[s.id] ?? 0;
                        return (
                          <span key={s.id} style={{
                            fontSize: 11, padding: '2px 7px', borderRadius: 6,
                            background: C.bg3, color: adet > 0 ? C.t2 : C.t3,
                          }}>{kisa(s.ad)} {adet}</span>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              const adet = k.adetler[aktif] || 0;
              const dusuk = k.min_stok > 0 && adet <= k.min_stok;
              return (
                <div key={k.kalem_kodu} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 2px', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 14, color: C.t1, flex: 1 }}>
                    {k.kalem_adi}{dusuk && <span style={{ fontSize: 11, color: C.kirmizi, fontWeight: 700 }}> · düşük</span>}
                  </span>
                  <span style={{ fontSize: 16, fontWeight: 800, color: dusuk ? C.kirmizi : (adet > 0 ? C.t1 : C.t3) }}>{adet}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Kök bileşen ─────────────────────────────────────────────────────────────
export default function CepApp() {
  const [girisli, setGirisli] = useState(() => tokenGecerli());
  const [view, setView] = useState('home');
  const [sayac, setSayac] = useState({ onay: 0, odeme: 0, odemeTutar: 0, ariza: 0 });
  const [kasa, setKasa] = useState({ tutar: null, gun: null, hareketler: [] });
  const [kasaModal, setKasaModal] = useState(false);

  const sayaclariYukle = useCallback(() => {
    Promise.allSettled([
      api('/onay-kuyrugu?durum=bekliyor&limit=400'),
      api('/odeme-plani/bugun'),
      api('/kasa'),
      api('/panel'),
      api('/stok-sayim/ariza/liste?durum=acik'),
    ]).then(([onay, odeme, kasaR, panelR, arizaR]) => {
      const onayN = (onay.status === 'fulfilled' && Array.isArray(onay.value)) ? onay.value.filter(giderOnayMi).length : 0;
      const odemeArr = (odeme.status === 'fulfilled' && Array.isArray(odeme.value)) ? odeme.value : [];
      const odemeTutar = odemeArr.reduce((s, o) => s + (Number(o.tutar) || 0), 0);
      const arizaN = (arizaR.status === 'fulfilled' && Number(arizaR.value?.toplam)) ? Number(arizaR.value.toplam) : 0;
      setSayac({ onay: onayN, odeme: odemeArr.length, odemeTutar, ariza: arizaN });

      const kTutar = (kasaR.status === 'fulfilled') ? (Number(kasaR.value?.guncel_bakiye) || 0) : null;
      const hareketler = (kasaR.status === 'fulfilled' && Array.isArray(kasaR.value?.hareketler)) ? kasaR.value.hareketler : [];
      const gun = (panelR.status === 'fulfilled' && panelR.value?.kac_gun_dayanir != null)
        ? Number(panelR.value.kac_gun_dayanir) : null;
      setKasa({ tutar: kTutar, gun, hareketler });
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

  if (view === 'odemeler')
    return <CepOdemeler onGeri={geri} />;
  if (view === 'onaylar')
    return <CepOnaylar onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'denetim')
    return <CepDenetim onGeri={geri} />;
  if (view === 'demirbas')
    return <CepDemirbas onGeri={geri} />;
  if (view === 'depolar')
    return <CepDepolar onGeri={geri} />;
  if (view === 'subeler')
    return <CepSubeler onGeri={geri} />;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Instrument Sans, system-ui, sans-serif' }}>
      <CepHome sayac={sayac} kasa={kasa} onKasa={() => setKasaModal(true)}
        onAc={setView} onCikis={cikis} yenile={sayaclariYukle} />
      {kasaModal && <CepKasaModal kasa={kasa} onKapat={() => setKasaModal(false)} />}
    </div>
  );
}
