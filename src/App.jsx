import { useState, useEffect, useRef } from 'react';
import { api } from './utils/api';
import { subscribeGlobalDataRefresh } from './utils/globalDataRefresh';
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
import OperasyonMerkezi from './pages/OperasyonMerkezi';
import TruthMotor from './pages/TruthMotor';
import EvoSatis from './pages/EvoSatis';
import TeslimKayit from './pages/TeslimKayit';
import KasaTeslim from './pages/KasaTeslim';
import EkstreYukle from './pages/EkstreYukle';
import KartYonetimi from './pages/KartYonetimi';
import IsBasvuruForm from './pages/IsBasvuruForm';
import IsBasvuruListesi from './pages/IsBasvuruListesi';
import Maliyet from './pages/Maliyet';
import EvTasarim from './pages/EvTasarim';
import FireFotoYukle from './pages/FireFotoYukle';
import './index.css';

const NAV = [
  { group: 'Yönetim & Karar', gicon: '📊', items: [
    { id: 'panel',            label: 'CFO Panel',           icon: '⬛' },
    { id: 'ops-merkez',       label: 'Operasyon Merkezi',   icon: '📡' },
    { id: 'akilli-denetim',   label: 'Akıllı Denetim',      icon: '🧠' },
    { id: 'maliyet',          label: 'Maliyet',             icon: '💰' },
    { id: 'strateji',         label: 'Strateji Motoru',     icon: '🎯' },
  ]},
  { group: 'Onay Bekleyenler', gicon: '✅', items: [
    { id: 'onay',             label: 'Onay Kuyruğu',        icon: '✅' },
    { id: 'ciro-taslak-onay', label: 'Ciro Onayı',          icon: '📋' },
  ]},
  { group: 'Para Hareketleri', gicon: '💰', items: [
    { id: 'ciro',             label: 'Ciro Girişi',         icon: '📈' },
    { id: 'evo-satis',        label: 'Ürün Satışları',      icon: '☕' },
    { id: 'kasa-teslim',      label: 'Kasa Teslim',         icon: '💵' },
    { id: 'anlik-gider',      label: 'Anlık Gider',         icon: '💸' },
    { id: 'dis-kaynak',       label: 'Dış Kaynak Geliri',   icon: '🪙' },
    { id: 'vadeli',           label: 'Vadeli Alım',         icon: '📦' },
  ]},
  { group: 'Kartlar', gicon: '💳', items: [
    { id: 'kart-yonetimi',    label: 'Kart Yönetimi',       icon: '💳' },
  ]},
  { group: 'İnsan Kaynakları', gicon: '💼', items: [
    { id: 'is-basvurusu',     label: 'İş Başvuruları',      icon: '💼' },
  ]},
  { group: 'Personel & Vardiya', gicon: '👥', items: [
    { id: 'personel',         label: 'Personel & Maaş',     icon: '👥' },
    { id: 'vardiya-planlamasi',label: 'Vardiya Planlaması', icon: '🗓️' },
    { id: 'sube-panel-pin',   label: 'Personel Panel PIN',  icon: '🔐' },
    { id: 'gorev-qr',         label: 'Görev QR Kodları',    icon: '📱' },
    { id: 'gorev-ozet',          label: 'Görev Takibi',        icon: '✅' },
    { id: 'stok-sayim',          label: 'Stok Sayım',          icon: '📋' },
    { id: 'personel-vardiya-takip', label: 'Vardiya Takip',    icon: '⏱️' },
  ]},
  { group: 'Tanımlar', gicon: '🗂️', items: [
    { id: 'sabit-giderler',   label: 'Sabit Giderler',      icon: '🏠' },
    { id: 'borclar',          label: 'Borç Envanteri',      icon: '🏦' },
    { id: 'tedarikciler',     label: 'Tedarikçiler',        icon: '🚚' },
    { id: 'tedarik-dosyasi',  label: 'Tedarik Dosyası',     icon: '🧾' },
  ]},
  { group: 'Rapor & Defter', gicon: '📒', items: [
    { id: 'rapor',            label: 'Aylık Rapor',         icon: '📈' },
    { id: 'ledger',           label: 'İşlem Defteri',       icon: '📒' },
  ]},
  { group: 'Veri & Sistem', gicon: '🔧', items: [
    { id: 'excel',            label: 'Excel Import',        icon: '📊' },
    { id: 'teslim-kayit',     label: 'Bilgi Teslim',        icon: '📨' },
    { id: 'veri-temizle',     label: 'Veri Temizle',        icon: '🧹' },
  ]},
  { group: 'Kişisel', gicon: '🏠', items: [
    { id: 'ev-tasarim',       label: 'İşletme/Dükkan Tasarımı', icon: '🏠' },
  ]},
];

