// 📱 TELEFON SAYFASI — Evvel Yeni yoklama (YOKLAMA_QR_TASARIM.md §A2; sunucu: evvel_yeni_yoklama_api.py)
// Adresler: /q/bagla/{davet} (merkezin linki → bu telefon kişinin olur) · /q/{sube}/{jeton} (paneldeki QR okutunca: tek büyük düğme
// GİRİŞ / YEMEK MOLASI BAŞLAT / MOLAYI BİTİR + sade ÇIKIŞ; K7 hak düştüyse tek bilgi satırı) · /q (salt durum). Menüsüz tam ekran, AÇIK TuliPi teması (design_qr_personel_marka). PIN yok; uyarı personele gitmez —
// yalnız işlemin sonucu tek cümle. Düğmeler ≥ 56px. Ağ düşerse AYNI istek_id ile "Tekrar dene" (sunucu ikinci kez yazmaz).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import tulipiLogo from '../../assets/tulipi-logo.jpg';
import { cihazBagla, cihazId, imzaliJson, yeniIstekId } from '../../utils/cihazImza';
import { paraGecerli, sayiTR, tlYaz } from '../../utils/trSayi';
import { kalemYazi } from '../../utils/devirOzet';

const T = { zemin: '#F4EFE9', kart: '#FFFFFF', kenar: '#E6DED4', yuzey: '#F7F2EC', metin: '#2A241E', metin2: '#6B5E50', silik: '#9C8E7E',
  aksan: '#C8956A', aksanKoyu: '#94592C', silikOkunur: '#6E6152', yesil: '#25794F', kirmizi: '#C03A2B', golge: '0 8px 30px rgba(120,90,60,.10)' };
const CSS = `
.tq,.tq *{box-sizing:border-box} .tq{min-height:100vh;background:${T.zemin};color:${T.metin};font-family:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.4;padding:16px;display:flex;flex-direction:column;gap:14px;max-width:520px;margin:0 auto}
.tq-kart{background:${T.kart};border:1px solid ${T.kenar};border-radius:16px;padding:16px;box-shadow:${T.golge};display:grid;gap:10px}
.tq-btn{min-height:64px;width:100%;border-radius:14px;border:1px solid ${T.kenar};background:${T.yuzey};color:${T.metin};font:inherit;font-size:20px;font-weight:800;cursor:pointer;padding:12px 16px}
.tq-btn:disabled{opacity:.45;cursor:default} .tq-ana{background:${T.aksanKoyu};border-color:${T.aksanKoyu};color:#fff} .tq-yesil{background:${T.yesil};border-color:${T.yesil};color:#fff}
.tq-kucuk{min-height:56px;font-size:17px;font-weight:700}
.tq-not{color:${T.metin2};font-size:14px} .tq-silik{color:${T.silikOkunur};font-size:13px}
`;

// 🗨️ SOR — telefonda sayfa içi soru (K-1 · 26 Eki · L4b Opus A + Fable A / Codex B → A): window.confirm telefonda/simde görünmüyordu.
// Merkez (KasaModulu) ve panel (subepanel/ortak) sor() ile AYNI sözleşme: sor({ soru, alt, tamam, iptal }) → true|false.
let sorDinle = null;
function sor(o) {
  return new Promise((coz) => {
    if (!sorDinle) { coz(window.confirm(o.soru)); return; }   // eslint-disable-line no-alert
    sorDinle({ ...o, coz });
  });
}
function SorKatmani() {
  const [s, setS] = useState(null);
  useEffect(() => {
    sorDinle = (o) => setS((onceki) => { if (onceki) onceki.coz(false); return { ...o, cozuldu: false }; });
    return () => { sorDinle = null; };
  }, []);
  const bitir = (v) => { if (!s || s.cozuldu) return; s.cozuldu = true; setS(null); s.coz(v); };
  useEffect(() => {   // panel penceresiyle aynı koruma (Codex denetimi): Esc = Vazgeç · Enter onaylamaz
    if (!s) return undefined;
    const tus = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); bitir(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', tus, true);
    return () => window.removeEventListener('keydown', tus, true);
  });
  if (!s) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={s.soru} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(42,36,30,.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 12 }}>
      <div className="tq-kart" style={{ width: 'min(480px,100%)' }}>
        <b style={{ fontSize: 19, lineHeight: 1.35 }}>{s.soru}</b>
        {s.alt && <div className="tq-not">{s.alt}</div>}
        <button type="button" className="tq-btn tq-ana" onClick={() => bitir(true)}>{s.tamam || 'Evet'}</button>
        <button type="button" className="tq-btn tq-kucuk" onClick={() => bitir(false)}>{s.iptal || 'Vazgeç'}</button>
      </div>
    </div>
  );
}

function Marka({ alt }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 10px rgba(200,149,106,0.25)' }}>
        <img src={tulipiLogo} alt="TuliPi Coffee" style={{ width: 40, height: 40, objectFit: 'contain' }} />
      </div>
      <div><div style={{ fontWeight: 800, fontSize: 18 }}>TuliPi Coffee</div><div className="tq-silik">{alt}</div></div>
    </div>
  );
}

