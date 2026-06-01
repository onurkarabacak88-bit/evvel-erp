import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
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

function BorcFaizOzet() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/kartlar/borc-faiz-ozet').then(setD).catch(() => {}); }, []);
  if (!d) return null;
  return (
    <div style={{ padding: '14px 16px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10, marginBottom: 12 }}>
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>💳 TOPLAM KART BORCU</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--red)' }}>{fmt(d.toplam_borc)}</div>
        </div>
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>📈 BANKAYA ÖDENEN TOPLAM FAİZ</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--orange)' }}>{fmt(d.toplam_odenen_faiz)}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)' }}>ekstrelerden birikimli</div>
        </div>
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>📄 BU AY EKSTRE</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: d.bu_ay_eksik_ekstre?.length ? 'var(--yellow)' : 'var(--green)', marginTop: 6 }}>
            {d.bu_ay_eksik_ekstre?.length ? `${d.bu_ay_eksik_ekstre.length} kart eksik` : '✓ Hepsi yüklü'}
          </div>
          {d.bu_ay_eksik_ekstre?.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{d.bu_ay_eksik_ekstre.slice(0, 4).join(', ')}{d.bu_ay_eksik_ekstre.length > 4 ? '…' : ''}</div>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 12 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kart</th><th>Sahip</th><th style={{ textAlign: 'right' }}>Güncel Borç</th><th style={{ textAlign: 'right' }}>Ödenen Faiz</th><th>Son Ekstre</th><th>Bu Ay</th></tr></thead>
            <tbody>
              {d.kartlar.map(k => (
                <tr key={k.kart_id}>
                  <td style={{ fontSize: 12, fontWeight: 600 }}>{k.kart_adi}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{k.sahip}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmt(k.guncel_borc)}</td>
                  <td style={{ textAlign: 'right' }} className="mono" >{k.toplam_odenen_faiz > 0 ? <span style={{ color: 'var(--orange)' }}>{fmt(k.toplam_odenen_faiz)}</span> : '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--text3)' }}>{k.son_ekstre_donem ? k.son_ekstre_donem.slice(0, 7) : '—'}</td>
                  <td>{k.bu_ay_ekstre_var ? <span className="badge badge-green">✓</span> : <span className="badge badge-yellow">eksik</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

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
      {aktif.id === 'genel' && <BorcFaizOzet />}
      <Active onNavigate={onNavigate} />
    </div>
  );
}
