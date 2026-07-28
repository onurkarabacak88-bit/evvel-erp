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
import React, { useEffect, useMemo, useState } from 'react';
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
const ucretMetni = (p) => (sayi(p.maas) > 0
  ? fmt(sayi(p.maas))
  : sayi(p.saatlik_ucret) > 0 ? `${fmt(p.saatlik_ucret)}/sa` : '—');

export default function EkipModulu({ gorunum, onCekmece, onKopru }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [personel, setPersonel] = useState([]);
  const [hafta, setHafta] = useState(null);
  const [bordro, setBordro] = useState([]);
  const [avans, setAvans] = useState(null);
  const [gorevOzet, setGorevOzet] = useState([]);
  const [takip, setTakip] = useState([]);
  const [basvurular, setBasvurular] = useState([]);
  const [basvuruOzet, setBasvuruOzet] = useState(null);
  const [pinler, setPinler] = useState([]);

  const bugun = isoBugun();
  const yil = Number(bugun.slice(0, 4));
  const ay = Number(bugun.slice(5, 7));
  const pazartesi = pazartesiBul(bugun);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/personel?aktif=true').catch(() => []),
      api(`/vardiya/v2/hafta-sube-tablo?pazartesi=${pazartesi}`).catch(() => null),
      api(`/personel-aylik?yil=${yil}&ay=${ay}`).catch(() => []),
      api('/avans/ozet').catch(() => null),
      api(`/gorev/ozet?tarih=${bugun}`).catch(() => []),
      api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}`).catch(() => null),
      api('/is-basvurusu?limit=200').catch(() => []),
      api('/is-basvurusu/ozet').catch(() => null),
      api('/sube-panel/merkez/personel-panel-pin').catch(() => []),
    ]).then(([p, h, b, av, go, vt, bs, bo, pin]) => {
      setPersonel(Array.isArray(p) ? p : []);
      setHafta(h);
      setBordro(Array.isArray(b) ? b : []);
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

  useEffect(yukle, []);

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
          background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
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
        : 'Bordro hesabı maaş çekirdeğinden gelir; onay ve ödeme Personel ekranından yapılır.',
      aksiyonAd: 'Personel ekranını aç',
      _hedef: 'personel',
    });
  };

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
            {kisaTarih(pazartesi)} haftası boş. Plan Vardiya Planlaması ekranından kurulur.
          </div>
          <button onClick={() => onKopru?.('vardiya-planlamasi')} style={{
            marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
          }}>Vardiya planlamasını aç</button>
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
              ? 'Atamayı değiştirmek için Vardiya Planlaması ekranını kullan — buradan yazılmaz.'
              : 'Bu gün-şube için kimse atanmamış. Açık slot, kapanış sorumlusu boşluğu anlamına da gelebilir.',
            aksiyonAd: 'Vardiya planlamasını aç',
            _hedef: 'vardiya-planlamasi',
          })}
        />
      </>
    );
  }

  // ── 3) Maaş & Avans ────────────────────────────────────────────────────────
  if (gorunum === 'maas') {
    const toplamNet = bordro.reduce((s, b) => s + sayi(b.hesaplanan_net), 0);
    const bekleyen = bordro.filter(b => b.durum && !['odendi', 'onayli'].includes(b.durum));
    const toplamAvans = avans?.toplam != null ? sayi(avans.toplam) : bordro.reduce((s, b) => s + sayi(b.avans_mahsup), 0);
    const toplamFm = bordro.reduce((s, b) => s + sayi(b.fazla_mesai_saat), 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: `${AY_KISA[ay - 1]} bordro`, deger: fmt(toplamNet), alt: `${bordro.length} kişi · hesaplanan net` },
          { etiket: 'Onay bekleyen', deger: String(bekleyen.length), alt: bekleyen.length ? 'taslak bordro' : 'hepsi onaylı', renk: bekleyen.length ? R.amber : R.yesil },
          { etiket: 'Avans', deger: fmt(toplamAvans), alt: 'maaştan mahsup edilecek', renk: R.krem },
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
                ],
                not: 'Hesap maaş çekirdeğinden gelir. Onay ve ödeme buradan YAPILMAZ — Personel ekranındaki guard\'lı akış kullanılır.',
                aksiyonAd: 'Personel ekranını aç',
                _hedef: 'personel',
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için bordro kaydı bulunamadı.
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
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugünkü görev', deger: String(toplam), alt: `${subeler.length} şube · vardiya blokları` },
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
                aksiyonAd: 'Görev takibini aç',
                _hedef: 'gorev-ozet',
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
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aylık toplam saat', deger: `${trSayi(toplamSaat, 0)} sa`, alt: `${satir.length} personel · ${AY_KISA[ay - 1]}` },
          { etiket: 'Toplam gecikme', deger: `${trSayi(toplamGecikme, 0)} dk`, alt: gecikenler.length ? `${gecikenler.length} personel` : 'gecikme yok', renk: toplamGecikme > 0 ? R.amber : R.yesil },
          { etiket: 'Fazla mesai', deger: `${trSayi(toplamFm, 0)} sa`, alt: 'plan üstü çalışma', renk: toplamFm > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Kişi başı ortalama', deger: satir.length ? `${trSayi(toplamSaat / satir.length, 0)} sa` : '—', alt: 'bu ay', renk: R.krem },
        ]} />
        {satir.length ? (
          <Tablo
            baslik={`Vardiya takip · ${AY_KISA[ay - 1]} ${yil}`}
            not="satıra tıkla → personel dosyası"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Çalışma türü' }, { ad: 'Planlanan saat', sag: true },
              { ad: 'Gecikme', sag: true }, { ad: 'Fazla mesai', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={satir.map(t => {
              const gec = sayi(t.toplam_gecikme_dk);
              const fm = sayi(t.toplam_fazla_mesai_saat);
              return {
                id: t.personel_id, _t: t,
                hucreler: [
                  { v: t.ad_soyad, kalin: true },
                  { v: turAd(t.calisma_turu), renk: R.not },
                  { v: `${trSayi(t.toplam_planlanan_saat, 0)} sa`, mono: true, sag: true },
                  { v: gec ? `${trSayi(gec, 0)} dk` : '—', mono: true, sag: true, renk: gec > 30 ? R.kirmizi : gec > 0 ? R.amber : R.not },
                  { v: fm ? `${trSayi(fm)} sa` : '—', mono: true, sag: true, renk: fm > 8 ? R.kirmizi : R.krem },
                  {
                    v: fm > 8 ? 'fazla mesai' : gec > 30 ? 'gecikme yüksek' : 'normal',
                    rozet: fm > 8 ? R.kirmizi : gec > 30 ? R.amber : R.yesil,
                  },
                ],
              };
            })}
            onSatir={(row) => {
              const p = personel.find(x => String(x.id) === String(row._t.personel_id));
              if (p) personelAc(p);
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için vardiya takip kaydı yok.
          </div>
        )}
        {/* Kapsama denetimi (2026-07-29): derin takip ekranı (izin alacağı, vardiya
            dışı girişler, geçmiş ay/filtreler) klasikte — köprüsü eksikti, açıldı. */}
        <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
          <button
            onClick={() => onKopru?.('personel-vardiya-takip')}
            style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            🕐 Tam takip ekranı (izin alacağı · vardiya dışı · geçmiş aylar)
          </button>
        </div>
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
        <KpiSeridi kpiler={[
          { etiket: 'Yeni başvuru', deger: String(basvuruOzet?.yeni ?? yeni.length), alt: 'okunmamış', renk: (basvuruOzet?.yeni ?? yeni.length) ? R.yesil : R.krem },
          { etiket: 'Görüşme aşamasında', deger: String(gorusme.length), alt: gorusme.length ? 'planlandı' : 'yok', renk: R.mavi },
          { etiket: 'Toplam başvuru', deger: String(bs.length), alt: 'arşivsiz kayıt' },
          { etiket: 'Öncelikli', deger: String(bs.filter(b => sayi(b.oncelik) > 0).length), alt: 'işaretlenmiş', renk: R.amber },
        ]} />
        {bs.length ? (
          <Liste
            satirlar={bs.slice(0, 40).map(b => ({
              id: b.id, _b: b,
              baslik: `${b.ad_soyad || b.ad || 'Başvuru'}${b.pozisyon ? ` · ${b.pozisyon}` : ''}`,
              alt: [b.sube_tercihi || b.sube, b.deneyim, b.olusturma ? kisaTarih(b.olusturma) : null]
                .filter(Boolean).join(' · ') || 'ayrıntı girilmemiş',
              tutar: '',
              rozet: trKucuk(b.durum) || 'yeni',
              rozetRenk: trKucuk(b.durum) === 'yeni' ? R.yesil : R.mavi,
              tier: trKucuk(b.durum) === 'yeni' ? 'uyari' : 'bilgi',
              aksiyon: 'İncele',
            }))}
            onAc={() => onKopru?.('is-basvurusu')}
          />
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
              not: 'Şube panelinin ortak PIN\'i yoktur — her personel kendi PIN\'iyle girer. PIN yenileme Personel Panel PIN ekranından yapılır.',
              aksiyonAd: 'Panel PIN ekranını aç',
              _hedef: 'sube-panel-pin',
            });
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Panel PIN kaydı bulunamadı.
        </div>
      )}
      {/* Kapsama denetimi (2026-07-29): görünüm adı "Görev QR" vaat ediyordu ama
          QR yoklama kodları + şube konum/yarıçap ayarı (gorev-qr sayfası) v2'den
          HİÇ erişilemiyordu — köprü açıldı. */}
      <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
        <button
          onClick={() => onKopru?.('gorev-qr')}
          style={{
            padding: '9px 17px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(217,154,78,.24)',
          }}
        >
          📱 Görev QR kodları & şube konum ayarı
        </button>
      </div>
    </>
  );
}
