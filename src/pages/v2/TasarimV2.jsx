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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, istekHatalari, istekHatalariniTemizle, istekHatasiDinle } from '../../utils/api';
import { R, F, MODULLER, GUN_SONU_MODULLERI, TARIH_GEZGINI_EKRANLARI, kartYuzey } from './tema';
import { Ikon, KpiSeridi, Hero, Liste, Tablo, Cekmece, Toast, KopruDurumu, HataBandi } from './parcalar';
import GenelModulu from './GenelModulu';
import KartModulu from './KartModulu';
import OdemeModulu from './OdemeModulu';
import EslesmeModulu from './EslesmeModulu';
import VergiModulu from './VergiModulu';
import TeshisModulu from './TeshisModulu';
import OpsModulu from './OpsModulu';
import MaliyetModulu from './MaliyetModulu';
import EkipModulu from './EkipModulu';
import BorcModulu from './BorcModulu';
import ParaModulu from './ParaModulu';
import DenetimModulu from './DenetimModulu';
import BelgeModulu from './BelgeModulu';
import { OnayModulu, YukModulu, RaporModulu, SistemModulu, TanimModulu } from './KucukModuller';

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
const AY_KISA_V2 = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
/** '2026-07-22' → '22 Tem'. Metin üzerinden çalışır, Date kurmaz (UTC kayması yok). */
const kisaGun = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${AY_KISA_V2[Number(m[2]) - 1]}` : String(iso || '');
};

const HAFTA_ADI = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
/** '2026-07-29' → '29 Tem 2026 · Çarşamba' (UTC'de kurulur, gün kaymaz). */
const uzunGun = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || '');
  const g = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return `${Number(m[3])} ${AY_KISA_V2[Number(m[2]) - 1]} ${m[1]} · ${HAFTA_ADI[g]}`;
};

const kisalt = (t, n = 90) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };

const sayi = (v) => Number(v) || 0;
const yuzde = (a, b) => (b ? (a / b) * 100 : 0);

/** Aramada Türkçe karakter duyarsızlığı: 'maas' → "Maaş & Avans" bulunur.
 *  ⚠️ Türkçe-I tuzağı: toLocaleLowerCase('tr') 'I'yı 'ı' yapar; burada zaten
 *  hemen ardından 'ı'→'i' indirgemesi geldiği için iki yön de aynı yere düşer. */
const TR_HARF = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
const sadeles = (s) => String(s ?? '').toLocaleLowerCase('tr').replace(/[çğıöşüâîû]/g, (c) => TR_HARF[c]);
/** TR ondalık: 6.8 → "6,8" */
const trSayi = (n, basamak = 1) => n.toFixed(basamak).replace('.', ',');
/** Sunucu gün adını İngilizce gönderiyor ("Friday") — ekranda Türkçe durur.
 *  Eşleşmeyen değer ham geçer (yeni/beklenmedik ad sessizce "—" olmasın). */
const GUN_TR = {
  Monday: 'Pazartesi', Tuesday: 'Salı', Wednesday: 'Çarşamba', Thursday: 'Perşembe',
  Friday: 'Cuma', Saturday: 'Cumartesi', Sunday: 'Pazar',
};
const gunTr = (g) => {
  const s = String(g || '').trim();
  return GUN_TR[s] || s;
};

/** KRİTİK NAKİT GRUPLAMA — Genel Bakış'taki kuralın aynısı (iki ekran ayrışmasın).
 *  Motor, serbest nakde sığmayan HER kart için ayrı bir "NAKİT YETERSİZ" önerisi
 *  üretiyor → aynı TEK sebep (para yetmiyor) listede 5-6 kez tekrarlayıp diğer
 *  önerileri aşağı itiyordu. 2+ ise tek satırda birleşir, kartlar alt bilgide.
 *  ⚠️ Tutar YAZILMAZ: bu önerilerde sunucu tavsiye_tutar=0 gönderir, istenen
 *  tutar yalnız açıklama metninin içinde geçer — metinden para PARSE ETMEK yasak
 *  (biçim değişince sessizce yanlış rakam basar). */
const kritikNakitAyir = (oneriler) => {
  const hepsi = oneriler || [];
  const grup = hepsi.filter((o) => String(o.oneri_turu || '') === 'KRITIK_NAKIT');
  if (grup.length < 2) return { grupSatiri: null, kalan: hepsi };
  const kartlar = grup.map((o) => o.kart_adi || o.banka).filter(Boolean);
  return {
    grupSatiri: {
      id: 'oneri-kritik-nakit-grubu',
      baslik: `⛔ NAKİT YETERSİZ — ${grup.length} kart`,
      alt: `serbest nakit bu ödemelere yetmiyor${kartlar.length ? ` · kartlar: ${kartlar.join(', ')}` : ''}`,
      tutar: '', tier: 'kritik', aksiyon: '', _hedef: '',
    },
    kalan: hepsi.filter((o) => String(o.oneri_turu || '') !== 'KRITIK_NAKIT'),
  };
};

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
.v2-arama{transition:border-color .16s,box-shadow .16s}
.v2-arama:hover{border-color:rgba(217,154,78,.4)}
.v2-kok ::selection{background:rgba(217,154,78,.32);color:#FFF6E9}
.v2-kok :focus-visible{outline:2px solid #D29A5B;outline-offset:2px;border-radius:4px}
@media (prefers-reduced-motion: reduce){.v2-kok *,.v2-kok *::before,.v2-kok *::after{transition-duration:.01ms !important;animation-duration:.01ms !important}}
/* Duyarlı kabuk (yeni handoff): dar ekranda görünüm kolonu çip satırına döner,
   çok darda ray incelir. Kolonun yerine geçen çip satırı içerik üstünde yaşar. */
.v2-cip-satiri{display:none}
@media (max-width:1040px){
  .v2-sutun{display:none!important}
  .v2-cip-satiri{display:flex!important}
}
@media (max-width:720px){
  .v2-ray{width:56px!important}
  .v2-mod{width:44px!important}
}
@media (prefers-reduced-motion:reduce){.v2-kok *{animation:none!important;transition:none!important}}
`;

