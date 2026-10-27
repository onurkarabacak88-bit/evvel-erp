// 🧾 ŞUBE PANELİ — ORTAK PARÇALAR (PANEL_YENIDEN_KURULUM.md · Basamak 1)
// Eski panelin (sube_panel.html) tema token'ları AYNEN: --bg #0b0f1a, --bg1 #111827, --bg2 #1a2236, --bg3 #222d42, accent #3b82f6, cyan #06b6d4,
// ok #22c55e, warn #f59e0b, danger #ef4444, depo mor #8b5cf6, tedarikçi turuncu #f97316, radius 12/8, Inter 14px.
// Bu dosya yalnız React'e bağımlıdır (döngü yok): ekranlar ortak'ı alır, SubePaneli ekranları alır.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { cihazId, imzaliFetch, imzaliJson } from '../../utils/cihazImza';
import { sayiTR } from '../../utils/trSayi';

export const C = { bg: '#0b0f1a', bg1: '#111827', bg2: '#1a2236', bg3: '#222d42', cizgi: 'rgba(99,120,160,0.18)', yazi: '#f0f4ff', soluk: '#7a8ba8',
  mavi: '#3b82f6', cyan: '#06b6d4', yesil: '#22c55e', sari: '#f59e0b', kirmizi: '#ef4444', mor: '#8b5cf6', turuncu: '#f97316' };

export const CSS = `
.sp *{box-sizing:border-box} .sp{font-family:Inter,system-ui,sans-serif;background:${C.bg};color:${C.yazi};min-height:100vh;font-size:14px;padding-bottom:64px}
.sp-btn{min-height:72px;border-radius:12px;border:1px solid ${C.cizgi};background:${C.bg2};color:${C.yazi};font-size:17px;font-weight:700;cursor:pointer;padding:10px 16px}
.sp-btn:disabled{opacity:.45;cursor:default}
.sp-btn.sp-orta{min-height:64px;padding:8px 14px;font-size:16px}
.sp-btn.sp-ikincil{min-height:48px;position:relative;background:transparent;color:${C.soluk};font-size:14px;padding:4px 14px}
.sp-btn.sp-ikincil::before{content:'';position:absolute;inset:-9px -2px} .sp-ana{background:${C.mavi};border-color:${C.mavi}} .sp-yesil{background:${C.yesil};border-color:${C.yesil};color:#05210f}
.sp-mor{background:linear-gradient(135deg,#4c1d95,#7c3aed);border-color:rgba(168,85,247,.4)}
.sp-in{width:100%;min-height:56px;border-radius:10px;border:1px solid ${C.cizgi};background:${C.bg1};color:${C.yazi};font-size:22px;padding:8px 12px}
.sp-ust{height:52px;display:flex;align-items:center;gap:12px;padding:0 14px;background:${C.bg1};border-bottom:1px solid ${C.cizgi}}
.sp-logo{color:${C.cyan};font-weight:900;letter-spacing:2px;font-size:16px}
.sp-govde{display:grid;grid-template-columns:220px 1fr 280px;gap:12px;padding:12px}
.sp-sol-kolon{background:${C.bg1};border:1px solid ${C.cizgi};border-radius:12px;padding:6px;align-self:start;display:grid;gap:2px}
.sp-sol-baslik{color:${C.soluk};font-size:11px;font-weight:800;letter-spacing:1.2px;padding:12px 12px 4px;text-transform:uppercase}
.sp-sol{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:8px 12px;border-radius:8px;border:none;background:transparent;color:${C.soluk};font-size:14px;font-weight:600;cursor:pointer;text-align:left}
.sp-sol.akt{background:rgba(59,130,246,.15);color:${C.mavi}} .sp-sol:disabled{opacity:.4;cursor:default}
.sp-rozet{margin-left:auto;min-width:22px;padding:2px 7px;border-radius:999px;font-size:12px;font-weight:800;color:#fff;text-align:center}
.sp-kart{background:${C.bg1};border:1px solid ${C.cizgi};border-radius:12px;padding:14px}
.sp-pm{width:72px;height:72px;border-radius:12px;border:1px solid ${C.cizgi};background:${C.bg3};color:${C.yazi};font-size:30px;font-weight:800;cursor:pointer}
.sp-hizli{min-height:108px;border-radius:12px;border:1px solid ${C.cizgi};color:#fff;cursor:pointer;display:grid;align-content:center;justify-items:center;gap:4px;padding:10px;font:inherit}
.sp-hizli b{font-size:16px} .sp-hizli span{font-size:12px;opacity:.85} .sp-hizli i{font-style:normal;font-size:34px;line-height:1}
.sp-hizli:disabled{opacity:.45;cursor:default}
.sp-alt{position:fixed;left:0;right:0;bottom:0;height:58px;display:grid;grid-template-columns:repeat(4,1fr);background:${C.bg1};border-top:1px solid ${C.cizgi};z-index:30}
.sp-alt button{border:none;background:transparent;color:${C.soluk};font:inherit;font-weight:700;cursor:pointer;position:relative}
.sp-alt button:disabled{opacity:.4;cursor:default}
.sp-cip{min-height:64px;display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;border:1px solid ${C.cizgi};background:${C.bg2};color:${C.soluk};font-weight:700;cursor:pointer;font:inherit}
@media (max-width:980px){.sp-govde{grid-template-columns:1fr 280px} .sp-sol-kolon{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px} .sp-sol-kolon .sp-sol{width:auto;flex:0 0 auto} .sp-sol-kolon .sp-sol-baslik{width:100%}}
@media (max-width:768px){.sp-govde{grid-template-columns:1fr} .sp-sag-kolon{display:none} .sp-alt{height:62px}}
.sp-alt-qr{display:none}
@media (max-width:1023px){.sp-qr-yuzen{display:none} .sp-alt{grid-template-columns:repeat(5,1fr)} .sp-alt .sp-alt-qr{display:block;color:${C.turuncu}}}
`;   // Ü-2 (26 Eki · L4b Opus + Fable + Codex: B): dar ekranda yüzen QR "Onayla"yı / sağ kartları örtüyordu → < 1024'te alt çubukta "📱 QR"

