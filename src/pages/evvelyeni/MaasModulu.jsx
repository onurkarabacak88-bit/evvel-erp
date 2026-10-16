// ─────────────────────────────────────────────────────────────────────────────
// 👥 EVVEL YENİ · MAAŞLAR — kişi × çalışma ayı: hak ediş − avans − ödenen = kalan
//
// Ortak karar (sahip + Codex + Claude): tek hesap, tek ekran. Gider HAK EDİŞTEN yazılır (çalışma ayına,
// bir kez); maaş/avans ödemeleri yalnız kasadan düşer. Ekim eski sistemin hesabıyla kapanır, Kasım'dan yeni.
// Rakamlar /api/evvel-yeni/maas'tan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, fmt, tl } from './KasaModulu';

export const MAAS_SAYFALAR = [
  { id: 'maaslar', ad: 'Maaşlar', alt: 'Hak ediş · avans · kalan' },
];

const alan = { padding: '8px 10px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, width: 110 };
const gecenAy = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const sayi = (x) => { const t = String(x ?? '').trim().replace(/\s/g, ''); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? n : NaN; };

export default function MaasModulu({ onToast, onSekme }) {
  const [ay, setAy] = useState(gecenAy);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sec, setSec] = useState(null);     // açık satır (personel_id)
  const [d, setD] = useState({});           // elle alanlar
  const [mesgul, setMesgul] = useState(false);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/maas/liste?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Maaşlar okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Maaşlar hesaplanıyor…</div></div>;

  const r = sec && v.personel.find((x) => x.personel_id === sec);
  const ac = (x) => {
    setSec(x.personel_id);
    const e = x.elle || {};
    setD({ eksik_gun: e.eksik_gun ?? '', rapor_gun: e.rapor_gun ?? '', rapor_kesinti: !!e.rapor_kesinti, bayram_saat: e.bayram_saat ?? '',
      mesai_saat: e.mesai_saat ?? '', calisma_saat: e.calisma_saat ?? '', duzeltme: e.duzeltme || '', aciklama: e.aciklama || '' });
  };
  const kaydet = async () => {
    setMesgul(true);
    try {
      const body = { rapor_kesinti: d.rapor_kesinti, aciklama: d.aciklama || null };
      for (const k of ['eksik_gun', 'rapor_gun', 'bayram_saat', 'duzeltme']) { const n = sayi(d[k]); if (Number.isNaN(n)) throw new Error(`${k}: sayı yaz`); body[k] = n ?? 0; }
      for (const [k, don] of [['mesai_saat', 'mesai_oneriye_don'], ['calisma_saat', 'saat_oneriye_don']]) {
        const n = sayi(d[k]); if (Number.isNaN(n)) throw new Error(`${k}: sayı yaz`);
        if (n == null) body[don] = true; else body[k] = n;
      }
      const res = await api(`/evvel-yeni/maas/${encodeURIComponent(sec)}/${v.ay}`, { method: 'POST', body });
      onToast?.(res.mesaj); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  const onayla = async (kaldir) => {
    try { const res = await api(`/evvel-yeni/maas/${encodeURIComponent(sec)}/${v.ay}/onay${kaldir ? '?kaldir=true' : ''}`, { method: 'POST' }); onToast?.(res.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Olmadı'); }
  };
  const ode = (x) => {
    try { window.sessionStorage.setItem('ey_odeme_on', JSON.stringify({ konu: 'personel', personel_id: x.personel_id, personel_kalemi: 'Maaş', ait_ay: v.ay, tutar: x.oneri['Maaş'] })); } catch { /* yut */ }
    onSekme?.('odemeler');
  };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Maaşlar</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Çalışma ayı
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)} style={{ ...alan, width: 'auto' }} />
        </label>
      </div>

      <div style={{ ...kart, padding: '14px 18px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {[['Hak ediş', v.toplam.hak_edis], ['Avans mahsubu', v.toplam.avans_mahsup], ['Ödenen', v.toplam.odenen], ['Kalan', v.toplam.kalan]].map(([a, t], i) => (
          <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: i === 3 ? 28 : 18, fontWeight: 700, color: i === 3 ? R.kirmizi : R.krem }}>{fmt(t)}</div></div>
        ))}
        {v.eski_mod && <Cip tur="sari">Ekim: eski sistemin hesabı</Cip>}
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>

      <div style={{ ...kart, overflowX: 'auto' }}>
        <table className="pi-tablo pi-excel">
          <thead><tr><th style={{ textAlign: 'left' }}>Personel</th><th style={{ textAlign: 'left' }}>Şube</th><th>Gün</th><th>Hak ediş</th><th>Avans</th><th>Ödenen</th><th>Kalan</th><th style={{ textAlign: 'left' }}>Durum</th><th /></tr></thead>
          <tbody>
            {v.personel.map((x) => (
              <tr key={x.personel_id} onClick={() => ac(x)} style={{ cursor: 'pointer', opacity: x.aktif ? 1 : 0.65 }}>
                <td style={{ textAlign: 'left' }}><b>{x.ad}</b> <span style={{ color: R.not, fontSize: 12 }}>{x.calisma_turu === 'yari' ? 'yarı' : ''}{x.aktif ? '' : ' · ayrıldı'}</span></td>
                <td style={{ textAlign: 'left' }}>{x.sube_ad}</td>
                <td style={num}>{x.gun ?? '—'}</td>
                <td style={num}>{fmt(x.hak_edis)}</td>
                <td style={num}>{x.avans_mahsup ? `−${fmt(x.avans_mahsup)}` : ''}</td>
                <td style={num}>{x.odenen ? `−${fmt(x.odenen)}` : ''}</td>
                <td style={{ ...num, fontWeight: 700, color: x.kalan > 0 ? R.kirmizi : R.yesil }}>{fmt(x.kalan)}</td>
                <td style={{ textAlign: 'left' }}>
                  {x.onay ? <Cip tur="yesil">onaylı</Cip> : x.kaynak === 'eski_sistem' ? <Cip tur="sari">eski hesap</Cip> : x.ay_acik ? <Cip>ay sürüyor</Cip> : <Cip>onay bekliyor</Cip>}
                  {(x.uyari || []).length > 0 && <Cip tur="kirmizi">⚠ {x.uyari.length}</Cip>}
                  {x.avans_devir_sonraki > 0 && <Cip tur="sari">devir {fmt(x.avans_devir_sonraki)}</Cip>}
                </td>
                <td>{x.kalan > 0 && <Dugme kucuk onClick={(e) => { e?.stopPropagation?.(); ode(x); }}>Öde</Dugme>}</td>
              </tr>
            ))}
            {!v.personel.length && <tr><td colSpan={9} style={{ textAlign: 'center', color: R.not }}>Bu ay için personel yok.</td></tr>}
          </tbody>
        </table>
      </div>

      {r && (
        <div role="dialog" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 }} onClick={() => setSec(null)}>
          <div style={{ ...kart, padding: 18, width: 'min(640px, 100%)', maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <b style={{ fontSize: 18 }}>{r.ad}</b><span style={{ color: R.not }}>{r.sube_ad} · {v.ay} · {r.calisma_turu === 'yari' ? 'yarı zamanlı' : 'tam zamanlı'}</span>
              <span style={{ marginLeft: 'auto' }}><Dugme kucuk onClick={() => setSec(null)}>Kapat</Dugme></span>
            </div>
            {(r.uyari || []).map((u) => <div key={u} style={{ color: R.kirmizi, fontWeight: 600 }}>⚠ {u}</div>)}
            <div>
              {r.kalemler.map((k) => (
                <div key={k.kod + k.ad} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 14 }}>
                  <span>{k.ad}</span><b style={{ ...num, color: k.tutar < 0 ? R.kirmizi : R.krem }}>{fmt(k.tutar)}</b>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontWeight: 700 }}><span>Hak ediş</span><span style={num}>{tl(r.hak_edis)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>− Avans mahsubu{r.avans_devir_onceki ? ` (önceki aydan devreden ${fmt(r.avans_devir_onceki)} dahil)` : ''}</span><span style={num}>{fmt(r.avans_mahsup)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}><span>− Ödenen ({Object.entries(r.odeme_kalemleri).filter(([k]) => k !== 'Avans').map(([k, t]) => `${k} ${fmt(t)}`).join(', ') || 'yok'})</span><span style={num}>{fmt(r.odenen)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontWeight: 800, fontSize: 17 }}><span>Kalan</span><span style={{ ...num, color: r.kalan > 0 ? R.kirmizi : R.yesil }}>{tl(r.kalan)}</span></div>
              {r.avans_devir_sonraki > 0 && <div style={{ fontSize: 13, color: R.amber }}>Avans hak edişi aştı: {fmt(r.avans_devir_sonraki)} ₺ sonraki aya devreder.</div>}
            </div>

            {r.kaynak === 'evvel_yeni' && !r.onay && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--pi-line)', paddingTop: 10 }}>
                <b style={{ fontSize: 14 }}>Bu aya özel (elle)</b>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', fontSize: 13 }}>
                  {r.calisma_turu === 'yari'
                    ? <label>Çalışma saati<br /><input style={alan} placeholder="vardiyadan" value={d.calisma_saat} onChange={(e) => setD((x) => ({ ...x, calisma_saat: e.target.value }))} /></label>
                    : <>
                      <label>Eksik gün<br /><input style={alan} value={d.eksik_gun} onChange={(e) => setD((x) => ({ ...x, eksik_gun: e.target.value }))} /></label>
                      <label>Raporlu gün<br /><input style={alan} value={d.rapor_gun} onChange={(e) => setD((x) => ({ ...x, rapor_gun: e.target.value }))} /></label>
                      <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={d.rapor_kesinti} onChange={(e) => setD((x) => ({ ...x, rapor_kesinti: e.target.checked }))} />rapor kesilsin</label>
                      <label>Fazla mesai saati<br /><input style={alan} placeholder="vardiyadan" value={d.mesai_saat} onChange={(e) => setD((x) => ({ ...x, mesai_saat: e.target.value }))} /></label>
                    </>}
                  <label>Bayram saati<br /><input style={alan} value={d.bayram_saat} onChange={(e) => setD((x) => ({ ...x, bayram_saat: e.target.value }))} /></label>
                  <label>Düzeltme ₺ (±)<br /><input style={alan} value={d.duzeltme} onChange={(e) => setD((x) => ({ ...x, duzeltme: e.target.value }))} /></label>
                  <label style={{ flex: 1, minWidth: 180 }}>Gerekçe<br /><input style={{ ...alan, width: '100%' }} value={d.aciklama} onChange={(e) => setD((x) => ({ ...x, aciklama: e.target.value }))} /></label>
                </div>
                <div style={{ fontSize: 12, color: R.not }}>"vardiyadan" yazan kutular boş bırakılırsa şube panelinin vardiya planı kullanılır.</div>
                <div style={{ display: 'flex', gap: 8 }}><Dugme onClick={kaydet} disabled={mesgul}>Kaydet</Dugme>
                  {!r.ay_acik && <Dugme ana onClick={() => onayla(false)}>Ayı onayla (dondur)</Dugme>}</div>
              </div>
            )}
            {r.onay && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Cip tur="yesil">Onaylı — kalemler donduruldu</Cip><Dugme kucuk onClick={() => onayla(true)}>Onayı kaldır</Dugme></div>}
            {r.kalan > 0 && <div><Dugme ana onClick={() => ode(r)}>Kalanı öde ({fmt(r.oneri['Maaş'])} ₺ maaş)</Dugme></div>}
          </div>
        </div>
      )}
    </div>
  );
}
