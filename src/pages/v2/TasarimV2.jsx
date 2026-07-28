// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — kadife koyu kabuk (PİLOT)
//
// Tasarım kaynağı: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html
// Kapsam: ikon rayı (74px) + görünüm sütunu (222px) + ana alan + detay çekmecesi.
// Yönetim & Karar modülünün 4 görünümü GERÇEK veriyle çalışır; diğer modüller
// mevcut ekranlara köprülenir (veri/işleyiş değişmez).
//
// Not: bu kabuk mevcut açık-krem temayı DEĞİŞTİRMEZ — #tasarim-v2 rotasında ayrı
// yaşar. Pilot onaylanırsa tema token'ları index.css'e taşınır.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, MODULLER, kartYuzey } from './tema';
import { Ikon, KpiSeridi, Hero, Liste, Tablo, Cekmece, Toast, KopruDurumu } from './parcalar';
import KartModulu from './KartModulu';
import OdemeModulu from './OdemeModulu';

// ⚠️ TARİH TUZAĞI: `new Date('2026-07-28T00:00:00')` yerel saat olarak ayrıştırılır,
// `toISOString()` ise UTC'ye çevirir. Türkiye'de (UTC+3) bu, tarihi BİR GÜN GERİ
// kaydırır — takvim 28'i 27 gösterir, "geçen hafta aynı gün" yanlış güne bakar.
// Çözüm: gün aritmetiğini baştan sona UTC'de yap, "bugün"ü yerel parçalardan kur.
const bugunISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const gunEkle = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sayi = (v) => Number(v) || 0;
const yuzde = (a, b) => (b ? (a / b) * 100 : 0);
/** TR ondalık: 6.8 → "6,8" */
const trSayi = (n, basamak = 1) => n.toFixed(basamak).replace('.', ',');

/** Animasyon + hover kuralları — v2 kabuğuna özel, global CSS'e sızmaz. */
const V2_CSS = `
@keyframes v2yuksel{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes v2belir{from{opacity:0}to{opacity:1}}
@keyframes v2kay{from{transform:translateX(52px);opacity:.3}to{transform:none;opacity:1}}
@keyframes v2buyu{from{opacity:0;transform:scale(.96) translateY(10px)}to{opacity:1;transform:none}}
@keyframes v2cizim{from{stroke-dashoffset:640}to{stroke-dashoffset:0}}
@keyframes v2cizgiAc{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.v2-kok ::-webkit-scrollbar{width:10px;height:10px}
.v2-kok ::-webkit-scrollbar-track{background:transparent}
.v2-kok ::-webkit-scrollbar-thumb{background:#3A2C1E;border-radius:5px;border:2px solid #16100A}
.v2-kok ::-webkit-scrollbar-thumb:hover{background:rgba(210,154,91,.5)}
.v2-hover-kalk{transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
.v2-hover-kalk:hover{transform:translateY(-2px);box-shadow:0 12px 26px rgba(0,0,0,.36);border-color:rgba(217,154,78,.4)}
.v2-satir{transition:background .13s}
.v2-satir:hover{background:rgba(217,154,78,.07)}
.v2-mod{transition:background .16s,color .16s}
.v2-mod:hover{background:#1F160D;color:#F3EADC}
.v2-gorunum{transition:background .16s,color .16s}
.v2-gorunum:hover{background:#221809;color:#F3EADC}
@media (prefers-reduced-motion:reduce){.v2-kok *{animation:none!important;transition:none!important}}
`;

