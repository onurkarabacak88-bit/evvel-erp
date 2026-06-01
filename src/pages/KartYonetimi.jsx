import { useState, useEffect } from 'react';
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
    <div style={{ padding: '14px 16px' }}>
      {/* KPI'lar */}
      {d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 14 }}>
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>💳 TOPLAM BORÇ</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--red)' }}>{fmt(d.toplam_borc)}</div>
          </div>
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>🩸 AYLIK FAİZ KAYBI</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--orange)' }}>{fmt(d.toplam_aylik_faiz)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>hiçbir şey yapmazsan her ay bankaya</div>
          </div>
          <div className="card" style={{ padding: '12px 14px' }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600 }}>📋 TOPLAM ASGARİ</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 800, color: 'var(--text1)' }}>{fmt(d.toplam_asgari)}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>bu ay en az ödenmesi gereken</div>
          </div>
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
              {proj.tasarruf_faiz != null && proj.erken_ay != null && (
                <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 8, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 6 }}>
                  💡 Sadece asgari ödesen: {proj.asgari_only.ay} ay + {fmt(proj.asgari_only.toplam_faiz)} faiz.
                  Bu plan sana <strong style={{ color: 'var(--green)' }}>{fmt(proj.tasarruf_faiz)} faiz</strong> + <strong style={{ color: 'var(--green)' }}>{proj.erken_ay} ay</strong> kazandırır.
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
