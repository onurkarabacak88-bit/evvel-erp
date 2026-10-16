// ─────────────────────────────────────────────────────────────────────────────
// 🌱 EVVEL YENİ — KENDİ ADRESİNDE, AYRI UYGULAMA (/evvel-yeni)
//
// Sahip (2026-10-15): "Bunu kadife tasarımda değil, başka bir alanda ayrı olarak yap;
// sonra (eskiyi) tamamen kaldırsak."
// → Evvel'in kadife kabuğuna (v2) hiçbir bağı yok. Yalnız ortak `api` yardımcısını ve
//   Evvel'in oturum jetonunu kullanır: Evvel'e girmiş tarayıcıda yeniden şifre sormaz.
// Adresler: /evvel-yeni · /evvel-yeni/<sayfa>
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import KasaModulu, { SAYFALAR } from './KasaModulu';
import GelirModulu, { GELIR_SAYFALAR } from './GelirModulu';
import GiderModulu, { GIDER_SAYFALAR } from './GiderModulu';
import OdemeModulu, { ODEME_SAYFALAR } from './OdemeModulu';
import KazancModulu, { KAZANC_SAYFALAR } from './KazancModulu';
import TanimModulu, { TANIM_SAYFALAR } from './TanimModulu';
import BarModulu, { BAR_SAYFALAR } from './BarModulu';
import MaasModulu, { MAAS_SAYFALAR, PersonelTakvim, GunlukYoklama } from './MaasModulu';
import SatisModulu, { SATIS_SAYFALAR } from './SatisModulu';
import KartModulu, { KART_SAYFALAR } from './KartModulu';
import { KiraTakvim } from './KiraModulu';

const OTURUM_ANAHTAR = 'evvel_oturum';   // Evvel ile aynı jeton

// Sahip: "evvel yeni yapalım" → uygulamanın adı EVVEL YENİ, adresi /evvel-yeni.
// Eski /para-izi adresi buraya yönlenir. Sol menü BÖLÜM BÖLÜM büyüyecek (Para · Tedarik · İşletme).
export const TABAN = '/evvel-yeni';
// Sahip: "kasa ve gelir ayrı; sol alanda FARKLI isimlerde olmalı" → her bölüm kendi başlığı.
const BOLUMLER = [
  { ad: 'Kasa', ikon: '💰', mod: 'kasa', sayfalar: SAYFALAR },
  { ad: 'Gelir', ikon: '📥', mod: 'gelir', sayfalar: GELIR_SAYFALAR },
  { ad: 'Gider', ikon: '💸', mod: 'gider', sayfalar: GIDER_SAYFALAR },
  { ad: 'Ödeme', ikon: '🧾', mod: 'odeme', sayfalar: ODEME_SAYFALAR },
  { ad: 'Kartlar', ikon: '💳', mod: 'kart', sayfalar: KART_SAYFALAR },
  { ad: 'Şube kazancı', ikon: '📈', mod: 'kazanc', sayfalar: KAZANC_SAYFALAR },
  { ad: 'Bar', ikon: '🥤', mod: 'bar', sayfalar: BAR_SAYFALAR },
  { ad: 'Satış kontrolü', ikon: '🔍', mod: 'satis', sayfalar: SATIS_SAYFALAR },
  { ad: 'Personel', ikon: '👥', mod: 'maas', sayfalar: MAAS_SAYFALAR },
  { ad: 'Tanımlar', ikon: '⚙️', mod: 'tanim', sayfalar: TANIM_SAYFALAR },
];
const TUM_SAYFALAR = BOLUMLER.flatMap((b) => b.sayfalar.map((x) => ({ ...x, mod: b.mod })));

const sekmeAdresten = () => {
  const p = (window.location.pathname || '').replace(/\/+$/, '');
  const son = p.replace(/^\/evvel-yeni/, '').split('/').filter(Boolean).pop() || '';
  return TUM_SAYFALAR.some((x) => x.id === son) ? son : 'kasam';
};

