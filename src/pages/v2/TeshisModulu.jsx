// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Para Zinciri Teşhisi (2026-08-08)
//
// Tasarım: ICERIK → denetim.parazinciri
//
// NEDEN VAR: fatura → borç → ödeme → cari zincirinin sağlığını ölçen yedi ayrı
// teşhis ucu vardı ve hiçbiri ekranda görünmüyordu. "Bu fatura neden borç
// listemde yok?", "bu ödeme gerçekten bu tedarikçiye mi gitti?", "iki katman
// birbirini tutuyor mu?" sorularının cevabı yalnız API'de yaşıyordu.
//
// SALT-OKUR: hüküm vermez, hiçbir şey yazmaz. Ham gerçeği gösterir.
// Veri uçları: /fatura/para-zinciri-rontgen · /kuyruk-bosluk-teshisi
//              /odenmis-sayilan-denetimi · /odeme-katmani-kiyas
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo } from './parcalar';

const sayi = (v) => Number(v) || 0;
const kisaTarih = (s) => (s ? String(s).slice(0, 10).split('-').reverse().slice(0, 2).join('.') : '—');

export default function TeshisModulu({ onCekmece }) {
  const [rontgen, setRontgen] = useState(null);
  const [kuyruk, setKuyruk] = useState(null);
  const [odenmis, setOdenmis] = useState(null);
  const [kiyas, setKiyas] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);

  useEffect(() => {
    setYukleniyor(true);
    Promise.all([
      api('/fatura/para-zinciri-rontgen').catch(() => null),
      api('/fatura/kuyruk-bosluk-teshisi').catch(() => null),
      api('/fatura/odenmis-sayilan-denetimi').catch(() => null),
      api('/fatura/odeme-katmani-kiyas').catch(() => null),
    ]).then(([r, k, o, ky]) => {
      setRontgen(r); setKuyruk(k); setOdenmis(o); setKiyas(ky);
    }).finally(() => setYukleniyor(false));
  }, []);

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: 28, textAlign: 'center', color: R.not2 }}>
      Para zinciri taranıyor… (dört ayrı teşhis)
    </div>;
  }

  const kayip = rontgen?.kayip_borc_eski_kismi || {};
  const fren = rontgen?.kart_plan_tekillik_freni || {};
  const riskli = sayi(odenmis?.riskli_tutar);
  const kiyasFark = sayi(kiyas?.toplam_kanonik) - sayi(kiyas?.toplam_mevcut);

  return (
    <>
      <KpiSeridi kpiler={[
        {
          etiket: 'Borç dışı belirsiz', deger: fmt(sayi(kuyruk?.borc_disi_toplam)),
          alt: 'fatura var, borç listesinde yok',
          renk: sayi(kuyruk?.borc_disi_toplam) > 0 ? R.amber : R.yesil,
        },
        {
          etiket: 'Şüpheli "ödendi"', deger: fmt(riskli),
          alt: `${sayi(odenmis?.damgali_fatura)} damgalı fatura incelendi`,
          renk: riskli > 0 ? R.kirmizi : R.yesil,
        },
        {
          etiket: 'Kayıp borç', deger: fmt(sayi(kayip.kayip_tutar)),
          alt: `${sayi(kayip.satir)} satır · kart dışı`,
          renk: sayi(kayip.kayip_tutar) > 0 ? R.amber : R.yesil,
        },
        {
          etiket: 'İki katman farkı', deger: fmt(Math.abs(kiyasFark)),
          alt: kiyasFark === 0 ? 'kanonik = cari ✓' : `${sayi(kiyas?.farkli_tedarikci)} tedarikçide sapma`,
          renk: kiyasFark === 0 ? R.yesil : R.kirmizi,
        },
      ]} />

      {/* SAĞLIK ŞERİDİ */}
      <div style={{ ...kartYuzey, padding: '11px 15px', marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: R.krem, marginBottom: 8 }}>
          🩺 Zincir sağlığı
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { ad: 'Kart planı tekillik freni', ok: !!fren.index_kurulu,
              detay: fren.index_kurulu ? 'kurulu — mükerrer dönem açılamaz' : 'KURULMAMIŞ' },
            { ad: 'Mükerrer dönem ihlali', ok: sayi(fren.ihlal_grubu) === 0,
              detay: `${sayi(fren.ihlal_grubu)} grup` },
            { ad: 'Referanssız kart planı', ok: sayi(fren.referanssiz_kart_plani) === 0,
              detay: `${sayi(fren.referanssiz_kart_plani)} satır` },
            { ad: 'Mükerrer fatura', ok: sayi(rontgen?.mukerrer_plan_ozet?.grup) === 0,
              detay: `${sayi(rontgen?.mukerrer_plan_ozet?.grup)} grup` },
            { ad: 'Kanonik katman ↔ cari', ok: kiyasFark === 0,
              detay: kiyasFark === 0 ? 'birebir aynı' : fmt(Math.abs(kiyasFark)) },
          ].map((x) => (
            <div key={x.ad} style={{
              flex: '1 1 170px', minWidth: 160, padding: '8px 10px', borderRadius: 9,
              background: R.girinti, border: `1px solid ${x.ok ? R.cizgi : R.kirmizi}`,
              borderLeft: `3px solid ${x.ok ? R.yesil : R.kirmizi}`,
            }}>
              <div style={{ fontSize: 11, color: R.metin2 }}>{x.ok ? '✓' : '⚠'} {x.ad}</div>
              <div style={{ fontSize: 11, color: x.ok ? R.not2 : R.kirmizi, marginTop: 3 }}>{x.detay}</div>
            </div>
          ))}
        </div>
      </div>

      {/* FATURA → BORÇ KUYRUĞU KIRILIMI */}
      {(kuyruk?.kirilim || []).length > 0 && (
        <Tablo
          baslik="Fatura → borç kuyruğu"
          not="her faturanın borç listesine girip girmediği ve sebebi"
          kolonlar={[{ ad: 'Durum' }, { ad: 'Adet', sag: true }, { ad: 'Tutar', sag: true }]}
          satirlar={(kuyruk.kirilim || []).map((x) => ({
            id: x.sebep,
            hucreler: [
              { v: x.aciklama || x.sebep },
              { v: String(sayi(x.adet)), mono: true, sag: true },
              {
                v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true,
                renk: String(x.sebep).startsWith('borca') ? R.yesil : R.amber,
              },
            ],
          }))}
        />
      )}

      {/* ŞÜPHELİ "ÖDENDİ" DAMGALARI */}
      {(odenmis?.satirlar || []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Tablo
            baslik='"Ödendi" sayılan faturaların denetimi'
            not="ödeme izi gerçekten o tedarikçiye mi ait?"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Tedarikçi' }, { ad: 'Tutar', sag: true },
              { ad: 'Durum' }, { ad: 'Ne demek' },
            ]}
            satirlar={(odenmis.satirlar || []).slice(0, 20).map((x) => ({
              id: x.fatura_id,
              hucreler: [
                { v: kisaTarih(x.tarih), mono: true },
                { v: (x.tedarikci || '—').slice(0, 26) },
                { v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true },
                {
                  v: x.hal === 'iz_uyusuyor' ? 'iz uyuşuyor'
                    : x.hal === 'mukerrer_kayit' ? 'mükerrer'
                      : x.hal === 'iz_tekil_degil' ? 'iz paylaşımlı' : 'başka ödeme?',
                  rozet: x.hal === 'iz_uyusuyor' ? R.yesil : R.kirmizi,
                },
                { v: (x.ne_demek || '').slice(0, 60) },
              ],
            }))}
          />
        </div>
      )}

      {/* KANONİK KATMAN KIYASI */}
      {(kiyas?.kiyas || []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Tablo
            baslik="Kanonik ödeme katmanı ↔ cari hesap"
            not="iki katman aynı gerçeği mi üretiyor? (fark 0 olmalı)"
            kolonlar={[
              { ad: 'Tedarikçi' }, { ad: 'Cari hesap', sag: true },
              { ad: 'Kanonik katman', sag: true }, { ad: 'Fark', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={(kiyas.kiyas || []).map((x) => ({
              id: x.tedarikci,
              hucreler: [
                { v: (x.tedarikci || '').slice(0, 26), kalin: true },
                { v: fmt(sayi(x.mevcut_odeme_izi)), mono: true, sag: true },
                { v: fmt(sayi(x.kanonik_katman)), mono: true, sag: true },
                {
                  v: fmt(sayi(x.fark)), mono: true, sag: true,
                  renk: Math.abs(sayi(x.fark)) < 0.5 ? R.not : R.kirmizi,
                },
                {
                  v: x.durum, rozet: x.durum === 'eşit' ? R.yesil : R.kirmizi,
                },
              ],
            }))}
          />
        </div>
      )}

      <div style={{ ...kartYuzey, padding: '10px 15px', marginTop: 12 }}>
        <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.65 }}>
          Bu ekran <b>hüküm vermez</b>, ham gerçeği gösterir. Rakamlar canlı tablolardan
          okunur; hiçbir şey yazılmaz. Bir satır yanlış görünüyorsa sebebi burada değil,
          onu üreten akıştadır.
        </div>
      </div>
    </>
  );
}
