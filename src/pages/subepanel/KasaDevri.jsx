// 💵 KASA DEVRİ — panel tarafı (PANEL_YENIDEN_KURULUM.md Basamak 4, sahip 2026-10-19). Panel YALNIZ başlatır ve gösterir:
// "Devri başlat" → devir QR'ı → ilk okutan içerideki kişi devreden olur, eski 5 adımı (kasa · bardak · ürün · pasta · onay) KENDİ
// telefonunda doldurur → panel özeti gösterir + devralan QR'ı → devralan okutup kabul eder (girişi açılır, devredenin çıkışı yazılır).
// Devir mantığı yoklama modülünde (tak-çıkar: panel yalnız PUBLIC uçları çağırır). Kayıtlı PC imzası (cihazImza 'tablet').
import React, { useState } from 'react';
import { imzaliJson } from '../../utils/cihazImza';
import { C, Modal, qrBoyut, TabletQR, tl, yeniIstek } from './ortak';
import { kalemYazi } from '../../utils/devirOzet';

export const DEVIR_ACIK = ['baslatildi', 'dolduruluyor', 'hazir', 'devreden_onayladi'];


export function DevirOzet({ devir }) {
  return (
    <div className="sp-kart" style={{ display: 'grid', gap: 4, fontSize: 14 }}>
      <div>💰 Kasa: <b>{devir.sayilan == null ? '—' : tl(devir.sayilan)}</b>{devir.devralan_sayilan != null && <> · devralan saydı: <b style={{ color: C.kirmizi }}>{tl(devir.devralan_sayilan)}</b></>}</div>
      <div>🥤 {kalemYazi(devir.bardak)}</div>
      <div>📦 {kalemYazi(devir.urunler)}</div>
      <div>🍰 Pasta: {devir.pasta ?? '—'}</div>
    </div>
  );
}

// Sağ kolondaki / ana sayfadaki kısa durum satırı
export function devirEtiket(devir) {
  if (!devir) return { renk: C.soluk, metin: '● Bekliyor' };
  return {
    baslatildi: { renk: C.sari, metin: '⏳ Devreden QR okutsun' },
    dolduruluyor: { renk: C.sari, metin: `⏳ ${devir.ustlenen || 'Devreden'} telefonda sayıyor` },
    hazir: { renk: C.sari, metin: '⏳ Onay bekleniyor' },
    devreden_onayladi: { renk: C.sari, metin: '⏳ Devralan QR okutsun' },
    tamam: { renk: C.yesil, metin: `✓ Tamamlandı · kasa ${devir.devralan || ''}'de` },
    tutmuyor: { renk: C.kirmizi, metin: `⚠ Tutmuyor · kasa ${devir.devralan || ''}'de` },
    merkez_kapatti: { renk: C.soluk, metin: '🏢 Merkez kapattı' },
  }[devir.durum] || { renk: C.soluk, metin: devir.durum };
}

export default function KasaDevri({ devir, tabletVar, kapali, kapat, yukle, iptal, mesgulDis }) {
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const acik = !!devir && DEVIR_ACIK.includes(devir.durum);
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
      {devir && !acik && (
        <div className="sp-kart" style={{ display: 'grid', gap: 6, borderColor: et.renk }}>
          <b style={{ color: et.renk }}>{et.metin}</b>
          <div style={{ color: C.soluk, fontSize: 13 }}>{devir.devreden} → {devir.devralan || '—'}{devir.devralan_saat ? ` · ${devir.devralan_saat}` : ''}{devir.vekil && devir.ustlenen ? ` · ${devir.ustlenen} adına doldurdu` : ''}</div>
          {devir.sayilan != null && <DevirOzet devir={devir} />}
        </div>
      )}
      {!acik && tabletVar && !kapali && (<>
        <div style={{ color: C.soluk, fontSize: 14 }}>Devri başlat → ekranda QR çıkar → kasayı devreden kendi telefonuyla okutur ve sayımı telefonda yapar.</div>
        <button className="sp-btn sp-yesil" disabled={mesgul} onClick={baslat}>{mesgul ? 'Başlatılıyor…' : '💵 Devri başlat'}</button>
      </>)}
      {acik && devir.durum === 'baslatildi' && (
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}>
          <b style={{ fontSize: 18 }}>1 · Kasayı DEVREDEN QR'ı okutsun</b>
          {tabletVar && <TabletQR boyut={qrB} devir={devir.id} />}
          <span style={{ color: C.soluk, fontSize: 13 }}>Okutan kişi devreden olur; sayımı kendi telefonunda yapar (15 dk). Başlatıldı {devir.panel}.</span>
        </div>
      )}
      {acik && devir.durum === 'dolduruluyor' && (
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}>
          <b style={{ fontSize: 18, color: C.sari }}>⏳ {devir.ustlenen || 'Devreden'} telefonunda sayıyor · {devir.ustlen_saat}'den beri</b>
          <span style={{ color: C.soluk, fontSize: 13 }}>Gönderince burada özet ve devralan QR'ı çıkar. Telefonu bozulursa başka biri bu QR'ı okutup {devir.pencere ? '15 dk dolunca' : 'şimdi'} devralabilir.</span>
          {tabletVar && <TabletQR boyut={Math.min(220, qrB)} devir={devir.id} />}
        </div>
      )}
      {acik && devir.durum === 'devreden_onayladi' && (<>
        <div style={{ color: C.yesil, fontWeight: 700 }}>✓ {devir.devreden} devretti · {devir.devreden_saat}{devir.vekil && devir.ustlenen ? ` (${devir.ustlenen} adına doldurdu)` : ''}</div>
        <DevirOzet devir={devir} />
        <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}>
          <b style={{ fontSize: 18 }}>2 · DEVRALAN QR'ı okutsun</b>
          {tabletVar && <TabletQR boyut={qrB} devir={devir.id} />}
          <span style={{ color: C.soluk, fontSize: 13 }}>Telefonda özeti görür → "Kabul ediyorum" (girişi açılır) ya da "Tutmuyor" + kendi saydığı tutar.</span>
        </div>
      </>)}
      {acik && devir.durum === 'hazir' && <div style={{ color: C.soluk }}>Eski devir formu ({devir.devreden} → {devir.devralan}) — iptal edip yeniden başlat.</div>}
      {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
      {acik && ['baslatildi', 'dolduruluyor', 'hazir'].includes(devir.durum) && (
        <button className="sp-btn" style={{ minHeight: 52 }} disabled={mesgul || mesgulDis} onClick={iptal}>✕ Devri iptal et</button>
      )}
      {acik && devir.durum === 'devreden_onayladi' && <div style={{ color: C.soluk, fontSize: 13 }}>Devreden gönderdi — iptal/değişiklik için merkeze haber ver.</div>}
    </Modal>
  );
}
