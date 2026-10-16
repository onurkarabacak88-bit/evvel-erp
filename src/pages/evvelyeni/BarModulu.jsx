// ─────────────────────────────────────────────────────────────────────────────
// 🥤 EVVEL YENİ · BAR SAYIMI — açılış/kapanış bardak + bar ürün sayımı
//
// Ortak karar (sahip + Codex + Fable + Claude): sayım kalır, üstündeki motorlar gelmez.
// İki soru: "Gece bir şey eksildi mi?" (devir farkı) · "Ürün aç girilmemiş mi?" (net eksilme < 0).
// Net eksilme satış + fire + ikram birliktedir — KAYIP DENMEZ. Rakamlar /api/evvel-yeni/bar'dan.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, Cekmece, fmt, tUzun, tKisa } from './KasaModulu';

export const BAR_SAYFALAR = [
  { id: 'bar_sayim', ad: 'Bar sayımı', alt: 'Devir farkı · ürün aç eksik' },
];

const DURUM = {
  tamam: { renk: 'var(--pi-good)', ad: 'tuttu' },
  sorun: { renk: 'var(--pi-warn)', ad: 'fark var' },
  kapanis_yok: { renk: 'var(--pi-line)', ad: 'kapanış yok' },
  acilis_yok: { renk: 'var(--pi-line)', ad: 'açılış yok' },
};
const isaret = (x) => (x == null ? '—' : x > 0 ? `+${fmt(x)}` : fmt(x));

export default function BarModulu() {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ck, setCk] = useState(null);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/bar/ozet?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Bar sayımı okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Sayımlar okunuyor…</div></div>;

  const gunAc = (s, g) => setCk({
    tip: 'BAR SAYIMI', baslik: `${s.ad} · ${tUzun(g.gun)}`,
    alt: 'Devir: dün akşam sayılan + gece açılan = bu sabah olmalı. Net eksilme: sabah + gün içi açılan − akşam (satış + fire + ikram).',
    kpi: [{ etiket: '🌙 Akşam kapanışı yapan', deger: g.kapanisci ? `${g.kapanisci}${g.kapanis_saat ? ` · ${g.kapanis_saat}` : ''}` : '— kapanış yok', renk: g.kapanisci ? undefined : R.kirmizi },
      { etiket: '🌅 Sabah açılışı yapan', deger: g.acilisci ? `${g.acilisci}${g.acilis_saat ? ` · ${g.acilis_saat}` : ''}` : '— açılış yok' },
      ...(g.dun_kapanisci ? [{ etiket: 'Dün akşam sayan', deger: g.dun_kapanisci }] : []),
      { etiket: 'Durum', deger: DURUM[g.durum].ad }, { etiket: 'Devir tutmayan kalem', deger: String(g.devir_fark) }, { etiket: 'Ürün aç eksik kalem', deger: String(g.ac_eksik) }],
    not: g.durum === 'kapanis_yok' ? 'Akşam kapanış sayımı yok — net eksilme hesaplanamaz.' : g.durum === 'acilis_yok' ? 'Sabah açılış sayımı yok.' : null,
    varsayilan: 'iz',
    tablo: {
      ad: 'Kalem kalem',
      kolonlar: [{ ad: 'Kalem' }, { ad: 'Dün akşam', sag: true }, { ad: 'Gece açılan', sag: true }, { ad: 'Bu sabah', sag: true }, { ad: 'Devir farkı', sag: true },
        { ad: 'Gün içi açılan', sag: true }, { ad: 'Akşam', sag: true }, { ad: 'Net eksilme', sag: true }],
      satirlar: g.kalemler.map((k) => [k.ad, k.dun_kapanis ?? '—', k.gece_ac || '', k.acilis ?? 'sayılmadı',
        k.devir_fark ? { t: isaret(k.devir_fark), renk: k.devir_fark < 0 ? R.kirmizi : R.amber, kalin: true } : (k.devir_fark === 0 ? '0' : '—'),
        k.gun_ici_ac || '', k.kapanis ?? 'sayılmadı',
        k.net_eksilme == null ? '—' : k.net_eksilme < 0 ? { t: `${fmt(k.net_eksilme)} · ürün aç eksik?`, renk: R.kirmizi, kalin: true } : fmt(k.net_eksilme)]),
    },
  });

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Bar</div><h1 style={{ fontSize: 30 }}>Bar sayımı</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Ay
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
            style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        </label>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not} Kalemler: {v.kalemler.map((k) => k.ad).join(' · ')}.</div>

      {v.subeler.map((s) => (s.panel_yok ? (
        <div key={s.sube_id} style={{ ...kart, padding: '10px 14px', color: R.not, fontSize: 13 }}><b style={{ color: 'var(--pi-ink)' }}>{s.ad}</b> · panelde sayım / kapanış yapılmıyor — bu ekranın kapsamı dışında (ciro Gelir'de)</div>
      ) : (
        <div key={s.sube_id} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 16 }}>{s.ad}</b>
            <Cip tur="yesil">{s.ozet.tamam} gün tuttu</Cip>
            {s.ozet.devir_sorunlu_gun > 0 && <Cip tur="sari">{s.ozet.devir_sorunlu_gun} gün devir farkı</Cip>}
            {s.ozet.ac_eksik_gun > 0 && <Cip tur="kirmizi">{s.ozet.ac_eksik_gun} gün ürün aç eksik?</Cip>}
            {s.ozet.kapanis_yok > 0 && <Cip>{s.ozet.kapanis_yok} gün sayım yok</Cip>}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {s.gunler.map((g) => (
              <button key={g.gun} type="button" onClick={() => gunAc(s, g)} title={`${tUzun(g.gun)} · ${DURUM[g.durum].ad}`} style={{
                width: 42, padding: '5px 0', borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 11.5, lineHeight: 1.25,
                border: `2px solid ${DURUM[g.durum].renk}`, background: 'var(--pi-bg)', color: R.krem,
              }}>
                <b style={num}>{tKisa(g.gun).split(' ')[0]}</b><br /><span style={{ color: R.not }}>{['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'][new Date(`${g.gun}T12:00:00`).getDay()]}</span>
                {(g.devir_fark > 0 || g.ac_eksik > 0) && <><br /><span style={{ fontWeight: 700, color: g.ac_eksik ? R.kirmizi : R.amber }}>{g.devir_fark + g.ac_eksik}</span></>}
              </button>
            ))}
          </div>
        </div>
      )))}
      <div style={{ fontSize: 12, color: R.not }}>Kutunun çerçevesi: yeşil = tuttu · sarı = fark var · gri = sayım yok. Güne tıkla → kalem kalem.</div>
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}
