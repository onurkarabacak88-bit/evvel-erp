// 🏠 KİRA HESABI — işletmeye özel tak-çıkar modül (sunucu: evvel_yeni_mulk_api.py).
// Sahip (2026-10-17): "Hem kiraları takip etmek hem işletmelerin (Fatma'nın kira hesabından) borçlanmalarını görmek;
// basit ama işlevsel." · "Kasım'da sıfır başlasın." 3 sekme: Ev kiraları (ev × ay) · İşletmelerin borcu (şube × ay) · Uyarılar.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt, tKisa } from './KasaModulu';
import { AY, AY_UZUN, AyIzgara, DURUM, Lejant, Pencere, YilSecici } from './AyTakvim';

export const MULK_SAYFALAR = [
  { id: 'mulk_takvim', ad: 'Ev kiraları', alt: 'Ev × ay · kira geldi mi' },
  { id: 'mulk_borc', ad: 'İşletmelerin borcu', alt: 'Kira hesabından alınan − geri ödenen' },
  { id: 'mulk_uyari', ad: 'Uyarılar', alt: 'Geciken kira · artış ayı' },
];
const alan = { padding: '8px 10px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, minWidth: 0, width: '100%' };
const ayBugun = () => new Date().toISOString().slice(0, 7);
const gunBugun = () => new Date().toISOString().slice(0, 10);
const yeniId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function useVeri(yol, yil) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const no = useRef(0);
  const yukle = () => {
    const n = ++no.current;
    setV(null);
    api(`${yol}?yil=${yil}`).then((r) => { if (n === no.current) { setV(r); setHata(null); } }).catch((e) => { if (n === no.current) setHata(e?.message || 'okunamadı'); });
  };
  useEffect(yukle, [yol, yil]);   // eslint-disable-line react-hooks/exhaustive-deps
  return [v, hata, yukle];
}

function Baslik({ ad, yil, setYil, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      <div><div className="pi-eyebrow">Evvel Yeni · Kira hesabı</div><h1 style={{ fontSize: 30 }}>{ad}</h1></div>
      {children}
      {setYil && <YilSecici yil={yil} setYil={setYil} />}
    </div>
  );
}

