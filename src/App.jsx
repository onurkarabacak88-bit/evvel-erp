import { useState, useEffect, useRef } from 'react';
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
import Subeler from './pages/Subeler';
import SubePanelPinleri from './pages/SubePanelPinleri';
import Tedarikciler from './pages/Tedarikciler';
import OperasyonMerkezi from './pages/OperasyonMerkezi';
import TeslimKayit from './pages/TeslimKayit';
import SevkiyatHazirlama from './pages/SevkiyatHazirlama';
import KasaTeslim from './pages/KasaTeslim';
import './index.css';

const NAV = [
  { group: 'Ana', items: [
    { id: 'panel',            label: 'CFO Panel',           icon: '⬛' },
    { id: 'ops-merkez',       label: 'Operasyon Merkezi',   icon: '📡' },
    { id: 'kasa-teslim',      label: 'Kasa Teslim',         icon: '💰' },
    { id: 'rapor',            label: 'Aylık Rapor',         icon: '📊' },
    { id: 'strateji',         label: 'Strateji Motoru',     icon: '🧠' },
    { id: 'onay',             label: 'Onay Kuyruğu',        icon: '✅' },
    { id: 'ciro-taslak-onay', label: 'Ciro Onayı',          icon: '📋' },
    { id: 'ledger',           label: 'İşlem Defteri',       icon: '📒' },
  ]},
  { group: 'Veri Girişi', items: [
    { id: 'ciro',             label: 'Ciro Girişi',         icon: '📈' },
    { id: 'kart-hareketleri', label: 'Kart Hareketi',       icon: '💳' },
    { id: 'anlik-gider',      label: 'Anlık Gider',         icon: '💸' },
    { id: 'dis-kaynak',       label: 'Dış Kaynak Geliri',   icon: '💰' },
    { id: 'vadeli',           label: 'Vadeli Alım',         icon: '📦' },
    { id: 'excel',            label: 'Excel Import',        icon: '📊' },
    { id: 'teslim-kayit',     label: 'Bilgi Teslim',        icon: '📦' },
    { id: 'sevkiyat-hazirlama', label: 'Sevkiyat Hazırlama', icon: '🚚' },
  ]},
  { group: 'Tanımlar', items: [
    { id: 'kartlar',          label: 'Kartlar',             icon: '💳' },
    { id: 'kart-merkez',      label: 'Kart Merkezi',        icon: '💳' },
    { id: 'personel',         label: 'Personel',            icon: '👥' },
    { id: 'borclar',          label: 'Borç Envanteri',      icon: '🏦' },
    { id: 'sabit-giderler',   label: 'Sabit Giderler',      icon: '🏠' },
    { id: 'vardiya-planlamasi',label: 'Vardiya Planlaması', icon: '🗓️' },
    { id: 'sube-panel-pin',   label: 'Personel panel PIN',  icon: '🔐' },
    { id: 'tedarikciler',     label: 'Tedarikçiler',        icon: '🚚' },
  ]},
];

const PAGES = {
  panel:              Panel,
  'ops-merkez':       OperasyonMerkezi,
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
  'sevkiyat-hazirlama': SevkiyatHazirlama,
  kartlar:            Kartlar,
  'kart-analiz':      KartMerkez,
  personel:           Personel,
  borclar:            Borclar,
  'sabit-giderler':   SabitGiderler,
  'vardiya-planlamasi': Subeler,
  'sube-panel-pin':   SubePanelPinleri,
  tedarikciler:       Tedarikciler,
};

function readPageFromHash() {
  try {
    const raw = (window.location.hash || '').replace(/^#/, '').split('&')[0];
    const h = decodeURIComponent(raw).trim();
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
              <div className="nav-label">{g.group}</div>
              {g.items.map(item => (
                <div
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => navigate(item.id)}
                >
                  <span className="icon">{item.icon}</span>
                  {item.label}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">EVVEL v2.4 · 27.03.2026</div>
      </aside>
      <main className="main" ref={mainRef}>
        <Page onNavigate={navigate} />
      </main>
    </div>
  );
}
