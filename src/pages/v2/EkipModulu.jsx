// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Personel & Vardiya modülü (7 görünüm, en geniş modül)
//
// Tasarım: ICERIK → ekip.kadro / vardiya / maas / gorev / takip / basvuru / pinqr
//
// ⚠️ MAAŞ ÇEKİRDEĞİNE DOKUNULMAZ: hesap `maas_service.py`, avans `avans_service.py`
// tek merkezdedir. Bu modül YALNIZ OKUR — bordro onayı/ödemesi mevcut Personel
// ekranından yapılır (guard'lar orada). Vardiya ataması da masaüstünden YAZILMAZ;
// ızgara salt-okurdur, atama planlama ekranından/şube panelinden yapılır.
//
// Veri uçları (hepsi salt-okur):
//   /personel?aktif=true                → kadro
//   /vardiya/v2/hafta-sube-tablo        → haftalık ızgara (şube × 7 gün)
//   /personel-aylik?yil=&ay=            → bordro (brüt, fazla mesai, avans, net, aşama)
//   /avans/ozet                         → avans toplamı
//   /gorev/ozet?tarih=                  → görev tamamlanma (şube × vardiya tipi)
//   /gorev/vardiya-takip?yil=&ay=       → giriş-çıkış, gecikme, fazla mesai
//   /is-basvurusu + /is-basvurusu/ozet  → başvurular
//   /sube-panel/merkez/personel-panel-pin → panel PIN durumu (PERSONEL bazlı)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, VardiyaIzgara } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const HAFTA = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

// ⚠️ Tarih tuzağı için bkz. TasarimV2.jsx — gün aritmetiği UTC'de yapılır.
const isoBugun = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isoEkle = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const haftaGunu = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
/** Verilen günün içinde bulunduğu haftanın pazartesisi. */
const pazartesiBul = (iso) => {
  const g = haftaGunu(iso);
  return isoEkle(iso, g === 0 ? -6 : 1 - g);
};
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

// ── VARDİYA TAKİP · GÜN DETAYI (/gorev/vardiya-takip → personel.gunler[]) ────
// Sunucu her planlı gün için ayrı ayrı döndürür: planlanan_saat · gecikme_dk ·
// fazla_mesai_saat · yemek_sure_dk/limit_dk/ucret_hakki · part_tam_uyari ·
// giris_var · baslangic_gunu. v2 bunların HİÇBİRİNİ okumuyordu (gorev_api:2197).
//
// Üç sinyal AYRI toplanır, biri diğerini gizlemez (ham veriyi hep topla):
//   · giriş yok    → vardiya planlı ama yoklama kaydı yok. baslangic_gunu HARİÇ:
//                    sistem kurulumundan (9 Haz 2025) önceki günleri sunucu
//                    "tam ve doğru çalışıldı" sayar, giris_var'ı true damgalar.
//   · yemek kaybı  → mola limiti AŞILDIĞI için hak doğmamış. Kişinin cebinden
//                    çıkan para; toplam yemek gününde görünmez.
//                    ⚠️ "hak yok" TEK BAŞINA kayıp değildir: part-time personel
//                    kısa günde zaten hak kazanmaz (gorev_api:2190 — hak yalnız
//                    part_tam ya da sürekli personelde doğar). Bunu kayıp saymak
//                    part-time'ın HER gününü uyarıya çevirirdi (tezgâhta 21 gün
//                    çıktı, 2026-08-01). Limit biliniyorsa AŞIM şart koşulur.
//   · part-tam     → part-time personele tam gün (≥9,4 sa) yazılmış. Bordro
//                    riski: part sayılıp tam çalıştırılıyor.
// Personel risk sinyali türleri (personel_risk_sinyal.sinyal_turu) — sunucu ham
// kod gönderir, ekranda insan diline çevrilir.
const RISK_SINYAL = {
  ACILIS_KASA_FARK: { ad: 'Açılış kasa farkı', renk: '#FBBF24' },
  KAPANIS_KASA_FARK: { ad: 'Kapanış kasa farkı', renk: '#FBBF24' },
  KASA_GERCEK_ACIK: { ad: 'Gerçek kasa açığı', renk: '#F87171' },
  SAYIM_OZENSIZLIK: { ad: 'Sayım özensizliği', renk: '#FBBF24' },
  GENEL: { ad: 'Genel', renk: '#8B7B67' },
};
// personel_takip.takip_seviyesi (database.py:2155)
const TAKIP_SEVIYE = {
  izlemede: { ad: 'izlemede', renk: '#60A5FA' },
  uyari: { ad: 'uyarı', renk: '#FBBF24' },
  kritik: { ad: 'KRİTİK', renk: '#F87171' },
};

const gunAnaliz = (t) => {
  const g = (t?.gunler || []).filter((x) => sayi(x.planlanan_saat) > 0);
  const isPart = String(t?.calisma_turu || '').toLocaleLowerCase('tr').includes('part');
  return {
    tumu: g,
    girisYok: g.filter((x) => !x.baslangic_gunu && x.giris_var === false),
    yemekKayip: g.filter((x) => {
      if (x.yemek_ucret_hakki) return false;
      if (x.yemek_sure_dk == null) return false;
      if (x.yemek_limit_dk != null) return sayi(x.yemek_sure_dk) > sayi(x.yemek_limit_dk);
      return !isPart;   // limit bilinmiyor → part-time'da hüküm verme
    }),
    partTam: g.filter((x) => x.part_tam_uyari === true),
  };
};

/** Bir günün tek cümlelik özeti — çekmecedeki iz defteri satırı. */
const gunCumle = (x) => {
  const p = [];
  p.push(`${trSayi(sayi(x.planlanan_saat))} sa planlandı`);
  if (x.baslangic_gunu) p.push('sistem başlangıcı — tam sayıldı');
  else if (x.giris_var === false) p.push('giriş kaydı YOK');
  if (sayi(x.gecikme_dk) > 0) p.push(`${trSayi(sayi(x.gecikme_dk), 0)} dk geç girildi`);
  if (sayi(x.fazla_mesai_saat) > 0) p.push(`${trSayi(sayi(x.fazla_mesai_saat))} sa fazla mesai`);
  if (x.yemek_sure_dk != null) {
    const sure = trSayi(sayi(x.yemek_sure_dk), 0);
    const limit = x.yemek_limit_dk != null ? `/${sayi(x.yemek_limit_dk)}` : '';
    p.push(x.yemek_ucret_hakki
      ? `yemek ${sure}${limit} dk · hak kazandı`
      : `yemek ${sure}${limit} dk · limit aşıldı, ücret hakkı YOK`);
  } else if (x.yemek_ucret_hakki) p.push('yemek ücreti hak edildi');
  if (x.part_tam_uyari) p.push('part-time personele TAM gün yazıldı');
  return p.join(' · ');
};

