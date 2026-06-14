import { useState, useEffect } from 'react';
import { api } from '../utils/api';

// ── Şifre Kapısı (CFO Panel ile aynı şifre, kalıcı oturum yok) ─────────────
function GirisKapisi({ onBasarili }) {
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);

  const girisYap = async (e) => {
    e.preventDefault();
    setHata('');
    setYukleniyor(true);
    try {
      const res = await api('/admin-giris', { method: 'POST', body: { sifre } });
      if (res?.ok) onBasarili();
    } catch (e2) {
      setHata(e2.message || 'Şifre yanlış');
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg1, #0f1117)', fontFamily: 'Instrument Sans, sans-serif',
    }}>
      <form onSubmit={girisYap} style={{
        width: 320, padding: 28, borderRadius: 14,
        background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2d35)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text1, #e8e9ec)', marginBottom: 4 }}>
          🏠 Ev Tasarımı
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3, #6b6f7a)', marginBottom: 20 }}>
          Devam etmek için şifre girin
        </div>
        <input
          type="password"
          autoFocus
          value={sifre}
          onChange={e => setSifre(e.target.value)}
          placeholder="Şifre"
          style={{
            width: '100%', padding: '12px 14px', borderRadius: 8, marginBottom: 12,
            border: '1px solid var(--border, #2a2d35)', background: 'var(--bg1, #0f1117)',
            color: 'var(--text1, #e8e9ec)', fontSize: 14, boxSizing: 'border-box',
          }}
        />
        {hata && <div style={{ fontSize: 12, color: '#e05c5c', marginBottom: 12 }}>{hata}</div>}
        <button type="submit" disabled={yukleniyor || !sifre} style={{
          width: '100%', padding: '12px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: '#C8956A', color: '#fff', fontWeight: 700, fontSize: 14,
          opacity: yukleniyor || !sifre ? 0.6 : 1,
        }}>
          {yukleniyor ? '…' : 'Giriş Yap'}
        </button>
      </form>
    </div>
  );
}

// ── Görsel Yükleme Kutusu ────────────────────────────────────────────────
function GorselYukle({ odaId, tip, baslik, aciklama, onYuklendi }) {
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState('');

  async function yukle(file) {
    if (!file) return;
    setBusy(true); setHata('');
    try {
      const fd = new FormData();
      fd.append('tip', tip);
      fd.append('dosya', file);
      const res = await fetch(`/api/ev-tasarim/odalar/${odaId}/gorsel`, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail || 'Yüklenemedi');
      onYuklendi();
    } catch (e) {
      setHata(e.message || 'Hata');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 14, textAlign: 'center', border: '1px dashed var(--border)' }}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); yukle(e.dataTransfer.files?.[0]); }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{baslik}</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{aciklama}</div>
      <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
        {busy ? '…' : 'Görsel Seç'}
        <input type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => yukle(e.target.files?.[0])} disabled={busy} />
      </label>
      {hata && <div className="alert-box red" style={{ marginTop: 8, fontSize: 12 }}>⚠️ {hata}</div>}
    </div>
  );
}

