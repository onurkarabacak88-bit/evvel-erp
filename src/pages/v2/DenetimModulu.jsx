// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — DENETİM & ZEKÂ modülü (kadife koyu)
// Blueprint: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html → denetim.* bölümleri
//
// 7 görünüm: Bugünkü Bulgular · Tanı Motorları · Olay Yelpazesi · Duyu Mutabakatı ·
//            Bağ Defteri · Duyu Paneli · Strateji Motoru
//
// İlkeler:
// - HER ŞEY ÖNERİ-ONLY: motorlar yalnız önerir, hüküm insanın. Bu modül hiçbir
//   yazma yapmaz; derin inceleme mevcut Akıllı Denetim / Duyu Paneli ekranlarında.
// - Blueprint'in demo rakamları (24 sinyal, %8 yanlış alarm, +41.200 ₺ etki)
//   KOPYALANMADI — ölçülmeyen metrik gösterilmez (sahte sayı yasağı). Yanlış
//   alarm oranı ve "ölçülen etki" sistemde takip edilmiyor; eklenirse gelir.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey } from './tema';
import { KpiSeridi, Liste, Tablo, BosDurum, HataBandi } from './parcalar';
// N3 — kritik-nakit birleştirme TEK YERDEN (Bakış da aynı yardımcıyı kullanır).
import { kritikNakitAyir, kritikNakitBaslik, kritikNakitAlt } from './oneriGrup';

