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

export default function KartModulu({ gorunum, onCekmece, onKopru }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [ozet, setOzet] = useState(null);
  const [harcama, setHarcama] = useState(null);
  const [hareketler, setHareketler] = useState([]);
  const [koc, setKoc] = useState(null);
  const [strateji, setStrateji] = useState('cig');
  const [nakit, setNakit] = useState(200000);

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
      : 'Bu dönem ekstresi YÜKLENMEDİ — dönem borcu tahminî hesaplanıyor.',
    aksiyonAd: k.ekstreVar ? 'Kart yönetimini aç' : 'Ekstre yükle',
    _hedef: k.ekstreVar ? 'kart-yonetimi' : 'ekstre-yukle',
  });

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
              tutar: fmt(k.donem), aksiyon: 'Ekstre yükle', _hedef: 'ekstre-yukle',
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
        onAc={(l) => (l._hedef === 'kart-yonetimi' ? kartAc(l._k) : onKopru?.(l._hedef))}
      />
    </>
  );
}
