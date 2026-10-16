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

// Sahip: "Beklenen satışı AYRI sekme yap; ilk alanda KESİN veriler (satılan, fire, kasa açığı) olsun."
export const SATIS_SAYFALAR = [
  { id: 'satis_kontrol', ad: 'Satış kontrolü', alt: 'Satılan · fire · kasa açığı' },
  { id: 'satis_beklenen', ad: 'Beklenen satış', alt: 'Bardaktan tahmini ciro' },
  { id: 'devir_defteri', ad: 'Kasa devir defteri', alt: 'Kim saydı · kime devretti' },
];

const DURUM = {
  bak: { tur: 'sari', ad: 'İncele' },
  normal: { tur: 'yesil', ad: 'Uyumlu' },
  birikiyor: { tur: undefined, ad: 'Referans oluşuyor' },
  hesaplanmadi: { tur: undefined, ad: 'Veri eksik' },
};

// ── 💵 KASA AÇIĞI — eski Evvel'in kapanış mutabakatı (sahip: "parasal açığı görmemiz lazım, Evvel bunu hesaplıyordu") ──
function KasaAcigi({ m, ciro, teslimler = [] }) {
  const satir = (ad, t, isaret, alt) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
      <span>{isaret} {ad}{alt && <span style={{ color: R.not, fontSize: 11.5 }}> · {alt}</span>}</span><b style={num}>{t == null ? '—' : fmt(t)}</b>
    </div>
  );
  if (!m) return <div style={{ background: 'var(--pi-bg)', borderRadius: 9, padding: '9px 11px', color: R.not, fontSize: 13 }}>💵 Kasa açığı: bu gün panelde açılış/kapanış kaydı yok.</div>;
  const f = m.fark;
  const renk = f == null ? R.not : Math.abs(f) < 1 ? R.yesil : f > 0 ? R.kirmizi : R.amber;
  return (
    <div style={{ background: 'var(--pi-bg)', borderRadius: 9, padding: '9px 11px', fontSize: 13, borderLeft: `4px solid ${renk}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <b style={{ fontSize: 13.5 }}>💵 KASA AÇIĞI</b>
        <b style={{ ...num, fontSize: 17, color: renk }}>{f == null ? (m.eksik || 'hesaplanamadı') : Math.abs(f) < 1 ? 'TUTTU ✓' : f > 0 ? `${fmt(f)} ₺ AÇIK` : `${fmt(-f)} ₺ FAZLA`}</b>
      </div>
      {satir('Sabah kasada sayılan', m.acilis, '')}
      {satir('Girilen nakit satış', m.z_nakit, '+', ciro ? `toplam ciro ${fmt(ciro.toplam)} (POS ${fmt(ciro.pos)})` : null)}
      {satir('Nakit giderler', m.gider_toplam, '−', m.giderler.length ? m.giderler.map((g) => `${g.ad} ${fmt(g.tutar)}${g.bekliyor ? ' (onay bekliyor)' : ''}`).join(', ') : null)}
      {m.ara_toplam > 0 && satir('Ara teslim', m.ara_toplam, '−', m.ara_teslimler.map((t) => `${t.alan || '?'} ${fmt(t.tutar)}`).join(', '))}
      {satir('Gün sonu teslim', m.teslim, '−')}
      {satir('Kasada bırakılan (devir)', m.devir, '−')}
      <div style={{ borderTop: '1px solid var(--pi-line)', marginTop: 4, paddingTop: 4, color: R.metin2, fontSize: 12 }}>
        <div>Sağlama · sabah: {m.sabah_fark == null ? 'dünkü devir yok' : Math.abs(m.sabah_fark) < 1 ? `dün bırakılan ${fmt(m.dun_devir)} = bu sabah sayılan ✓` : <span style={{ color: R.kirmizi }}>dün bırakılan {fmt(m.dun_devir)} · bu sabah {fmt(m.acilis)} → {m.sabah_fark > 0 ? '+' : ''}{fmt(m.sabah_fark)}</span>}</div>
        <div>Sağlama · akşam: {m.kor_belirsiz ? <span style={{ color: R.amber }}>sayım teslimden SONRA yapılmış ({fmt(m.kor_sayim)} = bırakılan) — sağlama yapılamadı</span>
          : m.kor_fark == null ? '—' : Math.abs(m.kor_fark) < 1 ? `sayılan ${fmt(m.kor_sayim)} − teslim = bırakılan ${fmt(m.devir)} ✓`
          : <span style={{ color: R.kirmizi }}>sayılan {fmt(m.kor_sayim)} − teslim {fmt((m.teslim || 0) + (m.ara_toplam || 0))} = {fmt(m.kor_kalan)} · bırakılan {fmt(m.devir)} → {m.kor_fark > 0 ? '+' : ''}{fmt(m.kor_fark)}</span>}</div>
        {/* Sahip: "teslim ihtimali varsa para teslimi yapılmış mı ona da baksın" */}
        {((m.teslim || 0) + (m.ara_toplam || 0) > 0 || teslimler.length > 0) && (
          <div>Sağlama · teslim: {teslimler.length === 0
            ? ((m.panel_teslimleri || []).length > 0
              ? <span style={{ color: R.amber }}>panelde {m.panel_teslimleri.map((t) => `${fmt(t.tutar)} → ${t.alan || '?'}`).join(', ')} var — Kasa'ya henüz aktarılmadı (≤10 dk) ya da alıcı Onur/Fethi/Fatma ile eşleşmedi</span>
              : <span style={{ color: R.kirmizi }}>kasiyer {fmt((m.teslim || 0) + (m.ara_toplam || 0))} ₺ teslim yazdı ama hiçbir teslim kaydı YOK</span>)
            : teslimler.map((t, i) => (
              <span key={i} style={{ marginRight: 8 }}>{fmt(t.tutar)} ₺ → {t.alan}: {t.durum === 'bekliyor'
                ? <span style={{ color: R.amber }}>henüz alınmadı</span>
                : t.otomatik ? <span style={{ color: R.amber }}>otomatik kabul (kimse saymadı)</span>
                  : Math.abs(t.fark || 0) < 1 ? <span style={{ color: R.yesil }}>aldı, saydı ✓</span>
                    : <span style={{ color: R.kirmizi }}>aldı, {fmt(t.alinan)} saydı → {fmt(t.fark)} eksik</span>}</span>))}
            {teslimler.length > 0 && Math.abs(teslimler.reduce((a, t) => a + t.tutar, 0) - ((m.teslim || 0) + (m.ara_toplam || 0))) >= 1 &&
              <span style={{ color: R.kirmizi }}> · kasiyerin yazdığı {fmt((m.teslim || 0) + (m.ara_toplam || 0))} ≠ Kasa'daki {fmt(teslimler.reduce((a, t) => a + t.tutar, 0))}</span>}
          </div>
        )}
        {m.vardiya.length > 0 && <div>Vardiya devri: {m.vardiya.map((v) => `${v.saat || ''} ${v.sayilan == null ? '' : `${fmt(v.sayilan)} ₺ sayıldı`}`).join(' · ')}</div>}
      </div>
    </div>
  );
}

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
      {v && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 460px), 1fr))', gap: 12 }}>
        {v.subeler.map((s) => (
          <div key={s.sube_id} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ fontSize: 16 }}>{s.ad}</b>
              {s.durum === 'kapanis_yok' && <Cip>akşam sayımı yok</Cip>}{s.durum === 'acilis_yok' && <Cip>sabah sayımı yok</Cip>}</div>
            {s.durum !== 'kapanis_yok' && s.durum !== 'acilis_yok' ? (
              <>
                {/* Sahip: "satılan yazısı daha belirgin olsun" — büyük rakamlı kutucuklar */}
                <div style={{ background: 'var(--pi-accent-soft)', borderRadius: 11, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', color: R.metin2, marginBottom: 6 }}>BUGÜN SATILAN</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {s.kalemler.filter((k) => k.satilan > 0).map((k) => (
                      <div key={k.kod} style={{ background: 'var(--pi-paper)', border: '1px solid var(--pi-line)', borderRadius: 10, padding: '6px 10px', textAlign: 'center', minWidth: 62 }}>
                        <div style={{ ...num, fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: 'var(--pi-accent)' }}>{k.satilan}</div>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{k.ad.replace(' bardak', '').replace(' (toplam)', '')}</div>
                      </div>
                    ))}
                    {!s.kalemler.some((k) => k.satilan > 0) && <span style={{ color: R.not }}>—</span>}
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}><table className="pi-tablo pi-excel" style={{ fontSize: 12.5, minWidth: 420 }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>Kalem</th><th>Sabah</th><th>Giren</th><th>Akşam</th><th>Kullanılan</th><th>Fire</th><th>Satılan</th></tr></thead>
                  <tbody>{s.kalemler.map((k) => (
                    <tr key={k.kod}>
                      <td style={{ textAlign: 'left' }}>{k.ad}{k.devir_fark ? <span style={{ color: R.amber }} title="dün akşamdan bu sabaha fark"> · gece {k.devir_fark > 0 ? '+' : ''}{k.devir_fark}</span> : ''}</td>
                      <td style={num}>{k.sabah ?? '—'}</td><td style={num}>{k.giren || ''}</td><td style={num}>{k.aksam ?? '—'}</td>
                      <td style={{ ...num, color: k.kullanilan < 0 ? R.kirmizi : undefined }}>{k.kullanilan == null ? '—' : k.kullanilan < 0 ? `${k.kullanilan} (ürün aç eksik?)` : k.kullanilan}</td>
                      <td style={{ ...num, color: k.fire ? R.amber : undefined }}>{k.fire || ''}</td>
                      <td style={{ ...num, fontWeight: 700 }}>{k.satilan ?? '—'}</td>
                    </tr>))}</tbody>
                </table></div>
              </>
            ) : <div style={{ color: R.not, fontSize: 13 }}>Sabah ve akşam bar sayımı olmadan kalem dökümü çıkmaz.</div>}
            {s.fire.length > 0 && (
              <div style={{ fontSize: 12.5, background: 'var(--pi-bg)', borderRadius: 9, padding: '7px 10px' }}>
                <b>Fire ({s.fire_toplam})</b>
                {s.fire.map((f, i) => <div key={i}>{f.saat} · {f.adet} × {f.ad} — <b>{f.sebep}</b>{f.kim ? ` · ${f.kim}` : ''}{f.aciklama ? ` · ${f.aciklama}` : ''}</div>)}
              </div>
            )}
            <KasaAcigi m={s.kasa_mutabakat} ciro={s.ciro} teslimler={s.teslimler} />
          </div>
        ))}
      </div>}
    </div>
  );
}

export default function SatisModulu({ gorunum }) {
  if (gorunum === 'devir_defteri') return <DevirDefteri />;
  if (gorunum !== 'satis_beklenen') {
    return (
      <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <style>{PI_CSS}</style>
        <div><div className="pi-eyebrow">Evvel Yeni · Kontrol</div><h1 style={{ fontSize: 30 }}>Satış kontrolü</h1></div>
        <GunlukDokum />
      </div>
    );
  }
  return <BeklenenSatis />;
}

function BeklenenSatis() {
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
        <div><div className="pi-eyebrow">Evvel Yeni · Tahmin</div><h1 style={{ fontSize: 30 }}>Beklenen satış</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={hepsi} onChange={(e) => setHepsi(e.target.checked)} />veri eksik günleri de göster
        </label>
        <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
          style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
      </div>
      <div style={{ fontSize: 13.5 }}>Bardaktan <b>tahmini</b> ciro ile girilen ciro — kesin değil, uyum izleme. Kesin rakamlar <b>Satış kontrolü</b> sekmesinde.</div>
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

// ── 🔁 KASA DEVİR DEFTERİ — sahip: "açılış ve kapanış sayımlarını, devrin kimden kime yapıldığını takip etmek" ──
export function DevirDefteri() {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sube, setSube] = useState(null);
  const no = useRef(0);
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/satis/devir-defteri?ay=${ay}`).then((r) => { if (n === no.current) { setV(r); setHata(null); setSube((x) => x || r.subeler.find((s) => s.ozet.tutan + s.ozet.kopuk > 0)?.sube_id || r.subeler[0]?.sube_id); } })
      .catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  }, [ay]);
  const s = v && v.subeler.find((x) => x.sube_id === sube);
  const tut = (x) => (x == null ? '—' : fmt(x));
  const fark = (x) => (x == null ? null : Math.abs(x) < 1 ? <span style={{ color: R.yesil }}> ✓</span> : <span style={{ color: R.kirmizi, fontWeight: 700 }}> {x > 0 ? '+' : ''}{fmt(x)}</span>);
  const hucre = { padding: '7px 9px', verticalAlign: 'top', borderTop: '1px solid var(--pi-line)', fontSize: 12.5 };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Kontrol</div><h1 style={{ fontSize: 30 }}>Kasa devir defteri</h1></div>
        <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
          style={{ marginLeft: 'auto', font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Defter hazırlanıyor…</div>}
      {v && <>
        <div style={{ fontSize: 12.5, color: R.not }}>{v.not} Kasiyer bu ekranı görmez.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {v.subeler.map((x) => (
            <button key={x.sube_id} type="button" onClick={() => setSube(x.sube_id)} style={{
              font: 'inherit', fontWeight: 700, padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${sube === x.sube_id ? 'var(--pi-accent)' : 'var(--pi-line)'}`, background: sube === x.sube_id ? 'var(--pi-accent)' : 'var(--pi-paper)', color: sube === x.sube_id ? 'var(--pi-on-accent)' : R.krem,
            }}>{x.ad} <span style={{ fontWeight: 400, fontSize: 12 }}>✓{x.ozet.tutan}{x.ozet.kopuk ? ` · ✗${x.ozet.kopuk}` : ''}</span></button>
          ))}
        </div>
        {s && (
          <div style={{ ...kart, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
              <thead><tr style={{ textAlign: 'left', fontSize: 12, color: R.metin2 }}>
                <th style={hucre}>Gün</th><th style={hucre}>🌅 Sabah sayımı</th><th style={hucre}>🔁 Vardiya devri</th><th style={hucre}>🌙 Akşam kapanış</th><th style={hucre}>➡️ Ertesi sabah</th><th style={hucre}>Zincir</th>
              </tr></thead>
              <tbody>{s.gunler.map((g) => (
                <tr key={g.gun} style={{ background: g.zincir_fark != null && !g.zincir_tutuyor ? 'rgba(192,58,43,.06)' : undefined }}>
                  <td style={{ ...hucre, ...num, whiteSpace: 'nowrap' }}><b>{tKisa(g.gun)}</b></td>
                  <td style={hucre}>{g.sabah ? <><b>{g.sabah.kim || '?'}</b> · {g.sabah.saat}<br />sayılan <b style={num}>{tut(g.sabah.sayilan)}</b>
                    {g.sabah.dun_birakilan != null && <span style={{ color: R.not }}> · dün bırakılan {tut(g.sabah.dun_birakilan)}</span>}{fark(g.sabah.fark)}</> : <span style={{ color: R.not }}>açılış yok</span>}</td>
                  <td style={hucre}>{g.vardiya ? <><b>{g.vardiya.devreden}</b> → <b>{g.vardiya.devralan}</b> · {g.vardiya.saat}<br />
                    nakit {tut(g.vardiya.nakit)}{g.vardiya.teslim ? ` · teslim ${tut(g.vardiya.teslim)}` : ''} · bıraktı <b style={num}>{tut(g.vardiya.birakilan)}</b>
                    {g.vardiya.durum === 'acilis_bekliyor' && <div style={{ color: R.amber }}>devralan henüz onaylamadı</div>}</> : <span style={{ color: R.not }}>—</span>}</td>
                  <td style={hucre}>{g.aksam ? <><b>{g.aksam.kim || '?'}</b> · {g.aksam.saat}<br />kör toplam <b style={num}>{tut(g.aksam.kor_toplam)}</b>
                    {g.aksam.teslim ? <> · teslim <b style={num}>{tut(g.aksam.teslim)}</b> → {g.aksam.kime || <span style={{ color: R.kirmizi }}>kime? kayıt yok</span>}</> : ' · teslim yok'}
                    {g.aksam.ara_teslim && <div style={{ color: R.not }}>ara teslim: {g.aksam.ara_teslim}</div>}
                    <div>bıraktı <b style={num}>{tut(g.aksam.birakilan)}</b></div></> : <span style={{ color: R.not }}>kapanış yok</span>}</td>
                  <td style={hucre}>{g.ertesi_sabah ? <><b>{g.ertesi_sabah.kim || '?'}</b> · {g.ertesi_sabah.saat}<br />saydı <b style={num}>{tut(g.ertesi_sabah.sayilan)}</b></> : <span style={{ color: R.not }}>—</span>}</td>
                  <td style={{ ...hucre, fontWeight: 700 }}>{g.zincir_fark == null ? <span style={{ color: R.not }}>—</span> : g.zincir_tutuyor ? <span style={{ color: R.yesil }}>tuttu ✓</span> : <span style={{ color: R.kirmizi }}>{g.zincir_fark > 0 ? '+' : ''}{fmt(g.zincir_fark)}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </>}
    </div>
  );
}
