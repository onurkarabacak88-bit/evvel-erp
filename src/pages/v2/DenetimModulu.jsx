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
      .catch(() => setDurum({}));
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

  const duyuYukle = useCallback(() => {
    setDuyuHata('');
    api('/duyu/kural-karnesi')
      .then((d) => setKarne(d || {}))
      .catch((e) => setDuyuHata(e?.message || ''));
    api('/duyu/sinapsler?gun=14').then((d) => setSinaps(d || {})).catch(() => setSinaps({}));
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
      .catch(() => {});
  };

  const notAc = () => {
    setNotForm({ baslik: '', tip: 'gozlem', sube_id: '' });
    if (!notSubeler.length) api('/subeler').then((d) => setNotSubeler(Array.isArray(d) ? d : [])).catch(() => {});
  };

  const notKaydet = async () => {
    if (!(notForm?.baslik || '').trim()) { onToast?.('Not başlığı gerekli'); return; }
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
  if (gorunum === 'anomali') {
    if (truthHata) return <HataBandi mesaj={truthHata} onTekrar={truthYukle} />;
    if (!rapor) return <Yukleniyor />;
    const subeler = Array.isArray(rapor.subeler) ? rapor.subeler : [];
    const toplamAnomali = subeler.reduce((t, s) => t + sayi(s.anomali_sayisi), 0);
    const alarmli = subeler.filter((s) => s.alarm && s.alarm !== 'normal');
    const uyumlu = subeler.filter((s) => s.ana_tani === 'UYUMLU');
    const hamListe = Array.isArray(notlar?.notlar) ? notlar.notlar : [];
    const hamTipler = Array.isArray(notlar?.tipler) ? notlar.tipler : [];
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'Bugün anomali', deger: String(toplamAnomali), alt: `${subeler.length} şube tarandı`, renk: toplamAnomali > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Alarmlı şube', deger: String(alarmli.length), alt: alarmli.map((s) => s.sube_ad).join(' · ') || 'yok', renk: alarmli.length > 0 ? R.kirmizi : R.yesil },
          { etiket: 'Uyumlu şube', deger: `${uyumlu.length} / ${subeler.length}`, alt: 'ana tanı UYUMLU', renk: R.yesil },
          { etiket: 'Tarih', deger: tarihKisa(rapor.tarih), alt: 'gece koşusu + gün içi' },
        ]} />
        {/* DUYU 3/6 — bulgu yaşam döngüsü: işaret defterinden türeyen ölçümler */}
        {iziOzet && sayi(iziOzet.isaretli_bulgu) > 0 && (
          <KpiSeridi kpiler={[
            { etiket: 'Çözülen (30g)', deger: String(sayi(iziOzet.cozulen)), alt: 'insan işaretiyle', renk: R.yesil },
            { etiket: 'Yanlış alarm', deger: String(sayi(iziOzet.yanlis_alarm)), alt: iziOzet.yanlis_alarm_orani_yuzde != null ? `oran %${iziOzet.yanlis_alarm_orani_yuzde}` : '—', renk: sayi(iziOzet.yanlis_alarm) > 0 ? R.amber : R.yesil },
            { etiket: 'Ort. çözüm süresi', deger: iziOzet.ort_cozum_saat != null ? `${iziOzet.ort_cozum_saat} sa` : '—', alt: 'gece doğum varsayımıyla ≈' },
            { etiket: 'İşaretli bulgu', deger: String(sayi(iziOzet.isaretli_bulgu)), alt: 'append-only defter' },
          ]} />
        )}
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
              return {
                id: s.sube_id,
                baslik: `${s.sube_ad} · ${s.ana_tani || '—'}`,
                alt: kisalt(s.zeka_ozet || s.yorum_metni, 110)
                  || (bulgulu ? `${sayi(s.anomali_sayisi)} anomali · ${sayi(s.toplam_karar)} karar` : 'temiz gün'),
                tutar: bulgulu ? `${sayi(s.anomali_sayisi)} bulgu` : '',
                tier: s.alarm && s.alarm !== 'normal' ? 'kritik' : bulgulu ? 'uyari' : 'iyi',
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
            onAc={({ _s }) => onCekmece?.({
              tip: 'ŞUBE TANISI',
              baslik: _s.sube_ad,
              alt: `${_s.ana_tani || '—'} · ${tarihKisa(_s.tarih)}`,
              kpi: [
                { etiket: 'Anomali', deger: String(sayi(_s.anomali_sayisi)), renk: sayi(_s.anomali_sayisi) > 0 ? R.kirmizi : R.yesil },
                { etiket: 'Karar', deger: String(sayi(_s.toplam_karar)) },
                { etiket: 'Alarm', deger: _s.alarm || 'normal', renk: _s.alarm !== 'normal' ? R.kirmizi : R.yesil },
                { etiket: 'Motor', deger: _s.motor_aktif ? 'aktif' : (_s.motor_mod || 'kapalı'), renk: _s.motor_aktif ? R.yesil : R.amber },
              ],
              listeBaslik: 'Boyut özeti',
              satirlar: (Array.isArray(_s.boyut_ozet) ? _s.boyut_ozet : []).slice(0, 10).map((b, i) => ({
                ad: typeof b === 'string' ? b : (b?.boyut || b?.ad || `boyut ${i + 1}`),
                detay: typeof b === 'object' ? (b?.durum || '') : '',
                tutar: typeof b === 'object' && b?.deger != null ? String(b.deger) : '',
              })),
              not: kisalt(_s.yorum_metni || _s.zeka_ozet, 300) || 'Bu gün için yorum üretilmedi.',
              aksiyonAd: 'Akıllı Denetim ekranını aç',
              _hedef: '__modul:denetim:motorlar',
            })}
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
    const aktifSayi = subeler.filter((s) => s.motor_aktif).length;
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
              const bulgu = sayi(r.anomali_sayisi);
              return {
                id: s.sube_id || `m-${i}`,
                _s: { ...s, ...r },
                hucreler: [
                  { v: s.sube_ad || r.sube_ad || '—', kalin: true },
                  s.motor_aktif ? { v: 'aktif', rozet: R.yesil } : { v: 'kapalı', rozet: R.amber },
                  { v: s.motor_mod || '—', renk: R.not },
                  { v: String(bulgu), mono: true, sag: true, kalin: bulgu > 0, renk: bulgu > 1 ? R.kirmizi : bulgu === 1 ? R.amber : R.not },
                  { v: String(s.son_calisma || r.son_calisma || '—').slice(0, 16), mono: true, renk: R.not },
                  r.alarm && r.alarm !== 'normal'
                    ? { v: 'alarm', rozet: R.kirmizi }
                    : bulgu > 0 ? { v: 'izlemede', rozet: R.amber } : { v: 'temiz', rozet: R.yesil },
                ],
              };
            })}
            onSatir={() => onKopru?.('__modul:denetim:motorlar')}
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
        + (sayi(r.kayit_guveni) && sayi(r.kayit_guveni) < 1 ? ' · aday eşleşme' : ''),
      tutar: r.tutar != null ? fmt(sayi(r.tutar)) : '',
    });
    return (
      <>
        <KpiSeridi kpiler={[
          // `kesit` NESNE: {bas, gun} — sayi(obje)=0 olduğu için hep "60 gün"
          // yazıyordu; sunucu farklı pencere kullansa ekran yanlış söylerdi.
          { etiket: 'Eşleşen', deger: String(eslesen), alt: `son ${sayi(mutabakat.kesit?.gun) || 60} gün`, renk: R.yesil },
          { etiket: 'Açık fark', deger: String(acikFark), alt: 'iki yönlü uyumsuzluk', renk: acikFark > 0 ? R.amber : R.yesil },
          { etiket: 'Düşüş var · kayıt yok', deger: String(dusumsuz.length), alt: 'kasadan çıktı, ödeme kaydı yok', renk: dusumsuz.length > 0 ? R.kirmizi : R.krem },
          { etiket: 'Kayıt var · düşüş yok', deger: String(kayitsiz.length), alt: 'ödeme kaydı var, kasada iz yok', renk: kayitsiz.length > 0 ? R.amber : R.krem },
        ]} />
        <OneriSeridi metin="Mutabakat çapa-bağımsızdır: kasa izi tek gerçek — fark bulunursa elle işaretleme değil, kaynağında düzeltme önerilir." />
        {acikFark === 0 ? (
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
                    <div style={{ fontFamily: F.mono, fontSize: 17, fontWeight: 700, marginTop: 4, color: (duyuKesit.satis.zimni_fiyat || []).length ? R.amber : R.krem }}>
                      {(duyuKesit.satis.zimni_fiyat || []).length}
                    </div>
                    <div style={{ fontSize: 10.5, color: R.not2, marginTop: 3, lineHeight: 1.45 }}>
                      üründe zımni fiyat (ciro/adet) menüden sapıyor
                    </div>
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
    const sinapsOlay = sayi(sinaps?.sinaps_olaylari) || (Array.isArray(sinaps?.sinaps_olaylari) ? sinaps.sinaps_olaylari.length : 0);
    return (
      <>
        <KpiSeridi kpiler={[
          { etiket: 'İzlenen kural', deger: String(kurallar.length), alt: 'öğrenme defteri karnesi' },
          { etiket: 'Öğrenme', deger: karne.ogrenme_aktif ? 'aktif' : 'kapalı', alt: `n eşiği ${sayi(karne.n_esigi) || '—'}`, renk: karne.ogrenme_aktif ? R.yesil : R.amber },
          { etiket: 'Sinaps olayı', deger: String(sinapsOlay), alt: `son ${sayi(sinaps?.kesit) || 14} gün · duyular arası` },
          { etiket: 'Omurga', deger: 'tek gözlem', alt: 'çakışma hata değil ürün' },
        ]} />
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
            deger: fmt(sayi(strateji.kullanilabilir_nakit)),
            alt: 'kasa − bu ayın zorunlu yükü (asgari+taksit+sabit)',
            renk: sayi(strateji.kullanilabilir_nakit) >= 0 ? R.yesil : R.kirmizi,
          },
          { etiket: 'Öneri toplamı', deger: fmt(sayi(strateji.toplam_oneri_tutari)), alt: 'önerilen hareket tutarı' },
        ]} />
        {/* DUYU 4/6 — öneri akıbeti: "Uyguladım" işareti append-only deftere yazılır.
            Otomatik "ölçülen etki" hesabı BİLEREK yok: hangi KPI'ya bağlanacağı
            öneriye göre değişir, uydurma rakam basılmaz — izi tutulur, etki insan
            notuyla/ileriki iterasyonla bağlanır. */}
        <OneriSeridi metin="Motor yalnız önerir — 'Uyguladım' işareti akıbet defterine yazılır; hangi önerinin hayata geçtiği artık ölçülüyor." />
        {oneriler.length === 0 ? (
          <BosDurum metin="Şu an açık strateji önerisi yok." />
        ) : (
          <Liste
            satirlar={oneriler.map((o, i) => {
              const ham = String(o.baslik || o.oneri || o.aciklama || `oneri-${i}`);
              const ref = `strateji:${ham.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').slice(0, 60)}`;
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
                ...(isaret === 'uygulandi'
                  ? { rozet: 'uygulandı ✓', rozetRenk: R.yesil }
                  : { aksiyonlar: [{ ad: '✓ Uyguladım', birincil: true, onTikla: () => bulguIsaretle(ref, 'uygulandi') }] }),
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
                { etiket: 'Akıbet', deger: isaretliler[_ref] === 'uygulandi' ? 'uygulandı' : 'bekliyor', renk: isaretliler[_ref] === 'uygulandi' ? R.yesil : R.amber },
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
