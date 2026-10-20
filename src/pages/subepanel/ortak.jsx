// 🧾 ŞUBE PANELİ — ORTAK PARÇALAR (PANEL_YENIDEN_KURULUM.md · Basamak 1)
// Eski panelin (sube_panel.html) tema token'ları AYNEN: --bg #0b0f1a, --bg1 #111827, --bg2 #1a2236, --bg3 #222d42, accent #3b82f6, cyan #06b6d4,
// ok #22c55e, warn #f59e0b, danger #ef4444, depo mor #8b5cf6, tedarikçi turuncu #f97316, radius 12/8, Inter 14px.
// Bu dosya yalnız React'e bağımlıdır (döngü yok): ekranlar ortak'ı alır, SubePaneli ekranları alır.
import React, { useEffect, useRef, useState } from 'react';
import { imzaliFetch } from '../../utils/cihazImza';
import { sayiTR } from '../../utils/trSayi';

export const C = { bg: '#0b0f1a', bg1: '#111827', bg2: '#1a2236', bg3: '#222d42', cizgi: 'rgba(99,120,160,0.18)', yazi: '#f0f4ff', soluk: '#7a8ba8',
  mavi: '#3b82f6', cyan: '#06b6d4', yesil: '#22c55e', sari: '#f59e0b', kirmizi: '#ef4444', mor: '#8b5cf6', turuncu: '#f97316' };

export const CSS = `
.sp *{box-sizing:border-box} .sp{font-family:Inter,system-ui,sans-serif;background:${C.bg};color:${C.yazi};min-height:100vh;font-size:14px;padding-bottom:64px}
.sp-btn{min-height:72px;border-radius:12px;border:1px solid ${C.cizgi};background:${C.bg2};color:${C.yazi};font-size:17px;font-weight:700;cursor:pointer;padding:10px 16px}
.sp-btn:disabled{opacity:.45;cursor:default} .sp-ana{background:${C.mavi};border-color:${C.mavi}} .sp-yesil{background:${C.yesil};border-color:${C.yesil};color:#05210f}
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
.sp-cip{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:999px;border:1px solid ${C.cizgi};background:${C.bg2};color:${C.soluk};font-weight:700;cursor:pointer;font:inherit}
@media (max-width:980px){.sp-govde{grid-template-columns:1fr 280px} .sp-sol-kolon{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px} .sp-sol-kolon .sp-sol{width:auto;flex:0 0 auto} .sp-sol-kolon .sp-sol-baslik{width:100%}}
@media (max-width:768px){.sp-govde{grid-template-columns:1fr} .sp-sag-kolon{display:none} .sp-alt{height:62px}}
`;

export const yeniIstek = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 60);
export const tl = (x) => (Number(x || 0)).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
export const sayi = (s) => String(s ?? '').replace(/[^\d]/g, '');
export const tutar = (s) => String(s ?? '').replace(/[^\d,.]/g, '').replace('.', ',');
export const tutarNum = (s) => { const n = sayiTR(s, 0); return Number.isNaN(n) ? 0 : n; };   // tek kaynak utils/trSayi ("12.50" artık 12,5)
export const sayimGovde = (sayim) => Object.entries(sayim).filter(([, v]) => v !== '' && v != null).map(([urun_id, v]) => ({ urun_id, sayilan: Number(v) }));
export const kalemGovde = (adet) => Object.entries(adet).filter(([, n]) => n > 0).map(([urun_id, n]) => ({ urun_id, adet: n }));