const PAGES = {
  panel:              Panel,
  'ops-merkez':       OperasyonMerkezi,
  'akilli-denetim':   TruthMotor,
  maliyet:            Maliyet,
  'evo-satis':        EvoSatis,
  'kasa-teslim':      KasaTeslim,
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
  'is-basvurusu':     IsBasvuruListesi,
  'ev-tasarim':       EvTasarim,
};

function readPageFromHash() {
  try {
    const raw = (window.location.hash || '').replace(/^#/, '').split('&')[0];
    const h = decodeURIComponent(raw).trim();
    if (h === 'sevkiyat-hazirlama') {
      try {
        sessionStorage.setItem('ops_merkez_ac_sekme', 'siparis-kontrol');
        sessionStorage.setItem('ops_kontrol_kulesi_gorunum', 'depo');
        const sid = sessionStorage.getItem('ops_sevkiyat_hazirlama_sube_id');
        if (sid) {
          sessionStorage.setItem('ops_kontrol_kulesi_depo', sid);
          sessionStorage.removeItem('ops_sevkiyat_hazirlama_sube_id');
        }
      } catch (_) {}
      return 'ops-merkez';
    }
    if (h && Object.prototype.hasOwnProperty.call(PAGES, h)) return h;
  } catch (_) {}
  return null;
}

function syncHashForPage(pageId) {
  try {
    const path = window.location.pathname || '/admin';
    if (!pageId || pageId === 'panel') {
      window.history.replaceState(null, '', path);
    } else {
      window.history.replaceState(null, '', `${path}#${encodeURIComponent(pageId)}`);
    }
  } catch (_) {}
}

// ── Admin Şifre Kapısı ───────────────────────────────────────────────────────
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
      background: 'var(--bg1, #0f1117)', fontFamily: 'Instrument Sans, sans-serif',
    }}>
      <form onSubmit={girisYap} style={{
        width: 320, padding: 28, borderRadius: 14,
        background: 'var(--bg2, #1a1d24)', border: '1px solid var(--border, #2a2d35)',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text1, #e8e9ec)', marginBottom: 4 }}>
          EVVEL ERP
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
        {hata && (
          <div style={{ fontSize: 12, color: '#e05c5c', marginBottom: 12 }}>{hata}</div>
        )}
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

export default function App() {
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

  const [page, setPage] = useState(() => readPageFromHash() ?? 'panel');
  const mainRef = useRef(null);
  const Page = PAGES[page] || Panel;
  const [onayBekleyen, setOnayBekleyen] = useState(0);
  const [ciroBekleyen, setCiroBekleyen] = useState(0);
  const [bugunAnomali, setBugunAnomali] = useState(0);
  const [yeniBasvuru, setYeniBasvuru] = useState(0);
  const [stokSayimBekleyen, setStokSayimBekleyen] = useState(0);
  // Sayfa her açıldığında (yenileme/yeniden giriş) şifre yeniden istensin —
  // kalıcı oturum tutulmuyor (localStorage kullanılmıyor).
  const [girisYapildi, setGirisYapildi] = useState(false);

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
      const bugun = new Date().toISOString().slice(0, 10);
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
    };
    yukle();
    const timer = setInterval(yukle, 60000);
    const unsub = subscribeGlobalDataRefresh(yukle);
    return () => { clearInterval(timer); unsub(); };
  }, [girisYapildi]);

  const navigate = (id) => {
    const p = Object.prototype.hasOwnProperty.call(PAGES, id) ? id : 'panel';
    setPage(p);
    syncHashForPage(p);
  };

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [page]);

  useEffect(() => {
    const onHash = () => {
      const p = readPageFromHash();
      setPage(p ?? 'panel');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!girisYapildi) {
    return <AdminGirisKapisi onBasarili={() => setGirisYapildi(true)} />;
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
              <div className="nav-label">{g.gicon && <span className="gico">{g.gicon}</span>}{g.group}</div>
              {g.items.map(item => (
                <div
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)}
                  style={{ position: 'relative' }}
                >
                  <span className="icon">{item.icon}</span>
                  {item.label}
                  {item.id === 'onay' && onayBekleyen > 0 && (
                    <span style={{
                      position: 'absolute', top: '50%', right: 10,
                      transform: 'translateY(-50%)',
                      minWidth: 18, height: 18, padding: '0 5px',
                      borderRadius: 999, background: '#22c55e', color: '#fff',
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
                      borderRadius: 999, background: '#22c55e', color: '#fff',
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
                      borderRadius: 999, background: '#22c55e', color: '#fff',
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
                      borderRadius: 999, background: '#ef4444', color: '#fff',
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
                      borderRadius: 999, background: '#22c55e', color: '#fff',
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
            onClick={() => setGirisYapildi(false)}
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
        {page !== 'panel' && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 40,
            background: 'var(--bg1)',
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
        <Page onNavigate={navigate} />
      </main>
    </div>
  );
}