const KABUK_CSS = `
.piapp{--bg:#F4EEE2;--paper:#FCFAF4;--line:#E0D4BE;--ink:#2A1E14;--ink3:#7F6C57;--accent:#9A5F2E;--on:#FFF8EC;--bad:#C03A2B;
  min-height:100vh;background:var(--bg);color:var(--ink);font-family:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
@media (prefers-color-scheme: dark){.piapp{--bg:#161009;--paper:#211710;--line:#3A2C1E;--ink:#F1E9DD;--ink3:#A3917B;--accent:#D29A5B;--on:#241A12;--bad:#E2604F}}
.piapp-duzen{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.piapp-sol{background:var(--paper);border-right:1px solid var(--line);padding:18px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh;overflow:auto}
.piapp-logo{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:22px;padding:0 10px 4px}
.piapp-alt{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:12px 10px 4px}
.piapp-baslik{display:flex;align-items:center;gap:10px;width:100%;border:1px solid var(--line);background:var(--bg);cursor:pointer;font:inherit;text-align:left;
  font-size:14.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink);font-weight:800;padding:12px 12px;border-radius:11px;margin-top:8px;border-left:4px solid var(--line)}
.piapp-baslik:hover{border-color:var(--accent)}
.piapp-baslik[data-aktif="1"]{border-left-color:var(--accent);background:var(--paper)}
.piapp-baslik[aria-current="page"]{background:var(--accent);color:var(--on);border-color:var(--accent)}
.piapp-baslik[aria-expanded="true"]{border-left-color:var(--accent)}
.piapp-baslik .ikon{font-size:17px;letter-spacing:0}
.piapp-baslik .ok{display:inline-block;transition:transform .15s;font-size:11px;color:var(--ink3)}
.piapp-baslik[aria-expanded="true"] .ok{transform:rotate(90deg)}
.piapp-baslik .nokta{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.piapp-sol a{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 10px;border-radius:9px;color:var(--ink);text-decoration:none;font-weight:600;font-size:14px}
.piapp-sol a:hover{background:var(--bg)}
.piapp-sol a[aria-current="page"]{background:var(--accent);color:var(--on)}
.piapp-sol small{display:block;font-weight:400;font-size:11.5px;color:var(--ink3)}
.piapp-sol a[aria-current="page"] small{color:var(--on);opacity:.8}
.piapp-ic{padding:12px 18px 40px;min-width:0}
/* Dar ekran (sahip: "menü bütün sayfayı kaplıyor"): üstte ☰ Menü çubuğu; menü üstte açılan katman, sayfa seçince kapanır */
.piapp-ust{display:none}
@media (max-width:820px){
  .piapp-duzen{grid-template-columns:1fr}
  .piapp-ust{display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:30;background:var(--paper);border-bottom:1px solid var(--line);padding:10px 14px}
  .piapp-ust button{font:inherit;font-weight:700;font-size:15px;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
  .piapp-sol{display:none;position:fixed;inset:56px 0 0 0;z-index:40;height:auto;border-right:0;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  .piapp-sol[data-acik="1"]{display:flex}
  .piapp-sol .piapp-logo{display:none}
  .piapp-ic{padding:16px !important}
}
.piapp-giris{max-width:360px;margin:12vh auto 0;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:12px}
.piapp-giris h1{font-family:'Fraunces',Georgia,serif;font-weight:600;margin:0;font-size:28px}
.piapp-giris input{font:inherit;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.piapp-giris button{font:inherit;font-weight:700;padding:11px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:var(--on);cursor:pointer}
.piapp-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:10px;font-size:14px;z-index:200;max-width:90vw}
`;