const sayi = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bugunISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const tarihKisa = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (s.length < 10) return '—';
  return `${Number(s.slice(8, 10))} ${AYLAR[Number(s.slice(5, 7)) - 1] || ''}`;
};
const kisalt = (s, n = 150) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Yerli form stilleri (köprü kaldırma turu)
const dnAlanStil = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
const dnEtiket = {
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

/** Ham gözlem satırı → çekmece. Bulgular ekranının ham katmanı ile eski
 *  Olay Yelpazesi aynı çekmeceyi paylaşır; tanım tek yerde durur. */
function hamOlayCekmecesi(n) {
  return {
    tip: 'OLAY KAYDI',
    baslik: kisalt(n.baslik || n.tip || 'Gözlem', 70),
    alt: `${tarihKisa(n.gun || n.tarih)}${n.sube_adi ? ` · ${n.sube_adi}` : ''}${n.tip ? ` · ${n.tip}` : ''}`,
    kpi: [
      { etiket: 'Tarih', deger: tarihKisa(n.gun || n.tarih) },
      { etiket: 'Tip', deger: n.tip || 'gözlem' },
      { etiket: 'Şube', deger: n.sube_adi || 'genel' },
      { etiket: 'Kaynak', deger: n.kaynak || (String(n.baslik || '').startsWith('[') ? 'sistem' : 'insan') },
    ],
    listeBaslik: 'Kayıt',
    satirlar: [
      { ad: 'Not', detay: 'ham gözlem', tutar: kisalt(n.metin || n.ozet || n.not || n.baslik || '—', 90) },
      { ad: 'Kayıt zamanı', detay: 'append-only defter', tutar: n.olusturma ? String(n.olusturma).slice(0, 16).replace('T', ' ') : '—' },
    ],
    not: 'Olaylar HAM gözlemdir — beyin bu notu okur ama yorum ayrı katmandadır (duyu duysun, beyin sonra çalışsın).',
    aksiyonAd: '🧠 Beyne bu olayı sor',
    _hedef: '__gorunum:duyu',
  };
}

export default function DenetimModulu({ gorunum, onCekmece, onKopru, onToast, onGorunum }) {
  const [mm, setMm] = useState(null);                // /ops/mutabakat-merkezi
  const [mmYukleniyor, setMmYukleniyor] = useState(false);
  const [mmKova, setMmKova] = useState(null);        // açık kova kodu
  const [mmYuklenen, setMmYuklenen] = useState('');  // PDF yüklenen satır id
  const [rapor, setRapor] = useState(null);          // truth gunluk-rapor
  const [durum, setDurum] = useState(null);          // truth durum
  const [truthHata, setTruthHata] = useState('');
  const [iziOzet, setIziOzet] = useState(null);      // duyu 3/6: bulgu yaşam döngüsü
  const [isaretliler, setIsaretliler] = useState({}); // ref → karar (oturum içi)
  const [ozet, setOzet] = useState(null);            // duyu ozet
  const [notlar, setNotlar] = useState(null);        // duyu gunluk-notlar
  const [olayHata, setOlayHata] = useState('');
  // Bugünkü Bulgular iki katman: 'cikarim' (motor) · 'ham' (olay defteri)
  const [bulguKatman, setBulguKatman] = useState('cikarim');
  const [mutabakat, setMutabakat] = useState(null);
  const [mutHata, setMutHata] = useState('');
  // ── TÜKETİM DÖRTGENİ (/duyu/dortgen) — şube seviyesinde çalışır.
  // Ödeme mutabakatı İKİ köşeyi (kasa ↔ ödeme kaydı) karşılaştırır; dörtgen
  // DÖRT köşeyi yan yana koyar: giren · kullanım · satış · sayım.
  // Aynı iş (mutabakat), aynı görünüm — ayrı ekran açılmadı.
  // Dört duyu ucu tek blokta — uyanış · müdahale izi · kayıt disiplini · fark profili
  const [duyuKesit, setDuyuKesit] = useState(null);
  const [dortSubeler, setDortSubeler] = useState([]);
  const [dortSube, setDortSube] = useState('');
  const [dortgen, setDortgen] = useState(null);
  const [beyin, setBeyin] = useState(null);
  const [dilekler, setDilekler] = useState(null);
  // Yazma-ucu turu (2026-08-03): /duyu/yavru-kurallari son_baglar + POST
  // /duyu/yavru-etiket — Y4'ün ÖĞRETMEN kanalı. v2'de bağlar hiç listelenmiyordu;
  // ✓/✗ işareti olmadan kural ağırlıkları n eşiğine hiç ulaşamaz (öğrenme kör).
  const [bagOlaylar, setBagOlaylar] = useState(null);
  const [etiketMesgul, setEtiketMesgul] = useState('');
  // ── YERLİ BEYİN SOHBETİ (köprü kaldırma turu, 2026-07-30) ─────────────────
  // Klasik DuyuPaneli'nin en değerli parçası: hafızalı sohbet (/beyin/sor) +
  // cevap etiketleme (/beyin/cevap-etiket). Beyin karar vermez, kayda işaret eder.
  const [soru, setSoru] = useState('');
  const [mesajlar, setMesajlar] = useState([]);   // {rol:'sen'|'beyin', metin, ...}
  const [oturumId, setOturumId] = useState(null);
  const [sohbetMesgul, setSohbetMesgul] = useState(false);
  const [sohbetHata, setSohbetHata] = useState('');
  // Günlük not (işletme günlüğü — duyu dilekleriyle doğan akış)
  const [notForm, setNotForm] = useState(null);   // {baslik, tip, sube_id}
  const [notMesgul, setNotMesgul] = useState(false);
  // N3 — Strateji'deki "NAKİT YETERSİZ" grubu açık mı (yalnız görünüm durumu).
  // ⚠️ Hook, görünüm dallarının ÜSTÜNDE durmak zorunda (koşullu hook yasak).
  const [nakitGrupAcik, setNakitGrupAcik] = useState(false);
  const [notSubeler, setNotSubeler] = useState([]);
  const [bagHata, setBagHata] = useState('');
  const [karne, setKarne] = useState(null);
  const [sinaps, setSinaps] = useState(null);
  const [duyuHata, setDuyuHata] = useState('');
  const [strateji, setStrateji] = useState(null);
  const [stratejiHata, setStratejiHata] = useState('');
  // Toplu ödeme koşusu (klasik Strateji ekranının tek yazma akışı) — TEK
  // TRANSACTION: biri düşerse hepsi geri alınır (uçtaki guard).
  const [topluSor, setTopluSor] = useState(false);
  const [topluMesgul, setTopluMesgul] = useState(false);

  const truthYukle = useCallback(() => {
    setTruthHata('');
    api(`/ops/truth/gunluk-rapor?tarih=${bugunISO()}`)
      .then((d) => setRapor(d || {}))
      .catch((e) => setTruthHata(e?.message || ''));
    api('/ops/truth/durum')
      .then((d) => setDurum(d || {}))
      // 🔴 EVV-DEN-N4 (2026-08-13) FAKE-GREEN: durum okuması DÜŞÜNCE {} olup motorlar
      // "KAPALI" gösteriyordu → DENETİM ekranı kendini kör/kapalı sanıyor (okuma
      // hatası ≠ motor kapalı). truthHata'ya bağla (view'ler 672/813 gate'ler).
      .catch((e) => setTruthHata(e?.message || 'Motor durumu okunamadı — yenileyin'));
    api('/ops/bulgu-izi/ozet?gun=30')
      .then((d) => {
        setIziOzet(d || {});
        const m = {};
        (d?.isaretli_refler || []).forEach((x) => { m[x.ref] = x.karar; });
        setIsaretliler((p) => ({ ...m, ...p }));
      })
      .catch(() => setIziOzet({}));
  }, []);

  // Bulgu işareti (append-only defter) — çift tık koruması yerel state'te
  const bulguIsaretle = useCallback((ref, karar) => {
    setIsaretliler((p) => ({ ...p, [ref]: karar }));
    api('/ops/bulgu-izi', { method: 'POST', body: { bulgu_ref: ref, karar } })
      .then(() => onToast?.(
        karar === 'cozuldu' ? '✓ Çözüldü olarak işaretlendi'
          : karar === 'uygulandi' ? '✓ Uygulandı — akıbet defterine yazıldı'
            : karar === 'ertelendi' ? '⏸ Ertelendi — öneri duruyor, kararın deftere yazıldı'
              : '✗ Yanlış alarm olarak işaretlendi'))
      .catch(() => {
        setIsaretliler((p) => { const q = { ...p }; delete q[ref]; return q; });
        onToast?.('İşaret kaydedilemedi');
      });
  }, [onToast]);

  const olayYukle = useCallback(() => {
    setOlayHata('');
    api('/duyu/ozet').then((d) => setOzet(d || {})).catch((e) => setOlayHata(e?.message || ''));
    api('/duyu/gunluk-notlar?gun=7').then((d) => setNotlar(d || {})).catch(() => setNotlar({}));
  }, []);

  const mutYukle = useCallback(() => {
    setMutHata('');
    // Şube listesi — dörtgen ŞUBE seviyesinde çalışır (sube_id zorunlu)
    api('/subeler').then((d) => {
      const liste = Array.isArray(d) ? d : (d?.subeler || []);
      setDortSubeler(liste);
      if (liste.length) setDortSube((s) => s || String(liste[0].id));
    }).catch(() => setDortSubeler([]));
    // ── DÖRT DUYU UCU DAHA — hepsi v2'de HİÇ çağrılmıyordu. Ayrı ayrı ekran
    // açmak yerine TEK "duyu kesiti" bölümünde toplandı (ajan kararı):
    //   uyanis-hazirlik    → motor uyanmaya hazır mı (termometre, takvim değil)
    //   mudahale-izi       → geçmişe dokunan işlemlerin izi (insider kör noktası)
    //   kayit-disiplini    → açıklama yoğunluğu · ödeme karması · kapanış sonrası
    //   kapanis-fark-profil→ şube bazında kasa farkı profili (İSİMSİZ)
    Promise.all([
      api('/duyu/uyanis-hazirlik').catch(() => null),
      api('/duyu/mudahale-izi?gun=30').catch(() => null),
      api('/duyu/kayit-disiplini?gun=14').catch(() => null),
      api('/duyu/kapanis-fark-profil?gun=30').catch(() => null),
      // satis-butunluk: zımni fiyat (ciro/adet) menü fiyatına kıyaslanır.
      // Sapma HÜKÜM DEĞİL — kampanya/ikram/yeni fiyat aynı izi bırakır.
      api('/duyu/satis-butunluk?gun=14').catch(() => null),
    ]).then(([uh, mi, kd, kfp, sb]) => setDuyuKesit({ uyanis: uh, mudahale: mi, disiplin: kd, farkProfil: kfp, satis: sb }))
      .catch(() => setDuyuKesit(null));
    api('/duyu/odeme-mutabakat?gun=60')
      .then((d) => setMutabakat(d || {}))
      .catch((e) => setMutHata(e?.message || ''));
  }, []);

  const bagYukle = useCallback(() => {
    setBagHata('');
    api('/beyin/gunluk?limit=10')
      .then((d) => setBeyin(Array.isArray(d?.kayitlar) ? d.kayitlar : []))
      .catch((e) => setBagHata(e?.message || ''));
    api('/beyin/bag-dilekleri?sadece_acik=1')
      .then((d) => setDilekler(Array.isArray(d?.dilekler) ? d.dilekler : []))
      .catch(() => setDilekler([]));
    // Son bağ olayları + insan kararları (öğretmen kanalı)
    api('/duyu/yavru-kurallari?gun=7')
      .then((d) => setBagOlaylar(Array.isArray(d?.son_baglar) ? d.son_baglar : []))
      .catch(() => setBagOlaylar([]));
  }, []);

  /**
   * Bağa insan işareti: ✓ doğru bağ / ✗ yanlış bağ (POST /duyu/yavru-etiket).
   * Sunucu sözü: etiket bağı KAPATMAZ, yalnız kuralın isabet karnesine yazılır;
   * karar upsert'tir — fikir değiştirme hakkı öğretmen defterinde de geçerli.
   */
  const bagEtiketle = async (b, karar) => {
    if (!b?.event_id || etiketMesgul) return;
    setEtiketMesgul(String(b.event_id));
    try {
      const r = await api('/duyu/yavru-etiket', { method: 'POST', body: { event_id: b.event_id, karar } });
      if (r?.ok === false) { onToast?.(r?.hata || 'İşaret kaydedilemedi'); return; }
      setBagOlaylar((liste) => (liste || []).map((x) =>
        String(x.event_id) === String(b.event_id) ? { ...x, insan_karari: karar } : x));
      onToast?.(karar === 'dogru_bag' ? '✓ doğru bağ işaretlendi' : '✗ yanlış bağ işaretlendi');
    } catch (e) {
      onToast?.(e?.message || 'İşaret kaydedilemedi');
    } finally {
      setEtiketMesgul('');
    }
  };

  // Kural kütüphanesi tanımları (soru 8/9) — tıklamada bir kez çekilir, ref'te tutulur
  const kuralTanimRef = useRef(null);

  // 🧠 ÖĞRENME HALKASI (2026-08-27) — duyular ile zekâyı BİRLEŞTİREN ölçüm.
  // Sistemin altı halkası ayrı ayrı çalışıyordu ama hiçbir ekran zinciri
  // BÜTÜN olarak göstermiyordu: duyu üretir → sinaps bağ kurar → insan
  // etiketler → kural öğrenir → motor bulgu üretir → insan karar verir.
  // Halka görünmediği için NEREDE koptuğu da görünmüyordu.
  // ⚠️ Bu bir ÖLÇÜM katmanıdır, yeni bir karar mekanizması değil: hiçbir şeyi
  // otomatik etiketlemez, hiçbir kuralın ağırlığını değiştirmez. Yalnız
  // zincirin hangi halkasında kaç kayıt olduğunu yan yana koyar (öneri-only).
  const [etiketKirilim, setEtiketKirilim] = useState(null);
  const duyuYukle = useCallback(() => {
    setDuyuHata('');
    api('/duyu/kural-karnesi')
      .then((d) => setKarne(d || {}))
      .catch((e) => setDuyuHata(e?.message || ''));
    api('/duyu/sinapsler?gun=14').then((d) => setSinaps(d || {})).catch(() => setSinaps({}));
    // Halka için: omurga sayaçları + etiketlerin KAYNAK kırılımı.
    // ⚠️ Hata-yutar: halka çizilemezse ekranın kalanı yaşar, ama halka
    // "okunamadı" der — sessizce 0 göstermez.
    api('/duyu/ozet').then((d) => setOzet(d || {})).catch(() => setOzet('__HATA__'));
    api('/duyu/etiketler?limit=500')
      .then((d) => {
        const l = Array.isArray(d) ? d : (d?.etiketler || d?.satirlar || null);
        if (!Array.isArray(l)) { setEtiketKirilim('__HATA__'); return; }
        const m = {};
        l.forEach((x) => { const k = String(x?.kaynak || 'bilinmiyor'); m[k] = (m[k] || 0) + 1; });
        setEtiketKirilim({ toplam: l.length, kaynaklar: m });
      })
      .catch(() => setEtiketKirilim('__HATA__'));
  }, []);

  /**
   * KURAL TANIMI çekmecesi (soru 8/9) — /duyu/yavru-kurallari.
   * Karne satırı "R6 doğru 4 / yanlış 1" der ama R6'nın NE olduğunu söylemez;
   * bu uç kural kütüphanesinin tanımını verir (ebeveyn→çocuk, pencere, tür).
   * Sahip kararı: YALNIZ `kurallar` tanımları okunur — `son_baglar` ALINMAZ
   * (bağ akışı zaten Bağ Defteri'nde; ikinci kopya kurulmaz).
   */
  const kuralTanimAc = async (k) => {
    let tanimlar = kuralTanimRef.current;
    if (!tanimlar) {
      try {
        const d = await api('/duyu/yavru-kurallari?gun=7');
        tanimlar = Array.isArray(d?.kurallar) ? d.kurallar : [];
        kuralTanimRef.current = tanimlar;
      } catch (e) {
        onToast?.(e?.message || 'Kural kütüphanesi okunamadı');
        return;
      }
    }
    const t = tanimlar.find((x) => String(x.kural_id) === String(k.kural_id)) || null;
    if (!t) {
      onToast?.(`${k.kural_id || 'Kural'} için kütüphane tanımı bulunamadı.`);
      return;
    }
    const TUR_AD = {
      T1: 'T1 · durağan bağ — "çocuk olay ebeveynden ötürü olabilir" der, sinyali KAPATMAZ',
      T2: 'T2 · beklenti — "ebeveyn olduysa çocuk DOĞMALI" der; yokluk sinyaldir',
    };
    onCekmece?.({
      tip: 'KURAL TANIMI · KÜTÜPHANE',
      baslik: t.kural_id,
      alt: `sürüm ${sayi(t.surum) || 1} · ${t.gecerli_bas || '—'} tarihinden beri · ${t.aktif ? 'aktif' : 'kapalı'}`,
      kpi: [
        { etiket: 'Tür', deger: t.tur || '—', renk: t.tur === 'T2' ? R.mavi : R.krem },
        { etiket: 'Pencere', deger: `${sayi(t.pencere_gun)} gün`, renk: R.krem },
        { etiket: 'Eşleşme', deger: t.eslesme || '—', renk: R.krem },
        { etiket: 'Durum', deger: t.aktif ? 'aktif' : 'kapalı', renk: t.aktif ? R.yesil : R.not3 },
      ],
      listeBaslik: 'Kuralın cümlesi',
      satirlar: [
        { ad: '📖 Açıklama', detay: t.aciklama || '—', tutar: '' },
        { ad: '⬆ Ebeveyn olay', detay: t.ebeveyn || '—', tutar: '' },
        { ad: '⬇ Çocuk olay', detay: t.cocuk || '—', tutar: '' },
        { ad: '🧬 Yaşam döngüsü', detay: t.yasam_dongusu || '—', tutar: '' },
        { ad: '⏱ Pencere çapası', detay: t.pencere_capasi || '—', tutar: '' },
      ],
      not: (TUR_AD[t.tur] || 'Kural türü bilinmiyor.')
        + ' Kural ekleme yalnız insan onayıyla (kod commit\'i) olur; karne bu kuralın davranışını ölçer, bağ akışı Bağ Defteri\'ndedir.',
    });
  };

  // ── beyin sohbeti (klasik DuyuPaneli sözleşmesi aynen) ────────────────────
  const sor = async () => {
    const s = soru.trim();
    if (s.length < 3 || sohbetMesgul) return;
    setSohbetMesgul(true);
    setSohbetHata('');
    setSoru('');
    setMesajlar((m) => [...m, { rol: 'sen', metin: s }]);
    try {
      const r = await api('/beyin/sor', { method: 'POST', body: { soru: s, oturum_id: oturumId } });
      if (r?.oturum_id) setOturumId(r.oturum_id);
      setMesajlar((m) => [...m, {
        rol: 'beyin', metin: r?.cevap || '—', bloklar: r?.bloklar,
        etiket: r?.etiket, dipnot: r?.dipnot, gunlukId: r?.gunluk_id, puan: null,
      }]);
    } catch (e) {
      setSohbetHata(e?.message || 'Beyin yanıt veremedi');
    } finally {
      setSohbetMesgul(false);
    }
  };

  const cevapEtiketle = (gunlukId, karar) => {
    api('/beyin/cevap-etiket', { method: 'POST', body: { gunluk_id: gunlukId, karar } })
      .then(() => setMesajlar((ms) => ms.map((x) => (x.gunlukId === gunlukId ? { ...x, puan: karar } : x))))
      // 🔵 EVV-DEN-N2 (2026-08-13): etiket yazımı düşerse sessiz yutuluyordu → kullanıcı
      // işaretlendi sanıyordu (puan set edilmese de geri bildirim yoktu). Toast ile görünür.
      .catch(() => onToast?.('Etiket kaydedilemedi — tekrar deneyin'));
  };

  const notAc = () => {
    setNotForm({ baslik: '', tip: 'gozlem', sube_id: '' });
    if (!notSubeler.length) api('/subeler').then((d) => setNotSubeler(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const notKaydet = async () => {
    if (!(notForm?.baslik || '').trim()) { onToast?.('Not başlığı gerekli'); return; }
    if (notMesgul) return;   // 🔵 EVV-DEN-N5 (2026-08-13) çift-tık: mükerrer günlük notu önle
    setNotMesgul(true);
    try {
      await api('/duyu/gunluk-not', {
        method: 'POST',
        body: { baslik: notForm.baslik.trim(), tip: notForm.tip, sube_id: notForm.sube_id || null },
      });
      onToast?.('✓ İşletme günlüğüne yazıldı — beyin bunu okur');
      setNotForm(null);
      olayYukle();
    } catch (e) {
      onToast?.(e?.message || 'Kaydedilemedi');
    } finally {
      setNotMesgul(false);
    }
  };

  const topluUygula = async () => {
    const uygulanabilir = (strateji?.oneriler || []).filter(
      (o) => o.oneri_turu !== 'ERTELE' && o.odeme_id && sayi(o.tavsiye_tutar) > 0);
    if (!uygulanabilir.length) { onToast?.('Uygulanabilir öneri yok'); setTopluSor(false); return; }
    if (topluMesgul) return;   // 🔵 EVV-DEN-N6 (2026-08-13) çift-tık: toplu ödeme (advisory→kasa) mükerrer önle
    setTopluMesgul(true);
    try {
      const r = await api('/toplu-odeme', {
        method: 'POST',
        body: { odemeler: uygulanabilir.map((o) => ({ odeme_id: o.odeme_id, tutar: sayi(o.tavsiye_tutar) })) },
      });
      onToast?.(`✓ ${sayi(r?.uygulanan)}/${uygulanabilir.length} ödeme uygulandı`);
      setTopluSor(false);
      stratejiYukle();
    } catch (e) {
      onToast?.(e?.message || 'Toplu ödeme başarısız — hiçbiri uygulanmadı');
    } finally {
      setTopluMesgul(false);
    }
  };

  const stratejiYukle = useCallback(() => {
    setStratejiHata('');
    api('/strateji')
      .then((d) => setStrateji(d || {}))
      .catch((e) => setStratejiHata(e?.message || ''));
    api('/ops/bulgu-izi/ozet?gun=30')
      .then((d) => {
        setIziOzet(d || {});
        const m = {};
        (d?.isaretli_refler || []).forEach((x) => { m[x.ref] = x.karar; });
        setIsaretliler((p) => ({ ...m, ...p }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (gorunum === 'anomali' || gorunum === 'motorlar') truthYukle();
    // Bulgular ekranı iki katman taşır (çıkarım + ham gözlem) — ikisi de yüklenir
    if (gorunum === 'anomali' || gorunum === 'olaylar') olayYukle();
    if (gorunum === 'mutabakat') mutYukle();
    // MUTABAKAT MERKEZİ — 6 kova tek uçtan (aradım/bulamadım/ne yapmalı)
    if (gorunum === 'mutabakatmerkezi' && !mm) {
      setMmYukleniyor(true);
      api('/ops/mutabakat-merkezi?gun=60')
        .then((d) => setMm(d || null))
        .catch(() => setMm(null))
        .finally(() => setMmYukleniyor(false));
    }
    // Dörtgen seçili şubeye göre ayrı çekilir (sube_id zorunlu uç)
    if (gorunum === 'mutabakat' && dortSube) {
      api(`/duyu/dortgen?sube_id=${encodeURIComponent(dortSube)}&gun=7`)
        .then((d) => setDortgen(d || null))
        .catch(() => setDortgen(null));
    }
    if (gorunum === 'bag') bagYukle();
    if (gorunum === 'duyu') duyuYukle();
    if (gorunum === 'strateji') stratejiYukle();
    // dortSube bağımlılıkta: şube değişince dörtgen yeniden çekilir
  }, [gorunum, dortSube, truthYukle, olayYukle, mutYukle, bagYukle, duyuYukle, stratejiYukle]);

  // ════════════════════════ GÖRÜNÜM: BUGÜNKÜ BULGULAR ═══════════════════════
  // ── MUTABAKAT MERKEZİ ────────────────────────────────────────────────────
  // "Aradım, bulamadım: ne yapmalı?" Altı kova tek kapıda; her satır dört
  // soruya cevap verir. Hüküm yok — aksiyon sahibin.
  if (gorunum === 'mutabakatmerkezi') {
    if (mmYukleniyor && !mm) return <Yukleniyor />;
    if (!mm) {
      return (
        <BosDurum
          baslik="Mutabakat verisi alınamadı"
          aciklama="Uç yanıt vermedi. Yenile'yi deneyin; sorun sürerse kayıtlar birikmeye devam eder, kayıp olmaz."
        />
      );
    }
    const o = mm.ozet || {};
    const kovalar = Array.isArray(mm.kovalar) ? mm.kovalar : [];
    const acikKova = kovalar.find((k) => k.kod === mmKova) || null;
    // ── MERKEZ PDF KANALI (2026-08-08, sahip deseni) ────────────────────────
    // İKİ KANAL vardır: şube personeli teslim anında FOTOĞRAF yükler (OCR yolu);
    // fatura o an gelmediyse merkez sonradan PDF yükler. PDF kanalı bugüne dek
    // yalnız CEP'te vardı — masaüstünde "mal geldi, faturası yok" satırı
    // görülüyor ama oradan yüklenemiyordu. Aynı guard'lı uca bağlanır
    // (/belge-talep/{id}/fatura-yukle); tek yazıcı ilkesi korunur.
    const teslimatPdfYukle = async (satirId, dosya) => {
      // 🔵 EVV-DEN-N3 (2026-08-13): mmYuklenen tek global marker; guard yoktu →
      // bir yükleme sürerken başka satır 2. yüklemeyi başlatabiliyordu. Erken-çıkış.
      if (!dosya || !satirId || mmYuklenen) return;
      setMmYuklenen(satirId);
      try {
        const fd = new FormData();
        fd.append('dosya', dosya, dosya.name || 'fatura.pdf');
        const res = await fetch(`/api/belge-talep/${satirId}/fatura-yukle`, { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((j && (j.detail || j.mesaj)) || 'Yükleme başarısız');
        onToast?.('✓ Fatura yüklendi — teslimat kapandı, borç kuyruğuna düşecek');
        setMm(null);   // listeyi tazele (yeniden çekilir)
      } catch (e) {
        onToast?.(`⚠ ${e?.message || 'Yükleme başarısız'}`);
      } finally {
        setMmYuklenen('');
      }
    };
    // Aksiyon → hangi ekrana köprü (yazma o ekranların guard'lı akışında kalır)
    const AKSIYON_HEDEF = {
      fatura_iste: { ad: '📩 Fatura İstek ekranı', hedef: '__modul:belge:istek' },
      tutar_gir: { ad: '🧾 Fatura Arşivi', hedef: '__modul:belge:arsiv' },
      belge_bagla: { ad: '📄 Belge Kapsama', hedef: '__modul:belge:kapsama' },
      kasa_izi_uret: { ad: '💰 Kasa Teslim', hedef: '__modul:para:kasa' },
      banka_kaydet: { ad: '🏦 Ödeme Merkezi', hedef: '__modul:odeme:gecmis' },
    };
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açık kalem', deger: String(sayi(o.acik_kalem)), alt: `${sayi(o.kova_sayisi)} kovada · son ${sayi(mm.pencere_gun)} gün`, renk: sayi(o.acik_kalem) ? R.kirmizi : R.yesil },
          { etiket: 'Toplam tutar', deger: fmt(sayi(o.toplam_tutar_tl)), alt: 'izi/belgesi eksik para', renk: R.bakirAcik },
          { etiket: 'Kritik kova', deger: String((o.kritik_kovalar || []).length), alt: (o.kritik_kovalar || []).length ? 'acil bakılmalı' : 'kritik yok', renk: (o.kritik_kovalar || []).length ? R.kirmizi : R.yesil },
          { etiket: 'İlke', deger: 'öneri-only', alt: 'sistem hüküm vermez', renk: R.not },
        ]} />

        <div style={{
          padding: '11px 15px', borderRadius: 12, marginBottom: 14, fontSize: 11.5, lineHeight: 1.65,
          background: 'rgba(96,165,250,.08)', border: '1px solid rgba(96,165,250,.24)', color: R.metin2,
        }}>
          Bu ekran <b>aradığı ve bulamadığı</b> kayıtları listeler. Her satır dört soruya cevap verir:
          ne aradım · nerede aradım · neden bulamadım · <b style={{ color: R.krem }}>ne yapmalı</b>.
          Hiçbir kayıt silinmez, otomatik düzeltilmez — karar sizin.
        </div>

        {/* Kova kartları */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))', gap: 10, marginBottom: 14 }}>
          {kovalar.map((k) => {
            const acik = k.kod === mmKova;
            // 🔴 (2026-08-27, Codex) `k.adet` NULL/eksik gelirse falsy → YEŞİL.
            // «Bu kovada iş yok» ile «bu kovayı okuyamadım» aynı renge düşüyordu.
            // Denetim ekranında bu, doğrudan alarm körlüğüdür.
            const adetBilinmiyor = k.adet == null;
            const renk = adetBilinmiyor ? R.not3
              : k.kritik ? R.kirmizi : sayi(k.adet) ? R.amber : R.yesil;
            return (
              <div
                key={k.kod}
                onClick={() => setMmKova(acik ? null : k.kod)}
                className="v2-hover-kalk"
                style={{
                  ...kartYuzey, padding: '13px 15px', cursor: 'pointer',
                  borderLeft: `3px solid ${renk}`,
                  outline: acik ? `1px solid ${R.bakir}66` : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: R.krem, flex: 1 }}>{k.ad}</span>
                  <span style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, color: renk }}>{sayi(k.adet)}</span>
                </div>
                <div style={{ fontSize: 11, color: R.not2, lineHeight: 1.5, minHeight: 30 }}>{k.aciklama}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8 }}>
                  {/* 🔴 (2026-08-27, Codex) FALSY-SIFIR: gerçek 0 ₺ «tutar
                      bilinmiyor» oluyordu. Sıfır bir cevaptır, cevapsızlık değil —
                      «bu kovada para yok» ile «tutarı okuyamadım» ayrı şeylerdir
                      ve para önceliklendirmesi tam bu ayrımla yapılır. */}
                  <span style={{ fontFamily: F.mono, fontSize: 12.5, color: k.tutar_tl == null ? R.not3 : (sayi(k.tutar_tl) ? R.bakirAcik : R.not2) }}>
                    {k.tutar_tl == null ? 'tutar okunamadı' : fmt(sayi(k.tutar_tl))}
                  </span>
                  <span style={{ fontSize: 10.5, color: R.not }}>{acik ? 'kapat ▲' : 'aç ▼'}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Açık kovanın satırları */}
        {acikKova && (acikKova.satirlar || []).length > 0 && (
          <>
            {/* MERKEZ PDF KANALI — yalnız "mal geldi, faturası yok" kovasında.
                Şube fotoğrafı teslim anında yükler; fatura sonradan geldiyse
                merkez buradan PDF olarak bağlar. Satır satır, teslimata damgalı. */}
            {acikKova.kod === 'teslim_faturasiz' && (
              <div style={{
                ...kartYuzey, padding: '12px 15px', marginBottom: 10,
                borderLeft: `3px solid ${R.mavi}`,
              }}>
                <div style={{ fontSize: 12.5, color: R.metin2, marginBottom: 9, lineHeight: 1.55 }}>
                  📎 <b style={{ color: R.krem }}>Fatura sonradan geldiyse buradan yükleyin.</b>{' '}
                  Şube teslim anında fotoğraf yükler (OCR); merkez, tedarikçiden gelen PDF'i
                  ilgili teslimata bağlar. Yüklenen belge o teslimata damgalanır ve borç kuyruğuna düşer.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {(acikKova.satirlar || []).slice(0, 12).map((s) => (
                    <div key={`yuk-${s.id}`} style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '7px 10px', borderRadius: 8, background: R.girinti,
                    }}>
                      <span style={{ fontSize: 12.5, color: R.krem, fontWeight: 600, minWidth: 120 }}>
                        {kisalt(String(s.tedarikci_ad || '—'), 22)}
                      </span>
                      <span style={{ fontSize: 11.5, color: R.not2 }}>
                        {s.sube_adi || '—'} · {String(s.tarih || '').slice(0, 10)}
                        {s.yas != null ? ` · ${s.yas} gün` : ''}
                      </span>
                      <span style={{ fontFamily: F.mono, fontSize: 12, color: R.bakirAcik }}>
                        {sayi(s.tutar) ? fmt(sayi(s.tutar)) : 'tutar bilinmiyor'}
                      </span>
                      <label style={{
                        marginLeft: 'auto', padding: '6px 13px', borderRadius: 8, cursor: 'pointer',
                        fontSize: 11.5, fontWeight: 700,
                        background: mmYuklenen === s.id ? R.cizgi3 : `${R.mavi}22`,
                        color: mmYuklenen === s.id ? R.not : R.mavi,
                        border: `1px solid ${R.mavi}44`,
                      }}>
                        {mmYuklenen === s.id ? '⏳ yükleniyor…' : '📎 PDF yükle'}
                        <input
                          type="file"
                          accept="application/pdf,image/*"
                          style={{ display: 'none' }}
                          disabled={mmYuklenen === s.id}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            teslimatPdfYukle(s.id, f);
                          }}
                        />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {AKSIYON_HEDEF[acikKova.aksiyon] && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => onKopru?.(AKSIYON_HEDEF[acikKova.aksiyon].hedef)}
                  style={{
                    padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                    fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                  }}
                >
                  {AKSIYON_HEDEF[acikKova.aksiyon].ad} →
                </button>
                <span style={{ fontSize: 11.5, color: R.not2 }}>
                  Yükleme/düzeltme o ekranın guard'lı akışında yapılır — buradan yalnız yönlendirilir.
                </span>
              </div>
            )}
            <Tablo
              baslik={`${acikKova.ad} · ${acikKova.adet} kalem`}
              not={acikKova.aciklama}
              kolonlar={[{ ad: 'Kayıt' }, { ad: 'Nerede' }, { ad: 'Tarih' }, { ad: 'Tutar', sag: true }, { ad: 'Ne yapmalı' }]}
              satirlar={(acikKova.satirlar || []).map((s, i) => {
                // Kova şemaları farklı — ortak dile çevir (uydurma alan okuma yok)
                const kayit = s.tedarikci_ad || s.tedarikci || s.aciklama || s.donem || '—';
                const nerede = s.sube_adi || s.sube_id || s.islem_turu || s.durum || '—';
                const tarih = s.tarih || s.vade || s.teslim_tarihi || '—';
                const tutar = sayi(s.tutar ?? s.elde_kalan_tl);
                const yas = s.yas != null ? ` · ${s.yas} gün` : '';
                return {
                  id: s.id || `mm-${i}`, _s: s,
                  hucreler: [
                    { v: kisalt(String(kayit), 42), kalin: true },
                    { v: String(nerede), renk: R.not },
                    { v: `${String(tarih).slice(0, 10)}${yas}`, mono: true, renk: R.not2 },
                    { v: tutar ? fmt(tutar) : '—', mono: true, sag: true, kalin: !!tutar },
                    { v: kisalt(String(s.ne_yapmali || '—'), 46), renk: R.metin2 },
                  ],
                };
              })}
              onSatir={(row) => {
                const s = row._s;
                onCekmece?.({
                  tip: 'MUTABAKAT KALEMİ',
                  baslik: String(s.tedarikci_ad || s.tedarikci || s.aciklama || acikKova.ad),
                  alt: acikKova.ad,
                  kpi: [
                    { etiket: 'Tutar', deger: sayi(s.tutar ?? s.elde_kalan_tl) ? fmt(sayi(s.tutar ?? s.elde_kalan_tl)) : 'bilinmiyor', renk: R.bakirAcik },
                    ...(s.yas != null ? [{ etiket: 'Yaş', deger: `${s.yas} gün`, renk: s.yas >= 15 ? R.kirmizi : R.amber }] : []),
                    { etiket: 'Aksiyon', deger: acikKova.aksiyon, renk: R.not },
                  ],
                  // ⚠️ (2026-08-27, Codex) SESSİZ KIRPMA: ham alanlar 12'de
                  // kesiliyordu ve kesildiği SÖYLENMİYORDU — «hangi veriye
                  // bakıldı?» sorusunun cevabı eksik kalıyordu. Kanıt katmanının
                  // yarısını göstermek, kanıtı göstermek değildir.
                  listeBaslik: (() => {
                    const n = Object.keys(s).filter((k) => k !== 'ne_yapmali').length;
                    return n > 12 ? `Kayıt ayrıntısı · ${n} alandan ilk 12'si` : 'Kayıt ayrıntısı';
                  })(),
                  // Ham alanları göster — hangi veriye bakıldığı gizlenmez
                  satirlar: Object.entries(s)
                    .filter(([k]) => k !== 'ne_yapmali')
                    .slice(0, 12)
                    .map(([k, v]) => ({ ad: k, detay: '', tutar: kisalt(String(v ?? '—'), 40) })),
                  not: `NE YAPMALI: ${s.ne_yapmali || acikKova.aksiyon}. ${mm.not || ''}`,
                });
              }}
            />
          </>
        )}
        {/* 🔴 (2026-08-27, Codex) NULL ile BOŞ AYNI SAYILIYORDU: `satirlar`
            gelmezse de «açık kalem yok — temiz» yazıyordu. Kuyruk verisi
            okunamadığında ekranın «temiz» demesi, denetim modülünün
            yapabileceği en kötü şeydir. Adet ile liste ÇELİŞİYORSA da söylenir. */}
        {acikKova && !Array.isArray(acikKova.satirlar) && (
          <BosDurum
            baslik={acikKova.ad}
            aciklama="Bu kovanın kalem listesi okunamadı — «açık kalem yok» demiyoruz, «bilmiyoruz» diyoruz. Yenileyin."
          />
        )}
        {acikKova && Array.isArray(acikKova.satirlar) && !acikKova.satirlar.length && (
          <BosDurum
            baslik={acikKova.ad}
            aciklama={sayi(acikKova.adet) > 0
              ? `Sayaç ${sayi(acikKova.adet)} kalem diyor ama liste boş geldi — iki kaynak çelişiyor, sayıya güvenmeyin.`
              : 'Bu kovada açık kalem yok — temiz.'}
            tamam={!(sayi(acikKova.adet) > 0)}
          />
        )}
      </>
    );
  }

  if (gorunum === 'anomali') {
    if (truthHata) return <HataBandi mesaj={truthHata} onTekrar={truthYukle} />;
    if (!rapor) return <Yukleniyor />;
    const subeler = Array.isArray(rapor.subeler) ? rapor.subeler : [];
    const toplamAnomali = subeler.reduce((t, s) => t + sayi(s.anomali_sayisi), 0);
    // ⚠️ (2026-08-27, Codex) ALARM EVRENİ YANLIŞTI: liste TÜM şubelerden
    // toplanıyordu. Ölçülmemiş bir şubenin yanıtta kalmış ESKİ `alarm` alanı
    // bugünün alarmı gibi sayılabiliyordu. `olculdu()` guard'ını değere ve
    // renge uygulayıp KAYNAK LİSTEYE uygulamamak, guard'ı yarım bırakmaktır.
    // (Not: `olculdu` aşağıda tanımlı ama bu satır render'da değil, hesapta
    // kullanılıyor — sıra için aşağı taşındı.)
    // 🔴 P0 SAHTE-SAKİN AŞISI (2026-08-17, Zekâ alanı denetimi): sunucu TÜM
    // şubeleri döndürüyor ve o gün hiç karar üretilmemişse ana_tani='UYUMLU',
    // anomali=0, calistirildi=false yazıyor. Ekran `calistirildi`/`motor_aktif`
    // alanlarını hiç okumadığı için MOTORU KOŞMAMIŞ şube "temiz gün" yeşili
    // basıyordu. CANLI KANIT: Alsancak motoru 16 Haziran'dan beri kapalı
    // (aktif=false) ama ekran "Uyumlu şube 4/4 · Bugün anomali 0 · 4 şube
    // tarandı" diyordu. Bu, üç sorunun ORTAK kökü: kapalı motor temiz görünüyor →
    // anomali 0 olduğu için işaretleme düğmesi hiç doğmuyor → karar defteri boş
    // kalıyor → yanlış-alarm oranı ölçülemiyor. Aynı tuzak 'motorlar'
    // görünümünde raporVar ile kapatılmıştı; burada açık kalmış.
    // KURAL: ölçülmemiş şube ne temiz ne kirlidir — PAYDA DIŞI kalır ve
    // "analiz edilmedi" diye görünür.
    const olculdu = (s) => s.calistirildi !== false && s.motor_aktif !== false;
    const olculen = subeler.filter(olculdu);
    const olculmeyen = subeler.filter((s) => !olculdu(s));
    const alarmli = olculen.filter((s) => s.alarm && s.alarm !== 'normal');
    const uyumlu = olculen.filter((s) => s.ana_tani === 'UYUMLU');
    const hamListe = Array.isArray(notlar?.notlar) ? notlar.notlar : [];
    const hamTipler = Array.isArray(notlar?.tipler) ? notlar.tipler : [];
    // 🔬 CANLI GEZİNTİ (2026-08-27) — MODÜLÜN EN ÖNEMLİ CÜMLESİ EKSİKTİ.
    // Ekran «bugün anomali 0» diyordu ama asıl haber şuydu: MOTOR KOŞMADI.
    // Canlı kanıt: 3 aktif şubenin son koşusu 25 Ağustos, bugün 27 — iki gece
    // atlanmış; 2 şubede motor Haziran'dan beri kapalı.
    // ⚠️ Bir denetim modülünün ilk söylemesi gereken şey, kendi ölçüm durumudur.
    // «Bulgu yok» ile «bakmadım» aynı ekranda aynı sessizliğe düşerse, modül
    // sahibi yanlış güvene sürükler — bu, alarm yorgunluğunun tersi ama aynı
    // derecede tehlikeli hâli: ALARM KÖRLÜĞÜ.
    // ⚠️ Bant yalnız GERÇEK bir gecikme varken çizilir (uyarı bütçesi):
    // motor taze koştuysa hiç görünmez.
    const motorDurumu = (() => {
      // ⚠️ (oto-tarama) ŞEKİL TUZAĞI: `durum` GELDİ ama `subeler` dizisi yoksa
      // eski hâl sessizce `null` dönüp bandı HİÇ çizmiyordu — yani okuma
      // bozulduğunda modül yine "sessiz sakin" görünüyordu. Bu dosyanın kendi
      // yorumu (satır ~889) tam bu tuzağı anlatıyor; aynısına düşmüşüm.
      if (durum && !Array.isArray(durum.subeler)) {
        return { sekilBozuk: true, kapali: [], eskiler: [], enEski: null, toplam: 0 };
      }
      const ds = Array.isArray(durum?.subeler) ? durum.subeler : [];
      if (!ds.length) return null;
      const bugunMs = Date.parse(`${bugunISO()}T00:00:00Z`);
      const yas = (d) => {
        const t = String(d || '').slice(0, 10);
        return /^\d{4}-\d{2}-\d{2}$/.test(t)
          ? Math.round((bugunMs - Date.parse(`${t}T00:00:00Z`)) / 86400000) : null;
      };
      const kapali = ds.filter((x) => x.aktif === false);
      const aktifler = ds.filter((x) => x.aktif !== false);
      // ⚠️ (oto-tarama) İKİ FARKLI VARSAYIM AYNI ALANDA: `eskiler` tarihsiz
      // şubeyi 99 gün sayıp listeye alıyordu ama `enEski` aynı şubeyi 0
      // sayıyordu → bant "1 aktif şubede gece koşusu 0 GÜNDÜR yapılmamış"
      // gibi anlamsız bir cümle üretebiliyordu. Tarihi olmayan şube AYRI
      // sayılır: "koşu tarihi yok" der, gün sayısına karışmaz.
      const tarihsiz = aktifler.filter((x) => yas(x.son_calisma) == null);
      const tarihli = aktifler.filter((x) => yas(x.son_calisma) != null);
      const eskiler = tarihli.filter((x) => yas(x.son_calisma) > 1);
      const enEski = eskiler.length
        ? eskiler.reduce((m, x) => Math.max(m, yas(x.son_calisma)), 0) : null;
      if (!kapali.length && !eskiler.length && !tarihsiz.length) return null;
      return { kapali, eskiler, tarihsiz, enEski, toplam: ds.length };
    })();

    return (
      <>
        {motorDurumu && (
          <div style={{
            ...kartYuzey, padding: '12px 17px', marginBottom: 13,
            borderLeft: `3px solid ${R.amber}`, fontSize: 12.5, color: R.metin2, lineHeight: 1.65,
          }}>
            🔇 <b style={{ color: R.krem }}>Denetim motoru tam çalışmıyor</b> — aşağıdaki sayılar
            «sorun yok» değil, <b>«bakılmadı»</b> anlamına gelebilir.
            {motorDurumu.sekilBozuk && (
              <> Motor durumu ucu <b style={{ color: R.krem }}>beklenmedik şekilde</b> yanıt verdi —
                koşu takvimi okunamadı, aşağıdaki sayılar teyit edilemiyor.</>
            )}
            {motorDurumu.eskiler.length > 0 && (
              <> {motorDurumu.eskiler.length} aktif şubede gece koşusu{' '}
                <b style={{ color: R.krem }}>{motorDurumu.enEski} gündür</b> yapılmamış
                ({motorDurumu.eskiler.map((x) => x.sube_ad).join(', ')}).</>
            )}
            {motorDurumu.tarihsiz?.length > 0 && (
              <> {motorDurumu.tarihsiz.length} aktif şubede{' '}
                <b style={{ color: R.krem }}>koşu tarihi hiç yok</b>
                {' '}({motorDurumu.tarihsiz.map((x) => x.sube_ad).join(', ')}) — motor hiç çalışmamış olabilir.</>
            )}
            {motorDurumu.kapali.length > 0 && (
              <> {motorDurumu.kapali.length} şubede motor <b style={{ color: R.krem }}>kapalı</b>
                {' '}({motorDurumu.kapali.map((x) => x.sube_ad).join(', ')}) — o şubeler için hüküm üretilmiyor.</>
            )}
            {' '}<span style={{ color: R.not3 }}>Koşu takvimi ve şube bazlı durum: Tanı Motorları sekmesi.</span>
          </div>
        )}
        <KpiSeridi kpiler={[
          // Payda artık ÖLÇÜLEN şube — "4 şube tarandı" derken 2'si hiç koşmamışsa yalan olur.
          { etiket: 'Bugün anomali', deger: String(toplamAnomali),
            alt: `${olculen.length} şube tarandı${olculmeyen.length ? ` · ${olculmeyen.length} analiz edilmedi` : ''}`,
            renk: toplamAnomali > 0 ? R.kirmizi : (olculen.length ? R.yesil : R.amber) },
          // 🔴 CANLI GEZİNTİ (2026-08-27) — GUARD'I BU KPI'YA UYGULAMAYI ATLAMIŞIM.
          // Kardeşi «Bugün anomali» ve «Uyumlu şube» `olculen.length` kapısını
          // taşıyor ama burası taşımıyordu: HİÇBİR ŞUBE ÖLÇÜLMEMİŞKEN
          // «Alarmlı şube 0 · yok» YEŞİL yazıyordu. Canlıda tam bu hâl vardı
          // (5 şubenin 5'i «analiz edilmedi»). Ölçülmemiş evrende «alarm yok»
          // demek, gözü kapalı «tehlike yok» demektir.
          {
            etiket: 'Alarmlı şube',
            deger: olculen.length ? String(alarmli.length) : '—',
            alt: alarmli.length ? alarmli.map((s) => s.sube_ad).join(' · ')
              : (olculen.length ? 'yok' : '⚠ hiçbir şube ölçülmedi — «yok» denemez'),
            renk: alarmli.length > 0 ? R.kirmizi : (olculen.length ? R.yesil : R.amber),
          },
          { etiket: 'Uyumlu şube', deger: `${uyumlu.length} / ${olculen.length}`,
            alt: olculmeyen.length ? `ölçülen içinde · ${olculmeyen.map((s) => s.sube_ad).join(', ')} hariç` : 'ana tanı UYUMLU',
            renk: olculen.length ? R.yesil : R.not },
          { etiket: 'Tarih', deger: tarihKisa(rapor.tarih), alt: 'gece koşusu + gün içi' },
        ]} />
        {/* DUYU 3/6 — bulgu yaşam döngüsü: işaret defterinden türeyen ölçümler */}
        {/* 🚪 CANLI GEZİNTİ (2026-08-27) — KARAR DEFTERİ KPI'LARININ KANITI
            EKRANDA YOKTU. Dört sayı da append-only defterden geliyor ama
            defterin kendisi hiçbir yerde açılmıyordu: sahip «yanlış alarm 0»
            görüyor, hangi kararların sayıldığını soramıyordu. Ölçülen şeyin
            kendisi görünmezse, ölçüm bir iddiadır — kanıt değil.
            ⚠️ YENİ UÇ ÇAĞRILMADI: `isaretli_refler` zaten bu yanıtın içinde
            geliyordu, yalnız sayılıp atılıyordu. Eksik olan kapıydı. */}
        {iziOzet && sayi(iziOzet.isaretli_bulgu) > 0 && (() => {
          const refler = Array.isArray(iziOzet.isaretli_refler) ? iziOzet.isaretli_refler : [];
          const kararAd = (k) => ({
            uygulandi: 'uygulandı', cozuldu: 'çözüldü', yanlis_alarm: 'yanlış alarm',
            ertelendi: 'ertelendi · şimdi değil', goruldu: 'görüldü',
          }[k] || k || '—');
          const kararRenk = (k) => ({
            uygulandi: R.yesil, cozuldu: R.yesil, yanlis_alarm: R.amber, ertelendi: R.not2,
          }[k] || R.not);
          const defteriAc = () => onCekmece?.({
            tip: 'KARAR DEFTERİ',
            baslik: 'İnsan kararlarının izi',
            alt: `${refler.length} kayıt · son ${sayi(iziOzet.kesit_gun) || 30} gün · append-only`,
            kpi: [
              { etiket: 'İşaretli bulgu', deger: String(sayi(iziOzet.isaretli_bulgu)) },
              { etiket: 'Çözülen', deger: String(sayi(iziOzet.cozulen)), renk: R.yesil },
              { etiket: 'Yanlış alarm', deger: String(sayi(iziOzet.yanlis_alarm)), renk: sayi(iziOzet.yanlis_alarm) > 0 ? R.amber : R.yesil },
            ],
            listeBaslik: 'Kararlar · en yeniden eskiye',
            satirlar: refler.map((x) => ({
              ad: String(x.ref || '—').slice(0, 70),
              detay: kararAd(x.karar),
              tutar: '',
            })),
            // ⚠️ Defter SİLİNMEZ: fikir değişirse yeni satır atılır, son satır
            // geçerlidir. Bu çekmece salt okur — karar kartların üstünden verilir.
            not: refler.length
              ? 'Defter append-only: bir karar silinmez, fikir değişirse yeni satır atılır ve son satır geçerli olur. Bu çekmece salt okur; kararlar bulgu kartlarının üstündeki ✓/✗ ile verilir.'
              : 'Bu kesitte işaretli karar yok — motorun isabeti ancak bulgulara ✓/✗ verildikçe ölçülebilir.',
          });
          return (
            <KpiSeridi kpiler={[
              { etiket: 'Çözülen (30g)', deger: String(sayi(iziOzet.cozulen)), alt: 'insan işaretiyle · deftere git', renk: R.yesil, onTikla: defteriAc },
              { etiket: 'Yanlış alarm', deger: String(sayi(iziOzet.yanlis_alarm)), alt: iziOzet.yanlis_alarm_orani_yuzde != null ? `oran %${iziOzet.yanlis_alarm_orani_yuzde}` : 'oran ölçülemedi', renk: sayi(iziOzet.yanlis_alarm) > 0 ? R.amber : R.yesil, onTikla: defteriAc },
              { etiket: 'Ort. çözüm süresi', deger: iziOzet.ort_cozum_saat != null ? `${iziOzet.ort_cozum_saat} sa` : '—', alt: 'gece doğum varsayımıyla ≈', onTikla: defteriAc },
              { etiket: 'İşaretli bulgu', deger: String(sayi(iziOzet.isaretli_bulgu)), alt: 'append-only defter · aç', onTikla: defteriAc },
            ]} />
          );
        })()}
        {/* ── İKİ KATMAN (sahip kararı 2026-07-30) ────────────────────────────
            Tasarım "tek varlık → tek ekran" diyor; bizim ilkemiz "ham veri
            kaybolmaz" diyor. İkisi de sağlanıyor: TEK ekran, İKİ katman.
            Çıkarım = motorun yorumu · Ham gözlem = olay defteri (append-only).
            Ham katman ÖNCE toplanır, çıkarım SONRA okunur — sıra bozulmaz. */}
        <div style={{
          display: 'flex', gap: 3, padding: 3, marginBottom: 14, borderRadius: 10,
          background: R.girinti, border: `1px solid ${R.cizgi}`, width: 'fit-content',
        }}>
          {[['cikarim', `Bulgular · ${toplamAnomali}`], ['ham', `Ham gözlem · ${hamListe.length}`]].map(([id, ad]) => (
            <div
              key={id}
              onClick={() => setBulguKatman(id)}
              style={{
                padding: '6px 14px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                color: bulguKatman === id ? '#1C1309' : R.not,
                background: bulguKatman === id ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : 'transparent',
              }}
            >
              {ad}
            </div>
          ))}
        </div>

        {bulguKatman === 'ham' ? (
          <>
            <OneriSeridi metin="Ham gözlem katmanı — olaylar olduğu gibi durur (duyu duysun, beyin sonra). Kayıt append-only'dir; buradaki hiçbir satır motorun yorumuyla değiştirilmez." />
            {hamListe.length === 0 ? (
              <BosDurum baslik="Ham gözlem yok" aciklama="Son 7 günde olay defterine not düşmemiş — defter sakin ya da notlar henüz üretilmedi." />
            ) : (
              <Liste
                satirlar={hamListe.slice(0, 30).map((n, i) => ({
                  id: n.id || `n-${i}`,
                  _n: n,
                  baslik: kisalt(n.baslik || n.tip || n.etiket || 'Gözlem', 70),
                  alt: `${tarihKisa(n.gun || n.tarih)} · ${kisalt(n.metin || n.ozet || n.not || '', 110)}`,
                  tutar: '',
                  tier: /kritik|alarm/i.test(String(n.tip || n.seviye || '')) ? 'kritik'
                    : /uyari|dikkat/i.test(String(n.tip || n.seviye || '')) ? 'uyari' : 'bilgi',
                }))}
                onAc={({ _n }) => onCekmece?.(hamOlayCekmecesi(_n))}
              />
            )}
            {hamTipler.length > 0 && (
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
                {hamTipler.slice(0, 12).map((t, i) => (
                  <span key={i} style={rozetHap(R.mavi)}>
                    {typeof t === 'string' ? t : (t?.tip || t?.ad || '—')}
                    {typeof t === 'object' && t?.adet != null ? ` · ${t.adet}` : ''}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
        <>
        <OneriSeridi metin="Motor yalnız ÖNERİR — bulgular insan onayı bekler. Kartlardaki ✓/✗ işaretleri append-only deftere yazılır; motorun isabeti bu işaretlerle ölçülür." />
        {subeler.length === 0 ? (
          <BosDurum metin="Bugün için tanı raporu yok — motor gece koşusuyla dolar." />
        ) : (
          <Liste
            satirlar={subeler.map((s) => {
              const ref = `truth:${s.sube_id}:${String(s.tarih || rapor.tarih || '').slice(0, 10)}:${s.ana_tani || 'GENEL'}`;
              const isaret = isaretliler[ref];
              const bulgulu = sayi(s.anomali_sayisi) > 0;
              // 🔴 P0: ölçülmemiş şube "temiz gün" DEMEZ — analiz edilmediğini söyler.
              // Sunucu koşmamış şubeye de ana_tani='UYUMLU' yazıyor (kapalı motor,
              // gece koşusu atlanmış gün); calistirildi/motor_aktif bunu ele veriyor.
              const olculmedi = s.calistirildi === false || s.motor_aktif === false;
              return {
                id: s.sube_id,
                baslik: `${s.sube_ad} · ${olculmedi ? 'ANALİZ EDİLMEDİ' : (s.ana_tani || '—')}`,
                alt: olculmedi
                  ? (s.motor_aktif === false
                      ? `motor kapalı${s.notu ? ` — ${kisalt(s.notu, 70)}` : ''} · bu şube için hüküm YOK`
                      : 'gece koşusu bu şubede çalışmadı · hüküm YOK')
                  : (kisalt(s.zeka_ozet || s.yorum_metni, 110)
                     || (bulgulu ? `${sayi(s.anomali_sayisi)} anomali · ${sayi(s.toplam_karar)} karar` : 'temiz gün')),
                tutar: olculmedi ? '—' : (bulgulu ? `${sayi(s.anomali_sayisi)} bulgu` : ''),
                // 'iyi' (yeşil) YALNIZ gerçekten ölçülüp temiz çıkanda; ölçülmeyen nötr.
                tier: olculmedi ? 'bilgi'
                  : (s.alarm && s.alarm !== 'normal' ? 'kritik' : bulgulu ? 'uyari' : 'iyi'),
                // Yaşam döngüsü işaretleri: yalnız bulgulu + henüz işaretsiz kartta
                ...(bulgulu && !isaret ? {
                  aksiyonlar: [
                    { ad: '✓ Çözüldü', birincil: true, onTikla: () => bulguIsaretle(ref, 'cozuldu') },
                    { ad: '✗ Yanlış alarm', onTikla: () => bulguIsaretle(ref, 'yanlis_alarm') },
                  ],
                } : {}),
                ...(isaret ? {
                  rozet: isaret === 'cozuldu' ? 'çözüldü ✓' : 'yanlış alarm',
                  rozetRenk: isaret === 'cozuldu' ? R.yesil : R.amber,
                } : (!bulgulu ? { aksiyon: 'İncele' } : {})),
                _s: s,
              };
            })}
            // 🔴 (2026-08-27, Codex) ÇEKMECE, LİSTENİN AKSİNİ SÖYLÜYORDU.
            // Üstteki kart «ANALİZ EDİLMEDİ» diyor, satıra tıklayınca açılan
            // çekmece aynı şube için «Anomali 0» YEŞİL ve «Alarm normal» YEŞİL
            // basıyordu. Yani kanıtı açmak, sahibi SAKİNLEŞTİRİYORDU — bu tam
            // olarak alarm körlüğü ve en kötü yerinde: kanıt katmanında.
            // ⚠️ Ölçülmemiş şubede sayı GÖSTERİLMEZ ('—'), renk NÖTR kalır ve
            // NEDEN ölçülmediği ilk satırda yazılır.
            onAc={({ _s }) => {
              const olcOK = _s.calistirildi !== false && _s.motor_aktif !== false;
              return onCekmece?.({
                tip: 'ŞUBE TANISI',
                baslik: _s.sube_ad,
                alt: olcOK ? `${_s.ana_tani || '—'} · ${tarihKisa(_s.tarih)}`
                  : `ANALİZ EDİLMEDİ · ${tarihKisa(_s.tarih)}`,
                kpi: [
                  {
                    etiket: 'Anomali',
                    deger: olcOK ? String(sayi(_s.anomali_sayisi)) : '—',
                    alt: olcOK ? undefined : 'motor bakmadı',
                    renk: !olcOK ? R.not3 : (sayi(_s.anomali_sayisi) > 0 ? R.kirmizi : R.yesil),
                  },
                  { etiket: 'Karar', deger: olcOK ? String(sayi(_s.toplam_karar)) : '—', renk: olcOK ? undefined : R.not3 },
                  {
                    etiket: 'Alarm',
                    deger: olcOK ? (_s.alarm || 'normal') : '—',
                    alt: olcOK ? undefined : 'hüküm yok',
                    renk: !olcOK ? R.not3 : (_s.alarm && _s.alarm !== 'normal' ? R.kirmizi : R.yesil),
                  },
                  { etiket: 'Motor', deger: _s.motor_aktif === false ? 'kapalı' : (_s.motor_mod || 'aktif'), renk: _s.motor_aktif === false ? R.amber : R.yesil },
                ],
                listeBaslik: (() => {
                  const n = Array.isArray(_s.boyut_ozet) ? _s.boyut_ozet.length : 0;
                  // ⚠️ (Codex) 10-tavan sessizdi.
                  return n > 10 ? `Boyut özeti · ${n} boyuttan ilk 10'u` : 'Boyut özeti';
                })(),
                satirlar: (Array.isArray(_s.boyut_ozet) ? _s.boyut_ozet : []).slice(0, 10).map((b, i) => ({
                  ad: typeof b === 'string' ? b : (b?.boyut || b?.ad || `boyut ${i + 1}`),
                  detay: typeof b === 'object' ? (b?.durum || '') : '',
                  tutar: typeof b === 'object' && b?.deger != null ? String(b.deger) : '',
                })),
                not: olcOK
                  ? (kisalt(_s.yorum_metni || _s.zeka_ozet, 300) || 'Bu gün için yorum üretilmedi.')
                  : `Bu şube için motor çalışmadı${_s.motor_aktif === false ? ' (motor kapalı)' : ''} — yukarıdaki «—» işaretleri «sorun yok» değil «bakılmadı» demektir. Koşu takvimi: Tanı Motorları sekmesi.`,
                aksiyonAd: 'Tanı Motorları’nı aç',
                _hedef: '__modul:denetim:motorlar',
              });
            }}
          />
        )}
        </>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: TANI MOTORLARI ═════════════════════════
  if (gorunum === 'motorlar') {
    if (truthHata) return <HataBandi mesaj={truthHata} onTekrar={truthYukle} />;
    if (!rapor || !durum) return <Yukleniyor />;
    const subeler = Array.isArray(durum.subeler) ? durum.subeler : [];
    const raporMap = {};
    (rapor.subeler || []).forEach((s) => { raporMap[String(s.sube_id)] = s; });
    const aktifSayi = subeler.filter((s) => s.aktif).length;
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Motor durumu', deger: durum.global_aktif ? 'AÇIK' : 'KAPALI', alt: 'küresel anahtar', renk: durum.global_aktif ? R.yesil : R.amber },
          { etiket: 'Aktif şube motoru', deger: `${aktifSayi} / ${subeler.length}`, alt: 'şube bazlı', renk: aktifSayi > 0 ? R.yesil : R.amber },
          { etiket: 'Tanı yelpazesi', deger: '13 tanı', alt: 'kasa · ciro · stok · N1-N3' },
          { etiket: 'İlke', deger: 'öneri-only', alt: 'insan onayı şart' },
        ]} />
        {subeler.length === 0 ? (
          <BosDurum metin="Motor durumu okunamadı." />
        ) : (
          <Tablo
            baslik="Tanı motorları · şube bazlı durum"
            not="satıra tıkla → bugünkü rapor; koşu gece 00:30"
            kolonlar={[
              { ad: 'Şube' }, { ad: 'Motor' }, { ad: 'Mod' }, { ad: 'Bugün bulgu', sag: 1 }, { ad: 'Son koşu' }, { ad: 'Durum' },
            ]}
            satirlar={subeler.map((s, i) => {
              const r = raporMap[String(s.sube_id)] || {};
              // 🔴 EVV-DEN-N1 (2026-08-13 satır-satır): rapor OLMAYAN şube (raporMap'te
              // yok) r={} → bulgu 0 → "temiz" yeşil görünüyordu. Analiz-edilmedi ≠ temiz;
              // denetim ekranında sessiz-başarısızlık. raporVar ile "rapor yok" ayrımı.
              const raporVar = !!raporMap[String(s.sube_id)];
              const bulgu = sayi(r.anomali_sayisi);
              return {
                id: s.sube_id || `m-${i}`,
                _s: { ...s, ...r },
                hucreler: [
                  { v: s.sube_ad || r.sube_ad || '—', kalin: true },
                  // ⚠️ ŞEKİL TUZAĞI (2026-08-07 denetimi): burada `s.motor_aktif` /
                  // `s.motor_mod` okunuyordu — /ops/truth/durum BÖYLE ALAN DÖNMÜYOR
                  // (sözleşme: sube_id, aktif, mod, son_calisma, notu, sube_ad).
                  // undefined → falsy → 5/5 şube "kapalı" göründü ve "Aktif şube
                  // motoru 0/5" yazdı. Gerçekte 3 şubede motor AÇIKTI. Bu, denetim
                  // ekranının kendisini kör gösteren bir okuma hatasıydı.
                  s.aktif ? { v: 'aktif', rozet: R.yesil } : { v: 'kapalı', rozet: R.amber },
                  { v: s.mod || '—', renk: R.not },
                  { v: raporVar ? String(bulgu) : '—', mono: true, sag: true, kalin: bulgu > 0, renk: !raporVar ? R.not3 : bulgu > 1 ? R.kirmizi : bulgu === 1 ? R.amber : R.not },
                  { v: String(s.son_calisma || r.son_calisma || '—').slice(0, 16), mono: true, renk: R.not },
                  // 🔴 CANLI GEZİNTİ (2026-08-27) — MOTORU KAPALI ŞUBEYE «TEMİZ» DENİYORDU.
                  // Canlı kanıt: ALSANCAK motoru KAPALI, son koşu 16 Haziran
                  // (2+ ay önce) — tablo yine de yeşil «temiz» basıyordu.
                  // MERKEZ aynı (15 Haziran). Üstelik AKTİF motorların son
                  // koşusu 25 Ağustos'tu ve bugün 27 — iki gecedir koşmamış
                  // motorlar da «temiz» görünüyordu.
                  // ⚠️ Bu tam olarak «Bugünkü Bulgular» görünümünde 2026-08-17'de
                  // kapatılan kusurun aynısı (`olculdu()` guard'ı); TABLOYA
                  // uygulanmamış — yarım kalan düzeltme.
                  // KURAL: motor bakmadıysa şube ne temiz ne kirlidir. Denetim
                  // ekranının kendisi «sorun yok» diyemez, ancak «bakmadım»
                  // diyebilir. Sahte sakinlik, denetimin en pahalı arızasıdır.
                  (() => {
                    // ⚠️ (2026-08-27, Codex) SIRA YANLIŞTI: `raporVar` en başta
                    // sorulunca, motor KAPALI olduğu için rapor üretilmeyen şube
                    // «rapor yok» diye görünüyordu — SEBEBİ gizleniyordu. Sahip
                    // «rapor gelmemiş, bekleyeyim» sanıyordu; oysa motor kapalı
                    // olduğu sürece o rapor HİÇ gelmeyecek. Motor durumu, rapor
                    // yokluğunun AÇIKLAMASIDIR; önce o sorulur.
                    if (s.aktif === false) return { v: 'motor kapalı · hüküm yok', rozet: R.not3 };
                    if (!raporVar) return { v: 'rapor yok', rozet: R.not3 };
                    if (r.alarm && r.alarm !== 'normal') return { v: 'alarm', rozet: R.kirmizi };
                    if (bulgu > 0) return { v: 'izlemede', rozet: R.amber };
                    // Koşu ESKİYSE «temiz» demek, dünkü fotoğrafa bugün demektir.
                    const kosu = String(s.son_calisma || r.son_calisma || '').slice(0, 10);
                    const gunFark = /^\d{4}-\d{2}-\d{2}$/.test(kosu)
                      ? Math.round((Date.parse(`${bugunISO()}T00:00:00Z`) - Date.parse(`${kosu}T00:00:00Z`)) / 86400000)
                      : null;
                    if (gunFark == null) return { v: 'koşu tarihi yok', rozet: R.not3 };
                    if (gunFark > 1) return { v: `koşu ${gunFark} gün eski`, rozet: R.amber };
                    return { v: 'temiz', rozet: R.yesil };
                  })(),
                ],
              };
            })}
            // 🔴 ÖLÜ KAPI (2026-08-27): tablo notu «satıra tıkla → bugünkü rapor»
            // diyordu ama köprü `denetim:motorlar`a, yani BU EKRANIN KENDİSİNE
            // gidiyordu — tıklama hiçbir şey yapmıyordu. Söz verilen ama
            // açılmayan kapı, kapısı olmayandan daha kötüdür: sahip bir kez
            // dener, çalışmadığını görür, bir daha hiçbir satıra tıklamaz.
            onSatir={() => onKopru?.('__modul:denetim:anomali')}   // tema.js:188 doğrulandı
          />
        )}
      </>
    );
  }

  // ── OLAY YELPAZESİ BİRLEŞTİ (2026-07-30) ──────────────────────────────────
  // Tasarımın "tek varlık → tek ekran" kuralı gereği ayrı görünüm kaldırıldı;
  // içeriği Bugünkü Bulgular ekranının HAM GÖZLEM katmanına taşındı. Ham veri
  // silinmedi, yalnızca çıkarımla AYNI ekranda ama AYRI katmanda duruyor.
  // Eski '#…:olaylar' adresi gelirse aşağıdaki yönlendirme çalışır.
  if (gorunum === 'olaylar') { onGorunum?.('anomali'); return null; }

  // ════════════════════════ GÖRÜNÜM: DUYU MUTABAKATI ════════════════════════
  if (gorunum === 'mutabakat') {
    if (mutHata) return <HataBandi mesaj={mutHata} onTekrar={mutYukle} />;
    if (!mutabakat) return <Yukleniyor />;
    // ⚠️ (2026-08-27, Codex) NULL ile BOŞ AYNI SAYILIYORDU: dizi gelmezse
    // sessizce `[]` oluyor, sonra ekran «iki yön de mutabık» ve «temiz»
    // yazıyordu. Cevap gelmedi ile uyum var, aynı şey değildir.
    const yonOkunamadi = !Array.isArray(mutabakat.dusus_var_odeme_kaydi_yok)
      || !Array.isArray(mutabakat.odeme_var_dusus_gorulmedi);
    const dusumsuz = Array.isArray(mutabakat.dusus_var_odeme_kaydi_yok) ? mutabakat.dusus_var_odeme_kaydi_yok : [];
    const kayitsiz = Array.isArray(mutabakat.odeme_var_dusus_gorulmedi) ? mutabakat.odeme_var_dusus_gorulmedi : [];
    const eslesen = sayi(mutabakat.eslesen) || (Array.isArray(mutabakat.eslesen) ? mutabakat.eslesen.length : 0);
    const acikFark = dusumsuz.length + kayitsiz.length;
    // 🐞 ŞEKİL TUZAĞI (düzeltildi): tek bir satır çevirici iki dala da
    // uygulanıyordu ve `aciklama/kurum/tedarikci/kaynak/tarih/tutar` arıyordu.
    // İki dalın şekli FARKLI (duyu_gorunumler:624):
    //   düşüş var  → {tedarikci_ad, pencere_bas, pencere_bit, dusus_tutar}
    //   kayıt var  → {tedarikci_ad, tutar, tarih, kaynak, kayit_guveni}
    // Eskiden "düşüş var" tarafı tarihsiz/tutarsız "kayıt" diye görünüyordu;
    // "kayıt var" tarafında ise ad yerine ÖDEME KANALI (kart/nakit) yazıyordu.
    const satirDusus = (r) => ({
      ad: kisalt(r.tedarikci_ad || 'tedarikçi', 44),
      detay: `${tarihKisa(r.pencere_bas)} – ${tarihKisa(r.pencere_bit)} · kasada iz var`,
      tutar: r.dusus_tutar != null ? fmt(sayi(r.dusus_tutar)) : '',
    });
    const satirKayit = (r) => ({
      ad: kisalt(r.tedarikci_ad || 'tedarikçi', 44),
      // kayit_guveni < 1 → fuzzy eşleşmiş ADAY; kesin değil, ekranda söylenir
      detay: `${tarihKisa(r.tarih)} · ${r.kaynak || 'kayıt'}`
        // 🔴 (2026-08-27, Codex) FALSY-SIFIR: `sayi(x) && x < 1` deseni,
        // güven 0 iken (EN ZAYIF aday) etiketi hiç basmıyordu — en şüpheli
        // eşleşme, kesinmiş gibi okunuyordu. Güven alanı YOKSA etiket yok;
        // VARSA ve 1'in altındaysa aday denir. 0 da bir güven değeridir.
        + (r.kayit_guveni != null && sayi(r.kayit_guveni) < 1 ? ' · aday eşleşme' : ''),
      tutar: r.tutar != null ? fmt(sayi(r.tutar)) : '',
    });
    return (
      <>
        <KpiSeridi kpiler={[
          // `kesit` NESNE: {bas, gun} — sayi(obje)=0 olduğu için hep "60 gün"
          // yazıyordu; sunucu farklı pencere kullansa ekran yanlış söylerdi.
          { etiket: 'Eşleşen', deger: String(eslesen), alt: `son ${sayi(mutabakat.kesit?.gun) || 60} gün`, renk: R.yesil },
          { etiket: 'Açık fark', deger: String(acikFark), alt: 'iki yönlü uyumsuzluk', renk: acikFark > 0 ? R.amber : R.yesil },
          // 🐞 DİL DÜZELTMESİ (2026-08-03): eski alt yazılar "kasadan çıktı /
          // kasada iz yok" diyordu — bu uç KASA mutabakatı DEĞİL; sol taraf
          // TEDARİKÇİNİN fatura-üstü bakiye zinciri, sağ taraf bizim ödeme
          // olaylarımız. "Kasada iz yok" okuyan sahip kasa açığı sanıyordu;
          // gerçek anlam "tedarikçinin sonraki faturasında düşüş görünmüyor
          // (zincir eksik olabilir — bilgi)".
          { etiket: 'Düşüş var · kayıt yok', deger: String(dusumsuz.length), alt: 'tedarikçi bakiyesi erimiş, bizde ödeme kaydı yok', renk: dusumsuz.length > 0 ? R.kirmizi : R.krem },
          { etiket: 'Kayıt var · düşüş yok', deger: String(kayitsiz.length), alt: 'ödememiz var, tedarikçi zincirinde erime görünmüyor (bilgi)', renk: kayitsiz.length > 0 ? R.amber : R.krem },
        ]} />
        <OneriSeridi metin="Bu ekran tedarikçi fatura-zinciri ↔ ödeme olayları ADAY eşleşmesidir (kasa mutabakatı değil). Bakiye düşüşü muhasebe sinyalidir — iade/iskonto da düşürür; hüküm yok." />
        {yonOkunamadi ? (
          <BosDurum
            baslik="Mutabakat okunamadı"
            aciklama="İki yönden en az biri liste döndürmedi — bu ekran «mutabık» demiyor, «karşılaştıramadım» diyor. Yenileyin."
          />
        ) : acikFark === 0 ? (
          <BosDurum metin="İki yön de mutabık — ödeme kayıtları ile kasa düşüşleri örtüşüyor." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginBottom: 16 }}>
            {[{ ad: 'Düşüş var · ödeme kaydı yok', rows: dusumsuz, renk: R.kirmizi, cevir: satirDusus },
              { ad: 'Ödeme kaydı var · düşüş görülmedi', rows: kayitsiz, renk: R.amber, cevir: satirKayit }].map((grup) => (
              <div key={grup.ad} style={{ ...kartYuzey, padding: '16px 18px', border: grup.rows.length ? `1px solid ${grup.renk}44` : kartYuzey.border }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
                }}>
                  <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>{grup.ad}</span>
                  <span style={rozetHap(grup.rows.length ? grup.renk : R.yesil)}>{grup.rows.length}</span>
                </div>
                {grup.rows.length === 0 ? (
                  <div style={{ fontSize: 12, color: R.not3, padding: '8px 0' }}>temiz</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {grup.rows.slice(0, 8).map((r, i) => {
                      const s = grup.cevir(r);
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{s.ad}</div>
                            <div style={{ fontSize: 11, color: R.not2 }}>{s.detay}</div>
                          </div>
                          <span style={{ fontFamily: F.mono, fontWeight: 700, whiteSpace: 'nowrap' }}>{s.tutar}</span>
                        </div>
                      );
                    })}
                    {grup.rows.length > 8 && (
                      <div style={{ fontSize: 11, color: R.not3 }}>+{grup.rows.length - 8} kayıt daha…</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {/* ── DUYU KESİTİ — dört ham gözlem tek yerde ──
            Hepsi Sv0: ALARM DEĞİL, ham veri. Her birinin sunucu notu "hüküm
            yok" diyor. Ayrı ekran açmak yerine tek bölüm — dördü de aynı işi
            yapıyor: bakılacak yeri işaret etmek. */}
        {duyuKesit && (() => {
          const uh = duyuKesit.uyanis;
          const mi = duyuKesit.mudahale;
          const kd = duyuKesit.disiplin;
          const fp = duyuKesit.farkProfil;
          if (!uh && !mi && !kd && !fp) return null;
          const kriterler = Array.isArray(uh?.kriterler) ? uh.kriterler : [];
          const gecen = kriterler.filter((k) => k.gecti).length;
          const miTurler = Array.isArray(mi?.islem_turleri) ? mi.islem_turleri : [];
          return (
            <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>Duyu kesiti · ham gözlem</span>
                <span style={{ fontSize: 11.5, color: R.not2 }}>Sv0 — alarm değil; bakılacak yeri işaret eder</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 10 }}>
                {/* Motor uyanış termometresi */}
                {uh && (
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>MOTOR UYANIŞI</div>
                    <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, marginTop: 4, color: gecen === kriterler.length && kriterler.length ? R.yesil : R.amber }}>
                      {uh.durum || `${gecen}/${kriterler.length}`}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 3, lineHeight: 1.45 }}>
                      {uh.motor || 'kriterler geçene kadar uyur'}
                    </div>
                    {kriterler.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 7 }}>
                        {kriterler.slice(0, 6).map((k, i) => (
                          <span key={i} title={`${k.kriter}: ${k.durum} (hedef ${k.hedef})`} style={{
                            width: 9, height: 9, borderRadius: 99,
                            background: k.gecti ? R.yesil : R.cizgi3,
                            border: k.gecti ? 'none' : `1px solid ${R.not3}`,
                          }} />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Müdahale izi — insider kör noktası */}
                {mi && (
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>MÜDAHALE İZİ · 30 GÜN</div>
                    <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, marginTop: 4, color: sayi(mi.toplam) > 0 ? R.amber : R.krem }}>
                      {sayi(mi.toplam)}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 3, lineHeight: 1.45 }}>
                      geçmişe dokunan işlem · <b>sahip dâhil</b>
                    </div>
                    {miTurler.length > 0 && (
                      <div style={{ fontSize: 10.5, color: R.not, marginTop: 5, fontFamily: F.mono }}>
                        {miTurler.slice(0, 3).map((t) => `${t.islem} ${sayi(t.adet)}`).join(' · ')}
                      </div>
                    )}
                  </div>
                )}

                {/* Kayıt disiplini */}
                {kd && (
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>KAYIT DİSİPLİNİ · 14 GÜN</div>
                    <div style={{ fontSize: 11.5, color: R.metin2, marginTop: 5, lineHeight: 1.6 }}>
                      {kd.geriye_tarihli_bugun != null && (
                        <div>Bugün geçmiş tarihli yazılan: <b style={{ fontFamily: F.mono }}>{sayi(kd.geriye_tarihli_bugun?.adet ?? kd.geriye_tarihli_bugun)}</b></div>
                      )}
                      {kd.kapanis_sonrasi_dun != null && (
                        <div>Dün kapanış sonrası kayıt: <b style={{ fontFamily: F.mono }}>{sayi(kd.kapanis_sonrasi_dun?.adet ?? kd.kapanis_sonrasi_dun)}</b></div>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: R.not3, marginTop: 5 }}>
                      açıklama yazmak · geç girmek meşru olabilir — hüküm yok
                    </div>
                  </div>
                )}

                {/* Şube kasa farkı profili — İSİMSİZ */}
                {Array.isArray(fp?.subeler) && fp.subeler.length > 0 && (
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>KASA FARKI PROFİLİ · 30 GÜN</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5 }}>
                      {fp.subeler.slice(0, 4).map((s, i) => (
                        <div key={i} style={{ fontSize: 11, color: R.metin2, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span>{s.sube_adi || '—'}</span>
                          <span style={{ fontFamily: F.mono, color: R.not }}>
                            {sayi(s.adet ?? s.olay_sayisi)} olay
                          </span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, color: R.not3, marginTop: 5 }}>isimsiz · yorumsuz</div>
                  </div>
                )}

                {/* Satış bütünlüğü — zımni fiyat (ciro/adet) menüye kıyas */}
                {duyuKesit.satis && (Array.isArray(duyuKesit.satis.zimni_fiyat) || duyuKesit.satis.iade_fire) && (
                  <div style={{ padding: '11px 14px', borderRadius: 11, background: R.girinti }}>
                    <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.5px' }}>SATIŞ BÜTÜNLÜĞÜ</div>
                    {/* 🔴 (2026-08-27, Codex) KART iade_fire VARSA da açılıyor ama
                        sayı YALNIZ `zimni_fiyat`ı sayıyordu: iade/fire sinyali
                        dolu, zımni fiyat boşsa kart koca bir «0» gösteriyordu —
                        sinyal var ama ekranda yokmuş gibi. İki sinyal AYRI
                        sayılır ve hangisinin dolu olduğu yazılır. */}
                    {(() => {
                      const zf = Array.isArray(duyuKesit.satis.zimni_fiyat) ? duyuKesit.satis.zimni_fiyat.length : null;
                      const ifH = duyuKesit.satis.iade_fire;
                      const ifN = Array.isArray(ifH) ? ifH.length : (ifH != null ? sayi(ifH) : null);
                      const varMi = (zf || 0) > 0 || (ifN || 0) > 0;
                      return (
                        <>
                          <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, marginTop: 4, color: varMi ? R.amber : R.krem }}>
                            {zf == null && ifN == null ? '—' : `${zf ?? 0}${ifN != null ? ` + ${ifN}` : ''}`}
                          </div>
                          <div style={{ fontSize: 10.5, color: R.not2, marginTop: 3, lineHeight: 1.45 }}>
                            {zf == null && ifN == null
                              ? 'satış bütünlüğü okunamadı — «sapma yok» demiyoruz'
                              : [
                                zf != null ? `${zf} üründe zımni fiyat (ciro/adet) menüden sapıyor` : null,
                                ifN != null ? `${ifN} iade/fire kaydı` : null,
                              ].filter(Boolean).join(' · ')}
                          </div>
                        </>
                      );
                    })()}
                    <div style={{ fontSize: 10, color: R.not3, marginTop: 5 }}>
                      kampanya · ikram · yeni fiyat aynı izi bırakır — aday
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* ── TÜKETİM DÖRTGENİ — dört köşe yan yana ──
            Ödeme mutabakatı İKİ köşeyi karşılaştırır (kasa ↔ ödeme kaydı).
            Bu blok DÖRT köşeyi koyar: giren · kullanım · satış · sayım.
            ⚠️ Sunucunun kendi kuralı: "—" = o köşede VERİ YOK (sıfır DEĞİL).
            Skor/yorum ÜRETİLMEZ — köşeler yan yana, hüküm insanın. */}
        {dortSubeler.length > 0 && (
          <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 11 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>
                Tüketim dörtgeni · şube
              </span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {dortSubeler.slice(0, 6).map((s) => {
                  const aktif = String(dortSube) === String(s.id);
                  return (
                    <div key={s.id} onClick={() => setDortSube(String(s.id))} style={{
                      padding: '5px 12px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                      background: aktif ? `${R.bakir}22` : R.girinti,
                      color: aktif ? R.bakir : R.not,
                      border: `1px solid ${aktif ? `${R.bakir}55` : R.cizgi3}`,
                    }}>{s.ad || s.id}</div>
                  );
                })}
              </div>
              {dortgen?.kesit && (
                <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto', fontFamily: F.mono }}>
                  {dortgen.kesit.bas} → {dortgen.kesit.bit}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: R.not2, marginBottom: 10, lineHeight: 1.55 }}>
              Dört kaynak yan yana: <b>giren</b> (teslim) · <b>kullanım</b> (ürün-aç) ·
              {' '}<b>satış</b> (Evo) · <b>sayım</b> (onaylı düzeltme).
              {' '}<b style={{ color: R.amber }}>“—” o köşede veri YOK demektir, sıfır değil.</b>
              {' '}Uyumsuzluk skoru üretilmez — değerlendirme insanındır.
            </div>
            {!dortgen ? (
              <div style={{ fontSize: 12, color: R.not3, padding: '10px 0' }}>Dörtgen verisi yükleniyor…</div>
            ) : !(dortgen.kalemler || []).length ? (
              <BosDurum metin="Bu şube ve dönem için dörtgen verisi yok." />
            ) : (
              <Tablo
                baslik={`${dortgen.sube_ad || '—'} · ${sayi(dortgen.kalem_sayisi)} kalem`}
                not="en çok köşesi dolu kalemler üstte (karşılaştırılabilir olanlar)"
                kolonlar={[
                  { ad: 'Kalem' }, { ad: 'Giren', sag: 1 }, { ad: 'Kullanım', sag: 1 },
                  { ad: 'Satış', sag: 1 }, { ad: 'Sayım Δ', sag: 1 },
                ]}
                satirlar={(dortgen.kalemler || []).slice(0, 25).map((k, i) => {
                  // null → "—" (veri yok). 0 gerçek sıfırdır, ayrı gösterilir.
                  const h = (v, renk) => (v == null
                    ? { v: '—', mono: true, sag: true, renk: R.not3, sira: -1 }
                    : { v: String(sayi(v)), mono: true, sag: true, renk: renk || R.krem, sira: sayi(v) });
                  return {
                    id: k.kalem_kodu || `dg-${i}`,
                    hucreler: [
                      { v: k.kalem_adi || k.kalem_kodu || '—', kalin: true },
                      h(k.giren, R.yesil),
                      h(k.kullanim),
                      h(k.satis, R.mavi),
                      k.sayim_delta == null
                        ? { v: '—', mono: true, sag: true, renk: R.not3, sira: -1 }
                        : {
                          v: `${sayi(k.sayim_delta) > 0 ? '+' : ''}${sayi(k.sayim_delta)}`,
                          mono: true, sag: true, kalin: true, sira: sayi(k.sayim_delta),
                          renk: sayi(k.sayim_delta) < 0 ? R.kirmizi : R.amber,
                        },
                    ],
                  };
                })}
              />
            )}
            {dortgen?.rozetler && Object.keys(dortgen.rozetler).length > 0 && (
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 4 }}>
                {Object.entries(dortgen.rozetler).map(([kose, r]) => (
                  <span key={kose} title={r?.kapsam || r?.hata || ''} style={{
                    padding: '4px 10px', borderRadius: 99, fontSize: 10.5,
                    background: r?.hata ? `${R.kirmizi}18` : R.girinti,
                    color: r?.hata ? R.kirmizi : R.not2,
                    border: `1px solid ${r?.hata ? `${R.kirmizi}44` : R.cizgi3}`,
                  }}>
                    {kose}: {r?.hata ? 'veri alınamadı' : (r?.kesit || r?.kaynak || '—')}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <KopruButon ad="🧠 Beyne sor (Duyu Ağı)" onTikla={() => onGorunum?.('duyu')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: BAĞ DEFTERİ ════════════════════════════
  if (gorunum === 'bag') {
    if (bagHata) return <HataBandi mesaj={bagHata} onTekrar={bagYukle} />;
    if (beyin == null || dilekler == null) return <Yukleniyor />;
    const sentezler = beyin.filter((k) => k.tip === 'gece_sentez' || k.cevap || k.metin);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Son sentez kaydı', deger: String(sentezler.length), alt: 'gece anlatıları (beyin)' },
          { etiket: 'Açık bağ dileği', deger: String(dilekler.length), alt: 'onay bekleyen yeni bağ', renk: dilekler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Kurulum ilkesi', deger: 'insan onayı', alt: 'dilek → onay → yeni üretici' },
          { etiket: 'Besleme', deger: 'gece motoru', alt: 'bağlar her gece yeniden kurulur' },
        ]} />
        <OneriSeridi metin="Bağ cümlelerini KOD kurar (gece), beyin yalnız AKTARIR — dilek defteri sistemin kendini eğitme kanalıdır." />

        {dilekler.length > 0 && (
          <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14, border: `1px solid ${R.amber}44` }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>Bağ dilek defteri · onay bekliyor</span>
              <span style={rozetHap(R.amber)}>{dilekler.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {dilekler.slice(0, 6).map((d, i) => (
                <div key={d.ref || i} style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  <span style={{ color: R.amber, fontWeight: 700 }}>DİLEK · </span>
                  <span style={{ color: R.krem }}>{kisalt(d?.payload_json?.dilek || d?.dilek || '—', 160)}</span>
                  <span style={{ color: R.not3, fontSize: 11 }}> · ref {String(d.ref || '').slice(0, 8)}</span>
                </div>
              ))}
              {/* ⚠️ (2026-08-27, Codex) SESSİZ ELEME: liste 6'da kesiliyordu ama
                  üstteki sayaç toplamı yazıyordu — sahip 6 görüp «hepsi bu»
                  sanabilirdi. Gece sentezlerinde bu düzeltilmiş, dilek tarafı
                  atlanmıştı. */}
              {dilekler.length > 6 && (
                <div style={{ fontSize: 11.5, color: R.not2, padding: '4px 2px' }}>
                  … ve <b style={{ color: R.not }}>{dilekler.length - 6} dilek daha</b> onay bekliyor —
                  liste en yenisinden 6'sını gösterir.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SON BAĞLAR + ÖĞRETMEN İŞARETİ (yazma-ucu turu, 2026-08-03) ──
            Gece motoru bağ örer; insan ✓/✗ ile Y4 kural ağırlıklarını EĞİTİR.
            T2 "cocuk_gelmedi" satırı sarı: beklenti boşa çıktı, yokluk sinyaldir. */}
        {Array.isArray(bagOlaylar) && bagOlaylar.length > 0 && (
          <div style={{ ...kartYuzey, padding: '16px 18px', marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 10,
            }}>
              <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                Son bağlar · öğretmen defteri
              </span>
              <span style={{ fontSize: 11, color: R.not2 }}>
                ✓/✗ işaretin kural ağırlıklarını eğitir — bağı kapatmaz
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {bagOlaylar.slice(0, 12).map((b, i) => {
                const gelmedi = String(b.olay_tipi || '').includes('cocuk_gelmedi');
                const kuralId = b?.payload_json?.kural_id || b.duyu || '—';
                return (
                  <div key={b.event_id || `bg-${i}`} style={{
                    display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5,
                    padding: '8px 12px', borderRadius: 9, background: R.girinti,
                    borderLeft: `3px solid ${gelmedi ? R.amber : R.cizgi3}`,
                  }}>
                    <span style={{ flexShrink: 0, fontFamily: F.mono, color: R.not2 }}>
                      {String(b.occurred_at || '').slice(5, 10) || '—'}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, color: gelmedi ? R.amber : R.metin2 }}>
                      {gelmedi ? '⚠️ ' : '🔗 '}<b>{kuralId}</b>
                      <span style={{ color: R.not2 }}> · {kisalt(b.signal_name || b.olay_tipi || '—', 70)}</span>
                    </span>
                    {b.insan_karari ? (
                      <span style={{
                        flexShrink: 0, fontSize: 10.5, fontWeight: 700,
                        color: b.insan_karari === 'dogru_bag' ? R.yesil : R.kirmizi,
                      }}>{b.insan_karari === 'dogru_bag' ? '✓ doğru' : '✗ yanlış'}</span>
                    ) : (
                      <span style={{ flexShrink: 0, display: 'inline-flex', gap: 5 }}>
                        <button
                          title="doğru bağ" disabled={!!etiketMesgul}
                          onClick={() => bagEtiketle(b, 'dogru_bag')}
                          style={{
                            padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                            border: `1px solid ${R.yesil}55`, background: 'transparent',
                            color: R.yesil, fontSize: 11, fontWeight: 700,
                            opacity: etiketMesgul ? 0.5 : 1,
                          }}
                        >✓</button>
                        <button
                          title="yanlış bağ" disabled={!!etiketMesgul}
                          onClick={() => bagEtiketle(b, 'yanlis_bag')}
                          style={{
                            padding: '3px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                            border: `1px solid ${R.kirmizi}55`, background: 'transparent',
                            color: R.kirmizi, fontSize: 11, fontWeight: 700,
                            opacity: etiketMesgul ? 0.5 : 1,
                          }}
                        >✗</button>
                      </span>
                    )}
                  </div>
                );
              })}
              {/* ⚠️ (2026-08-27, Codex) SESSİZ ELEME: bağ olayları 12'de
                  kesiliyordu, taşma notu yoktu. Öğretmen defterinde eksik
                  görülen bağ, hiç eğitilmeyen bağ demektir. */}
              {bagOlaylar.length > 12 && (
                <div style={{ fontSize: 11.5, color: R.not2, padding: '6px 2px 0' }}>
                  … ve <b style={{ color: R.not }}>{bagOlaylar.length - 12} bağ olayı daha</b> —
                  liste en yenisinden 12'sini gösterir.
                </div>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: R.not3, marginTop: 9, fontStyle: 'italic' }}>
              T1 bağı sinyali KAPATMAZ; T2 "çocuk gelmedi" beklenti boşluğudur. Karar sonradan değiştirilebilir (upsert).
            </div>
          </div>
        )}

        {sentezler.length === 0 ? (
          <BosDurum metin="Henüz gece sentezi kaydı yok — beyin her gece gözlem anlatısı üretir." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            {/* ⚠️ SESSİZ ELEME (2026-08-27): liste 6'da kesiliyordu ve KPI
                toplam sayıyı yazıyordu — 10 sentez varken sahip 6 görüp
                «hepsi bu» sanabilirdi. Taşan aşağıda söyleniyor. */}
            {sentezler.slice(0, 6).map((k, i) => (
              <div key={i} style={{ ...kartYuzey, padding: '15px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
                  <span style={rozetHap(R.bakir)}>{k.tip === 'gece_sentez' ? 'gece sentezi' : (k.tip || 'kayıt')}</span>
                  {k.tarih || k.olusturma ? (
                    <span style={{ fontSize: 11, color: R.not2 }}>{String(k.tarih || k.olusturma).slice(0, 16)}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 12.5, color: R.metin2, lineHeight: 1.6 }}>
                  {kisalt(k.cevap || k.metin || k.soru, 420)}
                </div>
              </div>
            ))}
            {sentezler.length > 6 && (
              <div style={{ fontSize: 11.5, color: R.not2, padding: '2px 4px' }}>
                … ve <b style={{ color: R.not }}>{sentezler.length - 6} sentez daha</b> —
                liste en yeni 6'sını gösterir; sayacın tamamı üstteki KPI'da.
              </div>
            )}
          </div>
        )}
        <KopruButon ad="🧠 Bağları beyne sor (Duyu Ağı)" onTikla={() => onGorunum?.('duyu')} />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: DUYU PANELİ ════════════════════════════
  if (gorunum === 'duyu') {
    if (duyuHata) return <HataBandi mesaj={duyuHata} onTekrar={duyuYukle} />;
    if (!karne || sinaps == null) return <Yukleniyor />;
    const kurallar = Array.isArray(karne.karne) ? karne.karne : [];
    // ⚠️ (2026-08-27, Codex) NULL «0 OLAY»A DÖNÜYORDU: alan gelmezse sayı 0
    // oluyor, kapı da açılmıyordu — sahibin «hangi birliktelikler oldu?»
    // sorusuna hiçbir yol kalmıyordu. «Olay yok» ile «okunamadı» ayrılır.
    const sinapsDizi = Array.isArray(sinaps?.sinaps_olaylari) ? sinaps.sinaps_olaylari : null;
    const sinapsOkunamadi = sinapsDizi == null && sinaps?.sinaps_olaylari == null;
    const sinapsOlay = sinapsDizi ? sinapsDizi.length : sayi(sinaps?.sinaps_olaylari);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen kural', deger: String(kurallar.length), alt: 'öğrenme defteri karnesi' },
          { etiket: 'Öğrenme', deger: karne.ogrenme_aktif ? 'aktif' : 'kapalı', alt: `n eşiği ${sayi(karne.n_esigi) || '—'}`, renk: karne.ogrenme_aktif ? R.yesil : R.amber },
          // 🚪 96 olay ELDEYDİ (`sinaps.sinaps_olaylari` tam dizi) ama yalnız
          // sayılıp atılıyordu — sahip «hangi 96?» diye soramıyordu.
          {
            etiket: 'Sinaps olayı',
            deger: sinapsOkunamadi ? '—' : String(sinapsOlay),
            renk: sinapsOkunamadi ? R.amber : undefined,
            alt: sinapsOkunamadi
              ? '⚠ okunamadı — «olay yok» demiyoruz'
              : `son ${sayi(sinaps?.kesit) || 14} gün · duyular arası${sinapsDizi?.length ? ' · dökümü aç' : ''}`,
            onTikla: (sinapsDizi && sinapsDizi.length)
              ? () => onCekmece?.({
                tip: 'SİNAPS',
                baslik: 'Duyular arası birliktelikler',
                alt: `${sinapsDizi.length} olay · son ${sayi(sinaps?.kesit) || 14} gün`,
                kpi: [
                  { etiket: 'Olay', deger: String(sinapsDizi.length) },
                  { etiket: 'Duyu', deger: String(new Set(sinapsDizi.map((o) => o.duyu)).size), alt: 'ayrı kaynak' },
                ],
                listeBaslik: 'Olaylar · yeniden eskiye',
                satirlar: sinapsDizi.slice(0, 60).map((o) => ({
                  ad: String(o.signal_name || o.olay_tipi || '—').slice(0, 70),
                  detay: [o.duyu, o.entity_id, String(o.occurred_at || '').slice(0, 10)].filter(Boolean).join(' · '),
                  tutar: '',
                })),
                // ⚠️ SESSİZ ELEME YASAK: 60'tan fazlası varsa söylenir.
                not: (sinapsDizi.length > 60
                  ? `Liste en yeni 60 olayı gösterir (${sinapsDizi.length} olaydan). `
                  : '')
                  + (sinaps.not || 'Sinapslar duyuları birbirine bağlar: birliktelik kaydeder, hüküm vermez, alarm kapatmaz.'),
              })
              : undefined,
          },
          { etiket: 'Omurga', deger: 'tek gözlem', alt: 'çakışma hata değil ürün' },
        ]} />
        {/* ==================================================================
            OGRENME HALKASI - duyular ile zekayi BIRLESTIREN tek goruntu
            ==================================================================
            Sistemin halkalari ayri ayri calisiyordu ama hicbir ekran zinciri
            BUTUN olarak gostermiyordu; halka gorunmeyince NEREDE koptugu da
            gorunmuyordu. Canli olcum (27 Agu):
              duyu 2.965 olay OK -> sinaps 287 bag OK -> ETIKET 163 var ama
              kurala ULASAN 1 KOPUK -> 10 kuralin 10'u %0 KOPUK
            Sebep tek satirlik: kural karnesi YALNIZ kaynak='bag_karari'
            etiketini sayiyor; sahibin verdigi 96 onay + 61 red BASKA kanalda
            duruyor. Ogretmen 157 kez konusmus, ogrenci birini duyuyor.
            UYARI: BU BIR OLCUM KATMANIDIR - hicbir seyi otomatik etiketlemez,
            hicbir agirligi degistirmez. Ne oldugunu SOYLER; karari sahip verir.
            ================================================================== */}
        {(() => {
          const ozetOK = ozet && ozet !== '__HATA__';
          const ekOK = etiketKirilim && etiketKirilim !== '__HATA__';
          const kur = Array.isArray(karne?.karne) ? karne.karne : [];
          const esik = sayi(karne?.n_esigi) || 30;
          const bagT = kur.reduce((t, k) => t + sayi(k.bag_n), 0);
          const olgun = kur.filter((k) => sayi(k.etiketli_n) >= esik).length;
          const uyuyan = kur.filter((k) => sayi(k.bag_n) === 0).length;
          const bagKarari = ekOK ? sayi(etiketKirilim.kaynaklar?.bag_karari) : null;
          const etiketToplam = ekOK ? etiketKirilim.toplam
            : (ozetOK ? sayi(ozet.etiket_sayisi) : null);
          const adimlar = [
            {
              ad: 'Duyu uretimi',
              baslik: 'DUYU ÜRETİMİ',
              deger: ozetOK ? String(sayi(ozet.toplam_olay)) : '—',
              alt: ozetOK
                ? `${Array.isArray(ozet.son_gun_tipleri) ? ozet.son_gun_tipleri.length : 0} olay tipi`
                : 'okunamadı',
              kopuk: ozetOK ? sayi(ozet.toplam_olay) === 0 : false,
            },
            {
              ad: 'Bag kurma',
              baslik: 'BAĞ KURMA',
              deger: String(bagT),
              alt: uyuyan > 0
                ? `${uyuyan}/${kur.length} kural hiç tetiklenmemiş`
                : 'tüm kurallar tetikleniyor',
              kopuk: bagT === 0 || (kur.length > 0 && uyuyan === kur.length),
            },
            {
              ad: 'Etiket',
              baslik: 'ETİKET (ÖĞRETMEN)',
              deger: etiketToplam == null ? '—' : String(etiketToplam),
              // ⚠️ "kurala ulaşan" demek yanlıştı (bkz. aşağıdaki not): bu iki
              // sayı aynı havuzun parçası değil, AYRI SORULARIN cevapları.
              alt: bagKarari == null ? 'kaynak kırılımı okunamadı'
                : `bağ hükmü: ${bagKarari} · gerisi başka soruya ait`,
              kopuk: bagKarari != null && etiketToplam != null && etiketToplam > 0 && bagKarari <= 1,
            },
            {
              ad: 'Kural ogrenmesi',
              baslik: 'KURAL ÖĞRENMESİ',
              deger: `${olgun} / ${kur.length}`,
              alt: `olgun kural · eşik ${esik} etiket`,
              kopuk: kur.length > 0 && olgun === 0,
            },
          ];
          const kopukSayi = adimlar.filter((a2) => a2.kopuk === true).length;
          return (
            <div style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 11 }}>
                <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>🧠 Öğrenme halkası</span>
                <span style={{ fontSize: 11, color: R.not2 }}>duyu → bağ → etiket → kural · zincirin bütünü</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: kopukSayi ? R.amber : R.yesil, fontWeight: 700 }}>
                  {kopukSayi ? `${kopukSayi} halka kopuk` : 'zincir tam'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
                {adimlar.map((a2, i2) => (
                  <React.Fragment key={a2.ad}>
                    {i2 > 0 && <div style={{ display: 'flex', alignItems: 'center', color: R.not3, fontSize: 15 }}>→</div>}
                    <div style={{
                      flex: '1 1 150px', minWidth: 138, padding: '10px 12px', borderRadius: 10,
                      background: R.girinti,
                      border: `1px solid ${a2.kopuk === true ? `${R.amber}66` : R.cizgi3}`,
                    }}>
                      <div style={{ fontSize: 10.5, color: R.not2, fontWeight: 700, letterSpacing: '.4px' }}>{a2.baslik}</div>
                      <div style={{
                        fontFamily: F.mono, fontSize: 18, fontWeight: 700, marginTop: 3,
                        color: a2.kopuk === true ? R.amber : (a2.deger === '—' ? R.not3 : R.krem),
                      }}>{a2.deger}</div>
                      <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2, lineHeight: 1.45 }}>{a2.alt}</div>
                    </div>
                  </React.Fragment>
                ))}
              </div>
              {/* ⚠️ (2026-08-27) BU CÜMLE BİR KEZ YANLIŞ YAZILDI, DÜZELTİLDİ.
                  Önce "öğretmen konuşuyor ama öğrenci duymuyor · bağlantı
                  eksikliği" yazmıştım — yani 163 etiketin kurallara BAĞLANMASI
                  gerektiğini ima ediyordu. Ölçtüm, YANILMIŞIM:
                    onay/red etiketinin iliskili_ref'i  = onay_kuyrugu.id
                    karnenin aradığı                    = duyu_olay.event_id
                  İkisi FARKLI TABLODAN. Eşleşmemesi hata değil, DOĞRU:
                  "bu gider meşru mu?" hükmü, "R4 kuralı bu iki olayı doğru mu
                  bağladı?" sorusunun cevabı DEĞİLDİR. Bağlamak bir kategori
                  hatası olurdu (doktrin 9: kanıt gücü simetrik değildir).
                  GERÇEK durum: kural öğrenicisinin ÖĞRETMENİ YOK. */}
              {bagKarari != null && etiketToplam > 0 && bagKarari <= 1 && bagT > 0 && (
                <div style={{ fontSize: 12, color: R.metin2, marginTop: 11, lineHeight: 1.65 }}>
                  ⚠ <b style={{ color: R.krem }}>Kural öğrenicisinin öğretmeni yok.</b> Defterdeki{' '}
                  <b style={{ color: R.krem }}>{etiketToplam} etiket</b> başka bir soruya ait
                  {ekOK && (
                    <> ({Object.entries(etiketKirilim.kaynaklar)
                      .filter(([k]) => k !== 'bag_karari')
                      .sort((x, y) => y[1] - x[1]).slice(0, 3)
                      .map(([k, n]) => `${n}× ${k}`).join(' · ')})</>
                  )}
                  {' '}— «bu kayıt meşru mu?» hükümleri. Kuralın sorduğu soru başka:
                  «bu iki olayı <i>doğru mu</i> bağladım?». O soruya bugüne dek{' '}
                  <b style={{ color: R.krem }}>{bagKarari}</b> kez cevap verilmiş,
                  oysa <b style={{ color: R.krem }}>{bagT} bağ</b> kurulmuş.
                  {' '}Bu bir bağlantı hatası <b>değil</b>: iki etiket farklı sorulara ait ve
                  birbirinin yerine sayılamaz. Eksik olan, bağları değerlendiren öğretmen —
                  Bağ Defteri’ndeki ✓/✗ işaretleri.
                </div>
              )}
              {uyuyan > 0 && (
                <div style={{ fontSize: 12, color: R.metin2, marginTop: 8, lineHeight: 1.65 }}>
                  💤 <b style={{ color: R.krem }}>{uyuyan} kural hiç tetiklenmemiş</b> (bağ = 0) —
                  bu kurallar için etiket toplamak anlamsız; önce üreten duyunun olay yayması gerekiyor.
                  Etiketlemek, ateşlenmeyen kuralı öğretmez.
                </div>
              )}
              <div style={{ fontSize: 10.5, color: R.not3, marginTop: 9, fontStyle: 'italic' }}>
                Bu panel ÖLÇER, karar vermez: hiçbir etiketi otomatik atmaz, hiçbir kuralın ağırlığını değiştirmez.
              </div>
            </div>
          );
        })()}
        {/* 🔬 CANLI GEZİNTİ (2026-08-27) — TABLO SIFIR AYRIM ÜRETİYORDU.
            Canlıda 10 kuralın 10'u da «veri yetersiz · — · %0 · öğreniyor»
            diyordu: 60 hücre, sıfır bilgi. Tufte'nin veri-mürekkep ölçütünde
            bu tablo tamamen mürekkep; istisna-temelli raporlamada ise okunacak
            hiçbir istisna yok. Sahip 10 satırı tarayıp aynı cümleyi 10 kez
            okuyor ve şu soruyu cevapsız bırakıyor: «ne zaman işe yarayacak?»
            ⚠️ TABLO KALDIRILMADI (ham veri kaybolmaz): üstüne DURUM CÜMLESİ
            eklendi. Cümle tablonun söyleyemediğini söyler — eşiğe ne kadar
            kaldı, hangi kural en ileride. Sessizlik yerine ilerleme. */}
        {kurallar.length > 0 && (() => {
          const esik = sayi(karne.n_esigi) || 30;
          const etiketli = (k) => sayi(k.etiketli_n);
          const olgun = kurallar.filter((k) => etiketli(k) >= esik);
          const enIleri = [...kurallar].sort((a, b) => etiketli(b) - etiketli(a))[0];
          const enIleriN = enIleri ? etiketli(enIleri) : 0;
          if (olgun.length === kurallar.length) return null;   // hepsi olgunsa cümleye gerek yok
          return (
            <div style={{
              ...kartYuzey, padding: '11px 16px', marginBottom: 12,
              borderLeft: `3px solid ${R.not3}`, fontSize: 12.5, color: R.metin2, lineHeight: 1.6,
            }}>
              <b style={{ color: R.krem }}>{kurallar.length - olgun.length} kural henüz öğreniyor</b>
              {olgun.length > 0 && <> · {olgun.length} kural olgunlaştı</>}
              {' '}— karne ancak <b>{esik} etiketli gözlem</b> biriktikten sonra ayrım üretir.
              {enIleri && enIleriN > 0
                ? <> En ileride <b style={{ color: R.krem }}>{enIleri.kural_id}</b> ({enIleriN}/{esik});
                    eşiğe <b>{Math.max(0, esik - enIleriN)}</b> gözlem kaldı.</>
                : <> Henüz hiçbir kurala etiket düşmemiş — <b>işaret defteri boş</b>: motorun
                    isabetini ölçmek için bulgulara ✓/✗ verilmesi gerekiyor.</>}
              {' '}<span style={{ color: R.not3 }}>Aşağıdaki tablo ham hâliyle duruyor — sayı gizlenmiyor, yalnız anlamı yazılıyor.</span>
            </div>
          );
        })()}
        {kurallar.length === 0 ? (
          <BosDurum metin="Kural karnesi boş — öğrenme defteri kurallar biriktikçe dolar." />
        ) : (
          <Tablo
            baslik="Kural karnesi · öğrenme defteri"
            not="kurallar VERİ'dir — davranışları gece motoru ölçer · satıra tıkla → kural tanımı"
            // 🐞 ŞEKİL TUZAĞI (düzeltildi): eski satırlar `k.ad/k.kural/k.durum/
            // k.gozlem/k.not` okuyordu — bunların HİÇBİRİ cevapta yok. Her satır
            // "kural 1, kural 2…" jenerik adıyla, hep yeşil "sağlıklı" rozetiyle
            // ve hep 0 gözlemle görünüyordu. Gerçek şema: duyu_yavru:497
            // {kural_id, tur, bag_n, etiketli_n, dogru_n, yanlis_n,
            //  posterior_ort, wilson_alt, n_esigi_rozet, agirlik_uygulaniyor}
            kolonlar={[
              { ad: 'Kural' }, { ad: 'Tür' }, { ad: 'Olgunluk' },
              { ad: 'Doğru / Yanlış', sag: 1 }, { ad: 'Güven alt sınırı', sag: 1 }, { ad: 'Ağırlık' },
            ]}
            satirlar={kurallar.slice(0, 20).map((k, i) => {
              const rozet = String(k.n_esigi_rozet || '');
              const dogru = sayi(k.dogru_n);
              const yanlis = sayi(k.yanlis_n);
              const etiketli = sayi(k.etiketli_n);
              return {
                id: k.kural_id || `k-${i}`,
                hucreler: [
                  { v: kisalt(k.kural_id || `kural ${i + 1}`, 42), kalin: true },
                  { v: k.tur || '—', renk: R.not },
                  // n_esigi_rozet: veri_yetersiz | zayif | aktif_olabilir
                  /aktif/i.test(rozet)
                    ? { v: 'aktif olabilir', rozet: R.yesil, sira: 2 }
                    : /zayif/i.test(rozet)
                      ? { v: 'zayıf', rozet: R.amber, sira: 1 }
                      : { v: 'veri yetersiz', rozet: R.not3, sira: 0 },
                  {
                    sira: etiketli, sag: true,
                    v: etiketli
                      ? (
                        <span style={{ fontFamily: F.mono, whiteSpace: 'nowrap' }}>
                          <span style={{ color: R.yesil, fontWeight: 700 }}>{dogru}</span>
                          <span style={{ color: R.not3 }}> / </span>
                          <span style={{ color: yanlis ? R.kirmizi : R.not2, fontWeight: 700 }}>{yanlis}</span>
                          <span style={{ color: R.not2, fontSize: 10 }}> · {sayi(k.bag_n)} bağ</span>
                        </span>
                      )
                      : '—',
                  },
                  {
                    v: k.wilson_alt != null ? `%${Math.round(sayi(k.wilson_alt) * 100)}` : '—',
                    mono: true, sag: true, renk: sayi(k.wilson_alt) >= 0.7 ? R.yesil : R.not,
                  },
                  k.agirlik_uygulaniyor
                    ? { v: 'uygulanıyor', rozet: R.mavi, sira: 1 }
                    : { v: 'öğreniyor', renk: R.not3, sira: 0 },
                ],
                _k: k,
              };
            })}
            onSatir={({ _k }) => kuralTanimAc(_k)}
          />
        )}

        {/* ── EVVEL BEYNİ'YLE KONUŞ (yerli — klasik Duyu Paneli'nin çekirdeği) ── */}
        <div style={{ ...kartYuzey, padding: '18px 20px', marginTop: 14, marginBottom: 16, borderLeft: `3px solid ${R.bakir}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 16, fontWeight: 600 }}>🧠 Evvel Beyni'yle Konuş</span>
            <span style={{ fontSize: 11, color: R.not2, flex: 1 }}>sohbet hafızalı — takip sorusu sorabilirsin</span>
            {mesajlar.length > 0 && (
              <button onClick={() => { setMesajlar([]); setOturumId(null); setSohbetHata(''); }} style={{
                padding: '5px 11px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                background: 'transparent', color: R.not, fontSize: 11, fontFamily: 'inherit',
              }}>🆕 Yeni sohbet</button>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: R.not, marginBottom: 12, lineHeight: 1.55 }}>
            "Bugün sorunlar nedir?" diye başla, "peki Köyceğiz'de?" diye devam et — önceki soruları hatırlar.
            Karar vermez, isim vermez; kayıtları anlatır, kayda işaret eder.
          </div>

          {mesajlar.length > 0 && (
            <div style={{ maxHeight: 420, overflowY: 'auto', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
              {mesajlar.map((m, i) => (
                <div key={i} style={{
                  padding: '11px 14px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.62,
                  background: m.rol === 'sen' ? 'rgba(217,154,78,.10)' : R.girinti,
                  border: `1px solid ${m.rol === 'sen' ? `${R.bakir}44` : R.cizgi3}`,
                  color: R.metin2, whiteSpace: 'pre-wrap',
                }}>
                  <div style={{
                    fontSize: 10, letterSpacing: '.7px', textTransform: 'uppercase', fontWeight: 700,
                    color: m.rol === 'sen' ? R.bakir : R.not2, marginBottom: 5,
                  }}>
                    {m.rol === 'sen' ? 'sen' : 'beyin'}
                    {m.etiket ? ` · ${m.etiket}` : ''}
                  </div>
                  {m.metin}
                  {m.dipnot && (
                    <div style={{ fontSize: 11, color: R.not2, marginTop: 7, fontStyle: 'italic' }}>{m.dipnot}</div>
                  )}
                  {!!(m.bloklar || []).length && (
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 7 }}>
                      okuduğu pencereler: {(m.bloklar || []).join(', ')}
                    </div>
                  )}
                  {m.rol === 'beyin' && m.gunlukId && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
                      {[['iyi', '👍 iyi cevap'], ['kotu', '👎 kötü']].map(([karar, ad]) => (
                        <button key={karar} onClick={() => cevapEtiketle(m.gunlukId, karar)} style={{
                          padding: '4px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5,
                          border: `1px solid ${m.puan === karar ? R.bakir : R.cizgi3}`,
                          background: m.puan === karar ? 'rgba(217,154,78,.14)' : 'transparent',
                          color: m.puan === karar ? R.bakir : R.not,
                          fontWeight: m.puan === karar ? 700 : 500,
                        }}>{ad}</button>
                      ))}
                      {m.puan && <span style={{ fontSize: 10.5, color: R.yesil, alignSelf: 'center' }}>✓ üslup rehberine işlendi</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {sohbetHata && (
            <div style={{ fontSize: 12, color: R.kirmizi, marginBottom: 10 }}>{sohbetHata}</div>
          )}

          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            <input
              value={soru}
              onChange={(e) => setSoru(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sor(); }}
              placeholder="örn. bu hafta reçetelere göre fazla giden malzeme var mı?"
              style={{
                flex: 1, minWidth: 240, boxSizing: 'border-box', padding: '10px 14px', borderRadius: 10,
                border: `1px solid ${R.cizgi3}`, background: R.girinti, color: R.krem,
                fontSize: 13, fontFamily: 'inherit', outline: 'none',
              }}
            />
            <button disabled={sohbetMesgul || soru.trim().length < 3} onClick={sor} style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: soru.trim().length < 3 ? R.girinti : 'linear-gradient(150deg, #E0A559, #AF6C29)',
              color: soru.trim().length < 3 ? R.not : '#1C1309', fontSize: 12.5, fontWeight: 700,
              fontFamily: 'inherit', cursor: soru.trim().length < 3 ? 'default' : 'pointer',
            }}>
              {sohbetMesgul ? 'Düşünüyor…' : 'Sor'}
            </button>
            <button onClick={notAc} style={{
              padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
              background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            }}>
              📓 Günlüğe not
            </button>
          </div>
        </div>

        {/* günlük not modalı */}
        {notForm && (
          <div onClick={(e) => { if (e.target === e.currentTarget && !notMesgul) setNotForm(null); }} style={{
            position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(10,6,2,.66)',
            backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}>
            <div style={{ ...kartYuzey, width: 480, maxWidth: '96vw', padding: '24px 26px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
                <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600 }}>📓 İşletme Günlüğü</div>
                <button onClick={() => setNotForm(null)} style={{
                  marginLeft: 'auto', border: 'none', background: 'transparent', color: R.not,
                  fontSize: 16, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: R.not, marginBottom: 14, lineHeight: 1.55 }}>
                Rakamların açıklamadığı şeyi buraya yaz — beyin bunu okur ("o gün su kesintisi vardı" gibi).
              </div>
              <label style={dnEtiket}>Not *</label>
              <input value={notForm.baslik} placeholder="örn. Zafer'de klima arızası, akşam kapandı"
                onChange={(e) => setNotForm((f) => ({ ...f, baslik: e.target.value }))} style={dnAlanStil} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                <div>
                  <label style={dnEtiket}>Tip</label>
                  <select value={notForm.tip} onChange={(e) => setNotForm((f) => ({ ...f, tip: e.target.value }))} style={dnAlanStil}>
                    {[['gozlem', 'Gözlem'], ['olay', 'Olay'], ['aksiyon', 'Aksiyon'], ['not', 'Not']].map(([v, ad]) => <option key={v} value={v}>{ad}</option>)}
                  </select>
                </div>
                <div>
                  <label style={dnEtiket}>Şube (varsa)</label>
                  <select value={notForm.sube_id} onChange={(e) => setNotForm((f) => ({ ...f, sube_id: e.target.value }))} style={dnAlanStil}>
                    <option value="">Genel</option>
                    {notSubeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                <button disabled={notMesgul} onClick={() => setNotForm(null)} style={{
                  padding: '10px 18px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                  background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                }}>İptal</button>
                <button disabled={notMesgul} onClick={notKaydet} style={{
                  padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                  fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                }}>{notMesgul ? 'Yazılıyor…' : 'Günlüğe yaz'}</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: STRATEJİ MOTORU ════════════════════════
  if (gorunum === 'strateji') {
    if (stratejiHata) return <HataBandi mesaj={stratejiHata} onTekrar={stratejiYukle} />;
    if (!strateji) return <Yukleniyor />;
    const oneriler = Array.isArray(strateji.oneriler) ? strateji.oneriler : [];
    // ── N3 (2026-08-16): KRİTİK NAKİT BİRLEŞTİRME ────────────────────────────
    // Motor, serbest nakde sığmayan HER kart için ayrı "NAKİT YETERSİZ" satırı
    // üretiyor → burada 5-6 kez tekrar edip gerçek stratejik önerileri aşağı
    // itiyordu. Birleştirme mantığı Bakış'ta vardı ama önerilerin KANONİK
    // ekranı BURASI; mantık ./oneriGrup'a taşındı, iki ekran da oradan besleniyor.
    // Grup satırı AÇILABİLİR: tek tek kartların "Uyguladım" işareti kaybolmasın
    // (akıbet defteri yalnız bu ekrandan yazılıyor).
    const { grup: nakitGrup, diger: digerOneri, kartlar: nakitKartlar, birlesir } = kritikNakitAyir(oneriler);
    const gosterilenOneriler = birlesir && !nakitGrupAcik ? digerOneri : [...nakitGrup, ...digerOneri];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Açık öneri', deger: String(oneriler.length), alt: 'motor üretimi', renk: oneriler.length > 0 ? R.amber : R.yesil },
          { etiket: 'Uygulanan (30g)', deger: String(sayi(iziOzet?.uygulanan)), alt: 'işaret defterinden', renk: sayi(iziOzet?.uygulanan) > 0 ? R.yesil : R.krem },
          // "Kasa 2,7M ama kullanılabilir 344K" çelişik görünüyordu (canlı
          // denetim 2026-08-03) — formül alt metne yazıldı: kasadan bu ayın
          // zorunlu yükü (kart asgari + kredi taksiti + sabit) düşülmüş hâli.
          {
            etiket: 'Kullanılabilir nakit',
            // 🔴 (2026-08-27, Codex) SAHTE YEŞİL: alan gelmezse `sayi(null)=0`
            // → «0 ₺» ve YEŞİL. «Ölçemedim» ile «nakit dengede» karışıyordu ve
            // sahip buna bakıp ÖDEME KARARI alabilirdi. Alan yoksa sayı yok.
            deger: strateji.kullanilabilir_nakit == null ? '—' : fmt(sayi(strateji.kullanilabilir_nakit)),
            alt: 'kasa − bu ayın zorunlu yükü (asgari+taksit+sabit)',
            renk: strateji.kullanilabilir_nakit == null ? R.not3
              : (sayi(strateji.kullanilabilir_nakit) >= 0 ? R.yesil : R.kirmizi),
          },
          { etiket: 'Öneri toplamı', deger: fmt(sayi(strateji.toplam_oneri_tutari)), alt: 'önerilen hareket tutarı' },
        ]} />
        {/* DUYU 4/6 — öneri akıbeti: "Uyguladım" işareti append-only deftere yazılır.
            Otomatik "ölçülen etki" hesabı BİLEREK yok: hangi KPI'ya bağlanacağı
            öneriye göre değişir, uydurma rakam basılmaz — izi tutulur, etki insan
            notuyla/ileriki iterasyonla bağlanır. */}
        <OneriSeridi metin="Motor yalnız önerir — 'Uyguladım' işareti akıbet defterine yazılır; hangi önerinin hayata geçtiği artık ölçülüyor." />
        {/* Aynı TEK sebebin (serbest nakit yetmiyor) N kart tekrarı — tek satır.
            Tıklayınca kartlar listeye AÇILIR; kapatınca yine toplanır. */}
        {birlesir && (
          <div
            onClick={() => setNakitGrupAcik((a) => !a)}
            tabIndex={0}
            role="button"
            aria-expanded={nakitGrupAcik}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setNakitGrupAcik((a) => !a); } }}
            style={{
              ...kartYuzey, padding: '11px 14px', marginBottom: 10, cursor: 'pointer', outline: 'none',
              borderLeft: `3px solid ${R.kirmizi}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: R.kirmizi }}>{kritikNakitBaslik(nakitGrup)}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3, whiteSpace: 'nowrap' }}>
                {nakitGrupAcik ? 'kartları topla' : 'kartları aç'}
              </span>
            </div>
            {/* ⚠️ TUTAR YOK: uç bu önerilerde tavsiye_tutar=0 gönderiyor; istenen
                tutar yalnız açıklama metninde geçiyor, metinden para parse etmek
                yasak (biçim değişince sessizce yanlış rakam basar). */}
            <div style={{ fontSize: 11.5, color: R.not2, marginTop: 4, lineHeight: 1.4 }}>
              {kritikNakitAlt(nakitKartlar)}
            </div>
          </div>
        )}
        {oneriler.length === 0 ? (
          <BosDurum metin="Şu an açık strateji önerisi yok." />
        ) : gosterilenOneriler.length === 0 ? (
          <BosDurum metin="Tüm öneriler yukarıdaki nakit grubunda — açmak için satıra dokunun." />
        ) : (
          <Liste
            satirlar={gosterilenOneriler.map((o, i) => {
              const ham = String(o.baslik || o.oneri || o.aciklama || `oneri-${i}`);
              // 🔴 (2026-08-27, Codex) KİMLİK ÇAKIŞMASI: ref YALNIZ başlıktan
              // türüyordu. Aynı/benzer başlıklı iki öneri aynı ref'e düşüyor ve
              // birine «uyguladım» demek DİĞERİNİ de etiketliyordu — karar
              // defteri güvenilmez hale geliyordu. Ayırt edici alanlar varsa
              // (ödeme kimliği, şube, tutar) ref'e KATILIR; yoksa sıra numarası
              // son çare olarak eklenir ki iki satır asla aynı kimliği almasın.
              const _refEk = [
                o.odeme_id ? `o${o.odeme_id}` : null,
                o.sube_id ? `s${o.sube_id}` : null,
                (o.tavsiye_tutar != null || o.tutar != null) ? `t${Math.round(sayi(o.tavsiye_tutar ?? o.tutar))}` : null,
              ].filter(Boolean).join(':') || `i${i}`;
              const ref = `strateji:${ham.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').slice(0, 60)}:${_refEk}`;
              const isaret = isaretliler[ref];
              return {
                id: o.id || `o-${i}`,
                _o: o,
                _ref: ref,
                baslik: kisalt(ham, 90),
                alt: kisalt(o.detay || o.gerekce || o.aciklama, 120),
                tutar: o.tutar != null || o.tavsiye_tutar != null ? fmt(sayi(o.tutar ?? o.tavsiye_tutar)) : '',
                tier: /KIRMIZI|kritik/i.test(String(o.renk || o.oncelik || '')) ? 'kritik'
                  : /TURUNCU|uyari/i.test(String(o.renk || o.oncelik || '')) ? 'uyari' : 'bilgi',
                // ⚠️ (2026-08-26) DEFTER YALNIZ "EVET"İ ÖĞRENİYORDU.
                // "Uyguladım" vardı, "gördüm ama şimdi değil" YOKTU. İki sonuç:
                //   1) Öneri-only yarım kalıyordu — sistem önerir, insan karar
                //      verir; ama kararın "sonra" hâli hiçbir yere yazılamıyordu.
                //   2) Aynı öneri her sabah geri geliyor ve SUSTURULAMIYORDU.
                // ⚠️ "Ertele" bir SUSTURMA DEĞİL, bir KARAR: öneri kaybolmaz,
                // rozetle görünür kalır ve defterde izi olur. Sistemin öğrenmesi
                // için "hayır"lar da "evet"ler kadar gerekli.
                ...(isaret === 'uygulandi'
                  ? { rozet: 'uygulandı ✓', rozetRenk: R.yesil }
                  : isaret === 'ertelendi'
                    ? {
                      rozet: 'ertelendi · şimdi değil',
                      rozetRenk: R.not2,
                      aksiyonlar: [{ ad: '✓ Uyguladım', birincil: true, onTikla: () => bulguIsaretle(ref, 'uygulandi') }],
                    }
                    : {
                      aksiyonlar: [
                        { ad: '✓ Uyguladım', birincil: true, onTikla: () => bulguIsaretle(ref, 'uygulandi') },
                        { ad: 'Şimdi değil', onTikla: () => bulguIsaretle(ref, 'ertelendi') },
                      ],
                    }),
              };
            })}
            onAc={({ _o, _ref }) => onCekmece?.({
              tip: 'STRATEJİ ÖNERİSİ',
              baslik: kisalt(String(_o.baslik || _o.oneri || _o.aciklama || 'Öneri'), 80),
              alt: `${_o.oneri_turu ? String(_o.oneri_turu).toLowerCase() : 'öneri'}${_o.sube_adi ? ` · ${_o.sube_adi}` : ''}`,
              kpi: [
                { etiket: 'Tavsiye tutar', deger: (_o.tutar != null || _o.tavsiye_tutar != null) ? fmt(sayi(_o.tutar ?? _o.tavsiye_tutar)) : '—' },
                { etiket: 'Öncelik', deger: String(_o.oncelik || _o.renk || 'normal').toLowerCase() },
                { etiket: 'Tür', deger: String(_o.oneri_turu || '—').toLowerCase() },
                {
                  etiket: 'Akıbet',
                  deger: isaretliler[_ref] === 'uygulandi' ? 'uygulandı'
                    : isaretliler[_ref] === 'ertelendi' ? 'ertelendi' : 'bekliyor',
                  renk: isaretliler[_ref] === 'uygulandi' ? R.yesil
                    : isaretliler[_ref] === 'ertelendi' ? R.not2 : R.amber,
                },
              ],
              listeBaslik: 'Gerekçe',
              satirlar: [
                { ad: 'Motor gerekçesi', detay: 'neden önerildi', tutar: kisalt(_o.detay || _o.gerekce || _o.aciklama || '—', 90) },
                ...(_o.odeme_id ? [{ ad: 'Bağlı ödeme', detay: 'kuyruk kalemi', tutar: String(_o.odeme_id).slice(0, 12) }] : []),
              ],
              not: 'Motor yalnız ÖNERİR — hüküm insanın. "Uyguladım" işareti akıbet defterine yazılır, motorun isabeti bununla ölçülür.',
              ...(isaretliler[_ref] === 'uygulandi' ? {} : {
                aksiyonlar: [{ ad: '✓ Uyguladım', birincil: true, onTikla: () => bulguIsaretle(_ref, 'uygulandi') }],
              }),
            })}
          />
        )}
        {(() => {
          const uygulanabilir = (strateji?.oneriler || []).filter(
            (o) => o.oneri_turu !== 'ERTELE' && o.odeme_id && sayi(o.tavsiye_tutar) > 0);
          if (!uygulanabilir.length) return null;
          const toplam = uygulanabilir.reduce((t, o) => t + sayi(o.tavsiye_tutar), 0);
          return (
            <div style={{ ...kartYuzey, padding: '16px 18px', marginTop: 14, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
                    Önerilen ödeme koşusu — {uygulanabilir.length} kalem
                  </div>
                  <div style={{ fontSize: 11.5, color: R.not, marginTop: 4 }}>
                    toplam <b style={{ fontFamily: F.mono, color: R.bakir }}>{fmt(toplam)}</b> · tek işlemde uygulanır,
                    biri düşerse hiçbiri yazılmaz
                  </div>
                </div>
                {topluSor ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button disabled={topluMesgul} onClick={topluUygula} style={{
                      padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                    }}>{topluMesgul ? 'Uygulanıyor…' : `Eminim — ${fmt(toplam)} öde`}</button>
                    <button onClick={() => setTopluSor(false)} style={{
                      padding: '9px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`, cursor: 'pointer',
                      background: 'transparent', color: R.metin2, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                    }}>Vazgeç</button>
                  </div>
                ) : (
                  <button onClick={() => setTopluSor(true)} style={{
                    padding: '9px 17px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                    fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
                  }}>
                    ⚡ Önerileri toplu uygula
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </>
    );
  }

  return <BosDurum metin="Bilinmeyen görünüm." />;
}