function EvKiralari({ onToast }) {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, hata, yukle] = useVeri('/evvel-yeni/mulk/takvim', yil);
  const [sec, setSec] = useState(null);
  const [form, setForm] = useState(null);
  const [tah, setTah] = useState(null);   // {e, a, tutar, tarih, istek_id}
  const kaydet = async () => {
    try {
      const govde = { ...form, tutar: Number(String(form.tutar).replace(',', '.')) || 0, odeme_gunu: Number(form.odeme_gunu) || 1,
        artis_ayi: form.artis_ayi ? Number(form.artis_ayi) : null };
      const r = await api(`/evvel-yeni/mulk${form.id ? `?mid=${encodeURIComponent(form.id)}` : ''}`, { method: 'POST', body: govde });
      onToast?.(r.mesaj); setForm(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  const tahsilEt = async () => {
    try {
      const r = await api('/evvel-yeni/mulk/tahsilat', { method: 'POST', body: { mulk_id: tah.e.id, ay: tah.a.ay, tutar: Number(String(tah.tutar).replace(',', '.')) || 0, tarih: tah.tarih, istek_id: tah.istek_id } });
      onToast?.(r.mesaj); setTah(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  const satirlar = (v?.evler || []).map((e) => ({
    id: e.id, baslik: e.ad, alt: `${e.kiraci || 'kiracı yok'} · ${fmt(e.kira)} ₺ · ${e.odeme_gunu}'i${e.aktif ? '' : ' · kapalı'}`, e,
    aylar: e.aylar.map((a) => ({ ...a, ust: a.odenen > 0 ? fmt(a.odenen) : fmt(a.beklenen), alt: a.artis_ayi ? '📈 artış' : a.durum === 'kismi' ? `kalan ${fmt(a.kalan)}` : null })),
    sag: fmt(e.yil_gelen), sagAlt: `/ ${fmt(e.yil_beklenen)}`,
  }));
  return (
    <>
      <Baslik ad="Ev kiraları" yil={yil} setYil={setYil}>
        <Dugme kucuk ana onClick={() => setForm({ ad: '', kiraci: '', tutar: '', odeme_gunu: '1', artis_ayi: '', baslangic_ay: ayBugun(), aktif: true })}>+ Ev ekle</Dugme>
      </Baslik>
      <Lejant />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && v.evler.length === 0 && <div style={{ color: R.not }}>Henüz ev yok. "+ Ev ekle" ile kiraya verilen evleri ekle.</div>}
      {v && v.evler.length > 0 && <AyIzgara satirlar={satirlar} onHucre={(s, a, i) => setSec({ e: s.e, a, i })} />}
      {sec && (
        <Pencere baslik={`🏠 ${sec.e.ad} · ${AY_UZUN[sec.i]} ${v.yil}`} onKapat={() => setSec(null)}>
          <div>Kira <b style={num}>{fmt(sec.a.beklenen)}</b> ₺ · gelen <b style={num}>{fmt(sec.a.odenen)}</b> ₺ · kalan <b style={num}>{fmt(sec.a.kalan)}</b> ₺</div>
          <div style={{ color: R.not, fontSize: 13 }}>Ödeme günü {tKisa(sec.a.vade)} · {DURUM[sec.a.durum]?.ad}{sec.e.kiraci ? ` · ${sec.e.kiraci}` : ''}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {sec.a.kalan > 0 && <Dugme kucuk ana onClick={() => { setTah({ e: sec.e, a: sec.a, tutar: String(sec.a.kalan), tarih: gunBugun(), istek_id: yeniId() }); setSec(null); }}>Kira geldi →</Dugme>}
            <Dugme kucuk onClick={() => { setForm({ id: sec.e.id, ad: sec.e.ad, kiraci: sec.e.kiraci || '', tutar: String(sec.e.kira), gecerli_ay: ayBugun(), odeme_gunu: String(sec.e.odeme_gunu), artis_ayi: sec.e.artis_ayi ? String(sec.e.artis_ayi) : '', baslangic_ay: sec.e.baslangic_ay, bitis_ay: sec.e.bitis_ay || '', aktif: sec.e.aktif, not_: sec.e.not || '' }); setSec(null); }}>Evi düzelt</Dugme>
          </div>
        </Pencere>
      )}
      {tah && (
        <Pencere baslik={`💰 ${tah.e.ad} · ${tah.a.ay} kirası geldi`} onKapat={() => setTah(null)}>
          <div style={{ fontSize: 13, color: R.metin2 }}>Fatma'nın kira hesabına giriş olarak yazılır.</div>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Gelen tutar (₺)<input style={alan} inputMode="decimal" value={tah.tutar} onChange={(e) => setTah((t) => ({ ...t, tutar: e.target.value }))} /></label>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Geldiği gün<input style={alan} type="date" value={tah.tarih} max={gunBugun()} onChange={(e) => setTah((t) => ({ ...t, tarih: e.target.value }))} /></label>
          <div><Dugme ana onClick={tahsilEt}>Kaydet</Dugme></div>
        </Pencere>
      )}
      {form && (
        <Pencere baslik={form.id ? 'Evi düzelt' : 'Yeni ev'} onKapat={() => setForm(null)}>
          {[['ad', 'Evin adı', 'text'], ['kiraci', 'Kiracı', 'text'], ['tutar', 'Aylık kira (₺)', 'text'], ...(form.id ? [['gecerli_ay', 'Bu tutar hangi aydan geçerli', 'month']] : []),
            ['odeme_gunu', 'Ödeme günü (1–31)', 'text'], ['artis_ayi', 'Artış ayı (1–12, bilmiyorsan boş)', 'text'], ['baslangic_ay', 'Kiralama başladığı ay', 'month'], ...(form.id ? [['bitis_ay', 'Bittiği ay (boş = sürüyor)', 'month']] : [])].map(([k, a, tip]) => (
            <label key={k} style={{ display: 'grid', gap: 4, fontSize: 13 }}>{a}
              <input style={alan} type={tip} value={form[k] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></label>
          ))}
          {form.id && <label style={{ fontSize: 13 }}><input type="checkbox" checked={!form.aktif} onChange={(e) => setForm((f) => ({ ...f, aktif: !e.target.checked }))} /> Kiralama bitti (listeden düşsün)</label>}
          <div><Dugme ana onClick={kaydet}>Kaydet</Dugme></div>
        </Pencere>
      )}
    </>
  );
}

function IsletmeBorcu() {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, hata] = useVeri('/evvel-yeni/mulk/borc', yil);
  const hucre = { padding: '6px 6px', textAlign: 'right', borderTop: '1px solid var(--pi-line)', fontSize: 12.5, ...num };
  return (
    <>
      <Baslik ad="İşletmelerin borcu" yil={yil} setYil={setYil} />
      <div style={{ fontSize: 13, color: R.metin2 }}>Fatma'nın kira hesabından işletme adına yapılan ödeme ve işletme bankasına aktarım borcu <b>artırır</b>; işletmeden kira hesabına aktarım (Kasa → Taşı / Yatır) <b>azaltır</b>. Şahsi harcama sayılmaz. {v && `${tKisa(v.baslangic)} ${v.baslangic.slice(0, 4)}'tan itibaren, sıfırdan.`}</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && (<>
        <div style={{ ...kart, padding: '12px 16px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div><div style={{ fontSize: 11, color: R.not, fontWeight: 700 }}>TOPLAM BORÇ</div><div style={{ ...num, fontSize: 24, fontWeight: 700, color: v.toplam_borc > 0 ? R.kirmizi : R.yesil }}>{fmt(v.toplam_borc)} ₺</div></div>
          {v.subeler.filter((s) => s.borc !== 0).map((s) => <div key={s.sube}><div style={{ fontSize: 11, color: R.not, fontWeight: 700 }}>{s.ad.toUpperCase()}</div><div style={{ ...num, fontSize: 17 }}>{fmt(s.borc)} ₺</div></div>)}
          {v.sahsi > 0 && <div><div style={{ fontSize: 11, color: R.not, fontWeight: 700 }}>ŞAHSİ (BORÇ DEĞİL)</div><div style={{ ...num, fontSize: 17, color: R.not }}>{fmt(v.sahsi)} ₺</div></div>}
        </div>
        <div style={{ ...kart, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
            <thead><tr style={{ fontSize: 12, color: R.metin2 }}><th style={{ ...hucre, textAlign: 'left', borderTop: 'none' }} />{AY.map((a) => <th key={a} style={{ ...hucre, borderTop: 'none' }}>{a}</th>)}</tr></thead>
            <tbody>{v.subeler.map((s) => (
              <tr key={s.sube}>
                <td style={{ ...hucre, textAlign: 'left', fontFamily: 'inherit' }}><b>{s.ad}</b></td>
                {s.aylar.map((a) => (
                  <td key={a.ay} style={{ ...hucre, color: a.baslamadi ? R.not : undefined }}>
                    {a.baslamadi ? '·' : <>
                      <div style={{ fontWeight: 700, color: a.borc > 0 ? R.kirmizi : R.metin2 }}>{fmt(a.borc)}</div>
                      {(a.alinan > 0 || a.geri > 0) && <div style={{ fontSize: 11, color: R.not }}>{a.alinan > 0 ? `+${fmt(a.alinan)}` : ''}{a.geri > 0 ? ` −${fmt(a.geri)}` : ''}</div>}
                    </>}
                  </td>
                ))}
              </tr>
            ))}</tbody>
          </table>
        </div>
        {v.hareketler.length > 0 && (
          <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
            <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700 }}>Hareketler</div>
            {v.hareketler.map((x) => (
              <div key={x.id} style={{ display: 'flex', gap: 10, borderTop: `1px solid ${R.cizgi}`, padding: '5px 0', fontSize: 13 }}>
                <span style={{ width: 52, color: R.metin2 }}>{tKisa(x.gun)}</span><span style={{ width: 90 }}>{(v.subeler.find((s) => s.sube === x.sube) || {}).ad}</span>
                <span style={{ flex: 1 }}>{x.aciklama}</span><b style={{ ...num, color: x.alinan > 0 ? R.kirmizi : R.yesil }}>{x.alinan > 0 ? `+${fmt(x.alinan)}` : `−${fmt(x.geri)}`}</b>
              </div>
            ))}
          </div>
        )}
      </>)}
    </>
  );
}

function Uyarilar({ onSekme }) {
  const yil = new Date().getFullYear();
  const [v, hata] = useVeri('/evvel-yeni/mulk/takvim', yil);
  const bugunAy = ayBugun();
  const sonrakiAy = Number(bugunAy.slice(5, 7)) % 12 + 1;
  const geciken = (v?.evler || []).flatMap((e) => e.aylar.filter((a) => ['gecikti', 'kismi'].includes(a.durum) && a.ay <= bugunAy).map((a) => ({ e, a })));
  const artis = (v?.evler || []).filter((e) => e.aktif && e.artis_ayi && [Number(bugunAy.slice(5, 7)), sonrakiAy].includes(e.artis_ayi));
  return (
    <>
      <Baslik ad="Uyarılar" />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {v && geciken.length === 0 && artis.length === 0 && <div style={{ color: R.not }}>Uyarı yok.</div>}
      {geciken.map(({ e, a }) => (
        <div key={e.id + a.ay} style={{ ...kart, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Cip tur="kirmizi">Kira gelmedi</Cip><span style={{ flex: 1 }}><b>{e.ad}</b>{e.kiraci ? ` · ${e.kiraci}` : ''} · {a.ay} · kalan <b style={num}>{fmt(a.kalan)}</b> ₺</span>
          <Dugme kucuk onClick={() => onSekme?.('mulk_takvim')}>Ev kiraları</Dugme>
        </div>
      ))}
      {artis.map((e) => (
        <div key={`a${e.id}`} style={{ ...kart, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <Cip tur="sari">📈 Artış ayı</Cip><span style={{ flex: 1 }}><b>{e.ad}</b> · {AY_UZUN[e.artis_ayi - 1]} — yeni tutarı "Evi düzelt"ten gir</span>
        </div>
      ))}
    </>
  );
}

export default function MulkModulu({ gorunum, onToast, onSekme }) {
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      {gorunum === 'mulk_borc' ? <IsletmeBorcu /> : gorunum === 'mulk_uyari' ? <Uyarilar onSekme={onSekme} /> : <EvKiralari onToast={onToast} />}
    </div>
  );
}
