// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — OPERASYON modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → ops.* bölümleri
//
// 6 görünüm: Sipariş Akışı (kanban) · Sevkiyat Hazırlama · Depo Stok ·
//            Bardak & Ürün Sayımı · Stok Hareketi · Kontrol Kulesi
//
// Blueprint'ten BİLİNÇLİ sapmalar (iş modeli tasarımdan üstün):
// 1. Kanban "Teslim et →" butonu YOK — teslim alma ŞUBEDE yapılır (görünür kabul
//    modeli). Masaüstünden teslim işaretlemek o zinciri delerdi. Yolda kartı
//    "şube kabulü bekleniyor" bilgisini gösterir.
// 2. Kanban 4 kolona ek olarak KABUL UYUMSUZLUĞU risk şeridi tepede (desen 2) —
//    gerçek yaşam döngüsünde blueprint'te olmayan bir aşama var, gizlenmez.
// 3. Sayım görünümü SALT-OKUR — sayım şubede personel kilidiyle yapılır
//    (stok_sayim modeli). Masaüstü yalnız bekleyen onayları ve düzeltme izini
//    gösterir; onay mevcut Stok Sayım ekranında kalır (yeni yazma yolu yok).
// 4. Tutar KPI'ları yalnız gerçek uçtan gelirse gösterilir — talep kalemlerinde
//    fiyat yok, blueprint'teki ₺ değerleri sahte olurdu (sahte sayı yasağı).
//
// Yazma yolları: SADECE /ops/siparis/sevkiyat-guncelle (SevkiyatHazirlama.jsx
// ile birebir aynı sözleşme + aynı kaynak kurallar). Başka yazma ucu yok.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Tarih aritmetiği YEREL kalır — toISOString UTC'ye çevirip TR'de (+3) tarihi
// bir gün geri kaydırır (Ödeme Merkezi'nde yaşanmış hata, d2340fa).
const bugunYerelISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (!s || s.length < 10) return '—';
  const ay = Number(s.slice(5, 7));
  return `${Number(s.slice(8, 10))} ${AYLAR[ay - 1] || ''}`;
};
const saatKisa = (ts) => {
  const s = String(ts || '');
  const m = s.match(/\d{2}:\d{2}/);
  return m ? m[0] : '';
};

// Gerçek yaşam döngüsü (siparis_kontrol_kulesi.py ASAMA_LABEL ile aynı sözlük)
const ASAMA = {
  bekliyor: { ad: 'MERKEZ KUYRUĞU', renk: R.amber },
  depoda: { ad: 'DEPODA HAZIRLANIYOR', renk: R.mavi },
  yolda: { ad: 'YOLDA / KABUL BEKLİYOR', renk: R.bakir },
  toptanci_bekliyor: { ad: 'TOPTANCIDAN BEKLENİYOR', renk: R.bakir },
  uyumsuzluk: { ad: 'KABUL UYUMSUZLUĞU', renk: R.kirmizi },
  tamamlandi: { ad: 'TAMAMLANDI', renk: R.yesil },
  iptal: { ad: 'İPTAL', renk: R.not2 },
  gonderilmedi: { ad: 'GÖNDERİLMEDİ', renk: R.not2 },
};

const rozetHap = (renk) => ({
  padding: '3px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
  background: `${renk}22`, color: renk, whiteSpace: 'nowrap',
});

// ── ortak durum blokları (desen 11: hata ≠ boş durum) ────────────────────────
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

