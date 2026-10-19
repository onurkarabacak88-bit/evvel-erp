// ☀️ AÇILIŞ SİHİRBAZI — eski sube_panel.html #acilisOverlay AYNEN (5660–5720, 9912–10055, 14325–14445); tek fark 5. adım:
// PIN yerine 📱 QR ile onay (PANEL_YENIDEN_KURULUM.md S2, Basamak 2). Kayıt: onay-iste → personel kendi telefonuyla okutur →
// sunucu açılışı ONAYLAYANIN adına yazar (S17: girişli herhangi bir personel). Tak-çıkar: yalnız props; sunucu uçları panel modülünde.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { C, sayi, TabletQR, tl, tutar, tutarNum, yeniIstek } from './ortak';

const ICO = ['', '💰', '🥤', '📦', '🍰', '📱'];
const BASLIK = ['', 'Kasa Sayımı', 'Bardak Stoku', 'Ürün Stoku', 'Pasta Stoku', 'QR ile Onay'];

const CSS_AW = `
@keyframes awSagdan{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}
@keyframes awSoldan{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:translateX(0)}}
@keyframes awPop{0%{transform:scale(.55);opacity:0}65%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
@keyframes awYukari{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.aw-perde{position:fixed;inset:0;background:rgba(5,8,18,.9);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:75;padding:20px}
.aw-kart{width:100%;max-width:490px;max-height:96vh;overflow:auto;background:${C.bg2};border:1px solid ${C.cizgi};border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6);color:${C.yazi}}
.aw-marka{background:linear-gradient(135deg,${C.mavi} 0%,#7c3aed 100%);padding:18px 22px 16px;display:flex;align-items:center;gap:12px}
.aw-logo{width:46px;height:46px;border-radius:14px;flex-shrink:0;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:22px}
.aw-mttl{color:#fff;font-size:17px;font-weight:900;letter-spacing:-.3px} .aw-msub{color:rgba(255,255,255,.65);font-size:11px;margin-top:2px}
.aw-saat{margin-left:auto;color:rgba(255,255,255,.75);font-size:14px;font-weight:800;letter-spacing:.04em}
.aw-cizgi{display:flex;align-items:center;padding:16px 22px 0}
.aw-nokta{width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;border:2px solid ${C.cizgi};background:${C.bg2};color:${C.soluk};transition:all .28s}
.aw-nokta.tamam{background:${C.yesil};border-color:${C.yesil};color:#fff} .aw-nokta.etkin{background:${C.mavi};border-color:${C.mavi};color:#fff;box-shadow:0 0 0 4px rgba(99,102,241,.22)}
.aw-hat{flex:1;height:2px;background:${C.cizgi};transition:background .35s} .aw-hat.tamam{background:${C.yesil}}
.aw-ic{padding:16px 22px 0} .aw-ileri{animation:awSagdan .22s ease-out} .aw-geri{animation:awSoldan .22s ease-out}
.aw-adim{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.aw-aico{width:40px;height:40px;border-radius:11px;flex-shrink:0;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.2);display:flex;align-items:center;justify-content:center;font-size:19px}
.aw-attl{font-size:15px;font-weight:800} .aw-asub{font-size:11px;color:${C.soluk};margin-top:2px;line-height:1.4}
.aw-kor{display:inline-flex;align-items:center;gap:6px;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:#60a5fa;border-radius:7px;padding:5px 11px;font-size:11px;font-weight:700;letter-spacing:.04em;margin-bottom:14px}
.aw-lbl{display:block;font-size:12px;color:${C.soluk};margin-bottom:4px;font-weight:600}
.aw-in{width:100%;box-sizing:border-box;min-width:0;min-height:48px;padding:8px 12px;border-radius:10px;border:1px solid ${C.cizgi};background:${C.bg};color:${C.yazi};font-size:18px;font-weight:700}
.aw-in:focus{outline:none;border-color:${C.mavi}}
.aw-izgara{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.aw-dugmeler{display:flex;gap:10px;padding:14px 22px 20px;margin-top:4px}
.aw-btn{height:52px;border-radius:10px;border:1px solid ${C.cizgi};background:${C.bg3};color:${C.yazi};font:inherit;font-size:14px;font-weight:800;cursor:pointer;padding:0 16px}
.aw-btn:disabled{opacity:.5;cursor:default} .aw-btn.ana{flex:1;background:${C.mavi};border-color:${C.mavi};color:#fff;font-size:15px} .aw-btn.yesil{background:${C.yesil};border-color:${C.yesil};color:#05210f}
.aw-uyari{margin:0 22px 4px;padding:10px 12px;border-radius:8px;line-height:1.4;background:rgba(239,68,68,.12);color:#fca5a5;font-size:13px}
.aw-hata{min-height:18px;padding:0 22px 4px;font-size:13px;color:${C.kirmizi};font-weight:700}
.aw-basari{display:flex;flex-direction:column;align-items:center;text-align:center;padding:36px 28px 32px}
.aw-bico{width:76px;height:76px;border-radius:50%;background:rgba(16,185,129,.1);border:2px solid rgba(16,185,129,.3);display:flex;align-items:center;justify-content:center;font-size:38px;animation:awPop .55s cubic-bezier(.34,1.56,.64,1) forwards;margin-bottom:18px}
.aw-bttl{font-size:22px;font-weight:900;animation:awYukari .4s .2s ease-out both} .aw-bsub{font-size:13px;color:${C.soluk};margin-top:8px;line-height:1.55;animation:awYukari .4s .38s ease-out both}
@media (max-width:480px){.aw-izgara{grid-template-columns:1fr 1fr}}
`;

