import { useState, useEffect } from 'react';
import { api, fmt, fmtDate } from '../utils/api';
import IzlemePanosu from '../components/IzlemePanosu';
import FiyatPanosu from '../components/FiyatPanosu';

// 🧾 VERGİ AYARLARI — kalem bazlı KDV oranı düzenleme + kira stopaj özeti (2026-07-05)
function VergiAyarlari({ fmt }) {
  const [kdv, setKdv] = useState(null);
  const [stopaj, setStopaj] = useState(null);
  const [kayit, setKayit] = useState({});   // kalem_kodu → kaydediliyor
  const [ara, setAra] = useState('');
  const KDV_SECENEK = [1, 10, 20];

  const yukle = () => {
    api('/ops/maliyet/kdv-oranlari').then(setKdv).catch(() => setKdv({ satirlar: [] }));
    api('/ops/maliyet/stopaj-ozet').then(setStopaj).catch(() => setStopaj(null));
  };
  useEffect(() => { yukle(); }, []);

  const oranKaydet = async (s, yuzde) => {
    setKayit(k => ({ ...k, [s.kalem_kodu]: true }));
    try {
      await api('/ops/maliyet/kdv-oran-kaydet', { method: 'POST', body: { kalem_kodu: s.kalem_kodu, kalem_adi: s.kalem_adi, kdv_yuzde: yuzde } });
      setKdv(d => ({ ...d, satirlar: d.satirlar.map(x => x.kalem_kodu === s.kalem_kodu ? { ...x, kdv_yuzde: yuzde, kdv_oran: yuzde / 100, tanimli: true } : x) }));
    } catch (e) { alert(e.message || 'Kaydedilemedi'); }
    finally { setKayit(k => ({ ...k, [s.kalem_kodu]: false })); }
  };

  const satirlar = (kdv?.satirlar || []).filter(s =>
    !ara || (s.kalem_adi || '').toLowerCase().includes(ara.toLowerCase()) || (s.kalem_kodu || '').toLowerCase().includes(ara.toLowerCase()));

  return (
    <>
      {/* Kira stopajı */}
      {stopaj && stopaj.adet > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>🏠 Kira Stopajı <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(brüt kira P&L gideri; stopaj devlete)</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 8 }}>
            <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>Brüt kira (aylık)</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(stopaj.toplam_brut_tl)}</div>
            </div>
            <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px', borderLeft: '3px solid var(--orange)' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>Stopaj → vergi dairesi</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--orange)' }}>{fmt(stopaj.toplam_stopaj_tl)}</div>
            </div>
            <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>Net → mülk sahibi</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(stopaj.toplam_net_tl)}</div>
            </div>
          </div>
          <div className="table-wrap">
            <table><thead><tr><th>Kira</th><th style={{ textAlign: 'right' }}>Brüt</th><th style={{ textAlign: 'right' }}>%</th><th style={{ textAlign: 'right' }}>Stopaj</th><th style={{ textAlign: 'right' }}>Net</th></tr></thead>
              <tbody>{stopaj.satirlar.map(s => (
                <tr key={s.id}><td>{s.gider_adi}</td><td className="mono" style={{ textAlign: 'right' }}>{fmt(s.brut_tl)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>%{s.stopaj_yuzde}</td>
                  <td className="mono" style={{ textAlign: 'right', color: 'var(--orange)' }}>{fmt(s.stopaj_tl)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{fmt(s.net_odenecek_tl)}</td></tr>))}
              </tbody></table>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }}>{stopaj.not}</div>
        </div>
      )}
      {stopaj && stopaj.adet === 0 && (
        <div className="card" style={{ marginTop: 14, fontSize: 12, color: 'var(--text3)' }}>
          🏠 Kira stopajı tanımlı değil. Bir kira giderine stopaj oranı (%20) eklerseniz burada özetlenir. (Şahıstan işyeri kirasında geçerli.)
        </div>
      )}

      {/* Kalem KDV oranları */}
      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>📋 Kalem KDV Oranları <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(alış — indirilecek KDV bundan hesaplanır)</span></span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={async () => {
              if (!confirm('Tüm kalemlere KDV oranı ada göre otomatik atansın mı? (Elle ayarladıklarınız korunur)')) return;
              try { const r = await api('/ops/maliyet/kdv-oran-otomatik', { method: 'POST' }); alert(`✓ ${r.toplam} kaleme atandı: ${JSON.stringify(r.atanan)}`); yukle(); }
              catch (e) { alert(e.message || 'Başarısız'); }
            }} className="btn btn-primary btn-sm" style={{ fontSize: 11 }}>⚡ Otomatik Ata</button>
            <input value={ara} onChange={e => setAra(e.target.value)} placeholder="Kalem ara…"
              style={{ padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', fontSize: 12, width: 140 }} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
          Kahve/süt gibi temel gıda %1, çoğu içecek %10, ambalaj/bardak %20. Varsayılan %{kdv?.varsayilan_yuzde || 10}. Değiştirdiğinde anında kaydolur.
        </div>
        {!kdv ? <div style={{ color: 'var(--text3)', padding: 20 }}>Yükleniyor…</div>
          : satirlar.length === 0 ? <div style={{ color: 'var(--text3)', padding: 20, fontSize: 12 }}>Alış fiyatı tanımlı kalem yok — önce Fiyatlar sekmesinden fiyat girin, sonra KDV oranını ayarlayın.</div>
            : (
              <div className="table-wrap">
                <table><thead><tr><th>Kalem</th><th style={{ textAlign: 'center' }}>KDV Oranı</th></tr></thead>
                  <tbody>{satirlar.slice(0, 200).map(s => (
                    <tr key={s.kalem_kodu}>
                      <td>{s.kalem_adi}{!s.tanimli && <span style={{ fontSize: 10, color: 'var(--text3)' }}> · varsayılan</span>}</td>
                      <td style={{ textAlign: 'center' }}>
                        <div style={{ display: 'inline-flex', gap: 4 }}>
                          {KDV_SECENEK.map(y => (
                            <button key={y} disabled={kayit[s.kalem_kodu]} onClick={() => oranKaydet(s, y)}
                              style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                border: `1px solid ${Math.round(s.kdv_yuzde) === y ? 'var(--accent)' : 'var(--border)'}`,
                                background: Math.round(s.kdv_yuzde) === y ? 'var(--accent-dim, rgba(80,160,120,0.15))' : 'var(--bg2)',
                                color: Math.round(s.kdv_yuzde) === y ? 'var(--accent)' : 'var(--text2)' }}>%{y}</button>
                          ))}
                        </div>
                      </td>
                    </tr>))}
                  </tbody></table>
              </div>
            )}
      </div>
    </>
  );
}

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
  const [isMobil, setIsMobil] = useState(typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const h = () => setIsMobil(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  const [maliyetData, setMaliyetData] = useState(null);
  const [maliyetFiyatlar, setMaliyetFiyatlar] = useState([]);
  const [stokKalemleri, setStokKalemleri] = useState([]);
  const [gunGunData, setGunGunData] = useState(null);
  const [subeOzetler, setSubeOzetler] = useState([]);   // Analiz: şube karşılaştırma kartları
  const [guvenSkoru, setGuvenSkoru] = useState(null);   // Faz 5: güven skoru + sapma motoru
  const [vergiOzet, setVergiOzet] = useState(null);     // Faz 1b: şube bazlı tahmini vergi
  const [kdvPoz, setKdvPoz] = useState(null);           // Faz 3: KDV pozisyonu (P&L dışı)
  const [guvenAcik, setGuvenAcik] = useState(false);    // detay aç/kapa
  const [sekme, setSekme] = useState('genel');          // genel | analiz | fiyatlar | faturalar
  const [altSekme, setAltSekme] = useState('ozet');     // genel-içi detay: ozet | vergi | pnl
  const [donem, setDonem] = useState('7');              // gun | bugun | 7 | 30 | ay | gecenay | ozel
  const [ozelBas, setOzelBas] = useState('');           // Özel aralık başlangıç (YYYY-MM-DD)
  const [ozelBit, setOzelBit] = useState('');           // Özel aralık bitiş
  const [seciliGun, setSeciliGun] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }); // 'Gün' modu — YEREL tarih (UTC değil), ◀▶ gezinir
  const [gunGunOnceki, setGunGunOnceki] = useState(null); // önceki eşit pencere (KPI trend için)
  const [maliyetDetayAcik, setMaliyetDetayAcik] = useState(true); // Toplam Maliyet drill-down (görünürlük için açık başlar)
  const [loading, setLoading] = useState(false);
  const [mesaj, setMesaj] = useState(null); // {m, t}

  const [maliyetForm, setMaliyetForm] = useState({ kalem_kodu: '', kalem_adi: '', birim: 'adet', birim_maliyet_tl: '', tedarikci: '', notlar: '' });
  const [kaydediliyor, setKaydediliyor] = useState(false);
  const [acikKalem, setAcikKalem] = useState(null);
  const [fiyatAra, setFiyatAra] = useState('');   // Fiyatlar sekmesi güncel liste araması

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
  // YEREL tarih (Y-M-D) — toISOString UTC'ye çevirip gün kaydırıyordu (TR=UTC+3 → ◀▶ 2-3 gün atlardı)
  const _iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const donemAralik = () => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const g = (n) => { const b = new Date(t); b.setDate(b.getDate() - n); return _iso(b); };
    if (donem === 'gun') return { bas: seciliGun, bit: seciliGun, label: fmtDate(seciliGun) };
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
    // Faz 1b — şube bazlı tahmini vergi (izole; endpoint max 31 gün)
    api(`/ops/maliyet/vergi-ozet?gun=${Math.min(31, _gunLen)}${subeQ}`)
      .then(setVergiOzet).catch(() => setVergiOzet(null));
    // Faz 3 — KDV pozisyonu (izole, P&L dışı)
    api(`/ops/maliyet/kdv-pozisyon?gun=${Math.min(92, _gunLen)}${subeQ}`)
      .then(setKdvPoz).catch(() => setKdvPoz(null));
  };

  useEffect(() => { yukle(); }, [subeId, donem, ozelBas, ozelBit, seciliGun]);

  // ⚖️ Ciro Fark Defteri (Evo ↔ Kasa) — P&L ciro kaynağı kararları
  const [fdefter, setFdefter] = useState(null);
  const [fdSube, setFdSube] = useState(null); // null = tüm şubeler
  const fdYukle = () => api('/ciro-taslak/fark-defteri?gun=45').then(setFdefter).catch(() => setFdefter(null));
  useEffect(() => { fdYukle(); }, []);
  async function farkKarar(id, karar) {
    try {
      await api(`/ciro-taslak/fark-defteri/${id}/karar`, { method: 'POST', body: { karar } });
      fdYukle();
      yukle(); // P&L cirosu karara göre değişir — tazele
    } catch (e) { alert(e?.message || 'karar kaydedilemedi'); }
  }
  async function farkGidereYaz(id) {
    try {
      const r = await api(`/ciro-taslak/fark-defteri/${id}/gidere-yaz`, { method: 'POST', body: {} });
      alert(`${fmt(r?.tutar)} kasa açığı anlık gider olarak yazıldı.`);
      fdYukle();
      yukle();
    } catch (e) { alert(e?.message || 'gidere yazılamadı'); }
  }
  // ⚖️ Kasa Hataları onayı (sahip 2026-07-18: Onay Kuyruğu'ndan KALDIRILDI,
  // Maliyet'te İSTEĞE BAĞLI bölüm oldu) — aynı onay-kuyruğu uçları kullanılır
  const [khListe, setKhListe] = useState([]);
  const [khAcik, setKhAcik] = useState(false);
  const khYukle = () => api('/onay-kuyrugu?durum=bekliyor&limit=400')
    .then(d => setKhListe((d || []).filter(o => String(o.islem_turu || '').toUpperCase().includes('KASA'))))
    .catch(() => setKhListe([]));
  useEffect(() => { khYukle(); }, []);
  async function khOnayla(id) {
    try { await api(`/onay-kuyrugu/${id}/onayla`, { method: 'POST' }); khYukle(); yukle(); }
    catch (e) { alert(e?.message || 'onaylanamadı'); }
  }
  async function khReddet(id) {
    if (!window.confirm('Bu kasa hatası kaydı reddedilsin mi? (plan iptal olur, kaynak aktif kalır)')) return;
    try { await api(`/onay-kuyrugu/${id}/reddet`, { method: 'POST', body: { neden: 'maliyet_ekrani_red' } }); khYukle(); }
    catch (e) { alert(e?.message || 'reddedilemedi'); }
  }
  async function farkGelireYaz(id) {
    try {
      const r = await api(`/ciro-taslak/fark-defteri/${id}/gelire-yaz`, { method: 'POST', body: {} });
      alert(`${fmt(r?.tutar)} kasa fazlası dış kaynak geliri olarak yazıldı.`);
      fdYukle();
      yukle();
    } catch (e) { alert(e?.message || 'gelire yazılamadı'); }
  }

  // Analiz sekmesi — TÜM (satış) şubelerin dönem özeti (karşılaştırma kartları için)
  useEffect(() => {
    if (sekme !== 'analiz' || !subeler.length) return;
    const ar = donemAralik();
    const liste = subeler.filter(s => s.id !== 'sube-merkez');
    Promise.all(liste.map(s =>
      api(`/ops/maliyet/gun-gun?bas=${ar.bas}&bit=${ar.bit}&sube_id=${encodeURIComponent(s.id)}`)
        .then(d => {
          const sat = d?.satirlar || [];
          const T = k => sat.reduce((a, x) => a + (Number(x[k]) || 0), 0);
          // FIX C6 (2026-07-05): net_kar_net_tl (harman vergi+KDV arındırma) — net_kar_tl eski/düz%25
          const ciro = T('ciro_tl'), gider = T('genel_toplam'), net = sat.reduce((a, x) => a + (Number(x.net_kar_net_tl ?? x.net_kar_tl) || 0), 0);
          // G7 (2026-07-07): marj tanım birliği — net kâr / NET SATIŞ (KDV hariç);
          // brüt ciro tabanı marjı sistematik ~%9 düşük gösteriyordu
          const netSatis = T('net_satis_tl') || ciro;
          return { sube_id: s.id, ad: s.ad || s.id, ciro, gider, net, marj: netSatis > 0 ? (net / netSatis) * 100 : null };
        })
        .catch(() => ({ sube_id: s.id, ad: s.ad || s.id, ciro: 0, gider: 0, net: 0, marj: null }))
    )).then(r => setSubeOzetler(r.sort((a, b) => b.ciro - a.ciro))).catch(() => {});
  }, [sekme, donem, ozelBas, ozelBit, seciliGun, subeler]);

  // 'Gün' modu — ◀ / ▶ ile gün gezin (geleceğe gitme)
  const _bugunIso = _iso(new Date(new Date().setHours(0, 0, 0, 0)));
  const gunKaydir = (delta) => {
    const d = new Date(seciliGun + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    const yeni = _iso(d);
    if (yeni > _bugunIso) return;
    setDonem('gun');
    setSeciliGun(yeni);
  };

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

  // ── Fiyatı girilmemiş ürünler ──────────────────────────────────────────────
  // Depo kataloğunda var ama urun_alis_fiyat'ta hiç kaydı olmayan kalemler.
  // Bunlar tüketilince maliyet 0₺ sayılır → kâr olduğundan yüksek görünür.
  const fiyatliKodSet = new Set(gruplar.map(g => g.kalem_kodu));
  const fiyatsizUrunler = stokKalemleri
    .filter(k => !fiyatliKodSet.has(k.kalem_kodu))
    .sort((a, b) => (a.kalem_adi || a.kalem_kodu || '').localeCompare(b.kalem_adi || b.kalem_kodu || '', 'tr'));
  // Dönemde tüketilen ama fiyatsız kalemler (acil — kârı aktif olarak şişiriyor)
  const tuketilenFiyatsiz = gunGunData?.fiyat_eksik_kalemler || [];

  // ── Eksik maliyet tespiti (kira / personel girilmemişse de kâr şişer) ──
  // Sadece cirosu>0 günlerden topla (kapanmamış/eksik gün maliyeti yanıltmasın).
  const _ggCirolu = (gunGunData?.satirlar || []).filter(s => (Number(s.ciro_tl) || 0) > 0);
  const donemKiraTL = _ggCirolu.reduce((a, s) => a + (Number(s.kira_maliyet_tl) || 0), 0);
  const donemPersonelTL = _ggCirolu.reduce((a, s) => a + (Number(s.personel_maliyet_tl) || 0), 0);
  const donemFaturaTL = _ggCirolu.reduce((a, s) => a + (Number(s.fatura_maliyet_tl) || 0), 0);
  const donemAbonelikTL = _ggCirolu.reduce((a, s) => a + (Number(s.abonelik_maliyet_tl) || 0), 0);
  const ciroluGunVar = _ggCirolu.length > 0;

  // ── Fatura kalemi → katalog kalemi öneri (eşleşmeyenler için, öneri-only) ──
  // Faturadaki OCR adından (ör. "8*24 ...FROZEN PİPET") katalogdaki kalemi
  // (ör. "Pipet") kelime kesişimiyle bulur. Fuzzy değil — ortak KELİME bazlı,
  // insan onaylar. UUID kodlu kalemleri elle aramak zorunda kalınmasın diye.
  const _kelimeBol = (s) => (s || '')
    .toLocaleLowerCase('tr')
    .replace(/[^a-zçğıöşü0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !['ve','ile','adet','baskili','baskılı','li','lı'].includes(w));
  // Çoklu öneri: en olası katalog kalemleri (kullanıcı doğru olanı tıklar; öneri yanlışsa
  // diğerini seçer veya kutuya kendi yazar). Kelime kesişim skoruna göre sıralı, top N.
  const kalemOnerileri = (ocrAd, n = 4) => {
    const oc = new Set(_kelimeBol(ocrAd));
    if (!oc.size) return [];
    const skorlu = [];
    for (const k of stokKalemleri) {
      const kw = _kelimeBol(k.kalem_adi);
      if (!kw.length) continue;
      const kesisim = kw.filter(w => oc.has(w)).length;
      if (!kesisim) continue;
      skorlu.push({ kalem_kodu: k.kalem_kodu, kalem_adi: k.kalem_adi, _skor: kesisim / kw.length });
    }
    skorlu.sort((a, b) => b._skor - a._skor);
    return skorlu.filter(x => x._skor >= 0.34).slice(0, n);
  };

  // Fiyatlar sekmesindeki forma kalemi doldur + en üste kaydır
  const fiyatFormaDoldur = (kalemKodu, kalemAdi) => {
    setMaliyetForm(f => ({ ...f, kalem_kodu: kalemKodu, kalem_adi: kalemAdi || kalemKodu, birim_maliyet_tl: '' }));
    setSekme('fiyatlar');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
  };

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
            {[['gun', 'Gün'], ['bugun', 'Bugün'], ['7', '7 Gün'], ['30', '30 Gün'], ['ay', 'Bu Ay'], ['gecenay', 'Geçen Ay'], ['ozel', 'Özel']].map(([id, lbl], i) => (
              <button key={id} onClick={() => setDonem(id)} style={{
                padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 12,
                borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                fontWeight: donem === id ? 700 : 500,
                background: donem === id ? 'var(--accent)' : 'transparent',
                color: donem === id ? '#fff' : 'var(--text3)',
              }}>{lbl}</button>
            ))}
          </div>
          {/* 'Gün' modu — gün gün ileri/geri */}
          {donem === 'gun' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <button onClick={() => gunKaydir(-1)} title="Önceki gün" style={{ padding: '4px 10px', cursor: 'pointer', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text1)' }}>◀</button>
              <input type="date" value={seciliGun} max={_bugunIso} onChange={e => setSeciliGun(e.target.value)} style={{ padding: '4px 6px' }} />
              <button onClick={() => gunKaydir(1)} disabled={seciliGun >= _bugunIso} title="Sonraki gün"
                style={{ padding: '4px 10px', cursor: seciliGun >= _bugunIso ? 'not-allowed' : 'pointer', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: seciliGun >= _bugunIso ? 'var(--text3)' : 'var(--text1)', opacity: seciliGun >= _bugunIso ? 0.5 : 1 }}>▶</button>
            </div>
          )}
          {donem === 'ozel' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="date" value={ozelBas} onChange={e => setOzelBas(e.target.value)} style={{ padding: '4px 6px' }} />
              <span style={{ color: 'var(--text3)' }}>→</span>
              <input type="date" value={ozelBit} onChange={e => setOzelBit(e.target.value)} style={{ padding: '4px 6px' }} />
            </div>
          )}
        </div>
      </div>

      {/* ── Şube sekmeleri (dropdown yerine; tek tıkla şube gez) ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {[{ id: '', ad: '🏢 Tüm Şubeler' }, ...subeler].map(s => (
          <button key={s.id || 'all'} onClick={() => setSubeId(s.id)} style={{
            padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12,
            fontWeight: subeId === s.id ? 700 : 500,
            border: `1px solid ${subeId === s.id ? 'var(--accent)' : 'var(--border)'}`,
            background: subeId === s.id ? 'var(--accent)' : 'transparent',
            color: subeId === s.id ? '#fff' : 'var(--text2)',
          }}>{s.ad || s.id}</button>
        ))}
      </div>

      {/* ── Görev sekmeleri (sahip 2026-07-19: 'alt sekmeler nelerin daha fazla
          gösterdiğini göstermeli') — her sekme etiket + kısa açıklama satırı ── */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          ['genel', '📊 Kâr Özeti', 'para kazandık mı?'],
          ['analiz', '🔍 Analiz', 'şube & gün kırılımı'],
          ['fiyatlar', '🏷️ Fiyatlar', 'artışlar + giriş + tam liste'],
          ['izleme', '📦 Depo İzleme', 'kalanlar + gün gün düşüm'],
          ['faturalar', '🧾 Faturalar', 'PDF fatura arşivi'],
        ].map(([id, lbl, alt]) => (
          <button key={id} onClick={() => setSekme(id)} style={{
            padding: '7px 14px 6px', border: 'none', background: 'transparent', cursor: 'pointer',
            textAlign: 'left', lineHeight: 1.2,
            borderBottom: sekme === id ? '2px solid var(--accent)' : '2px solid transparent',
          }}>
            <div style={{ fontSize: 13, fontWeight: sekme === id ? 700 : 500,
                          color: sekme === id ? 'var(--accent)' : 'var(--text2, var(--text))' }}>{lbl}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>{alt}</div>
          </button>
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
        // Kapalı sezon düzeltmesi: cirosu 0 ama KİRA/FATURA/ABONELİK gideri devam eden
        // gün GERÇEK zarardır (kapalı şube hâlâ kira ödüyor) → KPI'ya KATILIR, gösterilir.
        // Sadece "bugünün yarım günü" (ciro henüz işlenmemiş) hariç tutulur.
        const _bugunIso = _iso(new Date());
        const _sabitGider = (s) => (Number(s.kira_maliyet_tl) || 0) + (Number(s.fatura_maliyet_tl) || 0) + (Number(s.abonelik_maliyet_tl) || 0);
        const rows = tumRows.filter(s => {
          if ((Number(s.ciro_tl) || 0) > 0) return true;                  // açık/satışlı gün
          if (_sabitGider(s) > 0 && s.tarih !== _bugunIso) return true;   // kapalı ama kira ödenen gün = zarar
          return false;
        });
        const _kapaliZararVar = rows.length > 0 && rows.every(s => (Number(s.ciro_tl) || 0) === 0);
        if (!tumRows.length) return null;
        if (!rows.length) return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>📊 Genel Bakış</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{donemLabel}{subeId ? '' : ' · tüm şubeler'}</span>
            </div>
            <div className="card" style={{ fontSize: 12, color: 'var(--text3)' }}>Bu dönemde ne ciro ne de sabit gider (kira) kaydı var.</div>
          </div>
        );
        const topla = (k) => rows.reduce((a, s) => a + (Number(s[k]) || 0), 0);
        const ciro = topla('ciro_tl');
        const netSatis = topla('net_satis_tl') || (ciro / 1.10);   // FAZ 2: KDV hariç
        const maliyet = topla('genel_toplam');
        // FAZ 2: ana net kâr = net satış − maliyet − DOĞRU şube vergisi (şahıs/şirket), fire hariç
        const netKar = topla('net_kar_net_tl');
        const marj = netSatis > 0 ? (netKar / netSatis) * 100 : null;   // net marj (KDV hariç)
        const gunSayisi = new Set(rows.map(r => r.tarih)).size || rows.length;
        const netRenk = netKar > 0 ? 'var(--green)' : netKar < 0 ? 'var(--red)' : undefined;
        // Önceki eşit pencere (trend kıyası) — renk değil YÖN (GPT pattern)
        const orows = (gunGunOnceki?.satirlar || []).filter(s => (Number(s.ciro_tl) || 0) > 0);
        const oTopla = (k) => orows.reduce((a, s) => a + (Number(s[k]) || 0), 0);
        const oCiro = oTopla('ciro_tl'), oMaliyet = oTopla('genel_toplam'), oNet = oTopla('net_kar_net_tl');
        const oNetSatis = oTopla('net_satis_tl') || (oCiro / 1.10);
        const oMarj = oNetSatis > 0 ? (oNet / oNetSatis) * 100 : null;
        const yon = (cur, prev, artisIyi) => {
          if (!orows.length || prev == null) return null;
          const d = cur - prev;
          if (Math.abs(d) < 0.005 * (Math.abs(prev) || 1)) return { ok: '▬', renk: 'var(--text3)', t: '%0' };
          const pct = prev !== 0 ? (d / Math.abs(prev)) * 100 : null;
          const arti = d > 0;
          const iyi = artisIyi ? arti : !arti;
          return { ok: arti ? '▲' : '▼', renk: iyi ? 'var(--green)' : 'var(--red)', t: pct == null ? '' : `%${Math.abs(pct).toFixed(0)}` };
        };
        // Sparkline (kart içi mini trend) — eski→yeni
        const sparkline = (vals, renk) => {
          const arr = (vals || []).filter(v => v != null);
          if (arr.length < 2) return null;
          const w = 100, h = 22, mn = Math.min(...arr), mx = Math.max(...arr), rng = (mx - mn) || 1;
          const pts = arr.map((v, i) => `${(i / (arr.length - 1)) * w},${h - ((v - mn) / rng) * (h - 2) - 1}`).join(' ');
          return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 22, marginTop: 4, display: 'block' }}><polyline points={pts} fill="none" stroke={renk} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
        };
        const krono = [...rows].reverse();
        const netSeri = krono.map(s => Number(s.net_kar_net_tl) || 0);
        const ciroSeri = krono.map(s => Number(s.ciro_tl) || 0);
        // Maliyet kovaları (Toplam Maliyet drill-down)
        const kovalar = [
          ['Malzeme (ürün-aç)', 'toplam'], ['Personel', 'personel_maliyet_tl'],
          ['İşveren SGK payı', 'sgk_isveren_tl'],
          ['Kira', 'kira_maliyet_tl'], ['Faturalar', 'fatura_maliyet_tl'],
          ['Abonelikler', 'abonelik_maliyet_tl'], ['POS komisyonu', 'pos_komisyon_tl'],
          ['Platform komisyonu', 'platform_komisyon_tl'], ['Fire', 'fire_maliyet_tl'],
          ['İade', 'iade_maliyet_tl'], ['Şube anlık gider', 'sube_anlik_gider_tl'],
        ].map(([ad, k]) => ({ ad, tutar: topla(k) })).filter(x => x.tutar > 0.005).sort((a, b) => b.tutar - a.tutar);
        {/* Kart dili = ⚖️ Evo↔Fiziki Kasa kartıyla AYNI (sahip 2026-07-19:
            'Marj/Ciro kartları Evo-Fiziki gibi kart olsun'): renkli üst şerit +
            çerçeveli trend ROZETİ (▲%X) + mono büyük değer + alt not. */}
        const kart = (baslik, deger, alt, vurgu, tr, spark, tikla) => (
          <div className="card" onClick={tikla}
            style={{ borderTop: `3px solid ${vurgu || 'var(--border)'}`, cursor: tikla ? 'pointer' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text2, var(--text))', marginBottom: 4 }}>{baslik}</div>
              {tr && (
                <span style={{ fontSize: 11.5, fontWeight: 800, color: tr.renk, whiteSpace: 'nowrap',
                               padding: '2px 10px', borderRadius: 9, border: `1px solid ${tr.renk}` }}>
                  {tr.ok} {tr.t}
                </span>
              )}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                          color: vurgu || 'var(--text)' }}>{deger}</div>
            {spark}
            {alt && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{alt}</div>}
          </div>
        );
        return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>📊 Genel Bakış</span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{donemLabel}{gunSayisi ? ` · ${gunSayisi} ${_kapaliZararVar ? 'kapalı gün' : 'cirolu gün'}` : ''}{orows.length ? ' · ▲▼ geçen döneme göre' : ''}{subeId ? '' : ' · tüm şubeler'}</span>
            </div>
            {_kapaliZararVar && (
              <div style={{ marginBottom: 10, padding: '10px 13px', borderRadius: 10, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.40)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>🏚️</span>
                <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                  <strong style={{ color: '#ef4444' }}>Kapalı sezon — satış yok ama sabit gider sürüyor.</strong> Bu dönemde ciro girilmemiş; kira/fatura/abonelik gibi sabit giderler devam ettiği için sonuç <strong>zarar</strong>. Aşağıdaki net kâr eksi görünmesi normaldir.
                </div>
              </div>
            )}
            {/* HERO: Net Kâr — sayfanın ana cevabı, büyük ve vurgulu */}
            {(() => {
              const tr = yon(netKar, oNet, true);
              return (
                <div className="card mk-rise" style={{ borderTop: `3px solid ${netRenk || 'var(--accent)'}`, marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {netKar >= 0 ? '✅' : '🔴'} Net Kâr
                      {tr && <span style={{ fontSize: 11, fontWeight: 700, color: tr.renk }}>{tr.ok} {tr.t}</span>}
                    </div>
                    <div style={{ fontSize: 34, fontWeight: 800, fontFamily: 'var(--font-mono)', color: netRenk, lineHeight: 1.1 }}>{fmt(netKar)} ₺</div>
                    <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 5 }}>
                      {gunSayisi} {_kapaliZararVar ? 'kapalı gün' : 'cirolu gün'}{marj != null ? ` · marj %${marj.toFixed(1)}` : ''} · günlük ort. {fmt(netKar / Math.max(1, gunSayisi))}
                    </div>
                  </div>
                  <div style={{ width: 170, flexShrink: 0 }}>{sparkline(netSeri, netKar >= 0 ? 'var(--green)' : 'var(--red)')}</div>
                </div>
              );
            })()}
            {/* Alt KPI üçlüsü */}
            <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {kart('Marj', marj == null ? '—' : `%${marj.toFixed(1)}`, 'net kâr / net satış (KDV hariç)', netRenk, marj != null && oMarj != null ? yon(marj, oMarj, true) : null)}
              {kart('💵 Ciro (KDV dahil)', fmt(ciro), `günlük ort. ${fmt(ciro / Math.max(1, gunSayisi))}`, 'var(--accent)', yon(ciro, oCiro, true), sparkline(ciroSeri, 'var(--accent)'))}
              {kart('📉 Toplam Maliyet (KDV dahil)', fmt(maliyet), maliyetDetayAcik ? 'kapat ▴' : 'kırılımı gör ▾ · KDV-hariç net maliyet P&L tablosunda', '#f59e0b', yon(maliyet, oMaliyet, false), null, () => setMaliyetDetayAcik(v => !v))}
            </div>

            {/* ⚖️ EVO ↔ FİZİKİ KASA (sahip 2026-07-19: "personelin girdiği kasa
                doğru; Evo ile kasanın görüntüsünü yaz — fark fiziki kasaya göre:
                fazla YEŞİL, açık KIRMIZI; haftalıkta +/− farklar toplanır").
                Fark yalnız iki değerin de bilindiği günlerden; kasa girilmeyen
                günde ciro Evo'dan alınır ve fark sayılmaz. */}
            {(() => {
              const farkGunler = tumRows.filter(s => s.kasa_fark_tl != null);
              const evoYedekGun = tumRows.filter(s => s.ciro_kaynak === 'evo').length;
              const evoKararGun = tumRows.filter(s => s.ciro_kaynak === 'evo_dogru').length;
              if (!farkGunler.length && !evoYedekGun) return null;
              const kasaT = tumRows.reduce((a, s) => a + (Number(s.kasa_ciro_tl) || 0), 0);
              const evoT = tumRows.reduce((a, s) => a + (s.evo_ciro_tl != null
                ? Number(s.evo_ciro_tl) : (Number(s.kasa_ciro_tl) || 0)), 0);
              const fark = farkGunler.reduce((a, s) => a + (Number(s.kasa_fark_tl) || 0), 0);
              const renk = fark > 0 ? 'var(--green)' : fark < 0 ? 'var(--red)' : 'var(--text3)';
              const etiket = fark > 0 ? `+${fmt(fark)} FAZLA` : fark < 0 ? `−${fmt(Math.abs(fark))} AÇIK` : 'FARK YOK';
              return (
                <div className="card mk-rise" style={{ marginTop: 12, borderTop: `3px solid ${renk}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>⚖️ Evo ↔ Fiziki Kasa</div>
                    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                        🖥 Evo <b style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text)' }}>{fmt(evoT)}</b>
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                        💵 Kasa <b style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text)' }}>{fmt(kasaT)}</b>
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 16, color: renk,
                                     padding: '3px 12px', borderRadius: 9, border: `1px solid ${renk}` }}>{etiket}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                    Fark fiziki kasaya göre: kasa fazlaysa <b style={{ color: 'var(--green)' }}>yeşil fazla</b>, eksikse <b style={{ color: 'var(--red)' }}>kırmızı açık</b>.
                    Dönem seçiminde günlük +/− farklar toplanır{farkGunler.length ? ` (${farkGunler.length} farklı gün)` : ''}.
                    Ciro kaynağı: personelin girdiği kasa esas{evoYedekGun > 0 ? `; ${evoYedekGun} günde kasa girilmediği için Evo kullanıldı` : ''}{evoKararGun > 0 ? `; ${evoKararGun} günde senin kararınla Evo esas alındı (personel hatası)` : ''}.
                  </div>
                </div>
              );
            })()}

            {/* ── İZOLE: KDV Hariç (Gerçek Marj) katmanı — Faz 1, ayrı alan ── */}
            {topla('net_satis_tl') > 0 && (() => {
              const netSatis = topla('net_satis_tl'), hesKdv = topla('hesaplanan_kdv_tl');
              const brutKar = topla('brut_kar_tl'), favok = topla('favok_tl'), netKarNet = topla('net_kar_net_tl');
              const indKdv = topla('indirilecek_kdv_tl'), netMaliyet = topla('net_toplam_maliyet_tl');
              const brutMarj = netSatis > 0 ? (brutKar / netSatis) * 100 : null;
              const netMarjNet = netSatis > 0 ? (netKarNet / netSatis) * 100 : null;
              const nrenk = netKarNet > 0 ? 'var(--green)' : netKarNet < 0 ? 'var(--red)' : undefined;
              return (
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>💎 KDV Hariç — Gerçek Marj</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>ciro KDV dahil girilir, %10 ayrıştırılır · muhasebe katmanı</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                    {kart('Net Satış', fmt(netSatis), 'KDV hariç ciro')}
                    {kart('🏛️ Hesaplanan KDV', fmt(hesKdv), '%10 · devlete')}
                    {kart('📉 Net Maliyet (KDV hariç)', fmt(netMaliyet),
                          `maliyet ${fmt(netMaliyet + indKdv)} − mahsup KDV ${fmt(indKdv)}`)}
                    {kart('Brüt Kâr', fmt(brutKar), brutMarj == null ? '' : `marj %${brutMarj.toFixed(1)} · ürün maliyeti sonrası`)}
                    {kart('FAVÖK', fmt(favok), 'net satış − net maliyet (vergi öncesi)')}
                    {kart('✅ Net Kâr (KDV hariç)', fmt(netKarNet), netMarjNet == null ? '' : `net marj %${netMarjNet.toFixed(1)}`, nrenk)}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }}>
                    Bu satır KDV'yi cirodan ayrıştırır (gerçek marj). Üstteki hero "Net Kâr" da AYNI hesaptır (KDV-hariç, şube-bazlı vergili) — iki blok tutarlıdır.
                    {' '}⚖️ Alışta ödediğin KDV ({fmt(indKdv)}) GİDER DEĞİLDİR — devletten mahsup edilir; bu yüzden maliyetten ÇIKARILIR
                    ve kâra otomatik geri kazanılır. Devlete yalnız fark (Ödenecek KDV = {fmt(hesKdv - indKdv)}) kalır; o da kâr hesabına girmez, ayrı cep.
                  </div>
                </div>
              );
            })()}

            {/* ── ⚖️ CİRO FARK DEFTERİ (Evo ↔ Kasa) — sahip 2026-07-18: P&L cirosu
                 EVO kabul; fark meşruysa (iade/sayım) tıkla → kasa girişi kullanılır ── */}
            {fdefter && (fdefter.kayitlar || []).length > 0 && (() => {
              // ŞUBE ŞUBE ayrım (sahip isteği): filtre hapları + seçime göre toplamlar
              const tumKayit = fdefter.kayitlar || [];
              const subeListe = [...new Set(tumKayit.map(k => k.sube_ad || k.sube_id))];
              const fRows = fdSube ? tumKayit.filter(k => (k.sube_ad || k.sube_id) === fdSube) : tumKayit;
              const fEksik = fRows.filter(k => (k.fark || 0) < 0);
              const fFazla = fRows.filter(k => (k.fark || 0) > 0);
              const fEksikT = fEksik.reduce((s, k) => s + (k.fark || 0), 0);
              const fFazlaT = fFazla.reduce((s, k) => s + (k.fark || 0), 0);
              const fNet = fEksikT + fFazlaT;
              const fAcik = fRows.filter(k => k.durum === 'acik').length;
              const fCozulen = fRows.filter(k => ['gidere_yazildi', 'gelire_yazildi'].includes(k.durum)).length;
              const subeNet = s => tumKayit.filter(k => (k.sube_ad || k.sube_id) === s)
                .reduce((t, k) => t + (k.fark || 0), 0);
              return (
              <div className="card" style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                  ⚖️ Ciro Fark Defteri — Evo ↔ Kasa
                  {fAcik > 0 && <span style={{ color: 'var(--orange)' }}> · {fAcik} açık karar</span>}
                </div>
                {/* Şube filtresi — her hapta o şubenin NET farkı */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  <button className="btn btn-sm" onClick={() => setFdSube(null)}
                          style={{ background: !fdSube ? 'var(--accent)' : 'var(--bg3)', color: !fdSube ? '#FFF8EC' : 'var(--text2)', border: '1px solid var(--border)' }}>
                    Tümü · {fmt(tumKayit.reduce((t, k) => t + (k.fark || 0), 0))}
                  </button>
                  {subeListe.map(s => (
                    <button key={s} className="btn btn-sm" onClick={() => setFdSube(fdSube === s ? null : s)}
                            style={{ background: fdSube === s ? 'var(--accent)' : 'var(--bg3)', color: fdSube === s ? '#FFF8EC' : 'var(--text2)', border: '1px solid var(--border)' }}>
                      {s} · <span style={{ fontFamily: 'var(--font-mono)', color: fdSube === s ? '#FFF8EC' : (subeNet(s) < 0 ? 'var(--red)' : 'var(--green)') }}>{fmt(subeNet(s))}</span>
                    </button>
                  ))}
                </div>
                {/* Eksik / Fazla / Net — AYRI göstergeler; seçili şubeye göre yeniden hesaplanır */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
                  <div style={{ background: 'rgba(192,58,43,.08)', border: '1px solid rgba(192,58,43,.25)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>🔻 EKSİK (kasa &lt; Evo) · {fEksik.length} gün</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--red)' }}>{fmt(fEksikT)}</div>
                  </div>
                  <div style={{ background: 'rgba(37,121,79,.08)', border: '1px solid rgba(37,121,79,.25)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>🔺 FAZLA (kasa &gt; Evo) · {fFazla.length} gün</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>+{fmt(fFazlaT)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>⚖️ NET TOPLAM FARK{fdSube ? ` · ${fdSube}` : ''}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: fNet < 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(fNet)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>✓ Karar verilen · gidere/gelire yazılan</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{fRows.length - fAcik} · {fCozulen}</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                  Kâr-zarar cirosu bu günlerde EVO'dan kabul edilir (varsayılan — POS gerçeği). Fark meşruysa
                  (iade yapıldı / kasa sayımı farklı) <b>"Kasa doğru"</b>ya tıkla → o gün kasadaki giriş kullanılır.
                  Kasa kayıtlarına dokunulmaz; karar her an geri alınabilir.
                </div>
                {fRows.map(k => (
                  <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                    <span>
                      {k.tarih} · <b>{k.sube_ad || k.sube_id}</b> ·{' '}
                      {k.girilen == null ? (
                        <span style={{ color: 'var(--blue)' }}>girilmemiş gün → Evo {fmt(k.evo)} maliyete işlendi 🤖</span>
                      ) : (
                        <>
                          kasa {fmt(k.girilen)} / evo {fmt(k.evo)} ·{' '}
                          <b style={{ color: (k.fark || 0) < 0 ? 'var(--red)' : 'var(--green)' }}>
                            {(k.fark || 0) < 0 ? 'açık' : 'fazla'} {fmt(Math.abs(k.fark || 0))}
                          </b>
                        </>
                      )}
                      {k.durum === 'girilen_dogru' && <span style={{ color: 'var(--green)' }}> · ✓ kasa doğru (P&L kasa girişini kullanır)</span>}
                      {k.durum === 'evo_dogru' && <span style={{ color: 'var(--green)' }}> · ✓ evo doğru</span>}
                      {k.durum === 'gidere_yazildi' && <span style={{ color: 'var(--green)' }}> · ✓ açık anlık gidere yazıldı (kasadan düştü)</span>}
                      {k.durum === 'gelire_yazildi' && <span style={{ color: 'var(--green)' }}> · ✓ fazla dış kaynak gelirine yazıldı (kasaya girdi)</span>}
                    </span>
                    {k.durum === 'acik' && k.girilen != null ? (
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => farkKarar(k.id, 'girilen_dogru')}>✓ Kasa doğru (iade/sayım)</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => farkKarar(k.id, 'evo_dogru')}>✓ Evo doğru</button>
                        {(k.fark || 0) < 0 && (
                          <button className="btn btn-sm btn-danger" onClick={() => {
                            if (window.confirm(`${k.tarih} ${k.sube_ad || ''}: ${fmt(Math.abs(k.fark))} kasa açığı ANLIK GİDER olarak yazılsın mı? (kasadan düşer)`)) farkGidereYaz(k.id);
                          }}>💸 Açığı gidere yaz</button>
                        )}
                        {(k.fark || 0) > 0 && (
                          <button className="btn btn-sm btn-secondary" onClick={() => {
                            if (window.confirm(`${k.tarih} ${k.sube_ad || ''}: ${fmt(k.fark)} kasa fazlası DIŞ KAYNAK GELİRİ olarak yazılsın mı? (kasaya gelir girer)`)) farkGelireYaz(k.id);
                          }}>💰 Fazlayı gelir yaz</button>
                        )}
                      </span>
                    ) : (k.durum === 'girilen_dogru' || k.durum === 'evo_dogru') ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => farkKarar(k.id, 'acik')}>geri al</button>
                    ) : null}
                  </div>
                ))}
              </div>
              );
            })()}

            {/* ── ⚖️ KASA HATALARI (Onay Kuyruğu'ndan taşındı — isteğe bağlı bölüm) ── */}
            {khListe.length > 0 && (
              <div className="card" style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>
                    ⚖️ Kasa Hataları — onay bekleyen <span style={{ color: 'var(--orange)' }}>{khListe.length}</span>
                    <span style={{ color: 'var(--text3)', fontWeight: 400, fontSize: 11 }}> · Onay Kuyruğu'ndan buraya taşındı</span>
                  </span>
                  <button className="btn btn-sm btn-secondary" onClick={() => setKhAcik(v => !v)}>{khAcik ? 'gizle ▴' : 'göster ▾'}</button>
                </div>
                {khAcik && khListe.map(o => (
                  <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                    <span>
                      {o.tarih} · <span className="badge badge-yellow">{o.islem_turu}</span> · {(o.aciklama || '').slice(0, 60)}
                      {' '}<b style={{ fontFamily: 'var(--font-mono)', color: parseFloat(o.tutar) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {o.tutar != null ? `${parseFloat(o.tutar).toLocaleString('tr-TR', { maximumFractionDigits: 0 })} ₺` : '—'}
                      </b>
                    </span>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => khOnayla(o.id)}>✓ Onayla</button>
                      <button className="btn btn-sm btn-danger" onClick={() => khReddet(o.id)}>✕ Reddet</button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── Detay alt-sekmeleri: tablolar üst üste yığılmasın, tek pencerede gezilsin ── */}
            <div style={{ display: 'flex', gap: 6, marginTop: 18, marginBottom: 2, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              {[['ozet', '🎯 Güven & Sapma'], ['vergi', '🏛️ Vergi & KDV'], ['pnl', '💰 Günlük Kâr-Zarar']].map(([id, lbl]) => (
                <button key={id} onClick={() => setAltSekme(id)} style={{
                  padding: '7px 15px', borderRadius: 999, fontSize: 12.5, fontWeight: altSekme === id ? 700 : 500,
                  cursor: 'pointer', border: '1px solid ' + (altSekme === id ? 'var(--accent)' : 'var(--border)'),
                  background: altSekme === id ? 'var(--accent)' : 'transparent',
                  color: altSekme === id ? '#fff' : 'var(--text3)', transition: 'all .15s', whiteSpace: 'nowrap',
                }}>{lbl}</button>
              ))}
            </div>

            {/* ── İZOLE: Şube Bazlı Tahmini Vergi (Türkiye mekanizması) — Faz 1b ── */}
            {altSekme === 'vergi' && vergiOzet && (vergiOzet.satirlar || []).length > 0 && (
              <div className="card" style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>🏛️ Tahmini Vergi — Şube Bazlı</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>şirket %25 kurumlar · şahıs gelir vergisi (artan dilim)</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr>
                      <th>Şube</th><th>Tip</th><th style={{ textAlign: 'right' }}>Vergi Öncesi</th>
                      <th style={{ textAlign: 'right' }}>Tahmini Vergi</th><th style={{ textAlign: 'right' }}>Efektif</th>
                    </tr></thead>
                    <tbody>
                      {vergiOzet.satirlar.map(s => (
                        <tr key={s.sube_id}>
                          <td>{s.sube_adi}</td>
                          <td><span className={`badge ${s.vergi_tipi === 'sahis' ? 'badge-yellow' : 'badge-blue'}`} title={s.yontem}>{s.vergi_tipi === 'sahis' ? '👤 Şahıs' : '🏢 Şirket'}</span></td>
                          <td className="mono" style={{ textAlign: 'right', color: s.vergi_oncesi_kar_tl < 0 ? 'var(--red)' : undefined }}>{fmt(s.vergi_oncesi_kar_tl)}</td>
                          <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(s.tahmini_vergi_tl)}</td>
                          <td className="mono" style={{ textAlign: 'right', color: 'var(--text3)' }}>%{s.efektif_oran_pct}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700, borderTop: '1px solid var(--border)' }}>
                      <td colSpan={3} style={{ textAlign: 'right' }}>Toplam Tahmini Vergi</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{fmt(vergiOzet.toplam_vergi_tl)}</td><td></td>
                    </tr></tfoot>
                  </table>
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }}>{vergiOzet.not}</div>
              </div>
            )}

            {altSekme === 'vergi' && !((vergiOzet && (vergiOzet.satirlar || []).length > 0) || (kdvPoz && (kdvPoz.satirlar || []).length > 0)) && (
              <div className="card" style={{ marginTop: 14, fontSize: 12, color: 'var(--text3)' }}>Bu dönem için vergi / KDV verisi yok.</div>
            )}

            {/* ── İZOLE: KDV Pozisyonu (P&L DIŞI — devlete ödenecek) — Faz 3 ── */}
            {altSekme === 'vergi' && kdvPoz && (kdvPoz.satirlar || []).length > 0 && (
              <div className="card" style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>🧾 KDV Pozisyonu <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(P&L dışı — devlete)</span></span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>Hesaplanan − İndirilecek = Ödenecek · %{Math.round((kdvPoz.kdv_oran || 0.1) * 100)}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 8 }}>
                  <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>Hesaplanan (satış)</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(kdvPoz.toplam_hesaplanan_tl)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>İndirilecek (alış)</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(kdvPoz.toplam_indirilecek_tl)}</div>
                  </div>
                  <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '8px 10px', borderLeft: '3px solid var(--accent)' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>Ödenecek KDV</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--accent)' }}>{fmt(kdvPoz.toplam_odenecek_tl)}</div>
                  </div>
                </div>
                {!subeId && (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Şube</th><th style={{ textAlign: 'right' }}>Hesaplanan</th><th style={{ textAlign: 'right' }}>İndirilecek</th><th style={{ textAlign: 'right' }}>Ödenecek</th></tr></thead>
                      <tbody>
                        {kdvPoz.satirlar.map(s => (
                          <tr key={s.sube_id || s.sube_adi}>
                            <td>{s.sube_adi}</td>
                            <td className="mono" style={{ textAlign: 'right' }}>{fmt(s.hesaplanan_kdv_tl)}</td>
                            <td className="mono" style={{ textAlign: 'right' }}>{fmt(s.indirilecek_kdv_tl)}</td>
                            <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(s.odenecek_kdv_tl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }}>{kdvPoz.not}</div>
              </div>
            )}

            {/* 🧾 VERGİ AYARLARI — kalem KDV oranları + kira stopajı (2026-07-05) */}
            {altSekme === 'vergi' && <VergiAyarlari fmt={fmt} />}

            {maliyetDetayAcik && kovalar.length > 0 && (() => {
              const KOVA_RENK = {
                'Malzeme (ürün-aç)': '#1D9E75', 'Personel': '#378ADD', 'İşveren SGK payı': '#85B7EB',
                'Kira': '#BA7517', 'Faturalar': '#D85A30', 'Abonelikler': '#7F77DD',
                'POS komisyonu': '#888780', 'Platform komisyonu': '#B4B2A9', 'Fire': '#E24B4A',
                'İade': '#D4537E', 'Şube anlık gider': '#97C459',
              };
              const renk = ad => KOVA_RENK[ad] || '#888780';
              return (
                <div className="card" style={{ marginTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>📉 Para nereye gidiyor?</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>toplam {fmt(maliyet)} · {donemLabel}</span>
                  </div>
                  {/* Birleşik segment bar — tek bakışta dağılım */}
                  <div style={{ height: 14, borderRadius: 4, overflow: 'hidden', display: 'flex', marginBottom: 14, background: 'var(--bg3)' }}>
                    {kovalar.map(k => {
                      const pct = maliyet > 0 ? (k.tutar / maliyet) * 100 : 0;
                      return pct > 0 ? <div key={k.ad} title={`${k.ad}: ${fmt(k.tutar)} (%${pct.toFixed(0)})`} style={{ width: `${pct}%`, height: '100%', background: renk(k.ad) }} /> : null;
                    })}
                  </div>
                  {/* Kalem listesi — renkli nokta + tutar + % */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '7px 18px' }}>
                    {kovalar.map(k => {
                      const pct = maliyet > 0 ? (k.tutar / maliyet) * 100 : 0;
                      return (
                        <div key={k.ad} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ width: 10, height: 10, borderRadius: 2, background: renk(k.ad), flexShrink: 0 }} />
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.ad}</span>
                          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{fmt(k.tutar)}</span>
                          <span style={{ color: 'var(--text3)', width: 38, textAlign: 'right' }}>%{pct.toFixed(0)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* ── Genel Bakış: eksik maliyet uyarıları (kâr şişme riski) ── */}
      {sekme === 'genel' && (() => {
        const uyarilar = [];
        if (tuketilenFiyatsiz.length > 0) {
          uyarilar.push({
            ikon: '🔴', acil: true,
            baslik: `${tuketilenFiyatsiz.length} kalem fiyatsız tüketildi`,
            alt: `Maliyeti 0₺ sayıldı: ${tuketilenFiyatsiz.slice(0, 5).join(', ')}${tuketilenFiyatsiz.length > 5 ? ` +${tuketilenFiyatsiz.length - 5} kalem` : ''}${fiyatsizUrunler.length > 0 ? ` · toplam ${fiyatsizUrunler.length} ürün fiyatsız` : ''}`,
            hedef: 'fiyatlar', hedefMetin: '🏷️ Fiyatlar →',
          });
        } else if (fiyatsizUrunler.length > 0) {
          uyarilar.push({
            ikon: '🟡', acil: false,
            baslik: `${fiyatsizUrunler.length} ürünün alış fiyatı hiç girilmemiş`,
            alt: 'Tüketilirse maliyet 0₺ sayılır ve kâr şişer.',
            hedef: 'fiyatlar', hedefMetin: '🏷️ Fiyatlar →',
          });
        }
        if (subeId && ciroluGunVar && donemKiraTL === 0) {
          uyarilar.push({
            ikon: '🏠', acil: true,
            baslik: 'Bu şube için kira girilmemiş',
            alt: 'Kira maliyeti 0₺ sayıldı → kâr olduğundan yüksek görünüyor. Giderler ekranından (sabit gider → kira) gir.',
            hedef: null,
          });
        }
        if (subeId && ciroluGunVar && donemPersonelTL === 0) {
          uyarilar.push({
            ikon: '👥', acil: true,
            baslik: 'Bu dönemde personel maliyeti yok',
            alt: 'Vardiya/atama görünmüyor → personel gideri 0₺ sayıldı, kâr yüksek görünüyor. Vardiya Planlama’dan ata.',
            hedef: null,
          });
        }
        if (subeId && ciroluGunVar && donemFaturaTL === 0) {
          uyarilar.push({
            ikon: '🧾', acil: true,
            baslik: 'Fatura gideri girilmemiş (elektrik / su / gaz / internet)',
            alt: 'Fatura maliyeti 0₺ sayıldı → kâr yüksek görünüyor. Giderler ekranından (sabit gider → fatura) son faturayı gir.',
            hedef: null,
          });
        }
        if (subeId && ciroluGunVar && donemAbonelikTL === 0) {
          uyarilar.push({
            ikon: '🔁', acil: false,
            baslik: 'Abonelik gideri görünmüyor',
            alt: 'Aylık abonelik (yazılım, müzik, üyelik vb.) düşmemiş — varsa Giderler ekranından gir; bu şubede abonelik yoksa normal.',
            hedef: null,
          });
        }
        if (!uyarilar.length) return null;
        const acilVar = uyarilar.some(u => u.acil);
        const renk = acilVar ? '#ef4444' : '#eab308';
        const bg = acilVar ? 'rgba(239,68,68,0.10)' : 'rgba(234,179,8,0.10)';
        const bd = acilVar ? 'rgba(239,68,68,0.45)' : 'rgba(234,179,8,0.45)';
        return (
          <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 10, background: bg, border: `1px solid ${bd}` }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: renk, marginBottom: uyarilar.length ? 8 : 0 }}>
              ⚠️ Maliyet eksik görünüyor → kâr olduğundan YÜKSEK olabilir
            </div>
            {uyarilar.map((u, i) => (
              <div key={i}
                onClick={u.hedef ? () => setSekme(u.hedef) : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 0', cursor: u.hedef ? 'pointer' : 'default',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: 16, flexShrink: 0 }}>{u.ikon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{u.baslik}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{u.alt}</div>
                </div>
                {u.hedef && <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap', flexShrink: 0 }}>{u.hedefMetin}</span>}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Özet kartları (Analiz sekmesi) */}
      {/* ── Analiz: Şube karşılaştırma kartları (tıkla → o şubeyi seç) ── */}
      {sekme === 'analiz' && subeOzetler.length > 0 && (<>
        <div className="panel-section-hdr" style={{ marginBottom: 10 }}>
          <span>🏢 Şubeler — net kâr / marj</span>
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>{donemLabel} · karta tıkla → gün gün kırılım</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 20 }}>
          {subeOzetler.map(s => {
            const sec = subeId === s.sube_id;
            const veri = s.ciro > 0;
            const poz = s.net >= 0;
            const renk = !veri ? 'var(--text3)' : (poz ? '#22c55e' : '#ef4444');
            return (
              <div key={s.sube_id} onClick={() => setSubeId(sec ? '' : s.sube_id)} style={{
                cursor: 'pointer', background: 'var(--bg)', borderRadius: 12, padding: '12px 14px',
                border: sec ? '2px solid var(--accent)' : '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{s.ad}</span>
                  {sec && <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', padding: '2px 8px', borderRadius: 6 }}>seçili</span>}
                </div>
                <div style={{ fontSize: 21, fontWeight: 700, fontFamily: 'var(--font-mono)', color: renk }}>
                  {!veri ? '—' : (poz ? '+' : '') + fmt(s.net)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {!veri ? 'veri yok' : `marj %${s.marj.toFixed(1)} · ciro ${fmt(s.ciro)}`}
                </div>
                <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, Math.abs(s.marj || 0))}%`, height: '100%', background: veri ? (poz ? '#22c55e' : '#ef4444') : 'transparent' }} />
                </div>
              </div>
            );
          })}
        </div>
      </>)}

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
      {sekme === 'genel' && altSekme === 'ozet' && guvenSkoru && (() => {
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

      {/* ── KÂR-ZARAR (P&L) — TEK KATMAN: KDV-hariç + şube-bazlı vergi (G1-G5, 2026-07-07) ── */}
      {sekme === 'genel' && altSekme === 'pnl' && (<>
      <div className="panel-section-hdr" style={{ marginBottom: 12 }}>
        <span>💰 Kâr-Zarar (Operasyonel){subeId ? '' : ' — Tüm Şubeler'}</span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Net Satış (KDV hariç) − Net Maliyet (KDV hariç) = FAVÖK − Şube-bazlı Tahmini Vergi = NET KÂR · resmî muhasebe değil</span>
      </div>
      <div style={{ overflowX: 'auto', marginBottom: 16 }}>
        <table className="tablo">
          <thead>
            <tr>
              <th>Tarih</th>
              {!subeId && <th>Şube</th>}
              <th style={{ textAlign: 'right' }} title="Kasadaki brüt ciro — KDV dahil">💵 Ciro (KDV dahil)</th>
              <th style={{ textAlign: 'right' }} title="Ciro − hesaplanan KDV">Net Satış</th>
              <th style={{ textAlign: 'right' }}>📉 Net Maliyet (KDV hariç)</th>
              <th style={{ textAlign: 'right' }} title="Net Satış − Net Maliyet (KDV-hariç, vergi öncesi)">FAVÖK</th>
              <th style={{ textAlign: 'right' }} title="Şube-bazlı: şahıs şubelerde artan dilim, şirket şubelerde %25">🏛️ Tahmini Vergi</th>
              <th style={{ textAlign: 'right' }}>✅ NET KÂR</th>
              <th style={{ textAlign: 'right' }} title="Net Kâr / Net Satış">Marj</th>
            </tr>
          </thead>
          <tbody>
            {(gunGunData?.satirlar || []).map((s, i) => {
              const net = Number(s.net_kar_net_tl ?? s.net_kar_tl) || 0;  // FIX C6: doğru harman-vergi net kâr
              const renk = net > 0 ? 'var(--green)' : net < 0 ? 'var(--red)' : 'var(--text3)';
              return (
                <tr key={i}>
                  <td>{fmtDate(s.tarih)}</td>
                  {!subeId && <td>{s.sube_adi}</td>}
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(s.ciro_tl || 0)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.net_satis_tl ?? 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text2)', cursor: 'help' }}
                    title={[
                      'KDV-HARİÇ toplam maliyet. Kalemler (KDV dahil ham):',
                      `Kira: ${fmt(s.kira_maliyet_tl || 0)}`,
                      `Faturalar (elektrik/su/gaz): ${fmt(s.fatura_maliyet_tl || 0)}`,
                      `Abonelikler: ${fmt(s.abonelik_maliyet_tl || 0)}`,
                      `POS komisyonu: ${fmt(s.pos_komisyon_tl || 0)}`,
                      `Platform komisyonu: ${fmt(s.platform_komisyon_tl || 0)}`,
                      `Fire: ${fmt(s.fire_maliyet_tl || 0)}`,
                      `İade: ${fmt(s.iade_maliyet_tl || 0)}`,
                      `Şube anlık gider: ${fmt(s.sube_anlik_gider_tl || 0)}`,
                      '(+ ürün-aç COGS + personel)',
                      `KDV dahil toplam: ${fmt(s.genel_toplam || 0)}`,
                      'Hariç: kart faizi / finansman',
                    ].join('\n')}>{fmt(s.net_toplam_maliyet_tl ?? s.genel_toplam ?? 0)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.favok_tl ?? 0)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text3)' }}>{fmt(s.tahmini_vergi_net_tl ?? s.tahmini_vergi_tl ?? 0)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: renk }}>{fmt(net)}</td>
                  <td style={{ textAlign: 'right', color: renk }}>{(s.net_marj_net_pct ?? s.net_marj_pct) == null ? '—' : `%${s.net_marj_net_pct ?? s.net_marj_pct}`}</td>
                </tr>
              );
            })}
            {(!gunGunData?.satirlar || gunGunData.satirlar.length === 0) && (
              <tr><td colSpan={subeId ? 8 : 9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>Veri yok</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginBottom: 16, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
        ✅ Maliyet = ürün-aç COGS + personel + anlık gider + kira + faturalar + <strong>abonelikler</strong> + POS/platform komisyonu + fire + iade. <strong>Toplam Maliyet üstüne gelince kırılım görünür.</strong> ❌ <strong>Kart faizi / finansman DAHİL DEĞİL</strong> (işletme üzerine düşen finansman yükü, operasyonel kârı kirletmez). ⚠️ <strong>İkram</strong> (Evo 0₺/iskonto) ve <strong>personel tüketimi</strong> henüz yok (ayrı/Evo kaynak). Faz 5 ✅ güven skoru + sapma motoru.
      </div>
      </>)}

      {/* Gün gün maliyet detayı — Ürün Aç (URUN_AC) tüketim verisi × güncel alış fiyatı */}
      {sekme === 'analiz' && (() => {
        const KALEMLER = [
          ['Malzeme', '#1D9E75', s => Number(s.toplam) || 0],
          ['Personel', '#378ADD', s => Number(s.personel_maliyet_tl) || 0],
          ['Kira', '#BA7517', s => Number(s.kira_maliyet_tl) || 0],
          ['Fatura', '#D85A30', s => Number(s.fatura_maliyet_tl) || 0],
          ['Komisyon', '#888780', s => (Number(s.pos_komisyon_tl) || 0) + (Number(s.platform_komisyon_tl) || 0)],
          ['Abonelik', '#7F77DD', s => Number(s.abonelik_maliyet_tl) || 0],
          ['Fire', '#E24B4A', s => Number(s.fire_maliyet_tl) || 0],
          ['İade', '#D4537E', s => Number(s.iade_maliyet_tl) || 0],
          ['Anlık', '#97C459', s => Number(s.sube_anlik_gider_tl) || 0],
        ];
        const rows = (gunGunData?.satirlar || []).slice().sort((a, b) => (b.tarih || '').localeCompare(a.tarih || ''));
        const maxv = Math.max(1, ...rows.map(s => Math.max(Number(s.ciro_tl) || 0, Number(s.genel_toplam) || 0)));
        const aktifKalemler = KALEMLER.filter(([, , fn]) => rows.some(s => fn(s) > 0));
        return (
          <>
            <div className="panel-section-hdr" style={{ marginBottom: 8 }}>
              <span>📅 {subeId ? (subeAdiSecili || 'Şube') : 'Tüm Şubeler'} — gün gün gider kırılımı</span>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>ciro ▭ vs gider ▭ — aynı ölçek</span>
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 11, color: 'var(--text3)' }}>
              {aktifKalemler.map(([ad, renk]) => (
                <span key={ad} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: renk }} />{ad}
                </span>
              ))}
            </div>
            {gunGunData?.fiyat_eksik_kalemler?.length > 0 && (
              <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--yellow)' }}>
                ⚠️ Fiyatsız (0₺ sayıldı): {gunGunData.fiyat_eksik_kalemler.join(', ')}
              </div>
            )}
            {rows.length === 0 && (
              <div className="empty" style={{ marginBottom: 16 }}><p>Bu dönemde kayıt yok.</p></div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {rows.map((s, i) => {
                const ciro = Number(s.ciro_tl) || 0;
                const gider = Number(s.genel_toplam) || 0;
                const net = Number(s.net_kar_net_tl ?? s.net_kar_tl) || 0;  // FIX C6: doğru harman-vergi net kâr
                const neg = net < 0;
                return (
                  <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '11px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9, gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>
                        {fmtDate(s.tarih)}{!subeId && s.sube_adi ? <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · {s.sube_adi}</span> : ''}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', padding: '2px 9px', borderRadius: 6, background: neg ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)', color: neg ? '#ef4444' : '#22c55e' }}>
                        {neg ? '' : '+'}{fmt(net)} ₺
                      </span>
                    </div>
                    {/* Ciro çubuğu */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 11, color: 'var(--text3)', width: 40, flexShrink: 0 }}>ciro</span>
                      <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${(ciro / maxv * 100).toFixed(1)}%`, height: '100%', background: '#1D9E75' }} />
                      </div>
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text2)', width: 62, textAlign: 'right', flexShrink: 0 }}>{fmt(ciro)}</span>
                    </div>
                    {/* Gider segment çubuğu */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text3)', width: 40, flexShrink: 0 }}>gider</span>
                      <div style={{ flex: 1, height: 8, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                        {KALEMLER.map(([ad, renk, fn]) => {
                          const v = fn(s);
                          return v > 0 ? <div key={ad} title={`${ad}: ${fmt(v)}`} style={{ width: `${(v / maxv * 100).toFixed(1)}%`, height: '100%', background: renk }} /> : null;
                        })}
                      </div>
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text2)', width: 62, textAlign: 'right', flexShrink: 0 }}>{fmt(gider)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Fiyat girişi / güncelleme formu (Fiyatlar sekmesi) */}
      {sekme === 'fiyatlar' && (<>
      {/* 🏷️ FİYAT PANOSU — birincil yüzey (Codex: watch primary, entry contextual):
          izleme tahtası + sağ panelden bağlamsal fiyat girişi + ➕ Yeni Fiyat modalı.
          Zam alarmları 'Alarm Verenler' filtresine, fiyatsız uzun liste sol rail'e katlandı. */}
      <FiyatPanosu />

      {/* 🗂 KLASİK GİRİŞ FORMU — ikincil (muhasebe/eski alışkanlık; varsayılan kapalı) */}
      <details style={{ margin: '16px 0' }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--text3)' }}>
          🗂 Klasik giriş formu (kalem kodu ile) — aç/kapa
        </summary>
      <div className="card" style={{ margin: '10px 0 4px' }}>
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
      </details>

      {/* Fiyatsız uzun liste KALDIRILDI (Codex: panoya katlandı — sol rail
          FİYATSIZLAR + kesikli kutucuklar; fiyat girişi artık panodan) */}
      {false && (<>
      {/* ── Fiyatı girilmemiş ürünler (eşleştirilmemiş / fiyatsız) ── */}
      {fiyatsizUrunler.length > 0 && (
        <>
          <div className="panel-section-hdr" style={{ marginBottom: 8 }}>
            <span>⚠️ Fiyatı Girilmemiş Ürünler ({fiyatsizUrunler.length})</span>
            <span style={{ fontSize: 10, color: 'var(--text3)' }}>Tüketilince maliyet 0₺ sayılır → kâr şişer</span>
          </div>
          <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {fiyatsizUrunler.map((k, i) => {
                const acil = tuketilenFiyatsiz.includes(k.kalem_adi) || tuketilenFiyatsiz.includes(k.kalem_kodu);
                return (
                  <div key={k.kalem_kodu} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    background: acil ? 'rgba(239,68,68,0.07)' : 'transparent',
                  }}>
                    <span style={{ fontSize: 13 }}>{acil ? '🔴' : '⚪'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.kalem_adi || k.kalem_kodu}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                        {k.kalem_kodu}{acil ? ' · bu dönemde tüketildi' : ''}
                      </div>
                    </div>
                    <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => fiyatFormaDoldur(k.kalem_kodu, k.kalem_adi)}>
                      🏷️ Fiyat gir
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 16 }}>
            🔴 = bu dönemde tüketilmiş ama fiyatsız (maliyeti aktif olarak eksik hesaplanıyor). ⚪ = katalogda var, henüz fiyat girilmemiş.
            Faturalardan otomatik gelmeyen ürünlerin fiyatını buradan elle girebilirsin.
          </div>
        </>
      )}
      </>)}
      </>)}

      {/* 🔺 Zam Alarmları ayrı blok olarak KALDIRILDI (Codex: panoya katlandı —
          '🚨 Alarm Verenler' filtresi + kutucuk/rozet + Son Yükselenler) */}

      {/* ── FATURALAR sekmesi: PDF yükle + telefon faturaları + foto modal ── */}
      {/* 📈 İZLEME PANOSU — watchlist kabuğu (Codex kurgusu; sol rail + tile grid + timeline) */}
      {sekme === 'izleme' && <IzlemePanosu />}

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
                  <div style={{ display: 'grid', gridTemplateColumns: isMobil ? '1fr 1fr' : '2fr 1fr 1fr 1fr auto auto', gap: 8, alignItems: 'center' }}>
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
                    const kayit = !!fotoKalemKayit[k.id] || !!k.onaylandi;
                    const edit = fotoKalemDuzen[k.id] || {};
                    const kod = edit.kalem_kodu ?? (k.eslesen_stok_kodu || '');
                    const fy = edit.birim_maliyet_tl ?? (k.birim_fiyat != null ? String(k.birim_fiyat) : '');
                    const oneriler = !kod && !kayit ? kalemOnerileri(k.ocr_ad) : [];
                    const secadi = kod ? (stokKalemleri.find(x => x.kalem_kodu === kod)?.kalem_adi || '') : '';
                    return (
                      <div key={k.id}>
                        <div style={{ display: 'grid', gridTemplateColumns: isMobil ? '1fr' : '1.6fr 1.2fr 1fr auto', gap: 6, alignItems: 'center' }}>
                          <input type="text" list="depo-kalem-listesi-sayfa" placeholder="Ürün ara / kod yaz..." value={kod}
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
                        {/* Seçili kalem adını göster (kutuda UUID görünür → burada okunabilir ad + değiştir) */}
                        {kod && !kayit && (
                          <div style={{ marginTop: 4, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ color: 'var(--green)' }}>✓ Seçili: <strong>{secadi || kod}</strong></span>
                            <button className="btn btn-ghost btn-sm" style={{ padding: '1px 8px', color: 'var(--text3)' }}
                              onClick={() => setFotoKalemDuzen(p => ({ ...p, [k.id]: { ...p[k.id], kalem_kodu: '' } }))}>değiştir</button>
                          </div>
                        )}
                        {/* Çoklu öneri — doğru olanı tıkla; hiçbiri değilse yukarıdaki kutuya ürün adı yaz */}
                        {oneriler.length > 0 && (
                          <div style={{ marginTop: 4, fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            <span style={{ color: 'var(--text3)' }}>🔗 Bunlardan biri mi?</span>
                            {oneriler.map(o => (
                              <button key={o.kalem_kodu} className="btn btn-ghost btn-sm" style={{ color: 'var(--accent)', padding: '1px 8px' }}
                                title={`Faturadaki "${k.ocr_ad || ''}" → bu kalem`}
                                onClick={() => setFotoKalemDuzen(p => ({ ...p, [k.id]: { ...p[k.id], kalem_kodu: o.kalem_kodu } }))}>
                                {o.kalem_adi}
                              </button>
                            ))}
                          </div>
                        )}
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
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--text3)', marginBottom: 8 }}>
          📑 Tüm Fiyatlar — tam liste (muhasebe görünümü: ara · geçmiş · sil) — aç/kapa
        </summary>
      <div className="panel-section-hdr" style={{ marginBottom: 10 }}>
        <span>📑 Güncel Fiyat Listesi <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 11 }}>({gruplar.length} kalem fiyatlı{fiyatsizUrunler.length ? ` · ${fiyatsizUrunler.length} fiyatsız` : ''})</span></span>
        <span style={{ fontSize: 10, color: 'var(--text3)' }}>Ok ikonuna tıkla → değişim yüzdesi</span>
      </div>
      {gruplar.length > 0 && (
        <input type="text" placeholder="🔍 Fiyat listesinde ara (ürün adı / kod)..." value={fiyatAra}
          onChange={e => setFiyatAra(e.target.value)} style={{ width: '100%', marginBottom: 10 }} />
      )}
      {gruplar.length === 0 ? (
        <div className="empty"><p>Henüz fiyat tanımlanmamış. Yukarıdan ilk fiyatı ekleyebilirsin.</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {gruplar.filter(g => {
            const q = fiyatAra.trim().toLocaleLowerCase('tr');
            return !q || (g.guncel.kalem_adi || g.kalem_kodu || '').toLocaleLowerCase('tr').includes(q) || (g.kalem_kodu || '').toLowerCase().includes(q);
          }).map(g => {
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
      </details>
      </>)}
    </div>
  );
}
