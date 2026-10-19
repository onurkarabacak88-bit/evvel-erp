// 📱 TELEFON SAYFASI — Evvel Yeni yoklama (YOKLAMA_QR_TASARIM.md §A2; sunucu: evvel_yeni_yoklama_api.py)
// Adresler: /q/bagla/{davet} (merkezin linki → bu telefon kişinin olur) · /q/{sube}/{jeton} (paneldeki QR okutunca: tek büyük düğme
// GİRİŞ / YEMEK MOLASI BAŞLAT / MOLAYI BİTİR + sade ÇIKIŞ; K7 hak düştüyse tek bilgi satırı) · /q (salt durum). Menüsüz tam ekran, AÇIK TuliPi teması (design_qr_personel_marka). PIN yok; uyarı personele gitmez —
// yalnız işlemin sonucu tek cümle. Düğmeler ≥ 56px. Ağ düşerse AYNI istek_id ile "Tekrar dene" (sunucu ikinci kez yazmaz).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import tulipiLogo from '../../assets/tulipi-logo.jpg';
import { cihazBagla, cihazId, imzaliJson, yeniIstekId } from '../../utils/cihazImza';

const T = { zemin: '#F4EFE9', kart: '#FFFFFF', kenar: '#E6DED4', yuzey: '#F7F2EC', metin: '#2A241E', metin2: '#6B5E50', silik: '#9C8E7E',
  aksan: '#C8956A', yesil: '#25794F', kirmizi: '#C03A2B', golge: '0 8px 30px rgba(120,90,60,.10)' };
const CSS = `
.tq *{box-sizing:border-box} .tq{min-height:100vh;background:${T.zemin};color:${T.metin};font-family:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.4;padding:16px;display:flex;flex-direction:column;gap:14px;max-width:520px;margin:0 auto}
.tq-kart{background:${T.kart};border:1px solid ${T.kenar};border-radius:16px;padding:16px;box-shadow:${T.golge};display:grid;gap:10px}
.tq-btn{min-height:64px;width:100%;border-radius:14px;border:1px solid ${T.kenar};background:${T.yuzey};color:${T.metin};font:inherit;font-size:20px;font-weight:800;cursor:pointer;padding:12px 16px}
.tq-btn:disabled{opacity:.45;cursor:default} .tq-ana{background:${T.aksan};border-color:${T.aksan};color:#fff} .tq-yesil{background:${T.yesil};border-color:${T.yesil};color:#fff}
.tq-kucuk{min-height:56px;font-size:17px;font-weight:700}
.tq-not{color:${T.metin2};font-size:14px} .tq-silik{color:${T.silik};font-size:13px}
`;

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

// ── Konum: sayfa açılınca bir kez, 10 sn zaman aşımı; muaf kişide hata engel değil — sunucu karar verir (konum yine gönderilir) ──
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

