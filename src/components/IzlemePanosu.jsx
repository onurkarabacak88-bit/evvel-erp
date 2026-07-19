import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { trT } from './CariEkstrePanel';

// ── 📈 İZLEME PANOSU (2026-07-19, sahip: "sipariş-ver örüntüsüne bak, bu
// tasarımı kullan — tıklayınca içeriğini göreyim: Haziran 1'de 15 TL idi,
// Temmuz 10'da 17 TL oldu; SOL HATTAKİ SON YÜKSELENLER KALSIN").
// Desen = şube paneli sipariş-ver akışı: önce EMOJİ'Lİ KATEGORİ KARTLARI,
// kategoriye tıkla → ürün kutucukları, ürüne tıkla → sağda fiyat zinciri.
// Sol rail (Son Yükselenler) sabit. Yeni izleme görünümü = GORUNUMLER'e kayıt.
// Fiyat Artışları görünümü FiyatPanosu.jsx'e taşındı (sahip 2026-07-19:
// 'izleme alanını ikiye böl — fiyat artışlarını Fiyat Girişi alanına kur').
// Bu pano artık DEPO İZLEME'ye adanmıştır; yeni izleme görünümü gerekirse
// buraya kayıt eklenir.
const GORUNUMLER = [
  { id: 'depo', ad: '📦 Depo & Düşüm' },
];

