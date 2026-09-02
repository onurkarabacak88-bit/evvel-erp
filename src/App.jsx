import { useState, useEffect, useRef } from 'react';
import { bugunTR } from './utils/trTarih';
import { api } from './utils/api';
import { resolvePageAlias } from './utils/sayfaTakmaAd';
import { subscribeGlobalDataRefresh } from './utils/globalDataRefresh';
import BeyinChat from './components/BeyinChat';
import Ikon from './components/Ikon';
import Panel from './pages/Panel';
import Kartlar from './pages/Kartlar';
import KartHareketleri from './pages/KartHareketleri';
import Personel from './pages/Personel';
import Borclar from './pages/Borclar';
import SabitGiderler from './pages/SabitGiderler';
import AnlikGider from './pages/AnlikGider';
import VadeliAlimlar from './pages/VadeliAlimlar';
import OnayKuyrugu from './pages/OnayKuyrugu';
import CiroTaslakOnay from './pages/CiroTaslakOnay';
import Ciro from './pages/Ciro';
import Strateji from './pages/Strateji';
import Ledger from './pages/Ledger';
import ExcelImport from './pages/ExcelImport';
import DisKaynak from './pages/DisKaynak';
import Rapor from './pages/Rapor';
import KartMerkez from './pages/KartMerkez';
import KartEkstreAnaliz from './pages/KartEkstreAnaliz';
import VardiyaPlanlamaV2 from './pages/VardiyaPlanlamaV2';
import SubePanelPinleri from './pages/SubePanelPinleri';
import GorevQR from './pages/GorevQR';
import GorevGiris from './pages/GorevGiris';
import GorevOzet from './pages/GorevOzet';
import PersonelVardiyaTakip from './pages/PersonelVardiyaTakip';
import Tedarikciler from './pages/Tedarikciler';
import TedarikDosyasi from './pages/TedarikDosyasi';
import StokSayim from './pages/StokSayim';
import VeriTemizle from './pages/VeriTemizle.jsx';
import CiroKurtarma from './pages/CiroKurtarma.jsx';
import MerkezTemizlik from './pages/MerkezTemizlik.jsx';
import OperasyonMerkezi from './pages/OperasyonMerkezi';
import TruthMotor from './pages/TruthMotor';
import EvoSatis from './pages/EvoSatis';
import TeslimKayit from './pages/TeslimKayit';
import KasaTeslim from './pages/KasaTeslim';
import EkstreYukle from './pages/EkstreYukle';
import KartYonetimi from './pages/KartYonetimi';
import BorcNavigasyon from './pages/BorcNavigasyon';
import TvMenuYonetim from './pages/TvMenuYonetim';
import IsBasvuruForm from './pages/IsBasvuruForm';
import IsBasvuruListesi from './pages/IsBasvuruListesi';
import Maliyet from './pages/Maliyet';
import EvTasarim from './pages/EvTasarim';
import FireFotoYukle from './pages/FireFotoYukle';
import CepApp from './pages/cep/CepApp';
import DuyuPaneli from './pages/DuyuPaneli';
import ReceteEslestirme from './pages/ReceteEslestirme';
import BelgeMerkezi from './pages/BelgeMerkezi';
import OdemeMerkezi from './pages/OdemeMerkezi';
import TasarimV2 from './pages/v2/TasarimV2';
import './index.css';

