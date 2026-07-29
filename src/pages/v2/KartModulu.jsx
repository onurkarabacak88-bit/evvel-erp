// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Kartlar & Borç modülü (5 görünüm)
//
// Tasarım: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html
//          ICERIK → kart.ozet / kart.kartlar / kart.koc / kart.hareket / kart.ekstre
//
// Bu modül, mevcut 7 dağınık kart sayfasının işini tek yerde toplar:
//   Kartlar · KartMerkez · KartYonetimi · KartAnaliz · KartEkstreAnaliz ·
//   KartHareketleri · EkstreYukle
//
// Veri uçları (hepsi salt-okur):
//   /kartlar                     → limit, döngü, kesim, son ödeme, asgari
//   /kartlar/borc-faiz-ozet      → kart bazlı borç + ödenen faiz + eksik ekstre
//   /kartlar/borc-kocu           → strateji sıralaması, asgari toplamı, öncelik
//   /kartlar/harcama-ozet        → işletme / şahsi / belirsiz kırılımı
//   /kart-hareketleri            → hareket defteri
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, Serit, BorcKocu } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');

// ⚠️ Türkçe büyük-İ tuzağı: JS'in varsayılan toLowerCase()'i 'İ' → 'i̇' (birleşik
// noktalı i) üretir, ekranda "geci̇kti̇" gibi bozuk çıkar. Daima tr yerelini kullan.
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');
// ⚠️ İKİ YÖNLÜ TÜRKÇE-I TUZAĞI:
//   trKucuk  → 'İ'yi doğru çevirir ama ASCII 'I'yı NOKTASIZ 'ı' yapar.
//              'FAIZ' → 'faız', 'CIRO' → 'cıro' (yanlış).
//   slugAd   → veritabanı slug'ları (ASCII, BÜYÜK, alt çizgili) için: düz
//              toLowerCase + alt çizgi → boşluk. 'ANLIK_GIDER' → 'anlik gider'.
// Kural: TÜRKÇE metinde trKucuk, DB SLUG'ında slugAd.
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
/** '2026-07-22' → '22 Tem' (tasarımdaki kısa tarih biçimi). */
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

/** Kart döngü durumu — tasarımdaki DONGU sabitinin veriden türetilmiş hâli. */
const DONGU = {
  gecikti: { ad: 'GECİKTİ', renk: R.kirmizi },
  ekstre_bekleniyor: { ad: 'EKSTRE BEKLENİYOR', renk: R.amber },
  odeme_bekliyor: { ad: 'Ödeme bekliyor', renk: R.mavi },
  odendi: { ad: 'Ödendi', renk: R.yesil },
  yuklendi: { ad: 'Yüklendi', renk: R.yesil },
};

/**
 * Bir kartın döngü durumunu belirler. Sıra önemli: gecikme her şeyin önünde,
 * ekstre eksikliği ödeme beklemenin önünde (borç tahminî olur).
 */
function donguDurumu(k, ekstreVar) {
  const gun = sayi(k.gun_kaldi);
  const borc = sayi(k.guncel_borc);
  const asgariTamam = !!k.asgari_karsilandi;
  if (borc > 0 && gun < 0 && !asgariTamam) return 'gecikti';
  if (!ekstreVar) return 'ekstre_bekleniyor';
  if (asgariTamam) return 'odendi';
  if (borc > 0 && gun <= 5) return 'odeme_bekliyor';
  return 'yuklendi';
}

const gunMetni = (g) => {
  const n = Math.trunc(sayi(g));
  if (n < 0) return `${Math.abs(n)} gün geçti`;
  if (n === 0) return 'bugün';
  return `${n} gün`;
};

