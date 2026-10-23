// 💸 ANLIK GİDER (1 Kasım listesi madde 7 — sahip kararları 2026-10-20). Eski panel #mg formu AYNEN: kategori (serbest, isteğe bağlı) ·
// tutar · AÇIKLAMA ZORUNLU (para çıkışı adsız olamaz) · fiş/fatura alındı mı · QR'la içeride personel + PIN → kaydet.
// Onay YOK (kayıt kesin; fiş kontrolü merkezde) · yalnız NAKİT (çekmeceden) · kasa uyarısı personele GÖSTERİLMEZ (kör sayım).
// Sunucu: evvel_yeni_panel_api.gider_gir → olay 'gider' + Kasa dukkan_gideri_yaz (tek yazıcı). Gün kapalıyken girilmez.
import React, { useState } from 'react';
import { api } from '../../utils/api';
import { C, KisiPin, Modal, panelHata, tl, tutar, tutarNum, yeniIstek } from './ortak';

export default function AnlikGider({ d, subeId, adaylar, kapali, kapat, bitti }) {
  const [kat, setKat] = useState('');
  const [tut, setTut] = useState('');
  const [acik, setAcik] = useState('');
  const [fis, setFis] = useState(null);
  const [adim, setAdim] = useState(0);   // 0 form · 1 tek onay penceresi (özet + kişi + PIN)
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [istek, setIstek] = useState(yeniIstek);
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const devam = () => {
    setHata('');
    if (!(tutarNum(tut) > 0)) { setHata('Tutarı yaz'); return; }
    if (acik.trim().length < 3) { setHata('Açıklama zorunlu — neye ödendiğini yaz'); return; }
    if (fis === null) { setHata('Fiş / fatura alındı mı? — EVET ya da HAYIR seç'); return; }
    setAdim(1);
  };
  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/gider`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, tutar: tutarNum(tut), aciklama: acik.trim(),
        kategori: kat.trim() || null, fis } });
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.mesaj || 'Gider kaydedildi'), !!r.kuru);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setAdim(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') setAdim(0);
    }
    setMesgul(false);
  };
  return (
    <Modal baslik="💸 Anlık gider" kapat={kapat}>
      {kapali ? <div style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — gider girilemez (merkez girer)</div> : (<>
        {adim === 0 && (<>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 13 }}>Kategori (isteğe bağlı)</span>
            <input className="sp-in" style={{ fontSize: 16 }} value={kat} maxLength={40} onChange={(e) => setKat(e.target.value)} placeholder="ör. sarf malzeme, temizlik" /></label>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 13 }}>Tutar (₺) *</span>
            <input className="sp-in" style={{ fontSize: 24, fontWeight: 800 }} inputMode="decimal" value={tut} onChange={(e) => setTut(tutar(e.target.value))} placeholder="0,00" /></label>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 13 }}>Açıklama * — neye ödendi?</span>
            <input className="sp-in" style={{ fontSize: 16 }} value={acik} maxLength={120} onChange={(e) => setAcik(e.target.value)} placeholder="ör. çöp poşeti + bulaşık deterjanı" /></label>
          <div style={{ display: 'grid', gap: 6 }}><b>🧾 Fiş / fatura alındı mı? *</b>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={'sp-btn' + (fis === true ? ' sp-ana' : '')} style={{ flex: 1 }} onClick={() => setFis(true)}>EVET</button>
              <button type="button" className={'sp-btn' + (fis === false ? ' sp-ana' : '')} style={{ flex: 1 }} onClick={() => setFis(false)}>HAYIR</button>
            </div></div>
          <div style={{ color: C.soluk, fontSize: 12 }}>Çekmeceden NAKİT ödenen gider. Kartla ödenen merkezden girilir.</div>
          {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-yesil" onClick={devam}>Devam → kim ödedi?</button>
        </>)}
        {adim === 1 && (<>   {/* TEK pencere — özet + kişi + PIN + kaydet (sahip 23 Eki, G23) */}
          <div style={{ fontSize: 24, fontWeight: 900, color: C.sari }}>{tl(tutarNum(tut))}</div>
          <div>{acik.trim()}{kat.trim() ? ` · ${kat.trim()}` : ''} · fiş {fis ? 'VAR' : 'YOK'}</div>
          <button type="button" className="sp-btn" style={{ minHeight: 40, justifySelf: 'start' }} disabled={mesgul} onClick={() => setAdim(0)}>« Düzelt</button>
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim ödedi?"
            devam={kaydet} devamYazi="💸 Gideri kaydet" mesgul={mesgul} />
        </>)}
      </>)}
    </Modal>
  );
}

// 🤝 ELDEN AVANS TESLİMİ (kesim engeli T3-17, sahip 20 Eki): merkez onayladı → çekmeceden veren ad + PIN → Kasa (şube avansı) + maaştan
// mahsup. Personelin "aldım" onayı YOK. Aynı çekmece nakdi işi olduğu için anlık giderle aynı dosyada (ortak parçalar).
export function AvansTeslim({ t, d, subeId, adaylar, kapat, bitti }) {
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [istek, setIstek] = useState(yeniIstek);
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/avans-teslim`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, talep_id: t.id } });
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.mesaj || 'Avans teslim edildi'), !!r.kuru);
    } catch (e) {
      panelHata(e, { setHata, pinSifirla: () => setPin(''), yeniIstekVer: () => setIstek(yeniIstek()) });
    }
    setMesgul(false);
  };
  return (
    <Modal baslik="🤝 Avans teslimi" kapat={kapat}>
      <div style={{ fontSize: 18 }}><b>{t.ad}</b> — <b style={{ color: C.sari }}>{tl(t.tutar)}</b> çekmeceden verildi mi?</div>
      <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim verdi?" devam={kaydet}
        devamYazi={mesgul ? 'Kaydediliyor…' : '🤝 Teslim ettim'} />
    </Modal>
  );
}
