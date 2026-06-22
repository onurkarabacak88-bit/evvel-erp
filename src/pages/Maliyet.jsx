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
  const [guvenSkoru, setGuvenSkoru] = useState(null);   // Faz 5: güven skoru + sapma motoru
  const [guvenAcik, setGuvenAcik] = useState(false);    // detay aç/kapa
  const [sekme, setSekme] = useState('genel');          // genel | analiz | fiyatlar | faturalar
  const [donem, setDonem] = useState('7');              // bugun | 7 | 30 | ay | gecenay | ozel
  const [ozelBas, setOzelBas] = useState('');           // Özel aralık başlangıç (YYYY-MM-DD)
  const [ozelBit, setOzelBit] = useState('');           // Özel aralık bitiş
  const [gunGunOnceki, setGunGunOnceki] = useState(null); // önceki eşit pencere (KPI trend için)
  const [loading, setLoading] = useState(false);
  const [mesaj, setMesaj] = useState(null); // {m, t}

  const [maliyetForm, setMaliyetForm] = useState({ kalem_kodu: '', kalem_adi: '', birim: 'adet', birim_maliyet_tl: '', tedarikci: '', notlar: '' });
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [acikKalem, setAcikKalem] = useState(null);

  const [faturaTedarikci, setFaturaTedarikci] = useState('');
  const [faturaYukleniyor, setFaturaYukleniyor] = useState(false);
  const [faturaSatirlar, setFaturaSatirlar] = useState(null);
  const [faturaTarihi, setFaturaTarihi] = useState(null);
  const [faturaUyari, setFaturaUyari] = useState('');
  const [faturaKaydedilenler, setFaturaKaydedilenler] = useState({});

  // 📱 Telefon (foto) faturaları — şubeden gelen, OCR fiyat önerisi + kanıt fotoğrafı
  const [fotoFaturalar, setFotoFaturalar] = useState([]);
  const [fotoFaturaAcik, setFotoFaturaAcik] = useState(null);      // açık fatura id
  const [fotoFaturaDetay, setFotoFaturaDetay] = useState({});      // id -> {fatura, kalemler, siparis_kalemler}
  const [fotoKalemDuzen, setFotoKalemDuzen] = useState({});        // kalem_id -> {kalem_kodu, birim_maliyet_tl}
  const [fotoKalemKayit, setFotoKalemKayit] = useState({});        // kalem_id -> true
  const [fotoModalUrl, setFotoModalUrl] = useState(null);          // büyük foto overlay
  const [zamAlarmlar, setZamAlarmlar] = useState([]);              // 🔺 eşik üstü fiyat artışları

  useEffect(() => {
    api('/subeler').then(r => setSubeler(r || [])).catch(() => {});
  }, []);

  const fotoFaturaYukle = () => {
    api('/fatura/bekleyen').then(r => setFotoFaturalar((r && r.satirlar) || [])).catch(() => setFotoFaturalar([]));
  };
  useEffect(() => { fotoFaturaYukle(); }, []);

  const zamAlarmYukle = () => {
    api('/ops/fiyat-zam-alarmlari?gun=90').then(r => setZamAlarmlar((r && r.alarmlar) || [])).catch(() => setZamAlarmlar([]));
  };
  useEffect(() => { zamAlarmYukle(); }, []);
  const zamGorduldu = async (id) => {
    try {
      await api('/ops/fiyat-zam-alarmlari/goruldu', { method: 'POST', body: { id } });
      setZamAlarmlar(prev => prev.filter(a => a.id !== id));
    } catch (_) { /* yoksay */ }
  };

  const fotoFaturaAc = async (fid) => {
    if (fotoFaturaAcik === fid) { setFotoFaturaAcik(null); return; }
    setFotoFaturaAcik(fid);
    if (!fotoFaturaDetay[fid]) {
      try {
        const d = await api('/fatura/' + encodeURIComponent(fid));
        setFotoFaturaDetay(prev => ({ ...prev, [fid]: d }));
      } catch (e) { setMesaj({ m: e.message || 'Fatura yüklenemedi', t: 'error' }); }
    }
  };

  const fotoKalemOnayla = async (fid, kalem, kod, fy) => {
    const k = String(kod || '').trim();
    const fiyat = parseFloat(String(fy).replace(',', '.'));
    if (!k) { setMesaj({ m: 'Stok kalem kodu girin', t: 'error' }); return; }
    if (!(fiyat >= 0)) { setMesaj({ m: 'Geçerli fiyat girin', t: 'error' }); return; }
    try {
      const det = fotoFaturaDetay[fid];
      const ted = (det && det.fatura && det.fatura.tedarikci_ad) || null;
      await api('/fatura/kalem/' + encodeURIComponent(kalem.id) + '/onayla', { method: 'POST', body: {
        kalem_kodu: k, kalem_adi: kalem.ocr_ad || k, birim: kalem.birim || 'adet', birim_maliyet_tl: fiyat, tedarikci: ted,
      }});
      setFotoKalemKayit(prev => ({ ...prev, [kalem.id]: true }));
      setMesaj({ m: '✅ Fiyat onaylandı, güncellendi', t: 'success' });
    } catch (e) { setMesaj({ m: e.message || 'Onaylanamadı', t: 'error' }); }
  };

  // Dönem → tarih aralığı {bas, bit, label}. Backend bas/bit ile gerçek aralık çeker.
  const _iso = (d) => d.toISOString().slice(0, 10);
  const donemAralik = () => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const g = (n) => { const b = new Date(t); b.setDate(b.getDate() - n); return _iso(b); };
    if (donem === 'bugun') return { bas: _iso(t), bit: _iso(t), label: 'Bugün' };
    if (donem === '7') return { bas: g(6), bit: _iso(t), label: 'Son 7 gün' };
    if (donem === '30') return { bas: g(29), bit: _iso(t), label: 'Son 30 gün' };
    if (donem === 'ay') return { bas: _iso(new Date(t.getFullYear(), t.getMonth(), 1)), bit: _iso(t), label: 'Bu Ay' };
    if (donem === 'gecenay') return { bas: _iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), bit: _iso(new Date(t.getFullYear(), t.getMonth(), 0)), label: 'Geçen Ay' };
    if (donem === 'ozel' && ozelBas && ozelBit) return { bas: ozelBas, bit: ozelBit, label: 'Özel' };
    return { bas: g(6), bit: _iso(t), label: 'Son 7 gün' };
  };
  const _ar = donemAralik();
  const donemLabel = _ar.label;
  // Önceki eşit uzunluktaki pencere (KPI trend kıyası için)
  const oncekiAralik = (ar) => {
    const b = new Date(ar.bas + 'T00:00:00'), e = new Date(ar.bit + 'T00:00:00');
    const len = Math.round((e - b) / 86400000) + 1;
    const pe = new Date(b); pe.setDate(pe.getDate() - 1);
    const pb = new Date(pe); pb.setDate(pb.getDate() - (len - 1));
    return { bas: _iso(pb), bit: _iso(pe) };
  };

  const yukle = () => {
    setLoading(true);
    const ar = donemAralik();
    const onc = oncekiAralik(ar);
    const q = subeId ? `?sube_id=${encodeURIComponent(subeId)}` : '';
    const subeQ = subeId ? `&sube_id=${encodeURIComponent(subeId)}` : '';
    const _gunLen = Math.min(92, Math.round((new Date(ar.bit) - new Date(ar.bas)) / 86400000) + 1);
    Promise.all([
      api('/ops/maliyet/ozet' + q),
      api('/ops/maliyet/alis-fiyatlari'),
      api('/ops/maliyet/stok-kalemleri'),
      api(`/ops/maliyet/gun-gun?bas=${ar.bas}&bit=${ar.bit}${subeQ}`),
    ]).then(([ozet, fiyatlar, kalemler, gunGun]) => {
      setMaliyetData(ozet);
      setMaliyetFiyatlar(fiyatlar?.satirlar || []);
      setStokKalemleri(kalemler?.kalemler || []);
      setGunGunData(gunGun);
    }).catch(() => {}).finally(() => setLoading(false));
    // Önceki dönem (sadece KPI trend toplamları için)
    api(`/ops/maliyet/gun-gun?bas=${onc.bas}&bit=${onc.bit}${subeQ}`)
      .then(setGunGunOnceki).catch(() => setGunGunOnceki(null));
    // Faz 5 — güven skoru + sapma motoru (izole, hata yutar)
    api(`/ops/maliyet/guven-skoru?gun=${_gunLen}${subeQ}`)
      .then(setGuvenSkoru).catch(() => setGuvenSkoru(null));
  };

  useEffect(() => { yukle(); }, [subeId, donem, ozelBas, ozelBit]);

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
    setFaturaTarihi(null);
    setFaturaKaydedilenler({});
    try {
      // Çok-faturalı PDF: sayfalara böl → her faturayı LLM ile JSON'a çevir (vision YOK).
      // Aynı fatura no atlanır; tarih otomatik. Sonuç aşağıdaki "📱 Faturalar" listesinde.
      const fd = new FormData();
      fd.append('pdf', file);
      const res = await fetch('/api/fatura/yukle-pdf', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'PDF işlenemedi');
      const t = data.toplam_fatura || 0, y = data.yuklenen || 0, a = data.atlanan_mevcut || 0;
      setFaturaUyari(
        `✅ ${t} fatura bulundu · ${y} yeni alındı${a ? ` · ${a} zaten yüklüydü (atlandı)` : ''}. ` +
        `Arka planda okunuyor — birkaç saniye içinde aşağıdaki "📱 Faturalar" listesinde inceleyebilirsin.`
      );
      // OCR arka planda; bekleyen listesini birkaç kez tazele
      [4000, 9000, 16000].forEach(ms => setTimeout(() => {
        api('/fatura/bekleyen').then(r => setFotoFaturalar((r && r.satirlar) || [])).catch(() => {});
      }, ms));
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

  const faturaSatirAtla = (idx) => {
    setFaturaSatirlar(rows => rows.map((r, i) => i === idx ? { ...r, _atlandi: true } : r));
  };

  const faturaSatirGeriAl = (idx) => {
    setFaturaSatirlar(rows => rows.map((r, i) => i === idx ? { ...r, _atlandi: false } : r));
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
      gecerli_baslangic: s.gecerli_baslangic || null,
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Dönem seçici (GPT: en eksik #2 — bütün ekran buna bağlı) */}
          <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {[['bugun', 'Bugün'], ['7', '7 Gün'], ['30', '30 Gün'], ['ay', 'Bu Ay'], ['gecenay', 'Geçen Ay'], ['ozel', 'Özel']].map(([id, lbl], i) => (
              <button key={id} onClick={() => setDonem(id)} style={{
                padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 12,
                borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                fontWeight: donem === id ? 700 : 500,
                background: donem === id ? 'var(--accent)' : 'transparent',
                color: donem === id ? '#fff' : 'var(--text3)',
              }}>{lbl}</button>
            ))}
          </div>
          {donem === 'ozel' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="date" value={ozelBas} onChange={e => setOzelBas(e.target.value)} style={{ padding: '4px 6px' }} />
              <span style={{ color: 'var(--text3)' }}>→</span>
              <input type="date" value={ozelBit} onChange={e => setOzelBit(e.target.value)} style={{ padding: '4px 6px' }} />
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text3)' }}>Şube:</label>
            <select value={subeId} onChange={e => setSubeId(e.target.value)}>
              <option value="">Tüm Şubeler</option>
              {subeler.map(s => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Görev sekmeleri (GPT+kullanıcı tasarımı): farklı zihinsel modlar ── */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16, flexWrap: 'wrap' }}>
        {[['genel', '📊 Genel Bakış'], ['analiz', '🔍 Analiz'], ['fiyatlar', '🏷️ Fiyatlar'], ['faturalar', '🧾 Faturalar']].map(([id, lbl]) => (
          <button key={id} onClick={() => setSekme(id)} style={{
            padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 13, fontWeight: sekme === id ? 700 : 500,
            color: sekme === id ? 'var(--accent)' : 'var(--text3)',
            borderBottom: sekme === id ? '2px solid var(--accent)' : '2px solid transparent',
          }}>{lbl}</button>
        ))}
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

      {/* ── KPI ŞERİDİ — "Bugün para kazandık mı?" (gün-gün veriden hesaplanır) ── */}
      {sekme === 'genel' && (() => {
        const tumRows = gunGunData?.satirlar || [];
        // "Bugün yarım gün" / kapanmamış gün düzeltmesi: cirosu 0 olan günler
        // (veri eksik / gün kapanmamış) KPI'ya KATILMAZ — birikmiş maliyet yanlış
        // zarar göstermesin. P&L tablosu (Analiz) yine tüm günleri gösterir.
        const rows = tumRows.filter(s => (Number(s.ciro_tl) || 0) > 0);
        if (!tumRows.length) return null;
        if (!rows.length) return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>📊 Genel Bakış</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{donemLabel}{subeId ? '' : ' · tüm şubeler'}</span>
            </div>
            <div className="card" style={{ fontSize: 12, color: 'var(--text3)' }}>Bu dönemde henüz ciro kaydı yok — kâr hesaplanamaz.</div>
          </div>
        );
        const topla = (k) => rows.reduce((a, s) => a + (Number(s[k]) || 0), 0);
        const ciro = topla('ciro_tl');
        const maliyet = topla('genel_toplam');
        const netKar = topla('net_kar_tl');
        const marj = ciro > 0 ? (netKar / ciro) * 100 : null;
        const gunSayisi = new Set(rows.map(r => r.tarih)).size || rows.length;
        const netRenk = netKar > 0 ? 'var(--green)' : netKar < 0 ? 'var(--red)' : undefined;
        // Önceki eşit pencere (trend kıyası) — renk değil YÖN (GPT pattern)
        const orows = (gunGunOnceki?.satirlar || []).filter(s => (Number(s.ciro_tl) || 0) > 0);
        const oTopla = (k) => orows.reduce((a, s) => a + (Number(s[k]) || 0), 0);
        const oCiro = oTopla('ciro_tl'), oMaliyet = oTopla('genel_toplam'), oNet = oTopla('net_kar_tl');
        const oMarj = oCiro > 0 ? (oNet / oCiro) * 100 : null;
        const yon = (cur, prev, artisIyi) => {
          if (!orows.length || prev == null) return null;
          const d = cur - prev;
          if (Math.abs(d) < 0.005 * (Math.abs(prev) || 1)) return { ok: '▬', renk: 'var(--text3)', t: '%0' };
          const pct = prev !== 0 ? (d / Math.abs(prev)) * 100 : null;
          const arti = d > 0;
          const iyi = artisIyi ? arti : !arti;
          return { ok: arti ? '▲' : '▼', renk: iyi ? 'var(--green)' : 'var(--red)', t: pct == null ? '' : `%${Math.abs(pct).toFixed(0)}` };
        };
        const kart = (baslik, deger, alt, vurgu, tr) => (
          <div className="card" style={{ borderTop: vurgu ? `3px solid ${vurgu}` : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>{baslik}</div>
              {tr && <span style={{ fontSize: 11, fontWeight: 700, color: tr.renk, whiteSpace: 'nowrap' }}>{tr.ok} {tr.t}</span>}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)', color: vurgu || 'var(--text)' }}>{deger}</div>
            {alt && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{alt}</div>}
          </div>
        );
        return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>📊 Genel Bakış</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{donemLabel}{gunSayisi ? ` · ${gunSayisi} cirolu gün` : ''}{orows.length ? ' · ▲▼ geçen döneme göre' : ''}{subeId ? '' : ' · tüm şubeler'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {kart('✅ Net Kâr', fmt(netKar), `${gunSayisi} günde`, netRenk, yon(netKar, oNet, true))}
              {kart('Marj', marj == null ? '—' : `%${marj.toFixed(1)}`, 'net kâr / ciro', netRenk, marj != null && oMarj != null ? yon(marj, oMarj, true) : null)}
              {kart('💵 Ciro', fmt(ciro), `günlük ort. ${fmt(ciro / Math.max(1, gunSayisi))}`, undefined, yon(ciro, oCiro, true))}
              {kart('📉 Toplam Maliyet', fmt(maliyet), 'ürün+kira+komisyon+fire…', undefined, yon(maliyet, oMaliyet, false))}
            </div>
          </div>
        );
      })()}

      {/* Özet kartları (Analiz sekmesi) */}
      {sekme === 'analiz' && (
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
      )}

      {/* ── FAZ 5: GÜVEN SKORU + SAPMA MOTORU (öneri-only, hiçbir şeyi değiştirmez) ── */}
      {sekme === 'genel' && guvenSkoru && (() => {
        const skor = guvenSkoru.genel_skor ?? 0;
        const renk = skor >= 85 ? '#22c55e' : (skor >= 60 ? '#eab308' : '#ef4444');
        const durumRenk = (d) => d === 'iyi' ? '#22c55e' : (d === 'orta' ? '#eab308' : '#ef4444');
        const sapmalar = guvenSkoru.sapmalar || [];
        return (
          <div style={{ marginBottom: 16, border: `1px solid var(--border)`, borderRadius: 10, padding: 14, background: 'var(--bg2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }} onClick={() => setGuvenAcik(v => !v)}>
              <div style={{ position: 'relative', width: 54, height: 54, flexShrink: 0 }}>
                <svg viewBox="0 0 36 36" style={{ width: 54, height: 54, transform: 'rotate(-90deg)' }}>
                  <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border)" strokeWidth="3" />
                  <circle cx="18" cy="18" r="15.5" fill="none" stroke={renk} strokeWidth="3"
                    strokeDasharray={`${(skor / 100) * 97.4} 97.4`} strokeLinecap="round" />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: renk }}>{skor}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>🎯 Maliyet Güven Skoru {guvenSkoru.sube_id ? '' : '— Tüm Şubeler'}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
                  {sapmalar.length > 0
                    ? <span style={{ color: '#ef4444', fontWeight: 600 }}>⚠️ {sapmalar.length} şüpheli değer yakalandı (sapma motoru)</span>
                    : <span style={{ color: '#22c55e' }}>✓ Şüpheli değer yok</span>}
                  {' · '}maliyetin ne kadar güvenilir olduğu
                </div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{guvenAcik ? '▲ gizle' : '▼ detay'}</span>
            </div>

            {guvenAcik && (
              <div style={{ marginTop: 14 }}>
                {/* Kovalar */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, marginBottom: sapmalar.length ? 14 : 0 }}>
                  {(guvenSkoru.kovalar || []).map(k => (
                    <div key={k.kova} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{k.baslik}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: durumRenk(k.durum) }}>{k.skor}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 3, lineHeight: 1.35 }}>{k.mesaj}</div>
                    </div>
                  ))}
                </div>

                {/* Sapmalar */}
                {sapmalar.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#ef4444' }}>🔍 Sapma Motoru — şüpheli değerler (insan kontrolü gerek)</div>
                    {sapmalar.map((s, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', borderRadius: 7, marginBottom: 5,
                        background: s.siddet === 'kritik' ? 'rgba(239,68,68,0.10)' : 'rgba(234,179,8,0.08)',
                        border: `1px solid ${s.siddet === 'kritik' ? 'rgba(239,68,68,0.35)' : 'rgba(234,179,8,0.30)'}` }}>
                        <span style={{ fontSize: 13 }}>{s.tip === 'FIYAT_OUTLIER' ? '💸' : '📦'}</span>
                        <div style={{ flex: 1, fontSize: 11.5, lineHeight: 1.4 }}>
                          <span style={{ fontWeight: 600, color: s.siddet === 'kritik' ? '#ef4444' : '#b45309' }}>{s.kat}× </span>
                          {s.mesaj}
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4, fontStyle: 'italic' }}>
                      Bu motor sadece UYARIR — hiçbir sayıyı değiştirmez. Doğru olduğundan eminsen yok sayabilirsin.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── KÂR-ZARAR (P&L) — Ciro − Maliyet − Tahmini Vergi = Net Kâr ── */}
      {sekme === 'genel' && (<>
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>💰 Kâr-Zarar (Operasyonel){subeId ? '' : ' — Tüm Şubeler'}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Ciro − Maliyet − Tahmini Vergi (%25) = Net Kâr · KDV düşülmez · resmî muhasebe değil</span>
      </div>
      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="tablo">
          <thead>
            <tr>
              <th>Tarih</th>
              {!subeId && <th>Şube</th>}
              <th style={{ textAlign: 'right' }}>💵 Ciro</th>
              <th style={{ textAlign: 'right' }}>📉 Toplam Maliyet</th>
              <th style={{ textAlign: 'right' }}>Faaliyet Kârı</th>
              <th style={{ textAlign: 'right' }} title="max(0, faaliyet kârı) × %25">🏛️ Tahmini Vergi</th>
              <th style={{ textAlign: 'right' }}>✅ NET KÂR</th>
              <th style={{ textAlign: 'right' }}>Marj</th>
            </tr>
          </thead>
          <tbody>
            {(gunGunData?.satirlar || []).map((s, i) => {
              const net = Number(s.net_kar_tl) || 0;
              const renk = net > 0 ? 'var(--green)' : net < 0 ? 'var(--red)' : 'var(--text3)';
              return (
                <tr key={i}>
                  <td>{fmtDate(s.tarih)}</td>
                  {!subeId && <td>{s.sube_adi}</td>}
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(s.ciro_tl || 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)', cursor: 'help' }}
                    title={[
                      `Kira: ${fmt(s.kira_maliyet_tl || 0)}`,
                      `Faturalar (elektrik/su/gaz): ${fmt(s.fatura_maliyet_tl || 0)}`,
                      `Abonelikler: ${fmt(s.abonelik_maliyet_tl || 0)}`,
                      `POS komisyonu: ${fmt(s.pos_komisyon_tl || 0)}`,
                      `Platform komisyonu: ${fmt(s.platform_komisyon_tl || 0)}`,
                      `Fire: ${fmt(s.fire_maliyet_tl || 0)}`,
                      `İade: ${fmt(s.iade_maliyet_tl || 0)}`,
                      `Şube anlık gider: ${fmt(s.sube_anlik_gider_tl || 0)}`,
                      '(+ ürün-aç COGS + personel)',
                      'Hariç: kart faizi / finansman',
                    ].join('\n')}>{fmt(s.genel_toplam || 0)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.faaliyet_kari_tl || 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{fmt(s.tahmini_vergi_tl || 0)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: renk }}>{fmt(net)}</td>
                  <td style={{ textAlign: 'right', color: renk }}>{s.net_marj_pct == null ? '—' : `%${s.net_marj_pct}`}</td>
                </tr>
              );
            })}
            {(!gunGunData?.satirlar || gunGunData.satirlar.length === 0) && (
              <tr><td colSpan={subeId ? 7 : 8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>Veri yok</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginBottom: 16, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
        ✅ Maliyet = ürün-aç COGS + personel + anlık gider + kira + faturalar + <strong>abonelikler</strong> + POS/platform komisyonu + fire + iade. <strong>Toplam Maliyet üstüne gelince kırılım görünür.</strong> ❌ <strong>Kart faizi / finansman DAHİL DEĞİL</strong> (işletme üzerine düşen finansman yükü, operasyonel kârı kirletmez). ⚠️ <strong>İkram</strong> (Evo 0₺/iskonto) ve <strong>personel tüketimi</strong> henüz yok (ayrı/Evo kaynak). Faz 5 ✅ güven skoru + sapma motoru.
      </div>
      </>)}

      {/* Gün gün maliyet detayı — Ürün Aç (URUN_AC) tüketim verisi × güncel alış fiyatı */}
      {sekme === 'analiz' && (<>
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📅 Gün Gün Maliyet (Detay){subeId ? '' : ' — Tüm Şubeler'}</span>
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
      </>)}

      {/* Fiyat girişi / güncelleme formu (Fiyatlar sekmesi) */}
      {sekme === 'fiyatlar' && (<>
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
      </>)}

      {/* 🔺 Zam Alarmları — eşik üstü fiyat artışı (Akıllı Denetim sinyali) */}
      {sekme === 'fiyatlar' && zamAlarmlar.length > 0 && (
        <>
          <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
            <span>🔺 Zam Alarmları</span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>Eşik üstü fiyat artışı — onaylanan fatura fiyatından</span>
          </div>
          <div className="card" style={{ marginBottom: 16, border: '1px solid var(--red)' }}>
            {zamAlarmlar.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--red)', minWidth: 60 }}>🔺 +{a.artis_yuzde}%</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{a.kalem_adi || a.kalem_kodu}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>🚚 {a.tedarikci} · {fmt(a.eski_fiyat)}₺ → {fmt(a.yeni_fiyat)}₺ · {a.olusturma}</div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => zamGorduldu(a.id)}>Gördüm</button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── FATURALAR sekmesi: PDF yükle + telefon faturaları + foto modal ── */}
      {sekme === 'faturalar' && (<>
      {/* Fatura PDF yükleme — çok faturalı PDF (e-fatura) */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📄 Fatura PDF Yükle (toplu)</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Çok faturalı PDF'i ayırır · tarihleri otomatik eşler · aşağıda incelersin</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.5 }}>
          İçinde birden çok fatura olan PDF'i tek seferde at. Sistem her faturayı ayırır,
          tarih + ürün kodunu okur (vision yok → okuma hatası olmaz), aynı ürünü farklı
          tarihlerde tanır. Okunan faturalar aşağıdaki <strong>📱 Faturalar</strong> listesinde onayını bekler.
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>Fatura PDF (tek veya çok faturalı)</label>
          <input type="file" accept="application/pdf"
            onChange={e => faturaPdfYukle(e.target.files?.[0])} disabled={faturaYukleniyor} />
        </div>
        {faturaYukleniyor && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>PDF ayrıştırılıyor...</div>}
        {faturaUyari && <div style={{ fontSize: 12, color: 'var(--yellow)', marginBottom: 8 }}>⚠️ {faturaUyari}</div>}
        {faturaSatirlar?.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>
            📅 Fatura tarihi: {faturaTarihi ? fmtDate(faturaTarihi) : 'PDF\'ten okunamadı, fiyatlar bugünün tarihiyle kaydedilecek'}
          </div>
        )}

        {faturaSatirlar?.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {faturaSatirlar.map((s, idx) => {
              const fiyat = parseFloat(String(s.birim_maliyet_tl).replace(',', '.'));
              const fark = (s.onceki_fiyat != null && !isNaN(fiyat)) ? (fiyat - s.onceki_fiyat) : null;
              const yuzde = (fark !== null && s.onceki_fiyat > 0) ? (fark / s.onceki_fiyat) * 100 : null;
              const ok = fark === null ? null : fark > 0 ? '🔺' : fark < 0 ? '🔻' : '➖';
              const okRenk = fark > 0 ? 'var(--red)' : fark < 0 ? 'var(--green)' : 'var(--text3)';
              const kaydedildi = !!faturaKaydedilenler[idx];
              const atlandi = !!s._atlandi && !kaydedildi;
              if (atlandi) {
                return (
                  <div key={idx} style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--border)', opacity: 0.6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                      {s.urun_kodu && <span style={{ fontWeight: 700 }}>[{s.urun_kodu}] </span>}
                      {s.ham_metin} — geçildi
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => faturaSatirGeriAl(idx)}>Geri al</button>
                  </div>
                );
              }
              return (
                <div key={idx} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg3)', border: `1px solid ${kaydedildi ? 'var(--green)' : 'var(--border)'}` }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
                    {s.urun_kodu && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>[{s.urun_kodu}] </span>}
                    {s.ham_metin}
                    {s.miktar != null && <span> · {s.miktar} {s.birim || ''}</span>}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto auto', gap: 8, alignItems: 'center' }}>
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
                    {!kaydedildi && (
                      <button className="btn btn-ghost btn-sm" title="Bu satırı geç, kaydetme" onClick={() => faturaSatirAtla(idx)}>✕ Geç</button>
                    )}
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

      {/* 📱 Telefon (foto) faturaları — şubeden gelen, OCR fiyat önerisi + KANIT fotoğrafı */}
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>📱 Telefon Faturaları (öneri)</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>📷 ile şubenin çektiği faturayı gör · sen onaylayınca FİYAT güncellenir (stok değil)</span>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        {fotoFaturalar.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bekleyen telefon faturası yok.</div>
        ) : fotoFaturalar.map(f => {
          const acik = fotoFaturaAcik === f.id;
          const d = fotoFaturaDetay[f.id];
          return (
            <div key={f.id} style={{ borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--border)', marginBottom: 8, padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* 📷 KANIT: şubenin gönderdiği fatura fotoğrafı */}
                <button className="btn btn-ghost btn-sm" title="Şubenin gönderdiği fatura fotoğrafını gör"
                  onClick={() => setFotoModalUrl('/api/fatura/' + encodeURIComponent(f.id) + '/foto')}
                  style={{ fontSize: 20, padding: '2px 8px', lineHeight: 1 }}>📷</button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{f.tedarikci_ad || '(tedarikçi okunamadı)'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {f.sube_id}
                    {f.durum === 'ocr_bekliyor' ? ' · OCR sürüyor…' : f.durum === 'ocr_hata' ? ' · ⚠ OCR okunamadı' : (f.fatura_tarih ? ' · ' + fmtDate(f.fatura_tarih) : '')}
                    {f.toplam_tutar != null && ' · ' + fmt(f.toplam_tutar) + '₺'}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => fotoFaturaAc(f.id)}>{acik ? 'Kapat' : 'İncele'}</button>
                <button className="btn btn-ghost btn-sm" title="Bu faturayı sil (yanlış okundu/mükerrer)"
                  style={{ color: 'var(--red)' }}
                  onClick={async () => {
                    if (!window.confirm('Bu faturayı silmek istediğine emin misin? (Onaylanmış fiyat geçmişine dokunulmaz)')) return;
                    try {
                      const res = await fetch('/api/fatura/' + encodeURIComponent(f.id), { method: 'DELETE' });
                      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Silinemedi');
                      setFotoFaturalar(list => list.filter(x => x.id !== f.id));
                    } catch (e) { setMesaj({ m: 'Silme hatası: ' + (e.message || e), t: 'error' }); }
                  }}>🗑</button>
              </div>
              {acik && d && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {d.siparis_kalemler?.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>🧾 Sipariş: {d.siparis_kalemler.map(s => `${s.urun_ad}×${s.adet}`).join(', ')}</div>
                  )}
                  {(d.kalemler || []).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>OCR kalem bulamadı (📷 ile fotoğrafı kontrol et).</div>
                  )}
                  {(d.kalemler || []).map(k => {
                    const kayit = !!fotoKalemKayit[k.id];
                    const edit = fotoKalemDuzen[k.id] || {};
                    const kod = edit.kalem_kodu ?? (k.eslesen_stok_kodu || '');
                    const fy = edit.birim_maliyet_tl ?? (k.birim_fiyat != null ? String(k.birim_fiyat) : '');
                    return (
                      <div key={k.id}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1fr auto', gap: 6, alignItems: 'center' }}>
                          <input type="text" list="depo-kalem-listesi-sayfa" placeholder="Stok kodu" value={kod}
                            onChange={e => setFotoKalemDuzen(p => ({ ...p, [k.id]: { ...p[k.id], kalem_kodu: e.target.value } }))} disabled={kayit} />
                          <span style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.ocr_ad || ''}>
                            {k.ocr_ad || '—'}{k.adet != null ? ` ×${k.adet}` : ''}
                          </span>
                          <input type="text" inputMode="decimal" placeholder="₺" value={fy}
                            onChange={e => setFotoKalemDuzen(p => ({ ...p, [k.id]: { ...p[k.id], birim_maliyet_tl: e.target.value } }))} disabled={kayit} />
                          {kayit
                            ? <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 700, textAlign: 'center' }}>✅</span>
                            : <button className="btn btn-secondary btn-sm" onClick={() => fotoKalemOnayla(f.id, k, kod, fy)}>Onayla</button>}
                        </div>
                        {k.onceki_fiyat != null && k.birim_fiyat != null && (
                          <div style={{ marginTop: 3, fontSize: 10, color: k.fiyat_degisim > 0 ? 'var(--red)' : k.fiyat_degisim < 0 ? 'var(--green)' : 'var(--text3)' }}>
                            {k.fiyat_degisim > 0 ? '🔺' : k.fiyat_degisim < 0 ? '🔻' : '➖'} Önceki: {fmt(k.onceki_fiyat)} → {fmt(k.birim_fiyat)}
                            {k.fiyat_degisim_yuzde != null && ` (${k.fiyat_degisim > 0 ? '+' : ''}${k.fiyat_degisim_yuzde}%)`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Foto kanıt modalı — şubenin gönderdiği fatura görüntüsü */}
      {fotoModalUrl && (
        <div onClick={() => setFotoModalUrl(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.82)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <img src={fotoModalUrl} alt="Fatura fotoğrafı" onClick={e => e.stopPropagation()}
            style={{ maxWidth: '96%', maxHeight: '92%', borderRadius: 10, background: '#fff', boxShadow: '0 12px 48px rgba(0,0,0,.5)' }} />
        </div>
      )}
      </>)}

      {/* Güncel fiyat listesi + geçmiş/artış görseli (Fiyatlar sekmesi) */}
      {sekme === 'fiyatlar' && (<>
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
                    <button
                      onClick={() => setAcikKalem(acik ? null : g.kalem_kodu)}
                      title="Fiyat geçmişi / değişim yüzdesi / sil"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: ok ? 16 : 12, color: ok ? okRenk : 'var(--text3)', padding: 0, lineHeight: 1 }}
                    >{ok || '⋯'}</button>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`"${guncel.kalem_adi || g.kalem_kodu}" için bu fiyat kaydını silmek istediğine emin misin?`)) return;
                        try {
                          await api(`/ops/maliyet/alis-fiyat-sil/${guncel.id}`, { method: 'DELETE' });
                          setMesaj({ m: '✅ Fiyat kaydı silindi', t: 'success' });
                          yukle();
                        } catch (e) {
                          setMesaj({ m: 'Silme hatası: ' + (e.message || e), t: 'error' });
                        }
                      }}
                      title="Bu fiyat kaydını sil"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 14, color: 'var(--text3)', padding: 0, lineHeight: 1 }}
                    >🗑️</button>
                  </div>
                </div>
                {acik && onceki && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text2)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                    <span>{fmtDate(onceki.gecerli_baslangic)}: {fmt(onceki.birim_maliyet_tl)} → {fmtDate(guncel.gecerli_baslangic)}: {fmt(guncel.birim_maliyet_tl)}</span>
                    <span style={{ fontWeight: 700, color: okRenk }}>{fark > 0 ? '+' : ''}{yuzde.toFixed(1)}%</span>
                  </div>
                )}
                {acik && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`"${guncel.kalem_adi || g.kalem_kodu}" için TÜM fiyat geçmişini ve fatura eşleştirme hafızasını silmek istediğine emin misin? Bu işlem geri alınamaz.`)) return;
                        try {
                          await api(`/ops/maliyet/kalem-temizle/${g.kalem_kodu}`, { method: 'DELETE' });
                          setMesaj({ m: '✅ Kalemin tüm fiyat geçmişi ve eşleştirme hafızası silindi', t: 'success' });
                          setAcikKalem(null);
                          yukle();
                        } catch (e) {
                          setMesaj({ m: 'Silme hatası: ' + (e.message || e), t: 'error' });
                        }
                      }}
                      title="Bu kalemin tüm fiyat geçmişini ve fatura eşleştirme hafızasını sil"
                      style={{ background: 'transparent', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 6, cursor: 'pointer', fontSize: 10, padding: '4px 8px' }}
                    >🗑️ Tüm geçmişi temizle</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>)}
    </div>
  );
}