export default function TelefonSayfasi({ mod, davet, sube, jeton }) {
  useEffect(() => { document.title = 'TuliPi · Yoklama'; }, []);
  return (
    <div className="tq">
      <style>{CSS}</style>
      {mod === 'bagla' && <Bagla davet={davet} />}
      {mod === 'qr' && (onayKimligi() ? <OnayIslem sube={sube} jeton={jeton} onay={onayKimligi()} /> : <QrIslem sube={sube} jeton={jeton} />)}
      {mod === 'durum' && <Durum />}
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
    catch (e) { setHata(e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'Bağlanamadı')); }
    setMesgul(false);
  };
  return (
    <>
      <Marka alt="Telefonu bağla" />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 56 }}>{sonuc.durum === 'aktif' ? '✓' : '⏳'}</div>
          <b style={{ fontSize: 20 }}>{sonuc.mesaj}</b>
          {sonuc.guc === 'jeton' && <div className="tq-silik">Bu tarayıcı güçlü anahtar üretemedi; bağ zayıf (merkez görür).</div>}
          {sonuc.tur === 'telefon' && <div className="tq-not">Artık giriş / çıkış için şubedeki tabletin QR'ını okutman yeterli.</div>}
          {sonuc.tur === 'tablet' && <div className="tq-not">Merkez onaylayınca şube paneli köşede QR göstermeye başlar. Paneli hep BU tarayıcıda (normal pencerede) aç.</div>}
          {sonuc.tur === 'tablet' && sonuc.sube_id && (
            <a className="tq-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}
               href={`/panel/${encodeURIComponent(sonuc.sube_id)}`}>🧾 Şube panelini aç</a>
          )}
          {sonuc.tur === 'telefon' && <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">Durumumu gör</a>}
        </div>
      ) : (
        <div className="tq-kart">
          <b style={{ fontSize: 19 }}>Bu cihaz sana bağlanacak</b>
          <div className="tq-not">Merkezin gönderdiği bağlantı tek kullanımlık. Bağlanınca bu telefon senin adına giriş / çıkış yapar — şifre, PIN yok.</div>
          {varTel && <div className="tq-silik">Bu tarayıcıda zaten bağlı bir telefon kaydı var; yeniden bağlarsan eski bağ bu telefonda biter.</div>}
          {hata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="tq-btn tq-ana" disabled={mesgul} onClick={bagla}>{mesgul ? 'Bağlanıyor…' : '📱 BU CİHAZI BAĞLA'}</button>
          <div className="tq-silik">iPhone'da Safari: sayfayı "Ana ekrana ekle" ile açıp oradan bağlarsan bağ o kapta kalır.</div>
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
  const [tutmuyorAc, setTutmuyorAc] = useState(false);   // devralan "Tutmuyor" → kısa not alanı (K5: devir yine tamamlanır)
  const [notYazi, setNotYazi] = useState('');
  const istek = useRef({});                      // işlem → istek_id (giriş / çıkış / mola / devret / kabul ayrı); tekrar denemede AYNI
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}`)
      .then(setBen).catch((e) => setHata(e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'Okunamadı')));
  }, [bagli, sube]);
  useEffect(() => { yukle(); }, [yukle]);

  if (!bagli) return <TanimliDegil />;
  const yapabilir = ben?.yapabilir || [];
  // Büyük düğme: giriş → mola başlat / molayı bitir; ÇIKIŞ ikinci, sade düğme (§A2 "Girdi" satırı)
  const ana = yapabilir.includes('giris') ? 'giris' : yapabilir.includes('mola_bitir') ? 'mola-bitir' : yapabilir.includes('mola_baslat') ? 'mola-baslat' : null;
  const cikisVar = yapabilir.includes('cikis');
  // 💵 Kasa devri (§A2 devir satırları, §B8): devreden → DEVREDİYORUM · devralan → KABUL EDİYORUM / Tutmuyor (+ not). Onay sürüme bağlı.
  const devir = ben?.devir || null;
  const devret = !!devir && devir.rol === 'devreden' && yapabilir.includes('devret');
  const kabul = !!devir && devir.rol === 'devralan' && yapabilir.includes('kabul');
  const devirVar = devret || kabul;
  const islemVar = !!ana || cikisVar || devirVar;
  const konumHazir = konum.durum !== 'bekliyor' || !!ben?.muaf;
  // islem: giris | cikis | mola-baslat | mola-bitir | devret | kabul · ek: kabulde { tutuyor, not }
  const yap = async (islem, ek) => {
    if (!islem || mesgul) return;
    // her işlemin KENDİ istek_id'si; tekrar denemede aynı. Codex: kabul ile 'tutmuyor' AYRI kimlik → biri sunucuda tamamlandıysa
    // diğeri 409 alır (karar sessizce değişmez)
    const anahtar = islem === 'kabul' && ek && ek.tutuyor === false ? 'kabul-tutmuyor' : islem;
    if (!istek.current[anahtar]) istek.current[anahtar] = yeniIstekId();
    setMesgul(true); setIsHata(null);
    const devirIslem = islem === 'devret' || islem === 'kabul';
    const yol = devirIslem ? `/api/evvel-yeni/yoklama/devir/${encodeURIComponent(devir.id)}/${islem}` : `/api/evvel-yeni/yoklama/${islem}`;
    try {
      const r = await imzaliJson('telefon', 'POST', yol,
        { sube, qr: jeton, lat: konum.lat, lng: konum.lng, istek_id: istek.current[anahtar], ...(devirIslem ? { surum: devir.surum } : {}), ...(ek || {}) });
      const eskiSaat = islem === 'giris' ? ben.giris : islem === 'cikis' ? ben.cikis : islem === 'mola-baslat' ? ben.mola?.bas : islem === 'mola-bitir' ? ben.mola?.bit : null;
      const gosterim = islem === 'kabul' && ek && ek.tutuyor === false ? 'tutmuyor' : islem;
      setSonuc({ islem: gosterim, mesaj: r.mesaj, hak_dustu: !!r.hak_dustu, saat: (r.mesaj || '').match(/\d{2}:\d{2}/)?.[0] || (r.tekrar && eskiSaat) || saatSimdi(), tekrar: !!r.tekrar });
    } catch (e) {
      if (e instanceof TypeError) setIsHata({ islem, metin: 'İnternet yok — bağlantı gelince tekrar dene', tekrar: true });
      else {
        setIsHata({ islem, metin: e?.message || 'Kaydedilemedi', tekrar: e?.status >= 500 || e?.status === 429 });
        if (devirIslem && e?.status === 409) { istek.current[islem] = null; yukle(); }   // "Devir formu değişti — tekrar bak" → /ben yenilenir, yeni sürüm gelir
      }
    }
    setMesgul(false);
  };
  const baslik = { giris: 'Giriş', cikis: 'Çıkış', 'mola-baslat': 'Mola başladı', 'mola-bitir': 'Mola bitti', devret: 'Devrettin', kabul: 'Devir tamam', tutmuyor: 'Devir kaydedildi' };
  const etiket = { giris: '✅ GİRİŞ YAP', cikis: '🚪 ÇIKIŞ YAP', 'mola-baslat': '🍽 YEMEK MOLASI BAŞLAT', 'mola-bitir': '🍽 MOLAYI BİTİR', devret: '🔁 DEVREDİYORUM', kabul: '✅ KABUL EDİYORUM' };
  const dugmeYazi = (islem) => (mesgul ? 'Gönderiliyor…' : isHata?.tekrar && isHata.islem === islem ? '🔁 TEKRAR DENE' : etiket[islem]);
  return (
    <>
      <Marka alt={ben?.sube_ad ? `${ben.sube_ad} · ${gunYazi(ben.gun)}` : 'Yoklama'} />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, color: T.yesil, lineHeight: 1 }}>✓</div>
          <b style={{ fontSize: 26 }}>{baslik[sonuc.islem]} {sonuc.saat}</b>
          <div className="tq-not">{sonuc.mesaj}</div>
          {sonuc.hak_dustu && <div className="tq-not">Bugün yemek hakkı kazanılamadı</div>}
          <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">Durumumu gör</a>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !ben && <div className="tq-not">Hazırlanıyor…</div>}
          {ben && (<>
            <div style={{ fontSize: 22, fontWeight: 800 }}>👤 {ben.kisi}</div>
            <div className="tq-not">
              {ben.muaf ? 'konum: yönetici (muaf)' : konum.durum === 'ok' ? 'konum ✓' : konum.durum === 'bekliyor' ? 'konum alınıyor…' : konum.hata}
              {!ben.muaf && konum.durum === 'hata' && <> · <button type="button" onClick={konumAl} style={{ font: 'inherit', color: T.aksan, background: 'none', border: 'none', padding: 0, fontWeight: 700, minHeight: 44 }}>tekrar dene</button></>}
            </div>
            {(ben.giris || ben.cikis) && <div className="tq-silik">Bugün: giriş {ben.giris || '—'} · çıkış {ben.cikis || '—'}</div>}
            <MolaSatiri mola={ben.mola} />
            {ben.acik && ben.acik_sube && ben.acik_sube !== sube && <div style={{ color: T.kirmizi, fontWeight: 700 }}>Önce {ben.acik_sube_ad || 'diğer şube'}'den çıkış yap</div>}
            {isHata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata.metin}</div>}
            {devirVar && (<>
              <DevirKarti devir={devir} />
              {devret && (
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir} onClick={() => yap('devret')}>{dugmeYazi('devret')}</button>
              )}
              {kabul && !tutmuyorAc && (<>
                <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={() => yap('kabul', { tutuyor: true })}>{dugmeYazi('kabul')}</button>
                <button className="tq-btn tq-kucuk" disabled={mesgul} onClick={() => setTutmuyorAc(true)}>Tutmuyor</button>
              </>)}
              {kabul && tutmuyorAc && (<>
                <div className="tq-not">Tutmayan neyse kısaca yaz (zorunlu) — devir yine sende kalır, notun merkeze gider.</div>
                <input value={notYazi} onChange={(e) => setNotYazi(e.target.value.slice(0, 200))} placeholder="ör. çekmecede 1.180 ₺" autoFocus
                  style={{ minHeight: 56, borderRadius: 12, border: `1px solid ${T.kenar}`, background: T.yuzey, color: T.metin, font: 'inherit', fontSize: 18, padding: '10px 14px', width: '100%' }} />
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir || notYazi.trim().length < 2} onClick={() => yap('kabul', { tutuyor: false, not: notYazi.trim() })}>
                  {mesgul ? 'Gönderiliyor…' : isHata?.tekrar && isHata.islem === 'kabul' ? '🔁 TEKRAR DENE' : '⚠ TUTMUYOR — GÖNDER'}
                </button>
                <button className="tq-btn tq-kucuk" disabled={mesgul} onClick={() => setTutmuyorAc(false)}>Vazgeç</button>
              </>)}
            </>)}
            {ana && (
              <button className={'tq-btn ' + (devirVar ? 'tq-kucuk' : ana === 'giris' ? 'tq-yesil' : 'tq-ana')} disabled={mesgul || !konumHazir} onClick={() => yap(ana)}>
                {dugmeYazi(ana)}
              </button>
            )}
            {cikisVar && (
              <button className={'tq-btn ' + (ana || devirVar ? 'tq-kucuk' : 'tq-ana')} disabled={mesgul || !konumHazir} onClick={() => yap('cikis')}>
                {dugmeYazi('cikis')}
              </button>
            )}
            {!islemVar && !ben.acik && <div className="tq-silik">Bu QR ile yapılacak işlem yok.</div>}
          </>)}
        </div>
      )}
    </>
  );
}

// ── /q/{sube}/{jeton}?o={onay}: panelde açılış / kapanış formu doldu → "QR ile onayla" (PANEL_YENIDEN_KURULUM R1) ──
// Kişi telefondan tanınır (PIN yok); önce bu şubede girişi yoksa GİRİŞ YAP (aynı QR), sonra özet + ONAYLA.
const onayKimligi = () => {
  try { const o = new window.URLSearchParams(window.location.search).get('o') || ''; return /^[A-Za-z0-9-]{1,40}$/.test(o) ? o : ''; } catch { return ''; }
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
  const istek = useRef({});
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    Promise.all([
      imzaliJson('telefon', 'GET', `/api/evvel-yeni/panel/onay/${encodeURIComponent(onay)}/ozet`),
      imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}`),
    ]).then(([o, b]) => { setOzet(o); setBen(b); })
      .catch((e) => setHata(e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'Okunamadı')));
  }, [bagli, onay, sube]);
  useEffect(() => { yukle(); }, [yukle]);
  if (!bagli) return <TanimliDegil />;

  const konumHazir = konum.durum !== 'bekliyor' || !!ben?.muaf;
  const girisGerek = (ben?.yapabilir || []).includes('giris');
  const gecerli = ozet && (ozet.durum === 'bekliyor' || ozet.durum === 'hata');
  const yap = async (islem) => {
    if (mesgul) return;
    if (!istek.current[islem]) istek.current[islem] = yeniIstekId();   // tekrar denemede AYNI kimlik
    setMesgul(true); setIsHata(null);
    const yol = islem === 'giris' ? '/api/evvel-yeni/yoklama/giris' : `/api/evvel-yeni/panel/onay/${encodeURIComponent(onay)}/onayla`;
    try {
      const r = await imzaliJson('telefon', 'POST', yol, { sube, qr: jeton, lat: konum.lat, lng: konum.lng, istek_id: istek.current[islem] });
      if (islem === 'giris') { yukle(); }
      else setSonuc({ mesaj: r.mesaj, kuru: !!r.kuru });
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
          <b style={{ fontSize: 24 }}>{ozet?.ad || 'İşlem'} onaylandı · {saatSimdi()}</b>
          <div className="tq-not">{sonuc.mesaj}</div>
          <div className="tq-silik">Panel birkaç saniye içinde kendiliğinden geçer.</div>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !ozet && <div className="tq-not">Hazırlanıyor…</div>}
          {ozet && (<>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{TUR_IKON[ozet.tur] || '✔'} {ozet.ad} · {ozet.sube_ad}</div>
            <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: 12, fontSize: 17 }}>{ozet.ozet || '—'}</div>
            <div className="tq-not">Onaylayan: <b>👤 {ozet.kisi}</b> · {ben?.muaf ? 'konum: yönetici (muaf)' : konum.durum === 'ok' ? 'konum ✓' : konum.durum === 'bekliyor' ? 'konum alınıyor…' : konum.hata}
              {!ben?.muaf && konum.durum === 'hata' && <> · <button type="button" onClick={konumAl} style={{ font: 'inherit', color: T.aksan, background: 'none', border: 'none', padding: 0, fontWeight: 700, minHeight: 44 }}>tekrar dene</button></>}
            </div>
            {isHata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata.metin}</div>}
            {!gecerli && <div style={{ color: T.kirmizi, fontWeight: 700 }}>
              {ozet.durum === 'onaylandi' ? `Bu işlem zaten onaylandı${ozet.mesaj ? ' — ' + ozet.mesaj : ''}` : ozet.durum === 'sure_doldu' ? 'Onayın süresi doldu — panelden yeniden iste' : 'Bu onay artık geçerli değil — panelden yeniden iste'}
            </div>}
            {gecerli && girisGerek && (<>
              <div className="tq-not">Önce bu şubeye girişini yap — sonra onaylarsın (aynı QR yeter).</div>
              <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={() => yap('giris')}>{yazi('giris', '✅ GİRİŞ YAP')}</button>
            </>)}
            {gecerli && !girisGerek && (
              <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir} onClick={() => yap('onayla')}>{yazi('onayla', `✅ ONAYLA — ${ozet.ad || ''}`)}</button>
            )}
          </>)}
        </div>
      )}
    </>
  );
}

