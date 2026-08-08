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

const sayi = (v) => Number(v) || 0;
const kisalt = (t, n = 88) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const kisaGun = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}` : String(iso || '—');
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
      api('/kasa-kontrol').catch(() => null),
      api('/sabit-giderler/odenenler').catch(() => null),
      api('/vadeli-alimlar/ozet').catch(() => null),
      // NAKİT KONUM (2026-08-08): "param şu an nerede?" — şube kasası / yolda /
      // banka duraklarının toplamı ile kasa defteri bakiyesini karşılaştırır.
      api('/ops/metrics/nakit-konum?gun=60').catch(() => null),
    ]).then(([panel, uyarilar, onaylar, kasa, odenen, vadeli, nakit]) => {
      if (!panel) setHata('Panel verisi alınamadı');
      setVeri({ panel: panel || {}, uyarilar, onaylar, kasa, odenen, vadeli, nakit });
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

  // ── TRİAJ: gecikme GÜNÜNE göre (klasik panelin kaynak kuralı) ──────────────
  const odemeler = Array.isArray(p.bugun_odemeler) ? p.bugun_odemeler : [];
  const gK = odemeler.filter((u) => sayi(u.gun_farki) <= -15);
  const gU = odemeler.filter((u) => sayi(u.gun_farki) >= -14 && sayi(u.gun_farki) <= -8);
  const gB = odemeler.filter((u) => sayi(u.gun_farki) >= -7 && sayi(u.gun_farki) < 0);
  const gBug = odemeler.filter((u) => sayi(u.gun_farki) >= 0);
  // 🐞 CANLI DENETİM (2026-08-03): toplam `asgari_kalan` ile, satırlar `tutar`
  // ile sayıyordu — değişken giderde (asgari_kalan yok) KPI "8 kalem" deyip
  // 7 kalemin toplamını gösteriyordu. Aynı erişimci → sayı ve toplam aynı evren.
  const gecikmisTutar = (u) => sayi(u.tutar ?? u.asgari_kalan ?? u.asgari);
  const gecikmisToplam = odemeler
    .filter((u) => sayi(u.gun_farki) < 0)
    .reduce((s, u) => s + gecikmisTutar(u), 0);

  const odemeSatiri = (u, i) => ({
    id: u.id || `o-${i}`, _u: u,
    baslik: kisalt(u.ad || u.aciklama || u.tedarikci || 'Ödeme', 60),
    alt: [
      u.tip ? String(u.tip) : null,
      sayi(u.gun_farki) < 0 ? `${Math.abs(sayi(u.gun_farki))} gün gecikti` : 'bugün vadesi',
    ].filter(Boolean).join(' · '),
    tutar: fmt(sayi(u.tutar ?? u.asgari_kalan ?? u.asgari)),
    tier: sayi(u.gun_farki) <= -15 ? 'kritik' : sayi(u.gun_farki) <= -8 ? 'uyari' : sayi(u.gun_farki) < 0 ? 'bilgi' : 'iyi',
  });

  const odemeCekmece = ({ _u }) => onCekmece?.({
    tip: 'ÖDEME KAYDI',
    baslik: kisalt(_u.ad || _u.aciklama || 'Ödeme', 60),
    alt: sayi(_u.gun_farki) < 0 ? `${Math.abs(sayi(_u.gun_farki))} gün gecikti` : 'bugün vadesi',
    // Sahip düzeltmesi (2026-08-03): boş alanı GİZLEMEK yerine DOLDUR.
    // Satırda `tip`/`ad` yok ama kaynak_tablo + tarih + seviye VAR — tür
    // kaynaktan türetilir, vade tarihi ve seviye de çekmeceye girer.
    kpi: [
      { etiket: 'Tutar', deger: fmt(sayi(_u.tutar ?? _u.asgari_kalan)), renk: R.kirmizi },
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
      { ad: 'Ödeme adı', detay: _u.kaynak_tablo ? `kaynak: ${_u.kaynak_tablo}` : '', tutar: kisalt(_u.ad || _u.aciklama || '—', 34) },
      ...(_u.tarih ? [{ ad: 'Vade tarihi', detay: 'planlanan ödeme günü', tutar: String(_u.tarih).slice(0, 10) }] : []),
      { ad: 'Asgari kalan', detay: 'ödenmesi gereken', tutar: fmt(sayi(_u.asgari_kalan ?? _u.asgari ?? _u.tutar)) },
    ],
    not: 'Bu kart SALT-OKURDUR. Ödeme Ödeme Merkezi\'nde yapılır — para yazma yolu burada açılmaz.',
    aksiyonAd: 'Ödeme Merkezi\'nde aç',
    _hedef: '__modul:odeme:bekleyen',
  });

  // ════════════════════════ GÖRÜNÜM: KARAR ALANI ════════════════════════════
  if (gorunum === 'karar') {
    const bolum = (baslik, kayitlar, renk) => (
      <Bolum
        baslik={baslik}
        renk={renk}
        sayac={kayitlar.length}
        not="satıra tıkla → ödeme dosyası"
        cocuk={kayitlar.length === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Bu katmanda kayıt yok.</div>
          : <Liste satirlar={kayitlar.map(odemeSatiri)} onAc={odemeCekmece} />}
      />
    );
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kasa', deger: fmt(sayi(p.kasa)), alt: 'kanonik bakiye', renk: sayi(p.kasa) >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'Gecikmiş toplam', deger: fmt(gecikmisToplam), alt: `${gK.length + gU.length + gB.length} kalem`, renk: gecikmisToplam > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Bugün vadesi', deger: String(gBug.length), alt: gBug.length ? 'bugün ödenecek' : 'bugün yok', renk: gBug.length ? R.amber : R.yesil },
          { etiket: 'Kaç gün dayanır', deger: p.kac_gun_dayanir != null ? `${sayi(p.kac_gun_dayanir)} gün` : '—', alt: 'kasa / günlük yük', renk: sayi(p.kac_gun_dayanir) < 15 ? R.kirmizi : R.krem },
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
        {/* Klasik panelin 4 katmanlı triajı — gecikme GÜNÜNE göre */}
        {bolum('KRİTİK · 15+ gün gecikmiş', gK, R.kirmizi)}
        {bolum('UYARI · 8–14 gün', gU, R.amber)}
        {bolum('BİLGİ · 0–7 gün', gB, R.mavi)}
        {bolum('BUGÜN vadesi gelen', gBug, R.bakir)}
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
    return (
      <>
        {nakitBlok}
        <KpiSeridi kpiler={[
          { etiket: 'Bu ay ciro', deger: fmt(sayi(p.bu_ay_sadece_ciro ?? p.bu_ay_ciro)), alt: 'sadece ciro', renk: R.krem },
          { etiket: 'Nakit giriş', deger: giris ? fmt(giris) : '—', alt: 'bu ay', renk: giris ? R.yesil : R.not },
          { etiket: 'Nakit çıkış', deger: cikis ? fmt(cikis) : '—', alt: 'bu ay', renk: cikis ? R.kirmizi : R.not },
          { etiket: 'Net akış', deger: net ? fmt(net) : '—', alt: net >= 0 ? 'pozitif' : 'negatif', renk: net >= 0 ? R.yesil : R.kirmizi },
        ]} />

        <Bolum baslik="💼 Bu ayın para akışı" not="tahsilat kanalları" cocuk={
          <>
            <Satir ad="Nakit" deger={fmt(sayi(p.bu_ay_nakit))} />
            <Satir ad="POS / kart" deger={fmt(sayi(p.bu_ay_pos))} alt={sayi(p.bu_ay_pos_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_pos_kesinti))}` : null} />
            <Satir ad="Online" deger={fmt(sayi(p.bu_ay_online))} alt={sayi(p.bu_ay_online_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_online_kesinti))}` : null} />
            <Satir ad="Dış kaynak geliri" deger={fmt(sayi(p.bu_ay_dis_kaynak))} renk={R.metin2} />
            <Satir ad="Devir" deger={fmt(sayi(p.bu_ay_devir))} renk={R.metin2} />
          </>
        } />

        <Bolum baslik="🔍 Kasa özeti" not="anlık dağılım" cocuk={
          <>
            <Satir ad="Kanonik kasa" deger={fmt(sayi(p.kasa))} renk={R.yesil} alt="motors.guncel_kasa" />
            <Satir ad="Anlık nakit" deger={fmt(sayi(p.anlik_nakit))} />
            <Satir ad="Anlık kart" deger={fmt(sayi(p.anlik_kart))} />
            <Satir ad="Genel nakit toplamı" deger={fmt(sayi(p.genel_nakit_toplam))} renk={R.metin2} />
            <Satir ad="Genel kart toplamı" deger={fmt(sayi(p.genel_kart_toplam))} renk={R.metin2} />
          </>
        } />

        <Bolum baslik="⚡ Ödeme baskısı" not="finansman yükü" cocuk={
          <>
            <Satir ad="Bekleyen borç taksiti" deger={fmt(sayi(p.borc_taksit_bekleyen))} alt={sayi(p.borc_taksit_bekleyen_adet) ? `${sayi(p.borc_taksit_bekleyen_adet)} taksit` : null} renk={sayi(p.borc_taksit_bekleyen) ? R.kirmizi : R.krem} />
            <Satir ad="Ödenen borç taksiti" deger={fmt(sayi(p.borc_taksit_odenen))} renk={R.yesil} />
            <Satir ad="Bu ay kart faizi" deger={fmt(sayi(p.bu_ay_kart_faizi))} renk={sayi(p.bu_ay_kart_faizi) ? R.kirmizi : R.krem} />
            <Satir ad="Finansman maliyeti" deger={fmt(sayi(p.bu_ay_finansman_maliyeti))} renk={sayi(p.bu_ay_finansman_maliyeti) ? R.kirmizi : R.krem} />
            <Satir ad="Bekleyen gider sayısı" deger={String(sayi(p.bekleyen_gider_sayisi))} renk={R.metin2} />
          </>
        } />

        <Bolum baslik="✅ Bu ay ödenen sabit giderler" not="salt-okur" cocuk={
          (() => {
            const liste = Array.isArray(veri.odenen) ? veri.odenen : (veri.odenen?.odemeler || veri.odenen?.satirlar || []);
            if (!liste.length) return <div style={{ fontSize: 12, color: R.not2 }}>Bu ay ödenmiş sabit gider kaydı yok.</div>;
            return (
              <Tablo
                baslik=""
                kolonlar={[{ ad: 'Gider' }, { ad: 'Tarih' }, { ad: 'Tutar', sag: true }]}
                satirlar={liste.slice(0, 15).map((o, i) => ({
                  id: o.id || `sg-${i}`,
                  hucreler: [
                    { v: kisalt(o.ad || o.aciklama || o.gider_adi || '—', 44), kalin: true },
                    { v: kisaGun(o.odeme_tarihi || o.tarih), mono: true, renk: R.not },
                    { v: fmt(sayi(o.tutar)), mono: true, sag: true, kalin: true, renk: R.yesil },
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
  const oneriler = Array.isArray(p.oneriler) ? p.oneriler : [];
  const ciroEksik = Array.isArray(p.ciro_eksik_gunler) ? p.ciro_eksik_gunler : [];
  const mesajlar = Array.isArray(p.merkez_mesajlar) ? p.merkez_mesajlar : [];
  const oneriRenk = (o) => {
    const r = String(o.renk || '').toUpperCase();
    return r === 'KIRMIZI' ? R.kirmizi : r === 'TURUNCU' ? R.amber : r === 'SARI' ? R.amber : R.mavi;
  };
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Karar motoru', deger: String(oneriler.length), alt: oneriler.length ? 'öneri bekliyor' : 'öneri yok', renk: oneriler.length ? R.bakir : R.yesil },
        { etiket: 'Onay merkezi', deger: String(onaylar.length), alt: onaylar.length ? 'karar bekliyor' : 'kuyruk boş', renk: onaylar.length ? R.amber : R.yesil },
        { etiket: 'Sistem bildirimi', deger: String(uyarilar.length), alt: 'uyarı defteri', renk: uyarilar.length ? R.amber : R.yesil },
        { etiket: 'Ciro eksiği', deger: String(ciroEksik.length), alt: ciroEksik.length ? 'gün girilmemiş' : 'eksik yok', renk: ciroEksik.length ? R.kirmizi : R.yesil },
      ]} />

      <Bolum baslik="🧠 Karar motoru" sayac={oneriler.length} renk={R.bakir} not="öneri-only · hüküm insanın" cocuk={
        oneriler.length === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Motor bugün öneri üretmedi.</div>
          : <Liste
              satirlar={oneriler.map((o, i) => ({
                id: o.odeme_id || `on-${i}`, _o: o,
                baslik: kisalt(o.baslik || o.oneri || 'Öneri', 80),
                alt: kisalt(o.aciklama || o.detay || '', 100) || 'gerekçe yok',
                tutar: sayi(o.tavsiye_tutar) ? fmt(sayi(o.tavsiye_tutar)) : '',
                tier: oneriRenk(o) === R.kirmizi ? 'kritik' : oneriRenk(o) === R.amber ? 'uyari' : 'bilgi',
              }))}
              onAc={({ _o }) => onCekmece?.({
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
              })}
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
              satirlar={[...uyarilar, ...mesajlar].slice(0, 12).map((u, i) => ({
                id: u.id || `u-${i}`,
                baslik: kisalt(u.mesaj || u.baslik || u.metin || 'Bildirim', 88),
                alt: [u.sube_ad || u.sube_adi, u.tarih ? kisaGun(u.tarih) : null].filter(Boolean).join(' · ') || 'genel',
                tutar: sayi(u.tutar) ? fmt(sayi(u.tutar)) : '',
                tier: String(u.seviye || '').toUpperCase() === 'KRITIK' ? 'kritik'
                  : String(u.seviye || '').toUpperCase() === 'UYARI' ? 'uyari' : 'bilgi',
              }))}
            />
      } />

      <Bolum baslik="📉 Ciro eksikleri" sayac={ciroEksik.length} renk={ciroEksik.length ? R.kirmizi : R.yesil} not="ciro girilmemiş günler" cocuk={
        ciroEksik.length === 0
          ? <BosDurum tamam baslik="Ciro eksiği yok" aciklama="Tüm günlerin cirosu girilmiş." />
          : <Tablo
              baslik=""
              kolonlar={[{ ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Durum' }]}
              satirlar={ciroEksik.slice(0, 15).map((g, i) => ({
                id: `ce-${i}`,
                hucreler: [
                  { v: g.sube_adi || g.sube_ad || '—', kalin: true },
                  { v: kisaGun(g.tarih), mono: true, renk: R.not },
                  { v: g.kritik ? 'kritik' : 'eksik', rozet: g.kritik ? R.kirmizi : R.amber },
                ],
              }))}
              onSatir={() => onKopru?.('__modul:para:girisi')}
            />
      } />
    </>
  );
}
