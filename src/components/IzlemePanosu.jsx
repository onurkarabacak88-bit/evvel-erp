import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { trT } from './CariEkstrePanel';

// ── 📈 İZLEME PANOSU (2026-07-19, sahip: "sipariş-ver örüntüsüne bak, bu
// tasarımı kullan — tıklayınca içeriğini göreyim: Haziran 1'de 15 TL idi,
// Temmuz 10'da 17 TL oldu; SOL HATTAKİ SON YÜKSELENLER KALSIN").
// Desen = şube paneli sipariş-ver akışı: önce EMOJİ'Lİ KATEGORİ KARTLARI,
// kategoriye tıkla → ürün kutucukları, ürüne tıkla → sağda fiyat zinciri.
// Sol rail (Son Yükselenler) sabit. Yeni izleme görünümü = GORUNUMLER'e kayıt.
const GORUNUMLER = [
  { id: 'fiyat', ad: '🏷️ Fiyat Artışları' },
  { id: 'depo', ad: '📦 Depo & Düşüm' },
];

const DONEMLER = [['7', 'Son 7 gün'], ['30', 'Son 30 gün'], ['90', 'Son 90 gün'], ['tumu', 'Tümü']];

export default function IzlemePanosu() {
  const [gorunum, setGorunum] = useState('fiyat');
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [donem, setDonem] = useState('tumu');   // varsayılan TÜMÜ — bütün ürünler görünür
  const [kat, setKat] = useState(null);         // seçili kategori (null = kategori kartları)
  const [ara, setAra] = useState('');
  const [secili, setSecili] = useState(null);   // kalem_kodu
  useEffect(() => {
    api('/ops/maliyet/fiyat-izleme').then(setD).catch(e => setHata(e?.message || 'yüklenemedi'));
  }, []);
  // 📦 depo görünümü — tembel yükleme (sekmeye geçince 1 kez)
  const [dd, setDd] = useState(null);
  useEffect(() => {
    if (gorunum !== 'depo' || dd !== null) return;
    api('/ops/maliyet/depo-izleme').then(setDd).catch(() => setDd({ hata: true }));
  }, [gorunum, dd]);

  if (hata) return <div className="card" style={{ padding: 14, color: 'var(--red)' }}>{hata}</div>;
  if (!d) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>📈 İzleme panosu yükleniyor…</div>;

  const esik = d.zam_esik_yuzde || 10;
  const M = 'var(--font-mono)';
  const kesit = donem === 'tumu' ? '' : new Date(Date.now() - Number(donem) * 86400000).toISOString().slice(0, 10);
  const tumu = d.kalemler || [];
  const donemli = donem === 'tumu' ? tumu
    : tumu.filter(k => k.son_degisim && k.son_degisim >= kesit);
  const aranan = ara.trim().toLowerCase();
  const seciliK = tumu.find(k => k.kalem_kodu === secili) || null;

  // Kategori grupları (sipariş-ver kalıbı) — sıra: kategori sira → ad
  const katMap = new Map();
  for (const k of donemli) {
    const anahtar = k.kategori || 'Diğer';
    if (!katMap.has(anahtar)) katMap.set(anahtar, { ad: anahtar, emoji: k.kategori_emoji || '📦', sira: k.kategori_sira ?? 999, urunler: [] });
    katMap.get(anahtar).urunler.push(k);
  }
  const katListe = [...katMap.values()].sort((a, b) => (a.sira - b.sira) || a.ad.localeCompare(b.ad, 'tr'));

  const urunSirala = (arr) => arr.slice().sort((a, b) => {
    const aa = (a.degisim_pct || 0) >= esik ? 1 : 0, bb = (b.degisim_pct || 0) >= esik ? 1 : 0;
    if (aa !== bb) return bb - aa;                                    // eşik üstü zam önce
    const at = a.son_degisim || '', bt = b.son_degisim || '';
    if (at !== bt) return bt.localeCompare(at);                       // son değişim desc
    if (!!a.fiyat_yok !== !!b.fiyat_yok) return a.fiyat_yok ? 1 : -1; // fiyatsızlar sonda
    return (a.kalem_adi || '').localeCompare(b.kalem_adi || '', 'tr');
  });

  // Arama aktifse kategori atlanır — tüm ürünlerde arar
  const aramaSonuc = aranan
    ? urunSirala(donemli.filter(k => (k.kalem_adi || '').toLowerCase().includes(aranan)))
    : null;
  const seciliKat = kat ? katMap.get(kat) : null;

  const rozet = (k) => {
    if (k.fiyat_yok) return <span title="Hiç fiyat kaydı yok — maliyette 0 sayılıyor!"
      style={{ fontSize: 10.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>fiyat yok ⚠</span>;
    const pct = k.degisim_pct;
    if (pct == null) return <span style={{ fontSize: 11, color: 'var(--text3)' }}>=</span>;
    if (k.sicrama) return <span title="Birim/veri değişimi olabilir — gerçek zam sayılmaz"
      style={{ fontSize: 11.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>⚠ sıçrama</span>;
    const artis = pct > 0;
    return <span style={{ fontSize: 11.5, fontWeight: 800, whiteSpace: 'nowrap',
                          color: artis ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
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

  const urunKutusu = (k) => {
    const seciliMi = secili === k.kalem_kodu;
    const alarm = (k.degisim_pct || 0) >= esik && !k.sicrama;
    return (
      <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
        style={{ minHeight: 104, padding: '11px 12px', borderRadius: 14, cursor: 'pointer',
                 background: 'var(--bg2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                 border: `1px solid ${seciliMi ? 'var(--accent, #c9853f)' : alarm ? 'var(--red, #ef4444)' : k.fiyat_yok ? 'rgba(245,158,11,.55)' : 'var(--border)'}`,
                 borderStyle: k.fiyat_yok ? 'dashed' : 'solid',
                 boxShadow: seciliMi ? '0 0 0 1px var(--accent, #c9853f)' : undefined }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {k.kalem_adi}
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 15 }}>
              {k.fiyat_yok ? '—' : fmt(k.guncel_fiyat)}
            </span>
            {rozet(k)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>
            {k.fiyat_yok ? 'fiyat girilmemiş' : k.son_degisim ? `son değişim ${trT(k.son_degisim)}` : 'değişim yok'}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* KABUK BAŞLIĞI — görünüm pilleri + dönem + arama */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>📈 İzleme Panosu</span>
          {GORUNUMLER.map(g => chip(gorunum === g.id, () => setGorunum(g.id), g.ad))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={ara} onChange={e => setAra(e.target.value)} placeholder="🔍 ürün ara…"
            style={{ width: 160, height: 28, padding: '0 10px', borderRadius: 14, fontSize: 12,
                     background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)' }} />
          {DONEMLER.map(([k, lbl]) => chip(donem === k, () => setDonem(k), lbl, true))}
        </div>
      </div>

      {gorunum === 'fiyat' && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* SOL RAIL — Son Yükselenler (sahip: 'sol hattaki kalsın!') */}
          <div className="card" style={{ flex: '0 1 280px', minWidth: 245, padding: 12 }}>
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
                  {rozet(k)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: M }}>{fmt(k.guncel_fiyat)}</span>
                  <span>{trT(k.son_degisim)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ORTA — SİPARİŞ-VER ÖRÜNTÜSÜ: kategori kartları → ürün kutucukları */}
          <div style={{ flex: '1 1 380px', minWidth: 320 }}>
            {aramaSonuc ? (
              <>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
                  🔍 "{ara}" — {aramaSonuc.length} ürün
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                  {aramaSonuc.map(urunKutusu)}
                </div>
              </>
            ) : !seciliKat ? (
              <>
                {donem !== 'tumu' && (
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8 }}>
                    Yalnız bu dönemde fiyatı değişen ürünler gösteriliyor — hepsini görmek için "Tümü".
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                  {katListe.map(kt => {
                    const zamli = kt.urunler.filter(u => (u.degisim_pct || 0) > 0 && !u.sicrama).length;
                    const fiyatsiz = kt.urunler.filter(u => u.fiyat_yok).length;
                    return (
                      <div key={kt.ad} onClick={() => setKat(kt.ad)}
                        style={{ minHeight: 96, padding: '12px 12px', borderRadius: 14, cursor: 'pointer',
                                 background: 'var(--bg2)', border: `1px solid ${zamli > 0 ? 'rgba(239,68,68,.5)' : 'var(--border)'}`,
                                 display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                        <div style={{ fontSize: 22 }}>{kt.emoji}</div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800 }}>{kt.ad}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                            {kt.urunler.length} ürün
                            {zamli > 0 && <b style={{ color: 'var(--red, #ef4444)' }}> · {zamli} zam</b>}
                            {fiyatsiz > 0 && <b style={{ color: '#f59e0b' }}> · {fiyatsiz} fiyatsız</b>}
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
                  <span style={{ fontWeight: 800, fontSize: 13.5 }}>{seciliKat.emoji} {seciliKat.ad}
                    <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text3)' }}> · {seciliKat.urunler.length} ürün</span>
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                  {urunSirala(seciliKat.urunler).map(urunKutusu)}
                </div>
              </>
            )}
          </div>

          {/* SAĞ — SEÇİLİ ÜRÜNÜN FİYAT DEĞİŞİMİ (tarih sıralı bloklar) */}
          <div className="card" style={{ flex: '0 1 380px', minWidth: 295, padding: 14 }}>
            {!seciliK && (
              <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
                👈 Bir ürüne tıkla — fiyat değişimi burada tarih sırasıyla açılır
                (örn. "1 Haziran 15 ₺ → 10 Temmuz 17 ₺").
              </div>
            )}
            {seciliK && seciliK.fiyat_yok && (
              <div>
                <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>{seciliK.kalem_adi}</div>
                <div style={{ fontSize: 12.5, color: '#f59e0b', lineHeight: 1.5 }}>
                  ⚠ Bu ürünün hiç fiyat kaydı yok — her ürün-aç tıklaması maliyete <b>0 ₺</b> yazıyor,
                  net kâr olduğundan iyi görünüyor. Faturası onaylandığında fiyat kendiliğinden oluşur;
                  ya da 🏷️ Fiyatlar sekmesinden elle girilebilir.
                </div>
              </div>
            )}
            {seciliK && !seciliK.fiyat_yok && (() => {
              const z = seciliK.zincir || [];
              const ilk = z[0], son = z[z.length - 1];
              const toplamPct = (ilk && son && ilk.fiyat > 0)
                ? ((son.fiyat - ilk.fiyat) / ilk.fiyat) * 100 : null;
              const k90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
              const artis90 = z.filter(x => (x.degisim_pct || 0) > 0 && x.bas >= k90).length;
              return (
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 2 }}>
                    {seciliK.kategori_emoji} {seciliK.kalem_adi}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
                    Güncel <b style={{ fontFamily: M, color: 'var(--text)' }}>{fmt(seciliK.guncel_fiyat)}</b>
                    {toplamPct != null && Math.abs(toplamPct) > 0.05 && !z.some(x => x.duzeltme || x.sicrama) && (
                      <> · ilk kayıt → bugün{' '}
                        <b style={{ color: toplamPct > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
                          {toplamPct > 0 ? '+' : ''}%{toplamPct.toFixed(1)}
                        </b></>
                    )}
                    {artis90 > 0 && <> · son 90 günde {artis90} artış</>}
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
