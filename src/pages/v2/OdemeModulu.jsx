// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — Ödeme Merkezi modülü (4 görünüm)
//
// Tasarım: ICERIK → odeme.bekleyen / odeme.takvim / odeme.tedarikci / odeme.gecmis
//
// ⚠️ TEK YAZICI İLKESİ: bu modül deftere KENDİ yazmaz. "Öde" ve "Ertele",
// mevcut Ödeme Merkezi'nin kullandığı AYNI uçlara delege eder
// (/odeme-plani/{id}/ode, /odeme-plani/{id}/ertele) — o uçlarda FOR UPDATE
// kilidi, çift-ödeme kapısı ve maaş onay guard'ı zaten var. Yeni bir para
// yazma yolu açılmadı.
//
// Veri uçları:
//   /odeme-plani/bugun?gun=N   → bekleyen + gecikmiş + yaklaşan kuyruk
//   /odeme-plani/kokpit        → kasa, gecikmiş toplamı, nakit projeksiyonu
//   /fatura/cari-ozet          → tedarikçi açık bakiyeleri
//   /ledger?ay=YYYY-MM         → ödeme geçmişi (kasa hareketleri)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Tablo, Liste, Takvim, SecimCubugu, OnayModali, Serit } from './parcalar';

const sayi = (v) => Number(v) || 0;
const trSayi = (n, b = 1) => (Number(n) || 0).toFixed(b).replace('.', ',');
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');
// ⚠️ İKİ YÖNLÜ TÜRKÇE-I TUZAĞI:
//   trKucuk  → 'İ'yi doğru çevirir ama ASCII 'I'yı NOKTASIZ 'ı' yapar.
//              'FAIZ' → 'faız', 'CIRO' → 'cıro' (yanlış).
//   slugAd   → veritabanı slug'ları (ASCII, BÜYÜK, alt çizgili) için: düz
//              toLowerCase + alt çizgi → boşluk. 'ANLIK_GIDER' → 'anlik gider'.
// Kural: TÜRKÇE metinde trKucuk, DB SLUG'ında slugAd.
const slugAd = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
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
const kisaTarih = (t) => {
  const s = String(t || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '—';
  return `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}`;
};

/** kasa_hareketleri.islem_turu → okunur ödeme yöntemi */
const YONTEM = {
  KART_ODEME: 'kredi kartı',
  FATURA_ODEMESI: 'havale / nakit',
  PERSONEL_MAAS: 'maaş ödemesi',
  PERSONEL_AVANS: 'avans',
  TEDARIKCI_ODEME: 'tedarikçi ödemesi',
};

/** 📎 Fatura eki — klasik ÖM ile aynı boru hattı (PDF→yukle-pdf, foto→yukle). */
async function faturaEkiYukle(dosya) {
  const fd = new FormData();
  const isPdf = /pdf/i.test(dosya.type || '') || /\.pdf$/i.test(dosya.name || '');
  fd.append(isPdf ? 'pdf' : 'foto', dosya);
  const res = await fetch(isPdf ? '/api/fatura/yukle-pdf' : '/api/fatura/yukle', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.detail) || 'fatura yüklenemedi');
}

const omAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const omEtiket = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};

/** Vadeli kaynaklı plan satırı mı? — düzenle/sil yalnız bunlarda anlamlı. */
const vadeliMi = (o) => String(o?.kaynak_tablo || '') === 'vadeli_alimlar' && !!o?.kaynak_id;
const vadeliBaslik = (o) => `${o?.baslik || 'Vadeli alım'}`;

