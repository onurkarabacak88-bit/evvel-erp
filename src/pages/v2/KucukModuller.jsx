// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — küçük modüller (13 görünüm, 5 modül)
//
// Bu beşi tek dosyada: hiçbiri YENİ blok gerektirmiyor, hepsi mevcut
// KpiSeridi / Tablo / Liste üçlüsüyle kuruluyor. Ayrı dosyaya bölmek 5 kat
// kalıp kodu üretirdi; büyüyen bir modül çıkarsa kendi dosyasına taşınır.
//
//   OnayModulu    → onaylar.kuyruk / onaylar.ciro
//   YukModulu     → yuk.krediler / yuk.sabit
//   RaporModulu   → rapor.aylik / rapor.defter
//   SistemModulu  → sistem.excel / sistem.teslim / sistem.temizle
//   TanimModulu   → tanim.tedarikciler / tanim.zincir / tanim.dosya / tanim.tv
//
// ⚠️ Hepsi SALT-OKUR. Onaylama, ödeme, silme, fiyat basma gibi yazma işleri
// mevcut guard'lı ekranlarda kalır — buradan köprülenir.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste } from './parcalar';

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

const isoBugun = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

// ─── ortak kabuk parçaları ───────────────────────────────────────────────────
const Yukleniyor = ({ ad }) => (
  <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>{ad} yükleniyor…</div>
);

const Hata = ({ mesaj, onTekrar }) => (
  <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
    <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{mesaj}</div>
    <button onClick={onTekrar} style={{
      marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
      fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
    }}>Tekrar dene</button>
  </div>
);

/** Veri yok / bu ekran henüz veri üretmiyor — uydurma sayı yerine dürüst kutu. */
const Bos = ({ baslik, aciklama, aksiyon, onAksiyon, renk = R.not }) => (
  <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
    <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: renk }}>{baslik}</div>
    {aciklama && (
      <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6, maxWidth: 520, margin: '8px auto 0' }}>
        {aciklama}
      </div>
    )}
    {aksiyon && (
      <button onClick={onAksiyon} style={{
        marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
        background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
        fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
      }}>{aksiyon}</button>
    )}
  </div>
);

/** Ortak yükleyici: uç listesi → state. Hepsi hata-yutar. */
function useVeri(istekler, bagimlilik = []) {
  const [durum, setDurum] = useState({ yukleniyor: true, hata: '', veri: [] });
  const yukle = () => {
    setDurum(d => ({ ...d, yukleniyor: true, hata: '' }));
    Promise.all(istekler.map(([yol, varsayilan]) => api(yol).catch(() => varsayilan)))
      .then(v => setDurum({ yukleniyor: false, hata: '', veri: v }))
      .catch(e => setDurum({ yukleniyor: false, hata: e?.message || 'Veriler alınamadı.', veri: [] }));
  };
  useEffect(yukle, bagimlilik);
  return { ...durum, yukle };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) ONAY BEKLEYENLER — onaylar.kuyruk / onaylar.ciro
