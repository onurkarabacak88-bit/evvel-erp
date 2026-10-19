// 🧾 ŞUBE PANELİ — ÇERÇEVE (PANEL_YENIDEN_KURULUM.md: eski sube_panel.html AYNEN, yalnız QR sistemi yeni) · sunucu: evvel_yeni_panel_api.py
// Basamak 1: üst bar · sol menü (STOK İŞLEMLERİ / GÜN SONU / HIZLI ERİŞİM) · ana sayfa (AnaSayfa.jsx) · sağ (Kasa devri / Günü kapat) · alt bar ·
// açılış öncesi QR kapısı · sayı tuş takımı. Ekranlar (açılış, kapanış, devir, ürün aç, fire, ara teslim…) kendi basamaklarında yeniden kurulur;
// o güne dek aşağıdaki mevcut modallar AYNEN çalışır. Panel 1 Kasım'a kadar DENEME (kaydetmez).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { cihazId } from '../../utils/cihazImza';
import AcilisSihirbazi from './AcilisSihirbazi';
import AnaSayfa from './AnaSayfa';
import KasaDevri, { DEVIR_ACIK, devirEtiket } from './KasaDevri';
import UrunAc from './UrunAc';
import { AdetListesi, C, CSS, kalemGovde, Modal, SayimListesi, SayiTusTakimi, sayi, sayimGovde, TabletQR, tl, tutar, tutarNum, yeniIstek } from './ortak';