// 💾 TASLAK (tablette) — TEK kaynak (Dalga 5, F#53: 7 ekran ayrı try/JSON yazıyordu; Ürün aç / Tedarikçi / Sipariş / Depodan gelen
// taslakları hiç temizlenmiyordu, Depodan gelen anahtarı günsüzdü). Anahtar: sp_taslak:{şube}:{iş günü | depo_kabul}:{form}.
// 🔒 Kimliksiz yazan panel uçları (devir iptal · ürün aç taslağı · onay iste · ara sayım): bu PC bağlıysa CİHAZ İMZASIYLA gider
// (sunucu gerçek kayıttaki şubede imza ister — Codex P1, 28 Eki); bağlanmamış PC (deneme) eski yoldan.
export const panelYaz = (yol, method = 'POST', body) => (cihazId('tablet')
  ? imzaliJson('tablet', method, `/api${yol}`, body)
  : api(yol, { method, ...(body === undefined ? {} : { body }) }));
export const taslakOku = (k) => { try { return k ? JSON.parse(localStorage.getItem(k) || 'null') : null; } catch { return null; } };
export const taslakYaz = (k, v) => { try { if (k) localStorage.setItem(k, JSON.stringify(v)); } catch { /* yer yok / gizli pencere */ } };
export const taslakKaldir = (k) => { try { if (k) localStorage.removeItem(k); } catch { /* yok say */ } };
// Panel açılınca: DÜNDEN eski günlü taslaklar + artık yolda olmayan paketlerin 'depo_kabul' taslakları silinir (dünkü kapanış kurtarılabilsin diye dün kalır)
// yoldakiPartiler null → Depo kapalı / okunamadı: paket taslaklarına DOKUNULMAZ (Fable D5-B1: yarım sayım siliniyordu)
export const taslakTemizle = (subeId, gun, yoldakiPartiler = []) => {
  try {
    const dun = new Date(`${gun}T12:00:00Z`); dun.setUTCDate(dun.getUTCDate() - 1);
    const sinir = dun.toISOString().slice(0, 10);
    const yolda = new Set((yoldakiPartiler || []).map(String));
    const on = `sp_taslak:${subeId}:`;
    Object.keys(localStorage).filter((k) => k.startsWith(on)).forEach((k) => {
      const parca = k.slice(on.length).split(':');
      if (/^\d{4}-\d{2}-\d{2}$/.test(parca[0]) ? parca[0] < sinir : (parca[0] === 'depo_kabul' && yoldakiPartiler !== null && !yolda.has(parca[1]))) localStorage.removeItem(k);
    });
  } catch { /* yok say */ }
};

export { yeniIstekId as yeniIstek } from '../../utils/cihazImza';   // istek kimliği TEK üretici (Dalga 5, F#59)
export { tlYaz as tl } from '../../utils/trSayi';   // ₺ biçimi TEK kaynak (F#58)
export const sayi = (s) => String(s ?? '').replace(/[^\d]/g, '');
// para yazım maskesi: yalnız rakam , . kalır — noktayı virgüle ÇEVİRMEZ (Codex P1: '1.250' → '1,250' → 1,25 ₺ oluyordu; ayrım TEK kural sayiTR)
export const tutar = (s) => String(s ?? '').replace(/[^\d,.]/g, '');
export const tutarNum = (s) => { const n = sayiTR(s, 0); return Number.isNaN(n) ? 0 : n; };   // tek kaynak utils/trSayi ("12.50" artık 12,5)
export const sayimGovde = (sayim) => Object.entries(sayim).filter(([, v]) => v !== '' && v != null).map(([urun_id, v]) => ({ urun_id, sayilan: Number(v) }));
export const kalemGovde = (adet) => Object.entries(adet).filter(([, n]) => n > 0).map(([urun_id, n]) => ({ urun_id, adet: n }));

