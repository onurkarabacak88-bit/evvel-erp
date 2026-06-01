import { useState } from 'react';
import KartMerkez from './KartMerkez';
import Kartlar from './Kartlar';
import KartHareketleri from './KartHareketleri';
import KartEkstreAnaliz from './KartEkstreAnaliz';
import EkstreYukle from './EkstreYukle';

const TABS = [
  { id: 'genel',        label: 'Genel',          icon: '📊', C: KartMerkez },
  { id: 'kartlar',      label: 'Kartlar',        icon: '💳', C: Kartlar },
  { id: 'hareketler',   label: 'Hareketler',     icon: '🧾', C: KartHareketleri },
  { id: 'ekstre-yukle', label: 'Ekstre Yükle',   icon: '📄', C: EkstreYukle },
  { id: 'analiz',       label: 'Ekstre Analizi',  icon: '📂', C: KartEkstreAnaliz },
];

export default function KartYonetimi({ onNavigate }) {
  const [tab, setTab] = useState(() => {
    try { return sessionStorage.getItem('kart_yonetimi_tab') || 'genel'; } catch { return 'genel'; }
  });
  const aktif = TABS.find(t => t.id === tab) || TABS[0];
  const Active = aktif.C;

  function sec(id) {
    setTab(id);
    try { sessionStorage.setItem('kart_yonetimi_tab', id); } catch { /* */ }
  }

  return (
    <div>
      <div style={{
        position: 'sticky', top: 0, zIndex: 30, background: 'var(--bg)',
        borderBottom: '1px solid var(--border)', padding: '10px 16px 0',
        display: 'flex', gap: 4, flexWrap: 'wrap',
      }}>
        {TABS.map(t => {
          const a = t.id === aktif.id;
          return (
            <button key={t.id} type="button" onClick={() => sec(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '9px 16px', fontSize: 13, fontWeight: a ? 700 : 500,
                cursor: 'pointer', border: 'none', background: 'transparent',
                color: a ? 'var(--accent)' : 'var(--text3)',
                borderBottom: a ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1, borderRadius: '7px 7px 0 0',
                transition: 'color .15s, border-color .15s',
              }}>
              <span style={{ fontSize: 15 }}>{t.icon}</span>{t.label}
            </button>
          );
        })}
      </div>
      <Active onNavigate={onNavigate} />
    </div>
  );
}