export default function SubePaneli({ subeId }) {
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [kisi, setKisi] = useState('');
  const [sekme, setSekme] = useState('ana');
  const [acSecim, setAcSecim] = useState(0);   // Ürün Aç: onaylanmamış seçim sayısı (sol menü rozeti, eski solUrunAcBadge)
  useEffect(() => { setAcSecim(0); }, [d?.gun]);   // Fable: gün değişince rozet donmasın
  const [modal, setModal] = useState(null);
  const [mesaj, setMesaj] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [istek, setIstek] = useState(yeniIstek);
  // form durumları
  const [adet, setAdet] = useState({});
  const [sebep, setSebep] = useState('');
  const [sayim, setSayim] = useState({});
  const [f, setF] = useState({});
  const [pin, setPin] = useState('');   // sık işlem PIN'i — YALNIZ bellekte; taslak / kuyruk / deneme kaydına girmez
  const [anladim, setAnladim] = useState(null);     // tam ekran hata kartı (D6): işlem yapılmadı → personel görmeden geçemez
  const [kuyrukSay, setKuyrukSay] = useState(0);
  // 📱 Yoklama (QR telefon): tablet bu tarayıcıda kayıtlıysa köşede küçük QR (dokununca büyür); kapı açıkken büyük QR
  const [qrBuyuk, setQrBuyuk] = useState(false);
  const tabletVar = !!cihazId('tablet');
  const yok = d?.yoklama || { var: false, qr_gerekli: false, girenler: [], son_okutanlar: [], tablet_kayitli: false, devir: null, kapanis_sorumlusu: null };
  const qrGorunur = tabletVar && qrBuyuk;
  // 💵 Kasa devri çift onay (D5, §B8): panel formu kurar (hazir) → devreden telefonundan 'Devrediyorum' → devralan 'Kabul ediyorum' / 'Tutmuyor'
  const devir = yok.var ? yok.devir : null;
  const devirBekliyor = !!devir && DEVIR_ACIK.includes(devir.durum);

  // 💾 TASLAK (D6): açık formun her değişikliği tablete — pencere kapansa / sayfa yenilense geri gelir (iş günü boyunca)
  const [formGun, setFormGun] = useState(null);   // Codex: açık formun günü, açıldığı an sabitlenir
  const tKey = (m, g) => `sp_taslak:${subeId}:${g || formGun || d?.gun || ''}:${m}`;
  const taslakSil = (m) => { try { localStorage.removeItem(tKey(m)); } catch { /* yok say */ } };
  useEffect(() => {
    if (!modal || modal === 'kapanis' || !d) return;
    // Codex: istek kimliği de taslakta (yanıt kaybolsa da tekrar = aynı kayıt); müşteri ad/tel ORTAK tablete yazılmaz
    const { mAd, mTel, ...fGuvenli } = f;   // eslint-disable-line no-unused-vars
    try { localStorage.setItem(tKey(modal), JSON.stringify({ adet, sebep, sayim, f: fGuvenli, istek })); } catch { /* yok say */ }
  }, [modal, adet, sebep, sayim, f, istek]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 🔁 KUYRUK (D6): internet yoksa gönderim tablette bekler, gelince kendiliğinden gider (istek_id → ikinci kez yazılmaz)
  const qKey = `sp_kuyruk:${subeId}`;
  const kuyrukOku = () => { try { return JSON.parse(localStorage.getItem(qKey) || '[]'); } catch { return []; } };
  const kuyrukYaz = (q) => { try { localStorage.setItem(qKey, JSON.stringify(q)); } catch { /* yok say */ } setKuyrukSay(q.length); };
  const gonderiyor = useRef(false);
  const kuyrukCikar = (id) => kuyrukYaz(kuyrukOku().filter((x) => x.govde.istek_id !== id));   // Codex: her seferinde TAZE okunur
  const kuyruguGonder = useCallback(async () => {
    if (gonderiyor.current) return;   // tek gönderici
    gonderiyor.current = true;
    try {
      const q = kuyrukOku();
      setKuyrukSay(q.length);
      for (const it of q) {
        try {
          await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/${it.yol}`, { method: 'POST', body: it.govde });
          kuyrukCikar(it.govde.istek_id);
        } catch (e) {
          if (e instanceof TypeError) break;               // hâlâ internet yok → kalsın
          if (!e?.status || e.status >= 500 || e.status === 429) break;   // sunucu geçici → kalsın (Codex: 5xx'te silinmez)
          kuyrukCikar(it.govde.istek_id);   // 4xx: sunucu reddi deneme defterine yazdı (açılış/kapanış dahil) → merkez Bekleyen işler'de görür
          setAnladim((o) => o || `Bekleyen kayıt gönderilemedi (${it.ad || it.yol}): ${e?.message || 'hata'} — merkeze iletildi`);
        }
      }
    } finally { gonderiyor.current = false; }
  }, [subeId]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    kuyruguGonder();
    const t = window.setInterval(kuyruguGonder, 20000);
    window.addEventListener('online', kuyruguGonder);
    return () => { window.clearInterval(t); window.removeEventListener('online', kuyruguGonder); };
  }, [kuyruguGonder]);

  const yukle = useCallback(() => api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/durum`)
    .then((x) => { setD(x); setHata(''); }).catch((e) => setHata(e?.message || 'Panel açılamadı')), [subeId]);
  const [kapiGecildi, setKapiGecildi] = useState(false);   // yalnız DENEME'de "QR'sız geç" (saklanmaz — her yüklemede kapı yine görünür)
  const [sihirbazElle, setSihirbazElle] = useState(false);
  const [denemeKapandi, setDenemeKapandi] = useState(false);
  const [sihirbazBasari, setSihirbazBasari] = useState(false);   // başarı ekranı 1,9 sn tam görünsün (açılış düşünce erken kapanmasın)   // yalnız DENEME: kapat / deneme açılışı sonrası tekrar açılmasın (saklanmaz)
  const iceride = (yok.girenler || []).some((g) => g.acik);
  const sihirbazAcik = sihirbazBasari || !!d && !d.acilis_var && !d.kapanis_var && !(d.kuru && denemeKapandi)
    && (sihirbazElle || iceride || (d.kuru && kapiGecildi));
  const sihirbazOnceki = useRef(false);
  useEffect(() => {
    if (d?.acilis_var && sihirbazOnceki.current) setSihirbazBasari(true);   // Codex: açık sihirbaz açılış gelince hemen kaybolmasın
    sihirbazOnceki.current = !!(sihirbazAcik && d && !d.acilis_var);   // yalnız geçişte bir kez (sonra false)
  });
  useEffect(() => { if (tabletVar) { try { window.navigator.storage?.persist?.(); } catch { /* yok */ } } }, [tabletVar]);   // bağ silinmesin
  const kapiAcik = !!d && yok.var && !d.acilis_var && !d.kapanis_var && !(d.kuru && kapiGecildi) && !(yok.girenler || []).some((g) => g.acik);
  useEffect(() => {   // eski panel: 15 sn (POLL_MS), sekme gizliyken durur, öne gelince hemen çeker; kapı / QR / devir beklerken 5 sn
    yukle();
    const t = window.setInterval(() => { if (!document.hidden) yukle(); }, kapiAcik || qrGorunur || devirBekliyor ? 5000 : 15000);
    const gor = () => { if (!document.hidden) yukle(); };
    document.addEventListener('visibilitychange', gor);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', gor); };
  }, [yukle, kapiAcik, qrGorunur, devirBekliyor]);
  const [saat, setSaat] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setSaat(new Date()), 10000); return () => window.clearInterval(t); }, []);
  const [molaQr, setMolaQr] = useState(false);
  const kokRef = useRef(null);

  const temizle = () => { setAdet({}); setSebep(''); setSayim({}); setF({}); setPin(''); setIstek(yeniIstek()); };
  const ac = (m) => {
    if (m === 'acilis') { setDenemeKapandi(false); setSihirbazElle(true); return; }
    if (m === 'ac') { setSekme('ac'); return; }   // Basamak 5: Ürün Aç eski panel gibi orta alanda SEKME
    temizle();
    const adaylar = (yok.girenler || []).filter((g) => g.acik).map((g) => g.personel_id);
    setKisi(adaylar.length === 1 ? adaylar[0] : '');
    setFormGun(d.gun);
    let t = null;
    try { t = m !== 'kapanis' ? JSON.parse(localStorage.getItem(tKey(m, d.gun)) || 'null') : null; } catch { t = null; }
    if (t) {
      const { mAd, mTel, ...fGuvenli } = t.f || {};   // eslint-disable-line no-unused-vars
      setAdet(t.adet || {}); setSebep(t.sebep || ''); setSayim(t.sayim || {}); setF(fGuvenli); if (t.istek) setIstek(t.istek);
    }
    setModal(m);
  };
  const gonder = async (yol, govde, sonra) => {
    if (mesgul) return;
    if (!kisi) { setAnladim('Önce "Kim yapıyor?" kısmından adını seç'); return; }
    if (!(yok.girenler || []).some((g) => g.acik && g.personel_id === kisi)) {   // Codex: pencere açıkken çıkış yapan kişi
      setKisi(''); setAnladim('Seçili kişi artık içeride görünmüyor — adını yeniden seç'); return;
    }
    const pinli = ['urun-ac', 'fire', 'ara-teslim'].includes(yol);
    if (pinli && !/^\d{4}$/.test(pin)) { setAnladim('4 haneli PIN\'ini gir'); return; }
    setMesgul(true);
    const body = { ...govde, istek_id: istek, istemci_gunu: formGun || d.gun, ...(pinli ? { pin } : {}) };
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/${yol}`, { method: 'POST', body });
      // devir (yoklama açıkken): sunucu "Devir hazır — X telefonundan 'Devrediyorum'…" der; olay yazılmaz, onaylar telefonda (D5)
      setMesaj({ tur: r.kuru ? 'deneme' : 'tamam', metin: r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : r.devir_id && r.mesaj ? r.mesaj : (r.tekrar ? 'Bu kayıt zaten alınmıştı' : 'Kaydedildi ✓') });
      taslakSil(modal); setModal(null); temizle(); sonra?.(); yukle();
    } catch (e) {
      if (e instanceof TypeError && pinli) {   // PIN tablete yazılmaz → PIN'li işlem kuyruğa girmez; form açık kalır
        setAnladim('İnternet yok — bağlantı gelince yeniden gönder (form duruyor)');
      } else if (e instanceof TypeError) {   // internet yok → kuyruğa (aynı istek_id: sonra ikinci kez yazılmaz)
        kuyrukYaz([...kuyrukOku(), { yol, govde: body, ad: modal }]);
        setMesaj({ tur: 'deneme', metin: 'İnternet yok — kayıt tablette bekliyor, bağlantı gelince kendiliğinden gönderilecek' });
        taslakSil(modal); setModal(null); temizle();
      } else {
        // Codex: devir formu sunucudakinden eskiyse (409) aynı kimlikle tekrar gönderim hep reddedilir → yeni kimlik + güncel durum
        if (e?.status === 409 && yol === 'devir') { setIstek(yeniIstek()); yukle(); }
        if (pinli && (e?.status === 403 || e?.status === 429)) setPin('');   // yanlış / kilitli PIN → kutu boşalır
        setAnladim(e?.message && e.message.length < 160 ? e.message : 'Kaydedilemedi — tekrar deneyin');
      }
    }
    setMesgul(false);
  };

  // Devri iptal: yalnız devreden henüz onaylamadıysa (hazir); onayladıysa form kilitli → merkez kapatır
  const devirIptal = async () => {
    if (mesgul) return;
    setMesgul(true);
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/devir-iptal`, { method: 'POST', body: {} });
      setMesaj({ tur: 'tamam', metin: r.mesaj || 'Devir iptal edildi' }); yukle();
    } catch (e) {
      setMesaj({ tur: 'hata', metin: e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'İptal edilemedi') });
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
  // sahip: PIN/kişi seçilen her yerde YALNIZ QR ile girmiş (şu an içeride) personel — tüm personel listesi yedeği YOK
  const kisiAdaylari = (yok.girenler || []).filter((g) => g.acik).map((g) => ({ id: g.personel_id, ad: g.ad }));
  // bileşen DEĞİL düz fonksiyon (odağı kaybetmesin) — "Kim yapıyor?" yalnız QR ile girmiş personel; PIN kendi basamağında eklenecek
  const kimSec = (baslik = 'Kim yapıyor?', pinIste = false) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <b>{baslik}</b>
      {kisiAdaylari.length === 0
        ? <div style={{ color: C.sari, fontWeight: 700 }}>İçeride kimse yok — önce telefonundan QR ile giriş yap.</div>
        : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 }}>
            {kisiAdaylari.map((p) => <button key={p.id} type="button" className={'sp-btn' + (kisi === p.id ? ' sp-ana' : '')} onClick={() => { setKisi(p.id); setPin(''); }}>{p.ad}</button>)}
          </div>}
      {kisi && !kisiAdaylari.some((p) => p.id === kisi) && <div style={{ color: C.sari, fontWeight: 700 }}>Seçili kişi çıkış yapmış — adını yeniden seç</div>}
      {pinIste && kisi && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}><b>🔑 PIN</b>
          <input className="sp-in" style={{ width: 140, textAlign: 'center', letterSpacing: 8 }} type="password" inputMode="numeric" data-pin="1"
            autoComplete="off" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" /></label>
      )}
    </div>
  );
  const kapali = !!d.kapanis_var;   // D7: kapanıştan sonra yalnız Ana / Depodan gelen / Sipariş takip

  const yakinda = (m) => setMesaj({ tur: 'deneme', metin: m });
  // Ürün Aç hatırlatma bandı (eski: 12:00–12:59 · 16:00–16:59 · 20:00–20:59, o gün ürün aç kaydı yoksa; 4 saat susturulur)
  const bandSaat = [12, 16, 20].includes(saat.getHours());
  const urunAcVar = d.bugun.some((o) => o.tur === 'urun_ac' && !o.iptal);
  let bandSus = 0;
  try { bandSus = Number(localStorage.getItem('sp_urunac_bant:' + subeId) || 0); } catch { bandSus = 0; }
  const urunBandi = d.acilis_var && !kapali && bandSaat && !urunAcVar && Date.now() > bandSus;
  const SOL = [
    { b: 'STOK İŞLEMLERİ' },
    { k: 'teslim', i: '📦', ad: 'Tedarikçiden Gelen — Teslim Al', yakinda: true },
    { k: 'depo', i: '🚚', ad: 'Depodan Gelen — Teslim Al', yakinda: true, acikKapali: true },
    { k: 'siparis', i: '🛒', ad: 'Sipariş Ver', yakinda: true },
    { k: 'siparisTakip', i: '📊', ad: 'Sipariş Takip', yakinda: true, acikKapali: true },
    { k: 'ac', i: '🔓', ad: 'Ürün Aç' },
    { k: 'fire', i: '🔥', ad: 'Fire Bildirimi' },
    ...(d.sube.depo ? [{ k: 'gonderilecek', i: '📤', ad: 'Gönderilecek siparişler', yakinda: true }] : []),
    { b: 'GÜN SONU' },
    { k: 'araTeslim', i: '💵', ad: 'Ara Teslim' },
    { k: 'devir', i: '🔄', ad: 'Kasa Devri' },
    { k: 'kapanis', i: '🌙', ad: 'Günü Kapat', kapanisKarti: true },
    { b: 'HIZLI ERİŞİM' },
    { k: 'xrapor', i: '📷', ad: 'X Raporu', yakinda: true },
    { k: 'geri', i: '🧠', ad: 'Operasyon Geri Bildirimi', yakinda: true },
    { k: 'puan', i: '⭐', ad: 'Puanım', yakinda: true },
  ];

  return (
    <div className="sp" ref={kokRef}>
      <style>{CSS}</style>
      {/* ÜST BAR (eski 52px): EVVEL · şube · tarih saat */}
      <div className="sp-ust">
        <span className="sp-logo">EVVEL</span>
        <b style={{ fontSize: 18, flex: 1, textAlign: 'center' }}>{d.sube.ad}</b>
        {d.kuru && <span style={{ background: 'rgba(245,158,11,.15)', color: C.sari, padding: '4px 10px', borderRadius: 8, fontWeight: 700, fontSize: 12 }}>DENEME — kaydedilmez · panel {new Date(d.panel_baslangic + 'T12:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })} sabahı açılır</span>}
        <span style={{ color: C.soluk, fontVariantNumeric: 'tabular-nums' }}>{saat.toLocaleDateString('tr-TR')} · {saat.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      {urunBandi && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'rgba(59,130,246,.12)', borderBottom: `1px solid ${C.cizgi}` }}>
          <span style={{ flex: 1, fontWeight: 700 }}>🔓 Bugün henüz Ürün Aç kaydı yok. Saat {String(saat.getHours()).padStart(2, '0')}:00 oldu — açtığın ürünleri kaydet.</span>
          <button className="sp-btn" style={{ minHeight: 40, padding: '4px 12px' }} onClick={() => { try { localStorage.setItem('sp_urunac_bant:' + subeId, String(Date.now() + 4 * 3600 * 1000)); } catch { /* yok */ } setSaat(new Date()); }}>Kapat</button>
        </div>
      )}
      {mesaj && (
        <div onClick={() => setMesaj(null)} style={{ margin: '10px 12px 0', padding: '12px 14px', borderRadius: 10, fontWeight: 700, cursor: 'pointer',
          background: mesaj.tur === 'hata' ? 'rgba(239,68,68,.15)' : mesaj.tur === 'deneme' ? 'rgba(245,158,11,.15)' : 'rgba(34,197,94,.15)',
          color: mesaj.tur === 'hata' ? C.kirmizi : mesaj.tur === 'deneme' ? C.sari : C.yesil }}>{mesaj.metin}</div>
      )}
      {kuyrukSay > 0 && <div className="sp-kart" style={{ margin: '10px 12px 0', color: C.sari, fontWeight: 700 }}>⏳ {kuyrukSay} kayıt internet bekliyor</div>}

      <div className="sp-govde">
        {/* SOL MENÜ — eski sıra ve başlıklar */}
        <div className="sp-sol-kolon">
          <button className={'sp-sol' + (sekme === 'ana' ? ' akt' : '')} onClick={() => setSekme('ana')}><span style={{ fontSize: 18, width: 24 }}>🏠</span>Ana Sayfa</button>
          {SOL.map((m, i) => (m.b ? <div key={i} className="sp-sol-baslik">{m.b}</div> : (
            <button key={m.k} className={'sp-sol' + (m.k === sekme ? ' akt' : '')} disabled={m.kapanisKarti ? kapali : kapali && !m.acikKapali && ['ac', 'fire', 'araTeslim', 'devir'].includes(m.k)} title={m.yakinda ? 'Kendi basamağında açılacak' : ''}
              onClick={() => (m.yakinda ? yakinda(`${m.ad} — kendi basamağında açılacak`) : ac(m.k))}>
              <span style={{ fontSize: 18, width: 24 }}>{m.i}</span><span style={{ flex: 1 }}>{m.ad}</span>{m.yakinda && <small style={{ opacity: 0.7 }}>yakında</small>}
              {m.k === 'ac' && acSecim > 0 && <span className="sp-rozet" style={{ background: C.sari }} title={`${acSecim} kalem seçili — PIN onayı bekleniyor`}>{acSecim}</span>}
            </button>
          )))}
        </div>

        {/* ORTA: ANA SAYFA */}
        {sekme === 'ac' ? (
          <UrunAc key={d.gun} d={d} subeId={subeId} adaylar={kisiAdaylari} kapali={kapali} secimBildir={setAcSecim}
            bitti={(metin, kuru) => { setMesaj({ tur: kuru ? 'deneme' : 'tamam', metin }); yukle(); }} />
        ) : (
          <AnaSayfa d={d} yok={yok} tabletVar={tabletVar} kapali={kapali} ac={ac} setQrBuyuk={setQrBuyuk} setMolaQr={setMolaQr} bilgi={yakinda} />
        )}

        {/* SAĞ: GÜN SONU kartları (eski: 💵 Kasa Devri · 🌙 Günü Kapat, durum çipleriyle) */}
        <div className="sp-sag-kolon" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <button className="sp-kart" disabled={kapali} onClick={() => ac('devir')} style={{ textAlign: 'left', cursor: kapali ? 'default' : 'pointer', minHeight: 78, opacity: kapali ? 0.6 : 1, color: C.yazi, font: 'inherit', display: 'grid', gap: 4 }}>
            <b style={{ fontSize: 16 }}>💵 Kasa Devri</b><span style={{ color: C.soluk, fontSize: 12 }}>Vardiya nakit teslim & devir</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: devirEtiket(devir).renk }}>{devirEtiket(devir).metin}</span>
          </button>
          <button className="sp-kart" disabled={d.kapanis_var} onClick={() => ac('kapanis')} style={{ textAlign: 'left', cursor: d.kapanis_var ? 'default' : 'pointer', minHeight: 78, opacity: d.kapanis_var ? 0.6 : 1, color: C.yazi, font: 'inherit', display: 'grid', gap: 4,
            background: 'linear-gradient(135deg,rgba(76,29,149,.5),rgba(124,58,237,.35))' }}>
            <b style={{ fontSize: 16 }}>🌙 Günü Kapat</b><span style={{ color: C.soluk, fontSize: 12 }}>Ciro, stok & kapanış protokolü</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: d.kapanis_var ? C.yesil : C.soluk }}>{d.kapanis_var ? '🔒 Mühürlendi' : '● 5 adım'}</span>
          </button>
        </div>
      </div>

      {/* ALT BAR (eski 58px): Ana · Gider · Not · Mesaj */}
      <div className="sp-alt">
        <button onClick={() => setSekme('ana')} style={sekme === 'ana' ? { color: C.mavi } : undefined}><span style={{ fontSize: 20, display: 'block' }}>🏠</span><span style={{ fontSize: 11 }}>Ana</span></button>
        <button onClick={() => yakinda('Anlık gider ekranı kendi basamağında açılacak')}><span style={{ fontSize: 20, display: 'block' }}>💸</span><span style={{ fontSize: 11 }}>Gider</span></button>
        <button onClick={() => yakinda('Merkez notu ekranı kendi basamağında açılacak')}><span style={{ fontSize: 20, display: 'block' }}>📝</span><span style={{ fontSize: 11 }}>Not</span></button>
        <button onClick={() => yakinda('Mesajlar kendi basamağında açılacak')}><span style={{ fontSize: 20, display: 'block' }}>📩</span><span style={{ fontSize: 11 }}>Mesaj</span></button>
      </div>

      {/* 🔑 AÇILIŞ ÖNCESİ KAPI (eski §1a "Personel Girişi Gerekli" — eski QR + kasa kilidi PIN'i KALKTI, yerine yeni dönen QR) */}
      {kapiAcik && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(5,8,15,.96)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="sp-kart" style={{ maxWidth: 520, width: '100%', display: 'grid', justifyItems: 'center', gap: 14, textAlign: 'center' }}>
            {tabletVar ? (<>
              <div style={{ fontSize: 40 }}>📱</div>
              <b style={{ fontSize: 22 }}>Personel Girişi Gerekli</b>
              <div style={{ color: C.soluk }}>Kasa açılışından önce bir personelin bu QR'ı kendi telefonuyla okutması gerekiyor. Personel okutunca bu ekran kendiliğinden geçer.</div>
              <TabletQR boyut={Math.min(320, Math.max(220, (window.innerWidth || 600) - 120))} />
              <span style={{ color: C.soluk }}>⏳ Bekleniyor… · QR 60 saniyede bir değişir</span>
            </>) : (<>
              <div style={{ fontSize: 40 }}>🖥️</div>
              <b style={{ fontSize: 22 }}>Bu bilgisayar kayıtlı değil</b>
              {yok.tablet_kayitli ? (
                <div style={{ color: C.soluk, display: 'grid', gap: 8, textAlign: 'left' }}>
                  <div style={{ color: C.sari, fontWeight: 700 }}>Bu şubenin bağlı bir panel bilgisayarı VAR — ama bu tarayıcı onu tanımıyor.</div>
                  <div>Bağlantı bir kez yapılır ve <b>bağlandığı tarayıcıda</b> durur. Kontrol et:</div>
                  <div>• Dün bağladığın <b>aynı tarayıcı</b> mı (Chrome / Edge)? Aynı kullanıcı profili mi?</div>
                  <div>• <b>Gizli pencere</b> değil mi? (gizli pencere kapanınca bağlantıyı unutur)</div>
                  <div>• Adres aynı mı: <b>{window.location.host}</b></div>
                  <div>• Tarayıcıda "kapatınca verileri temizle" açık mı?</div>
                  <div>Hiçbiri değilse merkez yeni bağlantı linki üretsin (eskisi kendiliğinden geçersiz olur).</div>
                </div>
              ) : (
                <div style={{ color: C.soluk }}>QR bu bilgisayarda çıkmıyor. Merkez Personel › Telefonlar'dan bu şube için bağlantı linki üretsin; link BU tarayıcıda açılınca QR gelir.</div>
              )}
            </>)}
            {d.kuru && <button className="sp-btn" style={{ width: '100%' }} onClick={() => setKapiGecildi(true)}>Deneme: QR'sız geç</button>}
          </div>
        </div>
      )}

      {tabletVar && yok.var && !qrBuyuk && !kapiAcik && (
        <div style={{ position: 'fixed', right: 12, bottom: 70, zIndex: 40, padding: 6, borderRadius: 14, background: C.bg1, border: `1px solid ${C.cizgi}` }}>
          <TabletQR boyut={110} onClick={() => setQrBuyuk(true)} />
        </div>
      )}
      {(qrBuyuk || molaQr) && (
        <Modal baslik={molaQr ? '🍽️ Yemek Molası' : '📱 Giriş / çıkış QR'} kapat={() => { setQrBuyuk(false); setMolaQr(false); }}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}>
            {tabletVar ? <TabletQR boyut={Math.min(420, Math.max(240, (window.innerWidth || 600) - 80))} /> : <b>Bu bilgisayar kayıtlı değil — merkezden bağlantı iste</b>}
            <span style={{ color: C.soluk }}>{molaQr ? 'Telefonundan okut → "Yemek molası başlat" ya da "Molayı bitir". Konum doğrulamalı — şube dışından mola açılamaz.' : 'Telefonundan okut — 60 saniyede bir değişir'}</span>
          </div>
        </Modal>
      )}
      <SayiTusTakimi kapsam={kokRef} />
      {anladim && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div className="sp-kart" style={{ maxWidth: 520, display: 'grid', gap: 16, textAlign: 'center', borderColor: C.kirmizi }}>
            <div style={{ fontSize: 44 }}>⛔</div>
            <b style={{ fontSize: 22 }}>{anladim}</b>
            <div style={{ color: C.soluk }}>Bu işlem kaydedilmedi.</div>
            <button className="sp-btn sp-ana" onClick={() => setAnladim(null)}>ANLADIM</button>
          </div>
        </div>
      )}
      {/* ── MODALLAR ── */}
      {sihirbazAcik && (sihirbazBasari || !kapiAcik) && (
        <AcilisSihirbazi key={d.gun} d={d} subeId={subeId} tabletVar={tabletVar} kapatilabilir={!!d.kuru}
          kapat={() => { setSihirbazElle(false); setDenemeKapandi(true); }}
          basladi={() => setSihirbazBasari(true)}
          bitti={async () => { setSihirbazElle(false); if (d.kuru) setDenemeKapandi(true); await yukle(); setSihirbazBasari(false); }} />
      )}
      {(modal === 'ac' || modal === 'fire') && (
        <Modal baslik={modal === 'ac' ? '📦 Ürün Aç' : '🗑️ Fire'} kapat={() => setModal(null)} genis>
          {kimSec('Kim yapıyor?', true)}
          {modal === 'fire' && (<>
            <b>1 · Sebep</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 8 }}>
              {d.fire_sebepleri.map((x) => <button key={x.kod} className={'sp-btn' + (sebep === x.kod ? ' sp-ana' : '')} onClick={() => setSebep(x.kod)}>{x.ad}</button>)}
            </div>
            {sebep === 'diger' && <input className="sp-in" style={{ fontSize: 18 }} value={f.aciklama || ''} onChange={(e) => setF({ ...f, aciklama: e.target.value })} placeholder="Sebebi yaz" />}
            {sebep === 'iade' && (
              <div className="sp-kart" style={{ display: 'grid', gap: 8 }}>
                <b>Müşteri iadesi</b>
                <label style={{ display: 'grid', gap: 4 }}>Fiş numarası (zorunlu)<input className="sp-in" value={f.fis || ''} onChange={(e) => setF({ ...f, fis: e.target.value })} /></label>
                <label style={{ display: 'grid', gap: 4 }}>İade saati (zorunlu)<input className="sp-in" type="time" value={f.iadeSaat || ''} onChange={(e) => setF({ ...f, iadeSaat: e.target.value })} /></label>
                <label style={{ display: 'grid', gap: 4 }}>Müşteri adı (isteğe bağlı)<input className="sp-in" style={{ fontSize: 18 }} value={f.mAd || ''} onChange={(e) => setF({ ...f, mAd: e.target.value })} /></label>
                <label style={{ display: 'grid', gap: 4 }}>Müşteri telefonu (isteğe bağlı)<input className="sp-in" inputMode="tel" value={f.mTel || ''} onChange={(e) => setF({ ...f, mTel: e.target.value.replace(/[^\d+ ]/g, '') })} /></label>
              </div>
            )}
            <b>2 · Ürünler</b>
          </>)}
          <AdetListesi gruplar={modal === 'ac' ? d.acilan : tumUrunler} adet={adet} setAdet={setAdet} />
          <button className="sp-btn sp-yesil"
            disabled={mesgul || !kalemGovde(adet).length || (modal === 'fire' && (!sebep || (sebep === 'diger' && (f.aciklama || '').trim().length < 2) || (sebep === 'iade' && (!(f.fis || '').trim() || !f.iadeSaat))))}
            onClick={() => gonder(modal === 'ac' ? 'urun-ac' : 'fire', { personel_id: kisi, kalemler: kalemGovde(adet),
              ...(modal === 'fire' ? { sebep, aciklama: f.aciklama || null,
                iade: sebep === 'iade' ? { fis_no: f.fis, iade_saat: f.iadeSaat, musteri_ad: f.mAd || null, musteri_tel: f.mTel || null } : null } : {}) })}>
            ✔ {modal === 'ac' ? 'Açtıklarımı Kaydet' : 'Fireyi Kaydet'} ({kalemGovde(adet).reduce((a, x) => a + x.adet, 0)})</button>
        </Modal>
      )}
      {modal === 'araTeslim' && (
        <Modal baslik="💵 Ara Teslim" kapat={() => setModal(null)}>
          {kimSec('Teslim eden', true)}
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
        <KasaDevri devir={devir} tabletVar={tabletVar} kapali={kapali} kapat={() => setModal(null)} yukle={yukle} iptal={devirIptal} mesgulDis={mesgul} />
      )}
      {modal === 'kapanis' && (
        <Kapanis d={d} kimSec={kimSec} mesgul={mesgul} sayim={sayim} setSayim={setSayim} kapat={() => setModal(null)} taslakAnahtar={tKey('kapanis')}
          istek={istek} setIstek={setIstek}
          gonder={(govde) => gonder('kapanis', { personel_id: kisi, ...govde, sayim: sayimGovde(sayim) })} />
      )}
    </div>
  );
}

