// ─────────────────────────────────────────────────────────────────────────────
// 📈 EVVEL YENİ · GELİR — "Hangi şube ne kadar kazandırdı?" (gelir tarafı)
//
// Sahip (2026-10-15): "Önce gelir mekanizmasını kuracağım, sonra gider mekanizmasını."
// · "Şubenin nakit işleri toplansa da aslında o şubenin parası, sadece bende duruyor."
// · "Bu ikisi (kasa ve gelir) ayrı ama sol alanda farklı isimlerde olmalı."
// Bütün rakamlar /api/evvel-yeni/gelir'den gelir; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, Cekmece, fmt, tl, tUzun, tKisa, gunAdi } from './KasaModulu';

export const GELIR_SAYFALAR = [
  { id: 'gelirler', ad: 'Gelirlerim', alt: 'Şube şube · gün gün satış' },
];

const KANAL_RENK = { nakit: 'var(--pi-good)', pos: 'var(--pi-accent)', online: 'var(--pi-warn)' };

function KanalCubugu({ nakit, pos, online }) {
  const t = nakit + pos + online;
  if (!t) return <div style={{ height: 8, borderRadius: 999, background: 'var(--pi-bg)' }} />;
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--pi-bg)' }} aria-hidden="true">
      {[['nakit', nakit], ['pos', pos], ['online', online]].map(([k, v]) => v > 0 && <span key={k} style={{ width: `${(v * 100) / t}%`, background: KANAL_RENK[k] }} />)}
    </div>
  );
}

function Lejant() {
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 12, color: R.metin2, flexWrap: 'wrap' }}>
      {[['nakit', 'Nakit'], ['pos', 'POS / kart'], ['online', 'Online']].map(([k, a]) => (
        <span key={k} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><i style={{ width: 10, height: 10, borderRadius: 3, background: KANAL_RENK[k], display: 'inline-block' }} />{a}</span>
      ))}
    </div>
  );
}

