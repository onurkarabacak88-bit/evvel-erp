// ─────────────────────────────────────────────────────────────────────────────
// 🏠 KİRALIK MÜLKLER — Evvel'in İÇİNDE ama AYRI MANTIKTA çalışan sistem
//
// 🔴 NEDEN (sahip 2026-09-08/09):
//   · "kiralık mülklerimizin takip alanını kurmak istiyorum; sadece o sayfaya
//      girince kendi içinde sekmeleri ve çalışma metodu olan bir alan"
//   · "bu kasa izi, kahveci dükkânın kasa izinden ayrışmalı"
//   · "toplam kasa diye yeni bir isimde şu andaki kasa görünsün"
//   · "ev sembolleri ayrı ayrı olmalı" · "kira elden mi havale mi seçebilmeli"
//   · "kiracı değiştiğinde sistemden değişim yapabilmeliyim"
//   · "elektrik vs abonelikleri takip edebilmeliyim" · "tıklayınca açılmalı"
//   · "bütün çekmece ve tıklanabilirliği kur"  → bu dosyanın ikinci turu
//
// ⚠️ KAHVE İŞİYLE TEK KESİŞME NOKTASI:
//        TOPLAM KASA  =  TULİPİ kasası  +  MÜLK kasası
// Mülk hareketleri TULİPİ'nin cirosuna, giderine, P&L'ine GİRMEZ.
//
// ── ÇEKMECE DOKTRİNİ (mimari tur 2026-09-09) ────────────────────────────────
// 1. KAPI ANCAK ARKASINDA İÇERİK VARSA AÇILIR. İçerik yoksa `onTikla`
//    verilmez ve satır düz metin kalır. Boş kapı çıkmaz sokaktan beterdir:
//    kullanıcı bir kez tıklar, hiçbir şey görmez, bir daha tıklamaz.
// 2. GERİ YOLU ÇAĞIRANA AİTTİR. Aynı çekmeceye birden çok kapıdan girilebilir;
//    bu yüzden `geri` sabit yazılmaz, parametre olarak geçer. Kök kapıdan
//    açılınca `geri` verilmez → düğme hiç çizilmez (sahte geri yasağı).
// 3. HATA ≠ BOŞ. Async çekmeceler önce iskeletle açılır; uç düşerse çekmece
//    AÇIK KALIR ve "okunamadı" der. "Kayıt yok" demek yalan olurdu.
// 4. EKRAN KENDİ ARİTMETİĞİNİ KURMAZ. Sunucunun verdiği rakamlar yan yana
//    dizilir; SÜZMEK (filtrelemek) aritmetik değildir, HESAPLAMAK aritmetiktir.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { Tablo, HataBandi, BosDurum, KpiSeridi } from './parcalar';

// 🏠 Mülk sembolleri — sahip: "ev sembolleri ayrı ayrı olmalı".
// Amaç süs değil AYIRT ETME: listede mülkü adres okumadan gözle bulmak.
const SIMGELER = ['🏠', '🏡', '🏢', '🏬', '🏘️', '🏚️', '🏪', '🏭', '🛖', '🏛️', '🚪', '🅿️'];
const MULK_TURU = ['daire', 'dükkan', 'depo', 'ofis', 'arsa', 'diğer'];
const ABONELIK_TURU = [
  { id: 'elektrik', ad: 'Elektrik', simge: '⚡' },
  { id: 'su', ad: 'Su', simge: '💧' },
  { id: 'dogalgaz', ad: 'Doğalgaz', simge: '🔥' },
  { id: 'internet', ad: 'İnternet', simge: '🌐' },
  { id: 'aidat', ad: 'Aidat', simge: '🏢' },
  { id: 'diger', ad: 'Diğer', simge: '📄' },
];

// Hareket türlerinin insan dili + ne anlama geldiği.
// ⚠️ TEK YER: hem defter tablosu hem çekmece aynı sözlüğü okur. İki yerde ayrı
// yazılsaydı bir gün "MULK_GIDER" iki farklı şey anlatırdı.
const TUR_AD = {
  KIRA_TAHSILAT: 'Kira tahsilatı',
  DEPOZITO_ALINDI: 'Depozito alındı',
  DEPOZITO_IADE: 'Depozito iadesi',
  MULK_GIDER: 'Mülk gideri',
  MULK_AKTARIM_CIKIS: "Mülkten TULİPİ'ye çıkış",
  VARLIK_SATISI: 'Varlık satışı',
};
const TUR_ANLAM = {
  KIRA_TAHSILAT: 'Kira geliri. Mülk defterine girer, kahve işinin cirosuna girmez.',
  DEPOZITO_ALINDI: 'Emanet — GELİR DEĞİL. Kiracı çıkarken iade edilecek para.',
  DEPOZITO_IADE: 'Emanetin geri verilmesi. Yükümlülük kapanır.',
  MULK_GIDER: "Aidat, fatura, tadilat. Kahve işinin P&L'ine hiç girmez.",
  MULK_AKTARIM_CIKIS: 'Para dükkâna geçti. Mülk defterinden düşer, TULİPİ '
    + 'kasasına eklenir — TOPLAM KASA DEĞİŞMEZ.',
  VARLIK_SATISI: 'Mülk satışı. Gelir sayılmaz; varlık el değiştirdi.',
};

const alanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const etiketStil = {
  fontSize: 10.5, letterSpacing: '.7px', textTransform: 'uppercase',
  color: R.not2, fontWeight: 700, marginBottom: 6, display: 'block',
};
const dugme = {
  padding: '9px 16px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: 12, fontWeight: 600, border: `1px solid ${R.cizgi3}`,
  background: 'transparent', color: R.metin2,
};
const dugmeAna = {
  padding: '9px 20px', borderRadius: 9, border: 'none', cursor: 'pointer',
  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};

const sayi = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const fmt = (v) => sayi(v).toLocaleString('tr-TR', {
  minimumFractionDigits: 0, maximumFractionDigits: 0,
}) + ' ₺';
const bugun = () => new Date().toISOString().slice(0, 10);
const AY_AD = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz',
  'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const donemAd = (d) => {
  const [y, a] = String(d || '').split('-');
  return AY_AD[Number(a) - 1] ? `${AY_AD[Number(a) - 1]} ${y}` : String(d || '—');
};
const yontemAd = (y) => ({
  havale: '🏦 havale', elden: '💵 elden', nakit: '💵 nakit', kart: '💳 kart',
}[String(y || '')] || '⚠ yöntem yazılmamış');