const gunYazi = (g) => { try { return new Date(`${g}T12:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }); } catch { return g || ''; } };
const saatSimdi = () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
const etiketim = () => { try { return (navigator.userAgentData?.platform || navigator.platform || '').slice(0, 40); } catch { return ''; } };

// ── Ortak küçük yardımcılar (Dalga 5, F#60/F#61: adres parametresi 3 kopya, konum satırı 2 kopya, ağ hatası mesajı 6 kopya) ──
const urlKimlik = (ad) => {   // ?o= / ?tb= / ?dv= — yalnız güvenli kimlik
  try { const v = new window.URLSearchParams(window.location.search).get(ad) || ''; return /^[A-Za-z0-9-]{1,40}$/.test(v) ? v : ''; } catch { return ''; }
};
const agMesaji = (e, varsayilan) => (e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || varsayilan));
function KonumSatiri({ muaf, konum, konumAl }) {
  return (<>
    {muaf ? '' : konum.durum === 'ok' ? 'konum ✓' : konum.durum === 'bekliyor' ? 'konum alınıyor…' : konum.hata}
    {!muaf && konum.durum === 'hata' && <> · <button type="button" onClick={konumAl} style={{ font: 'inherit', color: T.aksanKoyu, background: 'none', border: 'none', padding: '0 6px', fontWeight: 700, minHeight: 48, minWidth: 48 }}>tekrar dene</button></>}
  </>);
}

// ── Konum: sayfa açılınca bir kez, 10 sn zaman aşımı; muaf kişide hata engel değil — sunucu karar verir (konum yine gönderilir) ──
// 📍 KONUM — tek kural (F1.2 · sim 26 Eki · L4b Opus + Fable + Codex C): sunucu 'konum_gerekli' söyler (konum_kontrol ile aynı yardımcı).
// Gerekiyorsa konum gelmeden düğme açılmaz ve büyük kart çıkar (bas → bekle → 403 döngüsü yok); gerekmiyorsa (muaf / koordinatsız
// şube) beklemeden açılır. Son söz yine sunucuda — ret QR'ı harcamaz. Alan yoksa (eski sunucu) önceki davranış.
const konumHazirMi = (ben, konum) => (ben?.konum_gerekli === undefined ? (konum.durum !== 'bekliyor' || !!ben?.muaf) : (!ben.konum_gerekli || konum.durum === 'ok'));
const konumYok = (ben) => !!ben?.muaf || ben?.konum_gerekli === false;   // konum hiç gerekmiyorsa satır da yok (Tema'da "izin gerekli" yanıltıyordu)
const konumRet = (metin) => /^Konum (izni gerekli|alınamadı)/.test(metin || '');
const konumKartiVar = (ben, konum, hataMetin) => !!ben?.konum_gerekli && konum.durum !== 'ok' && (konum.durum === 'hata' || konumRet(hataMetin));
function KonumKarti({ konum, konumAl }) {
  const izin = konum.hata === 'Konum izni gerekli' || konum.durum !== 'hata';
  return (
    <div style={{ background: '#FFF1EC', border: `2px solid ${T.kirmizi}`, borderRadius: 14, padding: 14, display: 'grid', gap: 10 }}>
      <b style={{ fontSize: 20 }}>📍 {izin ? 'Konum izni kapalı' : 'Konum alınamadı'}</b>
      <div className="tq-not">{izin ? 'Bu işlem için telefonun konumu gerekiyor. Tarayıcının site ayarlarından bu sayfaya konum izni ver, sonra Tekrar dene.'
        : 'Telefonun konumu açık mı? Açıksa kapıya / pencereye birkaç adım yaklaş, sonra Tekrar dene.'}</div>
      <button type="button" className="tq-btn tq-ana" onClick={konumAl}>📍 Tekrar dene</button>
      <div className="tq-silik">Konum gelince aşağıdaki düğmeler açılır.</div>
    </div>
  );
}
function useKonum(aktif) {
  const [k, setK] = useState({ durum: 'bekliyor', lat: null, lng: null, hata: '' });
  const al = useCallback(() => {
    if (!navigator.geolocation) { setK({ durum: 'hata', lat: null, lng: null, hata: 'Bu telefonda konum yok' }); return; }
    setK((o) => ({ ...o, durum: 'bekliyor', hata: '' }));
    navigator.geolocation.getCurrentPosition(
      (p) => setK({ durum: 'ok', lat: p.coords.latitude, lng: p.coords.longitude, hata: '' }),
      (e) => setK({ durum: 'hata', lat: null, lng: null, hata: e && e.code === 1 ? 'Konum izni gerekli' : 'Konum alınamadı' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }, []);
  useEffect(() => { if (aktif) al(); }, [aktif, al]);
  return [k, al];
}

// B31: saatten sonra Türkçe ayrılma eki — '13:20'den', '12:30'dan', '14:00'ten' (son okunan sayıya göre)
const SAAT_EK = { 0: "'dan", 1: "'den", 2: "'den", 3: "'ten", 4: "'ten", 5: "'ten", 6: "'dan", 7: "'den", 8: "'den", 9: "'dan" };
const ONLUK_EK = { 1: "'dan", 2: "'den", 3: "'dan", 4: "'tan", 5: "'den" };
function saatEki(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  if (Number.isNaN(h)) return "'den";
  const n = m ? m : h;
  if (n % 10) return SAAT_EK[n % 10];
  return n === 0 ? "'dan" : n === 10 ? "'dan" : n === 20 ? "'den" : ONLUK_EK[n / 10] || "'den";
}

export default function TelefonSayfasi({ mod, davet, sube, jeton }) {
  useEffect(() => {
    document.title = 'TuliPi · Personel';
    // Fable T1: başlık yazı tipi (Fraunces) + gövde (Instrument Sans) + "Ana ekrana ekle" (PWA) — yalnız telefon sayfasında
    const ekle = (tag, at) => { if (document.head.querySelector(`${tag}[data-tq="${at['data-tq']}"]`)) return; const el = document.createElement(tag); Object.entries(at).forEach(([k, v]) => el.setAttribute(k, v)); document.head.appendChild(el); };
    ekle('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Instrument+Sans:wght@400;600;700;800&display=swap', 'data-tq': 'font' });
    ekle('link', { rel: 'manifest', href: '/q-manifest.webmanifest', 'data-tq': 'manifest' });
    ekle('link', { rel: 'apple-touch-icon', href: '/q-ikon-192.png', 'data-tq': 'apple' });
    ekle('meta', { name: 'theme-color', content: '#F4EFE9', 'data-tq': 'tema' });
  }, []);
  return (
    <div className="tq">
      <style>{CSS}</style>
      <SorKatmani />
      {mod === 'bagla' && <Bagla davet={davet} />}
      {mod === 'qr' && (onayKimligi() ? <OnayIslem sube={sube} jeton={jeton} onay={onayKimligi()} />
        : devirKimligi() ? <DevirIslem sube={sube} jeton={jeton} did={devirKimligi()} />
        : teslimKimligi() ? <FaturaCek sube={sube} tid={teslimKimligi()} /> : <QrIslem sube={sube} jeton={jeton} />)}
      {mod === 'durum' && <Ev />}
    </div>
  );
}

// ── /q/bagla/{davet}: merkezin tek kullanımlık linki (K1, K9 uzaktan olur) ──
function Bagla({ davet }) {
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [hata, setHata] = useState('');
  const varTel = cihazId('telefon');
  const bagla = async () => {
    setMesgul(true); setHata('');
    try { setSonuc(await cihazBagla(davet, etiketim())); }
    catch (e) { setHata(agMesaji(e, 'Bağlanamadı')); }
    setMesgul(false);
  };
  return (
    <>
      <Marka alt={sonuc?.tur === 'tablet' ? 'Şube bilgisayarını bağla' : sonuc ? 'Telefonu bağla' : 'Cihazı bağla'} />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 56 }}>{sonuc.durum === 'aktif' ? '✓' : '⏳'}</div>
          <b style={{ fontSize: 20 }}>{sonuc.mesaj}</b>
          {sonuc.guc === 'jeton' && <div className="tq-silik">Bu tarayıcı güçlü anahtar üretemedi; bağ zayıf (merkez görür).</div>}
          {sonuc.tur === 'telefon' && <div className="tq-not">Artık giriş / çıkış için şubedeki panel bilgisayarının ekranındaki QR'ı okutman yeterli.</div>}
          {sonuc.tur === 'tablet' && <div className="tq-not">Merkez onaylayınca şube paneli köşede QR göstermeye başlar. Paneli hep BU tarayıcıda (normal pencerede) aç.</div>}
          {sonuc.tur === 'tablet' && sonuc.sube_id && (
            <a className="tq-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
               href={`/panel/${encodeURIComponent(sonuc.sube_id)}`}>🧾 Şube panelini aç</a>
          )}
          {sonuc.tur === 'telefon' && <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">✓ Tamam</a>}
        </div>
      ) : (
        <div className="tq-kart">
          <b style={{ fontSize: 19 }}>Bu cihaz bağlanacak</b>
          <div className="tq-not">Merkezin gönderdiği bağlantı tek kullanımlık. Kişisel telefon bağlantısıysa bu telefon senin adına giriş / çıkış yapar; şube bilgisayarı bağlantısıysa şube paneli QR gösterir — şifre, PIN yok.</div>
          {varTel && <div className="tq-silik">Bu tarayıcıda zaten bağlı bir telefon kaydı var; yeniden bağlarsan eski bağ bu telefonda biter.</div>}
          {hata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="tq-btn tq-ana" disabled={mesgul} onClick={bagla}>{mesgul ? 'Bağlanıyor…' : '📱 BU CİHAZI BAĞLA'}</button>
          <div className="tq-silik">iPhone: bu linki Safari'de aç ve burada bağla. Ana ekrana eklerken <b>"Web Uygulaması olarak aç" seçeneğini KAPAT</b> — açık kalırsa simge ayrı bir kap olur, bağı görmez ("tanımlı değil" der).</div>
        </div>
      )}
    </>
  );
}

// ── /q/{sube}/{jeton}: QR okutuldu → /ben + konum → tek büyük düğme ──
function QrIslem({ sube, jeton }) {
  const bagli = !!cihazId('telefon');
  const [ben, setBen] = useState(null);
  const [hata, setHata] = useState('');
  const [konum, konumAl] = useKonum(bagli);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [isHata, setIsHata] = useState(null);     // { metin, tekrar }
  const istek = useRef({});                      // işlem → istek_id (giriş / çıkış / mola / devret / kabul ayrı); tekrar denemede AYNI
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}&qr=${encodeURIComponent(jeton || '')}`)
      .then(setBen).catch((e) => setHata(agMesaji(e, 'Okunamadı')));
  }, [bagli, sube, jeton]);
  useEffect(() => { yukle(); }, [yukle]);

  const qrOk = ben?.qr_gecerli !== false;   // Fable #7: süresi dolan QR'da yanlış düğme ('GİRİŞ YAP') gösterilmez
  const yapabilir = qrOk ? (ben?.yapabilir || []) : [];
  // Büyük düğme: giriş → mola başlat / molayı bitir; ÇIKIŞ ikinci, sade düğme (§A2 "Girdi" satırı)
  const ana = yapabilir.includes('giris') ? 'giris' : yapabilir.includes('mola_bitir') ? 'mola-bitir' : yapabilir.includes('mola_baslat') ? 'mola-baslat' : null;
  const cikisVar = yapabilir.includes('cikis');
  // M-1 (F1.7 · sim 25 Eki): 45 dk dolmadan "Molayı bitir" basılabilir görünüyordu (sunucu reddediyor) → soluk + "HH:MM'de açılır"
  const [anMs, setAnMs] = useState(() => Date.now());
  const benAn = useRef(Date.now());
  useEffect(() => { benAn.current = Date.now(); setAnMs(Date.now()); }, [ben]);
  useEffect(() => {
    if (ana !== 'mola-bitir') return undefined;
    const t = window.setInterval(() => setAnMs(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, [ana]);
  const molaAz = ben?.mola?.en_az_dk || ben?.mola_en_az_dk || 45;
  const molaErken = ana === 'mola-bitir' && ben?.mola?.durum === 'suruyor' && (ben.mola.sure_dk + Math.floor((anMs - benAn.current) / 60000)) < molaAz;
  const molaAcilis = (() => {
    const [h, m] = String(ben?.mola?.bas || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
    const t = h * 60 + m + molaAz;
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  })();

  if (!bagli) return <TanimliDegil />;   // Fable: kancalar erken dönüşün ÜSTÜNDE (rules-of-hooks)
  // 💵 Kasa devri v2 (sahip 23 Eki): devir açıkken şube QR'ı → devir sayfasına davet (KÖR, rakam yok). Kasa sahibi "devret",
  // diğeri "kasayı devral" — devralanın vardiyası devirle başlar (ayrı giriş gerekmez; giriş ikinci, küçük düğme)
  const devir = ben?.devir || null;
  const devirVar = !!devir?.dv && qrOk;
  const islemVar = !!ana || cikisVar || devirVar;
  const konumHazir = konumHazirMi(ben, konum);
  const konumKarti = konumKartiVar(ben, konum, isHata?.metin);
  // islem: giris | cikis | mola-baslat | mola-bitir (devir v2 kendi sayfasında — ?dv=)
  const yap = async (islem) => {
    if (!islem || mesgul) return;
    if (!istek.current[islem]) istek.current[islem] = yeniIstekId();   // her işlemin KENDİ istek_id'si; tekrar denemede aynı
    setMesgul(true); setIsHata(null);
    try {
      const r = await imzaliJson('telefon', 'POST', `/api/evvel-yeni/yoklama/${islem}`,
        { sube, qr: jeton, lat: konum.lat, lng: konum.lng, istek_id: istek.current[islem] });
      const eskiSaat = islem === 'giris' ? ben.giris : islem === 'cikis' ? ben.cikis : islem === 'mola-baslat' ? ben.mola?.bas : islem === 'mola-bitir' ? ben.mola?.bit : null;
      setSonuc({ islem, mesaj: r.mesaj, hak_dustu: !!r.hak_dustu, saat: (r.mesaj || '').match(/\d{2}:\d{2}/)?.[0] || (r.tekrar && eskiSaat) || saatSimdi(), tekrar: !!r.tekrar });
    } catch (e) {
      if (e instanceof TypeError) setIsHata({ islem, metin: 'İnternet yok — bağlantı gelince tekrar dene', tekrar: true });
      else setIsHata({ islem, metin: e?.message || 'Kaydedilemedi', tekrar: e?.status >= 500 || e?.status === 429 });
    }
    setMesgul(false);
  };
  const baslik = { giris: 'Giriş', cikis: 'Çıkış', 'mola-baslat': 'Mola başladı', 'mola-bitir': 'Mola bitti' };
  const etiket = { giris: '✅ GİRİŞ YAP', cikis: '🚪 ÇIKIŞ YAP', 'mola-baslat': '🍽 YEMEK MOLASI BAŞLAT', 'mola-bitir': '🍽 MOLAYI BİTİR' };
  const dugmeYazi = (islem) => (mesgul ? 'Gönderiliyor…' : isHata?.tekrar && isHata.islem === islem ? '🔁 TEKRAR DENE' : etiket[islem]);
  return (
    <>
      <Marka alt={ben?.sube_ad ? `${ben.sube_ad} · ${gunYazi(ben.gun)}` : 'Yoklama'} />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, color: T.yesil, lineHeight: 1 }}>✓</div>
          <b style={{ fontSize: 26 }}>{baslik[sonuc.islem]} {sonuc.saat}</b>
          {(() => { const ham = sonuc.mesaj || ''; const m = ham.replace(/^[^·.]*(kaydedildi|başladı|bitti)[^·.]* · \d{2}:\d{2}\.?\s*/, '').replace(/^·\s*/, '') || (/zaten/.test(ham) ? 'Daha önce kaydedilmişti' : ''); return m ? <div className="tq-not">{m}</div> : null; })()}   {/* G37: başlığı tekrar eden baş kısım atılır ("İyi günler." kalır) */}
          {sonuc.hak_dustu && !ben?.yemek_tam && <div className="tq-not">Bugün yemek hakkı kazanılamadı</div>}
          {sonuc.islem === 'mola-bitir' && (ben?.yemek_tam ? <div style={{ color: T.yesil, fontWeight: 700 }}>🍽 Yemek hakkın tam (mola şartı yok)</div>
            : !sonuc.hak_dustu && <div style={{ color: T.yesil, fontWeight: 700 }}>🍽 Yemek hakkın kazanıldı ✓</div>)}{/* Fable: müdür şartsız (Maaş ile aynı kural) — 60 dk'yı aşsa da "kazanılamadı" denmez */}{/* M-2 (F1.7): kaybı söylüyordu, kazancı söylemiyordu */}
          {sonuc.islem === 'giris' && <div className="tq-not">🍽 Yemek molasına çıkarken paneldeki QR'ı <b>tekrar okut</b> → "Yemek molası başlat".</div>}
          <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">✓ Tamam</a>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !ben && <div className="tq-not">Hazırlanıyor…</div>}
          {ben && (<>
            <div style={{ fontSize: 22, fontWeight: 800 }}>👤 {ben.kisi}</div>
            {konumKarti ? <KonumKarti konum={konum} konumAl={konumAl} /> : <div className="tq-not">
              <KonumSatiri muaf={konumYok(ben)} konum={konum} konumAl={konumAl} />
            </div>}
            {(ben.giris || ben.cikis) && <div className="tq-silik">Bugün: giriş {ben.giris || '—'} · çıkış {ben.cikis || '—'}</div>}
            <MolaSatiri mola={ben.mola} />
            {!qrOk && <div style={{ color: T.kirmizi, fontWeight: 700 }}>QR süresi doldu — paneldeki QR'ı yeniden okut</div>}
            {ben.acik && ben.acik_sube && ben.acik_sube !== sube && <div style={{ color: T.kirmizi, fontWeight: 700 }}>Önce {ben.acik_sube_ad || 'diğer şube'}'den çıkış yap</div>}
            {isHata && !(konumKarti && konumRet(isHata.metin)) && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata.metin}</div>}
            {devirVar && (<>   {/* v2: devir sayfasına davet — KÖR (rakam yok) */}
              <div style={{ background: '#FFF6EC', border: `1px solid ${T.aksan}`, borderRadius: 12, padding: '10px 12px', fontWeight: 700 }}>
                💵 Kasa devri sürüyor — {devir.rol === 'devreden' ? 'kasa sende, sayıp devredeceksin' : `kasayı sen alacaksan kendi say${devir.devreden ? ` (veren: ${devir.devreden})` : ''}`}
                {devir.rol === 'devralan' && devir.giris_acilir ? ' (vardiyan devirle başlar)' : ''}
              </div>
              <a className="tq-btn tq-yesil" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
                href={`/q/${encodeURIComponent(sube)}/${encodeURIComponent(jeton || '')}?dv=${encodeURIComponent(devir.dv)}${devir.rol === 'devralan' ? '&devral=1' : ''}`}>
                {devir.rol === 'devreden' ? '💵 KASAYI DEVRET — SAY' : '💵 KASAYI DEVRAL — SAY'}</a>
            </>)}
            {ana && devirVar && ana === 'giris' && devir.giris_ikincil ? (   /* G71: devir sürerken gelen 2. kişi — düğme değil ince bağlantı, devirden uzak */
              <button type="button" disabled={mesgul || !konumHazir} onClick={() => yap('giris')}
                style={{ marginTop: 22, font: 'inherit', fontSize: 15, color: T.aksanKoyu, background: 'none', border: 'none', textDecoration: 'underline', minHeight: 48 }}>
                Yalnız mesai başlat — kasayı almıyorum</button>
            ) : ana && (
              <button className={'tq-btn ' + (devirVar ? 'tq-kucuk' : ana === 'giris' ? 'tq-yesil' : 'tq-ana')} disabled={mesgul || !konumHazir || molaErken} onClick={() => yap(ana)}>
                {molaErken ? `🍽 MOLAYI BİTİR · açılış ${molaAcilis}` : dugmeYazi(ana)}
              </button>
            )}
            {cikisVar && (
              <button className={'tq-btn ' + (ana || devirVar ? 'tq-kucuk' : 'tq-ana')} disabled={mesgul || !konumHazir} onClick={() => yap('cikis')}>
                {dugmeYazi('cikis')}
              </button>
            )}
            {!islemVar && !ben.acik && qrOk && <div className="tq-silik">{ben.gun_kapali ? "Bu şubenin günü kapandı — yeni iş günü 02:00'de başlar." : 'Bu QR ile yapılacak işlem yok.'}</div>}{/* Q-1 */}
          </>)}
        </div>
      )}
    </>
  );
}

// ── 🤝 AVANS TALEBİ (1 Kasım — kesim engeli T3-17, sahip 20 Eki: tavan eski oran; "aldım" onayı YOK) ──
// Tavan / kullanılabilir sunucudan (Maaş'ın hak edişi). Açık talep varken yenisi açılmaz. 1 Kasım öncesi kart görünmez (eski sayfa).
function AvansKart({ kartli }) {
  const [d, setD] = useState(null);
  const [ac, setAc] = useState(false);
  const [tut, setTut] = useState('');
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [msj, setMsj] = useState(null);
  const istek = useRef(null);
  const yukle = () => imzaliJson('telefon', 'GET', '/api/evvel-yeni/yoklama/avans').then(setD).catch(() => setD(null));
  useEffect(() => { yukle(); }, []);
  useEffect(() => {   // Codex P2: merkez onayı / teslim görünsün — 30 sn + uygulamaya dönüşte
    const tazele = () => { if (!document.hidden) yukle(); };
    const t = window.setInterval(tazele, 30000);
    document.addEventListener('visibilitychange', tazele);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tazele); };
  }, []);
  if (!d) return kartli ? <div className="tq-kart"><b>🤝 Avans</b><div className="tq-silik">Yükleniyor…</div></div> : null;
  if (d.kapali) return kartli ? <div className="tq-kart"><b>🤝 Avans</b><div className="tq-silik">Avans talebi 1 Kasım'dan itibaren buradan.</div></div> : null;   // Fable T1 #4: boş kart yok
  const para = (x) => tlYaz(x, 0);   // ₺ biçimi TEK kaynak (F#58)
  const gonder = async () => {
    if (mesgul) return;
    setMesgul(true); setMsj(null);
    if (!istek.current) istek.current = yeniIstekId();
    try {
      const r = await imzaliJson('telefon', 'POST', '/api/evvel-yeni/yoklama/avans', { tutar: tut, not: not.trim(), istek_id: istek.current });
      setMsj({ ok: true, metin: r.mesaj }); istek.current = null; setAc(false); setTut(''); setNot(''); yukle();
    } catch (e) {
      setMsj({ ok: false, metin: e instanceof TypeError ? 'İnternet yok — tekrar dene (talebin bekliyor)' : (e?.message || 'Gönderilemedi') });
      if (!(e instanceof TypeError)) istek.current = null;
    }
    setMesgul(false);
  };
  return (
    <div className={kartli ? 'tq-kart' : undefined} style={{ display: 'grid', gap: 8 }}>
      <b>🤝 Avans</b>
      {d.acik ? <div className="tq-not" style={d.acik.durum === 'onaylandi' ? { color: T.yesil, fontWeight: 700 } : undefined}>
          {d.acik.durum === 'talep' ? <>Açık talebin: <b>{para(d.acik.tutar)}</b> — merkez bakıyor</>
            : d.acik.yontem === 'elden' ? <>✅ Onaylandı — <b>{para(d.acik.tutar)}</b> {d.acik.sube ? `${d.acik.sube}'dan` : 'şubeden'} elden alabilirsin</>
              : <>✅ Onaylandı — <b>{para(d.acik.tutar)}</b></>}</div>
        : d.kullanilabilir > 0 ? <div className="tq-silik">Bu ay en çok {para(d.kullanilabilir)} isteyebilirsin</div>
        : <div className="tq-silik">Bu ay avans hakkın yok (hak ediş oluşmadı ya da doldu)</div>}
      {!d.acik && d.son && (   // B47: son talebin sonucu (7 gün)
        <div className="tq-not" style={{ color: d.son.durum === 'odendi' ? T.yesil : T.kirmizi }}>
          Son talebin ({para(d.son.tutar)}, {d.son.ts.slice(8, 10)}.{d.son.ts.slice(5, 7)}): {d.son.durum === 'odendi' ? (d.son.yontem === 'elden' ? `${d.son.sube ? d.son.sube + ' · ' : ''}${d.son.saat || ''} elden verildi ✓${d.son.kendine ? ' (kendin aldın)' : ''}` : 'hesabına havale edildi ✓ — hesabını kontrol et') : d.son.durum === 'kapatildi' ? `merkez kapattı${d.son.neden ? ' — ' + d.son.neden : ''}` : (d.son.neden && d.son.neden !== 'Merkez reddetti' ? `kabul edilmedi — ${d.son.neden}` : 'kabul edilmedi — merkeze sorabilirsin')}
        </div>)}
      {(d.bu_ay || []).length > 0 && (
        <div className="tq-silik" style={{ display: 'grid', gap: 2 }}>
          <span>Bu ay talebinle aldığın avans: <b>{para(d.bu_ay.reduce((a, x) => a + x.tutar, 0))}</b></span>
          {d.bu_ay.map((x, i) => <span key={i}>· {x.ts.slice(8, 10)}.{x.ts.slice(5, 7)} · {para(x.tutar)} · {x.yontem === 'elden' ? `elden${x.sube ? ' · ' + x.sube : ''}` : 'havale'}</span>)}
        </div>)}
      {msj && <div style={{ color: msj.ok ? T.yesil : T.kirmizi, fontWeight: 700 }}>{msj.metin}</div>}
      {!d.acik && d.kullanilabilir > 0 && !ac && <button className="tq-btn tq-kucuk" onClick={() => setAc(true)}>Avans iste</button>}
      {ac && (<>
        <input value={tut} onChange={(e) => setTut(e.target.value.replace(/[^\d,]/g, '').slice(0, 9))} placeholder="Tutar (₺)" inputMode="decimal" autoFocus style={GIRDI} />
        <input value={not} onChange={(e) => setNot(e.target.value.slice(0, 200))} placeholder="Not (isteğe bağlı)" style={GIRDI} />
        <button className="tq-btn tq-ana" disabled={mesgul || !tut} onClick={gonder}>{mesgul ? 'Gönderiliyor…' : 'Talebi gönder'}</button>
        <button className="tq-btn tq-kucuk" disabled={mesgul} onClick={() => setAc(false)}>Vazgeç</button>
      </>)}
    </div>
  );
}

