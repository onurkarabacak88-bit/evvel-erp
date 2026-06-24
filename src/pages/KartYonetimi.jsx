import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { api, fmt } from '../utils/api';
import KartMerkez from './KartMerkez';
import Kartlar from './Kartlar';
import KartHareketleri from './KartHareketleri';
import KartEkstreAnaliz from './KartEkstreAnaliz';
import EkstreYukle from './EkstreYukle';

const TABS = [
  { id: 'genel',        label: 'Genel',          icon: '📊', C: KartMerkez },
  { id: 'koc',          label: 'Borç Koçu',      icon: '🧭', C: BorcKocu },
  { id: 'kartlar',      label: 'Kartlar',        icon: '💳', C: Kartlar },
  { id: 'hareketler',   label: 'Hareketler',     icon: '🧾', C: KartHareketleri },
  { id: 'ekstre-yukle', label: 'Ekstre Yükle',   icon: '📄', C: EkstreYukle },
  { id: 'analiz',       label: 'Ekstre Analizi',  icon: '📂', C: KartEkstreAnaliz },
];

// En sık kullanılan aksiyonlar — her sekmeden tek tık erişim
const QUICK = [
  { id: 'ekstre-yukle', label: 'Ekstre Yükle', icon: '📄', renk: 'var(--accent)' },
  { id: 'hareketler',   label: 'Öde',          icon: '💸', renk: 'var(--green)', odeme: true },
  { id: 'koc',          label: 'Borç Koçu',    icon: '🧭', renk: 'var(--purple)' },
  { id: 'kartlar',      label: 'Kart Ekle',    icon: '➕', renk: 'var(--blue, #4a9eff)' },
];

const ANIM_CSS = `
  @keyframes kyFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes kyPop  { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }
  .ky-content { animation: kyFade .26s cubic-bezier(.22,.61,.36,1); }
  .ky-tab { position: relative; display: flex; align-items: center; gap: 7px; padding: 11px 16px;
    font-size: 13px; cursor: pointer; border: none; background: transparent; color: var(--text3);
    white-space: nowrap; transition: color .18s ease; border-radius: 8px 8px 0 0; }
  .ky-tab:hover { color: var(--text2); background: var(--bg2); }
  .ky-tab.active { color: var(--accent); font-weight: 700; }
  .ky-tab .ky-ico { font-size: 15px; transition: transform .25s cubic-bezier(.34,1.56,.64,1); }
  .ky-tab.active .ky-ico { transform: scale(1.18); }
  .ky-ind { position: absolute; bottom: -1px; height: 2.5px; border-radius: 3px; background: var(--accent);
    transition: transform .3s cubic-bezier(.22,.61,.36,1), width .3s cubic-bezier(.22,.61,.36,1);
    box-shadow: 0 0 8px var(--accent); }
  .ky-quick { display: flex; align-items: center; gap: 6px; padding: 6px 13px; font-size: 12.5px;
    font-weight: 600; border-radius: 999px; cursor: pointer; border: 1px solid var(--border);
    background: var(--bg2); color: var(--text2); transition: transform .15s ease, box-shadow .15s ease, border-color .15s; }
  .ky-quick:hover { transform: translateY(-1px); border-color: currentColor;
    box-shadow: 0 3px 12px rgba(0,0,0,.18); }
  .ky-kpi { animation: kyPop .4s cubic-bezier(.22,.61,.36,1) both; transition: transform .18s ease, box-shadow .18s ease; }
  .ky-kpi:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.16); }
  .ky-bar { height: 9px; border-radius: 5px; overflow: hidden; display: flex; background: var(--bg3); }
  .ky-bar > span { height: 100%; transition: width .5s cubic-bezier(.22,.61,.36,1); }
`;

