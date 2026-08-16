// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — 📈 ZAM TAKİBİ (paylaşılan görünüm)
//
// Sahip (2026-08-15): "bu artışlar ayrı bir sekme gibi düşün — ürün bazlı
// artışı görmem gerekiyor."
// Sahip (2026-08-16): "Zam Takibi, Karar Alanı ve Para Akışı gibi YUKARIDA
// SEKME olarak dursun." → görünüm Kâr & Maliyet'ten GENEL BAKIŞ'a TAŞINDI.
//
// ⚠️ TAŞINDI, KOPYALANMADI: MaliyetModulu'nda kopyası DURMAZ — orada tek satır
// köprü kaldı. İki ekranın aynı listeyi göstermesi "hangisi güncel?" sorusunu
// doğurur ve biri zamanla unutulur.
//
// Kendi verisini kendi çeker (görünüm nereye asılırsa asılsın çalışsın diye):
//   GET  /ops/fiyat-zam-alarmlari?gun=180&limit=60
//   POST /ops/fiyat-zam-alarmlari/goruldu   {id}
//
// ⚠️ `sadece_yeni` SUNUCUYA GEÇİRİLMEZ, filtre EKRANDA yapılır. Sebep: KPI
// şeridi "toplam / incelenmemiş" ayrımını gösterebilmek için HER İKİ kümeye de
// ihtiyaç duyar; sunucu tarafında filtrelenseydi "geçmişi göster" ikinci bir
// istek ister ve toplam sayaç yalan söylerdi. Varsayılan görünüm yine
// incelenmemişler (sahibin işi onlar), geçmiş tek tıkla açılır.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, BosDurum, HataBandi } from './parcalar';

