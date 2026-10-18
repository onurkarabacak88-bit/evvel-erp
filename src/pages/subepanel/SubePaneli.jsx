// 🧾 YENİ ŞUBE PANELİ (SUBE_PANELI_TASARIM.md) — sunucu: evvel_yeni_panel_api.py · adres /panel/{sube_id}
// Sahip: personel AYNI paneli görür (eski panelin koyu renk dili, sol menü, sağda Kasa Devri / Kapanış); kalite artıyorsa revizyon
// serbest. Uyarı / alarm personele GİTMEZ (merkez Bekleyen işler'de). Hata tek cümle: "Kaydedilemedi, tekrar deneyin".
// POS kuralı: düğme ≥ 72px, +/− 72×72, adet 32px. Ad seçimi (PIN yetki fazında). Panel 1 Kasım'a kadar DENEME (kaydetmez).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';

const C = { bg: '#0b0f1a', bg1: '#111827', bg2: '#1a2236', bg3: '#222d42', cizgi: 'rgba(99,120,160,0.18)', yazi: '#f0f4ff', soluk: '#7a8ba8',
  mavi: '#3b82f6', yesil: '#22c55e', sari: '#f59e0b', kirmizi: '#ef4444', mor: '#7c3aed' };
const CSS = `
.sp *{box-sizing:border-box} .sp{font-family:Inter,system-ui,sans-serif;background:${C.bg};color:${C.yazi};min-height:100vh;font-size:15px}
.sp-btn{min-height:72px;border-radius:12px;border:1px solid ${C.cizgi};background:${C.bg2};color:${C.yazi};font-size:17px;font-weight:700;cursor:pointer;padding:10px 16px}
.sp-btn:disabled{opacity:.45;cursor:default} .sp-ana{background:${C.mavi};border-color:${C.mavi}} .sp-yesil{background:${C.yesil};border-color:${C.yesil};color:#05210f}
.sp-mor{background:linear-gradient(135deg,#4c1d95,${C.mor});border-color:rgba(168,85,247,.4)}
.sp-in{width:100%;min-height:56px;border-radius:10px;border:1px solid ${C.cizgi};background:${C.bg1};color:${C.yazi};font-size:22px;padding:8px 12px}
.sp-sol{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:10px 14px;border-radius:8px;border:none;background:transparent;color:${C.soluk};font-size:15px;font-weight:600;cursor:pointer;text-align:left}
.sp-sol.akt{background:rgba(59,130,246,.15);color:${C.mavi}} .sp-sol:disabled{opacity:.4;cursor:default}
.sp-kart{background:${C.bg1};border:1px solid ${C.cizgi};border-radius:12px;padding:14px}
.sp-pm{width:72px;height:72px;border-radius:12px;border:1px solid ${C.cizgi};background:${C.bg3};color:${C.yazi};font-size:30px;font-weight:800;cursor:pointer}
.sp-govde{display:grid;grid-template-columns:220px 1fr 260px;gap:12px;padding:12px}
@media (max-width:980px){.sp-govde{grid-template-columns:1fr}}
`;

const yeniIstek = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 60);
const tl = (x) => (Number(x || 0)).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
const sayi = (s) => String(s ?? '').replace(/[^\d]/g, '');
const tutar = (s) => String(s ?? '').replace(/[^\d,.]/g, '').replace('.', ',');
const tutarNum = (s) => (s === '' || s == null ? 0 : Number(String(s).replace(/\./g, '').replace(',', '.')) || 0);

