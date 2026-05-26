import { useState, useRef, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';

// ── Renkler ────────────────────────────────────────────────────────────────────
const RENKLER = [
  '#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6',
  '#a78bfa','#34d399','#fbbf24','#f87171','#c084fc',
];

// ── Para formatla ──────────────────────────────────────────────────────────────
function fmt(v) {
  if (v == null || isNaN(v)) return '—';
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency', currency: 'TRY', maximumFractionDigits: 0,
  }).format(v);
}

// YYYY-MM → "Nis 2025"
const TR_AY = ['', 'Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
function ayLabel(ym) {
  if (!ym) return ym;
  const [yil, ay] = ym.split('-');
  return `${TR_AY[parseInt(ay)] || ay} ${yil}`;
}

// ── Banka adı normalize (fuzzy eşleştirme) ────────────────────────────────────
function bankaNorm(s) {
  return (s || '').toLowerCase()
    .replace(/\s+/g, '').replace(/bankası?|bank|bbva/g, '');
}
function bankaEslesiyor(a, b) {
  const na = bankaNorm(a), nb = bankaNorm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// PDF kart_no'sundan son 4 haneyi çıkar
function son4PDF(kartNo) {
  if (!kartNo) return '';
  const sadece = kartNo.replace(/[^0-9]/g, '');
  return sadece.slice(-4);
}

// ── Header gradienti ───────────────────────────────────────────────────────────
const BANNER = {
  background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
  padding: '22px 24px 18px',
  color: '#fff',
  borderRadius: 12,
  marginBottom: 20,
};

// ── Tooltip rengi ──────────────────────────────────────────────────────────────
const CUSTOM_TOOLTIP = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1e1e2e', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: '#aaa', marginBottom: 4 }}>{label}</div>
      <div style={{ color: '#fff', fontWeight: 700 }}>{fmt(payload[0]?.value)}</div>
    </div>
  );
};

