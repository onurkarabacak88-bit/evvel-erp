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
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, BosDurum, HataBandi, Liste } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Tarih aritmetiği YEREL kalır — toISOString UTC'ye çevirip TR'de (+3) tarihi
// bir gün geri kaydırır (Ödeme Merkezi'nde yaşanmış hata, d2340fa).
const bugunYerelISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const gunEkleISO = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const kisalt = (t, n = 60) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
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

// Açılış kasa farkı tolerans bantları — operasyon_kurallar.tolerans_seviyesi
// ile birebir: ±50 normal · 50–200 uyarı · 200+ kritik. Sunucu `fark_seviye`
// gönderir; renk BUNA göre verilir (5 TL fark kırmızı olmamalı).
const SEVIYE = {
  normal: { ad: 'tolerans içi', renk: R.metin2 },
  uyari: { ad: 'uyarı', renk: R.amber },
  kritik: { ad: 'kritik', renk: R.kirmizi },
};

// ── BAR ÖZETİ: kalem sözlüğü (operasyon_merkez_api._BAR_KEYS ile aynı sıra) ──
// Pasta ÇEŞİTLERİ (pasta_*) burada yok: devirde ve gün içi denetimde yalnız
// pasta_adet TOPLAMI karşılaştırılır — çeşitler günlük taze, gürültü yapar.
const BAR_KALEM = [
  ['bardak_kucuk', 'Bardak küçük'], ['bardak_buyuk', 'Bardak büyük'],
  ['bardak_plastik', 'Bardak plastik'], ['karton_bardak', 'Karton bardak'],
  ['su_adet', 'Su'], ['sut_litre', 'Süt (L)'], ['redbull_adet', 'Red Bull'],
  ['soda_adet', 'Soda'], ['cookie_adet', 'Cookie'], ['pasta_adet', 'Pasta (toplam)'],
  ['surup_adet', 'Şurup'], ['kahve_paket', 'Kahve paket'], ['kapak_adet', 'Kapak'],
  ['pecete_paket', 'Peçete'], ['diger_sarf', 'Diğer sarf'],
];
// Gün içi denetime giren kalemler — stok_bar_uyum.GUN_ICI_DENETIM_KEYS ile birebir.
// Negatif "satılan" YALNIZ bu kalemlerde uyarıya döner (sunucu da öyle sayar).
const BAR_DENETIM = new Set([
  'bardak_kucuk', 'bardak_buyuk', 'bardak_plastik',
  'su_adet', 'sut_litre', 'redbull_adet', 'soda_adet', 'pasta_adet',
]);
// Kapanış stoğu nereden alındı? "kapanis" kesin, ötekiler geçici yedek.
const BAR_KAPANIS_KAYNAK = {
  kapanis: { ad: 'kesin', renk: R.yesil, aciklama: 'şubenin tamamladığı kapanış sayımı' },
  devir: { ad: 'geçici · devir', renk: R.amber, aciklama: 'kapanış yok — vardiya devir sayımı yedek alındı' },
  ozet: { ad: 'geçici · özet', renk: R.amber, aciklama: 'kapanış yok — gün özeti yedek alındı' },
};

// ── KAPANIŞ TAKİP: ciro + nakit denklemi ─────────────────────────────────────
// Sunucu sözleşmesi: operasyon_merkez_api.kapanis_takip (satır anahtarları
// nakit/pos/online/ciro_tutar/online_cift_kayit/nakit_kasa_fark_tl…).
// ÇİFT KAYIT: şube online alanına yanlışlıkla nakit+POS toplamını yazarsa gün
// cirosu iki kez sayılır. Sunucu bunu `online_cift_kayit` ile bildirir; bayrak
// gelmezse aynı testi burada da yaparız (emniyet ağı — klasik ekranla birebir).
const ktCift = (r) => {
  const n = sayi(r?.nakit); const p = sayi(r?.pos); const o = sayi(r?.online);
  return r?.online_cift_kayit === true
    || (o > 0 && n > 0 && p > 0 && Math.abs(o - (n + p)) < 0.5);
};
const ktOnlineNet = (r) => (ktCift(r) ? 0 : sayi(r?.online));
const ktCiro = (r) => {
  const n = sayi(r?.nakit); const p = sayi(r?.pos); const o = ktOnlineNet(r);
  const t = sayi(r?.ciro_tutar);
  if (t > 0) return ktCift(r) && t > n + p + 0.5 ? n + p : t;
  return n + p + o;
};

// Nakit Δ = sabah kasa + X nakit − teslim − devir − ara teslim − nakit gider.
// İŞARET KURALI (sunucu): + → kasa AÇIĞI, − → kasa FAZLASI.
// TAM denkleme (açılış VE kapanış var) alarm verir. KISMİ denklemede gün hâlâ
// sürüyor; oradaki sayı gerçek fark değil "şu an kasada olması gereken"dir —
// kırmızı/yeşil boyanmaz, yoksa her öğleden sonra sahte kasa açığı alarmı olur.
// ⚠️ utils/api.fmt() sonuna zaten " ₺" ekler — üstüne bir daha yazma.
// (Tezgâhta "430 ₺ ₺ açık" olarak çıktı, 2026-08-01.)
const tl = (v) => fmt(Math.round(sayi(v)));            // "18.500 ₺"
const tlSade = (v) => Math.round(sayi(v)).toLocaleString('tr-TR');  // "18.500"
const tlIsaretli = (v) => `${sayi(v) > 0 ? '+' : ''}${tl(v)}`;      // "+430 ₺"