// ── Görsel Galerisi ──────────────────────────────────────────────────────
function Galeri({ gorseller, onSil }) {
  if (!gorseller?.length) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>Henüz görsel yok.</div>;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
      {gorseller.map(g => (
        <div key={g.id} style={{ position: 'relative', width: 120 }}>
          <img src={`/api/ev-tasarim/gorsel/${g.id}`} alt="" style={{
            width: 120, height: 90, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)',
          }} />
          {onSil && (
            <button onClick={() => onSil(g.id)} title="Sil" style={{
              position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%',
              border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', cursor: 'pointer', fontSize: 12,
            }}>✕</button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Maliyet Tablosu ──────────────────────────────────────────────────────
function MaliyetTablosu({ maliyet }) {
  if (!maliyet) return null;
  const kalemler = Array.isArray(maliyet.kalemler) ? maliyet.kalemler : [];
  return (
    <div style={{ marginTop: 10 }}>
      {kalemler.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kalem</th><th>Açıklama</th><th style={{ textAlign: 'right' }}>Min ₺</th><th style={{ textAlign: 'right' }}>Max ₺</th></tr></thead>
            <tbody>
              {kalemler.map((k, i) => (
                <tr key={i}>
                  <td>{k.ad}</td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{k.aciklama || '—'}{k.birim ? ` (${k.birim})` : ''}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{Number(k.min || 0).toLocaleString('tr-TR')}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{Number(k.max || 0).toLocaleString('tr-TR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 8, fontWeight: 700 }}>
        Toplam: {Number(maliyet.toplam_min || 0).toLocaleString('tr-TR')} ₺ – {Number(maliyet.toplam_max || 0).toLocaleString('tr-TR')} ₺
      </div>
      {maliyet.not && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>ℹ️ {maliyet.not}</div>}
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
        ⚠️ Bu tahmin AI'ın genel piyasa bilgisine dayanır, kesin teklif değildir.
      </div>
    </div>
  );
}

// ── Oda Detay ────────────────────────────────────────────────────────────
function OdaDetay({ oda, onGeri, onGuncelle }) {
  const [form, setForm] = useState({
    isim: oda.isim, genislik_m: oda.genislik_m || '', uzunluk_m: oda.uzunluk_m || '',
    yukseklik_m: oda.yukseklik_m || '', notlar: oda.notlar || '',
  });
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [fotolar, setFotolar] = useState([]);
  const [referanslar, setReferanslar] = useState([]);
  const [oneriler, setOneriler] = useState([]);
  const [stilNotu, setStilNotu] = useState('');
  const [uretiliyor, setUretiliyor] = useState(false);
  const [hata, setHata] = useState('');

  async function yukle() {
    api(`/ev-tasarim/odalar/${oda.id}/gorseller?tip=foto`).then(d => setFotolar(d.gorseller || [])).catch(() => {});
    api(`/ev-tasarim/odalar/${oda.id}/gorseller?tip=referans`).then(d => setReferanslar(d.gorseller || [])).catch(() => {});
    api(`/ev-tasarim/odalar/${oda.id}/oneriler`).then(d => setOneriler(d.oneriler || [])).catch(() => {});
  }
  useEffect(() => { yukle(); }, [oda.id]);

  async function kaydet() {
    setKaydediliyor(true); setHata('');
    try {
      await api(`/ev-tasarim/odalar/${oda.id}`, {
        method: 'PUT',
        body: {
          isim: form.isim,
          genislik_m: form.genislik_m ? parseFloat(form.genislik_m) : null,
          uzunluk_m: form.uzunluk_m ? parseFloat(form.uzunluk_m) : null,
          yukseklik_m: form.yukseklik_m ? parseFloat(form.yukseklik_m) : null,
          notlar: form.notlar,
        },
      });
      onGuncelle();
    } catch (e) { setHata(e.message); } finally { setKaydediliyor(false); }
  }

  async function gorselSil(id) {
    try {
      await api(`/ev-tasarim/gorsel/${id}`, { method: 'DELETE' });
      yukle();
    } catch (e) { setHata(e.message); }
  }

  async function tasarimUret() {
    if (!fotolar.length) { setHata('Önce odanın bir fotoğrafını yükleyin.'); return; }
    setUretiliyor(true); setHata('');
    try {
      await api(`/ev-tasarim/odalar/${oda.id}/tasarim-uret`, { method: 'POST', body: { stil_notu: stilNotu } });
      yukle();
    } catch (e) { setHata(e.message); } finally { setUretiliyor(false); }
  }

  return (
    <div>
      <button className="btn btn-secondary btn-sm" onClick={onGeri} style={{ marginBottom: 14 }}>← Oda Listesi</button>

      <div className="card mb-16" style={{ padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
          <div className="form-group"><label>Oda Adı</label>
            <input value={form.isim} onChange={e => setForm({ ...form, isim: e.target.value })} />
          </div>
          <div className="form-group"><label>Genişlik (m)</label>
            <input type="number" step="0.01" value={form.genislik_m} onChange={e => setForm({ ...form, genislik_m: e.target.value })} />
          </div>
          <div className="form-group"><label>Uzunluk (m)</label>
            <input type="number" step="0.01" value={form.uzunluk_m} onChange={e => setForm({ ...form, uzunluk_m: e.target.value })} />
          </div>
          <div className="form-group"><label>Tavan Yüksekliği (m)</label>
            <input type="number" step="0.01" value={form.yukseklik_m} onChange={e => setForm({ ...form, yukseklik_m: e.target.value })} />
          </div>
        </div>
        <div className="form-group" style={{ marginTop: 10 }}>
          <label>Notlar</label>
          <textarea rows={2} value={form.notlar} onChange={e => setForm({ ...form, notlar: e.target.value })} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={kaydediliyor} onClick={kaydet} style={{ marginTop: 8 }}>
          {kaydediliyor ? '…' : 'Ölçüleri Kaydet'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 14 }} className="mb-16">
        <div>
          <GorselYukle odaId={oda.id} tip="foto" baslik="📷 Oda Fotoğrafı" aciklama="Mevcut odanın fotoğrafını yükle" onYuklendi={yukle} />
          <Galeri gorseller={fotolar} onSil={gorselSil} />
        </div>
        <div>
          <GorselYukle odaId={oda.id} tip="referans" baslik="✨ Referans / İlham" aciklama="Beğendiğin tasarım görselleri" onYuklendi={yukle} />
          <Galeri gorseller={referanslar} onSil={gorselSil} />
        </div>
      </div>

      <div className="card mb-16" style={{ padding: 16 }}>
        <div className="form-group">
          <label>Stil Notu (opsiyonel)</label>
          <textarea rows={2} placeholder="örn. minimalist, sıcak tonlar, ahşap mobilya"
            value={stilNotu} onChange={e => setStilNotu(e.target.value)} />
        </div>
        <button className="btn btn-primary" disabled={uretiliyor} onClick={tasarimUret}>
          {uretiliyor ? <><span className="spinner" /> Üretiliyor… (20-60 sn sürebilir)</> : '🎨 Tasarım Üret'}
        </button>
        {hata && <div className="alert-box red" style={{ marginTop: 10 }}>⚠️ {hata}</div>}
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Üretilen Tasarımlar ({oneriler.length})</div>
        {!oneriler.length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>Henüz tasarım üretilmedi.</div>}
        {oneriler.map(o => (
          <div key={o.gorsel_id} style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <img src={`/api/ev-tasarim/gorsel/${o.gorsel_id}`} alt="" style={{
                width: 280, maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)',
              }} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <MaliyetTablosu maliyet={o.maliyet} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Oda Listesi ──────────────────────────────────────────────────────────
function OdaListesi({ odalar, onSec, onEklendi, onSil }) {
  const [form, setForm] = useState({ isim: '', genislik_m: '', uzunluk_m: '', yukseklik_m: '', notlar: '' });
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState('');

  async function ekle() {
    if (!form.isim.trim()) { setHata('Oda adı gerekli'); return; }
    setBusy(true); setHata('');
    try {
      await api('/ev-tasarim/odalar', {
        method: 'POST',
        body: {
          isim: form.isim,
          genislik_m: form.genislik_m ? parseFloat(form.genislik_m) : null,
          uzunluk_m: form.uzunluk_m ? parseFloat(form.uzunluk_m) : null,
          yukseklik_m: form.yukseklik_m ? parseFloat(form.yukseklik_m) : null,
          notlar: form.notlar,
        },
      });
      setForm({ isim: '', genislik_m: '', uzunluk_m: '', yukseklik_m: '', notlar: '' });
      onEklendi();
    } catch (e) { setHata(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="card mb-16" style={{ padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>+ Yeni Oda</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 }}>
          <div className="form-group"><label>Oda Adı *</label>
            <input placeholder="örn. Salon" value={form.isim} onChange={e => setForm({ ...form, isim: e.target.value })} />
          </div>
          <div className="form-group"><label>Genişlik (m)</label>
            <input type="number" step="0.01" value={form.genislik_m} onChange={e => setForm({ ...form, genislik_m: e.target.value })} />
          </div>
          <div className="form-group"><label>Uzunluk (m)</label>
            <input type="number" step="0.01" value={form.uzunluk_m} onChange={e => setForm({ ...form, uzunluk_m: e.target.value })} />
          </div>
          <div className="form-group"><label>Tavan Yüksekliği (m)</label>
            <input type="number" step="0.01" value={form.yukseklik_m} onChange={e => setForm({ ...form, yukseklik_m: e.target.value })} />
          </div>
        </div>
        <div className="form-group" style={{ marginTop: 10 }}>
          <label>Notlar</label>
          <textarea rows={2} value={form.notlar} onChange={e => setForm({ ...form, notlar: e.target.value })} />
        </div>
        {hata && <div className="alert-box red" style={{ marginTop: 8 }}>⚠️ {hata}</div>}
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={ekle} style={{ marginTop: 8 }}>
          {busy ? '…' : 'Oda Ekle'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
        {odalar.map(o => (
          <div key={o.id} className="card" style={{ padding: 16, cursor: 'pointer' }} onClick={() => onSec(o)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{o.isim}</div>
              <button onClick={(e) => { e.stopPropagation(); onSil(o.id); }} title="Sil" style={{
                border: 'none', background: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14,
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
              {[o.genislik_m && `${o.genislik_m}m`, o.uzunluk_m && `${o.uzunluk_m}m`, o.yukseklik_m && `h:${o.yukseklik_m}m`].filter(Boolean).join(' × ') || 'Ölçü girilmedi'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
              📷 {o.foto_sayisi || 0} · ✨ {o.referans_sayisi || 0} · 🎨 {o.uretilen_sayisi || 0}
            </div>
          </div>
        ))}
        {!odalar.length && <div style={{ fontSize: 13, color: 'var(--text3)' }}>Henüz oda eklenmedi.</div>}
      </div>
    </div>
  );
}

// ── Ana Sayfa ────────────────────────────────────────────────────────────
export default function EvTasarim() {
  const [girisYapildi, setGirisYapildi] = useState(false);
  const [odalar, setOdalar] = useState([]);
  const [secili, setSecili] = useState(null);

  function odalariYukle() {
    api('/ev-tasarim/odalar').then(d => setOdalar(d.odalar || [])).catch(() => {});
  }
  useEffect(() => { if (girisYapildi) odalariYukle(); }, [girisYapildi]);

  async function odaSil(id) {
    if (!confirm('Bu odayı ve tüm görsellerini silmek istediğine emin misin?')) return;
    try {
      await api(`/ev-tasarim/odalar/${id}`, { method: 'DELETE' });
      if (secili?.id === id) setSecili(null);
      odalariYukle();
    } catch (e) { alert(e.message); }
  }

  if (!girisYapildi) return <GirisKapisi onBasarili={() => setGirisYapildi(true)} />;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg1)', color: 'var(--text1)' }}>
      <div className="page" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div className="page-header">
          <h2>🏠 Ev Tasarımı</h2>
          <p>Oda fotoğrafları + ölçüler + referans görsellerle AI destekli iç mimari tasarım ve maliyet tahmini.</p>
        </div>
        {secili
          ? <OdaDetay oda={secili} onGeri={() => setSecili(null)} onGuncelle={odalariYukle} />
          : <OdaListesi odalar={odalar} onSec={setSecili} onEklendi={odalariYukle} onSil={odaSil} />}
      </div>
    </div>
  );
}
