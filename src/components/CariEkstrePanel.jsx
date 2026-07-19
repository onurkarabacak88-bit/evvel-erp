import { useState } from 'react';
import { fmt } from '../utils/api';

// ── 📒 CARİ EKSTRE PANELİ — ORTAK BİLEŞEN (2026-07-19, sahip: 'dünya
// klasmanında kullanım, sitenin profesyonelliğini kurgula' + 'Tedarikçi
// Merkezi içeriğini tamamla'). Codex çaprazlı tasarım spec'i; Ödeme Merkezi
// Tedarikçi sekmesi ve Tedarikçi Merkezi (Tedarikçi-360) AYNI paneli kullanır —
// tek kaynak, iki ekran; ekstre iki yerde iki farklı kalitede yaşamaz.
// Kanonik hiyerarşi (Xero/QuickBooks kalıbı): önce GÜNCEL DURUM (KPI şeridi),
// sonra DEFTER (borç/alacak/bakiye kolonlu gerçek tablo), sonra mutabakat
// (ikincil, katlanır), en sonda kaynak belgeler. PDF sağ çekmecede açılır —
// kullanıcı satırdan kopmaz; yeni sekme ikincil aksiyon. Veri tek uçtan
// (/fatura/cari-ekstre) — panel yalnız sunum, hesap yapmaz.
const bugunISO = () => new Date().toISOString().slice(0, 10);
const artiGunISO = (g) => new Date(Date.now() + g * 86400000).toISOString().slice(0, 10);

export const trT = (d) => (d && d.length >= 10) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : (d || '');
export const trAy = (a) => { // '2026-07' → 'Tem 2026'
  const adlar = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  return a && a.length >= 7 ? `${adlar[Number(a.slice(5, 7)) - 1] || a.slice(5, 7)} ${a.slice(0, 4)}` : a;
};

// 🏪 sürekli tedarikçi listesi (kullanım sıralı) — sekme şeridi ve otomatik ilk
// seçim AYNI listeyi kullanır (tek kaynak; ikisi ayrışırsa yanlış sekme seçilir)
export const malCariListesi = (cariler) => (cariler || [])
  .filter(t => !['hizmet', 'gecici'].includes(t.sinif || 'mal')
    && ((t.hesaplanan_acik || 0) > 1 || (t.fatura_adet_6ay || 0) > 0 || (t.odeme_izi_toplam_6ay || 0) > 0))
  .sort((a, b) => (b.fatura_adet_6ay || 0) - (a.fatura_adet_6ay || 0)
    || (b.fatura_toplam_6ay || 0) - (a.fatura_toplam_6ay || 0)
    || (b.hesaplanan_acik || 0) - (a.hesaplanan_acik || 0));