function Modal({ baslik, kapat, children, genis }) {
  return (
    <div onClick={kapat} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="sp-kart" style={{ width: genis ? 'min(980px,100%)' : 'min(560px,100%)', maxHeight: '92vh', overflow: 'auto', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><b style={{ fontSize: 20, flex: 1 }}>{baslik}</b>
          <button className="sp-btn" style={{ minHeight: 48, padding: '4px 14px' }} onClick={kapat}>✕</button></div>
        {children}
      </div>
    </div>
  );
}

// Ürün adet seçici (+/− 72px, adet 32px) — ürün aç / fire
function AdetListesi({ gruplar, adet, setAdet }) {
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
function SayimListesi({ gruplar, sayim, setSayim }) {
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

const sayimGovde = (sayim) => Object.entries(sayim).filter(([, v]) => v !== '' && v != null).map(([urun_id, v]) => ({ urun_id, sayilan: Number(v) }));
const kalemGovde = (adet) => Object.entries(adet).filter(([, n]) => n > 0).map(([urun_id, n]) => ({ urun_id, adet: n }));

export default function SubePaneli({ subeId }) {
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [kisi, setKisi] = useState(() => { try { return localStorage.getItem('sp_kisi:' + subeId) || ''; } catch { return ''; } });
  const [sekme, setSekme] = useState('ana');
  const [modal, setModal] = useState(null);
  const [mesaj, setMesaj] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [istek, setIstek] = useState(yeniIstek);
  // form durumları
  const [adet, setAdet] = useState({});
  const [sebep, setSebep] = useState('');
  const [sayim, setSayim] = useState({});
  const [f, setF] = useState({});

  const yukle = useCallback(() => api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/durum`)
    .then((x) => { setD(x); setHata(''); }).catch((e) => setHata(e?.message || 'Panel açılamadı')), [subeId]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => { try { if (kisi) localStorage.setItem('sp_kisi:' + subeId, kisi); } catch { /* yok say */ } }, [kisi, subeId]);

  const temizle = () => { setAdet({}); setSebep(''); setSayim({}); setF({}); setIstek(yeniIstek()); };
  const ac = (m) => { temizle(); setModal(m); };
  const gonder = async (yol, govde, sonra) => {
    if (mesgul) return;
    if (!kisi) { setMesaj({ tur: 'hata', metin: 'Önce adını seç' }); return; }
    setMesgul(true);
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/${yol}`, { method: 'POST', body: { ...govde, istek_id: istek } });
      setMesaj({ tur: r.kuru ? 'deneme' : 'tamam', metin: r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.tekrar ? 'Bu kayıt zaten alınmıştı' : 'Kaydedildi ✓') });
      setModal(null); temizle(); sonra?.(); yukle();
    } catch (e) {
      setMesaj({ tur: 'hata', metin: e?.message && e.message.length < 140 ? e.message : 'Kaydedilemedi, tekrar deneyin' });
    }
    setMesgul(false);
  };

  const tumUrunler = useMemo(() => {
    if (!d) return [];
    const m = {};
    [...d.sayilan, ...d.acilan].forEach((g) => { m[g.kategori] = [...(m[g.kategori] || []), ...g.urunler]; });
    return Object.entries(m).map(([kategori, urunler]) => ({ kategori, urunler }));
  }, [d]);

  if (hata) return <div className="sp" style={{ padding: 24 }}><style>{CSS}</style><h2>Panel açılamadı</h2><p>{hata}</p><button className="sp-btn" onClick={yukle}>Tekrar dene</button></div>;
  if (!d) return <div className="sp" style={{ padding: 24 }}><style>{CSS}</style>Yükleniyor…</div>;
  const kisiAd = d.personel.find((p) => p.id === kisi)?.ad;

  const MENU = [
    ['ana', '🏠', 'Ana Sayfa'], ['ac', '📦', 'Ürün Aç'], ['fire', '🗑️', 'Fire'], ['araTeslim', '💵', 'Ara Teslim'],
    ['-'], ['teslim', '🚚', 'Teslim Al', true], ['depo', '🏬', 'Depodan Gelen', true], ['siparis', '🛒', 'Sipariş', true],
    ['gider', '🧾', 'Anlık Gider', true], ['not', '📝', 'Not / Mesaj', true],
  ];

  return (
    <div className="sp">
      <style>{CSS}</style>
      {/* ÜST ŞERİT */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: C.bg1, borderBottom: `1px solid ${C.cizgi}`, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 20 }}>☕ {d.sube.ad}</b>
        <span style={{ color: C.soluk }}>{new Date(d.gun + 'T12:00').toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        {d.kuru && <span style={{ background: 'rgba(245,158,11,.15)', color: C.sari, padding: '6px 10px', borderRadius: 8, fontWeight: 700 }}>DENEME — kaydedilmez · panel {new Date(d.panel_baslangic + 'T12:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })} sabahı açılır</span>}
        <span style={{ flex: 1 }} />
        <select className="sp-in" style={{ width: 240, fontSize: 18, minHeight: 52 }} value={kisi} onChange={(e) => setKisi(e.target.value)}>
          <option value="">— Adını seç —</option>
          {d.personel.map((p) => <option key={p.id} value={p.id}>{p.ad}</option>)}
        </select>
      </div>
      {mesaj && (
        <div onClick={() => setMesaj(null)} style={{ margin: '10px 12px 0', padding: '12px 14px', borderRadius: 10, fontWeight: 700, cursor: 'pointer',
          background: mesaj.tur === 'hata' ? 'rgba(239,68,68,.15)' : mesaj.tur === 'deneme' ? 'rgba(245,158,11,.15)' : 'rgba(34,197,94,.15)',
          color: mesaj.tur === 'hata' ? C.kirmizi : mesaj.tur === 'deneme' ? C.sari : C.yesil }}>{mesaj.metin}</div>
      )}

      <div className="sp-govde">
        {/* SOL MENÜ */}
        <div className="sp-kart" style={{ padding: 6, alignSelf: 'start' }}>
          {MENU.map((m, i) => m[0] === '-' ? <div key={i} style={{ height: 1, background: C.cizgi, margin: '8px 6px' }} />
            : <button key={m[0]} className={'sp-sol' + (sekme === m[0] ? ' akt' : '')} disabled={m[3]} title={m[3] ? 'Yakında' : ''}
                onClick={() => (m[0] === 'ana' ? setSekme('ana') : ac(m[0]))}>
                <span style={{ fontSize: 20, width: 26 }}>{m[1]}</span>{m[2]}{m[3] && <small style={{ marginLeft: 'auto' }}>yakında</small>}
              </button>)}
        </div>

        {/* ORTA: ANA */}
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          {!d.acilis_var && (
            <button className="sp-btn sp-ana" style={{ minHeight: 96, fontSize: 22 }} onClick={() => ac('acilis')}>☀️ Açılışı Yap — kasa + sayım</button>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
            <button className="sp-btn" onClick={() => ac('ac')}>📦 Ürün Aç</button>
            <button className="sp-btn" onClick={() => ac('fire')}>🗑️ Fire</button>
            <button className="sp-btn" onClick={() => ac('araTeslim')}>💵 Ara Teslim</button>
          </div>
          <div className="sp-kart">
            <b>Bugün kaydedilenler</b>
            {d.bugun.length === 0 && <div style={{ color: C.soluk, marginTop: 6 }}>Henüz kayıt yok.</div>}
            {d.bugun.map((o) => (
              <div key={o.id} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: `1px solid ${C.cizgi}`, opacity: o.iptal ? 0.5 : 1 }}>
                <span style={{ color: C.soluk, width: 48 }}>{o.zaman}</span>
                <b style={{ flex: 1 }}>{{ acilis: 'Açılış', kapanis: 'Kapanış', urun_ac: 'Ürün açıldı', fire: 'Fire', teslim: 'Ara teslim', vardiya: 'Kasa devri' }[o.tur] || o.tur}</b>
                <span style={{ color: C.soluk }}>{o.kim}</span>
              </div>
            ))}
          </div>
        </div>

        {/* SAĞ: KASA DEVRİ / KAPANIŞ */}
        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <div className="sp-kart" style={{ display: 'grid', gap: 10 }}>
            <div style={{ color: C.soluk }}>{kisiAd ? `👤 ${kisiAd}` : 'Adını seç'}</div>
            <button className="sp-btn sp-ana" onClick={() => ac('devir')}>💵 Kasa Devri</button>
            <button className="sp-btn sp-mor" disabled={d.kapanis_var} onClick={() => ac('kapanis')}>{d.kapanis_var ? '🌙 Kapanış yapıldı' : '🌙 Kapanışı Başlat'}</button>
          </div>
        </div>
      </div>

      {/* ── MODALLAR ── */}
      {modal === 'acilis' && (
        <Modal baslik="☀️ Açılış" kapat={() => setModal(null)} genis>
          <label style={{ display: 'grid', gap: 6 }}><b>Kasadaki para (sayılan nakit)</b>
            <input className="sp-in" inputMode="decimal" value={f.kasa ?? ''} onChange={(e) => setF({ ...f, kasa: tutar(e.target.value) })} placeholder="0,00" /></label>
          <div><b>Sayım</b> <span style={{ color: C.soluk }}>— saydığın ürünleri yaz, boş bırakılan sayılmaz</span></div>
          <SayimListesi gruplar={d.sayilan} sayim={sayim} setSayim={setSayim} />
          <button className="sp-btn sp-yesil" disabled={mesgul || f.kasa === undefined || f.kasa === ''}
            onClick={() => gonder('acilis', { personel_id: kisi, kasa_sayim: tutarNum(f.kasa), sayim: sayimGovde(sayim) })}>✔ Açılışı Kaydet</button>
        </Modal>
      )}
      {(modal === 'ac' || modal === 'fire') && (
        <Modal baslik={modal === 'ac' ? '📦 Ürün Aç' : '🗑️ Fire'} kapat={() => setModal(null)} genis>
          <AdetListesi gruplar={modal === 'ac' ? d.acilan : tumUrunler} adet={adet} setAdet={setAdet} />
          {modal === 'fire' && <label style={{ display: 'grid', gap: 6 }}><b>Sebep</b>
            <input className="sp-in" style={{ fontSize: 18 }} value={sebep} onChange={(e) => setSebep(e.target.value)} placeholder="ör. döküldü, bozuldu" /></label>}
          <button className="sp-btn sp-yesil" disabled={mesgul || !kalemGovde(adet).length || (modal === 'fire' && sebep.trim().length < 2)}
            onClick={() => gonder(modal === 'ac' ? 'urun-ac' : 'fire', { personel_id: kisi, kalemler: kalemGovde(adet), ...(modal === 'fire' ? { sebep } : {}) })}>
            ✔ {modal === 'ac' ? 'Açtıklarımı Kaydet' : 'Fireyi Kaydet'} ({kalemGovde(adet).reduce((a, x) => a + x.adet, 0)})</button>
        </Modal>
      )}
      {modal === 'araTeslim' && (
        <Modal baslik="💵 Ara Teslim" kapat={() => setModal(null)}>
          <b>Kime?</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
            {d.teslim_alanlar.map((a) => <button key={a.id} className={'sp-btn' + (f.alan === a.id ? ' sp-ana' : '')} onClick={() => setF({ ...f, alan: a.id })}>{a.ad}</button>)}
          </div>
          <label style={{ display: 'grid', gap: 6 }}><b>Tutar</b>
            <input className="sp-in" inputMode="decimal" value={f.tutar ?? ''} onChange={(e) => setF({ ...f, tutar: tutar(e.target.value) })} placeholder="0,00" /></label>
          <button className="sp-btn sp-yesil" disabled={mesgul || !f.alan || !tutarNum(f.tutar)}
            onClick={() => gonder('ara-teslim', { personel_id: kisi, alan: f.alan, tutar: tutarNum(f.tutar) })}>✔ Teslimi Kaydet</button>
        </Modal>
      )}
      {modal === 'devir' && (
        <Modal baslik="💵 Kasa Devri" kapat={() => setModal(null)}>
          <div style={{ color: C.soluk }}>Devreden: <b style={{ color: C.yazi }}>{kisiAd || '— üstten adını seç —'}</b></div>
          <label style={{ display: 'grid', gap: 6 }}><b>Devralan</b>
            <select className="sp-in" style={{ fontSize: 18 }} value={f.devralan || ''} onChange={(e) => setF({ ...f, devralan: e.target.value })}>
              <option value="">— seç —</option>{d.personel.filter((p) => p.id !== kisi).map((p) => <option key={p.id} value={p.id}>{p.ad}</option>)}
            </select></label>
          <label style={{ display: 'grid', gap: 6 }}><b>Kasada sayılan</b>
            <input className="sp-in" inputMode="decimal" value={f.sayilan ?? ''} onChange={(e) => setF({ ...f, sayilan: tutar(e.target.value) })} placeholder="0,00" /></label>
          <button className="sp-btn sp-yesil" disabled={mesgul || !f.devralan || f.sayilan === undefined || f.sayilan === ''}
            onClick={() => gonder('devir', { devreden_id: kisi, devralan_id: f.devralan, sayilan: tutarNum(f.sayilan) })}>✔ Devri Kaydet</button>
        </Modal>
      )}
      {modal === 'kapanis' && (
        <Kapanis d={d} kisi={kisi} mesgul={mesgul} sayim={sayim} setSayim={setSayim} kapat={() => setModal(null)}
          gonder={(govde) => gonder('kapanis', { personel_id: kisi, ...govde, sayim: sayimGovde(sayim) })} />
      )}
    </div>
  );
}

// 🌙 Kapanış — 4 adım (eski 5 adım: ürün aç sorusu kalktı, QR mühür/saat kilidi merkeze)
function Kapanis({ d, mesgul, sayim, setSayim, kapat, gonder }) {
  const [adim, setAdim] = useState(1);
  const [v, setV] = useState({ nakit: '', pos: '', online: '', kor: '', birakilan: '', deg: {}, teslim: {} });
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const teslimler = Object.entries(v.teslim).filter(([, t]) => tutarNum(t) > 0).map(([alan, t]) => ({ alan, tutar: tutarNum(t) }));
  // bileşen DEĞİL düz fonksiyon: her tuşta yeniden kurulup odağı kaybetmesin
  const alan = (k, ad, ipucu) => (
    <label key={k} style={{ display: 'grid', gap: 6 }}><b>{ad}</b>{ipucu && <span style={{ color: C.soluk, fontSize: 13 }}>{ipucu}</span>}
      <input className="sp-in" inputMode="decimal" value={v[k]} onChange={(e) => set(k, tutar(e.target.value))} placeholder="0,00" /></label>
  );
  return (
    <Modal baslik={`🌙 Kapanış — adım ${adim} / 4`} kapat={kapat} genis={adim === 3}>
      {adim === 1 && (<>
        {alan("nakit", "Nakit satış", "X raporundaki nakit")}
        {alan("pos", "POS (kart)")}
        {alan("online", "Online")}
        <button className="sp-btn sp-ana" disabled={v.nakit === '' && v.pos === ''} onClick={() => setAdim(2)}>Kasa ve Teslime Geç →</button>
      </>)}
      {adim === 2 && (<>
        {alan("kor", "Kasada saydığın para", "teslimden önce, kasadaki nakit")}
        <b>Teslim (varsa)</b>
        {d.teslim_alanlar.map((a) => (
          <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 90, fontWeight: 700 }}>{a.ad}</span>
            <input className="sp-in" inputMode="decimal" value={v.teslim[a.id] ?? ''} placeholder="0,00"
              onChange={(e) => set('teslim', { ...v.teslim, [a.id]: tutar(e.target.value) })} /></label>
        ))}
        {alan("birakilan", "Kasada bırakılan")}
        <b>Değirmen</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
          {[['gunluk', 'Bugünkü Çekim', 'sağ üst'], ['doz1', 'Doz I (toplam)', 'sayaç'], ['doz2', 'Doz II (toplam)', 'sayaç'], ['doz3', 'Doz III', 'Helios']].map(([k, ad, ph]) => (
            <label key={k} style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk }}>{ad}</span>
              <input className="sp-in" inputMode="numeric" placeholder={ph} value={v.deg[k] ?? ''} onChange={(e) => set('deg', { ...v.deg, [k]: sayi(e.target.value) })} /></label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" onClick={() => setAdim(1)}>← Geri</button>
          <button className="sp-btn sp-ana" style={{ flex: 1 }} onClick={() => setAdim(3)}>Sayıma Geç →</button></div>
      </>)}
      {adim === 3 && (<>
        <div><b>Ürün sayımı</b> <span style={{ color: C.soluk }}>— bardak, su, süt, Redbull, soda, cookie, pasta</span></div>
        <SayimListesi gruplar={d.sayilan} sayim={sayim} setSayim={setSayim} />
        <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" onClick={() => setAdim(2)}>← Geri</button>
          <button className="sp-btn sp-ana" style={{ flex: 1 }} onClick={() => setAdim(4)}>Özete Geç →</button></div>
      </>)}
      {adim === 4 && (<>
        <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
          <div>Nakit: <b>{tl(tutarNum(v.nakit))}</b> · POS: <b>{tl(tutarNum(v.pos))}</b> · Online: <b>{tl(tutarNum(v.online))}</b></div>
          <div>Kasada sayılan: <b>{tl(tutarNum(v.kor))}</b> · Bırakılan: <b>{tl(tutarNum(v.birakilan))}</b></div>
          <div>Teslim: {teslimler.length ? teslimler.map((t) => `${t.alan.split(':')[1]} ${tl(t.tutar)}`).join(' · ') : '—'}</div>
          <div>Sayılan ürün: <b>{Object.values(sayim).filter((x) => x !== '').length}</b></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" onClick={() => setAdim(3)}>← Geri</button>
          <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={mesgul}
            onClick={() => gonder({ nakit: tutarNum(v.nakit), pos: tutarNum(v.pos), online: tutarNum(v.online), teslimler,
              kor_sayim: v.kor === '' ? null : tutarNum(v.kor), birakilan: v.birakilan === '' ? null : tutarNum(v.birakilan),
              degirmen: Object.values(v.deg).some((x) => x !== '') ? v.deg : null })}>✔ Kapanışı Gönder</button></div>
      </>)}
    </Modal>
  );
}
