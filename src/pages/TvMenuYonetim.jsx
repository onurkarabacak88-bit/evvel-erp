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

  const yukle = useCallback(() => {
    api('/tv-menu/liste')
      .then(r => setListe(Array.isArray(r) ? r : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
    api('/tv-ayar').then(setAyar).catch(() => {});
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

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
      const r = await api('/tv-menu/evo-fiyat-oneri?gun=21');
      setEvo(r);
      if (!r.oneri_sayisi) setBilgi('Evo bağlandı ama eşleşen ürün gelmedi (token/veri yok olabilir).');
    } catch (e) { setHata(e.message || 'Evo fiyatı alınamadı (token gerekebilir)'); }
    finally { setMesgul(''); }
  };
  const evoUygula = async () => {
    setMesgul('evo2'); setHata(''); setBilgi('');
    try {
      const r = await api('/tv-menu/evo-fiyat-uygula?gun=21', { method: 'POST' });
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

      {/* 3 EKRAN MODU (Faz 4) */}
      <div className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>🖥️ 3 Ekran Modu (opsiyonel)</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10 }}>
          Tek TV varsa üstteki linki kullan (her şey döner). 3 TV yan yana ise her birine farklı rol ver:
        </div>
        {[
          { n: '1', ad: 'MENÜ', desc: 'Fiyat listesi — karar', emoji: '📋' },
          { n: '2', ad: 'DENEYİM', desc: 'Coffee Story videosu — duygu', emoji: '🎬' },
          { n: '3', ad: 'MARKA + CANLI', desc: 'Logo + imza + en çok satan', emoji: '✨' },
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
