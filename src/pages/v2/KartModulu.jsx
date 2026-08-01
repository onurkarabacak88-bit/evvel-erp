// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Kartlar & Borç modülü (5 görünüm)
//
// Tasarım: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html
//          ICERIK → kart.ozet / kart.kartlar / kart.koc / kart.hareket / kart.ekstre
//
// Bu modül, mevcut 7 dağınık kart sayfasının işini tek yerde toplar:
//   Kartlar · KartMerkez · KartYonetimi · KartAnaliz · KartEkstreAnaliz ·
//   KartHareketleri · EkstreYukle
//
// Veri uçları (hepsi salt-okur):
//   /kartlar                     → limit, döngü, kesim, son ödeme, asgari
//   /kartlar/borc-faiz-ozet      → kart bazlı borç + ödenen faiz + eksik ekstre
//   /kartlar/borc-kocu           → strateji sıralaması, asgari toplamı, öncelik
//   /kartlar/harcama-ozet        → işletme / şahsi / belirsiz kırılımı
//   /kart-hareketleri            → hareket defteri
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, Serit, BorcKocu } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');

// ⚠️ Türkçe büyük-İ tuzağı: JS'in varsayılan toLowerCase()'i 'İ' → 'i̇' (birleşik
// noktalı i) üretir, ekranda "geci̇kti̇" gibi bozuk çıkar. Daima tr yerelini kullan.
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');
// ⚠️ İKİ YÖNLÜ TÜRKÇE-I TUZAĞI:
//   trKucuk  → 'İ'yi doğru çevirir ama ASCII 'I'yı NOKTASIZ 'ı' yapar.
//              'FAIZ' → 'faız', 'CIRO' → 'cıro' (yanlış).
//   slugAd   → veritabanı slug'ları (ASCII, BÜYÜK, alt çizgili) için: düz
//              toLowerCase + alt çizgi → boşluk. 'ANLIK_GIDER' → 'anlik gider'.
// Kural: TÜRKÇE metinde trKucuk, DB SLUG'ında slugAd.
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
/** '2026-07-22' → '22 Tem' (tasarımdaki kısa tarih biçimi). */
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

/** Kart döngü durumu — tasarımdaki DONGU sabitinin veriden türetilmiş hâli. */
const DONGU = {
  gecikti: { ad: 'GECİKTİ', renk: R.kirmizi },
  ekstre_bekleniyor: { ad: 'EKSTRE BEKLENİYOR', renk: R.amber },
  odeme_bekliyor: { ad: 'Ödeme bekliyor', renk: R.mavi },
  odendi: { ad: 'Ödendi', renk: R.yesil },
  yuklendi: { ad: 'Yüklendi', renk: R.yesil },
};

// Önceki dönemin kapanış hâli (finans_core.kart_aktif_donem:1287).
// "asgari_odendi" tam ödeme DEĞİLDİR: kalan anapara devreder ve faiz işler.
const ONCEKI_DURUM = {
  tam: { ad: 'tam ödendi', aciklama: 'geçen dönem tamamı kapandı — devreden yük yok', renk: R.yesil },
  asgari_odendi: { ad: 'asgari ödendi', aciklama: 'asgari karşılandı ama tamamı değil — kalan anapara devretti, faiz işledi', renk: R.amber },
  asgari_odenmedi: { ad: 'asgari ÖDENMEDİ', aciklama: 'asgari bile karşılanmadı — gecikme faizi + kart kapatma riski', renk: R.kirmizi },
  yok: { ad: 'yok', aciklama: 'önceki dönem verisi yok (yeni kart ya da ilk ekstre)', renk: R.not },
};

/**
 * Bir kartın döngü durumunu belirler. Sıra önemli: gecikme her şeyin önünde,
 * ekstre eksikliği ödeme beklemenin önünde (borç tahminî olur).
 */
function donguDurumu(k, ekstreVar) {
  const gun = sayi(k.gun_kaldi);
  const borc = sayi(k.guncel_borc);
  const asgariTamam = !!k.asgari_karsilandi;
  if (borc > 0 && gun < 0 && !asgariTamam) return 'gecikti';
  if (!ekstreVar) return 'ekstre_bekleniyor';
  if (asgariTamam) return 'odendi';
  if (borc > 0 && gun <= 5) return 'odeme_bekliyor';
  return 'yuklendi';
}

const kisalt = (t, n = 40) => {
  const x = String(t || '').trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};

const gunMetni = (g) => {
  const n = Math.trunc(sayi(g));
  if (n < 0) return `${Math.abs(n)} gün geçti`;
  if (n === 0) return 'bugün';
  return `${n} gün`;
};

const kMini = {
  padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};

