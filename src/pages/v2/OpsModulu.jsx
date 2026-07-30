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
import { KpiSeridi, Tablo } from './parcalar';

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
    api('/ops/bar-ozet?limit=60')
      .then((d) => setBarOzet(Array.isArray(d?.satirlar) ? d.satirlar : []))
      .catch(() => setBarOzet([]));
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

  useEffect(() => {
    if (gorunum === 'akis' || gorunum === 'kule') kuleYukle();
    if (gorunum === 'sevkiyat') sevkYukle();
    if (gorunum === 'depo') depoYukle();
    if (gorunum === 'sayim') sayimYukle();
    if (gorunum === 'hareket') hareketYukle();
    if (gorunum === 'bar') barYukle(barTarih);
    if (gorunum === 'denetim') denetimYukle(barTarih);
    if (gorunum === 'tedarik') tedarikYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum, kuleYukle, sevkYukle, depoYukle, sayimYukle, hareketYukle, barYukle, denetimYukle, tedarikYukle]);

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
      ...(s.asama === 'bekliyor'
        ? { aksiyonlar: [{ ad: '→ Yönlendir (depo / toptancı)', birincil: true, onTikla: () => yonAc(s) }] }
        : s.asama === 'depoda'
          ? { aksiyonAd: 'Sevkiyatı hazırla', _hedef: '__gorunum:sevkiyat' }
          : { aksiyonAd: 'Kontrol kulesinde izle', _hedef: '__gorunum:kule' }),
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
                    background: yonForm.mod === m ? 'rgba(217,154,78,.12)' : 'transparent',
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
                        background: (yonForm.tedarikciId && yonForm.secili.length) ? 'linear-gradient(150deg, #D99A4E, #B06E2C)' : R.girinti,
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
                    background: yonForm.depo ? 'linear-gradient(150deg, #D99A4E, #B06E2C)' : R.girinti,
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
    const kapananSube = kapanisSatir.filter((x) => x.kapanis_tamam).length;
    const farkliAcilis = acilisSatir.filter((x) => sayi(x.fark_tl) !== 0 && x.fark_tl != null);
    const teslimBekleyen = kapanisSatir.filter((x) => x.kapanis_tamam && !sayi(x.teslim_kasa_tl));
    const acAkis = Array.isArray(urunAcAkis?.kayitlar) ? urunAcAkis.kayitlar : [];
    const gunDegis = (n) => {
      const y = gunEkleISO(barTarih, n);
      if (y > bugunYerelISO()) return;   // geleceğe gitme
      setBarTarih(y);
      barYukle(y);
    };
    const ALT = [
      ['acilis', `\u{1F305} Açılış (${acilanSube}/${acilisSatir.length})`],
      ['kapanis', `\u{1F311} Kapanış (${kapananSube}/${kapanisSatir.length})`],
      ['urunac', `\u{1F7E2} Ürün-aç (${sayi(urunAcAkis?.toplam_islem)})`],
      ['kullanilan', '\u{1F7E0} Kullanılan ürünler'],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açılan şube', deger: `${acilanSube} / ${acilisSatir.length}`, alt: barTarih === bugunYerelISO() ? 'bugün' : barTarih, renk: acilanSube === acilisSatir.length && acilisSatir.length ? R.yesil : R.amber },
          { etiket: 'Kapanan şube', deger: `${kapananSube} / ${kapanisSatir.length}`, alt: kapananSube < kapanisSatir.length ? 'kapanış bekleniyor' : 'tamamlandı', renk: kapananSube === kapanisSatir.length && kapanisSatir.length ? R.yesil : R.amber },
          { etiket: 'Açılış farkı', deger: String(farkliAcilis.length), alt: farkliAcilis.length ? 'devir ile uyuşmayan' : 'devirle uyumlu', renk: farkliAcilis.length ? R.kirmizi : R.yesil },
          { etiket: 'Teslim bekleyen', deger: String(teslimBekleyen.length), alt: 'kapandı ama kasa teslim edilmedi', renk: teslimBekleyen.length ? R.amber : R.yesil },
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
              background: barSekme === id ? 'rgba(217,154,78,.12)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {barSekme === 'acilis' && (acilisSatir.length ? (
          <Tablo
            baslik={`Açılış kasası · ${tarihKisa(barTarih)}`}
            not="dünkü kapanış devri ile sabah sayımı karşılaştırılır"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Durum' }, { ad: 'Açılış saati' }, { ad: 'Personel' },
              { ad: 'Sayılan', sag: 1 }, { ad: 'Beklenen devir', sag: 1 }, { ad: 'Fark', sag: 1 },
            ]}
            satirlar={acilisSatir.map((x, i) => ({
              id: x.sube_id || `a-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                x.acilis_tamam
                  ? { v: 'açıldı', rozet: R.yesil }
                  : { v: x.acilis_durum || 'bekliyor', rozet: R.amber },
                { v: saatKisa(x.acilis_ts) || x.personel_saat || '—', mono: true, renk: R.not },
                { v: x.personel_ad || '—', renk: R.not },
                { v: x.acilis_kasa_tl != null ? fmt(sayi(x.acilis_kasa_tl)) : '—', mono: true, sag: true },
                { v: x.beklenen_devir_tl != null ? fmt(sayi(x.beklenen_devir_tl)) : '—', mono: true, sag: true, renk: R.not },
                x.fark_tl == null
                  ? { v: '—', sag: true, renk: R.not }
                  : { v: fmt(sayi(x.fark_tl)), mono: true, sag: true, kalin: true, renk: sayi(x.fark_tl) === 0 ? R.yesil : R.kirmizi },
              ],
            }))}
          />
        ) : <BosDurum metin="Bu gün için açılış kaydı yok." />)}

        {barSekme === 'kapanis' && (kapanisSatir.length ? (
          <Tablo
            baslik={`Kapanış takibi · ${tarihKisa(barTarih)}`}
            not={`kapanış son teslim saati: ${sayi(kapanisTakip?.kapanis_son_teslim_saat) || 2}:00`}
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Kapanış' }, { ad: 'Saat' }, { ad: 'Personel' },
              { ad: 'Kasa sayımı', sag: 1 }, { ad: 'Devir', sag: 1 }, { ad: 'Teslim', sag: 1 }, { ad: 'Ciro taslağı' },
            ]}
            satirlar={kapanisSatir.map((x, i) => ({
              id: x.sube_id || `k-${i}`,
              hucreler: [
                { v: x.sube_adi || '—', kalin: true },
                x.kapanis_tamam
                  ? { v: 'kapandı', rozet: R.yesil }
                  : { v: x.acildi ? 'açık' : 'açılmadı', rozet: x.acildi ? R.amber : R.not },
                { v: saatKisa(x.kapanis_ts) || '—', mono: true, renk: R.not },
                { v: x.kapanis_personel || '—', renk: R.not },
                { v: fmt(sayi(x.kasa_sayim)), mono: true, sag: true },
                { v: fmt(sayi(x.devir)), mono: true, sag: true, renk: R.not },
                { v: sayi(x.teslim_kasa_tl) ? fmt(sayi(x.teslim_kasa_tl)) : '—', mono: true, sag: true, renk: sayi(x.teslim_kasa_tl) ? R.yesil : R.amber },
                x.taslak_var
                  ? { v: x.taslak_durum || 'gönderildi', rozet: R.mavi }
                  : { v: '—', renk: R.not },
              ],
            }))}
          />
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
          const satir = (barOzet || []).filter((x) => !barTarih || String(x.tarih).slice(0, 10) === barTarih);
          const gosterilen = satir.length ? satir : (barOzet || []).slice(0, 8);
          if (!gosterilen.length) return <BosDurum metin="Bar özeti verisi yok." />;
          return (
            <>
              {!satir.length && (
                <div style={{ fontSize: 11.5, color: R.amber, marginBottom: 10 }}>
                  ⚠ {tarihKisa(barTarih)} için bar kaydı yok — son günler gösteriliyor.
                </div>
              )}
              <Tablo
                baslik="Kullanılan ürünler · açılış + ürün-aç − kapanış"
                not="devir-bilinçli hesap; kapanış tamamlanmadan gün geçici sayılır"
                kolonlar={[
                  { ad: 'Şube' }, { ad: 'Tarih' }, { ad: 'Kapanış' },
                  { ad: 'Bardak (K/B/P)', sag: 1 }, { ad: 'Süt (L)', sag: 1 }, { ad: 'Su', sag: 1 },
                ]}
                satirlar={gosterilen.slice(0, 40).map((x, i) => {
                  const st = x.satilan || {};
                  return {
                    id: `${x.sube_id}-${x.tarih}-${i}`,
                    hucreler: [
                      { v: x.sube_adi || '—', kalin: true },
                      { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                      x.kapanis_gercek
                        ? { v: 'kesin', rozet: R.yesil }
                        : { v: 'geçici', rozet: R.amber },
                      { v: `${sayi(st.bardak_kucuk)} / ${sayi(st.bardak_buyuk)} / ${sayi(st.bardak_plastik)}`, mono: true, sag: true },
                      { v: sayi(st.sut_litre) ? String(sayi(st.sut_litre)) : '—', mono: true, sag: true },
                      { v: sayi(st.su_adet) ? String(sayi(st.su_adet)) : '—', mono: true, sag: true },
                    ],
                  };
                })}
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
    const kayipListe = Array.isArray(dnKayip?.kalemler) ? dnKayip.kalemler
      : (Array.isArray(dnKayip?.satirlar) ? dnKayip.satirlar : []);
    const kontrolSatir = Array.isArray(dnKontrol?.subeler) ? dnKontrol.subeler
      : (Array.isArray(dnKontrol?.satirlar) ? dnKontrol.satirlar : []);
    const gunDegis = (n) => {
      const y = gunEkleISO(barTarih, n);
      if (y > bugunYerelISO()) return;
      setBarTarih(y);
      denetimYukle(y);
    };
    const ALT = [
      ['uyumsuz', `\u{1F9EA} Ürün uyumsuzluğu (${sayi(dnUyumsuz?.gun_bekleyen)})`],
      ['fire', `\u{1F525} Fire (${fireKayit.length})`],
      ['fis', `\u{1F9FE} Gider fişi (${fisListe.length})`],
      ['kontrol', '\u{1F50D} Kontrol özeti'],
      ['kayip', `\u{1F4C9} Stok kaybı (${kayipListe.length})`],
    ];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bekleyen uyumsuzluk', deger: String(sayi(dnUyumsuz?.gun_bekleyen)), alt: `${sayi(dnUyumsuz?.gun_toplam)} kayıt · ${sayi(dnUyumsuz?.gun_cozuldu)} çözüldü`, renk: sayi(dnUyumsuz?.gun_bekleyen) ? R.kirmizi : R.yesil },
          { etiket: 'Fire bildirimi', deger: String(sayi(dnFire?.gun_toplam)), alt: `${sayi(dnFire?.toplam_adet_gun)} adet · ${tarihKisa(barTarih)}`, renk: sayi(dnFire?.gun_toplam) ? R.amber : R.yesil },
          { etiket: 'Fişsiz gider', deger: String(fisListe.length), alt: 'son 7 gün · belge bekliyor', renk: fisListe.length ? R.amber : R.yesil },
          { etiket: 'Stok kaybı kalemi', deger: String(kayipListe.length), alt: 'son 45 gün analizi', renk: kayipListe.length ? R.amber : R.yesil },
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
              background: dnSekme === id ? 'rgba(217,154,78,.12)' : R.girinti,
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

        {dnSekme === 'fis' && (fisListe.length ? (
          <Tablo
            baslik="Fişi bekleyen giderler · son 7 gün"
            not="kasadan çıktı ama belge yüklenmedi — KDV kanıtı eksik"
            kolonlar={[{ ad: 'Açıklama' }, { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Tutar', sag: 1 }]}
            satirlar={fisListe.slice(0, 40).map((x, i) => ({
              id: x.id || `fi-${i}`,
              hucreler: [
                { v: x.aciklama || x.baslik || '—', kalin: true },
                { v: tarihKisa(x.tarih), mono: true, renk: R.not },
                { v: x.sube_adi || x.sube || '—', renk: R.not },
                { v: fmt(sayi(x.tutar)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
              ],
            }))}
          />
        ) : <BosDurum metin="Fişi bekleyen gider yok — tüm harcamaların belgesi var. ✓" />)}

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

        {dnSekme === 'kayip' && (kayipListe.length ? (
          <Tablo
            baslik="Stok kaybı analizi · son 45 gün"
            not="kayıtlı hareketle açıklanmayan azalma — aday, hüküm değil"
            kolonlar={[{ ad: 'Kalem' }, { ad: 'Şube' }, { ad: 'Kayıp', sag: 1 }, { ad: 'Not' }]}
            satirlar={kayipListe.slice(0, 40).map((x, i) => ({
              id: x.id || `ky-${i}`,
              hucreler: [
                { v: x.kalem_adi || x.urun_ad || '—', kalin: true },
                { v: x.sube_adi || x.sube_ad || '—', renk: R.not },
                { v: String(sayi(x.kayip ?? x.fark ?? x.adet)), mono: true, sag: true, kalin: true, renk: R.kirmizi },
                { v: x.not || x.aciklama || '—', renk: R.not },
              ],
            }))}
          />
        ) : <BosDurum metin="Stok kaybı bulgusu yok — hareketler dengede. ✓" />)}

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
      ['teslim', `\u{1F4E6} Toptancıdan gelen (${teslimSube.length})`],
      ['notlar', `\u{1F4DD} Şube notları (${notlar.length})`],
      ['tahmin', `\u{1F52E} Stok tahmini (${tahminler.length})`],
      ['kpi', `\u{1F4CA} KPI değişimi (${kpilar.length})`],
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
              background: tsSekme === id ? 'rgba(217,154,78,.12)' : R.girinti,
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
        {/* SEVKİYAT HIZI DUYUSU (2026-07-29): mevcut zaman damgalarından türetilen
            salt-okur ölçüm — 'talepten teslime kaç saat, hangi depo yavaş?' */}
        {hiz && sayi(hiz.teslim_adet) > 0 && (
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
        )}
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
