// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Kart İzi Eşleştirme (2026-08-08)
//
// Tasarım: ICERIK → odeme.eslesme
//
// NEDEN VAR: otomatik eşleştirme motoru güven skoruna göre "%55–95 arası sahip
// onaylasın" diyordu ama ONAYLAYACAK EKRAN YOKTU. Sistem aday üretiyor, kimse
// göremiyor; onay olmadan öğrenme bileşeni beslenmiyor, hiçbir şey
// otomatikleşemiyor — döngü kapalı kalıyordu. Bu ekran döngüyü açar.
//
// ⚠️ TEK YAZICI: bu modül kendi defterini yazmaz. Onay/ret/geri-al mevcut
// guard'lı uçlara delege eder (/fatura/kart-izi-onayla · /kart-izi-geri-al);
// karar defteri (append-only) orada yazılır.
//
// Veri uçları:
//   /fatura/kart-izi-otomatik-tara?uygula=0  → güven skorlu aday listesi
//   /fatura/kart-borc-izi?gun=N              → tedarikçi × ham kart satırı
//   /fatura/eslesme-karar-defteri            → kim ne zaman bağladı (iz)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, OnayModali } from './parcalar';

const sayi = (v) => Number(v) || 0;
const yuzde = (v) => `%${((Number(v) || 0) * 100).toFixed(0)}`;
const kisaTarih = (s) => (s ? String(s).slice(0, 10).split('-').reverse().slice(0, 2).join('.') : '—');

