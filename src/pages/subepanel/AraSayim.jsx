// ⏱ ARA KASA SAYIMI — tam ekran (PANEL_YENIDEN_KURULUM.md 'ARA SAYIM' A1–A5). Sunucu görevi açınca (/durum ara_sayim) panel 15 dk KİLİTLİ:
// çekmecedeki TÜM nakit KÖR sayılır (beklenen / fark ASLA gösterilmez) → 'Sayımı gönder' → ekranda QR → sayan kişi KENDİ telefonuyla okutur
// ve onaylar (kimlik telefondan). Süre dolarsa kilit kendiliğinden kalkar, merkez 'yapılmadı' görür. Bip yok. Sık işlemleri sunucu da
// durdurur (409). Görev, onay ve kayıt sunucuda: evvel_yeni_panel_api ara_sayim_* (yeni tablo yok).
import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { C, panelHata, qrBoyut, TabletQR, tutar, tutarNum, tl } from './ortak';

export default function AraSayim({ subeId, a, tabletVar, yenile }) {
  const [kalan, setKalan] = useState(a.kalan_sn);
  const [deger, setDeger] = useState('');
  const [onayId, setOnayId] = useState(a.gonderildi ? a.onay_id : null);   // gönderildiyse QR görünür (yenilemede kaybolmaz)
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  useEffect(() => { setKalan(a.kalan_sn); }, [a.kalan_sn]);
  useEffect(() => {
    const t = window.setInterval(() => setKalan((k) => Math.max(0, k - 1)), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => { if (kalan === 0) yenile(); }, [kalan]);   // eslint-disable-line react-hooks/exhaustive-deps
  const dk = String(Math.floor(kalan / 60)).padStart(2, '0');
  const sn = String(kalan % 60).padStart(2, '0');

  const gonder = async () => {
    if (mesgul) return;
    if (deger === '' || Number.isNaN(tutarNum(deger))) { setHata('Çekmecedeki TÜM parayı say ve yaz (boşsa 0)'); return; }
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/ara-sayim`, { method: 'POST', body: { sayilan: tutarNum(deger) } });
      setOnayId(r.onay_id);
    } catch (e) {
      panelHata(e, { setHata: (m) => setHata(m || 'Gönderilemedi — tekrar dene') });
    }
    setMesgul(false);
  };

  // 'Tutarı düzelt' sunucudaki tutarı SİLER — telefonda açık eski QR eski tutarı onaylayamaz (Fable D-A)
  const duzelt = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/ara-sayim-duzelt`, { method: 'POST', body: {} });
      setOnayId(null); setDeger('');
    } catch (e) { panelHata(e, { setHata: (m) => setHata(m || 'Düzeltilemedi — tekrar dene') }); }
    setMesgul(false);
  };

  return (
    <div className="sp-perde" style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(5,8,15,.97)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="sp-kart" style={{ width: 'min(560px,100%)', display: 'grid', gap: 14, textAlign: 'center', borderColor: C.sari }}>
        <div style={{ fontSize: 40 }}>⏱</div>
        <b style={{ fontSize: 24 }}>Ara kasa sayımı{a.deneme ? ' (DENEME)' : ''}</b>
        <div style={{ fontSize: 34, fontWeight: 900, color: kalan < 120 ? C.kirmizi : C.sari }}>{dk}:{sn}</div>
        <div style={{ color: C.soluk }}>Panel bu süre boyunca kilitli. Çekmecedeki <b style={{ color: C.yazi }}>TÜM nakdi</b> say ve yaz.</div>
        {!onayId ? (<>
          <input className="sp-in" inputMode="decimal" autoComplete="off" placeholder="0,00" value={deger}
            onChange={(e) => setDeger(tutar(e.target.value))} style={{ fontSize: 34, fontWeight: 900, textAlign: 'center' }} />
          {deger !== '' && <div style={{ color: C.soluk }}>{tl(tutarNum(deger))}</div>}
          {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-yesil" disabled={mesgul || kalan === 0} onClick={gonder}>{mesgul ? 'Gönderiliyor…' : 'Sayımı gönder → QR'}</button>
        </>) : (<>
          <div style={{ fontWeight: 700 }}>Sayan kişi KENDİ telefonuyla bu QR'ı okutup onaylasın</div>
          <div style={{ justifySelf: 'center' }}>{tabletVar ? <TabletQR boyut={qrBoyut(320, 200, 80)} onay={onayId} />
            : <div style={{ color: C.sari, fontWeight: 700 }}>Bu bilgisayar tablet olarak bağlı değil — QR gösterilemiyor, merkeze haber ver</div>}</div>
          <div style={{ color: C.soluk, fontSize: 13 }}>Onaylanınca ekran kendiliğinden açılır.</div>
          {a.durum === 'hata' && a.mesaj && <div style={{ color: C.kirmizi, fontWeight: 700 }}>Telefon onayı olmadı: {a.mesaj} — QR'ı yeniden okut</div>}
          {a.durum === 'isleniyor' && <div style={{ color: C.sari, fontWeight: 700 }}>Telefondan onaylanıyor…</div>}
          <button className="sp-btn" style={{ minHeight: 56 }} disabled={kalan === 0 || mesgul || a.durum === 'isleniyor'} onClick={duzelt}>« Tutarı düzelt (yeniden say)</button>
        </>)}
      </div>
    </div>
  );
}
