// 🏠 KİRA HESABI — işletmeye özel tak-çıkar modül (sunucu: evvel_yeni_mulk_api.py).
// Sahip (2026-10-17): "Hem kiraları takip etmek hem işletmelerin (Fatma'nın kira hesabından) borçlanmalarını görmek;
// basit ama işlevsel." · "Kasım'da sıfır başlasın." 3 sekme: Ev kiraları (ev × ay) · İşletmelerin borcu (şube × ay) · Uyarılar.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt, sayiTR, tKisa } from './KasaModulu';
import { ayTR, bugunTR } from '../../utils/trTarih';
import { AY, AY_UZUN, AyIzgara, DURUM, Lejant, Pencere, YilSecici } from './AyTakvim';

export const MULK_SAYFALAR = [
  { id: 'mulk_takvim', ad: 'Ev kiraları', alt: 'Ev × ay · kira geldi mi' },
  { id: 'mulk_borc', ad: 'İşletmelerin borcu', alt: 'Kira hesabından alınan − geri ödenen' },
  { id: 'mulk_uyari', ad: 'Uyarılar', alt: 'Geciken kira · artış ayı' },
];
const alan = { padding: '8px 10px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, minWidth: 0, width: '100%' };
const ayBugun = ayTR;     // C-T4-02: UTC değil TR (tahsilat tarihi gece 00–03 arası dün olmasın)
const gunBugun = bugunTR;
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
  const [mesgul, setMesgul] = useState(false);
  const [bagsiz, setBagsiz] = useState([]);
  useEffect(() => { if (tah) api('/evvel-yeni/mulk/baglanmamis').then((d) => setBagsiz(d.girisler || [])).catch(() => setBagsiz([])); }, [tah]);
  const bagla = async (g) => {
    if (mesgul) return; setMesgul(true);
    try { const r = await api('/evvel-yeni/mulk/bagla', { method: 'POST', body: { hareket_id: g.id, mulk_id: tah.e.id, ay: tah.a.ay } }); onToast?.(r.mesaj); setTah(null); yukle(); }
    catch (e) { onToast?.(e?.message || 'Bağlanamadı'); }
    setMesgul(false);
  };
  const kaydet = async () => {
    if (mesgul) return; setMesgul(true);
    try {
      const tu = sayiTR(form.tutar);
      if (Number.isNaN(tu)) { onToast?.('Tutarı sayı olarak yaz (ör. 25.000,00)'); setMesgul(false); return; }
      const govde = { ...form, tutar: tu, odeme_gunu: Number(form.odeme_gunu) || 1,
        artis_ayi: form.artis_ayi ? Number(form.artis_ayi) : null };
      const r = await api(`/evvel-yeni/mulk${form.id ? `?mid=${encodeURIComponent(form.id)}` : ''}`, { method: 'POST', body: govde });
      onToast?.(r.mesaj); setForm(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const tahsilEt = async () => {
    if (mesgul) return; setMesgul(true);
    try {
      const tt = sayiTR(tah.tutar);
      if (Number.isNaN(tt) || tt <= 0) { onToast?.('Tahsilat tutarını sayı olarak yaz (ör. 25.000,00)'); setMesgul(false); return; }
      const r = await api('/evvel-yeni/mulk/tahsilat', { method: 'POST', body: { mulk_id: tah.e.id, ay: tah.a.ay, tutar: tt, tarih: tah.tarih, istek_id: tah.istek_id } });
      onToast?.(r.mesaj); setTah(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const satirlar = (v?.evler || []).map((e) => ({
    id: e.id, baslik: e.ad, alt: `${e.kiraci || 'kiracı yok'} · ${fmt(e.kira)} ₺ · ayın ${e.odeme_gunu}. günü${e.aktif ? '' : ' · kapalı'}`, e,
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
          <div><Dugme ana disabled={mesgul} onClick={tahsilEt}>Kaydet</Dugme></div>
          {bagsiz.length > 0 && (
            <div style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, display: 'grid', gap: 4, fontSize: 13 }}>
              <div style={{ color: R.metin2 }}>Bu kira Kasa'ya daha önce girildiyse yenisini yazma — o girişi bu eve <b>bağla</b> (para iki kez girmesin):</div>
              {bagsiz.slice(-8).reverse().map((g) => (
                <div key={g.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>{tKisa(g.gun)} · <b style={num}>{fmt(g.tutar)}</b> ₺{g.kimden ? ` · ${g.kimden}` : ''}</span>
                  <Dugme kucuk disabled={mesgul} onClick={() => bagla(g)}>Bunu bağla</Dugme>
                </div>
              ))}
            </div>
          )}
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
          <div><Dugme ana disabled={mesgul} onClick={kaydet}>Kaydet</Dugme></div>
        </Pencere>
      )}
    </>
  );
}

function IsletmeBorcu({ onToast }) {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, hata, yukle] = useVeri('/evvel-yeni/mulk/borc', yil);
  const [mesgul, setMesgul] = useState('');
  const karar = async (x, k) => {
    setMesgul(x.id);
    try { const r = await api('/evvel-yeni/mulk/karar', { method: 'POST', body: { hareket_id: x.id, karar: k } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul('');
  };
  const hucre = { padding: '6px 6px', textAlign: 'right', borderTop: '1px solid var(--pi-line)', fontSize: 12.5, ...num };
  return (
    <>
      <Baslik ad="İşletmelerin borcu" yil={yil} setYil={setYil} />
      <div style={{ fontSize: 13, color: R.metin2 }}>Fatma'nın kira hesabından işletme adına yapılan ödeme ve işletme bankasına aktarım borcu <b>artırır</b>; işletmeden kira hesabına aktarım (Kasa → Taşı / Yatır) <b>azaltır</b>. Şahsi harcama sayılmaz. Bir eve ya da Fethi'nin hesabına aktarımda "şahsi mi, borç mu" diye sorulur. {v && `${tKisa(v.baslangic)} ${v.baslangic.slice(0, 4)} itibarıyla sıfırdan.`}</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && v.karar_bekleyen?.length > 0 && (
        <div style={{ ...kart, padding: '10px 14px', display: 'grid', gap: 4, borderColor: R.amber }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>Karar bekleyen aktarımlar — şahsi mi, işletme borcu mu?</div>
          {v.karar_bekleyen.map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0', fontSize: 13 }}>
              <span style={{ width: 52, color: R.metin2 }}>{tKisa(x.gun)}</span>
              <span style={{ flex: 1 }}>{x.yon === 'cikis' ? `Kira hesabı → ${x.karsi}` : `${x.karsi} → kira hesabı`}</span>
              <b style={num}>{fmt(x.tutar)} ₺</b>
              <Dugme kucuk disabled={mesgul === x.id} onClick={() => karar(x, 'sahsi')}>Şahsi</Dugme>
              <Dugme kucuk ana disabled={mesgul === x.id} onClick={() => karar(x, 'borc')}>{x.yon === 'cikis' ? 'İşletme borcu' : 'Borç geri ödemesi'}</Dugme>
            </div>
          ))}
        </div>
      )}
      {v && v.kararli?.length > 0 && (
        <details style={{ ...kart, padding: '8px 14px', fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: R.metin2 }}>Karar verilmiş aktarımlar ({v.kararli.length}) — değiştirmek için aç</summary>
          {v.kararli.map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0' }}>
              <span style={{ width: 52, color: R.metin2 }}>{tKisa(x.gun)}</span>
              <span style={{ flex: 1 }}>{x.yon === 'cikis' ? `Kira hesabı → ${x.karsi}` : `${x.karsi} → kira hesabı`}</span>
              <b style={num}>{fmt(x.tutar)} ₺</b>
              <Cip tur={x.karar === 'sahsi' ? undefined : 'sari'}>{x.karar === 'sahsi' ? 'şahsi' : 'işletme borcu'}</Cip>
              <Dugme kucuk disabled={mesgul === x.id} onClick={() => karar(x, x.karar === 'sahsi' ? 'borc' : 'sahsi')}>{x.karar === 'sahsi' ? 'Borç yap' : 'Şahsi yap'}</Dugme>
              <Dugme kucuk disabled={mesgul === x.id} onClick={() => karar(x, '')}>Kararı geri al</Dugme>
            </div>
          ))}
        </details>
      )}
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
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  useEffect(() => { api('/evvel-yeni/mulk/uyarilar').then(setV).catch((e) => setHata(e?.message || 'okunamadı')); }, []);
  return (
    <>
      <Baslik ad="Uyarılar" />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && v.geciken.length === 0 && v.artis.length === 0 && <div style={{ color: R.not }}>Uyarı yok.</div>}
      {(v?.geciken || []).map((g) => (
        <div key={g.id + g.ay} style={{ ...kart, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Cip tur="kirmizi">Kira gelmedi</Cip><span style={{ flex: 1 }}><b>{g.ad}</b>{g.kiraci ? ` · ${g.kiraci}` : ''} · {g.ay} · kalan <b style={num}>{fmt(g.kalan)}</b> ₺</span>
          <Dugme kucuk onClick={() => onSekme?.('mulk_takvim')}>Ev kiraları</Dugme>
        </div>
      ))}
      {(v?.artis || []).map((e) => (
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
      {gorunum === 'mulk_borc' ? <IsletmeBorcu onToast={onToast} /> : gorunum === 'mulk_uyari' ? <Uyarilar onSekme={onSekme} /> : <EvKiralari onToast={onToast} />}
    </div>
  );
}
