import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

const TV_URL = 'https://evvel-erp-production.up.railway.app/tv-menu';

export default function TvMenuYonetim() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState('');
  const [yeni, setYeni] = useState({ kategori: '', ad: '', aciklama: '', f8: '', f14: '', fice: '' });

  const yukle = useCallback(() => {
    api('/tv-menu/liste')
      .then(r => setListe(Array.isArray(r) ? r : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

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
          sira: it.sira || 0, aktif: it.aktif !== false,
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

      {bilgi && <div className="alert-box" style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--green)', marginBottom: 12, padding: 10, borderRadius: 8, fontSize: 13 }}>{bilgi}</div>}
      {hata && <div className="alert-box red" style={{ marginBottom: 12 }}>{hata}</div>}

      {liste === null && <div style={{ color: 'var(--text3)', padding: 20 }}>Yükleniyor…</div>}

      {Object.entries(gruplar).map(([kat, items]) => (
        <div key={kat} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--accent)', margin: '6px 2px 8px' }}>{kat}</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 70px 70px 70px 132px', gap: 8, padding: '8px 12px', fontSize: 11, color: 'var(--text3)', borderBottom: '1px solid var(--border)' }}>
              <span>Ürün</span><span>Açıklama</span><span style={{ textAlign: 'center' }}>8oz</span><span style={{ textAlign: 'center' }}>14oz</span><span style={{ textAlign: 'center' }}>Ice</span><span></span>
            </div>
            {items.map(it => (
              <div key={it.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 70px 70px 70px 132px', gap: 8, padding: '8px 12px', alignItems: 'center', borderTop: '1px solid var(--border)' }}>
                <input style={inp} value={it.ad || ''} onChange={e => setSatir(it.id, 'ad', e.target.value)} />
                <input style={inp} value={it.aciklama || ''} placeholder="—" onChange={e => setSatir(it.id, 'aciklama', e.target.value)} />
                <input style={num} value={it.f8 ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'f8', e.target.value)} />
                <input style={num} value={it.f14 ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'f14', e.target.value)} />
                <input style={num} value={it.fice ?? ''} placeholder="–" onChange={e => setSatir(it.id, 'fice', e.target.value)} />
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
