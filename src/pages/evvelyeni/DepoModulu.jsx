// ─────────────────────────────────────────────────────────────────────────────
// 📦 EVVEL YENİ · DEPO — tek hareket defteri; "Nerede?" ürün × konum; her hücre tıklanır → iz
//
// Sahip (2026-10-17): "depo takip — eski Evvel'in karışıklığını anla, sade ama işlevselliği ve takibi aynı."
// Codex + Fable kurgusu: tek defter, eksi kırpılmaz, kör sayım fark hareketi, Tema'da ürün aç depodan düşer (sahip: 2).
// Bütün rakamlar /api/evvel-yeni/depo'dan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { ALAN, Cekmece, Cip, Dugme, kart, num, PI_CSS, R, sor, tKisa } from './KasaModulu';
import { yeniIstekId as yeniIstek } from '../../utils/cihazImza';

export const DEPO_SAYFALAR = [
  { id: 'depo_nerede', ad: 'Depo — Nerede?', alt: 'Ürün × konum · tıkla → iz' },
  { id: 'depo_sevk', ad: 'Sevk et', alt: 'Merkez depodan şubeye paket' },
  { id: 'depo_yolda', ad: 'Yoldakiler', alt: 'Yalnız kabul bekleyen sevkler' },
  { id: 'depo_fark', ad: 'Sevk farkları', alt: 'Eksik / fazla gelen · çözüm' },
  { id: 'depo_sayim', ad: 'Depo sayımı', alt: 'Kör sayım · açılış sayımı' },
];

const alan = { ...ALAN, width: '100%', borderRadius: 9, minWidth: 0 };   // temel stil KasaModulu ALAN (T4-15)

// Kimlik evreni (Fable altyapı denetimi): 1 Kasım'dan itibaren YENİ katalog (sunucu kendisi seçer); öncesinde geçiş (eski aktarım).
// Merkez 1 Kasım'dan önce "Yeni katalog" görünümüne geçip yeni kimlikle açılış sayımı yapabilir. Seçim bu tarayıcıda hatırlanır.
const evrenOku = () => { try { return localStorage.getItem('ey_depo_evren') || ''; } catch { return ''; } };
function useOzet() {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [evren, setEvrenS] = useState(evrenOku);
  const setEvren = (x) => { try { localStorage.setItem('ey_depo_evren', x); } catch { /* yok */ } setEvrenS(x); setV(null); };
  const yukle = useCallback(async () => {
    try {
      const r = await api('/evvel-yeni/depo/ozet' + (evren ? `?evren=${evren}` : ''));
      if (r.varsayilan_evren === 'yeni' && evren) {   // Fable: 1 Kasım'dan sonra eski seçim yapışık kalmasın
        try { localStorage.removeItem('ey_depo_evren'); } catch { /* yok */ }
        setEvrenS(''); return;
      }
      setV(r); setHata(null);
    } catch (e) { setHata(e?.message || 'okunamadı'); }
  }, [evren]);
  useEffect(() => { yukle(); }, [yukle]);
  return [v, hata, yukle, setEvren];
}

