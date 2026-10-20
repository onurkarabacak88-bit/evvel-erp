// 📱 TELEFON SAYFASI — Evvel Yeni yoklama (YOKLAMA_QR_TASARIM.md §A2; sunucu: evvel_yeni_yoklama_api.py)
// Adresler: /q/bagla/{davet} (merkezin linki → bu telefon kişinin olur) · /q/{sube}/{jeton} (paneldeki QR okutunca: tek büyük düğme
// GİRİŞ / YEMEK MOLASI BAŞLAT / MOLAYI BİTİR + sade ÇIKIŞ; K7 hak düştüyse tek bilgi satırı) · /q (salt durum). Menüsüz tam ekran, AÇIK TuliPi teması (design_qr_personel_marka). PIN yok; uyarı personele gitmez —
// yalnız işlemin sonucu tek cümle. Düğmeler ≥ 56px. Ağ düşerse AYNI istek_id ile "Tekrar dene" (sunucu ikinci kez yazmaz).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import tulipiLogo from '../../assets/tulipi-logo.jpg';
import { cihazBagla, cihazId, imzaliJson, yeniIstekId } from '../../utils/cihazImza';
import { paraGecerli, sayiTR, tlYaz } from '../../utils/trSayi';
import { bardakOzet, kalemYazi } from '../../utils/devirOzet';

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

