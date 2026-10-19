// 🌙 KAPANIŞ SİHİRBAZI — eski sube_panel.html #kapanisModal AYNEN (5778–5900, 6685–6960): 5 adım
// 1 X raporu ciro + KÖR çekmece + teslim + bırakılan · 2 bardak · 3 ürün (+ "Ürün Aç kaydı yok" sorusu) · 4 değirmen + pasta ·
// 5 ☑ X raporu + 📱 QR ile mühür. Sahip kararları (2026-10-19): kapanışçı = QR'ı okutan telefonun sahibi · ikinci kişi aynı QR'la
// "Sadece çıkış yap" · mühürsüz gönder YOK → telefonsuz "📨 Merkeze gönder" (merkez geç kapanış) · ciro doğrudan Kasa'ya ·
// online = nakit+POS koruması · KASA UYARISI PANELDE YOK (sahip: kör sayım; yalnız merkez) · uyarılı kapanış → sarı "EKSİK VAR" + merkez "⚠ Kapanış uyarılı". Kasa sağlaması sunucuda
// Satış'ın TEK hesabıyla (kasa_mutabakat). Tak-çıkar: yalnız props; sunucu uçları panel modülünde.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { CSS_AW, trSaat } from './AcilisSihirbazi';
import { C, sayi, TabletQR, tl, tutar, tutarNum, yeniIstek } from './ortak';

const ICO = ['', '💰', '🥤', '📦', '🍰', '📱'];
const BASLIK = ['', 'Kasa & Ciro', 'Bardak Sayımı', 'Ürün Sayımı', 'Değirmen & Pasta', 'QR ile Mühürle'];
const PARA = /^\d{1,8}(,\d{1,2})?$/;

// 22:30 kuralı (sunucu kesin karar verir): 02:00–22:30 arası kapanış yapılamaz
const kapanisErken = (hhmm) => {
  const [h, m] = String(hhmm || '22:30').split(':').map(Number);
  const [sh, sm] = trSaat(new Date()).split(':').map(Number);
  return sh >= 2 && sh * 60 + sm < h * 60 + (m || 0);
};

