import { useState, useEffect, useCallback } from 'react';
import { api, fmt } from '../utils/api';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';
import CariEkstrePanel, { trT, malCariListesi } from '../components/CariEkstrePanel';
import KartAraOdemeModal from '../components/KartAraOdeme';

// 💸 ÖDEME MERKEZİ v2 (2026-07-19, sahip: "sistemi adam akıllı ele alalım";
// Codex çaprazlı — "tek form değil TEK KAPI: kuyruk birleşsin, yazıcılar birleşmesin").
// İLKE (değişmedi): hub deftere YAZMAZ — her eylem MEVCUT tek-yazıcı uca delege:
//   plan tam    → POST /odeme-plani/{oid}/ode
//   plan kısmi  → POST /odeme-plani/{oid}/kismi-ode
//   ertele      → POST /odeme-plani/{oid}/ertele
//   değişken f. → POST /fatura-ode | /fatura-vadeye-yaz
//   serbest     → POST /anlik-gider
//   söz/taahhüt → POST /vadeli-alimlar
// v2 YENİLİKLERİ: Nakit Kokpiti (kasa + 7/30g çıkış + ≈ en düşük bakiye),
// 3 ayrı form → tek "➕" sihirbazı (ilk soru: para çıktı mı?), window.prompt/
// alert/confirm tamamen kalktı (modal+toast), çoklu seçim → ödeme koşusu
// (Codex reçetesi: SIRAYLA mevcut uçlara çağrı + satır satır sonuç — tek
// transaction DEĞİL, guard'lar uçlarda). Maaş + banka/havale SONRAKİ fazlar.
const KATEGORILER = ['Fatura', 'Kira', 'Malzeme', 'Tamir/Bakım', 'Temizlik', 'Ulaşım', 'Diğer'];

async function faturaEkiYukle(dosya) {
  // 📎 Maliyet/Tedarikçi boru hattının aynısı — hata fırlatır, çağıran not düşer
  const fd = new FormData();
  const isPdf = /pdf/i.test(dosya.type || '') || /\.pdf$/i.test(dosya.name || '');
  fd.append(isPdf ? 'pdf' : 'foto', dosya);
  const headers = {};
  try {
    const mut = (localStorage.getItem('evvelMerkezMutasyonKey') || '').trim();
    if (mut) headers['X-Evvel-Merkez-Key'] = mut;
  } catch { /* ignore */ }
  const res = await fetch(isPdf ? '/api/fatura/yukle-pdf' : '/api/fatura/yukle',
    { method: 'POST', headers, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.detail) || 'fatura yüklenemedi');
}

const TIP_IKON = {
  'Kredi Kartı': '💳', 'Borç Taksiti': '🏦', 'Sabit Gider': '🏠',
  'Vadeli Alım': '📦', 'Fatura (tutar bekleniyor)': '⚡',
  'Personel Ödemesi': '👥',
};

// ── 🗂 ALT SEKMELER (2026-07-19, sahip kurgusu: "her ay ödeme yaptığım
// alanlar tek alanda, izlenebilir") — sekme=FİLTRE (tek kuyruk, tek veri;
// Codex: ayrı sayfa yaparsan sayılar tutmaz). Personel sahip kararıyla
// DAHİL (salt-görünüm; ödeme maaş akışında — guard zaten korur).
const SEKMELER = [
  ['tumu', '📋 Tümü', () => true],
  // hizmet sınıfı (elektrik/uydu/telekom) vadeli satırları Tedarikçi'ye DEĞİL
  // Giderler'e düşer (sahip: 'elektrik faturasını tedarikçi alanında bulunduramayız')
  ['tedarikci', '🏪 Tedarikçi', r => r.kaynak_tablo === 'vadeli_alimlar' && r.tedarikci_sinif !== 'hizmet'],
  ['kart', '💳 Kart', r => r.tip === 'Kredi Kartı'],
  ['kredi', '🏦 Kredi', r => r.kaynak_tablo === 'borc_envanteri'],
  ['personel', '👥 Personel', r => r.kaynak_tablo === 'personel'],
  ['giderler', '⚡ Giderler', r => r.kaynak_tablo === 'sabit_giderler' || r.tip === 'Sabit Gider' || r.tip === 'Fatura (tutar bekleniyor)'
    || (r.kaynak_tablo === 'vadeli_alimlar' && r.tedarikci_sinif === 'hizmet')],
];

// ── söz ↔ cari eşleşmesi (görsel gruplama; yazmaz) — 'fez' ↔ 'FEZ KAHVE GIDA…',
// 'ATALAY KAHVE' ↔ 'MEHMET ATALAY'. Genel kelimeler eşleşme sayılmaz.
const _ESLESME_STOP = new Set(['GIDA', 'GİDA', 'SANAYI', 'SANAYİ', 'TICARET', 'TİCARET',
  'LIMITED', 'LİMİTED', 'SIRKETI', 'ŞİRKETİ', 'ITHALAT', 'İTHALAT', 'IHRACAT', 'İHRACAT',
  'ANONIM', 'ANONİM', 'KAHVE', 'COFFEE', 'ROASTERY', 'SAN', 'TIC', 'TİC', 'LTD', 'STI', 'ŞTİ',
  'VE', 'A.S', 'A.Ş', 'AS', 'AŞ', 'GRUP', 'HIZMETLERI', 'HİZMETLERİ', 'URUNLERI', 'ÜRÜNLERİ']);
const _token = (s) => String(s || '').toLocaleUpperCase('tr')
  .split(/[^A-ZÇĞİÖŞÜ0-9]+/).filter(t => t.length >= 3 && !_ESLESME_STOP.has(t));
const tedarikciEslesir = (a, b) => {
  const A = String(a || '').trim().toLocaleUpperCase('tr'), B = String(b || '').trim().toLocaleUpperCase('tr');
  if (!A || !B) return false;
  if (A === B) return true;
  const ta = _token(A), tb = new Set(_token(B));
  return ta.some(t => tb.has(t));
};

const bugunISO = () => new Date().toISOString().slice(0, 10);
const artiGunISO = (g) => new Date(Date.now() + g * 86400000).toISOString().slice(0, 10);