// ── Ortak küçük yardımcılar (Dalga 5, F#60/F#61: adres parametresi 3 kopya, konum satırı 2 kopya, ağ hatası mesajı 6 kopya) ──
const urlKimlik = (ad) => {   // ?o= / ?tb= / ?dv= — yalnız güvenli kimlik
  try { const v = new window.URLSearchParams(window.location.search).get(ad) || ''; return /^[A-Za-z0-9-]{1,40}$/.test(v) ? v : ''; } catch { return ''; }
};
const agMesaji = (e, varsayilan) => (e instanceof TypeError ? 'İnternet yok — tekrar dene' : (e?.message || varsayilan));
function KonumSatiri({ muaf, konum, konumAl }) {
  return (<>
    {muaf ? 'konum: yönetici (muaf)' : konum.durum === 'ok' ? 'konum ✓' : konum.durum === 'bekliyor' ? 'konum alınıyor…' : konum.hata}
    {!muaf && konum.durum === 'hata' && <> · <button type="button" onClick={konumAl} style={{ font: 'inherit', color: T.aksan, background: 'none', border: 'none', padding: 0, fontWeight: 700, minHeight: 44 }}>tekrar dene</button></>}
  </>);
}

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
      {mod === 'qr' && (onayKimligi() ? <OnayIslem sube={sube} jeton={jeton} onay={onayKimligi()} />
        : devirKimligi() ? <DevirIslem sube={sube} jeton={jeton} did={devirKimligi()} />
        : teslimKimligi() ? <FaturaCek sube={sube} tid={teslimKimligi()} /> : <QrIslem sube={sube} jeton={jeton} />)}
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
    catch (e) { setHata(agMesaji(e, 'Bağlanamadı')); }
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
  const [sayYazi, setSayYazi] = useState('');    // sahip: tutmuyorsa devralanın KENDİ saydığı kasa tutarı (zorunlu)
  const istek = useRef({});                      // işlem → istek_id (giriş / çıkış / mola / devret / kabul ayrı); tekrar denemede AYNI
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}`)
      .then(setBen).catch((e) => setHata(agMesaji(e, 'Okunamadı')));
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
          {sonuc.islem === 'giris' && <div className="tq-not">🍽 Yemek molasına çıkarken paneldeki QR'ı <b>tekrar okut</b> → "Yemek molası başlat".</div>}
          <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">Durumumu gör</a>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !ben && <div className="tq-not">Hazırlanıyor…</div>}
          {ben && (<>
            <div style={{ fontSize: 22, fontWeight: 800 }}>👤 {ben.kisi}</div>
            <div className="tq-not">
              <KonumSatiri muaf={ben.muaf} konum={konum} konumAl={konumAl} />
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
                <div className="tq-not">Kasada kendi saydığın tutarı yaz (zorunlu) — devir yine sende kalır, fark merkeze gider.</div>
                <input value={sayYazi} onChange={(e) => setSayYazi(e.target.value.replace(/[^\d,]/g, '').slice(0, 12))} placeholder="Saydığım tutar (₺)" inputMode="decimal" autoFocus style={GIRDI} />
                <input value={notYazi} onChange={(e) => setNotYazi(e.target.value.slice(0, 200))} placeholder="Not (isteğe bağlı)" style={GIRDI} />
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir || !sayYazi} onClick={() => yap('kabul', { tutuyor: false, sayilan: sayYazi, not: notYazi.trim() })}>
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
            <AvansKart />
          </>)}
        </div>
      )}
    </>
  );
}

// ── 🤝 AVANS TALEBİ (1 Kasım — kesim engeli T3-17, sahip 20 Eki: tavan eski oran; "aldım" onayı YOK) ──
// Tavan / kullanılabilir sunucudan (Maaş'ın hak edişi). Açık talep varken yenisi açılmaz. 1 Kasım öncesi kart görünmez (eski sayfa).
function AvansKart() {
  const [d, setD] = useState(null);
  const [ac, setAc] = useState(false);
  const [tut, setTut] = useState('');
  const [not, setNot] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [msj, setMsj] = useState(null);
  const istek = useRef(null);
  const yukle = () => imzaliJson('telefon', 'GET', '/api/evvel-yeni/yoklama/avans').then(setD).catch(() => setD(null));
  useEffect(() => { yukle(); }, []);
  if (!d || d.kapali) return null;
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
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.kenar}`, display: 'grid', gap: 8 }}>
      <b>🤝 Avans</b>
      {d.acik ? <div className="tq-not">Açık talebin: <b>{para(d.acik.tutar)}</b> — {d.acik.durum === 'talep' ? 'merkez bakıyor' : d.acik.yontem === 'elden' ? 'onaylandı, şubeden elden verilecek' : 'onaylandı'}</div>
        : d.kullanilabilir > 0 ? <div className="tq-silik">Bu ay en çok {para(d.kullanilabilir)} isteyebilirsin</div>
        : <div className="tq-silik">Bu ay avans hakkın yok (hak ediş oluşmadı ya da doldu)</div>}
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
      imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/ben?sube=${encodeURIComponent(sube)}`),
    ]).then(([o, b]) => { setOzet(o); setBen(b); })
      .catch((e) => setHata(agMesaji(e, 'Okunamadı')));
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
            <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: 12, fontSize: 17 }}>{ozet.ozet || '—'}</div>
            <div className="tq-not">Onaylayan: <b>👤 {ozet.kisi}</b> · <KonumSatiri muaf={!!ben?.muaf} konum={konum} konumAl={konumAl} />
            </div>
            {girisMesaj && <div style={{ color: T.yesil, fontWeight: 700 }}>{girisMesaj}</div>}
            {isHata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata.metin}</div>}
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
              <button className="tq-btn tq-kucuk" disabled={mesgul || !konumHazir} onClick={() => { if (window.confirm('Kapanışı SEN yapmıyorsun — yalnız çıkışın yazılsın mı?')) yap('cikis'); }}>{yazi('cikis', '🚪 Sadece çıkış yap')}</button>
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
function Durum() {
  const bagli = !!cihazId('telefon');
  const [ben, setBen] = useState(null);
  const [hata, setHata] = useState('');
  const yukle = useCallback(() => {
    if (!bagli) return;
    setHata('');
    imzaliJson('telefon', 'GET', '/api/evvel-yeni/yoklama/ben').then(setBen)
      .catch((e) => setHata(agMesaji(e, 'Okunamadı')));
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
          {ben.acik && !ben.mola && <div className="tq-not">🍽 Yemek molası: henüz başlamadı — başlatmak için paneldeki QR'ı okut.</div>}
          <div className="tq-not">Giriş / çıkış / yemek molası için şubedeki tabletin QR'ını okut.</div>
        </>)}
      </div>
    </>
  );
}

const GIRDI = { minHeight: 56, borderRadius: 12, border: `1px solid ${T.kenar}`, background: T.yuzey, color: T.metin, font: 'inherit', fontSize: 18, padding: '10px 14px', width: '100%' };

// ── /q/{sube}/{jeton}?dv={devir}: panelde "Devri başlat" → devir QR'ı (PANEL_YENIDEN_KURULUM Basamak 4, sahip 2026-10-19) ──
// İlk okutan İÇERİDEKİ kişi otomatik devreden olur → 15 dk içinde telefonda eski 5 adım (kasa · bardak · ürün · pasta · onay) →
// DEVREDİYORUM. Devreden onaylayınca devredenden farklı okutan KABUL EDİYORUM / Tutmuyor + kendi saydığı tutar → girişi açılır.
const devirKimligi = () => {
  return urlKimlik('dv');
};

function DevirIslem({ sube, jeton, did }) {
  const bagli = !!cihazId('telefon');
  const [b, setB] = useState(null);          // /devir/{did}/telefon
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
  const [f, setF] = useState(ilk?.f || { kasa: '', s: {}, pasta: '', dogru: false, adina: '' });
  const [tutmuyor, setTutmuyor] = useState(!!ilk?.tutmuyor);
  const [say, setSay] = useState(ilk?.say || '');
  const [notY, setNotY] = useState(ilk?.notY || '');
  useEffect(() => { try { localStorage.setItem(tKey, JSON.stringify({ adim, f, tutmuyor, say, notY })); } catch { /* yok */ } }, [adim, f, tutmuyor, say, notY, tKey]);

  const yukle = useCallback(() => {
    if (!bagli) return Promise.resolve(null);
    setHata('');
    return imzaliJson('telefon', 'GET', `/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/telefon?sube=${encodeURIComponent(sube)}`)
      .then((x) => { setB(x); return x; })
      .catch((e) => { setHata(agMesaji(e, 'Okunamadı')); return null; });
  }, [bagli, did, sube]);
  useEffect(() => { yukle(); }, [yukle]);

  const konumHazir = konum.durum !== 'bekliyor' || !!b?.muaf;
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
  // Sahip: ilk okutan içerideki kişi OTOMATİK devreden (soru yok) — konum hazır olunca bir kez
  useEffect(() => {
    if (!b || otomatik.current || b.rol !== 'ustlenebilir' || !b.icerde || b.baska_subede || !konumHazir) return;
    otomatik.current = true;
    gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/ustlen`, { qr: jeton }, 'ustlen').then((r) => { if (r) yukle(); });
  }, [b, konumHazir]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!bagli) return <TanimliDegil />;
  const d = b?.devir;
  const liste = b?.liste || { bardak: [], urun: [] };
  const tl = (x) => tlYaz(x);
  const kalemDolu = (l) => l.every((u) => f.s[u.id] !== undefined && f.s[u.id] !== '');
  const kasaGecerli = paraGecerli(f.kasa);   // TEK para kuralı (F#57; sunucu ayrıca 1.000.000 üst sınırı uygular)
  const sayiKutu = (u) => (
    <label key={u.id} style={{ display: 'grid', gap: 4 }}><span className="tq-not">{u.ad}</span>
      <input style={GIRDI} inputMode="numeric" placeholder="0" value={f.s[u.id] ?? ''}
        onChange={(e) => setF((o) => ({ ...o, s: { ...o.s, [u.id]: e.target.value.replace(/\D/g, '').slice(0, 6) } }))} /></label>
  );
  const ozet = (x) => (
    <div style={{ background: T.yuzey, border: `1px solid ${T.kenar}`, borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 4 }}>
      <div style={{ fontSize: 18, fontWeight: 800 }}>💰 Kasa: {tl(x.kasa)}</div>
      <div>🥤 {kalemYazi(x.bardak)}</div>
      <div>📦 {kalemYazi(x.urunler)}</div>
      <div>🍰 Pasta: {x.pasta ?? '—'}</div>
    </div>
  );
  const formOzet = {
    kasa: sayiTR(f.kasa || '0', 0),
    bardak: liste.bardak.map((u) => ({ ad: u.ad, sayilan: f.s[u.id] })), urunler: liste.urun.map((u) => ({ ad: u.ad, sayilan: f.s[u.id] })), pasta: f.pasta,
  };
  const devret = async () => {
    const r = await gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/devret`, {
      kasa: f.kasa || '', pasta: f.pasta, dogruladim: !!f.dogru, adina: f.adina || null,
      bardak: liste.bardak.map((u) => ({ urun_id: u.id, sayilan: f.s[u.id] })), urunler: liste.urun.map((u) => ({ urun_id: u.id, sayilan: f.s[u.id] })),
    }, 'devret');
    if (r) { try { localStorage.removeItem(tKey); } catch { /* yok */ } setSonuc({ baslik: 'Devrettin', mesaj: r.mesaj }); }
    else yukle();
  };
  const kabul = async (tutuyor) => {
    const r = await gonder(`/api/evvel-yeni/yoklama/devir/${encodeURIComponent(did)}/kabul`,
      { qr: jeton, surum: d?.surum, tutuyor, ...(tutuyor ? {} : { sayilan: say, not: notY.trim() }) }, tutuyor ? 'kabul' : 'kabul-tutmuyor');
    if (r) { try { localStorage.removeItem(tKey); } catch { /* yok */ } setSonuc({ baslik: tutuyor ? 'Devir tamam' : 'Devir kaydedildi', mesaj: r.mesaj }); }
    else yukle();
  };
  const girisYap = async () => {
    const r = await gonder('/api/evvel-yeni/yoklama/giris', { qr: jeton }, 'giris');
    if (r) { otomatik.current = false; yukle(); }
  };

  return (
    <>
      <Marka alt={b?.sube_ad ? `${b.sube_ad} · kasa devri` : 'Kasa devri'} />
      {sonuc ? (
        <div className="tq-kart" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 72, color: T.yesil, lineHeight: 1 }}>✓</div>
          <b style={{ fontSize: 24 }}>{sonuc.baslik} · {saatSimdi()}</b>
          <div className="tq-not">{sonuc.mesaj}</div>
          <a className="tq-btn tq-kucuk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }} href="/q">Durumumu gör</a>
        </div>
      ) : (
        <div className="tq-kart">
          {hata && <><div style={{ color: T.kirmizi, fontWeight: 700 }}>{hata}</div><button className="tq-btn tq-kucuk" onClick={yukle}>Tekrar dene</button></>}
          {!hata && !b && <div className="tq-not">Hazırlanıyor…</div>}
          {b && (<>
            <div style={{ fontSize: 20, fontWeight: 800 }}>👤 {b.kisi}</div>
            <div className="tq-not">{b.muaf ? 'konum: yönetici (muaf)' : konum.durum === 'ok' ? 'konum ✓' : konum.durum === 'bekliyor' ? 'konum alınıyor…' : konum.hata}
              {!b.muaf && konum.durum === 'hata' && <> · <button type="button" onClick={konumAl} style={{ font: 'inherit', color: T.aksan, background: 'none', border: 'none', padding: 0, fontWeight: 700, minHeight: 44 }}>tekrar dene</button></>}</div>
            {isHata && <div style={{ color: T.kirmizi, fontWeight: 700 }}>{isHata}</div>}

            {b.rol === 'ustlenebilir' && b.baska_subede && <div style={{ color: T.kirmizi, fontWeight: 700 }}>Önce diğer şubeden çıkış yap</div>}
            {b.rol === 'ustlenebilir' && !b.icerde && !b.baska_subede && (<>
              <div className="tq-not">Kasayı devretmek için önce bu şubeye girişini yap (aynı QR).</div>
              <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={girisYap}>{mesgul ? 'Gönderiliyor…' : '✅ GİRİŞ YAP'}</button>
            </>)}
            {b.rol === 'ustlenebilir' && b.icerde && <div className="tq-not">{mesgul ? 'Devir sana bağlanıyor…' : 'Hazırlanıyor…'}</div>}
            {b.rol === 'ustlenebilir' && b.icerde && isHata && <button className="tq-btn tq-kucuk" onClick={() => { otomatik.current = false; yukle(); }}>Tekrar dene</button>}

            {b.rol === 'bekle' && <div className="tq-not">⏳ {d?.ustlenen || 'Başka biri'} şu an kasayı devrediyor — o bitirince devralan isen bu QR'ı yeniden okut.</div>}
            {b.rol === 'devreden_bekle' && <div className="tq-not">✓ Gönderdin. Şimdi devralan paneldeki QR'ı okutup kabul etsin.</div>}
            {b.rol === 'bitti' && <div className="tq-not">Bu devir kapandı ({d?.durum === 'tamam' ? `✓ ${d?.devralan || ''} devraldı` : d?.durum || '—'}).</div>}

            {b.rol === 'form' && (<>
              <div className="tq-silik">Adım {adim} / 5 · {b.pencere_dk} dk içinde gönder</div>
              {adim === 1 && (<>
                <b>💰 Kasadaki nakit (₺)</b>
                <div className="tq-not">Para kasada kalır, hesaplamalara girmez.</div>
                <input style={GIRDI} inputMode="decimal" placeholder="0" value={f.kasa} onChange={(e) => setF((o) => ({ ...o, kasa: e.target.value.replace(/[^\d,]/g, '').slice(0, 11) }))} />
              </>)}
              {adim === 2 && (<><b>🥤 Bardaklar</b>{liste.bardak.map(sayiKutu)}</>)}
              {adim === 3 && (<><b>📦 Ürünler</b>{liste.urun.map(sayiKutu)}</>)}
              {adim === 4 && (<>
                <b>🍰 Pasta (toplam adet)</b>
                <input style={GIRDI} inputMode="numeric" placeholder="0" value={f.pasta} onChange={(e) => setF((o) => ({ ...o, pasta: e.target.value.replace(/\D/g, '').slice(0, 5) }))} />
              </>)}
              {adim === 5 && (<>
                <b>✅ Özet</b>
                {ozet(formOzet)}
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: 48 }}>
                  <input type="checkbox" style={{ width: 24, height: 24 }} checked={!!f.dogru} onChange={(e) => setF((o) => ({ ...o, dogru: e.target.checked }))} />
                  <span>Kasadaki nakit sayımını doğruladım</span>
                </label>
                {(b.digerleri || []).length > 0 && (
                  <label style={{ display: 'grid', gap: 4 }}><span className="tq-silik">Devreden kim? (telefonu olmayan adına)</span>
                    <select style={GIRDI} value={f.adina} onChange={(e) => setF((o) => ({ ...o, adina: e.target.value }))}>
                      <option value="">Ben ({b.kisi})</option>
                      {b.digerleri.map((x) => <option key={x.id} value={x.id}>{x.ad} adına (telefonu yok)</option>)}
                    </select></label>
                )}
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir || !f.dogru} onClick={devret}>{mesgul ? 'Gönderiliyor…' : '🔁 DEVREDİYORUM'}</button>
              </>)}
              <div style={{ display: 'flex', gap: 8 }}>
                {adim > 1 && <button className="tq-btn tq-kucuk" style={{ flex: 1 }} disabled={mesgul} onClick={() => { setIsHata(''); setAdim(adim - 1); }}>« Geri</button>}
                {adim < 5 && <button className="tq-btn tq-kucuk tq-yesil" style={{ flex: 2 }}
                  onClick={() => {
                    setIsHata('');
                    if (adim === 1 && !kasaGecerli) { setIsHata('Kasadaki nakdi yaz'); return; }
                    if (adim === 2 && !kalemDolu(liste.bardak)) { setIsHata('Her bardağın adedini yaz (yoksa 0)'); return; }
                    if (adim === 3 && !kalemDolu(liste.urun)) { setIsHata('Her ürünün adedini yaz (yoksa 0)'); return; }
                    if (adim === 4 && f.pasta === '') { setIsHata('Pasta adedini yaz (yoksa 0)'); return; }
                    setAdim(adim + 1);
                  }}>İleri →</button>}
              </div>
            </>)}

            {b.rol === 'devralan' && d && (<>
              <div className="tq-silik">{d.devreden} sana devrediyor{d.devreden_saat ? ` · ${d.devreden_saat}` : ''}{d.vekil && d.ustlenen ? ` (${d.ustlenen} doldurdu)` : ''}</div>
              {ozet({ kasa: d.sayilan, bardak: d.bardak, urunler: d.urunler, pasta: d.pasta })}
              {!b.icerde && <div className="tq-not">Girişin bununla açılır.</div>}
              {!tutmuyor ? (<>
                <button className="tq-btn tq-yesil" disabled={mesgul || !konumHazir} onClick={() => kabul(true)}>{mesgul ? 'Gönderiliyor…' : '✅ KABUL EDİYORUM'}</button>
                <button className="tq-btn tq-kucuk" disabled={mesgul} onClick={() => setTutmuyor(true)}>Tutmuyor</button>
              </>) : (<>
                <div className="tq-not">Kasada kendi saydığın tutarı yaz (zorunlu) — devir yine sende kalır, fark merkeze gider.</div>
                <input style={GIRDI} inputMode="decimal" placeholder="Saydığım tutar (₺)" value={say} onChange={(e) => setSay(e.target.value.replace(/[^\d,]/g, '').slice(0, 12))} autoFocus />
                <input style={GIRDI} placeholder="Not (isteğe bağlı)" value={notY} onChange={(e) => setNotY(e.target.value.slice(0, 200))} />
                <button className="tq-btn tq-ana" disabled={mesgul || !konumHazir || !say} onClick={() => kabul(false)}>{mesgul ? 'Gönderiliyor…' : '⚠ TUTMUYOR — GÖNDER'}</button>
                <button className="tq-btn tq-kucuk" disabled={mesgul} onClick={() => setTutmuyor(false)}>Vazgeç</button>
              </>)}
            </>)}
          </>)}
        </div>
      )}
    </>
  );
}

// ── Kasa devri kartı (§A2): "Kasa: 1.250 ₺ · bardak küçük 40 / büyük 30 / plastik 20 → Mehmet"; devralanda "girişin bununla açılır" ──
const tlYazi = (x) => tlYaz(x);
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
