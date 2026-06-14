import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';

// ── Görsel Yükleme Kutusu ────────────────────────────────────────────────
function GorselYukle({ odaId, tip, baslik, aciklama, onYuklendi }) {
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState('');

  async function yukleBir(file) {
    const fd = new FormData();
    fd.append('tip', tip);
    fd.append('dosya', file);
    const res = await fetch(`/api/ev-tasarim/odalar/${odaId}/gorsel`, { method: 'POST', body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || 'Yüklenemedi');
  }

  async function yukle(files) {
    const liste = Array.from(files || []).filter(Boolean);
    if (!liste.length) return;
    setBusy(true); setHata('');
    try {
      for (const file of liste) {
        await yukleBir(file);
      }
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
      onDrop={e => { e.preventDefault(); yukle(e.dataTransfer.files); }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{baslik}</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{aciklama}</div>
      <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
        {busy ? '…' : 'Görsel Seç (birden fazla seçilebilir)'}
        <input type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => { yukle(e.target.files); e.target.value = ''; }} disabled={busy} />
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

// ── Maske Çizici ─────────────────────────────────────────────────────────
function MaskeCizici({ fotoUrl, onMaskChange }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const [boyutAyarlandi, setBoyutAyarlandi] = useState(false);
  const [fircaBoyu, setFircaBoyu] = useState(30);
  const cizimRef = useRef(false);

  function ayarlaBoyut() {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !img.naturalWidth) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    setBoyutAyarlandi(true);
  }

  function koordinat(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  function ciz(e) {
    if (!cizimRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { x, y } = koordinat(e);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(x, y, fircaBoyu / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function basla(e) {
    cizimRef.current = true;
    ciz(e);
  }

  function bitir() {
    if (!cizimRef.current) return;
    cizimRef.current = false;
    const canvas = canvasRef.current;
    // Tamamen boş mu kontrol et
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let bos = true;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) { bos = false; break; }
    }
    if (bos) { onMaskChange(null); return; }
    canvas.toBlob(blob => onMaskChange(blob), 'image/png');
  }

  function temizle() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    onMaskChange(null);
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
        Korumak istediğin eşyaların üzerini fırça ile boya — boyalı alanlar aynen
        korunur, gerisi yeniden tasarlanır.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12 }}>Fırça boyutu: {fircaBoyu}px</label>
        <input type="range" min={10} max={80} value={fircaBoyu} onChange={e => setFircaBoyu(Number(e.target.value))} />
        <button className="btn btn-secondary btn-sm" onClick={temizle}>Tümünü Temizle</button>
      </div>
      <div style={{ position: 'relative', maxWidth: 480 }}>
        <img ref={imgRef} src={fotoUrl} alt="" onLoad={ayarlaBoyut}
          style={{ width: '100%', display: 'block', borderRadius: 10, border: '1px solid var(--border)' }} />
        {boyutAyarlandi && (
          <canvas ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', cursor: 'crosshair', borderRadius: 10 }}
            onMouseDown={basla} onMouseMove={ciz} onMouseUp={bitir} onMouseLeave={bitir}
            onTouchStart={basla} onTouchMove={ciz} onTouchEnd={bitir}
          />
        )}
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
  const [urunler, setUrunler] = useState([]);
  const [oneriler, setOneriler] = useState([]);
  const [stilNotu, setStilNotu] = useState('');
  const [uretiliyor, setUretiliyor] = useState(false);
  const [hata, setHata] = useState('');
  const [maskBlob, setMaskBlob] = useState(null);
  const [maskeAcik, setMaskeAcik] = useState(false);

  async function yukle() {
    api(`/ev-tasarim/odalar/${oda.id}/gorseller?tip=foto`).then(d => setFotolar(d.gorseller || [])).catch(() => {});
    api(`/ev-tasarim/odalar/${oda.id}/gorseller?tip=referans`).then(d => setReferanslar(d.gorseller || [])).catch(() => {});
    api(`/ev-tasarim/odalar/${oda.id}/gorseller?tip=urun`).then(d => setUrunler(d.gorseller || [])).catch(() => {});
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
      const fd = new FormData();
      fd.append('stil_notu', stilNotu);
      if (maskBlob) fd.append('maske', maskBlob, 'maske.png');
      const res = await fetch(`/api/ev-tasarim/odalar/${oda.id}/tasarim-uret`, { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.detail || 'Tasarım üretilemedi');
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
        <div>
          <GorselYukle odaId={oda.id} tip="urun" baslik="🛋️ Yerleştirilecek Ürün" aciklama="Sahip olduğun/almayı planladığın ürünün fotoğrafı" onYuklendi={yukle} />
          <Galeri gorseller={urunler} onSil={gorselSil} />
        </div>
      </div>

      <div className="card mb-16" style={{ padding: 16 }}>
        <div className="form-group">
          <label>Stil Notu (opsiyonel)</label>
          <textarea rows={2} placeholder="örn. minimalist, sıcak tonlar, ahşap mobilya"
            value={stilNotu} onChange={e => setStilNotu(e.target.value)} />
        </div>

        {fotolar.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMaskeAcik(o => !o)}>
              🖌️ Korumak İstediğin Eşyaları Boya (opsiyonel) {maskeAcik ? '▲' : '▼'}
              {maskBlob ? ' · işaretlendi' : ''}
            </button>
            {maskeAcik && (
              <div style={{ marginTop: 10 }}>
                <MaskeCizici
                  key={fotolar[0]?.id}
                  fotoUrl={`/api/ev-tasarim/gorsel/${fotolar[0]?.id}`}
                  onMaskChange={setMaskBlob}
                />
              </div>
            )}
          </div>
        )}

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
  const [odalar, setOdalar] = useState([]);
  const [secili, setSecili] = useState(null);

  function odalariYukle() {
    api('/ev-tasarim/odalar').then(d => setOdalar(d.odalar || [])).catch(() => {});
  }
  useEffect(() => { odalariYukle(); }, []);

  async function odaSil(id) {
    if (!confirm('Bu odayı ve tüm görsellerini silmek istediğine emin misin?')) return;
    try {
      await api(`/ev-tasarim/odalar/${id}`, { method: 'DELETE' });
      if (secili?.id === id) setSecili(null);
      odalariYukle();
    } catch (e) { alert(e.message); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>🏠 İşletme / Dükkan Tasarımı</h2>
        <p>Mekan fotoğrafları + ölçüler + referans görsellerle AI destekli iç mimari tasarım ve maliyet tahmini.</p>
      </div>
      {secili
        ? <OdaDetay oda={secili} onGeri={() => setSecili(null)} onGuncelle={odalariYukle} />
        : <OdaListesi odalar={odalar} onSec={setSecili} onEklendi={odalariYukle} onSil={odaSil} />}
    </div>
  );
}
