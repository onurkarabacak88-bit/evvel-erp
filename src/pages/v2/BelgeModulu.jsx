// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — BELGE MERKEZİ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → belge.* bölümleri
//
// 7 görünüm: Belge Kapsama · Fatura Arşivi (FTS) · Fatura İstek · Mükerrer &
//            Parmak İzi · Cari Ekstre · Fiyat Bandı · KDV Kanıt Paketi
//
// Veri omurgası: /api/fatura/belge-merkezi (kapsama + arşiv + KDV kanıt tek uç),
// /api/fatura-istek/liste (BM-4), /api/fatura/cari-ekstre (BM-5),
// /api/fatura/fiyat-bandi (BM-6), /api/fatura/ara (BM-8 FTS).
// TÜM görünümler SALT-OKUR; fatura isteme/onay mevcut ekranlarda (köprü).
// KDV kanıtında motorun kendi ilkesi ekranda: KDV TUTARI HESAPLANMAZ — hüküm
// muhasebecinin (sahte sayı yasağıyla birebir uyumlu).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Liste, Tablo, BosDurum, HataBandi } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const buAyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// Tarih aritmetiği YEREL kalır — toISOString UTC'ye çevirip TR'de günü geri kaydırır.
const bugunYerelISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const kisalt = (s, n = 90) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Cari ekstre hareket tipleri — sunucu `tip` alanıyla gönderir
// (fatura_api.cari_ekstre: fatura | odeme | devir).
const CARI_HAREKET = {
  fatura: { ad: 'Fatura', borc: true },
  odeme: { ad: 'Ödeme', borc: false },
  devir: { ad: 'Açılış devri', borc: true },
};

