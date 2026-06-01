import { useState } from 'react';
import { fmt } from '../utils/api';

export default function EkstreYukle() {
  const [yukleniyor, setYukleniyor] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [hata, setHata] = useState(null);
  const [dosyaAdi, setDosyaAdi] = useState('');

  async function yukle(file) {
    if (!file) return;
    setDosyaAdi(file.name); setHata(null); setSonuc(null); setYukleniyor(true);
    const fd = new FormData();
    fd.append('dosya', file);
    try {
      const res = await fetch('/api/kartlar/ekstre-yukle', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ayrıştırılamadı');
      setSonuc(data);
    } catch (e) {
      setHata(e.message || 'Hata');
    } finally { setYukleniyor(false); }
  }

  const m = sonuc?.mutabakat;
  const kart = sonuc?.eslesen_kart;
  const formatAd = { worldcard: 'Worldcard / Yapı Kredi', enpara: 'Enpara' }[sonuc?.banka_format] || sonuc?.banka_format;

  return (
    <div className="page">
      <div className="page-header">
        <h2>📄 Ekstre Yükle</h2>
        <p>Banka kredi kartı ekstresini (PDF) yükle → otomatik ayrıştır + mutabakat. <strong>Önizleme — kayıt yazılmaz.</strong></p>
      </div>

      <div className="card mb-16" style={{ padding: 20, textAlign: 'center', border: '1px dashed var(--border)' }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); yukle(e.dataTransfer.files?.[0]); }}>
        <div style={{ fontSize: 34, marginBottom: 8 }}>📥</div>
        <div style={{ color: 'var(--text2)', marginBottom: 12, fontSize: 13 }}>
          PDF ekstreyi buraya sürükle veya seç · <span style={{ color: 'var(--text3)' }}>Worldcard & Enpara desteklenir (Axess → OCR, yakında)</span>
        </div>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          PDF Seç
          <input type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
            onChange={e => yukle(e.target.files?.[0])} />
        </label>
        {dosyaAdi && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10 }}>📎 {dosyaAdi}</div>}
      </div>

      {yukleniyor && <div className="card" style={{ padding: 20, textAlign: 'center' }}><span className="spinner" /> Ayrıştırılıyor…</div>}
      {hata && <div className="alert-box red mb-16">⚠️ {hata}</div>}

      {sonuc && !yukleniyor && (
        <>
          {/* Mutabakat */}
          {kart ? (
            <div className="card mb-16" style={{ padding: 16, borderLeft: `3px solid ${m?.tutar_uyumlu ? 'var(--green)' : 'var(--red)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>🔗 Eşleşen kart: {kart.kart_adi}</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{kart.banka} · Sahip: {kart.sahip}</div>
                </div>
                <span className={`badge ${m?.tutar_uyumlu ? 'badge-green' : 'badge-red'}`} style={{ fontSize: 12 }}>
                  {m?.tutar_uyumlu ? '✓ Borç uyumlu' : '⚠ Borç farkı var'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginTop: 12 }}>
                {[['Sistem borcu', m?.sistem_borc], ['Ekstre borcu', m?.ekstre_borc], ['Fark', m?.fark]].map(([l, v]) => (
                  <div key={l} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: l === 'Fark' && Math.abs(v || 0) >= 1 ? 'var(--red)' : 'var(--text1)' }}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="alert-box yellow mb-16">
              🔎 Son 4 hane <strong>{sonuc.son_dort || '—'}</strong> ile eşleşen kart yok. Kart tanımına son 4 haneyi gir, tekrar yükle.
            </div>
          )}

          {/* Ekstre başlık verisi */}
          <div className="card mb-16" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>{formatAd} · Kart …{sonuc.son_dort}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, fontSize: 13 }}>
              {[
                ['Kesim tarihi', sonuc.kesim_tarihi],
                ['Son ödeme', sonuc.son_odeme_tarihi],
                ['Dönem borcu', fmt(sonuc.donem_borcu)],
                ['Asgari', `${fmt(sonuc.asgari_tutar)}${sonuc.asgari_oran ? ` (%${sonuc.asgari_oran})` : ''}`],
                ['Limit', fmt(sonuc.limit)],
                ['Kalan taksit', sonuc.kalan_taksit != null ? fmt(sonuc.kalan_taksit) : '—'],
                ['Önceki borç', sonuc.onceki_borc != null ? fmt(sonuc.onceki_borc) : '—'],
                ['Kart sahibi', sonuc.kart_sahibi || '—'],
              ].map(([l, v]) => (
                <div key={l} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l}</div>
                  <div style={{ fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* İşlemler */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '12px 16px', fontWeight: 700 }}>İşlemler ({sonuc.islemler?.length || 0})</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Tarih</th><th>İşlem</th><th>Açıklama</th><th>Taksit</th><th style={{ textAlign: 'right' }}>Tutar</th></tr></thead>
                <tbody>
                  {(sonuc.islemler || []).map((x, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12 }}>{x.tarih || '—'}</td>
                      <td><span className={`badge ${x.tip === 'ODEME' ? 'badge-blue' : x.tip === 'FAIZ' ? 'badge-red' : 'badge-yellow'}`}>{x.tip}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{x.aciklama}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{x.taksit || '—'}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{fmt(x.tutar)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 12 }}>
            ℹ️ Bu bir <strong>önizlemedir</strong> — hiçbir kayıt değişmedi. Mutabakatı onaylayıp sisteme yazma adımı bir sonraki fazda eklenecek.
          </div>
        </>
      )}
    </div>
  );
}