const ktDelta = (r) => {
  const tam = r?.nakit_denkleme_tam === true || (!!r?.acildi && !!r?.kapanis_tamam);
  const kismi = r?.nakit_denkleme_kismi === true;
  const ham = r?.nakit_kasa_fark_tl;
  const gecerli = (tam || kismi) && ham != null && Number.isFinite(Number(ham));
  return { tam, kismi, gecerli, deger: gecerli ? Number(ham) : null };
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

const okButon = {
  width: 26, height: 26, borderRadius: 8, border: `1px solid ${R.cizgi3}`,
  background: R.girinti, color: R.metin2, fontSize: 13, cursor: 'pointer',
  fontFamily: 'inherit', lineHeight: 1,
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

/** Öneri-only şeridi — Denetim modülüyle AYNI dil (motor önerir, hüküm insanın). */
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

/** Uzlaştırma modalı form alanları. */
const opsAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none', marginBottom: 12,
};
const opsEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

// ── KASA KAYNAK DÜZELTME (sunucu sözleşmesi: operasyon_merkez_api._SEBEPLER) ──
// Klasik OperasyonMerkezi.kkDuzeltPayloadDogrula ile birebir; sunucu 400'ü
// beklemeden aynı cümleyi burada söyleriz (PIN boşuna harcanmasın).
function kdDogrula(sebep, payload, uyariTip) {
  const p = payload || {};
  if (sebep === 'ciro_yanlis') {
    if (uyariTip === 'ACILIS_KASA_FARK') return 'Devir uyumsuzluğu için ciro düzeltmesi uygun değil.';
    if (p.yeni_nakit == null && p.yeni_pos == null && p.yeni_online == null) {
      return 'En az bir ciro alanı girin (nakit, POS veya online).';
    }
  }
  if (sebep === 'acilis_yanlis') {
    if (p.yeni_acilis_kasa == null || !Number.isFinite(Number(p.yeni_acilis_kasa)) || Number(p.yeni_acilis_kasa) < 0) {
      return 'Yeni açılış kasa sayımı (₺) zorunlu — 0 veya pozitif sayı girin.';
    }
  }
  if (sebep === 'devir_yanlis') {
    if (p.yeni_teslim == null && p.yeni_devir == null) return 'Teslim veya devir alanından en az birini girin.';
  }
  if (sebep === 'gider_eksik') {
    if (uyariTip === 'ACILIS_KASA_FARK') return 'Devir uyumsuzluğu için gider eklenemez.';
    if (p.tutar == null || !Number.isFinite(Number(p.tutar)) || Number(p.tutar) <= 0) {
      return 'Gider tutarı 0\'dan büyük olmalı.';
    }
  }
  if (sebep === 'ciro_fazla') {
    if (uyariTip === 'ACILIS_KASA_FARK') return 'Devir uyumsuzluğu için ciro fazla eklenemez.';
    if (p.tutar == null || !Number.isFinite(Number(p.tutar)) || Number(p.tutar) <= 0) {
      return 'Ciroya eklenecek tutar 0\'dan büyük olmalı.';
    }
  }
  return null; // gercek_acik → kaynak değişmez, doğrulama gerekmez
}

/** Gelişmiş sebep listesi — uyarı tipine + fark yönüne göre daralır. */
function kdSebepler(uyariTip, farkTl) {
  const fark = Number(farkTl) || 0;
  const devir = uyariTip === 'ACILIS_KASA_FARK';
  const fazla = devir ? fark > 0 : fark < 0;
  const gercek = fazla ? '⚠️ Gerçek fazla — kaynak değişmez' : '⚠️ Gerçek açık — kaynak değişmez';
  if (devir) {
    return [
      ['acilis_yanlis', '🌅 Sabahçı kasa sayımı yanlış (bugünkü açılış)'],
      ['devir_yanlis', '🌙 Akşamcı devir/teslim yanlış (önceki gün kapanış)'],
      ['gercek_acik', gercek],
    ];
  }
  return [
    ['ciro_yanlis', '📝 Ciro yanlış (nakit / POS / online)'],
    fazla ? ['ciro_fazla', '💰 Z eksik basılmış — nakit ciroya ekle']
          : ['gider_eksik', '💸 Eksik nakit gider (anlık gidere ekle)'],
    ['devir_yanlis', '🌙 Kapanış teslim / devir yanlış (aynı gün)'],
    ['acilis_yanlis', '🌅 Açılış kasa sayımı yanlış'],
    ['gercek_acik', gercek],
  ];
}

const KD_SEBEP_AD = {
  ciro_yanlis: 'Ciro düzeltildi',
  acilis_yanlis: 'Açılış sayımı düzeltildi',
  gider_eksik: 'Eksik nakit gider eklendi',
  ciro_fazla: 'Ciroya nakit eklendi',
  devir_yanlis: 'Teslim / devir düzeltildi',
  gercek_acik: 'Gerçek fark kabul edildi (kaynak değişmedi)',
};

const zamanKisa = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—');

const kdKutuStil = (aktif) => ({
  ...opsAlanStil, marginBottom: 0, marginTop: 4,
  borderColor: aktif ? R.bakirAcik : R.cizgi3, fontWeight: aktif ? 700 : 400,
  fontFamily: F.mono,
});

export default function OpsModulu({ gorunum, onCekmece, onKopru, onToast, onGorunum }) {
  // ── SİPARİŞ AKIŞI + KULE ortak verisi ─────────────────────────────────────
  const [kule, setKule] = useState(null);        // kontrol-kulesi cevabı
  // Sipariş birleştirme (2026-07-31) — MEVCUT akış kanbanının 'bekliyor'
  // kolonunda çalışır; ayrı ekran/görünüm AÇILMADI.
  const [birlSecili, setBirlSecili] = useState({});  // talep_id → sube_id
  const [birlNot, setBirlNot] = useState('');
  const [birlMesgul, setBirlMesgul] = useState(false);
  const [kuleHata, setKuleHata] = useState('');
  const [subeOzet, setSubeOzet] = useState(null); // sevkiyat-subeler-ozet
  // ── UZLAŞTIRMA (uyumsuzluk ÇÖZME, 2026-07-31) ─────────────────────────────
  const [uzSevk, setUzSevk] = useState(null);      // sevkiyat uyumsuzlukları
  const [uzKasa, setUzKasa] = useState(null);      // kasa uyumsuzlukları
  const [uzPers, setUzPers] = useState(null);      // personel-vardiya
  const [uzHata, setUzHata] = useState('');
  const [uzAlt, setUzAlt] = useState('sevkiyat');
  const [uzModal, setUzModal] = useState(null);    // {tip, kayit, adet, notu, sayfa?, sebep?, payload?, gelismis?, pin?}
  const [uzMesgul, setUzMesgul] = useState('');
  // Kasa KAYNAK düzeltme + düzeltme tarihçesi (İŞLETME PIN'li — 2026-07-31)
  const [kdMesgul, setKdMesgul] = useState(false);
  const [thVeri, setThVeri] = useState(null);      // {yukleniyor, tarihce[], hata}
  const [thOnay, setThOnay] = useState(null);      // {kayit, pin, notu} — iki adımlı geri alma
  const [thMesgul, setThMesgul] = useState('');    // geri alınmakta olan audit id

  // ── CİRO FARK DEFTERİ (Faz 6c) — uzlaştırma masasının 4. kalemi ──────────
  const [uzFark, setUzFark] = useState([]);
  // Talep ↔ tahsis uyumsuzluğu: okuma ucu ZATEN vardı (/ops/v2/siparis-akis
  // içindeki tahsis[] dizisi) — v2 bu ucu hiç çağırmıyordu (2026-07-31).
  const [uzTahsis, setUzTahsis] = useState([]);
  const [fdModal, setFdModal] = useState(null);   // {tip, kayit, aciklama}
  const [fdMesgul, setFdMesgul] = useState(false);

  const fdUygula = async () => {
    const m = fdModal;
    if (!m) return;
    setFdMesgul(true);
    try {
      if (m.tip === 'karar') {
        await api(`/ciro-taslak/fark-defteri/${m.kayit.id}/karar`, { method: 'POST', body: {
          karar: m.karar, aciklama: (m.aciklama || '').trim() || null,
        } });
        onToast?.(m.karar === 'acik' ? '✓ Karar geri alındı' : '✓ Karar kaydedildi');
      } else if (m.tip === 'gelire') {
        await api(`/ciro-taslak/fark-defteri/${m.kayit.id}/gelire-yaz`, { method: 'POST' });
        onToast?.('✓ Fazla tutar dış kaynak geliri olarak yazıldı');
      } else if (m.tip === 'gidere') {
        await api(`/ciro-taslak/fark-defteri/${m.kayit.id}/gidere-yaz`, { method: 'POST' });
        onToast?.('✓ Eksik tutar anlık gider olarak yazıldı');
      }
      setFdModal(null);
      uzYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setFdMesgul(false); }
  };

  const uzYukle = useCallback(() => {
    setUzHata('');
    Promise.all([
      api('/ops/siparis/sevkiyat-uyumsuzluklar?gun=30&limit=300').catch(() => null),
      api('/ops/kasa-uyumsuzluk').catch(() => null),
      api('/ops/personel-vardiya-uyumsuzluk').catch(() => null),
      api('/ciro-taslak/fark-defteri?gun=45').catch(() => null),
      api('/ops/v2/siparis-akis?limit=200').catch(() => null),
    ]).then(([sv, ks, pr, fd, ak]) => {
      setUzSevk(sv || { satirlar: [] });
      setUzKasa(ks || {});
      setUzPers(pr || { kayitlar: [] });
      setUzFark(Array.isArray(fd?.satirlar) ? fd.satirlar : (Array.isArray(fd?.kayitlar) ? fd.kayitlar : (Array.isArray(fd) ? fd : [])));
      // Talebi düzleştir: her kalem ayrı satır; yalnız talep≠tahsis ve HENÜZ
      // uzlaşılmamış olanlar. (Uzlaşılmış kalem 'tam' durumda ve iki sayı eşit.)
      const akis = Array.isArray(ak?.siparis_akis) ? ak.siparis_akis : [];
      const satirlar = [];
      akis.forEach((t) => {
        (Array.isArray(t.tahsis) ? t.tahsis : []).forEach((k) => {
          if (!k || typeof k !== 'object') return;
          if (k.uzlasildi) return;
          const talep = sayi(k.talep_adet);
          const tahsis = sayi(k.tahsis_adet);
          if (talep === tahsis) return;
          satirlar.push({
            talep_id: t.id,
            urun_id: k.kalem_kodu || k.urun_id || '',
            kalem_adi: k.kalem_adi || k.kalem_kodu || k.urun_id || '—',
            sube_adi: t.sube_adi || '—',
            tarih: t.tarih || t.olusturma || '',
            talep_adet: talep,
            tahsis_adet: tahsis,
            durum: k.durum || '',
          });
        });
      });
      setUzTahsis(satirlar.filter((s) => s.talep_id && s.urun_id));
    }).catch((e) => setUzHata(e?.message || 'Uzlaştırma verisi alınamadı'));
  }, []);

  const ktMiniBtn = {
    padding: '5px 11px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${R.cizgi3}`,
    background: 'transparent', color: R.metin2, fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
  };

  // ── SİPARİŞ KATALOĞU (Faz 3, 2026-07-31) ──────────────────────────────────
  const [ktKatalog, setKtKatalog] = useState(null);
  const [ktHata, setKtHata] = useState('');
  const [ktModal, setKtModal] = useState(null);   // {tip, kategori, urun, ad, deger}
  const [ktMesgul, setKtMesgul] = useState(false);
  const [ktSyncOnay, setKtSyncOnay] = useState('');

  const ktYukle = useCallback(() => {
    setKtHata('');
    api('/ops/siparis/katalog')
      .then((d) => setKtKatalog(Array.isArray(d?.kategoriler) ? d.kategoriler : []))
      .catch((e) => setKtHata(e?.message || 'Katalog alınamadı'));
  }, []);

  const ktUygula = async () => {
    const m = ktModal;
    if (!m) return;
    setKtMesgul(true);
    try {
      if (m.tip === 'kategori') {
        const ad = (m.ad || '').trim();
        if (ad.length < 2) { onToast?.('Kategori adı en az 2 karakter'); setKtMesgul(false); return; }
        await api('/ops/siparis/kategori', { method: 'POST', body: { ad, emoji: (m.deger || '📦').trim() || '📦' } });
        onToast?.(`✓ «${ad}» kategorisi oluşturuldu`);
      } else if (m.tip === 'urun') {
        const ad = (m.ad || '').trim();
        if (!ad) { onToast?.('Ürün adı girin'); setKtMesgul(false); return; }
        await api('/ops/siparis/urun', {
          method: 'POST',
          body: { kategori_kod: m.kategori.kod, urun_adi: ad, aciklama: (m.deger || '').trim() || null },
        });
        onToast?.(`✓ «${ad}» kataloğa eklendi`);
      } else if (m.tip === 'ad') {
        const ad = (m.ad || '').trim();
        if (!ad) { onToast?.('Yeni ad girin'); setKtMesgul(false); return; }
        await api('/ops/siparis/urun-ad', {
          method: 'POST',
          body: { kategori_kod: m.kategori.kod, urun_id: m.urun.id, yeni_ad: ad },
        });
        onToast?.('✓ Ürün adı güncellendi');
      } else if (m.tip === 'fiyat') {
        const f = String(m.deger).trim().replace(',', '.');
        if (f !== '' && !Number.isFinite(Number(f))) { onToast?.('Geçerli bir fiyat girin'); setKtMesgul(false); return; }
        await api('/ops/siparis/urun-fiyat', {
          method: 'POST',
          body: { kategori_kod: m.kategori.kod, urun_id: m.urun.id, birim_fiyat_tl: f === '' ? null : Number(f) },
        });
        onToast?.('✓ Birim fiyat güncellendi');
      } else if (m.tip === 'pasif') {
        await api('/ops/siparis/urun-durum', {
          method: 'POST',
          body: { kategori_kod: m.kategori.kod, urun_id: m.urun.id, aktif: false },
        });
        onToast?.('✓ Ürün pasife alındı — şubeler artık sipariş edemez');
      }
      setKtModal(null);
      ktYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setKtMesgul(false); }
  };


  /** Uzlaştırmayı uygula — her tip KENDİ ucuna ve KENDİ gövdesine gider. */
  const uzUygula = async () => {
    const m = uzModal;
    if (!m) return;
    setUzMesgul(m.tip);
    try {
      if (m.tip === 'sevkiyat') {
        await api('/ops/siparis/sevkiyat-uyumsuzluk-coz', {
          method: 'POST',
          body: {
            stok_yolda_id: m.kayit.stok_yolda_id || m.kayit.id,
            cozum_adet: sayi(m.adet),
            notu: (m.notu || '').trim().slice(0, 500) || null,
          },
        });
        onToast?.('✓ Sevkiyat satırı uzlaştırıldı');
      } else if (m.tip === 'kasa') {
        await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(m.kayit.id)}/coz`, {
          method: 'POST',
          body: {
            notu: (m.notu || '').trim(),
            // Boş bırakılırsa ORİJİNAL fark kabul edilir (klasik davranış)
            duzeltilen_fark_tl: String(m.adet).trim() === '' ? null : sayi(m.adet),
          },
        });
        onToast?.('✓ Kasa uyumsuzluğu çözüldü');
      } else if (m.tip === 'personel') {
        await api(`/ops/personel-vardiya-uyumsuzluk/${encodeURIComponent(m.kayit.id)}/coz`, {
          method: 'POST',
          body: { notu: (m.notu || '').trim() || null },
        });
        onToast?.('✓ Personel-vardiya uyumsuzluğu çözüldü');
      } else if (m.tip === 'tahsis') {
        // Uzlaşma adedi HEM talebin HEM tahsisin yeni değeri olur; kalem 'tam'a geçer
        await api('/ops/siparis/talep-tahsis-uyumsuzluk-coz', {
          method: 'POST',
          body: {
            talep_id: m.kayit.talep_id,
            urun_id: m.kayit.urun_id,
            cozum_adet: Math.max(0, Math.round(sayi(m.adet))),
            notu: (m.notu || '').trim() || null,
          },
        });
        onToast?.(`✓ ${m.kayit.kalem_adi} uzlaştırıldı — talep ve tahsis ${Math.max(0, Math.round(sayi(m.adet)))} oldu`);
      }
      setUzModal(null);
      uzYukle();
    } catch (e) {
      onToast?.(e?.message || 'Uzlaştırma kaydedilemedi');
    } finally { setUzMesgul(''); }
  };

  /** Kasa farkını CANLI veriyle tazele — kaynağı DEĞİŞTİRMEZ, bayat dökümü yeniler. */
  const uzKasaYenidenHesapla = async (kayit) => {
    setUzMesgul(`yh:${kayit.id}`);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(kayit.id)}/yeniden-hesapla`, { method: 'POST' });
      onToast?.(r?.otomatik_cozuldu
        ? '🔄 Yeniden hesaplandı — fark eşik altına düştü, çözüldü'
        : `🔄 Yeniden hesaplandı — yeni fark ${fmt(sayi(r?.yeni_fark))}`);
      uzYukle();
    } catch (e) {
      onToast?.(e?.message || 'Yeniden hesaplanamadı');
    } finally { setUzMesgul(''); }
  };

  /**
   * KAYNAĞI DÜZELT — /coz'dan farkı: bu uç gerçek mali kaydı (ciro/açılış/gider/
   * devir) değiştirir, sonra farkı yeniden hesaplar. Bu yüzden İŞLETME onayı
   * (Merve Karabacak PIN) ister; sunucu doğrular, hatalıysa 403 döner.
   */
  const kdGonder = async () => {
    const m = uzModal;
    if (!m?.kayit?.id) return;
    const uyariTip = String(m.kayit.tip || '');
    const sebep = m.sebep || '';
    if (!sebep) { onToast?.('Önce yanlış olan kutuyu düzelt veya bir sebep seç'); return; }
    const hata = kdDogrula(sebep, m.payload, uyariTip);
    if (hata) { onToast?.(hata); return; }
    const pin = String(m.pin || '').replace(/\s/g, '');
    if (!/^\d{4}$/.test(pin)) { onToast?.('İşletme onay PIN kodu 4 haneli olmalı'); return; }

    setKdMesgul(true);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(m.kayit.id)}/kaynak-duzelt`, {
        method: 'POST',
        body: {
          sebep,
          payload: m.payload || {},
          notu: (m.notu || '').trim() || null,
          onay_pin: pin,
        },
      });
      if (r?.durum === 'zaten_cozulmus') {
        onToast?.('Bu uyarı zaten çözülmüş — ikinci mali kayıt yazılmadı');
      } else {
        const eski = fmt(sayi(r?.eski_fark));
        const yeni = fmt(sayi(r?.yeni_fark));
        // Cascade: aynı şubenin bağlı günleri de etkilenmiş olabilir — susturma.
        const cas = Array.isArray(r?.cascade) ? r.cascade : [];
        let casMsg = '';
        if (cas.length) {
          const cozulen = cas.filter((c) => c?.otomatik_cozuldu).length;
          const acik = cas.length - cozulen;
          const p = [];
          if (cozulen) p.push(`${cozulen} bağlı uyarı çözüldü`);
          if (acik) p.push(`${acik} bağlı uyarı hâlâ açık`);
          casMsg = ` · 🔗 ${p.join(', ')}`;
        }
        onToast?.(r?.otomatik_cozuldu
          ? `✓ Kaynak düzeltildi — fark sıfırlandı (${eski} → 0)${casMsg}`
          : `🔧 Kaynak düzeltildi — ${eski} → ${yeni}${casMsg}`);
      }
      setUzModal(null);
      uzYukle();
    } catch (e) {
      onToast?.(e?.message || 'Düzeltme başarısız — PIN yanlış olabilir');
    } finally { setKdMesgul(false); }
  };

  /** Düzeltme tarihçesini yükle (salt-okur audit defteri). */
  const thYukle = useCallback((uyariId) => {
    setThVeri({ yukleniyor: true, tarihce: [], hata: '' });
    api(`/ops/kasa-uyumsuzluk/${encodeURIComponent(uyariId)}/duzeltme-tarihce`)
      .then((r) => setThVeri({ yukleniyor: false, tarihce: Array.isArray(r?.tarihce) ? r.tarihce : [], hata: '' }))
      .catch((e) => setThVeri({ yukleniyor: false, tarihce: [], hata: e?.message || 'Tarihçe yüklenemedi' }));
  }, []);

  /** Bir düzeltmeyi GERİ AL — eski değerler restore edilir, fark yeniden hesaplanır. */
  const thGeriAl = async () => {
    const o = thOnay;
    if (!o?.kayit?.id || !uzModal?.kayit?.id) return;
    const pin = String(o.pin || '').replace(/\s/g, '');
    if (!/^\d{4}$/.test(pin)) { onToast?.('İşletme onay PIN kodu 4 haneli olmalı'); return; }
    setThMesgul(o.kayit.id);
    try {
      const r = await api(`/ops/kasa-uyumsuzluk/duzeltme/${encodeURIComponent(o.kayit.id)}/geri-al`, {
        method: 'POST',
        body: { notu: (o.notu || '').trim() || null, onay_pin: pin },
      });
      onToast?.(r?.otomatik_cozuldu
        ? `↶ Geri alındı — fark sıfırlandı · ${r?.restore || ''}`
        : `↶ Geri alındı — yeni fark ${fmt(sayi(r?.yeni_fark))} · ${r?.restore || ''}`);
      setThOnay(null);
      thYukle(uzModal.kayit.id);
      uzYukle();
    } catch (e) {
      onToast?.(e?.message || 'Geri alma başarısız — PIN yanlış olabilir');
    } finally { setThMesgul(''); }
  };

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
  // ── YERLİ DEPO YÖNLENDİRME (köprü kaldırma turu, 2026-07-29) ──────────────
  // Bekleyen sipariş → hedef depo ataması artık kadife modal; aynı guard'lı uç:
  // POST /ops/siparis/sevkiyata-gonder. Toptancı akışı (liste+yazdırma) klasik
  // kulede kalır — modaldan köprü verilir (işlev kaybı yasak).
  const [yonForm, setYonForm] = useState(null);   // {sip, mod:'depo'|'toptanci', depo, talimat, tedarikciId, secili:Set, not}
  const [depolar, setDepolar] = useState([]);
  const [yonMesgul, setYonMesgul] = useState(false);
  const [tedarikciler, setTedarikciler] = useState([]);
  // ── BAR AKIŞI (ops-merkez P0 sekmeleri, 2026-07-30) ───────────────────────
  // Klasik Operasyon Merkezi'nin 5 sekmesi (açılış kasa takip · kapanış takip ·
  // ürün-aç akışı · kullanılan ürünler) tek kadife görünümde alt-sekmeli.
  const [barSekme, setBarSekme] = useState('acilis');
  const [barTarih, setBarTarih] = useState(() => bugunYerelISO());
  const [acilisTakip, setAcilisTakip] = useState(null);
  const [kapanisTakip, setKapanisTakip] = useState(null);
  const [urunAcAkis, setUrunAcAkis] = useState(null);
  const [barOzet, setBarOzet] = useState(null);
  const [barHata, setBarHata] = useState('');
  // ── MERKEZ DENETİM (ops-merkez P1 sekmeleri, 2026-07-30) ──────────────────
  // urun-uyumsuzluk · fire-bildirim · gider fişi · kontrol özeti · stok kaybı
  const [dnSekme, setDnSekme] = useState('uyumsuz');
  const [dnUyumsuz, setDnUyumsuz] = useState(null);
  const [dnFire, setDnFire] = useState(null);
  const [dnFis, setDnFis] = useState(null);
  const [dnKontrol, setDnKontrol] = useState(null);
  const [dnKayip, setDnKayip] = useState(null);
  const [dnHata, setDnHata] = useState('');
  // ── TEDARİK & SİNYAL (ops-merkez P3 sekmeleri, 2026-07-30) ────────────────
  // toptancıdan gelenler · şube notları · stok tahmini · KPI delta
  const [tsSekme, setTsSekme] = useState('teslim');
  const [tsTeslim, setTsTeslim] = useState(null);
  const [tsNotlar, setTsNotlar] = useState(null);
  const [tsTahmin, setTsTahmin] = useState(null);
  const [tsKpi, setTsKpi] = useState(null);
  const [tsHata, setTsHata] = useState('');
  // ── SAYIM ─────────────────────────────────────────────────────────────────
  const [sayim, setSayim] = useState(null);
  const [sayimIz, setSayimIz] = useState(null);
  const [sayimHata, setSayimHata] = useState('');
  const [sayimAcikId, setSayimAcikId] = useState('');
  const [sayimDetay, setSayimDetay] = useState({});   // gorev_id → detay (kalem farkları)
  // ── HAREKET ───────────────────────────────────────────────────────────────
  const [hareket, setHareket] = useState(null);
  const [hareketHata, setHareketHata] = useState('');

  const [hiz, setHiz] = useState(null);   // sevkiyat hızı duyusu (salt-okur)
  const kuleYukle = useCallback(() => {
    setKuleHata('');
    api('/ops/siparis/kontrol-kulesi?gun=14&sadece_acik=false&limit=200')
      .then((d) => setKule(d || {}))
      .catch((e) => setKuleHata(e?.message || ''));
    api('/ops/siparis/sevkiyat-subeler-ozet?gun=30')
      .then((d) => setSubeOzet(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setSubeOzet([]));
    api('/ops/siparis/sevkiyat-hiz?gun=30')
      .then((d) => setHiz(d || {}))
      .catch(() => setHiz({}));
  }, []);

  /** Kart seçimini aç/kapat. Sunucu kuralı: hepsi AYNI şubeden olmalı. */
  const birlTogglaBirlestir = (talepId, subeId) => {
    setBirlSecili((p) => {
      const n = { ...p };
      if (n[talepId]) delete n[talepId];
      else n[talepId] = String(subeId || '');
      return n;
    });
  };
  const birlTemizle = () => { setBirlSecili({}); setBirlNot(''); };

  /**
   * 2+ bekleyen siparişi TEK siparişe indirir. Sunucu kuralları
   * (operasyon_merkez_api:17905): aynı şube · hepsi 'bekliyor' · hiçbiri depoya
   * yönlendirilmemiş · aynı ürün adetleri TOPLANIR · eskiler 'iptal' olur.
   */
  const birlestirGonder = async () => {
    const idler = Object.keys(birlSecili);
    if (idler.length < 2) { onToast?.('En az 2 sipariş seçin'); return; }
    setBirlMesgul(true);
    try {
      const r = await api('/ops/siparis/birlestir', {
        method: 'POST',
        body: { talep_idler: idler, not_aciklama: (birlNot || '').trim() || null },
      });
      onToast?.(`${sayi(r?.birlesik_talep_sayisi) || idler.length} sipariş tek siparişe indi — ${sayi(r?.kalem_sayisi)} kalem · yeni #${String(r?.yeni_talep_id || '').slice(-8)}`);
      birlTemizle();
      kuleYukle();
    } catch (e) {
      onToast?.(e?.message || 'Birleştirme başarısız');
    } finally {
      setBirlMesgul(false);
    }
  };

  const barYukle = useCallback((tarih) => {
    setBarHata('');
    const t = tarih || bugunYerelISO();
    api(`/ops/acilis-kasa-takip?tarih=${t}`)
      .then((d) => setAcilisTakip(d || {}))
      .catch((e) => setBarHata(e?.message || ''));
    api(`/ops/kapanis-takip?tarih=${t}`)
      .then((d) => setKapanisTakip(d || {}))
      .catch(() => setKapanisTakip({}));
    api(`/ops/v2/urun-ac-akis?tarih=${t}`)
      .then((d) => setUrunAcAkis(d || {}))
      .catch(() => setUrunAcAkis({}));
    // ⚠️ Bar özeti GÜN ODAKLI çekilir. İki sebep (ikisi de sunucu sözleşmesi):
    // 1) `gun` verilmezse uç evo_* alanlarını HİÇ doldurmaz (operasyon_merkez_api
    //    :4127 — Evo karşılaştırması yalnız tek-gün sorgusunda yapılır).
    // 2) `year_month` verilmezse sunucu İÇİNDE BULUNULAN ayı varsayar
    //    (_coerce_year_month:758). Geçmiş bir güne bakınca ay filtresi ile gün
    //    filtresi çelişip boş dönüyordu → ekran sessizce "kayıt yok" diyordu.
    // O güne ait kayıt yoksa aylık listeye düşülür (eski davranış korunur).
    api(`/ops/bar-ozet?gun=${t}&year_month=${t.slice(0, 7)}&limit=60`)
      .then((d) => {
        const s = Array.isArray(d?.satirlar) ? d.satirlar : [];
        if (s.length) { setBarOzet({ ...d, satirlar: s, gunluk: true }); return null; }
        return api('/ops/bar-ozet?limit=60').then((d2) => setBarOzet({
          ...(d2 || {}),
          satirlar: Array.isArray(d2?.satirlar) ? d2.satirlar : [],
          gunluk: false,
        }));
      })
      .catch(() => setBarOzet({ satirlar: [], gunluk: false }));
  }, []);

  const denetimYukle = useCallback((tarih) => {
    setDnHata('');
    const t = tarih || bugunYerelISO();
    api(`/ops/urun-uyumsuzluk?tarih=${t}`)
      .then((d) => setDnUyumsuz(d || {}))
      .catch((e) => setDnHata(e?.message || ''));
    api(`/ops/fire-bildirimler?tarih=${t}`)
      .then((d) => setDnFire(d || {}))
      .catch(() => setDnFire({}));
    api('/ops/gider-fis-bekleyen?gun=7')
      .then((d) => setDnFis(d || {}))
      .catch(() => setDnFis({}));
    api('/ops/kontrol-ozet')
      .then((d) => setDnKontrol(d || {}))
      .catch(() => setDnKontrol({}));
    api('/ops/stok-kayip-analiz?gun=45')
      .then((d) => setDnKayip(d || {}))
      .catch(() => setDnKayip({}));
  }, []);

  const tedarikYukle = useCallback(() => {
    setTsHata('');
    api('/ops/toptanci-teslimler?gun=14')
      .then((d) => setTsTeslim(d || {}))
      .catch((e) => setTsHata(e?.message || ''));
    api('/ops/sube-notlar?limit=60')
      .then((d) => setTsNotlar(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setTsNotlar([]));
    api('/ops/stok-tahmin')
      .then((d) => setTsTahmin(d || {}))
      .catch(() => setTsTahmin({}));
    api('/ops/kpi-delta?donem=ay')
      .then((d) => setTsKpi(d || {}))
      .catch(() => setTsKpi({}));
  }, []);

  const yonAc = (sip) => {
    const kalemler = Array.isArray(sip?.kalemler) ? sip.kalemler : [];
    setYonForm({
      sip, mod: 'depo', depo: '', talimat: '',
      tedarikciId: '', not: '',
      // varsayılan: tüm kalemler seçili (kısmi gönderim için tek tek kaldırılır)
      secili: kalemler.map((_, i) => i),
    });
    if (!depolar.length) {
      api('/ops/subeler/depolar')
        .then((r) => setDepolar(Array.isArray(r?.satirlar) ? r.satirlar : []))
        .catch(() => setDepolar([]));
    }
    if (!tedarikciler.length) {
      api('/tedarikciler?aktif=true')
        .then((r) => setTedarikciler(Array.isArray(r) ? r : (r?.tedarikciler || [])))
        .catch(() => setTedarikciler([]));
    }
  };

  /** Seçili kalemleri toptancıya yolla — klasik kule ile AYNI uç. */
  const toptanciyaYolla = async () => {
    const f = yonForm;
    const ted = (tedarikciler || []).find((t) => String(t.id) === String(f?.tedarikciId));
    if (!ted) { onToast?.('Kayıtlı tedarikçi seçin'); return; }
    const hamKalemler = Array.isArray(f.sip?.kalemler) ? f.sip.kalemler : [];
    const kalemler = hamKalemler.filter((_, i) => f.secili.includes(i));
    if (!kalemler.length) { onToast?.('En az bir kalem seçin'); return; }
    setYonMesgul(true);
    try {
      const r = await api('/ops/siparis/toptanciya-yolla', {
        method: 'POST',
        body: {
          talep_id: f.sip.id,
          tedarikci_id: ted.id,
          tedarikci_ad: ted.ad,
          not_aciklama: (f.not || '').trim() || null,
          kalemler,
        },
      });
      const tel = String(ted.telefon || '').replace(/\D/g, '');
      const waNot = r?.wa_basarili ? ' · WhatsApp gönderildi' : (tel ? '' : ' · telefon yok, WhatsApp gitmedi');
      const kalan = sayi(r?.kalan_adet);
      onToast?.(`🚚 ${ted.ad} — ${sayi(r?.toplam_adet)} adet yollandı${waNot}${
        r?.tam_gonderildi === false ? ` · ${kalan} adet kuyrukta kaldı` : ''}`);
      setYonForm(null);
      kuleYukle();
    } catch (e) {
      onToast?.(e?.message || 'Toptancıya gönderim hatası');
    } finally {
      setYonMesgul(false);
    }
  };

  /** Seçili kalemleri temiz bir pencerede yazdır (klasik kule deseni). */
  const toptanciYazdir = () => {
    const f = yonForm;
    const ted = (tedarikciler || []).find((t) => String(t.id) === String(f?.tedarikciId));
    const hamKalemler = Array.isArray(f.sip?.kalemler) ? f.sip.kalemler : [];
    const kalemler = hamKalemler.filter((_, i) => f.secili.includes(i));
    if (!kalemler.length) { onToast?.('Yazdırmak için en az bir kalem seçin'); return; }
    const satirlar = kalemler.map((k, i) =>
      `<tr><td style="padding:12px 14px;font-size:18px;border-bottom:1px solid #e0e0e0">${i + 1}. ${k.urun_ad || k.kalem_adi || '—'}</td>`
      + `<td style="padding:12px 16px;font-size:22px;font-weight:900;text-align:right;border-bottom:1px solid #e0e0e0">× ${sayi(k.adet)}</td></tr>`).join('');
    const toplam = kalemler.reduce((t, k) => t + sayi(k.adet), 0);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${ted?.ad || 'Toptanci'} — ${f.sip.sube_adi || ''}</title>`
      + `<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#fff;font-family:Arial,sans-serif}@media print{@page{margin:12mm}}</style>`
      + `</head><body><div style="padding:40px 44px;max-width:640px">`
      + `<div style="border-bottom:3px solid #111;padding-bottom:16px;margin-bottom:24px">`
      + `<div style="font-size:11px;color:#888;letter-spacing:.1em;margin-bottom:8px">TOPTANCI SİPARİŞ LİSTESİ</div>`
      + `<div style="font-size:26px;font-weight:900">${f.sip.sube_adi || '—'}</div>`
      + `<div style="font-size:20px;font-weight:800;margin-top:8px">▸ ${ted?.ad || '—'}</div>`
      + `<div style="font-size:13px;color:#666;margin-top:10px">📅 ${String(f.sip.tarih || '').slice(0, 10)}</div></div>`
      + `<table style="width:100%;border-collapse:collapse">${satirlar}</table>`
      + ((f.not || '').trim() ? `<div style="margin-top:24px;padding:12px 14px;background:#f5f5f5;border-radius:8px;font-size:13px;color:#555">Not: ${f.not}</div>` : '')
      + `<div style="margin-top:28px;border-top:1px solid #ccc;padding-top:12px;font-size:12px;color:#aaa">`
      + `${kalemler.length} kalem · ${toplam} toplam adet</div></div>`
      + `<script>window.onload=function(){window.print()}<\/script></body></html>`;
    const w = window.open('', '_blank', 'width=700,height=920');
    if (!w) { onToast?.('Yazdırma penceresi engellendi — tarayıcı izinlerini kontrol edin'); return; }
    w.document.write(html);
    w.document.close();
  };

  const yonKaydet = async () => {
    if (!yonForm?.depo) { onToast?.('Önce hedef depo seçin'); return; }
    setYonMesgul(true);
    try {
      const body = { talep_id: yonForm.sip.id, hedef_depo_sube_id: yonForm.depo };
      const tal = (yonForm.talimat || '').trim();
      if (tal) body.operasyon_yonlendirme_talimati = tal;
      await api('/ops/siparis/sevkiyata-gonder', { method: 'POST', body });
      onToast?.('🏭 Depoya yönlendirildi — merkez kuyruğundan çıktı');
      setYonForm(null);
      kuleYukle();
    } catch (e) {
      onToast?.(e?.message || 'Yönlendirme başarısız');
    } finally {
      setYonMesgul(false);
    }
  };

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

  // ── MERKEZ MÜDAHALE (Faz 4, 2026-07-31) ──────────────────────────────────
  // Merkezin ŞUBEYE dokunduğu üç işlem tek masada: güvenlik alarmı · zorunlu
  // mesaj · kapanış mührünü açma. Üçü de klasikte ayrı sekmelerdeydi.
  const [mdSekme, setMdSekme] = useState('alarm');
  const [mdAlarm, setMdAlarm] = useState(null);
  const [mdMesaj, setMdMesaj] = useState(null);
  const [mdSubeler, setMdSubeler] = useState([]);
  const [mdHata, setMdHata] = useState('');
  const [mdMesgul, setMdMesgul] = useState(false);
  const [mdModal, setMdModal] = useState(null);   // {tip, alarm|mesaj|sube, ...}
  // Yeni mesaj formu
  const [ymSube, setYmSube] = useState('');
  const [ymMetin, setYmMetin] = useState('');
  const [ymOncelik, setYmOncelik] = useState('normal');
  const [ymTtl, setYmTtl] = useState(72);
  // Kapanış geri alma formu — İŞLETME PIN'i zorunlu (sunucu doğrular)
  const [kgSube, setKgSube] = useState('');
  const [kgTarih, setKgTarih] = useState(bugunYerelISO());
  const [kgSebep, setKgSebep] = useState('');
  const [kgPin, setKgPin] = useState('');

  const mdYukle = useCallback(() => {
    setMdHata('');
    api('/ops/guvenlik-alarmlar')
      .then((d) => setMdAlarm(d || {}))
      .catch((e) => setMdHata(e?.message || 'Güvenlik alarmları alınamadı'));
    api('/ops/merkez-mesajlar?limit=100')
      .then((d) => setMdMesaj(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch((e) => setMdHata((p) => p || e?.message || 'Mesajlar alınamadı'));
    api('/ops/subeler/depolar')
      .then((d) => setMdSubeler(Array.isArray(d?.subeler) ? d.subeler : []))
      .catch(() => setMdSubeler([]));
  }, []);

  const mdUygula = async () => {
    const m = mdModal;
    if (!m) return;
    setMdMesgul(true);
    try {
      if (m.tip === 'okundu') {
        await api(`/ops/guvenlik-alarmlar/${m.alarm.sube_id}/okundu`, {
          method: 'POST', body: { notu: (m.notu || '').trim() || null },
        });
        onToast?.(`✓ ${m.alarm.sube_adi} alarmı okundu işaretlendi`);
      } else if (m.tip === 'sustur') {
        const dk = Math.max(5, Math.min(1440, Number(m.dk) || 120));
        await api(`/ops/guvenlik-alarmlar/${m.alarm.sube_id}/sustur`, {
          method: 'POST', body: { notu: (m.notu || '').trim() || null, sustur_dk: dk },
        });
        onToast?.(`✓ ${m.alarm.sube_adi} alarmı ${dk} dk susturuldu`);
      } else if (m.tip === 'mesaj-sil') {
        await api(`/ops/merkez-mesaj/${m.mesaj.id}`, { method: 'DELETE' });
        onToast?.('✓ Mesaj pasife alındı — şube artık göremeyecek');
      }
      setMdModal(null);
      mdYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setMdMesgul(false); }
  };

  const mesajGonder = async () => {
    const metin = ymMetin.trim();
    if (!ymSube) { onToast?.('Şube seçin'); return; }
    if (metin.length < 3) { onToast?.('Mesaj en az 3 karakter olmalı'); return; }
    if (metin.length > 2000) { onToast?.('Mesaj 2000 karakteri aşamaz'); return; }
    setMdMesgul(true);
    try {
      await api('/ops/merkez-mesaj-gonder', {
        method: 'POST',
        body: { sube_id: ymSube, mesaj: metin, oncelik: ymOncelik, ttl_saat: Math.max(1, Math.min(8760, Number(ymTtl) || 72)) },
      });
      onToast?.('✓ Mesaj gönderildi — şube okumadan kapanış yapamaz');
      setYmMetin(''); setYmOncelik('normal');
      mdYukle();
    } catch (e) {
      onToast?.(e?.message || 'Mesaj gönderilemedi');
    } finally { setMdMesgul(false); }
  };

  /** Kapanış mührünü aç. Sunucu İŞLETME PIN'ini doğrular (hatalı → 403). */
  const kapanisGeriAl = async () => {
    if (!kgSube) { onToast?.('Şube seçin'); return; }
    if (!/^\d{4}$/.test(kgPin.trim())) { onToast?.('İşletme onay PIN kodu 4 haneli olmalı'); return; }
    setMdMesgul(true);
    try {
      // ⚠️ Router prefix /api/sube-panel; api() zaten /api ekliyor.
      // Önceki hâli /api/sube/... idi → /api/api/sube/... olup 404 veriyordu.
      const r = await api(`/sube-panel/${kgSube}/kapanis-geri-al`, {
        method: 'POST',
        body: { onay_pin: kgPin.trim(), tarih: kgTarih, sebep: kgSebep.trim() || null },
      });
      onToast?.(`✓ Mühür açıldı${r?.kapanis_iptal != null ? ` — ${sayi(r.kapanis_iptal)} kapanış kaydı iptal` : ''}`);
      setKgPin(''); setKgSebep('');
      setMdModal(null);
    } catch (e) {
      onToast?.(e?.message || 'Geri alma başarısız — PIN veya tarih hatalı olabilir');
    } finally { setMdMesgul(false); }
  };

  // ── GİDER FİŞİ KARARI (Faz 4) ────────────────────────────────────────────
  // Klasikte liste vardı ama v2 sadece GÖSTERİYORDU. "gelmedi" kararı sunucuda
  // personel risk sinyali doğurur (depoda hareket varsa ağırlık 10, yoksa 4).
  const [fisModal, setFisModal] = useState(null);   // {gider, durum, notu}
  const [fisMesgul, setFisMesgul] = useState(false);

  const fisKarar = async () => {
    const m = fisModal;
    if (!m) return;
    setFisMesgul(true);
    try {
      await api('/ops/gider-fis-kontrol', {
        method: 'POST',
        body: { gider_id: m.gider.id, durum: m.durum, notu: (m.notu || '').trim() || null },
      });
      onToast?.(m.durum === 'geldi' ? '✓ Fiş geldi olarak işaretlendi'
        : m.durum === 'muaf' ? '✓ Fişten muaf sayıldı'
        : '✓ Fiş gelmedi — personel risk sinyali oluşturuldu');
      setFisModal(null);
      denetimYukle(barTarih);
    } catch (e) {
      onToast?.(e?.message || 'Karar kaydedilemedi');
    } finally { setFisMesgul(false); }
  };


  // Katalog modalı — tek modal, tipe göre alan gösterir
  const ktModalBlok = ktModal && (() => {
    const m = ktModal;
    const T = {
      kategori: { b: 'Yeni kategori', a: 'Şubelerin sipariş ekranında görünecek başlık.', ad: 'Kategori adı', ek: 'Emoji', btn: 'Kategoriyi oluştur' },
      urun:     { b: 'Yeni ürün', a: 'Bu kategoriye ürün ekler. Aynı ad daha önce pasife alınmışsa yeniden aktif olur.', ad: 'Ürün adı', ek: 'Açıklama (isteğe bağlı)', btn: 'Ürünü ekle' },
      ad:       { b: 'Ürün adını değiştir', a: 'Ad değişir; geçmiş siparişler etkilenmez.', ad: 'Yeni ad', ek: null, btn: 'Adı kaydet' },
      fiyat:    { b: 'Birim fiyat', a: 'Maliyet hesabı bu fiyatı kullanır. Boş bırakırsan ürün fiyatsız kalır.', ad: null, ek: 'Birim fiyat (₺)', btn: 'Fiyatı kaydet' },
      pasif:    { b: 'Ürünü pasife al', a: 'Şubeler bu ürünü artık sipariş edemez ve ürün bu listeden kaybolur. Geçmiş siparişler korunur.', ad: null, ek: null, btn: 'Evet, pasife al', tehlike: true },
    }[m.tip];
    const kapat = () => { if (!ktMesgul) setKtModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 430, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{T.b}</div>
            <button onClick={kapat} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>x</button>
          </div>
          {(m.kategori || m.urun) && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              {m.urun ? <b>{m.urun.ad}</b> : null}
              {m.urun && m.kategori ? ' · ' : ''}
              {m.kategori ? `${m.kategori.emoji || ''} ${m.kategori.ad}` : ''}
            </div>
          )}
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 16 }}>{T.a}</div>

          {T.ad && (
            <>
              <label style={opsEtiket}>{T.ad}</label>
              <input value={m.ad} autoFocus
                onChange={(e) => setKtModal((p) => ({ ...p, ad: e.target.value }))}
                style={opsAlanStil} />
            </>
          )}
          {T.ek && (
            <>
              <label style={opsEtiket}>{T.ek}</label>
              <input value={m.deger} inputMode={m.tip === 'fiyat' ? 'decimal' : undefined}
                onChange={(e) => setKtModal((p) => ({ ...p, deger: e.target.value }))}
                style={opsAlanStil} />
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={ktMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={ktMesgul} onClick={ktUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>{ktMesgul ? 'İşleniyor…' : T.btn}</button>
          </div>
        </div>
      </div>
    );
  })();

  useEffect(() => {
    if (gorunum === 'akis' || gorunum === 'kule') kuleYukle();
    if (gorunum === 'sevkiyat') sevkYukle();
    if (gorunum === 'depo') depoYukle();
    if (gorunum === 'sayim') sayimYukle();
    if (gorunum === 'hareket') hareketYukle();
    if (gorunum === 'bar') barYukle(barTarih);
    if (gorunum === 'denetim') denetimYukle(barTarih);
    if (gorunum === 'tedarik') tedarikYukle();
    if (gorunum === 'uzlastir') uzYukle();
    if (gorunum === 'katalog') ktYukle();
    if (gorunum === 'denetim') mdYukle();   // Merkez Denetim'in müdahale sekmeleri
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum, kuleYukle, sevkYukle, depoYukle, sayimYukle, hareketYukle, barYukle, denetimYukle, tedarikYukle, uzYukle, ktYukle, mdYukle]);

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
      const r = await api('/ops/siparis/sevkiyat-guncelle', {
        method: 'POST',
        body: {
          talep_id: seciliTalep.id,
          hedef_depo_sube_id: seciliTalep.hedef_depo_sube_id || seciliTalep.sevkiyat_sube_id,
          kalem_durumlari: payload,
          sevkiyat_notu: (notu || '').trim() || null,
          gonderildi: !!gonderildi,
        },
      });
      // Uyumsuzluk = sinyal, kapı değil: sevk engellemez ama uyarı gösterilir
      const uy = Number(r?.uyumsuzluk_uyarisi) || 0;
      onToast?.(gonderildi
        ? (uy > 0
          ? `🚚 Yola çıkarıldı — ⚠ bu depoda ${uy} çözülmemiş kabul uyumsuzluğu bekliyor`
          : '🚚 Yola çıkarıldı — talep şubesinde «Depodan Gelen» açıldı')
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
  // ── SİPARİŞ YAŞAM DÖNGÜSÜ (geri yön, 2026-07-31) ──────────────────────────
  // İptal/geri-al/yeniden-aç GERİ ALINAMAZ ya da akışı değiştirir → hepsi
  // ONAY MODALINDAN geçer; klasikteki window.confirm'in kadife karşılığı.
  const [ysModal, setYsModal] = useState(null);   // {tip, talep, aciklama}
  const [ysMesgul, setYsMesgul] = useState(false);

  const ysUygula = async () => {
    const m = ysModal;
    if (!m) return;
    const tid = String(m.talep?.id || m.talep?.talep_id || '').trim();
    if (!tid) { onToast?.('Talep kimliği okunamadı'); return; }
    setYsMesgul(true);
    try {
      if (m.tip === 'iptal') {
        await api('/ops/siparis/merkez-iptal', {
          method: 'POST',
          body: { talep_id: tid, aciklama: (m.aciklama || '').trim() || undefined },
        });
        onToast?.('🚫 Sipariş merkezden iptal edildi');
      } else if (m.tip === 'akis-iptal') {
        // GEÇ aşama iptali: merkez-iptal bu aşamaları REDDEDER (backend kuralı).
        // Sevk edilmiş adetler kaynak depoya iade edilir.
        await api('/ops/siparis/akisi-iptal', {
          method: 'POST',
          body: { talep_id: tid, aciklama: (m.aciklama || '').trim() || undefined },
        });
        onToast?.('🚫 Akış iptal edildi — sevk edilen adetler depoya iade edildi');
      } else if (m.tip === 'geri-al') {
        await api(`/ops/siparis/${encodeURIComponent(tid)}/toptanci-geri-al`, { method: 'POST' });
        onToast?.('↩ Sipariş kuyruğa geri alındı');
      } else if (m.tip === 'yeniden-ac') {
        await api(`/ops/siparis/gecmis/${encodeURIComponent(tid)}/yeniden-ac`, { method: 'POST' });
        onToast?.('🔄 Sipariş tekrar kuyruğa alındı');
      } else if (m.tip.startsWith('ozel:')) {
        const islem = m.tip.split(':')[1];
        await api('/ops/siparis/ozel-islem', {
          method: 'POST',
          body: { talep_id: tid, islem, not_aciklama: (m.aciklama || '').trim() || null },
        });
        onToast?.(islem === 'katalog' ? '✓ Özel talep kataloğa alındı'
          : islem === 'tek_sefer' ? '✓ Tek seferlik siparişe çevrildi'
          : '✓ Özel talep reddedildi');
      }
      setYsModal(null);
      kuleYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setYsMesgul(false); }
  };

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
      // AŞAMAYA GÖRE KAPI: ileri yön + GERİ yön (yaşam döngüsü)
      aksiyonlar: (() => {
        const A = [];
        const bitti = ['tamamlandi', 'iptal'].includes(s.asama);
        if (s.asama === 'bekliyor') {
          A.push({ ad: '→ Yönlendir (depo / toptancı)', birincil: true, onTikla: () => yonAc(s) });
        } else if (s.asama === 'depoda') {
          A.push({ ad: 'Sevkiyatı hazırla', birincil: true, onTikla: () => onGorunum?.('sevkiyat') });
        }
        if (s.asama === 'toptanci_bekliyor') {
          A.push({ ad: '↩ Toptancıdan geri al', onTikla: () => setYsModal({ tip: 'geri-al', talep: s, aciklama: '' }) });
        }
        if (bitti) {
          A.push({ ad: '🔄 Yeniden aç', birincil: true, onTikla: () => setYsModal({ tip: 'yeniden-ac', talep: s, aciklama: '' }) });
        } else {
          // Aşamaya göre DOĞRU uç: merkez-iptal yalnız bekliyor/onaylandi'yı kabul
          // eder; depo hazırlık ve yolda için akisi-iptal gerekiyor (backend kuralı).
          const gecAsama = /depo|hazirlik|hazırlık|yolda|sevk/i.test(String(s.asama || ''));
          A.push(gecAsama
            ? { ad: '🚫 Akışı iptal et', onTikla: () => setYsModal({ tip: 'akis-iptal', talep: s, aciklama: '' }) }
            : { ad: '🚫 Merkezden iptal et', onTikla: () => setYsModal({ tip: 'iptal', talep: s, aciklama: '' }) });
        }
        // Özel talep (katalogda olmayan istek) → 3 yollu karar
        if (s.ozel_talep || s.ozel || s.katalog_disi) {
          A.push({ ad: '📗 Kataloğa al', onTikla: () => setYsModal({ tip: 'ozel:katalog', talep: s, aciklama: '' }) });
          A.push({ ad: '1️⃣ Tek seferlik', onTikla: () => setYsModal({ tip: 'ozel:tek_sefer', talep: s, aciklama: '' }) });
          A.push({ ad: '✗ Özel talebi reddet', onTikla: () => setYsModal({ tip: 'ozel:red', talep: s, aciklama: '' }) });
        }
        return A;
      })(),
    });
  };

  // Çekmece aksiyonu TasarimV2'de koprule(_hedef) çağırır; görünüm-içi hedefler
  // için köprüyü burada yakalayamayız → kart üstündeki butonlar görünüm değiştirir,
  // çekmece aksiyonu eski sayfaya köprüler. (__gorunum: önekini TasarimV2 çözer.)

  /** TEK SEFERLİK toplu migration — geçmiş sipariş kayıtlarını da değiştirir. */
  const ktSyncYap = async () => {
    if (ktSyncOnay.trim() !== 'EVET_ESITLE') { onToast?.('Onay kutusuna tam olarak «EVET_ESITLE» yazın'); return; }
    setKtMesgul(true);
    try {
      const r = await api('/ops/siparis/sync-urun-adlari', { method: 'POST' });
      onToast?.(`✓ Adlar eşitlendi${r?.guncellenen != null ? ` — ${sayi(r.guncellenen)} kayıt` : ''}`);
      setKtSyncOnay('');
      ktYukle();
    } catch (e) {
      onToast?.(e?.message || 'Eşitleme başarısız');
    } finally { setKtMesgul(false); }
  };

  // ── YAŞAM DÖNGÜSÜ ONAY MODALI ─────────────────────────────────────────────
  // Klasikte window.confirm + prompt vardı. Kadifede: ne olacağını AÇIKÇA yazan
  // onay kutusu. Geri alınamaz işlemde düğme kırmızı.
  const ysModalBlok = ysModal && (() => {
    const t = ysModal.tip;
    const TANIM = {
      'iptal': {
        baslik: 'Siparişi merkezden iptal et',
        anlat: 'Talep iptal edilir ve kuyruktan düşer. Şube bu siparişi göremez; gerekirse yeniden açılabilir.',
        buton: 'Evet, iptal et', tehlike: true, notAlani: 'İptal nedeni (isteğe bağlı)',
      },
      'akis-iptal': {
        baslik: 'Akıştaki siparişi iptal et',
        anlat: 'Sipariş depoda hazırlanıyor ya da yolda. İptal edilince yolda stok satırları kaldırılır ve SEVK EDİLMİŞ ADETLER kaynak depoya iade edilir — depo stoğu geri artar. Fiziksel olarak yola çıkmış mal varsa onu da geri getirmeniz gerekir.',
        buton: 'Evet, akışı iptal et', tehlike: true, notAlani: 'İptal nedeni (isteğe bağlı)',
      },
      'geri-al': {
        baslik: 'Toptancıdan geri al',
        anlat: 'Toptancıya yollanan sipariş KUYRUĞA döner; yönlendirme baştan yapılır. Toptancıya gitmiş bilgi geri alınmaz — kendisine haber vermeniz gerekebilir.',
        buton: 'Evet, geri al', tehlike: false, notAlani: null,
      },
      'yeniden-ac': {
        baslik: 'Siparişi yeniden aç',
        anlat: 'Kapanmış sipariş tekrar kuyruğa alınır ve akışın başına döner.',
        buton: 'Evet, yeniden aç', tehlike: false, notAlani: null,
      },
      'ozel:katalog': {
        baslik: 'Özel talebi kataloğa al',
        anlat: 'Bu ürün kalıcı katalog kalemi olur; bundan sonra şubeler doğrudan sipariş edebilir.',
        buton: 'Kataloğa al', tehlike: false, notAlani: 'Not (isteğe bağlı)',
      },
      'ozel:tek_sefer': {
        baslik: 'Tek seferlik siparişe çevir',
        anlat: 'Talep bu sefere mahsus karşılanır; kataloğa girmez, tekrar istenirse yeniden karar verilir.',
        buton: 'Tek seferlik yap', tehlike: false, notAlani: 'Not (isteğe bağlı)',
      },
      'ozel:red': {
        baslik: 'Özel talebi reddet',
        anlat: 'Talep karşılanmaz. Şube gerekçeyi görebilsin diye not bırakmanız önerilir.',
        buton: 'Reddet', tehlike: true, notAlani: 'Red gerekçesi',
      },
    }[t] || {};
    const kapat = () => { if (!ysMesgul) setYsModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 440, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{TANIM.baslik}</div>
            <button onClick={kapat} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>x</button>
          </div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{ysModal.talep?.sube_adi || 'Şube'}</b> · {tarihKisa(ysModal.talep?.tarih)}
            {ysModal.talep?.kalem_sayisi ? ` · ${sayi(ysModal.talep.kalem_sayisi)} adet` : ''}
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 16 }}>
            {TANIM.anlat}
          </div>
          {TANIM.notAlani && (
            <>
              <label style={opsEtiket}>{TANIM.notAlani}</label>
              <input value={ysModal.aciklama} autoFocus
                onChange={(e) => setYsModal((p) => ({ ...p, aciklama: e.target.value }))}
                style={opsAlanStil} />
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={ysMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={ysMesgul} onClick={ysUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
              border: TANIM.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: TANIM.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: TANIM.tehlike ? R.kirmizi : '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>{ysMesgul ? 'İşleniyor…' : TANIM.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  // ════════════════════════ GÖRÜNÜM: SİPARİŞ AKIŞI ══════════════════════════
  // ── SEVKİYAT HIZI DUYUSU (2026-07-29) ─────────────────────────────────────
  // Mevcut zaman damgalarından türeyen salt-okur ölçüm: 'talepten teslime kaç
  // saat, hangi depo yavaş?'. Kontrol Kulesi Şube Karnesi'yle BİRLEŞİNCE
  // (2026-07-30) bu şerit Sipariş Akışı'na taşındı — duyu kaybolmadı.
  const hizSeridi = (hiz && sayi(hiz.teslim_adet) > 0) ? (
        <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>⏱ Sevkiyat hızı · son {sayi(hiz.kesit_gun)} gün</span>
            <span style={{ fontSize: 10.5, color: R.not2 }}>zaman damgalarından türetilir · damgasız kayıt hesaba girmez</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span>Talep→teslim ort <b style={{ fontFamily: F.mono, color: R.bakir }}>{hiz.ort_saat ?? '—'} sa</b></span>
            <span>medyan <b style={{ fontFamily: F.mono }}>{hiz.medyan_saat ?? '—'} sa</b></span>
            <span>depo hazırlık <b style={{ fontFamily: F.mono }}>{hiz.hazirlik_ort_saat ?? '—'} sa</b></span>
            <span>yolda <b style={{ fontFamily: F.mono }}>{hiz.yol_ort_saat ?? '—'} sa</b></span>
            <span style={{ color: R.not2 }}>{sayi(hiz.teslim_adet)} ölçülen teslim</span>
          </div>
          {(hiz.depolar || []).length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {(hiz.depolar || []).slice(0, 5).map((dp, i) => (
                <span key={i} style={{
                  ...rozetHap(i === 0 && (hiz.depolar || []).length > 1 ? R.amber : R.mavi),
                  fontFamily: F.mono,
                }}>
                  {dp.depo_adi}: {dp.ort_saat} sa · {dp.teslim} teslim
                </span>
              ))}
            </div>
          )}
        </div>
  ) : null;

  if (gorunum === 'akis') {
    if (kuleHata) return <HataBandi mesaj={kuleHata} onTekrar={kuleYukle} />;
    if (!kule) return <Yukleniyor />;
    const ozet = kule.ozet || {};
    const satirlar = Array.isArray(kule.satirlar) ? kule.satirlar : [];
    const acik = ['bekliyor', 'depoda', 'yolda', 'toptanci_bekliyor', 'uyumsuzluk']
      .reduce((t, k) => t + sayi(ozet[k]), 0);
    const uyumsuzlar = satirlar.filter((s) => s.asama === 'uyumsuzluk');
    const kolonlar = [
      { id: 'bekliyor', asamalar: ['bekliyor'], buton: '🏭 Depoya yönlendir', yerliYonlendir: true },
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

        {/* Kontrol Kulesi birleşti (2026-07-30): hız duyusu akışın yanına geldi */}
        {hizSeridi}
        {ysModalBlok}

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
                onClick={() => onGorunum?.('denetim')}
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

        {/* ── SİPARİŞ BİRLEŞTİRME — mevcut kanbanın 'bekliyor' kolonunda ──────
            Aynı şubenin gün içinde attığı birden çok talep tek sevkiyata iner. */}
        {(() => {
          const bekleyenler = satirlar.filter((s) => s.asama === 'bekliyor');
          if (bekleyenler.length < 2) return null;
          const secIdler = Object.keys(birlSecili);
          const secSubeler = [...new Set(Object.values(birlSecili))];
          const secSubeAdi = secIdler.length
            ? (bekleyenler.find((s) => String(s.id) === secIdler[0])?.sube_adi || '—') : '';
          if (secIdler.length === 0) {
            return (
              <div style={{
                padding: '10px 15px', borderRadius: 12, marginBottom: 12,
                fontSize: 11.5, color: R.not2, lineHeight: 1.6,
                background: R.girinti, border: `1px solid ${R.cizgi3}`,
              }}>
                🔗 Aynı şubeden <b>2 veya daha fazla</b> bekleyen siparişi işaretleyip
                tek siparişe birleştirebilirsin — aynı ürünlerin adetleri toplanır,
                depoya tek liste gider.
              </div>
            );
          }
          const yeterli = secIdler.length >= 2 && secSubeler.length === 1;
          return (
            <div style={{
              ...kartYuzey, padding: '13px 16px', marginBottom: 12,
              border: `1px solid ${yeterli ? `${R.bakir}55` : `${R.amber}55`}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={rozetHap(yeterli ? R.bakir : R.amber)}>
                  {secIdler.length} sipariş seçili
                </span>
                <span style={{ fontSize: 12, color: R.metin2, flex: 1, minWidth: 200 }}>
                  {secSubeler.length > 1
                    ? '⚠️ Farklı şubelerden seçim yapılmış — birleştirme yalnız AYNI şube içinde olur.'
                    : secIdler.length < 2
                      ? `${secSubeAdi} · en az 2 sipariş gerekir`
                      : `${secSubeAdi} · seçilenler tek siparişe inecek, eskiler iptal olacak`}
                </span>
                <button onClick={birlTemizle} disabled={birlMesgul} style={{
                  padding: '7px 13px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Seçimi temizle</button>
                <button onClick={birlestirGonder} disabled={!yeterli || birlMesgul} style={{
                  padding: '7px 15px', borderRadius: 9, border: 'none',
                  cursor: yeterli && !birlMesgul ? 'pointer' : 'not-allowed',
                  background: yeterli ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : R.girinti,
                  color: yeterli ? '#1C1309' : R.not3,
                  fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{birlMesgul ? 'Birleştiriliyor…' : '🔗 Birleştir'}</button>
              </div>
              <input value={birlNot} disabled={birlMesgul} placeholder="Merkez notu (opsiyonel) — orn. Aynı gün üç ayrı talep geldi, tek sevke indirildi."
                onChange={(e) => setBirlNot(e.target.value)} style={{ ...opsAlanStil, marginBottom: 0 }} />
            </div>
          );
        })()}

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
                        {/* Birleştirme seçimi — yalnız merkez kuyruğunda ve
                            yönlendirilmemiş kartta; sunucu ikisini de reddeder. */}
                        {kol.id === 'bekliyor' && satirlar.filter((x) => x.asama === 'bekliyor').length >= 2 && (() => {
                          const secili = !!birlSecili[s.id];
                          const yonlendirilmis = !!s.hedef_depo_sube_adi;
                          const secSubeler = [...new Set(Object.values(birlSecili))];
                          const baskaSube = secSubeler.length > 0 && !secili
                            && !secSubeler.includes(String(s.sube_id || ''));
                          const kapali = yonlendirilmis || baskaSube;
                          return (
                            <div
                              title={yonlendirilmis ? 'Depoya yönlendirilmiş — birleştirilemez'
                                : baskaSube ? 'Birleştirme aynı şube içinde olur'
                                : secili ? 'Seçimi kaldır' : 'Birleştirmek için seç'}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (kapali) {
                                  onToast?.(yonlendirilmis
                                    ? 'Bu sipariş depoya yönlendirilmiş — birleştirilemez'
                                    : 'Birleştirme yalnız AYNI şubenin siparişleri arasında olur');
                                  return;
                                }
                                birlTogglaBirlestir(s.id, s.sube_id);
                              }}
                              style={{
                                width: 18, height: 18, borderRadius: 6, flexShrink: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 11, fontWeight: 800, lineHeight: 1,
                                cursor: kapali ? 'not-allowed' : 'pointer',
                                opacity: kapali ? 0.35 : 1,
                                border: `1px solid ${secili ? R.bakir : R.cizgi3}`,
                                background: secili ? R.bakir : 'transparent',
                                color: secili ? '#1C1309' : 'transparent',
                              }}
                            >✓</div>
                          );
                        })()}
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
                            if (kol.yerliYonlendir) yonAc(s);
                            else if (kol.gorunum) onGorunum?.(kol.gorunum);
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

        {/* ── YERLİ DEPO YÖNLENDİRME MODALI (köprü kaldırıldı) ── */}
        {yonForm && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !yonMesgul) setYonForm(null); }}
            style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 500, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Depoya Yönlendir</div>
                <button onClick={() => !yonMesgul && setYonForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                {yonForm.sip.sube_adi || '—'} · {tarihKisa(yonForm.sip.tarih)} · {(yonForm.sip.kalemler || []).length} kalem
              </div>

              {/* Mod anahtarı — klasik kulenin depo/toptancı ikilisi */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {[['depo', '🏭 Depo sevk'], ['toptanci', '🚚 Toptancıya yolla']].map(([m, ad]) => (
                  <div key={m} onClick={() => setYonForm((f) => ({ ...f, mod: m }))} style={{
                    padding: '8px 15px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${yonForm.mod === m ? R.bakir : R.cizgi3}`,
                    color: yonForm.mod === m ? R.bakir : R.metin2,
                    background: yonForm.mod === m ? 'rgba(217,154,78,.14)' : 'transparent',
                  }}>{ad}</div>
                ))}
              </div>

              {yonForm.mod === 'toptanci' ? (
                <>
                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>
                    Toptancı *
                  </label>
                  <select
                    value={yonForm.tedarikciId}
                    onChange={(e) => setYonForm((f) => ({ ...f, tedarikciId: e.target.value }))}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                      border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                      fontSize: 13, fontFamily: 'inherit', outline: 'none',
                    }}
                  >
                    <option value="">Kayıtlı tedarikçi seçin…</option>
                    {tedarikciler.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.ad}{t.telefon ? '' : '  (telefon yok — WhatsApp gitmez)'}
                      </option>
                    ))}
                  </select>

                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, margin: '14px 0 6px', display: 'block' }}>
                    Gönderilecek kalemler ({yonForm.secili.length}/{(yonForm.sip.kalemler || []).length})
                  </label>
                  <div style={{
                    maxHeight: 190, overflowY: 'auto', borderRadius: 11,
                    border: `1px solid ${R.cizgi3}`, background: R.girinti, padding: '8px 10px',
                  }}>
                    {(yonForm.sip.kalemler || []).map((k, i) => {
                      const secili = yonForm.secili.includes(i);
                      return (
                        <div
                          key={i}
                          onClick={() => setYonForm((f) => ({
                            ...f,
                            secili: secili ? f.secili.filter((x) => x !== i) : [...f.secili, i],
                          }))}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px',
                            cursor: 'pointer', fontSize: 12.5,
                            color: secili ? R.krem : R.not, opacity: secili ? 1 : 0.55,
                          }}
                        >
                          <span style={{ color: secili ? R.yesil : R.not2, fontSize: 13 }}>{secili ? '✓' : '□'}</span>
                          <span style={{ flex: 1 }}>{k.urun_ad || k.kalem_adi || '—'}</span>
                          <span style={{ fontFamily: F.mono, fontWeight: 700 }}>× {sayi(k.adet)}</span>
                        </div>
                      );
                    })}
                  </div>

                  <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, margin: '14px 0 6px', display: 'block' }}>
                    Sipariş notu (isteğe bağlı)
                  </label>
                  <textarea
                    rows={2}
                    value={yonForm.not}
                    onChange={(e) => setYonForm((f) => ({ ...f, not: e.target.value }))}
                    placeholder="toptancıya iletilecek not…"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                      border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                      fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical',
                    }}
                  />

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                    <button onClick={toptanciYazdir} style={{
                      padding: '9px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                    }}>
                      🖨 Listeyi yazdır
                    </button>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                      <button disabled={yonMesgul} onClick={() => setYonForm(null)} style={{
                        padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>Vazgeç</button>
                      <button disabled={yonMesgul || !yonForm.tedarikciId || !yonForm.secili.length} onClick={toptanciyaYolla} style={{
                        padding: '10px 20px', borderRadius: 10, border: 'none',
                        background: (yonForm.tedarikciId && yonForm.secili.length) ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : R.girinti,
                        color: (yonForm.tedarikciId && yonForm.secili.length) ? '#1C1309' : R.not,
                        fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                        cursor: (yonForm.tedarikciId && yonForm.secili.length) ? 'pointer' : 'default',
                      }}>
                        {yonMesgul ? 'Yollanıyor…' : 'Toptancıya yolla'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
              <>
              <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>
                Hedef depo *
              </label>
              <select
                value={yonForm.depo}
                onChange={(e) => setYonForm((f) => ({ ...f, depo: e.target.value }))}
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                  fontSize: 13, fontFamily: 'inherit', outline: 'none',
                }}
              >
                <option value="">Depo seçin…</option>
                {depolar.map((d) => <option key={d.id} value={d.id}>{d.ad}</option>)}
              </select>

              <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, margin: '14px 0 6px', display: 'block' }}>
                Operasyon talimatı (isteğe bağlı)
              </label>
              <textarea
                rows={2}
                value={yonForm.talimat}
                onChange={(e) => setYonForm((f) => ({ ...f, talimat: e.target.value }))}
                placeholder="depo personeline not…"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                  fontSize: 13, fontFamily: 'inherit', outline: 'none', resize: 'vertical',
                }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  <button disabled={yonMesgul} onClick={() => setYonForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>Vazgeç</button>
                  <button disabled={yonMesgul || !yonForm.depo} onClick={yonKaydet} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: yonForm.depo ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : R.girinti,
                    color: yonForm.depo ? '#1C1309' : R.not, fontSize: 12.5, fontWeight: 700,
                    fontFamily: 'inherit', cursor: yonForm.depo ? 'pointer' : 'default',
                  }}>
                    {yonMesgul ? 'Yönlendiriliyor…' : 'Depoya yönlendir'}
                  </button>
                </div>
              </div>
              </>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: SİPARİŞ KATALOĞU ══════════════════════
  // Şubelerin sipariş edebildiği ürün listesi. v2'de HİÇ yönetilemiyordu.
  if (gorunum === 'katalog') {
    if (ktHata) return <HataBandi mesaj={ktHata} onTekrar={ktYukle} />;
    if (!ktKatalog) return <Yukleniyor />;

    const toplamUrun = ktKatalog.reduce((a, k) => a + (k.urunler || []).length, 0);
    const fiyatsiz = ktKatalog.reduce((a, k) =>
      a + (k.urunler || []).filter((u) => u.birim_fiyat_tl == null).length, 0);
    const eslesmemis = ktKatalog.reduce((a, k) =>
      a + (k.urunler || []).filter((u) => !u.depo_stok_kalem_kodu).length, 0);

    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kategori', deger: String(ktKatalog.length), alt: 'aktif katalog başlığı' },
          { etiket: 'Ürün', deger: String(toplamUrun), alt: 'şubelerin sipariş edebildiği' },
          { etiket: 'Fiyatsız ürün', deger: String(fiyatsiz), alt: fiyatsiz ? 'maliyet hesabına girmez' : 'hepsi fiyatlı', renk: fiyatsiz ? R.amber : R.yesil },
          { etiket: 'Depo eşleşmesi yok', deger: String(eslesmemis), alt: eslesmemis ? 'stok düşmez' : 'hepsi eşleşti', renk: eslesmemis ? R.amber : R.yesil },
        ]} />

        <div style={{
          padding: '11px 15px', borderRadius: 12, marginBottom: 14, fontSize: 11.5, lineHeight: 1.65,
          background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.24)', color: R.metin2,
        }}>
          Bu liste yalnız <b>aktif</b> kayıtları gösterir. Bir ürünü pasife aldığında
          buradan kaybolur — şubeler onu artık sipariş edemez, ama geçmiş siparişleri
          durur. Geri açmak şu an bu ekrandan yapılamıyor.
        </div>

        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
          <button onClick={() => setKtModal({ tip: 'kategori', ad: '', deger: '📦' })} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>+ Kategori ekle</button>
        </div>

        {ktKatalog.length === 0 ? (
          <BosDurum baslik="Katalog boş" aciklama="Henüz kategori tanımlanmamış. Şubelerin sipariş verebilmesi için önce kategori, sonra ürün ekleyin." />
        ) : ktKatalog.map((k) => (
          <div key={k.kod} style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: 17 }}>{k.emoji || '📦'}</span>
              <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>{k.ad}</span>
              <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2 }}>
                {(k.urunler || []).length} ürün
              </span>
              <button onClick={() => setKtModal({ tip: 'urun', kategori: k, ad: '', deger: '' })} style={{
                marginLeft: 'auto', padding: '6px 13px', borderRadius: 9, cursor: 'pointer',
                border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.metin2,
                fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
              }}>+ Ürün</button>
            </div>

            {(k.urunler || []).length === 0 ? (
              <div style={{ fontSize: 12, color: R.not2 }}>Bu kategoride ürün yok.</div>
            ) : (k.urunler || []).map((u) => (
              <div key={u.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
                borderBottom: `1px solid ${R.cizgi2}`, fontSize: 12.5, flexWrap: 'wrap',
              }}>
                <span style={{ flex: 1, minWidth: 140 }}>
                  {u.ad}
                  {!u.depo_stok_kalem_kodu && (
                    <span style={{ ...rozetHap(R.amber), marginLeft: 8, fontSize: 10 }}>depo eşleşmesi yok</span>
                  )}
                </span>
                <span style={{
                  fontFamily: F.mono, fontSize: 12, minWidth: 78, textAlign: 'right',
                  color: u.birim_fiyat_tl == null ? R.not3 : R.krem,
                }}>
                  {u.birim_fiyat_tl == null ? 'fiyatsız' : fmt(sayi(u.birim_fiyat_tl))}
                </span>
                <button onClick={() => setKtModal({ tip: 'ad', kategori: k, urun: u, ad: u.ad, deger: '' })} style={ktMiniBtn}>ad</button>
                <button onClick={() => setKtModal({ tip: 'fiyat', kategori: k, urun: u, ad: '', deger: u.birim_fiyat_tl == null ? '' : String(u.birim_fiyat_tl) })} style={ktMiniBtn}>fiyat</button>
                <button onClick={() => setKtModal({ tip: 'pasif', kategori: k, urun: u, ad: '', deger: '' })} style={{ ...ktMiniBtn, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>pasife al</button>
              </div>
            ))}
          </div>
        ))}

        {/* TEHLİKELİ: toplu migration — yazılı onay kapısı */}
        <div style={{ ...kartYuzey, padding: '16px 20px', border: `1px solid ${R.kirmizi}33` }}>
          <div style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>
            Ürün adlarını depo ile eşitle
          </div>
          <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.65, marginBottom: 12 }}>
            <b>Tek seferlik toplu işlem.</b> Katalogdaki ürün adlarını deponun kanonik
            adıyla değiştirir ve <b>geçmiş sipariş kayıtlarının içindeki adları da</b>
            günceller. Geri alınamaz — emin değilsen çalıştırma.
          </div>
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={ktSyncOnay} placeholder="Onaylamak için EVET_ESITLE yazın"
              onChange={(e) => setKtSyncOnay(e.target.value)}
              style={{ ...opsAlanStil, flex: '1 1 240px', marginBottom: 0 }} />
            <button disabled={ktMesgul || ktSyncOnay.trim() !== 'EVET_ESITLE'} onClick={ktSyncYap} style={{
              padding: '9px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
              cursor: ktSyncOnay.trim() === 'EVET_ESITLE' ? 'pointer' : 'default',
              border: `1px solid ${R.kirmizi}55`,
              background: ktSyncOnay.trim() === 'EVET_ESITLE' ? `${R.kirmizi}26` : R.girinti,
              color: ktSyncOnay.trim() === 'EVET_ESITLE' ? R.kirmizi : R.not3,
            }}>{ktMesgul ? 'Eşitleniyor…' : 'Adları eşitle'}</button>
          </div>
        </div>

        {ktModalBlok}
      </>
    );
  }

  // ── FAZ 6c ONAY MODALI ────────────────────────────────────────────────────
  const fdModalBlok = fdModal && (() => {
    const f = fdModal.kayit || {};
    const fark = sayi(f.fark);
    const T = fdModal.tip === 'karar' ? {
      baslik: fdModal.karar === 'acik' ? 'Kararı geri al'
        : fdModal.karar === 'girilen_dogru' ? 'Kasaya girilen doğru' : 'Evo satışı doğru',
      anlat: fdModal.karar === 'acik'
        ? 'Kayıt yeniden karar bekler duruma döner. Para yazma işlemi yapılmışsa bu onu geri almaz.'
        : (fdModal.karar === 'girilen_dogru'
          ? 'Kasadaki tutarın gerçek olduğunu söylüyorsun — fark Evo tarafındaki eksik/hatalı kayıttan geliyor demektir.'
          : 'Evo satışının gerçek olduğunu söylüyorsun — fark kasa girişindeki hatadan geliyor demektir.'),
      tehlike: false, buton: 'Kararı kaydet',
    } : fdModal.tip === 'gelire' ? {
      baslik: 'Fazlayı gelire yaz',
      anlat: 'Kasadaki fazla tutar DIŞ KAYNAK GELİRİ olarak kasa defterine işlenir. P&L cirosu Evo\'da kalır (satış gerçeği değişmez); bu para satış dışı gelirdir. Kasa defterine yazılan kayıt geri alınamaz.',
      tehlike: true, buton: 'Gelire yaz',
    } : {
      baslik: 'Eksiği gidere yaz',
      anlat: 'Eksik tutar ANLIK GİDER olarak kasa defterine işlenir. Kasa defterine yazılan kayıt geri alınamaz — önce farkın gerçekten kayıp olduğundan emin ol.',
      tehlike: true, buton: 'Gidere yaz',
    };
    const kapat = () => { if (!fdMesgul) setFdModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 450, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{T.baslik}</div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{f.sube_ad || f.sube_id || 'Şube'}</b> · {tarihKisa(f.tarih)}
          </div>
          <div style={{ fontSize: 12, color: R.not, marginBottom: 12, fontFamily: 'ui-monospace, monospace' }}>
            Kasa {fmt(sayi(f.girilen))} ₺ · Evo {fmt(sayi(f.evo))} ₺ · Fark{' '}
            <b style={{ color: fark < 0 ? R.kirmizi : R.yesil }}>{fark > 0 ? '+' : ''}{fmt(fark)} ₺</b>
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>
          {fdModal.tip === 'karar' && fdModal.karar !== 'acik' && (
            <>
              <label style={opsEtiket}>Gerekçe (isteğe bağlı)</label>
              <input value={fdModal.aciklama || ''} autoFocus
                onChange={(e) => setFdModal((p) => ({ ...p, aciklama: e.target.value }))} style={opsAlanStil} />
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={fdMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={fdMesgul} onClick={fdUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309',
            }}>{fdMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  // ── FAZ 4 MODALLARI ───────────────────────────────────────────────────────
  const mdModalBlok = mdModal && (() => {
    const T = {
      'okundu': { baslik: 'Alarmı okundu işaretle', anlat: 'Alarm listede kalır ama "görüldü" damgası alır. Olaylar devam ederse alarm yeniden yükselir.', buton: 'Okundu işaretle', tehlike: false },
      'sustur': { baslik: 'Alarmı sustur', anlat: 'Belirttiğin süre boyunca bu şubenin alarmı listede görünmez. Süre dolunca kendiliğinden geri döner — olaylar durmadıysa alarm da durmaz.', buton: 'Sustur', tehlike: false },
      'mesaj-sil': { baslik: 'Mesajı geri çek', anlat: 'Mesaj pasife alınır; şube panelinde görünmez. Kayıt silinmez, geçmişte durur.', buton: 'Geri çek', tehlike: true },
      'kapanis': { baslik: 'Kapanış mührünü aç', anlat: 'Gün sonu kapanışı iptal edilir, mühür açılır, gün sonu kasa teslimi silinir. KORUNUR: ciro taslağı ve vardiya/kasa devri. Kasaya dokunulmaz. Bu işlem denetim defterine yazılır.', buton: 'Mührü aç', tehlike: true },
    }[mdModal.tip] || {};
    const kapat = () => { if (!mdMesgul) setMdModal(null); };
    const onayla = mdModal.tip === 'kapanis' ? kapanisGeriAl : mdUygula;
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{T.baslik}</div>
            <button onClick={kapat} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>x</button>
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>
          {mdModal.tip === 'sustur' && (
            <>
              <label style={opsEtiket}>Susturma süresi (dakika · 5–1440)</label>
              <input type="number" min={5} max={1440} value={mdModal.dk ?? 120} autoFocus
                onChange={(e) => setMdModal((p) => ({ ...p, dk: e.target.value }))} style={opsAlanStil} />
            </>
          )}
          {(mdModal.tip === 'okundu' || mdModal.tip === 'sustur') && (
            <>
              <label style={opsEtiket}>Not (isteğe bağlı · 300 karakter)</label>
              <input value={mdModal.notu || ''} maxLength={300}
                onChange={(e) => setMdModal((p) => ({ ...p, notu: e.target.value }))} style={opsAlanStil} />
            </>
          )}
          {mdModal.tip === 'kapanis' && (
            <div style={{ fontSize: 12, color: R.metin2, marginBottom: 12, lineHeight: 1.7 }}>
              <b>{mdSubeler.find((x) => x.id === kgSube)?.ad || 'Şube'}</b> · {tarihKisa(kgTarih)}
              {kgSebep ? <><br /><span style={{ color: R.not }}>Sebep: {kgSebep}</span></> : null}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={mdMesgul} onClick={kapat} style={{ padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer', background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>Vazgeç</button>
            <button disabled={mdMesgul} onClick={onayla} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>{mdMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  const fisModalBlok = fisModal && (() => {
    const T = {
      'geldi': { baslik: 'Fiş geldi', anlat: 'Belge elimize ulaştı sayılır; gider fiş takibinden düşer.', tehlike: false, buton: 'Geldi olarak işaretle' },
      'gelmedi': { baslik: 'Fiş gelmedi', anlat: 'Harcamayı yapan personel için RİSK SİNYALİ oluşur. Aynı gün depoda hareket varsa sinyal ağırlığı yükselir (10), yoksa düşük kalır (4). Not bırakırsan sinyale işlenir.', tehlike: true, buton: 'Gelmedi olarak işaretle' },
      'muaf': { baslik: 'Fişten muaf', anlat: 'Bu harcama için belge beklenmez (ör. otopark, küçük ücret). Takipten düşer, risk sinyali doğmaz.', tehlike: false, buton: 'Muaf say' },
    }[fisModal.durum] || {};
    const kapat = () => { if (!fisMesgul) setFisModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 440, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>{T.baslik}</div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{fisModal.gider?.aciklama || 'Gider'}</b> · {fmt(sayi(fisModal.gider?.tutar))} ₺
          </div>
          <div style={{ fontSize: 12, color: R.not, marginBottom: 12 }}>
            {fisModal.gider?.sube_adi || '—'} · {tarihKisa(fisModal.gider?.tarih)}
            {fisModal.gider?.personel_ad ? ` · ${fisModal.gider.personel_ad}` : ''}
            {sayi(fisModal.gider?.gecikme_gun) > 0 ? ` · ${sayi(fisModal.gider.gecikme_gun)} gün geçti` : ''}
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>
          <label style={opsEtiket}>Not (isteğe bağlı)</label>
          <input value={fisModal.notu || ''} autoFocus
            onChange={(e) => setFisModal((p) => ({ ...p, notu: e.target.value }))} style={opsAlanStil} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={fisMesgul} onClick={kapat} style={{ padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer', background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>Vazgeç</button>
            <button disabled={fisMesgul} onClick={fisKarar} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>{fisMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  // ════════════════════════ GÖRÜNÜM: UZLAŞTIRMA ════════════════════════════
  // Denetim bulgusu (2026-07-31): v2 uyumsuzlukları ÇÖZEMİYORDU; sevkiyat /
  // kasa / personel-vardiya uyumsuzlukları GÖSTERİLMİYORDU bile. Dağınık
  // bırakmak yerine TEK uzlaştırma masası — her tip kendi KURALIYLA çözülür.
  if (gorunum === 'uzlastir') {
    if (uzHata) return <HataBandi mesaj={uzHata} onTekrar={uzYukle} />;
    if (!uzSevk || !uzPers) return <Yukleniyor />;

    const sevkSatir = Array.isArray(uzSevk?.satirlar) ? uzSevk.satirlar : [];
    const kasaSatir = Array.isArray(uzKasa?.uyarilar) ? uzKasa.uyarilar
      : (Array.isArray(uzKasa?.kayitlar) ? uzKasa.kayitlar : (Array.isArray(uzKasa) ? uzKasa : []));
    const persSatir = Array.isArray(uzPers?.kayitlar) ? uzPers.kayitlar : [];
    const acikKasa = kasaSatir.filter((k) => !/(cozuldu|çözüldü)/i.test(String(k.durum || '')));
    const acikPers = persSatir.filter((p) => !/(cozuldu|çözüldü)/i.test(String(p.durum || '')));
    // 'acik' = henüz karar verilmemiş; yazılmış olanlar (gelire/gidere) kapanmış sayılır
    const farkSatir = Array.isArray(uzFark) ? uzFark : [];
    const acikFark = farkSatir.filter((f) => !/(gelire_yazildi|gidere_yazildi|girilen_dogru|evo_dogru)/i.test(String(f.durum || '')));

    const ALT = [
      ['sevkiyat', `🚚 Sevkiyat (${sevkSatir.length})`],
      ['tahsis', `📦 Talep ↔ tahsis (${uzTahsis.length})`],
      ['kasa', `💰 Kasa (${acikKasa.length})`],
      ['personel', `👥 Personel-vardiya (${acikPers.length})`],
      ['ciro', `🧾 Ciro farkı (${acikFark.length})`],
    ];

    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Sevkiyat uyumsuzluğu', deger: String(sevkSatir.length), alt: 'son 30 gün · kabul farkı', renk: sevkSatir.length ? R.amber : R.yesil },
          { etiket: 'Kasa uyumsuzluğu', deger: String(acikKasa.length), alt: acikKasa.length ? 'açık kayıt' : 'temiz', renk: acikKasa.length ? R.kirmizi : R.yesil },
          { etiket: 'Personel-vardiya', deger: String(acikPers.length), alt: acikPers.length ? 'açık kayıt' : 'temiz', renk: acikPers.length ? R.amber : R.yesil },
          { etiket: 'Talep ↔ tahsis', deger: String(uzTahsis.length), alt: uzTahsis.length ? 'kalem uyuşmuyor' : 'temiz', renk: uzTahsis.length ? R.amber : R.yesil },
        ]} />

        <OneriSeridi metin="Uzlaştırma kaydı SİLMEZ — farkı kapatır ve kararı audit defterine yazar. Uzlaşma adedi hem talebin hem tahsisin yeni değeri olur; kalem 'tam' duruma geçer." />

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setUzAlt(id)} style={{
              padding: '7px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              color: uzAlt === id ? R.bakirAcik : R.metin2,
              background: uzAlt === id ? 'rgba(217,154,78,.14)' : R.girinti,
              border: `1px solid ${uzAlt === id ? 'rgba(217,154,78,.38)' : R.cizgi}`,
            }}>{ad}</div>
          ))}
        </div>

        {uzAlt === 'sevkiyat' && (sevkSatir.length === 0 ? (
          <BosDurum tamam baslik="Sevkiyat uyumsuzluğu yok" aciklama="Son 30 günde gönderilen ile kabul edilen adet birbirini tutuyor." />
        ) : (
          <Tablo
            baslik="Sevkiyat uyumsuzlukları · gönderilen ↔ kabul edilen"
            not="satıra tıkla → uzlaştır"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Kalem' }, { ad: 'Gönderilen', sag: true }, { ad: 'Kabul', sag: true }, { ad: 'Fark', sag: true }]}
            satirlar={sevkSatir.slice(0, 40).map((r, i) => {
              const gon = sayi(r.gonderilen_adet ?? r.gonderilen);
              const kab = sayi(r.kabul_adet ?? r.kabul_edilen);
              const fark = gon - kab;
              return {
                id: r.stok_yolda_id || r.id || `sv-${i}`, _r: r,
                hucreler: [
                  { v: r.sube_adi || r.hedef_sube_adi || '—', kalin: true },
                  { v: kisalt(r.kalem_adi || r.urun_adi || '—', 34) },
                  { v: String(gon), mono: true, sag: true },
                  { v: String(kab), mono: true, sag: true },
                  { v: (fark > 0 ? '+' : '') + String(fark), mono: true, sag: true, kalin: true, renk: fark === 0 ? R.yesil : R.amber },
                ],
              };
            })}
            onSatir={({ _r }) => setUzModal({
              tip: 'sevkiyat', kayit: _r,
              adet: String(sayi(_r.kabul_adet ?? _r.kabul_edilen)),
              notu: '',
            })}
          />
        ))}

        {uzAlt === 'tahsis' && (uzTahsis.length === 0 ? (
          <BosDurum tamam baslik="Talep ↔ tahsis uyumsuzluğu yok"
            aciklama="Şubenin istediği adet ile depoda tahsis edilen adet her kalemde örtüşüyor." />
        ) : (
          <>
            <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
              Şube <b>şu kadar istedi</b>, depo <b>şu kadar ayırdı</b> — ikisi tutmuyor.
              Genelde stok yetmediği için olur ve kalan adet fiilen iptal edilmiştir;
              ama sipariş kaydı hâlâ eski sayıyı taşıdığı için zincir "eksik" görünür.
              Uzlaştırma <b>iki sayıyı da</b> senin verdiğin adede eşitler ve kalemi
              "tam" duruma geçirir.
            </div>
            <Tablo
              baslik="Talep ↔ tahsis uyumsuzlukları · son 200 sipariş"
              not="satıra tıkla → uzlaştır"
              kolonlar={[{ ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Kalem' }, { ad: 'Talep', sag: true }, { ad: 'Tahsis', sag: true }, { ad: 'Fark', sag: true }]}
              satirlar={uzTahsis.slice(0, 60).map((t, i) => {
                const fark = t.tahsis_adet - t.talep_adet;
                return {
                  id: `${t.talep_id}-${t.urun_id}-${i}`, _t: t,
                  hucreler: [
                    { v: t.sube_adi, kalin: true },
                    { v: tarihKisa(t.tarih), mono: true, renk: R.not },
                    { v: kisalt(t.kalem_adi, 34) },
                    { v: String(t.talep_adet), mono: true, sag: true },
                    { v: String(t.tahsis_adet), mono: true, sag: true },
                    { v: (fark > 0 ? '+' : '') + String(fark), mono: true, sag: true, kalin: true, renk: R.amber },
                  ],
                };
              })}
              onSatir={({ _t }) => setUzModal({
                tip: 'tahsis', kayit: _t,
                // Varsayılan = TAHSİS: fiilen gönderilen/ayrılan gerçek sayı odur
                adet: String(_t.tahsis_adet),
                notu: '',
              })}
            />
          </>
        ))}

        {uzAlt === 'kasa' && (acikKasa.length === 0 ? (
          <BosDurum tamam baslik="Kasa uyumsuzluğu yok" aciklama="Açık kasa farkı kaydı bulunmuyor." />
        ) : (
          <Tablo
            baslik="Kasa uyumsuzlukları"
            not="satıra tıkla → çöz · fark tazelemek için satırdaki yeniden hesapla"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Fark', sag: true }, { ad: 'Durum' }, { ad: '' }]}
            satirlar={acikKasa.slice(0, 40).map((k, i) => ({
              id: k.id || `ku-${i}`, _k: k,
              hucreler: [
                { v: k.sube_adi || k.sube_ad || '—', kalin: true },
                { v: tarihKisa(k.tarih || k.gun), mono: true, renk: R.not },
                { v: fmt(sayi(k.fark_tl ?? k.fark)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: k.durum || 'açık', rozet: R.amber },
                { v: uzMesgul === `yh:${k.id}` ? '…' : '🔄 tazele', renk: R.mavi },
              ],
            }))}
            onSatir={({ _k }) => setUzModal({ tip: 'kasa', kayit: _k, adet: '', notu: '' })}
          />
        ))}

        {uzAlt === 'ciro' && (farkSatir.length ? (
          <>
            <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
              Kasaya girilen ciro ile Evo satışı tutmadığında buraya düşer.
              İki soru var: <b>hangisi doğru</b> (karar) ve <b>aradaki para ne oldu</b>
              (fazlaysa gelir, eksikse gider yazılır). Para yazma işlemi kasa
              defterine işlenir ve <b>geri alınamaz</b> — önce kararı ver.
            </div>
            <Liste satirlar={farkSatir.slice(0, 60).map((f) => {
              const fark = sayi(f.fark);
              const yazildi = /(gelire_yazildi|gidere_yazildi)/i.test(String(f.durum || ''));
              const kararli = /(girilen_dogru|evo_dogru)/i.test(String(f.durum || ''));
              const eylemler = [];
              if (!yazildi) {
                if (!kararli) {
                  eylemler.push({ ad: 'Kasa doğru', onTikla: () => setFdModal({ tip: 'karar', karar: 'girilen_dogru', kayit: f, aciklama: '' }) });
                  eylemler.push({ ad: 'Evo doğru', onTikla: () => setFdModal({ tip: 'karar', karar: 'evo_dogru', kayit: f, aciklama: '' }) });
                } else {
                  eylemler.push({ ad: 'Kararı geri al', onTikla: () => setFdModal({ tip: 'karar', karar: 'acik', kayit: f, aciklama: '' }) });
                }
                if (fark > 0) eylemler.push({ ad: 'Gelire yaz', onTikla: () => setFdModal({ tip: 'gelire', kayit: f }) });
                if (fark < 0) eylemler.push({ ad: 'Gidere yaz', onTikla: () => setFdModal({ tip: 'gidere', kayit: f }) });
              }
              return {
                baslik: `${f.sube_ad || f.sube_id || '—'} · ${tarihKisa(f.tarih)}`,
                alt: `Kasa ${fmt(sayi(f.girilen))} ₺ · Evo ${fmt(sayi(f.evo))} ₺${
                  yazildi ? ` — ${/gelire/i.test(String(f.durum)) ? 'gelire yazıldı' : 'gidere yazıldı'}`
                  : kararli ? ` — ${/girilen/i.test(String(f.durum)) ? 'kasa doğru denildi' : 'Evo doğru denildi'}` : ''}`,
                tutar: `${fark > 0 ? '+' : ''}${fmt(fark)} ₺`,
                tier: yazildi || kararli ? 'iyi' : (Math.abs(fark) >= 500 ? 'kritik' : 'uyari'),
                aksiyonlar: eylemler.length ? eylemler : undefined,
              };
            })} />
          </>
        ) : <BosDurum metin="Ciro farkı yok — kasa ile Evo satışı örtüşüyor. ✓" tamam />)}

        {fdModalBlok}

        {uzAlt === 'personel' && (acikPers.length === 0 ? (
          <BosDurum tamam baslik="Personel-vardiya uyumsuzluğu yok" aciklama="Vardiya kaydı ile fiili giriş-çıkış uyumlu." />
        ) : (
          <Tablo
            baslik="Personel ↔ vardiya uyumsuzlukları"
            not="satıra tıkla → çöz"
            kolonlar={[{ ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Sebep' }]}
            satirlar={acikPers.slice(0, 40).map((p, i) => ({
              id: p.id || `pv-${i}`, _p: p,
              hucreler: [
                { v: p.personel_ad || p.ad_soyad || '—', kalin: true },
                { v: p.sube_adi || '—', renk: R.not },
                { v: tarihKisa(p.tarih || p.gun), mono: true, renk: R.not },
                { v: kisalt(p.sebep || p.aciklama || p.tip || '—', 40) },
              ],
            }))}
            onSatir={({ _p }) => setUzModal({ tip: 'personel', kayit: _p, adet: '', notu: '' })}
          />
        ))}

        {/* İki farklı iş — karıştırılırsa mali kayıt yanlış yerden düzelir.
            KASA'ya özel; diğer sekmelerde gösterilirse yanlış yere bakılır. */}
        {uzAlt === 'kasa' && <div style={{
          padding: '12px 15px', borderRadius: 12, marginTop: 4, fontSize: 11.5, lineHeight: 1.65,
          background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.24)', color: R.metin2,
        }}>
          Kasa satırında <b>iki ayrı iş</b> var: <b>Farkı kapat</b> kaynağa dokunmaz, farkı
          olduğu gibi kabul edip kaydı çözüldü işaretler. <b>Kaynağı düzelt</b> ise gerçek
          mali kaydı (ciro / açılış / gider / devir) değiştirir, fark yeniden hesaplanır —
          bu yüzden <b>işletme onay PIN'i</b> ister ve <b>Tarihçe</b> sayfasından geri alınabilir.
        </div>}

        {uzModal && (() => {
          const m = uzModal;
          // Kasa satırı 3 sayfalı: farkı kapat · kaynağı düzelt (PIN) · tarihçe (geri al)
          const sayfa = m.tip === 'kasa' ? (m.sayfa || 'coz') : 'coz';
          const kilit = !!uzMesgul || kdMesgul || !!thMesgul;
          const BAS = sayfa === 'kaynak' ? 'Kasa farkı — kaynağı düzelt'
            : sayfa === 'tarihce' ? 'Düzeltme tarihçesi'
            : { sevkiyat: 'Sevkiyat uzlaşması', kasa: 'Kasa uyumsuzluğunu çöz',
                personel: 'Personel-vardiya uzlaşması', tahsis: 'Talep ↔ tahsis uzlaşması' }[m.tip];
          const gon = sayi(m.kayit.gonderilen_adet ?? m.kayit.gonderilen);
          const kab = sayi(m.kayit.kabul_adet ?? m.kayit.kabul_edilen);
          return (
            <div onClick={(e) => { if (e.target === e.currentTarget && !kilit) setUzModal(null); }} style={{
              position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
              backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}>
              <div style={{
                ...kartYuzey, width: sayfa === 'coz' ? 460 : 620, maxWidth: '96vw',
                maxHeight: '90vh', overflowY: 'auto', padding: '24px 26px',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>{BAS}</div>
                  <button onClick={() => !kilit && setUzModal(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>x</button>
                </div>

                {m.tip === 'sevkiyat' && (
                  <>
                    <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                      <b>{kisalt(m.kayit.kalem_adi || m.kayit.urun_adi || 'Kalem', 42)}</b>
                    </div>
                    <div style={{ fontSize: 12, color: R.not2, marginBottom: 14 }}>
                      Gönderilen <b style={{ fontFamily: F.mono }}>{gon}</b> ·
                      Kabul <b style={{ fontFamily: F.mono }}>{kab}</b> ·
                      Fark <b style={{ fontFamily: F.mono, color: R.amber }}>{gon - kab}</b>
                    </div>
                    <label style={opsEtiket}>Uzlaşma adedi</label>
                    <input value={m.adet} inputMode="numeric" autoFocus
                      onChange={(e) => setUzModal((p) => ({ ...p, adet: e.target.value }))}
                      style={opsAlanStil} />
                    <div style={{ fontSize: 11, color: R.not2, marginTop: -6, marginBottom: 12, lineHeight: 1.55 }}>
                      Bu adet hem talebin hem tahsisin YENİ değeri olur; kalem "tam" duruma geçer
                      ve karar audit defterine yazılır.
                    </div>
                  </>
                )}

                {m.tip === 'tahsis' && (() => {
                  const girilen = Math.max(0, Math.round(sayi(m.adet)));
                  const talep = sayi(m.kayit.talep_adet);
                  const tahsis = sayi(m.kayit.tahsis_adet);
                  return (
                    <>
                      <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                        <b>{kisalt(m.kayit.kalem_adi, 42)}</b>
                      </div>
                      <div style={{ fontSize: 12, color: R.not2, marginBottom: 14 }}>
                        {m.kayit.sube_adi} · {tarihKisa(m.kayit.tarih)} ·
                        {' '}Talep <b style={{ fontFamily: F.mono }}>{talep}</b> ·
                        {' '}Tahsis <b style={{ fontFamily: F.mono }}>{tahsis}</b> ·
                        {' '}Fark <b style={{ fontFamily: F.mono, color: R.amber }}>{tahsis - talep}</b>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                        {[[tahsis, `Tahsisi kabul et (${tahsis})`], [talep, `Talebi kabul et (${talep})`]].map(([v, ad]) => (
                          <div key={ad} onClick={() => setUzModal((p) => ({ ...p, adet: String(v) }))} style={{
                            padding: '7px 13px', borderRadius: 10, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                            border: `1px solid ${girilen === v ? R.bakir : R.cizgi3}`,
                            color: girilen === v ? R.bakir : R.metin2,
                            background: girilen === v ? 'rgba(217,154,78,.14)' : 'transparent',
                          }}>{ad}</div>
                        ))}
                      </div>
                      <label style={opsEtiket}>Uzlaşma adedi</label>
                      <input value={m.adet} inputMode="numeric"
                        onChange={(e) => setUzModal((p) => ({ ...p, adet: e.target.value }))}
                        style={opsAlanStil} />
                      <div style={{ fontSize: 11, color: R.not2, marginTop: -6, marginBottom: 12, lineHeight: 1.6 }}>
                        Bu adet <b>hem talebin hem tahsisin</b> yeni değeri olur — kalem
                        "tam" duruma geçer ve karar operasyon defterine yazılır.
                        {girilen !== tahsis && girilen !== talep && (
                          <> Girdiğin sayı ikisinden de farklı; <b>gerçekte ne gittiyse</b> onu yaz.</>
                        )}
                      </div>
                    </>
                  );
                })()}

                {m.tip === 'kasa' && sayfa === 'coz' && (
                  <>
                    <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                      <b>{m.kayit.sube_adi || m.kayit.sube_ad || 'Şube'}</b> · {tarihKisa(m.kayit.tarih || m.kayit.gun)}
                    </div>
                    <div style={{ fontSize: 12, color: R.not2, marginBottom: 14 }}>
                      Fark <b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(sayi(m.kayit.fark_tl ?? m.kayit.fark))}</b>
                    </div>
                    <label style={opsEtiket}>Düzeltilmiş fark (boş = orijinali kabul et)</label>
                    <input value={m.adet} inputMode="decimal" placeholder="orn. -25.50"
                      onChange={(e) => setUzModal((p) => ({ ...p, adet: e.target.value }))}
                      style={opsAlanStil} />
                    <div style={{ fontSize: 11.5, color: R.not2, marginTop: -4, marginBottom: 12, lineHeight: 1.6 }}>
                      Bu yol kaynağa <b>dokunmaz</b> — ciro/açılış/gider kaydı olduğu gibi kalır,
                      fark kabul edilip kayıt çözüldü işaretlenir. Yanlış olan gerçek bir kayıtsa
                      aşağıdan <b>Kaynağı düzelt</b>'e geç.
                    </div>
                    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 14 }}>
                      <button disabled={kilit} onClick={() => setUzModal((p) => ({
                        ...p, sayfa: 'kaynak', sebep: '', payload: {}, gelismis: false, pin: '',
                      }))} style={{
                        padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${R.bakirAcik}55`, background: `${R.bakirAcik}18`,
                        color: R.bakirAcik, fontSize: 12, fontWeight: 700,
                      }}>🔧 Kaynağı düzelt (PIN'li)</button>
                      <button disabled={kilit} onClick={() => {
                        setThOnay(null); thYukle(m.kayit.id);
                        setUzModal((p) => ({ ...p, sayfa: 'tarihce' }));
                      }} style={{
                        padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                        color: R.metin2, fontSize: 12, fontWeight: 600,
                      }}>📜 Tarihçe</button>
                    </div>
                  </>
                )}

                {/* ── KAYNAĞI DÜZELT — mali kaydı değiştirir, İŞLETME PIN'i şart ── */}
                {sayfa === 'kaynak' && (() => {
                  const dj = m.kayit.detay_json || {};
                  const tip = String(m.kayit.tip || '');
                  const devir = tip === 'ACILIS_KASA_FARK';
                  const fark = sayi(m.kayit.fark_tl ?? m.kayit.fark);
                  const fazla = devir ? fark > 0 : fark < 0;
                  const kutular = [{ etiket: '🌅 Açılış kasası', sebep: 'acilis_yanlis', pk: 'yeni_acilis_kasa', mev: dj.acilis_kasa }];
                  if (!devir) kutular.push({ etiket: '📝 Nakit ciro (Z)', sebep: 'ciro_yanlis', pk: 'yeni_nakit', mev: dj.z_nakit });
                  kutular.push({ etiket: '💵 Müdüre teslim', sebep: 'devir_yanlis', pk: 'yeni_teslim', mev: dj.teslim });
                  kutular.push({ etiket: '🌙 Kasada kalan (devir)', sebep: 'devir_yanlis', pk: 'yeni_devir', mev: dj.devir });
                  const mevFmt = (v) => (v != null && Number.isFinite(Number(v)) ? fmt(Number(v)) : '—');
                  const setPayload = (pk, v) => setUzModal((p) => ({
                    ...p, payload: { ...(p.payload || {}), [pk]: v },
                  }));
                  return (
                    <>
                      <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
                        <b>{m.kayit.sube_adi || m.kayit.sube_ad || 'Şube'}</b> · {tarihKisa(m.kayit.tarih || m.kayit.gun)} ·
                        {' '}fark <b style={{ fontFamily: F.mono, color: fazla ? R.yesil : R.kirmizi }}>{fmt(fark)}</b>
                      </div>
                      <div style={{ fontSize: 11, color: R.not2, marginBottom: 14 }}>
                        {devir
                          ? 'Devir: + sabah fazla saydı · − sabah eksik saydı'
                          : 'Kapanış: + kasa açığı (eksik nakit) · − kasa fazlası'}
                      </div>

                      {/* Z nakit 0 ise asıl sebep büyük ihtimalle onaylanmamış ciro */}
                      {!devir && (dj.z_nakit ?? -1) === 0 && Math.abs(fark) > 50 && (
                        <div style={{
                          padding: '11px 14px', borderRadius: 11, marginBottom: 14, fontSize: 11.5, lineHeight: 1.6,
                          background: 'rgba(251,191,36,.09)', border: '1px solid rgba(251,191,36,.34)', color: R.metin2,
                        }}>
                          <b style={{ color: R.amber }}>Z nakit 0 ₺ görünüyor — önce ciro onayına bak.</b><br />
                          Şube ciro girişi henüz onaylanmamış olabilir; onaylanırsa bu fark kendiliğinden
                          kapanır ve buradaki düzeltmeye gerek kalmaz.
                          <button disabled={kilit} onClick={() => { setUzModal(null); onKopru?.('__modul:onaylar:ciro'); }} style={{
                            display: 'block', marginTop: 8, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                            border: '1px solid rgba(251,191,36,.4)', background: 'rgba(251,191,36,.14)',
                            color: R.amber, fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                          }}>→ Bekleyen ciro onaylarına git</button>
                        </div>
                      )}

                      {devir && (
                        <div style={{
                          padding: '10px 14px', borderRadius: 11, marginBottom: 14, fontSize: 11.5, lineHeight: 1.6,
                          background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.24)', color: R.metin2,
                        }}>
                          Sabahçı az saydıysa <b>açılış kasası</b> kutusunu düzelt. Akşamcı yanlış
                          bıraktıysa <b>teslim / devir</b> kutusunu — o düzeltme <b>önceki günün kapanışına</b> yazılır.
                          Emin değilsen aşağıdaki <b>fark gerçek</b> düğmesini seç ve notu yaz.
                        </div>
                      )}

                      <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 10, lineHeight: 1.6 }}>
                        Yalnız <b>yanlış olan kutuyu</b> değiştir — sistem hangisini değiştirdiğini anlar,
                        gerçek kaydı düzeltir ve farkı yeniden hesaplar.
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                        {kutular.map((k) => {
                          const duzenlenen = m.sebep === k.sebep ? m.payload?.[k.pk] : undefined;
                          const aktif = duzenlenen != null;
                          return (
                            <label key={k.pk} style={{ fontSize: 11, color: R.not2 }}>
                              {k.etiket} <span style={{ color: R.metin2 }}>· şu an {mevFmt(k.mev)}</span>
                              <input
                                inputMode="decimal" disabled={kilit}
                                value={duzenlenen ?? (k.mev ?? '')}
                                onChange={(e) => {
                                  const v = e.target.value === '' ? undefined : Number(e.target.value);
                                  // Tek kutu kuralı: yeni kutuya geçince önceki düzenleme düşer
                                  setUzModal((p) => ({ ...p, gelismis: false, sebep: k.sebep, payload: { [k.pk]: v } }));
                                }}
                                style={kdKutuStil(aktif)} />
                            </label>
                          );
                        })}
                      </div>

                      <button disabled={kilit} onClick={() => setUzModal((p) => ({
                        ...p, gelismis: false, sebep: 'gercek_acik', payload: {},
                      }))} style={{
                        width: '100%', padding: '10px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                        fontSize: 12, fontWeight: m.sebep === 'gercek_acik' ? 700 : 600, marginBottom: 8,
                        border: `1px solid ${m.sebep === 'gercek_acik' ? 'rgba(220,38,38,.5)' : R.cizgi3}`,
                        background: m.sebep === 'gercek_acik' ? 'rgba(220,38,38,.16)' : 'transparent',
                        color: m.sebep === 'gercek_acik' ? '#FCA5A5' : R.metin2,
                      }}>
                        ⚠️ Veri doğru, fark gerçek {fazla ? 'fazla' : 'açık'} — kaynak değişmez
                      </button>

                      <button disabled={kilit} onClick={() => setUzModal((p) => ({ ...p, gelismis: !p.gelismis }))} style={{
                        background: 'none', border: 'none', color: R.not, fontSize: 11, cursor: 'pointer',
                        textDecoration: 'underline', fontFamily: 'inherit', padding: 0, marginBottom: 12,
                      }}>
                        {m.gelismis ? '▲ Gelişmişi gizle' : '⚙️ Gelişmiş (eksik gider / Z fazla / sebep seç)'}
                      </button>

                      {m.gelismis && (
                        <>
                          <label style={opsEtiket}>Sebep</label>
                          <select value={m.sebep || ''} disabled={kilit}
                            onChange={(e) => setUzModal((p) => ({ ...p, sebep: e.target.value, payload: {} }))}
                            style={opsAlanStil}>
                            <option value="">— seç —</option>
                            {kdSebepler(tip, fark).map(([v, ad]) => <option key={v} value={v}>{ad}</option>)}
                          </select>

                          {m.sebep === 'ciro_yanlis' && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                              {[['yeni_nakit', 'NAKİT'], ['yeni_pos', 'POS'], ['yeni_online', 'ONLINE']].map(([pk, ad]) => (
                                <label key={pk} style={{ fontSize: 11, color: R.not2 }}>
                                  {ad} (₺)
                                  <input inputMode="decimal" disabled={kilit} placeholder="boş = değiştirme"
                                    value={m.payload?.[pk] ?? ''}
                                    onChange={(e) => setPayload(pk, e.target.value === '' ? undefined : Number(e.target.value))}
                                    style={kdKutuStil(m.payload?.[pk] != null)} />
                                </label>
                              ))}
                            </div>
                          )}

                          {m.sebep === 'gider_eksik' && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                              <label style={{ fontSize: 11, color: R.not2 }}>
                                Kategori
                                <input disabled={kilit} placeholder="orn. Mutfak" value={m.payload?.kategori ?? ''}
                                  onChange={(e) => setPayload('kategori', e.target.value)}
                                  style={{ ...kdKutuStil(false), fontFamily: 'inherit' }} />
                              </label>
                              <label style={{ fontSize: 11, color: R.not2 }}>
                                Tutar (₺)
                                <input inputMode="decimal" disabled={kilit} placeholder={Math.abs(fark).toFixed(2)}
                                  value={m.payload?.tutar ?? ''}
                                  onChange={(e) => setPayload('tutar', e.target.value === '' ? undefined : Number(e.target.value))}
                                  style={kdKutuStil(m.payload?.tutar != null)} />
                              </label>
                              <label style={{ fontSize: 11, color: R.not2, gridColumn: '1 / -1' }}>
                                Açıklama (opsiyonel)
                                <input disabled={kilit} value={m.payload?.aciklama ?? ''}
                                  onChange={(e) => setPayload('aciklama', e.target.value)}
                                  style={{ ...kdKutuStil(false), fontFamily: 'inherit' }} />
                              </label>
                            </div>
                          )}

                          {m.sebep === 'ciro_fazla' && (
                            <>
                              <div style={{
                                padding: '10px 13px', borderRadius: 10, marginBottom: 10, fontSize: 11.5, lineHeight: 1.6,
                                background: 'rgba(74,222,128,.09)', border: '1px solid rgba(74,222,128,.3)', color: R.metin2,
                              }}>
                                Kasada beklenenden <b style={{ fontFamily: F.mono }}>{fmt(Math.abs(fark))}</b> fazla var.
                                Z raporu eksik basılmış olabilir; bu tutar <b>nakit ciroya eklenir</b>
                                (bildirilmemiş satış). POS ve online'a dokunulmaz.
                              </div>
                              <label style={{ fontSize: 11, color: R.not2, display: 'block', marginBottom: 12 }}>
                                Ciroya eklenecek nakit (₺)
                                <input inputMode="decimal" disabled={kilit} placeholder={Math.abs(fark).toFixed(2)}
                                  value={m.payload?.tutar ?? ''}
                                  onChange={(e) => setPayload('tutar', e.target.value === '' ? undefined : Number(e.target.value))}
                                  style={kdKutuStil(m.payload?.tutar != null)} />
                              </label>
                            </>
                          )}

                          {m.sebep === 'gercek_acik' && (
                            <div style={{
                              padding: '10px 13px', borderRadius: 10, marginBottom: 12, fontSize: 11.5, lineHeight: 1.6,
                              background: fazla ? 'rgba(74,222,128,.09)' : 'rgba(220,38,38,.1)',
                              border: `1px solid ${fazla ? 'rgba(74,222,128,.28)' : 'rgba(220,38,38,.3)'}`,
                              color: R.metin2,
                            }}>
                              Kaynak veriler (ciro / açılış / gider) <b>değişmez</b>. Fark olduğu gibi kalır,
                              kayıt çözüldü işaretlenir; {fazla
                                ? 'fazla tutar muhasebede ayrıca raporlanır.'
                                : 'kasa açığı şubeye/personele yansır.'}
                            </div>
                          )}
                        </>
                      )}

                      <label style={opsEtiket}>Düzeltme notu (opsiyonel)</label>
                      <input disabled={kilit} value={m.notu}
                        placeholder="orn. Açılış sayımında 200 ₺ atlanmış, kasiyer doğrulandı."
                        onChange={(e) => setUzModal((p) => ({ ...p, notu: e.target.value }))}
                        style={opsAlanStil} />

                      <label style={opsEtiket}>İşletme onay PIN kodu (4 hane)</label>
                      <input type="password" inputMode="numeric" maxLength={4} disabled={kilit}
                        value={m.pin || ''} placeholder="••••"
                        onChange={(e) => setUzModal((p) => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))}
                        style={{ ...opsAlanStil, letterSpacing: '6px', fontFamily: F.mono, marginBottom: 6 }} />
                      <div style={{ fontSize: 11, color: R.not2, marginBottom: 14, lineHeight: 1.6 }}>
                        Mali kayıt değişeceği için <b>Merve Karabacak'ın</b> panel PIN'i gerekir.
                        PIN'i sunucu doğrular; yanlışsa hiçbir şey yazılmaz.
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <button disabled={kilit} onClick={() => setUzModal((p) => ({ ...p, sayfa: 'coz', pin: '' }))} style={{
                          padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                        }}>‹ Geri</button>
                        <button disabled={kilit} onClick={kdGonder} style={{
                          padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', marginLeft: 'auto',
                          background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                        }}>{kdMesgul ? 'Düzeltiliyor…' : '🔧 Düzelt ve yeniden hesapla'}</button>
                      </div>

                      <div style={{ fontSize: 10.5, color: R.not2, marginTop: 12, lineHeight: 1.6 }}>
                        Kaynak güncellenir → kasa formülü yeniden hesaplanır → onay kuyruğundaki
                        KASA_FARK kaydı senkronlanır. Yeni fark 0 olursa kayıt otomatik çözüldü
                        işaretlenir. Her düzeltme <b>Tarihçe</b>'ye yazılır ve geri alınabilir.
                      </div>
                    </>
                  );
                })()}

                {/* ── TARİHÇE — audit defteri + geri alma ── */}
                {sayfa === 'tarihce' && (
                  <>
                    <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 12 }}>
                      <b>{m.kayit.sube_adi || m.kayit.sube_ad || 'Şube'}</b> · {tarihKisa(m.kayit.tarih || m.kayit.gun)}
                    </div>
                    {thVeri?.yukleniyor && <div style={{ fontSize: 12, color: R.not2, padding: '18px 0' }}>Tarihçe yükleniyor…</div>}
                    {!!thVeri?.hata && (
                      <div style={{
                        padding: '11px 14px', borderRadius: 11, marginBottom: 12, fontSize: 11.5,
                        background: 'rgba(220,38,38,.1)', border: '1px solid rgba(220,38,38,.3)', color: '#FCA5A5',
                      }}>
                        {thVeri.hata}
                        <button onClick={() => thYukle(m.kayit.id)} style={{
                          marginLeft: 10, background: 'none', border: 'none', color: R.mavi,
                          fontSize: 11, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit',
                        }}>tekrar dene</button>
                      </div>
                    )}
                    {!thVeri?.yukleniyor && !thVeri?.hata && (thVeri?.tarihce || []).length === 0 && (
                      <div style={{ fontSize: 12, color: R.not2, padding: '18px 0', lineHeight: 1.6 }}>
                        Bu uyarı için henüz kaynak düzeltmesi yapılmamış — geri alınacak bir şey yok.
                      </div>
                    )}
                    {(thVeri?.tarihce || []).map((t) => {
                      const geriAlindi = !!t.geri_alindi_mi;
                      const acik = thOnay?.kayit?.id === t.id;
                      return (
                        <div key={t.id} style={{
                          padding: '12px 14px', borderRadius: 12, marginBottom: 10,
                          background: R.girinti, border: `1px solid ${geriAlindi ? R.cizgi : R.cizgi3}`,
                          opacity: geriAlindi ? 0.62 : 1,
                        }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <b style={{ fontSize: 12.5, color: R.krem }}>{KD_SEBEP_AD[t.sebep] || t.sebep}</b>
                            <span style={{ fontSize: 11, color: R.not2, fontFamily: F.mono }}>{zamanKisa(t.olusturma)}</span>
                            {geriAlindi && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                                background: 'rgba(220,38,38,.16)', color: '#FCA5A5',
                              }}>↶ geri alındı</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11.5, color: R.not2, marginTop: 5, lineHeight: 1.6 }}>
                            Fark <b style={{ fontFamily: F.mono, color: R.metin2 }}>{fmt(sayi(t.eski_fark_tl))}</b>
                            {' → '}<b style={{ fontFamily: F.mono, color: R.metin2 }}>{fmt(sayi(t.yeni_fark_tl))}</b>
                            {' · '}{t.hedef_tablo || 'kaynak değişmedi'}
                            {t.personel_ad ? ` · ${t.personel_ad}` : ''}
                            {t.notu ? <><br />“{kisalt(t.notu, 120)}”</> : null}
                            {geriAlindi && t.geri_alan_personel_ad ? <br /> : null}
                            {geriAlindi && t.geri_alan_personel_ad
                              ? `Geri alan: ${t.geri_alan_personel_ad} · ${zamanKisa(t.geri_alma_ts)}` : ''}
                          </div>
                          {!geriAlindi && !acik && (
                            <button disabled={kilit} onClick={() => setThOnay({ kayit: t, pin: '', notu: '' })} style={{
                              marginTop: 9, padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
                              border: `1px solid ${R.cizgi3}`, background: 'transparent', color: R.metin2,
                              fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                            }}>↶ Bu düzeltmeyi geri al</button>
                          )}
                          {acik && (
                            <div style={{
                              marginTop: 10, padding: '12px 13px', borderRadius: 11,
                              background: 'rgba(220,38,38,.08)', border: '1px solid rgba(220,38,38,.28)',
                            }}>
                              <div style={{ fontSize: 11.5, color: R.metin2, lineHeight: 1.6, marginBottom: 10 }}>
                                <b style={{ color: '#FCA5A5' }}>Geri alınca ne olur:</b>{' '}
                                {t.hedef_tablo ? <><b>{t.hedef_tablo}</b> tablosundaki eski değerler geri yazılır</>
                                  : 'kaydın çözüldü işareti kaldırılır'} ve fark yeniden hesaplanır —
                                {' '}<b style={{ fontFamily: F.mono }}>{fmt(sayi(t.yeni_fark_tl))}</b> yerine
                                {' '}<b style={{ fontFamily: F.mono }}>{fmt(sayi(t.eski_fark_tl))}</b> beklenir.
                              </div>
                              <input disabled={!!thMesgul} value={thOnay.notu} placeholder="Geri alma sebebi (opsiyonel)"
                                onChange={(e) => setThOnay((p) => ({ ...p, notu: e.target.value }))}
                                style={opsAlanStil} />
                              <input type="password" inputMode="numeric" maxLength={4} disabled={!!thMesgul}
                                value={thOnay.pin} placeholder="İşletme PIN (4 hane)"
                                onChange={(e) => setThOnay((p) => ({ ...p, pin: e.target.value.replace(/\D/g, '') }))}
                                style={{ ...opsAlanStil, letterSpacing: '6px', fontFamily: F.mono }} />
                              <div style={{ display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
                                <button disabled={!!thMesgul} onClick={() => setThOnay(null)} style={{
                                  padding: '8px 14px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                                  background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                                }}>Vazgeç</button>
                                <button disabled={!!thMesgul} onClick={thGeriAl} style={{
                                  padding: '8px 16px', borderRadius: 9, border: '1px solid rgba(220,38,38,.5)', cursor: 'pointer',
                                  background: 'rgba(220,38,38,.2)', color: '#FCA5A5', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                                }}>{thMesgul === t.id ? 'Geri alınıyor…' : '↶ Evet, geri al'}</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', marginTop: 14 }}>
                      <button disabled={kilit} onClick={() => { setThOnay(null); setUzModal((p) => ({ ...p, sayfa: 'coz' })); }} style={{
                        padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>‹ Geri</button>
                    </div>
                  </>
                )}

                {m.tip === 'personel' && (
                  <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                    <b>{m.kayit.personel_ad || m.kayit.ad_soyad || 'Personel'}</b> ·
                    {' '}{tarihKisa(m.kayit.tarih || m.kayit.gun)}
                    <div style={{ fontSize: 11.5, color: R.not2, marginTop: 4 }}>
                      {kisalt(m.kayit.sebep || m.kayit.aciklama || '', 90)}
                    </div>
                  </div>
                )}

                {sayfa === 'coz' && (<>
                <label style={opsEtiket}>Not (opsiyonel)</label>
                <input value={m.notu} placeholder="orn. Stok yetersiz, kalan adet iptal kabul edildi."
                  onChange={(e) => setUzModal((p) => ({ ...p, notu: e.target.value }))}
                  style={opsAlanStil} />

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                  {m.tip === 'kasa' && (
                    <button disabled={!!uzMesgul} onClick={() => uzKasaYenidenHesapla(m.kayit)} style={{
                      padding: '10px 15px', borderRadius: 10, cursor: 'pointer',
                      border: `1px solid ${R.mavi}55`, background: `${R.mavi}18`, color: R.mavi,
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>🔄 Yeniden hesapla</button>
                  )}
                  <div style={{ display: 'flex', gap: 10, marginLeft: 'auto' }}>
                    <button disabled={!!uzMesgul} onClick={() => setUzModal(null)} style={{
                      padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={!!uzMesgul} onClick={uzUygula} style={{
                      padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    }}>{uzMesgul ? 'Uygulanıyor…' : 'Uzlaştır'}</button>
                  </div>
                </div>
                </>)}
              </div>
            </div>
          );
        })()}
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
                            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
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
                  ? 'Minimumun altında — sipariş için Sipariş Akışı, geçmiş için Stok Hareketi görünümü.'
                  : 'Hareket geçmişi Stok Hareketi görünümünde.',
                aksiyonAd: 'Stok hareketine git',
                _hedef: '__gorunum:hareket',
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
                              onClick={() => onKopru?.('__modul:ops:sayim')}
                              style={{
                                padding: '9px 17px', borderRadius: 10, border: 'none',
                                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
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
  // ════════════════════════ GÖRÜNÜM: BAR AKIŞI ══════════════════════════════
  // Operasyon Merkezi'nin 5 P0 sekmesi tek yerde (sahip hedefi: eski sürüm kalkacak):
  // açılış kasası · kapanış · ürün-aç akışı · kullanılan ürünler.
  // SALT-OKUR: kapanış/açılış YAZMA şubede QR akışında (kasa izi tek gerçek).
  if (gorunum === 'bar') {
    if (barHata) return <HataBandi mesaj={barHata} onTekrar={() => barYukle(barTarih)} />;
    if (!acilisTakip) return <Yukleniyor />;
    const acilisSatir = Array.isArray(acilisTakip?.satirlar) ? acilisTakip.satirlar : [];
    const kapanisSatir = Array.isArray(kapanisTakip?.satirlar) ? kapanisTakip.satirlar : [];
    const acilanSube = acilisSatir.filter((x) => x.acilis_tamam).length;
    // Özet sayaçlar sunucudan gelir (kapanis_yapan_adet / ciro_onaylanan_adet /
    // eksik_ciro_adet); uç eski bir cevap döndürürse satırdan hesaplanır.
    const kapananSube = kapanisTakip?.kapanis_yapan_adet != null
      ? sayi(kapanisTakip.kapanis_yapan_adet)
      : kapanisSatir.filter((x) => x.kapanis_tamam).length;
    const ciroOnaylanan = kapanisTakip?.ciro_onaylanan_adet != null
      ? sayi(kapanisTakip.ciro_onaylanan_adet)
      : kapanisSatir.filter((x) => x.ciro_onaylandi).length;
    const eksikCiro = kapanisTakip?.eksik_ciro_adet != null
      ? sayi(kapanisTakip.eksik_ciro_adet)
      : kapanisSatir.filter((x) => !x.ciro_onaylandi && !x.taslak_var).length;
    const taslakBekleyen = kapanisTakip?.taslak_bekleyen_adet != null
      ? sayi(kapanisTakip.taslak_bekleyen_adet)
      : kapanisSatir.filter((x) => x.taslak_var && x.taslak_durum === 'bekliyor').length;
    // Açılış farkı sayaçları SUNUCUDAN gelir (tolerans bandını o biliyor);
    // eski cevapta yoksa satırdan türetilir.
    const farkUyariAdet = acilisTakip?.fark_uyari_adet != null
      ? sayi(acilisTakip.fark_uyari_adet)
      : acilisSatir.filter((x) => ['uyari', 'kritik'].includes(x.fark_seviye)).length;
    const uyumsuzBekleyen = acilisTakip?.uyumsuzluk_bekleyen_adet != null
      ? sayi(acilisTakip.uyumsuzluk_bekleyen_adet)
      : acilisSatir.filter((x) => x.uyumsuzluk_bekliyor).length;
    const uyumsuzCozulen = acilisSatir.filter((x) => x.uyumsuzluk_cozuldu).length;
    // ⚠️ Eski hesap HER sıfır-olmayan farkı sayıyordu; 5 TL bile "fark" oluyordu.
    // Artık tolerans üstü olanlar (uyari/kritik) sayılır — sunucunun ölçüsü.
    const farkliAcilis = acilisSatir.filter((x) => x.fark_tl != null
      && (x.fark_seviye ? ['uyari', 'kritik'].includes(x.fark_seviye) : sayi(x.fark_tl) !== 0));
    const teslimBekleyen = kapanisSatir.filter((x) => x.kapanis_tamam && !sayi(x.teslim_kasa_tl));
    // Alarm YALNIZ tam denklemden: gün sürerken kısmi Δ gerçek fark değildir.
    const kasaFarkli = kapanisSatir.filter((x) => {
      const d = ktDelta(x);
      return d.gecerli && d.tam && Math.abs(d.deger) > 50;
    });
    const kasaAcikToplam = kasaFarkli.reduce((s, x) => s + Math.max(0, ktDelta(x).deger), 0);
    const ciftKayitli = kapanisSatir.filter(ktCift);
    // Kapanış tablosu aciliyet sırası: kapanmadı → ciro yok → onay bekliyor → tamam
    const kapanisOncelik = (r) => {
      if (!r.kapanis_tamam) return 0;
      if (!r.ciro_onaylandi && !r.taslak_var) return 1;
      if (r.taslak_var && r.taslak_durum === 'bekliyor') return 2;
      return 3;
    };
    const kapanisSirali = [...kapanisSatir].sort(
      (a, b) => kapanisOncelik(a) - kapanisOncelik(b)
        || String(a.sube_adi || '').localeCompare(String(b.sube_adi || ''), 'tr')
    );
    const acAkis = Array.isArray(urunAcAkis?.kayitlar) ? urunAcAkis.kayitlar : [];
    const gunDegis = (n) => {
      const y = gunEkleISO(barTarih, n);
      if (y > bugunYerelISO()) return;   // geleceğe gitme
      setBarTarih(y);
      barYukle(y);
    };
    const ALT = [
      ['acilis', `🌅 Açılış (${acilanSube}/${acilisSatir.length})`],
      ['kapanis', `🌑 Kapanış (${kapananSube}/${kapanisSatir.length})`],
      ['urunac', `🟢 Ürün-aç (${sayi(urunAcAkis?.toplam_islem)})`],
      ['kullanilan', '🟠 Kullanılan ürünler'],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açılan şube', deger: `${acilanSube} / ${acilisSatir.length}`, alt: barTarih === bugunYerelISO() ? 'bugün' : barTarih, renk: acilanSube === acilisSatir.length && acilisSatir.length ? R.yesil : R.amber },
          { etiket: 'Kapanan şube', deger: `${kapananSube} / ${kapanisSatir.length}`, alt: kapananSube < kapanisSatir.length ? 'kapanış bekleniyor' : 'tamamlandı', renk: kapananSube === kapanisSatir.length && kapanisSatir.length ? R.yesil : R.amber },
          {
            etiket: 'Açılış farkı',
            deger: String(farkUyariAdet),
            alt: farkUyariAdet
              ? `tolerans üstü${uyumsuzBekleyen ? ` · ${uyumsuzBekleyen} açık kayıt` : ''}${uyumsuzCozulen ? ` · ${uyumsuzCozulen} çözüldü` : ''}`
              : 'devirle uyumlu (±50 tolerans)',
            renk: farkUyariAdet ? R.kirmizi : R.yesil,
          },
          { etiket: 'Teslim bekleyen', deger: String(teslimBekleyen.length), alt: 'kapandı ama kasa teslim edilmedi', renk: teslimBekleyen.length ? R.amber : R.yesil },
          {
            etiket: 'Ciro onayı',
            deger: `${ciroOnaylanan} / ${kapanisSatir.length}`,
            alt: eksikCiro
              ? `${eksikCiro} şubede ciro hiç girilmedi`
              : taslakBekleyen ? `${taslakBekleyen} taslak onay bekliyor` : 'tamamlandı',
            renk: eksikCiro ? R.kirmizi : taslakBekleyen ? R.amber : R.yesil,
          },
          {
            etiket: 'Nakit Δ',
            deger: kasaFarkli.length ? String(kasaFarkli.length) : '0',
            alt: kasaFarkli.length
              ? (kasaAcikToplam > 0 ? `${tl(kasaAcikToplam)} kasa açığı` : 'fark var, açık yok')
              : kapananSube ? 'denklem tutuyor' : 'kapanış bekleniyor',
            renk: kasaFarkli.length ? R.kirmizi : R.yesil,
          },
        ]} />

        {/* gün gezgini + alt sekmeler */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => gunDegis(-1)} style={okButon}>‹</button>
            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, minWidth: 92, textAlign: 'center' }}>
              {tarihKisa(barTarih)}
            </span>
            <button onClick={() => gunDegis(1)} disabled={barTarih >= bugunYerelISO()} style={{
              ...okButon, opacity: barTarih >= bugunYerelISO() ? 0.35 : 1,
              cursor: barTarih >= bugunYerelISO() ? 'default' : 'pointer',
            }}>›</button>
          </div>
          <span style={{ width: 1, height: 20, background: R.cizgi3 }} />
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setBarSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${barSekme === id ? R.bakir : R.cizgi3}`,
              color: barSekme === id ? R.bakir : R.metin2,
              background: barSekme === id ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {barSekme === 'acilis' && (acilisSatir.length ? (
          <>
            {/* Açılış farkı da Uzlaştırma kuyruğuna düşer (/ops/kasa-uyumsuzluk).
                Burada İKİNCİ kuyruk kurulmaz: satırın o kuyruktaki DURUMU yazılır
                (çözüldü / bekliyor) ve çözüm masasına köprü verilir. Çözülmüş bir
                farkı kırmızı göstermek boşuna alarm olurdu. */}
            {uyumsuzBekleyen > 0 ? (
              <div style={{
                ...kartYuzey, padding: '13px 18px', marginBottom: 12, borderColor: `${R.amber}44`,
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              }}>
                <span style={rozetHap(R.amber)}>⚠ açık kasa uyumsuzluğu</span>
                <span style={{ fontSize: 12, color: R.not }}>
                  {uyumsuzBekleyen} şubede açılış farkı kayda düşmüş ve <b>henüz çözülmemiş</b>
                  {farkUyariAdet > uyumsuzBekleyen ? ` · ${farkUyariAdet} şubede fark tolerans üstünde` : ''}.
                  {' '}Çözme/işaretleme Uzlaştırma'da.
                </span>
                <button
                  onClick={() => onGorunum?.('uzlastir')}
                  style={{
                    marginLeft: 'auto', padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${R.bakir}66`, background: 'rgba(217,154,78,.14)',
                    color: R.bakirAcik, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                  }}
                >Uzlaştırmaya git →</button>
              </div>
            ) : null}

            <Tablo
              baslik={`Açılış kasası · ${tarihKisa(barTarih)}`}
              not={`${acilisTakip?.dunku_kapanis_tarih ? `${tarihKisa(acilisTakip.dunku_kapanis_tarih)} kapanış devri ile karşılaştırılır` : 'dünkü kapanış devri ile sabah sayımı karşılaştırılır'} · fark eşiği ±50 normal, 200+ kritik`}
              kolonlar={[
                { ad: 'Şube' }, { ad: 'Durum' }, { ad: 'Açılış saati' },
                { ad: 'Sayılan', sag: 1 }, { ad: 'Beklenen devir', sag: 1 },
                { ad: 'Fark', sag: 1 }, { ad: 'Uyumsuzluk' },
              ]}
              satirlar={acilisSatir.map((x, i) => {
                const fark = x.fark_tl == null ? null : sayi(x.fark_tl);
                const sev = SEVIYE[x.fark_seviye] || null;
                // Renk SEVİYEYE göre: 5 TL fark kırmızı olmamalı (sunucu ±50'yi
                // normal sayıyor, operasyon_kurallar.tolerans_seviyesi).
                const farkRenk = fark == null ? R.not
                  : x.uyumsuzluk_cozuldu ? R.not2
                    : sev ? sev.renk
                      : fark === 0 ? R.yesil : R.kirmizi;
                return {
                  id: x.sube_id || `a-${i}`,
                  hucreler: [
                    {
                      siraMetin: x.sube_adi || '',
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontWeight: 700 }}>{x.sube_adi || '—'}</span>
                          {x.personel_ad
                            ? <span style={{ fontSize: 10.5, color: R.not2 }}>{x.personel_ad}</span>
                            : null}
                        </span>
                      ),
                    },
                    x.acilis_tamam
                      ? {
                        // panel_acilis: kayıt şube panelinden (QR akışı) mı doğdu?
                        // Değilse sayım merkezde/dolaylı girilmiş demektir.
                        v: x.panel_acilis === false ? 'açıldı · panel dışı' : 'açıldı',
                        rozet: x.panel_acilis === false ? R.amber : R.yesil,
                      }
                      : { v: x.acilis_durum || 'bekliyor', rozet: R.amber },
                    { v: saatKisa(x.acilis_ts) || x.personel_saat || '—', mono: true, renk: R.not },
                    { v: x.acilis_kasa_tl != null ? fmt(sayi(x.acilis_kasa_tl)) : '—', mono: true, sag: true },
                    {
                      sira: x.beklenen_devir_tl != null ? sayi(x.beklenen_devir_tl) : null,
                      sag: true,
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span style={{ fontFamily: F.mono, color: R.not }}>
                            {x.beklenen_devir_tl != null ? fmt(sayi(x.beklenen_devir_tl)) : '—'}
                          </span>
                          {/* Devir tutarı yoksa "kim bıraktı" tek başına anlamsız
                              (karşılaştırılacak sayı yok) — birlikte gösterilir. */}
                          {x.dunku_kapanis_personel && x.beklenen_devir_tl != null
                            ? <span style={{ fontSize: 10, color: R.not2, whiteSpace: 'nowrap' }}>
                              {x.dunku_kapanis_personel} bıraktı
                            </span>
                            : null}
                        </span>
                      ),
                    },
                    fark == null
                      ? { v: '—', sag: true, renk: R.not }
                      : {
                        sira: fark, sag: true,
                        v: (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                            <span style={{ fontFamily: F.mono, fontWeight: 800, color: farkRenk }}>
                              {fark > 0 ? '+' : ''}{fmt(fark)}
                            </span>
                            {sev && fark !== 0
                              ? <span style={{ fontSize: 10, fontWeight: 700, color: farkRenk }}>{sev.ad}</span>
                              : null}
                          </span>
                        ),
                      },
                    x.uyumsuzluk_cozuldu
                      ? { v: 'çözüldü', rozet: R.yesil, sira: 0 }
                      : x.uyumsuzluk_bekliyor
                        ? { v: 'bekliyor', rozet: R.amber, sira: 2 }
                        : { v: '—', renk: R.not3, sira: 1 },
                  ],
                };
              })}
            />
          </>
        ) : <BosDurum metin="Bu gün için açılış kaydı yok." />)}

        {barSekme === 'kapanis' && (kapanisSatir.length ? (
          <>
            {/* İş günü ≠ takvim günü: gece 02:00'ye kadar önceki gün çalışılır.
                Tarih kutusunda "dün" görünmesi hata değil — sunucu böyle sayar. */}
            {kapanisTakip?.is_gunu_tr && kapanisTakip?.takvim_tr
              && String(kapanisTakip.is_gunu_tr) !== String(kapanisTakip.takvim_tr) ? (
              <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 12 }}>
                Takvim <span style={{ fontFamily: F.mono, color: R.metin2 }}>{kapanisTakip.takvim_tr}</span>
                {' · '}iş günü <span style={{ fontFamily: F.mono, color: R.metin2 }}>{kapanisTakip.is_gunu_tr}</span>
                {' — '}gece {sayi(kapanisTakip?.kapanis_son_teslim_saat) || 2}:00'ye kadar önceki gün sayılır.
              </div>
            ) : null}

            {/* Risk şeridi: kasa açığı YALNIZ tam denklemden doğar. Çözüm masası
                bu ekran değil — Uzlaştırma. Buradaki sayı gün fotoğrafıdır. */}
            {kasaFarkli.length ? (
              <div style={{
                ...kartYuzey, padding: '13px 18px', marginBottom: 14, borderColor: `${R.kirmizi}55`,
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              }}>
                <span style={rozetHap(R.kirmizi)}>⚠ nakit denklemi tutmuyor</span>
                <span style={{ fontSize: 12, color: R.not }}>
                  {kasaFarkli.length} şubede fark var
                  {kasaAcikToplam > 0 ? ` · toplam ${tl(kasaAcikToplam)} kasa açığı` : ''}
                  {' — '}
                  {kasaFarkli.map((x) => x.sube_adi).filter(Boolean).join(', ')}
                </span>
                <button
                  onClick={() => onGorunum?.('uzlastir')}
                  style={{
                    marginLeft: 'auto', padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${R.bakir}66`, background: 'rgba(217,154,78,.14)',
                    color: R.bakirAcik, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                  }}
                >Uzlaştırmaya git →</button>
              </div>
            ) : null}

            {/* Çift kayıt: online alanına nakit+POS toplamı yazılmışsa gün cirosu
                iki kez sayılırdı. Toplam sütunu düzeltilmiş değeri gösterir. */}
            {ciftKayitli.length ? (
              <OneriSeridi
                metin={`${ciftKayitli.map((x) => x.sube_adi).filter(Boolean).join(', ')} — online alanına nakit+POS toplamı yazılmış görünüyor. Ciro çift sayılmasın diye online 0 kabul edildi; düzeltme ciro onayında yapılır.`}
              />
            ) : null}

            <Tablo
              baslik={`Kapanış takibi · ${tarihKisa(barTarih)}`}
              not={`son teslim ${sayi(kapanisTakip?.kapanis_son_teslim_saat) || 2}:00 · satıra tıkla → nakit denklemi`}
              kolonlar={[
                { ad: 'Şube' }, { ad: 'Kapanış' }, { ad: 'Saat' },
                { ad: 'Ciro', sag: 1 }, { ad: 'Kasa sayımı', sag: 1 },
                { ad: 'Teslim', sag: 1 }, { ad: 'Devir', sag: 1 },
                { ad: 'Nakit Δ', sag: 1 }, { ad: 'Ciro onayı' },
              ]}
              satirlar={kapanisSirali.map((x, i) => {
                const d = ktDelta(x);
                const ciroT = ktCiro(x);
                const kismiNotr = d.kismi && !d.tam;
                const buyuk = d.gecerli && Math.abs(d.deger) > 0.5;
                const deltaRenk = !d.gecerli ? R.not3
                  : kismiNotr ? R.metin2
                    : !buyuk ? R.metin2
                      : d.deger > 0 ? R.kirmizi : R.yesil;
                const deltaEtiket = !d.gecerli ? null
                  : kismiNotr ? '⏳ olması gereken'
                    : !buyuk ? 'dengede'
                      : d.deger > 0 ? 'kasa açığı' : 'kasa fazlası';
                return {
                  id: x.sube_id || `k-${i}`,
                  _satir: x,
                  hucreler: [
                    {
                      siraMetin: x.sube_adi || '',
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                          <span style={{ fontWeight: 700 }}>{x.sube_adi || '—'}</span>
                          {x.kapanis_personel
                            ? <span style={{ fontSize: 10.5, color: R.not2 }}>{x.kapanis_personel}</span>
                            : null}
                        </span>
                      ),
                    },
                    x.kapanis_tamam
                      ? { v: 'kapandı', rozet: R.yesil }
                      : { v: x.acildi ? 'açık' : 'açılmadı', rozet: x.acildi ? R.amber : R.not },
                    { v: saatKisa(x.kapanis_ts) || '—', mono: true, renk: R.not },
                    {
                      sira: ciroT, sag: true,
                      v: (
                        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span style={{ fontFamily: F.mono, fontWeight: 700 }}>
                            {ciroT ? tl(ciroT) : '—'}
                          </span>
                          {ciroT ? (
                            <span style={{ fontSize: 10, color: R.not2, fontFamily: F.mono, whiteSpace: 'nowrap' }}>
                              N {tlSade(x.nakit)} · P {tlSade(x.pos)}
                              {ktCift(x)
                                ? ' · O çift'
                                : ktOnlineNet(x) ? ` · O ${tlSade(ktOnlineNet(x))}` : ''}
                            </span>
                          ) : null}
                        </span>
                      ),
                    },
                    // Kapanış yoksa kasa sayımı/devir HENÜZ YOK — 0 yazmak sahte
                    // sayıdır (şube kapanmadı, sayım yapılmadı demektir).
                    { v: x.kapanis_tamam ? tl(x.kasa_sayim) : '—', mono: true, sag: true, renk: x.kapanis_tamam ? undefined : R.not3 },
                    { v: sayi(x.teslim_kasa_tl) ? tl(x.teslim_kasa_tl) : '—', mono: true, sag: true, renk: sayi(x.teslim_kasa_tl) ? R.yesil : x.kapanis_tamam ? R.amber : R.not3 },
                    { v: x.kapanis_tamam ? tl(x.devir) : '—', mono: true, sag: true, renk: R.not },
                    d.gecerli
                      ? {
                        sira: d.deger, sag: true,
                        v: (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                            <span style={{ fontFamily: F.mono, fontWeight: buyuk && !kismiNotr ? 800 : 700, color: deltaRenk }}>
                              {tlIsaretli(d.deger)}
                            </span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: deltaRenk, whiteSpace: 'nowrap' }}>
                              {deltaEtiket}
                            </span>
                          </span>
                        ),
                      }
                      : {
                        sag: true, renk: R.not3, siraMetin: '',
                        v: (
                          <span style={{ fontSize: 10.5, lineHeight: 1.35, color: R.amber }}>
                            {!x.acildi && !x.kapanis_tamam ? 'açılış + kapanış yok'
                              : !x.acildi ? 'açılış yapılmadı' : 'kapanış yapılmadı'}
                          </span>
                        ),
                      },
                    x.ciro_onaylandi
                      ? { v: 'onaylandı', rozet: R.yesil }
                      : x.taslak_var
                        ? {
                          siraMetin: x.taslak_durum || 'gönderildi',
                          v: (
                            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
                              <span style={{
                                padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                                background: `${R.mavi}22`, color: R.mavi, whiteSpace: 'nowrap', alignSelf: 'flex-start',
                              }}>{x.taslak_durum || 'gönderildi'}</span>
                              {x.gonderen_ad
                                ? <span style={{ fontSize: 10.5, color: R.not2 }}>gönderen: {x.gonderen_ad}</span>
                                : null}
                            </span>
                          ),
                        }
                        : { v: 'ciro girilmedi', rozet: R.kirmizi },
                  ],
                };
              })}
              onSatir={(s) => {
                const x = s._satir; if (!x) return;
                const d = ktDelta(x);
                const ciroT = ktCiro(x);
                const sabah = sayi(x.sabah_kasa_tl);
                const nakitX = sayi(x.nakit);
                const teslim = sayi(x.teslim_kasa_tl);
                const devir = sayi(x.devir);
                const ara = sayi(x.ara_teslim_tl);
                const gider = sayi(x.anlik_gider_nakit_tl);
                onCekmece?.({
                  tip: 'KAPANIŞ · NAKİT DENKLEMİ',
                  baslik: x.sube_adi || 'Şube',
                  alt: `${tarihKisa(barTarih)} · ${x.kapanis_tamam ? `kapandı ${saatKisa(x.kapanis_ts) || ''}` : x.acildi ? 'kapanış bekleniyor' : 'açılış yapılmadı'}${x.kapanis_personel ? ` · ${x.kapanis_personel}` : ''}`,
                  kpi: [
                    { etiket: 'Gün cirosu', deger: tl(ciroT) },
                    {
                      etiket: 'Nakit Δ',
                      deger: d.gecerli ? tlIsaretli(d.deger) : '—',
                      renk: !d.gecerli || (d.kismi && !d.tam) ? R.metin2
                        : Math.abs(d.deger) <= 0.5 ? R.yesil
                          : d.deger > 0 ? R.kirmizi : R.amber,
                    },
                    { etiket: 'Teslim', deger: tl(teslim), renk: teslim ? R.yesil : R.amber },
                    { etiket: 'Devir', deger: tl(devir) },
                  ],
                  listeBaslik: 'Nakit denklemi (şelale)',
                  satirlar: [
                    { ad: 'Sabah kasa (açılış sayımı)', detay: 'gün başı devir', tutar: tl(sabah) },
                    { ad: 'Nakit ciro (X raporu)', detay: ktCift(x) ? 'online çift kayıt düzeltildi' : 'panelde girilen nakit', tutar: `+${tl(nakitX)}` },
                    { ad: 'Müdüre teslim', detay: 'kapanışta çıkan nakit', tutar: `−${tl(teslim)}` },
                    { ad: 'Ertesi güne devir', detay: 'kasada bırakılan', tutar: `−${tl(devir)}` },
                    { ad: 'Gün içi ara teslim', detay: ara ? 'gün ortasında müdüre verilen' : 'yok', tutar: `−${tl(ara)}` },
                    { ad: 'Nakit anlık gider', detay: gider ? 'aktif + onay bekleyen' : 'yok', tutar: `−${tl(gider)}` },
                    {
                      ad: d.gecerli ? (Math.abs(d.deger) <= 0.5 ? 'Sonuç: dengede' : d.deger > 0 ? 'Sonuç: kasa açığı' : 'Sonuç: kasa fazlası') : 'Sonuç: hesaplanamadı',
                      detay: d.tam ? 'tam denklem (açılış + kapanış var)' : d.kismi ? 'kısmi — gün sürüyor, gerçek fark değil' : 'açılış/kapanış eksik',
                      tutar: d.gecerli ? tlIsaretli(d.deger) : '—',
                    },
                  ],
                  not: d.tam && Math.abs(d.deger || 0) > 50
                    ? 'Pozitif fark = kasada olması gerekenden az nakit (açık). Düzeltme burada değil Uzlaştırma görünümünde yapılır — kaynağı düzeltmek kasa izine yazar.'
                    : d.kismi && !d.tam
                      ? 'Gün henüz kapanmadı. Bu sayı gerçek fark değil, şu an kasada olması gereken tutardır — kapanış girilince tam denkleme döner.'
                      : 'POS ve online tutarlar nakit denklemine girmez; denklem yalnız kasadaki parayı izler.',
                  aksiyonAd: 'Uzlaştırmaya git',
                  _hedef: '__gorunum:uzlastir',
                });
              }}
            />
          </>
        ) : <BosDurum metin="Bu gün için kapanış kaydı yok." />)}

        {barSekme === 'urunac' && (acAkis.length ? (
          <Tablo
            baslik={`Ürün-aç akışı · ${tarihKisa(barTarih)}`}
            not={`${sayi(urunAcAkis?.toplam_islem)} işlem · ${sayi(urunAcAkis?.toplam_adet)} adet — bara verilen ürünler`}
            kolonlar={[{ ad: 'Şube' }, { ad: 'Saat' }, { ad: 'Personel' }, { ad: 'Ürün' }, { ad: 'Adet', sag: 1 }]}
            satirlar={acAkis.slice(0, 60).map((x, i) => ({
              id: x.id || `u-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                { v: saatKisa(x.zaman || x.ts) || '—', mono: true, renk: R.not },
                { v: x.personel_ad || '—', renk: R.not },
                { v: x.urun_ad || x.kalem_adi || '—' },
                { v: String(sayi(x.adet)), mono: true, sag: true, kalin: true },
              ],
            }))}
          />
        ) : <BosDurum metin={`${tarihKisa(barTarih)} için ürün-aç kaydı yok — bara ürün verilmemiş ya da kayıt girilmemiş.`} />)}

        {barSekme === 'kullanilan' && (() => {
          const hepsi = Array.isArray(barOzet?.satirlar) ? barOzet.satirlar : [];
          const gunluk = barOzet?.gunluk === true;
          const gosterilen = gunluk ? hepsi : hepsi.slice(0, 8);
          if (!gosterilen.length) return <BosDurum metin="Bar özeti verisi yok." />;
          // Ürün-aç eksiği: satılan NEGATİF çıkmış = açılış+ürün-aç, kapanışı
          // karşılamıyor. Sunucu `fark_var`/`urun_ac_eksik_var` ile söylüyordu.
          const farkli = gosterilen.filter((x) => x.fark_var === true);
          const devirBozuk = gosterilen.filter((x) => x.devir_uyumsuz_var === true);
          const gecici = gosterilen.filter((x) => x.kapanis_var === false || x.kapanis_gercek === false);
          return (
            <>
              {!gunluk && (
                <div style={{ fontSize: 11.5, color: R.amber, marginBottom: 10 }}>
                  ⚠ {tarihKisa(barTarih)} için bar kaydı yok — son günler gösteriliyor
                  (Evo karşılaştırması yalnız tek gün seçiliyken yapılır).
                </div>
              )}

              {/* Evo karşılaştırma durumu — sunucu tek-gün sorgusunda dolduruyor.
                  "canlı" mı yoksa önbellekten "son çekim" mi olduğu ayrı yazılır;
                  eski veriyi canlıymış gibi göstermek yanlış güven verir. */}
              {gunluk && (
                <div style={{
                  ...kartYuzey, padding: '11px 16px', marginBottom: 12,
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  borderColor: barOzet?.evo_veri_geldi ? `${R.yesil}44` : `${R.amber}44`,
                }}>
                  <span style={rozetHap(barOzet?.evo_veri_geldi ? R.yesil : R.amber)}>
                    {barOzet?.evo_veri_geldi ? '✓ Evo verisi geldi' : '⚠ Evo verisi yok'}
                  </span>
                  <span style={{ fontSize: 11.5, color: R.not }}>
                    {barOzet?.evo_veri_geldi
                      ? (barOzet?.evo_canli === false
                        ? `Önbellekten okundu (son çekim${barOzet?.evo_son_cekim_ts ? ` ${String(barOzet.evo_son_cekim_ts).slice(0, 16).replace('T', ' ')}` : ''}) — canlı değil.`
                        : 'Canlı çekildi. Satılan sayılar Evo satışıyla karşılaştırılabilir.')
                      : (barOzet?.evo_mesaj || 'Evo satış verisi alınamadı — karşılaştırma yapılamıyor.')}
                  </span>
                </div>
              )}

              {/* ⚠️ BURASI UYARI KUYRUĞU DEĞİL. Aynı olaylar (URUN_AC_UYUMSUZLUK ·
                  STOK_BAR_DEVIR_FARK · STOK_BAR_GUN_ICI_FARK) Merkez Denetim ▸
                  Ürün uyumsuzluğu'nda ZATEN çözülebilir kayıt olarak duruyor
                  (/ops/urun-uyumsuzluk, durum + çöz akışıyla). Aynı işi ikinci
                  kez ilan etmeyiz: burada yalnız "kaç gün etkilendi" sayılır ve
                  çözüm masasına köprü verilir. Bu ekranın kendi katkısı
                  KALEM KALEM DENKLEM — o da satır çekmecesinde. */}
              {(farkli.length || devirBozuk.length) ? (
                <div style={{
                  ...kartYuzey, padding: '13px 18px', marginBottom: 12,
                  borderColor: farkli.length ? `${R.kirmizi}55` : `${R.amber}44`,
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                }}>
                  <span style={rozetHap(farkli.length ? R.kirmizi : R.amber)}>
                    {farkli.length ? '⚠ gün içi fark' : '⚠ devir farkı'}
                  </span>
                  <span style={{ fontSize: 12, color: R.not }}>
                    {farkli.length ? `${farkli.length} şube-günde satılan negatif (ürün-aç kaydı eksik olabilir)` : ''}
                    {farkli.length && devirBozuk.length ? ' · ' : ''}
                    {devirBozuk.length ? `${devirBozuk.length} şube-günde devir zinciri kopuk` : ''}
                    {' — '}
                    {[...new Set([...farkli, ...devirBozuk].map((x) => x.sube_adi))].filter(Boolean).join(', ')}.
                    {' '}Kalem kalem denklem için satıra tıkla; <b>çözme/işaretleme</b> Merkez Denetim'de.
                  </span>
                  <button
                    onClick={() => { setDnSekme('uyumsuz'); onGorunum?.('denetim'); }}
                    style={{
                      marginLeft: 'auto', padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                      border: `1px solid ${R.bakir}66`, background: 'rgba(217,154,78,.14)',
                      color: R.bakirAcik, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                    }}
                  >Ürün uyumsuzluğu kuyruğuna git →</button>
                </div>
              ) : null}

              <Tablo
                baslik={`Kullanılan ürünler · açılış + ürün-aç − kapanış${gunluk ? ` · ${tarihKisa(barTarih)}` : ''}`}
                not={`${gecici.length ? `${gecici.length} gün geçici kapanışla hesaplandı · ` : ''}satıra tıkla → kalem kalem denklem`}
                kolonlar={[
                  { ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Kapanış' },
                  { ad: 'Bardak (K/B/P)', sag: 1 }, { ad: 'Süt (L)', sag: 1 },
                  { ad: 'Su', sag: 1 }, { ad: 'Pasta', sag: 1 }, { ad: 'Denetim' },
                ]}
                satirlar={gosterilen.slice(0, 40).map((x, i) => {
                  const st = x.satilan || {};
                  const kay = BAR_KAPANIS_KAYNAK[x.kapanis_kaynak]
                    || { ad: x.kapanis_var ? 'geçici' : 'kapanmadı', renk: x.kapanis_var ? R.amber : R.not3, aciklama: 'kapanış kaydı yok' };
                  const haplar = [];
                  if (x.urun_ac_eksik_var) haplar.push({ ad: 'ürün-aç eksik', renk: R.kirmizi });
                  if (x.onceki_kapanis_yok) haplar.push({ ad: 'dün kapanış yok', renk: R.amber });
                  else if ((x.devir_uyumsuz_kalemleri || []).length) {
                    haplar.push({ ad: `devir ${x.devir_uyumsuz_kalemleri.length} kalem`, renk: R.amber });
                  }
                  return {
                    id: `${x.sube_id}-${x.tarih}-${i}`,
                    _bar: x,
                    hucreler: [
                      { v: x.sube_adi || '—', kalin: true },
                      { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                      { v: kay.ad, rozet: kay.renk },
                      { v: `${sayi(st.bardak_kucuk)} / ${sayi(st.bardak_buyuk)} / ${sayi(st.bardak_plastik)}`, mono: true, sag: true },
                      { v: sayi(st.sut_litre) ? String(sayi(st.sut_litre)) : '—', mono: true, sag: true },
                      { v: sayi(st.su_adet) ? String(sayi(st.su_adet)) : '—', mono: true, sag: true },
                      { v: sayi(st.pasta_adet) ? String(sayi(st.pasta_adet)) : '—', mono: true, sag: true },
                      haplar.length
                        ? {
                          sira: haplar.length,
                          siraMetin: haplar.map((h) => h.ad).join(' '),
                          v: (
                            <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                              {haplar.map((h, hi) => (
                                <span key={hi} style={{
                                  padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                                  background: `${h.renk}22`, color: h.renk, whiteSpace: 'nowrap',
                                }}>{h.ad}</span>
                              ))}
                            </span>
                          ),
                        }
                        : { v: 'tutuyor', rozet: R.yesil, sira: 0 },
                    ],
                  };
                })}
                onSatir={(row) => {
                  const x = row._bar; if (!x) return;
                  const ac = x.acilis || {}; const ua = x.urun_ac || {};
                  const kp = x.kapanis || {}; const st = x.satilan || {};
                  const evoAdet = x.evo_adet || {};
                  const kay = BAR_KAPANIS_KAYNAK[x.kapanis_kaynak];
                  // Kalem kalem denklem — yalnız HAREKET GÖRMÜŞ kalemler yazılır,
                  // 15 kalemin 10'u sıfırsa liste okunmaz hâle gelir.
                  const kalemler = BAR_KALEM
                    .filter(([k]) => sayi(ac[k]) || sayi(ua[k]) || sayi(kp[k]) || sayi(st[k]))
                    .map(([k, ad]) => {
                      const s = sayi(st[k]);
                      const negatif = s < 0 && BAR_DENETIM.has(k);
                      const evo = sayi(evoAdet[k]);
                      return {
                        ad: negatif ? `⚠ ${ad}` : ad,
                        detay: `açılış ${sayi(ac[k])} + ürün-aç ${sayi(ua[k])} − kapanış ${sayi(kp[k])}`
                          + (evo ? ` · Evo satış ${evo}` : '')
                          + (negatif ? ' — negatif: ürün-aç kaydı eksik olabilir' : ''),
                        tutar: `${s}`,
                      };
                    });
                  // Devir zinciri: dün kapanış + köprü ürün-aç = beklenen açılış
                  const df = x.devir_farklari || {};
                  const devirSatir = Object.entries(df).map(([k, d]) => {
                    const ad = (BAR_KALEM.find(([kk]) => kk === k) || [k, k])[1];
                    return {
                      ad: `↪ ${ad} · devir farkı`,
                      detay: `dün kapanış ${sayi(d.dun_kapanis)} + köprü ürün-aç ${sayi(d.kopru_urun_ac)} = beklenen ${sayi(d.beklenen)} · bugün açılış ${sayi(d.bugun_acilis)}`,
                      tutar: `${sayi(d.fark) > 0 ? '+' : ''}${sayi(d.fark)}`,
                    };
                  });
                  onCekmece?.({
                    tip: 'BAR GÜNÜ · KALEM DENKLEMİ',
                    baslik: x.sube_adi || 'Şube',
                    alt: `${tarihKisa(x.tarih)}${x.acilis_ts ? ` · açılış ${saatKisa(x.acilis_ts)}` : ''} · kapanış ${kay ? kay.ad : (x.kapanis_var ? 'geçici' : 'yok')}`,
                    kpi: [
                      { etiket: 'Bardak (K+B+P)', deger: String(sayi(st.bardak_kucuk) + sayi(st.bardak_buyuk) + sayi(st.bardak_plastik)) },
                      { etiket: 'Süt (L)', deger: String(sayi(st.sut_litre)) },
                      { etiket: 'Pasta', deger: String(sayi(st.pasta_adet)) },
                      {
                        etiket: 'Denetim',
                        deger: x.urun_ac_eksik_var ? 'ürün-aç eksik' : x.devir_uyumsuz_var ? 'devir farkı' : 'tutuyor',
                        renk: x.urun_ac_eksik_var ? R.kirmizi : x.devir_uyumsuz_var ? R.amber : R.yesil,
                      },
                    ],
                    listeBaslik: 'Kalem kalem: açılış + ürün-aç − kapanış = satılan',
                    satirlar: [...kalemler, ...devirSatir],
                    // Mesaj sırası ÖNEMLİ — en temel eksiklik önce söylenir.
                    // (Kapanış hiç yokken "negatif satılan" anlatmak yanıltıcı:
                    //  kapanış 0 sayıldığı için satılan ŞİŞMİŞ görünür.)
                    not: x.kapanis_var === false
                      ? 'Kapanış sayımı henüz YOK — kapanış 0 sayıldığı için "satılan" olduğundan yüksek görünür. Gün kapanınca sayılar yeniden hesaplanır; şu anki değerler geçicidir.'
                      : x.onceki_kapanis_yok
                        ? `Önceki gün (${x.onceki_kapanis_tarihi || '—'}) kapanış sayımı YOK — devir zinciri o günden kopuk, bugünkü açılış hiçbir şeyle karşılaştırılamıyor.`
                        : kay && x.kapanis_kaynak !== 'kapanis'
                          ? `Kapanış stoğu ${kay.aciklama}. Sayılar kesin değil; şube kapanışı tamamlayınca yeniden hesaplanır.`
                          : x.urun_ac_eksik_var
                            ? 'Negatif satılan = açılış + ürün-aç kapanışı karşılamıyor; bara ürün verilip ürün-aç kaydı girilmemiş olabilir. Bu ekran öneri verir, düzeltme şubedeki kayıt akışında yapılır.'
                            : 'Gün içi denklem tutuyor. Bu ekran SALT-OKUR ve öneri verir; sayım düzeltmesi şubedeki kayıt akışında yapılır.',
                  });
                }}
              />
            </>
          );
        })()}

        <div style={{ fontSize: 11.5, color: R.not, marginTop: 12, marginBottom: 16, lineHeight: 1.55 }}>
          ℹ Bu görünüm SALT-OKUR: açılış/kapanış kaydı şubede QR akışında doğar (kasa izi tek gerçek).
          Merkezden kapatma gerekiyorsa Operasyon Merkezi'ndeki yönetici akışı kullanılır.
        </div>
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: MERKEZ DENETİM ═════════════════════════
  // Operasyon Merkezi'nin denetim sekmeleri (P1) tek yerde — hepsi ÖNERİ-ONLY.
  if (gorunum === 'denetim') {
    if (dnHata) return <HataBandi mesaj={dnHata} onTekrar={() => denetimYukle(barTarih)} />;
    if (!dnUyumsuz) return <Yukleniyor />;
    const uyumsuzListe = Array.isArray(dnUyumsuz?.liste) ? dnUyumsuz.liste : [];
    const fireKayit = Array.isArray(dnFire?.kayitlar) && dnFire.kayitlar.length
      ? dnFire.kayitlar : (Array.isArray(dnFire?.son_kayitlar) ? dnFire.son_kayitlar : []);
    const fisListe = Array.isArray(dnFis?.kayitlar) ? dnFis.kayitlar
      : (Array.isArray(dnFis?.satirlar) ? dnFis.satirlar : (Array.isArray(dnFis) ? dnFis : []));
    // 🐞 SAHTE YEŞİL: sunucu diziyi `gunluk_satirlar` adıyla döndürüyor
    // (operasyon_merkez_api:4817). Eski kod `kalemler`/`satirlar` arıyordu →
    // liste HER ZAMAN boş → KPI "0 kalem" ve ekran "hareketler dengede ✓"
    // diyordu. Bu bir HÜKÜMDÜ, veri değil: 45 günün birikmiş açığı hiç
    // görünmüyordu. Satır anahtarları da yanlıştı (kalem_adi/kayip/fark/adet
    // yerine gerçeği urun_ad/acik/fazla/tahmini_tuketim_kayip).
    const kayipHam = Array.isArray(dnKayip?.gunluk_satirlar) ? dnKayip.gunluk_satirlar
      : (Array.isArray(dnKayip?.kalemler) ? dnKayip.kalemler
        : (Array.isArray(dnKayip?.satirlar) ? dnKayip.satirlar : []));
    // Yalnız AÇIK (eksik) satırlar uyarıdır; `fazla` çıkanlar ayrı okunur.
    const kayipListe = kayipHam.filter((x) => sayi(x.acik) > 0 || sayi(x.kayip) > 0);
    const kayipFazla = kayipHam.filter((x) => sayi(x.fazla) > 0);
    const kayipSube = Array.isArray(dnKayip?.sube_ozet) ? dnKayip.sube_ozet : [];
    const kayipPattern = Array.isArray(dnKayip?.haftalik_pattern) ? dnKayip.haftalik_pattern : [];
    const kayipSurekli = Array.isArray(dnKayip?.surekli_acik_personel) ? dnKayip.surekli_acik_personel : [];
    const kayipCokSube = kayipSurekli.filter((p) => p.cok_sube).length;
    // ⚠️ ÖLÇÜLEMEYEN GÜN: açılış eventi olmayan kapanışlar. Bunlar "kayıp yok"
    // DEĞİL "ölçülemedi" demektir — sıfır gibi göstermek yanlış güven verir.
    const kayipOlculemeyen = sayi(dnKayip?.veri_eksik_gun_sayisi);
    const kayipToplamAcik = kayipSube.reduce((s, x) => s + sayi(x.toplam_acik), 0);
    const kontrolSatir = Array.isArray(dnKontrol?.subeler) ? dnKontrol.subeler
      : (Array.isArray(dnKontrol?.satirlar) ? dnKontrol.satirlar : []);
    const gunDegis = (n) => {
      const y = gunEkleISO(barTarih, n);
      if (y > bugunYerelISO()) return;
      setBarTarih(y);
      denetimYukle(y);
    };
    const alarmListe = Array.isArray(mdAlarm?.alarmlar) ? mdAlarm.alarmlar : [];
    const mesajListe = Array.isArray(mdMesaj) ? mdMesaj : [];
    const okunmamisMesaj = mesajListe.filter((m) => !m.okundu).length;
    const ALT = [
      ['uyumsuz', `🧪 Ürün uyumsuzluğu (${sayi(dnUyumsuz?.gun_bekleyen)})`],
      ['fire', `🔥 Fire (${fireKayit.length})`],
      ['fis', `🧾 Gider fişi (${fisListe.length})`],
      ['kontrol', '🔍 Kontrol özeti'],
      ['kayip', `📉 Stok kaybı (${kayipListe.length})`],
      ['alarm', `🔐 Güvenlik (${sayi(mdAlarm?.alarm_sayisi)})`],
      ['mesaj', `📢 Merkez mesajı (${okunmamisMesaj})`],
      ['muhur', '🔓 Mühür açma'],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen uyumsuzluk', deger: String(sayi(dnUyumsuz?.gun_bekleyen)), alt: `${sayi(dnUyumsuz?.gun_toplam)} kayıt · ${sayi(dnUyumsuz?.gun_cozuldu)} çözüldü`, renk: sayi(dnUyumsuz?.gun_bekleyen) ? R.kirmizi : R.yesil },
          { etiket: 'Fire bildirimi', deger: String(sayi(dnFire?.gun_toplam)), alt: `${sayi(dnFire?.toplam_adet_gun)} adet · ${tarihKisa(barTarih)}`, renk: sayi(dnFire?.gun_toplam) ? R.amber : R.yesil },
          { etiket: 'Fişsiz gider', deger: String(fisListe.length), alt: 'son 7 gün · belge bekliyor', renk: fisListe.length ? R.amber : R.yesil },
          {
            etiket: 'Stok kaybı',
            deger: kayipToplamAcik ? String(kayipToplamAcik) : String(kayipListe.length),
            alt: kayipToplamAcik
              ? `adet açık · ${kayipListe.length} kalem-gün · 45 gün`
              : (kayipOlculemeyen ? `${kayipOlculemeyen} gün ÖLÇÜLEMEDİ` : 'son 45 gün analizi'),
            renk: kayipListe.length ? R.amber : kayipOlculemeyen ? R.not : R.yesil,
          },
        ]} />

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => gunDegis(-1)} style={okButon}>‹</button>
            <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, minWidth: 92, textAlign: 'center' }}>
              {tarihKisa(barTarih)}
            </span>
            <button onClick={() => gunDegis(1)} disabled={barTarih >= bugunYerelISO()} style={{
              ...okButon, opacity: barTarih >= bugunYerelISO() ? 0.35 : 1,
              cursor: barTarih >= bugunYerelISO() ? 'default' : 'pointer',
            }}>›</button>
          </div>
          <span style={{ width: 1, height: 20, background: R.cizgi3 }} />
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setDnSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${dnSekme === id ? R.bakir : R.cizgi3}`,
              color: dnSekme === id ? R.bakir : R.metin2,
              background: dnSekme === id ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {dnSekme === 'uyumsuz' && (uyumsuzListe.length ? (
          <Tablo
            baslik={`Ürün uyumsuzlukları · ${tarihKisa(barTarih)}`}
            not="formül → fark → çözüm; hüküm insanın (öneri-only)"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tip' }, { ad: 'Ürün' }, { ad: 'Fark', sag: 1 }, { ad: 'Durum' }]}
            satirlar={uyumsuzListe.slice(0, 40).map((x, i) => ({
              id: x.id || `uy-${i}`,
              hucreler: [
                { v: x.sube_adi || x.sube_ad || '—', kalin: true },
                { v: String(x.tip || '—').replace(/_/g, ' ').toLowerCase(), renk: R.not },
                { v: x.urun_ad || x.kalem_adi || '—' },
                { v: String(sayi(x.fark ?? x.fark_adet)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                x.cozuldu || x.durum === 'cozuldu'
                  ? { v: 'çözüldü', rozet: R.yesil }
                  : { v: 'bekliyor', rozet: R.amber },
              ],
            }))}
          />
        ) : <BosDurum metin={`${tarihKisa(barTarih)} için ürün uyumsuzluğu yok — sayımlar tutuyor. ✓`} />)}

        {dnSekme === 'fire' && (fireKayit.length ? (
          <Tablo
            baslik="Fire bildirimleri"
            not={sayi(dnFire?.gun_toplam) ? `${tarihKisa(barTarih)} günü` : 'bugün kayıt yok — son bildirimler'}
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Ürün' }, { ad: 'Adet', sag: 1 }, { ad: 'Sebep' }]}
            satirlar={fireKayit.slice(0, 40).map((x, i) => ({
              id: x.id || `f-${i}`,
              hucreler: [
                { v: x.sube_ad || x.sube_adi || '—', kalin: true },
                { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                { v: x.urun_ad || x.kalem_adi || '—' },
                { v: String(sayi(x.adet)), mono: true, sag: true, kalin: true, renk: R.amber },
                { v: x.sebep || x.aciklama || '—', renk: R.not },
              ],
            }))}
          />
        ) : <BosDurum metin="Fire bildirimi yok." />)}

        {fisModalBlok}
        {mdModalBlok}

        {dnSekme === 'fis' && (fisListe.length ? (
          <Tablo
            baslik="Fişi bekleyen giderler · son 7 gün"
            not="kasadan çıktı ama belge yüklenmedi — KDV kanıtı eksik"
            kolonlar={[{ ad: 'Açıklama' }, { ad: 'Tarih' }, { ad: 'Şube · personel' }, { ad: 'Tutar', sag: 1 }, { ad: 'Karar' }]}
            satirlar={fisListe.slice(0, 40).map((x, i) => ({
              id: x.id || `fi-${i}`,
              hucreler: [
                { v: x.aciklama || x.baslik || '—', kalin: true,
                  rozet: sayi(x.gecikme_gun) >= 5 ? { metin: `${sayi(x.gecikme_gun)} gün`, renk: R.kirmizi }
                    : (sayi(x.gecikme_gun) >= 2 ? { metin: `${sayi(x.gecikme_gun)} gün`, renk: R.amber } : null) },
                { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                { v: `${x.sube_adi || x.sube || '—'}${x.personel_ad ? ` · ${x.personel_ad}` : ''}`, renk: R.not },
                { v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: x.id ? (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => setFisModal({ gider: x, durum: 'geldi', notu: '' })} style={ktMiniBtn}>Geldi</button>
                      <button onClick={() => setFisModal({ gider: x, durum: 'muaf', notu: '' })} style={ktMiniBtn}>Muaf</button>
                      <button onClick={() => setFisModal({ gider: x, durum: 'gelmedi', notu: '' })}
                        style={{ ...ktMiniBtn, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Gelmedi</button>
                    </span>
                  ) : '—' },
              ],
            }))}
          />
        ) : <BosDurum metin="Fişi bekleyen gider yok — tüm harcamaların belgesi var. ✓" />)}

        {dnSekme === 'alarm' && (mdHata ? <HataBandi mesaj={mdHata} onTekrar={mdYukle} />
          : !mdAlarm ? <Yukleniyor />
          : alarmListe.length ? (
          <>
            <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 10, lineHeight: 1.7 }}>
              Şube panelinde PIN kilidi / hatalı PIN olayları eşiği aştığında alarm doğar.
              Pencere <b>{sayi(mdAlarm?.limitler?.pencere_dk)} dk</b> · kilit eşiği{' '}
              <b>{sayi(mdAlarm?.limitler?.pin_kilit_esik)}</b> · hatalı PIN eşiği{' '}
              <b>{sayi(mdAlarm?.limitler?.pin_hatali_esik)}</b>.
              Susturma süre dolunca kendiliğinden kalkar — olay sürüyorsa alarm geri gelir.
            </div>
            <Liste satirlar={alarmListe.map((a) => ({
              baslik: `${a.sube_adi || a.sube_id}${a.susturuldu ? ' · susturuldu' : ''}`,
              alt: a.mesaj || '—',
              tutar: a.seviye === 'kritik' ? 'KRİTİK' : 'uyarı',
              tier: a.susturuldu ? 'iyi' : (a.seviye === 'kritik' ? 'kritik' : 'uyari'),
              aksiyonlar: [
                { ad: 'Okundu', onTikla: () => setMdModal({ tip: 'okundu', alarm: a, notu: '' }) },
                { ad: 'Sustur', onTikla: () => setMdModal({ tip: 'sustur', alarm: a, notu: '', dk: 120 }) },
              ],
            }))} />
          </>
        ) : <BosDurum metin="Aktif güvenlik alarmı yok — şube girişlerinde anormallik görünmüyor. ✓" tamam />)}

        {dnSekme === 'mesaj' && (
          <>
            <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Şubeye zorunlu mesaj gönder</div>
              <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 12, lineHeight: 1.6 }}>
                Şube paneli bu mesajı <b>okumadan gün kapatamaz</b>. Süre dolunca listeden düşer.
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ minWidth: 160 }}>
                  <label style={opsEtiket}>Şube</label>
                  <select value={ymSube} onChange={(e) => setYmSube(e.target.value)} style={opsAlanStil}>
                    <option value="">— seçin —</option>
                    {mdSubeler.map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                  </select>
                </div>
                <div style={{ minWidth: 120 }}>
                  <label style={opsEtiket}>Öncelik</label>
                  <select value={ymOncelik} onChange={(e) => setYmOncelik(e.target.value)} style={opsAlanStil}>
                    <option value="normal">Normal</option>
                    <option value="kritik">Kritik</option>
                  </select>
                </div>
                <div style={{ minWidth: 120 }}>
                  <label style={opsEtiket}>Görünme süresi (saat)</label>
                  <input type="number" min={1} max={8760} value={ymTtl}
                    onChange={(e) => setYmTtl(e.target.value)} style={opsAlanStil} />
                </div>
              </div>
              <label style={opsEtiket}>Mesaj (3–2000 karakter · {ymMetin.trim().length})</label>
              <textarea value={ymMetin} onChange={(e) => setYmMetin(e.target.value)} rows={3}
                style={{ ...opsAlanStil, resize: 'vertical', lineHeight: 1.6 }} />
              <button disabled={mdMesgul} onClick={mesajGonder} style={{
                marginTop: 4, padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{mdMesgul ? 'Gönderiliyor…' : 'Mesajı gönder'}</button>
            </div>
            {mesajListe.length ? (
              <Liste baslik={`Gönderilen mesajlar · ${okunmamisMesaj} okunmadı`}
                satirlar={mesajListe.slice(0, 60).map((m) => ({
                  baslik: `${m.sube_adi || '—'}${m.oncelik === 'kritik' ? ' · KRİTİK' : ''}`,
                  alt: `${kisalt(m.mesaj || '', 110)} — ${m.okundu ? `okundu · ${m.okuyan_ad || 'personel'} · ${tarihKisa(m.okundu_ts)}` : 'okunmadı'}`,
                  tutar: tarihKisa(m.olusturma),
                  tier: m.okundu ? 'iyi' : (m.oncelik === 'kritik' ? 'kritik' : 'uyari'),
                  aksiyonlar: [{ ad: 'Geri çek', onTikla: () => setMdModal({ tip: 'mesaj-sil', mesaj: m }) }],
                }))} />
            ) : <BosDurum metin="Henüz merkez mesajı gönderilmemiş." tamam />}
          </>
        )}

        {dnSekme === 'muhur' && (
          <div style={{ ...kartYuzey, padding: '18px 20px', maxWidth: 520 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Kapanış mührünü aç</div>
            <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 14, lineHeight: 1.7 }}>
              Yanlış kapatılmış bir günü yeniden açar. <b>Korunur:</b> ciro taslağı ve
              vardiya/kasa devri. <b>Silinir:</b> yalnızca gün sonu kasa teslimi (yeniden
              kapanışta tekrar üretilir). Kasaya dokunulmaz, işlem denetim defterine yazılır.
              <br />İşletme onay PIN'i olmadan yapılamaz.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ minWidth: 170 }}>
                <label style={opsEtiket}>Şube</label>
                <select value={kgSube} onChange={(e) => setKgSube(e.target.value)} style={opsAlanStil}>
                  <option value="">— seçin —</option>
                  {mdSubeler.map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                </select>
              </div>
              <div style={{ minWidth: 150 }}>
                <label style={opsEtiket}>Tarih</label>
                <input type="date" value={kgTarih} max={bugunYerelISO()}
                  onChange={(e) => setKgTarih(e.target.value)} style={opsAlanStil} />
              </div>
            </div>
            <label style={opsEtiket}>Sebep (denetim defterine yazılır)</label>
            <input value={kgSebep} onChange={(e) => setKgSebep(e.target.value)} style={opsAlanStil} />
            <label style={opsEtiket}>İşletme onay PIN kodu (4 hane)</label>
            <input type="password" inputMode="numeric" maxLength={4} value={kgPin} autoComplete="off"
              onChange={(e) => setKgPin(e.target.value.replace(/\D/g, ''))}
              style={{ ...opsAlanStil, letterSpacing: 6, maxWidth: 140 }} />
            <button disabled={mdMesgul || !kgSube || kgPin.length !== 4}
              onClick={() => setMdModal({ tip: 'kapanis' })} style={{
                marginTop: 4, padding: '10px 20px', borderRadius: 10, cursor: 'pointer',
                border: `1px solid ${R.kirmizi}55`, background: `${R.kirmizi}26`, color: R.kirmizi,
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                opacity: (!kgSube || kgPin.length !== 4) ? 0.45 : 1,
              }}>Mührü aç…</button>
          </div>
        )}

        {dnSekme === 'kontrol' && (kontrolSatir.length ? (
          <Tablo
            baslik="Kontrol özeti · şube bazlı"
            not="günlük kontrol adımlarının tamamlanma durumu"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tamamlanan', sag: 1 }, { ad: 'Toplam', sag: 1 }, { ad: 'Durum' }]}
            satirlar={kontrolSatir.slice(0, 20).map((x, i) => {
              const tamam = sayi(x.tamam ?? x.tamamlanan);
              const toplam = sayi(x.toplam) || 1;
              return {
                id: x.sube_id || `kn-${i}`,
                hucreler: [
                  { v: x.sube_adi || x.sube_ad || '—', kalin: true },
                  { v: String(tamam), mono: true, sag: true },
                  { v: String(toplam), mono: true, sag: true, renk: R.not },
                  tamam >= toplam
                    ? { v: 'tamam', rozet: R.yesil }
                    : { v: `${toplam - tamam} eksik`, rozet: R.amber },
                ],
              };
            })}
          />
        ) : <BosDurum metin="Kontrol özeti verisi yok." />)}

        {dnSekme === 'kayip' && (
          <>
            {/* ÖLÇÜLEMEYEN GÜN — "kayıp yok" ile karıştırılmaz. Açılış eventi
                olmayan kapanışta denklem kurulamaz; sıfır göstermek yanlış
                güven verir, o yüzden ayrı ve önce söylenir. */}
            {kayipOlculemeyen > 0 && (
              <div style={{
                ...kartYuzey, padding: '11px 16px', marginBottom: 12, borderColor: `${R.amber}44`,
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              }}>
                <span style={rozetHap(R.amber)}>⚠ ölçülemeyen gün</span>
                <span style={{ fontSize: 11.5, color: R.not }}>
                  {kayipOlculemeyen} şube-günde açılış sayımı yok — o günler için denklem
                  kurulamadı. Bu <b>“kayıp yok” demek değil</b>, “ölçülemedi” demektir.
                </span>
              </div>
            )}

            {/* ŞUBE ÖZETİ — 45 günün birikmiş açığı. Bu ekranın kendi katkısı:
                tek günün değil KÜMÜLATİF tablo (tek gün denklemi Ürün
                uyumsuzluğu sekmesinde, beyan edilen fire ise Fire sekmesinde). */}
            {kayipSube.length > 0 && (
              <Tablo
                baslik={`Şube bazında birikmiş açık · son ${sayi(dnKayip?.gun_sayi) || 45} gün`}
                not="açılış + eklenen − kapanış; kayıtlı hareketle açıklanmayan azalma"
                kolonlar={[{ ad: 'Şube' }, { ad: 'Toplam açık', sag: 1 }, { ad: 'Kalem-gün', sag: 1 }, { ad: 'Açık gün', sag: 1 }]}
                satirlar={kayipSube.slice(0, 20).map((x, i) => ({
                  id: x.sube_id || `ks-${i}`,
                  hucreler: [
                    { v: x.sube_adi || '—', kalin: true },
                    { v: String(sayi(x.toplam_acik)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                    { v: String(sayi(x.acik_kalem)), mono: true, sag: true, renk: R.not },
                    { v: `${sayi(x.acik_gun_sayisi)} gün`, mono: true, sag: true, renk: R.not },
                  ],
                }))}
              />
            )}

            {/* PERSONEL EKSENİ — ROL AYRIMI: kişi listesi ve hükmü
                Ekip ▸ Personel Denetimi'nde kalır (/ops/personel-davranis-analiz
                orada zaten var). Burada YALNIZ sayı + köprü; aynı kişi listesini
                iki ekrana basmak mükerrer yapı olurdu. */}
            {kayipSurekli.length > 0 && (
              <div style={{
                ...kartYuzey, padding: '13px 18px', marginBottom: 16, borderColor: `${R.kirmizi}44`,
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              }}>
                <span style={rozetHap(R.kirmizi)}>⚠ sürekli açık veren personel</span>
                <span style={{ fontSize: 12, color: R.not }}>
                  {kayipSurekli.length} personel birden fazla günde açık veriyor
                  {kayipCokSube ? ` · ${kayipCokSube} kişi birden fazla şubede` : ''}.
                  {' '}Kişi kırılımı ve hüküm Ekip ▸ Personel Denetimi'nde.
                </span>
                <button
                  onClick={() => onKopru?.('__modul:ekip:denetim')}
                  style={{
                    marginLeft: 'auto', padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${R.bakir}66`, background: 'rgba(217,154,78,.14)',
                    color: R.bakirAcik, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                  }}
                >Personel Denetimi'ne git →</button>
              </div>
            )}

            {/* HAFTA GÜNÜ DESENİ — "hangi gün tekrar ediyor" sorusu */}
            {kayipPattern.length > 0 && (
              <Tablo
                baslik="Hafta günü deseni · tekrar eden açık"
                not="aynı ürün + aynı gün tekrar ediyorsa desen vardır — öneri, hüküm değil"
                kolonlar={[{ ad: 'Şube' }, { ad: 'Ürün' }, { ad: 'Gün' }, { ad: 'Ortalama açık', sag: 1 }, { ad: 'Örnek', sag: 1 }]}
                satirlar={kayipPattern.slice(0, 12).map((x, i) => ({
                  id: `kp-${i}`,
                  hucreler: [
                    { v: x.sube_adi || '—', kalin: true },
                    { v: x.urun_ad || x.urun || '—' },
                    // hafta_gun sunucuda ZATEN Türkçe gün adı (gun_adlari[weekday()])
                    { v: x.hafta_gun || '—', renk: R.not },
                    { v: trSayi(sayi(x.ortalama_acik)), mono: true, sag: true, kalin: true, renk: R.amber },
                    { v: `${sayi(x.ornek_sayisi)}×`, mono: true, sag: true, renk: R.not },
                  ],
                }))}
              />
            )}

            {kayipListe.length ? (
              <Tablo
                baslik={`Kalem kalem · gün gün${kayipFazla.length ? ` · ${kayipFazla.length} satırda FAZLA çıktı` : ''}`}
                not="kayıtlı hareketle açıklanmayan azalma — aday, hüküm değil"
                kolonlar={[
                  { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Ürün' }, { ad: 'Personel' },
                  { ad: 'Açılış', sag: 1 }, { ad: 'Eklenen', sag: 1 }, { ad: 'Kapanış', sag: 1 }, { ad: 'Açık', sag: 1 },
                ]}
                satirlar={kayipListe.slice(0, 40).map((x, i) => ({
                  id: `ky-${i}`,
                  hucreler: [
                    { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                    { v: x.sube_adi || '—', kalin: true },
                    { v: x.urun_ad || x.urun || x.kalem_adi || '—' },
                    { v: x.personel_ad || '—', renk: R.not2 },
                    { v: String(sayi(x.acilis)), mono: true, sag: true, renk: R.not },
                    { v: sayi(x.eklenen) ? String(sayi(x.eklenen)) : '—', mono: true, sag: true, renk: R.not },
                    { v: String(sayi(x.kapanis)), mono: true, sag: true, renk: R.not },
                    { v: String(sayi(x.acik) || sayi(x.kayip)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                  ],
                }))}
              />
            ) : (
              <BosDurum metin={kayipOlculemeyen > 0
                ? 'Ölçülebilen günlerde stok açığı bulunmadı — ama yukarıdaki ölçülemeyen günler hesaba katılmadı.'
                : 'Stok kaybı bulgusu yok — hareketler dengede. ✓'} />
            )}

            {sayi(dnKayip?.is_gunu_siniri_saat) > 0 && (
              <div style={{ fontSize: 11, color: R.not2, marginTop: -4, marginBottom: 12 }}>
                İş günü sınırı: gece {sayi(dnKayip.is_gunu_siniri_saat)}:00'den önceki kapanış
                bir önceki güne yazılır.
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 11.5, color: R.not, marginTop: 12, marginBottom: 16, lineHeight: 1.55 }}>
          ℹ Hepsi ÖNERİ-ONLY: bu ekran uyumsuzluğu GÖSTERİR, hüküm vermez.
          Uzlaştırma/çözüm işaretleri ilgili guard'lı akışlarda yapılır.
        </div>
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: TEDARİK & SİNYAL ═══════════════════════
  // ops-merkez P3: toptancıdan gelenler · şube notları · stok tahmini · KPI delta
  if (gorunum === 'tedarik') {
    if (tsHata) return <HataBandi mesaj={tsHata} onTekrar={tedarikYukle} />;
    if (!tsTeslim) return <Yukleniyor />;
    const teslimSube = Array.isArray(tsTeslim?.subeler) ? tsTeslim.subeler : [];
    const notlar = Array.isArray(tsNotlar) ? tsNotlar : [];
    const tahminler = Array.isArray(tsTahmin?.tahminler) ? tsTahmin.tahminler : [];
    const kpilar = Array.isArray(tsKpi?.kpilar) ? tsKpi.kpilar : [];
    const kritikTahmin = tahminler.filter((t) => sayi(t.kalan_gun) > 0 && sayi(t.kalan_gun) <= 7);
    const kotuKpi = kpilar.filter((k) => k.yon === 'kotu');
    const ALT = [
      ['teslim', `📦 Toptancıdan gelen (${teslimSube.length})`],
      ['notlar', `📝 Şube notları (${notlar.length})`],
      ['tahmin', `🔮 Stok tahmini (${tahminler.length})`],
      ['kpi', `📊 KPI değişimi (${kpilar.length})`],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Teslim alan şube', deger: `${teslimSube.length} şube`, alt: `son ${sayi(tsTeslim?.gun) || 14} gün`, renk: R.krem },
          { etiket: 'Şube notu', deger: String(notlar.length), alt: 'merkeze düşen kayıt', renk: notlar.length ? R.mavi : R.yesil },
          { etiket: 'Tükenme riski', deger: String(kritikTahmin.length), alt: kritikTahmin.length ? '7 günden az kalan kalem' : 'kritik kalem yok', renk: kritikTahmin.length ? R.kirmizi : R.yesil },
          { etiket: 'Kötüleşen KPI', deger: String(kotuKpi.length), alt: kotuKpi.length ? kotuKpi.map((k) => k.etiket).slice(0, 2).join(', ') : 'tümü iyi/nötr', renk: kotuKpi.length ? R.amber : R.yesil },
        ]} />

        <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setTsSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${tsSekme === id ? R.bakir : R.cizgi3}`,
              color: tsSekme === id ? R.bakir : R.metin2,
              background: tsSekme === id ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {tsSekme === 'teslim' && (teslimSube.length ? (
          <Tablo
            baslik={`Toptancıdan gelenler · son ${sayi(tsTeslim?.gun) || 14} gün`}
            not="şube panelinden girilen teslim alımları"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Teslim adedi', sag: true }, { ad: 'Son teslim' }]}
            satirlar={teslimSube.map((x, i) => ({
              id: x.sube_id || `t-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                { v: String(sayi(x.toplam)), mono: true, sag: true, kalin: true },
                { v: tarihKisa(x.son_tarih), mono: true, renk: R.not },
              ],
            }))}
          />
        ) : <BosDurum metin="Son 14 günde toptancıdan teslim alımı kaydı yok." />)}

        {tsSekme === 'notlar' && (notlar.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {notlar.slice(0, 30).map((n, i) => {
              const sistemNotu = /^\[/.test(String(n.metin || ''));
              return (
                <div key={n.id || `n-${i}`} style={{
                  ...kartYuzey, padding: '12px 16px',
                  borderLeft: `3px solid ${sistemNotu ? R.mavi : R.bakir}`,
                }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 5 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{n.sube_adi || n.sube_id || '—'}</span>
                    <span style={{ fontSize: 11, color: R.not2, fontFamily: F.mono }}>{tarihKisa(n.tarih || n.olusturma)}</span>
                    {sistemNotu && <span style={rozetHap(R.mavi)}>sistem</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.55 }}>{n.metin || '—'}</div>
                </div>
              );
            })}
          </div>
        ) : <BosDurum metin="Şube notu yok." />)}

        {tsSekme === 'tahmin' && (tahminler.length ? (
          <Tablo
            baslik={`Stok tahmini · ${sayi(tsTahmin?.gun) || 14} günlük tüketim ortalaması`}
            not="ortalama tüketimden ileriye projeksiyon — sipariş planı için"
            kolonlar={[
              { ad: 'Ürün' }, { ad: 'Günlük ort.', sag: true }, { ad: '7 gün tahmini', sag: true },
              { ad: 'Gözlem', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={[...tahminler]
              .sort((a, b) => sayi(b.ort_gunluk_tuketim) - sayi(a.ort_gunluk_tuketim))
              .slice(0, 40)
              .map((x, i) => ({
                id: x.urun_ad || `th-${i}`,
                hucreler: [
                  { v: x.urun_ad || '—', kalin: true },
                  { v: x.ort_gunluk_tuketim != null ? String(Math.round(sayi(x.ort_gunluk_tuketim) * 10) / 10) : '—', mono: true, sag: true },
                  { v: x.tahmin_7gun != null ? String(Math.round(sayi(x.tahmin_7gun))) : '—', mono: true, sag: true, kalin: true },
                  { v: `${sayi(x.gozlem_gun)} gün`, mono: true, sag: true, renk: R.not },
                  sayi(x.gozlem_gun) >= 10
                    ? { v: 'güvenilir', rozet: R.yesil }
                    : { v: 'az gözlem', rozet: R.amber },
                ],
              }))}
          />
        ) : <BosDurum metin="Stok tahmini için yeterli tüketim verisi yok." />)}

        {tsSekme === 'kpi' && (kpilar.length ? (
          <Tablo
            baslik={`KPI değişimi · ${tsKpi?.donem || 'ay'} (${sayi(tsKpi?.gun)} gün)`}
            not="önceki dönemle karşılaştırma — yön motor tarafından belirlenir"
            kolonlar={[{ ad: 'Gösterge' }, { ad: 'Şimdi', sag: true }, { ad: 'Önceki', sag: true }, { ad: 'Değişim', sag: true }, { ad: 'Yön' }]}
            satirlar={kpilar.map((k, i) => ({
              id: k.anahtar || `kp-${i}`,
              hucreler: [
                { v: k.etiket || k.anahtar || '—', kalin: true },
                { v: fmt(sayi(k.simdi)), mono: true, sag: true, kalin: true },
                { v: fmt(sayi(k.onceki)), mono: true, sag: true, renk: R.not },
                {
                  v: `${sayi(k.delta_pct) > 0 ? '+' : ''}${trSayi(sayi(k.delta_pct), 1)}%`,
                  mono: true, sag: true,
                  renk: k.yon === 'iyi' ? R.yesil : k.yon === 'kotu' ? R.kirmizi : R.not,
                },
                k.yon === 'iyi'
                  ? { v: 'iyileşti', rozet: R.yesil }
                  : k.yon === 'kotu' ? { v: 'kötüleşti', rozet: R.kirmizi } : { v: 'nötr', rozet: R.not },
              ],
            }))}
          />
        ) : <BosDurum metin="KPI karşılaştırma verisi yok." />)}
      </>
    );
  }

  // ── KONTROL KULESİ BİRLEŞTİ (2026-07-30, sahip kararı) ────────────────────
  // Tasarımın "tek varlık → tek ekran" kuralı: şubeyi iki ayrı tablo listeliyordu.
  // Kulenin ŞUBE tablosu Panel ▸ Şube Karnesi'ne operasyonel kolon olarak girdi;
  // hız duyusu Sipariş Akışı'na taşındı. Kule görünümü menüden kalktı ama
  // KODU DURUYOR — eski adres gelirse akışa yönlenir, iş durmaz.
  if (gorunum === 'kule') { onGorunum?.('akis'); return null; }

  if (gorunum === '__kule_arsiv') {
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
        {hizSeridi}
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