// Marka kimliği 2. tur (2026-07-18): kabuk ikonları emoji değil SVG (Ikon.jsx,
// tek outline ailesi) — icon/gicon alanları artık Ikon adı taşır.
const NAV = [
  { group: 'Yönetim & Karar', gicon: 'gosterge', items: [
    { id: 'panel',            label: 'CFO Panel',           icon: 'gosterge' },
    { id: 'tasarim-v2',       label: 'Kadife Tasarım · varsayılan', icon: 'gosterge' },
    { id: 'ops-merkez',       label: 'Operasyon Merkezi',   icon: 'radar' },
    { id: 'akilli-denetim',   label: 'Akıllı Denetim',      icon: 'islemci' },
    { id: 'duyu-paneli',      label: 'Duyu Paneli',         icon: 'goz' },
    { id: 'recete-eslestirme', label: 'Reçete Eşleştirme',  icon: 'bag' },
    { id: 'maliyet',          label: 'Kâr & Maliyet',       icon: 'para' },
    { id: 'odeme-merkezi',    label: 'Ödeme Merkezi',       icon: 'banknot' },
    { id: 'belge-merkezi',    label: 'Tedarikçi Kontrol',   icon: 'dukkan' },
    { id: 'borc-navigasyon',  label: 'Borç Navigasyonu',    icon: 'pusula' },
    { id: 'strateji',         label: 'Strateji Motoru',     icon: 'hedef' },
  ]},
  { group: 'Onay Bekleyenler', gicon: 'onay', items: [
    { id: 'onay',             label: 'Onay Kuyruğu',        icon: 'onay' },
    { id: 'ciro-taslak-onay', label: 'Ciro Onayı',          icon: 'pano-onay' },
  ]},
  { group: 'Para Hareketleri', gicon: 'para', items: [
    { id: 'ciro',             label: 'Ciro Girişi',         icon: 'trend' },
    { id: 'evo-satis',        label: 'Ürün Satışları',      icon: 'kahve' },
    { id: 'kasa-teslim',      label: 'Kasa Teslim',         icon: 'cuzdan' },
    { id: 'anlik-gider',      label: 'Anlık Gider',         icon: 'fis' },
    { id: 'dis-kaynak',       label: 'Dış Kaynak Geliri',   icon: 'arti-para' },
    // 'vadeli' (Vadeli Alım) FAZ C'de menüden çekildi — salt-okunur arşive döndü;
    // route PAGES'te durur (eski #vadeli linkleri kırılmaz), giriş/ödeme Ödeme Merkezi'nde
  ]},
  { group: 'Kartlar', gicon: 'kart', items: [
    { id: 'kart-yonetimi',    label: 'Kart Yönetimi',       icon: 'kart' },
  ]},
  { group: 'İnsan Kaynakları', gicon: 'canta', items: [
    { id: 'is-basvurusu',     label: 'İş Başvuruları',      icon: 'canta' },
  ]},
  { group: 'Personel & Vardiya', gicon: 'ekip', items: [
    { id: 'personel',         label: 'Personel & Maaş',     icon: 'ekip' },
    { id: 'vardiya-planlamasi',label: 'Vardiya Planlaması', icon: 'takvim' },
    { id: 'sube-panel-pin',   label: 'Personel Panel PIN',  icon: 'kilit' },
    { id: 'gorev-qr',         label: 'Görev QR Kodları',    icon: 'qr' },
    { id: 'gorev-ozet',          label: 'Görev Takibi',        icon: 'onay-kare' },
    { id: 'stok-sayim',          label: 'Stok Sayım',          icon: 'pano-liste' },
    { id: 'personel-vardiya-takip', label: 'Vardiya Takip',    icon: 'saat' },
  ]},
  { group: 'Tanımlar', gicon: 'klasor', items: [
    { id: 'sabit-giderler',   label: 'Sabit Giderler',      icon: 'ev' },
    { id: 'borclar',          label: 'Borç Envanteri',      icon: 'banka' },
    { id: 'tedarikciler',     label: 'Tedarikçiler',        icon: 'kamyon' },
    { id: 'tedarik-dosyasi',  label: 'Tedarik Dosyası',     icon: 'dosya' },
    { id: 'tv-menu',          label: 'TV Menü',             icon: 'tv' },
  ]},
  { group: 'Rapor & Defter', gicon: 'defter', items: [
    { id: 'rapor',            label: 'Aylık Rapor',         icon: 'grafik' },
    { id: 'ledger',           label: 'İşlem Defteri',       icon: 'defter' },
  ]},
  { group: 'Veri & Sistem', gicon: 'anahtar', items: [
    { id: 'excel',            label: 'Excel Import',        icon: 'tablo' },
    { id: 'teslim-kayit',     label: 'Bilgi Teslim',        icon: 'gelen-kutusu' },
    { id: 'veri-temizle',     label: 'Veri Temizle',        icon: 'silgi' },
    { id: 'merkez-temizlik',  label: 'Merkez Sipariş Temizliği', icon: 'cop' },
  ]},
  { group: 'Kişisel', gicon: 'ev', items: [
    { id: 'ev-tasarim',       label: 'İşletme/Dükkan Tasarımı', icon: 'cetvel' },
  ]},
];

