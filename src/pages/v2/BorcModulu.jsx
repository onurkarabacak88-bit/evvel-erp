// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Borç Navigasyonu modülü (4 görünüm)
//
// Tasarım: ICERIK → borc.durum (gauge) / borc.takvim (eğri) / borc.hedef (tablo)
//                   / borc.katki (katkı çubuğu)
//
// Motor zaten kurulu (borc_navigasyon_api.py) — bu modül YALNIZ GÖRSELLEŞTİRİR.
// Yeni hesap yapılmaz; ABEK, BBE, senaryolar hep uçtan gelir.
//
// Veri uçları (salt-okur):
//   /borc-nav/ozet          → BBE skoru + bileşenleri, ABEK, runway, borç tablosu
//   /borc-nav/takvim?ay=36  → aylık zorunlu yük ızgarası + en zor ay + biten krediler
//   /borc-nav/olcek-plani   → "hangi ciroyla hangi yapı" senaryoları
//   /borc-nav/sube-katki    → şube şube ortak havuz katkısı
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, Gauge, YukEgrisi, KatkiCubugu } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
/** '2027-02' → 'Şub 27' (tasarımdaki kısa ay biçimi). */
const kisaAy = (ym) => {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(ym || '—');
  return `${AY_KISA[Number(m[2]) - 1]} ${m[1].slice(2)}`;
};

/** Motorun renk adı → tema rengi. Bilinmeyen ad kırmızıya düşmez, nötr kalır. */
const RENK_AD = { KIRMIZI: R.kirmizi, TURUNCU: R.amber, SARI: R.amber, YESIL: R.yesil, YEŞIL: R.yesil, MAVI: R.mavi };
const renkCoz = (ad, varsayilan = R.amber) => RENK_AD[String(ad || '').toUpperCase()] || varsayilan;

