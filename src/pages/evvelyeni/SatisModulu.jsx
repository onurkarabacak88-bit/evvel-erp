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

// ── GÜNLÜK DÖKÜM — sahip: "bugün 14 adet 8oz vs. görmek istiyorum; kasada açık var mı, satıştan açık var mı; fire" ──
function GunlukDokum() {
  const [gun, setGun] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const no = useRef(0);
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/satis/gun?gun=${gun}`).then((r) => { if (n === no.current) { setV(r); setHata(null); } })
      .catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  }, [gun]);
  const kaydir = (k) => { const d = new Date(`${gun}T12:00:00`); d.setDate(d.getDate() + k); setGun(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); };
  const acikYaz = (x) => (x == null ? '—' : Math.abs(x) < 1 ? 'yok' : x > 0 ? `${fmt(Math.round(x))} ₺ AÇIK` : `${fmt(Math.round(-x))} ₺ fazla`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 18 }}>Günlük döküm</b>
        <Dugme kucuk onClick={() => kaydir(-1)}>‹</Dugme>
        <input type="date" value={gun} onChange={(e) => e.target.value && setGun(e.target.value)}
          style={{ font: 'inherit', padding: '5px 8px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        <Dugme kucuk onClick={() => kaydir(1)}>›</Dugme>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Döküm hazırlanıyor…</div>}
      {v && <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>}
      {v && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 12 }}>
        {v.subeler.map((s) => (
          <div key={s.sube_id} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ fontSize: 16 }}>{s.ad}</b>
              {s.durum === 'kapanis_yok' && <Cip>akşam sayımı yok</Cip>}{s.durum === 'acilis_yok' && <Cip>sabah sayımı yok</Cip>}</div>
            {s.durum !== 'kapanis_yok' && s.durum !== 'acilis_yok' ? (
              <>
                <div style={{ fontSize: 15 }}>Satılan: {s.kalemler.filter((k) => k.satilan).map((k) => <span key={k.kod} style={{ marginRight: 10, whiteSpace: 'nowrap' }}><b style={num}>{k.satilan}</b> {k.ad.replace(' bardak', '').replace(' (toplam)', '')}</span>)}
                  {!s.kalemler.some((k) => k.satilan) && <span style={{ color: R.not }}>—</span>}</div>
                <table className="pi-tablo pi-excel" style={{ fontSize: 12.5 }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>Kalem</th><th>Sabah</th><th>Giren</th><th>Akşam</th><th>Kullanılan</th><th>Fire</th><th>Satılan</th></tr></thead>
                  <tbody>{s.kalemler.map((k) => (
                    <tr key={k.kod}>
                      <td style={{ textAlign: 'left' }}>{k.ad}{k.devir_fark ? <span style={{ color: R.amber }} title="dün akşamdan bu sabaha fark"> · gece {k.devir_fark > 0 ? '+' : ''}{k.devir_fark}</span> : ''}</td>
                      <td style={num}>{k.sabah ?? '—'}</td><td style={num}>{k.giren || ''}</td><td style={num}>{k.aksam ?? '—'}</td>
                      <td style={{ ...num, color: k.kullanilan < 0 ? R.kirmizi : undefined }}>{k.kullanilan == null ? '—' : k.kullanilan < 0 ? `${k.kullanilan} (ürün aç eksik?)` : k.kullanilan}</td>
                      <td style={{ ...num, color: k.fire ? R.amber : undefined }}>{k.fire || ''}</td>
                      <td style={{ ...num, fontWeight: 700 }}>{k.satilan ?? '—'}</td>
                    </tr>))}</tbody>
                </table>
              </>
            ) : <div style={{ color: R.not, fontSize: 13 }}>Sabah ve akşam bar sayımı olmadan kalem dökümü çıkmaz.</div>}
            {s.fire.length > 0 && (
              <div style={{ fontSize: 12.5, background: 'var(--pi-bg)', borderRadius: 9, padding: '7px 10px' }}>
                <b>Fire ({s.fire_toplam})</b>
                {s.fire.map((f, i) => <div key={i}>{f.saat} · {f.adet} × {f.ad} — <b>{f.sebep}</b>{f.kim ? ` · ${f.kim}` : ''}{f.aciklama ? ` · ${f.aciklama}` : ''}</div>)}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
              <div style={{ background: 'var(--pi-bg)', borderRadius: 9, padding: '8px 10px' }}>
                <div style={{ color: R.not, fontSize: 11.5 }}>SATIŞTAN AÇIK</div>
                {s.ciro ? <>
                  <div>Girilen <b style={num}>{fmt(s.ciro.toplam)}</b> ₺ <span style={{ color: R.not }}>(nakit {fmt(s.ciro.nakit)} · POS {fmt(s.ciro.pos)}{s.ciro.online ? ` · online ${fmt(s.ciro.online)}` : ''})</span></div>
                  {s.beklenen_ciro != null
                    ? <div>Bardaktan beklenen ≈<b style={num}>{fmt(Math.round(s.beklenen_ciro))}</b> ₺ → <b style={{ color: s.satis_acik > 0 && s.satis_durum === 'bak' ? R.kirmizi : s.satis_acik > 0 ? R.amber : R.yesil }}>{acikYaz(s.satis_acik)}</b>
                      {s.guven === 'birikiyor' && <div style={{ color: R.not, fontSize: 11.5 }}>referans oluşuyor — yalnız bilgi</div>}</div>
                    : <div style={{ color: R.not }}>{s.satis_neden || 'hesaplanamadı'}</div>}
                </> : <div style={{ color: R.kirmizi }}>Kapanış cirosu yok</div>}
              </div>
              <div style={{ background: 'var(--pi-bg)', borderRadius: 9, padding: '8px 10px' }}>
                <div style={{ color: R.not, fontSize: 11.5 }}>KASA AÇIĞI (kör sayım)</div>
                {s.kasa ? (s.kasa.baslangic ? <div>Başlangıç sayımı · {fmt(s.kasa.sayilan)} ₺ sayıldı</div>
                  : <div>Defter {fmt(s.kasa.beklenen)} · sayılan {fmt(s.kasa.sayilan)} → <b style={{ color: Math.abs(s.kasa.fark) < 1 ? R.yesil : R.kirmizi }}>{acikYaz(s.kasa.fark)}</b></div>)
                  : <div style={{ color: R.not }}>Bu gün kör sayım yok (17 Ekim'den itibaren)</div>}
              </div>
            </div>
          </div>
        ))}
      </div>}
    </div>
  );
}

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
      <GunlukDokum />
      <b style={{ fontSize: 18, marginTop: 6 }}>Ay boyunca — bardak ↔ ciro uyumu</b>
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
