// ─────────────────────────────────────────────────────────────────────────────
// 📦 EVVEL YENİ · DEPO — tek hareket defteri; "Nerede?" ürün × konum; her hücre tıklanır → iz
//
// Sahip (2026-10-17): "depo takip — eski Evvel'in karışıklığını anla, sade ama işlevselliği ve takibi aynı."
// Codex + Fable kurgusu: tek defter, eksi kırpılmaz, kör sayım fark hareketi, Tema'da ürün aç depodan düşer (sahip: 2).
// Bütün rakamlar /api/evvel-yeni/depo'dan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, Cekmece, tKisa } from './KasaModulu';

export const DEPO_SAYFALAR = [
  { id: 'depo_nerede', ad: 'Depo — Nerede?', alt: 'Ürün × konum · tıkla → iz' },
  { id: 'depo_yolda', ad: 'Yoldakiler', alt: 'Kabul bekleyen · fark' },
  { id: 'depo_sayim', ad: 'Depo sayımı', alt: 'Kör sayım · açılış sayımı' },
];

const alan = {
  width: '100%', padding: '8px 10px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)',
  color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, minWidth: 0,
};

function useOzet() {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const yukle = useCallback(async () => {
    try { setV(await api('/evvel-yeni/depo/ozet')); setHata(null); } catch (e) { setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  return [v, hata, yukle];
}

export default function DepoModulu({ gorunum, onToast }) {
  if (gorunum === 'depo_yolda') return <Yoldakiler onToast={onToast} />;
  if (gorunum === 'depo_sayim') return <DepoSayim onToast={onToast} />;
  return <Nerede />;
}

function Nerede() {
  const [v, hata, yukle] = useOzet();
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
          satirlar: r.iz.map((x) => [tKisa(x.gun), `${x.aciklama || x.tur}${x.iptal ? ` · İPTAL (${x.iptal_sebep || ''})` : ''}`, x.karsi, x.kim || '',
            { t: `${x.d > 0 ? '+' : ''}${x.d}`, renk: x.iptal ? R.not : x.d > 0 ? R.yesil : R.kirmizi }, { t: String(x.kalan), kalin: true, renk: x.kalan < 0 ? R.kirmizi : undefined }]),
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
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Depo — Nerede?</h1></div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {v.eksi_sayi > 0 && <Cip tur="kirmizi">{v.eksi_sayi} hücre eksi</Cip>}
          <label style={{ fontSize: 13, display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={sadeceEksi} onChange={(e) => setSadeceEksi(e.target.checked)} />yalnız eksiler</label>
          <input placeholder="Ürün ara…" value={ara} onChange={(e) => setAra(e.target.value)} style={{ ...alan, width: 180 }} />
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {v.konumlar.filter((k) => k.id !== 'yolda').map((k) => (
          <Cip key={k.id} tur={k.acilis_sayimi ? 'yesil' : 'sari'}>{k.ad}: {k.acilis_sayimi ? `açılış sayımı var${k.son_sayim ? ` · son ${tKisa(k.son_sayim)}` : ''}` : 'açılış sayımı YOK'}</Cip>
        ))}
      </div>
      <div style={{ ...kart, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 760 }}>
          <thead><tr style={{ fontSize: 12, color: R.metin2, textAlign: 'right' }}>
            <th style={{ ...hucre, textAlign: 'left', borderTop: 'none' }}>Ürün</th>
            {v.konumlar.map((k) => <th key={k.id} style={{ ...hucre, borderTop: 'none' }}>{k.ad}</th>)}
          </tr></thead>
          <tbody>{satirlar.map((s) => {
            const baslik = s.kategori !== sonKat ? s.kategori : null;
            sonKat = s.kategori;
            return (
              <React.Fragment key={s.urun_id}>
                {baslik && <tr><td colSpan={v.konumlar.length + 1} style={{ ...hucre, fontWeight: 800, background: 'var(--pi-bg)' }}>{baslik}</td></tr>}
                <tr>
                  <td style={{ ...hucre, textAlign: 'left' }}>{s.ad}</td>
                  {v.konumlar.map((k) => {
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

function Yoldakiler({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const yukle = useCallback(async () => {
    try { setV(await api('/evvel-yeni/depo/yolda')); setHata(null); } catch (e) { setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  const kabul = async (x) => {
    if (!window.confirm(`${x.urun} (${x.sevk} adet) → ${x.nereye}\nŞube kabul etmedi. Merkez adına SEVK ADEDİYLE kabul edilsin mi?`)) return;
    try { const r = await api(`/evvel-yeni/depo/yolda/${encodeURIComponent(x.id)}/merkez-kabul`, { method: 'POST', body: {} }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  const coz = async (x, karar, soru) => {
    if (!window.confirm(soru)) return;
    try { const r = await api(`/evvel-yeni/depo/yolda/${encodeURIComponent(x.id)}/fark-coz`, { method: 'POST', body: { karar } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>{hata}</div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Yoldakiler okunuyor…</div></div>;
  const hucre = { padding: '7px 9px', borderTop: '1px solid var(--pi-line)', fontSize: 13 };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Yoldakiler</h1></div>
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>🚚 Kabul bekleyen sevkler {v.gec_sayi > 0 && <Cip tur="kirmizi">{v.gec_sayi} kalem {v.gec_gun}+ gündür yolda</Cip>}</div>
        {v.bekleyen.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Yolda mal yok ✓</div> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
            {v.bekleyen.map((x) => (
              <tr key={x.id} style={{ background: x.gec ? `color-mix(in srgb, ${R.kirmizi} 8%, transparent)` : undefined }}>
                <td style={{ ...hucre, whiteSpace: 'nowrap' }}>{x.sevk_gunu ? tKisa(x.sevk_gunu) : '—'}<div style={{ fontSize: 11.5, color: x.gec ? R.kirmizi : R.not }}>{x.gun} gün</div></td>
                <td style={hucre}><b>{x.urun}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.nereden} → {x.nereye}</div></td>
                <td style={{ ...hucre, textAlign: 'right', ...num, fontWeight: 700 }}>{x.sevk} adet</td>
                <td style={{ ...hucre, textAlign: 'right' }}><Dugme kucuk onClick={() => kabul(x)}>Merkez adına kabul</Dugme></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700 }}>⚖️ Sevk ≠ kabul</div>
        {v.fark.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Fark yok ✓</div> : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}><tbody>
            {v.fark.map((x) => (
              <tr key={x.id}>
                <td style={{ ...hucre, whiteSpace: 'nowrap' }}>{x.sevk_gunu ? tKisa(x.sevk_gunu) : '—'}</td>
                <td style={hucre}><b>{x.urun}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.nereden} → {x.nereye}</div></td>
                <td style={{ ...hucre, textAlign: 'right', ...num }}>sevk {x.sevk} · kabul {x.kabul + Math.max(0, x.fazla)}{x.merkez_kabul ? ' (merkez)' : ''}</td>
                <td style={{ ...hucre, textAlign: 'right', color: x.fazla > 0 ? R.amber : R.kirmizi, fontWeight: 700 }}>
                  {x.fazla > 0 ? <>+{x.fazla} fazla geldi — ASKIDA (birim karışmış olabilir)
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
                      <Dugme kucuk onClick={() => coz(x, 'fazla_onay', `${x.urun}: ${x.fazla} adet fazla GERÇEKTEN geldi mi? Şube stoğuna eklensin mi?`)}>Gerçekten geldi</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'fazla_ret', `${x.urun}: ${x.fazla} adet fazla yanlış (birim hatası) — reddedilsin mi?`)}>Yanlış, reddet</Dugme></div></>
                    : <>{x.eksik} adet eksik geldi — yolda kaldı
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', marginTop: 4 }}>
                      <Dugme kucuk onClick={() => coz(x, 'kayip', `${x.urun}: ${x.eksik} adet KAYIP olarak kapatılsın mı?`)}>Kayıp</Dugme>
                      <Dugme kucuk onClick={() => coz(x, 'iade', `${x.urun}: ${x.eksik} adet ${x.nereden} deposuna GERİ yazılsın mı (hiç çıkmamış)?`)}>Kaynağa geri</Dugme></div></>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </div>
  );
}

function DepoSayim({ onToast }) {
  const [v, hata, yukle] = useOzet();
  const [konum, setKonum] = useState('');
  const [deger, setDeger] = useState({});
  const [acilis, setAcilis] = useState(false);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  useEffect(() => {
    if (v && !konum) {
      const k = v.konumlar.find((x) => x.id !== 'yolda');
      if (k) { setKonum(k.id); setAcilis(!k.acilis_sayimi); }
    }
  }, [v, konum]);
  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>{hata}</div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Ürünler okunuyor…</div></div>;
  const k = v.konumlar.find((x) => x.id === konum);
  const urunler = v.satirlar;   // Codex: katalogda eşleşmeyen (eski kodlu) ürünler de sayılabilsin
  const kaydet = async () => {
    const satirlar = Object.entries(deger).filter(([, d]) => String(d).trim() !== '').map(([urun_id, d]) => ({ urun_id, sayilan: Number(String(d).replace(',', '.')) }));
    if (!satirlar.length) { onToast?.('En az bir ürün say'); return; }
    if (satirlar.some((s) => !Number.isInteger(s.sayilan) || s.sayilan < 0)) { onToast?.('Adetler tam sayı ve 0 ya da üstü olmalı'); return; }
    if (!window.confirm(`${k?.ad} · ${satirlar.length} ürün ${acilis ? 'AÇILIŞ SAYIMI' : 'sayımı'} olarak kaydedilsin mi?`)) return;
    setMesgul(true);
    try {
      const r = await api('/evvel-yeni/depo/sayim', { method: 'POST', body: { konum, satirlar, acilis } });
      onToast?.(r.mesaj); setSonuc(r); setDeger({}); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  let sonKat = null;
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Depo</div><h1 style={{ fontSize: 30 }}>Depo sayımı</h1></div>
      <div style={{ fontSize: 12.5, color: R.not }}>KÖR SAYIM: sistemin rakamı gösterilmez. Saydığın ürünün adedini yaz; boş bıraktığın ürün sayılmamış sayılır (0 değil).
        Kaydedince her ürün için fark (sayılan − sistem) iz bırakan bir hareket olarak yazılır. Konumdaki ilk sayım AÇILIŞ sayımıdır.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={konum} onChange={(e) => { setKonum(e.target.value); setDeger({}); const kk = v.konumlar.find((x) => x.id === e.target.value); setAcilis(!kk?.acilis_sayimi); }} style={{ ...alan, width: 'auto' }}>
          {v.konumlar.filter((x) => x.id !== 'yolda').map((x) => <option key={x.id} value={x.id}>{x.ad}{x.acilis_sayimi ? '' : ' — açılış sayımı yok'}</option>)}
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
