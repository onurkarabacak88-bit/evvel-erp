import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import html2pdf from 'html2pdf.js';

const BASE = import.meta.env.VITE_API_URL || '';

const GUN_KEYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const META_KEYS = new Set(['baslik', 'hafta_baslangic', 'hafta_bitis', 'sube_rehber']);

/** Haftanın pazartesi ISO (YYYY-MM-DD). */
function pazartesiISO(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function bugunISO() {
  return new Date().toISOString().slice(0, 10);
}

function subeAdListesi(subeRehber) {
  if (!Array.isArray(subeRehber)) return [];
  return subeRehber.map((r) => (r.ad || '').trim()).filter(Boolean);
}

function hucreSinifi(val, subeAds) {
  const t = (val || '').trim();
  if (!t) return 'hvp-cell hvp-cell--bos';
  const u = t.toLocaleUpperCase('tr-TR');
  if (u.includes('İZİN')) return 'hvp-cell hvp-cell--izin';
  if (/\d{1,2}\s*[.:]\d{2}\s*[-–]\s*\d{1,2}\s*[.:]\d{2}/.test(t)) {
    return 'hvp-cell hvp-cell--saat';
  }
  const compact = t.replace(/\s/g, '');
  if (/^\d{1,2}[.:]\d{2}([.:]\d{2})+$/.test(compact)) {
    return 'hvp-cell hvp-cell--saat';
  }
  for (const ad of subeAds) {
    if (!ad) continue;
    const au = ad.toLocaleUpperCase('tr-TR');
    if (u === au || (au.length >= 3 && u.includes(au))) {
      return 'hvp-cell hvp-cell--sube';
    }
  }
  return 'hvp-cell hvp-cell--diger';
}

/**
 * Haftalık vardiya raporu: tablo, PDF (html2pdf.js), Excel (GET /api/vardiya/excel).
 * Veri: GET /api/vardiya/haftalik?grup=1
 */
export default function HaftalikVardiyaPanel({ onNavigate }) {
  const [tarihSecim, setTarihSecim] = useState(bugunISO);
  const pzt = useMemo(() => pazartesiISO(tarihSecim), [tarihSecim]);

  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState(null);
  const [payload, setPayload] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  const printRef = useRef(null);

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    setHata(null);
    try {
      const res = await fetch(
        `${BASE}/api/vardiya/haftalik?tarih=${encodeURIComponent(pzt)}&grup=true`,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText || 'Veri alınamadı');
      }
      const data = await res.json();
      setPayload(data);
    } catch (e) {
      setHata(e.message || 'Hata');
      setPayload(null);
    } finally {
      setYukleniyor(false);
    }
  }, [pzt]);

  useEffect(() => {
    yukle();
  }, [yukle]);

  const subeAds = useMemo(
    () => subeAdListesi(payload?.sube_rehber),
    [payload],
  );

  const subeBloklari = useMemo(() => {
    if (!payload || typeof payload !== 'object') return [];
    return Object.entries(payload)
      .filter(([k]) => !META_KEYS.has(k))
      .map(([subeAd, satirlar]) => ({
        subeAd,
        satirlar: Array.isArray(satirlar) ? satirlar : [],
      }));
  }, [payload]);

  const excelIndir = async () => {
    setHata(null);
    try {
      const res = await fetch(
        `${BASE}/api/vardiya/excel?tarih=${encodeURIComponent(pzt)}`,
      );
      if (!res.ok) throw new Error('Excel indirilemedi');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vardiya_haftalik_${pzt}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setHata(e.message || 'Excel hatası');
    }
  };

  const pdfIndir = async () => {
    const el = printRef.current;
    if (!el) return;
    setPdfBusy(true);
    setHata(null);
    try {
      await html2pdf()
        .set({
          margin: [3, 3, 3, 3],
          filename: `vardiya_haftalik_${pzt}.pdf`,
          image: { type: 'jpeg', quality: 0.96 },
          html2canvas: { scale: 2, useCORS: true, logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
          pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
        })
        .from(el)
        .save();
    } catch (e) {
      setHata(
        e.message ||
          'PDF oluşturulamadı. `npm install` ile html2pdf.js kurulu olduğundan emin olun.',
      );
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <>
      <style>{`
        .hvp-page { max-width: 1200px; margin: 0 auto; padding: 16px 20px 40px; }
        .hvp-toolbar {
          display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px;
          margin-bottom: 20px; padding: 14px 16px; background: var(--bg2, #f4f4f5);
          border: 1px solid var(--border, #ddd); border-radius: 8px;
        }
        .hvp-toolbar label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
        .hvp-toolbar input[type="date"] { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border, #ccc); }
        .hvp-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .hvp-btn {
          padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border, #bbb);
          background: var(--bg, #fff); cursor: pointer; font-size: 13px; font-weight: 500;
        }
        .hvp-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .hvp-btn-primary { background: #2e7d32; color: #fff; border-color: #1b5e20; }
        .hvp-btn-secondary { background: #5e35b1; color: #fff; border-color: #4527a0; }
        .hvp-print-root {
          background: #fff; color: #111; padding: 12px 14px 20px;
          -webkit-print-color-adjust: exact; print-color-adjust: exact;
        }
        .hvp-print-root h1 {
          text-align: center; font-size: 18px; margin: 0 0 6px; letter-spacing: 0.02em;
        }
        .hvp-print-meta { text-align: center; font-size: 12px; color: #444; margin-bottom: 16px; }
        .hvp-sube-baslik {
          font-size: 13px; font-weight: 700; margin: 14px 0 6px; padding: 6px 8px;
          background: #e8e8e8; border: 1px solid #bbb;
        }
        .hvp-table {
          width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 8px;
          table-layout: fixed;
        }
        .hvp-table th, .hvp-table td {
          border: 1px solid #888; padding: 6px 4px; text-align: center; vertical-align: middle;
          word-break: break-word;
        }
        .hvp-table thead th { background: #d9d9d9; font-weight: 700; }
        .hvp-cell--izin { background: #c8e6c9 !important; }
        .hvp-cell--saat { background: #fafafa !important; }
        .hvp-cell--sube { background: #e1bee7 !important; }
        .hvp-cell--diger { background: #fff8e1 !important; }
        .hvp-cell--bos { background: #fff !important; }
        .hvp-legend { font-size: 11px; color: #555; margin-top: 12px; line-height: 1.5; }
      `}</style>

      <div className="page hvp-page">
        <div className="page-header" style={{ marginBottom: 16 }}>
          <h2>Haftalık vardiya raporu</h2>
          <p style={{ fontSize: 13, color: 'var(--text2, #555)', marginTop: 6 }}>
            Tablo görünümü, PDF ve Excel. Düzenleme için{' '}
            {typeof onNavigate === 'function' ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onNavigate('vardiya-haftalik')}
              >
                Haftalık Vardiya
              </button>
            ) : (
              'Haftalık Vardiya'
            )}{' '}
            sayfasını kullanın.
          </p>
        </div>

        <div className="hvp-toolbar no-print">
          <div>
            <label htmlFor="hvp-tarih">Hafta (herhangi bir gün seçin)</label>
            <input
              id="hvp-tarih"
              type="date"
              value={tarihSecim}
              onChange={(e) => setTarihSecim(e.target.value)}
            />
          </div>
          <div className="hvp-actions">
            <button
              type="button"
              className="hvp-btn hvp-btn-primary"
              disabled={pdfBusy || yukleniyor}
              onClick={pdfIndir}
            >
              {pdfBusy ? 'PDF…' : 'PDF İndir'}
            </button>
            <button
              type="button"
              className="hvp-btn hvp-btn-secondary"
              disabled={yukleniyor}
              onClick={excelIndir}
            >
              Excel İndir
            </button>
            <button type="button" className="hvp-btn" disabled={yukleniyor} onClick={yukle}>
              Yenile
            </button>
          </div>
        </div>

        {hata && (
          <div className="alert-box red mb-16" style={{ marginBottom: 16 }}>
            {hata}
          </div>
        )}

        {yukleniyor ? (
          <div className="loading" style={{ padding: 40 }}>
            <div className="spinner" />
            <span>Yükleniyor…</span>
          </div>
        ) : (
          <div ref={printRef} className="hvp-print-root">
            <h1>TULİPİ COFFEE HAFTALIK VARDİYA</h1>
            <div className="hvp-print-meta">
              Hafta başı: {pzt}
              {payload?.hafta_bitis ? ` — Pazar: ${payload.hafta_bitis}` : ''}
            </div>

            {subeBloklari.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#666' }}>Bu hafta için kayıt yok.</p>
            ) : (
              subeBloklari.map(({ subeAd, satirlar }) => (
                <section key={subeAd}>
                  <div className="hvp-sube-baslik">{subeAd}</div>
                  <table className="hvp-table">
                    <thead>
                      <tr>
                        <th style={{ width: '14%' }}>Personel</th>
                        {GUN_KEYS.map((k) => (
                          <th key={k} style={{ width: '10.5%' }}>
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {satirlar.length === 0 ? (
                        <tr>
                          <td colSpan={8} style={{ color: '#888' }}>
                            Personel yok
                          </td>
                        </tr>
                      ) : (
                        satirlar.map((satir, i) => (
                          <tr key={`${subeAd}-${satir.isim || i}-${i}`}>
                            <td style={{ fontWeight: 600 }}>{satir.isim || '—'}</td>
                            {GUN_KEYS.map((k) => {
                              const v = satir[k] ?? '';
                              return (
                                <td key={k} className={hucreSinifi(v, subeAds)}>
                                  {v || ''}
                                </td>
                              );
                            })}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </section>
              ))
            )}

            <div className="hvp-legend no-print">
              <strong>Gösterim:</strong> İZİNLİ yeşil; saat aralığı nötr; şube adı (kaydırma)
              mor. Veri <code>?grup=1</code> JSON ile uyumludur.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