export function Modal({ baslik, kapat, children, genis, genislik }) {
  const kokRef = useRef(null);
  useEffect(() => {   // G52 (sim 23 Eki, laptop): pencere açılınca imleç ilk yazı kutusuna — fareyle tıklamadan yazılsın (yalnız ⌨️ Klavye)
    if (cihazTuruOku() !== 'klavye') return undefined;
    const t = window.setTimeout(() => {
      const k = kokRef.current?.querySelector('textarea:not([disabled]), input:not([type=hidden]):not([type=checkbox]):not([disabled])');
      if (k && !kokRef.current.contains(document.activeElement)) k.focus();
    }, 60);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div ref={kokRef} onClick={kapat || undefined} className="sp-perde" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="sp-kart" style={{ width: genislik ? `min(${genislik}px,100%)` : genis ? 'min(980px,100%)' : 'min(560px,100%)', maxHeight: '92vh', overflow: 'auto', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 20, flex: 1 }}>{baslik}</b>
          {kapat && <button className="sp-btn sp-ikincil" onClick={kapat}>✕</button>}</div>
        {children}
      </div>
    </div>
  );
}

// 🗨️ SOR — panel sayfa içi soru penceresi (K-1 · 26 Eki · L4b Opus A + Fable A / Codex B → A): window.confirm dokunmatikte ve simde
// görünmüyordu. Merkez KasaModulu sor() ile AYNI sözleşme: sor({ soru, vurgu, alt, tamam, iptal }) → true|false;
// secenekler: [{ deger, yazi, ana }] verilirse seçilen deger | null (Vazgeç hiçbir şey açmaz).
// <SorKatmani /> panel kabuğunda (SubePaneli) bir kez; takılı değilse tarayıcı penceresine düşer (merkezle aynı yedek).
// Perdeye dokunmak kapatmaz (telaşta yanlış dokunuş) · Esc = Vazgeç · Enter onaylamaz · her soru bir kez çözülür.
let sorDinle = null;
export function sor(o) {
  return new Promise((coz) => {
    if (!sorDinle) { coz(o.secenekler ? null : window.confirm(o.soru)); return; }   // eslint-disable-line no-alert
    sorDinle({ ...o, coz });
  });
}
export function SorKatmani() {
  const [s, setS] = useState(null);
  const kutu = useRef(null);
  useEffect(() => {
    sorDinle = (o) => setS((onceki) => { if (onceki) onceki.coz(onceki.secenekler ? null : false); return { ...o, cozuldu: false }; });
    return () => { sorDinle = null; };
  }, []);
  const bitir = (v) => { if (!s || s.cozuldu) return; s.cozuldu = true; setS(null); s.coz(v); };
  useEffect(() => {
    if (!s) return undefined;
    kutu.current?.focus();
    const tus = (e) => {   // sayfanın tamamında (perdeye dokunulunca odak pencereden çıksa da) — yakalama evresinde, sihirbaz Enter'ı görmez
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bitir(s.secenekler ? null : false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }   // Enter HİÇ onaylamaz (Codex denetimi): çift Enter soruyu okumadan geçmesin — seçim dokunarak / fareyle
    };
    window.addEventListener('keydown', tus, true);
    return () => window.removeEventListener('keydown', tus, true);
  });
  if (!s) return null;
  const vazgec = s.secenekler ? null : false;
  return (
    <div role="dialog" aria-modal="true" aria-label={s.soru} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div ref={kutu} tabIndex={-1} className="sp-kart" style={{ width: 'min(560px,100%)', display: 'grid', gap: 14, outline: 'none' }}>
        <b style={{ fontSize: 20, lineHeight: 1.35, whiteSpace: 'pre-line' }}>{s.soru}</b>
        {s.vurgu && <div style={{ fontSize: 32, fontWeight: 800, color: C.kirmizi }}>{s.vurgu}</div>}
        {s.alt && <div style={{ color: C.soluk, fontSize: 15, whiteSpace: 'pre-line' }}>{s.alt}</div>}
        {(s.secenekler || []).map((x) => (
          <button key={x.deger} type="button" className={'sp-btn' + (x.ana ? ' sp-ana' : '')} style={{ textAlign: 'left' }} onClick={() => bitir(x.deger)}>{x.yazi}</button>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: s.secenekler ? '1fr' : '1fr 1fr', gap: 10 }}>
          <button type="button" className="sp-btn" onClick={() => bitir(vazgec)}>{s.iptal || 'Vazgeç'}</button>
          {!s.secenekler && <button type="button" className="sp-btn sp-ana" onClick={() => bitir(true)}>{s.tamam || 'Evet'}</button>}
        </div>
      </div>
    </div>
  );
}

// ⚠️ Panel gönderim hatası — TEK kural (tekrar denetimi F#54: 409 "zaten" bazı ekranlarda BAŞARI sayılıp form siliniyordu).
// Sunucu AYNI içerikli tekrarı 200 + tekrar ile döner; 409 "zaten" yalnız aynı istek FARKLI içerikle gelince → başarı DEĞİL:
// form durur, yeni istek kimliği alınır, personel ne yapacağını görür (sessiz kalem kaybı yok).
export const panelHata = (e, { setHata, pinSifirla, yeniIstekVer }) => {
  if (e instanceof TypeError) { setHata('İnternet yok — bağlantı gelince yeniden gönder (girdiklerin duruyor)'); return 'internet'; }
  if (e?.status === 403 || e?.status === 429) { pinSifirla?.(); setHata(e?.message || 'PIN hatalı'); return 'pin'; }
  if (e?.status === 409 && /zaten/i.test(e?.message || '')) {
    yeniIstekVer?.();
    setHata('⚠ Bu gönderim daha önce FARKLI içerikle kaydedilmiş. Ana sayfadaki "Bugün kaydedilenler"e bak; eksik kalan varsa formu düzeltip yeniden gönder (yeni kayıt olarak gider).');
    return 'farkli';
  }
  setHata(e?.message || 'Kaydedilemedi');
  return 'hata';
};

// ➖ ADET GİRDİSİ "− [adet] +" — Ürün aç · Tedarikçi teslim · Sipariş ver · Depodan gelen ORTAK (Dalga 5, F#51: 4 kopya). Koli
// yardımcıları ekranına göre farklı kalır (teslim: "koli × N + tek" izli; sipariş: "+1/+2/+3 koli" hızlı) — amaçları ayrı.
// G60 (sim 23 Eki, laptop): ürünler arası 3 Tab gerekiyordu (kutu → + → − → kutu) → klavye modunda −/+ Tab sırasında YOK (fareyle basılır),
// Enter = sonraki ürünün adet kutusu (aynı pencere / sayfa içinde).
const sonrakiAdet = (el) => {
  const kok = el.closest('.sp-perde') || document;
  const k = [...kok.querySelectorAll('input.sp-adet:not([disabled])')].filter((i) => i.offsetParent);
  const h = k[k.indexOf(el) + 1];
  if (h) { h.focus(); h.select?.(); }
};
export function AdetGirdi({ n, azalt, artir, yaz, genislik = 96, font = 30, kapali = false }) {
  const klavye = cihazTuruOku() === 'klavye';
  return (<>
    <button type="button" className="sp-pm" onClick={azalt} disabled={kapali} tabIndex={klavye ? -1 : undefined}>−</button>
    <input className="sp-in sp-adet" style={{ width: genislik, textAlign: 'center', fontSize: font, fontWeight: 800, padding: '4px 6px' }} inputMode="numeric" value={n || ''} placeholder="0"
      disabled={kapali} onChange={(e) => yaz(Number(e.target.value.replace(/\D/g, '') || 0))}
      onKeyDown={klavye ? (e) => { if (e.key === 'Enter') { e.preventDefault(); sonrakiAdet(e.currentTarget); } } : undefined} />
    <button type="button" className="sp-pm" onClick={artir} disabled={kapali} tabIndex={klavye ? -1 : undefined}>+</button>
  </>);
}
// ➕➖ adet değiştirme — TEK kural (Fable D6-R: Ürün aç / Fire / Tedarikçi / Sipariş 4 kopya, sınırlar 9999 ↔ 99999 farklıydı).
// Sınır sunucuyla aynı (çekirdek MAKS_ADET 99999). art: hızlı dokunuşta kaybolmasın diye önceki değer üzerinden.
export const MAKS_ADET = 99999;
export const adetAyarla = (setAdet) => ({
  art: (id, dlt) => setAdet((o) => ({ ...o, [id]: Math.max(0, Math.min(MAKS_ADET, (o[id] || 0) + dlt)) })),
  degis: (id, n) => setAdet((o) => ({ ...o, [id]: Math.max(0, Math.min(MAKS_ADET, Number(n) || 0)) })),
});

// 🗂 KATEGORİ KARTLARI — Ürün aç · Tedarikçi teslim · Sipariş ver ORTAK (Dalga 5, F#49/50/52: renk dizisi, kart, ürün haritası 3 kopyaydı).
// Kartta seçili ürün sayısı rozeti; 'alt' verilirse kartın altına küçük yazı (ör. "12 aktif · Dokun → liste").
export const TONLAR = ['linear-gradient(135deg,#1e3a8a,#3b82f6)', 'linear-gradient(135deg,#065f46,#10b981)', 'linear-gradient(135deg,#78350f,#f59e0b)', 'linear-gradient(135deg,#4c1d95,#8b5cf6)'];
export const urunHaritasi = (katalog) => Object.fromEntries((katalog || []).flatMap((k) => k.urunler.map((u) => [u.id, { ...u, kategori: k.kategori }])));
export function KategoriKartlari({ katalog, adet, kapali, onSec, alt, enAz = 160, yukseklik = 90, ton }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill,minmax(${enAz}px,1fr))`, gap: 10 }}>
      {katalog.map((k, i) => {
        const n = k.urunler.filter((u) => (adet[u.id] || 0) > 0).length;
        return (
          <button key={k.id} type="button" onClick={() => onSec(k.id)} disabled={kapali}
            style={{ position: 'relative', minHeight: yukseklik, borderRadius: 14, opacity: kapali ? 0.45 : 1, border: n ? `2px solid ${C.yesil}` : '1px solid transparent', background: ton ? ton(k, i) : TONLAR[i % 4],
              color: '#fff', textAlign: 'left', padding: 12, cursor: 'pointer', display: 'grid', gap: 4, font: 'inherit' }}>
            {n > 0 && <span style={{ position: 'absolute', top: 8, right: 8, background: C.yesil, color: '#05210f', borderRadius: 999, minWidth: 24, padding: '2px 7px', fontWeight: 900, fontSize: 13, textAlign: 'center' }}>{n}</span>}
            <span style={{ fontSize: 22 }}>{k.emoji || '📦'}</span>
            <b style={{ fontSize: 15 }}>{k.kategori}</b>
            {alt && <span style={{ fontSize: 12, opacity: 0.85 }}>{alt(k)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// 📱 QR ONAY AKIŞI (R1: işlem SONUNDA personelin telefonu) — açılış + kapanış sihirbazı ORTAK (Dalga 5, F#55: ~70 satır iki kopyaydı).
// onayIste: form → sunucuda onay kaydı (para/stok YAZILMAZ) · 2 sn'de bir durum sorulur · telefon onaylayınca onaylandi(r) ·
// onayIptal: « Geri — iptal KESİNLEŞMEDEN düzenlemeye dönülmez (Codex); belirsizlikte gerçek durum sorulur. true = geri dönülebilir.
export function useQrOnay({ subeId, tur, govde, mesgul, setMesgul, setHata, onaylandi }) {
  const [onay, setOnay] = useState(null);   // { id, durum, mesaj } — taslağa YAZILMAZ (yenilemede yeni QR)
  const [agHata, setAgHata] = useState(0);   // art arda bağlantı hatası
  const onayRef = useRef(onay); onayRef.current = onay;
  const sonRef = useRef(onaylandi); sonRef.current = onaylandi;
  const onayIste = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await panelYaz(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/onay-iste`, 'POST', { tur, govde: { ...govde(), personel_id: '-' } });
      setOnay({ id: r.onay_id, durum: 'bekliyor', mesaj: '' });
    } catch (e) {
      setHata(e instanceof TypeError ? 'İnternet yok — bağlantı gelince yeniden dene' : (e?.message || 'Onay istenemedi'));
    }
    setMesgul(false);
  };
  const onayIptal = async () => {
    const o = onay;
    if (!o || !['bekliyor', 'hata', 'isleniyor'].includes(o.durum)) { setOnay(null); return true; }
    try {
      await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}/iptal`, { method: 'POST', body: {} });
      setOnay(null); return true;
    } catch (e) {
      if (e instanceof TypeError) { setHata('İnternet yok — onay iptal edilemedi, bağlantı gelince tekrar dene'); return false; }
      try {   // o an telefonda onaylanmış / işleniyor olabilir → gerçek durumu sor
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}`);
        if (r.durum === 'onaylandi') { sonRef.current(r); return false; }
        if (r.durum === 'iptal' || r.durum === 'sure_doldu') { setOnay(null); return true; }   // yalnız doğrulanmış geçersizlikte
        setOnay({ id: o.id, durum: r.durum, mesaj: r.mesaj || '' });
      } catch { /* belirsiz */ }
      setHata('Onay iptal edilemedi — QR hâlâ geçerli olabilir; birazdan yeniden dene');   // Codex: belirsizlikte geri dönülmez
      return false;
    }
  };
  useEffect(() => {   // telefon onaylayınca panel kendiliğinden geçer
    if (!onay?.id || !['bekliyor', 'isleniyor', 'hata'].includes(onay.durum)) return undefined;
    let canli = true;
    const sor = async () => {
      try {
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(onay.id)}`);
        if (!canli || onayRef.current?.id !== onay.id) return;
        setAgHata(0);
        if (r.durum === 'onaylandi') sonRef.current(r);
        else if (r.durum !== onay.durum) setOnay({ id: onay.id, durum: r.durum, mesaj: r.mesaj || '' });
      } catch { if (canli) setAgHata((n) => n + 1); }   // ağ geçici — sonraki turda
    };
    const t = window.setInterval(sor, 2000);
    return () => { canli = false; window.clearInterval(t); };
  }, [onay?.id, onay?.durum]);   // eslint-disable-line react-hooks/exhaustive-deps
  return { onay, setOnay, agHata, onayRef, onayIste, onayIptal };
}

// QR boyutu: ekran genişliğinden (pay kadar boşluk bırak), [enAz, enCok] arasında — TEK hesap (Dalga 5, K11: 8 kopya)
export const qrBoyut = (enCok, enAz, pay) => Math.min(enCok, Math.max(enAz, (window.innerWidth || 600) - pay));

// 🎴 EKRAN BAŞLIĞI (hero) — TEK parça (Dalga 5, F#64: Ürün aç · Depodan gelen · Sipariş ver · Tedarikçi teslim aynı yapıyı ayrı yazıyordu)
export function Hero({ ikon, baslik, alt, zemin, cerceve, renk }) {
  return (
    <div className="sp-kart" style={{ display: 'flex', gap: 12, alignItems: 'center', background: zemin, borderColor: cerceve }}>
      <span style={{ fontSize: 28 }}>{ikon}</span>
      <div><b style={{ fontSize: 18, color: renk }}>{baslik}</b>
        <div style={{ color: C.soluk, fontSize: 13 }}>{alt}</div></div>
    </div>
  );
}

// 🔌 MODÜL KAPALI kartı (sök-tak) — TEK parça (Dalga 5, F#63: Depodan gelen, Sipariş, Tedarikçi ayrı yazıyordu)
export const ModulKapali = ({ children }) => <div className="sp-kart" style={{ color: C.sari, fontWeight: 700 }}>{children}</div>;

// 🔑 KİM + PIN (sahip R1b: QR'la içeride olan + kendi 4 haneli PIN'i) — TEK parça (Dalga 5, F#48: Ürün aç · Tedarikçi teslim ·
// Depodan gelen · panel ana pencereleri 'kimSec' ayrı kopyaydı). PIN yalnız bellekte. pinIste=false → yalnız kişi seçimi.
// devam verilmezse düğme çizilmez (gönder düğmesi formun kendisinde).
export function KisiPin({ adaylar, kisi, setKisi, pin, setPin, hata, devam, devamYazi = 'Devam → özet', soru = 'Kim?', pinIste = true, mesgul = false }) {
  const gecerli = !kisi || adaylar.some((x) => x.id === kisi);
  const pinRef = useRef(null);
  useEffect(() => {   // G52: laptopta kişi seçilince imleç PIN'e — denetim 15-3: başka yazı kutusundaysa ÇALMAZ (ör. "Neden?")
    if (!kisi || !pinIste || cihazTuruOku() !== 'klavye') return undefined;
    const t = window.setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== pinRef.current && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox'))) return;
      pinRef.current?.focus();
    }, 120);
    return () => window.clearTimeout(t);
  }, [kisi, pinIste]);
  useEffect(() => {   // G53 (sim 23 Eki): içeride tek kişi varken "Önce adını seç" gereksiz adımdı — PIN yine zorunlu
    if (pinIste && !kisi && adaylar.length === 1) setKisi(adaylar[0].id);
  }, [pinIste, kisi, adaylar, setKisi]);
  return (<>
    <b>{soru}</b>
    {adaylar.length === 0 ? <div style={{ color: C.sari, fontWeight: 700 }}>İçeride kimse yok — önce telefonundan QR ile giriş yap.</div> : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
        {adaylar.map((x) => <button key={x.id} type="button" className={'sp-btn' + (kisi === x.id ? ' sp-ana' : '')} onClick={() => { setKisi(x.id); setPin(''); }}>{x.ad}</button>)}
      </div>
    )}
    {!gecerli && <div style={{ color: C.sari, fontWeight: 700 }}>Seçili kişi çıkış yapmış — adını yeniden seç</div>}
    {pinIste && kisi && (
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}><b>🔑 PIN</b>
        <input ref={pinRef} className="sp-in" style={{ width: 140, textAlign: 'center', letterSpacing: 8 }} type="password" inputMode="numeric" data-pin="1" autoComplete="off"
          maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••"
          onKeyDown={(e) => { /* denetim 23 Eki: Enter doğrudan kaydeder → düğmeyle AYNI koşul */ if (devam && e.key === 'Enter' && kisi && gecerli && !mesgul && pin.length === 4) { e.preventDefault(); devam(); } }} /></label>
    )}
    {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
    {/* G23 (sahip ekran denemesi 23 Eki): soluk düğme neden basılmıyor söylenmiyordu */}
    {devam && adaylar.length > 0 && (!kisi || !gecerli || (pinIste && pin.length !== 4)) && (
      <div style={{ color: C.sari, fontWeight: 700, textAlign: 'center' }}>{!kisi || !gecerli ? '👆 Önce adını seç' : '🔑 4 haneli PIN\'ini gir'}</div>)}
    {devam && <button className="sp-btn sp-ana" disabled={!kisi || !gecerli || (pinIste && pin.length !== 4) || mesgul} onClick={devam}>{mesgul ? 'Gönderiliyor…' : devamYazi}</button>}
  </>);
}

// Sayım listesi (boş bırakılan SAYILMAZ)
export function SayimListesi({ gruplar, sayim, setSayim }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {gruplar.filter((g) => g.urunler.length).map((g) => (
        <div key={g.kategori}>
          <div style={{ color: C.soluk, fontWeight: 700, margin: '4px 0 6px' }}>{g.kategori}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 8 }}>
            {g.urunler.map((u) => (
              <label key={u.id} className="sp-kart" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}>
                <span style={{ flex: 1 }}><b>{u.ad}</b><div style={{ color: C.soluk, fontSize: 13 }}>kaç {u.birim}?</div></span>
                <input className="sp-in" style={{ width: 110, textAlign: 'center' }} inputMode="numeric" value={sayim[u.id] ?? ''}
                  onChange={(e) => setSayim((s) => ({ ...s, [u.id]: sayi(e.target.value) }))} />
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// 📱 Dönen QR (YOKLAMA_QR_TASARIM.md §B5) — eski panelin sabit QR'ının YERİNE (sahip: "kaldır yerine yenisini ekle").
// Yalnız bu tarayıcıda KAYITLI panel PC'sinin imzalı isteğine PNG döner; jeton 60 sn dilimli → 30 sn'de bir yenilenir.
// onay: açılış/kapanış "QR ile onayla" adımında onay kimliği QR'a eklenir (telefon o işlemi onaylar).
export function TabletQR({ boyut, onClick, onay, devir, teslim }) {
  const [src, setSrc] = useState('');
  const [hata, setHata] = useState('');
  useEffect(() => {
    let canli = true;
    let onceki = '';
    setSrc(''); setHata('');   // Codex: başka onayın QR'ı bir an bile görünmesin
    const yol = '/api/evvel-yeni/yoklama/qr.png' + (onay ? `?o=${encodeURIComponent(onay)}` : devir ? `?dv=${encodeURIComponent(devir)}`
      : teslim ? `?tb=${encodeURIComponent(teslim)}` : '');   // teslim: E1 "Faturayı çek"
    const acikSube = (window.location.pathname.match(/^\/panel\/([^/?#]+)/) || [])[1];   // B5: panelin açık olduğu şube — sunucu eşleşmezse söyler
    const yolS = acikSube ? `${yol}${yol.includes('?') ? '&' : '?'}s=${encodeURIComponent(acikSube)}` : yol;
    const cek = () => imzaliFetch('tablet', 'GET', yolS)
      .then(async (r) => {
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(typeof d.detail === 'string' ? d.detail : 'QR alınamadı'); }
        return r.blob();
      })
      .then((b) => { if (!canli) return; const u = URL.createObjectURL(b); if (onceki) URL.revokeObjectURL(onceki); onceki = u; setSrc(u); setHata(''); })
      .catch((e) => { if (canli) setHata(e instanceof TypeError ? 'İnternet yok' : (e?.message || 'QR alınamadı')); });
    cek();
    const t = window.setInterval(() => { if (!document.hidden) cek(); }, 30000);
    const gor = () => { if (!document.hidden) cek(); };
    document.addEventListener('visibilitychange', gor);
    return () => { canli = false; window.clearInterval(t); document.removeEventListener('visibilitychange', gor); if (onceki) URL.revokeObjectURL(onceki); };
  }, [onay, devir, teslim]);
  return (
    <div onClick={onClick} style={{ width: boyut, height: boyut, background: '#fff', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: onClick ? 'pointer' : 'default', overflow: 'hidden' }}>
      {src && hata ? <span style={{ color: '#b91c1c', fontSize: boyut > 200 ? 16 : 11, textAlign: 'center', padding: 6, fontWeight: 700 }}>{hata} — QR yenilenemedi</span>
        : src ? <img src={src} alt="QR" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        : <span style={{ color: '#333', fontSize: boyut > 200 ? 16 : 11, textAlign: 'center', padding: 6 }}>{hata || 'QR…'}</span>}
    </div>
  );
}

// 🔢 GLOBAL SAYI TUŞ TAKIMI (eski panel #sayiPaneli, sube_panel.html:14707–15018): inputmode=numeric/decimal olan her alanda sağdan kayar.
// 7 8 9 ⌫ / 4 5 6 ✓ / 1 2 3 / 0 00 , · en çok 8 tam + 2 ondalık · ilk tuş eski değeri siler · Enter onay, Esc kapat (değer kalır), Tab sonraki alan ·
// dışarı tıklamak onaylayarak kapatır. React kontrollü input'a NATIVE setter + 'input' olayıyla yazar (state güncellenir — Fable).
const yazInput = (el, deger) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, deger); else el.value = deger;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
// 👆/⌨️ CİHAZ TÜRÜ (sahip 23 Eki: "Starbucks dokunmatiği veya laptop kullanıyoruz şubelerde, bunun da seçilebilmesi çok önemli") —
// o tarayıcıda hatırlanır; seçilmemişse otomatik: dokunmatik ekran (kaba işaretçi / dokunma noktası) varsa 'dokunmatik'.
// Klavye modunda ekran numaratörü HİÇ açılmaz (rakam klavyeden, Enter/Tab ile ilerlenir).
const CIHAZ_ANAHTAR = 'sp_cihaz_turu';
export const cihazOtomatik = () => {
  try { return (window.matchMedia?.('(pointer: coarse)').matches || (window.navigator.maxTouchPoints || 0) > 0) ? 'dokunmatik' : 'klavye'; } catch { return 'dokunmatik'; }
};
export const cihazTuruOku = () => {
  try { const v = window.localStorage.getItem(CIHAZ_ANAHTAR); if (v === 'dokunmatik' || v === 'klavye') return v; } catch { /* yok */ }
  return cihazOtomatik();
};
export const cihazTuruYaz = (v) => { try { window.localStorage.setItem(CIHAZ_ANAHTAR, v); } catch { /* yok */ } };
// ⌨️ SİHİRBAZ KLAVYE AKIŞI (G43–G46, sim 23 Eki — laptop): adım açılınca imleç ilk BOŞ kutuya · Enter = sonraki kutu, son kutuda İleri
// (yeşil/ana düğme) · ileri geçince imleç düğmede kalmaz (çift Enter boş adımı denemez). Yalnız ⌨️ Klavye modunda; dokunmatikte numaratör var.
const sihirbazKutulari = (kok) => [...(kok?.querySelectorAll('.aw-kart input:not([type=hidden]):not([disabled]):not([data-pin])') || [])].filter((i) => i.offsetParent);   // denetim 15-2: PIN kendi düğmesine
export function useSihirbazKlavye(kokRef, adim) {
  useEffect(() => {
    if (cihazTuruOku() !== 'klavye') return undefined;
    const t = window.setTimeout(() => {
      const k = sihirbazKutulari(kokRef.current);
      const hedef = k.find((i) => i.type !== 'checkbox' && !i.value) || k[0];
      if (hedef && hedef.type === 'checkbox') {   // denetim 15-1: yalnız onay kutusu (X raporu) → özet okunmadan çift Enter işaretlemesin
        if (kokRef.current?.contains(document.activeElement)) document.activeElement.blur();
        t2 = window.setTimeout(() => hedef.focus(), 540);
      } else if (hedef) { hedef.focus(); if (hedef.select) hedef.select(); }
      else {   // kutusuz adım (özet + QR): imleç yeşil düğmeye — 600 ms sonra (önceki adımdan kalan çift Enter özeti okumadan QR açmasın)
        if (kokRef.current?.contains(document.activeElement)) document.activeElement.blur();
        t2 = window.setTimeout(() => kokRef.current?.querySelector('.aw-dugmeler .aw-btn.ana:not([disabled])')?.focus(), 540);
      }
    }, 60);   // adım geçiş canlandırması bitsin
    let t2 = 0;
    return () => { window.clearTimeout(t); window.clearTimeout(t2); };
  }, [kokRef, adim]);
  useEffect(() => {
    const kok = kokRef.current;
    if (!kok) return undefined;
    const tus = (e) => {
      if (e.key !== 'Enter' || cihazTuruOku() !== 'klavye' || !(e.target instanceof window.HTMLInputElement)) return;
      const k = sihirbazKutulari(kok);
      const i = k.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      if (e.target.type === 'checkbox' && !e.target.checked) { e.target.click(); return; }   // onay kutusu: Enter önce İŞARETLER (X raporu), sonra ilerler
      if (i < k.length - 1) { k[i + 1].focus(); if (k[i + 1].type !== 'checkbox') k[i + 1].select?.(); return; }
      kok.querySelector('.aw-dugmeler .aw-btn.ana:not([disabled])')?.click();
    };
    kok.addEventListener('keydown', tus);
    return () => kok.removeEventListener('keydown', tus);
  }, [kokRef]);
}

export function SayiTusTakimi({ kapsam, etkin = true }) {
  const [hedef, setHedef] = useState(null);
  const ilk = useRef(true);
  const eski = useRef('');
  const panelRef = useRef(null);
  useEffect(() => {
    if (!etkin) { setHedef(null); return undefined; }   // ⌨️ klavye modu: numaratör yok
    document.body.classList.add('sayi-dokunmatik');   // denetim (G31): alt boşluk KALICI — şerit kapanınca sayfa zıplamaz
    const kok = kapsam?.current || document;
    const odak = (e) => {
      const el = e.target;
      const m = el instanceof window.HTMLInputElement ? (el.dataset.imOnceki || el.getAttribute('inputmode')) : null;
      if (!(el instanceof window.HTMLInputElement) || (m !== 'numeric' && m !== 'decimal') || (el.type === 'password' && !el.dataset.pin) || el.type === 'time') {
        setHedef(null);   // Codex: Tab ile düğmeye / metne geçildi → takım bırakır
        return;
      }
      ilk.current = true; eski.current = el.value;
      el.dataset.imOnceki = m; el.setAttribute('inputmode', 'none');   // dokunmatik PC: Windows klavyesi + tuş takımı birlikte açılmasın
      setHedef(el);
    };
    kok.addEventListener('focusin', odak);
    return () => { kok.removeEventListener('focusin', odak); document.body.classList.remove('sayi-dokunmatik'); };
  }, [kapsam, etkin]);
  useEffect(() => {
    if (!hedef) return undefined;
    const elle = () => { ilk.current = false; };
    hedef.addEventListener('input', elle);
    const disari = (e) => {   // Fable: perde YOK (modal kaydırılabilsin, başka alana tek dokunuşla geçilsin)
      if (panelRef.current?.contains(e.target) || e.target === hedef) return;
      setHedef(null);
    };
    document.addEventListener('mousedown', disari, true);
    document.addEventListener('touchstart', disari, true);
    return () => {
      hedef.removeEventListener('input', elle);
      document.removeEventListener('mousedown', disari, true);
      document.removeEventListener('touchstart', disari, true);
      if (hedef.dataset.imOnceki) { hedef.setAttribute('inputmode', hedef.dataset.imOnceki); delete hedef.dataset.imOnceki; }
    };
  }, [hedef]);
  useEffect(() => {
    if (!hedef) return undefined;
    const tus = (e) => {
      if (/^[0-9,]$/.test(e.key) || e.key === 'Backspace') ilk.current = false;
      if (e.key === 'Enter') { e.preventDefault(); setHedef(null); hedef.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); setHedef(null); hedef.blur(); }   // G19 (sahip ekran denemesi 23 Eki): Esc yazılanı SİLMEZ, yalnız kapatır
    };
    window.addEventListener('keydown', tus);
    return () => window.removeEventListener('keydown', tus);
  }, [hedef]);
  useEffect(() => {   // G1 (sahip ekran denemesi 23 Eki): numaratör İleri'nin üstüne biniyordu → '6' yerine '61' sayıldı
    if (!hedef) return undefined;
    const kok = document.documentElement;
    // G31 (sahip ekran denemesi 23 Eki): SAYFA İÇİ formda (Tedarikçi fatura tutarı, Depodan gelen sayım) numaratör yandan düğmeyi
    // örtüyordu → sayfa içinde ALTTA tam genişlik şerit + kutu şeridin üstüne kaydırılır; pencerede (perde) eski hâl: sağda + perde sola
    const altta = !hedef.closest('.sp-perde,.aw-perde');
    const olc = () => kok.style.setProperty('--sayi-bosluk', `${(panelRef.current?.offsetWidth || 360) + 16}px`);
    if (!altta) olc();   // denetim: --sayi-bosluk yalnız pencere modunda ölçülür (şerit genişliği perde boşluğuna karışmasın)
    const sinif = altta ? 'sayi-alt' : 'sayi-acik';
    if (sinif === 'sayi-acik') window.clearTimeout(window.__sayiPerdeT);   // denetim: yalnız pencere→pencere geçişte iptal (sayfa içine geçişte eski sınıf kendi süresinde kalkar)
    document.body.classList.add(sinif);
    let raf = 0;
    if (altta) {   // sınıf eklendi → yapışkan kart akışa döndü; yeni yerleşim bir sonraki karede okunur
      raf = window.requestAnimationFrame(() => {
        const r = hedef.getBoundingClientRect();
        const ust = window.innerHeight - 70 - (panelRef.current?.offsetHeight || 170) - 12;   // şeridin üst kenarı
        if (r.bottom > ust - 140) window.scrollBy({ top: r.bottom - (ust - 140), behavior: 'smooth' });   // kutu + altındaki düğme şeridin üstünde
        else if (r.top < 70) window.scrollBy({ top: r.top - 90, behavior: 'smooth' });   // kart akışa dönünce kutu yukarıda kaldıysa
      });
    }
    if (!altta) window.addEventListener('resize', olc);
    return () => {
      window.cancelAnimationFrame(raf); window.removeEventListener('resize', olc);
      // denetim: pencere modunda boşluk dokunuşun İLK anında kalkınca pencere ~190px kayıyor, dokunuş başka düğmeye düşüyordu → 400 ms sonra
      if (sinif === 'sayi-acik') window.__sayiPerdeT = window.setTimeout(() => document.body.classList.remove(sinif), 400);
      else document.body.classList.remove(sinif);
    };
  }, [hedef]);
  if (!etkin) return null;
  // G38 (sim 23 Eki): sayı kutulu pencere dokunmatikte BAŞTAN sola yaslı — ilk dokunuşta kayıp ikinci dokunuş yanlış kutuya düşmesin;
  // G39: açılış/kapanış sihirbazı (aw-perde) BÜTÜN adımlarda aynı yerde (QR adımında ortaya zıplamasın)
  if (!hedef || !document.body.contains(hedef)) return <style>{'body.sayi-acik .sp-perde,body.sayi-acik .aw-perde,body.sayi-dokunmatik .aw-perde{padding-right:var(--sayi-bosluk,376px)!important;transition:padding-right .12s}body.sayi-dokunmatik .sp-perde:has(input[inputmode=\"numeric\"],input[inputmode=\"decimal\"],input[data-im-onceki]){padding-right:var(--sayi-bosluk,376px)!important}body.sayi-dokunmatik .sp-govde{padding-bottom:240px}body.sayi-dokunmatik .sp-sayi-kart{position:static!important}'}</style>;
  const altta = !hedef.closest('.sp-perde,.aw-perde');   // G31: sayfa içi → alt şerit
  const ondalik = (hedef.dataset.imOnceki || hedef.getAttribute('inputmode')) === 'decimal';
  const bas = (k) => {
    try { window.navigator.vibrate?.(8); } catch { /* yok */ }
    let v = ilk.current && k !== '⌫' ? '' : String(hedef.value || '');
    ilk.current = false;
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === ',') { if (ondalik && !v.includes(',')) v = (v || '0') + ','; }
    else {
      const [tam, kesir] = v.split(',');
      if (kesir !== undefined) { if (kesir.length < 2) v += k; }
      else if ((tam || '').replace(/^0+/, '').length + k.length <= 8) v = (tam === '0' ? '' : tam || '') + k;
    }
    yazInput(hedef, v);
  };
  const sonraki = () => {
    const hepsi = [...(kapsam?.current || document).querySelectorAll('input[inputmode="numeric"],input[inputmode="decimal"],input[data-im-onceki]')];
    const i = hepsi.indexOf(hedef);
    setHedef(null);
    if (i >= 0 && hepsi[i + 1]) hepsi[i + 1].focus(); else hedef.blur();
  };
  const tuslar = altta   // denetim: şeritte sayılar sırayla (1–8 / 9 0 00 , ⌫ ⇥ ✓)
    ? ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '00', ondalik ? ',' : '', '⌫', '⇥', '✓', '']
    : ['7', '8', '9', '⌫', '4', '5', '6', '✓', '1', '2', '3', '⇥', '0', '00', ondalik ? ',' : '', ''];
  return (
    <>
      <style>{'body.sayi-acik .sp-perde,body.sayi-acik .aw-perde,body.sayi-dokunmatik .aw-perde{padding-right:var(--sayi-bosluk,376px)!important;transition:padding-right .12s}body.sayi-dokunmatik .sp-perde:has(input[inputmode=\"numeric\"],input[inputmode=\"decimal\"],input[data-im-onceki]){padding-right:var(--sayi-bosluk,376px)!important}body.sayi-dokunmatik .sp-govde{padding-bottom:240px}body.sayi-dokunmatik .sp-sayi-kart{position:static!important}'}</style>
      <div ref={panelRef} onMouseDown={(e) => e.preventDefault()} style={{ position: 'fixed', bottom: 70, zIndex: 90, background: C.bg1,
        ...(altta ? { left: 8, right: 8, maxWidth: 760, margin: '0 auto', gridTemplateColumns: 'repeat(8,1fr)' }
          : { right: 8, width: 'min(360px,50vw)', minWidth: 260, gridTemplateColumns: 'repeat(4,1fr)' }),
        border: `1px solid ${C.cizgi}`, borderRadius: 14, padding: 10, display: 'grid', gap: 8, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
        {tuslar.map((k, i) => (k === '' ? <span key={i} /> : (
          <button key={i} type="button" className="sp-btn" style={{ minHeight: 64, fontSize: 24, padding: 0, background: k === '✓' ? C.yesil : C.bg2, color: k === '✓' ? '#05210f' : C.yazi }}
            onClick={() => (k === '✓' ? (setHedef(null), hedef.blur()) : k === '⇥' ? sonraki() : k === '00' ? (bas('0'), bas('0')) : bas(k))}>{k}</button>
        )))}
      </div>
    </>
  );
}