// Bugünün saat dakikası "07:00" ile karşılaştırma (Türkiye saati — panel PC'si TR'de; asıl karar sunucuda)
const trSaat = (t) => t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });
const saatOnce = (hhmm) => {
  const [h, m] = String(hhmm || '07:00').split(':').map(Number);
  const [sh, sm] = trSaat(new Date()).split(':').map(Number);
  return sh * 60 + sm < h * 60 + (m || 0);
};

export default function AcilisSihirbazi({ d, subeId, tabletVar, kapatilabilir, kapat, bitti, basladi }) {
  const urunler = d.sayilan.flatMap((g) => g.urunler);
  const bardakMi = (u) => /bardak/i.test(u.ad) && !/kapa[kğ]|çanta|tutucu/i.test(u.ad);
  const bardaklar = urunler.filter(bardakMi);
  const digerleri = urunler.filter((u) => !bardakMi(u));
  const anahtar = `sp_taslak:${subeId}:${d.gun}:acilis_sihirbaz`;   // iş gününe bağlı (02:00'de yeni gün = yeni form)
  const ilk = (() => { try { return JSON.parse(localStorage.getItem(anahtar) || 'null'); } catch { return null; } })();
  useEffect(() => {   // Fable: eski günlerin sihirbaz taslakları birikmesin
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(`sp_taslak:${subeId}:`) && k.endsWith(':acilis_sihirbaz') && k !== anahtar)
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* yok say */ }
  }, [anahtar, subeId]);
  const [adim, setAdim] = useState(ilk?.adim || 1);
  const [yon, setYon] = useState('ileri');
  const [kasa, setKasa] = useState(ilk?.kasa ?? '');
  const [sayim, setSayim] = useState(ilk?.sayim || {});
  const [pasta, setPasta] = useState(ilk?.pasta ?? '');
  const [istek] = useState(ilk?.istek || yeniIstek());   // aynı form = aynı kimlik → iki onay gelse de tek açılış
  const [hata, setHata] = useState('');
  const [onay, setOnay] = useState(null);   // { id, durum, mesaj } — taslağa YAZILMAZ (yenilemede yeni QR)
  const [mesgul, setMesgul] = useState(false);
  const [basari, setBasari] = useState(false);
  const [basariMesaj, setBasariMesaj] = useState('');
  const [agHata, setAgHata] = useState(0);   // 5. adımda art arda bağlantı hatası
  const [saat, setSaat] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setSaat(new Date()), 10000); return () => window.clearInterval(t); }, []);
  useEffect(() => {   // 💾 her tuşta tablete
    if (basari) return;
    try { localStorage.setItem(anahtar, JSON.stringify({ adim: Math.min(adim, 4), kasa, sayim, pasta, istek })); } catch { /* yok say */ }
  }, [adim, kasa, sayim, pasta, istek, anahtar, basari]);

  const git = (n) => { setHata(''); setYon(n > adim ? 'ileri' : 'geri'); setAdim(n); };
  const govde = () => ({
    istemci_gunu: d.gun, istek_id: istek, kasa_sayim: tutarNum(kasa), pasta_toplam: Number(pasta),
    sayim: urunler.map((u) => ({ urun_id: u.id, sayilan: Number(sayim[u.id]) })),
  });
  const zorunlu = (liste) => {   // eski reqInt: boş → "X adedini girin" (0 yazılabilir)
    const bos = liste.find((u) => sayim[u.id] === undefined || sayim[u.id] === '');
    if (bos) { setHata(`${bos.ad} adedini girin`); return false; }
    return true;
  };
  const basariGoster = useCallback((mesaj) => {
    if (mesaj) setBasariMesaj(mesaj);
    try { localStorage.removeItem(anahtar); } catch { /* yok say */ }
    setBasari((o) => {
      if (!o) { basladi?.(); window.setTimeout(() => bitti(), 1900); }   // eski: ~1,9 sn başarı ekranı (panel bu sürede sihirbazı kapatmaz)
      return true;
    });
  }, [anahtar, bitti, basladi]);

  const onayIste = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/onay-iste`, { method: 'POST', body: { tur: 'acilis', govde: { ...govde(), personel_id: '-' } } });
      setOnay({ id: r.onay_id, durum: 'bekliyor', mesaj: '' });
    } catch (e) {
      setHata(e instanceof TypeError ? 'İnternet yok — bağlantı gelince yeniden dene' : (e?.message || 'Onay istenemedi'));
    }
    setMesgul(false);
  };
  // « Geri: bekleyen onay iptal edilir; iptal KESİNLEŞMEDEN düzenlemeye dönülmez (Codex). true = geri dönülebilir
  const onayIptal = async () => {
    const o = onay;
    if (!o || !['bekliyor', 'hata', 'isleniyor'].includes(o.durum)) { setOnay(null); return true; }
    try {
      await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}/iptal`, { method: 'POST', body: {} });
      setOnay(null); return true;
    } catch (e) {
      if (e instanceof TypeError) { setHata('İnternet yok — onay iptal edilemedi, bağlantı gelince tekrar dene'); return false; }
      try {   // 409: o an telefonda onaylanmış / işleniyor olabilir → gerçek durumu sor
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(o.id)}`);
        if (r.durum === 'onaylandi') { basariGoster(); return false; }
        if (r.durum === 'isleniyor') { setOnay({ id: o.id, durum: 'isleniyor', mesaj: '' }); setHata('Onay telefondan işleniyor — bekle'); return false; }
      } catch { /* aşağıda */ }
      setOnay(null); return true;   // süresi dolmuş / iptal → zaten geçersiz
    }
  };

  // 5. adım: onay durumunu 2 sn'de bir sor (telefon onaylayınca panel kendiliğinden geçer)
  const onayRef = useRef(onay); onayRef.current = onay;
  useEffect(() => {
    if (!onay?.id || !['bekliyor', 'isleniyor', 'hata'].includes(onay.durum)) return undefined;
    let canli = true;
    const sor = async () => {
      try {
        const r = await api(`/evvel-yeni/panel/onay/${encodeURIComponent(onay.id)}`);
        if (!canli || onayRef.current?.id !== onay.id) return;
        setAgHata(0);
        if (r.durum === 'onaylandi') basariGoster(r.kuru ? r.mesaj : '');
        else if (r.durum !== onay.durum) setOnay({ id: onay.id, durum: r.durum, mesaj: r.mesaj || '' });
      } catch { if (canli) setAgHata((n) => n + 1); }   // ağ geçici — sonraki turda
    };
    const t = window.setInterval(sor, 2000);
    return () => { canli = false; window.clearInterval(t); };
  }, [onay?.id, onay?.durum, basariGoster]);   // eslint-disable-line react-hooks/exhaustive-deps
  // başka yoldan (ikinci sekme / telefon) açılış yazıldıysa
  useEffect(() => { if (d.acilis_var && !basari) basariGoster(); }, [d.acilis_var]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ileri = () => {
    setHata('');
    if (adim === 1) {
      if (kasa === '') { setHata('Kasa sayımı girin'); return; }
      if (!/^\d{1,8}(,\d{1,2})?$/.test(kasa)) { setHata('Kasa sayımı için geçerli değer girin'); return; }
      git(2); return;
    }
    if (adim === 2) { if (zorunlu(bardaklar)) git(3); return; }
    if (adim === 3) { if (zorunlu(digerleri)) git(4); return; }
    if (adim === 4) {
      if (pasta === '') { setHata('Pasta adedini girin'); return; }
      git(5); return;
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
      const kisi = (d.yoklama?.girenler || []).find((g) => g.acik)?.personel_id || d.personel[0]?.id;
      await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/acilis`, { method: 'POST', body: { ...govde(), personel_id: kisi } });
      basariGoster();
    } catch (e) { setHata(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };

  const sayiKutu = (u) => (
    <div key={u.id} style={{ minWidth: 0 }}>
      <label className="aw-lbl">{u.ad}</label>
      <input className="aw-in" inputMode="numeric" autoComplete="off" placeholder="0" value={sayim[u.id] ?? ''}
        onChange={(e) => setSayim((o) => ({ ...o, [u.id]: sayi(e.target.value).slice(0, 6) }))} />
    </div>
  );
  const altYazi = { 1: 'Kör sayım — önceki tutara bakmadan say', 2: bardaklar.map((u) => u.ad).join(' · ') || 'Bardak', 3: digerleri.map((u) => u.ad).join(' · ') || 'Ürün',
    4: 'Vitrin pasta sayımı', 5: 'Telefonunla QR\'ı okut ve onayla' }[adim];
  const saatUyari = saatOnce(d.saat?.acilis) ? `Açılış onayı yalnızca ${d.saat?.acilis || '07:00'} ve sonrasında yapılabilir (Türkiye saati) — erken açılış izni olan personel bu saatten önce de açabilir.` : '';

  return (
    <div className="aw-perde">
      <style>{CSS_AW}</style>
      <div className="aw-kart">
        <div className="aw-marka">
          <div className="aw-logo">☕</div>
          <div><div className="aw-mttl">Evvel ERP</div><div className="aw-msub">Şube Açılış Protokolü</div></div>
          {!basari && <div className="aw-saat">{trSaat(saat)}</div>}
        </div>
        {basari ? (
          <div className="aw-basari">
            <div className="aw-bico">✅</div>
            <div className="aw-bttl">Şube Açıldı!</div>
            <div className="aw-bsub">{d.kuru ? `DENEME — kaydedilmedi.${basariMesaj ? ' ' + basariMesaj : ''}` : 'Açılış kaydedildi, sistem hazır.'}<br />İyi çalışmalar…</div>
          </div>
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
              <div className="aw-kor">🔒 KÖR SAYIM — önceki tutara bakma</div>
              <p style={{ fontSize: 12, color: C.soluk, margin: '0 0 12px', lineHeight: 1.5 }}>Kasadaki parayı <b>bağımsız olarak say.</b> Sunucu saati: <b>{trSaat(saat)}</b></p>
              <label className="aw-lbl">Kasa Sayımı (₺)</label>
              <input className="aw-in" inputMode="decimal" autoComplete="off" placeholder="0" value={kasa} onChange={(e) => setKasa(tutar(e.target.value))} />
            </>)}
            {adim === 2 && <div className="aw-izgara">{bardaklar.map(sayiKutu)}</div>}
            {adim === 3 && <div className="aw-izgara">{digerleri.map(sayiKutu)}</div>}
            {adim === 4 && (
              <div style={{ maxWidth: 220, margin: '0 auto 8px' }}>
                <div className="aw-lbl" style={{ textAlign: 'center' }}>Pasta (toplam adet)</div>
                <input className="aw-in" style={{ fontSize: 22, fontWeight: 800, height: 52, textAlign: 'center' }} inputMode="numeric" placeholder="0"
                  value={pasta} onChange={(e) => setPasta(sayi(e.target.value).slice(0, 5))} />
              </div>
            )}
            {adim === 5 && (
              <div style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
                <div className="sp-kart" style={{ width: '100%', boxSizing: 'border-box', textAlign: 'left', fontSize: 14, display: 'grid', gap: 4 }}>
                  <div>💰 Kasa: <b>{tl(tutarNum(kasa))}</b></div>
                  <div>🥤 {bardaklar.map((u) => `${u.ad} ${sayim[u.id]}`).join(' · ') || '—'}</div>
                  <div>📦 {digerleri.map((u) => `${u.ad} ${sayim[u.id]}`).join(' · ') || '—'}</div>
                  <div>🍰 Pasta: <b>{pasta}</b></div>
                </div>
                {!tabletVar ? (
                  <b style={{ color: C.sari }}>Bu bilgisayar kayıtlı değil — QR çıkamaz. Merkezden bağlantı iste.</b>
                ) : !onay ? (
                  <span style={{ color: C.soluk, fontSize: 13 }}>Özet doğruysa aşağıdaki yeşil düğmeye bas — ekranda onay QR'ı çıkar.</span>
                ) : onay.durum === 'isleniyor' ? (
                  <b style={{ color: C.sari }}>⏳ Onay telefondan işleniyor… birazdan geçer</b>
                ) : onay.durum === 'bekliyor' ? (<>
                  <TabletQR boyut={Math.min(280, Math.max(200, (window.innerWidth || 600) - 140))} onay={onay.id} />
                  <span style={{ color: C.soluk, fontSize: 13 }}>Telefonunla okut → özeti gör → <b>ONAYLA</b>. Girişin yoksa önce telefonda "Giriş yap" çıkar (aynı QR).<br />⏳ Onay bekleniyor… (10 dk geçerli)</span>
                  {agHata >= 3 && <b style={{ color: C.sari }}>📶 Bağlantı yok — QR geçerli, bağlantı gelince onay görünür</b>}
                </>) : onay.durum === 'hata' ? (<>
                  <b style={{ color: C.kirmizi }}>{onay.mesaj || 'Onay kaydedilemedi'}</b>
                  <span style={{ color: C.soluk, fontSize: 13 }}>Sorun giderilince aynı QR ile telefondan yeniden onaylanabilir.</span>
                  <TabletQR boyut={Math.min(220, Math.max(180, (window.innerWidth || 600) - 160))} onay={onay.id} />
                </>) : (<>
                  <b style={{ color: C.kirmizi }}>{onay.durum === 'sure_doldu' ? 'Onayın süresi doldu' : 'Onay iptal edildi'} — aşağıdan yeniden QR iste</b>
                </>)}
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
                {mesgul ? 'Hazırlanıyor…' : onay ? '🔁 Yeniden QR iste' : '🔓 Onayla ve Şubeyi Aç'}</button>
            )}
            {kapatilabilir && <button className="aw-btn" disabled={mesgul} onClick={async () => { if (await onayIptal()) kapat(); }} title="Yalnız deneme döneminde">Deneme: kapat</button>}
          </div>
        </>)}
      </div>
    </div>
  );
}