function Giris({ onTamam }) {
  const [kadi, setKadi] = useState('');
  const [sifre, setSifre] = useState('');
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const gir = async (e) => {
    e.preventDefault();
    setHata(''); setMesgul(true);
    try {
      const r = kadi.trim()
        ? await api('/kullanici-giris', { method: 'POST', body: { kullanici_adi: kadi.trim(), sifre } })
        : await api('/admin-giris', { method: 'POST', body: { sifre } });
      const jeton = r?.jeton || r?.token;
      if (!jeton) throw new Error('Giriş yapılamadı');
      try { localStorage.setItem(OTURUM_ANAHTAR, jeton); } catch { /* yut */ }
      onTamam();
    } catch (er) { setHata(er?.message || 'Giriş yapılamadı'); } finally { setMesgul(false); }
  };
  return (
    <form className="piapp-giris" onSubmit={gir}>
      <h1>Evvel Yeni</h1>
      <div style={{ color: 'var(--ink3)', fontSize: 13 }}>Evvel kullanıcı adın ve şifrenle gir.</div>
      <input id="pi-kadi" aria-label="Kullanıcı adı" placeholder="Kullanıcı adı (ortak şifreyle girişte boş bırak)" value={kadi} onChange={(e) => setKadi(e.target.value)} autoComplete="username" />
      <input id="pi-sifre" aria-label="Şifre" type="password" placeholder="Şifre" value={sifre} onChange={(e) => setSifre(e.target.value)} autoComplete="current-password" />
      {hata && <div style={{ color: 'var(--bad)', fontSize: 13 }}>{hata}</div>}
      <button type="submit" disabled={mesgul || !sifre}>{mesgul ? '…' : 'Giriş yap'}</button>
    </form>
  );
}