export default function IzlemePanosu() {
  const [gorunum, setGorunum] = useState('depo');
  const [kat, setKat] = useState(null);         // seçili kategori (null = kategori kartları)
  const [ara, setAra] = useState('');
  const [secili, setSecili] = useState(null);   // kalem_kodu
  // 📦 depo verisi — pano açılınca 1 kez
  const [dd, setDd] = useState(null);
  useEffect(() => {
    api('/ops/maliyet/depo-izleme').then(setDd).catch(() => setDd({ hata: true }));
  }, []);

  const M = 'var(--font-mono)';

  const chip = (aktif, onClick, icerik, kucuk) => (
    <button onClick={onClick}
      style={{ height: kucuk ? 26 : 30, padding: kucuk ? '0 11px' : '0 14px', borderRadius: 15,
               fontSize: kucuk ? 11.5 : 12.5, fontWeight: 700, cursor: 'pointer',
               border: `1px solid ${aktif ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
               background: aktif ? 'var(--accent, #c9853f)' : 'transparent',
               color: aktif ? '#1a120b' : 'var(--text3)' }}>{icerik}</button>
  );


  return (
    <div>
      {/* KABUK BAŞLIĞI — görünüm pilleri + dönem + arama */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>📦 Depo İzleme</span>
          {GORUNUMLER.map(g => chip(gorunum === g.id, () => setGorunum(g.id), g.ad))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={ara} onChange={e => setAra(e.target.value)} placeholder="🔍 ürün ara…"
            style={{ width: 160, height: 28, padding: '0 10px', borderRadius: 14, fontSize: 12,
                     background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)' }} />
        </div>
      </div>

      {/* ═══ 📦 DEPO & DÜŞÜM — aynı kabuk, açıklayıcı başlıklar ═══ */}
      {gorunum === 'depo' && (!dd ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>📦 Depo verisi yükleniyor…</div>
      ) : dd.hata ? (
        <div className="card" style={{ padding: 14, color: 'var(--red)' }}>Depo verisi alınamadı.</div>
      ) : (() => {
        const dtumu = dd.kalemler || [];
        const dara = ara.trim().toLowerCase();
        const dKat = new Map();
        for (const k of dtumu) {
          const a = k.kategori || 'Diğer';
          if (!dKat.has(a)) dKat.set(a, { ad: a, emoji: k.kategori_emoji || '📦', sira: k.kategori_sira ?? 999, urunler: [] });
          dKat.get(a).urunler.push(k);
        }
        const dKatListe = [...dKat.values()].sort((a, b) => (a.sira - b.sira) || a.ad.localeCompare(b.ad, 'tr'));
        const dSirala = (arr) => arr.slice().sort((a, b) => (b.dusum_7g || 0) - (a.dusum_7g || 0)
          || (b.kalan_toplam || 0) - (a.kalan_toplam || 0));
        const dAramaSonuc = dara ? dSirala(dtumu.filter(k => (k.kalem_adi || '').toLowerCase().includes(dara))) : null;
        const dSeciliKat = kat ? dKat.get(kat) : null;
        const dSecili = dtumu.find(k => k.kalem_kodu === secili) || null;
        const depoKutu = (k) => (
          <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
            style={{ minHeight: 104, padding: '11px 12px', borderRadius: 14, cursor: 'pointer',
                     background: 'var(--bg2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                     border: `1px solid ${secili === k.kalem_kodu ? 'var(--accent, #c9853f)' : k.kritik ? 'var(--red, #ef4444)' : 'var(--border)'}`,
                     boxShadow: secili === k.kalem_kodu ? '0 0 0 1px var(--accent, #c9853f)' : undefined }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {k.kalem_adi}
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 16 }}>
                  {Math.round(k.kalan_toplam)}
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)' }}> kalan</span>
                </span>
                {(k.dusum_7g || 0) > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>7g −{Math.round(k.dusum_7g)}</span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: k.kritik ? 'var(--red, #ef4444)' : 'var(--text3)', marginTop: 2 }}>
                {k.kritik ? '⚠ kritik stok (min altı)' : `30 günde −${Math.round(k.dusum_30g || 0)}`}
              </div>
            </div>
          </div>
        );
        return (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* SOL RAIL — en çok tüketilenler */}
            <div className="card" style={{ flex: '0 1 280px', minWidth: 245, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text3)', marginBottom: 2 }}>
                🔻 SON 7 GÜNDE EN ÇOK DÜŞENLER
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 6 }}>
                ürün-aç / fire / reçete çıkışları toplamı
              </div>
              {(dd.en_cok_dusen || []).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Son 7 günde çıkış kaydı yok.</div>
              )}
              {(dd.en_cok_dusen || []).map(k => (
                <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
                  style={{ padding: '8px 8px', borderRadius: 9, cursor: 'pointer', marginBottom: 2,
                           background: secili === k.kalem_kodu ? 'rgba(255,255,255,.05)' : 'transparent',
                           borderLeft: `3px solid ${k.kritik ? 'var(--red, #ef4444)' : '#f59e0b'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {k.kalem_adi}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>−{Math.round(k.dusum_7g)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>depoda {Math.round(k.kalan_toplam)}</span>
                    <span>{k.kategori}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* ORTA — kategori kartları → ürün kutucukları (kalan + düşüm) */}
            <div style={{ flex: '1 1 380px', minWidth: 320 }}>
              {dAramaSonuc ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>🔍 "{ara}" — {dAramaSonuc.length} ürün</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                    {dAramaSonuc.map(depoKutu)}
                  </div>
                </>
              ) : !dSeciliKat ? (
                <>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8 }}>
                    Kategoriye tıkla → depodaki ürünler; ürüne tıkla → sağda gün gün düşüm izi.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                    {dKatListe.map(kt => {
                      const kritik = kt.urunler.filter(u => u.kritik).length;
                      const dusum = Math.round(kt.urunler.reduce((a, u) => a + (u.dusum_7g || 0), 0));
                      return (
                        <div key={kt.ad} onClick={() => setKat(kt.ad)}
                          style={{ minHeight: 96, padding: '12px 12px', borderRadius: 14, cursor: 'pointer',
                                   background: 'var(--bg2)', border: `1px solid ${kritik > 0 ? 'rgba(239,68,68,.5)' : 'var(--border)'}`,
                                   display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                          <div style={{ fontSize: 22 }}>{kt.emoji}</div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 800 }}>{kt.ad}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                              {kt.urunler.length} ürün
                              {dusum > 0 && <b style={{ color: '#f59e0b' }}> · 7g −{dusum}</b>}
                              {kritik > 0 && <b style={{ color: 'var(--red, #ef4444)' }}> · {kritik} kritik</b>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <button onClick={() => setKat(null)} className="btn btn-secondary btn-sm">← Kategoriler</button>
                    <span style={{ fontWeight: 800, fontSize: 13.5 }}>{dSeciliKat.emoji} {dSeciliKat.ad}
                      <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text3)' }}> · {dSeciliKat.urunler.length} ürün</span>
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                    {dSirala(dSeciliKat.urunler).map(depoKutu)}
                  </div>
                </>
              )}
            </div>

            {/* SAĞ — GÜN GÜN DÜŞÜM İZİ (önceki → sonraki) */}
            <div className="card" style={{ flex: '0 1 400px', minWidth: 300, padding: 14 }}>
              {!dSecili && (
                <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
                  👈 Bir ürüne tıkla — depodaki kalan + gün gün düşüm izi burada açılır
                  (örn. "18.07 · Zafer · 13 → 12").
                </div>
              )}
              {dSecili && (
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 2 }}>
                    {dSecili.kategori_emoji} {dSecili.kalem_adi}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
                    📦 Depoda kalan <b style={{ fontFamily: M, color: 'var(--text)', fontSize: 14 }}>{Math.round(dSecili.kalan_toplam)}</b>
                    {' '}· son 7 gün <b style={{ color: '#f59e0b' }}>−{Math.round(dSecili.dusum_7g || 0)}</b>
                    {' '}· son 30 gün <b style={{ color: '#f59e0b' }}>−{Math.round(dSecili.dusum_30g || 0)}</b>
                  </div>
                  {(dSecili.sube_kirilim || []).length > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 10, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {dSecili.sube_kirilim.map((sk2, j) => (
                        <span key={j} style={{ padding: '2px 9px', borderRadius: 8, border: '1px solid var(--border)' }}>
                          {sk2.sube}: <b style={{ fontFamily: M }}>{Math.round(sk2.adet)}</b>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--text3)', marginBottom: 4 }}>
                    📉 GÜN GÜN HAREKET <span style={{ fontWeight: 400 }}>(önceki → sonraki)</span>
                  </div>
                  {(dSecili.hareketler || []).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>Son 45 günde hareket kaydı yok.</div>
                  )}
                  {(dSecili.hareketler || []).map((h, j) => {
                    const dusum2 = (h.miktar || 0) < 0 || ((h.onceki ?? 0) > (h.sonraki ?? 0));
                    return (
                      <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {trT(h.t)} {h.saat} · {h.sube}
                          <span style={{ color: 'var(--text3)' }}> · {(h.tur || '').toLowerCase().replace(/_/g, ' ')}</span>
                        </span>
                        <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700,
                                       color: dusum2 ? '#f59e0b' : 'var(--green, #22c55e)' }}>
                          {h.onceki != null && h.sonraki != null
                            ? `${Math.round(h.onceki)} → ${Math.round(h.sonraki)}`
                            : `${(h.miktar || 0) > 0 ? '+' : ''}${Math.round(h.miktar || 0)}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })())}
    </div>
  );
}