// ── /q/{sube}/{jeton}?o={onay}: panelde açılış / kapanış formu doldu → "QR ile onayla" (PANEL_YENIDEN_KURULUM R1) ──
// Kişi telefondan tanınır (PIN yok); önce bu şubede girişi yoksa GİRİŞ YAP (aynı QR), sonra özet + ONAYLA.
const onayKimligi = () => {
  return urlKimlik('o');
};
const TUR_IKON = { acilis: '☀️', kapanis: '🌙' };

function OnayIslem({ sube, jeton, onay }) {
  const bagli = !!cihazId('telefon');
  const [ozet, setOzet] = useState(null);
  const [ben, setBen] = useState(null);
  const [hata, setHata] = useState('');
  const [konum, konumAl] = useKonum(bagli);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [isHata, setIsHata] = useState(null);
  const [girisMesaj, setGirisMesaj] = useState('');   // sahip: giriş yapınca telefonda açıkça "giriş kaydedildi" görünsün
  const istek = useRef({});
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    Promise.all([
      imzaliJson('telefon', 'GET', `/api/evvel-yeni/panel/onay/${encodeURIComponent(onay)}/ozet`),
      imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}&qr=${encodeURIComponent(jeton || '')}`),
    ]).then(([o, b]) => { setOzet(o); setBen(b); })
      .catch((e) => setHata(agMesaji(e, 'Okunamadı')));
  }, [bagli, onay, sube, jeton]);
  useEffect(() => { yukle(); }, [yukle]);
  if (!bagli) return <TanimliDegil />;

  const konumHazir = konumHazirMi(ben, konum);
  const konumKarti = konumKartiVar(ben, konum, isHata?.metin);
  const girisGerek = (ben?.yapabilir || []).includes('giris');
  const gecerli = ozet && (ozet.durum === 'bekliyor' || ozet.durum === 'hata');
  const yap = async (islem) => {
    if (mesgul) return;
    if (!istek.current[islem]) istek.current[islem] = yeniIstekId();   // tekrar denemede AYNI kimlik
    setMesgul(true); setIsHata(null);
    // sahip (19 Eki): kapanış QR'ını okutan İKİNCİ kişi "Sadece çıkış yap" (aynı QR; kapanışçı olmaz)
    const yol = islem === 'giris' ? '/api/evvel-yeni/yoklama/giris' : islem === 'cikis' ? '/api/evvel-yeni/yoklama/cikis'
      : `/api/evvel-yeni/panel/onay/${encodeURIComponent(onay)}/onayla`;
    try {
      const r = await imzaliJson('telefon', 'POST', yol, { sube, qr: jeton, lat: konum.lat, lng: konum.lng, istek_id: istek.current[islem] });
      if (islem === 'giris') { setGirisMesaj(`✅ ${r.mesaj || 'Giriş kaydedildi'} — şimdi aşağıdan ONAYLA`); yukle(); }
      else setSonuc({ mesaj: r.mesaj, kuru: !!r.kuru, cikis: islem === 'cikis' });
    } catch (e) {
      if (e instanceof TypeError) setIsHata({ islem, metin: 'İnternet yok — bağlantı gelince tekrar dene', tekrar: true });
      else {
        setIsHata({ islem, metin: e?.message || 'Onaylanamadı', tekrar: e?.status >= 500 || e?.status === 429 });
        if (e?.status === 400 && /giriş/i.test(e?.message || '')) yukle();   // "Önce telefonundan QR ile giriş yap" → GİRİŞ düğmesi
      }
    }
    setMesgul(false);
  };
  const yazi = (islem, varsayilan) => (mesgul ? 'Gönderiliyor…' : isHata?.tekrar && isHata.islem === islem ? '🔁 TEKRAR DENE' : varsayilan);

  return (
    <>
      <Marka alt={ozet?.sube_ad ? `${ozet.sube_ad} · onay` : 'Onay'} />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, color: T.yesil, lineHeight: 1 }}>✓</div>
          <b style={{ fontSize: 24 }}>{sonuc.cikis ? 'Çıkış yapıldı' : `${ozet?.ad || 'İşlem'} onaylandı`} · {saatSimdi()}</b>
          <div className="tq-not">{sonuc.mesaj}</div>
          {!sonuc.cikis && <div className="tq-silik">Panel birkaç saniye içinde kendiliğinden geçer.</div>}
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !ozet && <div className="tq-not">Hazırlanıyor…</div>}
          {ozet && (<>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{TUR_IKON[ozet.tur] || '✔'} {ozet.ad} · {ozet.sube_ad}</div>
            <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: 12, fontSize: 17, display: 'grid', gap: 6 }}>
              {/* G40 (sim 23 Eki): tek paragraf okunmuyordu → her parça ayrı satır, ilki (kasa/tutar) kalın */}
              {(ozet.ozet || '—').split(' · ').map((p, i) => <div key={i} style={i === 0 ? { fontWeight: 800, fontSize: 20 } : undefined}>{p.charAt(0).toLocaleUpperCase('tr') + p.slice(1)}</div>)}   {/* G49: her satır büyük harfle (online → Online) */}
            </div>
            <div className="tq-not">Onaylayan: <b>👤 {ozet.kisi}</b>{konumYok(ben) || konumKarti ? '' : ' · '}{!konumKarti && <KonumSatiri muaf={konumYok(ben)} konum={konum} konumAl={konumAl} />}
            </div>
            {konumKarti && <KonumKarti konum={konum} konumAl={konumAl} />}
            {girisMesaj && <div style={{ color: T.yesil, fontWeight: 700 }}>{girisMesaj}</div>}
            {isHata && !(konumKarti && konumRet(isHata.metin)) && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata.metin}</div>}
            {!gecerli && <div style={{ color: T.kirmizi, fontWeight: 700 }}>
              {ozet.durum === 'onaylandi' ? `Bu işlem zaten onaylandı${ozet.mesaj ? ' — ' + ozet.mesaj : ''}` : ozet.durum === 'sure_doldu' ? 'Onayın süresi doldu — panelden yeniden iste' : 'Bu onay artık geçerli değil — panelden yeniden iste'}
            </div>}
            {gecerli && girisGerek && (<>
              <div className="tq-not">Önce bu şubeye girişini yap — sonra onaylarsın (aynı QR yeter).</div>
              <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={() => yap('giris')}>{yazi('giris', '✅ GİRİŞ YAP')}</button>
            </>)}
            {gecerli && !girisGerek && (
              <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir} onClick={() => yap('onayla')}>
                {yazi('onayla', ozet.tur === 'kapanis' ? `✅ ONAYLA — kapanışçı olarak ${ozet.kisi || 'SEN'} kaydedileceksin` : `✅ ONAYLA — ${ozet.ad || ''}`)}</button>
            )}
            {!girisGerek && ozet.tur === 'kapanis' && (ben?.yapabilir || []).includes('cikis') && (<>
              <div className="tq-not">Kapanışı sen yapmıyorsan onaylama — yalnız çıkışını yap:</div>
              <button className="tq-btn tq-kucuk" disabled={mesgul || !konumHazir} onClick={async () => { if (await sor({ soru: 'Kapanışı SEN yapmıyorsun — yalnız çıkışın yazılsın mı?', alt: 'Kapanışçı olarak kaydedilmezsin.', tamam: '🚪 Evet, yalnız çıkış', iptal: 'Vazgeç' })) yap('cikis'); }}>{yazi('cikis', '🚪 Sadece çıkış yap')}</button>
            </>)}
          </>)}
        </div>
      )}
    </>
  );
}

// ── /q/{sube}/{jeton}?tb={teslim}: teslim kaydedildi → "📷 Faturayı çek" (Basamak 8 / E1). Fotoğraf telefonda küçültülür
// (uzun kenar 1600 px, JPEG) ve imzalı istekle teslime EK olarak yüklenir — ayrı fatura kaydı / okuma / eşleştirme YOK.
const teslimKimligi = () => {
  return urlKimlik('tb');
};
const kucult = async (dosya) => {   // Fable: EXIF yönü — createImageBitmap(imageOrientation) varsa yan dönmez
  if (window.createImageBitmap) {
    try {
      const bm = await window.createImageBitmap(dosya, { imageOrientation: 'from-image' });
      const o = Math.min(1, 1600 / Math.max(bm.width, bm.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bm.width * o); cv.height = Math.round(bm.height * o);
      cv.getContext('2d').drawImage(bm, 0, 0, cv.width, cv.height);
      bm.close?.();
      return cv.toDataURL('image/jpeg', 0.72);
    } catch { /* eski tarayıcı — Image yolu */ }
  }
  return kucultImg(dosya);
};
const kucultImg = (dosya) => new Promise((coz, red) => {
  const img = new window.Image();
  const url = URL.createObjectURL(dosya);
  img.onload = () => {
    const o = Math.min(1, 1600 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * o); cv.height = Math.round(img.height * o);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    coz(cv.toDataURL('image/jpeg', 0.72));
  };
  img.onerror = () => { URL.revokeObjectURL(url); red(new Error('Fotoğraf okunamadı')); };
  img.src = url;
});

function FaturaCek({ sube, tid }) {
  const bagli = !!cihazId('telefon');
  const [ozet, setOzet] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [eklenen, setEklenen] = useState([]);
  const yol = `/api/evvel-yeni/toptanci/teslim/${encodeURIComponent(tid)}/belge-telefon`;
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', `${yol}?sube=${encodeURIComponent(sube)}`).then(setOzet)
      .catch((e) => setHata(agMesaji(e, 'Okunamadı')));
  }, [bagli, yol, sube]);
  useEffect(() => { yukle(); }, [yukle]);
  if (!bagli) return <TanimliDegil />;
  const sec = async (e) => {
    const dosyalar = [...(e.target.files || [])];
    e.target.value = '';
    if (!dosyalar.length || mesgul) return;
    setMesgul(true); setHata('');
    for (const f of dosyalar) {
      try {
        const veri = await kucult(f);
        const r = await imzaliJson('telefon', 'POST', yol, { sube, veri, mime: 'image/jpeg' });
        setEklenen((o) => [...o, r.mesaj || 'Sayfa eklendi']);
      } catch (er) {
        setHata(er instanceof TypeError ? 'İnternet yok — bağlantı gelince tekrar çek' : (er?.message || 'Yüklenemedi'));
        break;
      }
    }
    setMesgul(false);
    yukle();
  };
  const dolu = ozet && ozet.belge_sayi >= ozet.max;
  return (
    <>
      <Marka alt="Faturayı çek" />
      <div className="tq-kart">
        {hata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div>}
        {!hata && !ozet && <div className="tq-not">Hazırlanıyor…</div>}
        {ozet && (<>
          <div style={{ fontSize: 20, fontWeight: 800 }}>🚚 {ozet.toptanci}</div>
          <div className="tq-not">{gunYazi(ozet.tarih)}{ozet.tutar != null ? ` · ${ozet.tutar.toLocaleString('tr-TR')} ₺` : ''} · çeken: <b>{ozet.kisi}</b></div>
          <div style={{ fontWeight: 700 }}>📎 Eklenen sayfa: {ozet.belge_sayi} / {ozet.max}</div>
          {eklenen.map((m, i) => <div key={i} style={{ color: T.yesil, fontWeight: 700 }}>✓ {m}</div>)}
          {!dolu && (
            <label className="tq-btn tq-ana" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: mesgul ? 0.6 : 1 }}>
              {mesgul ? 'Yükleniyor…' : ozet.belge_sayi ? '📷 SONRAKİ SAYFAYI ÇEK' : '📷 FATURAYI ÇEK'}
              <input type="file" accept="image/*" capture="environment" disabled={mesgul} onChange={sec} style={{ display: 'none' }} />
            </label>
          )}
          <div className="tq-silik">Her sayfayı ayrı çek, yazılar okunur olsun. Bittiyse sayfayı kapatabilirsin.</div>
        </>)}
      </div>
    </>
  );
}

// ── /q: salt durum ──
// ── 🏠 EV (/q) — Fable tasarımı T1 (tasarim_telefon/, sahip 21 Eki onayı): duruma göre TEK kart + alt sekmeler (⚡ Şimdi · 👤 Ben).
// Vardiyam / Sipariş sekmeleri kendi basamağında gelir (boş kabuk gösterilmez). İşlemler yine paneldeki QR ile (kimlik + konum);
// ev yalnız durumu ve sıradaki adımı söyler. 🔒 Kasa / başkasının verisi YOK — yalnız kişinin kendi günü.
const avatarRenk = (ad) => { const p = ['#C8956A', '#7A9E7E', '#8C7AA9', '#C27C6B', '#6F8FAF', '#B08D57']; let h = 0; for (const ch of String(ad || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return p[h % p.length]; };
const basHarf = (ad) => String(ad || '?').trim().split(/\s+/).slice(0, 2).map((x) => x[0] || '').join('').toLocaleUpperCase('tr-TR');
const ilkAd = (ad) => String(ad || '').trim().split(/\s+/)[0] || '';
function Avatar({ ad }) {
  return <div style={{ width: 44, height: 44, borderRadius: '50%', background: avatarRenk(ad), color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0 }}>{basHarf(ad)}</div>;
}
function EvBaslik({ ben }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <img src={tulipiLogo} alt="TuliPi" style={{ width: 34, height: 34, objectFit: 'contain' }} />
      </div>
      <Avatar ad={ben?.kisi} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{ben?.kisi || 'TuliPi'}</div>
        <div className="tq-silik">{[ben?.sube_ad, ben?.gun && gunYazi(ben.gun)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}
const dkKisa = (dk) => (dk >= 60 ? `${Math.floor(dk / 60)}s ${dk % 60}d` : `${dk}d`);
function Halka({ oran, yazi }) {
  const r = 34, c = 2 * Math.PI * r, o = Math.max(0, Math.min(1, oran || 0));
  return (
    <div style={{ position: 'relative', width: 86, height: 86, flexShrink: 0 }}>
      <svg width="86" height="86" viewBox="0 0 86 86" aria-hidden="true">
        <circle cx="43" cy="43" r={r} fill="none" stroke={T.kenar} strokeWidth="7" />
        <circle cx="43" cy="43" r={r} fill="none" stroke={T.aksan} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${c * o} ${c}`} transform="rotate(-90 43 43)" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}><b style={{ fontSize: 15 }}>{yazi}</b></div>
    </div>
  );
}
// İşlemler paneldeki QR ile (K6: sayfa içi okuyucu yok — telefonun kamerasıyla okutulur); bu kutu yalnız yol gösterir
function QrIpucu({ yazi, ana }) {
  return (
    <div style={{ minHeight: 60, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center', padding: '10px 14px',
      fontWeight: 800, fontSize: ana ? 18 : 16, background: ana ? T.aksanKoyu : T.yuzey, color: ana ? '#fff' : T.metin, border: `1px solid ${ana ? T.aksanKoyu : T.kenar}` }}>
      📷 {yazi}
    </div>
  );
}
function YemekBilgi({ ben }) {
  const m = ben.mola;
  const lim = ben.mola_limit_dk || 60, az = ben.mola_en_az_dk || 45;
  if (ben.yemek_tam) return <div className="tq-not">🍽 Yemek hakkın tam (mola şartı yok)</div>;   // Codex P2: müdür — Maaş ile aynı kural
  if (!m) return ben.cikis && !ben.acik   // Fable T1 #1: gün bitti, molasız gün hak oluşmaz (K17)
    ? <div className="tq-not">🍽 Bugün mola kullanılmadı · yemek hakkı oluşmadı</div>
    : <div className="tq-not">🍽 Yemek hakkı · bugün: mola ile kazanılır · {az}–{lim} dk</div>;
  if (m.durum === 'suruyor') return null;
  return m.hak_dustu
    ? <div className="tq-not">🍽 Mola {m.sure_dk ?? '—'} dk · bugün yemek hakkı oluşmadı ({lim} dk sınırı)</div>
    : <div className="tq-not" style={{ color: T.yesil, fontWeight: 700 }}>🍽 Yemek hakkı: kazanıldı ✓ · mola {m.sure_dk} dk</div>;
}
function MolaCubuk({ dk, az, lim }) {
  const yuzde = (x) => `${Math.min(100, (x / (lim + 1)) * 100)}%`;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ position: 'relative', height: 10, borderRadius: 6, background: T.yuzey, border: `1px solid ${T.kenar}` }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: yuzde(dk), borderRadius: 6, background: dk > lim ? T.kirmizi : T.aksan }} />
        <div style={{ position: 'absolute', left: yuzde(az), top: -4, bottom: -4, width: 2, background: T.metin2 }} />
        <div style={{ position: 'absolute', left: yuzde(lim), top: -4, bottom: -4, width: 2, background: T.kirmizi }} />
      </div>
      <div className="tq-silik" style={{ display: 'flex', justifyContent: 'space-between' }}><span>0</span><span>{az} dk</span><span>{lim} dk</span></div>
    </div>
  );
}
function SimdiKart({ ben, simdi }) {
  const lim = ben.mola_limit_dk || 60, az = ben.mola_en_az_dk || 45;
  const m = ben.mola;
  if (m && m.durum === 'suruyor') {
    return (
      <div className="tq-kart" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>🍽</div>
        <div className="tq-silik" style={{ letterSpacing: 1 }}>MOLADASIN</div>
        <b style={{ fontSize: 34, fontFamily: "'Fraunces', serif" }}>{m.sure_dk} dk</b>
        <div className="tq-not">{m.bas}{saatEki(m.bas)} beri · afiyet olsun</div>
        <MolaCubuk dk={m.sure_dk} az={az} lim={lim} />
        <div className="tq-not">{ben.yemek_tam ? 'Yemek hakkın tam (mola şartı yok) — afiyet olsun.' : m.hak_dustu || m.sure_dk > lim ? `${lim} dk geçti · bugün yemek hakkı oluşmadı` : `Yemek hakkı ${lim} dk'ya kadar senin. ${lim + 1}. dakikada sistem molayı kapatır; o gün yemek hakkı oluşmaz.`}</div>
        <QrIpucu yazi={m.sure_dk < az ? `Molayı en erken ${az}. dakikada bitirebilirsin` : 'Molayı bitirmek için QR okut'} ana={m.sure_dk >= az} />
      </div>
    );
  }
  if (ben.acik) {
    const dk = ben.giris_ts ? Math.max(0, Math.floor((simdi - new Date(ben.giris_ts).getTime()) / 60000)) : null;
    return (
      <div className="tq-kart">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Halka oran={1} yazi={dk != null ? dkKisa(dk) : '—'} />   {/* Codex P2: plan gelene kadar (T2) yalnız geçen süre — vardiya uzunluğu varsayılmaz */}
          <div>
            <div className="tq-silik" style={{ letterSpacing: 1 }}>İÇERİDESİN</div>
            <b style={{ fontSize: 24, fontFamily: "'Fraunces', serif" }}>{ben.giris ? `${ben.giris}'den beri` : 'İçeridesin'}</b>
          </div>
        </div>
        {ben.devir?.ev && (   // Fable T1 #2: devir bekliyor (yalnız rol + ad — tutar yok; işlem devir QR'ında)
          <div style={{ background: '#FFF6EC', border: `1px solid ${T.aksan}`, borderRadius: 12, padding: '10px 12px', fontWeight: 700 }}>
            💵 {ben.devir.rol === 'devralan' ? `${ben.devir.devreden || 'Arkadaşın'} kasayı sana devrediyor` : 'Kasa devrin sürüyor'} — paneldeki devir QR'ını okut
          </div>
        )}
        <QrIpucu yazi={m ? 'Çıkış için paneldeki QR\'ı okut' : 'Mola için paneldeki QR\'ı okut'} ana />
        {!m && <QrIpucu yazi="Çıkış: aynı QR" />}
        <YemekBilgi ben={ben} />
      </div>
    );
  }
  if (ben.cikis) {
    return (
      <div className="tq-kart" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, color: T.yesil, lineHeight: 1 }}>✓</div>
        <b style={{ fontSize: 28, fontFamily: "'Fraunces', serif" }}>Çıkış · {ben.cikis}</b>
        <div className="tq-not">İyi dinlenmeler {ilkAd(ben.kisi)} 🌙</div>
        <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: '10px 12px', textAlign: 'left', display: 'grid', gap: 4 }}>
          <div>Giriş <b>{ben.giris || '—'}</b> · Çıkış <b>{ben.cikis}</b></div>
          {m && <div>🍽 Mola {m.bas}–{m.bit || '—'} · {m.sure_dk ?? '—'} dk</div>}
        </div>
        <YemekBilgi ben={ben} />
      </div>
    );
  }
  return (
    <div className="tq-kart">
      <b style={{ fontSize: 26, fontFamily: "'Fraunces', serif" }}>Merhaba {ilkAd(ben.kisi)} ☀️</b>
      <div className="tq-not">Bugün henüz giriş yapmadın.</div>
      <QrIpucu yazi="Giriş için paneldeki QR'ı okut" ana />
      <YemekBilgi ben={ben} />
    </div>
  );
}
function BenSekme({ ben }) {
  return (
    <>
      <AvansKart kartli />
      <div className="tq-kart">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>📱 Bu telefon</span><span style={{ background: '#E5F2EA', color: T.yesil, borderRadius: 999, padding: '4px 10px', fontWeight: 700, fontSize: 13 }}>bağlı ✓</span>
        </div>
        <div className="tq-silik">Ana ekrana ekle: tarayıcı menüsünden "Ana ekrana ekle". iPhone'da Paylaş → Ana Ekrana Ekle → <b>"Web Uygulaması olarak aç" seçeneğini KAPAT</b> (açık kalırsa telefon bağlantısı o simgede görünmez).</div>
      </div>
      <div className="tq-silik" style={{ textAlign: 'center' }}>{ben?.kisi} · TuliPi</div>
    </>
  );
}
function AltMenu({ sekme, setSekme }) {
  const S = [['simdi', '⚡', 'Şimdi'], ['ben', '👤', 'Ben']];
  return (
    <nav style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: T.kart, borderTop: `1px solid ${T.kenar}`, display: 'flex', justifyContent: 'center', padding: '6px 12px calc(6px + env(safe-area-inset-bottom))', zIndex: 5 }}>
      <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 520 }}>
        {S.map(([id, ik, ad]) => (
          <button key={id} type="button" onClick={() => setSekme(id)} style={{ flex: 1, minHeight: 56, borderRadius: 12, border: 'none', font: 'inherit', cursor: 'pointer',
            background: sekme === id ? T.yuzey : 'transparent', color: sekme === id ? T.metin : T.metin2, fontWeight: sekme === id ? 800 : 600, display: 'grid', placeItems: 'center' }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>{ik}</span><span style={{ fontSize: 12 }}>{ad}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
function Ev() {
  const bagli = !!cihazId('telefon');
  const [ben, setBen] = useState(null);
  const [hata, setHata] = useState('');
  const [sekme, setSekme] = useState('simdi');
  const [simdi, setSimdi] = useState(() => Date.now());
  const yukle = useCallback(() => {
    if (!bagli) return;
    imzaliJson('telefon', 'GET', '/api/evvel-yeni/yoklama/ben').then((r) => { setBen(r); setHata(''); })
      .catch((e) => setHata(agMesaji(e, 'Okunamadı')));
  }, [bagli]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => {   // sayfa açıkken 30 sn'de bir tazele (K5: bildirim yok); sekme gizliyken durur, dönünce hemen tazeler
    const tazele = () => { if (!document.hidden) { setSimdi(Date.now()); yukle(); } };
    const t = window.setInterval(tazele, 30000);
    document.addEventListener('visibilitychange', tazele);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', tazele); };
  }, [yukle]);
  if (!bagli) return <TanimliDegil />;
  return (
    <div style={{ display: 'grid', gap: 14, paddingBottom: 84 }}>
      <EvBaslik ben={ben} />
      <EskiQrNotu bagli />
      {hata && <div className="tq-kart"><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></div>}
      {!hata && !ben && <div className="tq-kart"><div className="tq-not">Hazırlanıyor…</div></div>}
      {ben && sekme === 'simdi' && <SimdiKart ben={ben} simdi={simdi} />}
      {ben && sekme === 'ben' && <BenSekme ben={ben} />}
      <AltMenu sekme={sekme} setSekme={setSekme} />
    </div>
  );
}

const GIRDI = { minHeight: 56, borderRadius: 12, border: `1px solid ${T.kenar}`, background: T.yuzey, color: T.metin, font: 'inherit', fontSize: 18, padding: '10px 14px', width: '100%' };

// ── /q/{sube}/{jeton}?dv={devir}: panelde "Devri başlat" → devir QR'ı (PANEL_YENIDEN_KURULUM Basamak 4, sahip 2026-10-19) ──
// v2 (DEVIR_KURGU_V2, sahip 23 Eki): KASA SAHİBİ okutursa devreden formu, başkası okutursa devralan formu — ikisi AYRI ve KÖR sayar
// (karşı tarafın rakamı yok) → sistem karşılaştırır: tuttu / 1 kez birlikte yeniden (yalnız tutmayan kalem) / yine tutmazsa merkeze.
const devirKimligi = () => {
  return urlKimlik('dv');
};

function DevirIslem({ sube, jeton, did }) {
  const bagli = !!cihazId('telefon');
  const [b, setB] = useState(null);          // /devir/{did}/telefon (KÖR — karşı tarafın rakamı yok)
  const [hata, setHata] = useState('');
  const [konum, konumAl] = useKonum(bagli);
  const [mesgul, setMesgul] = useState(false);
  const [isHata, setIsHata] = useState('');
  const [sonuc, setSonuc] = useState(null);
  const istek = useRef({});
  const otomatik = useRef(false);
  const tKey = `ey_devir_taslak:${did}`;
  const ilk = (() => { try { return JSON.parse(localStorage.getItem(tKey) || 'null'); } catch { return null; } })();
  const [adim, setAdim] = useState(ilk?.adim || 1);
  const [f, setF] = useState(ilk?.f || { kasa: '', s: {}, pasta: '', dogru: false });
  const [tur, setTur] = useState(ilk?.tur || 1);   // 2. turda yalnız TUTMAYAN kalemler yeniden sorulur (gerisi 1. turdan)
  useEffect(() => { try { localStorage.setItem(tKey, JSON.stringify({ adim, f, tur })); } catch { /* yok */ } }, [adim, f, tur, tKey]);

  const yukle = useCallback(() => {
    if (!bagli) return Promise.resolve(null);
    setHata('');
    return imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/telefon?sube=${encodeURIComponent(sube)}&qr=${encodeURIComponent(jeton || '')}`)
      .then((x) => { setB(x); return x; })
      .catch((e) => { setHata(agMesaji(e, 'Okunamadı')); return null; });
  }, [bagli, did, sube, jeton]);
  useEffect(() => { yukle(); }, [yukle]);
  // karşı taraf sayarken sonucu bekle (3 sn) — sonuç gelince ekran kendiliğinden değişir
  useEffect(() => {
    if (!b || sonuc || !['gonderdin', 'bekle'].includes(b.rol)) return undefined;
    const t = window.setInterval(yukle, 3000);
    return () => window.clearInterval(t);
  }, [b, sonuc, yukle]);
  // 1. tur tutmadı → 2. tur: yalnız tutmayan kalemleri boşalt, gerisi kalsın (sahip: birlikte BİR KEZ daha sayın)
  const d = b?.devir;
  const liste = b?.liste || { bardak: [], urun: [] };
  useEffect(() => {
    if (!d || d.durum !== 'yeniden' || tur === 2) return;
    const fk = new Set(d.fark_kalem || []);
    setF((o) => {
      const s2 = { ...o.s };
      [...liste.bardak, ...liste.urun].forEach((u) => { if (fk.has(u.ad)) s2[u.id] = ''; });
      return { ...o, s: s2, kasa: fk.has('Kasa (nakit)') ? '' : o.kasa, pasta: fk.has('Pasta') ? '' : o.pasta, dogru: false };
    });
    setTur(2); setAdim(1); setIsHata('');
  }, [d, tur, liste.bardak, liste.urun]);

  const konumHazir = konumHazirMi(b, konum);
  const konumKarti = konumKartiVar(b, konum, isHata);
  const gonder = async (yol, govde, anahtar) => {
    if (mesgul) return null;
    if (!istek.current[anahtar]) istek.current[anahtar] = yeniIstekId();
    setMesgul(true); setIsHata('');
    try {
      const r = await imzaliJson('telefon', 'POST', yol, { sube, lat: konum.lat, lng: konum.lng, istek_id: istek.current[anahtar], ...govde });
      setMesgul(false);
      return r;
    } catch (e) {
      setIsHata(e instanceof TypeError ? 'İnternet yok — bağlantı gelince tekrar dene'
        : /QR süresi doldu/i.test(e?.message || '') ? "QR'ın süresi doldu — paneldeki QR'ı tekrar okut (yazdıkların duruyor)" : (e?.message || 'Kaydedilemedi'));
      if (!(e instanceof TypeError) && e?.status !== 429 && !(e?.status >= 500)) istek.current[anahtar] = null;
      setMesgul(false);
      return null;
    }
  };
  const basla = async (taraf, adina) => {
    const r = await gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/basla`, { qr: jeton, taraf, adina: adina || null }, `basla-${taraf}-${tur}`);
    if (r) yukle();
  };
  // Kasa sahibi (devreden) okutunca sayım formu kendiliğinden açılır (soru yok) — konum hazır olunca bir kez
  useEffect(() => {
    if (!b || otomatik.current || b.baska_subede || !konumHazir) return;
    if (b.rol === 'basla_devreden' && b.icerde) { otomatik.current = true; basla('devreden'); return; }
    // G67 (sim 23 Eki): devralan ana ekrandaki 'KASAYI DEVRAL' ile geldi — ikinci onay yok; yalnız 'onun adına say' seçeneği varsa seçim ekranı kalır
    // Opus B8: yalnız ana ekrandaki 'KASAYI DEVRAL' düğmesinden gelindiyse (devral=1) — panelin devir QR'ını doğrudan okutan ilgisiz kişi kendiliğinden devralan olmaz
    if (b.rol === 'basla_devralan' && !b.vekil_olabilir && urlKimlik('devral') === '1') { otomatik.current = true; basla('devralan'); }
  }, [b, konumHazir]);   // eslint-disable-line react-hooks/exhaustive-deps
  const vazgec = async () => {
    const r = await gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/vazgec`, {}, `vazgec-${tur}`);
    if (r) { try { localStorage.removeItem(tKey); } catch { /* yok */ } setSonuc({ baslik: 'Vazgeçtin', mesaj: r.mesaj, tuttu: null }); }   // G70: sonuç ekranda görünsün
  };

  if (!bagli) return <TanimliDegil />;
  const tl = (x) => tlYaz(x);
  const taraf = b?.rol === 'form_devreden' ? 'devreden' : 'devralan';
  const fk = new Set(tur === 2 ? (d?.fark_kalem || []) : []);
  const sor = (ad) => tur !== 2 || fk.has(ad);   // 2. turda yalnız tutmayan kalem sorulur
  const bardakSor = liste.bardak.filter((u) => sor(u.ad));
  const urunSor = liste.urun.filter((u) => sor(u.ad));
  const adimlar = [sor('Kasa (nakit)') && 1, bardakSor.length && 2, urunSor.length && 3, sor('Pasta') && 4, 5].filter(Boolean);
  const gAdim = adimlar.includes(adim) ? adim : adimlar[0];   // 2. turda sorulmayan adım atlanır
  const ai = adimlar.indexOf(gAdim);
  const kalemDolu = (l) => l.every((u) => f.s[u.id] !== undefined && f.s[u.id] !== '');
  const kasaGecerli = paraGecerli(f.kasa);   // TEK para kuralı (F#57)
  const sayiKutu = (u) => (
    <label key={u.id} style={{ display: 'grid', gap: 4 }}><span className="tq-not">{u.ad}</span>
      <input style={GIRDI} inputMode="numeric" placeholder="0" value={f.s[u.id] ?? ''}
        onChange={(e) => setF((o) => ({ ...o, s: { ...o.s, [u.id]: e.target.value.replace(/\D/g, '').slice(0, 6) } }))} /></label>
  );
  const kendiOzet = (
    <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 18, fontWeight: 800 }}>💰 Kasa: {tl(sayiTR(f.kasa || '0', 0))}</div>
      <div>🥤 {kalemYazi(liste.bardak.map((u) => ({ ad: u.ad, sayilan: f.s[u.id] })))}</div>
      <div>📦 {kalemYazi(liste.urun.map((u) => ({ ad: u.ad, sayilan: f.s[u.id] })))}</div>
      <div>🍰 Pasta: {f.pasta === '' ? '—' : f.pasta}</div>
    </div>
  );
  const gonderSayim = async () => {
    const r = await gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/say`, {
      taraf, kasa: f.kasa || '', pasta: f.pasta, dogruladim: !!f.dogru,
      bardak: liste.bardak.map((u) => ({ urun_id: u.id, sayilan: f.s[u.id] })), urunler: liste.urun.map((u) => ({ urun_id: u.id, sayilan: f.s[u.id] })),
    }, `say-${taraf}-${tur}`);
    if (!r) { yukle(); return; }
    if (/^✓ Tuttu|tamamlandı/.test(r.mesaj || '')) { try { localStorage.removeItem(tKey); } catch { /* yok */ } setSonuc({ baslik: /Tuttu/.test(r.mesaj) ? 'Devir tamam' : 'Devir tamamlandı', mesaj: r.mesaj, tuttu: /Tuttu/.test(r.mesaj) }); return; }
    yukle();
  };
  const bitisMesaji = () => {
    if (!d) return null;
    if (d.durum === 'tamam') return { baslik: 'Devir tamam', mesaj: `✓ Tuttu — kasa artık: ${d.devralan || ''}`, tuttu: true };
    if (d.durum === 'tutmadi') return { baslik: 'Devir tamamlandı', mesaj: `İkinci sayım da tutmadı — merkeze bildirildi. Kasa artık: ${d.devralan || ''}`, tuttu: false };
    if (d.durum === 'merkez_kapatti') return { baslik: 'Merkez kapattı', mesaj: d.merkez_sonuc === 'kapandi' ? `Devri merkez tamamladı. Kasa artık: ${d.devralan || ''}` : 'Bu devri merkez iptal etti — gerekirse panelden yeniden başlatılır.', tuttu: null };   // Opus B16
    return null;
  };
  const bitti = sonuc || (b?.rol === 'bitti' && bitisMesaji());

  return (
    <>
      <Marka alt={b?.sube_ad ? `${b.sube_ad} · kasa devri` : 'Kasa devri'} />
      {bitti ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, color: bitti.tuttu === false ? T.kirmizi : bitti.tuttu === null ? T.aksanKoyu : T.yesil, lineHeight: 1 }}>{bitti.tuttu === false ? '⚠' : bitti.tuttu === null ? '↩' : '✓'}</div>
          <b style={{ fontSize: 24 }}>{bitti.baslik}</b>
          <div className="tq-not">{bitti.mesaj}</div>
          <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">✓ Tamam</a>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !b && <div className="tq-not">Hazırlanıyor…</div>}
          {b && (<>
            <div style={{ fontSize: 20, fontWeight: 800 }}>👤 {b.kisi}</div>
            {konumKarti ? <KonumKarti konum={konum} konumAl={konumAl} /> : <div className="tq-not"><KonumSatiri muaf={konumYok(b)} konum={konum} konumAl={konumAl} /></div>}
            {isHata && !(konumKarti && konumRet(isHata)) && !(hata && /süresi doldu/i.test(hata) && /süresi doldu/i.test(isHata)) && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata}</div>}   {/* G57 */}
            {d?.durum === 'yeniden' && (   // KÖR: yalnız tutmayan KALEM ADI — rakam yok
              <div style={{ background: '#FDECEC', border: `2px solid ${T.kirmizi}`, borderRadius: 12, padding: '10px 12px', fontWeight: 800, color: T.kirmizi }}>
                ⚠ Tutmadı — birlikte bir kez daha sayın: {(d.fark_kalem || []).join(', ')}
              </div>
            )}

            {b.baska_subede && <div style={{ color: T.kirmizi, fontWeight: 700 }}>Önce diğer şubeden çıkış yap</div>}
            {b.rol === 'eski' && <div className="tq-not">Bu eski bir devir — panelden iptal edip yeniden başlatın.</div>}
            {b.rol === 'basla_devreden' && !b.icerde && <div className="tq-not">Kasayı devretmek için bu şubede içeride olmalısın.</div>}
            {b.rol === 'basla_devreden' && b.icerde && (<>
              <div className="tq-not">💵 Kasa sende — devredeceksin. {mesgul ? 'Sayım açılıyor…' : ''}</div>
              {isHata && <button className="tq-btn tq-kucuk" onClick={() => { otomatik.current = false; yukle(); }}>Tekrar dene</button>}
            </>)}
            {b.rol === 'basla_devralan' && !b.baska_subede && (<>
              <div className="tq-not">💵 Kasayı sen alacaksın{b.sahip?.ad ? ` (veren: ${b.sahip.ad})` : ''}. Kendi saydığını yaz — veren de ayrı sayar, sistem karşılaştırır.{!b.icerde ? ' Vardiyan bu devirle başlar.' : ''}</div>
              <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={() => { otomatik.current = true; basla('devralan'); }}>{mesgul ? 'Açılıyor…' : '💵 KASAYI DEVRALIYORUM — SAY'}</button>
              {b.vekil_olabilir && (
                <button className="tq-btn tq-kucuk" disabled={mesgul || !konumHazir} onClick={() => basla('devreden', b.sahip?.id)}>Veren ({b.sahip?.ad}) telefonsuz — onun adına devreden say</button>
              )}
              {!b.icerde && (   /* Opus B8 + G71: devir QR'ını okutan ama yalnız mesaiye gelen — ince bağlantı, devirden uzak */
                <a href={`/q/${encodeURIComponent(sube)}/${encodeURIComponent(jeton || '')}`}
                  style={{ marginTop: 22, display: 'block', textAlign: 'center', fontSize: 15, color: T.aksanKoyu, textDecoration: 'underline', minHeight: 48 }}>
                  Yalnız mesai başlat — kasayı almıyorum</a>
              )}
            </>)}
            {b.rol === 'bekle' && <div className="tq-not">⏳ {d?.devralan || 'Başka biri'} kasayı devralıyor — bu devirde senin işin yok.</div>}
            {b.rol === 'gonderdin' && (
              <div className="tq-not" style={{ fontWeight: 700 }}>✓ Sayımın gönderildi · ⏳ {d && (d.devreden_saydi && d.devralan_saydi ? 'karşılaştırılıyor…' : (() => {
                  const o = d.devreden_saydi ? { ad: d.devralan, basladi: !!d.devralan_id } : { ad: d.devreden || b.sahip?.ad, basladi: !!d.devreden_id };
                  return `${o.ad || 'Kasayı alacak kişi'} ${o.basladi ? 'sayıyor' : 'henüz QR okutmadı'} — sonuç burada çıkacak`;
                })())}</div>
            )}

            {(b.rol === 'form_devreden' || b.rol === 'form_devralan') && (<>
              <div className="tq-silik">{taraf === 'devreden' ? '💵 Kasayı devrediyorsun' : '💵 Kasayı devralıyorsun'}{tur === 2 ? ' · 2. sayım' : ''} · Adım {ai + 1} / {adimlar.length} · {b.pencere_dk} dk içinde gönder</div>
              {gAdim === 1 && (<>
                <b>💰 Kasadaki nakit (₺)</b>
                <div className="tq-not">Kasadaki bütün nakdi say ve yaz.</div>   {/* G55 */}
                <input style={GIRDI} inputMode="decimal" placeholder="0" value={f.kasa} onChange={(e) => setF((o) => ({ ...o, kasa: e.target.value.replace(/[^\d,]/g, '').slice(0, 11) }))} />
              </>)}
              {gAdim === 2 && (<><b>🥤 Bardaklar</b>{bardakSor.map(sayiKutu)}</>)}
              {gAdim === 3 && (<><b>📦 Ürünler</b>{urunSor.map(sayiKutu)}</>)}
              {gAdim === 4 && (<>
                <b>🍰 Pasta (toplam adet)</b>
                <input style={GIRDI} inputMode="numeric" placeholder="0" value={f.pasta} onChange={(e) => setF((o) => ({ ...o, pasta: e.target.value.replace(/\D/g, '').slice(0, 5) }))} />
              </>)}
              {gAdim === 5 && (<>
                <b>✅ Kendi sayımın</b>
                {kendiOzet}
                <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 56, padding: '8px 12px', borderRadius: 12, fontWeight: 800,
                  border: `2px solid ${f.dogru ? T.yesil : '#d97706'}`, background: f.dogru ? 'rgba(34,197,94,.12)' : 'rgba(245,158,11,.14)', color: f.dogru ? T.yesil : '#b45309' }}>
                  <input type="checkbox" style={{ width: 28, height: 28, flexShrink: 0 }} checked={!!f.dogru} onChange={(e) => setF((o) => ({ ...o, dogru: e.target.checked }))} />
                  <span>{f.dogru ? '✓ ' : ''}Saydım, doğru</span>
                </label>   {/* G56 */}
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir || !f.dogru} onClick={gonderSayim}>{mesgul ? 'Gönderiliyor…' : '📨 SAYIMI GÖNDER'}</button>
              </>)}
              <div style={{ display: 'flex', gap: 8 }}>
                {ai > 0 && <button className="tq-btn tq-kucuk" style={{ flex: 1 }} disabled={mesgul} onClick={() => { setIsHata(''); setAdim(adimlar[ai - 1]); }}>« Geri</button>}
                {gAdim < 5 && <button className="tq-btn tq-kucuk tq-yesil" style={{ flex: 2 }}
                  onClick={() => {
                    setIsHata('');
                    if (gAdim === 1 && !kasaGecerli) { setIsHata('Kasadaki nakdi yaz'); return; }
                    if (gAdim === 2 && !kalemDolu(bardakSor)) { setIsHata('Her bardağın adedini yaz (yoksa 0)'); return; }
                    if (gAdim === 3 && !kalemDolu(urunSor)) { setIsHata('Her ürünün adedini yaz (yoksa 0)'); return; }
                    if (gAdim === 4 && f.pasta === '') { setIsHata('Pasta adedini yaz (yoksa 0)'); return; }
                    setAdim(adimlar[ai + 1]);
                  }}>İleri →</button>}
              </div>
              {tur === 1 && (taraf === 'devralan' || (d?.vekil && d?.ustlenen_id && d.ustlenen_id !== d.devreden_id)) && (   /* G67: yanlış üstlenme geri alınır — İleri'den uzakta, düşük ağırlık */
                <button type="button" disabled={mesgul} onClick={vazgec}
                  style={{ marginTop: 18, font: 'inherit', fontSize: 14, color: T.aksanKoyu, background: 'none', border: 'none', textDecoration: 'underline', minHeight: 48 }}>
                  {taraf === 'devralan' ? 'Vazgeç — kasayı ben almıyorum' : 'Vazgeç — adına saymıyorum'}</button>
              )}
            </>)}
          </>)}
        </div>
      )}
    </>
  );
}

