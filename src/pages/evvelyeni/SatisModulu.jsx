// ─────────────────────────────────────────────────────────────────────────────
// 🔍 EVVEL YENİ · SATIŞ KONTROLÜ — "bu kadar bardak gittiyse kasaya şu kadar girmeliydi"
//
// Sahip: "Ürün aç mantığından satışları ve kasada farkı hesaplatıyorduk — bununla ilgili alan kur."
// Codex: sayım–ciro UYUMUNU izler; satış adedi ya da kayıp para ölçümü DEĞİL. Medyan + yayılım + TL tabanı;
// 14 temiz gün birikmeden uyarı yok. Kör kasa farkı yan yana — toplanmaz. Kimseye suç yazılmaz.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { AySecici, Cip, Dugme, fmt, kart, num, PI_CSS, R, tKisa, useSonIstek } from './KasaModulu';
import { ayTR, gunKaydir, tarihKaydir } from '../../utils/trTarih';

// Sahip: "Beklenen satışı AYRI sekme yap; ilk alanda KESİN veriler (satılan, fire, kasa açığı) olsun."
export const SATIS_SAYFALAR = [
  { id: 'satis_kontrol', ad: 'Satış kontrolü', alt: 'Satılan · fire · kasa açığı' },
  { id: 'satis_beklenen', ad: 'Beklenen satış', alt: 'Bardaktan tahmini ciro' },
  { id: 'devir_defteri', ad: 'Kasa devir defteri', alt: 'Kim saydı · kime devretti' },
];

// B84: dün kapalıysa son kapanış günü ('20.10 akşamı')
const dunAd = (g) => (g ? `${g.slice(8, 10)}.${g.slice(5, 7)} akşamı` : 'dün');
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
      {satir('Nakit giderler', m.gider_toplam, '−', (m.giderler || []).length ? m.giderler.map((g) => `${g.ad} ${fmt(g.tutar)}${g.bekliyor ? ' (onay bekliyor)' : ''}`).join(', ') : null)}
      {m.ara_toplam > 0 && satir('Ara teslim', m.ara_toplam, '−', (m.ara_teslimler || []).map((t) => `${t.alan_ad || t.alan || '?'} ${fmt(t.tutar)}${t.not ? ` (${t.not})` : ''}`).join(', '))}
      {satir('Gün sonu teslim', m.teslim, '−')}
      {satir('Kasada bırakılan (devir)', m.devir, '−')}
      <div style={{ borderTop: '1px solid var(--pi-line)', marginTop: 4, paddingTop: 4, color: R.metin2, fontSize: 12 }}>
        <div>Sağlama · sabah: {m.sabah_fark == null ? 'dünkü devir yok' : Math.round(m.sabah_fark * 100) === 0 ? `${dunAd(m.dun_devir_gunu)} bırakılan ${fmt(m.dun_devir)} = bu sabah sayılan ✓` : <span style={{ color: R.kirmizi }}>{dunAd(m.dun_devir_gunu)} bırakılan {fmt(m.dun_devir)} · bu sabah {fmt(m.acilis)} → {m.sabah_fark > 0 ? '+' : ''}{fmt(m.sabah_fark)}</span>}</div>
        <div>Sağlama · akşam: {m.kor_belirsiz ? <span style={{ color: R.amber }}>sayım teslimden SONRA yapılmış ({fmt(m.kor_sayim)} = bırakılan) — sağlama yapılamadı</span>
          : m.kor_fark == null ? '—' : Math.round(m.kor_fark * 100) === 0 ? `sayılan ${fmt(m.kor_sayim)} − teslim = bırakılan ${fmt(m.devir)} ✓`
          : <span style={{ color: R.kirmizi }}>sayılan {fmt(m.kor_sayim)} − teslim {fmt((m.teslim || 0) + (m.ara_toplam || 0))} = {fmt(m.kor_kalan)} · bırakılan {fmt(m.devir)} → {m.kor_fark > 0 ? '+' : ''}{fmt(m.kor_fark)}</span>}</div>
        {/* Sahip: "teslim ihtimali varsa para teslimi yapılmış mı ona da baksın" */}
        {((m.teslim || 0) + (m.ara_toplam || 0) > 0 || teslimler.length > 0) && (
          <div>Sağlama · teslim: {teslimler.length === 0
            ? ((m.panel_teslimleri || []).length > 0
              ? <span style={{ color: R.amber }}>panelde {m.panel_teslimleri.map((t) => `${fmt(t.tutar)} → ${t.alan || '?'}`).join(', ')} var — Kasa'ya henüz aktarılmadı (≤10 dk) ya da alıcı Onur/Fethi/Fatma ile eşleşmedi</span>
              : <span style={{ color: R.kirmizi }}>kasiyer {fmt((m.teslim || 0) + (m.ara_toplam || 0))} ₺ teslim yazdı ama hiçbir teslim kaydı YOK</span>)
            : teslimler.map((t, i) => (
              <span key={i} style={{ marginRight: 8, display: 'inline-block' }}>{i > 0 ? '· ' : ''}{fmt(t.tutar)} ₺ → {t.alan}: {t.durum === 'bekliyor'
                ? <span style={{ color: R.amber }}>henüz alınmadı</span>
                : t.otomatik ? <span style={{ color: R.amber }}>otomatik kabul (kimse saymadı)</span>
                  : Math.abs(t.fark || 0) < 1 ? <span style={{ color: R.yesil }}>aldı, saydı ✓</span>
                    : <span style={{ color: R.kirmizi }}>aldı, {fmt(t.alinan)} saydı → {fmt(t.fark)} eksik</span>}</span>))}
            {teslimler.length > 0 && Math.abs(teslimler.reduce((a, t) => a + t.tutar, 0) - ((m.teslim || 0) + (m.ara_toplam || 0))) >= 1 &&
              <span style={{ color: R.kirmizi }}> · kasiyerin yazdığı {fmt((m.teslim || 0) + (m.ara_toplam || 0))} ≠ Kasa'daki {fmt(teslimler.reduce((a, t) => a + t.tutar, 0))}</span>}
          </div>
        )}
        {(m.vardiya || []).length > 0 && <div>Vardiya devri: {m.vardiya.map((v) => `${v.saat || ''} ${v.sayilan == null ? '' : `${fmt(v.sayilan)} ₺ sayıldı`}`).join(' · ')}</div>}
      </div>
    </div>
  );
}

