// ─────────────────────────────────────────────────────────────────────────────
// 🚚 EVVEL YENİ · TOPTANCILAR — borç TESLİMDE doğar (şube paneli), tek kayıt
//
// Sahip + Codex + Fable (2026-10-16): fatura gelince AYNI teslimin tutarı kesinleşir (çift sayım yok);
// tutarsız teslimde adet × fiyat TAHMİNİ; ödemeler Ödeme formundan; vadesi geçen ekranda hesaplanır.
// Bütün rakamlar /api/evvel-yeni/toptanci'dan; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt, tKisa } from './KasaModulu';

export const TOPTANCI_SAYFALAR = [
  { id: 'toptancilar', ad: 'Toptancılar', alt: 'Borcumuz · vade · teslimler' },
];

const alan = {
  width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)',
  color: 'var(--pi-ink)', font: 'inherit', fontSize: 15, minWidth: 0,
};
const sayi = (x) => { const t = String(x ?? '').trim().replace(/\s/g, ''); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? n : NaN; };
const gunStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api('/evvel-yeni/toptanci/ozet'); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

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
  const Kutu = ({ ad, deger, renk, alt }) => (
    <div style={{ ...kart, padding: 12 }}>
      <div style={{ fontSize: 12, color: R.not }}>{ad}</div>
      <div style={{ ...num, fontSize: 22, fontWeight: 800, color: renk }}>{deger}</div>
      {alt && <div style={{ fontSize: 11.5, color: R.not }}>{alt}</div>}
    </div>
  );

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Tedarik</div><h1 style={{ fontSize: 30 }}>Toptancılar</h1></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Kutu ad="Öngörülen borcumuz" deger={`${fmt(T.bakiye)} ₺`} renk={R.kirmizi} alt={`kesin ${fmt(T.kesin)} · tahmini ${fmt(T.tahmini)}`} />
        <Kutu ad="Vadesi geçen" deger={`${fmt(T.vadesi_gecen)} ₺`} renk={T.vadesi_gecen > 0 ? R.kirmizi : R.yesil} />
        <Kutu ad="Bu hafta dolan" deger={`${fmt(T.bu_hafta)} ₺`} renk={T.bu_hafta > 0 ? R.amber : undefined} />
        <Kutu ad="Tutarı bilinmeyen teslim" deger={T.bilinmeyen_sayi} renk={T.bilinmeyen_sayi ? R.kirmizi : R.yesil} alt="fatura/ekstre gelince tutarı gir" />
      </div>
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
                  {t.sapma_sayi > 0 && <Cip tur="sari">⚠ {t.sapma_sayi} tutar tahminden %30+ farklı</Cip>}
                </div>
              </div>
              <div style={{ fontSize: 12, color: R.not, textAlign: 'right' }}>açılış {fmt(t.acilis)} · kesin {fmt(t.kesin)} · tahmini {fmt(t.tahmini)}<br />ödenen {fmt(t.odenen)}</div>
              <div style={{ ...num, fontWeight: 800, fontSize: 18, minWidth: 110, textAlign: 'right', color: t.bakiye > 0 ? R.kirmizi : t.bakiye < 0 ? R.amber : R.yesil }}>{fmt(t.bakiye)} ₺</div>
              <span style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
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
                              {(h.kalemler || []).length > 0 && <div style={{ fontSize: 11.5, color: R.not }}>{h.kalemler.map((k) => `${k.ad} ×${k.adet}${k.birim != null ? ` @${fmt(k.birim)}` : ' (fiyat eksik)'}`).join(' · ')}</div>}
                              {h.tahmini != null && h.kesin != null && <div style={{ fontSize: 11.5, color: h.sapma_uyari ? R.kirmizi : R.not }}>tahmin {fmt(h.tahmini)} → kesin {fmt(h.kesin)}{h.sapma != null ? ` (%${h.sapma})` : ''}{h.sapma_uyari ? ' ⚠ birim (koli/adet) karışmış olabilir' : ''}</div>}
                              {h.vade && <div style={{ fontSize: 11.5, color: R.not }}>vade {tKisa(h.vade)}</div>}
                              {h.aciklama && <div style={{ fontSize: 11.5, color: R.not }}>{h.aciklama}</div>}
                              {(h.iz || []).map((z, i) => <div key={i} style={{ fontSize: 11, color: R.not }}>✎ {z.zaman} {z.kim}: {z.eski != null ? `${fmt(z.eski)} → ` : ''}{fmt(z.yeni)} · {z.sebep}</div>)}
                              {h.iptal && <span style={{ color: R.kirmizi }}> · İPTAL ({h.iptal_sebep})</span>}
                            </> : <>💸 ödeme · {h.aciklama}{h.kartla ? ' · 💳' : ''}</>}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {h.tur === 'teslim'
                              ? <><b style={{ ...num, color: d.renk }}>{h.borc != null ? `+${fmt(h.borc)}` : '?'}</b><div style={{ fontSize: 11, color: d.renk }}>{d.ad}{h.durum === 'tahmini' && h.fiyat_eksik ? ` · ${h.fiyat_eksik} kalem fiyatsız` : ''}</div></>
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

      {tutarForm && (
        <Pencere baslik={`🧾 Tutar — ${tKisa(tutarForm.h.tarih)} ${tutarForm.h.sube}`} onKapat={() => !mesgul && setTutarForm(null)}>
          {tutarForm.h.tahmini != null && <div style={{ fontSize: 13, color: R.not }}>Sistemin tahmini: {fmt(tutarForm.h.tahmini)} ₺</div>}
          <Etiket ad="Fatura / ekstredeki tutar ₺ *"><input style={alan} inputMode="decimal" autoFocus value={tutarForm.tutar} onChange={(e) => setTutarForm({ ...tutarForm, tutar: e.target.value })} /></Etiket>
          <Etiket ad="Fatura no"><input style={alan} value={tutarForm.fatura_no} onChange={(e) => setTutarForm({ ...tutarForm, fatura_no: e.target.value })} /></Etiket>
          {tutarForm.h.kesin != null && <Etiket ad="Neden değişiyor? *"><input style={alan} value={tutarForm.sebep} onChange={(e) => setTutarForm({ ...tutarForm, sebep: e.target.value })} /></Etiket>}
          <Butonlar mesgul={mesgul} onVazgec={() => setTutarForm(null)} onKaydet={() => {
            const t = sayi(tutarForm.tutar);
            if (!(t > 0)) { onToast?.('Tutar gir'); return; }
            gonder(`/evvel-yeni/toptanci/teslim/${tutarForm.h.id}/tutar`, { tutar: t, fatura_geldi: true, fatura_no: tutarForm.fatura_no || null, sebep: tutarForm.sebep || null }, () => setTutarForm(null));
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