export function Modal({ baslik, kapat, children, genis, genislik }) {
  return (
    <div onClick={kapat || undefined} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="sp-kart" style={{ width: genislik ? `min(${genislik}px,100%)` : genis ? 'min(980px,100%)' : 'min(560px,100%)', maxHeight: '92vh', overflow: 'auto', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 20, flex: 1 }}>{baslik}</b>
          {kapat && <button className="sp-btn" style={{ minHeight: 48, padding: '4px 14px' }} onClick={kapat}>✕</button>}</div>
        {children}
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

// 🔑 KİM + PIN (sahip R1b: QR'la içeride olan + kendi 4 haneli PIN'i) — TEK parça; sipariş / gönderilecek / depodan gelen bunu kullanır
// (Tedarikçi teslim + Ürün aç'taki eski kopyalar sonraki temizlikte buna geçer). PIN yalnız bellekte.
export function KisiPin({ adaylar, kisi, setKisi, pin, setPin, hata, devam, devamYazi = 'Devam → özet', soru = 'Kim?' }) {
  return (<>
    <b>{soru}</b>
    {adaylar.length === 0 ? <div style={{ color: C.sari, fontWeight: 700 }}>İçeride kimse yok — önce telefonundan QR ile giriş yap.</div> : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
        {adaylar.map((x) => <button key={x.id} type="button" className={'sp-btn' + (kisi === x.id ? ' sp-ana' : '')} onClick={() => { setKisi(x.id); setPin(''); }}>{x.ad}</button>)}
      </div>
    )}
    {kisi && (
      <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}><b>🔑 PIN</b>
        <input className="sp-in" style={{ width: 140, textAlign: 'center', letterSpacing: 8 }} type="password" inputMode="numeric" data-pin="1" autoComplete="off"
          maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••"
          onKeyDown={(e) => { if (e.key === 'Enter' && kisi && pin.length === 4) { e.preventDefault(); devam(); } }} /></label>
    )}
    {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
    <button className="sp-btn sp-ana" disabled={!kisi || pin.length !== 4} onClick={devam}>{devamYazi}</button>
  </>);
}

// Ürün adet seçici (+/− 72px, adet 32px) — ürün aç / fire
export function AdetListesi({ gruplar, adet, setAdet }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {gruplar.filter((g) => g.urunler.length).map((g) => (
        <div key={g.kategori}>
          <div style={{ color: C.soluk, fontWeight: 700, margin: '4px 0 8px' }}>{g.kategori}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 8 }}>
            {g.urunler.map((u) => {
              const n = adet[u.id] || 0;
              return (
                <div key={u.id} className="sp-kart" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderColor: n ? C.mavi : C.cizgi }}>
                  <div style={{ flex: 1, minWidth: 0 }}><b>{u.ad}</b><div style={{ color: C.soluk, fontSize: 13 }}>{u.birim}</div></div>
                  <button className="sp-pm" onClick={() => setAdet((a) => ({ ...a, [u.id]: Math.max(0, n - 1) }))}>−</button>
                  <div style={{ width: 52, textAlign: 'center', fontSize: 32, fontWeight: 800 }}>{n}</div>
                  <button className="sp-pm" onClick={() => setAdet((a) => ({ ...a, [u.id]: n + 1 }))}>+</button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
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
    const cek = () => imzaliFetch('tablet', 'GET', yol)
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
// 7 8 9 ⌫ / 4 5 6 ✓ / 1 2 3 / 0 00 , · en çok 8 tam + 2 ondalık · ilk tuş eski değeri siler · Enter onay, Esc iptal, Tab sonraki alan ·
// dışarı tıklamak onaylayarak kapatır. React kontrollü input'a NATIVE setter + 'input' olayıyla yazar (state güncellenir — Fable).
const yazInput = (el, deger) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, deger); else el.value = deger;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
export function SayiTusTakimi({ kapsam }) {
  const [hedef, setHedef] = useState(null);
  const ilk = useRef(true);
  const eski = useRef('');
  const panelRef = useRef(null);
  useEffect(() => {
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
    return () => kok.removeEventListener('focusin', odak);
  }, [kapsam]);
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
      else if (e.key === 'Escape') { e.preventDefault(); yazInput(hedef, eski.current); setHedef(null); hedef.blur(); }
    };
    window.addEventListener('keydown', tus);
    return () => window.removeEventListener('keydown', tus);
  }, [hedef]);
  if (!hedef || !document.body.contains(hedef)) return null;
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
  const tuslar = ['7', '8', '9', '⌫', '4', '5', '6', '✓', '1', '2', '3', '⇥', '0', '00', ondalik ? ',' : '', ''];
  return (
    <>
      <div ref={panelRef} onMouseDown={(e) => e.preventDefault()} style={{ position: 'fixed', right: 8, bottom: 70, width: 'min(360px,50vw)', minWidth: 260, zIndex: 90, background: C.bg1,
        border: `1px solid ${C.cizgi}`, borderRadius: 14, padding: 10, display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}>
        {tuslar.map((k, i) => (k === '' ? <span key={i} /> : (
          <button key={i} type="button" className="sp-btn" style={{ minHeight: 64, fontSize: 24, padding: 0, background: k === '✓' ? C.yesil : C.bg2, color: k === '✓' ? '#05210f' : C.yazi }}
            onClick={() => (k === '✓' ? (setHedef(null), hedef.blur()) : k === '⇥' ? sonraki() : k === '00' ? (bas('0'), bas('0')) : bas(k))}>{k}</button>
        )))}
      </div>
    </>
  );
}
