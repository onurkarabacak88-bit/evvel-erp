// ─────────────────────────────────────────────────────────────────────────────
// 📈 EVVEL YENİ · ŞUBE KAZANCI — gelir − şubenin KENDİ gideri; kim kimi taşıyor
//
// Sahip (2026-10-15): "Para şubenin ama bende duruyor." · "Şubeler sanki hiç borcu yokmuş
// gibi." · "Zarar eden şubenin yükü hangi kâr eden şubenin üstünde, bunu anlamalıyım."
// Bütün rakamlar /api/evvel-yeni/kazanc'tan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, Cekmece, fmt, tl, tUzun } from './KasaModulu';
import { ayTR } from '../../utils/trTarih';

export const KAZANC_SAYFALAR = [
  { id: 'kazanc', ad: 'Şube kazancı', alt: 'Gelir − gider · kim kimi taşıyor' },
];

export default function KazancModulu() {
  const [ay, setAy] = useState(ayTR);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ck, setCk] = useState(null);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/kazanc/ozet?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Kazanç okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Kazanç hesaplanıyor…</div></div>;

  const ayAd = tUzun(v.ay_basi).split(' ')[1];
  const renk = (x) => (x >= 0 ? R.yesil : R.kirmizi);
  const enBuyuk = Math.max(1, ...v.subeler.map((s) => Math.max(s.gelir, s.gider)));

  const ac = (s) => setCk({
    tip: 'ŞUBE KAZANCI', baslik: `${s.ad} · ${ayAd}`,
    alt: 'Gelir − şubenin kendi gideri. Kredi, ev taksiti, patron şahsi dahil değil.',
    kpi: [{ etiket: 'Kazanç', deger: tl(s.kazanc), renk: renk(s.kazanc) }, { etiket: 'Gelir', deger: tl(s.gelir) }, { etiket: 'Gider', deger: tl(s.gider) },
      ...(s.tasidigi_yuk ? [{ etiket: 'Taşıdığı yük', deger: tl(s.tasidigi_yuk) }, { etiket: 'Yükten sonra', deger: tl(s.yuk_sonrasi), renk: renk(s.yuk_sonrasi) }] : [])],
    not: s.uyarilar.length ? '⚠ ' + s.uyarilar.join(' · ') : null,
    listeBaslik: 'Kalem kalem',
    satirlar: [
      { ad: 'Gelir · nakit', tutar: tl(s.gelir_kirilim.nakit) }, { ad: 'Gelir · POS', tutar: tl(s.gelir_kirilim.pos) }, { ad: 'Gelir · online', tutar: tl(s.gelir_kirilim.online) },
      ...Object.entries(s.gider_kirilim).filter(([, t]) => t).map(([k, t]) => ({ ad: `Gider · ${v.turler[k] || k}`, tutar: `− ${tl(t)}` })),
      ...s.tasidiklari.map((x) => ({ ad: `Taşıdığı · ${x.ad}`, tutar: `− ${tl(x.tutar)}`, detay: 'kârı oranında payına düşen' })),
    ],
  });

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Kazanç</div><h1 style={{ fontSize: 30 }}>Şube kazancı</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Ay
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
            style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        </label>
      </div>

      <div style={{ ...kart, padding: '16px 20px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={etiketStil}>{ayAd} işletme kazancı{v.ay_bitti ? '' : ' · bugüne kadar'}</div>
          <div style={{ ...num, fontSize: 40, fontWeight: 700, color: renk(v.isletme_kazanci), lineHeight: 1.05 }}>{tl(v.isletme_kazanci)}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[['Gelir', v.gelir], ['Şube giderleri', -v.sube_gideri], ['Ortak giderler', -v.ortak_gider]].map(([a, t]) => (
            <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 17 }}>{fmt(t)}</div></div>
          ))}
        </div>
        {v.cekis_toplam > 0 && <div style={{ marginLeft: 'auto', fontSize: 12.5, color: R.not }}>Patron çekişi {fmt(v.cekis_toplam)} ₺ (kazançtan ayrı)</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {v.subeler.map((s) => (
          <button key={s.cep} type="button" onClick={() => ac(s)} style={{
            ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: R.krem, padding: '14px 16px',
            borderLeft: `5px solid ${renk(s.kazanc)}`, display: 'flex', flexDirection: 'column', gap: 7,
          }}>
            <span style={etiketStil}>{s.kazanc >= 0 ? 'Kâr ediyor' : 'Zarar ediyor'}</span>
            <b style={{ fontSize: 15 }}>{s.ad}</b>
            <span style={{ ...num, fontSize: 26, fontWeight: 700, color: renk(s.kazanc) }}>{tl(s.kazanc)}</span>
            {[['Gelir', s.gelir, 'var(--pi-good)'], ['Gider', s.gider, 'var(--pi-bad)']].map(([a, t, c]) => (
              <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 38, color: R.metin2 }}>{a}</span>
                <span style={{ flex: 1, height: 8, background: 'var(--pi-bg)', borderRadius: 999, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${(t * 100) / enBuyuk}%`, background: c }} /></span>
                <span style={{ ...num, width: 70, textAlign: 'right' }}>{fmt(t)}</span>
              </div>
            ))}
            {s.tasidigi_yuk > 0 && <span style={{ fontSize: 12.5 }}>🏋️ Taşıdığı yük <b style={num}>{fmt(s.tasidigi_yuk)}</b> → kalan <b style={{ ...num, color: renk(s.yuk_sonrasi) }}>{fmt(s.yuk_sonrasi)}</b></span>}
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {s.marj_yuzde != null && <Cip>marj %{s.marj_yuzde}</Cip>}
              {s.uyarilar.length > 0 && <Cip tur="sari">{s.uyarilar.length} eksik</Cip>}
              <span style={{ marginLeft: 'auto', color: 'var(--pi-accent)', fontWeight: 700 }}>›</span>
            </span>
          </button>
        ))}
      </div>

      {v.zarar_eden_acigi + v.ortak_gider > 0 && (
        <div style={{ ...kart, padding: 14 }}>
          <b>Kim kimi taşıyor?</b> <span style={{ color: R.not, fontSize: 12.5 }}>zarar eden şubelerin açığı + ortak giderler, kâr edenlerin kârı oranında</span>
          {v.subeler.filter((s) => s.tasidiklari.length).map((s) => (
            <div key={s.cep} style={{ padding: '8px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 13.5 }}>
              <b>{s.ad}</b> taşıyor: {s.tasidiklari.map((x) => `${x.ad} ${fmt(x.tutar)} ₺`).join(' · ')}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}