// ── GÜNLÜK DÖKÜM — sahip: "bugün 14 adet 8oz vs. görmek istiyorum; kasada açık var mı, satıştan açık var mı; fire" ──
function GunlukDokum() {
  // dün (TR) — Dalga 5 · adreste ?gun= varsa o gün (Bekleyen işler › 🌅 Sabah sayımı tutmadı düğmesi bugünü açar)
  const [gun, setGun] = useState(() => (/^\d{4}-\d{2}-\d{2}$/.test(new URLSearchParams(window.location.search).get('gun') || '') ? [new URLSearchParams(window.location.search).get('gun'), tarihKaydir(0)].sort()[0] : tarihKaydir(-1)));   // ileri gün adresi bugüne kırpılır
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  useEffect(() => {   // G35 (sim 23 Eki): her açılışta DÜN seçiliydi — bugün kapanmış şube varsa bugün açılır (akşam kontrolü gözden kaçmasın)
    if (new URLSearchParams(window.location.search).get('gun')) return undefined;
    let canli = true;
    const bugun = tarihKaydir(0);
    api(`/evvel-yeni/satis/gun?gun=${bugun}`).then((r) => {
      if (canli && (r?.subeler || []).some((s) => s.durum && s.durum !== 'kapanis_yok')) setGun((g) => (g === tarihKaydir(-1) ? bugun : g));
    }).catch(() => { /* dün kalır */ });
    return () => { canli = false; };
  }, []);
  useSonIstek(`/evvel-yeni/satis/gun?gun=${gun}`, setV, setHata, true);   // ortak 'son istek kazanır' (T4-09)
  const bugunGun = tarihKaydir(0);   // F1.10 (sim 25 Eki): › ile gelecek güne gidiliyordu — bugünden ileri gün yok
  const kaydir = (k) => setGun((g) => { const y = gunKaydir(g, k); return y > bugunGun ? bugunGun : y; });   // Fable: adresten ileri gün gelirse ‹ / › bugüne kırpar, takılmaz
  const acikYaz = (x) => (x == null ? '—' : Math.abs(x) < 1 ? 'yok' : x > 0 ? `${fmt(Math.round(x))} ₺ AÇIK` : `${fmt(Math.round(-x))} ₺ fazla`);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 18 }}>Günlük döküm</b>
        <Dugme kucuk onClick={() => kaydir(-1)}>‹</Dugme>
        <input type="date" value={gun} max={bugunGun} onChange={(e) => e.target.value && e.target.value <= bugunGun && setGun(e.target.value)}
          style={{ font: 'inherit', padding: '5px 8px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        <Dugme kucuk disabled={gun >= bugunGun} onClick={() => kaydir(1)}>›</Dugme>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Döküm hazırlanıyor…</div>}
      {v && <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>}
      {/* F1.12 R7-2 (sim 26 Eki): 4 şube alt alta uzun sayfa — üstte şube çipleri, dokununca o şubenin kartına iner */}
      {v && v.subeler.length > 1 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {v.subeler.map((s) => (
          <Dugme key={s.sube_id} kucuk onClick={() => document.getElementById(`satis-sube-${s.sube_id}`)?.scrollIntoView({ block: 'start' })}>
            {s.ad}{s.devir_tutmadi?.length ? ' ⚠' : ''}
          </Dugme>))}
      </div>}
      {v && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 460px), 1fr))', gap: 12 }}>
        {v.subeler.map((s) => (
          <div key={s.sube_id} id={`satis-sube-${s.sube_id}`} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 9, scrollMarginTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={{ fontSize: 16 }}>{s.ad}</b>
              {s.durum === 'kapanis_yok' && <Cip>akşam sayımı yok</Cip>}{s.durum === 'acilis_yok' && <Cip>sabah sayımı yok</Cip>}</div>
            {/* F1.12 R7-1 (sim 26 Eki): gün içi devir tutmadıysa kasa açığına bakan merkez bilsin — ayrıntı devir defterinde (tek yer) */}
            {s.devir_tutmadi?.length > 0 && (
              <a href={`/evvel-yeni/devir_defteri?ay=${gun.slice(0, 7)}&sube=${s.sube_id}`}
                style={{ fontSize: 13, fontWeight: 700, color: R.amber, background: 'var(--pi-bg)', borderRadius: 9, padding: '7px 10px', textDecoration: 'none' }}>
                ⚠ gün içi devir tutmadı ({s.devir_tutmadi.map((d) => `${d.saat} ${d.devreden} → ${d.devralan}`).join(' · ')}) → Devir defteri
              </a>)}
            {s.devir_tutmadi === null && <div style={{ fontSize: 12.5, color: R.not }}>gün içi devir kontrolü okunamadı — Devir defterine bak</div>}
            {/* B63 (22 Eki): akşam sayımı yokken de tablo — sabah + gece farkı görünsün (Bekleyen › 🌅 Sabah sayımı tutmadı buraya gelir); 'satılan' akşamla çıkar */}
            {s.durum !== 'acilis_yok' && (s.durum !== 'kapanis_yok' || s.kalemler.some((k) => k.sabah != null)) ? (
              <>
                {/* Sahip: "satılan yazısı daha belirgin olsun" — büyük rakamlı kutucuklar */}
                {s.durum !== 'kapanis_yok' && <div style={{ background: 'var(--pi-accent-soft)', borderRadius: 11, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', color: R.metin2, marginBottom: 6 }}>BUGÜN SATILAN</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {s.kalemler.filter((k) => k.satilan > 0).map((k) => (
                      <div key={k.urun || k.kod} style={{ background: 'var(--pi-paper)', border: '1px solid var(--pi-line)', borderRadius: 10, padding: '6px 10px', textAlign: 'center', minWidth: 62 }}>
                        <div style={{ ...num, fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: 'var(--pi-accent)' }}>{k.satilan}</div>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{k.ad.replace(' bardak', '').replace(' (toplam)', '')}</div>
                      </div>
                    ))}
                    {!s.kalemler.some((k) => k.satilan > 0) && <span style={{ color: R.not }}>—</span>}
                  </div>
                </div>}
                <div style={{ overflowX: 'auto' }}><table className="pi-tablo pi-excel" style={{ fontSize: 12.5, minWidth: 420 }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>Kalem</th><th>Sabah</th><th>Giren</th><th>Akşam</th><th>Kullanılan</th><th>Fire</th><th>Satılan</th></tr></thead>
                  <tbody>{s.kalemler.map((k) => (
                    <tr key={k.urun || k.kod}>
                      <td style={{ textAlign: 'left' }}>{k.ad}{k.devir_fark ? (k.kayitsiz_giris
                        ? <span style={{ color: R.amber }} title="sabah vitrinde var, o gün kabul / teslim kaydı yok"> · kaydı girilmemiş +{k.devir_fark}</span>
                        : <span style={{ color: R.amber }} title="dün akşamdan bu sabaha fark"> · gece {k.devir_fark > 0 ? '+' : ''}{k.devir_fark}</span>) : ''}</td>
                      <td style={num}>{k.sabah ?? '—'}</td><td style={num}>{k.giren || ''}</td><td style={num}>{k.aksam ?? '—'}</td>
                      <td style={{ ...num, color: k.kullanilan < 0 ? R.kirmizi : undefined }}>{k.kullanilan == null ? '—' : k.kullanilan < 0 ? `${k.kullanilan} (${k.kayitsiz_giris ? 'kabul kaydı yok?' : 'ürün aç eksik?'})` : k.kullanilan}</td>
                      <td style={{ ...num, color: k.fire ? R.amber : undefined }}>{k.fire || ''}</td>
                      <td style={{ ...num, fontWeight: 700 }}>{k.satilan ?? '—'}</td>
                    </tr>))}</tbody>
                </table></div>
              </>
            ) : <div style={{ color: R.not, fontSize: 13 }}>Sabah bar sayımı olmadan kalem dökümü çıkmaz.</div>}
            {s.fire.length > 0 && (
              <div style={{ fontSize: 12.5, background: 'var(--pi-bg)', borderRadius: 9, padding: '7px 10px' }}>
                <b>Fire ({s.fire_toplam})</b>
                {s.fire.map((f, i) => <div key={i}>{f.saat} · {f.adet} × {f.ad} — <b>{f.sebep}</b>{f.iade ? [f.iade.sebep_ad, f.iade.fis_no && `fiş ${f.iade.fis_no}`, f.iade.iade_saat && `iade ${f.iade.iade_saat}`].filter(Boolean).map((x) => ` · ${x}`).join('') : ''}{f.kim ? ` · ${f.kim}` : ''}{f.aciklama ? ` · ${f.aciklama}` : ''}
                  {f.iade && (f.iade.musteri_ad || f.iade.musteri_tel) ? <span style={{ color: R.metin2 }}> · müşteri {[f.iade.musteri_ad, f.iade.musteri_tel].filter(Boolean).join(' ')}</span> : null}</div>)}
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
  const [ay, setAy] = useState(ayTR);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [hepsi, setHepsi] = useState(false);
  const yukle = useSonIstek(`/evvel-yeni/satis/kontrol?ay=${ay}`, setV, setHata);   // ortak 'son istek kazanır' (T4-09)
  // 📱 sahip 28 Eki (Fable A): telefonda (≤640 px) 8 sütunlu tablo yana kayıp okunmuyordu → gün başına kart, son gün üstte
  const [dar, setDar] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(max-width: 640px)');
    const f = (e) => setDar(e.matches);
    mq.addEventListener ? mq.addEventListener('change', f) : mq.addListener(f);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', f) : mq.removeListener(f));
  }, []);

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Satış kontrolü okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Hesaplanıyor… (bar sayımı + kapanışlar)</div></div>;

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Tahmin</div><h1 style={{ fontSize: dar ? 24 : 30 }}>Beklenen satış</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, minHeight: 40 }}>
          <input type="checkbox" checked={hepsi} onChange={(e) => setHepsi(e.target.checked)} />veri eksik günleri de göster
        </label>
        <AySecici ay={ay} setAy={setAy}
          style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
      </div>
      <div style={{ fontSize: 13.5 }}>Bardaktan <b>tahmini</b> ciro ile girilen ciro — kesin değil, uyum izleme. Kesin rakamlar <b>Satış kontrolü</b> sekmesinde.</div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>

      {v.subeler.map((s) => {
        if (s.panel_yok) return <div key={s.sube_id} style={{ ...kart, padding: '10px 14px', color: R.not, fontSize: 13 }}><b style={{ color: 'var(--pi-ink)' }}>{s.ad}</b> · panelde sayım / kapanış yapılmıyor — bu ekranın kapsamı dışında (ciro Gelir'de)</div>;
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
            {dar ? (
              <div style={{ display: 'grid' }}>
                {[...gun].reverse().map((g) => (
                  <div key={g.gun} style={{ padding: '9px 14px', borderTop: '1px solid var(--pi-line)', fontSize: 13.5 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <b style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(g.gun)}</b>
                      <span style={{ color: R.not }}>{g.bardak ? `${g.bardak} bardak` : '—'}</span>
                      <span style={{ ...num, marginLeft: 'auto' }}>{g.beklenen ? `≈${fmt(Math.round(g.beklenen))}` : '—'} ↔ {g.ciro != null ? fmt(g.ciro) : '—'} ₺</span>
                      <b style={{ ...num, color: g.sapma == null ? R.not : g.sapma < 0 ? (g.durum === 'bak' ? R.kirmizi : R.amber) : R.yesil }}>{g.sapma == null ? '' : `${g.sapma > 0 ? '+' : ''}${fmt(g.sapma)}%`}</b>
                    </div>
                    <div style={{ marginTop: 3, fontSize: 12.5 }}><Cip tur={DURUM[g.durum].tur}>{DURUM[g.durum].ad}</Cip>{g.neden && <span style={{ color: R.not }}> {g.neden}</span>}
                      {g.kasa_fark != null && <span style={{ color: R.not }}> · kör kasa {g.kasa_baslangic ? 'başlangıç' : g.kasa_fark === 0 ? 'tuttu' : `${g.kasa_fark > 0 ? 'eksik ' : 'fazla '}${fmt(Math.abs(g.kasa_fark))}`}</span>}</div>
                  </div>
                ))}
                {!gun.length && <div style={{ padding: 12, textAlign: 'center', color: R.not, fontSize: 13 }}>Hesaplanabilen gün yok — "veri eksik günleri de göster" ile sebeplerini gör.</div>}
              </div>
            ) : (
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
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 🔁 KASA DEVİR DEFTERİ — sahip: "açılış ve kapanış sayımlarını, devrin kimden kime yapıldığını takip etmek" ──
export function DevirDefteri() {
  const [ay, setAy] = useState(() => {   // F1.12: Satış kontrolündeki "devir tutmadı" bağı ay + şubeyle açar
    const a = new URLSearchParams(window.location.search).get('ay') || '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(a) ? a : ayTR();
  });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sube, setSube] = useState(null);
  const no = useRef(0);
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/satis/devir-defteri?ay=${ay}`).then((r) => { if (n === no.current) { setV(r); setHata(null); setSube((x) => x || r.subeler.find((s) => String(s.sube_id) === new URLSearchParams(window.location.search).get('sube'))?.sube_id || r.subeler.find((s) => s.ozet.tutan + s.ozet.kopuk + (s.ozet.celiskili || 0) > 0)?.sube_id || r.subeler[0]?.sube_id); } })
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
        <AySecici ay={ay} setAy={setAy}
          style={{ marginLeft: 'auto', font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Defter hazırlanıyor…</div>}
      {v && <>
        {v.dondu && <div style={{ background: 'var(--pi-bg)', border: '1px solid var(--pi-line)', borderRadius: 9, padding: '8px 11px', fontSize: 13 }}>
          🔒 <b>{new Date(`${ay}-01T12:00:00`).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })} — eski panel kaydı, dondurulmuş.</b> Değiştirilemez; kırmızılar yalnız bakmak içindir, iş / uyarı üretmez (sahip 27 Eki).</div>}
        <div style={{ fontSize: 12.5, color: R.not }}>{v.not} Kasiyer bu ekranı görmez.</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {v.subeler.map((x) => (
            <button key={x.sube_id} type="button" onClick={() => setSube(x.sube_id)} style={{
              font: 'inherit', fontWeight: 700, padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${sube === x.sube_id ? 'var(--pi-accent)' : 'var(--pi-line)'}`, background: sube === x.sube_id ? 'var(--pi-accent)' : 'var(--pi-paper)', color: sube === x.sube_id ? 'var(--pi-on-accent)' : R.krem,
            }}>{x.ad} <span style={{ fontWeight: 400, fontSize: 12 }}>✓{x.ozet.tutan}{x.ozet.celiskili ? ` · ⚠${x.ozet.celiskili}` : ''}{x.ozet.kopuk ? ` · ✗${x.ozet.kopuk}` : ''}</span></button>
          ))}
        </div>
        {s && s.panel_yok && <div style={{ ...kart, padding: '10px 14px', color: R.not, fontSize: 13 }}><b style={{ color: 'var(--pi-ink)' }}>{s.ad}</b> · panelde sayım / kapanış yapılmıyor — bu ekranın kapsamı dışında (ciro Gelir'de)</div>}
        {s && !s.panel_yok && (
          <div style={{ ...kart, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
              <thead><tr style={{ textAlign: 'left', fontSize: 12, color: R.metin2 }}>
                <th style={hucre}>Gün</th><th style={hucre}>🌅 Sabah sayımı</th><th style={hucre}>🔁 Vardiya devri</th><th style={hucre}>🌙 Akşam kapanış</th><th style={hucre}>➡️ Ertesi sabah</th><th style={hucre}>Zincir</th>
              </tr></thead>
              <tbody>{s.gunler.slice(Math.max(0, s.gunler.findIndex((g) => g.sabah || g.aksam || g.vardiya || g.vardiyalar?.length))).map((g) => (   /* R6-1 (sim 25 Eki): şubenin ilk kaydından önceki boş günler gizli */
                <tr key={g.gun} ref={g.gun === s.gunler[s.gunler.length - 1]?.gun ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined} style={{ background: g.zincir_durum === 'celiskili' ? 'rgba(201,138,30,.07)' : g.zincir_fark != null && !g.zincir_tutuyor ? 'rgba(192,58,43,.06)' : undefined }}>
                  <td style={{ ...hucre, ...num, whiteSpace: 'nowrap' }}><b>{tKisa(g.gun)}</b></td>
                  <td style={hucre}>{g.sabah ? <><b>{g.sabah.kim || '?'}</b> · {g.sabah.saat}<br />sayılan <b style={num}>{tut(g.sabah.sayilan)}</b>
                    {g.sabah.dun_birakilan != null && <span style={{ color: R.not }}> · {dunAd(g.sabah.dun_gunu)} bırakılan {tut(g.sabah.dun_birakilan)}</span>}{fark(g.sabah.fark)}</> : <span style={{ color: R.not }}>açılış yok</span>}</td>
                  <td style={hucre}>{(g.vardiyalar?.length ? g.vardiyalar : g.vardiya ? [g.vardiya] : []).map((vy, i) => (   /* D4: günün BÜTÜN devirleri */
                    <div key={i} style={i ? { borderTop: `1px dashed ${R.cizgi}`, marginTop: 4, paddingTop: 4 } : undefined}>
                      <b>{vy.devreden}</b> → <b>{vy.devralan}</b> · {vy.saat}<br />
                      {vy.durum === 'merkez' ? <span style={{ color: R.bakirAcik || R.amber }}>🏢 merkez kapattı · bıraktı <b style={num}>{tut(vy.birakilan)}</b>{vy.merkez_not ? ` · ${vy.merkez_not}` : ''}</span>
                        : vy.durum === 'tutmadi'
                        ? <span style={{ color: R.kirmizi }}>⚠ tutmadı · devreden {tut(vy.devreden_sayilan)} · devralan <b style={num}>{tut(vy.devralan_sayilan)}</b>{vy.fark_kalem?.length ? ` · ${vy.fark_kalem.join(', ')}` : ''}</span>
                        : <>{vy.teslim ? `teslim ${tut(vy.teslim)} · ` : ''}bıraktı <b style={num}>{tut(vy.birakilan)}</b>{vy.devralan_sayilan != null ? <span style={{ color: R.yesil }}> ✓ iki sayım tuttu{vy.tur > 1 ? ' (2. sayımda)' : ''}</span> : null}</>}
                      {vy.tur1 && <div style={{ fontSize: 12, color: R.amber }}>1. sayım: devreden {tut(vy.tur1.devreden)} · devralan {tut(vy.tur1.devralan)}{vy.tur1.fark_kalem?.length ? ` · ${vy.tur1.fark_kalem.join(', ')}` : ''}</div>}
                      {vy.durum === 'acilis_bekliyor' && <div style={{ color: R.amber }}>devralan henüz onaylamadı</div>}
                    </div>))}
                    {!g.vardiyalar?.length && !g.vardiya && <span style={{ color: R.not }}>—</span>}
                    {g.vardiya_kasa?.v1 && (   /* Faz 2 (sahip 24 Eki): vardiya bazında bardak → nakit — kart vardiyada bilinmez, oran izlenir */
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px dashed ${R.cizgi}`, display: 'grid', gap: 2, fontSize: 12 }}>
                        {['v1', 'v2'].map((k, i) => { const x = g.vardiya_kasa[k]; return (
                          <div key={k} style={{ color: x.durum === 'bak' ? R.kirmizi : R.metin2 }} title="Beklenen = günün nakit satışı × bu vardiyanın bardak payı. Kimseye suç yazılmaz.">
                            {i ? '🌙' : '☀'} <b>{x.kim || '?'}</b> · {x.bardak} bardak · kasaya {tut(x.nakit)} · beklenen ≈{tut(x.beklenen)}
                            {x.fark != null && <b style={num}> ({x.fark > 0 ? '+' : ''}{tut(x.fark)})</b>}{x.durum === 'bak' ? ' · bak' : x.durum === 'az' ? ' · az bardak (karşılaştırılmaz)' : ''}
                          </div>); })}
                      </div>
                    )}
                    {g.vardiya_kasa?.neden && <div style={{ marginTop: 4, fontSize: 12, color: R.not }}>vardiya kasası: {g.vardiya_kasa.neden}</div>}</td>
                  <td style={hucre}>{g.aksam ? <><b>{g.aksam.kim || '?'}</b> · {g.aksam.saat}<br />kör toplam <b style={num}>{tut(g.aksam.kor_toplam)}</b>
                    {g.aksam.teslim ? <> · teslim <b style={num}>{tut(g.aksam.teslim)}</b> → {g.aksam.kime || <span style={{ color: R.kirmizi }}>kime? kayıt yok</span>}</> : ' · teslim yok'}
                    {g.aksam.ara_teslim && <div style={{ color: R.not }}>ara teslim: {g.aksam.ara_teslim}</div>}
                    <div>bıraktı <b style={num}>{tut(g.aksam.birakilan)}</b>
                      {g.zincir_celiski && <span style={{ color: R.amber }} title="Personelin 'kasada bırakılan' beyanı ile kör sayım − teslim − ara teslim uyuşmuyor"> (beyan) · sayımdan kalan <b style={num}>{tut(g.aksam.sayimdan_kalan)}</b></span>}</div></> : <span style={{ color: R.not }}>kapanış yok</span>}
                    {g.elle_teslim && <div style={{ color: 'var(--pi-accent)', fontSize: 12 }}>teslim (Kasa'ya elle): {g.elle_teslim}</div>}</td>
                  <td style={hucre}>{g.ertesi_sabah ? <><b>{g.ertesi_sabah.kim || '?'}</b> · {g.ertesi_sabah.saat}<br />saydı <b style={num}>{tut(g.ertesi_sabah.sayilan)}</b></> : <span style={{ color: R.not }}>—</span>}</td>
                  {/* sahip 24 Eki (Alsancak +3243): beyan ile sayımdan kalan çelişirse İKİ fark birden; tolerans 0 ₺ (Codex) */}
                  <td style={{ ...hucre, fontWeight: 700 }}>{g.zincir_fark == null ? <span style={{ color: R.not }}>—</span>
                    : g.zincir_tutuyor ? <span style={{ color: R.yesil }}>tuttu ✓</span>
                    : g.zincir_durum === 'celiskili' ? <span style={{ color: R.amber }}>sabah uyumlu · kapanış verileri çelişkili
                        <div style={{ fontWeight: 400, fontSize: 12 }}>beyana göre {g.zincir_fark > 0 ? '+' : ''}{fmt(g.zincir_fark)} · sayıma göre {g.zincir_fark_sayim > 0 ? '+' : ''}{fmt(g.zincir_fark_sayim)}</div></span>
                    : <span style={{ color: R.kirmizi }}>{g.zincir_fark > 0 ? '+' : ''}{fmt(g.zincir_fark)}{g.zincir_celiski ? ' (beyana göre)' : ''}
                        {g.zincir_celiski && g.zincir_fark_sayim != null && <div style={{ fontWeight: 400, fontSize: 12 }}>sayıma göre {g.zincir_fark_sayim > 0 ? '+' : ''}{fmt(g.zincir_fark_sayim)}</div>}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </>}
    </div>
  );
}
