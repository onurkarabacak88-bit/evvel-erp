// ─────────────────────────────────────────────────────────────────────────────
// 👥 EVVEL YENİ · MAAŞLAR — kişi × çalışma ayı: hak ediş − avans − ödenen = kalan
//
// Ortak karar (sahip + Codex + Claude): tek hesap, tek ekran. Gider HAK EDİŞTEN yazılır (çalışma ayına,
// bir kez); maaş/avans ödemeleri yalnız kasadan düşer. Ekim eski sistemin hesabıyla kapanır, Kasım'dan yeni.
// Rakamlar /api/evvel-yeni/maas'tan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { sayiTR } from '../../utils/trSayi';
import { ALAN, AySecici, Cip, Dugme, etiketStil, fmt, kart, num, PI_CSS, R, soruOnay, soruYaz, tl, useSonIstek } from './KasaModulu';
import { ayAdi, ayKaydir, ayTR } from '../../utils/trTarih';
import { Pencere } from './AyTakvim';
// B39: tablo sütunlarında tutarlar aynı biçimde (35.200,00 · 20.533,33) — karışık ondalık gözü yanıltmasın
const fmt2 = (n) => (Number(n) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const MAAS_SAYFALAR = [
  { id: 'maaslar', ad: 'Maaşlar', alt: 'Hak ediş · avans · kalan' },
  { id: 'personel_yoklama', ad: 'Günlük yoklama', alt: 'Kim okuttu · kim okutmadı · geç kalan' },
  { id: 'personel_takvim', ad: 'Personel takvimi', alt: 'Gün gün hangi şubede · izinli' },
];

const alan = { ...ALAN, borderRadius: 9, width: 110 };   // temel stil KasaModulu ALAN (T4-15)
// Varsayılan: ödenecek ay = geçen ay; ama Evvel Yeni öncesi (kapanmış) aylar varsayılan olmaz → en erken Ekim 2026
const gecenAy = () => { const a = ayKaydir(ayTR(), -1); return a < '2026-10' ? '2026-10' : a; };
const sayi = (x) => sayiTR(x, null);   // tek kaynak utils/trSayi

export default function MaasModulu({ onToast, onSekme }) {
  const [ay, setAy] = useState(gecenAy);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sec, setSec] = useState(null);     // açık satır (personel_id)
  const [d, setD] = useState({});           // elle alanlar
  const [mesgul, setMesgul] = useState(false);
  const yukle = useSonIstek(`/evvel-yeni/maas/liste?ay=${ay}`, setV, setHata);   // ortak 'son istek kazanır' (T4-09)

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
          <AySecici ay={ay} setAy={setAy} style={{ ...alan, width: 'auto' }} />
        </label>
      </div>

      <div style={{ ...kart, padding: '14px 18px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {[['Hak ediş', v.toplam.hak_edis], ['Avans mahsubu', v.toplam.avans_mahsup], ['Ödenen', v.toplam.odenen], ['Kalan', v.toplam.kalan]].map(([a, t], i) => (
          <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: i === 3 ? 28 : 18, fontWeight: 700, color: i === 3 ? R.kirmizi : R.krem }}>{fmt(t)}</div></div>
        ))}
        {v.kapali ? <Cip tur="yesil">Kapanmış ay — ödendi sayıldı</Cip> : v.eski_mod && <Cip tur="sari">eski sistemin hesabı</Cip>}
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
                <td style={num}>{fmt2(x.hak_edis)}</td>
                <td style={num}>{x.avans_mahsup ? `−${fmt2(x.avans_mahsup)}` : ''}</td>
                <td style={num}>{x.odenen ? `−${fmt2(x.odenen)}` : ''}</td>
                <td style={{ ...num, fontWeight: 700, color: x.kalan > 0 ? R.kirmizi : R.yesil }}>{fmt2(x.kalan)}</td>
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
        <Pencere onKapat={() => setSec(null)} mesgul={mesgul} genislik={640} kapatDugmesi={false} aralik={12} maxYukseklik="90vh">   {/* ortak Pencere (T4-06) — işlem sürerken kapanmaz */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <b style={{ fontSize: 18 }}>{r.ad}</b><span style={{ color: R.not }}>{r.sube_ad} · {ayAdi(v.ay)} · {r.calisma_turu === 'yari' ? 'yarı zamanlı' : 'tam zamanlı'}</span>
              <span style={{ marginLeft: 'auto' }}><Dugme kucuk onClick={() => setSec(null)}>Kapat</Dugme></span>
            </div>
            {(r.uyari || []).map((u) => <div key={u} style={{ color: R.kirmizi, fontWeight: 600 }}>⚠ {u}</div>)}
            <div>
              {r.kalemler.map((k) => (
                <div key={k.kod + k.ad} style={{ padding: '6px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{k.ad}</span><b style={{ ...num, color: k.tutar < 0 ? R.kirmizi : R.krem }}>{fmt(k.tutar)}</b>
                  </div>
                  {k.kod === 'yemek' && (r.yemek_dusen || []).length > 0 && (   // K7: hak düşen günler (yoklama › Yemek molaları'ndan)
                    <div style={{ fontSize: 12, color: R.not, marginTop: 2 }}>
                      Yemek hakkı düşen günler: {r.yemek_dusen.map((d) => `${(d.gun || '').slice(8, 10)}.${(d.gun || '').slice(5, 7)} (${d.sure_dk ?? '?'} dk)`).join(', ')}
                    </div>
                  )}
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
                <div style={{ fontSize: 12, color: R.not }}>"vardiyadan" yazan kutular boş bırakılırsa Vardiya planı (Personel › Vardiya) kullanılır.</div>
                <div style={{ display: 'flex', gap: 8 }}><Dugme onClick={kaydet} disabled={mesgul}>Kaydet</Dugme>
                  {!r.ay_acik && <Dugme ana onClick={() => onayla(false)}>Ayı onayla (dondur)</Dugme>}</div>
              </div>
            )}
            {r.onay && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Cip tur="yesil">Onaylı — kalemler donduruldu</Cip><Dugme kucuk onClick={() => onayla(true)}>Onayı kaldır</Dugme></div>}
            {r.kalan > 0 && <div><Dugme ana onClick={() => ode(r)}>Kalanı öde ({fmt(r.oneri['Maaş'])} ₺ maaş)</Dugme></div>}
        </Pencere>
      )}
    </div>
  );
}