export default function GelirModulu() {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ck, setCk] = useState(null);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/gelir/ozet?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  const subeAc = (s) => setCk({
    tip: 'ŞUBE GELİRİ', baslik: `${s.ad} · ${tUzun(v.ay_basi).split(' ')[1]}`, alt: `${s.gun_sayisi} kapanış · günlük ortalama ${tl(s.gunluk_ort)}`,
    varsayilan: 'iz',
    kpi: [{ etiket: 'Toplam', deger: tl(s.toplam) }, { etiket: 'Nakit', deger: tl(s.nakit) }, { etiket: 'POS', deger: tl(s.pos) }, { etiket: 'Online', deger: tl(s.online) }],
    not: [s.eksik_gunler.length ? `🔴 Kapanışı girilmemiş ${s.eksik_gunler.length} gün: ${s.eksik_gunler.map(tKisa).join(', ')}` : null,
      s.onaysiz ? `🟡 ${s.onaysiz} kapanış henüz onaylanmadı` : null,
      s.ayrimsiz ? `${s.ayrimsiz} eski kapanışta POS/online ayrımı yok (tamamı POS sayıldı)` : null,
      s.tahmini_komisyon ? `Tahmini POS/online komisyonu: ${tl(s.tahmini_komisyon)} (gider tarafında kesinleşecek)` : null].filter(Boolean).join(' · ') || null,
    tablo: {
      ad: 'Gün gün',
      kolonlar: [{ ad: 'Gün' }, { ad: 'Gün adı' }, { ad: 'Nakit', sag: true }, { ad: 'POS', sag: true }, { ad: 'Online', sag: true }, { ad: 'Toplam', sag: true }, { ad: 'Durum' }],
      satirlar: s.gunler.map((g) => [tKisa(g.gun), gunAdi(g.gun), fmt(g.nakit), fmt(g.pos), fmt(g.online), { t: fmt(g.toplam), kalin: true },
        g.onay ? { t: 'onaylı', renk: R.yesil } : { t: 'onay bekliyor', renk: R.amber }]),
    },
  });

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Gelirler okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Gelirler okunuyor…</div></div>;

  const deg = v.degisim_yuzde;
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="pi-eyebrow">Evvel Yeni · Gelir</div>
          <h1 style={{ fontSize: 30 }}>Gelirlerim</h1>
        </div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Ay
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
            style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        </label>
      </div>

      {/* AY ÖZETİ */}
      <div style={{ ...kart, padding: '16px 20px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={etiketStil}>{tUzun(v.ay_basi).split(' ')[1]} cirosu{v.ay_bitti ? '' : ' · bugüne kadar'}</div>
          <div style={{ ...num, fontSize: 40, fontWeight: 700, color: R.bakirAcik, lineHeight: 1.05 }}>{tl(v.toplam)}</div>
          {deg != null && <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 4 }}>Geçen ayın aynı günlerine göre <b style={{ ...num, color: deg < 0 ? R.kirmizi : R.yesil }}>{deg > 0 ? '+' : ''}{fmt(deg)}%</b> ({fmt(v.gecen_ay_ayni_gunler)} ₺)</div>}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[['Nakit', v.nakit], ['POS / kart', v.pos], ['Online', v.online]].map(([a, t]) => (
            <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 17 }}>{fmt(t)}</div></div>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {v.eksik_gun_toplam > 0 ? <Cip tur="kirmizi">{v.eksik_gun_toplam} kapanış eksik</Cip> : <Cip tur="yesil">eksik gün yok</Cip>}
          {v.onaysiz_toplam > 0 && <Cip tur="sari">{v.onaysiz_toplam} onaysız</Cip>}
        </div>
      </div>

      {/* ŞUBE KARTLARI */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={etiketStil}>Şube şube</div><Lejant />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {v.subeler.map((s) => {
          const sv = s.eksik_gunler.length ? R.kirmizi : s.onaysiz ? R.amber : R.yesil;
          return (
            <button key={s.cep} type="button" onClick={() => subeAc(s)} style={{
              ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: R.krem, padding: '14px 16px',
              borderLeft: `5px solid ${sv}`, display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <span style={etiketStil}>Şube geliri</span>
              <b style={{ fontSize: 15 }}>{s.ad}</b>
              <span style={{ ...num, fontSize: 24, fontWeight: 700 }}>{tl(s.toplam)}</span>
              <KanalCubugu nakit={s.nakit} pos={s.pos} online={s.online} />
              <span style={{ fontSize: 12, color: R.metin2 }}>Nakit {fmt(s.nakit)} · POS {fmt(s.pos)} · Online {fmt(s.online)}</span>
              <span style={{ fontSize: 12, color: R.not }}>{s.gun_sayisi} gün · ortalama {fmt(s.gunluk_ort)} ₺/gün
                {s.degisim_yuzde != null && <> · <b style={{ color: s.degisim_yuzde < 0 ? R.kirmizi : R.yesil }}>{s.degisim_yuzde > 0 ? '+' : ''}{fmt(s.degisim_yuzde)}%</b></>}</span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {s.eksik_gunler.length > 0 && <Cip tur="kirmizi">{s.eksik_gunler.length} gün kapanış yok</Cip>}
                {s.onaysiz > 0 && <Cip tur="sari">{s.onaysiz} onaysız</Cip>}
                {!s.eksik_gunler.length && !s.onaysiz && <Cip tur="yesil">tam</Cip>}
                <span style={{ marginLeft: 'auto', color: 'var(--pi-accent)', fontWeight: 700 }}>›</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* GÜN × ŞUBE (Excel) */}
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--pi-line)' }}><b>Gün gün · tüm şubeler</b> <span style={{ color: R.not, fontSize: 12.5 }}>boş hücre = kapanış yok</span></div>
        <div style={{ overflowX: 'auto', maxHeight: 460 }}>
          <table className="pi-tablo pi-excel">
            <thead><tr><th>Gün</th>{v.subeler.map((s) => <th key={s.cep}>{s.ad}</th>)}<th>Toplam</th></tr></thead>
            <tbody>
              {v.matris.slice().reverse().map((m) => (
                <tr key={m.gun}>
                  <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(m.gun)} <span style={{ color: R.not }}>{gunAdi(m.gun).slice(0, 3)}</span></td>
                  {v.subeler.map((s) => {
                    const t = m.subeler[s.cep];
                    return <td key={s.cep} style={{ ...num, background: t == null ? 'var(--pi-bad-soft)' : undefined, color: t == null ? R.kirmizi : undefined }}>{t == null ? 'yok' : fmt(t)}</td>;
                  })}
                  <td style={{ ...num, fontWeight: 700 }}>{fmt(m.toplam)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* SATIŞ DIŞI */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <div style={{ ...kart, padding: 14 }}>
          <b>Satış dışı gelirler</b>
          {v.diger_gelirler.length ? v.diger_gelirler.map((x) => (
            <div key={x.ad} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 13 }}><span>{x.ad}</span><b style={num}>{fmt(x.tutar)}</b></div>
          )) : <div style={{ color: R.not, fontSize: 13, marginTop: 6 }}>Bu ay yok.</div>}
        </div>
        <div style={{ ...kart, padding: 14 }}>
          <b>Gelir sayılmayan girişler</b> <span style={{ color: R.not, fontSize: 12 }}>para girdi ama kazanç değil</span>
          {v.gelir_sayilmayanlar.length ? v.gelir_sayilmayanlar.map((x) => (
            <div key={x.ad} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 13 }}><span>{x.ad}</span><b style={num}>{fmt(x.tutar)}</b></div>
          )) : <div style={{ color: R.not, fontSize: 13, marginTop: 6 }}>Bu ay yok.</div>}
        </div>
      </div>
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}
