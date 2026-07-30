// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — KÂR & MALİYET modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → maliyet.* bölümleri
//
// 4 görünüm: Marj Özeti · Ürün Maliyeti · Reçeteler · Fiyat Zinciri
//
// Blueprint'ten BİLİNÇLİ sapmalar (tasarımın-devamı kuralıyla modellendi):
// 1. "Ürün Marjı" → "ÜRÜN MALİYETİ": sistemde ürün bazlı SATIŞ fiyatı yok
//    (satışlar Evo'da, menü fiyatı TV tarafında) — %79 marj kolonu sahte olurdu.
//    Gerçek karşılık: reçete maliyeti (reçete × alış fiyatı) + FİYATSIZ hammadde
//    riski (bu sistemin gerçek risk teması). Satış fiyatı entegre olursa marj
//    kolonu eklenir.
// 2. Hero marj yüzdesi yerine FOOD COST % (sistemin gerçek metriği,
//    sube_food_cost_gun) + %28–35 kahve zinciri benchmark bandı.
// 3. Fiyat zinciri = fiyat_zam_alarmi defteri (eşik üstü artışlar, onaylı
//    fiyattan) — blueprint'in dikey zaman çizelgesi birebir; "gördüm" işareti
//    MEVCUT uca delege (yeni yazma yolu yok).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Hero, Tablo } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const pct = (v) => `%${Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;

// Yerli form stilleri (köprü kaldırma turu)
const mlAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const mlEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

const rozetHap = (renk) => ({
  padding: '3px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
  background: `${renk}22`, color: renk, whiteSpace: 'nowrap',
});

function Yukleniyor() {
  return (
    <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>
      Yükleniyor…
    </div>
  );
}
function HataBandi({ mesaj, onTekrar }) {
  return (
    <div style={{
      ...kartYuzey, padding: '16px 20px', marginBottom: 16, display: 'flex',
      alignItems: 'center', gap: 14, border: `1px solid ${R.kirmizi}55`,
    }}>
      <span style={{ fontSize: 13, color: R.kirmizi, flex: 1 }}>
        Veri alınamadı — {mesaj || 'sunucuya ulaşılamadı'}. Bu "veri yok" değil, bağlantı sorunu.
      </span>
      <button
        onClick={onTekrar}
        style={{
          padding: '7px 14px', borderRadius: 9, border: `1px solid ${R.kirmizi}55`,
          background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 12, fontWeight: 700,
          fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        🔄 Tekrar dene
      </button>
    </div>
  );
}
function BosDurum({ metin }) {
  return (
    <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: R.not }}>{metin}</div>
    </div>
  );
}