function BorcFaizOzet({ onJump }) {
  const [d, setD] = useState(null);
  const [ho, setHo] = useState(null);
  useEffect(() => {
    api('/kartlar/borc-faiz-ozet').then(setD).catch(() => {});
    api('/kartlar/harcama-ozet').then(setHo).catch(() => {});
  }, []);
  if (!d) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)' }}><div className="spinner" /></div>;
  }

  const eksik = d.bu_ay_eksik_ekstre || [];
  // İşletme/şahsi/belirsiz oranları (görsel bar)
  const g = ho?.genel || { isletme: 0, sahsi: 0, belirsiz: 0 };
  const topHarcama = (g.isletme || 0) + (g.sahsi || 0) + (g.belirsiz || 0);
  const pct = (v) => topHarcama > 0 ? Math.round((v / topHarcama) * 100) : 0;

  const kpi = [
    { label: '💳 Toplam Kart Borcu', val: fmt(d.toplam_borc_taksitli ?? d.toplam_borc), renk: 'var(--red)', big: true,
      sub: d.toplam_taksit > 0
        ? `dönem ${fmt(d.toplam_borc)} + 📅 taksit ${fmt(d.toplam_taksit)}`
        : 'tüm aktif kartlar (taksit dahil)' },
    { label: '📈 Bankaya Ödenen Faiz', val: fmt(d.toplam_odenen_faiz), renk: 'var(--orange)',
      sub: 'ekstrelerden birikimli' },
  ];

  return (
    <div className="ky-content" style={{ padding: '14px 16px 0' }}>
      {/* HERO KPI + eksik ekstre aksiyon çipi */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12, marginBottom: 14 }}>
        {kpi.map((k, i) => (
          <div key={k.label} className="card ky-kpi" style={{ padding: '14px 16px', borderTop: `3px solid ${k.renk}`, animationDelay: `${i * 60}ms` }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700, letterSpacing: .3 }}>{k.label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: k.big ? 30 : 24, fontWeight: 800, color: k.renk, lineHeight: 1.1, marginTop: 4 }}>{k.val}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{k.sub}</div>
          </div>
        ))}
        {/* Eksik ekstre — aksiyon kartı */}
        <div
          className="card ky-kpi"
          onClick={() => eksik.length && onJump('ekstre-yukle')}
          style={{
            padding: '14px 16px', cursor: eksik.length ? 'pointer' : 'default',
            borderTop: `3px solid ${eksik.length ? 'var(--yellow)' : 'var(--green)'}`, animationDelay: '120ms',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 700, letterSpacing: .3 }}>📄 Bu Ay Ekstre Durumu</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: eksik.length ? 'var(--yellow)' : 'var(--green)', marginTop: 6 }}>
            {eksik.length ? `${eksik.length} kart eksik` : '✓ Hepsi yüklü'}
          </div>
          {eksik.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
              {eksik.slice(0, 4).join(', ')}{eksik.length > 4 ? '…' : ''} · <span style={{ color: 'var(--accent)' }}>yüklemek için tıkla →</span>
            </div>
          )}
        </div>
      </div>

      {/* İŞLETME / ŞAHSİ / BELİRSİZ — görsel bar */}
      {ho && topHarcama > 0 && (
        <div className="card ky-kpi" style={{ padding: '14px 16px', marginBottom: 14, animationDelay: '180ms' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>🏢 İşletme vs 👤 Şahsi Kırılımı <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>(kart harcamaları)</span></div>
            {g.belirsiz > 0 && (
              <button className="ky-quick" style={{ color: 'var(--orange)' }} onClick={() => onJump('hareketler')}>
                ❓ {fmt(g.belirsiz)} sınıflandır →
              </button>
            )}
          </div>
          <div className="ky-bar">
            <span style={{ width: `${pct(g.isletme)}%`, background: 'var(--green)' }} title={`İşletme ${fmt(g.isletme)}`} />
            <span style={{ width: `${pct(g.sahsi)}%`, background: 'var(--purple)' }} title={`Şahsi ${fmt(g.sahsi)}`} />
            <span style={{ width: `${pct(g.belirsiz)}%`, background: 'var(--orange)' }} title={`Belirsiz ${fmt(g.belirsiz)}`} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={{ color: 'var(--green)' }}>🏢 İşletme <strong>{fmt(g.isletme)}</strong> · %{pct(g.isletme)}</span>
            <span style={{ color: 'var(--purple)' }}>👤 Şahsi <strong>{fmt(g.sahsi)}</strong> · %{pct(g.sahsi)}</span>
            {g.belirsiz > 0 && <span style={{ color: 'var(--orange)' }}>❓ Belirsiz <strong>{fmt(g.belirsiz)}</strong> · %{pct(g.belirsiz)}</span>}
          </div>
        </div>
      )}

      {/* KART BAZLI TABLO */}
      <div className="card ky-kpi" style={{ padding: 0, marginBottom: 12, animationDelay: '240ms' }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kart</th><th>Sahip</th><th style={{ textAlign: 'right' }}>Dönem Borcu</th><th style={{ textAlign: 'right' }}>📅 Taksit Tutarı</th><th style={{ textAlign: 'right' }}>Toplam Borç</th><th style={{ textAlign: 'right' }}>Ödenen Faiz</th><th>Son Ekstre</th><th>Bu Ay</th></tr></thead>
            <tbody>
              {d.kartlar.map(k => (
                <tr key={k.kart_id}>
                  <td style={{ fontSize: 12, fontWeight: 600 }}>{k.kart_adi}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{k.sahip}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{fmt(k.guncel_borc)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{k.gelecek_taksit_anapara > 0 ? <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>{fmt(k.gelecek_taksit_anapara)}</span> : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--red)' }}>{fmt(k.toplam_borc_taksitli ?? k.guncel_borc)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{k.toplam_odenen_faiz > 0 ? <span style={{ color: 'var(--orange)' }}>{fmt(k.toplam_odenen_faiz)}</span> : '—'}</td>
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

function BorcKocu() {
  const [strateji, setStrateji] = useState('cig');
  const [nakit, setNakit] = useState('');
  const [d, setD] = useState(null);
  const [proj, setProj] = useState(null);
  const [loading, setLoading] = useState(false);

  function yukle() {
    setLoading(true);
    const n = parseFloat(nakit) || 0;
    api(`/kartlar/borc-kocu?strateji=${strateji}&nakit=${n}`).then(setD).catch(() => {}).finally(() => setLoading(false));
    if (n > 0) api(`/kartlar/borc-projeksiyon?aylik=${n}&strateji=${strateji}`).then(setProj).catch(() => setProj(null));
    else setProj(null);
  }
  useEffect(() => { yukle(); /* eslint-disable-next-line */ }, [strateji]);

  return (
    <div className="ky-content" style={{ padding: '14px 16px' }}>
      {/* KPI'lar */}
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 14 }}>
          {[
            { l: '💳 TOPLAM BORÇ', v: fmt(d.toplam_borc), c: 'var(--red)', s: '' },
            { l: '🩸 AYLIK FAİZ KAYBI', v: fmt(d.toplam_aylik_faiz), c: 'var(--orange)', s: 'hiçbir şey yapmazsan her ay bankaya' },
            { l: '📋 TOPLAM ASGARİ', v: fmt(d.toplam_asgari), c: 'var(--text1)', s: 'bu ay en az ödenmesi gereken' },
          ].map((k, i) => (
            <div key={k.l} className="card ky-kpi" style={{ padding: '12px 14px', animationDelay: `${i * 60}ms` }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>{k.l}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: k.c }}>{k.v}</div>
              {k.s && <div style={{ fontSize: 10, color: 'var(--text3)' }}>{k.s}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Strateji + nakit */}
      <div className="card mb-16" style={{ padding: 14, display: 'flex', gap: 14, alignItems: 'end', flexWrap: 'wrap' }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Strateji</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={`btn btn-sm ${strateji === 'cig' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStrateji('cig')} title="En yüksek faizliyi önce → en az faiz ödersin">🔻 Çığ (en yüksek faiz)</button>
            <button className={`btn btn-sm ${strateji === 'kartopu' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStrateji('kartopu')} title="En küçük borcu önce → motivasyon">❄️ Kartopu (en küçük borç)</button>
          </div>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Bu ay ödeyebileceğin nakit (₺)</label>
          <input type="number" value={nakit} onChange={e => setNakit(e.target.value)} placeholder="örn. 150000"
            style={{ padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text1)', width: 160 }} />
        </div>
        <button className="btn btn-primary btn-sm" onClick={yukle} disabled={loading}>{loading ? '…' : 'Hesapla'}</button>
      </div>

      {/* Öncelik vurgusu */}
      {d?.oncelik && (
        <div className="card mb-16" style={{ padding: 16, borderLeft: '3px solid var(--accent)' }}>
          <div style={{ fontSize: 13, color: 'var(--text2)' }}>🎯 <strong>Önce bunu kapat:</strong></div>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--accent)', marginTop: 4 }}>{d.oncelik.kart_adi}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
            Borç {fmt(d.oncelik.borc)} · Yıllık faiz %{d.oncelik.faiz_yillik} · Aylık faiz {fmt(d.oncelik.aylik_faiz)}
            {strateji === 'cig' ? ' — en pahalı faiz burada, önce bunu bitir.' : ' — en küçük borç, hızlı kapanır (motivasyon).'}
          </div>
          {d.asgari_karsilaniyor === false && (
            <div className="alert-box red" style={{ marginTop: 10 }}>⚠️ Girdiğin nakit toplam asgariyi ({fmt(d.toplam_asgari)}) karşılamıyor — en yüksek faizlilerin asgarisine öncelik verildi.</div>
          )}
          {Number(nakit) > 0 && d.artan_nakit > 0 && (
            <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 8 }}>✓ Tüm asgariler + öncelik kapandı, {fmt(d.artan_nakit)} nakit arttı (sıradakine yatır).</div>
          )}
        </div>
      )}

      {/* Kurtuluş Projeksiyonu */}
      {proj && (
        <div className="card mb-16" style={{ padding: 16, border: '1px solid var(--green)' }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🚀 Kurtuluş Projeksiyonu (aylık {fmt(proj.aylik)})</h3>
          {proj.verilen?.ay ? (
            <>
              <div style={{ fontSize: 15 }}>
                Bu tempoyla borç <strong style={{ color: 'var(--green)' }}>{proj.verilen.ay} ayda</strong> biter
                {proj.verilen.bitis_tarihi && <> (≈ <strong>{proj.verilen.bitis_tarihi.slice(0, 7)}</strong>)</>},
                toplam faiz <strong style={{ color: 'var(--orange)' }}>{fmt(proj.verilen.toplam_faiz)}</strong>.
              </div>
              {proj.aylik < proj.toplam_asgari && (
                <div className="alert-box yellow" style={{ marginTop: 8 }}>
                  ⚠️ Girdiğin tutar toplam asgarinin ({fmt(proj.toplam_asgari)}) altında — gecikme faizi/risk doğar. Mümkünse asgari üstüne çık.
                </div>
              )}
              {proj.erken_ay > 0 && proj.tasarruf_faiz > 0 && (
                <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 8, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 6 }}>
                  💡 Sadece asgari ödesen {proj.asgari_only.ay} ay sürerdi. Bu plan sana <strong style={{ color: 'var(--green)' }}>{fmt(proj.tasarruf_faiz)} faiz</strong> + <strong style={{ color: 'var(--green)' }}>{proj.erken_ay} ay</strong> kazandırır.
                </div>
              )}
            </>
          ) : (
            <div className="alert-box red">⚠️ Aylık {fmt(proj.aylik)} faizi bile karşılamıyor — borç azalmaz, büyür. Toplam asgari ({fmt(proj.toplam_asgari)}) üstünde bir tutar gir.</div>
          )}
        </div>
      )}

      {/* Tablo */}
      {d?.kartlar?.length > 0 ? (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Kart</th><th style={{ textAlign: 'right' }}>Borç</th><th style={{ textAlign: 'right' }}>Faiz %</th><th style={{ textAlign: 'right' }}>Aylık Faiz</th><th style={{ textAlign: 'right' }}>Asgari</th><th>Son Ödeme</th>{Number(nakit) > 0 && <th style={{ textAlign: 'right' }}>ÖNERİLEN ÖDEME</th>}</tr></thead>
              <tbody>
                {d.kartlar.map((k, i) => (
                  <tr key={k.kart_id} style={{ background: i === 0 ? 'rgba(200,149,106,0.07)' : undefined }}>
                    <td style={{ fontWeight: 700, color: i === 0 ? 'var(--accent)' : 'var(--text3)' }}>{i + 1}</td>
                    <td style={{ fontSize: 12, fontWeight: 600 }}>{k.kart_adi}<div style={{ fontSize: 10, color: 'var(--text3)' }}>{k.sahip}</div></td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmt(k.borc)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{k.faiz_belirsiz ? <span style={{ color: 'var(--yellow)' }} title="Faiz oranı girilmemiş">?</span> : `%${k.faiz_yillik}`}</td>
                    <td style={{ textAlign: 'right', color: 'var(--orange)' }} className="mono">{fmt(k.aylik_faiz)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{fmt(k.asgari)}</td>
                    <td style={{ fontSize: 11, color: 'var(--text3)' }}>{k.son_odeme ? new Date(k.son_odeme).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) : '—'}</td>
                    {Number(nakit) > 0 && <td style={{ textAlign: 'right', fontWeight: 700, color: k.onerilen_odeme > 0 ? 'var(--green)' : 'var(--text3)' }} className="mono">{k.onerilen_odeme > 0 ? fmt(k.onerilen_odeme) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : !loading && <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>🎉 Borcu olan kart yok!</div>}

      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 12 }}>
        ℹ️ <strong>Çığ</strong>: en yüksek faizliyi önce kapat → toplam en az faiz (matematiksel en ucuz). <strong>Kartopu</strong>: en küçük borcu önce kapat → motivasyon. Faiz oranı "?" olan kartların oranını <strong>Kartlar</strong>'dan gir ki hesap doğru olsun. Bu standart bir çerçevedir; kişiye özel mali karar için müşavirine de danış.
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

  // Kayan aktif sekme göstergesi
  const tabRefs = useRef({});
  const [ind, setInd] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = tabRefs.current[aktif.id];
    if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
  }, [aktif.id, tab]);
  useEffect(() => {
    const onResize = () => {
      const el = tabRefs.current[aktif.id];
      if (el) setInd({ left: el.offsetLeft, width: el.offsetWidth });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [aktif.id]);

  function sec(id) {
    setTab(id);
    try { sessionStorage.setItem('kart_yonetimi_tab', id); } catch { /* */ }
  }

  return (
    <div>
      <style>{ANIM_CSS}</style>
      <div style={{
        position: 'sticky', top: 0, zIndex: 30, background: 'var(--bg)',
        borderBottom: '1px solid var(--border)', padding: '8px 16px 0',
      }}>
        {/* Üst satır: sekmeler + hızlı erişim */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {TABS.map(t => (
              <button
                key={t.id} type="button" onClick={() => sec(t.id)}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                className={`ky-tab ${t.id === aktif.id ? 'active' : ''}`}
              >
                <span className="ky-ico">{t.icon}</span>{t.label}
              </button>
            ))}
            <div className="ky-ind" style={{ width: ind.width, transform: `translateX(${ind.left}px)` }} />
          </div>

          {/* Hızlı erişim çubuğu */}
          <div style={{ display: 'flex', gap: 7, paddingBottom: 8, flexWrap: 'wrap' }}>
            {QUICK.filter(q => q.id !== aktif.id).map(q => (
              <button key={q.id} type="button" className="ky-quick" style={{ color: q.renk }}
                onClick={() => {
                  if (q.odeme) { try { sessionStorage.setItem('kart_hareket_odeme_modal', '1'); } catch (_) {} }
                  sec(q.id);
                }}>
                <span style={{ fontSize: 14 }}>{q.icon}</span>{q.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {aktif.id === 'genel' && <BorcFaizOzet onJump={sec} />}
      <div key={tab} className="ky-content">
        <Active onNavigate={onNavigate} />
      </div>
    </div>
  );
}