// ── Yemek molası satırı (K7): sürüyor → "Mola 12:30'dan beri · 18 dk"; bitti → "Mola 12:30–13:05 · 35 dk";
//    hak düştüyse altında TEK bilgi satırı (kırmızı değil, bildirim değil) ──
function MolaSatiri({ mola }) {
  if (!mola) return null;
  return (
    <>
      <div style={{ fontSize: 17 }}>
        🍽 {mola.durum === 'suruyor' ? <>Mola <b>{mola.bas}</b>{saatEki(mola.bas)} beri · <b>{mola.sure_dk} dk</b></> : <>Mola {mola.bas}–{mola.bit || '—'} · <b>{mola.sure_dk ?? '—'} dk</b></>}
      </div>
      {mola.hak_dustu && <div className="tq-not">{mola.otomatik ? `Mola ${mola.sure_dk ?? 61} dakikayı geçti — sistem kapattı, yemek hakkını kaybettin` : 'Bugün yemek hakkı kazanılamadı'}</div>}
    </>
  );
}

// 🔀 Eski basılı QR'dan gelindi (/gorev-giris → /q?eski=1, 1 Kasım kesimi) — tek satır ipucu (Fable 21 Eki)
const eskiQrdan = () => { try { return new window.URLSearchParams(window.location.search).get('eski') === '1'; } catch { return false; } };
function EskiQrNotu({ bagli }) {
  if (!eskiQrdan()) return null;
  return (
    <div className="tq-kart" style={{ borderColor: T.aksanKoyu, fontWeight: 700 }}>
      🔀 Bu eski QR artık kullanılmıyor. {bagli ? "Giriş / çıkış için paneldeki QR'ı okut." : 'Telefonunu bağlamak için merkeze adını söyle; gelen linki bu telefonda aç.'}
    </div>
  );
}
// iPhone "Web Uygulaması olarak aç" kabı Safari'nin bağını görmez (canlı 27 Eki, Fable P-3) — yeni link İSTETME, bağ Safari'de
const simgeKabi = () => { try { return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch { return false; } };
function TanimliDegil() {
  const kap = simgeKabi();
  return (
    <>
      <Marka alt="Yoklama" />
      <EskiQrNotu bagli={false} />
      <div className="tq-kart" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 44 }}>📵</div>
        <b style={{ fontSize: 20 }}>Bu telefon tanımlı değil</b>
        {kap
          ? <div className="tq-not">Bu simge ayrı bir kap, telefon bağını görmüyor. Simgeyi sil; giriş / çıkış için paneldeki QR'ı kamerayla okut (Safari'de açılır, bağ orada). Ana ekrana yeniden eklersen <b>"Web Uygulaması olarak aç" seçeneğini KAPAT</b>.</div>
          : <div className="tq-not">Merkezden bağlantı linki iste; link bu telefonda açılınca bağlanır.</div>}
      </div>
    </>
  );
}
