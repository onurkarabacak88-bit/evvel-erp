// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Ödeme Merkezi modülü (4 görünüm)
//
// Tasarım: ICERIK → odeme.bekleyen / odeme.takvim / odeme.tedarikci / odeme.gecmis
//
// ⚠️ TEK YAZICI İLKESİ: bu modül deftere KENDİ yazmaz. "Öde" ve "Ertele",
// mevcut Ödeme Merkezi'nin kullandığı AYNI uçlara delege eder
// (/odeme-plani/{id}/ode, /odeme-plani/{id}/ertele) — o uçlarda FOR UPDATE
// kilidi, çift-ödeme kapısı ve maaş onay guard'ı zaten var. Yeni bir para
// yazma yolu açılmadı.
//
// Veri uçları:
//   /odeme-plani/bugun?gun=N   → bekleyen + gecikmiş + yaklaşan kuyruk
//   /odeme-plani/kokpit        → kasa, gecikmiş toplamı, nakit projeksiyonu
//   /fatura/cari-ozet          → tedarikçi açık bakiyeleri
//   /ledger?ay=YYYY-MM         → ödeme geçmişi (kasa hareketleri)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, Takvim, OnayModali } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');
// ⚠️ İKİ YÖNLÜ TÜRKÇE-I TUZAĞI:
//   trKucuk  → 'İ'yi doğru çevirir ama ASCII 'I'yı NOKTASIZ 'ı' yapar.
//              'FAIZ' → 'faız', 'CIRO' → 'cıro' (yanlış).
//   slugAd   → veritabanı slug'ları (ASCII, BÜYÜK, alt çizgili) için: düz
//              toLowerCase + alt çizgi → boşluk. 'ANLIK_GIDER' → 'anlik gider'.
// Kural: TÜRKÇE metinde trKucuk, DB SLUG'ında slugAd.
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
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
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

/** kasa_hareketleri.islem_turu → okunur ödeme yöntemi */
const YONTEM = {
  KART_ODEME: 'kredi kartı',
  FATURA_ODEMESI: 'havale / nakit',
  PERSONEL_MAAS: 'maaş ödemesi',
  PERSONEL_AVANS: 'avans',
  TEDARIKCI_ODEME: 'tedarikçi ödemesi',
};

