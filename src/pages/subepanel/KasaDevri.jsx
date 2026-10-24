// 💵 KASA DEVRİ — panel tarafı. v2 (DEVIR_KURGU_V2.md, sahip 23 Eki "baştan sona yeniden kurgula"):
// Panel YALNIZ başlatır ve DURUMU gösterir — HİÇBİR RAKAM yok (kör sayım; personel kasa derinliğini bilmez).
// "Devri başlat" → QR → kasa sahibi okutursa devreden, başkası okutursa devralan formu → ikisi AYRI sayar → sistem karşılaştırır →
// tuttu / "birlikte bir kez daha sayın" (yalnız tutmayan KALEM ADI) / ikinci de tutmazsa merkeze. Devir mantığı Yoklama modülünde
// (tak-çıkar: panel yalnız PUBLIC uçları çağırır). Kayıtlı PC imzası (cihazImza 'tablet').
import React, { useEffect, useRef, useState } from 'react';
import { imzaliJson } from '../../utils/cihazImza';
import { C, Modal, qrBoyut, TabletQR, yeniIstek } from './ortak';

export const DEVIR_ACIK = ['baslatildi', 'sayiliyor', 'yeniden', 'dolduruluyor', 'hazir', 'devreden_onayladi'];

// Sağ kolondaki / ana sayfadaki kısa durum satırı (KÖR)
export function devirEtiket(devir, kapandi = false) {
  if (!devir) return kapandi ? { renk: C.soluk, metin: '— gün kapandı' } : { renk: C.soluk, metin: '○ Henüz devir yok' };   // B6
  return {
    baslatildi: { renk: C.sari, metin: '⏳ Devir başladı — QR okutulsun' },
    sayiliyor: { renk: C.sari, metin: '⏳ Sayım sürüyor' },
    yeniden: { renk: C.kirmizi, metin: '⚠ Tutmadı — birlikte yeniden sayılıyor' },
    tamam: { renk: C.yesil, metin: `✓ Kasa artık: ${devir.devralan || ''}` },
    tutmadi: { renk: C.kirmizi, metin: `⚠ Tutmadı, merkeze bildirildi · kasa artık: ${devir.devralan || ''}` },
    tutmuyor: { renk: C.kirmizi, metin: `⚠ Tutmuyor · kasa artık: ${devir.devralan || ''}` },   // eski akış (tarihsel)
    merkez_kapatti: { renk: C.soluk, metin: '🏢 Merkez kapattı' },
    dolduruluyor: { renk: C.sari, metin: '⏳ Eski devir — iptal edip yeniden başlat' },
    hazir: { renk: C.sari, metin: '⏳ Eski devir — iptal edip yeniden başlat' },
    devreden_onayladi: { renk: C.sari, metin: '⏳ Eski devir — merkez kapatsın' },
  }[devir.durum] || { renk: C.soluk, metin: devir.durum };
}

function TarafSatiri({ ikon, ad, basladi, saydi, bos, uyari }) {
  // V30 (sim 24 Eki): kasa sahibi saydı ama kasayı alan yok → AYNI satır turuncu (yeni satır yok — sıfır kayma)
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 16, padding: '8px 10px', borderRadius: 10,
      background: uyari ? 'rgba(245,158,11,.16)' : C.bg2, border: uyari ? `2px solid ${C.sari}` : '2px solid transparent' }}>
      <span style={{ fontSize: 20 }}>{ikon}</span>
      <b style={{ flex: 1 }}>{uyari || ad || bos}</b>
      <span style={{ fontWeight: 800, color: saydi ? C.yesil : basladi ? C.sari : uyari ? C.sari : C.soluk }}>{saydi ? '✓ saydı' : basladi ? '⏳ sayıyor' : '○ QR okutmadı'}</span>
    </div>
  );
}

