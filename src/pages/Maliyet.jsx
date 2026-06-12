import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';

// ─────────────────────────────────────────────────────────────────────────
// Maliyet — Faz 1+2+3:
//  - Alış fiyatı girişi/güncelleme + geçmiş (artış/azalış oku)
//  - Fatura PDF yükleme (tablo bazlı parser, urun_kodu eşleştirme hafızası)
//  - Depo stok kataloğu ile otomatik tamamlama (kalem_kodu -> kalem_adi)
//  - Şube bazlı food cost özeti (sube_food_cost_gun) — "tek tek şubelerin
//    maliyeti" görünümü için şube seçici
// ─────────────────────────────────────────────────────────────────────────

const _gunGunKolonVarsayilan = [
  { kod: 'sut', baslik: 'Süt' },
  { kod: 'kahve', baslik: 'Kahve' },
  { kod: 'surup', baslik: 'Şurup' },
  { kod: 'bardak_8oz', baslik: '8oz Bardak' },
  { kod: 'bardak_14oz', baslik: '14oz Bardak' },
  { kod: 'karton_bardak', baslik: 'Karton Bardak' },
  { kod: 'plastik_bardak', baslik: 'Plastik Bardak' },
  { kod: 'kapak', baslik: 'Kapak' },
  { kod: 'pecete', baslik: 'Peçete' },
  { kod: 'su', baslik: 'Su' },
  { kod: 'pasta', baslik: 'Pasta/Tatlı' },
  { kod: 'diger', baslik: 'Diğer Sarf' },
];

