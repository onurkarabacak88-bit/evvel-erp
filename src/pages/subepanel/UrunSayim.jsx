// 📦 MERKEZ ÜRÜN SAYIMI İSTEDİ — tam ekran (sahip 10 Kas "her kırmızı yanan yere sayım iste … panelde bütün işlem kilitlense … panelin
// ortasında bu gözükse" · Fable L4b + Codex: kırmızı (birkaç ürün) PANELDE, bütün ürünler telefonda — adım 155). Ara kasa sayımı örüntüsü:
// ürünler KÖR sayılır (beklenen / fark ASLA gösterilmez) → 'Sayımı gönder' → ekranda QR → sayan kişi KENDİ telefonuyla onaylar.
// Süre YOK (sayılana kadar); merkez isteği iptal edebilir. Sunucu: evvel_yeni_panel_api urun_sayim_* · kilit _sayim_kilidi (409).
import React, { useEffect, useState } from 'react';
import { BirimCipi, C, panelHata, panelYaz, qrBoyut, TabletQR, taslakOku, taslakYaz } from './ortak';

export default function UrunSayim({ subeId, u, tabletVar, yenile }) {
  const anahtar = `sp_taslak:${subeId}:urun_sayim:${u.onay_id}`;
  const [say, setSay] = useState(() => ({ ...(taslakOku(anahtar) || {}), ...(u.sayilan || {}) }));   // 'hata'da sunucudaki sayılar geri gelir
  const [gonderildi, setGonderildi] = useState(!!u.gonderildi && u.durum !== 'hata');
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  useEffect(() => { taslakYaz(anahtar, say); }, [say, anahtar]);
  useEffect(() => {   // Codex L6: telefon onayı olmadıysa form sunucudaki sayılarla açılır (hata mesajı formda görünür)
    if (u.durum !== 'hata') return;
    if (u.sayilan) setSay((o) => ({ ...o, ...Object.fromEntries(Object.entries(u.sayilan).map(([k, v]) => [k, String(v)])) }));
  }, [u.durum, u.mesaj]);   // eslint-disable-line react-hooks/exhaustive-deps
  const formAcik = !gonderildi || u.durum === 'hata';   // Codex L6 2. tur: görünürlük DURUMDAN (hata → bekliyor → hata yarışı kaçmasın)
  const urunler = u.urunler || [];
  const dolu = urunler.filter((x) => (say[x.id] ?? '') !== '').length;
  const yaz = (id, v) => setSay((o) => ({ ...o, [id]: v === '' ? '' : String(Math.min(99999, Number(v) || 0)) }));

  const gonder = async () => {
    if (mesgul) return;
    if (dolu < urunler.length) { setHata(`${urunler.length - dolu} ürün boş — elde yoksa 0 yaz`); return; }
    setMesgul(true); setHata('');
    try {
      await panelYaz(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/urun-sayim`, 'POST',
        { sayilan: Object.fromEntries(urunler.map((x) => [x.id, Number(say[x.id])])) });
      setGonderildi(true);
      yenile?.();   // durum hemen 'bekliyor'a döner (hata ekranı beklemesin)
    } catch (e) { panelHata(e, { setHata: (m) => setHata(m || 'Gönderilemedi — tekrar dene') }); }
    setMesgul(false);
  };
  // 'Düzelt' sunucudaki sayıları SİLER — telefonda açık eski QR eski sayıları onaylayamaz (ara sayımla aynı kural)
  const duzelt = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      await panelYaz(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/urun-sayim-duzelt`, 'POST', {});
      setGonderildi(false);
      yenile?.();
    } catch (e) { panelHata(e, { setHata: (m) => setHata(m || 'Düzeltilemedi — tekrar dene') }); }
    setMesgul(false);
  };

  return (
    <div className="sp-perde" style={{ position: 'fixed', inset: 0, zIndex: 75, background: 'rgba(5,8,15,.97)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="sp-kart" style={{ width: 'min(640px,100%)', maxHeight: '94vh', overflowY: 'auto', display: 'grid', gap: 12, borderColor: C.sari }}>
        <div style={{ textAlign: 'center', display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 40 }}>📦</div>
          <b style={{ fontSize: 24 }}>Merkez ürün sayımı istiyor · {u.yer}</b>
          {u.not && <div style={{ color: C.sari, fontWeight: 700 }}>📝 {u.not}</div>}
          <div style={{ color: C.soluk }}>Panel sayım bitene kadar kilitli. Aşağıdaki ürünleri <b style={{ color: C.yazi }}>tek tek say</b> ve yaz — elde yoksa 0.</div>
        </div>
        {formAcik ? (<>
          {u.durum === 'hata' && u.mesaj && <div style={{ color: C.kirmizi, fontWeight: 700, textAlign: 'center' }}>Telefon onayı olmadı: {u.mesaj} — kontrol et, yeniden gönder</div>}
          <div style={{ color: C.soluk, fontSize: 13, textAlign: 'center' }}>{dolu} / {urunler.length} ürün yazıldı</div>
          {urunler.map((x) => (
            <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderRadius: 10, background: (say[x.id] ?? '') !== '' ? 'rgba(34,197,94,.1)' : C.bg2 }}>
              <span style={{ flex: 1, minWidth: 140, fontWeight: 700, fontSize: 16 }}>{x.ad} <BirimCipi u={x} /></span>
              <input className="sp-in" style={{ width: 110, textAlign: 'center', fontSize: 30, fontWeight: 800, padding: '4px 6px' }} inputMode="numeric"
                autoComplete="off" placeholder="?" value={say[x.id] ?? ''} onChange={(e) => yaz(x.id, e.target.value.replace(/\D/g, ''))} />
            </div>
          ))}
          {hata && <div style={{ color: C.kirmizi, fontWeight: 700, textAlign: 'center' }}>{hata}</div>}
          <button className="sp-btn sp-yesil" disabled={mesgul || dolu < urunler.length} onClick={gonder}>{mesgul ? 'Gönderiliyor…' : 'Sayımı gönder → QR'}</button>
        </>) : (<div style={{ display: 'grid', gap: 12, textAlign: 'center' }}>
          <div style={{ fontWeight: 700 }}>Sayan kişi KENDİ telefonuyla bu QR'ı okutup onaylasın</div>
          <div style={{ justifySelf: 'center' }}>{tabletVar ? <TabletQR boyut={qrBoyut(320, 200, 80)} onay={u.onay_id} />
            : <div style={{ color: C.sari, fontWeight: 700 }}>Bu bilgisayar tablet olarak bağlı değil — QR gösterilemiyor, merkeze haber ver</div>}</div>
          <div style={{ color: C.soluk, fontSize: 13 }}>Onaylanınca ekran kendiliğinden açılır.</div>
          {u.durum === 'hata' && u.mesaj && <div style={{ color: C.kirmizi, fontWeight: 700 }}>Telefon onayı olmadı: {u.mesaj} — QR'ı yeniden okut</div>}
          {u.durum === 'isleniyor' && <div style={{ color: C.sari, fontWeight: 700 }}>Telefondan onaylanıyor…</div>}
          {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-orta" disabled={mesgul || u.durum === 'isleniyor'} onClick={duzelt}>« Düzelt (yeniden say)</button>
        </div>)}
        <div style={{ color: C.soluk, fontSize: 12.5, textAlign: 'center' }}>Telefonu olmayan: telefonu bağlı bir arkadaş onaylasın ya da merkeze haber ver — merkez isteği iptal edebilir.</div>
      </div>
    </div>
  );
}
