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

  useEffect(() => {
    if (gorunum === 'ozet') ozetYukle();
    if (gorunum === 'urun' || gorunum === 'recete') receteYukle();
    if (gorunum === 'fiyat') alarmYukle();
  }, [gorunum, ozetYukle, receteYukle, alarmYukle]);

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
              _hedef: 'maliyet',
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