// ── 👥 PERSONEL TAKVİMİ — sahip: "panel verilerinden bulundukları şubeler gün gün; QR girişi yoksa izinli" ──
const SUBE_RENK = ['#9A5F2E', '#2E7D6B', '#5B5FB5', '#B5465B', '#7A7A2E', '#2E6E9A'];
export function PersonelTakvim({ onToast }) {
  const [ay, setAy] = useState(ayTR);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [yenile, setYenile] = useState(0);
  const no = useRef(0);
  const cevapla = async (s, karar) => {
    let izin_bitis = null;
    if (karar === 'izin') { izin_bitis = (await soruYaz(`${s.ad} yıllık izinde — izin hangi gün bitiyor? (YYYY-AA-GG, boş bırakabilirsin)`, true)) || null; }
    if (karar === 'ayrildi' && !(await soruOnay(`${s.ad} ayrıldı olarak işaretlensin mi?\nPasife alınır; ayrılış = son QR girişi (${s.son_qr || '?'}).`))) return;
    try { const r = await api('/evvel-yeni/maas/takvim-karar', { method: 'POST', body: { personel_id: s.personel_id, karar, tarih: s.ilk_gun, izin_bitis } }); onToast?.(r.mesaj); setYenile((x) => x + 1); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  useEffect(() => {
    const n = ++no.current;
    setV(null);
    api(`/evvel-yeni/maas/takvim?ay=${ay}`).then((r) => { if (n === no.current) { setV(r); setHata(null); } })
      .catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  }, [ay, yenile]);
  const renk = (ad) => (v ? SUBE_RENK[Math.max(0, v.subeler.indexOf(ad)) % SUBE_RENK.length] : '#999');
  const kisa = (ad) => (ad || '').slice(0, 3).toLocaleUpperCase('tr');
  const gunNo = (d) => Number(d.slice(8, 10));
  const gunHarf = (d) => ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct'][new Date(`${d}T12:00:00`).getDay()];
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Personel takvimi</h1></div>
        <AySecici ay={ay} setAy={setAy} style={{ ...alan, width: 'auto', marginLeft: 'auto' }} />
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Takvim hazırlanıyor…</div>}
      {v && <>
        {v.uyari && <div style={{ ...kart, padding: 12, color: R.kirmizi, fontWeight: 700 }}>{v.uyari}</div>}
        {/* Sahip: "arka arkaya iki gün QR girişi yoksa sistem SORSUN — ayrıldı mı, yıllık izinde mi, devam mı" */}
        {(v.sorulacak || []).length > 0 && (
          <div style={{ ...kart, padding: 14, borderLeft: '5px solid var(--pi-warn)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <b>🔔 {v.sorulacak.length} kişi {v.sorulacak.length > 1 ? 'günlerdir' : 'günlerdir'} QR ile giriş yapmadı</b>
            {v.sorulacak.map((s) => (
              <div key={s.personel_id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}>
                <span style={{ minWidth: 220 }}><b>{s.ad}</b> · {s.gun_sayisi} gündür QR yok{s.son_qr ? ` (son giriş ${s.son_qr.slice(8, 10)}.${s.son_qr.slice(5, 7)})` : ''}</span>
                <Dugme kucuk onClick={() => cevapla(s, 'ayrildi')}>Ayrıldı</Dugme>
                <Dugme kucuk onClick={() => cevapla(s, 'izin')}>Yıllık izinde</Dugme>
                <Dugme kucuk onClick={() => cevapla(s, 'devam')}>Devam ediyor</Dugme>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
        {(v.eslesmeyen || []).length > 0 && <div style={{ fontSize: 12.5, color: R.amber }}>Personel listesinde bulunamayan QR girişleri: {v.eslesmeyen.map((x) => `${x.ad} (${x.gun.slice(8, 10)}.${x.gun.slice(5, 7)} ${x.sube})`).join(', ')} — Tanımlar → Personel'den ekle ya da adı düzelt.</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
          {v.subeler.map((s) => <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: renk(s) }} />{s}</span>)}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 14, borderRadius: 4, border: '1px dashed var(--pi-line)' }} />izinli (QR yok)</span>
        </div>
        <div style={{ ...kart, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead><tr>
              <th style={{ textAlign: 'left', padding: '6px 10px', position: 'sticky', left: 0, background: 'var(--pi-paper)', minWidth: 170 }}>Personel</th>
              {v.gunler.map((d) => <th key={d} style={{ padding: '4px 1px', minWidth: 44, color: ['Ct', 'Pz'].includes(gunHarf(d)) ? R.amber : R.metin2 }}><div style={num}>{gunNo(d)}</div><div style={{ fontWeight: 400 }}>{gunHarf(d)}</div></th>)}
              <th style={{ textAlign: 'left', padding: '6px 10px', minWidth: 190 }}>Ay özeti</th>
            </tr></thead>
            <tbody>{v.personel.map((p) => (
              <tr key={p.personel_id} style={{ borderTop: '1px solid var(--pi-line)', opacity: p.aktif ? 1 : 0.6 }}>
                <td style={{ padding: '6px 10px', position: 'sticky', left: 0, background: 'var(--pi-paper)' }}>
                  <b>{p.ad}</b>{p.mudur && <span style={{ color: R.not }}> · müdür (QR aranmaz)</span>}{p.sube_qr_yok && !p.mudur && <span style={{ color: R.not }}> · şubede QR kullanılmıyor</span>}{!p.aktif && <span style={{ color: R.not }}> · ayrıldı</span>}{p.yillik_izinde && <span style={{ color: R.amber }}> · yıllık izinde{p.izin_bitis ? ` (${p.izin_bitis.slice(8, 10)}.${p.izin_bitis.slice(5, 7)}'e kadar)` : ''}</span>}
                  {/* Sahip: "shiftleri her zaman karışık yazıyoruz — önemli değil; maliyet kadroya (kayıtlı şube) yazılır" */}
                  <div style={{ fontSize: 11, color: R.not }}>kadro: {p.kayitli_sube}</div>
                </td>
                {p.gunler.map((g) => (
                  <td key={g.gun} style={{ padding: 1 }} title={g.durum === 'calisti' ? `${g.subeler.join(' + ')} · giriş ${g.saat || '?'}${g.disi ? ' · vardiya dışı' : ''}` : g.durum === 'izinli' ? 'QR girişi yok — izinli' : ''}>
                    {g.durum === 'calisti' ? (
                      <div style={{ minHeight: 34, borderRadius: 5, display: 'flex', flexDirection: 'column', overflow: 'hidden', border: g.disi ? '2px solid var(--pi-warn)' : 'none' }}>
                        {(g.girisler || g.subeler.map((s) => ({ sube: s, saat: g.saat }))).map((x, i) => (
                          <div key={i} title={x.panel ? `${x.sube} · QR yok — ${x.vardiya}` : `${x.sube} · QR ${x.saat || ''}`} style={{ flex: 1, background: x.panel ? `repeating-linear-gradient(135deg, ${renk(x.sube)} 0 4px, ${renk(x.sube)}99 4px 8px)` : renk(x.sube), color: '#fff', fontSize: 9, fontWeight: 700, lineHeight: 1.15, padding: '2px 1px', textAlign: 'center', outline: x.panel ? '1px dashed #fff' : 'none', outlineOffset: -2 }}>
                            {kisa(x.sube)}<br /><span style={{ fontWeight: 500 }}>{x.saat || ''}</span>
                          </div>
                        ))}
                      </div>
                    ) : g.durum === 'mudur' ? <div style={{ height: 30 }} title="Müdür — QR aranmaz" />
                      : g.durum === 'izinli' ? <div style={{ height: 30, borderRadius: 5, border: '1px dashed var(--pi-line)', display: 'grid', placeItems: 'center', color: R.not, fontSize: 9.5 }}>izin</div>
                      : <div style={{ height: 30 }} />}
                  </td>
                ))}
                <td style={{ padding: '6px 10px', fontSize: 12 }}>
                  {Object.entries(p.sube_gun).map(([s, n]) => <span key={s} style={{ marginRight: 8, whiteSpace: 'nowrap' }}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: renk(s), marginRight: 3 }} />{s} {n}</span>)}
                  <div style={{ color: R.not }}>{p.calisti_gun} gün çalıştı{p.qrsiz_gun ? <span style={{ color: R.amber }}> ({p.qrsiz_gun} gün QR'sız)</span> : ''} · {p.izinli_gun} gün izinli</div>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>}
    </div>
  );
}

// ── 📋 GÜNLÜK YOKLAMA — sahip: "hangi gün hangi şubede QR okutmuş, kim okutmamış, okutan geç mi kalmış — bunu görmek dert" ──
const YOK_DURUM = {
  zamaninda: { ad: 'zamanında', ikon: '✅', renk: R.yesil },
  gec: { ad: 'geç', ikon: '⏰', renk: R.amber },
  okutmadi: { ad: 'QR okutmadı', ikon: '❌', renk: R.kirmizi },
  plansiz: { ad: 'planda yok, geldi', ikon: '➕', renk: 'var(--pi-accent)' },
  bekleniyor: { ad: 'saati gelmedi', ikon: '⌛', renk: R.not },
};
const gunStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function GunlukYoklama() {
  const [gun, setGun] = useState(() => gunStr(new Date()));
  const [kac, setKac] = useState(1);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  useSonIstek(`/evvel-yeni/maas/yoklama?gun=${gun}&gun_sayisi=${kac}`, setV, setHata, true);   // ortak 'son istek kazanır' (T4-09)
  const kaydir = (d) => { const t = new Date(`${gun}T12:00:00`); t.setDate(t.getDate() + d); setGun(gunStr(t)); };
  const gunAd = (g) => new Date(`${g}T12:00:00`).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  const secStil = { font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Günlük yoklama</h1></div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Dugme kucuk onClick={() => kaydir(-1)}>‹ önceki</Dugme>
          <input type="date" value={gun} onChange={(e) => e.target.value && setGun(e.target.value)} style={secStil} />
          <Dugme kucuk onClick={() => kaydir(1)}>sonraki ›</Dugme>
          <Dugme kucuk onClick={() => setGun(gunStr(new Date()))}>Bugün</Dugme>
          <select value={kac} onChange={(e) => setKac(Number(e.target.value))} style={secStil}>
            <option value={1}>yalnız bu gün</option><option value={7}>son 7 gün</option><option value={14}>son 14 gün</option>
          </select>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12.5 }}>{Object.values(YOK_DURUM).map((d) => <span key={d.ad}>{d.ikon} {d.ad}</span>)}</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Yoklama hazırlanıyor…</div>}
      {v?.uyari && <div style={{ ...kart, padding: 12, color: R.kirmizi, fontWeight: 700 }}>{v.uyari}</div>}
      {v && <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>}
      {v && v.gunler.map((g) => (
        <div key={g.gun} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{gunAd(g.gun)}{!g.plan_var && <span style={{ color: R.amber, fontWeight: 500, fontSize: 13 }}> · bu gün için vardiya planı girilmemiş — yalnız QR girişleri</span>}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            {g.subeler.map((s) => (
              <div key={s.sube_id} style={{ ...kart, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, borderTop: `4px solid ${s.ozet.okutmadi ? R.kirmizi : s.ozet.gec ? R.amber : s.kisiler.length ? R.yesil : 'var(--pi-line)'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <b style={{ fontSize: 15 }}>{s.ad}</b>
                  <span style={{ fontSize: 12, color: R.not }}>{s.ozet.gec ? `⏰${s.ozet.gec} ` : ''}{s.ozet.okutmadi ? `❌${s.ozet.okutmadi}` : ''}</span>
                </div>
                {s.kisiler.length === 0 && <div style={{ fontSize: 12.5, color: R.not }}>Plan da QR da yok</div>}
                {s.kisiler.map((k, i) => {
                  const d = YOK_DURUM[k.durum];
                  const vurgu = k.durum === 'okutmadi' || k.durum === 'gec';
                  return (
                    <div key={`${k.personel_id}${i}`} style={{ display: 'grid', gridTemplateColumns: '20px 1fr auto', gap: 6, alignItems: 'center', fontSize: 13, padding: '4px 6px', borderRadius: 7, background: vurgu ? `color-mix(in srgb, ${d.renk} 10%, transparent)` : 'transparent' }}>
                      <span>{d.ikon}</span>
                      <span style={{ minWidth: 0 }}><b>{k.ad}</b>
                        <div style={{ fontSize: 11.5, color: R.not }}>{k.plan ? `plan ${k.plan}` : 'planda yok'}{k.qr_sube && k.qr_sube !== s.ad ? ` · QR: ${k.qr_sube}` : ''}{k.cikis ? ` · çıkış ${k.cikis}` : ''}</div></span>
                      <span style={{ textAlign: 'right', ...num, fontWeight: 700, color: d.renk }}>{k.qr ? `QR ${k.qr}` : '—'}{k.durum === 'gec' && <div style={{ fontSize: 11.5 }}>{k.gec_dk} dk geç</div>}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
