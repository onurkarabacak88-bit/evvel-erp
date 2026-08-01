// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — PARA HAREKETLERİ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → para.* bölümleri
//
// 5 görünüm: Ciro Girişi · Ürün Satışları · Kasa Teslim · Anlık Gider · Dış Kaynak
//
// İlkeler:
// - TÜM görünümler SALT-OKUR: ciro/gider/dış-kaynak GİRİŞİ mevcut guard'lı
//   formlarda kalır (köprüyle açılır) — yeni para yazma yolu YOK.
// - Blueprint'ten bilinçli sapmalar (tasarımın-devamı kuralı):
//   * Ürün Satışları'nda "Sabah/Öğle/Akşam" kolonları YOK — Evo raporu saatlik
//     kırılım vermiyor, sahte sayı yasak. Yerine şube kırılımı çekmecesi.
//   * Kasa Teslim'de "teslim bekleyen" KPI'sı YOK — sistemde 'bekleyen teslim'
//     kaydı tutulmuyor (teslim edilince kayıt doğar); olmayan veri uydurulmaz.
//     kasaTeslim rozeti de bu yüzden BAĞLANMADI.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, BosDurum, HataBandi } from './parcalar';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// Tarih tuzağı (bkz TasarimV2): "bugün" yerel parçalardan, aritmetik UTC'de
const bugunISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const gunEkle = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
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

// Kadife form alanı stili (yerli giriş — köprüsüz)
const alanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const alanEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