export default function OdemeModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [yukleniyor, setYukleniyor] = useState(true);
  const [hata, setHata] = useState('');
  const [kuyruk, setKuyruk] = useState([]);      // 14 günlük pencere
  const [kokpit, setKokpit] = useState(null);
  const [cari, setCari] = useState(null);
  const [vergi, setVergi] = useState(null);   // /duyu/vergi-takvim — yaklaşan vergi yükü
  const [gecmis, setGecmis] = useState([]);
  // Sahip kararı (soru 3/9): tedarikçi ödemeleri NAKİT+KART birleşik.
  // Kasa defteri kartla yapılan tedarikçi ödemesini GÖREMEZ (kasadan para
  // çıkmaz, kart hareketine yazılır) — /vadeli-alimlar/gecmis iki kanalı
  // tedarikçi bağıyla birleştirir. Üstteki liste ile ÇİFT SAYIM olmasın diye
  // ayrı blok: nakit satırlar iki kaynakta da var, birleştirilmez.
  const [tedOdeme, setTedOdeme] = useState(null);
  const [tedKanal, setTedKanal] = useState('');
  const [vade, setVade] = useState(null);   // duyu 5/6: vade disiplini (salt-okur)
  const [modal, setModal] = useState(null);
  const [calisiyor, setCalisiyor] = useState(false);

  const ay = isoBugun().slice(0, 7);

  const yukle = () => {
    setYukleniyor(true);
    setHata('');
    Promise.all([
      api('/odeme-plani/bugun?gun=14&personel=1').catch(() => []),
      api('/odeme-plani/kokpit?personel=1').catch(() => null),
      api('/fatura/cari-ozet').catch(() => null),
      api(`/ledger?limit=400&ay=${ay}`).catch(() => null),
      api('/vadeli-alimlar/gecmis?limit=200').catch(() => null),
      // VERGİ YÜKÜ (2026-08-07 denetimi): ödenecek KDV + kira stopajı hesaplanıyor
      // ama ödeme planında görünmüyordu — "bu ay ne ödeyeceğim" listesinde vergi
      // yoktu, ay sonu sürpriz oluyordu. Plana BORÇ olarak YAZILMAZ (tahminî
      // rakam borç sayılmaz — kasa izi tek gerçek); yaklaşan yük olarak GÖSTERİLİR.
      api('/duyu/vergi-takvim').catch(() => null),
    ]).then(([k, ko, c, l, tg, vt]) => {
      setVergi(vt);
      setTedOdeme(Array.isArray(tg?.satirlar) ? tg.satirlar : (Array.isArray(tg) ? tg : []));
      setKuyruk(Array.isArray(k) ? k : []);
      setKokpit(ko);
      setCari(c);
      const satir = Array.isArray(l) ? l : (l?.rows || []);
      setGecmis(satir.filter(r => sayi(r.tutar) < 0));
      if (!Array.isArray(k) && !ko) setHata('Ödeme verileri alınamadı.');
      setYukleniyor(false);
    }).catch((e) => {
      setHata(e?.message || 'Beklenmeyen bir hata oluştu.');
      setYukleniyor(false);
    });
    api('/ops/vade-disiplini?gun=90')
      .then((d) => setVade(d || {}))
      .catch(() => setVade({}));
  };

  // ── VADELİ ALIM KAYDI: düzenle / sil (2026-07-31) ─────────────────────────
  // ⚠️ ÖDEME buraya EKLENMEDİ: /vadeli-alimlar/{id}/ode içeride odeme_plani
  // satırı açan eski sarmalayıcı; kanonik yol /odeme-plani/{id}/ode ve o zaten
  // bu ekranda. İkinci para kapısı açmamak için bilinçli dışarıda.
  const [vaModal, setVaModal] = useState(null);   // {tip, o, form?}
  const [vaMesgul, setVaMesgul] = useState(false);

  const vaUygula = async () => {
    const m = vaModal;
    if (!m) return;
    const vid = m.o?.kaynak_id;
    if (!vid) { onToast?.('Vadeli alım kimliği bulunamadı'); return; }
    setVaMesgul(true);
    try {
      if (m.tip === 'duzenle') {
        const f = m.form || {};
        const t = Number(String(f.tutar).replace(',', '.'));
        if (!String(f.tedarikci || '').trim()) { onToast?.('Tedarikçi zorunlu'); setVaMesgul(false); return; }
        if (!Number.isFinite(t) || t <= 0) { onToast?.('Geçerli bir tutar girin'); setVaMesgul(false); return; }
        if (!f.vade_tarihi) { onToast?.('Vade tarihi zorunlu'); setVaMesgul(false); return; }
        await api(`/vadeli-alimlar/${vid}`, { method: 'PUT', body: {
          aciklama: String(f.aciklama || '').trim() || '—',
          tutar: t, vade_tarihi: f.vade_tarihi,
          tedarikci: String(f.tedarikci).trim(),
          ...(f.force ? { force: true } : {}),
        } });
        onToast?.('✓ Vadeli alım güncellendi');
      } else {
        await api(`/vadeli-alimlar/${vid}`, { method: 'DELETE' });
        onToast?.('✓ Vadeli alım kaydı silindi — ödeme kuyruğundan düştü');
      }
      setVaModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem başarısız');
    } finally { setVaMesgul(false); }
  };

  const vaModalBlok = vaModal && (() => {
    const kapat = () => { if (!vaMesgul) setVaModal(null); };
    const sil = vaModal.tip === 'sil';
    const f = vaModal.form || {};
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(10,6,2,.72)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 470, maxWidth: '96vw', padding: '24px 26px' }}>
          <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600, marginBottom: 6 }}>
            {sil ? 'Vadeli alımı sil' : 'Vadeli alımı düzenle'}
          </div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{vadeliBaslik(vaModal.o)}</b>
          </div>
          <div style={{ fontSize: 12, color: R.not2, lineHeight: 1.65, marginBottom: 14 }}>
            {sil
              ? 'Kayıt silinir ve ödeme kuyruğundan düşer. Ödenmiş bir alımı silmek kasa izini bozmaz ama borç geçmişini eksiltir — yanlış girilen kayıt için kullan.'
              : 'Tutar, vade veya tedarikçi düzeltilir. Ödeme burada YAPILMAZ — ödemek için satırdaki «Öde» düğmesini kullan (kasa izi oradan çıkar).'}
          </div>
          {!sil && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 170, flex: 1 }}><label style={omEtiket}>Tedarikçi</label>
                <input value={f.tedarikci ?? ''} autoFocus
                  onChange={(e) => setVaModal((p) => ({ ...p, form: { ...p.form, tedarikci: e.target.value } }))} style={omAlanStil} /></div>
              <div style={{ maxWidth: 140 }}><label style={omEtiket}>Tutar ₺</label>
                <input inputMode="decimal" value={f.tutar ?? ''}
                  onChange={(e) => setVaModal((p) => ({ ...p, form: { ...p.form, tutar: e.target.value } }))} style={omAlanStil} /></div>
              <div style={{ maxWidth: 160 }}><label style={omEtiket}>Vade tarihi</label>
                <input type="date" value={f.vade_tarihi ?? ''}
                  onChange={(e) => setVaModal((p) => ({ ...p, form: { ...p.form, vade_tarihi: e.target.value } }))} style={omAlanStil} /></div>
              <div style={{ minWidth: 200, flex: 1 }}><label style={omEtiket}>Açıklama</label>
                <input value={f.aciklama ?? ''}
                  onChange={(e) => setVaModal((p) => ({ ...p, form: { ...p.form, aciklama: e.target.value } }))} style={omAlanStil} /></div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button disabled={vaMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgeç</button>
            <button disabled={vaMesgul} onClick={vaUygula} style={{
              padding: '10px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              border: sil ? `1px solid ${R.kirmizi}55` : 'none',
              background: sil ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: sil ? R.kirmizi : '#1C1309',
            }}>{vaMesgul ? 'İşleniyor…' : (sil ? 'Sil' : 'Kaydet')}</button>
          </div>
        </div>
      </div>
    );
  })();

  useEffect(yukle, []);

  const bugun = isoBugun();
  const kasa = sayi(kokpit?.kasa);

  /** Kuyruğu normalize eder — tutarı girilmemiş fatura satırları ayrı işaretlenir. */
  const satirlar = useMemo(() => kuyruk.map(o => ({
    ...o,
    _tutar: sayi(o.tutar),
    _tahmin: sayi(o.tahmini_tutar),
    _tarih: o.tarih ? String(o.tarih).slice(0, 10) : null,
    _gecikmis: !!o.gecikmis,
    _bugunMu: o.tarih ? String(o.tarih).slice(0, 10) === bugun : false,
  })), [kuyruk, bugun]);

  // Tutarı girilmemiş fatura satırları kuyrukta GÖRÜNÜR ama toplamlara ve kalem
  // sayılarına KARIŞMAZ — kasa izi tek gerçek, tahmini rakam borç sayılmaz.
  const tutarli = satirlar.filter(o => !o.tutar_girilmedi);
  const tutarsiz = satirlar.filter(o => o.tutar_girilmedi);

  const bugunVeGecmis = tutarli.filter(o => o._gecikmis || o._bugunMu || !o._tarih);
  const bugunToplam = bugunVeGecmis.reduce((s, o) => s + o._tutar, 0);
  const haftaSatir = tutarli.filter(o => o._tarih && o._tarih <= isoEkle(bugun, 7));
  const haftaToplam = haftaSatir.reduce((s, o) => s + o._tutar, 0);
  const gecikmisSatir = tutarli.filter(o => o._gecikmis);
  const gecikmisToplam = gecikmisSatir.reduce((s, o) => s + o._tutar, 0);
  const toplamKuyruk = tutarli.reduce((s, o) => s + o._tutar, 0);
  const tutarsizNot = tutarsiz.length ? ` · ${tutarsiz.length} kalem tutarsız` : '';

  // ── TÜR KIRILIMI (2026-08-07, denetim bulgusu) ─────────────────────────────
  // ÖNCE: kuyruk tek düz listeydi. 36 kalemin içinde 10 MAAŞ kalemi (215 K ₺,
  // hepsi vadesi geçmiş) "Vadeli Alım" satırlarının arasında kayboluyordu —
  // sahip "personel ödemesini nereden yapacağım, plana yansımıyor" diye sordu.
  // Kalem PLANDA VARDI, görünmüyordu. Şimdi tür şeridi hangi yükün ne kadar
  // olduğunu tek bakışta verir ve tıklayınca o türe süzer.
  // Sayılar mevcut `tutarli` kümesinden türetilir — ikinci bir hesap yolu YOK.
  const [turFiltre, setTurFiltre] = useState('');
  const turOzet = useMemo(() => {
    const m = new Map();
    tutarli.forEach((o) => {
      const k = o.tip || 'Diğer';
      if (!m.has(k)) m.set(k, { ad: k, adet: 0, tutar: 0, gecikmis: 0, gecikmisTutar: 0 });
      const g = m.get(k);
      g.adet += 1; g.tutar += o._tutar;
      if (o._gecikmis) { g.gecikmis += 1; g.gecikmisTutar += o._tutar; }
    });
    // Tutarı girilmemiş kalemler ayrı bir tür gibi görünür (borç sayılmaz, ama gizlenmez)
    if (tutarsiz.length) {
      m.set('__tutarsiz__', {
        ad: 'Tutarı girilmemiş', adet: tutarsiz.length,
        tutar: tutarsiz.reduce((s, o) => s + o._tahmin, 0), gecikmis: 0, gecikmisTutar: 0, tahminMi: true,
      });
    }
    return [...m.values()].sort((a, b) => (b.gecikmisTutar - a.gecikmisTutar) || (b.tutar - a.tutar));
  }, [tutarli, tutarsiz]);

  // Süzgeç listeye uygulanır; KPI toplamları DEĞİŞMEZ (tüm kuyruğun gerçeği).
  const gorunenSatirlar = useMemo(() => {
    if (!turFiltre) return satirlar;
    if (turFiltre === '__tutarsiz__') return satirlar.filter((o) => o.tutar_girilmedi);
    return satirlar.filter((o) => (o.tip || 'Diğer') === turFiltre && !o.tutar_girilmedi);
  }, [satirlar, turFiltre]);

  // ── ÖDEME KOŞUSU v2-YERLİ (köprü kaldırma turu, 2026-07-30) ────────────────
  // Klasik ÖM sihirbazının çekirdeği: tam/kısmi + nakit/kart + fatura eki +
  // tutarsız fatura (öde / vadeye yaz) + tarih seçmeli ertele + taahhüt.
  // TEK YAZICI İLKESİ korunur: hepsi mevcut guard'lı uçlara delege.
  const [kartListe, setKartListe] = useState([]);
  // ── BORÇ ÖDE (cari hesaba ödeme, 2026-07-31) ──────────────────────────────
  // Sahip kararı: alım ≠ ödeme. Bu akış bir ALIM kaydına iliştirmeden, doğrudan
  // tedarikçinin cari hesabına ödeme yapar; para FIFO ile en eski borçtan kapatır.
  const [borcModal, setBorcModal] = useState(null);   // {ted, tutar, yontem, kartId, elle, secim{}}
  const [borcAcik, setBorcAcik] = useState(null);     // /cari-odenecekler cevabı
  const [borcMesgul, setBorcMesgul] = useState(false);
  // ── TOPLU ÖDEME KOŞUSU (tek kapı kararı, 2026-07-31) ──────────────────────
  // Backend /toplu-odeme TEK TRANSACTION uygular: biri düşerse hepsi rollback.
  // Advisory lock kasadan-çıkaran toplu işlemleri serileştirir (main.py MN5).
  const [topluSecim, setTopluSecim] = useState({});
  const [topluSor, setTopluSor] = useState(false);
  const [topluMesgul, setTopluMesgul] = useState(false);
  const kartlariGetir = () => {
    if (!kartListe.length) api('/kartlar').then((d) => setKartListe(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const odemeyiAc = (o) => {
    kartlariGetir();
    if (o.tutar_girilmedi) {
      // tutarsız fatura → tutar sor + ödendi/vadeye-yaz kararı (klasik akış)
      setModal({ tip: 'tutar', satir: o, tutar: o._tahmin ? String(o._tahmin) : '', yontem: 'nakit', kartId: '', dosya: null });
      return;
    }
    setModal({
      tip: 'ode', satir: o, mod: 'tam', yontem: 'nakit', kartId: '',
      // tamTutar = plandaki tutar; DEĞİŞTİRİLİRSE /ode?tutar= ile gider
      // (borç yine KAPANIR — kalan açan yol 'kismi').
      tamTutar: String(sayi(o._tutar)), kismiTutar: '',
      kalanVade: isoEkle(o._tarih || bugun, 30), dosya: null,
    });
  };

  const erteleyiAc = (o) => {
    setModal({ tip: 'ertele', satir: o, yeniTarih: isoEkle(o._tarih || bugun, 7) });
  };

  const dosyaNotu = async (dosya) => {
    if (!dosya) return '';
    try { await faturaEkiYukle(dosya); return ' · 📎 fatura arşive alındı'; }
    catch (e) { return ` · ⚠ fatura yüklenemedi: ${e.message}`; }
  };

  const modalOnayla = async () => {
    if (!modal) return;
    const o = modal.satir;
    setCalisiyor(true);
    try {
      if (modal.tip === 'ode') {
        if (modal.yontem === 'kart' && !modal.kartId) { onToast?.('Kart seçin'); setCalisiyor(false); return; }
        if (modal.mod === 'kismi') {
          const t = Number(String(modal.kismiTutar).replace(',', '.'));
          const isKart = o.tip === 'Kredi Kartı';
          if (!t || t <= 0 || t >= o._tutar) { onToast?.('Kısmi tutar 0 ile borç arasında olmalı'); setCalisiyor(false); return; }
          if (!isKart && !modal.kalanVade) { onToast?.('Kalan borç için yeni vade seçin'); setCalisiyor(false); return; }
          await api(`/odeme-plani/${o.id}/kismi-ode`, {
            method: 'POST',
            body: { odenen_tutar: t, kalan_vade_tarihi: isKart ? bugun : modal.kalanVade, odeme_yontemi: modal.yontem, kart_id: modal.yontem === 'kart' ? modal.kartId : null },
          });
          onToast?.(isKart
            ? `${fmt(t)} ödendi · kalan ${fmt(o._tutar - t)} sonraki ekstreye devreder${await dosyaNotu(modal.dosya)}`
            : `${fmt(t)} ödendi · kalan ${fmt(o._tutar - t)} → ${kisaTarih(modal.kalanVade)}${await dosyaNotu(modal.dosya)}`);
        } else {
          // Plandaki tutar yanlışsa düzeltilebilir: sunucu ?tutar= ile ödenen_tutar'ı
          // yazar ve planı 'odendi' kapatır (kalan AÇMAZ — o iş /kismi-ode'nin işi).
          const planT = sayi(o._tutar);
          const tamT = Number(String(modal.tamTutar ?? '').replace(',', '.'));
          if (!tamT || tamT <= 0) { onToast?.('Ödenecek tutar 0\'dan büyük olmalı'); setCalisiyor(false); return; }
          const duzeltildi = Math.abs(tamT - planT) > 0.005;
          const q = duzeltildi ? `?tutar=${encodeURIComponent(tamT)}` : '';
          await api(`/odeme-plani/${o.id}/ode${q}`, {
            method: 'POST',
            body: { odeme_yontemi: modal.yontem, kart_id: modal.yontem === 'kart' ? modal.kartId : null },
          });
          const nereye = modal.yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü';
          onToast?.(duzeltildi
            ? `${o.baslik} ${fmt(tamT)} ödendi — plan ${fmt(planT)} idi, tutar düzeltildi ve borç kapandı${await dosyaNotu(modal.dosya)}`
            : `${o.baslik} ödendi — ${nereye}${await dosyaNotu(modal.dosya)}`);
        }
      } else if (modal.tip === 'tutar') {
        const t = Number(String(modal.tutar).replace(',', '.'));
        if (!t || t <= 0) { onToast?.('Fatura tutarını girin'); setCalisiyor(false); return; }
        if (modal.karar === 'vadeye') {
          await api('/fatura-vadeye-yaz', { method: 'POST', body: { sabit_gider_id: o.sabit_gider_id, tutar: t } });
          onToast?.(`${fmt(t)} vadeye yazıldı — kasa etkilenmedi`);
        } else {
          if (modal.yontem === 'kart' && !modal.kartId) { onToast?.('Kart seçin'); setCalisiyor(false); return; }
          await api('/fatura-ode', {
            method: 'POST',
            body: { sabit_gider_id: o.sabit_gider_id, tutar: t, tarih: bugun, odeme_yontemi: modal.yontem, kart_id: modal.yontem === 'kart' ? modal.kartId : null },
          });
          onToast?.(`Ödendi — ${modal.yontem === 'kart' ? 'karta yazıldı' : 'kasadan düşüldü'}${await dosyaNotu(modal.dosya)}`);
        }
      } else if (modal.tip === 'taahhut') {
        const t = Number(String(modal.tutar).replace(',', '.'));
        if (!(modal.tedarikci || '').trim() || !t || !modal.vade) { onToast?.('Tedarikçi, tutar ve vade zorunlu'); setCalisiyor(false); return; }
        const r = await api('/vadeli-alimlar', {
          method: 'POST',
          body: {
            tedarikci: modal.tedarikci.trim(), tutar: t, vade_tarihi: modal.vade,
            aciklama: `🤝 Taahhüt: ${(modal.aciklama || '').trim() || 'ödeme sözü'}`,
            ...(modal.force ? { force: true } : {}),
            ...(modal.tedarikciKarari ? { tedarikci_karari: modal.tedarikciKarari } : {}),
            ...(modal.birlestirId ? { birlestir_vadeli_id: modal.birlestirId } : {}),
          },
        });
        // İKİ FARKLI UYARI, İKİ FARKLI ÇÖZÜM — eskiden ikisi de aynı "Yine de
        // kaydet" (force) düğmesine düşüyordu; force yalnız MÜKERRER-TARİH
        // uyarısını geçer, çoklu açık borcu GEÇMEZ → akış tıkanıyordu (400).
        // TEDARIKCI_ACIK_BAKIYE için sunucu karar bekliyor (main.py:7424):
        //   tedarikci_karari='ayri'                → yeni satır
        //   tedarikci_karari='ilave' + birlestir_vadeli_id → o borca ekle
        if (r?.kod === 'TEDARIKCI_ACIK_BAKIYE') {
          setModal((m) => ({
            ...m,
            acikBorclar: Array.isArray(r.mevcut_borc) ? r.mevcut_borc : [],
            uyari: r.mesaj || 'Bu tedarikçide birden fazla açık borç var',
          }));
          setCalisiyor(false); return;
        }
        if (r?.warning) { setModal((m) => ({ ...m, uyari: r.mesaj || 'Benzer kayıt olabilir' })); setCalisiyor(false); return; }
        onToast?.(`🤝 Taahhüt kaydedildi — ${kisaTarih(modal.vade)} günü bekleyenlerde görünecek`);
      } else {
        await api(`/odeme-plani/${o.id}/ertele?yeni_tarih=${encodeURIComponent(modal.yeniTarih)}`, { method: 'POST' });
        onToast?.(`${o.baslik} ${kisaTarih(modal.yeniTarih)} tarihine ertelendi`);
      }
      setModal(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'İşlem tamamlanamadı');
    } finally {
      setCalisiyor(false);
    }
  };

  if (yukleniyor) {
    return <div style={{ ...kartYuzey, padding: '46px 30px', textAlign: 'center', color: R.not }}>Ödeme verileri yükleniyor…</div>;
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

  // ── zengin ödeme modalı (tam/kısmi + yöntem + ek + tutarsız + ertele + taahhüt) ──
  const guncelle = (k, v) => setModal((m) => ({ ...m, [k]: v }));

  /** Borç Öde akışını aç: tedarikçinin AÇIK faturalarını FIFO sırayla getir. */
  const borcOdeAc = async (tedAd, onerilenTutar) => {
    setBorcModal({ ted: tedAd, tutar: onerilenTutar ? String(Math.round(onerilenTutar)) : '', yontem: 'nakit', kartId: '', elle: false, secim: {} });
    setBorcAcik(null);
    try {
      const d = await api(`/fatura/cari-odenecekler?tedarikci=${encodeURIComponent(tedAd)}`);
      setBorcAcik(d || { acik_faturalar: [], acik_toplam: 0 });
    } catch (e) {
      setBorcAcik({ acik_faturalar: [], acik_toplam: 0, _hata: e?.message || 'açık faturalar alınamadı' });
    }
  };

  /** FIFO önizleme: girilen tutar hangi faturaları kapatır? (sunucudaki kuralın aynısı) */
  const borcOnizleme = () => {
    const liste = borcAcik?.acik_faturalar || [];
    const t = sayi(borcModal?.tutar);
    if (!t || !liste.length) return { satirlar: [], avans: t || 0 };
    if (borcModal?.elle) {
      const sat = liste
        .filter((f) => sayi(borcModal.secim[f.fatura_id]) > 0)
        .map((f) => ({ ...f, kapanan: Math.min(sayi(borcModal.secim[f.fatura_id]), f.kalan) }));
      const toplam = sat.reduce((a, b) => a + b.kapanan, 0);
      return { satirlar: sat, avans: Math.max(0, t - toplam) };
    }
    let kalan = t; const sat = [];
    for (const f of liste) {
      if (kalan <= 0.01) break;
      const pay = Math.min(f.kalan, kalan);
      sat.push({ ...f, kapanan: pay });
      kalan -= pay;
    }
    return { satirlar: sat, avans: Math.max(0, kalan) };
  };

  const borcOdeGonder = async () => {
    const t = sayi(borcModal?.tutar);
    if (t <= 0) { onToast?.('Ödeme tutarı girin'); return; }
    if (borcModal.yontem === 'kart' && !borcModal.kartId) { onToast?.('Kart seçin'); return; }
    setBorcMesgul(true);
    try {
      const govde = {
        tedarikci: borcModal.ted, tutar: t,
        odeme_yontemi: borcModal.yontem,
        kart_id: borcModal.yontem === 'kart' ? borcModal.kartId : null,
      };
      if (borcModal.elle) {
        govde.tahsis = (borcAcik?.acik_faturalar || [])
          .filter((f) => sayi(borcModal.secim[f.fatura_id]) > 0)
          .map((f) => ({ fatura_id: f.fatura_id, tutar: sayi(borcModal.secim[f.fatura_id]) }));
      }
      const r = await api('/fatura/cari-ode', { method: 'POST', body: govde });
      const kapanan = (r?.kapatilan_faturalar || []).length;
      onToast?.(r?.mesaj || `✓ ${fmt(t)} ödendi · ${kapanan} fatura kapandı`);
      setBorcModal(null); setBorcAcik(null);
      yukle();
    } catch (e) {
      onToast?.(e?.message || 'Ödeme başarısız');
    } finally { setBorcMesgul(false); }
  };

  /** Seçilen bekleyen ödemeleri TEK transaction'da uygula. */
  const topluOdeGonder = async (secililer) => {
    if (!secililer.length) return;
    setTopluMesgul(true);
    try {
      const r = await api('/toplu-odeme', {
        method: 'POST',
        body: { odemeler: secililer.map((o) => ({ odeme_id: o._id, tutar: sayi(o._tutar) })) },
      });
      onToast?.(`✓ ${sayi(r?.uygulanan) || secililer.length}/${secililer.length} ödeme uygulandı`);
      setTopluSecim({}); setTopluSor(false);
      yukle();
    } catch (e) {
      // Tek transaction: biri düşerse HİÇBİRİ uygulanmaz — mesaj bunu söylemeli
      onToast?.(`${e?.message || 'Toplu ödeme başarısız'} — hiçbiri uygulanmadı`);
    } finally {
      setTopluMesgul(false);
    }
  };

  /** Seçili kaynağın ödeme sonrası durumu. Nakit → kasa bakiyesi; kart →
   *  kullanılabilir limit. Veri yoksa şerit HİÇ çıkmaz (uydurma bakiye yok). */
  const kaynakDurumu = (() => {
    if (!modal) return null;
    // Tam modda tutar DÜZELTİLEBİLİR olduğundan plandaki değere değil, gerçekten
    // çıkacak tutara bakılır — yoksa aynı ekranda iki farklı "sonrası kasa" çıkar.
    const tamDuzeltilmis = modal.tip === 'ode' && modal.mod !== 'kismi'
      ? Number(String(modal.tamTutar ?? '').replace(',', '.'))
      : NaN;
    const tutar = modal.mod === 'kismi'
      ? sayi(modal.kismiTutar)
      : (Number.isFinite(tamDuzeltilmis) && tamDuzeltilmis > 0
          ? tamDuzeltilmis
          : sayi(modal.satir?._tutar ?? modal.satir?.tutar));
    if (modal.yontem === 'nakit') {
      // kasa = Nakit Kokpiti'nin kanonik kasası (modülün zaten okuduğu sayı)
      if (!Number.isFinite(kasa) || kasa === 0) return null;
      const sonra = kasa - tutar;
      return (
        <div style={{ width: '100%', fontSize: 11.5, color: R.not, marginTop: 4 }}>
          Kasa {fmt(kasa)} → ödeme sonrası{' '}
          <b style={{ fontFamily: F.mono, color: sonra < 0 ? R.kirmizi : R.yesil }}>{fmt(sonra)}</b>
          {sonra < 0 && <span style={{ color: R.kirmizi }}> · kasa eksiye düşer</span>}
        </div>
      );
    }
    const k = kartListe.find((x) => String(x.id) === String(modal.kartId));
    if (!k) return null;
    const limit = sayi(k.limit_tutar);
    const borc = sayi(k.guncel_borc);
    if (!limit) return null;
    const kalan = limit - borc - tutar;
    return (
      <div style={{ width: '100%', fontSize: 11.5, color: R.not, marginTop: 4 }}>
        {k.kart_adi || k.banka} · kullanılabilir {fmt(limit - borc)} → harcama sonrası{' '}
        <b style={{ fontFamily: F.mono, color: kalan < 0 ? R.kirmizi : R.yesil }}>{fmt(kalan)}</b>
        {kalan < 0 && <span style={{ color: R.kirmizi }}> · limit aşılır</span>}
      </div>
    );
  })();
  const yontemSecici = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
      {[['nakit', '💵 Nakit / havale'], ['kart', '💳 Kart']].map(([y, ad]) => (
        <div key={y} onClick={() => guncelle('yontem', y)} style={{
          padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
          border: `1px solid ${modal?.yontem === y ? R.bakir : R.cizgi3}`,
          color: modal?.yontem === y ? R.bakir : R.metin2,
          background: modal?.yontem === y ? 'rgba(217,154,78,.14)' : 'transparent',
        }}>{ad}</div>
      ))}
      {modal?.yontem === 'kart' && (
        <select value={modal.kartId} onChange={(e) => guncelle('kartId', e.target.value)}
          style={{ ...omAlanStil, width: 'auto', minWidth: 170 }}>
          <option value="">Kart seçin *</option>
          {kartListe.map((k) => <option key={k.id} value={k.id}>{k.kart_adi || k.banka}</option>)}
        </select>
      )}
      {kaynakDurumu}
    </div>
  );
  const ekSecici = (
    <label style={{ display: 'block', marginTop: 12, fontSize: 11.5, color: R.not, cursor: 'pointer' }}>
      <input type="file" accept="application/pdf,image/*" style={{ display: 'none' }}
        onChange={(e) => guncelle('dosya', e.target.files?.[0] || null)} />
      📎 {modal?.dosya ? `${modal.dosya.name} — arşive eklenecek` : 'Fatura eki iliştir (isteğe bağlı — PDF/foto)'}
    </label>
  );
  // ── BORÇ ÖDE MODALI: FIFO önizlemeli ──────────────────────────────────────
  // Sahip kararı: alım ≠ ödeme. Bu modal fatura İSTEMEZ; girilen tutarın hangi
  // faturaları kapatacağını CANLI gösterir (sunucudaki FIFO kuralının aynısı).
  const borcOdeModali = borcModal && (() => {
    const { satirlar: onizleme, avans } = borcOnizleme();
    const acikToplam = sayi(borcAcik?.acik_toplam);
    const t = sayi(borcModal.tutar);
    const kapat = () => { if (!borcMesgul) { setBorcModal(null); setBorcAcik(null); } };
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 560, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>Borç öde</div>
            <button onClick={kapat} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>x</button>
          </div>
          <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 4 }}>
            <b>{borcModal.ted}</b>{borcAcik ? ` - acik bakiye ${fmt(acikToplam)}` : ' - acik faturalar yukleniyor...'}
          </div>
          <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.6, marginBottom: 16 }}>
            Bu bir <b>odeme</b>dir, alim degil - fatura istemez. Para en eski borctan
            kapatir; asagida hangi faturalarin kapanacagini gorursun.
          </div>

          <label style={omEtiket}>Odenecek tutar</label>
          <input value={borcModal.tutar} inputMode="decimal" autoFocus placeholder="0"
            onChange={(e) => setBorcModal((m) => ({ ...m, tutar: e.target.value }))}
            style={omAlanStil} />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            {[['nakit', 'Nakit / havale'], ['kart', 'Kart']].map(([id, ad]) => (
              <div key={id} onClick={() => setBorcModal((m) => ({ ...m, yontem: id }))} style={{
                padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${borcModal.yontem === id ? R.bakir : R.cizgi3}`,
                color: borcModal.yontem === id ? R.bakir : R.metin2,
                background: borcModal.yontem === id ? 'rgba(217,154,78,.14)' : 'transparent',
              }}>{ad}</div>
            ))}
            {borcModal.yontem === 'kart' && (
              <select value={borcModal.kartId} onChange={(e) => setBorcModal((m) => ({ ...m, kartId: e.target.value }))}
                style={{ ...omAlanStil, width: 'auto', minWidth: 170, marginBottom: 0 }}>
                <option value="">Kart secin *</option>
                {kartListe.map((k) => <option key={k.id} value={k.id}>{k.kart_adi || k.banka}</option>)}
              </select>
            )}
          </div>

          {borcAcik && (borcAcik.acik_faturalar || []).length > 0 && (
            <div style={{ border: `1px solid ${R.cizgi3}`, borderRadius: 12, padding: '12px 14px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
                  Kapanacak faturalar
                </span>
                <label style={{ marginLeft: 'auto', fontSize: 11.5, color: R.metin2, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={borcModal.elle}
                    onChange={(e) => setBorcModal((m) => ({ ...m, elle: e.target.checked, secim: {} }))} />
                  ben seceyim
                </label>
              </div>
              {(borcAcik.acik_faturalar || []).slice(0, 12).map((f) => {
                const o = onizleme.find((x) => x.fatura_id === f.fatura_id);
                const kapanan = o ? o.kapanan : 0;
                const tam = kapanan >= f.kalan - 0.01;
                return (
                  <div key={f.fatura_id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
                    borderBottom: `1px solid ${R.cizgi2}`, fontSize: 12,
                  }}>
                    <span style={{ color: R.not, fontFamily: F.mono, fontSize: 11, minWidth: 52 }}>{kisaTarih(f.tarih)}</span>
                    <span style={{ flex: 1, minWidth: 0, color: R.metin2 }}>{f.fatura_no || 'belge no yok'}</span>
                    <span style={{ fontFamily: F.mono, fontSize: 11.5, color: R.not2 }}>{fmt(f.kalan)}</span>
                    {borcModal.elle ? (
                      <input value={borcModal.secim[f.fatura_id] ?? ''} placeholder="0" inputMode="decimal"
                        onChange={(e) => setBorcModal((m) => ({ ...m, secim: { ...m.secim, [f.fatura_id]: e.target.value } }))}
                        style={{ ...omAlanStil, width: 92, marginBottom: 0, padding: '5px 8px', fontSize: 12 }} />
                    ) : (
                      <span style={{
                        minWidth: 82, textAlign: 'right', fontFamily: F.mono, fontSize: 12, fontWeight: 700,
                        color: kapanan > 0 ? (tam ? R.yesil : R.amber) : R.not3,
                      }}>
                        {kapanan > 0 ? `-${fmt(kapanan)}` : '-'}
                      </span>
                    )}
                  </div>
                );
              })}
              {avans > 0.01 && (
                <div style={{ fontSize: 11.5, color: R.amber, marginTop: 9 }}>
                  {fmt(avans)} borcu asiyor - avans olarak kalir.
                </div>
              )}
            </div>
          )}

          {borcAcik && (borcAcik.acik_faturalar || []).length === 0 && (
            <div style={{
              padding: '12px 14px', borderRadius: 12, marginBottom: 14, fontSize: 12, lineHeight: 1.6,
              background: 'rgba(96,165,250,.09)', border: '1px solid rgba(96,165,250,.26)', color: R.metin2,
            }}>
              Bu tedarikcide kapatacak acik fatura yok. Odeme yine de yapilir -
              <b> belgesiz</b> isaretlenir ve Belge Merkezi fatura kovalar.
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
            <button disabled={borcMesgul} onClick={kapat} style={{
              padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
            }}>Vazgec</button>
            <button disabled={borcMesgul || t <= 0} onClick={borcOdeGonder} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              cursor: borcMesgul || t <= 0 ? 'default' : 'pointer',
              background: t > 0 ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : R.girinti,
              color: t > 0 ? '#1C1309' : R.not, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            }}>
              {borcMesgul ? 'Odeniyor...' : t > 0 ? `${fmt(t)} ode` : 'Tutar girin'}
            </button>
          </div>
        </div>
      </div>
    );
  })();

  const modalBlok = modal && (() => {
    const o = modal.satir;
    const kapat = () => !calisiyor && setModal(null);
    const dugme = (ad, birincil, tikla, pasif) => (
      <button disabled={calisiyor || pasif} onClick={tikla} style={birincil ? {
        padding: '10px 20px', borderRadius: 10, border: 'none',
        background: pasif ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
        color: pasif ? R.not : '#1C1309', fontSize: 12.5, fontWeight: 700,
        fontFamily: 'inherit', cursor: pasif ? 'default' : 'pointer',
      } : {
        padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
        background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
      }}>{calisiyor && birincil ? 'İşleniyor…' : ad}</button>
    );
    return (
      <div onClick={(e) => { if (e.target === e.currentTarget) kapat(); }} style={{
        position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
        backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
        <div style={{ ...kartYuzey, width: 540, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto', padding: '24px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600 }}>
              {modal.tip === 'ode' ? 'Ödemeyi Onayla'
                : modal.tip === 'tutar' ? '⚡ Fatura Tutarı'
                : modal.tip === 'taahhut' ? '🤝 Yeni Taahhüt'
                : 'Ödemeyi Ertele'}
            </div>
            <button onClick={kapat} style={{
              marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
              fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
            }}>✕</button>
          </div>
          {o && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 14 }}>
              {o.baslik} · {o.tip}{o._tarih ? ` · vade ${kisaTarih(o._tarih)}` : ''}
            </div>
          )}

          {modal.tip === 'ode' && (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[['tam', `Tamamını öde — ${fmt(o._tutar)}`], ['kismi', 'Kısmi öde']].map(([m2, ad]) => (
                  <div key={m2} onClick={() => guncelle('mod', m2)} style={{
                    padding: '8px 14px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${modal.mod === m2 ? R.bakir : R.cizgi3}`,
                    color: modal.mod === m2 ? R.bakir : R.metin2,
                    background: modal.mod === m2 ? 'rgba(217,154,78,.14)' : 'transparent',
                  }}>{ad}</div>
                ))}
              </div>
              {modal.mod === 'tam' && (() => {
                const planT = sayi(o._tutar);
                const tamT = Number(String(modal.tamTutar ?? '').replace(',', '.')) || 0;
                const duzeltildi = tamT > 0 && Math.abs(tamT - planT) > 0.005;
                return (
                  <div style={{ marginTop: 12 }}>
                    <label style={omEtiket}>Ödenen tutar (₺)</label>
                    <input type="number" value={modal.tamTutar} onChange={(e) => guncelle('tamTutar', e.target.value)}
                      style={{ ...omAlanStil, fontFamily: F.mono, textAlign: 'right',
                        borderColor: duzeltildi ? R.bakir : undefined, fontWeight: duzeltildi ? 700 : undefined }} />
                    <div style={{ fontSize: 11.5, color: duzeltildi ? R.bakirAcik : R.not2, marginTop: -4, lineHeight: 1.6 }}>
                      {duzeltildi ? (
                        <>Plan <b style={{ fontFamily: F.mono }}>{fmt(planT)}</b> diyordu, sen{' '}
                          <b style={{ fontFamily: F.mono }}>{fmt(tamT)}</b> yazdın — <b>borç bu tutarla KAPANIR</b>,
                          kalan açılmaz. Kalan borç bırakmak istiyorsan <b>Kısmi öde</b>'yi seç.</>
                      ) : (
                        <>Fatura plandan farklı çıktıysa buradan düzeltebilirsin; borç yine kapanır.</>
                      )}
                    </div>
                  </div>
                );
              })()}
              {modal.mod === 'kismi' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                  <div>
                    <label style={omEtiket}>Ödenecek tutar (₺) *</label>
                    <input type="number" value={modal.kismiTutar} onChange={(e) => guncelle('kismiTutar', e.target.value)}
                      style={{ ...omAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                  </div>
                  {o.tip === 'Kredi Kartı' ? (
                    <div style={{ fontSize: 11.5, color: R.not, alignSelf: 'end', paddingBottom: 8 }}>
                      kalan sonraki ekstreye devreder
                    </div>
                  ) : (
                    <div>
                      <label style={omEtiket}>Kalan borcun yeni vadesi *</label>
                      <input type="date" value={modal.kalanVade} onChange={(e) => guncelle('kalanVade', e.target.value)}
                        style={{ ...omAlanStil, colorScheme: 'dark' }} />
                    </div>
                  )}
                </div>
              )}
              {yontemSecici}
              {ekSecici}
              {(() => {
                // Kasa etkisi GERÇEKTEN çıkacak tutarla hesaplanır — tam modda
                // düzeltilmiş tutar da buraya yansır (yoksa yanlış bakiye gösterirdi).
                const cikan = modal.mod === 'kismi'
                  ? (Number(String(modal.kismiTutar).replace(',', '.')) || 0)
                  : (Number(String(modal.tamTutar ?? '').replace(',', '.')) || 0);
                const sonra = kasa - cikan;
                return (
                  <div style={{
                    marginTop: 14, padding: '11px 15px', borderRadius: 12, background: R.girinti,
                    border: `1px solid ${R.cizgi3}`, fontSize: 12.5, color: R.metin2,
                  }}>
                    Ödeme sonrası kasa: <strong style={{ fontFamily: F.mono, color: sonra >= 0 ? R.yesil : R.kirmizi }}>
                      {fmt(sonra)}
                    </strong>
                    {modal.yontem === 'kart' ? ' — kart seçiliyken kasadan çıkmaz, kart borcuna yazılır.' : ''}
                  </div>
                );
              })()}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                {dugme('Vazgeç', false, kapat)}
                {dugme(modal.mod === 'kismi' ? 'Kısmi öde ve kaydet' : 'Öde ve kaydet', true, modalOnayla)}
              </div>
            </>
          )}

          {modal.tip === 'tutar' && (
            <>
              <div style={{ fontSize: 12, color: R.amber, marginBottom: 12 }}>
                ⚡ Bu faturanın tutarı girilmemiş{o._tahmin ? ` — geçmiş ort. ≈ ${fmt(o._tahmin)}` : ''}. Tutarı gir, sonra ne olduğunu söyle.
              </div>
              <label style={omEtiket}>Fatura tutarı (₺) *</label>
              <input type="number" value={modal.tutar} onChange={(e) => guncelle('tutar', e.target.value)}
                style={{ ...omAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
              {yontemSecici}
              {ekSecici}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
                {dugme('Vazgeç', false, kapat)}
                {dugme('Ödenmedi — vadeye yaz', false, () => { guncelle('karar', 'vadeye'); setTimeout(modalOnayla, 0); })}
                {dugme('Ödendi — kasadan/karttan düş', true, () => { guncelle('karar', 'odendi'); setTimeout(modalOnayla, 0); })}
              </div>
            </>
          )}

          {modal.tip === 'taahhut' && (
            <>
              <div style={{ fontSize: 12, color: R.metin2, marginBottom: 12, lineHeight: 1.5 }}>
                Para ÇIKMADI — tedarikçiye ödeme sözü. Borç yaratmaz; faturası gelince kendiliğinden birleşir.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={omEtiket}>Tedarikçi *</label>
                  <input value={modal.tedarikci || ''} onChange={(e) => guncelle('tedarikci', e.target.value)} style={omAlanStil} />
                </div>
                <div>
                  <label style={omEtiket}>Tutar (₺) *</label>
                  <input type="number" value={modal.tutar || ''} onChange={(e) => guncelle('tutar', e.target.value)}
                    style={{ ...omAlanStil, fontFamily: F.mono, textAlign: 'right' }} />
                </div>
                <div>
                  <label style={omEtiket}>Vade tarihi *</label>
                  <input type="date" value={modal.vade || ''} onChange={(e) => guncelle('vade', e.target.value)}
                    style={{ ...omAlanStil, colorScheme: 'dark' }} />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={omEtiket}>Açıklama</label>
                  <input value={modal.aciklama || ''} onChange={(e) => guncelle('aciklama', e.target.value)} style={omAlanStil} />
                </div>
              </div>
              {/* ÇOKLU AÇIK BORÇ — sunucu KARAR bekliyor, "yine de kaydet" işe
                  yaramaz (400 döner). İki gerçek seçenek sunulur. */}
              {modal.uyari && Array.isArray(modal.acikBorclar) && modal.acikBorclar.length > 0 && (
                <div style={{ marginTop: 12, padding: '13px 15px', borderRadius: 12, background: `${R.amber}12`, border: `1px solid ${R.amber}55` }}>
                  <div style={{ fontSize: 12, color: R.amber, fontWeight: 700, marginBottom: 4 }}>⚠ {modal.uyari}</div>
                  <div style={{ fontSize: 11.5, color: R.not, marginBottom: 10, lineHeight: 1.5 }}>
                    Ya mevcut bir borcun <b>üstüne eklenir</b> (tek satır, tutar birikir)
                    ya da <b>ayrı satır</b> açılır. Yanlış seçim cariyi ikiye böler.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {modal.acikBorclar.slice(0, 6).map((b) => (
                      <div
                        key={b.id}
                        onClick={() => setModal((m) => ({ ...m, birlestirId: String(b.id), tedarikciKarari: 'ilave' }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                          padding: '8px 11px', borderRadius: 9, fontSize: 11.5,
                          background: R.girinti,
                          border: `1px solid ${String(modal.birlestirId) === String(b.id) ? R.bakir : R.cizgi3}`,
                        }}
                      >
                        <span style={{ fontFamily: F.mono, color: R.not, flexShrink: 0 }}>{kisaTarih(b.vade_tarihi)}</span>
                        <span style={{
                          flex: 1, minWidth: 0, color: R.metin2,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{b.aciklama || b.tedarikci || 'borç'}</span>
                        <span style={{ fontFamily: F.mono, fontWeight: 700, flexShrink: 0 }}>{fmt(sayi(b.tutar))}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {dugme(
                      modal.birlestirId ? 'Seçilen borca ekle' : 'Önce borç seç',
                      !!modal.birlestirId,
                      () => { if (modal.birlestirId) setTimeout(modalOnayla, 0); },
                    )}
                    {dugme('Ayrı satır olarak kaydet', false, () => {
                      setModal((m) => ({ ...m, tedarikciKarari: 'ayri', birlestirId: '' }));
                      setTimeout(modalOnayla, 0);
                    })}
                    {dugme('Vazgeç', false, () => setModal((m) => ({ ...m, uyari: '', acikBorclar: null, tedarikciKarari: '', birlestirId: '' })))}
                  </div>
                </div>
              )}
              {/* MÜKERRER TARİH uyarısı — burada force GERÇEKTEN çözer */}
              {modal.uyari && !(Array.isArray(modal.acikBorclar) && modal.acikBorclar.length > 0) && (
                <div style={{ marginTop: 12, padding: '11px 15px', borderRadius: 12, background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}55` }}>
                  <div style={{ fontSize: 12, color: R.kirmizi, fontWeight: 700 }}>⚠ {modal.uyari}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {dugme('Yine de kaydet', true, () => { guncelle('force', true); setTimeout(modalOnayla, 0); })}
                    {dugme('Vazgeç', false, () => guncelle('uyari', ''))}
                  </div>
                </div>
              )}
              {!modal.uyari && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                  {dugme('Vazgeç', false, kapat)}
                  {dugme('Taahhüdü kaydet', true, modalOnayla)}
                </div>
              )}
            </>
          )}

          {modal.tip === 'ertele' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={omEtiket}>Mevcut vade</label>
                  <div style={{ ...omAlanStil, background: 'transparent', border: `1px dashed ${R.cizgi3}` }}>{kisaTarih(o._tarih)}</div>
                </div>
                <div>
                  <label style={omEtiket}>Yeni vade *</label>
                  <input type="date" value={modal.yeniTarih} onChange={(e) => guncelle('yeniTarih', e.target.value)}
                    style={{ ...omAlanStil, colorScheme: 'dark' }} />
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: R.not, marginTop: 10 }}>
                Erteleme kasa izine dokunmaz; yalnızca kuyruk vadesini ileri alır.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                {dugme('Vazgeç', false, kapat)}
                {dugme('Ertele', true, modalOnayla, !modal.yeniTarih)}
              </div>
            </>
          )}
        </div>
      </div>
    );
  })();

  // ── 1) Bekleyen ────────────────────────────────────────────────────────────
  if (gorunum === 'bekleyen') {
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün ödenecek', deger: fmt(bugunToplam), alt: `${bugunVeGecmis.length} kalem · vade bugün/geçmiş${tutarsizNot}`, renk: bugunToplam > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Bu hafta', deger: fmt(haftaToplam), alt: `${haftaSatir.length} kalem`, renk: R.krem },
          {
            etiket: 'Gecikmiş',
            // ⚠️ TEK DOĞRULUK KAYNAĞI: gecikmiş toplamı kokpit ucundan gelir
            // (odeme_plani_api:188 `gecikmis_toplam`). Eskiden bu sayı
            // /odeme-plani/bugun kuyruğundan istemcide YENİDEN toplanıyordu —
            // bugün örtüşüyor ama iki bağımsız kod yolu, biri değişirse
            // (ör. ileri pencere) sessizce sapar. Kart limit_doluluk'ta tam bu
            // olmuştu. Sunucu alanı yoksa eski hesaba düşülür.
            deger: fmt(kokpit?.gecikmis_toplam != null ? sayi(kokpit.gecikmis_toplam) : gecikmisToplam),
            alt: gecikmisSatir.length ? `${gecikmisSatir.length} kalem` : 'gecikme yok',
            renk: sayi(kokpit?.gecikmis_toplam ?? gecikmisToplam) > 0 ? R.kirmizi : R.yesil,
          },
          { etiket: 'Ödeme sonrası kasa', deger: fmt(kasa - bugunToplam), alt: 'bugünküler düşülmüş', renk: kasa - bugunToplam >= 0 ? R.yesil : R.kirmizi },
        ]} />
        <div style={{ display: 'flex', gap: 9, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setModal({ tip: 'taahhut', tedarikci: '', tutar: '', vade: isoEkle(bugun, 7), aciklama: '' })} style={{
            padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
            fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}>
            🤝 Yeni taahhüt (ödeme sözü)
          </button>
          <span style={{ fontSize: 11.5, color: R.not, alignSelf: 'center' }}>
            para çıkmadı — söz; faturası gelince kendiliğinden birleşir
          </span>
        </div>
        {/* ── NAKİT DİP NOKTASI (mali akış kurgusu 2026-08-08) ───────────────
            Kokpit `en_dusuk_bakiye` + `en_dusuk_tarih` hesaplıyordu ama HİÇBİR
            ekran göstermiyordu. "Bugün ödenecek" tek başına yeterli değil:
            asıl soru "önümüzdeki 30 günde kasa en dip hangi gün, ne kadar?"
            Ödeme sıralaması bu tarihe göre kurulur. */}
        {kokpit?.en_dusuk_tarih && (() => {
          const dip = sayi(kokpit.en_dusuk_bakiye);
          const c7 = sayi(kokpit.cikis_7);
          const c30 = sayi(kokpit.cikis_30);
          const renk = dip < 0 ? R.kirmizi : dip < c7 ? R.amber : R.yesil;
          return (
            <div style={{
              ...kartYuzey, padding: '12px 16px', marginBottom: 12,
              borderLeft: `3px solid ${renk}`, display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap',
            }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: renk }}>📉 Nakit dip noktası</span>
              <span style={{ fontSize: 12.5, color: R.metin2 }}>
                <b style={{ fontFamily: F.mono, color: renk }}>{kisaTarih(kokpit.en_dusuk_tarih)}</b>
                {' '}günü kasa <b style={{ fontFamily: F.mono, color: renk }}>{fmt(dip)}</b>'ye iner
              </span>
              <span style={{ fontSize: 11.5, color: R.not2 }}>
                7 gün çıkış {fmt(c7)} · 30 gün {fmt(c30)}
              </span>
              <span style={{ fontSize: 11, color: R.not, marginLeft: 'auto' }}>
                {dip < 0 ? '⚠ eksiye düşüyor — erteleme/yapılandırma şart'
                  : dip < c7 ? 'dip, bir haftalık çıkışın altında — tampon ince'
                    : 'tampon yeterli'}
              </span>
            </div>
          );
        })()}

        {/* VERGİ YÜKÜ — planda borç değil ama yaklaşan gerçek çıkış */}
        {(() => {
          const satirlar = Array.isArray(vergi?.takvim) ? vergi.takvim : [];
          const kdv = satirlar.find((s) => s.tur === 'KDV') || {};
          const stopaj = satirlar.find((s) => String(s.tur || '').startsWith('Muhtasar')) || {};
          const kdvTl = sayi(kdv.odenecek_kdv_tl);
          const stTl = sayi(stopaj.odenecek_tl);
          if (kdvTl <= 0 && stTl <= 0) return null;
          return (
            <div
              onClick={() => onCekmece?.({
                tip: 'VERGİ YÜKÜ',
                baslik: 'Yaklaşan vergi çıkışı',
                alt: 'ödeme planında borç olarak DURMAZ — tahminî, dönem kapanınca kesinleşir',
                kpi: [
                  { etiket: 'Ödenecek KDV', deger: fmt(kdvTl), renk: R.amber },
                  { etiket: 'Kira stopajı', deger: fmt(stTl), renk: R.amber },
                  { etiket: 'Toplam', deger: fmt(kdvTl + stTl), renk: R.kirmizi },
                ],
                listeBaslik: 'Kalemler',
                satirlar: [
                  { ad: 'Ödenecek KDV', detay: `${kdv.donem || '—'} · son ödeme ${kdv.son_odeme || '—'}`, tutar: fmt(kdvTl) },
                  { ad: 'Hesaplanan KDV', detay: 'satıştan · ciro KDV dahil girilir', tutar: fmt(sayi(kdv.hesaplanan_kdv_tl)) },
                  { ad: 'İndirilecek KDV', detay: 'alış + gider · kalem bazlı oran', tutar: fmt(sayi(kdv.indirilecek_kdv_tl)) },
                  { ad: 'Muhtasar (kira stopajı)', detay: `${stopaj.kira_adedi || 0} kira · son ödeme ${stopaj.son_odeme || '—'}`, tutar: fmt(stTl) },
                ],
                not: vergi?.not || 'Salt-okur farkındalık görünümü — beyanname değildir; muhasebeci takvimi esastır.',
              })}
              style={{
                ...kartYuzey, padding: '11px 15px', marginBottom: 12, cursor: 'pointer',
                borderLeft: `3px solid ${R.amber}`, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 700, color: R.amber }}>🧾 Yaklaşan vergi yükü</span>
              <span style={{ fontSize: 12.5, color: R.metin2 }}>
                KDV <b>{fmt(kdvTl)}</b>{kdv.son_odeme ? ` · son ödeme ${kisaTarih(kdv.son_odeme)}` : ''}
                {stTl > 0 ? ` · stopaj ${fmt(stTl)}` : ''}
              </span>
              <span style={{ fontSize: 11, color: R.not, marginLeft: 'auto' }}>
                kuyrukta borç olarak DURMAZ · tahminî — dokun, ayrıntı
              </span>
            </div>
          );
        })()}
        {/* Tür kırılımı — maaş/kira/kart yükü tek bakışta; tıkla → süz */}
        {turOzet.length > 1 && (
          <>
            <Serit
              rozetler={[
                ...(turFiltre ? [{ ad: '↩ Tümü', durum: `${tutarli.length} kalem`, renk: R.krem }] : []),
                ...turOzet.map((t) => ({
                  ad: t.ad === '__tutarsiz__' ? 'Tutarı girilmemiş' : t.ad,
                  durum: `${t.adet} kalem · ${t.tahminMi ? '≈' : ''}${fmt(t.tutar)}`,
                  ek: t.gecikmis ? `· ${t.gecikmis} gecikmiş` : '',
                  renk: t.gecikmis ? R.kirmizi : t.tahminMi ? R.amber : R.bakir,
                  _tur: t.ad,
                })),
              ]}
              onAc={(s) => setTurFiltre(s.ad === '↩ Tümü' ? '' : (s._tur === turFiltre ? '' : s._tur))}
            />
            {turFiltre && (
              <div style={{ fontSize: 11.5, color: R.not, marginTop: -8, marginBottom: 12 }}>
                «{turFiltre === '__tutarsiz__' ? 'Tutarı girilmemiş' : turFiltre}» süzgeci açık —
                {' '}{gorunenSatirlar.length} kalem gösteriliyor. Üstteki toplamlar TÜM kuyruğu anlatır.
              </div>
            )}
          </>
        )}
        {vaModalBlok}
        {gorunenSatirlar.length ? (
          <Liste
            secilebilir
            secili={topluSecim}
            onSec={(id) => setTopluSecim((p) => {
              const y = { ...p };
              if (y[id]) delete y[id]; else y[id] = true;
              return y;
            })}
            onHepsi={(hepsiMi) => setTopluSecim(hepsiMi
              ? Object.fromEntries(gorunenSatirlar.filter((x) => !x.tutar_girilmedi).map((x) => [x.id, true]))
              : {})}
            satirlar={gorunenSatirlar.map(o => ({
              id: o.id,
              // Tutarı girilmemiş kalem toplu koşuya GİREMEZ — ne ödeneceği belli değil
              secilemez: !!o.tutar_girilmedi,
              baslik: o.baslik,
              alt: `${o.tip}${o._tarih ? ` · vade ${kisaTarih(o._tarih)}` : ''}${o._gecikmis ? ` · ${o.gun_gecikme} gün gecikme` : ''}`,
              tutar: o.tutar_girilmedi ? (o._tahmin ? `≈ ${fmt(o._tahmin)}` : 'tutar yok') : fmt(o._tutar),
              tier: o._gecikmis ? 'kritik' : o._bugunMu ? 'uyari' : o.tutar_girilmedi ? 'uyari' : 'bilgi',
              aksiyonlar: [
                ...(o.tutar_girilmedi
                  ? [{ ad: 'Tutarı gir', birincil: true, onTikla: () => odemeyiAc(o) }]
                  : [
                    { ad: 'Öde', birincil: true, onTikla: () => odemeyiAc(o) },
                    { ad: 'Ertele', onTikla: () => erteleyiAc(o) },
                  ]),
                // Vadeli kaynaklı satırda kaydı düzeltmek/silmek mümkün —
                // ödeme değil, KAYIT yönetimi.
                ...(vadeliMi(o) ? [
                  { ad: 'Düzelt', onTikla: () => setVaModal({ tip: 'duzenle', o, form: {
                    tedarikci: o.tedarikci || o.baslik || '', tutar: String(sayi(o._tutar) || ''),
                    vade_tarihi: String(o._tarih || '').slice(0, 10), aciklama: o.aciklama || '',
                  } }) },
                  { ad: 'Kaydı sil', onTikla: () => setVaModal({ tip: 'sil', o }) },
                ] : []),
              ],
              _o: o,
            }))}
            onAc={(l) => onCekmece?.({
              tip: 'ÖDEME KALEMİ',
              baslik: l._o.baslik,
              alt: `${l._o.tip}${l._o._tarih ? ` · vade ${kisaTarih(l._o._tarih)}` : ''}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(l._o._tutar) },
                { etiket: 'Asgari', deger: l._o.asgari != null ? fmt(l._o.asgari) : '—' },
                { etiket: 'Durum', deger: l._o._gecikmis ? `${l._o.gun_gecikme} gün gecikme` : 'vadesinde' },
                { etiket: 'Kaynak', deger: l._o.kaynak_tablo || '—' },
              ],
              listeBaslik: 'Kasa etkisi',
              satirlar: [
                { ad: 'Mevcut kasa', detay: 'anlık', tutar: fmt(kasa) },
                { ad: 'Bu ödeme sonrası', detay: 'tek kalem', tutar: fmt(kasa - l._o._tutar) },
              ],
              not: l._o.tedarikci ? `Tedarikçi: ${l._o.tedarikci}` : 'Bu kalem bir tedarikçiye bağlanmamış.',
            })}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center' }}>
            <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600, color: turFiltre ? R.bakir : R.yesil }}>
              {turFiltre ? 'Bu türde kalem yok' : 'Bekleyen ödeme yok'}
            </div>
            <div style={{ fontSize: 13, color: R.not, marginTop: 8 }}>
              {turFiltre
                ? 'Süzgeci kaldırmak için yukarıdaki «↩ Tümü» rozetine dokun.'
                : 'Önümüzdeki 14 günde vadesi gelen kalem bulunmuyor.'}
            </div>
          </div>
        )}
        {(() => {
          const secililer = satirlar.filter((o) => topluSecim[o.id] && !o.tutar_girilmedi);
          const toplam = secililer.reduce((a, o) => a + sayi(o._tutar), 0);
          return (
            <>
              <SecimCubugu
                sayi={secililer.length}
                mesgul={topluMesgul}
                onaylaAd={`💸 ${fmt(toplam)} öde`}
                onOnayla={() => setTopluSor(true)}
                onTemizle={() => setTopluSecim({})}
              />
              <OnayModali
                acik={topluSor}
                baslik="Toplu ödeme koşusu"
                altBaslik={`${secililer.length} kalem tek seferde ödenecek`}
                tutar={fmt(toplam)}
                tutarSayi={toplam}
                satirlar={secililer.slice(0, 8).map((o) => ({
                  ad: String(o.baslik || '').slice(0, 44),
                  deger: fmt(sayi(o._tutar)),
                })).concat(secililer.length > 8
                  ? [{ ad: `… ve ${secililer.length - 8} kalem daha`, deger: '' }] : [])}
                not="TEK TRANSACTION: biri düşerse HİÇBİRİ uygulanmaz (rollback). Kasa yeterliliği kilit altında kontrol edilir; ödemeler kasa izine yazılır."
                onaylaAd={topluMesgul ? 'Ödeniyor…' : `Evet, ${secililer.length} kalemi öde`}
                calisiyor={topluMesgul}
                onOnayla={() => topluOdeGonder(secililer)}
                onKapat={() => setTopluSor(false)}
              />
            </>
          );
        })()}
        {modalBlok}
        {borcOdeModali}
      </>
    );
  }

  // ── 2) Vade Takvimi ────────────────────────────────────────────────────────
  if (gorunum === 'takvim') {
    const gunler = [];
    for (let i = 0; i < 14; i++) {
      const iso = isoEkle(bugun, i);
      // KPI'larla aynı kaynak: tutarı girilmemiş satırlar takvim toplamına da girmez.
      const gunSatir = tutarli.filter(o => (i === 0 ? (o._gecikmis || o._bugunMu || !o._tarih) : o._tarih === iso));
      const tutar = gunSatir.reduce((s, o) => s + o._tutar, 0);
      gunler.push({
        iso,
        gun: Number(iso.slice(8, 10)),
        haftaGunu: new Date(iso + 'T00:00:00Z').getUTCDay(),
        bugun: i === 0,
        gecikmis: i === 0 && gecikmisSatir.length > 0,
        tutar,
        tutarMetin: fmt(tutar),
        adet: gunSatir.length,
        _satirlar: gunSatir,
      });
    }
    const doluGun = gunler.filter(g => g.tutar > 0);
    const enYogun = doluGun.length ? doluGun.reduce((a, b) => (a.tutar > b.tutar ? a : b)) : null;
    const yedi = gunler.slice(0, 7).reduce((s, g) => s + g.tutar, 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: '14 günlük yük', deger: fmt(toplamKuyruk), alt: `${tutarli.length} kalem${tutarsizNot}` },
          { etiket: 'En yoğun gün', deger: enYogun ? kisaTarih(enYogun.iso) : '—', alt: enYogun ? `${fmt(enYogun.tutar)} · ${enYogun.adet} kalem` : 'ödeme yok', renk: R.amber },
          { etiket: 'Boş gün', deger: String(14 - doluGun.length), alt: 'ödeme yok', renk: R.krem },
          {
            // Sunucunun 31 günlük kasa-taban simülasyonu (odeme_plani_api:193):
            // gerçek vadeler + gün-tipine göre ciro tahmini. Panel'deki "kaç gün
            // dayanır" KABA oran (kasa / günlük yük); bu ise HANGİ GÜN dibi
            // göreceğini söyler. İkisi ayrı iş — Panel ambient uyarı, burası
            // tarih planlaması. Alan yoksa eski kasa yeterliliği gösterilir.
            etiket: kokpit?.en_dusuk_tarih ? 'En düşük bakiye' : 'Kasa yeterliliği',
            deger: kokpit?.en_dusuk_bakiye != null
              ? fmt(sayi(kokpit.en_dusuk_bakiye))
              : (yedi > 0 ? `%${trSayi(Math.min(999, (kasa / yedi) * 100), 0)}` : '—'),
            alt: kokpit?.en_dusuk_tarih
              ? `${kisaTarih(kokpit.en_dusuk_tarih)} · 31 gün projeksiyonunun dibi`
              : '7 günlük yük',
            renk: kokpit?.en_dusuk_bakiye != null
              ? (sayi(kokpit.en_dusuk_bakiye) < 0 ? R.kirmizi : sayi(kokpit.en_dusuk_bakiye) < sayi(kokpit.cikis_7) ? R.amber : R.yesil)
              : (yedi > 0 && kasa >= yedi ? R.yesil : R.amber),
          },
        ]} />
        {/* Projeksiyon NEGATİFE düşüyorsa bu bir tarih uyarısıdır — o güne kadar
            nakit girmezse kasa açığa düşer. Öneri-only; ödeme Bekleyen'de. */}
        {kokpit?.en_dusuk_bakiye != null && sayi(kokpit.en_dusuk_bakiye) < 0 && (
          <div style={{
            ...kartYuzey, padding: '12px 17px', marginBottom: 14, borderColor: `${R.kirmizi}55`,
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={{
              padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
              background: `${R.kirmizi}22`, color: R.kirmizi, whiteSpace: 'nowrap',
            }}>⚠ kasa dibe vuruyor</span>
            <span style={{ fontSize: 11.5, color: R.not }}>
              Mevcut vadeler ve ciro tahminiyle <b>{kisaTarih(kokpit.en_dusuk_tarih)}</b> günü kasa
              {' '}<b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(sayi(kokpit.en_dusuk_bakiye))}</b> seviyesine iniyor.
              {' '}O güne kadar tahsilat girmezse ödemeler karşılanmaz — erteleme/öteleme Bekleyen görünümünde.
            </span>
          </div>
        )}
        <Takvim
          gunler={gunler}
          onGun={(g) => onCekmece?.({
            tip: 'GÜNÜN ÖDEMELERİ',
            baslik: kisaTarih(g.iso),
            alt: `${g.adet} kalem · toplam ${fmt(g.tutar)}`,
            kpi: [
              { etiket: 'Gün toplamı', deger: fmt(g.tutar), renk: R.kirmizi },
              { etiket: 'Sonrası kasa', deger: fmt(kasa - g.tutar), renk: kasa - g.tutar >= 0 ? R.yesil : R.kirmizi },
            ],
            listeBaslik: 'Kalemler',
            satirlar: g._satirlar.map(o => ({ ad: o.baslik, detay: o.tip, tutar: fmt(o._tutar) })),
            not: 'Ödeme yapmak için Bekleyen görünümünü kullan — orada kalem kalem Öde/Ertele var.',
            aksiyonAd: 'Bekleyen ödemelere git',
            _hedef: '__gorunum:bekleyen',
          })}
        />
        {modalBlok}
        {borcOdeModali}
      </>
    );
  }

  // ── 3) Tedarikçi Bakiyesi ──────────────────────────────────────────────────
  if (gorunum === 'tedarikci') {
    const ted = (cari?.tedarikciler || []).map(t => ({
      ad: t.tedarikci || '—',
      acik: Math.max(0, sayi(t.hesaplanan_acik)),
      beyan: t.beyan_bakiye == null ? null : sayi(t.beyan_bakiye),
      fark: t.beyan_hesap_farki == null ? null : sayi(t.beyan_hesap_farki),
      kuyruk: sayi(t.bekleyen_vade_toplam),
      faturaAdet: sayi(t.fatura_adet_6ay),
      hacim: sayi(t.fatura_toplam_6ay),
      sonFatura: t.son_fatura,
      enYakinVade: t.en_yakin_vade,
      izVar: !!t.odeme_izi_var,
      _ham: t,
    }));
    const kritik = ted.filter(t => t.enYakinVade && String(t.enYakinVade).slice(0, 10) <= isoEkle(bugun, 3));
    const enBuyuk = ted.length ? ted.reduce((a, b) => (a.hacim > b.hacim ? a : b)) : null;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Aktif tedarikçi', deger: String(ted.length), alt: `${kritik.length} kritik (3 gün içinde)` },
          { etiket: 'Toplam açık bakiye', deger: fmt(sayi(cari?.toplam_hesaplanan_acik)), alt: 'hesaplanan · ödeme izi düşülmüş', renk: R.kirmizi },
          { etiket: 'Bekleyen vade sözü', deger: fmt(sayi(cari?.toplam_bekleyen_vade)), alt: 'ödeme kuyruğunda', renk: R.amber },
          { etiket: 'En büyük hacim', deger: enBuyuk ? enBuyuk.ad : '—', alt: enBuyuk ? `6 ay ${fmt(enBuyuk.hacim)}` : '—', renk: R.krem },
        ]} />
        {ted.length ? (
          <Tablo
            baslik="Tedarikçi bakiyesi"
            not="satıra tıkla → dosya + borç öde"
            kolonlar={[
              { ad: 'Tedarikçi' }, { ad: 'Açık bakiye', sag: true }, { ad: 'Beyan', sag: true },
              { ad: 'Fark', sag: true }, { ad: 'Kuyrukta', sag: true }, { ad: '6 ay hacim', sag: true }, { ad: 'Durum' },
            ]}
            satirlar={ted.map(t => {
              const uyumsuz = t.fark != null && Math.abs(t.fark) > Math.max(500, t.acik * 0.05);
              return {
                id: t.ad, _t: t,
                hucreler: [
                  { v: t.ad, kalin: true },
                  { v: fmt(t.acik), mono: true, sag: true, kalin: true, renk: t.acik > 0 ? R.kirmizi : R.not },
                  { v: t.beyan == null ? '—' : fmt(t.beyan), mono: true, sag: true },
                  { v: t.fark == null ? '—' : fmt(t.fark), mono: true, sag: true, renk: uyumsuz ? R.amber : R.not },
                  { v: fmt(t.kuyruk), mono: true, sag: true },
                  { v: fmt(t.hacim), mono: true, sag: true },
                  {
                    v: uyumsuz ? 'mutabakat farkı' : !t.izVar && t.acik > 0 ? 'ödeme izi yok' : 'normal',
                    rozet: uyumsuz ? R.amber : !t.izVar && t.acik > 0 ? R.kirmizi : R.yesil,
                  },
                ],
              };
            })}
            onSatir={(row) => {
              const t = row._t;
              onCekmece?.({
                tip: 'TEDARİKÇİ DOSYASI',
                baslik: t.ad,
                alt: `6 ayda ${t.faturaAdet} fatura · son ${kisaTarih(t.sonFatura)}`,
                kpi: [
                  { etiket: 'Hesaplanan açık', deger: fmt(t.acik), renk: R.kirmizi },
                  { etiket: 'Tedarikçi beyanı', deger: t.beyan == null ? '—' : fmt(t.beyan) },
                  { etiket: 'Kuyrukta', deger: fmt(t.kuyruk), renk: R.amber },
                  { etiket: 'En yakın vade', deger: kisaTarih(t.enYakinVade) },
                ],
                listeBaslik: '6 aylık hareket',
                satirlar: [
                  { ad: 'Fatura toplamı', detay: `${t.faturaAdet} belge`, tutar: fmt(t.hacim) },
                  { ad: 'Açılış devri', detay: 'sistem öncesi beyan', tutar: fmt(sayi(t._ham.devir)) },
                ],
                not: t.fark != null && Math.abs(t.fark) > Math.max(500, t.acik * 0.05)
                  ? 'İKİ GÖZ UYUŞMUYOR: tedarikçinin beyanı ile bizim hesabımız arasında fark var — eksik fatura, eksik ödeme kaydı ya da sistem-öncesi bakiye olabilir. Hüküm insanın.'
                  : 'Beyan ile hesap uyumlu görünüyor.',
                aksiyonlar: [
                  { ad: `💸 Borç öde${t.acik > 0 ? ` · ${fmt(t.acik)}` : ''}`, birincil: true,
                    onTikla: () => borcOdeAc(t.ad, t.acik) },
                  { ad: 'Cari ekstreyi aç', onTikla: () => onKopru?.('__modul:belge:cari') },
                ],
              });
            }}
          />
        ) : (
          <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
            Tedarikçi cari verisi bulunamadı.
          </div>
        )}
        {modalBlok}
        {borcOdeModali}
      </>
    );
  }

  // ── 4) Ödeme Geçmişi ───────────────────────────────────────────────────────
  const toplamOdenen = gecmis.reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0);
  const kartla = gecmis.filter(r => r.islem_turu === 'KART_ODEME');
  const ayAdi = `${AY_KISA[Number(ay.slice(5, 7)) - 1]} ${ay.slice(0, 4)}`;
  return (
    <>
      <KpiSeridi kpiler={[
        { etiket: `${ayAdi} ödemesi`, deger: fmt(toplamOdenen), alt: `${gecmis.length} kayıt` },
        { etiket: 'Kartla ödenen', deger: fmt(kartla.reduce((s, r) => s + Math.abs(sayi(r.tutar)), 0)), alt: `${kartla.length} kayıt`, renk: R.amber },
        { etiket: 'Gecikmiş kalan', deger: fmt(gecikmisToplam), alt: gecikmisSatir.length ? `${gecikmisSatir.length} kalem` : 'gecikme yok', renk: gecikmisSatir.length ? R.kirmizi : R.yesil },
        { etiket: 'Kasa', deger: fmt(kasa), alt: 'anlık bakiye', renk: kasa >= 0 ? R.yesil : R.kirmizi },
      ]} />
      {/* DUYU 5/6 — VADE DİSİPLİNİ: plan vadesi ↔ gerçek ödeme günü (salt-okur).
          Koç Finans vakası tam bu kör noktadandı — gecikme deseni artık görünür. */}
      {vade && sayi(vade.odenen_plan) > 0 && (
        <div style={{
          ...kartYuzey, padding: '16px 18px', marginBottom: 14,
          border: sayi(vade.gec) > 0 ? `1px solid ${R.amber}44` : kartYuzey.border,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
          }}>
            <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
              📅 Vade disiplini · son {sayi(vade.kesit_gun)} gün
            </span>
            <span style={{ fontSize: 10.5, color: R.not2 }}>plan vadesi ↔ gerçek ödeme günü · negatif = erken</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span>Ödenen plan <b style={{ fontFamily: F.mono }}>{sayi(vade.odenen_plan)}</b></span>
            <span>ort. sapma <b style={{ fontFamily: F.mono, color: sayi(vade.ort_gecikme_gun) > 0 ? R.amber : R.yesil }}>{vade.ort_gecikme_gun > 0 ? '+' : ''}{vade.ort_gecikme_gun ?? '—'} gün</b></span>
            <span>erken/zamanında <b style={{ fontFamily: F.mono, color: R.yesil }}>{sayi(vade.erken) + sayi(vade.zamaninda)}</b></span>
            <span>hafif geç (≤3g) <b style={{ fontFamily: F.mono, color: R.amber }}>{sayi(vade.hafif_gec)}</b></span>
            <span>geç (&gt;3g) <b style={{ fontFamily: F.mono, color: sayi(vade.gec) > 0 ? R.kirmizi : R.yesil }}>{sayi(vade.gec)}</b>{vade.gec_orani_yuzde != null ? ` · %${vade.gec_orani_yuzde}` : ''}</span>
          </div>
          {(vade.en_gecler || []).slice(0, 4).map((g, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
              padding: '7px 0', borderTop: i === 0 ? `1px solid ${R.cizgi2}` : 'none', marginTop: i === 0 ? 10 : 0,
            }}>
              <span style={{ fontFamily: F.mono, fontWeight: 700, color: R.kirmizi, minWidth: 58 }}>+{g.gecikme_gun} gün</span>
              <span style={{ flex: 1, color: R.metin2 }}>{g.aciklama || '—'}</span>
              <span style={{ fontFamily: F.mono, fontWeight: 700 }}>{fmt(sayi(g.tutar))}</span>
            </div>
          ))}
        </div>
      )}
      {/* ── TEDARİKÇİ ÖDEMELERİ · NAKİT + KART BİRLEŞİK (soru 3/9) ──
          Alttaki liste KASA defterinden gelir; kartla yapılan tedarikçi
          ödemesini GÖREMEZ (kasadan para çıkmaz). Bu blok iki kanalı
          tedarikçi bağıyla birleştirir. Nakit satırlar ALTTAKİ listede de
          görünür — o yüzden ayrı blok, toplamlar toplanMAZ. */}
      {Array.isArray(tedOdeme) && tedOdeme.length > 0 && (() => {
        const ayli = tedOdeme.filter((r) => String(r.tarih || '').startsWith(ay));
        const kaynak = ayli.length ? ayli : tedOdeme.slice(0, 30);
        const suzulmus = tedKanal ? kaynak.filter((r) => r.odeme_yontemi === tedKanal) : kaynak;
        const tNakit = kaynak.filter((r) => r.odeme_yontemi === 'nakit').reduce((s, r) => s + sayi(r.tutar), 0);
        const tKart = kaynak.filter((r) => r.odeme_yontemi === 'kart').reduce((s, r) => s + sayi(r.tutar), 0);
        return (
          <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 11, flexWrap: 'wrap', gap: 8,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                🤝 Tedarikçi ödemeleri · nakit + kart{ayli.length ? ` · ${ayAdi}` : ' · son kayıtlar'}
              </span>
              <span style={{ fontSize: 12, color: R.not }}>
                nakit <b style={{ fontFamily: F.mono, color: R.yesil }}>{fmt(tNakit)}</b>
                {' · '}kart <b style={{ fontFamily: F.mono, color: R.amber }}>{fmt(tKart)}</b>
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[['', 'tümü'], ['nakit', 'nakit'], ['kart', 'kart']].map(([k, adx]) => (
                <div key={k || 'tum'} onClick={() => setTedKanal(k)} style={{
                  padding: '5px 12px', borderRadius: 99, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${tedKanal === k ? R.bakir : R.cizgi3}`,
                  color: tedKanal === k ? R.bakir : R.not,
                  background: tedKanal === k ? 'rgba(217,154,78,.14)' : 'transparent',
                }}>{adx}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {suzulmus.slice(0, 14).map((r, i) => (
                <div key={`${r.vadeli_id || ''}-${i}`} style={{
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                  padding: '7px 11px', borderRadius: 9, background: R.girinti,
                }}>
                  <span style={{ fontFamily: F.mono, color: R.not, flexShrink: 0, width: 52 }}>{kisaTarih(r.tarih)}</span>
                  <span style={{
                    flexShrink: 0, padding: '2px 9px', borderRadius: 99, fontSize: 10, fontWeight: 700,
                    background: r.odeme_yontemi === 'kart' ? `${R.amber}1e` : `${R.yesil}1e`,
                    color: r.odeme_yontemi === 'kart' ? R.amber : R.yesil,
                  }}>{r.odeme_yontemi}</span>
                  <span style={{ fontWeight: 700, flexShrink: 0, minWidth: 100 }}>{r.tedarikci || '—'}</span>
                  <span style={{
                    flex: 1, minWidth: 0, color: R.not2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{r.vadeli_aciklama || r.aciklama || ''}</span>
                  <span style={{ fontFamily: F.mono, fontWeight: 700, flexShrink: 0 }}>{fmt(sayi(r.tutar))}</span>
                </div>
              ))}
              {!suzulmus.length && (
                <div style={{ fontSize: 12, color: R.not3, padding: '6px 0' }}>Bu kanalda kayıt yok.</div>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 8 }}>
              ℹ Nakit satırlar alttaki kasa listesinde de görünür — iki blok toplanmaz.
              Kart satırları yalnız burada (kasadan para çıkmadığı için kasa defterinde yoktur).
            </div>
          </div>
        );
      })()}

      {gecmis.length ? (
        <Tablo
          baslik={`Ödeme geçmişi · ${ayAdi}`}
          not="satıra tıkla → kayıt ayrıntısı"
          kolonlar={[
            { ad: 'Tarih' }, { ad: 'Açıklama' }, { ad: 'Yöntem' }, { ad: 'Tutar', sag: true }, { ad: 'Kaynak' },
          ]}
          satirlar={gecmis.slice(0, 120).map(r => ({
            id: r.id, _r: r,
            hucreler: [
              { v: kisaTarih(r.tarih), mono: true },
              { v: r.aciklama || YONTEM[r.islem_turu] || 'Ödeme', kalin: true },
              { v: YONTEM[r.islem_turu] || slugAd(r.islem_turu), rozet: r.islem_turu === 'KART_ODEME' ? R.amber : R.yesil },
              { v: fmt(Math.abs(sayi(r.tutar))), mono: true, sag: true },
              { v: r.kaynak_tablo || '—', renk: R.not },
            ],
          }))}
          onSatir={(row) => {
            const r = row._r;
            onCekmece?.({
              tip: 'ÖDEME KAYDI',
              baslik: r.aciklama || 'Ödeme',
              alt: `${kisaTarih(r.tarih)} · ${YONTEM[r.islem_turu] || slugAd(r.islem_turu)}`,
              kpi: [
                { etiket: 'Tutar', deger: fmt(Math.abs(sayi(r.tutar))) },
                { etiket: 'İşlem türü', deger: slugAd(r.islem_turu) },
              ],
              listeBaslik: 'Kaynak bağlantısı',
              satirlar: [
                { ad: 'Kaynak tablo', detay: 'kasa izi', tutar: r.kaynak_tablo || '—' },
                { ad: 'Kasa etkisi', detay: 'deftere işlendi', tutar: fmt(sayi(r.tutar)) },
              ],
              not: 'Bu kayıt kasa izinden geliyor — plan durumu bu izden türer, elle işaretleme yoktur.',
              aksiyonAd: 'İşlem defterini aç',
              _hedef: '__modul:rapor:defter',
            });
          }}
        />
      ) : (
        <div style={{ ...kartYuzey, padding: '38px 30px', textAlign: 'center', color: R.not }}>
          {ayAdi} ayında ödeme kaydı yok.
        </div>
      )}
      {modalBlok}
      {borcOdeModali}
    </>
  );
}