export default function TasarimV2({ onGit }) {
  const [mod, setMod] = useState('panel');
  const [gorunum, setGorunum] = useState('bugun');
  const [donem, setDonem] = useState('gun');
  const [cekmece, setCekmece] = useState(null);
  // Parametreli köprü yükü ('__modul:belge:cari:<ad>') — hedef ekran okur.
  const [kopruParam, setKopruParam] = useState(null);
  const [toast, setToast] = useState('');
  // Komut paleti (yeni handoff): ⌘K / Ctrl+K / '/' ile 40 ekrana tek yerden erişim
  const [subeOps, setSubeOps] = useState(null);   // şube × sevkiyat trafiği
  // /ops/v2/sube-davranis + /ops/v2/sube-skor — "hangi şube DÜZGÜN çalışıyor"
  const [subeDavranis, setSubeDavranis] = useState(null);
  const [subeSkor, setSubeSkor] = useState(null);
  // Haftalık kıyas (/ops/haftalik-karsilastirma) + şube gider (/metrics/finans-ozet)
  const [subeHafta, setSubeHafta] = useState(null);
  const [subeFinans, setSubeFinans] = useState(null);
  // TARİH GEZGİNİ: null = CANLI (bugün/son gün). Dolu ise geçmiş gün modu.
  const [secilenGun, setSecilenGun] = useState(null);
  const [palet, setPalet] = useState(false);
  const [paletQ, setPaletQ] = useState('');
  const [paletI, setPaletI] = useState(0);
  const paletRef = useRef(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');

  const [panel, setPanel] = useState(null);
  const [eksikCiro, setEksikCiro] = useState(null);   // /ciro/eksik-gunler
  const [cirolar, setCirolar] = useState([]);
  const [subeler, setSubeler] = useState([]);
  const [onaylar, setOnaylar] = useState([]);
  const [uyarilar, setUyarilar] = useState([]);   // Genel Bakış: klasik CFO triajı
  // Canlı rozet sayaçları — anahtar → sayı/metin. Sayacı olmayan görünüm rozet göstermez.
  const [rozetler, setRozetler] = useState({});

  // ── veri ───────────────────────────────────────────────────────────────────
  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/panel').catch(() => null),
      api('/uyarilar').catch(() => []),
      api('/ciro?limit=600').catch(() => []),
      api('/subeler').catch(() => []),
      api('/onay-kuyrugu?durum=bekliyor&limit=400').catch(() => []),
      // 📅 EKSİK CİRO (2026-08-09 sahip: "panel bir şubenin cirosunu 8 Ağustos
      // için gösteriyor, neden?"). Ciro girilmeyince kayıt yok, kayıt yoksa
      // alarm da yok — "yokluğun alarmı" hiç kurulmamıştı.
      api('/ciro/eksik-gunler?gun=14').catch(() => null),
    ]).then(([p, u, c, s, o, ec]) => {
      // 🔴 EVV-PANEL-N1 (2026-08-13 satır-satır denetim) FAKE-GREEN: /ciro catch `[]`
      // döndürdüğü için `!Array.isArray(c)` HİÇ true olmuyordu → `!p && false` = /panel
      // düşse de hata SET EDİLMİYOR, dashboard 0/boş render ediyordu. /panel kanonik
      // kaynak; düşerse açık hata (kart/KPI 0/yeşil yalanı gizlensin).
      if (!p) setHata('Panel verisi alınamadı — "0/boş" görünüm yanıltıcı olur, yenileyin.');
      setEksikCiro(ec);
      setPanel(p);
      setUyarilar(Array.isArray(u) ? u : (u?.uyarilar || []));
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
  // ⏳ ROZETLER GECİKMELİ YÜKLENİR (2026-08-08, sahip: "veriler sayfa açıldığında
  // hemen gelmiyor, tekrar dene deyince geliyor").
  // Panel açılışta ~30 uç çağırıyordu; hepsi AYNI ANDA gidince DB bağlantı
  // havuzu (24) tükeniyor, geride kalan istekler hata alıyordu. Rozetler menü
  // süsüdür — ilk boyamayı bekletmemeli. 1,2 sn gecikmeyle ikinci dalgada
  // yüklenirler: ekran verisi önce gelir, havuz rahatlar, rozet sonra düşer.
  useEffect(() => {
    let iptal = false;
    let zamanlayici = null;
    const koy = (k, v) => {
      if (iptal || v == null || v === 0 || v === '') return;
      setRozetler(r => ({ ...r, [k]: String(v) }));
    };
    zamanlayici = setTimeout(() => {
      if (iptal) return;
      rozetleriYukle();
    }, 1200);
    function rozetleriYukle() {
    // ⚠️ ROZET ≠ EKRAN tutarsızlığı (2026-08-07 denetimi): burada ham kuyruk
    // uzunluğu sayılıyordu → menüde "132" kırmızı, ekranda "Kuyruk temiz · 0".
    // Onay Kuyruğu ekranı (KucukModuller:178) islem_turu'nde KASA geçen kayıtları
    // onay saymaz — onlar kasa uyumsuzluğudur, ayrı iş. Rozet AYNI filtreyi
    // uygulamazsa her gün boşuna açılan bir kırmızı üretir (alarm körlüğü).
    api('/onay-kuyrugu?durum=bekliyor&limit=400')
      .then(d => koy('onay', Array.isArray(d)
        ? d.filter(o => !String(o.islem_turu || '').toUpperCase().includes('KASA')).length
        : 0)).catch(() => {});
    api('/ciro-taslak?durum=bekliyor')
      .then(d => koy('ciroOnay', Array.isArray(d) ? d.length : 0)).catch(() => {});
    api('/is-basvurusu/ozet')
      .then(d => koy('basvuru', Number(d?.yeni) || 0)).catch(() => {});
    api('/stok-sayim/bekleyen-onay')
      .then(d => koy('stokSayim', Number(d?.toplam) || 0)).catch(() => {});
    // MUTABAKAT MERKEZİ (2026-08-08): "aradım bulamadım" açık kalem sayısı.
    // Rozeti tema.js'de tanımlayıp beslememek yarım iş olurdu — bugün denetimde
    // tam bu kalıptan 6 ölü rozet çıktı (tanımlı ama hiçbir yerde beslenmiyor).
    api('/ops/mutabakat-merkezi?gun=60')
      .then(d => koy('mutabakatAcik', Number(d?.ozet?.acik_kalem) || 0)).catch(() => {});
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
    // Ekip rozetleri — bu hafta boş vardiya hücresi / onay bekleyen bordro / açık görev
    (() => {
      const b = bugunISO();
      const g = new Date(b + 'T00:00:00Z').getUTCDay();
      const pzt = gunEkle(b, g === 0 ? -6 : 1 - g);
      api(`/vardiya/v2/hafta-sube-tablo?pazartesi=${pzt}`)
        .then(d => {
          const gunler = d?.gunler || [];
          const bos = (d?.subeler || []).reduce((t, s) =>
            t + gunler.filter(x => !((s.gunler || {})[x] || []).length).length, 0);
          koy('vardiyaAcik', bos);
        }).catch(() => {});
      // 🔴 (2026-08-14) ROZET HİÇ ÇALIŞMIYORDU — iki ayrı kusur üst üste:
      //  (a) /personel-aylik NESNE döner {personeller:[...]}; kod Array.isArray(d)
      //      ile diziye zorluyordu → her zaman [] → rozet hep 0.
      //  (b) Sunucudaki onay durumu 'onaylandi', kod 'onayli' arıyordu → o değer
      //      hiç eşleşmiyordu (dizi düzelseydi bile onaylanmışlar bekleyen sayılırdı).
      // Kalan durumlar: 'taslak' + 'onay_bekliyor' = gerçekten bekleyen bordro.
      api(`/personel-aylik?yil=${Number(b.slice(0, 4))}&ay=${Number(b.slice(5, 7))}`)
        .then(d => {
          const ps = Array.isArray(d) ? d : (Array.isArray(d?.personeller) ? d.personeller : []);
          const norm = (x) => (x === 'onaylandi' ? 'onayli' : String(x || 'taslak'));
          koy('maasBekleyen', ps.filter(x => x.durum && !['odendi', 'onayli'].includes(norm(x.durum))).length);
        })
        .catch(() => {});
      api(`/gorev/ozet?tarih=${b}`)
        .then(d => koy('gorevAcik', (Array.isArray(d) ? d : [])
          .reduce((t, r) => t + Math.max(0, (Number(r.toplam) || 0) - (Number(r.tamamlanan) || 0)), 0)))
        .catch(() => {});
    })();
    api('/borc-nav/ozet')
      .then(d => { if (d?.surdurulemez) koy('borcDurum', '!'); }).catch(() => {});
    api('/sabit-giderler')
      .then(d => koy('sabitGider', (Array.isArray(d) ? d : [])
        .filter(g => g.aktif !== false && !g.bu_ay_odendi).length)).catch(() => {});
    api('/ops/tedarik-dosyasi?gun=60&limit=150')
      .then(d => {
        const ds = d?.dosyalar || [];
        koy('teslimatZinciri', ds.filter(x => (Number(x.fatura_say) || 0) === 0).length);
        koy('tedarikDosyasi', ds.filter(x => String(x.kabul_durum || '').toLocaleLowerCase('tr').includes('uyum')).length);
      }).catch(() => {});
    // 🔴 (2026-08-14) Filtre OLMAYAN alanları okuyordu: `gorulme_zamani` ve
    // `gorildi` (yazım hatası) — gerçek alan `goruldu`. İkisi de undefined
    // olduğu için koşul HER olay için doğru çıkıyor, rozet görülmüş olayları da
    // sayıyordu. Uç zaten hazır sayaç gönderiyor (`gorulmemis`) → filtre kalktı.
    api('/teslim-bildirim/liste?gun=7')
      .then(d => koy('bilgiTeslim', Number(d?.gorulmemis) || 0)).catch(() => {});
    api('/kart-hareketleri?limit=200')
      .then(d => koy('hareketBelirsiz', (Array.isArray(d) ? d : [])
        .filter(h => h.islem_turu === 'HARCAMA' && (h.harcama_tipi || 'belirsiz') === 'belirsiz').length))
      .catch(() => {});
    // Operasyon rozetleri — kontrol kulesi özeti (sadece açık aşamalar) + depo eşiği.
    // limit=1: rozet için satır listesi gerekmez, yalnız ozet sayaçları okunur.
    api('/ops/siparis/kontrol-kulesi?gun=14&sadece_acik=true&limit=1')
      .then(d => {
        const o = d?.ozet || {};
        const acik = ['bekliyor', 'depoda', 'yolda', 'toptanci_bekliyor', 'uyumsuzluk']
          .reduce((t, k) => t + (Number(o[k]) || 0), 0);
        koy('opsAcikSiparis', acik);
        koy('opsSevkiyat', Number(o.depoda) || 0);
      })
      .catch(() => {});
    api('/ops/depo-stok')
      .then(d => koy('opsDepoKritik', (d?.kalemler || [])
        .filter(k => Number(k.min_stok) > 0 && Number(k.toplam) < Number(k.min_stok)).length))
      .catch(() => {});
    // Zam Takibi rozeti — incelenmemiş eşik-üstü fiyat artışları.
    // 🔁 (2026-08-16) Görünüm Kâr & Maliyet'ten Genel Bakış'a taşındı; rozet
    // anahtarı 'fiyatZinciri' → 'genelZam' oldu (eski anahtarı tüketen satır
    // kalktı, orada bıraksak hiçbir yerde yanmayan ölü sayaç olurdu).
    // ⚠️ SORGU EKRANLA HİZALANDI: ekran gun=180&limit=60 çekip `!goruldu`
    // sayıyor. Rozet gun=90&sadece_yeni ile sayarsa menüde "3", ekranda "5"
    // yazar — bu dosyanın başındaki "ROZET ≠ EKRAN" tuzağının aynısı. Aynı
    // uç, aynı parametre, aynı filtre → rozet ekranın sözünü tutar.
    // HATA'da rozet YAZILMAZ (catch boş) — uydurma 0 basılmaz.
    api('/ops/fiyat-zam-alarmlari?gun=180&limit=60')
      .then(d => koy('genelZam', (Array.isArray(d?.alarmlar) ? d.alarmlar : [])
        .filter(a => !a.goruldu).length))
      .catch(() => {});
    // Belge rozetleri — kapsama (faturasız harcama adedi), istek (açık istek),
    // mükerrer (şüpheli + işlenemeyen). belge-merkezi tek uçtan ikisi birden.
    api(`/fatura/belge-merkezi?ay=${bugunISO().slice(0, 7)}`)
      .then(d => {
        koy('belgeKapsama', (Array.isArray(d?.faturasiz_harcamalar) ? d.faturasiz_harcamalar : []).length);
        const sup = Number(d?.kdv_kanit?.supheli?.adet) || 0;
        const isle = (Array.isArray(d?.islenemeyen_foto) ? d.islenemeyen_foto : []).length;
        koy('belgeMukerrer', sup + isle);
      })
      .catch(() => {});
    api('/fatura-istek/liste')
      .then(d => koy('faturaIstek', Number(d?.acik_adet) || 0))
      .catch(() => {});
    // ⚠️ KART İZİ + VERGİ ROZETLERİ KALDIRILDI (2026-08-08 canlı ders):
    // İkisi de AĞIR uçtur (kart-izi-otomatik-tara → cari_ozet + 83×11 döngü;
    // kart-vergi-etkisi → 400 hareket + zincir sorguları). Her sayfa açılışında
    // çağrılınca DB bağlantı havuzu tükendi ("PoolError: connection pool
    // exhausted") ve TÜM panel veri alamaz oldu. Rozet uğruna paneli riske
    // atmaya değmez — sayılar ekranın kendisinde zaten var.
    // Gerekirse ileride HAFİF bir sayaç ucu yazılıp bağlanır.
    // kasaTeslim rozeti (duyu 2/6) — teslim edilmemiş gün sonu kapanışı sayısı
    api('/ops/para-yolda?gun=14')
      .then(d => koy('kasaTeslim', Number(d?.bekleyen_adet) || 0))
      .catch(() => {});
    // Duyu mutabakatı rozeti — iki yönlü açık fark sayısı (ödeme↔kasa düşüşü)
    api('/duyu/odeme-mutabakat?gun=60')
      .then(d => {
        const a = Array.isArray(d?.dusus_var_odeme_kaydi_yok) ? d.dusus_var_odeme_kaydi_yok.length : 0;
        const b = Array.isArray(d?.odeme_var_dusus_gorulmedi) ? d.odeme_var_dusus_gorulmedi.length : 0;
        koy('duyuMutabakat', a + b);
      })
      .catch(() => {});
    // Tüketim kontrolü rozeti — satış×reçete beklenene göre %15+ FAZLA açılan
    // malzeme-gün sayısı (fire bildirimi düşüldükten sonra). Uç gece ön-hesaplı
    // önbellekten döner (gun=7), kabuk açılışını yormaz.
    api('/recete/kontrol?gun=7')
      .then(d => koy('tuketimFark', (Array.isArray(d?.kiyas) ? d.kiyas : [])
        .filter(s => {
          const y = s.fark_yuzde_fire_sonrasi ?? s.fark_yuzde;
          return y != null && y >= 15;
        }).length))
      .catch(() => {});
    }
    return () => { iptal = true; if (zamanlayici) clearTimeout(zamanlayici); };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ── YENİ SİPARİŞ BİLDİRİMİ (sahip 2026-07-29: "klasikte modal olarak
  // geliyordu, v2'de yok") — klasik hub'ın izleme deseni kadifeye taşındı:
  // 60 sn'de bir kontrol kulesi taranır; İLK yükleme tohumlar (modal açmaz),
  // sonrasında görülmemiş 'bekliyor' talebi düşerse BİLGİ MODALI açılır.
  const [siparisBildirim, setSiparisBildirim] = useState(null);
  const gorulenTalepRef = React.useRef(new Set());
  const bildirimIlkRef = React.useRef(true);
  useEffect(() => {
    let iptal = false;
    const tara = () => {
      api('/ops/siparis/kontrol-kulesi?gun=3&sadece_acik=true&limit=60')
        .then((d) => {
          if (iptal) return;
          const bekleyenler = (Array.isArray(d?.satirlar) ? d.satirlar : [])
            .filter((s) => s.asama === 'bekliyor');
          const seen = gorulenTalepRef.current;
          if (bildirimIlkRef.current) {
            bekleyenler.forEach((s) => seen.add(String(s.id)));
            bildirimIlkRef.current = false;
            return;
          }
          const yeniler = bekleyenler.filter((s) => !seen.has(String(s.id)));
          if (yeniler.length) {
            yeniler.forEach((s) => seen.add(String(s.id)));
            setSiparisBildirim({ yeniler });
          }
        })
        .catch(() => {});
    };
    tara();
    const t = setInterval(tara, 60000);
    return () => { iptal = true; clearInterval(t); };
  }, []);

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
    // Tarih gezgini seçiliyse odak O GÜN olur — veri gerçekten o günden süzülür,
    // ölçekleme/uydurma yok. Seçilen günde kayıt yoksa liste boş çıkar (dürüst).
    const odakGun = secilenGun || (hepsi.some(r => r.tarih === bugun) ? bugun : sonGun);
    const odakBugunMu = odakGun === bugun;

    const gunSatir = hepsi.filter(r => r.tarih === odakGun);
    const gunToplam = gunSatir.reduce((s, r) => s + r.toplam, 0);
    const gunNakit = gunSatir.reduce((s, r) => s + r.nakit, 0);
    const gunKart = gunSatir.reduce((s, r) => s + r.kart, 0);

    // Aynı haftanın önceki günü ile karşılaştırma (7 gün önce)
    const oncekiHafta = gunEkle(odakGun, -7);
    const oncekiToplam = hepsi.filter(r => r.tarih === oncekiHafta).reduce((s, r) => s + r.toplam, 0);
    const delta = oncekiToplam ? ((gunToplam - oncekiToplam) / oncekiToplam) * 100 : null;

    // Sparkline: odak günden geriye 14 gün (grafiğin üzerinde gezerken
    // hangi günü okuduğun görünsün diye etiketleri de biriktiriyoruz)
    const seri = [];
    const seriEtiket = [];
    for (let i = 13; i >= 0; i--) {
      const g = gunEkle(odakGun, -i);
      seri.push(hepsi.filter(r => r.tarih === g).reduce((s, r) => s + r.toplam, 0));
      seriEtiket.push(kisaGun(g));
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
      odakGun, odakBugunMu, gunToplam, gunNakit, gunKart, delta, seri, seriEtiket,
      subeGunListe, subeAyListe, ayToplam, ayOnEk, aySatir,
      gunSayisi: new Set(aySatir.map(r => r.tarih)).size,
      // 🔴 EVV-PANEL-N4 (2026-08-13): /ciro?limit=600 SESSİZ KIRPMA — 600'e ulaşınca
      // ayToplam/subeAyListe/seri eksik sayabilir (has_more kontrolü yok). Bayrak:
      // Ay/Şube görünümü "veri kırpılmış olabilir" uyarısı gösterir.
      ciroKirpildi: cirolar.length >= 600,
    };
  }, [cirolar, secilenGun]);

  const bugunOdemeler = useMemo(() => {
    const liste = panel?.bugun_odemeler || [];
    return Array.isArray(liste) ? liste : [];
  }, [panel, uyarilar]);

  // Riskler rozeti zaten yüklü panel verisinden türer (ekstra istek yok).
  useEffect(() => {
    const n = (panel?.oneriler?.length || 0) + (panel?.ciro_eksik_gunler?.length || 0);
    if (n > 0) setRozetler(r => ({ ...r, risk: String(n) }));
    // Genel Bakış rozeti = KRİTİK seviyeli uyarı sayısı (sahte sayı yok:
    // uyarı gelmezse rozet hiç çıkmaz)
    const kritikSayi = (Array.isArray(uyarilar) ? uyarilar : [])
      .filter((u) => String(u.seviye || u.tier || '').toUpperCase() === 'KRITIK').length;
    if (kritikSayi > 0) setRozetler(r => ({ ...r, genelAcik: String(kritikSayi) }));
  }, [panel, uyarilar]);

  const bugunOdemeToplam = bugunOdemeler.reduce((s, o) => s + sayi(o.tutar ?? o.kalan ?? o.tahmini_tutar), 0);
  // 📅 GECİKMİŞ / BUGÜN AYRIMI (2026-08-09, sahip: "bugün ödenecekler neden bu
  // kadar yüksek?"). Sebep: liste "vadesi bugün VE GEÇMİŞ" olanları birlikte
  // veriyor; canlıda bugüne ait TEK KURUŞ yok, 946.018 ₺'nin tamamı gecikmiş
  // (en eskisi 09.06 — iki ay). "Bugün ödenecek" etiketi bunu söylemiyordu.
  // 🔴 P1 (2026-08-12): önce new Date().toISOString() = UTC idi; TR (UTC+3) gece
  // 00:00-02:59 arası düne kayıp vadesi bugün olanı "gecikmiş" sayıyordu. Dosyanın
  // kanonik TR-yerel yardımcısı bugunISO() ile hizalandı.
  const _bugunISO = bugunISO();
  const _vadeAl = (o) => String(o.tarih ?? o.vade ?? o.vade_tarihi ?? '').slice(0, 10);
  const gecikmisOdemeler = bugunOdemeler.filter((o) => {
    const v = _vadeAl(o);
    return o.gecikmis === true || (v && v < _bugunISO);
  });
  const gercekBugunOdemeler = bugunOdemeler.filter((o) => !gecikmisOdemeler.includes(o));
  const _top = (l) => l.reduce((s, o) => s + sayi(o.tutar ?? o.kalan ?? o.tahmini_tutar), 0);
  const gecikmisToplam = _top(gecikmisOdemeler);
  const gercekBugunToplam = _top(gercekBugunOdemeler);
  const enEskiGecikme = gecikmisOdemeler.reduce(
    (m, o) => Math.max(m, sayi(o.gun_gecikme)), 0);
  // KASA = kanonik alan panel.kasa (motors.guncel_kasa — kasa izi tek gerçek).
  // Sahip yakaladı (2026-07-29): genel_nakit_toplam+genel_kart_toplam FARKLI bir
  // çift toplamdı (1.842.161) ve gerçek kasadan (2.533.389) sapıyordu — klasik
  // CFO Panel ile v2 aynı sayıyı göstermek ZORUNDA.
  const kasaBanka = sayi(panel?.kasa);

  // ── gezinme ────────────────────────────────────────────────────────────────
  const modObj = MODULLER.find(m => m.id === mod) || MODULLER[0];
  const gorunumObj = modObj.gorunumler.find(g => g.id === gorunum) || modObj.gorunumler[0];

  /** Geçmiş gün modunda "Bugün" kelimesi KULLANILMAZ; etiket o günün tarihine
   *  döner. Canlı günde eski davranış aynen sürer. */
  const gunEtiketi = (tip) => {
    const canli = !secilenGun && veri.odakBugunMu;
    if (tip === 'ciro') return canli ? 'Bugünkü ciro' : `${kisaGun(veri.odakGun)} cirosu`;
    return canli ? 'Bugün' : kisaGun(veri.odakGun);
  };

  // ── TARİH GEZGİNİ türetimleri ──────────────────────────────────────────────
  const gezginVar = TARIH_GEZGINI_EKRANLARI.includes(`${mod}.${gorunum}`);
  const odakGunSimdi = secilenGun || veri.odakGun || bugunISO();
  const gecmisGunMu = !!secilenGun && secilenGun < bugunISO();
  const okStil = {
    width: 26, height: 26, borderRadius: 7, cursor: 'pointer',
    border: `1px solid ${R.cizgi3}`, background: 'transparent', color: R.metin2,
    fontSize: 14, fontFamily: 'inherit', lineHeight: 1, padding: 0,
  };
  // Gezgin kapsam dışı bir ekrana geçilirse seçim DÜŞER — aksi hâlde geri
  // dönüldüğünde eski gün sessizce yürürlükte kalır (tarih yalanı riski).
  useEffect(() => { if (!gezginVar && secilenGun) setSecilenGun(null); }, [gezginVar]);   // eslint-disable-line react-hooks/exhaustive-deps

  const modSec = (id) => {
    const m = MODULLER.find(x => x.id === id);
    if (!m) return;
    setMod(id);
    setGorunum(m.gorunumler[0].id);
    setCekmece(null);
  };

  const koprule = (hedef) => {
    if (!hedef) return;
    // Görünüm-içi hedef: '__gorunum:sevkiyat' → eski sayfaya değil, v2'nin kendi
    // görünümüne geçer (çekmece aksiyonları da modül içinde kalabilsin diye).
    if (hedef.startsWith('__gorunum:')) {
      setGorunum(hedef.slice('__gorunum:'.length));
      setCekmece(null);
      return;
    }
    // Modül-arası hedef: '__modul:para:girisi' → klasik sayfaya değil, v2'nin
    // kendi modül+görünümüne geçer (köprüleri v2-yerlisine çevirme turu).
    if (hedef.startsWith('__modul:')) {
      // 4. parça = PARAMETRE ('__modul:belge:cari:<encodeURIComponent(ad)>').
      // Tedarikçi adı boşluk/nokta/& içerebilir → split(':') ile 4 parçaya
      // ayırıp geri kalanı BİRLEŞTİRİYORUZ (ad içinde ':' olsa bile kaybolmasın),
      // sonra decode. Parametre yoksa davranış eskisiyle birebir aynı.
      const _p = hedef.split(':');
      const mid = _p[1];
      const gid = _p[2];
      if (_p.length > 3) {
        const _ham = _p.slice(3).join(':');
        let _param = _ham;
        try { _param = decodeURIComponent(_ham); } catch { _param = _ham; }
        setKopruParam({ modul: mid, gorunum: gid, deger: _param });
      } else {
        setKopruParam(null);
      }
      const m = MODULLER.find((x) => x.id === mid);
      if (m) {
        setMod(mid);
        setGorunum(gid && m.gorunumler.some((g) => g.id === gid) ? gid : m.gorunumler[0].id);
        setCekmece(null);
      }
      return;
    }
    if (onGit) onGit(hedef);
    else window.location.hash = hedef;
  };

  // ── KOMUT PALETİ (yeni handoff) ────────────────────────────────────────────
  // ⌘K / Ctrl+K / '/' ile açılır. Arama TÜRKÇE KARAKTER DUYARSIZ: 'maas' yazınca
  // "Maaş & Avans" bulunur. Rozet sayıları canlıdan gelir (sahte sayı yok kuralı).
  const paletAc = () => { setPalet(true); setPaletQ(''); setPaletI(0); };
  const paletKapat = () => setPalet(false);

  const paletListe = () => {
    const q = sadeles(paletQ);
    const o = [];
    MODULLER.forEach((m) => m.gorunumler.forEach((g) => {
      const metin = sadeles(`${m.ad} ${m.kisa} ${g.ad} ${m.blok}`);
      if (!q || metin.includes(q)) {
        o.push({ mod: m.id, view: g.id, ad: g.ad, modAd: m.ad, blok: m.blok, rozet: rozetler[g.rozet], renk: g.renk });
      }
    }));
    return o.slice(0, 40);
  };

  const paletGit = (s) => {
    if (!s) return;
    setMod(s.mod);
    setGorunum(s.view);
    setPalet(false);
    setCekmece(null);
  };

  const paletTus = (e) => {
    const l = paletListe();
    if (e.key === 'ArrowDown') { e.preventDefault(); setPaletI((i) => Math.min(l.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletI((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); paletGit(l[paletI]); }
    else if (e.key === 'Escape') { e.preventDefault(); setPalet(false); }
  };

  // Şube Karnesi'nin OPERASYONEL kolonları (Kontrol Kulesi birleşti, 2026-07-30):
  // şubenin DEPO rolündeki sevkiyat trafiği. Karne görünümüne girilince yüklenir,
  // ana yüke binmez. Veri gelmezse kolonlar '—' gösterir (uydurma sayı yok).
  useEffect(() => {
    if (gorunum !== 'subeler' || subeOps !== null) return;
    api('/ops/siparis/sevkiyat-subeler-ozet')
      .then((d) => setSubeOps(Array.isArray(d?.satirlar) ? d.satirlar : (Array.isArray(d) ? d : [])))
      .catch(() => setSubeOps([]));
    // ⚠️ `/v2/` ÖNEKLİ, yani v2 İÇİN YAZILMIŞ iki motor — ama hiç çağrılmıyordu.
    // Karne yalnız CİRO sıralaması gösteriyordu: "hangi şube çok satıyor".
    // Bu ikisi "hangi şube DÜZGÜN çalışıyor" sorusunu cevaplıyor:
    //   sube-davranis → son 30 günün kural ihlalleri (kural kural, puanıyla)
    //   sube-skor     → ayın toplam puanı + durum etiketi
    // Çok satan şube kural ihlalinde birinci olabilir; ikisi ayrı eksen.
    api('/ops/v2/sube-davranis?gun=30')
      .then((d) => setSubeDavranis(Array.isArray(d?.subeler) ? d.subeler : []))
      .catch(() => setSubeDavranis([]));
    api('/ops/v2/sube-skor')
      .then((d) => setSubeSkor(Array.isArray(d?.skorlar) ? d.skorlar : []))
      .catch(() => setSubeSkor([]));
    // Sahip kararı (soru 4/9): HAFTALIK kıyas şeridi. Günlük ekran tek günü,
    // aylık karne bütün ayı gösterir — "hangi şube BU HAFTA düşüşte" sorusu
    // ikisinin arasında cevapsızdı.
    api('/ops/haftalik-karsilastirma')
      .then((d) => setSubeHafta(d || null))
      .catch(() => setSubeHafta(null));
    // Sahip kararı (soru 5/9): şube başına GİDER + ciro/gider oranı.
    // Ciro bir ekranda, anlık gider başka ekrandaydı; "hangi şube pahalı
    // çalışıyor" sorusu hiçbir yerde cevaplanmıyordu.
    api('/ops/metrics/finans-ozet?gun=30')
      .then((d) => setSubeFinans(d || null))
      .catch(() => setSubeFinans(null));
  }, [gorunum, subeOps]);

  // ── İSTEK HATASI BANDI (yeni handoff: "veri yok" ≠ "sistem bozuk") ────────
  // api() düşen GET'leri deftere yazar; kabuk burada okuyup KANONİK hata bandını
  // içeriğin EN ÜSTÜNDE gösterir. Böylece 100+ sessiz catch'i tek tek yamamadan
  // "sessiz .catch yasak" kuralı sağlanır: akış yaşar ama iz görünür.
  const [hataDefteri, setHataDefteri] = useState([]);
  useEffect(() => istekHatasiDinle(() => setHataDefteri(istekHatalari())), []);
  // Görünüm değişince defter sıfırlanır — önceki ekranın hatası burada asılı kalmaz
  useEffect(() => { istekHatalariniTemizle(); setHataDefteri([]); }, [mod, gorunum]);

  // Palet açılınca odak girdiye düşer
  useEffect(() => {
    if (palet) { const t = setTimeout(() => paletRef.current?.focus(), 30); return () => clearTimeout(t); }
  }, [palet]);

  // ── GLOBAL KLAVYE (yeni handoff) ───────────────────────────────────────────
  // ⌘K/Ctrl+K/'/' palet · Esc katmanları SIRAYLA kapatır (palet → çekmece) ·
  // j/k modül içinde sonraki/önceki görünüm. Bir girdiye yazarken kısayol yok.
  useEffect(() => {
    const isle = (e) => {
      const hedef = e.target;
      const yaziyor = hedef && (
        hedef.tagName === 'INPUT' || hedef.tagName === 'TEXTAREA' ||
        hedef.tagName === 'SELECT' || hedef.isContentEditable
      );
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); paletAc(); return;
      }
      if (e.key === 'Escape') {
        if (palet) { setPalet(false); return; }
        if (yaziyor) { hedef.blur(); return; }
        if (cekmece) { setCekmece(null); return; }
        return;
      }
      if (yaziyor || palet) return;
      if (e.key === '/') { e.preventDefault(); paletAc(); return; }
      if (e.key === 'j' || e.key === 'k') {
        const m = MODULLER.find((x) => x.id === mod);
        if (!m) return;
        const i = m.gorunumler.findIndex((g) => g.id === gorunum);
        const y = e.key === 'j' ? Math.min(m.gorunumler.length - 1, i + 1) : Math.max(0, i - 1);
        if (y !== i) { setGorunum(m.gorunumler[y].id); setCekmece(null); }
      }
    };
    window.addEventListener('keydown', isle);
    return () => window.removeEventListener('keydown', isle);
  }, [palet, cekmece, mod, gorunum]);

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
            background: `linear-gradient(150deg, #E0A559, #AF6C29)`, color: '#1C1309',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
          }}>
            Tekrar dene
          </button>
        </div>
      );
    }

    // ── IA REVİZYONU (yeni handoff): TAŞINAN GÖRÜNÜMLER ─────────────────────
    // Görünümler modüller arasında yer değiştirdi ama KODLARI taşınmadı —
    // sadece hangi modülün altında göründükleri değişti. Bu eşleme, ekranın
    // yeni evi ile onu üreten bileşeni birbirine bağlar.
    //   Banka Kredileri : Yükümlülükler → Borç & Kredi   (kredi de borçtur)
    //   Sabit Giderler  : Yükümlülükler → Ödeme Merkezi  (tekrarlayan ödeme)
    //   Anlık Gider     : Gelir & Kasa  → Ödeme Merkezi  (IA kuralı: gelir≠gider)
    //   Teslimat Zinciri: Tanımlar      → Operasyon      (master data değil, akış)
    //   Strateji        : Denetim       → Yönetim & Karar (karar ekranı)
    // 'yuk' modülü boşaldığı için ray'dan kalktı; bileşeni (YukModulu) yaşıyor.
    if (mod === 'kart' && gorunum === 'krediler') {
      return <YukModulu gorunum="krediler" onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'odeme' && gorunum === 'sabit') {
      return <YukModulu gorunum="sabit" onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'odeme' && gorunum === 'gider') {
      return <ParaModulu gorunum="gider" onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'ops' && gorunum === 'zincir') {
      return <TanimModulu gorunum="zincir" onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'panel' && gorunum === 'strateji') {
      return <DenetimModulu gorunum="strateji" onCekmece={setCekmece} onKopru={koprule} onToast={setToast} onGorunum={setGorunum} />;
    }

    // v2'ye yazılmış modüller
    if (mod === 'genel') {
      // onToast (2026-08-16): 'zam' görünümü "gördüm" işaretlemesi yapıyor —
      // yazma sonucunun geri bildirimi kabuğun toast'ından geçer.
      return <GenelModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'kart') {
      return <KartModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    // 🔗 Kart izi eşleştirme + karar defteri (2026-08-08) — ayrı modül dosyası
    if (mod === 'odeme' && (gorunum === 'eslesme' || gorunum === 'eslesmedefter')) {
      return <EslesmeModulu gorunum={gorunum === 'eslesmedefter' ? 'defter' : 'eslesme'}
                            onCekmece={setCekmece} onToast={setToast} />;
    }
    if (mod === 'belge' && gorunum === 'vergi') {
      return <VergiModulu onCekmece={setCekmece} />;
    }
    if (mod === 'denetim' && gorunum === 'parazinciri') {
      return <TeshisModulu onCekmece={setCekmece} />;
    }
    if (mod === 'odeme') {
      // hedefOdeme: '__modul:odeme:bekleyen:<planId>' köprüsünün parametresi —
      // belge:cari deseniyle AYNI (kopruParam genel çözümleyicisi zaten 4. parçayı
      // ayrıştırıyor). Modül bunu TEK SEFER tüketip ilgili kalemin modalını açar.
      return <OdemeModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast}
        hedefOdeme={kopruParam?.modul === 'odeme' && kopruParam?.gorunum === 'bekleyen' ? kopruParam.deger : null} />;
    }
    if (mod === 'ops') {
      return (
        <OpsModulu
          gorunum={gorunum}
          onCekmece={setCekmece}
          onKopru={koprule}
          onToast={setToast}
          onGorunum={setGorunum}
        />
      );
    }
    if (mod === 'ekip') {
      return <EkipModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'borc') {
      return <BorcModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} />;
    }
    if (mod === 'para') {
      return <ParaModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'denetim') {
      return <DenetimModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} onGorunum={setGorunum} />;
    }
    if (mod === 'belge') {
      return <BelgeModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast}
        cariHedef={kopruParam?.modul === 'belge' && kopruParam?.gorunum === 'cari' ? kopruParam.deger : null} />;
    }
    // Küçük modüller (KucukModuller.jsx) — yeni blok gerektirmeyenler
    if (mod === 'onaylar') {
      return <OnayModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    // 'yuk' modülü IA revizyonunda kalktı — görünümleri Borç & Kredi ile Ödeme
    // Merkezi'ne dağıldı (yukarıdaki eşleme). Eski #yuk adresi gelirse iş
    // durmasın diye bileşen hâlâ cevap verir.
    if (mod === 'yuk') {
      return <YukModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'rapor') {
      return <RaporModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'sistem') {
      return <SistemModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'tanim') {
      return <TanimModulu gorunum={gorunum} onCekmece={setCekmece} onKopru={koprule} onToast={setToast} />;
    }
    if (mod === 'maliyet') {
      return (
        <MaliyetModulu
          gorunum={gorunum}
          onCekmece={setCekmece}
          onKopru={koprule}
          onToast={setToast}
        />
      );
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
      // Sparkline: GERÇEK son 14 gün serisi (uydurma seed yok)
      // ETİKET TÜRETME (handoff zorunlu kuralı): geçmiş günde "Bugün" geçen her
      // etiket O GÜNÜN tarihine çevrilir — yoksa arayüz yalan söyler.
      { etiket: gunEtiketi('ciro'), deger: fmt(d.gunToplam), alt: `${d.subeGunListe.length} şube · ${kisaGun(d.odakGun)}`, seri: d.seri },
      { etiket: 'Nakit', deger: fmt(d.gunNakit), alt: `payı %${yuzde(d.gunNakit, d.gunToplam).toFixed(0)}`, renk: R.krem },
      { etiket: 'Kart + online', deger: fmt(d.gunKart), alt: `payı %${yuzde(d.gunKart, d.gunToplam).toFixed(0)}`, renk: R.krem },
      // Etiket artık YALAN SÖYLEMİYOR: gecikmiş ile bugün ayrı. Canlıda
      // "Bugün ödenecek 946.018 ₺" deniyordu ama bugüne ait hiç kalem yoktu.
      gecikmisToplam > 0
        ? {
          etiket: 'Gecikmiş ödeme',
          deger: fmt(gecikmisToplam),
          alt: `${gecikmisOdemeler.length} kalem · en eskisi ${enEskiGecikme || '?'} gün`,
          renk: R.kirmizi,
        }
        : {
          etiket: 'Bugün ödenecek',
          deger: fmt(gercekBugunToplam),
          alt: `${gercekBugunOdemeler.length} kalem · vadesi bugün`,
          renk: gercekBugunToplam > 0 ? R.amber : R.yesil,
        },
    ];
    // CFO HIZLI BAKIŞ (sahip 2026-07-29): klasik CFO panelin "tek bakışta" özeti —
    // kasa/serbest nakit/dayanma/yük/ay cirosu — v2 Bugün'e taşındı. Kaynak
    // alanlar birebir /api/panel (kasa = kanonik).
    const gunDayanir = sayi(panel?.kac_gun_dayanir);
    const cfoKpiler = panel ? [
      { etiket: 'Kasa', deger: fmt(sayi(panel.kasa)), alt: 'kanonik · kasa izi', renk: R.yesil },
      { etiket: 'Serbest nakit', deger: fmt(sayi(panel.serbest_nakit)), alt: 'zorunlu yük sonrası', renk: sayi(panel.serbest_nakit) >= 0 ? R.krem : R.kirmizi },
      // 🟡 (2026-08-12): gerçek "0 gün" (nakit bitti — en kritik alarm) truthy
      // kontrolde '—' oluyordu. null/undefined = ölçülemedi, 0 = gerçek alarm.
      { etiket: 'Kaç gün dayanır', deger: panel?.kac_gun_dayanir != null ? `${trSayi(gunDayanir, 0)} gün` : '—', alt: 'ciro dursa bile', renk: gunDayanir >= 30 ? R.yesil : gunDayanir >= 10 ? R.amber : R.kirmizi },
      // Gecikmiş ayrı KPI olduğunda bugünkü de görünsün — ikisi farklı iş:
      // gecikmiş "neden ödenmedi", bugünkü "bugün öde".
      ...(gecikmisToplam > 0 ? [{
        etiket: 'Bugün vadesi gelen',
        deger: fmt(gercekBugunToplam),
        alt: gercekBugunOdemeler.length
          ? `${gercekBugunOdemeler.length} kalem`
          : 'bugüne ait kalem yok',
        renk: gercekBugunToplam > 0 ? R.amber : R.yesil,
      }] : []),
      { etiket: '7 gün yükü', deger: fmt(sayi(panel.yuk_7)), alt: 'vadesi gelen ödemeler' },
      { etiket: '30 gün yükü', deger: fmt(sayi(panel.yuk_30)), alt: 'aylık zorunlu çıkış' },
      // 🔵 (2026-08-14) 'Bu ay ciro' kartı KALDIRILDI: Bugün görünümü zaten 2 KPI
      // şeridi + Hero taşıyor, en yoğun ekran burası. Aylık ciro Ay Özeti'nde
      // dağılım grafiği ve günlük ortalamayla birlikte daha zengin duruyor —
      // aynı sayıyı iki yerde göstermek yoğunluğu boşuna artırıyordu.
    ] : [];

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

    // K5 tutarlılık: aynı sebepten doğan "NAKİT YETERSİZ" önerileri tek satırda.
    const { grupSatiri, kalan } = kritikNakitAyir(panel?.oneriler || []);
    const tumOneriler = [
      ...(grupSatiri ? [grupSatiri] : []),
      ...kalan.map((o, i) => ({
        id: `oneri-${i}`,
        baslik: o.baslik,
        alt: o.aciklama,
        tutar: sayi(o.tavsiye_tutar) > 0 ? fmt(o.tavsiye_tutar) : '',
        tier: o.renk === 'KIRMIZI' ? 'kritik' : o.renk === 'TURUNCU' ? 'uyari' : 'bilgi',
        // Ödeme kuyruğuna bağlı öneride butonu göster; bağlı değilse yönlendirme yapma.
        aksiyon: o.odeme_id ? 'Ödemeye git' : '',
        // 🔵 (2026-08-14) Düğme KLASİĞE kaçıyordu ('odeme-merkezi') — sahip v2'den
        // çıkıp eski sayfaya düşüyordu. v2'nin kendi Ödeme Merkezi'ne köprülenir.
        _hedef: o.odeme_id ? '__modul:odeme:bekleyen' : '',
      })),
    ];
    const oneriListe = tumOneriler.slice(0, 6);

    return (
      <>
        {/* ── 📅 EKSİK CİRO ŞERİDİ — para rakamlarından ÖNCE ──────────────
            Sahip 2026-08-09: "panel bir şubenin cirosunu 8 Ağustos için
            gösteriyor, neden?" Panel doğruydu; TEMA o gün ciro girmemişti.
            Sistemde var olanı denetleyen çok şey vardı ama OLMAYANI arayan
            yoktu. Eksik ciro tüm kâr/ciro rakamlarını sessizce bozar — bu
            yüzden şerit en üstte: altındaki sayılara güvenmeden önce görülsün. */}
        {eksikCiro && sayi(eksikCiro.eksik_adet) > 0 && (() => {
          const ek = eksikCiro.eksikler || [];
          const enEski = ek.length ? Math.max(...ek.map((e) => sayi(e.gun_once))) : 0;
          const renk = enEski >= 3 ? R.kirmizi : R.amber;
          return (
            <div style={{
              ...kartYuzey, padding: '12px 16px', marginBottom: 12,
              borderLeft: `3px solid ${renk}`,
            }}>
              <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: renk }}>
                  📅 Girilmemiş ciro — {sayi(eksikCiro.eksik_adet)} gün
                </span>
                <span style={{ fontSize: 12, color: R.metin2 }}>
                  {Object.entries(eksikCiro.eksik_sube_ozet || {})
                    .map(([ad, n]) => `${ad}: ${n} gün`).join(' · ')}
                </span>
                <span style={{ fontSize: 11, color: R.not, marginLeft: 'auto' }}>
                  son 14 gün
                </span>
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 9 }}>
                {ek.slice(0, 8).map((e) => (
                  <span key={`${e.sube_id}${e.tarih}`} style={{
                    padding: '4px 10px', borderRadius: 99, fontSize: 11.5,
                    background: R.girinti, border: `1px solid ${R.cizgi3}`, color: R.metin2,
                  }}>
                    <b style={{ color: R.krem }}>{e.sube_adi}</b> · {kisaGun(e.tarih)}
                    <span style={{ color: R.not2 }}> ({e.gun_once} gün önce)</span>
                  </span>
                ))}
                {ek.length > 8 && (
                  <span style={{ fontSize: 11, color: R.not2, alignSelf: 'center' }}>
                    +{ek.length - 8} gün daha
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 9, lineHeight: 1.6 }}>
                Ciro girilmeyen gün <b>sıfır sayılır</b>: aşağıdaki kâr, ciro ve
                şube karşılaştırmaları o kadar eksik çıkar. Şube panelinden
                girilince kendiliğinden düzelir.
                {(eksikCiro.bugun_bekleyen || []).length > 0 && (
                  <> Bugün için {(eksikCiro.bugun_bekleyen || []).map((b) => b.sube_adi).join(', ')}
                    {' '}henüz girmedi — gün kapanmadığı için eksik sayılmadı.</>
                )}
              </div>
            </div>
          );
        })()}

        <KpiSeridi kpiler={kpiler} />
        {cfoKpiler.length > 0 && <KpiSeridi kpiler={cfoKpiler} />}
        <Hero
          etiket={`${gunEtiketi('baslik')} · son 14 gün ritmi`}
          deger={fmt(d.gunToplam)}
          delta={d.delta == null ? '' : `%${trSayi(Math.abs(d.delta))} ${d.delta >= 0 ? '↑' : '↓'}`}
          deltaTip={d.delta == null ? 'notr' : d.delta >= 0 ? 'iyi' : 'kotu'}
          not={
            d.delta == null
              ? 'Geçen haftanın aynı günü için karşılaştırma verisi yok.'
              // 🔴 EVV-PANEL-N2 (2026-08-13): KPI'lar gecikmiş/bugün'ü AYIRIYOR ama Hero
              // notu hâlâ ham `bugunOdemeToplam` (gecikmiş DAHİL, şişik) basıyordu. Bugün
              // vadesi olanı (gercekBugunToplam) göster + gecikmişi ayrı belirt.
              : `Geçen haftanın aynı günü ${fmt(veri.seri[6] || 0)}. Kasa + banka toplamı ${fmt(kasaBanka)}; bugün vadesi gelen ${fmt(gercekBugunToplam)}${gecikmisToplam > 0 ? ` (ayrıca ${fmt(gecikmisToplam)} gecikmiş)` : ''}.`
          }
          seri={d.seri}
          seriEtiket={d.seriEtiket}
          seriAd="günlük ciro"
          seriBicim={fmt}
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
            _hedef: '__modul:para:girisi',
          })}
        />
        {oneriListe.length > 0 ? (
          <>
            <Liste satirlar={oneriListe} onAc={(l) => koprule(l._hedef)} />
            {/* Kesme notu: liste sessizce kırpılmasın — kalanın nerede olduğu yazılır. */}
            {tumOneriler.length > 6 && (
              <div style={{ fontSize: 11, color: R.not2, padding: '8px 4px 0' }}>
                ilk 6 / {tumOneriler.length} öneri · tamamı Riskler görünümünde
              </div>
            )}
          </>
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
    // PROD-V2-CIRO-001 FIX: ayCiro BRÜT bu_ay_ciro (ciro tablosu) — aşağıdaki dağılım nakit/pos/online
    // BRÜT olduğundan toplam=parça olsun (önce NET bu_ay_sadece_ciro → toplam≠parça). d.ayToplam
    // fallback zaten BRÜT (nakit+pos+online). Ortalama da aynı brüt kaynaktan → K7 tek-kaynak korunur.
    const ayCiro = sayi(panel?.bu_ay_ciro) || d.ayToplam;
    const ayNakit = sayi(panel?.bu_ay_nakit);
    const ayPos = sayi(panel?.bu_ay_pos);
    const ayOnline = sayi(panel?.bu_ay_online);
    // 🐞 K7 (canlı denetim): ortalama + "Ay cirosu" TEK KAYNAK (artık brüt bu_ay_ciro || d.ayToplam,
    // ikisi de brüt). Eskiden ortalama istemci d.ayToplam, ciro sunucu bu_ay_sadece_ciro'ydu → 694₺ drift.
    const gunOrt = d.gunSayisi ? ayCiro / d.gunSayisi : 0;
    // Onay sayacı: Riskler'deki KASA ayrımının aynısı (124 kasa hatası
    // burada da "onay bekleyen" diye görünüyordu).
    const kasaHatasiAdet = onaylar.filter((o) => String(o.islem_turu || '').toUpperCase().includes('KASA')).length;
    const gercekOnay = onaylar.length - kasaHatasiAdet;

    const kpiler = [
      { etiket: 'Ay cirosu', deger: fmt(ayCiro), alt: `${d.gunSayisi} gün kayıt · ${d.ayOnEk}` },
      { etiket: 'Günlük ortalama', deger: fmt(gunOrt), alt: 'kayıtlı günler üzerinden', renk: R.krem },
      { etiket: 'Kasa + banka', deger: fmt(kasaBanka), alt: 'anlık toplam', renk: kasaBanka > 0 ? R.yesil : R.kirmizi },
      {
        etiket: 'Onay bekleyen',
        deger: String(gercekOnay),
        alt: kasaHatasiAdet ? `kuyrukta · kasa hatası ${kasaHatasiAdet} ayrı` : 'kuyrukta',
        renk: gercekOnay ? R.amber : R.yesil,
      },
      // 🔵 (2026-08-14) HAFTALIK TEMPO: ay toplamı ayın sonunda anlaşılır, gün
      // gürültülüdür — "gidişat iyi mi?" sorusunun ritmi haftadır. Sunucu bu
      // kıyası zaten hesaplıyordu, Ay görünümü okumuyordu.
      ...(subeHafta?.genel_degisim_pct != null ? [(() => {
        const p = sayi(subeHafta.genel_degisim_pct);
        return {
          etiket: 'Haftalık tempo',
          deger: `${p > 0 ? '+' : ''}${subeHafta.genel_degisim_pct}%`,
          alt: `bu hafta ${fmt(sayi(subeHafta.toplam_bu_hafta))} ↔ ${fmt(sayi(subeHafta.toplam_gecen_hafta))}`,
          renk: p >= 0 ? R.yesil : R.kirmizi,
        };
      })()] : []),
    ];

    // PROD-V2-CIRO-001 FIX: dağılım GROSS-ONLY (Nakit/POS/Online) → toplam (brüt bu_ay_ciro) = parça.
    // Önceki "Online kesinti" satırı YALNIZ online komisyonu düşüyordu (POS kesinti eksikti) → yarım
    // waterfall, toplamla tutmuyordu. Komisyonlar finansman-maliyeti kartında ayrıca gösterilir.
    const dagilim = [
      { ad: 'Nakit', tutar: ayNakit || d.aySatir.reduce((s, r) => s + r.nakit, 0), renk: R.yesil },
      { ad: 'POS', tutar: ayPos, renk: R.bakir },
      { ad: 'Online', tutar: ayOnline, renk: R.mavi },
    ].filter(x => x.tutar !== 0);
    const enBuyuk = Math.max(...dagilim.map(x => Math.abs(x.tutar)), 1);

    return (
      <>
        {/* 🔴 EVV-PANEL-N4: /ciro 600 satır tavanına ulaştıysa ay toplamı/şube kırılımı
            eksik sayabilir — sessiz undercount yerine açık uyarı. */}
        {d.ciroKirpildi && (
          <div style={{ ...kartYuzey, padding: '10px 16px', marginBottom: 12, borderLeft: `3px solid ${R.amber}`, fontSize: 12, color: R.metin2 }}>
            ⚠ Ciro kaydı 600 satır tavanına ulaştı — bu aydaki bazı günler toplama girmemiş olabilir. Aylık rakam kanonik değil, kırılım eksik olabilir.
          </div>
        )}
        {/* 🔵 (2026-08-14) Ay toplamının en büyük sessiz yanılgısı: girilmemiş gün
            SIFIR sayılır → ay toplamı o kadar eksik çıkar. Bugün görünümünde şerit
            vardı, Ay'da yoktu — oysa yanılgının vurduğu rakam tam burada. */}
        {eksikCiro && sayi(eksikCiro.eksik_adet) > 0 && (
          <div style={{ ...kartYuzey, padding: '10px 16px', marginBottom: 12, borderLeft: `3px solid ${R.amber}`, fontSize: 12, color: R.metin2 }}>
            📅 Bu ay <b style={{ color: R.krem }}>{sayi(eksikCiro.eksik_adet)} gün</b> ciro girilmemiş — ay toplamı o kadar eksik.
          </div>
        )}
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
          {/* Grafik payları gösteriyor ama okumayı sahibe bırakıyordu — tek cümlelik
              yargı satırı ekli (ayCiro 0 ise bölme yapılmaz, satır çizilmez). */}
          {ayCiro > 0 && (
            <div style={{ fontSize: 11.5, color: R.not2, marginTop: 13, paddingTop: 11, borderTop: `1px solid ${R.cizgi2}` }}>
              Nakit payı <b style={{ fontFamily: F.mono, color: R.krem }}>%{yuzde(ayNakit, ayCiro).toFixed(0)}</b>
              {' · '}kart + online <b style={{ fontFamily: F.mono, color: R.krem }}>%{yuzde(ayPos + ayOnline, ayCiro).toFixed(0)}</b>
            </div>
          )}
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
    /** Şube adına göre sevkiyat trafiği satırı (Kontrol Kulesi'nden gelen kolonlar). */
    // 🔵 EVV-PANEL-N3 (2026-08-13): opsOf `toLocaleLowerCase('tr')` kullanıyordu ama
    // diğer feed'ler (finans/davranış) `sadeles()` (Türkçe-İ + aksan normalizasyonu) →
    // aksanlı şubede (KÖYCEĞİZ) eşleşme kaçıp depo yükü/yolda "—" görünüyordu. Hizalandı.
    const opsOf = (ad) => (subeOps || []).find(
      (o) => sadeles(o.depo_sube_adi || o.sube_adi || '') === sadeles(ad || ''),
    );
    // Şube adı eşleşmesi — dosyanın kendi `sadeles` yardımcısı (Türkçe-I tuzağı
    // + aksan normalizasyonu birlikte; ör. "KÖYCEĞİZ" ↔ "Köyceğiz")
    const adEs = (a, b) => sadeles(a) === sadeles(b);
    const davranisOf = (ad) => (subeDavranis || []).find((x) => adEs(x.sube_adi, ad));
    const skorOf = (ad) => (subeSkor || []).find((x) => adEs(x.sube_adi, ad));
    const haftaOf = (ad) => (subeHafta?.subeler || []).find((x) => adEs(x.sube_adi, ad));
    // finans-ozet satırlarında sube_adi YOK — id üzerinden şube adına eşlenir.
    const finansMap = (() => {
      const idToAd = {};
      (subeler || []).forEach((s) => { idToAd[String(s.id)] = s.ad; });
      const agg = {};
      (subeFinans?.ciro_gider_orani || []).forEach((r) => {
        const ad = idToAd[String(r.sube_id)] || String(r.sube_id);
        const k = sadeles(ad);
        if (!agg[k]) agg[k] = { ad, ciro: 0, gider: 0 };
        agg[k].ciro += sayi(r.ciro);
        agg[k].gider += sayi(r.gider);
      });
      return agg;
    })();
    const finansOf = (ad) => finansMap[sadeles(ad)] || null;

    // 🔴 P1 (2026-08-12): Şube Karnesi tablosu YALNIZ ciro feed'inden (subeAyListe)
    // kuruluyordu → 0 ciro ama gideri süren KAPALI şube (canlıda Alsancak/Köyceğiz)
    // hiç satır almıyor, 30g gideri görünmez kalıyordu. subeAyListe'yi MUTASYONA
    // UĞRATMADAN (onu 'Aktif şube' + 'En düşük ciro' KPI'ları paylaşıyor) tablo için
    // AYRI liste: finans kovasında olup ciroda olmayan giderli şubeleri 0-ciro satır
    // olarak ekle — en altta kalır (toplam 0).
    const subeKarne = (() => {
      const eldeki = new Set(d.subeAyListe.map((s) => sadeles(s.ad)));
      const eksik = Object.values(finansMap)
        .filter((f) => !eldeki.has(sadeles(f.ad)) && sayi(f.gider) > 0)
        .map((f) => ({ ad: f.ad, toplam: 0, nakit: 0, kart: 0, gunSayisi: 0, pay: 0, _ciroYok: true }));
      return [...d.subeAyListe, ...eksik];
    })();

    const kpiler = [
      { etiket: 'En yüksek ciro', deger: enIyi.ad, alt: fmt(enIyi.toplam), renk: R.yesil },
      { etiket: 'En düşük ciro', deger: enZayif.ad, alt: fmt(enZayif.toplam), renk: R.kirmizi },
      { etiket: 'Aktif şube', deger: String(d.subeAyListe.length), alt: `${subeler.length} tanımlı şube`, renk: R.krem },
      { etiket: 'Ay toplamı', deger: fmt(d.ayToplam), alt: `${d.gunSayisi} gün`, renk: R.krem },
    ];

    // Şube dosyası çekmecesi — tablo satırı ve dikkat-şeridi AYNI kapıdan açsın
    // (eskiden yalnız tablonun onSatir gövdesindeydi; iki yerde iki kopya olmasın).
    const subeDosyasiAc = (s) => {
      if (!s) return;
      const dv = davranisOf(s.ad);
      const sk = skorOf(s.ad);
      const ihlaller = Array.isArray(dv?.ihlaller) ? dv.ihlaller : [];
      const cezaPuan = sayi(dv?.toplam_puan ?? sk?.toplam_puan);
      setCekmece({
        tip: 'ŞUBE DOSYASI', baslik: s.ad, alt: `${d.ayOnEk} · ${s.gunSayisi} gün kayıt`,
        kpi: [
          { etiket: 'Ay cirosu', deger: fmt(s.toplam) },
          { etiket: 'Zincir payı', deger: `%${trSayi(s.pay)}` },
          { etiket: 'Günlük ort.', deger: fmt(s.toplam / (s.gunSayisi || 1)) },
          // Ciro ekseninin yanına DAVRANIŞ ekseni: çok satan şube kural
          // ihlalinde de birinci olabilir — ikisi ayrı soru.
          (dv || sk)
            ? {
              etiket: 'Davranış',
              deger: sk?.durum || (cezaPuan > 0 ? `${cezaPuan} ceza` : 'temiz'),
              renk: cezaPuan >= 20 ? R.kirmizi : cezaPuan > 0 ? R.amber : R.yesil,
            }
            : { etiket: 'Nakit payı', deger: `%${yuzde(s.nakit, s.toplam).toFixed(0)}` },
        ],
        listeBaslik: ihlaller.length ? 'Ödeme tipi + kural ihlalleri (30 gün)' : 'Ödeme tipine göre',
        satirlar: [
          { ad: 'Nakit', detay: `%${yuzde(s.nakit, s.toplam).toFixed(0)}`, tutar: fmt(s.nakit) },
          { ad: 'Kart + online', detay: `%${yuzde(s.kart, s.toplam).toFixed(0)}`, tutar: fmt(s.kart) },
          // Kural kural ihlal dökümü — hangi kural kaç kez, kaç puan
          ...ihlaller.slice(0, 10).map((i) => ({
            ad: `⚠ ${i.kural || 'kural'}`,
            detay: `${sayi(i.ihlal_sayisi)} kez · son 30 gün`,
            tutar: `${sayi(i.puan)} puan`,
          })),
          // Anlık gider kategori trendi (soru 5/9) — uç sube filtresiz
          // çağrıldığı için ZİNCİR GENELİ; etiketle dürüstçe söylenir.
          ...(() => {
            const kt = subeFinans?.anlik_gider_kategori_trend || [];
            if (!kt.length) return [];
            const sonHafta = kt.reduce((m, r) => (String(r.hafta) > m ? String(r.hafta) : m), '');
            return kt
              .filter((r) => String(r.hafta) === sonHafta)
              .slice(0, 4)
              .map((r) => ({
                ad: `💸 ${r.kategori || 'kategori'} · zincir geneli`,
                detay: `bu hafta ${sayi(r.kayit_adet)} kayıt`,
                tutar: fmt(sayi(r.toplam_tutar)),
              }));
          })(),
        ],
        not: [
          s.gunSayisi < d.gunSayisi
            ? `Bu şubede ${d.gunSayisi - s.gunSayisi} gün ciro kaydı eksik — karşılaştırma bu yüzden düşük çıkabilir.`
            : 'Ay boyunca eksik gün yok, karne tam.',
          ihlaller.length
            ? 'Davranış puanı CEZA puanıdır — yüksek olması kötüdür. Gözlem toplar, hüküm vermez.'
            : (dv || sk) ? 'Bu ay kural ihlali kaydedilmemiş.' : '',
        ].filter(Boolean).join(' '),
        aksiyonAd: 'Ciro defterini aç',
        _hedef: '__modul:para:girisi',
      });
    };

    // ── ⚠ DİKKAT İSTEYEN ŞUBELER ────────────────────────────────────────────
    // Karne tablosu 11 kolon × N şube — doğru ama "hangisine bakayım?" sorusunu
    // sahibin gözüne bırakıyordu. Şerit dört sinyali tarar, en ağırını yazar.
    // Sinyal yoksa kart HİÇ çizilmez (boş "sorun yok" kutusu gürültüdür).
    const dikkatListesi = (() => {
      const ONEM = { kirmizi: 0, amber: 1 };
      // Sinyal grupları arası öncelik (ciro yok > hafta düşüşü > ceza > verim).
      const GRUP = { ciroYok: 0, hafta: 1, ceza: 2, verim: 3 };
      // 🔴 (2026-08-14) 3-TAVAN YANLIŞ ADAYI KESİYORDU: liste yalnız ton'a göre
      // sıralanıyordu, JS sort KARARLI olduğu için aynı tondaki adaylar arasında
      // sıra tabloya giriş sırasıyla belirleniyordu. Canlıda ALSANCAK (30g gider
      // 2.174₺) listeye girdi, KÖYCEĞİZ (45.539₺ — 20 katı) tavana takılıp
      // dışarıda kaldı. Artık her sinyalin kendi ÖNEM METRİĞİ var (`sira`,
      // küçükten büyüğe): grup içinde büyük para / sert düşüş önce gelir,
      // 3-tavan ondan SONRA uygulanır.
      const kayitlar = subeKarne.map((s) => {
        const sinyaller = [];
        const f = finansOf(s.ad);
        // (a) Ciro yok ama gider sürüyor — en ağır sinyal: kapalı görünen şube para yakıyor.
        //     Önem = yakılan para (gider DESC).
        if (s._ciroYok) {
          const gider = sayi(f?.gider);
          sinyaller.push({
            ton: 'kirmizi', grup: 'ciroYok', sira: -gider,
            metin: `ciro yok, 30g gider ${fmt(gider)}`,
          });
        }
        // (b) Haftalık düşüş — ay bitmeden yakalanması gereken ritim kaybı.
        //     Önem = düşüşün sertliği (yüzde ASC; -22 önce, -6 sonra).
        const h = haftaOf(s.ad);
        const p = h?.degisim_pct;
        if (p != null && sayi(p) <= -5) {
          sinyaller.push({
            ton: sayi(p) <= -15 ? 'kirmizi' : 'amber',
            grup: 'hafta', sira: sayi(p),
            metin: `bu hafta %${Math.abs(sayi(p))} düşüş (${fmt(sayi(h.bu_hafta))})`,
          });
        }
        // (c) Davranış ceza puanı — ciro iyi olsa da çalışma düzeni bozuk olabilir.
        //     Önem = ceza puanı (DESC).
        const dv = davranisOf(s.ad);
        const sk = skorOf(s.ad);
        const ceza = sayi(dv?.toplam_puan ?? sk?.toplam_puan);
        if (ceza >= 20) {
          sinyaller.push({ ton: 'amber', grup: 'ceza', sira: -ceza, metin: `davranış: ${ceza} ceza puanı` });
        }
        // (d) Gider verimi — 1₺ gidere düşen ciro 5₺'nin altındaysa verim zayıf.
        //     Önem = oran (ASC; 1,2₺ önce, 4,8₺ sonra).
        if (f && sayi(f.gider) > 0) {
          const oran = sayi(f.ciro) / sayi(f.gider);
          if (oran < 5) {
            sinyaller.push({
              ton: 'amber', grup: 'verim', sira: oran,
              metin: `1₺ gidere yalnız ${oran.toFixed(1)}₺ ciro`,
            });
          }
        }
        if (!sinyaller.length) return null;
        // Şubenin kendi sinyalleri içinde en ağırı manşete çıkar.
        sinyaller.sort((x, y) => (ONEM[x.ton] - ONEM[y.ton]) || (GRUP[x.grup] - GRUP[y.grup]) || (x.sira - y.sira));
        return { s, enAgir: sinyaller[0], ekSayi: sinyaller.length - 1 };
      }).filter(Boolean);
      // Şubeler arası: ton → grup → grup-içi önem metriği. Tavan EN SONDA.
      kayitlar.sort((a, b) => (
        (ONEM[a.enAgir.ton] - ONEM[b.enAgir.ton])
        || (GRUP[a.enAgir.grup] - GRUP[b.enAgir.grup])
        || (a.enAgir.sira - b.enAgir.sira)
      ));
      // TAVAN 4 (2026-08-14, canlı ders): 3'ken iki "ciro yok" kaydı üst üste yer
      // tutup TEMA'nın %15,7 haftalık düşüşünü — asıl operasyonel sinyali — dışarı
      // itti; oysa dışarıda kalanın yerini tutan 2.174₺'lik gider önemsizdi.
      // 4 sinyal tipi var, 5 şubeli zincirde her tipe bir satır makul.
      return kayitlar.slice(0, 4);
    })();

    return (
      <>
        <KpiSeridi kpiler={kpiler} />

        {dikkatListesi.length > 0 && (
          <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14, borderLeft: `3px solid ${R.amber}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14, fontWeight: 600 }}>⚠ Dikkat isteyen şubeler</span>
              <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>
                sinyal önceliğiyle · dokun → şube dosyası
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {dikkatListesi.map(({ s, enAgir, ekSayi }) => {
                const renk = enAgir.ton === 'kirmizi' ? R.kirmizi : R.amber;
                return (
                  <div
                    key={s.ad}
                    onClick={() => subeDosyasiAc(s)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); subeDosyasiAc(s); }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                      cursor: 'pointer', fontSize: 12.5,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: renk, flexShrink: 0 }} />
                    <b style={{ color: R.krem }}>{s.ad}</b>
                    <span style={{ color: renk }}>— {enAgir.metin}</span>
                    {ekSayi > 0 && <span style={{ color: R.not2, fontSize: 11 }}>· +{ekSayi} sinyal</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── HAFTALIK KIYAS ŞERİDİ (soru 4/9) — gün çok kısa, ay çok geç;
            "hangi şube BU HAFTA düşüşte" bu ritimde yakalanır. ── */}
        {Array.isArray(subeHafta?.subeler) && subeHafta.subeler.length > 0 && (
          <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 9 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14, fontWeight: 600 }}>Bu hafta ↔ önceki hafta</span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                zincir {fmt(sayi(subeHafta.toplam_bu_hafta))} ↔ {fmt(sayi(subeHafta.toplam_gecen_hafta))}
                {subeHafta.genel_degisim_pct != null && (
                  <b style={{ marginLeft: 6, color: sayi(subeHafta.genel_degisim_pct) >= 0 ? R.yesil : R.kirmizi }}>
                    {sayi(subeHafta.genel_degisim_pct) > 0 ? '+' : ''}{subeHafta.genel_degisim_pct}%
                  </b>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {subeHafta.subeler.map((h) => {
                const p = h.degisim_pct;
                const renk = p == null ? R.not : p >= 0 ? R.yesil : R.kirmizi;
                return (
                  <span key={h.sube_id || h.sube_adi} style={{
                    padding: '6px 12px', borderRadius: 99, fontSize: 11.5,
                    background: R.girinti, border: `1px solid ${p != null && p < -5 ? `${R.kirmizi}55` : R.cizgi3}`,
                    color: R.metin2,
                  }}>
                    {h.sube_adi}{' '}
                    <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(h.bu_hafta))}</b>{' '}
                    <b style={{ fontFamily: F.mono, color: renk }}>
                      {p == null ? '—' : `${p > 0 ? '+' : ''}${p}%`}
                    </b>
                  </span>
                );
              })}
            </div>
            {/* A-2. tur: finans-ozet'in ZİNCİR oranları — kart faiz yükü, POS
                kesintisi, toplam kart maliyeti (cironun yüzdesi). Sunucu
                hesaplıyordu, hiçbir ekran okumuyordu. null = "—" (ölçülemedi). */}
            {subeFinans && (() => {
              const oranlar = [
                ['Kart faiz yükü', subeFinans.kart_faiz_yuku_orani, 0.01, 0.02],
                ['POS kesintisi', subeFinans.pos_yanan_para_orani, 0.02, 0.03],
                ['Toplam kart maliyeti', subeFinans.toplam_kart_maliyeti_orani, 0.03, 0.045],
              ].filter(([, v]) => v != null);
              const cgo = subeFinans.ciro_gider_orani_ozet;
              if (!oranlar.length && cgo == null) return null;
              return (
                <div style={{
                  display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10,
                  paddingTop: 9, borderTop: `1px solid ${R.cizgi3}`, fontSize: 11,
                }}>
                  <span style={{ color: R.not2, fontWeight: 700 }}>Zincir · son {sayi(subeFinans.gun_sayi) || 30} gün</span>
                  {cgo != null && (
                    <span style={{ color: R.metin2 }}>
                      1₺ gider → <b style={{ fontFamily: F.mono, color: sayi(cgo) >= 10 ? R.yesil : sayi(cgo) >= 5 ? R.amber : R.kirmizi }}>{sayi(cgo).toFixed(1)}₺</b> ciro
                    </span>
                  )}
                  {oranlar.map(([ad, v, iyi, kotu]) => (
                    <span key={ad} style={{ color: R.metin2 }}>
                      {ad}{' '}
                      <b style={{ fontFamily: F.mono, color: sayi(v) >= kotu ? R.kirmizi : sayi(v) >= iyi ? R.amber : R.yesil }}>
                        %{(sayi(v) * 100).toFixed(1)}
                      </b>
                    </span>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        <Tablo
          baslik={`Şube karnesi · ${d.ayOnEk}`}
          not="satıra tıkla → şube dosyası · son iki kolon depo rolündeki sevkiyat trafiği"
          kolonlar={[
            { ad: 'Şube' }, { ad: 'Ciro', sag: true }, { ad: 'Nakit', sag: true },
            { ad: 'Kart + online', sag: true }, { ad: 'Günlük ort.', sag: true },
            { ad: 'Zincir payı', sag: true }, { ad: 'Kayıt' },
            // ── Gider ekseni (soru 5/9): KANONİK gider (2026-08-10) — nakit çıkışı
            //    anlık giderden, kart çıkışı kart defterinden; her para çıkışı tek
            //    kanal. (Sabit/maaş bu kanonik kovada değil.) ──
            { ad: 'Gider (30g)', sag: true },
            // ── Kontrol Kulesi birleşti: şubenin DEPO rolündeki trafiği ──
            { ad: 'Depo yükü', sag: true }, { ad: 'Yolda', sag: true },
            // ── Davranış ekseni: ciro ≠ düzgün çalışma ──
            { ad: 'Davranış' },
          ]}
          satirlar={subeKarne.map(s => ({
            id: s.ad,
            _s: s,
            hucreler: [
              { v: s._ciroYok ? `${s.ad} · ciro yok` : s.ad, kalin: true, renk: s._ciroYok ? R.not2 : undefined },
              { v: fmt(s.toplam), mono: true, sag: true },
              { v: fmt(s.nakit), mono: true, sag: true },
              { v: fmt(s.kart), mono: true, sag: true },
              { v: fmt(s.toplam / (s.gunSayisi || 1)), mono: true, sag: true },
              { v: `%${trSayi(s.pay)}`, bar: (s.pay / enBuyukPay) * 100, sag: true, renk: s.pay >= enBuyukPay * 0.8 ? R.yesil : s.pay >= enBuyukPay * 0.5 ? R.amber : R.kirmizi },
              { v: `${s.gunSayisi} gün`, rozet: s.gunSayisi >= d.gunSayisi ? R.yesil : R.amber },
              // Gider (soru 5/9): iki satırlı hücre — üstte 30 günlük KANONİK
              // gider (nakit anlık + kart çıkışı), altta ciro/gider oranı. Oran
              // YÜKSEK = iyi (1₺ gidere kaç ₺ ciro). Veri yoksa '—' (sıfır ≠ ölçülemedi).
              (() => {
                const f = finansOf(s.ad);
                if (!f || (!f.gider && !f.ciro)) return { v: '—', sag: true, renk: R.not3, sira: -1 };
                const oran = f.gider > 0 ? f.ciro / f.gider : null;
                return {
                  sira: f.gider, sag: true,
                  v: (
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(f.gider)}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                        color: oran == null ? R.not3 : oran >= 10 ? R.yesil : oran >= 5 ? R.amber : R.kirmizi,
                      }}>
                        {oran == null ? 'gider yok' : `1₺ → ${oran.toFixed(1)}₺ ciro`}
                      </span>
                    </span>
                  ),
                };
              })(),
              // Operasyonel: veri gelmediyse '—' (uydurma sayı yok)
              { v: opsOf(s.ad) ? String(sayi(opsOf(s.ad).toplam)) : '—', mono: true, sag: true,
                renk: opsOf(s.ad) && sayi(opsOf(s.ad).toplam) > 0 ? R.krem : R.not },
              { v: opsOf(s.ad) ? String(sayi(opsOf(s.ad).hazirlikta) + sayi(opsOf(s.ad).gonderildi)) : '—',
                mono: true, sag: true,
                renk: opsOf(s.ad) && (sayi(opsOf(s.ad).hazirlikta) + sayi(opsOf(s.ad).gonderildi)) > 0 ? R.bakir : R.not },
              // Davranış puanı DÜŞÜKSE iyi (ihlal puanı toplanıyor). Veri
              // gelmediyse '—' — sıfır ihlal ile ölçüm yok aynı şey değil.
              (() => {
                const dv = davranisOf(s.ad);
                const sk = skorOf(s.ad);
                if (!dv && !sk) return { v: '—', renk: R.not3, sira: -1 };
                const puan = sayi(dv?.toplam_puan ?? sk?.toplam_puan);
                const ihlal = (dv?.ihlaller || []).length;
                const durum = sk?.durum || dv?.durum;
                return {
                  sira: puan,
                  v: (
                    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{
                        padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                        alignSelf: 'flex-start', whiteSpace: 'nowrap',
                        background: puan >= 20 ? `${R.kirmizi}22` : puan > 0 ? `${R.amber}22` : `${R.yesil}22`,
                        color: puan >= 20 ? R.kirmizi : puan > 0 ? R.amber : R.yesil,
                      }}>{durum || (puan > 0 ? `${puan} ceza` : 'temiz')}</span>
                      {ihlal ? (
                        <span style={{ fontSize: 10, color: R.not2 }}>{ihlal} kural · 30 gün</span>
                      ) : null}
                    </span>
                  ),
                };
              })(),
            ],
          }))}
          onSatir={(row) => subeDosyasiAc(row._s)}
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
      // 🐞 CANLI DENETİM (2026-08-03): 124 "bekleyen işlem" görünüyordu ama
      // Onay ekranı aynı kuyruğu 0 gösteriyordu — kuyruktaki KASA türü kayıtlar
      // onay değil kasa uyumsuzluğudur (Onay ekranındaki frontend filtreyle
      // AYNI ayrım). Gerçek onay + kasa hatası ayrı ayrı yazılır.
      (() => {
        const kasaAdet = onaylar.filter((o) => String(o.islem_turu || '').toUpperCase().includes('KASA')).length;
        const gercekOnay = onaylar.length - kasaAdet;
        return {
          etiket: 'Onay kuyruğu',
          deger: String(gercekOnay),
          alt: kasaAdet ? `bekleyen onay · kasa hatası ${kasaAdet} ayrı sayılır` : 'bekleyen işlem',
          renk: gercekOnay ? R.amber : R.yesil,
        };
      })(),
      { etiket: 'Ciro eksik gün', deger: String(eksikGunler.length), alt: 'kayıt girilmemiş', renk: eksikGunler.length ? R.kirmizi : R.yesil },
      // 🔵 (2026-08-14) Riskler görünümü "kaç adet" sayıyordu ama PARANIN büyüklüğü
      // hiç görünmüyordu — 2 kalem 900 K ₺ ile 9 kalem 4 K ₺ aynı ağırlıkta duruyordu.
      ...(gecikmisToplam > 0 ? [{
        etiket: 'Gecikmiş yük',
        deger: fmt(gecikmisToplam),
        alt: `${gecikmisOdemeler.length} kalem · en eskisi ${enEskiGecikme || '?'} gün`,
        renk: R.kirmizi,
      }] : []),
    ];

    // K5 tutarlılık: "NAKİT YETERSİZ" önerileri Bugün görünümüyle aynı kuralla gruplanır.
    const { grupSatiri, kalan } = kritikNakitAyir(oneriler);
    const satirlar = [
      ...(grupSatiri ? [grupSatiri] : []),
      ...kalan.map((o, i) => ({
        id: `o-${i}`, baslik: o.baslik, alt: o.aciklama,
        tutar: sayi(o.tavsiye_tutar) > 0 ? fmt(o.tavsiye_tutar) : '',
        tier: o.renk === 'KIRMIZI' ? 'kritik' : o.renk === 'TURUNCU' ? 'uyari' : 'bilgi',
        // v2 köprüsü — eskiden klasik 'odeme-merkezi' sayfasına düşüyordu.
        aksiyon: o.odeme_id ? 'Ödemeye git' : '', _hedef: o.odeme_id ? '__modul:odeme:bekleyen' : '',
      })),
      // 🔴 (2026-08-14) Satır "Şube · tarih cirosu girilmemiş" diyordu ama uç ŞUBE
      // GÖNDERMİYOR (alanlar: tarih, gun_adi, days_ago, kritik) → her satırda jenerik
      // "Şube" yazıyordu. Var olmayan alan yerine ucun verdiği bilgi gösterilir.
      ...eksikGunler.slice(0, 6).map((g, i) => ({
        id: `e-${i}`,
        baslik: `${gunTr(g.gun_adi) || 'Gün'} · ${String(g.tarih || g).slice(0, 10)} cirosu girilmemiş`,
        alt: [
          'kâr ve kasa rakamları bu gün için eksik hesaplanır',
          sayi(g.days_ago) === 0 ? 'bugün' : `${sayi(g.days_ago)} gün önce`,
        ].join(' · '),
        tutar: '', tier: g.kritik ? 'kritik' : 'uyari', aksiyon: 'Ciro gir', _hedef: '__modul:para:girisi',
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

      {/* Kâğıt dokusu (marka dokunuşu) — tıklamayı engellemez, en üstte durur */}
      <div aria-hidden="true" style={{
        position: 'fixed', inset: 0, zIndex: 200, pointerEvents: 'none',
        opacity: 0.05, mixBlendMode: 'overlay',
        backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/></filter><rect width="160" height="160" filter="url(#n)"/></svg>'
        )}")`,
      }} />

      {/* ikon rayı */}
      <div className="v2-ray" style={{
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

        {MODULLER.map((m, i) => {
          const aktif = m.id === mod;
          // Tasarım kuralı: modülde KIRMIZI rozetli (acil) bir görünüm varsa
          // ray ikonunda kırmızı nokta belirir.
          const acilVar = m.gorunumler.some(g => g.renk === '#F87171' && rozetler[g.rozet]);
          // Yeni handoff: ray 4 anlamsal bloğa ayrılır; her blok başında
          // 44px genişliğinde üst kenarlıklı etiket durur.
          const blokBasi = i === 0 || MODULLER[i - 1].blok !== m.blok;
          return (
            <React.Fragment key={m.id}>
            {blokBasi && (
              <div style={{
                width: 44, flexShrink: 0, paddingTop: 9, marginTop: 3,
                borderTop: `1px solid ${R.cizgi}`, fontSize: 7.5, fontWeight: 700,
                letterSpacing: '.7px', textTransform: 'uppercase', color: '#5E5142',
                textAlign: 'center', lineHeight: 1.25,
              }}>
                {m.blok}
              </div>
            )}
            <div
              onClick={() => modSec(m.id)}
              title={m.ad}
              className="v2-mod"
              // Klavye erişimi (ui-ux-pro-max sistematik tarama 2026-08-15):
              // ana gezinme yalnız fareyle çalışıyordu — Tab + Enter/Space eklendi.
              tabIndex={0}
              role="button"
              aria-label={m.ad}
              aria-current={aktif ? 'page' : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modSec(m.id); }
              }}
              style={{
                position: 'relative', flexShrink: 0, width: 52, padding: '9px 0 7px', borderRadius: 12,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer',
                color: aktif ? R.bakirAcik : R.not,
                background: aktif ? 'rgba(217,154,78,.14)' : 'transparent',
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
            </React.Fragment>
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

      {/* görünüm sütunu — ≤1040px'te gizlenir, yerini çip satırı alır */}
      <div className="v2-sutun" style={{
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
                tabIndex={0}
                role="button"
                aria-current={aktif ? 'page' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setGorunum(g.id); setCekmece(null); }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', borderRadius: 9,
                  cursor: 'pointer', fontSize: 12.5,
                  // Aktif durum tek sözlükten: zemin .14 · metin #E5B27A · ağırlık 600
                  color: aktif ? R.bakirAcik : R.metin2,
                  fontWeight: aktif ? 600 : 400,
                  background: aktif ? 'rgba(217,154,78,.14)' : 'transparent',
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
            {/* ── DÖNEM SEÇİCİ — yalnız GERÇEKTEN dönem değiştiren yerde ──────
                Denetim (2026-07-30): seçici 14 modülün hepsinde duruyordu ama
                YALNIZ Panel'de iş yapıyordu; kalan 13'te tıklanıyor, hiçbir şey
                değişmiyordu — sessiz yalan. Artık sadece Panel'de görünür.
                ⚠️ Blueprint 3 dilim (Gün/Hafta/Ay) ve sabit katsayıyla ₺
                ölçekleme öneriyor (Hafta ×6,4 / Ay ×27,8). O ÇARPIM UYDURMADIR
                — bizde her dilim GERÇEK bir görünüme düşer. Haftalık toplam
                görünümü henüz yok, o yüzden "Hafta" dilimi de yok. */}
            {mod === 'panel' && (
              <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi}` }}>
                {[['gun', 'Gün', 'bugun'], ['ay', 'Ay', 'ay']].map(([id, ad, hedefGorunum]) => (
                  <div
                    key={id}
                    onClick={() => { setDonem(id); setGorunum(hedefGorunum); setCekmece(null); }}
                    style={{
                      padding: '5px 13px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                      color: gorunum === hedefGorunum ? '#1C1309' : R.not,
                      background: gorunum === hedefGorunum ? `linear-gradient(150deg, #E0A559, #AF6C29)` : 'transparent',
                    }}
                  >
                    {ad}
                  </div>
                ))}
              </div>
            )}

            {/* ── TARİH GEZGİNİ (yeni handoff) ─────────────────────────────
                YALNIZ beyaz listedeki ekranlarda çıkar (tema.js). Gün kavramı
                olmayan ya da o günün verisini getiremediğimiz ekranda gezgin
                göstermek "yanlış tarih iddiası" olur — bu yüzden liste dar. */}
            {gezginVar && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: 3, borderRadius: 10,
                background: R.girinti, border: `1px solid ${R.cizgi}`,
              }}>
                <button
                  onClick={() => setSecilenGun(gunEkle(odakGunSimdi, -1))}
                  title="Önceki gün"
                  style={okStil}
                >‹</button>
                <div
                  onClick={() => setSecilenGun(null)}
                  title={gecmisGunMu ? 'Bugüne dön' : 'Canlı gün'}
                  style={{
                    minWidth: 92, textAlign: 'center', padding: '2px 8px', cursor: 'pointer',
                    lineHeight: 1.2,
                  }}
                >
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: gecmisGunMu ? R.amber : R.krem }}>
                    {kisaGun(odakGunSimdi)}
                  </div>
                  <div style={{ fontSize: 9.5, color: R.not2 }}>
                    {gecmisGunMu ? 'geçmiş gün' : 'canlı'}
                  </div>
                </div>
                <button
                  onClick={() => {
                    const y2 = gunEkle(odakGunSimdi, 1);
                    setSecilenGun(y2 >= bugunISO ? null : y2);   // geleceğe geçilmez
                  }}
                  disabled={!gecmisGunMu}
                  title={gecmisGunMu ? 'Sonraki gün' : 'Gelecek gün yok'}
                  style={{ ...okStil, opacity: gecmisGunMu ? 1 : 0.35, cursor: gecmisGunMu ? 'pointer' : 'default' }}
                >›</button>
              </div>
            )}

            {/* Arama tetikleyici — salt-okur; tıklama komut paletini açar (yeni handoff) */}
            <div
              onClick={paletAc}
              className="v2-arama"
              title="Modül, ekran ara — ⌘K"
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 10,
                background: R.girinti, border: `1px solid ${R.cizgi}`, color: R.not2, fontSize: 12.5,
                width: 'clamp(150px, 16vw, 230px)', cursor: 'pointer',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" />
              </svg>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Ara — modül, ekran
              </span>
              <span style={{ fontFamily: F.mono, fontSize: 10, color: '#6E6052', flexShrink: 0 }}>⌘K</span>
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

            {/* "Klasik görünüm" butonu KALDIRILDI (sahip 2026-07-29): ana ekran
                %100 kadife. Klasik ekranlar silinmedi — v2 köprüleri gerektiğinde
                götürür; gizli kapı: adres çubuğuna #panel (veya sayfa hash'i). */}

            {/*
              Blueprint'te üst çubukta "Gün Sonu Kapat" var. Ama bu sistemde gün
              sonunu KASA KİMDEYSE O kapatır (şubede, 5 adımlı mühür/QR akışı) —
              masaüstünden tek tuşla 4 şubeyi kapatmak o modeli deler.
              Sahip kararı: buton DURUR ama kapatmaz; kapanışın izlendiği ekrana
              götürür (Operasyon Merkezi → 📊 Kapanış Takip).
            */}
            {/* BAĞLAMA GÖRE BİRİNCİL EYLEM (yeni handoff kuralı, 2026-07-30):
                başlıktaki birincil eylem İÇERİKLE İLGİSİZSE render edilmez.
                Gün sonu yalnız GÜNLÜK OPERASYON modüllerinde anlamlı; TV menüsü
                düzenlerken ya da borç takvimine bakarken orada durması
                kullanıcıyı yanlış yönlendirir. */}
            {GUN_SONU_MODULLERI.includes(mod) && (
              <button
                onClick={() => koprule('__modul:ops:bar')}
                title="Kapanış takibini açar — kapatma işlemi şubede mühür/QR ile yapılır"
                style={{
                  padding: '8px 15px', borderRadius: 10, border: 'none',
                  background: `linear-gradient(150deg, #E0A559, #AF6C29)`, color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                  boxShadow: '0 6px 18px rgba(217,154,78,.24)',
                }}
              >
                Gün Sonu Takibi
              </button>
            )}
            {/* ESKİ ARAYÜZ KAPISI (sahip 2026-08-01: "hemen yanına koyacaksın,
                tıklayınca o arayüzden çalışsın"). Klasik kabuk emekli ama SİLİNMEDİ
                — '#klasik:<sayfa>' kapısı hâlâ ayakta (App.jsx:181). Buton o kapıyı
                kullanır ve klasik Operasyon Merkezi'ni DOĞRUDAN Kapanış Takip
                sekmesinde açar. Sekme açma bilgisi ELLE yazılmaz: 'kapanis-takip'
                zaten bir sayfa TAKMA ADI (utils/sayfaTakmaAd.js:26) — çözümlenirken
                sessionStorage 'ops_merkez_ac_sekme' bayrağını kendi koyar ve
                'ops-merkez' döner; OperasyonMerkezi.jsx:4977 bayrağı okuyup sekmeyi
                açar. Tek kaynak korunur.
                ⚠️ koprule() BURADA KULLANILMAZ: gerçek uygulamada onGit=App.navigate
                ve navigate ham id'yi doğrudan resolvePageAlias'a verir — 'klasik:'
                önekli hâli orada TANINMAZ, PAGES'te de yok, sessizce Panel'e düşerdi.
                İki taşıyıcının sözleşmesi farklı, ikisi de ayrı besleniyor:
                  · onGit varsa  → takma ad ('kapanis-takip')
                  · yoksa        → hash kapısı ('#klasik:kapanis-takip')
                Hash yolunda App'in hashchange dinleyicisi sayfayı çevirir; sayfa
                yenilemesi gerekmez, v2'ye dönüş tarayıcı geri tuşuyla olur. */}
            {GUN_SONU_MODULLERI.includes(mod) && (
              <button
                onClick={() => {
                  if (onGit) onGit('kapanis-takip');
                  else window.location.hash = 'klasik:kapanis-takip';
                }}
                title="Aynı işi ESKİ arayüzde açar — klasik Operasyon Merkezi ▸ 📊 Kapanış Takip. Geri dönmek için tarayıcı geri tuşu."
                style={{
                  padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${R.cizgi3}`, background: R.girinti,
                  color: R.metin2, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                ⧉ Eski arayüz
              </button>
            )}
          </div>
        </header>

        {/* ═══ İÇERİK ALANI — MODAL KONUMLANDIRMASININ KÖKÜ (2026-08-15) ═══
            Sahip: "modallar sayfanın ALT kısmında açılıyor, görmek için aşağı
            inmek zorundayız."

            KÖK: bu sarmalayıcı `animation: v2yuksel … both` taşıyordu ve o
            keyframes TRANSFORM içeriyor (translateY(12px) → none). CSS kuralı:
            transform UYGULANAN eleman, `position:fixed` torunları için İÇEREN
            BLOK olur. `fill-mode: both` FORWARDS fill de içerdiği için animasyon
            bittikten SONRA da transform'u "etkilemeye" devam ediyor → içeren
            blok KALICI oluyordu. Sonuç: modüllerin `inset:0` modalları viewport'a
            değil, bu UZUN içerik kutusuna göre ortalanıyor, yani ekranın altına
            düşüyordu (sayfa uzadıkça daha aşağı).

            ÇÖZÜM — `both` → `backwards`:
              · `backwards` = yalnız GECİKME öncesi ilk kare uygulanır.
              · Bitişte FORWARDS fill YOK → transform artık animasyonla
                sürülmüyor → eleman içeren blok OLMAKTAN ÇIKIYOR.
              · GÖRSEL FARK YOK: `to` karesi zaten `opacity:1; transform:none`,
                yani elemanın doğal hâli. Giriş "yükseliş" hissi aynen duruyor.

            ⚠️ NEDEN "animasyonu iç bir elemana taşımak" ÇÖZMEZ: modallar
            renderModul() içinde, yani o iç elemanın DA torunu olurdu — tuzak
            yer değiştirir, kaybolmazdı. Mesele sarmalayıcının YERİ değil,
            transform'un KALICI kalmasıydı.

            📌 Bu tek satır 9 modüldeki ~27 modalı birden viewport'a çözer.
            (Çekmece ve kabuk bildirimi zaten bu sarmalayıcının DIŞINDA — o
            yüzden onlar hep doğru çalışıyordu; teşhisin kanıtı da buydu.) */}
        <div style={{
          padding: '22px 30px 60px', maxWidth: 1420, margin: '0 auto',
          animation: 'v2yuksel .28s cubic-bezier(.22,1,.36,1) backwards',
        }}>
          {hataDefteri.length > 0 && (
            <HataBandi
              mesaj={hataDefteri[0].mesaj}
              kod={hataDefteri[0].kod}
              kaynak={hataDefteri.length > 1
                ? `${hataDefteri[0].yol} +${hataDefteri.length - 1} uç daha`
                : hataDefteri[0].yol}
              deneme={hataDefteri[0].adet > 1 ? `${hataDefteri[0].adet}. kez` : null}
              onTekrar={() => { istekHatalariniTemizle(); setHataDefteri([]); yukle(); }}
            />
          )}

          {gezginVar && gecmisGunMu && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 13, padding: '13px 16px',
              borderRadius: 12, marginBottom: 16, flexWrap: 'wrap',
              background: 'linear-gradient(165deg, rgba(251,191,36,.10), #221809)',
              border: '1px solid rgba(251,191,36,.30)',
            }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: R.amber }}>
                  {uzunGun(odakGunSimdi)}
                </div>
                <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 3, lineHeight: 1.55 }}>
                  Geçmiş gün görüntüleniyor. Rakamlar o günün kapanışıdır; canlı
                  değildir ve buradan düzeltme kaydı girilemez.
                </div>
              </div>
              <button
                onClick={() => setSecilenGun(null)}
                style={{
                  flexShrink: 0, padding: '8px 15px', borderRadius: 9, cursor: 'pointer',
                  border: `1px solid ${R.amber}55`, background: `${R.amber}18`,
                  color: R.amber, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                }}
              >
                Bugüne dön
              </button>
            </div>
          )}

          {/* Dar ekran gezinmesi: 222px kolon gizlenince görünümler çip olur */}
          <div className="v2-cip-satiri" style={{ gap: 7, overflowX: 'auto', paddingBottom: 2, marginBottom: 16 }}>
            {modObj.gorunumler.map((g) => {
              const aktif = g.id === gorunum;
              const sayac = rozetler[g.rozet];
              return (
                <div
                  key={g.id}
                  onClick={() => { setGorunum(g.id); setCekmece(null); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer',
                    padding: '7px 13px', borderRadius: 99, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                    color: aktif ? R.bakirAcik : R.metin2,
                    background: aktif ? 'rgba(217,154,78,.14)' : R.girinti,
                    border: `1px solid ${aktif ? 'rgba(217,154,78,.38)' : R.cizgi}`,
                  }}
                >
                  {g.ad}
                  {sayac > 0 && (
                    <span style={{
                      fontFamily: F.mono, fontSize: 9.5, fontWeight: 700, padding: '1px 6px',
                      borderRadius: 99, background: `${g.renk || R.bakir}26`, color: g.renk || R.bakir,
                    }}>
                      {sayac}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
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
          // Belgeler / İz sekmeleri (yeni handoff): modül veri geçerse dolar,
          // geçmezse sekme NEDEN boş olduğunu söyler — uydurma belge/iz yok.
          belgeler={cekmece?.belgeler}
          iz={cekmece?.iz}
          // 📎 Belge yükleme: modül geçerse Belgeler sekmesinde düğme çıkar.
          belgeYukle={cekmece?.belgeYukle}
          dosyaBilgi={cekmece?.dosyaBilgi}
          aksiyonAd={cekmece?.aksiyonAd}
          onAksiyon={() => koprule(cekmece?._hedef)}
          // Çoklu aksiyon (modül kendi işini yapar): tıklayınca çekmece kapanır,
          // modülün açtığı form/onay öne gelsin.
          aksiyonlar={(cekmece?.aksiyonlar || []).map((a) => ({
            ...a,
            onTikla: () => { setCekmece(null); a.onTikla?.(); },
          }))}
          onKapat={() => setCekmece(null)}
        />
        {/* Yeni sipariş bilgi modalı — kadife dilinde, klasik hub bildiriminin karşılığı */}
        {siparisBildirim && (
          <div
            onClick={() => setSiparisBildirim(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 130, display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: 20, background: 'rgba(10,6,2,.7)',
              backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
              animation: 'v2belir .14s ease both',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: 420, borderRadius: 20,
                background: 'linear-gradient(165deg, #2C2116, #231909)',
                border: `1px solid ${R.bakir}44`, boxShadow: '0 26px 60px rgba(0,0,0,.5), 0 0 40px rgba(217,154,78,.14)',
                animation: 'v2buyu .26s cubic-bezier(.4,0,.2,1) both',
              }}
            >
              <div style={{ padding: '20px 22px 14px', borderBottom: `1px solid ${R.cizgi2}` }}>
                <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>
                  📬 {siparisBildirim.yeniler.length === 1 ? 'Yeni sipariş talebi' : `${siparisBildirim.yeniler.length} yeni sipariş talebi`}
                </div>
                <div style={{ fontSize: 12, color: R.not, marginTop: 4 }}>şubeden merkeze düştü — depo yönlendirmesi bekliyor</div>
              </div>
              <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {siparisBildirim.yeniler.slice(0, 4).map((s) => (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>{s.sube_adi || 'Şube'}</span>
                    <span style={{ fontSize: 11.5, color: R.metin2 }}>
                      {(s.kalemler || []).length} kalem · {sayi(s.kalem_sayisi)} adet
                    </span>
                  </div>
                ))}
                {siparisBildirim.yeniler.length > 4 && (
                  <div style={{ fontSize: 11, color: R.not3 }}>+{siparisBildirim.yeniler.length - 4} talep daha…</div>
                )}
              </div>
              <div style={{ padding: '14px 22px', borderTop: `1px solid ${R.cizgi2}`, display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
                <button onClick={() => setSiparisBildirim(null)} style={{
                  padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
                  background: 'transparent', color: R.not, fontSize: 12.5, fontWeight: 600,
                  fontFamily: 'inherit', cursor: 'pointer',
                }}>Kapat</button>
                <button onClick={() => { setSiparisBildirim(null); setMod('ops'); setGorunum('akis'); setCekmece(null); }} style={{
                  padding: '9px 18px', borderRadius: 10, border: 'none',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                }}>Sipariş Akışını aç</button>
              </div>
            </div>
          </div>
        )}
        <Toast metin={toast} />
      </main>

      {/* ── KOMUT PALETİ (580px, üstten %12) ──────────────────────────────── */}
      {palet && (() => {
        const sonuc = paletListe();
        return (
          <div
            onClick={paletKapat}
            style={{
              position: 'fixed', inset: 0, zIndex: 150, display: 'flex',
              alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 20px 20px',
              background: 'rgba(10,6,2,.72)', backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)', animation: 'v2belir .14s ease both',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%', maxWidth: 580, borderRadius: 16, overflow: 'hidden',
                background: 'linear-gradient(168deg,#2E2216,#20170B)',
                border: '1px solid rgba(243,233,220,.13)',
                boxShadow: '0 34px 80px -24px rgba(0,0,0,.85), inset 0 1px 0 rgba(255,241,224,.07)',
                animation: 'v2buyu .2s cubic-bezier(.4,0,.2,1) both',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: `1px solid ${R.cizgi3}` }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={R.bakir}
                  strokeWidth="1.8" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" />
                </svg>
                <input
                  ref={paletRef}
                  value={paletQ}
                  onChange={(e) => { setPaletQ(e.target.value); setPaletI(0); }}
                  onKeyDown={paletTus}
                  placeholder="Modül, ekran veya kayıt ara…"
                  style={{
                    flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
                    color: R.krem, fontSize: 15, fontFamily: 'inherit',
                  }}
                />
                <span style={{ fontFamily: F.mono, fontSize: 10, color: '#6E6052', flexShrink: 0 }}>esc</span>
              </div>

              <div style={{ maxHeight: '46vh', overflowY: 'auto', overflowX: 'hidden', padding: 8 }}>
                {sonuc.length === 0 ? (
                  <div style={{ padding: '32px 18px', textAlign: 'center' }}>
                    <div style={{ fontFamily: F.baslik, fontSize: 15, color: R.metin2 }}>Eşleşen ekran yok</div>
                    <div style={{ fontSize: 12, color: '#6E6052', marginTop: 5 }}>
                      «{paletQ}» için sonuç bulunamadı — modül adı ya da ekran adı deneyin
                    </div>
                  </div>
                ) : sonuc.map((p, i) => {
                  const secili = i === paletI;
                  return (
                    <div
                      key={`${p.mod}.${p.view}`}
                      onClick={() => paletGit(p)}
                      onMouseEnter={() => setPaletI(i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 11, padding: '9px 11px',
                        borderRadius: 8, cursor: 'pointer',
                        background: secili ? 'rgba(217,154,78,.14)' : 'transparent',
                      }}
                    >
                      <span style={{
                        width: 74, flexShrink: 0, fontSize: 9, fontWeight: 700, letterSpacing: '.6px',
                        textTransform: 'uppercase', color: '#5E5142',
                      }}>
                        {p.blok}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, color: secili ? R.bakirAcik : R.krem }}>
                          {p.ad}
                        </span>
                        <span style={{ display: 'block', fontSize: 11, color: R.not2, marginTop: 2 }}>{p.modAd}</span>
                      </span>
                      {p.rozet > 0 && (
                        <span style={{
                          fontFamily: F.mono, fontSize: 10, fontWeight: 700, padding: '2px 7px',
                          borderRadius: 99, background: `${p.renk || R.bakir}26`, color: p.renk || R.bakir,
                        }}>
                          {p.rozet}
                        </span>
                      )}
                      <span style={{ fontFamily: F.mono, fontSize: 10, color: '#6E6052', flexShrink: 0 }}>
                        {secili ? '↵' : ''}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '10px 18px',
                borderTop: `1px solid ${R.cizgi3}`, background: 'rgba(18,12,7,.5)',
                fontSize: 10.5, color: '#6E6052',
              }}>
                <span>↑↓ gez</span><span>↵ aç</span><span>esc kapat</span>
                <span style={{ marginLeft: 'auto' }}>{MODULLER.reduce((s, m) => s + m.gorunumler.length, 0)} ekran</span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