// ═════════════════════════════════════════════════════════════════════════════
export function OnayModulu({ gorunum, onCekmece, onKopru }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/onay-kuyrugu?durum=bekliyor&limit=400', []],
    ['/ciro-taslak?durum=bekliyor', []],
    ['/subeler', []],
  ]);
  if (yukleniyor) return <Yukleniyor ad="Onay kuyruğu" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [kuyrukHam, ciroHam, subeler] = veri;
  const kuyruk = Array.isArray(kuyrukHam) ? kuyrukHam : [];
  const ciro = Array.isArray(ciroHam) ? ciroHam : [];
  const subeAd = (id) => (subeler || []).find(s => String(s.id) === String(id))?.ad || '—';

  if (gorunum === 'kuyruk') {
    // ⚠️ Kasa hatası kuralı korundu: islem_turu'nde KASA geçen kayıtlar kuyruğa
    // düşmez (bunlar kasa uyumsuzluğu, onay işi değil) — eski ekrandaki filtre.
    const satir = kuyruk.filter(o => !String(o.islem_turu || '').toUpperCase().includes('KASA'));
    const toplam = satir.reduce((s, o) => s + sayi(o.tutar), 0);
    const gunFark = (t) => {
      if (!t) return null;
      const d = Math.round((new Date(isoBugun() + 'T00:00:00Z') - new Date(String(t).slice(0, 10) + 'T00:00:00Z')) / 86400000);
      return Number.isFinite(d) ? d : null;
    };
    const enEski = satir.reduce((a, o) => Math.max(a, gunFark(o.tarih) ?? 0), 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen onay', deger: String(satir.length), alt: 'gider · avans · fire · tanım', renk: satir.length ? R.amber : R.yesil },
          { etiket: 'Toplam tutar', deger: fmt(toplam), alt: 'onay bekleyen', renk: toplam ? R.amber : R.krem },
          { etiket: 'En eski', deger: enEski ? `${enEski} gün` : '—', alt: enEski > 2 ? 'gecikiyor' : 'taze', renk: enEski > 2 ? R.kirmizi : R.krem },
          { etiket: 'Kasa hatası ayrı', deger: String(kuyruk.length - satir.length), alt: 'onay değil · kasa uyumsuzluğu', renk: R.not },
        ]} />
        {satir.length ? (
          <Liste
            satirlar={satir.slice(0, 60).map(o => ({
              id: o.id, _o: o,
              baslik: o.aciklama || slugAd(o.islem_turu) || 'Onay kaydı',
              alt: `${slugAd(o.islem_turu)} · ${kisaTarih(o.tarih)}${o.kaynak_tablo ? ` · ${o.kaynak_tablo}` : ''}`,
              tutar: sayi(o.tutar) ? fmt(o.tutar) : '',
              tier: (gunFark(o.tarih) ?? 0) > 2 ? 'kritik' : 'uyari',
              aksiyon: 'Onay kuyruğunu aç',
            }))}
            onAc={(l) => onCekmece?.({
              tip: 'ONAY KAYDI',
              baslik: l._o.aciklama || slugAd(l._o.islem_turu),
              alt: `${slugAd(l._o.islem_turu)} · ${kisaTarih(l._o.tarih)}`,
              kpi: [
                { etiket: 'Tutar', deger: sayi(l._o.tutar) ? fmt(l._o.tutar) : '—' },
                { etiket: 'Bekleme', deger: `${gunFark(l._o.tarih) ?? 0} gün`, renk: (gunFark(l._o.tarih) ?? 0) > 2 ? R.kirmizi : R.krem },
              ],
              listeBaslik: 'Kaynak',
              satirlar: [
                { ad: 'İşlem türü', detay: 'kuyruk sınıfı', tutar: slugAd(l._o.islem_turu) },
                { ad: 'Kaynak tablo', detay: 'kaydın geldiği yer', tutar: l._o.kaynak_tablo || '—' },
              ],
              not: 'Onaylama ve reddetme buradan YAPILMAZ — Onay Kuyruğu ekranındaki guard\'lı akış kullanılır.',
              aksiyonAd: 'Onay kuyruğunu aç',
              _hedef: 'onay',
            })}
          />
        ) : (
          <Bos baslik="Onay bekleyen kayıt yok" aciklama="Kuyruk temiz — gider, avans, fire ve tanım değişiklikleri onaylanmış." renk={R.yesil} />
        )}
      </>
    );
  }

  // onaylar.ciro
  const toplamCiro = ciro.reduce((s, c) => s + sayi(c.nakit) + sayi(c.pos) + sayi(c.online), 0);
  const gunler = [...new Set(ciro.map(c => String(c.tarih).slice(0, 10)))];
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Bekleyen ciro onayı', deger: String(ciro.length), alt: gunler.length ? gunler.map(kisaTarih).join(', ') : 'yok', renk: ciro.length ? R.amber : R.yesil },
        { etiket: 'Toplam ciro', deger: fmt(toplamCiro), alt: 'onaylanınca deftere işlenir', renk: R.krem },
        { etiket: 'Şube', deger: String(new Set(ciro.map(c => c.sube_id)).size), alt: 'taslak gönderen', renk: R.krem },
        { etiket: 'Onay sonrası', deger: 'deftere işlenir', alt: 'geri alma: ters kayıt', renk: R.not },
      ]} />
      {ciro.length ? (
        <Tablo
          baslik="Bekleyen ciro onayları"
          not="satıra tıkla → taslak ayrıntısı"
          kolonlar={[
            { ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Nakit', sag: true },
            { ad: 'POS', sag: true }, { ad: 'Online', sag: true }, { ad: 'Toplam', sag: true },
          ]}
          satirlar={ciro.map(c => ({
            id: c.id, _c: c,
            hucreler: [
              { v: c.sube_adi || subeAd(c.sube_id), kalin: true },
              { v: kisaTarih(c.tarih), mono: true },
              { v: fmt(sayi(c.nakit)), mono: true, sag: true },
              { v: fmt(sayi(c.pos)), mono: true, sag: true },
              { v: fmt(sayi(c.online)), mono: true, sag: true },
              { v: fmt(sayi(c.nakit) + sayi(c.pos) + sayi(c.online)), mono: true, sag: true, kalin: true },
            ],
          }))}
          onSatir={(row) => {
            const c = row._c;
            const t = sayi(c.nakit) + sayi(c.pos) + sayi(c.online);
            onCekmece?.({
              tip: 'CİRO TASLAĞI',
              baslik: c.sube_adi || subeAd(c.sube_id),
              alt: `${kisaTarih(c.tarih)} · personel taslağı`,
              kpi: [
                { etiket: 'Toplam', deger: fmt(t) },
                { etiket: 'Nakit payı', deger: t ? `%${trSayi((sayi(c.nakit) / t) * 100, 0)}` : '—' },
              ],
              listeBaslik: 'Kırılım',
              satirlar: [
                { ad: 'Nakit', detay: 'kasaya giren', tutar: fmt(sayi(c.nakit)) },
                { ad: 'POS', detay: 'kart', tutar: fmt(sayi(c.pos)) },
                { ad: 'Online', detay: 'platform', tutar: fmt(sayi(c.online)) },
                { ad: 'Açıklama', detay: 'personel notu', tutar: c.aciklama || '—' },
              ],
              not: 'Onaylandığında ciro defterine işlenir. Onay Ciro Onayı ekranından verilir.',
              aksiyonAd: 'Ciro onayını aç',
              _hedef: 'ciro-taslak-onay',
            });
          }}
        />
      ) : (
        <Bos baslik="Bekleyen ciro onayı yok" aciklama="Şubelerden gelen tüm ciro taslakları işlenmiş." renk={R.yesil} />
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) YÜKÜMLÜLÜKLER — yuk.krediler / yuk.sabit
// ═════════════════════════════════════════════════════════════════════════════
export function YukModulu({ gorunum, onCekmece, onKopru }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/borclar', []],
    ['/sabit-giderler', []],
    ['/sabit-giderler/odemeler', null],
  ]);
  if (yukleniyor) return <Yukleniyor ad="Yükümlülükler" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [krediHam, sabitHam, odemeler] = veri;
  const krediler = (Array.isArray(krediHam) ? krediHam : []).filter(k => k.aktif !== false);
  const sabitler = (Array.isArray(sabitHam) ? sabitHam : []).filter(g => g.aktif !== false);

  if (gorunum === 'krediler') {
    const kalanTop = krediler.reduce((s, k) => s + sayi(k.toplam_borc), 0);
    const taksitTop = krediler.reduce((s, k) => s + sayi(k.aylik_taksit), 0);
    const odemesiz = krediler.filter(k => sayi(k.aylik_taksit) === 0);
    const enYakinBitis = krediler
      .filter(k => sayi(k.kalan_vade) > 0)
      .sort((a, b) => sayi(a.kalan_vade) - sayi(b.kalan_vade))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kalan borç', deger: fmt(kalanTop), alt: `${krediler.length} kredi`, renk: R.kirmizi },
          { etiket: 'Aylık taksit', deger: fmt(taksitTop), alt: 'toplam yük', renk: R.amber },
          { etiket: 'Ödemesiz dönemde', deger: String(odemesiz.length), alt: odemesiz.length ? 'taksiti henüz başlamadı' : 'yok', renk: odemesiz.length ? R.amber : R.yesil },
          { etiket: 'İlk biten', deger: enYakinBitis ? `${enYakinBitis.kalan_vade} taksit` : '—', alt: enYakinBitis ? enYakinBitis.kurum : 'veri yok', renk: R.yesil },
        ]} />
        {krediler.length ? (
          <Tablo
            baslik="Banka kredileri"
            not="satıra tıkla → kredi dosyası"
            kolonlar={[
              { ad: 'Kurum' }, { ad: 'Tür' }, { ad: 'Kalan borç', sag: true },
              { ad: 'Aylık taksit', sag: true }, { ad: 'Kalan vade', sag: true },
              { ad: 'Ödeme günü', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={krediler.map(k => ({
              id: k.id, _k: k,
              hucreler: [
                { v: k.kurum, kalin: true },
                { v: slugAd(k.borc_turu) || '—', renk: R.not },
                { v: fmt(sayi(k.toplam_borc)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: sayi(k.aylik_taksit) ? fmt(k.aylik_taksit) : '—', mono: true, sag: true, renk: sayi(k.aylik_taksit) ? R.amber : R.not },
                { v: `${sayi(k.kalan_vade)}/${sayi(k.toplam_vade)}`, mono: true, sag: true },
                { v: k.odeme_gunu ? `ayın ${k.odeme_gunu}` : '—', mono: true, sag: true },
                {
                  v: sayi(k.aylik_taksit) ? 'ödeniyor' : 'ödemesiz dönem',
                  rozet: sayi(k.aylik_taksit) ? R.yesil : R.amber,
                },
              ],
            }))}
            onSatir={(row) => {
              const k = row._k;
              const odenen = sayi(k.toplam_vade) - sayi(k.kalan_vade);
              onCekmece?.({
                tip: 'KREDİ DOSYASI',
                baslik: k.kurum,
                alt: `${slugAd(k.borc_turu) || 'kredi'} · ${sayi(k.toplam_vade)} taksit`,
                kpi: [
                  { etiket: 'Kalan borç', deger: fmt(sayi(k.toplam_borc)), renk: R.kirmizi },
                  { etiket: 'Aylık taksit', deger: sayi(k.aylik_taksit) ? fmt(k.aylik_taksit) : '—', renk: R.amber },
                  { etiket: 'Ödenen taksit', deger: `${odenen}/${sayi(k.toplam_vade)}` },
                  { etiket: 'Ödeme günü', deger: k.odeme_gunu ? `ayın ${k.odeme_gunu}` : '—' },
                ],
                listeBaslik: 'Zaman çizgisi',
                satirlar: [
                  { ad: 'Başlangıç', detay: 'kredi çekimi', tutar: kisaTarih(k.baslangic_tarihi) },
                  { ad: 'Kalan vade', detay: 'bitmesine', tutar: `${sayi(k.kalan_vade)} taksit` },
                  { ad: 'Kalan toplam ödeme', detay: 'taksit × kalan vade', tutar: fmt(sayi(k.aylik_taksit) * sayi(k.kalan_vade)) },
                ],
                not: sayi(k.aylik_taksit)
                  ? 'Taksit ödeme kuyruğuna otomatik düşer; ödeme Ödeme Merkezi\'nden yapılır.'
                  : 'Ödemesiz dönemde — taksit başladığında aylık yük artacak, borç takviminde görünür.',
                aksiyonAd: 'Borç envanterini aç',
                _hedef: 'borclar',
              });
            }}
          />
        ) : (
          <Bos baslik="Kayıtlı kredi yok" aciklama="Borç envanterine kredi girildiğinde aylık yük buradan izlenir." aksiyon="Borç envanterini aç" onAksiyon={() => onKopru?.('borclar')} />
        )}
      </>
    );
  }

  // yuk.sabit
  const toplamSabit = sabitler.reduce((s, g) => s + sayi(g.tutar), 0);
  const kira = sabitler.filter(g => trKucuk(g.kategori).includes('kira'));
  const odendi = sabitler.filter(g => g.bu_ay_odendi);
  const bekleyen = sabitler.filter(g => !g.bu_ay_odendi);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Aylık sabit gider', deger: fmt(toplamSabit), alt: `${sabitler.length} kalem` },
        { etiket: 'Kira payı', deger: fmt(kira.reduce((s, g) => s + sayi(g.tutar), 0)), alt: toplamSabit ? `%${trSayi((kira.reduce((s, g) => s + sayi(g.tutar), 0) / toplamSabit) * 100, 0)}` : '—', renk: R.krem },
        { etiket: 'Bu ay ödenen', deger: String(odendi.length), alt: fmt(odendi.reduce((s, g) => s + sayi(g.tutar), 0)), renk: R.yesil },
        { etiket: 'Bu ay bekleyen', deger: String(bekleyen.length), alt: fmt(bekleyen.reduce((s, g) => s + sayi(g.tutar), 0)), renk: bekleyen.length ? R.amber : R.yesil },
      ]} />
      {sabitler.length ? (
        <Tablo
          baslik={`Sabit giderler · ${AY_KISA[Number(isoBugun().slice(5, 7)) - 1]}`}
          not="satıra tıkla → gider dosyası"
          kolonlar={[
            { ad: 'Gider' }, { ad: 'Kategori' }, { ad: 'Yer' },
            { ad: 'Tutar', sag: true }, { ad: 'Ödeme günü', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={sabitler.map(g => ({
            id: g.id, _g: g,
            hucreler: [
              { v: g.gider_adi, kalin: true },
              { v: g.kategori || '—', renk: R.not },
              { v: g.sube_adi || 'genel', renk: R.not },
              { v: sayi(g.tutar) ? fmt(g.tutar) : '≈ değişken', mono: true, sag: true, renk: sayi(g.tutar) ? R.krem : R.amber },
              { v: g.odeme_gunu ? `ayın ${g.odeme_gunu}` : '—', mono: true, sag: true },
              { v: g.bu_ay_odendi ? 'ödendi' : 'bekliyor', rozet: g.bu_ay_odendi ? R.yesil : R.amber },
            ],
          }))}
          onSatir={(row) => {
            const g = row._g;
            onCekmece?.({
              tip: 'SABİT GİDER',
              baslik: g.gider_adi,
              alt: `${g.kategori || 'gider'} · ${g.sube_adi || 'genel'}`,
              kpi: [
                { etiket: 'Tutar', deger: sayi(g.tutar) ? fmt(g.tutar) : '≈ değişken' },
                { etiket: 'Periyot', deger: slugAd(g.periyot) || 'aylık' },
                { etiket: 'Ödeme günü', deger: g.odeme_gunu ? `ayın ${g.odeme_gunu}` : '—' },
                { etiket: 'Bu ay', deger: g.bu_ay_odendi ? 'ödendi' : 'bekliyor', renk: g.bu_ay_odendi ? R.yesil : R.amber },
              ],
              listeBaslik: 'Ödeme bilgisi',
              satirlar: [
                { ad: 'Ödeme yöntemi', detay: 'talimat', tutar: slugAd(g.odeme_yontemi) || 'manuel' },
                { ad: 'Başlangıç', detay: 'ilk dönem', tutar: kisaTarih(g.baslangic_tarihi) },
              ],
              not: sayi(g.tutar)
                ? 'Sabit tutarlı gider — ödeme kuyruğuna otomatik düşer.'
                : 'Değişken tutarlı: her ay fatura tutarı sorulur, girilene kadar toplamlara karışmaz.',
              aksiyonAd: 'Sabit giderleri aç',
              _hedef: 'sabit-giderler',
            });
          }}
        />
      ) : (
        <Bos baslik="Sabit gider tanımlı değil" aciklama="Kira, enerji, abonelik gibi düzenli giderler tanımlanınca ödeme kuyruğuna otomatik düşer." aksiyon="Sabit giderleri aç" onAksiyon={() => onKopru?.('sabit-giderler')} />
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) RAPOR & DEFTER — rapor.aylik / rapor.defter
// ═════════════════════════════════════════════════════════════════════════════
export function RaporModulu({ gorunum, onCekmece, onKopru }) {
  const ay = isoBugun().slice(0, 7);
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/rapor/aylik', null],
    [`/ledger?limit=300&ay=${ay}`, null],
  ]);
  if (yukleniyor) return <Yukleniyor ad="Rapor" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [rapor, ledgerHam] = veri;

  if (gorunum === 'aylik') {
    // trend12 tek çağrıda 12 ay verir — ay ay 12 istek atmaya gerek yok.
    const trend = (rapor?.trend12 || []).filter(t => sayi(t.ciro) > 0 || sayi(t.gider) > 0);
    if (!trend.length) {
      return <Bos baslik="Aylık rapor verisi yok" aciklama="Ciro ve gider kaydı biriktikçe aylık karşılaştırma burada oluşur." aksiyon="Aylık raporu aç" onAksiyon={() => onKopru?.('rapor')} />;
    }
    const son = trend[trend.length - 1];
    const toplamCiro = trend.reduce((s, t) => s + sayi(t.ciro), 0);
    const toplamNet = trend.reduce((s, t) => s + sayi(t.net), 0);
    const marj = (t) => (sayi(t.gelir) ? (sayi(t.net) / sayi(t.gelir)) * 100 : 0);
    const enIyi = trend.reduce((a, b) => (marj(a) >= marj(b) ? a : b));
    const enZayif = trend.reduce((a, b) => (marj(a) <= marj(b) ? a : b));
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: `${trend.length} ay ciro`, deger: fmt(toplamCiro), alt: `${trend[0].ay_kisa} – ${son.ay_kisa}` },
          { etiket: `${trend.length} ay net`, deger: fmt(toplamNet), alt: toplamCiro ? `ortalama marj %${trSayi((toplamNet / toplamCiro) * 100)}` : '—', renk: toplamNet >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'En iyi ay', deger: enIyi.ay_kisa, alt: `marj %${trSayi(marj(enIyi))}`, renk: R.yesil },
          { etiket: 'En zayıf ay', deger: enZayif.ay_kisa, alt: `marj %${trSayi(marj(enZayif))}`, renk: R.kirmizi },
        ]} />
        <Tablo
          baslik={`Aylık rapor · son ${trend.length} ay`}
          not="satıra tıkla → ay kırılımı"
          kolonlar={[
            { ad: 'Ay' }, { ad: 'Ciro', sag: true }, { ad: 'Gelir', sag: true },
            { ad: 'Gider', sag: true }, { ad: 'Net', sag: true }, { ad: 'Marj', sag: true },
          ]}
          satirlar={[...trend].reverse().map(t => ({
            id: t.ay, _t: t,
            hucreler: [
              { v: `${t.ay_kisa} ${t.ay.slice(0, 4)}`, kalin: true },
              { v: fmt(sayi(t.ciro)), mono: true, sag: true },
              { v: fmt(sayi(t.gelir)), mono: true, sag: true },
              { v: fmt(sayi(t.gider)), mono: true, sag: true, renk: R.kirmizi },
              { v: fmt(sayi(t.net)), mono: true, sag: true, kalin: true, renk: sayi(t.net) >= 0 ? R.yesil : R.kirmizi },
              { v: `%${trSayi(marj(t))}`, mono: true, sag: true, renk: marj(t) >= 15 ? R.yesil : marj(t) >= 8 ? R.amber : R.kirmizi },
            ],
          }))}
          onSatir={(row) => {
            const t = row._t;
            onCekmece?.({
              tip: 'AY KIRILIMI',
              baslik: `${t.ay_kisa} ${t.ay.slice(0, 4)}`,
              alt: `net ${fmt(sayi(t.net))} · marj %${trSayi(marj(t))}`,
              kpi: [
                { etiket: 'Ciro', deger: fmt(sayi(t.ciro)) },
                { etiket: 'Net', deger: fmt(sayi(t.net)), renk: sayi(t.net) >= 0 ? R.yesil : R.kirmizi },
              ],
              listeBaslik: 'Kalemler',
              satirlar: [
                { ad: 'Toplam gelir', detay: 'ciro + dış kaynak', tutar: fmt(sayi(t.gelir)) },
                { ad: 'Toplam gider', detay: 'kasa çıkışları', tutar: fmt(sayi(t.gider)) },
                { ad: 'Net', detay: 'gelir − gider', tutar: fmt(sayi(t.net)) },
              ],
              not: 'Rakamlar kasa hareketlerinden gelir — kasa izi tek gerçek.',
              aksiyonAd: 'Aylık raporu aç',
              _hedef: 'rapor',
            });
          }}
        />
      </>
    );
  }

  // rapor.defter
  const satir = Array.isArray(ledgerHam) ? ledgerHam : (ledgerHam?.rows || []);
  const ozet = ledgerHam?.ozet || {};
  const gelir = sayi(ozet.toplam_gelir) || satir.filter(r => sayi(r.tutar) > 0).reduce((s, r) => s + sayi(r.tutar), 0);
  const gider = sayi(ozet.toplam_gider) || satir.filter(r => sayi(r.tutar) < 0).reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Kayıt', deger: String(satir.length), alt: `${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}` },
        { etiket: 'Giren', deger: fmt(gelir), alt: 'kasa girişi', renk: R.yesil },
        { etiket: 'Çıkan', deger: fmt(gider), alt: 'kasa çıkışı', renk: R.kirmizi },
        { etiket: 'Net', deger: fmt(gelir - gider), alt: 'bu ay', renk: gelir - gider >= 0 ? R.yesil : R.kirmizi },
      ]} />
      {satir.length ? (
        <Tablo
          baslik={`İşlem defteri · ${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}`}
          not="satıra tıkla → kayıt ayrıntısı"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'İşlem' }, { ad: 'Açıklama' }, { ad: 'Tutar', sag: true }, { ad: 'Kaynak' },
          ]}
          satirlar={satir.slice(0, 150).map(r => ({
            id: r.id, _r: r,
            hucreler: [
              { v: kisaTarih(r.tarih), mono: true },
              { v: slugAd(r.islem_turu), rozet: sayi(r.tutar) >= 0 ? R.yesil : R.bakir },
              { v: r.aciklama || '—', kalin: true },
              { v: fmt(sayi(r.tutar)), mono: true, sag: true, kalin: true, renk: sayi(r.tutar) >= 0 ? R.yesil : R.kirmizi },
              { v: r.kaynak_tablo || '—', renk: R.not },
            ],
          }))}
          onSatir={(row) => {
            const r = row._r;
            onCekmece?.({
              tip: 'DEFTER KAYDI',
              baslik: r.aciklama || slugAd(r.islem_turu),
              alt: `${kisaTarih(r.tarih)} · ${slugAd(r.islem_turu)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(sayi(r.tutar)), renk: sayi(r.tutar) >= 0 ? R.yesil : R.kirmizi },
                { etiket: 'Yön', deger: sayi(r.tutar) >= 0 ? 'giriş' : 'çıkış' },
              ],
              listeBaslik: 'Bağlantı',
              satirlar: [
                { ad: 'Kaynak tablo', detay: 'kaydın doğduğu yer', tutar: r.kaynak_tablo || '—' },
                { ad: 'İşlem türü', detay: 'defter sınıfı', tutar: slugAd(r.islem_turu) },
              ],
              not: 'İşlem defteri append-only\'dir; düzeltme ters kayıtla yapılır.',
              aksiyonAd: 'İşlem defterini aç',
              _hedef: 'ledger',
            });
          }}
        />
      ) : (
        <Bos baslik="Bu ay defter kaydı yok" aciklama="Kasa hareketi oluştukça işlem defteri dolar." aksiyon="İşlem defterini aç" onAksiyon={() => onKopru?.('ledger')} />
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4) VERİ & SİSTEM — sistem.excel / sistem.teslim / sistem.temizle
// ═════════════════════════════════════════════════════════════════════════════
export function SistemModulu({ gorunum, onCekmece, onKopru }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/teslim-bildirim/liste?gun=7', null],
    ['/ops/siparis/depo-akisi-kalinti', null],
    ['/import-izi?limit=30', null],  // DUYU 6/6: import iz defteri
  ]);
  if (yukleniyor) return <Yukleniyor ad="Sistem" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [teslimHam, kalinti, importIzi] = veri;
  const olaylar = teslimHam?.olaylar || (Array.isArray(teslimHam) ? teslimHam : []);

  if (gorunum === 'excel') {
    // DUYU 6/6 (2026-07-29): "Yükleme geçmişi kayıt altına alınmıyor" eksiği
    // KAPANDI — import_izi append-only defteri her yüklemeyi damgalar.
    const izler = importIzi?.kayitlar || [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kayıtlı yükleme', deger: String(izler.length), alt: 'iz defteri (append-only)' },
          { etiket: 'Son yükleme', deger: izler[0] ? String(izler[0].olusturma).slice(5, 16) : '—', alt: izler[0] ? `${izler[0].toplam_eklenen ?? 0} satır eklendi` : 'henüz iz yok' },
          { etiket: 'Toplam eklenen', deger: String(izler.reduce((s, r) => s + (Number(r.toplam_eklenen) || 0), 0)), alt: 'izlenen yüklemelerde', renk: R.yesil },
          { etiket: 'Hatalı satır', deger: String(izler.reduce((s, r) => s + (Number(r.hata_sayisi) || 0), 0)), alt: 'atlanan kayıtlar', renk: izler.some(r => Number(r.hata_sayisi) > 0) ? R.amber : R.yesil },
        ]} />
        {izler.length === 0 ? (
          <Bos
            baslik="Excel Import"
            aciklama="Banka ekstresi ve POS dosyaları (XLSX · CSV) buradan yüklenir. İz defteri bu ilk kurulumla açıldı — bundan sonraki her yükleme burada damgalanır."
            aksiyon="Excel Import'u aç"
            onAksiyon={() => onKopru?.('excel')}
          />
        ) : (
          <Tablo
            baslik="Yükleme iz defteri"
            not="her import kim/ne zaman/kaç satır iziyle damgalanır"
            kolonlar={[{ ad: 'Zaman' }, { ad: 'Dosya' }, { ad: 'Eklenen', sag: true }, { ad: 'Hata', sag: true }]}
            satirlar={izler.map((r, i) => ({
              id: `iz-${i}`,
              hucreler: [
                { v: String(r.olusturma || '—'), mono: true, renk: R.not },
                { v: r.dosya_adi || '—', kalin: true },
                { v: String(r.toplam_eklenen ?? 0), mono: true, sag: true, renk: R.yesil },
                { v: String(r.hata_sayisi ?? 0), mono: true, sag: true, renk: Number(r.hata_sayisi) > 0 ? R.amber : R.not },
              ],
            }))}
            onSatir={() => onKopru?.('excel')}
          />
        )}
      </>
    );
  }

  if (gorunum === 'teslim') {
    const gorulmemis = olaylar.filter(o => !o.gorulme_zamani && !o.gorildi);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Son 7 gün teslim', deger: String(olaylar.length), alt: 'şube depo teslimleri' },
          { etiket: 'Görülmemiş', deger: String(gorulmemis.length), alt: gorulmemis.length ? 'bildirim bekliyor' : 'hepsi görüldü', renk: gorulmemis.length ? R.mavi : R.yesil },
          { etiket: 'Şube', deger: String(new Set(olaylar.map(o => o.sube_adi).filter(Boolean)).size), alt: 'teslim alan', renk: R.krem },
          { etiket: 'Kalıcı onay', deger: '"Tamam" sunucuda', alt: 'bir daha çıkmaz', renk: R.not },
        ]} />
        {olaylar.length ? (
          <Liste
            satirlar={olaylar.slice(0, 40).map((o, i) => ({
              id: o.anahtar || i, _o: o,
              baslik: `${o.sube_adi || 'Şube'} · ${o.baslik || 'teslim işlendi'}`,
              alt: [o.zaman ? kisaTarih(o.zaman) : null, o.detay].filter(Boolean).join(' · ') || 'ayrıntı yok',
              tutar: sayi(o.tutar) ? fmt(o.tutar) : '',
              tier: (!o.gorulme_zamani && !o.gorildi) ? 'bilgi' : 'iyi',
              aksiyon: 'Bilgi teslimi aç',
            }))}
            onAc={() => onKopru?.('teslim-kayit')}
          />
        ) : (
          <Bos baslik="Son 7 günde teslim bildirimi yok" aciklama="Şube depodan teslim aldığında bildirim burada görünür." renk={R.yesil} />
        )}
      </>
    );
  }

  // sistem.temizle
  const kalintiAdet = sayi(kalinti?.toplam) || (kalinti?.kayitlar || []).length;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Depo akışı kalıntısı', deger: String(kalintiAdet), alt: kalintiAdet ? 'temizlenebilir kayıt' : 'temiz', renk: kalintiAdet ? R.amber : R.yesil },
        { etiket: 'Yedek', deger: 'otomatik', alt: 'silmeden önce alınır', renk: R.yesil },
        { etiket: 'Geri alma', deger: 'ters kayıt', alt: 'defter append-only', renk: R.not },
        { etiket: 'Yetki', deger: 'sahip', alt: 'mutasyon anahtarı gerekir', renk: R.not },
      ]} />
      <Liste
        satirlar={[
          ...(kalintiAdet ? [{
            id: 'kalinti',
            baslik: `Depo akışı kalıntısı · ${kalintiAdet} kayıt`,
            alt: 'tamamlanmış sipariş akışından artakalan geçici kayıtlar',
            tutar: `${kalintiAdet} kayıt`, tier: 'uyari', aksiyon: 'Veri Temizle\'yi aç',
            _hedef: 'veri-temizle',
          }] : []),
          {
            id: 'merkez',
            baslik: 'Merkez sipariş temizliği',
            alt: 'tamamlanmış siparişlerin eskileri arşive iner',
            tutar: 'arşiv', tier: 'bilgi', aksiyon: 'Temizliği aç',
            _hedef: 'merkez-temizlik',
          },
          {
            id: 'sifirla',
            baslik: 'Sistem sıfırlama',
            alt: 'TÜM işlem verisini siler — yalnızca demo/kurulum aşamasında kullanılır',
            tutar: 'tehlikeli', tier: 'kritik', aksiyon: 'Veri Temizle\'yi aç',
            _hedef: 'veri-temizle',
          },
        ]}
        onAc={(l) => onKopru?.(l._hedef)}
      />
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) TANIMLAR — tanim.tedarikciler / zincir / dosya / tv
// ═════════════════════════════════════════════════════════════════════════════
export function TanimModulu({ gorunum, onCekmece, onKopru }) {
  const { yukleniyor, hata, veri, yukle } = useVeri([
    ['/tedarikciler', []],
    ['/ops/tedarik-dosyasi?gun=60&limit=150', null],
    ['/tv-menu/liste', []],
  ]);
  if (yukleniyor) return <Yukleniyor ad="Tanımlar" />;
  if (hata) return <Hata mesaj={hata} onTekrar={yukle} />;

  const [tedHam, dosyaHam, tvHam] = veri;
  const tedarikciler = (Array.isArray(tedHam) ? tedHam : []).filter(t => t.aktif !== false);
  const dosyalar = dosyaHam?.dosyalar || [];
  const tv = Array.isArray(tvHam) ? tvHam : [];

  if (gorunum === 'tedarikciler') {
    const kategoriler = [...new Set(tedarikciler.map(t => t.kategori).filter(Boolean))];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif tedarikçi', deger: String(tedarikciler.length), alt: `${kategoriler.length} kategori` },
          { etiket: 'Telefonu kayıtlı', deger: String(tedarikciler.filter(t => t.telefon).length), alt: 'WhatsApp ile ulaşılabilir', renk: R.yesil },
          { etiket: 'Telefonu eksik', deger: String(tedarikciler.filter(t => !t.telefon).length), alt: 'fatura isteği gönderilemez', renk: tedarikciler.some(t => !t.telefon) ? R.amber : R.yesil },
          { etiket: 'Kategori', deger: String(kategoriler.length), alt: kategoriler.slice(0, 3).join(', ') || '—', renk: R.krem },
        ]} />
        {tedarikciler.length ? (
          <Tablo
            baslik="Tedarikçi tanımları"
            not="satıra tıkla → tedarikçi dosyası"
            kolonlar={[{ ad: 'Tedarikçi' }, { ad: 'Kategori' }, { ad: 'Telefon' }, { ad: 'Açıklama' }, { ad: 'Durum' }]}
            satirlar={tedarikciler.map(t => ({
              id: t.id, _t: t,
              hucreler: [
                { v: t.ad, kalin: true },
                { v: t.kategori || '—', renk: R.not },
                { v: t.telefon || '—', mono: true, renk: t.telefon ? R.krem : R.amber },
                { v: t.aciklama || '—', renk: R.not },
                { v: t.telefon ? 'tam' : 'telefon eksik', rozet: t.telefon ? R.yesil : R.amber },
              ],
            }))}
            onSatir={(row) => {
              const t = row._t;
              onCekmece?.({
                tip: 'TEDARİKÇİ',
                baslik: t.ad,
                alt: t.kategori || 'kategori girilmemiş',
                kpi: [
                  { etiket: 'Kategori', deger: t.kategori || '—' },
                  { etiket: 'İletişim', deger: t.telefon ? 'kayıtlı' : 'eksik', renk: t.telefon ? R.yesil : R.amber },
                ],
                listeBaslik: 'Tanım',
                satirlar: [
                  { ad: 'Telefon', detay: 'fatura isteği için', tutar: t.telefon || '—' },
                  { ad: 'Açıklama', detay: 'not', tutar: t.aciklama || '—' },
                ],
                not: t.telefon
                  ? 'Fatura isteği WhatsApp ile tek dokunuşla gönderilebilir.'
                  : 'Telefon kayıtlı değil — fatura isteği motoru bu tedarikçiye mesaj gönderemez.',
                aksiyonAd: 'Tedarikçileri aç',
                _hedef: 'tedarikciler',
              });
            }}
          />
        ) : (
          <Bos baslik="Tanımlı tedarikçi yok" aksiyon="Tedarikçileri aç" onAksiyon={() => onKopru?.('tedarikciler')} />
        )}
      </>
    );
  }

  if (gorunum === 'zincir' || gorunum === 'dosya') {
    // Aynı kaynak iki görünüme bakar: `zincir` sipariş→kabul→fatura akışının
    // AÇIK olanlarına, `dosya` tüm dosya arşivine.
    const acik = dosyalar.filter(d => sayi(d.fatura_say) === 0 || slugAd(d.kabul_durum).includes('uyum'));
    const liste = gorunum === 'zincir' ? acik : dosyalar;
    const tamEslesen = dosyalar.filter(d => sayi(d.fatura_say) > 0 && !slugAd(d.kabul_durum).includes('uyum'));
    return (
      <>
        <KpiSeridi kpiler={gorunum === 'zincir' ? [
          { etiket: 'Açık zincir', deger: String(acik.length), alt: 'kabul veya fatura eksik', renk: acik.length ? R.amber : R.yesil },
          { etiket: 'Tam kapanan', deger: `${tamEslesen.length} / ${dosyalar.length}`, alt: 'son 60 gün', renk: R.yesil },
          { etiket: 'Faturasız teslim', deger: String(dosyalar.filter(d => sayi(d.fatura_say) === 0).length), alt: 'belge bekliyor', renk: R.kirmizi },
          { etiket: 'Kabul uyumsuz', deger: String(dosyalar.filter(d => slugAd(d.kabul_durum).includes('uyum')).length), alt: 'adet farkı', renk: R.amber },
        ] : [
          { etiket: 'Tedarik dosyası', deger: String(dosyalar.length), alt: 'son 60 gün sipariş' },
          { etiket: 'Faturalı', deger: String(dosyalar.filter(d => sayi(d.fatura_say) > 0).length), alt: 'belge eklenmiş', renk: R.yesil },
          { etiket: 'Faturasız', deger: String(dosyalar.filter(d => sayi(d.fatura_say) === 0).length), alt: 'belge eksik', renk: R.kirmizi },
          { etiket: 'Şube', deger: String(new Set(dosyalar.map(d => d.sube_adi).filter(Boolean)).size), alt: 'sipariş veren', renk: R.krem },
        ]} />
        {liste.length ? (
          <Tablo
            baslik={gorunum === 'zincir' ? 'Sipariş → kabul → fatura zinciri' : 'Tedarik dosyası · son 60 gün'}
            not="satıra tıkla → zincir dosyası"
            kolonlar={[
              { ad: 'Sipariş' }, { ad: 'Şube' }, { ad: 'Tarih' },
              { ad: 'Toptancı' }, { ad: 'Fatura', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={liste.slice(0, 120).map(d => ({
              id: d.talep_id, _d: d,
              hucreler: [
                { v: `#${String(d.talep_id).slice(0, 8)}`, mono: true, kalin: true },
                { v: d.sube_adi || '—' },
                { v: kisaTarih(d.tarih), mono: true },
                { v: d.tedarikciler || '—', renk: R.not },
                { v: String(sayi(d.fatura_say)), mono: true, sag: true, renk: sayi(d.fatura_say) ? R.yesil : R.kirmizi },
                {
                  v: sayi(d.fatura_say) === 0 ? 'fatura bekliyor'
                    : slugAd(d.kabul_durum).includes('uyum') ? 'kabul uyumsuz' : 'kapandı',
                  rozet: sayi(d.fatura_say) === 0 ? R.kirmizi
                    : slugAd(d.kabul_durum).includes('uyum') ? R.amber : R.yesil,
                },
              ],
            }))}
            onSatir={(row) => {
              const d = row._d;
              onCekmece?.({
                tip: 'ZİNCİR DOSYASI',
                baslik: `Sipariş #${String(d.talep_id).slice(0, 8)}`,
                alt: `${d.sube_adi || 'şube'} · ${kisaTarih(d.tarih)}`,
                kpi: [
                  { etiket: 'Fatura', deger: String(sayi(d.fatura_say)), renk: sayi(d.fatura_say) ? R.yesil : R.kirmizi },
                  { etiket: 'Sipariş durumu', deger: slugAd(d.durum) || '—' },
                ],
                listeBaslik: 'Zincir noktaları',
                satirlar: [
                  { ad: 'Talep', detay: 'şube siparişi', tutar: kisaTarih(d.tarih) },
                  { ad: 'Toptancı', detay: 'sipariş verilen', tutar: d.tedarikciler || '—' },
                  { ad: 'Kabul', detay: 'şube teslim aldı', tutar: slugAd(d.kabul_durum) || '—' },
                  { ad: 'Fatura', detay: 'belge sayısı', tutar: `${sayi(d.fatura_say)} belge` },
                ],
                not: sayi(d.fatura_say) === 0
                  ? 'Bu teslimatın faturası henüz gelmemiş — belge talep motoru tedarikçiyi kovalar.'
                  : 'Zincirin dört noktası da kayıtlı; adet ve fiyat varyansı Tedarik Dosyası detayında.',
                aksiyonAd: 'Tedarik dosyasını aç',
                _hedef: 'tedarik-dosyasi',
              });
            }}
          />
        ) : (
          <Bos
            baslik={gorunum === 'zincir' ? 'Açık zincir yok' : 'Tedarik dosyası boş'}
            aciklama={gorunum === 'zincir'
              ? 'Son 60 günde kabulü ve faturası tamamlanmamış sipariş bulunmuyor.'
              : 'Son 60 günde toptancı zinciri olan sipariş kaydı yok.'}
            renk={gorunum === 'zincir' ? R.yesil : R.not}
          />
        )}
      </>
    );
  }

  // tanim.tv
  const yayinda = tv.filter(u => u.aktif !== false && u.gorunur !== false);
  const kategoriler = [...new Set(tv.map(u => u.kategori).filter(Boolean))];
  const fiyatli = tv.filter(u => sayi(u.f8) > 0 || sayi(u.f14) > 0 || sayi(u.fice) > 0);
  const fiyatMetni = (u) => {
    const p = [sayi(u.f8), sayi(u.f14), sayi(u.fice)].filter(x => x > 0);
    return p.length ? `${fmt(Math.min(...p)).replace(' ₺', '')}–${fmt(Math.max(...p))}` : '—';
  };
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Yayındaki ürün', deger: String(yayinda.length), alt: `${tv.length} tanımlı ürün`, renk: R.yesil },
        { etiket: 'Gizli', deger: String(tv.length - yayinda.length), alt: 'menüden kaldırılmış', renk: tv.length - yayinda.length ? R.amber : R.krem },
        { etiket: 'Kategori', deger: String(kategoriler.length), alt: kategoriler.slice(0, 3).join(', ') || '—', renk: R.krem },
        { etiket: 'Fiyatı girilmemiş', deger: String(tv.length - fiyatli.length), alt: 'ekranda boş görünür', renk: tv.length - fiyatli.length ? R.kirmizi : R.yesil },
      ]} />
      {tv.length ? (
        <Tablo
          baslik="TV menü içeriği"
          not="satıra tıkla → ürün ayrıntısı · fiyat düzenleme TV Menü ekranında"
          kolonlar={[{ ad: 'Ürün' }, { ad: 'Kategori' }, { ad: 'Fiyat', sag: true }, { ad: 'Sıra', sag: true }, { ad: 'Yayın' }]}
          satirlar={tv.slice(0, 150).map(u => ({
            id: u.id, _u: u,
            hucreler: [
              { v: u.ad, kalin: true },
              { v: u.kategori || '—', renk: R.not },
              { v: fiyatMetni(u), mono: true, sag: true, renk: fiyatli.includes(u) ? R.krem : R.kirmizi },
              { v: String(sayi(u.sira)), mono: true, sag: true },
              {
                v: (u.aktif !== false && u.gorunur !== false) ? 'yayında' : 'gizli',
                rozet: (u.aktif !== false && u.gorunur !== false) ? R.yesil : R.not,
              },
            ],
          }))}
          onSatir={(row) => {
            const u = row._u;
            onCekmece?.({
              tip: 'TV MENÜ ÜRÜNÜ',
              baslik: u.ad,
              alt: `${u.kategori || 'kategori yok'} · ${(u.aktif !== false && u.gorunur !== false) ? 'yayında' : 'gizli'}`,
              kpi: [
                { etiket: 'Fiyat aralığı', deger: fiyatMetni(u) },
                { etiket: 'Sıra', deger: String(sayi(u.sira)) },
              ],
              listeBaslik: 'Boy fiyatları',
              satirlar: [
                { ad: '8 oz', detay: 'küçük', tutar: sayi(u.f8) ? fmt(u.f8) : '—' },
                { ad: '14 oz', detay: 'büyük', tutar: sayi(u.f14) ? fmt(u.f14) : '—' },
                { ad: 'Ice', detay: 'soğuk', tutar: sayi(u.fice) ? fmt(u.fice) : '—' },
              ],
              not: 'TV menü TULİPİ markasının kendi tasarım dilini kullanır — müşteri ekranı kadife koyuya çevrilmez, burası yalnız yönetim görünümü.',
              aksiyonAd: 'TV Menü yönetimini aç',
              _hedef: 'tv-menu',
            });
          }}
        />
      ) : (
        <Bos baslik="TV menüsünde ürün yok" aksiyon="TV Menü yönetimini aç" onAksiyon={() => onKopru?.('tv-menu')} />
      )}
    </>
  );
}
