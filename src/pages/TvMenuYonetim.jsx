import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const TV_URL = 'https://evvel-erp-production.up.railway.app/tv-menu';

export default function TvMenuYonetim() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState('');
  const [yeni, setYeni] = useState({ kategori: '', ad: '', aciklama: '', f8: '', f14: '', fice: '' });
  const [ayar, setAyar] = useState(null);
  const [evo, setEvo] = useState(null);
  const [kurgu, setKurgu] = useState(null);   // 🎬 portre /tv-portre sahne dizisi
  const [klipler, setKlipler] = useState([]); // kullanılabilir video klipleri
  const [katList, setKatList] = useState([]); // menü kategori adları

  const yukle = useCallback(() => {
    api('/tv-menu/liste')
      .then(r => setListe(Array.isArray(r) ? r : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
    api('/tv-ayar').then(setAyar).catch(() => {});
    api('/tv-portre/kurgu').then(d => { setKurgu(d.slots || []); setKlipler(d.klipler || []); }).catch(() => setKurgu([]));
    api('/tv-menu').then(d => setKatList((d.kategoriler || []).map(k => k.kategori))).catch(() => {});
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  // ── 🎬 KURGU EDİTÖRÜ yardımcıları (E2) ──
  const PORTRE_URL = 'https://evvel-erp-production.up.railway.app/tv-portre';
  const bosSlot = () => ({ sure: 5000, e1: { menu: katList[0] || '' }, e2: { v: klipler[0] || '', k: '', b: '' }, e3: { menu: katList[0] || '' } });
  const icSet = (i, ek, alan, deger) => setKurgu(k => k.map((s, j) => j === i ? { ...s, [ek]: { ...s[ek], [alan]: deger } } : s));
  const tipSet = (i, ek, tip) => setKurgu(k => k.map((s, j) => j !== i ? s : { ...s, [ek]:
    tip === 'menu' ? { menu: katList[0] || '' }
    : tip === 'spot' ? { spot: true }
    : tip === 'cok' ? { cok: true }
    : tip === 'yeni' ? { yeni: true }
    : tip === 'sezon' ? { sezon: true }
    : tip === 'hero' ? { hero: true }
    : tip === 'gunun' ? { gunun: true }
    : { v: klipler[0] || '', k: '', b: '' } }));
  const sureSet = (i, sn) => setKurgu(k => k.map((s, j) => j === i ? { ...s, sure: Math.max(2, Math.min(60, parseInt(sn) || 5)) * 1000 } : s));
  const slotTasi = (i, yon) => setKurgu(k => { const a = [...k]; const j = i + yon; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const slotSil = (i) => setKurgu(k => k.filter((_, j) => j !== i));
  const slotEkle = () => setKurgu(k => [...(k || []), bosSlot()]);
  const kurguKaydet = async () => {
    setMesgul('kurgu'); setHata(''); setBilgi('');
    try { const r = await api('/tv-portre/kurgu', { method: 'POST', body: { slots: kurgu } }); setBilgi(`✓ Kurgu yayınlandı (${r.slot_sayisi} sahne) — TV'yi yenile, güncellenir.`); }
    catch (e) { setHata(e.message || 'Kaydedilemedi (geçersiz kurgu?)'); }
    finally { setMesgul(''); }
  };
  const kurguSifirla = async () => {
    if (!window.confirm('Kurgu varsayılana (hazır 7 sahne) dönsün mü? Kaydettiklerin silinir.')) return;
    setMesgul('kurgu');
    try { await api('/tv-portre/kurgu-sifirla', { method: 'POST' }); const d = await api('/tv-portre/kurgu'); setKurgu(d.slots || []); setBilgi('✓ Varsayılana dönüldü.'); }
    catch (e) { setHata(e.message || 'Olmadı'); }
    finally { setMesgul(''); }
  };

  const ayarKaydet = async () => {
    setMesgul('ayar'); setHata(''); setBilgi('');
    try {
      await api('/tv-ayar', { method: 'POST', body: ayar });
      setBilgi('✓ Yaşayan menü ayarları kaydedildi');
    } catch (e) { setHata(e.message || 'Kaydedilemedi'); }
    finally { setMesgul(''); }
  };

  const evoCek = async () => {
    setMesgul('evo'); setHata(''); setBilgi(''); setEvo(null);
    try {
      const r = await api('/tv-menu/evo-fiyat-oneri?gun=30');
      setEvo(r);
      if (!r.oneri_sayisi) setBilgi('Evo bağlandı ama eşleşen ürün gelmedi (token/veri yok olabilir).');
    } catch (e) { setHata(e.message || 'Evo fiyatı alınamadı (token gerekebilir)'); }
    finally { setMesgul(''); }
  };
  const evoUygula = async () => {
    setMesgul('evo2'); setHata(''); setBilgi('');
    try {
      const r = await api('/tv-menu/evo-fiyat-uygula?gun=30', { method: 'POST' });
      setBilgi(`✓ Evo fiyatları uygulandı — ${r.degisen_sayisi} değişiklik`);
      setEvo(null); yukle();
    } catch (e) { setHata(e.message || 'Uygulanamadı'); }
    finally { setMesgul(''); }
  };

  const setSatir = (id, alan, deger) => {
    setListe(l => l.map(x => x.id === id ? { ...x, [alan]: deger } : x));
  };

  const numOrNull = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const kaydet = async (it) => {
    setMesgul(it.id); setHata(''); setBilgi('');
    try {
      await api(`/tv-menu/urun/${it.id}`, {
        method: 'PUT',
        body: {
          kategori: it.kategori, ad: it.ad, aciklama: it.aciklama || null,
          f8: numOrNull(it.f8), f14: numOrNull(it.f14), fice: numOrNull(it.fice),
          sira: it.sira || 0, aktif: it.aktif !== false, yeni: it.yeni === true,
        },
      });
      setBilgi(`✓ ${it.ad} kaydedildi — TV ~1 dk içinde güncellenir`);
    } catch (e) { setHata(e.message || 'Kaydedilemedi'); }
    finally { setMesgul(''); }
  };

  const sil = async (it) => {
    if (!window.confirm(`${it.ad} silinsin mi?`)) return;
    setMesgul(it.id);
    try { await api(`/tv-menu/urun/${it.id}`, { method: 'DELETE' }); yukle(); setBilgi('Silindi.'); }
    catch (e) { setHata(e.message || 'Silinemedi'); }
    finally { setMesgul(''); }
  };

  const ekle = async () => {
    if (!yeni.kategori.trim() || !yeni.ad.trim()) { setHata('Kategori ve ad zorunlu'); return; }
    setMesgul('yeni'); setHata('');
    try {
      await api('/tv-menu/urun', {
        method: 'POST',
        body: {
          kategori: yeni.kategori.trim(), ad: yeni.ad.trim(), aciklama: yeni.aciklama.trim() || null,
          f8: numOrNull(yeni.f8), f14: numOrNull(yeni.f14), fice: numOrNull(yeni.fice), sira: 999,
        },
      });
      setYeni({ kategori: yeni.kategori, ad: '', aciklama: '', f8: '', f14: '', fice: '' });
      setBilgi('Ürün eklendi.'); yukle();
    } catch (e) { setHata(e.message || 'Eklenemedi'); }
    finally { setMesgul(''); }
  };

  const inp = { width: '100%', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', color: 'var(--text1)', fontSize: 14, boxSizing: 'border-box' };
  const num = { ...inp, textAlign: 'center', fontFamily: 'var(--font-mono)' };

  // kategori gruplama
  const gruplar = {};
  (liste || []).forEach(it => { (gruplar[it.kategori] = gruplar[it.kategori] || []).push(it); });

  return (
    <div style={{ padding: '16px 18px', maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 800 }}>📺 TV Menü Yönetimi</h2>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 14 }}>
        Fiyatı değiştir → Kaydet. TV ekranı ~1 dakikada kendiliğinden güncellenir (boş bırakılan fiyat menüde “–” görünür).
      </div>

      {/* TV linki */}
      <div className="card" style={{ padding: '12px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text2)' }}>📺 TV linki:</span>
        <code style={{ fontSize: 13, color: 'var(--accent)', wordBreak: 'break-all' }}>{TV_URL}</code>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-sm btn-secondary" onClick={() => { navigator.clipboard?.writeText(TV_URL); setBilgi('Link kopyalandı'); }}>Kopyala</button>
          <a className="btn btn-sm btn-primary" href={TV_URL} target="_blank" rel="noreferrer">Aç (TV)</a>
        </div>
      </div>

      {/* 🎬 KURGU EDİTÖRÜ (İŞ 2 · E2) — dikey /tv-portre sahne dizisi */}
      <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--green)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>🎬 Kurgu Editörü <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>· dikey pano: sahne sırası · klip · süre · yazı</span></div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {['1', '2', '3'].map(n => <a key={n} className="btn btn-sm btn-secondary" href={`${PORTRE_URL}?ekran=${n}`} target="_blank" rel="noreferrer">TV{n}</a>)}
          </div>
        </div>
        {kurgu === null ? <div style={{ fontSize: 12, color: 'var(--text3)' }}>Yükleniyor…</div> : (
          <>
            {kurgu.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--bg2, var(--bg))' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>Sahne {i + 1}</b>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>süre(sn) <input type="number" min="2" max="60" value={Math.round((s.sure || 5000) / 1000)} onChange={e => sureSet(i, e.target.value)} style={{ width: 54 }} /></label>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => slotTasi(i, -1)} disabled={i === 0}>▲</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => slotTasi(i, 1)} disabled={i === kurgu.length - 1}>▼</button>
                    <button className="btn btn-sm btn-danger" onClick={() => slotSil(i)}>🗑</button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                  {[['e1', '1 · Menü/karar'], ['e2', '2 · Deneyim'], ['e3', '3 · İmza']].map(([ek, lbl]) => {
                    const ic = s[ek] || {}; const tip = ic.spot ? 'spot' : ic.cok ? 'cok' : ic.yeni ? 'yeni' : ic.sezon ? 'sezon' : ic.hero ? 'hero' : ic.gunun ? 'gunun' : (ic.menu != null ? 'menu' : 'video');
                    const OTO = { spot: 'İmza ürün + fiyat + “yanına yakışır” otomatik. İmza/pair’i Yaşayan Menü Ayarları’ndan seç.', cok: '🏆 Bu hafta en çok satılan 3 ürün — canlı satış verisinden otomatik.', yeni: '✨ Menüye yeni eklenen ürünler — canlı veriden otomatik.', sezon: '☀️ Mevsim/saate göre öneri (yazın buzlu, kışın sıcak) — canlı, fiyatsız fısıltı.', hero: '🥤 Haftanın en çok seçileni — bardak görseli + tat notu, FİYATSIZ (vaat sahnesi).', gunun: '⭐ Günün seçimi — fiyat İLK KEZ burada + “yanına yakışır” köprüsü (satış zirvesi).' };
                    return (
                      <div key={ek} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4 }}>Ekran {lbl}</div>
                        <select value={tip} onChange={e => tipSet(i, ek, e.target.value)} style={{ width: '100%', fontSize: 11, marginBottom: 4 }}>
                          <option value="menu">📋 Menü sayfası</option><option value="video">🎬 Video sahne</option><option value="spot">★ İmza spotlight</option>
                          <option value="cok">🏆 En çok satılan</option><option value="yeni">✨ Yeni ürünler</option><option value="sezon">☀️ Mevsim/saat</option>
                          <option value="hero">🥤 Kahraman ürün</option><option value="gunun">⭐ Günün seçimi</option>
                        </select>
                        {tip === 'menu'
                          ? <select value={ic.menu || ''} onChange={e => icSet(i, ek, 'menu', e.target.value)} style={{ width: '100%', fontSize: 11 }}>{katList.map(c => <option key={c} value={c}>{c}</option>)}</select>
                          : OTO[tip]
                          ? <div style={{ fontSize: 10.5, color: 'var(--text3)', lineHeight: 1.4 }}>{OTO[tip]}</div>
                          : <>
                              <select value={ic.v || ''} onChange={e => icSet(i, ek, 'v', e.target.value)} style={{ width: '100%', fontSize: 11, marginBottom: 3 }}>{klipler.map(c => <option key={c} value={c}>{c.replace('tulipi_', '')}</option>)}</select>
                              <input placeholder="üst yazı (kicker)" value={ic.k || ''} onChange={e => icSet(i, ek, 'k', e.target.value)} style={{ width: '100%', fontSize: 11, marginBottom: 3 }} />
                              <input placeholder="ana yazı (beat)" value={ic.b || ''} onChange={e => icSet(i, ek, 'b', e.target.value)} style={{ width: '100%', fontSize: 11 }} />
                            </>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <button className="btn btn-sm btn-secondary" onClick={slotEkle}>+ Sahne Ekle</button>
              <button className="btn btn-sm btn-primary" onClick={kurguKaydet} disabled={mesgul === 'kurgu'}>💾 Kaydet & Yayınla</button>
              <button className="btn btn-sm btn-ghost" onClick={kurguSifirla} disabled={mesgul === 'kurgu'}>↺ Varsayılana Dön</button>
              <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>Kaydedince TV'yi yenile. Bozuk kurgu reddedilir (TV kararmaz).</span>
            </div>
          </>
        )}
      </div>

      {/* 3 EKRAN MODU (Faz 4) */}
      <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>🖥️ 3 Ekran Modu (opsiyonel)</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
          Tek TV varsa üstteki linki kullan (her şey döner). 3 TV yan yana ise her birine farklı rol ver:
        </div>
        {[
          { n: '1', ad: 'MARKA + HERO', desc: 'Marka, Coffee Story, top seller ve sosyal kanit', emoji: '🎬' },
          { n: '2', ad: 'ANA KAHVE MENU', desc: 'Classic + Signature kahve fiyat referansi', emoji: '📋' },
          { n: '3', ad: 'UPSELL + SOGUK', desc: 'Soguk icecek, tatli, kombin ve kampanya sahneleri', emoji: '✨' },
        ].map((e) => {
          const url = `${TV_URL}?ekran=${e.n}`;
          return (
            <div key={e.n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 18 }}>{e.emoji}</span>
              <div style={{ minWidth: 150 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Ekran {e.n} · {e.ad}</div>
                <div style={{ fontSize: 11, color: 'var(--text2)' }}>{e.desc}</div>
              </div>
              <code style={{ fontSize: 12, color: 'var(--accent)', wordBreak: 'break-all', flex: 1 }}>{url}</code>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-secondary" onClick={() => { navigator.clipboard?.writeText(url); setBilgi(`Ekran ${e.n} linki kopyalandı`); }}>Kopyala</button>
                <a className="btn btn-sm btn-primary" href={url} target="_blank" rel="noreferrer">Aç</a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Evo'dan fiyat çek (öneri → uygula) */}
      <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid #d4a843' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>📥 Evo'dan Fiyat Çek</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
          Evo satışlarından güncel liste fiyatını hesaplar (KDV dahil) ve menünle karşılaştırır. <b>Önce göster, sonra uygula</b> — otomatik ezmez.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-secondary" onClick={evoCek} disabled={mesgul === 'evo'}>
            {mesgul === 'evo' ? 'Çekiliyor…' : '🔍 Evo Fiyatlarını Getir'}
          </button>
          {evo && evo.oneri_sayisi > 0 && (
            <button className="btn btn-sm btn-primary" onClick={evoUygula} disabled={mesgul === 'evo2'}>
              {mesgul === 'evo2' ? 'Uygulanıyor…' : `✅ Uygula (${evo.oneri_sayisi} eşleşme)`}
            </button>
          )}
        </div>
        {evo && evo.oneriler && evo.oneriler.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {evo.oneriler.map((o, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, padding: '4px 0', borderTop: '1px solid var(--border)', alignItems: 'center' }}>
                <span style={{ flex: 1 }}>{o.menu_ad} <span style={{ color: 'var(--text3)', fontSize: 11 }}>({o.kolon === 'fice' ? 'Ice' : o.kolon === 'f14' ? '14oz' : '8oz'})</span></span>
                <span style={{ color: 'var(--text2)' }}>{o.mevcut == null ? '—' : o.mevcut}</span>
                <span style={{ color: 'var(--text3)' }}>→</span>
                <span style={{ fontWeight: 700, color: o.fark === 0 ? 'var(--green)' : '#d4a843' }}>{o.evo}{o.fark === 0 ? ' ✓' : (o.fark != null ? ` (${o.fark > 0 ? '+' : ''}${o.fark})` : '')}</span>
              </div>
            ))}
            {evo.eslesmeyen && evo.eslesmeyen.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)' }}>Evo'da olup menüde olmayan: {evo.eslesmeyen.join(', ')}</div>
            )}
          </div>
        )}
      </div>

      {bilgi && <div className="alert-box" style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--green)', marginBottom: 12, padding: 10, borderRadius: 8, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div className="alert-box red" style={{ marginBottom: 12 }}>{hata}</div>}

      {/* Yaşayan Menü Ayarları (Faz 2) */}
      {ayar && (
        <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--green)' }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>🌿 Yaşayan Menü — alt şerit ayarları</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>TV ekranının altında dönen canlı bilgiler. Saat-modu (sabah/öğle/akşam) otomatik gelir.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>🔥 Öne çıkan ürün</div>
              <input style={inp} placeholder="ör. Latte" value={ayar.one_cikan || ''} onChange={e => setAyar({ ...ayar, one_cikan: e.target.value })} disabled={ayar.one_cikan_oto} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text3)', marginTop: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!ayar.one_cikan_oto} onChange={e => setAyar({ ...ayar, one_cikan_oto: e.target.checked })} style={{ accentColor: 'var(--green)' }} />
                Evo satışından otomatik seç
              </label>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>⏰ Happy Hour</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text3)', marginBottom: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!ayar.hh_aktif} onChange={e => setAyar({ ...ayar, hh_aktif: e.target.checked })} style={{ accentColor: 'var(--green)' }} />
                Aktif
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input style={{ ...num, width: 56 }} type="number" min={0} max={23} value={ayar.hh_bas ?? 14} onChange={e => setAyar({ ...ayar, hh_bas: parseInt(e.target.value, 10) })} />
                <span style={{ color: 'var(--text3)' }}>–</span>
                <input style={{ ...num, width: 56 }} type="number" min={0} max={23} value={ayar.hh_bit ?? 16} onChange={e => setAyar({ ...ayar, hh_bit: parseInt(e.target.value, 10) })} />
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>saat</span>
              </div>
              <input style={{ ...inp, marginTop: 6 }} placeholder="Mesaj (ör. 2. kahve bizden)" value={ayar.hh_mesaj || ''} onChange={e => setAyar({ ...ayar, hh_mesaj: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 5, fontWeight: 600 }}>⭐ İmza Ürünü (TV'de spotlight sayfası)</div>
              <input style={inp} list="tvUrunler" placeholder="ör. Caramel Macchiato (boş = kapalı)" value={ayar.imza_urun || ''} onChange={e => setAyar({ ...ayar, imza_urun: e.target.value })} />
              <datalist id="tvUrunler">{(liste || []).map(it => <option key={it.id} value={it.ad} />)}</datalist>
              <input style={{ ...inp, marginTop: 6 }} placeholder="Açıklama / slogan (taze süt köpüğü…)" value={ayar.imza_aciklama || ''} onChange={e => setAyar({ ...ayar, imza_aciklama: e.target.value })} />
            </div>
          </div>
          <button className="btn btn-sm btn-primary" style={{ marginTop: 12 }} disabled={mesgul === 'ayar'} onClick={ayarKaydet}>{mesgul === 'ayar' ? 'Kaydediliyor…' : 'Ayarları Kaydet'}</button>
        </div>
      )}

      {liste === null && <div style={{ color: 'var(--text3)', padding: 20 }}>Yükleniyor…</div>}

      {Object.entries(gruplar).map(([kat, items]) => (
        <div key={kat} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', margin: '6px 2px 8px' }}>{kat}</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.1fr 62px 62px 62px 54px 120px', gap: 8, padding: '8px 12px', fontSize: 11, color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>
              <span>Ürün</span><span>Açıklama</span><span style={{ textAlign: 'center' }}>8oz</span><span style={{ textAlign: 'center' }}>14oz</span><span style={{ textAlign: 'center' }}>Ice</span><span style={{ textAlign: 'center' }}>✨Yeni</span><span></span>
            </div>
            {items.map(it => (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.1fr 62px 62px 62px 54px 120px', gap: 8, padding: '8px 12px', alignItems: 'center', borderTop: '1px solid var(--border)' }}>
                <input style={inp} value={it.ad || ''} onChange={e => setSatir(it.id, 'ad', e.target.value)} />
                <input style={inp} value={it.aciklama || ''} placeholder="—" onChange={e => setSatir(it.id, 'aciklama', e.target.value)} />
                <input style={num} value={it.f8 ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'f8', e.target.value)} />
                <input style={num} value={it.f14 ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'f14', e.target.value)} />
                <input style={num} value={it.fice ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'fice', e.target.value)} />
                <div style={{ textAlign: 'center' }}><input type="checkbox" checked={it.yeni === true} onChange={e => setSatir(it.id, 'yeni', e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--green)', cursor: 'pointer' }} /></div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-sm btn-primary" disabled={mesgul === it.id} onClick={() => kaydet(it)}>{mesgul === it.id ? '…' : 'Kaydet'}</button>
                  <button className="btn btn-sm btn-danger" disabled={mesgul === it.id} onClick={() => sil(it)}>Sil</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Yeni ürün */}
      <div className="card" style={{ padding: 14, marginTop: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>+ Yeni Ürün</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1.2fr 70px 70px 70px', gap: 8, alignItems: 'center' }}>
          <input style={inp} list="tvKats" placeholder="Kategori" value={yeni.kategori} onChange={e => setYeni({ ...yeni, kategori: e.target.value })} />
          <datalist id="tvKats">{Object.keys(gruplar).map(k => <option key={k} value={k} />)}</datalist>
          <input style={inp} placeholder="Ürün adı" value={yeni.ad} onChange={e => setYeni({ ...yeni, ad: e.target.value })} />
          <input style={inp} placeholder="Açıklama (ops.)" value={yeni.aciklama} onChange={e => setYeni({ ...yeni, aciklama: e.target.value })} />
          <input style={num} placeholder="8oz" value={yeni.f8} onChange={e => setYeni({ ...yeni, f8: e.target.value })} />
          <input style={num} placeholder="14oz" value={yeni.f14} onChange={e => setYeni({ ...yeni, f14: e.target.value })} />
          <input style={num} placeholder="Ice" value={yeni.fice} onChange={e => setYeni({ ...yeni, fice: e.target.value })} />
        </div>
        <button className="btn btn-sm btn-primary" style={{ marginTop: 10 }} disabled={mesgul === 'yeni'} onClick={ekle}>{mesgul === 'yeni' ? 'Ekleniyor…' : 'Ekle'}</button>
      </div>
    </div>
  );
}