const sayi = (v) => Number(v) || 0;
const pct = (v) => `%${Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
const rozetHap = (renk) => ({
  padding: '2px 9px', borderRadius: 99, fontSize: 11, fontWeight: 700,
  background: `${renk}22`, color: renk,
});

/** Zam alarmının `tedarikci` alanını TEDARİKÇİ + KAYNAK olarak ayırır.
 *
 * Sahip onaylı teslimat↔fatura bağından doğan alarmlarda provenance'ı bu
 * alanın sonuna damgalıyoruz; alarm tablosunda serbest metin kolonu yok ve
 * şekli değiştirmemek için yeni kolon açılmadı. Ham alanı olduğu gibi basmak
 * tedarikçi adını okunmaz yapıyor ve "kaç tedarikçi" sayımını şişiriyordu
 * (her fatura ayrı metin).
 *
 * Damgası olmayan ESKİ/elle kayıtlar olduğu gibi döner (kaynak = '').
 * ⚠️ Ayraç backend'deki damga metniyle birebir — orası değişirse burası da
 * değişmeli; o yüzden tek sabitte tutuluyor.
 *
 * 🔗 TAŞINDI (2026-08-16): eskiden MaliyetModulu.jsx:68'deydi. Görünümle
 * BİRLİKTE geldi — tek kullanıcısı bu ekran; iki dosyada kopya bırakılmadı. */
const ZAM_KAYNAK_DAMGASI = ' · teslimat-fatura bağı';
export const kaynakAyir = (ham) => {
  const s = String(ham || '').trim();
  const i = s.indexOf(ZAM_KAYNAK_DAMGASI);
  if (i < 0) return { tedarikci: s || '—', kaynak: '' };
  return { tedarikci: s.slice(0, i).trim() || '—', kaynak: s.slice(i + 3).trim() };
};

function Yukleniyor() {
  return (
    <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>
      Yükleniyor…
    </div>
  );
}

export default function ZamTakibi({ onToast }) {
  const [alarmlar, setAlarmlar] = useState(null);
  const [alarmHata, setAlarmHata] = useState('');
  const [esik, setEsik] = useState(15);
  const [zamGecmis, setZamGecmis] = useState(false);

  const alarmYukle = useCallback(() => {
    setAlarmHata('');
    api('/ops/fiyat-zam-alarmlari?gun=180&limit=60')
      .then((d) => {
        setAlarmlar(Array.isArray(d?.alarmlar) ? d.alarmlar : []);
        if (d?.esik_yuzde) setEsik(sayi(d.esik_yuzde));
      })
      .catch((e) => setAlarmHata(e?.message || 'Zam alarmları alınamadı'));
  }, []);
  useEffect(() => { alarmYukle(); }, [alarmYukle]);

  // HATA ≠ BOŞ: alarm ucu düşerse "zam yok, tedarik sakin" DEMEK yasak —
  // sahte-sakin, alarm körlüğünün ilk adımıdır (bkz. ops_fiyat_zam_alarmlari
  // içindeki aynı gerekçeli P1 düzeltmesi).
  if (alarmHata) return <HataBandi mesaj={alarmHata} onTekrar={alarmYukle} />;
  if (alarmlar == null) return <Yukleniyor />;

  const yeni = alarmlar.filter((a) => !a.goruldu);
  const gosterilen = zamGecmis ? alarmlar : yeni;
  const artislar = alarmlar.map((a) => sayi(a.artis_yuzde)).filter((n) => n > 0);
  const ortArtis = artislar.length
    ? artislar.reduce((t, n) => t + n, 0) / artislar.length : 0;
  // Tedarikçi sayımı KAYNAK METASINDAN ARINDIRILMIŞ ada göre yapılır: aynı
  // tedarikçinin her faturası ayrı bir metin taşıdığı için ham alanla saymak
  // "9 tedarikçi" gibi şişmiş bir sayı üretirdi.
  const tedarikciler = new Set(
    alarmlar.map((a) => kaynakAyir(a.tedarikci).tedarikci).filter((t) => t && t !== '—'),
  );

  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'İncelenmemiş zam', deger: String(yeni.length), alt: `toplam ${alarmlar.length} · son 180 gün`, renk: yeni.length > 0 ? R.kirmizi : R.yesil },
        { etiket: 'Ortalama artış', deger: artislar.length ? pct(ortArtis) : '—', alt: `eşik %${esik} üstü kalemlerde`, renk: R.amber },
        { etiket: 'En sert artış', deger: artislar.length ? pct(Math.max(...artislar)) : '—', alt: 'tek kalemde', renk: R.kirmizi },
        { etiket: 'Tedarikçi', deger: String(tedarikciler.size), alt: 'zam yapan firma sayısı' },
      ]} />

      {alarmlar.length === 0 ? (
        <BosDurum metin={`Son 180 günde %${esik} eşiğini aşan fiyat artışı yok — tedarik fiyatları sakin.`} />
      ) : (
        <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, flexWrap: 'wrap',
            paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 16,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>
              Ürün bazlı zamlar
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: R.not2 }}>
                {zamGecmis
                  ? `${alarmlar.length} kayıt · incelenmişler dâhil`
                  : `${yeni.length} incelenmemiş`}
              </span>
              <button
                onClick={() => setZamGecmis((v) => !v)}
                style={{
                  padding: '4px 12px', borderRadius: 99, border: `1px solid ${R.cizgi3}`,
                  background: zamGecmis ? R.girinti : 'transparent', color: R.metin2,
                  fontSize: 10.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                {zamGecmis ? 'yalnız yeniler' : 'geçmişi göster'}
              </button>
            </div>
          </div>

          {gosterilen.length === 0 ? (
            // Liste boş ama VERİ VAR: "zam yok" demek yanlış olurdu — hepsi
            // incelenmiş demektir. Boşluğun SEBEBİNİ söyle (boş alan kuralı).
            <div style={{ fontSize: 12.5, color: R.not2, lineHeight: 1.7, padding: '10px 2px' }}>
              İncelenmemiş zam kalmadı — {alarmlar.length} kaydın hepsi işaretlenmiş.
              Geçmişi görmek için “geçmişi göster”e bas.
            </div>
          ) : (<>
            {gosterilen.length > 25 && (
              <div style={{ fontSize: 10.5, color: R.not2, marginBottom: 8 }}>
                ilk 25 kayıt gösteriliyor · toplam {gosterilen.length}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {gosterilen.slice(0, 25).map((a) => {
                const artis = sayi(a.artis_yuzde);
                const sert = artis >= esik * 2;
                const renk = sert ? R.kirmizi : R.amber;
                const { tedarikci, kaynak } = kaynakAyir(a.tedarikci);
                return (
                  <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 14 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span style={{
                        width: 10, height: 10, borderRadius: 99, marginTop: 4, background: renk,
                        boxShadow: a.goruldu ? 'none' : `0 0 8px ${renk}`,
                      }} />
                      <span style={{ flex: 1, width: 1, background: R.cizgi2 }} />
                    </div>
                    <div style={{ paddingBottom: 16, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{a.kalem_adi || a.kalem_kodu}</span>
                        <span style={{ ...rozetHap(renk), fontFamily: F.mono }}>
                          {sayi(a.eski_fiyat).toLocaleString('tr-TR')} → {sayi(a.yeni_fiyat).toLocaleString('tr-TR')} ₺ · +{pct(artis).slice(1)}
                        </span>
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
                      <div style={{ fontSize: 11.5, color: R.not, marginTop: 4 }}>
                        {tedarikci} · <span style={{ fontFamily: F.mono }}>{a.olusturma}</span>
                      </div>
                      {/* KAYNAK METASI — "bu zam nereden biliniyor?" Sahip onaylı
                          fatura bağından gelen kayıtlarda provenance backend'de
                          tedarikçi alanının sonuna damgalanıyor; burada ikincil
                          satıra AYRILIR (ham alanı olduğu gibi basmak tedarikçi
                          adını okunmaz hâle getiriyordu). */}
                      {kaynak && (
                        <div style={{ fontSize: 10.5, color: R.not3, marginTop: 2, lineHeight: 1.5 }}>
                          {kaynak}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: R.metin2, marginTop: 4, lineHeight: 1.55 }}>
                        {sert
                          ? 'Sert artış — bu kalemi kullanan reçetelerin maliyeti belirgin yükselir; menü fiyatı kararı gerekebilir.'
                          : 'Eşik üstü artış — reçete maliyetlerine yansır, izlemeye değer.'}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>)}
        </div>
      )}
    </>
  );
}