// ── /q: salt durum ──
function Durum() {
  const bagli = !!cihazId('telefon');
  const [ben, setBen] = useState(null);
  const [hata, setHata] = useState('');
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', '/api/evvel-yeni/yoklama/ben').then(setBen)
      .catch((e) => setHata(e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || 'Okunamadı')));
  }, [bagli]);
  useEffect(() => { yukle(); }, [yukle]);
  if (!bagli) return <TanimliDegil />;
  return (
    <>
      <Marka alt="Bugünkü durumun" />
      <div className="tq-kart">
        {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
        {!hata && !ben && <div className="tq-not">Hazırlanıyor…</div>}
        {ben && (<>
          <div style={{ fontSize: 22, fontWeight: 800 }}>👤 {ben.kisi}</div>
          <div className="tq-silik">{gunYazi(ben.gun)}</div>
          <div style={{ fontSize: 18 }}>Giriş: <b>{ben.giris || '—'}</b> · Çıkış: <b>{ben.cikis || '—'}</b></div>
          {ben.acik && <div style={{ color: T.yesil, fontWeight: 700 }}>İçeridesin{ben.acik_sube_ad ? ` · ${ben.acik_sube_ad}` : ''}</div>}
          <MolaSatiri mola={ben.mola} />
          <div className="tq-not">Giriş / çıkış / yemek molası için şubedeki tabletin QR'ını okut.</div>
        </>)}
      </div>
    </>
  );
}

