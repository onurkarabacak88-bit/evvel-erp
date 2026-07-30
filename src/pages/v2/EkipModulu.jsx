// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Personel & Vardiya modülü (7 görünüm, en geniş modül)
//
// Tasarım: ICERIK → ekip.kadro / vardiya / maas / gorev / takip / basvuru / pinqr
//
// ⚠️ MAAŞ ÇEKİRDEĞİNE DOKUNULMAZ: hesap `maas_service.py`, avans `avans_service.py`
// tek merkezdedir. Bu modül YALNIZ OKUR — bordro onayı/ödemesi mevcut Personel
// ekranından yapılır (guard'lar orada). Vardiya ataması da masaüstünden YAZILMAZ;
// ızgara salt-okurdur, atama planlama ekranından/şube panelinden yapılır.
//
// Veri uçları (hepsi salt-okur):
//   /personel?aktif=true                → kadro
//   /vardiya/v2/hafta-sube-tablo        → haftalık ızgara (şube × 7 gün)
//   /personel-aylik?yil=&ay=            → bordro (brüt, fazla mesai, avans, net, aşama)
//   /avans/ozet                         → avans toplamı
//   /gorev/ozet?tarih=                  → görev tamamlanma (şube × vardiya tipi)
//   /gorev/vardiya-takip?yil=&ay=       → giriş-çıkış, gecikme, fazla mesai
//   /is-basvurusu + /is-basvurusu/ozet  → başvurular
//   /sube-panel/merkez/personel-panel-pin → panel PIN durumu (PERSONEL bazlı)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, VardiyaIzgara } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const HAFTA = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

// ⚠️ Tarih tuzağı için bkz. TasarimV2.jsx — gün aritmetiği UTC'de yapılır.
const isoBugun = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isoEkle = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const haftaGunu = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
/** Verilen günün içinde bulunduğu haftanın pazartesisi. */
const pazartesiBul = (iso) => {
  const g = haftaGunu(iso);
  return isoEkle(iso, g === 0 ? -6 : 1 - g);
};
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

