// ─────────────────────────────────────────────────────────────────────────────
// 🚚 EVVEL YENİ · TOPTANCILAR — borç TESLİMDE doğar (şube paneli), tek kayıt
//
// Sahip + Codex + Fable (2026-10-16): fatura gelince AYNI teslimin tutarı kesinleşir (çift sayım yok);
// tutarsız teslimde adet × fiyat TAHMİNİ; ödemeler Ödeme formundan; vadesi geçen ekranda hesaplanır.
// Bütün rakamlar /api/evvel-yeni/toptanci'dan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, Cekmece, fmt, tKisa } from './KasaModulu';

export const TOPTANCI_SAYFALAR = [
  { id: 'toptancilar', ad: 'Toptancılar', alt: 'Borcumuz · vade · teslimler' },
  { id: 'urun_fiyatlari', ad: 'Ürün fiyatları', alt: 'Panel kategorileri · eksik fiyat' },
];

const alan = {
  width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)',
  color: 'var(--pi-ink)', font: 'inherit', fontSize: 15, minWidth: 0,
};
const sayi = (x) => { const t = String(x ?? '').trim().replace(/\s/g, ''); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? n : NaN; };
const gunStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Sahip: "fiyat yok tıklayınca direkt o alana gitsin — köprü olsun"
const fiyataGit = (urunId) => {
  window.history.pushState({}, '', `/evvel-yeni/urun_fiyatlari${urunId ? `?urun=${encodeURIComponent(urunId)}` : '?eksik=1'}`);
  window.dispatchEvent(new window.PopStateEvent('popstate'));
};
const DURUM = {
  kesin: { ad: 'kesin', renk: R.yesil },
  tahmini: { ad: 'tahmini', renk: R.amber },
  bilinmiyor: { ad: 'tutar bilinmiyor', renk: R.kirmizi },
};

