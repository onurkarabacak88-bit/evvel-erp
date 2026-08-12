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
import { KpiSeridi, Hero, Tablo, BosDurum, HataBandi } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const pct = (v) => `%${Number(v).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;

// Yerli form stilleri (köprü kaldırma turu)
const mlAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const mlEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
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

const mlBtn = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const mlMini = {
  padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};

export default function MaliyetModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [ozet, setOzet] = useState(null);
  const [ozetHata, setOzetHata] = useState('');
  // Vergi & KDV (P&L DIŞI, izole) — /ops/maliyet/kdv-pozisyon + /vergi-ozet
  const [vergi, setVergi] = useState(null);
  const [vergiHata, setVergiHata] = useState('');
  // Güven skoru + sapma motoru (/ops/maliyet/guven-skoru) — SALT-OKUR, öneri-only.
  // Maliyet sayısının NE KADAR GÜVENİLİR olduğunu söyler; hata yoksa sessiz durur.
  const [guven, setGuven] = useState(null);
  const [basabas, setBasabas] = useState(null);   // /ops/maliyet/basabas
  const [pnl, setPnl] = useState(null);           // /ops/maliyet/pnl-merdiven
  // /ops/maliyet/gun-gun → kalem grubu kırılımı + fiyatı tanımsız kalemler
  const [gunGun, setGunGun] = useState(null);
  // /recete/degirmen-kiyas → makine sayacı gerçeği (bildirimden bağımsız katman)
  const [degirmen, setDegirmen] = useState(null);
  const [receteler, setReceteler] = useState(null);
  const [receteKaynak, setReceteKaynak] = useState('');   // 'recete_projeksiyon' = kanonik evren
  const [fiyatlar, setFiyatlar] = useState(null);
  const [receteHata, setReceteHata] = useState('');
  const [alarmlar, setAlarmlar] = useState(null);
  const [alarmHata, setAlarmHata] = useState('');
  const [esik, setEsik] = useState(15);
  const [kontrol, setKontrol] = useState(null);
  const [kontrolHata, setKontrolHata] = useState('');
  // ── YERLİ REÇETE EŞLEŞTİRME (köprü kaldırma turu, 2026-07-30) ─────────────
  // Kural (2026-07-29 sahip onayı): reçete "Ice X" = Evo "X Ice"; sade ad = "X 14 Oz".
  // Öneriler onaysız KULLANILMAZ (duyu anayasası) — bu ekran yalnız karar verir.
  const [eslModal, setEslModal] = useState(false);
  const [eslListe, setEslListe] = useState(null);
  const [eslMesgul, setEslMesgul] = useState('');      // işlenen öneri id'si
  const [eslTip, setEslTip] = useState('urun');        // urun | malzeme sekmesi
  const [elleForm, setElleForm] = useState(null);      // {tip, kaynak_ad, hedef_ad, hedef_kod}
  const [adaylar, setAdaylar] = useState(null);

  const ozetYukle = useCallback(() => {
    setOzetHata('');
    api('/ops/maliyet/ozet?gun=30')
      .then((d) => setOzet(d || {}))
      .catch((e) => setOzetHata(e?.message || ''));
    // BAŞABAŞ (2026-08-07 denetimi): "günde kaç ₺ satarsam zarar etmem" sorusu
    // sistemde cevapsızdı — parçalar (ciro, sabit gider, bordro, food cost, POS)
    // vardı, birleştiren yoktu. Hata-yutar: uç düşerse blok görünmez, ekran çalışır.
    api('/ops/maliyet/basabas?gun=30')
      .then((d) => setBasabas(d || null))
      .catch(() => setBasabas(null));
    // P&L MERDİVENİ (2026-08-08): ciro→brüt→FAVÖK→net tek zincir. Parçalar
    // ayrı ekranlardaydı; "kâr nerede eriyor" sorusu cevapsızdı.
    api('/ops/maliyet/pnl-merdiven?gun=30')
      .then((d) => setPnl(d || null))
      .catch(() => setPnl(null));
    // Güven skoru aynı ekranda yüklenir: food cost sayısını GÖSTERMEDEN önce
    // "bu sayı ne kadar güvenilir" sorusunun cevabı hazır olsun.
    api('/ops/maliyet/guven-skoru?gun=7')
      .then((d) => setGuven(d || null))
      .catch(() => setGuven(null));
    // KALEM GRUBU KIRILIMI (/ops/maliyet/gun-gun) — v2 bu ucu HİÇ çağırmıyordu.
    // Marj Özeti "food cost %31" diyor ama PARANIN NEREYE gittiğini söylemiyor.
    // Bu uç ürün-aç tüketimini alış fiyatıyla çarpıp grup grup (süt · şurup ·
    // bardak · pasta…) günlük maliyete çeviriyor. Ayrıca fiyatı tanımlı
    // OLMAYAN kalemleri bildiriyor — o kalemler maliyete HİÇ girmiyor demektir.
    api('/ops/maliyet/gun-gun?gun=30')
      .then((d) => setGunGun(d || null))
      .catch(() => setGunGun(null));
  }, []);

  /** GERÇEK maliyet verisi (ürün-aç × alış fiyatı). Sahip doktrini: maliyetin
   *  GERÇEĞİ personelin şube panelinden açtığı üründen gelir; reçete yalnız
   *  TEYİT basamağıdır. Ürün Maliyeti ekranı bu veriyi de yükler. */
  const gercekYukle = useCallback(() => {
    if (gunGun) return;
    api('/ops/maliyet/gun-gun?gun=30')
      .then((d) => setGunGun(d || null))
      .catch(() => setGunGun(null));
  }, [gunGun]);

  const receteYukle = useCallback(() => {
    setReceteHata('');
    api('/ops/maliyet/recete-listesi')
      .then((d) => {
        setReceteler(Array.isArray(d?.receteler) ? d.receteler : []);
        // Reçete evreni birleşti (2026-08-03): kaynak 'recete_projeksiyon' ise
        // satırlar KANONİK reçete evreninden türetilmiştir — düzenleme oradan
        // (Reçete Eşleştirme) yapılır, buradaki CRUD yanlış evrene yazardı.
        setReceteKaynak(d?.kaynak || '');
      })
      .catch((e) => setReceteHata(e?.message || ''));
    api('/ops/maliyet/alis-fiyatlari')
      .then((d) => setFiyatlar(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setFiyatlar([]));
  }, []);

  const alarmYukle = useCallback(() => {
    setAlarmHata('');
    kdvYukle();
    api('/ops/fiyat-zam-alarmlari?gun=180&limit=60')
      .then((d) => {
        setAlarmlar(Array.isArray(d?.alarmlar) ? d.alarmlar : []);
        if (d?.esik_yuzde) setEsik(sayi(d.esik_yuzde));
      })
      .catch((e) => setAlarmHata(e?.message || ''));
  }, []);

  const kontrolYukle = useCallback(() => {
    setKontrolHata('');
    api('/recete/kontrol?gun=7')
      .then((d) => setKontrol(d || {}))
      .catch((e) => setKontrolHata(e?.message || ''));
    // ÜÇÜNCÜ KATMAN — v2 bu ucu HİÇ çağırmıyordu.
    // Reçete kontrolü: satış×reçete (BEKLENEN) ↔ ürün-aç (BİLDİRİLEN).
    // Değirmen kıyası: makine sayacı × gramaj (MAKİNE GERÇEĞİ) ↔ beklenen.
    // Üçüncüsü bildirimden bağımsız — kimse girmese de makine sayıyor.
    api('/recete/degirmen-kiyas?gun=7')
      .then((d) => setDegirmen(d || null))
      .catch(() => setDegirmen(null));
  }, []);

  // ── eşleştirme ekranı (klasik ReceteEslestirme sözleşmesi) ────────────────
  const eslYukle = () => {
    api('/recete/eslestirmeler')
      .then((d) => setEslListe(Array.isArray(d?.eslestirmeler) ? d.eslestirmeler : []))
      .catch(() => setEslListe([]));
  };

  const eslAc = () => {
    setEslModal(true);
    setEslListe(null);
    setElleForm(null);
    eslYukle();
    if (!adaylar) {
      api('/recete/eslestirme-adaylar')
        .then((d) => setAdaylar(d || {}))
        .catch(() => setAdaylar({}));
    }
  };

  const eslKarar = async (id, karar) => {
    setEslMesgul(id);
    try {
      await api('/recete/eslestirme-karar', { method: 'POST', body: { id, karar } });
      onToast?.(karar === 'onayli' ? '✓ Eşleştirme onaylandı' : '✗ Öneri reddedildi');
      eslYukle();
      kontrolYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally {
      setEslMesgul('');
    }
  };

  const eslOnerUret = async () => {
    setEslMesgul('oner');
    try {
      const r = await api('/recete/eslestirme-oner', { method: 'POST', body: {} });
      onToast?.(`🔍 ${sayi(r?.yeni_oneri)} yeni öneri üretildi — onayını bekliyor`);
      eslYukle();
    } catch (e) {
      onToast?.(e?.message || 'Öneri üretilemedi');
    } finally {
      setEslMesgul('');
    }
  };

  const elleEkle = async () => {
    const f = elleForm;
    if (!f?.kaynak_ad || !f?.hedef_ad) { onToast?.('Kaynak ve hedef seçilmeli'); return; }
    if (f.tip === 'malzeme' && !f.hedef_kod) { onToast?.('Malzeme eşleştirmesinde depo kalemi seçilmeli'); return; }
    setEslMesgul('elle');
    try {
      await api('/recete/eslestirme-ekle', {
        method: 'POST',
        body: { tip: f.tip, kaynak_ad: f.kaynak_ad, hedef_ad: f.hedef_ad, hedef_kod: f.hedef_kod || null },
      });
      onToast?.('✓ Elle eşleştirme kaydedildi (insan kararı = onaylı)');
      setElleForm(null);
      eslYukle();
      kontrolYukle();
    } catch (e) {
      onToast?.(e?.message || 'Eklenemedi');
    } finally {
      setEslMesgul('');
    }
  };

  // ── FİYAT & KDV YÖNETİMİ (Faz 6, 2026-07-31) ──────────────────────────────
  // v2 fiyatları GÖSTERİYORDU ama düzeltemiyordu: yanlış alış fiyatı, eksik KDV
  // oranı, çöp kalem kaydı — hepsi klasikte çözülüyordu, burada değil.
  const [fyModal, setFyModal] = useState(null);   // {tip, ...}
  const [fyMesgul, setFyMesgul] = useState(false);
  const [kdvOranlar, setKdvOranlar] = useState(null);

  const kdvYukle = useCallback(() => {
    api('/ops/maliyet/kdv-oranlari')
      .then((d) => setKdvOranlar(Array.isArray(d?.satirlar) ? d.satirlar : (Array.isArray(d) ? d : [])))
      .catch(() => setKdvOranlar([]));
  }, []);

  const fyUygula = async () => {
    const m = fyModal;
    if (!m) return;
    if (fyMesgul) return;   // 🔁 (2026-08-12) çift-tık: mükerrer fiyat/KDV/silme yazımını önle
    setFyMesgul(true);
    try {
      if (m.tip === 'fiyat') {
        const kod = String(m.kalem_kodu || '').trim();
        const tutar = Number(String(m.birim_maliyet_tl).replace(',', '.'));
        if (!kod) { onToast?.('Kalem kodu zorunlu'); setFyMesgul(false); return; }
        // 🔴 P1 (2026-08-12): 0 TL de reddedilir (backend'le hizalı) — 0 maliyeti sıfırlar.
        if (!Number.isFinite(tutar) || tutar <= 0) { onToast?.('Fiyat 0\'dan büyük olmalı (0/negatif maliyeti sıfırlar)'); setFyMesgul(false); return; }
        await api('/ops/maliyet/alis-fiyat-kaydet', { method: 'POST', body: {
          kalem_kodu: kod, kalem_adi: (m.kalem_adi || '').trim() || null,
          birim: (m.birim || 'adet').trim() || 'adet', birim_maliyet_tl: tutar,
          gecerli_baslangic: m.gecerli_baslangic || null,
          tedarikci: (m.tedarikci || '').trim() || null,
          notlar: (m.notlar || '').trim() || null,
        } });
        onToast?.('✓ Alış fiyatı kaydedildi');
      } else if (m.tip === 'fiyat-sil') {
        await api(`/ops/maliyet/alis-fiyat-sil/${m.fiyat.id}`, { method: 'DELETE' });
        onToast?.('✓ Fiyat kaydı silindi — bir önceki fiyat geçerli olur');
      } else if (m.tip === 'kdv') {
        const y = Number(String(m.kdv_yuzde).replace(',', '.'));
        if (!Number.isFinite(y) || y < 0 || y > 40) { onToast?.('KDV yüzdesi 0–40 arası olmalı'); setFyMesgul(false); return; }
        await api('/ops/maliyet/kdv-oran-kaydet', { method: 'POST', body: {
          kalem_kodu: m.kalem_kodu, kalem_adi: m.kalem_adi || null, kdv_yuzde: y,
        } });
        onToast?.(`✓ KDV %${y} olarak kaydedildi`);
      } else if (m.tip === 'kdv-oto') {
        const r = await api(`/ops/maliyet/kdv-oran-otomatik?force=${m.force ? 'true' : 'false'}`, { method: 'POST' });
        const a = r?.atanan || {};
        onToast?.(`✓ KDV atandı — %1: ${sayi(a['%1'])} · %10: ${sayi(a['%10'])} · %20: ${sayi(a['%20'])}`);
      } else if (m.tip === 'kalem-temizle') {
        await api(`/ops/maliyet/kalem-temizle/${encodeURIComponent(m.kalem_kodu)}`, { method: 'DELETE' });
        onToast?.('✓ Kalemin tüm fiyat geçmişi silindi');
      }
      setFyModal(null);
      receteYukle(); kdvYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setFyMesgul(false); }
  };

  const vergiYukle = useCallback(() => {
    setVergiHata('');
    Promise.all([
      api('/ops/maliyet/kdv-pozisyon?gun=30').catch(() => null),
      api('/ops/maliyet/vergi-ozet?gun=30').catch(() => null),
      // NE KADAR'ın yanına NE ZAMAN: vergi çıkışının takvimi hiçbir ekranda
      // yoktu. /duyu/vergi-takvim KDV + muhtasar son ödeme günlerini veriyor.
      api('/duyu/vergi-takvim').catch(() => null),
      // Kira stopajı: brüt kira P&L gideri, stopaj vergi dairesine gider —
      // "mülk sahibine ne kadar, devlete ne kadar" ayrımı hiç görünmüyordu.
      api('/ops/maliyet/stopaj-ozet').catch(() => null),
    ]).then(([k, v, t, st]) => {
      if (!k && !v) { setVergiHata('Vergi verisi alınamadı'); return; }
      setVergi({ kdv: k, vergi: v, takvim: t, stopaj: st });
    }).catch((e) => setVergiHata(e?.message || 'Vergi verisi alınamadı'));
  }, []);

  useEffect(() => {
    if (gorunum === 'ozet') ozetYukle();
    if (gorunum === 'urun' || gorunum === 'recete') receteYukle();
    if (gorunum === 'urun') gercekYukle();   // GERÇEK maliyet (ürün-aç) — reçeteden ÖNCE gelir
    if (gorunum === 'fiyat') alarmYukle();
    if (gorunum === 'tuketim') kontrolYukle();
    if (gorunum === 'vergi') vergiYukle();
  }, [gorunum, ozetYukle, receteYukle, alarmYukle, kontrolYukle, vergiYukle, gercekYukle]);

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
    // SUNUCUNUN HESABI ESAS (reçete birleşmesi 2026-08-03): projeksiyon
    // satırında satir_maliyet_tl varsa o kullanılır — çeviri (shot→gram→
    // ambalaj payı) sunucuda tek yerde yaşar. İstemci çarpımı yalnız eski
    // (legacy) satırlar için yedektir.
    let toplam = 0;
    let fiyatsiz = 0;
    const satirlar = (r.hammaddeler || []).map((h) => {
      let tutar;
      if (h.satir_maliyet_tl != null) tutar = sayi(h.satir_maliyet_tl);
      else if (h.fiyatlanabilir === false) tutar = null;
      else {
        const f = fiyatMap[String(h.hammadde_kodu)];
        tutar = f ? sayi(h.miktar) * f.maliyet : null;
      }
      if (tutar == null) fiyatsiz += 1;
      else toplam += tutar;
      return { ...h, tutar };
    });
    return { satirlar, toplam, fiyatsiz };
  }, [fiyatMap]);

  // ════════════════════════ GÖRÜNÜM: MARJ ÖZETİ ═════════════════════════════
  // ── FATURA PDF → KALEM → ALIŞ FİYATI (2026-07-31) ─────────────────────────
  // Tarama notu: /fatura/yukle-pdf (belge arşivi) v2'de ZATEN var, o başka iş.
  // Bu akış PDF'ten KALEM çıkarıp fiyata çeviriyor — elle fiyat girmeye alternatif.
  const [fpSatirlar, setFpSatirlar] = useState(null);   // null=hiç denenmedi
  const [fpUyari, setFpUyari] = useState('');
  const [fpTedarikci, setFpTedarikci] = useState('');
  const [fpYukleniyor, setFpYukleniyor] = useState(false);
  const [fpOnayModal, setFpOnayModal] = useState(null);
  const [fpMesgul, setFpMesgul] = useState(false);

  const faturaPdfYukle = async (dosya) => {
    if (!dosya) return;
    setFpYukleniyor(true); setFpUyari('');
    try {
      const fd = new FormData();
      fd.append('file', dosya);
      if (fpTedarikci.trim()) fd.append('tedarikci', fpTedarikci.trim());
      // multipart — api() JSON gönderdiği için elden fetch
      const res = await fetch('/api/ops/maliyet/fatura-pdf-yukle', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.detail || `Yükleme başarısız (HTTP ${res.status})`);
      const sat = Array.isArray(d?.satirlar) ? d.satirlar : [];
      setFpSatirlar(sat);
      setFpUyari(d?.uyari || '');
      onToast?.(sat.length ? `✓ ${sayi(sat.length)} kalem çıkarıldı — onayla ki fiyata dönüşsün` : 'Kalem satırı çıkarılamadı');
    } catch (e) {
      setFpSatirlar([]);
      setFpUyari(e?.message || 'PDF okunamadı');
      onToast?.(e?.message || 'PDF okunamadı');
    } finally { setFpYukleniyor(false); }
  };

  const fpOnayla = async () => {
    const m = fpOnayModal;
    if (!m) return;
    const tutar = Number(String(m.birim_maliyet_tl).replace(',', '.'));
    if (!String(m.kalem_kodu || '').trim()) { onToast?.('Kalem kodu zorunlu'); return; }
    if (!Number.isFinite(tutar) || tutar < 0) { onToast?.('Geçerli birim maliyet girin'); return; }
    setFpMesgul(true);
    try {
      await api('/ops/maliyet/fatura-kalem-onayla', { method: 'POST', body: {
        ham_metin: m.ham_metin || '', urun_kodu: (m.urun_kodu || '').trim() || null,
        aciklama: (m.aciklama || '').trim() || null,
        kalem_kodu: String(m.kalem_kodu).trim(),
        kalem_adi: (m.kalem_adi || '').trim() || null,
        birim: (m.birim || 'adet').trim() || 'adet',
        birim_maliyet_tl: tutar,
        tedarikci: (m.tedarikci || fpTedarikci || '').trim() || null,
        gecerli_baslangic: m.gecerli_baslangic || null,
      } });
      onToast?.('✓ Kalem onaylandı — alış fiyatı zincirine eklendi');
      // onaylanan satırı listeden düşür ki hangisi kaldığı belli olsun
      setFpSatirlar((p) => (Array.isArray(p) ? p.filter((_, i) => i !== m._i) : p));
      setFpOnayModal(null);
      receteYukle(); kdvYukle();
    } catch (e) {
      onToast?.(e?.message || 'Onay başarısız');
    } finally { setFpMesgul(false); }
  };

  // ── REÇETE YÖNETİMİ + FOOD-COST (2026-07-31) ──────────────────────────────
  // Ekran reçeteyi GÖSTERİYORDU; düzeltme/silme ve food-cost tetiği yoktu.
  const [rcModal, setRcModal] = useState(null);   // {tip, recete?, kalemler?}
  const [rcMesgul, setRcMesgul] = useState(false);

  const rcUygula = async () => {
    const m = rcModal;
    if (!m) return;
    setRcMesgul(true);
    try {
      if (m.tip === 'duzenle') {
        const kalemler = (m.kalemler || [])
          .filter((k) => String(k.hammadde_kodu || '').trim())
          .map((k) => ({
            hammadde_kodu: String(k.hammadde_kodu).trim(),
            hammadde_adi: (k.hammadde_adi || '').trim() || null,
            miktar: Number(String(k.miktar).replace(',', '.')) || 0,
            birim: (k.birim || 'adet').trim() || 'adet',
          }))
          .filter((k) => k.miktar > 0);
        if (!kalemler.length) { onToast?.('En az bir hammadde ve miktar girin'); setRcMesgul(false); return; }
        await api('/ops/maliyet/recete-kaydet', { method: 'POST', body: {
          urun_id: m.recete.urun_id, urun_adi: m.recete.urun_adi || null, hammaddeler: kalemler,
        } });
        onToast?.('✓ Reçete kaydedildi — ürün maliyeti bundan sonra buna göre hesaplanır');
      } else if (m.tip === 'sil') {
        await api(`/ops/maliyet/recete-sil/${encodeURIComponent(m.recete.urun_id)}`, { method: 'DELETE' });
        onToast?.('✓ Reçete silindi — bu ürün maliyetsiz kaldı');
      } else if (m.tip === 'foodcost') {
        const r = await api('/ops/maliyet/food-cost-hesapla', { method: 'POST', body: {
          tarih: m.tarih || null, tarih_bitis: m.tarih_bitis || null, sube_id: m.sube_id || null,
        } });
        onToast?.(`✓ Food-cost hesaplandı${r?.gun_sayisi != null ? ` — ${sayi(r.gun_sayisi)} gün` : ''}`);
      }
      setRcModal(null);
      receteYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setRcMesgul(false); }
  };

  const rcModalBlok = rcModal && (() => {
    const kapat = () => { if (!rcMesgul) setRcModal(null); };
    const T = {
      'duzenle': { baslik: 'Reçeteyi düzenle', buton: 'Reçeteyi kaydet', tehlike: false,
        anlat: 'Bir porsiyon için kullanılan hammadde miktarları. Ürün maliyeti ve tüketim kontrolü bu sayılardan çıkar — miktarı 0 yaparsan o satır reçeteden düşer. Kaydetmek ürünün TÜM reçetesini bu listeyle değiştirir.' },
      'sil': { baslik: 'Reçeteyi sil', buton: 'Sil', tehlike: true,
        anlat: 'Ürünün tüm reçete satırları silinir. Bu ürün maliyetsiz kalır: kâr hesabında maliyeti 0 görünür ve tüketim kontrolü onu izleyemez.' },
      'foodcost': { baslik: 'Food-cost hesapla', buton: 'Hesapla', tehlike: false,
        anlat: 'Seçilen gün(ler) için satış × reçete üzerinden hammadde maliyetini yeniden hesaplar. Reçeteler veya alış fiyatları değiştiyse geçmiş günü tazelemek için kullanılır. Boş bırakırsan bugün hesaplanır.' },
    }[rcModal.tip] || {};
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 125, background: 'rgba(10,6,2,.72)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 520, maxWidth: '96vw', padding: '24px 26px', maxHeight: '88vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{T.baslik}</div>
            <button onClick={kapat} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>x</button>
          </div>
          {rcModal.recete && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              <b>{rcModal.recete.urun_adi || rcModal.recete.urun_id}</b>
            </div>
          )}
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>

          {rcModal.tip === 'duzenle' && (
            <>
              {(rcModal.kalemler || []).map((k, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <label style={mlEtiket}>Hammadde</label>
                    <input value={k.hammadde_adi ?? k.hammadde_kodu ?? ''}
                      onChange={(e) => setRcModal((p) => ({ ...p, kalemler: p.kalemler.map((x, j) => j === i ? { ...x, hammadde_adi: e.target.value } : x) }))}
                      style={mlAlanStil} />
                  </div>
                  <div style={{ maxWidth: 100 }}>
                    <label style={mlEtiket}>Miktar</label>
                    <input inputMode="decimal" value={k.miktar ?? ''}
                      onChange={(e) => setRcModal((p) => ({ ...p, kalemler: p.kalemler.map((x, j) => j === i ? { ...x, miktar: e.target.value } : x) }))}
                      style={mlAlanStil} />
                  </div>
                  <div style={{ maxWidth: 80 }}>
                    <label style={mlEtiket}>Birim</label>
                    <input value={k.birim ?? 'adet'}
                      onChange={(e) => setRcModal((p) => ({ ...p, kalemler: p.kalemler.map((x, j) => j === i ? { ...x, birim: e.target.value } : x) }))}
                      style={mlAlanStil} />
                  </div>
                </div>
              ))}
              <button onClick={() => setRcModal((p) => ({ ...p, kalemler: [...(p.kalemler || []), { hammadde_kodu: '', hammadde_adi: '', miktar: '', birim: 'adet' }] }))}
                style={{ ...mlMini, marginTop: 6 }}>+ Hammadde satırı</button>
              <div style={{ fontSize: 11, color: R.not2, marginTop: 8, lineHeight: 1.6 }}>
                Yeni satırda hammadde <b>kodu</b> gerekiyor; ad yazmak yetmez — kodu
                bilmiyorsan Stok kalemlerinden bak.
              </div>
            </>
          )}
          {rcModal.tip === 'foodcost' && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ maxWidth: 160 }}><label style={mlEtiket}>Tarih</label>
                <input type="date" value={rcModal.tarih ?? ''}
                  onChange={(e) => setRcModal((p) => ({ ...p, tarih: e.target.value }))} style={mlAlanStil} /></div>
              <div style={{ maxWidth: 160 }}><label style={mlEtiket}>Bitiş (aralık için)</label>
                <input type="date" value={rcModal.tarih_bitis ?? ''}
                  onChange={(e) => setRcModal((p) => ({ ...p, tarih_bitis: e.target.value }))} style={mlAlanStil} /></div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={rcMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={rcMesgul} onClick={rcUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309',
            }}>{rcMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  // ── FAZ 6 ONAY/FORM MODALI ────────────────────────────────────────────────
  const fyModalBlok = fyModal && (() => {
    const T = {
      'fiyat': { baslik: 'Alış fiyatı gir', tehlike: false, buton: 'Fiyatı kaydet',
        anlat: 'Girilen tutar AÇILIŞ birimi fiyatıdır — içerik katsayısı uygulanmaz. Yeni tarihli kayıt eskisini geçersiz kılmaz, zincire eklenir; geçmiş maliyet hesapları bozulmaz.' },
      'fiyat-sil': { baslik: 'Fiyat kaydını sil', tehlike: true, buton: 'Sil',
        anlat: 'Bu tek fiyat satırı kaldırılır; zincirde bir önceki fiyat geçerli olur. Yanlış/test kaydını düzeltmek içindir.' },
      'kdv': { baslik: 'KDV oranı ata', tehlike: false, buton: 'KDV\'yi kaydet',
        anlat: 'Türkiye oranları: %1 (temel gıda), %10, %20. Oran net kâr hesabına girer — yanlış oran kârı olduğundan yüksek/düşük gösterir.' },
      'kdv-oto': { baslik: 'KDV oranlarını otomatik doldur', tehlike: !!fyModal.force, buton: 'Çalıştır',
        anlat: 'Kalem adına bakan kural motoru KDV oranı önerir ve yazar. Bu bir TAHMİNDİR — sonucu gözden geçir.' },
      'kalem-temizle': { baslik: 'Kalemin fiyat geçmişini temizle', tehlike: true, buton: 'Temizle',
        anlat: 'Bu kaleme ait TÜM alış fiyatı kayıtları silinir — tek satır değil, geçmişin tamamı. Geçmiş maliyet hesapları bu kalemde fiyatsız kalır.' },
    }[fyModal.tip] || {};
    const kapat = () => { if (!fyMesgul) setFyModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 470, maxWidth: '96vw', padding: '24px 26px', maxHeight: '88vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{T.baslik}</div>
            <button onClick={kapat} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>x</button>
          </div>
          {(fyModal.kalem_adi || fyModal.fiyat) && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              <b>{fyModal.kalem_adi || fyModal.fiyat?.kalem_adi || fyModal.fiyat?.kalem_kodu}</b>
              {fyModal.fiyat ? ` · ${fmt(sayi(fyModal.fiyat.birim_maliyet_tl))} ₺` : ''}
            </div>
          )}
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>

          {fyModal.tip === 'fiyat' && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 150, flex: 1 }}><label style={mlEtiket}>Kalem kodu</label>
                  <input value={fyModal.kalem_kodu} onChange={(e) => setFyModal((p) => ({ ...p, kalem_kodu: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ minWidth: 150, flex: 1 }}><label style={mlEtiket}>Kalem adı</label>
                  <input value={fyModal.kalem_adi} onChange={(e) => setFyModal((p) => ({ ...p, kalem_adi: e.target.value }))} style={mlAlanStil} /></div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ maxWidth: 140 }}><label style={mlEtiket}>Birim maliyet ₺</label>
                  <input inputMode="decimal" value={fyModal.birim_maliyet_tl} onChange={(e) => setFyModal((p) => ({ ...p, birim_maliyet_tl: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ maxWidth: 110 }}><label style={mlEtiket}>Birim</label>
                  <input value={fyModal.birim} onChange={(e) => setFyModal((p) => ({ ...p, birim: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ maxWidth: 150 }}><label style={mlEtiket}>Geçerlilik başlangıcı</label>
                  <input type="date" value={fyModal.gecerli_baslangic} onChange={(e) => setFyModal((p) => ({ ...p, gecerli_baslangic: e.target.value }))} style={mlAlanStil} /></div>
              </div>
              <label style={mlEtiket}>Tedarikçi</label>
              <input value={fyModal.tedarikci} onChange={(e) => setFyModal((p) => ({ ...p, tedarikci: e.target.value }))} style={mlAlanStil} />
              <label style={mlEtiket}>Not</label>
              <input value={fyModal.notlar} onChange={(e) => setFyModal((p) => ({ ...p, notlar: e.target.value }))} style={mlAlanStil} />
            </>
          )}
          {fyModal.tip === 'kdv' && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 150, flex: 1 }}><label style={mlEtiket}>Kalem kodu</label>
                  <input value={fyModal.kalem_kodu} onChange={(e) => setFyModal((p) => ({ ...p, kalem_kodu: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ maxWidth: 120 }}><label style={mlEtiket}>KDV %</label>
                  <input inputMode="decimal" value={fyModal.kdv_yuzde} onChange={(e) => setFyModal((p) => ({ ...p, kdv_yuzde: e.target.value }))} style={mlAlanStil} /></div>
              </div>
              <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                {[1, 10, 20].map((y) => (
                  <button key={y} onClick={() => setFyModal((p) => ({ ...p, kdv_yuzde: y }))} style={{
                    ...mlMini, padding: '6px 14px',
                    borderColor: sayi(fyModal.kdv_yuzde) === y ? R.bakir : R.cizgi3,
                    color: sayi(fyModal.kdv_yuzde) === y ? R.bakir : R.not,
                    background: sayi(fyModal.kdv_yuzde) === y ? `${R.bakir}1E` : 'transparent',
                  }}>%{y}</button>
                ))}
              </div>
            </>
          )}
          {fyModal.tip === 'kdv-oto' && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: R.metin2, cursor: 'pointer', lineHeight: 1.6 }}>
              <input type="checkbox" checked={!!fyModal.force} style={{ marginTop: 3 }}
                onChange={(e) => setFyModal((p) => ({ ...p, force: e.target.checked }))} />
              <span>
                <b>Elle ayarları da ez</b> — işaretlemezsen yalnız KDV'si tanımsız kalemler
                doldurulur ve senin elle girdiğin oranlar KORUNUR. İşaretlersen tüm kalemler
                kural sonucuyla yeniden yazılır; <b>elle girilenler kaybolur</b>.
              </span>
            </label>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={fyMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={fyMesgul} onClick={fyUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              border: T.tehlike ? `1px solid ${R.kirmizi}55` : 'none',
              background: T.tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: T.tehlike ? R.kirmizi : '#1C1309',
            }}>{fyMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

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
      // 🔵 P1 (2026-08-12, Maliyet denetimi): trend grafiği maliyeti `gercek || teorik`
      // ile hesaplıyordu → kanonik L1 (actual_open_cogs_tl, ürün-aç×fiyat) ATLANIYOR +
      // `||` gerçek 0'ı teoriğe düşürüyordu. L1 kartıyla (aşağıda) AYNI kanonik zincir.
      gunMap[t].maliyet += sayi(g.actual_open_cogs_tl ?? g.gercek_maliyet_tl ?? g.teorik_maliyet_tl);
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
    // ⚠️ EŞİK KODA GÖMÜLMEZ: sunucu benchmark bandını kendisi gönderiyor
    // (operasyon_merkez_api:13667 → benchmark.food_cost_min_pct/max_pct).
    // Eskiden %28–35 üç ayrı yerde sabit yazılıydı; norm sunucuda güncellenirse
    // ekran sessizce eski bandı gösterirdi (kart limit_doluluk vakasıyla aynı
    // sınıf tuzak: sunucunun hesabını istemcide yeniden kurma).
    const bmin = sayi(ozet?.benchmark?.food_cost_min_pct) || 28;
    const bmax = sayi(ozet?.benchmark?.food_cost_max_pct) || 35;
    const bandMetni = `%${Math.round(bmin)}–${Math.round(bmax)}`;
    const bench = foodCost == null ? null : (foodCost <= bmax && foodCost >= bmin)
      ? { ad: 'norm içinde', tip: 'iyi' }
      : foodCost < bmin ? { ad: 'normun altında', tip: 'iyi' } : { ad: 'norm üstü', tip: 'kotu' };
    // Altyapı eksikleri: sunucu ne yapılması gerektiğini CÜMLE olarak söylüyor
    const altyapiEksik = Array.isArray(ozet?.altyapi_durum?.eksikler) ? ozet.altyapi_durum.eksikler : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Food cost (30 gün)', deger: foodCost == null ? '—' : pct(foodCost), alt: `benchmark ${bandMetni}`, renk: foodCost == null ? R.not : foodCost > bmax ? R.kirmizi : R.yesil },
          {
            etiket: 'Stok değeri',
            deger: fmt(sayi(ozet.stok_degeri_tl ?? ozet.toplam_stok_degeri_tl)),
            alt: sayi(ozet.stok_kalem_sayisi)
              ? `${sayi(ozet.stok_kalem_sayisi)} kalem × alış fiyatı`
              : 'mevcut stok × alış fiyatı',
          },
          // A-2. tur: fire EŞİĞİ de sunucudan (shrinkage_izleme_pct %2 /
          // sorusturma_pct %5) — food-cost bandıyla aynı kural: eşik koda gömülmez.
          (() => {
            const fireOran = toplamCiro > 0 ? (toplamFire / toplamCiro) * 100 : null;
            const sIzleme = sayi(ozet?.benchmark?.shrinkage_izleme_pct) || 2;
            const sSorus = sayi(ozet?.benchmark?.shrinkage_sorusturma_pct) || 5;
            return {
              etiket: 'Fire (30 gün)',
              deger: fmt(toplamFire),
              alt: fireOran == null
                ? 'shrinkage toplamı · oran için ciro gerekli'
                : `cironun %${fireOran.toFixed(1)}'i · izleme %${sIzleme} / soruşturma %${sSorus}`,
              renk: fireOran == null ? R.krem
                : fireOran >= sSorus ? R.kirmizi
                  : fireOran >= sIzleme ? R.amber : R.yesil,
            };
          })(),
          {
            etiket: 'Altyapı',
            deger: `${sayi(ozet.alis_fiyat_sayisi)} fiyat · ${sayi(ozet.recete_sayisi)} reçete`,
            // Sunucu eksikleri madde madde söylüyordu; v2 "tanımlı kayıtlar"
            // diye geçiştiriyordu — hesabın NEDEN eksik olabileceği kayboluyordu.
            alt: altyapiEksik.length ? `⚠ ${altyapiEksik[0]}` : 'tanımlı kayıtlar',
            renk: altyapiEksik.length ? R.amber : R.krem,
          },
        ]} />

        {/* ── P&L MERDİVENİ — mali okumanın omurgası ────────────────────────
            Sonuç önce gelir: ciro → brüt → FAVÖK → net. Altındaki başabaş
            "ne olmalı"yı, bu blok "ne oldu"yu anlatır. */}
        {Array.isArray(pnl?.basamaklar) && pnl.basamaklar.length > 0 && (() => {
          const bas = pnl.basamaklar;
          const ciroTl = Math.abs(sayi(bas[0]?.tutar_tl)) || 1;
          const netB = bas[bas.length - 1];
          const netPoz = sayi(netB?.tutar_tl) >= 0;
          const kars = sayi(pnl.favok_finansman_karsilama_pct);
          return (
            <div style={{
              ...kartYuzey, padding: '16px 19px', marginBottom: 14,
              borderLeft: `3px solid ${netPoz ? R.yesil : R.kirmizi}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontFamily: F.baslik, fontSize: 16, fontWeight: 600 }}>
                  📊 Kâr merdiveni · son {sayi(pnl.gun)} gün
                </span>
                <span style={{ fontSize: 11.5, color: R.not2 }}>tahakkuk — nakit takvimi Ödeme Merkezi'nde</span>
                {kars ? (
                  <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: kars >= 100 ? R.yesil : R.kirmizi }}>
                    FAVÖK, finansmanın %{trSayi(kars, 0)}'ini karşılıyor
                  </span>
                ) : null}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {bas.map((b, i) => {
                  const tut = sayi(b.tutar_tl);
                  const oran = Math.min(100, (Math.abs(tut) / ciroTl) * 100);
                  const araToplam = b.tur === 'ara_toplam' || b.tur === 'sonuc';
                  const renk = b.tur === 'gider' ? R.kirmizi
                    : b.tur === 'sonuc' ? (tut >= 0 ? R.yesil : R.kirmizi)
                      : b.tur === 'ara_toplam' ? R.bakirAcik : R.krem;
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 11,
                      paddingTop: araToplam ? 6 : 0,
                      borderTop: araToplam ? `1px solid ${R.cizgi3}` : 'none',
                    }}>
                      <span style={{
                        fontSize: araToplam ? 13 : 12.5, width: 168, flexShrink: 0,
                        color: araToplam ? R.krem : R.metin2, fontWeight: araToplam ? 700 : 400,
                      }}>{b.ad}</span>
                      <div style={{ flex: 1, height: araToplam ? 9 : 7, borderRadius: 99, background: R.girinti, overflow: 'hidden' }}>
                        <div style={{ width: `${oran}%`, height: '100%', background: renk, opacity: araToplam ? 0.85 : 0.6 }} />
                      </div>
                      <span style={{
                        fontSize: araToplam ? 13.5 : 12.5, fontFamily: F.mono, width: 128, textAlign: 'right',
                        color: renk, fontWeight: araToplam ? 700 : 400,
                      }}>{fmt(tut)}</span>
                      <span style={{ fontSize: 11, fontFamily: F.mono, width: 52, textAlign: 'right', color: R.not2 }}>
                        {b.ciro_pay_pct != null ? `%${trSayi(sayi(b.ciro_pay_pct), 1)}` : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {pnl.teshis && (
                <div style={{
                  marginTop: 13, padding: '10px 13px', borderRadius: 9, fontSize: 12.5, lineHeight: 1.6,
                  background: netPoz ? 'rgba(74,222,128,.08)' : 'rgba(248,113,113,.08)',
                  border: `1px solid ${netPoz ? R.yesil : R.kirmizi}33`,
                  color: netPoz ? R.metin2 : R.krem,
                }}>
                  {netPoz ? '✓ ' : '⚠ '}{pnl.teshis}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: R.not3, marginTop: 8, lineHeight: 1.55 }}>
                {pnl.not}
              </div>
            </div>
          );
        })()}

        {/* ── BAŞABAŞ NOKTASI (2026-08-07 denetimi) ──────────────────────────
            "Günde kaç ₺ satarsam zarar etmem?" — parçalar sistemde vardı,
            birleştiren ekran yoktu. İKİ eşik ayrı gösterilir: işletme (dükkân
            dönüyor mu) ve nakit (borç dahil, kasa eriyor mu). */}
        {basabas?.basabas?.nakit && (() => {
          const b = basabas.basabas;
          const m = basabas.mevcut || {};
          const s = basabas.sabit_yuk_aylik || {};
          const d = basabas.degisken_oran_pct || {};
          const gunluk = sayi(m.gunluk_ciro_ort_tl);
          const isl = sayi(b.isletme?.gunluk_tl);
          const nak = sayi(b.nakit?.gunluk_tl);
          const fark = gunluk - nak;
          const durumRenk = basabas.durum === 'ustunde' ? R.yesil
            : basabas.durum === 'sinirda' ? R.amber : R.kirmizi;
          const dolu = nak > 0 ? Math.min(100, (gunluk / nak) * 100) : 0;
          const islNokta = nak > 0 ? Math.min(100, (isl / nak) * 100) : 0;
          return (
            <div
              onClick={() => onCekmece?.({
                tip: 'BAŞABAŞ NOKTASI',
                baslik: 'Günde kaç ₺ satmalıyım?',
                alt: `${sayi(m.cirolu_gun)} cirolu günün ortalaması · öneri-only`,
                kpi: [
                  { etiket: 'İşletme eşiği', deger: `${fmt(isl)}/gün`, renk: gunluk >= isl ? R.yesil : R.kirmizi },
                  { etiket: 'Nakit eşiği', deger: `${fmt(nak)}/gün`, renk: gunluk >= nak ? R.yesil : R.kirmizi },
                  { etiket: 'Bugünkü ortalama', deger: `${fmt(gunluk)}/gün`, renk: durumRenk },
                ],
                listeBaslik: 'Aylık sabit yük (periyot normalize)',
                satirlar: [
                  { ad: 'Kira', detay: '6 aylık kira ÷6 yapıldı', tutar: fmt(sayi(s.kira)) },
                  { ad: 'Faturalar', detay: 'elektrik · su · internet', tutar: fmt(sayi(s.fatura)) },
                  { ad: 'Personel', detay: 'aktif kadro · maaş + yemek + yol', tutar: fmt(sayi(s.personel)) },
                  { ad: 'Diğer sabit', detay: '', tutar: fmt(sayi(s.diger)) },
                  { ad: '= İşletme sabit yükü', detay: 'dükkânın döndüğü taban', tutar: fmt(sayi(s.isletme_toplam)) },
                  { ad: 'Finansman (kart + kredi)', detay: 'ödeme planı · 30 gün', tutar: fmt(sayi(s.finansman)) },
                  { ad: '= Nakit sabit yükü', detay: 'kasanın erimediği taban', tutar: fmt(sayi(s.nakit_toplam)) },
                  { ad: 'Değişken oran', detay: `food cost %${sayi(d.food_cost).toFixed(1)} + POS %${sayi(d.pos_kesinti).toFixed(2)}`, tutar: `%${sayi(d.toplam).toFixed(1)}` },
                  ...(b.nakit_temkinli_fc28 ? [{
                    ad: 'Temkinli eşik (food cost %28)',
                    detay: 'reçete kapsaması düşükken güvenli taban',
                    tutar: `${fmt(sayi(b.nakit_temkinli_fc28.gunluk_tl))}/gün`,
                  }] : []),
                ],
                not: (basabas.varsayimlar || []).join(' · ') || basabas.not,
              })}
              style={{
                ...kartYuzey, padding: '15px 18px', marginBottom: 14, cursor: 'pointer',
                borderLeft: `3px solid ${durumRenk}`,
              }}
            >
              <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 10 }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>⚖️ Başabaş noktası</span>
                <span style={{ fontSize: 12.5, color: R.metin2 }}>
                  Bugünkü ortalama <b style={{ fontFamily: F.mono, color: durumRenk }}>{fmt(gunluk)}/gün</b>
                  {' · '}nakit eşiği <b style={{ fontFamily: F.mono }}>{fmt(nak)}/gün</b>
                </span>
                <span style={{
                  marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: durumRenk,
                }}>
                  {basabas.durum === 'ustunde' ? '✓ eşiğin üstünde'
                    : basabas.durum === 'sinirda' ? '≈ sınırda'
                      : `↓ günde ${fmt(Math.abs(fark))} eksik`}
                </span>
              </div>
              {/* Tek çubuk: nereye kadar geldik + işletme eşiği işareti */}
              <div style={{ position: 'relative', height: 9, borderRadius: 99, background: R.girinti, overflow: 'hidden' }}>
                <div style={{ width: `${dolu}%`, height: '100%', background: durumRenk, opacity: 0.75 }} />
                <div style={{
                  position: 'absolute', left: `${islNokta}%`, top: -3, width: 2, height: 15,
                  background: R.bakirAcik,
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: R.not2, marginTop: 5 }}>
                <span>işletme eşiği {fmt(isl)}/gün — dükkân döner</span>
                <span>nakit eşiği {fmt(nak)}/gün — borç dahil · dokun, döküm</span>
              </div>
            </div>
          );
        })()}

        {/* ── GÜNLÜK KÂR & VERGİ (sahip isteği 2026-08-03: "eski alandaki gibi
            günlük net kâr + vergiyi Maliyet'te göreyim") — klasik Kâr&Maliyet
            ekranının P&L alt satırı. Sunucu HER alanı zaten gönderiyordu
            (net_kar_net_tl, tahmini_vergi, KDV üçlüsü, kova kırılımları) —
            v2 yalnız grup kırılımını gösteriyordu. KDV TAM-MODEL dili:
            net = KDV-HARİÇ (ödenecek KDV P&L DIŞI, ayrı satırda). */}
        {gunGun && (() => {
          const satirlarP = (Array.isArray(gunGun.satirlar) ? gunGun.satirlar : [])
            .slice().sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)));
          if (!satirlarP.length) return null;
          // KPI kuralı (klasik f946935 dersi): toplamlar YALNIZ cirolu günlerden —
          // cirosu girilmemiş gün birikmiş maliyetiyle sahte zarar göstermesin.
          const cirolu = satirlarP.filter((g) => sayi(g.ciro_tl) > 0);
          const t30net = cirolu.reduce((s, g) => s + sayi(g.net_kar_net_tl ?? g.net_kar_tl), 0);
          const t30vergi = cirolu.reduce((s, g) => s + sayi(g.tahmini_vergi_net_tl ?? g.tahmini_vergi_tl), 0);
          const t30kdv = cirolu.reduce((s, g) => s + sayi(g.odenecek_kdv_tl), 0);
          const sonGun = cirolu[0] || null;
          const KOVALAR = [
            ['net_cogs_tl', 'Malzeme (COGS)'], ['personel_maliyet_tl', 'Personel'],
            ['sgk_isveren_tl', 'SGK işveren'], ['kira_maliyet_tl', 'Kira'],
            ['fatura_maliyet_tl', 'Faturalar'], ['abonelik_maliyet_tl', 'Abonelik'],
            ['pos_komisyon_tl', 'POS komisyonu'], ['platform_komisyon_tl', 'Platform komisyonu'],
            ['fire_maliyet_tl', 'Fire'], ['iade_maliyet_tl', 'İade'],
            ['sube_anlik_gider_tl', 'Anlık gider'],
          ];
          return (
            <>
              <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 11 }}>
                  💰 Günlük kâr & vergi · son {sayi(gunGun.gun) || 30} gün
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10, marginBottom: 4 }}>
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>SON CİROLU GÜN NET</div>
                    <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: sonGun && sayi(sonGun.net_kar_net_tl ?? sonGun.net_kar_tl) >= 0 ? R.yesil : R.kirmizi }}>
                      {sonGun ? fmt(sayi(sonGun.net_kar_net_tl ?? sonGun.net_kar_tl)) : '—'}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>
                      {sonGun ? `${tarihKisa(sonGun.tarih)} · ${sonGun.sube_adi || ''} · KDV-hariç` : 'cirolu gün yok'}
                    </div>
                  </div>
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>NET KÂR (CİROLU GÜNLER)</div>
                    <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: t30net >= 0 ? R.yesil : R.kirmizi }}>{fmt(t30net)}</div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>{cirolu.length} şube-gün · KDV-hariç model</div>
                  </div>
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>TAHMİNÎ VERGİ</div>
                    <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: R.amber }}>{fmt(t30vergi)}</div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>şube tipine göre efektif oran · detay Vergi & KDV</div>
                  </div>
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>ÖDENECEK KDV</div>
                    <div style={{ fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 4, color: R.krem }}>{fmt(t30kdv)}</div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>P&L DIŞI — kasadan çıkacak ayrı yük</div>
                  </div>
                </div>
              </div>

              <Tablo
                baslik="Gün gün kâr"
                not="satıra tıkla → gider kovaları + kâr basamakları · cirosuz gün marjsız gösterilir"
                kolonlar={[
                  { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Ciro', sag: true },
                  { ad: 'Toplam gider', sag: true }, { ad: 'Net kâr', sag: true },
                  { ad: 'Net marj', sag: true }, { ad: 'Vergi', sag: true },
                ]}
                satirlar={satirlarP.slice(0, 21).map((g, i) => {
                  const ciroG = sayi(g.ciro_tl);
                  const net = sayi(g.net_kar_net_tl ?? g.net_kar_tl);
                  const marj = g.net_marj_net_pct ?? g.net_marj_pct;
                  return {
                    id: `${g.tarih}-${g.sube_id || i}`,
                    _g: g,
                    hucreler: [
                      { v: tarihKisa(g.tarih), mono: true },
                      { v: g.sube_adi || '—', renk: R.not },
                      ciroG > 0
                        ? { v: fmt(ciroG), mono: true, sag: true, sira: ciroG }
                        : { v: 'girilmedi', sag: true, renk: R.amber, sira: -1 },
                      { v: fmt(sayi(g.net_toplam_maliyet_tl)), mono: true, sag: true, sira: sayi(g.net_toplam_maliyet_tl) },
                      { v: fmt(net), mono: true, sag: true, kalin: true, renk: net >= 0 ? R.yesil : R.kirmizi, sira: net },
                      marj != null && ciroG > 0
                        ? { v: `%${sayi(marj).toFixed(1)}`, mono: true, sag: true, renk: sayi(marj) >= 0 ? R.yesil : R.kirmizi, sira: sayi(marj) }
                        : { v: '—', sag: true, renk: R.not3, sira: -999 },
                      { v: fmt(sayi(g.tahmini_vergi_net_tl ?? g.tahmini_vergi_tl)), mono: true, sag: true, renk: R.amber },
                    ],
                  };
                })}
                onSatir={({ _g }) => {
                  const g = _g;
                  const kovalar = KOVALAR
                    .map(([k, ad]) => ({ ad, tutar: sayi(g[k]) }))
                    .filter((x) => x.tutar > 0);
                  onCekmece?.({
                    tip: 'GÜNLÜK KÂR KIRILIMI',
                    baslik: `${g.sube_adi || 'Şube'} · ${tarihKisa(g.tarih)}`,
                    alt: sayi(g.ciro_tl) > 0 ? `ciro ${fmt(sayi(g.ciro_tl))}` : 'ciro girilmedi — marj hesaplanamaz',
                    kpi: [
                      { etiket: 'Brüt kâr', deger: fmt(sayi(g.brut_kar_tl)), renk: sayi(g.brut_kar_tl) >= 0 ? R.yesil : R.kirmizi },
                      { etiket: 'FAVÖK', deger: fmt(sayi(g.favok_tl)), renk: sayi(g.favok_tl) >= 0 ? R.yesil : R.kirmizi },
                      { etiket: 'Net kâr (KDV-hariç)', deger: fmt(sayi(g.net_kar_net_tl ?? g.net_kar_tl)), renk: sayi(g.net_kar_net_tl ?? g.net_kar_tl) >= 0 ? R.yesil : R.kirmizi },
                      { etiket: 'Vergi (efektif)', deger: `%${Math.round(sayi(g.vergi_efektif_oran_pct))}`, renk: R.amber },
                    ],
                    listeBaslik: 'Gider kovaları (KDV-hariç)',
                    satirlar: [
                      ...kovalar.map((x) => ({ ad: x.ad, detay: '', tutar: fmt(x.tutar) })),
                      { ad: 'Tahminî vergi', detay: 'şube tipine göre', tutar: fmt(sayi(g.tahmini_vergi_net_tl ?? g.tahmini_vergi_tl)) },
                      { ad: 'Ödenecek KDV', detay: 'P&L DIŞI — ayrı nakit yükü', tutar: fmt(sayi(g.odenecek_kdv_tl)) },
                    ],
                    not: 'Kâr basamakları: brüt = ciro − COGS · FAVÖK = brüt − işletme giderleri · '
                      + 'net = faaliyet − tahminî vergi. Tüm gider satırları KDV-HARİÇ modeldedir; '
                      + 'ödenecek KDV kârı etkilemez, kasadan ayrıca çıkar.',
                  });
                }}
              />
            </>
          );
        })()}

        {/* ── KANONİK MALİYET: L1 gerçek (ürün-aç) ↔ L2 beklenen (reçete) ↔ L3 sapma ──
            Sahip doktrini + Codex (2026-08-03): para ÜRÜN-AÇ'tan sürülür, reçete
            KONTROL eder. Beklenen ASLA ölçeklenmez — kapsama % ile alt sınırdır. */}
        {(() => {
          const l1 = gunler.reduce((s, g) => s + sayi(g.actual_open_cogs_tl ?? g.gercek_maliyet_tl ?? g.teorik_maliyet_tl), 0);
          const l2li = gunler.filter((g) => g.theoretical_recipe_cogs_tl != null);
          if (!l2li.length) return null;
          const l2 = l2li.reduce((s, g) => s + sayi(g.theoretical_recipe_cogs_tl), 0);
          const sapma = l1 - l2;
          const kapsamalar = l2li.map((g) => sayi(g.teorik_kapsama_pct)).filter((x) => x > 0);
          const ortKapsama = kapsamalar.length ? kapsamalar.reduce((a, b) => a + b, 0) / kapsamalar.length : null;
          const altSinir = l2li.some((g) => g.teorik_alt_sinir);
          return (
            <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14, fontWeight: 600 }}>Gerçek ↔ Beklenen</span>
                <span style={{ fontSize: 12, color: R.metin2 }}>
                  gerçek (ürün-aç) <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(l1)}</b>
                </span>
                <span style={{ fontSize: 12, color: R.metin2 }}>
                  beklenen (satış×reçete) <b style={{ fontFamily: F.mono, color: R.mavi }}>{fmt(l2)}</b>
                  {altSinir ? <span style={{ color: R.amber }}> ≥ alt sınır</span> : null}
                </span>
                <span style={{ fontSize: 12, color: R.metin2 }}>
                  sapma <b style={{ fontFamily: F.mono, color: sapma > 0 ? R.kirmizi : R.yesil }}>
                    {sapma > 0 ? '+' : ''}{fmt(sapma)}
                  </b>
                </span>
                {ortKapsama != null && (
                  <span style={{ fontSize: 11, color: R.not2 }}>satış kapsaması ~%{ortKapsama.toFixed(0)}</span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: R.not3, marginTop: 7, lineHeight: 1.55 }}>
                Sapma + ise açılan mal, satışın gerektirdiğinden fazla (fire/porsiyon/kayıt) —
                gözlem, hüküm değil. Beklenen yalnız eşleşmiş+fiyatlı satışları kapsar,
                ölçekleme yapılmaz; kapsama düşükken sapma yorumu temkinli okunur.
              </div>
            </div>
          );
        })()}

        {/* ── GÜVEN SKORU + SAPMA MOTORU (öneri-only, SALT-OKUR) ──
            Food cost sayısının kendisi kadar önemli: o sayı ne kadar
            güvenilir? Sapma motoru "48M ciro / 70K bardak" tipi veri-kalitesi
            kazalarını ÖNCEDEN yakalar. Hiçbir veriyi değiştirmez. */}
        {guven && (() => {
          const skor = sayi(guven.genel_skor);
          const sapmalar = Array.isArray(guven.sapmalar) ? guven.sapmalar : [];
          const kovalar = Array.isArray(guven.kovalar) ? guven.kovalar : [];
          const zayif = kovalar.filter((k) => k.durum === 'zayif');
          const skorRenk = skor >= 85 ? R.yesil : skor >= 60 ? R.amber : R.kirmizi;
          return (
            <div style={{
              ...kartYuzey, padding: '15px 18px', marginBottom: 14,
              borderColor: sayi(guven.kritik_sapma) ? `${R.kirmizi}55` : `${skorRenk}33`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: sapmalar.length ? 11 : 0 }}>
                <span style={{ fontFamily: F.mono, fontSize: 22, fontWeight: 700, color: skorRenk }}>
                  {skor}<span style={{ fontSize: 13, color: R.not2 }}>/100</span>
                </span>
                <span style={{ fontSize: 12.5, color: R.metin2 }}>
                  <b>Maliyet güven skoru</b>
                  {zayif.length
                    ? ` — zayıf halka: ${zayif.map((k) => k.baslik).join(', ')}`
                    : ' — veri kalitesi iyi'}
                </span>
                {/* Kova kova skor: hangi girdi maliyeti güvenilmez yapıyor */}
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                  {kovalar.map((k) => (
                    <span key={k.kova} title={k.mesaj || ''} style={{
                      padding: '4px 10px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                      whiteSpace: 'nowrap',
                      background: k.durum === 'zayif' ? `${R.kirmizi}1e` : k.durum === 'orta' ? `${R.amber}1e` : `${R.yesil}18`,
                      color: k.durum === 'zayif' ? R.kirmizi : k.durum === 'orta' ? R.amber : R.yesil,
                    }}>{k.baslik} {sayi(k.skor)}</span>
                  ))}
                </span>
              </div>

              {sapmalar.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11, color: R.not2 }}>
                    ⚠ {sapmalar.length} şüpheli değer — <b>öneri-only</b>, hiçbir veri değiştirilmedi.
                    {sayi(guven.kritik_sapma) > 0 && ' Kritik sapma genel skoru düşürür.'}
                  </div>
                  {sapmalar.slice(0, 5).map((s, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                      padding: '8px 11px', borderRadius: 9, background: R.girinti,
                      borderLeft: `3px solid ${s.siddet === 'kritik' ? R.kirmizi : R.amber}`,
                    }}>
                      <span style={{
                        flexShrink: 0, fontSize: 10, fontWeight: 700,
                        color: s.siddet === 'kritik' ? R.kirmizi : R.amber,
                      }}>{s.tip === 'FIYAT_OUTLIER' ? 'FİYAT' : 'ADET'}</span>
                      <span style={{ flex: 1, minWidth: 0, color: R.metin2 }}>{s.mesaj}</span>
                      {s.kat != null && (
                        <span style={{ flexShrink: 0, fontFamily: F.mono, fontWeight: 700, color: R.kirmizi }}>
                          {sayi(s.kat)}×
                        </span>
                      )}
                    </div>
                  ))}
                  {sapmalar.length > 5 && (
                    <div style={{ fontSize: 11, color: R.not3 }}>+{sapmalar.length - 5} sapma daha</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── PARA NEREYE GİDİYOR — kalem grubu kırılımı (/maliyet/gun-gun) ──
            Food cost %31 diyor ama hangi grup? Süt mü, bardak mı, pasta mı?
            Ürün-aç tüketimi × alış fiyatı, grup grup toplanır. */}
        {gunGun && (() => {
          const kolonlar = Array.isArray(gunGun.kolonlar) ? gunGun.kolonlar : [];
          const satirlarG = Array.isArray(gunGun.satirlar) ? gunGun.satirlar : [];
          const fiyatsiz = Array.isArray(gunGun.fiyat_eksik_kalemler) ? gunGun.fiyat_eksik_kalemler : [];
          if (!kolonlar.length || !satirlarG.length) return null;
          // Grup toplamı: tüm gün+şube satırları üzerinden
          const gruplar = kolonlar.map((k) => ({
            kod: k.kod,
            baslik: k.baslik,
            toplam: satirlarG.reduce((s, r) => s + sayi(r[k.kod]), 0),
          })).filter((g) => g.toplam > 0).sort((a, b) => b.toplam - a.toplam);
          const genelToplam = gruplar.reduce((s, g) => s + g.toplam, 0);
          if (!genelToplam) return null;
          return (
            <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                  Para nereye gidiyor · kalem grubu · son {sayi(gunGun.gun) || 30} gün
                </span>
                <span style={{ fontSize: 11.5, color: R.not2 }}>
                  ürün-aç tüketimi × alış fiyatı · toplam {fmt(genelToplam)}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {gruplar.slice(0, 10).map((g) => {
                  const o = (g.toplam / genelToplam) * 100;
                  return (
                    <div key={g.kod} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                      <span style={{ fontSize: 11.5, width: 108, flexShrink: 0, color: R.metin2 }}>{g.baslik}</span>
                      <span style={{ flex: 1, height: 8, borderRadius: 99, background: R.cizgi2, overflow: 'hidden' }}>
                        <span style={{
                          display: 'block', height: '100%', borderRadius: 99,
                          width: `${Math.max(2, o)}%`,
                          background: `linear-gradient(90deg, ${R.bakirKoyu}, ${R.bakir})`,
                        }} />
                      </span>
                      <span style={{ fontSize: 11, color: R.not2, width: 42, textAlign: 'right', flexShrink: 0 }}>
                        %{Math.round(o)}
                      </span>
                      <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, width: 100, textAlign: 'right', flexShrink: 0 }}>
                        {fmt(g.toplam)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* Fiyatı tanımsız kalem = maliyete HİÇ girmiyor → food cost düşük çıkar */}
              {fiyatsiz.length > 0 && (
                <div style={{
                  marginTop: 11, padding: '9px 13px', borderRadius: 10,
                  background: `${R.kirmizi}12`, border: `1px solid ${R.kirmizi}33`,
                  fontSize: 11.5, color: R.not, lineHeight: 1.55,
                }}>
                  ⚠ <b>{fiyatsiz.length} kalemin alış fiyatı tanımlı değil</b> — bu kalemler maliyete
                  {' '}<b>hiç girmiyor</b>, food cost olduğundan düşük görünüyor:
                  {' '}{fiyatsiz.slice(0, 8).join(' · ')}{fiyatsiz.length > 8 ? ` +${fiyatsiz.length - 8}` : ''}
                </div>
              )}
            </div>
          );
        })()}

        {/* Altyapı eksikleri — food cost hesabının GÜVENİLİRLİĞİNİ etkiler:
            alış fiyatı ya da reçete eksikse maliyet olduğundan düşük çıkar. */}
        {altyapiEksik.length > 0 && (
          <div style={{
            ...kartYuzey, padding: '12px 17px', marginBottom: 14, borderColor: `${R.amber}44`,
            display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={rozetHap(R.amber)}>⚠ altyapı eksik</span>
            <span style={{ fontSize: 11.5, color: R.not, lineHeight: 1.55, flex: 1, minWidth: 200 }}>
              {altyapiEksik.join(' · ')}
              {' — '}bu eksikler giderilmeden food cost <b>olduğundan düşük</b> çıkabilir.
            </span>
          </div>
        )}
        {seri.length >= 2 ? (
          <Hero
            etiket="Food cost · günlük seyir (ürün maliyeti / ciro)"
            deger={foodCost == null ? '—' : pct(foodCost)}
            delta={bench?.ad}
            deltaTip={bench?.tip || 'notr'}
            not={`Son ${siraliGunler.length} günün toplamı: ciro ${fmt(toplamCiro)} · ürün maliyeti ${fmt(toplamMaliyet)}. Kahve zinciri normu ${bandMetni} — çizgi bu bandın üstüne çıktığı gün maliyet yönetimi gerektirir.`}
            seri={seri}
            seriEtiket={siraliGunler.map(tarihKisa)}
            seriAd="food cost"
            seriBicim={pct}
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
    // ── GERÇEK MALİYET (sahip doktrini, 2026-08-07) ─────────────────────────
    // "Maliyet reçeteden değil, personelin şube panelinden açtığı ÜRÜN-AÇ'tan
    // hesaplanmalı; reçete yalnız TEYİT basamağı." Bu ekran reçeteyi GERÇEK gibi
    // sunuyordu (başlık: 'reçete × güncel alış fiyatı'). Artık gerçek ölçüm
    // ÖNCE gelir, reçete altında ve 'beklenen/teyit' etiketiyle durur.
    // Not: ürün-aç KALEM bazlıdır ("süt açtım"), ürün bazlı değil ("Latte için
    // açtım") — bu yüzden gerçek maliyet KALEM GRUBU kırılımıyla verilir; ürün
    // başına dağıtım ancak reçeteyle olur ve o zaten teyit katmanıdır.
    const gercekGruplar = (() => {
      const kol = Array.isArray(gunGun?.kolonlar) ? gunGun.kolonlar : [];
      const sat = Array.isArray(gunGun?.satirlar) ? gunGun.satirlar : [];
      if (!kol.length || !sat.length) return null;
      const g = kol.map((k) => ({
        kod: k.kod, baslik: k.baslik,
        toplam: sat.reduce((s, r) => s + sayi(r[k.kod]), 0),
      })).filter((x) => x.toplam > 0).sort((a, b) => b.toplam - a.toplam);
      const top = g.reduce((s, x) => s + x.toplam, 0);
      return top > 0 ? { gruplar: g, toplam: top, gun: sayi(gunGun.gun) || 30 } : null;
    })();
    return (
      <>
        <KpiSeridi kpiler={[
          {
            etiket: 'GERÇEK maliyet',
            deger: gercekGruplar ? fmt(gercekGruplar.toplam) : '—',
            alt: gercekGruplar ? `ürün-aç defteri · son ${gercekGruplar.gun} gün` : 'ürün-aç verisi yok',
            renk: gercekGruplar ? R.bakirAcik : R.not,
          },
          { etiket: 'Reçeteli ürün', deger: String(receteler.length), alt: 'teyit için tanımlı' },
          { etiket: 'Fiyatsız hammaddeli', deger: String(eksikli.length), alt: 'teyit EKSİK kalır', renk: eksikli.length > 0 ? R.amber : R.yesil },
          { etiket: 'Tanımlı alış fiyatı', deger: String((fiyatlar || []).filter((f) => !f.gecerli_bitis).length), alt: 'aktif kayıt' },
        ]} />

        {/* ── 1) GERÇEK — personelin açtığı üründen ─────────────────────────── */}
        {gercekGruplar ? (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, borderLeft: `3px solid ${R.bakir}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                ☕ Gerçek maliyet · ürün-aç defteri
              </span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                son {gercekGruplar.gun} gün · toplam <b style={{ fontFamily: F.mono, color: R.bakirAcik }}>{fmt(gercekGruplar.toplam)}</b>
              </span>
            </div>
            <div style={{ fontSize: 11, color: R.not2, marginBottom: 12, lineHeight: 1.55 }}>
              Personel şube panelinden ürün açtıkça düşen <b style={{ color: R.metin2 }}>gerçek tüketim</b> × alış fiyatı.
              Maliyetin kaynağı budur — aşağıdaki reçete tablosu bunu <b style={{ color: R.metin2 }}>teyit eder</b>, yerine geçmez.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gercekGruplar.gruplar.slice(0, 10).map((g) => {
                const o = (g.toplam / gercekGruplar.toplam) * 100;
                return (
                  <div key={g.kod} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <span style={{ fontSize: 11.5, width: 112, flexShrink: 0, color: R.metin2 }}>{g.baslik}</span>
                    <div style={{ flex: 1, height: 7, borderRadius: 99, background: R.girinti, overflow: 'hidden' }}>
                      <div style={{ width: `${o}%`, height: '100%', background: R.bakir, opacity: 0.8 }} />
                    </div>
                    <span style={{ fontSize: 11.5, fontFamily: F.mono, width: 92, textAlign: 'right', color: R.krem }}>{fmt(g.toplam)}</span>
                    <span style={{ fontSize: 10.5, fontFamily: F.mono, width: 42, textAlign: 'right', color: R.not2 }}>%{o.toFixed(1)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, borderLeft: `3px solid ${R.not3}` }}>
            <div style={{ fontSize: 12.5, color: R.metin2 }}>
              ☕ <b>Gerçek maliyet</b> (ürün-aç defteri) henüz hazırlanıyor — aşağıdaki reçete tablosu
              beklenen maliyeti gösterir, gerçeğin yerine geçmez.
            </div>
          </div>
        )}

        {/* Sistemde satış fiyatı yok — marj bilerek gösterilmiyor (sahte sayı yasağı).
            Bu şerit o kısıtı GÖRÜNÜR yapar (desen 8). */}
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ kapsam</span>
          Bu tablo <b style={{ color: R.metin2 }}>BEKLENEN</b> malzeme maliyetidir (reçete × alış fiyatı) —
          gerçek maliyet yukarıdaki ürün-aç defterinden gelir; burası <b style={{ color: R.metin2 }}>teyit</b> katmanıdır.
          Satış fiyatı sisteme bağlı değil —
          marj yüzdesi hesaplanamaz; fiyatsız hammadde satırları maliyeti eksik bırakır (kırmızı rozet).
        </div>

        {receteler.length === 0 ? (
          <BosDurum metin="Henüz reçete tanımlı değil — Reçete Eşleştirme ekranından tanımlanır." />
        ) : (
          <Tablo
            baslik="Beklenen ürün maliyeti · reçete × alış fiyatı (teyit katmanı)"
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
              _hedef: '__modul:maliyet:ozet',
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
        {rcModalBlok}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <button onClick={() => setRcModal({ tip: 'foodcost', tarih: '', tarih_bitis: '' })} style={mlBtn}>
            🧮 Food-cost hesapla
          </button>
        </div>
        <KpiSeridi kpiler={[
          { etiket: 'Tanımlı reçete', deger: String(receteler.length), alt: 'ürün kartı' },
          { etiket: 'Aktif alış fiyatı', deger: String((fiyatlar || []).filter((f) => !f.gecerli_bitis).length), alt: 'hammadde fiyatı' },
          {
            etiket: 'Eksiksiz reçete',
            // durum sunucudan geliyorsa onu say (exact+approx = tamamı fiyatlı);
            // legacy satırda eski istemci hesabı yedek kalır
            deger: String(receteler.filter((r) => (r.durum
              ? (r.durum === 'exact' || r.durum === 'approx')
              : receteMaliyet(r).fiyatsiz === 0)).length),
            alt: 'tüm kalemleri fiyatlandı',
            renk: R.yesil,
          },
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
                        {/* Codex sözleşmesi: kısmi fiyatlanan ürün "0 TL" ya da
                            "tam maliyet" DEĞİL — "5 kalemin 3'ü fiyatlandı" dili */}
                        {r.toplam_n != null
                          ? `${r.toplam_n} kalemin ${sayi(r.fiyatlanan_n)}'i fiyatlandı`
                          : `${(r.hammaddeler || []).length} hammadde`}
                      </div>
                    </div>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                      {/* 4 kademeli dürüstlük damgası (exact/approx/partial/unpriced) */}
                      {r.durum === 'exact' && <span style={rozetHap(R.yesil)}>kesin</span>}
                      {r.durum === 'approx' && <span style={rozetHap(R.amber)}>≈ varsayımlı</span>}
                      {r.durum === 'partial' && <span style={rozetHap(R.kirmizi)}>kısmi</span>}
                      {r.durum === 'unpriced' && <span style={rozetHap(R.not3)}>fiyatlanamadı</span>}
                      {!r.durum && h.fiyatsiz > 0 && <span style={rozetHap(R.kirmizi)}>{h.fiyatsiz} fiyatsız</span>}
                      {/* Kanonik evrenden türetilen satırda CRUD kapalı — buradaki
                          form boş urun_recete tablosuna (yanlış evrene) yazardı.
                          Düzenleme yeri: Reçete Eşleştirme. */}
                      {receteKaynak !== 'recete_projeksiyon' && (
                        <>
                          <button onClick={() => setRcModal({ tip: 'duzenle', recete: r,
                            kalemler: (r.hammaddeler || []).map((x) => ({
                              hammadde_kodu: x.hammadde_kodu, hammadde_adi: x.hammadde_adi,
                              miktar: x.miktar, birim: x.birim || 'adet',
                            })) })} style={mlMini}>Düzenle</button>
                          <button onClick={() => setRcModal({ tip: 'sil', recete: r })}
                            style={{ ...mlMini, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Sil</button>
                        </>
                      )}
                    </span>
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

  // ── YERLİ EŞLEŞTİRME MODALI (her görünümden açılabilir) ───────────────────
  const eslestirmeModali = eslModal && (() => {
    const hepsi = eslListe || [];
    const oneriler = hepsi.filter((r) => r.durum === 'oneri' && r.tip === eslTip);
    const onaylilar = hepsi.filter((r) => r.durum === 'onayli' && r.tip === eslTip);
    const kaynakListe = eslTip === 'urun' ? (adaylar?.recete_urunler || []) : (adaylar?.recete_malzemeler || []);
    const hedefListe = eslTip === 'urun' ? (adaylar?.evo_adlar || []) : (adaylar?.depo_kalemler || []);
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget && !eslMesgul) setEslModal(false); }} style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 680, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>🔗 Reçete Eşleştirme</div>
            <div style={{ fontSize: 11.5, color: R.not2 }}>öneriler onaysız KULLANILMAZ</div>
            <button onClick={() => setEslModal(false)} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>✕</button>
          </div>
          <div style={{ fontSize: 11.5, color: R.not, marginBottom: 14, lineHeight: 1.55 }}>
            Kural: reçetedeki <b>"Ice X"</b> = Evo'daki <b>"X Ice"</b> · sade ad = <b>"X 14 Oz"</b>.
            Eşleşmeyen ürünün satışı tüketim kontrolüne girmez.
          </div>

          <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            {[['urun', '🥤 Ürün ↔ Evo satış'], ['malzeme', '📦 Malzeme ↔ depo']].map(([t, ad]) => (
              <div key={t} onClick={() => setEslTip(t)} style={{
                padding: '7px 14px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${eslTip === t ? R.bakir : R.cizgi3}`,
                color: eslTip === t ? R.bakir : R.metin2,
                background: eslTip === t ? 'rgba(217,154,78,.14)' : 'transparent',
              }}>{ad}</div>
            ))}
            <button disabled={!!eslMesgul} onClick={eslOnerUret} style={{
              marginLeft: 'auto', padding: '7px 13px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.metin2,
              fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
            }}>
              {eslMesgul === 'oner' ? 'Taranıyor…' : '🔍 Öneri üret (Evo katalogunu tara)'}
            </button>
          </div>

          {eslListe == null ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: R.not, fontSize: 13 }}>Yükleniyor…</div>
          ) : (
            <>
              <div style={{ fontSize: 11, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 8 }}>
                Onay bekleyen ({oneriler.length})
              </div>
              {oneriler.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, padding: '10px 0 16px' }}>
                  Bekleyen öneri yok. Yeni ürün eklendiyse "Öneri üret"e bas.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 16 }}>
                  {oneriler.slice(0, 40).map((r) => (
                    <div key={r.id} style={{
                      display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
                      padding: '9px 13px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>
                        <span style={{ color: R.metin2 }}>{r.kaynak_ad}</span>
                        <span style={{ color: R.not2, margin: '0 7px' }}>→</span>
                        <span style={{ fontWeight: 700 }}>{r.hedef_ad}</span>
                        {r.benzerlik != null && (
                          <span style={{ ...rozetHap(r.benzerlik >= 0.99 ? R.yesil : r.benzerlik >= 0.7 ? R.amber : R.kirmizi), marginLeft: 8 }}>
                            %{Math.round(sayi(r.benzerlik) * 100)}
                          </span>
                        )}
                      </div>
                      <button disabled={!!eslMesgul} onClick={() => eslKarar(r.id, 'onayli')} style={{
                        padding: '6px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.yesil}22`, color: R.yesil, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                      }}>{eslMesgul === r.id ? '…' : '✓ Onayla'}</button>
                      <button disabled={!!eslMesgul} onClick={() => eslKarar(r.id, 'reddedildi')} style={{
                        padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                        color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>✗ Reddet</button>
                    </div>
                  ))}
                </div>
              )}

              {/* elle eşleştirme */}
              {elleForm ? (
                <div style={{ padding: '13px 16px', borderRadius: 12, background: R.girinti, border: `1px solid ${R.bakir}44`, marginBottom: 14 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: R.bakir, marginBottom: 11 }}>
                    Elle eşleştir ({eslTip === 'urun' ? 'ürün' : 'malzeme'}) — insan kararı doğrudan onaylıdır
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
                    <div>
                      <label style={mlEtiket}>Reçetedeki ad</label>
                      <select value={elleForm.kaynak_ad} onChange={(e) => setElleForm((f) => ({ ...f, kaynak_ad: e.target.value }))} style={mlAlanStil}>
                        <option value="">Seçin…</option>
                        {kaynakListe.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={mlEtiket}>{eslTip === 'urun' ? 'Evo satış adı' : 'Depo kalemi'}</label>
                      <select
                        value={eslTip === 'urun' ? elleForm.hedef_ad : elleForm.hedef_kod}
                        onChange={(e) => {
                          if (eslTip === 'urun') setElleForm((f) => ({ ...f, hedef_ad: e.target.value, hedef_kod: '' }));
                          else {
                            const k = (hedefListe || []).find((x) => String(x.kalem_kodu) === e.target.value);
                            setElleForm((f) => ({ ...f, hedef_kod: e.target.value, hedef_ad: k?.kalem_adi || '' }));
                          }
                        }}
                        style={mlAlanStil}
                      >
                        <option value="">Seçin…</option>
                        {eslTip === 'urun'
                          ? (hedefListe || []).map((a) => <option key={a} value={a}>{a}</option>)
                          : (hedefListe || []).map((k) => <option key={k.kalem_kodu} value={k.kalem_kodu}>{k.kalem_adi}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 12 }}>
                    <button disabled={!!eslMesgul} onClick={() => setElleForm(null)} style={{
                      padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={!!eslMesgul} onClick={elleEkle} style={{
                      padding: '8px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>{eslMesgul === 'elle' ? 'Kaydediliyor…' : 'Eşleştir'}</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setElleForm({ tip: eslTip, kaynak_ad: '', hedef_ad: '', hedef_kod: '' })} style={{
                  padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600,
                  fontFamily: 'inherit', marginBottom: 14,
                }}>
                  ✍️ Elle eşleştir (öneri yoksa)
                </button>
              )}

              <div style={{ fontSize: 11, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 8 }}>
                Onaylı eşleşmeler ({onaylilar.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 200, overflowY: 'auto' }}>
                {onaylilar.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: R.not }}>Henüz onaylı eşleşme yok.</div>
                ) : onaylilar.slice(0, 60).map((r) => (
                  <div key={r.id} style={{ fontSize: 12, color: R.metin2, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: R.yesil }}>✓</span>
                    <span style={{ color: R.not }}>{r.kaynak_ad}</span>
                    <span style={{ color: R.not2 }}>→</span>
                    <span>{r.hedef_ad}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    );
  })();

  // ════════════════════════ GÖRÜNÜM: TÜKETİM KONTROLÜ ═══════════════════════
  // Sahip isteği (2026-07-28): "satışın verisine göre maliyet — bara giren ürün
  // açılımını takip edip fazla kullanımı saptayalım." Motor zaten kuruluydu
  // (recete_api.kontrol): BEKLENEN = Evo satış × reçete, GERÇEK = ürün-aç defteri
  // × ambalaj içeriği (bar sayımlı malzemede devir-bilinçli). Burada yalnız
  // TASARIMA getirildi — öneri-only: hiçbir yazma yok, hüküm insanın.
  if (gorunum === 'tuketim') {
    if (kontrolHata) return <HataBandi mesaj={kontrolHata} onTekrar={kontrolYukle} />;
    if (!kontrol) return <Yukleniyor />;

    // Eşleştirme henüz kurulmamışsa dürüst boş durum + köprü
    if (kontrol.durum === 'eslestirme_bekliyor') {
      return (
        <>
          <KpiSeridi kpiler={[
            { etiket: 'Onaylı ürün eşleşmesi', deger: String(sayi(kontrol.onayli_urun)), alt: 'reçete ↔ Evo satış adı', renk: R.amber },
            { etiket: 'Onaylı malzeme', deger: String(sayi(kontrol.onayli_malzeme)), alt: 'reçete ↔ depo kalemi', renk: R.amber },
            { etiket: 'Bekleyen öneri', deger: String(sayi(kontrol.bekleyen_oneri)), alt: 'onayını bekliyor', renk: R.kirmizi },
            { etiket: 'Durum', deger: 'kurulum', alt: 'eşleştirme tamamlanmalı' },
          ]} />
          <div style={{ ...kartYuzey, padding: '30px 26px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600 }}>
              Kontrol için eşleştirme onayı gerekiyor
            </div>
            <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6, maxWidth: 520, margin: '8px auto 0' }}>
              Satış × reçete karşılaştırması, reçete adlarının Evo satış adlarıyla ve
              malzemelerin depo kalemleriyle eşleşmesini ister. {sayi(kontrol.bekleyen_oneri)} öneri onay bekliyor.
            </div>
            <button
              onClick={() => eslAc()}
              style={{
                marginTop: 16, padding: '10px 18px', borderRadius: 11, border: 'none',
                background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              Eşleştirme onayına git
            </button>
          </div>
          {eslestirmeModali}
        </>
      );
    }

    const kiyas = Array.isArray(kontrol.kiyas) ? kontrol.kiyas : [];
    // Malzeme bazında grupla
    const gruplar = {};
    kiyas.forEach((s) => {
      const k = `${s.malzeme}|${s.birim}`;
      (gruplar[k] = gruplar[k] || { malzeme: s.malzeme, birim: s.birim, gunler: [] }).gunler.push(s);
    });
    const netFark = (s) => s.fark_fire_sonrasi ?? s.fark;
    const netYuzde = (s) => s.fark_yuzde_fire_sonrasi ?? s.fark_yuzde;
    const grupListe = Object.values(gruplar).map((g) => {
      const olculen = g.gunler.filter((s) => netFark(s) != null);
      const fazla = olculen.filter((s) => (netYuzde(s) ?? 0) >= 15);
      // KALICI TEK YÖNLÜ fark = insanın bakacağı yer (motorun kendi notu):
      // ölçülen ≥3 gün ve hepsi aynı yönde ve ortalama %10'u aşıyor
      const ort = olculen.length
        ? olculen.reduce((t, s) => t + (netYuzde(s) ?? 0), 0) / olculen.length : 0;
      const kalici = olculen.length >= 3
        && (olculen.every((s) => netFark(s) > 0) || olculen.every((s) => netFark(s) < 0))
        && Math.abs(ort) >= 10;
      return { ...g, olculen, fazla, ort, kalici };
    }).sort((a, b) => b.fazla.length - a.fazla.length || Math.abs(b.ort) - Math.abs(a.ort));
    const toplamFazla = grupListe.reduce((t, g) => t + g.fazla.length, 0);
    const enSert = kiyas.reduce((m, s) => Math.max(m, netYuzde(s) ?? -Infinity), -Infinity);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen malzeme', deger: String(grupListe.length), alt: `son ${sayi(kontrol.kesit_gun)} gün · onaylı eşleşme` },
          { etiket: 'Fazla kullanım', deger: String(toplamFazla), alt: 'beklenenden %15+ fazla (gün×malzeme)', renk: toplamFazla > 0 ? R.kirmizi : R.yesil },
          { etiket: 'En sert sapma', deger: Number.isFinite(enSert) ? `+${pct(enSert).slice(1)}` : '—', alt: 'tek günde', renk: Number.isFinite(enSert) && enSert >= 15 ? R.kirmizi : R.krem },
          { etiket: 'Eşleşme', deger: `${sayi(kontrol.onayli_urun_es)} ürün · ${sayi(kontrol.onayli_malzeme_es)} malzeme`, alt: 'onaylı köprüler' },
        ]} />

        {/* Öneri-only ilkesi ekranda (desen 8) — motorun kendi cümlesi */}
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ gözlem</span>
          Beklenen = Evo satış × reçete · Gerçek = bara açılan ürün (devir bilinçli).
          Fark ± fire/işçilik payı normaldir — <b style={{ color: R.metin2 }}>KALICI ve TEK YÖNLÜ fark</b> insanın
          bakacağı yerdir. Bu ekran hüküm vermez, stok akışına dokunmaz.
        </div>

        {grupListe.length === 0 ? (
          <BosDurum metin="Kıyaslanabilir gün yok — satış verisi ve ürün-aç kaydı biriktikçe bu ekran dolar." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginBottom: 16 }}>
            {grupListe.map((g) => (
              <div key={`${g.malzeme}|${g.birim}`} style={{
                ...kartYuzey, padding: '16px 18px',
                border: g.kalici ? `1px solid ${g.ort > 0 ? R.kirmizi : R.amber}55` : kartYuzey.border,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10, flexWrap: 'wrap',
                }}>
                  <div>
                    <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>
                      {g.malzeme}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>
                      {g.olculen.length}/{g.gunler.length} gün ölçülebildi · birim {g.birim}
                    </div>
                  </div>
                  {g.kalici ? (
                    <span style={rozetHap(g.ort > 0 ? R.kirmizi : R.amber)}>
                      ⚠ kalıcı {g.ort > 0 ? 'fazla kullanım' : 'eksik açılış'} · ort {g.ort > 0 ? '+' : ''}{Math.round(g.ort)}%
                    </span>
                  ) : g.fazla.length > 0 ? (
                    <span style={rozetHap(R.amber)}>{g.fazla.length} gün fazla</span>
                  ) : g.olculen.length > 0 ? (
                    <span style={rozetHap(R.yesil)}>✓ uyumlu</span>
                  ) : (
                    <span style={rozetHap(R.not2)}>ölçülemedi</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {g.gunler.slice(-7).map((s, i) => {
                    const f = netFark(s); const y = netYuzde(s);
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
                        <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2, minWidth: 46 }}>{tarihKisa(s.gun)}</span>
                        <span style={{ color: R.metin2 }}>beklenen <b style={{ fontFamily: F.mono }}>{s.beklenen_miktar}</b></span>
                        <span style={{ flex: 1, height: 1, background: R.cizgi2 }} />
                        {f == null ? (
                          <span style={{ fontSize: 10.5, color: R.not3 }}>
                            {s.eksik === 'bar_sayim_yok' ? 'bar sayımı yok'
                              : s.eksik === 'ambalaj_icerigi_tanimsiz' ? 'ambalaj tanımsız'
                              : s.eksik === 'urun_ac_kaydi_yok' ? 'ürün-aç kaydı yok' : 'ölçülemedi'}
                          </span>
                        ) : (
                          <>
                            <span style={{ color: R.metin2 }}>gerçek <b style={{ fontFamily: F.mono }}>{s.gercek_miktar}</b></span>
                            <span style={{
                              fontFamily: F.mono, fontSize: 11.5, fontWeight: 700, minWidth: 58, textAlign: 'right',
                              color: (y ?? 0) >= 15 ? R.kirmizi : (y ?? 0) <= -15 ? R.amber : R.yesil,
                            }}>
                              {f > 0 ? '+' : ''}{f}{y != null ? ` (%${Math.round(y)})` : ''}
                            </span>
                            {s.bildirilen_fire ? (
                              <span style={{ fontSize: 9.5, color: R.not2 }} title="bildirilen fire düşüldü">🗑 {s.bildirilen_fire}</span>
                            ) : null}
                            {s.kapanis_gecici && <span style={{ fontSize: 9.5, color: R.not3 }}>geçici</span>}
                            {s.ambalaj_varsayim && <span style={{ fontSize: 9.5, color: R.amber }} title="ambalaj içeriği varsayım — teyit bekliyor">≈</span>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── DEĞİRMEN KIYASI — üçüncü katman (makine gerçeği) ──
            Reçete kontrolü iki katmanı kıyaslar: satış×reçete (beklenen) ↔
            ürün-aç (BİLDİRİLEN). İkisi de insan girdisine bağlı.
            Değirmen sayacı bildirimden BAĞIMSIZ: kimse bir şey girmese de
            makine çekimi sayar. Fark ±kalibrasyon/ikram payı taşır — gözlemdir. */}
        {Array.isArray(degirmen?.gun_kiyasi) && degirmen.gun_kiyasi.length > 0 && (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 11, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                Değirmen kıyası · makine gerçeği ↔ beklenen
              </span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                doz {sayi(degirmen.doz_gramaj?.cift)}g çift · son {sayi(degirmen.kesit_gun) || 7} gün
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {degirmen.gun_kiyasi.slice(0, 7).map((g, i) => {
                const bek = g.beklenen_gram;
                const fark = sayi(g.fark_gram);
                const yuzde = sayi(g.fark_yuzde);
                const eksikSube = sayi(g.sube_sayisi) < 4;
                return (
                  <div key={g.tarih || i} style={{
                    display: 'flex', alignItems: 'center', gap: 11, fontSize: 11.5,
                    padding: '8px 12px', borderRadius: 9, background: R.girinti,
                  }}>
                    <span style={{ fontFamily: F.mono, color: R.not, flexShrink: 0, width: 54 }}>{tarihKisa(g.tarih)}</span>
                    <span style={{ flex: 1, minWidth: 0, color: R.metin2, fontFamily: F.mono }}>
                      makine {sayi(g.makine_gram)}g
                      {bek != null ? ` ↔ beklenen ${sayi(bek)}g` : ' · beklenen hesaplanamadı'}
                    </span>
                    {eksikSube && (
                      <span style={{ flexShrink: 0, fontSize: 10, color: R.amber }}>
                        {sayi(g.sube_sayisi)}/4 şube — kıyas eksik
                      </span>
                    )}
                    {bek != null && (
                      <>
                        <span style={{
                          flexShrink: 0, fontFamily: F.mono, fontWeight: 700,
                          color: Math.abs(yuzde) > 15 ? R.kirmizi : Math.abs(yuzde) > 7 ? R.amber : R.yesil,
                        }}>{fark > 0 ? '+' : ''}{fark}g</span>
                        <span style={{ flexShrink: 0, fontSize: 10.5, color: R.not2, width: 74, textAlign: 'right' }}>
                          %{yuzde} · {sayi(g.fark_cekim)} çekim
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: R.not2, marginTop: 9, lineHeight: 1.55 }}>
              ℹ Sayaç israfı DA sayar (tek 8oz'da ikinci shot çöpe gidebilir) — bu farkın
              doğal parçasıdır ve <b>görünür olması istenir</b>. Sayaç sıfırlanan gün hesaplanmaz.
              Fark ± kalibrasyon/ikram payı taşır; <b>yorum insanın</b>.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
          <button
            onClick={() => eslAc()}
            style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Reçete & eşleştirme yönetimi
          </button>
          <button
            onClick={() => onKopru?.('__modul:denetim:duyu')}
            style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            Duyu Paneli'nde geçmiş bulgular
          </button>
        </div>
        {eslestirmeModali}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: VERGİ & KDV ════════════════════════════
  // ⚠️ P&L DIŞI — sunucunun kendi tanımı. KDV ne gelir ne giderdir; devlet
  // adına tahsil edilir/ödenir. Bu yüzden Marj Özeti'ne KARIŞTIRILMADI.
  // Vergi tarafı da burada: şubeler KARMA (şahıs/şirket) — düz oran YANLIŞ
  // olurdu, uç şube şube vergi_tipi + yöntem + efektif oran gönderiyor.
  if (gorunum === 'vergi') {
    if (vergiHata) return <HataBandi mesaj={vergiHata} onTekrar={vergiYukle} />;
    if (!vergi) return <Yukleniyor />;
    const kdv = vergi.kdv || {};
    const vrg = vergi.vergi || {};
    const kdvSatir = Array.isArray(kdv.satirlar) ? kdv.satirlar : [];
    const vrgSatir = Array.isArray(vrg.satirlar) ? vrg.satirlar : [];
    const odenecek = sayi(kdv.toplam_odenecek_tl);
    const kdvOran = sayi(kdv.kdv_oran);
    return (
      <>
        <KpiSeridi kpiler={[
          {
            etiket: 'Ödenecek KDV',
            deger: fmt(odenecek),
            alt: `hesaplanan ${fmt(sayi(kdv.toplam_hesaplanan_tl))} − indirilecek ${fmt(sayi(kdv.toplam_indirilecek_tl))}`,
            renk: odenecek > 0 ? R.kirmizi : R.yesil,
          },
          { etiket: 'Hesaplanan KDV', deger: fmt(sayi(kdv.toplam_hesaplanan_tl)), alt: 'satıştan · ciro KDV dahil girilir', renk: R.krem },
          { etiket: 'İndirilecek KDV', deger: fmt(sayi(kdv.toplam_indirilecek_tl)), alt: 'alış + gider · kalem bazlı oran', renk: R.yesil },
          {
            etiket: 'Tahminî vergi',
            deger: fmt(sayi(vrg.toplam_vergi_tl)),
            alt: `vergi öncesi kâr ${fmt(sayi(vrg.toplam_vergi_oncesi_kar_tl))}`,
            renk: R.amber,
          },
        ]} />

        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ P&L dışı</span>
          KDV ne gelir ne giderdir — devlet adına tahsil edilir/ödenir, bu yüzden kâr tablosuna
          <b>&nbsp;girmez</b>. Vergi rakamı <b>tahminîdir</b>: yönetsel gösterge, resmî beyan değil.
        </div>

        {/* ── 🏛️ MÜKELLEF BAZLI — beyan ŞUBEYE değil MÜKELLEFE verilir ──
            2026-08-09 sahip denetimi: şube bazlı toplam iki şeyi yanlış gösteriyordu.
            (1) Bir şubenin devreden KDV'si ancak AYNI mükellefin başka şubesinin
                borcundan düşülebilir — şube satırı bunu söylemiyordu.
            (2) Vergi şube başına hesaplanınca zarar eden şube YOK SAYILIYORDU;
                oysa aynı mükellefin zararı kârdan düşer. */}
        {(Array.isArray(kdv.mukellefler) || Array.isArray(vrg.mukellefler)) && (
          <div style={{ ...kartYuzey, padding: '13px 16px', marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: R.krem, marginBottom: 4 }}>
              🏛️ Mükellef bazlı — beyan bu kırılımda verilir
            </div>
            <div style={{ fontSize: 11, color: R.not2, marginBottom: 10, lineHeight: 1.55 }}>
              Beyanname şubeye değil mükellefe verilir. Bir şubenin devreden KDV'si ya da
              zararı yalnız <b>aynı mükellefin</b> diğer şubesiyle mahsuplaşır — başka
              mükellefe geçemez.
            </div>
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              {(kdv.mukellefler || []).map((m) => (
                <div key={`k${m.mukellef}`} style={{
                  flex: '1 1 230px', minWidth: 220, padding: '10px 12px', borderRadius: 10,
                  background: R.girinti, border: `1px solid ${R.cizgi}`,
                  borderLeft: `3px solid ${sayi(m.net_tl) > 0 ? R.kirmizi : R.yesil}`,
                }}>
                  <div style={{ fontSize: 11.5, color: R.metin2 }}>
                    KDV · {m.mukellef_adi}
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, color: R.krem, marginTop: 2 }}>
                    {fmt(Math.abs(sayi(m.net_tl)))}
                  </div>
                  <div style={{ fontSize: 10.5, color: sayi(m.net_tl) > 0 ? R.kirmizi : R.yesil, marginTop: 2 }}>
                    {m.durum}
                  </div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4, lineHeight: 1.45 }}>
                    hesaplanan {fmt(sayi(m.hesaplanan_kdv_tl))} − indirilecek {fmt(sayi(m.indirilecek_kdv_tl))}
                    <br />{(m.subeler || []).join(' · ')}
                  </div>
                </div>
              ))}
              {(vrg.mukellefler || []).map((m) => (
                <div key={`v${m.mukellef}`} style={{
                  flex: '1 1 230px', minWidth: 220, padding: '10px 12px', borderRadius: 10,
                  background: R.girinti, border: `1px solid ${R.cizgi}`,
                  borderLeft: `3px solid ${R.amber}`,
                }}>
                  <div style={{ fontSize: 11.5, color: R.metin2 }}>
                    Gelir/Kurumlar · {m.mukellef_adi}
                  </div>
                  <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, color: R.krem, marginTop: 2 }}>
                    {fmt(sayi(m.tahmini_vergi_tl))}
                  </div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2 }}>{m.yontem}</div>
                  <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4, lineHeight: 1.45 }}>
                    matrah {fmt(sayi(m.vergi_oncesi_kar_tl))} (zarar mahsuplu)
                    <br />{(m.subeler || []).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
            {sayi(vrg.zarar_mahsubu_kazanci_tl) > 0 && (
              <div style={{
                marginTop: 10, padding: '9px 12px', borderRadius: 9,
                background: R.girinti, borderLeft: `3px solid ${R.yesil}`,
                fontSize: 11.5, color: R.metin2, lineHeight: 1.6,
              }}>
                💡 Zarar mahsubu kazancı: <b style={{ color: R.yesil }}>
                  {fmt(sayi(vrg.zarar_mahsubu_kazanci_tl))}</b> — şube şube toplansaydı
                bu kadar fazla vergi hesaplanırdı. Zarar eden şube, aynı mükellefin kâr eden
                şubesinin matrahını düşürür.
              </div>
            )}
          </div>
        )}

        {/* ── VERGİ TAKVİMİ — "ne kadar" değil "NE ZAMAN" ──
            Ödenecek KDV tutarı yukarıda; buradaki soru para ne gün çıkacak.
            Sunucunun kendi uyarısı: beyanname DEĞİL, yönetim tahmini. */}
        {Array.isArray(vergi.takvim?.takvim) && vergi.takvim.takvim.length > 0 && (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 11, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>Vergi nakit takvimi</span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>ödeme günleri pratik varsayım — muhasebeci takvimi esastır</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {vergi.takvim.takvim.map((t, i) => {
                const tutar = sayi(t.odenecek_tl ?? t.odenecek_kdv_tl ?? t.tutar);
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 11, fontSize: 12,
                    padding: '9px 13px', borderRadius: 10, background: R.girinti,
                    borderLeft: `3px solid ${t.hata ? R.kirmizi : R.bakir}`,
                  }}>
                    <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 150 }}>{t.tur || '—'}</span>
                    {t.hata ? (
                      <span style={{ flex: 1, color: R.kirmizi }}>{t.hata}</span>
                    ) : (
                      <>
                        <span style={{ flex: 1, minWidth: 0, color: R.not2 }}>
                          {t.donem || ''}{t.rozet ? ` · ${t.rozet}` : ''}
                        </span>
                        {t.son_odeme && (
                          <span style={{ fontFamily: F.mono, fontSize: 11.5, color: R.amber, flexShrink: 0 }}>
                            son ödeme {String(t.son_odeme).slice(0, 10)}
                          </span>
                        )}
                        <span style={{ fontFamily: F.mono, fontWeight: 700, flexShrink: 0, minWidth: 90, textAlign: 'right' }}>
                          {tutar ? fmt(tutar) : '—'}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── KİRA STOPAJI — brüt kira P&L'de kalır, stopaj vergi dairesine ── */}
        {sayi(vergi.stopaj?.toplam_stopaj_tl) > 0 && (
          <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>Kira stopajı</span>
              <span style={{ fontSize: 12, color: R.not }}>
                brüt <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(vergi.stopaj.toplam_brut_tl))}</b>
                {' = '}mülk sahibine <b style={{ fontFamily: F.mono, color: R.yesil }}>{fmt(sayi(vergi.stopaj.toplam_net_tl))}</b>
                {' + '}vergi dairesine <b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(sayi(vergi.stopaj.toplam_stopaj_tl))}</b>
                <span style={{ color: R.not2 }}> · {sayi(vergi.stopaj.adet)} kira</span>
              </span>
            </div>
            {/* A-2. tur: kira kira döküm — toplam vardı ama HANGİ kiranın ne
                kadar stopajı olduğu görünmüyordu (satirlar[] okunmuyordu). */}
            {(Array.isArray(vergi.stopaj?.satirlar) ? vergi.stopaj.satirlar : []).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
                {vergi.stopaj.satirlar.slice(0, 6).map((s, i) => (
                  <div key={s.id || i} style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                    padding: '6px 11px', borderRadius: 8, background: R.girinti,
                  }}>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>{s.gider_adi || '—'}</span>
                    <span style={{ flexShrink: 0, color: R.not2 }}>%{sayi(s.stopaj_yuzde)}</span>
                    <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.krem }}>{fmt(sayi(s.brut_tl))}</span>
                    <span style={{ flexShrink: 0, color: R.not3 }}>=</span>
                    <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.yesil }}>{fmt(sayi(s.net_odenecek_tl))}</span>
                    <span style={{ flexShrink: 0, color: R.not3 }}>+</span>
                    <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.kirmizi }}>{fmt(sayi(s.stopaj_tl))}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, color: R.not2, marginTop: 7, lineHeight: 1.55 }}>
              ⚠ Brüt kira <b>P&L gideridir ve değişmez</b>. Stopaj ayrı bir nakit çıkışı değil,
              brütün içinden devlete giden paydır — mülk sahibine net ödenir (muhtasar).
            </div>
          </div>
        )}

        {kdvSatir.length > 0 && (
          <Tablo
            baslik={`KDV pozisyonu · son ${sayi(kdv.gun) || 30} gün`}
            not={`KDV oranı %${Math.round(kdvOran * 100)} · hesaplanan KDV cirodan KESİN, indirilecek TAHMİNÎ`}
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Hesaplanan', sag: 1 }, { ad: 'İndirilecek', sag: 1 },
              { ad: 'Ödenecek', sag: 1 },
            ]}
            satirlar={kdvSatir.map((x, i) => ({
              id: x.sube_id || `kd-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                { v: fmt(sayi(x.hesaplanan_kdv_tl)), mono: true, sag: true },
                { v: fmt(sayi(x.indirilecek_kdv_tl)), mono: true, sag: true, renk: R.yesil },
                {
                  v: fmt(sayi(x.odenecek_kdv_tl)), mono: true, sag: true, kalin: true,
                  renk: sayi(x.odenecek_kdv_tl) > 0 ? R.kirmizi : R.yesil,
                },
              ],
            }))}
          />
        )}

        {vrgSatir.length > 0 && (
          <Tablo
            baslik={`Tahminî vergi · son ${sayi(vrg.gun) || 30} gün`}
            not="şubeler KARMA: şahıs şubede artan dilim (efektif oran), şirkette kurumlar vergisi"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Vergi tipi' }, { ad: 'Vergi öncesi kâr', sag: 1 },
              { ad: 'Efektif oran', sag: 1 }, { ad: 'Tahminî vergi', sag: 1 }, { ad: 'Vergi sonrası', sag: 1 },
            ]}
            satirlar={vrgSatir.map((x, i) => ({
              id: x.sube_id || `vg-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                {
                  v: /sahis|şahıs/i.test(String(x.vergi_tipi || '')) ? 'şahıs' : 'şirket',
                  rozet: /sahis|şahıs/i.test(String(x.vergi_tipi || '')) ? R.mavi : R.bakir,
                },
                { v: fmt(sayi(x.vergi_oncesi_kar_tl)), mono: true, sag: true },
                { v: pct(sayi(x.efektif_oran_pct)), mono: true, sag: true, renk: R.amber },
                { v: fmt(sayi(x.tahmini_vergi_tl)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: fmt(sayi(x.vergi_sonrasi_kar_tl)), mono: true, sag: true, renk: R.yesil },
              ],
            }))}
          />
        )}

        {(kdv.not || vrg.not) && (
          <div style={{ fontSize: 11, color: R.not2, lineHeight: 1.6, marginBottom: 16 }}>
            {kdv.not && <div>ℹ {kdv.not}</div>}
            {vrg.not && <div style={{ marginTop: 6 }}>ℹ {vrg.not}</div>}
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

        {/* ══ FİYAT & KDV YÖNETİMİ (Faz 6) — zinciri sadece izlemek yetmiyor ══ */}
        <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>Fiyat & KDV yönetimi</div>
            <div style={{ fontSize: 11.5, color: R.not2 }}>
              {sayi(fiyatlar?.length)} kalemde fiyat · {kdvOranlar === null ? '…' : `${sayi(kdvOranlar.length)} kalemde KDV tanımlı`}
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
            Alış fiyatı ürün maliyetinin, KDV oranı da net kârın <b>girdisidir</b> —
            eksik ya da yanlışsa marj tablosu yanlış çıkar. Elle girilen fiyat
            <b> açılış birimi</b> fiyatıdır; içerik katsayısı uygulanmaz.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setFyModal({ tip: 'fiyat', kalem_kodu: '', kalem_adi: '', birim: 'adet', birim_maliyet_tl: '', gecerli_baslangic: '', tedarikci: '', notlar: '' })}
              style={mlBtn}>+ Alış fiyatı gir</button>
            <button onClick={() => setFyModal({ tip: 'kdv', kalem_kodu: '', kalem_adi: '', kdv_yuzde: 20 })}
              style={mlBtn}>% KDV oranı ata</button>
            <button onClick={() => setFyModal({ tip: 'kdv-oto', force: false })}
              style={mlBtn}>⚡ KDV'yi otomatik doldur</button>
          </div>

          {/* Fiyatı olan kalemler — düzelt / sil / KDV ata */}
          {!!(fiyatlar || []).length && (
            <div style={{ marginTop: 14, maxHeight: 340, overflowY: 'auto' }}>
              {(fiyatlar || []).slice(0, 60).map((f, i) => {
                const kdv = (kdvOranlar || []).find((k) => String(k.kalem_kodu) === String(f.kalem_kodu));
                return (
                  <div key={f.id || i} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                    borderRadius: 9, background: R.girinti, marginBottom: 5, fontSize: 12, flexWrap: 'wrap',
                  }}>
                    <span style={{ fontWeight: 600 }}>{f.kalem_adi || f.kalem_kodu}</span>
                    <span style={{ color: R.not, fontFamily: 'ui-monospace, monospace' }}>
                      {fmt(sayi(f.birim_maliyet_tl))} ₺ / {f.birim || 'adet'}
                    </span>
                    {kdv ? (
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: `${R.yesil}1E`, color: R.yesil }}>
                        KDV %{Math.round(sayi(kdv.kdv_oran) * 100) || sayi(kdv.kdv_yuzde)}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: `${R.amber}22`, color: R.amber }}>
                        KDV tanımsız
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => setFyModal({ tip: 'fiyat', kalem_kodu: f.kalem_kodu, kalem_adi: f.kalem_adi || '', birim: f.birim || 'adet', birim_maliyet_tl: String(sayi(f.birim_maliyet_tl)), gecerli_baslangic: '', tedarikci: f.tedarikci || '', notlar: '' })}
                        style={mlMini}>Yeni fiyat</button>
                      <button onClick={() => setFyModal({ tip: 'kdv', kalem_kodu: f.kalem_kodu, kalem_adi: f.kalem_adi || '', kdv_yuzde: kdv ? Math.round(sayi(kdv.kdv_oran) * 100) || 20 : 20 })}
                        style={mlMini}>KDV</button>
                      {f.id && (
                        <button onClick={() => setFyModal({ tip: 'fiyat-sil', fiyat: f })}
                          style={{ ...mlMini, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Sil</button>
                      )}
                      <button onClick={() => setFyModal({ tip: 'kalem-temizle', kalem_kodu: f.kalem_kodu, kalem_adi: f.kalem_adi })}
                        style={{ ...mlMini, color: R.kirmizi, borderColor: `${R.kirmizi}44` }}>Kalemi temizle</button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {fyModalBlok}

        {/* ══ FATURA PDF'TEN FİYAT (elle girmeye alternatif) ══ */}
        <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 16 }}>
          <div style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
            Fatura PDF'inden fiyat al
          </div>
          <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 12 }}>
            Tedarikçi faturasını yükle; kalemler çıkarılır ve <b>tek tek onayınla</b>
            {' '}alış fiyatına dönüşür. Onaylamadığın hiçbir satır fiyata yazılmaz —
            okuma hatası maliyeti sessizce bozmasın diye. Bu ekran belge arşivi değil;
            faturanın kendisini saklamak için Belge Merkezi'ni kullan.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ minWidth: 180 }}>
              <label style={mlEtiket}>Tedarikçi (isteğe bağlı)</label>
              <input value={fpTedarikci} onChange={(e) => setFpTedarikci(e.target.value)} style={mlAlanStil} />
            </div>
            <label style={{ ...mlBtn, display: 'inline-flex', alignItems: 'center', marginBottom: 2 }}>
              {fpYukleniyor ? 'Okunuyor…' : '📄 PDF seç'}
              <input type="file" accept="application/pdf" style={{ display: 'none' }}
                onChange={(e) => { faturaPdfYukle(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>
          {!!fpUyari && (
            <div style={{
              marginTop: 12, padding: '10px 14px', borderRadius: 9, fontSize: 12,
              background: `${R.amber}18`, border: `1px solid ${R.amber}44`, color: R.amber, lineHeight: 1.6,
            }}>{fpUyari}</div>
          )}
          {Array.isArray(fpSatirlar) && fpSatirlar.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: R.metin2, marginBottom: 8 }}>
                <b>{sayi(fpSatirlar.length)}</b> kalem onay bekliyor
              </div>
              {fpSatirlar.slice(0, 40).map((x, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                  borderRadius: 9, background: R.girinti, marginBottom: 5, fontSize: 12, flexWrap: 'wrap',
                }}>
                  <span style={{ fontWeight: 600, flex: 1, minWidth: 140 }}>
                    {x.kalem_adi || x.ad || x.aciklama || x.ham_metin || 'kalem'}
                  </span>
                  {x.miktar != null && <span style={{ color: R.not2 }}>{x.miktar} {x.birim || ''}</span>}
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: R.krem }}>
                    {fmt(sayi(x.birim_maliyet_tl ?? x.birim_fiyat ?? x.tutar))} ₺
                  </span>
                  <button onClick={() => setFpOnayModal({
                    _i: i,
                    ham_metin: x.ham_metin || x.aciklama || x.ad || '',
                    kalem_kodu: x.kalem_kodu || x.urun_kodu || '',
                    kalem_adi: x.kalem_adi || x.ad || '',
                    urun_kodu: x.urun_kodu || '',
                    aciklama: x.aciklama || '',
                    birim: x.birim || 'adet',
                    birim_maliyet_tl: String(sayi(x.birim_maliyet_tl ?? x.birim_fiyat ?? x.tutar) || ''),
                    tedarikci: x.tedarikci || fpTedarikci || '',
                    gecerli_baslangic: '',
                  })} style={{ ...mlMini, marginLeft: 'auto' }}>Onayla</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {fpOnayModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !fpMesgul) setFpOnayModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 128, background: 'rgba(10,6,2,.72)',
            backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 500, maxWidth: '96vw', padding: '24px 26px', maxHeight: '88vh', overflowY: 'auto' }}>
              <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>Kalemi fiyata çevir</div>
              <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 12 }}>
                Faturadan okunan satır aşağıda. <b>Kalem kodu</b> sistemin stok kalemiyle
                eşleştiği yerdir — yanlış kod yanlış ürünün maliyetini bozar, kontrol et.
                Onaylanan satır alış fiyatı zincirine tarihiyle eklenir.
              </div>
              <div style={{
                padding: '9px 12px', borderRadius: 9, background: R.girinti, fontSize: 11.5,
                color: R.not, marginBottom: 10, fontFamily: 'ui-monospace, monospace', lineHeight: 1.6,
              }}>{fpOnayModal.ham_metin || '—'}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 150, flex: 1 }}><label style={mlEtiket}>Kalem kodu</label>
                  <input value={fpOnayModal.kalem_kodu} autoFocus
                    onChange={(e) => setFpOnayModal((p) => ({ ...p, kalem_kodu: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ minWidth: 150, flex: 1 }}><label style={mlEtiket}>Kalem adı</label>
                  <input value={fpOnayModal.kalem_adi}
                    onChange={(e) => setFpOnayModal((p) => ({ ...p, kalem_adi: e.target.value }))} style={mlAlanStil} /></div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ maxWidth: 140 }}><label style={mlEtiket}>Birim maliyet ₺</label>
                  <input inputMode="decimal" value={fpOnayModal.birim_maliyet_tl}
                    onChange={(e) => setFpOnayModal((p) => ({ ...p, birim_maliyet_tl: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ maxWidth: 110 }}><label style={mlEtiket}>Birim</label>
                  <input value={fpOnayModal.birim}
                    onChange={(e) => setFpOnayModal((p) => ({ ...p, birim: e.target.value }))} style={mlAlanStil} /></div>
                <div style={{ maxWidth: 160 }}><label style={mlEtiket}>Geçerlilik başlangıcı</label>
                  <input type="date" value={fpOnayModal.gecerli_baslangic}
                    onChange={(e) => setFpOnayModal((p) => ({ ...p, gecerli_baslangic: e.target.value }))} style={mlAlanStil} /></div>
              </div>
              <label style={mlEtiket}>Tedarikçi</label>
              <input value={fpOnayModal.tedarikci}
                onChange={(e) => setFpOnayModal((p) => ({ ...p, tedarikci: e.target.value }))} style={mlAlanStil} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={fpMesgul} onClick={() => setFpOnayModal(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Vazgeç</button>
                <button disabled={fpMesgul} onClick={fpOnayla} style={{
                  padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                  fontFamily: 'inherit', border: 'none',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                }}>{fpMesgul ? 'İşleniyor…' : 'Fiyata çevir'}</button>
              </div>
            </div>
          </div>
        )}
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