export default function BorcModulu({ gorunum, onCekmece, onKopru }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [ozet, setOzet] = useState(null);
  const [takvim, setTakvim] = useState(null);
  const [olcek, setOlcek] = useState(null);
  const [katki, setKatki] = useState(null);
  // 5. görünüm (köprü kaldırma turu, 2026-07-30): klasik BorcNavigasyon'daki
  // 12 aylık projeksiyon v2'de karşılıksızdı — köprü yerine yerli görünüm.
  const [proj, setProj] = useState(null);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/borc-nav/ozet').catch(() => null),
      api('/borc-nav/takvim?ay=36').catch(() => null),
      api('/borc-nav/olcek-plani').catch(() => null),
      api('/borc-nav/sube-katki?gun=30').catch(() => null),
      api('/borc-nav/projeksiyon?ay=12').catch(() => null),
    ]).then(([o, t, ol, k, p]) => {
      setOzet(o); setTakvim(t); setOlcek(ol); setKatki(k); setProj(p);
      if (!o && !t) setHata('Borç navigasyon verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  useEffect(yukle, []);

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Borç verileri yükleniyor…</div>;
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

  const kpi = ozet?.kpi || {};
  const bbe = kpi.borc_baski_endeksi || {};
  const borc = ozet?.borc || {};
  const abek = ozet?.abek || {};
  const hedef = ozet?.hedef_ciro || {};

  // ── 1) Bu Ay Batıyor Muyum? (gauge) ────────────────────────────────────────
  if (gorunum === 'durum') {
    if (!ozet) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Borç özeti hesaplanamadı — ciro ve borç kaydı biriktikçe endeks oluşur.
        </div>
      );
    }
    const renk = renkCoz(bbe.renk, R.kirmizi);
    const aylikAcik = sayi(kpi.tahmini_acik?.aylik_yapisal);
    const runway = kpi.runway_ay;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam borç', deger: fmt(sayi(borc.toplam)), alt: `kart ${fmt(sayi(borc.kart_toplam)).replace(' ₺', '')} + kredi ${fmt(sayi(borc.kredi_kalan))}`, renk: R.kirmizi },
          { etiket: 'ABEK · aylık kapasite', deger: fmt(sayi(abek.deger)), alt: `ciro ${fmt(sayi(abek.ciro_ay)).replace(' ₺', '')} · nakit marj %${trSayi(sayi(abek.nakit_marj_pct))}`, renk: sayi(abek.deger) > 0 ? R.yesil : R.kirmizi },
          { etiket: 'Zorunlu yük', deger: fmt(sayi(borc.zorunlu_yuk)), alt: `kart asgari ${fmt(sayi(borc.kart_asgari)).replace(' ₺', '')} + kredi ${fmt(sayi(borc.kredi_taksiti)).replace(' ₺', '')}`, renk: R.krem },
          { etiket: 'Aylık açık', deger: fmt(aylikAcik), alt: aylikAcik < 0 ? 'her ay borca ekleniyor' : 'kapasite yetiyor', renk: aylikAcik < 0 ? R.kirmizi : R.yesil },
        ]} />

        <Gauge
          skor={bbe.skor}
          durum={bbe.durum || '—'}
          renk={renk}
          not={ozet.surdurulemez
            ? 'Borç çevriliyor ama kapanmıyor: zorunlu yük aylık kapasiteyi (ABEK) aşıyor. Fark her ay ana paraya ekleniyor.'
            : 'Zorunlu yük aylık kapasitenin altında — mevcut tempoda borç kontrol altında.'}
          bilesenler={(ozet.bbe_bilesenler || []).map(b => ({
            ad: b.ad,
            agirlik: `%${Math.round(sayi(b.agirlik) * 100)}`,
            skor: trSayi(sayi(b.skor), 0),
            skorSayi: sayi(b.skor),
            renk,
          }))}
          saglik={[
            {
              etiket: 'Runway',
              deger: runway == null ? '—' : `${trSayi(runway)} ay`,
              alt: runway == null ? 'hesaplanamadı' : 'mevcut tempoda nakit tükenir',
              renk: renkCoz(kpi.runway_renk, R.amber),
            },
            {
              etiket: 'Ay sonu tahminî açık',
              deger: fmt(sayi(kpi.tahmini_acik?.ay_sonu)),
              alt: 'bugünkü gidişle',
              renk: sayi(kpi.tahmini_acik?.ay_sonu) < 0 ? R.kirmizi : R.yesil,
            },
            {
              etiket: 'Hedef ciro · borç sabit',
              deger: hedef.borc_sabit ? fmt(hedef.borc_sabit) : '—',
              alt: hedef.borc_sabit && sayi(abek.ciro_ay)
                ? `şu an ${fmt(sayi(abek.ciro_ay)).replace(' ₺', '')} · ${trSayi(sayi(hedef.borc_sabit) / sayi(abek.ciro_ay), 2)}×`
                : 'marj negatifken hesaplanamaz',
              renk: R.bakir,
            },
            {
              etiket: 'Borç / yıllık ciro',
              deger: sayi(abek.ciro_ay) ? `%${trSayi((sayi(borc.toplam) / (sayi(abek.ciro_ay) * 12)) * 100)}` : '—',
              alt: sayi(abek.ciro_ay) ? `${fmt(sayi(borc.toplam)).replace(' ₺', '')} / ${fmt(sayi(abek.ciro_ay) * 12)}` : '—',
              renk: R.amber,
            },
          ]}
        />

        {!!(ozet.notlar || []).length && (
          <Liste
            satirlar={(ozet.notlar || []).slice(0, 6).map((n, i) => ({
              id: `n${i}`,
              _n: n,
              baslik: typeof n === 'string' ? n : (n.baslik || 'Not'),
              alt: typeof n === 'string' ? 'motor notu' : (n.aciklama || ''),
              tutar: '',
              tier: 'bilgi',
            }))}
            onAc={({ _n }) => onCekmece?.({
              tip: 'MOTOR NOTU',
              baslik: typeof _n === 'string' ? _n : (_n.baslik || 'Not'),
              alt: 'borç navigasyon motoru · öneri-only',
              kpi: [
                { etiket: 'Toplam borç', deger: fmt(sayi(borc.toplam)), renk: R.kirmizi },
                { etiket: 'ABEK', deger: fmt(sayi(abek.deger)), renk: sayi(abek.deger) > 0 ? R.yesil : R.kirmizi },
              ],
              listeBaslik: 'Notun dayanağı',
              satirlar: [
                { ad: 'Açıklama', detay: 'motor gerekçesi', tutar: typeof _n === 'string' ? '—' : (_n.aciklama || '—') },
                { ad: 'Zorunlu yük', detay: 'kart asgari + kredi taksiti', tutar: fmt(sayi(borc.zorunlu_yuk)) },
              ],
              not: 'Bu not motorun gözlemidir; karar sahibin. Ayrıntılı gidişat için Nakit Projeksiyonu görünümüne bak.',
              aksiyonAd: 'Nakit projeksiyonuna git',
              _hedef: '__gorunum:projeksiyon',
            })}
          />
        )}
      </>
    );
  }

  // ── 2) Borç Takvimi · 36 ay (eğri) ─────────────────────────────────────────
  if (gorunum === 'takvim') {
    const grid = takvim?.takvim || [];
    if (!grid.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Takvim üretilemedi — kredi ve kart kaydı girildiğinde 36 aylık yük eğrisi burada oluşur.
        </div>
      );
    }
    const peak = takvim.peak;
    const abekAylik = sayi(takvim.abek_aylik);
    const acikAylar = grid.filter(g => sayi(g.acik) > 0);
    const ilkRahatlama = (takvim.kredi_biten_takvim || [])[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Finansal borç', deger: fmt(sayi(takvim.finansal_borc)), alt: 'bugün gerçekte borçlu olunan', renk: R.kirmizi },
          { etiket: 'Toplam gelecek ödeme', deger: fmt(sayi(takvim.toplam_gelecek_odeme)), alt: 'faiz dahil cepten çıkacak', renk: R.amber },
          { etiket: 'En zor ay', deger: peak ? kisaAy(peak.ay) : '—', alt: peak ? `zorunlu yük ${fmt(sayi(peak.zorunlu_yuk))}` : '—', renk: R.kirmizi },
          { etiket: 'Açık veren ay', deger: `${acikAylar.length} / ${grid.length}`, alt: acikAylar.length ? 'ABEK yetmiyor' : 'hepsi karşılanıyor', renk: acikAylar.length ? R.amber : R.yesil },
        ]} />

        <YukEgrisi
          baslik={`Aylık zorunlu yük — gelecek ${grid.length} ay`}
          alt="kredi taksitleri + kart asgarisi · kredi tarafı kesin, kart yaklaşık"
          seri={grid.map(g => ({ deger: sayi(g.zorunlu_yuk) }))}
          esik={abekAylik}
          esikAd={`ABEK ${fmt(abekAylik)}`}
          notMetni={peak
            ? `En zor ay ${kisaAy(peak.ay)} — zorunlu yük ${fmt(sayi(peak.zorunlu_yuk))}. ${sayi(peak.acik) > 0
              ? `O ay ABEK'in ${fmt(sayi(peak.acik))} üstünde açık doğuyor.`
              : 'O ay bile ABEK yükü karşılıyor.'}`
            : null}
          etiketler={[0, Math.floor(grid.length / 4), Math.floor(grid.length / 2), Math.floor((grid.length * 3) / 4), grid.length - 1]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map(i => kisaAy(grid[i]?.ay))}
          rozetler={(takvim.kredi_biten_takvim || []).slice(0, 8).map(b =>
            typeof b === 'string' ? b : `${b.ad || b.kurum || 'Kredi'} · ${kisaAy(b.ay || b.bitis)}`)}
        />

        <Tablo
          baslik="Ay ay zorunlu yük"
          not="satıra tıkla → o ayın kırılımı"
          kolonlar={[
            { ad: 'Ay' }, { ad: 'Kredi taksiti', sag: true }, { ad: 'Kart asgarisi', sag: true },
            { ad: 'Zorunlu yük', sag: true }, { ad: 'ABEK', sag: true }, { ad: 'Açık', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={grid.slice(0, 36).map(g => ({
            id: g.ay, _g: g,
            hucreler: [
              { v: kisaAy(g.ay), kalin: true, mono: true },
              { v: fmt(sayi(g.kredi_taksit)), mono: true, sag: true },
              { v: fmt(sayi(g.kart_min)), mono: true, sag: true },
              { v: fmt(sayi(g.zorunlu_yuk)), mono: true, sag: true, kalin: true, renk: R.krem },
              { v: fmt(sayi(g.abek)), mono: true, sag: true, renk: R.yesil },
              { v: fmt(sayi(g.acik)), mono: true, sag: true, renk: sayi(g.acik) > 0 ? R.kirmizi : R.yesil },
              { v: sayi(g.acik) > 0 ? 'açık' : 'karşılanıyor', rozet: sayi(g.acik) > 0 ? R.kirmizi : R.yesil },
            ],
          }))}
          onSatir={(row) => {
            const g = row._g;
            onCekmece?.({
              tip: 'AY KIRILIMI',
              baslik: kisaAy(g.ay),
              alt: sayi(g.acik) > 0 ? `ABEK'in ${fmt(sayi(g.acik))} üstünde açık` : 'yük karşılanıyor',
              kpi: [
                { etiket: 'Zorunlu yük', deger: fmt(sayi(g.zorunlu_yuk)), renk: R.kirmizi },
                { etiket: 'ABEK', deger: fmt(sayi(g.abek)), renk: R.yesil },
              ],
              listeBaslik: 'Kırılım',
              satirlar: [
                { ad: 'Kredi taksitleri', detay: 'amortisman · kesin', tutar: fmt(sayi(g.kredi_taksit)) },
                { ad: 'Kart asgarisi', detay: 'yaklaşık', tutar: fmt(sayi(g.kart_min)) },
                { ad: 'Kalan kredi anaparası', detay: 'o ay sonunda', tutar: fmt(sayi(g.kredi_kalan_anapara)) },
                { ad: 'Açık', detay: 'zorunlu yük − ABEK', tutar: fmt(sayi(g.acik)) },
              ],
              not: takvim.not || 'Kredi tarafı kesin (amortisman), kart tarafı yaklaşık (asgari sabit varsayımı).',
              aksiyonAd: 'Nakit projeksiyonuna git',
              _hedef: '__gorunum:projeksiyon',
            });
          }}
        />
      </>
    );
  }

  // ── 3) Hedef Ciro & Ölçek ──────────────────────────────────────────────────
  if (gorunum === 'hedef') {
    const sen = olcek?.senaryolar || {};
    const par = olcek?.parametreler || {};
    const kap = olcek?.kapasite_gerceklik || {};
    const SIRA = [
      ['borc_sabit', 'Borç büyümesin', R.yesil],
      ['yil_25_azal', 'Borç yılda %25 azalsın', R.amber],
      ['ay24_bitir', 'Borç 24 ayda bitsin', R.kirmizi],
    ];
    const satir = SIRA.map(([k, ad, renk]) => ({ k, ad, renk, s: sen[k] })).filter(x => x.s);
    if (!satir.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>Ölçek planı hesaplanamıyor</div>
          <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6, maxWidth: 500, margin: '8px auto 0' }}>
            Nakit marj sıfır veya negatif olduğunda "ne kadar ciro gerekir" sorusunun matematiksel cevabı yok —
            önce marjın pozitife dönmesi gerekiyor.
          </div>
        </div>
      );
    }
    const mevcutCiro = sayi(par.mevcut_ciro);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Şu anki ciro', deger: fmt(mevcutCiro), alt: `aylık · ${sayi(par.mevcut_sube)} şube` },
          { etiket: 'Borç sabit kalsın', deger: sen.borc_sabit ? fmt(sen.borc_sabit.hedef_ciro) : '—', alt: sen.borc_sabit ? `${trSayi(sayi(sen.borc_sabit.carpan_mevcut), 2)}× · günlük ${fmt(sayi(sen.borc_sabit.hedef_ciro) / 30)}` : '—', renk: R.krem },
          { etiket: '24 ayda bitsin', deger: sen.ay24_bitir ? fmt(sen.ay24_bitir.hedef_ciro) : 'ulaşılamıyor', alt: sen.ay24_bitir ? `${trSayi(sayi(sen.ay24_bitir.carpan_mevcut), 2)}× · +${sayi(sen.ay24_bitir.yeni_sube)} şube` : 'mevcut yapıyla mümkün değil', renk: R.kirmizi },
          { etiket: 'Yapılandırma', deger: kap.yapilandirma_sart ? 'şart' : 'gerekmiyor', alt: kap.yapilandirma_sart ? 'mevcut kapasite yetmiyor' : 'kapasite yeterli', renk: kap.yapilandirma_sart ? R.kirmizi : R.yesil },
        ]} />

        <Tablo
          baslik={'Ölçek planı — "ne kadar" değil "hangi yapıyla"'}
          not="personel alt-doğrusal, kira basamaklı"
          kolonlar={[
            { ad: 'Hedef' }, { ad: 'Gereken ciro/ay', sag: true }, { ad: 'Çarpan', sag: true },
            { ad: 'Şube', sag: true }, { ad: 'Personel', sag: true },
            { ad: 'Üretilen ABEK', sag: true }, { ad: 'Sonuç' },
          ]}
          satirlar={satir.map(x => ({
            id: x.k, _x: x,
            hucreler: [
              { v: x.ad, kalin: true },
              { v: fmt(sayi(x.s.hedef_ciro)), mono: true, sag: true, kalin: true, renk: x.renk },
              { v: `${trSayi(sayi(x.s.carpan_mevcut), 2)}×`, mono: true, sag: true },
              { v: String(sayi(x.s.sube_sayisi)), mono: true, sag: true },
              { v: x.s.personel_sayisi != null ? `~${x.s.personel_sayisi}` : '—', mono: true, sag: true },
              { v: fmt(sayi(x.s.uretilen_abek)), mono: true, sag: true, renk: x.renk },
              {
                v: sayi(x.s.yeni_sube) > 0 ? `+${sayi(x.s.yeni_sube)} şube şart` : 'mevcut yapıyla',
                rozet: sayi(x.s.yeni_sube) > 0 ? R.amber : R.yesil,
              },
            ],
          }))}
          onSatir={(row) => {
            const x = row._x;
            onCekmece?.({
              tip: 'ÖLÇEK SENARYOSU',
              baslik: x.ad,
              alt: `gereken ciro ${fmt(sayi(x.s.hedef_ciro))} · ${trSayi(sayi(x.s.carpan_mevcut), 2)}×`,
              kpi: [
                { etiket: 'Hedef ciro', deger: fmt(sayi(x.s.hedef_ciro)), renk: x.renk },
                { etiket: 'Üretilen ABEK', deger: fmt(sayi(x.s.uretilen_abek)), renk: R.yesil },
                { etiket: 'Şube', deger: String(sayi(x.s.sube_sayisi)) },
                { etiket: 'Personel', deger: x.s.personel_sayisi != null ? `~${x.s.personel_sayisi}` : '—' },
              ],
              listeBaslik: 'Yapı gereksinimi',
              satirlar: [
                { ad: 'Yeni şube', detay: 'mevcuda ek', tutar: `${sayi(x.s.yeni_sube)} şube` },
                { ad: 'Şube başı ciro', detay: 'kapasite kontrolü', tutar: fmt(sayi(x.s.ciro_sube_basi)) },
                { ad: 'Personel maliyeti', detay: 'aylık', tutar: fmt(sayi(x.s.personel_maliyet)) },
                { ad: 'Mevcut ciro', detay: 'bugün', tutar: fmt(mevcutCiro) },
              ],
              not: kap.yapilandirma_sart
                ? `Mevcut ${sayi(par.mevcut_sube)} şube tam kapasitede bile ${fmt(sayi(kap.mevcut_sube_max_abek))} ABEK üretiyor; zorunlu yük ${fmt(sayi(kap.zorunlu_yuk))}. Yani ciro artışı tek başına yetmez — yapılandırma şart.`
                : 'Mevcut yapı bu hedefi taşıyabilir.',
              aksiyonAd: 'Nakit projeksiyonuna git',
              _hedef: '__gorunum:projeksiyon',
            });
          }}
        />
      </>
    );
  }

  // ── 5) Nakit Projeksiyonu (12 ay) — klasik köprü yerine yerli görünüm ──────
  if (gorunum === 'projeksiyon') {
    const seri = proj?.seri || [];
    if (!seri.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Projeksiyon hesaplanamadı — borç ve ABEK verisi biriktikçe 12 aylık gidişat burada çizilir.
        </div>
      );
    }
    const bas = sayi(proj?.varsayim?.baslangic_borc);
    const degerler = [bas, ...seri.map(s => sayi(s.toplam_borc))];
    const enB = Math.max(...degerler); const enK = Math.min(...degerler);
    const G = 640; const Y = 190; const solB = 10; const sagB = 10; const ustB = 16; const altB = 24;
    const n = degerler.length;
    const xk = (i) => solB + (i / Math.max(1, n - 1)) * (G - solB - sagB);
    const yk = (v) => ustB + (1 - (v - enK) / Math.max(1, enB - enK)) * (Y - ustB - altB);
    const cizgi = degerler.map((v, i) => `${xk(i)},${yk(v)}`).join(' ');
    const alan = `${xk(0)},${yk(enK)} ${cizgi} ${xk(n - 1)},${yk(enK)}`;
    const sarmal = !!proj.spiral;
    const renk = sarmal ? R.kirmizi : R.yesil;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugünkü borç', deger: fmt(bas), alt: 'başlangıç tabanı', renk: R.krem },
          { etiket: '12 ay sonu', deger: fmt(sayi(proj.ay_sonu_borc)), alt: `${sayi(proj.artis_pct) > 0 ? '+' : ''}${sayi(proj.artis_pct)}% değişim`, renk },
          { etiket: 'Aylık faiz', deger: fmt(sayi(proj.aylik_faiz_tl)), alt: `efektif %${sayi(proj.varsayim?.efektif_aylik_faiz_pct)}/ay`, renk: R.kirmizi },
          { etiket: 'ABEK (ödeme gücü)', deger: fmt(sayi(proj.varsayim?.abek_aylik)), alt: sarmal ? 'faizi karşılamıyor' : 'faizi karşılıyor', renk: sarmal ? R.kirmizi : R.yesil },
        ]} />

        {sarmal && (
          <div style={{
            ...kartYuzey, padding: '14px 18px', marginBottom: 14,
            border: `1px solid ${R.kirmizi}66`, background: `linear-gradient(165deg, rgba(248,113,113,.10), ${R.kartUst2 || R.girinti})`,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: R.kirmizi }}>🌀 Sarmal uyarısı</div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 6, lineHeight: 1.6 }}>
              Aylık ödeme kapasitesi (ABEK) faizi bile karşılamıyor — faize karşı açık{' '}
              <b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(sayi(proj.abek_aciligi_faize_karsi))}/ay</b>.
              {proj.ikiye_katlanma_ay
                ? <> Bu gidişatla borç <b>~{sayi(proj.ikiye_katlanma_ay)} ayda ikiye katlanır</b>.</>
                : ' Borç sürekli büyür.'}
            </div>
          </div>
        )}

        <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            paddingBottom: 11, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14, flexWrap: 'wrap', gap: 8,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>🔮 Borç eğrisi · 12 ay</span>
            <span style={{ fontSize: 11, color: R.not2 }}>
              her ay faiz geliyor, ABEK kadarı ödeniyor → fark borca ekleniyor
            </span>
          </div>
          <svg viewBox={`0 0 ${G} ${Y}`} style={{ width: '100%', display: 'block' }}>
            <line x1={solB} y1={yk(bas)} x2={G - sagB} y2={yk(bas)} stroke={R.cizgi3} strokeDasharray="4 4" />
            <text x={G - sagB} y={yk(bas) - 5} textAnchor="end" style={{ fontSize: 10, fill: R.not2 }}>bugün {fmt(bas)}</text>
            <polygon points={alan} fill={renk} opacity="0.13" />
            <polyline points={cizgi} fill="none" stroke={renk} strokeWidth="2.5" />
            {degerler.map((v, i) => (i % 2 === 0 ? (
              <g key={i}>
                <circle cx={xk(i)} cy={yk(v)} r="2.8" fill={renk} />
                <text x={xk(i)} y={Y - 7} textAnchor="middle" style={{ fontSize: 9, fill: R.not2 }}>
                  {i === 0 ? 'şimdi' : `${i}a`}
                </text>
              </g>
            ) : null))}
          </svg>
        </div>

        <div style={{
          ...kartYuzey, padding: '14px 18px', display: 'flex', gap: 20,
          flexWrap: 'wrap', fontSize: 12.5, color: R.metin2, marginBottom: 16,
        }}>
          <span>Borcun DURMASI için gereken aylık ödeme:{' '}
            <b style={{ fontFamily: F.mono, color: R.bakir }}>{fmt(sayi(proj.borc_sabit_icin_gereken_aylik_odeme))}</b>
          </span>
          <span style={{ color: R.not }}>
            Şu anki kapasite {fmt(sayi(proj.varsayim?.abek_aylik))} → aradaki fark her ay borca ekleniyor.
          </span>
        </div>
      </>
    );
  }

  // ── 4) Şube Katkısı ────────────────────────────────────────────────────────
  const subeler = katki?.subeler || [];
  if (!subeler.length) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
        Şube katkısı hesaplanamadı — ciro ve gider kaydı biriktikçe havuz etkisi burada görünür.
      </div>
    );
  }
  const besleyen = subeler.filter(s => sayi(s.ileri_aylik_katki) >= 0);
  const bosaltan = subeler.filter(s => sayi(s.ileri_aylik_katki) < 0);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Havuzu besleyen', deger: fmt(sayi(katki.havuz_besleyen_aylik)), alt: `${besleyen.length} şube · aylık`, renk: R.yesil },
        { etiket: 'Havuzu boşaltan', deger: fmt(sayi(katki.havuz_bosaltan_aylik)), alt: bosaltan.length ? `${bosaltan.length} şube` : 'yok', renk: bosaltan.length ? R.kirmizi : R.yesil },
        { etiket: 'Net havuz', deger: fmt(sayi(katki.net_havuz_aylik)), alt: 'aylık borç kapasitesi', renk: sayi(katki.net_havuz_aylik) > 0 ? R.krem : R.kirmizi },
        { etiket: 'Krediler', deger: 'kolektif', alt: 'şubeye paylaştırılmaz', renk: R.not },
      ]} />

      <KatkiCubugu
        baslik="Ortak havuzu kim besliyor, kim boşaltıyor?"
        alt="ileriye dönük aylık operasyonel nakit · finansman hariç"
        satirlar={subeler.map(s => ({
          ad: s.sube_adi || '—',
          deger: sayi(s.ileri_aylik_katki),
          metin: fmt(sayi(s.ileri_aylik_katki)),
          durum: s.durum === 'kapali' ? 'kapalı' : 'aktif',
          _s: s,
        }))}
        onSatir={(row) => {
          const s = row._s;
          onCekmece?.({
            tip: 'ŞUBE KATKISI',
            baslik: s.sube_adi || '—',
            alt: `${s.durum === 'kapali' ? 'kapalı' : 'aktif'} · ileriye dönük aylık etki`,
            kpi: [
              { etiket: 'Aylık katkı', deger: fmt(sayi(s.ileri_aylik_katki)), renk: sayi(s.ileri_aylik_katki) >= 0 ? R.yesil : R.kirmizi },
              { etiket: 'Kira', deger: fmt(sayi(s.kira_aylik)), renk: R.amber },
            ],
            listeBaslik: 'Dönem verisi',
            satirlar: [
              { ad: 'Dönem cirosu', detay: `son ${sayi(katki.gun)} gün`, tutar: fmt(sayi(s.ciro_donem)) },
              { ad: 'Operasyonel net', detay: 'gerçekleşen', tutar: fmt(sayi(s.operasyonel_net_aylik)) },
              { ad: 'Son ciro günü', detay: s.gun_since_ciro != null ? `${s.gun_since_ciro} gün önce` : 'bilinmiyor', tutar: s.son_ciro_gun || '—' },
            ],
            not: s.durum === 'kapali'
              ? 'Kapalı şube: gelir yok ama kira sürüyor — ileriye dönük etkisi saf drenaj.'
              : (katki.not || 'Katkı = operasyonel nakit (kira dahil, finansman hariç). Krediler kolektiftir, şubeye paylaştırılmaz.'),
            aksiyonAd: 'Nakit projeksiyonuna git',
            _hedef: '__gorunum:projeksiyon',
          });
        }}
      />
    </>
  );
}