export default function KartModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [ozet, setOzet] = useState(null);
  const [harcama, setHarcama] = useState(null);
  const [hareketler, setHareketler] = useState([]);
  const [koc, setKoc] = useState(null);
  const [strateji, setStrateji] = useState('cig');
  const [nakit, setNakit] = useState(200000);
  // ── YERLİ EKSTRE YÜKLEME (köprü kaldırma turu, 2026-07-30) ─────────────────
  // Klasik EkstreYukle.jsx akışı AYNEN: PDF → /kartlar/ekstre-yukle (önizleme,
  // kayıt yazmaz) → ⚡ tek-tık mutabakat (import + eşik-onaylı devir kapama).
  const [eksModal, setEksModal] = useState(false);
  const [eksYukleniyor, setEksYukleniyor] = useState(false);
  const [eksSonuc, setEksSonuc] = useState(null);
  const [eksHata, setEksHata] = useState('');
  const [eksDosyaAdi, setEksDosyaAdi] = useState('');
  const [eksLastFile, setEksLastFile] = useState(null);
  const [eksTtBusy, setEksTtBusy] = useState(false);
  const [eksImpSonuc, setEksImpSonuc] = useState(null);
  const [eksOnaySor, setEksOnaySor] = useState(null);   // eşik üstü fark onayı {fark, ekstreBorc, yeniBorc, impOzet}
  const [kartEkleBusy, setKartEkleBusy] = useState(false);
  const [manForm, setManForm] = useState(null);          // manuel ekstre {kart_id, donem, son_odeme, donem_borcu, asgari_tutar, faiz_orani}
  const [manBusy, setManBusy] = useState(false);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/kartlar').catch(() => []),
      api('/kartlar/borc-faiz-ozet').catch(() => null),
      api('/kartlar/harcama-ozet').catch(() => null),
      api('/kart-hareketleri?limit=200').catch(() => []),
    ]).then(([k, o, h, hr]) => {
      setKartlar(Array.isArray(k) ? k : []);
      setOzet(o);
      setHarcama(h);
      setHareketler(Array.isArray(hr) ? hr : []);
      if (!o && !(Array.isArray(k) && k.length)) setHata('Kart verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  useEffect(yukle, []);

  // Borç Koçu ayrı uç — strateji/nakit değişince tazelenir.
  useEffect(() => {
    let iptal = false;
    api(`/kartlar/borc-kocu?strateji=${strateji}&nakit=${sayi(nakit)}`)
      .then(d => { if (!iptal) setKoc(d); })
      .catch(() => { if (!iptal) setKoc(null); });
    return () => { iptal = true; };
  }, [strateji, nakit]);

  /** borc-faiz-ozet satırlarını kart id'siyle eşler — ekstre durumu oradan gelir. */
  const ozetMap = useMemo(() => {
    const m = {};
    (ozet?.kartlar || []).forEach(r => { m[String(r.kart_id)] = r; });
    return m;
  }, [ozet]);

  const kartSatir = useMemo(() => kartlar.map(k => {
    const o = ozetMap[String(k.id)] || {};
    const ekstreVar = o.bu_ay_ekstre_var != null ? !!o.bu_ay_ekstre_var : !!k.ekstre_gercek;
    const limit = sayi(k.limit_tutar);
    const borc = sayi(k.guncel_borc);
    return {
      id: String(k.id),
      ad: k.kart_adi || k.banka || 'Kart',
      sahip: k.sahip || 'İşletme',
      donem: sayi(o.guncel_borc ?? k.donem_borcu ?? borc),
      taksit: sayi(o.gelecek_taksit_anapara ?? k.gelecek_taksit_anapara),
      toplam: sayi(o.toplam_borc_taksitli ?? k.toplam_borc_taksitli ?? borc),
      odenenFaiz: sayi(o.toplam_odenen_faiz),
      limit,
      kullanim: limit ? Math.min(100, (borc / limit) * 100) : 0,
      faizYillik: sayi(k.faiz_orani),
      kesim: k.kesim_gunu,
      sonOdeme: k.aktif_son_odeme || k.son_odeme_tarihi,
      gunKaldi: sayi(k.gun_kaldi),
      asgari: sayi(k.asgari_odeme),
      asgariKarsilandi: !!k.asgari_karsilandi,
      ekstreVar,
      durum: donguDurumu(k, ekstreVar),
    };
  }), [kartlar, ozetMap]);

  const toplamAsgari = koc ? sayi(koc.toplam_asgari) : kartSatir.reduce((s, k) => s + k.asgari, 0);

  // ── ortak: kart dosyası çekmecesi ──────────────────────────────────────────
  const kartAc = (k) => onCekmece?.({
    tip: 'KART DOSYASI',
    baslik: k.ad,
    alt: `${k.sahip} · ${trKucuk(DONGU[k.durum].ad)}`,
    kpi: [
      { etiket: 'Toplam borç', deger: fmt(k.toplam), renk: R.kirmizi },
      { etiket: 'Dönem borcu', deger: fmt(k.donem) },
      { etiket: 'Asgari', deger: fmt(k.asgari), renk: k.asgariKarsilandi ? R.yesil : R.amber },
      { etiket: 'Ödenen faiz', deger: fmt(k.odenenFaiz), renk: R.amber },
    ],
    listeBaslik: 'Limit ve döngü',
    satirlar: [
      { ad: 'Limit', detay: `kullanım %${trSayi(k.kullanim, 0)}`, tutar: fmt(k.limit) },
      { ad: 'Gelecek taksit anaparası', detay: 'sonraki dönemlere yayılı', tutar: fmt(k.taksit) },
      { ad: 'Yıllık faiz', detay: k.faizYillik > 0 ? 'sözleşme oranı' : 'girilmemiş', tutar: k.faizYillik > 0 ? `%${trSayi(k.faizYillik)}` : '—' },
      { ad: 'Kesim günü', detay: `ayın ${k.kesim}`, tutar: gunMetni(k.gunKaldi) },
    ],
    not: k.ekstreVar
      ? 'Bu dönem ekstresi yüklü — rakamlar ekstreyle doğrulandı.'
      : 'Bu dönem ekstresi YÜKLENMEDİ — Ekstre Durumu görünümünden PDF yükleyin.',
    aksiyonAd: k.ekstreVar ? 'Kart yönetimini aç' : 'Ekstre durumuna git',
    _hedef: k.ekstreVar ? 'kart-yonetimi' : '__gorunum:ekstre',
  });

  // ── ekstre yükleme fonksiyonları (klasik EkstreYukle.jsx sözleşmesi) ───────
  const BANKA_AD = { axess: 'Axess', worldcard: 'Yapı Kredi', enpara: 'Enpara', ziraat: 'Ziraat', garanti: 'Garanti' };
  const FORMAT_AD = { worldcard: 'Worldcard / Yapı Kredi', enpara: 'Enpara', axess: 'Axess / Akbank', ziraat: 'Ziraat Bankkart', garanti: 'Garanti Bonus' };
  const gunCikar = (d) => {
    const s = String(d || '');
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return parseInt(m[3], 10);
    m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (m) return parseInt(m[1], 10);
    return 1;
  };

  const eksAc = () => {
    setEksModal(true);
    setEksSonuc(null); setEksHata(''); setEksDosyaAdi(''); setEksImpSonuc(null);
    setEksOnaySor(null); setManForm(null);
  };

  const eksDosyaYukle = async (file) => {
    if (!file) return;
    setEksLastFile(file);
    setEksDosyaAdi(file.name);
    setEksHata(''); setEksSonuc(null); setEksImpSonuc(null); setEksOnaySor(null);
    setEksYukleniyor(true);
    const fd = new FormData();
    fd.append('dosya', file);
    try {
      // api util JSON gövde varsayar — dosya için düz fetch (klasik desen)
      const res = await fetch('/api/kartlar/ekstre-yukle', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ayrıştırılamadı');
      setEksSonuc(data);
    } catch (e) {
      setEksHata(e?.message || 'Dosya işlenemedi');
    } finally {
      setEksYukleniyor(false);
    }
  };

  /** İmport sonrası kalan farkı devirle kapat + sonucu işle (ortak kuyruk). */
  const eksDevirVeBitir = async (impOzet, yeniBorcIn, devirGerekli) => {
    const kart = eksSonuc?.eslesen_kart;
    const ekstreBorc = eksSonuc?.mutabakat?.ekstre_borc ?? eksSonuc?.donem_borcu ?? 0;
    let yeniBorc = yeniBorcIn;
    let devirYapildi = false; let devirDuzeltme = 0;
    if (devirGerekli) {
      const r2 = await fetch(`/api/kartlar/${kart.id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: eksSonuc.kesim_tarihi, son_odeme: eksSonuc.son_odeme_tarihi || null,
          donem_borcu: eksSonuc.donem_borcu, asgari_tutar: eksSonuc.asgari_tutar || null,
          faiz_orani: eksSonuc.akdi_faiz_yillik || null,
        }),
      });
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2.detail || 'Mutabakat düzeltmesi yapılamadı');
      devirDuzeltme = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      yeniBorc = d2.yeni_borc; devirYapildi = true;
    }
    const sonFark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
    setEksSonuc((sn) => ({ ...sn, mutabakat: { ...sn.mutabakat, sistem_borc: yeniBorc, fark: sonFark, tutar_uyumlu: Math.abs(sonFark) < 1 } }));
    setEksImpSonuc({ ...impOzet, tek_tik: true, devir: devirYapildi, devir_duzeltme: devirDuzeltme, yeni_sistem_borc: yeniBorc, buyuk_fark_onay_gerek: Math.abs(sonFark) > 1 });
    onToast?.('⚡ Mutabakat tamam — kart borcu ekstreyle eşitlendi');
    yukle();  // kart listesi/rozetler tazelensin
  };

  /** ⚡ TEK TIK MUTABAKAT — klasik mantık aynen: import → eşik-onaylı devir. */
  const eksTekTik = async () => {
    const kart = eksSonuc?.eslesen_kart;
    if (!kart?.id || !eksSonuc) return;
    setEksTtBusy(true); setEksHata(''); setEksImpSonuc(null); setEksOnaySor(null);
    try {
      const islemler = (eksSonuc.islemler || []).filter((x) => x && x.durum === 'yeni')
        .map((x) => ({ tarih: x.tarih, tutar: x.tutar, tip: x.tip, aciklama: x.aciklama,
                       kategori: x.kategori, harcama_tipi: x.oneri_tipi || undefined,
                       taksit_sayisi: x.taksit_sayisi || undefined,
                       taksit_anapara: x.taksit_anapara || undefined }));
      let yeniBorc = eksSonuc?.mutabakat?.sistem_borc;
      let impOzet = { yazilan: 0, atlanan_veya_mevcut: 0 };
      if (islemler.length) {
        const r1 = await fetch('/api/kartlar/ekstre-import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kart_id: kart.id, islemler }),
        });
        const d1 = await r1.json();
        if (!r1.ok) throw new Error(d1.detail || 'İçe aktarılamadı');
        impOzet = d1; yeniBorc = d1.yeni_sistem_borc;
      }
      const ekstreBorc = eksSonuc?.mutabakat?.ekstre_borc ?? eksSonuc?.donem_borcu ?? 0;
      const fark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      const esik = Math.max(5000, Math.abs(ekstreBorc) * 0.05);
      if (Math.abs(fark) > 1 && Math.abs(fark) > esik) {
        // Eşik üstü — kadife onay kutusu (klasikte window.confirm idi)
        setEksOnaySor({ fark, ekstreBorc, yeniBorc, impOzet });
        return;
      }
      await eksDevirVeBitir(impOzet, yeniBorc, Math.abs(fark) > 1);
    } catch (e) {
      setEksHata(e?.message || 'Mutabakat başarısız');
    } finally {
      setEksTtBusy(false);
    }
  };

  const eksKartiEkle = async () => {
    if (!eksSonuc) return;
    const bankaLabel = BANKA_AD[eksSonuc.banka_format] || eksSonuc.banka_format || 'Banka';
    setKartEkleBusy(true); setEksHata('');
    try {
      const r = await fetch('/api/kartlar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kart_adi: `${bankaLabel} ${eksSonuc.kart_sahibi || ''} ${eksSonuc.son_dort || ''}`.replace(/\s+/g, ' ').trim(),
          banka: bankaLabel,
          limit_tutar: eksSonuc.limit || 0,
          kesim_gunu: gunCikar(eksSonuc.kesim_tarihi),
          son_odeme_gunu: gunCikar(eksSonuc.son_odeme_tarihi),
          faiz_orani: eksSonuc.akdi_faiz_yillik || 0,
          asgari_oran: eksSonuc.asgari_oran || 40,
          gecikme_faiz_orani: eksSonuc.gecikme_faiz_yillik || 0,
          son_dort_hane: eksSonuc.son_dort || null,
          sahip: eksSonuc.kart_sahibi || 'İşletme',
        }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Kart eklenemedi'); }
      onToast?.('✓ Kart eklendi — ekstre yeniden eşleştiriliyor');
      if (eksLastFile) await eksDosyaYukle(eksLastFile);
    } catch (e) {
      setEksHata(e?.message || 'Kart eklenemedi');
    } finally {
      setKartEkleBusy(false);
    }
  };

  const eksManuelKaydet = async () => {
    if (!manForm?.kart_id || !manForm?.donem || !manForm?.donem_borcu) {
      setEksHata('Kart, kesim tarihi ve dönem borcu zorunlu.'); return;
    }
    setManBusy(true); setEksHata('');
    try {
      const r = await fetch(`/api/kartlar/${manForm.kart_id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: manForm.donem, son_odeme: manForm.son_odeme || null,
          donem_borcu: parseFloat(manForm.donem_borcu),
          asgari_tutar: manForm.asgari_tutar ? parseFloat(manForm.asgari_tutar) : null,
          faiz_orani: manForm.faiz_orani ? parseFloat(manForm.faiz_orani) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Kaydedilemedi');
      onToast?.(`✓ Manuel ekstre kaydedildi — yeni borç ${fmt(sayi(d.yeni_borc))}`);
      setManForm(null);
      yukle();
    } catch (e) {
      setEksHata(e?.message || 'Kaydedilemedi');
    } finally {
      setManBusy(false);
    }
  };

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Kart verileri yükleniyor…</div>;
  }
  if (hata) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{hata}</div>
        <button onClick={yukle} style={{
          marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>Tekrar dene</button>
      </div>
    );
  }
  if (!kartSatir.length) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>Kayıtlı kart yok</div>
        <div style={{ fontSize: 13, color: R.not, marginTop: 8 }}>Kart tanımlayınca borç ve faiz takibi burada başlar.</div>
      </div>
    );
  }

  // ── 1) Kart & Faiz Özeti ───────────────────────────────────────────────────
  if (gorunum === 'ozet') {
    const donem = kartSatir.reduce((s, k) => s + k.donem, 0);
    const taksit = kartSatir.reduce((s, k) => s + k.taksit, 0);
    const eksik = kartSatir.filter(k => !k.ekstreVar);
    return (
      <>
        <Serit
          rozetler={kartSatir.map(k => ({
            ad: k.ad, durum: DONGU[k.durum].ad, renk: DONGU[k.durum].renk,
            ek: k.durum === 'gecikti' || k.durum === 'odeme_bekliyor' ? gunMetni(k.gunKaldi) : '',
            _k: k,
          }))}
          onAc={(s) => kartAc(s._k)}
        />
        <KpiSeridi kpiler={[
          { etiket: 'Toplam kart borcu', deger: fmt(sayi(ozet?.toplam_borc_taksitli) || donem + taksit), alt: `dönem ${fmt(donem).replace(' ₺','')} + taksit ${fmt(taksit)}`, renk: R.kirmizi },
          { etiket: 'Bankaya ödenen faiz', deger: fmt(sayi(ozet?.toplam_odenen_faiz)), alt: 'ekstrelerden birikimli', renk: R.amber },
          { etiket: 'Bu ay eksik ekstre', deger: `${eksik.length} kart`, alt: eksik.length ? eksik.map(k => k.ad).join(', ') : 'hepsi yüklendi', renk: eksik.length ? R.amber : R.yesil },
          { etiket: 'Toplam asgari', deger: fmt(toplamAsgari), alt: 'bu ay en az ödenmeli', renk: R.krem },
        ]} />
        <Tablo
          baslik="Kart bazlı borç & faiz"
          not="satıra tıkla → kart dosyası"
          kolonlar={[
            { ad: 'Kart' }, { ad: 'Sahip' }, { ad: 'Dönem borcu', sag: true },
            { ad: 'Taksit', sag: true }, { ad: 'Toplam borç', sag: true },
            { ad: 'Ödenen faiz', sag: true }, { ad: 'Bu ay ekstre' },
          ]}
          satirlar={kartSatir.map(k => ({
            id: k.id, _k: k,
            hucreler: [
              { v: k.ad, kalin: true },
              { v: k.sahip, renk: R.not },
              { v: fmt(k.donem), mono: true, sag: true },
              { v: k.taksit ? fmt(k.taksit) : '—', mono: true, sag: true, renk: k.taksit ? R.amber : R.not },
              { v: fmt(k.toplam), mono: true, sag: true, kalin: true, renk: R.kirmizi },
              { v: fmt(k.odenenFaiz), mono: true, sag: true, renk: R.amber },
              { v: k.ekstreVar ? 'yüklendi' : 'eksik', rozet: k.ekstreVar ? R.yesil : R.amber },
            ],
          }))}
          onSatir={(row) => kartAc(row._k)}
        />
      </>
    );
  }

  // ── 2) Kart Dosyaları ──────────────────────────────────────────────────────
  if (gorunum === 'kartlar') {
    const toplamLimit = kartSatir.reduce((s, k) => s + k.limit, 0);
    const toplamBorc = kartSatir.reduce((s, k) => s + k.toplam, 0);
    const faizli = kartSatir.filter(k => k.faizYillik > 0);
    const enPahali = faizli.length ? faizli.reduce((a, b) => (a.faizYillik > b.faizYillik ? a : b)) : null;
    const yakin = [...kartSatir].filter(k => k.gunKaldi >= 0).sort((a, b) => a.gunKaldi - b.gunKaldi)[0];
    const sirket = kartSatir.filter(k => trKucuk(k.sahip).includes('işletme')).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif kart', deger: String(kartSatir.length), alt: `${kartSatir.length - sirket} kişisel · ${sirket} işletme` },
          { etiket: 'Toplam limit', deger: fmt(toplamLimit), alt: `kullanım %${trSayi(toplamLimit ? (toplamBorc / toplamLimit) * 100 : 0, 0)}`, renk: R.krem },
          { etiket: 'En pahalı faiz', deger: enPahali ? `%${trSayi(enPahali.faizYillik)}/yıl` : '—', alt: enPahali ? enPahali.ad : 'faiz oranı girilmemiş', renk: enPahali ? R.kirmizi : R.not },
          { etiket: 'En yakın son ödeme', deger: yakin ? gunMetni(yakin.gunKaldi) : '—', alt: yakin ? yakin.ad : 'vadesi gelen yok', renk: R.amber },
        ]} />
        <Tablo
          baslik="Kart dosyaları · limit ve döngü"
          not="satıra tıkla → kart dosyası"
          kolonlar={[
            { ad: 'Kart' }, { ad: 'Limit', sag: true }, { ad: 'Kullanım', sag: true },
            { ad: 'Yıllık faiz', sag: true }, { ad: 'Kesim' }, { ad: 'Son ödeme' }, { ad: 'Döngü' },
          ]}
          satirlar={kartSatir.map(k => ({
            id: k.id, _k: k,
            hucreler: [
              { v: k.ad, kalin: true },
              { v: fmt(k.limit), mono: true, sag: true },
              { v: `%${trSayi(k.kullanim, 0)}`, bar: k.kullanim, sag: true, renk: k.kullanim > 80 ? R.kirmizi : k.kullanim > 60 ? R.amber : R.yesil },
              { v: k.faizYillik > 0 ? `%${trSayi(k.faizYillik)}` : '—', mono: true, sag: true, renk: k.faizYillik >= 55 ? R.kirmizi : k.faizYillik > 0 ? R.amber : R.not },
              { v: k.kesim ? `ayın ${k.kesim}` : '—', mono: true },
              { v: kisaTarih(k.sonOdeme), mono: true },
              { v: trKucuk(DONGU[k.durum].ad), rozet: DONGU[k.durum].renk },
            ],
          }))}
          onSatir={(row) => kartAc(row._k)}
        />
      </>
    );
  }

  // ── 3) Borç Koçu ───────────────────────────────────────────────────────────
  if (gorunum === 'koc') {
    const kocKart = koc?.kartlar || [];
    const toplamBorc = sayi(koc?.toplam_borc) || kartSatir.reduce((s, k) => s + k.toplam, 0);
    const aylikFaiz = sayi(koc?.toplam_aylik_faiz);
    const oncelik = koc?.oncelik;
    // Kaç ayda biter: aylık ödeme faizi aşıyorsa anapara erir.
    const netAylik = sayi(nakit) - aylikFaiz;
    const kurtulusAy = netAylik > 0 ? Math.ceil(toplamBorc / netAylik) : null;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam borç', deger: fmt(toplamBorc), alt: `${kartSatir.length} kart`, renk: R.kirmizi },
          { etiket: 'Aylık faiz kaybı', deger: fmt(aylikFaiz), alt: 'hiçbir şey yapmazsan bankaya', renk: R.amber },
          { etiket: 'Toplam asgari', deger: fmt(toplamAsgari), alt: 'bu ay minimum', renk: R.krem },
          { etiket: 'Kurtuluş', deger: kurtulusAy ? `${kurtulusAy} ay` : '—', alt: kurtulusAy ? `aylık ${fmt(sayi(nakit))} ödemeyle` : 'ödeme faizi karşılamıyor', renk: kurtulusAy ? R.yesil : R.kirmizi },
        ]} />
        <BorcKocu
          strateji={strateji}
          onStrateji={setStrateji}
          nakit={nakit}
          onNakit={(v) => setNakit(v === '' ? 0 : Number(v))}
          oncelikAd={oncelik?.kart_adi}
          oncelikNot={oncelik ? (
            strateji === 'cig'
              ? `Yıllık %${trSayi(sayi(oncelik.faiz_yillik))} faizle en pahalı borç bu. Aylık ${fmt(sayi(oncelik.aylik_faiz))} sadece faize gidiyor.`
              : `En küçük bakiye bu (${fmt(sayi(oncelik.borc))}). Kapanınca listeden bir kart eksilir, motivasyon artar.`
          ) : ''}
          ozetNot={koc?.asgari_karsilaniyor === false
            ? `⚠ Girdiğin nakit tüm asgarileri karşılamıyor — en az ${fmt(toplamAsgari)} gerekiyor.`
            : sayi(koc?.artan_nakit) > 0
              ? `✓ Tüm asgariler + öncelik kapanır, ${fmt(sayi(koc.artan_nakit))} nakit artar — sıradaki karta yatır.`
              : ''}
          satirlar={kocKart.map(k => ({
            id: k.kart_id,
            ad: k.kart_adi,
            sahip: k.sahip || 'İşletme',
            borc: fmt(sayi(k.borc)),
            faiz: k.faiz_belirsiz ? '—' : `%${trSayi(sayi(k.faiz_yillik))}`,
            faizBelirsiz: !!k.faiz_belirsiz,
            aylikFaiz: fmt(sayi(k.aylik_faiz)),
            asgari: fmt(sayi(k.asgari)),
            onerilen: fmt(sayi(k.onerilen_odeme)),
          }))}
        />
      </>
    );
  }

  // ── 4) Hareketler ──────────────────────────────────────────────────────────
  if (gorunum === 'hareket') {
    const g = harcama?.genel || {};
    const toplam = sayi(g.toplam);
    const belirsizAdet = hareketler.filter(h => (h.harcama_tipi || 'belirsiz') === 'belirsiz' && h.islem_turu === 'HARCAMA').length;
    const pay = (v) => (toplam ? `%${trSayi((sayi(v) / toplam) * 100, 0)}` : '—');
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam harcama', deger: fmt(toplam), alt: `${hareketler.length} hareket` },
          { etiket: 'İşletme', deger: pay(g.isletme), alt: fmt(sayi(g.isletme)), renk: R.yesil },
          { etiket: 'Şahsi', deger: pay(g.sahsi), alt: fmt(sayi(g.sahsi)), renk: R.mavi },
          { etiket: 'Sınıflandırılmayan', deger: `${belirsizAdet} hareket`, alt: `${fmt(sayi(g.belirsiz))} · karar bekliyor`, renk: belirsizAdet ? R.amber : R.yesil },
        ]} />
        <Tablo
          baslik="Kart hareketleri · işletme / şahsi"
          not="satıra tıkla → sınıflandır"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'Kart' }, { ad: 'Açıklama' },
            { ad: 'Tutar', sag: true }, { ad: 'Tür' }, { ad: 'Sınıf' },
          ]}
          satirlar={hareketler.slice(0, 120).map(h => {
            const sinif = h.harcama_tipi || 'belirsiz';
            const odeme = h.islem_turu === 'ODEME';
            return {
              id: h.id, _h: h,
              hucreler: [
                { v: kisaTarih(h.tarih), mono: true },
                { v: h.kart_adi || h.banka || '—', renk: R.not },
                { v: h.aciklama || (odeme ? 'Kart ödemesi' : 'Harcama'), kalin: true },
                { v: fmt(sayi(h.tutar)), mono: true, sag: true, renk: odeme ? R.yesil : R.krem },
                { v: slugAd(h.islem_turu), rozet: odeme ? R.yesil : h.islem_turu === 'FAIZ' ? R.kirmizi : R.bakir },
                { v: sinif === 'isletme' ? 'işletme' : sinif === 'sahsi' ? 'şahsi' : 'belirsiz', rozet: sinif === 'isletme' ? R.yesil : sinif === 'sahsi' ? R.mavi : R.amber },
              ],
            };
          })}
          onSatir={(row) => {
            const h = row._h;
            onCekmece?.({
              tip: 'KART HAREKETİ',
              baslik: h.aciklama || 'Hareket',
              alt: `${h.kart_adi || h.banka || 'Kart'} · ${kisaTarih(h.tarih)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(sayi(h.tutar)) },
                { etiket: 'Tür', deger: slugAd(h.islem_turu) },
                { etiket: 'Taksit', deger: sayi(h.taksit_sayisi) > 1 ? `${h.taksit_sayisi} ay` : 'tek çekim' },
                { etiket: 'Sınıf', deger: h.harcama_tipi || 'belirsiz' },
              ],
              listeBaslik: 'Kayıt ayrıntısı',
              satirlar: [
                { ad: 'Ana para', detay: 'faiz hariç', tutar: fmt(sayi(h.ana_para)) },
                { ad: 'Faiz tutarı', detay: 'KKDF/BSMV dahil', tutar: fmt(sayi(h.faiz_tutari)) },
              ],
              not: (h.harcama_tipi || 'belirsiz') === 'belirsiz'
                ? 'Bu hareket işletme mi şahsi mi belirlenmemiş — sınıflandırılmadan işletmenin gerçek kart yükü doğru çıkmaz.'
                : 'Sınıflandırma yapılmış; işletme/şahsi ayrımı raporlara doğru yansıyor.',
              aksiyonAd: 'Kart hareketlerini aç',
              _hedef: 'kart-hareketleri',
            });
          }}
        />
      </>
    );
  }

  // ── 5) Ekstre Durumu ───────────────────────────────────────────────────────
  const eksikler = kartSatir.filter(k => !k.ekstreVar);
  const gecikmis = kartSatir.filter(k => k.durum === 'gecikti');
  const yakinlar = [...kartSatir].filter(k => k.gunKaldi >= 0).sort((a, b) => a.gunKaldi - b.gunKaldi);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Yüklenen ekstre', deger: `${kartSatir.length - eksikler.length} / ${kartSatir.length}`, alt: 'bu dönem', renk: eksikler.length ? R.amber : R.yesil },
        { etiket: 'Eksik', deger: String(eksikler.length), alt: eksikler.length ? eksikler.map(k => k.ad).join(', ') : 'yok', renk: eksikler.length ? R.amber : R.yesil },
        { etiket: 'Gecikmiş kart', deger: String(gecikmis.length), alt: gecikmis.length ? gecikmis.map(k => k.ad).join(', ') : 'yok', renk: gecikmis.length ? R.kirmizi : R.yesil },
        { etiket: 'Sonraki son ödeme', deger: yakinlar[0] ? gunMetni(yakinlar[0].gunKaldi) : '—', alt: yakinlar[0] ? yakinlar[0].ad : 'vadesi gelen yok', renk: R.krem },
      ]} />
      <Liste
        satirlar={kartSatir
          .slice()
          .sort((a, b) => {
            const oncelik = { gecikti: 0, ekstre_bekleniyor: 1, odeme_bekliyor: 2, yuklendi: 3, odendi: 4 };
            return oncelik[a.durum] - oncelik[b.durum];
          })
          .map(k => {
            if (k.durum === 'gecikti') return {
              id: k.id, _k: k, tier: 'kritik',
              baslik: `${k.ad} · son ödeme geçti`,
              alt: `${gunMetni(k.gunKaldi)} · gecikme faizi işliyor`,
              tutar: fmt(k.toplam), aksiyon: 'Ödemeye git', _hedef: 'odeme-merkezi',
            };
            if (!k.ekstreVar) return {
              id: k.id, _k: k, tier: 'uyari',
              baslik: `${k.ad} · ekstre yüklenmedi`,
              alt: `kesim ayın ${k.kesim || '—'} · dönem borcu tahminî hesaplanıyor`,
              tutar: fmt(k.donem), aksiyon: 'Ekstre yükle', _hedef: '__yerli:ekstre',
            };
            if (k.durum === 'odeme_bekliyor') return {
              id: k.id, _k: k, tier: 'kritik',
              baslik: `${k.ad} · son ödeme ${gunMetni(k.gunKaldi)}`,
              alt: `asgari ${fmt(k.asgari)} · tam ödeme ${fmt(k.toplam)}`,
              tutar: fmt(k.toplam), aksiyon: 'Ödemeye git', _hedef: 'odeme-merkezi',
            };
            return {
              id: k.id, _k: k, tier: k.durum === 'odendi' ? 'iyi' : 'bilgi',
              baslik: `${k.ad} · ${trKucuk(DONGU[k.durum].ad)}`,
              alt: `kesim ayın ${k.kesim || '—'} · dönem borcu ${fmt(k.donem)} doğrulandı`,
              tutar: fmt(k.toplam), aksiyon: 'Detay', _hedef: 'kart-yonetimi',
            };
          })}
        onAc={(l) => (l._hedef === 'kart-yonetimi' ? kartAc(l._k)
          : l._hedef === '__yerli:ekstre' ? eksAc()
          : onKopru?.(l._hedef))}
      />
      {/* Kapsama denetimi bulgusu (2026-07-29): Ekstre Analizi (harcama dağılımı
          grafikleri + arşiv, klasik kart-analiz) v2'de karşılıksızdı — köprü açıldı. */}
      <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
        <button
          onClick={eksAc}
          style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}
        >
          📄 Ekstre yükle (PDF)
        </button>
        <button
          onClick={() => onKopru?.('kart-analiz')}
          style={{
            padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
            background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          📊 Ekstre analizi (harcama dağılımı + arşiv)
        </button>
      </div>

      {/* ── YERLİ EKSTRE YÜKLEME MODALI (klasik EkstreYukle akışı kadifede) ── */}
      {eksModal && (() => {
        const m = eksSonuc?.mutabakat;
        const kart = eksSonuc?.eslesen_kart;
        return (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !eksYukleniyor && !eksTtBusy) setEksModal(false); }}
            style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 620, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>📄 Ekstre Yükle</div>
                <div style={{ fontSize: 11.5, color: R.not2 }}>önizleme — kayıt yazılmaz</div>
                <button onClick={() => setEksModal(false)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: R.metin2, marginBottom: 14 }}>
                Banka PDF ekstresini seç → otomatik ayrıştır + mutabakat. Sonra ⚡ tek tıkla kapat.
              </div>

              {/* Dosya seçimi */}
              <label style={{
                display: 'block', padding: '22px 18px', borderRadius: 14, textAlign: 'center',
                border: `1px dashed ${R.bakir}66`, background: R.girinti, cursor: 'pointer', marginBottom: 14,
              }}>
                <input type="file" accept="application/pdf" style={{ display: 'none' }}
                  onChange={(e) => eksDosyaYukle(e.target.files?.[0])} />
                <div style={{ fontSize: 13, fontWeight: 700, color: R.bakir }}>
                  {eksYukleniyor ? '⏳ Ayrıştırılıyor…' : (eksDosyaAdi || 'PDF seçmek için tıkla')}
                </div>
                {!eksYukleniyor && eksDosyaAdi && <div style={{ fontSize: 11, color: R.not, marginTop: 4 }}>başka dosya seçmek için tekrar tıkla</div>}
              </label>

              {eksHata && (
                <div style={{ padding: '11px 15px', borderRadius: 12, background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`, fontSize: 12.5, color: R.kirmizi, marginBottom: 12 }}>
                  {eksHata}
                </div>
              )}

              {/* Ayrıştırma sonucu */}
              {eksSonuc && (
                <>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 12 }}>
                    <span>Banka: <b>{FORMAT_AD[eksSonuc.banka_format] || eksSonuc.banka_format || '—'}</b></span>
                    <span>Kart: {kart
                      ? <b style={{ color: R.yesil }}>{kart.kart_adi || kart.ad || kart.banka}</b>
                      : <b style={{ color: R.amber }}>eşleşen kart bulunamadı</b>}
                    </span>
                    {eksSonuc.son_dort && <span style={{ fontFamily: F.mono, color: R.not }}>…{eksSonuc.son_dort}</span>}
                  </div>

                  {!kart && (
                    <button disabled={kartEkleBusy} onClick={eksKartiEkle} style={{
                      padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer', marginBottom: 12,
                      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>
                      {kartEkleBusy ? 'Ekleniyor…' : '+ Bu kartı sisteme ekle'}
                    </button>
                  )}

                  {m && (
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10,
                      padding: '13px 15px', borderRadius: 12, background: R.girinti,
                      border: `1px solid ${m.tutar_uyumlu ? `${R.yesil}55` : `${R.amber}55`}`, marginBottom: 12,
                    }}>
                      {[
                        ['Ekstre borcu', fmt(sayi(m.ekstre_borc)), R.krem],
                        ['Sistem borcu', fmt(sayi(m.sistem_borc)), R.krem],
                        ['Fark', fmt(sayi(m.fark)), m.tutar_uyumlu ? R.yesil : R.kirmizi],
                        ['Yeni işlem', String(sayi(m.yeni_islem_adet)), sayi(m.yeni_islem_adet) ? R.amber : R.yesil],
                      ].map(([et, dg, renk]) => (
                        <div key={et}>
                          <div style={{ fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>{et}</div>
                          <div style={{ fontFamily: F.mono, fontSize: 14.5, fontWeight: 700, color: renk, marginTop: 3 }}>{dg}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Eşik üstü fark onayı — klasikte window.confirm idi */}
                  {eksOnaySor && (
                    <div style={{ padding: '13px 16px', borderRadius: 12, background: `${R.amber}12`, border: `1px solid ${R.amber}66`, marginBottom: 12 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: R.amber }}>
                        ⚠ Fark güvenlik eşiğinin üstünde: {fmt(Math.abs(eksOnaySor.fark))}
                      </div>
                      <div style={{ fontSize: 12, color: R.metin2, marginTop: 6, lineHeight: 1.55 }}>
                        Bu genelde İLK mutabakatta eski devir tabanından kaynaklanır ve güvenlidir
                        (düzeltme birikmez, her zaman yeniden hesaplanır). Sistem borcu ekstre
                        borcuna ({fmt(sayi(eksOnaySor.ekstreBorc))}) eşitlensin mi?
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button disabled={eksTtBusy} onClick={async () => {
                          setEksTtBusy(true);
                          try { await eksDevirVeBitir(eksOnaySor.impOzet, eksOnaySor.yeniBorc, true); setEksOnaySor(null); }
                          catch (e) { setEksHata(e?.message || 'Düzeltme yapılamadı'); }
                          finally { setEksTtBusy(false); }
                        }} style={{
                          padding: '8px 15px', borderRadius: 9, border: 'none', cursor: 'pointer',
                          background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                          fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                        }}>Evet, eşitle</button>
                        <button onClick={() => setEksOnaySor(null)} style={{
                          padding: '8px 13px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                        }}>Vazgeç</button>
                      </div>
                    </div>
                  )}

                  {/* Sonuç özeti */}
                  {eksImpSonuc && (
                    <div style={{ padding: '11px 15px', borderRadius: 12, background: `${R.yesil}12`, border: `1px solid ${R.yesil}55`, fontSize: 12.5, color: R.metin2, marginBottom: 12, lineHeight: 1.6 }}>
                      ✓ {sayi(eksImpSonuc.yazilan)} işlem aktarıldı
                      {sayi(eksImpSonuc.atlanan_veya_mevcut) ? ` · ${sayi(eksImpSonuc.atlanan_veya_mevcut)} zaten kayıtlıydı` : ''}
                      {eksImpSonuc.devir ? ` · devir düzeltmesi ${fmt(Math.abs(sayi(eksImpSonuc.devir_duzeltme)))}` : ''}
                      {' — yeni sistem borcu '}<b style={{ fontFamily: F.mono }}>{fmt(sayi(eksImpSonuc.yeni_sistem_borc))}</b>
                    </div>
                  )}

                  {kart && !eksImpSonuc && !eksOnaySor && (
                    <button disabled={eksTtBusy} onClick={eksTekTik} style={{
                      width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                      fontSize: 13.5, fontWeight: 800, fontFamily: 'inherit', marginBottom: 12,
                    }}>
                      {eksTtBusy ? 'Mutabakat yapılıyor…' : '⚡ Tek Tık Mutabakat — aktar + farkı kapat'}
                    </button>
                  )}
                </>
              )}

              {/* Manuel ekstre (Axess gibi PDF'i okunamayan kartlar) */}
              {manForm ? (
                <div style={{ padding: '14px 16px', borderRadius: 12, background: R.girinti, border: `1px solid ${R.bakir}44` }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: R.bakir, marginBottom: 12 }}>Manuel ekstre girişi</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.7px', color: R.not2, fontWeight: 700, marginBottom: 6 }}>Kart *</div>
                      <select value={manForm.kart_id} onChange={(e) => setManForm((f) => ({ ...f, kart_id: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem, fontSize: 13, fontFamily: 'inherit' }}>
                        <option value="">Seçin…</option>
                        {kartlar.map((k) => <option key={k.id} value={k.id}>{k.kart_adi || k.banka}</option>)}
                      </select>
                    </div>
                    {[['donem', 'Kesim tarihi *', 'date'], ['son_odeme', 'Son ödeme', 'date'],
                      ['donem_borcu', 'Dönem borcu (₺) *', 'number'], ['asgari_tutar', 'Asgari (₺)', 'number'],
                      ['faiz_orani', 'Yıllık faiz %', 'number']].map(([k, ad, tip]) => (
                      <div key={k}>
                        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.7px', color: R.not2, fontWeight: 700, marginBottom: 6 }}>{ad}</div>
                        <input type={tip} value={manForm[k]} onChange={(e) => setManForm((f) => ({ ...f, [k]: e.target.value }))}
                          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem, fontSize: 13, fontFamily: tip === 'number' ? F.mono : 'inherit', textAlign: tip === 'number' ? 'right' : 'left', colorScheme: 'dark' }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                    <button disabled={manBusy} onClick={() => setManForm(null)} style={{
                      padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={manBusy} onClick={eksManuelKaydet} style={{
                      padding: '8px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>{manBusy ? 'Kaydediliyor…' : 'Kaydet'}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setManForm({ kart_id: '', donem: '', son_odeme: '', donem_borcu: '', asgari_tutar: '', faiz_orani: '' })} style={{
                  padding: '8px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                }}>
                  ✍️ PDF okunmuyor mu? Manuel ekstre gir (Axess vb.)
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
