// ─────────────────────────────────────────────────────────────────────────────
// 🔍 EVVEL YENİ · SATIŞ KONTROLÜ — "bu kadar bardak gittiyse kasaya şu kadar girmeliydi"
//
// Sahip: "Ürün aç mantığından satışları ve kasada farkı hesaplatıyorduk — bununla ilgili alan kur."
// Codex: sayım–ciro UYUMUNU izler; satış adedi ya da kayıp para ölçümü DEĞİL. Medyan + yayılım + TL tabanı;
// 14 temiz gün birikmeden uyarı yok. Kör kasa farkı yan yana — toplanmaz. Kimseye suç yazılmaz.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt, tKisa } from './KasaModulu';

export const SATIS_SAYFALAR = [
  { id: 'satis_kontrol', ad: 'Satış kontrolü', alt: 'Bardak ↔ ciro · kör kasa' },
];

const DURUM = {
  bak: { tur: 'sari', ad: 'İncele' },
  normal: { tur: 'yesil', ad: 'Uyumlu' },
  birikiyor: { tur: undefined, ad: 'Referans oluşuyor' },
  hesaplanmadi: { tur: undefined, ad: 'Veri eksik' },
};

export default function SatisModulu() {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [hepsi, setHepsi] = useState(false);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/satis/kontrol?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Satış kontrolü okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Hesaplanıyor… (bar sayımı + kapanışlar)</div></div>;

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Kontrol</div><h1 style={{ fontSize: 30 }}>Satış kontrolü</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={hepsi} onChange={(e) => setHepsi(e.target.checked)} />veri eksik günleri de göster
        </label>
        <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
          style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>

      {v.subeler.map((s) => {
        const gun = s.gunler.filter((g) => hepsi || g.durum !== 'hesaplanmadi');
        return (
          <div key={s.sube_id} style={{ ...kart, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid var(--pi-line)' }}>
              <b style={{ fontSize: 16 }}>{s.ad}</b>
              {s.ozet.bak > 0 && <Cip tur="sari">{s.ozet.bak} gün incele</Cip>}
              {s.ozet.normal > 0 && <Cip tur="yesil">{s.ozet.normal} gün uyumlu</Cip>}
              {s.ozet.birikiyor > 0 && <Cip>{s.ozet.birikiyor} gün referans oluşuyor</Cip>}
              <Cip>{s.ozet.hesaplanmadi} gün veri eksik</Cip>
              <span style={{ marginLeft: 'auto', fontSize: 12.5, color: R.not }}>temiz gün: {s.temiz_gun} / {v.kural.gecici_gun} gerekli (tam güven {v.kural.tam_gun})</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="pi-tablo pi-excel">
                <thead><tr><th>Gün</th><th>Bardak</th><th>₺/bardak</th><th>Beklenen</th><th>Girilen ciro</th><th>Sapma</th><th>Kör kasa</th><th style={{ textAlign: 'left' }}>Durum</th></tr></thead>
                <tbody>
                  {gun.map((g) => (
                    <tr key={g.gun}>
                      <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(g.gun)}</td>
                      <td style={num} title={Object.entries(g.bardak_kalem || {}).map(([k, x]) => `${k}: ${x ?? '—'}`).join(' · ')}>{g.bardak || '—'}</td>
                      <td style={num}>{g.oran ? fmt(Math.round(g.oran)) : '—'}</td>
                      <td style={num} title={g.aralik_alt ? `alt sınır ${fmt(g.aralik_alt)} ₺` : ''}>{g.beklenen ? `≈${fmt(Math.round(g.beklenen))}` : '—'}</td>
                      <td style={num}>{g.ciro != null ? fmt(g.ciro) : '—'}</td>
                      <td style={{ ...num, fontWeight: 700, color: g.sapma == null ? R.not : g.sapma < 0 ? (g.durum === 'bak' ? R.kirmizi : R.amber) : R.yesil }}>{g.sapma == null ? '—' : `${g.sapma > 0 ? '+' : ''}${fmt(g.sapma)}%`}</td>
                      <td style={num}>{g.kasa_fark == null ? '—' : g.kasa_baslangic ? 'başlangıç' : g.kasa_fark === 0 ? 'tuttu' : `${g.kasa_fark > 0 ? 'eksik ' : 'fazla '}${fmt(Math.abs(g.kasa_fark))}`}</td>
                      <td style={{ textAlign: 'left', fontSize: 12.5 }}><Cip tur={DURUM[g.durum].tur}>{DURUM[g.durum].ad}</Cip>{g.neden && <span style={{ color: R.not }}> {g.neden}</span>}
                        {g.durum === 'bak' && <span> · {g.bardak} bardak; ≈{fmt(Math.round(g.beklenen))} ₺ beklenirdi, {fmt(g.ciro)} ₺ girildi</span>}</td>
                    </tr>
                  ))}
                  {!gun.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: R.not }}>Hesaplanabilen gün yok — "veri eksik günleri de göster" ile sebeplerini gör.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
