// 🧾 FATURALARI ŞUBELERE DAĞIT — İŞLETMEYE ÖZEL modül (sunucu: evvel_yeni_fatura_api.py). Sayfası Ödeme altında.
// Sahip (2026-10-17): "Otomatik ödenen faturaları kart ekstresinden abone kodlarıyla şubelere eşleştirelim; çıkarıldığında
// başka alanları sıkıntıya sokmasın, sadece bize özgü." Ayda bir: kart seç → ekstre PDF → satırların şubesi → kaydet.
// Kaydedilen satır Ödeme'nin kendi kaydıdır (kartla fatura) → şube gideri; bir kez seçilen şube sonraki ay hatırlanır.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, fmt, tKisa } from './KasaModulu';

export const FATURA_SAYFALAR = [{ id: 'fatura_dagit', ad: 'Faturaları dağıt', alt: 'Kart ekstresi → şube gideri' }];

const alan = { padding: '8px 10px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, minWidth: 0 };

export default function FaturaModulu({ onToast }) {
  const [kartlar, setKartlar] = useState([]);
  const [kartId, setKartId] = useState('');
  const [v, setV] = useState(null);           // /oku sonucu
  const [sec, setSec] = useState({});         // satır id → { hedef, fatura_turu }
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const [yapistir, setYapistir] = useState(false);
  const [metin, setMetin] = useState('');
  const [sonuc, setSonuc] = useState(null);
  const [sonGovde, setSonGovde] = useState(null);   // kaydettikten sonra aynı ekstreyi yeniden okumak için
  const istekNo = useRef(0);                          // Codex: geç gelen eski cevap ekrana basılmasın
  const [kurallar, setKurallar] = useState(null);
  const kuralYukle = () => api('/evvel-yeni/fatura/kurallar').then((d) => setKurallar(d.kurallar)).catch(() => {});
  const unut = async (k) => { try { await api(`/evvel-yeni/fatura/kural-sil?kart_id=${encodeURIComponent(k.kart_id)}&anahtar=${encodeURIComponent(k.anahtar)}`, { method: 'POST' }); kuralYukle(); } catch (e) { setHata(e?.message || 'Silinemedi'); } };

  useEffect(() => {
    api('/evvel-yeni/odeme/listeler').then((d) => setKartlar(d?.kartlar || [])).catch(() => setHata('Kartlar okunamadı'));
  }, []);

  const oku = async (govde, sonucuKoru) => {
    const n = ++istekNo.current;
    setMesgul(true); setHata(''); if (!sonucuKoru) setSonuc(null); setSonGovde(govde);
    try {
      const d = await api('/evvel-yeni/fatura/oku', { method: 'POST', body: { kart_id: kartId, ...govde } });
      if (n !== istekNo.current) return;
      setV(d);
      const s = {};
      d.satirlar.forEach((x) => { s[x.id] = { hedef: x.durum === 'yeni' ? (x.oneri || '') : '', fatura_turu: x.fatura_turu }; });
      setSec(s);
    } catch (e) { setHata(e?.message || 'Ekstre okunamadı'); setV(null); }
    setMesgul(false);
  };
  const pdfSec = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new window.FileReader();
    r.onload = () => oku({ pdf: String(r.result) });
    r.readAsDataURL(f);
    e.target.value = '';
  };
  const kaydet = async () => {
    const satirlar = v.satirlar.filter((x) => x.durum === 'yeni' && sec[x.id]?.hedef)
      .map((x) => ({ id: x.id, istek: x.istek, tarih: x.tarih, aciklama: x.aciklama, tutar: x.tutar, no: x.no, imza: x.imza, ...sec[x.id] }));
    if (!satirlar.length) { setHata('Şubesi seçilmiş satır yok'); return; }
    setMesgul(true); setHata('');
    try {
      const d = await api('/evvel-yeni/fatura/kaydet', { method: 'POST', body: { kart_id: v.kart.id, satirlar } });   // okunan ekstrenin kartı
      setSonuc(d); onToast?.(d.mesaj);
      if (sonGovde) await oku(sonGovde, true);
    } catch (e) { setHata(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };

  const yeni = v ? v.satirlar.filter((x) => x.durum === 'yeni') : [];
  const secili = yeni.filter((x) => sec[x.id]?.hedef && sec[x.id].hedef !== 'yoksay');
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>Faturaları şubelere dağıt</h1></div>
      <div style={{ ...kart, padding: '12px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={kartId} disabled={mesgul} onChange={(e) => { istekNo.current += 1; setKartId(e.target.value); setV(null); setSonuc(null); }} style={alan}>
          <option value="">Kart seç…</option>
          {kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}
        </select>
        <label style={{ ...alan, cursor: kartId && !mesgul ? 'pointer' : 'not-allowed', opacity: kartId ? 1 : 0.5, background: 'var(--pi-accent)', color: 'var(--pi-on, #fff)', fontWeight: 600 }}>
          {mesgul ? 'Okunuyor…' : '📄 Ekstre PDF yükle'}
          <input type="file" accept="application/pdf" disabled={!kartId || mesgul} onChange={pdfSec} style={{ display: 'none' }} />
        </label>
        <Dugme kucuk disabled={!kartId} onClick={() => setYapistir((x) => !x)}>{yapistir ? 'Kapat' : 'PDF okunmuyorsa: metni yapıştır'}</Dugme>
        <span style={{ fontSize: 12.5, color: R.not, flexBasis: '100%' }}>
          Ekstredeki fatura satırları listelenir. Şubesini bir kez seçtiğin satır sonraki ay kendiliğinden gelir. Kaydedilen fatura o şubenin giderine yazılır; kartla ödendiği için kasadan düşmez.
        </span>
      </div>
      {yapistir && (
        <div style={{ ...kart, padding: '12px 14px', display: 'grid', gap: 8 }}>
          <textarea value={metin} onChange={(e) => setMetin(e.target.value)} rows={6} placeholder="Ekstrenin metnini buraya yapıştır (tarih … açıklama … tutar)" style={{ ...alan, width: '100%' }} />
          <div><Dugme kucuk ana disabled={!metin.trim() || mesgul} onClick={() => oku({ metin })}>Oku</Dugme></div>
        </div>
      )}
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {sonuc && <div style={{ ...kart, padding: '10px 14px', color: R.yesil }}>{sonuc.mesaj}
        {sonuc.sonuc.filter((x) => !x.ok).map((x) => <div key={x.id} style={{ color: R.kirmizi, fontSize: 12.5 }}>• {x.mesaj}</div>)}</div>}
      <div>
        <Dugme kucuk onClick={() => (kurallar ? setKurallar(null) : kuralYukle())}>{kurallar ? 'Hatırlananları gizle' : 'Hatırlanan eşleşmeler'}</Dugme>
      </div>
      {kurallar && (
        <div style={{ ...kart, padding: '10px 14px', display: 'grid', gap: 4, fontSize: 13 }}>
          {kurallar.length === 0 && <div style={{ color: R.not }}>Henüz hatırlanan eşleşme yok.</div>}
          {kurallar.map((k) => (
            <div key={k.kart_id + k.anahtar} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 260px' }}>{k.anahtar.startsWith('no:') ? `abone no ${k.anahtar.slice(3)}` : `"${k.anahtar.slice(3)}"`}
                <span style={{ color: R.not }}> · {k.ornek}</span></span>
              <span>{k.belirsiz ? <Cip tur="sari">birden çok şube — her ay sorulur</Cip> : k.hedef === 'yoksay' ? <Cip>yok sayılıyor</Cip>
                : <b>{(v?.subeler || []).find((b) => b.id === k.hedef)?.ad || k.hedef}</b>}</span>
              <Dugme kucuk onClick={() => unut(k)}>Unut</Dugme>
            </div>
          ))}
        </div>
      )}
      {v && (
        <div style={{ ...kart, padding: '12px 14px', display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div style={etiketStil}>{v.kart.ad} · {v.satirlar.length} fatura satırı</div>
            <span style={{ fontSize: 12.5, color: R.not }}>{v.diger_sayi} satır fatura değil (dokunulmadı)</span>
            <span style={{ marginLeft: 'auto' }}>
              <Dugme ana disabled={mesgul || !secili.length} onClick={kaydet}>{secili.length} faturayı kaydet · {fmt(secili.reduce((t, x) => t + x.tutar, 0))} ₺</Dugme>
            </span>
          </div>
          {v.satirlar.length === 0 && <div style={{ color: R.not }}>Bu ekstrede fatura satırı bulunamadı.</div>}
          {v.satirlar.map((x) => {
            const s = sec[x.id] || {};
            const kapali = x.durum !== 'yeni';
            return (
              <div key={x.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(60px,70px) minmax(0,1fr) minmax(80px,100px) minmax(140px,190px) minmax(120px,160px)', gap: 8, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, paddingTop: 6, fontSize: 13.5, opacity: kapali ? 0.55 : 1 }}>
                <span style={{ color: R.metin2 }}>{tKisa(x.tarih)}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={x.aciklama}>
                  {x.aciklama}{' '}
                  {x.durum === 'girilmis' && <Cip tur="yesil">zaten girilmiş</Cip>}
                  {x.durum === 'gelecek' && <Cip tur="sari">ileri tarihli</Cip>}
                  {x.durum === 'donem_oncesi' && <Cip>Evvel Yeni öncesi — yazılmaz</Cip>}
                  {x.benzer && <Cip tur="sari" >benzer kayıt var: {x.benzer}</Cip>}
                  {x.kesin && x.durum === 'yeni' && <Cip tur="yesil">numaradan</Cip>}
                  {!x.kesin && x.oneri && x.durum === 'yeni' && <Cip tur="sari">geçen aydan</Cip>}
                  {x.belirsiz && x.durum === 'yeni' && <Cip tur="sari">birden çok şube — seç</Cip>}
                </span>
                <b style={{ ...num, textAlign: 'right' }}>{fmt(x.tutar)}</b>
                <select disabled={kapali} value={s.hedef || ''} onChange={(e) => setSec((o) => ({ ...o, [x.id]: { ...s, hedef: e.target.value } }))} style={alan}>
                  <option value="">Şube seç…</option>
                  {v.subeler.map((b) => <option key={b.id} value={b.id}>{b.ad}</option>)}
                  {v.patronlar.map((p) => <option key={p} value={`patron:${p}`}>Ev / {p} (şahsi)</option>)}
                  <option value="yoksay">Yok say (fatura değil)</option>
                </select>
                <select disabled={kapali || !s.hedef || s.hedef === 'yoksay' || s.hedef.startsWith('patron:')} value={s.fatura_turu || ''}
                  onChange={(e) => setSec((o) => ({ ...o, [x.id]: { ...s, fatura_turu: e.target.value } }))} style={alan}>
                  {v.fatura_turleri.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