// ── Ana bileşen ────────────────────────────────────────────────────────────────
export default function KartEkstreAnaliz() {
  const [dosyalar, setDosyalar]     = useState([]);   // { file, name }
  const [loading, setLoading]       = useState(false);
  const [sonuc, setSonuc]           = useState(null);
  const [hata, setHata]             = useState(null);
  const [aramaText, setAramaText]   = useState('');
  const [secilenKat, setSecilenKat] = useState('Tümü');
  const [secilenBnk, setSecilenBnk] = useState('Tümü');
  const [surukle, setSurukle]       = useState(false);
  const fileRef = useRef();

  // ── Mevcut kartlar (eşleştirme için) ─────────────────────────────────────────
  const [kartlar, setKartlar]         = useState([]);
  // eslesmeler: { 'Enpara::1234': kart_id, ... }
  const [eslesmeler, setEslesmeler]   = useState({});
  // aktarimSonuclari: { 'Enpara::1234': { yazilan, atlanan, kart_adi } }
  const [aktarimSonuclari, setAktarimSonuclari] = useState({});
  const [aktarimLoading, setAktarimLoading] = useState('');

  useEffect(() => {
    fetch('/kart-analiz/kartlar-listesi')
      .then(r => r.ok ? r.json() : [])
      .then(setKartlar)
      .catch(() => {});
  }, []);

  // ── Dosya ekleme ─────────────────────────────────────────────────────────────
  function dosyaEkle(files) {
    const yeni = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!yeni.length) return;
    setDosyalar(prev => {
      const mevcutAdlar = new Set(prev.map(d => d.name));
      return [...prev, ...yeni.filter(f => !mevcutAdlar.has(f.name)).map(f => ({ file: f, name: f.name }))];
    });
  }

  function dosyaCikar(name) {
    setDosyalar(prev => prev.filter(d => d.name !== name));
  }

  function onDrop(e) {
    e.preventDefault();
    setSurukle(false);
    dosyaEkle(e.dataTransfer.files);
  }

  // ── API çağrısı ───────────────────────────────────────────────────────────────
  async function analiz() {
    if (!dosyalar.length) return;
    setLoading(true);
    setHata(null);
    setSonuc(null);
    try {
      const form = new FormData();
      dosyalar.forEach(d => form.append('files', d.file, d.name));
      const r = await fetch('/kart-analiz/parse-pdf', { method: 'POST', body: form });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }));
        throw new Error(err.detail || r.statusText);
      }
      const data = await r.json();
      setSonuc(data);
      setAktarimSonuclari({});
      // Auto-eşleştir: banka adı + son 4 hane uyuşuyorsa direkt seç
      if (kartlar.length > 0) {
        const oto = {};
        (data.islemler || []).forEach(tx => {
          const key = tx.banka + '::' + son4PDF(tx.kart_no);
          if (oto[key]) return;
          const s4 = son4PDF(tx.kart_no);
          const eslesen = kartlar.find(k =>
            bankaEslesiyor(k.banka, tx.banka) &&
            (k.son_dort_hane === s4 || (!k.son_dort_hane && !s4))
          ) || kartlar.find(k => bankaEslesiyor(k.banka, tx.banka));
          if (eslesen) oto[key] = eslesen.id;
        });
        setEslesmeler(oto);
      }
    } catch (e) {
      setHata(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Sonuçları ön-işle ─────────────────────────────────────────────────────────
  const islemler    = sonuc?.islemler || [];
  const ozet        = sonuc?.ozet || {};
  const aylikRaw    = sonuc?.aylik_harcama || [];
  const katRaw      = sonuc?.kat_dagilim || [];
  const kartRaw     = sonuc?.kart_dagilim || [];
  const tekrarlayan = sonuc?.tekrarlayan || [];

  // recharts dataKey'leri: backend 'toplam' key'i kullanıyor
  const aylikData   = aylikRaw.map(d => ({ ...d, ay: ayLabel(d.ay), tutar: d.toplam }));
  const katData     = katRaw.map(d => ({ ...d, tutar: d.toplam }));
  const kartData    = kartRaw.map(d => ({ ...d, tutar: d.toplam }));

  // Hesaplanan özetler
  const aylikOrt = aylikRaw.length > 0 ? ozet.toplam_harcama / aylikRaw.length : 0;
  const enYuksekKat = katRaw[0]?.kategori || '—';

  // Tekrarlayan gruplama
  const abonelikler = tekrarlayan.filter(t => t['tür'] === 'İptal Edilebilir Abonelik');
  const sabitler    = tekrarlayan.filter(t => t['tür'] === 'Sabit Yükümlülük');

  // ── PDF'ten okunan benzersiz kart listesi (banka + son4) ──────────────────────
  const pdfKartlar = (() => {
    const seen = new Set();
    const list = [];
    islemler.forEach(tx => {
      const s4 = son4PDF(tx.kart_no);
      const key = tx.banka + '::' + s4;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({ key, banka: tx.banka, s4, kart_no: tx.kart_no });
      }
    });
    return list;
  })();

  // Aktarım: bir PDF kartının tüm harcamalarını gönder
  async function aktarYap(pdfKey, kartId) {
    if (!kartId) return;
    setAktarimLoading(pdfKey);
    try {
      const [banka, s4] = pdfKey.split('::');
      const secilen = islemler.filter(tx =>
        !tx.odeme_mi &&
        tx.banka === banka &&
        son4PDF(tx.kart_no) === s4
      );
      const r = await fetch('/kart-analiz/aktar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kart_id: kartId, islemler: secilen }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || r.statusText);
      setAktarimSonuclari(prev => ({ ...prev, [pdfKey]: d }));
    } catch (e) {
      setAktarimSonuclari(prev => ({ ...prev, [pdfKey]: { hata: e.message } }));
    } finally {
      setAktarimLoading('');
    }
  }

  // Son 4 haneyi karta kaydet
  async function son4Kaydet(kartId, s4) {
    await fetch('/kart-analiz/kaydet-son-dort-hane', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kart_id: kartId, son_dort_hane: s4 }),
    });
    // kartlar listesini yenile
    const fresh = await fetch('/kart-analiz/kartlar-listesi').then(r => r.json()).catch(() => kartlar);
    setKartlar(fresh);
  }

  // Filtre seçenekleri
  const bankaListesi = ['Tümü', ...new Set(islemler.map(i => i.banka))];
  const katListesi   = ['Tümü', ...new Set(islemler.filter(i => !i.odeme_mi).map(i => i.kategori))].sort();

  // Filtrelenmiş işlemler (ödemeler hariç)
  const filtreli = islemler.filter(i => {
    if (i.odeme_mi) return false;
    if (secilenBnk !== 'Tümü' && i.banka !== secilenBnk) return false;
    if (secilenKat !== 'Tümü' && i.kategori !== secilenKat) return false;
    if (aramaText && !i.aciklama.toLowerCase().includes(aramaText.toLowerCase())) return false;
    return true;
  });

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="page">

      {/* Banner */}
      <div style={BANNER}>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5, marginBottom: 3 }}>
          💳 Kart Ekstre Analizi
        </div>
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          Enpara · Garanti BBVA · Yapı Kredi · Ziraat &mdash; birden fazla PDF yükleyebilirsiniz
        </div>
      </div>

      {/* Sürükle-bırak alanı */}
      <div
        onDragOver={e => { e.preventDefault(); setSurukle(true); }}
        onDragLeave={() => setSurukle(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        style={{
          border: `2px dashed ${surukle ? '#6366f1' : 'var(--border)'}`,
          borderRadius: 12,
          padding: '32px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          marginBottom: 12,
          transition: 'all .2s',
          background: surukle ? 'rgba(99,102,241,0.07)' : 'var(--bg2)',
        }}>
        <input ref={fileRef} type="file" accept=".pdf" multiple hidden
          onChange={e => dosyaEkle(e.target.files)} />
        <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
          PDF Ekstrelerinizi Sürükleyin veya Tıklayın
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          Birden fazla banka ekstresi aynı anda yüklenebilir
        </div>
      </div>

      {/* Yüklenen dosyalar */}
      {dosyalar.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {dosyalar.map(d => (
            <div key={d.name} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', background: 'var(--bg3)',
              borderRadius: 20, border: '1px solid var(--border)', fontSize: 12,
            }}>
              <span>📄 {d.name}</span>
              <button
                onClick={e => { e.stopPropagation(); dosyaCikar(d.name); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 0, fontSize: 15, lineHeight: 1 }}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Analiz butonu */}
      <button
        onClick={analiz}
        disabled={loading || dosyalar.length === 0}
        className="btn btn-primary"
        style={{ width: '100%', height: 50, fontSize: 15, fontWeight: 800, marginBottom: 24, letterSpacing: 0.3 }}>
        {loading
          ? '⏳ Analiz ediliyor…'
          : dosyalar.length === 0
            ? '📄 Önce PDF yükleyin'
            : `🔍 ${dosyalar.length} PDF Analiz Et`}
      </button>

      {/* Hata */}
      {hata && (
        <div style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 8,
          background: 'rgba(220,50,50,0.08)', border: '1px solid var(--red)',
          fontSize: 13, color: 'var(--red)',
        }}>
          ⚠️ {hata}
        </div>
      )}

      {/* ── SONUÇLAR ── */}
      {sonuc && (
        <>

          {/* KPI Tile'ları */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 24 }}>
            {[
              { label: '💸 Toplam Harcama', val: fmt(ozet.toplam_harcama), renk: 'var(--red)' },
              { label: '📅 Aylık Ortalama', val: fmt(aylikOrt), renk: 'var(--yellow)' },
              { label: '🏆 En Yüksek Kat.', val: enYuksekKat, renk: 'var(--primary)', kucuk: true },
              { label: '💰 Toplam Ödeme',  val: fmt(ozet.toplam_odeme), renk: 'var(--green)' },
              { label: '📝 Harcama Sayısı', val: String(ozet.harcama_sayisi || 0), renk: 'var(--text2)' },
            ].map(({ label, val, renk, kucuk }) => (
              <div key={label} className="metric-card" style={{ borderTop: `3px solid ${renk}` }}>
                <div className="metric-label">{label}</div>
                <div className="metric-value" style={{ fontSize: kucuk ? 13 : 18, color: renk, fontWeight: 700 }}>{val}</div>
              </div>
            ))}
          </div>

          {/* ── Kart Eşleştirme Paneli ── */}
          {pdfKartlar.length > 0 && kartlar.length > 0 && (
            <div className="card" style={{ marginBottom: 24, border: '1px solid rgba(99,102,241,0.35)' }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>🔗 Kart Eşleştirme</h3>
              <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14, marginTop: 0 }}>
                PDF'ten okunan her kartı mevcut kart tanımınızla eşleştirin. Harcamaları &nbsp;
                <strong style={{ color: 'var(--primary)' }}>Kart Hareketleri</strong>'ne aktarabilirsiniz.
              </p>

              {pdfKartlar.map(pk => {
                const eslKartId = eslesmeler[pk.key] || '';
                const eslKart   = kartlar.find(k => k.id === eslKartId);
                const sonuc_    = aktarimSonuclari[pk.key];
                const isLoading = aktarimLoading === pk.key;
                const txCount   = islemler.filter(tx => !tx.odeme_mi && tx.banka === pk.banka && son4PDF(tx.kart_no) === pk.s4).length;

                return (
                  <div key={pk.key} style={{
                    padding: '14px 16px', marginBottom: 10, borderRadius: 10,
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                  }}>
                    {/* Sol: PDF kart kimliği */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 160 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          {pk.banka} {pk.s4 ? <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>**** {pk.s4}</span> : ''}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                          PDF'te {txCount} harcama
                        </div>
                      </div>

                      <div style={{ fontSize: 18, color: 'var(--text3)', paddingTop: 4 }}>→</div>

                      {/* Dropdown */}
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <select
                          value={eslKartId}
                          onChange={e => {
                            const yeni = e.target.value;
                            setEslesmeler(prev => ({ ...prev, [pk.key]: yeni }));
                            // Son 4 haneyi otomatik kaydet (eğer kart tanımında yoksa)
                            const secilenK = kartlar.find(k => k.id === yeni);
                            if (yeni && pk.s4 && secilenK && !secilenK.son_dort_hane)
                              son4Kaydet(yeni, pk.s4);
                          }}
                          style={{
                            width: '100%', padding: '8px 10px', borderRadius: 6,
                            background: 'var(--bg2)', border: `1px solid ${eslKartId ? 'var(--primary)' : 'var(--border)'}`,
                            color: 'var(--text1)', fontSize: 13,
                          }}>
                          <option value="">— Kart seçin —</option>
                          {kartlar.map(k => (
                            <option key={k.id} value={k.id}>
                              {k.kart_adi} ({k.banka}{k.son_dort_hane ? ' ****' + k.son_dort_hane : ''})
                            </option>
                          ))}
                        </select>

                        {/* Eşleşen kartın metrikleri */}
                        {eslKart && (
                          <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                            {[
                              { label: 'Limit', val: fmt(eslKart.limit_tutar), renk: 'var(--text2)' },
                              { label: 'Faiz', val: `%${eslKart.faiz_orani}`, renk: 'var(--yellow)' },
                              { label: 'Mevcut Borç', val: fmt(eslKart.guncel_borc), renk: 'var(--red)' },
                            ].map(m => (
                              <div key={m.label} style={{ fontSize: 11, color: 'var(--text3)' }}>
                                {m.label}: <strong style={{ color: m.renk }}>{m.val}</strong>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Aktarım butonu */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <button
                          onClick={() => aktarYap(pk.key, eslKartId)}
                          disabled={!eslKartId || isLoading || !!sonuc_?.yazilan}
                          className="btn btn-primary btn-sm"
                          style={{ height: 38, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', minWidth: 110 }}>
                          {isLoading ? '⏳ Aktarılıyor…' : sonuc_?.yazilan != null ? '✅ Aktarıldı' : '⬆ Aktar'}
                        </button>

                        {/* Sonuç */}
                        {sonuc_ && !sonuc_.hata && (
                          <div style={{ fontSize: 11, textAlign: 'right', color: 'var(--green)', lineHeight: 1.4 }}>
                            {sonuc_.yazilan} yeni kayıt
                            {sonuc_.atlanan > 0 && <span style={{ color: 'var(--text3)' }}> · {sonuc_.atlanan} duplike atlandı</span>}
                          </div>
                        )}
                        {sonuc_?.hata && (
                          <div style={{ fontSize: 11, color: 'var(--red)' }}>⚠ {sonuc_.hata}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Aylık + Kategori grafikleri */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 16, marginBottom: 24 }}>

            {/* Aylık harcama bar chart */}
            <div className="card">
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>📅 Aylık Harcama</h3>
              {aylikData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text3)', fontSize: 12 }}>Veri yok</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={aylikData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="ay" tick={{ fontSize: 10, fill: 'var(--text3)' }} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text3)' }}
                      tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v} />
                    <Tooltip content={<CUSTOM_TOOLTIP />} cursor={{ fill: 'rgba(99,102,241,0.08)' }} />
                    <Bar dataKey="tutar" fill="#6366f1" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Kategori pie */}
            <div className="card">
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>🏷 Kategoriler</h3>
              {katData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text3)', fontSize: 12 }}>Veri yok</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={katData.slice(0, 8)}
                      dataKey="tutar"
                      nameKey="kategori"
                      cx="50%" cy="45%"
                      outerRadius={72}
                      innerRadius={30}>
                      {katData.slice(0, 8).map((_, i) => (
                        <Cell key={i} fill={RENKLER[i % RENKLER.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => fmt(v)} />
                    <Legend
                      iconSize={8}
                      formatter={v => <span style={{ fontSize: 9, color: 'var(--text2)' }}>{v}</span>}
                      wrapperStyle={{ paddingTop: 4 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Kart bazlı harcama (birden fazla kart varsa) */}
          {kartData.length > 1 && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>💳 Kart Bazlı Harcama</h3>
              <ResponsiveContainer width="100%" height={Math.max(120, kartData.length * 44)}>
                <BarChart data={kartData} layout="vertical" margin={{ top: 0, right: 20, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--text3)' }}
                    tickFormatter={v => v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v} />
                  <YAxis type="category" dataKey="kart" tick={{ fontSize: 11, fill: 'var(--text2)' }} width={130} />
                  <Tooltip content={<CUSTOM_TOOLTIP />} cursor={{ fill: 'rgba(99,102,241,0.08)' }} />
                  <Bar dataKey="tutar" fill="#8b5cf6" radius={[0, 5, 5, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Tekrarlayan ödemeler */}
          {(abonelikler.length > 0 || sabitler.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
              {[
                { liste: abonelikler, label: '📱 İptal Edilebilir Abonelikler', renk: '#f59e0b' },
                { liste: sabitler,    label: '🏠 Sabit Yükümlülükler',         renk: '#ef4444' },
              ].map(({ liste, label, renk }) =>
                liste.length > 0 ? (
                  <div key={label} className="card">
                    <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{label}</h3>
                    {liste.map((t, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: i < liste.length - 1 ? '1px solid var(--border)' : 'none',
                        fontSize: 12,
                      }}>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--text1)' }}>{t.aciklama}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                            {t['işlem_sayısı']}x · {t.banka}
                          </div>
                        </div>
                        <span style={{ fontWeight: 700, color: renk, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                          {fmt(t['aylık_ortalama'])}
                        </span>
                      </div>
                    ))}
                    <div style={{
                      marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)',
                      display: 'flex', justifyContent: 'space-between', fontSize: 12
                    }}>
                      <span style={{ color: 'var(--text3)' }}>Aylık toplam</span>
                      <span style={{ fontWeight: 700, color: renk }}>
                        {fmt(liste.reduce((s, t) => s + (t['aylık_ortalama'] || 0), 0))}
                      </span>
                    </div>
                  </div>
                ) : null
              )}
            </div>
          )}

          {/* Kategori özeti (tablo) */}
          {katData.length > 0 && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>📊 Kategori Özeti</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 8 }}>
                {katData.map((k, i) => {
                  const pct = ozet.toplam_harcama > 0 ? (k.tutar / ozet.toplam_harcama * 100) : 0;
                  return (
                    <div key={k.kategori} style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 8, borderLeft: `3px solid ${RENKLER[i % RENKLER.length]}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{k.kategori}</span>
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>%{pct.toFixed(1)}</span>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: RENKLER[i % RENKLER.length], fontFamily: 'var(--font-mono)' }}>{fmt(k.tutar)}</div>
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 6 }}>
                        <div style={{ width: `${pct}%`, height: 3, background: RENKLER[i % RENKLER.length], borderRadius: 2 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* İşlem tablosu */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                📋 İşlem Listesi <span style={{ color: 'var(--text3)', fontWeight: 400 }}>({filtreli.length})</span>
              </h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  placeholder="🔍 Ara…"
                  value={aramaText}
                  onChange={e => setAramaText(e.target.value)}
                  style={{
                    padding: '6px 10px', background: 'var(--bg3)',
                    border: '1px solid var(--border)', borderRadius: 6,
                    color: 'var(--text1)', fontSize: 12, width: 150,
                  }}
                />
                <select
                  value={secilenBnk}
                  onChange={e => setSecilenBnk(e.target.value)}
                  style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 12 }}>
                  {bankaListesi.map(b => <option key={b}>{b}</option>)}
                </select>
                <select
                  value={secilenKat}
                  onChange={e => setSecilenKat(e.target.value)}
                  style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 12 }}>
                  {katListesi.map(k => <option key={k}>{k}</option>)}
                </select>
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)' }}>
                    {[
                      { h: 'Tarih', align: 'left' },
                      { h: 'Açıklama', align: 'left' },
                      { h: 'Banka', align: 'left' },
                      { h: 'Kategori', align: 'left' },
                      { h: 'Tutar', align: 'right' },
                    ].map(({ h, align }) => (
                      <th key={h} style={{ textAlign: align, padding: '7px 10px', color: 'var(--text3)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtreli.slice(0, 300).map((tx, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '7px 10px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{tx.tarih}</td>
                      <td style={{ padding: '7px 10px', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.aciklama}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{tx.banka}</td>
                      <td style={{ padding: '7px 10px' }}>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                          background: 'rgba(99,102,241,0.12)', color: '#a5b4fc', fontSize: 10, fontWeight: 600,
                        }}>{tx.kategori}</span>
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)', color: '#f87171', whiteSpace: 'nowrap' }}>
                        {fmt(tx.tutar)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtreli.length > 300 && (
                <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text3)', textAlign: 'center' }}>
                  İlk 300 işlem gösteriliyor — filtre kullanarak daraltın ({filtreli.length} toplam)
                </div>
              )}
              {filtreli.length === 0 && islemler.length > 0 && (
                <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
                  Filtreyle eşleşen işlem bulunamadı
                </div>
              )}
            </div>
          </div>

          {/* Parse uyarıları */}
          {sonuc.hatalar?.length > 0 && (
            <div style={{
              padding: '10px 14px', background: 'rgba(245,158,11,0.08)',
              border: '1px solid var(--yellow)', borderRadius: 8, fontSize: 12, color: 'var(--yellow)',
            }}>
              ⚠️ {sonuc.hatalar.length} dosyada uyarı: {sonuc.hatalar.join(' · ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