// ═══════════════════════════════════════════════════════════════════
export default function MulkModulu({ gorunum, onCekmece, onKopru, onToast }) {
  const [kasa, setKasa] = useState(null);
  const [mulkler, setMulkler] = useState(null);
  const [kiracilar, setKiracilar] = useState(null);
  const [sozlesmeler, setSozlesmeler] = useState(null);
  const [tahsilat, setTahsilat] = useState(null);
  const [abonelikler, setAbonelikler] = useState(null);
  const [defter, setDefter] = useState(null);
  const [goc, setGoc] = useState(null);
  const [hata, setHata] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [form, setForm] = useState(null);   // { tip, veri }

  const yukle = useCallback(async () => {
    setHata(null);
    try {
      const [k, m, kr, sz] = await Promise.all([
        api('/api/mulk/kasa'),
        api('/api/mulk'),
        api('/api/mulk/kiraci'),
        api('/api/mulk/sozlesme'),
      ]);
      setKasa(k); setMulkler(m); setKiracilar(kr); setSozlesmeler(sz);
    } catch (e) {
      setHata(String(e?.message || e));
    }
  }, []);

  useEffect(() => { yukle(); }, [yukle]);

  const gorunumYukle = useCallback(async (g) => {
    try {
      if (g === 'tahsilat') setTahsilat(await api('/api/mulk/tahsilat'));
      else if (g === 'abonelik') setAbonelikler(await api('/api/mulk/abonelik'));
      else if (g === 'defter') setDefter(await api('/api/mulk/defter'));
      else if (g === 'goc') setGoc(await api('/api/mulk/goc-adaylari'));
    } catch (e) { setHata(String(e?.message || e)); }
  }, []);

  useEffect(() => { gorunumYukle(gorunum); }, [gorunum, gorunumYukle]);

  const cagir = async (yol, yontem, govde) => {
    setMesgul(true);
    try {
      const r = await api(yol, { method: yontem, body: JSON.stringify(govde) });
      onToast?.(r?.islem ? `✅ ${r.islem}` : '✅ kaydedildi');
      setForm(null);
      await yukle();
      await gorunumYukle(gorunum);
      return r;
    } catch (e) {
      onToast?.(`⚠ ${String(e?.message || e)}`);
      throw e;
    } finally { setMesgul(false); }
  };

  // ⚠️ Form açan her aksiyon önce çekmeceyi KAPATIR: çekmece kendi verisini
  // yenilemez; açık kalırsa kayıt sonrası BAYAT rakam gösterir.
  const formAc = (tip, veri) => { onCekmece?.(null); setForm({ tip, veri }); };

  // ═════════════════════════════════════════════════════════════════
  // ÇEKMECELER
  // ═════════════════════════════════════════════════════════════════

  // ── MÜLK HAREKETİ — diğer beş çekmecenin ORTAK alt kapısı ────────
  const mulkHareketiAc = (h, geri) => {
    const tur = String(h.tur || '');
    const iptalEdilebilir = tur === 'KIRA_TAHSILAT' || tur === 'MULK_GIDER';
    const bendenGeri = { ad: TUR_AD[tur] || 'hareket',
      onTikla: () => mulkHareketiAc(h, geri) };
    onCekmece?.({
      tip: 'MÜLK HAREKETİ',
      baslik: TUR_AD[tur] || tur.replace(/_/g, ' '),
      alt: `${h.tarih} · ${h.mulk_ad || 'mülke bağlı değil'}`,
      geri,
      kpi: [
        { etiket: 'Tutar', deger: fmt(h.tutar),
          renk: sayi(h.tutar) < 0 ? R.kirmizi : R.yesil },
        { etiket: 'Kasa izi', deger: h.kasa_iz ? '✓ var' : '⚠ YOK',
          renk: h.kasa_iz ? R.yesil : R.kirmizi },
        { etiket: 'Kasa çekmecesi',
          deger: h.kasa_defter === 'MULK' ? 'MÜLK' : (h.kasa_defter || '—'),
          renk: h.kasa_defter === 'MULK' ? R.yesil
            : h.kasa_defter ? R.amber : R.not3 },
        { etiket: 'Yöntem', deger: yontemAd(h.odeme_yontemi),
          renk: h.odeme_yontemi ? R.krem : R.amber },
      ],
      listeBaslik: 'Bu satır ne anlatıyor',
      satirlar: [
        { ad: 'Bu tür ne demek', detay: TUR_ANLAM[tur] || 'tanımsız tür', tutar: '' },
        ...(h.mulk_id ? [{
          ad: 'Mülk ›', detay: h.mulk_ad || '—', tutar: '',
          onTikla: () => mulkDosyasiAc(
            { id: h.mulk_id, ad: h.mulk_ad, simge: h.mulk_simge }, bendenGeri),
        }] : []),
        ...(h.kiraci_id ? [{
          ad: 'Kiracı ›', detay: h.kiraci_ad || '—', tutar: '',
          onTikla: () => kiraciDosyasiAc(
            { id: h.kiraci_id, ad: h.kiraci_ad }, bendenGeri),
        }] : []),
        { ad: 'Hangi ayın kirası',
          detay: h.donem ? donemAd(h.donem)
            : 'yazılmamış — en eski açık aydan kapatılır (FIFO)',
          tutar: '', solgun: !h.donem },
        { ad: 'Kasa satırı',
          detay: h.kasa_iz
            ? `${String(h.kasa_iz).slice(0, 8)}… · ${h.kasa_turu || '—'} · ${h.kasa_defter || '—'}`
            : '⚠ BU SATIR KASAYA YANSIMAMIŞ — mülk kasası bu tutarı içermiyor',
          tutar: '' },
        ...(h.kaynak_kasa_id ? [{
          ad: 'Eski kayıttan geldi',
          detay: 'Göç aynası — eski "dış kaynak" kaydına dokunulmadı, '
            + 'karşısına bu satır yazıldı.',
          tutar: '', solgun: true,
        }] : []),
        ...(h.aciklama ? [{ ad: 'Açıklama', detay: h.aciklama, tutar: '' }] : []),
      ],
      dosyaBilgi: {
        Kimlik: String(h.id || '').slice(0, 8) + '…',
        'Yazıldığı an': String(h.olusturma || '').slice(0, 19) || '—',
        'Kaynak kasa kaydı': h.kaynak_kasa_id
          ? String(h.kaynak_kasa_id).slice(0, 8) + '…' : '—',
      },
      // ⚠️ İPTAL DÜĞMESİ YALNIZ İKİ TÜRDE: sunucu diğerlerinde kasa ters kaydı
      // yazmıyor; tek taraflı iptal iki defteri ayrıştırırdı.
      aksiyonlar: iptalEdilebilir ? [{
        ad: 'Bu hareketi iptal et',
        onTikla: async () => {
          // eslint-disable-next-line no-alert
          if (!window.confirm(`${TUR_AD[tur]} — ${fmt(h.tutar)} iptal edilsin mi?\n\nSatır silinmez, "iptal" işaretlenir; kasa karşılığı ters kayıtla kapanır.`)) return;
          onCekmece?.(null);
          try {
            await api(`/api/mulk/hareket/${h.id}`, { method: 'DELETE' });
            onToast?.('✅ hareket iptal edildi');
            await yukle(); await gorunumYukle(gorunum);
          } catch (e) { onToast?.(`⚠ ${String(e?.message || e)}`); }
        },
      }] : undefined,
      not: h.kasa_iz ? undefined
        : 'Bu hareketin kasa izi yok. Mülk kasası bu tutarı İÇERMİYOR — '
          + 'satır iptal edilip yeniden yazılmalı.',
    });
  };

  // ── MÜLK DOSYASI ────────────────────────────────────────────────
  const mulkDosyasiAc = async (m, geri) => {
    const bendenGeri = { ad: `${m.simge || '🏠'} ${m.ad}`,
      onTikla: () => mulkDosyasiAc(m, geri) };
    onCekmece?.({
      tip: 'MÜLK DOSYASI', baslik: `${m.simge || '🏠'}  ${m.ad}`,
      alt: 'yükleniyor…', geri, satirlar: [],
    });
    let d = null;
    try { d = await api(`/api/mulk/${m.id}/dosya`); }
    catch (e) {
      onCekmece?.({
        tip: 'MÜLK DOSYASI', baslik: `${m.simge || '🏠'}  ${m.ad}`,
        alt: 'okunamadı', geri, satirlar: [],
        not: `Dosya okunamadı: ${String(e?.message || e)}. Rakam uydurulmadı.`,
      });
      return;
    }
    const mm = d.mulk || m;
    const s = d.sozlesmeler || [];
    const aktif = s.find((x) => x.durum === 'aktif');
    const har = d.hareketler || [];
    onCekmece?.({
      tip: 'MÜLK DOSYASI',
      baslik: `${mm.simge || '🏠'}  ${mm.ad}`,
      alt: [mm.bina, mm.birim, mm.tur].filter(Boolean).join(' · ')
        || mm.adres || 'adres girilmemiş',
      geri,
      kpi: [
        { etiket: 'Durum', deger: aktif ? 'DOLU' : 'BOŞ',
          renk: aktif ? R.yesil : R.amber },
        { etiket: 'Aylık kira', deger: aktif ? fmt(aktif.aylik_kira) : '—' },
        { etiket: 'Kiracı geçmişi', deger: `${d.kiraci_gecmisi || 0} sözleşme` },
        { etiket: 'Toplam tahsil', deger: fmt(d.toplam_kira) },
      ],
      listeBaslik: 'Dosya içeriği',
      satirlar: [
        ...(aktif ? [{
          ad: `Kiracı: ${aktif.kiraci_ad} ›`,
          detay: `${aktif.baslangic}'den beri · her ayın ${aktif.odeme_gunu}'i`,
          tutar: '',
          onTikla: () => kiraciDosyasiAc(
            { id: aktif.kiraci_id, ad: aktif.kiraci_ad }, bendenGeri),
        }] : []),
        ...(s.length ? [{ ad: '— KİRACI GEÇMİŞİ —', detay: `${s.length} sözleşme`, tutar: '', solgun: true }] : []),
        ...s.map((x) => ({
          ad: `${x.kiraci_ad}${x.durum === 'aktif' ? '  ●' : ''}`,
          detay: [`${x.baslangic} → ${x.bitis || 'sürüyor'}`, x.durum,
            sayi(x.depozito) ? `depozito ${fmt(x.depozito)}` : null,
            x.kiraci_tipi === 'isyeri' ? `işyeri · stopaj %${x.stopaj_orani}` : null,
          ].filter(Boolean).join(' · '),
          tutar: fmt(x.aylik_kira),
          onTikla: () => kiraDosyasiAc({ ...x, mulk_ad: mm.ad, mulk_id: mm.id }, bendenGeri),
        })),
        ...(d.abonelikler?.length ? [{ ad: '— ABONELİKLER —', detay: `${d.abonelikler.length} kayıt`, tutar: '', solgun: true }] : []),
        ...(d.abonelikler || []).map((a) => {
          const t = ABONELIK_TURU.find((x) => x.id === a.tur);
          const riskli = a.abone_kime === 'sahip' && a.odeyen === 'kiraci';
          return {
            ad: `${t?.simge || '📄'} ${t?.ad || a.tur}${riskli ? '  ⚠' : ''}`,
            detay: [`abone: ${a.abone_kime === 'sahip' ? 'siz' : 'kiracı'}`,
              `ödeyen: ${a.odeyen === 'sahip' ? 'siz' : 'kiracı'}`,
              a.saglayici].filter(Boolean).join(' · ')
              + (riskli ? ' — kiracı ödemezse borç SİZE kalır' : ''),
            tutar: a.aylik_tahmin ? fmt(a.aylik_tahmin) : '',
            onTikla: () => abonelikDosyasiAc(
              { ...a, mulk_ad: mm.ad, mulk_simge: mm.simge }, bendenGeri),
          };
        }),
        ...(har.length ? [{
          ad: '— PARA HAREKETLERİ —',
          // ⚠️ SESSİZ ELEME YASAK: kaç tanesinin göründüğü söylenir.
          detay: har.length > 40
            ? `${har.length} hareketin en yeni 40'ı burada`
            : `${har.length} satır`,
          tutar: '', solgun: true,
        }] : []),
        ...har.slice(0, 40).map((h) => ({
          ad: TUR_AD[h.tur] || h.tur.replace(/_/g, ' '),
          detay: [h.tarih, h.kiraci_ad, yontemAd(h.odeme_yontemi),
            h.kasa_iz ? 'kasa izi ✓' : '⚠ kasa izi YOK'].filter(Boolean).join(' · '),
          tutar: fmt(h.tutar),
          onTikla: () => mulkHareketiAc(
            { ...h, mulk_ad: mm.ad, mulk_simge: mm.simge, mulk_id: mm.id }, bendenGeri),
        })),
      ],
      dosyaBilgi: {
        Bina: mm.bina || '—', Birim: mm.birim || '—',
        Adres: mm.adres || '—', Tür: mm.tur || '—',
        Not: mm.notlar || '—',
        Kimlik: String(mm.id || '').slice(0, 8) + '…',
      },
      aksiyonlar: aktif ? [
        { ad: 'Tahsilat yaz', birincil: true, onTikla: () => tahsilatFormuAc(aktif) },
        { ad: 'Kiracı değişimi',
          onTikla: () => devirFormuAc({ ...aktif, mulk_ad: mm.ad }) },
        { ad: 'Mülkü düzenle', onTikla: () => formAc('mulk', { ...mm }) },
      ] : [
        { ad: '+ Sözleşme aç', birincil: true,
          onTikla: () => formAc('sozlesme', { mulk_id: mm.id }) },
        { ad: 'Mülkü düzenle', onTikla: () => formAc('mulk', { ...mm }) },
      ],
    });
  };

  // ── KİRA DOSYASI (sözleşme) ─────────────────────────────────────
  const kiraDosyasiAc = async (soz, geri) => {
    const bendenGeri = { ad: `${soz.kiraci_ad} kira dosyası`,
      onTikla: () => kiraDosyasiAc(soz, geri) };
    onCekmece?.({ tip: 'KİRA DOSYASI', baslik: soz.kiraci_ad || 'sözleşme',
      alt: 'yükleniyor…', geri, satirlar: [] });

    let t = tahsilat;
    let hareketler = [];
    try {
      if (!t) { t = await api('/api/mulk/tahsilat'); setTahsilat(t); }
      const d = await api(`/api/mulk/defter?sozlesme_id=${encodeURIComponent(soz.id)}`);
      hareketler = d.satirlar || [];
    } catch (e) {
      onCekmece?.({ tip: 'KİRA DOSYASI', baslik: soz.kiraci_ad || 'sözleşme',
        alt: 'okunamadı', geri, satirlar: [],
        not: `Okunamadı: ${String(e?.message || e)}. Rakam uydurulmadı.` });
      return;
    }
    const r = (t?.satirlar || []).find((x) => x.sozlesme_id === soz.id);
    const tahsilatlar = hareketler.filter((h) => h.tur === 'KIRA_TAHSILAT');
    const depozitolar = hareketler.filter((h) => String(h.tur).startsWith('DEPOZITO'));

    onCekmece?.({
      tip: 'KİRA DOSYASI',
      baslik: soz.kiraci_ad || r?.kiraci_ad || 'sözleşme',
      alt: [soz.mulk_ad || r?.mulk_ad,
        `${soz.baslangic || r?.baslangic}'den beri`,
        `her ayın ${soz.odeme_gunu || r?.odeme_gunu || 1}'i`,
        soz.durum && soz.durum !== 'aktif' ? `⚠ ${soz.durum}` : null,
      ].filter(Boolean).join(' · '),
      geri,
      kpi: r ? [
        { etiket: 'Beklenen', deger: fmt(r.beklenen) },
        { etiket: 'Alınan', deger: fmt(r.alinan) },
        { etiket: 'Bakiye', deger: fmt(r.bakiye),
          renk: r.bakiye > 0.5 ? R.kirmizi : r.bakiye < -0.5 ? R.yesil : R.metin2 },
        { etiket: 'Durum',
          deger: r.durum === 'borclu' ? `${r.gecikme_ay} ay geride`
            : r.durum === 'pesin' ? 'peşin ödemiş' : 'güncel',
          renk: r.durum === 'borclu' ? R.kirmizi
            : r.durum === 'pesin' ? R.yesil : R.metin2 },
      ] : [
        { etiket: 'Aylık kira', deger: fmt(soz.aylik_kira) },
        { etiket: 'Durum', deger: soz.durum || '—', renk: R.amber },
      ],
      listeBaslik: 'Kira dosyası',
      satirlar: [
        // 🔍 "3 AY GERİDE" İDDİASININ KANITI — sahip 2026-09-09: "bence de görünmeli".
        // Bir rakama bakıp "bu nereden çıktı" diyememek bordroda DÖRT AY fark
        // edilmeyen bir eksik hesaba yol açmıştı.
        ...(r ? [{
          ad: 'Beklenen nasıl oluştu',
          detay: [
            `${r.ay_sayisi} ay yaşandı × ${fmt(r.aylik_kira)}/ay`,
            r.kiraci_tipi === 'isyeri' && r.stopaj_orani > 0
              ? `stopaj %${r.stopaj_orani} kaynağında kesiliyor → NET beklenir`
              : null,
            r.aylar?.length ? 'ay ay dökümü için tıkla' : null,
          ].filter(Boolean).join(' · '),
          tutar: fmt(r.beklenen),
          onTikla: r.aylar?.length ? () => kiraAylariAc(r, bendenGeri) : undefined,
        }] : []),
        ...(tahsilatlar.length
          ? [{ ad: '— TAHSİLATLAR —', detay: `${tahsilatlar.length} ödeme`, tutar: '', solgun: true }]
          : [{ ad: 'Tahsilat', detay: 'henüz ödeme kaydı yok', tutar: '', solgun: true }]),
        ...tahsilatlar.map((h) => ({
          ad: h.tarih,
          detay: [yontemAd(h.odeme_yontemi),
            h.donem ? donemAd(h.donem) : 'dönem yazılmamış (FIFO)',
            h.kasa_iz ? 'kasa izi ✓' : '⚠ kasa izi YOK'].join(' · '),
          tutar: fmt(h.tutar),
          onTikla: () => mulkHareketiAc(h, bendenGeri),
        })),
        {
          ad: 'Depozito',
          detay: [
            sayi(soz.depozito) ? `sözleşmede ${fmt(soz.depozito)}` : 'sözleşmede yazmıyor',
            depozitolar.length ? `defterde ${depozitolar.length} hareket`
              : '⚠ defterde hareket YOK',
          ].join(' · '),
          tutar: depozitolar.length
            ? fmt(depozitolar.reduce((a, b) => a + sayi(b.tutar), 0)) : '',
          onTikla: depozitolar.length
            ? () => mulkHareketiAc(depozitolar[0], bendenGeri) : undefined,
        },
        ...(soz.kiraci_id || r?.kiraci_id ? [{
          ad: 'Kiracı ›', detay: soz.kiraci_ad || r?.kiraci_ad || '—', tutar: '',
          onTikla: () => kiraciDosyasiAc(
            { id: soz.kiraci_id || r.kiraci_id, ad: soz.kiraci_ad || r.kiraci_ad },
            bendenGeri),
        }] : []),
        ...(soz.mulk_id || r?.mulk_id ? [{
          ad: 'Mülk ›', detay: soz.mulk_ad || r?.mulk_ad || '—', tutar: '',
          onTikla: () => mulkDosyasiAc(
            { id: soz.mulk_id || r.mulk_id, ad: soz.mulk_ad || r.mulk_ad }, bendenGeri),
        }] : []),
        { ad: 'Telefon', detay: r?.telefon || soz.telefon || 'yazılmamış', tutar: '',
          solgun: !(r?.telefon || soz.telefon) },
      ],
      not: t?.not,
      aksiyonlar: (soz.durum === 'aktif' || !soz.durum) ? [
        { ad: 'Tahsilat yaz', birincil: true, onTikla: () => tahsilatFormuAc(r || soz) },
        // 🔴 ESKİ CANLI HATA: alt çubuktaki "Kiracı değişimi" düğmesi tıklanan
        // satıra DEĞİL listenin İLK sözleşmesine form açıyordu. Artık aksiyon
        // çekmecenin kendi sözleşmesini taşıyor.
        { ad: 'Kiracı değişimi', onTikla: () => devirFormuAc(soz, r) },
      ] : undefined,
    });
  };

  // ── AY AY DAĞILIM ───────────────────────────────────────────────
  const kiraAylariAc = (r, geri) => onCekmece?.({
    tip: 'KİRA AYLARI',
    baslik: `${r.kiraci_ad} · ay ay dökümü`,
    alt: `${r.ay_sayisi} ay × ${fmt(r.aylik_kira)} · ${r.acik_ay} ay açık`,
    geri,
    kpi: [
      { etiket: 'Beklenen', deger: fmt(r.beklenen) },
      { etiket: 'Alınan', deger: fmt(r.alinan) },
      { etiket: 'Açık ay', deger: String(r.acik_ay ?? '—'),
        renk: r.acik_ay ? R.kirmizi : R.yesil },
      { etiket: 'Peşin kalan', deger: fmt(r.pesin_tutar),
        renk: sayi(r.pesin_tutar) > 0 ? R.yesil : R.not3 },
    ],
    listeBaslik: 'Aylar',
    satirlar: (r.aylar || []).map((a) => ({
      ad: donemAd(a.donem),
      detay: a.kapatan?.length
        ? a.kapatan.map((k) => `${k.tarih} · ${fmt(k.tutar)}`).join('  +  ')
          + (a.durum === 'kismi' ? `  → ${fmt(a.acik)} açık` : '')
        : '⚠ hiç ödeme düşmedi',
      tutar: fmt(a.beklenen),
      solgun: a.durum === 'kapandi',
    })),
    not: 'Hangi ödemenin hangi ayı kapattığı KAYDEDİLMEZ, burada hesaplanır: '
      + 'ödemeler tarih sırasıyla en eski açık aya yazılır. Bu yüzden 3 aylık '
      + 'toplu ödeme, yarım ödeme ve peşin ödeme aynı kuraldan çıkar.',
  });

  // ── KİRACI DOSYASI ──────────────────────────────────────────────
  const kiraciDosyasiAc = async (k, geri) => {
    const bendenGeri = { ad: `${k.ad} dosyası`, onTikla: () => kiraciDosyasiAc(k, geri) };
    onCekmece?.({ tip: 'KİRACI DOSYASI', baslik: k.ad || 'kiracı',
      alt: 'yükleniyor…', geri, satirlar: [] });
    let takma = [];
    let har = [];
    let t = tahsilat;
    try {
      const [a, b] = await Promise.all([
        api(`/api/mulk/kiraci/${encodeURIComponent(k.id)}/takma-ad`),
        api(`/api/mulk/defter?kiraci_id=${encodeURIComponent(k.id)}`),
      ]);
      takma = a.takma_adlar || [];
      har = b.satirlar || [];
      if (!t) { t = await api('/api/mulk/tahsilat'); setTahsilat(t); }
    } catch (e) {
      onCekmece?.({ tip: 'KİRACI DOSYASI', baslik: k.ad || 'kiracı',
        alt: 'okunamadı', geri, satirlar: [],
        not: `Okunamadı: ${String(e?.message || e)}. Rakam uydurulmadı.` });
      return;
    }
    const kiraciSoz = (sozlesmeler?.sozlesmeler || []).filter((x) => x.kiraci_id === k.id);
    const aktifSoz = kiraciSoz.find((x) => x.durum === 'aktif');
    const bak = (t?.satirlar || []).find((x) => x.kiraci_id === k.id);
    const kisi = (kiracilar?.kiracilar || []).find((x) => x.id === k.id) || k;
    const tahsilatlar = har.filter((h) => h.tur === 'KIRA_TAHSILAT');

    onCekmece?.({
      tip: 'KİRACI DOSYASI',
      baslik: kisi.ad || k.ad,
      alt: aktifSoz ? `${aktifSoz.mulk_ad} · ${fmt(aktifSoz.aylik_kira)}/ay`
        : 'aktif sözleşmesi yok',
      geri,
      kpi: [
        { etiket: 'Aktif mülk', deger: aktifSoz?.mulk_ad || '—' },
        { etiket: 'Aylık', deger: aktifSoz ? fmt(aktifSoz.aylik_kira) : '—' },
        { etiket: 'Bakiye', deger: bak ? fmt(bak.bakiye) : '—',
          renk: bak ? (bak.bakiye > 0.5 ? R.kirmizi
            : bak.bakiye < -0.5 ? R.yesil : R.metin2) : R.not3 },
        { etiket: 'Ödeme', deger: `${tahsilatlar.length} kayıt` },
      ],
      listeBaslik: 'Kiracı dosyası',
      satirlar: [
        ...(kiraciSoz.length ? [{ ad: '— SÖZLEŞMELER —', detay: `${kiraciSoz.length} kayıt`, tutar: '', solgun: true }] : []),
        ...kiraciSoz.map((x) => ({
          ad: `${x.mulk_ad}${x.durum === 'aktif' ? '  ●' : ''}`,
          detay: `${x.baslangic} → ${x.bitis || 'sürüyor'} · ${x.durum}`,
          tutar: fmt(x.aylik_kira),
          onTikla: () => kiraDosyasiAc(x, bendenGeri),
        })),
        ...(takma.length ? [{
          ad: '— BİLİNEN YAZIMLAR —',
          detay: 'banka ekstresi ve serbest metin bu adlarla eşleşir',
          tutar: '', solgun: true,
        }] : []),
        ...takma.map((ta) => ({
          ad: ta.takma_ad,
          detay: `kaynak: ${ta.kaynak || '—'} · ${String(ta.olusturma || '').slice(0, 10)}`,
          tutar: '',
          // ⚠️ AYIRMA KAPISI: birleştirme formu "kiracı dosyasından tek tek
          // ayırabilirsiniz" diye SÖZ VERİYOR. Sözü tutan yer burası.
          // Tek yazım kalmışsa ayırma yok — kişinin hiçbir adı kalmazdı.
          satirAksiyon: takma.length > 1 ? {
            ad: '×', ipucu: 'bu yazımı bu kişiden AYIR', renk: R.kirmizi,
            onTikla: async () => {
              // eslint-disable-next-line no-alert
              if (!window.confirm(`"${ta.takma_ad}" yazımı ${kisi.ad} kişisinden ayrılsın mı?\n\nBu yazımla gelen kayıtlar bir daha ona eşleşmez.`)) return;
              try {
                await api(`/api/mulk/kiraci/takma-ad/${encodeURIComponent(ta.takma_ad)}`,
                  { method: 'DELETE' });
                onToast?.('✅ yazım ayrıldı');
                await yukle();
                kiraciDosyasiAc(k, geri);
              } catch (e) { onToast?.(`⚠ ${String(e?.message || e)}`); }
            },
          } : undefined,
        })),
        ...(har.length ? [{ ad: '— PARA HAREKETLERİ —', detay: `${har.length} satır`, tutar: '', solgun: true }] : []),
        ...har.map((h) => ({
          ad: TUR_AD[h.tur] || h.tur.replace(/_/g, ' '),
          detay: [h.tarih, h.mulk_ad, yontemAd(h.odeme_yontemi)].filter(Boolean).join(' · '),
          tutar: fmt(h.tutar),
          onTikla: () => mulkHareketiAc(h, bendenGeri),
        })),
        { ad: 'Telefon', detay: kisi.telefon || 'yazılmamış', tutar: '',
          solgun: !kisi.telefon },
        ...(kisi.notlar ? [{ ad: 'Not', detay: kisi.notlar, tutar: '' }] : []),
      ],
      aksiyonlar: aktifSoz ? [
        { ad: 'Tahsilat yaz', birincil: true,
          onTikla: () => tahsilatFormuAc(bak || aktifSoz) },
        { ad: 'Kiracı değişimi', onTikla: () => devirFormuAc(aktifSoz, bak) },
        { ad: 'Düzenle', onTikla: () => formAc('kiraci', { ...kisi }) },
      ] : [
        { ad: '+ Sözleşme aç', birincil: true,
          onTikla: () => formAc('sozlesme', { kiraci_id: kisi.id }) },
        { ad: 'Düzenle', onTikla: () => formAc('kiraci', { ...kisi }) },
      ],
    });
  };

  // ── ABONELİK ────────────────────────────────────────────────────
  const abonelikDosyasiAc = (a, geri) => {
    const t = ABONELIK_TURU.find((x) => x.id === a.tur);
    const riskli = a.abone_kime === 'sahip' && a.odeyen === 'kiraci';
    const bendenGeri = { ad: `${t?.ad || a.tur} aboneliği`,
      onTikla: () => abonelikDosyasiAc(a, geri) };
    onCekmece?.({
      tip: 'ABONELİK',
      baslik: `${t?.simge || '📄'}  ${t?.ad || a.tur} · ${a.mulk_ad || ''}`,
      alt: [a.saglayici || 'sağlayıcı yazılmamış',
        a.abone_no || 'abone no yok'].join(' · '),
      geri,
      kpi: [
        { etiket: 'Abone kimin üstüne',
          deger: a.abone_kime === 'sahip' ? 'siz' : 'kiracı' },
        { etiket: 'Faturayı ödeyen',
          deger: a.odeyen === 'sahip' ? 'siz' : 'kiracı' },
        { etiket: 'Aylık tahmin', deger: a.aylik_tahmin ? fmt(a.aylik_tahmin) : '—' },
        { etiket: 'Risk', deger: riskli ? '⚠ SİZE KALIR' : 'yok',
          renk: riskli ? R.amber : R.yesil },
      ],
      listeBaslik: 'Abonelik dosyası',
      satirlar: [
        ...(riskli ? [{
          ad: 'Bu abonelik neden riskli',
          detay: 'Abone SİZİN üstünüze kayıtlı ama faturayı KİRACI ödüyor. '
            + 'Kiracı ödemezse ya da çıkarsa borç sağlayıcı nezdinde SİZE kalır. '
            + 'İki çıkış var: aboneliği kiracının üstüne aldırmak, ya da ödeyeni '
            + '"siz" yapıp bedeli kiraya yansıtmak.',
          tutar: '',
        }] : []),
        ...(a.mulk_id ? [{
          ad: 'Mülk ›', detay: a.mulk_ad || '—', tutar: '',
          onTikla: () => mulkDosyasiAc(
            { id: a.mulk_id, ad: a.mulk_ad, simge: a.mulk_simge }, bendenGeri),
        }] : []),
        { ad: 'Hangi kiracı döneminde',
          detay: a.sozlesme_id ? 'bir sözleşmeye bağlı'
            : 'sözleşmeye bağlanmamış — kiracı değişiminde abonelik OTOMATİK '
              + 'devredilmez, size sorulur',
          tutar: '', solgun: !a.sozlesme_id },
        ...(a.notlar ? [{ ad: 'Not', detay: a.notlar, tutar: '' }] : []),
      ],
      aksiyonlar: [
        { ad: 'Düzenle', birincil: true, onTikla: () => formAc('abonelik', { ...a }) },
        { ad: 'Aboneliği kapat',
          onTikla: async () => {
            // eslint-disable-next-line no-alert
            if (!window.confirm(`${t?.ad || a.tur} aboneliği kapatılsın mı?`)) return;
            onCekmece?.(null);
            try {
              await api(`/api/mulk/abonelik/${a.id}`, { method: 'DELETE' });
              onToast?.('✅ abonelik kapatıldı');
              await yukle(); await gorunumYukle(gorunum);
            } catch (e) { onToast?.(`⚠ ${String(e?.message || e)}`); }
          } },
      ],
    });
  };

  // ── BİNA ────────────────────────────────────────────────────────
  const binaAc = (b) => {
    const birimler = (mulkler?.mulkler || []).filter((m) => (m.bina || '—') === b.bina);
    const bendenGeri = { ad: `🏢 ${b.bina}`, onTikla: () => binaAc(b) };
    onCekmece?.({
      tip: 'BİNA', baslik: `🏢  ${b.bina}`,
      alt: `${b.dolu}/${b.birim} birim dolu`,
      kpi: [
        { etiket: 'Birim', deger: String(b.birim) },
        { etiket: 'Dolu', deger: `${b.dolu}/${b.birim}`,
          renk: b.dolu === b.birim ? R.yesil : R.amber },
        { etiket: 'Aylık kira', deger: fmt(b.aylik) },
      ],
      listeBaslik: 'Birimler',
      satirlar: birimler.map((m) => ({
        ad: `${m.simge || '🏠'} ${m.birim || m.ad}`,
        detay: [m.kiraci_ad || 'BOŞ', m.tur].filter(Boolean).join(' · '),
        tutar: m.sozlesme_kira ? fmt(m.sozlesme_kira) : '—',
        solgun: !m.sozlesme_id,
        onTikla: () => mulkDosyasiAc(m, bendenGeri),
      })),
      aksiyonlar: [{ ad: '+ Bu binaya birim ekle', birincil: true,
        onTikla: () => formAc('mulk', { bina: b.bina, simge: '🏠' }) }],
    });
  };

  // ── KASA KUTULARI ───────────────────────────────────────────────
  const mulkKasasiAc = () => {
    const kir = kasa?.kirilim || [];
    const bendenGeri = { ad: 'Mülk kasası', onTikla: () => mulkKasasiAc() };
    onCekmece?.({
      tip: 'MÜLK KASASI', baslik: 'Mülk çekmecesinin içi',
      alt: 'kahve işine karışmayan para',
      kpi: [
        { etiket: 'Mülk kasası', deger: fmt(kasa?.mulk) },
        { etiket: 'Elde depozito', deger: fmt(kasa?.depozito_emanet), renk: R.amber },
        { etiket: 'Hareket türü', deger: `${kir.length} tür` },
        { etiket: 'Toplam kasa', deger: fmt(kasa?.toplam) },
      ],
      listeBaslik: 'Tür tür kırılım',
      satirlar: kir.map((x) => ({
        ad: TUR_AD[x.islem_turu] || x.islem_turu.replace(/_/g, ' '),
        detay: `${x.adet} hareket · ${TUR_ANLAM[x.islem_turu] || ''}`,
        tutar: fmt(x.tutar),
        onTikla: () => turListesiAc(x.islem_turu, bendenGeri),
      })),
      not: kasa?.not,
    });
  };

  const turListesiAc = async (tur, geri) => {
    onCekmece?.({ tip: 'MÜLK HAREKETLERİ', baslik: TUR_AD[tur] || tur,
      alt: 'yükleniyor…', geri, satirlar: [] });
    let d = null;
    try { d = await api(`/api/mulk/defter?tur=${encodeURIComponent(tur)}`); }
    catch (e) {
      onCekmece?.({ tip: 'MÜLK HAREKETLERİ', baslik: TUR_AD[tur] || tur,
        alt: 'okunamadı', geri, satirlar: [],
        not: `Okunamadı: ${String(e?.message || e)}` });
      return;
    }
    const bendenGeri = { ad: TUR_AD[tur] || tur, onTikla: () => turListesiAc(tur, geri) };
    onCekmece?.({
      tip: 'MÜLK HAREKETLERİ', baslik: TUR_AD[tur] || tur,
      alt: `${d.adet} satır${d.kesildi ? ' (liste tavana dayandı)' : ''}`,
      geri,
      kpi: [
        { etiket: 'Toplam', deger: fmt(d.toplam),
          renk: sayi(d.toplam) < 0 ? R.kirmizi : R.yesil },
        { etiket: 'Satır', deger: String(d.adet) },
        { etiket: 'Kasa izi yok', deger: String(d.izsiz || 0),
          renk: d.izsiz ? R.kirmizi : R.yesil },
      ],
      listeBaslik: TUR_ANLAM[tur] || 'Hareketler',
      satirlar: (d.satirlar || []).map((h) => ({
        ad: h.tarih,
        detay: [h.mulk_ad, h.kiraci_ad, yontemAd(h.odeme_yontemi),
          h.kasa_iz ? null : '⚠ kasa izi YOK'].filter(Boolean).join(' · '),
        tutar: fmt(h.tutar),
        onTikla: () => mulkHareketiAc(h, bendenGeri),
      })),
    });
  };

  const depozitoAc = async () => {
    const bendenGeri = { ad: 'Depozito emaneti', onTikla: () => depozitoAc() };
    onCekmece?.({ tip: 'DEPOZİTO EMANETİ', baslik: 'Elde tutulan depozito',
      alt: 'yükleniyor…', satirlar: [] });
    let har = [];
    try {
      const d = await api('/api/mulk/defter?tur=DEPOZITO_ALINDI,DEPOZITO_IADE');
      har = d.satirlar || [];
    } catch (e) {
      onCekmece?.({ tip: 'DEPOZİTO EMANETİ', baslik: 'Elde tutulan depozito',
        alt: 'okunamadı', satirlar: [],
        not: `Okunamadı: ${String(e?.message || e)}` });
      return;
    }
    const sozDep = (sozlesmeler?.sozlesmeler || [])
      .filter((x) => x.durum === 'aktif' && sayi(x.depozito) > 0);
    onCekmece?.({
      tip: 'DEPOZİTO EMANETİ',
      baslik: 'Elde tutulan depozito',
      alt: 'gelir değil — iade edilecek emanet',
      kpi: [
        { etiket: 'Defterde emanet', deger: fmt(kasa?.depozito_emanet), renk: R.amber },
        { etiket: 'Sözleşmede yazan', deger: `${sozDep.length} sözleşme` },
        { etiket: 'Hareket', deger: String(har.length) },
      ],
      listeBaslik: 'İki taraf yan yana',
      satirlar: [
        ...(sozDep.length ? [{
          ad: '— SÖZLEŞMEDE YAZAN —',
          detay: 'kâğıtta alınmış görünen depozito', tutar: '', solgun: true,
        }] : []),
        ...sozDep.map((x) => ({
          ad: x.kiraci_ad,
          detay: `${x.mulk_ad} · ${x.baslangic}`,
          tutar: fmt(x.depozito),
          onTikla: () => kiraDosyasiAc(x, bendenGeri),
        })),
        ...(har.length ? [{
          ad: '— DEFTERDE FİİLEN —',
          detay: 'kasaya girmiş/çıkmış depozito hareketi', tutar: '', solgun: true,
        }] : []),
        ...har.map((h) => ({
          ad: `${TUR_AD[h.tur]} · ${h.tarih}`,
          detay: [h.kiraci_ad, h.mulk_ad, h.aciklama].filter(Boolean).join(' · '),
          tutar: fmt(h.tutar),
          onTikla: () => mulkHareketiAc(h, bendenGeri),
        })),
      ],
      not: 'Depozito GELİR DEĞİL, iade edilecek emanettir. İki blok tutmuyorsa '
        + 'depozito sözleşmeye yazılmış ama para hareketi doğmamıştır — o zaman '
        + 'kasa o parayı içermez.',
    });
  };

  // ── GÖÇ ÇEKMECELERİ ─────────────────────────────────────────────
  const gocKovasiAc = (ad, kova, karar) => onCekmece?.({
    tip: 'GÖÇ KOVASI', baslik: ad,
    alt: `${kova?.adet || 0} kayıt · ${fmt(kova?.toplam)}`,
    kpi: [
      { etiket: 'Kayıt', deger: String(kova?.adet || 0) },
      { etiket: 'Tutar', deger: fmt(kova?.toplam) },
      { etiket: 'Ne olacak', deger: karar },
    ],
    listeBaslik: 'Ham kayıtlar (eski "dış kaynak" defteri)',
    satirlar: (kova?.satirlar || []).map((r) => ({
      ad: r.tarih, detay: r.aciklama || '—', tutar: fmt(r.tutar),
    })),
    not: 'Sınıflama YALNIZ açıklamadaki kelimeye bakar. Yanlış kovaya düşmüş '
      + 'bir kayıt varsa onu görmenin tek yolu bu listedir.',
  });

  const gocKumesiAc = (k, geri) => {
    const bendenGeri = { ad: k.eslesti ? k.kiraci_ad : k.onerilen_ad,
      onTikla: () => gocKumesiAc(k, geri) };
    onCekmece?.({
      tip: 'KİRACI KÜMESİ',
      baslik: k.eslesti ? k.kiraci_ad : k.onerilen_ad,
      alt: `${k.adet} kayıt · ${k.aylar?.length || 0} ay · ${k.yazim_adedi} yazım`,
      geri,
      kpi: [
        { etiket: 'Toplam', deger: fmt(k.toplam) },
        { etiket: 'Kayıt', deger: String(k.adet) },
        { etiket: 'Yazım', deger: String(k.yazim_adedi),
          renk: k.yazim_adedi > 1 ? R.amber : R.metin2 },
        { etiket: 'Durum', deger: k.eslesti ? 'tanımlı ✓' : 'tanımsız',
          renk: k.eslesti ? R.yesil : R.amber },
      ],
      listeBaslik: 'Küme içeriği',
      satirlar: [
        { ad: '— YAZIMLAR —', detay: 'açıklamada böyle geçmiş', tutar: '', solgun: true },
        ...(k.yazimlar || []).map((y) => ({ ad: y, detay: '', tutar: '' })),
        ...(k.satirlar?.length ? [{
          ad: '— HAM KAYITLAR —',
          detay: 'birleştirmeden önce okunması gereken liste',
          tutar: '', solgun: true,
        }] : []),
        ...(k.satirlar || []).map((r) => ({
          ad: r.tarih, detay: r.aciklama || '—', tutar: fmt(r.tutar),
        })),
      ],
      aksiyonlar: k.eslesti ? [{
        ad: 'Kiracı dosyasını aç', birincil: true,
        onTikla: () => kiraciDosyasiAc({ id: k.kiraci_id, ad: k.kiraci_ad }, bendenGeri),
      }] : [{
        ad: 'Kiracıyı tanımla', birincil: true,
        onTikla: () => formAc('birlestir', {
          ad: k.onerilen_ad, anahtarlar: [k.anahtar], yazimlar: k.yazimlar || [],
        }),
      }],
    });
  };

  const gocOnerisiAc = (o, km) => {
    const ka = km.find((x) => x.anahtar === o.a_anahtar);
    const kb = km.find((x) => x.anahtar === o.b_anahtar);
    const bendenGeri = { ad: 'Birleştirme önerisi', onTikla: () => gocOnerisiAc(o, km) };
    onCekmece?.({
      tip: 'BİRLEŞTİRME ÖNERİSİ',
      baslik: `${o.a}  ↔  ${o.b}`,
      alt: o.gerekce,
      kpi: [
        { etiket: 'Benzerlik', deger: `%${Math.round(o.benzerlik * 100)}`,
          renk: o.benzerlik >= 0.9 ? R.amber : R.metin2 },
        { etiket: 'Toplam', deger: fmt(o.toplam) },
      ],
      listeBaslik: 'İki küme yan yana',
      satirlar: [ka, kb].filter(Boolean).map((k) => ({
        ad: k.onerilen_ad,
        detay: [`${k.adet} kayıt`, (k.yazimlar || []).join(' ~ '),
          (k.aylar || []).join(', ')].filter(Boolean).join(' · '),
        tutar: fmt(k.toplam),
        onTikla: () => gocKumesiAc(k, bendenGeri),
      })),
      not: 'Bu bir ÖNERİDİR, birleştirme yapılmadı. İki isim benzer olsa da '
        + 'BAŞKA İNSAN olabilir; yanlış birleştirme iki kiracının borcunu tek '
        + 'kişide toplar ve biri "ödemiş" görünür. Aylar ikisinde de aynıysa '
        + 'iki ayrı kişi olma ihtimali yükselir.',
      aksiyonlar: [{
        ad: 'İkisini birleştir', birincil: true,
        onTikla: () => formAc('birlestir', {
          ad: (sayi(ka?.toplam) >= sayi(kb?.toplam) ? ka : kb)?.onerilen_ad || o.a,
          anahtarlar: [o.a_anahtar, o.b_anahtar],
          yazimlar: [...(ka?.yazimlar || []), ...(kb?.yazimlar || [])],
        }),
      }],
    });
  };

  // ── FORM AÇICILAR (çekmece aksiyonlarından çağrılır) ─────────────
  const tahsilatFormuAc = (r) => formAc('tahsilat', {
    sozlesme_id: r.sozlesme_id || r.id,
    kiraci_ad: r.kiraci_ad, mulk_ad: r.mulk_ad,
    aylik_kira: r.aylik_kira,
    tutar: sayi(r.bakiye) > 0 ? Math.min(sayi(r.bakiye), sayi(r.aylik_kira))
      : sayi(r.aylik_kira),
    odeme_yontemi: 'havale', tulipiye_aktar: true,
  });

  const devirFormuAc = (soz, r) => formAc('devir', {
    sozlesme_id: soz.sozlesme_id || soz.id,
    mulk_ad: soz.mulk_ad || r?.mulk_ad,
    eski_kiraci_ad: soz.kiraci_ad || r?.kiraci_ad,
    eski_kiraci_id: soz.kiraci_id || r?.kiraci_id,
    eski_kira: soz.aylik_kira || r?.aylik_kira,
    eski_depozito: soz.depozito,
  });

  if (hata) return <HataBandi mesaj={hata} kaynak="mülk" onTekrar={yukle} />;

  // ═════════════════════════════════════════════════════════════════
  // FORMLAR
  // ⚠️ FONKSİYON, BİLEŞEN DEĞİL. `const Form = () => …` + `<Form />` her
  // render'da YENİ bir bileşen TİPİ doğurur; React alt ağacı söker ve yeniden
  // kurar → her tuşta girdi odağı kaybolur. `{formCiz()}` bu tuzağı kapatır.
  // ═════════════════════════════════════════════════════════════════
  const formCiz = () => {
    if (!form) return null;
    const { tip } = form;
    const v = form.veri;
    const setV = (y) => setForm({ ...form, veri: { ...form.veri, ...y } });
    const kapat = () => setForm(null);

    const sarmal = (baslik, alt, icerik, kaydet) => (
      <div style={{
        marginBottom: 18, padding: 18, borderRadius: 14,
        background: kartYuzey, border: `1px solid ${R.cizgi3}`,
      }}>
        <div style={{ fontFamily: F.baslik, fontSize: 16, color: R.krem, marginBottom: 3 }}>
          {baslik}
        </div>
        {alt ? <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 14 }}>{alt}</div> : null}
        {icerik}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button style={dugmeAna} disabled={mesgul} onClick={kaydet}>
            {mesgul ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
          <button style={dugme} onClick={kapat}>Vazgeç</button>
        </div>
      </div>
    );

    const izgara = (cocuklar) => (
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12,
      }}>{cocuklar}</div>
    );

    if (tip === 'mulk') {
      return sarmal(
        v.id ? 'Mülkü düzenle' : 'Yeni mülk',
        'Sembol seçin — listede adres okumadan gözle bulmak için.',
        <>
          <div style={{ marginBottom: 14 }}>
            <span style={etiketStil}>Sembol</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {SIMGELER.map((sm) => (
                <button key={sm} onClick={() => setV({ simge: sm })} style={{
                  fontSize: 22, padding: '6px 9px', borderRadius: 10, cursor: 'pointer',
                  background: v.simge === sm ? 'rgba(224,165,89,.18)' : 'transparent',
                  border: `1px solid ${v.simge === sm ? R.bakir : R.cizgi3}`,
                }}>{sm}</button>
              ))}
            </div>
          </div>
          {izgara(<>
            <div><span style={etiketStil}>Bina / yer</span>
              <input style={alanStil} value={v.bina || ''} placeholder="Muhacır Pazarı"
                     list="mulk-binalar"
                     onChange={(e) => setV({ bina: e.target.value })} />
              <datalist id="mulk-binalar">
                {(mulkler?.binalar || []).filter((b) => b.bina !== '—')
                  .map((b) => <option key={b.bina} value={b.bina} />)}
              </datalist>
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                Aynı binadaki birimler listede birlikte toplanır.
              </div></div>
            <div><span style={etiketStil}>Birim</span>
              <input style={alanStil} value={v.birim || ''} placeholder="1. kat"
                     onChange={(e) => setV({ birim: e.target.value })} /></div>
            <div style={{ gridColumn: '1/-1' }}>
              <span style={etiketStil}>Görünen ad</span>
              <input style={alanStil} value={v.ad || ''}
                     placeholder={[v.bina, v.birim].filter(Boolean).join(' · ')
                       || 'Muhacır Pazarı · 1. kat'}
                     onChange={(e) => setV({ ad: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                Boş bırakırsanız <b>bina · birim</b> birleştirilerek yazılır.
              </div></div>
            <div><span style={etiketStil}>Tür</span>
              <select style={alanStil} value={v.tur || ''}
                      onChange={(e) => setV({ tur: e.target.value })}>
                <option value="">—</option>
                {MULK_TURU.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></div>
            <div><span style={etiketStil}>Hedef aylık kira</span>
              <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                     onChange={(e) => setV({ aylik_kira: e.target.value })} /></div>
            <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Adres</span>
              <input style={alanStil} value={v.adres || ''}
                     onChange={(e) => setV({ adres: e.target.value })} /></div>
            <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Not</span>
              <input style={alanStil} value={v.notlar || ''}
                     onChange={(e) => setV({ notlar: e.target.value })} /></div>
          </>)}
        </>,
        () => {
          if (!String(v.ad || '').trim() && !String(v.bina || '').trim()) {
            onToast?.('⚠ En az bina adı ya da görünen ad gerekli'); return;
          }
          cagir(v.id ? `/api/mulk/${v.id}` : '/api/mulk', v.id ? 'PUT' : 'POST', {
            ad: v.ad || null, bina: v.bina || null, birim: v.birim || null,
            adres: v.adres || null, tur: v.tur || null, simge: v.simge || null,
            aylik_kira: v.aylik_kira ? Number(v.aylik_kira) : null,
            notlar: v.notlar || null,
          });
        });
    }

    if (tip === 'kiraci') {
      return sarmal(v.id ? 'Kiracıyı düzenle' : 'Yeni kiracı', null,
        izgara(<>
          <div><span style={etiketStil}>Ad Soyad *</span>
            <input style={alanStil} value={v.ad || ''}
                   onChange={(e) => setV({ ad: e.target.value })} /></div>
          <div><span style={etiketStil}>Telefon</span>
            <input style={alanStil} value={v.telefon || ''}
                   onChange={(e) => setV({ telefon: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Not</span>
            <input style={alanStil} value={v.notlar || ''}
                   onChange={(e) => setV({ notlar: e.target.value })} /></div>
        </>),
        () => {
          if (!String(v.ad || '').trim()) { onToast?.('⚠ Ad zorunlu'); return; }
          cagir(v.id ? `/api/mulk/kiraci/${v.id}` : '/api/mulk/kiraci',
            v.id ? 'PUT' : 'POST',
            { ad: v.ad, telefon: v.telefon || null, notlar: v.notlar || null });
        });
    }

    if (tip === 'sozlesme') {
      return sarmal('Yeni sözleşme',
        'Kira artışında bu sözleşmeyi bitirip YENİSİNİ açın — geçmiş tahsilatlar eski tutara bağlı kalsın.',
        izgara(<>
          <div><span style={etiketStil}>Mülk *</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">seçin…</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Kiracı *</span>
            <select style={alanStil} value={v.kiraci_id || ''}
                    onChange={(e) => setV({ kiraci_id: e.target.value })}>
              <option value="">seçin…</option>
              {(kiracilar?.kiracilar || []).map((k) =>
                <option key={k.id} value={k.id}>{k.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Başlangıç *</span>
            <input style={alanStil} type="date" value={v.baslangic || bugun()}
                   onChange={(e) => setV({ baslangic: e.target.value })} /></div>
          <div><span style={etiketStil}>Aylık kira *</span>
            <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                   onChange={(e) => setV({ aylik_kira: e.target.value })} /></div>
          <div><span style={etiketStil}>Depozito</span>
            <input style={alanStil} type="number" value={v.depozito ?? ''}
                   onChange={(e) => setV({ depozito: e.target.value })} /></div>
          <div><span style={etiketStil}>Ödeme günü</span>
            <input style={alanStil} type="number" min="1" max="31" value={v.odeme_gunu ?? 1}
                   onChange={(e) => setV({ odeme_gunu: e.target.value })} /></div>
          <div><span style={etiketStil}>Kiracı tipi</span>
            <select style={alanStil} value={v.kiraci_tipi || 'sahis'}
                    onChange={(e) => setV({
                      kiraci_tipi: e.target.value,
                      stopaj_orani: e.target.value === 'isyeri' ? 20 : 0,
                    })}>
              <option value="sahis">Şahıs (konut)</option>
              <option value="isyeri">İşyeri (stopajlı)</option>
            </select></div>
          {v.kiraci_tipi === 'isyeri' ? (
            <div><span style={etiketStil}>Stopaj %</span>
              <input style={alanStil} type="number" value={v.stopaj_orani ?? 20}
                     onChange={(e) => setV({ stopaj_orani: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                İşyeri kiracı stopajı kaynağında keser; size NET ulaşır. Bu oran
                girilmezse her ay "eksik ödedi" uyarısı çıkar.
              </div></div>
          ) : null}
        </>),
        () => {
          if (!v.mulk_id || !v.kiraci_id || !v.aylik_kira) {
            onToast?.('⚠ Mülk, kiracı ve aylık kira zorunlu'); return;
          }
          cagir('/api/mulk/sozlesme', 'POST', {
            mulk_id: v.mulk_id, kiraci_id: v.kiraci_id,
            baslangic: v.baslangic || bugun(),
            aylik_kira: Number(v.aylik_kira),
            depozito: Number(v.depozito || 0),
            odeme_gunu: Number(v.odeme_gunu || 1),
            kiraci_tipi: v.kiraci_tipi || 'sahis',
            stopaj_orani: Number(v.stopaj_orani || 0),
          });
        });
    }

    if (tip === 'tahsilat') {
      return sarmal(`Kira tahsilatı — ${v.kiraci_ad || ''}`,
        `${v.mulk_ad || ''} · aylık ${fmt(v.aylik_kira)}`,
        <>
          {izgara(<>
            <div><span style={etiketStil}>Tarih</span>
              <input style={alanStil} type="date" value={v.tarih || bugun()}
                     onChange={(e) => setV({ tarih: e.target.value })} /></div>
            <div><span style={etiketStil}>Tutar *</span>
              <input style={alanStil} type="number" value={v.tutar ?? ''}
                     onChange={(e) => setV({ tutar: e.target.value })} /></div>
            <div><span style={etiketStil}>Hangi ayın kirası</span>
              <input style={alanStil} type="month" value={v.donem || ''}
                     onChange={(e) => setV({ donem: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                İsteğe bağlı. Boş bırakırsanız en eski açık aydan kapatılır.
              </div></div>
          </>)}
          <div style={{ marginTop: 14 }}>
            <span style={etiketStil}>Para nasıl geldi?</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ id: 'havale', ad: '🏦 Havale / EFT' },
                { id: 'elden', ad: '💵 Elden nakit' }].map((y) => (
                <button key={y.id} onClick={() => setV({ odeme_yontemi: y.id })} style={{
                  ...dugme, flex: 1,
                  background: v.odeme_yontemi === y.id ? 'rgba(224,165,89,.18)' : 'transparent',
                  borderColor: v.odeme_yontemi === y.id ? R.bakir : R.cizgi3,
                  color: v.odeme_yontemi === y.id ? R.krem : R.metin2,
                }}>{y.ad}</button>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 6 }}>
              Elden alınan nakit çekmecedeki parayı artırır, havale bankaya düşer.
              Ayrım olmadan banka mutabakatı doğru çalışmaz.
            </div>
          </div>
          <label style={{
            display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 14,
            cursor: 'pointer',
          }}>
            <input type="checkbox" checked={!!v.tulipiye_aktar} style={{ marginTop: 3 }}
                   onChange={(e) => setV({ tulipiye_aktar: e.target.checked })} />
            <span style={{ fontSize: 12, color: R.metin2, lineHeight: 1.5 }}>
              <b style={{ color: R.krem }}>Bu para dükkâna girdi</b> — TULİPİ
              kasasında kullanılacak.<br />
              İşaretlerseniz mülk defterinden çıkıp TULİPİ'ye aktarılır;
              <b> toplam kasa değişmez.</b> İşaretlemezseniz para mülk
              çekmecesinde birikir.
            </span>
          </label>
        </>,
        () => {
          if (!v.tutar) { onToast?.('⚠ Tutar zorunlu'); return; }
          cagir('/api/mulk/tahsilat', 'POST', {
            sozlesme_id: v.sozlesme_id, tarih: v.tarih || bugun(),
            tutar: Number(v.tutar), donem: v.donem || null,
            odeme_yontemi: v.odeme_yontemi || null,
            tulipiye_aktar: !!v.tulipiye_aktar,
          });
        });
    }

    if (tip === 'devir') {
      return sarmal(`Kiracı değişimi — ${v.mulk_ad || ''}`,
        `Çıkan: ${v.eski_kiraci_ad}. Eski sözleşme kapanır, yenisi açılır — geçmiş tahsilatlar eski kiracıda KALIR.`,
        izgara(<>
          <div><span style={etiketStil}>Yeni kiracı *</span>
            <select style={alanStil} value={v.yeni_kiraci_id || ''}
                    onChange={(e) => setV({ yeni_kiraci_id: e.target.value })}>
              <option value="">seçin…</option>
              {(kiracilar?.kiracilar || []).filter((k) => k.id !== v.eski_kiraci_id)
                .map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Devir tarihi *</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Yeni aylık kira</span>
            <input style={alanStil} type="number" value={v.aylik_kira ?? ''}
                   placeholder={String(v.eski_kira || '')}
                   onChange={(e) => setV({ aylik_kira: e.target.value })} />
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
              Boş bırakırsanız eskisi devam eder.
            </div></div>
          <div><span style={etiketStil}>Yeni depozito</span>
            <input style={alanStil} type="number" value={v.depozito ?? ''}
                   onChange={(e) => setV({ depozito: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={v.depozito_iade !== false}
                     onChange={(e) => setV({ depozito_iade: e.target.checked })} />
              <span style={{ fontSize: 12, color: R.metin2 }}>
                Çıkan kiracının depozitosu iade edildi
                {sayi(v.eski_depozito) ? ` (${fmt(v.eski_depozito)})` : ''}
                {' '}— mülk defterinden düşülür.
              </span>
            </label>
          </div>
        </>),
        async () => {
          if (!v.yeni_kiraci_id) { onToast?.('⚠ Yeni kiracı seçin'); return; }
          const r = await cagir(`/api/mulk/sozlesme/${v.sozlesme_id}/devir`, 'POST', {
            yeni_kiraci_id: v.yeni_kiraci_id, tarih: v.tarih || bugun(),
            aylik_kira: v.aylik_kira ? Number(v.aylik_kira) : null,
            depozito: Number(v.depozito || 0),
            depozito_iade: v.depozito_iade !== false,
          });
          if (r?.abonelik_uyarisi?.length) {
            onToast?.(`⚠ ${r.abonelik_uyarisi.length} abonelik devredilmedi — Abonelikler sekmesinden güncelleyin`);
          }
        });
    }

    if (tip === 'birlestir') {
      return sarmal('Kiracıyı tanımla',
        'Bu yazımların hepsi tek kişiye bağlanacak. Bir daha sorulmayacak — banka ekstresinden gelen isim de bundan sonra bu kişiye eşleşir.',
        <>
          {izgara(<>
            <div><span style={etiketStil}>Kanonik ad *</span>
              <input style={alanStil} value={v.ad || ''}
                     onChange={(e) => setV({ ad: e.target.value })} />
              <div style={{ fontSize: 10.5, color: R.not2, marginTop: 4 }}>
                Bundan sonra ekranda görünecek doğru yazım.
              </div></div>
            <div><span style={etiketStil}>Telefon</span>
              <input style={alanStil} value={v.telefon || ''}
                     onChange={(e) => setV({ telefon: e.target.value })} /></div>
          </>)}
          <div style={{ marginTop: 14 }}>
            <span style={etiketStil}>Bağlanacak yazımlar</span>
            <div style={{
              padding: '10px 12px', borderRadius: 10, background: R.girinti,
              border: `1px solid ${R.cizgi3}`, fontSize: 12, color: R.metin2,
              lineHeight: 1.7,
            }}>
              {(v.yazimlar || []).map((y) => <div key={y}>· {y}</div>)}
            </div>
            <div style={{ fontSize: 10.5, color: R.not2, marginTop: 6 }}>
              Yanlış birleştirdiyseniz kiracı dosyasından tek tek ayırabilirsiniz.
            </div>
          </div>
        </>,
        () => {
          if (!String(v.ad || '').trim()) { onToast?.('⚠ Kanonik ad zorunlu'); return; }
          cagir('/api/mulk/kiraci/birlestir', 'POST', {
            ad: v.ad, telefon: v.telefon || null,
            anahtarlar: v.anahtarlar || [], yazimlar: v.yazimlar || [],
          }).catch(() => {});
        });
    }

    if (tip === 'abonelik') {
      return sarmal(v.id ? 'Aboneliği düzenle' : 'Yeni abonelik',
        'İki ayrı soru: ABONE kimin üstüne kayıtlı, FATURAYI kim ödüyor. Karıştırılırsa tahliyeden sonra borç size kalır.',
        izgara(<>
          <div><span style={etiketStil}>Mülk *</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">seçin…</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Tür *</span>
            <select style={alanStil} value={v.tur || ''}
                    onChange={(e) => setV({ tur: e.target.value })}>
              <option value="">seçin…</option>
              {ABONELIK_TURU.map((t) =>
                <option key={t.id} value={t.id}>{t.simge + ' ' + t.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Sağlayıcı</span>
            <input style={alanStil} value={v.saglayici || ''} placeholder="Aydem · İZSU…"
                   onChange={(e) => setV({ saglayici: e.target.value })} /></div>
          <div><span style={etiketStil}>Abone / tesisat no</span>
            <input style={alanStil} value={v.abone_no || ''}
                   onChange={(e) => setV({ abone_no: e.target.value })} /></div>
          <div><span style={etiketStil}>Abone kimin üstüne</span>
            <select style={alanStil} value={v.abone_kime || 'sahip'}
                    onChange={(e) => setV({ abone_kime: e.target.value })}>
              <option value="sahip">Benim üstüme</option>
              <option value="kiraci">Kiracının üstüne</option>
            </select></div>
          <div><span style={etiketStil}>Faturayı kim öder</span>
            <select style={alanStil} value={v.odeyen || 'kiraci'}
                    onChange={(e) => setV({ odeyen: e.target.value })}>
              <option value="kiraci">Kiracı</option>
              <option value="sahip">Ben</option>
            </select></div>
          <div><span style={etiketStil}>Aylık tahmini</span>
            <input style={alanStil} type="number" value={v.aylik_tahmin ?? ''}
                   onChange={(e) => setV({ aylik_tahmin: e.target.value })} /></div>
        </>),
        () => {
          if (!v.mulk_id || !v.tur) { onToast?.('⚠ Mülk ve tür zorunlu'); return; }
          cagir(v.id ? `/api/mulk/abonelik/${v.id}` : '/api/mulk/abonelik',
            v.id ? 'PUT' : 'POST', {
              mulk_id: v.mulk_id, tur: v.tur, saglayici: v.saglayici || null,
              abone_no: v.abone_no || null,
              abone_kime: v.abone_kime || 'sahip', odeyen: v.odeyen || 'kiraci',
              aylik_tahmin: v.aylik_tahmin ? Number(v.aylik_tahmin) : null,
            });
        });
    }

    if (tip === 'gider') {
      return sarmal('Mülk gideri',
        'Aidat · site faturası · emlak vergisi · tadilat. Kahve işinin giderine KARIŞMAZ.',
        izgara(<>
          <div><span style={etiketStil}>Tarih</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Tutar *</span>
            <input style={alanStil} type="number" value={v.tutar ?? ''}
                   onChange={(e) => setV({ tutar: e.target.value })} /></div>
          <div><span style={etiketStil}>Mülk</span>
            <select style={alanStil} value={v.mulk_id || ''}
                    onChange={(e) => setV({ mulk_id: e.target.value })}>
              <option value="">(genel)</option>
              {(mulkler?.mulkler || []).map((m) =>
                <option key={m.id} value={m.id}>{(m.simge || '🏠') + ' ' + m.ad}</option>)}
            </select></div>
          <div><span style={etiketStil}>Nasıl ödendi</span>
            <select style={alanStil} value={v.odeme_yontemi || ''}
                    onChange={(e) => setV({ odeme_yontemi: e.target.value })}>
              <option value="">—</option>
              <option value="havale">🏦 Havale</option>
              <option value="elden">💵 Elden</option>
            </select></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Açıklama *</span>
            <input style={alanStil} value={v.aciklama || ''}
                   placeholder="Huzur Sitesi aidat — Eylül"
                   onChange={(e) => setV({ aciklama: e.target.value })} /></div>
        </>),
        () => {
          if (!v.tutar || !String(v.aciklama || '').trim()) {
            onToast?.('⚠ Tutar ve açıklama zorunlu'); return;
          }
          cagir('/api/mulk/gider', 'POST', {
            tarih: v.tarih || bugun(), tutar: Number(v.tutar),
            aciklama: v.aciklama, mulk_id: v.mulk_id || null,
            odeme_yontemi: v.odeme_yontemi || null,
          });
        });
    }

    if (tip === 'aktarim') {
      return sarmal("Mülkten TULİPİ'ye aktarım",
        'Mülk defterinden para çıkar, TULİPİ kasasına girer. TOPLAM KASA DEĞİŞMEZ.',
        izgara(<>
          <div><span style={etiketStil}>Tarih</span>
            <input style={alanStil} type="date" value={v.tarih || bugun()}
                   onChange={(e) => setV({ tarih: e.target.value })} /></div>
          <div><span style={etiketStil}>Tutar *</span>
            <input style={alanStil} type="number" value={v.tutar ?? ''}
                   onChange={(e) => setV({ tutar: e.target.value })} /></div>
          <div style={{ gridColumn: '1/-1' }}><span style={etiketStil}>Açıklama</span>
            <input style={alanStil} value={v.aciklama || ''}
                   onChange={(e) => setV({ aciklama: e.target.value })} /></div>
        </>),
        () => {
          if (!v.tutar) { onToast?.('⚠ Tutar zorunlu'); return; }
          cagir('/api/mulk/aktarim', 'POST', {
            tarih: v.tarih || bugun(), tutar: Number(v.tutar),
            aciklama: v.aciklama || null,
          });
        });
    }
    return null;
  };

  const ustCubuk = (dugmeler) => (
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', margin: '16px 0 14px' }}>
      {dugmeler.map((d) => (
        <button key={d.ad} style={d.ana ? dugmeAna : dugme} onClick={d.tikla}>{d.ad}</button>
      ))}
    </div>
  );

  // ── KASA ŞERİDİ — dört kutu, üçü kapı ───────────────────────────
  const kasaSeridi = () => {
    if (!kasa) return null;
    const kutular = [
      {
        etiket: 'Toplam kasa', deger: fmt(kasa.toplam), renk: R.krem,
        alt: onKopru ? "TULİPİ + mülk · ayrımlar Panel'de" : 'TULİPİ + mülk',
        // 🔗 Toplam kasanın ayrıntısı ZATEN Panel'de (şube + tür + banka).
        // Aynı çekmeceyi burada yeniden kurmak iki gerçek doğururdu.
        onTikla: onKopru ? () => onKopru('__modul:genel:akis') : undefined,
      },
      {
        etiket: 'TULİPİ kasası', deger: fmt(kasa.tulipi), renk: R.bakir,
        alt: 'kahve işi',
        onTikla: onKopru ? () => onKopru('__modul:genel:akis') : undefined,
      },
      {
        etiket: 'Mülk kasası', deger: fmt(kasa.mulk), renk: R.yesil,
        alt: (kasa.kirilim || []).length
          ? 'kira · aidat · depozito · içi için tıkla' : 'henüz hareket yok',
        // 🚪 Kapı ancak arkasında içerik varsa: kırılım boşsa düz kutu.
        onTikla: (kasa.kirilim || []).length ? mulkKasasiAc : undefined,
      },
    ];
    const sozDepVar = (sozlesmeler?.sozlesmeler || [])
      .some((x) => x.durum === 'aktif' && sayi(x.depozito) > 0);
    if (sayi(kasa.depozito_emanet) !== 0 || sozDepVar) {
      kutular.push({
        etiket: 'Elde tutulan depozito', deger: fmt(kasa.depozito_emanet),
        renk: R.amber, alt: 'emanet — gelir DEĞİL · ayrım için tıkla',
        onTikla: depozitoAc,
      });
    }
    return (
      <>
        <KpiSeridi kpiler={kutular} />
        <div style={{ fontSize: 11.5, color: R.not2, lineHeight: 1.55, margin: '2px 0 4px' }}>
          Toplam kasa = TULİPİ + Mülk. Para yerinden oynamadı; yalnız hangi
          çekmeceye ait olduğu yazıldı.
        </div>
      </>
    );
  };

  // ═════════════════════════════════════════════════════════════════
  // GÖRÜNÜMLER
  // ═════════════════════════════════════════════════════════════════
  const govde = () => {
    // ── MÜLKLER ──────────────────────────────────────────────────
    if (!gorunum || gorunum === 'mulkler') {
      const liste = mulkler?.mulkler || [];
      const binalar = (mulkler?.binalar || []).filter((b) => b.bina !== '—');
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni mülk', ana: true, tikla: () => formAc('mulk', { simge: '🏠' }) },
            { ad: '+ Sözleşme', tikla: () => formAc('sozlesme', {}) },
            { ad: '+ Mülk gideri', tikla: () => formAc('gider', {}) },
            { ad: "↗ TULİPİ'ye aktar", tikla: () => formAc('aktarim', {}) },
          ])}
          {formCiz()}
          {binalar.length > 1 ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {binalar.map((b) => (
                <div key={b.bina} role="button" tabIndex={0}
                     onClick={() => binaAc(b)}
                     onKeyDown={(e) => {
                       if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); binaAc(b); }
                     }}
                     style={{
                       padding: '11px 14px', borderRadius: 12, background: kartYuzey,
                       border: `1px solid ${R.cizgi2}`, minWidth: 150, cursor: 'pointer',
                     }}>
                  <div style={{ fontSize: 13, color: R.krem, fontWeight: 600 }}>
                    🏢 {b.bina} <span style={{ color: R.bakir }}>›</span>
                  </div>
                  <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>
                    {b.dolu}/{b.birim} birim dolu
                  </div>
                  <div style={{ fontSize: 15, color: R.bakir, fontWeight: 700, marginTop: 3 }}>
                    {fmt(b.aylik)}<span style={{ fontSize: 10.5, color: R.not2 }}> /ay</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {!liste.length ? (
            <BosDurum baslik="Henüz mülk yok"
                      aciklama="İlk mülkü ekleyin; sonra kiracı ve sözleşme tanımlayın."
                      ikon="🏠" />
          ) : (
            <Tablo
              baslik={`Mülkler · ${mulkler.dolu} dolu, ${mulkler.bos} boş`}
              not={`Aylık beklenen: ${fmt(mulkler.aylik_beklenen)} · satıra tıklayın`}
              kolonlar={[{ ad: '' }, { ad: 'Bina' }, { ad: 'Birim / ad' }, { ad: 'Tür' },
                { ad: 'Kiracı' }, { ad: 'Aylık kira', sag: true }, { ad: 'Durum' }]}
              satirlar={liste.map((m) => ({
                id: m.id, _m: m,
                hucreler: [
                  { v: m.simge || '🏠' },
                  { v: m.bina || '—', renk: m.bina ? R.metin2 : R.not3 },
                  { v: m.birim || m.ad, kalin: true },
                  { v: m.tur || '—', renk: R.not2 },
                  { v: m.kiraci_ad || '—', renk: m.kiraci_ad ? R.krem : R.not3 },
                  { v: m.sozlesme_kira ? fmt(m.sozlesme_kira) : '—', sag: true, mono: true },
                  { v: m.sozlesme_id ? 'DOLU' : 'BOŞ',
                    rozet: m.sozlesme_id ? R.yesil : R.amber },
                ],
              }))}
              onSatir={(r) => mulkDosyasiAc(r._m)}
            />
          )}
        </>
      );
    }

    // ── TAHSİLAT & GECİKME ───────────────────────────────────────
    if (gorunum === 'tahsilat') {
      if (!tahsilat) return <BosDurum baslik="Yükleniyor…" ikon="⏳" />;
      const s = tahsilat.satirlar || [];
      return (
        <>
          {formCiz()}
          {!s.length ? (
            <BosDurum baslik="Aktif sözleşme yok"
                      aciklama="Tahsilat takibi sözleşmeye dayanır. Önce mülk, kiracı ve sözleşme tanımlayın."
                      ikon="📋" />
          ) : (
            <Tablo
              baslik={`Tahsilat · ${tahsilat.borclu_adet} kiracı borçlu`}
              not={`toplam bakiye ${fmt(tahsilat.toplam_bakiye)} · satıra tıklayın`}
              kolonlar={[{ ad: 'Mülk' }, { ad: 'Kiracı' }, { ad: 'Aylık', sag: true },
                { ad: 'Beklenen', sag: true }, { ad: 'Alınan', sag: true },
                { ad: 'Bakiye', sag: true }, { ad: 'Durum' }]}
              satirlar={s.map((r) => ({
                id: r.sozlesme_id, _r: r,
                hucreler: [
                  { v: r.mulk_ad }, { v: r.kiraci_ad, kalin: true },
                  { v: fmt(r.aylik_kira), sag: true, mono: true, renk: R.not2 },
                  { v: fmt(r.beklenen), sag: true, mono: true },
                  { v: fmt(r.alinan), sag: true, mono: true },
                  { v: fmt(r.bakiye), sag: true, mono: true, kalin: true,
                    renk: r.bakiye > 0.5 ? R.kirmizi
                      : r.bakiye < -0.5 ? R.yesil : R.metin2 },
                  { v: r.durum === 'borclu' ? `${r.gecikme_ay} ay geride`
                      : r.durum === 'pesin' ? 'peşin' : 'güncel',
                    rozet: r.durum === 'borclu' ? R.kirmizi
                      : r.durum === 'pesin' ? R.yesil : R.not },
                ],
              }))}
              onSatir={(row) => kiraDosyasiAc({
                id: row._r.sozlesme_id, kiraci_ad: row._r.kiraci_ad,
                kiraci_id: row._r.kiraci_id, mulk_ad: row._r.mulk_ad,
                mulk_id: row._r.mulk_id, aylik_kira: row._r.aylik_kira,
                baslangic: row._r.baslangic, odeme_gunu: row._r.odeme_gunu,
                durum: 'aktif', telefon: row._r.telefon,
              })}
            />
          )}
        </>
      );
    }

    // ── KİRACILAR ────────────────────────────────────────────────
    if (gorunum === 'kiracilar') {
      const liste = kiracilar?.kiracilar || [];
      const aktifSoz = (sozlesmeler?.sozlesmeler || []).filter((x) => x.durum === 'aktif');
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni kiracı', ana: true, tikla: () => formAc('kiraci', {}) },
            { ad: '+ Sözleşme', tikla: () => formAc('sozlesme', {}) },
          ])}
          {formCiz()}
          {!liste.length ? (
            <BosDurum baslik="Henüz kiracı yok"
                      aciklama="Kiracıyı bir kez tanımlayın; farklı yazımları sistem sonradan kendisi tanır."
                      ikon="👤" />
          ) : (
            <Tablo
              baslik={`Kiracılar · ${liste.length}`}
              not="satıra tıklayın — kiracının dosyası açılır"
              kolonlar={[{ ad: 'Ad Soyad' }, { ad: 'Telefon' }, { ad: 'Mülk' },
                { ad: 'Aylık', sag: true }, { ad: 'Bilinen yazımlar' }]}
              satirlar={liste.map((k) => {
                const soz = aktifSoz.find((x) => x.kiraci_id === k.id);
                return {
                  id: k.id, _k: k,
                  hucreler: [
                    { v: k.ad, kalin: true },
                    { v: k.telefon || '—', mono: true, renk: R.metin2 },
                    { v: soz?.mulk_ad || '—', renk: soz ? R.krem : R.not3 },
                    { v: soz ? fmt(soz.aylik_kira) : '—', sag: true, mono: true },
                    { v: k.takma_adlar || '—', renk: R.not2 },
                  ],
                };
              })}
              onSatir={(row) => kiraciDosyasiAc(row._k)}
            />
          )}
        </>
      );
    }

    // ── ABONELİKLER ──────────────────────────────────────────────
    if (gorunum === 'abonelik') {
      const liste = abonelikler?.abonelikler || [];
      return (
        <>
          {ustCubuk([
            { ad: '+ Yeni abonelik', ana: true, tikla: () => formAc('abonelik', {}) },
          ])}
          {formCiz()}
          {!liste.length ? (
            <BosDurum baslik="Abonelik kaydı yok"
                      aciklama="Elektrik, su, doğalgaz, internet, aidat… Her mülk için abonenin kimin üstüne kayıtlı olduğunu ve faturayı kimin ödediğini ayrı ayrı yazın."
                      ikon="⚡" />
          ) : (
            <Tablo
              baslik={`Abonelikler · ${liste.length}`}
              not={abonelikler.riskli_adet
                ? `⚠ ${abonelikler.riskli_adet} abonelik SİZİN üstünüze kayıtlı ama faturayı kiracı ödüyor`
                : 'satıra tıklayın'}
              kolonlar={[{ ad: '' }, { ad: 'Mülk' }, { ad: 'Tür' }, { ad: 'Sağlayıcı' },
                { ad: 'Abone' }, { ad: 'Ödeyen' }, { ad: 'Aylık', sag: true }]}
              satirlar={liste.map((a) => {
                const t = ABONELIK_TURU.find((x) => x.id === a.tur);
                const riskli = a.abone_kime === 'sahip' && a.odeyen === 'kiraci';
                return {
                  id: a.id, _a: a,
                  hucreler: [
                    { v: t?.simge || '📄' },
                    { v: `${a.mulk_simge || '🏠'} ${a.mulk_ad}` },
                    { v: t?.ad || a.tur, kalin: true },
                    { v: a.saglayici || '—', renk: R.not2 },
                    { v: a.abone_kime === 'sahip' ? (riskli ? 'siz ⚠' : 'siz') : 'kiracı',
                      renk: riskli ? R.amber : R.krem },
                    { v: a.odeyen === 'sahip' ? 'siz' : 'kiracı', renk: R.metin2 },
                    { v: a.aylik_tahmin ? fmt(a.aylik_tahmin) : '—', sag: true, mono: true },
                  ],
                };
              })}
              onSatir={(row) => abonelikDosyasiAc(row._a)}
            />
          )}
        </>
      );
    }

    // ── MÜLK DEFTERİ ─────────────────────────────────────────────
    if (gorunum === 'defter') {
      const s = defter?.satirlar || [];
      return (
        <>
          {ustCubuk([
            { ad: '+ Mülk gideri', tikla: () => formAc('gider', {}) },
            { ad: "↗ TULİPİ'ye aktar", tikla: () => formAc('aktarim', {}) },
          ])}
          {formCiz()}
          {!s.length ? (
            <BosDurum baslik="Defter boş"
                      aciklama="Kira tahsilatı, aidat, depozito ve aktarımlar buraya düşer. Her satırın kasa izi vardır."
                      ikon="📒" />
          ) : (
            <Tablo
              baslik={`Mülk defteri · ${defter.adet} hareket`}
              not={defter.izsiz
                ? `⚠ ${defter.izsiz} satırın kasa izi YOK`
                : 'satıra tıklayın — kasa izi ve tür açıklaması açılır'}
              kolonlar={[{ ad: 'Tarih' }, { ad: 'İşlem' }, { ad: 'Mülk' }, { ad: 'Kiracı' },
                { ad: 'Açıklama' }, { ad: 'Tutar', sag: true }, { ad: 'Kasa izi' }]}
              satirlar={s.map((h) => ({
                id: h.id, _h: h,
                hucreler: [
                  { v: h.tarih, mono: true, renk: R.metin2 },
                  { v: TUR_AD[h.tur] || h.tur.replace(/_/g, ' '), kalin: true },
                  { v: h.mulk_ad || '—', renk: R.not2 },
                  { v: h.kiraci_ad || '—', renk: R.not2 },
                  { v: h.aciklama || '—', renk: R.metin2 },
                  { v: fmt(h.tutar), sag: true, mono: true, kalin: true,
                    renk: sayi(h.tutar) < 0 ? R.kirmizi : R.yesil },
                  { v: h.kasa_iz ? '✓' : 'YOK',
                    rozet: h.kasa_iz ? R.yesil : R.kirmizi },
                ],
              }))}
              onSatir={(row) => mulkHareketiAc(row._h)}
            />
          )}
        </>
      );
    }

    // ── GÖÇ: eski kayıtları aktar ────────────────────────────────
    if (gorunum === 'goc') {
      if (!goc) return <BosDurum baslik="Okunuyor…" ikon="⏳" />;
      const km = goc.kiraci_kumeleri || [];
      const on = goc.birlestirme_onerileri || [];
      const KOVA = [
        ['🏠 Kira', goc.kira, 'mülk defterine aynalanır', R.yesil],
        ['🔐 Depozito', goc.depozito, 'emanet olarak ayrılır — gelir DEĞİL', R.amber],
        ['🧾 Mülk gideri', goc.mulk_gideri, 'mülk gideri olur', R.metin2],
        ['🏡 Varlık satışı', goc.varlik_satisi, 'gelir sayılmaz — varlık satışı', R.amber],
        ['💰 Gerçek dış kaynak', goc.gercek_dis_kaynak,
          'DOKUNULMAZ — emekli maaşı, kredi, SGK', R.not2],
      ];
      return (
        <>
          {formCiz()}
          <div style={{
            padding: 16, borderRadius: 14, marginBottom: 16,
            background: 'rgba(251,191,36,.07)', border: '1px solid rgba(251,191,36,.28)',
          }}>
            <div style={{ fontFamily: F.baslik, fontSize: 15, color: R.amber, marginBottom: 6 }}>
              🧪 Kuru çalıştırma — hiçbir şey yazılmadı
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.6 }}>
              "Dış kaynak geliri" içindeki eski kayıtlar okundu ve türlerine
              ayrıldı. Satıra tıklayarak <b>ham kayıtları</b> görebilirsiniz —
              sınıflama yalnız açıklamadaki kelimeye bakar, yanlış kovaya düşmüş
              bir kaydı görmenin tek yolu içine bakmaktır.
            </div>
          </div>

          <Tablo
            baslik="Eski kayıtların gerçek içeriği"
            not="satıra tıklayın — o kovanın ham kayıtları açılır"
            kolonlar={[{ ad: 'Ne' }, { ad: 'Kayıt', sag: true },
              { ad: 'Tutar', sag: true }, { ad: 'Ne olacak' }]}
            satirlar={KOVA.map(([ad, kv, karar, renk], i) => ({
              id: `k${i}`, _k: { ad, kv, karar },
              hucreler: [
                { v: ad, kalin: true },
                { v: String(kv?.adet ?? 0), sag: true, mono: true },
                { v: fmt(kv?.toplam), sag: true, mono: true, kalin: true, renk },
                { v: karar, renk: R.not2 },
              ],
            }))}
            onSatir={(row) => {
              const { ad, kv, karar } = row._k;
              if (!kv?.satirlar?.length) { onToast?.('Bu kovada kayıt yok'); return; }
              gocKovasiAc(ad, kv, karar);
            }}
          />

          <div style={{ height: 18 }} />
          <Tablo
            baslik={`Kiracı adayları · ${km.length} küme`}
            not={`${goc.eslesen_kume || 0}/${km.length} tanımlı · satıra tıklayın`}
            kolonlar={[{ ad: 'Önerilen ad' }, { ad: 'Kayıt', sag: true },
              { ad: 'Toplam', sag: true }, { ad: 'Aylar' }, { ad: 'Yazım' },
              { ad: 'Durum' }]}
            satirlar={km.map((k, i) => ({
              id: `${k.anahtar}-${i}`, _k: k,
              hucreler: [
                { v: k.eslesti ? k.kiraci_ad : k.onerilen_ad, kalin: true },
                { v: String(k.adet), sag: true, mono: true },
                { v: fmt(k.toplam), sag: true, mono: true },
                { v: (k.aylar || []).join(', '), renk: R.not2, mono: true },
                { v: k.yazim_adedi > 1 ? `${k.yazim_adedi} farklı` : '—',
                  renk: k.yazim_adedi > 1 ? R.amber : R.not3 },
                { v: k.eslesti ? 'tanımlı ✓' : 'tanımsız',
                  rozet: k.eslesti ? R.yesil : R.amber },
              ],
            }))}
            onSatir={(row) => gocKumesiAc(row._k)}
          />

          {on.length ? (
            <>
              <div style={{ height: 18 }} />
              <Tablo
                baslik={`Birleştirme önerileri · ${on.length}`}
                not="⚠ ÖNERİ — otomatik birleştirilmedi. Satıra tıklayın: iki kümeyi yan yana görürsünüz."
                kolonlar={[{ ad: 'Bu' }, { ad: 'ile bu' }, { ad: 'Neden' },
                  { ad: 'Benzerlik', sag: true }, { ad: 'Toplam', sag: true }]}
                satirlar={on.map((o, i) => ({
                  id: `o${i}`, _o: o,
                  hucreler: [
                    { v: o.a, kalin: true }, { v: o.b, kalin: true },
                    { v: o.gerekce, renk: R.not2 },
                    { v: `%${Math.round(o.benzerlik * 100)}`, sag: true, mono: true,
                      renk: o.benzerlik >= 0.9 ? R.amber : R.not2 },
                    { v: fmt(o.toplam), sag: true, mono: true },
                  ],
                }))}
                onSatir={(row) => gocOnerisiAc(row._o, km)}
              />
            </>
          ) : null}
        </>
      );
    }

    return <BosDurum baslik="Görünüm bulunamadı" ikon="❓" />;
  };

  return (
    <div>
      {kasaSeridi()}
      {govde()}
    </div>
  );
}