export default function CariEkstrePanel({ ek, ad }) {
  const [donem, setDonem] = useState('tumu');     // buay | son3 | tumu
  const [mutAcik, setMutAcik] = useState(false);  // aylık mutabakat katlanır
  const [onizle, setOnizle] = useState(null);     // {url,no,tarih,tutar} → sağ çekmece
  const bugun = bugunISO();
  const esik = donem === 'buay' ? `${bugun.slice(0, 7)}-01` : donem === 'son3' ? artiGunISO(-90) : '';

  const har = (ek.hareketler || []).filter(h => !esik || h.tarih >= esik);
  const fats = (ek.faturalar || []).filter(f => !esik || String(f.tarih) >= esik).slice(-30).reverse();
  const aylar = (ek.aylik || []).filter(a => !a.sistem_oncesi);
  const vadeler = ek.bekleyen_vadeler || [];
  const gecikmis = vadeler.filter(v => v.vade && v.vade < bugun);
  const gecikmisTop = gecikmis.reduce((s, v) => s + (v.tutar || 0), 0);
  const enEskiGun = gecikmis.length
    ? Math.max(...gecikmis.map(v => Math.round((new Date(bugun) - new Date(v.vade)) / 86400000))) : 0;
  const siradaki = vadeler.filter(v => v.vade && v.vade >= bugun).sort((a, b) => a.vade.localeCompare(b.vade))[0] || null;
  const odemeler = (ek.odeme_adaylari || []).slice().sort((a, b) => String(a.tarih).localeCompare(String(b.tarih)));
  const sonOdeme = odemeler[odemeler.length - 1] || null;

  const M = 'var(--font-mono)';
  const kpiKart = (label, deger, alt, renk) => (
    <div style={{ flex: '1 1 160px', minWidth: 150, padding: '12px 14px', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--bg2)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: M, fontVariantNumeric: 'tabular-nums',
                    color: renk || 'var(--text)' }}>{deger}</div>
      {alt && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alt}</div>}
    </div>
  );

  const rozet = (metin, tip) => {
    const stil = tip === 'odeme' ? { border: '1px solid var(--green, #22c55e)', color: 'var(--green, #22c55e)' }
      : tip === 'devir' ? { border: '1px solid var(--text3)', color: 'var(--text3)' }
      : { border: '1px solid var(--border)', color: 'var(--text2, var(--text))' };
    return <span style={{ ...stil, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap' }}>{metin}</span>;
  };

  const para = (n) => (n == null ? '' : fmt(n));
  const hucreSag = { textAlign: 'right', fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 12.5, padding: '9px 8px', whiteSpace: 'nowrap' };
  const hucre = { fontSize: 12.5, padding: '9px 8px' };
  const basHucre = { fontSize: 11, fontWeight: 700, color: 'var(--text3)', textAlign: 'left', padding: '4px 8px' };

  const yazdir = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    const satirlar = har.map(h => `<tr>
      <td>${trT(h.tarih)}</td><td>${h.tip === 'odeme' ? 'Ödeme' : h.tip === 'devir' ? 'Devir' : 'Fatura'}</td>
      <td>${(h.aciklama || '').replace(/</g, '&lt;').slice(0, 60)}</td>
      <td class="s">${h.tip === 'odeme' ? '' : para(h.tutar)}</td>
      <td class="s">${h.tip === 'odeme' ? para(h.tutar) : ''}</td>
      <td class="s">${para(h.bakiye)}</td></tr>`).join('');
    w.document.write(`<html><head><title>${ad} — Cari Ekstre</title><style>
      body{font-family:Arial,sans-serif;color:#111;padding:24px}h2{margin:0 0 2px}
      .alt{color:#555;font-size:12px;margin-bottom:14px}
      table{border-collapse:collapse;width:100%;font-size:12px}
      th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
      th{background:#f2f2f2}td.s{text-align:right;font-variant-numeric:tabular-nums}
      .toplam{margin-top:12px;font-size:14px;font-weight:bold}</style></head><body>
      <h2>${ad} — Cari Ekstre</h2>
      <div class="alt">Düzenleme: ${trT(bugun)} · Açık bakiye: ${para(ek.hesaplanan_acik)} · Kaynak: EVVEL Ödeme Merkezi</div>
      <table><tr><th>Tarih</th><th>İşlem</th><th>Açıklama</th><th>Borç</th><th>Alacak</th><th>Bakiye</th></tr>${satirlar}</table>
      <div class="toplam">Güncel Bakiye: ${para(ek.yuruyen_bakiye)}</div></body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  const chip = (k, etiket) => (
    <button key={k} onClick={() => setDonem(k)}
      style={{ height: 26, padding: '0 11px', borderRadius: 13, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
               border: `1px solid ${donem === k ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
               background: donem === k ? 'var(--accent, #c9853f)' : 'transparent',
               color: donem === k ? '#1a120b' : 'var(--text3)' }}>{etiket}</button>
  );

  return (
    <div style={{ margin: '0 10px 12px 10px', padding: '14px 16px', borderRadius: 12,
                  border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--bg2) 60%, transparent)' }}>
      {/* 1 ▸ KPI ŞERİDİ — önce güncel durum */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        {kpiKart('Açık Bakiye', para(ek.hesaplanan_acik), 'fatura − ödeme + devir')}
        {kpiKart('Vadesi Geçmiş', para(gecikmisTop),
          gecikmisTop > 0 ? `en eski gecikme ${enEskiGun} gün` : 'geciken yok ✓',
          gecikmisTop > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)')}
        {kpiKart('Son Ödeme', sonOdeme ? para(sonOdeme.tutar) : '—',
          sonOdeme ? trT(String(sonOdeme.tarih)) : 'henüz ödeme izi yok')}
        {kpiKart('Sıradaki Vade', siradaki ? trT(siradaki.vade) : '—',
          siradaki ? `beklenen ${para(siradaki.tutar)}` : 'takvimde vade yok',
          gecikmisTop > 0 ? '#f59e0b' : undefined)}
      </div>

      {/* 2 ▸ HAREKET EKSTRESİ — ana bölüm: borç/alacak/bakiye defteri */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2, var(--text))' }}>Hareket Ekstresi</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {chip('buay', 'Bu Ay')}{chip('son3', 'Son 3 Ay')}{chip('tumu', 'Tümü')}
          <button onClick={yazdir} title="Yazdırılabilir ekstre"
            style={{ height: 26, padding: '0 11px', borderRadius: 13, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                     border: '1px solid var(--border)', background: 'transparent', color: 'var(--text3)' }}>🖨 Yazdır</button>
        </span>
      </div>
      {har.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text3)', padding: '10px 0 4px' }}>Bu dönemde hareket yok.</div>
      ) : (
        <div style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ ...basHucre, width: 84 }}>Tarih</th>
                <th style={{ ...basHucre, width: 72 }}>İşlem</th>
                <th style={basHucre}>Açıklama</th>
                <th style={{ ...basHucre, textAlign: 'right', width: 104 }}>Borç</th>
                <th style={{ ...basHucre, textAlign: 'right', width: 104 }}>Alacak</th>
                <th style={{ ...basHucre, textAlign: 'right', width: 116 }}>Bakiye</th>
              </tr>
            </thead>
            <tbody>
              {har.map((h, j) => (
                <tr key={j} style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.03)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                  <td style={{ ...hucre, fontFamily: M, fontSize: 12, whiteSpace: 'nowrap' }}>{trT(h.tarih)}</td>
                  <td style={hucre}>{rozet(h.tip === 'odeme' ? 'Ödeme' : h.tip === 'devir' ? 'Devir' : 'Fatura', h.tip)}</td>
                  <td style={{ ...hucre, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text2, var(--text))' }}>
                    {(h.aciklama || '').slice(0, 48)}
                    {h.goruntule && (
                      <button onClick={() => setOnizle({ url: h.goruntule, no: h.aciklama, tarih: h.tarih, tutar: h.tutar })}
                        style={{ marginLeft: 6, padding: '1px 7px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
                                 border: '1px solid var(--blue, #60a5fa)', color: 'var(--blue, #60a5fa)', background: 'transparent' }}>belge</button>
                    )}
                  </td>
                  <td style={{ ...hucreSag, color: h.tip === 'odeme' ? 'transparent' : '#d6a663' }}>{h.tip === 'odeme' ? '' : para(h.tutar)}</td>
                  <td style={{ ...hucreSag, color: 'var(--green, #22c55e)' }}>{h.tip === 'odeme' ? para(h.tutar) : ''}</td>
                  <td style={hucreSag}>{para(h.bakiye)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'rgba(255,255,255,.04)', borderTop: '2px solid var(--border)' }}>
                <td colSpan={5} style={{ ...hucre, fontWeight: 800 }}>Güncel Bakiye</td>
                <td style={{ ...hucreSag, fontSize: 14, fontWeight: 800 }}>{para(ek.yuruyen_bakiye)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 3 ▸ AYLIK MUTABAKAT — ikincil, katlanır */}
      {aylar.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button onClick={() => setMutAcik(a => !a)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                     fontSize: 12, fontWeight: 700, color: 'var(--text2, var(--text))' }}>
            {mutAcik ? '▾' : '▸'} Aylık Mutabakat <span style={{ fontWeight: 400, color: 'var(--text3)' }}>({aylar.length} ay)</span>
          </button>
          {mutAcik && (
            <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table style={{ width: '100%', minWidth: 460, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ ...basHucre, width: 90 }}>Ay</th>
                  <th style={{ ...basHucre, textAlign: 'right' }}>Fatura</th>
                  <th style={{ ...basHucre, textAlign: 'right' }}>Ödeme</th>
                  <th style={{ ...basHucre, textAlign: 'right', width: 120 }}>Net Fark</th>
                  <th style={{ ...basHucre, textAlign: 'right', width: 110 }}>Durum</th>
                </tr>
              </thead>
              <tbody>
                {aylar.map((a, j) => (
                  <tr key={j} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...hucre, fontWeight: 700 }}>{trAy(a.ay)}</td>
                    <td style={hucreSag}>{a.fatura_adet > 0 ? `${a.fatura_adet} · ${para(a.fatura_toplam)}` : '—'}</td>
                    <td style={hucreSag}>{a.odeme_adet > 0 ? `${a.odeme_adet} · ${para(a.odeme_toplam)}` : '—'}</td>
                    <td style={hucreSag}>{para(Math.abs(a.fark))}</td>
                    <td style={{ ...hucre, textAlign: 'right' }}>
                      {a.fark > 0 ? rozet('Kalan', 'fatura')
                        : a.fark < 0 ? rozet('Fazla ödeme', 'devir')
                        : rozet('Kapandı ✓', 'odeme')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {/* 4 ▸ BELGELER — kaynak faturalar (belge önizleme çekmecesiyle) */}
      {fats.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2, var(--text))', marginBottom: 4 }}>Belgeler</div>
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 440, borderCollapse: 'collapse' }}>
            <tbody>
              {fats.map((f, j) => (
                <tr key={j} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...hucre, fontFamily: M, fontSize: 12, width: 84, whiteSpace: 'nowrap' }}>{trT(String(f.tarih))}</td>
                  <td style={{ ...hucre, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.fatura_no || 'no yok'}</td>
                  <td style={{ ...hucreSag, width: 110 }}>{para(f.tutar)}</td>
                  <td style={{ ...hucre, textAlign: 'right', width: 150, whiteSpace: 'nowrap' }}>
                    {f.goruntule && (
                      <>
                        <button onClick={() => setOnizle({ url: f.goruntule, no: f.fatura_no, tarih: String(f.tarih), tutar: f.tutar })}
                          style={{ padding: '2px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                                   border: '1px solid var(--blue, #60a5fa)', color: 'var(--blue, #60a5fa)', background: 'transparent' }}>Önizle</button>
                        <a href={f.goruntule} target="_blank" rel="noreferrer"
                           style={{ marginLeft: 8, fontSize: 11, color: 'var(--text3)' }}>Yeni sekme ↗</a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* 📄 BELGE ÇEKMECESİ — sağdan açılır, ekstre görünür kalır */}
      {onizle && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70 }}>
          <div onClick={() => setOnizle(null)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
          <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(760px, 94vw)',
                        background: 'var(--bg1, #17110c)', borderLeft: '1px solid var(--border)',
                        display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 28px rgba(0,0,0,.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                          padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  🧾 {onizle.no || 'Fatura'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                  {trT(onizle.tarih)}{onizle.tutar != null ? ` · ${para(onizle.tutar)}` : ''} · {ad}
                </div>
              </span>
              <span style={{ display: 'flex', gap: 8, whiteSpace: 'nowrap' }}>
                <a className="btn btn-secondary btn-sm" href={onizle.url} target="_blank" rel="noreferrer">Yeni sekmede aç</a>
                <button className="btn btn-primary btn-sm" onClick={() => setOnizle(null)}>Kapat ✕</button>
              </span>
            </div>
            <iframe title="fatura-onizleme" src={onizle.url}
              style={{ flex: 1, border: 'none', background: '#fff' }} />
          </div>
        </div>
      )}
    </div>
  );
}
