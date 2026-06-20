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

import { useState, useEffect, useCallback, useRef } from 'react';
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

// wa.me numara normalizasyonu (TR) — geçerli değilse '' döner
const cepWaNum = (tel) => {
  let n = String(tel || '').replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length === 11 && n.startsWith('0')) n = '90' + n.slice(1);
  else if (n.length === 10 && n.startsWith('5')) n = '90' + n;
  else if (n.length === 12 && n.startsWith('90')) { /* zaten */ }
  return n.length >= 11 ? n : '';
};

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
    { id: 'ciro', ikon: '📋', baslik: 'Ciro Onayı', renk: C.mavi,
      sayi: sayac.ciro, alt: sayac.ciro > 0 ? `${sayac.ciro} bekleyen ciro` : 'Bekleyen ciro yok' },
    { id: 'kasa-uyumsuzluk', ikon: '🔴', baslik: 'Kasa Uyumsuzluğu', renk: C.kirmizi,
      sayi: sayac.kasaUyum, alt: sayac.kasaUyum > 0 ? `${sayac.kasaUyum} açık fark` : 'Bugün fark yok' },
    { id: 'dis-kaynak', ikon: '🪙', baslik: 'Dış Kaynak', renk: C.yesil,
      sayi: null, alt: sayac.disKaynak > 0 ? `Bu ay ${fmt(sayac.disKaynak)}` : 'Bu ay gelir yok' },
    { id: 'anlik-gider', ikon: '💸', baslik: 'Anlık Gider', renk: C.kirmizi,
      sayi: null, alt: 'Gider ekle / aylık liste' },
    { id: 'vadeli', ikon: '🧾', baslik: 'Vadeli Alımlar', renk: '#f59e0b',
      sayi: null, alt: 'Vadeli borç ekle / öde' },
    { id: 'kartlar', ikon: '💳', baslik: 'Kartlar', renk: C.kirmizi,
      sayi: null, alt: 'Borç · limit · yaklaşan' },
    { id: 'kule', ikon: '🚚', baslik: 'Sipariş Kulesi', renk: C.mavi,
      sayi: sayac.kule, alt: sayac.kule > 0 ? `${sayac.kule} yönlendir bekliyor` : 'Gelen sipariş & yönlendir' },
    { id: 'depolar', ikon: '📦', baslik: 'Depolar', renk: C.mavi,
      sayi: null, alt: 'Tüm şube stokları' },
    { id: 'belge-talep', ikon: '🧾', baslik: 'Fatura Bekleyen', renk: '#f59e0b',
      sayi: sayac.belge, alt: sayac.belge > 0 ? `${sayac.belge} teslimat faturası bekliyor` : 'Fatura bekleyen yok' },
    { id: 'merkez-sil', ikon: '🧹', baslik: 'Merkez Sipariş Temizliği', renk: C.kirmizi,
      sayi: null, alt: 'Deneme siparişlerini sil' },
    // Denetim kartı şimdilik kapalı (kullanıcı kararı) — component/route dormant duruyor.
    { id: 'basvurular', ikon: '🧑‍💼', baslik: 'İş Başvuruları', renk: C.mavi,
      sayi: sayac.basvuru, alt: sayac.basvuru > 0 ? `${sayac.basvuru} yeni başvuru` : 'Yeni başvuru yok' },
    { id: 'stok-sayim', ikon: '📋', baslik: 'Stok Sayım', renk: C.mavi,
      sayi: sayac.sayimOnay, alt: sayac.sayimOnay > 0 ? `${sayac.sayimOnay} onay bekliyor` : 'Görev ata / onayla' },
    { id: 'vardiya-takip', ikon: '👥', baslik: 'Vardiya Takip', renk: C.mavi,
      sayi: null, alt: 'Aylık mesai / gecikme' },
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