// ── Kasa devri kartı (§A2): "Kasa: 1.250 ₺ · bardak küçük 40 / büyük 30 / plastik 20 → Mehmet"; devralanda "girişin bununla açılır" ──
const tlYazi = (x) => (Number(x || 0)).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
const bardakOzet = (b) => (b || []).map((x) => `${String(x.ad || '').replace(/^bardak\s*/i, '') || 'bardak'} ${x.sayilan}`).join(' / ');
function DevirKarti({ devir }) {
  const devralan = devir.rol === 'devralan';
  return (
    <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 4 }}>
      <div className="tq-silik">{devralan ? `${devir.devreden} sana devrediyor${devir.devreden_saat ? ` · ${devir.devreden_saat}` : ''}` : 'Kasa devri'}</div>
      <div style={{ fontSize: 18, fontWeight: 800 }}>
        Kasa: {tlYazi(devir.sayilan)}{devir.bardak?.length ? <> · bardak {bardakOzet(devir.bardak)}</> : null}{!devralan && <> → {devir.devralan}</>}
      </div>
      {devralan && devir.giris_acilir && <div className="tq-not">Girişin bununla açılır.</div>}
    </div>
  );
}

// ── Yemek molası satırı (K7): sürüyor → "Mola 12:30'dan beri · 18 dk"; bitti → "Mola 12:30–13:05 · 35 dk";
//    hak düştüyse altında TEK bilgi satırı (kırmızı değil, bildirim değil) ──
function MolaSatiri({ mola }) {
  if (!mola) return null;
  return (
    <>
      <div style={{ fontSize: 17 }}>
        🍽 {mola.durum === 'suruyor' ? <>Mola <b>{mola.bas}</b>'dan beri · <b>{mola.sure_dk} dk</b></> : <>Mola {mola.bas}–{mola.bit || '—'} · <b>{mola.sure_dk ?? '—'} dk</b></>}
      </div>
      {mola.hak_dustu && <div className="tq-not">{mola.otomatik ? `Mola ${mola.sure_dk ?? 61} dakikayı geçti — sistem kapattı, yemek hakkını kaybettin` : 'Bugün yemek hakkı kazanılamadı'}</div>}
    </>
  );
}

function TanimliDegil() {
  return (
    <>
      <Marka alt="Yoklama" />
      <div className="tq-kart" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 44 }}>📵</div>
        <b style={{ fontSize: 20 }}>Bu telefon tanımlı değil</b>
        <div className="tq-not">Merkezden bağlantı linki iste; link bu telefonda açılınca bağlanır.</div>
      </div>
    </>
  );
}