export default function EvvelYeniApp() {
  const [durum, setDurum] = useState('soruluyor');   // soruluyor | giris | tamam
  const [sekme, setSekme] = useState(sekmeAdresten);
  const [toast, setToast] = useState('');
  const [rozet, setRozet] = useState({});
  const veriGeldi = (v) => setRozet({
    isler: v.isler.length, teslim: v.isler.filter((x) => x.tur === 'teslim').length, farklar: v.ozet.acik_fark_sayisi,
  });

  useEffect(() => {
    document.title = 'Evvel Yeni';
    let jeton = null;
    try { jeton = localStorage.getItem(OTURUM_ANAHTAR); } catch { /* yut */ }
    if (!jeton) { setDurum('giris'); return; }
    api(`/admin-oturum?jeton=${encodeURIComponent(jeton)}`)
      .then((d) => setDurum(d?.gecerli ? 'tamam' : 'giris'))
      .catch(() => setDurum('giris'));
  }, []);
  useEffect(() => {
    const f = () => setSekme(sekmeAdresten());
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const [menuAcik, setMenuAcik] = useState(false);   // dar ekranda menü katmanı
  const [acik, setAcik] = useState(() => { try { return JSON.parse(localStorage.getItem('evvel_yeni_menu_acik') || '[]').slice(0, 1); } catch { return []; } });
  // Sahip (2026-10-16): "bir başlığı açınca diğeri kapansın" → aynı anda TEK başlık açık
  const bolumAc = (ad) => setAcik((a) => {
    const y = a.includes(ad) ? [] : [ad];
    try { localStorage.setItem('evvel_yeni_menu_acik', JSON.stringify(y)); } catch { /* yut */ }
    return y;
  });

  const sekmeDegis = (k) => {
    const yol = k === 'kasam' ? TABAN : `${TABAN}/${k}`;
    if (window.location.pathname !== yol) window.history.pushState(null, '', yol);
    setSekme(k);
  };

  return (
    <div className="piapp">
      <style>{KABUK_CSS}</style>
      {durum === 'soruluyor' && <div style={{ padding: 40, color: 'var(--ink3)' }}>Evvel Yeni açılıyor…</div>}
      {durum === 'giris' && <Giris onTamam={() => setDurum('tamam')} />}
      {durum === 'tamam' && (
        <div className="piapp-duzen">
          <div className="piapp-ust">
            <button type="button" onClick={() => setMenuAcik((x) => !x)} aria-expanded={menuAcik}>{menuAcik ? '✕ Kapat' : '☰ Menü'}</button>
            <b style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 18 }}>Evvel Yeni</b>
            <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink3)' }}>{(TUM_SAYFALAR.find((x) => x.id === sekme) || {}).ad}</span>
          </div>
          {/* SOL MENÜ — sahip: "solda bulunan alanlarda rahatlıkla kurgu yapabileceğiz".
              Yeni konu = yeni satır; bir sayfaya sıkıştırılmaz. Yalnız ÇALIŞAN alanlar listelenir. */}
          <nav className="piapp-sol" data-acik={menuAcik ? '1' : '0'} aria-label="Evvel Yeni bölümleri">
            <div className="piapp-logo">Evvel Yeni</div>

            {BOLUMLER.map((b) => {
              // Sahip (2026-10-16): "ana başlıklar açılır kapanır; tıklayınca aşağı doğru açılsın, basmadıkça kapalı dursun"
              const ac = acik.includes(b.ad);
              const aktif = b.sayfalar.some((m) => m.id === sekme);
              const rozetTop = b.sayfalar.reduce((t, m) => t + (Number(rozet[m.id]) || 0), 0);
              return (<React.Fragment key={b.ad}>
              {/* Sahip: "altında başka başlık yoksa (Şube kazancı gibi) basınca alta açmak yerine DİREKT açılsın" */}
              <button type="button" className="piapp-baslik" aria-expanded={b.sayfalar.length > 1 ? ac : undefined} data-aktif={aktif ? '1' : '0'}
                aria-current={b.sayfalar.length === 1 && aktif ? 'page' : undefined}
                onClick={() => {
                  if (b.sayfalar.length === 1) { sekmeDegis(b.sayfalar[0].id); setMenuAcik(false); setAcik([]); }
                  else bolumAc(b.ad);
                }}>
                <span className="ikon" aria-hidden="true">{b.ikon}</span><span style={{ flex: 1 }}>{b.ad}</span>{b.sayfalar.length > 1 && <span className="ok">▶</span>}
                {aktif && !ac && b.sayfalar.length > 1 && <span className="nokta" title="Açık sayfa bu bölümde" />}
                {!ac && rozetTop > 0 && <span style={{ background: 'var(--bad)', color: 'var(--on)', borderRadius: 999, padding: '0 7px', fontSize: 11.5, fontWeight: 700, letterSpacing: 0 }}>{rozetTop}</span>}
              </button>
              {ac && b.sayfalar.length > 1 && b.sayfalar.map((m) => (
              <a key={m.id} href={m.id === 'kasam' ? TABAN : `${TABAN}/${m.id}`} aria-current={sekme === m.id ? 'page' : undefined}
                onClick={(e) => { e.preventDefault(); sekmeDegis(m.id); setMenuAcik(false); }}>
                <span>{m.ad}<small>{m.alt}</small></span>
                {rozet[m.id] ? <span style={{ background: 'var(--bad)', color: 'var(--on)', borderRadius: 999, padding: '0 8px', fontSize: 12, fontWeight: 700 }}>{rozet[m.id]}</span> : null}
              </a>
            ))}</React.Fragment>);
            })}
          </nav>
          <main className="piapp-ic">
            {(TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'satis'
              ? <SatisModulu gorunum={sekme} />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'maas'
              ? (sekme === 'personel_yoklama' ? <GunlukYoklama /> : sekme === 'personel_takvim' ? <PersonelTakvim onToast={setToast} /> : <MaasModulu onToast={setToast} onSekme={sekmeDegis} />)
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'bar'
              ? <BarModulu />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'tanim'
              ? <TanimModulu gorunum={sekme} onToast={setToast} />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'kart'
              ? <KartModulu onToast={setToast} />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'kazanc'
              ? <KazancModulu />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'odeme'
              ? (sekme === 'kira_takvimi' ? <KiraTakvim /> : <OdemeModulu onToast={setToast} />)
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'gider'
              ? <GiderModulu onToast={setToast} />
              : (TUM_SAYFALAR.find((x) => x.id === sekme) || {}).mod === 'gelir'
              ? <GelirModulu />
              : <KasaModulu gorunum={sekme} onSekme={sekmeDegis} onToast={setToast} onVeri={veriGeldi} sekmesiz />}
          </main>
        </div>
      )}
      {toast && <div className="piapp-toast" role="status">{toast}</div>}
    </div>
  );
}
