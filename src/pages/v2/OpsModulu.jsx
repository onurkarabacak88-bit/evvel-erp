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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// ══════════════════════════════════════════════════════════════════════════
// İŞ GÜNÜ ≠ TAKVİM GÜNÜ — 2026-08-27, sunucudan ölçüldü
// ══════════════════════════════════════════════════════════════════════════
// Bu ekranların "bugün"ü tarayıcı takviminden türüyordu. Ama sunucu iş gününü
// 06:00'da başlatıyor: /ops/stok-kayip-analiz yanıtında `is_gunu_siniri_saat:
// 6`. Yani gece 00:00–05:59 arasında takvim yeni güne geçmiş olsa da sistem
// hâlâ ÖNCEKİ iş gününü sayıyor.
// Sahip için sonucu: kapanış saatinde (bar gece kapanır) ekranı açtığında
// bomboş bir "bugün" görür ve "kayıt gitmiş mi?" diye düşünür — oysa kayıtlar
// hâlâ dünün gününde durmaktadır.
// ⚠️ SINIR UYDURULMUYOR: sunucu söylediğinde onun değeri kullanılır
// (`isGunuSiniriRef`), söylemediğinde 6 varsayılır ve bu ekranda YAZILIR.
// ⚠️ `bugunYerelISO` OLDUĞU GİBİ DURUYOR — "takvim günü" gereken yerler var
// (ileri gitmeyi durduran sınır gibi). İki kavram artık iki ayrı ad.
let _IS_GUNU_SINIRI = 6;
export const isGunuSiniriAyarla = (saat) => {
  if (Number.isFinite(Number(saat))) _IS_GUNU_SINIRI = Number(saat);
};
const isGunuBugun = () => {
  const d = new Date();
  if (d.getHours() < _IS_GUNU_SINIRI) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Takvim günü ile iş günü ayrıştığı an (gece penceresi) — ekran bunu söyler.
const isGunuKaymasiVar = () => isGunuBugun() !== bugunYerelISO();

// ══════════════════════════════════════════════════════════════════════════
// İŞ KUYRUĞU KURUCUSU — tek yordam, iki çağıran
// ══════════════════════════════════════════════════════════════════════════
// Hem ekran (sıralamayı çizmek için) hem de değişim ölçümü (dünle kıyaslamak
// için) AYNI kuyruğu görmeli. İki yerde ayrı ayrı kurulsaydı bir gün ayrışır
// ve "yeni gelen iş" sayısı ekrandakiyle tutmazdı.
const opsGunFarki = (t, bugunISO) => {
  if (!t) return null;
  const d = new Date(String(t).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((new Date(bugunISO + 'T00:00:00Z') - d) / 86400000);
};
export const opsKuyrukKur = (satirlar, bugunISO) => {
  const L = Array.isArray(satirlar) ? satirlar : [];
  const say = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const m = (x, sinif, baslik, aciklama) => ({
    sinif, baslik, aciklama, _s: x,
    yas: opsGunFarki(x.tarih, bugunISO),
    anahtar: `${sinif}|${x.id}`,
  });
  // ⚠️ AYNI KELİME FARKLI ARİTMETİK (canlı yürüyüşte yakalandı, 2026-08-28):
  // `kalem_sayisi` alanı KALEM ÇEŞİDİ DEĞİL, TOPLAM ADET'tir. Kuyruk bu alanı
  // "kalem" diye yazınca aynı sipariş ekranda iki farklı sayıyla görünüyordu:
  // kuyruk "1894 kalem", kanban/modal/çekmece "32 kalem · 1894 adet".
  // Çeşit = kalemler dizisinin uzunluğu; adet = kalem_sayisi.
  const cesit = (x) => (Array.isArray(x.kalemler) ? x.kalemler.length : null);
  const yuk = (x) => {
    const c = cesit(x);
    return c != null ? `${c} kalem · ${say(x.kalem_sayisi)} adet` : `${say(x.kalem_sayisi)} adet`;
  };
  return [
    ...L.filter((x) => x.asama === 'uyumsuzluk').map((x) => m(
      x, 1, `${x.sube_adi || 'Şube'} · kabul uyuşmazlığı`,
      'şube teslim aldı ama adet tutmadı — merkez kararı gerekiyor')),
    ...L.filter((x) => x.asama === 'bekliyor').map((x) => m(
      x, 2, `${x.sube_adi || 'Şube'} · depoya yönlendirilmedi`,
      `${yuk(x)} · merkez kuyruğunda`)),
    ...L.filter((x) => x.asama === 'depoda').map((x) => m(
      x, 2, `${x.sube_adi || 'Şube'} · depoda hazırlanıyor`,
      `${yuk(x)} · sevk bekliyor`)),
    // ⚠️ YANLIŞ TARAFI SUÇLAMA (canlı yürüyüşte yakalandı, 2026-08-28):
    // 'yolda' ile 'toptanci_bekliyor' AYNI cümleye konmuştu — ikisine birden
    // "şube kabulü gecikti · N gündür yolda" yazılıyordu. Oysa toptancı
    // siparişi HİÇ YOLA ÇIKMAMIŞTIR: mal toptancıdan gelmemiştir, şubenin
    // kabul edeceği bir şey yoktur. Sahip 10 gündür şubeyi suçlu sanıyordu.
    // Canlı ölçüm: 7 sipariş 5–10 gündür toptancıda, 6'sı TEMA.
    ...L.filter((x) => x.asama === 'yolda')
      .filter((x) => (opsGunFarki(x.tarih, bugunISO) ?? 0) >= 2)
      .map((x) => m(
        x, 3, `${x.sube_adi || 'Şube'} · şube kabulü gecikti`,
        `${opsGunFarki(x.tarih, bugunISO)} gündür yolda · ${yuk(x)}`)),
    ...L.filter((x) => x.asama === 'toptanci_bekliyor')
      .filter((x) => (opsGunFarki(x.tarih, bugunISO) ?? 0) >= 2)
      .map((x) => m(
        x, 3, `${x.sube_adi || 'Şube'} · toptancıdan mal gelmedi`,
        `${opsGunFarki(x.tarih, bugunISO)} gündür toptancıda · ${yuk(x)} · şube değil TEDARİKÇİ bekleniyor`)),
  ].sort((a, b) => (a.sinif - b.sinif) || ((b.yas ?? 0) - (a.yas ?? 0)));
};

// ── DEĞİŞİM TABANI ────────────────────────────────────────────────────────
// ⚠️ İKİ KAYIT: {bugun, onceki}. Tek kayıt tutulsaydı aynı gün ikinci kez
// açıldığında taban bugüne eşitlenir, delta 0 çıkar ve ekran "değişmedi"
// YALANI söylerdi (BAKIŞ'ta yaşanan tuzak).
const OPS_KUYRUK_ANAHTAR = 'evvelOpsKuyruk';
const opsTabanOku = () => {
  try {
    const h = localStorage.getItem(OPS_KUYRUK_ANAHTAR);
    return h ? JSON.parse(h) : null;
  } catch { return null; }
};
const opsTabanYaz = (bugunISO, anahtarlar) => {
  try {
    const k = opsTabanOku();
    if (k && k.bugun && k.bugun.tarih === bugunISO) return;   // aynı gün: kaydırma
    localStorage.setItem(OPS_KUYRUK_ANAHTAR, JSON.stringify({
      bugun: { tarih: bugunISO, anahtarlar },
      onceki: k?.bugun || null,
    }));
  } catch { /* depolama kapalı olabilir — ölçüm yoksa ekran yine çalışır */ }
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
    // 🔵 EVV-OPS2-N4 (2026-08-13): source-of-truth money rewrite — girilen alanlar
    // sayısal + negatif-değil olmalıydı (eskiden yalnız "alan var mı" bakılıyordu).
    for (const [ad, v] of [['nakit', p.yeni_nakit], ['POS', p.yeni_pos], ['online', p.yeni_online]]) {
      if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) return `${ad} değeri geçersiz — 0 veya pozitif sayı girin.`;
    }
  }
  if (sebep === 'acilis_yanlis') {
    if (p.yeni_acilis_kasa == null || !Number.isFinite(Number(p.yeni_acilis_kasa)) || Number(p.yeni_acilis_kasa) < 0) {
      return 'Yeni açılış kasa sayımı (₺) zorunlu — 0 veya pozitif sayı girin.';
    }
  }
  if (sebep === 'devir_yanlis') {
    if (p.yeni_teslim == null && p.yeni_devir == null) return 'Teslim veya devir alanından en az birini girin.';
    // 🔵 EVV-OPS2-N4: sayısal + negatif-değil (money-rewrite).
    for (const [ad, v] of [['teslim', p.yeni_teslim], ['devir', p.yeni_devir]]) {
      if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) return `${ad} değeri geçersiz — 0 veya pozitif sayı girin.`;
    }
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
  // Kuyruk değişimi: dünkü kuyrukla bugünkünü karşılaştır (BAKIŞ hamlesi 3).
  const [kuyrukDegisim, setKuyrukDegisim] = useState(null);
  // 📊 ÖLÇÜM (BAKIŞ hamlesi 7): kuyruk gerçekten iş ürettirdi mi, yoksa yeni
  // bir duvar kâğıdı mı oldu? Bir tasarım değişikliği kendi başarısını ilan
  // edemez. Oturum kimliği burada tutulur; ilk anlamlı eylemde bildirilir.
  const olcumOturumRef = useRef(null);
  const olcumEylemRef = useRef(false);
  const olcumEylem = (tur) => {
    if (olcumEylemRef.current || !olcumOturumRef.current) return;
    olcumEylemRef.current = true;
    // Hata yutar: ölçüm yazılamazsa ekran hiç etkilenmez.
    api('/ops-olcum/eylem', { method: 'POST', body: { oturum_id: olcumOturumRef.current, tur } })
      .catch(() => {});
  };
  // talep_id → /ops/v2/bekleyen-siparisler zenginleştirmesi (uyarı + stok kararı)
  const [bekZengin, setBekZengin] = useState({});
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
  // /ops/tedarikci-guvenilirlik — çok-şube tedarikçi paterni (ham olay ≠ patern)
  const [uzTedarikci, setUzTedarikci] = useState([]);
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
    if (fdMesgul) return;   // 🔁 (2026-08-12) çift-tık erken-çıkış: buton-disable React
    // commit etmeden 2. tık ateşlenmesin (backend fark-defteri atomik claim'li ama UX+savunma).
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
      // ÇOK-ŞUBE TEDARİKÇİ PATERNİ — v2 bu ucu HİÇ çağırmıyordu. Sevkiyat
      // uyumsuzluğu listesi HAM olayları gösteriyor; bu uç aynı tedarikçinin
      // FARKLI ŞUBELERDE tekrar edip etmediğini söylüyor. Ayrım kritik:
      // ≥2 şube → tedarikçi paterni (şube masum) · tek şube → belirsiz.
      api('/ops/tedarikci-guvenilirlik?gun=60').catch(() => null),
      api('/ops/personel-vardiya-uyumsuzluk').catch(() => null),
      api('/ciro-taslak/fark-defteri?gun=45').catch(() => null),
      api('/ops/v2/siparis-akis?limit=200').catch(() => null),
    // ⚠️ Sıra Promise.all ile BİREBİR — tedarikçi paterni 3. sıraya eklendi
    ]).then(([sv, ks, tg, pr, fd, ak]) => {
      // 🔵 (2026-08-12, Ops denetimi) FAKE-GREEN: KRİTİK mutabakat okumaları (kasa
      // uyumsuzluk / ciro fark) DÜŞERSE boş={}→"temiz/0" render edip çözülmemiş
      // uyumsuzlukları GİZLİYORDU. Kritik null → açık hata banner'ı (yenile), sahte
      // sakinlik yok. Yardımcı okumalar (sevkiyat paterni/tedarikçi) null tolere edilir.
      // ⚠️ YARIM GUARD KAPANDI (Codex, 2026-08-27 — bu projede 7. kez):
      // Bir önceki tur kasa/ciro okumalarını banner'a çıkarmış ama SEVKİYAT
      // UYUMSUZLUKLARI'nı "yardımcı okuma" sayıp `sv || {satirlar:[]}` ile
      // sessizce boşaltıyordu. Oysa bu ekranın ADI Uzlaştırma; sevkiyat
      // uyumsuzluğu listesi burada yardımcı değil, MASANIN KENDİSİDİR.
      // Uç düşerse ekran "uyumsuzluk yok" der — çözülmemiş fark gizlenir.
      // Aynı gerekçe tahsis akışı (`ak`) için de geçerli: talep≠tahsis
      // satırları oradan türer; düşerse tahsis farkı yokmuş gibi görünür.
      const _dusen = [
        ks == null ? 'kasa uyumsuzluk' : null,
        fd == null ? 'ciro fark defteri' : null,
        sv == null ? 'sevkiyat uyumsuzlukları' : null,
        ak == null ? 'sipariş/tahsis akışı' : null,
        // ⚠️ Fable: personel-vardiya da bu masanın ÇÖZÜLEBİLİR bir kalemi
        // (uzUygula tip:'personel'). Onu "yardımcı okuma" sayıp sessizce
        // boşaltmak, yarım guard'ın devamıydı.
        pr == null ? 'personel-vardiya uyumsuzluğu' : null,
      ].filter(Boolean);
      if (_dusen.length) {
        setUzHata(`Mutabakat verisi yüklenemedi (${_dusen.join(' · ')}) — `
                  + '"temiz" görünüm EKSİK olabilir, çözülmemiş uyumsuzluk gizlenmiş olabilir. Yenileyin.');
        return;
      }
      setUzSevk(sv || { satirlar: [] });
      setUzKasa(ks || {});
      setUzTedarikci(Array.isArray(tg?.tedarikciler) ? tg.tedarikciler : []);
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
    if (ktMesgul) return;   // 🔵 EVV-OPS3-F (2026-08-13) çift-tık: mükerrer katalog yazma önle
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
        // 🔵 EVV-OPS2-N1 (2026-08-13): eskiden yalnız non-finite reddediliyordu → NEGATİF
        // birim fiyat geçip stok-değeri/marj KPI'larını ters çeviriyordu. Negatifi de reddet.
        if (f !== '' && (!Number.isFinite(Number(f)) || Number(f) < 0)) { onToast?.('Geçerli bir fiyat girin (negatif olamaz)'); setKtMesgul(false); return; }
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
    if (uzMesgul) return;   // 🔁 (2026-08-12) çift-tık erken-çıkış guard
    // 💵 (2026-08-12) client-trust: girilen tutar/adet BOŞ değilse ama geçersizse
    // sayi() sessizce 0'a düşürüp yanlış (0 TL/0 adet) uzlaştırma yazıyordu. Doğrula.
    const _adetHam = String(m.adet ?? '').trim();
    if (_adetHam !== '' && !(sayi(_adetHam) > 0) && (m.tip === 'kasa' || m.tip === 'sevkiyat' || m.tip === 'tahsis')) {
      onToast?.('Girilen tutar/adet geçersiz — sayı girin (ondalık için nokta)'); return;
    }
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
  // /ops/v2/depo-ozet → ozet bloğu: stok TL değeri + 30 gün harcama + şube başı
  const [depoDeger, setDepoDeger] = useState(null);
  const [stokDevir, setStokDevir] = useState(null);   // /ops/metrics/stok-devir
  const [depoHata, setDepoHata] = useState('');
  const [depoSube, setDepoSube] = useState('');   // '' = tüm şubeler
  // ── YERLİ DEPO YÖNLENDİRME (köprü kaldırma turu, 2026-07-29) ──────────────
  // Bekleyen sipariş → hedef depo ataması artık kadife modal; aynı guard'lı uç:
  // POST /ops/siparis/sevkiyata-gonder. Toptancı akışı (liste+yazdırma) klasik
  // kulede kalır — modaldan köprü verilir (işlev kaybı yasak).
  const [yonForm, setYonForm] = useState(null);   // {sip, mod:'depo'|'toptanci', depo, talimat, tedarikciId, secili:Set, not}
  const [depolar, setDepolar] = useState([]);
  const [yonMesgul, setYonMesgul] = useState(false);
  // ⛔ Kalem bazında merkez iptali — {sip, kalem, gerekce}
  const [kalemIptal, setKalemIptal] = useState(null);
  const [kalemIptalMesgul, setKalemIptalMesgul] = useState(false);
  const [tedarikciler, setTedarikciler] = useState([]);
  // ── BAR AKIŞI (ops-merkez P0 sekmeleri, 2026-07-30) ───────────────────────
  // Klasik Operasyon Merkezi'nin 5 sekmesi (açılış kasa takip · kapanış takip ·
  // ürün-aç akışı · kullanılan ürünler) tek kadife görünümde alt-sekmeli.
  const [barSekme, setBarSekme] = useState('acilis');
  const [barTarih, setBarTarih] = useState(() => isGunuBugun());
  const [acilisTakip, setAcilisTakip] = useState(null);
  // /ops/gec-acilan-subeler — "saatinde mi açıldı" (kasa tuttu mu'dan AYRI soru)
  const [gecAcilis, setGecAcilis] = useState(null);
  const [kapanisTakip, setKapanisTakip] = useState(null);
  const [urunAcAkis, setUrunAcAkis] = useState(null);
  const [barOzet, setBarOzet] = useState(null);
  const [barHata, setBarHata] = useState('');
  // Sahip kararı (2026-08-03, soru 7/9): /ops/sayimlar — açılış satırına
  // tıklayınca HAM sabah sayımı çekmecesi (kim, saat kaçta, kalem kalem ne
  // saydı). Tablo TL özetini gösterir; bu uç arkasındaki fiziki sayımdır.
  // Tıklama anında çekilir, tarih başına önbelleğe alınır.
  const [barSayimCache, setBarSayimCache] = useState({});   // tarih → satirlar[]
  // ── MERKEZ DENETİM (ops-merkez P1 sekmeleri, 2026-07-30) ──────────────────
  // urun-uyumsuzluk · fire-bildirim · gider fişi · kontrol özeti · stok kaybı
  const [dnSekme, setDnSekme] = useState('uyumsuz');
  const [dnUyumsuz, setDnUyumsuz] = useState(null);
  const [dnFire, setDnFire] = useState(null);
  const [dnFis, setDnFis] = useState(null);
  const [dnKontrol, setDnKontrol] = useState(null);
  // /ops/metrics/sube-operasyon-kalite — vardiya devri eksik tik oranı + trend
  const [opKalite, setOpKalite] = useState(null);
  // Sahip kararı (2026-08-03, soru 6/9): /ops/personel-metrik-sube — personel
  // verimlilik ikizinin ŞUBE kırılımı (açılış sapması + kontrol cevabı şube
  // bazında). Kişi kırılımı EKİP ▸ Personel Denetimi'nde; burada şube boyutu.
  const [opPersonelSube, setOpPersonelSube] = useState(null);
  const [dnKayip, setDnKayip] = useState(null);
  const [dnHata, setDnHata] = useState('');
  // ── TEDARİK & SİNYAL (ops-merkez P3 sekmeleri, 2026-07-30) ────────────────
  // toptancıdan gelenler · şube notları · stok tahmini · KPI delta
  const [tsSekme, setTsSekme] = useState('teslim');
  // /ops/siparis/toptanci-listesi — toptancıya GİDEN yönlendirme logu
  const [tsGiden, setTsGiden] = useState(null);
  const [tsTeslim, setTsTeslim] = useState(null);
  const [tsNotlar, setTsNotlar] = useState(null);
  const [tsTahmin, setTsTahmin] = useState(null);
  const [tsKpi, setTsKpi] = useState(null);
  const [siparisOneri, setSiparisOneri] = useState(null);   // /ops/siparis/oneri
  const [oneriKova, setOneriKova] = useState('acil');       // acil | yakin | fazla
  const [tsHata, setTsHata] = useState('');
  // 🔎 ÜRÜN GELİŞ GEÇMİŞİ (2026-08-16, sahip: "vanilya milkshake geliş tarihleri…
  // bunu takip edebilecek bir sistem kurmalıyız"). Yerleşim denetçisi hükmü:
  // 'teslim' sekmesi (Toptancıdan gelen) aynı kavramın 14-günlük özeti — bu
  // sekme onun ürün-bazlı derin arama hâli. Kaynak: /ops/urun-gelis-gecmisi
  // (toptanci_siparis kabulleri; ŞUBELER ARASI SEVKİYAT DAHİL DEĞİL).
  const [ugSorgu, setUgSorgu] = useState('');
  const [ugVeri, setUgVeri] = useState(null);     // null=hiç aranmadı
  const [ugHata, setUgHata] = useState('');
  const [ugMesgul, setUgMesgul] = useState(false);
  // 🗂 YAZDIKÇA ÖNERİ (sahip: "esp yazdığımda altta çıksın, tıklayınca tarihçe —
  // Mehmet Atalay mantığı"). Katalog (depo stok kalemleri, ~140 ad) sekme ilk
  // açıldığında BİR KEZ çekilir; süzme ekranda. Vanilya Şurup/Vanilya Toz
  // karışıklığının aşısı: kullanıcı serbest metinle değil KATALOG ADIYLA arar.
  // Katalog çekilemezse öneri çıkmaz ama serbest arama ÇALIŞMAYA DEVAM EDER
  // ([] işaretlenir; boş katalog "öneri yok" demek, arama kapısı değil).
  const [ugKatalog, setUgKatalog] = useState(null);
  // Boş katalog ("öneri yok") ile okunamayan katalog ("bakamadım") ayrı
  // durumlardır; tek bir `[]` ikisini de temsil edemez.
  const [ugKatalogHata, setUgKatalogHata] = useState('');
  // Ciro farkı sekmesinde karara bağlanmış kayıtları göster/gizle — kuyruk
  // sade kalsın ama "kararı geri al" yolu erişilebilir olsun.
  const [fdCozulmusGoster, setFdCozulmusGoster] = useState(false);
  const [ugListeAcik, setUgListeAcik] = useState(false);
  useEffect(() => {
    // ══════════════════════════════════════════════════════════════════
    // 🔴 YORUM DÜZELTMEYİ ANLATIYORDU, KOD ESKİ HÂLİNDEYDİ (Fable, 2026-08-27)
    // ══════════════════════════════════════════════════════════════════
    // Bir önceki turda buraya "artık hata ayrı işaretlenir, yeniden
    // denenebilir" diye bir yorum yazdım — ama KODU DEĞİŞTİRMEDİM. Koşul
    // hâlâ `ugKatalog == null`, catch hâlâ `setUgKatalog([])` idi. Yani
    // geçici bir ağ hatası oturum boyu "öneri yok" ekranına dönüşmeye devam
    // ediyordu ve yorum bunu KAPANMIŞ gösteriyordu.
    // ⚠️ Bu, kusurların en aldatıcısıdır: sonraki denetçi (insan ya da makine)
    // yorumu okuyup "burası halledilmiş" diye geçer. Kod yalan söylemez ama
    // YORUM SÖYLEYEBİLİR.
    // Şimdi gerçekten kuruldu: hata `ugKatalogHata` ile ayrı tutulur, boş
    // katalog ile okunamayan katalog karışmaz, tekrar denenebilir.
    if (gorunum === 'tedarik' && tsSekme === 'urungelis' && ugKatalog == null && !ugKatalogHata) {
      api('/ops/maliyet/stok-kalemleri')
        .then((d) => setUgKatalog(
          (Array.isArray(d?.kalemler) ? d.kalemler : [])
            .map((k) => {
              // Katalogda kalem_kodu çoğunlukla UUID — ekranda gürültü.
              // Yalnız İNSAN kodu göster (kısa, tire-siz "ESP01" gibi).
              const hamKod = String(k.kalem_kodu || '').trim();
              const insanKod = hamKod && hamKod.length <= 12 && !/^[0-9a-f-]{16,}$/i.test(hamKod) ? hamKod : '';
              return { ad: String(k.kalem_adi || '').trim(), kod: insanKod };
            })
            .filter((k) => k.ad),
        ))
        .catch((e) => setUgKatalogHata(e?.message || 'Ürün kataloğu okunamadı'));
    }
  }, [gorunum, tsSekme, ugKatalog, ugKatalogHata]);
  // Türkçe-I tuzağı: 'I'.toLowerCase()='i' ASCII'de ama 'ESPRESSO'
  // aramasında İ/ı ayrımı şaşar — tr-TR locale ile küçült.
  const ugKucuk = (s) => String(s || '').toLocaleLowerCase('tr-TR');
  const ugAra = async (q) => {
    const s = String(q ?? ugSorgu).trim();
    if (s.length < 2) { onToast?.('Ürün adı en az 2 harf olmalı.'); return; }
    if (ugMesgul) return;
    setUgListeAcik(false);
    setUgMesgul(true); setUgHata('');
    try {
      setUgVeri(await api(`/ops/urun-gelis-gecmisi?urun=${encodeURIComponent(s)}&gun=365`));
    } catch (e) {
      // HATA ≠ BOŞ: eski sonucu temizle ki bayat veri "cevap" gibi durmasın.
      setUgVeri(null); setUgHata(e?.message || 'Geliş geçmişi alınamadı');
    } finally { setUgMesgul(false); }
  };
  // ── SAYIM ─────────────────────────────────────────────────────────────────
  const [sayim, setSayim] = useState(null);
  const [sayimIz, setSayimIz] = useState(null);
  const [sayimHata, setSayimHata] = useState('');
  const [sayimAcikId, setSayimAcikId] = useState('');
  const [sayimDetay, setSayimDetay] = useState({});   // gorev_id → detay (kalem farkları)
  // ── HAREKET ───────────────────────────────────────────────────────────────
  const [hareket, setHareket] = useState(null);
  // ── SİPARİŞ ARŞİVİ (sahip kararı: ayrı görünüm) ───────────────────────────
  // /ops/siparis/gecmis (tüm durumlar, 730 güne dek) + /ops/siparis/
  // depo-sevkiyat-raporlari (rapor metni tarihçesi). Kanban 14 günlük AÇIK işi
  // gösterir; kapanan sipariş pencereden çıkınca kayboluyordu.
  const [arsivVeri, setArsivVeri] = useState(null);
  const [arsivRapor, setArsivRapor] = useState(null);
  const [arsivHata, setArsivHata] = useState('');
  const [arsivGun, setArsivGun] = useState(90);
  const [arsivDurum, setArsivDurum] = useState('');
  const [arsivArama, setArsivArama] = useState('');
  const [arsivSekme, setArsivSekme] = useState('siparis');
  const [arsivMesgul, setArsivMesgul] = useState('');
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
    // BEKLEYEN SİPARİŞ ZENGİNLEŞTİRMESİ (/ops/v2/bekleyen-siparisler) — v2 için
    // yazılmış ama hiç bağlanmamıştı. Kanban kartı "kaç kalem" diyordu; bu uç
    // KARAR İÇİN GEREKEN üç şeyi ekliyor: şube zaten var mı (gereksiz sipariş),
    // gönderirsek merkezde ne kalır (barem riski), davranış uyarısı var mı.
    // 🔵 EVV-OPS3-F (2026-08-13): kanban kontrol-kulesi gun=14 yükleniyor ama bekleyen
    // zenginleştirme gun=7'ydi → 8-14 gün yaşındaki açık siparişler board'da görünüp
    // stok/davranış/risk bağlamını kaybediyordu. 14'e hizalandı.
    api('/ops/v2/bekleyen-siparisler?gun=14')
      .then((d) => {
        const m = {};
        (Array.isArray(d?.siparisler) ? d.siparisler : []).forEach((s) => { m[String(s.id)] = s; });
        setBekZengin(m);
      })
      .catch(() => setBekZengin({}));
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
      // ⚠️ falsy-zero: sunucu meşru 0 derse `||` bunu "yok" sanıp seçilen
      // adedi yazıyordu — birleşmeyen işlem birleşmiş gibi bildiriliyordu.
      onToast?.(`${r?.birlesik_talep_sayisi != null ? sayi(r.birlesik_talep_sayisi) : idler.length} sipariş tek siparişe indi — ${sayi(r?.kalem_sayisi)} kalem · yeni #${String(r?.yeni_talep_id || '').slice(-8)}`);
      birlTemizle();
      kuleYukle();
    } catch (e) {
      onToast?.(e?.message || 'Birleştirme başarısız');
    } finally {
      setBirlMesgul(false);
    }
  };

  // ⚠️ BAYAT CEVAP (Codex P0, 2026-08-27): tarih hızlı değiştirildiğinde
  // ESKİ isteğin geç dönen cevabı YENİ tarihin ekranını eziyordu. Sahip
  // "27 Ağustos" yazan ekranda 26 Ağustos'un rakamlarını görebilirdi — ve
  // bunu anlamasının hiçbir yolu yoktu. Her yükleme bir sıra numarası alır;
  // yalnız EN SON başlatılan yükleme state yazabilir.
  const barIstekRef = useRef(0);
  // 🔢 SEVKİYAT UYUMSUZLUĞU — TEK OKUMA NOKTASI
  // Alan adı sunucuda `sevk_adet`. Eski adlar emniyet ağı olarak duruyor ama
  // ARTIK SESSİZ DEĞİL: hiçbiri yoksa null döner ve ekran "—" yazar (0 yazmaz).
  // "Gönderilmedi" ile "okunamadı" aynı görüntüye düşemez.
  const uzSevkAdet = (r) => {
    const v = r?.sevk_adet ?? r?.gonderilen_adet ?? r?.gonderilen;
    return v == null ? null : sayi(v);
  };
  const uzKabulAdet = (r) => {
    const v = r?.kabul_adet ?? r?.kabul_edilen;
    return v == null ? null : sayi(v);
  };
  // Fark SUNUCUNUN alanıdır; ekran kendi aritmetiğini kurmaz. Sunucu vermezse
  // (ve iki uç da okunabiliyorsa) türetilir ve türetildiği belli olur.
  const uzFarkAdet = (r) => {
    if (r?.fark_adet != null) return sayi(r.fark_adet);
    const g = uzSevkAdet(r); const k = uzKabulAdet(r);
    return (g == null || k == null) ? null : g - k;
  };

  const barYukle = useCallback((tarih) => {
    setBarHata('');
    const t = tarih || isGunuBugun();
    const _bilet = ++barIstekRef.current;
    const _guncel = () => barIstekRef.current === _bilet;
    api(`/ops/acilis-kasa-takip?tarih=${t}`)
      .then((d) => { if (_guncel()) setAcilisTakip(d || {}); })
      .catch((e) => { if (_guncel()) setBarHata(e?.message || ''); });
    api(`/ops/kapanis-takip?tarih=${t}`)
      .then((d) => { if (_guncel()) setKapanisTakip(d || {}); })
      // 🔵 (2026-08-12) FAKE-GREEN: kapanış takip (kasa kapanış = para) DÜŞÜNCE {}'e
      // yutulup "denklem tutuyor/0" gibi render ediliyordu. Hata banner'ına yüzeye çıkar.
      .catch((e) => { if (_guncel()) setBarHata(e?.message || 'Kapanış takip verisi yüklenemedi — yenileyin.'); });
    // GEÇ AÇILAN ŞUBELER (/ops/gec-acilan-subeler) — v2 bu ucu HİÇ çağırmıyordu.
    // /ops/acilis-kasa-takip "açıldı mı + kasa tuttu mu" der; bu uç "SAATİNDE
    // mi açıldı" der. Üç ayrı liste: geç açılan · açılış başlamış ama
    // TAMAMLANMAMIŞ · o gün hiç ACILIS kaydı OLUŞMAMIŞ (panel/motor çalışmamış).
    api(`/ops/gec-acilan-subeler?tarih=${t}`)
      .then((d) => { if (_guncel()) setGecAcilis(d || null); })
      .catch(() => { if (_guncel()) setGecAcilis(null); });
    api(`/ops/v2/urun-ac-akis?tarih=${t}`)
      .then((d) => { if (_guncel()) setUrunAcAkis(d || {}); })
      .catch(() => { if (_guncel()) setUrunAcAkis({}); });
    // ⚠️ Bar özeti GÜN ODAKLI çekilir. İki sebep (ikisi de sunucu sözleşmesi):
    // 1) `gun` verilmezse uç evo_* alanlarını HİÇ doldurmaz (operasyon_merkez_api
    //    :4127 — Evo karşılaştırması yalnız tek-gün sorgusunda yapılır).
    // 2) `year_month` verilmezse sunucu İÇİNDE BULUNULAN ayı varsayar
    //    (_coerce_year_month:758). Geçmiş bir güne bakınca ay filtresi ile gün
    //    filtresi çelişip boş dönüyordu → ekran sessizce "kayıt yok" diyordu.
    // O güne ait kayıt yoksa aylık listeye düşülür (eski davranış korunur).
    api(`/ops/bar-ozet?gun=${t}&year_month=${t.slice(0, 7)}&limit=60`)
      .then((d) => {
        if (!_guncel()) return null;
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

  /**
   * HAM SABAH SAYIMI çekmecesi (soru 7/9) — /ops/sayimlar.
   * Açılış tablosu TL özetini gösterir ("sayılan 4.200 ₺"); bu uç o TL'nin
   * ARKASINDAKİ fiziki sayımı verir: kim saydı, saat kaçta, kalem kalem adet.
   * Sıfır kalemler gizlenir — sayım formunda boş bırakılan alan "0 saydı"
   * demek değildir, o yüzden yalnız girilenler listelenir.
   */
  const barSayimAc = async (x) => {
    const t = barTarih;
    let liste = barSayimCache[t];
    if (!liste) {
      try {
        const d = await api(`/ops/sayimlar?gun=${t}&year_month=${t.slice(0, 7)}&limit=60`);
        liste = Array.isArray(d?.satirlar) ? d.satirlar : [];
        setBarSayimCache((c) => ({ ...c, [t]: liste }));
      } catch (e) {
        onToast?.(e?.message || 'Sayım kaydı okunamadı');
        return;
      }
    }
    const kayit = liste.find((s) => String(s.sube_id) === String(x.sube_id))
      || liste.find((s) => (s.sube_adi || '').toLocaleLowerCase('tr') === (x.sube_adi || '').toLocaleLowerCase('tr'))
      || null;
    if (!kayit) {
      onToast?.(`${x.sube_adi || 'Şube'} için ${tarihKisa(t)} günü ham sayım kaydı yok.`);
      return;
    }
    const stok = kayit.stok_sayim || {};
    const kalemler = BAR_KALEM
      .map(([k, ad]) => [ad, sayi(stok[k])])
      .filter(([, v]) => v > 0);
    // BAR_KALEM dışındaki anahtarlar (ör. pasta çeşitleri) de gelebilir — atlanmaz.
    const bilinen = new Set(BAR_KALEM.map(([k]) => k));
    const ekstra = Object.entries(stok)
      .filter(([k, v]) => !bilinen.has(k) && sayi(v) > 0)
      .map(([k, v]) => [k.replace(/_/g, ' '), sayi(v)]);
    const tumu = [...kalemler, ...ekstra];
    onCekmece?.({
      tip: 'HAM SABAH SAYIMI',
      baslik: x.sube_adi || 'Şube',
      alt: `${tarihKisa(t)} · ${kayit.personel_ad || 'personel bilinmiyor'}${kayit.bildirim_saati ? ` · ${String(kayit.bildirim_saati).slice(0, 5)}` : ''}`,
      kpi: [
        { etiket: 'Sayan', deger: kayit.personel_ad || '—', renk: kayit.personel_ad ? R.krem : R.not3 },
        { etiket: 'Saat', deger: saatKisa(kayit.cevap_ts) || (kayit.bildirim_saati ? String(kayit.bildirim_saati).slice(0, 5) : '—'), renk: R.krem },
        { etiket: 'Girilen kalem', deger: String(tumu.length), renk: tumu.length ? R.yesil : R.amber },
      ],
      listeBaslik: 'Kalem kalem sabah sayımı',
      satirlar: tumu.length
        ? tumu.map(([ad, v]) => ({ ad, detay: '', tutar: String(v) }))
        : [{ ad: 'Sayım kaydı var ama kalem girilmemiş', detay: 'form boş gönderilmiş olabilir', tutar: '—' }],
      not: 'Bu çekmece fiziki sayımın HAM halidir — tablodaki TL özeti bu sayımdan türetilir. '
        + 'Sıfır görünen kalem listelenmez: boş bırakılan alan "0 saydı" demek değildir.',
    });
  };

  // ⚠️ Fable: bar görünümüne eklenen bayat-cevap koruması denetim görünümüne
  // UYGULANMAMIŞTI. `denetimYukle(barTarih)` tarihle çağrılıyor; tarih hızlı
  // değiştirilirse eski günün ürün-uyumsuzluk/fire cevabı yeni günün ekranını
  // ezebilir. Denetim masasında tarihle rakamın ayrışması, barda olmasından
  // daha tehlikelidir. Aynı bilet mekanizması buraya da kuruldu.
  const dnIstekRef = useRef(0);
  // ⚠️ Yazma RENDER'da değil EFFECT'te: StrictMode render'ı iki kez çalıştırır,
  // taban iki kez kayar ve "dün" bir günde iki adım geriye giderdi.
  useEffect(() => {
    if (!kule) return;
    const bugunISO = isGunuBugun();
    const simdi = opsKuyrukKur(kule.satirlar, bugunISO).map((m) => m.anahtar);
    const taban = opsTabanOku();
    // Kıyas TABANI: bugünün kaydı varsa ONCEKI ile kıyasla (aynı gün ikinci
    // açılışta kendisiyle kıyaslayıp "değişmedi" dememek için).
    const kiyas = (taban?.bugun?.tarih === bugunISO ? taban?.onceki : taban?.bugun) || null;
    if (kiyas && Array.isArray(kiyas.anahtarlar)) {
      const eski = new Set(kiyas.anahtarlar);
      const yeniSet = new Set(simdi);
      setKuyrukDegisim({
        tarih: kiyas.tarih,
        yeni: simdi.filter((k) => !eski.has(k)).length,
        kapanan: kiyas.anahtarlar.filter((k) => !yeniSet.has(k)).length,
      });
    } else {
      setKuyrukDegisim(null);   // taban yoksa uydurma delta YAZILMAZ
    }
    opsTabanYaz(bugunISO, simdi);

    // 📊 Oturum açılışı: o anki kuyruğun anahtarlarını damgala. Yalnız akış
    // görünümünde ve oturumda BİR KEZ — yenileme her seferinde yeni oturum
    // sayılsaydı M2 (eylemsiz oran) paydası şişer, ekran haksız yere
    // "kimse iş yapmıyor" görünürdü (BAKIŞ'ta yaşanan tuzak).
    if (gorunum === 'akis' && olcumOturumRef.current == null) {
      const k = opsKuyrukKur(kule.satirlar, bugunISO);
      api('/ops-olcum/acilis', {
        method: 'POST',
        body: {
          gorunum: 'akis',
          kuyruk: k.map((m) => m.anahtar),
          kuyruk_sinif: k.map((m) => m.sinif),
        },
      }).then((r) => { olcumOturumRef.current = r?.oturum_id || null; }).catch(() => {});
    }
  }, [kule, gorunum]);

  const denetimYukle = useCallback((tarih) => {
    setDnHata('');
    const t = tarih || isGunuBugun();
    const _bilet = ++dnIstekRef.current;
    const _guncel = () => dnIstekRef.current === _bilet;
    api(`/ops/urun-uyumsuzluk?tarih=${t}`)
      .then((d) => { if (_guncel()) setDnUyumsuz(d || {}); })
      .catch((e) => { if (_guncel()) setDnHata(e?.message || ''); });
    api(`/ops/fire-bildirimler?tarih=${t}`)
      .then((d) => { if (_guncel()) setDnFire(d || {}); })
      // ⚠️ HATA != BOŞ: fire okunamazsa "fire yok" DENMEZ.
      .catch((e) => { if (_guncel()) { setDnFire(null); setDnHata((h) => h || (e?.message || 'Fire bildirimleri okunamadı')); } });
    api('/ops/gider-fis-bekleyen?gun=7')
      .then((d) => { if (_guncel()) setDnFis(d || {}); })
      .catch((e) => { if (_guncel()) { setDnFis(null); setDnHata((h) => h || (e?.message || 'Gider fişi listesi okunamadı')); } });
    // ŞUBE OPERASYON KALİTESİ (/ops/metrics/sube-operasyon-kalite) — v2 bu ucu
    // HİÇ çağırmıyordu. Kontrol özeti "kontroller yapıldı mı" der; bu uç
    // VARDİYA DEVRİNİN ne kadar eksik tiklendiğini ölçer — ayrı bir kalite
    // boyutu. Sunucu ayrıca "veri yetersiz" durumunu açıkça bildiriyor.
    api('/ops/metrics/sube-operasyon-kalite?gun=30')
      .then((d) => { if (_guncel()) setOpKalite(d || null); })
      .catch(() => { if (_guncel()) setOpKalite(null); });
    // Personel metriklerinin şube kırılımı (soru 6/9)
    api('/ops/personel-metrik-sube?gun=30')
      .then((d) => { if (_guncel()) setOpPersonelSube(d || null); })
      .catch(() => { if (_guncel()) setOpPersonelSube(null); });
    api('/ops/kontrol-ozet')
      .then((d) => { if (_guncel()) setDnKontrol(d || {}); })
      .catch((e) => { if (_guncel()) { setDnKontrol(null); setDnHata((h) => h || (e?.message || 'Kontrol özeti okunamadı')); } });
    api('/ops/stok-kayip-analiz?gun=45')
      .then((d) => {
        // Sunucu iş günü sınırını KENDİSİ söylüyor — ekran onu varsaymaz,
        // ondan öğrenir (kural iki yerde ayrı ayrı yaşamasın).
        if (d && d.is_gunu_siniri_saat != null) isGunuSiniriAyarla(d.is_gunu_siniri_saat);
        setDnKayip(d || {});
      })
      .catch(() => setDnKayip({}));
  }, []);

  const arsivYukle = useCallback((gun, durum, arama) => {
    setArsivHata('');
    const q = [`gun=${gun || 90}`];
    if (durum) q.push(`durum=${encodeURIComponent(durum)}`);
    if ((arama || '').trim()) q.push(`sube_arama=${encodeURIComponent(arama.trim())}`);
    api(`/ops/siparis/gecmis?${q.join('&')}&limit=300`)
      .then((d) => setArsivVeri(d || null))
      .catch((e) => { setArsivVeri(null); setArsivHata(e?.message || 'Arşiv alınamadı'); });
    // 🔵 EVV-OPS3-F: arşiv görünümü 730 güne dek gidiyor (yorum 688) ama rapor fetch'i
    // 365'e kırpıyordu → 366-730 gün arası siparişler eşleşen depo/sevkiyat raporu olmadan
    // görünüyordu (arşiv toplamı/drill uzlaşmıyordu). 730'a çıkarıldı.
    api(`/ops/siparis/depo-sevkiyat-raporlari?gun=${Math.min(730, gun || 90)}&limit=60`)
      .then((d) => setArsivRapor(Array.isArray(d?.raporlar) ? d.raporlar : []))
      .catch(() => setArsivRapor([]));
  }, []);

  const tedarikYukle = useCallback(() => {
    setTsHata('');
    api('/ops/toptanci-teslimler?gun=14')
      .then((d) => setTsTeslim(d || {}))
      .catch((e) => setTsHata(e?.message || ''));
    // GİDEN yön (/ops/siparis/toptanci-listesi) — v2 bu ucu HİÇ çağırmıyordu.
    // Ekran yalnız GELEN teslimi gösteriyordu; "biz ne yolladık" tarafı yoktu,
    // dolayısıyla "yolladık ama gelmedi" sorusu bu ekranda sorulamıyordu.
    api('/ops/siparis/toptanci-listesi?donem=gun_14&sirala=en_son&limit=200')
      .then((d) => setTsGiden(d || null))
      .catch(() => setTsGiden(null));
    api('/ops/sube-notlar?limit=60')
      .then((d) => setTsNotlar(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setTsNotlar([]));
    api('/ops/stok-tahmin')
      .then((d) => setTsTahmin(d || {}))
      .catch(() => setTsTahmin({}));
    api('/ops/kpi-delta?donem=ay')
      .then((d) => setTsKpi(d || {}))
      .catch(() => setTsKpi({}));
    // 🛒 SİPARİŞ ÖNERİSİ (2026-08-08, sahip isteği): ürün bazında ne alınmalı,
    // neyi ALMAMALI — ürün-aç tüketimi + açılım ritmi + nakit bağlamı.
    api('/ops/siparis/oneri?hedef_gun=21')
      .then((d) => setSiparisOneri(d || null))
      .catch(() => setSiparisOneri(null));
  }, []);

  const yonAc = (sip) => {
    // ⚠️ ÇİFT GÖNDERİM FRENİ (Fable denetimi + canlı yürüyüş, 2026-08-28)
    // Sunucu `kalan_kalemler` alanını ZATEN hesaplıyor: hiçbir yere (ne
    // toptancıya ne depoya) gitmemiş kalemler. Klasik kule bunu 6 yerde
    // kullanıyordu; v2 HİÇBİR yerde kullanmıyordu ve modalı siparişin TÜM
    // kalemleriyle açıyordu. Sonuç: aynı kalem ikinci kez seçilip başka bir
    // toptancıya yollanabiliyordu — iki tedarikçi siparişi, iki WhatsApp,
    // iki fatura. Modal artık yalnız KALANI açar.
    // ⚠️ Kalan boşsa listeye düşülmez: `kalan_kalemler` hiç gelmiyorsa
    //    (eski kayıt / uç değişimi) tüm kalemlere düşer — fren kaybolur ama
    //    ekran çalışır. Gelmiş ve BOŞSA gönderilecek kalem yok demektir.
    const _kalanVar = Array.isArray(sip?.kalan_kalemler);
    const kalemler = _kalanVar ? sip.kalan_kalemler : (Array.isArray(sip?.kalemler) ? sip.kalemler : []);
    if (_kalanVar && kalemler.length === 0) {
      onToast?.('Bu siparişin tüm kalemleri zaten yönlendirilmiş — gönderilecek kalem kalmadı');
      return;
    }
    setYonForm({
      sip, mod: 'depo', depo: '', talimat: '',
      tedarikciId: '', not: '',
      // ⚠️ `sip` yerine KALAN listesi taşınır: modal içindeki her yer
      //    (seçim, yazdırma, gönderim) aynı listeyi görmeli — biri tüm
      //    kalemleri, diğeri kalanı görürse indeksler kayar ve YANLIŞ KALEM
      //    gönderilir.
      kalemListe: kalemler,
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
    // ⚠️ Modalin TASIDIGI liste (kalan kalemler) — `f.sip.kalemler`
    // okunursa indeksler kayar ve YANLIS KALEM gonderilir.
    const hamKalemler = Array.isArray(f.kalemListe) ? f.kalemListe
      : (Array.isArray(f.sip?.kalemler) ? f.sip.kalemler : []);
    const kalemler = hamKalemler.filter((_, i) => f.secili.includes(i));
    if (!kalemler.length) { onToast?.('En az bir kalem seçin'); return; }
    if (yonMesgul) return;   // 🔁 (2026-08-12) çift-tık: mükerrer tedarikçi siparişi/WhatsApp önle
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
    const hamKalemler = Array.isArray(f.kalemListe) ? f.kalemListe
      : (Array.isArray(f.sip?.kalemler) ? f.sip.kalemler : []);
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
    // Depo stoğunun TL DEĞERİ + son 30 gün harcaması — /ops/depo-stok yalnız
    // ADET veriyor. Bu uç (v2 için yazılmış, hiç bağlanmamıştı) parayı ve
    // tüketim hızını ekler: "kaç adet var" ile "kaç lira bağlı" ayrı sorular.
    // A-2. tur: yalnız `ozet` saklanıyordu, `urunler[]` (kalem başına TL +
    // şube kırılımı değeri) çöpe gidiyordu. Artık tamamı saklanır.
    api('/ops/v2/depo-ozet?gun=30')
      .then((d) => setDepoDeger(d || null))
      .catch(() => setDepoDeger(null));
    // STOK DEVİR HIZI (2026-08-08 denetimi): "param kaç gün depoda bekliyor".
    // Depo değeri ve tüketim ayrı ayrı hesaplanıyordu, bölen soru yoktu.
    api('/ops/metrics/stok-devir?gun=30')
      .then((d) => setStokDevir(d || null))
      .catch(() => setStokDevir(null));
  }, []);

  const sayimYukle = useCallback(() => {
    setSayimHata('');
    api('/stok-sayim/bekleyen-onay')
      .then((d) => setSayim(d || {}))
      .catch((e) => setSayimHata(e?.message || ''));
    // ══════════════════════════════════════════════════════════════════════
    // 🔴 KPI'LAR İSTEK SINIRINI YANSITIYORDU — 2026-08-27, canlı ölçüm
    // ══════════════════════════════════════════════════════════════════════
    // Uç, özet sayılarını (ezilen_kalem · karar_sayim · degismeyen) İSTENEN
    // PENCERE üzerinden hesaplıyor. limit=200 ile:
    //     limit 200  → toplam_iz 200 · ezilen 112 · karar 200/0
    //     limit 500  → toplam_iz 500 · ezilen 285 · karar 500/0
    //     limit 1000 → toplam_iz 543 · ezilen 315 · karar 543/0   ← GERÇEK
    // Yani ekrandaki "112 ezilen kalem" gerçekte 315'ti; "karar dağılımı
    // 200/0" ise sadece istek limitinin kendisiydi. Bu, sessiz kırpmanın en
    // zararlı hâli: gizlenen bir liste satırı değil, MANŞET RAKAMIN sessizce
    // istek parametresine bağlı olması.
    api('/stok-sayim/duzeltme-iz?limit=1000')
      .then((d) => setSayimIz(d || {}))
      .catch(() => setSayimIz(null));
  }, []);

  const hareketYukle = useCallback(() => {
    setHareketHata('');
    api('/ops/stok-hareketleri?gun=3&limit=150')
      // ⚠️ Sunucu satırların yanında HAZIR ÖZET de gönderiyor
      // (operasyon_merkez_api:17358 → tur_ozet, sube_ozet). Eskiden yalnız
      // `.satirlar` alınıp gerisi atılıyordu; v2 aynı giriş/çıkış toplamlarını
      // istemcide yeniden hesaplıyordu. Tam cevap saklanır.
      .then((d) => setHareket(Array.isArray(d) ? { satirlar: d, tur_ozet: [], sube_ozet: [] }
        : { ...(d || {}), satirlar: Array.isArray(d?.satirlar) ? d.satirlar : [] }))
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
  const [kgTarih, setKgTarih] = useState(isGunuBugun());
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
      // 🔵 EVV-OPS2-N2 (2026-08-13): uç `{satirlar: rows}` döndürüyor (backend 11391) ama
      // burada `.subeler` okunuyordu → merkez-müdahale şube listesi HEP BOŞ. Sözleşmeye hizala.
      .then((d) => setMdSubeler(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setMdSubeler([]));
  }, []);

  const mdUygula = async () => {
    const m = mdModal;
    if (!m) return;
    if (mdMesgul) return;   // 🔵 EVV-OPS3-F (2026-08-13) çift-tık: mükerrer merkez-müdahale önle
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
    if (gorunum === 'siparisarsiv') arsivYukle(arsivGun, arsivDurum, arsivArama);
    if (gorunum === 'bar') barYukle(barTarih);
    if (gorunum === 'denetim') denetimYukle(barTarih);
    if (gorunum === 'tedarik') tedarikYukle();
    if (gorunum === 'uzlastir') uzYukle();
    if (gorunum === 'katalog') ktYukle();
    if (gorunum === 'denetim') mdYukle();   // Merkez Denetim'in müdahale sekmeleri
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum, kuleYukle, sevkYukle, depoYukle, sayimYukle, hareketYukle, barYukle, denetimYukle, tedarikYukle, uzYukle, ktYukle, mdYukle, arsivYukle]);

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
    // 🔵 (2026-08-12, Ops denetimi): client kalem adedi yalnız >0 kapısındaydı; işaret/
    // tamsayı sınırı yoktu → negatif/ondalık adet stok-hareket yazısına sızabiliyordu.
    // Kaynakta non-negatif tamsayıya clamp (backend de doğrular ama savunma).
    // 🔵 EVV-OPS3-E (2026-08-13): adet clamp + durum-adet TUTARLILIĞI — durum 'yok'/'not'
    // iken pozitif gonderilen_adet taşınması stok-çıkışı ile niyeti çeliştiriyordu (aynı kalem
    // hem "yok" hem sevk-adetli). Yalnız var/kısmi'de adet gider, aksi 0.
    const payload = Object.values(kd).map((x) => {
      const adet = Math.max(0, Math.round(sayi(x.gonderilen_adet)));
      const durum = String(x.durum || '').toLowerCase();   // Codex: case-guard
      const gonderilir = durum === 'var' || durum === 'kismi';
      return { ...x, gonderilen_adet: gonderilir ? adet : 0 };
    });
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
    if (ysMesgul) return;   // 🔁 (2026-08-12) çift-tık: mükerrer iptal/geri-al/restok önle
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

  /** 📂 Tek siparişin TÜM zinciri — talep → gönderim → kabul farkı → fatura.
   *  Uç (/ops/tedarik-dosyasi) uzun süredir vardı ama hiçbir ekrana bağlı
   *  değildi: "şu siparişe ne oldu" sorusunun cevabı yalnız API'de yaşıyordu. */
  const dosyaAc = async (s) => {
    onToast?.('Tedarik dosyası açılıyor…');
    let d = null;
    try { d = await api(`/ops/tedarik-dosyasi/${s.id}`); }
    catch (e) { onToast?.(e?.message || 'Tedarik dosyası okunamadı', 'red'); return; }
    const gonderim = d?.toptanci_siparisler || d?.gonderimler || [];
    const faturalar = d?.faturalar || [];
    // 🔵 EVV-OPS2-N5 (2026-08-13): GRNI/"zincir tamam" kararı faturalar.length'ten
    // türüyordu ama iptal/taslak fatura da sayılıyordu → geçersiz fatura zinciri
    // "tamam/borç işlendi" gösterebiliyordu. Yalnız GEÇERLİ (iptal/taslak değil) say.
    const gecerliFatura = faturalar.filter((f) => !/(iptal|taslak|reddedild)/i.test(String(f.durum || '')));
    const kabul = d?.kabul_farklari || d?.kabul || [];
    const satirlar = [];
    satirlar.push({
      id: 'n1', hucreler: [
        { v: '① Talep' },
        { v: tarihKisa(d?.talep?.tarih || s.tarih), mono: true },
        { v: `${(d?.talep?.kalemler || s.kalemler || []).length} kalem çeşidi` },
        { v: d?.talep?.durum || s.asama || '—', rozet: R.bakir },
      ],
    });
    gonderim.forEach((g, i) => satirlar.push({
      id: `n2${i}`, hucreler: [
        { v: '② Toptancıya gönderim' },
        { v: tarihKisa(g.olusturma || g.tarih), mono: true },
        { v: g.tedarikci_ad || '—' },
        {
          v: g.durum === 'teslim_alindi' ? 'teslim alındı' : (g.durum || '—'),
          rozet: g.durum === 'teslim_alindi' ? R.yesil : g.durum === 'iptal' ? R.not : R.amber,
        },
      ],
    }));
    kabul.forEach((k, i) => satirlar.push({
      id: `n3${i}`, hucreler: [
        { v: '③ Kabul farkı' },
        { v: '—' },
        // ⚠️ Fable: burası ham alan okuyordu ve dosyanın geri kalanı için
        // yazılmış null-dönen okuyucuları (uzSevkAdet/uzKabulAdet/uzFarkAdet)
        // kullanmıyordu — "yanlış alan adı" kalıbına açık tek noktaydı.
        // Artık aynı okuyucular: alan yoksa "0" değil "—" yazılır.
        { v: `${k.urun_ad || k.kalem_adi || '—'}: sevk ${uzSevkAdet(k) ?? '—'} / kabul ${uzKabulAdet(k) ?? '—'}` },
        (() => {
          const f = uzFarkAdet(k);
          return f == null
            ? { v: 'fark ölçülemedi', rozet: R.not3 }
            : { v: `fark ${f > 0 ? '+' : ''}${f}`, rozet: f === 0 ? R.not : R.kirmizi };
        })(),
      ],
    }));
    // ⚠️ YARIM SÜZGEÇ (Codex, 2026-08-27 — bu projede 7. kez):
    // KPI `gecerliFatura` (iptal/taslak/reddedilmiş HARİÇ) üzerinden
    // hesaplanıyordu, ama bu liste `faturalar`ın TAMAMINI dolaşıp her satırı
    // YEŞİL basıyordu. Ekranda iptal edilmiş bir fatura, borcun işlendiğine
    // dair kanıt gibi duruyordu. Süzgeci değere uygulayıp listeye
    // uygulamamak, süzgeci yarım bırakmaktır.
    // ⚠️ SATIR SİLİNMİYOR (ham veri kaybolmaz) — rengi ve etiketi doğru
    // olanla değişiyor: geçersiz fatura artık kanıt gibi görünmüyor.
    faturalar.forEach((f, i) => {
      const _gecersiz = /(iptal|taslak|reddedild)/i.test(String(f.durum || ''));
      satirlar.push({
        id: `n4${i}`, hucreler: [
          { v: '④ Fatura' },
          { v: tarihKisa(f.fatura_tarih || f.tarih), mono: true },
          {
            v: `${f.fatura_no || '(no yok)'} · ${fmt(sayi(f.toplam_tutar != null ? f.toplam_tutar : f.tutar))}`
              + (_gecersiz ? ' · borç kanıtı DEĞİL' : ''),
            renk: _gecersiz ? R.not3 : undefined,
          },
          { v: f.durum || 'kayıtlı', rozet: _gecersiz ? R.not3 : R.yesil },
        ],
      });
    });
    if (!gecerliFatura.length) {
      satirlar.push({
        id: 'n4x', hucreler: [
          { v: '④ Fatura' }, { v: '—' },
          { v: 'henüz gelmedi — bu teslimat faturasız teslimat (GRNI) sayılır' },
          { v: 'bekliyor', rozet: R.amber },
        ],
      });
    }
    onCekmece?.({
      tip: 'TEDARİK DOSYASI',
      baslik: `${s.sube_adi || 'Şube'} · ${tarihKisa(s.tarih)}`,
      alt: 'siparişin tam zinciri — talep, gönderim, kabul, fatura',
      kpi: [
        { etiket: 'Gönderim', deger: String(gonderim.length) },
        { etiket: 'Fatura', deger: String(gecerliFatura.length), renk: gecerliFatura.length ? R.yesil : R.amber },
        { etiket: 'Kabul farkı', deger: String(kabul.length), renk: kabul.length ? R.kirmizi : R.yesil },
      ],
      listeBaslik: 'Zincir — basamak basamak',
      satirlar,
      not: gecerliFatura.length
        ? 'Zincir tamam: mal geldi, faturası kayıtlı — borç satırı cariye işlendi.'
        : 'Fatura gelmedi. Bu teslimat borç SATIRI değil; Tedarikçi Bakiyesi\'nde '
          + '"📦 faturasız teslimat" olarak GERÇEK BORÇ sütununa eklenir. Fatura '
          + 'gelince açık bakiyeye geçer, toplam değişmez.',
    });
  };

  // ══════════════════════════════════════════════════════════════════════
  // ⛔ KALEM BAZINDA MERKEZ İPTALİ (sahip isteği, 2026-08-28)
  // ══════════════════════════════════════════════════════════════════════
  // "gelen siparişi kalem bazında merkez iptal de edebilmeli — esp çarpıya
  // basınca iptal." ⚠️ Tek tıkla SESSİZCE iptal edilmez: şubenin istediği bir
  // şeyi merkez geri çeviriyor, bu bir KARAR. Onay penceresi + gerekçe alanı.
  const kalemIptalAc = (sip, kalem) => {
    setKalemIptal({ sip, kalem, gerekce: '' });
  };
  const kalemIptalUygula = async () => {
    const f = kalemIptal;
    if (!f || kalemIptalMesgul) return;
    setKalemIptalMesgul(true);
    try {
      const r = await api('/ops/siparis/kalem-iptal', {
        method: 'POST',
        body: {
          talep_id: f.sip.id,
          urun_ad: f.kalem?.urun_ad || null,
          urun_id: f.kalem?.urun_id || null,
          aciklama: (f.gerekce || '').trim() || null,
        },
      });
      onToast?.(
        r?.talep_iptal_edildi
          ? `⛔ ${r.iptal_edilen} iptal edildi — kalem kalmadığı için sipariş de kapandı`
          : `⛔ ${r?.iptal_edilen || 'Kalem'} iptal edildi · ${sayi(r?.kalan_aktif_kalem)} kalem devam ediyor`,
      );
      setKalemIptal(null);
      kuleYukle();
    } catch (e) {
      // ⚠️ Hata YUTULMAZ: sunucu "zaten toptancıya yollanmış" diyorsa sahip
      //    bunu görmeli — pencere açık kalır, karar sahipte.
      onToast?.(e?.message || 'Kalem iptal edilemedi');
    } finally {
      setKalemIptalMesgul(false);
    }
  };

  const siparisAc = (s) => {
    const a = ASAMA[s.asama] || ASAMA.bekliyor;
    // Bekleyen sipariş zenginleştirmesi — yalnız 'bekliyor' aşamasında dolu olur
    const z = bekZengin[String(s.id)] || null;
    const zKalem = z && Array.isArray(z.kalemler) ? z.kalemler : [];
    const zKalemMap = {};
    zKalem.forEach((k) => { zKalemMap[String(k.urun_ad || k.urun_id || '')] = k; });
    onCekmece?.({
      tip: 'SİPARİŞ',
      baslik: `${s.sube_adi || 'Şube'} · ${tarihKisa(s.tarih)}`,
      // 👤 SİPARİŞİ KİM İSTEDİ (sahip isteği, 2026-08-28): `personel_ad` uçtan
      // ZATEN geliyordu ama hiçbir yerde yazılmıyordu. Sahip çekmeceyi açınca
      // "bunu kim istedi" sorusunu soramıyor, siparişi sahipsiz bir kayıt
      // olarak görüyordu. Şube adının hemen altına, aşamayla aynı satıra.
      alt: [
        s.asama_metni || a.ad.toLowerCase(),
        s.personel_ad ? `isteyen: ${s.personel_ad}` : '',
        saatKisa(s.olusturma) ? `saat ${saatKisa(s.olusturma)}` : '',
      ].filter(Boolean).join(' · '),
      kpi: [
        { etiket: 'Aşama', deger: (a.ad || '').toLowerCase(), renk: a.renk },
        { etiket: 'Kalem çeşidi', deger: String((s.kalemler || []).length) },
        { etiket: 'Toplam adet', deger: String(sayi(s.kalem_sayisi)) },
        z
          ? {
            etiket: 'Karar sinyali',
            // ⚠️ ÖLÇÜLEMEDİ ≠ TEMİZ (canlı yürüyüşte yakalandı, 2026-08-28):
            // merdiven yalnız üç riske bakıyor, hiçbiri çıkmayınca "temiz"
            // YEŞİL yazıyordu. Oysa bugünkü ZAFER siparişinde sunucu
            // `merkez_kayit_eksik_var: true` diyordu: 32 kalemin 32'sinde
            // merkez stok kaydı YOK. Üç bayrak "false" çünkü kıyaslanacak
            // stok yok — risk olmadığı için değil. Yeşil, tam da yönlendirme
            // kararının verildiği yerde "kontrol ettim, sorun yok" diyordu.
            // Ölçülemeyen durum artık kendi basamağında ve GRİ.
            deger: z.gereksiz_var ? 'gereksiz?'
              : z.barem_risk_var ? 'barem riski'
                : z.stok_alarm_var ? 'stok alarmı'
                  : z.merkez_kayit_eksik_var ? 'ölçülemedi' : 'temiz',
            renk: z.gereksiz_var || z.barem_risk_var ? R.kirmizi
              : z.stok_alarm_var ? R.amber
                : z.merkez_kayit_eksik_var ? R.not2 : R.yesil,
          }
          : { etiket: 'Hedef depo', deger: s.hedef_depo_sube_adi || 'atanmadı', renk: s.hedef_depo_sube_adi ? R.krem : R.amber },
      ],
      listeBaslik: z ? 'Talep kalemleri · merkez stok durumu' : 'Talep kalemleri',
      // ⚠️ SESSİZ ELEME (Codex, 2026-08-27): kalem listesi 14'te kesiliyor ve
      // kesildiği SÖYLENMİYORDU. Sahip "bütün kalemleri gördüm" sanıp eksik
      // kanıtla karar veriyordu — 38 kalemlik siparişte 24 kalem görünmüyordu.
      // (Taşan sayı listenin sonunda ayrı satır olarak yazılıyor.)
      satirlar: [
        ...(s.kalemler || []).slice(0, 14).map((k) => {
        const zk = zKalemMap[String(k?.urun_ad || '')] || null;
        // ── 🔀 KALEMİN HEDEFİ (sahip isteği, 2026-08-28) ──────────────────
        // "listede o kalemin yanında yönlendirilen toptancı ya da depo
        // yazmalı… seçtiğim kalem silikleşmeli". Kule artık her kaleme
        // `yonlendirme: {tip, ad, adet}` yapıştırıyor.
        const yon = k?.yonlendirme || null;
        const iptalli = !!k?.iptal;
        const yonMetin = iptalli
          ? `⛔ merkez iptal etti${k?.iptal_aciklama ? ` · ${k.iptal_aciklama}` : ''}`
          : yon
            ? `${yon.tip === 'depo' ? '🏭' : yon.tip === 'karma' ? '⚠️' : '🚚'} ${yon.ad}${
              sayi(yon.adet) ? ` · ${sayi(yon.adet)} adet` : ''}${
              yon.tip === 'karma' ? ' — AYNI KALEM İKİ KANALDAN ÇIKMIŞ' : ''}`
            : '';
        // ── 📦 DEPODA KAÇ VAR (sahip isteği) ──────────────────────────────
        // "her ürünün TEMA şubesinde ne kadar olduğu parantezde yazmalı —
        // depodan sayıyı yollayabilecek miyim görmeliyim." Ürün adının
        // yanında, özete tıklamadan.
        // ⚠️ Depo adı UYDURULMAZ: sunucu `stok_depo_adi` vermezse parantez
        //    hiç yazılmaz (yanlış deponun sayısı gösterilmez).
        const depoAd = z?.stok_depo_adi || null;
        const depoVar = zk && zk.hedef_depo_mevcut != null ? sayi(zk.hedef_depo_mevcut) : null;
        const parantez = (depoAd && depoVar != null)
          ? ` (${depoAd}: ${depoVar}${depoVar >= sayi(k?.adet) ? ' ✓' : ' ⚠ yetmez'})`
          : '';
        // Karar için gereken üç sayı: şubede zaten var mı · merkezde ne kalır ·
        // barem altına düşer mi. Sunucu hesaplıyordu, ekran hiç göstermiyordu.
        // A-2. tur: sonuç cümlesinin ("X kalır") ARKASINDAKİ ham sayılar da
        // yazılır — merkezde kaç var / kaç rezerve / min kaç. -1 = kayıt yok
        // ("0 var" değil "bilinmiyor"). Hedef depo atanmışsa hesap ORADAN
        // yapılır; onun sayıları da gösterilir.
        const detay = zk
          ? [
            zk.sube_zaten_var ? `⚠ şubede zaten ${sayi(zk.sube_depo_mevcut)} var` : '',
            zk.merkez_mevcut != null && sayi(zk.merkez_mevcut) >= 0
              ? `merkezde ${sayi(zk.merkez_mevcut)}${sayi(zk.merkez_rezerve) ? ` (${sayi(zk.merkez_rezerve)} rezerve)` : ''}${sayi(zk.merkez_min_stok) ? ` · min ${sayi(zk.merkez_min_stok)}` : ''}`
              : (zk.merkez_mevcut != null && sayi(zk.merkez_mevcut) < 0 ? 'merkez kaydı yok' : ''),
            zk.hedef_depo_mevcut != null
              ? `hedef depoda ${sayi(zk.hedef_depo_mevcut)}${sayi(zk.hedef_depo_rezerve) ? ` (${sayi(zk.hedef_depo_rezerve)} rezerve)` : ''}${sayi(zk.hedef_depo_min_stok) ? ` · min ${sayi(zk.hedef_depo_min_stok)}` : ''}`
              : '',
            zk.kalan_gonderince != null ? `gönderince ${sayi(zk.kalan_gonderince)} kalır` : '',
            zk.merkez_barem_risk ? '⚠ barem altına düşer' : '',
            zk.alarm_merkez ? '⚠ merkez alarmı' : '',
          ].filter(Boolean).join(' · ')
          : (k?.birim ? String(k.birim) : '');
        return {
          ad: `${k?.urun_ad || '—'}${parantez}`,
          // Hedef varsa EN ÖNE gelir: "bu kalem artık nerede" sorusu, stok
          // sayılarından önce cevaplanır.
          detay: [yonMetin, detay].filter(Boolean).join(' · '),
          tutar: `${sayi(k?.adet)} adet`,
          // Yönlendirilmiş/iptal edilmiş kalem SİLİNMEZ, soluklaşır.
          solgun: !!(yon || iptalli),
          // ⛔ KALEM İPTALİ — yalnız HENÜZ YÖNLENDİRİLMEMİŞ ve iptal
          // edilmemiş kalemde. Yola çıkmış malı iptal düğmesi göstermek
          // yapılamayacak bir söz vermektir (sunucu da reddeder).
          ...((!yon && !iptalli && s.asama === 'bekliyor' && k?.urun_ad) ? {
            satirAksiyon: {
              ad: '×', renk: R.kirmizi,
              ipucu: `${k.urun_ad} kalemini merkez olarak iptal et`,
              onTikla: () => kalemIptalAc(s, k),
            },
          } : null),
        };
        }),
        // Taşan kalem sayısı YAZILIR — görünmeyen kalem, aranmayan kalemdir.
        ...((s.kalemler || []).length > 14 ? [{
          ad: `… ve ${(s.kalemler || []).length - 14} kalem daha`,
          detay: 'liste ilk 14 kalemi gösterir · tamamı sipariş kaydında',
          tutar: '',
        }] : []),
      ],
      not: [
        // Davranış uyarısı: aynı şube kısa aralıkla tekrar istiyor olabilir
        z && Array.isArray(z.davranis_uyarilari) && z.davranis_uyarilari.length
          ? `⚠ Davranış: ${z.davranis_uyarilari.map((u) => (typeof u === 'string' ? u : (u.mesaj || u.tip || ''))).filter(Boolean).join(' · ')}`
          : '',
        z?.gereksiz_var ? '⚠ Bazı kalemler şubenin kendi deposunda ZATEN VAR — sipariş gereksiz olabilir.' : '',
        z?.merkez_kayit_eksik_var ? 'Bazı kalemlerin merkez stok kaydı yok — "gönderince ne kalır" hesaplanamadı.' : '',
        // stok_hesap_kaynagi: yukarıdaki sayılar HANGİ depodan hesaplandı —
        // merkez mi, atanmış hedef depo mu. Yanlış depoya bakarak karar
        // verilmesin diye adıyla yazılır.
        z?.stok_hesap_kaynagi
          ? `Stok hesabı kaynağı: ${z.stok_hesap_kaynagi === 'hedef_depo' ? 'atanmış HEDEF DEPO' : z.stok_hesap_kaynagi === 'merkez' ? 'merkez depo' : z.stok_hesap_kaynagi}.`
          : '',
        s.asama_metni,
        s.operasyon_yonlendirme_talimati ? `Talimat: ${s.operasyon_yonlendirme_talimati}` : '',
        s.asama === 'yolda' ? 'Teslim alma ŞUBEDE yapılır (görünür kabul) — masaüstünden teslim işaretlenmez.' : '',
        // 👤 KİŞİ ZİNCİRİ (sahip isteği, 2026-08-28): dört ad da uçtan geliyordu
        // ama yalnız `kabul_personel_ad` ve yalnız UYUMSUZLUK aşamasında
        // yazılıyordu. Yani sipariş normal aktığında hiçbir adımın sahibi
        // görünmüyordu. ⚠️ Boş halka GİZLENMEZ, "—" ile yazılır: adım
        // atlanmışsa bunu görmek de bilgidir (sessiz eleme yasak).
        (() => {
          const h = [
            ['istedi', s.personel_ad, s.olusturma],
            ['tahsis', s.tahsis_yapan_ad, s.tahsis_ts],
            ['sevk', s.sevkiyat_personel_ad, s.sevkiyat_ts],
            ['kabul', s.kabul_personel_ad, s.kabul_ts],
          ];
          // Zincir yalnız BAŞLAMIŞ adımlara kadar yazılır: henüz sırası
          // gelmemiş adımı "—" ile göstermek eksiklik hissi üretir, oysa
          // normaldir. Son dolu halkadan sonrası kesilir.
          let son = -1;
          h.forEach((x, i) => { if (x[1] || x[2]) son = i; });
          if (son < 0) return '';
          return `👤 ${h.slice(0, son + 1).map(([ad, kisi, ts]) => {
            const sa = saatKisa(ts);
            return `${ad}: ${kisi || '—'}${sa ? ` (${sa})` : ''}`;
          }).join(' → ')}`;
        })(),
      ].filter(Boolean).join(' · '),
      // AŞAMAYA GÖRE KAPI: ileri yön + GERİ yön (yaşam döngüsü)
      aksiyonlar: (() => {
        const A = [];
        // 📂 TEDARİK DOSYASI (2026-08-09): /ops/tedarik-dosyasi/{id} tek
        // siparişin TÜM zincirini veriyordu (talep → toptancı gönderimleri →
        // kabul farkı → fatura + OCR fiyat) ama hiçbir ekranda yoktu. Bir
        // siparişin hikâyesini görmek için 5 modül gezmek gerekiyordu.
        A.push({
          ad: '📂 Tam zincir (tedarik dosyası)',
          onTikla: () => dosyaAc(s),
        });
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
    if (ktMesgul) return;   // 🔁 (2026-08-12) çift-tık: toplu ad/geçmiş yeniden-yazımını iki kez ateşleme
    setKtMesgul(true);
    try {
      const r = await api('/ops/siparis/sync-urun-adlari', { method: 'POST' });
      // 🐞 Toast olmayan `guncellenen` alanını okuyordu — sunucu
      // urun_guncellenen_adet + talep_guncellenen_adet döner.
      const u = sayi(r?.urun_guncellenen_adet); const t2 = sayi(r?.talep_guncellenen_adet);
      onToast?.(`✓ Adlar eşitlendi — ${u} ürün + ${t2} geçmiş talep güncellendi`);
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

    // ══════════════════════════════════════════════════════════════════════
    // 🧭 İŞ KUYRUĞU — "bugün merkezde ne yapmalıyım?"
    // ══════════════════════════════════════════════════════════════════════
    // Kurulum modül seviyesinde (`opsKuyrukKur`) — değişim ölçümü de aynı
    // yordamı çağırır, ikisi ayrışamaz.
    const kuyrukHam = opsKuyrukKur(satirlar, isGunuBugun());
    const KUYRUK_TAVAN = 5;
    const kuyruk = kuyrukHam.slice(0, KUYRUK_TAVAN);
    const kuyrukTasan = kuyrukHam.length - kuyruk.length;
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
          // ⚠️ MÜKERRER SAYI (bilişsel yük ölçümü, 2026-08-27): bu iki rakam
          // aşağıdaki kanban kolon başlıklarında ZATEN aynen duruyor. Tek
          // ekranda 70 sayı sayıldı; aynı sayıyı iki kez göstermek Tufte'nin
          // "veri-mürekkep" savurganlığı ve boşuna bilişsel yük.
          // ⚠️ SİLMEDİM — kaldırmak bilgi kaybı olurdu. Bunun yerine kanban'ın
          // SÖYLEYEMEDİĞİ şeyi ekledim: EN ESKİ işin yaşı. Kuyruk tam da bunun
          // önemli olduğunu gösterdi (14 gündür bekleyen bir karar vardı ve
          // hiçbir yerde yazmıyordu). Aynı yer artık iki değil üç şey söylüyor.
          (() => {
            const enEski = satirlar.filter((x) => x.asama === 'bekliyor')
              .map((x) => opsGunFarki(x.tarih, isGunuBugun()))
              .filter((v) => v != null)
              .sort((a, b) => b - a)[0];
            return {
              etiket: 'Merkez kuyruğu',
              deger: String(sayi(ozet.bekliyor)),
              alt: sayi(ozet.bekliyor) === 0 ? 'boş — yönlendirme beklemiyor'
                : (enEski != null ? `depo yönlendirmesi bekliyor · en eskisi ${enEski} gün` : 'depo yönlendirmesi bekliyor'),
              renk: sayi(ozet.bekliyor) > 0 ? R.amber : R.krem,
            };
          })(),
          (() => {
            const enEski = satirlar.filter((x) => x.asama === 'depoda')
              .map((x) => opsGunFarki(x.tarih, isGunuBugun()))
              .filter((v) => v != null)
              .sort((a, b) => b - a)[0];
            return {
              etiket: 'Depoda hazırlanan',
              deger: String(sayi(ozet.depoda)),
              alt: sayi(ozet.depoda) === 0 ? 'boş — hazırlık beklemiyor'
                : (enEski != null ? `sevk bekliyor · en eskisi ${enEski} gün` : 'sevk bekliyor'),
              renk: sayi(ozet.depoda) > 0 ? R.mavi : R.krem,
            };
          })(),
          { etiket: 'Kabul uyumsuzluğu', deger: String(sayi(ozet.uyumsuzluk)), alt: sayi(ozet.uyumsuzluk) > 0 ? 'merkez müdahalesi gerekli' : 'temiz', renk: sayi(ozet.uyumsuzluk) > 0 ? R.kirmizi : R.yesil },
        ]} />

        {/* 🧭 İŞ KUYRUĞU — ekranın İLK bloğu (hero-önce deseni).
            Boşsa gösterilmez: boş bir "yapılacak yok" kartı ekran yer kaplar,
            iş üretmez. */}
        {kuyruk.length > 0 && (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 11 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>🧭 Bugün merkezde ne yapmalıyım</span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                {kuyrukHam.length} iş · en acili üstte
                {kuyrukTasan > 0 && ` · ${kuyrukTasan} tanesi aşağıdaki panoda`}
              </span>
              {/* ⚠️ DEĞİŞİM (BAKIŞ hamlesi 3): sabit rakam 3. günden sonra
                  duvar kâğıdı olur. "Dün 10 iş vardı, bugün de 10" ile
                  "3 kapandı 3 yenisi geldi" ÇOK farklı iki gerçek — ilkinde
                  hiç çalışılmamış, ikincisinde çalışılmış ama iş akmaya devam
                  ediyor. Taban yoksa uydurma delta yazılmaz. */}
              {kuyrukDegisim && (kuyrukDegisim.yeni > 0 || kuyrukDegisim.kapanan > 0) && (
                <span style={{ fontSize: 11.5, color: R.not3 }}>
                  · {kuyrukDegisim.tarih}’ten beri{' '}
                  {kuyrukDegisim.kapanan > 0 && (
                    <b style={{ color: R.yesil }}>{kuyrukDegisim.kapanan} kapandı</b>
                  )}
                  {kuyrukDegisim.kapanan > 0 && kuyrukDegisim.yeni > 0 && ' · '}
                  {kuyrukDegisim.yeni > 0 && (
                    <b style={{ color: R.amber }}>{kuyrukDegisim.yeni} yeni</b>
                  )}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {kuyruk.map((m) => {
                const renk = m.sinif === 1 ? R.kirmizi : m.sinif === 2 ? R.bakir : R.amber;
                return (
                  <div
                    key={m.anahtar}
                    onClick={() => { olcumEylem('kuyruk'); siparisAc(m._s); }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); olcumEylem('kuyruk'); siparisAc(m._s); } }}
                    className="v2-hover-kalk"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                      padding: '11px 14px', borderRadius: 12, background: R.girinti,
                      border: `1px solid ${R.cizgi}`, borderLeft: `3px solid ${renk}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: R.krem }}>{m.baslik}</div>
                      <div style={{ fontSize: 11.5, color: R.not2, marginTop: 2 }}>{m.aciklama}</div>
                    </div>
                    {m.yas != null && (
                      <span style={{ fontSize: 11, color: m.yas >= 3 ? R.amber : R.not3, fontFamily: F.mono }}>
                        {m.yas === 0 ? 'bugün' : `${m.yas} gün`}
                      </span>
                    )}
                    <span style={{ color: R.not3, fontSize: 13 }}>›</span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: R.not3, marginTop: 9, lineHeight: 1.6 }}>
              Bu liste elle kapatılmaz — iş bitince kayıt aşama değiştirir ve madde kendiliğinden düşer.
              Aşağıdaki pano tüm siparişlerin <b>kanıt katmanıdır</b>; buradaki sıra <b>karardır</b>.
            </div>
          </div>
        )}

        {/* Kontrol Kulesi birleşti (2026-07-30): hız duyusu akışın yanına geldi */}
        {hizSeridi}
        {ysModalBlok}

        {/* ══════════════════════════════════════════════════════════════
            🔻 RİSK ŞERİDİ KÜÇÜLDÜ — "İKİNCİ BUGÜN LİSTESİ YOK" (BAKIŞ kuralı)
            ══════════════════════════════════════════════════════════════
            Bu şerit, kuyruk kurulmadan önce ekranın karar katmanıydı: uyumsuz
            siparişler kırmızı kartlar hâlinde burada duruyordu. Kuyruk gelince
            AYNI siparişler S1'de, yaşlarıyla ve sıralı olarak görünmeye
            başladı — yani ekranda İKİ karar katmanı oluştu ve sahip hangisine
            bakacağını bilemezdi. BAKIŞ'ta bu açıkça yasaklanmıştı: "Motor &
            Bildirimler = istisna arşivi; ikinci 'bugün' listesi YOK."
            ⚠️ Bilgi SİLİNMEDİ, ROLÜ değişti: şerit artık karar yeri değil,
            toplam + geçiş. Kartlar kaldırıldı (kuyrukta zaten var, yaşıyla
            birlikte); kalan tek şey sayı ve "hepsini incele" yolu.
            ⚠️ KIRMIZI BÜTÇESİ: aynı sorun iki kez kırmızıyla bağırıyordu.
            Kuyruk S1'i zaten kırmızı; burası artık amber (ikincil).
            ⚠️ Kuyruğa girmeyen (tavanı aşan) uyumsuzluk varsa BURADA sayılır —
            hiçbir kalem iki katmandan da düşmez. */}
        {uyumsuzlar.length > 0 && (
          <div style={{
            ...kartYuzey, padding: '11px 16px', marginBottom: 14,
            borderLeft: `3px solid ${R.amber}`,
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 12.5, color: R.krem }}>
              <b>{uyumsuzlar.length}</b> kabul uyuşmazlığı — şube kabulü sevk edilenle uyuşmadı
            </span>
            <span style={{ fontSize: 11.5, color: R.not3 }}>
              {kuyruk.filter((m) => m.sinif === 1).length > 0
                ? `${kuyruk.filter((m) => m.sinif === 1).length} tanesi yukarıdaki kuyrukta`
                : 'kuyrukta yer kalmadı — hepsi panoda'}
            </span>
            <button
              onClick={() => onGorunum?.('denetim')}
              style={{
                marginLeft: 'auto', padding: '0 16px', minHeight: 40, borderRadius: 10,
                border: `1px solid ${R.cizgi3}`, background: R.girinti,
                color: R.not, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              }}
            >Merkez Denetim’de incele →</button>
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
                      {/* KARAR SİNYALİ — depoya yönlendirmeden ÖNCE görünmeli.
                          Çekmeceyi açmadan "bu sipariş gereksiz mi / merkezi
                          barem altına düşürür mü" sorusu cevaplanıyor. */}
                      {(() => {
                        const z = bekZengin[String(s.id)];
                        // ⚠️ `uyari_var` kapısı ölçülemeyen durumu ELİYORDU:
                        // stok kaydı yoksa risk hesaplanamaz, uyari_var false
                        // kalır ve kart HİÇBİR ŞEY göstermezdi — sahip kartın
                        // sessizliğini "sorun yok" diye okuyordu. Kayıt eksiği
                        // artık kapıyı kendi başına açar.
                        if (!z || (!z.uyari_var && !z.merkez_kayit_eksik_var)) return null;
                        const haplar = [];
                        if (z.gereksiz_var) haplar.push({ ad: 'şubede zaten var', renk: R.kirmizi });
                        if (z.barem_risk_var) haplar.push({ ad: 'barem riski', renk: R.kirmizi });
                        if (z.stok_alarm_var) haplar.push({ ad: 'merkez stok alarmı', renk: R.amber });
                        if (z.merkez_kayit_eksik_var) haplar.push({ ad: 'stok ölçülemedi', renk: R.not2 });
                        if ((z.davranis_uyarilari || []).length) haplar.push({ ad: 'davranış uyarısı', renk: R.amber });
                        if (!haplar.length) return null;
                        return (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                            {haplar.map((h, hi) => (
                              <span key={hi} style={{
                                padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700,
                                background: `${h.renk}1e`, color: h.renk, whiteSpace: 'nowrap',
                              }}>{h.ad}</span>
                            ))}
                          </div>
                        );
                      })()}
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

        {/* ══════════════════════════════════════════════════════════════
            📌 GÜN KAPANIŞI — serial position (Murdock 1962)
            ══════════════════════════════════════════════════════════════
            Ölçtüm: bu ekran ham kanban kartıyla bitiyordu ("ZAFER · 14 Ağu ·
            1 kalem · 120 adet"). Bir dizinin İLK ve SON ögesi hatırlanır,
            ortası silinir. Ekranın ilk ögesi iş kuyruğu (iyi), son ögesi bir
            kart yığınıydı — yani merkezin aklında kalan son şey bir veri
            parçasıydı, bir cümle değil.
            ⚠️ YENİ HESAP YOK: yalnız ekranda ZATEN olan sayılar tek cümlede
            toplanıyor. */}
        <div style={{
          ...kartYuzey, padding: '14px 18px', marginTop: 14,
          borderLeft: `3px solid ${kuyrukHam.length ? R.bakir : R.yesil}`,
        }}>
          <div style={{ fontSize: 11, letterSpacing: .8, color: R.not3, marginBottom: 6 }}>GÜN KAPANIŞI</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.75, color: R.krem }}>
            Son 14 günde <b>{acik}</b> açık sipariş var.{' '}
            {sayi(ozet.yolda) + sayi(ozet.toptanci_bekliyor) > 0 && (
              <>Bunların <b>{sayi(ozet.yolda) + sayi(ozet.toptanci_bekliyor)}</b> tanesi yolda —{' '}
                <b>şube kabulünü bekliyor</b>, top merkezde değil.{' '}</>
            )}
            {kuyrukHam.length > 0
              ? <>Merkezin kararını bekleyen <b style={{ color: R.bakir }}>{kuyrukHam.length} iş</b> var;
                  sırası yukarıdaki kuyrukta.</>
              : <>Merkezde bekleyen iş <b style={{ color: R.yesil }}>yok</b>.</>}
          </div>
          {/* ⚠️ Bu ekranın ölçtüğü şeyin SINIRI: kanban "sipariş hangi
              aşamada" der, "iş kimde" demez. Yolda bekleyen bir sipariş
              merkezin işi değildir — bunu yazmak, merkezi olmayan bir işten
              sorumlu hissettirmemek içindir. */}
          <div style={{ fontSize: 11.5, color: R.not2, marginTop: 8, lineHeight: 1.7 }}>
            Pano siparişin <b>hangi aşamada</b> olduğunu gösterir, <b>işin kimde</b> olduğunu değil:
            “yolda” olan bir sipariş şubenin kabulünü bekler, merkezin yapacağı bir şey yoktur.
          </div>
        </div>

        {/* ── ⛔ KALEM İPTAL ONAYI ──────────────────────────────────────────
            Şubenin istediği bir kalemi merkez geri çeviriyor: bu bir KARAR,
            tek tık değil. Gerekçe isteğe bağlı ama SORULUR — sorulmayan
            gerekçe hiç yazılmaz, sonra "bunu neden iptal etmişiz" denir. */}
        {kalemIptal && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !kalemIptalMesgul) setKalemIptal(null); }}
            style={{
              position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(10,6,2,.7)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 430, maxWidth: '96vw', padding: '22px 24px' }}>
              <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 4 }}>
                Kalemi iptal et
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14, lineHeight: 1.5 }}>
                <b style={{ color: R.krem }}>{kalemIptal.kalem?.urun_ad}</b>
                {sayi(kalemIptal.kalem?.adet) ? ` · ${sayi(kalemIptal.kalem.adet)} adet` : ''}
                {' — '}{kalemIptal.sip?.sube_adi} istemişti.
                <div style={{ color: R.not2, marginTop: 5 }}>
                  Kalem <b>silinmez</b>, &ldquo;merkez iptal etti&rdquo; olarak işaretlenir ve listede
                  soluk kalır — şube ne istediğini, siz neyi geri çevirdiğinizi görebilesiniz.
                  Siparişin diğer kalemleri akmaya devam eder.
                </div>
              </div>
              <label style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block' }}>
                Gerekçe (isteğe bağlı)
              </label>
              <input
                value={kalemIptal.gerekce}
                onChange={(e) => setKalemIptal((f) => ({ ...f, gerekce: e.target.value }))}
                placeholder="ör. stokta yok · bu ay alınmayacak"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
                  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                  fontSize: 13, fontFamily: 'inherit', outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
                <button disabled={kalemIptalMesgul} onClick={() => setKalemIptal(null)} style={{
                  padding: '9px 16px', borderRadius: 10, fontSize: 12.5, fontWeight: 700,
                  fontFamily: 'inherit', cursor: 'pointer', background: 'transparent',
                  border: `1px solid ${R.cizgi3}`, color: R.metin2,
                }}>Vazgeç</button>
                <button disabled={kalemIptalMesgul} onClick={kalemIptalUygula} style={{
                  padding: '9px 16px', borderRadius: 10, fontSize: 12.5, fontWeight: 700,
                  fontFamily: 'inherit', cursor: kalemIptalMesgul ? 'default' : 'pointer',
                  background: kalemIptalMesgul ? R.girinti : R.kirmizi,
                  border: 'none', color: kalemIptalMesgul ? R.not : '#fff',
                }}>{kalemIptalMesgul ? 'İptal ediliyor…' : 'Kalemi iptal et'}</button>
              </div>
            </div>
          </div>
        )}

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
                {yonForm.sip.personel_ad ? ` · isteyen: ${yonForm.sip.personel_ad}` : ''}
              </div>
              {/* 🔶 ZATEN YOLLANANI YAZ — modal artık yalnız KALANI gösteriyor.
                  Bu satır olmadan liste sessizce kısalır ve sahip "sipariş
                  küçülmüş" sanır. Ne kaldığı değil, NEYİN ÇIKTIĞI da yazılır. */}
              {(yonForm.sip.dagitilan_kalem_adlari || []).length > 0 && (
                <div style={{
                  fontSize: 11.5, lineHeight: 1.5, marginBottom: 14, padding: '9px 12px',
                  borderRadius: 10, background: 'rgba(217,154,78,.10)',
                  border: `1px solid ${R.bakir}44`, color: R.metin2,
                }}>
                  🔶 <b>Zaten yollandı:</b> {(yonForm.sip.dagitilan_kalem_adlari || []).join(', ')}
                  <div style={{ color: R.not2, marginTop: 3 }}>
                    Bu kalemler aşağıdaki listede YOKTUR — aynı mal ikinci kez sipariş edilmesin diye çıkarıldı.
                  </div>
                </div>
              )}

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
                    Gönderilecek kalemler ({yonForm.secili.length}/{(yonForm.kalemListe || yonForm.sip.kalemler || []).length})
                  </label>
                  <div style={{
                    maxHeight: 190, overflowY: 'auto', borderRadius: 11,
                    border: `1px solid ${R.cizgi3}`, background: R.girinti, padding: '8px 10px',
                  }}>
                    {(yonForm.kalemListe || yonForm.sip.kalemler || []).map((k, i) => {
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
              {/* ⚠️ DÜRÜST SINIR (2026-08-28): toptancı yönü kalem seçebiliyor,
                  DEPO yönü seçemiyor — `/ops/siparis/sevkiyata-gonder` ucu
                  kalem listesi almıyor, siparişin TAMAMINI depoya atıyor.
                  Yukarıdaki "zaten yollandı" kutusu kalemleri listeden
                  çıkardığı için sahip "onlar hariç gider" sanabilir. Sanmasın:
                  sınır adıyla yazılıyor. (Kalem bazlı yönlendirme tasarımı
                  Codex+Fable denetiminden geçti, kuruluşu bekliyor.) */}
              {(yonForm.sip.dagitilan_kalem_adlari || []).length > 0 && (
                <div style={{
                  fontSize: 11.5, lineHeight: 1.5, marginTop: 10, padding: '9px 12px',
                  borderRadius: 10, background: 'rgba(214,109,92,.10)',
                  border: `1px solid ${R.kirmizi}44`, color: R.metin2,
                }}>
                  ⚠ <b>Depo yönlendirmesi şu an kalem seçemez:</b> siparişin
                  TAMAMI seçilen depoya gider — yukarıda &ldquo;zaten yollandı&rdquo; yazan
                  kalemler dâhil. Yalnız kalanları göndermek için önce toptancı
                  sekmesini kullanın.
                </div>
              )}

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

    // ⚠️ ŞEKİL TUZAĞI (2026-08-07 denetimi): sunucu kategori altındaki ürünleri
    // `items` alanında gönderir (operasyon_merkez_api:8890), ekran `urunler`
    // okuyordu → 11 kategori DOLUYKEN 'Ürün 0 · Bu kategoride ürün yok' yazıyordu.
    // Şubelerin sipariş edebildiği katalog var sanılmıyordu; oysa Espresso/Filtre/
    // Granül... hepsi kayıtlı. Fiyatsız + depo-eşleşmesiz sayaçları da 0 çıkıyordu.
    const kItems = (k) => (k.items || k.urunler || []);
    const toplamUrun = ktKatalog.reduce((a, k) => a + kItems(k).length, 0);
    // 🔵 EVV-OPS3-F: eskiden yalnız `== null` fiyatsız sayılıyordu → 0/''/bozuk değer
    // "fiyatlı ₺0" görünüp maliyet hesabına 0 basıyordu. Pozitif olmayan = fiyatsız.
    const fiyatsiz = ktKatalog.reduce((a, k) =>
      a + kItems(k).filter((u) => !(sayi(u.birim_fiyat_tl) > 0)).length, 0);
    const eslesmemis = ktKatalog.reduce((a, k) =>
      a + kItems(k).filter((u) => !u.depo_stok_kalem_kodu).length, 0);

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
                {kItems(k).length} ürün
              </span>
              <button onClick={() => setKtModal({ tip: 'urun', kategori: k, ad: '', deger: '' })} style={{
                marginLeft: 'auto', padding: '6px 13px', borderRadius: 9, cursor: 'pointer',
                border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.metin2,
                fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
              }}>+ Ürün</button>
            </div>

            {kItems(k).length === 0 ? (
              <div style={{ fontSize: 12, color: R.not2 }}>Bu kategoride ürün yok.</div>
            ) : kItems(k).map((u) => (
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
                  color: !(sayi(u.birim_fiyat_tl) > 0) ? R.not3 : R.krem,   // Codex: tek predicate (>0) — count/text/renk/prefill tutarlı
                }}>
                  {!(sayi(u.birim_fiyat_tl) > 0) ? 'fiyatsız' : fmt(sayi(u.birim_fiyat_tl))}
                </span>
                <button onClick={() => setKtModal({ tip: 'ad', kategori: k, urun: u, ad: u.ad, deger: '' })} style={ktMiniBtn}>ad</button>
                <button onClick={() => setKtModal({ tip: 'fiyat', kategori: k, urun: u, ad: '', deger: !(sayi(u.birim_fiyat_tl) > 0) ? '' : String(u.birim_fiyat_tl) })} style={ktMiniBtn}>fiyat</button>
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
    // 🐞 SAHTE YEŞİL: sunucu diziyi `liste` adıyla döndürüyor
    // (operasyon_merkez_api:6937). Eski kod `uyarilar`/`kayitlar` arıyordu —
    // ikisi de cevapta YOK → kasaSatir HER ZAMAN boş → "Kasa uyumsuzluğu"
    // KPI'ı ve Uzlaştırma'nın Kasa sekmesi gerçek veriye rağmen "0 / temiz"
    // gösteriyordu. Çözüm masasının kendisi kördü.
    const kasaSatir = Array.isArray(uzKasa?.liste) ? uzKasa.liste
      : (Array.isArray(uzKasa?.uyarilar) ? uzKasa.uyarilar
        : (Array.isArray(uzKasa?.kayitlar) ? uzKasa.kayitlar : (Array.isArray(uzKasa) ? uzKasa : [])));
    const persSatir = Array.isArray(uzPers?.kayitlar) ? uzPers.kayitlar : [];
    const acikKasa = kasaSatir.filter((k) => !/(cozuldu|çözüldü)/i.test(String(k.durum || '')));
    const acikPers = persSatir.filter((p) => !/(cozuldu|çözüldü)/i.test(String(p.durum || '')));
    // 'acik' = henüz karar verilmemiş; yazılmış olanlar (gelire/gidere) kapanmış sayılır
    const farkSatir = Array.isArray(uzFark) ? uzFark : [];
    // ══════════════════════════════════════════════════════════════════════
    // 🔴 İŞ KUYRUĞU 5 KATINA ŞİŞMİŞTİ — 2026-08-27, canlı ölçüm
    // ══════════════════════════════════════════════════════════════════════
    // Sekme "Ciro farkı (54)" diyordu. Defteri ölçtüm — 57 kaydın dağılımı:
    //   · durum='acik'                          11  ← GERÇEK İŞ (fark ölçülmüş)
    //   · 'evo_kullaniliyor' + fark YOK         32  ← şube kapanış GİRMEMİŞ;
    //        ortada bir fark yok ki uzlaştırılsın (girilen=NULL, fark=NULL —
    //        ciro_taslak_api.py:608 bu satırı böyle yazıyor)
    //   · 'evo_kullaniliyor' + fark VAR         11  ← Evo lehine KARARA BAĞLANMIŞ
    //   · gelire_yazildi / evo_dogru             3  ← kapanmış
    // Eski süzgeç yalnız son grubu eliyordu; 43 kaydı "açık iş" sayıyordu.
    // ⚠️ ALARM BÜTÇESİ: 54 satırlık bir kuyruğa bakan insan hiçbirine bakmaz.
    // Kuyruk gerçek işi göstermeli; diğerleri SİLİNMEZ, AYRI SAYILIR.
    const acikFark = farkSatir.filter((f) => String(f.durum || '') === 'acik');
    // Kapanış girilmemiş günler: bu bir "fark" değil, EKSİK KAYIT sinyalidir —
    // ayrı bir iş, ayrı sayılır (gizlenmez).
    const kapanissizFark = farkSatir.filter((f) => String(f.durum || '') === 'evo_kullaniliyor' && f.fark == null);
    const cozulmusFark = farkSatir.filter((f) => {
      const d = String(f.durum || '');
      return d !== 'acik' && !(d === 'evo_kullaniliyor' && f.fark == null);
    });

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
          // ⚠️ ÇERÇEVELEME (sistematik tarama, 2026-08-27): bu sayı KALEM
          // satırı sayar (16), yanındaki "Kasa uyumsuzluğu" ise KAYIT sayar (1).
          // Yan yana duran iki rakam farklı birimde olunca 16:1 gibi görünür;
          // aynı birimde (sipariş) oran 4:1. En büyük sayı, birimi yüzünden
          // olduğundan ağır bir çıpa kuruyordu. Sayı değişmedi — NEYİ saydığı
          // ve kaç siparişe denk geldiği yazıldı.
          {
            onTikla: sevkSatir.length ? () => setUzAlt('sevkiyat') : undefined,
            etiket: 'Sevkiyat uyumsuzluğu',
            deger: String(sevkSatir.length),
            alt: (() => {
              const sip = new Set(sevkSatir.map((r) => r.siparis_talep_id).filter(Boolean)).size;
              return sip ? `${sevkSatir.length} kalem · ${sip} siparişte · son 30 gün`
                : 'son 30 gün · kabul farkı';
            })(),
            renk: sevkSatir.length ? R.amber : R.yesil,
          },
          { onTikla: acikKasa.length ? () => setUzAlt('kasa') : undefined, etiket: 'Kasa uyumsuzluğu', deger: String(acikKasa.length), alt: acikKasa.length ? 'açık kayıt' : 'temiz', renk: acikKasa.length ? R.kirmizi : R.yesil },
          { onTikla: acikPers.length ? () => setUzAlt('personel') : undefined, etiket: 'Personel-vardiya', deger: String(acikPers.length), alt: acikPers.length ? 'açık kayıt' : 'temiz', renk: acikPers.length ? R.amber : R.yesil },
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

        {/* ── ÇOK-ŞUBE TEDARİKÇİ PATERNİ ──
            Aşağıdaki liste HAM olayları gösteriyor: "şu şubede şu kalem eksik".
            Bu blok aynı olayları TEDARİKÇİ bazında toplayıp asıl soruyu soruyor:
            fark tek şubede mi, yoksa aynı tedarikçi FARKLI ŞUBELERDE de mi
            eksik gönderiyor? ≥2 şube → tedarikçi paterni, şube masum.
            Tek şube → belirsiz (şube/sayım da olabilir) — suçlama YOK. */}
        {uzAlt === 'sevkiyat' && uzTedarikci.length > 0 && (
          <div style={{ ...kartYuzey, padding: '14px 18px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                Tedarikçi paterni · son 60 gün
              </span>
              <span style={{ fontSize: 11, color: R.not2 }}>
                tek olaydan suçlama yok — çok şube = ikna edici sinyal
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {uzTedarikci.length > 8 && (
                <div style={{ fontSize: 11, color: R.not3 }}>
                  ⚠ {uzTedarikci.length} tedarikçinin ilk 8'i gösteriliyor ({uzTedarikci.length - 8} tanesi listede yok)
                </div>
              )}
              {uzTedarikci.slice(0, 8).map((t, i) => {
                const patern = t.sonuc === 'tedarikci_paterni';
                return (
                  <div key={t.tedarikci || i} style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                    padding: '8px 12px', borderRadius: 9, background: R.girinti,
                    borderLeft: `3px solid ${patern ? R.kirmizi : R.not3}`,
                  }}>
                    <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 128 }}>{t.tedarikci || '—'}</span>
                    <span style={{
                      flexShrink: 0, padding: '2px 9px', borderRadius: 99, fontSize: 10,
                      fontWeight: 700, whiteSpace: 'nowrap',
                      background: patern ? `${R.kirmizi}1e` : `${R.not3}22`,
                      color: patern ? R.kirmizi : R.not2,
                    }}>{patern ? `${sayi(t.sube_sayisi)} şubede patern` : 'tek şube · belirsiz'}</span>
                    <span style={{ flex: 1, minWidth: 0, color: R.not2 }}>
                      {(t.subeler || []).join(', ')}
                    </span>
                    <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.not }}>
                      {sayi(t.olay_sayisi)} olay
                    </span>
                    {sayi(t.eksik_toplam) > 0 && (
                      <span style={{ flexShrink: 0, fontFamily: F.mono, fontWeight: 700, color: R.kirmizi }}>
                        −{sayi(t.eksik_toplam)}
                      </span>
                    )}
                    {sayi(t.fazla_toplam) > 0 && (
                      <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.yesil }}>
                        +{sayi(t.fazla_toplam)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {uzAlt === 'sevkiyat' && (sevkSatir.length === 0 ? (
          <BosDurum tamam baslik="Sevkiyat uyumsuzluğu yok" aciklama="Son 30 günde gönderilen ile kabul edilen adet birbirini tutuyor." />
        ) : (
          <Tablo
            baslik="Sevkiyat uyumsuzlukları · gönderilen ↔ kabul edilen"
            kolonlar={[{ ad: 'Şube' }, { ad: 'Kalem' }, { ad: 'Gönderilen', sag: true }, { ad: 'Kabul', sag: true }, { ad: 'Fark', sag: true }]}
            not={sevkSatir.length > 40
              ? `satıra tıkla → uzlaştır · ⚠ ${sevkSatir.length} uyumsuzluğun ilk 40'ı gösteriliyor (${sevkSatir.length - 40} satır listede yok)`
              : 'satıra tıkla → uzlaştır'}
            satirlar={sevkSatir.slice(0, 40).map((r, i) => {
              const gon = uzSevkAdet(r);
              const kab = uzKabulAdet(r);
              const fark = uzFarkAdet(r);
              return {
                id: r.stok_yolda_id || r.id || `sv-${i}`, _r: r,
                hucreler: [
                  { v: r.sube_adi || r.hedef_sube_adi || '—', kalin: true },
                  { v: kisalt(r.kalem_adi || r.urun_adi || '—', 34) },
                  { v: gon == null ? '—' : String(gon), mono: true, sag: true, renk: gon == null ? R.not3 : undefined },
                  { v: kab == null ? '—' : String(kab), mono: true, sag: true, renk: kab == null ? R.not3 : undefined },
                  fark == null
                    ? { v: 'ölçülemedi', sag: true, renk: R.not3 }
                    : { v: (fark > 0 ? '+' : '') + String(fark), mono: true, sag: true, kalin: true, renk: fark === 0 ? R.yesil : R.amber },
                ],
              };
            })}
            onSatir={({ _r }) => setUzModal({
              tip: 'sevkiyat', kayit: _r,
              // ⚠️ Fable: tablo Kabul sütununu `uzKabulAdet()` ile okurken,
              // satıra tıklayınca açılan modalın ÖN DOLGUSU ham alanlardan
              // okuyordu. Yardımcı zaten alan adı değişkenliği için var;
              // baypas edilirse tablo "Kabul 7" derken modal "0" ile açılır
              // ve sahip onaylarsa talep+tahsis 0'a eşitlenir.
              adet: (() => { const k = uzKabulAdet(_r); return k == null ? '' : String(k); })(),
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
              baslik={`Talep ↔ tahsis uyumsuzlukları · ${uzTahsis.length > 60 ? `${uzTahsis.length} kayıttan ilk 60` : `${uzTahsis.length} kayıt`}`}
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
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Fark', sag: true },
              { ad: 'Kişi deseni' }, { ad: 'Durum' }, { ad: '' },
            ]}
            not={'satıra tıkla → çöz · fark tazelemek için satırdaki yeniden hesapla'
              + (acikKasa.length > 40
                ? ` · ⚠ ${acikKasa.length} açık uyumsuzluğun ilk 40'ı gösteriliyor (${acikKasa.length - 40} kayıt listede yok)`
                : '')}
            satirlar={acikKasa.slice(0, 40).map((k, i) => {
              // personel_patern: AYNI KİŞİDE tekrar eden fark (son 30 gün).
              // Tek seferlik fark ile kronik desen aynı şey değil — sunucu
              // ayrımı yapıyordu, ekran hiç göstermiyordu.
              const pat = k.personel_patern || null;
              return {
                id: k.id || `ku-${i}`, _k: k,
                hucreler: [
                  { v: k.sube_adi || k.sube_ad || '—', kalin: true },
                  { v: tarihKisa(k.tarih || k.gun), mono: true, renk: R.not },
                  { v: fmt(sayi(k.fark_tl ?? k.fark)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                  pat
                    ? (pat.kronik
                      ? {
                        sira: 2,
                        siraMetin: 'kronik',
                        v: (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{
                              padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                              background: `${R.kirmizi}22`, color: R.kirmizi, alignSelf: 'flex-start',
                            }}>{pat.hep_acik ? 'hep açık' : 'kronik'}</span>
                            <span style={{ fontSize: 10, color: R.not2, whiteSpace: 'nowrap' }}>
                              30g: {sayi(pat.son_30g_adet)} fark · {sayi(pat.acik_adet)} açık
                            </span>
                          </span>
                        ),
                      }
                      : { v: `${sayi(pat.son_30g_adet)}× / 30g`, mono: true, renk: R.not2, sira: 1 })
                    : { v: '—', renk: R.not3, sira: 0 },
                  { v: k.durum || 'açık', rozet: R.amber },
                  { v: uzMesgul === `yh:${k.id}` ? '…' : '🔄 tazele', renk: R.mavi },
                ],
              };
            })}
            onSatir={({ _k }) => setUzModal({ tip: 'kasa', kayit: _k, adet: '', notu: '' })}
          />
        ))}

        {/* ⚠️ AYNI AD, İKİ HESAP (Codex, 2026-08-27): sekme sayacı `acikFark`,
            gövde `farkSatir` kullanıyordu — sekme "(0)" derken içeride satır
            olabiliyordu. İkisi artık AYNI kümeyi anlatıyor. */}
        {uzAlt === 'ciro' && ((acikFark.length || kapanissizFark.length || cozulmusFark.length) ? (
          <>
            <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
              Kasaya girilen ciro ile Evo satışı tutmadığında buraya düşer.
              İki soru var: <b>hangisi doğru</b> (karar) ve <b>aradaki para ne oldu</b>
              (fazlaysa gelir, eksikse gider yazılır). Para yazma işlemi kasa
              defterine işlenir ve <b>geri alınamaz</b> — önce kararı ver.
            </div>
            {/* ⚠️ Fable: kuyruğu gerçek işe indirirken KARAR GERİ ALMA yolunu
                kapatmışım. "Kararı geri al" eylemi yalnız karara bağlanmış
                kayıtlarda üretiliyor, ama o kayıtlar listeye hiç girmediği için
                o dala erişilemiyordu — sahip yanlış karar verdiyse bu ekrandan
                DÖNEMİYORDU. Kuyruk disiplini korunuyor (varsayılan: yalnız açık
                iş), geri alma yolu geri geldi: çözülmüşler istendiğinde açılır. */}
            {cozulmusFark.length > 0 && (
              <button
                onClick={() => setFdCozulmusGoster((v) => !v)}
                style={{
                  marginBottom: 10, padding: '0 16px', minHeight: 40, borderRadius: 10,
                  border: `1px solid ${R.cizgi3}`, background: fdCozulmusGoster ? R.girinti : 'transparent',
                  color: R.not, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                }}
              >{fdCozulmusGoster ? '▾ karara bağlananları gizle' : `▸ karara bağlanan ${cozulmusFark.length} kaydı göster (kararı geri almak için)`}</button>
            )}
            <Liste satirlar={(fdCozulmusGoster ? [...acikFark, ...cozulmusFark] : acikFark).slice(0, 60).map((f) => {
              const fark = sayi(f.fark);
              const yazildi = /(gelire_yazildi|gidere_yazildi)/i.test(String(f.durum || ''));
              const kararli = /(girilen_dogru|evo_dogru)/i.test(String(f.durum || ''));
              const eylemler = [];
              if (!yazildi) {
                if (!kararli) {
                  eylemler.push({ ad: 'Kasa doğru', onTikla: () => setFdModal({ tip: 'karar', karar: 'girilen_dogru', kayit: f, aciklama: '' }) });
                  eylemler.push({ ad: 'Evo doğru', onTikla: () => setFdModal({ tip: 'karar', karar: 'evo_dogru', kayit: f, aciklama: '' }) });
                  // 🔵 (2026-08-12, Ops denetimi): para-yazma YALNIZ AÇIK farkta. Eskiden
                  // sadece `!yazildi` bakıyordu → 'kasa doğru/Evo doğru' (fark=veri hatası)
                  // denmiş satır sekmede KAPALI sayılırken listede "Gelire/Gidere yaz"
                  // sunuyordu (çelişki: kasa doğruysa fark gerçek para değildir).
                  if (fark > 0) eylemler.push({ ad: 'Gelire yaz', onTikla: () => setFdModal({ tip: 'gelire', kayit: f }) });
                  if (fark < 0) eylemler.push({ ad: 'Gidere yaz', onTikla: () => setFdModal({ tip: 'gidere', kayit: f }) });
                } else {
                  eylemler.push({ ad: 'Kararı geri al', onTikla: () => setFdModal({ tip: 'karar', karar: 'acik', kayit: f, aciklama: '' }) });
                }
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
            {/* ⚠️ KUYRUKTAN ÇIKARILANLAR GİZLENMEZ, SAYILIR. Kuyruğu gerçek
                işe indirmek, geri kalanı yok saymak değildir — biri "eksik
                kayıt", diğeri "karara bağlanmış", ikisi de bilgidir. */}
            {(kapanissizFark.length > 0 || cozulmusFark.length > 0 || acikFark.length > 60) && (
              <div style={{
                ...kartYuzey, padding: '12px 16px', marginTop: 10,
                fontSize: 12, color: R.not2, lineHeight: 1.7,
              }}>
                {acikFark.length > 60 && (
                  <div style={{ color: R.amber }}>
                    ⚠ {acikFark.length} açık farkın ilk 60'ı listeleniyor — {acikFark.length - 60} kayıt listede yok.
                  </div>
                )}
                {kapanissizFark.length > 0 && (
                  <div>
                    📭 <b style={{ color: R.not }}>{kapanissizFark.length} gün</b> için şube kapanış girmemiş;
                    Evo satışı kullanılmış. Bunlar <b>fark değildir</b> (karşılaştırılacak ikinci sayı yok) —
                    ayrı bir iş: eksik kapanış kaydı.
                  </div>
                )}
                {cozulmusFark.length > 0 && (
                  <div>✅ <b style={{ color: R.not }}>{cozulmusFark.length} kayıt</b> zaten karara bağlanmış — kuyrukta görünmez.</div>
                )}
              </div>
            )}
          </>
        ) : <BosDurum metin="Ciro farkı yok — kasa ile Evo satışı örtüşüyor. ✓" tamam />)}

        {fdModalBlok}

        {uzAlt === 'personel' && (acikPers.length === 0 ? (
          <BosDurum tamam baslik="Personel-vardiya uyumsuzluğu yok" aciklama="Vardiya kaydı ile fiili giriş-çıkış uyumlu." />
        ) : (
          <Tablo
            baslik="Personel ↔ vardiya uyumsuzlukları"
            not={'satıra tıkla → çöz'
              + (acikPers.length > 40 ? ` · ⚠ ${acikPers.length} kaydın ilk 40'ı gösteriliyor` : '')}
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
          // ⚠️ KARARIN VERİLDİĞİ YER: burada da yanlış alan okunuyordu, yani
          // sahip "Gönderilen 0" görerek uzlaştırma yapıyordu. Tablo ile aynı
          // yordam — ikisi bir daha ayrışamaz.
          const gon = uzSevkAdet(m.kayit);
          const kab = uzKabulAdet(m.kayit);
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
                      Gönderilen <b style={{ fontFamily: F.mono }}>{gon == null ? 'ölçülemedi' : gon}</b> ·
                      Kabul <b style={{ fontFamily: F.mono }}>{kab}</b> ·
                      {/* ⚠️ KARARIN VERİLDİĞİ SATIR (Fable, 2026-08-27):
                          burada `gon - kab` diye EKRAN KENDİ ARİTMETİĞİNİ
                          kuruyordu. Üstelik bu turda `gon`/`kab`ı null
                          dönebilir yaptığım için JS'te `null - 5 = -5` olup
                          aynı satırda hem "Gönderilen ölçülemedi" hem
                          "Fark −5" yazabiliyordu — uydurma bir rakamla
                          uzlaşma kararı. Fark artık tablonun kullandığı
                          TEK üreticiden (`uzFarkAdet`) geliyor. */}
                      Fark <b style={{ fontFamily: F.mono, color: R.amber }}>{
                        (() => {
                          const f = uzFarkAdet(m.kayit);
                          return f == null ? 'ölçülemedi' : (f > 0 ? `+${f}` : String(f));
                        })()
                      }</b>
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
                      {/* 🔵 EVV-OPS3-D: z_nakit "0"/"0.00" string gelirse `=== 0` susuyordu (uyarı çıkmaz). sayi() ile coerce. */}
                      {!devir && dj.z_nakit != null && sayi(dj.z_nakit) === 0 && Math.abs(fark) > 50 && (
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
    // A-2. tur: değer motoru artık TAM saklanıyor — ozet + kalem başına TL.
    const dOzet = depoDeger?.ozet || null;
    const degerMap = {};
    (Array.isArray(depoDeger?.urunler) ? depoDeger.urunler : []).forEach((u) => {
      if (u?.kalem_kodu) degerMap[String(u.kalem_kodu)] = u;
    });
    // Şube seçiliyse o şubenin değeri, değilse zincir toplamı. null = fiyat
    // yok → "—" (0 ₺ "değersiz" demek olurdu, fiyatsız kalem ölçülemez).
    const kalemDeger = (k) => {
      const u = degerMap[String(k.kalem_kodu || '')];
      if (!u) return null;
      if (depoSube) {
        const sd = (u.subeler || {})[depoSube];
        return sd ? sayi(sd.deger) : null;
      }
      return sayi(u.toplam_deger);
    };
    return (
      <>
        <KpiSeridi kpiler={[
          // ⚠️ SAHTE YEŞİL (2026-08-07 denetimi): "Kritik 0 · Düşük 0" ikisi de
          // YEŞİL yanarken alt satırda "337 şube-kalem sıfırda" yazıyordu.
          // Sunucu kuralı (_depo_stok_satir_alarm_mu + sayaç): mevcut<=0 olan
          // kalem "sıfır" kovasına gider, `elif` yüzünden "kritik" sayılmaz;
          // bardak dışı kalemlerde alarm eşiği zaten mevcut<=0'dır → o kova hep
          // BOŞ kalır. Yani "kritik 0" ölçüm sonucu değil, TANIM GEREĞİ sıfırdı.
          // Stokta OLMAYAN kalem, azalan kalemden daha acildir; öne alındı.
          {
            // ⚠️ ÇERÇEVELEME: bu ekranın EN BÜYÜK ve İLK sayısı, ama birimi
            // ekrandaki başka hiçbir sayıyla aynı değil: 367 = ŞUBE×KALEM çifti,
            // 4 şube üzerinden. Hemen yanındaki "Toplam kalem 134" ise 2 şubelik
            // kalem KARTI. Okuyan "367 nasıl 134'ten büyük olur" diye takılır ya
            // da — daha kötüsü — takılmaz ve yanlış bir büyüklük hissi taşır.
            etiket: 'Stokta yok',
            deger: dOzet ? String(sayi(dOzet.sifir_kalem_sayisi)) : '—',
            // 🔵 EVV-OPS3-C: dOzet yokken deger '—' ama renk yeşildi (bilinmeyen=temiz). Nötr.
            alt: dOzet
              ? `${sayi(dOzet.urun_sayisi)} ürün × tüm şubeler içinde · adet DEĞİL, şube-kalem çifti`
              : 'şube-kalem · mevcut sıfır',
            renk: !dOzet ? R.not3 : sayi(dOzet.sifir_kalem_sayisi) > 0 ? R.kirmizi : R.yesil,
          },
          // ══════════════════════════════════════════════════════════════
          // 🔴 KRİTİK KALEM: SUNUCU 3 DİYORDU, EKRAN 0 YAZIYORDU
          // ══════════════════════════════════════════════════════════════
          // Canlı ölçüm (2026-08-27):
          //   /ops/v2/depo-ozet  → kritik_kalem_sayisi = 3 · 4 şube · 157 ürün
          //   /ops/depo-stok     → 134 kalem · 2 şube · min_stok tanımlı: 5
          // Ekran ikinci uçtan KENDİ hesabını kuruyordu; 134 kalemin yalnız
          // 5'inde eşik tanımlı olduğu için sonuç yapısal olarak 0'a yakındı.
          // Yani "KRİTİK KALEM 0" bir ölçüm değil, ÖLÇEMEYİŞTİ — ve üç kritik
          // kalem yeşil bir sıfırın arkasında görünmüyordu. Stok tükenmesi
          // demek, satış kaybı demektir.
          // ⚠️ Sunucunun sayısı esastır (gösterim kendi aritmetiğini kurmaz).
          // Ekranın kendi hesabı kanıt olarak yanında durur; ikisi ayrışırsa
          // AYRIŞTIĞI YAZILIR — sessizce birini seçmek yanlış olurdu.
          (() => {
            const sunucuKritik = dOzet?.kritik_kalem_sayisi;
            const esikli = kalemler.filter((k) => sayi(k.min_stok) > 0).length;
            const kapsamZayif = kalemler.length > 0 && esikli / kalemler.length < 0.5;
            if (sunucuKritik == null) {
              return {
                etiket: 'Kritik kalem',
                deger: kapsamZayif ? '—' : String(kritik.length),
                alt: kapsamZayif
                  ? `⚠ ölçülemedi · ${kalemler.length} kalemin ${esikli} tanesinde eşik var`
                  : 'eşiğin altında',
                renk: kapsamZayif ? R.not3 : (kritik.length > 0 ? R.kirmizi : R.not),
              };
            }
            const ayristi = sayi(sunucuKritik) !== kritik.length;
            return {
              etiket: 'Kritik kalem',
              deger: String(sayi(sunucuKritik)),
              alt: ayristi
                ? `tüm şubeler · bu tablo ${kritik.length} görüyor (${kalemler.length} kalemin ${esikli}'inde eşik var)`
                : 'eşiğin altında',
              renk: sayi(sunucuKritik) > 0 ? R.kirmizi : R.not,
            };
          })(),
          // Düşük kalem yalnız EŞİĞİ OLAN kalemler için anlamlıdır; kapsam
          // zayıfsa 0 "sorun yok" demek değildir, "bakamıyorum" demektir.
          (() => {
            const esikli = kalemler.filter((k) => sayi(k.min_stok) > 0).length;
            const kapsamZayif = kalemler.length > 0 && esikli / kalemler.length < 0.5;
            return {
              etiket: 'Düşük kalem',
              deger: kapsamZayif ? '—' : String(dusuk.length),
              alt: kapsamZayif
                ? `⚠ ${kalemler.length} kalemin yalnız ${esikli}'inde eşik tanımlı`
                : 'eşiğe yaklaşıyor',
              renk: kapsamZayif ? R.not3 : (dusuk.length > 0 ? R.amber : R.not),
            };
          })(),
          {
            etiket: 'Toplam kalem',
            deger: String(kalemler.length),
            // ⚠️ KPI şeridindeki para/sıfır sayıları 4 ŞUBEYİ, bu tablo 2
            // ŞUBEYİ anlatıyor (canlı ölçüm). Yan yana duran iki sayının
            // farklı evrenleri varsa bu YAZILIR.
            alt: `stok kartı · bu tablo ${(subeler || []).length || 0} şube`,
          },
          // Adet ≠ para: 10.000 bardak ile 20 kg çekirdek aynı "kalem" ama
          // farklı sermaye. Sunucu değeri hesaplıyordu, ekran hiç göstermiyordu.
          {
            etiket: 'Depodaki para',
            deger: dOzet ? fmt(sayi(dOzet.toplam_stok_deger)) : '—',
            alt: dOzet
              ? `30 günde harcanan ${fmt(sayi(dOzet.toplam_harcama_deger))}`
              : 'alış fiyatı × mevcut',
            renk: R.bakirAcik,
          },
          // ⚠️ "Tüm şubeler" YANILTICIYDI: bu tablonun ucu 2 şube döndürüyor
          // (TEMA, ZAFER) ama üstteki para/sıfır sayıları 4 şubeyi kapsıyor.
          // "Tümü" derken hangi tümü olduğu yazılmalı.
          {
            etiket: 'Kapsam',
            deger: depoSube ? (subeler.find((s) => s.id === depoSube)?.ad || 'şube') : `${(subeler || []).length} şube`,
            alt: depoSube ? 'aşağıdan değiştir'
              : `stok kaydı olan şubeler${dOzet ? ' · üstteki para/sıfır tüm zinciri sayar' : ''}`,
          },
        ]} />

        {/* ── STOK DEVİR HIZI: "param kaç gün depoda bekliyor" ────────────── */}
        {stokDevir?.stok_gun != null && (() => {
          const sg = sayi(stokDevir.stok_gun);
          const renk = stokDevir.durum === 'saglikli' ? R.yesil
            : stokDevir.durum === 'yuksek' ? R.amber : R.kirmizi;
          const [bMin, bMax] = stokDevir.saglikli_bant_gun || [15, 30];
          // Bandın üstünde kalan pay ≈ rafta fazladan bekleyen nakit
          const fazla = sg > bMax && sayi(stokDevir.gunluk_harcama_tl) > 0
            ? (sg - bMax) * sayi(stokDevir.gunluk_harcama_tl) : 0;
          return (
            <div
              onClick={() => onCekmece?.({
                tip: 'STOK DEVİR HIZI',
                baslik: 'Param kaç gün depoda bekliyor?',
                alt: `son ${sayi(stokDevir.gun)} gün · sağlıklı bant ${bMin}-${bMax} gün`,
                kpi: [
                  { etiket: 'Stok günü', deger: `${trSayi(sg, 1)} gün`, renk },
                  { etiket: 'Depodaki para', deger: fmt(sayi(stokDevir.stok_deger_tl)), renk: R.bakirAcik },
                  { etiket: 'Günlük tüketim', deger: fmt(sayi(stokDevir.gunluk_harcama_tl)) },
                ],
                listeBaslik: 'Şube kırılımı — bağlı paraya göre',
                satirlar: (stokDevir.subeler || []).map((s) => ({
                  ad: s.sube_adi,
                  detay: s.harcama_yok
                    ? 'tüketim yok (sezon kapalı) — para bağlı duruyor'
                    : `${trSayi(sayi(s.stok_gun), 1)} gün · günlük ${fmt(sayi(s.gunluk_harcama_tl))}`,
                  tutar: fmt(sayi(s.stok_deger_tl)),
                })),
                not: `${stokDevir.not}${fazla > 0 ? ` · Bandın üstünde kalan ≈ ${fmt(fazla)} rafta bekliyor.` : ''}`,
              })}
              style={{
                ...kartYuzey, padding: '13px 17px', marginBottom: 14, cursor: 'pointer',
                borderLeft: `3px solid ${renk}`, display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap',
              }}
            >
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>📦 Stok devir hızı</span>
              <span style={{ fontSize: 13, color: R.metin2 }}>
                <b style={{ fontFamily: F.mono, color: renk, fontSize: 15 }}>{trSayi(sg, 1)} gün</b>
                {' '}stok tutuluyor · sağlıklı bant {bMin}-{bMax} gün
              </span>
              {fazla > 0 && (
                <span style={{ fontSize: 12, color: R.bakirAcik }}>
                  ≈ <b>{fmt(fazla)}</b> bandın üstünde rafta bekliyor
                </span>
              )}
              <span style={{ fontSize: 11, color: R.not, marginLeft: 'auto' }}>dokun → şube kırılımı</span>
            </div>
          );
        })()}

        {/* ŞUBE BAŞI STOK DEĞERİ — hangi şubede ne kadar sermaye bağlı.
            Kritik kalem sayısıyla birlikte okunur: az kalem + çok para = pahalı
            kalemlerde birikme, çok kalem + az para = ucuz sarf yığılması. */}
        {dOzet?.sube_basi && Object.keys(dOzet.sube_basi).length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {subeler.map((s) => {
              const sb = dOzet.sube_basi[s.id];
              if (!sb) return null;
              return (
                <div key={s.id} style={{ ...kartYuzey, padding: '10px 14px', borderRadius: 12, minWidth: 158 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 3 }}>{s.ad}</div>
                  <div style={{ fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: R.bakirAcik }}>
                    {fmt(sayi(sb.stok_deger))}
                  </div>
                  <div style={{ fontSize: 10.5, color: R.not2 }}>
                    {sayi(sb.kritik) ? `⚠ ${sayi(sb.kritik)} kritik · ` : ''}
                    {sayi(sb.sifir) ? `${sayi(sb.sifir)} sıfır · ` : ''}
                    30g harcama {fmt(sayi(sb.harcama_deger))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
            not={'satıra tıkla → şube kırılımı'
              + (kalemler.length > 120
                ? ` · ⚠ ${kalemler.length} kalemin ilk 120'si gösteriliyor, ${kalemler.length - 120} kalem listede yok`
                : '')}
            kolonlar={[
              { ad: 'Kalem' }, { ad: 'Kategori' }, { ad: 'Mevcut', sag: 1 },
              { ad: 'Bağlı para', sag: 1 },
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
                const deger = kalemDeger(k);
                return {
                  id: k.kalem_kodu,
                  _kalem: k,
                  hucreler: [
                    { v: k.kalem_adi, kalin: true },
                    { v: k.kategori || 'Diğer', renk: R.not },
                    { v: String(a), mono: true, sag: true, renk: d.renk, kalin: d.ad === 'kritik' },
                    // null = fiyat tanımsız → "—". Fiyatsız kalem maliyet
                    // motoruna da girmiyor (guven-skoru sapma listesiyle aynı dert).
                    deger == null
                      ? { v: '—', sag: true, renk: R.not3, sira: -1 }
                      : { v: fmt(deger), mono: true, sag: true, renk: R.bakirAcik, sira: deger },
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
                satirlar: subeler.map((sb) => {
                  const u = degerMap[String(k.kalem_kodu || '')];
                  const sd = u ? (u.subeler || {})[sb.id] : null;
                  return {
                    ad: sb.ad,
                    detay: sd && sayi(sd.harcanan) ? `30g harcanan ${sayi(sd.harcanan)} adet` : '',
                    tutar: `${sayi((k.adetler || {})[sb.id])} adet${sd && sd.deger != null ? ` · ${fmt(sayi(sd.deger))}` : ''}`,
                  };
                }),
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
    // ⚠️ Fable: `/stok-sayim/duzeltme-iz` düşerse `setSayimIz(null)` sessizce
    // yutuluyor, sonra `sayimIz || {}` yüzünden KPI "Ezilen kalem 0 · Karar
    // 0/0" basıyordu — sakin renkte, ölçülmüş bir sıfır gibi. Sayım defteri
    // okunamadığı gün "hiç düzeltme olmamış" görünüyordu. Depo görünümü bu
    // ayrımı zaten doğru yapıyor ("—"); aynı disiplin buraya da geldi.
    const izOkunamadi = sayimIz === null;
    const iz = sayimIz || {};
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Onay bekleyen sayım', deger: String(gorevler.length), alt: 'sahip onayı gerekli', renk: gorevler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Fark bulunan', deger: String(farkli.length), alt: 'sistemle uyuşmayan görev', renk: farkli.length > 0 ? R.kirmizi : R.krem },
          // ⚠️ DOYMA KONTROLÜ: sayılar pencere üzerinden hesaplandığı için,
          // kayıt sayısı istenen limite DAYANDIYSA rakamlar tavana takılmış
          // demektir ve toplam değil, pencere toplamıdır. Bunu söylemek
          // zorundayız — yoksa büyüyen defterde aynı yanılgı geri gelir.
          {
            etiket: 'Ezilen kalem (iz)',
            deger: izOkunamadi ? '—' : String(sayi(iz.ezilen_kalem)),
            alt: izOkunamadi ? '⚠ düzeltme izi okunamadı — "hiç düzeltme yok" DEMEK DEĞİL'
              : (sayi(iz.toplam_iz) >= 1000
                ? '⚠ 1000 kayıt penceresi doldu — gerçek toplam daha büyük olabilir'
                : `onayla stok değişti · ${sayi(iz.toplam_iz)} iz kaydı içinde`),
            renk: izOkunamadi ? R.not3 : (sayi(iz.ezilen_kalem) > 0 ? R.amber : R.krem),
          },
          {
            etiket: 'Karar dağılımı',
            deger: izOkunamadi ? '—' : `${sayi(iz.karar_sayim)} / ${sayi(iz.karar_sistem)}`,
            // ⚠️ ÇERÇEVELEME: "543 / 0" nötr bir dağılım gibi sunuluyordu ama
            // yüksek sesle bir şey söylüyor: 543 düzeltmenin HEPSİNDE sayım
            // kabul edilmiş, sistemin kendi rakamı BİR KEZ BİLE korunmamış.
            // Bu ya "sistem stoğu hep yanlış tutuyor" ya da "akışta 'sistemi
            // koru' seçeneği fiilen kullanılmıyor" demektir. İkisi de bilgidir;
            // nötr bir kesir olarak geçiştirilemez.
            alt: izOkunamadi ? 'okunamadı'
              : (sayi(iz.toplam_iz) >= 1000 ? '⚠ pencere doldu — kısmi'
                : (sayi(iz.karar_sayim) > 0 && sayi(iz.karar_sistem) === 0
                  ? 'sayım kabul / sistem korundu — sistem hiç korunmadı'
                  : 'sayım kabul / sistem korundu')),
          },
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
            kolonlar={[
              { ad: 'Zaman' }, { ad: 'Kalem' }, { ad: 'Eski', sag: 1 },
              { ad: 'Sayılan', sag: 1 }, { ad: 'Yeni', sag: 1 }, { ad: 'Δ', sag: 1 }, { ad: 'Karar' },
            ]}
            not={'envanter_duzeltme defteri (salt-okur)'
              + ((iz.ornekler || []).length > 12
                ? ` · ⚠ ${iz.ornekler.length} düzeltmenin ilk 12'si gösteriliyor, ${iz.ornekler.length - 12} kayıt listede yok`
                : '')}
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
    const hrSatir = Array.isArray(hareket?.satirlar) ? hareket.satirlar : [];
    const bugunku = hrSatir.filter((h) => String(h.zaman || '').slice(0, 10) === bugun);
    const say = (f) => hrSatir.filter(f).length;
    // Sunucunun hazır kırılımları (tur_ozet / sube_ozet) — istemcide yeniden
    // hesaplanmaz; miktar toplamları (giriş/çıkış adet) yalnız burada var.
    const hrSube = Array.isArray(hareket?.sube_ozet) ? hareket.sube_ozet : [];
    const hrTur = Array.isArray(hareket?.tur_ozet) ? hareket.tur_ozet : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün kayıt', deger: String(bugunku.length), alt: 'stok hareketi' },
          // ⚠️ Codex: hemen üstte sunucunun `tur_ozet` kırılımı DURUYOR ama
          // KPI'lar istemcide `turCoz()` ile yeniden sayılıyordu. Sunucu yeni
          // bir tür ekler ya da adlandırmayı değiştirirse KPI ile altındaki
          // tür dağılımı FARKLI konuşur — aynı ekranda iki gerçek.
          // Sunucu kırılımı varsa esas odur; yoksa istemci sayımı yedektir ve
          // yedeğe düşüldüğü YAZILIR.
          (() => {
            const sunucu = hrTur.filter((t) => turCoz(t.hareket_turu || t.tur).ad === 'giriş')
              .reduce((a, t) => a + sayi(t.adet ?? t.kayit ?? t.sayi), 0);
            return {
              etiket: 'Giriş (3 gün)',
              deger: String(hrTur.length ? sunucu : say((h) => turCoz(h.hareket_turu).ad === 'giriş')),
              alt: hrTur.length ? 'teslim + kabul' : 'teslim + kabul · ekrandan sayıldı',
              renk: R.yesil,
            };
          })(),
          (() => {
            const sunucu = hrTur.filter((t) => turCoz(t.hareket_turu || t.tur).ad === 'çıkış')
              .reduce((a, t) => a + sayi(t.adet ?? t.kayit ?? t.sayi), 0);
            return {
              etiket: 'Çıkış (3 gün)',
              deger: String(hrTur.length ? sunucu : say((h) => turCoz(h.hareket_turu).ad === 'çıkış')),
              alt: hrTur.length ? 'sevk + ürün aç' : 'sevk + ürün aç · ekrandan sayıldı',
            };
          })(),
          // ⚠️ Fable: bu KPI hâlâ istemcide, üstelik sunucudan `limit=150` ile
          // gelen pencereden sayılıyordu. 3 günde 150'den çok hareket olursa
          // FİRE sayısı sessizce eksik çıkar — fire doğrudan para kaybı
          // sayacıdır. Komşu iki KPI sunucu kırılımını kullanıyor; bu da öyle.
          (() => {
            const sunucu = hrTur
              .filter((t) => ['fire', 'sayım'].includes(turCoz(t.hareket_turu || t.tur).ad))
              .reduce((a, t) => a + sayi(t.adet ?? t.kayit ?? t.sayi), 0);
            const fireSunucu = hrTur
              .filter((t) => turCoz(t.hareket_turu || t.tur).ad === 'fire')
              .reduce((a, t) => a + sayi(t.adet ?? t.kayit ?? t.sayi), 0);
            const varmi = hrTur.length > 0;
            const deger = varmi ? sunucu : say((h) => ['fire', 'sayım'].includes(turCoz(h.hareket_turu).ad));
            const fire = varmi ? fireSunucu : say((h) => turCoz(h.hareket_turu).ad === 'fire');
            return {
              etiket: 'Fire + sayım (3 gün)',
              deger: String(deger),
              alt: varmi ? 'düzeltme dahil' : 'düzeltme dahil · ekrandan sayıldı (150 kayıt penceresi)',
              renk: fire > 0 ? R.kirmizi : R.krem,
            };
          })(),
        ]} />

        {/* ŞUBE KIRILIMI — sunucu hareket adedinin yanında MİKTAR toplamlarını
            da veriyor (giriş/çıkış adedi). Satır listesinden bu türetilemezdi;
            ekran yalnız kayıt sayısını gösteriyordu. */}
        {hrSube.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {hrSube.map((s, i) => (
              <div key={s.sube_id || i} style={{
                ...kartYuzey, padding: '10px 14px', borderRadius: 12, minWidth: 150,
              }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 3 }}>{s.sube_ad || s.sube_id}</div>
                <div style={{ fontSize: 11, color: R.not2, fontFamily: F.mono }}>
                  <span style={{ color: R.yesil }}>+{sayi(s.toplam_giris)}</span>
                  {' / '}
                  <span style={{ color: R.bakir }}>−{sayi(s.toplam_cikis)}</span>
                  <span style={{ color: R.not3 }}> · {sayi(s.hareket_adet)} kayıt</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TÜR DAĞILIMI — hangi hareket tipi kaç kez (sunucu sıralı gönderiyor) */}
        {hrTur.length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
            {hrTur.length > 8 && (
              <span style={{ fontSize: 11, color: R.not3, alignSelf: 'center' }}>
                ⚠ {hrTur.length} türün ilk 8'i · {hrTur.length - 8} tür daha var
              </span>
            )}
            {hrTur.slice(0, 8).map((t, i) => {
              const tc = turCoz(t.hareket_turu);
              return (
                <span key={i} style={{
                  padding: '5px 11px', borderRadius: 99, fontSize: 11,
                  background: `${tc.renk}18`, color: tc.renk, fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  {t.hareket_turu} <b style={{ fontFamily: F.mono }}>{sayi(t.adet)}</b>
                </span>
              );
            })}
          </div>
        )}

        {hrSatir.length === 0 ? (
          <BosDurum metin="Son 3 günde stok hareketi kaydı yok." />
        ) : (
          <Tablo
            baslik="Stok hareketi · son 3 gün"
            kolonlar={[
              { ad: 'Zaman' }, { ad: 'Tür' }, { ad: 'Kalem' }, { ad: 'Şube' },
              { ad: 'Miktar', sag: 1 }, { ad: 'Önce → sonra', sag: 1 }, { ad: 'Kaynak' },
            ]}
            not={'defter kaydı silinmez, değiştirilmez — yalnız üstüne yazılır'
              + (hrSatir.length > 60
                ? ` · ⚠ ${hrSatir.length} hareketin ilk 60'ı gösteriliyor, ${hrSatir.length - 60} kayıt listede yok (defter eksik görünür)`
                : '')}
            satirlar={hrSatir.slice(0, 60).map((h, i) => {
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

  // ════════════════════════ GÖRÜNÜM: SİPARİŞ ARŞİVİ ═════════════════════════
  // Sahip kararı (soru 1/9, 2026-08-03): AYRI görünüm. Kanban 14 günlük AÇIK
  // işi gösterir; bu ekran KAPANMIŞ dahil tüm geçmişi. "Geçen ay Köyceğiz'e ne
  // gönderdik?" sorusunun cevabı. Sevkiyat rapor tarihçesi ikinci sekmede.
  if (gorunum === 'siparisarsiv') {
    if (arsivHata) return <HataBandi mesaj={arsivHata} onTekrar={() => arsivYukle(arsivGun, arsivDurum, arsivArama)} />;
    if (!arsivVeri) return <Yukleniyor />;
    const arSatir = Array.isArray(arsivVeri.satirlar) ? arsivVeri.satirlar : [];
    const arOzet = arsivVeri.ozet || {};
    const raporlar = Array.isArray(arsivRapor) ? arsivRapor : [];
    // Durum sözlüğü — /ops/siparis/gecmis valid_durumlar ile birebir
    const AR_DURUM = {
      bekliyor: { ad: 'bekliyor', renk: R.amber },
      hazirlaniyor: { ad: 'hazırlanıyor', renk: R.mavi },
      gonderildi: { ad: 'gönderildi', renk: R.bakir },
      teslim_edildi: { ad: 'teslim edildi', renk: R.yesil },
      iptal: { ad: 'iptal', renk: R.not3 },
      gonderilmedi: { ad: 'GÖNDERİLMEDİ', renk: R.kirmizi },
      // ⚠️ DÜZ-DİL ETİKET (desen 7) — canlı gözlem 2026-08-27:
      // Arşiv tablosunda durum sütunu `kabul_uyusmazlik` diye HAM VERİTABANI
      // değeri gösteriyordu; komşu satırlar "gönderildi", "teslim edildi"
      // derken. Haritada karşılığı olmayan durum, olduğu gibi ekrana düşüyor.
      // Sahip kod okumaz: alt çizgili, Türkçe karaktersiz bir kelime ona
      // sistemin bozuk olduğunu düşündürür.
      kabul_uyusmazlik: { ad: 'kabul uyuşmazlığı', renk: R.kirmizi },
    };
    const filtrele = (g, d, a) => { arsivYukle(g, d, a); };
    const yenidenAc = async (talep) => {
      if (arsivMesgul) return;   // 🔁 (2026-08-12) çift-tık: aynı siparişi iki kez yeniden-açma
      setArsivMesgul(String(talep.id));
      try {
        await api(`/ops/siparis/gecmis/${encodeURIComponent(talep.id)}/yeniden-ac`, { method: 'POST' });
        onToast?.('✓ Sipariş kuyruğa döndü — Sipariş Akışı ▸ bekliyor kolonunda');
        arsivYukle(arsivGun, arsivDurum, arsivArama);
      } catch (e) {
        onToast?.(e?.message || 'Yeniden açılamadı');
      } finally { setArsivMesgul(''); }
    };
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Kayıt', deger: String(sayi(arsivVeri.toplam)), alt: `son ${sayi(arsivVeri.gun) || arsivGun} gün${arsivVeri.sube_arama ? ` · "${arsivVeri.sube_arama}"` : ''}` },
          // ══════════════════════════════════════════════════════════════
          // ⚠️ KENDİ YANLIŞ DÜZELTMEMİ GERİ ALDIM — 2026-08-27
          // ══════════════════════════════════════════════════════════════
          // Codex burayı "sahte yeşil" diye işaretledi, ben de ÖLÇMEDEN kabul
          // edip "alan yoksa ölçülemedi" yazdım. Sonra ucu ölçtüm:
          //   /ops/siparis/gecmis → ozet = { teslim_edildi:16, iptal:2,
          //                                  kabul_uyusmazlik:4, gonderildi:7 }
          // Bu bir DURUM HİSTOGRAMI: anahtarlar durum adları. `gonderilmedi`
          // anahtarının OLMAMASI "okunamadı" değil, "o durumda hiç kayıt yok"
          // demektir — yani gerçekten 0. Benim düzeltmem gerçek bir sıfırı
          // "ölçülemedi" diye gösteriyordu: düzeltmeye çalıştığım kusurun
          // AYNADAKİ hâli (bu kez boş alanı yok saymak yerine, var olan bilgiyi
          // yok saymak).
          // ⚠️ DOĞRU AYRIM: ÖZETİN KENDİSİ yoksa "—" (okunamadı); özet varsa
          // eksik anahtar 0'dır ve 0 yazılır.
          {
            etiket: 'Teslim edildi',
            deger: arsivVeri.ozet ? String(sayi(arOzet.teslim_edildi)) : '—',
            alt: arsivVeri.ozet ? 'zincir kapandı' : 'özet okunamadı',
            renk: arsivVeri.ozet ? R.yesil : R.not3,
          },
          {
            etiket: 'Gönderilmedi',
            deger: arsivVeri.ozet ? String(sayi(arOzet.gonderilmedi)) : '—',
            alt: !arsivVeri.ozet ? '⚠ özet okunamadı — "takılan yok" DEMEK DEĞİL'
              : (sayi(arOzet.gonderilmedi) ? 'kuyruğa geri alınabilir' : 'takılan yok'),
            renk: !arsivVeri.ozet ? R.not3
              : (sayi(arOzet.gonderilmedi) ? R.kirmizi : R.yesil),
          },
          {
            etiket: 'İptal',
            deger: arsivVeri.ozet ? String(sayi(arOzet.iptal)) : '—',
            alt: arsivVeri.ozet ? `bekleyen ${sayi(arOzet.bekliyor)}` : 'özet okunamadı',
            renk: R.not,
          },
          // ⚠️ Fable: özet histogramında DOLU ve KIRMIZI bir durum vardı —
          // `kabul_uyusmazlik` (şube teslim aldı ama adet tutmadı = stok/para
          // farkı) — ama manşette yoktu; ancak filtre çipine tıklayan bulurdu.
          // "Gönderilmedi 0" yeşilini gören sahip, dolu olan uyuşmazlığı
          // kaçırıyordu. En kırmızı sayı en görünür yerde durmalı.
          {
            etiket: 'Kabul uyuşmazlığı',
            deger: arsivVeri.ozet ? String(sayi(arOzet.kabul_uyusmazlik)) : '—',
            alt: !arsivVeri.ozet ? 'özet okunamadı'
              : (sayi(arOzet.kabul_uyusmazlik) ? 'teslim alındı, adet tutmadı' : 'adet farkı yok'),
            renk: !arsivVeri.ozet ? R.not3
              : (sayi(arOzet.kabul_uyusmazlik) ? R.kirmizi : R.yesil),
          },
        ]} />

        {/* filtre çubuğu: gün · durum · şube arama */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          {[30, 90, 180, 365].map((g) => (
            <div key={g} onClick={() => { setArsivGun(g); filtrele(g, arsivDurum, arsivArama); }} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${arsivGun === g ? R.bakir : R.cizgi3}`,
              color: arsivGun === g ? R.bakir : R.metin2,
              background: arsivGun === g ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{g} gün</div>
          ))}
          <span style={{ width: 1, height: 20, background: R.cizgi3 }} />
          {[['', 'tümü'], ...Object.entries(AR_DURUM).map(([k, v]) => [k, v.ad])].map(([k, ad]) => (
            <div key={k || 'tum'} onClick={() => { setArsivDurum(k); filtrele(arsivGun, k, arsivArama); }} style={{
              padding: '6px 12px', borderRadius: 99, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${arsivDurum === k ? R.bakir : R.cizgi3}`,
              color: arsivDurum === k ? R.bakir : R.not,
              background: arsivDurum === k ? 'rgba(217,154,78,.14)' : 'transparent',
            }}>{ad}</div>
          ))}
          <input
            value={arsivArama}
            onChange={(e) => setArsivArama(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && filtrele(arsivGun, arsivDurum, arsivArama)}
            placeholder="Şube ara… (Enter)"
            style={{
              marginLeft: 'auto', padding: '7px 12px', borderRadius: 10, width: 150,
              border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
              fontSize: 12, fontFamily: 'inherit', outline: 'none',
            }}
          />
        </div>

        {/* alt sekmeler: sipariş arşivi · sevkiyat raporları */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[['siparis', `📦 Siparişler (${arSatir.length})`], ['rapor', `📝 Sevkiyat raporları (${raporlar.length})`]].map(([id, ad]) => (
            <div key={id} onClick={() => setArsivSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${arsivSekme === id ? R.bakir : R.cizgi3}`,
              color: arsivSekme === id ? R.bakir : R.metin2,
              background: arsivSekme === id ? 'rgba(217,154,78,.14)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {arsivSekme === 'siparis' && (arSatir.length ? (
          <Tablo
            baslik={`Sipariş arşivi · son ${sayi(arsivVeri.gun) || arsivGun} gün`}
            not={'tüm durumlar dahil · satıra tıkla → kalem dökümü'
              + (arSatir.length > 120
                ? ` · ⚠ ${arSatir.length} kaydın ilk 120'si gösteriliyor, ${arSatir.length - 120} sipariş listede yok`
                : '')}
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Durum' },
              { ad: 'Kalem', sag: 1 }, { ad: 'Toplam adet', sag: 1 }, { ad: '' },
            ]}
            satirlar={arSatir.slice(0, 120).map((t, i) => {
              const dr = AR_DURUM[t.durum] || { ad: t.durum || '—', renk: R.not };
              return {
                id: t.id || `ar-${i}`, _t: t,
                hucreler: [
                  { v: tarihKisa(t.tarih), mono: true, renk: R.not },
                  { v: t.sube_adi || '—', kalin: true },
                  { v: dr.ad, rozet: dr.renk },
                  { v: String((t.kalemler || []).length), mono: true, sag: true, renk: R.not },
                  { v: String(sayi(t.kalem_adet_toplam)), mono: true, sag: true, kalin: true },
                  t.durum === 'gonderilmedi'
                    ? { v: arsivMesgul === String(t.id) ? '…' : '↩ kuyruğa al', renk: R.bakirAcik }
                    : { v: '', renk: R.not3 },
                ],
              };
            })}
            onSatir={({ _t }) => {
              const dr = AR_DURUM[_t.durum] || { ad: _t.durum || '—', renk: R.not };
              onCekmece?.({
                tip: 'ARŞİV · SİPARİŞ',
                baslik: `${_t.sube_adi || 'Şube'} · ${tarihKisa(_t.tarih)}`,
                alt: `${dr.ad}${_t.sevkiyat_ts ? ` · sevk ${String(_t.sevkiyat_ts).slice(0, 16).replace('T', ' ')}` : ''}`,
                kpi: [
                  { etiket: 'Durum', deger: dr.ad, renk: dr.renk },
                  { etiket: 'Kalem', deger: String((_t.kalemler || []).length) },
                  { etiket: 'Toplam adet', deger: String(sayi(_t.kalem_adet_toplam)) },
                ],
                listeBaslik: 'Kalemler',
                // ⚠️ Fable: KPI "Kalem: 45" derken liste 30'da kesiliyor ve
                // "15 kalem gösterilmiyor" denmiyordu — dosyanın başka her
                // tablosu taşmayı sayıyla söylerken tek istisna burasıydı.
                satirlar: [
                  ...(_t.kalemler || []).slice(0, 30).map((k) => ({
                    ad: k?.urun_ad || k?.kalem_adi || '—',
                    detay: k?.birim ? String(k.birim) : '',
                    tutar: `${sayi(k?.adet)} adet`,
                  })),
                  ...((_t.kalemler || []).length > 30 ? [{
                    ad: `… ve ${(_t.kalemler || []).length - 30} kalem daha`,
                    detay: 'liste ilk 30 kalemi gösterir · tamamı sipariş kaydında',
                    tutar: '',
                  }] : []),
                ],
                not: _t.durum === 'gonderilmedi'
                  ? 'Bu sipariş GÖNDERİLMEDİ olarak kapanmış. "Kuyruğa al" onu Sipariş Akışı\'nın bekliyor kolonuna geri döndürür — yeni kayıt açmaz.'
                  : 'Arşiv salt-okurdur. Açık işler Sipariş Akışı kanbanında yönetilir.',
                ...(_t.durum === 'gonderilmedi' ? {
                  aksiyonlar: [{ ad: '↩ Kuyruğa geri al', birincil: true, onTikla: () => yenidenAc(_t) }],
                } : {}),
              });
            }}
          />
        ) : <BosDurum metin="Bu filtreyle arşivde sipariş yok." />)}

        {arsivSekme === 'rapor' && (raporlar.length ? (
          <Tablo
            baslik="Depo sevkiyat raporları · tarihçe"
            not={'sevkiyat hazırlanırken yazılan rapor metinleri · satıra tıkla → tam metin'
              + (raporlar.length > 60 ? ` · ⚠ ${raporlar.length} raporun ilk 60'ı gösteriliyor` : '')}
            kolonlar={[
              { ad: 'Rapor tarihi' }, { ad: 'Depo' }, { ad: 'Talep eden şube' },
              { ad: 'Personel' }, { ad: 'Durum' },
            ]}
            satirlar={raporlar.slice(0, 60).map((r, i) => ({
              id: r.id || `rp-${i}`, _r: r,
              hucreler: [
                { v: String(r.depo_sevkiyat_rapor_ts || r.tarih || '').slice(0, 16).replace('T', ' '), mono: true, renk: R.not },
                { v: r.hedef_depo_adi || '—', kalin: true },
                { v: r.talep_sube_adi || '—', renk: R.not },
                { v: r.depo_personel_ad || '—', renk: R.not2 },
                r.depo_sevkiyat_rapor_uyari
                  ? { v: 'uyarılı', rozet: R.amber }
                  : { v: r.sevkiyat_durumu || r.durum || '—', renk: R.not },
              ],
            }))}
            onSatir={({ _r }) => onCekmece?.({
              tip: 'SEVKİYAT RAPORU',
              baslik: `${_r.hedef_depo_adi || 'Depo'} → ${_r.talep_sube_adi || 'şube'}`,
              alt: `${String(_r.depo_sevkiyat_rapor_ts || '').slice(0, 16).replace('T', ' ')}${_r.depo_personel_ad ? ` · ${_r.depo_personel_ad}` : ''}`,
              kpi: [
                { etiket: 'Durum', deger: _r.sevkiyat_durumu || _r.durum || '—' },
                { etiket: 'Uyarı', deger: _r.depo_sevkiyat_rapor_uyari ? 'var' : 'yok', renk: _r.depo_sevkiyat_rapor_uyari ? R.amber : R.yesil },
              ],
              listeBaslik: 'Rapor metni',
              satirlar: [{ ad: _r.depo_sevkiyat_rapor_metni || '—', detay: '', tutar: '' }],
              not: _r.depo_sevkiyat_rapor_uyari
                ? `⚠ ${_r.depo_sevkiyat_rapor_uyari}`
                : 'Depo personelinin sevkiyatı hazırlarken bıraktığı not — salt-okur tarihçe.',
            })}
          />
        ) : <BosDurum metin="Bu dönemde yazılmış sevkiyat raporu yok." />)}
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
    // 🔵 EVV-OPS3-B: "teslim bekleyen" = kapandı AMA teslim kaydı YOK (teslim_var false).
    // Eskiden `!sayi(teslim_kasa_tl)` idi → gerçek 0 TL teslim (kart-günü) de "bekleyen" sayılıyordu.
    const teslimBekleyen = kapanisSatir.filter((x) => x.kapanis_tamam && !x.teslim_var);
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
          // ⚠️ "bugün" etiketi artık İŞ GÜNÜNE göre; gece penceresindeyse
          // takvimle iş gününün ayrıştığı SÖYLENİYOR.
          { etiket: 'Açılan şube', deger: `${acilanSube} / ${acilisSatir.length}`, alt: barTarih === isGunuBugun() ? (isGunuKaymasiVar() ? 'bugün (iş günü — takvim yarını gösteriyor)' : 'bugün') : barTarih, renk: acilanSube === acilisSatir.length && acilisSatir.length ? R.yesil : R.amber },
          { etiket: 'Kapanan şube', deger: `${kapananSube} / ${kapanisSatir.length}`, alt: kapananSube < kapanisSatir.length ? 'kapanış bekleniyor' : 'tamamlandı', renk: kapananSube === kapanisSatir.length && kapanisSatir.length ? R.yesil : R.amber },
          // ══════════════════════════════════════════════════════════════
          // 🔴 SAHTE SAKİNLİK — canlı gözlem 2026-08-27
          // ══════════════════════════════════════════════════════════════
          // Ekran "AÇILIŞ FARKI 0 · devirle uyumlu" (YEŞİL) diyordu. Ama:
          //  ① 4 şubenin YALNIZ 2'si ölçülmüştü (ALSANCAK ve KÖYCEĞİZ'de
          //     açılış tamamlanmamış → sayılan yok, beklenen yok, fark yok).
          //     Ölçülmemiş şube "uyumlu" sayılamaz; hiç tartılmamış demektir.
          //  ② Hemen ALTINDAKİ bant "1 şubede açılış farkı kayda düşmüş ve
          //     henüz çözülmemiş" diyordu. `uyumsuzBekleyen` yalnız
          //     `farkUyariAdet > 0` iken alt yazıya giriyordu — yani AÇIK bir
          //     uyumsuzluk varken üstteki kart yeşil kalıyordu.
          // İkisi birden: sahip "sabah kasaları tuttu" diye ekranı kapatır.
          (() => {
            // ⚠️ Alan adları TAHMİN EDİLMEDİ, uçtan okundu (canlı):
            // acilis_tamam · fark_tl · fark_seviye · uyumsuzluk_bekliyor.
            // İlk yazışta `r.fark`/`r.sayilan` yazmıştım — o alanlar YOK;
            // hepsi null çıkıp "4 şube ölçülmedi" diye kendi yanlış alarmımı
            // üretecekti. Ölçülmüşlüğün kanıtı `acilis_tamam`tır.
            const olculen = acilisSatir.filter((r) => r.acilis_tamam || r.fark_seviye != null).length;
            const eksikOlcum = acilisSatir.length - olculen;
            const acikVar = sayi(uyumsuzBekleyen) > 0;
            const temiz = !farkUyariAdet && !acikVar && !eksikOlcum;
            return {
              etiket: 'Açılış farkı',
              deger: String(farkUyariAdet),
              alt: [
                farkUyariAdet ? 'tolerans üstü' : (eksikOlcum ? 'ölçülen şubelerde tolerans içi' : 'devirle uyumlu (±50 tolerans)'),
                eksikOlcum ? `⚠ ${eksikOlcum} şube henüz ölçülmedi (${olculen}/${acilisSatir.length})` : null,
                acikVar ? `⚠ ${sayi(uyumsuzBekleyen)} açık kayıt çözülmedi` : null,
                sayi(uyumsuzCozulen) ? `${sayi(uyumsuzCozulen)} çözüldü` : null,
              ].filter(Boolean).join(' · '),
              // Yeşil YALNIZ her şube ölçüldüyse ve açık kayıt yoksa.
              renk: farkUyariAdet ? R.kirmizi : (temiz ? R.yesil : R.amber),
            };
          })(),
          { etiket: 'Teslim bekleyen', deger: String(teslimBekleyen.length), alt: 'kapandı ama kasa teslim edilmedi', renk: teslimBekleyen.length ? R.amber : R.yesil },
          {
            etiket: 'Ciro onayı',
            deger: `${ciroOnaylanan} / ${kapanisSatir.length}`,
            alt: eksikCiro
              ? `${eksikCiro} şubede ciro hiç girilmedi`
              : taslakBekleyen ? `${taslakBekleyen} taslak onay bekliyor` : 'tamamlandı',
            renk: eksikCiro ? R.kirmizi : taslakBekleyen ? R.amber : R.yesil,
          },
          // ⚠️ Fable: "Açılış farkı" kartında düzeltilen SAHTE SAKİNLİK'in
          // kardeşi burada duruyordu. 4 şubenin 1'i kapanmışken bile fark
          // yoksa kart YEŞİL "denklem tutuyor" diyordu; hiç kapanmamışken de
          // yeşildi. Ölçülmemiş şube "tutuyor" sayılamaz — hiç tartılmamıştır.
          (() => {
            const kapanmayan = Math.max(0, kapanisSatir.length - kapananSube);
            const temiz = !kasaFarkli.length && kapananSube > 0 && kapanmayan === 0;
            return {
              etiket: 'Nakit Δ',
              deger: kasaFarkli.length ? String(kasaFarkli.length) : '0',
              alt: [
                kasaFarkli.length
                  ? (kasaAcikToplam > 0 ? `${tl(kasaAcikToplam)} kasa açığı` : 'fark var, açık yok')
                  : (kapananSube ? 'kapanan şubelerde denklem tutuyor' : 'hiçbir şube kapanmadı'),
                kapanmayan ? `⚠ ${kapanmayan} şube henüz kapanmadı (${kapananSube}/${kapanisSatir.length})` : null,
              ].filter(Boolean).join(' · '),
              renk: kasaFarkli.length ? R.kirmizi : (temiz ? R.yesil : R.amber),
            };
          })(),
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

            {/* ── SAATİNDE AÇILDI MI? (kasa tuttu mu'dan AYRI soru) ──
                Üç durum ayrı ayrı: geç açıldı · açılış başladı ama bitmedi ·
                o gün hiç ACILIS kaydı oluşmadı (panel/motor çalışmamış).
                Sonuncusu en sinsisi: "sorun yok" gibi görünür, aslında ÖLÇÜM YOK. */}
            {gecAcilis && (() => {
              const gecler = Array.isArray(gecAcilis.kayitlar) ? gecAcilis.kayitlar : [];
              const acilmayan = Array.isArray(gecAcilis.acilmayan_subeler) ? gecAcilis.acilmayan_subeler : [];
              const kayitsiz = Array.isArray(gecAcilis.plan_kayitsiz_subeler) ? gecAcilis.plan_kayitsiz_subeler : [];
              if (!gecler.length && !acilmayan.length && !kayitsiz.length) return null;
              const esik = sayi(gecAcilis.gecikme_uyari_esik_dk) || 15;
              const kritik = gecler.filter((g) => g.gecikme_seviye === 'kritik');
              return (
                <div style={{
                  ...kartYuzey, padding: '13px 18px', marginBottom: 12,
                  borderColor: kritik.length ? `${R.kirmizi}55` : `${R.amber}44`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                    <span style={rozetHap(kritik.length ? R.kirmizi : R.amber)}>⏰ açılış saati</span>
                    <span style={{ fontSize: 12, color: R.not }}>
                      {gecler.length ? `${gecler.length} şube geç açıldı` : 'geç açılan yok'}
                      {kritik.length ? ` (${kritik.length} kritik)` : ''}
                      {acilmayan.length ? ` · ${acilmayan.length} şubede açılış başladı ama tamamlanmadı` : ''}
                      {kayitsiz.length ? ` · ${kayitsiz.length} şubede hiç açılış kaydı oluşmadı` : ''}
                      {` — eşik ${esik} dk`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {gecler.length > 6 && (
                      <div style={{ fontSize: 11, color: R.not3 }}>
                        ⚠ {gecler.length} kaydın ilk 6'sı gösteriliyor ({gecler.length - 6} tanesi listede yok)
                      </div>
                    )}
                    {gecler.slice(0, 6).map((g, i) => (
                      <div key={g.event_id || `gc-${i}`} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                        borderLeft: `3px solid ${g.gecikme_seviye === 'kritik' ? R.kirmizi : R.amber}`,
                      }}>
                        <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 82 }}>{g.sube_adi || '—'}</span>
                        <span style={{ flex: 1, minWidth: 0, color: R.not2, fontFamily: F.mono }}>
                          plan {String(g.planlanan_saat || '').slice(0, 5) || '—'} → açılış {g.acilis_saat || '—'}
                          {g.personel_ad ? ` · ${g.personel_ad}` : ''}
                          {g.vardiya_planli === false ? ' · vardiya planı yok' : ''}
                        </span>
                        <span style={{
                          flexShrink: 0, fontFamily: F.mono, fontWeight: 700,
                          color: g.gecikme_seviye === 'kritik' ? R.kirmizi : R.amber,
                        }}>+{sayi(g.gecikme_dk)} dk</span>
                      </div>
                    ))}
                    {acilmayan.map((a, i) => (
                      <div key={`ac-${i}`} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                        borderLeft: `3px solid ${R.amber}`,
                      }}>
                        <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 82 }}>{a.sube_adi || '—'}</span>
                        <span style={{ flex: 1, minWidth: 0, color: R.not2 }}>
                          açılış <b>tamamlanmadı</b> ({a.durum || 'bekliyor'})
                          {a.beklenen_saat ? ` · beklenen ${a.beklenen_saat}` : ''}
                          {/* 🔵 EVV-OPS2-N3 (2026-08-13): `beklened_personel` typo → beklenen personel adı hiç görünmüyordu */}
                          {a.beklenen_personel ? ` · ${a.beklenen_personel}` : ''}
                        </span>
                      </div>
                    ))}
                    {kayitsiz.map((p, i) => (
                      <div key={`pk-${i}`} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                        borderLeft: `3px solid ${R.not3}`,
                      }}>
                        <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 82 }}>{p.sube_adi || '—'}</span>
                        <span style={{ flex: 1, minWidth: 0, color: R.not2 }}>
                          bu gün için <b>hiç açılış kaydı oluşmamış</b> — panel ya da motor çalışmamış
                          {p.plan_acilis_saati ? ` · plan ${p.plan_acilis_saati}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            <Tablo
              baslik={`Açılış kasası · ${tarihKisa(barTarih)}`}
              not={`${acilisTakip?.dunku_kapanis_tarih ? `${tarihKisa(acilisTakip.dunku_kapanis_tarih)} kapanış devri ile karşılaştırılır` : 'dünkü kapanış devri ile sabah sayımı karşılaştırılır'} · fark eşiği ±50 normal, 200+ kritik · satıra tıkla → ham sabah sayımı`}
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
                // ⚠️ Fable: yorum "5 TL kırmızı olmamalı" derken YEDEK DAL tam
                // bunu yapıyordu — seviye alanı gelmezse tolerans bandı yok
                // sayılıp her fark kırmızıya boyanıyordu. Yedek de aynı bandı
                // uygular (±50 normal); band sunucudan gelmezse burada da
                // uydurulmaz, yalnız tekrar edilir.
                const farkRenk = fark == null ? R.not
                  : x.uyumsuzluk_cozuldu ? R.not2
                    : sev ? sev.renk
                      : Math.abs(fark) <= 50 ? R.yesil
                        : Math.abs(fark) < 200 ? R.amber : R.kirmizi;
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
                  _x: x,
                };
              })}
              onSatir={({ _x }) => barSayimAc(_x)}
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
                // 🔵 (2026-08-12, Ops denetimi): satır eşiği 0.5 idi ama üst KPI/alarm
                // 50 kullanıyor (sunucu tolerans bandı) → başlık "denklem tutuyor" derken
                // satır 5₺ farkı "kasa açığı/fazlası" kırmızısıyla gösteriyordu. Eşikler hizalandı.
                const buyuk = d.gecerli && Math.abs(d.deger) > 50;
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
                            {/* 🔵 EVV-OPS3-B: kapanmış günde 0 ciro GERÇEK (0 satış) → '0 ₺' göster,
                                '—' (veri yok) DEĞİL. Kapanmamışsa ve 0 ise '—'. */}
                            {(x.kapanis_tamam || ciroT) ? tl(ciroT) : '—'}
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
                    { v: x.teslim_var ? tl(sayi(x.teslim_kasa_tl)) : '—', mono: true, sag: true, renk: x.teslim_var ? R.yesil : x.kapanis_tamam ? R.amber : R.not3 },
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
                        : Math.abs(d.deger) <= 50 ? R.yesil
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
                      ad: d.gecerli ? (Math.abs(d.deger) <= 50 ? 'Sonuç: dengede' : d.deger > 0 ? 'Sonuç: kasa açığı' : 'Sonuç: kasa fazlası') : 'Sonuç: hesaplanamadı',
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
            not={`${sayi(urunAcAkis?.toplam_islem)} işlem · ${sayi(urunAcAkis?.toplam_adet)} adet — bara verilen ürünler`
              + (acAkis.length > 60 ? ` · ⚠ ${acAkis.length} kaydın ilk 60'ı gösteriliyor` : '')}
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
                  {/* ⚠️ Codex: bu yedek listede ayrıca 8 kayıt sınırı vardı ve
                      söylenmiyordu. Sahip hem GÜN değil AY verisine bakarken
                      hem de kırpılmış bir listeye bakıyordu. */}
                  {hepsi.length > 8 && (
                    <> Ayrıca <b>{hepsi.length} kaydın ilk 8'i</b> gösteriliyor
                      ({hepsi.length - 8} kayıt listede yok).</>
                  )}
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
                      // ⚠️ falsy-zero (Codex): `sayi(x) ? x : '—'` GERÇEK 0
                      // tüketimi "veri yok"a çeviriyordu. Oysa "o gün hiç süt
                      // kullanılmadı" bir BULGUDUR — sayım yapılmadığıyla aynı
                      // şey değildir. Alanın kendisi yoksa "—", 0 ise "0".
                      // ⚠️ Dizi İÇİNDE JSX yorumu ({/* */}) geçersizdir; ilk
                      // yazışta öyle yazıp derlemeyi kırmıştım.
                      { v: st?.sut_litre == null ? '—' : String(sayi(st.sut_litre)), mono: true, sag: true, renk: st?.sut_litre == null ? R.not3 : undefined },
                      { v: st?.su_adet == null ? '—' : String(sayi(st.su_adet)), mono: true, sag: true, renk: st?.su_adet == null ? R.not3 : undefined },
                      { v: st?.pasta_adet == null ? '—' : String(sayi(st.pasta_adet)), mono: true, sag: true, renk: st?.pasta_adet == null ? R.not3 : undefined },
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
                      // ⚠️ Fable: tabloda null↔0 ayrımı titizlikle yapılmışken
                      // (satıra tıklanınca açılan) bu çekmecenin KPI'ları
                      // `String(sayi(x))` diyordu: alan hiç yoksa da "0".
                      // Tablo "—" derken çekmece "0" diyordu — düzeltilen
                      // kusur bir kat içeride yeniden doğmuş.
                      { etiket: 'Süt (L)', deger: st?.sut_litre == null ? '—' : String(sayi(st.sut_litre)) },
                      { etiket: 'Pasta', deger: st?.pasta_adet == null ? '—' : String(sayi(st.pasta_adet)) },
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
    // ══════════════════════════════════════════════════════════════════════
    // 🔴 OLMAYAN BİR KİŞİYİ SUÇLAMAK — 2026-08-27, canlı kanıt
    // ══════════════════════════════════════════════════════════════════════
    // Ekran "⚠ sürekli açık veren personel · 1 personel birden fazla günde
    // açık veriyor · 1 kişi birden fazla şubede" diyordu. Ucu ölçtüm; o
    // listede TEK kayıt vardı:
    //     personel_id: null · personel_ad: "—" · toplam_acik: 2327
    //     acik_kalem: 367 · risk_seviyesi: "yuksek" · cok_sube: true
    // Yani personeli BELLİ OLMAYAN bütün kayıplar tek bir kovada toplanmış ve
    // o kova "yüksek riskli bir kişi" gibi sunuluyordu. Ortada kişi YOK.
    // ⚠️ Bu, eksik veriden üretilmiş bir SUÇLAMADIR. Sahip "Personel
    // Denetimi'ne git" düğmesine basıp bir fail arar; bulamaz, ya da o gün
    // orada olan birinden şüphelenir. Sistem kimseyi, kanıtı olmadan işaret
    // etmez.
    // ⚠️ Kayıt SİLİNMİYOR: 2327 birim açık gerçek ve önemli — ama bu bir
    // "kim yaptı" bulgusu değil, "kim yaptığı KAYITLI DEĞİL" bulgusudur.
    // İkisi ayrı ayrı gösteriliyor.
    const _kayipHam = Array.isArray(dnKayip?.surekli_acik_personel) ? dnKayip.surekli_acik_personel : [];
    const _kisiMi = (x) => !!(x && x.personel_id && String(x.personel_ad || '').trim() && String(x.personel_ad).trim() !== '—');
    const kayipSurekli = _kayipHam.filter(_kisiMi);
    const kayipAtanmamis = _kayipHam.filter((x) => !_kisiMi(x));
    const kayipCokSube = kayipSurekli.filter((p) => p.cok_sube).length;
    // ⚠️ ÖLÇÜLEMEYEN GÜN: açılış eventi olmayan kapanışlar. Bunlar "kayıp yok"
    // DEĞİL "ölçülemedi" demektir — sıfır gibi göstermek yanlış güven verir.
    const kayipOlculemeyen = sayi(dnKayip?.veri_eksik_gun_sayisi);
    const kayipToplamAcik = kayipSube.reduce((s, x) => s + sayi(x.toplam_acik), 0);
    // 🔵 (2026-08-12, Ops denetimi): KPI değeri kayipToplamAcik'ten, rengi/boş-durumu
    // kayipListe.length'ten geliyordu (iki kaynak) → özet açık varken (kayipToplamAcik>0)
    // detay listesi boşsa kart YEŞİL + "kayıp yok ✓" gösteriyordu. Tek "kayıp var" kaynağı.
    const kayipVar = kayipListe.length > 0 || kayipToplamAcik > 0.01;
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
      // 🔵 EVV-OPS2-N6 (2026-08-13): tab badge yalnız kayipListe.length'ti → özet açık
      // (kayipToplamAcik>0) ama detay listesi boşsa "Stok kaybı (0)" gösteriyordu (KPI/body
      // açık kayıp derken). kayipVar ise en az '!' göster.
      ['kayip', `📉 Stok kaybı (${kayipListe.length || (kayipVar ? '!' : '0')})`],
      ['alarm', `🔐 Güvenlik (${sayi(mdAlarm?.alarm_sayisi)})`],
      ['mesaj', `📢 Merkez mesajı (${okunmamisMesaj})`],
      ['muhur', '🔓 Mühür açma'],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { onTikla: () => setDnSekme('uyumsuz'), etiket: 'Bekleyen uyumsuzluk', deger: String(sayi(dnUyumsuz?.gun_bekleyen)), alt: `${sayi(dnUyumsuz?.gun_toplam)} kayıt · ${sayi(dnUyumsuz?.gun_cozuldu)} çözüldü`, renk: sayi(dnUyumsuz?.gun_bekleyen) ? R.kirmizi : R.yesil },
          // 🚪 KPI -> kanıtını taşıyan SEKME. Veri zaten yüklü, hedef zaten
          // var; eksik olan tek şey sahibin oraya gidebilmesiydi.
          {
            etiket: 'Fire bildirimi',
            deger: String(sayi(dnFire?.gun_toplam)),
            alt: `${sayi(dnFire?.toplam_adet_gun)} adet · ${tarihKisa(barTarih)}`,
            renk: sayi(dnFire?.gun_toplam) ? R.amber : R.yesil,
            onTikla: fireKayit.length ? () => setDnSekme('fire') : undefined,
          },
          {
            etiket: 'Fişsiz gider',
            deger: String(fisListe.length),
            alt: fisListe.length ? 'son 7 gün · belge bekliyor · aç' : 'son 7 gün · belge bekliyor',
            renk: fisListe.length ? R.amber : R.yesil,
            onTikla: fisListe.length ? () => setDnSekme('fis') : undefined,
          },
          {
            // ⚠️ ÇERÇEVELEME: bu sayı FARKLI BİRİMLERİ topluyor. Canlı ölçüm:
            // plastik bardak 623 + su 445 + SÜT 262 (litre) + redbull 253 +
            // 14oz bardak 236 … 8 ayrı ürün tek "adet" başlığı altında.
            // Bir bardak ile bir litre süt aynı ağırlıkta sayılıyor. Ekranın en
            // büyük rakamı olduğu için çıpayı da o kuruyor.
            // ⚠️ SAYIYI DEĞİŞTİRMEDİM (sunucunun toplamı) — neyin toplandığı
            // yazıldı: "8 üründe" ve "birimler karışık".
            onTikla: (kayipToplamAcik || kayipListe.length) ? () => setDnSekme('kayip') : undefined,
            etiket: 'Stok kaybı',
            deger: kayipToplamAcik ? String(kayipToplamAcik) : String(kayipListe.length),
            alt: kayipToplamAcik
              ? (() => {
                const urunSayisi = new Set(
                  (dnKayip?.haftalik_pattern || []).map((x) => x.urun_ad || x.urun).filter(Boolean),
                ).size;
                return urunSayisi > 1
                  ? `${urunSayisi} üründe toplam · birimler karışık (bardak+litre+adet)`
                  : `adet açık · ${kayipListe.length} kalem-gün · 45 gün`;
              })()
              : (kayipOlculemeyen ? `${kayipOlculemeyen} gün ÖLÇÜLEMEDİ` : 'son 45 gün analizi'),
            renk: kayipVar ? R.amber : kayipOlculemeyen ? R.not : R.yesil,
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
            not={'formül → fark → çözüm; kararı sen verirsin'
              + (uyumsuzListe.length > 40
                ? ` · ⚠ ${uyumsuzListe.length} kaydın ilk 40'ı gösteriliyor`
                : '')}
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tip' }, { ad: 'Ürün' }, { ad: 'Dün → bugün' }, { ad: 'Fark', sag: 1 }, { ad: 'Durum' }]}
            satirlar={uyumsuzListe.slice(0, 40).map((x, i) => ({
              id: x.id || `uy-${i}`,
              hucreler: [
                { v: x.sube_adi || x.sube_ad || '—', kalin: true },
                { v: String(x.tip || '—').replace(/_/g, ' ').toLowerCase(), renk: R.not },
                { v: x.urun_ad || x.kalem_adi || '—' },
                // ══════════════════════════════════════════════════════════
                // 🔴 FARK HEP 0 GÖRÜNÜYORDU — 2026-08-27, canlı kanıt
                // ══════════════════════════════════════════════════════════
                // Ekran `x.fark ?? x.fark_adet` okuyordu; sunucuda bu iki alan
                // YOK. Gerçek alanlar: `efektif_fark_tl` (çözüm sonrası kalan)
                // ve `fark_tl` (ham). İkisi de okunmayınca sayi(undefined)=0
                // ve BÜTÜN uyumsuzluklar "Fark 0" görünüyordu.
                // Canlı: Soda TEMA — dün kapanış 43, bugün açılış 24, Δ −19.
                // Ekran bunu 0 diye gösteriyordu. Farkı sıfır olan bir
                // uyumsuzluk, uyumsuzluk değildir: sahip listeye bakıp
                // "hepsi sıfır, boş ver" der ve 19 birim kayıp görünmez.
                // ⚠️ ALAN ADI TUZAĞI: adı `_tl` ama taşıdığı şey ADET (bardak,
                // şişe). Bu yüzden para biçimi (fmt) UYGULANMIYOR — ₺ yazmak
                // 19 adet sodayı 19 lira sanmaya yol açardı.
                // ⚠️ KENDİ KUSURUM (aynı gün): bu kanıt kolonunu eklerken
                // `sayi(x.beklenen_tl) → sayi(x.gercek_tl)` yazmıştım. Ama o
                // iki alan YALNIZ devir-farkı tipinde dolu; "karşılıksız açma"
                // tipinde ikisi de null → sayi(null)=0 → ekran "0 → 0" diyordu.
                // Yani farkı +10 olan bir satırın kanıtı "hiçbir şey olmamış"
                // gibi görünüyordu — düzeltmeye çalıştığım falsy-zero'yu bu kez
                // KENDİM ürettim.
                // ⚠️ Boş alan gizlenmiyor, EŞDEĞERİNDEN türetiliyor: o tipte
                // kanıt `detay_json` içinde (depoda ne vardı, ne istendi).
                (() => {
                  if (x.beklenen_tl != null && x.gercek_tl != null) {
                    return { v: `${sayi(x.beklenen_tl)} → ${sayi(x.gercek_tl)}`, mono: true, renk: R.not2 };
                  }
                  const d = x.detay_json || {};
                  if (d.mevcut_oncesi != null || d.istenen != null) {
                    return {
                      v: `depoda ${sayi(d.mevcut_oncesi)} · istenen ${sayi(d.istenen)}`,
                      mono: true, renk: R.not2,
                    };
                  }
                  return { v: '—', renk: R.not3 };
                })(),
                (() => {
                  const f = x.efektif_fark_tl != null ? x.efektif_fark_tl : x.fark_tl;
                  if (f == null) return { v: 'ölçülemedi', sag: true, renk: R.not3 };
                  const n = sayi(f);
                  return {
                    v: (n > 0 ? '+' : '') + String(n),
                    mono: true, sag: true, kalin: true,
                    renk: n === 0 ? R.not : R.kirmizi,
                  };
                })(),
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
            not={(sayi(dnFire?.gun_toplam) ? `${tarihKisa(barTarih)} günü` : 'bugün kayıt yok — son bildirimler')
              + (fireKayit.length > 40 ? ` · ⚠ ${fireKayit.length} bildirimin ilk 40'ı gösteriliyor` : '')}
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
              // ⚠️ SUSTURMA ÇÖZÜM DEĞİLDİR (Codex, 2026-08-27):
              // Susturulan güvenlik alarmı 'iyi' (yeşil) boyanıyordu — yani
              // "bu olay kapandı" gibi görünüyordu. Oysa susturmak yalnız
              // alarm bütçesini yönetir; olay olduğu yerde durur. Güvenlik
              // olayında bu ayrım hayatidir: sahip "hallolmuş" sanıp bir daha
              // bakmaz. Susturulmuş alarm artık BİLGİ seviyesinde — kaybolmaz
              // (susturma silme değildir), bağırmaz (susturulmuş olmasının
              // anlamı budur), ama YEŞİLE DE DÖNMEZ (çözülmedi).
              // ⚠️ Yeni bir renk jetonu UYDURULMADI: tema.js'te `notr` yok,
              // olmayan tier sessizce maviye düşerdi. Var olan `bilgi` jetonu
              // tam bu anlamı taşıyor — ortak dosyaya dokunmaya gerek yok.
              tier: a.susturuldu ? 'bilgi' : (a.seviye === 'kritik' ? 'kritik' : 'uyari'),
              aksiyonlar: [
                { ad: 'Okundu', onTikla: () => setMdModal({ tip: 'okundu', alarm: a, notu: '' }) },
                { ad: 'Sustur', onTikla: () => setMdModal({ tip: 'sustur', alarm: a, notu: '', dk: 120 }) },
              ],
            }))} />
          </>
        ) : (
          // ══════════════════════════════════════════════════════════════
          // 🔴 ALARM KÖRLÜĞÜ — "bulgu yok" ile "hiç bakılmamış" aynı sessizlik
          // ══════════════════════════════════════════════════════════════
          // Boş durum "şube girişlerinde anormallik görünmüyor ✓" diyordu
          // (yeşil onay). Ama uç iki ayrı sayı veriyor:
          //     alarm_sayisi        = AKTİF alarm
          //     toplam_alarm_kaydi  = BUGÜNE KADARKİ TÜM kayıt
          // Canlı ölçüm: ikisi de 0. Aylardır PIN'le çalışan şube panelleri
          // varken hiç kayıt oluşmamış olması, "hiç anormallik yaşanmadı"dan
          // çok "dedektör hiç yazmamış" ihtimaline yakındır — ve ekran bu iki
          // ihtimali AYNI yeşil onaya indirgiyordu.
          // ⚠️ Sistem, ölçmediği şey için temiz kâğıdı VERMEZ.
          sayi(mdAlarm?.toplam_alarm_kaydi) > 0
            ? <BosDurum metin="Aktif güvenlik alarmı yok — şube girişlerinde anormallik görünmüyor. ✓" tamam />
            : (
              <BosDurum
                baslik="Hiç güvenlik alarmı kaydı yok"
                metin={'Aktif alarm yok — ama bugüne kadar HİÇ alarm kaydı da oluşmamış. '
                  + 'Bu "anormallik yaşanmadı" anlamına gelebileceği gibi, alarmı üreten '
                  + 'akışın hiç çalışmamış olması da mümkündür; ekran bu ikisini ayırt edemez. '
                  + 'Şube panelinde PIN kilidi/hatalı PIN olayları eşiği aştığında kayıt doğar '
                  + `(pencere ${sayi(mdAlarm?.limitler?.pencere_dk)} dk · kilit eşiği `
                  + `${sayi(mdAlarm?.limitler?.pin_kilit_esik)} · hatalı PIN eşiği `
                  + `${sayi(mdAlarm?.limitler?.pin_hatali_esik)}).`}
              />
            )
        ))}

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
              <Liste baslik={`Gönderilen mesajlar · ${okunmamisMesaj} okunmadı`
                + (mesajListe.length > 60 ? ` · ilk 60 gösteriliyor (${mesajListe.length - 60} daha)` : '')}
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

        {/* ── ŞUBE OPERASYON KALİTESİ — kontrol özetinden AYRI boyut ──
            Kontrol özeti "kontroller yapıldı mı" der; bu blok VARDİYA DEVRİNİN
            ne kadar eksik tiklendiğini + not gönderme sıklığını + sipariş
            çevrim süresini ölçer. Sunucu "veri yetersiz" durumunu ayrıca
            bildiriyor — sıfır ile ölçülemedi karıştırılmasın. */}
        {/* ⚠️ Fable: `opKalite` null ise bu sekme HİÇBİR ŞEY çizmiyordu — ne
            hata, ne yükleniyor, ne boş durum. Sessiz beyaz alan, sahip için
            "kontrol edilecek bir şey yok" diye okunur. Komşu "alarm" sekmesi
            bu üç durumu doğru ayırıyordu; burada yoktu. */}
        {dnSekme === 'kontrol' && !opKalite && (
          dnHata
            ? <HataBandi mesaj={dnHata} onTekrar={() => denetimYukle(barTarih)} />
            : <BosDurum baslik="Kontrol özeti okunamadı"
                metin="Şube operasyon kalitesi verisi gelmedi. Bu 'sorun yok' demek değildir — ölçüm alınamadı. Yenilemeyi deneyin." />
        )}
        {dnSekme === 'kontrol' && opKalite && (() => {
          const vk = opKalite.veri_kalite || {};
          const vardiyaOran = opKalite.vardiya_eksik_oran;
          const dongu = opKalite.siparis_dongusu?.ozet || {};
          const trend = opKalite.kontrol_gecikmesi_trend || {};
          const subeOran = Array.isArray(opKalite.vardiya_devri_eksik_tik_orani)
            ? opKalite.vardiya_devri_eksik_tik_orani : [];
          const yetersiz = (k) => vk[k]?.durum === 'yetersiz_veri' || vk[k]?.seviye === 'yetersiz_veri';
          const deger = (v, ek, k) => (yetersiz(k) ? 'ölçülemedi' : (v == null ? '—' : `${trSayi(sayi(v))}${ek}`));
          return (
            <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 11 }}>
                Operasyon kalitesi · son {sayi(opKalite.gun_sayi) || 30} gün
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(178px,1fr))', gap: 10, marginBottom: subeOran.length ? 12 : 0 }}>
                <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                  <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>VARDİYA DEVRİ EKSİK TİK</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4,
                    color: yetersiz('vardiya_eksik_oran') ? R.not3
                      : sayi(vardiyaOran) > 20 ? R.kirmizi : sayi(vardiyaOran) > 5 ? R.amber : R.yesil,
                  }}>{deger(vardiyaOran, '%', 'vardiya_eksik_oran')}</div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>devir adımları tamamlanmadan kapanmış</div>
                </div>
                <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                  <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>NOT GÖNDERME</div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: yetersiz('not_gonderim_gunluk_ort') ? R.not3 : R.krem }}>
                    {deger(opKalite.not_gonderim_gunluk_ort, '', 'not_gonderim_gunluk_ort')}
                  </div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>şube başına günlük not</div>
                </div>
                <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                  <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>SİPARİŞ ÇEVRİMİ</div>
                  <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: yetersiz('siparis_cevrim_sure_gun') ? R.not3 : R.krem }}>
                    {deger(opKalite.siparis_cevrim_sure_gun, ' gün', 'siparis_cevrim_sure_gun')}
                  </div>
                  {/* ⚠️ Codex: ana metrik "ölçülemedi" diyebiliyor ama alt satır
                      `dongu` boş objeye düştüğünde yine de "0 bekliyor" yazıyordu.
                      Ölçülemeyen şey 0 gibi görünemez — "bekleyen sipariş yok"
                      cümlesi, şube malsız beklerken de kurulabilirdi. */}
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>
                    talep → teslim · {dongu?.teslim_bekleyen == null
                      ? <span style={{ color: R.not3 }}>bekleyen sayısı okunamadı</span>
                      : `${sayi(dongu.teslim_bekleyen)} bekliyor`}
                  </div>
                </div>
                <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                  <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>KONTROL GECİKMESİ</div>
                  <div style={{
                    fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4,
                    color: trend.yon === 'kotulesme' ? R.kirmizi : trend.yon === 'iyilesme' ? R.yesil : R.krem,
                  }}>
                    {trend.son_hafta_ort_dk != null ? `${trSayi(sayi(trend.son_hafta_ort_dk), 0)} dk` : '—'}
                  </div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>
                    {trend.yon === 'kotulesme' ? '↑ kötüleşiyor' : trend.yon === 'iyilesme' ? '↓ iyileşiyor'
                      : trend.yon === 'yetersiz_veri' ? 'trend için veri az' : 'sabit'}
                    {trend.onceki_hafta_ort_dk != null ? ` · önceki hafta ${trSayi(sayi(trend.onceki_hafta_ort_dk), 0)} dk` : ''}
                  </div>
                </div>
              </div>
              {subeOran.length > 0 && (
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {subeOran.map((s, i) => (
                    <span key={s.sube_id || i} style={{
                      padding: '5px 11px', borderRadius: 99, fontSize: 11,
                      background: R.girinti, border: `1px solid ${R.cizgi3}`, color: R.metin2,
                    }}>
                      {s.sube_adi || '—'}{' '}
                      <b style={{
                        fontFamily: F.mono,
                        color: sayi(s.eksik_tik_orani_pct) > 20 ? R.kirmizi : sayi(s.eksik_tik_orani_pct) > 5 ? R.amber : R.yesil,
                      }}>%{trSayi(sayi(s.eksik_tik_orani_pct), 0)}</b>
                      <span style={{ color: R.not3 }}> · {sayi(s.toplam_devri)} devir</span>
                    </span>
                  ))}
                </div>
              )}
              {/* Personel metriği ŞUBE kırılımı (soru 6/9) — hangi şubede açılış
                  geç, kontrol yavaş. Kişi kırılımı Ekip ▸ Personel Denetimi'nde;
                  null = "ölçülemedi", 0 dk sanılmasın diye "—" basılır. */}
              {(opPersonelSube?.subeler || []).some((s) => s.acilis_ornek || s.kontrol_ornek) && (
                <div style={{ marginTop: 12, paddingTop: 11, borderTop: `1px solid ${R.cizgi3}` }}>
                  <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px', marginBottom: 8 }}>
                    AÇILIŞ SAPMASI + KONTROL CEVABI · ŞUBE KIRILIMI
                    <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}> — kişi kırılımı Ekip ▸ Personel Denetimi'nde</span>
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    {(opPersonelSube.subeler || []).map((s, i) => {
                      const ac = s.acilis_sapma_ort_dk;
                      const ko = s.kontrol_cevap_ort_dk;
                      return (
                        <span key={s.sube_id || i} style={{
                          padding: '5px 11px', borderRadius: 99, fontSize: 11,
                          background: R.girinti, border: `1px solid ${R.cizgi3}`, color: R.metin2,
                        }}>
                          {s.sube_adi || '—'}{' '}
                          <span style={{ color: R.not3 }}>açılış </span>
                          <b style={{ fontFamily: F.mono, color: ac == null ? R.not3 : sayi(ac) > 15 ? R.kirmizi : sayi(ac) > 5 ? R.amber : R.yesil }}>
                            {ac == null ? '—' : `${sayi(ac) > 0 ? '+' : ''}${trSayi(sayi(ac), 0)} dk`}
                          </b>
                          <span style={{ color: R.not3 }}> · kontrol </span>
                          <b style={{ fontFamily: F.mono, color: ko == null ? R.not3 : sayi(ko) > 30 ? R.kirmizi : sayi(ko) > 15 ? R.amber : R.yesil }}>
                            {ko == null ? '—' : `${trSayi(sayi(ko), 0)} dk`}
                          </b>
                          <span style={{ color: R.not3 }}> · {sayi(s.aktif_personel_adet)} kişi</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {dnSekme === 'kontrol' && (kontrolSatir.length ? (
          <Tablo
            baslik="Kontrol özeti · şube bazlı"
            // Sunucunun hazır sayaçları (kritik_toplam/uyari_toplam) hiç
            // okunmuyordu — A-2 minör; tablo yalnız tamam/toplam gösteriyordu.
            not={`günlük kontrol adımlarının tamamlanma durumu${
              sayi(dnKontrol?.kritik_toplam) || sayi(dnKontrol?.uyari_toplam)
                ? ` · açık uyarı: ${sayi(dnKontrol?.kritik_toplam)} kritik + ${sayi(dnKontrol?.uyari_toplam)} uyarı`
                : ''}`}
            kolonlar={[{ ad: 'Şube' }, { ad: 'Tamamlanan', sag: 1 }, { ad: 'Toplam', sag: 1 }, { ad: 'Durum' }]}
            satirlar={kontrolSatir.slice(0, 20).map((x, i) => {
              const tamam = sayi(x.tamam ?? x.tamamlanan);
              // 🔵 (2026-08-12): `sayi(x.toplam) || 1` toplam 0/null iken UYDURMA 1 üretip
              // "1 eksik" yalanı basıyordu (kontrol yokken). Gerçek toplamı kullan; 0 = veri yok.
              const toplam = sayi(x.toplam);
              return {
                id: x.sube_id || `kn-${i}`,
                hucreler: [
                  { v: x.sube_adi || x.sube_ad || '—', kalin: true },
                  { v: String(tamam), mono: true, sag: true },
                  { v: toplam > 0 ? String(toplam) : '—', mono: true, sag: true, renk: R.not },
                  toplam <= 0
                    ? { v: 'veri yok', rozet: R.not }
                    : tamam >= toplam
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
            {/* KİŞİSİ BELLİ OLMAYAN AÇIK — suçlama değil, KAYIT EKSİĞİ bulgusu.
                Ayrı kart, ayrı dil, ayrı renk: kimseyi işaret etmez. */}
            {kayipAtanmamis.length > 0 && (
              <div style={{
                ...kartYuzey, padding: '13px 18px', marginBottom: 12, borderColor: `${R.amber}44`,
                fontSize: 12, color: R.not, lineHeight: 1.7,
              }}>
                <span style={rozetHap(R.amber)}>◑ kişisi belirlenemeyen açık</span>{' '}
                <b style={{ fontFamily: F.mono, color: R.krem }}>
                  {kayipAtanmamis.reduce((a, x) => a + sayi(x.toplam_acik), 0)}
                </b> birim açık, <b>hangi personelin vardiyasında oluştuğu kayıtlı değil</b>.
                Bu bir kişi bulgusu <b>değildir</b> — kayıt eksiği bulgusudur; kimseyi işaret etmez.
                Kişi bazlı inceleme ancak açılış/kapanış kaydında personel varken mümkün.
              </div>
            )}
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
              <BosDurum metin={kayipToplamAcik > 0.01
                ? `Şube özetinde ${kayipToplamAcik} adet açık görünüyor ama kalem-gün kırılımı gelmedi — veri eksik, "kayıp yok" DEĞİL.`
                : kayipOlculemeyen > 0
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
          {/* 🗣️ SİSTEM DİLİ (BAKIŞ hamlesi 6): "ÖNERİ-ONLY" bir mühendislik
              terimi — sahip kod bilmez. BAKIŞ'ta bunu "sistem önerir, kararı
              sen verirsin" diye çevirmiştik; aynı cümle burada da. */}
          ℹ Sistem önerir, kararı sen verirsin: bu ekran uyumsuzluğu GÖSTERİR, karar vermez.
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
    // 🔴 EVV-OPS3-A (2026-08-13 satır-satır, tedarik lensi): eskiden `kalan_gun > 0`
    // ZATEN TÜKENMİŞ (0/negatif) kalemleri riskten düşürüyordu → sipariş ekranında EN acil
    // (bugün sipariş et) olanlar KPI'dan kaçıyordu. null=forecast yok (hariç); tükenmiş DAHİL.
    const kritikTahmin = tahminler.filter((t) => t.kalan_gun != null && sayi(t.kalan_gun) <= 7);
    const kotuKpi = kpilar.filter((k) => k.yon === 'kotu');
    // Aynı ilişkinin İKİ YÖNÜ yan yana: ne gönderdik ↔ ne geldi.
    // Eskiden yalnız "gelen" vardı; giden yönlendirme logu hiç görünmüyordu.
    const gidenler = Array.isArray(tsGiden?.gonderimler) ? tsGiden.gonderimler : [];
    // 🛒 SİPARİŞ ÖNERİSİ en başta: bu ekranın diğer sekmeleri "ne oldu"yu anlatır,
    // öneri ise "ne yapmalı"yı söyler — aksiyon önce gelir.
    const oneriOzet = siparisOneri?.ozet || null;
    const ALT = [
      ...(oneriOzet ? [['oneri', `🛒 Sipariş önerisi (${sayi(oneriOzet.acil_kalem)} acil)`]] : []),
      ['giden', `🚚 Toptancıya giden (${gidenler.length})`],
      ['teslim', `📦 Toptancıdan gelen (${teslimSube.length})`],
      ['urungelis', '🔎 Ürün geliş geçmişi'],
      ['notlar', `📝 Şube notları (${notlar.length})`],
      ['tahmin', `🔮 Stok tahmini (${tahminler.length})`],
      ['kpi', `📊 KPI değişimi (${kpilar.length})`],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Teslim alan şube', deger: `${teslimSube.length} şube`, alt: `son ${sayi(tsTeslim?.gun) || 14} gün`, renk: R.krem },
          {
            etiket: 'Şube notu',
            deger: String(notlar.length),
            alt: notlar.length ? 'merkeze düşen kayıt · aç' : 'merkeze düşen kayıt',
            renk: notlar.length ? R.mavi : R.yesil,
            onTikla: notlar.length ? () => setTsSekme('notlar') : undefined,
          },
          // ══════════════════════════════════════════════════════════════
          // 🔴 HİÇ ÇALIŞMAMIŞ BİR ALARM — 2026-08-27, canlı kanıt
          // ══════════════════════════════════════════════════════════════
          // "TÜKENME RİSKİ 0 · kritik kalem yok" YEŞİL yazıyordu. Ucu ölçtüm:
          //   /ops/stok-tahmin → 30 tahmin, alanlar: urun_ad ·
          //   ort_gunluk_tuketim · gozlem_gun · tahmin_7gun · trend
          // `kalan_gun` diye bir alan YOK. Süzgeç `t.kalan_gun != null` olduğu
          // için sonuç HER ZAMAN boş; bu KPI hiçbir zaman 0'dan başka bir şey
          // gösteremezdi. Yani bir alarm değil, yeşil bir dekordu.
          // Üstelik AYNI EKRAN "🛒 Sipariş önerisi (46 acil)" diyordu ve
          // sipariş öneri ucu `acil_kalem: 46 · acil_tutar_tl: 47.198 ₺`
          // döndürüyordu. Sahip "kritik kalem yok" okuyup 46 acil kalemi
          // sipariş etmeden geçebilirdi.
          // ⚠️ Ölçen kaynak zaten vardı: sipariş öneri motoru tedarik süresini
          // ve hedef günü hesaba katıyor. KPI artık ONDAN okuyor.
          // ⚠️ O da yoksa YEŞİL SIFIR YOK — "ölçülemedi" yazılır.
          (() => {
            if (oneriOzet && oneriOzet.acil_kalem != null) {
              const a = sayi(oneriOzet.acil_kalem);
              return {
                etiket: 'Tükenme riski',
                deger: String(a),
                alt: a
                  ? `${fmt(sayi(oneriOzet.acil_tutar_tl))} · listeyi aç`
                  : 'acil sipariş kalemi yok',
                renk: a ? R.kirmizi : R.yesil,
                // 🚪 Bu modülün en pahalı rakamıydı ve HİÇBİR YERE
                // açılmıyordu: sahip "46 acil kalem" okuyup hangi ürün
                // olduğunu göremiyordu. Kanıt zaten yüklü — bir sekme ötede.
                onTikla: a ? () => { setTsSekme('oneri'); setOneriKova('acil'); } : undefined,
              };
            }
            return {
              etiket: 'Tükenme riski',
              deger: '—',
              alt: '⚠ sipariş öneri motoru okunamadı — "risk yok" DEMEK DEĞİL',
              renk: R.not3,
            };
          })(),
          {
            etiket: 'Kötüleşen KPI',
            deger: String(kotuKpi.length),
            alt: kotuKpi.length ? `${kotuKpi.map((k) => k.etiket).slice(0, 2).join(', ')} · aç` : 'tümü iyi/nötr',
            renk: kotuKpi.length ? R.amber : R.yesil,
            onTikla: kotuKpi.length ? () => setTsSekme('kpi') : undefined,
          },
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

        {tsSekme === 'oneri' && oneriOzet && (() => {
          const kovalar = [
            ['acil', `🔴 Acil (${sayi(oneriOzet.acil_kalem)})`, siparisOneri.acil || [], 'tedarik süresinde biter — bugün sipariş geç'],
            ['yakin', `🟡 Yakın (${sayi(oneriOzet.yakin_kalem)})`, siparisOneri.yakin || [], 'planlı alım penceresinde'],
            ['fazla', `⛔ ALMA (${sayi(oneriOzet.fazla_kalem)})`, siparisOneri.fazla || [], 'hedefin çok üstünde — para rafta yatıyor'],
          ];
          const [, , liste, kovaNot] = kovalar.find(([k]) => k === oneriKova) || kovalar[0];
          const kasaYeter = oneriOzet.kasa_yeterli;
          return (
            <>
              <KpiSeridi kpiler={[
                { etiket: 'Acil sipariş', deger: fmt(sayi(oneriOzet.acil_tutar_tl)), alt: `${sayi(oneriOzet.acil_kalem)} kalem · hemen`, renk: sayi(oneriOzet.acil_kalem) ? R.kirmizi : R.yesil },
                { etiket: 'Önerilen toplam', deger: fmt(sayi(oneriOzet.onerilen_tutar_tl)), alt: `21 günlük hedefe göre`, renk: R.bakirAcik },
                { etiket: 'Rafta bekleyen', deger: fmt(sayi(oneriOzet.fazla_bagli_para_tl)), alt: `${sayi(oneriOzet.fazla_kalem)} kalem · ALMA`, renk: R.amber },
                {
                  etiket: 'Kasa yeterli mi',
                  deger: kasaYeter == null ? '—' : (kasaYeter ? 'evet' : 'HAYIR'),
                  alt: oneriOzet.kasa_tl != null
                    ? `kasa ${fmt(sayi(oneriOzet.kasa_tl))} · gecikmiş ${fmt(sayi(oneriOzet.gecikmis_odeme_tl))}`
                    : 'kasa bilgisi yok',
                  renk: kasaYeter == null ? R.not : (kasaYeter ? R.yesil : R.kirmizi),
                },
              ]} />

              {/* Kategori özeti — toptancı seçimi kategori bazlı yapılır */}
              {(siparisOneri.kategoriler || []).length > 0 && (
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
                  {siparisOneri.kategoriler.slice(0, 8).map((k) => (
                    <span key={k.kategori} style={{
                      padding: '5px 12px', borderRadius: 99, fontSize: 11.5, fontWeight: 700,
                      background: k.acil ? `${R.kirmizi}1F` : R.girinti,
                      color: k.acil ? R.kirmizi : R.metin2,
                      border: `1px solid ${k.acil ? `${R.kirmizi}44` : R.cizgi3}`,
                    }}>
                      {k.kategori} · {k.kalem} kalem · {fmt(k.tutar)}{k.acil ? ` · ${k.acil} acil` : ''}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
                {kovalar.map(([id, ad]) => (
                  <div key={id} onClick={() => setOneriKova(id)} style={{
                    padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${oneriKova === id ? R.bakir : R.cizgi3}`,
                    color: oneriKova === id ? R.bakir : R.metin2,
                    background: oneriKova === id ? 'rgba(217,154,78,.14)' : R.girinti,
                  }}>{ad}</div>
                ))}
                <span style={{ fontSize: 11, color: R.not2, alignSelf: 'center' }}>{kovaNot}</span>
              </div>

              {liste.length ? (
                <Tablo
                  baslik={oneriKova === 'fazla' ? 'Bu kalemleri ALMA — rafta bekleyen para' : 'Sipariş önerisi · ürün bazında'}
                  not={oneriKova === 'fazla'
                    ? 'hedefin çok üstünde stok · sipariş vermek nakdi rafa bağlar'
                    : 'öneri = (21 gün × günlük tüketim) − mevcut · kaynak: ürün-aç defteri'}
                  kolonlar={oneriKova === 'fazla'
                    ? [{ ad: 'Kalem' }, { ad: 'Şube' }, { ad: 'Elde', sag: true }, { ad: 'Bağlı para', sag: true }, { ad: 'Neden' }]
                    : [{ ad: 'Kalem' }, { ad: 'Şube' }, { ad: 'Elde', sag: true }, { ad: 'Ritim' }, { ad: 'Öneri', sag: true }, { ad: 'Tutar', sag: true }]}
                  satirlar={liste.slice(0, 60).map((s, i) => ({
                    id: `${s.kalem_kodu}-${s.sube_id}-${i}`, _s: s,
                    hucreler: oneriKova === 'fazla'
                      ? [
                        { v: s.kalem_adi, kalin: true },
                        { v: s.sube_adi, renk: R.not },
                        { v: String(s.mevcut), mono: true, sag: true },
                        { v: fmt(sayi(s.bagli_para_tl)), mono: true, sag: true, renk: R.amber, kalin: true },
                        { v: s.neden || '—', renk: R.not2 },
                      ]
                      : [
                        { v: s.kalem_adi, kalin: true },
                        { v: s.sube_adi, renk: R.not },
                        { v: String(s.mevcut), mono: true, sag: true, renk: sayi(s.mevcut) <= 0 ? R.kirmizi : R.krem },
                        {
                          // Ritim: seyrek kalemde asıl sinyal budur
                          v: s.ortalama_aralik_gun
                            ? `${trSayi(sayi(s.ortalama_aralik_gun), 0)} günde bir${s.gun_gecti != null ? ` · ${s.gun_gecti}g önce` : ''}`
                            : (s.kalan_gun != null ? `${trSayi(sayi(s.kalan_gun), 1)} gün kaldı` : '—'),
                          renk: R.not2,
                        },
                        { v: `${trSayi(sayi(s.oneri_adet), 1)}`, mono: true, sag: true, kalin: true },
                        { v: fmt(sayi(s.tahmini_tutar_tl)), mono: true, sag: true },
                      ],
                  }))}
                  onSatir={(row) => {
                    const s = row._s;
                    onCekmece?.({
                      tip: oneriKova === 'fazla' ? 'FAZLA STOK' : 'SİPARİŞ ÖNERİSİ',
                      baslik: s.kalem_adi,
                      alt: `${s.sube_adi} · ${s.kategori || 'kategori yok'}`,
                      kpi: [
                        { etiket: 'Elde', deger: String(s.mevcut) },
                        { etiket: 'Günlük tüketim', deger: `${trSayi(sayi(s.gunluk_tuketim), 2)}` },
                        ...(s.oneri_adet != null
                          ? [{ etiket: 'Öneri', deger: `${trSayi(sayi(s.oneri_adet), 1)} adet`, renk: R.bakirAcik }]
                          : [{ etiket: 'Bağlı para', deger: fmt(sayi(s.bagli_para_tl)), renk: R.amber }]),
                      ],
                      listeBaslik: 'Ölçüler',
                      satirlar: [
                        { ad: 'Kalan gün', detay: 'mevcut ÷ günlük tüketim', tutar: s.kalan_gun != null ? `${trSayi(sayi(s.kalan_gun), 1)} gün` : '—' },
                        { ad: 'Açılım ritmi', detay: 'kaç günde bir açılıyor', tutar: s.ortalama_aralik_gun ? `${trSayi(sayi(s.ortalama_aralik_gun), 1)} gün` : '—' },
                        { ad: 'Son açılım', detay: s.son_acilim || 'kayıt yok', tutar: s.gun_gecti != null ? `${s.gun_gecti} gün önce` : '—' },
                        { ad: 'Açılım başına', detay: 'her açılışta düşen', tutar: s.acilim_basina_adet != null ? `${trSayi(sayi(s.acilim_basina_adet), 1)} adet` : '—' },
                        { ad: 'Yeniden sipariş noktası', detay: `tedarik ${sayi(siparisOneri?.parametreler?.tedarik_gun) || 3} gün + emniyet`, tutar: s.rop != null ? `${trSayi(sayi(s.rop), 1)} adet` : '—' },
                        ...(s.trend ? [{ ad: 'Tüketim trendi', detay: 'stok tahmin motorundan', tutar: s.trend }] : []),
                        ...(s.acil_nedeni ? [{ ad: '⚠ Acil nedeni', detay: s.acil_nedeni, tutar: '' }] : []),
                      ],
                      not: siparisOneri?.not,
                    });
                  }}
                />
              ) : (
                <BosDurum metin={oneriKova === 'fazla' ? 'Hedefin üstünde stok yok — depo dengeli.' : 'Bu kovada kalem yok.'} />
              )}
            </>
          );
        })()}
        {tsSekme === 'giden' && (gidenler.length ? (
          <Tablo
            baslik={`Toptancıya giden · ${tsGiden?.filtre_etiket || 'son 14 gün'}`}
            not={`${sayi(tsGiden?.toplam_kayit)} gönderim · ${sayi(tsGiden?.toplam_satir)} kalem satırı — satıra tıkla → kalem dökümü`}
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Tedarikçi' }, { ad: 'Şube' },
              { ad: 'Kalem', sag: 1 }, { ad: 'Toplam adet', sag: 1 }, { ad: 'Ne gönderildi' },
            ]}
            satirlar={gidenler.slice(0, 40).map((g, i) => ({
              id: g.id || `tg-${i}`,
              _g: g,
              hucreler: [
                {
                  siraMetin: String(g.tarih || ''),
                  v: (
                    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontFamily: F.mono }}>{tarihKisa(g.tarih)}</span>
                      {g.saat ? <span style={{ fontSize: 10, color: R.not2, fontFamily: F.mono }}>{String(g.saat).slice(0, 5)}</span> : null}
                    </span>
                  ),
                },
                { v: g.tedarikci_ad || '—', kalin: true },
                { v: g.sube_adi || '—', renk: R.not },
                { v: String(sayi(g.kalem_sayisi)), mono: true, sag: true, renk: R.not },
                { v: String(sayi(g.toplam_adet)), mono: true, sag: true, kalin: true },
                { v: kisalt(g.kalemler_ozet || '—', 46), renk: R.not2 },
              ],
            }))}
            onSatir={({ _g }) => {
              const kl = Array.isArray(_g?.kalemler) ? _g.kalemler : [];
              onCekmece?.({
                tip: 'TOPTANCIYA GÖNDERİM',
                baslik: _g?.tedarikci_ad || 'Tedarikçi',
                alt: `${tarihKisa(_g?.tarih)}${_g?.saat ? ` ${String(_g.saat).slice(0, 5)}` : ''} · ${_g?.sube_adi || '—'} için`,
                kpi: [
                  { etiket: 'Kalem', deger: String(sayi(_g?.kalem_sayisi)) },
                  { etiket: 'Toplam adet', deger: String(sayi(_g?.toplam_adet)) },
                  { etiket: 'Talep', deger: _g?.talep_id ? `#${String(_g.talep_id).slice(-8)}` : 'bağlantısız' },
                ],
                listeBaslik: 'Gönderilen kalemler',
                satirlar: kl.slice(0, 30).map((k) => ({
                  ad: k?.urun_ad || k?.kalem_adi || '—',
                  detay: k?.birim ? String(k.birim) : '',
                  tutar: `${sayi(k?.adet)} adet`,
                })),
                not: [
                  _g?.not_aciklama ? `Not: ${_g.not_aciklama}` : '',
                  'Bu liste GİDEN yönlendirmedir (WhatsApp ile toptancıya iletilen). Gelen teslim ayrı sekmede — ikisi tutmuyorsa eksik/geç teslim var demektir.',
                ].filter(Boolean).join(' · '),
              });
            }}
          />
        ) : <BosDurum metin="Son 14 günde toptancıya yönlendirilmiş sipariş yok." />)}

        {tsSekme === 'teslim' && (teslimSube.length ? (
          <Tablo
            baslik={`Toptancıdan gelenler · son ${sayi(tsTeslim?.gun) || 14} gün`}
            not="şube panelinden girilen teslim alımları · satıra tıkla → kalem dökümü"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Teslim adedi', sag: true },
              { ad: 'Son teslim' }, { ad: 'Eksik/kısmi', sag: true },
            ]}
            satirlar={teslimSube.map((x, i) => {
              // Sunucu her şube için son 5 teslimi KALEM KALEM gönderiyordu
              // (tedarikci · kalemler[] · teslim_durumu · olay_ts); v2 yalnız
              // şube toplamını basıyordu → kısmi/eksik teslim görünmüyordu.
              const det = Array.isArray(x.teslimler) ? x.teslimler : [];
              const eksik = det.filter((t) => t.teslim_durumu && t.teslim_durumu !== 'tam_geldi');
              return {
                id: x.sube_id || `t-${i}`,
                _t: x,
                hucreler: [
                  { v: x.sube_adi || '—', kalin: true },
                  { v: String(sayi(x.toplam)), mono: true, sag: true, kalin: true },
                  { v: tarihKisa(x.son_tarih), mono: true, renk: R.not },
                  eksik.length
                    ? { v: `${eksik.length} teslim`, rozet: R.amber, sira: eksik.length }
                    : { v: det.length ? 'tam' : '—', rozet: det.length ? R.yesil : undefined, renk: det.length ? undefined : R.not3, sira: 0 },
                ],
              };
            })}
            onSatir={({ _t }) => {
              const det = Array.isArray(_t?.teslimler) ? _t.teslimler : [];
              if (!det.length) { onToast?.('Bu şube için kalem dökümü gelmedi.'); return; }
              onCekmece?.({
                tip: 'TOPTANCI TESLİMLERİ',
                baslik: _t.sube_adi || 'Şube',
                alt: `son ${sayi(tsTeslim?.gun) || 14} gün · ${sayi(_t.toplam)} teslim · en yeni ${det.length} tanesi`,
                kpi: [
                  { etiket: 'Teslim', deger: String(sayi(_t.toplam)) },
                  {
                    etiket: 'Kısmi/eksik',
                    deger: String(det.filter((t) => t.teslim_durumu && t.teslim_durumu !== 'tam_geldi').length),
                    renk: det.some((t) => t.teslim_durumu && t.teslim_durumu !== 'tam_geldi') ? R.amber : R.yesil,
                  },
                  { etiket: 'Son teslim', deger: tarihKisa(_t.son_tarih) },
                ],
                listeBaslik: 'Teslim kalemleri',
                satirlar: det.map((t) => ({
                  ad: `${t.tedarikci || '—'}${t.teslim_durumu && t.teslim_durumu !== 'tam_geldi' ? ` · ⚠ ${t.teslim_durumu}` : ''}`,
                  detay: (Array.isArray(t.kalemler) && t.kalemler.length)
                    ? t.kalemler.map((k) => `${k.ad} ${sayi(k.adet)}`).join(' · ')
                    : 'kalem girilmemiş',
                  tutar: String(t.olay_ts || t.tarih || '').slice(0, 16),
                })),
                not: 'Teslim kaydı ŞUBEDE girilir (görünür kabul modeli). Buradaki liste salt-okurdur; eksik/kısmi teslimin çözümü sipariş akışında yapılır.',
              });
            }}
          />
        ) : <BosDurum metin="Son 14 günde toptancıdan teslim alımı kaydı yok." />)}

        {tsSekme === 'urungelis' && (() => {
          // "vanilya milkshake ne zaman geldi?" — ürün adıyla toptancı geliş kazısı.
          const ist = ugVeri?.istatistik || null;
          const gelisler = Array.isArray(ugVeri?.gelisler) ? ugVeri.gelisler : [];
          const bekleyenler = Array.isArray(ugVeri?.bekleyenler) ? ugVeri.bekleyenler : [];
          // Geç kaldı sinyali: son gelişten bu yana geçen gün, ortalama aralığın
          // 1,5 katını aştıysa amber. 3'ten az farklı günle ortalama ZAYIF —
          // sinyal üretilmez, "az veri" dürüstlüğü yazılır.
          let gecikmeNotu = null;
          if (ist?.son_gelis && ist?.ortalama_aralik_gun != null) {
            const gecen = Math.floor((Date.now() - new Date(`${ist.son_gelis}T12:00:00+03:00`).getTime()) / 86400000);
            if (sayi(ist.farkli_gun) < 3) {
              gecikmeNotu = { renk: R.not, metin: `son gelişten bu yana ${gecen} gün · aralık ortalaması için veri az (${sayi(ist.farkli_gun)} gün)` };
            } else if (gecen > ist.ortalama_aralik_gun * 1.5) {
              gecikmeNotu = { renk: R.amber, metin: `⚠ son gelişten bu yana ${gecen} gün geçti — ortalama aralık ${ist.ortalama_aralik_gun} gün. Sipariş zamanı geçmiş olabilir.` };
            } else {
              gecikmeNotu = { renk: R.yesil, metin: `son gelişten bu yana ${gecen} gün · ortalama aralık ${ist.ortalama_aralik_gun} gün — ritim normal` };
            }
          }
          return (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 380 }}>
                  <input
                    value={ugSorgu}
                    onChange={(e) => { setUgSorgu(e.target.value); setUgListeAcik(true); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') ugAra(); if (e.key === 'Escape') setUgListeAcik(false); }}
                    placeholder="Ürün adı yaz — ör. esp, vanilya…"
                    aria-label="Ürün geliş geçmişi arama"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: 10,
                      border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                      fontSize: 12.5, fontFamily: 'inherit', outline: 'none',
                    }}
                  />
                  {/* 🗂 KATALOG ÖNERİLERİ — "esp" → Espresso; tıkla = o ürünün
                      tarihçesi (Atalay cari dosyası deseninin ürün hâli).
                      Serbest arama da yaşıyor: öneri seçmek zorunlu değil. */}
                  {/* ⚠️ Yeni hata durumu SESSİZ KALMAZ: katalog okunamadıysa
                      kullanıcı bunu görür ve tekrar deneyebilir. Aksi hâlde
                      "öneri yok" sanmaya devam ederdi — düzeltmenin amacı tam
                      da bu ayrımı görünür kılmaktı. */}
                  {ugKatalogHata && (
                    <div style={{
                      marginTop: 8, padding: '9px 12px', borderRadius: 10,
                      background: `${R.amber}14`, border: `1px solid ${R.amber}44`,
                      fontSize: 11.5, color: R.amber, display: 'flex', gap: 10, alignItems: 'center',
                    }}>
                      <span>⚠ Ürün kataloğu okunamadı — bu "eşleşen ürün yok" demek DEĞİL.</span>
                      <button
                        onClick={() => setUgKatalogHata('')}
                        style={{
                          marginLeft: 'auto', padding: '0 14px', minHeight: 34, borderRadius: 9,
                          border: `1px solid ${R.bakir}66`, background: 'rgba(217,154,78,.14)',
                          color: R.bakirAcik, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                        }}
                      >Tekrar dene</button>
                    </div>
                  )}
                  {ugListeAcik && ugSorgu.trim().length >= 2 && Array.isArray(ugKatalog) && (() => {
                    const q = ugKucuk(ugSorgu.trim());
                    const esler = ugKatalog
                      .filter((k) => ugKucuk(k.ad).includes(q) || (k.kod && ugKucuk(k.kod).includes(q)))
                      .slice(0, 8);
                    if (!esler.length) return null;
                    return (
                      <div role="listbox" aria-label="Ürün önerileri" style={{
                        position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
                        marginTop: 4, borderRadius: 10, border: `1px solid ${R.cizgi3}`,
                        background: R.zemin2 || R.girinti, boxShadow: '0 14px 30px rgba(0,0,0,.45)',
                        overflow: 'hidden',
                      }}>
                        {esler.map((k) => (
                          <div
                            key={`${k.ad}|${k.kod}`}
                            role="option"
                            tabIndex={0}
                            onClick={() => { setUgSorgu(k.ad); ugAra(k.ad); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { setUgSorgu(k.ad); ugAra(k.ad); } }}
                            style={{
                              padding: '7px 12px', fontSize: 12.5, color: R.krem, cursor: 'pointer',
                              borderBottom: `1px solid ${R.cizgi3}`, display: 'flex', gap: 8, alignItems: 'baseline',
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{k.ad}</span>
                            {k.kod && <span style={{ fontSize: 10.5, color: R.not3, fontFamily: F.mono }}>{k.kod}</span>}
                            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not2 }}>tarihçeyi aç ›</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                <button
                  onClick={() => ugAra()}
                  disabled={ugMesgul}
                  style={{
                    padding: '8px 16px', borderRadius: 10, border: `1px solid ${R.bakir}`,
                    background: 'rgba(217,154,78,.14)', color: R.bakir, fontSize: 12,
                    fontWeight: 700, cursor: ugMesgul ? 'wait' : 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {ugMesgul ? 'Aranıyor…' : 'Geçmişi getir'}
                </button>
                <span style={{ fontSize: 10.5, color: R.not3 }}>
                  son 365 gün · yalnız TOPTANCIDAN gelenler — şubeler arası sevkiyat sayılmaz
                </span>
              </div>

              {ugHata && <HataBandi mesaj={ugHata} onTekrar={() => ugAra()} />}
              {!ugHata && ugVeri == null && (
                <BosDurum metin="Ürün adını yazıp Enter'a bas — toptancıdan geliş tarihleri, şube ve miktar dökümüyle burada listelenir." />
              )}
              {!ugHata && ugVeri != null && (
                gelisler.length === 0 && bekleyenler.length === 0 ? (
                  <BosDurum metin={`"${ugVeri.sorgu}" adıyla son 365 günde toptancı kaydı yok. Ürün sistemde başka adla geçiyor olabilir — daha kısa bir parça dene (ör. "vanil").`} />
                ) : (
                  <>
                    <KpiSeridi kpiler={[
                      { etiket: 'Geliş', deger: String(sayi(ist?.gelis_adet)), alt: `${sayi(ist?.farkli_gun)} farklı gün`, renk: R.krem },
                      { etiket: 'Son geliş', deger: ist?.son_gelis ? tarihKisa(ist.son_gelis) : '—', alt: ist?.ilk_gelis ? `ilk: ${tarihKisa(ist.ilk_gelis)}` : '', renk: R.bakirAcik },
                      { etiket: 'Ortalama aralık', deger: ist?.ortalama_aralik_gun != null ? `${ist.ortalama_aralik_gun} gün` : '—', alt: sayi(ist?.farkli_gun) < 3 ? 'az veri' : 'farklı günler arası', renk: R.mavi },
                      { etiket: 'Bekleyen sipariş', deger: String(bekleyenler.length), alt: bekleyenler.length ? 'gönderildi · teslim yok' : 'yok', renk: bekleyenler.length ? R.amber : R.yesil },
                    ]} />
                    {gecikmeNotu && (
                      <div style={{ ...kartYuzey, padding: '9px 13px', marginBottom: 12, fontSize: 12, color: gecikmeNotu.renk, borderLeft: `3px solid ${gecikmeNotu.renk}` }}>
                        {gecikmeNotu.metin}
                      </div>
                    )}
                    <Tablo
                      baslik={`"${ugVeri.sorgu}" — toptancıdan gelişler`}
                      not={'kaynak: toptancı sipariş kabulleri (şubede görünür kabul)'
                        + (gelisler.length > 60 ? ` · ⚠ ${gelisler.length} kaydın ilk 60'ı gösteriliyor` : '')}
                      kolonlar={[
                        { ad: 'Geliş' }, { ad: 'Ürün' }, { ad: 'Miktar', sag: true },
                        { ad: 'Şube' }, { ad: 'Toptancı' },
                      ]}
                      satirlar={gelisler.slice(0, 60).map((g, i) => ({
                        id: `ug-${i}`,
                        hucreler: [
                          { v: String(g.gelis_ts || ''), mono: true, kalin: true },
                          { v: g.urun_ad || '—' },
                          { v: `${g.miktar ?? '—'}${g.birim ? ` ${g.birim}` : ''}`, mono: true, sag: true },
                          { v: g.sube || '—' },
                          { v: g.tedarikci || '—', renk: R.not },
                        ],
                      }))}
                    />
                    {gelisler.length > 60 && (
                      <div style={{ fontSize: 10.5, color: R.not3, marginTop: 6 }}>listede ilk 60 geliş · toplam {gelisler.length}</div>
                    )}
                    {bekleyenler.length > 0 && (
                      <Tablo
                        baslik="Bekleyen siparişler (gönderildi, teslim kaydı yok)"
                        kolonlar={[{ ad: 'Sipariş' }, { ad: 'Ürün' }, { ad: 'Şube' }, { ad: 'Toptancı' }]}
                        satirlar={bekleyenler.slice(0, 20).map((b, i) => ({
                          id: `ugb-${i}`,
                          hucreler: [
                            { v: String(b.siparis_ts || ''), mono: true },
                            { v: b.urun_ad || '—' },
                            { v: b.sube || '—' },
                            { v: b.tedarikci || '—', renk: R.not },
                          ],
                        }))}
                      />
                    )}
                  </>
                )
              )}
            </>
          );
        })()}

        {tsSekme === 'notlar' && (notlar.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {notlar.length > 30 && (
              <div style={{ fontSize: 11, color: R.not3, marginBottom: 8 }}>
                ⚠ {notlar.length} notun ilk 30'u gösteriliyor ({notlar.length - 30} not listede yok)
              </div>
            )}
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