export default function EslesmeModulu({ gorunum, onCekmece, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [tara, setTara] = useState(null);      // otomatik tarama sonucu
  const [izler, setIzler] = useState(null);    // tedarikçi × kart satırı
  const [defter, setDefter] = useState(null);  // karar geçmişi
  const [secim, setSecim] = useState({});      // {hareket_id: tedarikci}
  const [modal, setModal] = useState(null);
  const [mesgul, setMesgul] = useState(false);

  const yukle = React.useCallback(() => {
    setYukleniyor(true); setHata('');
    Promise.all([
      api('/fatura/kart-izi-otomatik-tara?uygula=0', { method: 'POST' }).catch(() => null),
      api('/fatura/kart-borc-izi?gun=400').catch(() => null),
      api('/fatura/eslesme-karar-defteri?limit=60').catch(() => null),
    ]).then(([t, i, d]) => {
      setTara(t); setIzler(i); setDefter(d);
    }).catch((e) => setHata(String(e?.message || e)))
      .finally(() => setYukleniyor(false));
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  // Aday havuzu: otomatik taramanın "sahip onayı bekleyen"leri + iz listesi
  const adaylar = useMemo(() => {
    const a = (tara?.adaylar || []).map((x) => ({
      hareketId: x.hareket_id, tedarikci: x.tedarikci, tutar: sayi(x.tutar),
      tarih: x.tarih, aciklama: x.aciklama, guven: sayi(x.guven),
      gerekce: x.gerekce, dokum: x.dokum, acik: sayi(x.acik_bakiye),
      kaynak: 'skor',
    }));
    const varOlan = new Set(a.map((x) => x.hareketId));
    (izler?.satirlar || []).forEach((s) => {
      (s.izler || []).forEach((i) => {
        if (i.durum === 'aday' && !varOlan.has(i.hareket_id)) {
          a.push({
            hareketId: i.hareket_id, tedarikci: s.tedarikci, tutar: sayi(i.tutar),
            tarih: i.tarih, aciklama: i.aciklama, guven: 0, gerekce: 'ad eşleşmesi',
            acik: sayi(s.acik_bakiye), kaynak: 'ad',
          });
        }
      });
    });
    return a.sort((x, y) => y.guven - x.guven);
  }, [tara, izler]);

  const secili = Object.keys(secim).filter((k) => secim[k]);
  const seciliTutar = adaylar.filter((a) => secim[a.hareketId]).reduce((t, a) => t + a.tutar, 0);

  const uygula = async (tedarikci, idler, geriAl = false) => {
    if (!idler.length) return;
    setMesgul(true);
    try {
      const yol = geriAl ? '/fatura/kart-izi-geri-al' : '/fatura/kart-izi-onayla';
      const r = await api(yol, {
        method: 'POST',
        body: { tedarikci, hareket_idler: idler, aktor: 'sahip', dayanak: 'ekrandan onay' },
      });
      onToast?.(geriAl
        ? `↩ ${r?.geri_alinan || idler.length} bağ geri alındı`
        : `✓ ${r?.damgalanan || idler.length} çekim ${tedarikci} borcuna bağlandı`);
      setSecim({}); setModal(null); yukle();
    } catch (e) {
      onToast?.(`✕ ${String(e?.message || e)}`);
    } finally { setMesgul(false); }
  };

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: 28, textAlign: 'center', color: R.not2 }}>
      Eşleşme adayları taranıyor…
    </div>;
  }
  if (hata) {
    return <div style={{ ...kartYuzey, padding: 20, borderLeft: `3px solid ${R.kirmizi}` }}>
      <div style={{ color: R.kirmizi, fontWeight: 700, marginBottom: 6 }}>Tarama okunamadı</div>
      <div style={{ color: R.not2, fontSize: 12.5 }}>{hata}</div>
    </div>;
  }

  // ── KARAR DEFTERİ görünümü ────────────────────────────────────────────────
  if (gorunum === 'defter') {
    const k = defter?.kayitlar || [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam karar', deger: String(sayi(defter?.ozet?.toplam)), alt: 'append-only — silinmez' },
          { etiket: 'Bağlanan', deger: String(sayi(defter?.ozet?.bagla)), alt: 'tedarikçi borcuna', renk: R.yesil },
          { etiket: 'İlgisiz denilen', deger: String(sayi(defter?.ozet?.reddet)), alt: 'bizim ödememiz değil', renk: R.not },
          { etiket: 'Geri alınan', deger: String(sayi(defter?.ozet?.geri_al)), alt: 'karar düzeltmesi', renk: R.amber },
        ]} />
        {k.length ? (
          <Tablo
            baslik="Eşleşme karar defteri"
            not="append-only — hiçbir satır silinmez, düzeltme yeni satırdır"
            kolonlar={[
              { ad: 'Zaman' }, { ad: 'Karar' }, { ad: 'Önceki' }, { ad: 'Yeni' },
              { ad: 'Tutar', sag: true }, { ad: 'Kim' }, { ad: 'Dayanak' },
            ]}
            satirlar={k.map((x) => ({
              id: x.id,
              hucreler: [
                { v: String(x.ts || '').slice(0, 16).replace('T', ' '), mono: true },
                {
                  v: x.karar === 'bagla' ? 'bağladı' : x.karar === 'reddet' ? 'ilgisiz' : 'geri aldı',
                  rozet: x.karar === 'bagla' ? R.yesil : x.karar === 'reddet' ? R.not : R.amber,
                },
                { v: x.onceki_deger || '—' },
                { v: x.yeni_deger, kalin: true },
                { v: fmt(sayi(x.tutar)), mono: true, sag: true },
                { v: x.aktor === 'sistem' ? '🤖 sistem' : `👤 ${x.aktor}` },
                { v: (x.dayanak || '—').slice(0, 46) },
              ],
            }))}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: 26, textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, color: R.metin2 }}>Henüz karar yok</div>
            <div style={{ fontSize: 12.5, color: R.not2, marginTop: 6 }}>
              Bir çekimi tedarikçiye bağladığında burada iz kalır.
            </div>
          </div>
        )}
      </>
    );
  }

  // ── EŞLEŞME görünümü (varsayılan) ─────────────────────────────────────────
  const otoAdet = sayi(tara?.otomatik_baglanan);
  const izsizler = izler?.iz_bulunamayan || [];
  return (
    <>
      <KpiSeridi kpiler={[
        {
          etiket: 'Onayını bekleyen', deger: String(adaylar.length),
          alt: adaylar.length ? `${fmt(adaylar.reduce((t, a) => t + a.tutar, 0))} tutarında` : 'temiz',
          renk: adaylar.length ? R.amber : R.yesil,
        },
        {
          etiket: 'Sistem bağladı', deger: String(otoAdet),
          alt: otoAdet ? `${fmt(sayi(tara?.otomatik_tutar))} · %95+ güven` : 'öğrenme bekliyor',
          renk: R.yesil,
        },
        {
          etiket: 'Borcu var, izi yok', deger: String(izsizler.length),
          alt: 'kartta karşılığı bulunamadı', renk: izsizler.length ? R.not : R.yesil,
        },
        {
          etiket: 'Taranan kart satırı', deger: String(sayi(izler?.taranan_kart_hareketi)),
          alt: `${sayi(izler?.borclu_tedarikci)} borçlu tedarikçi`, renk: R.krem,
        },
      ]} />

      {/* NASIL ÇALIŞIR — sahip bunu ilk kez görüyor olabilir */}
      <div style={{ ...kartYuzey, padding: '11px 15px', marginBottom: 12, borderLeft: `3px solid ${R.bakir}` }}>
        <div style={{ fontSize: 12.5, color: R.krem, fontWeight: 700, marginBottom: 5 }}>
          🔗 Bu ekran ne yapar?
        </div>
        <div style={{ fontSize: 12, color: R.metin2, lineHeight: 1.65 }}>
          Kart ekstresindeki bir çekimin hangi tedarikçinin borcuna ait olduğunu işaretlersin.
          Sistem <b>yeni ödeme kaydı açmaz</b> — sadece bağ kurar, borç cari hesaptan düşer.
          Yanlış bağ para yaratmaz/yok etmez, tek tıkla geri alınır.
          <b style={{ color: R.bakir }}> Onayladığın her kalıbı sistem öğrenir</b>; aynısı bir daha
          gelirse kendi bağlar.
        </div>
      </div>

      {secili.length > 0 && (
        <div style={{
          ...kartYuzey, padding: '10px 14px', marginBottom: 12,
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          borderLeft: `3px solid ${R.bakir}`,
        }}>
          <span style={{ fontSize: 12.5, color: R.krem, fontWeight: 700 }}>
            {secili.length} çekim seçili · <span style={{ fontFamily: F.mono }}>{fmt(seciliTutar)}</span>
          </span>
          <button
            onClick={() => {
              const ilk = adaylar.find((a) => secim[a.hareketId]);
              const hepsiAyni = adaylar.filter((a) => secim[a.hareketId])
                .every((a) => a.tedarikci === ilk?.tedarikci);
              if (!hepsiAyni) { onToast?.('✕ Farklı tedarikçiler seçili — tek tedarikçi seç'); return; }
              setModal({ tip: 'onay', tedarikci: ilk.tedarikci, idler: secili, tutar: seciliTutar });
            }}
            style={{
              padding: '7px 15px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: R.bakir, color: '#1A1209', fontWeight: 700, fontSize: 12.5,
            }}
          >✓ Seçilenleri bağla</button>
          <button
            onClick={() => setModal({ tip: 'ilgisiz', idler: secili, tutar: seciliTutar })}
            style={{
              padding: '7px 15px', borderRadius: 8, cursor: 'pointer',
              background: 'transparent', color: R.metin2,
              border: `1px solid ${R.cizgi3}`, fontSize: 12.5,
            }}
          >✕ Bizim ödememiz değil</button>
          <button onClick={() => setSecim({})}
            style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
              background: 'transparent', color: R.not, border: `1px solid ${R.cizgi}`, fontSize: 12 }}
          >temizle</button>
        </div>
      )}

      {adaylar.length ? (
        <Tablo
          baslik="Onayını bekleyen eşleşmeler"
          not="satırı seç → bağla; sistem öğrenir, sonrakini kendi yapar"
          kolonlar={[
            { ad: '' }, { ad: 'Tarih' }, { ad: 'Kart ekstresi satırı' },
            { ad: 'Tutar', sag: true }, { ad: 'Tedarikçi' },
            { ad: 'Açık borç', sag: true }, { ad: 'Güven' },
          ]}
          satirlar={adaylar.map((a) => ({
            id: a.hareketId, _a: a,
            hucreler: [
              { v: secim[a.hareketId] ? '☑' : '☐' },
              { v: kisaTarih(a.tarih), mono: true },
              { v: a.aciklama || '—' },
              { v: fmt(a.tutar), mono: true, sag: true, kalin: true },
              { v: a.tedarikci, kalin: true },
              { v: fmt(a.acik), mono: true, sag: true, renk: R.not2 },
              {
                v: a.guven ? yuzde(a.guven) : 'ad',
                rozet: a.guven >= 0.8 ? R.yesil : a.guven >= 0.6 ? R.amber : R.not,
              },
            ],
          }))}
          onSatir={(s) => {
            const a = s._a;
            setSecim((o) => ({ ...o, [a.hareketId]: o[a.hareketId] ? null : a.tedarikci }));
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: 30, textAlign: 'center' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, color: R.yesil }}>Onay bekleyen eşleşme yok</div>
          <div style={{ fontSize: 12.5, color: R.not2, marginTop: 7, lineHeight: 1.6 }}>
            Kart ekstresindeki çekimlerle açık tedarikçi borçları arasında
            değerlendirilecek aday bulunamadı. Yeni ekstre yüklediğinde tarama
            kendiliğinden çalışır.
          </div>
        </div>
      )}

      {izsizler.length > 0 && (
        <div style={{ ...kartYuzey, padding: '12px 16px', marginTop: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: R.krem, marginBottom: 8 }}>
            Borcu var ama kartta izi yok — {izsizler.length} tedarikçi
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {izsizler.slice(0, 12).map((z) => (
              <div key={z.tedarikci} style={{
                padding: '6px 10px', borderRadius: 8, background: R.girinti,
                border: `1px solid ${R.cizgi}`, fontSize: 11.5, color: R.metin2,
              }}>
                {z.tedarikci} · <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(z.acik_bakiye))}</b>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: R.not2, marginTop: 8 }}>
            Nakitten ödenmiş, henüz ödenmemiş ya da kart açıklaması tedarikçi adını taşımıyor olabilir.
          </div>
        </div>
      )}

      {modal && (
        <OnayModali
          acik
          baslik={modal.tip === 'onay' ? 'Çekimleri borca bağla' : 'İlgisiz olarak işaretle'}
          altBaslik={modal.tip === 'onay'
            ? `${modal.idler.length} kart çekimi "${modal.tedarikci}" borcuna bağlanacak. Yeni ödeme kaydı AÇILMAZ — borç cari hesaptan düşer. Bu kalıbı sistem öğrenir, sonrakini kendi bağlar.`
            : `${modal.idler.length} çekim hiçbir tedarikçiye ait sayılmayacak ve bir daha aday gösterilmeyecek.`}
          tutar={fmt(modal.tutar)}
          not={modal.tip === 'onay'
            ? 'Yanlış bağ para yaratmaz/yok etmez — tek tıkla geri alınır, karar defterine iz düşer.'
            : 'Karar defterine yazılır; gerekirse geri alınabilir.'}
          onaylaAd={modal.tip === 'onay' ? 'Bağla' : 'İlgisiz say'}
          calisiyor={mesgul}
          onKapat={() => setModal(null)}
          onOnayla={() => uygula(modal.tip === 'onay' ? modal.tedarikci : '(ilgisiz)', modal.idler)}
        />
      )}
    </>
  );
}