export default function KapanisSihirbazi({ d, subeId, tabletVar, kapat, bitti, urunAcaGit, gun: formGunu }) {
  const gun = formGunu || d.gun;   // Codex P1: formun iş günü AÇILDIĞI an sabit — 02:00'de yeniden kurulup rakamlar silinmez
  const urunler = d.sayilan.flatMap((g) => g.urunler);
  const bardakMi = (u) => /bardak/i.test(u.ad) && !/kapa[kğ]|çanta|tutucu/i.test(u.ad);
  const bardaklar = urunler.filter(bardakMi);
  const digerleri = urunler.filter((u) => !bardakMi(u));
  const urunAcVar = d.bugun.some((o) => o.tur === 'urun_ac' && !o.iptal);
  const yok = d.yoklama || {};
  const iceride = (yok.girenler || []).filter((g) => g.acik);
  const anahtar = `sp_taslak:${subeId}:${gun}:kapanis_sihirbaz`;   // iş gününe bağlı (eski: 18 saat)
  const ilk = (() => { try { return JSON.parse(localStorage.getItem(anahtar) || 'null'); } catch { return null; } })();
  useEffect(() => {   // eski günlerin taslakları birikmesin — DÜNÜNKÜ silinmez (gece yarısı gönderilmemiş kapanış kurtarılır)
    try {
      const dun = new Date(new Date(gun + 'T12:00').getTime() - 864e5).toISOString().slice(0, 10);
      Object.keys(localStorage).filter((k) => k.startsWith(`sp_taslak:${subeId}:`) && k.endsWith(':kapanis_sihirbaz') && k !== anahtar
        && (k.split(':')[2] || '') < dun)
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* yok say */ }
  }, [anahtar, subeId, gun]);
  const [adim, setAdim] = useState(ilk?.adim || 1);
  const [yon, setYon] = useState('ileri');
  const [v, setV] = useState(ilk?.v || { nakit: '', pos: '', online: '', kor: '', birakilan: '', teslim: {}, deg: {}, pasta: '', xrapor: false, urunAcYok: false });
  const [sayim, setSayim] = useState(ilk?.sayim || {});
  const [istek] = useState(ilk?.istek || yeniIstek());   // aynı form = aynı kimlik → iki onay gelse de tek kapanış
  const [hata, setHata] = useState('');
  const [onay, setOnay] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [sonuc, setSonuc] = useState(null);   // { tur: 'tamam' | 'uyari' | 'merkeze', mesaj, uyarilar }
  const [agHata, setAgHata] = useState(0);
  const [merkezAc, setMerkezAc] = useState(false);
  const [mKisi, setMKisi] = useState('');
  const [mPin, setMPin] = useState('');   // YALNIZ bellekte
  const [saat, setSaat] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setSaat(new Date()), 10000); return () => window.clearInterval(t); }, []);
  useEffect(() => {   // 💾 her tuşta tablete (eski kapTaslakKaydet)
    if (sonuc) return;
    try { localStorage.setItem(anahtar, JSON.stringify({ adim: Math.min(adim, 4), v, sayim, istek })); } catch { /* yok say */ }
  }, [adim, v, sayim, istek, anahtar, sonuc]);
  const set = (k, x) => setV((o) => ({ ...o, [k]: x }));
  const git = (n) => { setHata(''); setYon(n > adim ? 'ileri' : 'geri'); setAdim(n); };
  const teslimler = Object.entries(v.teslim || {}).filter(([, t]) => tutarNum(t) > 0).map(([alan, t]) => ({ alan, tutar: tutarNum(t) }));
  const govde = () => ({
    istemci_gunu: gun, istek_id: istek, nakit: tutarNum(v.nakit), pos: tutarNum(v.pos), online: tutarNum(v.online), teslimler,
    kor_sayim: tutarNum(v.kor), birakilan: tutarNum(v.birakilan), x_rapor: !!v.xrapor, urun_ac_yok: !urunAcVar && !!v.urunAcYok,
    degirmen: Object.values(v.deg || {}).some((x) => x !== '') ? v.deg : null, pasta_toplam: Number(v.pasta),
    sayim: urunler.map((u) => ({ urun_id: u.id, sayilan: Number(sayim[u.id]) })),
  });
  const zorunlu = (liste) => {
    const bos = liste.find((u) => sayim[u.id] === undefined || sayim[u.id] === '');
    if (bos) { setHata(`${bos.ad} adedini girin`); return false; }
    return true;
  };

  const ebeveyn = useRef({ bitti }); ebeveyn.current = { bitti };
  const sonucOldu = useRef(false);
  const sonucGoster = useCallback((s) => {
    if (sonucOldu.current) return;
    sonucOldu.current = true;
    try { localStorage.removeItem(anahtar); } catch { /* yok say */ }
    setSonuc(s);
    if (s.tur === 'tamam') window.setTimeout(() => ebeveyn.current.bitti(), 2200);
  }, [anahtar]);
  const bittiSonuc = (r, kisi) => {
    const u = r?.uyarilar || [];
    sonucGoster({ tur: u.length ? 'uyari' : 'tamam', uyarilar: u, kisi, mesaj: r?.kuru ? (r.mesaj || 'DENEME — kaydedilmedi') : '' });
  };

  const onayIste = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/onay-iste`, { method: 'POST', body: { tur: 'kapanis', govde: { ...govde(), personel_id: '-' } } });
      setOnay({ id: r.onay_id, durum: 'bekliyor', mesaj: '' });
    } catch (e) {
      setHata(e instanceof TypeError ? 'İnternet yok — bağlantı gelince yeniden dene' : (e?.message || 'Onay istenemedi'));
    }
    setMesgul(false);
  };
  const onayIptal = async () => {   // AcilisSihirbazi ile aynı kural: iptal kesinleşmeden düzenlemeye dönülmez
    const o = onay;
    if (!o || !['bekliyor', 'hata', 'isleniyor'].includes(o.durum)) { setOnay(null); return true; }
    try {
      await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}/iptal`, { method: 'POST', body: {} });
      setOnay(null); return true;
    } catch (e) {
      if (e instanceof TypeError) { setHata('İnternet yok — onay iptal edilemedi, bağlantı gelince tekrar dene'); return false; }
      try {
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}`);
        if (r.durum === 'onaylandi') { bittiSonuc(r, r.kisi); return false; }
        if (r.durum === 'iptal' || r.durum === 'sure_doldu') { setOnay(null); return true; }
        setOnay({ id: o.id, durum: r.durum, mesaj: r.mesaj || '' });
      } catch { /* belirsiz */ }
      setHata('Onay iptal edilemedi — QR hâlâ geçerli olabilir; birazdan yeniden dene');
      return false;
    }
  };
  const onayRef = useRef(onay); onayRef.current = onay;
  useEffect(() => {   // 5. adım: telefon onaylayınca panel kendiliğinden geçer
    if (!onay?.id || !['bekliyor', 'isleniyor', 'hata'].includes(onay.durum)) return undefined;
    let canli = true;
    const sor = async () => {
      try {
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(onay.id)}`);
        if (!canli || onayRef.current?.id !== onay.id) return;
        setAgHata(0);
        if (r.durum === 'onaylandi') bittiSonuc(r, r.kisi);
        else if (r.durum !== onay.durum) setOnay({ id: onay.id, durum: r.durum, mesaj: r.mesaj || '' });
      } catch { if (canli) setAgHata((n) => n + 1); }
    };
    const t = window.setInterval(sor, 2000);
    return () => { canli = false; window.clearInterval(t); };
  }, [onay?.id, onay?.durum]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {   // başka yoldan kapandıysa — Codex P2-7: açık onay varsa uyarıları ONDAN al (EKSİK VAR yutulmasın)
    if (!d.kapanis_var || sonuc || d.gun !== gun) return;
    const o = onayRef.current;
    if (!o?.id) { sonucGoster({ tur: 'tamam', uyarilar: [] }); return; }
    api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}`)
      .then((r) => (r.durum === 'onaylandi' ? bittiSonuc(r, r.kisi) : sonucGoster({ tur: 'tamam', uyarilar: [] })))
      .catch(() => sonucGoster({ tur: 'tamam', uyarilar: [] }));
  }, [d.kapanis_var]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ileri = () => {
    setHata('');
    if (adim === 1) {   // eski kapNext1 doğrulamaları AYNEN
      for (const [k, ad] of [['nakit', 'Nakit'], ['pos', 'POS'], ['online', 'Online']]) {
        if (v[k] !== '' && !PARA.test(v[k])) { setHata(`${ad} için geçerli tutar girin`); return; }
      }
      if (v.kor === '' || !PARA.test(v.kor)) { setHata('Çekmecedeki TÜM parayı sayıp girin (teslim etmeden önce, kör sayım)'); return; }
      if (v.birakilan === '' || !PARA.test(v.birakilan)) { setHata('Kasada bırakılan (devir) tutarı zorunlu'); return; }
      const n = tutarNum(v.nakit), p = tutarNum(v.pos), o = tutarNum(v.online);
      if (o > 0 && n > 0 && p > 0 && Math.abs(o - (n + p)) < 0.5) { setHata('Online alanı nakit+POS toplamına eşit olamaz. Online satış yoksa 0 bırakın.'); return; }
      if (n + p + o <= 0) { setHata('En az bir ciro tutarı girin'); return; }
      git(2); return;
    }
    if (adim === 2) { if (zorunlu(bardaklar)) git(3); return; }
    if (adim === 3) {
      if (!zorunlu(digerleri)) return;
      if (!urunAcVar && !v.urunAcYok) { setHata('Bugün Ürün Aç kaydı yok — açtığın ürünleri kaydet ya da "Bugün ürün açılmadı" de'); return; }
      git(4); return;
    }
    if (adim === 4) {
      if (v.pasta === '') { setHata('Pasta adedini girin'); return; }
      git(5);
    }
  };
  const geri = async () => {
    if (mesgul) return;
    if (adim === 5) { setMesgul(true); const tamam = await onayIptal(); setMesgul(false); if (!tamam) return; }
    if (adim > 1) git(adim - 1);
  };
  const denemeKaydet = async () => {   // yalnız DENEME: telefonsuz doğrudan uç (sunucu kuru — kaydetmez)
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const kisi = iceride[0]?.personel_id || d.personel[0]?.id;
      if (!kisi) { setHata('İçeride kimse yok — deneme kaydı için önce biri QR ile girsin'); setMesgul(false); return; }
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/kapanis`, { method: 'POST', body: { ...govde(), personel_id: kisi } });
      bittiSonuc(r, iceride[0]?.ad);
    } catch (e) { setHata(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const merkezeGonder = async () => {   // sahip: mühürsüz YOK — telefonsuz kapanışçı merkeze gönderir (merkez geç kapanış işler)
    if (mesgul) return;
    if (onay?.durum === 'isleniyor') { setHata('Kapanış şu an telefondan onaylanıyor — birkaç saniye bekle'); return; }
    if (!mKisi) { setHata('Adını seç'); return; }
    if (!/^\d{4}$/.test(mPin)) { setHata('4 haneli PIN\'ini gir'); return; }
    setMesgul(true); setHata('');
    try {
      if (onay && ['bekliyor', 'hata'].includes(onay.durum) && !(await onayIptal())) { setMesgul(false); return; }   // açık QR onayı kalmasın
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/kapanis`, { method: 'POST', body: { ...govde(), personel_id: mKisi, pin: mPin, merkeze: true } });
      setMPin('');
      sonucGoster({ tur: 'merkeze', uyarilar: [], mesaj: r.mesaj });
    } catch (e) {
      setMPin('');
      setHata(e instanceof TypeError ? 'İnternet yok — bağlantı gelince yeniden gönder (form duruyor)' : (e?.message || 'Gönderilemedi'));
    }
    setMesgul(false);
  };

  const sayiKutu = (u) => (
    <div key={u.id} style={{ minWidth: 0 }}>
      <label className="aw-lbl">{u.ad}</label>
      <input className="aw-in" inputMode="numeric" autoComplete="off" placeholder="0" value={sayim[u.id] ?? ''}
        onChange={(e) => setSayim((o) => ({ ...o, [u.id]: sayi(e.target.value).slice(0, 6) }))} />
    </div>
  );
  const para = (k, ad, ipucu) => (
    <div style={{ minWidth: 0 }}>
      <label className="aw-lbl">{ad}</label>
      <input className="aw-in" inputMode="decimal" autoComplete="off" placeholder={ipucu || '0'} value={v[k]} onChange={(e) => set(k, tutar(e.target.value))} />
    </div>
  );
  const altYazi = { 1: 'X raporu + kör çekmece sayımı + teslim', 2: bardaklar.map((u) => u.ad).join(' · ') || 'Bardak', 3: digerleri.map((u) => u.ad).join(' · ') || 'Ürün',
    4: 'Değirmen sayaçları (isteğe bağlı) + vitrin pasta', 5: 'Kapanışı yapan telefonuyla okutur — kapanışçı o olur' }[adim];
  const saatUyari = kapanisErken(d.saat?.kapanis) ? `Kapanış ${d.saat?.kapanis || '22:30'}'dan önce yapılamaz (Türkiye saati).` : '';
  const dv = yok.devir;
  const devirAcik = dv && ['baslatildi', 'dolduruluyor', 'devreden_onayladi'].includes(dv.durum);

  return (
    <div className="aw-perde">
      <style>{CSS_AW}</style>
      <div className="aw-kart">
        <div className="aw-marka" style={{ background: 'linear-gradient(135deg,#4c1d95 0%,#7c3aed 100%)' }}>
          <div className="aw-logo">🌙</div>
          <div><div className="aw-mttl">Evvel ERP</div><div className="aw-msub">Şube Kapanış Protokolü</div></div>
          {!sonuc && <div className="aw-saat">{trSaat(saat)}</div>}
        </div>
        {sonuc ? (
          sonuc.tur === 'tamam' ? (
            <div className="aw-basari">
              <div className="aw-bico">🔒</div>
              <div className="aw-bttl">Gün Kapandı</div>
              <div className="aw-bsub">{sonuc.mesaj || (d.kuru ? 'DENEME — kaydedilmedi.' : `Kapanış mühürlendi${sonuc.kisi ? ` · ${sonuc.kisi}` : ''}.`)}<br />İyi akşamlar…</div>
            </div>
          ) : (
            <div style={{ padding: 22, display: 'grid', gap: 12, background: sonuc.tur === 'uyari' ? '#FFF4DB' : 'rgba(59,130,246,.1)', color: sonuc.tur === 'uyari' ? '#2a1e14' : C.yazi }}>
              <b style={{ fontSize: 21, color: sonuc.tur === 'uyari' ? '#B26B00' : C.mavi }}>
                {sonuc.tur === 'uyari' ? '⚠️ KAPANIŞ KAYDEDİLDİ — AMA EKSİK VAR' : '📨 Merkeze iletildi'}</b>
              {sonuc.tur === 'uyari' ? (<>
                {sonuc.mesaj && <div style={{ fontWeight: 700 }}>{sonuc.mesaj}</div>}
                <div>Girdiğin bütün veriler kaydedildi. Şunlar eksik / dikkat:</div>
                <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>{sonuc.uyarilar.map((u) => <li key={u}>{u}</li>)}</ul>
                <div>Yöneticine haber ver — merkez de gördü.</div>
              </>) : <div>{sonuc.mesaj}</div>}
              <button className="aw-btn ana" style={{ background: sonuc.tur === 'uyari' ? '#B26B00' : C.mavi, borderColor: 'transparent' }} onClick={() => bitti()}>ANLADIM</button>
            </div>
          )
        ) : (<>
          <div className="aw-cizgi">
            {[1, 2, 3, 4, 5].map((i) => (
              <React.Fragment key={i}>
                <div className={'aw-nokta' + (i < adim ? ' tamam' : i === adim ? ' etkin' : '')}>{i < adim ? '✓' : i}</div>
                {i < 5 && <div className={'aw-hat' + (i < adim ? ' tamam' : '')} />}
              </React.Fragment>
            ))}
          </div>
          <div key={adim} className={'aw-ic ' + (yon === 'ileri' ? 'aw-ileri' : 'aw-geri')}>
            <div className="aw-adim">
              <div className="aw-aico">{ICO[adim]}</div>
              <div><div className="aw-attl">{BASLIK[adim]}</div><div className="aw-asub">{altYazi}</div></div>
            </div>
            {adim === 1 && (<>
              <div className="aw-lbl" style={{ color: '#fbbf24', fontWeight: 800 }}>◈ X RAPORU CİRO</div>
              <div className="aw-izgara" style={{ marginBottom: 14 }}>{para('nakit', 'Nakit (₺)')}{para('pos', 'POS (₺)')}{para('online', 'Online (₺)')}</div>
              <div className="aw-kor">🔒 KÖR SAYIM — önce çekmecedeki TÜM parayı say, teslim için ayırmadan</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {para('kor', '1 · Çekmecedeki TÜM para *', 'Önce say')}
                <div>
                  <div className="aw-lbl">2 · Teslim (kime, ne kadar)</div>
                  <div className="aw-izgara">
                    {d.teslim_alanlar.map((a) => (
                      <div key={a.id} style={{ minWidth: 0 }}>
                        <label className="aw-lbl">👤 {a.ad}</label>
                        <input className="aw-in" inputMode="decimal" autoComplete="off" placeholder="0" value={v.teslim?.[a.id] ?? ''}
                          onChange={(e) => set('teslim', { ...(v.teslim || {}), [a.id]: tutar(e.target.value) })} />
                      </div>
                    ))}
                  </div>
                </div>
                {para('birakilan', '3 · Kasada bırakılan (devir) *', 'Zorunlu')}
              </div>
            </>)}
            {adim === 2 && <div className="aw-izgara">{bardaklar.map(sayiKutu)}</div>}
            {adim === 3 && (<>
              <div className="aw-izgara">{digerleri.map(sayiKutu)}</div>
              {!urunAcVar && (
                <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'rgba(245,158,11,.12)', border: `1px solid ${C.sari}`, display: 'grid', gap: 8 }}>
                  <b style={{ color: C.sari }}>🔓 Bugün Ürün Aç kaydı yok</b>
                  <span style={{ fontSize: 13, color: C.soluk }}>Gün içinde koli / şişe açtıysan önce Ürün Aç'a kaydet (girdiklerin burada duruyor).</span>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="aw-btn" type="button" onClick={() => urunAcaGit()}>🔓 Ürün Aç'a git</button>
                    <button className={'aw-btn' + (v.urunAcYok ? ' ana yesil' : '')} type="button" onClick={() => set('urunAcYok', !v.urunAcYok)}>
                      {v.urunAcYok ? '✓ Bugün ürün açılmadı' : 'Bugün ürün açılmadı'}</button>
                  </div>
                </div>
              )}
            </>)}
            {adim === 4 && (<>
              <div className="aw-lbl" style={{ color: '#f59e0b', fontWeight: 800 }}>◈ DEĞİRMEN SAYACI (isteğe bağlı — kapanışı engellemez)</div>
              <div className="aw-izgara" style={{ gridTemplateColumns: 'repeat(2,1fr)', marginBottom: 14 }}>
                {[['gunluk', 'Bugünkü Çekim', 'sağ üst'], ['doz1', 'Doz I (toplam)', 'sayaç'], ['doz2', 'Doz II (toplam)', 'sayaç'], ['doz3', 'Doz III', 'Helios']].map(([k, ad, ph]) => (
                  <div key={k} style={{ minWidth: 0 }}><label className="aw-lbl">{ad}</label>
                    <input className="aw-in" inputMode="numeric" autoComplete="off" placeholder={ph} value={v.deg?.[k] ?? ''}
                      onChange={(e) => set('deg', { ...(v.deg || {}), [k]: sayi(e.target.value).slice(0, 9) })} /></div>
                ))}
              </div>
              <div style={{ maxWidth: 220, margin: '0 auto 8px' }}>
                <div className="aw-lbl" style={{ textAlign: 'center' }}>Pasta (toplam adet)</div>
                <input className="aw-in" style={{ fontSize: 22, fontWeight: 800, height: 52, textAlign: 'center' }} inputMode="numeric" placeholder="0"
                  value={v.pasta} onChange={(e) => set('pasta', sayi(e.target.value).slice(0, 5))} />
              </div>
            </>)}
            {adim === 5 && (
              <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
                <div className="sp-kart" style={{ width: '100%', boxSizing: 'border-box', textAlign: 'left', fontSize: 14, display: 'grid', gap: 4 }}>
                  <div>🧾 Nakit <b>{tl(tutarNum(v.nakit))}</b> · POS <b>{tl(tutarNum(v.pos))}</b> · Online <b>{tl(tutarNum(v.online))}</b></div>
                  <div>💰 Çekmece <b>{tl(tutarNum(v.kor))}</b> · Teslim {teslimler.length ? teslimler.map((t) => `${(d.teslim_alanlar.find((x) => x.id === t.alan) || {}).ad || t.alan} ${tl(t.tutar)}`).join(', ') : '—'} · Bırakılan <b>{tl(tutarNum(v.birakilan))}</b></div>
                  <div>🥤 {bardaklar.map((u) => `${u.ad} ${sayim[u.id]}`).join(' · ') || '—'}</div>
                  <div>📦 {digerleri.map((u) => `${u.ad} ${sayim[u.id]}`).join(' · ') || '—'}</div>
                  <div>🍰 Pasta <b>{v.pasta}</b></div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, alignSelf: 'stretch', fontWeight: 700, minHeight: 44 }}>
                  <input type="checkbox" checked={!!v.xrapor} onChange={(e) => set('xrapor', e.target.checked)} style={{ width: 22, height: 22 }} />
                  X raporu yazıcıdan çıktı alındı ve gönderildi</label>
                {(!d.acilis_var || devirAcik) && (
                  <div style={{ alignSelf: 'stretch', textAlign: 'left', padding: 10, borderRadius: 8, background: 'rgba(245,158,11,.12)', color: C.sari, fontSize: 13, display: 'grid', gap: 3 }}>
                    {!d.acilis_var && <div>⚠ Bugün açılış kaydı yok</div>}
                    {devirAcik && <div>⚠ Kasa devri tamamlanmadı</div>}
                  </div>
                )}
                {/* İçeride kalanlar: kapanışçı DIŞINDAKİLER aynı QR'la "Sadece çıkış yap" (sahip 19 Eki) */}
                <div style={{ alignSelf: 'stretch', textAlign: 'left', fontSize: 13, display: 'grid', gap: 4 }}>
                  <b>👥 İçeride: {iceride.length ? iceride.map((g) => g.ad + (g.molada ? ' (molada)' : '')).join(', ') : 'kimse yok'}</b>
                  {yok.kapanis_sorumlusu?.ad && <span style={{ color: C.soluk }}>🌙 Kapanış sorumlusu: {yok.kapanis_sorumlusu.ad}</span>}
                  {iceride.length > 1 && <span style={{ color: C.soluk }}>Kapanışı yapmayacak olan aynı QR'ı okutup telefonunda <b>"🚪 Sadece çıkış yap"</b>a bassın.</span>}
                </div>
                {!tabletVar ? (
                  <b style={{ color: C.sari }}>Bu bilgisayar kayıtlı değil — QR çıkamaz. Merkezden bağlantı iste.</b>
                ) : !onay ? (
                  <span style={{ color: C.soluk, fontSize: 13 }}>Özet doğruysa aşağıdaki düğmeye bas — ekranda mühür QR'ı çıkar.</span>
                ) : onay.durum === 'isleniyor' ? (
                  <b style={{ color: C.sari }}>⏳ Onay telefondan işleniyor… birazdan geçer</b>
                ) : onay.durum === 'bekliyor' ? (<>
                  <TabletQR boyut={Math.min(260, Math.max(200, (window.innerWidth || 600) - 140))} onay={onay.id} />
                  <span style={{ color: C.soluk, fontSize: 13 }}>Kapanışı yapan telefonuyla okutur → özeti görür → <b>ONAYLA</b>. Kapanışçı o kaydedilir ve çıkışı yazılır.<br />⏳ Onay bekleniyor… (10 dk geçerli)</span>
                  {agHata >= 3 && <b style={{ color: C.sari }}>📶 Bağlantı yok — QR geçerli, bağlantı gelince onay görünür</b>}
                </>) : onay.durum === 'hata' ? (<>
                  <b style={{ color: C.kirmizi }}>{onay.mesaj || 'Onay kaydedilemedi'}</b>
                  <span style={{ color: C.soluk, fontSize: 13 }}>Sorun giderilince aynı QR ile telefondan yeniden onaylanabilir.</span>
                  <TabletQR boyut={Math.min(220, Math.max(180, (window.innerWidth || 600) - 160))} onay={onay.id} />
                </>) : (
                  <b style={{ color: C.kirmizi }}>{onay.durum === 'sure_doldu' ? 'Onayın süresi doldu' : 'Onay iptal edildi'} — aşağıdan yeniden QR iste</b>
                )}
                {/* 📨 Telefonsuz: mühürsüz YOK (sahip) → merkez geç kapanış işler; önce içerideki başka biri kendi telefonuyla onaylayabilir */}
                {!merkezAc ? (
                  <button type="button" onClick={() => setMerkezAc(true)} style={{ background: 'none', border: 'none', color: C.soluk, textDecoration: 'underline', font: 'inherit', fontSize: 13, minHeight: 44, cursor: 'pointer' }}>
                    📵 Kapanışçının telefonu yok / çalışmıyor mu?</button>
                ) : (
                  <div className="sp-kart" style={{ alignSelf: 'stretch', textAlign: 'left', display: 'grid', gap: 8 }}>
                    <b>📨 Merkeze gönder</b>
                    <span style={{ fontSize: 13, color: C.soluk }}>Önce içeride telefonu olan başka biri QR'ı okutup onaylayabilir (kapanışçı o olur). Kimse yoksa: adını seç + PIN → rakamlar kaybolmaz, <b>merkez işleyince gün kapanır</b>.</span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {iceride.length === 0 ? <span style={{ color: C.sari }}>İçeride kimse yok — önce QR ile giriş yap.</span>
                        : iceride.map((g) => <button key={g.personel_id} type="button" className={'aw-btn' + (mKisi === g.personel_id ? ' ana' : '')} onClick={() => setMKisi(g.personel_id)}>{g.ad}</button>)}
                    </div>
                    {mKisi && <input className="aw-in" style={{ width: 160, textAlign: 'center', letterSpacing: 8 }} type="password" inputMode="numeric" data-pin="1"
                      autoComplete="off" maxLength={4} value={mPin} onChange={(e) => setMPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="PIN" />}
                    <button type="button" className="aw-btn" disabled={mesgul || !mKisi || mPin.length !== 4} onClick={merkezeGonder}>📨 Merkeze gönder</button>
                  </div>
                )}
                {d.kuru && <button className="aw-btn" style={{ width: '100%' }} disabled={mesgul} onClick={denemeKaydet}>Deneme: QR'sız kaydet</button>}
              </div>
            )}
          </div>
          {saatUyari && <div className="aw-uyari">{saatUyari}</div>}
          <div className="aw-hata">{hata}</div>
          <div className="aw-dugmeler">
            {adim > 1 && <button className="aw-btn" onClick={geri} disabled={mesgul}>« Geri</button>}
            {adim < 5 && <button className="aw-btn ana" onClick={ileri}>İleri →</button>}
            {adim === 5 && tabletVar && (!onay || !['bekliyor', 'isleniyor'].includes(onay.durum)) && (
              <button className="aw-btn ana yesil" disabled={mesgul} onClick={onayIste}>
                {mesgul ? 'Hazırlanıyor…' : onay ? '🔁 Yeniden QR iste' : '🔒 QR ile Mühürle'}</button>
            )}
            <button className="aw-btn" disabled={mesgul} onClick={async () => { if (await onayIptal()) kapat(); }} title="Girdiklerin tablette durur">Kapat</button>
          </div>
        </>)}
      </div>
    </div>
  );
}