export default function ToptanciModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [acik, setAcik] = useState(null);
  const [tutarForm, setTutarForm] = useState(null);   // {h, tutar, fatura_no, sebep}
  const [teslimForm, setTeslimForm] = useState(null); // {t, tutar, tarih, fatura_geldi, fatura_no, aciklama}
  const [mesgul, setMesgul] = useState(false);
  const [ara, setAra] = useState('');
  const [ck, setCk] = useState(null);   // 🔍 "nerede" çekmecesi
  const donus = useRef(null);           // tutar girildikten sonra hangi toptancının izine dönülecek
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api('/evvel-yeni/toptanci/ozet'); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => {   // tutar kaydedildi → aynı toptancının izine geri dön (bağlam kaybolmasın)
    if (!v || !donus.current || tutarForm) return;
    const t = v.toptancilar.find((x) => x.id === donus.current);
    donus.current = null;
    if (t) setCk(toptanciCk(t));
  }, [v, tutarForm]);   // eslint-disable-line react-hooks/exhaustive-deps

  const gonder = async (yol, body, kapat) => {
    setMesgul(true);
    try { const r = await api(yol, { method: 'POST', body }); onToast?.(r.mesaj); kapat?.(); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  const ode = (t) => {
    try { window.sessionStorage.setItem('ey_odeme_on', JSON.stringify({ konu: 'toptanci', toptanci_id: t.id, tutar: t.vadesi_gecen > 0 ? t.vadesi_gecen : 0 })); } catch { /* yut */ }
    window.history.pushState({}, '', '/evvel-yeni/odemeler');
    window.dispatchEvent(new window.PopStateEvent('popstate'));
  };

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Toptancılar okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Toptancılar hazırlanıyor…</div></div>;
  const liste = v.toptancilar.filter((t) => !ara || t.ad.toLocaleLowerCase('tr').includes(ara.toLocaleLowerCase('tr')));
  const T = v.toplam;
  const Kutu = ({ ad, deger, renk, alt, onTikla }) => (
    <button type="button" onClick={onTikla} style={{ ...kart, padding: 12, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'var(--pi-ink)' }}>
      <div style={{ fontSize: 12, color: R.not }}>{ad} <span style={{ color: 'var(--pi-accent)' }}>›</span></div>
      <div style={{ ...num, fontSize: 22, fontWeight: 800, color: renk }}>{deger}</div>
      {alt && <div style={{ fontSize: 11.5, color: R.not }}>{alt}</div>}
    </button>
  );

  // ── 🔍 NEREDE? (Evvel'in ilk kurgusu: "neyin nerede olduğunu bulabilelim") — her rakam tıklanır, iz açılır ──
  const tutarAc = (h, t) => { donus.current = t ? t.id : null; setCk(null); setTutarForm({ h, tutar: h.kesin != null ? String(h.kesin) : '', fatura_no: h.fatura_no || '', sebep: '', kaynak: 'fatura' }); };
  const toptanciCk = (t, geri, filtre) => {
    const sirali = [...t.hareketler].sort((a, b) => (a.tarih < b.tarih ? -1 : a.tarih > b.tarih ? 1 : 0));
    const gorunur = (h) => !filtre || (filtre.sube ? (h.tur === 'teslim' && h.sube === filtre.sube) : filtre.odeme ? h.tur === 'odeme' : true);
    const kendi = () => setCk(toptanciCk(t, geri, filtre));
    const tum = () => setCk(toptanciCk(t, geri));
    let kalan = t.acilis;
    const izSatir = [];
    if (t.acilis) izSatir.push(['—', 'Açılış borcu', '', '', { t: fmt(t.acilis), kalin: true }, '', { t: fmt(kalan), kalin: true }, 'açılış']);
    sirali.forEach((h) => {
      const goster = gorunur(h);
      if (h.tur === 'teslim') {
        if (!h.iptal && h.borc != null) kalan += h.borc;
        if (!goster) return;
        const kalemler = (h.kalemler || []).map((k) => `${k.ad} ×${k.adet}`).join(', ');
        izSatir.push([tKisa(h.tarih), `🚚 teslim${kalemler ? ` · ${kalemler}` : ''}${h.fatura_no ? ` · fatura ${h.fatura_no}` : ''}`,
          `→ ${h.sube}`, h.teslim_alan || '',
          h.borc != null ? { t: `+${fmt(h.borc)}`, renk: h.iptal ? R.not : R.kirmizi } : { t: '?', renk: R.kirmizi }, '',
          { t: fmt(kalan), kalin: true }, h.iptal ? { t: `İPTAL · ${h.iptal_sebep || ''}`, renk: R.not } : { t: DURUM[h.durum].ad, renk: DURUM[h.durum].renk }]);
      } else {
        kalan -= h.tutar;
        if (!goster) return;
        izSatir.push([tKisa(h.tarih), `💸 ödeme · ${h.aciklama || ''}`, `← ${(h.nereden || []).map((n) => `${n.tur === 'kart' ? '💳' : '💵'} ${n.ad} ${fmt(n.tutar)}`).join(' + ') || '—'}`,
          h.kim || '', '', { t: `−${fmt(h.tutar)}`, renk: R.yesil }, { t: fmt(kalan), kalin: true }, 'ödendi']);
      }
    });
    const bilinmeyen = t.hareketler.filter((h) => h.tur === 'teslim' && !h.iptal && (h.durum === 'bilinmiyor' || (h.durum === 'tahmini' && h.fiyat_eksik)));
    return {
      tip: filtre ? `TOPTANCI · ${filtre.sube ? `${filtre.sube}'E GELEN` : 'ÖDEMELER'}` : 'TOPTANCI · NEREDE?', baslik: t.ad,
      geri: filtre ? { ad: `${t.ad} · tümü`, onTikla: tum } : geri,
      alt: `${t.kategori ? `${t.kategori} · ` : ''}${t.vade_gun != null ? `vade ${t.vade_gun} gün` : 'vade tanımsız (Tanımlar → Toptancılar)'}`,
      kpi: [{ etiket: 'Borcumuz', deger: `${fmt(t.bakiye)} ₺`, renk: t.bakiye > 0 ? R.kirmizi : R.yesil },
        { etiket: 'Kesin', deger: fmt(t.kesin) }, { etiket: 'Tahmini', deger: fmt(t.tahmini) }, { etiket: 'Ödenen', deger: fmt(t.odenen) },
        ...(t.acilis ? [{ etiket: 'Açılış', deger: fmt(t.acilis) }] : []),
        ...(t.vadesi_gecen ? [{ etiket: 'Vadesi geçen', deger: fmt(t.vadesi_gecen), renk: R.kirmizi }] : [])],
      not: [bilinmeyen.length ? `${bilinmeyen.length} teslimin tutarı bilinmiyor ya da eksik tahminli — aşağıdan tıklayıp gir` : null,
        t.vadesi_belirsiz ? `${fmt(t.vadesi_belirsiz)} ₺ borcun vadesi tanımsız (açılış ya da vade günü girilmemiş) — Tanımlar → Toptancılar` : null,
        t.sapma_sayi ? `⚠ ${t.sapma_sayi} teslimde kesin tutar tahminden %30+ farklı` : null].filter(Boolean).join(' · ') || null,
      listeBaslik: 'Mal nereye gitti · ödeme nereden çıktı',
      satirlar: [
        ...(t.sube_dagilim || []).map((d) => ({ ad: `📍 ${d.sube}'e gelen mal (${d.sayi} teslim)`, tutar: `${fmt(d.tutar)} ₺`, detay: 'Tıkla → yalnız bu şubenin teslimleri',
          onTikla: () => setCk(toptanciCk(t, { ad: t.ad, onTikla: kendi }, { sube: d.sube })) })),
        ...(t.odeme_dagilim || []).map((d) => ({ ad: `Ödeme · ${d.nereden}`, tutar: `−${fmt(d.tutar)} ₺`, detay: 'Tıkla → yalnız ödemeler',
          onTikla: () => setCk(toptanciCk(t, { ad: t.ad, onTikla: kendi }, { odeme: true })) })),
        ...bilinmeyen.map((h) => ({ ad: `❓ ${tKisa(h.tarih)} ${h.sube} teslimi — ${h.durum === 'bilinmiyor' ? 'tutar yok' : `${h.fiyat_eksik} kalem fiyatsız, tahmin eksik`}`, tutar: 'tutar gir', detay: 'Tıkla → fatura/ekstredeki tutarı gir', onTikla: () => tutarAc(h, t) })),
      ],
      aksiyonlar: [{ ad: 'Öde', birincil: true, onTikla: () => ode(t) },
        { ad: '+ Teslim (merkezden)', onTikla: () => setTeslimForm({ t, tutar: '', tarih: gunStr(new Date()), fatura_geldi: true, fatura_no: '', aciklama: '' }) }],
      tablo: { ad: 'İz', kolonlar: [{ ad: 'Gün' }, { ad: 'Ne', sar: true }, { ad: 'Nereye / nereden', sar: true }, { ad: 'Kim' }, { ad: 'Borç +', sag: true }, { ad: 'Ödeme −', sag: true }, { ad: 'Kalan borç', sag: true }, { ad: 'Durum' }],
        satirlar: izSatir.reverse() },
    };
  };
  const listeCk = (baslik, alt, secici, deger) => {
    const xs = v.toptancilar.filter(secici);
    const kendi = () => setCk(listeCk(baslik, alt, secici, deger));
    return {
      tip: 'TOPTANCILAR', baslik, alt,
      kpi: [{ etiket: 'Toplam', deger: `${fmt(xs.reduce((a, t) => a + deger(t), 0))} ₺` }, { etiket: 'Toptancı', deger: xs.length }],
      listeBaslik: 'Kimde? — tıkla, izini aç',
      satirlar: xs.sort((a, b) => deger(b) - deger(a)).map((t) => ({ ad: t.ad, tutar: `${fmt(deger(t))} ₺`, detay: t.vade_gun != null ? `vade ${t.vade_gun} gün` : '',
        onTikla: () => setCk(toptanciCk(t, { ad: baslik, onTikla: kendi })) })),
    };
  };
  const bilinmeyenCk = () => {
    const xs = v.toptancilar.flatMap((t) => t.hareketler.filter((h) => h.tur === 'teslim' && !h.iptal && (h.durum === 'bilinmiyor' || (h.durum === 'tahmini' && h.fiyat_eksik))).map((h) => ({ t, h })));
    return {
      tip: 'TOPTANCILAR', baslik: 'Tutarı bilinmeyen teslimler', alt: 'Fatura gelmemiş, kâğıtta fiyat yok, sistemde de fiyat yok — fatura ya da ekstre gelince tutarı gir',
      kpi: [{ etiket: 'Teslim', deger: xs.length }],
      satirlar: xs.map(({ t, h }) => ({ ad: `${tKisa(h.tarih)} · ${t.ad} → ${h.sube}${h.durum === 'tahmini' ? ` (${h.fiyat_eksik} kalem fiyatsız)` : ''}`, tutar: 'tutar gir', detay: (h.kalemler || []).map((k) => `${k.ad} ×${k.adet}`).join(', '), onTikla: () => tutarAc(h, t) })),
    };
  };
  // 📍 ŞUBE GÖZÜYLE — hangi şubeye hangi toptancıdan ne geldi
  const subeler = {};
  v.toptancilar.forEach((t) => (t.sube_dagilim || []).forEach((d) => {
    const x = (subeler[d.sube] = subeler[d.sube] || { sube: d.sube, tutar: 0, sayi: 0, toptancilar: [] });
    x.tutar += d.tutar; x.sayi += d.sayi; x.toptancilar.push({ t, tutar: d.tutar, sayi: d.sayi });
  }));
  const subeCk = (x) => ({
    tip: 'ŞUBE GÖZÜYLE', baslik: `${x.sube}'e gelen mal`, alt: 'Toptancılardan teslim alınan (borç doğuran) mal — kesin ya da tahmini tutarla',
    kpi: [{ etiket: 'Toplam', deger: `${fmt(x.tutar)} ₺` }, { etiket: 'Teslim', deger: x.sayi }],
    listeBaslik: 'Hangi toptancıdan?',
    satirlar: x.toptancilar.sort((a, b) => b.tutar - a.tutar).map((y) => ({ ad: `${y.t.ad} (${y.sayi} teslim)`, tutar: `${fmt(y.tutar)} ₺`,
      onTikla: () => setCk(toptanciCk(y.t, { ad: `${x.sube}'e gelen mal`, onTikla: () => setCk(subeCk(x)) }, { sube: x.sube })) })),
  });

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Tedarik</div><h1 style={{ fontSize: 30 }}>Toptancılar</h1></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Kutu ad="Öngörülen borcumuz" deger={`${fmt(T.bakiye)} ₺`} renk={R.kirmizi} alt={`${T.borclu_sayi || 0} toptancıya · tahmine dayalı teslimler ${fmt(T.tahmini)}${T.alacak ? ` · ${fmt(T.alacak)} ₺ alacaklıyız` : ''}`}
          onTikla={() => setCk(listeCk('Öngörülen borcumuz', 'Kime ne kadar borcumuz var (kesin + tahmini − ödenen)', (t) => t.bakiye > 0, (t) => t.bakiye))} />
        <Kutu ad="Vadesi geçen" deger={`${fmt(T.vadesi_gecen)} ₺`} renk={T.vadesi_gecen > 0 ? R.kirmizi : R.yesil}
          onTikla={() => setCk(listeCk('Vadesi geçen', 'Ödemeler en eski borçtan düşüldükten sonra vadesi geçmiş kalan', (t) => t.vadesi_gecen > 0, (t) => t.vadesi_gecen))} />
        <Kutu ad="Bu hafta dolan" deger={`${fmt(T.bu_hafta)} ₺`} renk={T.bu_hafta > 0 ? R.amber : undefined}
          onTikla={() => setCk(listeCk('Bu hafta dolan', '7 gün içinde vadesi dolacak borç', (t) => t.bu_hafta > 0, (t) => t.bu_hafta))} />
        <Kutu ad="Tutarı bilinmeyen teslim" deger={T.bilinmeyen_sayi + (T.eksik_tahmin_sayi || 0)} renk={T.bilinmeyen_sayi || T.eksik_tahmin_sayi ? R.kirmizi : R.yesil}
          alt={T.eksik_tahmin_sayi ? `${T.bilinmeyen_sayi} tutarsız · ${T.eksik_tahmin_sayi} eksik tahminli` : 'fatura/ekstre gelince tutarı gir'}
          onTikla={() => setCk(bilinmeyenCk())} />
        {T.vadesi_belirsiz > 0 && <Kutu ad="Vadesi tanımsız" deger={`${fmt(T.vadesi_belirsiz)} ₺`} renk={R.amber} alt="açılış borcu / vade günü girilmemiş"
          onTikla={() => setCk(listeCk('Vadesi tanımsız', 'Vadesi bilinmediği için vadesi geçen/bu hafta hesabına girmeyen borç — Tanımlar → Toptancılar\'dan vade günü gir', (t) => t.vadesi_belirsiz > 0, (t) => t.vadesi_belirsiz))} />}
      </div>
      {Object.keys(subeler).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <b style={{ fontSize: 13 }}>📍 Şube gözüyle:</b>
          {Object.values(subeler).sort((a, b) => b.tutar - a.tutar).map((x) => (
            <Dugme key={x.sube} kucuk onClick={() => setCk(subeCk(x))}>{x.sube} · {fmt(x.tutar)} ₺ ({x.sayi})</Dugme>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not} Vade günü ve açılış borcu: Tanımlar → Toptancılar.</div>
      <input placeholder="Toptancı ara…" value={ara} onChange={(e) => setAra(e.target.value)} style={{ ...alan, maxWidth: 320 }} />
      <div style={{ ...kart, overflow: 'hidden' }}>
        {liste.map((t) => (
          <div key={t.id} style={{ borderBottom: '1px solid var(--pi-line)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', cursor: 'pointer' }} onClick={() => setAcik(acik === t.id ? null : t.id)}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <b>{t.ad}</b>{!t.aktif && <Cip>pasif</Cip>}
                <div style={{ fontSize: 12, color: R.not }}>{[t.kategori, t.vade_gun != null ? `vade ${t.vade_gun} gün` : 'vade tanımsız', t.son_hareket ? `son ${tKisa(t.son_hareket)}` : 'hareket yok'].filter(Boolean).join(' · ')}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                  {t.vadesi_gecen > 0 && <Cip tur="kirmizi">vadesi geçen {fmt(t.vadesi_gecen)}</Cip>}
                  {t.bu_hafta > 0 && <Cip tur="sari">bu hafta {fmt(t.bu_hafta)}</Cip>}
                  {t.bilinmeyen_sayi > 0 && <Cip tur="kirmizi">{t.bilinmeyen_sayi} teslimin tutarı yok</Cip>}
                  {t.eksik_tahmin_sayi > 0 && <Cip tur="sari">{t.eksik_tahmin_sayi} teslimde fiyatsız kalem</Cip>}
                  {t.vadesi_belirsiz > 0 && <Cip>vadesi tanımsız {fmt(t.vadesi_belirsiz)}</Cip>}
                  {t.sapma_sayi > 0 && <Cip tur="sari">⚠ {t.sapma_sayi} tutar tahminden %30+ farklı</Cip>}
                </div>
              </div>
              <div style={{ fontSize: 12, color: R.not, textAlign: 'right' }}>açılış {fmt(t.acilis)} · kesin {fmt(t.kesin)} · tahmini {fmt(t.tahmini)}<br />ödenen {fmt(t.odenen)}</div>
              <div style={{ ...num, fontWeight: 800, fontSize: 18, minWidth: 110, textAlign: 'right', color: t.bakiye > 0 ? R.kirmizi : t.bakiye < 0 ? R.amber : R.yesil }}>{fmt(t.bakiye)} ₺</div>
              <span style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                <Dugme kucuk onClick={() => setCk(toptanciCk(t))}>🔍 Nerede?</Dugme>
                <Dugme kucuk onClick={() => setTeslimForm({ t, tutar: '', tarih: gunStr(new Date()), fatura_geldi: true, fatura_no: '', aciklama: '' })}>+ Teslim</Dugme>
                <Dugme ana kucuk onClick={() => ode(t)}>Öde</Dugme>
              </span>
            </div>
            {acik === t.id && (
              <div style={{ padding: '0 14px 12px' }}>
                {t.bakiye < 0 && <div style={{ fontSize: 12.5, color: R.amber, marginBottom: 6 }}>Bakiye eksi: ödenen, borçtan fazla — açılış borcu ya da bir teslim girilmemiş olabilir.</div>}
                {t.hareketler.length === 0 ? <div style={{ fontSize: 13, color: R.not }}>Hareket yok.</div> : (
                  <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}><tbody>
                    {t.hareketler.map((h) => {
                      const d = DURUM[h.durum];
                      return (
                        <tr key={h.id} style={{ borderTop: '1px solid var(--pi-line)', opacity: h.iptal ? 0.45 : 1, verticalAlign: 'top' }}>
                          <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{tKisa(h.tarih)}</td>
                          <td style={{ padding: '6px 8px' }}>
                            {h.tur === 'teslim' ? <>
                              🚚 teslim · {h.sube}{h.teslim_alan ? ` · ${h.teslim_alan}` : ''} {h.fatura_geldi === true ? <Cip tur="yesil">faturalı{h.fatura_no ? ` ${h.fatura_no}` : ''}</Cip> : h.fatura_geldi === false ? <Cip>faturasız</Cip> : null}
                              {(h.kalemler || []).length > 0 && <div style={{ fontSize: 11.5, color: R.not }}>{h.kalemler.map((k, i) => (
                                <span key={i}>{i > 0 ? ' · ' : ''}{k.ad} ×{k.adet}{k.birim != null ? ` @${fmt(k.birim)}`
                                  : <button type="button" onClick={() => fiyataGit(k.urun_id)} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: R.kirmizi, textDecoration: 'underline', cursor: 'pointer' }}> (fiyat yok → gir)</button>}</span>))}</div>}
                              {h.tahmini != null && h.kesin != null && <div style={{ fontSize: 11.5, color: h.sapma_uyari ? R.kirmizi : R.not }}>tahmin {fmt(h.tahmini)} → kesin {fmt(h.kesin)}{h.sapma != null ? ` (%${h.sapma})` : ''}{h.sapma_uyari ? ' ⚠ birim (koli/adet) karışmış olabilir' : ''}</div>}
                              {h.vade && <div style={{ fontSize: 11.5, color: R.not }}>vade {tKisa(h.vade)}</div>}
                              {h.aciklama && <div style={{ fontSize: 11.5, color: R.not }}>{h.aciklama}</div>}
                              {(h.iz || []).map((z, i) => <div key={i} style={{ fontSize: 11, color: R.not }}>✎ {z.zaman} {z.kim}: {z.eski != null ? `${fmt(z.eski)} → ` : ''}{fmt(z.yeni)} · {z.sebep}</div>)}
                              {h.iptal && <span style={{ color: R.kirmizi }}> · İPTAL ({h.iptal_sebep})</span>}
                            </> : <>💸 ödeme · {h.aciklama}{h.kartla ? ' · 💳' : ''}</>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {h.tur === 'teslim'
                              ? <><b style={{ ...num, color: d.renk }}>{h.borc != null ? `+${fmt(h.borc)}` : '?'}</b><div style={{ fontSize: 11, color: d.renk }}>{d.ad}{h.fiyat_eksik ? <button type="button" onClick={() => fiyataGit(null)} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: R.kirmizi, textDecoration: 'underline', cursor: 'pointer' }}> · {h.fiyat_eksik} kalem fiyatsız →</button> : ''}</div></>
                              : <b style={{ ...num, color: R.yesil }}>−{fmt(h.tutar)}</b>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {h.tur === 'teslim' && !h.iptal && <span style={{ display: 'inline-flex', gap: 4 }}>
                              <Dugme kucuk ana={h.durum !== 'kesin'} onClick={() => setTutarForm({ h, tutar: h.kesin != null ? String(h.kesin) : '', fatura_no: h.fatura_no || '', sebep: '' })}>{h.durum === 'kesin' ? 'Düzelt' : 'Tutar gir'}</Dugme>
                              <Dugme kucuk onClick={() => { const s = window.prompt('Bu teslim neden iptal ediliyor?'); if (s) gonder(`/evvel-yeni/toptanci/teslim/${h.id}/iptal`, { sebep: s }); }}>İptal</Dugme>
                            </span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody></table>
                )}
              </div>
            )}
          </div>
        ))}
        {liste.length === 0 && <div style={{ padding: 14, color: R.not }}>Toptancı yok.</div>}
      </div>

      <Cekmece v={ck} onKapat={() => setCk(null)} />
      {tutarForm && (
        <Pencere baslik={`🧾 Tutar — ${tKisa(tutarForm.h.tarih)} ${tutarForm.h.sube}`} onKapat={() => !mesgul && setTutarForm(null)}>
          {tutarForm.h.tahmini != null && <div style={{ fontSize: 13, color: R.not }}>Sistemin tahmini: {fmt(tutarForm.h.tahmini)} ₺</div>}
          <Etiket ad="Fatura / ekstredeki tutar ₺ *"><input style={alan} inputMode="decimal" autoFocus value={tutarForm.tutar} onChange={(e) => setTutarForm({ ...tutarForm, tutar: e.target.value })} /></Etiket>
          <Etiket ad="Bu tutar nereden?"><select style={alan} value={tutarForm.kaynak} onChange={(e) => setTutarForm({ ...tutarForm, kaynak: e.target.value })}>
            <option value="fatura">Fatura geldi</option><option value="ekstre">Fatura yok — ekstre / fiş / toptancıdan öğrenildi</option></select></Etiket>
          {tutarForm.kaynak === 'fatura' && <Etiket ad="Fatura no"><input style={alan} value={tutarForm.fatura_no} onChange={(e) => setTutarForm({ ...tutarForm, fatura_no: e.target.value })} /></Etiket>}
          {tutarForm.h.kesin != null && <Etiket ad="Neden değişiyor? *"><input style={alan} value={tutarForm.sebep} onChange={(e) => setTutarForm({ ...tutarForm, sebep: e.target.value })} /></Etiket>}
          <Butonlar mesgul={mesgul} onVazgec={() => setTutarForm(null)} onKaydet={() => {
            const t = sayi(tutarForm.tutar);
            if (!(t > 0)) { onToast?.('Tutar gir'); return; }
            gonder(`/evvel-yeni/toptanci/teslim/${tutarForm.h.id}/tutar`, { tutar: t, fatura_geldi: tutarForm.kaynak === 'fatura', fatura_no: tutarForm.kaynak === 'fatura' ? (tutarForm.fatura_no || null) : null, sebep: tutarForm.sebep || (tutarForm.kaynak === 'fatura' ? null : 'ekstre/fiş') }, () => setTutarForm(null));
          }} />
        </Pencere>
      )}
      {teslimForm && (
        <Pencere baslik={`🚚 ${teslimForm.t.ad} — teslim (merkezden)`} onKapat={() => !mesgul && setTeslimForm(null)}>
          <div style={{ fontSize: 12.5, color: R.not }}>Şubeler teslimi panelden girer. Bu form panel dışı gelen mal ya da unutulan teslim için.</div>
          <Etiket ad="Tutar ₺ (bilinmiyorsa boş)"><input style={alan} inputMode="decimal" autoFocus value={teslimForm.tutar} onChange={(e) => setTeslimForm({ ...teslimForm, tutar: e.target.value })} /></Etiket>
          <Etiket ad="Tarih"><input style={alan} type="date" max={gunStr(new Date())} value={teslimForm.tarih} onChange={(e) => setTeslimForm({ ...teslimForm, tarih: e.target.value })} /></Etiket>
          <Etiket ad="Fatura geldi mi?"><select style={alan} value={teslimForm.fatura_geldi ? '1' : '0'} onChange={(e) => setTeslimForm({ ...teslimForm, fatura_geldi: e.target.value === '1' })}><option value="1">Evet</option><option value="0">Hayır</option></select></Etiket>
          {teslimForm.fatura_geldi && <Etiket ad="Fatura no"><input style={alan} value={teslimForm.fatura_no} onChange={(e) => setTeslimForm({ ...teslimForm, fatura_no: e.target.value })} /></Etiket>}
          <Etiket ad="Açıklama"><input style={alan} value={teslimForm.aciklama} onChange={(e) => setTeslimForm({ ...teslimForm, aciklama: e.target.value })} /></Etiket>
          <Butonlar mesgul={mesgul} onVazgec={() => setTeslimForm(null)} onKaydet={() => {
            const t = sayi(teslimForm.tutar);
            if (Number.isNaN(t) || (t != null && t <= 0)) { onToast?.('Tutar sayı olmalı'); return; }
            gonder('/evvel-yeni/toptanci/teslim', { toptanci_id: teslimForm.t.id, tarih: teslimForm.tarih, tutar: t, fatura_geldi: teslimForm.fatura_geldi, fatura_no: teslimForm.fatura_no || null, aciklama: teslimForm.aciklama || null }, () => setTeslimForm(null));
          }} />
        </Pencere>
      )}
    </div>
  );
}

function Pencere({ baslik, onKapat, children }) {
  return (
    <div onClick={onKapat} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
      <div style={{ ...kart, padding: 18, width: 'min(440px, 100%)', display: 'flex', flexDirection: 'column', gap: 12 }} onClick={(e) => e.stopPropagation()}>
        <b style={{ fontSize: 17 }}>{baslik}</b>{children}
      </div>
    </div>
  );
}
function Etiket({ ad, children }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13, fontWeight: 600, color: R.metin2 }}>{ad}{children}</label>;
}
function Butonlar({ mesgul, onVazgec, onKaydet }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Dugme kucuk onClick={onVazgec} disabled={mesgul}>Vazgeç</Dugme>
      <Dugme ana onClick={onKaydet} disabled={mesgul}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</Dugme>
    </div>
  );
}

// ── 🏷️ ÜRÜN FİYATLARI — sahip (2026-10-16): "paneldeki kategori şekliyle ürün fiyatlarını kur, benzer olsun;
//    fiyatı olmayan ürünleri manuel girebilelim" ──
const KAYNAK_RENK = { elle: 'var(--pi-accent)', 'son alış': R.yesil, katalog: R.amber };
export function UrunFiyatlari({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [kat, setKat] = useState(null);
  const [sadeceEksik, setSadeceEksik] = useState(false);
  const [duz, setDuz] = useState(null);   // {u, deger}
  const [mesgul, setMesgul] = useState(false);
  const [evren, setEvrenS] = useState(() => { try { return localStorage.getItem('ey_fiyat_evren') || ''; } catch { return ''; } });
  const setEvren = (x) => { try { localStorage.setItem('ey_fiyat_evren', x); } catch { /* yok */ } setEvrenS(x); setV(null); setKat(null); };
  const yukle = useCallback(async () => {
    try {
      const r = await api('/evvel-yeni/toptanci/fiyatlar' + (evren ? `?evren=${evren}` : '')); setV(r); setHata(null);
      const q = new window.URLSearchParams(window.location.search);
      const hedef = q.get('urun');
      const hk = hedef && r.kategoriler.find((k) => k.urunler.some((u) => u.id === hedef));
      if (hk) {
        const u = hk.urunler.find((x) => x.id === hedef);
        setKat(hk.id); setDuz({ u, deger: u.elle != null ? String(u.elle) : '' });
      } else {
        if (q.get('eksik')) { setSadeceEksik(true); setKat((k) => k || (r.kategoriler.find((x) => x.eksik) || r.kategoriler[0])?.id); }
        else setKat((k) => k || r.kategoriler[0]?.id);
      }
      if (hedef || q.get('eksik')) window.history.replaceState({}, '', window.location.pathname);
    }
    catch (e) { setHata(e?.message || 'okunamadı'); }
  }, [evren]);
  useEffect(() => { yukle(); }, [yukle]);
  const kaydet = async (birim) => {
    setMesgul(true);
    try { const r = await api('/evvel-yeni/toptanci/fiyat', { method: 'POST', body: { urun_id: duz.u.id, birim } }); onToast?.(r.mesaj); setDuz(null); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Fiyatlar okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Fiyatlar hazırlanıyor…</div></div>;
  const secili = v.kategoriler.find((k) => k.id === kat) || v.kategoriler[0];
  const urunler = (secili?.urunler || []).filter((u) => !sadeceEksik || u.gecerli == null);
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Tedarik</div><h1 style={{ fontSize: 30 }}>Ürün fiyatları</h1></div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {v.eksik > 0 && <Cip tur="kirmizi">{v.eksik} / {v.toplam} ürünün fiyatı yok</Cip>}
          <label style={{ fontSize: 13, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={sadeceEksik} onChange={(e) => setSadeceEksik(e.target.checked)} />yalnız fiyatı olmayanlar</label>
        </span>
      </div>
      <div style={{ ...kart, padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ color: R.not }}>Katalog:</span>
        <b style={{ color: v.evren === 'yeni' ? R.yesil : R.not }}>{v.evren === 'yeni' ? '🆕 Yeni katalog (Evvel Yeni)' : '🔁 Geçiş — eski katalog'}</b>
        <span style={{ flex: 1 }} />
        <Dugme kucuk onClick={() => setEvren(v.evren === 'yeni' ? 'eski' : 'yeni')}>{v.evren === 'yeni' ? 'Eski kataloğa dön' : 'Yeni kataloğa geç'}</Dugme>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {v.kategoriler.map((k) => (
          <button key={k.id} type="button" onClick={() => setKat(k.id)} style={{
            font: 'inherit', fontWeight: 700, fontSize: 14, padding: '9px 14px', borderRadius: 12, cursor: 'pointer',
            border: `1px solid ${secili?.id === k.id ? 'var(--pi-accent)' : 'var(--pi-line)'}`,
            background: secili?.id === k.id ? 'var(--pi-accent)' : 'var(--pi-paper)', color: secili?.id === k.id ? 'var(--pi-on-accent)' : 'var(--pi-ink)',
          }}>{k.emoji ? `${k.emoji} ` : ''}{k.ad}{k.eksik ? <span style={{ marginLeft: 6, background: R.kirmizi, color: '#fff', borderRadius: 99, padding: '0 7px', fontSize: 11.5 }}>{k.eksik}</span> : null}</button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
        {urunler.map((u) => (
          <button key={u.id} type="button" onClick={() => setDuz({ u, deger: u.elle != null ? String(u.elle) : '' })} style={{
            ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'var(--pi-ink)', padding: 12, minHeight: 92,
            display: 'flex', flexDirection: 'column', gap: 4, border: u.gecerli == null ? `2px solid ${R.kirmizi}` : kart.border,
          }}>
            <b style={{ fontSize: 14, lineHeight: 1.2 }}>{u.ad}</b>
            {u.gecerli != null
              ? <span style={{ ...num, fontSize: 20, fontWeight: 800 }}>{fmt(u.gecerli)} ₺<span style={{ fontSize: 12, fontWeight: 600, color: R.not }}> / {u.birim || 'adet'}</span></span>
              : <span style={{ color: R.kirmizi, fontWeight: 700 }}>fiyat yok — gir</span>}
            {u.koli && u.gecerli != null && <span style={{ fontSize: 11.5, color: R.not }}>1 koli ({u.koli} adet) = {fmt(u.gecerli * u.koli)} ₺</span>}
            {u.kaynak && <span style={{ fontSize: 11.5, color: KAYNAK_RENK[u.kaynak] }}>{u.kaynak}{u.kaynak === 'son alış' && u.son_alis?.kdv_yok ? ' (KDV oranı yok)' : ''}</span>}
            {u.toptanci.length > 0 && <span style={{ fontSize: 11, color: R.not }}>{u.toptanci.map((t) => `${t.toptanci}: ${fmt(t.birim)}`).join(' · ')}</span>}
          </button>
        ))}
        {urunler.length === 0 && <div style={{ color: R.not, fontSize: 13 }}>{sadeceEksik ? 'Bu kategoride fiyatı olmayan ürün yok ✓' : 'Ürün yok.'}</div>}
      </div>
      {duz && (
        <div onClick={() => !mesgul && setDuz(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div style={{ ...kart, padding: 18, width: 'min(420px, 100%)', display: 'flex', flexDirection: 'column', gap: 10 }} onClick={(e) => e.stopPropagation()}>
            <b style={{ fontSize: 17 }}>🏷️ {duz.u.ad}</b>
            <div style={{ fontSize: 13, color: R.not, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>Son alış: {duz.u.son_alis ? `${fmt(duz.u.son_alis.birim)} ₺${duz.u.son_alis.tarih ? ` (${tKisa(duz.u.son_alis.tarih)})` : ''}` : 'yok'}</span>
              <span>Katalog: {duz.u.katalog != null ? `${fmt(duz.u.katalog)} ₺` : 'yok'}</span>
              {duz.u.elle != null && <span>Elle girilen: {fmt(duz.u.elle)} ₺{duz.u.elle_kim ? ` · ${duz.u.elle_kim}` : ''}</span>}
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13, fontWeight: 600 }}>1 {(duz.u.birim || 'adet').toUpperCase()} fiyatı ₺ (KDV dahil){duz.u.koli ? ` — kolide ${duz.u.koli} adet var, koli fiyatını ${duz.u.koli}'e böl` : ''}
              <input autoFocus inputMode="decimal" value={duz.deger} onChange={(e) => setDuz({ ...duz, deger: e.target.value })}
                style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 18 }} /></label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {duz.u.elle != null && <Dugme kucuk disabled={mesgul} onClick={() => kaydet(null)}>Elle fiyatı kaldır</Dugme>}
              <Dugme kucuk disabled={mesgul} onClick={() => setDuz(null)}>Vazgeç</Dugme>
              <Dugme ana disabled={mesgul} onClick={() => {
                const t = String(duz.deger).trim().replace(/\s/g, ''); const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
                if (!(n > 0)) { onToast?.('Fiyat yaz'); return; }
                kaydet(n);
              }}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</Dugme>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
