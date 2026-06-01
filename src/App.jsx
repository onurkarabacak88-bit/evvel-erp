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
import Tedarikciler from './pages/Tedarikciler';
import VeriTemizle from './pages/VeriTemizle.jsx';
import OperasyonMerkezi from './pages/OperasyonMerkezi';
import TruthMotor from './pages/TruthMotor';
import EvoSatis from './pages/EvoSatis';
import TeslimKayit from './pages/TeslimKayit';
import KasaTeslim from './pages/KasaTeslim';
import EkstreYukle from './pages/EkstreYukle';
import KartYonetimi from './pages/KartYonetimi';
import './index.css';

const NAV = [
  { group: 'Yönetim & Karar', gicon: '📊', items: [
    { id: 'panel',            label: 'CFO Panel',           icon: '⬛' },
    { id: 'ops-merkez',       label: 'Operasyon Merkezi',   icon: '📡' },
    { id: 'akilli-denetim',   label: 'Akıllı Denetim',      icon: '🧠' },
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
  { group: 'Personel & Vardiya', gicon: '👥', items: [
    { id: 'personel',         label: 'Personel & Maaş',     icon: '👥' },
    { id: 'vardiya-planlamasi',label: 'Vardiya Planlaması', icon: '🗓️' },
    { id: 'sube-panel-pin',   label: 'Personel Panel PIN',  icon: '🔐' },
  ]},
  { group: 'Tanımlar', gicon: '🗂️', items: [
    { id: 'sabit-giderler',   label: 'Sabit Giderler',      icon: '🏠' },
    { id: 'borclar',          label: 'Borç Envanteri',      icon: '🏦' },
    { id: 'tedarikciler',     label: 'Tedarikçiler',        icon: '🚚' },
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
];

const PAGES = {
  panel:              Panel,
  'ops-merkez':       OperasyonMerkezi,
  'akilli-denetim':   TruthMotor,
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
  tedarikciler:       Tedarikciler,
  'veri-temizle':     VeriTemizle,
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

export default function App() {
  const [page, setPage] = useState(() => readPageFromHash() ?? 'panel');
  const mainRef = useRef(null);
  const Page = PAGES[page] || Panel;
  const [onayBekleyen, setOnayBekleyen] = useState(0);
  const [bugunAnomali, setBugunAnomali] = useState(0);

  useEffect(() => {
    const yukle = () => {
      api('/onay-kuyrugu?durum=bekliyor&limit=400')
        .then(d => setOnayBekleyen(Array.isArray(d) ? d.length : 0))
        .catch(() => {});
      // Akıllı Denetim bugün anomali sayısı
      const bugun = new Date().toISOString().slice(0, 10);
      api(`/ops/truth/gunluk-rapor?tarih=${bugun}`)
        .then(d => {
          const top = (d?.subeler || []).reduce((s, r) => s + (Number(r.anomali_sayisi) || 0), 0);
          setBugunAnomali(top);
        })
        .catch(() => {});
    };
    yukle();
    const timer = setInterval(yukle, 60000);
    const unsub = subscribeGlobalDataRefresh(yukle);
    return () => { clearInterval(timer); unsub(); };
  }, []);

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
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">EVVEL v2.4 · 27.03.2026</div>
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