function EvrenSecimi({ v, setEvren }) {
  if (!v) return null;
  const yeni = v.evren === 'yeni';
  return (
    <div style={{ ...kart, padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
      <span style={{ color: R.not }}>Katalog:</span>
      <b style={{ color: yeni ? R.yesil : R.not }}>{yeni ? '🆕 Yeni katalog (Evvel Yeni ürün kimlikleri)' : '🔁 Geçiş — eski sistemden aktarılan kayıtlar'}</b>
      <span style={{ flex: 1 }} />
      {v.varsayilan_evren !== 'yeni' && <Dugme kucuk onClick={() => setEvren(yeni ? 'eski' : 'yeni')}>{yeni ? 'Geçiş görünümüne dön' : 'Yeni kataloğa geç (1 Kasım açılış sayımı)'}</Dugme>}
    </div>
  );
}

export default function DepoModulu({ gorunum, onToast }) {
  if (gorunum === 'depo_sevk') return <SevkEt onToast={onToast} />;
  if (gorunum === 'depo_yolda') return <Yoldakiler onToast={onToast} mod="yolda" />;
  if (gorunum === 'depo_fark') return <Yoldakiler onToast={onToast} mod="fark" />;
  if (gorunum === 'depo_sayim') return <DepoSayim onToast={onToast} />;
  return <Nerede />;
}

function Nerede() {
  const [v, hata, yukle, setEvren] = useOzet();
  const [ara, setAra] = useState('');
  const [sadeceEksi, setSadeceEksi] = useState(false);
  const [ck, setCk] = useState(null);
  const izAc = async (s, k) => {
    try {
      const r = await api(`/evvel-yeni/depo/iz?urun_id=${encodeURIComponent(s.urun_id)}&konum=${encodeURIComponent(k.id)}`);
      setCk({
        tip: 'DEPO · NEREDE?', baslik: `${s.ad} · ${k.ad}`,
        alt: 'Bu ürünün bu konumdaki bütün hareketleri — en yeni üstte; kalan satır satır yürür.',
        kpi: [{ etiket: 'Kalan', deger: `${r.kalan} adet`, renk: r.kalan < 0 ? R.kirmizi : undefined },
          ...(s.eski?.[k.id] != null ? [{ etiket: 'Eski sistem diyor', deger: `${s.eski[k.id]} adet` }] : [])],
        not: r.kalan < 0 ? 'Eksi: bu konuma giriş (teslim al / kabul) girilmemiş ya da açılış sayımı yapılmamış olabilir.' : null,
        varsayilan: 'iz',
        tablo: {
          ad: 'İz', kolonlar: [{ ad: 'Gün' }, { ad: 'Ne', sar: true }, { ad: 'Nereden / nereye', sar: true }, { ad: 'Kim' }, { ad: 'Adet', sag: true }, { ad: 'Kalan', sag: true }],
          satirlar: r.iz.map((x) => [tKisa(x.gun), `${x.aciklama && x.aciklama !== x.tur ? x.aciklama : (IZ_TUR_AD[x.tur] || x.tur)}${x.iptal ? ` · İPTAL (${x.iptal_sebep || ''})` : ''}`, x.karsi, x.kim || '',
            // B81: kod adı ('ac') yerine Türkçe · iptal satırı kalanı değiştirmez → adet üstü çizili gösterilir (eklendi sanılmasın)
            { t: x.iptal ? `(${x.d > 0 ? '+' : ''}${x.d}) iptal` : `${x.d > 0 ? '+' : ''}${x.d}`, renk: x.iptal ? R.not : x.d > 0 ? R.yesil : R.kirmizi }, { t: String(x.kalan), kalin: true, renk: x.kalan < 0 ? R.kirmizi : undefined }]),
        },
      });
    } catch (e) { setCk({ tip: 'DEPO', baslik: 'İz okunamadı', not: e?.message }); }
  };
  const satirlar = useMemo(() => (v ? v.satirlar.filter((s) => (!ara || s.ad.toLocaleLowerCase('tr').includes(ara.toLocaleLowerCase('tr')))
    && (!sadeceEksi || s.eksi.length)) : []), [v, ara, sadeceEksi]);
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Depo okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Depo hesaplanıyor (ilk açılışta panel kayıtları aktarılıyor)…</div></div>;
  let sonKat = null;
  const hucre = { padding: '5px 8px', borderTop: '1px solid var(--pi-line)', fontSize: 13 };
  const subeK = v.konumlar.filter((k) => k.id.startsWith('depo:') || k.id.startsWith('bar:'));   // sahip: yolda / askıda kendi sekmesinde, burada karışmasın
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Depo — Nerede?</h1></div>
        <EvrenSecimi v={v} setEvren={setEvren} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {v.eksi_sayi > 0 && <Cip tur="kirmizi">{v.eksi_sayi} hücre eksi</Cip>}
          <label style={{ fontSize: 13, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={sadeceEksi} onChange={(e) => setSadeceEksi(e.target.checked)} />yalnız eksiler</label>
          <input placeholder="Ürün ara…" value={ara} onChange={(e) => setAra(e.target.value)} style={{ ...alan, width: 180 }} />
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {v.konumlar.filter((k) => k.id.startsWith('depo:') || k.id.startsWith('bar:')).map((k) => (
          <Cip key={k.id} tur={k.acilis_sayimi ? 'yesil' : 'sari'}>{k.ad}: {k.acilis_sayimi ? `açılış sayımı var${k.son_sayim ? ` · son ${tKisa(k.son_sayim)}` : ''}` : 'açılış sayımı YOK'}</Cip>
        ))}
      </div>
      <div style={{ ...kart, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760 }}>
          <thead><tr style={{ fontSize: 12, color: R.metin2, textAlign: 'right' }}>
            <th style={{ ...hucre, textAlign: 'left', borderTop: 'none' }}>Ürün</th>
            {subeK.map((k) => <th key={k.id} style={{ ...hucre, borderTop: 'none' }}>{k.ad}</th>)}
          </tr></thead>
          <tbody>{satirlar.map((s) => {
            const baslik = s.kategori !== sonKat ? s.kategori : null;
            sonKat = s.kategori;
            return (
              <React.Fragment key={s.urun_id}>
                {baslik && <tr><td colSpan={subeK.length + 1} style={{ ...hucre, fontWeight: 800, background: 'var(--pi-bg)' }}>{baslik}</td></tr>}
                <tr>
                  <td style={{ ...hucre, textAlign: 'left' }}>{s.ad}</td>
                  {subeK.map((k) => {
                    const b = s.bakiye[k.id];
                    return (
                      <td key={k.id} style={{ ...hucre, textAlign: 'right', padding: 2 }}>
                        <button type="button" onClick={() => izAc(s, k)} title={s.eski?.[k.id] != null ? `eski sistem: ${s.eski[k.id]}` : 'İzi aç'} style={{
                          width: '100%', border: 'none', background: b < 0 ? `color-mix(in srgb, ${R.kirmizi} 14%, transparent)` : 'transparent', cursor: 'pointer',
                          font: 'inherit', ...num, fontWeight: b ? 700 : 400, color: b < 0 ? R.kirmizi : b ? 'var(--pi-ink)' : R.not, padding: '4px 6px', borderRadius: 6, textAlign: 'right',
                        }}>{b || '·'}</button>
                      </td>
                    );
                  })}
                </tr>
              </React.Fragment>
            );
          })}</tbody>
        </table>
      </div>
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}

function Yoldakiler({ onToast, mod }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [evren, setEvren] = useState('');   // '' = sunucu seçer · 'eski' = geçiş (eski sistemden kalan açık sevkler) · 'yeni'
  const yukle = useCallback(async () => {
    try { setV(await api('/evvel-yeni/depo/yolda' + (evren ? `?evren=${evren}` : ''))); setHata(null); } catch (e) { setHata(e?.message || 'okunamadı'); }
  }, [evren]);
  useEffect(() => { yukle(); }, [yukle]);
  const kabul = async (x) => {
    if (!(await sor({ soru: `${x.urun} (${x.sevk} adet) → ${x.nereye}\nŞube kabul etmedi. Merkez adına SEVK ADEDİYLE kabul edilsin mi?`, tamam: 'Merkez adına kabul et' }))) return;
    try { const r = await api(`/evvel-yeni/depo/yolda/${encodeURIComponent(x.id)}/merkez-kabul`, { method: 'POST', body: {} }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  const coz = async (x, karar, soru) => {
    if (!(await sor({ soru, tamam: 'Evet, böyle kapat' }))) return;
    try { const r = await api(`/evvel-yeni/depo/yolda/${encodeURIComponent(x.id)}/fark-coz`, { method: 'POST', body: { karar } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>{hata}</div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Yoldakiler okunuyor…</div></div>;
  const hucre = { padding: '7px 9px', borderTop: '1px solid var(--pi-line)', fontSize: 13 };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>{mod === 'fark' ? 'Sevk farkları' : 'Yoldakiler'}</h1></div>
      <div style={{ ...kart, padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ color: R.not }}>Gösterilen:</span>
        <b>{v.evren === 'yeni' ? '🆕 Yeni sevkler (Sevk et)' : '🔁 Eski sistemden gelen sevkler (geçiş)'}</b>
        <span style={{ flex: 1 }} />
        <Dugme kucuk onClick={() => { setV(null); setEvren(v.evren === 'yeni' ? 'eski' : 'yeni'); }}>{v.evren === 'yeni' ? 'Eski açık sevklere bak' : 'Yeni sevklere bak'}</Dugme>
      </div>
      {mod === 'yolda' && (<div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>🚚 Kabul bekleyen sevkler {v.gec_sayi > 0 && <Cip tur="kirmizi">{v.gec_sayi} kalem {v.gec_gun}+ gündür yolda</Cip>}</div>
        {v.bekleyen.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Yolda mal yok ✓</div> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
            {v.bekleyen.map((x) => (
              <tr key={x.id} style={{ background: x.gec ? `color-mix(in srgb, ${R.kirmizi} 8%, transparent)` : undefined }}>
                <td style={{ ...hucre, whiteSpace: 'nowrap' }}>{x.sevk_gunu ? tKisa(x.sevk_gunu) : '—'}<div style={{ fontSize: 11.5, color: x.gec ? R.kirmizi : R.not }}>{x.gun} gün</div></td>
                <td style={hucre}><b>{x.urun}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.nereden} → {x.nereye}</div>
                  <div style={{ fontSize: 11.5, color: R.not }}>📤 Gönderen: <b>{x.sevk_eden || '—'}</b></div></td>
                <td style={{ ...hucre, textAlign: 'right', ...num, fontWeight: 700 }}>{x.sevk} adet</td>
                <td style={{ ...hucre, textAlign: 'right' }}><Dugme kucuk onClick={() => kabul(x)}>Merkez adına kabul</Dugme></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>)}
      {mod === 'fark' && (<div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>⚖️ Sevk ≠ kabul — eksik gelen yolda bekler, fazla gelen askıda bekler; karar verince kapanır</div>
        {v.fark.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Fark yok ✓</div> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
            {v.fark.map((x) => (
              <tr key={x.id}>
                <td style={{ ...hucre, whiteSpace: 'nowrap' }}>{x.sevk_gunu ? tKisa(x.sevk_gunu) : '—'}</td>
                <td style={hucre}><b>{x.urun}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.nereden} → {x.nereye}</div>
                  <div style={{ fontSize: 11.5, color: R.not }}>📤 Gönderen: <b>{x.sevk_eden || '—'}</b> · 📥 Kabul eden: <b>{x.kabul_eden || '—'}</b>{x.merkez_kabul ? ' (merkez adına — şube saymadı)' : ''}</div></td>
                <td style={{ ...hucre, textAlign: 'right', whiteSpace: 'nowrap', ...num }}>sevk {x.sevk} · kabul {x.kabul + Math.max(0, x.fazla)}</td>{/* Y12 (sim 24 Eki): rakamlar alt alta kırılıyordu */}
                <td style={{ ...hucre, textAlign: 'right', color: x.fazla > 0 || x.hasar > 0 ? R.amber : R.kirmizi, fontWeight: 700 }}>
                  {x.hasar > 0 ? <>{x.hasar} adet HASARLI geldi — ASKIDA
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
                      <Dugme kucuk onClick={() => coz(x, 'hasar_fire', `${x.urun}: ${x.hasar} hasarlı adet FİRE yazılsın mı?`)}>Fire yaz</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'hasar_iade', `${x.urun}: ${x.hasar} hasarlı adet ${x.nereden} deposuna GERİ dönsün mü?`)}>Kaynağa geri</Dugme></div>
                    {x.fazla > 0 && <div style={{ fontSize: 11.5, color: R.not, marginTop: 4 }}>+{x.fazla} sağlam fazla da var — hasarı çözünce görünür</div>}</>
                  : x.fazla > 0 ? <>+{x.fazla} fazla geldi — ASKIDA (birim karışmış olabilir)
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
                      <Dugme kucuk onClick={() => coz(x, 'fazla_onay', `${x.urun}: ${x.fazla} adet fazla GERÇEKTEN geldi mi? Şube stoğuna eklensin mi?`)}>Gerçekten geldi</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'fazla_ret', `${x.urun}: ${x.fazla} adet fazla yanlış (birim hatası) — reddedilsin mi?`)}>Yanlış, reddet</Dugme></div></>
                    : <>{x.eksik} adet eksik geldi — yolda kaldı
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
                      <Dugme kucuk onClick={() => coz(x, 'kayip', `${x.urun}: ${x.eksik} adet KAYIP olarak kapatılsın mı?`)}>Kayıp</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'iade', `${x.urun}: ${x.eksik} adet ${x.nereden} deposuna GERİ yazılsın mı (hiç çıkmamış)?`)}>Kaynağa geri</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'sube_saydi', `${x.urun}: gelen TAMMIŞ, şube yanlış saymış — ${x.eksik} adet şube stoğuna eklensin mi?`)}>Şube yanlış saydı</Dugme></div></>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>)}
    </div>
  );
}

// 🚚 SEVK ET (Basamak 5 S2 — sahip P2: depoda görünmese de yazılır + uyarı; pasta seçilemez: pastane şubeye doğrudan getirir)
const IZ_TUR_AD = { giris: 'Giriş', sevk: 'Sevk', kabul: 'Kabul', fazla_kabul: 'Fazla kabul', ac: 'Ürün aç', tuketim: 'Tüketim', fire: 'Fire', sayim: 'Sayım', acilis_sayim: 'Açılış sayımı', iade: 'İade', kayip: 'Kayıp', hasar: 'Hasar' };
const DURUM_AD = { yolda: ['🚚 yolda', 'sari'], kismi: ['◐ kısmen kabul', 'sari'], kabul: ['✓ kabul edildi', 'yesil'], iptal: ['geri alındı', undefined] };

function SevkEt({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [liste, setListe] = useState(null);
  const [deneme, setDeneme] = useState(false);
  const [hedef, setHedef] = useState('');
  const [ara, setAra] = useState('');
  const [adet, setAdet] = useState({});    // urun_id → {koli, tek}
  const [notu, setNotu] = useState('');
  const [istek, setIstek] = useState(yeniIstek);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const yukle = useCallback(async () => {
    try { setV(await api('/evvel-yeni/depo/ozet?evren=yeni')); setHata(null); } catch (e) { setHata(e?.message || 'okunamadı'); }
    try { const l = await api('/evvel-yeni/depo/sevkler'); setListe(l.partiler); setDeneme(!!l.deneme); } catch { setListe([]); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  const urunler = useMemo(() => (v?.satirlar || []).filter((u) => u.takip !== 'gununde' && u.kategori !== '❔ Katalogda eşleşmeyen'), [v]);
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>{hata}</div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Ürünler okunuyor…</div></div>;
  const merkez = v.konumlar.find((k) => k.merkez);
  const hedefler = v.konumlar.filter((k) => k.id.startsWith('depo:') && !k.merkez);
  const toplam = (u) => {
    const a = adet[u.urun_id] || {};
    return (parseInt(a.koli || '0', 10) || 0) * (u.koli_ici > 1 ? u.koli_ici : 0) + (parseInt(a.tek || '0', 10) || 0);
  };
  const secili = urunler.filter((u) => toplam(u) > 0);
  const setA = (id, ad, x) => { if (!/^\d{0,5}$/.test(x)) return; setAdet((o) => ({ ...o, [id]: { ...(o[id] || {}), [ad]: x } })); };
  const gonder = async () => {
    if (!hedef) { onToast?.('Hangi şubeye? Hedef seç'); return; }
    if (!secili.length) { onToast?.('En az bir ürün seç'); return; }
    const h = hedefler.find((k) => k.sube_id === hedef);
    if (!(await sor({ soru: `${merkez?.ad || 'Merkez depo'} → ${h?.ad}\n\n${secili.map((u) => `• ${u.ad}: ${toplam(u)}`).join('\n')}\n\nYola çıksın mı?`, tamam: '🚚 Yola çıkar' }))) return;
    setMesgul(true);
    try {
      const r = await api('/evvel-yeni/depo/sevk', { method: 'POST',
        body: { hedef, istek_id: istek, not_: notu.trim() || null, kalemler: secili.map((u) => ({ urun_id: u.urun_id, adet: toplam(u) })) } });
      setSonuc(r); onToast?.(r.mesaj);
      if (!r.kuru) { setAdet({}); setNotu(''); }
      setIstek(yeniIstek()); yukle();
    } catch (e) { onToast?.(e?.message || 'Gönderilemedi'); } finally { setMesgul(false); }
  };
  const geriAl = async (p) => {
    const sebep = await sor({ soru: `${p.nereye} paketi geri alınsın mı?`, ipucu: 'Şube henüz kabul etmedi. Sebep yaz (en az 3 harf).', giris: true, tamam: 'Paketi geri al' });
    if (!sebep || sebep.trim().length < 3) return;
    try { const r = await api(`/evvel-yeni/depo/sevk/${encodeURIComponent(p.id)}/iptal`, { method: 'POST', body: { sebep: sebep.trim() } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Geri alınamadı'); }
  };
  const q = ara.trim().toLocaleLowerCase('tr');
  const gorunen = q ? urunler.filter((u) => u.ad.toLocaleLowerCase('tr').includes(q)) : urunler;
  let sonKat = null;
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Sevk et</h1></div>
      {deneme && <div style={{ ...kart, padding: '8px 12px', fontSize: 13, borderLeft: `5px solid ${R.amber}` }}>
        🧪 <b>DENEME</b> — 1 Kasım'a kadar gönderilen paket KAYDEDİLMEZ (gerçek sevk eski sistemden). Ekranı denemek için kullanabilirsin.</div>}
      <div style={{ fontSize: 12.5, color: R.not }}>{merkez?.ad || 'Merkez depo'} → şube. Şube, paneldeki <b>Depodan gelen</b>'de adetleri GÖRMEDEN sayıp kabul eder;
        eksik / fazla / hasarlı gelen <b>Sevk farkları</b>'na düşer. Depoda görünmeyen ürün de gönderilebilir (uyarı verir). 🍰 Pasta burada yok — pastane şubeye doğrudan getirir.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={hedef} onChange={(e) => setHedef(e.target.value)} style={{ ...alan, width: 'auto' }}>
          <option value="">— Hangi şubeye? —</option>
          {hedefler.map((k) => <option key={k.id} value={k.sube_id}>{k.ad}</option>)}
        </select>
        <input placeholder="Ürün ara…" value={ara} onChange={(e) => setAra(e.target.value)} style={{ ...alan, width: 200 }} />
        <span style={{ marginLeft: 'auto', fontSize: 13, color: R.not }}>{secili.length} ürün · {secili.reduce((t, u) => t + toplam(u), 0)} adet</span>
      </div>
      <div style={{ ...kart, padding: 10, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '55vh', overflow: 'auto' }}>
        {gorunen.map((u) => {
          const baslik = u.kategori !== sonKat ? u.kategori : null;
          sonKat = u.kategori;
          const dep = merkez ? (u.bakiye || {})[merkez.id] || 0 : 0;
          const t = toplam(u);
          return (
            <React.Fragment key={u.urun_id}>
              {baslik && <div style={{ fontWeight: 800, padding: '8px 4px 4px' }}>{baslik}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 4px', borderTop: '1px solid var(--pi-line)', flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 140, fontSize: 14 }}>{u.ad}<span style={{ fontSize: 11.5, color: dep < t ? R.kirmizi : R.not }}> · depoda {dep}</span></span>
                {u.koli_ici > 1 && <>
                  <input inputMode="numeric" placeholder="koli" value={(adet[u.urun_id] || {}).koli ?? ''} onChange={(e) => setA(u.urun_id, 'koli', e.target.value)} style={{ ...alan, width: 64, textAlign: 'right' }} />
                  <span style={{ fontSize: 12, color: R.not }}>× {u.koli_ici} +</span></>}
                <input inputMode="numeric" placeholder="adet" value={(adet[u.urun_id] || {}).tek ?? ''} onChange={(e) => setA(u.urun_id, 'tek', e.target.value)} style={{ ...alan, width: 72, textAlign: 'right' }} />
                <b style={{ ...num, width: 48, textAlign: 'right' }}>{t || ''}</b>
              </div>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input placeholder="Not (isteğe bağlı) — adet YAZMA, şube görür (kör sayım)" value={notu} maxLength={300} onChange={(e) => setNotu(e.target.value)} style={{ ...alan, flex: 1, minWidth: 200 }} />
        <Dugme ana onClick={gonder} disabled={mesgul || !hedef || !secili.length}>{mesgul ? 'Gönderiliyor…' : '🚚 Yola çıkar'}</Dugme>
      </div>
      {sonuc && <div style={{ ...kart, padding: 12, borderLeft: `5px solid ${sonuc.kuru ? R.amber : sonuc.eksi?.length ? R.kirmizi : R.yesil}`, fontSize: 13.5 }}>{sonuc.mesaj}</div>}
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>📋 Son paketler (14 gün)</div>
        {!liste ? <div style={{ padding: '0 14px 14px', color: R.not }}>Okunuyor…</div>
          : liste.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Henüz paket yok.</div>
          : liste.map((p) => (
            <div key={p.id} style={{ padding: '8px 14px', borderTop: '1px solid var(--pi-line)', fontSize: 13, opacity: p.durum === 'iptal' ? 0.55 : 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <b>{tKisa(p.gun)}</b><span>{p.nereden} → <b>{p.nereye}</b></span><Cip tur={DURUM_AD[p.durum][1]}>{DURUM_AD[p.durum][0]}</Cip>
                <span style={{ color: R.not }}>{p.kim}</span><span style={{ flex: 1 }} />
                {p.durum === 'yolda' && <Dugme kucuk onClick={() => geriAl(p)}>Geri al</Dugme>}
              </div>
              <div style={{ color: R.not, marginTop: 2 }}>
                {p.kalemler.map((k) => `${k.ad} ${k.adet}${k.kabul != null ? ` → ${k.kabul}` : ''}${k.hasar ? ` (hasarlı ${k.hasar})` : ''}${k.fazla ? ` (+${k.fazla})` : ''}`).join(' · ')}
                {p.not ? ` · 📝 ${p.not}` : ''}{p.iptal_sebep ? ` · geri alma: ${p.iptal_sebep}` : ''}</div>
            </div>
          ))}
      </div>
    </div>
  );
}

function DepoSayim({ onToast }) {
  const [v, hata, yukle, setEvren] = useOzet();
  const [konum, setKonum] = useState('');
  const [deger, setDeger] = useState({});
  const [acilis, setAcilis] = useState(false);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  useEffect(() => {
    if (v && !konum) {
      const k = v.konumlar.find((x) => x.id.startsWith('depo:'));
      if (k) { setKonum(k.id); setAcilis(!k.acilis_sayimi); }
    }
  }, [v, konum]);
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>{hata}</div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Ürünler okunuyor…</div></div>;
  const k = v.konumlar.find((x) => x.id === konum);
  const urunler = v.satirlar.filter((u) => u.takip !== 'gununde');   // Codex: eşleşmeyen (eski kodlu) de sayılır · Fable: pasta sayılmaz
  const kaydet = async () => {
    const satirlar = Object.entries(deger).filter(([, d]) => String(d).trim() !== '').map(([urun_id, d]) => ({ urun_id, sayilan: Number(String(d).replace(',', '.')) }));
    if (!satirlar.length) { onToast?.('En az bir ürün say'); return; }
    if (satirlar.some((s) => !Number.isInteger(s.sayilan) || s.sayilan < 0)) { onToast?.('Adetler tam sayı ve 0 ya da üstü olmalı'); return; }
    if (!(await sor({ soru: `${k?.ad} · ${satirlar.length} ürün ${acilis ? 'AÇILIŞ SAYIMI' : 'sayımı'} olarak kaydedilsin mi?`, tamam: 'Kaydet' }))) return;
    setMesgul(true);
    try {
      const r = await api('/evvel-yeni/depo/sayim', { method: 'POST', body: { konum, satirlar, acilis, evren: v.evren } });
      onToast?.(r.mesaj); setSonuc(r); setDeger({}); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  let sonKat = null;
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Depo sayımı</h1></div>
      <EvrenSecimi v={v} setEvren={(x) => { setEvren(x); setDeger({}); setKonum(''); }} />
      <div style={{ fontSize: 12.5, color: R.not }}>KÖR SAYIM: sistemin rakamı gösterilmez. Saydığın ürünün adedini yaz; boş bıraktığın ürün sayılmamış sayılır (0 değil).
        Kaydedince her ürün için fark (sayılan − sistem) iz bırakan bir hareket olarak yazılır. Konumdaki ilk sayım AÇILIŞ sayımıdır.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={konum} onChange={(e) => { setKonum(e.target.value); setDeger({}); const kk = v.konumlar.find((x) => x.id === e.target.value); setAcilis(!kk?.acilis_sayimi); }} style={{ ...alan, width: 'auto' }}>
          {v.konumlar.filter((x) => x.id.startsWith('depo:')).map((x) => <option key={x.id} value={x.id}>{x.ad}{x.acilis_sayimi ? '' : ' — açılış sayımı yok'}</option>)}
        </select>
        <label style={{ fontSize: 13, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={acilis} onChange={(e) => setAcilis(e.target.checked)} />açılış sayımı</label>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: R.not }}>{Object.values(deger).filter((d) => String(d).trim() !== '').length} ürün sayıldı</span>
        <Dugme ana onClick={kaydet} disabled={mesgul}>{mesgul ? 'Kaydediliyor…' : 'Sayımı kaydet'}</Dugme>
      </div>
      {sonuc && sonuc.farklar?.length > 0 && (
        <div style={{ ...kart, padding: 12, borderLeft: `5px solid ${R.amber}` }}>
          <b>Sayım farkları</b> (merkez görür)
          {sonuc.farklar.map((f) => {
            const u = urunler.find((x) => x.urun_id === f.urun_id);
            return <div key={f.urun_id} style={{ fontSize: 13 }}>{u?.ad || f.urun_id}: sistem {f.defter} · sayılan {f.sayilan} → <b style={{ color: f.fark < 0 ? R.kirmizi : R.yesil }}>{f.fark > 0 ? '+' : ''}{f.fark}</b></div>;
          })}
        </div>
      )}
      <div style={{ ...kart, padding: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {urunler.map((s) => {
          const baslik = s.kategori !== sonKat ? s.kategori : null;
          sonKat = s.kategori;
          return (
            <React.Fragment key={s.urun_id}>
              {baslik && <div style={{ fontWeight: 800, padding: '8px 4px 4px' }}>{baslik}</div>}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 4px', borderTop: '1px solid var(--pi-line)' }}>
                <span style={{ flex: 1, fontSize: 14 }}>{s.ad}</span>
                <input inputMode="numeric" placeholder="adet" value={deger[s.urun_id] ?? ''} onChange={(e) => setDeger({ ...deger, [s.urun_id]: e.target.value })} style={{ ...alan, width: 100, textAlign: 'right' }} />
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
