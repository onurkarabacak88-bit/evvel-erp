// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — DENETİM & ZEKÂ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → denetim.* bölümleri
//
// 7 görünüm: Bugünkü Bulgular · Tanı Motorları · Olay Yelpazesi · Duyu Mutabakatı ·
//            Bağ Defteri · Duyu Paneli · Strateji Motoru
//
// İlkeler:
// - HER ŞEY ÖNERİ-ONLY: motorlar yalnız önerir, hüküm insanın. Bu modül hiçbir
//   yazma yapmaz; derin inceleme mevcut Akıllı Denetim / Duyu Paneli ekranlarında.
// - Blueprint'in demo rakamları (24 sinyal, %8 yanlış alarm, +41.200 ₺ etki)
//   KOPYALANMADI — ölçülmeyen metrik gösterilmez (sahte sayı yasağı). Yanlış
//   alarm oranı ve "ölçülen etki" sistemde takip edilmiyor; eklenirse gelir.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Liste, Tablo } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bugunISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const kisalt = (s, n = 150) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
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
      <button onClick={onTekrar} style={{
        padding: '7px 14px', borderRadius: 9, border: `1px solid ${R.kirmizi}55`,
        background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 12, fontWeight: 700,
        fontFamily: 'inherit', cursor: 'pointer',
      }}>
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
function OneriSeridi({ metin }) {
  return (
    <div style={{
      ...kartYuzey, padding: '12px 18px', marginBottom: 14,
      fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <span style={rozetHap(R.mavi)}>ℹ öneri-only</span>
      {metin}
    </div>
  );
}
function KopruButon({ ad, onTikla, birincil }) {
  return (
    <button onClick={onTikla} style={birincil ? {
      padding: '9px 17px', borderRadius: 10, border: 'none',
      background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
      fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
      boxShadow: '0 6px 18px rgba(217,154,78,.24)',
    } : {
      padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
      background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
      fontFamily: 'inherit', cursor: 'pointer',
    }}>
      {ad}
    </button>
  );
}

export default function DenetimModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [rapor, setRapor] = useState(null);          // truth gunluk-rapor
  const [durum, setDurum] = useState(null);          // truth durum
  const [truthHata, setTruthHata] = useState('');
  const [iziOzet, setIziOzet] = useState(null);      // duyu 3/6: bulgu yaşam döngüsü
  const [isaretliler, setIsaretliler] = useState({}); // ref → karar (oturum içi)
  const [ozet, setOzet] = useState(null);            // duyu ozet
  const [notlar, setNotlar] = useState(null);        // duyu gunluk-notlar
  const [olayHata, setOlayHata] = useState('');
  const [mutabakat, setMutabakat] = useState(null);
  const [mutHata, setMutHata] = useState('');
  const [beyin, setBeyin] = useState(null);
  const [dilekler, setDilekler] = useState(null);
  const [bagHata, setBagHata] = useState('');
  const [karne, setKarne] = useState(null);
  const [sinaps, setSinaps] = useState(null);
  const [duyuHata, setDuyuHata] = useState('');
  const [strateji, setStrateji] = useState(null);
  const [stratejiHata, setStratejiHata] = useState('');

  const truthYukle = useCallback(() => {
    setTruthHata('');
    api(`/ops/truth/gunluk-rapor?tarih=${bugunISO()}`)
      .then((d) => setRapor(d || {}))
      .catch((e) => setTruthHata(e?.message || ''));
    api('/ops/truth/durum')
      .then((d) => setDurum(d || {}))
      .catch(() => setDurum({}));
    api('/ops/bulgu-izi/ozet?gun=30')
      .then((d) => {
        setIziOzet(d || {});
        const m = {};
        (d?.isaretli_refler || []).forEach((x) => { m[x.ref] = x.karar; });
        setIsaretliler((p) => ({ ...m, ...p }));
      })
      .catch(() => setIziOzet({}));
  }, []);

  // Bulgu işareti (append-only defter) — çift tık koruması yerel state'te
  const bulguIsaretle = useCallback((ref, karar) => {
    setIsaretliler((p) => ({ ...p, [ref]: karar }));
    api('/ops/bulgu-izi', { method: 'POST', body: { bulgu_ref: ref, karar } })
      .then(() => onToast?.(
        karar === 'cozuldu' ? '✓ Çözüldü olarak işaretlendi'
          : karar === 'uygulandi' ? '✓ Uygulandı — akıbet defterine yazıldı'
            : '✗ Yanlış alarm olarak işaretlendi'))
      .catch(() => {
        setIsaretliler((p) => { const q = { ...p }; delete q[ref]; return q; });
        onToast?.('İşaret kaydedilemedi');
      });
  }, [onToast]);

  const olayYukle = useCallback(() => {
    setOlayHata('');
    api('/duyu/ozet').then((d) => setOzet(d || {})).catch((e) => setOlayHata(e?.message || ''));
    api('/duyu/gunluk-notlar?gun=7').then((d) => setNotlar(d || {})).catch(() => setNotlar({}));
  }, []);

  const mutYukle = useCallback(() => {
    setMutHata('');
    api('/duyu/odeme-mutabakat?gun=60')
      .then((d) => setMutabakat(d || {}))
      .catch((e) => setMutHata(e?.message || ''));
  }, []);

  const bagYukle = useCallback(() => {
    setBagHata('');
    api('/beyin/gunluk?limit=10')
      .then((d) => setBeyin(Array.isArray(d?.kayitlar) ? d.kayitlar : []))
      .catch((e) => setBagHata(e?.message || ''));
    api('/beyin/bag-dilekleri?sadece_acik=1')
      .then((d) => setDilekler(Array.isArray(d?.dilekler) ? d.dilekler : []))
      .catch(() => setDilekler([]));
  }, []);

  const duyuYukle = useCallback(() => {
    setDuyuHata('');
    api('/duyu/kural-karnesi')
      .then((d) => setKarne(d || {}))
      .catch((e) => setDuyuHata(e?.message || ''));
    api('/duyu/sinapsler?gun=14').then((d) => setSinaps(d || {})).catch(() => setSinaps({}));
  }, []);

  const stratejiYukle = useCallback(() => {
    setStratejiHata('');
    api('/strateji')
      .then((d) => setStrateji(d || {}))
      .catch((e) => setStratejiHata(e?.message || ''));
    api('/ops/bulgu-izi/ozet?gun=30')
      .then((d) => {
        setIziOzet(d || {});
        const m = {};
        (d?.isaretli_refler || []).forEach((x) => { m[x.ref] = x.karar; });
        setIsaretliler((p) => ({ ...m, ...p }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (gorunum === 'anomali' || gorunum === 'motorlar') truthYukle();
    if (gorunum === 'olaylar') olayYukle();
    if (gorunum === 'mutabakat') mutYukle();
    if (gorunum === 'bag') bagYukle();
    if (gorunum === 'duyu') duyuYukle();
    if (gorunum === 'strateji') stratejiYukle();
  }, [gorunum, truthYukle, olayYukle, mutYukle, bagYukle, duyuYukle, stratejiYukle]);

  // ════════════════════════ GÖRÜNÜM: BUGÜNKÜ BULGULAR ═══════════════════════
  if (gorunum === 'anomali') {
    if (truthHata) return <HataBandi mesaj={truthHata} onTekrar={truthYukle} />;
    if (!rapor) return <Yukleniyor />;
    const subeler = Array.isArray(rapor.subeler) ? rapor.subeler : [];
    const toplamAnomali = subeler.reduce((t, s) => t + sayi(s.anomali_sayisi), 0);
    const alarmli = subeler.filter((s) => s.alarm && s.alarm !== 'normal');
    const uyumlu = subeler.filter((s) => s.ana_tani === 'UYUMLU');
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün anomali', deger: String(toplamAnomali), alt: `${subeler.length} şube tarandı`, renk: toplamAnomali > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Alarmlı şube', deger: String(alarmli.length), alt: alarmli.map((s) => s.sube_ad).join(' · ') || 'yok', renk: alarmli.length > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Uyumlu şube', deger: `${uyumlu.length} / ${subeler.length}`, alt: 'ana tanı UYUMLU', renk: R.yesil },
          { etiket: 'Tarih', deger: tarihKisa(rapor.tarih), alt: 'gece koşusu + gün içi' },
        ]} />
        {/* DUYU 3/6 — bulgu yaşam döngüsü: işaret defterinden türeyen ölçümler */}
        {iziOzet && sayi(iziOzet.isaretli_bulgu) > 0 && (
          <KpiSeridi kpiler={[
            { etiket: 'Çözülen (30g)', deger: String(sayi(iziOzet.cozulen)), alt: 'insan işaretiyle', renk: R.yesil },
            { etiket: 'Yanlış alarm', deger: String(sayi(iziOzet.yanlis_alarm)), alt: iziOzet.yanlis_alarm_orani_yuzde != null ? `oran %${iziOzet.yanlis_alarm_orani_yuzde}` : '—', renk: sayi(iziOzet.yanlis_alarm) > 0 ? R.amber : R.yesil },
            { etiket: 'Ort. çözüm süresi', deger: iziOzet.ort_cozum_saat != null ? `${iziOzet.ort_cozum_saat} sa` : '—', alt: 'gece doğum varsayımıyla ≈' },
            { etiket: 'İşaretli bulgu', deger: String(sayi(iziOzet.isaretli_bulgu)), alt: 'append-only defter' },
          ]} />
        )}
        <OneriSeridi metin="Motor yalnız ÖNERİR — bulgular insan onayı bekler. Kartlardaki ✓/✗ işaretleri append-only deftere yazılır; motorun isabeti bu işaretlerle ölçülür." />
        {subeler.length === 0 ? (
          <BosDurum metin="Bugün için tanı raporu yok — motor gece koşusuyla dolar." />
        ) : (
          <Liste
            satirlar={subeler.map((s) => {
              const ref = `truth:${s.sube_id}:${String(s.tarih || rapor.tarih || '').slice(0, 10)}:${s.ana_tani || 'GENEL'}`;
              const isaret = isaretliler[ref];
              const bulgulu = sayi(s.anomali_sayisi) > 0;
              return {
                id: s.sube_id,
                baslik: `${s.sube_ad} · ${s.ana_tani || '—'}`,
                alt: kisalt(s.zeka_ozet || s.yorum_metni, 110)
                  || (bulgulu ? `${sayi(s.anomali_sayisi)} anomali · ${sayi(s.toplam_karar)} karar` : 'temiz gün'),
                tutar: bulgulu ? `${sayi(s.anomali_sayisi)} bulgu` : '',
                tier: s.alarm && s.alarm !== 'normal' ? 'kritik' : bulgulu ? 'uyari' : 'iyi',
                // Yaşam döngüsü işaretleri: yalnız bulgulu + henüz işaretsiz kartta
                ...(bulgulu && !isaret ? {
                  aksiyonlar: [
                    { ad: '✓ Çözüldü', birincil: true, onTikla: () => bulguIsaretle(ref, 'cozuldu') },
                    { ad: '✗ Yanlış alarm', onTikla: () => bulguIsaretle(ref, 'yanlis_alarm') },
                  ],
                } : {}),
                ...(isaret ? {
                  rozet: isaret === 'cozuldu' ? 'çözüldü ✓' : 'yanlış alarm',
                  rozetRenk: isaret === 'cozuldu' ? R.yesil : R.amber,
                } : (!bulgulu ? { aksiyon: 'İncele' } : {})),
                _s: s,
              };
            })}
            onAc={({ _s }) => onCekmece?.({
              tip: 'ŞUBE TANISI',
              baslik: _s.sube_ad,
              alt: `${_s.ana_tani || '—'} · ${tarihKisa(_s.tarih)}`,
              kpi: [
                { etiket: 'Anomali', deger: String(sayi(_s.anomali_sayisi)), renk: sayi(_s.anomali_sayisi) > 0 ? R.kirmizi : R.yesil },
                { etiket: 'Karar', deger: String(sayi(_s.toplam_karar)) },
                { etiket: 'Alarm', deger: _s.alarm || 'normal', renk: _s.alarm !== 'normal' ? R.kirmizi : R.yesil },
                { etiket: 'Motor', deger: _s.motor_aktif ? 'aktif' : (_s.motor_mod || 'kapalı'), renk: _s.motor_aktif ? R.yesil : R.amber },
              ],
              listeBaslik: 'Boyut özeti',
              satirlar: (Array.isArray(_s.boyut_ozet) ? _s.boyut_ozet : []).slice(0, 10).map((b, i) => ({
                ad: typeof b === 'string' ? b : (b?.boyut || b?.ad || `boyut ${i + 1}`),
                detay: typeof b === 'object' ? (b?.durum || '') : '',
                tutar: typeof b === 'object' && b?.deger != null ? String(b.deger) : '',
              })),
              not: kisalt(_s.yorum_metni || _s.zeka_ozet, 300) || 'Bu gün için yorum üretilmedi.',
              aksiyonAd: 'Akıllı Denetim ekranını aç',
              _hedef: '__modul:denetim:motorlar',
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: TANI MOTORLARI ═════════════════════════
  if (gorunum === 'motorlar') {
    if (truthHata) return <HataBandi mesaj={truthHata} onTekrar={truthYukle} />;
    if (!rapor || !durum) return <Yukleniyor />;
    const subeler = Array.isArray(durum.subeler) ? durum.subeler : [];
    const raporMap = {};
    (rapor.subeler || []).forEach((s) => { raporMap[String(s.sube_id)] = s; });
    const aktifSayi = subeler.filter((s) => s.motor_aktif).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Motor durumu', deger: durum.global_aktif ? 'AÇIK' : 'KAPALI', alt: 'küresel anahtar', renk: durum.global_aktif ? R.yesil : R.amber },
          { etiket: 'Aktif şube motoru', deger: `${aktifSayi} / ${subeler.length}`, alt: 'şube bazlı', renk: aktifSayi > 0 ? R.yesil : R.amber },
          { etiket: 'Tanı yelpazesi', deger: '13 tanı', alt: 'kasa · ciro · stok · N1-N3' },
          { etiket: 'İlke', deger: 'öneri-only', alt: 'insan onayı şart' },
        ]} />
        {subeler.length === 0 ? (
          <BosDurum metin="Motor durumu okunamadı." />
        ) : (
          <Tablo
            baslik="Tanı motorları · şube bazlı durum"
            not="satıra tıkla → bugünkü rapor; koşu gece 00:30"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Motor' }, { ad: 'Mod' }, { ad: 'Bugün bulgu', sag: 1 }, { ad: 'Son koşu' }, { ad: 'Durum' },
            ]}
            satirlar={subeler.map((s, i) => {
              const r = raporMap[String(s.sube_id)] || {};
              const bulgu = sayi(r.anomali_sayisi);
              return {
                id: s.sube_id || `m-${i}`,
                _s: { ...s, ...r },
                hucreler: [
                  { v: s.sube_ad || r.sube_ad || '—', kalin: true },
                  s.motor_aktif ? { v: 'aktif', rozet: R.yesil } : { v: 'kapalı', rozet: R.amber },
                  { v: s.motor_mod || '—', renk: R.not },
                  { v: String(bulgu), mono: true, sag: true, kalin: bulgu > 0, renk: bulgu > 1 ? R.kirmizi : bulgu === 1 ? R.amber : R.not },
                  { v: String(s.son_calisma || r.son_calisma || '—').slice(0, 16), mono: true, renk: R.not },
                  r.alarm && r.alarm !== 'normal'
                    ? { v: 'alarm', rozet: R.kirmizi }
                    : bulgu > 0 ? { v: 'izlemede', rozet: R.amber } : { v: 'temiz', rozet: R.yesil },
                ],
              };
            })}
            onSatir={() => onKopru?.('__modul:denetim:motorlar')}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: OLAY YELPAZESİ ═════════════════════════
  if (gorunum === 'olaylar') {
    if (olayHata) return <HataBandi mesaj={olayHata} onTekrar={olayYukle} />;
    if (!ozet || notlar == null) return <Yukleniyor />;
    const notListe = Array.isArray(notlar?.notlar) ? notlar.notlar : [];
    const tipler = Array.isArray(notlar?.tipler) ? notlar.tipler : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam olay', deger: String(sayi(ozet.toplam_olay)), alt: 'olay yelpazesi defteri' },
          { etiket: 'Etiket çeşidi', deger: String(sayi(ozet.etiket_sayisi)), alt: 'izlenen olay tipi' },
          { etiket: 'Son 7 gün notu', deger: String(notListe.length), alt: 'günlük gözlem notu' },
          { etiket: 'Okuyucular', deger: String((ozet.okuyucular || []).length || '—'), alt: 'salt-okur uçlar' },
        ]} />
        <OneriSeridi metin="Olaylar ham gözlemdir (duyu duysun, beyin sonra) — kayıt append-only, yorum ayrı katmanda." />
        {notListe.length === 0 ? (
          <BosDurum metin="Son 7 günde günlük not yok — olay defteri sakin ya da notlar henüz üretilmedi." />
        ) : (
          <Liste
            satirlar={notListe.slice(0, 20).map((n, i) => ({
              id: n.id || `n-${i}`,
              baslik: kisalt(n.baslik || n.tip || n.etiket || 'Gözlem', 70),
              alt: `${tarihKisa(n.gun || n.tarih)} · ${kisalt(n.metin || n.ozet || n.not || '', 110)}`,
              tutar: '',
              tier: /kritik|alarm/i.test(String(n.tip || n.seviye || '')) ? 'kritik'
                : /uyari|dikkat/i.test(String(n.tip || n.seviye || '')) ? 'uyari' : 'bilgi',
            }))}
          />
        )}
        {tipler.length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
            {tipler.slice(0, 12).map((t, i) => (
              <span key={i} style={rozetHap(R.mavi)}>{typeof t === 'string' ? t : (t?.tip || t?.ad || '—')}</span>
            ))}
          </div>
        )}
        <KopruButon ad="Duyu Paneli'ni aç" onTikla={() => onKopru?.('duyu-paneli')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DUYU MUTABAKATI ════════════════════════
  if (gorunum === 'mutabakat') {
    if (mutHata) return <HataBandi mesaj={mutHata} onTekrar={mutYukle} />;
    if (!mutabakat) return <Yukleniyor />;
    const dusumsuz = Array.isArray(mutabakat.dusus_var_odeme_kaydi_yok) ? mutabakat.dusus_var_odeme_kaydi_yok : [];
    const kayitsiz = Array.isArray(mutabakat.odeme_var_dusus_gorulmedi) ? mutabakat.odeme_var_dusus_gorulmedi : [];
    const eslesen = sayi(mutabakat.eslesen) || (Array.isArray(mutabakat.eslesen) ? mutabakat.eslesen.length : 0);
    const acikFark = dusumsuz.length + kayitsiz.length;
    const satirYap = (r, yon) => ({
      ad: kisalt(r.aciklama || r.kurum || r.tedarikci || r.kaynak || 'kayıt', 44),
      detay: `${tarihKisa(r.tarih || r.gun)} · ${yon}`,
      tutar: r.tutar != null ? fmt(sayi(r.tutar)) : '',
    });
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Eşleşen', deger: String(eslesen), alt: `son ${sayi(mutabakat.kesit) || 60} gün`, renk: R.yesil },
          { etiket: 'Açık fark', deger: String(acikFark), alt: 'iki yönlü uyumsuzluk', renk: acikFark > 0 ? R.amber : R.yesil },
          { etiket: 'Düşüş var · kayıt yok', deger: String(dusumsuz.length), alt: 'kasadan çıktı, ödeme kaydı yok', renk: dusumsuz.length > 0 ? R.kirmizi : R.krem },
          { etiket: 'Kayıt var · düşüş yok', deger: String(kayitsiz.length), alt: 'ödeme kaydı var, kasada iz yok', renk: kayitsiz.length > 0 ? R.amber : R.krem },
        ]} />
        <OneriSeridi metin="Mutabakat çapa-bağımsızdır: kasa izi tek gerçek — fark bulunursa elle işaretleme değil, kaynağında düzeltme önerilir." />
        {acikFark === 0 ? (
          <BosDurum metin="İki yön de mutabık — ödeme kayıtları ile kasa düşüşleri örtüşüyor." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[{ ad: 'Düşüş var · ödeme kaydı yok', rows: dusumsuz, renk: R.kirmizi, yon: 'kasada iz var' },
              { ad: 'Ödeme kaydı var · düşüş görülmedi', rows: kayitsiz, renk: R.amber, yon: 'kayıt var' }].map((grup) => (
              <div key={grup.ad} style={{ ...kartYuzey, padding: '16px 18px', border: grup.rows.length ? `1px solid ${grup.renk}44` : kartYuzey.border }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
                }}>
                  <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>{grup.ad}</span>
                  <span style={rozetHap(grup.rows.length ? grup.renk : R.yesil)}>{grup.rows.length}</span>
                </div>
                {grup.rows.length === 0 ? (
                  <div style={{ fontSize: 12, color: R.not3, padding: '8px 0' }}>temiz</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {grup.rows.slice(0, 8).map((r, i) => {
                      const s = satirYap(r, grup.yon);
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{s.ad}</div>
                            <div style={{ fontSize: 11, color: R.not2 }}>{s.detay}</div>
                          </div>
                          <span style={{ fontFamily: F.mono, fontWeight: 700, whiteSpace: 'nowrap' }}>{s.tutar}</span>
                        </div>
                      );
                    })}
                    {grup.rows.length > 8 && (
                      <div style={{ fontSize: 11, color: R.not3 }}>+{grup.rows.length - 8} kayıt daha…</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <KopruButon ad="Duyu Paneli'nde tam mutabakat" onTikla={() => onKopru?.('duyu-paneli')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: BAĞ DEFTERİ ════════════════════════════
  if (gorunum === 'bag') {
    if (bagHata) return <HataBandi mesaj={bagHata} onTekrar={bagYukle} />;
    if (beyin == null || dilekler == null) return <Yukleniyor />;
    const sentezler = beyin.filter((k) => k.tip === 'gece_sentez' || k.cevap || k.metin);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Son sentez kaydı', deger: String(sentezler.length), alt: 'gece anlatıları (beyin)' },
          { etiket: 'Açık bağ dileği', deger: String(dilekler.length), alt: 'onay bekleyen yeni bağ', renk: dilekler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Kurulum ilkesi', deger: 'insan onayı', alt: 'dilek → onay → yeni üretici' },
          { etiket: 'Besleme', deger: 'gece motoru', alt: 'bağlar her gece yeniden kurulur' },
        ]} />
        <OneriSeridi metin="Bağ cümlelerini KOD kurar (gece), beyin yalnız AKTARIR — dilek defteri sistemin kendini eğitme kanalıdır." />

        {dilekler.length > 0 && (
          <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14, border: `1px solid ${R.amber}44` }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>Bağ dilek defteri · onay bekliyor</span>
              <span style={rozetHap(R.amber)}>{dilekler.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {dilekler.slice(0, 6).map((d, i) => (
                <div key={d.ref || i} style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  <span style={{ color: R.amber, fontWeight: 700 }}>DİLEK · </span>
                  <span style={{ color: R.krem }}>{kisalt(d?.payload_json?.dilek || d?.dilek || '—', 160)}</span>
                  <span style={{ color: R.not3, fontSize: 11 }}> · ref {String(d.ref || '').slice(0, 8)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sentezler.length === 0 ? (
          <BosDurum metin="Henüz gece sentezi kaydı yok — beyin her gece gözlem anlatısı üretir." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {sentezler.slice(0, 6).map((k, i) => (
              <div key={i} style={{ ...kartYuzey, padding: '15px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
                  <span style={rozetHap(R.bakir)}>{k.tip === 'gece_sentez' ? 'gece sentezi' : (k.tip || 'kayıt')}</span>
                  {k.tarih || k.olusturma ? (
                    <span style={{ fontSize: 11, color: R.not2 }}>{String(k.tarih || k.olusturma).slice(0, 16)}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.6 }}>
                  {kisalt(k.cevap || k.metin || k.soru, 420)}
                </div>
              </div>
            ))}
          </div>
        )}
        <KopruButon ad="Duyu Paneli'nde Bağ Defteri" onTikla={() => onKopru?.('duyu-paneli')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DUYU PANELİ ════════════════════════════
  if (gorunum === 'duyu') {
    if (duyuHata) return <HataBandi mesaj={duyuHata} onTekrar={duyuYukle} />;
    if (!karne || sinaps == null) return <Yukleniyor />;
    const kurallar = Array.isArray(karne.karne) ? karne.karne : [];
    const sinapsOlay = sayi(sinaps?.sinaps_olaylari) || (Array.isArray(sinaps?.sinaps_olaylari) ? sinaps.sinaps_olaylari.length : 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen kural', deger: String(kurallar.length), alt: 'öğrenme defteri karnesi' },
          { etiket: 'Öğrenme', deger: karne.ogrenme_aktif ? 'aktif' : 'kapalı', alt: `n eşiği ${sayi(karne.n_esigi) || '—'}`, renk: karne.ogrenme_aktif ? R.yesil : R.amber },
          { etiket: 'Sinaps olayı', deger: String(sinapsOlay), alt: `son ${sayi(sinaps?.kesit) || 14} gün · duyular arası` },
          { etiket: 'Omurga', deger: 'tek gözlem', alt: 'çakışma hata değil ürün' },
        ]} />
        {kurallar.length === 0 ? (
          <BosDurum metin="Kural karnesi boş — öğrenme defteri kurallar biriktikçe dolar." />
        ) : (
          <Tablo
            baslik="Kural karnesi · öğrenme defteri"
            not="kurallar VERİ'dir — davranışları gece motoru ölçer"
            kolonlar={[
              { ad: 'Kural' }, { ad: 'Durum' }, { ad: 'Gözlem', sag: 1 }, { ad: 'Not' },
            ]}
            satirlar={kurallar.slice(0, 20).map((k, i) => ({
              id: k.id || k.kural || `k-${i}`,
              hucreler: [
                { v: kisalt(k.ad || k.kural || k.etiket || `kural ${i + 1}`, 40), kalin: true },
                /alarm|kritik/i.test(String(k.durum || ''))
                  ? { v: k.durum, rozet: R.kirmizi }
                  : /izle|uyari/i.test(String(k.durum || ''))
                    ? { v: k.durum || 'izlemede', rozet: R.amber }
                    : { v: k.durum || 'sağlıklı', rozet: R.yesil },
                { v: String(sayi(k.gozlem ?? k.n ?? k.sayi)), mono: true, sag: true },
                { v: kisalt(k.not || k.aciklama || '', 60), renk: R.not },
              ],
            }))}
            onSatir={() => onKopru?.('duyu-paneli')}
          />
        )}
        <KopruButon birincil ad="Tam Duyu Paneli'ni aç" onTikla={() => onKopru?.('duyu-paneli')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: STRATEJİ MOTORU ════════════════════════
  if (gorunum === 'strateji') {
    if (stratejiHata) return <HataBandi mesaj={stratejiHata} onTekrar={stratejiYukle} />;
    if (!strateji) return <Yukleniyor />;
    const oneriler = Array.isArray(strateji.oneriler) ? strateji.oneriler : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açık öneri', deger: String(oneriler.length), alt: 'motor üretimi', renk: oneriler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Uygulanan (30g)', deger: String(sayi(iziOzet?.uygulanan)), alt: 'işaret defterinden', renk: sayi(iziOzet?.uygulanan) > 0 ? R.yesil : R.krem },
          { etiket: 'Kullanılabilir nakit', deger: fmt(sayi(strateji.kullanilabilir_nakit)), alt: 'zorunlu yük sonrası', renk: sayi(strateji.kullanilabilir_nakit) >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'Öneri toplamı', deger: fmt(sayi(strateji.toplam_oneri_tutari)), alt: 'önerilen hareket tutarı' },
        ]} />
        {/* DUYU 4/6 — öneri akıbeti: "Uyguladım" işareti append-only deftere yazılır.
            Otomatik "ölçülen etki" hesabı BİLEREK yok: hangi KPI'ya bağlanacağı
            öneriye göre değişir, uydurma rakam basılmaz — izi tutulur, etki insan
            notuyla/ileriki iterasyonla bağlanır. */}
        <OneriSeridi metin="Motor yalnız önerir — 'Uyguladım' işareti akıbet defterine yazılır; hangi önerinin hayata geçtiği artık ölçülüyor." />
        {oneriler.length === 0 ? (
          <BosDurum metin="Şu an açık strateji önerisi yok." />
        ) : (
          <Liste
            satirlar={oneriler.map((o, i) => {
              const ham = String(o.baslik || o.oneri || o.aciklama || `oneri-${i}`);
              const ref = `strateji:${ham.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').slice(0, 60)}`;
              const isaret = isaretliler[ref];
              return {
                id: o.id || `o-${i}`,
                baslik: kisalt(ham, 90),
                alt: kisalt(o.detay || o.gerekce || o.aciklama, 120),
                tutar: o.tutar != null || o.tavsiye_tutar != null ? fmt(sayi(o.tutar ?? o.tavsiye_tutar)) : '',
                tier: /KIRMIZI|kritik/i.test(String(o.renk || o.oncelik || '')) ? 'kritik'
                  : /TURUNCU|uyari/i.test(String(o.renk || o.oncelik || '')) ? 'uyari' : 'bilgi',
                ...(isaret === 'uygulandi'
                  ? { rozet: 'uygulandı ✓', rozetRenk: R.yesil }
                  : { aksiyonlar: [{ ad: '✓ Uyguladım', birincil: true, onTikla: () => bulguIsaretle(ref, 'uygulandi') }] }),
              };
            })}
          />
        )}
        <KopruButon ad="Strateji ekranını aç" onTikla={() => onKopru?.('strateji')} />
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