export default function MaliyetModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [ozet, setOzet] = useState(null);
  const [ozetHata, setOzetHata] = useState('');
  const [receteler, setReceteler] = useState(null);
  const [fiyatlar, setFiyatlar] = useState(null);
  const [receteHata, setReceteHata] = useState('');
  const [alarmlar, setAlarmlar] = useState(null);
  const [alarmHata, setAlarmHata] = useState('');
  const [esik, setEsik] = useState(15);
  const [kontrol, setKontrol] = useState(null);
  const [kontrolHata, setKontrolHata] = useState('');
  // ── YERLİ REÇETE EŞLEŞTİRME (köprü kaldırma turu, 2026-07-30) ─────────────
  // Kural (2026-07-29 sahip onayı): reçete "Ice X" = Evo "X Ice"; sade ad = "X 14 Oz".
  // Öneriler onaysız KULLANILMAZ (duyu anayasası) — bu ekran yalnız karar verir.
  const [eslModal, setEslModal] = useState(false);
  const [eslListe, setEslListe] = useState(null);
  const [eslMesgul, setEslMesgul] = useState('');      // işlenen öneri id'si
  const [eslTip, setEslTip] = useState('urun');        // urun | malzeme sekmesi
  const [elleForm, setElleForm] = useState(null);      // {tip, kaynak_ad, hedef_ad, hedef_kod}
  const [adaylar, setAdaylar] = useState(null);

  const ozetYukle = useCallback(() => {
    setOzetHata('');
    api('/ops/maliyet/ozet?gun=30')
      .then((d) => setOzet(d || {}))
      .catch((e) => setOzetHata(e?.message || ''));
  }, []);

  const receteYukle = useCallback(() => {
    setReceteHata('');
    api('/ops/maliyet/recete-listesi')
      .then((d) => setReceteler(Array.isArray(d?.receteler) ? d.receteler : []))
      .catch((e) => setReceteHata(e?.message || ''));
    api('/ops/maliyet/alis-fiyatlari')
      .then((d) => setFiyatlar(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setFiyatlar([]));
  }, []);

  const alarmYukle = useCallback(() => {
    setAlarmHata('');
    api('/ops/fiyat-zam-alarmlari?gun=180&limit=60')
      .then((d) => {
        setAlarmlar(Array.isArray(d?.alarmlar) ? d.alarmlar : []);
        if (d?.esik_yuzde) setEsik(sayi(d.esik_yuzde));
      })
      .catch((e) => setAlarmHata(e?.message || ''));
  }, []);

  const kontrolYukle = useCallback(() => {
    setKontrolHata('');
    api('/recete/kontrol?gun=7')
      .then((d) => setKontrol(d || {}))
      .catch((e) => setKontrolHata(e?.message || ''));
  }, []);

  // ── eşleştirme ekranı (klasik ReceteEslestirme sözleşmesi) ────────────────
  const eslYukle = () => {
    api('/recete/eslestirmeler')
      .then((d) => setEslListe(Array.isArray(d?.eslestirmeler) ? d.eslestirmeler : []))
      .catch(() => setEslListe([]));
  };

  const eslAc = () => {
    setEslModal(true);
    setEslListe(null);
    setElleForm(null);
    eslYukle();
    if (!adaylar) {
      api('/recete/eslestirme-adaylar')
        .then((d) => setAdaylar(d || {}))
        .catch(() => setAdaylar({}));
    }
  };

  const eslKarar = async (id, karar) => {
    setEslMesgul(id);
    try {
      await api('/recete/eslestirme-karar', { method: 'POST', body: { id, karar } });
      onToast?.(karar === 'onayli' ? '✓ Eşleştirme onaylandı' : '✗ Öneri reddedildi');
      eslYukle();
      kontrolYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally {
      setEslMesgul('');
    }
  };

  const eslOnerUret = async () => {
    setEslMesgul('oner');
    try {
      const r = await api('/recete/eslestirme-oner', { method: 'POST', body: {} });
      onToast?.(`🔍 ${sayi(r?.yeni_oneri)} yeni öneri üretildi — onayını bekliyor`);
      eslYukle();
    } catch (e) {
      onToast?.(e?.message || 'Öneri üretilemedi');
    } finally {
      setEslMesgul('');
    }
  };

  const elleEkle = async () => {
    const f = elleForm;
    if (!f?.kaynak_ad || !f?.hedef_ad) { onToast?.('Kaynak ve hedef seçilmeli'); return; }
    if (f.tip === 'malzeme' && !f.hedef_kod) { onToast?.('Malzeme eşleştirmesinde depo kalemi seçilmeli'); return; }
    setEslMesgul('elle');
    try {
      await api('/recete/eslestirme-ekle', {
        method: 'POST',
        body: { tip: f.tip, kaynak_ad: f.kaynak_ad, hedef_ad: f.hedef_ad, hedef_kod: f.hedef_kod || null },
      });
      onToast?.('✓ Elle eşleştirme kaydedildi (insan kararı = onaylı)');
      setElleForm(null);
      eslYukle();
      kontrolYukle();
    } catch (e) {
      onToast?.(e?.message || 'Eklenemedi');
    } finally {
      setEslMesgul('');
    }
  };

  useEffect(() => {
    if (gorunum === 'ozet') ozetYukle();
    if (gorunum === 'urun' || gorunum === 'recete') receteYukle();
    if (gorunum === 'fiyat') alarmYukle();
    if (gorunum === 'tuketim') kontrolYukle();
  }, [gorunum, ozetYukle, receteYukle, alarmYukle, kontrolYukle]);

  // Aktif alış fiyatı haritası: kalem_kodu → {maliyet, birim} (en güncel geçerli)
  const fiyatMap = useMemo(() => {
    const m = {};
    (fiyatlar || []).forEach((f) => {
      if (f.gecerli_bitis) return; // kapanmış fiyat
      const k = String(f.kalem_kodu);
      if (!m[k]) m[k] = { maliyet: sayi(f.birim_maliyet_tl), birim: f.birim || 'adet' };
    });
    return m;
  }, [fiyatlar]);

  // Reçete → maliyet hesabı (fiyatsız hammadde sayısıyla birlikte)
  const receteMaliyet = useCallback((r) => {
    let toplam = 0;
    let fiyatsiz = 0;
    const satirlar = (r.hammaddeler || []).map((h) => {
      const f = fiyatMap[String(h.hammadde_kodu)];
      const tutar = f ? sayi(h.miktar) * f.maliyet : null;
      if (tutar == null) fiyatsiz += 1;
      else toplam += tutar;
      return { ...h, tutar };
    });
    return { satirlar, toplam, fiyatsiz };
  }, [fiyatMap]);

  // ════════════════════════ GÖRÜNÜM: MARJ ÖZETİ ═════════════════════════════
  if (gorunum === 'ozet') {
    if (ozetHata) return <HataBandi mesaj={ozetHata} onTekrar={ozetYukle} />;
    if (!ozet) return <Yukleniyor />;
    const gunler = Array.isArray(ozet.gun_satirlari) ? ozet.gun_satirlari : [];
    // Gün bazlı toplulaştır (şube satırları → gün toplamı)
    const gunMap = {};
    gunler.forEach((g) => {
      const t = String(g.tarih || '').slice(0, 10);
      if (!gunMap[t]) gunMap[t] = { ciro: 0, maliyet: 0, fire: 0 };
      gunMap[t].ciro += sayi(g.ciro_tl);
      gunMap[t].maliyet += sayi(g.gercek_maliyet_tl || g.teorik_maliyet_tl);
      gunMap[t].fire += sayi(g.shrinkage_tl);
    });
    const siraliGunler = Object.keys(gunMap).sort();
    const seri = siraliGunler.map((t) => {
      const g = gunMap[t];
      return g.ciro > 0 ? (g.maliyet / g.ciro) * 100 : 0;
    });
    const toplamCiro = siraliGunler.reduce((s, t) => s + gunMap[t].ciro, 0);
    const toplamMaliyet = siraliGunler.reduce((s, t) => s + gunMap[t].maliyet, 0);
    const toplamFire = siraliGunler.reduce((s, t) => s + gunMap[t].fire, 0);
    const foodCost = toplamCiro > 0 ? (toplamMaliyet / toplamCiro) * 100 : null;
    const bench = foodCost == null ? null : foodCost <= 35 && foodCost >= 28
      ? { ad: 'norm içinde', tip: 'iyi' }
      : foodCost < 28 ? { ad: 'normun altında', tip: 'iyi' } : { ad: 'norm üstü', tip: 'kotu' };
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Food cost (30 gün)', deger: foodCost == null ? '—' : pct(foodCost), alt: 'benchmark %28–35', renk: foodCost == null ? R.not : foodCost > 35 ? R.kirmizi : R.yesil },
          { etiket: 'Stok değeri', deger: fmt(sayi(ozet.stok_degeri_tl ?? ozet.toplam_stok_degeri_tl)), alt: 'mevcut stok × alış fiyatı' },
          { etiket: 'Fire (30 gün)', deger: fmt(toplamFire), alt: 'shrinkage toplamı', renk: toplamFire > 0 ? R.amber : R.krem },
          { etiket: 'Altyapı', deger: `${sayi(ozet.alis_fiyat_sayisi)} fiyat · ${sayi(ozet.recete_sayisi)} reçete`, alt: 'tanımlı kayıtlar' },
        ]} />
        {seri.length >= 2 ? (
          <Hero
            etiket="Food cost · günlük seyir (ürün maliyeti / ciro)"
            deger={foodCost == null ? '—' : pct(foodCost)}
            delta={bench?.ad}
            deltaTip={bench?.tip || 'notr'}
            not={`Son ${siraliGunler.length} günün toplamı: ciro ${fmt(toplamCiro)} · ürün maliyeti ${fmt(toplamMaliyet)}. Kahve zinciri normu %28–35 — çizgi bu bandın üstüne çıktığı gün maliyet yönetimi gerektirir.`}
            seri={seri}
            seriEtiket={siraliGunler.map(tarihKisa)}
            seriAd="food cost"
            seriBicim={pct}
            ikincil={[
              { etiket: 'En iyi gün', alt: 'en düşük food cost', deger: seri.length ? pct(Math.min(...seri.filter((x) => x > 0))) : '—', renk: R.yesil },
              { etiket: 'En kötü gün', alt: 'en yüksek food cost', deger: seri.length ? pct(Math.max(...seri)) : '—', renk: R.kirmizi },
              { etiket: 'Fiyat zinciri', alt: 'eşik üstü artışlar', deger: 'incele →', renk: R.bakir },
            ]}
            onIkincil={(h) => h.etiket === 'Fiyat zinciri' && onKopru?.('__gorunum:fiyat')}
          />
        ) : (
          <BosDurum metin="Günlük food cost kaydı henüz birikmedi — alış fiyatları ve reçeteler tanımlandıkça bu ekran dolar. Şu ana kadarki kayıtlar KPI şeridinde." />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: ÜRÜN MALİYETİ ══════════════════════════
  if (gorunum === 'urun') {
    if (receteHata) return <HataBandi mesaj={receteHata} onTekrar={receteYukle} />;
    if (receteler == null || fiyatlar == null) return <Yukleniyor />;
    const hesapli = receteler.map((r) => ({ r, h: receteMaliyet(r) }));
    const eksikli = hesapli.filter((x) => x.h.fiyatsiz > 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Reçeteli ürün', deger: String(receteler.length), alt: 'maliyet hesaplanabilir' },
          { etiket: 'Fiyatsız hammaddeli', deger: String(eksikli.length), alt: 'maliyeti EKSİK hesaplanır', renk: eksikli.length > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Tanımlı alış fiyatı', deger: String((fiyatlar || []).filter((f) => !f.gecerli_bitis).length), alt: 'aktif kayıt' },
          { etiket: 'En pahalı reçete', deger: hesapli.length ? fmt(Math.max(...hesapli.map((x) => x.h.toplam))) : '—', alt: 'malzeme maliyeti' },
        ]} />

        {/* Sistemde satış fiyatı yok — marj bilerek gösterilmiyor (sahte sayı yasağı).
            Bu şerit o kısıtı GÖRÜNÜR yapar (desen 8). */}
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ kapsam</span>
          Bu tablo <b style={{ color: R.metin2 }}>malzeme maliyetini</b> gösterir. Satış fiyatı sisteme bağlı değil —
          marj yüzdesi hesaplanamaz; fiyatsız hammadde satırları maliyeti eksik bırakır (kırmızı rozet).
        </div>

        {receteler.length === 0 ? (
          <BosDurum metin="Henüz reçete tanımlı değil — Reçete Eşleştirme ekranından tanımlanır." />
        ) : (
          <Tablo
            baslik="Ürün maliyeti · reçete × güncel alış fiyatı"
            not="satıra tıkla → reçete kırılımı"
            kolonlar={[
              { ad: 'Ürün' }, { ad: 'Hammadde', sag: 1 }, { ad: 'Fiyatsız', sag: 1 },
              { ad: 'Malzeme maliyeti', sag: 1 }, { ad: 'Durum' },
            ]}
            satirlar={hesapli
              .sort((a, b) => b.h.toplam - a.h.toplam)
              .slice(0, 80)
              .map(({ r, h }) => ({
                id: r.urun_id,
                _r: r, _h: h,
                hucreler: [
                  { v: r.urun_adi || r.urun_id, kalin: true },
                  { v: String((r.hammaddeler || []).length), mono: true, sag: true },
                  { v: h.fiyatsiz ? String(h.fiyatsiz) : '—', mono: true, sag: true, renk: h.fiyatsiz ? R.kirmizi : R.not3 },
                  { v: fmt(h.toplam) + (h.fiyatsiz ? ' +?' : ''), mono: true, sag: true, kalin: true, renk: h.fiyatsiz ? R.amber : R.krem },
                  h.fiyatsiz
                    ? { v: 'eksik hesap', rozet: R.kirmizi }
                    : { v: 'tam', rozet: R.yesil },
                ],
              }))}
            onSatir={({ _r, _h }) => onCekmece?.({
              tip: 'REÇETE KIRILIMI',
              baslik: _r.urun_adi || _r.urun_id,
              alt: `${(_r.hammaddeler || []).length} hammadde · malzeme maliyeti ${fmt(_h.toplam)}${_h.fiyatsiz ? ' (eksik)' : ''}`,
              kpi: [
                { etiket: 'Malzeme maliyeti', deger: fmt(_h.toplam), renk: _h.fiyatsiz ? R.amber : R.krem },
                { etiket: 'Hammadde', deger: String((_r.hammaddeler || []).length) },
                { etiket: 'Fiyatsız', deger: String(_h.fiyatsiz), renk: _h.fiyatsiz ? R.kirmizi : R.yesil },
                { etiket: 'Satış fiyatı', deger: 'bağlı değil', renk: R.not2 },
              ],
              listeBaslik: 'Reçete satırları',
              satirlar: _h.satirlar.map((s) => ({
                ad: s.hammadde_adi || s.hammadde_kodu,
                detay: `${s.miktar} ${s.birim || 'adet'}`,
                tutar: s.tutar == null ? 'fiyat yok' : fmt(s.tutar),
              })),
              not: _h.fiyatsiz
                ? `${_h.fiyatsiz} hammaddenin alış fiyatı tanımsız — maliyet gerçekte daha yüksek. Fiyatlar Kâr & Maliyet ekranından girilir.`
                : 'Tüm hammaddelerin güncel alış fiyatı tanımlı.',
              aksiyonAd: 'Reçete / fiyat yönetimini aç',
              _hedef: '__modul:maliyet:ozet',
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: REÇETELER ══════════════════════════════
  if (gorunum === 'recete') {
    if (receteHata) return <HataBandi mesaj={receteHata} onTekrar={receteYukle} />;
    if (receteler == null || fiyatlar == null) return <Yukleniyor />;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Tanımlı reçete', deger: String(receteler.length), alt: 'ürün kartı' },
          { etiket: 'Aktif alış fiyatı', deger: String((fiyatlar || []).filter((f) => !f.gecerli_bitis).length), alt: 'hammadde fiyatı' },
          { etiket: 'Eksiksiz reçete', deger: String(receteler.filter((r) => receteMaliyet(r).fiyatsiz === 0).length), alt: 'tüm fiyatlar tanımlı', renk: R.yesil },
          { etiket: 'Düzenleme', deger: 'Reçete Eşleştirme', alt: 'ekleme/değiştirme orada' },
        ]} />
        {receteler.length === 0 ? (
          <BosDurum metin="Henüz reçete yok — Reçete Eşleştirme ekranından tanımlanır." />
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 12, marginBottom: 16,
          }}>
            {receteler.slice(0, 30).map((r) => {
              const h = receteMaliyet(r);
              return (
                <div key={r.urun_id} style={{ ...kartYuzey, padding: '18px 20px' }}>
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
                    paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12,
                  }}>
                    <div>
                      <div style={{ fontFamily: F.baslik, fontSize: 16, fontWeight: 600 }}>
                        {r.urun_adi || r.urun_id}
                      </div>
                      <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>
                        {(r.hammaddeler || []).length} hammadde
                      </div>
                    </div>
                    {h.fiyatsiz > 0 && <span style={rozetHap(R.kirmizi)}>{h.fiyatsiz} fiyatsız</span>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {h.satirlar.slice(0, 8).map((s, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                        <span style={{ color: R.krem }}>{s.hammadde_adi || s.hammadde_kodu}</span>
                        <span style={{ flex: 1, height: 1, background: R.cizgi2 }} />
                        <span style={{ fontSize: 11, color: R.not2 }}>{s.miktar} {s.birim || 'adet'}</span>
                        <span style={{
                          whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 12.5,
                          color: s.tutar == null ? R.kirmizi : R.metin2, minWidth: 64, textAlign: 'right',
                        }}>
                          {s.tutar == null ? 'fiyat yok' : fmt(s.tutar)}
                        </span>
                      </div>
                    ))}
                    {h.satirlar.length > 8 && (
                      <div style={{ fontSize: 11, color: R.not3 }}>+{h.satirlar.length - 8} satır daha…</div>
                    )}
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginTop: 14, paddingTop: 12, borderTop: `1px solid ${R.cizgi2}`,
                  }}>
                    <span style={{ fontSize: 12, color: R.not, fontWeight: 600 }}>Toplam malzeme maliyeti</span>
                    <span style={{
                      whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 14, fontWeight: 700,
                      color: h.fiyatsiz ? R.amber : R.krem,
                    }}>
                      {fmt(h.toplam)}{h.fiyatsiz ? ' +?' : ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {receteler.length > 30 && (
          <div style={{ fontSize: 12, color: R.not2, textAlign: 'center', marginBottom: 16 }}>
            İlk 30 reçete gösteriliyor — tamamı Reçete Eşleştirme ekranında ({receteler.length}).
          </div>
        )}
      </>
    );
  }

  // ── YERLİ EŞLEŞTİRME MODALI (her görünümden açılabilir) ───────────────────
  const eslestirmeModali = eslModal && (() => {
    const hepsi = eslListe || [];
    const oneriler = hepsi.filter((r) => r.durum === 'oneri' && r.tip === eslTip);
    const onaylilar = hepsi.filter((r) => r.durum === 'onayli' && r.tip === eslTip);
    const kaynakListe = eslTip === 'urun' ? (adaylar?.recete_urunler || []) : (adaylar?.recete_malzemeler || []);
    const hedefListe = eslTip === 'urun' ? (adaylar?.evo_adlar || []) : (adaylar?.depo_kalemler || []);
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget && !eslMesgul) setEslModal(false); }} style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 680, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>🔗 Reçete Eşleştirme</div>
            <div style={{ fontSize: 11.5, color: R.not2 }}>öneriler onaysız KULLANILMAZ</div>
            <button onClick={() => setEslModal(false)} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>✕</button>
          </div>
          <div style={{ fontSize: 11.5, color: R.not, marginBottom: 14, lineHeight: 1.55 }}>
            Kural: reçetedeki <b>"Ice X"</b> = Evo'daki <b>"X Ice"</b> · sade ad = <b>"X 14 Oz"</b>.
            Eşleşmeyen ürünün satışı tüketim kontrolüne girmez.
          </div>

          <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            {[['urun', '🥤 Ürün ↔ Evo satış'], ['malzeme', '📦 Malzeme ↔ depo']].map(([t, ad]) => (
              <div key={t} onClick={() => setEslTip(t)} style={{
                padding: '7px 14px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${eslTip === t ? R.bakir : R.cizgi3}`,
                color: eslTip === t ? R.bakir : R.metin2,
                background: eslTip === t ? 'rgba(217,154,78,.12)' : 'transparent',
              }}>{ad}</div>
            ))}
            <button disabled={!!eslMesgul} onClick={eslOnerUret} style={{
              marginLeft: 'auto', padding: '7px 13px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.metin2,
              fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
            }}>
              {eslMesgul === 'oner' ? 'Taranıyor…' : '🔍 Öneri üret (Evo katalogunu tara)'}
            </button>
          </div>

          {eslListe == null ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: R.not, fontSize: 13 }}>Yükleniyor…</div>
          ) : (
            <>
              <div style={{ fontSize: 11, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 8 }}>
                Onay bekleyen ({oneriler.length})
              </div>
              {oneriler.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, padding: '10px 0 16px' }}>
                  Bekleyen öneri yok. Yeni ürün eklendiyse "Öneri üret"e bas.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
                  {oneriler.slice(0, 40).map((r) => (
                    <div key={r.id} style={{
                      display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
                      padding: '9px 13px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>
                        <span style={{ color: R.metin2 }}>{r.kaynak_ad}</span>
                        <span style={{ color: R.not2, margin: '0 7px' }}>→</span>
                        <span style={{ fontWeight: 700 }}>{r.hedef_ad}</span>
                        {r.benzerlik != null && (
                          <span style={{ ...rozetHap(r.benzerlik >= 0.99 ? R.yesil : r.benzerlik >= 0.7 ? R.amber : R.kirmizi), marginLeft: 8 }}>
                            %{Math.round(sayi(r.benzerlik) * 100)}
                          </span>
                        )}
                      </div>
                      <button disabled={!!eslMesgul} onClick={() => eslKarar(r.id, 'onayli')} style={{
                        padding: '6px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.yesil}22`, color: R.yesil, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                      }}>{eslMesgul === r.id ? '…' : '✓ Onayla'}</button>
                      <button disabled={!!eslMesgul} onClick={() => eslKarar(r.id, 'reddedildi')} style={{
                        padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                        color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>✗ Reddet</button>
                    </div>
                  ))}
                </div>
              )}

              {/* elle eşleştirme */}
              {elleForm ? (
                <div style={{ padding: '13px 16px', borderRadius: 12, background: R.girinti, border: `1px solid ${R.bakir}44`, marginBottom: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: R.bakir, marginBottom: 11 }}>
                    Elle eşleştir ({eslTip === 'urun' ? 'ürün' : 'malzeme'}) — insan kararı doğrudan onaylıdır
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
                    <div>
                      <label style={mlEtiket}>Reçetedeki ad</label>
                      <select value={elleForm.kaynak_ad} onChange={(e) => setElleForm((f) => ({ ...f, kaynak_ad: e.target.value }))} style={mlAlanStil}>
                        <option value="">Seçin…</option>
                        {kaynakListe.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={mlEtiket}>{eslTip === 'urun' ? 'Evo satış adı' : 'Depo kalemi'}</label>
                      <select
                        value={eslTip === 'urun' ? elleForm.hedef_ad : elleForm.hedef_kod}
                        onChange={(e) => {
                          if (eslTip === 'urun') setElleForm((f) => ({ ...f, hedef_ad: e.target.value, hedef_kod: '' }));
                          else {
                            const k = (hedefListe || []).find((x) => String(x.kalem_kodu) === e.target.value);
                            setElleForm((f) => ({ ...f, hedef_kod: e.target.value, hedef_ad: k?.kalem_adi || '' }));
                          }
                        }}
                        style={mlAlanStil}
                      >
                        <option value="">Seçin…</option>
                        {eslTip === 'urun'
                          ? (hedefListe || []).map((a) => <option key={a} value={a}>{a}</option>)
                          : (hedefListe || []).map((k) => <option key={k.kalem_kodu} value={k.kalem_kodu}>{k.kalem_adi}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 12 }}>
                    <button disabled={!!eslMesgul} onClick={() => setElleForm(null)} style={{
                      padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={!!eslMesgul} onClick={elleEkle} style={{
                      padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>{eslMesgul === 'elle' ? 'Kaydediliyor…' : 'Eşleştir'}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setElleForm({ tip: eslTip, kaynak_ad: '', hedef_ad: '', hedef_kod: '' })} style={{
                  padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600,
                  fontFamily: 'inherit', marginBottom: 14,
                }}>
                  ✍️ Elle eşleştir (öneri yoksa)
                </button>
              )}

              <div style={{ fontSize: 11, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 8 }}>
                Onaylı eşleşmeler ({onaylilar.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 200, overflowY: 'auto' }}>
                {onaylilar.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: R.not }}>Henüz onaylı eşleşme yok.</div>
                ) : onaylilar.slice(0, 60).map((r) => (
                  <div key={r.id} style={{ fontSize: 12, color: R.metin2, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: R.yesil }}>✓</span>
                    <span style={{ color: R.not }}>{r.kaynak_ad}</span>
                    <span style={{ color: R.not2 }}>→</span>
                    <span>{r.hedef_ad}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  })();

  // ════════════════════════ GÖRÜNÜM: TÜKETİM KONTROLÜ ═══════════════════════
  // Sahip isteği (2026-07-28): "satışın verisine göre maliyet — bara giren ürün
  // açılımını takip edip fazla kullanımı saptayalım." Motor zaten kuruluydu
  // (recete_api.kontrol): BEKLENEN = Evo satış × reçete, GERÇEK = ürün-aç defteri
  // × ambalaj içeriği (bar sayımlı malzemede devir-bilinçli). Burada yalnız
  // TASARIMA getirildi — öneri-only: hiçbir yazma yok, hüküm insanın.
  if (gorunum === 'tuketim') {
    if (kontrolHata) return <HataBandi mesaj={kontrolHata} onTekrar={kontrolYukle} />;
    if (!kontrol) return <Yukleniyor />;

    // Eşleştirme henüz kurulmamışsa dürüst boş durum + köprü
    if (kontrol.durum === 'eslestirme_bekliyor') {
      return (
        <>
          <KpiSeridi kpiler={[
            { etiket: 'Onaylı ürün eşleşmesi', deger: String(sayi(kontrol.onayli_urun)), alt: 'reçete ↔ Evo satış adı', renk: R.amber },
            { etiket: 'Onaylı malzeme', deger: String(sayi(kontrol.onayli_malzeme)), alt: 'reçete ↔ depo kalemi', renk: R.amber },
            { etiket: 'Bekleyen öneri', deger: String(sayi(kontrol.bekleyen_oneri)), alt: 'onayını bekliyor', renk: R.kirmizi },
            { etiket: 'Durum', deger: 'kurulum', alt: 'eşleştirme tamamlanmalı' },
          ]} />
          <div style={{ ...kartYuzey, padding: '30px 26px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600 }}>
              Kontrol için eşleştirme onayı gerekiyor
            </div>
            <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6, maxWidth: 520, margin: '8px auto 0' }}>
              Satış × reçete karşılaştırması, reçete adlarının Evo satış adlarıyla ve
              malzemelerin depo kalemleriyle eşleşmesini ister. {sayi(kontrol.bekleyen_oneri)} öneri onay bekliyor.
            </div>
            <button
              onClick={() => eslAc()}
              style={{
                marginTop: 16, padding: '10px 18px', borderRadius: 11, border: 'none',
                background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              Eşleştirme onayına git
            </button>
          </div>
          {eslestirmeModali}
        </>
      );
    }

    const kiyas = Array.isArray(kontrol.kiyas) ? kontrol.kiyas : [];
    // Malzeme bazında grupla
    const gruplar = {};
    kiyas.forEach((s) => {
      const k = `${s.malzeme}|${s.birim}`;
      (gruplar[k] = gruplar[k] || { malzeme: s.malzeme, birim: s.birim, gunler: [] }).gunler.push(s);
    });
    const netFark = (s) => s.fark_fire_sonrasi ?? s.fark;
    const netYuzde = (s) => s.fark_yuzde_fire_sonrasi ?? s.fark_yuzde;
    const grupListe = Object.values(gruplar).map((g) => {
      const olculen = g.gunler.filter((s) => netFark(s) != null);
      const fazla = olculen.filter((s) => (netYuzde(s) ?? 0) >= 15);
      // KALICI TEK YÖNLÜ fark = insanın bakacağı yer (motorun kendi notu):
      // ölçülen ≥3 gün ve hepsi aynı yönde ve ortalama %10'u aşıyor
      const ort = olculen.length
        ? olculen.reduce((t, s) => t + (netYuzde(s) ?? 0), 0) / olculen.length : 0;
      const kalici = olculen.length >= 3
        && (olculen.every((s) => netFark(s) > 0) || olculen.every((s) => netFark(s) < 0))
        && Math.abs(ort) >= 10;
      return { ...g, olculen, fazla, ort, kalici };
    }).sort((a, b) => b.fazla.length - a.fazla.length || Math.abs(b.ort) - Math.abs(a.ort));
    const toplamFazla = grupListe.reduce((t, g) => t + g.fazla.length, 0);
    const enSert = kiyas.reduce((m, s) => Math.max(m, netYuzde(s) ?? -Infinity), -Infinity);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen malzeme', deger: String(grupListe.length), alt: `son ${sayi(kontrol.kesit_gun)} gün · onaylı eşleşme` },
          { etiket: 'Fazla kullanım', deger: String(toplamFazla), alt: 'beklenenden %15+ fazla (gün×malzeme)', renk: toplamFazla > 0 ? R.kirmizi : R.yesil },
          { etiket: 'En sert sapma', deger: Number.isFinite(enSert) ? `+${pct(enSert).slice(1)}` : '—', alt: 'tek günde', renk: Number.isFinite(enSert) && enSert >= 15 ? R.kirmizi : R.krem },
          { etiket: 'Eşleşme', deger: `${sayi(kontrol.onayli_urun_es)} ürün · ${sayi(kontrol.onayli_malzeme_es)} malzeme`, alt: 'onaylı köprüler' },
        ]} />

        {/* Öneri-only ilkesi ekranda (desen 8) — motorun kendi cümlesi */}
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ gözlem</span>
          Beklenen = Evo satış × reçete · Gerçek = bara açılan ürün (devir bilinçli).
          Fark ± fire/işçilik payı normaldir — <b style={{ color: R.metin2 }}>KALICI ve TEK YÖNLÜ fark</b> insanın
          bakacağı yerdir. Bu ekran hüküm vermez, stok akışına dokunmaz.
        </div>

        {grupListe.length === 0 ? (
          <BosDurum metin="Kıyaslanabilir gün yok — satış verisi ve ürün-aç kaydı biriktikçe bu ekran dolar." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16 }}>
            {grupListe.map((g) => (
              <div key={`${g.malzeme}|${g.birim}`} style={{
                ...kartYuzey, padding: '16px 18px',
                border: g.kalici ? `1px solid ${g.ort > 0 ? R.kirmizi : R.amber}55` : kartYuzey.border,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10, flexWrap: 'wrap',
                }}>
                  <div>
                    <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>
                      {g.malzeme}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>
                      {g.olculen.length}/{g.gunler.length} gün ölçülebildi · birim {g.birim}
                    </div>
                  </div>
                  {g.kalici ? (
                    <span style={rozetHap(g.ort > 0 ? R.kirmizi : R.amber)}>
                      ⚠ kalıcı {g.ort > 0 ? 'fazla kullanım' : 'eksik açılış'} · ort {g.ort > 0 ? '+' : ''}{Math.round(g.ort)}%
                    </span>
                  ) : g.fazla.length > 0 ? (
                    <span style={rozetHap(R.amber)}>{g.fazla.length} gün fazla</span>
                  ) : g.olculen.length > 0 ? (
                    <span style={rozetHap(R.yesil)}>✓ uyumlu</span>
                  ) : (
                    <span style={rozetHap(R.not2)}>ölçülemedi</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.gunler.slice(-7).map((s, i) => {
                    const f = netFark(s); const y = netYuzde(s);
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
                        <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2, minWidth: 46 }}>{tarihKisa(s.gun)}</span>
                        <span style={{ color: R.metin2 }}>beklenen <b style={{ fontFamily: F.mono }}>{s.beklenen_miktar}</b></span>
                        <span style={{ flex: 1, height: 1, background: R.cizgi2 }} />
                        {f == null ? (
                          <span style={{ fontSize: 10.5, color: R.not3 }}>
                            {s.eksik === 'bar_sayim_yok' ? 'bar sayımı yok'
                              : s.eksik === 'ambalaj_icerigi_tanimsiz' ? 'ambalaj tanımsız'
                              : s.eksik === 'urun_ac_kaydi_yok' ? 'ürün-aç kaydı yok' : 'ölçülemedi'}
                          </span>
                        ) : (
                          <>
                            <span style={{ color: R.metin2 }}>gerçek <b style={{ fontFamily: F.mono }}>{s.gercek_miktar}</b></span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, fontWeight: 700, minWidth: 58, textAlign: 'right',
                              color: (y ?? 0) >= 15 ? R.kirmizi : (y ?? 0) <= -15 ? R.amber : R.yesil,
                            }}>
                              {f > 0 ? '+' : ''}{f}{y != null ? ` (%${Math.round(y)})` : ''}
                            </span>
                            {s.bildirilen_fire ? (
                              <span style={{ fontSize: 9.5, color: R.not2 }} title="bildirilen fire düşüldü">🗑 {s.bildirilen_fire}</span>
                            ) : null}
                            {s.kapanis_gecici && <span style={{ fontSize: 9.5, color: R.not3 }}>geçici</span>}
                            {s.ambalaj_varsayim && <span style={{ fontSize: 9.5, color: R.amber }} title="ambalaj içeriği varsayım — teyit bekliyor">≈</span>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            onClick={() => eslAc()}
            style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Reçete & eşleştirme yönetimi
          </button>
          <button
            onClick={() => onKopru?.('__modul:denetim:duyu')}
            style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Duyu Paneli'nde geçmiş bulgular
          </button>
        </div>
        {eslestirmeModali}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FİYAT ZİNCİRİ ══════════════════════════
  if (gorunum === 'fiyat') {
    if (alarmHata) return <HataBandi mesaj={alarmHata} onTekrar={alarmYukle} />;
    if (alarmlar == null) return <Yukleniyor />;
    const yeni = alarmlar.filter((a) => !a.goruldu);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Eşik üstü artış', deger: String(alarmlar.length), alt: `son 180 gün · eşik %${esik}`, renk: alarmlar.length > 0 ? R.amber : R.yesil },
          { etiket: 'İncelenmemiş', deger: String(yeni.length), alt: 'gördüm işareti bekliyor', renk: yeni.length > 0 ? R.kirmizi : R.yesil },
          { etiket: 'En sert artış', deger: alarmlar.length ? pct(Math.max(...alarmlar.map((a) => sayi(a.artis_yuzde)))) : '—', alt: 'tek kalemde', renk: R.kirmizi },
          { etiket: 'Kaynak', deger: 'onaylı fiyat', alt: 'OCR değil — öneri-only ilkesi' },
        ]} />
        {alarmlar.length === 0 ? (
          <BosDurum metin={`Son 180 günde %${esik} eşiğini aşan fiyat artışı yok — tedarik fiyatları sakin.`} />
        ) : (
          <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 16,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>Fiyat zinciri</span>
              <span style={{ fontSize: 11, color: R.not2 }}>her değişiklik kim/ne zaman/etki ile kayıtlı</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {alarmlar.slice(0, 25).map((a) => {
                const artis = sayi(a.artis_yuzde);
                return (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span style={{
                        width: 10, height: 10, borderRadius: 99, marginTop: 4,
                        background: artis >= esik * 2 ? R.kirmizi : R.amber,
                        boxShadow: a.goruldu ? 'none' : `0 0 8px ${artis >= esik * 2 ? R.kirmizi : R.amber}`,
                      }} />
                      <span style={{ flex: 1, width: 1, background: R.cizgi2 }} />
                    </div>
                    <div style={{ paddingBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{a.kalem_adi || a.kalem_kodu}</span>
                        <span style={{
                          ...rozetHap(artis >= esik * 2 ? R.kirmizi : R.amber),
                          fontFamily: F.mono,
                        }}>
                          {sayi(a.eski_fiyat).toLocaleString('tr-TR')} → {sayi(a.yeni_fiyat).toLocaleString('tr-TR')} ₺ · +{pct(artis).slice(1)}
                        </span>
                        <span style={{ fontSize: 11, color: R.not2 }}>{a.olusturma} · {a.tedarikci}</span>
                        {!a.goruldu && (
                          <button
                            onClick={async () => {
                              try {
                                await api('/ops/fiyat-zam-alarmlari/goruldu', { method: 'POST', body: { id: a.id } });
                                onToast?.('✓ İncelendi olarak işaretlendi');
                                alarmYukle();
                              } catch (e) { onToast?.(e?.message || 'İşaretlenemedi'); }
                            }}
                            style={{
                              padding: '3px 11px', borderRadius: 99, border: `1px solid ${R.cizgi3}`,
                              background: R.girinti, color: R.metin2, fontSize: 10.5, fontWeight: 700,
                              fontFamily: 'inherit', cursor: 'pointer',
                            }}
                          >
                            gördüm
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: R.metin2, marginTop: 4, lineHeight: 1.55 }}>
                        {artis >= esik * 2
                          ? 'Sert artış — bu kalemi kullanan reçetelerin maliyeti belirgin yükselir; menü fiyatı kararı gerekebilir.'
                          : 'Eşik üstü artış — reçete maliyetlerine yansır, izlemeye değer.'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