// ── Ciro Onayları (şube kapanış ciro taslakları — onayla/reddet) ─────────────
function CepCiroOnay({ onGeri, onDegisti }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [islemId, setIslemId] = useState(null);

  const yukle = useCallback(() => {
    setHata('');
    api('/ciro-taslak?durum=bekliyor')
      .then(d => setListe(Array.isArray(d) ? d : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const onayla = async (id) => {
    setIslemId(id);
    try {
      await api(`/ciro-taslak/${id}/onayla`, { method: 'POST', body: {} });
      setListe(l => (l || []).filter(o => o.id !== id));
      onDegisti && onDegisti();
    } catch (e) { alert('Onaylanamadı: ' + (e.message || '')); }
    finally { setIslemId(null); }
  };

  const reddetGonder = async (id) => {
    const neden = window.prompt('Reddetme sebebi (şubeye gider):', '');
    if (neden === null) return;
    setIslemId(id);
    try {
      await api(`/ciro-taslak/${id}/reddet`, { method: 'POST', body: { neden: (neden || '').trim() || 'Tutar hatalı' } });
      setListe(l => (l || []).filter(o => o.id !== id));
      onDegisti && onDegisti();
    } catch (e) { alert('Reddedilemedi: ' + (e.message || '')); }
    finally { setIslemId(null); }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="📋 Ciro Onayları" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            Onay bekleyen ciro yok.
          </div>
        )}
        {(liste || []).map(o => {
          const mesgul = islemId === o.id;
          const nakit = Number(o.nakit) || 0, pos = Number(o.pos) || 0, online = Number(o.online) || 0;
          const toplam = nakit + pos + online;
          return (
            <div key={o.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
              padding: 14, marginBottom: 12, opacity: mesgul ? 0.55 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{o.sube_adi}</span>
                <span style={{ fontSize: 12, color: C.t3 }}>{o.tarih}{o.gonderen_ad ? ` · ${o.gonderen_ad}` : ''}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {[['Nakit', nakit], ['POS', pos], ['Online', online]].map(([l, v]) => (
                  <div key={l} style={{ flex: 1, background: C.bg3, borderRadius: 10, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: C.t3 }}>{l}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.t1 }}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.yesil, marginBottom: 12 }}>Toplam {fmt(toplam)}</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button disabled={mesgul} onClick={() => onayla(o.id)} style={{
                  flex: 1, padding: '13px', borderRadius: 10, border: 'none',
                  background: C.yesil, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer',
                }}>✓ Onayla</button>
                <button disabled={mesgul} onClick={() => reddetGonder(o.id)} style={{
                  padding: '13px 18px', borderRadius: 10, border: `1px solid ${C.kirmizi}`,
                  background: 'transparent', color: C.kirmizi, fontWeight: 700, fontSize: 15, cursor: 'pointer',
                }}>✕</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Kasa Uyumsuzluğu (salt-okur — PC formuna yakın, müdahalesiz) ─────────────
function CepKasaUyumsuzluk({ onGeri }) {
  const [data, setData] = useState(null);
  const [hata, setHata] = useState('');
  const [gun, setGun] = useState(0); // 0=bugün(iş günü), 1=dün...
  const [isGunBaz, setIsGunBaz] = useState(null); // backend'in çözdüğü iş günü (Şubeler ile aynı baz)
  const yukle = useCallback(() => {
    setHata('');
    // gün=0 → tarih GÖNDERME: backend is_gunu_tr() kullansın (Şubeler/kapanış-takip ile aynı gün).
    // Takvim günü yollanırsa gece penceresinde iş günü ile uyuşmaz → fark "kayıp" görünürdü.
    let url = '/ops/kasa-uyumsuzluk?sadece_bekleyen=false';
    if (gun > 0 && isGunBaz) {
      const t = new Date(isGunBaz + 'T00:00:00'); t.setDate(t.getDate() - gun);
      url += `&tarih=${t.toISOString().slice(0, 10)}`;
    }
    api(url)
      .then(d => { setData(d); if (gun === 0 && d?.tarih) setIsGunBaz(d.tarih); })
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setData({ liste: [] }); });
  }, [gun, isGunBaz]);
  useEffect(() => { yukle(); const t = setInterval(yukle, 60000); return () => clearInterval(t); }, [yukle]);

  const liste = data?.liste || [];
  const sevRenk = (s) => s === 'kritik' ? C.kirmizi : s === 'uyari' ? C.sari : C.t3;
  const tipMetin = (t) => String(t).includes('ACILIS') ? 'Açılış' : String(t).includes('KAPANIS') ? 'Kapanış' : t;
  const gunMetin = gun === 0 ? 'Bugün' : gun === 1 ? 'Dün' : `${gun} gün önce`;

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🔴 Kasa Uyumsuzluğu" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Gün gezinme */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '10px 14px', borderBottom: `1px solid ${C.border}` }}>
        <button onClick={() => setGun(g => g + 1)} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: '6px 12px', fontSize: 16, cursor: 'pointer' }}>‹</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.t1, minWidth: 110, textAlign: 'center' }}>
          {gunMetin}
          {data?.tarih && <div style={{ fontSize: 10, color: C.t3, fontWeight: 400 }}>{new Date(data.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} · iş günü</div>}
        </span>
        <button onClick={() => setGun(g => Math.max(0, g - 1))} disabled={gun === 0} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: gun === 0 ? C.t3 : C.t2, padding: '6px 12px', fontSize: 16, cursor: gun === 0 ? 'default' : 'pointer' }}>›</button>
      </div>

      <div style={{ padding: 14 }}>
        {data === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {data && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            {gunMetin} kasa uyumsuzluğu yok.
          </div>
        )}
        {liste.map(u => {
          const r = sevRenk(u.seviye);
          const f = Number(u.fark_tl) || 0;
          return (
            <div key={u.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${r}`,
              borderRadius: 14, padding: 14, marginBottom: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{u.sube_adi}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: r, background: C.bg3, padding: '2px 8px', borderRadius: 6 }}>
                  {tipMetin(u.tip)}{u.seviye && u.seviye !== 'normal' ? ` · ${u.seviye}` : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
                <div style={{ flex: 1, background: C.bg3, borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: C.t3 }}>Fark</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: Math.abs(f) <= 1 ? C.t2 : r }}>{f > 0 ? '+' : ''}{fmt(f)}</div>
                </div>
                <div style={{ flex: 1, background: C.bg3, borderRadius: 10, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: C.t3 }}>Beklenen → Gerçek</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.t1 }}>{fmt(u.beklenen_tl)} → {fmt(u.gercek_tl)}</div>
                </div>
              </div>
              {u.mesaj && <div style={{ fontSize: 12, color: C.t2, lineHeight: 1.4 }}>{u.mesaj}</div>}
              {(u.acilis_personel_ad || u.kapanis_personel_ad) && (
                <div style={{ fontSize: 11, color: C.t3, marginTop: 5 }}>
                  {u.acilis_personel_ad ? `açan: ${u.acilis_personel_ad}` : ''}{u.acilis_personel_ad && u.kapanis_personel_ad ? ' · ' : ''}{u.kapanis_personel_ad ? `kapatan: ${u.kapanis_personel_ad}` : ''}
                </div>
              )}
              {u.okundu && <div style={{ fontSize: 11, color: C.yesil, marginTop: 4, fontWeight: 700 }}>✓ çözüldü</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Dış Kaynak Geliri (CFO'daki gibi — bu ay toplam + liste, salt-okur) ──────
function CepDisKaynak({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [ayOff, setAyOff] = useState(0); // 0=bu ay, 1=geçen ay...
  const ayStr = (() => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - ayOff); return t.toISOString().slice(0, 7); })();
  const ayMetin = (() => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - ayOff); return t.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }); })();

  const yukle = useCallback(() => {
    setHata('');
    api(`/dis-kaynak?ay=${ayStr}`)
      .then(d => setListe(Array.isArray(d) ? d : (d?.liste || [])))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, [ayStr]);
  useEffect(() => { yukle(); }, [yukle]);

  const aktif = (liste || []).filter(x => x.durum !== 'iptal');
  const toplam = aktif.reduce((s, x) => s + (Number(x.tutar) || 0), 0);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🪙 Dış Kaynak Geliri" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Ay gezinme + toplam */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 10 }}>
          <button onClick={() => setAyOff(a => a + 1)} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: '6px 12px', fontSize: 16, cursor: 'pointer' }}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.t1, minWidth: 130, textAlign: 'center', textTransform: 'capitalize' }}>{ayMetin}</span>
          <button onClick={() => setAyOff(a => Math.max(0, a - 1))} disabled={ayOff === 0} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: ayOff === 0 ? C.t3 : C.t2, padding: '6px 12px', fontSize: 16, cursor: ayOff === 0 ? 'default' : 'pointer' }}>›</button>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: C.t3 }}>Ciro dışı gelir (toplam)</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: toplam > 0 ? C.yesil : C.t3, marginTop: 2 }}>{fmt(toplam)}</div>
        </div>
      </div>

      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>Bu ay dış kaynak geliri yok.</div>
        )}
        {(liste || []).map(x => {
          const iptal = x.durum === 'iptal';
          return (
            <div key={x.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14,
              padding: '12px 14px', marginBottom: 10, opacity: iptal ? 0.5 : 1,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, color: C.t1, lineHeight: 1.4, textDecoration: iptal ? 'line-through' : 'none' }}>{x.aciklama || '—'}</div>
                  <div style={{ fontSize: 11, color: C.t3, marginTop: 3 }}>{x.tarih}{iptal ? ' · iptal' : ''}</div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: iptal ? C.t3 : C.yesil, whiteSpace: 'nowrap' }}>{fmt(x.tutar)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Belge Talep (fatura bekleyen teslimatlar — wa.me ile fatura iste) ────────
function CepBelgeTalep({ onGeri, onDegisti }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState('');

  const yukle = useCallback(() => {
    setHata('');
    api('/belge-talep/bekleyen')
      .then(d => setListe(Array.isArray(d?.talepler) ? d.talepler : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  // wa.me numara normalizasyonu (CepDepolar ile aynı kural)
  const telNorm = (tel) => {
    let num = String(tel || '').replace(/\D/g, '');
    if (num.startsWith('00')) num = num.slice(2);
    if (num.length === 11 && num.startsWith('0')) num = '90' + num.slice(1);
    else if (num.length === 10 && num.startsWith('5')) num = '90' + num;
    return num.length >= 11 ? num : '';
  };

  const faturaIste = async (x) => {
    const num = telNorm(x.tedarikci_tel);
    if (!num) { setHata(`${x.tedarikci_ad || 'Tedarikçi'} için geçerli telefon yok`); return; }
    const tarih = x.teslim_tarihi ? new Date(x.teslim_tarihi).toLocaleDateString('tr-TR') : 'bugünkü';
    const mesaj =
      `Merhaba ${x.tedarikci_ad || ''},\n\n` +
      `*${x.sube_adi || ''}* şubemize ${tarih} tarihli teslimatınız ulaştı. 🙏\n` +
      `Bu teslimata ait *faturanın PDF nüshasını* iletebilir misiniz?\n\n` +
      `Teşekkürler.`;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(mesaj)}`, '_blank');
    // İz: mesaj sayısını artır (belge ritmi) — hata olsa da wa.me açıldı
    try { await api(`/belge-talep/${x.id}/mesaj-gonderildi`, { method: 'POST' }); yukle(); } catch { /* yut */ }
  };

  // Toptancı WhatsApp'tan faturayı yolladı → dosyayı yükle (mevcut fatura boru hattına gider,
  // bu teslimata damgalanır, 'fatura geldi' sinyali yakalanır → kart kapanır)
  const faturaYukle = async (x, dosya) => {
    if (!dosya) return;
    setMesgul(x.id); setHata('');
    try {
      const fd = new FormData();
      fd.append('dosya', dosya, dosya.name || 'fatura');
      const res = await fetch(`/api/belge-talep/${x.id}/fatura-yukle`, { method: 'POST', body: fd });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e && (e.detail || e.mesaj)) || 'Yükleme başarısız');
      }
      yukle(); onDegisti && onDegisti();
    } catch (e) { setHata(typeof e.message === 'string' ? e.message : 'Yükleme başarısız'); }
    finally { setMesgul(''); }
  };

  // Dijital fatura yoksa (sadece kâğıt) elle kapat — yedek
  const elleKapat = async (x) => {
    setMesgul(x.id);
    try { await api(`/belge-talep/${x.id}/kapat`, { method: 'POST', body: { durum: 'kapandi' } }); yukle(); onDegisti && onDegisti(); }
    catch (e) { setHata(e.message || 'Kapatılamadı'); }
    finally { setMesgul(''); }
  };

  // Yaşa göre renk: <24sa sarı, <72sa turuncu, ≥72sa kırmızı
  const renk = (s) => s >= 72 ? C.kirmizi : (s >= 24 ? '#f59e0b' : C.sari);
  const yasMetin = (s) => s < 1 ? 'az önce' : (s < 24 ? `${Math.round(s)} saat önce` : `${Math.floor(s / 24)} gün önce`);

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧾 Fatura Bekleyen" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.t3, lineHeight: 1.5 }}>
        Şube teslim aldı, faturası henüz gelmedi. Toptancıdan PDF iste; geldiğinde buradan yükle → otomatik maliyete düşer ve kart kapanır.
      </div>
      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 16 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>Fatura bekleyen teslimat yok. ✅</div>
        )}
        {(liste || []).map(x => {
          const yas = Number(x.yas_saat) || 0;
          const bar = renk(yas);
          const telVar = !!telNorm(x.tedarikci_tel);
          return (
            <div key={x.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${bar}`,
              borderRadius: 14, padding: '12px 14px', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{x.tedarikci_ad || 'Tedarikçi'}</div>
                  <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{x.sube_adi || ''} · {x.teslim_tarihi ? new Date(x.teslim_tarihi).toLocaleDateString('tr-TR') : ''} teslimatı</div>
                  <div style={{ fontSize: 11, color: C.t3, marginTop: 3 }}>
                    {yasMetin(yas)}{x.mesaj_sayisi > 0 ? ` · ${x.mesaj_sayisi}× istendi` : ' · henüz istenmedi'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={() => faturaIste(x)} disabled={!telVar} style={{
                  flex: 1, background: telVar ? '#25D366' : C.bg, color: telVar ? '#fff' : C.t3,
                  border: telVar ? 'none' : `1px solid ${C.border}`, borderRadius: 10, padding: '11px 0',
                  fontSize: 14, fontWeight: 800, cursor: telVar ? 'pointer' : 'default',
                }}>{telVar ? '📲 Fatura İste' : 'Telefon yok'}</button>
                <label style={{
                  flex: 1, background: C.mavi, color: '#fff', borderRadius: 10, padding: '11px 0',
                  fontSize: 14, fontWeight: 800, cursor: mesgul === x.id ? 'default' : 'pointer',
                  textAlign: 'center', opacity: mesgul === x.id ? 0.6 : 1,
                }}>
                  {mesgul === x.id ? 'Yükleniyor…' : '📎 Fatura Geldi'}
                  <input type="file" accept="application/pdf,image/*" style={{ display: 'none' }}
                    disabled={mesgul === x.id}
                    onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; faturaYukle(x, f); }} />
                </label>
              </div>
              <div style={{ textAlign: 'center', marginTop: 6 }}>
                <button onClick={() => elleKapat(x)} disabled={mesgul === x.id} style={{
                  background: 'none', border: 'none', color: C.t3, fontSize: 11,
                  textDecoration: 'underline', cursor: 'pointer',
                }}>fatura dijital değil · elle kapat</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── İş Başvuruları (salt-okur — gelen başvuruları telefondan gör) ───────────
function CepBasvurular({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [filtre, setFiltre] = useState('aktif'); // aktif | arsiv
  const [secili, setSecili] = useState(null);    // detay açılan başvuru

  const yukle = useCallback(() => {
    setHata('');
    const q = filtre === 'arsiv' ? '?arsivli=true' : '?arsivli=false';
    api(`/is-basvurusu${q}`)
      .then(d => setListe(Array.isArray(d) ? d : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, [filtre]);
  useEffect(() => { yukle(); }, [yukle]);

  const durumRenk = (d) => {
    const s = String(d || '').toLowerCase();
    if (s.includes('olumlu') || s.includes('kabul') || s.includes('alindi')) return C.yesil;
    if (s.includes('olumsuz') || s.includes('red')) return C.kirmizi;
    if (s.includes('deger') || s.includes('gorus') || s.includes('mulakat')) return C.mavi;
    return C.sari;
  };
  // Numara gösterimi: başında 0 yoksa biz ekleyelim (10 hane 5'le başlıyorsa → 0...)
  const telFmt = (tel) => {
    let d = String(tel || '').replace(/\D/g, '');
    if (d.startsWith('90') && d.length === 12) d = d.slice(2);
    if (d.length === 10 && d.startsWith('5')) d = '0' + d;
    return d || String(tel || '');
  };
  const telNorm = (tel) => telFmt(tel);

  const ac = (b) => {
    setSecili(b);
    // Görüldü işaretle (YENİ rozetini düşür) — salt-okur dünyada zararsız
    if (!b.goruldu_ts) {
      api(`/is-basvurusu/${b.id}/gor`, { method: 'PATCH' }).then(yukle).catch(() => {});
    }
  };

  if (secili) return <CepBasvuruDetay b={secili} onGeri={() => setSecili(null)} durumRenk={durumRenk} telNorm={telNorm} />;

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧑‍💼 İş Başvuruları" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Aktif / Arşiv sekmesi */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        {[['aktif', 'Aktif'], ['arsiv', 'Arşiv']].map(([k, etk]) => (
          <button key={k} onClick={() => setFiltre(k)} style={{
            flex: 1, background: filtre === k ? C.mavi : C.bg2, color: filtre === k ? '#fff' : C.t2,
            border: `1px solid ${filtre === k ? C.mavi : C.border}`, borderRadius: 10, padding: '9px 0',
            fontSize: 14, fontWeight: 700, cursor: 'pointer',
          }}>{etk}</button>
        ))}
      </div>
      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 16 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>{filtre === 'arsiv' ? 'Arşivde başvuru yok.' : 'Aktif başvuru yok.'}</div>
        )}
        {(liste || []).map(b => {
          const yeni = !b.goruldu_ts;
          const subeler = Array.isArray(b.tercih_subeler) ? b.tercih_subeler.join(', ') : '';
          const tel = telNorm(b.telefon);
          return (
            <div key={b.id} onClick={() => ac(b)} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${durumRenk(b.durum)}`,
              borderRadius: 14, padding: '12px 14px', marginBottom: 10, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: C.t1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {b.ad_soyad || '—'}
                    {yeni && <span style={{ background: C.kirmizi, color: '#fff', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 6 }}>YENİ</span>}
                    {(b.oncelik === 1 || b.oncelik === 2) && <span style={{ fontSize: 12 }}>{b.oncelik === 1 ? '⭐' : '🔸'}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>{b.pozisyon || 'Pozisyon belirtilmemiş'}{subeler ? ` · ${subeler}` : ''}</div>
                  <div style={{ fontSize: 11, color: C.t3, marginTop: 3 }}>
                    {b.ilce || ''}{b.dogum_yili ? ` · ${b.dogum_yili}` : ''}{b.olusturma_ts ? ` · ${new Date(b.olusturma_ts).toLocaleDateString('tr-TR')}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {b.skor && b.skor.toplam != null && <div style={{ fontSize: 18, fontWeight: 800, color: C.t1 }}>{b.skor.toplam}</div>}
                  <div style={{ fontSize: 10, color: durumRenk(b.durum), fontWeight: 700, marginTop: 2 }}>{b.durum || ''}</div>
                </div>
              </div>
              {tel && (
                <a href={`tel:${tel}`} onClick={e => e.stopPropagation()} style={{
                  display: 'block', textAlign: 'center', marginTop: 10, background: C.bg,
                  border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 0',
                  fontSize: 14, fontWeight: 700, color: C.yesil, textDecoration: 'none',
                }}>📞 {tel}</a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── İş Başvurusu Detay (skor kırılımı + sinyaller + tüm bilgiler) ───────────
function CepBasvuruDetay({ b, onGeri, durumRenk, telNorm }) {
  const skor = b.skor || {};
  const boyutlar = skor.boyutlar || {};
  const sinyaller = Array.isArray(skor.sinyaller) ? skor.sinyaller : [];
  const tel = telNorm(b.telefon);
  const subeler = Array.isArray(b.tercih_subeler) ? b.tercih_subeler.join(', ') : '';
  const gunler = Array.isArray(b.musait_gunler) ? b.musait_gunler.join(', ') : '';

  const ETIKET = {
    pozisyon: 'Pozisyon', calisma_tercihi: 'Çalışma', baslangic: 'Başlangıç',
    en_erken_saat: 'En erken saat', kahve_deneyim: 'Kahve deneyimi', ulasim: 'Ulaşım',
    ilce: 'İlçe', dogum_yili: 'Doğum yılı', yasam_durumu: 'Yaşam', egitim_durumu: 'Eğitim',
  };
  const satirlar = Object.keys(ETIKET)
    .map(k => [ETIKET[k], b[k]])
    .filter(([, v]) => v != null && String(v).trim() !== '');

  const Row = ({ etk, val }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontSize: 12, color: C.t3 }}>{etk}</span>
      <span style={{ fontSize: 13, color: C.t1, fontWeight: 600, textAlign: 'right' }}>{String(val)}</span>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧑‍💼 Başvuru Detayı" onGeri={onGeri} />
      <div style={{ padding: 14, paddingBottom: 30 }}>
        {/* Üst kart: ad + skor */}
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div>
              <div style={{ fontSize: 19, fontWeight: 800, color: C.t1 }}>{b.ad_soyad || '—'}</div>
              <div style={{ fontSize: 12, color: durumRenk(b.durum), fontWeight: 700, marginTop: 3 }}>{b.durum || ''}</div>
            </div>
            {skor.toplam != null && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 30, fontWeight: 800, color: C.t1, lineHeight: 1 }}>{skor.toplam}</div>
                <div style={{ fontSize: 10, color: C.t3 }}>/ 100{skor.genel_label ? ` · ${skor.genel_label}` : ''}</div>
              </div>
            )}
          </div>
          {tel && (
            <a href={`tel:${tel}`} style={{
              display: 'block', textAlign: 'center', marginTop: 12, background: '#25D366',
              borderRadius: 10, padding: '11px 0', fontSize: 14, fontWeight: 800, color: '#fff', textDecoration: 'none',
            }}>📞 {tel}</a>
          )}
        </div>

        {/* Skor boyutları (5 × 20) */}
        {Object.keys(boyutlar).length > 0 && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.t1, marginBottom: 10 }}>📊 Skor Kırılımı</div>
            {Object.keys(boyutlar).map(k => {
              const d = boyutlar[k] || {};
              const p = Number(d.puan) || 0;
              const oran = Math.max(0, Math.min(100, (p / 20) * 100));
              const renk = p >= 15 ? C.yesil : (p >= 9 ? C.sari : C.kirmizi);
              return (
                <div key={k} style={{ marginBottom: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.t2, marginBottom: 3 }}>
                    <span>{d.label || k}</span><span style={{ fontWeight: 700, color: C.t1 }}>{p}/20</span>
                  </div>
                  <div style={{ height: 7, background: C.bg, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${oran}%`, height: '100%', background: renk }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Sinyaller */}
        {sinyaller.length > 0 && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.t1, marginBottom: 8 }}>🚩 Sinyaller</div>
            {sinyaller.map((s, i) => (
              <div key={i} style={{
                fontSize: 13, color: s.tip === 'olumlu' ? C.yesil : C.sari, padding: '4px 0',
                lineHeight: 1.4,
              }}>{s.mesaj}</div>
            ))}
          </div>
        )}

        {/* Bilgiler */}
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.t1, marginBottom: 6 }}>📋 Bilgiler</div>
          {subeler && <Row etk="Tercih şubeler" val={subeler} />}
          {satirlar.map(([etk, val]) => <Row key={etk} etk={etk} val={val} />)}
          {gunler && <Row etk="Müsait günler" val={gunler} />}
        </div>

        {/* Tanıtım / not */}
        {(b.tanitim || b.ek_not) && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.t1, marginBottom: 8 }}>✍️ Kendini Tanıtımı</div>
            {b.tanitim && <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{b.tanitim}</div>}
            {b.ek_not && <div style={{ fontSize: 12, color: C.t3, marginTop: 8, fontStyle: 'italic' }}>Not: {b.ek_not}</div>}
            {(b.referans_ad || b.referans_tel) && (
              <div style={{ fontSize: 12, color: C.t3, marginTop: 8 }}>Referans: {b.referans_ad || ''} {b.referans_tel || ''}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Merkez Sipariş Temizliği (deneme/sahte siparişleri sil — stok geri al) ───
function CepMerkezSil({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState('');
  const [bilgi, setBilgi] = useState('');

  const yukle = useCallback(() => {
    setHata('');
    api('/ops/siparis/merkez-liste')
      .then(d => setListe(Array.isArray(d?.siparisler) ? d.siparisler : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const sil = async (s) => {
    const stokUyari = s.teslim_alindi
      ? '\n\n⚠️ Bu sipariş TESLİM ALINMIŞ — eklenen stok da Tema deposundan GERİ ALINACAK.'
      : '';
    if (!window.confirm(`${s.tedarikci_ad || 'Sipariş'} (${s.sube_adi || ''}) silinsin mi?${stokUyari}\n\nBu işlem geri alınamaz.`)) return;
    setMesgul(s.talep_id); setHata(''); setBilgi('');
    try {
      const r = await api('/ops/siparis/merkez-test-temizle', {
        method: 'POST', body: { talep_id: s.talep_id, stok_geri_al: true },
      });
      const gr = Array.isArray(r?.stok_geri_alinan) ? r.stok_geri_alinan : [];
      setBilgi(gr.length ? `Silindi · stok geri alındı: ${gr.join(', ')}` : 'Silindi.');
      yukle();
    } catch (e) { setHata(e.message || 'Silinemedi'); }
    finally { setMesgul(''); }
  };

  const durumEtiket = (s) => {
    if (s.iptalli) return { t: 'iptal', renk: C.t3 };
    if (s.teslim_alindi) return { t: 'teslim alındı · stok eklendi', renk: C.yesil };
    return { t: 'yolda/bekliyor', renk: C.sari };
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧹 Merkez Sipariş Temizliği" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, fontSize: 12, color: C.t3, lineHeight: 1.5 }}>
        Telefondan/merkezden verilen deneme siparişleri. Sil dersen sipariş kaydı kalkar; teslim alınmışsa eklenen stok da geri alınır.
      </div>
      {bilgi && <div style={{ margin: 14, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13 }}>{bilgi}</div>}
      <div style={{ padding: 14 }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 16 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>Merkez siparişi yok.</div>
        )}
        {(liste || []).map(s => {
          const d = durumEtiket(s);
          return (
            <div key={s.talep_id} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${d.renk}`,
              borderRadius: 14, padding: '12px 14px', marginBottom: 10,
            }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{s.tedarikci_ad || 'Tedarikçi yok'}</div>
              <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{s.sube_adi || ''}{s.kalem_ozet ? ` · ${s.kalem_ozet}` : ''}</div>
              <div style={{ fontSize: 11, color: d.renk, fontWeight: 700, marginTop: 3 }}>
                {d.t}{s.olusturma ? ` · ${new Date(s.olusturma).toLocaleDateString('tr-TR')}` : ''}
              </div>
              <button onClick={() => sil(s)} disabled={mesgul === s.talep_id} style={{
                width: '100%', marginTop: 10, background: C.kirmizi, color: '#fff', border: 'none',
                borderRadius: 10, padding: '11px 0', fontSize: 14, fontWeight: 800,
                cursor: mesgul === s.talep_id ? 'default' : 'pointer', opacity: mesgul === s.talep_id ? 0.6 : 1,
              }}>{mesgul === s.talep_id ? 'Siliniyor…' : '🗑️ Sil'}</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Anlık Gider (telefondan gider ekle — nakit/kart + aylık liste) ──────────
const GIDER_KATEGORILER = ['Nakit Alım', 'Market', 'Fatura', 'Kargo', 'Yemek', 'Yakıt', 'Bakım', 'Diğer'];

function CepAnlikGider({ onGeri }) {
  const bugun = () => new Date().toISOString().split('T')[0];
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [kartlar, setKartlar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [formAcik, setFormAcik] = useState(false);
  const [ayOff, setAyOff] = useState(0); // 0=bu ay, 1=geçen ay…
  const [f, setF] = useState({ tarih: bugun(), kategori: 'Diğer', tutar: '', aciklama: '', sube: 'MERKEZ', odeme_yontemi: 'nakit', kart_id: '' });

  const ayStr = (() => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - ayOff); return t.toISOString().slice(0, 7); })();
  const ayMetin = (() => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - ayOff); return t.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' }); })();

  const yukle = useCallback(() => {
    setHata('');
    api(`/anlik-gider?durum=aktif&include_summary=true&ay=${ayStr}`)
      .then(r => setListe(Array.isArray(r) ? r : (r?.satirlar || [])))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, [ayStr]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => {
    api('/kartlar').then(r => setKartlar(Array.isArray(r) ? r : [])).catch(() => {});
    api('/subeler').then(r => setSubeler(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const kaydet = async () => {
    const tutarN = Number(String(f.tutar).replace(',', '.'));
    if (!tutarN || tutarN <= 0) { setHata('Geçerli tutar girin'); return; }
    if (f.odeme_yontemi === 'kart' && !f.kart_id) { setHata('Kart seçin'); return; }
    setMesgul(true); setHata(''); setBilgi('');
    try {
      const body = { ...f, tutar: tutarN };
      if (f.odeme_yontemi === 'nakit') delete body.kart_id;
      const res = await api('/anlik-gider', { method: 'POST', body });
      if (res && res.warning) { setHata(res.mesaj || 'Mükerrer olabilir — tekrar deneyin'); setMesgul(false); return; }
      setBilgi(f.odeme_yontemi === 'kart' ? 'Eklendi — kart borcuna işlendi' : 'Eklendi — kasadan düşüldü');
      setF({ tarih: bugun(), kategori: 'Diğer', tutar: '', aciklama: '', sube: f.sube, odeme_yontemi: 'nakit', kart_id: '' });
      setFormAcik(false);
      yukle();
    } catch (e) { setHata(e.message || 'Kaydedilemedi'); }
    finally { setMesgul(false); }
  };

  const sil = async (g) => {
    const m = g.odeme_yontemi === 'kart' ? 'İptal et? Kart borcundan düşülecek.' : 'İptal et? Kasaya iade edilecek.';
    if (!window.confirm(m)) return;
    setMesgul(true);
    try { await api(`/anlik-gider/${g.id}`, { method: 'DELETE' }); setBilgi('İptal edildi.'); yukle(); }
    catch (e) { setHata(e.message || 'İptal edilemedi'); }
    finally { setMesgul(false); }
  };

  const aktif = (liste || []).filter(g => g.durum === 'aktif' || !g.durum);
  const toplamAy = aktif.reduce((s, g) => s + (Number(g.tutar) || 0), 0);
  const subeChip = ['MERKEZ', ...subeler.map(s => s.ad).filter(Boolean)];

  const inp = { width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '11px 12px', fontSize: 15, color: C.t1, boxSizing: 'border-box' };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="💸 Anlık Gider" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Ay gezinme + toplam */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 8 }}>
          <button onClick={() => setAyOff(a => a + 1)} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: '6px 12px', fontSize: 16, cursor: 'pointer' }}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.t1, minWidth: 130, textAlign: 'center', textTransform: 'capitalize' }}>{ayMetin}</span>
          <button onClick={() => setAyOff(a => Math.max(0, a - 1))} disabled={ayOff === 0} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: ayOff === 0 ? C.t3 : C.t2, padding: '6px 12px', fontSize: 16, cursor: ayOff === 0 ? 'default' : 'pointer' }}>›</button>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: C.t3 }}>Aktif giderler (toplam)</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.kirmizi, marginTop: 2 }}>{fmt(toplamAy)}</div>
        </div>
      </div>

      {bilgi && <div style={{ margin: 14, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div style={{ margin: 14, padding: 10, background: 'rgba(239,68,68,0.12)', borderRadius: 10, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}

      <div style={{ padding: 14 }}>
        {!formAcik && (
          <button onClick={() => { setFormAcik(true); setHata(''); }} style={{
            width: '100%', background: C.kirmizi, color: '#fff', border: 'none', borderRadius: 12,
            padding: '14px 0', fontSize: 16, fontWeight: 800, cursor: 'pointer', marginBottom: 14,
          }}>+ Gider Ekle</button>
        )}

        {formAcik && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 14 }}>
            <input type="number" inputMode="decimal" placeholder="Tutar ₺" value={f.tutar}
              onChange={e => set('tutar', e.target.value)} style={{ ...inp, fontSize: 22, fontWeight: 800, textAlign: 'center', marginBottom: 10 }} />

            <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Kategori</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {GIDER_KATEGORILER.map(k => (
                <button key={k} onClick={() => set('kategori', k)} style={{
                  background: f.kategori === k ? C.mavi : C.bg, color: f.kategori === k ? '#fff' : C.t2,
                  border: `1px solid ${f.kategori === k ? C.mavi : C.border}`, borderRadius: 20, padding: '6px 12px',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>{k}</button>
              ))}
            </div>

            <input placeholder="Açıklama (opsiyonel)" value={f.aciklama}
              onChange={e => set('aciklama', e.target.value)} style={{ ...inp, marginBottom: 12 }} />

            <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Şube / yer</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {subeChip.map(s => (
                <button key={s} onClick={() => set('sube', s)} style={{
                  background: f.sube === s ? C.mavi : C.bg, color: f.sube === s ? '#fff' : C.t2,
                  border: `1px solid ${f.sube === s ? C.mavi : C.border}`, borderRadius: 20, padding: '6px 12px',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>{s}</button>
              ))}
            </div>

            <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Ödeme</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[['nakit', '💵 Nakit (kasadan)'], ['kart', '💳 Kart (borca)']].map(([k, etk]) => (
                <button key={k} onClick={() => set('odeme_yontemi', k)} style={{
                  flex: 1, background: f.odeme_yontemi === k ? C.t1 : C.bg, color: f.odeme_yontemi === k ? C.bg : C.t2,
                  border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}>{etk}</button>
              ))}
            </div>

            {f.odeme_yontemi === 'kart' && (
              <select value={f.kart_id} onChange={e => set('kart_id', e.target.value)} style={{ ...inp, marginBottom: 12 }}>
                <option value="">Kart seçin…</option>
                {kartlar.map(k => <option key={k.id} value={k.id}>{k.ad || k.kart_adi || k.banka || k.id}</option>)}
              </select>
            )}

            <input type="date" value={f.tarih} onChange={e => set('tarih', e.target.value)} style={{ ...inp, marginBottom: 12 }} />

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setFormAcik(false); setHata(''); }} style={{
                flex: 1, background: C.bg, color: C.t2, border: `1px solid ${C.border}`, borderRadius: 10,
                padding: '12px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer',
              }}>Vazgeç</button>
              <button onClick={kaydet} disabled={mesgul} style={{
                flex: 2, background: C.yesil, color: '#fff', border: 'none', borderRadius: 10,
                padding: '12px 0', fontSize: 15, fontWeight: 800, cursor: mesgul ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1,
              }}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>
        )}

        {/* Liste */}
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {liste && aktif.length === 0 && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Bu ay gider yok.</div>}
        {aktif.map(g => (
          <div key={g.id} style={{
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', marginBottom: 10,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: C.t1, fontWeight: 700 }}>{g.aciklama || g.kategori || '—'}</div>
                <div style={{ fontSize: 11, color: C.t3, marginTop: 3 }}>
                  {g.kategori}{g.sube ? ` · ${g.sube}` : ''} · {g.odeme_yontemi === 'kart' ? '💳 kart' : '💵 nakit'}{g.tarih ? ` · ${new Date(g.tarih).toLocaleDateString('tr-TR')}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.kirmizi }}>{fmt(g.tutar)}</div>
                <button onClick={() => sil(g)} disabled={mesgul} style={{
                  background: 'none', border: 'none', color: C.t3, fontSize: 11, textDecoration: 'underline', cursor: 'pointer', marginTop: 2,
                }}>iptal</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Vadeli Alımlar (telefondan ekle / öde / iptal) ──────────────────────────
function CepVadeli({ onGeri }) {
  const bugun = () => new Date().toISOString().split('T')[0];
  const [liste, setListe] = useState(null);
  const [gorunum, setGorunum] = useState('bekliyor'); // bekliyor | odendi
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [kartlar, setKartlar] = useState([]);
  const [tedarikciler, setTedarikciler] = useState([]);
  const [formAcik, setFormAcik] = useState(false);
  const [f, setF] = useState({ tedarikci: '', telefon: '', aciklama: '', tutar: '', vade_tarihi: '' });
  const [odeId, setOdeId] = useState('');        // ödeme paneli açık satır
  const [odeYontem, setOdeYontem] = useState('nakit');
  const [odeKart, setOdeKart] = useState('');

  const yukle = useCallback(() => {
    setHata('');
    api(`/vadeli-alimlar?durum=${gorunum}&gun=30`)
      .then(r => setListe(Array.isArray(r) ? r : (r?.satirlar || [])))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, [gorunum]);
  useEffect(() => { yukle(); }, [yukle]);
  const tedYukle = useCallback(() => { api('/tedarikciler').then(r => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || []))).catch(() => {}); }, []);
  useEffect(() => {
    api('/kartlar').then(r => setKartlar(Array.isArray(r) ? r : [])).catch(() => {});
    tedYukle();
  }, [tedYukle]);

  // Tedarikçi adı yazıldıkça: kayıtlı bir tedarikçiyle birebir eşleşirse telefonu otomatik doldur
  const tedBul = (ad) => tedarikciler.find(t => String(t.ad || '').trim().toLowerCase() === String(ad || '').trim().toLowerCase());
  const set = (k, v) => setF(p => {
    const n = { ...p, [k]: v };
    if (k === 'tedarikci') {
      const t = tedBul(v);
      if (t && t.telefon && !p.telefon) n.telefon = t.telefon;
    }
    return n;
  });

  const _post = async (body) => {
    const res = await api('/vadeli-alimlar', { method: 'POST', body });
    if (res && res.warning && res.kod === 'TEDARIKCI_ACIK_BAKIYE') {
      const rows = res.mevcut_borc || [];
      const birlestir = window.confirm(`${res.mesaj || 'Bu tedarikçinin açık borcu var.'}\n\nMevcut borca EKLENSİN mi?\n(İptal = ayrı borç olarak ekle)`);
      const body2 = birlestir
        ? { ...body, birlestir_vadeli_id: rows[0]?.id }
        : { ...body, tedarikci_karari: 'ayri' };
      return api('/vadeli-alimlar', { method: 'POST', body: body2 });
    }
    if (res && res.warning) {
      if (window.confirm(`${res.mesaj || 'Mükerrer olabilir.'}\n\nYine de eklensin mi?`)) {
        return api('/vadeli-alimlar', { method: 'POST', body: { ...body, force: true } });
      }
      return null;
    }
    return res;
  };

  const kaydet = async () => {
    const tutarN = Number(String(f.tutar).replace(',', '.'));
    if (!f.tedarikci.trim()) { setHata('Tedarikçi girin'); return; }
    if (!tutarN || tutarN <= 0) { setHata('Geçerli tutar girin'); return; }
    if (!f.vade_tarihi) { setHata('Vade tarihi girin'); return; }
    const tedAd = f.tedarikci.trim();
    const tel = f.telefon.trim();
    setMesgul(true); setHata(''); setBilgi('');
    try {
      const res = await _post({ tedarikci: tedAd, aciklama: f.aciklama.trim(), tutar: tutarN, vade_tarihi: f.vade_tarihi });
      if (res) {
        let ekNot = '';
        // Tedarikçi kayıtlı değilse → listeye ekleme öner + otomatik ekle
        const kayitli = tedBul(tedAd);
        if (!kayitli && tedAd.length >= 2) {
          const telMetin = tel ? ` (tel: ${tel})` : '';
          if (window.confirm(`"${tedAd}" tedarikçi listesinde yok.${telMetin}\n\nTedarikçi olarak kaydedilsin mi?`)) {
            try {
              await api('/tedarikciler', { method: 'POST', body: { ad: tedAd, telefon: tel } });
              ekNot = ' · tedarikçi listeye eklendi';
              tedYukle();
            } catch (e2) { ekNot = ' · (tedarikçi eklenemedi: ' + (e2.message || '') + ')'; }
          }
        } else if (kayitli && tel && !String(kayitli.telefon || '').trim()) {
          // Kayıtlı ama telefonu boştu → girilen telefonu güncelle
          if (window.confirm(`"${tedAd}" için telefon kayıtlı değil. ${tel} numarası eklensin mi?`)) {
            try {
              await api(`/tedarikciler/${kayitli.id}`, { method: 'PUT', body: { ad: kayitli.ad, kategori: kayitli.kategori || '', telefon: tel, aciklama: kayitli.aciklama || '' } });
              ekNot = ' · telefon güncellendi';
              tedYukle();
            } catch { /* yut */ }
          }
        }
        setBilgi((res.birlestirildi ? `Birleştirildi — toplam ${fmt(res.yeni_toplam)}` : 'Vadeli alım eklendi.') + ekNot);
        setF({ tedarikci: '', telefon: '', aciklama: '', tutar: '', vade_tarihi: '' });
        setFormAcik(false);
        yukle();
      }
    } catch (e) { setHata(e.message || 'Kaydedilemedi'); }
    finally { setMesgul(false); }
  };

  const odeAc = (v) => { setOdeId(v.id); setOdeYontem('nakit'); setOdeKart(''); setHata(''); };

  const ode = async (v) => {
    if (odeYontem === 'kart' && !odeKart) { setHata('Kart seçin'); return; }
    setMesgul(true); setHata('');
    try {
      await api(`/vadeli-alimlar/${v.id}/ode`, {
        method: 'POST', body: { odeme_yontemi: odeYontem, kart_id: odeYontem === 'kart' ? odeKart : null },
      });
      setBilgi(odeYontem === 'kart' ? 'Ödendi — kart harcamasına eklendi' : 'Ödendi — kasadan düşüldü');
      setOdeId(''); yukle();
    } catch (e) { setHata(e.message || 'Ödenemedi'); }
    finally { setMesgul(false); }
  };

  const sil = async (v) => {
    if (!window.confirm(`${v.aciklama || v.tedarikci || 'Bu vadeli alım'} iptal edilsin mi?`)) return;
    setMesgul(true);
    try { await api(`/vadeli-alimlar/${v.id}`, { method: 'DELETE' }); setBilgi('İptal edildi.'); yukle(); }
    catch (e) { setHata(e.message || 'İptal edilemedi'); }
    finally { setMesgul(false); }
  };

  const toplam = (liste || []).reduce((s, v) => s + (Number(v.tutar) || 0), 0);
  const inp = { width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '11px 12px', fontSize: 15, color: C.t1, boxSizing: 'border-box' };

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="🧾 Vadeli Alımlar" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Sekme + toplam */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {[['bekliyor', 'Bekleyen'], ['odendi', 'Ödenen']].map(([k, etk]) => (
            <button key={k} onClick={() => setGorunum(k)} style={{
              flex: 1, background: gorunum === k ? C.mavi : C.bg2, color: gorunum === k ? '#fff' : C.t2,
              border: `1px solid ${gorunum === k ? C.mavi : C.border}`, borderRadius: 10, padding: '9px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}>{etk}</button>
          ))}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: C.t3 }}>{gorunum === 'bekliyor' ? 'Bekleyen borç (toplam)' : 'Ödenen (toplam)'}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: gorunum === 'bekliyor' ? C.kirmizi : C.yesil, marginTop: 2 }}>{fmt(toplam)}</div>
        </div>
      </div>

      {bilgi && <div style={{ margin: 14, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div style={{ margin: 14, padding: 10, background: 'rgba(239,68,68,0.12)', borderRadius: 10, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}

      <div style={{ padding: 14 }}>
        {gorunum === 'bekliyor' && !formAcik && (
          <button onClick={() => { setFormAcik(true); setHata(''); }} style={{
            width: '100%', background: C.kirmizi, color: '#fff', border: 'none', borderRadius: 12,
            padding: '14px 0', fontSize: 16, fontWeight: 800, cursor: 'pointer', marginBottom: 14,
          }}>+ Vadeli Alım Ekle</button>
        )}

        {formAcik && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 14 }}>
            <input list="cepTedListe" placeholder="Tedarikçi (kayıtlıdan seç veya yaz)" value={f.tedarikci} onChange={e => set('tedarikci', e.target.value)} style={{ ...inp, marginBottom: 8 }} />
            <datalist id="cepTedListe">
              {tedarikciler.map(t => <option key={t.id} value={t.ad}>{t.telefon ? `${t.ad} · ${t.telefon}` : t.ad}</option>)}
            </datalist>
            {(() => { const t = tedBul(f.tedarikci); return f.tedarikci.trim().length >= 2 && (
              <div style={{ fontSize: 11, color: t ? C.yesil : C.sari, marginBottom: 8 }}>
                {t ? '✓ Kayıtlı tedarikçi' : '＋ Yeni — kayıt sonunda listeye eklenebilir'}
              </div>
            ); })()}
            <input type="tel" inputMode="tel" placeholder="Tedarikçi telefonu (opsiyonel)" value={f.telefon} onChange={e => set('telefon', e.target.value)} style={{ ...inp, marginBottom: 10 }} />
            <input placeholder="Açıklama (opsiyonel)" value={f.aciklama} onChange={e => set('aciklama', e.target.value)} style={{ ...inp, marginBottom: 10 }} />
            <input type="number" inputMode="decimal" placeholder="Tutar ₺" value={f.tutar} onChange={e => set('tutar', e.target.value)} style={{ ...inp, fontSize: 20, fontWeight: 800, textAlign: 'center', marginBottom: 10 }} />
            <div style={{ fontSize: 12, color: C.t3, marginBottom: 4 }}>Vade tarihi</div>
            <input type="date" value={f.vade_tarihi} onChange={e => set('vade_tarihi', e.target.value)} style={{ ...inp, marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setFormAcik(false); setHata(''); }} style={{ flex: 1, background: C.bg, color: C.t2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 0', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Vazgeç</button>
              <button onClick={kaydet} disabled={mesgul} style={{ flex: 2, background: C.yesil, color: '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontSize: 15, fontWeight: 800, cursor: mesgul ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1 }}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
            </div>
          </div>
        )}

        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {liste && liste.length === 0 && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>{gorunum === 'bekliyor' ? 'Bekleyen vadeli alım yok.' : 'Ödenen kayıt yok.'}</div>}
        {(liste || []).map(v => {
          const gecikti = gorunum === 'bekliyor' && v.vade_tarihi && v.vade_tarihi < bugun();
          const bar = gecikti ? C.kirmizi : (gorunum === 'odendi' ? C.yesil : C.sari);
          return (
            <div key={v.id} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${bar}`, borderRadius: 14, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.t1 }}>{v.tedarikci || v.aciklama || '—'}</div>
                  {v.tedarikci && v.aciklama && <div style={{ fontSize: 12, color: C.t2, marginTop: 2 }}>{v.aciklama}</div>}
                  <div style={{ fontSize: 11, color: gecikti ? C.kirmizi : C.t3, fontWeight: gecikti ? 700 : 400, marginTop: 3 }}>
                    {v.vade_tarihi ? `vade: ${new Date(v.vade_tarihi).toLocaleDateString('tr-TR')}` : ''}{gecikti ? ' · gecikmiş!' : ''}
                  </div>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: bar, whiteSpace: 'nowrap' }}>{fmt(v.tutar)}</div>
              </div>

              {gorunum === 'bekliyor' && odeId !== v.id && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={() => odeAc(v)} disabled={mesgul} style={{ flex: 2, background: C.yesil, color: '#fff', border: 'none', borderRadius: 10, padding: '10px 0', fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>✓ Ödendi</button>
                  <button onClick={() => sil(v)} disabled={mesgul} style={{ flex: 1, background: C.bg, color: C.t3, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>İptal</button>
                </div>
              )}

              {gorunum === 'bekliyor' && odeId === v.id && (
                <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    {[['nakit', '💵 Nakit'], ['kart', '💳 Kart']].map(([k, etk]) => (
                      <button key={k} onClick={() => setOdeYontem(k)} style={{ flex: 1, background: odeYontem === k ? C.t1 : C.bg, color: odeYontem === k ? C.bg : C.t2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{etk}</button>
                    ))}
                  </div>
                  {odeYontem === 'kart' && (
                    <select value={odeKart} onChange={e => setOdeKart(e.target.value)} style={{ ...inp, marginBottom: 8 }}>
                      <option value="">Kart seçin…</option>
                      {kartlar.map(k => <option key={k.id} value={k.id}>{k.ad || k.kart_adi || k.banka || k.id}</option>)}
                    </select>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setOdeId('')} style={{ flex: 1, background: C.bg, color: C.t2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Vazgeç</button>
                    <button onClick={() => ode(v)} disabled={mesgul} style={{ flex: 2, background: C.yesil, color: '#fff', border: 'none', borderRadius: 10, padding: '10px 0', fontSize: 14, fontWeight: 800, cursor: mesgul ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1 }}>{mesgul ? '…' : `${fmt(v.tutar)} Öde`}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stok Sayım (sahip: ata / bekleyen onay / aktif görevler) ────────────────
function CepStokSayim({ onGeri }) {
  const [alt, setAlt] = useState('onay'); // onay | ata | aktif

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="📋 Stok Sayım" onGeri={onGeri} />
      <div style={{ display: 'flex', gap: 6, padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        {[['onay', 'Onay Bekleyen'], ['ata', 'Görev Ata'], ['aktif', 'Aktif']].map(([k, etk]) => (
          <button key={k} onClick={() => setAlt(k)} style={{
            flex: 1, background: alt === k ? C.mavi : C.bg2, color: alt === k ? '#fff' : C.t2,
            border: `1px solid ${alt === k ? C.mavi : C.border}`, borderRadius: 10, padding: '9px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}>{etk}</button>
        ))}
      </div>
      {alt === 'onay' && <CepSayimOnay />}
      {alt === 'ata' && <CepSayimAta />}
      {alt === 'aktif' && <CepSayimAktif />}
    </div>
  );
}

function CepSayimOnay() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [acik, setAcik] = useState(null);   // detay görev
  const [satirlar, setSatirlar] = useState([]);
  const [kararlar, setKararlar] = useState({}); // kalem_kodu -> 'sayim'|'sistem'
  const [mesgul, setMesgul] = useState(false);

  const yukle = useCallback(() => {
    api('/stok-sayim/bekleyen-onay').then(r => setListe(r?.gorevler || [])).catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const detayAc = async (g) => {
    setHata(''); setBilgi('');
    try {
      const d = await api(`/stok-sayim/gorev/${g.id}`);
      setAcik(d); setSatirlar(d.satirlar || []);
      setKararlar(Object.fromEntries((d.satirlar || []).filter(s => s.fark !== 0).map(s => [s.kalem_kodu, 'sayim'])));
    } catch (e) { setHata(e.message || 'Açılamadı'); }
  };

  const onayla = async () => {
    setMesgul(true); setHata('');
    try {
      const kararList = Object.entries(kararlar).map(([kalem_kodu, karar]) => ({ kalem_kodu, karar }));
      await api(`/stok-sayim/gorev/${acik.id}/onayla`, { method: 'POST', body: { kararlar: kararList, karar_veren_ad: 'Patron (Cep)' } });
      setBilgi('Onaylandı — stok güncellendi.'); setAcik(null); yukle();
    } catch (e) { setHata(e.message || 'Onaylanamadı'); }
    finally { setMesgul(false); }
  };

  if (acik) {
    const farklar = satirlar.filter(s => s.fark !== 0);
    const kalibrasyon = acik.mod === 'kalibrasyon';
    return (
      <div style={{ padding: 14 }}>
        <button onClick={() => setAcik(null)} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>‹ Listeye dön</button>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{acik.sube_adi} · {acik.personel_ad}</div>
        <div style={{ fontSize: 12, color: C.t3, marginBottom: 12 }}>{kalibrasyon ? '🎯 Kalibrasyon (ilk sayım)' : '🔁 Kontrol'} · {farklar.length} farklı kalem</div>
        {hata && <div style={{ margin: '6px 0', padding: 8, background: 'rgba(239,68,68,0.12)', borderRadius: 8, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}
        {farklar.length === 0 && <div style={{ color: C.yesil, padding: 16, textAlign: 'center' }}>✅ Fark yok — sayım sistemle uyumlu.</div>}
        {farklar.map(s => (
          <div key={s.kalem_kodu} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.t1, flex: 1, minWidth: 0 }}>{s.kalem_adi}</div>
              <div style={{ fontSize: 12, color: C.t3, whiteSpace: 'nowrap' }}>sistem {s.sistem_adet} → sayım <b style={{ color: C.t1 }}>{s.sayilan_adet}</b> <span style={{ color: s.fark > 0 ? C.yesil : C.kirmizi }}>({s.fark > 0 ? '+' : ''}{s.fark})</span></div>
            </div>
            {!kalibrasyon && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {[['sayim', `Sayımı al (${s.sayilan_adet})`], ['sistem', `Sistemi koru (${s.sistem_adet})`]].map(([k, etk]) => (
                  <button key={k} onClick={() => setKararlar(p => ({ ...p, [s.kalem_kodu]: k }))} style={{
                    flex: 1, background: (kararlar[s.kalem_kodu] || 'sayim') === k ? C.mavi : C.bg, color: (kararlar[s.kalem_kodu] || 'sayim') === k ? '#fff' : C.t2,
                    border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>{etk}</button>
                ))}
              </div>
            )}
          </div>
        ))}
        <button onClick={onayla} disabled={mesgul} style={{ width: '100%', marginTop: 12, background: C.yesil, color: '#fff', border: 'none', borderRadius: 12, padding: '14px 0', fontSize: 16, fontWeight: 800, cursor: mesgul ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1 }}>{mesgul ? 'Onaylanıyor…' : '✅ Onayla & Stoğu Güncelle'}</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 14 }}>
      {bilgi && <div style={{ marginBottom: 10, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div style={{ marginBottom: 10, padding: 10, background: 'rgba(239,68,68,0.12)', borderRadius: 10, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}
      {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
      {liste && liste.length === 0 && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Onay bekleyen sayım yok.</div>}
      {(liste || []).map(g => (
        <div key={g.id} onClick={() => detayAc(g)} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${g.fark_sayisi > 0 ? C.sari : C.yesil}`, borderRadius: 14, padding: '12px 14px', marginBottom: 10, cursor: 'pointer' }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{g.sube_adi} · {g.personel_ad}</div>
          <div style={{ fontSize: 12, color: C.t2, marginTop: 3 }}>{g.mod === 'kalibrasyon' ? '🎯 Kalibrasyon' : '🔁 Kontrol'} · {g.kalem_sayisi} kalem</div>
          <div style={{ fontSize: 12, color: g.fark_sayisi > 0 ? C.sari : C.yesil, fontWeight: 700, marginTop: 3 }}>{g.fark_sayisi > 0 ? `${g.fark_sayisi} farklı kalem — incele` : 'fark yok'}</div>
        </div>
      ))}
    </div>
  );
}

function CepSayimAta() {
  const [subeler, setSubeler] = useState([]);
  const [personeller, setPersoneller] = useState([]);
  const [subeId, setSubeId] = useState('');
  const [personelId, setPersonelId] = useState('');
  const [kapsam, setKapsam] = useState('tam');
  const [not, setNot] = useState('');
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState(false);

  useEffect(() => { api('/subeler').then(r => setSubeler((r || []).filter(x => x.aktif !== false && !x.sezon_kapali))).catch(() => {}); }, []);
  useEffect(() => {
    setPersonelId('');
    if (!subeId) { setPersoneller([]); return; }
    api(`/gorev/sube-personel/${encodeURIComponent(subeId)}`).then(r => setPersoneller(r || [])).catch(() => setPersoneller([]));
  }, [subeId]);

  const ata = async () => {
    if (!subeId || !personelId) { setHata('Şube ve personel seçin'); return; }
    setMesgul(true); setHata(''); setBilgi('');
    try {
      const r = await api('/stok-sayim/gorev-ata', { method: 'POST', body: { sube_id: subeId, personel_id: personelId, kapsam_tip: kapsam, not_aciklama: not.trim() || null, atayan_ad: 'Patron (Cep)' } });
      // Personelin telefonu tanımlıysa → wa.me ile haber ver (senin telefonundan)
      const p = personeller.find(x => String(x.id) === String(personelId));
      const num = cepWaNum(p?.telefon);
      const subeAd = subeler.find(x => x.id === subeId)?.ad || '';
      if (num) {
        const msg = `Merhaba ${p?.ad_soyad || ''} 👋\n*${subeAd}* için sana stok sayım görevi atandı 📋\nMesai başlat, QR okut ve ürünleri say. Teşekkürler 🙏`;
        window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank');
        setBilgi(`✅ Atandı — ${r.personel_ad || ''} · ${r.kalem_sayisi} kalem. WhatsApp açıldı, gönder.`);
      } else {
        setBilgi(`✅ Atandı — ${r.personel_ad || ''} · ${r.kalem_sayisi} kalem · ${r.mod === 'kalibrasyon' ? 'Kalibrasyon' : 'Kontrol'}. ${p && !p.telefon ? '(Bu personelin telefonu kayıtlı değil — WhatsApp gidemedi)' : 'Personel mesai başlatınca ekran kilitlenir.'}`);
      }
      setPersonelId(''); setNot('');
    } catch (e) { setHata(e.message || 'Atanamadı'); }
    finally { setMesgul(false); }
  };

  const inp = { width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '11px 12px', fontSize: 15, color: C.t1, boxSizing: 'border-box' };

  return (
    <div style={{ padding: 14 }}>
      {bilgi && <div style={{ marginBottom: 12, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13, lineHeight: 1.5 }}>{bilgi}</div>}
      {hata && <div style={{ marginBottom: 12, padding: 10, background: 'rgba(239,68,68,0.12)', borderRadius: 10, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}

      <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Şube</div>
      <select value={subeId} onChange={e => setSubeId(e.target.value)} style={{ ...inp, marginBottom: 12 }}>
        <option value="">Şube seçin…</option>
        {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
      </select>

      <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Personel</div>
      <select value={personelId} onChange={e => setPersonelId(e.target.value)} disabled={!subeId} style={{ ...inp, marginBottom: 12, opacity: subeId ? 1 : 0.5 }}>
        <option value="">{subeId ? 'Personel seçin…' : 'Önce şube seçin'}</option>
        {personeller.map(p => <option key={p.id} value={p.id}>{p.ad_soyad}{p.bu_sube ? '' : ` (${p.sube_adi})`}{p.pin_tanimli ? '' : ' · PIN yok'}</option>)}
      </select>

      <div style={{ fontSize: 12, color: C.t3, marginBottom: 5 }}>Kapsam</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[['tam', 'Tam sayım'], ['set', 'Kritik set']].map(([k, etk]) => (
          <button key={k} onClick={() => setKapsam(k)} style={{ flex: 1, background: kapsam === k ? C.mavi : C.bg, color: kapsam === k ? '#fff' : C.t2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{etk}</button>
        ))}
      </div>
      {kapsam === 'set' && <div style={{ fontSize: 11, color: C.t3, marginBottom: 12 }}>Not: kritik set kalemlerini şimdilik masaüstünden seçebilirsin; cepte tam sayım önerilir.</div>}

      <input placeholder="Not (opsiyonel)" value={not} onChange={e => setNot(e.target.value)} style={{ ...inp, marginBottom: 14 }} />

      <button onClick={ata} disabled={mesgul || kapsam === 'set'} style={{ width: '100%', background: kapsam === 'set' ? C.bg2 : C.yesil, color: kapsam === 'set' ? C.t3 : '#fff', border: 'none', borderRadius: 12, padding: '14px 0', fontSize: 16, fontWeight: 800, cursor: (mesgul || kapsam === 'set') ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1 }}>
        {mesgul ? 'Atanıyor…' : (kapsam === 'set' ? 'Kritik set masaüstünden' : '📋 Sayım Görevi Ata')}
      </button>
    </div>
  );
}

function CepSayimAktif() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState(false);

  const yukle = useCallback(() => {
    api('/stok-sayim/gorevler?limit=100').then(r => setListe(r?.gorevler || [])).catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const kilitAc = async (g) => {
    if (!window.confirm(`${g.personel_ad || 'Personel'} (${g.sube_adi}) sayım görevini iptal et ve kilidi aç?`)) return;
    setMesgul(true); setHata('');
    try { await api(`/stok-sayim/gorev/${g.id}/kilit-ac`, { method: 'POST', body: { neden: 'sahip uzaktan açtı (cep)' } }); setBilgi('Kilit açıldı.'); yukle(); }
    catch (e) { setHata(e.message || 'Açılamadı'); }
    finally { setMesgul(false); }
  };

  const DURUM = { atandi: ['atandı', C.sari], basladi: ['sayımda', C.mavi], tamamlandi: ['onay bekliyor', '#f59e0b'], onaylandi: ['onaylandı', C.yesil] };
  const aktifler = (liste || []).filter(g => ['atandi', 'basladi', 'tamamlandi'].includes(g.durum));

  return (
    <div style={{ padding: 14 }}>
      {bilgi && <div style={{ marginBottom: 10, padding: 10, background: 'rgba(34,197,94,0.12)', borderRadius: 10, color: C.yesil, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div style={{ marginBottom: 10, padding: 10, background: 'rgba(239,68,68,0.12)', borderRadius: 10, color: C.kirmizi, fontSize: 13 }}>{hata}</div>}
      {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
      {liste && aktifler.length === 0 && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Aktif sayım görevi yok.</div>}
      {aktifler.map(g => {
        const [et, renk] = DURUM[g.durum] || [g.durum, C.t3];
        return (
          <div key={g.id} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `4px solid ${renk}`, borderRadius: 14, padding: '12px 14px', marginBottom: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{g.sube_adi} · {g.personel_ad}</div>
            <div style={{ fontSize: 12, color: renk, fontWeight: 700, marginTop: 3 }}>{et}{g.mod ? ` · ${g.mod === 'kalibrasyon' ? 'Kalibrasyon' : 'Kontrol'}` : ''}</div>
            {(g.durum === 'atandi' || g.durum === 'basladi') && (
              <button onClick={() => kilitAc(g)} disabled={mesgul} style={{ marginTop: 10, width: '100%', background: C.bg, color: C.kirmizi, border: `1px solid ${C.border}`, borderRadius: 10, padding: '9px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🔓 İptal et & kilidi aç</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Vardiya Takip (salt-okur — aylık mesai/gecikme/part-tam) ────────────────
function CepVardiyaTakip({ onGeri }) {
  const [veri, setVeri] = useState(null);
  const [vardiyaDisi, setVardiyaDisi] = useState([]);
  const [izinMap, setIzinMap] = useState({}); // personel_id -> izin[]
  const [hata, setHata] = useState('');
  const [ayOff, setAyOff] = useState(0);
  const [filtre, setFiltre] = useState('aktif'); // aktif | ayrildi | hepsi
  const [secili, setSecili] = useState(null);    // detay modalı
  const bugunStr = new Date().toISOString().slice(0, 10);
  const izinliBugun = (p) => (izinMap[p.personel_id] || []).some(i =>
    String(i.baslangic_tarih).slice(0, 10) <= bugunStr && bugunStr <= String(i.bitis_tarih).slice(0, 10));

  const d = (() => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() - ayOff); return t; })();
  const yil = d.getFullYear();
  const ay = d.getMonth() + 1;
  const ayMetin = d.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

  const yukle = useCallback(() => {
    setHata('');
    const bugunTarih = new Date().toISOString().slice(0, 10);
    const ayBas = `${yil}-${String(ay).padStart(2, '0')}-01`;
    const ayBitis = new Date(yil, ay, 0).toISOString().slice(0, 10); // ayın son günü
    Promise.all([
      api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}`),
      api(`/gorev/yoklama?tarih=${bugunTarih}&sadece_vardiya_disi=true`).catch(() => []),
      api(`/vardiya/v2/izin?baslangic=${ayBas}&bitis=${ayBitis}`).catch(() => ({ izinler: [] })),
    ]).then(([v, vd, iz]) => {
      setVeri(v || { personeller: [] });
      setVardiyaDisi(Array.isArray(vd) ? vd : []);
      const m = {};
      for (const i of (iz?.izinler || [])) { (m[i.personel_id] = m[i.personel_id] || []).push(i); }
      setIzinMap(m);
    }).catch(e => { setHata(e.message || 'Yüklenemedi'); setVeri({ personeller: [] }); });
  }, [yil, ay]);
  useEffect(() => { yukle(); }, [yukle]);

  const hs = (n) => (Math.round((Number(n) || 0) * 10) / 10) + 's';
  const personeller = veri?.personeller || [];
  const liste = personeller.filter(p => filtre === 'hepsi' ? true : filtre === 'ayrildi' ? !p.aktif : p.aktif !== false);
  const ozetFazla = personeller.reduce((s, p) => s + (Number(p.toplam_fazla_mesai_saat) || 0), 0);
  const ozetPartTam = personeller.filter(p => p.part_tam_gun > 0).length;

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      <Baslik baslik="👥 Vardiya Takip" onGeri={onGeri}
        sag={<button onClick={yukle} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>} />
      {/* Ay gezinme */}
      <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          <button onClick={() => setAyOff(a => a + 1)} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.t2, padding: '6px 12px', fontSize: 16, cursor: 'pointer' }}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.t1, minWidth: 130, textAlign: 'center', textTransform: 'capitalize' }}>{ayMetin}</span>
          <button onClick={() => setAyOff(a => Math.max(0, a - 1))} disabled={ayOff === 0} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, color: ayOff === 0 ? C.t3 : C.t2, padding: '6px 12px', fontSize: 16, cursor: ayOff === 0 ? 'default' : 'pointer' }}>›</button>
        </div>
      </div>

      {/* Özet */}
      {personeller.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '12px 14px 0' }}>
          {[[`${personeller.length}`, 'Personel', C.t1], [hs(ozetFazla), 'Fazla mesai', '#f59e0b'], [`${ozetPartTam}`, 'Part-tam', '#f59e0b']].map(([v, l, renk]) => (
            <div key={l} style={{ flex: 1, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: renk }}>{v}</div>
              <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{l}</div>
            </div>
          ))}
        </div>
      )}

      {/* Bugün vardiya dışı girişler */}
      {vardiyaDisi.length > 0 && (
        <div style={{ margin: '12px 14px 0', border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.06)', borderRadius: 12, padding: '10px 12px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>🔀 Bugün vardiya dışı giriş ({vardiyaDisi.length})</div>
          {vardiyaDisi.map((g, i) => (
            <div key={i} style={{ fontSize: 12, color: C.t2, padding: '3px 0' }}>
              <b style={{ color: C.t1 }}>{g.ad_soyad}</b> · {g.asil_sube_adi || '—'} → <span style={{ color: '#f59e0b' }}>{g.sube_adi}</span>
            </div>
          ))}
        </div>
      )}

      {/* Filtre */}
      <div style={{ display: 'flex', gap: 6, padding: '12px 14px 0' }}>
        {[['aktif', 'Aktif'], ['ayrildi', 'Ayrıldı'], ['hepsi', 'Tümü']].map(([k, l]) => (
          <button key={k} onClick={() => setFiltre(k)} style={{ flex: 1, background: filtre === k ? C.mavi : C.bg2, color: filtre === k ? '#fff' : C.t2, border: `1px solid ${filtre === k ? C.mavi : C.border}`, borderRadius: 8, padding: '7px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>{l}</button>
        ))}
      </div>

      <div style={{ padding: 14 }}>
        {veri === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 16 }}>{hata}</div>}
        {veri && liste.length === 0 && !hata && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Bu ay için kayıt yok.</div>}
        {liste.map(p => {
          const ayrildi = !p.aktif;
          const izinli = izinliBugun(p);
          return (
            <div key={p.personel_id} onClick={() => setSecili(p)} style={{ background: C.bg2, border: `1px solid ${izinli ? 'rgba(34,197,94,0.4)' : C.border}`, borderLeft: izinli ? `4px solid ${C.yesil}` : `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', marginBottom: 10, opacity: ayrildi ? 0.7 : 1, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>
                  {p.ad_soyad}
                  {izinli && <span style={{ fontSize: 11, fontWeight: 700, color: C.yesil, background: 'rgba(34,197,94,0.14)', borderRadius: 6, padding: '2px 7px', marginLeft: 6 }}>🌴 Bugün izinli</span>}
                  <span style={{ fontSize: 10, color: C.t3, fontWeight: 400, marginLeft: 6 }}>{p.calisma_turu === 'surekli' ? 'Sürekli' : 'Part-time'}</span>
                  {ayrildi && <span style={{ fontSize: 10, color: C.t3, marginLeft: 6 }}>· ayrıldı</span>}
                </div>
                {p['net_hakediş'] != null && <div style={{ fontSize: 14, fontWeight: 800, color: C.yesil, whiteSpace: 'nowrap' }}>{fmt(Math.round(p['net_hakediş']))}</div>}
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 12 }}>
                <span style={{ color: C.t3 }}>Plan <b style={{ color: C.t1 }}>{hs(p.toplam_planlanan_saat)}</b></span>
                <span style={{ color: C.t3 }}>Fazla <b style={{ color: p.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : C.t1 }}>{hs(p.toplam_fazla_mesai_saat)}</b></span>
                <span style={{ color: C.t3 }}>Gecikme <b style={{ color: p.toplam_gecikme_dk > 0 ? C.kirmizi : C.t1 }}>{p.toplam_gecikme_dk || 0} dk</b></span>
                <span style={{ color: C.t3 }}>Yemek <b style={{ color: C.yesil }}>{p.yemek_ucret_gun || 0}g</b></span>
              </div>
              {(p.part_tam_gun > 0 || p.haftalik_izin_kullanilmadi > 0) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {p.part_tam_gun > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.12)', borderRadius: 6, padding: '2px 8px' }}>{p.part_tam_gun}g part-tam</span>}
                  {p.haftalik_izin_kullanilmadi > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: C.kirmizi, background: 'rgba(239,68,68,0.12)', borderRadius: 6, padding: '2px 8px' }}>{p.haftalik_izin_kullanilmadi} hafta izinsiz</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {secili && <CepVardiyaModal p={secili} izinler={izinMap[secili.personel_id] || []} onKapat={() => setSecili(null)} />}
    </div>
  );
}

function CepVardiyaModal({ p, izinler = [], onKapat }) {
  const hs = (n) => (Math.round((Number(n) || 0) * 10) / 10) + 's';
  const gunler = (p.gunler || []).filter(g => g.planlanan_saat > 0);
  const son7 = [...gunler].sort((a, b) => String(b.tarih).localeCompare(String(a.tarih))).slice(0, 7);
  const haft = p.haftalik_izin_detay || [];
  const trGun = (t) => new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' });
  const izinAralik = (iz) => {
    const b = String(iz.baslangic_tarih).slice(0, 10), s = String(iz.bitis_tarih).slice(0, 10);
    return b === s ? trGun(b) : `${trGun(b)} → ${trGun(s)}`;
  };

  const Sat = ({ l, v, renk }) => (
    <div style={{ textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: renk || C.t1 }}>{v}</div>
      <div style={{ fontSize: 10, color: C.t3, marginTop: 2 }}>{l}</div>
    </div>
  );

  return (
    <div onClick={onKapat} style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 9999, display: 'flex', flexDirection: 'column' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.bg2, width: '100%', maxWidth: 520, margin: '0 auto', height: '100%', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {/* Başlık */}
        <div style={{ position: 'sticky', top: 0, background: C.bg2, borderBottom: `1px solid ${C.border}`, padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.t1 }}>{p.ad_soyad}</div>
            <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{p.calisma_turu === 'surekli' ? 'Sürekli' : 'Part-time'}{p.aktif === false ? ' · ayrıldı' : ''}</div>
          </div>
          <button onClick={onKapat} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.t2, width: 34, height: 34, borderRadius: 9, fontSize: 16, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ padding: 16 }}>
          {/* Özet metrikler */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <Sat l="Plan" v={hs(p.toplam_planlanan_saat)} />
            <Sat l="Fazla" v={hs(p.toplam_fazla_mesai_saat)} renk={p.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : C.t1} />
            <Sat l="Gecikme" v={`${p.toplam_gecikme_dk || 0}dk`} renk={p.toplam_gecikme_dk > 0 ? C.kirmizi : C.t1} />
            <Sat l="Yemek" v={`${p.yemek_ucret_gun || 0}g`} renk={C.yesil} />
            <Sat l="Net" v={p['net_hakediş'] > 0 ? fmt(Math.round(p['net_hakediş'])) : '—'} renk={C.yesil} />
          </div>

          {/* İzinler */}
          <div style={{ fontSize: 12, fontWeight: 800, color: C.t2, marginBottom: 6 }}>🌴 İzin / Devamsızlık</div>
          {izinler.length === 0 ? (
            <div style={{ fontSize: 12, color: C.t3, marginBottom: 14 }}>Bu ay kayıtlı izin/devamsızlık yok.</div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              {izinler.map((iz, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 10px', background: C.bg, borderRadius: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: C.t1, fontWeight: 600 }}>{izinAralik(iz)}</span>
                  <span style={{ fontSize: 11, color: C.t3, textAlign: 'right', flex: 1 }}>{iz.tip || ''}{iz.gun_kesri && Number(iz.gun_kesri) !== 1 ? ` · ${iz.gun_kesri}g` : ''}{iz.aciklama ? ` · ${iz.aciklama}` : ''}</span>
                </div>
              ))}
            </div>
          )}

          {/* Haftalık izin durumu */}
          {haft.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.t2, marginBottom: 6 }}>📅 Haftalık izin</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {haft.map((h, i) => (
                  <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 7, color: h.izin_var ? C.yesil : C.kirmizi, background: h.izin_var ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${h.izin_var ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                    {new Date(h.hafta).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} {h.izin_var ? '✓' : '✗ izinsiz'}
                  </span>
                ))}
              </div>
            </>
          )}

          {/* Son 7 gün */}
          <div style={{ fontSize: 12, fontWeight: 800, color: C.t2, marginBottom: 6 }}>🗓️ Son çalışılan günler</div>
          {son7.length === 0 ? (
            <div style={{ fontSize: 12, color: C.t3 }}>Kayıt yok.</div>
          ) : son7.map((g, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', background: C.bg, borderRadius: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: C.t1, fontWeight: 600 }}>{trGun(g.tarih)}</span>
              <span style={{ fontSize: 11, color: C.t3, display: 'flex', gap: 10 }}>
                <span>{hs(g.planlanan_saat)}</span>
                {g.gecikme_dk > 0 && <span style={{ color: C.kirmizi }}>⏰ {g.gecikme_dk}dk</span>}
                {g.fazla_mesai_saat > 0 && <span style={{ color: '#f59e0b' }}>+{hs(g.fazla_mesai_saat)}</span>}
                {g.yemek_sure_dk != null && <span style={{ color: g.yemek_ucret_hakki ? C.yesil : C.kirmizi }}>🍽️{g.yemek_ucret_hakki ? '✓' : '✗'}</span>}
                {!g.giris_var && !g.baslangic_gunu && <span style={{ color: C.kirmizi }}>giriş yok</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
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
          // GERÇEK kasa farkı sadece kapanış denklemi TAM olduğunda sayılır. Gün sürerken
          // (kısmi) nakit_kasa_fark = "şu an kasada olması gereken" → fark değil, alarm verme.
          const kasaDenklemTam = !!s.nakit_denkleme_tam;
          const gercekKasaFark = kasaDenklemTam && fark != null && Math.abs(Number(fark)) > 1;
          const serit = (girmeyenler.length || akFarkVar || gercekKasaFark) ? C.kirmizi
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
                  <div style={{ fontSize: 11, color: C.t3 }}>{kasaDenklemTam ? 'Kasa farkı' : 'Kasada olması gereken'}</div>
                  {!kasaDenklemTam ? (
                    <div style={{ fontSize: 15, fontWeight: 800, color: C.t2 }}>
                      {fark == null ? '—' : fmt(fark)}
                      <span style={{ fontSize: 10, color: C.t3, fontWeight: 600, marginLeft: 4 }}>⏳ gün sürüyor</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 15, fontWeight: 800, color: fark == null ? C.t3 : (Math.abs(Number(fark)) <= 1 ? C.yesil : (Number(fark) > 0 ? C.kirmizi : C.sari)) }}>
                      {fark == null ? '—' : (Number(fark) > 0 ? `${fmt(fark)} açık` : Number(fark) < 0 ? `${fmt(Math.abs(Number(fark)))} fazla` : '0 ✓')}
                    </div>
                  )}
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

// Sipariş adet kontrolü (−/sayı/+) — depo satırında sipariş modunda
function SipAdet({ k, secim, secAdet, secSet }) {
  const adet = secim[k.kalem_kodu]?.adet || 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button onClick={() => secAdet(k, -1)} style={{ width: 30, height: 30, borderRadius: 7, border: `1px solid ${C.border}`, background: C.bg3, color: C.t1, fontSize: 18, fontWeight: 800, cursor: 'pointer' }}>−</button>
      <input value={adet || ''} onChange={e => secSet(k, e.target.value)} placeholder="0" inputMode="numeric" style={{
        width: 42, textAlign: 'center', padding: '5px 0', borderRadius: 7, border: `1px solid ${adet > 0 ? '#25D366' : C.border}`,
        background: C.bg, color: adet > 0 ? '#25D366' : C.t3, fontSize: 15, fontWeight: 800,
      }} />
      <button onClick={() => secAdet(k, +1)} style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: '#25D366', color: '#fff', fontSize: 18, fontWeight: 800, cursor: 'pointer' }}>+</button>
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
  // Sipariş modu (wa.me — senin telefonundan)
  const [sipMod, setSipMod] = useState(false);
  const [tedarikciler, setTedarikciler] = useState([]);
  const [tedId, setTedId] = useState('');
  const [sipSube, setSipSube] = useState(''); // teslimat şubesi
  const [secim, setSecim] = useState({}); // kalem_kodu -> { ad, adet }
  const [sipNot, setSipNot] = useState('');
  const [sadeceSecili, setSadeceSecili] = useState(false);
  // Tik: yoksa ekle (adet 1), varsa çıkar
  const secTik = (k) => setSecim(m => {
    const n = { ...m };
    if (n[k.kalem_kodu]) delete n[k.kalem_kodu];
    else n[k.kalem_kodu] = { ad: k.kalem_adi, adet: 1 };
    return n;
  });
  useEffect(() => { api('/tedarikciler').then(r => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || []))).catch(() => {}); }, []);

  const secAdet = (k, delta) => setSecim(m => {
    const cur = m[k.kalem_kodu]?.adet || 0;
    const yeni = Math.max(0, cur + delta);
    const n = { ...m };
    if (yeni === 0) delete n[k.kalem_kodu];
    else n[k.kalem_kodu] = { ad: k.kalem_adi, adet: yeni };
    return n;
  });
  const secSet = (k, val) => setSecim(m => {
    const yeni = Math.max(0, parseInt(val, 10) || 0);
    const n = { ...m };
    if (yeni === 0) delete n[k.kalem_kodu];
    else n[k.kalem_kodu] = { ad: k.kalem_adi, adet: yeni };
    return n;
  });
  const secimList = Object.values(secim);

  const waGonder = async () => {
    const ted = tedarikciler.find(t => String(t.id) === String(tedId));
    if (!ted) { setHata('Toptancı seçin'); return; }
    const subeId = sipSube || (aktif !== 'tumu' ? aktif : '');
    const subeAd = (data?.subeler || []).find(s => s.id === subeId)?.ad;
    if (!subeAd) { setHata('Teslimat şubesi seçin'); return; }
    if (!secimList.length) { setHata('En az bir ürün seçin'); return; }
    const tel = String(ted.telefon || '').replace(/\D/g, '');
    let num = tel;
    if (num.startsWith('00')) num = num.slice(2);
    if (num.length === 11 && num.startsWith('0')) num = '90' + num.slice(1);
    else if (num.length === 10 && num.startsWith('5')) num = '90' + num;
    if (num.length < 11) { setHata(`${ted.ad} için geçerli telefon yok`); return; }
    // 1) MERKEZ SİPARİŞ kaydı — şube takip/kabul/stok için (kalem_kodu = kanonik UUID)
    const kalemler = Object.entries(secim).map(([kk, v]) => ({ urun_ad: v.ad, adet: v.adet, kalem_kodu: kk }));
    try {
      await api('/ops/siparis/merkez-siparis-olustur', {
        method: 'POST',
        body: { sube_id: subeId, tedarikci_id: ted.id, kalemler, not_aciklama: sipNot.trim() || null },
      });
    } catch (e) { setHata('Merkez kaydı: ' + (e.message || '') + ' (WhatsApp yine de açılıyor)'); }
    // 2) wa.me — hazır mesaj senin telefonundan
    const satirlar = secimList.map(x => `• ${x.adet} adet ${x.ad}`).join('\n');
    const bugun = new Date().toLocaleDateString('tr-TR');
    const mesaj =
      `Merhaba ${ted.ad},\n` +
      `*${subeAd}* şubemiz için sipariş 🛒 (${bugun})\n\n` +
      `${satirlar}` +
      `${sipNot.trim() ? `\n\n📝 Not: ${sipNot.trim()}` : ''}\n\n` +
      `Teşekkürler. 🙏`;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(mesaj)}`, '_blank');
    // 3) temizle (sipariş oluştu)
    setSecim({}); setSipNot(''); setSadeceSecili(false);
  };

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
  // "yok" sayımı satış şubeleri üzerinden (merkez = kaynak depo, şube değil)
  const satisSubeler = subeler.filter(s => s.id !== 'sube-merkez');
  const kisa = (ad) => (ad || '').slice(0, 3).toUpperCase();
  const q = ara.trim().toLocaleLowerCase('tr');
  let kalemler = (data?.kalemler || []).filter(k => !q || (k.kalem_adi || '').toLocaleLowerCase('tr').includes(q));
  // Tek şube modunda: sadece o depoda kaydı olan kalemler
  if (aktif !== 'tumu') kalemler = kalemler.filter(k => k.adetler && k.adetler[aktif] != null);
  // Sipariş modunda "sadece seçilenler": tiklenenler kalsın, diğerleri kaybolsun
  if (sipMod && sadeceSecili) kalemler = kalemler.filter(k => secim[k.kalem_kodu]);

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
        {/* Sipariş Oluştur toggle */}
        <button onClick={() => { setSipMod(v => !v); setHata(''); }} style={{
          width: '100%', padding: '10px', borderRadius: 10, marginBottom: 8, cursor: 'pointer',
          border: 'none', fontWeight: 800, fontSize: 14,
          background: sipMod ? C.kirmizi : C.yesil, color: '#fff',
        }}>{sipMod ? '✕ Siparişi Kapat' : '🛒 Sipariş Oluştur'}</button>

        {/* Sipariş bar — toptancı seç + gönder (wa.me, senin telefonundan) */}
        {sipMod && (
          <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 12, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <select value={tedId} onChange={e => setTedId(e.target.value)} style={{
                flex: 1, padding: '9px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: C.bg, color: C.t1, fontSize: 14, boxSizing: 'border-box',
              }}>
                <option value="">— Toptancı —</option>
                {tedarikciler.map(t => <option key={t.id} value={t.id} disabled={!t.telefon}>{t.ad}{t.telefon ? '' : ' (tel yok)'}</option>)}
              </select>
              <select value={sipSube || (aktif !== 'tumu' ? aktif : '')} onChange={e => setSipSube(e.target.value)} style={{
                flex: 1, padding: '9px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: C.bg, color: C.t1, fontSize: 14, boxSizing: 'border-box',
              }}>
                <option value="">— Teslimat şubesi —</option>
                {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
              </select>
            </div>
            <input value={sipNot} onChange={e => setSipNot(e.target.value)} placeholder="Not (opsiyonel)" style={{
              width: '100%', padding: '9px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
              background: C.bg, color: C.t1, fontSize: 14, boxSizing: 'border-box', marginBottom: 8,
            }} />
            {(() => {
              const subeOk = !!(sipSube || (aktif !== 'tumu' ? aktif : ''));
              const haz = secimList.length && tedId && subeOk;
              return (
                <button onClick={waGonder} disabled={!haz} style={{
                  width: '100%', padding: '11px', borderRadius: 9, border: 'none', cursor: haz ? 'pointer' : 'not-allowed',
                  background: haz ? '#25D366' : C.bg3, color: haz ? '#fff' : C.t3, fontWeight: 800, fontSize: 14,
                }}>📲 WhatsApp'tan Gönder ({secimList.length})</button>
              );
            })()}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <button onClick={() => setSadeceSecili(v => !v)} disabled={!secimList.length} style={{
                padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: secimList.length ? 'pointer' : 'not-allowed',
                border: `1px solid ${sadeceSecili ? C.mavi : C.border}`,
                background: sadeceSecili ? C.mavi : C.bg, color: sadeceSecili ? '#fff' : (secimList.length ? C.t2 : C.t3),
              }}>{sadeceSecili ? '◉ Sadece seçilenler' : '○ Sadece seçilenler'} ({secimList.length})</button>
              <span style={{ fontSize: 10, color: C.t3, flex: 1, textAlign: 'right', marginLeft: 8 }}>Kendi WhatsApp'ından gider</span>
            </div>
          </div>
        )}

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
                // Sipariş modunda SEÇİLEN şube vurgulu (sarı); yoksa TEMA vurgulu (kahve)
                const vurguSube = (sipMod && sipSube) ? sipSube : 'sube-tema';
                const vurguRenk = (sipMod && sipSube) ? C.sari : '#C8956A';
                // Renk: hepsinde yok → kırmızı; bazı şubede yok → sarı
                const yokSay = satisSubeler.filter(s => (k.adetler?.[s.id] ?? 0) === 0).length;
                const tumYok = satisSubeler.length > 0 && yokSay >= satisSubeler.length;
                const bazYok = !tumYok && yokSay > 0;
                const durumRenk = tumYok ? C.kirmizi : (bazYok ? C.sari : null);
                const seciliT = !!secim[k.kalem_kodu];
                return (
                  <div key={k.kalem_kodu} style={{ padding: '9px 2px', borderTop: `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {sipMod && <input type="checkbox" checked={seciliT} onChange={() => secTik(k)} style={{ width: 20, height: 20, accentColor: '#25D366', flex: '0 0 auto' }} />}
                      <span style={{ fontSize: 14, flex: 1, color: durumRenk || C.t1, fontWeight: durumRenk ? 700 : 400 }}>
                        {k.kalem_adi}
                        {tumYok ? <span style={{ fontSize: 11, fontWeight: 700 }}> · stok yok</span>
                          : bazYok ? <span style={{ fontSize: 11, fontWeight: 700 }}> · {yokSay} şubede yok</span> : null}
                      </span>
                      {sipMod ? (seciliT && <SipAdet k={k} secim={secim} secAdet={secAdet} secSet={secSet} />)
                        : <span style={{ fontSize: 14, fontWeight: 800, color: C.t1 }}>{k.toplam}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {subeler.map(s => {
                        const adet = k.adetler?.[s.id] ?? 0;
                        const vurgulu = s.id === vurguSube;
                        return (
                          <span key={s.id} style={vurgulu ? {
                            fontSize: 12, padding: '3px 9px', borderRadius: 7, fontWeight: 800,
                            background: vurguRenk, color: '#fff', border: `1px solid ${vurguRenk}`,
                          } : {
                            fontSize: 11, padding: '2px 7px', borderRadius: 6,
                            background: C.bg3, color: adet > 0 ? C.t2 : C.kirmizi, fontWeight: adet > 0 ? 400 : 700,
                          }}>{kisa(s.ad)} {adet}</span>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              const adet = k.adetler[aktif] || 0;
              const dusuk = k.min_stok > 0 && adet <= k.min_stok;
              const sifir = adet === 0;
              const secili = !!secim[k.kalem_kodu];
              return (
                <div key={k.kalem_kodu} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 2px', borderTop: `1px solid ${C.border}` }}>
                  {sipMod && <input type="checkbox" checked={secili} onChange={() => secTik(k)} style={{ width: 20, height: 20, accentColor: '#25D366', flex: '0 0 auto' }} />}
                  <span style={{ fontSize: 14, flex: 1, color: sifir ? C.kirmizi : C.t1, fontWeight: sifir ? 700 : 400 }}>
                    {k.kalem_adi}
                    {sifir ? <span style={{ fontSize: 11, fontWeight: 700 }}> · stok yok</span>
                      : dusuk ? <span style={{ fontSize: 11, color: C.kirmizi, fontWeight: 700 }}> · düşük</span> : null}
                    <span style={{ fontSize: 11, color: C.t3 }}> · depo {adet}</span>
                  </span>
                  {sipMod ? (secili && <SipAdet k={k} secim={secim} secAdet={secAdet} secSet={secSet} />)
                    : <span style={{ fontSize: 16, fontWeight: 800, color: dusuk ? C.kirmizi : (adet > 0 ? C.t1 : C.t3) }}>{adet}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Kartlar (toplam borç + kart kart: borç/limit/yaklaşan ödeme + son hareketler) ──
function CepKartlar({ onGeri }) {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [detay, setDetay] = useState(null);       // seçilen kart (hareketler modalı)
  const [hareketler, setHareketler] = useState(null);

  useEffect(() => {
    api('/kartlar')
      .then(r => setListe(Array.isArray(r) ? r : (r?.kartlar || [])))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);

  // Yaklaşan ödeme üstte (borçlu kartlar gün sırasına göre)
  const kartlar = (liste || []).slice().sort((a, b) => {
    const ga = (Number(a.guncel_borc) || 0) > 0 && a.gun_kaldi != null ? a.gun_kaldi : 9999;
    const gb = (Number(b.guncel_borc) || 0) > 0 && b.gun_kaldi != null ? b.gun_kaldi : 9999;
    return ga - gb;
  });
  const toplamBorc = (liste || []).reduce((s, k) => s + (Number(k.guncel_borc) || 0), 0);
  const toplamKalan = (liste || []).reduce((s, k) => s + (Number(k.kalan_limit) || 0), 0);
  const yaklasanSay = (liste || []).filter(k => (Number(k.guncel_borc) || 0) > 0 && k.gun_kaldi != null && k.gun_kaldi <= 7).length;

  const odemeRenk = (k) => {
    if ((Number(k.guncel_borc) || 0) <= 0 || k.gun_kaldi == null) return C.t3;
    return k.gun_kaldi <= 3 ? C.kirmizi : k.gun_kaldi <= 7 ? C.sari : C.t2;
  };
  const trTarih = (s) => s ? new Date(s).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) : '—';

  const acDetay = (k) => {
    setDetay(k); setHareketler(null);
    api(`/kart-hareketleri?kart_id=${k.id}&limit=40`)
      .then(r => setHareketler(Array.isArray(r) ? r : []))
      .catch(() => setHareketler([]));
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: 30 }}>
      <Baslik baslik="💳 Kartlar" onGeri={onGeri} />

      {liste && liste.length > 0 && (
        <div style={{ margin: 14, padding: 16, borderRadius: 16, background: 'linear-gradient(135deg, var(--bg2,#1a1d24), var(--bg3,#22262f))', border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, color: C.t3 }}>Toplam kart borcu</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.kirmizi, marginTop: 2 }}>{fmt(toplamBorc)}</div>
          <div style={{ fontSize: 12, color: C.t3, marginTop: 4 }}>Kalan limit: <b style={{ color: C.yesil }}>{fmt(toplamKalan)}</b></div>
          {yaklasanSay > 0 && (
            <div style={{ fontSize: 13, fontWeight: 700, color: C.sari, marginTop: 10 }}>⚠️ {yaklasanSay} kartın son ödeme tarihi 7 gün içinde</div>
          )}
        </div>
      )}

      <div style={{ padding: '0 14px 14px' }}>
        {liste === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}
        {liste && liste.length === 0 && !hata && <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>Kart yok.</div>}
        {kartlar.map(k => {
          const borc = Number(k.guncel_borc) || 0;
          const limit = Number(k.limit_tutar) || 0;
          const doluluk = limit > 0 ? Math.min(100, Math.round((borc / limit) * 100)) : 0;
          const oRenk = odemeRenk(k);
          return (
            <button key={k.id} onClick={() => acDetay(k)} style={{
              width: '100%', textAlign: 'left', background: C.bg2, border: `1px solid ${C.border}`,
              borderLeft: `4px solid ${oRenk}`, borderRadius: 14, padding: 14, marginBottom: 12, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: C.t1 }}>{k.kart_adi || k.banka || 'Kart'}</span>
                <span style={{ fontSize: 17, fontWeight: 800, color: borc > 0 ? C.kirmizi : C.t3, whiteSpace: 'nowrap' }}>{fmt(borc)}</span>
              </div>
              <div style={{ height: 6, background: C.bg3, borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                <div style={{ width: `${doluluk}%`, height: '100%', background: doluluk >= 90 ? C.kirmizi : doluluk >= 70 ? C.sari : C.yesil }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.t3, marginTop: 6 }}>
                <span>Kalan: <b style={{ color: C.t2 }}>{fmt(k.kalan_limit)}</b></span>
                {borc > 0 && k.gun_kaldi != null && (
                  <span style={{ color: oRenk, fontWeight: 700 }}>{k.gun_kaldi <= 3 ? '🔴' : k.gun_kaldi <= 7 ? '🟡' : '🟢'} Son ödeme {trTarih(k.son_odeme_tarihi)} · {k.gun_kaldi}g</span>
                )}
              </div>
              {borc > 0 && Number(k.asgari_odeme) > 0 && (
                <div style={{ fontSize: 11, color: C.t3, marginTop: 3 }}>Asgari: {fmt(k.asgari_odeme)}{k.asgari_karsilandi ? ' ✓ ödendi' : ''}</div>
              )}
            </button>
          );
        })}
      </div>

      {detay && (
        <div onClick={e => e.target === e.currentTarget && setDetay(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: '100%', maxHeight: '85vh', background: C.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTop: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>💳 {detay.kart_adi || detay.banka}</span>
                <button onClick={() => setDetay(null)} style={{ background: C.bg3, border: 'none', borderRadius: 10, color: C.t2, width: 36, height: 36, fontSize: 16, cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ fontSize: 13, color: C.t3, marginTop: 6 }}>
                Borç <b style={{ color: C.kirmizi }}>{fmt(detay.guncel_borc)}</b> · Kalan {fmt(detay.kalan_limit)} · Son ödeme {trTarih(detay.son_odeme_tarihi)}
              </div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 3 }}>
                Kullanım %{detay.limit_doluluk != null ? Math.round(detay.limit_doluluk) : (Number(detay.limit_tutar) > 0 ? Math.round((Number(detay.guncel_borc) / Number(detay.limit_tutar)) * 100) : 0)}
                {Number(detay.asgari_odeme) > 0 ? ` · Asgari ${fmt(detay.asgari_odeme)}${detay.asgari_karsilandi ? ' ✓' : ''}` : ''}
              </div>
            </div>
            <div style={{ overflowY: 'auto', padding: '4px 16px 20px' }}>
              {hareketler === null && <div style={{ color: C.t3, textAlign: 'center', padding: 20 }}>Yükleniyor…</div>}
              {hareketler && hareketler.length === 0 && <div style={{ color: C.t3, textAlign: 'center', padding: 20 }}>Hareket yok.</div>}
              {(hareketler || []).map((h, i) => {
                const odeme = h.islem_turu === 'ODEME';
                const t = Number(h.tutar) || 0;
                return (
                  <div key={h.id || i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.4 }}>{h.aciklama || h.islem_turu}</div>
                      <div style={{ fontSize: 11, color: C.t3, marginTop: 2 }}>{h.islem_turu}{h.taksit_sayisi > 1 ? ` · ${h.taksit_sayisi} taksit` : ''} · {String(h.tarih).slice(0, 10)}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', color: odeme ? C.yesil : C.kirmizi }}>{odeme ? '−' : '+'}{fmt(Math.abs(t))}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Kök bileşen ─────────────────────────────────────────────────────────────
// ── Sipariş Kontrol Kulesi (gelen sipariş + yönlendir) ──────────────────────
function CepKule({ onGeri, onDegisti }) {
  const [data, setData] = useState(null);
  const [hata, setHata] = useState('');
  const [tab, setTab] = useState('gelen');       // 'gelen' | 'takip'
  const [tedarikciler, setTedarikciler] = useState([]);
  const [yon, setYon] = useState(null);          // alt-sayfa: yönlendirilecek talep
  const [tedId, setTedId] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [undo, setUndo] = useState(null);        // { talep_id, sube_adi, ted_ad, tam }
  const [oneriler, setOneriler] = useState({});  // urun_norm -> {tedarikci_id, tedarikci_ad, oran, kaynak}
  const [varsayilan, setVarsayilan] = useState(false);  // alt-sayfa: "bunları hep buradan al"
  const [subeler, setSubeler] = useState([]);
  const [depoYon, setDepoYon] = useState(null);   // depo-sevk alt-sayfası: { talep, items }
  const [depoSubeId, setDepoSubeId] = useState('');
  const [uyum, setUyum] = useState([]);           // kabul uyumsuzlukları (kapanmış dahil)
  const [detay, setDetay] = useState(null);       // tıklanan siparişin detay modalı
  const gonderiyorRef = useRef(false);  // SENKRON kilit — çift tıkta iki gönderimi engeller

  const yukle = useCallback((sessiz) => {
    if (!sessiz) setHata('');
    api('/ops/siparis/kontrol-kulesi?gun=30')
      .then(d => setData(d))
      .catch(e => { if (!sessiz) { setHata(e.message || 'Yüklenemedi'); setData({ satirlar: [] }); } });
    // Kabul uyumsuzlukları AYRI çekilir — kapanmış (teslim_edildi) olsa bile görünsün
    api('/ops/siparis/kontrol-kulesi?gun=30&asama=uyumsuzluk&sadece_acik=false&limit=200')
      .then(d => setUyum(d?.satirlar || []))
      .catch(() => {});
  }, []);
  useEffect(() => { yukle(); const t = setInterval(() => yukle(true), 45000); return () => clearInterval(t); }, [yukle]);
  useEffect(() => { api('/tedarikciler').then(r => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || []))).catch(() => {}); }, []);
  const oneriYukle = useCallback(() => { api('/ops/siparis/toptanci-oneri').then(r => setOneriler(r?.oneriler || {})).catch(() => {}); }, []);
  useEffect(() => { oneriYukle(); }, [oneriYukle]);
  useEffect(() => { api('/subeler').then(r => setSubeler(Array.isArray(r) ? r : [])).catch(() => {}); }, []);
  // Geri-al penceresi 10 sn (Gmail mantığı — ikinci onaya gerek yok)
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 10000); return () => clearTimeout(t); }, [undo]);

  const itemsOf = (s) => (Array.isArray(s.kalan_kalemler) && s.kalan_kalemler.length ? s.kalan_kalemler : (s.kalemler || []));
  const satirlar = data?.satirlar || [];
  // En eski en üstte — hiçbir sipariş dibe gömülmesin
  const yasDk = (s) => { const t = s.olusturma || s.tarih; const ms = t ? (Date.now() - new Date(t).getTime()) : 0; return Math.max(0, Math.floor(ms / 60000)); };
  const gelen = satirlar.filter(s => s.asama === 'bekliyor').sort((a, b) => yasDk(b) - yasDk(a));
  const yasMetin = (dk) => dk < 1 ? 'az önce' : dk < 60 ? `${dk} dk bekliyor` : dk < 1440 ? `${Math.floor(dk / 60)} sa ${dk % 60} dk bekliyor` : `${Math.floor(dk / 1440)} gün bekliyor`;
  const yasRenk = (dk) => dk >= 120 ? C.kirmizi : dk >= 30 ? C.sari : C.yesil;

  // Son kullanılan toptancı hafızası (şube bazlı, localStorage) — öğrenen öneri Faz 2
  const sonKey = (sid) => `cep_son_toptanci:${sid || 'genel'}`;
  const sonGet = (sid) => { try { return JSON.parse(localStorage.getItem(sonKey(sid)) || 'null'); } catch { return null; } };
  const sonSet = (sid, ted) => { try { localStorage.setItem(sonKey(sid), JSON.stringify({ id: ted.id, ad: ted.ad })); } catch { /* ignore */ } };

  // Öğrenen öneri: ürün → toptancı (geçmiş + elle tercih). Kalemleri öneriye göre grupla.
  const oneriOf = (ad) => oneriler[String(ad || '').trim().toLowerCase()] || null;
  const gruplaItems = (items) => {
    const map = {}; const onerisiz = [];
    items.forEach(it => {
      const o = oneriOf(it.urun_ad);
      if (o && o.tedarikci_id) {
        const g = map[o.tedarikci_id] || (map[o.tedarikci_id] = { ted_id: o.tedarikci_id, ted_ad: o.tedarikci_ad, oran: o.oran, kaynak: o.kaynak, items: [] });
        g.items.push(it);
        if (o.oran != null) g.oran = Math.min(g.oran == null ? 1 : g.oran, o.oran);
      } else onerisiz.push(it);
    });
    return { gruplar: Object.values(map), onerisiz };
  };

  const waNum = (tel) => {
    let n = String(tel || '').replace(/\D/g, '');
    if (n.startsWith('00')) n = n.slice(2);
    if (n.length === 11 && n.startsWith('0')) n = '90' + n.slice(1);
    else if (n.length === 10 && n.startsWith('5')) n = '90' + n;
    return n.length >= 11 ? n : '';
  };

  // Tek yönlendirme yolu — grup kısayolu da alt-sayfa da bunu çağırır (items = alt küme)
  const route = async (talep, ted, items) => {
    if (!talep || !ted) return;
    const liste = (items && items.length ? items : itemsOf(talep));
    const kalemler = liste.map(k => ({ urun_ad: k.urun_ad, adet: Number(k.adet) || 1 })).filter(k => k.urun_ad);
    if (!kalemler.length) { alert('Gönderilecek kalem yok'); return; }
    if (gonderiyorRef.current) return; gonderiyorRef.current = true;  // çift tık kilidi
    const tel = ted.telefon || tedarikciler.find(t => String(t.id) === String(ted.id))?.telefon;
    setMesgul(true);
    try {
      const r = await api('/ops/siparis/toptanciya-yolla', {
        method: 'POST',
        body: { talep_id: talep.id, tedarikci_id: ted.id, tedarikci_ad: ted.ad, kalemler },
      });
      if (!r?.wa_basarili) {  // Green API gitmediyse senin telefonundan wa.me
        const num = waNum(tel);
        if (num) {
          const sipTarih = talep.tarih ? new Date(talep.tarih).toLocaleDateString('tr-TR') : new Date().toLocaleDateString('tr-TR');
          const txt = `🛒 *${talep.sube_adi}* şubesi için sipariş\n📅 Sipariş Tarihi: ${sipTarih}\n\n` +
            kalemler.map(k => `• ${k.adet} adet ${k.urun_ad}`).join('\n');
          window.open(`https://wa.me/${num}?text=${encodeURIComponent(txt)}`, '_blank');
        }
      }
      sonSet(talep.sube_id, ted);  // hafıza: bir dahaki sefere şube kısayolu
      // "Varsayılan yap" işaretliyse bu ürünleri bu toptancıya TERCİH olarak kaydet (öğrenir/düzelir)
      if (varsayilan) {
        await Promise.allSettled(kalemler.map(k =>
          api('/ops/siparis/toptanci-tercih', { method: 'POST', body: { urun_ad: k.urun_ad, tedarikci_id: ted.id, tedarikci_ad: ted.ad } })
        ));
        setVarsayilan(false); oneriYukle();
      }
      setYon(null); setTedId('');
      setUndo({ talep_id: talep.id, sube_adi: talep.sube_adi, ted_ad: ted.ad, tam: r?.tam_gonderildi !== false });
      yukle(); onDegisti && onDegisti();
    } catch (e) { alert('Yönlendirilemedi: ' + (e.message || '')); }
    finally { setMesgul(false); gonderiyorRef.current = false; }
  };

  const geriAl = async () => {
    if (!undo) return;
    const id = undo.talep_id; const tam = undo.tam; setUndo(null);
    try {
      await api(`/ops/siparis/${id}/toptanci-geri-al`, { method: 'POST' });
      yukle(); onDegisti && onDegisti();
    } catch (e) {
      alert('Geri alınamadı: ' + (e.message || '') + (tam ? '' : ' (kısmi gönderim masaüstünden düzeltilir)'));
    }
  };

  // TOPLU: tüm gelen siparişleri öneriye göre toptancıda birleştir (opsiyon — varsayılan değil)
  const batchKur = () => {
    const map = {};
    gelen.forEach(s => {
      gruplaItems(itemsOf(s)).gruplar.forEach(g => {
        const b = map[g.ted_id] || (map[g.ted_id] = { ted_id: g.ted_id, ted_ad: g.ted_ad, satirlar: [], kalem: 0 });
        b.satirlar.push({ talep: s, items: g.items });
        b.kalem += g.items.length;
      });
    });
    return Object.values(map).sort((a, b) => b.kalem - a.kalem);
  };

  const batchGonder = async (b) => {
    if (gonderiyorRef.current) return; gonderiyorRef.current = true;  // çift tık kilidi
    setMesgul(true);
    try {
      for (const row of b.satirlar) {  // her talebi kaydet — WA YOK (tek birleşik mesaj aşağıda)
        const kalemler = row.items.map(k => ({ urun_ad: k.urun_ad, adet: Number(k.adet) || 1 })).filter(k => k.urun_ad);
        if (!kalemler.length) continue;
        await api('/ops/siparis/toptanciya-yolla', {
          method: 'POST',
          body: { talep_id: row.talep.id, tedarikci_id: b.ted_id, tedarikci_ad: b.ted_ad, kalemler, wa_gonder: false },
        });
      }
      const ted = tedarikciler.find(t => String(t.id) === String(b.ted_id));
      const num = waNum(ted?.telefon);
      if (num) {  // tek birleşik mesaj — şube kırılımlı
        const bloklar = b.satirlar.map(row => {
          const st = row.talep.tarih ? new Date(row.talep.tarih).toLocaleDateString('tr-TR') : '';
          return `*${row.talep.sube_adi}*${st ? ` — 📅 ${st}` : ''}\n` + row.items.map(k => `• ${k.adet || ''} ${k.urun_ad}`.trim()).join('\n');
        }).join('\n\n');
        window.open(`https://wa.me/${num}?text=${encodeURIComponent(`🛒 Sipariş\n\n${bloklar}`)}`, '_blank');
      } else {
        alert(`${b.ted_ad} için telefon yok — kayıt yapıldı, mesajı elle gönder.`);
      }
      yukle(); onDegisti && onDegisti();
    } catch (e) { alert('Toplu gönderim hatası: ' + (e.message || '')); }
    finally { setMesgul(false); gonderiyorRef.current = false; }
  };

  // Kendi depomuzdan sevk — kaynak depo şubesini sen seçersin (toptancıya alternatif)
  const depoSevk = async () => {
    if (!depoYon || !depoSubeId) return;
    if (gonderiyorRef.current) return; gonderiyorRef.current = true;  // çift tık kilidi
    setMesgul(true);
    try {
      await api('/ops/siparis/sevkiyata-gonder', {
        method: 'POST',
        body: { talep_id: depoYon.talep.id, hedef_depo_sube_id: depoSubeId },
      });
      const dep = subeler.find(x => String(x.id) === String(depoSubeId));
      setDepoYon(null); setDepoSubeId('');
      setUndo({ talep_id: depoYon.talep.id, sube_adi: depoYon.talep.sube_adi, ted_ad: `${dep?.ad || 'depo'} (depo)`, tam: false, depo: true });
      yukle(); onDegisti && onDegisti();
    } catch (e) { alert('Sevk başlatılamadı: ' + (e.message || '')); }
    finally { setMesgul(false); gonderiyorRef.current = false; }
  };

  const renkAsama = (a) => a === 'bekliyor' ? C.sari : a === 'tamamlandi' ? C.yesil
    : a === 'uyumsuzluk' ? C.kirmizi : (a === 'iptal' || a === 'gonderilmedi') ? C.t3 : C.mavi;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, paddingBottom: undo ? 80 : 0 }}>
      <Baslik baslik="🚚 Sipariş Kulesi" onGeri={onGeri} sag={
        <button onClick={() => yukle()} style={{ background: 'none', border: 'none', color: C.t3, fontSize: 20, cursor: 'pointer' }}>↻</button>
      } />
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px 4px' }}>
        {[['gelen', `Gelen (${gelen.length})`], ['toplu', 'Toplu'], ['takip', uyum.length ? `Takip ⚠${uyum.length}` : 'Takip']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            flex: 1, padding: '10px', borderRadius: 10, cursor: 'pointer', fontWeight: 800, fontSize: 14,
            border: `1px solid ${tab === k ? C.mavi : C.border}`,
            background: tab === k ? C.mavi : C.bg2, color: tab === k ? '#fff' : C.t2,
          }}>{lbl}</button>
        ))}
      </div>

      <div style={{ padding: 14 }}>
        {data === null && <div style={{ color: C.t3, textAlign: 'center', padding: 30 }}>Yükleniyor…</div>}
        {hata && <div style={{ color: C.kirmizi, textAlign: 'center', padding: 20 }}>{hata}</div>}

        {/* GELEN: hızlı karar kartı (yaş + kalem sayısı + son toptancı kısayolu) */}
        {data && tab === 'gelen' && gelen.length === 0 && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
            Tüm siparişler yönlendirildi.
          </div>
        )}
        {data && tab === 'gelen' && gelen.map(s => {
          const items = itemsOf(s);
          const dk = yasDk(s);
          const { gruplar, onerisiz } = gruplaItems(items);
          return (
            <div key={s.id} style={{
              background: C.bg2, border: `1px solid ${C.border}`,
              borderLeft: `4px solid ${yasRenk(dk)}`, borderRadius: 14, padding: 14, marginBottom: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 17, fontWeight: 800, color: C.t1 }}>{s.sube_adi}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: yasRenk(dk) }}>● {yasMetin(dk)}</span>
              </div>
              <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{items.length} kalem</div>
              {s.kismi_toptanci && (
                <div style={{ fontSize: 11, color: C.sari, fontWeight: 700, marginTop: 6 }}>
                  🔶 {(s.dagitilan_kalem_adlari || []).join(', ')} yollandı
                </div>
              )}

              {/* Öneriye göre gruplar — her grup tek tık (espresso→ATALAY, soda→Fez ayrı) */}
              {gruplar.map(g => (
                <div key={g.ted_id} style={{ marginTop: 10, padding: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: C.t1 }}>{g.ted_ad}</span>
                    <span style={{ fontSize: 11, color: C.t3 }}>{g.kaynak === 'elle' ? 'senin seçimin' : `öneri %${Math.round((g.oran || 0) * 100)}`}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.t2, marginBottom: 8 }}>
                    {g.items.map(k => `${k.adet || ''} ${k.urun_ad}`.trim()).join(', ')}
                  </div>
                  <button disabled={mesgul} onClick={() => route(s, { id: g.ted_id, ad: g.ted_ad }, g.items)} style={{
                    width: '100%', padding: '11px', borderRadius: 9, border: 'none',
                    background: C.yesil, color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                  }}>🚚 {g.ted_ad}'a yolla</button>
                  <button disabled={mesgul} onClick={() => { setYon({ talep: s, items: g.items }); setTedId(g.ted_id); setVarsayilan(false); }} style={{
                    width: '100%', padding: '8px', marginTop: 6, borderRadius: 9, border: 'none',
                    background: 'transparent', color: C.t3, fontWeight: 600, fontSize: 12, cursor: 'pointer',
                  }}>başka toptancı / düzelt</button>
                </div>
              ))}

              {/* Önerisi olmayan kalemler — elle yönlendir (ilk seçim öğrenilir) */}
              {onerisiz.length > 0 && (
                <div style={{ marginTop: 10, padding: 10, background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 12, color: C.t3, marginBottom: 6 }}>Öneri yok — toptancı seç</div>
                  <div style={{ fontSize: 12, color: C.t2, marginBottom: 8 }}>
                    {onerisiz.map(k => `${k.adet || ''} ${k.urun_ad}`.trim()).join(', ')}
                  </div>
                  <button disabled={mesgul} onClick={() => { setYon({ talep: s, items: onerisiz }); setTedId(''); setVarsayilan(true); }} style={{
                    width: '100%', padding: '11px', borderRadius: 9, border: 'none',
                    background: C.mavi, color: '#fff', fontWeight: 800, fontSize: 13, cursor: 'pointer',
                  }}>🚚 Toptancı seç</button>
                </div>
              )}

              {/* Kendi depomuzdan sevk — toptancıya ALTERNATİF (kaynak depo şubesi seç) */}
              <button disabled={mesgul} onClick={() => { setDepoYon({ talep: s, items }); setDepoSubeId(''); }} style={{
                width: '100%', marginTop: 10, padding: '11px', borderRadius: 10,
                border: `1px solid ${C.mavi}`, background: 'transparent', color: C.mavi,
                fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}>📦 Bunun yerine depodan gönder</button>
            </div>
          );
        })}

        {/* TOPLU: toptancıya göre birleştir, tek mesaj (opsiyon) */}
        {data && tab === 'toplu' && (() => {
          const bl = batchKur();
          if (!bl.length) return (
            <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📦</div>Birleştirilecek (önerili) sipariş yok.
            </div>
          );
          return bl.map(b => (
            <div key={b.ted_id} style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 14, padding: 14, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{b.ted_ad}</span>
                <span style={{ fontSize: 12, color: C.t3 }}>{b.satirlar.length} şube · {b.kalem} kalem</span>
              </div>
              {b.satirlar.map((row, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
                  <span style={{ color: C.t1, fontWeight: 700 }}>{row.talep.sube_adi}: </span>
                  <span style={{ color: C.t2 }}>{row.items.map(k => `${k.adet || ''} ${k.urun_ad}`.trim()).join(', ')}</span>
                </div>
              ))}
              <button disabled={mesgul} onClick={() => batchGonder(b)} style={{
                width: '100%', marginTop: 10, padding: '12px', borderRadius: 10, border: 'none',
                background: C.yesil, color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer',
              }}>📨 Tek mesajla yolla ({b.satirlar.length} şube)</button>
            </div>
          ));
        })()}

        {/* TAKIP: aşamalı, salt-okur */}
        {/* KABUL UYUMSUZLUKLARI — kapanmış olsa bile görünür (en üstte, kırmızı) */}
        {data && tab === 'takip' && uyum.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: C.kirmizi, marginBottom: 8 }}>⚠ Kabul Uyumsuzlukları ({uyum.length})</div>
            {uyum.map(s => (
              <div key={s.id} onClick={() => setDetay(s)} style={{
                background: 'rgba(239,68,68,0.06)', border: `1px solid rgba(239,68,68,0.3)`,
                borderLeft: `4px solid ${C.kirmizi}`, borderRadius: 14, padding: 14, marginBottom: 10, cursor: 'pointer',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{s.sube_adi}</span>
                  <span style={{ fontSize: 12, color: C.t3 }}>{String(s.tarih || '').slice(0, 10)}</span>
                </div>
                <div style={{ fontSize: 12, color: C.kirmizi, fontWeight: 700, marginTop: 4 }}>Kabulde eksik/fazla — incele ›</div>
                <div style={{ fontSize: 12, color: C.t3, marginTop: 4, lineHeight: 1.5 }}>
                  {s.sevkiyat_personel_ad ? `Sevk: ${s.sevkiyat_personel_ad}` : 'Sevk: —'}
                  {'  ·  '}{s.kabul_personel_ad ? `Kabul: ${s.kabul_personel_ad}` : 'Kabul: —'}
                </div>
              </div>
            ))}
          </div>
        )}

        {data && tab === 'takip' && satirlar.length === 0 && uyum.length === 0 && (
          <div style={{ color: C.t3, textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🗂️</div>Açık sipariş yok.
          </div>
        )}
        {data && tab === 'takip' && satirlar.map(s => {
          const items = itemsOf(s);
          const kimKim = s.sevkiyat_personel_ad || s.kabul_personel_ad;
          return (
            <div key={s.id} onClick={() => setDetay(s)} style={{
              background: C.bg2, border: `1px solid ${C.border}`,
              borderLeft: `4px solid ${renkAsama(s.asama)}`, borderRadius: 14, padding: 14, marginBottom: 12, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: C.t1 }}>{s.sube_adi}</span>
                <span style={{ fontSize: 12, color: C.t3 }}>{String(s.tarih || '').slice(0, 10)}</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: renkAsama(s.asama), marginBottom: 6 }}>{s.asama_metni || s.asama}</div>
              <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.5 }}>
                {items.length ? items.map(k => `${k.adet || ''} ${k.urun_ad}`.trim()).join(' · ') : '—'}
              </div>
              {kimKim && (
                <div style={{ fontSize: 11, color: C.t3, marginTop: 6 }}>
                  {s.sevkiyat_personel_ad ? `Sevk: ${s.sevkiyat_personel_ad}` : ''}{s.sevkiyat_personel_ad && s.kabul_personel_ad ? '  ·  ' : ''}{s.kabul_personel_ad ? `Kabul: ${s.kabul_personel_ad}` : ''}
                </div>
              )}
              {s.kismi_toptanci && (
                <div style={{ fontSize: 11, color: C.sari, fontWeight: 700, marginTop: 6, lineHeight: 1.4 }}>
                  🔶 {(s.dagitilan_kalem_adlari || []).join(', ')} yollandı · kalan {(s.kalan_kalemler || []).map(k => k.urun_ad).filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Yönlendir alt-sayfası ("başka toptancı" / ilk yönlendirme) */}
      {yon && (
        <div onClick={e => e.target === e.currentTarget && setYon(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'flex-end',
        }}>
          <div style={{
            width: '100%', maxHeight: '85vh', overflowY: 'auto', background: C.bg2,
            borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTop: `1px solid ${C.border}`, padding: 18,
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.t1, marginBottom: 2 }}>🚚 {yon.talep.sube_adi} → Toptancı</div>
            <div style={{ fontSize: 12, color: C.t3, marginBottom: 12 }}>Bu kalemler gönderilecek; toptancıyı seç.</div>
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
              {yon.items.map((k, i) => (
                <div key={i} style={{ fontSize: 13, color: C.t1, padding: '3px 0' }}>• {k.adet || ''} {k.urun_ad}</div>
              ))}
            </div>
            <select value={tedId} onChange={e => setTedId(e.target.value)} style={{
              width: '100%', padding: '12px', borderRadius: 10, border: `1px solid ${C.border}`,
              background: C.bg, color: C.t1, fontSize: 15, boxSizing: 'border-box', marginBottom: 12,
            }}>
              <option value="">— Toptancı seç —</option>
              {tedarikciler.map(t => <option key={t.id} value={t.id}>{t.ad}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.t2, margin: '0 0 14px', cursor: 'pointer' }}>
              <input type="checkbox" checked={varsayilan} onChange={e => setVarsayilan(e.target.checked)} style={{ width: 18, height: 18 }} />
              Bu ürünleri hep buradan al (öğrensin)
            </label>
            <button disabled={mesgul || !tedId} onClick={() => route(yon.talep, tedarikciler.find(t => String(t.id) === String(tedId)), yon.items)} style={{
              width: '100%', padding: '14px', borderRadius: 12, border: 'none',
              background: (mesgul || !tedId) ? C.bg3 : C.yesil, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer',
            }}>{mesgul ? '…' : '✓ Yönlendir & Gönder'}</button>
            <button onClick={() => { setYon(null); setVarsayilan(false); }} style={{
              width: '100%', padding: '12px', marginTop: 8, borderRadius: 12, border: 'none',
              background: 'transparent', color: C.t3, fontWeight: 700, cursor: 'pointer',
            }}>Vazgeç</button>
          </div>
        </div>
      )}

      {/* Depo-sevk alt-sayfası — hangi şubenin deposundan sevk edilsin? */}
      {depoYon && (
        <div onClick={e => e.target === e.currentTarget && setDepoYon(null)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'flex-end',
        }}>
          <div style={{
            width: '100%', maxHeight: '85vh', overflowY: 'auto', background: C.bg2,
            borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTop: `1px solid ${C.border}`, padding: 18,
          }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.t1, marginBottom: 2 }}>📦 {depoYon.talep.sube_adi} → Depodan sevk</div>
            <div style={{ fontSize: 12, color: C.t3, marginBottom: 12 }}>Hangi şubenin deposundan sevk edilsin?</div>
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
              {depoYon.items.map((k, i) => (
                <div key={i} style={{ fontSize: 13, color: C.t1, padding: '3px 0' }}>• {k.adet || ''} {k.urun_ad}</div>
              ))}
            </div>
            <select value={depoSubeId} onChange={e => setDepoSubeId(e.target.value)} style={{
              width: '100%', padding: '12px', borderRadius: 10, border: `1px solid ${C.border}`,
              background: C.bg, color: C.t1, fontSize: 15, boxSizing: 'border-box', marginBottom: 12,
            }}>
              <option value="">— Kaynak depo şubesi —</option>
              {subeler.filter(x => String(x.id) !== String(depoYon.talep.sube_id)).map(x => (
                <option key={x.id} value={x.id}>{x.ad}</option>
              ))}
            </select>
            <button disabled={mesgul || !depoSubeId} onClick={depoSevk} style={{
              width: '100%', padding: '14px', borderRadius: 12, border: 'none',
              background: (mesgul || !depoSubeId) ? C.bg3 : C.mavi, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer',
            }}>{mesgul ? '…' : '✓ Sevk Başlat'}</button>
            <button onClick={() => setDepoYon(null)} style={{
              width: '100%', padding: '12px', marginTop: 8, borderRadius: 12, border: 'none',
              background: 'transparent', color: C.t3, fontWeight: 700, cursor: 'pointer',
            }}>Vazgeç</button>
          </div>
        </div>
      )}

      {/* Sipariş detay modalı — alış (kabul) vs çıkış (sevk) + kim-kim */}
      {detay && (() => {
        const yolda = Array.isArray(detay.yolda) ? detay.yolda : [];
        const items = itemsOf(detay);
        return (
          <div onClick={e => e.target === e.currentTarget && setDetay(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 70, display: 'flex', flexDirection: 'column' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: C.bg2, width: '100%', maxWidth: 520, margin: '0 auto', height: '100%', overflowY: 'auto' }}>
              <div style={{ position: 'sticky', top: 0, background: C.bg2, borderBottom: `1px solid ${C.border}`, padding: '16px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.t1 }}>{detay.sube_adi}</div>
                  <div style={{ fontSize: 12, color: C.t3, marginTop: 2 }}>{detay.asama_metni || detay.asama} · {String(detay.tarih || '').slice(0, 10)}</div>
                </div>
                <button onClick={() => setDetay(null)} style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.t2, width: 34, height: 34, borderRadius: 9, fontSize: 16, cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ padding: 16 }}>
                {/* Kim sevk etti / kim kabul etti */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  <div style={{ flex: 1, background: C.bg, borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: C.t3 }}>🚚 Çıkış (sevk eden)</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.t1, marginTop: 2 }}>{detay.sevkiyat_personel_ad || detay.tahsis_yapan_ad || '—'}</div>
                    {detay.sevkiyat_ts && <div style={{ fontSize: 10, color: C.t3 }}>{String(detay.sevkiyat_ts).slice(0, 16).replace('T', ' ')}</div>}
                  </div>
                  <div style={{ flex: 1, background: C.bg, borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: C.t3 }}>📥 Alış (kabul eden)</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.t1, marginTop: 2 }}>{detay.kabul_personel_ad || '—'}</div>
                    {detay.kabul_ts && <div style={{ fontSize: 10, color: C.t3 }}>{String(detay.kabul_ts).slice(0, 16).replace('T', ' ')}</div>}
                  </div>
                </div>

                {/* Kalem kalem: çıkış (sevk) vs alış (kabul) */}
                <div style={{ fontSize: 12, fontWeight: 800, color: C.t2, marginBottom: 8 }}>Kalem kalem — çıkış vs alış</div>
                {yolda.length > 0 ? yolda.map((y, i) => {
                  const sevk = Number(y.sevk_adet) || 0;
                  const kab = y.kabul_adet == null ? null : Number(y.kabul_adet);
                  const fark = kab == null ? null : kab - sevk;
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 11px', background: C.bg, borderRadius: 10, marginBottom: 6, borderLeft: `3px solid ${fark ? C.kirmizi : C.yesil}` }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.t1, flex: 1, minWidth: 0 }}>{y.kalem_adi || y.kalem_kodu}</span>
                      <span style={{ fontSize: 12, color: C.t3, whiteSpace: 'nowrap' }}>çıkış {sevk} → alış <b style={{ color: C.t1 }}>{kab == null ? '—' : kab}</b>{fark ? <span style={{ color: C.kirmizi }}> ({fark > 0 ? '+' : ''}{fark})</span> : <span style={{ color: C.yesil }}> ✓</span>}</span>
                    </div>
                  );
                }) : (
                  <div style={{ fontSize: 13, color: C.t2, lineHeight: 1.6 }}>
                    {items.length ? items.map(k => `${k.adet || ''} ${k.urun_ad}`.trim()).join(' · ') : '—'}
                    <div style={{ fontSize: 11, color: C.t3, marginTop: 8 }}>Bu sipariş toptancıdan geldi (depo sevk satırı yok); kalem bazlı çıkış/alış kıyası depo sevkiyatlarında görünür.</div>
                  </div>
                )}

                {/* Uyumsuzluğu çöz — ilgili personele WhatsApp (senin telefonundan) */}
                {(() => {
                  const tarih = String(detay.tarih || '').slice(0, 10);
                  // SAYI VERME — sadece ürün adları (uyumsuz olanlar; yoksa tüm kalemler)
                  const farkliAdlar = (Array.isArray(detay.yolda) && detay.yolda.length)
                    ? detay.yolda.filter(y => y.kabul_adet != null && (Number(y.kabul_adet) - (Number(y.sevk_adet) || 0)) !== 0).map(y => y.kalem_adi || y.kalem_kodu)
                    : [];
                  const adlar = (farkliAdlar.length ? farkliAdlar : items.map(k => k.urun_ad)).filter(Boolean);
                  const urunMetin = adlar.length ? adlar.join(', ') : 'bu teslimat';
                  const sorMesaj = (kim, ad) =>
                    kim === 'kabul'
                      ? `Merhaba ${ad || ''} 👋\n*${detay.sube_adi}* ${tarih} teslimatında *${urunMetin}* alışını kabul etmişsin ama bir uyumsuzluk var 🔴\nTekrar kontrol eder misin? 🙏`
                      : `Merhaba ${ad || ''} 👋\n*${detay.sube_adi}* ${tarih} teslimatında *${urunMetin}* sevkinde bir uyumsuzluk var 🔴\nTekrar kontrol eder misin? 🙏`;
                  const wa = (kim, tel, ad) => {
                    const num = cepWaNum(tel);
                    if (!num) { alert(`${ad || 'Personel'} için telefon kayıtlı değil (Personel kaydına telefon ekle).`); return; }
                    window.open(`https://wa.me/${num}?text=${encodeURIComponent(sorMesaj(kim, ad))}`, '_blank');
                  };
                  return (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: C.t2, marginBottom: 8 }}>Uyumsuzluğu çöz — sor</div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => wa('kabul', detay.kabul_personel_tel, detay.kabul_personel_ad)} disabled={!detay.kabul_personel_ad} style={{ flex: 1, background: detay.kabul_personel_ad ? '#25D366' : C.bg, color: detay.kabul_personel_ad ? '#fff' : C.t3, border: detay.kabul_personel_ad ? 'none' : `1px solid ${C.border}`, borderRadius: 10, padding: '11px 0', fontSize: 13, fontWeight: 800, cursor: detay.kabul_personel_ad ? 'pointer' : 'default' }}>📲 Kabul edene sor{detay.kabul_personel_ad ? `\n${detay.kabul_personel_ad}` : ''}</button>
                        <button onClick={() => wa('sevk', detay.sevk_personel_tel, detay.sevkiyat_personel_ad)} disabled={!detay.sevkiyat_personel_ad} style={{ flex: 1, background: detay.sevkiyat_personel_ad ? C.mavi : C.bg, color: detay.sevkiyat_personel_ad ? '#fff' : C.t3, border: detay.sevkiyat_personel_ad ? 'none' : `1px solid ${C.border}`, borderRadius: 10, padding: '11px 0', fontSize: 13, fontWeight: 800, cursor: detay.sevkiyat_personel_ad ? 'pointer' : 'default' }}>📲 Sevk edene sor{detay.sevkiyat_personel_ad ? `\n${detay.sevkiyat_personel_ad}` : ''}</button>
                      </div>
                      <div style={{ fontSize: 11, color: C.t3, marginTop: 8, lineHeight: 1.5 }}>Telefonu kayıtlı personele WhatsApp açılır (senin telefonundan, hazır mesajla). Telefon yoksa Personel kaydına ekle.</div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Geri-al penceresi (10 sn) — ikinci onay yerine. Depo sevkinde geri-al yok (masaüstü). */}
      {undo && (
        <div style={{
          position: 'fixed', left: 14, right: 14, bottom: 18, zIndex: 60,
          background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 14,
          padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
        }}>
          <span style={{ fontSize: 13, color: C.t1, flex: 1 }}>
            ✓ {undo.sube_adi} → <b>{undo.ted_ad}</b> {undo.depo ? 'sevke verildi' : 'gönderildi'}
          </span>
          {!undo.depo && (
            <button onClick={geriAl} style={{
              background: 'none', border: `1px solid ${C.sari}`, borderRadius: 8,
              color: C.sari, fontWeight: 800, fontSize: 13, padding: '8px 12px', cursor: 'pointer',
            }}>↩ Geri Al</button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CepApp() {
  const [girisli, setGirisli] = useState(() => tokenGecerli());
  const [view, setView] = useState('home');
  const [sayac, setSayac] = useState({ onay: 0, odeme: 0, odemeTutar: 0, ariza: 0, kule: 0, ciro: 0, kasaUyum: 0, disKaynak: 0, belge: 0, basvuru: 0, sayimOnay: 0 });
  const [kasa, setKasa] = useState({ tutar: null, gun: null, hareketler: [] });
  const [kasaModal, setKasaModal] = useState(false);

  const sayaclariYukle = useCallback(() => {
    Promise.allSettled([
      api('/onay-kuyrugu?durum=bekliyor&limit=400'),
      api('/odeme-plani/bugun'),
      api('/kasa'),
      api('/panel'),
      api('/stok-sayim/ariza/liste?durum=acik'),
      api('/ops/siparis/kontrol-kulesi?gun=30&asama=bekliyor&limit=200'),
      api('/ciro-taslak?durum=bekliyor'),
      api('/ops/kasa-uyumsuzluk'),
      api('/belge-talep/bekleyen'),
      api('/is-basvurusu/ozet'),
      api('/stok-sayim/bekleyen-onay'),
    ]).then(([onay, odeme, kasaR, panelR, arizaR, kuleR, ciroR, kuyumR, belgeR, basvuruR, sayimR]) => {
      const onayN = (onay.status === 'fulfilled' && Array.isArray(onay.value)) ? onay.value.filter(giderOnayMi).length : 0;
      const odemeArr = (odeme.status === 'fulfilled' && Array.isArray(odeme.value)) ? odeme.value : [];
      const odemeTutar = odemeArr.reduce((s, o) => s + (Number(o.tutar) || 0), 0);
      const arizaN = (arizaR.status === 'fulfilled' && Number(arizaR.value?.toplam)) ? Number(arizaR.value.toplam) : 0;
      const kuleN = (kuleR.status === 'fulfilled') ? (Number(kuleR.value?.toplam) || 0) : 0;
      const ciroN = (ciroR.status === 'fulfilled' && Array.isArray(ciroR.value)) ? ciroR.value.length : 0;
      const kuyumN = (kuyumR.status === 'fulfilled') ? (Number(kuyumR.value?.gun_bekleyen) || 0) : 0;
      const disK = (panelR.status === 'fulfilled') ? (Number(panelR.value?.bu_ay_dis_kaynak) || 0) : 0;
      const belgeN = (belgeR.status === 'fulfilled') ? (Number(belgeR.value?.toplam) || 0) : 0;
      const basvuruN = (basvuruR.status === 'fulfilled') ? (Number(basvuruR.value?.yeni) || 0) : 0;
      const sayimN = (sayimR.status === 'fulfilled') ? (Number(sayimR.value?.toplam) || 0) : 0;
      setSayac({ onay: onayN, odeme: odemeArr.length, odemeTutar, ariza: arizaN, kule: kuleN, ciro: ciroN, kasaUyum: kuyumN, disKaynak: disK, belge: belgeN, basvuru: basvuruN, sayimOnay: sayimN });

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
  if (view === 'ciro')
    return <CepCiroOnay onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'kasa-uyumsuzluk')
    return <CepKasaUyumsuzluk onGeri={geri} />;
  if (view === 'dis-kaynak')
    return <CepDisKaynak onGeri={geri} />;
  if (view === 'anlik-gider')
    return <CepAnlikGider onGeri={geri} />;
  if (view === 'vadeli')
    return <CepVadeli onGeri={geri} />;
  if (view === 'kartlar')
    return <CepKartlar onGeri={geri} />;
  if (view === 'onaylar')
    return <CepOnaylar onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'denetim')
    return <CepDenetim onGeri={geri} />;
  if (view === 'stok-sayim')
    return <CepStokSayim onGeri={geri} />;
  if (view === 'vardiya-takip')
    return <CepVardiyaTakip onGeri={geri} />;
  if (view === 'demirbas')
    return <CepDemirbas onGeri={geri} />;
  if (view === 'kule')
    return <CepKule onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'depolar')
    return <CepDepolar onGeri={geri} />;
  if (view === 'belge-talep')
    return <CepBelgeTalep onGeri={geri} onDegisti={sayaclariYukle} />;
  if (view === 'basvurular')
    return <CepBasvurular onGeri={geri} />;
  if (view === 'merkez-sil')
    return <CepMerkezSil onGeri={geri} />;
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