// Yerli form stilleri (köprü kaldırma turu)
const bmAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const bmEtiket = {
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
/** Fatura satırı → 3 sekmeli çekmece (Özet · Belgeler · İz).
 *  Yeni handoff'un merkez deseni: "tablo → tıkla → özet + bağlı belgeler +
 *  değişmez işlem izi". İz ADIMLARI YALNIZ GERÇEK ALANLARDAN türetilir —
 *  veri yoksa adım hiç yazılmaz (uydurma zincir yok). */
function faturaCekmecesi(b) {
  const ocrTamam = /tamam/i.test(String(b.durum || ''));
  const ocrHata = /hata/i.test(String(b.durum || ''));
  const iz = [
    {
      ad: 'Belge arşive girdi',
      detay: b.kaynak || 'PDF/foto yüklemesi',
      zaman: tarihKisa(b.tarih),
    },
  ];
  if (b.durum) {
    iz.push({
      ad: ocrTamam ? 'Kalemler okundu' : ocrHata ? 'Okuma başarısız' : `Durum: ${b.durum}`,
      detay: ocrTamam ? 'satır satır çözümlendi' : ocrHata ? 'elle kontrol gerekir' : 'işleniyor',
      renk: ocrTamam ? R.yesil : ocrHata ? R.kirmizi : R.amber,
      bekliyor: !ocrTamam && !ocrHata,
    });
  }
  if (b.parmak_izi || b.mukerrer != null) {
    iz.push({
      ad: b.mukerrer ? 'Mükerrer şüphesi' : 'Parmak izi alındı',
      detay: b.mukerrer ? 'aynı belge daha önce girmiş olabilir' : 'aynı belge iki kez girmez',
      renk: b.mukerrer ? R.kirmizi : R.yesil,
    });
  }
  if (b.gib_damga || b.gib) {
    iz.push({ ad: 'GİB damgası doğrulandı', detay: 'resmî belge', renk: R.yesil });
  }
  return {
    tip: 'FATURA KAYDI',
    baslik: kisalt(b.tedarikci_ad || b.toptanci || b.fatura_no || 'Fatura', 60),
    alt: `${tarihKisa(b.tarih)}${b.fatura_no ? ` · ${b.fatura_no}` : ''}`,
    kpi: [
      { etiket: 'Tutar', deger: fmt(sayi(b.tutar)), renk: R.krem },
      { etiket: 'Tarih', deger: tarihKisa(b.tarih) },
      { etiket: 'Durum', deger: ocrTamam ? 'işlendi' : (b.durum || '—'), renk: ocrTamam ? R.yesil : ocrHata ? R.kirmizi : R.amber },
      ...(b.bakiye_dahil != null ? [{ etiket: 'Bakiye (dahil)', deger: fmt(sayi(b.bakiye_dahil)) }] : []),
    ],
    listeBaslik: 'Belge',
    satirlar: [
      { ad: 'Tedarikçi', detay: 'cari kimlik', tutar: kisalt(b.tedarikci_ad || b.toptanci || '—', 34) },
      { ad: 'Belge no', detay: 'fatura numarası', tutar: b.fatura_no || '—' },
      { ad: 'Tutar', detay: 'belge üzerindeki', tutar: fmt(sayi(b.tutar)) },
    ],
    not: 'Fatura arşivi KDV kanıtının temelidir — belge 10 yıl saklanır, silinmez.',
    belgeler: b.goruntule
      ? [{ ad: `${kisalt(b.tedarikci_ad || b.toptanci || 'Fatura', 30)} · belge`, tur: 'PDF', boyut: 'arşivdeki asıl belge', url: b.goruntule, rozet: 'arşivde', rozetRenk: R.yesil }]
      : [],
    iz,
    dosyaBilgi: {
      'Kayıt no': String(b.id || '—'),
      'Kaynak modül': 'Belge Merkezi',
      'Belge tarihi': tarihKisa(b.tarih),
    },
  };
}

function KopruButon({ ad, onTikla, birincil }) {
  return (
    <button onClick={onTikla} style={birincil ? {
      padding: '9px 17px', borderRadius: 10, border: 'none',
      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
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

const fiMini = {
  padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 11, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const fiBtn = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};

export default function BelgeModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [merkez, setMerkez] = useState(null);
  const [merkezHata, setMerkezHata] = useState('');
  const [istek, setIstek] = useState(null);
  const [istekHata, setIstekHata] = useState('');
  // ── YERLİ BELGE TALEP YÖNETİMİ (köprü kaldırma turu, 2026-07-30) ──────────
  // Klasik BelgeMerkezi'nin "Açık Teslimat" akışı: elle talep aç · WhatsApp ile
  // fatura iste (wa.me + mesaj-gönderildi izi) · kanıtla kapat. Uçlar aynen.
  const [talep, setTalep] = useState(null);
  const [talepForm, setTalepForm] = useState(null);     // {ad, tarih, not}
  const [kapatForm, setKapatForm] = useState(null);     // {t, tip, aciklama}
  const [talepMesgul, setTalepMesgul] = useState(false);
  // Açılış devri beyanı (sistem öncesi bakiye) — klasik BelgeMerkezi akışı
  const [devirForm, setDevirForm] = useState(null);   // {tedarikci, tutar, aciklama}
  const [devirMesgul, setDevirMesgul] = useState(false);
  // Belge yükleme (faturasız harcamaya PDF/foto ekle) — klasik boru hattı
  const [yukMesgul, setYukMesgul] = useState(false);
  const [bant, setBant] = useState(null);
  const [bantHata, setBantHata] = useState('');
  const [cariSecim, setCariSecim] = useState('');
  const [cari, setCari] = useState(null);
  const [cariHata, setCariHata] = useState('');
  const [arama, setArama] = useState('');
  const [aramaSonuc, setAramaSonuc] = useState(null);
  // Kapsama ekranındaki harcama listesi seçimi (faturasiz | kurumsal | beklenmez)
  const [kapsamaListe, setKapsamaListe] = useState('faturasiz');
  const [araniyor, setAraniyor] = useState(false);

  const merkezYukle = useCallback(() => {
    setMerkezHata('');
    api(`/fatura/belge-merkezi?ay=${buAyISO()}`)
      .then((d) => setMerkez(d || {}))
      .catch((e) => setMerkezHata(e?.message || ''));
  }, []);

  const talepYukle = useCallback(() => {
    api('/belge-talep/bekleyen')
      .then((d) => setTalep(d || {}))
      .catch(() => setTalep({}));
  }, []);

  const talepEkle = async () => {
    const ad = (talepForm?.ad || '').trim();
    if (ad.length < 2) { onToast?.('Tedarikçi adı gerekli'); return; }
    if (talepMesgul) return;   // 🔁 (2026-08-12) çift-tık: mükerrer talep açma önle
    setTalepMesgul(true);
    try {
      await api('/belge-talep/elle', {
        method: 'POST',
        body: { tedarikci_ad: ad, teslim_tarihi: talepForm.tarih || null, not_metin: talepForm.not || null },
      });
      onToast?.('✓ Talep açıldı — fatura gelene dek burada bekler');
      setTalepForm(null);
      talepYukle();
    } catch (e) {
      onToast?.(e?.message || 'Eklenemedi');
    } finally {
      setTalepMesgul(false);
    }
  };

  const talepKapat = async () => {
    const { t, tip, aciklama } = kapatForm || {};
    if (!t?.id) return;
    if (tip === 'manuel' && !(aciklama || '').trim()) { onToast?.('Manuel kapanışta açıklama zorunlu'); return; }
    if (talepMesgul) return;   // 🔁 (2026-08-12) çift-tık: mükerrer kapatma önle
    setTalepMesgul(true);
    try {
      const body = tip === 'fatura' ? { durum: 'pdf_geldi', kapanis_tipi: 'fatura' }
        : tip === 'irsaliye' ? { durum: 'kapandi', kapanis_tipi: 'irsaliye' }
        : { durum: 'kapandi', kapanis_tipi: 'manuel', aciklama: aciklama.trim() };
      await api(`/belge-talep/${t.id}/kapat`, { method: 'POST', body });
      onToast?.(`${t.tedarikci_ad} talebi kapatıldı`);
      setKapatForm(null);
      talepYukle();
    } catch (e) {
      onToast?.(e?.message || 'Kapatılamadı');
    } finally {
      setTalepMesgul(false);
    }
  };

  const talepIste = (t) => {
    const tel = String(t.tedarikci_tel || '').replace(/\D/g, '');
    if (!tel) { onToast?.('📵 Telefon yok — Tanımlar ▸ Tedarikçiler\'den numara ekleyin'); return; }
    const msg = `Merhaba 🙏 ${t.teslim_tarihi ? `${t.teslim_tarihi} tarihli ` : ''}teslimatın faturasını rica ederiz.`;
    window.open(`https://wa.me/${tel.startsWith('90') ? tel : `90${tel}`}?text=${encodeURIComponent(msg)}`, '_blank');
    api(`/belge-talep/${t.id}/mesaj-gonderildi`, { method: 'POST' }).then(talepYukle).catch(() => {});
  };

  /** 📎 Fatura/belge yükle — PDF ise LLM kalem ayrıştırma, foto ise OCR yolu. */
  const belgeYukle = async (dosya) => {
    if (!dosya) return;
    setYukMesgul(true);
    try {
      const fd = new FormData();
      const isPdf = /pdf/i.test(dosya.type || '') || /\.pdf$/i.test(dosya.name || '');
      fd.append(isPdf ? 'pdf' : 'foto', dosya);
      const res = await fetch(isPdf ? '/api/fatura/yukle-pdf' : '/api/fatura/yukle', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d?.detail || 'Yüklenemedi');
      onToast?.(`📎 Belge arşive alındı${d?.kalem_sayisi ? ` — ${d.kalem_sayisi} kalem ayrıştırıldı` : ''}`);
      merkezYukle();
    } catch (e) {
      onToast?.(e?.message || 'Belge yüklenemedi');
    } finally {
      setYukMesgul(false);
    }
  };

  const devirKaydet = async () => {
    const t = Number(String(devirForm?.tutar || '').replace(',', '.'));
    if (!devirForm?.tedarikci || !Number.isFinite(t)) { onToast?.('Tedarikçi ve tutar gerekli'); return; }
    setDevirMesgul(true);
    try {
      await api('/fatura/cari-devir', {
        method: 'POST',
        body: { tedarikci: devirForm.tedarikci, tutar: t, aciklama: (devirForm.aciklama || '').trim() || null },
      });
      onToast?.(`✓ Açılış devri kaydedildi — ${devirForm.tedarikci}`);
      setDevirForm(null);
      cariYukle(devirForm.tedarikci);
    } catch (e) {
      onToast?.(e?.message || 'Devir kaydedilemedi');
    } finally {
      setDevirMesgul(false);
    }
  };

  const istekYukle = useCallback(() => {
    setIstekHata('');
    talepYukle();
    istisnaYukle();
    api('/fatura-istek/liste')
      .then((d) => setIstek(d || {}))
      .catch((e) => setIstekHata(e?.message || ''));
  }, [talepYukle]);

  const bantYukle = useCallback(() => {
    setBantHata('');
    api('/fatura/fiyat-bandi')
      .then((d) => setBant(d || {}))
      .catch((e) => setBantHata(e?.message || ''));
  }, []);

  const cariYukle = useCallback((tedarikci) => {
    if (!tedarikci) return;
    setCariHata('');
    setCari(null);
    api(`/fatura/cari-ekstre?tedarikci=${encodeURIComponent(tedarikci)}`)
      .then((d) => setCari(d || {}))
      .catch((e) => setCariHata(e?.message || ''));
  }, []);

  // ── FATURA İSTEĞİ EYLEMLERİ (Faz 7, 2026-07-31) ───────────────────────────
  // v2 istekleri GÖSTERİYORDU ama kapatamıyordu: gönderdiğini işaretleyemiyor,
  // numara giremiyor, "bu tedarikçiden belge beklenmez" diyemiyordu.
  const [fiModal, setFiModal] = useState(null);   // {tip, istek?, ...}
  const [fiMesgul, setFiMesgul] = useState(false);
  const [istisnalar, setIstisnalar] = useState(null);

  const istisnaYukle = useCallback(() => {
    api('/fatura-istek/istisnalar')
      .then((d) => setIstisnalar(Array.isArray(d?.kaliplar) ? d.kaliplar
        : (Array.isArray(d?.satirlar) ? d.satirlar : (Array.isArray(d) ? d : []))))
      .catch(() => setIstisnalar([]));
  }, []);

  const fiUygula = async () => {
    const m = fiModal;
    if (!m) return;
    if (fiMesgul) return;   // 🔁 (2026-08-12) çift-tık: gonderildi/kapat/tara/istisna-sil/ocr mükerrer POST'unu önle
    setFiMesgul(true);
    try {
      if (m.tip === 'gonderildi') {
        await api(`/fatura-istek/${m.istek.id}/gonderildi`, { method: 'POST' });
        onToast?.('✓ Gönderildi olarak işaretlendi');
      } else if (m.tip === 'telefon') {
        const tel = String(m.telefon || '').trim();
        if (tel.replace(/\D/g, '').length < 10) { onToast?.('Geçerli numara girin — örn. 0532 123 45 67'); setFiMesgul(false); return; }
        await api(`/fatura-istek/${m.istek.id}/telefon`, { method: 'POST', body: { telefon: tel } });
        onToast?.('✓ Numara kaydedildi — aynı tedarikçinin diğer açık işlerine de işlendi');
      } else if (m.tip === 'kapat') {
        const ac = String(m.aciklama || '').trim();
        if (!ac) { onToast?.('Açıklama zorunlu — kayıt sessizce kapanamaz'); setFiMesgul(false); return; }
        await api(`/fatura-istek/${m.istek.id}/kapat`, { method: 'POST', body: {
          aciklama: ac, kalici_istisna: !!m.kalici_istisna,
        } });
        onToast?.(m.kalici_istisna
          ? '✓ Kapatıldı ve kalıp öğrenildi — bu tedarikçi bir daha istenmeyecek'
          : '✓ İstek kapatıldı');
      } else if (m.tip === 'tara') {
        const r = await api('/fatura-istek/tara', { method: 'POST' });
        onToast?.(`✓ Tarama bitti${r?.yeni_aday != null ? ` — ${sayi(r.yeni_aday)} yeni aday` : ''}`);
      } else if (m.tip === 'istisna-sil') {
        await api('/fatura-istek/istisna-sil', { method: 'POST', body: { kalip: m.kalip } });
        onToast?.('✓ İstisna geri alındı — sonraki taramada yeniden istenebilir');
      } else if (m.tip === 'ocr') {
        const r = await api('/fatura/ocr-yeniden-dene?limit=50', { method: 'POST' });
        // 🐞 Toast olmayan `basarili` alanını okuyordu — sunucu `kuyruga_alinan`
        // + `son_hatalar` döner (OCR asenkron; kök neden hatalarda). Gerçek alanlar:
        const hata0 = Array.isArray(r?.son_hatalar) && r.son_hatalar[0]
          ? ` · son hata: ${String(r.son_hatalar[0]).slice(0, 60)}` : '';
        onToast?.(`✓ ${sayi(r?.kuyruga_alinan)} belge OCR kuyruğuna alındı — 1-2 dk sonra yenile${hata0}`);
      }
      setFiModal(null);
      istekYukle(); istisnaYukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setFiMesgul(false); }
  };

  useEffect(() => {
    if (['kapsama', 'arsiv', 'uyarilar', 'kdv', 'cari'].includes(gorunum) && !merkez) merkezYukle();
    if (gorunum === 'istek') istekYukle();
    if (gorunum === 'fiyat') bantYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  const toptancilar = useMemo(() => (Array.isArray(merkez?.toptancilar) ? merkez.toptancilar : []), [merkez]);

  // Cari görünümüne ilk girişte en büyük toptancıyı seç
  useEffect(() => {
    if (gorunum === 'cari' && !cariSecim && toptancilar.length) {
      const ilk = toptancilar[0].toptanci;
      setCariSecim(ilk);
      cariYukle(ilk);
    }
  }, [gorunum, cariSecim, toptancilar, cariYukle]);

  // ════════════════════════ GÖRÜNÜM: BELGE KAPSAMA ══════════════════════════
  // ── FAZ 7 MODALI ──────────────────────────────────────────────────────────
  const fiModalBlok = fiModal && (() => {
    const T = {
      'gonderildi': { baslik: 'Gönderildi olarak işaretle', tehlike: false, buton: 'İşaretle',
        anlat: 'Mesajı tedarikçiye ilettiğini kaydeder. Bu iz belge ritmi ölçümüne girer — kimin ne kadar sürede fatura gönderdiği buradan çıkar.' },
      'telefon': { baslik: 'Tedarikçi numarası', tehlike: false, buton: 'Numarayı kaydet',
        anlat: 'Numara sadece bu isteğe değil, AYNI tedarikçinin tüm açık isteklerine ve numarası boşsa tedarikçi kartına da işlenir. Bir kez girersin.' },
      'kapat': { baslik: 'İsteği kapat', tehlike: false, buton: 'Kapat',
        anlat: 'Açıklama zorunlu — kayıt sessizce kapanamaz. Açıklamanın ilk kelimeleri kapanış nedeni olarak saklanır.' },
      'tara': { baslik: 'Fatura isteği taraması çalıştır', tehlike: false, buton: 'Taramayı başlat',
        anlat: 'Gece motorunun aynısını şimdi çalıştırır: belgesiz ödemeleri tarayıp yeni fatura isteği adayları üretir. Mevcut istekleri bozmaz.' },
      'istisna-sil': { baslik: 'İstisnayı geri al', tehlike: false, buton: 'Geri al',
        anlat: 'Bu kalıp silinir; sonraki taramada bu tedarikçi için yeniden fatura istenebilir. Yanlış öğrenmeyi düzeltmek içindir.' },
      'ocr': { baslik: 'OCR\'ı yeniden dene', tehlike: false, buton: 'Yeniden dene',
        anlat: 'Yüklenmiş ama okunamamış belgeler tekrar OCR\'a sokulur (en fazla 50). Personelin yüklediği fotoların sessizce düşmesine karşı emniyet — mevcut okunmuş belgelere dokunmaz.' },
    }[fiModal.tip] || {};
    const kapat = () => { if (!fiMesgul) setFiModal(null); };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>{T.baslik}</div>
            <button onClick={kapat} style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit' }}>x</button>
          </div>
          {fiModal.istek && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
              <b>{fiModal.istek.tedarikci_ad || 'Tedarikçi'}</b> · {tarihKisa(fiModal.istek.tarih)}
              {fiModal.istek.tutar != null ? ` · ${fmt(sayi(fiModal.istek.tutar))} ₺` : ''}
            </div>
          )}
          {fiModal.kalip && <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}><b>{fiModal.kalip}</b></div>}
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>{T.anlat}</div>

          {fiModal.tip === 'telefon' && (
            <>
              <label style={bmEtiket}>Telefon</label>
              <input value={fiModal.telefon || ''} autoFocus inputMode="tel" placeholder="0532 123 45 67"
                onChange={(e) => setFiModal((p) => ({ ...p, telefon: e.target.value }))} style={bmAlanStil} />
            </>
          )}
          {fiModal.tip === 'kapat' && (
            <>
              <label style={bmEtiket}>Kapanış açıklaması (zorunlu)</label>
              <input value={fiModal.aciklama || ''} autoFocus placeholder="ör. faturası kâğıt geldi"
                onChange={(e) => setFiModal((p) => ({ ...p, aciklama: e.target.value }))} style={bmAlanStil} />
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12,
                color: R.metin2, cursor: 'pointer', lineHeight: 1.6, marginTop: 12,
              }}>
                <input type="checkbox" checked={!!fiModal.kalici_istisna} style={{ marginTop: 3 }}
                  onChange={(e) => setFiModal((p) => ({ ...p, kalici_istisna: e.target.checked }))} />
                <span>
                  🚫 <b>Bu tedarikçiden belge beklenmez</b> — kalıp öğrenilir, bir daha
                  aday üretilmez. Sadece gerçekten faturası olmayan yerler için işaretle
                  (ör. pazar esnafı); yanlışlıkla işaretlersen aşağıdaki istisna
                  listesinden geri alabilirsin.
                </span>
              </label>
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={fiMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={fiMesgul} onClick={fiUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              fontFamily: 'inherit', border: 'none',
              background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            }}>{fiMesgul ? 'İşleniyor…' : T.buton}</button>
          </div>
        </div>
      </div>
    );
  })();

  if (gorunum === 'kapsama') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    // 🔵 P1 (2026-08-12, Belge denetimi) FAKE-GREEN: okuma 200 dönse de payload BOŞ
    // gelirse (setMerkez({})) `kapsama||{}`→%0→"Faturasız yok, kapsama tam" render edilip
    // EKSİK FATURALARI GİZLİYORDU (uyum riski). kapsama==null (eksik) ≠ present (gerçek 0).
    if (merkez.kapsama == null) {
      return <HataBandi mesaj="Belge kapsama verisi gelmedi — 'kapsama tam / eksik yok' yanıltıcı olabilir, yenileyin." onTekrar={merkezYukle} />;
    }
    const k = merkez.kapsama || {};
    const oran = sayi(k.oran_yuzde);
    // Sunucu harcamayı DÖRDE ayırır (fatura_api.belge_merkezi_ozet):
    //   faturali_eslesen · kurumsal_otomatik · belge_beklenmez · faturasiz
    // v2 ilk ikisini birleştirip son ikisini tek kırmızıya eziyordu; üstelik
    // yeşil çubuk `oran_yuzde` (= yalnız eslesen/toplam) ile çiziliyordu —
    // yani efsane "Faturalı = eşleşen + kurumsal" derken çubuk kurumsalı
    // KIRMIZI tarafta gösteriyordu. Dört dilim ayrı ayrı çizilir.
    const eslesen = sayi(k.faturali_eslesen);
    const kurumsal = sayi(k.kurumsal_otomatik);
    const beklenmez = sayi(k.belge_beklenmez);
    const faturasiz = sayi(k.faturasiz);
    const toplamHarcama = sayi(k.isletme_kart_harcamasi);
    const faturali = eslesen + kurumsal;
    const yuzde = (v) => (toplamHarcama > 0 ? (v / toplamHarcama) * 100 : 0);
    const fh = Array.isArray(merkez.faturasiz_harcamalar) ? merkez.faturasiz_harcamalar : [];
    const kh = Array.isArray(merkez.kurumsal_harcamalar) ? merkez.kurumsal_harcamalar : [];
    const bh = Array.isArray(merkez.belgesiz_harcamalar) ? merkez.belgesiz_harcamalar : [];
    // Üç liste aynı ekranda ama karışmaz: hangisine bakıldığı seçilir.
    const listeler = [
      ['faturasiz', `🔴 Faturasız (${fh.length})`, fh, 'Belge isteme adayı — faturası bulunamadı.'],
      ['kurumsal', `🔵 Kurumsal otomatik (${kh.length})`, kh, 'E-fatura kendiliğinden geliyor; ayrıca belge istenmez.'],
      ['beklenmez', `⚪ Belge beklenmez (${bh.length})`, bh, 'Banka masrafı, vergi, harç gibi kalemler — faturası olmaz.'],
    ].filter(([, , liste]) => liste.length);
    const aktifListe = listeler.find(([id]) => id === kapsamaListe) || listeler[0];
    return (
      <>
        <KpiSeridi kpiler={[
          // ⚠️ TABAN DÜZELTMESİ (2026-08-07 denetimi): kapsama oranı TÜM harcamayı
          // payda alıyordu. Belgesi zaten beklenmeyen kalemler (kurumsal otomatik
          // talimat + belge_beklenmez) de paydadaydı → canlı vaka: Ağustos'ta
          // 3.903 ₺'nin TAMAMI otomatik internet faturası, faturasız riskli kalem
          // 0 ₺ iken ekran "%0 kapsama" KIRMIZISI basıyordu. Panik yaratan yalan.
          // Artık sunucunun riskli tabanı (belge_bekleyen_taban) esas; taban 0 ise
          // oran YOK — "belge bekleyen harcama yok" denir, %0 denmez.
          (sayi(k.belge_bekleyen_taban) > 0 || k.belge_bekleyen_taban == null
            ? {
              etiket: 'Belge kapsama',
              deger: `%${Math.round(sayi(k.oran_riskli_yuzde ?? oran))}`,
              alt: 'belge beklenen harcamanın faturalısı',
              renk: sayi(k.oran_riskli_yuzde ?? oran) >= 70 ? R.yesil : sayi(k.oran_riskli_yuzde ?? oran) >= 50 ? R.amber : R.kirmizi,
            }
            : {
              etiket: 'Belge kapsama',
              deger: 'temiz',
              alt: 'belge bekleyen harcama yok',
              renk: R.yesil,
            }),
          { etiket: 'Faturalı', deger: fmt(faturali), alt: 'eşleşen + kurumsal otomatik', renk: R.yesil },
          { etiket: 'Faturasız', deger: fmt(faturasiz), alt: 'belge isteme adayı', renk: faturasiz > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Kart harcaması', deger: fmt(sayi(k.isletme_kart_harcamasi)), alt: `${merkez.ay || buAyISO()} · işletme` },
        ]} />

        {/* Yerli belge yükleme (köprü kaldırma turu): faturasız harcamaya ek */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <label style={{
            padding: '9px 17px', borderRadius: 10, cursor: yukMesgul ? 'default' : 'pointer',
            background: yukMesgul ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
            color: yukMesgul ? R.not : '#1C1309', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            <input type="file" accept="application/pdf,image/*" style={{ display: 'none' }} disabled={yukMesgul}
              onChange={(e) => { belgeYukle(e.target.files?.[0]); e.target.value = ''; }} />
            {yukMesgul ? '⏳ Yükleniyor…' : '📎 Belge yükle (PDF / foto)'}
          </label>
          <span style={{ fontSize: 11.5, color: R.not }}>
            PDF: kalemler otomatik ayrıştırılır · foto: OCR ile okunur — arşive girer, kapsama oranı güncellenir
          </span>
        </div>

        {/* Kapsama barı — blueprint'in yeşil/kırmızı oran şeridi */}
        <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>
              Belge kapsama — {merkez.ay || buAyISO()} kart harcamaları
            </span>
            <span style={{ fontSize: 11.5, color: R.not2 }}>faturasız kısım = KDV indirimi + gider kanıtı kaybı riski</span>
          </div>
          {/* DÖRT DİLİM: eşleşen · kurumsal otomatik · belge beklenmez · faturasız.
              Sadece gerçekten faturasız kısım kırmızıdır; "belge beklenmez"i
              kırmızı göstermek olmayan bir borcu suç gibi gösterirdi. */}
          <div style={{ display: 'flex', height: 16, borderRadius: 99, overflow: 'hidden', background: R.cizgi2 }}>
            {eslesen > 0 && <span title={`Faturası eşleşen ${fmt(eslesen)}`} style={{ width: `${yuzde(eslesen)}%`, background: `linear-gradient(90deg, ${R.yesil}, #22C55E)` }} />}
            {kurumsal > 0 && <span title={`Kurumsal otomatik ${fmt(kurumsal)}`} style={{ width: `${yuzde(kurumsal)}%`, background: `linear-gradient(90deg, ${R.mavi}, #3B82F6)` }} />}
            {beklenmez > 0 && <span title={`Belge beklenmez ${fmt(beklenmez)}`} style={{ width: `${yuzde(beklenmez)}%`, background: R.cizgi3 }} />}
            {faturasiz > 0 && <span title={`Faturasız ${fmt(faturasiz)}`} style={{ flex: 1, background: `linear-gradient(90deg, ${R.kirmizi}, #EF4444)` }} />}
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5 }}>
            <span style={{ color: R.yesil }}>Eşleşen <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(eslesen)}</b> · %{Math.round(oran)}</span>
            {kurumsal > 0 && <span style={{ color: R.mavi }}>Kurumsal otomatik <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(kurumsal)}</b></span>}
            {beklenmez > 0 && <span style={{ color: R.not2 }}>Belge beklenmez <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(beklenmez)}</b></span>}
            <span style={{ color: R.kirmizi }}>Faturasız <b style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>{fmt(faturasiz)}</b></span>
            <span style={{ color: R.not2, marginLeft: 'auto' }}>hedef %85</span>
          </div>
        </div>

        {/* Üç harcama listesi — sunucu üçünü ayrı döndürüyordu, v2 yalnız
            faturasız olanı gösteriyordu. Kurumsal ve belge-beklenmez kalemleri
            görünmeyince "neden faturası yok?" sorusu cevapsız kalıyordu. */}
        {listeler.length > 1 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {listeler.map(([id, ad]) => (
              <div key={id} onClick={() => setKapsamaListe(id)} style={{
                padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${aktifListe?.[0] === id ? R.bakir : R.cizgi3}`,
                color: aktifListe?.[0] === id ? R.bakir : R.metin2,
                background: aktifListe?.[0] === id ? 'rgba(217,154,78,.14)' : R.girinti,
              }}>{ad}</div>
            ))}
          </div>
        )}

        {!aktifListe ? (
          <BosDurum metin="Faturasız işletme harcaması yok — kapsama tam." />
        ) : (
          <>
            <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 9 }}>{aktifListe[3]}</div>
            <Liste
              satirlar={aktifListe[2].slice(0, 12).map((h, i) => ({
                id: `${aktifListe[0]}-${i}`,
                baslik: kisalt(h.aciklama || 'Kart harcaması', 70),
                alt: `${tarihKisa(h.tarih)} · ${kisalt(h.kart, 34)}${h.tip ? ` · ${h.tip}` : ''}`,
                tutar: fmt(sayi(h.tutar)),
                tier: aktifListe[0] !== 'faturasiz' ? 'bilgi' : sayi(h.tutar) >= 10000 ? 'kritik' : 'uyari',
                aksiyon: '',
              }))}
              onAc={() => onToast?.(aktifListe[0] === 'faturasiz'
                ? 'Bu harcamanın faturasını yukarıdaki 📎 Belge yükle ile arşive ekleyin.'
                : aktifListe[0] === 'kurumsal'
                  ? 'Kurumsal harcama: e-fatura kendiliğinden geliyor, ayrıca belge istenmez.'
                  : 'Bu kalemin faturası olmaz (banka masrafı, vergi, harç…) — kapsama oranını düşürmez.')}
            />
          </>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FATURA ARŞİVİ (FTS) ════════════════════
  if (gorunum === 'arsiv') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const arsiv = Array.isArray(merkez.fatura_arsivi) ? merkez.fatura_arsivi : [];
    const gosterilen = aramaSonuc != null ? aramaSonuc : arsiv;
    // GÜN GÜN kırılım — sahibin ilk isteğiydi ("toptancı toptancı, ay ay, GÜN GÜN
    // görebildiğim"), sunucu gönderiyordu, v2 hiç okumuyordu.
    const gunGun = Array.isArray(merkez.gun_gun) ? merkez.gun_gun : [];
    const enBuyukGun = gunGun.reduce((m, g) => Math.max(m, sayi(g.tutar)), 0);
    // Arşiv deposu (BM-0b): dosya sayısı + toplam boyut. Sunucu ≈500 MB üstünde
    // obje depoya taşıma uyarısını kendi metninde söylüyor.
    const depo = merkez.arsiv_depo || null;
    const depoMb = sayi(depo?.toplam_mb);
    const ara = async () => {
      const q = arama.trim();
      if (!q) { setAramaSonuc(null); return; }
      setAraniyor(true);
      try {
        const d = await api(`/fatura/ara?q=${encodeURIComponent(q)}`);
        const rows = Array.isArray(d) ? d : (d?.sonuclar || d?.satirlar || []);
        setAramaSonuc(rows);
      } catch { setAramaSonuc([]); }
      setAraniyor(false);
    };
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bu ay belge', deger: String(arsiv.length), alt: merkez.ay || buAyISO() },
          { etiket: 'Toptancı', deger: String(toptancilar.length), alt: 'arşivde temsil edilen' },
          { etiket: 'Arşiv toplamı', deger: fmt(toptancilar.reduce((t, x) => t + sayi(x.toplam), 0)), alt: 'toptancı faturaları' },
          {
            etiket: 'Arşiv deposu',
            deger: depo ? `${trSayi(depoMb, depoMb >= 100 ? 0 : 1)} MB` : '—',
            alt: depo ? `${sayi(depo.dosyali_adet)} dosyalı belge` : 'boyut bilgisi yok',
            renk: depoMb >= 500 ? R.amber : R.krem,
          },
        ]} />
        {/* FTS arama — blueprint'in arama kutusu, /fatura/ara gerçek ucu */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
          padding: '6px 6px 6px 16px', borderRadius: 14, background: R.girinti, border: `1px solid ${R.cizgi}`,
        }}>
          <input
            value={arama}
            onChange={(e) => setArama(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ara()}
            placeholder="Belge metninde ara — toptancı, kalem, tutar, belge no… (FTS)"
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: R.krem, fontSize: 13, fontFamily: 'inherit', padding: '9px 0',
            }}
          />
          {aramaSonuc != null && (
            <button onClick={() => { setArama(''); setAramaSonuc(null); }} style={{
              padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`,
              background: 'transparent', color: R.not, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer',
            }}>
              temizle
            </button>
          )}
          <button onClick={ara} disabled={araniyor} style={{
            padding: '8px 15px', borderRadius: 9, border: 'none',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', opacity: araniyor ? 0.6 : 1,
          }}>
            {araniyor ? '…' : 'Ara'}
          </button>
        </div>
        {/* ── GÜN GÜN (sahip isteği: "ay ay, gün gün görebildiğim") ──
            Arama açıkken gizlenir: arama ay dışına çıkabilir, gün şeridi o ayın
            fotoğrafıdır — ikisini yan yana göstermek yanlış okutur. */}
        {aramaSonuc == null && gunGun.length > 0 && (
          <div style={{ ...kartYuzey, padding: '16px 20px', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>
                Gün gün · {merkez.ay || buAyISO()}
              </span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                {gunGun.length} günde belge geldi · en yoğun {fmt(enBuyukGun)}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {gunGun.slice(0, 14).map((g, i) => {
                const t = sayi(g.tutar);
                const oranG = enBuyukGun > 0 ? (t / enBuyukGun) * 100 : 0;
                return (
                  <div key={g.gun || i} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <span style={{ fontFamily: F.mono, fontSize: 11.5, color: R.not, width: 52, flexShrink: 0 }}>
                      {tarihKisa(g.gun)}
                    </span>
                    <span style={{ flex: 1, height: 8, borderRadius: 99, background: R.cizgi2, overflow: 'hidden' }}>
                      <span style={{
                        display: 'block', height: '100%', borderRadius: 99,
                        width: `${Math.max(2, oranG)}%`,
                        background: `linear-gradient(90deg, ${R.bakirKoyu}, ${R.bakir})`,
                      }} />
                    </span>
                    <span style={{ fontSize: 11, color: R.not2, width: 62, flexShrink: 0, textAlign: 'right' }}>
                      {sayi(g.adet)} belge
                    </span>
                    <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, width: 96, flexShrink: 0, textAlign: 'right' }}>
                      {fmt(t)}
                    </span>
                  </div>
                );
              })}
            </div>
            {gunGun.length > 14 && (
              <div style={{ fontSize: 11, color: R.not2, marginTop: 9 }}>
                En yeni 14 gün gösteriliyor · ayın tamamı {gunGun.length} gün.
              </div>
            )}
          </div>
        )}

        {/* Depo eşiği — sunucu ≈500 MB üstünde obje depoya taşımayı öneriyor (BM-0b) */}
        {depoMb >= 500 && (
          <div style={{
            ...kartYuzey, padding: '11px 16px', marginBottom: 14, borderColor: `${R.amber}44`,
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={rozetHap(R.amber)}>⚠ arşiv büyüdü</span>
            <span style={{ fontSize: 11.5, color: R.not }}>
              {depo?.not || 'Obje depoya taşıma gündeme alınmalı.'}
            </span>
          </div>
        )}

        {gosterilen.length === 0 ? (
          <BosDurum metin={aramaSonuc != null ? 'Arama sonucu yok.' : 'Bu ay arşivlenmiş fatura yok.'} />
        ) : (
          <Tablo
            baslik={aramaSonuc != null ? `Arama sonucu · ${gosterilen.length} belge` : `Fatura arşivi · ${merkez.ay || buAyISO()}`}
            not="satıra tıkla → belge görüntüle"
            kolonlar={[
              { ad: 'Tarih' }, { ad: 'Toptancı' }, { ad: 'Durum' }, { ad: 'Tutar', sag: 1 },
            ]}
            satirlar={gosterilen.slice(0, 40).map((b, i) => ({
              id: b.id || `b-${i}`,
              _b: b,
              hucreler: [
                { v: tarihKisa(b.tarih), mono: true, renk: R.not },
                { v: kisalt(b.tedarikci_ad || b.toptanci || '—', 42), kalin: true },
                /tamam/i.test(String(b.durum || ''))
                  ? { v: 'işlendi', rozet: R.yesil }
                  : /hata/i.test(String(b.durum || ''))
                    ? { v: b.durum, rozet: R.kirmizi }
                    : { v: b.durum || '—', rozet: R.amber },
                { v: fmt(sayi(b.tutar)), mono: true, sag: true, kalin: true },
              ],
            }))}
            onSatir={({ _b }) => onCekmece?.(faturaCekmecesi(_b))}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FATURA İSTEK ═══════════════════════════
  if (gorunum === 'istek') {
    if (istekHata) return <HataBandi mesaj={istekHata} onTekrar={istekYukle} />;
    if (!istek) return <Yukleniyor />;
    const gruplar = Array.isArray(istek.gruplar) ? istek.gruplar : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen istek', deger: String(sayi(istek.acik_adet)), alt: 'teslim alındı, belge yok', renk: sayi(istek.acik_adet) > 0 ? R.amber : R.yesil },
          { etiket: 'Toplam açık', deger: fmt(sayi(istek.acik_toplam)), alt: 'KDV kanıtı bekliyor', renk: sayi(istek.acik_toplam) > 0 ? R.kirmizi : R.krem },
          { etiket: 'KDV riski', deger: fmt(sayi(istek.kdv_riski)), alt: 'belgesiz kısımda tahmini' },
          { etiket: 'Oto-kapanış', deger: 'açık', alt: 'fatura gelince istek kapanır', renk: R.yesil },
        ]} />

        {fiModalBlok}

        {/* Faz 7: motor tetikleri — listeyi izlemek yetmiyor, besleyebilmek gerek */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <button onClick={() => setFiModal({ tip: 'tara' })} style={fiBtn}>🔍 Şimdi tara</button>
          <button onClick={() => setFiModal({ tip: 'ocr' })} style={fiBtn}>🔁 Okunamayan belgeleri yeniden dene</button>
        </div>

        {/* Öğrenilmiş istisnalar — "bir daha isteme" dediklerimiz burada, geri alınabilir */}
        {!!(istisnalar || []).length && (
          <div style={{ ...kartYuzey, padding: '14px 18px', marginBottom: 14 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
              Belge beklenmeyenler · {sayi(istisnalar.length)}
            </div>
            <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.7, marginBottom: 10 }}>
              Bu kalıplar için fatura isteği <b>üretilmiyor</b>. Yanlış öğrenildiyse geri al —
              sonraki taramada yeniden aday olur.
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              {istisnalar.slice(0, 40).map((k, i) => {
                const kalip = typeof k === 'string' ? k : (k.kalip || k.ad || '');
                return (
                  <span key={i} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px',
                    borderRadius: 999, background: R.girinti, fontSize: 11.5, color: R.metin2,
                  }}>
                    🚫 {kalip}
                    <button onClick={() => setFiModal({ tip: 'istisna-sil', kalip })} style={{
                      border: 'none', background: 'transparent', color: R.not, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: 13, padding: 0, lineHeight: 1,
                    }} title="İstisnayı geri al">x</button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {gruplar.length === 0 ? (
          <BosDurum metin="Açık fatura isteği yok — teslim alınan her şeyin belgesi gelmiş." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
            {gruplar.slice(0, 10).map((g, i) => (
              <div key={i} style={{ ...kartYuzey, padding: '15px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 170 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700 }}>{g.tedarikci || '—'}</div>
                    <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                      {sayi(g.adet)} istek · {g.tel ? 'telefon kayıtlı — wa.me tek dokunuş (cepten)' : 'telefon kayıtsız'}
                    </div>
                  </div>
                  <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: R.kirmizi }}>
                    {fmt(sayi(g.toplam))}
                  </span>
                  {g.kurumsal && <span style={rozetHap(R.mavi)}>kurumsal</span>}
                </div>
                {(Array.isArray(g.istekler) ? g.istekler : []).slice(0, 3).map((x, j) => (
                  <div key={j} style={{
                    display: 'flex', gap: 10, fontSize: 12, color: R.metin2, alignItems: 'center',
                    marginTop: 8, paddingTop: 8, borderTop: `1px solid ${R.cizgi2}`, flexWrap: 'wrap',
                  }}>
                    <span style={{ fontFamily: F.mono, color: R.not2 }}>{tarihKisa(x.tarih)}</span>
                    <span style={{ flex: 1, minWidth: 120 }}>{kisalt(x.aciklama || x.kaynak_tip, 64)}</span>
                    <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(x.tutar))}</span>
                    {x.id && (
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {x.durum !== 'istek_gonderildi' && (
                          <button onClick={() => setFiModal({ tip: 'gonderildi', istek: { ...x, tedarikci_ad: g.tedarikci_ad || g.ad } })}
                            style={fiMini}>Gönderildi</button>
                        )}
                        <button onClick={() => setFiModal({ tip: 'telefon', istek: { ...x, tedarikci_ad: g.tedarikci_ad || g.ad }, telefon: x.tedarikci_tel || '' })}
                          style={fiMini}>Numara</button>
                        <button onClick={() => setFiModal({ tip: 'kapat', istek: { ...x, tedarikci_ad: g.tedarikci_ad || g.ad }, aciklama: '', kalici_istisna: false })}
                          style={fiMini}>Kapat</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {/* ── AÇIK TESLİMAT / BELGE TALEBİ (yerli — klasik akış kadifede) ── */}
        {(() => {
          const talepler = Array.isArray(talep?.talepler) ? talep.talepler : (Array.isArray(talep) ? talep : []);
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 16 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                paddingBottom: 11, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12,
              }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                  📦 Açık teslimat · belge takibi
                </span>
                <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
                  teslim alındı, faturası bekliyor — WhatsApp'la iste, gelince kapat
                </span>
                <button onClick={() => setTalepForm({ ad: '', tarih: '', not: '' })} style={{
                  padding: '7px 14px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                }}>
                  + Elle talep aç
                </button>
              </div>
              {talepler.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, textAlign: 'center', padding: '14px 0' }}>
                  Bekleyen belge talebi yok — teslim alınan her şeyin belgesi gelmiş. ✓
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {talepler.slice(0, 12).map((t) => (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '10px 14px', borderRadius: 12, background: R.girinti,
                      border: `1px solid ${R.cizgi3}`,
                    }}>
                      <div style={{ flex: 1, minWidth: 160 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{t.tedarikci_ad || '—'}</div>
                        <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                          {t.teslim_tarihi ? `${tarihKisa(t.teslim_tarihi)} teslim` : 'tarih yok'}
                          {sayi(t.gelen_fatura_adet) > 0 ? ` · ${sayi(t.gelen_fatura_adet)} fatura geldi` : ''}
                          {t.mesaj_gonderildi_ts ? ' · mesaj gönderildi' : ''}
                          {t.tedarikci_tel ? '' : ' · 📵 telefon yok'}
                        </div>
                      </div>
                      <button onClick={() => talepIste(t)} style={{
                        padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
                        border: `1px solid ${R.yesil}55`, background: `${R.yesil}18`,
                        color: R.yesil, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                      }}>
                        💬 Fatura iste
                      </button>
                      <button onClick={() => setKapatForm({ t, tip: sayi(t.gelen_fatura_adet) > 0 ? 'fatura' : 'irsaliye', aciklama: '' })} style={{
                        padding: '6px 12px', borderRadius: 9, cursor: 'pointer',
                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                        color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>
                        ✓ Kapat
                      </button>
                    </div>
                  ))}
                  {talepler.length > 12 && (
                    <div style={{ fontSize: 11, color: R.not2, textAlign: 'center' }}>
                      +{talepler.length - 12} talep daha
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* elle talep formu */}
        {talepForm && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !talepMesgul) setTalepForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 470, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Elle Belge Talebi</div>
                <button onClick={() => setTalepForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={bmEtiket}>Tedarikçi adı *</label>
                  <input value={talepForm.ad} onChange={(e) => setTalepForm((f) => ({ ...f, ad: e.target.value }))} style={bmAlanStil} />
                </div>
                <div>
                  <label style={bmEtiket}>Teslim tarihi</label>
                  <input type="date" value={talepForm.tarih} onChange={(e) => setTalepForm((f) => ({ ...f, tarih: e.target.value }))}
                    style={{ ...bmAlanStil, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={bmEtiket}>Not</label>
                  <input value={talepForm.not} onChange={(e) => setTalepForm((f) => ({ ...f, not: e.target.value }))} style={bmAlanStil} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={talepMesgul} onClick={() => setTalepForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>İptal</button>
                <button disabled={talepMesgul} onClick={talepEkle} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{talepMesgul ? 'Ekleniyor…' : 'Talebi aç'}</button>
              </div>
            </div>
          </div>
        )}

        {/* kapanış kanıtı modalı (klasikte prompt idi) */}
        {kapatForm && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !talepMesgul) setKapatForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Talebi Kapat</div>
                <button onClick={() => setKapatForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                {kapatForm.t.tedarikci_ad} — kapanış kanıtı nedir?
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {[
                  ['fatura', '📄 Fatura geldi', 'PDF/foto arşivde — KDV kanıtı tamam'],
                  ['irsaliye', '📋 İrsaliye alındı', 'fatura sonra gelecek, teslim kanıtı var'],
                  ['manuel', '✍️ Diğer (açıklama yaz)', 'iade, iptal, hatalı kayıt vb.'],
                ].map(([tip, ad, aciklama]) => (
                  <div key={tip} onClick={() => setKapatForm((f) => ({ ...f, tip }))} style={{
                    padding: '11px 14px', borderRadius: 12, cursor: 'pointer',
                    border: `1px solid ${kapatForm.tip === tip ? R.bakir : R.cizgi3}`,
                    background: kapatForm.tip === tip ? 'rgba(217,154,78,.14)' : R.girinti,
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: kapatForm.tip === tip ? R.bakir : R.krem }}>{ad}</div>
                    <div style={{ fontSize: 11, color: R.not, marginTop: 3 }}>{aciklama}</div>
                  </div>
                ))}
              </div>
              {kapatForm.tip === 'manuel' && (
                <div style={{ marginTop: 12 }}>
                  <label style={bmEtiket}>Açıklama *</label>
                  <input value={kapatForm.aciklama} onChange={(e) => setKapatForm((f) => ({ ...f, aciklama: e.target.value }))} style={bmAlanStil} />
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={talepMesgul} onClick={() => setKapatForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Vazgeç</button>
                <button disabled={talepMesgul} onClick={talepKapat} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{talepMesgul ? 'Kapatılıyor…' : 'Kapat'}</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: MÜKERRER & PARMAK İZİ ══════════════════
  if (gorunum === 'uyarilar') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const kk = merkez.kdv_kanit || {};
    const supheli = kk.supheli || {};
    const inceleme = kk.inceleme || {};
    // 🐞 `islenemeyen_foto` sunucuda NESNE: {adet, son_hata, fotolar}
    // (fatura_api.belge_merkezi_ozet). Eski kod `Array.isArray` ile bakıyordu →
    // her zaman false → KPI KALICI OLARAK 0 gösteriyordu ve boş-durum kontrolü
    // kuyruğu "temiz" sayıyordu. Gerçek işlenemeyen fotoğraflar görünmüyordu.
    const ifoto = merkez.islenemeyen_foto || {};
    const islenemeyen = Array.isArray(ifoto.fotolar) ? ifoto.fotolar
      : (Array.isArray(ifoto) ? ifoto : []);          // eski dizi biçimine tolerans
    const islenemeyenAdet = ifoto.adet != null ? sayi(ifoto.adet) : islenemeyen.length;
    // son_hata = kök neden (ör. LLM kota doldu). Ekran şimdiye kadar
    // "fotoğraf okunamadı" diye TAHMİN yürütüyordu; sunucu sebebi söylüyor.
    const sonHata = (ifoto.son_hata || '').trim();
    const arsiv = Array.isArray(merkez.fatura_arsivi) ? merkez.fatura_arsivi : [];
    const hatali = arsiv.filter((b) => /hata/i.test(String(b.durum || '')));
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Şüpheli belge', deger: String(sayi(supheli.adet)), alt: 'GİB damgası / mükerrer şüphesi', renk: sayi(supheli.adet) > 0 ? R.kirmizi : R.yesil },
          { etiket: 'İnceleme kuyruğu', deger: String(sayi(inceleme.adet)), alt: `no/VKN eksik · ${fmt(sayi(inceleme.toplam))}`, renk: sayi(inceleme.adet) > 0 ? R.amber : R.yesil },
          { etiket: 'İşlenemeyen foto', deger: String(islenemeyenAdet), alt: sonHata ? kisalt(sonHata, 40) : 'OCR okuyamadı', renk: islenemeyenAdet > 0 ? R.amber : R.krem },
          { etiket: 'Mükerrer freni', deger: '4 katman', alt: 'aynı belge iki kanaldan giremez', renk: R.yesil },
        ]} />
        <div style={{
          ...kartYuzey, padding: '12px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <span style={rozetHap(R.mavi)}>ℹ fren</span>
          Parmak izi (PDF hash) + belge no + tutar+gün + GİB damgası — dört katman girişte otomatik çalışır;
          bu ekran KALANLARI (inceleme + şüpheli) gösterir.
        </div>
        {/* 🔵 P1 (2026-08-12, Belge denetimi) FAKE-GREEN: boş-durum `supheli.adet`i (GİB
            damgası/mükerrer şüphesi KPI'ı) göz ardı ediyordu → şüpheli belge varken
            "kuyruk temiz" diyordu. Şüpheli>0 ise 'temiz' gösterme. */}
        {hatali.length === 0 && islenemeyenAdet === 0 && sayi(inceleme.adet) === 0 && sayi(supheli.adet) === 0 ? (
          <BosDurum metin="Uyarı kuyruğu temiz — mükerrer şüphesi veya işlenemeyen belge yok." />
        ) : (
          <>
            {/* İŞLENEMEYEN FOTOĞRAFLAR — kök nedeniyle birlikte. Sebep sunucudan
                gelir; "daha net çek" tavsiyesi her hatada doğru değil (kota
                dolduysa fotoğrafın netliğiyle ilgisi yok). */}
            {islenemeyenAdet > 0 && (
              <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, border: `1px solid ${R.amber}44` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>
                  İşlenemeyen fotoğraf · {islenemeyenAdet} belge
                </div>
                <div style={{ fontSize: 12, color: R.metin2, lineHeight: 1.55 }}>
                  {sonHata
                    ? <>Son hata: <b style={{ color: R.amber }}>{sonHata}</b> — kök neden buysa yeniden yüklemek çözmez, önce bu giderilmeli.</>
                    : 'OCR okuyamadı. Daha net bir kopya yükleyin.'}
                </div>
                {islenemeyen.length > 0 && (
                  <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {islenemeyen.slice(0, 6).map((f, i) => (
                      <div key={f.id || `if-${i}`} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                      }}>
                        <span style={{ fontFamily: F.mono, color: R.not, flexShrink: 0 }}>{tarihKisa(f.tarih)}</span>
                        <span style={{ flex: 1, minWidth: 0, color: R.metin2 }}>
                          {kisalt(f.tedarikci_ad || f.dosya_adi || f.aciklama || 'Fotoğraf', 52)}
                        </span>
                        {f.hata && <span style={{ color: R.not2, flexShrink: 0 }}>{kisalt(f.hata, 34)}</span>}
                      </div>
                    ))}
                    {islenemeyen.length > 6 && (
                      <div style={{ fontSize: 11, color: R.not2 }}>+{islenemeyen.length - 6} kayıt daha</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {hatali.length > 0 && (
              <Liste
                satirlar={hatali.slice(0, 8).map((b, i) => ({
                  id: b.id || `h-${i}`,
                  baslik: `${kisalt(b.tedarikci_ad, 44)} · işlenemedi`,
                  alt: `${tarihKisa(b.tarih)} · durum: ${b.durum}`,
                  tutar: fmt(sayi(b.tutar)),
                  tier: 'kritik',
                  aksiyon: '',
                }))}
                onAc={() => onToast?.(sonHata
                  ? `İşlenemeyen belge — son hata: ${sonHata}`
                  : 'İşlenemeyen belge: fotoğraf okunamadı — 📎 Belge yükle ile daha net bir kopya yükleyin.')}
              />
            )}
            {sayi(inceleme.adet) > 0 && (
              <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, border: `1px solid ${R.amber}44` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>
                  İnceleme kuyruğu · {sayi(inceleme.adet)} belge · {fmt(sayi(inceleme.toplam))}
                </div>
                <div style={{ fontSize: 12, color: R.metin2, lineHeight: 1.55 }}>
                  Belge no veya VKN eksik — fatura onay ekranında tamamlanınca KDV kanıt paketine girer.
                </div>
              </div>
            )}
          </>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: CARİ EKSTRE ════════════════════════════
  if (gorunum === 'cari') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const faturalar = Array.isArray(cari?.faturalar) ? cari.faturalar : [];
    // ⚠️ v2 bu ucun cevabını TAM tutuyordu ama yalnız KPI + fatura listesi
    // çiziyordu. Klasik CariEkstrePanel.jsx'in başında yazan ilke:
    //   "tek kaynak, iki ekran; ekstre iki yerde iki farklı kalitede yaşamaz"
    // ve kanonik sıra: GÜNCEL DURUM → DEFTER → mutabakat → kaynak belgeler.
    // v2 DEFTER'i ve mutabakatı hiç kurmamıştı; eksik derinlik kapatıldı.
    const hareketler = Array.isArray(cari?.hareketler) ? cari.hareketler : [];
    const aylik = Array.isArray(cari?.aylik) ? cari.aylik : [];
    const vadeler = Array.isArray(cari?.bekleyen_vadeler) ? cari.bekleyen_vadeler : [];
    const adaylar = Array.isArray(cari?.odeme_adaylari) ? cari.odeme_adaylari : [];
    const bugunISO = bugunYerelISO();
    const gecikmisVade = vadeler.filter((v) => String(v.vade || '') < bugunISO);
    return (
      <>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {toptancilar.slice(0, 8).map((t) => {
            const aktif = cariSecim === t.toptanci;
            return (
              <div
                key={t.toptanci}
                onClick={() => { setCariSecim(t.toptanci); cariYukle(t.toptanci); }}
                style={{
                  padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  background: aktif ? `${R.bakir}22` : R.girinti,
                  color: aktif ? R.bakir : R.not,
                  border: `1px solid ${aktif ? `${R.bakir}55` : R.cizgi3}`,
                }}
              >
                {kisalt(t.toptanci, 24)}
              </div>
            );
          })}
        </div>
        {cariHata ? <HataBandi mesaj={cariHata} onTekrar={() => cariYukle(cariSecim)} /> : !cari ? <Yukleniyor /> : (
          <>
            <KpiSeridi kpiler={[
              { etiket: 'Hesaplanan açık', deger: fmt(sayi(cari.hesaplanan_acik)), alt: 'fatura − ödeme izi + devir', renk: sayi(cari.hesaplanan_acik) > 0 ? R.kirmizi : R.yesil },
              { etiket: 'Tedarikçi beyanı', deger: cari.beyan_bakiye != null ? fmt(sayi(cari.beyan_bakiye)) : '—', alt: cari.beyan_bakiye != null ? 'iki göz kıyası' : 'beyan girilmemiş' },
              { etiket: 'Açılış devri', deger: fmt(sayi(cari.devir)), alt: kisalt(cari.devir_not, 30) || 'sistem öncesi beyan' },
              { etiket: '6 ay hacim', deger: fmt(sayi(cari.fatura_toplam_6ay)), alt: `${sayi(cari.fatura_adet)} fatura · ödeme izi ${fmt(sayi(cari.odeme_izi_toplam_6ay))}` },
            ]} />
            {/* ── BEKLEYEN VADELER (varsa önce, çünkü aksiyon gerektirir) ── */}
            {vadeler.length > 0 && (
              <div style={{
                ...kartYuzey, padding: '13px 18px', marginBottom: 14,
                borderColor: gecikmisVade.length ? `${R.kirmizi}55` : `${R.amber}44`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: vadeler.length ? 10 : 0 }}>
                  <span style={rozetHap(gecikmisVade.length ? R.kirmizi : R.amber)}>
                    {gecikmisVade.length ? `⚠ ${gecikmisVade.length} vadesi geçmiş` : '⏳ bekleyen vade'}
                  </span>
                  <span style={{ fontSize: 12, color: R.not }}>
                    {vadeler.length} açık söz · toplam <b style={{ fontFamily: F.mono }}>{fmt(sayi(cari.bekleyen_vade_toplam))}</b>
                    {' — '}ödeme <b>Ödeme Merkezi</b>'nden yapılır, bu ekran salt-okur.
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {vadeler.slice(0, 6).map((v, i) => {
                    const gec = String(v.vade || '') < bugunISO;
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                      }}>
                        <span style={{ fontFamily: F.mono, color: gec ? R.kirmizi : R.not, flexShrink: 0, width: 54 }}>
                          {tarihKisa(v.vade)}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, color: R.metin2 }}>{kisalt(v.aciklama, 60)}</span>
                        {gec && <span style={{ fontSize: 10, fontWeight: 700, color: R.kirmizi, flexShrink: 0 }}>gecikti</span>}
                        <span style={{ fontFamily: F.mono, fontWeight: 700, flexShrink: 0 }}>{fmt(sayi(v.tutar))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── DEFTER — kanonik sıranın kalbi: borç / alacak / yürüyen bakiye.
                Ekstre DEVİRLE başlar (açılış fişi); ödeme alacak sütununa yazılır
                ve bakiyeyi düşürür. Sunucu bakiyeyi kendisi yürütüyor — burada
                YENİDEN HESAPLANMAZ. */}
            {hareketler.length > 0 && (
              <Tablo
                baslik={`Cari defter — ${kisalt(cariSecim, 40)}`}
                not={`yürüyen bakiye ${fmt(sayi(cari.yuruyen_bakiye))} · ${hareketler.length} hareket`}
                kolonlar={[
                  { ad: 'Tarih' }, { ad: 'Hareket' }, { ad: 'Açıklama' },
                  { ad: 'Borç', sag: 1 }, { ad: 'Alacak', sag: 1 }, { ad: 'Bakiye', sag: 1 },
                ]}
                satirlar={hareketler.slice(-40).reverse().map((h, i) => {
                  const tip = CARI_HAREKET[h.tip] || { ad: h.tip || '—', borc: true };
                  const t = sayi(h.tutar);
                  return {
                    id: `hr-${i}`,
                    hucreler: [
                      { v: tarihKisa(h.tarih), mono: true, renk: R.not },
                      {
                        v: tip.ad,
                        rozet: h.tip === 'odeme' ? R.yesil : h.tip === 'devir' ? R.mavi : R.bakir,
                      },
                      { v: kisalt(h.aciklama, 54) || '—', renk: R.metin2 },
                      { v: tip.borc ? fmt(t) : '—', mono: true, sag: true, renk: tip.borc ? R.krem : R.not3 },
                      { v: tip.borc ? '—' : fmt(t), mono: true, sag: true, renk: tip.borc ? R.not3 : R.yesil },
                      { v: fmt(sayi(h.bakiye)), mono: true, sag: true, kalin: true, renk: sayi(h.bakiye) > 0 ? R.kirmizi : R.yesil },
                    ],
                  };
                })}
              />
            )}

            {/* ── AY AY MUTABAKAT (ikincil — katlanır) ── */}
            {aylik.length > 0 && (
              <details style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: R.metin2 }}>
                  📅 Ay ay mutabakat · {aylik.length} ay
                  {adaylar.length ? ` · ${adaylar.length} ödeme adayı eşleşti` : ''}
                </summary>
                <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ fontSize: 10.5, color: R.not2, marginBottom: 3 }}>
                    Ödeme adayları METİN EŞLEŞMESİDİR — kesin mutabakat değil (öneri-only).
                  </div>
                  {[...aylik].sort((a, b) => String(b.ay).localeCompare(String(a.ay))).slice(0, 12).map((a, i) => {
                    const fark = sayi(a.fark);
                    return (
                      <div key={a.ay || i} style={{
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                        padding: '7px 11px', borderRadius: 9, background: R.girinti,
                      }}>
                        <span style={{ fontFamily: F.mono, color: R.metin2, flexShrink: 0, width: 58 }}>{a.ay}</span>
                        <span style={{ flex: 1, minWidth: 0, color: R.not2 }}>
                          {sayi(a.fatura_adet)} fatura {fmt(sayi(a.fatura_toplam))} · {sayi(a.odeme_adet)} ödeme {fmt(sayi(a.odeme_toplam))}
                        </span>
                        <span style={{
                          fontFamily: F.mono, fontWeight: 700, flexShrink: 0,
                          color: Math.abs(fark) < 0.5 ? R.yesil : fark > 0 ? R.kirmizi : R.mavi,
                        }}>
                          {fark > 0 ? '+' : ''}{fmt(fark)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}

            {faturalar.length === 0 ? (
              <BosDurum metin="Bu tedarikçi için arşivde fatura yok." />
            ) : (
              <Tablo
                baslik={`Kaynak belgeler — ${kisalt(cariSecim, 40)}`}
                not="satıra tıkla → belge görüntüle"
                kolonlar={[
                  { ad: 'Tarih' }, { ad: 'Belge no' }, { ad: 'Tutar', sag: 1 }, { ad: 'Bakiye (dahil)', sag: 1 },
                ]}
                satirlar={faturalar.slice(0, 30).map((f, i) => ({
                  id: f.id || `f-${i}`,
                  _f: f,
                  hucreler: [
                    { v: tarihKisa(f.tarih), mono: true, renk: R.not },
                    { v: f.fatura_no || '—', mono: true, renk: R.not },
                    { v: fmt(sayi(f.tutar)), mono: true, sag: true, kalin: true },
                    { v: f.bakiye_dahil != null ? fmt(sayi(f.bakiye_dahil)) : '—', mono: true, sag: true, renk: R.metin2 },
                  ],
                }))}
                onSatir={({ _f }) => onCekmece?.(faturaCekmecesi({ ...
                  _f, tedarikci_ad: _f.tedarikci_ad || cariSecim }))}
              />
            )}
          </>
        )}

        {cariSecim && (
          <div style={{ display: 'flex', gap: 9, marginTop: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <button onClick={() => setDevirForm({
              tedarikci: cariSecim,
              tutar: cari?.devir != null ? String(sayi(cari.devir)) : '',
              aciklama: cari?.devir_not || '',
            })} style={{
              padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: R.girinti, color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            }}>
              ⚖️ Açılış devri beyan et
            </button>
            <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
              sistem öncesi bakiye — hesaplanan açığa eklenir (+borç / −avans)
            </span>
          </div>
        )}

        {/* açılış devri modalı */}
        {devirForm && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !devirMesgul) setDevirForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>⚖️ Açılış Devri</div>
                <button onClick={() => setDevirForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14, lineHeight: 1.55 }}>
                <b>{devirForm.tedarikci}</b> — sistem kurulmadan önceki bakiye beyanı.
                Artı değer BORÇ (ona borçluyuz), eksi değer AVANS (fazla ödeme) anlamına gelir.
              </div>
              <label style={bmEtiket}>Devir tutarı (₺) *</label>
              <input type="number" value={devirForm.tutar}
                onChange={(e) => setDevirForm((f) => ({ ...f, tutar: e.target.value }))}
                style={{ ...bmAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
              <div style={{ marginTop: 12 }}>
                <label style={bmEtiket}>Açıklama / dayanak</label>
                <input value={devirForm.aciklama} placeholder="örn. Haziran ekstre mutabakatı"
                  onChange={(e) => setDevirForm((f) => ({ ...f, aciklama: e.target.value }))} style={bmAlanStil} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={devirMesgul} onClick={() => setDevirForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>İptal</button>
                <button disabled={devirMesgul} onClick={devirKaydet} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{devirMesgul ? 'Kaydediliyor…' : 'Devri kaydet'}</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: FİYAT BANDI ════════════════════════════
  if (gorunum === 'fiyat') {
    if (bantHata) return <HataBandi mesaj={bantHata} onTekrar={bantYukle} />;
    if (!bant) return <Yukleniyor />;
    const disi = Array.isArray(bant.band_disi) ? bant.band_disi : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen kalem', deger: String(sayi(bant.urun_adet)), alt: 'fatura fiyat geçmişi' },
          { etiket: 'Bant dışı', deger: String(sayi(bant.band_disi_adet)), alt: 'son alış aralık üstünde', renk: sayi(bant.band_disi_adet) > 0 ? R.kirmizi : R.yesil },
          { etiket: 'En sert sapma', deger: disi.length ? `${Math.round(Math.max(...disi.map((x) => (sayi(x.son_fiyat) / (sayi(x.medyan) || 1) - 1) * 100)))}%` : '—', alt: 'medyana göre', renk: R.kirmizi },
          { etiket: 'Kaynak', deger: 'onaylı fatura', alt: 'OCR değil — öneri-only' },
        ]} />
        {disi.length === 0 ? (
          <BosDurum metin="Bant dışı alış yok — son fiyatlar 90 günlük aralığın içinde." />
        ) : (
          <Tablo
            baslik="Fiyat bandı · son alış vs geçmiş aralık"
            not="zam yakalanınca burada belirir — 3 zam bu bantla yakalandı"
            kolonlar={[
              { ad: 'Kalem' }, { ad: 'Son tedarikçi' }, { ad: 'Bant', sag: 1 }, { ad: 'Son alış', sag: 1 }, { ad: 'Sapma', sag: 1 }, { ad: 'Durum' },
            ]}
            satirlar={disi.slice(0, 25).map((x, i) => {
              const sapma = sayi(x.medyan) > 0 ? Math.round((sayi(x.son_fiyat) / sayi(x.medyan) - 1) * 100) : null;
              return {
                id: x.kod || `x-${i}`,
                hucreler: [
                  { v: kisalt(x.ad, 40), kalin: true },
                  { v: kisalt(x.son_tedarikci || x.tedarikci || '—', 24), renk: R.not },
                  { v: Array.isArray(x.aralik) ? `${x.aralik[0]} – ${x.aralik[1]}` : '—', mono: true, sag: true, renk: R.not },
                  { v: String(sayi(x.son_fiyat)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                  { v: sapma != null ? `+%${sapma}` : '—', mono: true, sag: true, renk: R.kirmizi },
                  { v: 'bant dışı', rozet: R.kirmizi },
                ],
              };
            })}
          />
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: KDV KANIT PAKETİ ═══════════════════════
  if (gorunum === 'kdv') {
    if (merkezHata) return <HataBandi mesaj={merkezHata} onTekrar={merkezYukle} />;
    if (!merkez) return <Yukleniyor />;
    const kk = merkez.kdv_kanit || {};
    const uclu = [
      { ad: 'İndirime aday', v: kk.indirime_aday, renk: R.yesil, alt: 'fatura no + VKN/GİB damgası ✓ — pakete hazır' },
      { ad: 'İnceleme', v: kk.inceleme, renk: R.amber, alt: 'no/VKN eksik — tamamlanınca pakete girer' },
      { ad: 'Şüpheli', v: kk.supheli, renk: R.kirmizi, alt: 'mükerrer/GİB uyarılı — muhasebeye NOTLA gider' },
    ];
    return (
      <>
        <KpiSeridi kpiler={uclu.map((u) => ({
          etiket: u.ad, deger: `${sayi(u.v?.adet)} belge`, alt: fmt(sayi(u.v?.toplam)), renk: sayi(u.v?.adet) > 0 ? u.renk : R.krem,
        })).concat([{ etiket: 'Dönem', deger: kk.ay || merkez.ay || buAyISO(), alt: 'muhasebeye ay sonu' }])} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12, marginBottom: 14 }}>
          {uclu.map((u) => (
            <div key={u.ad} style={{ ...kartYuzey, padding: '17px 19px', border: sayi(u.v?.adet) > 0 ? `1px solid ${u.renk}44` : kartYuzey.border }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>{u.ad}</span>
                <span style={rozetHap(sayi(u.v?.adet) > 0 ? u.renk : R.yesil)}>{sayi(u.v?.adet)}</span>
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 19, fontWeight: 700, marginBottom: 7 }}>{fmt(sayi(u.v?.toplam))}</div>
              <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.5 }}>{u.alt}</div>
            </div>
          ))}
        </div>
        {/* Motorun kendi ilkesi — sahte sayı yasağının backend'deki kardeşi */}
        <div style={{
          ...kartYuzey, padding: '13px 18px', marginBottom: 14,
          fontSize: 12, color: R.not, lineHeight: 1.6,
        }}>
          <span style={rozetHap(R.mavi)}>ℹ ilke</span>{' '}
          KDV TUTARI HESAPLANMAZ — hüküm muhasebecinin. Bu ekran yalnız belge KANITININ
          sağlamlığını sınıflar; eksikler fatura onay ekranında no/VKN girilerek kapanır.
        </div>
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