export default function OpsModulu({ gorunum, onCekmece, onKopru, onToast, onGorunum }) {
  // ── SİPARİŞ AKIŞI + KULE ortak verisi ─────────────────────────────────────
  const [kule, setKule] = useState(null);        // kontrol-kulesi cevabı
  const [kuleHata, setKuleHata] = useState('');
  const [subeOzet, setSubeOzet] = useState(null); // sevkiyat-subeler-ozet
  // ── SEVKİYAT ──────────────────────────────────────────────────────────────
  const [sevkListe, setSevkListe] = useState(null);
  const [sevkHata, setSevkHata] = useState('');
  const [seciliId, setSeciliId] = useState('');
  const [kd, setKd] = useState({});               // kalem durumları (indeks anahtarlı)
  const [notu, setNotu] = useState('');
  const [busy, setBusy] = useState(false);
  // ── DEPO ──────────────────────────────────────────────────────────────────
  const [depo, setDepo] = useState(null);
  const [depoHata, setDepoHata] = useState('');
  const [depoSube, setDepoSube] = useState('');   // '' = tüm şubeler
  // ── SAYIM ─────────────────────────────────────────────────────────────────
  const [sayim, setSayim] = useState(null);
  const [sayimIz, setSayimIz] = useState(null);
  const [sayimHata, setSayimHata] = useState('');
  const [sayimAcikId, setSayimAcikId] = useState('');
  const [sayimDetay, setSayimDetay] = useState({});   // gorev_id → detay (kalem farkları)
  // ── HAREKET ───────────────────────────────────────────────────────────────
  const [hareket, setHareket] = useState(null);
  const [hareketHata, setHareketHata] = useState('');

  const kuleYukle = useCallback(() => {
    setKuleHata('');
    api('/ops/siparis/kontrol-kulesi?gun=14&sadece_acik=false&limit=200')
      .then((d) => setKule(d || {}))
      .catch((e) => setKuleHata(e?.message || ''));
    api('/ops/siparis/sevkiyat-subeler-ozet?gun=30')
      .then((d) => setSubeOzet(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setSubeOzet([]));
  }, []);

  const sevkYukle = useCallback(() => {
    setSevkHata('');
    api('/ops/siparis/sevkiyat-listesi?durum=hazirlaniyor&gun=14')
      .then((d) => setSevkListe(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch((e) => setSevkHata(e?.message || ''));
  }, []);

  const depoYukle = useCallback(() => {
    setDepoHata('');
    api('/ops/depo-stok')
      .then((d) => setDepo(d || {}))
      .catch((e) => setDepoHata(e?.message || ''));
  }, []);

  const sayimYukle = useCallback(() => {
    setSayimHata('');
    api('/stok-sayim/bekleyen-onay')
      .then((d) => setSayim(d || {}))
      .catch((e) => setSayimHata(e?.message || ''));
    api('/stok-sayim/duzeltme-iz?limit=200')
      .then((d) => setSayimIz(d || {}))
      .catch(() => setSayimIz(null));
  }, []);

  const hareketYukle = useCallback(() => {
    setHareketHata('');
    api('/ops/stok-hareketleri?gun=3&limit=150')
      .then((d) => setHareket(Array.isArray(d?.satirlar) ? d.satirlar : (Array.isArray(d) ? d : [])))
      .catch((e) => setHareketHata(e?.message || ''));
  }, []);

  // Sayım görevi aç/kapa — açılınca kalem farkları bir kez çekilir (salt-okur)
  const sayimGorevAc = useCallback((gid) => {
    setSayimAcikId((p) => (p === gid ? '' : gid));
    setSayimDetay((p) => {
      if (p[gid]) return p;
      api(`/stok-sayim/gorev/${gid}`)
        .then((d) => setSayimDetay((q) => ({ ...q, [gid]: d || { satirlar: [] } })))
        .catch(() => setSayimDetay((q) => ({ ...q, [gid]: { hata: true, satirlar: [] } })));
      return p;
    });
  }, []);

  useEffect(() => {
    if (gorunum === 'akis' || gorunum === 'kule') kuleYukle();
    if (gorunum === 'sevkiyat') sevkYukle();
    if (gorunum === 'depo') depoYukle();
    if (gorunum === 'sayim') sayimYukle();
    if (gorunum === 'hareket') hareketYukle();
  }, [gorunum, kuleYukle, sevkYukle, depoYukle, sayimYukle, hareketYukle]);

  // ── seçili sevkiyat talebi değişince kalem durumlarını hazırla ────────────
  const seciliTalep = useMemo(
    () => (sevkListe || []).find((t) => String(t.id) === String(seciliId)) || null,
    [sevkListe, seciliId],
  );

  useEffect(() => {
    if (!seciliTalep) { setKd({}); setNotu(''); return; }
    const next = {};
    (seciliTalep.kalemler || []).forEach((k, i) => {
      next[i] = {
        urun_id: k?.urun_id || null,
        urun_ad: k?.urun_ad || null,
        durum: 'var',
        gonderilen_adet: sayi(k?.adet),
        not_aciklama: '',
      };
    });
    // Daha önce kaydedilmiş hazırlık varsa üstüne yaz (aynı eşleme kuralı:
    // urun_id + urun_ad — SevkiyatHazirlama.jsx ile birebir)
    (seciliTalep.kalem_durumlari || []).forEach((d) => {
      const idx = (seciliTalep.kalemler || []).findIndex(
        (k) => (k?.urun_id || '') === (d?.urun_id || '') && (k?.urun_ad || '') === (d?.urun_ad || ''),
      );
      if (idx >= 0) {
        next[idx] = {
          urun_id: d?.urun_id || null,
          urun_ad: d?.urun_ad || null,
          durum: d?.durum || 'var',
          gonderilen_adet: sayi(d?.gonderilen_adet),
          not_aciklama: d?.not_aciklama || '',
        };
      }
    });
    setKd(next);
    setNotu(seciliTalep?.sevkiyat_notu || '');
  }, [seciliTalep]);

  // ── sevkiyat kaydet — MEVCUT sözleşme, MEVCUT kaynak kurallar ─────────────
  async function sevkKaydet(gonderildi) {
    if (!seciliTalep || busy) return;
    const payload = Object.values(kd);
    if (!payload.length) { onToast?.('En az bir kalem durumu seçin'); return; }
    const sevkVar = payload.some((x) => {
      const d = String(x.durum || '').toLowerCase();
      return (d === 'var' || d === 'kismi') && sayi(x.gonderilen_adet) > 0;
    });
    if (gonderildi && !sevkVar) {
      onToast?.('Yola çıkarmak için en az bir kalemde «var/kısmi» + gönderilen adet gerekli');
      return;
    }
    if (!gonderildi && sevkVar) {
      // Kaynak kural (backend + SevkiyatHazirlama): adet girilmişse hazırlık kaydı yok
      onToast?.('Gönderilen adet girilmiş — «Yola çıkar» ile sevk edin; hazırlık kaydı yalnız yok/not içindir');
      return;
    }
    setBusy(true);
    try {
      await api('/ops/siparis/sevkiyat-guncelle', {
        method: 'POST',
        body: {
          talep_id: seciliTalep.id,
          hedef_depo_sube_id: seciliTalep.hedef_depo_sube_id || seciliTalep.sevkiyat_sube_id,
          kalem_durumlari: payload,
          sevkiyat_notu: (notu || '').trim() || null,
          gonderildi: !!gonderildi,
        },
      });
      onToast?.(gonderildi
        ? '🚚 Yola çıkarıldı — talep şubesinde «Depodan Gelen» açıldı'
        : '✓ Hazırlık kaydedildi (stok çıkmadı)');
      setSeciliId('');
      sevkYukle();
    } catch (e) {
      onToast?.(e?.message || 'Güncelleme başarısız');
    } finally {
      setBusy(false);
    }
  }

  // ── sipariş kartı çekmecesi (kanban + kule ortak) ─────────────────────────
  const siparisAc = (s) => {
    const a = ASAMA[s.asama] || ASAMA.bekliyor;
    onCekmece?.({
      tip: 'SİPARİŞ',
      baslik: `${s.sube_adi || 'Şube'} · ${tarihKisa(s.tarih)}`,
      alt: s.asama_metni || a.ad.toLowerCase(),
      kpi: [
        { etiket: 'Aşama', deger: (a.ad || '').toLowerCase(), renk: a.renk },
        { etiket: 'Kalem çeşidi', deger: String((s.kalemler || []).length) },
        { etiket: 'Toplam adet', deger: String(sayi(s.kalem_sayisi)) },
        { etiket: 'Hedef depo', deger: s.hedef_depo_sube_adi || 'atanmadı', renk: s.hedef_depo_sube_adi ? R.krem : R.amber },
      ],
      listeBaslik: 'Talep kalemleri',
      satirlar: (s.kalemler || []).slice(0, 14).map((k) => ({
        ad: k?.urun_ad || '—',
        detay: k?.birim ? String(k.birim) : '',
        tutar: `${sayi(k?.adet)} adet`,
      })),
      not: [
        s.asama_metni,
        s.operasyon_yonlendirme_talimati ? `Talimat: ${s.operasyon_yonlendirme_talimati}` : '',
        s.asama === 'yolda' ? 'Teslim alma ŞUBEDE yapılır (görünür kabul) — masaüstünden teslim işaretlenmez.' : '',
        s.asama === 'uyumsuzluk' && s.kabul_personel_ad
          ? `Kabulü yapan: ${s.kabul_personel_ad}${saatKisa(s.kabul_ts) ? ` · ${saatKisa(s.kabul_ts)}` : ''}`
          : '',
      ].filter(Boolean).join(' · '),
      aksiyonAd: s.asama === 'bekliyor' ? 'Yönlendirme ekranını aç'
        : s.asama === 'depoda' ? 'Sevkiyatı hazırla'
        : 'Operasyon Merkezi\'ni aç',
      _hedef: s.asama === 'depoda' ? '__gorunum:sevkiyat' : (s.asama === 'bekliyor' ? 'sevkiyat-hazirlama' : 'ops-merkez'),
    });
  };

  // Çekmece aksiyonu TasarimV2'de koprule(_hedef) çağırır; görünüm-içi hedefler
  // için köprüyü burada yakalayamayız → kart üstündeki butonlar görünüm değiştirir,
  // çekmece aksiyonu eski sayfaya köprüler. (__gorunum: önekini TasarimV2 çözer.)

  // ════════════════════════ GÖRÜNÜM: SİPARİŞ AKIŞI ══════════════════════════
  if (gorunum === 'akis') {
    if (kuleHata) return <HataBandi mesaj={kuleHata} onTekrar={kuleYukle} />;
    if (!kule) return <Yukleniyor />;
    const ozet = kule.ozet || {};
    const satirlar = Array.isArray(kule.satirlar) ? kule.satirlar : [];
    const acik = ['bekliyor', 'depoda', 'yolda', 'toptanci_bekliyor', 'uyumsuzluk']
      .reduce((t, k) => t + sayi(ozet[k]), 0);
    const uyumsuzlar = satirlar.filter((s) => s.asama === 'uyumsuzluk');
    const kolonlar = [
      { id: 'bekliyor', asamalar: ['bekliyor'], buton: 'Yönlendir →', hedef: 'sevkiyat-hazirlama' },
      { id: 'depoda', asamalar: ['depoda'], buton: 'Sevkiyatı hazırla →', gorunum: 'sevkiyat' },
      { id: 'yolda', asamalar: ['yolda', 'toptanci_bekliyor'], bilgi: 'şube kabulü bekleniyor' },
      { id: 'tamamlandi', asamalar: ['tamamlandi'] },
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açık sipariş', deger: String(acik), alt: 'son 14 gün · tüm aşamalar' },
          { etiket: 'Merkez kuyruğu', deger: String(sayi(ozet.bekliyor)), alt: 'depo yönlendirmesi bekliyor', renk: sayi(ozet.bekliyor) > 0 ? R.amber : R.krem },
          { etiket: 'Depoda hazırlanan', deger: String(sayi(ozet.depoda)), alt: 'sevk bekliyor', renk: sayi(ozet.depoda) > 0 ? R.mavi : R.krem },
          { etiket: 'Kabul uyumsuzluğu', deger: String(sayi(ozet.uyumsuzluk)), alt: sayi(ozet.uyumsuzluk) > 0 ? 'merkez müdahalesi gerekli' : 'temiz', renk: sayi(ozet.uyumsuzluk) > 0 ? R.kirmizi : R.yesil },
        ]} />

        {/* Risk şeridi TEPEDE (desen 2) — blueprint'te olmayan gerçek aşama.
            Her uyumsuz sipariş tıklanabilir kart: çekmecede kalemler + aşama metni. */}
        {uyumsuzlar.length > 0 && (
          <div style={{
            ...kartYuzey, padding: '14px 18px', marginBottom: 14,
            border: `1px solid ${R.kirmizi}55`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={rozetHap(R.kirmizi)}>⚠ kabul uyumsuzluğu · {uyumsuzlar.length}</span>
              <span style={{ fontSize: 12, color: R.metin2, flex: 1 }}>
                şube kabulü sevk edilenle uyuşmadı — merkez kararı gerekli
              </span>
              <button
                onClick={() => onKopru?.('ops-merkez')}
                style={{
                  padding: '6px 13px', borderRadius: 9, border: `1px solid ${R.kirmizi}55`,
                  background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 11.5, fontWeight: 700,
                  fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                Tümünü incele
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {uyumsuzlar.slice(0, 6).map((s) => (
                <div
                  key={s.id}
                  onClick={() => siparisAc(s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer',
                    padding: '8px 13px', borderRadius: 11,
                    border: `1px solid ${R.kirmizi}40`,
                    background: 'linear-gradient(165deg, #2E1B12, #251409)',
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{s.sube_adi}</span>
                  <span style={{ fontSize: 10.5, color: R.not2, fontFamily: F.mono }}>{tarihKisa(s.tarih)}</span>
                  <span style={{ fontSize: 10.5, color: R.kirmizi }}>
                    {(s.kalemler || []).length} kalem →
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
          gap: 11, alignItems: 'start', marginBottom: 16,
        }}>
          {kolonlar.map((kol) => {
            const a0 = ASAMA[kol.asamalar[0]];
            const kartlar = satirlar.filter((s) => kol.asamalar.includes(s.asama));
            return (
              <div key={kol.id} style={{
                background: `linear-gradient(165deg, #241A10, #1E1509)`,
                border: '1px solid rgba(243,233,220,.08)', borderRadius: 16, padding: 12, minHeight: 240,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '2px 4px 10px', borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11,
                }}>
                  <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.7px', color: a0.renk }}>{a0.ad}</span>
                  <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2 }}>{kartlar.length}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {kartlar.length === 0 && (
                    <div style={{ fontSize: 11.5, color: R.not3, textAlign: 'center', padding: '18px 0' }}>boş</div>
                  )}
                  {kartlar.slice(0, 8).map((s) => (
                    <div
                      key={s.id}
                      onClick={() => siparisAc(s)}
                      className="v2-kanban-kart"
                      style={{
                        padding: '12px 13px', borderRadius: 13,
                        border: `1px solid ${s.asama === 'toptanci_bekliyor' ? `${R.bakir}44` : 'rgba(243,233,220,.1)'}`,
                        background: 'linear-gradient(165deg, #2C2116, #251A0E)', cursor: 'pointer',
                        transition: 'transform .14s ease, box-shadow .14s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{s.sube_adi || '—'}</span>
                        <span style={{ fontFamily: F.mono, fontSize: 10, color: R.not2 }}>{tarihKisa(s.tarih)}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: R.metin2, marginTop: 5, lineHeight: 1.45 }}>
                        {(s.kalemler || []).length} kalem · {sayi(s.kalem_sayisi)} adet
                        {s.hedef_depo_sube_adi ? ` · depo: ${s.hedef_depo_sube_adi}` : ''}
                        {s.asama === 'toptanci_bekliyor' ? ' · toptancıya yönlendirildi' : ''}
                      </div>
                      {kol.buton ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (kol.gorunum) onGorunum?.(kol.gorunum);
                            else onKopru?.(kol.hedef);
                          }}
                          style={{
                            width: '100%', marginTop: 10, padding: 6, borderRadius: 8,
                            border: `1px solid ${R.bakir}55`, background: `${R.bakir}1f`,
                            color: R.bakir, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                          }}
                        >
                          {kol.buton}
                        </button>
                      ) : kol.id === 'yolda' ? (
                        /* Tasarımın devamı: buton yerine iki aşamalı teslim boru
                           hattı — masaüstünde "Teslim et" yok (şube kabul modeli),
                           ama süreç görünür kalır (desen 8: kritik bağlam görünür). */
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 5, marginTop: 10,
                          flexWrap: 'wrap',
                        }}>
                          <span style={{ ...rozetHap(R.bakir), fontSize: 9.5 }}>
                            {s.asama === 'toptanci_bekliyor' ? 'toptancıya verildi ✓' : `depodan çıktı ✓${saatKisa(s.sevkiyat_ts) ? ` ${saatKisa(s.sevkiyat_ts)}` : ''}`}
                          </span>
                          <span style={{ color: R.not3, fontSize: 10 }}>→</span>
                          <span style={{ ...rozetHap(R.amber), fontSize: 9.5 }}>şube kabulü bekleniyor</span>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {kartlar.length > 8 && (
                    <div style={{ fontSize: 11, color: R.not2, textAlign: 'center' }}>+{kartlar.length - 8} daha…</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: SEVKİYAT HAZIRLAMA ═════════════════════
  if (gorunum === 'sevkiyat') {
    if (sevkHata) return <HataBandi mesaj={sevkHata} onTekrar={sevkYukle} />;
    if (!sevkListe) return <Yukleniyor />;
    const eksik = Object.values(kd).filter((x) => x.durum === 'yok' || x.durum === 'kismi').length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Hazırlıkta talep', deger: String(sevkListe.length), alt: 'son 14 gün', renk: sevkListe.length > 0 ? R.mavi : R.krem },
          { etiket: 'Seçili talep', deger: seciliTalep ? `${(seciliTalep.kalemler || []).length} kalem` : '—', alt: seciliTalep ? (seciliTalep.sube_adi || '') : 'listeden seç' },
          { etiket: 'Eksik / kısmi', deger: seciliTalep ? String(eksik) : '—', alt: 'yok veya kısmi işaretli', renk: eksik > 0 ? R.amber : R.krem },
          { etiket: 'Hedef depo', deger: seciliTalep?.hedef_depo_sube_adi || '—', alt: 'sevkiyatı yapacak şube' },
        ]} />

        {sevkListe.length === 0 && <BosDurum metin="Hazırlık bekleyen sevkiyat talebi yok — kuyruk temiz. Yeni talepler Sipariş Akışı'nda görünür." />}

        {sevkListe.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {sevkListe.map((t) => {
              const secili = String(t.id) === String(seciliId);
              return (
                <div key={t.id} style={{ ...kartYuzey, padding: 0, border: secili ? `1px solid ${R.bakir}66` : kartYuzey.border }}>
                  <div
                    onClick={() => setSeciliId(secili ? '' : String(t.id))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px',
                      cursor: 'pointer', flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 180 }}>
                      <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                        {t.sube_adi} → {t.hedef_depo_sube_adi || 'depo'}
                      </div>
                      <div style={{ fontSize: 11.5, color: R.not2, marginTop: 3 }}>
                        {tarihKisa(t.tarih)} · {(t.kalemler || []).length} kalem
                        {t.personel_ad ? ` · talep: ${t.personel_ad}` : ''}
                      </div>
                    </div>
                    <span style={rozetHap(t.sevkiyat_durum === 'kismi_hazirlandi' ? R.amber : R.mavi)}>
                      {t.sevkiyat_durum === 'kismi_hazirlandi' ? 'kısmi hazırlandı' : 'hazırlanıyor'}
                    </span>
                    <span style={{ fontSize: 11, color: R.not3 }}>{secili ? 'kapat ▲' : 'hazırla ▼'}</span>
                  </div>

                  {secili && (
                    <div style={{ padding: '0 18px 16px', borderTop: `1px solid ${R.cizgi2}` }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 13 }}>
                        {(t.kalemler || []).map((k, i) => {
                          const d = kd[i] || {};
                          const secenek = [
                            { id: 'var', ad: 'Var', renk: R.yesil },
                            { id: 'kismi', ad: 'Kısmi', renk: R.amber },
                            { id: 'yok', ad: 'Yok', renk: R.kirmizi },
                          ];
                          return (
                            <div key={i} style={{
                              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
                              padding: '11px 13px', borderRadius: 12,
                              border: '1px solid rgba(243,233,220,.08)',
                              background: 'linear-gradient(165deg, #2C2116, #241A0E)',
                            }}>
                              <div style={{ flex: 1, minWidth: 150 }}>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>{k?.urun_ad || '—'}</div>
                                <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>istenen {sayi(k?.adet)}</div>
                              </div>
                              <label style={{ fontSize: 10.5, color: R.not2, display: 'flex', flexDirection: 'column', gap: 3 }}>
                                gönderilen
                                <input
                                  type="number"
                                  min="0"
                                  value={d.gonderilen_adet ?? 0}
                                  onChange={(e) => setKd((p) => ({
                                    ...p,
                                    [i]: { ...p[i], gonderilen_adet: Math.max(0, sayi(e.target.value)) },
                                  }))}
                                  style={{
                                    width: 76, padding: '6px 9px', borderRadius: 8,
                                    border: `1px solid ${R.cizgi3}`, background: R.girinti,
                                    color: R.krem, fontFamily: F.mono, fontSize: 13, outline: 'none',
                                  }}
                                />
                              </label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {secenek.map((o) => {
                                  const aktif = (d.durum || 'var') === o.id;
                                  return (
                                    <div
                                      key={o.id}
                                      onClick={() => setKd((p) => ({
                                        ...p,
                                        [i]: {
                                          ...p[i],
                                          durum: o.id,
                                          gonderilen_adet: o.id === 'var' ? sayi(k?.adet) : o.id === 'yok' ? 0 : sayi(p[i]?.gonderilen_adet),
                                        },
                                      }))}
                                      style={{
                                        padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700,
                                        cursor: 'pointer', userSelect: 'none',
                                        background: aktif ? `${o.renk}26` : R.girinti,
                                        color: aktif ? o.renk : R.not2,
                                        border: `1px solid ${aktif ? `${o.renk}55` : R.cizgi3}`,
                                      }}
                                    >
                                      {o.ad}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <label style={{ display: 'block', fontSize: 11.5, color: R.metin2, fontWeight: 600, margin: '13px 0 6px' }}>
                        Sevkiyat notu (isteğe bağlı)
                        <input
                          value={notu}
                          onChange={(e) => setNotu(e.target.value)}
                          placeholder="ör. çekirdek eksik — kalan perşembe gönderilecek"
                          style={{
                            width: '100%', marginTop: 6, padding: '9px 12px', borderRadius: 9,
                            border: `1px solid ${R.cizgi3}`, background: R.girinti,
                            color: R.krem, fontSize: 13, fontFamily: 'inherit', outline: 'none',
                          }}
                        />
                      </label>

                      <div style={{ display: 'flex', gap: 9, marginTop: 13, paddingTop: 13, borderTop: `1px solid ${R.cizgi2}`, flexWrap: 'wrap' }}>
                        <button
                          disabled={busy}
                          onClick={() => sevkKaydet(true)}
                          style={{
                            padding: '10px 18px', borderRadius: 11, border: 'none',
                            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                            cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                            boxShadow: '0 6px 18px rgba(217,154,78,.24)',
                          }}
                        >
                          Yola çıkar — şubede teslim al aç
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => sevkKaydet(false)}
                          style={{
                            padding: '10px 16px', borderRadius: 11, border: `1px solid ${R.cizgi3}`,
                            background: 'transparent', color: R.not, fontSize: 12.5, fontWeight: 600,
                            fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                          }}
                        >
                          Hazırlığı kaydet (stok çıkmaz)
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DEPO STOK ══════════════════════════════
  if (gorunum === 'depo') {
    if (depoHata) return <HataBandi mesaj={depoHata} onTekrar={depoYukle} />;
    if (!depo) return <Yukleniyor />;
    const subeler = Array.isArray(depo.subeler) ? depo.subeler : [];
    const kalemler = Array.isArray(depo.kalemler) ? depo.kalemler : [];
    const adetAl = (k) => (depoSube ? sayi((k.adetler || {})[depoSube]) : sayi(k.toplam));
    const durumAl = (k) => {
      const a = adetAl(k); const m = sayi(k.min_stok);
      if (m <= 0) return { ad: 'eşik yok', renk: R.not2 };
      if (a < m) return { ad: 'kritik', renk: R.kirmizi };
      if (a < m * 1.5) return { ad: 'düşük', renk: R.amber };
      return { ad: 'yeterli', renk: R.yesil };
    };
    const kritik = kalemler.filter((k) => sayi(k.min_stok) > 0 && adetAl(k) < sayi(k.min_stok));
    const dusuk = kalemler.filter((k) => {
      const a = adetAl(k); const m = sayi(k.min_stok);
      return m > 0 && a >= m && a < m * 1.5;
    });
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kritik kalem', deger: String(kritik.length), alt: 'minimumun altında', renk: kritik.length > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Düşük kalem', deger: String(dusuk.length), alt: 'eşiğe yaklaşıyor', renk: dusuk.length > 0 ? R.amber : R.krem },
          { etiket: 'Toplam kalem', deger: String(kalemler.length), alt: 'stok kartı' },
          { etiket: 'Kapsam', deger: depoSube ? (subeler.find((s) => s.id === depoSube)?.ad || 'şube') : 'Tüm şubeler', alt: 'aşağıdan değiştir' },
        ]} />

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {[{ id: '', ad: 'Tümü' }, ...subeler].map((s) => {
            const aktif = depoSube === s.id;
            return (
              <div
                key={s.id || 'tum'}
                onClick={() => setDepoSube(s.id)}
                style={{
                  padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: aktif ? `${R.bakir}22` : R.girinti,
                  color: aktif ? R.bakir : R.not,
                  border: `1px solid ${aktif ? `${R.bakir}55` : R.cizgi3}`,
                }}
              >
                {s.ad}
              </div>
            );
          })}
        </div>

        {kalemler.length === 0 ? (
          <BosDurum metin="Depo stok kartı yok — henüz stok tanımlanmamış." />
        ) : (
          <Tablo
            baslik={`Depo stok durumu · ${depoSube ? (subeler.find((s) => s.id === depoSube)?.ad || '') : 'tüm şubeler toplamı'}`}
            not="satıra tıkla → şube kırılımı"
            kolonlar={[
              { ad: 'Kalem' }, { ad: 'Kategori' }, { ad: 'Mevcut', sag: 1 },
              { ad: 'Kritik seviye', sag: 1 }, { ad: 'Min\'e oran', sag: 1 }, { ad: 'Durum' },
            ]}
            satirlar={[...kalemler]
              .sort((a, b) => {
                const da = durumAl(a).ad; const db2 = durumAl(b).ad;
                const sira = { kritik: 0, 'düşük': 1, yeterli: 2, 'eşik yok': 3 };
                return (sira[da] ?? 9) - (sira[db2] ?? 9);
              })
              .slice(0, 120)
              .map((k) => {
                const a = adetAl(k); const m = sayi(k.min_stok); const d = durumAl(k);
                const oran = m > 0 ? a / m : null;
                return {
                  id: k.kalem_kodu,
                  _kalem: k,
                  hucreler: [
                    { v: k.kalem_adi, kalin: true },
                    { v: k.kategori || 'Diğer', renk: R.not },
                    { v: String(a), mono: true, sag: true, renk: d.renk, kalin: d.ad === 'kritik' },
                    { v: m > 0 ? String(m) : '—', mono: true, sag: true, renk: R.not },
                    oran == null
                      ? { v: '—', sag: true, renk: R.not3 }
                      : { v: `×${oran.toFixed(1)}`, bar: Math.max(3, Math.min(100, Math.round((oran / 2) * 100))), sag: true, renk: d.renk },
                    { v: d.ad, rozet: d.renk },
                  ],
                };
              })}
            onSatir={(s) => {
              const k = s._kalem; const m = sayi(k.min_stok); const d = durumAl(k);
              onCekmece?.({
                tip: 'STOK KALEMİ',
                baslik: k.kalem_adi,
                alt: `${k.kategori || 'Diğer'} · ${d.ad}`,
                kpi: [
                  { etiket: depoSube ? 'Şube mevcut' : 'Toplam mevcut', deger: String(adetAl(k)), renk: d.renk },
                  { etiket: 'Kritik seviye', deger: m > 0 ? String(m) : 'tanımsız' },
                  { etiket: 'Şube sayısı', deger: String(Object.keys(k.adetler || {}).length) },
                  { etiket: 'Durum', deger: d.ad, renk: d.renk },
                ],
                listeBaslik: 'Şube kırılımı',
                satirlar: subeler.map((sb) => ({
                  ad: sb.ad,
                  detay: '',
                  tutar: `${sayi((k.adetler || {})[sb.id])} adet`,
                })),
                not: m > 0 && adetAl(k) < m
                  ? 'Minimumun altında — sipariş oluşturma ve hareket geçmişi Operasyon Merkezi\'nde.'
                  : 'Hareket geçmişi ve sipariş akışı Operasyon Merkezi\'nde.',
                aksiyonAd: 'Operasyon Merkezi\'ni aç',
                _hedef: 'ops-merkez',
              });
            }}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: BARDAK & ÜRÜN SAYIMI ═══════════════════
  // SALT-OKUR: sayım şubede personel kilidiyle yapılır; masaüstü onay + iz izler.
  if (gorunum === 'sayim') {
    if (sayimHata) return <HataBandi mesaj={sayimHata} onTekrar={sayimYukle} />;
    if (!sayim) return <Yukleniyor />;
    const gorevler = Array.isArray(sayim.gorevler) ? sayim.gorevler : [];
    const farkli = gorevler.filter((g) => sayi(g.fark_sayisi) > 0);
    const iz = sayimIz || {};
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Onay bekleyen sayım', deger: String(gorevler.length), alt: 'sahip onayı gerekli', renk: gorevler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Fark bulunan', deger: String(farkli.length), alt: 'sistemle uyuşmayan görev', renk: farkli.length > 0 ? R.kirmizi : R.krem },
          { etiket: 'Ezilen kalem (iz)', deger: String(sayi(iz.ezilen_kalem)), alt: 'onayla stok değişti', renk: sayi(iz.ezilen_kalem) > 0 ? R.amber : R.krem },
          { etiket: 'Karar dağılımı', deger: `${sayi(iz.karar_sayim)} / ${sayi(iz.karar_sistem)}`, alt: 'sayım kabul / sistem korundu' },
        ]} />

        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ model</span>
          Sayım ŞUBEDE personel kilidiyle yapılır (çift-tık keypad) — masaüstü yalnız sonucu onaylar.
          Onay ekranı: <b style={{ color: R.metin2 }}>Stok Sayım</b> sayfası.
        </div>

        {gorevler.length === 0 ? (
          <BosDurum metin="Onay bekleyen sayım yok — tüm sayımlar işlenmiş." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {gorevler.map((g) => {
              const fark = sayi(g.fark_sayisi);
              const acik = sayimAcikId === String(g.id);
              const det = sayimDetay[String(g.id)];
              return (
                <div key={g.id} style={{
                  ...kartYuzey, padding: 0,
                  border: acik ? `1px solid ${R.bakir}55` : fark > 0 ? `1px solid ${R.amber}44` : kartYuzey.border,
                }}>
                  <div
                    onClick={() => sayimGorevAc(String(g.id))}
                    style={{
                      padding: '13px 18px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 170 }}>
                      <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                        {g.sube_adi || '—'} · {g.kapsam_tip || 'sayım'}
                      </div>
                      <div style={{ fontSize: 11.5, color: R.not2, marginTop: 3 }}>
                        {g.personel_ad || '—'} · {sayi(g.kalem_sayisi)} kalem · {tarihKisa(g.tamamlama_ts)} {saatKisa(g.tamamlama_ts)}
                      </div>
                    </div>
                    <span style={rozetHap(fark > 0 ? R.kirmizi : R.yesil)}>
                      {fark > 0 ? `${fark} fark` : 'fark yok'}
                    </span>
                    <span style={rozetHap(R.amber)}>onay bekliyor</span>
                    <span style={{ fontSize: 11, color: R.not3 }}>{acik ? 'kapat ▲' : 'incele ▼'}</span>
                  </div>

                  {acik && (
                    <div style={{ padding: '0 18px 16px', borderTop: `1px solid ${R.cizgi2}` }}>
                      {!det ? (
                        <div style={{ padding: '18px 0', fontSize: 12.5, color: R.not, textAlign: 'center' }}>
                          Kalem farkları yükleniyor…
                        </div>
                      ) : det.hata ? (
                        <div style={{ padding: '14px 0', fontSize: 12.5, color: R.kirmizi }}>
                          Detay alınamadı — Stok Sayım ekranından incelenebilir.
                        </div>
                      ) : (
                        <>
                          {/* Blueprint'in sayım kart grid'i — SALT-OKUR uyarlama:
                              −/+ keypad yerine sistem→sayılan karşılaştırması.
                              Fark olan kart amber tonlu (tasarımdaki kutuStil kuralı). */}
                          <div style={{
                            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                            gap: 11, marginTop: 13,
                          }}>
                            {(det.satirlar || []).map((k, i) => {
                              const f = sayi(k.fark);
                              const fRenk = f === 0 ? R.yesil : f < 0 ? R.kirmizi : R.amber;
                              return (
                                <div key={i} style={{
                                  padding: '13px 15px', borderRadius: 14,
                                  border: `1px solid ${f !== 0 ? `${R.amber}44` : 'rgba(243,233,220,.08)'}`,
                                  background: f !== 0
                                    ? 'linear-gradient(165deg, #2E2412, #251B09)'
                                    : 'linear-gradient(165deg, #2C2116, #241A0E)',
                                }}>
                                  <div style={{ fontSize: 13, fontWeight: 600 }}>{k.kalem_adi}</div>
                                  <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                                    sistemde {sayi(k.sistem_adet)}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 9 }}>
                                    <span style={{ fontFamily: F.mono, fontSize: 20, fontWeight: 700 }}>
                                      {sayi(k.sayilan_adet)}
                                    </span>
                                    <span style={{ fontSize: 10, color: R.not2 }}>sayılan</span>
                                  </div>
                                  <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    paddingTop: 8, marginTop: 9, borderTop: `1px solid ${R.cizgi2}`,
                                  }}>
                                    <span style={{ fontSize: 11, color: R.not2 }}>fark</span>
                                    <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, color: fRenk }}>
                                      {f === 0 ? '✓ yok' : `${f > 0 ? '+' : ''}${f}`}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {det.not_aciklama && (
                            <div style={{ fontSize: 11.5, color: R.not, marginTop: 11 }}>
                              Personel notu: {det.not_aciklama}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 9, marginTop: 13, paddingTop: 13, borderTop: `1px solid ${R.cizgi2}` }}>
                            <button
                              onClick={() => onKopru?.('stok-sayim')}
                              style={{
                                padding: '9px 17px', borderRadius: 10, border: 'none',
                                background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                                fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                                boxShadow: '0 6px 18px rgba(217,154,78,.24)',
                              }}
                            >
                              Onayla / geri al — Stok Sayım ekranı
                            </button>
                            <span style={{ fontSize: 11, color: R.not3, alignSelf: 'center' }}>
                              stok ancak onayla değişir
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {Array.isArray(iz.ornekler) && iz.ornekler.length > 0 && (
          <Tablo
            baslik="Düzeltme izi — sayımın ezdiği son kalemler"
            not="envanter_duzeltme defteri (salt-okur)"
            kolonlar={[
              { ad: 'Zaman' }, { ad: 'Kalem' }, { ad: 'Eski', sag: 1 },
              { ad: 'Sayılan', sag: 1 }, { ad: 'Yeni', sag: 1 }, { ad: 'Δ', sag: 1 }, { ad: 'Karar' },
            ]}
            satirlar={iz.ornekler.slice(0, 12).map((r, i) => {
              const delta = sayi(r.delta);
              return {
                id: `iz-${i}`,
                hucreler: [
                  { v: `${tarihKisa(r.olusturma)} ${saatKisa(r.olusturma)}`, mono: true, renk: R.not },
                  { v: r.kalem_adi || '—', kalin: true },
                  { v: String(sayi(r.eski_adet)), mono: true, sag: true, renk: R.not },
                  { v: String(sayi(r.sayilan_adet)), mono: true, sag: true },
                  { v: String(sayi(r.yeni_adet)), mono: true, sag: true },
                  { v: `${delta > 0 ? '+' : ''}${delta}`, mono: true, sag: true, renk: delta === 0 ? R.not : delta > 0 ? R.yesil : R.kirmizi, kalin: true },
                  { v: r.karar === 'sayim' ? 'sayım kabul' : 'sistem korundu', rozet: r.karar === 'sayim' ? R.amber : R.mavi },
                ],
              };
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: STOK HAREKETİ ══════════════════════════
  if (gorunum === 'hareket') {
    if (hareketHata) return <HataBandi mesaj={hareketHata} onTekrar={hareketYukle} />;
    if (!hareket) return <Yukleniyor />;
    const bugun = bugunYerelISO();
    const turCoz = (t) => {
      const u = String(t || '').toUpperCase();
      if (u.includes('FIRE') || u.includes('IMHA')) return { ad: 'fire', renk: R.kirmizi };
      if (u.includes('SAYIM') || u.includes('DUZELT')) return { ad: 'sayım', renk: R.amber };
      if (u.includes('GIRIS') || u.includes('KABUL') || u.includes('TESLIM')) return { ad: 'giriş', renk: R.yesil };
      if (u.includes('SEVK') || u.includes('CIKIS') || u.includes('SATIS') || u.includes('URUN_AC')) return { ad: 'çıkış', renk: R.bakir };
      return { ad: (t || '—').toLowerCase(), renk: R.mavi };
    };
    const bugunku = hareket.filter((h) => String(h.zaman || '').slice(0, 10) === bugun);
    const say = (f) => hareket.filter(f).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün kayıt', deger: String(bugunku.length), alt: 'stok hareketi' },
          { etiket: 'Giriş (3 gün)', deger: String(say((h) => turCoz(h.hareket_turu).ad === 'giriş')), alt: 'teslim + kabul', renk: R.yesil },
          { etiket: 'Çıkış (3 gün)', deger: String(say((h) => turCoz(h.hareket_turu).ad === 'çıkış')), alt: 'sevk + ürün aç' },
          { etiket: 'Fire + sayım (3 gün)', deger: String(say((h) => ['fire', 'sayım'].includes(turCoz(h.hareket_turu).ad))), alt: 'düzeltme dahil', renk: say((h) => turCoz(h.hareket_turu).ad === 'fire') > 0 ? R.kirmizi : R.krem },
        ]} />
        {hareket.length === 0 ? (
          <BosDurum metin="Son 3 günde stok hareketi kaydı yok." />
        ) : (
          <Tablo
            baslik="Stok hareketi · son 3 gün"
            not="append-only defter — satırlar değiştirilemez"
            kolonlar={[
              { ad: 'Zaman' }, { ad: 'Tür' }, { ad: 'Kalem' }, { ad: 'Şube' },
              { ad: 'Miktar', sag: 1 }, { ad: 'Önce → sonra', sag: 1 }, { ad: 'Kaynak' },
            ]}
            satirlar={hareket.slice(0, 60).map((h, i) => {
              const tur = turCoz(h.hareket_turu);
              const m = sayi(h.miktar);
              return {
                id: h.id || `h-${i}`,
                hucreler: [
                  { v: `${tarihKisa(h.zaman)} ${saatKisa(h.zaman)}`, mono: true, renk: R.not },
                  { v: tur.ad, rozet: tur.renk },
                  { v: h.kalem_adi || h.kalem_kodu || '—', kalin: true },
                  { v: h.sube_ad || '—', renk: R.not },
                  { v: `${m > 0 ? '+' : ''}${m}`, mono: true, sag: true, renk: m > 0 ? R.yesil : m < 0 ? R.kirmizi : R.not, kalin: true },
                  { v: `${sayi(h.onceki_miktar)} → ${sayi(h.sonraki_miktar)}`, mono: true, sag: true, renk: R.not },
                  { v: [h.kaynak_tip, h.personel_ad].filter(Boolean).join(' · ') || '—', renk: R.not2 },
                ],
              };
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: KONTROL KULESİ ═════════════════════════
  if (gorunum === 'kule') {
    if (kuleHata) return <HataBandi mesaj={kuleHata} onTekrar={kuleYukle} />;
    if (!kule || subeOzet == null) return <Yukleniyor />;
    const ozet = kule.ozet || {};
    const acik = ['bekliyor', 'depoda', 'yolda', 'toptanci_bekliyor', 'uyumsuzluk']
      .reduce((t, k) => t + sayi(ozet[k]), 0);
    const yuklu = subeOzet.filter((s) => sayi(s.toplam) > 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açık sipariş', deger: String(acik), alt: 'son 14 gün' },
          { etiket: 'Uyumsuzluk', deger: String(sayi(ozet.uyumsuzluk)), alt: sayi(ozet.uyumsuzluk) > 0 ? 'müdahale gerekli' : 'temiz', renk: sayi(ozet.uyumsuzluk) > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Yolda', deger: String(sayi(ozet.yolda) + sayi(ozet.toptanci_bekliyor)), alt: 'kabul bekleyen', renk: R.bakir },
          { etiket: 'Tamamlanan', deger: String(sayi(ozet.tamamlandi)), alt: 'son 14 gün', renk: R.yesil },
        ]} />
        {yuklu.length === 0 ? (
          <BosDurum metin="Son 30 günde depo olarak atanan şube yok — sevkiyat trafiği bulunmuyor." />
        ) : (
          <Tablo
            baslik="Kontrol kulesi · depo bazlı sevkiyat yükü"
            not="satıra tıkla → o deponun hazırlık kuyruğu"
            kolonlar={[
              { ad: 'Depo şube' }, { ad: 'Tip' }, { ad: 'Hazırlıkta', sag: 1 },
              { ad: 'Gönderildi', sag: 1 }, { ad: 'Teslim edildi', sag: 1 }, { ad: 'Son talep' }, { ad: 'Durum' },
            ]}
            satirlar={yuklu.map((s) => ({
              id: s.depo_sube_id,
              hucreler: [
                { v: s.depo_sube_adi, kalin: true },
                { v: s.sube_tipi || 'normal', renk: R.not },
                { v: String(sayi(s.hazirlikta)), mono: true, sag: true, renk: sayi(s.hazirlikta) > 0 ? R.mavi : R.not, kalin: sayi(s.hazirlikta) > 0 },
                { v: String(sayi(s.gonderildi)), mono: true, sag: true },
                { v: String(sayi(s.teslim_edildi)), mono: true, sag: true, renk: R.yesil },
                { v: s.son_talep_tarih ? tarihKisa(s.son_talep_tarih) : '—', renk: R.not },
                sayi(s.hazirlikta) > 0
                  ? { v: 'hazırlık var', rozet: R.mavi }
                  : { v: 'temiz', rozet: R.yesil },
              ],
            }))}
            onSatir={() => onGorunum?.('sevkiyat')}
          />
        )}
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
