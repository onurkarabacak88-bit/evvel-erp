// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Vergi Etkisi (2026-08-08)
//
// Tasarım: ICERIK → belge.vergi
//
// SAHİP SORUSU: "kart harcamalarında işletme mi şahsi mi diye ayrıştırıyoruz;
// işletme için olanların faturaları var mı yok mu diye sorulmalı. Fatura varsa
// vergiden düşümde gider olarak sayılmalı ki ödenecek vergiyi daha net
// belirlemiş oluruz — hem KDV hem gelir vergisinden düşümler olur."
//
// Bu ekran o soruyu tek bakışta cevaplar: hangi harcamanın belgesi var, hangi
// belgesiz kalan yüzünden ne kadar vergi avantajı kullanılamıyor.
//
// SALT-OKUR: hiçbir yazma yok. Kovalara tıklayınca çekmece açılır.
// Veri ucu: /fatura/kart-vergi-etkisi?gun=365
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo } from './parcalar';

const sayi = (v) => Number(v) || 0;
const kisaTarih = (s) => (s ? String(s).slice(0, 10).split('-').reverse().slice(0, 2).join('.') : '—');

const KOVA_ANLAM = {
  belgeli: { ad: '✅ Belgeli', renk: '#4ADE80', not: 'KDV indirilebilir + matrahtan düşer' },
  belgesiz: { ad: '⚠️ Belgesiz', renk: '#F87171', not: 'para çıktı, belge yok — avantaj KAYIP' },
  // 📋 Sahip (2026-08-08): "her ödemenin faturası olmaz — maaş, bazı kiralar,
  // kredi ödemeleri". Bunlar KAYIP DEĞİL: gider yazılır, KDV zaten yoktur.
  belge_beklenmez: { ad: '📋 Belge beklenmez', renk: '#60A5FA',
    not: 'maaş · kira · kredi/kart — bordro/dekont belgedir, gider yazılır' },
  belirsiz: { ad: '❓ Belirsiz', renk: '#FBBF24', not: 'işletme mi şahsi mi ayrılmamış' },
  // 🔁 2026-08-09: "Cari borç ödemesi — ATALAY KAHVE" satırı gider değil ÖDEMEdir.
  // Malın gideri kendi faturasında sayıldı; burada saymak çift sayım olurdu.
  borc_kapatma: { ad: '🔁 Borç kapatma', renk: '#94A3B8',
    not: 'tedarikçiye ödeme — gider değil, mal kendi faturasında sayıldı' },
  // 📜 2026-08-09 (sahip: "DYK faturası daha önceydi, geçmiş bariyeri var mı?")
  sistem_oncesi: { ad: '📜 Sistem öncesi', renk: '#8B7B67',
    not: '1 Haz 2026 öncesi — açılış devrinde; belgesi eski defterde' },
  sahsi: { ad: '👤 Şahsi', renk: '#8B7B67', not: 'vergiye konu değil' },
  vergi_sgk: { ad: '⚖️ Vergi/SGK', renk: '#60A5FA', not: 'verginin kendisi — gider değil' },
  yurtdisi: { ad: '🌐 Yurtdışı', renk: '#A78BFA', not: 'KDV-2 sorumlu sıfatıyla' },
};

