// 🧾 ANLIK GİDER FİŞ KONTROL — tak-çıkar modül (sunucu: evvel_yeni_fis_api.py). Sayfası Gider altında.
// Sahip (2026-10-17): "Fiş kontrol olsun; fiş olmazsa personelle beraber girişi yapan yazsın; ayrı sekmede. Panelden
// girişlerde yeterli, bizim girişlerimizde gerek yok." Yalnız şube panelinden gelen dükkân giderleri listelenir.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, fmt, tKisa } from './KasaModulu';

export const FIS_SAYFALAR = [{ id: 'fis_kontrol', ad: 'Anlık gider fiş kontrol', alt: 'Panelden girilen giderler' }];

const DURUM_CIP = { bekliyor: ['sari', 'fiş bekleniyor'], geldi: ['yesil', 'fiş geldi'], gelmedi: ['kirmizi', 'fiş gelmedi'], muaf: ['gri', 'fiş gerekmez'] };

export default function FisModulu({ onToast }) {
  const [mod, setMod] = useState('bekliyor');
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => {
    setHata('');
    api(`/evvel-yeni/fis/liste?durum=${mod}`).then(setV).catch((e) => setHata(e?.message || 'Liste okunamadı'));
  }, [mod]);
  useEffect(() => { yukle(); }, [yukle]);
  const isaretle = async (ref, durum) => {
    setMesgul(ref);
    try { const d = await api('/evvel-yeni/fis/isaretle', { method: 'POST', body: { ref, durum } }); onToast?.(d.mesaj); yukle(); }
    catch (e) { setHata(e?.message || 'Kaydedilemedi'); }
    setMesgul('');
  };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Gider</div><h1 style={{ fontSize: 30 }}>Anlık gider fiş kontrol</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Yalnız şube panelinden girilen giderler. Fişi gelmeyen gider, girişi yapan personelin adıyla kalır.</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['bekliyor', `Fiş bekleyen${v ? ` (${v.bekliyor})` : ''}`], ['gelmedi', `Fiş gelmeyen${v ? ` (${v.gelmedi})` : ''}`], ['hepsi', 'Hepsi']].map(([k, a]) => (
          <Dugme key={k} kucuk ana={mod === k} onClick={() => setMod(k)}>{a}</Dugme>
        ))}
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && mod === 'gelmedi' && v.kisi_ozet.length > 0 && (
        <div style={{ ...kart, padding: '10px 14px', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div style={etiketStil}>Fişi gelmeyen · girişi yapan</div>
          {v.kisi_ozet.map((k) => <span key={k.giren} style={{ fontSize: 13.5 }}><b>{k.giren}</b> · {k.adet} gider · <b style={num}>{fmt(k.tutar)} ₺</b></span>)}
        </div>
      )}
      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          {v.satirlar.length === 0 && <div style={{ color: R.not, padding: 6 }}>{mod === 'bekliyor' ? 'Fiş bekleyen gider yok.' : 'Kayıt yok.'}</div>}
          {v.satirlar.map((x) => {
            const [cipTur, cipAd] = DURUM_CIP[x.durum] || DURUM_CIP.bekliyor;
            return (
              <div key={x.ref} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '7px 0', fontSize: 13.5 }}>
                <span style={{ width: 52, color: R.metin2 }}>{tKisa(x.tarih)}</span>
                <span style={{ width: 80 }}>{x.sube}</span>
                <span style={{ flex: '1 1 200px', minWidth: 0 }}>{x.aciklama}
                  <span style={{ color: x.durum === 'gelmedi' ? R.kirmizi : R.not }}> · giren: <b>{x.giren}</b></span>
                  {x.kart && <span style={{ color: R.not }}> · kart/havale</span>}
                  {x.panel_gonderildi && x.durum === 'bekliyor' && <span style={{ color: R.not }}> · panelde "fiş gönderildi" dendi</span>}
                </span>
                <b style={{ ...num, width: 80, textAlign: 'right' }}>{fmt(x.tutar)}</b>
                <Cip tur={cipTur}>{cipAd}</Cip>
                <span style={{ display: 'flex', gap: 4 }}>
                  {x.durum !== 'geldi' && <Dugme kucuk disabled={mesgul === x.ref} onClick={() => isaretle(x.ref, 'geldi')}>Geldi</Dugme>}
                  {x.durum !== 'gelmedi' && <Dugme kucuk disabled={mesgul === x.ref} onClick={() => isaretle(x.ref, 'gelmedi')}>Gelmedi</Dugme>}
                  {x.durum === 'bekliyor' && <Dugme kucuk disabled={mesgul === x.ref} onClick={() => isaretle(x.ref, 'muaf')}>Gerekmez</Dugme>}
                  {x.durum !== 'bekliyor' && <Dugme kucuk disabled={mesgul === x.ref} onClick={() => isaretle(x.ref, 'bekliyor')}>Geri al</Dugme>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