export default function KasaDevri({ devir, tabletVar, kapali, kapat, yukle, iptal, mesgulDis }) {
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const acik = !!devir && DEVIR_ACIK.includes(devir.durum);
  const yeni = acik && ['baslatildi', 'sayiliyor', 'yeniden'].includes(devir.durum);
  // sahip 23 Eki: devir SONUÇLANINCA (pencere açıkken açık → bitti) sonuç 10 sn görünür, pencere kendiliğinden kapanır
  const onceki = useRef(devir?.durum);
  const [kalan, setKalan] = useState(null);
  useEffect(() => {
    const o = onceki.current; onceki.current = devir?.durum;
    if (['baslatildi', 'sayiliyor', 'yeniden'].includes(o) && devir && ['tamam', 'tutmadi'].includes(devir.durum)) setKalan(10);
  }, [devir?.durum]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (kalan == null) return undefined;
    if (kalan <= 0) { kapat(); return undefined; }
    const t = window.setTimeout(() => setKalan((k) => k - 1), 1000);
    return () => window.clearTimeout(t);
  }, [kalan, kapat]);
  const baslat = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try { await imzaliJson('tablet', 'POST', '/api/evvel-yeni/yoklama/devir-baslat', { istek_id: yeniIstek() }); await yukle(); }
    catch (e) { setHata(e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'Devir başlatılamadı')); }
    setMesgul(false);
  };
  const qrB = qrBoyut(300, 200, 160);
  const et = devirEtiket(devir);
  return (
    <Modal baslik="💵 Kasa Devri" kapat={kapat}>
      {!tabletVar && <b style={{ color: C.sari }}>Bu bilgisayar kayıtlı değil — devir QR'ı çıkamaz. Merkezden bağlantı iste.</b>}
      {/* bitmiş devir: büyük durum satırı — sahip: günde BİR devir, ikinci devir düğmesi YOK (sunucu da 409; yalnız merkez iptalinden sonra yeniden) */}
      {devir && !acik && (
        <div className="sp-kart" style={{ display: 'grid', gap: 6, borderColor: et.renk, borderWidth: 2 }}>
          <b style={{ color: et.renk, fontSize: 20 }}>{et.metin}</b>
          <div style={{ color: C.soluk, fontSize: 14 }}>{devir.devreden} → {devir.devralan || '—'}{devir.devralan_saat ? ` · ${devir.devralan_saat}` : ''}{devir.vekil && devir.ustlenen ? (devir.ustlenen_id === devir.devreden_id ? ' · kasa sahibi içeride değildi' : ` · ${devir.ustlenen}, ${devir.devreden} adına saydı`) : ''}</div>
        </div>
      )}
      {/* sahip 23 Eki: "devir bir kere olur" — tamamlanmış devir varsa yeni devir YOK (yalnız iptal/düşen devirden sonra yeniden) */}
      {!acik && tabletVar && !kapali && !devir && (<>
        <div style={{ color: C.soluk, fontSize: 14 }}>Devri başlat → ekranda QR çıkar → <b>kasayı veren</b> ve <b>kasayı alan</b> kendi telefonuyla okutur, ikisi ayrı sayar. Sistem karşılaştırır. Günde bir devir olur.</div>
        <button className="sp-btn sp-yesil" disabled={mesgul} onClick={baslat}>{mesgul ? 'Başlatılıyor…' : '💵 Devri başlat'}</button>
      </>)}
      {devir && !acik && <div style={{ color: C.soluk, fontSize: 13 }}>Bugünkü devir yapıldı — günde bir devir olur.{kalan != null && kalan > 0 ? ` · Bu pencere ${kalan} sn içinde kapanır.` : ''}</div>}
      {!devir && kapali && <div style={{ color: C.soluk, fontSize: 13 }}>Gün kapandı — devir yok.</div>}
      {yeni && (
        <div style={{ display: 'grid', gap: 10 }}>
          {devir.durum === 'yeniden' && (
            <div style={{ border: `2px solid ${C.kirmizi}`, background: 'rgba(239,68,68,.12)', borderRadius: 12, padding: '10px 12px', fontWeight: 800, color: C.kirmizi, fontSize: 17 }}>
              ⚠ Tutmadı — birlikte bir kez daha sayın: {(devir.fark_kalem || []).join(', ')}
            </div>
          )}
          <TarafSatiri ikon="📤" ad={devir.devreden || devir.kasa_sahibi} basladi={!!devir.devreden_id} saydi={devir.devreden_saydi} bos="Kasa sahibi" />
          <TarafSatiri ikon="📥" ad={devir.devralan} basladi={!!devir.devralan_id} saydi={devir.devralan_saydi} bos="Kasayı alacak kişi"
            uyari={devir.devreden_saydi && !devir.devralan_id ? '⚠ Kasayı kimse almadı — alacak kişi QR okutsun' : null} />
          {tabletVar && <div style={{ justifySelf: 'center' }}><TabletQR boyut={devir.durum === 'baslatildi' ? qrB : Math.min(220, qrB)} devir={devir.id} /></div>}
          <span style={{ color: C.soluk, fontSize: 13, textAlign: 'center' }}>
            {devir.durum === 'yeniden' ? 'İkiniz de telefonunuzda yalnız tutmayan kalemleri yeniden sayıp gönderin.'
              : `${devir.kasa_sahibi || 'Kasa sahibi'} okutursa devreden, diğeri okutursa devralan olur · başladı ${devir.panel}`}
          </span>
        </div>
      )}
      {acik && !yeni && <div style={{ color: C.soluk }}>Eski devir formu ({devir.devreden || '—'} → {devir.devralan || '—'}) — {devir.durum === 'devreden_onayladi' ? 'merkez kapatsın' : 'iptal edip yeniden başlat'}.</div>}
      {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
      {acik && ['dolduruluyor', 'hazir'].includes(devir.durum) && (   /* yalnız eski akış satırı; v2 devri panelden iptal edilmez (günde bir devir) */
        <button className="sp-btn" style={{ minHeight: 52 }} disabled={mesgul || mesgulDis} onClick={iptal}>✕ Eski devri iptal et</button>
      )}
      {yeni && <div style={{ color: C.soluk, fontSize: 13, textAlign: 'center' }}>Günde bir devir olur — takılırsa merkeze haber ver.</div>}
    </Modal>
  );
}
