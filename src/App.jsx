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
import Ciro from './pages/Ciro';
import Strateji from './pages/Strateji';
import Ledger from './pages/Ledger';
import ExcelImport from './pages/ExcelImport';
import DisKaynak from './pages/DisKaynak';
import Rapor from './pages/Rapor';
import KartMerkez from './pages/KartMerkez';
import Subeler from './pages/Subeler';
import './index.css';

const NAV = [
  { group: 'Ana', items: [
    { id: 'panel', label: 'CFO Panel', icon: '⬛' },
    { id: 'rapor', label: 'Aylık Rapor', icon: '📊' },
    { id: 'strateji', label: 'Strateji Motoru', icon: '🧠' },
    { id: 'onay', label: 'Onay Kuyruğu', icon: '✅' },
    { id: 'ledger', label: 'İşlem Defteri', icon: '📒' },
  ]},
  { group: 'Veri Girişi', items: [
    { id: 'ciro', label: 'Ciro Girişi', icon: '📈' },
    { id: 'kart-hareketleri', label: 'Kart Hareketi', icon: '💳' },
    { id: 'anlik-gider', label: 'Anlık Gider', icon: '💸' },
    { id: 'dis-kaynak', label: 'Dış Kaynak Geliri', icon: '💰' },
    { id: 'vadeli', label: 'Vadeli Alım', icon: '📦' },
    { id: 'excel', label: 'Excel Import', icon: '📊' },
  ]},
  { group: 'Tanımlar', items: [
    { id: 'kartlar', label: 'Kartlar', icon: '💳' },
    { id: 'kart-merkez', label: 'Kart Merkezi', icon: '💳' },
    { id: 'personel', label: 'Personel', icon: '👥' },
    { id: 'borclar', label: 'Borç Envanteri', icon: '🏦' },
    { id: 'sabit-giderler', label: 'Sabit Giderler', icon: '🏠' },
    { id: 'subeler', label: 'Şube Ayarları', icon: '🏪' },
  ]},
];

const PAGES = {
  panel: Panel, strateji: Strateji, onay: OnayKuyrugu, ledger: Ledger,
  ciro: Ciro, 'kart-hareketleri': KartHareketleri, 'anlik-gider': AnlikGider,
  rapor: Rapor, 'kart-merkez': KartMerkez, 'dis-kaynak': DisKaynak, vadeli: VadeliAlimlar, excel: ExcelImport, kartlar: Kartlar, 'kart-analiz': KartMerkez,
  personel: Personel, borclar: Borclar, 'sabit-giderler': SabitGiderler, subeler: Subeler,
};

export default function App() {
  const [page, setPage] = useState('panel');
  const mainRef = useRef(null);
  const Page = PAGES[page] || Panel;

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [page]);

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
                <div key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => setPage(item.id)}>
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
        <Page onNavigate={setPage} />
      </main>
    </div>
  );
}