export default function ParaModulu({ gorunum, onCekmece, onKopru, onToast }) {
  // ── CİRO GİRİŞİ ───────────────────────────────────────────────────────────
  const [cirolar, setCirolar] = useState(null);
  const [subeler, setSubeler] = useState([]);
  const [taslaklar, setTaslaklar] = useState([]);
  const [ciroHata, setCiroHata] = useState('');
  // v2-YERLİ ciro formu (2026-07-29 sahip kararı: köprüler kalkıyor) — aynı
  // guard'lı uca yazar (POST /ciro: mükerrer uyarı + force; DELETE: kasa iadesi)
  const [ciroForm, setCiroForm] = useState(null);      // null=kapalı | {tarih,sube_id,nakit,pos,online,aciklama}
  const [ciroDup, setCiroDup] = useState('');          // mükerrer uyarı metni
  const [ciroMesgul, setCiroMesgul] = useState(false);
  const [iptalSor, setIptalSor] = useState('');        // iki-adımlı iptal onayı (kayıt id)
  // ── ÜRÜN SATIŞLARI ────────────────────────────────────────────────────────
  const [satisGun, setSatisGun] = useState(() => bugunISO());
  const [satis, setSatis] = useState(null);
  const [satisHata, setSatisHata] = useState('');
  // Evo kasiyer kimliği: ortak hesapta isim gelmez, sayısal ID kalır (2026-07-31)
  const [evoIsim, setEvoIsim] = useState(null);        // {personel_id, ad}
  const [evoMesgul, setEvoMesgul] = useState(false);
  const [evoSyncMesgul, setEvoSyncMesgul] = useState(false);
  // ⚠️ SAHİP YAKALADI (2026-07-31): "ürün satışları bakışında şube bazlı kırılım
  // yok, v1'de bu desen vardı." Doğruydu — aynı Evo cevabında şube başına
  // ciro_toplam / nakit / kart / iskonto_toplam / fatura_sayisi / gruplar
  // geliyordu, v2 hepsini atıp yalnız ürünleri birleştiriyordu.
  const [satisSube, setSatisSube] = useState('');   // '' = tüm şubeler
  // ── KASA TESLİM ───────────────────────────────────────────────────────────
  const [teslimler, setTeslimler] = useState(null);
  const [teslimHata, setTeslimHata] = useState('');
  const [paraYolda, setParaYolda] = useState(null);  // duyu 2/6 (salt-okur)
  // v2-YERLİ (köprü kaldırma): filtre hapları + teslim alıcı yönetimi
  // (teslim kaydının KENDİSİ QR/şube akışında doğar — burada yazılmaz)
  const [teslimSube, setTeslimSube] = useState('');
  const [teslimTur, setTeslimTur] = useState('');
  const [aliciModal, setAliciModal] = useState(false);
  const [alicilar, setAlicilar] = useState(null);
  const [aliciForm, setAliciForm] = useState(null);  // {id?, ad, unvan, sube_id}
  const [aliciMesgul, setAliciMesgul] = useState(false);
  const [aliciPasifSor, setAliciPasifSor] = useState('');
  // Zincirin 3. halkası: kasa → teslim → BANKA (2026-07-31)
  const [bankaMut, setBankaMut] = useState(null);      // /banka-mutabakat
  const [bankaListe, setBankaListe] = useState(null);  // /banka-yatirimlari
  const [bankaModal, setBankaModal] = useState(false);
  const [bankaForm, setBankaForm] = useState(null);    // {tarih, tutar, yatiran_ad, aciklama}
  const [bankaMesgul, setBankaMesgul] = useState(false);
  // ── ANLIK GİDER ───────────────────────────────────────────────────────────
  const [giderler, setGiderler] = useState(null);
  const [giderOzet, setGiderOzet] = useState(null);
  const [giderHata, setGiderHata] = useState('');
  // v2-YERLİ gider formu (köprü kaldırma turu): aynı guard'lı uçlar
  const [giderForm, setGiderForm] = useState(null);   // {tarih,kategori,tutar,aciklama,sube,odeme_yontemi,kart_id,tedarikci}
  const [giderDup, setGiderDup] = useState('');
  const [kartlar, setKartlar] = useState([]);
  const [kartOneri, setKartOneri] = useState(null);
  const [giderIptalSor, setGiderIptalSor] = useState('');
  // ── DIŞ KAYNAK ────────────────────────────────────────────────────────────
  const [dkAy, setDkAy] = useState(() => bugunISO().slice(0, 7));
  const [diskaynak, setDiskaynak] = useState(null);
  const [dkHata, setDkHata] = useState('');
  const [dkForm, setDkForm] = useState(null);         // {tarih,kategori,tutar,aciklama}
  const [dkDup, setDkDup] = useState('');
  const [dkIptalSor, setDkIptalSor] = useState('');
  const [formMesgul, setFormMesgul] = useState(false);

  const ciroYukle = useCallback(() => {
    setCiroHata('');
    Promise.all([
      api('/ciro?limit=300'),
      api('/subeler'),
      api('/ciro-taslak?durum=bekliyor').catch(() => []),
    ]).then(([c, s, t]) => {
      setCirolar(Array.isArray(c) ? c : []);
      setSubeler(Array.isArray(s) ? s : []);
      setTaslaklar(Array.isArray(t) ? t : []);
    }).catch((e) => setCiroHata(e?.message || ''));
  }, []);

  const ciroKaydet = async (force = false) => {
    if (!ciroForm?.sube_id) { onToast?.('Şube seçmeden ciro kaydedilmez'); return; }
    setCiroMesgul(true);
    setCiroDup('');
    try {
      const res = await api('/ciro', { method: 'POST', body: { ...ciroForm, force } });
      if (res?.warning) { setCiroDup(res.mesaj || 'Benzer kayıt var.'); return; }
      onToast?.('✓ Ciro kaydedildi — merkez kasaya eklendi');
      setCiroForm(null);
      ciroYukle();
    } catch (e) {
      onToast?.(e?.message || 'Ciro kaydedilemedi');
    } finally {
      setCiroMesgul(false);
    }
  };

  const ciroIptal = async (id) => {
    setCiroMesgul(true);
    try {
      await api(`/ciro/${id}`, { method: 'DELETE' });
      onToast?.('Ciro iptal edildi — kasadan iade edildi');
      setIptalSor('');
      ciroYukle();
    } catch (e) {
      onToast?.(e?.message || 'İptal edilemedi');
    } finally {
      setCiroMesgul(false);
    }
  };

  // Gider formunu aç: kart listesi tembel yüklenir (yalnız form açılınca)
  const giderFormAc = () => {
    setGiderDup('');
    setKartOneri(null);
    setGiderForm({
      tarih: bugunISO(), kategori: 'Diğer', tutar: '', aciklama: '',
      sube: 'MERKEZ', odeme_yontemi: 'nakit', kart_id: '', tedarikci: '',
    });
    if (!kartlar.length) api('/kartlar').then((d) => setKartlar(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const giderKaydet = async (force = false) => {
    if (!sayi(giderForm?.tutar)) { onToast?.('Tutar girmeden gider kaydedilmez'); return; }
    if (giderForm.odeme_yontemi === 'kart' && !giderForm.kart_id) { onToast?.('Kart seçimi zorunlu'); return; }
    setFormMesgul(true);
    setGiderDup('');
    try {
      const body = { ...giderForm, force };
      if (body.odeme_yontemi === 'nakit') delete body.kart_id;
      const res = await api('/anlik-gider', { method: 'POST', body });
      if (res?.warning) { setGiderDup(res.mesaj || 'Benzer kayıt var.'); return; }
      onToast?.(giderForm.odeme_yontemi === 'kart'
        ? '✓ Gider kaydedildi — kart borcuna eklendi'
        : '✓ Gider kaydedildi — kasadan düşüldü');
      setGiderForm(null);
      giderYukle();
    } catch (e) {
      onToast?.(e?.message || 'Gider kaydedilemedi');
    } finally {
      setFormMesgul(false);
    }
  };

  const giderSil = async (g) => {
    setFormMesgul(true);
    try {
      await api(`/anlik-gider/${g.id}`, { method: 'DELETE' });
      onToast?.(g?.odeme_yontemi === 'kart' ? 'İptal — kart borcundan düşüldü' : 'İptal — kasaya iade edildi');
      setGiderIptalSor('');
      giderYukle();
    } catch (e) {
      onToast?.(e?.message || 'İptal edilemedi');
    } finally {
      setFormMesgul(false);
    }
  };

  // Kart önerisi (salt-okur yardım): tutar + kart modundayken istenir
  const kartOneriGetir = (tutar) => {
    api(`/anlik-gider-kart-oneri?tutar=${sayi(tutar)}`)
      .then((d) => setKartOneri(d || null))
      .catch(() => setKartOneri(null));
  };

  const dkKaydet = async (force = false) => {
    if (!sayi(dkForm?.tutar)) { onToast?.('Tutar girmeden gelir kaydedilmez'); return; }
    setFormMesgul(true);
    setDkDup('');
    try {
      const res = await api('/dis-kaynak', { method: 'POST', body: { ...dkForm, force } });
      if (res?.warning) { setDkDup(res.mesaj || 'Benzer kayıt var.'); return; }
      onToast?.('✓ Gelir kaydedildi — kasaya eklendi');
      setDkForm(null);
      dkYukle(dkAy);
    } catch (e) {
      onToast?.(e?.message || 'Gelir kaydedilemedi');
    } finally {
      setFormMesgul(false);
    }
  };

  const dkSil = async (id) => {
    setFormMesgul(true);
    try {
      await api(`/dis-kaynak/${id}`, { method: 'DELETE' });
      onToast?.('İptal edildi — kasadan düşüldü');
      setDkIptalSor('');
      dkYukle(dkAy);
    } catch (e) {
      onToast?.(e?.message || 'İptal edilemedi');
    } finally {
      setFormMesgul(false);
    }
  };

  const satisYukle = useCallback((gun) => {
    setSatisHata('');
    setSatis(null);
    api(`/evo/sube-grup-detay?bastar=${gun}&bittar=${gun}`)
      .then((d) => setSatis(d || {}))
      .catch((e) => setSatisHata(e?.message || ''));
  }, []);

  /** Evo'da isimsiz kalan kasiyere elle isim ver (ID → ad eşleşmesi cache'e yazılır).
   *  ⚠️ Gövde OBJE gider — api() zaten JSON.stringify ediyor; klasik ekran burada
   *  bir kez daha stringify ettiği için sunucuya metin gönderiyordu. */
  const evoIsimKaydet = async () => {
    const pid = String(evoIsim?.personel_id || '').trim();
    const ad = String(evoIsim?.ad || '').trim();
    if (!pid) return;
    if (!ad) { onToast?.('Personel adını yazın'); return; }
    setEvoMesgul(true);
    try {
      await api('/evo/personel-isim-gir', { method: 'POST', body: { personel_id: pid, ad } });
      onToast?.(`✓ #${pid} artık «${ad}» olarak tanınıyor`);
      setEvoIsim(null);
      satisYukle(satisGun);
    } catch (e) {
      onToast?.(e?.message || 'İsim kaydedilemedi');
    } finally {
      setEvoMesgul(false);
    }
  };

  /** Son 14 günü tarayıp Evo'dan gelen isimleri tazele (elle girilenleri ezmez). */
  const evoIsimSync = async () => {
    setEvoSyncMesgul(true);
    try {
      const r = await api('/evo/personel-sync?gunler=14', { method: 'POST' });
      onToast?.(`🔄 ${sayi(r?.cache_boyutu)} personel kaydı tazelendi (son ${sayi(r?.taranan_gun) || 14} gün)`);
      satisYukle(satisGun);
    } catch (e) {
      onToast?.(e?.message || 'Evo taraması başarısız — token gerekebilir');
    } finally {
      setEvoSyncMesgul(false);
    }
  };

  const teslimYukle = useCallback(() => {
    setTeslimHata('');
    const b = bugunISO();
    Promise.all([
      api(`/kasa-teslim?tarih_baslangic=${b.slice(0, 7)}-01&tarih_bitis=${b}`),
      subeler.length ? Promise.resolve(subeler) : api('/subeler').catch(() => []),
    ]).then(([k, s]) => {
      setTeslimler(Array.isArray(k) ? k : (k?.satirlar || []));
      if (!subeler.length && Array.isArray(s)) setSubeler(s);
    }).catch((e) => setTeslimHata(e?.message || ''));
    api('/ops/para-yolda?gun=14')
      .then((d) => setParaYolda(d || {}))
      .catch(() => setParaYolda({}));
    bankaYukle();
  }, [subeler]);

  /** Kasa → teslim → banka üçlüsü. Mutabakat GÖSTERGE; banka yatırımı kasaya DOKUNMAZ.
   *  Fonksiyon BEYANI (const değil) — teslimYukle içinden çağrılıyor, TDZ'ye düşmesin. */
  function bankaYukle() {
    api('/banka-mutabakat').then((d) => setBankaMut(d || null)).catch(() => setBankaMut(null));
    api('/banka-yatirimlari?limit=200')
      .then((r) => setBankaListe(Array.isArray(r?.satirlar) ? r.satirlar : []))
      .catch(() => setBankaListe([]));
  }

  const bankaKaydet = async () => {
    const f = bankaForm || {};
    const tutar = Number(String(f.tutar ?? '').replace(',', '.'));
    if (!tutar || tutar <= 0) { onToast?.('Geçerli bir tutar girin'); return; }
    const ad = (f.yatiran_ad || '').trim();
    if (!ad) { onToast?.('Bankaya yatıran kişinin adını yazın'); return; }
    if (!f.tarih) { onToast?.('Yatırma tarihi zorunlu'); return; }
    setBankaMesgul(true);
    try {
      await api('/banka-yatirimlari', {
        method: 'POST',
        body: { tarih: f.tarih, tutar, yatiran_ad: ad, aciklama: (f.aciklama || '').trim() || null },
      });
      onToast?.(`🏦 ${fmt(tutar)} banka yatırımı kaydedildi — takip kaydı, kasadan düşülmedi`);
      setBankaForm({ tarih: bugunISO(), tutar: '', yatiran_ad: ad, aciklama: '' });
      bankaYukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setBankaMesgul(false);
    }
  };

  const alicilariYukle = () => {
    api('/kasa-teslim-alici')
      .then((r) => setAlicilar(Array.isArray(r?.alicilar) ? r.alicilar : []))
      .catch(() => setAlicilar([]));
  };

  const aliciKaydet = async () => {
    if (!(aliciForm?.ad || '').trim()) { onToast?.('Alıcı adı zorunlu'); return; }
    setAliciMesgul(true);
    try {
      const body = { ad: aliciForm.ad, unvan: aliciForm.unvan || '', sube_id: aliciForm.sube_id || '' };
      if (aliciForm.id) await api(`/kasa-teslim-alici/${aliciForm.id}`, { method: 'PUT', body });
      else await api('/kasa-teslim-alici', { method: 'POST', body });
      onToast?.(aliciForm.id ? '✓ Alıcı güncellendi' : '✓ Alıcı eklendi');
      setAliciForm(null);
      alicilariYukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setAliciMesgul(false);
    }
  };

  const aliciPasife = async (id) => {
    setAliciMesgul(true);
    try {
      await api(`/kasa-teslim-alici/${id}`, { method: 'DELETE' });
      onToast?.('Alıcı pasife alındı');
      setAliciPasifSor('');
      alicilariYukle();
    } catch (e) {
      onToast?.(e?.message || 'Pasife alınamadı');
    } finally {
      setAliciMesgul(false);
    }
  };

  const giderYukle = useCallback(() => {
    setGiderHata('');
    const ay = bugunISO().slice(0, 7);
    api(`/anlik-gider?durum=aktif&include_summary=true&ay=${ay}`)
      .then((d) => {
        setGiderler(Array.isArray(d) ? d : (d?.satirlar || []));
        setGiderOzet(d?.ozet || null);
      })
      .catch((e) => setGiderHata(e?.message || ''));
  }, []);

  const dkYukle = useCallback((ay) => {
    setDkHata('');
    setDiskaynak(null);
    api(`/dis-kaynak?ay=${ay}`)
      .then((d) => setDiskaynak(Array.isArray(d) ? d : (d?.liste || [])))
      .catch((e) => setDkHata(e?.message || ''));
  }, []);

  useEffect(() => {
    if (gorunum === 'girisi') ciroYukle();
    if (gorunum === 'satis') satisYukle(satisGun);
    if (gorunum === 'kasa') teslimYukle();
    if (gorunum === 'gider') giderYukle();
    if (gorunum === 'diskaynak') dkYukle(dkAy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  const subeAd = useMemo(() => {
    const m = {};
    (subeler || []).forEach((s) => { m[String(s.id)] = s.ad; });
    return m;
  }, [subeler]);

  // ════════════════════════ GÖRÜNÜM: CİRO GİRİŞİ ════════════════════════════
  if (gorunum === 'girisi') {
    if (ciroHata) return <HataBandi mesaj={ciroHata} onTekrar={ciroYukle} />;
    if (cirolar == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const dun = gunEkle(bugun, -1);
    const gunKayit = (g) => cirolar.filter((c) => String(c.tarih || '').slice(0, 10) === g);
    const bugunku = gunKayit(bugun);
    const dunku = gunKayit(dun);
    const toplam = (rows) => rows.reduce((t, c) => t + (sayi(c.toplam) || sayi(c.nakit) + sayi(c.pos) + sayi(c.online)), 0);
    const girilenSubeler = new Set(bugunku.map((c) => String(c.sube_id)));
    const magazalar = (subeler || []).filter((s) => s.aktif !== false);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün girilen', deger: `${girilenSubeler.size} / ${magazalar.length} şube`, alt: girilenSubeler.size < magazalar.length ? 'eksik şube var' : 'tamamlandı', renk: girilenSubeler.size < magazalar.length ? R.amber : R.yesil },
          { etiket: 'Bugünkü toplam', deger: fmt(toplam(bugunku)), alt: 'onaylı ciro kayıtları' },
          { etiket: 'Dün', deger: fmt(toplam(dunku)), alt: `${dunku.length} şube kaydı` },
          { etiket: 'Onay bekleyen taslak', deger: String(taslaklar.length), alt: 'ciro onayında', renk: taslaklar.length > 0 ? R.amber : R.krem },
        ]} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {magazalar.map((s) => {
            const kayit = bugunku.find((c) => String(c.sube_id) === String(s.id));
            return (
              <div key={s.id} style={{
                ...kartYuzey, padding: '13px 18px', display: 'flex', alignItems: 'center',
                gap: 14, flexWrap: 'wrap',
                border: kayit ? kartYuzey.border : `1px solid ${R.amber}44`,
              }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.ad}</div>
                  <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                    {kayit ? `bugün girildi · ${tarihKisa(kayit.tarih)}` : 'bugünün cirosu henüz girilmedi'}
                  </div>
                </div>
                {kayit ? (
                  <>
                    <span style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700 }}>
                      {fmt(sayi(kayit.toplam) || sayi(kayit.nakit) + sayi(kayit.pos) + sayi(kayit.online))}
                    </span>
                    <span style={rozetHap(R.yesil)}>✓ girildi</span>
                    {iptalSor === String(kayit.id) ? (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button disabled={ciroMesgul} onClick={() => ciroIptal(kayit.id)} style={{
                          padding: '6px 12px', borderRadius: 9, border: 'none', cursor: 'pointer',
                          background: `${R.kirmizi}22`, color: R.kirmizi, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                        }}>
                          Eminim — kasadan iade et
                        </button>
                        <button onClick={() => setIptalSor('')} style={{
                          padding: '6px 10px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                        }}>
                          Vazgeç
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setIptalSor(String(kayit.id))} style={{
                        padding: '6px 11px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>
                        İptal
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <span style={rozetHap(R.amber)}>bekliyor</span>
                    <KopruButon birincil ad="Ciro gir" onTikla={() => {
                      setCiroDup('');
                      setCiroForm({ tarih: bugun, sube_id: String(s.id), nakit: '', pos: '', online: '', aciklama: '' });
                    }} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 16 }}>
          <KopruButon birincil ad="+ Ciro Gir (serbest tarih/şube)" onTikla={() => {
            setCiroDup('');
            setCiroForm({ tarih: bugun, sube_id: '', nakit: '', pos: '', online: '', aciklama: '' });
          }} />
          {taslaklar.length > 0 && <KopruButon ad={`Ciro onayı (${taslaklar.length})`} onTikla={() => onKopru?.('__modul:onaylar:ciro')} />}
        </div>

        {/* ── YERLİ CİRO FORMU (kadife modal — köprü kaldırıldı, aynı uca yazar) ── */}
        {ciroForm && (() => {
          const sube = (subeler || []).find((x) => String(x.id) === String(ciroForm.sube_id));
          const posK = (sayi(ciroForm.pos) * (sayi(sube?.pos_oran))) / 100;
          const onlK = (sayi(ciroForm.online) * (sayi(sube?.online_oran))) / 100;
          const yanan = posK + onlK;
          const toplamG = sayi(ciroForm.nakit) + sayi(ciroForm.pos) + sayi(ciroForm.online);
          const alan = (k, v) => setCiroForm((f) => ({ ...f, [k]: v }));
          return (
            <div
              onClick={(e) => { if (e.target === e.currentTarget && !ciroMesgul) setCiroForm(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
                backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
              }}
            >
              <div style={{ ...kartYuzey, width: 520, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Ciro Gir</div>
                  <div style={{ fontSize: 11.5, color: R.not2 }}>kaydedilince merkez kasaya eklenir</div>
                  <button onClick={() => !ciroMesgul && setCiroForm(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={alanEtiket}>Tarih</label>
                    <input type="date" value={ciroForm.tarih} onChange={(e) => alan('tarih', e.target.value)}
                      style={{ ...alanStil, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Şube *</label>
                    <select value={ciroForm.sube_id} onChange={(e) => alan('sube_id', e.target.value)} style={alanStil}>
                      <option value="">Seçin</option>
                      {(subeler || []).map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={alanEtiket}>Nakit (₺)</label>
                    <input type="number" value={ciroForm.nakit} onChange={(e) => alan('nakit', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>POS (₺)</label>
                    <input type="number" value={ciroForm.pos} onChange={(e) => alan('pos', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Online (₺)</label>
                    <input type="number" value={ciroForm.online} onChange={(e) => alan('online', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Açıklama</label>
                    <input value={ciroForm.aciklama} onChange={(e) => alan('aciklama', e.target.value)} style={alanStil} />
                  </div>
                </div>

                {/* Anlık toplam + yanan para (finansman maliyeti) */}
                <div style={{
                  marginTop: 16, padding: '12px 16px', borderRadius: 12, background: R.girinti,
                  border: `1px solid ${R.cizgi3}`, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5,
                }}>
                  <span style={{ color: R.metin2 }}>
                    Toplam: <strong style={{ fontFamily: F.mono, color: R.krem }}>{fmt(toplamG)}</strong>
                  </span>
                  {yanan > 0 && (
                    <>
                      {posK > 0 && <span style={{ color: R.metin2 }}>POS kesinti (%{sayi(sube?.pos_oran)}): <strong style={{ fontFamily: F.mono, color: R.kirmizi }}>−{fmt(posK)}</strong></span>}
                      {onlK > 0 && <span style={{ color: R.metin2 }}>Online kesinti (%{sayi(sube?.online_oran)}): <strong style={{ fontFamily: F.mono, color: R.kirmizi }}>−{fmt(onlK)}</strong></span>}
                      <span style={{ color: R.kirmizi, fontWeight: 700 }}>🔥 Yanan: {fmt(yanan)}</span>
                    </>
                  )}
                </div>

                {ciroDup && (
                  <div style={{
                    marginTop: 14, padding: '13px 16px', borderRadius: 12,
                    background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`,
                  }}>
                    <div style={{ fontSize: 12.5, color: R.kirmizi, fontWeight: 700 }}>⚠ Benzer kayıt var</div>
                    <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.55 }}>{ciroDup}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button disabled={ciroMesgul} onClick={() => ciroKaydet(true)} style={{
                        padding: '7px 13px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                      }}>
                        Yine de kaydet
                      </button>
                      <button onClick={() => setCiroDup('')} style={{
                        padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                      }}>
                        Vazgeç
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <button disabled={ciroMesgul} onClick={() => setCiroForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>
                    İptal
                  </button>
                  <button disabled={ciroMesgul || !ciroForm.sube_id || ciroDup !== ''} onClick={() => ciroKaydet(false)} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: (!ciroForm.sube_id || ciroDup !== '') ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                    color: (!ciroForm.sube_id || ciroDup !== '') ? R.not : '#1C1309',
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    cursor: (!ciroForm.sube_id || ciroDup !== '') ? 'default' : 'pointer',
                  }}>
                    {ciroMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: ÜRÜN SATIŞLARI ═════════════════════════
  if (gorunum === 'satis') {
    if (satisHata) return <HataBandi mesaj={satisHata} onTekrar={() => satisYukle(satisGun)} />;
    if (satis == null) return <Yukleniyor />;
    const subeVeri = satis?.subeler || {};
    const subeAdlari = Object.keys(subeVeri);
    // Şube seçiliyse ürün tablosu da O ŞUBEYE daralır (klasikteki şube analizi)
    const seciliSube = satisSube && subeVeri[satisSube] ? satisSube : '';
    const kaynakSubeler = seciliSube ? { [seciliSube]: subeVeri[seciliSube] } : subeVeri;
    const sd0 = seciliSube ? (subeVeri[seciliSube] || {}) : null;
    // Ürünleri şubeler arası topla
    const urunMap = {};
    let toplamAdet = 0; let toplamCiro = 0;
    Object.entries(kaynakSubeler).forEach(([sad, sd]) => {
      (sd?.cok_satilan || []).forEach((u) => {
        const k = String(u.ad || '').trim();
        if (!k) return;
        if (!urunMap[k]) urunMap[k] = { ad: k, grup: u.grup || '—', adet: 0, ciro: 0, subeler: {} };
        urunMap[k].adet += sayi(u.adet);
        urunMap[k].ciro += sayi(u.ciro);
        urunMap[k].subeler[sad] = (urunMap[k].subeler[sad] || 0) + sayi(u.adet);
        toplamAdet += sayi(u.adet);
        toplamCiro += sayi(u.ciro);
      });
    });
    const urunler = Object.values(urunMap).sort((a, b) => b.adet - a.adet);
    const enCok = urunler[0];
    const gunSecici = (
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[[bugunISO(), 'Bugün'], [gunEkle(bugunISO(), -1), 'Dün'], [gunEkle(bugunISO(), -2), tarihKisa(gunEkle(bugunISO(), -2))]].map(([g, ad]) => (
          <div
            key={g}
            onClick={() => { setSatisGun(g); satisYukle(g); }}
            style={{
              padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              background: satisGun === g ? `${R.bakir}22` : R.girinti,
              color: satisGun === g ? R.bakir : R.not,
              border: `1px solid ${satisGun === g ? `${R.bakir}55` : R.cizgi3}`,
            }}
          >
            {ad}
          </div>
        ))}
      </div>
    );
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Satılan ürün', deger: String(toplamAdet), alt: `${urunler.length} çeşit · ${seciliSube || `${subeAdlari.length} şube`}` },
          { etiket: 'Ürün cirosu', deger: toplamCiro > 0 ? fmt(toplamCiro) : '—', alt: 'Evo satış raporu' },
          { etiket: 'En çok satan', deger: enCok ? enCok.ad : '—', alt: enCok ? `${enCok.adet} adet` : 'kayıt yok', renk: R.yesil },
          { etiket: 'Gün', deger: tarihKisa(satisGun), alt: 'Evo gece senkronuyla dolar' },
        ]} />
        {gunSecici}

        {/* ── ŞUBE KIRILIMI — klasikteki şube analizi (v1 deseni geri geldi) ── */}
        {subeAdlari.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              {[['', 'Tüm şubeler'], ...subeAdlari.map((s) => [s, s])].map(([id, ad]) => (
                <div key={id || 'hepsi'} onClick={() => setSatisSube(id)} style={{
                  padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                  background: seciliSube === id ? `${R.bakir}22` : R.girinti,
                  color: seciliSube === id ? R.bakir : R.not,
                  border: `1px solid ${seciliSube === id ? `${R.bakir}55` : R.cizgi3}`,
                }}>{ad}</div>
              ))}
            </div>

            {sd0 && (() => {
              const ciro = sayi(sd0.ciro_toplam);
              const nakit = sayi(sd0.nakit);
              const kart = sayi(sd0.kart);
              const isk = sayi(sd0.iskonto_toplam);
              const fis = sayi(sd0.fatura_sayisi);
              const gruplar = Object.entries(sd0.gruplar || {})
                .map(([g, v]) => ({ g, adet: sayi(v?.adet), ciro: sayi(v?.ciro) }))
                .filter((x) => x.adet > 0 || x.ciro > 0)
                .sort((a, b) => b.ciro - a.ciro);
              const grupToplam = gruplar.reduce((s, x) => s + x.ciro, 0);
              return (
                <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12,
                  }}>
                    <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                      🏪 {seciliSube} · {tarihKisa(satisGun)}
                    </span>
                    <span style={{ fontSize: 11, color: R.not2 }}>Evo şube raporu</span>
                  </div>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12.5, marginBottom: gruplar.length ? 13 : 0 }}>
                    <span>Fiş <b style={{ fontFamily: F.mono }}>{fis || '—'}</b></span>
                    <span>Ciro <b style={{ fontFamily: F.mono }}>{ciro > 0 ? fmt(ciro) : '—'}</b></span>
                    <span>Nakit <b style={{ fontFamily: F.mono, color: R.yesil }}>{fmt(nakit)}</b>
                      {ciro > 0 && <span style={{ color: R.not2 }}> · %{Math.round((nakit / ciro) * 100)}</span>}</span>
                    <span>Kart <b style={{ fontFamily: F.mono, color: R.mavi }}>{fmt(kart)}</b>
                      {ciro > 0 && <span style={{ color: R.not2 }}> · %{Math.round((kart / ciro) * 100)}</span>}</span>
                    <span>İskonto <b style={{ fontFamily: F.mono, color: isk > 0 ? R.amber : R.not }}>{isk > 0 ? fmt(isk) : '—'}</b>
                      {isk > 0 && ciro > 0 && <span style={{ color: R.not2 }}> · ciroya oranı %{((isk / ciro) * 100).toFixed(1).replace('.', ',')}</span>}</span>
                    <span style={{ color: R.not2 }}>fiş başı {fis > 0 ? fmt(ciro / fis) : '—'}</span>
                  </div>

                  {gruplar.length > 0 && (
                    <>
                      <div style={{ fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
                        color: R.not2, fontWeight: 700, marginBottom: 8 }}>Grup dağılımı</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {gruplar.map((x) => {
                          const pay = grupToplam > 0 ? Math.round((x.ciro / grupToplam) * 100) : 0;
                          return (
                            <div key={x.g} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                              <span style={{ minWidth: 108, fontWeight: 600 }}>{x.g}</span>
                              <span style={{ fontFamily: F.mono, color: R.not2, minWidth: 66 }}>{x.adet} adet</span>
                              <div style={{ flex: 1, height: 6, borderRadius: 99, background: R.girinti, overflow: 'hidden', minWidth: 60 }}>
                                <div style={{ width: `${pay}%`, height: '100%', background: R.bakir }} />
                              </div>
                              <span style={{ fontFamily: F.mono, minWidth: 78, textAlign: 'right' }}>{fmt(x.ciro)}</span>
                              <span style={{ fontFamily: F.mono, color: R.not2, minWidth: 34, textAlign: 'right' }}>%{pay}</span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {!gruplar.length && (
                    <div style={{ fontSize: 11.5, color: R.not2 }}>
                      Bu gün için grup dağılımı gelmedi — Evo raporu gece senkronuyla dolar.
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {urunler.length === 0 ? (
          <BosDurum metin="Bu gün için Evo satış raporu henüz düşmedi — rapor gece senkronuyla gelir. Dünü seçerek tamamlanmış günü görebilirsin." />
        ) : (
          <Tablo
            baslik={`Ürün satışları · ${seciliSube || 'tüm şubeler'} · ${tarihKisa(satisGun)}`}
            not={seciliSube ? 'yalnız bu şubenin ürünleri' : 'satıra tıkla → şube kırılımı'}
            kolonlar={[
              { ad: 'Ürün' }, { ad: 'Grup' }, { ad: 'Adet', sag: 1 }, { ad: 'Ciro', sag: 1 }, { ad: 'Pay', sag: 1 },
            ]}
            satirlar={urunler.slice(0, 30).map((u, i) => ({
              id: `u-${i}`,
              _u: u,
              hucreler: [
                { v: u.ad, kalin: true },
                { v: u.grup, renk: R.not },
                { v: String(u.adet), mono: true, sag: true, kalin: i === 0 },
                { v: u.ciro > 0 ? fmt(u.ciro) : '—', mono: true, sag: true },
                { v: toplamAdet ? `%${Math.round((u.adet / toplamAdet) * 100)}` : '—', bar: toplamAdet ? Math.round((u.adet / toplamAdet) * 100) : 0, sag: true, renk: R.bakir },
              ],
            }))}
            onSatir={({ _u }) => onCekmece?.({
              tip: 'ÜRÜN SATIŞI',
              baslik: _u.ad,
              alt: `${_u.grup} · ${tarihKisa(satisGun)} · ${_u.adet} adet`,
              kpi: [
                { etiket: 'Adet', deger: String(_u.adet) },
                { etiket: 'Ciro', deger: _u.ciro > 0 ? fmt(_u.ciro) : '—' },
                { etiket: 'Şube', deger: String(Object.keys(_u.subeler).length) },
                { etiket: 'Pay', deger: toplamAdet ? `%${Math.round((_u.adet / toplamAdet) * 100)}` : '—', renk: R.bakir },
              ],
              listeBaslik: 'Şube kırılımı',
              satirlar: Object.entries(_u.subeler)
                .sort((a, b) => b[1] - a[1])
                .map(([sad, adet]) => ({ ad: sad, detay: '', tutar: `${adet} adet` })),
              not: 'Reçete maliyeti ve tüketim kıyası Kâr & Maliyet modülünde.',
              aksiyonAd: 'Satış analizini aç (Evo)',
              _hedef: '__modul:para:satis',
            })}
          />
        )}

        {/* ── KİM SATTI — aynı Evo cevabında geliyordu, v2'de hiç kullanılmıyordu ──
            Evo'da ortak kasa hesabı kullanılınca isim gelmez, sayısal ID kalır;
            o eşleşmeyi burada elle kurabiliyoruz (POST /evo/personel-isim-gir). */}
        {(() => {
          const kisiMap = {};
          Object.entries(kaynakSubeler).forEach(([sad, sd]) => {
            (sd?.personel_satislar || []).forEach((p) => {
              const pid = String(p.personel_id ?? '').trim();
              if (!pid) return;
              if (!kisiMap[pid]) kisiMap[pid] = { pid, ad: String(p.ad ?? '').trim(), fis: 0, ciro: 0, subeler: new Set() };
              kisiMap[pid].fis += sayi(p.fis_sayisi);
              kisiMap[pid].ciro += sayi(p.ciro);
              kisiMap[pid].subeler.add(sad);
              if (!kisiMap[pid].ad) kisiMap[pid].ad = String(p.ad ?? '').trim();
            });
          });
          const kisiler = Object.values(kisiMap).sort((a, b) => b.ciro - a.ciro);
          if (kisiler.length === 0) return null;
          // "Sayısal ad" = Evo isim vermemiş, elimizde yalnız ID var
          const isimsiz = kisiler.filter((k) => /^\d+$/.test(k.ad) || !k.ad);
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginTop: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12, flexWrap: 'wrap',
              }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                  👤 Kim sattı · {tarihKisa(satisGun)}
                </span>
                <span style={{ fontSize: 11, color: isimsiz.length ? R.amber : R.not2 }}>
                  {kisiler.length} kasiyer
                  {isimsiz.length > 0 ? ` · ${isimsiz.length} tanesi isimsiz` : ' · hepsi tanımlı'}
                </span>
                <button disabled={evoSyncMesgul} onClick={evoIsimSync} style={{
                  padding: '6px 13px', borderRadius: 9, cursor: evoSyncMesgul ? 'wait' : 'pointer',
                  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.metin2,
                  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                }}>{evoSyncMesgul ? '⏳ taranıyor…' : '🔄 İsimleri Evo\'dan tazele'}</button>
              </div>

              <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                {kisiler.map((k) => {
                  const bilinmiyor = /^\d+$/.test(k.ad) || !k.ad;
                  const duzenlemede = evoIsim?.personel_id === k.pid;
                  if (duzenlemede) {
                    return (
                      <div key={k.pid} style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 11,
                        background: R.girinti, border: `1px solid ${R.bakirAcik}66`,
                      }}>
                        <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2 }}>#{k.pid}</span>
                        <input autoFocus value={evoIsim.ad} disabled={evoMesgul} placeholder="Personel adı…"
                          onChange={(e) => setEvoIsim((p) => ({ ...p, ad: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') evoIsimKaydet();
                            if (e.key === 'Escape') setEvoIsim(null);
                          }}
                          style={{
                            width: 130, padding: '5px 9px', borderRadius: 8, fontSize: 12, fontFamily: 'inherit',
                            border: `1px solid ${R.bakirAcik}`, background: R.zemin, color: R.krem, outline: 'none',
                          }} />
                        <button disabled={evoMesgul} onClick={evoIsimKaydet} style={{
                          padding: '5px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                          background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                          fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                        }}>{evoMesgul ? '…' : '✓'}</button>
                        <button disabled={evoMesgul} onClick={() => setEvoIsim(null)} style={{
                          padding: '5px 8px', borderRadius: 8, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.metin2, fontSize: 11, fontFamily: 'inherit',
                        }}>✕</button>
                      </div>
                    );
                  }
                  return (
                    <div key={k.pid} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 11,
                      background: R.girinti,
                      border: bilinmiyor ? `1px dashed ${R.amber}66` : `1px solid ${R.cizgi3}`,
                    }}>
                      <b style={{ fontSize: 12.5, color: bilinmiyor ? R.not : R.krem }}>
                        {bilinmiyor ? `#${k.ad || k.pid}` : k.ad}
                      </b>
                      {bilinmiyor && (
                        <button onClick={() => setEvoIsim({ personel_id: k.pid, ad: '' })} style={{
                          padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                          border: `1px solid ${R.amber}55`, background: `${R.amber}18`,
                          color: R.amber, fontSize: 10.5, fontWeight: 700,
                        }}>isim gir</button>
                      )}
                      <span style={{ fontSize: 11.5, color: R.not2, fontFamily: F.mono }}>
                        {k.fis} fiş · {fmt(k.ciro)}
                      </span>
                      {[...k.subeler].length === 1 && (
                        <span style={{ fontSize: 10.5, color: R.not2 }}>· {[...k.subeler][0]}</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 11, lineHeight: 1.6 }}>
                {isimsiz.length > 0 ? (
                  <>Evo bu kasiyerlerin adını vermiyor — genelde <b>ortak kasa hesabı</b> kullanıldığında
                  olur. Verdiğin isim ID'ye kalıcı bağlanır; sonraki günlerde de bu adla görünür.</>
                ) : (
                  <>Kasiyer isimleri Evo'dan geliyor. Bu tablo satış sahipliğini gösterir;
                  personel puan defteri ayrı bir motordur.</>
                )}
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: KASA TESLİM ════════════════════════════
  if (gorunum === 'kasa') {
    if (teslimHata) return <HataBandi mesaj={teslimHata} onTekrar={teslimYukle} />;
    if (teslimler == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const bugunku = teslimler.filter((t) => String(t.tarih || '').slice(0, 10) === bugun);
    const ara = teslimler.filter((t) => t.teslim_turu === 'ara');
    const gunSonu = teslimler.filter((t) => t.teslim_turu === 'gun_sonu');
    const toplam = (rows) => rows.reduce((s, t) => s + sayi(t.tutar), 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün teslim', deger: `${bugunku.length} kayıt`, alt: fmt(toplam(bugunku)), renk: bugunku.length > 0 ? R.yesil : R.krem },
          { etiket: 'Bu ay ara teslim', deger: String(ara.length), alt: fmt(toplam(ara)) },
          { etiket: 'Bu ay gün sonu', deger: String(gunSonu.length), alt: fmt(toplam(gunSonu)) },
          { etiket: 'Bu ay toplam', deger: fmt(toplam(teslimler)), alt: `${teslimler.length} teslim kaydı` },
        ]} />
        {/* PARA YOLDA DUYUSU 2/6 (2026-07-29): "teslim bekleyen" artık uydurma
            değil TÜRETİLMİŞ veri — kapanış cevap_ts ↔ gun_sonu teslim eşlemesi. */}
        {paraYolda && sayi(paraYolda.kapanis_adet) > 0 && (
          <div style={{
            ...kartYuzey, padding: '16px 18px', marginBottom: 14,
            border: sayi(paraYolda.gecikmis_adet) > 0 ? `1px solid ${R.kirmizi}55` : kartYuzey.border,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                💸 Para yolda · son {sayi(paraYolda.kesit_gun)} gün
              </span>
              <span style={{ fontSize: 10.5, color: R.not2 }}>
                kapanış ↔ gün sonu teslimi eşlemesi · 18 saati aşan gecikmiş sayılır
              </span>
            </div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, marginBottom: sayi(paraYolda.bekleyen_adet) > 0 ? 11 : 0 }}>
              <span>Kapanış <b style={{ fontFamily: F.mono }}>{sayi(paraYolda.kapanis_adet)}</b></span>
              <span>teslimle eşleşen <b style={{ fontFamily: F.mono, color: R.yesil }}>{sayi(paraYolda.eslesen_adet)}</b></span>
              <span>bekleyen <b style={{ fontFamily: F.mono, color: sayi(paraYolda.bekleyen_adet) > 0 ? R.amber : R.yesil }}>{sayi(paraYolda.bekleyen_adet)}</b></span>
              <span>gecikmiş <b style={{ fontFamily: F.mono, color: sayi(paraYolda.gecikmis_adet) > 0 ? R.kirmizi : R.yesil }}>{sayi(paraYolda.gecikmis_adet)}</b></span>
              <span style={{ color: R.not2 }}>
                ort. kapanış→teslim {paraYolda.ort_teslim_saat != null ? `${paraYolda.ort_teslim_saat} sa` : '—'}
              </span>
            </div>
            {(paraYolda.bekleyenler || []).slice(0, 6).map((b, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5,
                padding: '8px 0', borderTop: i === 0 ? `1px solid ${R.cizgi2}` : 'none',
              }}>
                <span style={rozetHap(b.gecikmis ? R.kirmizi : R.amber)}>
                  {b.gecikmis ? 'gecikmiş' : 'yolda'}
                </span>
                <span style={{ fontWeight: 700, flex: 1 }}>{b.sube}</span>
                <span style={{ color: R.not2, fontSize: 11.5 }}>
                  {tarihKisa(b.tarih)} {b.kapanis_saat} kapanış · {b.gecen_saat != null ? `${Math.round(b.gecen_saat)} sa geçti` : ''}
                </span>
                {b.beklenen_tutar != null && (
                  <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(b.beklenen_tutar))}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* ── ZİNCİRİN 3. HALKASI: kasa → teslim → BANKA ──────────────────────
            Teslim tablosu paranın şubeden çıkışını gösteriyordu; bankaya girişi
            hiçbir yerde görünmüyordu. /banka-mutabakat ikisini karşılaştırır. */}
        {bankaMut && (() => {
          const teslim = sayi(bankaMut.donem_teslim);
          const yatan = sayi(bankaMut.donem_yatan);
          const fark = sayi(bankaMut.donem_fark);
          const elde = sayi(bankaMut.elde_nakit);
          const oran = teslim > 0 ? Math.min(100, Math.round((yatan / teslim) * 100)) : 0;
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12, flexWrap: 'wrap', gap: 8,
              }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                  🏦 Kasa → teslim → banka · {bankaMut.donem || 'bu ay'}
                </span>
                <button onClick={() => {
                  setBankaModal(true);
                  setBankaForm({ tarih: bugunISO(), tutar: '', yatiran_ad: '', aciklama: '' });
                  if (bankaListe == null) bankaYukle();
                }} style={{
                  padding: '7px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${R.bakir}55`, background: `${R.bakir}22`,
                  color: R.bakir, fontSize: 11.5, fontWeight: 700,
                }}>🏦 Banka yatırımı kaydet</button>
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12.5, marginBottom: 11 }}>
                <span>
                  Şubelerden teslim alınan <b style={{ fontFamily: F.mono }}>{fmt(teslim)}</b>
                  {/* Sunucu ARA ve KAPANIŞ teslimini ayrı gönderiyordu; ikisi
                      farklı iş: ara teslim gün içinde, kapanış gün sonunda. */}
                  {(sayi(bankaMut.teslim_ara) > 0 || sayi(bankaMut.teslim_kapanis) > 0) && (
                    <span style={{ color: R.not2 }}>
                      {' '}(kapanış {fmt(sayi(bankaMut.teslim_kapanis))} · ara {fmt(sayi(bankaMut.teslim_ara))})
                    </span>
                  )}
                </span>
                <span>bankaya yatan <b style={{ fontFamily: F.mono, color: R.yesil }}>{fmt(yatan)}</b>
                  <span style={{ color: R.not2 }}> · {sayi(bankaMut.yatan_adet)} kayıt</span></span>
                <span>fark <b style={{ fontFamily: F.mono, color: Math.abs(fark) > 0.5 ? R.amber : R.yesil }}>{fmt(fark)}</b></span>
              </div>

              {/* ŞUBE KIRILIMI — hangi şube ne kadar teslim etti. Sunucu
                  gönderiyordu, ekran yalnız toplamı gösteriyordu; fark çıkınca
                  "hangi şubeden" sorusu cevapsız kalıyordu. */}
              {Array.isArray(bankaMut.sube_teslim) && bankaMut.sube_teslim.length > 0 && (
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 11 }}>
                  {bankaMut.sube_teslim.map((s, i) => (
                    <span key={s.sube || i} style={{
                      padding: '5px 11px', borderRadius: 99, fontSize: 11.5,
                      background: R.girinti, border: `1px solid ${R.cizgi3}`, color: R.metin2,
                    }}>
                      {s.sube} <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(s.teslim))}</b>
                    </span>
                  ))}
                </div>
              )}

              {/* Kapsama çubuğu — dönem teslimin ne kadarı bankaya ulaşmış */}
              <div style={{ height: 7, borderRadius: 99, background: R.girinti, overflow: 'hidden', marginBottom: 11 }}>
                <div style={{
                  width: `${oran}%`, height: '100%',
                  background: oran >= 90 ? R.yesil : oran >= 50 ? R.bakirAcik : R.amber,
                }} />
              </div>

              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
                padding: '10px 13px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
              }}>
                <span style={{ fontSize: 12.5, color: R.metin2 }}>Elde / yolda nakit (kümülatif)</span>
                <b style={{ fontFamily: F.mono, fontSize: 15, color: elde > 0 ? R.amber : R.yesil }}>{fmt(elde)}</b>
                <span style={{ fontSize: 11, color: R.not2, flex: 1, minWidth: 200 }}>
                  bugüne kadar teslim alınan − bugüne kadar bankaya yatan
                </span>
              </div>

              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 10, lineHeight: 1.6 }}>
                Gösterge amaçlı: banka yatırımı <b>takip kaydıdır</b>, kasadan düşmez —
                para zaten teslim alınırken kasadan çıkmıştı. Buradaki fark "teslim alınıp
                henüz bankaya götürülmemiş nakit"tir, kasa açığı değildir.
              </div>
            </div>
          );
        })()}

        {/* Filtre hapları (şube + tür) — klasik ekranın filtreleri yerlileşti */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {[['', 'Tüm şubeler'], ...(subeler || []).map((s) => [String(s.id), s.ad])].map(([id, ad]) => (
            <div key={`s${id}`} onClick={() => setTeslimSube(id)} style={{
              padding: '5px 12px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              background: teslimSube === id ? `${R.bakir}22` : R.girinti,
              color: teslimSube === id ? R.bakir : R.not,
              border: `1px solid ${teslimSube === id ? `${R.bakir}55` : R.cizgi3}`,
            }}>{ad}</div>
          ))}
          <span style={{ width: 1, height: 18, background: R.cizgi3 }} />
          {[['', 'Hepsi'], ['ara', '🔄 ara'], ['gun_sonu', '🌙 gün sonu']].map(([id, ad]) => (
            <div key={`t${id}`} onClick={() => setTeslimTur(id)} style={{
              padding: '5px 12px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
              background: teslimTur === id ? `${R.bakir}22` : R.girinti,
              color: teslimTur === id ? R.bakir : R.not,
              border: `1px solid ${teslimTur === id ? `${R.bakir}55` : R.cizgi3}`,
            }}>{ad}</div>
          ))}
          <button onClick={() => { setAliciModal(true); if (alicilar == null) alicilariYukle(); }} style={{
            marginLeft: 'auto', padding: '7px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
            background: R.girinti, color: R.metin2, fontSize: 11.5, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer',
          }}>
            👤 Teslim alıcılarını yönet
          </button>
        </div>
        {(() => {
          const suzulmus = teslimler.filter((t) =>
            (!teslimSube || String(t.sube_id) === teslimSube) &&
            (!teslimTur || t.teslim_turu === teslimTur));
          return suzulmus.length === 0 ? (
            <BosDurum metin={teslimler.length === 0 ? 'Bu ay kasa teslim kaydı yok.' : 'Bu filtrede teslim kaydı yok.'} />
          ) : (
            <Tablo
              baslik="Kasa teslimleri · bu ay"
              not="teslim eden → alan; kayıt kasa iziyle doğar (yazma QR/şube akışında)"
              kolonlar={[
                { ad: 'Tarih' }, { ad: 'Şube' }, { ad: 'Tür' }, { ad: 'Teslim eden → alan' }, { ad: 'Tutar', sag: 1 },
              ]}
              satirlar={[...suzulmus]
                .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
                .slice(0, 40)
                .map((t, i) => ({
                  id: t.id || `t-${i}`,
                  hucreler: [
                    { v: tarihKisa(t.tarih), mono: true, renk: R.not },
                    { v: subeAd[String(t.sube_id)] || t.sube_adi || '—', kalin: true },
                    t.teslim_turu === 'gun_sonu'
                      ? { v: '🌙 gün sonu', rozet: R.mavi }
                      : { v: '🔄 ara', rozet: R.amber },
                    { v: `${t.teslim_eden_ad || '—'} → ${t.teslim_alan_ad || '—'}`, renk: R.metin2 },
                    { v: fmt(sayi(t.tutar)), mono: true, sag: true, kalin: true },
                  ],
                }))}
            />
          );
        })()}

        {/* ── TESLİM ALICI YÖNETİMİ (kadife modal — klasik CRUD yerlileşti) ── */}
        {bankaModal && bankaForm && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !bankaMesgul) { setBankaModal(false); setBankaForm(null); } }}
            style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 560, maxWidth: '96vw', maxHeight: '90vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Banka Yatırımı</div>
                <div style={{ fontSize: 11.5, color: R.not2 }}>kim, ne zaman, ne kadar yatırdı</div>
                <button onClick={() => { setBankaModal(false); setBankaForm(null); }} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{
                padding: '10px 13px', borderRadius: 11, marginBottom: 16, fontSize: 11.5, lineHeight: 1.6,
                background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.24)', color: R.metin2,
              }}>
                Bu kayıt <b>kasadan para düşürmez</b> — nakit zaten şubeden teslim alınırken
                kasadan çıkmıştı. Burası o paranın bankaya ulaştığının izi; mutabakat
                şeridindeki "elde/yolda nakit" bu kayıtlarla kapanır.
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={alanEtiket}>Yatırma tarihi</label>
                  <input type="date" value={bankaForm.tarih} disabled={bankaMesgul}
                    onChange={(e) => setBankaForm((f) => ({ ...f, tarih: e.target.value }))}
                    style={{ ...alanStil, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={alanEtiket}>Tutar (₺)</label>
                  <input inputMode="decimal" value={bankaForm.tutar} disabled={bankaMesgul} placeholder="orn. 45000"
                    onChange={(e) => setBankaForm((f) => ({ ...f, tutar: e.target.value }))}
                    style={{ ...alanStil, fontFamily: F.mono }} />
                </div>
              </div>
              <label style={alanEtiket}>Bankaya yatıran kişi</label>
              <input value={bankaForm.yatiran_ad} disabled={bankaMesgul} placeholder="orn. Merve Karabacak"
                onChange={(e) => setBankaForm((f) => ({ ...f, yatiran_ad: e.target.value }))}
                style={alanStil} />
              <label style={alanEtiket}>Açıklama (opsiyonel)</label>
              <input value={bankaForm.aciklama} disabled={bankaMesgul} placeholder="orn. Zafer + Köyceğiz hafta sonu teslimleri"
                onChange={(e) => setBankaForm((f) => ({ ...f, aciklama: e.target.value }))}
                style={alanStil} />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4, marginBottom: 18 }}>
                <button disabled={bankaMesgul} onClick={() => { setBankaModal(false); setBankaForm(null); }} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Kapat</button>
                <button disabled={bankaMesgul} onClick={bankaKaydet} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{bankaMesgul ? 'Kaydediliyor…' : '🏦 Kaydet'}</button>
              </div>

              <div style={{
                fontFamily: F.baslik, fontSize: 14, fontWeight: 600, marginBottom: 10,
                paddingTop: 14, borderTop: `1px solid ${R.cizgi2}`,
              }}>Son yatırımlar</div>
              {bankaListe == null ? (
                <div style={{ padding: '14px 0', textAlign: 'center', color: R.not, fontSize: 12.5 }}>Yükleniyor…</div>
              ) : bankaListe.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, textAlign: 'center', padding: '12px 0', lineHeight: 1.6 }}>
                  Henüz banka yatırımı kaydı yok — teslim alınan nakit tümüyle "elde" görünüyor.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {bankaListe.slice(0, 12).map((b) => (
                    <div key={b.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px',
                      borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <span style={{ fontFamily: F.mono, fontSize: 11.5, color: R.not, width: 62 }}>{tarihKisa(b.tarih)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700 }}>{b.yatiran_ad || '—'}</div>
                        {b.aciklama && (
                          <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{b.aciklama}</div>
                        )}
                      </div>
                      <span style={{ fontFamily: F.mono, fontSize: 13, fontWeight: 700 }}>{fmt(sayi(b.tutar))}</span>
                    </div>
                  ))}
                  {bankaListe.length > 12 && (
                    <div style={{ fontSize: 11, color: R.not2, textAlign: 'center', paddingTop: 4 }}>
                      … ve {bankaListe.length - 12} kayıt daha
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {aliciModal && (
          <div
            onClick={(e) => { if (e.target === e.currentTarget && !aliciMesgul) { setAliciModal(false); setAliciForm(null); } }}
            style={{
              position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
              backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div style={{ ...kartYuzey, width: 540, maxWidth: '96vw', maxHeight: '90vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Teslim Alıcıları</div>
                <div style={{ fontSize: 11.5, color: R.not2 }}>kasayı teslim alabilecek kişiler</div>
                <button onClick={() => { setAliciModal(false); setAliciForm(null); }} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>

              {alicilar == null ? (
                <div style={{ padding: '20px 0', textAlign: 'center', color: R.not, fontSize: 13 }}>Yükleniyor…</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                  {alicilar.length === 0 && (
                    <div style={{ fontSize: 12.5, color: R.not, textAlign: 'center', padding: '12px 0' }}>
                      Kayıtlı teslim alıcısı yok — aşağıdan ekleyin.
                    </div>
                  )}
                  {alicilar.map((a) => (
                    <div key={a.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                      borderRadius: 12, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{a.ad}</div>
                        <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>
                          {a.unvan || '—'}{a.sube_adi ? ` · ${a.sube_adi}` : ''}
                        </div>
                      </div>
                      <button onClick={() => setAliciForm({ id: a.id, ad: a.ad || '', unvan: a.unvan || '', sube_id: a.sube_id || '' })} style={{
                        padding: '6px 11px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                      }}>Düzenle</button>
                      {aliciPasifSor === String(a.id) ? (
                        <>
                          <button disabled={aliciMesgul} onClick={() => aliciPasife(a.id)} style={{
                            padding: '6px 11px', borderRadius: 9, border: 'none', cursor: 'pointer',
                            background: `${R.kirmizi}22`, color: R.kirmizi, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                          }}>Eminim</button>
                          <button onClick={() => setAliciPasifSor('')} style={{
                            padding: '6px 9px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                            background: 'transparent', color: R.metin2, fontSize: 11.5, fontFamily: 'inherit',
                          }}>Vazgeç</button>
                        </>
                      ) : (
                        <button onClick={() => setAliciPasifSor(String(a.id))} style={{
                          padding: '6px 11px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                          background: 'transparent', color: R.not, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                        }}>Pasife al</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {aliciForm ? (
                <div style={{ padding: '14px 16px', borderRadius: 12, background: R.girinti, border: `1px solid ${R.bakir}44` }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: R.bakir, marginBottom: 12 }}>
                    {aliciForm.id ? 'Alıcıyı düzenle' : 'Yeni teslim alıcısı'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <label style={alanEtiket}>Ad *</label>
                      <input value={aliciForm.ad} onChange={(e) => setAliciForm((f) => ({ ...f, ad: e.target.value }))} style={alanStil} />
                    </div>
                    <div>
                      <label style={alanEtiket}>Unvan</label>
                      <input value={aliciForm.unvan} onChange={(e) => setAliciForm((f) => ({ ...f, unvan: e.target.value }))}
                        placeholder="örn. muhasebe" style={alanStil} />
                    </div>
                    <div>
                      <label style={alanEtiket}>Şube (isteğe bağlı)</label>
                      <select value={aliciForm.sube_id} onChange={(e) => setAliciForm((f) => ({ ...f, sube_id: e.target.value }))} style={alanStil}>
                        <option value="">Tüm şubeler</option>
                        {(subeler || []).map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                    <button disabled={aliciMesgul} onClick={() => setAliciForm(null)} style={{
                      padding: '8px 15px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                    <button disabled={aliciMesgul} onClick={aliciKaydet} style={{
                      padding: '8px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>
                      {aliciMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setAliciForm({ ad: '', unvan: '', sube_id: '' })} style={{
                  padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                }}>
                  + Yeni alıcı ekle
                </button>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: ANLIK GİDER ════════════════════════════
  if (gorunum === 'gider') {
    if (giderHata) return <HataBandi mesaj={giderHata} onTekrar={giderYukle} />;
    if (giderler == null) return <Yukleniyor />;
    const bugun = bugunISO();
    const bugunku = giderler.filter((g) => String(g.tarih || '').slice(0, 10) === bugun);
    const toplam = (rows) => rows.reduce((s, g) => s + sayi(g.tutar), 0);
    const enBuyuk = [...giderler].sort((a, b) => sayi(b.tutar) - sayi(a.tutar))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugünkü anlık gider', deger: fmt(toplam(bugunku)), alt: `${bugunku.length} kayıt`, renk: bugunku.length > 0 ? R.amber : R.krem },
          { etiket: 'Bu ay toplam', deger: fmt(sayi(giderOzet?.toplam) || toplam(giderler)), alt: 'plan dışı harcama' },
          { etiket: 'Kayıt sayısı', deger: String(giderler.length), alt: 'bu ay' },
          { etiket: 'En büyük kalem', deger: enBuyuk ? fmt(sayi(enBuyuk.tutar)) : '—', alt: enBuyuk ? String(enBuyuk.aciklama || '').slice(0, 26) : 'kayıt yok' },
        ]} />
        <div style={{ display: 'flex', gap: 9, marginBottom: 14 }}>
          <KopruButon birincil ad="+ Anlık gider gir" onTikla={giderFormAc} />
        </div>
        {giderler.length === 0 ? (
          <BosDurum metin="Bu ay anlık gider kaydı yok — plan dışı harcama girilmemiş." />
        ) : (
          <Liste
            satirlar={[...giderler]
              .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
              .slice(0, 40)
              .map((g, i) => ({
                id: g.id || `g-${i}`, _g: g,
                baslik: g.aciklama || g.kategori || 'Gider',
                alt: `${tarihKisa(g.tarih)} · ${g.kategori || '—'} · ${g.sube_adi || subeAd[String(g.sube_id)] || g.sube || '—'}${g.odeme_yontemi === 'kart' ? ' · 💳 kart' : ''}`,
                tutar: fmt(sayi(g.tutar)),
                tier: 'uyari',
                aksiyonlar: giderIptalSor === String(g.id) ? [
                  { ad: formMesgul ? '…' : 'Eminim — iptal et', birincil: true, onTikla: () => !formMesgul && giderSil(g) },
                  { ad: 'Vazgeç', onTikla: () => setGiderIptalSor('') },
                ] : [
                  { ad: 'İptal', onTikla: () => setGiderIptalSor(String(g.id)) },
                ],
              }))}
          />
        )}

        {/* ── YERLİ GİDER FORMU (kadife modal) ── */}
        {giderForm && (() => {
          const alan = (k, v) => setGiderForm((f) => ({ ...f, [k]: v }));
          const oneriIlk = Array.isArray(kartOneri?.oneriler) ? kartOneri.oneriler[0] : (Array.isArray(kartOneri) ? kartOneri[0] : null);
          return (
            <div
              onClick={(e) => { if (e.target === e.currentTarget && !formMesgul) setGiderForm(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
                backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
              }}
            >
              <div style={{ ...kartYuzey, width: 540, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Anlık Gider</div>
                  <div style={{ fontSize: 11.5, color: R.not2 }}>nakit: kasadan düşer · kart: borca eklenir</div>
                  <button onClick={() => !formMesgul && setGiderForm(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={alanEtiket}>Tarih</label>
                    <input type="date" value={giderForm.tarih} onChange={(e) => alan('tarih', e.target.value)}
                      style={{ ...alanStil, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Kategori</label>
                    <select value={giderForm.kategori} onChange={(e) => alan('kategori', e.target.value)} style={alanStil}>
                      {['Nakit Alım', 'Market', 'Fatura', 'Kargo', 'Yemek', 'Yakıt', 'Bakım', 'Diğer'].map((k) => <option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={alanEtiket}>Tutar (₺) *</label>
                    <input type="number" value={giderForm.tutar} onChange={(e) => alan('tutar', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Şube</label>
                    <select value={giderForm.sube} onChange={(e) => alan('sube', e.target.value)} style={alanStil}>
                      {['MERKEZ', 'TEMA', 'ZAFER', 'ALSANCAK', 'KOYCEGIZ'].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={alanEtiket}>Açıklama</label>
                    <input value={giderForm.aciklama} onChange={(e) => alan('aciklama', e.target.value)} style={alanStil} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Tedarikçi (varsa)</label>
                    <input value={giderForm.tedarikci} onChange={(e) => alan('tedarikci', e.target.value)}
                      placeholder="cari eşleşme için" style={alanStil} />
                  </div>
                </div>

                {/* Ödeme yöntemi */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  {[['nakit', '💵 Nakit — kasadan'], ['kart', '💳 Kart — borca yaz']].map(([y, ad]) => (
                    <div key={y} onClick={() => {
                      alan('odeme_yontemi', y);
                      if (y === 'kart') kartOneriGetir(giderForm.tutar);
                    }} style={{
                      padding: '8px 15px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                      border: `1px solid ${giderForm.odeme_yontemi === y ? R.bakir : R.cizgi3}`,
                      color: giderForm.odeme_yontemi === y ? R.bakir : R.metin2,
                      background: giderForm.odeme_yontemi === y ? 'rgba(217,154,78,.14)' : 'transparent',
                    }}>
                      {ad}
                    </div>
                  ))}
                  {giderForm.odeme_yontemi === 'kart' && (
                    <select value={giderForm.kart_id} onChange={(e) => alan('kart_id', e.target.value)}
                      style={{ ...alanStil, width: 'auto', minWidth: 180 }}>
                      <option value="">Kart seçin *</option>
                      {kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad || k.kart_adi || k.banka}</option>)}
                    </select>
                  )}
                </div>
                {giderForm.odeme_yontemi === 'kart' && oneriIlk && (
                  <div style={{ fontSize: 11.5, color: R.not, marginTop: 8 }}>
                    💡 Önerilen kart: <strong style={{ color: R.bakir }}>{oneriIlk.ad || oneriIlk.kart_adi || '—'}</strong>
                    {oneriIlk.neden ? ` — ${oneriIlk.neden}` : ''}
                  </div>
                )}

                {giderDup && (
                  <div style={{
                    marginTop: 14, padding: '13px 16px', borderRadius: 12,
                    background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`,
                  }}>
                    <div style={{ fontSize: 12.5, color: R.kirmizi, fontWeight: 700 }}>⚠ Benzer kayıt var</div>
                    <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.55 }}>{giderDup}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button disabled={formMesgul} onClick={() => giderKaydet(true)} style={{
                        padding: '7px 13px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                      }}>Yine de kaydet</button>
                      <button onClick={() => setGiderDup('')} style={{
                        padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                      }}>Vazgeç</button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <button disabled={formMesgul} onClick={() => setGiderForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>İptal</button>
                  <button disabled={formMesgul || giderDup !== ''} onClick={() => giderKaydet(false)} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: giderDup !== '' ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                    color: giderDup !== '' ? R.not : '#1C1309', fontSize: 12.5, fontWeight: 700,
                    fontFamily: 'inherit', cursor: giderDup !== '' ? 'default' : 'pointer',
                  }}>
                    {formMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DIŞ KAYNAK ═════════════════════════════
  if (gorunum === 'diskaynak') {
    if (dkHata) return <HataBandi mesaj={dkHata} onTekrar={() => dkYukle(dkAy)} />;
    if (diskaynak == null) return <Yukleniyor />;
    const buAy = bugunISO().slice(0, 7);
    const gecenAy = gunEkle(buAy + '-01', -1).slice(0, 7);
    const toplam = diskaynak.reduce((s, r) => s + sayi(r.tutar), 0);
    const enBuyuk = [...diskaynak].sort((a, b) => sayi(b.tutar) - sayi(a.tutar))[0];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Dönem dış geliri', deger: fmt(toplam), alt: `${diskaynak.length} kayıt · ciro dışı`, renk: R.yesil },
          { etiket: 'En büyük kayıt', deger: enBuyuk ? fmt(sayi(enBuyuk.tutar)) : '—', alt: enBuyuk ? String(enBuyuk.aciklama || '').slice(0, 26) : '—' },
          { etiket: 'Dönem', deger: dkAy, alt: 'aşağıdan değiştir' },
          { etiket: 'Not', deger: 'kasaya işlenir', alt: 'ciro istatistiklerine karışmaz' },
        ]} />
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[[buAy, 'Bu ay'], [gecenAy, 'Geçen ay']].map(([a, ad]) => (
            <div
              key={a}
              onClick={() => { setDkAy(a); dkYukle(a); }}
              style={{
                padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                background: dkAy === a ? `${R.bakir}22` : R.girinti,
                color: dkAy === a ? R.bakir : R.not,
                border: `1px solid ${dkAy === a ? `${R.bakir}55` : R.cizgi3}`,
              }}
            >
              {ad}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 9, marginBottom: 14 }}>
          <KopruButon birincil ad="+ Gelir ekle" onTikla={() => {
            setDkDup('');
            setDkForm({ tarih: bugunISO(), kategori: 'Aile Desteği', tutar: '', aciklama: '' });
          }} />
        </div>
        {diskaynak.length === 0 ? (
          <BosDurum metin="Bu dönemde dış kaynak geliri kaydı yok." />
        ) : (
          <Liste
            satirlar={[...diskaynak]
              .sort((a, b) => String(b.tarih).localeCompare(String(a.tarih)))
              .slice(0, 40)
              .map((r, i) => ({
                id: r.id || `d-${i}`, _r: r,
                baslik: r.aciklama || r.kategori || 'Gelir',
                alt: `${tarihKisa(r.tarih)} · ${r.kategori || '—'} · ${r.durum === 'aktif' ? 'işlendi' : (r.durum || '—')}`,
                tutar: fmt(sayi(r.tutar)),
                tier: 'olumlu',
                aksiyonlar: dkIptalSor === String(r.id) ? [
                  { ad: formMesgul ? '…' : 'Eminim — kasadan düş', birincil: true, onTikla: () => !formMesgul && dkSil(r.id) },
                  { ad: 'Vazgeç', onTikla: () => setDkIptalSor('') },
                ] : [
                  { ad: 'İptal', onTikla: () => setDkIptalSor(String(r.id)) },
                ],
              }))}
          />
        )}

        {/* ── YERLİ DIŞ KAYNAK FORMU ── */}
        {dkForm && (() => {
          const alan = (k, v) => setDkForm((f) => ({ ...f, [k]: v }));
          return (
            <div
              onClick={(e) => { if (e.target === e.currentTarget && !formMesgul) setDkForm(null); }}
              style={{
                position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
                backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
              }}
            >
              <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>Dış Kaynak Geliri</div>
                  <div style={{ fontSize: 11.5, color: R.not2 }}>ciro dışı — kasaya eklenir</div>
                  <button onClick={() => !formMesgul && setDkForm(null)} style={{
                    marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                    fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                  }}>✕</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <label style={alanEtiket}>Tarih</label>
                    <input type="date" value={dkForm.tarih} onChange={(e) => alan('tarih', e.target.value)}
                      style={{ ...alanStil, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Kategori</label>
                    <select value={dkForm.kategori} onChange={(e) => alan('kategori', e.target.value)} style={alanStil}>
                      {['Aile Desteği', 'Banka Kredisi', 'Ortak Sermayesi', 'Kişisel Borç', 'Devlet Desteği', 'Diğer Gelir'].map((k) => <option key={k}>{k}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={alanEtiket}>Tutar (₺) *</label>
                    <input type="number" value={dkForm.tutar} onChange={(e) => alan('tutar', e.target.value)}
                      style={{ ...alanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  <div>
                    <label style={alanEtiket}>Açıklama</label>
                    <input value={dkForm.aciklama} onChange={(e) => alan('aciklama', e.target.value)} style={alanStil} />
                  </div>
                </div>

                {dkDup && (
                  <div style={{
                    marginTop: 14, padding: '13px 16px', borderRadius: 12,
                    background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55`,
                  }}>
                    <div style={{ fontSize: 12.5, color: R.kirmizi, fontWeight: 700 }}>⚠ Benzer kayıt var</div>
                    <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.55 }}>{dkDup}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button disabled={formMesgul} onClick={() => dkKaydet(true)} style={{
                        padding: '7px 13px', borderRadius: 9, border: 'none', cursor: 'pointer',
                        background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                      }}>Yine de kaydet</button>
                      <button onClick={() => setDkDup('')} style={{
                        padding: '7px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                        background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                      }}>Vazgeç</button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                  <button disabled={formMesgul} onClick={() => setDkForm(null)} style={{
                    padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>İptal</button>
                  <button disabled={formMesgul || dkDup !== ''} onClick={() => dkKaydet(false)} style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: dkDup !== '' ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
                    color: dkDup !== '' ? R.not : '#1C1309', fontSize: 12.5, fontWeight: 700,
                    fontFamily: 'inherit', cursor: dkDup !== '' ? 'default' : 'pointer',
                  }}>
                    {formMesgul ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