const PAGES = {
  panel:              Panel,
  'tasarim-v2':       TasarimV2,
  'ops-merkez':       OperasyonMerkezi,
  'akilli-denetim':   TruthMotor,
  maliyet:            Maliyet,
  'evo-satis':        EvoSatis,
  'kasa-teslim':      KasaTeslim,
  'duyu-paneli':      DuyuPaneli,
  'recete-eslestirme': ReceteEslestirme,
  'belge-merkezi':    BelgeMerkezi,
  'odeme-merkezi':    OdemeMerkezi,
  strateji:           Strateji,
  onay:               OnayKuyrugu,
  'ciro-taslak-onay': CiroTaslakOnay,
  ledger:             Ledger,
  ciro:               Ciro,
  'kart-hareketleri': KartHareketleri,
  'anlik-gider':      AnlikGider,
  rapor:              Rapor,
  'kart-merkez':      KartMerkez,
  'dis-kaynak':       DisKaynak,
  vadeli:             VadeliAlimlar,
  excel:              ExcelImport,
  'teslim-kayit':     TeslimKayit,
  kartlar:            Kartlar,
  'kart-analiz':      KartEkstreAnaliz,
  'ekstre-yukle':     EkstreYukle,
  'kart-yonetimi':    KartYonetimi,
  'borc-navigasyon':  BorcNavigasyon,
  'tv-menu':          TvMenuYonetim,
  personel:           Personel,
  borclar:            Borclar,
  'sabit-giderler':   SabitGiderler,
  'vardiya-planlamasi': VardiyaPlanlamaV2,
  'sube-panel-pin':   SubePanelPinleri,
  'gorev-qr':         GorevQR,
  'gorev-ozet':              GorevOzet,
  'personel-vardiya-takip':  PersonelVardiyaTakip,
  tedarikciler:       Tedarikciler,
  'tedarik-dosyasi':  TedarikDosyasi,
  'stok-sayim':       StokSayim,
  'veri-temizle':     VeriTemizle,
  // 🚑 Acil kurtarma ekrani — #klasik:ciro-kurtarma ile acilir.
  'ciro-kurtarma':    CiroKurtarma,
  'merkez-temizlik':  MerkezTemizlik,
  'is-basvurusu':     IsBasvuruListesi,
  'ev-tasarim':       EvTasarim,
};

// ── KLASİK TASARIM GÖRÜNMEZ (sahip kararı 2026-07-30) ────────────────────────
// "Silme yerine tamamen görünmez yap — sadece yeni olanı göreyim."
// Klasik ekranların HİÇBİRİ silinmedi: PAGES sözlüğü, sayfa dosyaları ve NAV
// listesi dosyada duruyor. Ama artık hiçbir yol oraya çıkmıyor:
//   · v2'de klasiğe giden köprü kalmadı (son 4'ü de yerli oldu)
//   · düz '#panel' gibi eski hash'ler de artık v2 açar
//   · klasik kabuk YALNIZ '#klasik:<sayfa>' yazılırsa açılır (acil kurtarma)
// Bu kapı bilinçlidir: bir v2 ekranı bozulursa iş durmasın diye eski ekran
// hâlâ ayakta — ama kimse kazara oraya düşmez.
const KLASIK_ONEK = 'klasik:';

