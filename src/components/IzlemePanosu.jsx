import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { trT } from './CariEkstrePanel';

// ── 📈 İZLEME PANOSU (2026-07-19, sahip: "kalemlerin artışlarını blok blok
// görmeliyim — ürün-aç'taki kutucuk desenini kullan; tıklayınca tarih sıralı
// artış zinciri; sol tarafta en son artış yapanlar; ileride başka izlemeleri
// de aynı alanda başlık değiştirerek görmek istiyorum").
// Codex kurgusu: trading-app watchlist kalıbı — TEK kabuk: üstte görünüm
// değiştirici, sol rail (öne çıkanlar) + orta kutucuk ızgarası + sağ detay.
// Yeni izleme = GORUNUMLER'e kayıt; yeni sayfa AÇILMAZ (sadeleştirme ilkesi).
const GORUNUMLER = [
  { id: 'fiyat', ad: '🏷️ Fiyat İzleme' },
  // gelecek: { id: 'stok', ad: '📦 Stok Riski' }, { id: 'band', ad: '📈 Fiyat Bandı' }
];

const DONEMLER = [['7', 'Son 7 gün'], ['30', 'Son 30 gün'], ['90', 'Son 90 gün'], ['tumu', 'Tümü']];

export default function IzlemePanosu() {
  const [gorunum, setGorunum] = useState('fiyat');
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [donem, setDonem] = useState('90');
  const [secili, setSecili] = useState(null); // kalem_kodu
  useEffect(() => {
    api('/ops/maliyet/fiyat-izleme').then(setD).catch(e => setHata(e?.message || 'yüklenemedi'));
  }, []);

  if (hata) return <div className="card" style={{ padding: 14, color: 'var(--red)' }}>{hata}</div>;
  if (!d) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>📈 İzleme panosu yükleniyor…</div>;

  const esik = d.zam_esik_yuzde || 10;
  const M = 'var(--font-mono)';
  const kesit = donem === 'tumu' ? '' : new Date(Date.now() - Number(donem) * 86400000).toISOString().slice(0, 10);
  const tumu = d.kalemler || [];
  // Dönem filtresi: pencerede DEĞİŞİM yaşamış kalemler; 'Tümü' = hepsi (stabiller sonda)
  const kalemler = (donem === 'tumu' ? tumu
    : tumu.filter(k => k.son_degisim && k.son_degisim >= kesit))
    .slice().sort((a, b) => {
      const aa = (a.degisim_pct || 0) >= esik ? 1 : 0, bb = (b.degisim_pct || 0) >= esik ? 1 : 0;
      if (aa !== bb) return bb - aa;                                   // 1) eşik üstü artış önce
      const at = a.son_degisim || '', bt = b.son_degisim || '';
      if (at !== bt) return bt.localeCompare(at);                      // 2) son değişim tarihi desc
      return (b.degisim_pct || 0) - (a.degisim_pct || 0);              // 3) yüzde desc
    });
  const seciliK = tumu.find(k => k.kalem_kodu === secili) || null;

  const rozet = (pct, sicrama) => {
    if (pct == null) return <span style={{ fontSize: 11, color: 'var(--text3)' }}>=</span>;
    if (sicrama) return <span title="Birim/veri değişimi olabilir — gerçek zam sayılmaz"
      style={{ fontSize: 11.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>⚠ sıçrama</span>;
    const artis = pct > 0;
    const renk = artis ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)';
    return <span style={{ fontSize: 11.5, fontWeight: 800, color: renk, whiteSpace: 'nowrap' }}>
      {artis ? '↑' : '↓'} %{Math.abs(pct).toFixed(1)}
    </span>;
  };

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
      {/* KABUK BAŞLIĞI — görünüm değiştirici (watchlist kalıbı; yeni izleme = yeni pill) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>📈 İzleme Panosu</span>
          {GORUNUMLER.map(g => chip(gorunum === g.id, () => setGorunum(g.id), g.ad))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {DONEMLER.map(([k, lbl]) => chip(donem === k, () => setDonem(k), lbl, true))}
        </div>
      </div>

      {gorunum === 'fiyat' && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* SOL RAIL — Son Yükselenler */}
          <div className="card" style={{ flex: '0 1 290px', minWidth: 250, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text3)', marginBottom: 6 }}>
              🔺 SON YÜKSELENLER
            </div>
            {(d.son_yukselenler || []).length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kayıtlı fiyat artışı yok 🎉</div>
            )}
            {(d.son_yukselenler || []).map(k => (
              <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
                style={{ padding: '8px 8px', borderRadius: 9, cursor: 'pointer', marginBottom: 2,
                         background: secili === k.kalem_kodu ? 'rgba(255,255,255,.05)' : 'transparent',
                         borderLeft: `3px solid ${(k.degisim_pct || 0) >= esik ? 'var(--red, #ef4444)' : '#f59e0b'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {k.kalem_adi}
                  </span>
                  {rozet(k.degisim_pct, k.sicrama)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: M }}>{fmt(k.guncel_fiyat)}</span>
                  <span>{trT(k.son_degisim)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ORTA — KUTUCUK IZGARASI (şube paneli ürün-aç dili) */}
          <div style={{ flex: '1 1 380px', minWidth: 320 }}>
            {kalemler.length === 0 && (
              <div className="card" style={{ padding: 16, fontSize: 12.5, color: 'var(--text3)' }}>
                Bu dönemde fiyat değişimi yaşayan kalem yok — "Tümü"nü seç, bütün kalemleri gör.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              {kalemler.map(k => {
                const seciliMi = secili === k.kalem_kodu;
                const alarm = (k.degisim_pct || 0) >= esik;
                return (
                  <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
                    style={{ minHeight: 108, padding: '12px 12px', borderRadius: 14, cursor: 'pointer',
                             background: 'var(--bg2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                             border: `1px solid ${seciliMi ? 'var(--accent, #c9853f)' : alarm ? 'var(--red, #ef4444)' : 'var(--border)'}`,
                             boxShadow: seciliMi ? '0 0 0 1px var(--accent, #c9853f)' : undefined }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden',
                                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                      {k.kalem_adi}
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 15.5 }}>
                          {fmt(k.guncel_fiyat)}
                        </span>
                        {rozet(k.degisim_pct, k.sicrama)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>
                        {k.son_degisim ? `son değişim ${trT(k.son_degisim)}` : 'değişim yok'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* SAĞ — SEÇİLİ KALEMİN FİYAT ZİNCİRİ (tarih sıralı bloklar) */}
          <div className="card" style={{ flex: '0 1 400px', minWidth: 300, padding: 14 }}>
            {!seciliK && (
              <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
                👈 Bir kutucuğa (ya da soldaki listeye) tıkla — o kalemin fiyat artış zinciri
                tarih sırasıyla burada açılır.
              </div>
            )}
            {seciliK && (() => {
              const z = seciliK.zincir || [];
              const ilk = z[0], son = z[z.length - 1];
              const toplamPct = (ilk && son && ilk.fiyat > 0)
                ? ((son.fiyat - ilk.fiyat) / ilk.fiyat) * 100 : null;
              const k90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
              const artis90 = z.filter(x => (x.degisim_pct || 0) > 0 && x.bas >= k90).length;
              const enYuksek = Math.max(0, ...z.map(x => x.degisim_pct || 0));
              return (
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 2 }}>{seciliK.kalem_adi}</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                    Güncel <b style={{ fontFamily: M, color: 'var(--text)' }}>{fmt(seciliK.guncel_fiyat)}</b>
                    {toplamPct != null && Math.abs(toplamPct) > 0.05 && (
                      <> · ilk kayıt → bugün{' '}
                        <b style={{ color: toplamPct > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
                          {toplamPct > 0 ? '+' : ''}%{toplamPct.toFixed(1)}
                        </b></>
                    )}
                    {artis90 > 0 && <> · son 90 günde {artis90} artış</>}
                    {enYuksek > 0 && <> · en yüksek +%{enYuksek.toFixed(1)}</>}
                  </div>
                  {z.map((b, i) => (
                    <div key={i}>
                      {i > 0 && (b.duzeltme ? (
                        <div style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 0 3px 14px', color: 'var(--text3)' }}>
                          🔧 birim düzeltmesi (zam değil)
                        </div>
                      ) : b.sicrama ? (
                        <div style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 0 3px 14px', color: '#f59e0b' }}>
                          ⚠ %{Math.abs(b.degisim_pct || 0).toFixed(0)} sıçrama — birim/veri değişimi olabilir, zam sayılmadı
                        </div>
                      ) : (
                        <div style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 0 3px 14px',
                                      color: (b.degisim_pct || 0) > 0 ? 'var(--red, #ef4444)' : (b.degisim_pct || 0) < 0 ? 'var(--green, #22c55e)' : 'var(--text3)' }}>
                          {(b.degisim_pct || 0) > 0 ? '↑' : (b.degisim_pct || 0) < 0 ? '↓' : '='}{' '}
                          %{Math.abs(b.degisim_pct || 0).toFixed(1)}
                          {' '}({(b.fiyat - z[i - 1].fiyat) > 0 ? '+' : ''}{fmt(b.fiyat - z[i - 1].fiyat)})
                        </div>
                      ))}
                      <div style={{ padding: '9px 12px', borderRadius: 10,
                                    border: `1px solid ${i === z.length - 1 ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
                                    background: i === z.length - 1 ? 'rgba(255,255,255,.04)' : 'transparent' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
                            {trT(b.bas)} — {b.bit ? trT(b.bit) : 'bugün'}
                            {i === z.length - 1 && <b style={{ color: 'var(--accent, #c9853f)' }}> · GÜNCEL</b>}
                          </span>
                          <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 14.5 }}>
                            {fmt(b.fiyat)}
                          </span>
                        </div>
                        {(b.tedarikci || b.notlar) && (
                          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {b.tedarikci ? `${b.tedarikci}` : ''}{b.tedarikci && b.notlar ? ' · ' : ''}{b.notlar}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