export default function OdemeModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [kuyruk, setKuyruk] = useState([]);      // 14 günlük pencere
  const [kokpit, setKokpit] = useState(null);
  const [cari, setCari] = useState(null);
  const [gecmis, setGecmis] = useState([]);
  const [vade, setVade] = useState(null);   // duyu 5/6: vade disiplini (salt-okur)
  const [modal, setModal] = useState(null);
  const [calisiyor, setCalisiyor] = useState(false);

  const ay = isoBugun().slice(0, 7);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/odeme-plani/bugun?gun=14&personel=1').catch(() => []),
      api('/odeme-plani/kokpit?personel=1').catch(() => null),
      api('/fatura/cari-ozet').catch(() => null),
      api(`/ledger?limit=400&ay=${ay}`).catch(() => null),
    ]).then(([k, ko, c, l]) => {
      setKuyruk(Array.isArray(k) ? k : []);
      setKokpit(ko);
      setCari(c);
      const satir = Array.isArray(l) ? l : (l?.rows || []);
      setGecmis(satir.filter(r => sayi(r.tutar) < 0));
      if (!Array.isArray(k) && !ko) setHata('Ödeme verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
    api('/ops/vade-disiplini?gun=90')
      .then((d) => setVade(d || {}))
      .catch(() => setVade({}));
  };

  useEffect(yukle, []);

  const bugun = isoBugun();
  const kasa = sayi(kokpit?.kasa);

  /** Kuyruğu normalize eder — tutarı girilmemiş fatura satırları ayrı işaretlenir. */
  const satirlar = useMemo(() => kuyruk.map(o => ({
    ...o,
    _tutar: sayi(o.tutar),
    _tahmin: sayi(o.tahmini_tutar),
    _tarih: o.tarih ? String(o.tarih).slice(0, 10) : null,
    _gecikmis: !!o.gecikmis,
    _bugunMu: o.tarih ? String(o.tarih).slice(0, 10) === bugun : false,
  })), [kuyruk, bugun]);

  // Tutarı girilmemiş fatura satırları kuyrukta GÖRÜNÜR ama toplamlara ve kalem
  // sayılarına KARIŞMAZ — kasa izi tek gerçek, tahmini rakam borç sayılmaz.
  const tutarli = satirlar.filter(o => !o.tutar_girilmedi);
  const tutarsiz = satirlar.filter(o => o.tutar_girilmedi);

  const bugunVeGecmis = tutarli.filter(o => o._gecikmis || o._bugunMu || !o._tarih);
  const bugunToplam = bugunVeGecmis.reduce((s, o) => s + o._tutar, 0);
  const haftaSatir = tutarli.filter(o => o._tarih && o._tarih <= isoEkle(bugun, 7));
  const haftaToplam = haftaSatir.reduce((s, o) => s + o._tutar, 0);
  const gecikmisSatir = tutarli.filter(o => o._gecikmis);
  const gecikmisToplam = gecikmisSatir.reduce((s, o) => s + o._tutar, 0);
  const toplamKuyruk = tutarli.reduce((s, o) => s + o._tutar, 0);
  const tutarsizNot = tutarsiz.length ? ` · ${tutarsiz.length} kalem tutarsız` : '';

  // ── ödeme / erteleme (mevcut tek-yazıcı uçlara delege) ─────────────────────
  const odemeyiAc = (o) => {
    if (o.tutar_girilmedi) {
      onToast?.('Bu faturanın tutarı girilmemiş — önce tutarı gir.');
      onKopru?.('odeme-merkezi');
      return;
    }
    setModal({
      tip: 'ode',
      satir: o,
      baslik: 'Ödemeyi onayla',
      altBaslik: `${o.baslik} · ${o.tip}`,
      tutar: fmt(o._tutar),
      satirlar: [
        { ad: 'Ödeme sonrası kasa', deger: fmt(kasa - o._tutar), renk: kasa - o._tutar >= 0 ? R.yesil : R.kirmizi },
      ],
      not: 'Kayıt işlem defterine yazılır ve tedarikçi bakiyesinden düşülür. Geri almak için defterden ters kayıt gerekir.',
      onaylaAd: 'Öde ve kaydet',
    });
  };

  const erteleyiAc = (o) => {
    const yeni = isoEkle(o._tarih || bugun, 7);
    setModal({
      tip: 'ertele',
      satir: o,
      yeniTarih: yeni,
      baslik: 'Ödemeyi ertele',
      altBaslik: `${o.baslik} · ${o.tip}`,
      tutar: fmt(o._tutar),
      satirlar: [
        { ad: 'Mevcut vade', deger: kisaTarih(o._tarih), renk: R.amber },
        { ad: 'Yeni vade', deger: kisaTarih(yeni), renk: R.bakir },
      ],
      not: 'Erteleme kasa izine dokunmaz; yalnızca ödeme kuyruğundaki vade tarihini ileri alır.',
      onaylaAd: '7 gün ertele',
    });
  };

  const modalOnayla = async () => {
    if (!modal) return;
    setCalisiyor(true);
    try {
      if (modal.tip === 'ode') {
        await api(`/odeme-plani/${modal.satir.id}/ode`, { method: 'POST' });
        onToast?.(`${modal.satir.baslik} ödendi`);
      } else {
        await api(`/odeme-plani/${modal.satir.id}/ertele?yeni_tarih=${encodeURIComponent(modal.yeniTarih)}`, { method: 'POST' });
        onToast?.(`${modal.satir.baslik} ${kisaTarih(modal.yeniTarih)} tarihine ertelendi`);
      }
      setModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem tamamlanamadı');
    } finally {
      setCalisiyor(false);
    }
  };

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Ödeme verileri yükleniyor…</div>;
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

  const modalBlok = (
    <OnayModali
      acik={!!modal}
      baslik={modal?.baslik}
      altBaslik={modal?.altBaslik}
      tutar={modal?.tutar}
      satirlar={modal?.satirlar}
      not={modal?.not}
      onaylaAd={modal?.onaylaAd}
      calisiyor={calisiyor}
      onOnayla={modalOnayla}
      onKapat={() => !calisiyor && setModal(null)}
    />
  );

  // ── 1) Bekleyen ────────────────────────────────────────────────────────────
  if (gorunum === 'bekleyen') {
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün ödenecek', deger: fmt(bugunToplam), alt: `${bugunVeGecmis.length} kalem · vade bugün/geçmiş${tutarsizNot}`, renk: bugunToplam > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Bu hafta', deger: fmt(haftaToplam), alt: `${haftaSatir.length} kalem`, renk: R.krem },
          { etiket: 'Gecikmiş', deger: fmt(gecikmisToplam), alt: gecikmisSatir.length ? `${gecikmisSatir.length} kalem` : 'gecikme yok', renk: gecikmisSatir.length ? R.kirmizi : R.yesil },
          { etiket: 'Ödeme sonrası kasa', deger: fmt(kasa - bugunToplam), alt: 'bugünküler düşülmüş', renk: kasa - bugunToplam >= 0 ? R.yesil : R.kirmizi },
        ]} />
        {satirlar.length ? (
          <Liste
            satirlar={satirlar.map(o => ({
              id: o.id,
              baslik: o.baslik,
              alt: `${o.tip}${o._tarih ? ` · vade ${kisaTarih(o._tarih)}` : ''}${o._gecikmis ? ` · ${o.gun_gecikme} gün gecikme` : ''}`,
              tutar: o.tutar_girilmedi ? (o._tahmin ? `≈ ${fmt(o._tahmin)}` : 'tutar yok') : fmt(o._tutar),
              tier: o._gecikmis ? 'kritik' : o._bugunMu ? 'uyari' : o.tutar_girilmedi ? 'uyari' : 'bilgi',
              aksiyonlar: o.tutar_girilmedi
                ? [{ ad: 'Tutarı gir', birincil: true, onTikla: () => onKopru?.('odeme-merkezi') }]
                : [
                  { ad: 'Öde', birincil: true, onTikla: () => odemeyiAc(o) },
                  { ad: 'Ertele', onTikla: () => erteleyiAc(o) },
                ],
              _o: o,
            }))}
            onAc={(l) => onCekmece?.({
              tip: 'ÖDEME KALEMİ',
              baslik: l._o.baslik,
              alt: `${l._o.tip}${l._o._tarih ? ` · vade ${kisaTarih(l._o._tarih)}` : ''}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(l._o._tutar) },
                { etiket: 'Asgari', deger: l._o.asgari != null ? fmt(l._o.asgari) : '—' },
                { etiket: 'Durum', deger: l._o._gecikmis ? `${l._o.gun_gecikme} gün gecikme` : 'vadesinde' },
                { etiket: 'Kaynak', deger: l._o.kaynak_tablo || '—' },
              ],
              listeBaslik: 'Kasa etkisi',
              satirlar: [
                { ad: 'Mevcut kasa', detay: 'anlık', tutar: fmt(kasa) },
                { ad: 'Bu ödeme sonrası', detay: 'tek kalem', tutar: fmt(kasa - l._o._tutar) },
              ],
              not: l._o.tedarikci ? `Tedarikçi: ${l._o.tedarikci}` : 'Bu kalem bir tedarikçiye bağlanmamış.',
              aksiyonAd: 'Ödeme Merkezi\'ni aç',
              _hedef: 'odeme-merkezi',
            })}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.yesil }}>Bekleyen ödeme yok</div>
            <div style={{ fontSize: 13, color: R.not, marginTop: 8 }}>Önümüzdeki 14 günde vadesi gelen kalem bulunmuyor.</div>
          </div>
        )}
        {modalBlok}
      </>
    );
  }

  // ── 2) Vade Takvimi ────────────────────────────────────────────────────────
  if (gorunum === 'takvim') {
    const gunler = [];
    for (let i = 0; i < 14; i++) {
      const iso = isoEkle(bugun, i);
      // KPI'larla aynı kaynak: tutarı girilmemiş satırlar takvim toplamına da girmez.
      const gunSatir = tutarli.filter(o => (i === 0 ? (o._gecikmis || o._bugunMu || !o._tarih) : o._tarih === iso));
      const tutar = gunSatir.reduce((s, o) => s + o._tutar, 0);
      gunler.push({
        iso,
        gun: Number(iso.slice(8, 10)),
        haftaGunu: new Date(iso + 'T00:00:00Z').getUTCDay(),
        bugun: i === 0,
        gecikmis: i === 0 && gecikmisSatir.length > 0,
        tutar,
        tutarMetin: fmt(tutar),
        adet: gunSatir.length,
        _satirlar: gunSatir,
      });
    }
    const doluGun = gunler.filter(g => g.tutar > 0);
    const enYogun = doluGun.length ? doluGun.reduce((a, b) => (a.tutar > b.tutar ? a : b)) : null;
    const yedi = gunler.slice(0, 7).reduce((s, g) => s + g.tutar, 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: '14 günlük yük', deger: fmt(toplamKuyruk), alt: `${tutarli.length} kalem${tutarsizNot}` },
          { etiket: 'En yoğun gün', deger: enYogun ? kisaTarih(enYogun.iso) : '—', alt: enYogun ? `${fmt(enYogun.tutar)} · ${enYogun.adet} kalem` : 'ödeme yok', renk: R.amber },
          { etiket: 'Boş gün', deger: String(14 - doluGun.length), alt: 'ödeme yok', renk: R.krem },
          { etiket: 'Kasa yeterliliği', deger: yedi > 0 ? `%${trSayi(Math.min(999, (kasa / yedi) * 100), 0)}` : '—', alt: '7 günlük yük', renk: yedi > 0 && kasa >= yedi ? R.yesil : R.amber },
        ]} />
        <Takvim
          gunler={gunler}
          onGun={(g) => onCekmece?.({
            tip: 'GÜNÜN ÖDEMELERİ',
            baslik: kisaTarih(g.iso),
            alt: `${g.adet} kalem · toplam ${fmt(g.tutar)}`,
            kpi: [
              { etiket: 'Gün toplamı', deger: fmt(g.tutar), renk: R.kirmizi },
              { etiket: 'Sonrası kasa', deger: fmt(kasa - g.tutar), renk: kasa - g.tutar >= 0 ? R.yesil : R.kirmizi },
            ],
            listeBaslik: 'Kalemler',
            satirlar: g._satirlar.map(o => ({ ad: o.baslik, detay: o.tip, tutar: fmt(o._tutar) })),
            not: 'Ödeme yapmak için Bekleyen görünümünü kullan — orada kalem kalem Öde/Ertele var.',
            aksiyonAd: 'Ödeme Merkezi\'ni aç',
            _hedef: 'odeme-merkezi',
          })}
        />
        {modalBlok}
      </>
    );
  }

  // ── 3) Tedarikçi Bakiyesi ──────────────────────────────────────────────────
  if (gorunum === 'tedarikci') {
    const ted = (cari?.tedarikciler || []).map(t => ({
      ad: t.tedarikci || '—',
      acik: Math.max(0, sayi(t.hesaplanan_acik)),
      beyan: t.beyan_bakiye == null ? null : sayi(t.beyan_bakiye),
      fark: t.beyan_hesap_farki == null ? null : sayi(t.beyan_hesap_farki),
      kuyruk: sayi(t.bekleyen_vade_toplam),
      faturaAdet: sayi(t.fatura_adet_6ay),
      hacim: sayi(t.fatura_toplam_6ay),
      sonFatura: t.son_fatura,
      enYakinVade: t.en_yakin_vade,
      izVar: !!t.odeme_izi_var,
      _ham: t,
    }));
    const kritik = ted.filter(t => t.enYakinVade && String(t.enYakinVade).slice(0, 10) <= isoEkle(bugun, 3));
    const enBuyuk = ted.length ? ted.reduce((a, b) => (a.hacim > b.hacim ? a : b)) : null;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif tedarikçi', deger: String(ted.length), alt: `${kritik.length} kritik (3 gün içinde)` },
          { etiket: 'Toplam açık bakiye', deger: fmt(sayi(cari?.toplam_hesaplanan_acik)), alt: 'hesaplanan · ödeme izi düşülmüş', renk: R.kirmizi },
          { etiket: 'Bekleyen vade sözü', deger: fmt(sayi(cari?.toplam_bekleyen_vade)), alt: 'ödeme kuyruğunda', renk: R.amber },
          { etiket: 'En büyük hacim', deger: enBuyuk ? enBuyuk.ad : '—', alt: enBuyuk ? `6 ay ${fmt(enBuyuk.hacim)}` : '—', renk: R.krem },
        ]} />
        {ted.length ? (
          <Tablo
            baslik="Tedarikçi bakiyesi"
            not="satıra tıkla → tedarikçi dosyası"
            kolonlar={[
              { ad: 'Tedarikçi' }, { ad: 'Açık bakiye', sag: true }, { ad: 'Beyan', sag: true },
              { ad: 'Fark', sag: true }, { ad: 'Kuyrukta', sag: true }, { ad: '6 ay hacim', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={ted.map(t => {
              const uyumsuz = t.fark != null && Math.abs(t.fark) > Math.max(500, t.acik * 0.05);
              return {
                id: t.ad, _t: t,
                hucreler: [
                  { v: t.ad, kalin: true },
                  { v: fmt(t.acik), mono: true, sag: true, kalin: true, renk: t.acik > 0 ? R.kirmizi : R.not },
                  { v: t.beyan == null ? '—' : fmt(t.beyan), mono: true, sag: true },
                  { v: t.fark == null ? '—' : fmt(t.fark), mono: true, sag: true, renk: uyumsuz ? R.amber : R.not },
                  { v: fmt(t.kuyruk), mono: true, sag: true },
                  { v: fmt(t.hacim), mono: true, sag: true },
                  {
                    v: uyumsuz ? 'mutabakat farkı' : !t.izVar && t.acik > 0 ? 'ödeme izi yok' : 'normal',
                    rozet: uyumsuz ? R.amber : !t.izVar && t.acik > 0 ? R.kirmizi : R.yesil,
                  },
                ],
              };
            })}
            onSatir={(row) => {
              const t = row._t;
              onCekmece?.({
                tip: 'TEDARİKÇİ DOSYASI',
                baslik: t.ad,
                alt: `6 ayda ${t.faturaAdet} fatura · son ${kisaTarih(t.sonFatura)}`,
                kpi: [
                  { etiket: 'Hesaplanan açık', deger: fmt(t.acik), renk: R.kirmizi },
                  { etiket: 'Tedarikçi beyanı', deger: t.beyan == null ? '—' : fmt(t.beyan) },
                  { etiket: 'Kuyrukta', deger: fmt(t.kuyruk), renk: R.amber },
                  { etiket: 'En yakın vade', deger: kisaTarih(t.enYakinVade) },
                ],
                listeBaslik: '6 aylık hareket',
                satirlar: [
                  { ad: 'Fatura toplamı', detay: `${t.faturaAdet} belge`, tutar: fmt(t.hacim) },
                  { ad: 'Açılış devri', detay: 'sistem öncesi beyan', tutar: fmt(sayi(t._ham.devir)) },
                ],
                not: t.fark != null && Math.abs(t.fark) > Math.max(500, t.acik * 0.05)
                  ? 'İKİ GÖZ UYUŞMUYOR: tedarikçinin beyanı ile bizim hesabımız arasında fark var — eksik fatura, eksik ödeme kaydı ya da sistem-öncesi bakiye olabilir. Hüküm insanın.'
                  : 'Beyan ile hesap uyumlu görünüyor.',
                aksiyonAd: 'Tedarikçi kontrolünü aç',
                _hedef: 'belge-merkezi',
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Tedarikçi cari verisi bulunamadı.
          </div>
        )}
        {modalBlok}
      </>
    );
  }

  // ── 4) Ödeme Geçmişi ───────────────────────────────────────────────────────
  const toplamOdenen = gecmis.reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0);
  const kartla = gecmis.filter(r => r.islem_turu === 'KART_ODEME');
  const ayAdi = `${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}`;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: `${ayAdi} ödemesi`, deger: fmt(toplamOdenen), alt: `${gecmis.length} kayıt` },
        { etiket: 'Kartla ödenen', deger: fmt(kartla.reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0)), alt: `${kartla.length} kayıt`, renk: R.amber },
        { etiket: 'Gecikmiş kalan', deger: fmt(gecikmisToplam), alt: gecikmisSatir.length ? `${gecikmisSatir.length} kalem` : 'gecikme yok', renk: gecikmisSatir.length ? R.kirmizi : R.yesil },
        { etiket: 'Kasa', deger: fmt(kasa), alt: 'anlık bakiye', renk: kasa >= 0 ? R.yesil : R.kirmizi },
      ]} />
      {/* DUYU 5/6 — VADE DİSİPLİNİ: plan vadesi ↔ gerçek ödeme günü (salt-okur).
          Koç Finans vakası tam bu kör noktadandı — gecikme deseni artık görünür. */}
      {vade && sayi(vade.odenen_plan) > 0 && (
        <div style={{
          ...kartYuzey, padding: '16px 18px', marginBottom: 14,
          border: sayi(vade.gec) > 0 ? `1px solid ${R.amber}44` : kartYuzey.border,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
              📅 Vade disiplini · son {sayi(vade.kesit_gun)} gün
            </span>
            <span style={{ fontSize: 10.5, color: R.not2 }}>plan vadesi ↔ gerçek ödeme günü · negatif = erken</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span>Ödenen plan <b style={{ fontFamily: F.mono }}>{sayi(vade.odenen_plan)}</b></span>
            <span>ort. sapma <b style={{ fontFamily: F.mono, color: sayi(vade.ort_gecikme_gun) > 0 ? R.amber : R.yesil }}>{vade.ort_gecikme_gun > 0 ? '+' : ''}{vade.ort_gecikme_gun ?? '—'} gün</b></span>
            <span>erken/zamanında <b style={{ fontFamily: F.mono, color: R.yesil }}>{sayi(vade.erken) + sayi(vade.zamaninda)}</b></span>
            <span>hafif geç (≤3g) <b style={{ fontFamily: F.mono, color: R.amber }}>{sayi(vade.hafif_gec)}</b></span>
            <span>geç (&gt;3g) <b style={{ fontFamily: F.mono, color: sayi(vade.gec) > 0 ? R.kirmizi : R.yesil }}>{sayi(vade.gec)}</b>{vade.gec_orani_yuzde != null ? ` · %${vade.gec_orani_yuzde}` : ''}</span>
          </div>
          {(vade.en_gecler || []).slice(0, 4).map((g, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
              padding: '7px 0', borderTop: i === 0 ? `1px solid ${R.cizgi2}` : 'none', marginTop: i === 0 ? 10 : 0,
            }}>
              <span style={{ fontFamily: F.mono, fontWeight: 700, color: R.kirmizi, minWidth: 58 }}>+{g.gecikme_gun} gün</span>
              <span style={{ flex: 1, color: R.metin2 }}>{g.aciklama || '—'}</span>
              <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(g.tutar))}</span>
            </div>
          ))}
        </div>
      )}
      {gecmis.length ? (
        <Tablo
          baslik={`Ödeme geçmişi · ${ayAdi}`}
          not="satıra tıkla → kayıt ayrıntısı"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'Açıklama' }, { ad: 'Yöntem' }, { ad: 'Tutar', sag: true }, { ad: 'Kaynak' },
          ]}
          satirlar={gecmis.slice(0, 120).map(r => ({
            id: r.id, _r: r,
            hucreler: [
              { v: kisaTarih(r.tarih), mono: true },
              { v: r.aciklama || YONTEM[r.islem_turu] || 'Ödeme', kalin: true },
              { v: YONTEM[r.islem_turu] || slugAd(r.islem_turu), rozet: r.islem_turu === 'KART_ODEME' ? R.amber : R.yesil },
              { v: fmt(Math.abs(sayi(r.tutar))), mono: true, sag: true },
              { v: r.kaynak_tablo || '—', renk: R.not },
            ],
          }))}
          onSatir={(row) => {
            const r = row._r;
            onCekmece?.({
              tip: 'ÖDEME KAYDI',
              baslik: r.aciklama || 'Ödeme',
              alt: `${kisaTarih(r.tarih)} · ${YONTEM[r.islem_turu] || slugAd(r.islem_turu)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(Math.abs(sayi(r.tutar))) },
                { etiket: 'İşlem türü', deger: slugAd(r.islem_turu) },
              ],
              listeBaslik: 'Kaynak bağlantısı',
              satirlar: [
                { ad: 'Kaynak tablo', detay: 'kasa izi', tutar: r.kaynak_tablo || '—' },
                { ad: 'Kasa etkisi', detay: 'deftere işlendi', tutar: fmt(sayi(r.tutar)) },
              ],
              not: 'Bu kayıt kasa izinden geliyor — plan durumu bu izden türer, elle işaretleme yoktur.',
              aksiyonAd: 'İşlem defterini aç',
              _hedef: '__modul:rapor:defter',
            });
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          {ayAdi} ayında ödeme kaydı yok.
        </div>
      )}
      {modalBlok}
    </>
  );
}