// 🌙 Kapanış — 4 adım (eski 5 adım: ürün aç sorusu kalktı, QR mühür/saat kilidi merkeze)
function Kapanis({ d, kimSec, mesgul, sayim, setSayim, kapat, gonder, taslakAnahtar, istek, setIstek }) {
  const ilk = (() => { try { return JSON.parse(localStorage.getItem(taslakAnahtar) || 'null'); } catch { return null; } })();
  const [adim, setAdim] = useState(ilk?.adim || 1);
  const [v, setV] = useState(ilk?.v || { nakit: '', pos: '', online: '', kor: '', birakilan: '', deg: {}, teslim: {}, pasta: '' });
  useEffect(() => { if (ilk?.sayim) setSayim(ilk.sayim); if (ilk?.istek) setIstek(ilk.istek); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // 💾 her tuşta tablete (D6) — istek kimliği dahil; gönderim başarılı olunca silinir
    try { localStorage.setItem(taslakAnahtar, JSON.stringify({ adim, v, sayim, istek })); } catch { /* yok say */ }
  }, [adim, v, sayim, istek, taslakAnahtar]);
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
        {kimSec('Kapanışı yapan')}
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
        <div><b>Ürün sayımı</b> <span style={{ color: C.soluk }}>— bardak, su, süt, Redbull, soda, cookie</span></div>
        <SayimListesi gruplar={d.sayilan} sayim={sayim} setSayim={setSayim} />
        <label className="sp-kart" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}>
          <span style={{ flex: 1 }}><b>🍰 Pasta</b><div style={{ color: C.soluk, fontSize: 13 }}>toplam kaç adet?</div></span>
          <input className="sp-in" style={{ width: 110, textAlign: 'center' }} inputMode="numeric" value={v.pasta} onChange={(e) => set('pasta', sayi(e.target.value))} /></label>
        <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" onClick={() => setAdim(2)}>← Geri</button>
          <button className="sp-btn sp-ana" style={{ flex: 1 }} onClick={() => setAdim(4)}>Özete Geç →</button></div>
      </>)}
      {adim === 4 && (<>
        {kimSec('Kapanışı yapan')}
        <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
          <div>Nakit: <b>{tl(tutarNum(v.nakit))}</b> · POS: <b>{tl(tutarNum(v.pos))}</b> · Online: <b>{tl(tutarNum(v.online))}</b></div>
          <div>Kasada sayılan: <b>{tl(tutarNum(v.kor))}</b> · Bırakılan: <b>{tl(tutarNum(v.birakilan))}</b></div>
          <div>Teslim: {teslimler.length ? teslimler.map((t) => `${t.alan.split(':')[1]} ${tl(t.tutar)}`).join(' · ') : '—'}</div>
          <div>Sayılan ürün: <b>{Object.values(sayim).filter((x) => x !== '').length}</b> · Pasta: <b>{v.pasta === '' ? '—' : v.pasta}</b></div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" onClick={() => setAdim(3)}>← Geri</button>
          <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={mesgul}
            onClick={() => gonder({ nakit: tutarNum(v.nakit), pos: tutarNum(v.pos), online: tutarNum(v.online), teslimler,
              kor_sayim: v.kor === '' ? null : tutarNum(v.kor), birakilan: v.birakilan === '' ? null : tutarNum(v.birakilan),
              degirmen: Object.values(v.deg).some((x) => x !== '') ? v.deg : null,
              pasta_toplam: v.pasta === '' ? null : Number(v.pasta) })}>✔ Kapanışı Gönder</button></div>
      </>)}
    </Modal>
  );
}