export default function OdemeMerkezi() {
  const [liste, setListe] = useState(null);
  const [kokpit, setKokpit] = useState(null);
  const [hata, setHata] = useState('');
  const [msg, setMsg] = useState(null);
  const [pencere, setPencere] = useState(7);
  const [grupla, setGrupla] = useState('zaman'); // 'zaman' | 'tur'
  const [filtre, setFiltre] = useState('tumu');  // 'tumu' | 'bugun' | 'gecikmis' | 'tutar'
  const [sekme, setSekme] = useState('tumu');    // 🗂 alt sekme (SEKMELER)
  const [kdvPoz, setKdvPoz] = useState(null);    // 🏛 Resmi Ödemeler (KDV) bloğu
  // 💳 ARA ÖDEME (2026-07-27, sahip): dönem kapanmış (planı yok) ama borcu süren
  // kartlar listeden KAYBOLMASIN — kart özetleri ayrı çekilir, plansızlar ayrı
  // blokta gösterilir, tek tıkla ara ödeme (ortak KartAraOdemeModal).
  const [kartOzetler, setKartOzetler] = useState([]);
  const [araKart, setAraKart] = useState(null);
  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 5000); };

  const yukle = useCallback(() => {
    // personel=1: sahip kurgusu — TÜM çıkışlar tek çatıda görünür (maaş dahil)
    api(`/odeme-plani/bugun?gun=${pencere}&personel=1`)
      .then(r => setListe(Array.isArray(r) ? r : []))
      .catch(e => { setHata(e?.message || 'Yüklenemedi'); setListe([]); });
    api('/odeme-plani/kokpit?personel=1').then(setKokpit).catch(() => setKokpit(null));
    api('/ops/maliyet/kdv-pozisyon?gun=30').then(setKdvPoz).catch(() => setKdvPoz(null));
    api('/kartlar').then(r => setKartOzetler(Array.isArray(r) ? r : (r?.kartlar || []))).catch(() => setKartOzetler([]));
    setCariler(null); // ödeme sonrası cari borç listesi tazelensin (iz düşmüş olabilir)
    setEkstreler({}); // ekstreler de taze çekilsin
  }, [pencere]);
  useEffect(() => { yukle(); }, [yukle]);
  // FAZ D — AP mutabakat sağlığı (cari borç ↔ ödeme kuyruğu tutuyor mu)
  const [apm, setApm] = useState(null);
  const [apmAcik, setApmAcik] = useState(false);
  useEffect(() => { api('/fatura/ap-mutabakat').then(setApm).catch(() => setApm(null)); }, []);

  // 📒 CARİ BORÇLAR (2026-07-19, sahip: 'vadeli alımların dışında olan bir ödeme
  // altyapısı') — Tedarikçi sekmesi: faturalardan yığılan cari açık, söz şartı
  // olmadan buradan ödenir. Hub YAZMAZ: ödeme = sihirbazın serbest formu
  // tedarikçi damgalı (POST /anlik-gider → supplier_payment_event conf=1.0),
  // iz düşünce self-heal/mutabakat gerisini eşler.
  const [cariler, setCariler] = useState(null);
  const [cariSecili, setCariSecili] = useState(null); // ▾ açık tedarikçi satırı
  const [ekstreler, setEkstreler] = useState({});     // 📜 tedarikçi → ay-ay ekstre
  useEffect(() => {
    if (sekme !== 'tedarikci' || cariler !== null) return;
    api('/fatura/cari-ozet').then(r => setCariler(r?.tedarikciler || [])).catch(() => setCariler([]));
  }, [sekme, cariler]);
  const cariAc = (ad) => {
    setCariSecili(s => (s === ad ? null : ad));
    if (!ekstreler[ad]) {
      api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(ad)}`)
        .then(r => setEkstreler(e => ({ ...e, [ad]: r })))
        .catch(() => setEkstreler(e => ({ ...e, [ad]: { hata: true } })));
    }
  };
  // 🗂 sekme şeridi (sahip: 'yan yana başlıklar'): ilk girişte en çok çalışılan
  // tedarikçi otomatik seçilir — boş detay alanı kalmasın. Tedarikçi Kontrol'den
  // '💸 Ödeme ekranında aç' ile gelinmişse O tedarikçi seçilir (gevşek ad eşleşmesi:
  // TM fatura ünvanı taşır, burada kısa ad olabilir).
  useEffect(() => {
    if (!cariler) return;
    let hedefAd = null;
    try {
      hedefAd = sessionStorage.getItem('om_ac_tedarikci');
      if (hedefAd) { sessionStorage.removeItem('om_ac_tedarikci'); setSekme('tedarikci'); }
    } catch { /* yoksay */ }
    if (hedefAd) {
      const u = hedefAd.trim().toUpperCase();
      const aday = malCariListesi(cariler).find(t =>
        t.tedarikci.toUpperCase() === u
        || t.tedarikci.toUpperCase().includes(u) || u.includes(t.tedarikci.toUpperCase())
        || (t.resmi_adlar || []).some(r => r.toUpperCase() === u || r.toUpperCase().includes(u) || u.includes(r.toUpperCase())));
      if (aday) { cariAc(aday.tedarikci); return; }
    }
    if (sekme !== 'tedarikci' || cariSecili) return;
    const ilk = malCariListesi(cariler)[0];
    if (ilk) cariAc(ilk.tedarikci);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sekme, cariler, cariSecili]);

  // ── TEK ÖDEME MODALI ──
  const [sec, setSec] = useState(null);          // seçili satır
  const [mod, setMod] = useState('tam');         // tam | kismi | vadeye (fatura satırı)
  const [tutar, setTutar] = useState('');
  const [kalanVade, setKalanVade] = useState('');
  const [yontem, setYontem] = useState('nakit');
  const [kartId, setKartId] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [dosya, setDosya] = useState(null);
  const [mesgul, setMesgul] = useState(false);

  const ac = (r) => {
    if (r.kaynak_tablo === 'personel') {
      toast('👥 Maaş/avans ödemesi kendi akışından yapılır (Personel & Maaş ekranı) — burada sadece izlenir.', 'yellow');
      return;
    }
    setSec(r); setMod('tam');
    setTutar(r.tutar_girilmedi ? (r.tahmini_tutar || '') : r.tutar);
    setKalanVade(''); setYontem('nakit'); setKartId(''); setDosya(null); setHata('');
    const t = r.tutar_girilmedi ? (r.tahmini_tutar || 0) : r.tutar;
    api(`/anlik-gider-kart-oneri?tutar=${t || 0}`)
      .then(rr => setKartlar(Array.isArray(rr) ? rr : (rr?.kartlar || [])))
      .catch(() => setKartlar([]));
  };
  const kapat = () => { setSec(null); setHata(''); };

  const dosyaNotu = async () => {
    if (!dosya) return '';
    try { await faturaEkiYukle(dosya); return ' · 📎 fatura arşive alındı'; }
    catch (e) { return ` · ⚠ fatura yüklenemedi: ${e.message}`; }
  };

  const odemeYap = async () => {
    if (!sec) return;
    const tutarN = Number(String(tutar).replace(',', '.'));
    if (yontem === 'kart' && !kartId) { setHata('Kart seçin'); return; }
    setMesgul(true); setHata('');
    try {
      if (sec.tutar_girilmedi) {
        if (!tutarN || tutarN <= 0) { setHata('Fatura tutarını girin'); setMesgul(false); return; }
        if (mod === 'vadeye') {
          await api('/fatura-vadeye-yaz', { method: 'POST', body: { sabit_gider_id: sec.sabit_gider_id, tutar: tutarN } });
          toast(`${sec.baslik.slice(0, 40)} — ${fmt(tutarN)} vadeye yazıldı (kasa etkilenmedi)`);
        } else {
          await api('/fatura-ode', {
            method: 'POST',
            body: { sabit_gider_id: sec.sabit_gider_id, tutar: tutarN, tarih: bugunISO(), odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
          });
          toast(`Ödendi — ${yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü'}${await dosyaNotu()}`);
        }
      } else if (mod === 'kismi') {
        const isKart = sec.tip === 'Kredi Kartı';
        if (!tutarN || tutarN <= 0 || tutarN >= Number(sec.tutar)) { setHata('Kısmi tutar 0 ile borç arasında olmalı'); setMesgul(false); return; }
        // KART: kalan bir sonraki ekstreye devreder → elle vade tarihi YOK (backend is_kart_plan yolu yok sayar).
        // Diğer borçlar (vadeli/sabit): kalan için yeni vade zorunlu.
        if (!isKart && !kalanVade) { setHata('Kalan borç için yeni vade tarihi seçin'); setMesgul(false); return; }
        await api(`/odeme-plani/${sec.id}/kismi-ode`, {
          method: 'POST',
          body: { odenen_tutar: tutarN, kalan_vade_tarihi: isKart ? bugunISO() : kalanVade, odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
        });
        toast(isKart
          ? `${fmt(tutarN)} kart ödemesi · kalan ${fmt(Number(sec.tutar) - tutarN)} sonraki ekstreye devreder${await dosyaNotu()}`
          : `${fmt(tutarN)} ödendi · kalan ${fmt(Number(sec.tutar) - tutarN)} → ${kalanVade}${await dosyaNotu()}`);
      } else {
        await api(`/odeme-plani/${sec.id}/ode`, {
          method: 'POST',
          body: { odeme_yontemi: yontem, kart_id: yontem === 'kart' ? kartId : null },
        });
        toast(`${sec.baslik.slice(0, 40)} ödendi — ${yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü'}${await dosyaNotu()}`);
      }
      kapat(); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { setHata(e?.message || 'Ödenemedi'); }
    finally { setMesgul(false); }
  };

  // ── ERTELE MODALI (window.prompt yerine) ──
  const [erteleAcik, setErteleAcik] = useState(false);
  const [erteleTarih, setErteleTarih] = useState('');
  const erteleBaslat = () => { setErteleTarih(artiGunISO(7)); setErteleAcik(true); };
  const erteleUygula = async () => {
    if (!sec || !erteleTarih) return;
    setMesgul(true);
    try {
      await api(`/odeme-plani/${sec.id}/ertele?yeni_tarih=${encodeURIComponent(erteleTarih)}`, { method: 'POST' });
      toast(`Ertelendi → ${erteleTarih}`, 'yellow');
      setErteleAcik(false); kapat(); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { setHata(e?.message || 'Ertelenemedi'); }
    finally { setMesgul(false); }
  };

  // ── ➕ TEK SİHİRBAZ — 3 formun yeni tek evi ──
  // adim: 'soru' (para çıktı mı?) | 'serbest' | 'soz-soru' | 'taahhut' | 'fatura'
  const [siha, setSiha] = useState(null);
  const sihirbazAc = () => { setSiha('soru'); setTUyari(null); setHata(''); };
  const sihirbazKapat = () => { setSiha(null); setTUyari(null); };

  // Serbest ödeme (para ÇIKTI — anlık gider)
  const [sf, setSf] = useState({ kategori: 'Diğer', tutar: '', aciklama: '', sube: 'MERKEZ', odeme_yontemi: 'nakit', kart_id: '', tedarikci: '' });
  const [sDosya, setSDosya] = useState(null);
  const [subeler, setSubeler] = useState([]);
  const [tedarikciler, setTedarikciler] = useState([]);
  useEffect(() => {
    api('/subeler').then(r => setSubeler(Array.isArray(r) ? r : [])).catch(() => {});
    api('/tedarikciler').then(r => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || []))).catch(() => {});
  }, []);
  const serbestKaydet = async () => {
    const t = Number(String(sf.tutar).replace(',', '.'));
    if (!t || t <= 0) { toast('Geçerli tutar girin', 'red'); return; }
    if (sf.odeme_yontemi === 'kart' && !sf.kart_id) { toast('Kart seçin', 'red'); return; }
    setMesgul(true);
    try {
      const body = { ...sf, tutar: t, tarih: bugunISO() };
      if (!sDosya) body.aciklama = `${(sf.aciklama || '').trim()} [faturasız alım]`.trim();
      if (sf.odeme_yontemi === 'nakit') delete body.kart_id;
      const res = await api('/anlik-gider', { method: 'POST', body });
      if (res && res.warning) { toast(res.mesaj || 'Mükerrer olabilir', 'red'); setMesgul(false); return; }
      let not = ' · faturasız alım olarak girildi';
      if (sDosya) { try { await faturaEkiYukle(sDosya); not = ' · 📎 fatura arşive alındı'; } catch (e) { not = ` · ⚠ ${e.message}`; } }
      toast((sf.odeme_yontemi === 'kart' ? 'Eklendi — karta yazıldı' : 'Eklendi — kasadan düşüldü')
        + (sf.tedarikci ? ' · 🏪 tedarikçiye ödeme olarak izlendi' : '') + not);
      setSf({ kategori: 'Diğer', tutar: '', aciklama: '', sube: sf.sube, odeme_yontemi: 'nakit', kart_id: '', tedarikci: '' });
      setSDosya(null); sihirbazKapat(); yukle(); publishGlobalDataRefresh('odeme-merkezi');
    } catch (e) { toast(e?.message || 'Kaydedilemedi', 'red'); }
    finally { setMesgul(false); }
  };
  useEffect(() => {
    if (siha === 'serbest' && sf.odeme_yontemi === 'kart') {
      api(`/anlik-gider-kart-oneri?tutar=${Number(String(sf.tutar).replace(',', '.')) || 0}`)
        .then(rr => setKartlar(Array.isArray(rr) ? rr : (rr?.kartlar || []))).catch(() => {});
    }
  }, [siha, sf.odeme_yontemi, sf.tutar]);

  // 🤝 Taahhüt (para ÇIKMADI — söz; borç yaratmaz, faturası gelince oto birleşir)
  const [tf, setTf] = useState({ tedarikci: '', tutar: '', vade: '', aciklama: '' });
  const [tUyari, setTUyari] = useState(null); // {mesaj, kod} — confirm yerine satır içi karar kutusu
  const taahhutKaydet = async (ekstra = {}) => {
    const tut = parseFloat(String(tf.tutar).replace(',', '.'));
    if (!tf.tedarikci.trim() || !tut || !tf.vade) { toast('Tedarikçi, tutar ve vade tarihi zorunlu.', 'red'); return; }
    setMesgul(true);
    try {
      const r = await api('/vadeli-alimlar', { method: 'POST', body: {
        tedarikci: tf.tedarikci.trim(), tutar: tut, vade_tarihi: tf.vade,
        aciklama: `🤝 Taahhüt: ${tf.aciklama.trim() || 'ödeme sözü'}`, ...ekstra,
      } });
      if (r?.warning) { setTUyari({ mesaj: r.mesaj || 'Benzer kayıt olabilir', kod: r.kod || '' }); setMesgul(false); return; }
      toast(`Taahhüt kaydedildi — ${tf.vade} günü bekleyenlerde görünecek.`);
      setTf({ tedarikci: '', tutar: '', vade: '', aciklama: '' });
      setTUyari(null); sihirbazKapat(); yukle();
    } catch (e) { toast(e?.message || 'kaydedilemedi', 'red'); }
    finally { setMesgul(false); }
  };

  // 📄 Faturadan Vadeye (para ÇIKMADI — okunmuş faturayı takvime bağla)
  const [fvTed, setFvTed] = useState('');
  const [fvFaturalar, setFvFaturalar] = useState([]);
  const [fvSecili, setFvSecili] = useState(null);   // vade tarihi sorulan fatura id
  const [fvVade, setFvVade] = useState('');
  const fvGetir = async () => {
    try {
      const r = await api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(fvTed.trim())}`);
      setFvFaturalar((r?.faturalar || []).filter(f => (f.tutar || 0) > 0).slice(-10).reverse());
      setFvSecili(null);
    } catch (e) { toast(e?.message || 'faturalar alınamadı', 'red'); setFvFaturalar([]); }
  };
  const fvYaz = async (f) => {
    if (!fvVade) { toast('Vade tarihi seçin', 'red'); return; }
    setMesgul(true);
    try {
      await api('/vadeli-alimlar', { method: 'POST', body: {
        tedarikci: fvTed.trim(), tutar: f.tutar, vade_tarihi: fvVade,
        aciklama: `Fatura ${f.fatura_no || String(f.id).slice(0, 8)} — vadeye yazıldı (Ödeme Merkezi)`,
      } });
      toast(`${fmt(f.tutar)} vadeye yazıldı (${fvVade}) — bekleyenlere düşecek.`);
      setFvSecili(null); sihirbazKapat(); yukle();
    } catch (e) { toast(e?.message || 'vadeye yazılamadı', 'red'); }
    finally { setMesgul(false); }
  };

  // 📒 cari borçtan ödeme/söz — sihirbazı dolu açar (aynı delege uçları)
  const cariOde = (t) => {
    setSf(s => ({ ...s, kategori: 'Fatura', tedarikci: t.tedarikci || '',
                  tutar: Math.max(0, t.hesaplanan_acik || 0).toFixed(2),
                  aciklama: `Cari borç ödemesi — ${t.tedarikci || ''}`.slice(0, 80) }));
    setSDosya(null); setSiha('serbest'); setHata('');
  };
  const cariVade = (t) => {
    setTf({ tedarikci: t.tedarikci || '', tutar: Math.max(0, t.hesaplanan_acik || 0).toFixed(2),
            vade: artiGunISO(7), aciklama: 'cari borç için ödeme sözü' });
    setTUyari(null); setSiha('taahhut'); setHata('');
  };

  // ── ☑ ÇOKLU SEÇİM + ÖDEME KOŞUSU ──
  const [secim, setSecim] = useState(() => new Set());
  const [kosu, setKosu] = useState(null);   // {yontem, kartId, sonuc: null|[{id,baslik,tutar,ok,mesaj}], calisiyor}
  // personel satırı seçilemez/ödenemez (v1 salt-görünüm — maaş akışı tek yazıcı)
  const secilebilir = (r) => !r.tutar_girilmedi && !String(r.id).startsWith('fatura_') && r.kaynak_tablo !== 'personel';
  const secToggle = (id) => setSecim(s => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const seciliSatirlar = (liste || []).filter(r => secim.has(r.id));
  const seciliToplam = seciliSatirlar.reduce((s, r) => s + (Number(r.tutar) || 0), 0);
  const kosuBaslat = () => {
    setKosu({ yontem: 'nakit', kartId: '', sonuc: null, calisiyor: false });
    api(`/anlik-gider-kart-oneri?tutar=${seciliToplam || 0}`)
      .then(rr => setKartlar(Array.isArray(rr) ? rr : (rr?.kartlar || []))).catch(() => setKartlar([]));
  };
  const kosuCalistir = async () => {
    // Codex reçetesi: tek transaction DEĞİL — mevcut tek-yazıcı uca SIRAYLA çağrı,
    // satır bazlı başarı/hata dökümü. Guard/kilit/dedup mantığı uçlarda zaten var.
    if (kosu.yontem === 'kart' && !kosu.kartId) { toast('Kart seçin', 'red'); return; }
    setKosu(k => ({ ...k, calisiyor: true, sonuc: [] }));
    const sonuc = [];
    for (const r of seciliSatirlar) {
      try {
        await api(`/odeme-plani/${r.id}/ode`, {
          method: 'POST',
          body: { odeme_yontemi: kosu.yontem, kart_id: kosu.yontem === 'kart' ? kosu.kartId : null },
        });
        sonuc.push({ id: r.id, baslik: r.baslik, tutar: r.tutar, ok: true });
      } catch (e) {
        sonuc.push({ id: r.id, baslik: r.baslik, tutar: r.tutar, ok: false, mesaj: e?.message || 'ödenemedi' });
      }
      setKosu(k => k ? { ...k, sonuc: [...sonuc] } : k);
    }
    setKosu(k => k ? { ...k, calisiyor: false, sonuc } : k);
    setSecim(new Set()); yukle(); publishGlobalDataRefresh('odeme-merkezi');
  };

  // ── LİSTE HESAPLARI ──
  // 🗂 önce alt sekme süzer (tek kuyruk üstünde filtre), sonra zaman/tür bölümleri
  const sekmePred = (SEKMELER.find(([k]) => k === sekme) || SEKMELER[0])[2];
  const sekmeListe = (liste || []).filter(sekmePred);
  const gecikmis = sekmeListe.filter(r => r.gecikmis);
  const bugunkuler = sekmeListe.filter(r => !r.gecikmis && (r.gun_gecikme === 0 || r.tutar_girilmedi));
  const yaklasan = sekmeListe.filter(r => !r.gecikmis && r.gun_gecikme < 0 && !r.tutar_girilmedi);
  const topla = (arr) => arr.reduce((s, r) => s + (Number(r.tutar) || 0), 0);
  const gecikmisT = topla(gecikmis), bugunT = topla(bugunkuler), yaklasanT = topla(yaklasan);

  const filtreUygula = (arr) => arr.filter(r =>
    filtre === 'tumu' ? true
      : filtre === 'gecikmis' ? r.gecikmis
        : filtre === 'bugun' ? (!r.gecikmis && (r.gun_gecikme === 0 || r.tutar_girilmedi))
          : filtre === 'tutar' ? r.tutar_girilmedi : true);

  const zamanEtiket = (r) => r.gecikmis ? `${r.gun_gecikme} gün gecikti`
    : (r.gun_gecikme < 0 ? (r.gun_gecikme === -1 ? 'yarın' : `${-r.gun_gecikme} gün sonra`)
      : (r.tutar_girilmedi ? 'tutar bekleniyor' : 'bugün'));

  const Satir = ({ r }) => {
    const renk = r.gecikmis ? 'var(--red)' : (r.gun_gecikme < 0 ? 'var(--text3)' : 'var(--orange)');
    const secili = secim.has(r.id);
    return (
      <div onClick={() => ac(r)}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                 padding: '12px 12px', margin: '6px 0', borderRadius: 10, cursor: 'pointer',
                 background: secili ? 'var(--accent-dim, var(--bg3, var(--bg2)))' : 'var(--bg2)',
                 borderLeft: `4px solid ${renk}`,
                 outline: secili ? '2px solid var(--accent)' : 'none',
                 transition: 'transform .08s, background .12s' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {secilebilir(r) && (
            <input type="checkbox" checked={secili} onChange={() => secToggle(r.id)}
              onClick={e => e.stopPropagation()}
              style={{ width: 20, height: 20, cursor: 'pointer', flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 20 }}>{TIP_IKON[r.tip] || '💸'}</span>
          <span style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>{r.baslik}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              <span style={{ color: renk, fontWeight: 700 }}>{zamanEtiket(r)}</span>
              {' · '}{r.tip}{r.tarih ? ` · ${r.tarih}` : ''}
            </div>
          </span>
        </span>
        <span style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 15 }}>
              {r.tutar_girilmedi ? (r.tahmini_tutar ? `≈ ${fmt(r.tahmini_tutar)}` : '—') : fmt(r.tutar)}
            </div>
            {r.asgari != null && <div style={{ fontSize: 10, color: 'var(--text3)' }}>asgari {fmt(r.asgari)}</div>}
          </span>
          {r.kaynak_tablo === 'personel' ? (
            <span style={{ fontSize: 11, color: 'var(--text3)', minWidth: 86, textAlign: 'right' }}>maaş akışında</span>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); ac(r); }}
              style={{ minWidth: 86 }}>{r.tutar_girilmedi ? 'Tutarı Gir' : 'Öde ›'}</button>
          )}
        </span>
      </div>
    );
  };

  const Bolum = ({ ad, renk, satirlar, toplam }) => satirlar.length > 0 && (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 4px' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: renk, letterSpacing: 0.5 }}>{ad} ({satirlar.length})</span>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: renk, fontWeight: 700 }}>{fmt(toplam)}</span>
      </div>
      {satirlar.map(r => <Satir key={r.id} r={r} />)}
    </div>
  );

  const TUR_GRUPLARI = [
    ['💳 KREDİ KARTLARI', ['Kredi Kartı']],
    ['🏦 KREDİLER / TAKSİTLER', ['Borç Taksiti']],
    ['📦 VADELİ BORÇLAR (TEDARİKÇİ)', ['Vadeli Alım']],
    ['👥 PERSONEL (MAAŞ / AVANS)', ['Personel Ödemesi']],
    ['⚡ DEĞİŞKEN FATURALAR', ['Fatura (tutar bekleniyor)']],
    ['🏠 SABİT GİDERLER', ['Sabit Gider']],
  ];
  const turSirala = (arr) => [...arr].sort((a, b) => (b.gecikmis ? 1 : 0) - (a.gecikmis ? 1 : 0) || (b.gun_gecikme || 0) - (a.gun_gecikme || 0));
  const turGruplari = TUR_GRUPLARI.map(([ad, tipler]) => {
    const satirlar = turSirala(filtreUygula(sekmeListe.filter(r => tipler.includes(r.tip))));
    return { ad, satirlar, toplam: topla(satirlar), gecikmisVar: satirlar.some(r => r.gecikmis) };
  });
  const turDisi = turSirala(filtreUygula(sekmeListe.filter(r => !TUR_GRUPLARI.some(([, t]) => t.includes(r.tip)))));

  // Sihirbaz seçenek kartı
  const SecenekKart = ({ ikon, ad, alt, onClick }) => (
    <button onClick={onClick}
      style={{ flex: 1, minWidth: 160, padding: '18px 12px', borderRadius: 12, cursor: 'pointer',
               border: '2px solid var(--border)', background: 'var(--bg2)', textAlign: 'center',
               color: 'var(--text, inherit)' /* ham <button> koyu temada siyah yazar — okunmazdı */ }}>
      <div style={{ fontSize: 30 }}>{ikon}</div>
      <div style={{ fontWeight: 800, fontSize: 15, marginTop: 4 }}>{ad}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{alt}</div>
    </button>
  );

  const kokpitKartlar = kokpit ? [
    ['💰 Kasa', kokpit.kasa, null, 'var(--green, #22c55e)', true],
    ['⚠ Gecikmiş', kokpit.gecikmis_toplam, `${kokpit.gecikmis_adet} ödeme`, 'var(--red)', kokpit.gecikmis_toplam > 0],
    ['📅 7 gün çıkış', kokpit.cikis_7, null, 'var(--orange)', false],
    ['🗓 30 gün çıkış', kokpit.cikis_30, null, 'var(--text2, var(--text))', false],
    ['📉 ≈ En düşük bakiye', kokpit.en_dusuk_bakiye, kokpit.en_dusuk_tarih,
      kokpit.en_dusuk_bakiye < 0 ? 'var(--red)' : 'var(--text2, var(--text))', kokpit.en_dusuk_bakiye < 0],
  ] : null;

  return (
    <div className="page" style={{ paddingBottom: secim.size > 0 ? 90 : undefined }}>
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2>💸 Ödeme Merkezi</h2>
          <p>Tüm para çıkışı tek kapıdan — sistem doğru deftere kendisi dağıtır.</p>
        </div>
        <button className="btn btn-primary" style={{ fontSize: 15, padding: '10px 18px' }}
          onClick={sihirbazAc}>➕ Yeni Ödeme / Söz</button>
      </div>

      {/* 🧭 NAKİT KOKPİTİ — karar bağlamı (Codex: ABEK'i bekleme, kokpiti hemen çıkar) */}
      {kokpitKartlar && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          {kokpitKartlar.map(([ad, val, alt, renk, vurgu]) => (
            <div key={ad} className="card" style={{ padding: '10px 16px', minWidth: 150, flex: '1 1 150px', borderTop: `3px solid ${renk}` }}>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>{ad}{alt ? ` · ${alt}` : ''}</div>
              <div style={{ fontWeight: 800, fontFamily: 'var(--font-mono)', fontSize: vurgu ? 21 : 16, color: renk }}>{fmt(val)}</div>
            </div>
          ))}
        </div>
      )}
      {kokpit && (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 12 }}>
          ≈ tahmin: günlük ciro ortalaması + bekleyen ödeme takvimi (maaş hariç) — kesinlik iddiası yok.
        </div>
      )}

      {/* FAZ D — mutabakat sağlığı (sade dil) */}
      {apm && (
        <div className={`alert-box ${apm.saglikli ? 'green' : 'yellow'} mb-16`} style={{ cursor: 'pointer' }}
          onClick={() => setApmAcik(a => !a)}>
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>
                {apm.saglikli
                  ? '✅ Borç defteri ile ödeme kuyruğu birbirini tutuyor'
                  : `⚠ ${apm.uyumsuz_adet} tedarikçide borç defteri ile ödeme kuyruğu farklı konuşuyor`}
                <span style={{ color: 'var(--text3)', fontWeight: 400 }}>
                  {' '}· defterdeki borç {fmt(apm.toplam_cari_acik)} / kuyruktaki söz {fmt(apm.toplam_kuyruk)}
                </span>
              </span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>{apmAcik ? 'gizle ▴' : 'detay ▾'}</span>
            </div>
            {apmAcik && (apm.tedarikciler || []).filter(t => !t.uyumlu).length > 0 && (
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {apm.tedarikciler.filter(t => !t.uyumlu).slice(0, 10).map((t, i) => (
                  <div key={i} style={{ padding: '3px 0', borderTop: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span><b>{t.tedarikci}</b> · {t.yon === 'kuyruk_eksik' ? 'borç var ama ödeme kuyruğunda yok' : 'kuyrukta söz var ama defterde borç yok'}</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>defter {fmt(t.cari_acik)} / kuyruk {fmt(t.kuyruk_toplam)}</span>
                    </div>
                    {/* NEDEN dökümü — fatura damgaları + açık sözler (veri konuşsun) */}
                    {t.detay && (
                      <div style={{ marginTop: 2, marginLeft: 10, fontSize: 11, color: 'var(--text3)' }}>
                        {(t.detay.faturalar || []).slice(0, 4).map((f, j) => (
                          <div key={'f' + j}>
                            📄 {f.tarih || '?'} · {fmt(f.tutar)} · {
                              f.kuyruk_damga === 'bagli' ? 'kuyruğa bağlı'
                              : f.kuyruk_damga === 'odenmis' ? 'ödenmiş sayıldı (iz var)'
                              : f.kuyruk_damga === 'insan' ? '⚠ insan kararı bekliyor'
                              : f.kuyruk_damga === 'arsiv' ? 'sistem-öncesi arşiv'
                              : '⚠ kuyruğa hiç girmemiş'}
                          </div>
                        ))}
                        {(t.detay.acik_sozler || []).map((v, j) => (
                          <div key={'v' + j}>🤝 açık söz: {fmt(v.tutar)} · vade {v.vade}{v.aciklama ? ` · ${v.aciklama.slice(0, 40)}` : ''}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                  Öneri-only — hüküm insanın. Her satır sahiple tek tek konuşularak çözülür.
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {hata && !sec && !siha && <div className="alert-box red mb-16">{hata}</div>}
      {liste === null && <div style={{ color: 'var(--text3)' }}>Yükleniyor…</div>}

      {/* 🗂 ALT SEKMELER — sahip kurgusu: her ay ödeme yapılan alanlar tek çatıda */}
      {liste !== null && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {SEKMELER.map(([k, et, pred]) => {
            const arr = (liste || []).filter(pred);
            const t = topla(arr);
            const aktif = sekme === k;
            const gecVar = arr.some(r => r.gecikmis);
            return (
              <button key={k} onClick={() => { setSekme(k); setSecim(new Set()); }}
                style={{ padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                         border: aktif ? '2px solid var(--accent)' : '1px solid var(--border)',
                         background: aktif ? 'var(--accent-dim, var(--bg3, var(--bg2)))' : 'var(--bg2)',
                         fontWeight: aktif ? 800 : 600, fontSize: 13,
                         color: 'var(--text, inherit)',
                         display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{et}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)',
                               color: gecVar ? 'var(--red)' : 'var(--text3)' }}>
                  {arr.length}{t > 0 ? ` · ${fmt(t)}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 🏛 RESMİ ÖDEMELER bloğu (v1: sekme değil blok — ikinci resmi tip gelince terfi) */}
      {sekme === 'tumu' && kdvPoz && (kdvPoz.toplam_odenecek_tl || 0) > 0 && (
        <div className="card" style={{ padding: '10px 16px', marginBottom: 10, display: 'flex',
                                       justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>
            🏛 Resmi Ödemeler — Ödenecek KDV (son {kdvPoz.gun} gün)
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}> · bilgi amaçlı, kuyruğa dahil değil</span>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800 }}>≈ {fmt(kdvPoz.toplam_odenecek_tl)}</span>
        </div>
      )}

      {liste !== null && sekme !== 'tedarikci' && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 6 }}>
            <div style={{ fontWeight: 800 }}>
              {(SEKMELER.find(([k]) => k === sekme) || SEKMELER[0])[1]} — Bekleyenler ({sekmeListe.length})
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {[['tumu', 'Tümü'], ['gecikmis', '⚠ Gecikmiş'], ['bugun', '🗓 Bugün'], ['tutar', '⚡ Tutar bekleyen']].map(([f, et]) => (
                <button key={f} className="btn btn-secondary btn-sm"
                  style={{ fontWeight: filtre === f ? 800 : 400, border: filtre === f ? '2px solid var(--accent)' : undefined }}
                  onClick={() => setFiltre(f)}>{et}</button>
              ))}
              <span style={{ width: 8 }} />
              {[['zaman', '⏱ Zaman'], ['tur', '🗂 Tür']].map(([m, et]) => (
                <button key={m} className="btn btn-secondary btn-sm"
                  style={{ fontWeight: grupla === m ? 800 : 400, border: grupla === m ? '2px solid var(--accent)' : undefined }}
                  onClick={() => setGrupla(m)}>{et}</button>
              ))}
              <span style={{ width: 8 }} />
              {[7, 30, 60].map(g => (
                <button key={g} className="btn btn-secondary btn-sm"
                  style={{ fontWeight: pencere === g ? 800 : 400, border: pencere === g ? '2px solid var(--accent)' : undefined }}
                  onClick={() => setPencere(g)}>{g} gün</button>
              ))}
            </div>
          </div>
          {sekmeListe.length === 0 && (
            <div style={{ textAlign: 'center', padding: 30, color: 'var(--text3)' }}>
              <div style={{ fontSize: 40, marginBottom: 6 }}>🎉</div>
              {sekme === 'tumu' ? 'Bekleyen ödeme yok — kasan rahat.' : 'Bu alanda bekleyen ödeme yok.'}
            </div>
          )}
          {grupla === 'zaman' ? (
            <>
              <Bolum ad="GECİKMİŞ" renk="var(--red)" satirlar={filtreUygula(gecikmis)} toplam={topla(filtreUygula(gecikmis))} />
              <Bolum ad="BUGÜN / TUTAR BEKLEYEN" renk="var(--orange)" satirlar={filtreUygula(bugunkuler)} toplam={topla(filtreUygula(bugunkuler))} />
              <Bolum ad={`YAKLAŞAN (${pencere} GÜN)`} renk="var(--text3)" satirlar={filtreUygula(yaklasan)} toplam={topla(filtreUygula(yaklasan))} />
            </>
          ) : (
            <>
              {turGruplari.map(g => (
                <Bolum key={g.ad} ad={g.ad} renk={g.gecikmisVar ? 'var(--red)' : 'var(--text2, var(--text))'}
                  satirlar={g.satirlar} toplam={g.toplam} />
              ))}
              <Bolum ad="DİĞER" renk="var(--text3)" satirlar={turDisi} toplam={topla(turDisi)} />
            </>
          )}
          {sekmeListe.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              ☑ Kutucuklarla birden çok ödeme seçip alttan tek seferde ödeyebilirsin.
              {sekme === 'personel' && ' Maaş/avans ödemeleri kendi akışından yapılır — burada izlenir.'}
            </div>
          )}

          {/* 💳 ARA ÖDEME BLOĞU (2026-07-27, sahip: 'merkez alandan da ara ödeme imkânı'):
              dönem kapanmış (aktif planı yok) ama borcu süren kartlar burada HER ZAMAN
              görünür — kart borçlu bir kart ödeme ekranından asla kaybolmaz. */}
          {(sekme === 'tumu' || sekme === 'kart') && (() => {
            const planBasliklar = (liste || []).filter(r => r.tip === 'Kredi Kartı').map(r => String(r.baslik || ''));
            const plansizlar = kartOzetler.filter(k => (Number(k.guncel_borc) || 0) > 0.01
              && !planBasliklar.some(b => b.includes(String(k.kart_adi || '—'))));
            if (plansizlar.length === 0) return null;
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 4px' }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2, var(--text))', letterSpacing: 0.5 }}>
                    💳 KART ARA ÖDEME ({plansizlar.length}) — dönem kapalı, borç sürüyor
                  </span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text2, var(--text))', fontWeight: 700 }}>
                    {fmt(plansizlar.reduce((s, k) => s + (Number(k.guncel_borc) || 0), 0))}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', padding: '0 4px 4px' }}>
                  Bu kartların bu dönem planı kapandı (asgari/tam ödendi) ya da yeni ekstre bekleniyor —
                  istersen beklemeden ara ödeme yap, borç ve gelecek ekstre devri küçülür.
                </div>
                {plansizlar.map(k => (
                  <div key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                                           padding: '12px 12px', margin: '6px 0', borderRadius: 10,
                                           background: 'var(--bg2)', borderLeft: '4px solid var(--blue, #60a5fa)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ fontSize: 20 }}>💳</span>
                      <span style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>
                          {(k.banka || '').trim()} {k.kart_adi}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                          kesim günü {k.kesim_gunu || '—'}{k.son_odeme_tarihi ? ` · sıradaki son ödeme ${k.son_odeme_tarihi}` : ''}
                        </div>
                      </span>
                    </span>
                    <span style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 15 }}>{fmt(k.guncel_borc)}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>güncel borç</div>
                      </span>
                      <button className="btn btn-primary btn-sm" style={{ minWidth: 100 }}
                        onClick={() => setAraKart(k)}>💸 Ara Ödeme</button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* 🏪 TEDARİKÇİ — BİRLEŞİK GÖRÜNÜM (sahip: 'aynı borç iki yerde
          görünmesin'): tedarikçi başına TEK satır — cari açık + ne kadarı
          takvimli (kuyruk sözü) / takvimsiz; satıra tıklayınca o tedarikçinin
          sözleri açılır (oradan ödenir). Sözler cariye görsel eşlenir
          (tedarikciEslesir) — yazma yok, çift sayım görüntüsü yok. */}
      {sekme === 'tedarikci' && (() => {
        // gecici = internetten kartla tek seferlik alım (ödemesi kart ekstresinde) — cari takip edilmez
        const sozler = (liste || []).filter(r => r.kaynak_tablo === 'vadeli_alimlar'
          && r.tedarikci_sinif !== 'hizmet' && r.tedarikci_sinif !== 'gecici');
        // 🏪 HER SÜREKLİ TEDARİKÇİ = KART (sahip: 'her tedarikçi tek tek başlık/kart
        // olsun; kullanımı fazla olanlar başta; eklendikçe kart da eklenir'):
        // borcu 0 olsa da faturası/hareketi olan tedarikçi listede KALIR (SÜTAŞ dersi —
        // beyanla sıfırlandı diye kaybolmasın); sıralama = KULLANIM (6 ay fatura adet,
        // eş adette ciro), borç değil. Yeni tedarikçi faturası yüklenince cari-ozet'ten
        // kendiliğinden kart olur — elle ekleme yok.
        const malCariler = malCariListesi(cariler);
        const kullanilan = new Set();
        const gruplar = malCariler.map(t => {
          const ait = sozler.filter(r => !kullanilan.has(r.id) && tedarikciEslesir(r.tedarikci || r.baslik, t.tedarikci));
          ait.forEach(r => kullanilan.add(r.id));
          const takvimli = ait.reduce((s, r) => s + (Number(r.tutar) || 0), 0);
          return { t, ait, takvimli, takvimsiz: Math.max(0, (t.hesaplanan_acik || 0) - takvimli) };
        });
        const serbestSozler = sozler.filter(r => !kullanilan.has(r.id));
        // 📦 DİĞER (sahip: 'diğer alanı kurun — tek ödemeler / tedarikçide
        // birleşmeyen alanlar alt alta'): geçici sınıf = tek seferlik internet/kart
        // alımı (ASSA, D-MARKET — ödemesi kart ekstresinde, sürekli cari değil).
        // Kart değil sade satır — sürekli tedarikçiyle karışmasın.
        const digerCariler = (cariler || []).filter(t => (t.sinif || '') === 'gecici')
          .sort((a, b) => (b.hesaplanan_acik || 0) - (a.hesaplanan_acik || 0));
        return (
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>
              🏪 Tedarikçiler <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>— yan yana başlıklar; en çok çalışılan solda; başlığa tıkla, altında ekstresi açılır</span>
            </div>
            {cariler === null && <div style={{ color: 'var(--text3)', fontSize: 13 }}>Yükleniyor…</div>}
            {cariler !== null && gruplar.length === 0 && serbestSozler.length === 0 && (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--text3)' }}>
                <div style={{ fontSize: 40, marginBottom: 6 }}>🎉</div>Kayıtlı tedarikçi hareketi yok — ilk fatura yüklenince kartı burada belirir.
              </div>
            )}
            {/* 🗂 YAN YANA BAŞLIK ŞERİDİ (sahip: 'tedarikçiler yan yana sekmeler
                halinde başlıklar olsun') — durum noktası + ad + açık bakiye;
                tıkla → altta o tedarikçinin detayı/ekstresi */}
            {gruplar.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0 14px' }}>
                {gruplar.map(({ t, takvimsiz }, i) => {
                  const acik = t.hesaplanan_acik || 0;
                  const seciliMi = cariSecili === t.tedarikci;
                  const kapali = acik <= 1;
                  const gecikmisVade = !kapali && t.en_yakin_vade && t.en_yakin_vade < bugunISO() && (t.bekleyen_vade_toplam || 0) > 0;
                  const durumRenk = kapali ? 'var(--green, #22c55e)' : gecikmisVade ? 'var(--red, #ef4444)'
                    : takvimsiz > Math.max(500, acik * 0.05) ? 'var(--orange)' : 'var(--green, #22c55e)';
                  return (
                    <button key={i} onClick={() => { if (!seciliMi) cariAc(t.tedarikci); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 13px', borderRadius: 10,
                               cursor: 'pointer', fontWeight: 700, fontSize: 12.5, maxWidth: 250,
                               border: `1px solid ${seciliMi ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
                               background: seciliMi ? 'var(--accent, #c9853f)' : 'var(--bg2)',
                               color: seciliMi ? '#1a120b' : 'var(--text)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: durumRenk }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.tedarikci}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 11,
                                     color: seciliMi ? '#1a120b' : 'var(--text3)', flexShrink: 0 }}>{fmt(acik)}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {/* 📌 SEÇİLİ TEDARİKÇİNİN DETAYI — başlık bilgisi + sözler + ekstre */}
            {(() => {
              const g = gruplar.find(x => x.t.tedarikci === cariSecili);
              if (!g) return null;
              const { t, ait, takvimli, takvimsiz } = g;
              const acik = t.hesaplanan_acik || 0;
              const kapali = acik <= 1;
              const gecikmisVade = !kapali && t.en_yakin_vade && t.en_yakin_vade < bugunISO() && (t.bekleyen_vade_toplam || 0) > 0;
              const durumRenk = kapali ? 'var(--green, #22c55e)' : gecikmisVade ? 'var(--red, #ef4444)'
                : takvimsiz > Math.max(500, acik * 0.05) ? 'var(--orange)' : 'var(--green, #22c55e)';
              return (
                <div style={{ borderRadius: 14, background: 'var(--bg2)', border: '1px solid var(--border)',
                              overflow: 'hidden', borderLeft: `4px solid ${durumRenk}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                                padding: '13px 14px', flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>
                        {t.tedarikci}
                        {kapali && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 8,
                                                  border: '1px solid var(--green, #22c55e)', color: 'var(--green, #22c55e)' }}>cari kapalı ✓</span>}
                        {gecikmisVade && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 8,
                                                        border: '1px solid var(--red, #ef4444)', color: 'var(--red, #ef4444)' }}>vadesi geçti</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 3 }}>
                        📄 {t.fatura_adet_6ay || 0} fatura (6 ay) · {fmt(t.fatura_toplam_6ay || 0)} alım
                        {t.son_fatura ? ` · son ${trT(String(t.son_fatura))}` : ''}
                        {!kapali && takvimli > 0 ? ` · takvimli ${fmt(takvimli)}` : ''}
                        {!kapali && takvimsiz > 0 ? ` · ⚠ takvimsiz ${fmt(takvimsiz)}` : ''}
                        {(t.resmi_adlar || []).length > 0 && (
                          <span> · 🔗 {t.resmi_adlar.map(a => a.split(' ').slice(0, 2).join(' ')).join(' + ')}</span>
                        )}
                      </div>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)' }}>açık bakiye</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 16,
                                      color: kapali ? 'var(--green, #22c55e)' : 'var(--text)' }}>{fmt(acik)}</div>
                      </span>
                      {!kapali && (
                        <>
                          <button className="btn btn-primary btn-sm" onClick={() => cariOde(t)}>💸 Öde</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => cariVade(t)}>🤝 Vadeye</button>
                        </>
                      )}
                      <button className="btn btn-secondary btn-sm" title="Belge arşivi, beyan, devir, fatura kovalama — Tedarikçi Kontrol'de incele"
                        onClick={() => {
                          try { sessionStorage.setItem('tm_ac_tedarikci', t.tedarikci); } catch { /* yoksay */ }
                          window.location.hash = 'belge-merkezi';
                        }}>🏦 Tedarikçi 360</button>
                    </span>
                  </div>
                  {ait.length > 0 && (
                    <div style={{ padding: '0 10px 8px 22px' }}>
                      {ait.map(r => <Satir key={r.id} r={r} />)}
                    </div>
                  )}
                  {ait.length === 0 && !kapali && (
                    <div style={{ padding: '0 12px 10px 22px', fontSize: 12, color: 'var(--text3)' }}>
                      Kuyrukta sözü yok — 🤝 Vadeye ile takvime bağla ya da 💸 Öde.
                    </div>
                  )}
                  {/* 📒 CARİ EKSTRE — Codex çaprazlı dünya-klasmanı sunum:
                      KPI şeridi → borç/alacak/bakiye defteri → katlanır mutabakat → belgeler */}
                  {(() => {
                    const ek = ekstreler[t.tedarikci];
                    if (!ek) return <div style={{ padding: '0 12px 10px 22px', fontSize: 12, color: 'var(--text3)' }}>📜 Ekstre yükleniyor…</div>;
                    if (ek.hata) return <div style={{ padding: '0 12px 10px 22px', fontSize: 12, color: 'var(--red)' }}>Ekstre alınamadı.</div>;
                    return <CariEkstrePanel ek={ek} ad={t.tedarikci} mode="action" />;
                  })()}
                </div>
              );
            })()}
            {(digerCariler.length > 0 || serbestSozler.length > 0) && (
              <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text3)', marginBottom: 2 }}>
                  📦 DİĞER <span style={{ fontWeight: 400 }}>— tek seferlik alımlar + tedarikçi kartına birleşmeyenler</span>
                </div>
                {digerCariler.map((t, i) => {
                  const acikMi = cariSecili === t.tedarikci;
                  return (
                    <div key={`d${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
                      <div onClick={() => cariAc(t.tedarikci)}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                                 padding: '8px 6px', cursor: 'pointer', flexWrap: 'wrap' }}>
                        <span style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                            {acikMi ? '▾' : '▸'} {t.tedarikci}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                            tek seferlik alım — ödemesi kart ekstresinde izlenir
                            {t.son_fatura ? ` · son ${trT(String(t.son_fatura))}` : ''}
                          </div>
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 13 }}>
                          {fmt(t.hesaplanan_acik || 0)}
                        </span>
                      </div>
                      {acikMi && (() => {
                        const ek = ekstreler[t.tedarikci];
                        if (!ek) return <div style={{ padding: '0 6px 8px', fontSize: 12, color: 'var(--text3)' }}>📜 Ekstre yükleniyor…</div>;
                        if (ek.hata) return <div style={{ padding: '0 6px 8px', fontSize: 12, color: 'var(--red)' }}>Ekstre alınamadı.</div>;
                        return <CariEkstrePanel ek={ek} ad={t.tedarikci} mode="action" />;
                      })()}
                    </div>
                  );
                })}
                {serbestSozler.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text3)', padding: '2px 4px' }}>
                      🧾 Cariye eşleşmeyen sözler ({serbestSozler.length})
                    </div>
                    {serbestSozler.map(r => <Satir key={r.id} r={r} />)}
                  </div>
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
              Açık = fatura − ödeme izi + devir. Takvimli = kuyruktaki sözler (aynı borcun vade planı — ayrı borç DEĞİL). Ödeme izi düşünce açık kendiliğinden azalır.
            </div>
          </div>
        );
      })()}

      {/* ── ☑ YAPIŞKAN ALT BAR — ödeme koşusu (dokunmatik için büyük) ── */}
      {secim.size > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40,
                      background: 'var(--bg1, var(--bg2))', borderTop: '2px solid var(--accent)',
                      padding: '12px 20px', display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', gap: 12, flexWrap: 'wrap',
                      boxShadow: '0 -4px 16px rgba(0,0,0,.25)' }}>
          <span style={{ fontWeight: 800 }}>
            ☑ {secim.size} ödeme seçildi · <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(seciliToplam)}</span>
          </span>
          <span style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setSecim(new Set())}>Vazgeç</button>
            <button className="btn btn-primary" style={{ fontSize: 15, padding: '10px 20px' }}
              onClick={kosuBaslat}>💸 Hepsini Öde ›</button>
          </span>
        </div>
      )}

      {/* ── ÖDEME KOŞUSU MODALI ── */}
      {kosu && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && !kosu.calisiyor && setKosu(null)}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header"><h3>💸 Ödeme Koşusu — {seciliSatirlar.length || (kosu.sonuc || []).length} ödeme</h3></div>
            <div className="form-group" style={{ padding: '4px 16px 12px', display: 'grid', gap: 10 }}>
              {!kosu.sonuc && (
                <>
                  <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 12 }}>
                    {seciliSatirlar.map(r => (
                      <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{TIP_IKON[r.tip] || '💸'} {r.baslik}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmt(r.tutar)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontWeight: 800 }}>
                      <span>TOPLAM</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(seciliToplam)}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[['nakit', '💵', 'Kasa', 'kasadan düşer'], ['kart', '💳', 'Kart', 'kart borcuna yazılır']].map(([k, ikon, ad, alt]) => (
                      <button key={k} onClick={() => setKosu(x => ({ ...x, yontem: k }))}
                        style={{ flex: 1, padding: '12px 8px', borderRadius: 10, cursor: 'pointer',
                                 border: `2px solid ${kosu.yontem === k ? 'var(--accent)' : 'var(--border)'}`,
                                 background: kosu.yontem === k ? 'var(--accent-dim, var(--bg2))' : 'var(--bg2)',
                                 color: 'var(--text, inherit)', textAlign: 'center' }}>
                        <div style={{ fontSize: 22 }}>{ikon}</div>
                        <div style={{ fontWeight: 800, fontSize: 14 }}>{ad}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>{alt}</div>
                      </button>
                    ))}
                  </div>
                  {kosu.yontem === 'kart' && (
                    <select value={kosu.kartId} onChange={e => setKosu(x => ({ ...x, kartId: e.target.value }))}>
                      <option value="">Kart seçin…</option>
                      {kartlar.map(k => <option key={k.kart_id || k.id} value={k.kart_id || k.id} disabled={k.uygun === false}>
                        {(k.banka || '')} {k.kart_adi}{k.oneri ? ' ⭐' : ''}{k.kalan_limit != null ? ` — kalan ${fmt(k.kalan_limit)}` : ''}
                      </option>)}
                    </select>
                  )}
                  {kokpit && kosu.yontem === 'nakit' && seciliToplam > kokpit.kasa && (
                    <div className="alert-box red">⚠ Toplam ({fmt(seciliToplam)}) kasadaki paradan ({fmt(kokpit.kasa)}) büyük — bir kısmı reddedilebilir.</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    Ödemeler tek tek sırayla işlenir; her satırın sonucu aşağıda görünür. Biri takılırsa diğerleri etkilenmez.
                  </div>
                </>
              )}
              {kosu.sonuc && (
                <div style={{ maxHeight: 280, overflowY: 'auto', fontSize: 12 }}>
                  {kosu.sonuc.map(s => (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.ok ? '✅' : '❌'} {s.baslik}{!s.ok && s.mesaj ? ` — ${s.mesaj}` : ''}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(s.tutar)}</span>
                    </div>
                  ))}
                  {kosu.calisiyor && <div style={{ padding: 6, color: 'var(--text3)' }}>İşleniyor…</div>}
                  {!kosu.calisiyor && (
                    <div style={{ padding: '8px 0', fontWeight: 800 }}>
                      Koşu bitti: {kosu.sonuc.filter(s => s.ok).length} ödendi
                      {kosu.sonuc.some(s => !s.ok) ? ` · ${kosu.sonuc.filter(s => !s.ok).length} başarısız (listede duruyor)` : ''}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {!kosu.sonuc ? (
                <>
                  <button className="btn btn-secondary" onClick={() => setKosu(null)}>Vazgeç</button>
                  <button className="btn btn-primary" onClick={kosuCalistir}>Onayla ve Öde ({fmt(seciliToplam)})</button>
                </>
              ) : (
                <button className="btn btn-primary" disabled={kosu.calisiyor} onClick={() => setKosu(null)}>Kapat</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── ➕ SİHİRBAZ MODALI — 3 formun tek evi ── */}
      {siha && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && sihirbazKapat()}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>
                {siha !== 'soru' && (
                  <button className="btn btn-ghost btn-sm" style={{ marginRight: 8 }}
                    onClick={() => setSiha(siha === 'serbest' ? 'soru' : (siha === 'soz-soru' ? 'soru' : 'soz-soru'))}>‹ Geri</button>
                )}
                {siha === 'soru' && '➕ Yeni Ödeme / Söz'}
                {siha === 'serbest' && '💸 Ödeme Yaptım — kayda geçir'}
                {siha === 'soz-soru' && '🤝 İleride Ödeyeceğim'}
                {siha === 'taahhut' && '🤝 Ödeme Sözü (taahhüt)'}
                {siha === 'fatura' && '📄 Okunmuş Faturayı Takvime Koy'}
              </h3>
            </div>
            <div className="form-group" style={{ padding: '4px 16px 12px', display: 'grid', gap: 10 }}>
              {siha === 'soru' && (
                <>
                  <div style={{ fontSize: 13, color: 'var(--text2, var(--text))' }}>Para kasadan/karttan <b>çıktı mı?</b></div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <SecenekKart ikon="💸" ad="Evet, ödedim" alt="anlık gider — kasadan/karttan düşülür"
                      onClick={() => setSiha('serbest')} />
                    <SecenekKart ikon="🗓" ad="Hayır, ileride ödeyeceğim" alt="ödeme takvimine söz yazılır"
                      onClick={() => setSiha('soz-soru')} />
                  </div>
                </>
              )}
              {siha === 'soz-soru' && (
                <>
                  <div style={{ fontSize: 13, color: 'var(--text2, var(--text))' }}>Bu söz neye dayanıyor?</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <SecenekKart ikon="📄" ad="Okunmuş bir faturaya" alt="sistemdeki faturayı vadeye bağla"
                      onClick={() => { setSiha('fatura'); setFvVade(artiGunISO(7)); }} />
                    <SecenekKart ikon="🤝" ad="Serbest söz" alt="fatura henüz yok — borç yaratmaz, plan kaydıdır"
                      onClick={() => setSiha('taahhut')} />
                  </div>
                </>
              )}
              {siha === 'serbest' && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={sf.kategori} onChange={e => setSf({ ...sf, kategori: e.target.value })}>{KATEGORILER.map(k => <option key={k}>{k}</option>)}</select>
                    <select value={sf.sube} onChange={e => setSf({ ...sf, sube: e.target.value })}>
                      <option>MERKEZ</option>{subeler.map(s => <option key={s.id}>{s.ad}</option>)}
                    </select>
                  </div>
                  <input type="number" placeholder="Tutar ₺" value={sf.tutar} onChange={e => setSf({ ...sf, tutar: e.target.value })} />
                  <input placeholder="Açıklama (ne için ödendi?)" value={sf.aciklama} onChange={e => setSf({ ...sf, aciklama: e.target.value })} />
                  <input list="omTedarikciler" placeholder="🏪 Tedarikçi (opsiyonel — tedarikçiye ödemeyse seç)"
                    value={sf.tedarikci} onChange={e => setSf({ ...sf, tedarikci: e.target.value })} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['nakit', '💵 Nakit (kasadan)'], ['kart', '💳 Kart (borca)']].map(([k, et]) => (
                      <button key={k} className={sf.odeme_yontemi === k ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                        onClick={() => setSf({ ...sf, odeme_yontemi: k })}>{et}</button>
                    ))}
                  </div>
                  {sf.odeme_yontemi === 'kart' && (
                    <select value={sf.kart_id} onChange={e => setSf({ ...sf, kart_id: e.target.value })}>
                      <option value="">Kart seçin…</option>
                      {kartlar.map(k => <option key={k.kart_id || k.id} value={k.kart_id || k.id}>
                        {(k.banka || '')} {k.kart_adi}{k.oneri ? ' ⭐' : ''}{k.kalan_limit != null ? ` — kalan ${fmt(k.kalan_limit)}` : ''}
                      </option>)}
                    </select>
                  )}
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>📎 Fatura (opsiyonel)</div>
                    <input type="file" accept="application/pdf,image/*" onChange={e => setSDosya(e.target.files?.[0] || null)} />
                    <div style={{ fontSize: 11, color: sDosya ? 'var(--green)' : 'var(--yellow)' }}>
                      {sDosya ? `📎 ${sDosya.name} — arşive alınacak` : '⚠ Eklenmezse FATURASIZ ALIM olarak işaretlenir'}
                    </div>
                  </div>
                  <button className="btn btn-primary" disabled={mesgul} onClick={serbestKaydet}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
                </>
              )}
              {siha === 'taahhut' && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    Bu bir ödeme SÖZÜdür — borç yaratmaz (borç faturadan doğar). Faturası
                    sonradan okunursa sistem otomatik bu söze bağlar, çift kayıt olmaz.
                  </div>
                  <input list="omTedarikciler" placeholder="🏪 Tedarikçi" value={tf.tedarikci}
                    onChange={e => setTf({ ...tf, tedarikci: e.target.value })} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="number" placeholder="Tutar ₺" style={{ flex: 1 }} value={tf.tutar}
                      onChange={e => setTf({ ...tf, tutar: e.target.value })} />
                    <input type="date" style={{ flex: 1 }} value={tf.vade}
                      onChange={e => setTf({ ...tf, vade: e.target.value })} />
                  </div>
                  <input placeholder="Açıklama (ör: temmuz süt borcu)" value={tf.aciklama}
                    onChange={e => setTf({ ...tf, aciklama: e.target.value })} />
                  {tUyari && (
                    <div className="alert-box yellow" style={{ display: 'block' }}>
                      <div style={{ marginBottom: 8 }}>⚠ {tUyari.mesaj}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {tUyari.kod === 'TEDARIKCI_ACIK_BAKIYE'
                          ? <button className="btn btn-primary btn-sm" disabled={mesgul}
                              onClick={() => taahhutKaydet({ tedarikci_karari: 'ayri' })}>Ayrı satır olarak kaydet</button>
                          : <button className="btn btn-primary btn-sm" disabled={mesgul}
                              onClick={() => taahhutKaydet({ force: true })}>Yine de kaydet</button>}
                        <button className="btn btn-secondary btn-sm" onClick={() => setTUyari(null)}>Vazgeç</button>
                      </div>
                    </div>
                  )}
                  {!tUyari && (
                    <button className="btn btn-primary" disabled={mesgul} onClick={() => taahhutKaydet()}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
                  )}
                </>
              )}
              {siha === 'fatura' && (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input list="omTedarikciler" placeholder="🏪 Tedarikçi seç…" style={{ flex: 1 }}
                      value={fvTed} onChange={e => setFvTed(e.target.value)} />
                    <button className="btn btn-secondary btn-sm" disabled={fvTed.trim().length < 3}
                      onClick={fvGetir}>Faturaları Getir</button>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {fvFaturalar.map(f => (
                      <div key={f.id} style={{ fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <span>🧾 {f.tarih} · {f.fatura_no || 'no yok'} · <b style={{ fontFamily: 'var(--font-mono)' }}>{fmt(f.tutar)}</b>
                            {f.goruntule && <>{' '}<a href={f.goruntule} target="_blank" rel="noreferrer" style={{ color: 'var(--blue, #60a5fa)' }}>📎</a></>}
                          </span>
                          {fvSecili !== f.id && (
                            <button className="btn btn-sm btn-primary" onClick={() => { setFvSecili(f.id); setFvVade(artiGunISO(7)); }}>📅 Vadeye yaz</button>
                          )}
                        </div>
                        {fvSecili === f.id && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>Vade:</span>
                            <input type="date" value={fvVade} onChange={e => setFvVade(e.target.value)} />
                            <button className="btn btn-sm btn-primary" disabled={mesgul} onClick={() => fvYaz(f)}>Onayla</button>
                            <button className="btn btn-sm btn-secondary" onClick={() => setFvSecili(null)}>Vazgeç</button>
                          </div>
                        )}
                      </div>
                    ))}
                    {fvFaturalar.length === 0 && fvTed && (
                      <div style={{ fontSize: 11, color: 'var(--text3)' }}>Tedarikçiyi yazıp "Faturaları Getir"e bas — son 10 okunmuş fatura listelenir.</div>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={sihirbazKapat}>Kapat</button>
            </div>
          </div>
        </div>
      )}

      <datalist id="omTedarikciler">
        {tedarikciler.map(t => <option key={t.id || t.ad} value={t.ad} />)}
      </datalist>

      {/* 💳 ARA ÖDEME MODALI — ortak bileşen (Kartlar sayfasıyla aynı) */}
      {araKart && (
        <KartAraOdemeModal kart={araKart} kasa={kokpit?.kasa}
          onKapat={() => setAraKart(null)}
          onOdendi={(n) => { setAraKart(null); toast(`${fmt(n)} ara ödeme kaydedildi — kasadan düştü, kart borcu azaldı`);
            publishGlobalDataRefresh('kart-ara-odeme'); yukle(); }} />
      )}

      {/* ── TEK ÖDEME MODALI — her tür için aynı pencere ── */}
      {sec && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && kapat()}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-header"><h3>{TIP_IKON[sec.tip] || '💸'} {sec.baslik}</h3></div>
            <div className="form-group" style={{ padding: '4px 16px 12px', display: 'grid', gap: 10 }}>
              {hata && <div className="alert-box red">{hata}</div>}
              {sec.tutar_girilmedi ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu ayın fatura tutarını gir{sec.tahmini_tutar ? ` (geçen ay ≈ ${fmt(sec.tahmini_tutar)})` : ''}:</div>
                  <input type="number" autoFocus value={tutar} onChange={e => setTutar(e.target.value)} placeholder="Fatura tutarı ₺" />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className={mod !== 'vadeye' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMod('tam')}>Ödedim</button>
                    <button className={mod === 'vadeye' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMod('vadeye')}>Henüz ödemedim → vadeye yaz</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className={mod === 'tam' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => { setMod('tam'); setTutar(sec.tutar); }}>Tam · {fmt(sec.tutar)}</button>
                    <button className={mod === 'kismi' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => { setMod('kismi'); if (sec.tip === 'Kredi Kartı' && sec.asgari != null) setTutar(sec.asgari); }}>{sec.tip === 'Kredi Kartı' ? '✂ Asgari/Kısmi' : '✂ Kısmi'}{sec.asgari != null ? ` (asg ${fmt(sec.asgari)})` : ''}</button>
                  </div>
                  {mod === 'kismi' && (
                    <>
                      <input type="number" value={tutar} onChange={e => setTutar(e.target.value)} placeholder="Ödenecek tutar ₺" />
                      {sec.tip === 'Kredi Kartı' ? (
                        <div style={{ fontSize: 12, color: 'var(--text3)' }}>💳 Kalan tutar bir sonraki ekstreye devreder — kartın kesim döngüsü izler, vade seçmene gerek yok.</div>
                      ) : (
                        <>
                          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kalan borç için yeni vade:</div>
                          <input type="date" value={kalanVade} onChange={e => setKalanVade(e.target.value)} />
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {/* 💳 KART BORCU: kart kartla ödenmez, faturası da olmaz (sahip kuralı) —
                  yöntem seçici + fatura eki GİZLİ; ödeme kasadan (nakit/havale) çıkar */}
              {mod !== 'vadeye' && sec.tip === 'Kredi Kartı' && (
                <div style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8 }}>
                  💵 Kart borcu kasadan ödenir (nakit/havale){kokpit ? ` — kasada ${fmt(kokpit.kasa)}` : ''}.
                </div>
              )}
              {mod !== 'vadeye' && sec.tip !== 'Kredi Kartı' && (
                <>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[['nakit', '💵', 'Kasa', kokpit ? `kasada ${fmt(kokpit.kasa)}` : 'kasadan düşer'], ['kart', '💳', 'Kart', 'kart borcuna yazılır']].map(([k, ikon, ad, alt]) => (
                      <button key={k} onClick={() => setYontem(k)}
                        style={{ flex: 1, padding: '12px 8px', borderRadius: 10, cursor: 'pointer',
                                 border: `2px solid ${yontem === k ? 'var(--accent)' : 'var(--border)'}`,
                                 background: yontem === k ? 'var(--accent-dim, var(--bg2))' : 'var(--bg2)',
                                 color: 'var(--text, inherit)', textAlign: 'center' }}>
                        <div style={{ fontSize: 22 }}>{ikon}</div>
                        <div style={{ fontWeight: 800, fontSize: 14 }}>{ad}</div>
                        <div style={{ fontSize: 10, color: 'var(--text3)' }}>{alt}</div>
                      </button>
                    ))}
                  </div>
                  {yontem === 'kart' && (
                    <select value={kartId} onChange={e => setKartId(e.target.value)}>
                      <option value="">Kart seçin…</option>
                      {kartlar.map(k => <option key={k.kart_id || k.id} value={k.kart_id || k.id} disabled={k.uygun === false}>
                        {(k.banka || '')} {k.kart_adi}{k.oneri ? ' ⭐' : ''}{k.kalan_limit != null ? ` — kalan ${fmt(k.kalan_limit)}` : ''}{k.uygun === false ? ` (${k.uygun_degil_neden})` : ''}
                      </option>)}
                    </select>
                  )}
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>📎 Fatura ekle (opsiyonel — arşive/cariye düşer)</div>
                    <input type="file" accept="application/pdf,image/*" onChange={e => setDosya(e.target.files?.[0] || null)} />
                  </div>
                </>
              )}
              {erteleAcik && (
                <div className="alert-box yellow" style={{ display: 'block' }}>
                  <div style={{ marginBottom: 6 }}>⏭ Yeni vade tarihi seç:</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="date" value={erteleTarih} onChange={e => setErteleTarih(e.target.value)} />
                    <button className="btn btn-primary btn-sm" disabled={mesgul || !erteleTarih} onClick={erteleUygula}>Ertele</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setErteleAcik(false)}>Vazgeç</button>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer" style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <span>
                {!sec.tutar_girilmedi && !erteleAcik && <button className="btn btn-ghost btn-sm" onClick={erteleBaslat} disabled={mesgul}>⏭ Ertele</button>}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary" onClick={kapat}>Vazgeç</button>
                <button className="btn btn-primary" onClick={odemeYap} disabled={mesgul}>
                  {mesgul ? 'İşleniyor…' : (mod === 'vadeye' ? 'Vadeye Yaz' : 'Onayla ve Öde')}
                </button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