export default function VergiModulu({ onCekmece }) {
  const [d, setD] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');

  useEffect(() => {
    setYukleniyor(true);
    api('/fatura/kart-vergi-etkisi?gun=365')
      .then(setD)
      .catch((e) => setHata(String(e?.message || e)))
      .finally(() => setYukleniyor(false));
  }, []);

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: 28, textAlign: 'center', color: R.not2 }}>
      Vergi etkisi hesaplanıyor…
    </div>;
  }
  if (hata) {
    return <div style={{ ...kartYuzey, padding: 20, borderLeft: `3px solid ${R.kirmizi}` }}>
      <div style={{ color: R.kirmizi, fontWeight: 700 }}>Hesap okunamadı</div>
      <div style={{ color: R.not2, fontSize: 12.5, marginTop: 6 }}>{hata}</div>
    </div>;
  }

  const k = d?.kovalar || {};
  const belgesiz = k.belgesiz || {};
  const belgeli = k.belgeli || {};
  const kayip = sayi(belgesiz.kayip_tasarruf);

  // "Hesaba girmeyenler" listesi tutara göre sıralı geliyordu; 📜 sistem öncesi
  // kalemler eklenince ilk 10'u doldurup vergi/SGK + yurtdışını ekrandan
  // siliyordu. Her sınıftan en büyük 5'i alınır — hiçbir sınıf kaybolmaz.
  const ozelGrup = {};
  (d?.ozel_sinif_harcamalari || []).forEach((x) => {
    (ozelGrup[x.sinif] = ozelGrup[x.sinif] || []).push(x);
  });
  const ozelGosterilecek = Object.values(ozelGrup)
    .flatMap((g) => g.slice(0, 5))
    .sort((a, b) => sayi(b.tutar) - sayi(a.tutar));

  return (
    <>
      <KpiSeridi kpiler={[
        {
          etiket: 'KAYIP vergi avantajı', deger: fmt(kayip),
          alt: 'faturası olması gerekip gelmeyenler', renk: R.kirmizi,
        },
        {
          etiket: 'Kullanılabilir', deger: fmt(sayi(belgeli.vergi_tasarrufu)),
          alt: 'belgeli harcamalardan', renk: R.yesil,
        },
        {
          etiket: 'Belgesiz tutar', deger: fmt(sayi(belgesiz.tutar)),
          alt: `${sayi(belgesiz.adet)} harcama · belge bekliyor`, renk: R.amber,
        },
        {
          etiket: 'Belirsiz', deger: fmt(sayi((k.belirsiz || {}).tutar)),
          alt: `${sayi((k.belirsiz || {}).adet)} harcama · işletme mi şahsi mi?`, renk: R.krem,
        },
      ]} />

      {/* ÖZET CÜMLE — sahibin okuyacağı tek satır */}
      {d?.ozet_cumle && (
        <div style={{
          ...kartYuzey, padding: '13px 16px', marginBottom: 12,
          borderLeft: `3px solid ${kayip > 0 ? R.kirmizi : R.yesil}`,
        }}>
          <div style={{ fontSize: 13, color: R.krem, lineHeight: 1.7 }}>{d.ozet_cumle}</div>
          <div style={{ fontSize: 11, color: R.not2, marginTop: 6 }}>
            KDV oranları kategori tahminidir (Market/Yemek %10, diğer %20); kesin rakam
            faturanın kendi KDV'sidir. Kurumlar/gelir vergisi oranı %{((d?.kurumlar_orani || 0.25) * 100).toFixed(0)}.
          </div>
        </div>
      )}

      {/* KOVA KIRILIMI */}
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(k).map(([kod, v]) => {
          const meta = KOVA_ANLAM[kod] || { ad: kod, renk: R.not, not: '' };
          const etki = sayi(v.vergi_tasarrufu) || sayi(v.kayip_tasarruf);
          return (
            <div key={kod} style={{
              flex: '1 1 180px', minWidth: 168, padding: '11px 13px', borderRadius: 10,
              background: R.girinti, border: `1px solid ${R.cizgi}`,
              borderLeft: `3px solid ${meta.renk}`,
            }}>
              <div style={{ fontSize: 11.5, color: R.metin2, marginBottom: 4 }}>{meta.ad}</div>
              <div style={{ fontFamily: F.mono, fontSize: 16, fontWeight: 700, color: R.krem }}>
                {fmt(sayi(v.tutar))}
              </div>
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 3 }}>
                {sayi(v.adet)} harcama{sayi(v.kdv) > 0 ? ` · KDV ${fmt(sayi(v.kdv))}` : ''}
              </div>
              {etki > 0 && (
                <div style={{
                  fontSize: 10.5, marginTop: 4, fontWeight: 600,
                  color: kod === 'belgesiz' ? R.kirmizi : R.yesil,
                }}>
                  {kod === 'belgesiz' ? '↓ kayıp ' : '↑ tasarruf '}{fmt(etki)}
                </div>
              )}
              <div style={{ fontSize: 10, color: R.not3 || R.not2, marginTop: 4, lineHeight: 1.4 }}>
                {meta.not}
              </div>
            </div>
          );
        })}
      </div>

      {/* BELGESİZ LİSTESİ — en büyükten */}
      {(d?.belgesiz_harcamalar || []).length > 0 && (
        <Tablo
          baslik="Belgesiz işletme harcamaları"
          not="belge gelirse KDV indirimi + gider yazımı kazanılır"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'Harcama' }, { ad: 'Kategori' },
            { ad: 'Tutar', sag: true }, { ad: 'KDV (tahmini)', sag: true }, { ad: 'Belge durumu' },
          ]}
          satirlar={(d.belgesiz_harcamalar || []).slice(0, 30).map((x, i) => ({
            id: `${x.hareket_id || i}`,
            hucreler: [
              { v: kisaTarih(x.tarih), mono: true },
              { v: x.aciklama || '—' },
              { v: x.kategori || '—' },
              { v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true },
              { v: fmt(sayi(x.kdv_tahmini)), mono: true, sag: true, renk: R.amber },
              { v: x.istek_durumu === 'istek yok' ? 'istenmemiş' : x.istek_durumu, rozet: R.kirmizi },
            ],
          }))}
        />
      )}

      {/* BELİRSİZLER — önerili */}
      {(d?.belirsiz_harcamalar || []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Tablo
            baslik="İşletme mi şahsi mi belli değil"
            not="sistem kaydından doğanlar tartışmasız işletmedir — öneri sütununa bak"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Harcama' }, { ad: 'Tutar', sag: true },
              { ad: 'Öneri' }, { ad: 'Gerekçe' },
            ]}
            satirlar={(d.belirsiz_harcamalar || []).slice(0, 25).map((x, i) => ({
              id: `b${x.hareket_id || i}`,
              hucreler: [
                { v: kisaTarih(x.tarih), mono: true },
                { v: x.aciklama || '—' },
                { v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true },
                {
                  v: x.oneri === 'isletme' ? 'işletme' : 'sahip kararı',
                  rozet: x.oneri === 'isletme' ? R.yesil : R.not,
                },
                { v: (x.oneri_gerekce || '—').slice(0, 46) },
              ],
            }))}
          />
        </div>
      )}

      {/* ÖZEL SINIFLAR — gider sayılmayanlar */}
      {(d?.ozel_sinif_harcamalari || []).length > 0 && (
        <div style={{ ...kartYuzey, padding: '12px 16px', marginTop: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: R.krem, marginBottom: 8 }}>
            Gider/KDV hesabına GİRMEYENLER
            <span style={{ fontWeight: 400, color: R.not2, fontSize: 11, marginLeft: 8 }}>
              her sınıftan en büyük 5 kalem
            </span>
          </div>
          {ozelGosterilecek.map((x, i) => (
            <div key={i} style={{
              display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0',
              borderBottom: i < ozelGosterilecek.length - 1 ? `1px solid ${R.cizgi}` : 'none',
              fontSize: 12,
            }}>
              <span style={{
                fontSize: 10.5, padding: '2px 7px', borderRadius: 6,
                background: R.girinti,
                color: x.sinif === 'vergi_sgk' ? '#60A5FA'
                  : x.sinif === 'borc_kapatma' ? '#94A3B8'
                    : x.sinif === 'sistem_oncesi' ? '#8B7B67'
                      : x.sinif === 'belge_beklenmez' ? '#60A5FA' : '#A78BFA',
              }}>{x.sinif === 'vergi_sgk' ? 'vergi/SGK'
                : x.sinif === 'borc_kapatma' ? 'borç kapatma'
                  : x.sinif === 'sistem_oncesi' ? '📜 sistem öncesi'
                    : x.sinif === 'belge_beklenmez' ? 'belge beklenmez' : 'yurtdışı'}</span>
              <span style={{ fontFamily: F.mono, color: R.krem, minWidth: 96, textAlign: 'right' }}>
                {fmt(sayi(x.tutar))}
              </span>
              <span style={{ color: R.metin2, flex: 1 }}>{x.aciklama}</span>
              <span style={{ color: R.not2, fontSize: 10.5 }}>{x.ne_demek}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
