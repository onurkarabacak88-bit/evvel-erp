// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — GENEL BAKIŞ modülü (rayın EN ÜSTÜ, Panel'in üstünde)
//
// Sahip isteği (2026-07-31): "klasik CFO panelinde 13 bölüm / 20+ uç vardı,
// SADECE ORADAKİ KARTLARI görmek istiyorum."
// Bu modül klasik `Panel.jsx`'in (3336 satır) KART bölümlerini kadife dilinde
// taşır. Panel modülü ESKİ HÂLİNDE kaldı — buraya hiçbir şey iliştirilmedi.
//
// ⚠️ KARTLAR SALT-OKUR. Klasikteki form/aksiyon alanları (fiyat girişi, fatura
// PDF yükleme, toplu ödeme koşusu) BİLEREK taşınmadı: sahip "kartları görmek
// istiyorum" dedi; ayrıca o işlerin yerli karşılığı zaten Maliyet / Belge /
// Ödeme Merkezi modüllerinde duruyor (aynı işi iki yerde yapmak "tek eylem
// tek yer" kuralını çiğner).
//
// ⚠️ TRİAJ NEYE GÖRE: klasik panel ödemeleri UYARI SEVİYESİNE göre değil,
// GECİKME GÜNÜNE (`gun_farki`) göre ayırıyor — 15+ / 8-14 / 0-7 / bugün.
// İlk denememde seviyeye göre ayırmıştım, yanlıştı; kaynak okunarak düzeltildi.
//
// Uçlar: /panel · /uyarilar · /onay-kuyrugu · /kasa-kontrol ·
//        /sabit-giderler/odemeler · /sabit-giderler/odenenler · /vadeli-alimlar/ozet
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Liste, Tablo, BosDurum, HataBandi } from './parcalar';
import { kayitDosyasiYukle, belgeYukleyiciUret } from './kayitDosyasi';

const sayi = (v) => Number(v) || 0;
const kisalt = (t, n = 88) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const kisaGun = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}` : String(iso || '—');
};

/** Ödeme adını sadeleştirir — ekranda TEKNİK metin durmasın diye.
 *  Sunucu adı "Vadeli Alım: Fatura NAZ2026000000236 (DORUK AJANS MATBAACILIK)"
 *  gibi geliyor: sahip önce KİME ödeneceğini görmeli, fatura numarası detaydır.
 *  1) baştaki tekrarlı "Vadeli Alım: " önekleri soyulur (kayıtlarda 2 kez üst üste
 *     bindiği görüldü), 2) sondaki parantez içi FİRMA başlığa çıkar, kalan kısım
 *     (fatura no) alt satıra iner, 3) parantez yoksa soyulmuş ham metin kalır.
 *  Bilgi kaybı yok: ham metin ödeme çekmecesinin "Ödeme adı" satırında durur. */
/** Sunucu gün adını İngilizce gönderiyor ("Friday") — ekranda Türkçe durur. */
const GUN_TR = {
  Monday: 'Pazartesi', Tuesday: 'Salı', Wednesday: 'Çarşamba', Thursday: 'Perşembe',
  Friday: 'Cuma', Saturday: 'Cumartesi', Sunday: 'Pazar',
};
const gunTr = (g) => {
  const s = String(g || '').trim();
  return GUN_TR[s] || s || '—';
};

const HARF_RE = /[A-Za-zĞÜŞİÖÇÂÎÛğüşıiöçâîû]/g;
/** Parantez içi metin gerçekten FİRMA ADI mı? (canlı yanlış-pozitif filtresi)
 *  Kart/kredi/abone kayıtlarında da son parantez var ama içi firma değil:
 *  "(kesim 2026-07-20)" · "(21346598)" · "(01564752)" — bunlar başlığa çıkınca
 *  sahip kimin ödemesi olduğunu göremiyordu. İki kapı: kesim tarihi metni
 *  reddedilir; rakam/no ağırlıklı içerik (harf < uzunluğun yarısı) reddedilir. */
const firmaMi = (icerik) => {
  const s = String(icerik || '').trim();
  if (!s || /kesim/i.test(s)) return false;
  return (s.match(HARF_RE) || []).length >= s.length / 2;
};
const sadeOdemeAdi = (ham) => {
  const t = String(ham ?? '').trim().replace(/^(Vadeli Alım:\s*)+/i, '').trim();
  // SON parantez grubu — kuyruğa rağmen. Eskiden `\)\s*$` şartı vardı, bu yüzden
  // "… (ESHİM TEKNİK SERVİS) — sahip onayı…" gibi parantezden SONRA metin süren
  // kayıtlarda firma hiç yakalanmıyordu. `(?=[^()]*$)` = bundan sonra başka
  // parantez yok, yani bu sondaki grup.
  const m = t.match(/\(([^()]{3,})\)(?=[^()]*$)/);
  if (m) {
    const firma = m[1].trim();
    if (firmaMi(firma)) {
      const onces = t.slice(0, m.index).trim().replace(/[·\-–—,:;]+$/, '').trim();
      const kuyruk = t.slice(m.index + m[0].length).trim().replace(/^[·\-–—,:;]+/, '').trim();
      const ek = [onces, kuyruk].filter(Boolean).join(' · ');
      return { baslik: firma, ek: ek || null };
    }
  }
  return { baslik: t, ek: null };
};

/** Klasik panelin bölüm başlığı — kadife karşılığı. */
function Bolum({ baslik, not, renk, sayac, cocuk }) {
  return (
    <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12,
        paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, flexWrap: 'wrap',
      }}>
        {renk && <span style={{ width: 7, height: 7, borderRadius: 99, background: renk }} />}
        <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>{baslik}</span>
        {sayac != null && (
          <span style={{ fontFamily: F.mono, fontSize: 11.5, fontWeight: 700, color: renk || R.bakir }}>
            {sayac}
          </span>
        )}
        {not && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not2 }}>{not}</span>}
      </div>
      {cocuk}
    </div>
  );
}

/** Ad → değer satırı (klasikteki özet satırlarının karşılığı). */
function Satir({ ad, deger, renk, alt }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '8px 0', borderBottom: `1px solid ${R.cizgi2}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: R.metin2 }}>{ad}</div>
        {alt && <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{alt}</div>}
      </div>
      <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: renk || R.krem }}>
        {deger}
      </div>
    </div>
  );
}