export default function KartModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [ozet, setOzet] = useState(null);
  const [harcama, setHarcama] = useState(null);
  const [hareketler, setHareketler] = useState([]);
  const [koc, setKoc] = useState(null);
  // /kartlar/borc-projeksiyon — çok aylık GERÇEK faiz simülasyonu (çığ/kartopu)
  const [proj, setProj] = useState(null);
  const [strateji, setStrateji] = useState('cig');
  const [nakit, setNakit] = useState(200000);
  // ── YERLİ EKSTRE YÜKLEME (köprü kaldırma turu, 2026-07-30) ─────────────────
  // Klasik EkstreYukle.jsx akışı AYNEN: PDF → /kartlar/ekstre-yukle (önizleme,
  // kayıt yazmaz) → ⚡ tek-tık mutabakat (import + eşik-onaylı devir kapama).
  const [eksModal, setEksModal] = useState(false);
  const [eksYukleniyor, setEksYukleniyor] = useState(false);
  const [eksSonuc, setEksSonuc] = useState(null);
  const [eksHata, setEksHata] = useState('');
  const [eksDosyaAdi, setEksDosyaAdi] = useState('');
  const [eksLastFile, setEksLastFile] = useState(null);
  const [eksTtBusy, setEksTtBusy] = useState(false);
  const [eksImpSonuc, setEksImpSonuc] = useState(null);
  const [eksOnaySor, setEksOnaySor] = useState(null);   // eşik üstü fark onayı {fark, ekstreBorc, yeniBorc, impOzet}
  const [kartEkleBusy, setKartEkleBusy] = useState(false);
  const [manForm, setManForm] = useState(null);          // manuel ekstre {kart_id, donem, son_odeme, donem_borcu, asgari_tutar, faiz_orani}
  const [manBusy, setManBusy] = useState(false);
  // ── YERLİ KART CRUD (köprü kaldırma turu) — klasik Kartlar.jsx sözleşmesi ──
  // PIN'li tehlikeli uçlar (kalıcı-sil / ledger-sıfırla / tam-sıfırla) BİLEREK
  // taşınmadı — sahip kararına kadar klasikte kalır.
  const [kartForm, setKartForm] = useState(null);        // {duzenleId?, kart_adi, banka, ...}
  const [kartMesgul, setKartMesgul] = useState(false);
  // Ekstre faizi üretimi (2026-07-31) — gece motoru zaten yazar, bu ELLE tetikler
  const [faizMesgul, setFaizMesgul] = useState(false);
  const [faizSonuc, setFaizSonuc] = useState(null);      // {yazilan, kartlar[]}
  // Ekstre dönemi silme (2026-07-31) — GERİ ALINAMAZ, iki adımlı onay şart
  const [donemSil, setDonemSil] = useState(null);        // {kartId, kartAd, donem}
  const [donemSilMesgul, setDonemSilMesgul] = useState(false);
  const [kartPasifSor, setKartPasifSor] = useState('');
  // ── YERLİ KART ANALİZİ (köprü kaldırma turu, 2026-07-30) ──────────────────
  // Klasik KartEkstreAnaliz'in iki bloğu: aylık borç/faiz eğrisi + kategori
  // dağılımı (/kartlar/analiz) ve dönem arşivi (/kartlar/ekstre-arsiv).
  const [analiz, setAnaliz] = useState(null);
  const [arsiv, setArsiv] = useState(null);

  /**
   * Ekstre faizini hesapla-yaz. Gece motoru bunu zaten koşar; buradaki düğme
   * ekstre elle yüklendiğinde beklememek içindir. Sunucu kart kart durum döner
   * (yazildi / zaten_yazilmis / tam_odendi / ekstre_yok / henuz_* / faiz_cok_kucuk)
   * — sayıyı özetlemek yerine NEDENİ göstermek işin aslı.
   */
  const faizUret = async () => {
    setFaizMesgul(true);
    setFaizSonuc(null);
    try {
      const r = await api('/kartlar/faiz-uret', { method: 'POST' });
      const satirlar = Array.isArray(r?.kartlar) ? r.kartlar : [];
      const yazilan = satirlar.filter((k) => k?.durum === 'yazildi');
      setFaizSonuc({ donem: r?.donem || '', yazilan: yazilan.length, kartlar: satirlar });
      onToast?.(yazilan.length
        ? `${yazilan.length} karta faiz yazıldı — aşağıda kart kart neden yazıldığı var`
        : 'Faiz yazılacak kart çıkmadı — sebepleri aşağıda kart kart yazılı');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Faiz üretilemedi');
    } finally {
      setFaizMesgul(false);
    }
  };

  /**
   * Bir kartın TEK AYINI sil. Sunucu o aya ait HARCAMA/FAİZ hareketlerini ve
   * dönem snapshot'ını GERÇEKTEN siler (soft-delete değil, geri alma ucu yok).
   * ÖDEME/DEVİR hareketlerine dokunmaz — onlar kasa tarafının kaydı.
   * Kullanım amacı: yanlış ekstre yüklendiyse silip doğrusunu yüklemek.
   */
  const donemSilUygula = async () => {
    const d = donemSil;
    if (!d?.kartId || !d?.donem) return;
    setDonemSilMesgul(true);
    try {
      const r = await api(`/kartlar/${encodeURIComponent(d.kartId)}/ekstre-donem/${encodeURIComponent(d.donem)}`, { method: 'DELETE' });
      onToast?.(`${r?.kart_adi || d.kartAd} · ${kisaTarih(d.donem)} dönemi silindi — ${sayi(r?.silinen_hareket)} hareket kalktı, şimdi doğru ekstreyi yükleyebilirsin`);
      setDonemSil(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Dönem silinemedi');
    } finally {
      setDonemSilMesgul(false);
    }
  };

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/kartlar').catch(() => []),
      api('/kartlar/borc-faiz-ozet').catch(() => null),
      api('/kartlar/harcama-ozet').catch(() => null),
      api('/kart-hareketleri?limit=200').catch(() => []),
      api('/kartlar/analiz').catch(() => null),
      api('/kartlar/ekstre-arsiv').catch(() => null),
    ]).then(([k, o, h, hr, an, ar]) => {
      setAnaliz(an);
      setArsiv(ar);
      setKartlar(Array.isArray(k) ? k : []);
      setOzet(o);
      setHarcama(h);
      setHareketler(Array.isArray(hr) ? hr : []);
      if (!o && !(Array.isArray(k) && k.length)) setHata('Kart verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  // ── KART HAREKETİ EYLEMLERİ (2026-07-31) ──────────────────────────────────
  // v2 hareketleri gösteriyordu ama sınıflandıramıyor/silemiyordu.
  const [khModal, setKhModal] = useState(null);   // {tip: 'sil'|'tip', hareket, harcama?}
  const [khMesgul, setKhMesgul] = useState(false);

  const khUygula = async () => {
    const m = khModal;
    if (!m) return;
    setKhMesgul(true);
    try {
      if (m.tip === 'sil') {
        await api(`/kart-hareketleri/${m.hareket.id}`, { method: 'DELETE' });
        onToast?.('✓ Hareket silindi');
      } else {
        // tip SORGU parametresi — gövdeye koyulursa 422 döner
        await api(`/kart-hareketleri/${m.hareket.id}/harcama-tipi?tip=${m.harcama}`, { method: 'POST' });
        onToast?.(m.harcama === 'isletme' ? '✓ İşletme harcaması olarak işaretlendi' : '✓ Şahsi harcama olarak işaretlendi');
      }
      setKhModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setKhMesgul(false); }
  };

  const khModalBlok = khModal && (() => {
    const kapat = () => { if (!khMesgul) setKhModal(null); };
    const sil = khModal.tip === 'sil';
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.72)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 430, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
            {sil ? 'Hareketi sil' : 'Harcama tipini belirle'}
          </div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{khModal.hareket?.aciklama || 'Hareket'}</b>
            {khModal.hareket?.tutar != null ? ` · ${fmt(sayi(khModal.hareket.tutar))} ₺` : ''}
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
            {sil
              ? 'Hareket kart defterinden kaldırılır. Ekstreden gelen bir satırsa bir sonraki içe aktarımda geri gelebilir — kalıcı düzeltme ekstre tarafında yapılır.'
              : 'İşletme/şahsi ayrımı gider ve KDV hesabına girer; belirsiz kalan hareketler maliyete yazılmaz.'}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={khMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={khMesgul} onClick={khUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              border: sil ? `1px solid ${R.kirmizi}55` : 'none',
              background: sil ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: sil ? R.kirmizi : '#1C1309',
            }}>{khMesgul ? 'İşleniyor…' : (sil ? 'Sil' : 'İşaretle')}</button>
          </div>
        </div>
      </div>
    );
  })();

  // ── KART KALICI SİL + LEDGER SIFIRLA (2026-07-31) ─────────────────────────
  // "Pasife al" zaten vardı ve doğru varsayılan o (defter bütünlüğü). Bu ikisi
  // İSTİSNA işlemler: ikisi de işletme PIN'i ister, sunucu doğrular.
  const [ktkModal, setKtkModal] = useState(null);   // {tip, kart?}
  const [ktkPin, setKtkPin] = useState('');
  const [ktkYazi, setKtkYazi] = useState('');
  const [ktkMesgul, setKtkMesgul] = useState(false);

  const ktkKapat = () => { if (!ktkMesgul) { setKtkModal(null); setKtkPin(''); setKtkYazi(''); } };

  const ktkUygula = async () => {
    const m = ktkModal;
    if (!m) return;
    if (!/^\d{4}$/.test(ktkPin.trim())) { onToast?.('İşletme onay PIN kodu 4 haneli olmalı'); return; }
    if (m.tip === 'ledger-hepsi' && ktkYazi.trim() !== 'TUM KARTLAR') {
      onToast?.('Onay kutusuna tam olarak «TUM KARTLAR» yazın'); return;
    }
    setKtkMesgul(true);
    try {
      if (m.tip === 'kalici-sil') {
        await api(`/kartlar/${m.kart.id}/kalici-sil`, { method: 'POST', body: { onay_pin: ktkPin.trim() } });
        onToast?.('✓ Kart kalıcı olarak silindi');
      } else if (m.tip === 'ledger') {
        await api(`/kartlar/${m.kart.id}/ledger-sifirla`, { method: 'POST', body: { onay_pin: ktkPin.trim(), hepsi: false } });
        onToast?.('✓ Kart hareketleri iptal edildi — borç sıfırlandı');
      } else if (m.tip === 'ledger-hepsi') {
        await api('/kartlar/__hepsi__/ledger-sifirla', { method: 'POST', body: { onay_pin: ktkPin.trim(), hepsi: true } });
        onToast?.('✓ Tüm kartların hareketleri iptal edildi');
      }
      ktkKapat();
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız — PIN hatalı olabilir');
    } finally { setKtkMesgul(false); }
  };

  const ktkModalBlok = ktkModal && (() => {
    const T = {
      'kalici-sil': {
        baslik: 'Kartı kalıcı sil',
        anlat: 'Kart kayıtlardan TAMAMEN kaldırılır ve geri gelmez. Normalde doğru işlem «Pasife al»dır — o kartı kullanımdan çıkarır ama geçmiş hareketleri ve defter bütünlüğünü korur. Kalıcı silme yalnız yanlış açılmış / hiç kullanılmamış kart içindir.',
        buton: 'Kalıcı sil',
      },
      'ledger': {
        baslik: 'Kart hareketlerini sıfırla',
        anlat: 'Bu kartın tüm hareketleri iptal edilir ve kart borcu sıfırlanır. Bozuk/karışık ekstre içe aktarımını temizlemek ve açılış devri kurmadan ÖNCE çalıştırmak içindir. Manuel kasa hareketleriniz bundan etkilenir — devam etmeden emin ol.',
        buton: 'Hareketleri sıfırla',
      },
      'ledger-hepsi': {
        baslik: 'TÜM kartların hareketlerini sıfırla',
        anlat: 'Bütün aktif kartların hareketleri iptal edilir ve borçları sıfırlanır. Bu, kart defterini baştan kurmak demektir — yalnız açılış devri öncesi tek seferlik temizlik için. Yanlışlıkla çalıştırılırsa tüm kart borç geçmişi silinir.',
        buton: 'Hepsini sıfırla',
      },
    }[ktkModal.tip] || {};
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) ktkKapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 135, background: 'rgba(10,6,2,.75)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 470, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6, color: R.kirmizi }}>
            {T.baslik}
          </div>
          {ktkModal.kart && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              <b>{ktkModal.kart.ad || ktkModal.kart.kart_adi || ktkModal.kart.banka}</b>
            </div>
          )}
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.7, marginBottom: 14 }}>{T.anlat}</div>

          {ktkModal.tip === 'ledger-hepsi' && (
            <>
              <label style={{ display: 'block', fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 5 }}>
                Onaylamak için «TUM KARTLAR» yazın
              </label>
              <input value={ktkYazi} onChange={(e) => setKtkYazi(e.target.value)} autoFocus style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                fontSize: 13, fontFamily: 'inherit', outline: 'none', marginBottom: 8,
              }} />
            </>
          )}
          <label style={{ display: 'block', fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 5 }}>
            İşletme onay PIN kodu (4 hane)
          </label>
          <input type="password" inputMode="numeric" maxLength={4} value={ktkPin} autoComplete="off"
            onChange={(e) => setKtkPin(e.target.value.replace(/\D/g, ''))} style={{
              width: 140, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
              border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
              fontSize: 13, fontFamily: 'inherit', outline: 'none', letterSpacing: 6,
            }} />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={ktkMesgul} onClick={ktkKapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={ktkMesgul || ktkPin.length !== 4} onClick={ktkUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              fontFamily: 'inherit', border: `1px solid ${R.kirmizi}55`,
              background: `${R.kirmizi}26`, color: R.kirmizi,
              opacity: ktkPin.length === 4 ? 1 : 0.45,
            }}>{ktkMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  useEffect(yukle, []);

  // Borç Koçu ayrı uç — strateji/nakit değişince tazelenir.
  useEffect(() => {
    let iptal = false;
    api(`/kartlar/borc-kocu?strateji=${strateji}&nakit=${sayi(nakit)}`)
      .then(d => { if (!iptal) setKoc(d); })
      .catch(() => { if (!iptal) setKoc(null); });
    // ⚠️ KURTULUŞ SÜRESİ SUNUCUDAN — v2 bunu `toplamBorc / netAylik` diye
    // KENDİ TAHMİN EDİYORDU. O kaba oran faizin BİLEŞİKLENMESİNİ ve stratejiyi
    // (çığ/kartopu) yok sayar; sunucu ay ay gerçek simülasyon koşuyor ve
    // ayrıca "sadece asgari ödersen" senaryosuyla karşılaştırıyor.
    // Kart limit_doluluk vakasıyla aynı sınıf tuzak.
    api(`/kartlar/borc-projeksiyon?aylik=${sayi(nakit)}&strateji=${strateji}`)
      .then(d => { if (!iptal) setProj(d || null); })
      .catch(() => { if (!iptal) setProj(null); });
    return () => { iptal = true; };
  }, [strateji, nakit]);

  /** borc-faiz-ozet satırlarını kart id'siyle eşler — ekstre durumu oradan gelir. */
  const ozetMap = useMemo(() => {
    const m = {};
    (ozet?.kartlar || []).forEach(r => { m[String(r.kart_id)] = r; });
    return m;
  }, [ozet]);

  const kartSatir = useMemo(() => kartlar.map(k => {
    const o = ozetMap[String(k.id)] || {};
    const ekstreVar = o.bu_ay_ekstre_var != null ? !!o.bu_ay_ekstre_var : !!k.ekstre_gercek;
    const limit = sayi(k.limit_tutar);
    const borc = sayi(k.guncel_borc);
    return {
      id: String(k.id),
      ad: k.kart_adi || k.banka || 'Kart',
      sahip: k.sahip || 'İşletme',
      donem: sayi(o.guncel_borc ?? k.donem_borcu ?? borc),
      taksit: sayi(o.gelecek_taksit_anapara ?? k.gelecek_taksit_anapara),
      toplam: sayi(o.toplam_borc_taksitli ?? k.toplam_borc_taksitli ?? borc),
      odenenFaiz: sayi(o.toplam_odenen_faiz),
      limit,
      // ⚠️ KULLANIM/KALAN LİMİT SUNUCUDAN GELİR — burada HESAPLANMAZ.
      // Eski kod `guncel_borc / limit_tutar` yapıyordu; sunucunun limit_doluluk'u
      // (main.py:2721) bambaşka bir hesap: anlık borç (kesim sonrası ödeme dahil)
      // + gelecek TAKSİT yükü, üstelik ORTAK LİMİT HAVUZU'nda grup seviyesinde
      // yeniden hesaplanıyor. Yani taksitli kartta kullanımı DÜŞÜK, limit
      // paylaşan kartlarda ise çift sayıp YANLIŞ gösteriyordu. Sunucu alanı
      // yoksa (eski cevap) eski hesaba düşülür.
      kalanLimit: k.kalan_limit != null ? sayi(k.kalan_limit) : null,
      kullanim: k.limit_doluluk != null
        ? Math.max(0, Math.min(100, sayi(k.limit_doluluk) * 100))
        : (limit ? Math.min(100, (borc / limit) * 100) : 0),
      kullanimKaynak: k.limit_doluluk != null ? 'sunucu' : 'tahmin',
      // Anlık borç = ekstre dönem borcu + kesim sonrası hareketler (gerçek zamanlı)
      anlikBorc: k.anlik_borc != null ? sayi(k.anlik_borc) : borc,
      bankaLimit: k.kullanilabilir_limit != null ? sayi(k.kullanilabilir_limit) : null,
      // Ortak limit havuzu: kart formunda tanımlanabiliyordu ama SONUCU hiç
      // gösterilmiyordu — paylaşılan limitte kalan tek havuzdan hesaplanır.
      ortakGrup: (k.ortak_limit_grup || '').trim() || null,
      ortakGrupLimit: k.ortak_grup_limit != null ? sayi(k.ortak_grup_limit) : null,
      ortakGrupBorc: k.ortak_grup_borc != null ? sayi(k.ortak_grup_borc) : null,
      ortakGrupUye: sayi(k.ortak_grup_uye),
      // Devreden = geçen dönem tam ödenmediği için bu ekstreye taşınan yük.
      // devreden_faiz gerçekten ÖDENEN paradır; anapara sadece ertelenmiştir.
      devredenAnapara: sayi(k.devreden_anapara),
      devredenFaiz: sayi(k.devreden_faiz),
      buEkstre: sayi(k.bu_ekstre),
      gelecekEkstre: sayi(k.gelecek_ekstre),
      tekCekim: sayi(k.tek_cekim),
      aylikTaksit: sayi(k.aylik_taksit),
      buDonemOdenen: sayi(k.bu_donem_odenen),
      oncekiDurum: k.onceki_durum || 'yok',
      oncekiEkstre: sayi(k.onceki_ekstre),
      oncekiOdenen: sayi(k.onceki_odenen),
      aktifDonem: k.aktif_donem || null,
      aktifKesim: k.aktif_kesim || null,
      // blink: son ödeme günü geçmiş VE bekleyen ödeme planı var = acil
      blink: k.blink === true,
      faizYillik: sayi(k.faiz_orani),
      kesim: k.kesim_gunu,
      sonOdeme: k.aktif_son_odeme || k.son_odeme_tarihi,
      gunKaldi: sayi(k.gun_kaldi),
      asgari: sayi(k.asgari_odeme),
      asgariKarsilandi: !!k.asgari_karsilandi,
      ekstreVar,
      durum: donguDurumu(k, ekstreVar),
    };
  }), [kartlar, ozetMap]);

  const toplamAsgari = koc ? sayi(koc.toplam_asgari) : kartSatir.reduce((s, k) => s + k.asgari, 0);

  // ── ortak: kart dosyası çekmecesi ──────────────────────────────────────────
  const kartAc = (k) => onCekmece?.({
    tip: 'KART DOSYASI',
    baslik: k.ad,
    alt: `${k.sahip} · ${trKucuk(DONGU[k.durum].ad)}`,
    kpi: [
      { etiket: 'Toplam borç', deger: fmt(k.toplam), renk: R.kirmizi },
      {
        etiket: 'Kalan limit',
        deger: k.kalanLimit != null ? fmt(k.kalanLimit) : '—',
        renk: k.kalanLimit == null ? R.not
          : k.kalanLimit <= 0 ? R.kirmizi : k.kullanim >= 80 ? R.amber : R.yesil,
      },
      { etiket: 'Asgari', deger: fmt(k.asgari), renk: k.asgariKarsilandi ? R.yesil : R.amber },
      { etiket: 'Ödenen faiz', deger: fmt(k.odenenFaiz), renk: R.amber },
    ],
    listeBaslik: 'Limit ve döngü',
    satirlar: [
      { ad: 'Limit', detay: `kullanım %${trSayi(k.kullanim, 0)}${k.kullanimKaynak === 'tahmin' ? ' · tahmini' : ' · anlık borç + gelecek taksit'}`, tutar: fmt(k.limit) },
      ...(k.kalanLimit != null ? [{
        ad: 'Kalan limit',
        detay: k.ortakGrup ? 'ortak havuzdan — bu kart tek başına değil' : 'limit − anlık borç − gelecek taksit yükü',
        tutar: fmt(k.kalanLimit),
      }] : []),
      ...(k.ortakGrup ? [{
        ad: `Ortak limit havuzu · ${k.ortakGrup}`,
        detay: `${k.ortakGrupUye || 2} kart aynı limiti paylaşıyor · havuz borcu ${fmt(k.ortakGrupBorc)}`,
        tutar: k.ortakGrupLimit != null ? fmt(k.ortakGrupLimit) : fmt(k.limit),
      }] : []),
      ...(k.bankaLimit != null ? [{
        ad: 'Bankanın yazdığı kullanılabilir limit',
        detay: 'ekstre PDF\'inden okundu — bizim hesabımızla karşılaştır',
        tutar: fmt(k.bankaLimit),
      }] : []),
      {
        ad: 'Anlık borç',
        detay: k.ekstreVar ? 'ekstre dönem borcu + kesim sonrası ödeme/harcama' : 'defter borcu (ekstre yok)',
        tutar: fmt(k.anlikBorc),
      },
      { ad: 'Bu ekstre', detay: k.aktifKesim ? `kesim ${kisaTarih(k.aktifKesim)}` : 'aktif dönem', tutar: fmt(k.buEkstre) },
      ...(k.buDonemOdenen > 0 ? [{
        ad: 'Bu dönem ödenen',
        detay: k.asgariKarsilandi ? 'asgari karşılandı' : `asgari ${fmt(k.asgari)} · henüz karşılanmadı`,
        tutar: fmt(k.buDonemOdenen),
      }] : []),
      { ad: 'Gelecek ekstre', detay: `tek çekim ${fmt(k.tekCekim)} + aylık taksit ${fmt(k.aylikTaksit)}`, tutar: fmt(k.gelecekEkstre) },
      { ad: 'Gelecek taksit anaparası', detay: 'sonraki dönemlere yayılı', tutar: fmt(k.taksit) },
      // DEVREDEN: geçen dönem tam ödenmediği için taşınan yük. Faiz GERÇEKTEN
      // ödenen paradır (kart borcuna yazılır), anapara yalnızca ertelenmiştir.
      ...(k.devredenAnapara > 0 || k.devredenFaiz > 0 ? [{
        ad: 'Devreden anapara',
        detay: 'geçen dönem ödenmeyip bu ekstreye taşınan tutar',
        tutar: fmt(k.devredenAnapara),
      }, {
        ad: '⚠ Devreden faiz',
        detay: 'tam ödenmediği için işleyen faiz (KKDF/BSMV dâhil) — yanan para',
        tutar: fmt(k.devredenFaiz),
      }] : []),
      {
        ad: 'Önceki dönem',
        detay: ONCEKI_DURUM[k.oncekiDurum]?.aciklama || 'önceki dönem verisi yok',
        tutar: ONCEKI_DURUM[k.oncekiDurum]?.ad || 'yok',
      },
      { ad: 'Yıllık faiz', detay: k.faizYillik > 0 ? 'sözleşme oranı' : 'girilmemiş', tutar: k.faizYillik > 0 ? `%${trSayi(k.faizYillik)}` : '—' },
      { ad: 'Kesim günü', detay: `ayın ${k.kesim}`, tutar: gunMetni(k.gunKaldi) },
    ],
    not: k.blink
      ? 'ACİL — son ödeme günü geçti ve bu kart için bekleyen bir ödeme planı var. Ödeme Merkezi\'nden kapatın; gecikme faizi her gün işler.'
      : k.ekstreVar
        ? 'Bu dönem ekstresi yüklü — rakamlar ekstreyle doğrulandı. Düzenleme Kart Dosyaları satır butonlarından.'
        : 'Bu dönem ekstresi YÜKLENMEDİ — Ekstre Durumu görünümünden PDF yükleyin. Ekstre yokken kalan limit ve devreden faiz tahminîdir.',
    ...(k.ekstreVar ? {} : { aksiyonAd: 'Ekstre durumuna git', _hedef: '__gorunum:ekstre' }),
  });

  const kartFormAc = (k) => {
    const ham = k ? kartlar.find((x) => String(x.id) === String(k.id)) : null;
    setKartForm(ham ? {
      duzenleId: ham.id, kart_adi: ham.kart_adi || '', banka: ham.banka || '',
      limit_tutar: ham.limit_tutar ?? '', kesim_gunu: ham.kesim_gunu ?? 15,
      son_odeme_gunu: ham.son_odeme_gunu ?? 25, faiz_orani: ham.faiz_orani ?? '',
      asgari_oran: ham.asgari_oran ?? 40, gecikme_faiz_orani: ham.gecikme_faiz_orani ?? 0,
      sahip: ham.sahip ?? 'İşletme', ortak_limit_grup: ham.ortak_limit_grup ?? '',
    } : {
      duzenleId: null, kart_adi: '', banka: '', limit_tutar: '', kesim_gunu: 15,
      son_odeme_gunu: 25, faiz_orani: '', asgari_oran: 40, gecikme_faiz_orani: '',
      sahip: 'İşletme', ortak_limit_grup: '',
    });
  };

  const kartKaydet = async () => {
    if (!(kartForm?.kart_adi || '').trim()) { onToast?.('Kart adı zorunlu'); return; }
    setKartMesgul(true);
    try {
      const { duzenleId, ...body } = kartForm;
      if (duzenleId) await api(`/kartlar/${duzenleId}`, { method: 'PUT', body });
      else await api('/kartlar', { method: 'POST', body });
      onToast?.(duzenleId ? '✓ Kart güncellendi' : '✓ Kart eklendi');
      setKartForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setKartMesgul(false);
    }
  };

  const kartPasife = async (id) => {
    setKartMesgul(true);
    try {
      await api(`/kartlar/${id}`, { method: 'DELETE' });
      onToast?.('Kart pasife alındı');
      setKartPasifSor('');
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Pasife alınamadı');
    } finally {
      setKartMesgul(false);
    }
  };

  // ── ekstre yükleme fonksiyonları (klasik EkstreYukle.jsx sözleşmesi) ───────
  const BANKA_AD = { axess: 'Axess', worldcard: 'Yapı Kredi', enpara: 'Enpara', ziraat: 'Ziraat', garanti: 'Garanti' };
  const FORMAT_AD = { worldcard: 'Worldcard / Yapı Kredi', enpara: 'Enpara', axess: 'Axess / Akbank', ziraat: 'Ziraat Bankkart', garanti: 'Garanti Bonus' };
  const gunCikar = (d) => {
    const s = String(d || '');
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return parseInt(m[3], 10);
    m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (m) return parseInt(m[1], 10);
    return 1;
  };

  const eksAc = () => {
    setEksModal(true);
    setEksSonuc(null); setEksHata(''); setEksDosyaAdi(''); setEksImpSonuc(null);
    setEksOnaySor(null); setManForm(null);
  };

  const eksDosyaYukle = async (file) => {
    if (!file) return;
    setEksLastFile(file);
    setEksDosyaAdi(file.name);
    setEksHata(''); setEksSonuc(null); setEksImpSonuc(null); setEksOnaySor(null);
    setEksYukleniyor(true);
    const fd = new FormData();
    fd.append('dosya', file);
    try {
      // api util JSON gövde varsayar — dosya için düz fetch (klasik desen)
      const res = await fetch('/api/kartlar/ekstre-yukle', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ayrıştırılamadı');
      setEksSonuc(data);
    } catch (e) {
      setEksHata(e?.message || 'Dosya işlenemedi');
    } finally {
      setEksYukleniyor(false);
    }
  };

  /** İmport sonrası kalan farkı devirle kapat + sonucu işle (ortak kuyruk). */
  const eksDevirVeBitir = async (impOzet, yeniBorcIn, devirGerekli) => {
    const kart = eksSonuc?.eslesen_kart;
    const ekstreBorc = eksSonuc?.mutabakat?.ekstre_borc ?? eksSonuc?.donem_borcu ?? 0;
    let yeniBorc = yeniBorcIn;
    let devirYapildi = false; let devirDuzeltme = 0;
    if (devirGerekli) {
      const r2 = await fetch(`/api/kartlar/${kart.id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: eksSonuc.kesim_tarihi, son_odeme: eksSonuc.son_odeme_tarihi || null,
          donem_borcu: eksSonuc.donem_borcu, asgari_tutar: eksSonuc.asgari_tutar || null,
          faiz_orani: eksSonuc.akdi_faiz_yillik || null,
        }),
      });
      const d2 = await r2.json();
      if (!r2.ok) throw new Error(d2.detail || 'Mutabakat düzeltmesi yapılamadı');
      devirDuzeltme = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      yeniBorc = d2.yeni_borc; devirYapildi = true;
    }
    const sonFark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
    setEksSonuc((sn) => ({ ...sn, mutabakat: { ...sn.mutabakat, sistem_borc: yeniBorc, fark: sonFark, tutar_uyumlu: Math.abs(sonFark) < 1 } }));
    setEksImpSonuc({ ...impOzet, tek_tik: true, devir: devirYapildi, devir_duzeltme: devirDuzeltme, yeni_sistem_borc: yeniBorc, buyuk_fark_onay_gerek: Math.abs(sonFark) > 1 });
    onToast?.('⚡ Mutabakat tamam — kart borcu ekstreyle eşitlendi');
    yukle();  // kart listesi/rozetler tazelensin
  };

  /** ⚡ TEK TIK MUTABAKAT — klasik mantık aynen: import → eşik-onaylı devir. */
  const eksTekTik = async () => {
    const kart = eksSonuc?.eslesen_kart;
    if (!kart?.id || !eksSonuc) return;
    setEksTtBusy(true); setEksHata(''); setEksImpSonuc(null); setEksOnaySor(null);
    try {
      const islemler = (eksSonuc.islemler || []).filter((x) => x && x.durum === 'yeni')
        .map((x) => ({ tarih: x.tarih, tutar: x.tutar, tip: x.tip, aciklama: x.aciklama,
                       kategori: x.kategori, harcama_tipi: x.oneri_tipi || undefined,
                       taksit_sayisi: x.taksit_sayisi || undefined,
                       taksit_anapara: x.taksit_anapara || undefined }));
      let yeniBorc = eksSonuc?.mutabakat?.sistem_borc;
      let impOzet = { yazilan: 0, atlanan_veya_mevcut: 0 };
      if (islemler.length) {
        const r1 = await fetch('/api/kartlar/ekstre-import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kart_id: kart.id, islemler }),
        });
        const d1 = await r1.json();
        if (!r1.ok) throw new Error(d1.detail || 'İçe aktarılamadı');
        impOzet = d1; yeniBorc = d1.yeni_sistem_borc;
      }
      const ekstreBorc = eksSonuc?.mutabakat?.ekstre_borc ?? eksSonuc?.donem_borcu ?? 0;
      const fark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      const esik = Math.max(5000, Math.abs(ekstreBorc) * 0.05);
      if (Math.abs(fark) > 1 && Math.abs(fark) > esik) {
        // Eşik üstü — kadife onay kutusu (klasikte window.confirm idi)
        setEksOnaySor({ fark, ekstreBorc, yeniBorc, impOzet });
        return;
      }
      await eksDevirVeBitir(impOzet, yeniBorc, Math.abs(fark) > 1);
    } catch (e) {
      setEksHata(e?.message || 'Mutabakat başarısız');
    } finally {
      setEksTtBusy(false);
    }
  };

  const eksKartiEkle = async () => {
    if (!eksSonuc) return;
    const bankaLabel = BANKA_AD[eksSonuc.banka_format] || eksSonuc.banka_format || 'Banka';
    setKartEkleBusy(true); setEksHata('');
    try {
      const r = await fetch('/api/kartlar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kart_adi: `${bankaLabel} ${eksSonuc.kart_sahibi || ''} ${eksSonuc.son_dort || ''}`.replace(/\s+/g, ' ').trim(),
          banka: bankaLabel,
          limit_tutar: eksSonuc.limit || 0,
          kesim_gunu: gunCikar(eksSonuc.kesim_tarihi),
          son_odeme_gunu: gunCikar(eksSonuc.son_odeme_tarihi),
          faiz_orani: eksSonuc.akdi_faiz_yillik || 0,
          asgari_oran: eksSonuc.asgari_oran || 40,
          gecikme_faiz_orani: eksSonuc.gecikme_faiz_yillik || 0,
          son_dort_hane: eksSonuc.son_dort || null,
          sahip: eksSonuc.kart_sahibi || 'İşletme',
        }),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Kart eklenemedi'); }
      onToast?.('✓ Kart eklendi — ekstre yeniden eşleştiriliyor');
      if (eksLastFile) await eksDosyaYukle(eksLastFile);
    } catch (e) {
      setEksHata(e?.message || 'Kart eklenemedi');
    } finally {
      setKartEkleBusy(false);
    }
  };

  const eksManuelKaydet = async () => {
    if (!manForm?.kart_id || !manForm?.donem || !manForm?.donem_borcu) {
      setEksHata('Kart, kesim tarihi ve dönem borcu zorunlu.'); return;
    }
    setManBusy(true); setEksHata('');
    try {
      const r = await fetch(`/api/kartlar/${manForm.kart_id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: manForm.donem, son_odeme: manForm.son_odeme || null,
          donem_borcu: parseFloat(manForm.donem_borcu),
          asgari_tutar: manForm.asgari_tutar ? parseFloat(manForm.asgari_tutar) : null,
          faiz_orani: manForm.faiz_orani ? parseFloat(manForm.faiz_orani) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Kaydedilemedi');
      onToast?.(`✓ Manuel ekstre kaydedildi — yeni borç ${fmt(sayi(d.yeni_borc))}`);
      setManForm(null);
      yukle();
    } catch (e) {
      setEksHata(e?.message || 'Kaydedilemedi');
    } finally {
      setManBusy(false);
    }
  };

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Kart verileri yükleniyor…</div>;
  }
  if (hata) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{hata}</div>
        <button onClick={yukle} style={{
          marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>Tekrar dene</button>
      </div>
    );
  }
  if (!kartSatir.length) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>Kayıtlı kart yok</div>
        <div style={{ fontSize: 13, color: R.not, marginTop: 8 }}>Kart tanımlayınca borç ve faiz takibi burada başlar.</div>
      </div>
    );
  }

  // ── 1) Kart & Faiz Özeti ───────────────────────────────────────────────────
  if (gorunum === 'ozet') {
    const donem = kartSatir.reduce((s, k) => s + k.donem, 0);
    const taksit = kartSatir.reduce((s, k) => s + k.taksit, 0);
    const eksik = kartSatir.filter(k => !k.ekstreVar);
    return (
      <>
        <Serit
          rozetler={kartSatir.map(k => ({
            ad: k.ad, durum: DONGU[k.durum].ad, renk: DONGU[k.durum].renk,
            ek: k.durum === 'gecikti' || k.durum === 'odeme_bekliyor' ? gunMetni(k.gunKaldi) : '',
            _k: k,
          }))}
          onAc={(s) => kartAc(s._k)}
        />
        <KpiSeridi kpiler={[
          { etiket: 'Toplam kart borcu', deger: fmt(sayi(ozet?.toplam_borc_taksitli) || donem + taksit), alt: `dönem ${fmt(donem).replace(' ₺','')} + taksit ${fmt(taksit)}`, renk: R.kirmizi },
          { etiket: 'Bankaya ödenen faiz', deger: fmt(sayi(ozet?.toplam_odenen_faiz)), alt: 'ekstrelerden birikimli', renk: R.amber },
          { etiket: 'Bu ay eksik ekstre', deger: `${eksik.length} kart`, alt: eksik.length ? eksik.map(k => k.ad).join(', ') : 'hepsi yüklendi', renk: eksik.length ? R.amber : R.yesil },
          { etiket: 'Toplam asgari', deger: fmt(toplamAsgari), alt: 'bu ay en az ödenmeli', renk: R.krem },
        ]} />
        <Tablo
          baslik="Kart bazlı borç & faiz"
          not="satıra tıkla → kart dosyası"
          kolonlar={[
            { ad: 'Kart' }, { ad: 'Sahip' }, { ad: 'Dönem borcu', sag: true },
            { ad: 'Taksit', sag: true }, { ad: 'Toplam borç', sag: true },
            { ad: 'Ödenen faiz', sag: true }, { ad: 'Bu ay ekstre' },
          ]}
          satirlar={kartSatir.map(k => ({
            id: k.id, _k: k,
            hucreler: [
              { v: k.ad, kalin: true },
              { v: k.sahip, renk: R.not },
              { v: fmt(k.donem), mono: true, sag: true },
              { v: k.taksit ? fmt(k.taksit) : '—', mono: true, sag: true, renk: k.taksit ? R.amber : R.not },
              { v: fmt(k.toplam), mono: true, sag: true, kalin: true, renk: R.kirmizi },
              { v: fmt(k.odenenFaiz), mono: true, sag: true, renk: R.amber },
              { v: k.ekstreVar ? 'yüklendi' : 'eksik', rozet: k.ekstreVar ? R.yesil : R.amber },
            ],
          }))}
          onSatir={(row) => kartAc(row._k)}
        />

        {/* ── EKSTRE FAİZİ ÜRET — gece motorunun elle tetiklenmiş hâli ────────── */}
        <div style={{ ...kartYuzey, padding: '15px 18px', marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>💢 Ekstre faizi</span>
            <span style={{ fontSize: 11.5, color: R.not2, flex: 1, minWidth: 220 }}>
              Sistem her gece kesim/son ödeme döngüsüne göre faizi kendisi yazar.
              Bu düğme ekstreyi <b>az önce yüklediysen</b> beklememek içindir.
            </span>
            <button disabled={faizMesgul} onClick={faizUret} style={{
              padding: '8px 15px', borderRadius: 10, cursor: faizMesgul ? 'wait' : 'pointer',
              border: `1px solid ${R.bakir}55`, background: `${R.bakir}22`, color: R.bakir,
              fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
            }}>{faizMesgul ? '⏳ hesaplanıyor…' : '💢 Faizi şimdi hesapla'}</button>
          </div>

          {faizSonuc && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${R.cizgi2}` }}>
              <div style={{ fontSize: 12, color: R.metin2, marginBottom: 9 }}>
                <b>{faizSonuc.donem || 'bu ay'}</b> · {faizSonuc.kartlar.length} kart tarandı ·{' '}
                <b style={{ color: faizSonuc.yazilan ? R.amber : R.yesil }}>
                  {faizSonuc.yazilan} karta faiz yazıldı
                </b>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {faizSonuc.kartlar.map((k, i) => {
                  const D = {
                    yazildi: ['faiz yazıldı', R.amber],
                    zaten_yazilmis: ['bu dönem zaten yazılmıştı', R.not],
                    tam_odendi: ['tam ödenmiş — faiz doğmaz', R.yesil],
                    ekstre_yok: ['ekstre yüklenmemiş', R.amber],
                    faiz_cok_kucuk: ['faiz eşiğin altında', R.not],
                    henuz_son_odeme_gecmedi: ['son ödeme günü geçmedi', R.not],
                    henuz_kapanmis_kesim_yok: ['kapanmış kesim yok', R.not],
                  }[k?.durum] || [k?.hata ? `hata: ${k.hata}` : (k?.durum || '—'), R.kirmizi];
                  const kartAdi = kartlar.find((x) => String(x.id) === String(k?.kart_id));
                  return (
                    <div key={k?.kart_id || `f-${i}`} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi3}`, fontSize: 12,
                    }}>
                      <b style={{ flex: 1, minWidth: 0 }}>
                        {k?.kart_adi || kartAdi?.kart_adi || kartAdi?.banka || `#${k?.kart_id || '—'}`}
                      </b>
                      <span style={{ color: D[1] }}>{D[0]}</span>
                      {sayi(k?.faiz) > 0 && (
                        <span style={{ fontFamily: F.mono, fontWeight: 700, color: R.amber }}>{fmt(sayi(k.faiz))}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 10, lineHeight: 1.6 }}>
                Yazılan faiz kart borcuna işlenir; kasadan para çıkmaz. Aynı dönem
                ikinci kez çalıştırılırsa üstüne yazmaz — "zaten yazılmıştı" der.
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  // ── 2) Kart Dosyaları ──────────────────────────────────────────────────────
  if (gorunum === 'kartlar') {
    // ⚠️ ORTAK LİMİT HAVUZU: limit paylaşan kartlarda sunucu HER ÜYEYE aynı
    // havuz limitini ve aynı kalan limiti yazar (main.py:2700). Kart kart
    // toplarsan havuzu üye sayısı kadar ÇİFT SAYARSIN. Önce havuza indirge.
    const havuzlar = new Map();
    kartSatir.forEach((k) => {
      const anahtar = k.ortakGrup || `__tek:${k.id}`;
      if (havuzlar.has(anahtar)) return;   // havuzun ilk üyesi havuzu temsil eder
      havuzlar.set(anahtar, {
        limit: k.ortakGrup && k.ortakGrupLimit != null ? k.ortakGrupLimit : k.limit,
        kalan: k.kalanLimit,
        borc: k.ortakGrup && k.ortakGrupBorc != null ? k.ortakGrupBorc : k.toplam,
      });
    });
    const havuzListe = [...havuzlar.values()];
    const toplamLimit = havuzListe.reduce((s, h) => s + sayi(h.limit), 0);
    const toplamBorc = havuzListe.reduce((s, h) => s + sayi(h.borc), 0);
    const kalanBilinen = havuzListe.filter((h) => h.kalan != null);
    const toplamKalan = kalanBilinen.reduce((s, h) => s + sayi(h.kalan), 0);
    const havuzluKart = kartSatir.filter((k) => k.ortakGrup).length;
    const acilKart = kartSatir.filter((k) => k.blink);
    const faizli = kartSatir.filter(k => k.faizYillik > 0);
    const enPahali = faizli.length ? faizli.reduce((a, b) => (a.faizYillik > b.faizYillik ? a : b)) : null;
    const yakin = [...kartSatir].filter(k => k.gunKaldi >= 0).sort((a, b) => a.gunKaldi - b.gunKaldi)[0];
    const sirket = kartSatir.filter(k => trKucuk(k.sahip).includes('işletme')).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif kart', deger: String(kartSatir.length), alt: `${kartSatir.length - sirket} kişisel · ${sirket} işletme${havuzluKart ? ` · ${havuzluKart} kart ortak limitte` : ''}` },
          { etiket: 'Toplam limit', deger: fmt(toplamLimit), alt: `kullanım %${trSayi(toplamLimit ? (toplamBorc / toplamLimit) * 100 : 0, 0)}${havuzluKart ? ' · ortak havuz tek sayıldı' : ''}`, renk: R.krem },
          {
            etiket: 'Kalan limit',
            deger: kalanBilinen.length ? fmt(toplamKalan) : '—',
            alt: kalanBilinen.length
              ? (kalanBilinen.length < havuzListe.length ? `${kalanBilinen.length}/${havuzListe.length} havuzdan` : 'harcanabilir')
              : 'ekstre yüklenince hesaplanır',
            renk: !kalanBilinen.length ? R.not : toplamKalan <= 0 ? R.kirmizi : R.yesil,
          },
          { etiket: 'En pahalı faiz', deger: enPahali ? `%${trSayi(enPahali.faizYillik)}/yıl` : '—', alt: enPahali ? enPahali.ad : 'faiz oranı girilmemiş', renk: enPahali ? R.kirmizi : R.not },
          {
            etiket: 'En yakın son ödeme',
            deger: acilKart.length ? `${acilKart.length} acil` : yakin ? gunMetni(yakin.gunKaldi) : '—',
            alt: acilKart.length
              ? `vadesi geçti, ödeme bekliyor — ${acilKart.map((k) => k.ad).join(', ')}`
              : yakin ? yakin.ad : 'vadesi gelen yok',
            renk: acilKart.length ? R.kirmizi : R.amber,
          },
        ]} />
        <div style={{ display: 'flex', gap: 9, marginBottom: 12 }}>
          <button onClick={() => kartFormAc(null)} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            + Kart ekle
          </button>
        </div>
        <Liste
          satirlar={kartSatir.map(k => ({
            id: k.id, _k: k,
            baslik: k.ad,
            alt: `${k.kalanLimit != null ? `kalan limit ${fmt(k.kalanLimit)}` : `limit ${fmt(k.limit)}`}`
              + ` · kullanım %${trSayi(k.kullanim, 0)}`
              + `${k.ortakGrup ? ` · ortak havuz «${k.ortakGrup}»` : ''}`
              + `${k.devredenFaiz > 0 ? ` · devreden faiz ${fmt(k.devredenFaiz)}` : ''}`
              + `${k.faizYillik > 0 ? ` · faiz %${trSayi(k.faizYillik)}/yıl` : ''}`
              + ` · son ödeme ${kisaTarih(k.sonOdeme)}`,
            tutar: fmt(k.toplam),
            tier: (k.blink || k.durum === 'gecikti') ? 'kritik' : k.durum === 'ekstre_bekleniyor' ? 'uyari' : k.durum === 'odendi' ? 'olumlu' : 'bilgi',
            rozet: k.blink ? 'acil · vadesi geçti' : trKucuk(DONGU[k.durum].ad),
            rozetRenk: k.blink ? R.kirmizi : DONGU[k.durum].renk,
            aksiyonlar: kartPasifSor === String(k.id) ? [
              { ad: kartMesgul ? '…' : 'Eminim — pasife al', birincil: true, onTikla: () => !kartMesgul && kartPasife(k.id) },
              { ad: 'Vazgeç', onTikla: () => setKartPasifSor('') },
            ] : [
              { ad: '✎ Düzenle', birincil: true, onTikla: () => kartFormAc(k) },
              { ad: 'Pasife al', onTikla: () => setKartPasifSor(String(k.id)) },
              // İSTİSNA işlemler — ikisi de işletme PIN'i ister
              { ad: 'Hareketleri sıfırla', onTikla: () => setKtkModal({ tip: 'ledger', kart: k }) },
              { ad: 'Kalıcı sil', onTikla: () => setKtkModal({ tip: 'kalici-sil', kart: k }) },
            ],
          }))}
          onAc={(l) => kartAc(l._k)}
        />

        {ktkModalBlok}
        {/* Tek seferlik temizlik — açılış devri öncesi; sıradan kullanım değil */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${R.cizgi3}` }}>
          <div style={{ fontSize: 11, color: R.not2, lineHeight: 1.6, marginBottom: 8 }}>
            Kart defterini baştan kurmak (açılış devri öncesi tek seferlik temizlik):
          </div>
          <button onClick={() => setKtkModal({ tip: 'ledger-hepsi' })} style={{
            padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11.5, fontWeight: 600, border: `1px solid ${R.kirmizi}44`,
            background: 'transparent', color: R.kirmizi,
          }}>⚠ Tüm kartların hareketlerini sıfırla</button>
        </div>

        {/* ── YERLİ KART FORMU (klasik Kartlar.jsx alanları aynen) ── */}
        {kartForm && (() => {
          const alan = (k, v) => setKartForm((f) => ({ ...f, [k]: v }));
          const alanStil = {
            width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
            border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
            fontSize: 13, fontFamily: 'inherit', outline: 'none',
          };
          const et = { fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' };
          return (
            <div
              onClick={(e) => { if (e.target === e.currentTarget && !kartMesgul) setKartForm(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
                backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
              }}
            >
              <div style={{ ...kartYuzey, width: 560, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>
                    {kartForm.duzenleId ? 'Kartı Düzenle' : 'Yeni Kart'}
                  </div>
                  <button onClick={() => !kartMesgul && setKartForm(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
                  <div>
                    <label style={et}>Kart adı *</label>
                    <input value={kartForm.kart_adi} onChange={(e) => alan('kart_adi', e.target.value)} style={alanStil} />
                  </div>
                  <div>
                    <label style={et}>Banka</label>
                    <input value={kartForm.banka} onChange={(e) => alan('banka', e.target.value)} style={alanStil} />
                  </div>
                  <div>
                    <label style={et}>Limit (₺)</label>
                    <input type="number" value={kartForm.limit_tutar} onChange={(e) => alan('limit_tutar', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Sahip</label>
                    <select value={kartForm.sahip} onChange={(e) => alan('sahip', e.target.value)} style={alanStil}>
                      {['İşletme', 'Şahsi'].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={et}>Kesim günü</label>
                    <input type="number" min={1} max={31} value={kartForm.kesim_gunu} onChange={(e) => alan('kesim_gunu', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Son ödeme günü</label>
                    <input type="number" min={1} max={31} value={kartForm.son_odeme_gunu} onChange={(e) => alan('son_odeme_gunu', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Yıllık faiz %</label>
                    <input type="number" value={kartForm.faiz_orani} onChange={(e) => alan('faiz_orani', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Asgari oran %</label>
                    <input type="number" value={kartForm.asgari_oran} onChange={(e) => alan('asgari_oran', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Gecikme faizi %</label>
                    <input type="number" value={kartForm.gecikme_faiz_orani} onChange={(e) => alan('gecikme_faiz_orani', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={et}>Ortak limit grubu</label>
                    <input value={kartForm.ortak_limit_grup} placeholder="aynı limiti paylaşanlar"
                      onChange={(e) => alan('ortak_limit_grup', e.target.value)} style={alanStil} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: R.not, marginTop: 12, lineHeight: 1.5 }}>
                  Kalıcı silme / sıfırlama gibi PIN'li işlemler güvenlik gereği klasik Kartlar ekranında.
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                  <button disabled={kartMesgul} onClick={() => setKartForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>İptal</button>
                  <button disabled={kartMesgul} onClick={kartKaydet} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                  }}>
                    {kartMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  // ── 3) Borç Koçu ───────────────────────────────────────────────────────────
  if (gorunum === 'koc') {
    const kocKart = koc?.kartlar || [];
    const toplamBorc = sayi(koc?.toplam_borc) || kartSatir.reduce((s, k) => s + k.toplam, 0);
    const aylikFaiz = sayi(koc?.toplam_aylik_faiz);
    const oncelik = koc?.oncelik;
    // Kurtuluş süresi: SUNUCUNUN ay ay simülasyonu esas (bileşik faiz +
    // strateji sırası dahil). Uç yoksa eski kaba orana düşülür — ama o oran
    // faizi bileşiklemediği için GERÇEKTEN OLDUĞUNDAN KISA gösterir.
    const netAylik = sayi(nakit) - aylikFaiz;
    const kabaAy = netAylik > 0 ? Math.ceil(toplamBorc / netAylik) : null;
    const projAy = proj?.verilen?.ay ?? null;
    const kurtulusAy = projAy != null ? projAy : kabaAy;
    const projBitmedi = proj?.verilen?.bitmedi === true;
    const asgariAy = proj?.asgari_only?.ay ?? null;
    const tasarruf = sayi(proj?.tasarruf_faiz);
    const erkenAy = sayi(proj?.erken_ay);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam borç', deger: fmt(toplamBorc), alt: `${kartSatir.length} kart`, renk: R.kirmizi },
          { etiket: 'Aylık faiz kaybı', deger: fmt(aylikFaiz), alt: 'hiçbir şey yapmazsan bankaya', renk: R.amber },
          { etiket: 'Toplam asgari', deger: fmt(toplamAsgari), alt: 'bu ay minimum', renk: R.krem },
          {
            etiket: 'Kurtuluş',
            deger: projBitmedi ? 'bitmiyor' : kurtulusAy ? `${kurtulusAy} ay` : '—',
            alt: projBitmedi
              ? 'bu tempoda borç kapanmıyor'
              : kurtulusAy
                ? `aylık ${fmt(sayi(nakit))} ödemeyle${proj?.verilen?.bitis_tarihi ? ` · ${kisaTarih(proj.verilen.bitis_tarihi)}` : ''}${projAy == null ? ' · kaba tahmin' : ''}`
                : 'ödeme faizi karşılamıyor',
            renk: projBitmedi ? R.kirmizi : kurtulusAy ? R.yesil : R.kirmizi,
          },
        ]} />

        {/* ── ÇOK AYLIK PROJEKSİYON (/kartlar/borc-projeksiyon) ──
            Borç Koçu tek dönemi dağıtır: "bu ay hangi karta ne kadar".
            Bu blok BÜTÜN YOLU gösterir: kaç ayda biter, toplam ne kadar faiz
            ödersin ve SADECE ASGARİ ödersen ne kaybedersin. */}
        {proj && (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 11 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                Kurtuluş projeksiyonu · {proj.strateji === 'kartopu' ? 'kartopu' : 'çığ'}
              </span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                gerçek faiz simülasyonu — standart çerçeve, kişiye özel mali tavsiye değildir
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
              <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.yesil}33` }}>
                <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>
                  AYLIK {fmt(sayi(proj.aylik))} ÖDERSEN
                </div>
                <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, color: projBitmedi ? R.kirmizi : R.yesil, marginTop: 4 }}>
                  {projBitmedi ? 'bitmiyor' : `${projAy} ay`}
                </div>
                <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                  toplam faiz {fmt(sayi(proj.verilen?.toplam_faiz))}
                  {proj.verilen?.bitis_tarihi ? ` · ${kisaTarih(proj.verilen.bitis_tarihi)}` : ''}
                </div>
              </div>
              <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.kirmizi}33` }}>
                <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>
                  SADECE ASGARİ ÖDERSEN
                </div>
                <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, color: R.kirmizi, marginTop: 4 }}>
                  {proj.asgari_only?.bitmedi ? 'bitmiyor' : asgariAy ? `${asgariAy} ay` : '—'}
                </div>
                <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                  toplam faiz {fmt(sayi(proj.asgari_only?.toplam_faiz))}
                </div>
              </div>
              {(tasarruf > 0 || erkenAy > 0) && (
                <div style={{ padding: '11px 14px', borderRadius: 11, background: `${R.bakir}14`, border: `1px solid ${R.bakir}44` }}>
                  <div style={{ fontSize: 10.5, color: R.bakirAcik, fontWeight: 700, letterSpacing: '.5px' }}>
                    FARK — CEBİNDE KALAN
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, color: R.bakirAcik, marginTop: 4 }}>
                    {fmt(tasarruf)}
                  </div>
                  <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                    {erkenAy > 0 ? `${erkenAy} ay erken biter` : 'daha az faiz'}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <BorcKocu
          strateji={strateji}
          onStrateji={setStrateji}
          nakit={nakit}
          onNakit={(v) => setNakit(v === '' ? 0 : Number(v))}
          oncelikAd={oncelik?.kart_adi}
          oncelikNot={oncelik ? (
            strateji === 'cig'
              ? `Yıllık %${trSayi(sayi(oncelik.faiz_yillik))} faizle en pahalı borç bu. Aylık ${fmt(sayi(oncelik.aylik_faiz))} sadece faize gidiyor.`
              : `En küçük bakiye bu (${fmt(sayi(oncelik.borc))}). Kapanınca listeden bir kart eksilir, motivasyon artar.`
          ) : ''}
          ozetNot={koc?.asgari_karsilaniyor === false
            ? `⚠ Girdiğin nakit tüm asgarileri karşılamıyor — en az ${fmt(toplamAsgari)} gerekiyor.`
            : sayi(koc?.artan_nakit) > 0
              ? `✓ Tüm asgariler + öncelik kapanır, ${fmt(sayi(koc.artan_nakit))} nakit artar — sıradaki karta yatır.`
              : ''}
          satirlar={kocKart.map(k => ({
            id: k.kart_id,
            ad: k.kart_adi,
            sahip: k.sahip || 'İşletme',
            borc: fmt(sayi(k.borc)),
            faiz: k.faiz_belirsiz ? '—' : `%${trSayi(sayi(k.faiz_yillik))}`,
            faizBelirsiz: !!k.faiz_belirsiz,
            aylikFaiz: fmt(sayi(k.aylik_faiz)),
            asgari: fmt(sayi(k.asgari)),
            onerilen: fmt(sayi(k.onerilen_odeme)),
          }))}
        />
      </>
    );
  }

  // ── 4) Hareketler ──────────────────────────────────────────────────────────
  if (gorunum === 'hareket') {
    const g = harcama?.genel || {};
    const toplam = sayi(g.toplam);
    const belirsizAdet = hareketler.filter(h => (h.harcama_tipi || 'belirsiz') === 'belirsiz' && h.islem_turu === 'HARCAMA').length;
    const pay = (v) => (toplam ? `%${trSayi((sayi(v) / toplam) * 100, 0)}` : '—');
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam harcama', deger: fmt(toplam), alt: `${hareketler.length} hareket` },
          { etiket: 'İşletme', deger: pay(g.isletme), alt: fmt(sayi(g.isletme)), renk: R.yesil },
          { etiket: 'Şahsi', deger: pay(g.sahsi), alt: fmt(sayi(g.sahsi)), renk: R.mavi },
          { etiket: 'Sınıflandırılmayan', deger: `${belirsizAdet} hareket`, alt: `${fmt(sayi(g.belirsiz))} · karar bekliyor`, renk: belirsizAdet ? R.amber : R.yesil },
        ]} />
        {khModalBlok}
        <Tablo
          baslik="Kart hareketleri · işletme / şahsi"
          not="satıra tıkla → sınıflandır"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'Kart' }, { ad: 'Açıklama' },
            { ad: 'Tutar', sag: true }, { ad: 'Tür' }, { ad: 'Sınıf' }, { ad: 'İşlem' },
          ]}
          satirlar={hareketler.slice(0, 120).map(h => {
            const sinif = h.harcama_tipi || 'belirsiz';
            const odeme = h.islem_turu === 'ODEME';
            return {
              id: h.id, _h: h,
              hucreler: [
                { v: kisaTarih(h.tarih), mono: true },
                { v: h.kart_adi || h.banka || '—', renk: R.not },
                { v: h.aciklama || (odeme ? 'Kart ödemesi' : 'Harcama'), kalin: true },
                { v: fmt(sayi(h.tutar)), mono: true, sag: true, renk: odeme ? R.yesil : R.krem },
                { v: slugAd(h.islem_turu), rozet: odeme ? R.yesil : h.islem_turu === 'FAIZ' ? R.kirmizi : R.bakir },
                { v: sinif === 'isletme' ? 'işletme' : sinif === 'sahsi' ? 'şahsi' : 'belirsiz', rozet: sinif === 'isletme' ? R.yesil : sinif === 'sahsi' ? R.mavi : R.amber },
                { v: (
                    <span style={{ display: 'flex', gap: 5 }} onClick={(e) => e.stopPropagation()}>
                      {sinif !== 'isletme' && <button onClick={() => setKhModal({ tip: 'tip', hareket: h, harcama: 'isletme' })} style={kMini}>İşletme</button>}
                      {sinif !== 'sahsi' && <button onClick={() => setKhModal({ tip: 'tip', hareket: h, harcama: 'sahsi' })} style={kMini}>Şahsi</button>}
                      <button onClick={() => setKhModal({ tip: 'sil', hareket: h })}
                        style={{ ...kMini, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Sil</button>
                    </span>
                  ) },
              ],
            };
          })}
          onSatir={(row) => {
            const h = row._h;
            onCekmece?.({
              tip: 'KART HAREKETİ',
              baslik: h.aciklama || 'Hareket',
              alt: `${h.kart_adi || h.banka || 'Kart'} · ${kisaTarih(h.tarih)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(sayi(h.tutar)) },
                { etiket: 'Tür', deger: slugAd(h.islem_turu) },
                { etiket: 'Taksit', deger: sayi(h.taksit_sayisi) > 1 ? `${h.taksit_sayisi} ay` : 'tek çekim' },
                { etiket: 'Sınıf', deger: h.harcama_tipi || 'belirsiz' },
              ],
              listeBaslik: 'Kayıt ayrıntısı',
              satirlar: [
                { ad: 'Ana para', detay: 'faiz hariç', tutar: fmt(sayi(h.ana_para)) },
                { ad: 'Faiz tutarı', detay: 'KKDF/BSMV dahil', tutar: fmt(sayi(h.faiz_tutari)) },
              ],
              not: (h.harcama_tipi || 'belirsiz') === 'belirsiz'
                ? 'Bu hareket işletme mi şahsi mi belirlenmemiş — sınıflandırılmadan işletmenin gerçek kart yükü doğru çıkmaz. Sınıflandırma klasik Kart Hareketleri ekranında.'
                : 'Sınıflandırma yapılmış; işletme/şahsi ayrımı raporlara doğru yansıyor.',
            });
          }}
        />
      </>
    );
  }

  // ── 5) Ekstre Durumu ───────────────────────────────────────────────────────
  const eksikler = kartSatir.filter(k => !k.ekstreVar);
  const gecikmis = kartSatir.filter(k => k.durum === 'gecikti');
  const yakinlar = [...kartSatir].filter(k => k.gunKaldi >= 0).sort((a, b) => a.gunKaldi - b.gunKaldi);
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'Yüklenen ekstre', deger: `${kartSatir.length - eksikler.length} / ${kartSatir.length}`, alt: 'bu dönem', renk: eksikler.length ? R.amber : R.yesil },
        { etiket: 'Eksik', deger: String(eksikler.length), alt: eksikler.length ? eksikler.map(k => k.ad).join(', ') : 'yok', renk: eksikler.length ? R.amber : R.yesil },
        { etiket: 'Gecikmiş kart', deger: String(gecikmis.length), alt: gecikmis.length ? gecikmis.map(k => k.ad).join(', ') : 'yok', renk: gecikmis.length ? R.kirmizi : R.yesil },
        { etiket: 'Sonraki son ödeme', deger: yakinlar[0] ? gunMetni(yakinlar[0].gunKaldi) : '—', alt: yakinlar[0] ? yakinlar[0].ad : 'vadesi gelen yok', renk: R.krem },
      ]} />
      <Liste
        satirlar={kartSatir
          .slice()
          .sort((a, b) => {
            const oncelik = { gecikti: 0, ekstre_bekleniyor: 1, odeme_bekliyor: 2, yuklendi: 3, odendi: 4 };
            return oncelik[a.durum] - oncelik[b.durum];
          })
          .map(k => {
            if (k.durum === 'gecikti') return {
              id: k.id, _k: k, tier: 'kritik',
              baslik: `${k.ad} · son ödeme geçti`,
              alt: `${gunMetni(k.gunKaldi)} · gecikme faizi işliyor`,
              tutar: fmt(k.toplam), aksiyon: 'Ödemeye git', _hedef: '__modul:odeme:bekleyen',
            };
            if (!k.ekstreVar) return {
              id: k.id, _k: k, tier: 'uyari',
              baslik: `${k.ad} · ekstre yüklenmedi`,
              alt: `kesim ayın ${k.kesim || '—'} · dönem borcu tahminî hesaplanıyor`,
              tutar: fmt(k.donem), aksiyon: 'Ekstre yükle', _hedef: '__yerli:ekstre',
            };
            if (k.durum === 'odeme_bekliyor') return {
              id: k.id, _k: k, tier: 'kritik',
              baslik: `${k.ad} · son ödeme ${gunMetni(k.gunKaldi)}`,
              alt: `asgari ${fmt(k.asgari)} · tam ödeme ${fmt(k.toplam)}`,
              tutar: fmt(k.toplam), aksiyon: 'Ödemeye git', _hedef: '__modul:odeme:bekleyen',
            };
            return {
              id: k.id, _k: k, tier: k.durum === 'odendi' ? 'iyi' : 'bilgi',
              baslik: `${k.ad} · ${trKucuk(DONGU[k.durum].ad)}`,
              alt: `kesim ayın ${k.kesim || '—'} · dönem borcu ${fmt(k.donem)} doğrulandı`,
              tutar: fmt(k.toplam), aksiyon: 'Detay', _hedef: '__modul:kart:kartlar',
            };
          })}
        onAc={(l) => (l._hedef === 'kart-yonetimi' ? kartAc(l._k)
          : l._hedef === '__yerli:ekstre' ? eksAc()
          : onKopru?.(l._hedef))}
      />
      {/* Kapsama denetimi bulgusu (2026-07-29): Ekstre Analizi (harcama dağılımı
          grafikleri + arşiv, klasik kart-analiz) v2'de karşılıksızdı — köprü açıldı. */}
      <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
        <button
          onClick={eksAc}
          style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}
        >
          📄 Ekstre yükle (PDF)
        </button>
      </div>

      {/* ── YERLİ EKSTRE ANALİZİ: aylık borç/faiz + kategori dağılımı ── */}
      {(() => {
        const aylik = Array.isArray(analiz?.aylik) ? analiz.aylik : [];
        const kategori = Array.isArray(analiz?.kategori) ? analiz.kategori : [];
        if (!aylik.length && !kategori.length) return null;
        const enBuyukBorc = Math.max(1, ...aylik.map((a) => sayi(a.borc)));
        const katToplam = Math.max(1, kategori.reduce((t, k) => t + sayi(k.tutar), 0));
        return (
          <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
              paddingBottom: 11, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>📊 Ekstre analizi</span>
              <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
                dönem dönem borç ve ödenen faiz · harcamanın nereye gittiği
              </span>
            </div>

            {aylik.length > 0 && (
              <>
                <div style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 9 }}>
                  Dönem borcu ve ödenen faiz
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 18 }}>
                  {aylik.slice(-8).map((a, i) => {
                    const oran = (sayi(a.borc) / enBuyukBorc) * 100;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ width: 62, fontSize: 11, color: R.not2, fontFamily: F.mono }}>
                          {kisaTarih(a.donem)}
                        </span>
                        <div style={{ flex: 1, minWidth: 90, height: 16, borderRadius: 8, background: R.girinti, overflow: 'hidden' }}>
                          <div style={{
                            width: `${Math.max(2, oran)}%`, height: '100%', borderRadius: 8,
                            background: 'linear-gradient(90deg, rgba(217,154,78,.55), rgba(217,154,78,.9))',
                          }} />
                        </div>
                        <span style={{ width: 100, textAlign: 'right', fontFamily: F.mono, fontSize: 12, fontWeight: 700 }}>
                          {fmt(sayi(a.borc))}
                        </span>
                        <span style={{ width: 104, textAlign: 'right', fontFamily: F.mono, fontSize: 11.5, color: R.kirmizi }}>
                          faiz {fmt(sayi(a.faiz))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {kategori.length > 0 && (
              <>
                <div style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 9 }}>
                  Harcama dağılımı · kategori
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {kategori.slice(0, 10).map((k, i) => {
                    const pay = (sayi(k.tutar) / katToplam) * 100;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ width: 132, fontSize: 12, color: R.metin2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {k.kategori || '—'}
                        </span>
                        <div style={{ flex: 1, minWidth: 80, height: 14, borderRadius: 7, background: R.girinti, overflow: 'hidden' }}>
                          <div style={{
                            width: `${Math.max(2, pay)}%`, height: '100%', borderRadius: 7,
                            background: pay >= 30 ? R.kirmizi : pay >= 15 ? R.amber : R.mavi, opacity: 0.78,
                          }} />
                        </div>
                        <span style={{ width: 52, textAlign: 'right', fontFamily: F.mono, fontSize: 11.5, color: R.not }}>
                          %{trSayi(pay, 0)}
                        </span>
                        <span style={{ width: 100, textAlign: 'right', fontFamily: F.mono, fontSize: 12, fontWeight: 700 }}>
                          {fmt(sayi(k.tutar))}
                        </span>
                        <span style={{ width: 62, textAlign: 'right', fontSize: 11, color: R.not2 }}>
                          {sayi(k.adet)} işlem
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── DÖNEM ARŞİVİ (klasik ekstre arşivi) ── */}
      {(() => {
        const kartlarArsiv = Array.isArray(arsiv?.kartlar) ? arsiv.kartlar : [];
        const donemler = kartlarArsiv.flatMap((k) => (k.donemler || []).map((d) => ({ ...d, kartId: k.kart_id, kartAd: k.kart_adi, banka: k.banka })));
        if (!donemler.length) return null;
        return (
          <>
            {/* KART BAZLI ÖZET — sunucu kart kart donem_adet/son_donem/
                toplam_faiz gönderiyordu, v2 hepsini düzleştirip atıyordu.
                "Hangi kartın ekstresi eksik/eski" sorusu cevapsız kalıyordu. */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {kartlarArsiv.map((k) => (
                <div key={k.kart_id} style={{ ...kartYuzey, padding: '10px 14px', borderRadius: 12, minWidth: 168 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 3 }}>
                    {kisalt(k.kart_adi || k.banka || 'Kart', 24)}
                    {k.son_dort_hane ? <span style={{ color: R.not2, fontWeight: 400 }}> ·{k.son_dort_hane}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: R.not2 }}>
                    <span style={{ fontFamily: F.mono }}>{sayi(k.donem_adet)}</span> dönem
                    {k.son_donem ? ` · son ${kisaTarih(k.son_donem)}` : ' · ekstre yok'}
                  </div>
                  {sayi(k.toplam_faiz) > 0 && (
                    <div style={{ fontSize: 11, color: R.kirmizi, fontFamily: F.mono, marginTop: 2 }}>
                      faiz {fmt(sayi(k.toplam_faiz))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Tablo
            baslik="Ekstre arşivi · yüklenmiş dönemler"
            not="satıra tıkla → yanlış yüklenen dönemi sil ve yeniden yükle"
            kolonlar={[
              { ad: 'Kart' }, { ad: 'Dönem' }, { ad: 'Kaynak' }, { ad: 'Dönem borcu', sag: true },
              { ad: 'Harcama', sag: true }, { ad: 'Ödeme', sag: true }, { ad: 'Faiz', sag: true }, { ad: '' },
            ]}
            satirlar={donemler
              .slice()
              .sort((a, b) => String(b.donem).localeCompare(String(a.donem)))
              .slice(0, 40)
              .map((d, i) => ({
                id: `${d.kartAd}-${d.donem}-${i}`, _d: d,
                hucreler: [
                  { v: kisalt(d.kartAd || d.banka || '—', 26), kalin: true },
                  { v: kisaTarih(d.donem), mono: true, renk: R.not },
                  // kaynak: PDF'ten mi okundu, elle mi girildi — güvenilirlik farkı
                  /manuel|elle/i.test(String(d.kaynak || ''))
                    ? { v: 'manuel', rozet: R.amber, sira: 0 }
                    : d.kaynak
                      ? { v: String(d.kaynak).toLowerCase(), rozet: R.yesil, sira: 1 }
                      : { v: '—', renk: R.not3, sira: 0 },
                  { v: fmt(sayi(d.donem_borcu)), mono: true, sag: true, kalin: true },
                  { v: fmt(sayi(d.donem_harcama)), mono: true, sag: true, renk: R.amber },
                  { v: fmt(sayi(d.donem_odeme)), mono: true, sag: true, renk: R.yesil },
                  { v: fmt(sayi(d.donem_faizi)), mono: true, sag: true, renk: sayi(d.donem_faizi) > 0 ? R.kirmizi : R.not },
                  { v: d.kartId ? '🗑 sil' : '', renk: R.kirmizi },
                ],
              }))}
            onSatir={({ _d }) => {
              if (!_d?.kartId) { onToast?.('Bu satırda kart kimliği yok — silme yapılamaz'); return; }
              setDonemSil({ kartId: _d.kartId, kartAd: _d.kartAd || _d.banka || 'Kart', donem: _d.donem });
            }}
            />
          </>
        );
      })()}

      {/* ── DÖNEM SİLME ONAYI — geri alınamaz, ne silinip ne kaldığı yazılı ── */}
      {donemSil && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !donemSilMesgul) setDonemSil(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(10,6,2,.7)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div style={{ ...kartYuzey, width: 500, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Ekstre dönemini sil</div>
              <button onClick={() => !donemSilMesgul && setDonemSil(null)} style={{
                marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
              <b>{donemSil.kartAd}</b> · {kisaTarih(donemSil.donem)}
            </div>
            <div style={{
              padding: '13px 15px', borderRadius: 12, marginBottom: 16,
              background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.28)',
              fontSize: 12, color: R.metin2, lineHeight: 1.7,
            }}>
              <b style={{ color: '#FCA5A5' }}>Bu işlemin geri alması yok.</b> Kayıtlar gerçekten silinir.
              <div style={{ marginTop: 9 }}>
                <b>Silinecek:</b> bu aya ait <b>harcama</b> ve <b>faiz</b> hareketleri + dönem özeti<br />
                <b>Korunacak:</b> <b>ödeme</b> ve <b>devir</b> kayıtları — onlar kasa tarafının izi, dokunulmaz
              </div>
              <div style={{ marginTop: 9, color: R.not2 }}>
                Kullanım amacı: yanlış ekstre yüklendiyse silip doğrusunu yüklemek.
                Silme sonrası kartın dönem borcu yeniden hesaplanır.
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button disabled={donemSilMesgul} onClick={() => setDonemSil(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={donemSilMesgul} onClick={donemSilUygula} style={{
                padding: '10px 18px', borderRadius: 10, border: '1px solid rgba(220,38,38,.5)', cursor: 'pointer',
                background: 'rgba(220,38,38,.2)', color: '#FCA5A5', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{donemSilMesgul ? 'Siliniyor…' : '🗑 Evet, bu dönemi sil'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── YERLİ EKSTRE YÜKLEME MODALI (klasik EkstreYukle akışı kadifede) ── */}
      {eksModal && (() => {
        const m = eksSonuc?.mutabakat;
        const kart = eksSonuc?.eslesen_kart;
        return (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !eksYukleniyor && !eksTtBusy) setEksModal(false); }}
            style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 620, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>📄 Ekstre Yükle</div>
                <div style={{ fontSize: 11.5, color: R.not2 }}>önizleme — kayıt yazılmaz</div>
                <button onClick={() => setEksModal(false)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: R.metin2, marginBottom: 14 }}>
                Banka PDF ekstresini seç → otomatik ayrıştır + mutabakat. Sonra ⚡ tek tıkla kapat.
              </div>

              {/* Dosya seçimi */}
              <label style={{
                display: 'block', padding: '22px 18px', borderRadius: 14, textAlign: 'center',
                border: `1px dashed ${R.bakir}66`, background: R.girinti, cursor: 'pointer', marginBottom: 14,
              }}>
                <input type="file" accept="application/pdf" style={{ display: 'none' }}
                  onChange={(e) => eksDosyaYukle(e.target.files?.[0])} />
                <div style={{ fontSize: 13, fontWeight: 700, color: R.bakir }}>
                  {eksYukleniyor ? '⏳ Ayrıştırılıyor…' : (eksDosyaAdi || 'PDF seçmek için tıkla')}
                </div>
                {!eksYukleniyor && eksDosyaAdi && <div style={{ fontSize: 11, color: R.not, marginTop: 4 }}>başka dosya seçmek için tekrar tıkla</div>}
              </label>

              {eksHata && (
                <div style={{ padding: '11px 15px', borderRadius: 12, background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`, fontSize: 12.5, color: R.kirmizi, marginBottom: 12 }}>
                  {eksHata}
                </div>
              )}

              {/* Ayrıştırma sonucu */}
              {eksSonuc && (
                <>
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 12 }}>
                    <span>Banka: <b>{FORMAT_AD[eksSonuc.banka_format] || eksSonuc.banka_format || '—'}</b></span>
                    <span>Kart: {kart
                      ? <b style={{ color: R.yesil }}>{kart.kart_adi || kart.ad || kart.banka}</b>
                      : <b style={{ color: R.amber }}>eşleşen kart bulunamadı</b>}
                    </span>
                    {eksSonuc.son_dort && <span style={{ fontFamily: F.mono, color: R.not }}>…{eksSonuc.son_dort}</span>}
                  </div>

                  {!kart && (
                    <button disabled={kartEkleBusy} onClick={eksKartiEkle} style={{
                      padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer', marginBottom: 12,
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>
                      {kartEkleBusy ? 'Ekleniyor…' : '+ Bu kartı sisteme ekle'}
                    </button>
                  )}

                  {m && (
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10,
                      padding: '13px 15px', borderRadius: 12, background: R.girinti,
                      border: `1px solid ${m.tutar_uyumlu ? `${R.yesil}55` : `${R.amber}55`}`, marginBottom: 12,
                    }}>
                      {[
                        ['Ekstre borcu', fmt(sayi(m.ekstre_borc)), R.krem],
                        ['Sistem borcu', fmt(sayi(m.sistem_borc)), R.krem],
                        ['Fark', fmt(sayi(m.fark)), m.tutar_uyumlu ? R.yesil : R.kirmizi],
                        ['Yeni işlem', String(sayi(m.yeni_islem_adet)), sayi(m.yeni_islem_adet) ? R.amber : R.yesil],
                      ].map(([et, dg, renk]) => (
                        <div key={et}>
                          <div style={{ fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>{et}</div>
                          <div style={{ fontFamily: F.mono, fontSize: 14.5, fontWeight: 700, color: renk, marginTop: 3 }}>{dg}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Eşik üstü fark onayı — klasikte window.confirm idi */}
                  {eksOnaySor && (
                    <div style={{ padding: '13px 16px', borderRadius: 12, background: `${R.amber}12`, border: `1px solid ${R.amber}66`, marginBottom: 12 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: R.amber }}>
                        ⚠ Fark güvenlik eşiğinin üstünde: {fmt(Math.abs(eksOnaySor.fark))}
                      </div>
                      <div style={{ fontSize: 12, color: R.metin2, marginTop: 6, lineHeight: 1.55 }}>
                        Bu genelde İLK mutabakatta eski devir tabanından kaynaklanır ve güvenlidir
                        (düzeltme birikmez, her zaman yeniden hesaplanır). Sistem borcu ekstre
                        borcuna ({fmt(sayi(eksOnaySor.ekstreBorc))}) eşitlensin mi?
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button disabled={eksTtBusy} onClick={async () => {
                          setEksTtBusy(true);
                          try { await eksDevirVeBitir(eksOnaySor.impOzet, eksOnaySor.yeniBorc, true); setEksOnaySor(null); }
                          catch (e) { setEksHata(e?.message || 'Düzeltme yapılamadı'); }
                          finally { setEksTtBusy(false); }
                        }} style={{
                          padding: '8px 15px', borderRadius: 9, border: 'none', cursor: 'pointer',
                          background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                          fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                        }}>Evet, eşitle</button>
                        <button onClick={() => setEksOnaySor(null)} style={{
                          padding: '8px 13px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                        }}>Vazgeç</button>
                      </div>
                    </div>
                  )}

                  {/* Sonuç özeti */}
                  {eksImpSonuc && (
                    <div style={{ padding: '11px 15px', borderRadius: 12, background: `${R.yesil}12`, border: `1px solid ${R.yesil}55`, fontSize: 12.5, color: R.metin2, marginBottom: 12, lineHeight: 1.6 }}>
                      ✓ {sayi(eksImpSonuc.yazilan)} işlem aktarıldı
                      {sayi(eksImpSonuc.atlanan_veya_mevcut) ? ` · ${sayi(eksImpSonuc.atlanan_veya_mevcut)} zaten kayıtlıydı` : ''}
                      {eksImpSonuc.devir ? ` · devir düzeltmesi ${fmt(Math.abs(sayi(eksImpSonuc.devir_duzeltme)))}` : ''}
                      {' — yeni sistem borcu '}<b style={{ fontFamily: F.mono }}>{fmt(sayi(eksImpSonuc.yeni_sistem_borc))}</b>
                    </div>
                  )}

                  {kart && !eksImpSonuc && !eksOnaySor && (
                    <button disabled={eksTtBusy} onClick={eksTekTik} style={{
                      width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 13.5, fontWeight: 800, fontFamily: 'inherit', marginBottom: 12,
                    }}>
                      {eksTtBusy ? 'Mutabakat yapılıyor…' : '⚡ Tek Tık Mutabakat — aktar + farkı kapat'}
                    </button>
                  )}
                </>
              )}

              {/* Manuel ekstre (Axess gibi PDF'i okunamayan kartlar) */}
              {manForm ? (
                <div style={{ padding: '14px 16px', borderRadius: 12, background: R.girinti, border: `1px solid ${R.bakir}44` }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: R.bakir, marginBottom: 12 }}>Manuel ekstre girişi</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.7px', color: R.not2, fontWeight: 700, marginBottom: 6 }}>Kart *</div>
                      <select value={manForm.kart_id} onChange={(e) => setManForm((f) => ({ ...f, kart_id: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem, fontSize: 13, fontFamily: 'inherit' }}>
                        <option value="">Seçin…</option>
                        {kartlar.map((k) => <option key={k.id} value={k.id}>{k.kart_adi || k.banka}</option>)}
                      </select>
                    </div>
                    {[['donem', 'Kesim tarihi *', 'date'], ['son_odeme', 'Son ödeme', 'date'],
                      ['donem_borcu', 'Dönem borcu (₺) *', 'number'], ['asgari_tutar', 'Asgari (₺)', 'number'],
                      ['faiz_orani', 'Yıllık faiz %', 'number']].map(([k, ad, tip]) => (
                      <div key={k}>
                        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.7px', color: R.not2, fontWeight: 700, marginBottom: 6 }}>{ad}</div>
                        <input type={tip} value={manForm[k]} onChange={(e) => setManForm((f) => ({ ...f, [k]: e.target.value }))}
                          style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem, fontSize: 13, fontFamily: tip === 'number' ? F.mono : 'inherit', textAlign: tip === 'number' ? 'right' : 'left', colorScheme: 'dark' }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                    <button disabled={manBusy} onClick={() => setManForm(null)} style={{
                      padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={manBusy} onClick={eksManuelKaydet} style={{
                      padding: '8px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>{manBusy ? 'Kaydediliyor…' : 'Kaydet'}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setManForm({ kart_id: '', donem: '', son_odeme: '', donem_borcu: '', asgari_tutar: '', faiz_orani: '' })} style={{
                  padding: '8px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                }}>
                  ✍️ PDF okunmuyor mu? Manuel ekstre gir (Axess vb.)
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