/** başlangıç tarihinden bugüne kıdem (ay). */
const kidemAy = (bas) => {
  if (!bas) return null;
  const b = new Date(String(bas).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  const n = new Date(isoBugun() + 'T00:00:00Z');
  return Math.max(0, (n.getUTCFullYear() - b.getUTCFullYear()) * 12 + (n.getUTCMonth() - b.getUTCMonth()));
};

/** Bordro aşaması → rozet rengi (tasarımdaki onaylı/taslak/ödendi dili). */
const ASAMA_RENK = { odendi: R.mavi, onayli: R.yesil, onay_bekliyor: R.amber, taslak: R.amber };
// DB slug'ı ekranda ham gösterilmez (düz-dil kuralı): 'onayli' → 'onaylı'.
const ASAMA_AD = { odendi: 'ödendi', onayli: 'onaylı', onay_bekliyor: 'onay bekliyor', taslak: 'taslak' };
const asamaAd = (d) => ASAMA_AD[d] || trKucuk(d) || 'taslak';

/** Çalışma türü slug'ı da ham gösterilmez: 'surekli' → 'sürekli'. */
const TUR_AD = { surekli: 'sürekli', part: 'part-time', gunluk: 'günlük', stajyer: 'stajyer' };
const turAd = (t) => TUR_AD[t] || trKucuk(t) || '—';

/** Sürekli personelde aylık ücret, part-time'da saatlik ücret gösterilir. */
// Yerli form stilleri (köprü kaldırma turu)
const vpOk = {
  width: 26, height: 26, borderRadius: 8, border: `1px solid ${R.cizgi3}`,
  background: R.girinti, color: R.metin2, fontSize: 13, cursor: 'pointer',
  fontFamily: 'inherit', lineHeight: 1,
};
const rozetHapV = {
  padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
};
const ekAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const ekEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

const ucretMetni = (p) => (sayi(p.maas) > 0
  ? fmt(sayi(p.maas))
  : sayi(p.saatlik_ucret) > 0 ? `${fmt(p.saatlik_ucret)}/sa` : '—');

const plBtn = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const plMini = {
  padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};

const BV_DURUM_AD = {
  bekliyor: 'Bekliyor', gorusme: 'Görüşme', olumlu: 'Olumlu', olumsuz: 'Olumsuz',
};

export default function EkipModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [personel, setPersonel] = useState([]);
  // ── YERLİ PERSONEL CRUD (köprü kaldırma turu, 2026-07-30) ─────────────────
  // Klasik Personel.jsx sözleşmesi aynen. Bordro/maaş ödemesi ve vardiya
  // planlama BİLEREK taşınmadı (maaş guard'lı akış + 5338 satırlık planlayıcı).
  const [pForm, setPForm] = useState(null);      // {duzenleId?, ad_soyad, gorev, ...}
  const [pMesgul, setPMesgul] = useState(false);
  const [cikisForm, setCikisForm] = useState(null);  // {id, ad, neden}
  const [subeListe, setSubeListe] = useState([]);
  // ── DERİN TAKİP (köprü kaldırma turu, 2026-07-30) ─────────────────────────
  // Klasik PersonelVardiyaTakip'in iki bloğu: izin alacağı (borçlu hafta ↔
  // verilen izin) ve o gün vardiya dışı görünen girişler.
  const [izin, setIzin] = useState(null);
  const [vardiyaDisi, setVardiyaDisi] = useState(null);
  // ── PERSONEL DENETİMİ (ops-merkez P2 sekmeleri, 2026-07-30) ───────────────
  // davranış analizi · puan defteri · geç kalma · kasa açık analizi + kasiyer karne
  const [pdSekme, setPdSekme] = useState('davranis');
  const [pdDavranis, setPdDavranis] = useState(null);
  const [pdPuan, setPdPuan] = useState(null);
  const [pdGec, setPdGec] = useState(null);
  const [pdKasa, setPdKasa] = useState(null);
  const [pdKarne, setPdKarne] = useState(null);
  // Sahip kararı (2026-08-03, soru 6/9): /ops/metrics/personel-verimlilik'in
  // KİŞİ ikizleri buraya dağıtıldı — tepki hızı çekmecede, PIN dağılımı blokta.
  // kasa_farki_frekansi ALINMADI: davranış tablosundaki kasa farkıyla mükerrer.
  const [pdVerim, setPdVerim] = useState(null);
  const [pdHata, setPdHata] = useState('');
  // Yazma-ucu turu (2026-08-03): POST /gorev/gecikme-eksik-gun — yönetici
  // kararıyla gecikme eksik güne çevrilir (klasik EksikGunModal karşılığı).
  // Sunucu KATMALI yazar (mevcut+yeni) ve kanonik neti yeniden hesaplar;
  // onaylı bordro kilitliyse 400 döner. Bordrodaki mutlak alanın yerini almaz.
  const [eksikGunModal, setEksikGunModal] = useState(null); // {t, gun, not, mesgul}
  // ── YERLİ VARDİYA PLANLAYICI (köprü kaldırma turu, 2026-07-30) ────────────
  // Klasik VardiyaPlanlamaV2 (5338 satır) çekirdeği: gün planı + atama/sil +
  // çakışma kontrolü. Sürükle-bırak yerine TIKLA-ATA (dokunmatikte de çalışır).
  // Uçlar aynen: /vardiya/v2/gun · /assign · /atama/check · /atama/{id} DELETE ·
  // /gun-kopyala · /gun-temizle
  const [vpTarih, setVpTarih] = useState(() => isoBugun());
  const [vpGun, setVpGun] = useState(null);
  const [vpHata, setVpHata] = useState('');
  const [vpMesgul, setVpMesgul] = useState('');
  const [vpAtaModal, setVpAtaModal] = useState(null);   // {slot, subeAd, personelId, uyari, override}
  const [vpKopyaModal, setVpKopyaModal] = useState(null);
  const [hafta, setHafta] = useState(null);
  // 🐞 /personel-aylik NESNE döndürür: {yil, ay, personeller[], toplam_tahmini}
  // (main.py:5676). Eski kod iki çağrı yerinde de `Array.isArray(b) ? b : []`
  // yazıyordu → HER ZAMAN boş dizi → Maaş & Avans bordro tablosu CANLIDA
  // TAMAMEN BOŞTU. Tezgâh gizliyordu: mock (BORDRO) düz dizi.
  // Tek okuyucu burada; iki çağrı yeri de bunu kullanır.
  const bordroCoz = (b) => (Array.isArray(b) ? { personeller: b, toplam_tahmini: null }
    : { personeller: Array.isArray(b?.personeller) ? b.personeller : [], toplam_tahmini: b?.toplam_tahmini ?? null });
  const [bordroVeri, setBordroVeri] = useState({ personeller: [], toplam_tahmini: null });
  const bordro = bordroVeri.personeller;
  const setBordro = (b) => setBordroVeri(bordroCoz(b));
  const [avans, setAvans] = useState(null);
  const [gorevOzet, setGorevOzet] = useState([]);
  const [takip, setTakip] = useState([]);
  const [basvurular, setBasvurular] = useState([]);
  const [basvuruOzet, setBasvuruOzet] = useState(null);
  const [pinler, setPinler] = useState([]);
  // ── SON KÖPRÜ TURU (2026-07-30) — klasikle bağ kalmasın ────────────────────
  // Bordro onay/ödeme, panel PIN ve QR/konum ayarı artık YERLİ. Uçlar aynı
  // guard'lı uçlar; maaş hesabı hâlâ maas_service'in tekelinde — burada
  // yalnız o çekirdeğin AÇTIĞI kapılar (kaydet/onayla/öde/kilit) kullanılır.
  const [bMesgul, setBMesgul] = useState(false);
  const [bModal, setBModal] = useState(null);      // {tip, b, form}
  const [bGecmis, setBGecmis] = useState(null);    // geçmiş dizisi
  const [pinModal, setPinModal] = useState(null);  // {id, ad, pin}
  const [pinOnay, setPinOnay] = useState({ id: '', pin: '' });
  const [pinMesgul, setPinMesgul] = useState(false);
  const [merkezKey, setMerkezKey] = useState('');
  const [qrListe, setQrListe] = useState(null);
  const [qrModal, setQrModal] = useState(null);    // {sube_id, sube_ad, lat, lng, radius, yapistir}
  const [qrMesgul, setQrMesgul] = useState(false);

  const bugun = isoBugun();
  const buYil = Number(bugun.slice(0, 4));
  const buAy = Number(bugun.slice(5, 7));
  const pazartesi = pazartesiBul(bugun);

  // Dönem seçimi (sahip isteği 2026-07-29): maaş/takip AY, görev GÜN gezinir —
  // "bu aya sabit" sınırlaması kalktı; geçmiş bordro/takip kadifede görünür.
  const [donem, setDonem] = useState({ yil: buYil, ay: buAy });
  const [gorevTarih, setGorevTarih] = useState(bugun);
  const yil = donem.yil;
  const ay = donem.ay;
  const [donemYukleniyor, setDonemYukleniyor] = useState(false);
  const [silForm, setSilForm] = useState(null);     // {id, ad}
  const [syncOnay, setSyncOnay] = useState(false);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/personel?aktif=true').catch(() => []),
      api(`/vardiya/v2/hafta-sube-tablo?pazartesi=${pazartesi}`).catch(() => null),
      api(`/personel-aylik?yil=${donem.yil}&ay=${donem.ay}`).catch(() => []),
      api('/avans/ozet').catch(() => null),
      api(`/gorev/ozet?tarih=${gorevTarih}`).catch(() => []),
      api(`/gorev/vardiya-takip?yil=${donem.yil}&ay=${donem.ay}`).catch(() => null),
      api('/is-basvurusu?limit=200').catch(() => []),
      api('/is-basvurusu/ozet').catch(() => null),
      api('/sube-panel/merkez/personel-panel-pin').catch(() => []),
      api('/gorev/izin-alacagi').catch(() => null),
      api(`/gorev/yoklama?tarih=${bugun}&sadece_vardiya_disi=true`).catch(() => []),
    ]).then(([p, h, b, av, go, vt, bs, bo, pin, iz, vd]) => {
      setIzin(iz);
      setVardiyaDisi(Array.isArray(vd) ? vd : (vd?.kayitlar || []));
      setPersonel(Array.isArray(p) ? p : []);
      setHafta(h);
      setBordro(b);
      setAvans(av);
      setGorevOzet(Array.isArray(go) ? go : []);
      setTakip(Array.isArray(vt) ? vt : (vt?.personeller || []));
      setBasvurular(Array.isArray(bs) ? bs : (bs?.basvurular || []));
      setBasvuruOzet(bo);
      setPinler(Array.isArray(pin) ? pin : []);
      if (!(Array.isArray(p) && p.length)) setHata('Personel verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  // ── VARDİYA PLAN ALTYAPISI (Faz 5, 2026-07-31) ────────────────────────────
  // Klasikte plan İSKELETİ yönetilebiliyordu (slot üret/düzenle, gün kilidi,
  // hafta-doldur motoru, izin); v2'de yalnız ATAMA vardı — boş ızgaraya kişi
  // koymaya çalışıyorduk. Bu blok iskeleti geri getiriyor.
  const [plSekme, setPlSekme] = useState('');        // '' | slot | kilit | motor | izin
  const [plMesgul, setPlMesgul] = useState(false);
  const [plKilit, setPlKilit] = useState(null);      // {tarih, kilitli}
  const [plModal, setPlModal] = useState(null);      // {tip, ...}
  const [plMotor, setPlMotor] = useState(null);      // dry-run sonucu
  const [gkPin, setGkPin] = useState('');
  // Yeni/düzenlenen slot formu
  const BOS_SLOT = { sube_id: '', ad: '', tip: 'normal', baslangic_saat: '09:00',
    bitis_saat: '17:00', gece_vardiyasi: false, min_personel: 1, ideal_personel: 1,
    aktif_gunler: [1, 2, 3, 4, 5, 6, 7], aktif: true, sira: 0 };
  const [slotForm, setSlotForm] = useState(BOS_SLOT);
  // İzin formu
  const [izForm, setIzForm] = useState({ personel_id: '', baslangic_tarih: '', bitis_tarih: '', tip: 'mazeret', aciklama: '' });

  const plKilitYukle = useCallback((t) => {
    api(`/vardiya/v2/gun-kilit?tarih=${t}`)
      .then((d) => setPlKilit(d || null))
      .catch(() => setPlKilit(null));
  }, []);

  const slotKaydet = async () => {
    const f = slotForm;
    if (!f.sube_id) { onToast?.('Şube seçin'); return; }
    if (!String(f.ad || '').trim()) { onToast?.('Slot adı girin'); return; }
    if (!Array.isArray(f.aktif_gunler) || !f.aktif_gunler.length) { onToast?.('En az bir gün seçin'); return; }
    setPlMesgul(true);
    try {
      const govde = { ...f, ad: String(f.ad).trim(),
        min_personel: Math.max(0, Number(f.min_personel) || 0),
        ideal_personel: Math.max(0, Number(f.ideal_personel) || 0),
        sira: Number(f.sira) || 0 };
      if (f.id) {
        await api(`/vardiya/v2/slot/${f.id}`, { method: 'PUT', body: govde });
        onToast?.('✓ Slot güncellendi');
      } else {
        await api('/vardiya/v2/slot', { method: 'POST', body: govde });
        onToast?.('✓ Slot eklendi — plandaki tüm günlerde geçerli');
      }
      setPlModal(null); setSlotForm(BOS_SLOT); vpYukle(vpTarih);
    } catch (e) { onToast?.(e?.message || 'Slot kaydedilemedi'); }
    finally { setPlMesgul(false); }
  };

  const slotSil = async () => {
    const sl = plModal?.slot;
    if (!sl?.id) return;
    setPlMesgul(true);
    try {
      await api(`/vardiya/v2/slot/${sl.id}`, { method: 'DELETE' });
      onToast?.('✓ Slot silindi');
      setPlModal(null); vpYukle(vpTarih);
    } catch (e) { onToast?.(e?.message || 'Slot silinemedi'); }
    finally { setPlMesgul(false); }
  };

  /** Şubenin açılış-kapanış saatlerinden slot iskeleti üretir. */
  const slotUret = async () => {
    const m = plModal;
    if (!m?.sube_id) { onToast?.('Şube seçin'); return; }
    setPlMesgul(true);
    try {
      const r = await api('/vardiya/v2/slot/uret', { method: 'POST', body: {
        sube_id: m.sube_id, mod: m.mod || 'yenile',
        acilis_dakika: Number(m.acilis_dakika) || 60,
        kapanis_dakika: Number(m.kapanis_dakika) || 60,
        normal_slot_dakika: Number(m.normal_slot_dakika) || 120,
        hafta_ici: !!m.hafta_ici,
      } });
      onToast?.(`✓ Slot iskeleti üretildi${r?.uretilen != null ? ` — ${sayi(r.uretilen)} slot` : ''}`);
      setPlModal(null); vpYukle(vpTarih);
    } catch (e) { onToast?.(e?.message || 'Üretim başarısız'); }
    finally { setPlMesgul(false); }
  };

  const gunKilitDegis = async (kilitli) => {
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/gun-kilit', { method: 'PUT', body: { tarih: vpTarih, kilitli, aciklama: null } });
      onToast?.(kilitli ? '✓ Gün kilitlendi — plan değişmez' : '✓ Gün kilidi açıldı');
      plKilitYukle(vpTarih); setPlModal(null);
    } catch (e) { onToast?.(e?.message || 'Kilit değiştirilemedi'); }
    finally { setPlMesgul(false); }
  };

  /** Geçmiş günlerin toplu kilidini açar — işletme PIN'i ister (sunucu doğrular). */
  const gecmisKilitAc = async () => {
    if (!gkPin.trim()) { onToast?.('PIN girin'); return; }
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/gecmis-kilit-ac', { method: 'POST', body: { pin: gkPin.trim() } });
      onToast?.('✓ Geçmiş kilitleri açıldı');
      setGkPin(''); plKilitYukle(vpTarih); setPlModal(null);
    } catch (e) { onToast?.(e?.message || 'PIN hatalı olabilir'); }
    finally { setPlMesgul(false); }
  };

  /** Hafta doldurma motoru. ÖNCE dry_run — veritabanı geri alınır, sonuç gösterilir. */
  const motorCalistir = async (gercek) => {
    setPlMesgul(true);
    try {
      const r = await api('/vardiya/v2/motor/hafta-doldur', { method: 'POST', body: {
        pazartesi, max_rounds: 120, tasima_izni: true, dry_run: !gercek,
      } });
      setPlMotor({ ...r, gercek });
      onToast?.(gercek ? '✓ Hafta dolduruldu' : 'Önizleme hazır — veritabanı değişmedi');
      if (gercek) { yukle(); vpYukle(vpTarih); }
    } catch (e) { onToast?.(e?.message || 'Motor çalışmadı'); }
    finally { setPlMesgul(false); }
  };

  // ── İZİN LİSTESİ + SİL (2026-07-31) ───────────────────────────────────────
  // Önceki turda izin EKLEME yazıldı ama listeleme/silme yoktu: yanlış girilen
  // izin ekranda görünmüyor ve kaldırılamıyordu. Yarım kalan iş tamamlandı.
  const [izinler, setIzinler] = useState(null);
  const [izSilModal, setIzSilModal] = useState(null);

  const izinlerYukle = useCallback(() => {
    api('/vardiya/v2/izin')
      .then((d) => setIzinler(Array.isArray(d) ? d : (Array.isArray(d?.satirlar) ? d.satirlar : [])))
      .catch(() => setIzinler([]));
  }, []);

  const izinSil = async () => {
    const iz = izSilModal;
    if (!iz?.id) return;
    setPlMesgul(true);
    try {
      await api(`/vardiya/v2/izin/${iz.id}`, { method: 'DELETE' });
      onToast?.('✓ İzin kaldırıldı — o günler yeniden planlanabilir');
      setIzSilModal(null);
      izinlerYukle(); vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'İzin silinemedi');
    } finally { setPlMesgul(false); }
  };

  const izinEkle = async () => {
    const f = izForm;
    if (!f.personel_id) { onToast?.('Personel seçin'); return; }
    if (!f.baslangic_tarih || !f.bitis_tarih) { onToast?.('Tarih aralığı girin'); return; }
    if (f.bitis_tarih < f.baslangic_tarih) { onToast?.('Bitiş, başlangıçtan önce olamaz'); return; }
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/izin', { method: 'POST', body: {
        personel_id: f.personel_id, baslangic_tarih: f.baslangic_tarih,
        bitis_tarih: f.bitis_tarih, tip: f.tip, aciklama: f.aciklama.trim() || null,
      } });
      onToast?.('✓ İzin kaydedildi — motor bu günlerde atama yapmaz');
      setIzForm({ personel_id: '', baslangic_tarih: '', bitis_tarih: '', tip: 'mazeret', aciklama: '' });
      vpYukle(vpTarih); izinlerYukle();
    } catch (e) { onToast?.(e?.message || 'İzin eklenemedi'); }
    finally { setPlMesgul(false); }
  };

  // ── FAZ 5c: serbest atama · preset · kısıt · hedef · kasıtlı boş ──────────
  const [sbForm, setSbForm] = useState({ personel_id: '', sube_id: '', baslangic_saat: '09:00', bitis_saat: '17:00', aciklama: '', override: false, kesinlestir: false });
  const [presetler, setPresetler] = useState(null);
  const [prForm, setPrForm] = useState({ kod: '', ad: '', bas_saat: '09:00', bit_saat: '17:00', gece_vardiyasi: false, sira: 0, aktif: true });
  const [ksPersonel, setKsPersonel] = useState('');
  const [ksVeri, setKsVeri] = useState(null);
  const [hdSube, setHdSube] = useState('');
  const [hdSayi, setHdSayi] = useState('');

  const presetYukle = useCallback(() => {
    api('/vardiya/v2/preset')
      .then((d) => setPresetler(Array.isArray(d) ? d : (d?.presetler || d?.satirlar || [])))
      .catch(() => setPresetler([]));
  }, []);

  const kisitYukle = useCallback((pid) => {
    if (!pid) { setKsVeri(null); return; }
    api(`/vardiya/v2/kisit/${pid}`)
      .then((d) => setKsVeri(d || {}))
      .catch(() => setKsVeri({}));
  }, []);

  /** Slot dışı, serbest saatli atama. Önce serbest slot hazırlanır. */
  const serbestAta = async () => {
    const f = sbForm;
    if (!f.personel_id || !f.sube_id) { onToast?.('Personel ve şube seçin'); return; }
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/serbest-slot-hazirla', { method: 'POST' });
      await api('/vardiya/v2/atama-serbest', { method: 'POST', body: {
        personel_id: f.personel_id, sube_id: f.sube_id, tarih: vpTarih,
        baslangic_saat: f.baslangic_saat, bitis_saat: f.bitis_saat,
        override: !!f.override, aciklama: f.aciklama.trim() || null,
        kesinlestir: !!f.kesinlestir,
      } });
      onToast?.('✓ Serbest saatli atama yapıldı');
      setSbForm((p) => ({ ...p, aciklama: '', override: false }));
      vpYukle(vpTarih); yukle();
    } catch (e) { onToast?.(e?.message || 'Atama başarısız — çakışma olabilir'); }
    finally { setPlMesgul(false); }
  };

  const presetKaydet = async () => {
    const f = prForm;
    if (!f.kod.trim() || !f.ad.trim()) { onToast?.('Kod ve ad girin'); return; }
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/preset', { method: 'POST', body: {
        kod: f.kod.trim(), ad: f.ad.trim(), bas_saat: f.bas_saat, bit_saat: f.bit_saat,
        gece_vardiyasi: !!f.gece_vardiyasi, renk: null, sira: Number(f.sira) || 0, aktif: true,
      } });
      onToast?.('✓ Preset kaydedildi');
      setPrForm({ kod: '', ad: '', bas_saat: '09:00', bit_saat: '17:00', gece_vardiyasi: false, sira: 0, aktif: true });
      presetYukle();
    } catch (e) { onToast?.(e?.message || 'Preset kaydedilemedi'); }
    finally { setPlMesgul(false); }
  };

  const presetSil = async (kod) => {
    setPlMesgul(true);
    try {
      await api(`/vardiya/v2/preset/${encodeURIComponent(kod)}`, { method: 'DELETE' });
      onToast?.('✓ Preset silindi'); presetYukle();
    } catch (e) { onToast?.(e?.message || 'Silinemedi'); }
    finally { setPlMesgul(false); }
  };

  const kisitKaydet = async () => {
    if (!ksPersonel) { onToast?.('Personel seçin'); return; }
    setPlMesgul(true);
    try {
      const k = ksVeri || {};
      await api(`/vardiya/v2/kisit/${ksPersonel}`, { method: 'PUT', body: {
        max_gunluk_saat: Number(k.max_gunluk_saat) || 9.5,
        max_haftalik_saat: Number(k.max_haftalik_saat) || 57,
        izinli_subeler: Array.isArray(k.izinli_subeler) ? k.izinli_subeler : [],
        yasak_subeler: Array.isArray(k.yasak_subeler) ? k.yasak_subeler : [],
        calisilabilir_saat_min: k.calisilabilir_saat_min || null,
        calisilabilir_saat_max: k.calisilabilir_saat_max || null,
        min_gecis_dk: Number(k.min_gecis_dk) || 30,
        vardiya_preset_json: k.vardiya_preset_json || {},
        gun_saat_kisitlari_json: k.gun_saat_kisitlari_json || {},
        yemek_sube_id: k.yemek_sube_id || null,
      } });
      onToast?.('✓ Kısıtlar kaydedildi — motor bunlara uyar');
    } catch (e) { onToast?.(e?.message || 'Kısıt kaydedilemedi'); }
    finally { setPlMesgul(false); }
  };

  const hedefKaydet = async () => {
    if (!hdSube) { onToast?.('Şube seçin'); return; }
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/sube-gun-hedef', { method: 'PUT', body: {
        sube_id: hdSube, tarih: vpTarih,
        hedef_personel: String(hdSayi).trim() === '' ? null : Number(hdSayi),
      } });
      onToast?.(String(hdSayi).trim() === '' ? '✓ Hedef kaldırıldı' : `✓ Hedef ${sayi(hdSayi)} kişi olarak kaydedildi`);
      vpYukle(vpTarih);
    } catch (e) { onToast?.(e?.message || 'Hedef kaydedilemedi'); }
    finally { setPlMesgul(false); }
  };

  /** "Bu kişi bugün bilerek boş" — eksik uyarısı üretmesin diye. */
  const kasitliBos = async (pid, deger) => {
    setPlMesgul(true);
    try {
      await api('/vardiya/v2/personel-gun', { method: 'PUT', body: { personel_id: pid, tarih: vpTarih, kasitli_bos: !!deger } });
      onToast?.(deger ? '✓ Bugün bilerek boş işaretlendi' : '✓ İşaret kaldırıldı');
      vpYukle(vpTarih);
    } catch (e) { onToast?.(e?.message || 'İşaretlenemedi'); }
    finally { setPlMesgul(false); }
  };

  // ── İŞ BAŞVURULARI EYLEMLERİ (Faz 8, 2026-07-31) ──────────────────────────
  // v2 başvuruları GÖSTERİYORDU, hiçbirine dokunamıyordu: durum verilemiyor,
  // öncelik işaretlenemiyor, arşivlenemiyor, işe alınamıyordu (7/7 eksik).
  const [bvModal, setBvModal] = useState(null);   // {tip, basvuru?, ...}
  const [bvMesgul, setBvMesgul] = useState(false);
  const [bvSecim, setBvSecim] = useState([]);     // toplu arşiv için id listesi

  const bvUygula = async () => {
    const m = bvModal;
    if (!m) return;
    setBvMesgul(true);
    try {
      const bid = m.basvuru?.id;
      if (m.tip === 'durum') {
        await api(`/is-basvurusu/${bid}/durum`, { method: 'PATCH', body: { durum: m.durum } });
        onToast?.(`✓ Durum «${BV_DURUM_AD[m.durum] || m.durum}» yapıldı`);
      } else if (m.tip === 'oncelik') {
        await api(`/is-basvurusu/${bid}/oncelik`, { method: 'PATCH', body: { oncelik: Number(m.oncelik) || 0 } });
        onToast?.(Number(m.oncelik) ? `✓ ${m.oncelik}. öncelik işaretlendi` : '✓ Öncelik kaldırıldı');
      } else if (m.tip === 'arsiv') {
        await api(`/is-basvurusu/${bid}/arsiv`, { method: 'PATCH', body: { arsivli: !!m.arsivli } });
        onToast?.(m.arsivli ? '✓ Arşivlendi — durum ve öncelik korundu' : '✓ Arşivden çıkarıldı');
      } else if (m.tip === 'toplu-arsiv') {
        const r = await api('/is-basvurusu/toplu-arsiv', { method: 'POST', body: { ids: bvSecim, arsivli: true } });
        onToast?.(`✓ ${sayi(r?.guncellenen ?? bvSecim.length)} başvuru arşivlendi`);
        setBvSecim([]);
      } else if (m.tip === 'ise-al') {
        const r = await api(`/is-basvurusu/${bid}/ise-al`, { method: 'POST', body: { gorev: (m.gorev || '').trim() || null } });
        onToast?.(r?.zaten_alinmis ? 'Bu kişi zaten işe alınmış — personel kaydı var' : '✓ İşe alındı, personel kaydı açıldı');
      } else if (m.tip === 'sil') {
        await api(`/is-basvurusu/${bid}`, { method: 'DELETE' });
        onToast?.('✓ Başvuru silindi');
      }
      setBvModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setBvMesgul(false); }
  };

  /** Başvuruyu açarken okundu damgası — sessiz, hata yutulur (izleme verisi). */
  const bvGor = (b) => {
    if (b?.id && !b.goruldu) api(`/is-basvurusu/${b.id}/gor`, { method: 'PATCH' }).catch(() => {});
  };

  useEffect(yukle, []);

  // Merkez mutasyon anahtarı — sunucuda EVVEL_MERKEZ_MUTASYON_ANAHTARI tanımlıysa
  // PIN/yönetici değişikliği için gerekir; tarayıcıda saklanır (klasikteki gibi).
  useEffect(() => {
    try { setMerkezKey((localStorage.getItem('evvelMerkezMutasyonKey') || '').trim()); } catch { /* yok */ }
  }, []);

  // QR kartları görünüme girilince yüklenir (ana yüke ek yük bindirmesin).
  useEffect(() => {
    if (gorunum === 'pinqr' && qrListe === null) qrYukle();
  }, [gorunum]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── BORDRO YERLİ AKIŞ ──────────────────────────────────────────────────────
  const bAc = (tip, b) => {
    if (tip === 'gecmis') {
      setBGecmis({ ad: b.ad_soyad, satirlar: null });
      api(`/personel-aylik/${b.personel_id}/gecmis`)
        .then((d) => setBGecmis({ ad: b.ad_soyad, satirlar: Array.isArray(d) ? d : [] }))
        .catch(() => setBGecmis({ ad: b.ad_soyad, satirlar: [] }));
      return;
    }
    setBModal({
      tip, b,
      form: {
        calisma_saati: b.calisma_saati ?? '',
        fazla_mesai_saat: b.fazla_mesai_saat ?? '',
        bayram_mesai_saat: b.bayram_mesai_saat ?? '',
        eksik_gun: b.eksik_gun ?? '',
        raporlu_gun: b.raporlu_gun ?? '',
        rapor_kesinti: !!b.rapor_kesinti,
        manuel_duzeltme: b.manuel_duzeltme ?? '',
        not_aciklama: b.not_aciklama || '',
      },
    });
  };

  const bYap = async () => {
    const { tip, b, form } = bModal || {};
    if (!tip) return;
    const pid = b.personel_id;
    const q = `yil=${yil}&ay=${ay}`;
    setBMesgul(true);
    try {
      if (tip === 'doldur') {
        const r = await api(`/personel-aylik/${pid}/vardiya-aktar?${q}`, { method: 'POST' });
        onToast?.(`✓ Vardiya aktarıldı — net ${fmt(sayi(r?.hesaplanan_net))}`);
      } else if (tip === 'kaydet') {
        const r = await api(`/personel-aylik/${pid}?${q}`, {
          method: 'POST',
          body: {
            calisma_saati: sayi(form.calisma_saati),
            fazla_mesai_saat: sayi(form.fazla_mesai_saat),
            bayram_mesai_saat: sayi(form.bayram_mesai_saat),
            eksik_gun: sayi(form.eksik_gun),
            raporlu_gun: sayi(form.raporlu_gun),
            rapor_kesinti: !!form.rapor_kesinti,
            manuel_duzeltme: sayi(form.manuel_duzeltme),
            not_aciklama: (form.not_aciklama || '').trim() || null,
          },
        });
        onToast?.(`✓ Kaydedildi — net ${fmt(sayi(r?.hesaplanan_net))}`);
      } else if (tip === 'onayla') {
        await api(`/personel-aylik/${pid}/onayla?${q}`, { method: 'POST' });
        onToast?.('✓ Onaylandı — tutar kilitlendi, ödeme açıldı');
      } else if (tip === 'ode') {
        if (!b.odeme_id) throw new Error('Ödeme planı yok — önce onayla');
        await api(`/odeme-plani/${b.odeme_id}/ode`, { method: 'POST', body: { odeme_yontemi: 'nakit' } });
        onToast?.('💰 Ödendi — kasadan düşüldü');
      } else if (tip === 'kilit') {
        await api(`/personel-aylik/${pid}/kilit-ac?${q}`, { method: 'POST' });
        onToast?.('🔓 Kilit açıldı — düzeltip tekrar onayla');
      } else if (tip === 'sil') {
        await api(`/personel-aylik/${pid}?${q}`, { method: 'DELETE' });
        onToast?.('Kayıt silindi — taslağa döndü');
      }
      setBModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally {
      setBMesgul(false);
    }
  };

  /** Bordronun AŞAMASINA göre açık kapılar — kapalı olan düğme hiç görünmez. */
  const bordroAksiyonlari = (b) => {
    const d = String(b.durum || 'taslak');
    const A = [];
    if (d === 'odendi') {
      A.push({ ad: '🕘 Geçmiş aylar', onTikla: () => bAc('gecmis', b) });
      return A;
    }
    if (d === 'onayli') {
      A.push({ ad: '💰 Öde (kasadan düş)', birincil: true, onTikla: () => bAc('ode', b) });
      A.push({ ad: '🔓 Kilidi aç', onTikla: () => bAc('kilit', b) });
      A.push({ ad: '🕘 Geçmiş aylar', onTikla: () => bAc('gecmis', b) });
      return A;
    }
    A.push({ ad: '✓ Onayla (tutarı kilitle)', birincil: true, onTikla: () => bAc('onayla', b) });
    A.push({ ad: '🗓 Vardiyadan doldur', onTikla: () => bAc('doldur', b) });
    A.push({ ad: '✎ Düzelt & kaydet', onTikla: () => bAc('kaydet', b) });
    A.push({ ad: '🕘 Geçmiş aylar', onTikla: () => bAc('gecmis', b) });
    A.push({ ad: '🗑 Kaydı sil', onTikla: () => bAc('sil', b) });
    return A;
  };

  // ── PANEL PIN YERLİ AKIŞ ───────────────────────────────────────────────────
  const yoneticiVar = pinler.some((p) => p.yonetici);
  /** Yönetici varsa değişiklik için yönetici kimliği + PIN'i şarttır (klasik kural). */
  const pinOnayGovde = () => {
    if (!yoneticiVar) return {};
    return { onaylayan_personel_id: (pinOnay.id || '').trim(), onaylayan_pin: (pinOnay.pin || '').trim() };
  };
  const pinOnayGecerli = () => {
    if (!yoneticiVar) return true;
    const ok = (pinOnay.id || '').trim() && /^\d{4}$/.test((pinOnay.pin || '').trim());
    if (!ok) onToast?.('Önce onaylayan yöneticiyi seçip 4 haneli PIN\'ini girin');
    return !!ok;
  };

  const pinKaydet = async () => {
    const pin = (pinModal?.pin || '').trim();
    if (!/^\d{4}$/.test(pin)) { onToast?.('4 haneli PIN girin'); return; }
    if (!pinOnayGecerli()) return;
    setPinMesgul(true);
    try {
      await api(`/sube-panel/merkez/personel/${encodeURIComponent(pinModal.id)}/panel-pin`, {
        method: 'PUT', body: { pin, ...pinOnayGovde() },
      });
      onToast?.('✓ PIN kaydedildi — tüm şube panellerinde geçerli');
      setPinModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'PIN kaydedilemedi');
    } finally { setPinMesgul(false); }
  };

  const yoneticiDegistir = async (p, yonetici) => {
    if (!pinOnayGecerli()) return;
    setPinMesgul(true);
    try {
      await api(`/sube-panel/merkez/personel/${encodeURIComponent(p.id)}/panel-yonetici`, {
        method: 'PUT', body: { yonetici, ...pinOnayGovde() },
      });
      onToast?.(yonetici ? '✓ Yönetici işaretlendi' : '✓ Yönetici kaldırıldı');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setPinMesgul(false); }
  };

  const merkezKeyKaydet = () => {
    try {
      const v = (merkezKey || '').trim();
      if (v) localStorage.setItem('evvelMerkezMutasyonKey', v);
      else localStorage.removeItem('evvelMerkezMutasyonKey');
      onToast?.(v ? '✓ Merkez anahtarı bu tarayıcıda saklandı' : 'Anahtar silindi');
    } catch {
      onToast?.('Tarayıcı deposu kullanılamıyor');
    }
  };

  // ── QR + ŞUBE KONUMU YERLİ AKIŞ ────────────────────────────────────────────
  const qrYukle = () => {
    Promise.all([
      api('/gorev/qr-liste').catch(() => []),
      api('/subeler').catch(() => []),
    ]).then(([qr, sb]) => {
      const detay = Object.fromEntries((sb || []).map((s) => [s.id, s]));
      setQrListe((Array.isArray(qr) ? qr : []).map((s) => ({
        ...s,
        lat: detay[s.sube_id]?.lat ?? null,
        lng: detay[s.sube_id]?.lng ?? null,
        konum_radius_m: detay[s.sube_id]?.konum_radius_m ?? 150,
      })));
    }).catch(() => setQrListe([]));
  };

  const konumKaydet = async () => {
    const lat = parseFloat(qrModal?.lat), lng = parseFloat(qrModal?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { onToast?.('Enlem/boylam eksik'); return; }
    setQrMesgul(true);
    try {
      await api(`/gorev/sube-konum/${qrModal.sube_id}`, {
        method: 'PUT',
        body: { lat, lng, konum_radius_m: parseInt(qrModal.radius, 10) || 150 },
      });
      onToast?.(`✓ ${qrModal.sube_ad} konumu kaydedildi (±${parseInt(qrModal.radius, 10) || 150}m)`);
      setQrModal(null);
      qrYukle();
    } catch (e) {
      onToast?.(e?.message || 'Konum kaydedilemedi');
    } finally { setQrMesgul(false); }
  };

  const vpYukle = (tarih) => {
    setVpHata('');
    const t = tarih || vpTarih;
    api(`/vardiya/v2/gun?tarih=${t}`)
      .then((d) => setVpGun(d || {}))
      .catch((e) => setVpHata(e?.message || ''));
  };

  const vpGunDegis = (n) => {
    const y = isoEkle(vpTarih, n);
    setVpTarih(y);
    vpYukle(y);
    plKilitYukle(y);
  };

  /** Atama kapısı: önce check (çakışma=kesin engel), sonra assign. */
  const vpAta = async (zorla = false) => {
    const m = vpAtaModal;
    if (!m?.personelId) { onToast?.('Personel seçin'); return; }
    setVpMesgul('ata');
    try {
      const body = {
        personel_id: m.personelId, slot_id: m.slot.id, tarih: vpTarih,
        override: zorla, otomatik_saat_cozumu: true,
      };
      if (!zorla) {
        const c = await api('/vardiya/v2/atama/check', { method: 'POST', body });
        const uyarilar = Array.isArray(c?.uyarilar) ? c.uyarilar : [];
        if (c?.cakisma_var === true) {
          setVpAtaModal((f) => ({ ...f, uyari: 'Bu personel aynı saatte başka bir slotta atanmış — çakışma engeldir.', override: false }));
          setVpMesgul('');
          return;
        }
        if (c?.override_gerekir === true || uyarilar.length) {
          const metin = uyarilar.map((u) => (typeof u === 'string' ? u : (u.mesaj || u.aciklama || ''))).filter(Boolean).join(' · ');
          // personel_gun: sunucu o günün SAAT BÜTÇESİNİ de gönderiyor
          // (main.py:10936). v2 yalnız uyarı metnini gösteriyordu; "kaç saat
          // kaldı" bilgisi olmadan yönetici override kararını körlemesine
          // veriyordu. Sayıyı uyarının yanına koyuyoruz — hüküm yine insanın.
          const g = c?.personel_gun || null;
          const butce = g && g.kalan_saat != null
            ? `Bugün ${trSayi(sayi(g.toplam_saat))} sa atanmış (${sayi(g.atama_sayisi)} slot) · günlük sınır ${trSayi(sayi(g.max_gunluk_saat))} sa · kalan ${trSayi(sayi(g.kalan_saat))} sa`
            : '';
          setVpAtaModal((f) => ({
            ...f,
            uyari: metin || 'Bu atama için uyarı var.',
            butce,
            kritikVar: c?.kritik_var === true,
            override: true,
          }));
          setVpMesgul('');
          return;
        }
      }
      await api('/vardiya/v2/assign', { method: 'POST', body });
      onToast?.('✓ Vardiya atandı');
      setVpAtaModal(null);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Atama yapılamadı');
    } finally {
      setVpMesgul('');
    }
  };

  const vpAtamaSil = async (atamaId, ad) => {
    setVpMesgul(atamaId);
    try {
      await api(`/vardiya/v2/atama/${atamaId}`, { method: 'DELETE' });
      onToast?.(`${ad || 'Atama'} kaldırıldı`);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Kaldırılamadı');
    } finally {
      setVpMesgul('');
    }
  };

  const vpGunTemizle = async () => {
    setVpMesgul('temizle');
    try {
      await api(`/vardiya/v2/gun-temizle?tarih=${vpTarih}`, { method: 'POST' });
      onToast?.(`${kisaTarih(vpTarih)} planı temizlendi`);
      setVpKopyaModal(null);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Temizlenemedi');
    } finally {
      setVpMesgul('');
    }
  };

  const vpGunKopyala = async (hedef) => {
    if (!hedef) { onToast?.('Hedef gün seçin'); return; }
    setVpMesgul('kopyala');
    try {
      await api(`/vardiya/v2/gun-kopyala?kaynak=${vpTarih}&hedef=${hedef}&temizle=true`, { method: 'POST' });
      onToast?.(`${kisaTarih(vpTarih)} planı ${kisaTarih(hedef)} gününe kopyalandı`);
      setVpKopyaModal(null);
    } catch (e) {
      onToast?.(e?.message || 'Kopyalanamadı');
    } finally {
      setVpMesgul('');
    }
  };

  useEffect(() => {
    if (gorunum === 'vardiya') vpYukle(vpTarih);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  /**
   * Kişi bazlı RİSK SİNYALİ dökümü (/ops/personel-risk-sinyal) — v2 bu ucu HİÇ
   * çağırmıyordu. Davranış tablosu AGREGAT gösteriyor ("4 açılışta 340₺ fark");
   * bu uç o toplamın ARKASINDAKİ olayları ve varsa TAKİP kaydını getirir.
   * Tıklama anında çekilir (liste yüklenirken 200 kişi için çekmek anlamsız).
   */
  const riskSinyalAc = async (p) => {
    if (!p?.personel_id) { onToast?.('Bu satırda personel kimliği yok.'); return; }
    let d = null;
    try {
      d = await api(`/ops/personel-risk-sinyal?personel_id=${encodeURIComponent(p.personel_id)}&gun=45`);
    } catch (e) {
      onToast?.(e?.message || 'Risk sinyali okunamadı');
      return;
    }
    const satirlar = Array.isArray(d?.satirlar) ? d.satirlar : [];
    const takip = d?.takip || null;
    const sev = takip ? (TAKIP_SEVIYE[takip.takip_seviyesi] || TAKIP_SEVIYE.izlemede) : null;
    const agirlikToplam = satirlar.reduce((s, x) => s + sayi(x.agirlik), 0);
    // Kişi tepki ikizleri (soru 6/9): /ops/metrics/personel-verimlilik'ten bu
    // personelin kontrol cevap hızı + açılış sapması — zincir ortalamasıyla
    // kıyaslı. Veri yoksa KPI hiç eklenmez ("0 dk" sahte güven vermesin).
    const pid = String(p.personel_id);
    const vKontrol = (pdVerim?.kontrol_cevap_hizi || []).find((x) => String(x.personel_id) === pid) || null;
    const vAcilis = (pdVerim?.acilis_saati_sapmasi || []).find((x) => String(x.personel_id) === pid) || null;
    const zincirKontrol = pdVerim?.kontrol_cevap_ort_dk;
    const zincirAcilis = pdVerim?.acilis_sapma_ort_dk;
    const verimKpi = [];
    if (vKontrol && vKontrol.ort_cevap_dk != null) {
      const v = sayi(vKontrol.ort_cevap_dk);
      const z = zincirKontrol != null ? sayi(zincirKontrol) : null;
      verimKpi.push({
        etiket: 'Kontrol tepkisi',
        deger: `${trSayi(v)} dk`,
        alt: z != null ? `zincir ort. ${trSayi(z)} dk · ${sayi(vKontrol.ornek_sayi)} örnek` : `${sayi(vKontrol.ornek_sayi)} örnek`,
        renk: z != null && v > z * 1.5 ? R.kirmizi : z != null && v > z ? R.amber : R.yesil,
      });
    }
    if (vAcilis && vAcilis.ort_sapma_dk != null) {
      const v = sayi(vAcilis.ort_sapma_dk);
      const z = zincirAcilis != null ? sayi(zincirAcilis) : null;
      verimKpi.push({
        etiket: 'Açılış sapması',
        deger: `${v > 0 ? '+' : ''}${trSayi(v)} dk`,
        alt: z != null ? `zincir ort. ${z > 0 ? '+' : ''}${trSayi(z)} dk · ${sayi(vAcilis.ornek_sayi)} örnek` : `${sayi(vAcilis.ornek_sayi)} örnek`,
        renk: v > 15 ? R.kirmizi : v > 5 ? R.amber : R.yesil,
      });
    }
    onCekmece?.({
      tip: 'RİSK SİNYALİ · OLAY DÖKÜMÜ',
      baslik: p.personel_ad || 'Personel',
      alt: `${p.sube_adi || '—'} · son ${sayi(d?.gun_sayi) || 45} gün · ${satirlar.length} sinyal`,
      kpi: [
        { etiket: 'Sinyal', deger: String(satirlar.length), renk: satirlar.length ? R.amber : R.yesil },
        { etiket: 'Ağırlık toplamı', deger: String(agirlikToplam), renk: agirlikToplam > 10 ? R.kirmizi : R.krem },
        { etiket: 'Davranış skoru', deger: sayi(p.davranis_risk_skoru) ? trSayi(sayi(p.davranis_risk_skoru)) : '—', renk: R.amber },
        {
          etiket: 'Takip',
          deger: sev ? sev.ad : 'yok',
          renk: sev ? sev.renk : R.yesil,
        },
        ...verimKpi,
      ],
      listeBaslik: 'Sinyaller · yeniden eskiye',
      satirlar: satirlar.slice(0, 40).map((s) => {
        const t = RISK_SINYAL[s.sinyal_turu] || { ad: s.sinyal_turu || 'sinyal' };
        return {
          ad: `${kisaTarih(s.tarih)} · ${t.ad}`,
          detay: s.aciklama || '—',
          tutar: `ağırlık ${sayi(s.agirlik)}`,
        };
      }),
      not: takip
        ? `⚠ TAKİP KAYDI VAR — ${sev?.ad || takip.takip_seviyesi} · ${kisaTarih(takip.takip_baslangic)} tarihinden beri.`
          + (takip.tetikleyen_sinyal ? ` Tetikleyen: ${takip.tetikleyen_sinyal}.` : '')
          + (takip.notlar ? ` Not: ${takip.notlar}` : '')
          + ' Bu ekran GÖZLEM toplar; disiplin kararı sahibindir.'
        : (satirlar.length
          ? 'Bu personel için açılmış bir takip kaydı YOK — sinyaller gözlem olarak duruyor. Puan/risk maaşa ya da avansa bağlanmaz.'
          : 'Son 45 günde risk sinyali üretilmemiş.'),
    });
  };

  const pdYukle = () => {
    setPdHata('');
    const ym = `${donem.yil}-${String(donem.ay).padStart(2, '0')}`;
    api('/ops/personel-davranis-analiz?gun=45')
      .then((d) => setPdDavranis(d || {}))
      .catch((e) => setPdHata(e?.message || ''));
    api('/ops/sube-personel-puan')
      .then((d) => setPdPuan(d || {}))
      .catch(() => setPdPuan({}));
    api(`/ops/gec-kalan-personel?year_month=${ym}`)
      .then((d) => setPdGec(d || {}))
      .catch(() => setPdGec({}));
    api('/ops/kasa-acik-analiz?gun_sayi=30')
      .then((d) => setPdKasa(d || {}))
      .catch(() => setPdKasa({}));
    api('/ops/kasiyer-karne?gun=30')
      .then((d) => setPdKarne(Array.isArray(d?.karne) ? d.karne : []))
      .catch(() => setPdKarne([]));
    // Kişi verimlilik ikizleri (soru 6/9) — davranış tablosuyla aynı 45 gün
    api('/ops/metrics/personel-verimlilik?gun=45')
      .then((d) => setPdVerim(d || null))
      .catch(() => setPdVerim(null));
  };

  useEffect(() => {
    if (gorunum === 'denetim') pdYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum, donem.yil, donem.ay]);

  // ── personel formu (klasik Personel.jsx sözleşmesi) ────────────────────────
  const pFormAc = (p) => {
    setPForm(p ? {
      duzenleId: p.id, ad_soyad: p.ad_soyad || '', gorev: p.gorev || '',
      calisma_turu: p.calisma_turu || 'surekli', maas: p.maas ?? '',
      saatlik_ucret: p.saatlik_ucret ?? '', yemek_ucreti: p.yemek_ucreti ?? '',
      yol_ucreti: p.yol_ucreti ?? '', sube_id: p.sube_id || '',
      baslangic_tarihi: String(p.baslangic_tarihi || '').slice(0, 10),
      telefon: p.telefon || '', notlar: p.notlar || '',
    } : {
      duzenleId: null, ad_soyad: '', gorev: '', calisma_turu: 'surekli', maas: '',
      saatlik_ucret: '', yemek_ucreti: '', yol_ucreti: '', sube_id: '',
      baslangic_tarihi: '', telefon: '', notlar: '',
    });
    if (!subeListe.length) api('/subeler').then((d) => setSubeListe(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const pKaydet = async () => {
    const f = pForm;
    if (!(f?.ad_soyad || '').trim()) { onToast?.('Ad soyad zorunlu'); return; }
    setPMesgul(true);
    try {
      const body = {
        ad_soyad: f.ad_soyad.trim(), gorev: f.gorev || null,
        calisma_turu: f.calisma_turu, maas: f.maas ? Number(f.maas) : 0,
        saatlik_ucret: f.saatlik_ucret ? Number(f.saatlik_ucret) : 0,
        yemek_ucreti: f.yemek_ucreti ? Number(f.yemek_ucreti) : 0,
        yol_ucreti: f.yol_ucreti ? Number(f.yol_ucreti) : 0,
        odeme_gunu: 1, sube_id: f.sube_id || null,
        baslangic_tarihi: f.baslangic_tarihi || null,
        notlar: f.notlar || null, telefon: (f.telefon || '').trim() || null,
      };
      if (f.duzenleId) await api(`/personel/${f.duzenleId}`, { method: 'PUT', body });
      else await api('/personel', { method: 'POST', body });
      onToast?.(f.duzenleId ? '✓ Personel güncellendi' : '✓ Personel eklendi');
      setPForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setPMesgul(false);
    }
  };

  // ── PERSONEL SİL + VARDİYA SYNC (2026-07-31) ──────────────────────────────
  // Tam grep: /cikis ZATEN vardı (dokunulmadı); DELETE /personel/{id} ve
  // POST /personel-aylik/vardiya-sync v2'de HİÇ yoktu.

  /** Kalıcı silme — çıkıştan FARKLI: çıkış pasife alır, bu kaydı yok eder. */
  const personelSil = async () => {
    if (!silForm?.id) return;
    setPMesgul(true);
    try {
      await api(`/personel/${silForm.id}`, { method: 'DELETE' });
      onToast?.(`${silForm.ad} kaydı silindi`);
      setSilForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Silinemedi — geçmiş kaydı olan personel silinemeyebilir');
    } finally { setPMesgul(false); }
  };

  /** Seçili dönemin vardiya verisini aylık maaş + ödeme planına senkronlar. */
  const vardiyaSync = async () => {
    setPMesgul(true);
    try {
      const r = await api(`/personel-aylik/vardiya-sync?yil=${donem.yil}&ay=${donem.ay}`, { method: 'POST' });
      onToast?.(`✓ ${donem.ay}/${donem.yil} vardiya verisi aktarıldı${r?.guncellenen != null ? ` — ${sayi(r.guncellenen)} kayıt` : ''}`);
      setSyncOnay(false);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Senkronizasyon başarısız');
    } finally { setPMesgul(false); }
  };

  const cikisYap = async () => {
    if (!cikisForm?.id) return;
    setPMesgul(true);
    try {
      // Adres şablonunun İÇİNDE tırnak bırakma: denetim betiğinin çıkarıcısı
      // `${... || ''}` gördüğünde şablonu okuyamıyor, uç "v2'de yok" görünüyor.
      // Değeri önce hesapla, şablona sade değişken koy.
      const neden = encodeURIComponent(cikisForm.neden || '');
      await api(`/personel/${cikisForm.id}/cikis?neden=${neden}`, { method: 'POST' });
      onToast?.(`${cikisForm.ad} işten çıkış kaydı yapıldı`);
      setCikisForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Çıkış kaydedilemedi');
    } finally {
      setPMesgul(false);
    }
  };

  // Dönem/gün değişince yalnız İLGİLİ uçlar tazelenir — tam ekran yükleme yok.
  const ayDegistir = (d) => {
    setDonem(({ yil: y0, ay: a0 }) => {
      let a = a0 + d; let y = y0;
      if (a < 1) { a = 12; y -= 1; }
      if (a > 12) { a = 1; y += 1; }
      if (y > buYil || (y === buYil && a > buAy)) return { yil: y0, ay: a0 }; // geleceğe gitme
      setDonemYukleniyor(true);
      Promise.all([
        api(`/personel-aylik?yil=${y}&ay=${a}`).catch(() => []),
        api(`/gorev/vardiya-takip?yil=${y}&ay=${a}`).catch(() => null),
      ]).then(([b, vt]) => {
        setBordro(b);
        setTakip(Array.isArray(vt) ? vt : (vt?.personeller || []));
        setDonemYukleniyor(false);
      });
      return { yil: y, ay: a };
    });
  };
  const gorevGunDegistir = (d) => {
    setGorevTarih((t0) => {
      const dt = new Date(t0 + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + d);
      const t = dt.toISOString().slice(0, 10);
      if (t > bugun) return t0; // geleceğe gitme
      setDonemYukleniyor(true);
      api(`/gorev/ozet?tarih=${t}`).catch(() => [])
        .then((go) => { setGorevOzet(Array.isArray(go) ? go : []); setDonemYukleniyor(false); });
      return t;
    });
  };

  /** ‹ dönem › gezgini — maaş/takip (ay) ve görev (gün) görünümlerinde. */
  const DonemSecici = ({ etiket, onGeri, onIleri, ileriKapali }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <button onClick={onGeri} style={{
        width: 30, height: 30, borderRadius: 9, border: `1px solid ${R.cizgi3}`,
        background: R.girinti, color: R.metin2, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer',
      }}>‹</button>
      <span style={{
        padding: '6px 14px', borderRadius: 99, fontSize: 12.5, fontWeight: 700,
        background: `${R.bakir}18`, color: R.bakir, border: `1px solid ${R.bakir}44`,
        fontFamily: F.mono, minWidth: 96, textAlign: 'center',
      }}>
        {donemYukleniyor ? '…' : etiket}
      </span>
      <button onClick={onIleri} disabled={ileriKapali} style={{
        width: 30, height: 30, borderRadius: 9, border: `1px solid ${R.cizgi3}`,
        background: R.girinti, color: ileriKapali ? R.not3 : R.metin2, fontSize: 14,
        fontFamily: 'inherit', cursor: ileriKapali ? 'default' : 'pointer', opacity: ileriKapali ? 0.5 : 1,
      }}>›</button>
      {ileriKapali && <span style={{ fontSize: 10.5, color: R.not3 }}>güncel dönem</span>}
    </div>
  );

  /** Vardiya takibindeki kişi bazlı toplamları personel id ile eşler. */
  const takipMap = useMemo(() => {
    const m = {};
    (takip || []).forEach(t => { m[String(t.personel_id)] = t; });
    return m;
  }, [takip]);

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Ekip verileri yükleniyor…</div>;
  }
  if (hata) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{hata}</div>
        <button onClick={yukle} style={{
          marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>Tekrar dene</button>
      </div>
    );
  }

  // ── ortak: personel dosyası çekmecesi ──────────────────────────────────────
  const personelAc = (p) => {
    const t = takipMap[String(p.id)] || {};
    const bd = bordro.find(x => String(x.personel_id) === String(p.id)) || {};
    const kd = kidemAy(p.baslangic_tarihi);
    onCekmece?.({
      tip: 'PERSONEL DOSYASI',
      baslik: p.ad_soyad,
      alt: `${p.gorev || 'görev girilmemiş'} · ${p.sube_adi || 'şube atanmamış'}`,
      kpi: [
        { etiket: 'Kıdem', deger: kd == null ? '—' : `${kd} ay` },
        { etiket: 'Bu ay saat', deger: t.toplam_planlanan_saat != null ? `${trSayi(t.toplam_planlanan_saat, 0)} sa` : '—' },
        { etiket: 'Fazla mesai', deger: t.toplam_fazla_mesai_saat ? `${trSayi(t.toplam_fazla_mesai_saat)} sa` : '—', renk: sayi(t.toplam_fazla_mesai_saat) > 0 ? R.kirmizi : R.krem },
        { etiket: 'Çalışma türü', deger: turAd(p.calisma_turu) },
      ],
      listeBaslik: 'Bu ay bordro',
      // ⚠️ Çekmece satır sözleşmesi: {ad, detay, tutar} — başka alan adı boş liste render eder.
      satirlar: [
        { ad: 'Ücret', detay: sayi(p.maas) > 0 ? 'aylık · sözleşme' : 'saatlik', tutar: ucretMetni(p) },
        { ad: 'Hesaplanan net', detay: bd.durum ? asamaAd(bd.durum) : 'kayıt yok', tutar: bd.hesaplanan_net != null ? fmt(bd.hesaplanan_net) : '—' },
        { ad: 'Avans mahsubu', detay: 'maaştan düşülen', tutar: fmt(sayi(bd.avans_mahsup)) },
        { ad: 'Gecikme', detay: 'bu ay toplam', tutar: t.toplam_gecikme_dk ? `${trSayi(t.toplam_gecikme_dk, 0)} dk` : '—' },
      ],
      not: kd != null && kd < 3
        ? 'Deneme süresinde — ilk 3 ay yakın takip edilir.'
        : 'Bordro hesabı maaş çekirdeğinden gelir; maaş onayı Maaş & Avans görünümünde.',
      aksiyonlar: [
        { ad: '✎ Bilgileri düzenle', birincil: true, onTikla: () => pFormAc(p) },
        { ad: 'İşten çıkış', onTikla: () => setCikisForm({ id: p.id, ad: p.ad_soyad, neden: '' }) },
        { ad: 'Kaydı sil', onTikla: () => setSilForm({ id: p.id, ad: p.ad_soyad }) },
      ],
    });
  };

  // ── personel formu + çıkış modalı (kadro görünümünde render edilir) ────────
  const personelModali = (
    <>
      {pForm && (() => {
        const alan = (k, v) => setPForm((f) => ({ ...f, [k]: v }));
        const partTime = pForm.calisma_turu === 'part_time';
        return (
          <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setPForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 560, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>
                  {pForm.duzenleId ? 'Personeli Düzenle' : 'Yeni Personel'}
                </div>
                <button onClick={() => !pMesgul && setPForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
                <div>
                  <label style={ekEtiket}>Ad soyad *</label>
                  <input value={pForm.ad_soyad} onChange={(e) => alan('ad_soyad', e.target.value)} style={ekAlanStil} />
                </div>
                <div>
                  <label style={ekEtiket}>Görev</label>
                  <input value={pForm.gorev} placeholder="barista, müdür…"
                    onChange={(e) => alan('gorev', e.target.value)} style={ekAlanStil} />
                </div>
                <div>
                  <label style={ekEtiket}>Çalışma türü</label>
                  <select value={pForm.calisma_turu} onChange={(e) => alan('calisma_turu', e.target.value)} style={ekAlanStil}>
                    <option value="surekli">Sürekli (aylık maaş)</option>
                    <option value="part_time">Part-time (saatlik)</option>
                  </select>
                </div>
                <div>
                  <label style={ekEtiket}>Şube</label>
                  <select value={pForm.sube_id} onChange={(e) => alan('sube_id', e.target.value)} style={ekAlanStil}>
                    <option value="">Merkez / atanmamış</option>
                    {subeListe.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                  </select>
                </div>
                <div>
                  <label style={ekEtiket}>{partTime ? 'Saatlik ücret (₺)' : 'Aylık maaş (₺)'}</label>
                  <input type="number" value={partTime ? pForm.saatlik_ucret : pForm.maas}
                    onChange={(e) => alan(partTime ? 'saatlik_ucret' : 'maas', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Başlangıç tarihi</label>
                  <input type="date" value={pForm.baslangic_tarihi} onChange={(e) => alan('baslangic_tarihi', e.target.value)}
                    style={{ ...ekAlanStil, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Yemek ücreti (₺)</label>
                  <input type="number" value={pForm.yemek_ucreti} onChange={(e) => alan('yemek_ucreti', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Yol ücreti (₺)</label>
                  <input type="number" value={pForm.yol_ucreti} onChange={(e) => alan('yol_ucreti', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Telefon</label>
                  <input value={pForm.telefon} onChange={(e) => alan('telefon', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono }} />
                </div>
                <div>
                  <label style={ekEtiket}>Not</label>
                  <input value={pForm.notlar} onChange={(e) => alan('notlar', e.target.value)} style={ekAlanStil} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: R.not, marginTop: 12, lineHeight: 1.5 }}>
                Maaş ödemesi ve bordro onayı Maaş & Avans görünümünde — burada yalnız kadro bilgisi tutulur.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={pMesgul} onClick={() => setPForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>İptal</button>
                <button disabled={pMesgul} onClick={pKaydet} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{pMesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {silForm && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setSilForm(null); }} style={{
          position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
          backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 430, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Personel kaydını sil</div>
            <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.7, marginBottom: 14 }}>
              <b>{silForm.ad}</b> kaydı tamamen silinir ve geri gelmez.
              <br /><br />İşten ayrılan biri için <b>«İşten çıkış»</b> doğru seçim —
              o pasife alır, bordro ve vardiya geçmişi durur. Silme yalnız
              <b> yanlış/mükerrer kayıt</b> içindir; geçmişi olan personel
              sunucuda silinemeyebilir.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button disabled={pMesgul} onClick={() => setSilForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={pMesgul} onClick={personelSil} style={{
                padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                fontFamily: 'inherit', border: `1px solid ${R.kirmizi}55`,
                background: `${R.kirmizi}26`, color: R.kirmizi,
              }}>{pMesgul ? 'İşleniyor…' : 'Kalıcı sil'}</button>
            </div>
          </div>
        </div>
      )}

      {syncOnay && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setSyncOnay(false); }} style={{
          position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
          backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 450, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
              Vardiya verisini maaşa aktar
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              <b>{donem.ay}/{donem.yil}</b> dönemi
            </div>
            <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.7, marginBottom: 14 }}>
              Seçili ayın vardiya kayıtları aylık maaş kayıtlarına ve ödeme planına
              işlenir. Vardiya planında sonradan değişiklik yaptıysan bordronun
              güncel olması için bunu çalıştır. <b>Onaylanmış/kilitli</b> bordrolar
              korunur.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button disabled={pMesgul} onClick={() => setSyncOnay(false)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={pMesgul} onClick={vardiyaSync} style={{
                padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                fontFamily: 'inherit', border: 'none',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
              }}>{pMesgul ? 'Aktarılıyor…' : 'Aktar'}</button>
            </div>
          </div>
        </div>
      )}

      {cikisForm && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setCikisForm(null); }} style={{
          position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
          backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>İşten Çıkış</div>
              <button onClick={() => !pMesgul && setCikisForm(null)} style={{
                marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
              <b>{cikisForm.ad}</b> pasife alınacak; kadrodan çıkar, geçmiş bordro kayıtları korunur.
            </div>
            <label style={ekEtiket}>Çıkış nedeni</label>
            <input value={cikisForm.neden} placeholder="istifa, dönem sonu…"
              onChange={(e) => setCikisForm((f) => ({ ...f, neden: e.target.value }))} style={ekAlanStil} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button disabled={pMesgul} onClick={() => setCikisForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={pMesgul} onClick={cikisYap} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{pMesgul ? 'İşleniyor…' : 'Çıkışı kaydet'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── 8) PERSONEL DENETİMİ (ops-merkez P2) ──────────────────────────────────
  // Klasik Operasyon Merkezi'nin 4 personel sekmesi tek yerde — ÖNERİ-ONLY,
  // isim verir ama hüküm vermez (puan maaşa bağlanmaz kuralı korunur).
  // ── FAZ 8: BAŞVURU YÖNETİM MODALI ─────────────────────────────────────────
  // Backend'de durum · öncelik · arşiv AYRI BOYUTLAR (biri diğerini ezmez).
  // Ekran da öyle: tek açılır liste değil, üç bağımsız denetim.
  const bvModalBlok = bvModal && (() => {
    const b = bvModal.basvuru || {};
    // Alt onaydan vazgecince YONETIM cekmecesine don, hepsini kapatma.
    const kapat = () => {
      if (bvMesgul) return;
      if (bvModal.tip !== 'yonet' && bvModal.tip !== 'toplu-arsiv' && b.id) setBvModal({ tip: 'yonet', basvuru: b });
      else setBvModal(null);
    };
    const dv = trKucuk(b.durum) || 'bekliyor';
    const onc = sayi(b.oncelik);

    if (bvModal.tip !== 'yonet') {
      const T = {
        'durum': { baslik: 'Durumu değiştir', anlat: `«${BV_DURUM_AD[bvModal.durum] || bvModal.durum}» yapılacak. Öncelik ve arşiv durumu DEĞİŞMEZ — ayrı boyutlar.`, tehlike: false, buton: 'Değiştir' },
        'oncelik': { baslik: 'Önceliği ayarla', anlat: 'Öncelik işareti durumu ve arşivi etkilemez; arşivdeyken de korunur.', tehlike: false, buton: 'Kaydet' },
        'arsiv': { baslik: bvModal.arsivli ? 'Arşivle' : 'Arşivden çıkar', anlat: bvModal.arsivli ? 'Listeden kalkar ama SİLİNMEZ — durum ve öncelik korunur, istediğinde geri çıkarırsın.' : 'Başvuru yeniden aktif listeye döner.', tehlike: false, buton: 'Onayla' },
        'toplu-arsiv': { baslik: 'Seçilenleri arşivle', anlat: `${bvSecim.length} başvuru arşive taşınır. Silinmez; durum ve öncelikleri korunur.`, tehlike: false, buton: 'Arşivle' },
        'ise-al': { baslik: 'İşe al', anlat: 'Başvurudan PERSONEL KAYDI açılır ve kişi kadroya girer. Bu kişi artık vardiya planına atanabilir, maaş motoruna dahil olur. Zaten alınmışsa yeni kayıt açılmaz.', tehlike: false, buton: 'İşe al' },
        'sil': { baslik: 'Başvuruyu sil', anlat: 'Kayıt tamamen silinir ve geri gelmez. Görüşmediğin birini elemek için ARŞİV daha doğru — silme yalnız hatalı/çöp kayıt içindir.', tehlike: true, buton: 'Kalıcı sil' },
      }[bvModal.tip] || {};
      return (
        <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
          position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
          backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 430, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{T.baslik}</div>
            {b.ad_soyad && <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}><b>{b.ad_soyad}</b>{b.pozisyon ? ` · ${b.pozisyon}` : ''}</div>}
            <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>
            {bvModal.tip === 'ise-al' && (
              <>
                <label style={ekEtiket}>Görev / pozisyon</label>
                <input value={bvModal.gorev ?? (b.pozisyon || '')} autoFocus
                  onChange={(e) => setBvModal((p) => ({ ...p, gorev: e.target.value }))} style={ekAlanStil} />
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
              <button disabled={bvMesgul} onClick={kapat} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={bvMesgul} onClick={bvUygula} style={{
                padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
                background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                color: T.tehlike ? R.kirmizi : '#1C1309',
              }}>{bvMesgul ? 'İşleniyor…' : T.buton}</button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 125, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 500, maxWidth: '96vw', padding: '24px 26px', maxHeight: '88vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>{b.ad_soyad || 'Başvuru'}</div>
            <button onClick={kapat} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>x</button>
          </div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 16, lineHeight: 1.7 }}>
            {[b.pozisyon, b.telefon, b.sube_tercihi || b.sube, b.ilce,
              b.dogum_yili ? `${b.dogum_yili} doğumlu` : null,
              b.olusturma ? kisaTarih(b.olusturma) : null].filter(Boolean).join(' · ')}
            {b.personel_id && <><br /><span style={{ color: R.yesil, fontWeight: 700 }}>✓ İşe alınmış — personel kaydı var</span></>}
          </div>

          <label style={ekEtiket}>Durum</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {['bekliyor', 'gorusme', 'olumlu', 'olumsuz'].map((d) => (
              <button key={d} onClick={() => setBvModal({ tip: 'durum', basvuru: b, durum: d })} style={{
                padding: '7px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600,
                border: `1px solid ${dv === d ? R.bakir : R.cizgi3}`,
                background: dv === d ? `${R.bakir}1E` : 'transparent',
                color: dv === d ? R.bakir : R.metin2,
              }}>{BV_DURUM_AD[d]}</button>
            ))}
          </div>

          <label style={ekEtiket}>Öncelik · durumu ve arşivi etkilemez</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {[[1, '★ Birinci'], [2, '☆ İkinci'], [0, 'Yok']].map(([v, ad]) => (
              <button key={v} onClick={() => setBvModal({ tip: 'oncelik', basvuru: b, oncelik: v })} style={{
                padding: '7px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600,
                border: `1px solid ${onc === v ? R.amber : R.cizgi3}`,
                background: onc === v ? `${R.amber}1E` : 'transparent',
                color: onc === v ? R.amber : R.metin2,
              }}>{ad}</button>
            ))}
          </div>

          <div style={{ borderTop: `1px solid ${R.cizgi3}`, paddingTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!b.personel_id && (
              <button onClick={() => setBvModal({ tip: 'ise-al', basvuru: b, gorev: b.pozisyon || '' })} style={{
                padding: '9px 18px', borderRadius: 9, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
              }}>İşe al</button>
            )}
            <button onClick={() => setBvModal({ tip: 'arsiv', basvuru: b, arsivli: !b.arsivli })} style={plBtn}>
              {b.arsivli ? 'Arşivden çıkar' : 'Arşivle'}
            </button>
            <button onClick={() => setBvModal({ tip: 'sil', basvuru: b })} style={{
              ...plBtn, marginLeft: 'auto', color: R.kirmizi, borderColor: `${R.kirmizi}44`,
            }}>Sil</button>
          </div>
        </div>
      </div>
    );
  })();

  if (gorunum === 'denetim') {
    if (pdHata) {
      return (
        <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
          <div style={{ fontSize: 13, color: R.kirmizi }}>Veri alınamadı — {pdHata}</div>
          <button onClick={pdYukle} style={{
            marginTop: 14, padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>🔄 Tekrar dene</button>
        </div>
      );
    }
    if (!pdDavranis) {
      return <div style={{ ...kartYuzey, padding: '40px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>Personel denetimi yükleniyor…</div>;
    }
    const davranis = Array.isArray(pdDavranis?.personel_ozet) ? pdDavranis.personel_ozet : [];
    // Sunucu ayrıca "sürekli riskli" kısa listesi gönderiyor (risk skoruna göre
    // sıralı) — v2 bunu hiç okumuyordu. Kritik rozetinin kaynağı budur.
    const surekliRiskli = Array.isArray(pdDavranis?.surekli_riskli_personel) ? pdDavranis.surekli_riskli_personel : [];
    const riskliIdler = new Set(surekliRiskli.map((p) => String(p.personel_id)));
    const puanlar = Array.isArray(pdPuan?.personeller) ? pdPuan.personeller : [];
    const gecSatir = Array.isArray(pdGec?.satirlar) ? pdGec.satirlar : [];
    const kasaSatir = Array.isArray(pdKasa?.personeller) ? pdKasa.personeller
      : (Array.isArray(pdKasa?.satirlar) ? pdKasa.satirlar : []);
    const karne = Array.isArray(pdKarne) ? pdKarne : [];
    const ALT = [
      ['davranis', `👤 Davranış (${davranis.length})`],
      ['puan', `🏅 Puan (${puanlar.length})`],
      ['gec', `⏰ Geç kalma (${gecSatir.length})`],
      ['kasa', `💵 Kasa açığı (${kasaSatir.length})`],
    ];
    const enDusukPuan = puanlar.length ? puanlar.reduce((a, b) => (sayi(a.puan) <= sayi(b.puan) ? a : b)) : null;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen personel', deger: String(davranis.length), alt: 'son 45 gün davranış', renk: R.krem },
          { etiket: 'Kritik geç kalma', deger: String(sayi(pdGec?.kritik_personel_sayisi)), alt: `${sayi(pdGec?.gecikme_toplam_adet)} gecikme · eşik ${sayi(pdGec?.kritik_dk)} dk`, renk: sayi(pdGec?.kritik_personel_sayisi) ? R.amber : R.yesil },
          { etiket: 'En düşük puan', deger: enDusukPuan ? String(sayi(enDusukPuan.puan)) : '—', alt: enDusukPuan ? enDusukPuan.ad_soyad : 'veri yok', renk: enDusukPuan && sayi(enDusukPuan.puan) < 70 ? R.kirmizi : R.krem },
          { etiket: 'Kasa açığı olan', deger: String(kasaSatir.length), alt: 'son 30 gün', renk: kasaSatir.length ? R.kirmizi : R.yesil },
        ]} />

        <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setPdSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${pdSekme === id ? R.bakir : R.cizgi3}`,
              color: pdSekme === id ? R.bakir : R.metin2,
              background: pdSekme === id ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {/* PIN hatası saat dağılımı (soru 6/9) — sunucu bunu KİŞİYE değil saat
            dilimine bağlar (kim olduğu bilinmez, o yüzden davranış tablosuna
            sütun olarak GİRMEZ). Hangi dilimde yoğunlaşıyor: gözlem verisi. */}
        {pdSekme === 'davranis' && (pdVerim?.pin_hata_saat_dagilimi || []).length > 0 && (() => {
          const dilimler = pdVerim.pin_hata_saat_dagilimi;
          const DILIM_AD = { sabah: '🌅 Sabah (05-10)', ogle: '☀️ Öğle (11-16)', aksam: '🌆 Akşam (17-22)', gece: '🌙 Gece (23-04)' };
          const toplam = dilimler.reduce((s, x) => s + sayi(x.adet), 0);
          return (
            <div style={{
              ...kartYuzey, padding: '11px 16px', marginBottom: 12,
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}>
              <span style={{
                padding: '3px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                background: 'rgba(217,154,78,.14)', color: R.amber, border: `1px solid ${R.amber}44`,
              }}>🔐 PIN hatası · {toplam}</span>
              {dilimler.map((x, i) => (
                <span key={x.dilim || i} style={{ fontSize: 11.5, color: R.metin2 }}>
                  {DILIM_AD[x.dilim] || x.dilim}{' '}
                  <b style={{ fontFamily: F.mono, color: sayi(x.adet) >= toplam / 2 ? R.kirmizi : R.krem }}>{sayi(x.adet)}</b>
                </span>
              ))}
              <span style={{ fontSize: 10.5, color: R.not3 }}>
                son 45 gün · kişiye bağlanamaz, saat dilimi gözlemi
              </span>
            </div>
          );
        })()}

        {pdSekme === 'davranis' && (davranis.length ? (
          <Tablo
            baslik="Davranış analizi · son 45 gün"
            not="gözlem toplamı — hüküm değil; puan maaşa bağlanmaz · satıra tıkla → olay dökümü"
            // 🐞 ŞEKİL TUZAĞI (düzeltildi): eski kolonlar `vardiya_sayisi`,
            // `gecikme_dk`, `kasa_fark` okuyordu — bu adlar BAŞKA uçlardan
            // (puan/geç/kasa) kopyalanmış, /ops/personel-davranis-analiz
            // cevabında YOK. Tablo hep "—"/0 gösteriyordu; sunucunun zengin
            // verisi (risk skoru, bardak düşüğü, vardiya eksiği) hiç çıkmıyordu.
            // Gerçek şema: operasyon_merkez_api:5010 personel_ozet[].
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Açılış', sag: true },
              { ad: 'Kasa farkı', sag: true }, { ad: 'Bardak düşüğü', sag: true },
              { ad: 'Vardiya eksiği', sag: true }, { ad: 'Risk skoru', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={davranis.slice(0, 40).map((x, i) => {
              const farkAdet = sayi(x.acilis_kasa_fark_adet);
              const farkTutar = sayi(x.acilis_kasa_fark_toplam);
              const bardakAdet = sayi(x.bardak_dusuk_adet);
              const vardiyaEksik = sayi(x.vardiya_eksik_adet);
              const risk = sayi(x.davranis_risk_skoru);
              const riskli = riskliIdler.has(String(x.personel_id));
              return {
                id: x.personel_id || `d-${i}`,
                hucreler: [
                  { v: x.personel_ad || '—', kalin: true },
                  { v: x.sube_adi || '—', renk: R.not },
                  { v: String(sayi(x.acilis_sayisi)), mono: true, sag: true, renk: R.not },
                  farkAdet
                    ? {
                      sira: farkTutar, sag: true,
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span style={{ fontFamily: F.mono, fontWeight: 700, color: R.kirmizi }}>{fmt(farkTutar)}</span>
                          <span style={{ fontSize: 10, color: R.not2 }}>{farkAdet} açılışta</span>
                        </span>
                      ),
                    }
                    : { v: '—', sag: true, renk: R.not3, sira: 0 },
                  bardakAdet
                    ? {
                      sira: sayi(x.bardak_dusuk_toplam), sag: true,
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span style={{ fontFamily: F.mono, fontWeight: 700, color: R.amber }}>{sayi(x.bardak_dusuk_toplam)}</span>
                          <span style={{ fontSize: 10, color: R.not2 }}>{bardakAdet} günde</span>
                        </span>
                      ),
                    }
                    : { v: '—', sag: true, renk: R.not3, sira: 0 },
                  { v: vardiyaEksik ? String(vardiyaEksik) : '—', mono: true, sag: true, renk: vardiyaEksik ? R.amber : R.not3 },
                  { v: risk ? trSayi(risk) : '—', mono: true, sag: true, kalin: true, renk: riskli ? R.kirmizi : risk ? R.amber : R.not3, sira: risk },
                  riskli
                    ? { v: 'sürekli riskli', rozet: R.kirmizi, sira: 2 }
                    : (farkAdet || bardakAdet || vardiyaEksik)
                      ? { v: 'izlemede', rozet: R.amber, sira: 1 }
                      : { v: 'normal', rozet: R.yesil, sira: 0 },
                ],
                _p: x,
              };
            })}
            onSatir={({ _p }) => riskSinyalAc(_p)}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.not }}>Davranış verisi yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Vardiya ve kasa kaydı biriktikçe analiz oluşur.</div>
          </div>
        ))}

        {pdSekme === 'puan' && (puanlar.length ? (
          <Tablo
            baslik="Puan defteri · lig tablosu"
            not="kural=VERİ; gece motoru hesaplar — puan maaşa/avansa BAĞLANMAZ"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Puan', sag: true }, { ad: 'Tamam', sag: true },
              { ad: 'Gecikti', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={[...puanlar]
              .sort((a, b) => sayi(b.puan) - sayi(a.puan))
              .slice(0, 40)
              .map((x, i) => ({
                id: x.personel_id || `p-${i}`,
                hucreler: [
                  { v: x.ad_soyad || '—', kalin: true },
                  { v: String(sayi(x.puan)), mono: true, sag: true, kalin: true, renk: sayi(x.puan) >= 90 ? R.yesil : sayi(x.puan) >= 70 ? R.amber : R.kirmizi },
                  { v: String(sayi(x.tamam)), mono: true, sag: true, renk: R.yesil },
                  { v: String(sayi(x.gecikti)), mono: true, sag: true, renk: sayi(x.gecikti) ? R.amber : R.not },
                  sayi(x.puan) >= 90
                    ? { v: 'örnek', rozet: R.yesil }
                    : sayi(x.puan) >= 70 ? { v: 'iyi', rozet: R.mavi } : { v: 'destek gerek', rozet: R.amber },
                ],
              }))}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.not }}>Puan verisi yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Görev tamamlama kayıtları biriktikçe puan oluşur.</div>
          </div>
        ))}

        {pdSekme === 'gec' && (gecSatir.length ? (
          <Tablo
            baslik={`Geç kalma · ${AY_KISA[ay - 1]} ${yil}`}
            not={`grace ${sayi(pdGec?.gecikme_dk)} dk · kritik eşik ${sayi(pdGec?.kritik_dk)} dk`}
            // ⚠️ ŞUBE üst seviyede YOK — sunucu kişi başına toplar, şube ancak
            // `detaylar[]` içindeki her olayda bulunur (bir kişi birden fazla
            // şubede geç kalmış olabilir). Boş "Şube" sütunu yerine olayların
            // şubeleri özetlenir; olay dökümü satır çekmecesinde.
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Şube(ler)' }, { ad: 'Gecikme adedi', sag: true },
              { ad: 'Toplam dk', sag: true }, { ad: 'Ortalama', sag: true },
              { ad: 'En kötü', sag: true }, { ad: 'Skor', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={gecSatir.slice(0, 40).map((x, i) => {
              const dk = sayi(x.toplam_gecikme_dk);
              const adet = sayi(x.gecikme_adet);
              const det = Array.isArray(x.detaylar) ? x.detaylar : [];
              const subeler = [...new Set(det.map((d) => d.sube_adi).filter(Boolean))];
              return {
                id: x.personel_id || `g-${i}`,
                _g: x,
                hucreler: [
                  { v: x.personel_ad || x.ad_soyad || '—', kalin: true },
                  {
                    siraMetin: subeler.join(', '),
                    v: subeler.length > 1
                      ? `${subeler[0]} +${subeler.length - 1}`
                      : (subeler[0] || '—'),
                    renk: R.not,
                  },
                  { v: String(adet), mono: true, sag: true },
                  { v: dk ? `${trSayi(dk, 0)} dk` : '—', mono: true, sag: true, renk: dk > 60 ? R.kirmizi : R.amber },
                  { v: sayi(x.ortalama_gecikme_dk) ? `${trSayi(x.ortalama_gecikme_dk, 0)} dk` : '—', mono: true, sag: true, renk: R.not },
                  {
                    v: sayi(x.max_gecikme_dk) ? `${trSayi(x.max_gecikme_dk, 0)} dk` : '—',
                    mono: true, sag: true, renk: sayi(x.max_gecikme_dk) > sayi(pdGec?.kritik_dk) ? R.kirmizi : R.not,
                  },
                  { v: sayi(x.skor) ? trSayi(x.skor) : '—', mono: true, sag: true, kalin: true, renk: x.kritik ? R.kirmizi : R.amber, sira: sayi(x.skor) },
                  x.kritik
                    ? { v: `kritik${sayi(x.kritik_gecikme_adet) ? ` · ${sayi(x.kritik_gecikme_adet)}×` : ''}`, rozet: R.kirmizi, sira: 1 }
                    : { v: 'izlemede', rozet: R.amber, sira: 0 },
                ],
              };
            })}
            onSatir={({ _g }) => {
              const det = Array.isArray(_g?.detaylar) ? _g.detaylar : [];
              onCekmece?.({
                tip: 'GEÇ KALMA · OLAY DÖKÜMÜ',
                baslik: _g?.personel_ad || _g?.ad_soyad || 'Personel',
                alt: `${AY_KISA[ay - 1]} ${yil} · ${sayi(_g?.gecikme_adet)} gecikme · grace ${sayi(pdGec?.gecikme_dk)} dk`,
                kpi: [
                  { etiket: 'Toplam', deger: `${trSayi(sayi(_g?.toplam_gecikme_dk), 0)} dk`, renk: R.amber },
                  { etiket: 'Ortalama', deger: `${trSayi(sayi(_g?.ortalama_gecikme_dk), 0)} dk` },
                  { etiket: 'En kötü', deger: `${trSayi(sayi(_g?.max_gecikme_dk), 0)} dk`, renk: R.kirmizi },
                  { etiket: 'Skor', deger: sayi(_g?.skor) ? trSayi(_g.skor) : '—', renk: _g?.kritik ? R.kirmizi : R.krem },
                ],
                listeBaslik: 'Gecikme olayları · gün gün',
                satirlar: det.slice(0, 40).map((d) => ({
                  ad: `${kisaTarih(d.tarih)} · ${d.sube_adi || '—'}`,
                  detay: `planlanan ${String(d.planlanan_saat || '').slice(0, 5)} · giriş ${String(d.acilis_saat || '').slice(0, 5)}`,
                  tutar: `${trSayi(sayi(d.gecikme_dk), 0)} dk`,
                })),
                not: `Kritik eşik ${sayi(pdGec?.kritik_dk)} dk. Bu ekran AYLIK açılış gecikmesini sıralar; günlük vardiya kaydı ve ücret etkisi Vardiya Takip görünümündedir — iki sayı aynı olmak zorunda değil.`,
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.yesil }}>Geç kalma kaydı yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Bu dönemde grace süresini aşan giriş yok.</div>
          </div>
        ))}

        {pdSekme === 'kasa' && (
          <>
            {kasaSatir.length ? (
              <Tablo
                baslik="Kasa açığı analizi · son 30 gün"
                not="kasa farkı olan vardiyalar — özensizlik ≠ açık (şüphe skoru ayrı)"
                kolonlar={[
                  { ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Vardiya', sag: true },
                  { ad: 'Toplam fark', sag: true }, { ad: 'Durum' },
                ]}
                satirlar={kasaSatir.slice(0, 30).map((x, i) => {
                  const fark = sayi(x.toplam_fark ?? x.fark);
                  return {
                    id: x.personel_id || `k-${i}`,
                    hucreler: [
                      { v: x.ad_soyad || x.personel_ad || '—', kalin: true },
                      { v: x.sube_adi || x.sube_ad || '—', renk: R.not },
                      { v: String(sayi(x.vardiya_sayisi ?? x.adet)), mono: true, sag: true },
                      { v: fmt(fark), mono: true, sag: true, kalin: true, renk: fark < 0 ? R.kirmizi : R.yesil },
                      Math.abs(fark) > 500
                        ? { v: 'incele', rozet: R.kirmizi }
                        : { v: 'küçük fark', rozet: R.amber },
                    ],
                  };
                })}
              />
            ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.yesil }}>Kasa açığı yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Son 30 günde kasa farkı olan personel kaydı bulunmuyor.</div>
          </div>
        )}
            {karne.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <Tablo
                  baslik="Kasiyer karnesi · son 30 gün"
                  not="işlem hacmi ve doğruluk oranı"
                  kolonlar={[{ ad: 'Kasiyer' }, { ad: 'Vardiya', sag: true }, { ad: 'Temiz gün', sag: true }, { ad: 'Oran', sag: true }]}
                  satirlar={karne.slice(0, 20).map((x, i) => {
                    const vard = sayi(x.vardiya ?? x.vardiya_sayisi) || 1;
                    const temiz = sayi(x.temiz ?? x.temiz_gun);
                    return {
                      id: x.personel_id || `kr-${i}`,
                      hucreler: [
                        { v: x.ad_soyad || x.personel_ad || '—', kalin: true },
                        { v: String(vard), mono: true, sag: true },
                        { v: String(temiz), mono: true, sag: true, renk: R.yesil },
                        { v: `%${trSayi((temiz / vard) * 100, 0)}`, mono: true, sag: true, renk: (temiz / vard) >= 0.9 ? R.yesil : R.amber },
                      ],
                    };
                  })}
                />
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 11.5, color: R.not, marginTop: 12, marginBottom: 16, lineHeight: 1.55 }}>
          ℹ ÖNERİ-ONLY: bu ekran gözlem toplar, hüküm vermez. Puan maaşa/avansa bağlanmaz;
          disiplin kararı sahibin.
        </div>
      </>
    );
  }

  // ── 1) Kadro ───────────────────────────────────────────────────────────────
  if (gorunum === 'kadro') {
    const satir = personel.map(p => {
      const t = takipMap[String(p.id)] || {};
      const kd = kidemAy(p.baslangic_tarihi);
      const fm = sayi(t.toplam_fazla_mesai_saat);
      return {
        p, kd,
        saat: t.toplam_planlanan_saat != null ? sayi(t.toplam_planlanan_saat) : null,
        fm,
        durum: fm > 8 ? 'fazla mesai' : kd != null && kd < 3 ? 'deneme' : 'aktif',
        durumRenk: fm > 8 ? R.kirmizi : kd != null && kd < 3 ? R.mavi : R.yesil,
      };
    });
    const yeni = satir.filter(x => x.kd != null && x.kd < 1).length;
    const kidemli = satir.filter(x => x.kd != null);
    const ortKidem = kidemli.length ? kidemli.reduce((s, x) => s + x.kd, 0) / kidemli.length : null;
    // Şube sayısı yalnız GERÇEK şubelerden: sube_id'si olmayan (merkez/depo)
    // personel şube saydırmaz — yoksa "5 şube" gibi yanlış rakam çıkar.
    const subeSayisi = new Set(personel.filter(p => p.sube_id).map(p => p.sube_adi).filter(Boolean)).size;
    const subesiz = personel.filter(p => !p.sube_id).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam personel', deger: String(personel.length), alt: `${subeSayisi} şube${subesiz ? ` + ${subesiz} merkez` : ''}` },
          { etiket: 'Bu ay işe giren', deger: String(yeni), alt: yeni ? 'ilk ayında' : 'yeni giriş yok', renk: yeni ? R.yesil : R.krem },
          { etiket: 'Fazla mesai riski', deger: String(satir.filter(x => x.fm > 8).length), alt: 'bu ay 8 saatten fazla', renk: satir.some(x => x.fm > 8) ? R.kirmizi : R.yesil },
          { etiket: 'Ortalama kıdem', deger: ortKidem == null ? '—' : `${trSayi(ortKidem, 0)} ay`, alt: 'zincir geneli', renk: R.krem },
        ]} />
        <Tablo
          baslik="Kadro"
          not="satıra tıkla → personel dosyası"
          kolonlar={[
            { ad: 'Personel' }, { ad: 'Görev' }, { ad: 'Şube' },
            { ad: 'Kıdem', sag: true }, { ad: 'Bu ay saat', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={satir.map(x => ({
            id: x.p.id, _p: x.p,
            hucreler: [
              { v: x.p.ad_soyad, kalin: true },
              { v: x.p.gorev || '—', renk: R.not },
              { v: x.p.sube_adi || '—', renk: R.not },
              { v: x.kd == null ? '—' : `${x.kd} ay`, mono: true, sag: true },
              { v: x.saat == null ? '—' : `${trSayi(x.saat, 0)} sa`, mono: true, sag: true, renk: x.fm > 8 ? R.kirmizi : R.krem },
              { v: x.durum, rozet: x.durumRenk },
            ],
          }))}
          onSatir={(row) => personelAc(row._p)}
        />
        <div style={{ display: 'flex', gap: 9, marginTop: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={() => pFormAc(null)} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            + Personel ekle
          </button>
          <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
            düzenleme ve işten çıkış için satıra tıkla
          </span>
        </div>
        {personelModali}
      </>
    );
  }

  // ── 2) Vardiya Planı ───────────────────────────────────────────────────────
  if (gorunum === 'vardiya') {
    const gunISO = hafta?.gunler || Array.from({ length: 7 }, (_, i) => isoEkle(pazartesi, i));
    const gunler = gunISO.map(g => ({
      iso: g,
      haftaAd: HAFTA[haftaGunu(g)],
      gunAd: kisaTarih(g),
      bugun: g === bugun,
    }));
    // Uç sözleşmesi (vardiya_v2.sube_haftalik_gorunum): şube alanı `sube_ad`,
    // `gunler` ise TARİH STRİNGİYLE anahtarlanmış sözlük — dizi değil.
    const subeler = (hafta?.subeler || []).map(s => ({
      ad: s.sube_ad || s.ad || '—',
      gunler: gunISO.map(g => {
        const ham = (s.gunler || {})[g] || [];
        const kisiler = (Array.isArray(ham) ? ham : []).map(k => ({
          ad: k.ad_soyad || k.ad || '—',
          gorev: k.gorev,
          saat: k.saat,
          kapanis: k.kapanis,
        }));
        return { iso: g, kisiler };
      }),
    }));

    const toplamHucre = subeler.length * 7;
    const bosHucre = subeler.reduce((s, x) => s + x.gunler.filter(h => !h.kisiler.length).length, 0);
    const atamaSayisi = subeler.reduce((s, x) => s + x.gunler.reduce((t, h) => t + h.kisiler.length, 0), 0);
    const fazlaMesai = personel.filter(p => sayi(takipMap[String(p.id)]?.toplam_fazla_mesai_saat) > 8).length;

    if (!subeler.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>Bu hafta için vardiya planı yok</div>
          <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6 }}>
            {kisaTarih(pazartesi)} haftası boş. Aşağıdaki gün planlayıcıdan atama yapabilirsin.
          </div>
        </div>
      );
    }

    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Boş slot', deger: String(bosHucre), alt: bosHucre ? 'kimse atanmamış gün-şube' : 'hafta tam', renk: bosHucre ? R.amber : R.yesil },
          { etiket: 'Toplam atama', deger: String(atamaSayisi), alt: `${subeler.length} şube · 7 gün` },
          { etiket: 'Fazla mesai riski', deger: `${fazlaMesai} kişi`, alt: 'bu ay 8 saat üzeri', renk: fazlaMesai ? R.kirmizi : R.yesil },
          { etiket: 'Doluluk', deger: toplamHucre ? `%${trSayi(((toplamHucre - bosHucre) / toplamHucre) * 100, 0)}` : '—', alt: 'gün-şube hücresi', renk: R.krem },
        ]} />
        <VardiyaIzgara
          baslik={`Vardiya planı · ${kisaTarih(pazartesi)} – ${kisaTarih(isoEkle(pazartesi, 6))}`}
          not="salt-okur · atama planlama ekranından yapılır"
          gunler={gunler}
          subeler={subeler}
          onHucre={(s, h) => onCekmece?.({
            tip: 'VARDİYA HÜCRESİ',
            baslik: `${s.ad} · ${kisaTarih(h.iso)}`,
            alt: h.kisiler.length ? `${h.kisiler.length} kişi atanmış` : 'kimse atanmamış',
            kpi: [
              { etiket: 'Atanan', deger: String(h.kisiler.length), renk: h.kisiler.length ? R.yesil : R.kirmizi },
              { etiket: 'Gün', deger: HAFTA[haftaGunu(h.iso)] },
            ],
            listeBaslik: 'Vardiyadakiler',
            satirlar: h.kisiler.map(k => ({
              ad: k.ad,
              detay: k.gorev || (k.kapanis ? 'kapanış sorumlusu' : 'vardiya'),
              tutar: k.saat || '—',
            })),
            not: h.kisiler.length
              ? 'Atamayı değiştirmek için aşağıdaki gün planlayıcıyı kullan (o güne geçer).'
              : 'Bu gün-şube için kimse atanmamış. Açık slot, kapanış sorumlusu boşluğu anlamına da gelebilir.',
            aksiyonlar: [{
              ad: `→ ${kisaTarih(h.iso)} gününü planla`,
              birincil: true,
              onTikla: () => { setVpTarih(h.iso); vpYukle(h.iso); },
            }],
          })}
        />

        {/* ══════════ YERLİ GÜN PLANLAYICI (klasik VardiyaPlanlamaV2 çekirdeği) ══════════ */}
        <div style={{ ...kartYuzey, padding: '18px 20px', marginTop: 16, marginBottom: 16 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>🗓 Gün planlayıcı</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={() => vpGunDegis(-1)} style={vpOk}>‹</button>
              <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, minWidth: 92, textAlign: 'center' }}>
                {kisaTarih(vpTarih)}
              </span>
              <button onClick={() => vpGunDegis(1)} style={vpOk}>›</button>
            </div>
            <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
              slota tıkla → personel ata · çakışma engeldir, uyarıda onay sorar
            </span>
            <button onClick={() => setVpKopyaModal({ hedef: isoEkle(vpTarih, 1) })} style={{
              padding: '7px 13px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: R.girinti, color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
            }}>
              📋 Kopyala / temizle
            </button>
          </div>

          {vpHata ? (
            <div style={{ fontSize: 12.5, color: R.kirmizi }}>
              Gün planı alınamadı — {vpHata}
              <button onClick={() => vpYukle(vpTarih)} style={{
                marginLeft: 10, padding: '5px 11px', borderRadius: 8, border: `1px solid ${R.kirmizi}55`,
                background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
              }}>Tekrar dene</button>
            </div>
          ) : !vpGun ? (
            <div style={{ fontSize: 12.5, color: R.not, textAlign: 'center', padding: '18px 0' }}>Gün planı yükleniyor…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              {(vpGun.subeler || []).map((sb) => {
                const slotlar = Array.isArray(sb.slotlar) ? sb.slotlar : [];
                const eksikVar = slotlar.some((sv) => sayi(sv.eksik) > 0);
                return (
                  <div key={sb.sube_id} style={{
                    background: 'linear-gradient(165deg, #241A10, #1E1509)',
                    border: `1px solid ${eksikVar ? `${R.amber}44` : 'rgba(243,233,220,.08)'}`,
                    borderRadius: 14, padding: 13,
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      paddingBottom: 9, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{sb.sube_ad || '—'}</span>
                      <span style={{ fontSize: 10.5, color: R.not2, fontFamily: F.mono }}>
                        {sayi(sb.atanan_benzersiz_kisi)} kişi
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {slotlar.length === 0 && (
                        <div style={{ fontSize: 11.5, color: R.not3, textAlign: 'center', padding: '10px 0' }}>slot tanımı yok</div>
                      )}
                      {slotlar.map((sv) => {
                        const slot = sv.slot || {};
                        const atamalar = Array.isArray(sv.atamalar) ? sv.atamalar : [];
                        const eksik = sayi(sv.eksik);
                        const saat = `${String(slot.baslangic_saat || '').slice(0, 5)}–${String(slot.bitis_saat || '').slice(0, 5)}`;
                        return (
                          <div key={slot.id} style={{
                            padding: '10px 12px', borderRadius: 11,
                            background: R.girinti,
                            border: `1px solid ${eksik > 0 ? `${R.amber}55` : R.cizgi3}`,
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{slot.ad || 'vardiya'}</span>
                              <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2 }}>{saat}</span>
                              {eksik > 0 && <span style={{ ...rozetHapV, background: `${R.amber}22`, color: R.amber }}>{eksik} eksik</span>}
                            </div>
                            {atamalar.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                                {atamalar.map((a) => (
                                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                    <span style={{ color: R.yesil }}>✓</span>
                                    <span style={{ flex: 1, color: R.metin2 }}>
                                      {a.ad_soyad || `${a.ad || ''} ${a.soyad || ''}`.trim() || '—'}
                                      {a.kapanis ? ' · kapanış' : ''}
                                    </span>
                                    <button
                                      disabled={vpMesgul === a.id}
                                      onClick={() => vpAtamaSil(a.id, a.ad_soyad || a.ad)}
                                      style={{
                                        padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                                        color: R.not, fontSize: 10.5,
                                      }}
                                    >
                                      {vpMesgul === a.id ? '…' : 'kaldır'}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <button
                              onClick={() => setVpAtaModal({ slot, subeAd: sb.sube_ad, personelId: '', uyari: '', override: false })}
                              style={{
                                width: '100%', marginTop: 9, padding: '6px 0', borderRadius: 8,
                                border: `1px solid ${R.bakir}55`, background: `${R.bakir}1a`,
                                color: R.bakir, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                              }}
                            >
                              + Personel ata
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* atama modalı */}
        {vpAtaModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !vpMesgul) setVpAtaModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Vardiya Ataması</div>
                <button onClick={() => !vpMesgul && setVpAtaModal(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                {vpAtaModal.subeAd} · {vpAtaModal.slot.ad || 'vardiya'} ·{' '}
                {String(vpAtaModal.slot.baslangic_saat || '').slice(0, 5)}–{String(vpAtaModal.slot.bitis_saat || '').slice(0, 5)} ·{' '}
                {kisaTarih(vpTarih)}
              </div>
              <label style={ekEtiket}>Personel *</label>
              <select
                value={vpAtaModal.personelId}
                onChange={(e) => setVpAtaModal((f) => ({ ...f, personelId: e.target.value, uyari: '', override: false }))}
                style={ekAlanStil}
              >
                <option value="">Seçin…</option>
                {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad}{p.sube_adi ? ` · ${p.sube_adi}` : ''}</option>)}
              </select>

              {vpAtaModal.uyari && (
                <div style={{
                  marginTop: 13, padding: '12px 15px', borderRadius: 12,
                  background: vpAtaModal.override ? `${R.amber}12` : `${R.kirmizi}14`,
                  border: `1px solid ${vpAtaModal.override ? `${R.amber}66` : `${R.kirmizi}55`}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: vpAtaModal.override ? R.amber : R.kirmizi }}>
                    {vpAtaModal.override
                      ? (vpAtaModal.kritikVar ? '⚠ KRİTİK uyarı' : '⚠ Uyarı var')
                      : '⛔ Çakışma — atanamaz'}
                  </div>
                  <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.5 }}>{vpAtaModal.uyari}</div>
                  {/* Gün saat bütçesi — "yine de ata" kararı buna bakılarak verilir */}
                  {vpAtaModal.butce && (
                    <div style={{
                      fontSize: 11.5, color: R.not, marginTop: 8, padding: '7px 11px',
                      borderRadius: 9, background: R.girinti, fontFamily: F.mono,
                    }}>{vpAtaModal.butce}</div>
                  )}
                  {vpAtaModal.override && (
                    <button disabled={vpMesgul === 'ata'} onClick={() => vpAta(true)} style={{
                      marginTop: 10, padding: '7px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
                      background: `${R.amber}26`, color: R.amber, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                    }}>{vpMesgul === 'ata' ? 'Atanıyor…' : 'Yine de ata'}</button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                <button disabled={!!vpMesgul} onClick={() => setVpAtaModal(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Vazgeç</button>
                <button
                  disabled={!!vpMesgul || !vpAtaModal.personelId || (!!vpAtaModal.uyari && !vpAtaModal.override)}
                  onClick={() => vpAta(false)}
                  style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: vpAtaModal.personelId ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : R.girinti,
                    color: vpAtaModal.personelId ? '#1C1309' : R.not,
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    cursor: vpAtaModal.personelId ? 'pointer' : 'default',
                  }}
                >
                  {vpMesgul === 'ata' ? 'Kontrol ediliyor…' : 'Ata'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ PLAN ALTYAPISI (Faz 5) — iskelet burada kurulur, atama yukarıda yapılır ══ */}
        <div style={{ ...kartYuzey, padding: '16px 18px', marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>Plan altyapısı</div>
            <div style={{ fontSize: 11.5, color: R.not2 }}>
              slot iskeleti · gün kilidi · otomatik doldurma · izin
            </div>
            {plKilit && (
              <span style={{
                marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                background: plKilit.kilitli ? `${R.kirmizi}22` : `${R.yesil}1E`,
                color: plKilit.kilitli ? R.kirmizi : R.yesil,
              }}>{plKilit.kilitli ? '🔒 gün kilitli' : '🔓 gün açık'}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {[['slot', '🧱 Slot iskeleti'], ['kilit', '🔒 Gün kilidi'], ['motor', '⚙️ Otomatik doldur'], ['izin', '🌴 İzin'], ['serbest', '🕐 Serbest atama'], ['preset', '⏱ Preset'], ['kisit', '🚧 Kısıtlar']].map(([k, ad]) => (
              <button key={k} onClick={() => { setPlSekme(plSekme === k ? '' : k); if (k === 'preset') presetYukle(); if (k === 'izin') izinlerYukle(); }} style={{
                padding: '7px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, fontWeight: 600,
                border: `1px solid ${plSekme === k ? R.bakir : R.cizgi3}`,
                background: plSekme === k ? `${R.bakir}1E` : 'transparent',
                color: plSekme === k ? R.bakir : R.metin2,
              }}>{ad}</button>
            ))}
          </div>

          {plSekme === 'slot' && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 10 }}>
                Slot = plandaki <b>boş yuva</b>. Kişiyi bir slota atarsın; slot yoksa
                atanacak yer de yoktur. Slotlar günlük değil <b>kalıcıdır</b> — hangi
                haftanın günlerinde geçerli olduğunu seçersin.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button onClick={() => { setSlotForm({ ...BOS_SLOT, sube_id: (vpGun?.subeler || [])[0]?.sube_id || '' }); setPlModal({ tip: 'slot' }); }}
                  style={plBtn}>+ Yeni slot</button>
                <button onClick={() => setPlModal({ tip: 'uret', sube_id: (vpGun?.subeler || [])[0]?.sube_id || '', mod: 'yenile', acilis_dakika: 60, kapanis_dakika: 60, normal_slot_dakika: 120, hafta_ici: false })}
                  style={plBtn}>⚡ Açılış-kapanıştan üret</button>
              </div>
              {(vpGun?.subeler || []).map((sb) => (
                <div key={sb.sube_id || sb.sube_ad} style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: R.metin2, marginBottom: 6 }}>{sb.sube_ad || sb.ad || '—'}</div>
                  {(sb.slotlar || []).length ? (sb.slotlar || []).map((x, i) => {
                    const sl = x.slot || x;
                    return (
                      <div key={sl.id || i} style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        borderRadius: 9, background: R.girinti, marginBottom: 5, fontSize: 12,
                      }}>
                        <span style={{ fontWeight: 600 }}>{sl.ad || '—'}</span>
                        <span style={{ color: R.not, fontFamily: 'ui-monospace, monospace' }}>
                          {sl.baslangic_saat}–{sl.bitis_saat}{sl.gece_vardiyasi ? ' 🌙' : ''}
                        </span>
                        <span style={{ color: R.not2 }}>min {sayi(sl.min_personel)} · ideal {sayi(sl.ideal_personel)}</span>
                        {sayi(x.eksik) > 0 && (
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: `${R.kirmizi}22`, color: R.kirmizi }}>
                            {sayi(x.eksik)} eksik
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                          <button onClick={() => { setSlotForm({ ...BOS_SLOT, ...sl, sube_id: sl.sube_id || sb.sube_id }); setPlModal({ tip: 'slot' }); }} style={plMini}>Düzenle</button>
                          <button onClick={() => setPlModal({ tip: 'slot-sil', slot: sl })} style={{ ...plMini, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Sil</button>
                        </span>
                      </div>
                    );
                  }) : <div style={{ fontSize: 11.5, color: R.not, padding: '6px 0' }}>Bu şubede slot yok — yukarıdan üretebilirsin.</div>}
                </div>
              ))}
              {/* Şube-gün hedefi: slotlardan bağımsız "bugün kaç kişi olmalı" beyanı */}
              <div style={{ borderTop: `1px solid ${R.cizgi3}`, paddingTop: 12, marginTop: 6 }}>
                <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 8 }}>
                  <b>Günlük hedef kişi</b> — slot toplamından bağımsız olarak
                  {' '}<b>{kisaTarih(vpTarih)}</b> günü için «kaç kişi olmalı» dersin.
                  Yoğun/sakin günleri slot iskeletini bozmadan ayarlamanı sağlar. Boş bırakırsan hedef kalkar.
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ minWidth: 160 }}><label style={ekEtiket}>Şube</label>
                    <select value={hdSube} onChange={(e) => setHdSube(e.target.value)} style={ekAlanStil}>
                      <option value="">— seçin —</option>
                      {(vpGun?.subeler || []).map((x) => <option key={x.sube_id} value={x.sube_id}>{x.sube_ad || x.ad}</option>)}
                    </select></div>
                  <div style={{ maxWidth: 110 }}><label style={ekEtiket}>Hedef kişi</label>
                    <input type="number" min={0} value={hdSayi} onChange={(e) => setHdSayi(e.target.value)} style={ekAlanStil} /></div>
                  <button disabled={plMesgul} onClick={hedefKaydet} style={{ ...plBtn, marginBottom: 2 }}>Hedefi kaydet</button>
                </div>
              </div>
            </div>
          )}

          {plSekme === 'kilit' && (
            <div style={{ marginTop: 14, maxWidth: 520 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                Kilitli günde plan <b>değiştirilemez</b> — atama eklenemez, silinemez.
                Vardiya kesinleştikten sonra kilitlemek, sonradan sessizce değiştirilmesini önler.
                Geçmiş günler kendiliğinden kilitlidir; toplu açmak işletme PIN'i ister.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                <button onClick={() => setPlModal({ tip: 'kilit', kilitli: !plKilit?.kilitli })} style={plBtn}>
                  {plKilit?.kilitli ? '🔓 Bu günün kilidini aç' : '🔒 Bu günü kilitle'}
                </button>
              </div>
              <label style={ekEtiket}>Geçmiş günleri toplu aç · işletme PIN kodu</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="password" inputMode="numeric" value={gkPin} autoComplete="off"
                  onChange={(e) => setGkPin(e.target.value)} style={{ ...ekAlanStil, maxWidth: 150, letterSpacing: 5 }} />
                <button disabled={plMesgul || !gkPin.trim()} onClick={() => setPlModal({ tip: 'gecmis-kilit' })}
                  style={{ ...plBtn, opacity: gkPin.trim() ? 1 : 0.45 }}>Geçmişi aç…</button>
              </div>
            </div>
          )}

          {plSekme === 'motor' && (
            <div style={{ marginTop: 14, maxWidth: 620 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                Motor haftanın <b>eksik slotlarını</b> uygun personelle doldurmaya çalışır;
                kısıtları (günlük/haftalık saat, izin, şube yasağı) çiğnemez.
                Önce <b>önizleme</b> çalıştır — veritabanı geri alınır, sadece ne olacağını görürsün.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button disabled={plMesgul} onClick={() => motorCalistir(false)} style={plBtn}>
                  {plMesgul ? 'Çalışıyor…' : '👁 Önizle (geri alınır)'}
                </button>
                <button disabled={plMesgul || !plMotor || plMotor.gercek} onClick={() => motorCalistir(true)}
                  style={{ ...plBtn, borderColor: R.bakir, background: `${R.bakir}1E`, color: R.bakir,
                    opacity: (!plMotor || plMotor.gercek) ? 0.45 : 1 }}>
                  ✓ Uygula
                </button>
              </div>
              {plMotor && (
                <div style={{ padding: '12px 14px', borderRadius: 10, background: R.girinti, fontSize: 12, lineHeight: 1.75 }}>
                  <b>{plMotor.gercek ? 'Uygulandı' : 'Önizleme'}</b> — {plMotor.mesaj || 'sonuç mesajı yok'}
                  {plMotor.atanan != null && <><br />Atanan: <b>{sayi(plMotor.atanan)}</b></>}
                  {plMotor.kalan_eksik != null && <> · Kalan eksik: <b>{sayi(plMotor.kalan_eksik)}</b></>}
                  {!plMotor.gercek && <div style={{ color: R.not2, marginTop: 6 }}>Sonucu beğendiysen «Uygula» ile kalıcı hale getir.</div>}
                </div>
              )}
            </div>
          )}

          {plSekme === 'izin' && (
            <div style={{ marginTop: 14, maxWidth: 620 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                İzinli personel plana <b>atanamaz</b>; motor da o günleri atlar.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 180 }}>
                  <label style={ekEtiket}>Personel</label>
                  <select value={izForm.personel_id} onChange={(e) => setIzForm((p) => ({ ...p, personel_id: e.target.value }))} style={ekAlanStil}>
                    <option value="">— seçin —</option>
                    {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad || p.ad}</option>)}
                  </select>
                </div>
                <div><label style={ekEtiket}>Başlangıç</label>
                  <input type="date" value={izForm.baslangic_tarih} onChange={(e) => setIzForm((p) => ({ ...p, baslangic_tarih: e.target.value }))} style={ekAlanStil} /></div>
                <div><label style={ekEtiket}>Bitiş</label>
                  <input type="date" value={izForm.bitis_tarih} onChange={(e) => setIzForm((p) => ({ ...p, bitis_tarih: e.target.value }))} style={ekAlanStil} /></div>
                <div><label style={ekEtiket}>Tip</label>
                  <select value={izForm.tip} onChange={(e) => setIzForm((p) => ({ ...p, tip: e.target.value }))} style={ekAlanStil}>
                    <option value="mazeret">Mazeret</option>
                    <option value="yillik">Yıllık</option>
                    <option value="rapor">Rapor</option>
                    <option value="ucretsiz">Ücretsiz</option>
                  </select></div>
              </div>
              <label style={ekEtiket}>Açıklama (isteğe bağlı)</label>
              <input value={izForm.aciklama} onChange={(e) => setIzForm((p) => ({ ...p, aciklama: e.target.value }))} style={ekAlanStil} />
              <button disabled={plMesgul} onClick={izinEkle} style={plBtn}>{plMesgul ? 'Kaydediliyor…' : 'İzni kaydet'}</button>
              {/* Kayıtlı izinler — yanlış girileni buradan kaldır */}
              {Array.isArray(izinler) && izinler.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: R.metin2, marginBottom: 6 }}>
                    Kayıtlı izinler · {sayi(izinler.length)}
                  </div>
                  {izinler.slice(0, 40).map((z, i) => (
                    <div key={z.id || i} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderRadius: 9, background: R.girinti, marginBottom: 5, fontSize: 12, flexWrap: 'wrap',
                    }}>
                      <span style={{ fontWeight: 600 }}>{z._personel_full || z.personel_ad || z.personel_id}</span>
                      <span style={{ color: R.not, fontFamily: 'ui-monospace, monospace' }}>
                        {kisaTarih(z.baslangic_tarih)} → {kisaTarih(z.bitis_tarih)}
                      </span>
                      <span style={{ color: R.not2 }}>{z.tip || 'mazeret'}</span>
                      {z.aciklama && <span style={{ color: R.not2 }}>· {z.aciklama}</span>}
                      <button onClick={() => setIzSilModal(z)}
                        style={{ ...plMini, marginLeft: 'auto', color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Kaldır</button>
                    </div>
                  ))}
                </div>
              )}
              {izSilModal && (
                <div onClick={(e) => { if (e.target === e.currentTarget && !plMesgul) setIzSilModal(null); }} style={{
                  position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
                  backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
                }}>
                  <div style={{ ...kartYuzey, width: 420, maxWidth: '96vw', padding: '24px 26px' }}>
                    <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>İzni kaldır</div>
                    <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                      <b>{izSilModal._personel_full || izSilModal.personel_ad || izSilModal.personel_id}</b> ·{' '}
                      {kisaTarih(izSilModal.baslangic_tarih)} → {kisaTarih(izSilModal.bitis_tarih)}
                    </div>
                    <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
                      İzin kaydı silinir; o günlerde bu kişi yeniden plana atanabilir ve
                      motor onu aday sayar. Zaten yapılmış atamalar etkilenmez.
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                      <button disabled={plMesgul} onClick={() => setIzSilModal(null)} style={{
                        padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>Vazgeç</button>
                      <button disabled={plMesgul} onClick={izinSil} style={{
                        padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                        fontFamily: 'inherit', border: `1px solid ${R.kirmizi}55`,
                        background: `${R.kirmizi}26`, color: R.kirmizi,
                      }}>{plMesgul ? 'İşleniyor…' : 'Kaldır'}</button>
                    </div>
                  </div>
                </div>
              )}
              {/* Kasıtlı boş: izin değil, "bugün bilerek çalışmıyor" beyanı */}
              <div style={{ borderTop: `1px solid ${R.cizgi3}`, paddingTop: 12, marginTop: 14 }}>
                <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 8 }}>
                  <b>Bilerek boş</b> — izin değil. Kişi <b>{kisaTarih(vpTarih)}</b> günü
                  planda yok ama bu bir eksiklik değil; sistem «atanmamış» uyarısı üretmesin diye işaretlenir.
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ minWidth: 180 }}><label style={ekEtiket}>Personel</label>
                    <select value={izForm.personel_id} onChange={(e) => setIzForm((p) => ({ ...p, personel_id: e.target.value }))} style={ekAlanStil}>
                      <option value="">— seçin —</option>
                      {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad || p.ad}</option>)}
                    </select></div>
                  <button disabled={plMesgul || !izForm.personel_id} onClick={() => kasitliBos(izForm.personel_id, true)}
                    style={{ ...plBtn, marginBottom: 2, opacity: izForm.personel_id ? 1 : 0.45 }}>Bilerek boş işaretle</button>
                  <button disabled={plMesgul || !izForm.personel_id} onClick={() => kasitliBos(izForm.personel_id, false)}
                    style={{ ...plBtn, marginBottom: 2, opacity: izForm.personel_id ? 1 : 0.45 }}>İşareti kaldır</button>
                </div>
              </div>
            </div>
          )}

          {plSekme === 'serbest' && (
            <div style={{ marginTop: 14, maxWidth: 680 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                Slota sığmayan durumlar için: kişiyi <b>istediğin saat aralığında</b>
                {' '}<b>{kisaTarih(vpTarih)}</b> gününe atar. Gece sarkması otomatik anlaşılır
                (bitiş, başlangıçtan küçükse ertesi gün). Çakışma varsa engellenir —
                bilerek geçmek istiyorsan «zorla» işaretle.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 170 }}><label style={ekEtiket}>Personel</label>
                  <select value={sbForm.personel_id} onChange={(e) => setSbForm((p) => ({ ...p, personel_id: e.target.value }))} style={ekAlanStil}>
                    <option value="">— seçin —</option>
                    {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad || p.ad}</option>)}
                  </select></div>
                <div style={{ minWidth: 150 }}><label style={ekEtiket}>Şube</label>
                  <select value={sbForm.sube_id} onChange={(e) => setSbForm((p) => ({ ...p, sube_id: e.target.value }))} style={ekAlanStil}>
                    <option value="">— seçin —</option>
                    {(vpGun?.subeler || []).map((x) => <option key={x.sube_id} value={x.sube_id}>{x.sube_ad || x.ad}</option>)}
                  </select></div>
                <div><label style={ekEtiket}>Başlangıç</label>
                  <input type="time" value={sbForm.baslangic_saat} onChange={(e) => setSbForm((p) => ({ ...p, baslangic_saat: e.target.value }))} style={ekAlanStil} /></div>
                <div><label style={ekEtiket}>Bitiş</label>
                  <input type="time" value={sbForm.bitis_saat} onChange={(e) => setSbForm((p) => ({ ...p, bitis_saat: e.target.value }))} style={ekAlanStil} /></div>
              </div>
              <label style={ekEtiket}>Açıklama</label>
              <input value={sbForm.aciklama} onChange={(e) => setSbForm((p) => ({ ...p, aciklama: e.target.value }))} style={ekAlanStil} />
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '10px 0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: R.metin2, cursor: 'pointer' }}>
                  <input type="checkbox" checked={sbForm.override} onChange={(e) => setSbForm((p) => ({ ...p, override: e.target.checked }))} />
                  Çakışmaya rağmen zorla
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: R.metin2, cursor: 'pointer' }}>
                  <input type="checkbox" checked={sbForm.kesinlestir} onChange={(e) => setSbForm((p) => ({ ...p, kesinlestir: e.target.checked }))} />
                  Kesinleştir
                </label>
              </div>
              <button disabled={plMesgul} onClick={serbestAta} style={plBtn}>{plMesgul ? 'Atanıyor…' : 'Serbest ata'}</button>
            </div>
          )}

          {plSekme === 'preset' && (
            <div style={{ marginTop: 14, maxWidth: 680 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                Preset = sık kullanılan <b>hazır vardiya kalıbı</b> (ör. «Sabah 08–16»).
                Bir kez tanımlarsın, planlarken tekrar saat yazmazsın.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ maxWidth: 110 }}><label style={ekEtiket}>Kod</label>
                  <input value={prForm.kod} onChange={(e) => setPrForm((p) => ({ ...p, kod: e.target.value }))} style={ekAlanStil} /></div>
                <div style={{ minWidth: 160 }}><label style={ekEtiket}>Ad</label>
                  <input value={prForm.ad} onChange={(e) => setPrForm((p) => ({ ...p, ad: e.target.value }))} style={ekAlanStil} /></div>
                <div><label style={ekEtiket}>Başlangıç</label>
                  <input type="time" value={prForm.bas_saat} onChange={(e) => setPrForm((p) => ({ ...p, bas_saat: e.target.value }))} style={ekAlanStil} /></div>
                <div><label style={ekEtiket}>Bitiş</label>
                  <input type="time" value={prForm.bit_saat} onChange={(e) => setPrForm((p) => ({ ...p, bit_saat: e.target.value }))} style={ekAlanStil} /></div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: R.metin2, cursor: 'pointer', margin: '10px 0' }}>
                <input type="checkbox" checked={prForm.gece_vardiyasi} onChange={(e) => setPrForm((p) => ({ ...p, gece_vardiyasi: e.target.checked }))} />
                Gece vardiyası
              </label>
              <button disabled={plMesgul} onClick={presetKaydet} style={plBtn}>Preseti kaydet</button>
              <div style={{ marginTop: 14 }}>
                {presetler === null ? <div style={{ fontSize: 12, color: R.not }}>Yükleniyor…</div>
                  : presetler.length ? presetler.map((x, i) => (
                  <div key={x.kod || i} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                    borderRadius: 9, background: R.girinti, marginBottom: 5, fontSize: 12,
                  }}>
                    <span style={{ fontWeight: 600 }}>{x.ad || x.kod}</span>
                    <span style={{ color: R.not, fontFamily: 'ui-monospace, monospace' }}>
                      {x.bas_saat}–{x.bit_saat}{x.gece_vardiyasi ? ' 🌙' : ''}
                    </span>
                    <span style={{ color: R.not2 }}>kod: {x.kod}</span>
                    <button onClick={() => presetSil(x.kod)} style={{ ...plMini, marginLeft: 'auto', color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Sil</button>
                  </div>
                )) : <div style={{ fontSize: 11.5, color: R.not }}>Henüz preset yok.</div>}
              </div>
            </div>
          )}

          {plSekme === 'kisit' && (
            <div style={{ marginTop: 14, maxWidth: 680 }}>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
                Kısıtlar <b>motorun uyduğu kurallardır</b> — kimse günlük/haftalık
                saat tavanının üstüne, çalışamayacağı saate veya yasaklı şubeye atanmaz.
              </div>
              <div style={{ minWidth: 200, maxWidth: 260 }}>
                <label style={ekEtiket}>Personel</label>
                <select value={ksPersonel} onChange={(e) => { setKsPersonel(e.target.value); kisitYukle(e.target.value); }} style={ekAlanStil}>
                  <option value="">— seçin —</option>
                  {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad || p.ad}</option>)}
                </select>
              </div>
              {ksPersonel && ksVeri && (
                <>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ maxWidth: 130 }}><label style={ekEtiket}>Günlük tavan (saat)</label>
                      <input type="number" step="0.5" value={ksVeri.max_gunluk_saat ?? 9.5}
                        onChange={(e) => setKsVeri((p) => ({ ...p, max_gunluk_saat: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 130 }}><label style={ekEtiket}>Haftalık tavan</label>
                      <input type="number" step="0.5" value={ksVeri.max_haftalik_saat ?? 57}
                        onChange={(e) => setKsVeri((p) => ({ ...p, max_haftalik_saat: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 130 }}><label style={ekEtiket}>En erken saat</label>
                      <input type="time" value={ksVeri.calisilabilir_saat_min || ''}
                        onChange={(e) => setKsVeri((p) => ({ ...p, calisilabilir_saat_min: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 130 }}><label style={ekEtiket}>En geç saat</label>
                      <input type="time" value={ksVeri.calisilabilir_saat_max || ''}
                        onChange={(e) => setKsVeri((p) => ({ ...p, calisilabilir_saat_max: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 150 }}><label style={ekEtiket}>Vardiyalar arası min (dk)</label>
                      <input type="number" value={ksVeri.min_gecis_dk ?? 30}
                        onChange={(e) => setKsVeri((p) => ({ ...p, min_gecis_dk: e.target.value }))} style={ekAlanStil} /></div>
                  </div>
                  <label style={ekEtiket}>Yasaklı şubeler (bu kişi buralara atanmaz)</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {(vpGun?.subeler || []).map((sb) => {
                      const yasak = (ksVeri.yasak_subeler || []).includes(sb.sube_id);
                      return (
                        <button key={sb.sube_id} onClick={() => setKsVeri((p) => ({
                          ...p, yasak_subeler: yasak
                            ? (p.yasak_subeler || []).filter((x) => x !== sb.sube_id)
                            : [...(p.yasak_subeler || []), sb.sube_id],
                        }))} style={{
                          padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                          fontSize: 11.5, fontWeight: 600,
                          border: `1px solid ${yasak ? R.kirmizi : R.cizgi3}`,
                          background: yasak ? `${R.kirmizi}22` : 'transparent',
                          color: yasak ? R.kirmizi : R.not,
                        }}>{yasak ? '⛔ ' : ''}{sb.sube_ad || sb.ad}</button>
                      );
                    })}
                  </div>
                  <button disabled={plMesgul} onClick={kisitKaydet} style={plBtn}>Kısıtları kaydet</button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Faz 5 onay modalı */}
        {plModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !plMesgul) setPlModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(10,6,2,.7)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px', maxHeight: '88vh', overflowY: 'auto' }}>
              {plModal.tip === 'slot' && (
                <>
                  <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 12 }}>
                    {slotForm.id ? 'Slotu düzenle' : 'Yeni slot'}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 160 }}><label style={ekEtiket}>Şube</label>
                      <select value={slotForm.sube_id} onChange={(e) => setSlotForm((p) => ({ ...p, sube_id: e.target.value }))} style={ekAlanStil}>
                        <option value="">— seçin —</option>
                        {(vpGun?.subeler || []).map((x) => <option key={x.sube_id} value={x.sube_id}>{x.sube_ad || x.ad}</option>)}
                      </select></div>
                    <div style={{ minWidth: 150 }}><label style={ekEtiket}>Slot adı</label>
                      <input value={slotForm.ad} onChange={(e) => setSlotForm((p) => ({ ...p, ad: e.target.value }))} style={ekAlanStil} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div><label style={ekEtiket}>Başlangıç</label>
                      <input type="time" value={slotForm.baslangic_saat} onChange={(e) => setSlotForm((p) => ({ ...p, baslangic_saat: e.target.value }))} style={ekAlanStil} /></div>
                    <div><label style={ekEtiket}>Bitiş</label>
                      <input type="time" value={slotForm.bitis_saat} onChange={(e) => setSlotForm((p) => ({ ...p, bitis_saat: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 90 }}><label style={ekEtiket}>Min kişi</label>
                      <input type="number" min={0} value={slotForm.min_personel} onChange={(e) => setSlotForm((p) => ({ ...p, min_personel: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 90 }}><label style={ekEtiket}>İdeal kişi</label>
                      <input type="number" min={0} value={slotForm.ideal_personel} onChange={(e) => setSlotForm((p) => ({ ...p, ideal_personel: e.target.value }))} style={ekAlanStil} /></div>
                  </div>
                  <label style={ekEtiket}>Geçerli günler</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {[[1, 'Pzt'], [2, 'Sal'], [3, 'Çar'], [4, 'Per'], [5, 'Cum'], [6, 'Cmt'], [7, 'Paz']].map(([n, ad]) => {
                      const acik = (slotForm.aktif_gunler || []).includes(n);
                      return (
                        <button key={n} onClick={() => setSlotForm((p) => ({
                          ...p, aktif_gunler: acik ? p.aktif_gunler.filter((x) => x !== n) : [...(p.aktif_gunler || []), n].sort(),
                        }))} style={{
                          padding: '6px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
                          border: `1px solid ${acik ? R.bakir : R.cizgi3}`, background: acik ? `${R.bakir}22` : 'transparent',
                          color: acik ? R.bakir : R.not,
                        }}>{ad}</button>
                      );
                    })}
                  </div>
                  <label style={{ ...ekEtiket, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!slotForm.gece_vardiyasi}
                      onChange={(e) => setSlotForm((p) => ({ ...p, gece_vardiyasi: e.target.checked }))} />
                    Gece vardiyası (bitiş ertesi güne sarkar)
                  </label>
                </>
              )}
              {plModal.tip === 'uret' && (
                <>
                  <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Açılış-kapanıştan slot üret</div>
                  <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
                    Şubenin çalışma saatlerini alıp otomatik slot iskeleti kurar.
                    <b> Yenile</b> mevcut slotları değiştirir, <b>Ekle</b> üzerine ekler.
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 160 }}><label style={ekEtiket}>Şube</label>
                      <select value={plModal.sube_id} onChange={(e) => setPlModal((p) => ({ ...p, sube_id: e.target.value }))} style={ekAlanStil}>
                        <option value="">— seçin —</option>
                        {(vpGun?.subeler || []).map((x) => <option key={x.sube_id} value={x.sube_id}>{x.sube_ad || x.ad}</option>)}
                      </select></div>
                    <div><label style={ekEtiket}>Mod</label>
                      <select value={plModal.mod} onChange={(e) => setPlModal((p) => ({ ...p, mod: e.target.value }))} style={ekAlanStil}>
                        <option value="yenile">Yenile</option><option value="ekle">Ekle</option>
                      </select></div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ maxWidth: 110 }}><label style={ekEtiket}>Açılış (dk)</label>
                      <input type="number" value={plModal.acilis_dakika} onChange={(e) => setPlModal((p) => ({ ...p, acilis_dakika: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 110 }}><label style={ekEtiket}>Kapanış (dk)</label>
                      <input type="number" value={plModal.kapanis_dakika} onChange={(e) => setPlModal((p) => ({ ...p, kapanis_dakika: e.target.value }))} style={ekAlanStil} /></div>
                    <div style={{ maxWidth: 120 }}><label style={ekEtiket}>Normal slot (dk)</label>
                      <input type="number" value={plModal.normal_slot_dakika} onChange={(e) => setPlModal((p) => ({ ...p, normal_slot_dakika: e.target.value }))} style={ekAlanStil} /></div>
                  </div>
                </>
              )}
              {plModal.tip === 'slot-sil' && (
                <>
                  <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Slotu sil</div>
                  <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
                    <b>«{plModal.slot?.ad}»</b> slotu kaldırılır. Bu slota yapılmış atamalar
                    da düşer — plan yeniden kurulur.
                  </div>
                </>
              )}
              {plModal.tip === 'kilit' && (
                <>
                  <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
                    {plModal.kilitli ? 'Günü kilitle' : 'Gün kilidini aç'}
                  </div>
                  <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
                    {plModal.kilitli
                      ? 'Bu günün planı dondurulur; kimse atama ekleyip çıkaramaz. İstediğinde geri açabilirsin.'
                      : 'Plan yeniden değiştirilebilir hale gelir. Vardiya kesinleştiyse yeniden kilitlemeyi unutma.'}
                  </div>
                </>
              )}
              {plModal.tip === 'gecmis-kilit' && (
                <>
                  <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Geçmiş kilitlerini aç</div>
                  <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
                    Geçmiş günlerin planı düzenlenebilir hale gelir. Geçmişi değiştirmek
                    işçilik ve puan hesaplarını da etkiler — gerçekten gerekiyorsa yap.
                    PIN sunucuda doğrulanır.
                  </div>
                </>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                <button disabled={plMesgul} onClick={() => setPlModal(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Vazgeç</button>
                <button disabled={plMesgul} onClick={() => {
                  if (plModal.tip === 'slot') slotKaydet();
                  else if (plModal.tip === 'uret') slotUret();
                  else if (plModal.tip === 'slot-sil') slotSil();
                  else if (plModal.tip === 'kilit') gunKilitDegis(plModal.kilitli);
                  else if (plModal.tip === 'gecmis-kilit') gecmisKilitAc();
                }} style={{
                  padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                  border: plModal.tip === 'slot-sil' || plModal.tip === 'gecmis-kilit' ? `1px solid ${R.kirmizi}55` : 'none',
                  background: plModal.tip === 'slot-sil' || plModal.tip === 'gecmis-kilit' ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                  color: plModal.tip === 'slot-sil' || plModal.tip === 'gecmis-kilit' ? R.kirmizi : '#1C1309',
                }}>{plMesgul ? 'İşleniyor…' : 'Onayla'}</button>
              </div>
            </div>
          </div>
        )}

        {/* kopyala / temizle modalı */}
        {vpKopyaModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !vpMesgul) setVpKopyaModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Gün Planı Kopyala</div>
                <button onClick={() => !vpMesgul && setVpKopyaModal(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                <b>{kisaTarih(vpTarih)}</b> planı hedef güne kopyalanır (hedefin mevcut planı silinir).
              </div>
              <label style={ekEtiket}>Hedef gün</label>
              <input type="date" value={vpKopyaModal.hedef}
                onChange={(e) => setVpKopyaModal((f) => ({ ...f, hedef: e.target.value }))}
                style={{ ...ekAlanStil, colorScheme: 'dark' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                <button disabled={!!vpMesgul} onClick={vpGunTemizle} style={{
                  padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${R.kirmizi}55`, background: `${R.kirmizi}18`,
                  color: R.kirmizi, fontSize: 11.5, fontWeight: 700,
                }}>
                  {vpMesgul === 'temizle' ? 'Temizleniyor…' : `${kisaTarih(vpTarih)} planını temizle`}
                </button>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  <button disabled={!!vpMesgul} onClick={() => setVpKopyaModal(null)} style={{
                    padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>Vazgeç</button>
                  <button disabled={!!vpMesgul || !vpKopyaModal.hedef} onClick={() => vpGunKopyala(vpKopyaModal.hedef)} style={{
                    padding: '10px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                  }}>{vpMesgul === 'kopyala' ? 'Kopyalanıyor…' : 'Kopyala'}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── 3) Maaş & Avans ────────────────────────────────────────────────────────
  if (gorunum === 'maas') {
    // Sunucu kendi toplamını gönderiyor (`toplam_tahmini`) — istemcide yeniden
    // toplamak sunucunun kırpma/yuvarlama kurallarını ıskalayabilir (kart
    // limitinde tam bu tuzağa düşülmüştü). Sunucununki esas, yoksa hesapla.
    const toplamNet = bordroVeri?.toplam_tahmini != null
      ? sayi(bordroVeri.toplam_tahmini)
      : bordro.reduce((s, b) => s + sayi(b.hesaplanan_net), 0);
    const bekleyen = bordro.filter(b => b.durum && !['odendi', 'onayli'].includes(b.durum));
    // ⚠️ `avans.toplam` diye bir alan YOK (avans_service:527) — eski kod onu
    // arayıp her seferinde bordro vekiline düşüyordu. İki kavram FARKLI:
    //   avans_mahsup  = maaştan düşülecek MUHASEBE kalemi (bordro bilir)
    //   bekleyen/teslim_bekleyen = QR talep → onay → teslim akışının CANLI
    //   kuyruğu (bordro bunu göremez; para henüz çıkmamış olabilir)
    // Mahsup toplamı doğru amaçla kalıyor, canlı kuyruk AYRI kartlara geldi.
    const toplamAvans = bordro.reduce((s, b) => s + sayi(b.avans_mahsup), 0);
    const avansBekleyen = sayi(avans?.bekleyen_adet);
    const avansTeslimBekleyen = sayi(avans?.teslim_bekleyen_adet);
    const toplamFm = bordro.reduce((s, b) => s + sayi(b.fazla_mesai_saat), 0);
    return (
      <>
        <DonemSecici
          etiket={`${AY_KISA[ay - 1]} ${yil}`}
          onGeri={() => ayDegistir(-1)}
          onIleri={() => ayDegistir(1)}
          ileriKapali={yil === buYil && ay === buAy}
        />
        {/* silForm + syncOnay modalları personelModali parçasının içinde */}
        {personelModali}
        {/* Vardiya→maaş aktarımı: plan sonradan değiştiyse bordroyu tazeler */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <button onClick={() => setSyncOnay(true)} style={{
            padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
            background: 'transparent', color: R.metin2,
          }}>🔄 Vardiya verisini maaşa aktar</button>
        </div>
        <KpiSeridi kpiler={[
          { etiket: `${AY_KISA[ay - 1]} bordro`, deger: fmt(toplamNet), alt: `${bordro.length} kişi · hesaplanan net` },
          { etiket: 'Onay bekleyen', deger: String(bekleyen.length), alt: bekleyen.length ? 'taslak bordro' : 'hepsi onaylı', renk: bekleyen.length ? R.amber : R.yesil },
          { etiket: 'Avans mahsubu', deger: fmt(toplamAvans), alt: 'bu ay maaştan düşülecek', renk: R.krem },
          {
            etiket: 'Onay bekleyen avans',
            deger: avansBekleyen ? String(avansBekleyen) : '—',
            alt: avansBekleyen ? `${fmt(sayi(avans?.bekleyen_tutar))} · QR talebi` : 'bekleyen talep yok',
            renk: avansBekleyen ? R.amber : R.yesil,
          },
          {
            etiket: 'Teslim bekleyen',
            deger: avansTeslimBekleyen ? String(avansTeslimBekleyen) : '—',
            alt: avansTeslimBekleyen
              ? `${fmt(sayi(avans?.teslim_bekleyen_tutar))} · onaylandı, para verilmedi`
              : (sayi(avans?.bu_ay_odenen) ? `bu ay ${fmt(sayi(avans.bu_ay_odenen))} ödendi` : 'teslim bekleyen yok'),
            renk: avansTeslimBekleyen ? R.kirmizi : R.yesil,
          },
          { etiket: 'Fazla mesai', deger: `${trSayi(toplamFm, 0)} sa`, alt: 'bu ay toplam', renk: toplamFm > 0 ? R.kirmizi : R.krem },
        ]} />
        {bordro.length ? (
          <Tablo
            baslik={`Maaş & avans · ${AY_KISA[ay - 1]} ${yil}`}
            not="satıra tıkla → bordro dosyası"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Ücret', sag: true }, { ad: 'Fazla mesai', sag: true },
              { ad: 'Avans', sag: true }, { ad: 'Net', sag: true }, { ad: 'Aşama' },
            ]}
            satirlar={bordro.map(b => ({
              id: b.personel_id, _b: b,
              hucreler: [
                { v: b.ad_soyad, kalin: true },
                { v: ucretMetni(b), mono: true, sag: true },
                { v: b.fazla_mesai_saat ? `${trSayi(b.fazla_mesai_saat)} sa` : '—', mono: true, sag: true, renk: sayi(b.fazla_mesai_saat) > 8 ? R.kirmizi : R.krem },
                { v: b.avans_mahsup ? fmt(b.avans_mahsup) : '—', mono: true, sag: true, renk: sayi(b.avans_mahsup) ? R.amber : R.not },
                { v: fmt(sayi(b.hesaplanan_net)), mono: true, sag: true, kalin: true },
                { v: asamaAd(b.durum), rozet: ASAMA_RENK[b.durum] || R.amber },
              ],
            }))}
            onSatir={(row) => {
              const b = row._b;
              onCekmece?.({
                tip: 'BORDRO DOSYASI',
                baslik: b.ad_soyad,
                alt: `${AY_KISA[ay - 1]} ${yil} · ${asamaAd(b.durum)}`,
                kpi: [
                  { etiket: 'Hesaplanan net', deger: fmt(sayi(b.hesaplanan_net)), renk: R.yesil },
                  { etiket: 'Ücret', deger: ucretMetni(b) },
                  { etiket: 'Çalışma saati', deger: b.calisma_saati ? `${trSayi(b.calisma_saati, 0)} sa` : '—' },
                  { etiket: 'Fazla mesai', deger: b.fazla_mesai_saat ? `${trSayi(b.fazla_mesai_saat)} sa` : '—', renk: sayi(b.fazla_mesai_saat) > 8 ? R.kirmizi : R.krem },
                ],
                listeBaslik: 'Kırılım',
                satirlar: [
                  { ad: 'Avans mahsubu', detay: 'bu ay düşülen', tutar: fmt(sayi(b.avans_mahsup)) },
                  { ad: 'Mahsup devri', detay: 'sonraki aya taşan', tutar: fmt(sayi(b.mahsup_devir)) },
                  { ad: 'Eksik gün', detay: 'devamsızlık', tutar: b.eksik_gun ? `${trSayi(b.eksik_gun, 0)} gün` : '—' },
                  { ad: 'Manuel düzeltme', detay: b.not_aciklama || 'not yok', tutar: fmt(sayi(b.manuel_duzeltme)) },
                  // Ödeme planının KENDİ durumu — kayıt `durum`undan ayrı kavram
                  // (bordro onaylı olabilir ama para henüz çıkmamış olabilir).
                  ...(b.odeme_durumu ? [{
                    ad: 'Ödeme durumu',
                    detay: b.odeme_tarihi ? `${kisaTarih(b.odeme_tarihi)} tarihli plan` : 'plan tarihi yok',
                    tutar: String(b.odeme_durumu),
                  }] : []),
                  // Vardiya kaynağı: kanonik saat sunucudan gelir. `calisma_saati`
                  // ile ayrışıyorsa bordroda elle düzeltme yapılmış demektir.
                  ...(b.vardiya_ay_toplam_saat != null ? [{
                    ad: 'Vardiya kaynağı (ay)',
                    detay: sayi(b.vardiya_ay_toplam_saat) !== sayi(b.calisma_saati)
                      ? `⚠ bordrodaki ${trSayi(sayi(b.calisma_saati), 0)} sa ile ayrışıyor — elle düzeltilmiş olabilir`
                      : 'bordrodaki saatle birebir',
                    tutar: `${trSayi(sayi(b.vardiya_ay_toplam_saat), 0)} sa`,
                  }] : []),
                  ...(sayi(b.vardiya_ek_mesai_saat) > 0 ? [{
                    ad: 'Haftalık limit üstü',
                    detay: `haftalık limit ${trSayi(sayi(b.vardiya_haftalik_limit), 0)} sa`,
                    tutar: `${trSayi(sayi(b.vardiya_ek_mesai_saat))} sa`,
                  }] : []),
                ],
                not: 'Hesap maaş çekirdeğinin (maas_service) tekelindedir — buradaki düğmeler o çekirdeğin açtığı kapılardır, yeni bir para yolu değil. Ödeme kasa izine yazılır.',
                aksiyonlar: bordroAksiyonlari(b),
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için bordro kaydı bulunamadı.
          </div>
        )}

        {/* ── YERLİ BORDRO İŞLEMİ (köprü kalktı 2026-07-30) ─────────────────── */}
        {bModal && (() => {
          const { tip, b, form } = bModal;
          const BASLIK = {
            doldur: 'Vardiyadan doldur', kaydet: 'Bordroyu düzelt', onayla: 'Bordroyu onayla',
            ode: 'Maaş ödemesi', kilit: 'Kilidi aç', sil: 'Aylık kaydı sil',
          }[tip];
          const ANLAT = {
            doldur: 'Vardiya defterindeki gerçekleşen saatler bu aya aktarılır ve net yeniden hesaplanır. Elle girdiğin düzeltmeler EZİLİR.',
            kaydet: 'Girdiğin değerler maaş çekirdeğine gider, net orada hesaplanır. Buradaki alanlar hesabın girdisidir — sonucu değil.',
            onayla: 'Tutar KİLİTLENİR ve ödeme planı açılır. Onaydan sonra düzeltme ancak kilidi açarak yapılır.',
            ode: 'Kasadan düşülür ve kasa izine yazılır. Kasa izi tek gerçektir — bu adım geri alınmaz.',
            kilit: 'Kayıt taslağa döner, düzeltip yeniden onaylayabilirsin. ÖDENMİŞ kayıt açılmaz.',
            sil: 'Bu ayın bordro kaydı silinir, personel taslak duruma döner. Geçmiş aylar etkilenmez.',
          }[tip];
          const TEHLIKE = tip === 'ode' || tip === 'sil';
          const alan = (k, etiket, ipucu) => (
            <div style={{ flex: '1 1 140px' }}>
              <label style={ekEtiket}>{etiket}</label>
              <input value={form[k]} inputMode="decimal" placeholder={ipucu || '0'}
                onChange={(e) => setBModal((m) => ({ ...m, form: { ...m.form, [k]: e.target.value } }))}
                style={ekAlanStil} />
            </div>
          );
          return (
            <div onClick={(e) => { if (e.target === e.currentTarget && !bMesgul) setBModal(null); }} style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}>
              <div style={{ ...kartYuzey, width: tip === 'kaydet' ? 600 : 460, maxWidth: '96vw', padding: '24px 26px', maxHeight: '90vh', overflowY: 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>{BASLIK}</div>
                  <button onClick={() => !bMesgul && setBModal(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                  <b>{b.ad_soyad}</b> · {AY_KISA[ay - 1]} {yil} · hesaplanan net <b style={{ color: R.yesil }}>{fmt(sayi(b.hesaplanan_net))}</b>
                </div>
                <div style={{ fontSize: 12, color: R.not, lineHeight: 1.65, marginBottom: 16 }}>{ANLAT}</div>

                {tip === 'kaydet' && (
                  <>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {alan('calisma_saati', 'Çalışma saati')}
                      {alan('fazla_mesai_saat', 'Fazla mesai (sa)')}
                      {alan('bayram_mesai_saat', 'Bayram mesai (sa)')}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {alan('eksik_gun', 'Eksik gün')}
                      {alan('raporlu_gun', 'Raporlu gün')}
                      {alan('manuel_duzeltme', 'Manuel düzeltme (₺)', '± tutar')}
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: R.metin2, margin: '6px 0 12px' }}>
                      <input type="checkbox" checked={!!form.rapor_kesinti}
                        onChange={(e) => setBModal((m) => ({ ...m, form: { ...m.form, rapor_kesinti: e.target.checked } }))} />
                      Raporlu günler ücretten kesilsin
                    </label>
                    <label style={ekEtiket}>Not (düzeltmenin gerekçesi)</label>
                    <input value={form.not_aciklama} placeholder="neden elle düzeltildi?"
                      onChange={(e) => setBModal((m) => ({ ...m, form: { ...m.form, not_aciklama: e.target.value } }))}
                      style={ekAlanStil} />
                  </>
                )}

                {tip === 'ode' && !b.odeme_id && (
                  <div style={{ fontSize: 12, color: R.amber, marginBottom: 12 }}>
                    ⚠️ Bu bordroda ödeme planı yok — önce onaylanması gerekir.
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                  <button disabled={bMesgul} onClick={() => setBModal(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>Vazgeç</button>
                  <button disabled={bMesgul || (tip === 'ode' && !b.odeme_id)} onClick={bYap} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: TEHLIKE ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                    color: TEHLIKE ? R.kirmizi : '#1C1309', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                  }}>{bMesgul ? 'İşleniyor…' : BASLIK}</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Geçmiş aylar — salt-okur */}
        {bGecmis && (
          <div onClick={(e) => { if (e.target === e.currentTarget) setBGecmis(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 520, maxWidth: '96vw', padding: '24px 26px', maxHeight: '86vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>{bGecmis.ad} · geçmiş</div>
                <button onClick={() => setBGecmis(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              {bGecmis.satirlar === null ? (
                <div style={{ fontSize: 12.5, color: R.not }}>Yükleniyor…</div>
              ) : bGecmis.satirlar.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not }}>Geçmiş aylık kayıt yok.</div>
              ) : bGecmis.satirlar.map((g, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 0',
                  borderBottom: `1px solid ${R.cizgi3}`, fontSize: 12.5,
                }}>
                  <span style={{ color: R.metin2, minWidth: 82 }}>{AY_KISA[(Number(g.ay) || 1) - 1]} {g.yil}</span>
                  <span style={{ color: R.not, fontSize: 11.5 }}>{g.durum || '—'}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{fmt(sayi(g.hesaplanan_net))}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  // ── 4) Görev Takibi ────────────────────────────────────────────────────────
  if (gorunum === 'gorev') {
    const toplam = gorevOzet.reduce((s, g) => s + sayi(g.toplam), 0);
    const tamam = gorevOzet.reduce((s, g) => s + sayi(g.tamamlanan), 0);
    const acik = toplam - tamam;
    const subeGrup = {};
    gorevOzet.forEach(g => {
      const k = g.sube_adi || '—';
      if (!subeGrup[k]) subeGrup[k] = { ad: k, toplam: 0, tamam: 0, bloklar: [] };
      subeGrup[k].toplam += sayi(g.toplam);
      subeGrup[k].tamam += sayi(g.tamamlanan);
      subeGrup[k].bloklar.push({ tip: g.vardiya_tip, toplam: sayi(g.toplam), tamam: sayi(g.tamamlanan) });
    });
    const subeler = Object.values(subeGrup).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
    const gorevGunEtiket = `${Number(gorevTarih.slice(8, 10))} ${AY_KISA[Number(gorevTarih.slice(5, 7)) - 1]}`;
    return (
      <>
        <DonemSecici
          etiket={gorevTarih === bugun ? `Bugün · ${gorevGunEtiket}` : gorevGunEtiket}
          onGeri={() => gorevGunDegistir(-1)}
          onIleri={() => gorevGunDegistir(1)}
          ileriKapali={gorevTarih === bugun}
        />
        <KpiSeridi kpiler={[
          { etiket: gorevTarih === bugun ? 'Bugünkü görev' : `${gorevGunEtiket} görevi`, deger: String(toplam), alt: `${subeler.length} şube · vardiya blokları` },
          { etiket: 'Tamamlanan', deger: String(tamam), alt: toplam ? `%${trSayi((tamam / toplam) * 100, 0)}` : '—', renk: R.yesil },
          { etiket: 'Açık', deger: String(acik), alt: acik ? 'henüz işaretlenmedi' : 'hepsi kapandı', renk: acik ? R.amber : R.yesil },
          { etiket: 'Aktif kadro', deger: String(personel.length), alt: 'görev atanabilir personel', renk: R.krem },
        ]} />
        {subeler.length ? (
          <Tablo
            baslik={`Görev takibi · ${kisaTarih(bugun)}`}
            not="satıra tıkla → şubenin vardiya blokları"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Toplam görev', sag: true }, { ad: 'Tamamlanan', sag: true },
              { ad: 'Açık', sag: true }, { ad: 'Tamamlanma', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={subeler.map(s => {
              const oran = s.toplam ? (s.tamam / s.toplam) * 100 : 0;
              return {
                id: s.ad, _s: s,
                hucreler: [
                  { v: s.ad, kalin: true },
                  { v: String(s.toplam), mono: true, sag: true },
                  { v: String(s.tamam), mono: true, sag: true, renk: R.yesil },
                  { v: String(s.toplam - s.tamam), mono: true, sag: true, renk: s.toplam - s.tamam ? R.amber : R.not },
                  { v: `%${trSayi(oran, 0)}`, bar: oran, sag: true, renk: oran >= 90 ? R.yesil : oran >= 60 ? R.amber : R.kirmizi },
                  { v: oran >= 90 ? 'temiz' : oran >= 60 ? 'eksik var' : 'geride', rozet: oran >= 90 ? R.yesil : oran >= 60 ? R.amber : R.kirmizi },
                ],
              };
            })}
            onSatir={(row) => {
              const s = row._s;
              onCekmece?.({
                tip: 'ŞUBE GÖREVLERİ',
                baslik: s.ad,
                alt: `${kisaTarih(bugun)} · ${s.tamam}/${s.toplam} tamamlandı`,
                kpi: [
                  { etiket: 'Toplam', deger: String(s.toplam) },
                  { etiket: 'Açık', deger: String(s.toplam - s.tamam), renk: s.toplam - s.tamam ? R.amber : R.yesil },
                ],
                listeBaslik: 'Vardiya blokları',
                satirlar: s.bloklar.map(b => ({
                  ad: b.tip || 'vardiya',
                  detay: b.tamam === b.toplam ? 'tamam' : `${b.toplam - b.tamam} açık`,
                  tutar: `${b.tamam}/${b.toplam}`,
                })),
                not: 'Görevler QR ile personel telefonundan işaretlenir; kanıt fotoğrafı görev kaydında durur.',
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Bugün için görev şablonu bulunamadı.
          </div>
        )}
      </>
    );
  }

  // ── 5) Vardiya Takip (giriş-çıkış) ─────────────────────────────────────────
  if (gorunum === 'takip') {
    const satir = (takip || []).filter(t => t.aktif !== false);
    const toplamSaat = satir.reduce((s, t) => s + sayi(t.toplam_planlanan_saat), 0);
    const toplamGecikme = satir.reduce((s, t) => s + sayi(t.toplam_gecikme_dk), 0);
    const toplamFm = satir.reduce((s, t) => s + sayi(t.toplam_fazla_mesai_saat), 0);
    const gecikenler = satir.filter(t => sayi(t.toplam_gecikme_dk) > 0);
    // ⚠️ SAHİP YAKALADI (2026-07-31): klasik Vardiya Takip'te sistem hakedişi
    // HESAPLAYIP gösteriyordu; /gorev/vardiya-takip zaten `ucret_detay` +
    // `net_hakediş` döndürüyor ama v2 bu veriyi ATIYORDU. Geri kondu.
    // Yeni hesap YOK — sunucunun hesabı gösteriliyor. Bordronun kendisi
    // maas_service tekelinde; burası TAHMİNÎ hakediş penceresi.
    const netAl = (t) => sayi(t?.['net_hakediş'] ?? t?.ucret_detay?.['net_hakediş']);
    const toplamNet = satir.reduce((s, t) => s + netAl(t), 0);
    // Gün detayı (2026-08-01, okuma boşluğu #3): sunucu her gün için ayrı ayrı
    // gönderiyordu, v2 `gunler[]` dizisine hiç bakmıyordu.
    const analizler = satir.map((t) => ({ t, a: gunAnaliz(t) }));
    const girisYokGun = analizler.reduce((s, x) => s + x.a.girisYok.length, 0);
    const girisYokKisi = analizler.filter((x) => x.a.girisYok.length).length;
    const yemekKayipGun = analizler.reduce((s, x) => s + x.a.yemekKayip.length, 0);
    const yemekKayipKisi = analizler.filter((x) => x.a.yemekKayip.length).length;
    const partTamKisi = analizler.filter((x) => x.a.partTam.length).length;
    // Haftalık izin: sunucu hangi HAFTA olduğunu da söylüyordu; v2 yalnız sayıyı
    // kullanıyordu. İzinsiz hafta = yasal risk, kişisi ve haftası belli olmalı.
    const izinsizKisi = satir.filter((t) => sayi(t.haftalik_izin_kullanilmadi) > 0).length;
    return (
      <>
        <DonemSecici
          etiket={`${AY_KISA[ay - 1]} ${yil}`}
          onGeri={() => ayDegistir(-1)}
          onIleri={() => ayDegistir(1)}
          ileriKapali={yil === buYil && ay === buAy}
        />
        <KpiSeridi kpiler={[
          { etiket: 'Aylık toplam saat', deger: `${trSayi(toplamSaat, 0)} sa`, alt: `${satir.length} personel · ${AY_KISA[ay - 1]}` },
          { etiket: 'Toplam gecikme', deger: `${trSayi(toplamGecikme, 0)} dk`, alt: gecikenler.length ? `${gecikenler.length} personel` : 'gecikme yok', renk: toplamGecikme > 0 ? R.amber : R.yesil },
          { etiket: 'Fazla mesai', deger: `${trSayi(toplamFm, 0)} sa`, alt: 'plan üstü çalışma', renk: toplamFm > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Tahminî hakediş', deger: toplamNet > 0 ? fmt(toplamNet) : '—', alt: toplamNet > 0 ? `${satir.length} personel · bugüne kadar` : 'ücret verisi yok', renk: R.bakirAcik },
          {
            etiket: 'Giriş yok',
            deger: `${girisYokGun} gün`,
            alt: girisYokGun ? `${girisYokKisi} personel · vardiya planlı, yoklama yok` : 'her planlı günde giriş var',
            renk: girisYokGun ? R.kirmizi : R.yesil,
          },
          {
            etiket: 'Yemek hakkı kaybı',
            deger: `${yemekKayipGun} gün`,
            alt: yemekKayipGun ? `${yemekKayipKisi} personel · mola limiti aşıldı` : 'hak kaybı yok',
            renk: yemekKayipGun ? R.amber : R.yesil,
          },
        ]} />
        {satir.length ? (
          <Tablo
            baslik={`Vardiya takip · ${AY_KISA[ay - 1]} ${yil}`}
            not="satıra tıkla → hakediş kırılımı + gün gün iz defteri"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Çalışma türü' }, { ad: 'Planlanan saat', sag: true },
              { ad: 'Gecikme', sag: true }, { ad: 'Fazla mesai', sag: true },
              { ad: 'Tahminî hakediş', sag: true }, { ad: 'Uyarılar' },
            ]}
            satirlar={analizler.map(({ t, a }) => {
              const gec = sayi(t.toplam_gecikme_dk);
              const fm = sayi(t.toplam_fazla_mesai_saat);
              // Uyarılar TEK rozete ezilmez — üç ayrı sinyal üç ayrı haptır
              // (klasikte de ayrı ayrı duruyordu). En ağırından üçü gösterilir.
              const haplar = [];
              if (a.girisYok.length) haplar.push({ ad: `${a.girisYok.length} gün giriş yok`, renk: R.kirmizi });
              if (sayi(t.haftalik_izin_kullanilmadi) > 0) haplar.push({ ad: `${sayi(t.haftalik_izin_kullanilmadi)} hafta izinsiz`, renk: R.kirmizi });
              if (a.partTam.length) haplar.push({ ad: `${a.partTam.length} gün part-tam`, renk: R.amber });
              if (a.yemekKayip.length) haplar.push({ ad: `${a.yemekKayip.length} gün yemek kaybı`, renk: R.amber });
              if (fm > 8) haplar.push({ ad: `${trSayi(fm)} sa fazla mesai`, renk: R.kirmizi });
              if (gec > 30) haplar.push({ ad: 'gecikme yüksek', renk: R.amber });
              return {
                id: t.personel_id, _t: t, _a: a,
                hucreler: [
                  { v: t.ad_soyad, kalin: true },
                  { v: turAd(t.calisma_turu), renk: R.not },
                  { v: `${trSayi(t.toplam_planlanan_saat, 0)} sa`, mono: true, sag: true },
                  { v: gec ? `${trSayi(gec, 0)} dk` : '—', mono: true, sag: true, renk: gec > 30 ? R.kirmizi : gec > 0 ? R.amber : R.not },
                  { v: fm ? `${trSayi(fm)} sa` : '—', mono: true, sag: true, renk: fm > 8 ? R.kirmizi : R.krem },
                  { v: netAl(t) > 0 ? fmt(netAl(t)) : '—', mono: true, sag: true, kalin: true, renk: R.bakirAcik },
                  haplar.length
                    ? {
                      sira: haplar.length,
                      siraMetin: haplar.map((h) => h.ad).join(' '),
                      v: (
                        <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                          {haplar.slice(0, 3).map((h, i) => (
                            <span key={i} style={{
                              padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                              background: `${h.renk}22`, color: h.renk, whiteSpace: 'nowrap',
                            }}>{h.ad}</span>
                          ))}
                          {haplar.length > 3 && (
                            <span style={{ fontSize: 10.5, color: R.not2, alignSelf: 'center' }}>+{haplar.length - 3}</span>
                          )}
                        </span>
                      ),
                    }
                    : { v: 'normal', rozet: R.yesil, sira: 0 },
                ],
              };
            })}
            onSatir={(row) => {
              // Klasikteki ücret şelalesi — sunucunun ucret_detay'ı olduğu gibi
              const t = row._t;
              // ⚠️ fm/gec hücre map'inin kapsamındaydı; burada YENİDEN türetilir
              const fm = sayi(t.toplam_fazla_mesai_saat);
              const gec = sayi(t.toplam_gecikme_dk);
              const d = t.ucret_detay || {};
              const partTime = d.calisma_saati != null;
              const kalemler = [];
              if (partTime) {
                kalemler.push({ ad: 'Çalışılan saat', detay: `saatlik ${fmt(sayi(d.saatlik_ucret))}`, tutar: `${trSayi(sayi(d.calisma_saati))} sa` });
                kalemler.push({ ad: 'Normal ücret', detay: 'saat × saatlik ücret', tutar: fmt(sayi(d.normal_ucret)) });
              } else {
                kalemler.push({
                  ad: d.ay_tamam ? 'Taban maaş (tam ay)' : `Taban maaş · ${sayi(d.gecen_gun)}/${sayi(d.ay_gun)} gün`,
                  detay: d.ay_tamam ? 'aylık taban' : `günlük ${fmt(sayi(d.gunluk_ucret))} × ${sayi(d.gecen_gun)} gün`,
                  tutar: fmt(sayi(d.ay_tamam ? d.taban_maas : d.kazanilan_taban)),
                });
                if (sayi(d.fazla_mesai_saat) > 0) kalemler.push({
                  ad: 'Fazla mesai', detay: `${trSayi(sayi(d.fazla_mesai_saat))} sa × saatlik ${fmt(sayi(d.saatlik_ucret))}`,
                  tutar: fmt(sayi(d.fazla_mesai_ucret)),
                });
              }
              if (sayi(d.yemek_ucret) > 0 || sayi(t.yemek_ucret_gun) > 0) kalemler.push({
                ad: 'Yemek ücreti', detay: `${sayi(t.yemek_ucret_gun)} gün hak edildi · günlük ${fmt(sayi(d.yemek_ucret_birim))}`,
                tutar: fmt(sayi(d.yemek_ucret)),
              });
              if (sayi(d.yol_ucret) > 0) kalemler.push({
                ad: 'Yol ücreti', detay: d.yol_ucret_aylik ? `aylık ${fmt(sayi(d.yol_ucret_aylik))} · gün oranıyla` : 'gün oranıyla',
                tutar: fmt(sayi(d.yol_ucret)),
              });
              kalemler.push({ ad: 'Net hakediş', detay: 'bugüne kadar birikmiş', tutar: fmt(netAl(t)) });

              // ── GÜN DETAYINDAN GELEN SİNYALLER (sunucu gönderiyordu, v2 atıyordu)
              const a = row._a || gunAnaliz(t);
              if (a.girisYok.length) kalemler.push({
                ad: '⚠ Giriş kaydı olmayan gün',
                detay: `vardiya planlıydı, yoklama yok — ${a.girisYok.slice(0, 4).map((x) => kisaTarih(x.tarih)).join(', ')}${a.girisYok.length > 4 ? '…' : ''}`,
                tutar: `${a.girisYok.length} gün`,
              });
              if (a.yemekKayip.length) kalemler.push({
                ad: '⚠ Yemek ücreti hakkı kaybı',
                detay: `mola limiti aşıldığı için hak doğmadı — ${a.yemekKayip.slice(0, 4).map((x) => kisaTarih(x.tarih)).join(', ')}${a.yemekKayip.length > 4 ? '…' : ''}`,
                tutar: `${a.yemekKayip.length} gün`,
              });
              if (a.partTam.length) kalemler.push({
                ad: '⚠ Part-time personele tam gün',
                detay: 'part sayılıp ≥9,4 sa çalıştırılmış — çalışma türü gözden geçirilmeli',
                tutar: `${a.partTam.length} gün`,
              });
              if (sayi(t.haftalik_izin_kullanilmadi) > 0) kalemler.push({
                ad: '⚠ Kullanılmayan haftalık izin', detay: 'ücretli izin verilmeli — hakedişe dâhil değil',
                tutar: `${sayi(t.haftalik_izin_kullanilmadi)} gün`,
              });
              // Hangi HAFTA olduğu da sunucudan geliyordu; yalnız izinsiz haftalar
              // yazılır (izinli haftaları listelemek gürültü olurdu).
              (t.haftalik_izin_detay || []).filter((h) => h.izin_var === false).forEach((h) => {
                kalemler.push({
                  ad: `${kisaTarih(h.hafta)} haftası — izin YOK`,
                  detay: `${sayi(h.calisilan_gun)}/${sayi(h.toplam_gun)} gün çalışıldı`,
                  tutar: 'izin alacağı',
                });
              });

              // İz defteri: ay içindeki her planlı gün, yenisi üstte.
              const iz = [...a.tumu]
                .sort((x, y) => String(y.tarih).localeCompare(String(x.tarih)))
                .map((x) => {
                  const girisYok = !x.baslangic_gunu && x.giris_var === false;
                  const yemekKayip = x.yemek_sure_dk != null && !x.yemek_ucret_hakki;
                  return {
                    ad: `${kisaTarih(x.tarih)} · ${HAFTA[haftaGunu(x.tarih)]}`,
                    detay: gunCumle(x),
                    bekliyor: girisYok,
                    renk: girisYok ? R.kirmizi
                      : (yemekKayip || x.part_tam_uyari || sayi(x.gecikme_dk) > 30) ? R.amber
                        : R.yesil,
                  };
                });

              onCekmece?.({
                tip: 'HAKEDİŞ KIRILIMI',
                baslik: t.ad_soyad,
                alt: `${turAd(t.calisma_turu)} · ${AY_KISA[ay - 1]} ${yil} · ${a.tumu.length} planlı gün${
                  t.cikis_tarihi ? ` · çıkış ${kisaTarih(t.cikis_tarihi)}` : ''}`,
                kpi: [
                  { etiket: 'Net hakediş', deger: fmt(netAl(t)), renk: R.bakirAcik },
                  { etiket: 'Planlanan saat', deger: `${trSayi(sayi(t.toplam_planlanan_saat), 0)} sa` },
                  { etiket: 'Fazla mesai', deger: fm ? `${trSayi(fm)} sa` : '—', renk: fm > 8 ? R.kirmizi : R.krem },
                  {
                    etiket: 'Giriş yok',
                    deger: a.girisYok.length ? `${a.girisYok.length} gün` : '—',
                    renk: a.girisYok.length ? R.kirmizi : R.krem,
                  },
                ],
                listeBaslik: 'Ücret kırılımı + uyarılar',
                satirlar: kalemler,
                iz,
                // Gecikme varsa yönetici aksiyonu: eksik güne çevirme (soru yok,
                // modal açılır — ½/1 gün + not orada seçilir).
                aksiyonlar: gec > 0 ? [{
                  ad: `⏱ Gecikmeyi eksik güne çevir (${trSayi(gec, 0)} dk)`,
                  onTikla: () => setEksikGunModal({ t, gun: 0.5, not: '', mesgul: false }),
                }] : undefined,
                not: d.not
                  ? `${d.not} — bu TAHMİNÎ hakediştir, bordronun kendisi Ekip ▸ Maaş & Avans'ta onaylanır. Gün gün kayıt İz sekmesinde.`
                  : 'Bu TAHMİNÎ hakediş: vardiya kaydından türetilir, ay ilerledikçe artar. Ödenecek bordro Ekip ▸ Maaş & Avans\'ta onaylanır — iki sayı aynı olmak zorunda değil. Gün gün kayıt İz sekmesinde.',
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için vardiya takip kaydı yok.
          </div>
        )}

        {/* ── EKSİK GÜN MODALI (yazma-ucu turu) — klasik EksikGunModal karşılığı.
            Sunucu katmalı yazar: burada girilen ½/1 mevcut eksik güne EKLENİR. */}
        {eksikGunModal && (() => {
          const m = eksikGunModal;
          const kaydet = async () => {
            setEksikGunModal({ ...m, mesgul: true });
            try {
              await api('/gorev/gecikme-eksik-gun', {
                method: 'POST',
                body: {
                  personel_id: m.t.personel_id, yil, ay,
                  eksik_gun: m.gun, not_aciklama: m.not || null,
                },
              });
              onToast?.(`${m.t.ad_soyad}: ${m.gun === 0.5 ? '½' : '1'} eksik gün işlendi — net yeniden hesaplandı`);
              setEksikGunModal(null);
              api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}`)
                .then((vt) => setTakip(Array.isArray(vt) ? vt : (vt?.personeller || [])))
                .catch(() => {});
            } catch (e) {
              onToast?.(e?.message || 'İşlenemedi');
              setEksikGunModal({ ...m, mesgul: false });
            }
          };
          return (
            <div style={{
              position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
              backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}>
              <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
                <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 4 }}>
                  Gecikmeyi eksik güne çevir
                </div>
                <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.7, marginBottom: 14 }}>
                  <b>{m.t.ad_soyad}</b> · {AY_KISA[ay - 1]} {yil} · toplam gecikme{' '}
                  <b style={{ color: R.amber }}>{trSayi(sayi(m.t.toplam_gecikme_dk), 0)} dk</b>.
                  Bu bir <b>yönetici kararıdır</b>: seçilen gün mevcut eksik güne <b>eklenir</b>,
                  net maaş kanonik motorla yeniden hesaplanır. Onaylı bordro kilitliyse sunucu reddeder.
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {[0.5, 1].map((g) => (
                    <button key={g} onClick={() => setEksikGunModal({ ...m, gun: g })} style={{
                      flex: 1, padding: '11px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                      border: `1px solid ${m.gun === g ? R.bakir : R.cizgi3}`,
                      background: m.gun === g ? 'rgba(217,154,78,.16)' : R.girinti,
                      color: m.gun === g ? R.bakirAcik : R.metin2, fontWeight: 700, fontSize: 13.5,
                    }}>{g === 0.5 ? '½ gün' : '1 tam gün'}</button>
                  ))}
                </div>
                <input
                  value={m.not}
                  onChange={(e) => setEksikGunModal({ ...m, not: e.target.value })}
                  placeholder="Not (isteğe bağlı) — neden eksik gün sayıldı?"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '10px 13px', borderRadius: 10,
                    border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                    fontSize: 12.5, fontFamily: 'inherit', marginBottom: 16,
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button onClick={() => !m.mesgul && setEksikGunModal(null)} style={{
                    padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
                    background: 'transparent', color: R.not, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                  }}>Vazgeç</button>
                  <button onClick={kaydet} disabled={m.mesgul} style={{
                    padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: R.bakir, color: '#1d1207', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    opacity: m.mesgul ? 0.6 : 1,
                  }}>{m.mesgul ? 'İşleniyor…' : 'Eksik gün olarak işle'}</button>
                </div>
              </div>
            </div>
          );
        })()}
        {/* ── İZİN ALACAĞI (yerli — klasik derin takip bloğu) ── */}
        {(() => {
          const kisiler = Array.isArray(izin?.personeller) ? izin.personeller : [];
          const alacakli = kisiler.filter((k) => sayi(k.net_alacak_gun) > 0 || sayi(k.borclu_hafta_sayisi) > 0);
          if (!kisiler.length) return null;
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginTop: 14, marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
                paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12,
              }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>🏖 İzin alacağı</span>
                <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
                  {izin.baslangic ? `${kisaTarih(izin.baslangic)} – ${kisaTarih(izin.bitis)}` : 'dönem'} ·
                  haftalık izin hakkı ↔ verilen izin
                </span>
                <span style={{ fontSize: 11.5, color: alacakli.length ? R.amber : R.yesil, fontWeight: 700 }}>
                  {alacakli.length ? `${alacakli.length} kişide alacak/borç var` : 'hepsi dengede ✓'}
                </span>
              </div>
              {alacakli.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, padding: '8px 0' }}>
                  Bu dönemde izin alacağı biriken personel yok — haftalık izinler kullanılmış.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {alacakli.slice(0, 12).map((k) => (
                    <div key={k.personel_id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '9px 13px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <span style={{ flex: 1, minWidth: 150, fontSize: 12.5, fontWeight: 700 }}>{k.ad_soyad}</span>
                      <span style={{ fontSize: 11.5, color: R.not }}>
                        verilen izin <b style={{ fontFamily: F.mono, color: R.krem }}>{trSayi(sayi(k.verilen_izin_gun), 1)} gün</b>
                      </span>
                      {sayi(k.borclu_hafta_sayisi) > 0 && (
                        <span style={{ fontSize: 11.5, color: R.amber }}>
                          izinsiz hafta <b style={{ fontFamily: F.mono }}>{sayi(k.borclu_hafta_sayisi)}</b>
                        </span>
                      )}
                      <span style={{
                        fontFamily: F.mono, fontSize: 12.5, fontWeight: 700,
                        color: sayi(k.net_alacak_gun) > 0 ? R.kirmizi : R.yesil,
                      }}>
                        net {trSayi(sayi(k.net_alacak_gun), 1)} gün
                      </span>
                    </div>
                  ))}
                  {alacakli.length > 12 && (
                    <div style={{ fontSize: 11, color: R.not2, textAlign: 'center' }}>+{alacakli.length - 12} kişi daha</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── VARDİYA DIŞI GİRİŞLER (bugün) ── */}
        {(() => {
          const kayitlar = Array.isArray(vardiyaDisi) ? vardiyaDisi : [];
          return (
            <div style={{
              ...kartYuzey, padding: '14px 18px', marginBottom: 16,
              border: kayitlar.length ? `1px solid ${R.amber}55` : kartYuzey.border,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>🚪 Vardiya dışı giriş · bugün</span>
                <span style={{ fontSize: 11.5, color: R.not2, flex: 1 }}>
                  planında olmadığı halde panele giren personel
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  color: kayitlar.length ? R.amber : R.yesil,
                }}>
                  {kayitlar.length ? `${kayitlar.length} kayıt` : 'yok ✓'}
                </span>
              </div>
              {kayitlar.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 11 }}>
                  {kayitlar.slice(0, 8).map((k, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, color: R.metin2, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700 }}>{k.ad_soyad || k.personel_ad || '—'}</span>
                      <span style={{ color: R.not }}>{k.sube_adi || '—'}</span>
                      <span style={{ fontFamily: F.mono, color: R.not2 }}>{k.giris_saat || k.saat || ''}</span>
                      {k.aciklama && <span style={{ color: R.not }}>{k.aciklama}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {/* Bu görünümden de personel dosyası açılıyor → düzenle/çıkış modalları burada da gerekli */}
        {personelModali}
      </>
    );
  }

  // ── 6) İş Başvuruları ──────────────────────────────────────────────────────
  if (gorunum === 'basvuru') {
    const bs = basvurular;
    const yeni = bs.filter(b => trKucuk(b.durum) === 'yeni');
    const gorusme = bs.filter(b => trKucuk(b.durum).includes('görüş') || trKucuk(b.durum).includes('gorus'));
    return (
      <>
        {bvModalBlok}
        <KpiSeridi kpiler={[
          { etiket: 'Yeni başvuru', deger: String(basvuruOzet?.yeni ?? yeni.length), alt: 'okunmamış', renk: (basvuruOzet?.yeni ?? yeni.length) ? R.yesil : R.krem },
          { etiket: 'Görüşme aşamasında', deger: String(gorusme.length), alt: gorusme.length ? 'planlandı' : 'yok', renk: R.mavi },
          { etiket: 'Toplam başvuru', deger: String(bs.length), alt: 'arşivsiz kayıt' },
          { etiket: 'Öncelikli', deger: String(bs.filter(b => sayi(b.oncelik) > 0).length), alt: 'işaretlenmiş', renk: R.amber },
        ]} />
        {bs.length ? (
          <>
            {/* Faz 8: toplu arşiv çubuğu — seçim varken görünür */}
            {!!bvSecim.length && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
                borderRadius: 10, background: `${R.bakir}1A`, border: `1px solid ${R.bakir}44`,
                marginBottom: 12, fontSize: 12.5,
              }}>
                <b>{bvSecim.length} başvuru seçildi</b>
                <button onClick={() => setBvModal({ tip: 'toplu-arsiv' })} style={{
                  marginLeft: 'auto', padding: '7px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                }}>Seçilenleri arşivle</button>
                <button onClick={() => setBvSecim([])} style={{
                  padding: '7px 14px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                }}>Seçimi bırak</button>
              </div>
            )}
            <Liste
              secilebilir
              secili={bvSecim}
              onSec={(id) => setBvSecim((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
              onHepsi={() => setBvSecim((p) => (p.length === bs.length ? [] : bs.map((b) => b.id)))}
              satirlar={bs.slice(0, 40).map(b => {
                const d = trKucuk(b.durum) || 'yeni';
                const onc = sayi(b.oncelik);
                return {
                  id: b.id, _b: b,
                  baslik: `${onc ? `${onc === 1 ? '★' : '☆'} ` : ''}${b.ad_soyad || b.ad || 'Başvuru'}${b.pozisyon ? ` · ${b.pozisyon}` : ''}`,
                  alt: [b.sube_tercihi || b.sube, b.deneyim, b.olusturma ? kisaTarih(b.olusturma) : null,
                        b.arsivli ? 'arşivde' : null, b.personel_id ? 'işe alındı ✓' : null]
                    .filter(Boolean).join(' · ') || 'ayrıntı girilmemiş',
                  tutar: '',
                  rozet: BV_DURUM_AD[d] || d,
                  rozetRenk: d === 'yeni' ? R.yesil : d === 'olumlu' ? R.yesil : d === 'olumsuz' ? R.kirmizi : R.mavi,
                  tier: b.personel_id ? 'iyi' : d === 'yeni' ? 'uyari' : 'bilgi',
                  aksiyonlar: [{ ad: 'Yönet', onTikla: () => { bvGor(b); setBvModal({ tip: 'yonet', basvuru: b }); } }],
                };
              })}
              onAc={(r) => { bvGor(r?._b || r); setBvModal({ tip: 'yonet', basvuru: r?._b || r }); }}
            />
          </>
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Açık iş başvurusu yok.
          </div>
        )}
      </>
    );
  }

  // ── 7) Panel PIN & Görev QR ────────────────────────────────────────────────
  // ⚠️ TASARIM SAPMASI (bilinçli): blueprint ŞUBE başına tek panel PIN gösteriyor
  // ("••14"). Gerçekte PIN PERSONEL bazlı — her personelin kendi PIN'i var, şubenin
  // ortak PIN'i YOK. Uydurma şube PIN'i göstermek yerine tablo aynı biçimde ama
  // doğru içerikle kuruldu: şube başına kaç personelin PIN'i tanımlı, kaç yönetici.
  const subeGrup = {};
  pinler.forEach(p => {
    const k = p.sube_adi || 'Şube atanmamış';
    if (!subeGrup[k]) subeGrup[k] = { ad: k, toplam: 0, tanimli: 0, yonetici: 0, kisiler: [] };
    subeGrup[k].toplam += 1;
    if (p.panel_pin_tanimli) subeGrup[k].tanimli += 1;
    if (p.yonetici) subeGrup[k].yonetici += 1;
    subeGrup[k].kisiler.push(p);
  });
  const pinSube = Object.values(subeGrup).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
  // "Şube atanmamış" grubu tabloda kalır (personel kaybolmasın) ama ŞUBE SAYILMAZ.
  const gercekSube = pinSube.filter(s => s.ad !== 'Şube atanmamış').length;
  const toplamTanimli = pinler.filter(p => p.panel_pin_tanimli).length;
  const eksikPin = pinler.length - toplamTanimli;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'PIN tanımlı personel', deger: `${toplamTanimli} / ${pinler.length}`, alt: 'şube paneline girebilen', renk: eksikPin ? R.amber : R.yesil },
        { etiket: 'PIN eksik', deger: String(eksikPin), alt: eksikPin ? 'panele giremez' : 'hepsi tanımlı', renk: eksikPin ? R.amber : R.yesil },
        { etiket: 'Panel yöneticisi', deger: String(pinler.filter(p => p.yonetici).length), alt: 'cep override yetkisi', renk: R.krem },
        { etiket: 'Şube', deger: String(gercekSube), alt: 'PIN dağılımı', renk: R.krem },
      ]} />
      {pinSube.length ? (
        <Tablo
          baslik="Şube panel PIN durumu"
          not="PIN personel bazlıdır · satıra tıkla → şube kırılımı"
          kolonlar={[
            { ad: 'Şube' }, { ad: 'Personel', sag: true }, { ad: 'PIN tanımlı', sag: true },
            { ad: 'PIN eksik', sag: true }, { ad: 'Yönetici', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={pinSube.map(s => {
            const eksik = s.toplam - s.tanimli;
            return {
              id: s.ad, _s: s,
              hucreler: [
                { v: s.ad, kalin: true },
                { v: String(s.toplam), mono: true, sag: true },
                { v: String(s.tanimli), mono: true, sag: true, renk: R.yesil },
                { v: String(eksik), mono: true, sag: true, renk: eksik ? R.amber : R.not },
                { v: String(s.yonetici), mono: true, sag: true, renk: s.yonetici ? R.mavi : R.not },
                { v: eksik ? 'PIN eksik' : 'tamam', rozet: eksik ? R.amber : R.yesil },
              ],
            };
          })}
          onSatir={(row) => {
            const s = row._s;
            onCekmece?.({
              tip: 'ŞUBE PIN DURUMU',
              baslik: s.ad,
              alt: `${s.tanimli}/${s.toplam} personelin PIN'i tanımlı`,
              kpi: [
                { etiket: 'Personel', deger: String(s.toplam) },
                { etiket: 'PIN eksik', deger: String(s.toplam - s.tanimli), renk: s.toplam - s.tanimli ? R.amber : R.yesil },
              ],
              listeBaslik: 'Personel',
              satirlar: s.kisiler.map(k => ({
                ad: k.ad_soyad,
                detay: k.yonetici ? 'panel yöneticisi' : 'personel',
                tutar: k.panel_pin_tanimli ? 'PIN var' : 'PIN yok',
              })),
              not: 'Şube panelinin ortak PIN\'i yoktur — her personel kendi PIN\'iyle girer. PIN aşağıdaki personel tablosundan atanır.',
            });
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Panel PIN kaydı bulunamadı.
        </div>
      )}
      {/* ── YÖNETİCİ ONAY KAPISI (klasik kural aynen) ─────────────────────── */}
      {yoneticiVar && (
        <div style={{ ...kartYuzey, padding: '18px 22px', marginBottom: 16 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Panel yöneticisi onayı</div>
          <div style={{ fontSize: 12, color: R.not, lineHeight: 1.6, marginBottom: 12 }}>
            En az bir yönetici tanımlıyken PIN veya yönetici rolü değişikliği için bir yöneticinin kimliği ve PIN'i gerekir.
            Bu alan doldurulmadan aşağıdaki düğmeler iş yapmaz.
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <label style={ekEtiket}>Onaylayan yönetici</label>
              <select value={pinOnay.id} onChange={(e) => setPinOnay((o) => ({ ...o, id: e.target.value }))} style={ekAlanStil}>
                <option value="">Seçin</option>
                {pinler.filter(p => p.yonetici).map(p => (
                  <option key={p.id} value={p.id}>{p.ad_soyad}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: '0 0 130px' }}>
              <label style={ekEtiket}>Yönetici PIN</label>
              <input value={pinOnay.pin} placeholder="••••" inputMode="numeric" maxLength={4}
                onChange={(e) => setPinOnay((o) => ({ ...o, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                style={{ ...ekAlanStil, letterSpacing: '0.28em' }} />
            </div>
          </div>
        </div>
      )}
      {!yoneticiVar && pinler.length > 0 && (
        <div style={{ ...kartYuzey, padding: '14px 20px', marginBottom: 16, fontSize: 12, color: R.amber, lineHeight: 1.6 }}>
          İlk kurulum: henüz panel yöneticisi yok — PIN ve yönetici atamaları onaysız yapılabilir.
          İlk yöneticiyi işaretledikten sonra her değişiklik yönetici onayı ister.
        </div>
      )}

      {/* ── PERSONEL PIN TABLOSU — köprü kalktı, atama burada ──────────────── */}
      {pinler.length > 0 && (
        <Tablo
          baslik="Personel panel PIN'leri"
          not="satıra tıkla → PIN ata / yönetici yetkisi · aynı PIN tüm şubelerde geçerli"
          kolonlar={[{ ad: 'Ad soyad' }, { ad: 'Şube (kayıt)' }, { ad: 'PIN' }, { ad: 'Yönetici' }]}
          satirlar={pinler.map(p => ({
            id: p.id, _p: p,
            hucreler: [
              { v: p.ad_soyad, kalin: true },
              { v: p.sube_adi || '—', renk: R.not },
              { v: p.panel_pin_tanimli ? 'tanımlı' : 'yok', rozet: p.panel_pin_tanimli ? R.yesil : R.amber },
              { v: p.yonetici ? 'yönetici' : '—', renk: p.yonetici ? R.mavi : R.not },
            ],
          }))}
          onSatir={({ _p }) => onCekmece?.({
            tip: 'PANEL KİMLİĞİ',
            baslik: _p.ad_soyad,
            alt: `${_p.sube_adi || 'şube atanmamış'} · ${_p.panel_pin_tanimli ? 'PIN tanımlı' : 'PIN yok'}`,
            kpi: [
              { etiket: 'PIN', deger: _p.panel_pin_tanimli ? 'tanımlı' : 'yok', renk: _p.panel_pin_tanimli ? R.yesil : R.amber },
              { etiket: 'Yönetici', deger: _p.yonetici ? 'evet' : 'hayır', renk: _p.yonetici ? R.mavi : R.not },
              { etiket: 'Kayıt şubesi', deger: _p.sube_adi || '—' },
            ],
            listeBaslik: 'PIN neyi açar',
            satirlar: [
              { ad: 'Kasa kilidi', detay: 'şube paneli', tutar: 'PIN ister' },
              { ad: 'Kapanış onayı', detay: 'mühür adımı', tutar: 'PIN ister' },
              { ad: 'Vardiya devri', detay: 'kasa el değiştirme', tutar: 'PIN ister' },
            ],
            not: 'PIN personele aittir, şubeye değil — personel hangi şubede çalışırsa çalışsın aynı PIN geçerlidir. Yönetici yetkisi cep override kapısını açar.',
            aksiyonlar: [
              { ad: _p.panel_pin_tanimli ? '🔑 PIN değiştir' : '🔑 PIN ata', birincil: true, onTikla: () => setPinModal({ id: _p.id, ad: _p.ad_soyad, pin: '' }) },
              { ad: _p.yonetici ? '↓ Yönetici yetkisini kaldır' : '↑ Yönetici yap', onTikla: () => yoneticiDegistir(_p, !_p.yonetici) },
            ],
          })}
        />
      )}

      {/* ── ŞUBE QR KODLARI + KONUM (köprü kalktı 2026-07-30) ──────────────── */}
      <div style={{ ...kartYuzey, padding: '20px 24px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600 }}>Şube QR kodları</div>
          <div style={{ fontSize: 11.5, color: R.not }}>
            {qrListe === null ? 'yükleniyor…' : `${qrListe.filter(s => s.lat && s.lng).length}/${qrListe.length} şubede konum tanımlı`}
          </div>
          <button onClick={qrYukle} style={{
            marginLeft: 'auto', padding: '6px 13px', borderRadius: 9, cursor: 'pointer',
            border: `1px solid ${R.cizgi3}`, background: 'transparent', color: R.metin2,
            fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
          }}>↻ Yenile</button>
        </div>
        <div style={{ fontSize: 12, color: R.not, lineHeight: 1.65, marginBottom: 16 }}>
          Her şubenin kodunu kasaya asın — personel okutunca görev listesine düşer. Konum tanımlı değilse
          personel <b>herhangi bir yerden</b> giriş yapabilir; tanımlıysa sistem şubede olup olmadığını doğrular.
        </div>
        {qrListe === null ? (
          <div style={{ fontSize: 12.5, color: R.not, padding: '20px 0', textAlign: 'center' }}>QR kodlar hazırlanıyor…</div>
        ) : qrListe.length === 0 ? (
          <div style={{ fontSize: 12.5, color: R.not, padding: '20px 0', textAlign: 'center' }}>QR listesi alınamadı.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
            {qrListe.map(s => {
              const konumVar = !!(s.lat && s.lng);
              return (
                <div key={s.sube_id} style={{
                  border: `1px solid ${R.cizgi3}`, borderRadius: 14, padding: 16, textAlign: 'center',
                  background: 'rgba(255,255,255,.02)',
                }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>{s.sube_ad}</div>
                  <div style={{ background: '#fff', borderRadius: 10, padding: 9, display: 'inline-block', marginBottom: 12 }}>
                    <img src={s.qr_url} alt={`${s.sube_ad} QR`} style={{ width: 148, height: 148, display: 'block' }} />
                  </div>
                  <div style={{
                    fontSize: 11, marginBottom: 10,
                    color: konumVar ? R.yesil : R.amber,
                  }}>
                    {konumVar ? `📍 konum tanımlı · ±${s.konum_radius_m ?? 150}m` : '📍 konum tanımlı değil'}
                  </div>
                  <div style={{ display: 'flex', gap: 7, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <a href={s.qr_url} download={`${s.sube_ad}_qr.png`} style={{
                      padding: '6px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 600,
                      background: `${R.bakir}22`, color: R.bakir, border: `1px solid ${R.bakir}44`,
                      textDecoration: 'none',
                    }}>İndir</a>
                    <a href={s.giris_url} target="_blank" rel="noreferrer" style={{
                      padding: '6px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 600,
                      background: 'transparent', color: R.metin2, border: `1px solid ${R.cizgi3}`,
                      textDecoration: 'none',
                    }}>Önizle</a>
                    <button onClick={() => setQrModal({
                      sube_id: s.sube_id, sube_ad: s.sube_ad,
                      lat: s.lat ?? '', lng: s.lng ?? '', radius: s.konum_radius_m ?? 150, yapistir: '',
                    })} style={{
                      padding: '6px 12px', borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                      background: 'transparent', color: konumVar ? R.metin2 : R.amber,
                      border: `1px solid ${konumVar ? R.cizgi3 : `${R.amber}55`}`, fontFamily: 'inherit',
                    }}>Konum</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: R.not, lineHeight: 1.7, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${R.cizgi3}` }}>
          QR'sız giriş de mümkün — personel şu adresi telefona kaydedebilir:{' '}
          <a href={`${window.location.origin}/gorev-pin`} target="_blank" rel="noreferrer"
            style={{ color: R.mavi, fontWeight: 700, textDecoration: 'none' }}>
            {window.location.origin}/gorev-pin
          </a>
        </div>
      </div>

      {/* Sunucu mutasyon anahtarı — üretimde tanımlıysa gerekir */}
      <details style={{ ...kartYuzey, padding: '14px 20px', marginBottom: 16, fontSize: 12, color: R.metin2 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Sunucu mutasyon anahtarı (isteğe bağlı)</summary>
        <div style={{ fontSize: 11.5, color: R.not, lineHeight: 1.65, margin: '10px 0' }}>
          Sunucuda <code>EVVEL_MERKEZ_MUTASYON_ANAHTARI</code> tanımlıysa PIN/yönetici değişiklikleri
          <code> X-Evvel-Merkez-Key</code> başlığı ister. Anahtar yalnız bu tarayıcıda saklanır.
        </div>
        <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="password" autoComplete="off" placeholder="Sunucudakiyle aynı anahtar"
            value={merkezKey} onChange={(e) => setMerkezKey(e.target.value)}
            style={{ ...ekAlanStil, flex: '1 1 220px', marginBottom: 0 }} />
          <button onClick={merkezKeyKaydet} style={{
            padding: '9px 16px', borderRadius: 9, cursor: 'pointer', border: `1px solid ${R.cizgi3}`,
            background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          }}>Kaydet / temizle</button>
        </div>
      </details>

      {/* PIN atama modalı */}
      {pinModal && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !pinMesgul) setPinModal(null); }} style={{
          position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
          backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 400, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Panel PIN</div>
              <button onClick={() => !pinMesgul && setPinModal(null)} style={{
                marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
              <b>{pinModal.ad}</b> — bu PIN tüm şubelerdeki panel işlemlerinde kullanılır.
            </div>
            <label style={ekEtiket}>4 haneli PIN</label>
            <input value={pinModal.pin} placeholder="••••" inputMode="numeric" maxLength={4} autoFocus
              onChange={(e) => setPinModal((m) => ({ ...m, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
              style={{ ...ekAlanStil, letterSpacing: '0.3em', fontSize: 18, textAlign: 'center' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button disabled={pinMesgul} onClick={() => setPinModal(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={pinMesgul} onClick={pinKaydet} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{pinMesgul ? 'Kaydediliyor…' : 'PIN\'i kaydet'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Şube konum modalı */}
      {qrModal && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !qrMesgul) setQrModal(null); }} style={{
          position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
          backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 470, maxWidth: '96vw', padding: '24px 26px', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>{qrModal.sube_ad} · konum</div>
              <button onClick={() => !qrMesgul && setQrModal(null)} style={{
                marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: R.not, lineHeight: 1.65, marginBottom: 16 }}>
              Konum tanımlıysa QR ile giriş yalnız şubenin yakınından yapılabilir. En kolay yol:
              maps.google.com'da şubeye sağ tıkla → koordinatı kopyala → aşağıya yapıştır.
            </div>
            <label style={ekEtiket}>Google Maps koordinatı yapıştır</label>
            <input value={qrModal.yapistir} placeholder="37.1234567, 28.9876543"
              onChange={(e) => {
                const v = e.target.value;
                const m = v.match(/(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)/);
                setQrModal((q) => ({ ...q, yapistir: v, ...(m ? { lat: m[1], lng: m[2] } : {}) }));
              }}
              style={ekAlanStil} />
            <button onClick={() => {
              if (!navigator.geolocation) { onToast?.('Tarayıcı konum desteklemiyor'); return; }
              navigator.geolocation.getCurrentPosition(
                (pos) => setQrModal((q) => ({ ...q, lat: pos.coords.latitude.toFixed(7), lng: pos.coords.longitude.toFixed(7) })),
                () => onToast?.('Konum izni reddedildi — Maps yöntemini kullanın'),
                { enableHighAccuracy: true, timeout: 10000 },
              );
            }} style={{
              width: '100%', padding: '9px 12px', borderRadius: 9, cursor: 'pointer', marginBottom: 14,
              border: `1px solid ${R.cizgi3}`, background: 'transparent', color: R.metin2,
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            }}>📡 Şu anki GPS konumumu al</button>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={ekEtiket}>Enlem (lat)</label>
                <input value={qrModal.lat} onChange={(e) => setQrModal((q) => ({ ...q, lat: e.target.value }))} style={ekAlanStil} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={ekEtiket}>Boylam (lng)</label>
                <input value={qrModal.lng} onChange={(e) => setQrModal((q) => ({ ...q, lng: e.target.value }))} style={ekAlanStil} />
              </div>
            </div>
            <label style={ekEtiket}>İzin verilen mesafe — {qrModal.radius}m</label>
            <input type="range" min="50" max="500" step="25" value={qrModal.radius}
              onChange={(e) => setQrModal((q) => ({ ...q, radius: e.target.value }))}
              style={{ width: '100%', marginBottom: 4 }} />
            <div style={{ fontSize: 11, color: R.not, marginBottom: 14 }}>Küçük şubeler için 100m, büyük için 200m önerilir.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button disabled={qrMesgul} onClick={() => setQrModal(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={qrMesgul || !qrModal.lat || !qrModal.lng} onClick={konumKaydet} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{qrMesgul ? 'Kaydediliyor…' : 'Konumu kaydet'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