export default function GenelModulu({ gorunum, onCekmece, onKopru }) {
  const [veri, setVeri] = useState(null);
  const [hata, setHata] = useState('');

  const yukle = () => {
    setHata('');
    Promise.all([
      api('/panel').catch(() => null),
      api('/uyarilar').catch(() => []),
      api('/onay-kuyrugu?durum=bekliyor&limit=400').catch(() => []),
      // 🟡 EVV-GENEL-N5 (2026-08-12): /kasa-kontrol çekiliyor ama HİÇ kullanılmıyordu
      // (KPI'lar p.kasa=/panel kullanır) → ölü-okuma kaldırıldı (boşa API çağrısı).
      api('/sabit-giderler/odenenler').catch(() => null),
      api('/vadeli-alimlar/ozet').catch(() => null),
      // NAKİT KONUM (2026-08-08): "param şu an nerede?" — şube kasası / yolda /
      // banka duraklarının toplamı ile kasa defteri bakiyesini karşılaştırır.
      api('/ops/metrics/nakit-konum?gun=60').catch(() => null),
    ]).then(([panel, uyarilar, onaylar, odenen, vadeli, nakit]) => {
      // 🔴 P1 (2026-08-12, Genel denetimi) FAKE-GREEN: /panel DÜŞSE de setHata VE setVeri
      // ikisi de çalışıyordu → `hata && !veri` (98) veri dolu olduğu için banner GÖSTERMEZ,
      // panel={} ile "0/boş/yeşil" dashboard render ediyordu (kasa 0 yeşil vb). Panel
      // yoksa veri KURMA → HataBandi görünsün (kısmi money-read hatası gizlenmesin).
      if (!panel) { setHata('Panel verisi alınamadı — "0/boş" görünüm yanıltıcı olur, yenileyin.'); return; }
      setVeri({ panel, uyarilar, onaylar, odenen, vadeli, nakit });
    }).catch((e) => setHata(e?.message || 'Veri alınamadı'));
  };
  useEffect(yukle, []);

  if (hata && !veri) return <HataBandi mesaj={hata} onTekrar={yukle} />;
  if (!veri) {
    return (
      <div style={{ ...kartYuzey, padding: '40px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>
        Genel bakış yükleniyor…
      </div>
    );
  }

  const p = veri.panel;
  // /vadeli-alimlar/ozet — {toplam_odenen, toplam_bekleyen, bekleyen_adet, geciken_adet}
  const v = veri.vadeli;
  const uyarilar = Array.isArray(veri.uyarilar) ? veri.uyarilar : (veri.uyarilar?.uyarilar || []);
  const onaylar = (Array.isArray(veri.onaylar) ? veri.onaylar : [])
    .filter((o) => !String(o.islem_turu || '').toUpperCase().includes('KASA'));
  // ⬆️ (2026-08-14) `oneriler` bildirim görünümünün içinde tanımlıydı; Karar
  // alanındaki "Bugün ilk 3 iş" bandı da okuyor → tek yere, yukarı alındı.
  const oneriler = Array.isArray(p.oneriler) ? p.oneriler : [];

  // ── TRİAJ: gecikme GÜNÜNE göre (klasik panelin kaynak kuralı) ──────────────
  const odemeler = Array.isArray(p.bugun_odemeler) ? p.bugun_odemeler : [];
  const gK = odemeler.filter((u) => sayi(u.gun_farki) <= -15);
  const gU = odemeler.filter((u) => sayi(u.gun_farki) >= -14 && sayi(u.gun_farki) <= -8);
  const gB = odemeler.filter((u) => sayi(u.gun_farki) >= -7 && sayi(u.gun_farki) < 0);
  // 🔴 EVV-GENEL-N3 (2026-08-12 satır-satır denetim): "Bugün vadesi" YALNIZ gun_farki===0.
  // gun_farki = vade − bugün → gelecek ödeme POZİTİF (motors 981/986 "N gün kaldı/sonra");
  // eskiden gBug = gun_farki>=0 gelecekteki vadeleri de "bugün" sayıp bugünkü yükü şişiriyordu.
  const gBug = odemeler.filter((u) => sayi(u.gun_farki) === 0);
  const gYak = odemeler.filter((u) => sayi(u.gun_farki) > 0);
  // 🐞 CANLI DENETİM (2026-08-03): toplam `asgari_kalan` ile, satırlar `tutar`
  // ile sayıyordu — değişken giderde (asgari_kalan yok) KPI "8 kalem" deyip
  // 7 kalemin toplamını gösteriyordu. Aynı erişimci → sayı ve toplam aynı evren.
  // 🔴 EVV-GENEL-N1: TEK erişimci — satır (139) ve çekmece (151) AYNI fallback zincirini
  // kullansın (eskiden çekmece `?? asgari`'yi atlıyordu → satırda para, çekmecede 0).
  const odemeTutar = (u) => sayi(u.tutar ?? u.asgari_kalan ?? u.asgari);
  const gecikmisTutar = odemeTutar;
  const gecikmisToplam = odemeler
    .filter((u) => sayi(u.gun_farki) < 0)
    .reduce((s, u) => s + gecikmisTutar(u), 0);

  // 🔵 (2026-08-14): satır başlığı ham sunucu metniydi ("Vadeli Alım: Fatura
  // NAZ2026… (DORUK AJANS MATBAACIL…") → 60 karakterde kesilince FİRMA ADI hiç
  // görünmüyordu. Artık firma başlıkta, fatura no alt satırda.
  const odemeSatiri = (u, i) => {
    const sadeAd = sadeOdemeAdi(u.ad || u.aciklama || u.tedarikci || 'Ödeme');
    return {
      id: u.id || `o-${i}`, _u: u,
      baslik: kisalt(sadeAd.baslik || 'Ödeme', 60),
      alt: [
        u.tip ? String(u.tip) : null,
        sadeAd.ek ? kisalt(sadeAd.ek, 46) : null,
        // 🔴 EVV-GENEL-N3: 3-yönlü — geçmiş (gecikti) · bugün · gelecek (N gün sonra).
        sayi(u.gun_farki) < 0 ? `${Math.abs(sayi(u.gun_farki))} gün gecikti`
          : sayi(u.gun_farki) === 0 ? 'bugün vadesi' : `${sayi(u.gun_farki)} gün sonra`,
      ].filter(Boolean).join(' · '),
      tutar: fmt(odemeTutar(u)),
      tier: sayi(u.gun_farki) <= -15 ? 'kritik' : sayi(u.gun_farki) <= -8 ? 'uyari' : sayi(u.gun_farki) < 0 ? 'bilgi' : 'iyi',
    };
  };

  /** Ödeme satırının BENZERSİZ kimliği (görüntü metni değil, kayıt kimliği).
   *  ⚠️ Sunucu bu satırlarda `id` GÖNDERMİYOR — alan adı `odeme_id` (motors.py:1259).
   *  Değişken gider satırlarında ise `odeme_id` bilerek NULL (motors.py:1388); orada
   *  kimlik kaynak_tablo+kaynak_id ikilisinde. Bu yüzden zincir: odeme_id → bileşik.
   *  Bileşik anahtar aynı render'daki iki farklı kaydı ayırmaya yeter (kaynak_id
   *  gider başına tekil; vade ve tutar da ayırıcı). */
  const kayitAnahtari = (u) => String(
    u.odeme_id
    || u.id
    || [u.kaynak_tablo || '?', u.kaynak_id || '?', u.kart_id || '?',
        u.tarih || '?', sayi(u.tutar)].join('|'),
  );

  /** Çekmece gövdesi — `ek` ile iz/belgeler sonradan eklenebilsin diye fonksiyon.
   *  tip + baslik SABİT kalır: Cekmece sekme sıfırlaması [acik,tip,baslik]'e bağlı
   *  (parcalar.jsx:1319) → aynı değerlerle yeniden çağırınca sahip hangi sekmedeyse
   *  orada kalır, veri altına dolar. */
  const odemeCekmeceVeri = (_u, ek = {}) => ({
    tip: 'ÖDEME KAYDI',
    // Geç gelen iz/belge yanıtının hangi kayda ait olduğunu ayırt eden KİMLİK.
    // Başlık kimlik DEĞİLDİR: 60 karakterde kesilmiş görüntü metni, aynı bankanın
    // iki kartı gibi vakalarda birebir aynı çıkabilir → A'nın yanıtı B'ye basardı.
    // (TasarimV2 çekmece alanlarını tek tek okuyor, spread yok → bu alan ekrana
    // sızmaz; `_hedef` de aynı desende taşınıyor.)
    _kayitId: kayitAnahtari(_u),
    baslik: kisalt(sadeOdemeAdi(_u.ad || _u.aciklama || 'Ödeme').baslik || 'Ödeme', 60),
    alt: sayi(_u.gun_farki) < 0 ? `${Math.abs(sayi(_u.gun_farki))} gün gecikti`
      : sayi(_u.gun_farki) === 0 ? 'bugün vadesi' : `${sayi(_u.gun_farki)} gün sonra`,
    // Sahip düzeltmesi (2026-08-03): boş alanı GİZLEMEK yerine DOLDUR.
    // Satırda `tip`/`ad` yok ama kaynak_tablo + tarih + seviye VAR — tür
    // kaynaktan türetilir, vade tarihi ve seviye de çekmeceye girer.
    kpi: [
      { etiket: 'Tutar', deger: fmt(odemeTutar(_u)), renk: R.kirmizi },
      { etiket: 'Gecikme', deger: sayi(_u.gun_farki) < 0 ? `${Math.abs(sayi(_u.gun_farki))} gün` : 'yok', renk: sayi(_u.gun_farki) < 0 ? R.kirmizi : R.yesil },
      {
        etiket: 'Tür',
        deger: _u.tip ? String(_u.tip)
          : ({ vadeli_alimlar: 'Vadeli alım', sabit_giderler: 'Sabit gider', kartlar: 'Kart ekstresi',
               borc_envanteri: 'Kredi taksiti', cari_odeme: 'Cari ödeme', degisken: 'Değişken gider' }[_u.kaynak_tablo]
             || (_u.kart_id ? 'Kart ekstresi' : 'Ödeme planı')),
      },
      ...(_u.seviye ? [{
        etiket: 'Seviye', deger: String(_u.seviye),
        renk: String(_u.seviye).toUpperCase() === 'KRITIK' ? R.kirmizi : R.amber,
      }] : []),
    ],
    listeBaslik: 'Kayıt',
    satirlar: [
      // 🔴 TAŞMA DÜZELTMESİ (2026-08-14, canlı ölçüm: içerik 448px panelde 569px):
      // ham ad `tutar` alanına basılıyordu, o alan mono + nowrap → 70 karakter tek
      // satırda 525px sürüyordu. Ham ad artık `detay`da: 11px, sarabilen alan.
      // Bilgi kaybı yok — tam hâliyle duruyor, sadece doğru sütunda.
      {
        ad: 'Kaydın tam adı',
        detay: kisalt(_u.ad || _u.aciklama || '—', 110),
        tutar: '',
      },
      ...(_u.kaynak_tablo ? [{ ad: 'Kaynak', detay: 'kaydı üreten defter', tutar: String(_u.kaynak_tablo) }] : []),
      ...(_u.tarih ? [{ ad: 'Vade tarihi', detay: 'planlanan ödeme günü', tutar: String(_u.tarih).slice(0, 10) }] : []),
      { ad: 'Asgari kalan', detay: 'ödenmesi gereken', tutar: fmt(sayi(_u.asgari_kalan ?? _u.asgari ?? _u.tutar)) },
    ],
    not: '🔒 Salt-okunur — ödeme Ödeme Merkezi\'nden yapılır.',
    aksiyonAd: 'Ödeme Merkezi\'nde aç',
    _hedef: '__modul:odeme:bekleyen',
    ...ek,
  });

  /** 💳 KAYIT ZENGİNLEŞTİRME (sahip 2026-08-14: "o karta yapılmış ödemeler
   *  görünebilir", "bu ayın ekstresi direkt görülebilir"). Çekmecenin İz ve
   *  Belgeler sekmeleri tasarımda vardı ama veri geçilmiyordu → hep boş açılıyordu.
   *  Çekmece ÖNCE açılır (bekleme yok), veri arkadan gelir.
   *  Bu kaydın kaynak ikilisi — kart planlarında kimlik kart_id'dir.
   *  İz/belge çekme ve merge mantığı ./kayitDosyasi'nda (tek yer, 4 modül ortak). */
  const kayitBagi = (_u) => {
    const tablo = _u.kaynak_tablo || (_u.kart_id ? 'kartlar' : null);
    const kid = (tablo === 'kartlar') ? (_u.kart_id || _u.kaynak_id) : _u.kaynak_id;
    return {
      onCekmece, tip: 'ÖDEME KAYDI',
      kaynakTablo: tablo, kaynakId: kid,
      kayitId: kayitAnahtari(_u), renkler: { kirmizi: R.kirmizi },
    };
  };

  const odemeCekmece = ({ _u }) => {
    const bag = kayitBagi(_u);
    onCekmece?.(odemeCekmeceVeri(_u, { belgeYukle: belgeYukleyiciUret(bag) }));
    kayitDosyasiYukle(bag);
  };

  // ════════════════════════ GÖRÜNÜM: KARAR ALANI ════════════════════════════
  if (gorunum === 'karar') {
    // 🔵 (2026-08-14) İKİ DÜZELTME:
    //  · Başlıkta yalnız ADET vardı → "3 kalem" ne kadar para bilinmiyordu; sayacın
    //    yanına katmanın TUTAR TOPLAMI kondu (kaç kalem değil, ne kadar para).
    //  · "satıra tıkla" notu 5 bölümde 5 kez tekrar ediyordu → yalnız ilkinde.
    // Sıralama: kova içinde TUTAR büyükten küçüğe (gecikme günü zaten satırda yazılı,
    // aynı kovadaki kalemler zaten aynı gecikme aralığında → ayıran şey paradır).
    const bolum = (baslik, kayitlar, renk, notGoster = false) => {
      const toplam = kayitlar.reduce((s, u) => s + odemeTutar(u), 0);
      const sirali = [...kayitlar].sort((a, b) => odemeTutar(b) - odemeTutar(a));
      return (
        <Bolum
          baslik={baslik}
          renk={renk}
          sayac={`${kayitlar.length} kalem · ${fmt(toplam)}`}
          not={notGoster ? 'satıra tıkla → ödeme dosyası' : null}
          cocuk={kayitlar.length === 0
            ? <div style={{ fontSize: 12, color: R.not2 }}>Bu katmanda kayıt yok.</div>
            : <Liste satirlar={sirali.map(odemeSatiri)} onAc={odemeCekmece} />}
        />
      );
    };

    // "48 saatlik yük": bugün (0) + yarın (1) vadesi olan kalemlerin toplamı.
    // Bugün kasadan çıkacak parayı planlarken yarını da görmek gerekir.
    const gYarin = odemeler.filter((u) => sayi(u.gun_farki) === 0 || sayi(u.gun_farki) === 1);
    const t48 = gYarin.reduce((s, u) => s + odemeTutar(u), 0);
    const gBugToplam = gBug.reduce((s, u) => s + odemeTutar(u), 0);
    // Ödeme baskısı hiç yoksa 4 boş katman yerine tek net cümle gösterilir.
    const baskiYok = (gK.length + gU.length + gB.length + gBug.length) === 0;

    // ── ☀️ BUGÜN İLK 3 İŞ ────────────────────────────────────────────────────
    // Sahip ekranı açtığında "önce neye bakayım?" sorusunun cevabı. Uydurma yok:
    // üç madde de aynı veriden türer; madde üretecek veri yoksa bant hiç çizilmez.
    const ilkUcIs = (() => {
      const isler = [];
      const gecikmisSirali = odemeler
        .filter((u) => sayi(u.gun_farki) < 0)
        .sort((a, b) => odemeTutar(b) - odemeTutar(a));
      const enBuyuk = gecikmisSirali[0];
      if (enBuyuk) {
        const ad = sadeOdemeAdi(enBuyuk.ad || enBuyuk.aciklama || 'Ödeme');
        isler.push({
          k: 'gecikmis', ikon: '🔴', renk: R.kirmizi,
          metin: `${kisalt(ad.baslik, 38)} — ${fmt(odemeTutar(enBuyuk))}`,
          alt: `${Math.abs(sayi(enBuyuk.gun_farki))} gün gecikti · en büyük gecikmiş kalem`,
          onTikla: () => odemeCekmece({ _u: enBuyuk }),
        });
      }
      if (t48 > 0) {
        isler.push({
          k: 'yuk48', ikon: '📅', renk: R.amber,
          metin: `Bugün/yarın çıkacak: ${fmt(t48)}`,
          alt: `${gYarin.length} kalem · 48 saatlik nakit yükü`,
        });
      } else if (gYak.length) {
        const enYakin = [...gYak].sort((a, b) => sayi(a.gun_farki) - sayi(b.gun_farki))[0];
        const ad2 = sadeOdemeAdi(enYakin.ad || enYakin.aciklama || 'Ödeme');
        isler.push({
          k: 'yuk48', ikon: '📅', renk: R.mavi,
          metin: `En yakın vade: ${kisalt(ad2.baslik, 32)} — ${fmt(odemeTutar(enYakin))}`,
          alt: `${sayi(enYakin.gun_farki)} gün sonra · bugün/yarın ödeme yok`,
          onTikla: () => odemeCekmece({ _u: enYakin }),
        });
      }
      if (onaylar.length > 0) {
        isler.push({
          k: 'onay', ikon: '🔔', renk: R.amber,
          metin: `${onaylar.length} onay bekliyor`,
          alt: 'karar verilmedikçe kayıt işlenmez → Onay Kuyruğu',
          onTikla: () => onKopru?.('__modul:onaylar:kuyruk'),
        });
      } else if (oneriler.length > 0) {
        isler.push({
          k: 'oneri', ikon: '🧠', renk: R.bakir,
          metin: `Karar motorunda ${oneriler.length} öneri`,
          alt: 'öneri-only · hüküm insanın → Motor & Bildirimler',
          onTikla: () => onKopru?.('__gorunum:bildirim'),
        });
      }
      return isler;
    })();

    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kasa', deger: fmt(sayi(p.kasa)), alt: 'kanonik bakiye', renk: sayi(p.kasa) >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'Gecikmiş toplam', deger: fmt(gecikmisToplam), alt: `${gK.length + gU.length + gB.length} kalem`, renk: gecikmisToplam > 0 ? R.kirmizi : R.yesil },
          {
            // 🔵 (2026-08-14): "Bugün vadesi" ADET sayıyordu ("3") — yanındaki tüm
            // KPI'lar para gösterirken bu tek başına sayıydı, üstelik "3 kalem" bugün
            // kasadan ne çıkacağını söylemiyordu. Değer = TUTAR, adet alta indi.
            etiket: 'Bugün vadesi',
            deger: fmt(gBugToplam),
            alt: `${gBug.length} kalem · 48 saat ${fmt(t48)}`,
            renk: gBugToplam > 0 ? R.amber : t48 > 0 ? R.mavi : R.yesil,
          },
          { etiket: 'Kaç gün dayanır', deger: p.kac_gun_dayanir != null ? `${sayi(p.kac_gun_dayanir)} gün` : '—', alt: 'kasa / günlük yük', renk: p.kac_gun_dayanir == null ? R.not3 : sayi(p.kac_gun_dayanir) < 15 ? R.kirmizi : R.krem },
          {
            // ⚠️ /vadeli-alimlar/ozet ÇEKİLİYOR ama hiçbir yerde OKUNMUYORDU
            // (satır 87'de state'e konup unutulmuş — ölü veri). Klasik Panel
            // geciken_adet'i kırmızı rozet olarak kullanıyordu.
            etiket: 'Vadeli alım',
            deger: v ? String(sayi(v.bekleyen_adet)) : '—',
            // Etiket "gecikmiş" üstteki plan-gecikmişiyle karışıyordu — bu sayı
            // YALNIZ vadeli alım sözlerini sayar, ayrı evren olduğu yazılır.
            alt: v
              ? (sayi(v.geciken_adet)
                ? `⚠ ${sayi(v.geciken_adet)} sözün vadesi geçti · bekleyen ${fmt(sayi(v.toplam_bekleyen))}`
                : `bekleyen ${fmt(sayi(v.toplam_bekleyen))} · bu ay ödenen ${fmt(sayi(v.toplam_odenen))}`)
              : 'veri yok',
            renk: sayi(v?.geciken_adet) ? R.kirmizi : sayi(v?.bekleyen_adet) ? R.amber : R.yesil,
          },
        ]} />

        {/* ☀️ Günün ilk üç işi — KPI şeridinin hemen altında, tek bakışta sıra */}
        {ilkUcIs.length > 0 && (
          <div style={{ ...kartYuzey, padding: '14px 18px', marginBottom: 14, borderLeft: `3px solid ${R.bakir}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>☀️ Bugün ilk 3 iş</span>
              <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>önem sırasına dizili</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ilkUcIs.map((is, i) => (
                <div
                  key={is.k}
                  onClick={is.onTikla}
                  tabIndex={is.onTikla ? 0 : undefined}
                  role={is.onTikla ? 'button' : undefined}
                  onKeyDown={is.onTikla ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); is.onTikla(); }
                  } : undefined}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px',
                    borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi2}`,
                    cursor: is.onTikla ? 'pointer' : 'default',
                  }}
                >
                  <span style={{ fontFamily: F.mono, fontSize: 11.5, fontWeight: 700, color: R.not2, width: 14, flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ fontSize: 13, flexShrink: 0 }}>{is.ikon}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: is.renk }}>{is.metin}</div>
                    <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{is.alt}</div>
                  </div>
                  {is.onTikla && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3, whiteSpace: 'nowrap' }}>dokun →</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Klasik panelin 4 katmanlı triajı — gecikme GÜNÜNE göre.
            🟢 (2026-08-14) TEMİZ GÜN: dört katman da boşken üst üste 4 "kayıt yok"
            kutusu çiziliyordu — sahip 4 boş kutuyu tarayıp "sorun yok mu?" diye
            düşünüyordu. Baskı yoksa tek cümle söylenir. */}
        {baskiYok ? (
          <div style={{
            ...kartYuzey, padding: '16px 20px', marginBottom: 14,
            borderLeft: `3px solid ${R.yesil}`, fontSize: 13, lineHeight: 1.6, color: R.metin2,
          }}>
            <b style={{ color: R.yesil }}>✓ Bugün ödeme baskısı yok</b> — gecikmiş, bugün vadesi ve
            7 gün içi kalem bulunmuyor.
          </div>
        ) : (
          <>
            {bolum('KRİTİK · 15+ gün gecikmiş', gK, R.kirmizi, true)}
            {bolum('UYARI · 8–14 gün', gU, R.amber)}
            {bolum('BİLGİ · 0–7 gün', gB, R.mavi)}
            {bolum('BUGÜN vadesi gelen', gBug, R.bakir)}
          </>
        )}
        {/* 🔴 EVV-GENEL-N3: gelecek (gun_farki>0) vadeler artık "bugün"e karışmıyor,
            ayrı YAKLAŞAN kovasında görünür. Temiz günde de listelenir. */}
        {gYak.length > 0 && bolum('YAKLAŞAN · gelecek günler', gYak, R.krem, baskiYok)}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: PARA AKIŞI ═════════════════════════════
  if (gorunum === 'akis') {
    const giris = sayi(p.bu_ay_nakit_giris);
    const cikis = sayi(p.bu_ay_nakit_cikis);
    const net = p.bu_ay_net != null ? sayi(p.bu_ay_net) : giris - cikis;
    // ── NAKİT KONUM: "param şu an nerede?" ───────────────────────────────────
    // Kasa bakiyesi tek sayıdır ama para tek yerde durmaz: şube kasasında,
    // yolda (teslim alınmış/bankaya girmemiş) ve bankada bekler. Durakların
    // toplamı ile defter bakiyesi arasındaki fark = mutabakatsız nakit.
    const nk = veri.nakit;
    // 🔴 EVV-GENEL-N2 (2026-08-12 satır-satır denetim) FAKE-GREEN: /nakit-konum okuması
    // DÜŞERSE (nk===null) kart sessizce kayboluyordu → mutabakat tam sorun anında görünmez.
    // Okuma-hatasını (null) veri-yokluğundan (duraklar absent) ayır: null → açık uyarı.
    const nakitHataBlok = nk === null ? (
      <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14, borderLeft: `3px solid ${R.kirmizi}`, fontSize: 12.5, color: R.metin2 }}>
        ⚠ Nakit konum verisi gelmedi — "param nerede?" mutabakatı gizlenmiş olabilir. Yenileyin.
      </div>
    ) : null;
    const nakitBlok = nk?.duraklar ? (() => {
      const du = nk.duraklar;
      const sag = nk.saglik || {};
      const mut = sayi(nk.mutabakatsiz_tl);
      const renk = sag.durum === 'yesil' ? R.yesil : sag.durum === 'sari' ? R.amber : R.kirmizi;
      const duraklar = [
        ['Şube kasalarında', sayi(du.sube_kasalarinda_tl), R.krem, 'son kapanış sayımı'],
        ['Yolda', sayi(du.yolda_tl), renk, 'teslim alınmış · bankaya girmemiş'],
        ['Bankada', sayi(du.bankada_tl), R.mavi, 'yatırım kayıtları'],
      ];
      const enBuyuk = Math.max(1, ...duraklar.map(([, v]) => Math.abs(v)));
      return (
        <div
          onClick={() => onCekmece?.({
            tip: 'NAKİT KONUM',
            baslik: 'Param şu an nerede?',
            alt: `son ${sayi(nk.pencere_gun)} gün · kayıt üretmez, konumu hesaplar`,
            kpi: [
              { etiket: 'Durakların toplamı', deger: fmt(sayi(du.duraklar_toplami_tl)), renk: R.bakirAcik },
              { etiket: 'Kasa defteri', deger: fmt(sayi(nk.defter_bakiyesi_tl)) },
              { etiket: 'Mutabakatsız', deger: fmt(mut), renk: Math.abs(mut) > 1 ? R.kirmizi : R.yesil },
            ],
            listeBaslik: 'Duraklar ve akış',
            satirlar: [
              ...duraklar.map(([ad, v, , alt]) => ({ ad, detay: alt, tutar: fmt(v) })),
              { ad: '= Durakların toplamı', detay: 'konumu doğrulanmış nakit', tutar: fmt(sayi(du.duraklar_toplami_tl)) },
              { ad: 'Kasa defteri bakiyesi', detay: 'kanonik kayıt', tutar: fmt(sayi(nk.defter_bakiyesi_tl)) },
              { ad: '⚠ Mutabakatsız', detay: 'hangi durakta olduğu bilinmeyen', tutar: fmt(mut) },
              { ad: 'Teslim alınan (toplam)', detay: `${sayi(nk.akis?.teslim_adet)} işlem`, tutar: fmt(sayi(nk.akis?.teslim_alinan_tum_tl)) },
              { ad: 'Bankaya yatan (toplam)', detay: `${sayi(nk.akis?.banka_adet)} işlem`, tutar: fmt(sayi(nk.akis?.bankaya_yatan_tum_tl)) },
              ...(nk.sube_kasalari || []).map((s) => ({
                ad: `${s.sube_adi} kasası`, detay: `son kapanış ${s.son_kapanis}`, tutar: fmt(sayi(s.kasada_tl)),
              })),
            ],
            not: `${sag.esik || ''} · ${nk.not || ''}`,
          })}
          style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, cursor: 'pointer', borderLeft: `3px solid ${renk}` }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 11 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>💵 Param şu an nerede?</span>
            {sag.yolda_haftalik_ciro_pct != null && (
              <span style={{ fontSize: 11.5, color: renk, fontWeight: 700 }}>
                {/* ⚠️ trSayi bu dosyada TANIMLI DEĞİL (bugün 8. helper tuzağı) —
                    Math.round ile yazıldı. Kural: helper kullanmadan önce O DOSYADA grep. */}
                yoldaki nakit = haftalık cironun %{Math.round(sayi(sag.yolda_haftalik_ciro_pct))}'i
              </span>
            )}
            <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>dokun → tam döküm</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {duraklar.map(([ad, v, c, alt]) => (
              <div key={ad} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ fontSize: 12, width: 132, flexShrink: 0, color: R.metin2 }}>{ad}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 99, background: R.girinti, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, (Math.abs(v) / enBuyuk) * 100)}%`, height: '100%', background: c, opacity: 0.75 }} />
                </div>
                <span style={{ fontSize: 12.5, fontFamily: F.mono, width: 104, textAlign: 'right', color: c }}>{fmt(v)}</span>
                <span style={{ fontSize: 10.5, color: R.not3, width: 168 }}>{alt}</span>
              </div>
            ))}
          </div>
          {Math.abs(mut) > 1 && (
            <div style={{
              marginTop: 11, padding: '9px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.55,
              background: 'rgba(248,113,113,.08)', border: `1px solid ${R.kirmizi}33`, color: R.metin2,
            }}>
              ⚠ Kasa defteri <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(nk.defter_bakiyesi_tl))}</b> diyor,
              durakların toplamı <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(du.duraklar_toplami_tl))}</b> —
              aradaki <b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(mut)}</b> hangi durakta olduğu
              doğrulanmamış nakit. Şube kasası rakamları son kapanış sayımından gelir; sayım eskiyse fark büyür.
            </div>
          )}
        </div>
      );
    })() : null;
    // 🔵 (2026-08-14) BLOK SIRASI DEĞİŞTİ (yalnız yerleşim — veri/mantık aynı):
    // sabah ilk sorulan soru operasyoneldir. Sıra artık
    //   1) param nerede → 2) ödeme baskısı → 3) aylık KPI → 4) tahsilat kanalları
    //   → 5) kasa özeti → 6) bu ay ödenen sabit giderler.
    // Eskiden aylık özet (geçmişe bakan rakamlar) 2. sıradaydı, "bu ay neyi
    // ödemem gerek" ise en alttaydı → sahip her sabah aşağı kaydırıyordu.
    return (
      <>
        {nakitHataBlok}
        {nakitBlok}

        <Bolum baslik="⚡ Ödeme baskısı" not="finansman yükü" cocuk={
          <>
            <Satir ad="Bekleyen borç taksiti" deger={fmt(sayi(p.borc_taksit_bekleyen))} alt={sayi(p.borc_taksit_bekleyen_adet) ? `${sayi(p.borc_taksit_bekleyen_adet)} taksit` : null} renk={sayi(p.borc_taksit_bekleyen) ? R.kirmizi : R.krem} />
            <Satir ad="Ödenen borç taksiti" deger={fmt(sayi(p.borc_taksit_odenen))} renk={R.yesil} />
            <Satir ad="Bu ay kart faizi" deger={fmt(sayi(p.bu_ay_kart_faizi))} renk={sayi(p.bu_ay_kart_faizi) ? R.kirmizi : R.krem} />
            <Satir ad="Finansman maliyeti" deger={fmt(sayi(p.bu_ay_finansman_maliyeti))} renk={sayi(p.bu_ay_finansman_maliyeti) ? R.kirmizi : R.krem} />
            <Satir ad="Bekleyen gider sayısı" deger={String(sayi(p.bekleyen_gider_sayisi))} renk={R.metin2} />
          </>
        } />

        <KpiSeridi kpiler={[
          { /* PROD-V2-CIRO-001 FIX: BRÜT bu_ay_ciro (ciro tablosu) — "Bu ay ciro" etiketi brüt olmalı;
               önce NET bu_ay_sadece_ciro tercih ediliyordu, aşağıdaki tahsilat kanalları brütken tutarsızdı. */
            etiket: 'Bu ay ciro', deger: fmt(sayi(p.bu_ay_ciro ?? p.bu_ay_sadece_ciro)), alt: 'sadece ciro', renk: R.krem },
          { etiket: 'Nakit giriş', deger: giris ? fmt(giris) : '—', alt: 'bu ay', renk: giris ? R.yesil : R.not },
          { etiket: 'Nakit çıkış', deger: cikis ? fmt(cikis) : '—', alt: 'bu ay', renk: cikis ? R.kirmizi : R.not },
          { etiket: 'Net akış', deger: net ? fmt(net) : '—', alt: net >= 0 ? 'pozitif' : 'negatif', renk: net >= 0 ? R.yesil : R.kirmizi },
        ]} />

        {/* 🔵 (2026-08-12): başlık "para akışı" idi ama satırlar TAHSİLAT KANALLARI (ciro
            kırılımı: nakit/pos/online/dış/devir) — üstteki nakit-akışı KPI'ıyla (giriş/çıkış/
            net) karıştırılmasın diye başlık nota (tahsilat) hizalandı. Farklı metrikler. */}
        <Bolum baslik="💼 Bu ayın tahsilat kanalları" not="ciro kırılımı — üstteki nakit-akışı KPI'sından farklı" cocuk={
          <>
            <Satir ad="Nakit" deger={fmt(sayi(p.bu_ay_nakit))} />
            <Satir ad="POS / kart" deger={fmt(sayi(p.bu_ay_pos))} alt={sayi(p.bu_ay_pos_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_pos_kesinti))}` : null} />
            <Satir ad="Online" deger={fmt(sayi(p.bu_ay_online))} alt={sayi(p.bu_ay_online_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_online_kesinti))}` : null} />
            <Satir ad="Dış kaynak geliri" deger={fmt(sayi(p.bu_ay_dis_kaynak))} renk={R.metin2} />
            {/* Devir geçmiş aydan taşınan bakiyedir — bu ayın tahsilatı sanılıp
                kanal toplamlarına eklenmesin diye açıkça yazılır. */}
            <Satir ad="Devir" deger={fmt(sayi(p.bu_ay_devir))} renk={R.metin2} alt="geçmiş aydan devreden — bu ayın tahsilatı değil" />
          </>
        } />

        <Bolum baslik="🔍 Kasa özeti" not="anlık dağılım" cocuk={
          <>
            {/* Alt yazı kod adıydı ("motors.guncel_kasa") — ekranda dosya/fonksiyon
                adı durmaz; sahibin dilinde nereden geldiği yazılır. */}
            <Satir ad="Kanonik kasa" deger={fmt(sayi(p.kasa))} renk={R.yesil} alt="kasa izi defteri · kanonik" />
            <Satir ad="Anlık nakit" deger={fmt(sayi(p.anlik_nakit))} />
            <Satir ad="Anlık kart" deger={fmt(sayi(p.anlik_kart))} />
            <Satir ad="Genel nakit toplamı" deger={fmt(sayi(p.genel_nakit_toplam))} renk={R.metin2} />
            <Satir ad="Genel kart toplamı" deger={fmt(sayi(p.genel_kart_toplam))} renk={R.metin2} />
          </>
        } />

        <Bolum baslik="✅ Bu ay ödenen sabit giderler" not="salt-okur" cocuk={
          (() => {
            const liste = Array.isArray(veri.odenen) ? veri.odenen : (veri.odenen?.odemeler || veri.odenen?.satirlar || []);
            // 🔴 (2026-08-14) CANLIDA HEP 0 ₺: tablo `o.tutar` okuyordu ama uç bu adı
            // HİÇ göndermiyor — alanlar {aciklama, gider_adi, odenen_tutar,
            // odenecek_tutar, odeme_tarihi, plan_tarihi, kategori}. Ad da `o.ad`
            // aranıyordu, o da yok → her satır "— · 0 ₺" idi.
            // Ayrıca uç TÜM AYLARI ve tutarı 0/eksi olan "LİMİT YETERSİZ" plan
            // kayıtlarını da döndürüyor; başlık "Bu ay ÖDENEN" diyor → içinde
            // bulunulan ay + gerçekten ödenmiş (odenen_tutar>0) kayıtlar süzülür.
            const simdi = new Date();
            const buAy = `${simdi.getFullYear()}-${String(simdi.getMonth() + 1).padStart(2, '0')}`;
            const buAyLis = liste.filter((o) => (
              String(o.odeme_tarihi || '').slice(0, 7) === buAy && sayi(o.odenen_tutar) > 0
            ));
            if (!buAyLis.length) return <div style={{ fontSize: 12, color: R.not2 }}>Bu ay ödenmiş sabit gider kaydı yok.</div>;
            return (
              <Tablo
                baslik=""
                not={buAyLis.length > 15 ? `ilk 15 / ${buAyLis.length} kayıt` : null}
                kolonlar={[{ ad: 'Gider' }, { ad: 'Tarih' }, { ad: 'Tutar', sag: true }]}
                satirlar={buAyLis.slice(0, 15).map((o, i) => ({
                  id: o.id || `sg-${i}`,
                  hucreler: [
                    { v: kisalt(o.aciklama || o.gider_adi || o.ad || '—', 44), kalin: true },
                    { v: kisaGun(o.odeme_tarihi || o.plan_tarihi || o.tarih), mono: true, renk: R.not },
                    { v: fmt(sayi(o.odenen_tutar ?? o.odenecek_tutar ?? o.tutar)), mono: true, sag: true, kalin: true, renk: R.yesil },
                  ],
                }))}
              />
            );
          })()
        } />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: BİLDİRİMLER ════════════════════════════
  const ciroEksik = Array.isArray(p.ciro_eksik_gunler) ? p.ciro_eksik_gunler : [];
  const mesajlar = Array.isArray(p.merkez_mesajlar) ? p.merkez_mesajlar : [];
  const oneriRenk = (o) => {
    const r = String(o.renk || '').toUpperCase();
    return r === 'KIRMIZI' ? R.kirmizi : r === 'TURUNCU' ? R.amber : r === 'SARI' ? R.amber : R.mavi;
  };

  // ── MOTOR ÖNERİLERİ: KRİTİK NAKİT GRUBU ───────────────────────────────────
  // Motor, serbest nakde sığmayan HER kart için ayrı bir "NAKİT YETERSİZ" satırı
  // üretiyor → aynı tek sebep (para yetmiyor) listede 5-6 kez tekrar edip diğer
  // önerileri aşağı itiyordu. 2+ ise tek satırda birleştirilir, kartlar çekmecede.
  const kritikNakit = oneriler.filter((o) => String(o.oneri_turu || '') === 'KRITIK_NAKIT');
  const digerOneriler = oneriler.filter((o) => String(o.oneri_turu || '') !== 'KRITIK_NAKIT');
  const oneriSatiri = (o, i) => ({
    id: o.odeme_id || `on-${i}`, _o: o,
    baslik: kisalt(o.baslik || o.oneri || 'Öneri', 80),
    alt: kisalt(o.aciklama || o.detay || '', 100) || 'gerekçe yok',
    tutar: sayi(o.tavsiye_tutar) ? fmt(sayi(o.tavsiye_tutar)) : '',
    tier: oneriRenk(o) === R.kirmizi ? 'kritik' : oneriRenk(o) === R.amber ? 'uyari' : 'bilgi',
  });
  const kritikNakitKartlari = kritikNakit
    .map((o) => o.kart_adi || o.banka)
    .filter(Boolean);
  const oneriSatirlari = [
    ...(kritikNakit.length >= 2
      ? [{
          id: 'oneri-kritik-nakit-grubu', _grup: kritikNakit,
          baslik: `⛔ NAKİT YETERSİZ — ${kritikNakit.length} kart`,
          // ⚠️ Tutar YAZILMAZ: uç bu önerilerde tavsiye_tutar=0 gönderiyor, istenen
          // tutar yalnız açıklama metninin içinde geçiyor — metinden para PARSE
          // ETMEK yasak (biçim değişince sessizce yanlış rakam basar).
          alt: kisalt(
            `serbest nakit bu ödemelere yetmiyor${kritikNakitKartlari.length ? ` · kartlar: ${kritikNakitKartlari.join(', ')}` : ''}`,
            110,
          ),
          tutar: '',
          tier: 'kritik',
        }]
      : kritikNakit.map(oneriSatiri)),
    ...digerOneriler.map(oneriSatiri),
  ];

  // ── 🔶 BUGÜN SENDEN KARAR BEKLEYENLER ─────────────────────────────────────
  // Altta üç ayrı kutu var (motor / onay / bildirim); sahip günü görmek için
  // üçünü de taramak zorundaydı. Bu şerit en fazla 3 maddede özetler; kutular
  // olduğu gibi kalır (şerit özet, kutular kaynak).
  const kritikBildirimler = [...uyarilar, ...mesajlar]
    .filter((u) => String(u.seviye || '').toUpperCase() === 'KRITIK')
    .sort((a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')));
  const kararBekleyen = [];
  if (onaylar.length > 0) {
    kararBekleyen.push({
      k: 'onay', ikon: '🔔', renk: R.amber,
      metin: `${onaylar.length} onay kararın bekliyor`,
      onTikla: () => onKopru?.('__modul:onaylar:kuyruk'),
    });
  }
  if (kritikBildirimler.length > 0) {
    const en = kritikBildirimler[0];
    kararBekleyen.push({
      k: 'bildirim', ikon: '⛔', renk: R.kirmizi,
      metin: kisalt(en.aciklama || en.mesaj || en.baslik || 'Kritik bildirim', 60),
    });
  }
  if (kritikNakit.length > 0) {
    kararBekleyen.push({
      k: 'motor', ikon: '🧠', renk: R.bakir,
      metin: `Motor: ${kritikNakit.length} kritik öneri`,
    });
  }

  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Karar motoru', deger: String(oneriler.length), alt: oneriler.length ? 'öneri bekliyor' : 'öneri yok', renk: oneriler.length ? R.bakir : R.yesil },
        { etiket: 'Onay merkezi', deger: String(onaylar.length), alt: onaylar.length ? 'karar bekliyor' : 'kuyruk boş', renk: onaylar.length ? R.amber : R.yesil },
        { etiket: 'Sistem bildirimi', deger: String(uyarilar.length), alt: 'uyarı defteri', renk: uyarilar.length ? R.amber : R.yesil },
        { etiket: 'Ciro eksiği', deger: String(ciroEksik.length), alt: ciroEksik.length ? 'gün girilmemiş' : 'eksik yok', renk: ciroEksik.length ? R.kirmizi : R.yesil },
      ]} />

      {kararBekleyen.length > 0 && (
        <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14, borderLeft: `3px solid ${R.amber}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 9 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>Bugün senden karar bekleyenler</span>
            <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>aşağıdaki kutuların özeti</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {kararBekleyen.map((k) => (
              <div
                key={k.k}
                onClick={k.onTikla}
                tabIndex={k.onTikla ? 0 : undefined}
                role={k.onTikla ? 'button' : undefined}
                onKeyDown={k.onTikla ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); k.onTikla(); }
                } : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi2}`,
                  cursor: k.onTikla ? 'pointer' : 'default',
                }}
              >
                <span style={{ fontSize: 13, flexShrink: 0 }}>{k.ikon}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: k.renk, minWidth: 0 }}>{k.metin}</span>
                {k.onTikla && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3, whiteSpace: 'nowrap' }}>dokun →</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <Bolum baslik="🧠 Karar motoru" sayac={oneriSatirlari.length} renk={R.bakir} not="öneri-only · hüküm insanın" cocuk={
        oneriler.length === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Motor bugün öneri üretmedi.</div>
          : <Liste
              satirlar={oneriSatirlari}
              onAc={({ _o, _grup }) => (_grup ? onCekmece?.({
                tip: 'MOTOR ÖNERİSİ',
                baslik: `⛔ Nakit yetersiz — ${_grup.length} kart`,
                alt: 'aynı sebep, birden çok kart',
                kpi: [
                  { etiket: 'Etkilenen kart', deger: String(_grup.length), renk: R.kirmizi },
                  { etiket: 'Öncelik', deger: 'kırmızı', renk: R.kirmizi },
                ],
                listeBaslik: 'Nakit yetmeyen kartlar',
                satirlar: _grup.map((o, i) => ({
                  ad: o.kart_adi || o.banka || `Kart ${i + 1}`,
                  detay: o.banka || 'banka bilgisi yok',
                  tutar: o.tarih ? String(o.tarih).slice(0, 10) : '—',
                })),
                not: 'Motor yalnız ÖNERİR — hüküm insanındır. Serbest nakit (zorunlu yükler ayrıldıktan sonra) bu ödemelere yetmiyor; hangisinin öne alınacağı sahip kararıdır.',
                aksiyonAd: 'Strateji Önerileri\'ni aç',
                _hedef: '__modul:panel:strateji',
              }) : onCekmece?.({
                tip: 'MOTOR ÖNERİSİ',
                baslik: kisalt(_o.baslik || 'Öneri', 70),
                alt: String(_o.renk || 'bilgi').toLowerCase(),
                kpi: [
                  { etiket: 'Tavsiye tutar', deger: sayi(_o.tavsiye_tutar) ? fmt(sayi(_o.tavsiye_tutar)) : '—' },
                  { etiket: 'Öncelik', deger: String(_o.renk || '—').toLowerCase(), renk: oneriRenk(_o) },
                ],
                listeBaslik: 'Gerekçe',
                satirlar: [{ ad: 'Motor gerekçesi', detay: 'neden önerildi', tutar: kisalt(_o.aciklama || '—', 80) }],
                not: 'Motor yalnız ÖNERİR — hüküm insanındır. Uygulama Strateji Önerileri ekranında işaretlenir.',
                aksiyonAd: 'Strateji Önerileri\'ni aç',
                _hedef: '__modul:panel:strateji',
              }))}
            />
      } />

      <Bolum baslik="🔔 Onay merkezi" sayac={onaylar.length} renk={R.amber} not="KASA kayıtları hariç" cocuk={
        onaylar.length === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Onay bekleyen kayıt yok.</div>
          : <Liste
              satirlar={onaylar.slice(0, 10).map((o, i) => ({
                id: o.id || `oy-${i}`,
                baslik: kisalt(o.aciklama || o.islem_turu || 'Onay kaydı', 70),
                alt: `${String(o.islem_turu || '').toLowerCase().replace(/_/g, ' ')} · ${kisaGun(o.tarih)}`,
                tutar: sayi(o.tutar) ? fmt(sayi(o.tutar)) : '',
                tier: 'uyari',
                aksiyon: 'Onay Kuyruğu\'nda karar ver',
              }))}
              onAc={() => onKopru?.('__modul:onaylar:kuyruk')}
            />
      } />

      <Bolum baslik="📣 Sistem bildirimleri" sayac={uyarilar.length + mesajlar.length} renk={R.mavi} cocuk={
        (uyarilar.length + mesajlar.length) === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Bildirim yok.</div>
          : <Liste
              /* 🟡 EVV-GENEL-N6 (2026-08-12): eskiden sırasız birleştirilip slice(0,12)
                 ediliyordu → bir feed ilk 12'yi doldurursa diğerinin daha YENİ/kritik
                 kaydı görünmeden düşüyordu. Önce tarih'e göre (yeni→eski) sırala. */
              satirlar={[...uyarilar, ...mesajlar]
                .sort((a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')))
                .slice(0, 12).map((u, i) => ({
                id: u.id || `u-${i}`,
                // 🔴 (2026-08-14) BİLDİRİMLER İSİMSİZDİ: başlık `mesaj` okuyordu ama
                // `mesaj` jenerik durum cümlesi ("4 gün sonra ödeme var.") — KİMİN
                // ödemesi olduğu `aciklama`da ("Vadeli Alım: Fatura X (FİRMA)").
                // Liste "4 gün sonra ödeme var" × 6 satır hâline geliyordu.
                // Artık alacaklı başlıkta, durum cümlesi alt satırda.
                baslik: kisalt(u.aciklama || u.mesaj || u.baslik || u.metin || 'Bildirim', 88),
                alt: [
                  // `aciklama` yoksa mesaj zaten başlığa çıktı → alt satırda tekrarlanmaz.
                  u.aciklama ? u.mesaj : null,
                  u.sube_ad || u.sube_adi,
                  u.tarih ? kisaGun(u.tarih) : null,
                ].filter(Boolean).join(' · ') || 'genel',
                tutar: sayi(u.tutar) ? fmt(sayi(u.tutar)) : '',
                tier: String(u.seviye || '').toUpperCase() === 'KRITIK' ? 'kritik'
                  : String(u.seviye || '').toUpperCase() === 'UYARI' ? 'uyari' : 'bilgi',
              }))}
            />
      } />

      <Bolum baslik="📉 Ciro eksikleri" sayac={ciroEksik.length} renk={ciroEksik.length ? R.kirmizi : R.yesil} not="ciro girilmemiş günler" cocuk={
        ciroEksik.length === 0
          ? <BosDurum tamam baslik="Ciro eksiği yok" aciklama="Tüm günlerin cirosu girilmiş." />
          /* 🔴 (2026-08-14) 'Şube' kolonu CANLIDA HEP "—" idi: uç gün bazında çalışıyor,
             alanları {tarih, gun_adi, days_ago, kritik} — ŞUBE KIRILIMI YOK. Var
             olmayan alanı kolon yapmak yerine ucun gerçekten verdiği bilgi gösterilir:
             hangi gün, ne kadar zaman önce. */
          : <Tablo
              baslik=""
              not={ciroEksik.length > 15 ? `ilk 15 / ${ciroEksik.length} gün` : null}
              kolonlar={[{ ad: 'Gün' }, { ad: 'Tarih' }, { ad: 'Durum' }]}
              satirlar={ciroEksik.slice(0, 15).map((g, i) => ({
                id: `ce-${i}`,
                hucreler: [
                  { v: gunTr(g.gun_adi), kalin: true },
                  // "0 gün önce" saçma okunuyordu → bugünse "bugün" yazılır.
                  { v: `${kisaGun(g.tarih)} · ${sayi(g.days_ago) === 0 ? 'bugün' : `${sayi(g.days_ago)} gün önce`}`, mono: true, renk: R.not },
                  { v: g.kritik ? 'kritik' : 'eksik', rozet: g.kritik ? R.kirmizi : R.amber },
                ],
              }))}
              onSatir={() => onKopru?.('__modul:para:girisi')}
            />
      } />
    </>
  );
}
