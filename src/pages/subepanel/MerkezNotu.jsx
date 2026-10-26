// 📝 MERKEZ NOTU (Fable + Codex 21 Eki). Eski panel #mn AYNEN: metin (≥3) → içeride personel + PIN → kaydet. Para / stok yazmaz.
// 🔒 SAHİP KURALI (21 Eki): personel kasa sisteminin derinliğini BİLMEZ — ekranda notun merkezde nereye bağlandığı / kasa ile ilişkisi
// ANLATILMAZ, kasa örneği verilmez (yoksa eksik notla örtülür → güvenlik). Merkezde nereye düştüğü yalnız merkez ekranlarında.
// Sunucu: evvel_yeni_panel_api.merkez_notu → olay 'not' (yalnız insan yazar — sistem bildirimi bu türe yazılmaz).
import React, { useState } from 'react';
import { api } from '../../utils/api';
import { C, KisiPin, Modal, panelHata, yeniIstek } from './ortak';

export default function MerkezNotu({ d, subeId, adaylar, kapat, bitti }) {
  const [metin, setMetin] = useState('');
  const [adim, setAdim] = useState(0);   // 0 metin · 1 kişi + PIN
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [istek, setIstek] = useState(yeniIstek);
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const devam = () => {
    setHata('');
    if (metin.trim().length < 3) { setHata('Notu yaz (en az 3 harf)'); return; }
    setAdim(1);
  };
  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/not`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, metin: metin.trim() } });
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.mesaj || 'Not merkeze iletildi'), !!r.kuru);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setAdim(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') setAdim(0);
    }
    setMesgul(false);
  };
  return (
    <Modal baslik="📝 Merkez notu" kapat={kapat}>
      {adim === 0 && (<>
        <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 13 }}>Merkeze ne iletmek istiyorsun? *</span>
          <textarea className="sp-in" style={{ fontSize: 16, minHeight: 120, resize: 'vertical' }} value={metin} maxLength={2000}
            onChange={(e) => setMetin(e.target.value)} placeholder="ör. müşteri iadesi, arıza, eksik ürün"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); devam(); } }} /></label>   {/* laptop: Ctrl+Enter = Devam (düz Enter yeni satır) */}
        <div style={{ color: C.soluk, fontSize: 12 }}>Not merkeze iletilir.</div>
        {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
        <button className="sp-btn sp-yesil" onClick={devam}>Devam → kim yazıyor?</button>
      </>)}
      {adim === 1 && (<>   {/* G51 (sim 23 Eki): gönderilen not görünmüyordu → özet + düzelt + kişi + PIN (Gider ile aynı tek pencere) */}
        <div style={{ background: C.bg2, borderRadius: 10, padding: 10, whiteSpace: 'pre-wrap', maxHeight: '25vh', overflow: 'auto' }}>{metin.trim()}</div>
        <button type="button" className="sp-btn sp-orta" style={{ justifySelf: 'start' }} disabled={mesgul} onClick={() => setAdim(0)}>« Düzelt</button>
        <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim yazıyor?"
          devam={kaydet} devamYazi={mesgul ? 'Gönderiliyor…' : '📝 Merkeze gönder'} />
      </>)}
    </Modal>
  );
}