export default function TasarimV2({ onGit }) {
  const [mod, setMod] = useState('panel');
  const [gorunum, setGorunum] = useState('bugun');
  const [donem, setDonem] = useState('gun');
  const [cekmece, setCekmece] = useState(null);
  const [toast, setToast] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');

  const [panel, setPanel] = useState(null);
  const [cirolar, setCirolar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [onaylar, setOnaylar] = useState([]);
  // Canlı rozet sayaçları — anahtar → sayı/metin. Sayacı olmayan görünüm rozet göstermez.
  const [rozetler, setRozetler] = useState({});

  // ── veri ───────────────────────────────────────────────────────────────────
  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/panel').catch(() => null),
      api('/ciro?limit=600').catch(() => []),
      api('/subeler').catch(() => []),
      api('/onay-kuyrugu?durum=bekliyor&limit=400').catch(() => []),
    ]).then(([p, c, s, o]) => {
      if (!p && !Array.isArray(c)) setHata('Veriler alınamadı — bağlantıyı kontrol edin.');
      setPanel(p);
      setCirolar(Array.isArray(c) ? c : []);
      setSubeler(Array.isArray(s) ? s : []);
      setOnaylar(Array.isArray(o) ? o : []);
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  useEffect(yukle, []);

  // ── canlı rozet sayaçları ──────────────────────────────────────────────────
  // Tasarımda her görünümün yanında bekleyen iş sayısı var (27 görünüm). Oradaki
  // rakamlar demo; burada GERÇEK uçlardan sayılır. Hepsi hata-yutar: bir uç
  // düşerse o rozet görünmez, kabuk çalışmaya devam eder.
  useEffect(() => {
    let iptal = false;
    const koy = (k, v) => {
      if (iptal || v == null || v === 0 || v === '') return;
      setRozetler(r => ({ ...r, [k]: String(v) }));
    };
    api('/onay-kuyrugu?durum=bekliyor&limit=400')
      .then(d => koy('onay', Array.isArray(d) ? d.length : 0)).catch(() => {});
    api('/ciro-taslak?durum=bekliyor')
      .then(d => koy('ciroOnay', Array.isArray(d) ? d.length : 0)).catch(() => {});
    api('/is-basvurusu/ozet')
      .then(d => koy('basvuru', Number(d?.yeni) || 0)).catch(() => {});
    api('/stok-sayim/bekleyen-onay')
      .then(d => koy('stokSayim', Number(d?.toplam) || 0)).catch(() => {});
    api(`/ops/truth/gunluk-rapor?tarih=${bugunISO()}`)
      .then(d => koy('anomali', (d?.subeler || []).reduce((t, r) => t + (Number(r.anomali_sayisi) || 0), 0)))
      .catch(() => {});
    api('/odeme-plani/bugun?gun=0&personel=1')
      .then(d => koy('odemeBekleyen', Array.isArray(d) ? d.length : 0)).catch(() => {});
    api('/kartlar/borc-faiz-ozet')
      .then(d => koy('ekstreEksik', Number(d?.bu_ay_eksik_ekstre) || 0)).catch(() => {});
    // Gecikmiş kart ≠ ekstresi eksik kart: burada son ödeme günü geçmiş ve
    // asgarisi karşılanmamış kartlar sayılır (kırmızı rozet = gerçekten acil).
    api('/kartlar')
      .then(d => koy('kartGecikmis', (Array.isArray(d) ? d : []).filter(k =>
        Number(k.gun_kaldi) < 0 && Number(k.guncel_borc) > 0 && !k.asgari_karsilandi).length))
      .catch(() => {});
    api('/kart-hareketleri?limit=200')
      .then(d => koy('hareketBelirsiz', (Array.isArray(d) ? d : [])
        .filter(h => h.islem_turu === 'HARCAMA' && (h.harcama_tipi || 'belirsiz') === 'belirsiz').length))
      .catch(() => {});
    return () => { iptal = true; };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── türetilmiş veriler ─────────────────────────────────────────────────────
  const veri = useMemo(() => {
    const bugun = bugunISO();
    const norm = (r) => ({
      tarih: String(r.tarih || '').slice(0, 10),
      sube: r.sube_adi || '—',
      subeId: r.sube_id,
      nakit: sayi(r.nakit),
      kart: sayi(r.pos) + sayi(r.online),
      toplam: sayi(r.toplam) || sayi(r.nakit) + sayi(r.pos) + sayi(r.online),
    });
    const hepsi = cirolar.map(norm);

    // Son ciro girilen gün — bugün henüz girilmemişse "en güncel gün"ü göster.
    const gunler = [...new Set(hepsi.map(r => r.tarih))].sort();
    const sonGun = gunler[gunler.length - 1] || bugun;
    const odakGun = hepsi.some(r => r.tarih === bugun) ? bugun : sonGun;
    const odakBugunMu = odakGun === bugun;

    const gunSatir = hepsi.filter(r => r.tarih === odakGun);
    const gunToplam = gunSatir.reduce((s, r) => s + r.toplam, 0);
    const gunNakit = gunSatir.reduce((s, r) => s + r.nakit, 0);
    const gunKart = gunSatir.reduce((s, r) => s + r.kart, 0);

    // Aynı haftanın önceki günü ile karşılaştırma (7 gün önce)
    const oncekiHafta = gunEkle(odakGun, -7);
    const oncekiToplam = hepsi.filter(r => r.tarih === oncekiHafta).reduce((s, r) => s + r.toplam, 0);
    const delta = oncekiToplam ? ((gunToplam - oncekiToplam) / oncekiToplam) * 100 : null;

    // Sparkline: odak günden geriye 14 gün
    const seri = [];
    for (let i = 13; i >= 0; i--) {
      const g = gunEkle(odakGun, -i);
      seri.push(hepsi.filter(r => r.tarih === g).reduce((s, r) => s + r.toplam, 0));
    }

    // Şube kırılımı — odak gün
    const subeGun = {};
    gunSatir.forEach(r => { subeGun[r.sube] = (subeGun[r.sube] || 0) + r.toplam; });
    const subeGunListe = Object.entries(subeGun).sort((a, b) => b[1] - a[1]);

    // Ay kırılımı — içinde bulunulan ay
    const ayOnEk = odakGun.slice(0, 7);
    const aySatir = hepsi.filter(r => r.tarih.startsWith(ayOnEk));
    const subeAy = {};
    aySatir.forEach(r => {
      if (!subeAy[r.sube]) subeAy[r.sube] = { toplam: 0, nakit: 0, kart: 0, gun: new Set() };
      subeAy[r.sube].toplam += r.toplam;
      subeAy[r.sube].nakit += r.nakit;
      subeAy[r.sube].kart += r.kart;
      subeAy[r.sube].gun.add(r.tarih);
    });
    const ayToplam = aySatir.reduce((s, r) => s + r.toplam, 0);
    const subeAyListe = Object.entries(subeAy)
      .map(([ad, v]) => ({ ad, ...v, gunSayisi: v.gun.size, pay: yuzde(v.toplam, ayToplam) }))
      .sort((a, b) => b.toplam - a.toplam);

    return {
      odakGun, odakBugunMu, gunToplam, gunNakit, gunKart, delta, seri,
      subeGunListe, subeAyListe, ayToplam, ayOnEk, aySatir,
      gunSayisi: new Set(aySatir.map(r => r.tarih)).size,
    };
  }, [cirolar]);

  const bugunOdemeler = useMemo(() => {
    const liste = panel?.bugun_odemeler || [];
    return Array.isArray(liste) ? liste : [];
  }, [panel]);

  // Riskler rozeti zaten yüklü panel verisinden türer (ekstra istek yok).
  useEffect(() => {
    const n = (panel?.oneriler?.length || 0) + (panel?.ciro_eksik_gunler?.length || 0);
    if (n > 0) setRozetler(r => ({ ...r, risk: String(n) }));
  }, [panel]);

  const bugunOdemeToplam = bugunOdemeler.reduce((s, o) => s + sayi(o.tutar ?? o.kalan ?? o.tahmini_tutar), 0);
  const kasaBanka = sayi(panel?.genel_nakit_toplam) + sayi(panel?.genel_kart_toplam);

  // ── gezinme ────────────────────────────────────────────────────────────────
  const modObj = MODULLER.find(m => m.id === mod) || MODULLER[0];
  const gorunumObj = modObj.gorunumler.find(g => g.id === gorunum) || modObj.gorunumler[0];

  const modSec = (id) => {
    const m = MODULLER.find(x => x.id === id);
    if (!m) return;
    setMod(id);
    setGorunum(m.gorunumler[0].id);
    setCekmece(null);
  };

  const koprule = (hedef) => {
    if (!hedef) return;
    if (onGit) onGit(hedef);
    else window.location.hash = hedef;
  };

  // ── görünüm gövdeleri ──────────────────────────────────────────────────────
  const govde = () => {
    if (yukleniyor) {
      return (
        <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>
          Veriler yükleniyor…
        </div>
      );
    }
    if (hata) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{hata}</div>
          <button onClick={yukle} style={{
            marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
            background: `linear-gradient(150deg, #D99A4E, #B06E2C)`, color: '#1C1309',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
          }}>
            Tekrar dene
          </button>
        </div>
      );
    }

    // v2'ye yazılmış modüller
    if (mod === 'kart') {
      return <KartModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} />;
    }
    if (mod === 'odeme') {
      return <OdemeModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }

    if (mod !== 'panel') {
      return <KopruDurumu ad={gorunumObj.ad} onGit={() => koprule(gorunumObj.hedef)} />;
    }

    if (gorunum === 'bugun') return <PanelBugun />;
    if (gorunum === 'ay') return <PanelAy />;
    if (gorunum === 'subeler') return <PanelSubeler />;
    return <PanelRisk />;
  };

  function PanelBugun() {
    const d = veri;
    const kpiler = [
      { etiket: d.odakBugunMu ? 'Bugünkü ciro' : 'Son gün cirosu', deger: fmt(d.gunToplam), alt: `${d.subeGunListe.length} şube · ${d.odakGun}` },
      { etiket: 'Nakit', deger: fmt(d.gunNakit), alt: `payı %${yuzde(d.gunNakit, d.gunToplam).toFixed(0)}`, renk: R.krem },
      { etiket: 'Kart + online', deger: fmt(d.gunKart), alt: `payı %${yuzde(d.gunKart, d.gunToplam).toFixed(0)}`, renk: R.krem },
      { etiket: 'Bugün ödenecek', deger: fmt(bugunOdemeToplam), alt: `${bugunOdemeler.length} kalem · vadesi bugün/geçmiş`, renk: bugunOdemeToplam > 0 ? R.kirmizi : R.yesil },
    ];

    const enIyi = d.subeGunListe[0]?.[1] || 0;
    const ikincil = d.subeGunListe.slice(0, 4).map(([ad, tutar]) => ({
      etiket: ad,
      // Not: "günün %22'si/%15'i" eki sayının okunuşuna göre değişir — ek almayan
      // biçim seçildi ki her oranda doğru okunsun.
      alt: `gün payı %${yuzde(tutar, d.gunToplam).toFixed(0)}`,
      deger: fmt(tutar),
      renk: tutar >= enIyi * 0.8 ? R.yesil : tutar >= enIyi * 0.5 ? R.amber : R.kirmizi,
      _ad: ad, _tutar: tutar,
    }));

    const oneriListe = (panel?.oneriler || []).slice(0, 6).map((o, i) => ({
      id: `oneri-${i}`,
      baslik: o.baslik,
      alt: o.aciklama,
      tutar: sayi(o.tavsiye_tutar) > 0 ? fmt(o.tavsiye_tutar) : '',
      tier: o.renk === 'KIRMIZI' ? 'kritik' : o.renk === 'TURUNCU' ? 'uyari' : 'bilgi',
      // Ödeme kuyruğuna bağlı öneride butonu göster; bağlı değilse yönlendirme yapma.
      aksiyon: o.odeme_id ? 'Ödemeye git' : '',
      _hedef: o.odeme_id ? 'odeme-merkezi' : '',
    }));

    return (
      <>
        <KpiSeridi kpiler={kpiler} />
        <Hero
          etiket={d.odakBugunMu ? 'Bugün · son 14 gün ritmi' : `${d.odakGun} · son 14 gün ritmi`}
          deger={fmt(d.gunToplam)}
          delta={d.delta == null ? '' : `%${trSayi(Math.abs(d.delta))} ${d.delta >= 0 ? '↑' : '↓'}`}
          deltaTip={d.delta == null ? 'notr' : d.delta >= 0 ? 'iyi' : 'kotu'}
          not={
            d.delta == null
              ? 'Geçen haftanın aynı günü için karşılaştırma verisi yok.'
              : `Geçen haftanın aynı günü ${fmt(veri.seri[6] || 0)}. Kasa + banka toplamı ${fmt(kasaBanka)}; bugün ödenmesi gereken ${fmt(bugunOdemeToplam)}.`
          }
          seri={d.seri}
          ikincil={ikincil}
          onIkincil={(h) => setCekmece({
            tip: 'ŞUBE', baslik: h._ad, alt: `${d.odakGun} · gün cirosu`,
            kpi: [
              { etiket: 'Gün cirosu', deger: fmt(h._tutar) },
              { etiket: 'Gün payı', deger: `%${trSayi(yuzde(h._tutar, d.gunToplam))}` },
            ],
            listeBaslik: 'Bu ay',
            satirlar: (() => {
              const s = d.subeAyListe.find(x => x.ad === h._ad);
              if (!s) return [];
              return [
                { ad: 'Ay cirosu', detay: `${s.gunSayisi} gün kayıt`, tutar: fmt(s.toplam) },
                { ad: 'Nakit', detay: `%${yuzde(s.nakit, s.toplam).toFixed(0)}`, tutar: fmt(s.nakit) },
                { ad: 'Kart + online', detay: `%${yuzde(s.kart, s.toplam).toFixed(0)}`, tutar: fmt(s.kart) },
                { ad: 'Günlük ortalama', detay: 'bu ay', tutar: fmt(s.toplam / (s.gunSayisi || 1)) },
              ];
            })(),
            not: 'Rakamlar ciro defterinden geliyor — onaylanmış (aktif) kayıtlar.',
            aksiyonAd: 'Ciro defterini aç',
            _hedef: 'ciro',
          })}
        />
        {oneriListe.length > 0 ? (
          <Liste satirlar={oneriListe} onAc={(l) => koprule(l._hedef)} />
        ) : (
          <div style={{ ...kartYuzey, padding: '28px 24px', textAlign: 'center', color: R.not, fontSize: 13 }}>
            Bugün için açık öneri yok — kasa akışı temiz görünüyor.
          </div>
        )}
      </>
    );
  }

  function PanelAy() {
    const d = veri;
    const ayCiro = sayi(panel?.bu_ay_sadece_ciro) || d.ayToplam;
    const ayNakit = sayi(panel?.bu_ay_nakit);
    const ayPos = sayi(panel?.bu_ay_pos);
    const ayOnline = sayi(panel?.bu_ay_online);
    const kesinti = sayi(panel?.bu_ay_online_kesinti);
    const gunOrt = d.gunSayisi ? d.ayToplam / d.gunSayisi : 0;

    const kpiler = [
      { etiket: 'Ay cirosu', deger: fmt(ayCiro), alt: `${d.gunSayisi} gün kayıt · ${d.ayOnEk}` },
      { etiket: 'Günlük ortalama', deger: fmt(gunOrt), alt: 'kayıtlı günler üzerinden', renk: R.krem },
      { etiket: 'Kasa + banka', deger: fmt(kasaBanka), alt: 'anlık toplam', renk: kasaBanka > 0 ? R.yesil : R.kirmizi },
      { etiket: 'Onay bekleyen', deger: String(onaylar.length), alt: 'kuyrukta', renk: onaylar.length ? R.amber : R.yesil },
    ];

    const dagilim = [
      { ad: 'Nakit', tutar: ayNakit || d.aySatir.reduce((s, r) => s + r.nakit, 0), renk: R.yesil },
      { ad: 'POS', tutar: ayPos, renk: R.bakir },
      { ad: 'Online', tutar: ayOnline, renk: R.mavi },
      { ad: 'Online kesinti', tutar: -kesinti, renk: R.kirmizi },
    ].filter(x => x.tutar !== 0);
    const enBuyuk = Math.max(...dagilim.map(x => Math.abs(x.tutar)), 1);

    return (
      <>
        <KpiSeridi kpiler={kpiler} />
        <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 16,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>Ay cirosu neyden oluştu</span>
            <span style={{ fontSize: 11, color: R.not2 }}>ödeme tipine göre kırılım</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
            {dagilim.map((x, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ width: 128, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{x.ad}</span>
                <div style={{ flex: 1, height: 20, borderRadius: 6, background: R.cizgi2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 6,
                    width: `${(Math.abs(x.tutar) / enBuyuk) * 100}%`, background: x.renk,
                  }} />
                </div>
                <span style={{
                  width: 140, textAlign: 'right', whiteSpace: 'nowrap',
                  fontFamily: F.mono, fontSize: 13.5, fontWeight: 700, color: x.renk,
                }}>
                  {fmt(x.tutar)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  function PanelSubeler() {
    const d = veri;
    if (!d.subeAyListe.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Bu ay için ciro kaydı bulunamadı.
        </div>
      );
    }
    const enIyi = d.subeAyListe[0];
    const enZayif = d.subeAyListe[d.subeAyListe.length - 1];
    const enBuyukPay = enIyi.pay || 1;

    const kpiler = [
      { etiket: 'En yüksek ciro', deger: enIyi.ad, alt: fmt(enIyi.toplam), renk: R.yesil },
      { etiket: 'En düşük ciro', deger: enZayif.ad, alt: fmt(enZayif.toplam), renk: R.kirmizi },
      { etiket: 'Aktif şube', deger: String(d.subeAyListe.length), alt: `${subeler.length} tanımlı şube`, renk: R.krem },
      { etiket: 'Ay toplamı', deger: fmt(d.ayToplam), alt: `${d.gunSayisi} gün`, renk: R.krem },
    ];

    return (
      <>
        <KpiSeridi kpiler={kpiler} />
        <Tablo
          baslik={`Şube karnesi · ${d.ayOnEk}`}
          not="satıra tıkla → şube dosyası"
          kolonlar={[
            { ad: 'Şube' }, { ad: 'Ciro', sag: true }, { ad: 'Nakit', sag: true },
            { ad: 'Kart + online', sag: true }, { ad: 'Günlük ort.', sag: true },
            { ad: 'Zincir payı', sag: true }, { ad: 'Kayıt' },
          ]}
          satirlar={d.subeAyListe.map(s => ({
            id: s.ad,
            _s: s,
            hucreler: [
              { v: s.ad, kalin: true },
              { v: fmt(s.toplam), mono: true, sag: true },
              { v: fmt(s.nakit), mono: true, sag: true },
              { v: fmt(s.kart), mono: true, sag: true },
              { v: fmt(s.toplam / (s.gunSayisi || 1)), mono: true, sag: true },
              { v: `%${trSayi(s.pay)}`, bar: (s.pay / enBuyukPay) * 100, sag: true, renk: s.pay >= enBuyukPay * 0.8 ? R.yesil : s.pay >= enBuyukPay * 0.5 ? R.amber : R.kirmizi },
              { v: `${s.gunSayisi} gün`, rozet: s.gunSayisi >= d.gunSayisi ? R.yesil : R.amber },
            ],
          }))}
          onSatir={(row) => {
            const s = row._s;
            setCekmece({
              tip: 'ŞUBE DOSYASI', baslik: s.ad, alt: `${d.ayOnEk} · ${s.gunSayisi} gün kayıt`,
              kpi: [
                { etiket: 'Ay cirosu', deger: fmt(s.toplam) },
                { etiket: 'Zincir payı', deger: `%${trSayi(s.pay)}` },
                { etiket: 'Günlük ort.', deger: fmt(s.toplam / (s.gunSayisi || 1)) },
                { etiket: 'Nakit payı', deger: `%${yuzde(s.nakit, s.toplam).toFixed(0)}` },
              ],
              listeBaslik: 'Ödeme tipine göre',
              satirlar: [
                { ad: 'Nakit', detay: `%${yuzde(s.nakit, s.toplam).toFixed(0)}`, tutar: fmt(s.nakit) },
                { ad: 'Kart + online', detay: `%${yuzde(s.kart, s.toplam).toFixed(0)}`, tutar: fmt(s.kart) },
              ],
              not: s.gunSayisi < d.gunSayisi
                ? `Bu şubede ${d.gunSayisi - s.gunSayisi} gün ciro kaydı eksik — karşılaştırma bu yüzden düşük çıkabilir.`
                : 'Ay boyunca eksik gün yok, karne tam.',
              aksiyonAd: 'Ciro defterini aç',
              _hedef: 'ciro',
            });
          }}
        />
      </>
    );
  }

  function PanelRisk() {
    const oneriler = panel?.oneriler || [];
    const kritik = oneriler.filter(o => o.renk === 'KIRMIZI');
    const uyari = oneriler.filter(o => o.renk === 'TURUNCU');
    const digerler = oneriler.filter(o => o.renk !== 'KIRMIZI' && o.renk !== 'TURUNCU');
    const eksikGunler = panel?.ciro_eksik_gunler || [];

    const kpiler = [
      { etiket: 'Kritik', deger: String(kritik.length), alt: 'bugün karar gerekiyor', renk: kritik.length ? R.kirmizi : R.yesil },
      { etiket: 'Uyarı', deger: String(uyari.length), alt: 'bu hafta içinde', renk: uyari.length ? R.amber : R.yesil },
      { etiket: 'Onay kuyruğu', deger: String(onaylar.length), alt: 'bekleyen işlem', renk: onaylar.length ? R.amber : R.yesil },
      { etiket: 'Ciro eksik gün', deger: String(eksikGunler.length), alt: 'kayıt girilmemiş', renk: eksikGunler.length ? R.kirmizi : R.yesil },
    ];

    const satirlar = [
      ...oneriler.map((o, i) => ({
        id: `o-${i}`, baslik: o.baslik, alt: o.aciklama,
        tutar: sayi(o.tavsiye_tutar) > 0 ? fmt(o.tavsiye_tutar) : '',
        tier: o.renk === 'KIRMIZI' ? 'kritik' : o.renk === 'TURUNCU' ? 'uyari' : 'bilgi',
        aksiyon: o.odeme_id ? 'Ödemeye git' : '', _hedef: o.odeme_id ? 'odeme-merkezi' : '',
      })),
      ...eksikGunler.slice(0, 6).map((g, i) => ({
        id: `e-${i}`,
        baslik: `${g.sube_adi || g.sube || 'Şube'} · ${String(g.tarih || g).slice(0, 10)} cirosu girilmemiş`,
        alt: 'kâr ve kasa rakamları bu gün için eksik hesaplanır',
        tutar: '', tier: 'uyari', aksiyon: 'Ciro gir', _hedef: 'ciro',
      })),
    ];

    return (
      <>
        <KpiSeridi kpiler={kpiler} />
        {satirlar.length ? (
          <Liste satirlar={satirlar} onAc={(l) => koprule(l._hedef)} />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.yesil }}>Açık risk yok</div>
            <div style={{ fontSize: 13, color: R.not, marginTop: 8 }}>
              Öneri kuyruğu ve ciro kayıtları temiz görünüyor.
            </div>
          </div>
        )}
      </>
    );
  }

  // ── kabuk ──────────────────────────────────────────────────────────────────
  return (
    <div className="v2-kok" style={{
      display: 'flex', height: '100vh', overflow: 'hidden', color: R.krem,
      fontFamily: F.govde, fontSize: 14, lineHeight: 1.5,
      background: `radial-gradient(1100px 620px at 68% -12%, rgba(64,45,24,.55), transparent), ${R.zemin}`,
    }}>
      <style>{V2_CSS}</style>

      {/* ikon rayı */}
      <div style={{
        width: 74, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 6, padding: '16px 0 12px', background: R.ray, borderRight: `1px solid ${R.cizgi}`,
        overflowY: 'auto', overflowX: 'hidden', minHeight: 0, scrollbarWidth: 'none',
      }}>
        <div style={{
          position: 'relative', fontFamily: F.baslik, fontSize: 22, fontWeight: 600,
          color: R.krem, lineHeight: 1, paddingBottom: 14, marginBottom: 8,
        }}>
          E<span style={{ color: R.bakir }}>.</span>
          <span style={{
            position: 'absolute', left: 0, bottom: 6, width: 26, height: 2, background: R.bakir,
            transformOrigin: 'left', animation: 'v2cizgiAc .8s cubic-bezier(.22,1,.36,1) .2s both',
          }} />
        </div>

        {MODULLER.map(m => {
          const aktif = m.id === mod;
          // Tasarım kuralı: modülde KIRMIZI rozetli (acil) bir görünüm varsa
          // ray ikonunda kırmızı nokta belirir.
          const acilVar = m.gorunumler.some(g => g.renk === '#F87171' && rozetler[g.rozet]);
          return (
            <div
              key={m.id}
              onClick={() => modSec(m.id)}
              title={m.ad}
              className="v2-mod"
              style={{
                position: 'relative', flexShrink: 0, width: 52, padding: '9px 0 7px', borderRadius: 12,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer',
                color: aktif ? R.bakir : R.not,
                background: aktif ? 'rgba(217,154,78,.13)' : 'transparent',
              }}
            >
              <Ikon yol={m.ikon} />
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase' }}>
                {m.kisa}
              </span>
              {acilVar && (
                <span style={{
                  position: 'absolute', top: 6, right: 6, width: 6, height: 6,
                  borderRadius: 99, background: R.kirmizi,
                }} />
              )}
            </div>
          );
        })}

        <div style={{
          marginTop: 'auto', flexShrink: 0, width: 34, height: 34, borderRadius: 99,
          background: `linear-gradient(150deg, ${R.bakir}, ${R.bakirKoyu})`, color: '#1C1309',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
        }}>
          OK
        </div>
      </div>

      {/* görünüm sütunu */}
      <div style={{
        width: 222, flexShrink: 0, display: 'flex', flexDirection: 'column',
        background: R.sutun, borderRight: `1px solid ${R.cizgi}`,
      }}>
        <div style={{ padding: '20px 18px 14px', borderBottom: `1px solid ${R.cizgi}` }}>
          <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{modObj.ad}</div>
          <div style={{ fontSize: 10.5, color: R.not2, letterSpacing: '.8px', textTransform: 'uppercase', marginTop: 4 }}>
            {modObj.alt}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {modObj.gorunumler.map(g => {
            const aktif = g.id === gorunum;
            return (
              <div
                key={g.id}
                onClick={() => { setGorunum(g.id); setCekmece(null); }}
                className="v2-gorunum"
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', borderRadius: 9,
                  cursor: 'pointer', fontSize: 12.5,
                  color: aktif ? R.krem : R.metin2,
                  background: aktif ? 'rgba(217,154,78,.1)' : 'transparent',
                  borderLeft: `2px solid ${aktif ? R.bakir : 'transparent'}`,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{g.ad}</span>
                {rozetler[g.rozet] && (
                  <span style={{
                    minWidth: 19, padding: '1px 6px', borderRadius: 99, fontSize: 10, fontWeight: 700,
                    fontFamily: F.mono, textAlign: 'center',
                    background: `${g.renk || R.bakir}22`, color: g.renk || R.bakir,
                  }}>
                    {rozetler[g.rozet]}
                  </span>
                )}
                {g.hedef && !rozetler[g.rozet] && <span style={{ fontSize: 9.5, color: R.not3 }}>↗</span>}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '14px 16px', borderTop: `1px solid ${R.cizgi}`, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 10, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
            Kasa + banka
          </span>
          <div style={{
            whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 17, fontWeight: 700,
            color: kasaBanka >= 0 ? R.yesil : R.kirmizi,
          }}>
            {yukleniyor ? '…' : fmt(kasaBanka)}
          </div>
          <div style={{ fontSize: 10.5, color: R.not2, lineHeight: 1.5 }}>
            {bugunOdemeToplam > 0
              ? `bugün ödenecek ${fmt(bugunOdemeToplam)}`
              : 'bugün vadesi gelen ödeme yok'}
          </div>
        </div>
      </div>

      {/* ana alan */}
      <main style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <header style={{
          position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 18, padding: '15px 30px 13px',
          background: 'rgba(22,16,10,.86)', backdropFilter: 'blur(16px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(16px) saturate(1.2)', borderBottom: `1px solid ${R.cizgi}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, letterSpacing: '1px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
              {modObj.ad}
            </div>
            <h1 style={{ fontFamily: F.baslik, fontSize: 23, fontWeight: 600, lineHeight: 1.2, marginTop: 3 }}>
              {gorunumObj.ad}
            </h1>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi}` }}>
              {[['gun', 'Gün'], ['hafta', 'Hafta'], ['ay', 'Ay']].map(([id, ad]) => (
                <div
                  key={id}
                  onClick={() => { setDonem(id); if (mod === 'panel') setGorunum(id === 'ay' ? 'ay' : 'bugun'); }}
                  style={{
                    padding: '5px 11px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                    color: donem === id ? '#1C1309' : R.not,
                    background: donem === id ? `linear-gradient(150deg, #D99A4E, #B06E2C)` : 'transparent',
                  }}
                >
                  {ad}
                </div>
              ))}
            </div>

            <button
              onClick={() => { yukle(); setToast('Veriler tazelendi'); }}
              style={{
                padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
                background: R.girinti, color: R.metin2, fontSize: 12.5, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              Yenile
            </button>

            <button
              onClick={() => koprule('panel')}
              style={{
                padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
                background: R.girinti, color: R.metin2, fontSize: 12.5, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              Klasik görünüm
            </button>

            {/*
              Blueprint'te üst çubukta "Gün Sonu Kapat" var. Ama bu sistemde gün
              sonunu KASA KİMDEYSE O kapatır (şubede, 5 adımlı mühür/QR akışı) —
              masaüstünden tek tuşla 4 şubeyi kapatmak o modeli deler.
              Sahip kararı: buton DURUR ama kapatmaz; kapanışın izlendiği ekrana
              götürür (Operasyon Merkezi → 📊 Kapanış Takip).
            */}
            <button
              onClick={() => koprule('kapanis-takip')}
              title="Kapanış takibini açar — kapatma işlemi şubede mühür/QR ile yapılır"
              style={{
                padding: '8px 15px', borderRadius: 10, border: 'none',
                background: `linear-gradient(150deg, #D99A4E, #B06E2C)`, color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                boxShadow: '0 6px 18px rgba(217,154,78,.24)',
              }}
            >
              Gün Sonu Takibi
            </button>
          </div>
        </header>

        <div style={{
          padding: '22px 30px 60px', maxWidth: 1420, margin: '0 auto',
          animation: 'v2yuksel .28s cubic-bezier(.22,1,.36,1) both',
        }}>
          {govde()}
        </div>

        <Cekmece
          acik={!!cekmece}
          tip={cekmece?.tip}
          baslik={cekmece?.baslik}
          alt={cekmece?.alt}
          kpi={cekmece?.kpi}
          listeBaslik={cekmece?.listeBaslik}
          satirlar={cekmece?.satirlar}
          not={cekmece?.not}
          aksiyonAd={cekmece?.aksiyonAd}
          onAksiyon={() => koprule(cekmece?._hedef)}
          onKapat={() => setCekmece(null)}
        />
        <Toast metin={toast} />
      </main>
    </div>
  );
}