function readPageFromHash() {
  try {
    const raw = (window.location.hash || '').replace(/^#/, '').split('&')[0];
    const h = decodeURIComponent(raw).trim();
    if (!h.startsWith(KLASIK_ONEK)) return null;   // klasik görünmez: her şey v2
    const g = h.slice(KLASIK_ONEK.length).trim();
    const cozulmus = resolvePageAlias(g);
    if (cozulmus !== g) return cozulmus;
    if (g && Object.prototype.hasOwnProperty.call(PAGES, g)) return g;
  } catch (_) {}
  return null;
}

function syncHashForPage(pageId) {
  try {
    const path = window.location.pathname || '/admin';
    // Kalıcı geçiş: hash'siz kök adres = v2 (varsayılan). Klasik ekran açıksa
    // hash 'klasik:' önekiyle yazılır — yenilemede aynı yere döner, ama o
    // adres paylaşılmadıkça kimse klasiğe düşmez.
    if (!pageId || pageId === 'tasarim-v2') {
      window.history.replaceState(null, '', path);
    } else {
      window.history.replaceState(null, '', `${path}#${KLASIK_ONEK}${encodeURIComponent(pageId)}`);
    }
  } catch (_) {}
}

// ── Admin Şifre Kapısı ───────────────────────────────────────────────────────
// Oturum, sunucunun imzaladığı süreli jetonla taşınır (main.py /api/admin-giris).
// Şifre değişirse imza tutmaz ve saklanan jeton kendiliğinden düşer.
const OTURUM_ANAHTAR = 'evvel_oturum';

function AdminGirisKapisi({ onBasarili }) {
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);

  const girisYap = async (e) => {
    e.preventDefault();
    setHata('');
    setYukleniyor(true);
    try {
      const res = await api('/admin-giris', { method: 'POST', body: { sifre } });
      if (res?.ok) {
        // Sunucunun imzaladığı süreli jeton — F5'te yeniden şifre sorulmasın.
        if (res.jeton) { try { localStorage.setItem(OTURUM_ANAHTAR, res.jeton); } catch (_) {} }
        onBasarili();
      }
    } catch (e2) {
      setHata(e2.message || 'Şifre yanlış');
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', fontFamily: "'Instrument Sans', sans-serif",
    }}>
      <form onSubmit={girisYap} style={{
        width: 320, padding: 32, borderRadius: 14,
        background: 'var(--bg2)', border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-2)', textAlign: 'center',
      }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          EVVEL<span style={{ color: 'var(--accent)' }}>.</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 24 }}>
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
            border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text)', fontSize: 14, boxSizing: 'border-box',
          }}
        />
        {hata && (
          <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{hata}</div>
        )}
        <button type="submit" disabled={yukleniyor || !sifre} className="btn btn-primary" style={{
          width: '100%', padding: '12px', fontSize: 14,
          opacity: yukleniyor || !sifre ? 0.6 : 1,
        }}>
          {yukleniyor ? '…' : 'Giriş Yap'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  // EVVEL · CEP — işletme sahibi mobil kabuğu (sidebar yok, ayrı kabuk)
  if (window.location.pathname === '/cep' || window.location.pathname.startsWith('/cep/')) {
    return <CepApp />;
  }

  // İş başvurusu — mobil form, sidebar yok
  if (window.location.pathname === '/is-basvurusu') {
    return <IsBasvuruForm />;
  }

  // QR giriş sayfası — sidebar olmadan tam ekran
  const gorevGirisMatch = window.location.pathname.match(/^\/gorev-giris\/(.+)$/);
  if (gorevGirisMatch) {
    return <GorevGiris subeId={gorevGirisMatch[1]} />;
  }
  // QR'sız direkt giriş — şube seçimli
  if (window.location.pathname === '/gorev-pin') {
    return <GorevGiris subeId={null} />;
  }

  // Fire/iade kanıt fotoğrafı — personel telefonundan QR ile açılır
  const fireFotoMatch = window.location.pathname.match(/^\/fire-foto\/(.+)$/);
  if (fireFotoMatch) {
    const params = new URLSearchParams(window.location.search);
    return <FireFotoYukle bildirimId={fireFotoMatch[1]} token={params.get('t') || ''} />;
  }

  // KALICI GEÇİŞ (sahip kararı 2026-07-29): varsayılan giriş = kadife koyu v2.
  // Klasik ekranlara v2 üst çubuğundaki "Klasik görünüm" ile ya da #panel
  // hash'iyle gidilir; hash'siz kök adres her zaman v2 açar.
  const [page, setPage] = useState(() => readPageFromHash() ?? 'tasarim-v2');
  const mainRef = useRef(null);
  const Page = PAGES[page] || Panel;
  const [onayBekleyen, setOnayBekleyen] = useState(0);
  // 📦 Teslim bildirimleri (sahip 2026-07-18): personel teslim alınca görünür
  // bilgi notu; 'Tamam' kalıcıdır (sunucuda görüldü defteri) — bir daha çıkmaz
  const [teslimler, setTeslimler] = useState([]);
  const teslimYukle = () => api('/teslim-bildirim/liste?gun=7')
    .then(d => setTeslimler(d?.olaylar || [])).catch(() => setTeslimler([]));
  async function teslimGordum(anahtar) {
    try {
      await api('/teslim-bildirim/gordum', { method: 'POST', body: { anahtar } });
      setTeslimler(t => t.filter(o => o.anahtar !== anahtar));
    } catch (_) { /* bildirim çökse akış yaşar */ }
  }
  const [ciroBekleyen, setCiroBekleyen] = useState(0);
  const [bugunAnomali, setBugunAnomali] = useState(0);
  const [yeniBasvuru, setYeniBasvuru] = useState(0);
  const [stokSayimBekleyen, setStokSayimBekleyen] = useState(0);
  // OTURUM (2026-08-10, sahip: "her sayfa yenilemede şifre soruyor").
  // Eskiden kalıcı oturum YOKTU → her F5 yeniden giriş demekti. Artık sunucunun
  // imzaladığı jeton saklanır ve açılışta DOĞRULATILIR (körlemesine güvenilmez).
  const [girisYapildi, setGirisYapildi] = useState(false);
  const [oturumSoruluyor, setOturumSoruluyor] = useState(true);

  useEffect(() => {
    let jeton = null;
    try { jeton = localStorage.getItem(OTURUM_ANAHTAR); } catch (_) {}
    if (!jeton) { setOturumSoruluyor(false); return; }
    api(`/admin-oturum?jeton=${encodeURIComponent(jeton)}`)
      .then((d) => {
        if (d?.gecerli) setGirisYapildi(true);
        else { try { localStorage.removeItem(OTURUM_ANAHTAR); } catch (_) {} }
      })
      .catch(() => { /* ağ hatasında kapıyı aç bırakma — şifre sorulur */ })
      .finally(() => setOturumSoruluyor(false));
  }, []);

  useEffect(() => {
    if (!girisYapildi) return;
    const yukle = () => {
      api('/onay-kuyrugu?durum=bekliyor&limit=400')
        .then(d => setOnayBekleyen(Array.isArray(d) ? d.length : 0))
        .catch(() => {});
      // Bekleyen ciro onayı (ciro taslakları) — menüde sayı rozeti için
      api('/ciro-taslak?durum=bekliyor')
        .then(d => setCiroBekleyen(Array.isArray(d) ? d.length : 0))
        .catch(() => {});
      // Akıllı Denetim bugün anomali sayısı
      const bugun = bugunTR();
      api(`/ops/truth/gunluk-rapor?tarih=${bugun}`)
        .then(d => {
          const top = (d?.subeler || []).reduce((s, r) => s + (Number(r.anomali_sayisi) || 0), 0);
          setBugunAnomali(top);
        })
        .catch(() => {});
      // Yeni iş başvurusu sayısı
      api('/is-basvurusu/ozet')
        .then(d => setYeniBasvuru(Number(d?.yeni) || 0))
        .catch(() => {});
      // Stok sayım: onay bekleyen sayısı (menü rozeti)
      api('/stok-sayim/bekleyen-onay')
        .then(d => setStokSayimBekleyen(Number(d?.toplam) || 0))
        .catch(() => {});
      teslimYukle();
    };
    yukle();
    const timer = setInterval(yukle, 60000);
    const unsub = subscribeGlobalDataRefresh(yukle);
    return () => { clearInterval(timer); unsub(); };
  }, [girisYapildi]);

  const navigate = (id) => {
    const cozulmus = resolvePageAlias(id);
    const p = Object.prototype.hasOwnProperty.call(PAGES, cozulmus) ? cozulmus : 'panel';
    setPage(p);
    syncHashForPage(p);
  };

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [page]);

  useEffect(() => {
    const onHash = () => {
      const p = readPageFromHash();
      setPage(p ?? 'tasarim-v2');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (oturumSoruluyor) {
    // Saklanan jeton doğrulanırken şifre ekranını GÖSTERME — aksi halde her
    // açılışta bir an "şifre girin" parlar ve oturum kopmuş gibi görünür.
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)', color: 'var(--text3)', fontSize: 13,
        fontFamily: "'Instrument Sans', sans-serif",
      }}>EVVEL<span style={{ color: 'var(--accent)' }}>.</span></div>
    );
  }

  if (!girisYapildi) {
    return <AdminGirisKapisi onBasarili={() => setGirisYapildi(true)} />;
  }

  // 🎨 Kadife koyu kabuk (Cloud Design v2 pilotu) — kendi ikon rayı + görünüm
  // sütunu var, klasik sidebar'ı kullanmaz. Şifre kapısının ARKASINDA durur.
  if (page === 'tasarim-v2') {
    return <TasarimV2 onGit={navigate} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>EVVEL ERP</h1>
          <span>V2 · CFO Panel</span>
        </div>
        <nav className="sidebar-nav">
          {NAV.map(g => (
            <div key={g.group} className="nav-group">
              <div className="nav-label">{g.gicon && <span className="gico"><Ikon ad={g.gicon} boyut={12} kalinlik={2} /></span>}{g.group}</div>
              {g.items.map(item => (
                <div
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)}
                  style={{ position: 'relative' }}
                >
                  <span className="icon"><Ikon ad={item.icon} boyut={16} /></span>
                  {item.label}
                  {item.id === 'onay' && onayBekleyen > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: 'var(--green)', color: '#fff',
                      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                    }}>
                      {onayBekleyen}
                    </span>
                  )}
                  {item.id === 'ciro-taslak-onay' && ciroBekleyen > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: 'var(--green)', color: '#fff',
                      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                    }} title="Bekleyen ciro onayı">
                      {ciroBekleyen}
                    </span>
                  )}
                  {item.id === 'is-basvurusu' && yeniBasvuru > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: 'var(--green)', color: '#fff',
                      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                    }} title="Yeni başvuru">
                      {yeniBasvuru}
                    </span>
                  )}
                  {item.id === 'akilli-denetim' && bugunAnomali > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: 'var(--red)', color: '#fff',
                      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                    }} title="Bugün anomali sayısı">
                      {bugunAnomali}
                    </span>
                  )}
                  {item.id === 'stok-sayim' && stokSayimBekleyen > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: 'var(--green)', color: '#fff',
                      fontSize: 11, fontWeight: 800, lineHeight: '18px', textAlign: 'center',
                    }} title="Onay bekleyen sayım">
                      {stokSayimBekleyen}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>EVVEL v2.4 · 27.03.2026</span>
          <button
            onClick={() => {
              // Saklanan jeton da silinmeli — yoksa "Çıkış"tan sonra sayfa
              // yenilenince oturum geri gelir ve düğme yalan söylemiş olur.
              try { localStorage.removeItem(OTURUM_ANAHTAR); } catch (_) {}
              setGirisYapildi(false);
            }}
            title="Çıkış"
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text3)', padding: '3px 8px', cursor: 'pointer', fontSize: 11,
            }}
          >
            Çıkış
          </button>
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        {/* Emeklilik şeridi: buraya ancak '#klasik:' yazarak gelinir. Ekran
            silinmedi ama artık ürünün parçası değil — dönüş kapısı hep açık. */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 41,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '8px 20px', fontSize: 12,
          background: 'var(--accent-dim, rgba(200,149,106,.12))',
          borderBottom: '1px solid var(--accent-border, rgba(200,149,106,.3))',
        }}>
          <span>
            <b>Emekli tasarım.</b> Bu ekran arşivde duruyor; günlük işin tamamı kadife tasarımda.
          </span>
          <button
            onClick={() => navigate('tasarim-v2')}
            style={{
              marginLeft: 'auto', padding: '5px 14px', borderRadius: 7, cursor: 'pointer',
              background: 'var(--accent)', border: 'none', color: '#1C1309',
              fontSize: 12, fontWeight: 700,
            }}
          >
            ← Kadife tasarıma dön
          </button>
        </div>
        {page !== 'panel' && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 40,
            background: 'var(--glass, rgba(246,240,228,.82))',
            backdropFilter: 'blur(14px) saturate(1.15)',
            WebkitBackdropFilter: 'blur(14px) saturate(1.15)',
            borderBottom: '1px solid var(--border)',
            padding: '6px 20px',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <button
              onClick={() => navigate('panel')}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 12px', borderRadius: 6,
                background: 'var(--bg2)', border: '1px solid var(--border)',
                color: 'var(--text2)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--bg2)'}
            >
              ← CFO Paneli
            </button>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>
              {NAV.flatMap(g => g.items).find(i => i.id === page)?.label || page}
            </span>
          </div>
        )}
        {/* 📦 Görülmemiş teslim bildirimleri — 'Tamam' kalıcı, bir daha çıkmaz */}
        {teslimler.length > 0 && (
          <div style={{ margin: '12px 24px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {teslimler.slice(0, 4).map(o => (
              <div key={o.anahtar} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                padding: '9px 14px', borderRadius: 10, fontSize: 13,
                background: 'var(--accent-dim)', border: '1px solid var(--accent-border)',
              }}>
                <span>
                  📦 <b>{o.sube_ad}</b> · {String(o.zaman).replace('T', ' ')} — {o.tur}:{' '}
                  <b>{o.kalem_adet} kalem / {Math.round(o.toplam_miktar)} adet</b> depoya işlendi
                  {' '}<span style={{ color: 'var(--text3)' }}>· detay: Operasyon Merkezi → Stok Hareketi</span>
                </span>
                <button className="btn btn-sm btn-primary" onClick={() => teslimGordum(o.anahtar)}>Tamam</button>
              </div>
            ))}
            {teslimler.length > 4 && (
              <div style={{ fontSize: 11, color: 'var(--text3)', paddingLeft: 4 }}>+ {teslimler.length - 4} teslim daha…</div>
            )}
          </div>
        )}
        {/* Sayfa geçiş koreografisi — key=page: her sekme değişiminde içerik
            yumuşak yükselerek girer (CSS .sayfa-gecis, reduced-motion saygılı) */}
        <div key={page} className="sayfa-gecis">
          <Page onNavigate={navigate} />
        </div>
      </main>
      {/* 🧠 Beyin sohbeti — her sayfada sağ altta; sayfa gezinirken sohbet kaybolmaz */}
      <BeyinChat />
    </div>
  );
}