/** başlangıç tarihinden bugüne kıdem (ay). */
const kidemAy = (bas) => {
  if (!bas) return null;
  const b = new Date(String(bas).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  const n = new Date(isoBugun() + 'T00:00:00Z');
  return Math.max(0, (n.getUTCFullYear() - b.getUTCFullYear()) * 12 + (n.getUTCMonth() - b.getUTCMonth()));
};

/** Bordro aşaması → rozet rengi (tasarımdaki onaylı/taslak/ödendi dili). */
const ASAMA_RENK = { odendi: R.mavi, onayli: R.yesil, onay_bekliyor: R.amber, taslak: R.amber };
// DB slug'ı ekranda ham gösterilmez (düz-dil kuralı): 'onayli' → 'onaylı'.
const ASAMA_AD = { odendi: 'ödendi', onayli: 'onaylı', onay_bekliyor: 'onay bekliyor', taslak: 'taslak' };
const asamaAd = (d) => ASAMA_AD[d] || trKucuk(d) || 'taslak';

/** Çalışma türü slug'ı da ham gösterilmez: 'surekli' → 'sürekli'. */
const TUR_AD = { surekli: 'sürekli', part: 'part-time', gunluk: 'günlük', stajyer: 'stajyer' };
const turAd = (t) => TUR_AD[t] || trKucuk(t) || '—';

/** Sürekli personelde aylık ücret, part-time'da saatlik ücret gösterilir. */
// Yerli form stilleri (köprü kaldırma turu)
const vpOk = {
  width: 26, height: 26, borderRadius: 8, border: `1px solid ${R.cizgi3}`,
  background: R.girinti, color: R.metin2, fontSize: 13, cursor: 'pointer',
  fontFamily: 'inherit', lineHeight: 1,
};
const rozetHapV = {
  padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
};
const ekAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const ekEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

const ucretMetni = (p) => (sayi(p.maas) > 0
  ? fmt(sayi(p.maas))
  : sayi(p.saatlik_ucret) > 0 ? `${fmt(p.saatlik_ucret)}/sa` : '—');

export default function EkipModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [personel, setPersonel] = useState([]);
  // ── YERLİ PERSONEL CRUD (köprü kaldırma turu, 2026-07-30) ─────────────────
  // Klasik Personel.jsx sözleşmesi aynen. Bordro/maaş ödemesi ve vardiya
  // planlama BİLEREK taşınmadı (maaş guard'lı akış + 5338 satırlık planlayıcı).
  const [pForm, setPForm] = useState(null);      // {duzenleId?, ad_soyad, gorev, ...}
  const [pMesgul, setPMesgul] = useState(false);
  const [cikisForm, setCikisForm] = useState(null);  // {id, ad, neden}
  const [subeListe, setSubeListe] = useState([]);
  // ── DERİN TAKİP (köprü kaldırma turu, 2026-07-30) ─────────────────────────
  // Klasik PersonelVardiyaTakip'in iki bloğu: izin alacağı (borçlu hafta ↔
  // verilen izin) ve o gün vardiya dışı görünen girişler.
  const [izin, setIzin] = useState(null);
  const [vardiyaDisi, setVardiyaDisi] = useState(null);
  // ── PERSONEL DENETİMİ (ops-merkez P2 sekmeleri, 2026-07-30) ───────────────
  // davranış analizi · puan defteri · geç kalma · kasa açık analizi + kasiyer karne
  const [pdSekme, setPdSekme] = useState('davranis');
  const [pdDavranis, setPdDavranis] = useState(null);
  const [pdPuan, setPdPuan] = useState(null);
  const [pdGec, setPdGec] = useState(null);
  const [pdKasa, setPdKasa] = useState(null);
  const [pdKarne, setPdKarne] = useState(null);
  const [pdHata, setPdHata] = useState('');
  // ── YERLİ VARDİYA PLANLAYICI (köprü kaldırma turu, 2026-07-30) ────────────
  // Klasik VardiyaPlanlamaV2 (5338 satır) çekirdeği: gün planı + atama/sil +
  // çakışma kontrolü. Sürükle-bırak yerine TIKLA-ATA (dokunmatikte de çalışır).
  // Uçlar aynen: /vardiya/v2/gun · /assign · /atama/check · /atama/{id} DELETE ·
  // /gun-kopyala · /gun-temizle
  const [vpTarih, setVpTarih] = useState(() => isoBugun());
  const [vpGun, setVpGun] = useState(null);
  const [vpHata, setVpHata] = useState('');
  const [vpMesgul, setVpMesgul] = useState('');
  const [vpAtaModal, setVpAtaModal] = useState(null);   // {slot, subeAd, personelId, uyari, override}
  const [vpKopyaModal, setVpKopyaModal] = useState(null);
  const [hafta, setHafta] = useState(null);
  const [bordro, setBordro] = useState([]);
  const [avans, setAvans] = useState(null);
  const [gorevOzet, setGorevOzet] = useState([]);
  const [takip, setTakip] = useState([]);
  const [basvurular, setBasvurular] = useState([]);
  const [basvuruOzet, setBasvuruOzet] = useState(null);
  const [pinler, setPinler] = useState([]);

  const bugun = isoBugun();
  const buYil = Number(bugun.slice(0, 4));
  const buAy = Number(bugun.slice(5, 7));
  const pazartesi = pazartesiBul(bugun);

  // Dönem seçimi (sahip isteği 2026-07-29): maaş/takip AY, görev GÜN gezinir —
  // "bu aya sabit" sınırlaması kalktı; geçmiş bordro/takip kadifede görünür.
  const [donem, setDonem] = useState({ yil: buYil, ay: buAy });
  const [gorevTarih, setGorevTarih] = useState(bugun);
  const yil = donem.yil;
  const ay = donem.ay;
  const [donemYukleniyor, setDonemYukleniyor] = useState(false);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/personel?aktif=true').catch(() => []),
      api(`/vardiya/v2/hafta-sube-tablo?pazartesi=${pazartesi}`).catch(() => null),
      api(`/personel-aylik?yil=${donem.yil}&ay=${donem.ay}`).catch(() => []),
      api('/avans/ozet').catch(() => null),
      api(`/gorev/ozet?tarih=${gorevTarih}`).catch(() => []),
      api(`/gorev/vardiya-takip?yil=${donem.yil}&ay=${donem.ay}`).catch(() => null),
      api('/is-basvurusu?limit=200').catch(() => []),
      api('/is-basvurusu/ozet').catch(() => null),
      api('/sube-panel/merkez/personel-panel-pin').catch(() => []),
      api('/gorev/izin-alacagi').catch(() => null),
      api(`/gorev/yoklama?tarih=${bugun}&sadece_vardiya_disi=true`).catch(() => []),
    ]).then(([p, h, b, av, go, vt, bs, bo, pin, iz, vd]) => {
      setIzin(iz);
      setVardiyaDisi(Array.isArray(vd) ? vd : (vd?.kayitlar || []));
      setPersonel(Array.isArray(p) ? p : []);
      setHafta(h);
      setBordro(Array.isArray(b) ? b : []);
      setAvans(av);
      setGorevOzet(Array.isArray(go) ? go : []);
      setTakip(Array.isArray(vt) ? vt : (vt?.personeller || []));
      setBasvurular(Array.isArray(bs) ? bs : (bs?.basvurular || []));
      setBasvuruOzet(bo);
      setPinler(Array.isArray(pin) ? pin : []);
      if (!(Array.isArray(p) && p.length)) setHata('Personel verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
  };

  useEffect(yukle, []);

  const vpYukle = (tarih) => {
    setVpHata('');
    const t = tarih || vpTarih;
    api(`/vardiya/v2/gun?tarih=${t}`)
      .then((d) => setVpGun(d || {}))
      .catch((e) => setVpHata(e?.message || ''));
  };

  const vpGunDegis = (n) => {
    const y = isoEkle(vpTarih, n);
    setVpTarih(y);
    vpYukle(y);
  };

  /** Atama kapısı: önce check (çakışma=kesin engel), sonra assign. */
  const vpAta = async (zorla = false) => {
    const m = vpAtaModal;
    if (!m?.personelId) { onToast?.('Personel seçin'); return; }
    setVpMesgul('ata');
    try {
      const body = {
        personel_id: m.personelId, slot_id: m.slot.id, tarih: vpTarih,
        override: zorla, otomatik_saat_cozumu: true,
      };
      if (!zorla) {
        const c = await api('/vardiya/v2/atama/check', { method: 'POST', body });
        const uyarilar = Array.isArray(c?.uyarilar) ? c.uyarilar : [];
        if (c?.cakisma_var === true) {
          setVpAtaModal((f) => ({ ...f, uyari: 'Bu personel aynı saatte başka bir slotta atanmış — çakışma engeldir.', override: false }));
          setVpMesgul('');
          return;
        }
        if (c?.override_gerekir === true || uyarilar.length) {
          const metin = uyarilar.map((u) => (typeof u === 'string' ? u : (u.mesaj || u.aciklama || ''))).filter(Boolean).join(' · ');
          setVpAtaModal((f) => ({ ...f, uyari: metin || 'Bu atama için uyarı var.', override: true }));
          setVpMesgul('');
          return;
        }
      }
      await api('/vardiya/v2/assign', { method: 'POST', body });
      onToast?.('✓ Vardiya atandı');
      setVpAtaModal(null);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Atama yapılamadı');
    } finally {
      setVpMesgul('');
    }
  };

  const vpAtamaSil = async (atamaId, ad) => {
    setVpMesgul(atamaId);
    try {
      await api(`/vardiya/v2/atama/${atamaId}`, { method: 'DELETE' });
      onToast?.(`${ad || 'Atama'} kaldırıldı`);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Kaldırılamadı');
    } finally {
      setVpMesgul('');
    }
  };

  const vpGunTemizle = async () => {
    setVpMesgul('temizle');
    try {
      await api(`/vardiya/v2/gun-temizle?tarih=${vpTarih}`, { method: 'POST' });
      onToast?.(`${kisaTarih(vpTarih)} planı temizlendi`);
      setVpKopyaModal(null);
      vpYukle(vpTarih);
    } catch (e) {
      onToast?.(e?.message || 'Temizlenemedi');
    } finally {
      setVpMesgul('');
    }
  };

  const vpGunKopyala = async (hedef) => {
    if (!hedef) { onToast?.('Hedef gün seçin'); return; }
    setVpMesgul('kopyala');
    try {
      await api(`/vardiya/v2/gun-kopyala?kaynak=${vpTarih}&hedef=${hedef}&temizle=true`, { method: 'POST' });
      onToast?.(`${kisaTarih(vpTarih)} planı ${kisaTarih(hedef)} gününe kopyalandı`);
      setVpKopyaModal(null);
    } catch (e) {
      onToast?.(e?.message || 'Kopyalanamadı');
    } finally {
      setVpMesgul('');
    }
  };

  useEffect(() => {
    if (gorunum === 'vardiya') vpYukle(vpTarih);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum]);

  const pdYukle = () => {
    setPdHata('');
    const ym = `${donem.yil}-${String(donem.ay).padStart(2, '0')}`;
    api('/ops/personel-davranis-analiz?gun=45')
      .then((d) => setPdDavranis(d || {}))
      .catch((e) => setPdHata(e?.message || ''));
    api('/ops/sube-personel-puan')
      .then((d) => setPdPuan(d || {}))
      .catch(() => setPdPuan({}));
    api(`/ops/gec-kalan-personel?year_month=${ym}`)
      .then((d) => setPdGec(d || {}))
      .catch(() => setPdGec({}));
    api('/ops/kasa-acik-analiz?gun_sayi=30')
      .then((d) => setPdKasa(d || {}))
      .catch(() => setPdKasa({}));
    api('/ops/kasiyer-karne?gun=30')
      .then((d) => setPdKarne(Array.isArray(d?.karne) ? d.karne : []))
      .catch(() => setPdKarne([]));
  };

  useEffect(() => {
    if (gorunum === 'denetim') pdYukle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gorunum, donem.yil, donem.ay]);

  // ── personel formu (klasik Personel.jsx sözleşmesi) ────────────────────────
  const pFormAc = (p) => {
    setPForm(p ? {
      duzenleId: p.id, ad_soyad: p.ad_soyad || '', gorev: p.gorev || '',
      calisma_turu: p.calisma_turu || 'surekli', maas: p.maas ?? '',
      saatlik_ucret: p.saatlik_ucret ?? '', yemek_ucreti: p.yemek_ucreti ?? '',
      yol_ucreti: p.yol_ucreti ?? '', sube_id: p.sube_id || '',
      baslangic_tarihi: String(p.baslangic_tarihi || '').slice(0, 10),
      telefon: p.telefon || '', notlar: p.notlar || '',
    } : {
      duzenleId: null, ad_soyad: '', gorev: '', calisma_turu: 'surekli', maas: '',
      saatlik_ucret: '', yemek_ucreti: '', yol_ucreti: '', sube_id: '',
      baslangic_tarihi: '', telefon: '', notlar: '',
    });
    if (!subeListe.length) api('/subeler').then((d) => setSubeListe(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const pKaydet = async () => {
    const f = pForm;
    if (!(f?.ad_soyad || '').trim()) { onToast?.('Ad soyad zorunlu'); return; }
    setPMesgul(true);
    try {
      const body = {
        ad_soyad: f.ad_soyad.trim(), gorev: f.gorev || null,
        calisma_turu: f.calisma_turu, maas: f.maas ? Number(f.maas) : 0,
        saatlik_ucret: f.saatlik_ucret ? Number(f.saatlik_ucret) : 0,
        yemek_ucreti: f.yemek_ucreti ? Number(f.yemek_ucreti) : 0,
        yol_ucreti: f.yol_ucreti ? Number(f.yol_ucreti) : 0,
        odeme_gunu: 1, sube_id: f.sube_id || null,
        baslangic_tarihi: f.baslangic_tarihi || null,
        notlar: f.notlar || null, telefon: (f.telefon || '').trim() || null,
      };
      if (f.duzenleId) await api(`/personel/${f.duzenleId}`, { method: 'PUT', body });
      else await api('/personel', { method: 'POST', body });
      onToast?.(f.duzenleId ? '✓ Personel güncellendi' : '✓ Personel eklendi');
      setPForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setPMesgul(false);
    }
  };

  const cikisYap = async () => {
    if (!cikisForm?.id) return;
    setPMesgul(true);
    try {
      await api(`/personel/${cikisForm.id}/cikis?neden=${encodeURIComponent(cikisForm.neden || '')}`, { method: 'POST' });
      onToast?.(`${cikisForm.ad} işten çıkış kaydı yapıldı`);
      setCikisForm(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Çıkış kaydedilemedi');
    } finally {
      setPMesgul(false);
    }
  };

  // Dönem/gün değişince yalnız İLGİLİ uçlar tazelenir — tam ekran yükleme yok.
  const ayDegistir = (d) => {
    setDonem(({ yil: y0, ay: a0 }) => {
      let a = a0 + d; let y = y0;
      if (a < 1) { a = 12; y -= 1; }
      if (a > 12) { a = 1; y += 1; }
      if (y > buYil || (y === buYil && a > buAy)) return { yil: y0, ay: a0 }; // geleceğe gitme
      setDonemYukleniyor(true);
      Promise.all([
        api(`/personel-aylik?yil=${y}&ay=${a}`).catch(() => []),
        api(`/gorev/vardiya-takip?yil=${y}&ay=${a}`).catch(() => null),
      ]).then(([b, vt]) => {
        setBordro(Array.isArray(b) ? b : []);
        setTakip(Array.isArray(vt) ? vt : (vt?.personeller || []));
        setDonemYukleniyor(false);
      });
      return { yil: y, ay: a };
    });
  };
  const gorevGunDegistir = (d) => {
    setGorevTarih((t0) => {
      const dt = new Date(t0 + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + d);
      const t = dt.toISOString().slice(0, 10);
      if (t > bugun) return t0; // geleceğe gitme
      setDonemYukleniyor(true);
      api(`/gorev/ozet?tarih=${t}`).catch(() => [])
        .then((go) => { setGorevOzet(Array.isArray(go) ? go : []); setDonemYukleniyor(false); });
      return t;
    });
  };

  /** ‹ dönem › gezgini — maaş/takip (ay) ve görev (gün) görünümlerinde. */
  const DonemSecici = ({ etiket, onGeri, onIleri, ileriKapali }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <button onClick={onGeri} style={{
        width: 30, height: 30, borderRadius: 9, border: `1px solid ${R.cizgi3}`,
        background: R.girinti, color: R.metin2, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer',
      }}>‹</button>
      <span style={{
        padding: '6px 14px', borderRadius: 99, fontSize: 12.5, fontWeight: 700,
        background: `${R.bakir}18`, color: R.bakir, border: `1px solid ${R.bakir}44`,
        fontFamily: F.mono, minWidth: 96, textAlign: 'center',
      }}>
        {donemYukleniyor ? '…' : etiket}
      </span>
      <button onClick={onIleri} disabled={ileriKapali} style={{
        width: 30, height: 30, borderRadius: 9, border: `1px solid ${R.cizgi3}`,
        background: R.girinti, color: ileriKapali ? R.not3 : R.metin2, fontSize: 14,
        fontFamily: 'inherit', cursor: ileriKapali ? 'default' : 'pointer', opacity: ileriKapali ? 0.5 : 1,
      }}>›</button>
      {ileriKapali && <span style={{ fontSize: 10.5, color: R.not3 }}>güncel dönem</span>}
    </div>
  );

  /** Vardiya takibindeki kişi bazlı toplamları personel id ile eşler. */
  const takipMap = useMemo(() => {
    const m = {};
    (takip || []).forEach(t => { m[String(t.personel_id)] = t; });
    return m;
  }, [takip]);

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Ekip verileri yükleniyor…</div>;
  }
  if (hata) {
    return (
      <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
        <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: R.kirmizi }}>{hata}</div>
        <button onClick={yukle} style={{
          marginTop: 16, padding: '10px 20px', borderRadius: 10, border: 'none',
          background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>Tekrar dene</button>
      </div>
    );
  }

  // ── ortak: personel dosyası çekmecesi ──────────────────────────────────────
  const personelAc = (p) => {
    const t = takipMap[String(p.id)] || {};
    const bd = bordro.find(x => String(x.personel_id) === String(p.id)) || {};
    const kd = kidemAy(p.baslangic_tarihi);
    onCekmece?.({
      tip: 'PERSONEL DOSYASI',
      baslik: p.ad_soyad,
      alt: `${p.gorev || 'görev girilmemiş'} · ${p.sube_adi || 'şube atanmamış'}`,
      kpi: [
        { etiket: 'Kıdem', deger: kd == null ? '—' : `${kd} ay` },
        { etiket: 'Bu ay saat', deger: t.toplam_planlanan_saat != null ? `${trSayi(t.toplam_planlanan_saat, 0)} sa` : '—' },
        { etiket: 'Fazla mesai', deger: t.toplam_fazla_mesai_saat ? `${trSayi(t.toplam_fazla_mesai_saat)} sa` : '—', renk: sayi(t.toplam_fazla_mesai_saat) > 0 ? R.kirmizi : R.krem },
        { etiket: 'Çalışma türü', deger: turAd(p.calisma_turu) },
      ],
      listeBaslik: 'Bu ay bordro',
      // ⚠️ Çekmece satır sözleşmesi: {ad, detay, tutar} — başka alan adı boş liste render eder.
      satirlar: [
        { ad: 'Ücret', detay: sayi(p.maas) > 0 ? 'aylık · sözleşme' : 'saatlik', tutar: ucretMetni(p) },
        { ad: 'Hesaplanan net', detay: bd.durum ? asamaAd(bd.durum) : 'kayıt yok', tutar: bd.hesaplanan_net != null ? fmt(bd.hesaplanan_net) : '—' },
        { ad: 'Avans mahsubu', detay: 'maaştan düşülen', tutar: fmt(sayi(bd.avans_mahsup)) },
        { ad: 'Gecikme', detay: 'bu ay toplam', tutar: t.toplam_gecikme_dk ? `${trSayi(t.toplam_gecikme_dk, 0)} dk` : '—' },
      ],
      not: kd != null && kd < 3
        ? 'Deneme süresinde — ilk 3 ay yakın takip edilir.'
        : 'Bordro hesabı maaş çekirdeğinden gelir; maaş onayı Maaş & Avans görünümünde.',
      aksiyonlar: [
        { ad: '✎ Bilgileri düzenle', birincil: true, onTikla: () => pFormAc(p) },
        { ad: 'İşten çıkış', onTikla: () => setCikisForm({ id: p.id, ad: p.ad_soyad, neden: '' }) },
      ],
    });
  };

  // ── personel formu + çıkış modalı (kadro görünümünde render edilir) ────────
  const personelModali = (
    <>
      {pForm && (() => {
        const alan = (k, v) => setPForm((f) => ({ ...f, [k]: v }));
        const partTime = pForm.calisma_turu === 'part_time';
        return (
          <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setPForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 560, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>
                  {pForm.duzenleId ? 'Personeli Düzenle' : 'Yeni Personel'}
                </div>
                <button onClick={() => !pMesgul && setPForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
                <div>
                  <label style={ekEtiket}>Ad soyad *</label>
                  <input value={pForm.ad_soyad} onChange={(e) => alan('ad_soyad', e.target.value)} style={ekAlanStil} />
                </div>
                <div>
                  <label style={ekEtiket}>Görev</label>
                  <input value={pForm.gorev} placeholder="barista, müdür…"
                    onChange={(e) => alan('gorev', e.target.value)} style={ekAlanStil} />
                </div>
                <div>
                  <label style={ekEtiket}>Çalışma türü</label>
                  <select value={pForm.calisma_turu} onChange={(e) => alan('calisma_turu', e.target.value)} style={ekAlanStil}>
                    <option value="surekli">Sürekli (aylık maaş)</option>
                    <option value="part_time">Part-time (saatlik)</option>
                  </select>
                </div>
                <div>
                  <label style={ekEtiket}>Şube</label>
                  <select value={pForm.sube_id} onChange={(e) => alan('sube_id', e.target.value)} style={ekAlanStil}>
                    <option value="">Merkez / atanmamış</option>
                    {subeListe.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                  </select>
                </div>
                <div>
                  <label style={ekEtiket}>{partTime ? 'Saatlik ücret (₺)' : 'Aylık maaş (₺)'}</label>
                  <input type="number" value={partTime ? pForm.saatlik_ucret : pForm.maas}
                    onChange={(e) => alan(partTime ? 'saatlik_ucret' : 'maas', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Başlangıç tarihi</label>
                  <input type="date" value={pForm.baslangic_tarihi} onChange={(e) => alan('baslangic_tarihi', e.target.value)}
                    style={{ ...ekAlanStil, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Yemek ücreti (₺)</label>
                  <input type="number" value={pForm.yemek_ucreti} onChange={(e) => alan('yemek_ucreti', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Yol ücreti (₺)</label>
                  <input type="number" value={pForm.yol_ucreti} onChange={(e) => alan('yol_ucreti', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={ekEtiket}>Telefon</label>
                  <input value={pForm.telefon} onChange={(e) => alan('telefon', e.target.value)}
                    style={{ ...ekAlanStil, fontFamily: F.mono }} />
                </div>
                <div>
                  <label style={ekEtiket}>Not</label>
                  <input value={pForm.notlar} onChange={(e) => alan('notlar', e.target.value)} style={ekAlanStil} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: R.not, marginTop: 12, lineHeight: 1.5 }}>
                Maaş ödemesi ve bordro onayı Maaş & Avans görünümünde — burada yalnız kadro bilgisi tutulur.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={pMesgul} onClick={() => setPForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>İptal</button>
                <button disabled={pMesgul} onClick={pKaydet} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{pMesgul ? 'Kaydediliyor…' : 'Kaydet'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {cikisForm && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !pMesgul) setCikisForm(null); }} style={{
          position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
          backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>İşten Çıkış</div>
              <button onClick={() => !pMesgul && setCikisForm(null)} style={{
                marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
              }}>✕</button>
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
              <b>{cikisForm.ad}</b> pasife alınacak; kadrodan çıkar, geçmiş bordro kayıtları korunur.
            </div>
            <label style={ekEtiket}>Çıkış nedeni</label>
            <input value={cikisForm.neden} placeholder="istifa, dönem sonu…"
              onChange={(e) => setCikisForm((f) => ({ ...f, neden: e.target.value }))} style={ekAlanStil} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button disabled={pMesgul} onClick={() => setCikisForm(null)} style={{
                padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              }}>Vazgeç</button>
              <button disabled={pMesgul} onClick={cikisYap} style={{
                padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: `${R.kirmizi}26`, color: R.kirmizi, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              }}>{pMesgul ? 'İşleniyor…' : 'Çıkışı kaydet'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // ── 8) PERSONEL DENETİMİ (ops-merkez P2) ──────────────────────────────────
  // Klasik Operasyon Merkezi'nin 4 personel sekmesi tek yerde — ÖNERİ-ONLY,
  // isim verir ama hüküm vermez (puan maaşa bağlanmaz kuralı korunur).
  if (gorunum === 'denetim') {
    if (pdHata) {
      return (
        <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center', border: `1px solid ${R.kirmizi}55` }}>
          <div style={{ fontSize: 13, color: R.kirmizi }}>Veri alınamadı — {pdHata}</div>
          <button onClick={pdYukle} style={{
            marginTop: 14, padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>🔄 Tekrar dene</button>
        </div>
      );
    }
    if (!pdDavranis) {
      return <div style={{ ...kartYuzey, padding: '40px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>Personel denetimi yükleniyor…</div>;
    }
    const davranis = Array.isArray(pdDavranis?.personel_ozet) ? pdDavranis.personel_ozet : [];
    const puanlar = Array.isArray(pdPuan?.personeller) ? pdPuan.personeller : [];
    const gecSatir = Array.isArray(pdGec?.satirlar) ? pdGec.satirlar : [];
    const kasaSatir = Array.isArray(pdKasa?.personeller) ? pdKasa.personeller
      : (Array.isArray(pdKasa?.satirlar) ? pdKasa.satirlar : []);
    const karne = Array.isArray(pdKarne) ? pdKarne : [];
    const ALT = [
      ['davranis', `👤 Davranış (${davranis.length})`],
      ['puan', `🏅 Puan (${puanlar.length})`],
      ['gec', `⏰ Geç kalma (${gecSatir.length})`],
      ['kasa', `💵 Kasa açığı (${kasaSatir.length})`],
    ];
    const enDusukPuan = puanlar.length ? puanlar.reduce((a, b) => (sayi(a.puan) <= sayi(b.puan) ? a : b)) : null;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen personel', deger: String(davranis.length), alt: 'son 45 gün davranış', renk: R.krem },
          { etiket: 'Kritik geç kalma', deger: String(sayi(pdGec?.kritik_personel_sayisi)), alt: `${sayi(pdGec?.gecikme_toplam_adet)} gecikme · eşik ${sayi(pdGec?.kritik_dk)} dk`, renk: sayi(pdGec?.kritik_personel_sayisi) ? R.amber : R.yesil },
          { etiket: 'En düşük puan', deger: enDusukPuan ? String(sayi(enDusukPuan.puan)) : '—', alt: enDusukPuan ? enDusukPuan.ad_soyad : 'veri yok', renk: enDusukPuan && sayi(enDusukPuan.puan) < 70 ? R.kirmizi : R.krem },
          { etiket: 'Kasa açığı olan', deger: String(kasaSatir.length), alt: 'son 30 gün', renk: kasaSatir.length ? R.kirmizi : R.yesil },
        ]} />

        <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}>
          {ALT.map(([id, ad]) => (
            <div key={id} onClick={() => setPdSekme(id)} style={{
              padding: '6px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${pdSekme === id ? R.bakir : R.cizgi3}`,
              color: pdSekme === id ? R.bakir : R.metin2,
              background: pdSekme === id ? 'rgba(217,154,78,.12)' : R.girinti,
            }}>{ad}</div>
          ))}
        </div>

        {pdSekme === 'davranis' && (davranis.length ? (
          <Tablo
            baslik="Davranış analizi · son 45 gün"
            not="gözlem toplamı — hüküm değil; puan maaşa bağlanmaz"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Vardiya', sag: true },
              { ad: 'Gecikme', sag: true }, { ad: 'Kasa farkı', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={davranis.slice(0, 40).map((x, i) => {
              const gec = sayi(x.gecikme_dk ?? x.toplam_gecikme_dk);
              const fark = sayi(x.kasa_fark ?? x.toplam_kasa_fark);
              return {
                id: x.personel_id || `d-${i}`,
                hucreler: [
                  { v: x.personel_ad || x.ad_soyad || '—', kalin: true },
                  { v: x.sube_adi || x.sube_ad || '—', renk: R.not },
                  { v: String(sayi(x.vardiya_sayisi ?? x.vardiya)), mono: true, sag: true },
                  { v: gec ? `${trSayi(gec, 0)} dk` : '—', mono: true, sag: true, renk: gec > 30 ? R.amber : R.not },
                  { v: fark ? fmt(fark) : '—', mono: true, sag: true, renk: fark ? R.kirmizi : R.not },
                  (gec > 30 || fark)
                    ? { v: 'izlemede', rozet: R.amber }
                    : { v: 'normal', rozet: R.yesil },
                ],
              };
            })}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.not }}>Davranış verisi yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Vardiya ve kasa kaydı biriktikçe analiz oluşur.</div>
          </div>
        ))}

        {pdSekme === 'puan' && (puanlar.length ? (
          <Tablo
            baslik="Puan defteri · lig tablosu"
            not="kural=VERİ; gece motoru hesaplar — puan maaşa/avansa BAĞLANMAZ"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Puan', sag: true }, { ad: 'Tamam', sag: true },
              { ad: 'Gecikti', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={[...puanlar]
              .sort((a, b) => sayi(b.puan) - sayi(a.puan))
              .slice(0, 40)
              .map((x, i) => ({
                id: x.personel_id || `p-${i}`,
                hucreler: [
                  { v: x.ad_soyad || '—', kalin: true },
                  { v: String(sayi(x.puan)), mono: true, sag: true, kalin: true, renk: sayi(x.puan) >= 90 ? R.yesil : sayi(x.puan) >= 70 ? R.amber : R.kirmizi },
                  { v: String(sayi(x.tamam)), mono: true, sag: true, renk: R.yesil },
                  { v: String(sayi(x.gecikti)), mono: true, sag: true, renk: sayi(x.gecikti) ? R.amber : R.not },
                  sayi(x.puan) >= 90
                    ? { v: 'örnek', rozet: R.yesil }
                    : sayi(x.puan) >= 70 ? { v: 'iyi', rozet: R.mavi } : { v: 'destek gerek', rozet: R.amber },
                ],
              }))}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.not }}>Puan verisi yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Görev tamamlama kayıtları biriktikçe puan oluşur.</div>
          </div>
        ))}

        {pdSekme === 'gec' && (gecSatir.length ? (
          <Tablo
            baslik={`Geç kalma · ${AY_KISA[ay - 1]} ${yil}`}
            not={`grace ${sayi(pdGec?.gecikme_dk)} dk · kritik eşik ${sayi(pdGec?.kritik_dk)} dk`}
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Gecikme adedi', sag: true },
              { ad: 'Toplam dk', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={gecSatir.slice(0, 40).map((x, i) => {
              const dk = sayi(x.toplam_gecikme_dk ?? x.gecikme_dk);
              const adet = sayi(x.gecikme_adet ?? x.adet);
              return {
                id: x.personel_id || `g-${i}`,
                hucreler: [
                  { v: x.ad_soyad || x.personel_ad || '—', kalin: true },
                  { v: x.sube_adi || x.sube_ad || '—', renk: R.not },
                  { v: String(adet), mono: true, sag: true },
                  { v: dk ? `${trSayi(dk, 0)} dk` : '—', mono: true, sag: true, renk: dk > 60 ? R.kirmizi : R.amber },
                  x.kritik
                    ? { v: 'kritik', rozet: R.kirmizi }
                    : { v: 'izlemede', rozet: R.amber },
                ],
              };
            })}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.yesil }}>Geç kalma kaydı yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Bu dönemde grace süresini aşan giriş yok.</div>
          </div>
        ))}

        {pdSekme === 'kasa' && (
          <>
            {kasaSatir.length ? (
              <Tablo
                baslik="Kasa açığı analizi · son 30 gün"
                not="kasa farkı olan vardiyalar — özensizlik ≠ açık (şüphe skoru ayrı)"
                kolonlar={[
                  { ad: 'Personel' }, { ad: 'Şube' }, { ad: 'Vardiya', sag: true },
                  { ad: 'Toplam fark', sag: true }, { ad: 'Durum' },
                ]}
                satirlar={kasaSatir.slice(0, 30).map((x, i) => {
                  const fark = sayi(x.toplam_fark ?? x.fark);
                  return {
                    id: x.personel_id || `k-${i}`,
                    hucreler: [
                      { v: x.ad_soyad || x.personel_ad || '—', kalin: true },
                      { v: x.sube_adi || x.sube_ad || '—', renk: R.not },
                      { v: String(sayi(x.vardiya_sayisi ?? x.adet)), mono: true, sag: true },
                      { v: fmt(fark), mono: true, sag: true, kalin: true, renk: fark < 0 ? R.kirmizi : R.yesil },
                      Math.abs(fark) > 500
                        ? { v: 'incele', rozet: R.kirmizi }
                        : { v: 'küçük fark', rozet: R.amber },
                    ],
                  };
                })}
              />
            ) : (
          <div style={{ ...kartYuzey, padding: '34px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.yesil }}>Kasa açığı yok</div>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 7 }}>Son 30 günde kasa farkı olan personel kaydı bulunmuyor.</div>
          </div>
        )}
            {karne.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <Tablo
                  baslik="Kasiyer karnesi · son 30 gün"
                  not="işlem hacmi ve doğruluk oranı"
                  kolonlar={[{ ad: 'Kasiyer' }, { ad: 'Vardiya', sag: true }, { ad: 'Temiz gün', sag: true }, { ad: 'Oran', sag: true }]}
                  satirlar={karne.slice(0, 20).map((x, i) => {
                    const vard = sayi(x.vardiya ?? x.vardiya_sayisi) || 1;
                    const temiz = sayi(x.temiz ?? x.temiz_gun);
                    return {
                      id: x.personel_id || `kr-${i}`,
                      hucreler: [
                        { v: x.ad_soyad || x.personel_ad || '—', kalin: true },
                        { v: String(vard), mono: true, sag: true },
                        { v: String(temiz), mono: true, sag: true, renk: R.yesil },
                        { v: `%${trSayi((temiz / vard) * 100, 0)}`, mono: true, sag: true, renk: (temiz / vard) >= 0.9 ? R.yesil : R.amber },
                      ],
                    };
                  })}
                />
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 11.5, color: R.not, marginTop: 12, marginBottom: 16, lineHeight: 1.55 }}>
          ℹ ÖNERİ-ONLY: bu ekran gözlem toplar, hüküm vermez. Puan maaşa/avansa bağlanmaz;
          disiplin kararı sahibin.
        </div>
      </>
    );
  }

  // ── 1) Kadro ───────────────────────────────────────────────────────────────
  if (gorunum === 'kadro') {
    const satir = personel.map(p => {
      const t = takipMap[String(p.id)] || {};
      const kd = kidemAy(p.baslangic_tarihi);
      const fm = sayi(t.toplam_fazla_mesai_saat);
      return {
        p, kd,
        saat: t.toplam_planlanan_saat != null ? sayi(t.toplam_planlanan_saat) : null,
        fm,
        durum: fm > 8 ? 'fazla mesai' : kd != null && kd < 3 ? 'deneme' : 'aktif',
        durumRenk: fm > 8 ? R.kirmizi : kd != null && kd < 3 ? R.mavi : R.yesil,
      };
    });
    const yeni = satir.filter(x => x.kd != null && x.kd < 1).length;
    const kidemli = satir.filter(x => x.kd != null);
    const ortKidem = kidemli.length ? kidemli.reduce((s, x) => s + x.kd, 0) / kidemli.length : null;
    // Şube sayısı yalnız GERÇEK şubelerden: sube_id'si olmayan (merkez/depo)
    // personel şube saydırmaz — yoksa "5 şube" gibi yanlış rakam çıkar.
    const subeSayisi = new Set(personel.filter(p => p.sube_id).map(p => p.sube_adi).filter(Boolean)).size;
    const subesiz = personel.filter(p => !p.sube_id).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Toplam personel', deger: String(personel.length), alt: `${subeSayisi} şube${subesiz ? ` + ${subesiz} merkez` : ''}` },
          { etiket: 'Bu ay işe giren', deger: String(yeni), alt: yeni ? 'ilk ayında' : 'yeni giriş yok', renk: yeni ? R.yesil : R.krem },
          { etiket: 'Fazla mesai riski', deger: String(satir.filter(x => x.fm > 8).length), alt: 'bu ay 8 saatten fazla', renk: satir.some(x => x.fm > 8) ? R.kirmizi : R.yesil },
          { etiket: 'Ortalama kıdem', deger: ortKidem == null ? '—' : `${trSayi(ortKidem, 0)} ay`, alt: 'zincir geneli', renk: R.krem },
        ]} />
        <Tablo
          baslik="Kadro"
          not="satıra tıkla → personel dosyası"
          kolonlar={[
            { ad: 'Personel' }, { ad: 'Görev' }, { ad: 'Şube' },
            { ad: 'Kıdem', sag: true }, { ad: 'Bu ay saat', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={satir.map(x => ({
            id: x.p.id, _p: x.p,
            hucreler: [
              { v: x.p.ad_soyad, kalin: true },
              { v: x.p.gorev || '—', renk: R.not },
              { v: x.p.sube_adi || '—', renk: R.not },
              { v: x.kd == null ? '—' : `${x.kd} ay`, mono: true, sag: true },
              { v: x.saat == null ? '—' : `${trSayi(x.saat, 0)} sa`, mono: true, sag: true, renk: x.fm > 8 ? R.kirmizi : R.krem },
              { v: x.durum, rozet: x.durumRenk },
            ],
          }))}
          onSatir={(row) => personelAc(row._p)}
        />
        <div style={{ display: 'flex', gap: 9, marginTop: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={() => pFormAc(null)} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            + Personel ekle
          </button>
          <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
            düzenleme ve işten çıkış için satıra tıkla
          </span>
        </div>
        {personelModali}
      </>
    );
  }

  // ── 2) Vardiya Planı ───────────────────────────────────────────────────────
  if (gorunum === 'vardiya') {
    const gunISO = hafta?.gunler || Array.from({ length: 7 }, (_, i) => isoEkle(pazartesi, i));
    const gunler = gunISO.map(g => ({
      iso: g,
      haftaAd: HAFTA[haftaGunu(g)],
      gunAd: kisaTarih(g),
      bugun: g === bugun,
    }));
    // Uç sözleşmesi (vardiya_v2.sube_haftalik_gorunum): şube alanı `sube_ad`,
    // `gunler` ise TARİH STRİNGİYLE anahtarlanmış sözlük — dizi değil.
    const subeler = (hafta?.subeler || []).map(s => ({
      ad: s.sube_ad || s.ad || '—',
      gunler: gunISO.map(g => {
        const ham = (s.gunler || {})[g] || [];
        const kisiler = (Array.isArray(ham) ? ham : []).map(k => ({
          ad: k.ad_soyad || k.ad || '—',
          gorev: k.gorev,
          saat: k.saat,
          kapanis: k.kapanis,
        }));
        return { iso: g, kisiler };
      }),
    }));

    const toplamHucre = subeler.length * 7;
    const bosHucre = subeler.reduce((s, x) => s + x.gunler.filter(h => !h.kisiler.length).length, 0);
    const atamaSayisi = subeler.reduce((s, x) => s + x.gunler.reduce((t, h) => t + h.kisiler.length, 0), 0);
    const fazlaMesai = personel.filter(p => sayi(takipMap[String(p.id)]?.toplam_fazla_mesai_saat) > 8).length;

    if (!subeler.length) {
      return (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>Bu hafta için vardiya planı yok</div>
          <div style={{ fontSize: 13, color: R.not, marginTop: 8, lineHeight: 1.6 }}>
            {kisaTarih(pazartesi)} haftası boş. Aşağıdaki gün planlayıcıdan atama yapabilirsin.
          </div>
        </div>
      );
    }

    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Boş slot', deger: String(bosHucre), alt: bosHucre ? 'kimse atanmamış gün-şube' : 'hafta tam', renk: bosHucre ? R.amber : R.yesil },
          { etiket: 'Toplam atama', deger: String(atamaSayisi), alt: `${subeler.length} şube · 7 gün` },
          { etiket: 'Fazla mesai riski', deger: `${fazlaMesai} kişi`, alt: 'bu ay 8 saat üzeri', renk: fazlaMesai ? R.kirmizi : R.yesil },
          { etiket: 'Doluluk', deger: toplamHucre ? `%${trSayi(((toplamHucre - bosHucre) / toplamHucre) * 100, 0)}` : '—', alt: 'gün-şube hücresi', renk: R.krem },
        ]} />
        <VardiyaIzgara
          baslik={`Vardiya planı · ${kisaTarih(pazartesi)} – ${kisaTarih(isoEkle(pazartesi, 6))}`}
          not="salt-okur · atama planlama ekranından yapılır"
          gunler={gunler}
          subeler={subeler}
          onHucre={(s, h) => onCekmece?.({
            tip: 'VARDİYA HÜCRESİ',
            baslik: `${s.ad} · ${kisaTarih(h.iso)}`,
            alt: h.kisiler.length ? `${h.kisiler.length} kişi atanmış` : 'kimse atanmamış',
            kpi: [
              { etiket: 'Atanan', deger: String(h.kisiler.length), renk: h.kisiler.length ? R.yesil : R.kirmizi },
              { etiket: 'Gün', deger: HAFTA[haftaGunu(h.iso)] },
            ],
            listeBaslik: 'Vardiyadakiler',
            satirlar: h.kisiler.map(k => ({
              ad: k.ad,
              detay: k.gorev || (k.kapanis ? 'kapanış sorumlusu' : 'vardiya'),
              tutar: k.saat || '—',
            })),
            not: h.kisiler.length
              ? 'Atamayı değiştirmek için aşağıdaki gün planlayıcıyı kullan (o güne geçer).'
              : 'Bu gün-şube için kimse atanmamış. Açık slot, kapanış sorumlusu boşluğu anlamına da gelebilir.',
            aksiyonlar: [{
              ad: `→ ${kisaTarih(h.iso)} gününü planla`,
              birincil: true,
              onTikla: () => { setVpTarih(h.iso); vpYukle(h.iso); },
            }],
          })}
        />

        {/* ══════════ YERLİ GÜN PLANLAYICI (klasik VardiyaPlanlamaV2 çekirdeği) ══════════ */}
        <div style={{ ...kartYuzey, padding: '18px 20px', marginTop: 16, marginBottom: 16 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>🗓 Gün planlayıcı</span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={() => vpGunDegis(-1)} style={vpOk}>‹</button>
              <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, minWidth: 92, textAlign: 'center' }}>
                {kisaTarih(vpTarih)}
              </span>
              <button onClick={() => vpGunDegis(1)} style={vpOk}>›</button>
            </div>
            <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
              slota tıkla → personel ata · çakışma engeldir, uyarıda onay sorar
            </span>
            <button onClick={() => setVpKopyaModal({ hedef: isoEkle(vpTarih, 1) })} style={{
              padding: '7px 13px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: R.girinti, color: R.metin2, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
            }}>
              📋 Kopyala / temizle
            </button>
          </div>

          {vpHata ? (
            <div style={{ fontSize: 12.5, color: R.kirmizi }}>
              Gün planı alınamadı — {vpHata}
              <button onClick={() => vpYukle(vpTarih)} style={{
                marginLeft: 10, padding: '5px 11px', borderRadius: 8, border: `1px solid ${R.kirmizi}55`,
                background: `${R.kirmizi}18`, color: R.kirmizi, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
              }}>Tekrar dene</button>
            </div>
          ) : !vpGun ? (
            <div style={{ fontSize: 12.5, color: R.not, textAlign: 'center', padding: '18px 0' }}>Gün planı yükleniyor…</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              {(vpGun.subeler || []).map((sb) => {
                const slotlar = Array.isArray(sb.slotlar) ? sb.slotlar : [];
                const eksikVar = slotlar.some((sv) => sayi(sv.eksik) > 0);
                return (
                  <div key={sb.sube_id} style={{
                    background: 'linear-gradient(165deg, #241A10, #1E1509)',
                    border: `1px solid ${eksikVar ? `${R.amber}44` : 'rgba(243,233,220,.08)'}`,
                    borderRadius: 14, padding: 13,
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      paddingBottom: 9, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
                    }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>{sb.sube_ad || '—'}</span>
                      <span style={{ fontSize: 10.5, color: R.not2, fontFamily: F.mono }}>
                        {sayi(sb.atanan_benzersiz_kisi)} kişi
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {slotlar.length === 0 && (
                        <div style={{ fontSize: 11.5, color: R.not3, textAlign: 'center', padding: '10px 0' }}>slot tanımı yok</div>
                      )}
                      {slotlar.map((sv) => {
                        const slot = sv.slot || {};
                        const atamalar = Array.isArray(sv.atamalar) ? sv.atamalar : [];
                        const eksik = sayi(sv.eksik);
                        const saat = `${String(slot.baslangic_saat || '').slice(0, 5)}–${String(slot.bitis_saat || '').slice(0, 5)}`;
                        return (
                          <div key={slot.id} style={{
                            padding: '10px 12px', borderRadius: 11,
                            background: R.girinti,
                            border: `1px solid ${eksik > 0 ? `${R.amber}55` : R.cizgi3}`,
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{slot.ad || 'vardiya'}</span>
                              <span style={{ fontFamily: F.mono, fontSize: 11, color: R.not2 }}>{saat}</span>
                              {eksik > 0 && <span style={{ ...rozetHapV, background: `${R.amber}22`, color: R.amber }}>{eksik} eksik</span>}
                            </div>
                            {atamalar.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                                {atamalar.map((a) => (
                                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                                    <span style={{ color: R.yesil }}>✓</span>
                                    <span style={{ flex: 1, color: R.metin2 }}>
                                      {a.ad_soyad || `${a.ad || ''} ${a.soyad || ''}`.trim() || '—'}
                                      {a.kapanis ? ' · kapanış' : ''}
                                    </span>
                                    <button
                                      disabled={vpMesgul === a.id}
                                      onClick={() => vpAtamaSil(a.id, a.ad_soyad || a.ad)}
                                      style={{
                                        padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                                        border: `1px solid ${R.cizgi3}`, background: 'transparent',
                                        color: R.not, fontSize: 10.5,
                                      }}
                                    >
                                      {vpMesgul === a.id ? '…' : 'kaldır'}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                            <button
                              onClick={() => setVpAtaModal({ slot, subeAd: sb.sube_ad, personelId: '', uyari: '', override: false })}
                              style={{
                                width: '100%', marginTop: 9, padding: '6px 0', borderRadius: 8,
                                border: `1px solid ${R.bakir}55`, background: `${R.bakir}1a`,
                                color: R.bakir, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                              }}
                            >
                              + Personel ata
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* atama modalı */}
        {vpAtaModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !vpMesgul) setVpAtaModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Vardiya Ataması</div>
                <button onClick={() => !vpMesgul && setVpAtaModal(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                {vpAtaModal.subeAd} · {vpAtaModal.slot.ad || 'vardiya'} ·{' '}
                {String(vpAtaModal.slot.baslangic_saat || '').slice(0, 5)}–{String(vpAtaModal.slot.bitis_saat || '').slice(0, 5)} ·{' '}
                {kisaTarih(vpTarih)}
              </div>
              <label style={ekEtiket}>Personel *</label>
              <select
                value={vpAtaModal.personelId}
                onChange={(e) => setVpAtaModal((f) => ({ ...f, personelId: e.target.value, uyari: '', override: false }))}
                style={ekAlanStil}
              >
                <option value="">Seçin…</option>
                {personel.map((p) => <option key={p.id} value={p.id}>{p.ad_soyad}{p.sube_adi ? ` · ${p.sube_adi}` : ''}</option>)}
              </select>

              {vpAtaModal.uyari && (
                <div style={{
                  marginTop: 13, padding: '12px 15px', borderRadius: 12,
                  background: vpAtaModal.override ? `${R.amber}12` : `${R.kirmizi}14`,
                  border: `1px solid ${vpAtaModal.override ? `${R.amber}66` : `${R.kirmizi}55`}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: vpAtaModal.override ? R.amber : R.kirmizi }}>
                    {vpAtaModal.override ? '⚠ Uyarı var' : '⛔ Çakışma — atanamaz'}
                  </div>
                  <div style={{ fontSize: 12, color: R.metin2, marginTop: 5, lineHeight: 1.5 }}>{vpAtaModal.uyari}</div>
                  {vpAtaModal.override && (
                    <button disabled={vpMesgul === 'ata'} onClick={() => vpAta(true)} style={{
                      marginTop: 10, padding: '7px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
                      background: `${R.amber}26`, color: R.amber, fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                    }}>{vpMesgul === 'ata' ? 'Atanıyor…' : 'Yine de ata'}</button>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                <button disabled={!!vpMesgul} onClick={() => setVpAtaModal(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>Vazgeç</button>
                <button
                  disabled={!!vpMesgul || !vpAtaModal.personelId || (!!vpAtaModal.uyari && !vpAtaModal.override)}
                  onClick={() => vpAta(false)}
                  style={{
                    padding: '10px 20px', borderRadius: 10, border: 'none',
                    background: vpAtaModal.personelId ? 'linear-gradient(150deg, #D99A4E, #B06E2C)' : R.girinti,
                    color: vpAtaModal.personelId ? '#1C1309' : R.not,
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                    cursor: vpAtaModal.personelId ? 'pointer' : 'default',
                  }}
                >
                  {vpMesgul === 'ata' ? 'Kontrol ediliyor…' : 'Ata'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* kopyala / temizle modalı */}
        {vpKopyaModal && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !vpMesgul) setVpKopyaModal(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 460, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Gün Planı Kopyala</div>
                <button onClick={() => !vpMesgul && setVpKopyaModal(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
                <b>{kisaTarih(vpTarih)}</b> planı hedef güne kopyalanır (hedefin mevcut planı silinir).
              </div>
              <label style={ekEtiket}>Hedef gün</label>
              <input type="date" value={vpKopyaModal.hedef}
                onChange={(e) => setVpKopyaModal((f) => ({ ...f, hedef: e.target.value }))}
                style={{ ...ekAlanStil, colorScheme: 'dark' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                <button disabled={!!vpMesgul} onClick={vpGunTemizle} style={{
                  padding: '9px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                  border: `1px solid ${R.kirmizi}55`, background: `${R.kirmizi}18`,
                  color: R.kirmizi, fontSize: 11.5, fontWeight: 700,
                }}>
                  {vpMesgul === 'temizle' ? 'Temizleniyor…' : `${kisaTarih(vpTarih)} planını temizle`}
                </button>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  <button disabled={!!vpMesgul} onClick={() => setVpKopyaModal(null)} style={{
                    padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                    background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                  }}>Vazgeç</button>
                  <button disabled={!!vpMesgul || !vpKopyaModal.hedef} onClick={() => vpGunKopyala(vpKopyaModal.hedef)} style={{
                    padding: '10px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
                    fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                  }}>{vpMesgul === 'kopyala' ? 'Kopyalanıyor…' : 'Kopyala'}</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ── 3) Maaş & Avans ────────────────────────────────────────────────────────
  if (gorunum === 'maas') {
    const toplamNet = bordro.reduce((s, b) => s + sayi(b.hesaplanan_net), 0);
    const bekleyen = bordro.filter(b => b.durum && !['odendi', 'onayli'].includes(b.durum));
    const toplamAvans = avans?.toplam != null ? sayi(avans.toplam) : bordro.reduce((s, b) => s + sayi(b.avans_mahsup), 0);
    const toplamFm = bordro.reduce((s, b) => s + sayi(b.fazla_mesai_saat), 0);
    return (
      <>
        <DonemSecici
          etiket={`${AY_KISA[ay - 1]} ${yil}`}
          onGeri={() => ayDegistir(-1)}
          onIleri={() => ayDegistir(1)}
          ileriKapali={yil === buYil && ay === buAy}
        />
        <KpiSeridi kpiler={[
          { etiket: `${AY_KISA[ay - 1]} bordro`, deger: fmt(toplamNet), alt: `${bordro.length} kişi · hesaplanan net` },
          { etiket: 'Onay bekleyen', deger: String(bekleyen.length), alt: bekleyen.length ? 'taslak bordro' : 'hepsi onaylı', renk: bekleyen.length ? R.amber : R.yesil },
          { etiket: 'Avans', deger: fmt(toplamAvans), alt: 'maaştan mahsup edilecek', renk: R.krem },
          { etiket: 'Fazla mesai', deger: `${trSayi(toplamFm, 0)} sa`, alt: 'bu ay toplam', renk: toplamFm > 0 ? R.kirmizi : R.krem },
        ]} />
        {bordro.length ? (
          <Tablo
            baslik={`Maaş & avans · ${AY_KISA[ay - 1]} ${yil}`}
            not="satıra tıkla → bordro dosyası"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Ücret', sag: true }, { ad: 'Fazla mesai', sag: true },
              { ad: 'Avans', sag: true }, { ad: 'Net', sag: true }, { ad: 'Aşama' },
            ]}
            satirlar={bordro.map(b => ({
              id: b.personel_id, _b: b,
              hucreler: [
                { v: b.ad_soyad, kalin: true },
                { v: ucretMetni(b), mono: true, sag: true },
                { v: b.fazla_mesai_saat ? `${trSayi(b.fazla_mesai_saat)} sa` : '—', mono: true, sag: true, renk: sayi(b.fazla_mesai_saat) > 8 ? R.kirmizi : R.krem },
                { v: b.avans_mahsup ? fmt(b.avans_mahsup) : '—', mono: true, sag: true, renk: sayi(b.avans_mahsup) ? R.amber : R.not },
                { v: fmt(sayi(b.hesaplanan_net)), mono: true, sag: true, kalin: true },
                { v: asamaAd(b.durum), rozet: ASAMA_RENK[b.durum] || R.amber },
              ],
            }))}
            onSatir={(row) => {
              const b = row._b;
              onCekmece?.({
                tip: 'BORDRO DOSYASI',
                baslik: b.ad_soyad,
                alt: `${AY_KISA[ay - 1]} ${yil} · ${asamaAd(b.durum)}`,
                kpi: [
                  { etiket: 'Hesaplanan net', deger: fmt(sayi(b.hesaplanan_net)), renk: R.yesil },
                  { etiket: 'Ücret', deger: ucretMetni(b) },
                  { etiket: 'Çalışma saati', deger: b.calisma_saati ? `${trSayi(b.calisma_saati, 0)} sa` : '—' },
                  { etiket: 'Fazla mesai', deger: b.fazla_mesai_saat ? `${trSayi(b.fazla_mesai_saat)} sa` : '—', renk: sayi(b.fazla_mesai_saat) > 8 ? R.kirmizi : R.krem },
                ],
                listeBaslik: 'Kırılım',
                satirlar: [
                  { ad: 'Avans mahsubu', detay: 'bu ay düşülen', tutar: fmt(sayi(b.avans_mahsup)) },
                  { ad: 'Mahsup devri', detay: 'sonraki aya taşan', tutar: fmt(sayi(b.mahsup_devir)) },
                  { ad: 'Eksik gün', detay: 'devamsızlık', tutar: b.eksik_gun ? `${trSayi(b.eksik_gun, 0)} gün` : '—' },
                  { ad: 'Manuel düzeltme', detay: b.not_aciklama || 'not yok', tutar: fmt(sayi(b.manuel_duzeltme)) },
                ],
                not: 'Hesap maaş çekirdeğinden gelir. Bordro onayı ve ödemesi guard\'lı maaş akışında yapılır (Personel ekranı).',
                aksiyonAd: 'Personel ekranını aç',
                _hedef: 'personel',   // maaş onay/ödeme akışı klasikte (guard'lı) — bilinçli
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için bordro kaydı bulunamadı.
          </div>
        )}
      </>
    );
  }

  // ── 4) Görev Takibi ────────────────────────────────────────────────────────
  if (gorunum === 'gorev') {
    const toplam = gorevOzet.reduce((s, g) => s + sayi(g.toplam), 0);
    const tamam = gorevOzet.reduce((s, g) => s + sayi(g.tamamlanan), 0);
    const acik = toplam - tamam;
    const subeGrup = {};
    gorevOzet.forEach(g => {
      const k = g.sube_adi || '—';
      if (!subeGrup[k]) subeGrup[k] = { ad: k, toplam: 0, tamam: 0, bloklar: [] };
      subeGrup[k].toplam += sayi(g.toplam);
      subeGrup[k].tamam += sayi(g.tamamlanan);
      subeGrup[k].bloklar.push({ tip: g.vardiya_tip, toplam: sayi(g.toplam), tamam: sayi(g.tamamlanan) });
    });
    const subeler = Object.values(subeGrup).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
    const gorevGunEtiket = `${Number(gorevTarih.slice(8, 10))} ${AY_KISA[Number(gorevTarih.slice(5, 7)) - 1]}`;
    return (
      <>
        <DonemSecici
          etiket={gorevTarih === bugun ? `Bugün · ${gorevGunEtiket}` : gorevGunEtiket}
          onGeri={() => gorevGunDegistir(-1)}
          onIleri={() => gorevGunDegistir(1)}
          ileriKapali={gorevTarih === bugun}
        />
        <KpiSeridi kpiler={[
          { etiket: gorevTarih === bugun ? 'Bugünkü görev' : `${gorevGunEtiket} görevi`, deger: String(toplam), alt: `${subeler.length} şube · vardiya blokları` },
          { etiket: 'Tamamlanan', deger: String(tamam), alt: toplam ? `%${trSayi((tamam / toplam) * 100, 0)}` : '—', renk: R.yesil },
          { etiket: 'Açık', deger: String(acik), alt: acik ? 'henüz işaretlenmedi' : 'hepsi kapandı', renk: acik ? R.amber : R.yesil },
          { etiket: 'Aktif kadro', deger: String(personel.length), alt: 'görev atanabilir personel', renk: R.krem },
        ]} />
        {subeler.length ? (
          <Tablo
            baslik={`Görev takibi · ${kisaTarih(bugun)}`}
            not="satıra tıkla → şubenin vardiya blokları"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Toplam görev', sag: true }, { ad: 'Tamamlanan', sag: true },
              { ad: 'Açık', sag: true }, { ad: 'Tamamlanma', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={subeler.map(s => {
              const oran = s.toplam ? (s.tamam / s.toplam) * 100 : 0;
              return {
                id: s.ad, _s: s,
                hucreler: [
                  { v: s.ad, kalin: true },
                  { v: String(s.toplam), mono: true, sag: true },
                  { v: String(s.tamam), mono: true, sag: true, renk: R.yesil },
                  { v: String(s.toplam - s.tamam), mono: true, sag: true, renk: s.toplam - s.tamam ? R.amber : R.not },
                  { v: `%${trSayi(oran, 0)}`, bar: oran, sag: true, renk: oran >= 90 ? R.yesil : oran >= 60 ? R.amber : R.kirmizi },
                  { v: oran >= 90 ? 'temiz' : oran >= 60 ? 'eksik var' : 'geride', rozet: oran >= 90 ? R.yesil : oran >= 60 ? R.amber : R.kirmizi },
                ],
              };
            })}
            onSatir={(row) => {
              const s = row._s;
              onCekmece?.({
                tip: 'ŞUBE GÖREVLERİ',
                baslik: s.ad,
                alt: `${kisaTarih(bugun)} · ${s.tamam}/${s.toplam} tamamlandı`,
                kpi: [
                  { etiket: 'Toplam', deger: String(s.toplam) },
                  { etiket: 'Açık', deger: String(s.toplam - s.tamam), renk: s.toplam - s.tamam ? R.amber : R.yesil },
                ],
                listeBaslik: 'Vardiya blokları',
                satirlar: s.bloklar.map(b => ({
                  ad: b.tip || 'vardiya',
                  detay: b.tamam === b.toplam ? 'tamam' : `${b.toplam - b.tamam} açık`,
                  tutar: `${b.tamam}/${b.toplam}`,
                })),
                not: 'Görevler QR ile personel telefonundan işaretlenir; kanıt fotoğrafı görev kaydında durur.',
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Bugün için görev şablonu bulunamadı.
          </div>
        )}
      </>
    );
  }

  // ── 5) Vardiya Takip (giriş-çıkış) ─────────────────────────────────────────
  if (gorunum === 'takip') {
    const satir = (takip || []).filter(t => t.aktif !== false);
    const toplamSaat = satir.reduce((s, t) => s + sayi(t.toplam_planlanan_saat), 0);
    const toplamGecikme = satir.reduce((s, t) => s + sayi(t.toplam_gecikme_dk), 0);
    const toplamFm = satir.reduce((s, t) => s + sayi(t.toplam_fazla_mesai_saat), 0);
    const gecikenler = satir.filter(t => sayi(t.toplam_gecikme_dk) > 0);
    return (
      <>
        <DonemSecici
          etiket={`${AY_KISA[ay - 1]} ${yil}`}
          onGeri={() => ayDegistir(-1)}
          onIleri={() => ayDegistir(1)}
          ileriKapali={yil === buYil && ay === buAy}
        />
        <KpiSeridi kpiler={[
          { etiket: 'Aylık toplam saat', deger: `${trSayi(toplamSaat, 0)} sa`, alt: `${satir.length} personel · ${AY_KISA[ay - 1]}` },
          { etiket: 'Toplam gecikme', deger: `${trSayi(toplamGecikme, 0)} dk`, alt: gecikenler.length ? `${gecikenler.length} personel` : 'gecikme yok', renk: toplamGecikme > 0 ? R.amber : R.yesil },
          { etiket: 'Fazla mesai', deger: `${trSayi(toplamFm, 0)} sa`, alt: 'plan üstü çalışma', renk: toplamFm > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Kişi başı ortalama', deger: satir.length ? `${trSayi(toplamSaat / satir.length, 0)} sa` : '—', alt: 'bu ay', renk: R.krem },
        ]} />
        {satir.length ? (
          <Tablo
            baslik={`Vardiya takip · ${AY_KISA[ay - 1]} ${yil}`}
            not="satıra tıkla → personel dosyası"
            kolonlar={[
              { ad: 'Personel' }, { ad: 'Çalışma türü' }, { ad: 'Planlanan saat', sag: true },
              { ad: 'Gecikme', sag: true }, { ad: 'Fazla mesai', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={satir.map(t => {
              const gec = sayi(t.toplam_gecikme_dk);
              const fm = sayi(t.toplam_fazla_mesai_saat);
              return {
                id: t.personel_id, _t: t,
                hucreler: [
                  { v: t.ad_soyad, kalin: true },
                  { v: turAd(t.calisma_turu), renk: R.not },
                  { v: `${trSayi(t.toplam_planlanan_saat, 0)} sa`, mono: true, sag: true },
                  { v: gec ? `${trSayi(gec, 0)} dk` : '—', mono: true, sag: true, renk: gec > 30 ? R.kirmizi : gec > 0 ? R.amber : R.not },
                  { v: fm ? `${trSayi(fm)} sa` : '—', mono: true, sag: true, renk: fm > 8 ? R.kirmizi : R.krem },
                  {
                    v: fm > 8 ? 'fazla mesai' : gec > 30 ? 'gecikme yüksek' : 'normal',
                    rozet: fm > 8 ? R.kirmizi : gec > 30 ? R.amber : R.yesil,
                  },
                ],
              };
            })}
            onSatir={(row) => {
              const p = personel.find(x => String(x.id) === String(row._t.personel_id));
              if (p) personelAc(p);
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            {AY_KISA[ay - 1]} {yil} için vardiya takip kaydı yok.
          </div>
        )}
        {/* ── İZİN ALACAĞI (yerli — klasik derin takip bloğu) ── */}
        {(() => {
          const kisiler = Array.isArray(izin?.personeller) ? izin.personeller : [];
          const alacakli = kisiler.filter((k) => sayi(k.net_alacak_gun) > 0 || sayi(k.borclu_hafta_sayisi) > 0);
          if (!kisiler.length) return null;
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginTop: 14, marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
                paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 12,
              }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>🏖 İzin alacağı</span>
                <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>
                  {izin.baslangic ? `${kisaTarih(izin.baslangic)} – ${kisaTarih(izin.bitis)}` : 'dönem'} ·
                  haftalık izin hakkı ↔ verilen izin
                </span>
                <span style={{ fontSize: 11.5, color: alacakli.length ? R.amber : R.yesil, fontWeight: 700 }}>
                  {alacakli.length ? `${alacakli.length} kişide alacak/borç var` : 'hepsi dengede ✓'}
                </span>
              </div>
              {alacakli.length === 0 ? (
                <div style={{ fontSize: 12.5, color: R.not, padding: '8px 0' }}>
                  Bu dönemde izin alacağı biriken personel yok — haftalık izinler kullanılmış.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {alacakli.slice(0, 12).map((k) => (
                    <div key={k.personel_id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '9px 13px', borderRadius: 11, background: R.girinti, border: `1px solid ${R.cizgi3}`,
                    }}>
                      <span style={{ flex: 1, minWidth: 150, fontSize: 12.5, fontWeight: 700 }}>{k.ad_soyad}</span>
                      <span style={{ fontSize: 11.5, color: R.not }}>
                        verilen izin <b style={{ fontFamily: F.mono, color: R.krem }}>{trSayi(sayi(k.verilen_izin_gun), 1)} gün</b>
                      </span>
                      {sayi(k.borclu_hafta_sayisi) > 0 && (
                        <span style={{ fontSize: 11.5, color: R.amber }}>
                          izinsiz hafta <b style={{ fontFamily: F.mono }}>{sayi(k.borclu_hafta_sayisi)}</b>
                        </span>
                      )}
                      <span style={{
                        fontFamily: F.mono, fontSize: 12.5, fontWeight: 700,
                        color: sayi(k.net_alacak_gun) > 0 ? R.kirmizi : R.yesil,
                      }}>
                        net {trSayi(sayi(k.net_alacak_gun), 1)} gün
                      </span>
                    </div>
                  ))}
                  {alacakli.length > 12 && (
                    <div style={{ fontSize: 11, color: R.not2, textAlign: 'center' }}>+{alacakli.length - 12} kişi daha</div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* ── VARDİYA DIŞI GİRİŞLER (bugün) ── */}
        {(() => {
          const kayitlar = Array.isArray(vardiyaDisi) ? vardiyaDisi : [];
          return (
            <div style={{
              ...kartYuzey, padding: '14px 18px', marginBottom: 16,
              border: kayitlar.length ? `1px solid ${R.amber}55` : kartYuzey.border,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>🚪 Vardiya dışı giriş · bugün</span>
                <span style={{ fontSize: 11.5, color: R.not2, flex: 1 }}>
                  planında olmadığı halde panele giren personel
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700,
                  color: kayitlar.length ? R.amber : R.yesil,
                }}>
                  {kayitlar.length ? `${kayitlar.length} kayıt` : 'yok ✓'}
                </span>
              </div>
              {kayitlar.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 11 }}>
                  {kayitlar.slice(0, 8).map((k, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, color: R.metin2, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700 }}>{k.ad_soyad || k.personel_ad || '—'}</span>
                      <span style={{ color: R.not }}>{k.sube_adi || '—'}</span>
                      <span style={{ fontFamily: F.mono, color: R.not2 }}>{k.giris_saat || k.saat || ''}</span>
                      {k.aciklama && <span style={{ color: R.not }}>{k.aciklama}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {/* Bu görünümden de personel dosyası açılıyor → düzenle/çıkış modalları burada da gerekli */}
        {personelModali}
      </>
    );
  }

  // ── 6) İş Başvuruları ──────────────────────────────────────────────────────
  if (gorunum === 'basvuru') {
    const bs = basvurular;
    const yeni = bs.filter(b => trKucuk(b.durum) === 'yeni');
    const gorusme = bs.filter(b => trKucuk(b.durum).includes('görüş') || trKucuk(b.durum).includes('gorus'));
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Yeni başvuru', deger: String(basvuruOzet?.yeni ?? yeni.length), alt: 'okunmamış', renk: (basvuruOzet?.yeni ?? yeni.length) ? R.yesil : R.krem },
          { etiket: 'Görüşme aşamasında', deger: String(gorusme.length), alt: gorusme.length ? 'planlandı' : 'yok', renk: R.mavi },
          { etiket: 'Toplam başvuru', deger: String(bs.length), alt: 'arşivsiz kayıt' },
          { etiket: 'Öncelikli', deger: String(bs.filter(b => sayi(b.oncelik) > 0).length), alt: 'işaretlenmiş', renk: R.amber },
        ]} />
        {bs.length ? (
          <Liste
            satirlar={bs.slice(0, 40).map(b => ({
              id: b.id, _b: b,
              baslik: `${b.ad_soyad || b.ad || 'Başvuru'}${b.pozisyon ? ` · ${b.pozisyon}` : ''}`,
              alt: [b.sube_tercihi || b.sube, b.deneyim, b.olusturma ? kisaTarih(b.olusturma) : null]
                .filter(Boolean).join(' · ') || 'ayrıntı girilmemiş',
              tutar: '',
              rozet: trKucuk(b.durum) || 'yeni',
              rozetRenk: trKucuk(b.durum) === 'yeni' ? R.yesil : R.mavi,
              tier: trKucuk(b.durum) === 'yeni' ? 'uyari' : 'bilgi',
              aksiyon: 'İncele',
            }))}
            onAc={() => onKopru?.('__modul:ekip:basvuru')}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Açık iş başvurusu yok.
          </div>
        )}
      </>
    );
  }

  // ── 7) Panel PIN & Görev QR ────────────────────────────────────────────────
  // ⚠️ TASARIM SAPMASI (bilinçli): blueprint ŞUBE başına tek panel PIN gösteriyor
  // ("••14"). Gerçekte PIN PERSONEL bazlı — her personelin kendi PIN'i var, şubenin
  // ortak PIN'i YOK. Uydurma şube PIN'i göstermek yerine tablo aynı biçimde ama
  // doğru içerikle kuruldu: şube başına kaç personelin PIN'i tanımlı, kaç yönetici.
  const subeGrup = {};
  pinler.forEach(p => {
    const k = p.sube_adi || 'Şube atanmamış';
    if (!subeGrup[k]) subeGrup[k] = { ad: k, toplam: 0, tanimli: 0, yonetici: 0, kisiler: [] };
    subeGrup[k].toplam += 1;
    if (p.panel_pin_tanimli) subeGrup[k].tanimli += 1;
    if (p.yonetici) subeGrup[k].yonetici += 1;
    subeGrup[k].kisiler.push(p);
  });
  const pinSube = Object.values(subeGrup).sort((a, b) => a.ad.localeCompare(b.ad, 'tr'));
  // "Şube atanmamış" grubu tabloda kalır (personel kaybolmasın) ama ŞUBE SAYILMAZ.
  const gercekSube = pinSube.filter(s => s.ad !== 'Şube atanmamış').length;
  const toplamTanimli = pinler.filter(p => p.panel_pin_tanimli).length;
  const eksikPin = pinler.length - toplamTanimli;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: 'PIN tanımlı personel', deger: `${toplamTanimli} / ${pinler.length}`, alt: 'şube paneline girebilen', renk: eksikPin ? R.amber : R.yesil },
        { etiket: 'PIN eksik', deger: String(eksikPin), alt: eksikPin ? 'panele giremez' : 'hepsi tanımlı', renk: eksikPin ? R.amber : R.yesil },
        { etiket: 'Panel yöneticisi', deger: String(pinler.filter(p => p.yonetici).length), alt: 'cep override yetkisi', renk: R.krem },
        { etiket: 'Şube', deger: String(gercekSube), alt: 'PIN dağılımı', renk: R.krem },
      ]} />
      {pinSube.length ? (
        <Tablo
          baslik="Şube panel PIN durumu"
          not="PIN personel bazlıdır · satıra tıkla → şube kırılımı"
          kolonlar={[
            { ad: 'Şube' }, { ad: 'Personel', sag: true }, { ad: 'PIN tanımlı', sag: true },
            { ad: 'PIN eksik', sag: true }, { ad: 'Yönetici', sag: true }, { ad: 'Durum' },
          ]}
          satirlar={pinSube.map(s => {
            const eksik = s.toplam - s.tanimli;
            return {
              id: s.ad, _s: s,
              hucreler: [
                { v: s.ad, kalin: true },
                { v: String(s.toplam), mono: true, sag: true },
                { v: String(s.tanimli), mono: true, sag: true, renk: R.yesil },
                { v: String(eksik), mono: true, sag: true, renk: eksik ? R.amber : R.not },
                { v: String(s.yonetici), mono: true, sag: true, renk: s.yonetici ? R.mavi : R.not },
                { v: eksik ? 'PIN eksik' : 'tamam', rozet: eksik ? R.amber : R.yesil },
              ],
            };
          })}
          onSatir={(row) => {
            const s = row._s;
            onCekmece?.({
              tip: 'ŞUBE PIN DURUMU',
              baslik: s.ad,
              alt: `${s.tanimli}/${s.toplam} personelin PIN'i tanımlı`,
              kpi: [
                { etiket: 'Personel', deger: String(s.toplam) },
                { etiket: 'PIN eksik', deger: String(s.toplam - s.tanimli), renk: s.toplam - s.tanimli ? R.amber : R.yesil },
              ],
              listeBaslik: 'Personel',
              satirlar: s.kisiler.map(k => ({
                ad: k.ad_soyad,
                detay: k.yonetici ? 'panel yöneticisi' : 'personel',
                tutar: k.panel_pin_tanimli ? 'PIN var' : 'PIN yok',
              })),
              not: 'Şube panelinin ortak PIN\'i yoktur — her personel kendi PIN\'iyle girer. PIN yenileme Personel Panel PIN ekranından yapılır.',
              aksiyonAd: 'Panel PIN ekranını aç',
              _hedef: 'sube-panel-pin',
            });
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          Panel PIN kaydı bulunamadı.
        </div>
      )}
      {/* Kapsama denetimi (2026-07-29): görünüm adı "Görev QR" vaat ediyordu ama
          QR yoklama kodları + şube konum/yarıçap ayarı (gorev-qr sayfası) v2'den
          HİÇ erişilemiyordu — köprü açıldı. */}
      <div style={{ display: 'flex', gap: 9, marginTop: 2, marginBottom: 16 }}>
        <button
          onClick={() => onKopru?.('gorev-qr')}
          style={{
            padding: '9px 17px', borderRadius: 10, border: 'none',
            background: 'linear-gradient(150deg, #D99A4E, #B06E2C)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(217,154,78,.24)',
          }}
        >
          📱 Görev QR kodları & şube konum ayarı
        </button>
      </div>
    </>
  );
}