export default function Maliyet() {
  const [subeler, setSubeler] = useState([]);
  const [subeId, setSubeId] = useState(''); // '' = tüm şubeler

  const [maliyetData, setMaliyetData] = useState(null);
  const [maliyetFiyatlar, setMaliyetFiyatlar] = useState([]);
  const [stokKalemleri, setStokKalemleri] = useState([]);
  const [gunGunData, setGunGunData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mesaj, setMesaj] = useState(null); // {m, t}

  const [maliyetForm, setMaliyetForm] = useState({ kalem_kodu: '', kalem_adi: '', birim: 'adet', birim_maliyet_tl: '', tedarikci: '', notlar: '' });
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [acikKalem, setAcikKalem] = useState(null);

  const [faturaTedarikci, setFaturaTedarikci] = useState('');
  const [faturaYukleniyor, setFaturaYukleniyor] = useState(false);
  const [faturaSatirlar, setFaturaSatirlar] = useState(null);
  const [faturaUyari, setFaturaUyari] = useState('');
  const [faturaKaydedilenler, setFaturaKaydedilenler] = useState({});

  useEffect(() => {
    api('/subeler').then(r => setSubeler(r || [])).catch(() => {});
  }, []);

  const yukle = () => {
    setLoading(true);
    const q = subeId ? `?sube_id=${encodeURIComponent(subeId)}` : '';
    Promise.all([
      api('/ops/maliyet/ozet' + q),
      api('/ops/maliyet/alis-fiyatlari'),
      api('/ops/maliyet/stok-kalemleri'),
      api('/ops/maliyet/gun-gun?gun=7' + (subeId ? `&sube_id=${encodeURIComponent(subeId)}` : '')),
    ]).then(([ozet, fiyatlar, kalemler, gunGun]) => {
      setMaliyetData(ozet);
      setMaliyetFiyatlar(fiyatlar?.satirlar || []);
      setStokKalemleri(kalemler?.kalemler || []);
      setGunGunData(gunGun);
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { yukle(); }, [subeId]);

  useEffect(() => {
    if (!mesaj) return;
    const t = setTimeout(() => setMesaj(null), 4000);
    return () => clearTimeout(t);
  }, [mesaj]);

  const stokKalemiSecildi = (kalemKodu, setFn) => {
    const k = stokKalemleri.find(s => s.kalem_kodu === kalemKodu);
    setFn(f => ({ ...f, kalem_kodu: kalemKodu, ...(k ? { kalem_adi: k.kalem_adi } : {}) }));
  };

  const fiyatKaydet = () => {
    const kalem = (maliyetForm.kalem_kodu || '').trim();
    const fiyat = parseFloat(String(maliyetForm.birim_maliyet_tl).replace(',', '.'));
    if (!kalem) { setMesaj({ m: 'Kalem kodu zorunlu', t: 'error' }); return; }
    if (!(fiyat >= 0)) { setMesaj({ m: 'Geçerli bir fiyat girin', t: 'error' }); return; }
    setKaydediliyor(true);
    api('/ops/maliyet/alis-fiyat-kaydet', { method: 'POST', body: {
      kalem_kodu: kalem,
      kalem_adi: (maliyetForm.kalem_adi || '').trim() || kalem,
      birim: maliyetForm.birim || 'adet',
      birim_maliyet_tl: fiyat,
      tedarikci: (maliyetForm.tedarikci || '').trim() || null,
      notlar: (maliyetForm.notlar || '').trim() || null,
    }})
    .then(() => {
      setMesaj({ m: '✅ Fiyat kaydedildi', t: 'success' });
      setMaliyetForm({ kalem_kodu: '', kalem_adi: '', birim: 'adet', birim_maliyet_tl: '', tedarikci: '', notlar: '' });
      yukle();
    })
    .catch(e => setMesaj({ m: e.message || 'Kayıt başarısız', t: 'error' }))
    .finally(() => setKaydediliyor(false));
  };

  // Gün gün maliyet iskeleti — son 7 gün, en yeni üstte (içerikler sonraki adımda doldurulacak)
  const gunGunTarihler = (() => {
    const out = [];
    const d = new Date();
    for (let i = 0; i < 7; i++) {
      const t = new Date(d);
      t.setDate(d.getDate() - i);
      out.push(t.toISOString().slice(0, 10));
    }
    return out;
  })();

  const subeAdiSecili = subeId ? (subeler.find(s => s.id === subeId)?.ad || subeId) : 'Tüm Şubeler';

  const gruplar = (() => {
    const map = new Map();
    for (const r of maliyetFiyatlar) {
      if (!map.has(r.kalem_kodu)) map.set(r.kalem_kodu, []);
      map.get(r.kalem_kodu).push(r);
    }
    const out = [];
    for (const [kalem_kodu, gecmis] of map.entries()) {
      gecmis.sort((a, b) => (b.gecerli_baslangic || '').localeCompare(a.gecerli_baslangic || ''));
      out.push({ kalem_kodu, guncel: gecmis[0], onceki: gecmis[1] || null, gecmis });
    }
    out.sort((a, b) => (a.guncel.kalem_adi || a.kalem_kodu || '').localeCompare(b.guncel.kalem_adi || b.kalem_kodu || '', 'tr'));
    return out;
  })();

  const faturaPdfYukle = async (file) => {
    if (!file) return;
    setFaturaYukleniyor(true);
    setFaturaUyari('');
    setFaturaSatirlar(null);
    setFaturaKaydedilenler({});
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (faturaTedarikci.trim()) fd.append('tedarikci', faturaTedarikci.trim());
      const res = await fetch('/api/ops/maliyet/fatura-pdf-yukle', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'PDF işlenemedi');
      const satirlar = (data.satirlar || []).map(s => ({
        ...s,
        kalem_kodu: s.onerilen_kalem_kodu || '',
        kalem_adi: s.onerilen_kalem_adi || s.aciklama,
        birim: s.birim || 'adet',
        birim_maliyet_tl: s.tutar != null ? String(s.tutar) : '',
      }));
      setFaturaSatirlar(satirlar);
      if (data.uyari) setFaturaUyari(data.uyari);
      else if (!satirlar.length) setFaturaUyari('PDF içinde kalem satırı bulunamadı.');
    } catch (e) {
      setFaturaUyari(e.message || 'PDF işlenemedi');
    } finally {
      setFaturaYukleniyor(false);
    }
  };

  const faturaSatirGuncelle = (idx, alan, deger) => {
    setFaturaSatirlar(rows => rows.map((r, i) => {
      if (i !== idx) return r;
      if (alan === 'kalem_kodu') {
        const k = stokKalemleri.find(s => s.kalem_kodu === deger);
        return { ...r, kalem_kodu: deger, ...(k ? { kalem_adi: k.kalem_adi } : {}) };
      }
      return { ...r, [alan]: deger };
    }));
  };

  const faturaSatirKaydet = (idx) => {
    const s = faturaSatirlar[idx];
    const kalem = (s.kalem_kodu || '').trim();
    const fiyat = parseFloat(String(s.birim_maliyet_tl).replace(',', '.'));
    if (!kalem) { setMesaj({ m: 'Kalem kodu seç/gir', t: 'error' }); return; }
    if (!(fiyat >= 0)) { setMesaj({ m: 'Geçerli bir fiyat girin', t: 'error' }); return; }
    api('/ops/maliyet/fatura-kalem-onayla', { method: 'POST', body: {
      ham_metin: s.ham_metin,
      urun_kodu: s.urun_kodu || null,
      aciklama: s.aciklama || null,
      kalem_kodu: kalem,
      kalem_adi: (s.kalem_adi || '').trim() || kalem,
      birim: s.birim || 'adet',
      birim_maliyet_tl: fiyat,
      tedarikci: faturaTedarikci.trim() || null,
    }})
    .then(() => {
      setFaturaKaydedilenler(prev => ({ ...prev, [idx]: true }));
      yukle();
    })
    .catch(e => setMesaj({ m: e.message || 'Kayıt başarısız', t: 'error' }));
  };

  if (loading && !maliyetData) {
    return <div className="page"><div className="empty"><p>Yükleniyor...</p></div></div>;
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>💰 Maliyet</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text3)' }}>Şube:</label>
          <select value={subeId} onChange={e => setSubeId(e.target.value)}>
            <option value="">Tüm Şubeler</option>
            {subeler.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
          </select>
        </div>
      </div>

      {mesaj && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8,
          background: mesaj.t === 'error' ? 'rgba(220,60,60,0.1)' : 'rgba(60,180,90,0.1)',
          border: `1px solid ${mesaj.t === 'error' ? 'rgba(220,60,60,0.3)' : 'rgba(60,180,90,0.3)'}`,
          fontSize: 12, color: 'var(--text2)' }}>
          {mesaj.m}
        </div>
      )}

      {/* Altyapı durumu uyarıları */}
      {maliyetData?.altyapi_durum?.eksikler?.length > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 12px', borderRadius: 8, background: 'rgba(220,160,0,0.06)', border: '1px solid rgba(220,160,0,0.25)' }}>
          {maliyetData.altyapi_durum.eksikler.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--text2)' }}>⚠️ {e}</div>
          ))}
        </div>
      )}

      {/* Özet kartları */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div className="card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>📦 Stok Değeri{subeId ? ' (şube)' : ' (tüm şubeler)'}</h3>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fmt(maliyetData?.stok_degeri_tl || 0)}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{maliyetData?.stok_kalem_sayisi || 0} kalem</div>
        </div>
        <div className="card">
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🏷️ Tanımlı Fiyatlar</h3>
          <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{gruplar.length}</div>
          <div style={{ fontSize: 11, color: 'var(--text3)' }}>kalem fiyatlandırıldı</div>
        </div>
        {maliyetData?.benchmark && (
          <div className="card">
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>🎯 Benchmark</h3>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>%{maliyetData.benchmark.food_cost_min_pct}–{maliyetData.benchmark.food_cost_max_pct}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>{maliyetData.benchmark.aciklama}</div>
          </div>
        )}
      </div>

      {/* Gün gün maliyet detayı — Ürün Aç (URUN_AC) tüketim verisi × güncel alış fiyatı */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📅 Gün Gün Maliyet{subeId ? '' : ' — Tüm Şubeler'}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>"Ürün Aç" tüketimi × güncel fiyat — reçete gerekmez</span>
      </div>
      {gunGunData?.fiyat_eksik_kalemler?.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--yellow)' }}>
          ⚠️ Fiyatı tanımlanmamış kalemler (0₺ sayıldı): {gunGunData.fiyat_eksik_kalemler.join(', ')}
        </div>
      )}
      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="tablo">
          <thead>
            <tr>
              <th>Tarih</th>
              {!subeId && <th>Şube</th>}
              {(gunGunData?.kolonlar || _gunGunKolonVarsayilan).map(k => <th key={k.kod}>{k.baslik}</th>)}
              <th>Malzeme Toplamı</th>
              <th>👥 Personel (kişi)</th>
              <th>👥 Personel Saat</th>
              <th>👥 Personel Maliyeti</th>
              <th title="Şube panelinden girilen ve onaylanan anlık giderler">🧾 Şube Anlık Gider</th>
              <th>GENEL TOPLAM</th>
            </tr>
          </thead>
          <tbody>
            {(gunGunData?.satirlar || gunGunTarihler.map(t => ({ tarih: t, sube_adi: subeAdiSecili, _bos: true }))).map((satir, i) => (
              <tr key={i}>
                <td>{fmtDate(satir.tarih)}</td>
                {!subeId && <td>{satir.sube_adi}</td>}
                {(gunGunData?.kolonlar || _gunGunKolonVarsayilan).map(k => (
                  <td key={k.kod}>{satir._bos ? '—' : fmt(satir[k.kod] || 0)}</td>
                ))}
                <td style={{ fontWeight: 700 }}>{satir._bos ? '—' : fmt(satir.toplam || 0)}</td>
                <td>{satir._bos ? '—' : (satir.personel_sayisi || 0)}</td>
                <td>{satir._bos ? '—' : (satir.personel_saat || 0)}</td>
                <td>{satir._bos ? '—' : fmt(satir.personel_maliyet_tl || 0)}</td>
                <td>{satir._bos ? '—' : fmt(satir.sube_anlik_gider_tl || 0)}</td>
                <td style={{ fontWeight: 700, color: 'var(--accent)' }}>{satir._bos ? '—' : fmt(satir.genel_toplam || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Fiyat girişi / güncelleme formu */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>➕ Fiyat Girişi / Güncelleme</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 10, marginBottom: 12 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Kalem kodu (depo kataloğu)</label>
            <input type="text" list="depo-kalem-listesi-sayfa" placeholder="örn. sut_litre" value={maliyetForm.kalem_kodu}
              onChange={e => stokKalemiSecildi(e.target.value, setMaliyetForm)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Kalem adı</label>
            <input type="text" placeholder="örn. Süt 1L" value={maliyetForm.kalem_adi}
              onChange={e => setMaliyetForm(f => ({ ...f, kalem_adi: e.target.value }))} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Birim</label>
            <select value={maliyetForm.birim} onChange={e => setMaliyetForm(f => ({ ...f, birim: e.target.value }))}>
              <option value="adet">adet</option>
              <option value="kg">kg</option>
              <option value="lt">lt</option>
              <option value="koli">koli</option>
              <option value="paket">paket</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Birim fiyat (₺)</label>
            <input type="text" inputMode="decimal" placeholder="0.00" value={maliyetForm.birim_maliyet_tl}
              onChange={e => setMaliyetForm(f => ({ ...f, birim_maliyet_tl: e.target.value }))} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Tedarikçi (opsiyonel)</label>
            <input type="text" placeholder="örn. Pınar Bayi" value={maliyetForm.tedarikci}
              onChange={e => setMaliyetForm(f => ({ ...f, tedarikci: e.target.value }))} />
          </div>
        </div>
        <button className="btn btn-primary btn-sm" disabled={kaydediliyor} onClick={fiyatKaydet}>
          {kaydediliyor ? 'Kaydediliyor...' : '💾 Fiyatı Kaydet'}
        </button>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
          Aynı kalem kodu için yeni bir fiyat kaydedersen, eski fiyat otomatik olarak "geçmiş" olarak saklanır ve aşağıdaki listede artış/azalış oku ile karşılaştırma görürsün.
          Kalem kodu, depo stoğundaki ({stokKalemleri.length} kalem) gerçek kodlardan seçilirse, fiyat o kalemin depo stok değerine de otomatik yansır.
        </div>
      </div>

      <datalist id="depo-kalem-listesi-sayfa">
        {stokKalemleri.map(k => (
          <option key={k.kalem_kodu} value={k.kalem_kodu}>{k.kalem_adi}</option>
        ))}
      </datalist>

      {/* Fatura PDF yükleme */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📄 Fatura PDF Yükle</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Satırları okur, sen onaylayınca fiyatları günceller</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 10, marginBottom: 12, alignItems: 'end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Tedarikçi (opsiyonel)</label>
            <input type="text" placeholder="örn. Pınar Bayi" value={faturaTedarikci}
              onChange={e => setFaturaTedarikci(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Fatura PDF</label>
            <input type="file" accept="application/pdf"
              onChange={e => faturaPdfYukle(e.target.files?.[0])} disabled={faturaYukleniyor} />
          </div>
        </div>
        {faturaYukleniyor && <div style={{ fontSize: 12, color: 'var(--text3)' }}>PDF okunuyor...</div>}
        {faturaUyari && <div style={{ fontSize: 12, color: 'var(--yellow)', marginBottom: 8 }}>⚠️ {faturaUyari}</div>}

        {faturaSatirlar?.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {faturaSatirlar.map((s, idx) => {
              const fiyat = parseFloat(String(s.birim_maliyet_tl).replace(',', '.'));
              const fark = (s.onceki_fiyat != null && !isNaN(fiyat)) ? (fiyat - s.onceki_fiyat) : null;
              const yuzde = (fark !== null && s.onceki_fiyat > 0) ? (fark / s.onceki_fiyat) * 100 : null;
              const ok = fark === null ? null : fark > 0 ? '🔺' : fark < 0 ? '🔻' : '➖';
              const okRenk = fark > 0 ? 'var(--red)' : fark < 0 ? 'var(--green)' : 'var(--text3)';
              const kaydedildi = !!faturaKaydedilenler[idx];
              return (
                <div key={idx} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg3)', border: `1px solid ${kaydedildi ? 'var(--green)' : 'var(--border)'}` }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
                    {s.urun_kodu && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>[{s.urun_kodu}] </span>}
                    {s.ham_metin}
                    {s.miktar != null && <span> · {s.miktar} {s.birim || ''}</span>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'center' }}>
                    <input type="text" list="depo-kalem-listesi-sayfa" placeholder="Stok kalem kodu (örn. sut_litre)" value={s.kalem_kodu}
                      onChange={e => faturaSatirGuncelle(idx, 'kalem_kodu', e.target.value)} disabled={kaydedildi} />
                    <input type="text" placeholder="Kalem adı" value={s.kalem_adi}
                      onChange={e => faturaSatirGuncelle(idx, 'kalem_adi', e.target.value)} disabled={kaydedildi} />
                    <select value={s.birim} onChange={e => faturaSatirGuncelle(idx, 'birim', e.target.value)} disabled={kaydedildi}>
                      <option value="adet">adet</option>
                      <option value="kg">kg</option>
                      <option value="lt">lt</option>
                      <option value="koli">koli</option>
                      <option value="paket">paket</option>
                    </select>
                    <input type="text" inputMode="decimal" placeholder="₺" value={s.birim_maliyet_tl}
                      onChange={e => faturaSatirGuncelle(idx, 'birim_maliyet_tl', e.target.value)} disabled={kaydedildi} />
                    {kaydedildi
                      ? <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700, textAlign: 'center' }}>✅ Kaydedildi</span>
                      : <button className="btn btn-secondary btn-sm" onClick={() => faturaSatirKaydet(idx)}>Onayla</button>}
                  </div>
                  {fark !== null && (
                    <div style={{ marginTop: 6, fontSize: 11, color: okRenk, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{ok}</span>
                      <span>Önceki fiyat ({fmtDate(s.onceki_tarih)}): {fmt(s.onceki_fiyat)} → Yeni: {fmt(fiyat)}</span>
                      {yuzde !== null && <span style={{ fontWeight: 700 }}>({fark > 0 ? '+' : ''}{yuzde.toFixed(1)}%)</span>}
                    </div>
                  )}
                  {s.miktar != null && (
                    <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text3)' }}>Faturadaki miktar: {s.miktar}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Güncel fiyat listesi + geçmiş/artış görseli */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📑 Güncel Fiyat Listesi</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Ok ikonuna tıkla → değişim yüzdesi</span>
      </div>
      {gruplar.length === 0 ? (
        <div className="empty"><p>Henüz fiyat tanımlanmamış. Yukarıdan ilk fiyatı ekleyebilirsin.</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {gruplar.map(g => {
            const guncel = g.guncel;
            const onceki = g.onceki;
            const fark = onceki ? (guncel.birim_maliyet_tl - onceki.birim_maliyet_tl) : null;
            const yuzde = (onceki && onceki.birim_maliyet_tl > 0) ? (fark / onceki.birim_maliyet_tl) * 100 : null;
            const ok = fark === null ? null : fark > 0 ? '🔺' : fark < 0 ? '🔻' : '➖';
            const okRenk = fark > 0 ? 'var(--red)' : fark < 0 ? 'var(--green)' : 'var(--text3)';
            const acik = acikKalem === g.kalem_kodu;
            return (
              <div key={g.kalem_kodu} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{guncel.kalem_adi || g.kalem_kodu}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                      {guncel.birim} · {guncel.tedarikci || 'tedarikçi belirtilmemiş'} · {fmtDate(guncel.gecerli_baslangic)}'den beri
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14 }}>{fmt(guncel.birim_maliyet_tl)}</div>
                    {ok && (
                      <button
                        onClick={() => setAcikKalem(acik ? null : g.kalem_kodu)}
                        title="Fiyat geçmişi / değişim yüzdesi"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, color: okRenk, padding: 0, lineHeight: 1 }}
                      >{ok}</button>
                    )}
                  </div>
                </div>
                {acik && onceki && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text2)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                    <span>{fmtDate(onceki.gecerli_baslangic)}: {fmt(onceki.birim_maliyet_tl)} → {fmtDate(guncel.gecerli_baslangic)}: {fmt(guncel.birim_maliyet_tl)}</span>
                    <span style={{ fontWeight: 700, color: okRenk }}>{fark > 0 ? '+' : ''}{yuzde.toFixed(1)}%</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
