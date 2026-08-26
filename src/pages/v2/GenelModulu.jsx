// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — GENEL BAKIŞ modülü (rayın EN ÜSTÜ, Panel'in üstünde)
//
// Sahip isteği (2026-07-31): "klasik CFO panelinde 13 bölüm / 20+ uç vardı,
// SADECE ORADAKİ KARTLARI görmek istiyorum."
// Bu modül klasik `Panel.jsx`'in (3336 satır) KART bölümlerini kadife dilinde
// taşır. Panel modülü ESKİ HÂLİNDE kaldı — buraya hiçbir şey iliştirilmedi.
//
// ⚠️ KARTLAR SALT-OKUR. Klasikteki form/aksiyon alanları (fiyat girişi, fatura
// PDF yükleme, toplu ödeme koşusu) BİLEREK taşınmadı: sahip "kartları görmek
// istiyorum" dedi; ayrıca o işlerin yerli karşılığı zaten Maliyet / Belge /
// Ödeme Merkezi modüllerinde duruyor (aynı işi iki yerde yapmak "tek eylem
// tek yer" kuralını çiğner).
//
// ⚠️ TRİAJ NEYE GÖRE: klasik panel ödemeleri UYARI SEVİYESİNE göre değil,
// GECİKME GÜNÜNE (`gun_farki`) göre ayırıyor — 15+ / 8-14 / 0-7 / bugün.
// İlk denememde seviyeye göre ayırmıştım, yanlıştı; kaynak okunarak düzeltildi.
//
// Uçlar: /panel · /uyarilar · /onay-kuyrugu · /kasa-kontrol ·
//        /sabit-giderler/odemeler · /sabit-giderler/odenenler · /vadeli-alimlar/ozet
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import { api, fmt } from '../../utils/api';
import { R, F, kartYuzey, IK } from './tema';
import { KpiSeridi, Liste, Tablo, BosDurum, HataBandi, Ikon } from './parcalar';
import { kayitDosyasiYukle, belgeYukleyiciUret, cariEkstreAksiyonu } from './kayitDosyasi';
import { enKritikOneri } from './oneriGrup';
// 📈 Zam Takibi ayrı dosyada: kendi verisini kendi çeker, Bakış'ın /panel
// yüklemesini bekletmez (2026-08-16 taşıma turu).
import ZamTakibi from './ZamTakibi';

const sayi = (v) => Number(v) || 0;

/** Ödeme tutarının TEK ERİŞİMCİSİ — fallback zinciri burada, başka yerde değil.
 *  🔵 (2026-08-26) Bileşen içinden MODÜL seviyesine alındı: "değişim önceliği"
 *  anlık görüntüsünü alan useEffect erken çıkışların ÜSTÜNDE çalışmak zorunda
 *  (koşullu hook yasak), oraya da aynı zincir lazımdı. Kopyalanmadı — taşındı;
 *  iki ayrı tutar okuması bir gün kaçınılmaz olarak ayrışırdı. */
const odemeTutar = (u) => sayi(u.tutar ?? u.asgari_kalan ?? u.asgari);
const kisalt = (t, n = 88) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
/** Türkçe-I tuzağı: 'I'→'ı', 'İ'→'i'. Ekran metni küçültmesinde HEP bu. */
const trKucuk = (s) => String(s || '').toLocaleLowerCase('tr');

/** KISA PARA — dar çiplerde tek satıra sığsın diye: 33.250 ₺ → "33,3K ₺".
 *  ⚠️ Yalnız DAR yüzeylerde kullanılır; KPI ve liste satırları tam rakamı
 *  gösterir (yuvarlanmış rakam karşılaştırma için iyidir, mutabakat için değil). */
const kisaPara = (v) => {
  const n = sayi(v);
  const m = Math.abs(n);
  if (m >= 1e6) return `${(n / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}M ₺`;
  if (m >= 1000) return `${(n / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}K ₺`;
  return `${Math.round(n).toLocaleString('tr-TR')} ₺`;
};

/** Sunucunun teknik `tip` kodu → sahibin dili.
 *  Canlıda satır altında ham 'degisken' yazıyordu (motors.py:1411) — sahip
 *  "degisken" diye bir gider tanımadı; görünen etiket Türkçeleştirilir.
 *  Sözlükte olmayan tip HAM geçer (uydurma çeviri yok). */
const TIP_ETIKET = { degisken: 'değişken gider', sabit: 'sabit gider' };
const tipEtiket = (t) => {
  const s = String(t ?? '').trim();
  if (!s) return null;
  return TIP_ETIKET[trKucuk(s)] || s;
};

// ── ŞUBE SÖZLÜĞÜ (Y3 — küçük kalemleri şube başlığı altında toplamak için) ───
// ⚠️ KURAL: YANLIŞ GRUPLAMA > GRUPLAMAMA. Bu yüzden desen ANCHOR'lu (tam kelime)
// ve yalnız adın İLK kelimesine bakılır — "Kira ödemesi, Zafer'in payı" gibi
// metinlerde kelime geçse bile kayıt gruplanmaz, tekil kalır.
// Türkçe-I tuzağına düşmemek için toLowerCase YOK: desenler ö/ğ/i alternatifli.
const SUBE_SOZLUK = [
  ['GAZZE', /^gazze$/i],
  ['KÖYCEĞİZ', /^k[öo]yce[ğg][iı]z$/i],
  ['ALSANCAK', /^alsancak$/i],
  ['ZAFER', /^zafer$/i],
  ['TEMA', /^tema$/i],
];
const AYIRAC_RE = /[\s:·\-–—,/()]+/;
const subeSozlukten = (parca) => {
  const t = String(parca || '').trim();
  if (!t) return null;
  for (const [ad, re] of SUBE_SOZLUK) if (re.test(t)) return ad;
  return null;
};
/** Kaydın şubesi — ÖNCE gerçek alan, YOKSA adın ilk kelimesi, o da yoksa null.
 *  null = "türetilemedi" → kayıt gruplanmaz (tekil satır olarak kalır). */
const kayitSubesi = (u) => {
  const alan = String(u?.sube ?? u?.sube_adi ?? u?.sube_ad ?? '').trim();
  if (alan) return subeSozlukten(alan) || alan;   // alan varsa TÜRETME yok
  const ham = String(u?.ad ?? u?.aciklama ?? '').trim();
  const ilk = ham.split(AYIRAC_RE).filter(Boolean)[0] || '';
  return subeSozlukten(ilk);
};

// ═══════════════════ ŞUBE IŞIKLARI (Sabah Kokpiti B1) ═══════════════════════
// Sahip sabah ilk şunu soruyor: "dükkânlar açıldı mı, dün kapandı mı?"
// Kaynak: /ops/kapanis-takip (bugün + dün) ve /subeler (sezon + açılış saati).
//
// ⚠️ RENK-KÖRÜ YEDEĞİ: her ışığın yanında İŞARET var (✓ / – / !) — karar
// yalnız renge bağlı kalmaz.
const ISIK = {
  acik: { renk: R.yesil, isaret: '✓', ad: 'açık' },
  kapandi: { renk: R.yesil, isaret: '✓', ad: 'gün kapandı' },
  bekleniyor: { renk: R.amber, isaret: '–', ad: 'henüz açılmadı' },
  gec: { renk: R.kirmizi, isaret: '!', ad: 'açılmadı · geç' },
  sezon: { renk: R.not3, isaret: '–', ad: 'sezon kapalı' },
  veriYok: { renk: R.not3, isaret: '?', ad: 'veri yok' },
};
/** Açılıştan sonra kaç dakika "hâlâ normal" sayılır (amber → kırmızı eşiği). */
const GEC_TOLERANS_DK = 60;
const VARSAYILAN_ACILIS_DK = 8 * 60;   // acilis_saati tanımsızsa 08:00

/** "HH:MM" → dakika. Çözülemezse null (uydurma saat üretmeyiz). */
const saatDakika = (s) => {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const sa = Number(m[1]); const dk = Number(m[2]);
  if (sa > 23 || dk > 59) return null;
  return sa * 60 + dk;
};
/** Sunucu zaman damgası ("2026-08-16 08:42:17…") → "08:42". Çözülemezse null
 *  (uydurma saat üretmeyiz). acilis_ts sunucuda Europe/Istanbul'a çevrilmiş
 *  gelir — burada dilim dönüşümü YAPILMAZ, yalnız metinden saat kesilir. */
const tsSaat = (ts) => {
  const m = String(ts || '').match(/[T ](\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
};
/** Şu anki İstanbul saati (dakika). Tarayıcı saat dilimi ne olursa olsun TR. */
const trSimdiDk = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return saatDakika(p) ?? 0;
};

/**
 * Bir şubenin ışığı. SAF fonksiyon — test edilebilsin diye `simdiDk` dışarıdan.
 * @param satir  bugünün /ops/kapanis-takip satırı (yoksa null)
 * @param tanim  /subeler kaydı (yoksa null → sezon bilinmez, gri YAPILMAZ)
 * @param dunSatir dünün satırı; `dunBilinmiyor` true ise dün hakkında HÜKÜM YOK
 */
const subeIsigi = ({ satir, tanim, dunSatir, dunBilinmiyor, simdiDk }) => {
  if (tanim?.sezon_kapali) return { ...ISIK.sezon, anahtar: 'sezon', dunMetni: null };
  // Dün kapanışı: bilinmiyorsa "eksik" DEME (sahte alarm) — "—" yaz.
  const dunKapandi = dunBilinmiyor || !dunSatir ? null : !!dunSatir.kapanis_tamam;
  const dunMetni = dunKapandi === null ? 'dün —'
    : dunKapandi ? 'dün ✓' : 'dün kapanış ✗';

  if (!satir) return { ...ISIK.veriYok, anahtar: 'veriYok', dunMetni };

  let taban;
  if (satir.kapanis_tamam) taban = { ...ISIK.kapandi, anahtar: 'kapandi' };
  else if (satir.acildi) taban = { ...ISIK.acik, anahtar: 'acik' };
  else {
    const acilisDk = saatDakika(tanim?.acilis_saati) ?? VARSAYILAN_ACILIS_DK;
    taban = simdiDk < acilisDk + GEC_TOLERANS_DK
      ? { ...ISIK.bekleniyor, anahtar: 'bekleniyor' }
      : { ...ISIK.gec, anahtar: 'gec' };
  }
  // Dün kapanışı EKSİKSE ışık kırmızıya çekilir (para/ciro izi eksik demektir),
  // ama etiket bugünün durumunu söylemeye devam eder — iki gerçek de görünür.
  if (dunKapandi === false) {
    return { ...taban, renk: ISIK.gec.renk, isaret: '!', dunMetni, dunEksik: true };
  }
  return { ...taban, dunMetni };
};
const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const kisaGun = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${AY_KISA[Number(m[2]) - 1]}` : String(iso || '—');
};

/** Ödeme adını sadeleştirir — ekranda TEKNİK metin durmasın diye.
 *  Sunucu adı "Vadeli Alım: Fatura NAZ2026000000236 (DORUK AJANS MATBAACILIK)"
 *  gibi geliyor: sahip önce KİME ödeneceğini görmeli, fatura numarası detaydır.
 *  1) baştaki tekrarlı "Vadeli Alım: " önekleri soyulur (kayıtlarda 2 kez üst üste
 *     bindiği görüldü), 2) sondaki parantez içi FİRMA başlığa çıkar, kalan kısım
 *     (fatura no) alt satıra iner, 3) parantez yoksa soyulmuş ham metin kalır.
 *  Bilgi kaybı yok: ham metin ödeme çekmecesinin "Ödeme adı" satırında durur. */
/** Sunucu gün adını İngilizce gönderiyor ("Friday") — ekranda Türkçe durur. */
const GUN_TR = {
  Monday: 'Pazartesi', Tuesday: 'Salı', Wednesday: 'Çarşamba', Thursday: 'Perşembe',
  Friday: 'Cuma', Saturday: 'Cumartesi', Sunday: 'Pazar',
};
const gunTr = (g) => {
  const s = String(g || '').trim();
  return GUN_TR[s] || s || '—';
};

const HARF_RE = /[A-Za-zĞÜŞİÖÇÂÎÛğüşıiöçâîû]/g;
/** Parantez içi metin gerçekten FİRMA ADI mı? (canlı yanlış-pozitif filtresi)
 *  Kart/kredi/abone kayıtlarında da son parantez var ama içi firma değil:
 *  "(kesim 2026-07-20)" · "(21346598)" · "(01564752)" — bunlar başlığa çıkınca
 *  sahip kimin ödemesi olduğunu göremiyordu. İki kapı: kesim tarihi metni
 *  reddedilir; rakam/no ağırlıklı içerik (harf < uzunluğun yarısı) reddedilir. */
const firmaMi = (icerik) => {
  const s = String(icerik || '').trim();
  if (!s || /kesim/i.test(s)) return false;
  return (s.match(HARF_RE) || []).length >= s.length / 2;
};
const sadeOdemeAdi = (ham) => {
  const t = String(ham ?? '').trim().replace(/^(Vadeli Alım:\s*)+/i, '').trim();
  // SON parantez grubu — kuyruğa rağmen. Eskiden `\)\s*$` şartı vardı, bu yüzden
  // "… (ESHİM TEKNİK SERVİS) — sahip onayı…" gibi parantezden SONRA metin süren
  // kayıtlarda firma hiç yakalanmıyordu. `(?=[^()]*$)` = bundan sonra başka
  // parantez yok, yani bu sondaki grup.
  const m = t.match(/\(([^()]{3,})\)(?=[^()]*$)/);
  if (m) {
    const firma = m[1].trim();
    if (firmaMi(firma)) {
      const onces = t.slice(0, m.index).trim().replace(/[·\-–—,:;]+$/, '').trim();
      const kuyruk = t.slice(m.index + m[0].length).trim().replace(/^[·\-–—,:;]+/, '').trim();
      const ek = [onces, kuyruk].filter(Boolean).join(' · ');
      return { baslik: firma, ek: ek || null };
    }
  }
  return { baslik: t, ek: null };
};

/** Klasik panelin bölüm başlığı — kadife karşılığı. */
function Bolum({ baslik, not, renk, sayac, cocuk }) {
  return (
    <div style={{ ...kartYuzey, padding: '18px 20px', marginBottom: 14 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12,
        paddingBottom: 10, borderBottom: `1px solid ${R.cizgi2}`, flexWrap: 'wrap',
      }}>
        {renk && <span style={{ width: 7, height: 7, borderRadius: 99, background: renk }} />}
        <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>{baslik}</span>
        {sayac != null && (
          <span style={{ fontFamily: F.mono, fontSize: 11.5, fontWeight: 700, color: renk || R.bakir }}>
            {sayac}
          </span>
        )}
        {not && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not2 }}>{not}</span>}
      </div>
      {cocuk}
    </div>
  );
}

/** Ad → değer satırı (klasikteki özet satırlarının karşılığı). */
function Satir({ ad, deger, renk, alt }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 12, padding: '8px 0', borderBottom: `1px solid ${R.cizgi2}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: R.metin2 }}>{ad}</div>
        {alt && <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{alt}</div>}
      </div>
      <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 13, fontWeight: 700, color: renk || R.krem }}>
        {deger}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BAKIŞ / KARAR ALANI — SUNUM PARÇALARI (2026-08-16 yeniden-düzen)
//
// ⚠️ Neden `parcalar.jsx`'e yazılmadılar: bunlar Bakış'a ÖZGÜ yerleşim
// parçaları (katman akordeonu, şube grubu, iş kartı). Paylaşılan dosyaya
// konsalar 14 modülün yüzeyini genişletirdi; oraya YALNIZ `Liste`'ye eklenen
// additive `solgun` bayrağı gitti.
// ⚠️ Hiçbiri VERİ HESAPLAMAZ — hazır sayıları çizerler.
// ─────────────────────────────────────────────────────────────────────────────

/** Renk zeminli küçük ikon kutusu — emoji yerine tema IK seti. */
function IkonRozet({ yol, renk, boyut = 15 }) {
  return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      width: boyut + 12, height: boyut + 12, borderRadius: 9,
      background: `${renk}1F`, color: renk,
    }}>
      <Ikon yol={yol} boyut={boyut} />
    </span>
  );
}

/** Aç/kapa göstergesi — dönen chevron (emoji ▾ değil, tema çizgisi). */
function AcKapaOk({ acik, renk }) {
  return (
    <span style={{
      display: 'flex', color: renk, flexShrink: 0,
      transform: acik ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease',
    }}>
      <Ikon yol={IK.asagiOk} boyut={14} />
    </span>
  );
}

/** Klavye + fare ile açılabilen başlık — `div role=button` tekrarını tek yere alır.
 *  `acik` verilirse aria-expanded yazılır: aç/kapa durumu METİN olarak değil,
 *  chevron + erişilebilirlik özniteliğiyle taşınır (ekranda 5 katman × "Aç"
 *  kelimesi gereksiz gürültüydü — chevron zaten standart affordans). */
const acilirBaslikOzellik = (onAc, acik, etiket) => ({
  onClick: onAc,
  tabIndex: 0,
  role: 'button',
  ...(acik == null ? {} : { 'aria-expanded': acik }),
  ...(etiket ? { 'aria-label': etiket, title: etiket } : {}),
  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAc(); } },
});

// ═══════════════════ MOZAİK PARÇALARI (Sabah Kokpiti) ═══════════════════════
// Sahip: "hâlâ alt alta sıralı ve rahatsız edici — DESEN kurmalıyız."
// Bu yüzden her bant YATAY bir ızgaradır; hiçbir bant dikey liste değildir.
// `Izgara` tek yerden yönetir: kartlar eşit yükseklikte (stretch), gap tutarlı.

/** Bant başlığı — küçük, sessiz etiket (ŞUBELER / BUGÜN / PARA / KISA YOLLAR). */
function Bant({ etiket, not, cocuk }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, lineHeight: 1.1 }}>
        <span style={{
          fontSize: 10, letterSpacing: '1.1px', textTransform: 'uppercase',
          color: R.not, fontWeight: 700,
        }}>
          {etiket}
        </span>
        {not && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3 }}>{not}</span>}
      </div>
      {cocuk}
    </section>
  );
}

/** Yatay kart ızgarası — `en` = kartın en dar hâli (auto-fit ile sarar). */
function Izgara({ en, cocuk, gap = 10 }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${en}px,1fr))`,
      gap, alignItems: 'stretch',
    }}>
      {cocuk}
    </div>
  );
}

/**
 * ŞUBE IŞIĞI — sabahın ilk sorusu: "bu dükkân açıldı mı?"
 * TEK BAKIŞ KURALI: uzaktan okunan şey RENK + İŞARET; rakamlar mini satırda.
 */
function SubeIsigi({ ad, isik, ciroMetni, acilisSaat }) {
  return (
    <div
      title={`${ad} — ${isik.ad}${acilisSaat ? ` · açılış ${acilisSaat}` : ''}${isik.dunEksik ? ' · dün kapanış eksik' : ''}`}
      style={{
        ...kartYuzey, padding: '9px 11px', borderRadius: 14,
        borderTop: `3px solid ${isik.renk}`,
        display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {/* 11px ışık + renk-körü işareti — renge tek başına güvenilmez */}
        <span style={{
          width: 11, height: 11, borderRadius: 99, background: isik.renk, flexShrink: 0,
          boxShadow: `0 0 0 3px ${isik.renk}22`,
        }} />
        <span style={{
          fontFamily: F.baslik, fontSize: 13.5, fontWeight: 600, color: R.krem,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>
          {ad}
        </span>
        <span style={{
          marginLeft: 'auto', flexShrink: 0, fontFamily: F.mono, fontSize: 12,
          fontWeight: 700, color: isik.renk,
        }}>
          {isik.isaret}
        </span>
      </div>
      {/* Açılış saati durum satırının YANINA yazılır (yeni satır değil):
          kokpitin 720px tam-tek-ekran bütçesi kart yükseltilerek bozulmaz. */}
      <div style={{ fontSize: 11, color: isik.renk, fontWeight: 600, lineHeight: 1.2 }}>
        {isik.ad}
        {acilisSaat && (
          <span style={{ fontFamily: F.mono, fontWeight: 700 }}> · {acilisSaat}</span>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: R.not2, lineHeight: 1.25 }}>
        {[ciroMetni, isik.dunMetni].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

/**
 * KATMAN ÇİPİ — gecikme kovasının yatay özeti (eski dikey akordeon satırının
 * mozaik karşılığı). Tıklayınca kalem listesi bandın ALTINDA yerinde açılır.
 *
 * 🔑 GÜVEN İLKESİ korunur: kapalıyken ADET · TOPLAM · EN ESKİ · EN BÜYÜK
 * dördü de kartın üstünde durur — hiçbiri "aç"ın arkasına saklanmaz.
 */
// `degisim` (2026-08-26): "bu hafta +2" — KRONİK ile AKUT'u ayırır.
// 78 gündür duran 18 kalem ile bu hafta gelen 2 kalem AYNI ŞEY DEĞİLDİR:
// birincisi yapılandırma kararı ister, ikincisi bugün ödeme kararı. Tek bir
// "18 kalem" rakamı ikisini tek torbaya koyuyordu ve sahip her sabah aynı
// kırmızıyı görüp duyarsızlaşıyordu. Karşılaştırma tabanı yoksa YAZILMAZ.
function KatmanCipi({ baslik, renk, adet, toplam, enBuyukMetin, enBuyukKisa, vadeKisa, degisim, acik, onAc }) {
  return (
    <div
      {...acilirBaslikOzellik(
        onAc, acik,
        // İpucu = TAM hâl (firma adıyla). Ekrandaki kısa hâl tutarı zaten
        // gösteriyor; ipucu yalnız "hangi kalem" sorusunu cevaplar.
        `${baslik} — ${enBuyukMetin} · ${acik ? 'kapat' : `${adet} kalemi aç`}`,
      )}
      style={{
        ...kartYuzey, padding: '9px 12px', borderRadius: 14,
        borderTop: `3px solid ${renk}`, cursor: 'pointer', outline: 'none',
        display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
        ...(acik ? { boxShadow: `0 0 0 1px ${renk}66, 0 12px 28px rgba(0,0,0,.3)` } : null),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Başlık TEK SATIR: uzun kova adı sarınca çip 2 kademe uzuyor ve
            mozaik tek ekrandan taşıyordu. Tam metin ipucunda. */}
        <span style={{
          fontSize: 10.5, fontWeight: 700, color: renk, letterSpacing: '.3px',
          minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          lineHeight: 1.25,
        }}>
          {baslik}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}><AcKapaOk acik={acik} renk={R.not3} /></span>
      </div>
      {/* Rütbe: çipin ana rakamı 16 mono — KPI'nın (20) altında, metnin üstünde */}
      <div style={{ fontFamily: F.mono, fontSize: 16, fontWeight: 700, color: renk, lineHeight: 1.15 }}>
        {toplam}
      </div>
      {/* TEK SATIR — sarmaz, sığmazsa kırpılır (tam metin ipucunda).
          Üç gerçek de EKRANDA: adet · yaş · en büyük tutar. */}
      <div style={{
        fontSize: 10.5, color: R.not2, lineHeight: 1.25,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {[`${adet} kalem`, vadeKisa, enBuyukKisa].filter(Boolean).join(' · ')}
        {degisim && <span style={{ color: R.bakirAcik, fontWeight: 700 }}> · {degisim}</span>}
      </div>
    </div>
  );
}

/** Kısa yol / iş çipi — yatay bant elemanı. `rozet` mevcut sayaçlardan gelir.
 *  `buyuk` = BUGÜN bandının iş kartı (büyük ikon + iki satır + aksiyon metni);
 *  yalın hâl = KISA YOLLAR çipi (13px ikon + rozet + '›' oku, tek satır). */
function Cip({ ikonYol, renk, baslik, alt, rozet, aksiyonAd, onTikla, buyuk, birincil }) {
  return (
    <div
      {...(onTikla ? acilirBaslikOzellik(onTikla, null, aksiyonAd || baslik) : {})}
      style={{
        ...kartYuzey, borderRadius: 13, padding: buyuk ? '9px 12px' : '6px 11px',
        // K5 — "hepsi eşit" hissini kırar: günün 1 numaralı işi kalın kenar +
        // renk halkasıyla öne çıkar, 2-3 nötr kalır. Yükseklik AYNI (ızgara
        // stretch'te en uzun kartı takip ederdi → tek ekran bütçesi bozulmasın).
        borderLeft: `${birincil ? 4 : 3}px solid ${renk}`,
        ...(birincil ? { boxShadow: `0 0 0 1px ${renk}55, 0 12px 28px rgba(0,0,0,.3)` } : null),
        cursor: onTikla ? 'pointer' : 'default',
        outline: 'none', display: 'flex', alignItems: 'center', gap: buyuk ? 9 : 7, minWidth: 0,
      }}
    >
      {/* Z3 (sahip: "kısa yol çipleri pek kullanışlı değil"):
          6px renk noktası ne olduğunu anlatmıyordu — küçük çipte de İKON var.
          ⚠️ YÜKSEKLİK BÜTÇESİ KUTSAL: küçük çipte ZEMİNLİ kutu (IkonRozet)
          kullanılMAZ — kutu 13+12=25px olup çipi 31→39px şişiriyordu (ölçüldü).
          Çıplak 13px ikon metin satırından (16px) alçak kalır → çip 31px'te
          sabit. Büyük (BUGÜN) kartlarında kutu duruyor, orada yer var. */}
      {buyuk && ikonYol && <IkonRozet yol={ikonYol} renk={renk} boyut={birincil ? 16 : 14} />}
      {!buyuk && (ikonYol
        ? <span style={{ display: 'flex', color: renk, flexShrink: 0 }}><Ikon yol={ikonYol} boyut={13} /></span>
        : <span style={{ width: 6, height: 6, borderRadius: 99, background: renk, flexShrink: 0 }} />)}
      <div style={{ minWidth: 0 }}>
        <div style={{
          // Rütbe: birincil iş 13,5 + kendi rengi · ikincil işler 12,5 + krem
          // (nötr). Renk yalnız 1 numarada "bak buraya" der.
          fontSize: birincil ? 13.5 : buyuk ? 12.5 : 12,
          fontWeight: birincil ? 700 : 600,
          color: birincil ? renk : R.krem,
          lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: buyuk ? 'normal' : 'nowrap',
        }}>
          {baslik}
        </div>
        {alt && <div style={{ fontSize: 10.5, color: R.not2, marginTop: 2, lineHeight: 1.25 }}>{alt}</div>}
      </div>
      {rozet != null && (
        <span style={{
          marginLeft: 'auto', flexShrink: 0, padding: '2px 8px', borderRadius: 99,
          fontFamily: F.mono, fontSize: 10.5, fontWeight: 700,
          background: `${renk}24`, color: renk,
        }}>
          {rozet}
        </span>
      )}
      {/* Z3 — "buraya basılır" işareti. Rozetten SONRA, ince ve sessiz.
          Yalnız küçük çipte: BUGÜN kartlarında zaten "… →" aksiyon metni var,
          iki ok üst üste gürültü olurdu. Yükseklik etkisi yok (satır içi glif). */}
      {!buyuk && onTikla && (
        <span style={{
          flexShrink: 0, fontSize: 12, lineHeight: 1, color: R.not2,
          marginLeft: rozet != null ? 6 : 'auto',
        }}>
          ›
        </span>
      )}
    </div>
  );
}

/**
 * ŞUBE GRUBU — küçük kalemler ("ALSANCAK elektrik/su/genel") tek satırda.
 * Grubun İÇİ ayrıca açılır; kalemler kaybolmaz, sadece bir kademe geriye gider.
 */
function SubeGrubu({ sube, adet, toplam, kelimeler, acik, onAc, cocuk }) {
  return (
    <div style={{ borderRadius: 12, background: R.girinti, border: `1px solid ${R.cizgi2}` }}>
      <div
        {...acilirBaslikOzellik(onAc, acik, `${sube} — ${acik ? 'kapat' : `${adet} kalemi aç`}`)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          cursor: 'pointer', outline: 'none',
        }}
      >
        <IkonRozet yol={IK.kahve} renk={R.bakir} boyut={13} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: R.krem }}>
            {sube} — {adet} kalem
          </div>
          {kelimeler && <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{kelimeler}</div>}
        </div>
        <span style={{
          marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
        }}>
          <span style={{ fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, color: R.metin2 }}>{toplam}</span>
          <AcKapaOk acik={acik} renk={R.not3} />
        </span>
      </div>
      {acik && (
        <div style={{ padding: '0 10px 10px' }}>{cocuk}</div>
      )}
    </div>
  );
}

export default function GenelModulu({ gorunum, onCekmece, onKopru, onToast, onZamSayac }) {
  const [veri, setVeri] = useState(null);
  const [hata, setHata] = useState('');
  // ⚠️ HOOK YERİ: aşağıda `if (!veri) return …` erken çıkışları var — bu iki
  // state onların ÜSTÜNDE durmak zorunda (koşullu hook = React kuralı ihlali).
  // Katman akordeonu ve şube grubu açıklıkları YALNIZ görünüm durumudur, veri
  // değildir; yenilemede sıfırlanmaları da beklenen davranıştır.
  const [acikKatman, setAcikKatman] = useState({});   // { katmanAnahtari: true }
  const [acikGrup, setAcikGrup] = useState({});       // { 'katman|ŞUBE': true }

  const yukle = () => {
    setHata('');
    Promise.all([
      api('/panel').catch(() => null),
      api('/uyarilar').catch(() => []),
      api('/onay-kuyrugu?durum=bekliyor&limit=400').catch(() => []),
      // 🟡 EVV-GENEL-N5 (2026-08-12): /kasa-kontrol çekiliyor ama HİÇ kullanılmıyordu
      // (KPI'lar p.kasa=/panel kullanır) → ölü-okuma kaldırıldı (boşa API çağrısı).
      api('/sabit-giderler/odenenler').catch(() => null),
      api('/vadeli-alimlar/ozet').catch(() => null),
      // NAKİT KONUM (2026-08-08): "param şu an nerede?" — şube kasası / yolda /
      // banka duraklarının toplamı ile kasa defteri bakiyesini karşılaştırır.
      api('/ops/metrics/nakit-konum?gun=60').catch(() => null),
      // ☀️ SABAH KOKPİTİ (2026-08-16, sahip: "dükkânın açılıp açılmadığı gibi
      // KISA YOLLARLA 2 dakikada inceleyeceği şeyler"). YENİ UÇ YAZILMADI —
      // klasik Operasyon Merkezi'nin "📊 Kapanış Takip" sekmesini besleyen uç
      // (operasyon_merkez_api.kapanis_takip:1952) şube başına AÇILIŞ + KAPANIŞ +
      // CİRO'yu zaten döndürüyor.
      // ⚠️ SENTİNEL: null yerine '__HATA__' — okuma düşerse "hiç şube yok"
      // (sahte-yeşil) ile karışmasın; kartlar dürüstçe "veri yok" der.
      api('/ops/kapanis-takip').catch(() => '__HATA__'),
      // Şube tanımları: `sezon_kapali` (gri ışık) ve `acilis_saati` (erken/geç
      // eşiği) YALNIZ burada var — kapanis-takip yalnız id+ad seçiyor.
      api('/subeler').catch(() => null),
    ]).then(([panel, uyarilar, onaylar, odenen, vadeli, nakit, kapanis, subeler]) => {
      // 🔴 P1 (2026-08-12, Genel denetimi) FAKE-GREEN: /panel DÜŞSE de setHata VE setVeri
      // ikisi de çalışıyordu → `hata && !veri` (98) veri dolu olduğu için banner GÖSTERMEZ,
      // panel={} ile "0/boş/yeşil" dashboard render ediyordu (kasa 0 yeşil vb). Panel
      // yoksa veri KURMA → HataBandi görünsün (kısmi money-read hatası gizlenmesin).
      if (!panel) { setHata('Panel verisi alınamadı — "0/boş" görünüm yanıltıcı olur, yenileyin.'); return; }
      setVeri({ panel, uyarilar, onaylar, odenen, vadeli, nakit, kapanis, subeler, dun: null });

      // ── DÜNÜN KAPANIŞI (zincirli ikinci okuma) ──────────────────────────
      // ⚠️ "Dün"ü İSTEMCİDE HESAPLAMIYORUZ. Sunucunun İŞ GÜNÜ kavramı var
      // (gece 02:00'a kadar önceki takvim günü — is_gunu_tr); tarayıcı saati
      // ile hesaplarsak gece yarısı ile 02:00 arasında YANLIŞ GÜNÜ "dün" diye
      // gösteririz. Bu yüzden dün = sunucunun döndürdüğü is_gunu_tr − 1.
      const isGunu = kapanis && kapanis !== '__HATA__' ? String(kapanis.is_gunu_tr || '') : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(isGunu)) return;
      const d = new Date(`${isGunu}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      const dunIso = d.toISOString().slice(0, 10);
      // Fonksiyonel merge: yanıt geç gelirse ve sahip bu arada yenilediyse
      // eski cevabın yeni veriyi ezmemesi için state'in KENDİSİNE sorulur.
      api(`/ops/kapanis-takip?tarih=${dunIso}`)
        .then((x) => setVeri((s) => (s ? { ...s, dun: x } : s)))
        .catch(() => setVeri((s) => (s ? { ...s, dun: '__HATA__' } : s)));
    }).catch((e) => setHata(e?.message || 'Veri alınamadı'));
  };
  useEffect(yukle, []);

  // ══════════════════════════════════════════════════════════════════════════
  // 📉 DEĞİŞİM ÖNCELİĞİ (2026-08-26 BAKIŞ kurgusu · HAMLE 3)
  // ══════════════════════════════════════════════════════════════════════════
  // ── NEDEN ────────────────────────────────────────────────────────────────
  // Sabit uyaran görünmez olur. "GECİKMİŞ 1.433.944 ₺" her sabah aynı rakamsa
  // üçüncü günden sonra duvar kâğıdıdır — sahip ona bakmayı bırakır, sonra
  // rakam gerçekten sıçradığında da fark etmez. Alışkanlaşmanın tek panzehri
  // ENVANTER değil DEĞİŞİM anlatmaktır: "dünden beri +50.400 · 2 yeni kalem".
  //
  // ── NEDEN localStorage, NEDEN YENİ TABLO DEĞİL ───────────────────────────
  // Bu bir KARŞILAŞTIRMA TABANI, bir kayıt değil. Sunucuya yazsaydık her açılış
  // veri üretirdi (kayıt üretmeyen ekran kuralı) ve gece anlık görüntüsüyle
  // ikinci bir gerçek doğardı. Tarayıcıda durur, kimseyi bağlamaz.
  //
  // ⚠️ TARİH SUNUCUDAN: "bugün"ü tarayıcı saatinden hesaplamak bu dosyada zaten
  // yasak (sunucunun iş günü kavramı var — gece 02:00'a kadar önceki gün).
  // is_gunu_tr okunamıyorsa DELTA HİÇ YAZILMAZ; yanlış günle kıyaslamaktansa
  // hiç kıyaslamamak doğrudur.
  //
  // ⚠️ İKİ KAYIT TUTULUR ({bugun, onceki}) — tek kayıt tutsaydık aynı gün içinde
  // sayfa yenilendiğinde taban "bugün" olur, delta 0,00 çıkar ve ekran
  // "hiçbir şey değişmedi" YALANINI söylerdi (dairesel mutabakat tuzağı).
  // ══════════════════════════════════════════════════════════════════════════
  // 📊 ÖLÇÜM BAĞLANTISI — "bu ekran iş üretiyor mu?" (M1 · M2)
  // ══════════════════════════════════════════════════════════════════════════
  // Bir tasarım değişikliği "daha iyi oldu" diye İDDİA EDİLEMEZ, ölçülmesi
  // gerekir. Ölçülen asıl şey: sahip açıp KAPATIYOR mu, yoksa BİR İŞ mi yapıyor?
  //
  // ⚠️ Kuyruk render sırasında hesaplanıyor (erken çıkışların altında), ölçüm
  // kancası ise en üstte olmak zorunda (koşullu hook yasak). Köprü bir REF:
  // render kuyruğu ref'e yazar, effect BOYAMA SONRASI okur. State kullanılsaydı
  // her ölçüm bir yeniden-render doğururdu — ölçüm aleti ölçtüğü şeyi bozardı.
  const kuyrukRef = React.useRef(null);
  const oturumRef = React.useRef(null);
  const olculduRef = React.useRef(false);
  useEffect(() => {
    // ── ⚠️ ALETİN KENDİ KUSURU (canlıda yakalandı, düzeltildi) ──────────────
    // İlk sürümde her BAKIŞ açılışı İKİ oturum yazıyordu: `veri` iki kez
    // değişiyor (önce /panel demeti, sonra zincirli "dün" okuması) ve effect
    // ikisinde de ateşleniyordu. Sonuç: M2'nin (boş çıkış oranı) PAYDASI
    // şişerdi — sahip her seferinde iş yapsa bile oran "%50 boş çıkış" derdi.
    // Ölçüm aleti önce kendini denetler; tek ziyaret = tek oturum.
    if (gorunum !== 'karar') { olculduRef.current = false; return undefined; }
    if (!veri?.panel || olculduRef.current) return undefined;
    // ⚠️ DÜN OKUMASI BİTMEDEN ÖLÇME: kuyruğun "TEMA dün kapanmadı" maddesi dün
    // verisine dayanır. Erken ölçseydik o madde kuyrukta HİÇ görünmemiş gibi
    // kaydedilir, ömrü de isabeti de yanlış çıkardı. `dun` null iken bekleriz;
    // kapanış okuması düşmüşse zincir hiç çalışmaz, o hâlde de ölçeriz
    // (yoksa arıza günlerinde ölçüm tamamen susardı).
    if (veri.dun === null && veri.kapanis !== '__HATA__') return undefined;
    olculduRef.current = true;
    const k = kuyrukRef.current || { anahtar: [], sinif: [] };
    let iptal = false;
    // ⚠️ GÖVDE DÜZ NESNE VERİLİR, JSON.stringify EDİLMEZ: api() gövdeyi ZATEN
    // kendisi çeviriyor (utils/api.js — `body: opts.body ? JSON.stringify(...)`).
    // İki kez çevrilince sunucuya nesne değil METİN gider ve uç 422 döner.
    // Canlıda tam olarak bu oldu; ölçüm sessizce hiç yazmadı — ölçüm aletinin
    // kendi kendini denetlemesi bu yüzden şart (ucu ayrıca curl ile sınadık).
    api('/bakis-olcum/acilis', {
      method: 'POST',
      body: { gorunum, kuyruk: k.anahtar, kuyruk_sinif: k.sinif },
    })
      .then((r) => { if (!iptal) oturumRef.current = r?.oturum_id || null; })
      .catch(() => { /* ölçüm düşerse ekran çalışmaya devam eder */ });
    return () => { iptal = true; };
  }, [veri, gorunum]);

  /** İlk ANLAMLI eylemi bildirir. Sonraki tıklamalar sessiz — "ilk eyleme süre"
   *  ölçüyoruz; ikincisi ilkini ezseydi metrik sessizce başka şey ölçerdi. */
  const olcumEylem = (tur) => {
    const oid = oturumRef.current;
    if (!oid) return;
    oturumRef.current = null;
    api('/bakis-olcum/eylem', { method: 'POST', body: { oturum_id: oid, tur } })
      .catch(() => { /* sessiz */ });
  };

  const [gecmisOzet, setGecmisOzet] = useState(null);
  useEffect(() => {
    if (!veri?.panel) return;
    const kap = veri.kapanis;
    const bugunIso = kap && kap !== '__HATA__' ? String(kap.is_gunu_tr || '') : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bugunIso)) return;   // gün bilinmiyor → delta yok
    const od = Array.isArray(veri.panel.bugun_odemeler) ? veri.panel.bugun_odemeler : [];
    const gec = od.filter((u) => sayi(u.gun_farki) < 0);
    const nk = veri.nakit;
    const anlik = {
      tarih: bugunIso,
      gecikmisTl: gec.reduce((s, u) => s + odemeTutar(u), 0),
      gecikmisAdet: gec.length,
      kritikAdet: od.filter((u) => sayi(u.gun_farki) <= -15).length,
      mutTl: nk && nk !== '__HATA__' && nk.duraklar ? Math.abs(sayi(nk.mutabakatsiz_tl)) : null,
    };
    try {
      const ham = localStorage.getItem('evvelBakisOzet');
      const kayit = ham ? JSON.parse(ham) : null;
      // Gün döndüyse dünkü "bugun" artık "onceki" olur.
      let onceki = kayit?.onceki || null;
      if (kayit?.bugun?.tarih && kayit.bugun.tarih !== bugunIso) onceki = kayit.bugun;
      setGecmisOzet(onceki && onceki.tarih !== bugunIso ? onceki : null);
      localStorage.setItem('evvelBakisOzet', JSON.stringify({ bugun: anlik, onceki }));
    } catch { /* depolama kapalıysa delta yazılmaz — ekran çalışmaya devam eder */ }
  }, [veri]);

  // ════════════════════════ GÖRÜNÜM: ZAM TAKİBİ ═════════════════════════════
  // ⚠️ ERKEN ÇIKIŞLARIN ÜSTÜNDE — bilerek. Zam listesinin /panel ile HİÇBİR
  // ilgisi yok (kendi ucunu kendi çeker). Aşağıya konsaydı sekme, /panel
  // yüklenene kadar "Genel bakış yükleniyor…" gösterir; /panel düşerse de
  // hiç açılmazdı. Bir ekranın başka bir ekranın verisine rehin olmaması için
  // dal buraya alındı. (Hook'ların hepsi yukarıda — koşullu hook yok.)
  if (gorunum === 'zam') return <ZamTakibi onToast={onToast} onSayac={onZamSayac} />;

  if (hata && !veri) return <HataBandi mesaj={hata} onTekrar={yukle} />;
  if (!veri) {
    return (
      <div style={{ ...kartYuzey, padding: '40px 30px', textAlign: 'center', color: R.not, fontSize: 13 }}>
        Genel bakış yükleniyor…
      </div>
    );
  }

  const p = veri.panel;
  // /vadeli-alimlar/ozet — {toplam_odenen, toplam_bekleyen, bekleyen_adet, geciken_adet}
  const v = veri.vadeli;
  const uyarilar = Array.isArray(veri.uyarilar) ? veri.uyarilar : (veri.uyarilar?.uyarilar || []);
  const onaylar = (Array.isArray(veri.onaylar) ? veri.onaylar : [])
    .filter((o) => !String(o.islem_turu || '').toUpperCase().includes('KASA'));
  // ⬆️ (2026-08-14) `oneriler` bildirim görünümünün içinde tanımlıydı; Karar
  // alanındaki "Bugün ilk 3 iş" bandı da okuyor → tek yere, yukarı alındı.
  const oneriler = Array.isArray(p.oneriler) ? p.oneriler : [];

  // ── TRİAJ: gecikme GÜNÜNE göre (klasik panelin kaynak kuralı) ──────────────
  const odemeler = Array.isArray(p.bugun_odemeler) ? p.bugun_odemeler : [];
  const gK = odemeler.filter((u) => sayi(u.gun_farki) <= -15);
  const gU = odemeler.filter((u) => sayi(u.gun_farki) >= -14 && sayi(u.gun_farki) <= -8);
  const gB = odemeler.filter((u) => sayi(u.gun_farki) >= -7 && sayi(u.gun_farki) < 0);
  // 🔴 EVV-GENEL-N3 (2026-08-12 satır-satır denetim): "Bugün vadesi" YALNIZ gun_farki===0.
  // gun_farki = vade − bugün → gelecek ödeme POZİTİF (motors 981/986 "N gün kaldı/sonra");
  // eskiden gBug = gun_farki>=0 gelecekteki vadeleri de "bugün" sayıp bugünkü yükü şişiriyordu.
  const gBug = odemeler.filter((u) => sayi(u.gun_farki) === 0);
  const gYak = odemeler.filter((u) => sayi(u.gun_farki) > 0);
  // 🐞 CANLI DENETİM (2026-08-03): toplam `asgari_kalan` ile, satırlar `tutar`
  // ile sayıyordu — değişken giderde (asgari_kalan yok) KPI "8 kalem" deyip
  // 7 kalemin toplamını gösteriyordu. Aynı erişimci → sayı ve toplam aynı evren.
  // 🔴 EVV-GENEL-N1: TEK erişimci — satır (139) ve çekmece (151) AYNI fallback zincirini
  // kullansın (eskiden çekmece `?? asgari`'yi atlıyordu → satırda para, çekmecede 0).
  // (odemeTutar modül seviyesine taşındı — dosyanın başına bak.)
  const gecikmisTutar = odemeTutar;
  const gecikmisToplam = odemeler
    .filter((u) => sayi(u.gun_farki) < 0)
    .reduce((s, u) => s + gecikmisTutar(u), 0);

  // 🔵 (2026-08-14): satır başlığı ham sunucu metniydi ("Vadeli Alım: Fatura
  // NAZ2026… (DORUK AJANS MATBAACIL…") → 60 karakterde kesilince FİRMA ADI hiç
  // görünmüyordu. Artık firma başlıkta, fatura no alt satırda.
  const odemeSatiri = (u, i) => {
    const sadeAd = sadeOdemeAdi(u.ad || u.aciklama || u.tedarikci || 'Ödeme');
    return {
      id: u.id || `o-${i}`, _u: u,
      baslik: kisalt(sadeAd.baslik || 'Ödeme', 60),
      alt: [
        // Ham 'degisken' yerine "değişken gider" (Y5 dil turu) — sözlükte
        // olmayan tip ham geçer, uydurma çeviri yapılmaz.
        tipEtiket(u.tip),
        sadeAd.ek ? kisalt(sadeAd.ek, 46) : null,
        // 🔴 EVV-GENEL-N3: 3-yönlü — geçmiş (gecikti) · bugün · gelecek (N gün sonra).
        sayi(u.gun_farki) < 0 ? `${Math.abs(sayi(u.gun_farki))} gün gecikti`
          : sayi(u.gun_farki) === 0 ? 'bugün vadesi' : `${sayi(u.gun_farki)} gün sonra`,
      ].filter(Boolean).join(' · '),
      tutar: fmt(odemeTutar(u)),
      tier: sayi(u.gun_farki) <= -15 ? 'kritik' : sayi(u.gun_farki) <= -8 ? 'uyari' : sayi(u.gun_farki) < 0 ? 'bilgi' : 'iyi',
    };
  };

  /** Ödeme satırının BENZERSİZ kimliği (görüntü metni değil, kayıt kimliği).
   *  ⚠️ Sunucu bu satırlarda `id` GÖNDERMİYOR — alan adı `odeme_id` (motors.py:1259).
   *  Değişken gider satırlarında ise `odeme_id` bilerek NULL (motors.py:1388); orada
   *  kimlik kaynak_tablo+kaynak_id ikilisinde. Bu yüzden zincir: odeme_id → bileşik.
   *  Bileşik anahtar aynı render'daki iki farklı kaydı ayırmaya yeter (kaynak_id
   *  gider başına tekil; vade ve tutar da ayırıcı). */
  const kayitAnahtari = (u) => String(
    u.odeme_id
    || u.id
    || [u.kaynak_tablo || '?', u.kaynak_id || '?', u.kart_id || '?',
        u.tarih || '?', sayi(u.tutar)].join('|'),
  );

  /** 💰 ÖDEME KÖPRÜSÜ — TEK ÜRETİCİ (2026-08-15 canlı hata düzeltmesi).
   *
   * CANLI VAKA: "Sabit Gider: alsancak kira" çekmecesinden '💰 Ödeme yap' →
   * doğru ekrana inildi ama modal AÇILMADI, toast da ÇIKMADI (sessiz düşme).
   *
   * KÖK: kimlik TEK ANAHTARA (plan id) bağlanmıştı. Panelin ödeme satırları
   * TEK BİR ad uzayı kullanmıyor:
   *   · plan satırları      → `odeme_id` = odeme_plani.id            (motors.py:1272)
   *   · sabit/değişken gider→ `odeme_id` **NULL**, kimlik kaynak ikilisinde
   *                            (motors.py:1401 — planı olmayan gider)
   * `odeme_id` boş olunca köprü PARAMETRESİZ kuruluyor, hedef ekran hedefsiz
   * açılıyor ve akış hiçbir iz bırakmadan bitiyordu — aranan kalem listede
   * gözükse bile. (Aynı ders: "tek anahtar 'iz yok' yalanı".)
   *
   * ÇÖZÜM: kimlik BİLEŞİK taşınır. Plan id varsa o; yoksa kaynak ikilisi
   * `k~<tablo>~<id>` olarak gider ve hedef ekran her iki ad uzayında da arar.
   * '~' ayracı bilerek: köprü çözücüsü ':' ile parçalıyor, ayrac çakışmasın.
   *
   * ⚠️ VAAT-GERÇEK: hiçbir kimlik çıkmıyorsa AD DA değişmez ("Ödeme Merkezi'nde
   * aç") — "Ödeme yap" deyip genel listeye düşürmek sahibi kandırmaktır.
   */
  const odemeHedefi = (_u) => {
    const planId = String(_u.odeme_id || _u.id || '').trim();
    if (planId) {
      return { aksiyonAd: '💰 Ödeme yap',
        _hedef: `__modul:odeme:bekleyen:${encodeURIComponent(planId)}` };
    }
    const tablo = String(_u.kaynak_tablo || '').trim();
    const kid = String(_u.kaynak_id || '').trim();
    if (tablo && kid) {
      return { aksiyonAd: '💰 Ödeme yap',
        _hedef: `__modul:odeme:bekleyen:${encodeURIComponent(`k~${tablo}~${kid}`)}` };
    }
    return { aksiyonAd: 'Ödeme Merkezi\'nde aç', _hedef: '__modul:odeme:bekleyen' };
  };

  /** Çekmece gövdesi — `ek` ile iz/belgeler sonradan eklenebilsin diye fonksiyon.
   *  tip + baslik SABİT kalır: Cekmece sekme sıfırlaması [acik,tip,baslik]'e bağlı
   *  (parcalar.jsx:1319) → aynı değerlerle yeniden çağırınca sahip hangi sekmedeyse
   *  orada kalır, veri altına dolar. */
  const odemeCekmeceVeri = (_u, ek = {}) => ({
    tip: 'ÖDEME KAYDI',
    // Geç gelen iz/belge yanıtının hangi kayda ait olduğunu ayırt eden KİMLİK.
    // Başlık kimlik DEĞİLDİR: 60 karakterde kesilmiş görüntü metni, aynı bankanın
    // iki kartı gibi vakalarda birebir aynı çıkabilir → A'nın yanıtı B'ye basardı.
    // (TasarimV2 çekmece alanlarını tek tek okuyor, spread yok → bu alan ekrana
    // sızmaz; `_hedef` de aynı desende taşınıyor.)
    _kayitId: kayitAnahtari(_u),
    baslik: kisalt(sadeOdemeAdi(_u.ad || _u.aciklama || 'Ödeme').baslik || 'Ödeme', 60),
    alt: sayi(_u.gun_farki) < 0 ? `${Math.abs(sayi(_u.gun_farki))} gün gecikti`
      : sayi(_u.gun_farki) === 0 ? 'bugün vadesi' : `${sayi(_u.gun_farki)} gün sonra`,
    // Sahip düzeltmesi (2026-08-03): boş alanı GİZLEMEK yerine DOLDUR.
    // Satırda `tip`/`ad` yok ama kaynak_tablo + tarih + seviye VAR — tür
    // kaynaktan türetilir, vade tarihi ve seviye de çekmeceye girer.
    kpi: [
      { etiket: 'Tutar', deger: fmt(odemeTutar(_u)), renk: R.kirmizi },
      { etiket: 'Gecikme', deger: sayi(_u.gun_farki) < 0 ? `${Math.abs(sayi(_u.gun_farki))} gün` : 'yok', renk: sayi(_u.gun_farki) < 0 ? R.kirmizi : R.yesil },
      {
        etiket: 'Tür',
        deger: tipEtiket(_u.tip)
          || ({ vadeli_alimlar: 'Vadeli alım', sabit_giderler: 'Sabit gider', kartlar: 'Kart ekstresi',
               borc_envanteri: 'Kredi taksiti', cari_odeme: 'Cari ödeme', degisken: 'Değişken gider' }[_u.kaynak_tablo]
             || (_u.kart_id ? 'Kart ekstresi' : 'Ödeme planı')),
      },
      ...(_u.seviye ? [{
        etiket: 'Seviye', deger: String(_u.seviye),
        renk: String(_u.seviye).toUpperCase() === 'KRITIK' ? R.kirmizi : R.amber,
      }] : []),
    ],
    listeBaslik: 'Kayıt',
    satirlar: [
      // 🔴 TAŞMA DÜZELTMESİ (2026-08-14, canlı ölçüm: içerik 448px panelde 569px):
      // ham ad `tutar` alanına basılıyordu, o alan mono + nowrap → 70 karakter tek
      // satırda 525px sürüyordu. Ham ad artık `detay`da: 11px, sarabilen alan.
      // Bilgi kaybı yok — tam hâliyle duruyor, sadece doğru sütunda.
      {
        ad: 'Kaydın tam adı',
        detay: kisalt(_u.ad || _u.aciklama || '—', 110),
        tutar: '',
      },
      ...(_u.kaynak_tablo ? [{ ad: 'Kaynak', detay: 'kaydı üreten defter', tutar: String(_u.kaynak_tablo) }] : []),
      ...(_u.tarih ? [{ ad: 'Vade tarihi', detay: 'planlanan ödeme günü', tutar: String(_u.tarih).slice(0, 10) }] : []),
      { ad: 'Asgari kalan', detay: 'ödenmesi gereken', tutar: fmt(sayi(_u.asgari_kalan ?? _u.asgari ?? _u.tutar)) },
    ],
    not: '🔒 Salt-okunur — ödeme Ödeme Merkezi\'nden yapılır.',
    ...odemeHedefi(_u),
    // 🔗 Kayıt bir TEDARİKÇİ taşıyorsa cari ekstresine parametreli köprü.
    // Ad çıkarılamıyorsa aksiyon üretilmez → tek düğmeli eski hâl korunur
    // (işlevsiz düğme göstermeyiz).
    ...(cariEkstreAksiyonu({ kayit: _u, onKopru })
      ? {
        aksiyonlar: [
          // 🔴 CANLI HATA (2026-08-15): bu dal ESKİ parametresiz köprüyü sabit
          // yazıyordu. Tedarikçisi olan HER kayıtta (Cekmece `aksiyonlar` varsa
          // `aksiyonAd`ı göstermiyor) doğrudan iniş sessizce KAYBOLUYORDU —
          // aynı hedef iki yerde ayrı ayrı kurulduğu için biri güncellendi,
          // diğeri kaldı. Artık İKİSİ DE tek üreticiden (`odemeHedefi`) besleniyor.
          {
            ad: odemeHedefi(_u).aksiyonAd,
            birincil: true,
            onTikla: () => onKopru?.(odemeHedefi(_u)._hedef),
          },
          cariEkstreAksiyonu({ kayit: _u, onKopru }),
        ],
      }
      : {}),
    ...ek,
  });

  /** 💳 KAYIT ZENGİNLEŞTİRME (sahip 2026-08-14: "o karta yapılmış ödemeler
   *  görünebilir", "bu ayın ekstresi direkt görülebilir"). Çekmecenin İz ve
   *  Belgeler sekmeleri tasarımda vardı ama veri geçilmiyordu → hep boş açılıyordu.
   *  Çekmece ÖNCE açılır (bekleme yok), veri arkadan gelir.
   *  Bu kaydın kaynak ikilisi — kart planlarında kimlik kart_id'dir.
   *  İz/belge çekme ve merge mantığı ./kayitDosyasi'nda (tek yer, 4 modül ortak). */
  const kayitBagi = (_u) => {
    const tablo = _u.kaynak_tablo || (_u.kart_id ? 'kartlar' : null);
    const kid = (tablo === 'kartlar') ? (_u.kart_id || _u.kaynak_id) : _u.kaynak_id;
    return {
      onCekmece, tip: 'ÖDEME KAYDI',
      kaynakTablo: tablo, kaynakId: kid,
      kayitId: kayitAnahtari(_u), renkler: { kirmizi: R.kirmizi, amber: R.amber },
    };
  };

  const odemeCekmece = ({ _u }) => {
    const bag = kayitBagi(_u);
    onCekmece?.(odemeCekmeceVeri(_u, { belgeYukle: belgeYukleyiciUret(bag) }));
    kayitDosyasiYukle(bag);
  };

  // ── 💰 KASA ÇEKMECESİ (2026-08-17) ───────────────────────────────────────
  // Sahip: "merkez gösterimde TOPLAM kasayı görmeliyim ama :)) ve kasaya
  // tıkladığımda AYRIMLARI görebilmeliyim."
  // Kaynak /api/kasa-defteri — 2026-08-17'de tam bu ihtiyaç için açıldı:
  // öncesinde kasayı uçtan uca okuyan uç YOKTU (/kasa sabit LIMIT 100), o
  // yüzden hiçbir ekran kırılımı dürüstçe gösteremiyordu.
  // ⛔ Burada HİÇBİR rakam yeniden hesaplanmaz — 17 farklı borç formülü
  //    kusurunun kart tarafındaki dersi: gösterim kendi aritmetiğini kurmaz.
  const SUBE_ADI = { 'sube-zafer': 'ZAFER', 'sube-tema': 'TEMA',
    'sube-koycegiz': 'KÖYCEĞİZ', 'sube-alsancak': 'ALSANCAK',
    '(atanmamış)': 'Merkez (şube dışı)' };

  // ══════════════════════════════════════════════════════════════════════════
  // 🚪 KASA · İKİNCİ KATMAN (2026-08-26) — "şu satırın içinde ne var?"
  // ══════════════════════════════════════════════════════════════════════════
  // Çekmece bugüne dek ÇIKMAZ SOKAKTI: şube bakiyesini görüyordun ama o
  // bakiyeyi oluşturan hareketleri göremiyordun. "ZAFER 12.065 ₺" bir cevap
  // değil, bir SORUDUR — hangi hareketlerden oluştu?
  //
  // ⚠️ YALANCI KAPI KURULMADI: bu katman /api/kasa-defteri'nin ZATEN VAR OLAN
  // `sube_id` ve `islem_turu` filtrelerini kullanır. Veri kaynağı olmayan bir
  // satır kapı YAPILMAZ — tıklanıp boş açılan kapı, bugünkü dürüst çıkmaz
  // sokaktan daha kötüdür.
  //
  // ⛔ HİÇBİR RAKAM YENİDEN HESAPLANMAZ: uç ne dönerse o yazılır.
  const kasaDetayAc = async ({ baslik, sube_id, islem_turu, altBilgi, geriHedef }) => {
    // BOYUT 300: canlıda ZAFER kasası 282 hareket — 120'de "162 tanesi bu
    // listede yok" yazıyordu. Dürüsttü ama işe yaramıyordu: sahip yarısını
    // göremediği bir listeyle hüküm veremez. 300 en kalabalık kasayı da
    // kapsıyor; taşarsa kaç satırın dışarıda kaldığı YİNE yazılır (uç `kalan`
    // döndürüyor — sessiz eleme yasak).
    const sorgu = new URLSearchParams({ boyut: '300' });
    if (sube_id) sorgu.set('sube_id', sube_id);
    if (islem_turu) sorgu.set('islem_turu', islem_turu);
    // Geri yolu ÇAĞIRANA aittir: aynı hareket listesine hem KASA çekmecesinden
    // hem "param nerede?" çekmecesinden girilebiliyor. Sabit bir geri koysaydım
    // kullanıcı girmediği kapıdan çıkardı.
    const geri = geriHedef || { ad: 'Kasa · toplam ve ayrımlar', onTikla: () => kasaCekmecesiniAc() };
    onCekmece?.({ tip: 'KASA HAREKETLERİ', baslik, alt: 'yükleniyor…', satirlar: [], geri });
    try {
      const d = await api(`/kasa-defteri?${sorgu.toString()}`);
      const oz = d?.ozet || {};
      const satirlar = (d?.satirlar || []).map((h) => ({
        ad: kisalt(String(h.aciklama || h.islem_turu || '—'), 58),
        // Kasayı OYNATMAYAN satır (DEVIR, ODEME_PLANI…) defterde durur ama
        // bakiyeye girmez. Karışırsa "kasa tutmuyor" diye sahte alarm doğar —
        // o yüzden satırın kendisinde SÖYLENİR.
        detay: [
          kisaGun(h.tarih),
          h.islem_turu,
          h.kasa_etkisi === false ? '⚠ kasayı oynatmaz' : null,
        ].filter(Boolean).join(' · '),
        tutar: fmt(sayi(h.tutar)),
      }));
      onCekmece?.({
        tip: 'KASA HAREKETLERİ',
        baslik,
        // SESSİZ ELEME YASAK: kaç satır dışarıda kaldığı SÖYLENİR.
        alt: [altBilgi, `${sayi(d?.toplam)} hareket`,
          sayi(d?.kalan) > 0 ? `${sayi(d.kalan)} tanesi bu listede yok` : null,
        ].filter(Boolean).join(' · '),
        kpi: [
          { etiket: 'Net', deger: fmt(sayi(oz.net)), renk: sayi(oz.net) >= 0 ? R.yesil : R.kirmizi },
          { etiket: 'Giriş', deger: fmt(sayi(oz.giris)), renk: R.yesil },
          { etiket: 'Çıkış', deger: fmt(sayi(oz.cikis)), renk: R.kirmizi },
        ],
        listeBaslik: 'Hareketler · yeniden eskiye',
        satirlar,
        not: sayi(oz.kasa_etkisiz_adet) > 0
          ? `${sayi(oz.kasa_etkisiz_adet)} hareket defterde duruyor ama kasa bakiyesini `
            + `oynatmıyor (toplam ${fmt(sayi(oz.kasa_etkisiz_toplam))}) — devir/plan kayıtları. `
            + 'Net rakamına dahil değiller.'
          : null,
        geri,
      });
    } catch (e) {
      onCekmece?.({
        tip: 'KASA HAREKETLERİ', baslik, alt: 'hareketler alınamadı', satirlar: [],
        not: `Okunamadı: ${e?.message || 'bilinmeyen hata'}. Rakam uydurulmadı.`,
        geri,
      });
    }
  };

  const kasaCekmecesiniAc = async () => {
    // Önce iskeleti aç — veri gelene kadar boş ekran yerine "yükleniyor".
    onCekmece?.({
      tip: 'KASA', baslik: 'Kasa · toplam ve ayrımlar',
      alt: 'yükleniyor…', satirlar: [],
    });
    try {
      const [d, bm] = await Promise.all([
        api('/kasa-defteri?boyut=1'),          // yalnız özet+kırılım lazım
        api('/banka-mutabakat').catch(() => null),
      ]);
      const oz = d?.ozet || {};
      const subeler = (d?.sube_kirilim || [])
        .map((r) => ({
          ad: SUBE_ADI[r.sube] || r.sube,
          // 🚪 Ham anahtar KORUNUR — ikinci katman /kasa-defteri'ye bunu geçer.
          // Ekran adı ("ZAFER") ile filtre anahtarı ("sube-zafer") farklı şeyler;
          // ekran adını filtreye yollamak sessizce BOŞ liste getirirdi.
          anahtar: r.sube,
          bakiye: sayi(r.giris) - sayi(r.cikis),
          adet: sayi(r.adet),
        }))
        .sort((a, b) => b.bakiye - a.bakiye);

      // Türler: en çok para hareketi olan 8 tür (çıkış ağırlıklı sıralı)
      const turler = (d?.tur_kirilim || [])
        .map((r) => ({ ad: r.islem_turu, cikis: sayi(r.cikis), giris: sayi(r.giris), adet: sayi(r.adet), subesiz: sayi(r.subesiz) }))
        .sort((a, b) => (b.cikis + b.giris) - (a.cikis + a.giris))
        .slice(0, 8);

      const satirlar = [
        ...subeler.map((s) => ({
          ad: s.ad,
          // ⚠️ Eksi bakiye gerçek hayatta olamaz (para yoksa ödeme yapılamaz) —
          // sessiz geçilmez. Uyarı `detay`e yazılır çünkü çekmece satırı `rozet`
          // alanını RENDER ETMİYOR (parcalar.jsx: yalnız ad/detay/tutar) —
          // rozet olarak koysaydım işaret sessizce yok olurdu.
          detay: s.bakiye < 0
            ? `${s.adet} hareket · ⚠ eksi bakiye — kasa eksiye düşemez`
            : `${s.adet} hareket`,
          tutar: fmt(s.bakiye),
          // 🚪 KAPI: bu bakiyeyi oluşturan hareketler
          onTikla: () => kasaDetayAc({
            baslik: `${s.ad} · kasa hareketleri`,
            sube_id: s.anahtar,
            altBilgi: `bakiye ${fmt(s.bakiye)}`,
          }),
        })),
        { ad: '───────────', detay: '', tutar: '' },
        ...turler.map((t) => ({
          ad: t.ad,
          detay: `${t.adet} hareket${t.subesiz ? ` · ${t.subesiz} tanesi şubesiz` : ''}`,
          tutar: t.cikis > t.giris ? `−${fmt(t.cikis)}` : fmt(t.giris),
          // 🚪 KAPI: bu türdeki hareketler (tüm şubeler)
          onTikla: () => kasaDetayAc({
            baslik: `${t.ad} · kasa hareketleri`,
            islem_turu: t.ad,
            altBilgi: 'tüm şubeler',
          }),
        })),
      ];

      const kpi = [
        { etiket: 'Toplam kasa', deger: fmt(sayi(oz.net)), renk: sayi(oz.net) >= 0 ? R.yesil : R.kirmizi },
        { etiket: 'Giriş', deger: fmt(sayi(oz.giris)), renk: R.yesil },
        { etiket: 'Çıkış', deger: fmt(sayi(oz.cikis)), renk: R.kirmizi },
        {
          etiket: 'Şubesiz hareket',
          deger: String(sayi(oz.subesiz_adet)),
          renk: sayi(oz.subesiz_adet) > 0 ? R.amber : R.yesil,
        },
      ];

      // Teslim → banka akışı: ZATEN VAR OLAN /banka-mutabakat'tan okunur,
      // burada yeniden kurulmaz. Uç düşerse bölüm sessizce kaybolmaz — not'ta
      // neden görünmediği yazar (HATA ≠ BOŞ).
      const akis = bm
        ? `Teslim→banka (${bm.donem}): alınan ${fmt(sayi(bm.donem_teslim))} · `
          + `bankaya yatan ${fmt(sayi(bm.donem_yatan))} · fark ${fmt(sayi(bm.donem_fark))}. `
          + `Ödemelerin %${sayi(bm.siniflama_pct).toFixed(1)}'inde elden/havale yazıyor — `
          + `kalanı «belirsiz», o yüzden elde nakit kesin hesaplanamıyor.`
        : 'Teslim→banka akışı okunamadı (/banka-mutabakat yanıt vermedi).';

      onCekmece?.({
        tip: 'KASA',
        baslik: 'Kasa · toplam ve ayrımlar',
        alt: `${sayi(d?.toplam)} hareket · merkez = şube kasalarının toplamı`,
        kpi,
        listeBaslik: 'Kasa bazında · sonra işlem türü',
        satirlar,
        not: akis,
      });
    } catch (e) {
      onCekmece?.({
        tip: 'KASA', baslik: 'Kasa · toplam ve ayrımlar',
        alt: 'ayrım alınamadı',
        satirlar: [],
        not: `Kırılım okunamadı: ${e?.message || 'bilinmeyen hata'}. `
           + 'Rakam uydurulmadı — uç düzelince ayrım burada görünecek.',
      });
    }
  };

  // ════════════════════════ GÖRÜNÜM: KARAR ALANI ════════════════════════════
  if (gorunum === 'karar') {
    // ─────────────────────────────────────────────────────────────────────────
    // 🎨 SAF SUNUM YENİDEN-DÜZENİ (2026-08-16). Sahip: "amatör, düzensiz".
    //
    // ESKİ HÂL: 5 KPI + ilk-3-iş bandı + 5 katmanın TAMAMI açık düz liste →
    // canlıda 117 metin satırlık tek kaydırma. Ekranda "ne yapmalıyım" ile
    // "arşivde ne var" aynı görsel ağırlıktaydı.
    //
    // YENİ HÂL (veri/uç/davranış AYNEN korunur — yalnız yerleşim ve dil):
    //   Y1 · 4'lü kompakt durum şeridi + iki kolon (sol %60 işler / sağ %36 risk)
    //   Y2 · her katman VARSAYILAN tek "dürüst özet" satırı, yerinde açılır
    //   Y3 · genişletilmiş listede küçük kalemler ŞUBE altında toplanır
    //   Y4 · ilk-3-iş'te görünen kalem listede SOLGUN + etiketli (DÜŞÜRÜLMEZ)
    //   Y5 · sadeOdemeAdi her yerde · emoji → IK ikonları · tipografik rütbe
    //
    // ⛔ DOKUNULMAYANLAR: triaj eşikleri (gK/gU/gB/gBug/gYak), odemeTutar
    // fallback zinciri, odemeCekmece + odemeHedefi köprüsü, ilk-3-iş seçim
    // kuralları. Bu blokta TEK BİR yeni sayı türetilmedi.
    // ─────────────────────────────────────────────────────────────────────────

    // "48 saatlik yük": bugün (0) + yarın (1) vadesi olan kalemlerin toplamı.
    // Bugün kasadan çıkacak parayı planlarken yarını da görmek gerekir.
    const gYarin = odemeler.filter((u) => sayi(u.gun_farki) === 0 || sayi(u.gun_farki) === 1);
    const t48 = gYarin.reduce((s, u) => s + odemeTutar(u), 0);
    const gBugToplam = gBug.reduce((s, u) => s + odemeTutar(u), 0);
    // Ödeme baskısı hiç yoksa katman yerine tek net cümle gösterilir.
    const baskiYok = (gK.length + gU.length + gB.length + gBug.length) === 0;

    // ── BUGÜN İLK 3 İŞ ───────────────────────────────────────────────────────
    // Sahip ekranı açtığında "önce neye bakayım?" sorusunun cevabı. Uydurma yok:
    // üç madde de aynı veriden türer; madde üretecek veri yoksa madde yazılmaz.
    // 🔵 (2026-08-16) İKİ SUNUM EKİ — seçim kuralları AYNI:
    //   · `ikonYol`: emoji (🔴📅🔔🧠) yerine tema IK seti
    //   · `_u`: maddenin dayandığı KAYIT — aşağıda tekrar-soluklaştırma (Y4) ve
    //     kart üstündeki doğrudan aksiyon adı bundan türer.
    const ilkUcIs = (() => {
      const isler = [];
      const gecikmisSirali = odemeler
        .filter((u) => sayi(u.gun_farki) < 0)
        .sort((a, b) => odemeTutar(b) - odemeTutar(a));
      const enBuyuk = gecikmisSirali[0];
      if (enBuyuk) {
        const ad = sadeOdemeAdi(enBuyuk.ad || enBuyuk.aciklama || 'Ödeme');
        isler.push({
          k: 'gecikmis', ikonYol: IK.uyari, renk: R.kirmizi, _u: enBuyuk,
          metin: `${kisalt(ad.baslik, 38)} — ${fmt(odemeTutar(enBuyuk))}`,
          alt: `${Math.abs(sayi(enBuyuk.gun_farki))} gün gecikti · en büyük gecikmiş kalem`,
          aksiyonAd: 'Ödeme dosyasını aç',
          onTikla: () => odemeCekmece({ _u: enBuyuk }),
        });
      }
      if (t48 > 0) {
        isler.push({
          k: 'yuk48', ikonYol: IK.takvim, renk: R.amber,
          metin: `Bugün/yarın çıkacak: ${fmt(t48)}`,
          alt: `${gYarin.length} kalem · 48 saatlik nakit yükü`,
        });
      } else if (gYak.length) {
        const enYakin = [...gYak].sort((a, b) => sayi(a.gun_farki) - sayi(b.gun_farki))[0];
        const ad2 = sadeOdemeAdi(enYakin.ad || enYakin.aciklama || 'Ödeme');
        isler.push({
          k: 'yuk48', ikonYol: IK.takvim, renk: R.mavi, _u: enYakin,
          metin: `En yakın vade: ${kisalt(ad2.baslik, 32)} — ${fmt(odemeTutar(enYakin))}`,
          alt: `${sayi(enYakin.gun_farki)} gün sonra · bugün/yarın ödeme yok`,
          aksiyonAd: 'Ödeme dosyasını aç',
          onTikla: () => odemeCekmece({ _u: enYakin }),
        });
      }
      if (onaylar.length > 0) {
        isler.push({
          k: 'onay', ikonYol: IK.onay, renk: R.amber,
          metin: `${onaylar.length} onay bekliyor`,
          alt: 'karar verilmedikçe kayıt işlenmez',
          aksiyonAd: 'Onay Kuyruğu\'na git',
          onTikla: () => onKopru?.('__modul:onaylar:kuyruk'),
        });
      } else if (oneriler.length > 0) {
        isler.push({
          k: 'oneri', ikonYol: IK.islemci, renk: R.bakir,
          metin: `Karar motorunda ${oneriler.length} öneri`,
          alt: 'öneri-only · hüküm insanın',
          aksiyonAd: 'Motor & Bildirimler',
          onTikla: () => onKopru?.('__gorunum:bildirim'),
        });
      }
      return isler;
    })();

    // Y4 — TEKRAR KURALI: ilk-3-iş'te GÖRÜNEN kaydın kimlikleri.
    // ⚠️ Bu kayıtlar katman listesinden DÜŞÜRÜLMEZ; düşürülseydi katman
    // sayacı/toplamı ile liste birbirini tutmaz, sahip "9 kalem" deyip 8 satır
    // görürdü. Yalnız soluklaştırılıp "yukarıda gördün" diye etiketlenir.
    // 🔵 (2026-08-26) Küme ARTIK BOŞ DOĞAR, kuyruk kurulunca doldurulur (aşağıda
    // `kuyrukGorunen` tanımının hemen ardında). Sebep: madde kaynağı `ilkUcIs`
    // değil artık BUGÜN KUYRUĞU ve kuyruk 5'te kesiliyor — eskisi gibi ilkUcIs'ten
    // türetilseydi, kesilip EKRANDA GÖRÜNMEYEN bir kalem listede "↑ bugünün
    // işlerinde" diye solgun etiketlenirdi. Sahip yukarı bakar, o kalemi bulamaz.
    // Etiket yalnız GERÇEKTEN GÖRÜNEN kalem için doğrudur.
    // (Set nesnesi değişmez, İÇERİĞİ dolar — `const` doğru.)
    const heroAnahtarlar = new Set();
    const katmanSatiri = (u, i) => {
      const s = odemeSatiri(u, i);
      if (!heroAnahtarlar.has(kayitAnahtari(u))) return s;
      return { ...s, solgun: true, rozet: '↑ bugünün işlerinde', rozetRenk: R.bakir };
    };

    // ── Y3: ŞUBE GRUPLAMA ────────────────────────────────────────────────────
    // EŞİK NEDEN 12.000 ₺: canlıda şube faturaları (elektrik/su/genel/internet)
    // 1.500–9.000 ₺ bandında; kira ve tedarikçi faturaları 15.000 ₺ üstünde
    // duruyor. 12.000 bu iki kümenin arasındaki boşluk — eşik ÜSTÜ hiçbir kalem
    // gruba girmez, yani "büyük para" her zaman tek başına ve adıyla görünür.
    // Eşiği yükseltmek gerçek karar kalemlerini gizler; düşürmek gruplamayı
    // etkisizleştirir (ikisinin de bedeli asimetrik: gizlemek daha pahalı).
    const GRUP_ESIK = 12000;
    const gruplanabilir = (u) => {
      const kt = String(u.kaynak_tablo || '');
      // ⛔ Tedarikçi faturaları ASLA gruplanmaz — onlar KARAR kalemidir,
      // "ALSANCAK — 2 fatura" diye toplanırsa kimin parası olduğu kaybolur.
      if (kt === 'vadeli_alimlar') return false;
      const kucukKaynak = kt === 'sabit_giderler' || kt === 'anlik_giderler'
        || trKucuk(u.tip) === 'degisken';
      return kucukKaynak && odemeTutar(u) < GRUP_ESIK && !!kayitSubesi(u);
    };
    /** Grubun içindekileri tarif eden 3 anahtar kelime (kategori → yoksa 2. kelime). */
    const grupKelimeleri = (liste) => {
      const kel = [];
      liste.forEach((u) => {
        const ham = String(u.kategori || '').trim()
          || (String(u.ad || u.aciklama || '').trim().split(AYIRAC_RE).filter(Boolean)[1] || '');
        const s = trKucuk(ham).trim();
        if (s && !kel.includes(s)) kel.push(s);
      });
      return kel.slice(0, 3).join(' + ');
    };
    /** Kova → { gruplar, tekil }. Grup en az 2 kalemle kurulur (tek kalemlik
     *  "grup" bir kademe fazla tıklama demektir, bilgi kazancı yoktur). */
    const kovaGorunumu = (kayitlar) => {
      const kutu = new Map();
      const tekil = [];
      kayitlar.forEach((u) => {
        if (!gruplanabilir(u)) { tekil.push(u); return; }
        const s = kayitSubesi(u);
        if (!kutu.has(s)) kutu.set(s, []);
        kutu.get(s).push(u);
      });
      const gruplar = [];
      kutu.forEach((liste, sube) => {
        if (liste.length < 2) { tekil.push(...liste); return; }
        gruplar.push({
          sube,
          kayitlar: [...liste].sort((a, b) => odemeTutar(b) - odemeTutar(a)),
          toplam: liste.reduce((s, u) => s + odemeTutar(u), 0),
          kelimeler: grupKelimeleri(liste),
        });
      });
      return {
        gruplar: gruplar.sort((a, b) => b.toplam - a.toplam),
        tekil: tekil.sort((a, b) => odemeTutar(b) - odemeTutar(a)),
      };
    };

    // ── Y2: KATMAN ÖZETİ ─────────────────────────────────────────────────────
    // Kapalı satır 4 gerçeği taşır: ADET · TOPLAM · EN BÜYÜK KALEM · VADE UCU.
    const katmanOzeti = (kayitlar) => {
      const toplam = kayitlar.reduce((s, u) => s + odemeTutar(u), 0);
      const enBuyuk = kayitlar.reduce((a, b) => (odemeTutar(b) > odemeTutar(a) ? b : a));
      const enBuyukAd = sadeOdemeAdi(enBuyuk.ad || enBuyuk.aciklama || 'Ödeme').baslik;
      const gunler = kayitlar.map((u) => sayi(u.gun_farki));
      const enEski = Math.min(...gunler);
      const gelecek = gunler.filter((g) => g > 0);
      return {
        adet: kayitlar.length,
        toplam: fmt(toplam),
        // TAM hâl ipucunda (firma adı 26 karaktere kadar) …
        enBuyukMetin: `en büyüğü ${kisalt(enBuyukAd, 26)} ${fmt(odemeTutar(enBuyuk))}`,
        // … KISA hâl EKRANDA (Codex kritiği: "en büyük"ü hover'a saklamak
        // dürüstlük ilkesini çiğner — tutar görünür kalmalı).
        enBuyukKisa: `en büyük ${kisaPara(odemeTutar(enBuyuk))}`,
        vadeMetni: enEski < 0 ? `en eskisi ${Math.abs(enEski)} gün`
          : gelecek.length ? `en yakını ${Math.min(...gelecek)} gün sonra`
            : 'hepsi bugün vadeli',
        // Çip tek satırlık; gün bilgisi "68g" gibi kısalır (kovanın kendi
        // başlığı zaten "15+ gün gecikmiş" diyor, birim belirsiz kalmaz).
        vadeKisa: enEski < 0 ? `${Math.abs(enEski)}g`
          : gelecek.length ? `+${Math.min(...gelecek)}g`
            : 'bugün',
      };
    };

    // Katman sırası klasik triajın kendisi. BOŞ KATMAN HİÇ ÇİZİLMEZ (eskiden
    // "Bu katmanda kayıt yok" kutusu ekranı dolduruyordu).
    const katmanlar = [
      // ══════════════════════════════════════════════════════════════════════
      // 🎨 RENK RAMPASI (2026-08-26 BAKIŞ kurgusu) — sıcaktan soğuğa, aciliyetle
      // ══════════════════════════════════════════════════════════════════════
      // ESKİ HÂLİN KUSURU: "BİLGİ · 0–7 gün" MAVİYDİ — en büyük para, en sakin
      // etiket. Canlı ölçüm: kritik 186.021 ₺ (kırmızı) · uyarı 169.205 ₺ (amber)
      // · bu kova 1.078.718 ₺ (mavi). Yani gecikmiş borcun %75'i "BİLGİ" adıyla
      // ve ekranın en sakin rengiyle duruyordu. "Bilgi" kelimesi "okumasan da
      // olur" çerçevesi kurar; gecikmiş para hiçbir zaman bilgi değildir —
      // TAZE bir borçtur ve tazeyken kapatmak en ucuzudur.
      //
      // ⚠️ Tek satırı amber yapmak YETMEZDİ: UYARI da amberdi, iki kova aynı
      // renge düşüp ayrım bozulurdu. O yüzden RAMPANIN TAMAMI kuruldu —
      // gecikmişler sıcak uçta üç ayrı kademe, gecikmemişler soğuk uçta:
      //
      //   GECİKMİŞ  15+ gün → kırmızı   (kronik)
      //   GECİKMİŞ  8–14    → amber     (yerleşiyor)
      //   GECİKMİŞ  0–7     → bakır     (taze — hâlâ sıcak, ama en düşük kademe)
      //   ───────────────── gecikme çizgisi ─────────────────
      //   BUGÜN vadeli      → krem      (geç değil, olağan iş)
      //   YAKLAŞAN gelecek  → mavi      (sakin — mavinin DOĞRU yeri burası)
      { anahtar: 'kritik', baslik: 'KRİTİK · 15+ gün gecikmiş', renk: R.kirmizi, kayitlar: gK },
      { anahtar: 'uyari', baslik: 'UYARI · 8–14 gün gecikmiş', renk: R.amber, kayitlar: gU },
      { anahtar: 'bilgi', baslik: 'TAZE GECİKME · 0–7 gün — büyümeden kapat', renk: R.bakir, kayitlar: gB },
      { anahtar: 'bugun', baslik: 'BUGÜN vadesi gelen', renk: R.krem, kayitlar: gBug },
      { anahtar: 'yaklasan', baslik: 'YAKLAŞAN · henüz vadesi gelmedi', renk: R.mavi, kayitlar: gYak },
    ].filter((k) => k.kayitlar.length > 0);

    const katmanIcerigi = (anahtar, kayitlar) => {
      const { gruplar, tekil } = kovaGorunumu(kayitlar);
      return (
        <>
          {gruplar.map((g) => {
            const gA = `${anahtar}|${g.sube}`;
            return (
              <SubeGrubu
                key={gA}
                sube={g.sube}
                adet={g.kayitlar.length}
                toplam={fmt(g.toplam)}
                kelimeler={g.kelimeler}
                acik={!!acikGrup[gA]}
                onAc={() => setAcikGrup((s) => ({ ...s, [gA]: !s[gA] }))}
                cocuk={<Liste satirlar={g.kayitlar.map(katmanSatiri)} onAc={odemeCekmece} />}
              />
            );
          })}
          {tekil.length > 0 && <Liste satirlar={tekil.map(katmanSatiri)} onAc={odemeCekmece} />}
        </>
      );
    };

    // ── Vadeli alım: KPI kartıydı, artık sağ kolonda köprü çipi (Y1) ─────────
    // Hedef DOĞRULANDI: MODULLER'de odeme modülünün 'tedarikci' görünümü var
    // (tema.js:206) ve o ekran "Bekleyen vade sözü" toplamını gösteriyor
    // (OdemeModulu.jsx:2023) — yani çipin vaadi ile iniş yeri aynı sayı.
    const vRenk = sayi(v?.geciken_adet) ? R.kirmizi : sayi(v?.bekleyen_adet) ? R.amber : R.yesil;
    const vAlt = v
      ? (sayi(v.geciken_adet)
        ? `${sayi(v.geciken_adet)} sözün vadesi geçti · bekleyen ${fmt(sayi(v.toplam_bekleyen))}`
        : `bekleyen ${fmt(sayi(v.toplam_bekleyen))} · bu ay ödenen ${fmt(sayi(v.toplam_odenen))}`)
      : 'veri yok';

    // ═════════ B1 — ŞUBE IŞIKLARI (sabahın ilk sorusu) ═══════════════════════
    // Kaynaklar: /ops/kapanis-takip (bugün) · aynı uç ?tarih=dün · /subeler.
    // Kart listesini /subeler SÜRÜKLER: sezon-kapalı şube kapanis-takip'te de
    // görünür (aktif=TRUE) ama sezon bayrağı YALNIZ /subeler'de var; ikisi
    // birleşmezse kapalı dükkân "açılmadı · geç" diye kırmızı yanardı.
    const kapanisHam = veri.kapanis;
    const kapanisHata = kapanisHam === '__HATA__' || !kapanisHam;
    const bugunSatir = new Map(
      (kapanisHata ? [] : (kapanisHam.satirlar || [])).map((r) => [String(r.sube_id), r]),
    );
    const dunHam = veri.dun;
    // 3 hâl AYRI: yükleniyor (null) · okuma düştü ('__HATA__') · geldi.
    const dunBilinmiyor = !dunHam || dunHam === '__HATA__';
    const dunSatir = new Map(
      (dunBilinmiyor ? [] : (dunHam.satirlar || [])).map((r) => [String(r.sube_id), r]),
    );
    const subeTanim = Array.isArray(veri.subeler) ? veri.subeler : null;
    const subeListesi = subeTanim
      ? subeTanim.filter((s) => s.aktif !== false).map((s) => ({ id: String(s.id), ad: s.ad, tanim: s }))
      // /subeler düştüyse kapanış satırlarına düşülür — sezon bilgisi olmadan
      // (bilmediğimiz şeyi "sezon kapalı" diye boyamayız).
      : (kapanisHata ? [] : (kapanisHam.satirlar || []).map((r) => ({ id: String(r.sube_id), ad: r.sube_adi, tanim: null })));
    const simdiDk = trSimdiDk();
    const subeKartlari = subeListesi.map((s) => {
      const satir = bugunSatir.get(s.id) || null;
      const isik = subeIsigi({
        satir, tanim: s.tanim, dunSatir: dunSatir.get(s.id) || null, dunBilinmiyor, simdiDk,
      });
      // Bugünün cirosu: kapanış X / onaylı ciro / taslak — hiçbiri yoksa DÜRÜST "—".
      const ciro = satir ? sayi(satir.ciro_tutar) : 0;
      const ciroMetni = isik.anahtar === 'sezon' ? null
        : ciro > 0 ? `bugün ${fmt(ciro)}` : 'bugün ciro —';
      // Sahip isteği (2026-08-16): QR ile fiilen KAÇTA açıldığı görünsün.
      // acilis_ts kapanis-takip'te zaten var (İstanbul saatine çevrili) —
      // yeni uç yok. Saat çözülemezse hiç yazılmaz (uydurma yok).
      const acilisSaat = satir ? tsSaat(satir.acilis_ts) : null;
      return { ...s, isik, ciroMetni, acilisSaat };
    });

    // K1 — DÜNÜN TOPLAM CİROSU (ŞUBELER bandının sağ şeridi).
    // Zincirli dün okumasından ZATEN elde; ek uç çağrılmaz.
    // ⚠️ TREND YÜZDESİ YOK: /panel günlük ciro serisi döndürmüyor (motors.py
    // panel sözlüğünde bu_ay_ciro var, dünkü/önceki-gün yok) — karşılaştırma
    // günü olmadan "%+6" yazmak uydurma olurdu. Yalnız toplam gösterilir.
    // Dün okuması düşmüş/gelmemişse şerit HİÇ ÇİZİLMEZ (0 ₺ demek yalan olur).
    const dunCiroToplam = dunBilinmiyor ? null
      : (dunHam.satirlar || []).reduce((s, r) => s + sayi(r.ciro_tutar), 0);
    const subeNotu = kapanisHata ? 'kapanış takibi okunamadı'
      : dunBilinmiyor ? 'dün verisi bekleniyor'
        : dunCiroToplam > 0 ? (
          <>
            {/* 🔵 (2026-08-26) "dün" TEK BAŞINA BAĞLAMSIZ: rakamın hangi güne ait
                olduğu söylenmeden 36,8K bir şey ifade etmiyor (pazartesi mi,
                pazar mı?). Tarih ZATEN elde — dün okuması is_gunu_tr ile geldi.
                ⚠️ Yüzde/trend YAZILMIYOR: /panel günlük ciro serisi döndürmüyor,
                karşılaştırma günü olmadan "%+6" uydurma olurdu (mevcut karar
                doğruydu, korundu). Yalnız GÜN ADI eklendi. */}
            {dunHam?.is_gunu_tr ? `${kisaGun(dunHam.is_gunu_tr)} toplamı ` : 'dün toplam '}
            <b style={{ fontFamily: F.mono, color: R.metin2, fontWeight: 700 }}>{kisaPara(dunCiroToplam)}</b>
          </>
        ) : 'dün ciro girilmemiş';

    // ══════════════════════════════════════════════════════════════════════════
    // 🎯 BUGÜN KUYRUĞU (2026-08-26 BAKIŞ kurgusu) — liste değil KUYRUK
    // ══════════════════════════════════════════════════════════════════════════
    // ── NEDEN (kanıtlanmış kusur) ────────────────────────────────────────────
    // `ilkUcIs` ÜÇ SABİT YUVADAN doluyordu: en büyük gecikmiş · 48 saatlik yük ·
    // onay(ya da öneri). Canlıda bu 2 madde üretiyordu. Aynı ekranın altında ise
    // 33 gecikmiş kalem, 78 günlük borç, 17 vadesi geçmiş söz, TEMA'nın
    // girilmemiş cirosu ve 875.824 ₺'lik doğrulanmamış nakit duruyordu.
    // Yani "BUGÜN" listesi eksik değil, YANLIŞ EŞİKLİYDİ: 2 maddelik liste
    // 33 kalemlik gerçeğin yanında "iş bitti" yanılsaması veriyordu.
    //
    // Üç kaynak ekrana HİÇ ULAŞAMIYORDU:
    //   · ciro eksiği  → `ciroEksik` satır ~1600'de tanımlı, bu görünüm satır
    //     910'da return ediyor; Karar Alanı ona ERİŞEMİYORDU bile.
    //   · dün kapanmayan şube → yalnız şube kartında minik "!" işareti.
    //   · mutabakatsız nakit → `veri.nakit` satır 557'de ÇEKİLİYOR ama bu
    //     görünümde HİÇ KULLANILMIYORDU (yalnız "akis" görünümü okuyordu).
    //
    // ── KURAL: 3 SINIF, TEK SIRA ─────────────────────────────────────────────
    //   S1 ÖLÇÜM BOZUK    → en üstte. Çözülmeden ekranın KENDİ rakamları yalan
    //                       söyler; ölçemediğini yönetemezsin.
    //   S2 PARASAL SONUÇ  → ₺ büyüklüğüne göre.
    //   S3 KARAR BEKLEYEN → onay / motor önerisi.
    //
    // ── KAPANMA: madde ELLE KAPATILMAZ, VERİDEN DÜŞER ────────────────────────
    // Kapanış mührü basılınca, ciro girilince, ödeme kaydı oluşunca, sayım
    // yapılınca madde kendiliğinden yok olur. "Kasa İzi = Tek Gerçek" kuralının
    // aynısı. Kapanamayan madde bir tasarım hatasıdır — çünkü kapanamayan
    // uyarı, bir süre sonra hiç okunmayan uyarıdır (uyarı bütçesi doktrini).
    //
    // ── TAVAN 5 ─────────────────────────────────────────────────────────────
    // 33 kalemlik liste bir karar değil ENVANTERDİR; sahip her kalemde mikro
    // karar verip yorulur ve hiçbir şey yapmadan çıkar. Taşanlar sayılır ve
    // tam listeye köprülenir — gizlenmez.
    // 📊 Kasa ayrımını açmak da anlamlı bir eylemdir — ölçüme bildirilir.
    // (olcumEylem yalnız İLK çağrıda yazar; iki yerden çağrılması zararsız.)
    const kasaAc = () => { olcumEylem('cekmece'); kasaCekmecesiniAc(); };

    const ciroEksikGunler = Array.isArray(p.ciro_eksik_gunler) ? p.ciro_eksik_gunler : [];

    // ══════════════════════════════════════════════════════════════════════════
    // 💰 NAKİT DURUMU — TEK ERİŞİMCİ (hem KASA çıpası hem S1 maddesi buradan)
    // ══════════════════════════════════════════════════════════════════════════
    // Aynı hesabı iki yerde yapmak, iki yerin bir gün ayrışması demektir.
    // `veri.nakit` satır ~557'de zaten çekiliyordu ama bu görünümde HİÇ
    // kullanılmıyordu — yeni uç YOK, yalnız okunmayan veri okunuyor.
    //
    // ⚠️ EŞİK %10 NEDEN: kuruş farkı için her sabah alarm yazmak uyarı bütçesini
    // yakar. Defterin onda birinden büyük fark artık "yuvarlama" değildir.
    const nakitDurum = (() => {
      const nk2 = veri.nakit;
      if (!nk2 || nk2 === '__HATA__' || !nk2.duraklar) return { saglam: false };
      const mut2 = Math.abs(sayi(nk2.mutabakatsiz_tl));
      const defter2 = Math.abs(sayi(nk2.defter_bakiyesi_tl));
      return {
        saglam: true,
        mut: mut2,
        defter: defter2,
        dogrulanmis: sayi(nk2.duraklar.duraklar_toplami_tl),
        pay: defter2 > 0 ? Math.round((mut2 / defter2) * 100) : 0,
        ciddiFark: defter2 > 0 && mut2 > defter2 * 0.10,
        // 📉 Doğrulanmış dayanıklılık SUNUCUDAN gelir (operasyon_merkez_api ·
        // kac_gun_dayanir_dogrulanmis). Burada BÖLME YAPILMAZ: "gösterim kendi
        // aritmetiğini kurmaz". Uç hesaplayamazsa null döner ve aralık yazılmaz.
        gunDogrulanmis: nk2.kac_gun_dayanir_dogrulanmis == null
          ? null : sayi(nk2.kac_gun_dayanir_dogrulanmis),
      };
    })();

    const bugunKuyrugu = (() => {
      const aday = [];

      // ── S1 · ÖLÇÜM BOZUK ──────────────────────────────────────────────────
      // (a) Dün kapanmayan şube: kapanış yoksa o günün cirosu/kasası ÖLÇÜLEMEZ.
      // ⚠️ Köprü YOK — v2'de kapanış takibi modülü bulunmuyor (tema.js MODULLER
      // ağacında karşılığı çözülemedi). Uydurma hedef sessizce yanlış ekrana
      // düşürürdü; madde eylemsiz durur, bulgu yine de görünür.
      const dunKapanmayan = subeKartlari.filter((s) => s.isik?.dunEksik);
      if (dunKapanmayan.length > 0) {
        aday.push({
          sinif: 1, tl: 0, k: 's1_kapanis', ikonYol: IK.veriYok, renk: R.kirmizi,
          metin: `${dunKapanmayan.map((s) => s.ad).join(' · ')} dün kapanmadı`,
          alt: 'o günün cirosu ve kasası ölçülemiyor',
        });
      }
      // (b) Ciro girilmemiş günler.
      if (ciroEksikGunler.length > 0) {
        aday.push({
          sinif: 1, tl: 0, k: 's1_ciro', ikonYol: IK.veriYok, renk: R.kirmizi,
          metin: `${ciroEksikGunler.length} gün ciro girilmemiş`,
          alt: 'girilmeyen gün tüm ay rakamlarını eksik gösterir',
          aksiyonAd: 'Ciro Girişi\'ne git',
          onTikla: () => onKopru?.('__modul:para:girisi'),   // tema.js:209 doğrulandı
        });
      }
      // (c) Konumu doğrulanmamış nakit — DEFTERİN ÖNEMLİ BİR PAYI ise.
      // ⚠️ Her fark madde açmaz: kuruş farkı için her sabah iş yazmak uyarı
      // bütçesini yakar. Eşik %10 — defterin onda biri kayıpsa bu artık
      // "yuvarlama" değil, ölçüm sorunudur.
      if (nakitDurum.ciddiFark) {
        aday.push({
          sinif: 1, tl: nakitDurum.mut, k: 's1_mutabakat', ikonYol: IK.banknot, renk: R.kirmizi,
          metin: `${fmt(nakitDurum.mut)} nakit — yeri doğrulanmamış`,
          alt: `defterin %${nakitDurum.pay}'i · şube sayımı eskiyse fark büyür`,
          aksiyonAd: 'Kasa ayrımını aç',
          onTikla: kasaAc,
        });
      }

      // ── S2 · PARASAL SONUÇ + S3 · KARAR BEKLEYEN ──────────────────────────
      // Mevcut `ilkUcIs` üreticisi AYNEN korunur (seçim kuralları, odemeTutar
      // zinciri, odemeCekmece köprüsü hiç değişmedi) — yalnız sınıfı damgalanır.
      //
      // ── ⚖️ S2 EŞİĞİ: BİR GÜNLÜK ORTALAMA CİRO ────────────────────────────
      // Kuyruğun tavanı 5. O beş yeri 800 ₺'lik bir gecikmiş kalem kapatırsa,
      // arkasındaki gerçek iş görünmez olur. Eşik SABİT SAYI OLAMAZ: 10.000 ₺
      // bu işletme için farklı, iki kat büyüdüğünde farklı anlam taşır. O yüzden
      // işletmenin KENDİ ölçeğine bağlanır — bir günlük ortalama ciro.
      //
      // ⚠️ ELENEN KALEM KAYBOLMAZ: gecikme kovası çipinde ve Ödeme Merkezi'nde
      // duruyor. Eşik "gizleme" değil "öne çıkarmama" kuralıdır.
      // ⚠️ Ciro okunamıyorsa eşik UYGULANMAZ (0) — ölçemediğim bir kuralla
      // eleme yapmak, sessizce iş kaybetmektir.
      // ⚠️ AYIN KAÇI OLDUĞU SUNUCUDAN: `is_gunu_tr` bu dosyada zaten doğrulanmış
      // tek tarih kaynağı (tarayıcı saati yasak — sunucunun iş günü kavramı var).
      // `p.bugun` diye bir alan VARSAYMADIM; olmayan alandan bölen üretmek
      // sessizce yanlış eşik kurardı. Tarih okunamazsa eşik 0 = uygulanmaz.
      const isGunuStr = !kapanisHata ? String(kapanisHam.is_gunu_tr || '') : '';
      const gecenGun = /^\d{4}-\d{2}-\d{2}$/.test(isGunuStr) ? Number(isGunuStr.slice(8, 10)) : 0;
      const gunlukOrtCiro = gecenGun > 0
        ? sayi(p.bu_ay_ciro ?? p.bu_ay_sadece_ciro) / gecenGun
        : 0;
      const SINIF = { gecikmis: 2, yuk48: 2, onay: 3, oneri: 3 };
      ilkUcIs.forEach((is) => {
        const tl = is._u ? odemeTutar(is._u) : 0;
        // Yalnız "en büyük gecikmiş" maddesi eşiğe tabi: 48 saatlik yük ve
        // onay/öneri maddeleri para büyüklüğüyle değil ZAMANLA acildir.
        if (is.k === 'gecikmis' && gunlukOrtCiro > 0 && tl > 0 && tl < gunlukOrtCiro) return;
        aday.push({ ...is, sinif: SINIF[is.k] ?? 3, tl });
      });

      // ── S2b · MOTORUN EN KRİTİK ÖNERİSİ ───────────────────────────────────
      // Bu cümle ("Faiz %51. Ertelersen 38.760 ₺ faiz ödersin") 4. görünümde
      // duruyordu. Ertelemenin FİYATINI söyleyen tek yer orasıydı — oysa karar
      // burada veriliyor. Kayıp çerçevesi eylem çağrısında kazanç çerçevesinden
      // güçlü çalışır; cümle kuyruğa taşındı.
      // ⚠️ Onay/öneri maddesi zaten eklendiyse tekrar yazılmaz.
      // ⚠️ ALAN ADLARI oneriGrup.js'ten DOĞRULANDI: enKritikOneri {baslik, alt,
      // grupMu, _o} döndürür — `tutar`/`gerekce` diye alan YOKTUR. (İlk yazımda
      // varsayılmıştı; helper'ı kullanmadan önce dönüş şeklini oku kuralı.)
      // Sıralama ₺ ile yapılamadığı için S2'nin dibine oturur (tl=0) — gecikmiş
      // para her zaman önce gelir, öneri onun ardından.
      const motorEnKritik = enKritikOneri(oneriler);
      if (motorEnKritik && !aday.some((a) => a.k === 'oneri')) {
        aday.push({
          sinif: 2, tl: 0, k: 's2_motor',
          ikonYol: IK.islemci, renk: R.bakir,
          metin: kisalt(String(motorEnKritik.baslik || 'Karar motoru önerisi'), 44),
          alt: kisalt(String(motorEnKritik.alt || 'öneri-only · hüküm insanın'), 60),
          aksiyonAd: 'Motor & Bildirimler',
          onTikla: () => onKopru?.('__gorunum:bildirim'),
        });
      }

      // Sınıf önce, sınıf içinde ₺ büyüklüğü.
      aday.sort((a, b) => a.sinif - b.sinif || b.tl - a.tl);
      return aday;
    })();

    const kuyrukGorunen = bugunKuyrugu.slice(0, 5);
    const kuyrukTasan = bugunKuyrugu.length - kuyrukGorunen.length;
    // Y4 kümesini doldur — yalnız EKRANDA GÖRÜNEN kayıtlar (yukarıdaki nota bak).
    kuyrukGorunen.forEach((x) => { if (x._u) heroAnahtarlar.add(kayitAnahtari(x._u)); });

    // 📊 Kuyruğu ölçüm kancasına bildir (M3-M5: madde ömrü + kronikleşme).
    // ⚠️ ANAHTAR KİMLİĞİ KALICI OLMALI: ödeme maddesinde kayıt kimliği kullanılır,
    // yoksa aynı iş her gün "yeni madde" sayılır ve hiçbir şey kapanmış görünmez
    // (ömür ölçümü sonsuza dek 0 gün çıkardı). Kaydı olmayan maddede tür anahtarı
    // yeterlidir — o maddeler zaten türü başına tek tanedir.
    kuyrukRef.current = {
      anahtar: bugunKuyrugu.map((x) => (x._u ? `odeme|${kayitAnahtari(x._u)}` : x.k)),
      sinif: bugunKuyrugu.map((x) => x.sinif),
    };

    // ── "YAPACAK BİR ŞEY YOK" NE ZAMAN DENİR? ────────────────────────────────
    // Bu ekranın en zor tasarım kararı. İKİ koşul BİRDEN gerekir:
    //   (1) hiçbir kaynak madde üretmemiş,
    //   (2) hiçbir okuma DÜŞMEMİŞ.
    // Uç düşmüşse "iş yok" demek YALANDIR (HATA ≠ BOŞ) — körlüğü huzur diye
    // satmak, bu sistemin en temel yasağı. O yüzden okuma hatası varsa yeşil
    // kutu yerine dürüst uyarı basılır.
    const kuyrukOkumaHatasi = kapanisHata || dunBilinmiyor || veri.nakit === '__HATA__';

    // ═════════ B4 — KISA YOLLAR ═══════════════════════════════════════════════
    // ⚠️ Hedeflerin HEPSİ tema.js MODULLER ağacından doğrulandı (aşağıdaki
    // yorumlardaki satır numaraları o tanımın yeri). Rozetler YALNIZ Bakış'ın
    // zaten okuduğu sayaçlardan gelir — rozet için yeni uç çağrılmadı; sayacı
    // olmayan çip rozetsiz durur (uydurma rozet yok).
    const kisaYollar = [
      { k: 'odeme', ad: 'Ödeme Merkezi', ikon: IK.banknot, renk: R.bakir,
        rozet: gK.length + gU.length + gB.length + gBug.length || null,
        hedef: '__modul:odeme:bekleyen' },                       // tema.js:202
      { k: 'onay', ad: 'Onay Kuyruğu', ikon: IK.onay, renk: R.amber,
        rozet: onaylar.length || null, hedef: '__modul:onaylar:kuyruk' },  // tema.js:215
      { k: 'cari', ad: 'Cari Ekstre', ikon: IK.dosya, renk: R.mavi,
        rozet: null, hedef: '__modul:belge:cari' },               // tema.js:283
      // 📈 'Zam Takibi' çipi KALKTI (2026-08-16): artık Bakış'ın kendi ÜST
      // SEKMESİ. Bulunduğun modülün sekmesine kısa yol koymak, rayda zaten
      // duran bir kapıyı ikinci kez çizmek olurdu.
      { k: 'kart', ad: 'Kart Dosyaları', ikon: IK.kart, renk: R.mavi,
        rozet: null, hedef: '__modul:kart:kartlar' },             // tema.js:249
      { k: 'defter', ad: 'İşlem Defteri', ikon: IK.klasor, renk: R.not2,
        rozet: null, hedef: '__modul:rapor:defter' },             // tema.js:166
    ];

    // Açık katmanların detayı PARA bandının ALTINDA, yerinde açılır.
    const acikKatmanlar = katmanlar.filter((k) => acikKatman[k.anahtar]);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ═════════ BANT 1 — ŞUBELER ═══════════════════════════════════════
            Sahip 2 dakikalık turunun İLK sorusu: "dükkânlar açıldı mı?"
            Uzaktan okunan tek şey RENK; rakam mini satırda. */}
        <Bant
          etiket="Şubeler"
          not={subeNotu}
          cocuk={subeKartlari.length === 0 ? (
            <div style={{ ...kartYuzey, padding: '13px 15px', fontSize: 12.5, color: R.metin2, borderLeft: `3px solid ${R.kirmizi}` }}>
              Şube durumu alınamadı — açılış/kapanış ışıkları gösterilemiyor. Yenileyin.
            </div>
          ) : (
            /* K4 — en=158 · gap 10 → 1010px içerikte en fazla 6 sütun.
               5 şubede auto-fit boş rayları toplar → 5 kart ≈ 194px tek satır;
               6 şubede tam 160px (≥140 tabanı korunur); 7+ şubede zarif
               ikinci satır. Daha küçük bir taban 7 sütun açıp kartları
               okunmaz hâle getirirdi. */
            <Izgara en={158} cocuk={subeKartlari.map((s) => (
              <SubeIsigi key={s.id} ad={s.ad} isik={s.isik} ciroMetni={s.ciroMetni} acilisSaat={s.acilisSaat} />
            ))} />
          )}
        />

        {/* ═════════ BANT 2 — BUGÜN ═════════════════════════════════════════
            Y-dalgasındaki dikey "ilk 3 iş" listesi YATAY çip dizisine indi.
            Seçim kuralları ve onTikla davranışları AYNEN korundu. */}
        <Bant
          etiket="Bugün"
          not={kuyrukGorunen.length ? 'ölçüm önce · sonra para büyüklüğü' : null}
          cocuk={kuyrukGorunen.length === 0 ? (
            /* ── BOŞ HÂL: iki ayrı gerçek, iki ayrı kutu ────────────────────
               Okuma düşmüşken "iş yok" demek körlüğü huzur diye satmaktır.
               O yüzden önce OKUMA HATASI sorulur (HATA ≠ BOŞ). */
            kuyrukOkumaHatasi ? (
              <div style={{ ...kartYuzey, padding: '11px 14px', fontSize: 12.5, color: R.metin2, borderLeft: `3px solid ${R.kirmizi}` }}>
                ⚠ Bugünün işleri çıkarılamadı — {[
                  kapanisHata ? 'kapanış takibi' : null,
                  dunBilinmiyor ? 'dün kapanışı' : null,
                  veri.nakit === '__HATA__' ? 'nakit konumu' : null,
                ].filter(Boolean).join(' · ')} okunamadı. <b>“İş yok” demiyoruz</b>; ölçemediğimiz için bilmiyoruz. Yenileyin.
              </div>
            ) : (
              <div style={{ ...kartYuzey, padding: '11px 14px', fontSize: 12.5, color: R.metin2, borderLeft: `3px solid ${R.yesil}` }}>
                Bugün seni bekleyen iş yok.
                {/* İZLENEN EVRENİN BOYUTU: "boş"un "kör" olmadığının kanıtı.
                    Sayı yazmazsak sahip haklı olarak "gerçekten baktın mı?"
                    diye sorar — ve sormakta haklıdır. */}
                {(gK.length + gU.length + gB.length + gBug.length + gYak.length) > 0 && (
                  <span style={{ color: R.not2 }}>
                    {' '}<b style={{ fontFamily: F.mono }}>{gK.length + gU.length + gB.length + gBug.length + gYak.length}</b> kalem izleniyor, hiçbiri gecikmemiş.
                  </span>
                )}
              </div>
            )
          ) : (
            <>
              <Izgara en={230} cocuk={kuyrukGorunen.map((is, i) => (
                <Cip
                  key={is.k}
                  buyuk
                  // K5 — günün 1 numarası baskın; gerisi nötr.
                  // ⚠️ Kırmızı bütçesi: ön-dikkatsel işlemede aynı anda birden
                  // çok kırmızı yarışırsa hiçbiri kazanmaz. Baskınlık TEK öğede.
                  birincil={i === 0}
                  ikonYol={is.ikonYol}
                  renk={is.renk}
                  baslik={is.metin}
                  // Alt satır 2 satırı geçmesin diye gerekçe kırpılır (tam metin
                  // zaten tıklanınca açılan çekmecede). 3. satır = taşma demek.
                  alt={[`${i + 1}.`, kisalt(is.alt, 44), is.onTikla ? `${is.aksiyonAd} →` : null].filter(Boolean).join(' ')}
                  // 📊 Kuyruktan bir işe girmek EN ANLAMLI eylemdir — ekranın
                  // var oluş sebebi tam olarak bu. M1/M2 buradan ölçülür.
                  onTikla={is.onTikla ? () => { olcumEylem('kuyruk'); is.onTikla(); } : undefined}
                  aksiyonAd={is.aksiyonAd}
                />
              ))} />
              {/* TAŞAN İŞLER GİZLENMEZ, SAYILIR. Sessiz kırpma "hepsi bu" diye
                  okunur; kaç iş görülmediğini söylemek dürüstlüğün şartı. */}
              {kuyrukTasan > 0 && (
                <div
                  onClick={() => onKopru?.('__modul:odeme:bekleyen')}
                  style={{
                    marginTop: 8, fontSize: 12, color: R.not2, cursor: onKopru ? 'pointer' : 'default',
                  }}
                >
                  … ve <b style={{ color: R.metin2 }}>{kuyrukTasan} iş daha</b> — kuyruk ilk 5'i gösterir
                  {onKopru ? <span style={{ color: R.bakir }}> · tam listeye git →</span> : null}
                </div>
              )}
            </>
          )}
        />

        {/* ═════════ BANT 3 — PARA ═══════════════════════════════════════════ */}
        <Bant etiket="Para" not={baskiYok ? 'ödeme baskısı yok' : null} cocuk={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {/* `sik` — şerit bir BANDIN içinde; kendi alt boşluğunu taşımaz,
            aralığı bandın flex gap'i verir (çift boşluk = boşa 16px). */}
        <KpiSeridi sik kpiler={[
          // ══════════════════════════════════════════════════════════════════
          // 💰 KASA — ÇİFT ÇIPA (2026-08-26 BAKIŞ kurgusu)
          // ══════════════════════════════════════════════════════════════════
          // ESKİ HÂL: 1.797.603 ₺ tek sayı ve YEŞİL. Bu ekranın ilk büyük
          // parasal rakamıydı → sahip "param var" çıpası alıp sonraki tüm borç
          // rakamlarını buna göre "karşılanabilir" okuyordu. Oysa o toplamın
          // 875.824 ₺'sinin (yarısına yakını) HANGİ DURAKTA olduğu belli değil;
          // doğrulanmamış parayı yeşille göstermek sahte-yeşil yasağının ta
          // kendisidir. Uyarı 2. görünümde saklıydı, çıpa burada kuruluyordu.
          //
          // YENİ HÂL: çıpa DOĞRULANMIŞ para. Doğrulanmamış kısım kaybolmuyor —
          // aynı kartta, alt satırda, kendi adıyla duruyor. Sahip iki gerçeği
          // birden görüyor: elinde kesin ne var, ne kadarı soru işareti.
          //
          // ⚠️ Fark ciddi DEĞİLSE (≤%10) eski gösterim aynen korunur — küçük
          // yuvarlama farkı için sahibi her sabah tedirgin etmek uyarı
          // yorgunluğu üretir ve gerçek fark büyüdüğünde fark edilmez.
          // 🖱️ 2026-08-17 sahip kuralı KORUNDU: tıklayınca ayrım açılır; kırılım
          // /api/kasa-defteri'den CANLI gelir, burada rakam yeniden hesaplanmaz.
          nakitDurum.ciddiFark ? {
            etiket: 'Kasa · doğrulanmış',
            deger: fmt(nakitDurum.dogrulanmis),
            alt: `+ ${fmt(nakitDurum.mut)} yeri doğrulanmamış · ayrım için tıkla`,
            renk: R.krem,          // yeşil DEĞİL: doğrulanmamış pay varken "iyi" denmez
            onTikla: kasaAc,
          } : {
            etiket: 'Kasa',
            deger: fmt(sayi(p.kasa)),
            alt: 'tüm kasaların toplamı · ayrım için tıkla',
            renk: sayi(p.kasa) >= 0 ? R.yesil : R.kirmizi,
            onTikla: kasaAc,
          },
          // 📉 GECİKMİŞ — rakamın yanında DEĞİŞİMİ de söyler (HAMLE 3).
          // Taban `gecmisOzet` (önceki günün anlık görüntüsü); yoksa delta yok.
          (() => {
            const d = gecmisOzet ? {
              tl: gecikmisToplam - sayi(gecmisOzet.gecikmisTl),
              adet: (gK.length + gU.length + gB.length) - sayi(gecmisOzet.gecikmisAdet),
            } : null;
            // Sıfır değişim de bir bilgidir ("dünden beri değişmedi") ama YALNIZ
            // gerçek bir taban varken — tek ölçümden "değişmedi" demek yalandır.
            const metin = !d ? null
              : (d.tl === 0 && d.adet === 0) ? `${gecmisOzet.tarih.slice(5)}'ten beri değişmedi`
                : [
                  `${gecmisOzet.tarih.slice(5)}'ten beri ${d.tl >= 0 ? '+' : '−'}${fmt(Math.abs(d.tl))}`,
                  d.adet !== 0 ? `${d.adet > 0 ? '+' : '−'}${Math.abs(d.adet)} kalem` : null,
                ].filter(Boolean).join(' · ');
            return {
              etiket: 'Gecikmiş',
              deger: fmt(gecikmisToplam),
              alt: `${gK.length + gU.length + gB.length} kalem`,
              renk: gecikmisToplam > 0 ? R.kirmizi : R.yesil,
              delta: metin,
              // Büyüme kötü, küçülme iyi — renk yönü söyler.
              deltaRenk: !d || (d.tl === 0 && d.adet === 0) ? R.not3
                : d.tl > 0 ? R.kirmizi : R.yesil,
            };
          })(),
          {
            // 🔵 (2026-08-14): değer TUTAR, adet alta indi (yanındaki KPI'lar para
            // gösterirken bu tek başına sayıydı).
            etiket: 'Bugün + 48 saat',
            deger: fmt(gBugToplam),
            alt: `${gBug.length} kalem · 48 saat ${fmt(t48)}`,
            renk: gBugToplam > 0 ? R.amber : t48 > 0 ? R.mavi : R.yesil,
          },
          {
            etiket: 'Dayanıklılık',
            // 📉 ARALIK (2026-08-26): tek sayı yerine "12–23 gün". Alt uç
            // doğrulanmış nakitten, üst uç kasa defterinden — ikisi de AYNI
            // paydadan (finans_core · gunluk_nakit_yuku). Aralık ancak iki uç da
            // varken yazılır; sunucu alt ucu hesaplayamadıysa tek sayıya döner.
            deger: (() => {
              const ust = p.kac_gun_dayanir != null ? sayi(p.kac_gun_dayanir) : null;
              if (ust == null) return '—';
              const alt = nakitDurum.ciddiFark ? nakitDurum.gunDogrulanmis : null;
              return alt != null && alt < ust ? `${alt}–${ust} gün` : `${ust} gün`;
            })(),
            // ⚠️ DAYANAĞINI SÖYLER (2026-08-26): bu sayı kasa/günlük-yük'ten
            // türüyor ve o "kasa" ŞİŞKİN olabilir — içinde yeri doğrulanmamış
            // para varsa dayanıklılık da o kadar iyimserdir. Rakamı burada
            // düzeltmiyoruz: "gösterim kendi aritmetiğini kurmaz" kuralı gereği
            // doğrulanmış-kasa dayanıklılığı SUNUCUDA hesaplanmalı
            // (motors.py · kac_gun_dayanir_dogrulanmis). O gelene kadar dürüst
            // olan şey sayıyı uydurmak değil, DAYANAĞINI AÇIK YAZMAKTIR.
            alt: nakitDurum.ciddiFark
              ? (nakitDurum.gunDogrulanmis != null
                ? 'alt uç: yalnız doğrulanmış nakit · üst uç: kasa defteri'
                : 'doğrulanmamış kasa üzerinden · iyimser')
              : 'kasa / günlük yük',
            renk: p.kac_gun_dayanir == null ? R.not3
              : sayi(p.kac_gun_dayanir) < 15 ? R.kirmizi
                : nakitDurum.ciddiFark ? R.amber : R.krem,
          },
        ]} />

        {/* Gecikme kovaları — dikey akordeon YERİNE yatay çip dizisi.
            Boş kova hiç çizilmez; detay bandın ALTINDA yerinde açılır. */}
        {katmanlar.length > 0 && (
          <Izgara en={178} cocuk={katmanlar.map((k) => {
            const o = katmanOzeti(k.kayitlar);
            return (
              <KatmanCipi
                key={k.anahtar}
                baslik={k.baslik}
                renk={k.renk}
                adet={o.adet}
                toplam={o.toplam}
                enBuyukMetin={o.enBuyukMetin}
                enBuyukKisa={o.enBuyukKisa}
                vadeKisa={o.vadeKisa}
                // KRONİK / AKUT AYRIMI — yalnız KRİTİK kovada ve yalnız gerçek
                // bir karşılaştırma tabanı varken. Taban yoksa yazılmaz.
                // (Kritik kova en pahalısı: 78 gündür duran kalemler burada.)
                degisim={(() => {
                  if (k.anahtar !== 'kritik' || !gecmisOzet) return null;
                  const d = gK.length - sayi(gecmisOzet.kritikAdet);
                  return d > 0 ? `yeni +${d}` : d < 0 ? `kapanan ${Math.abs(d)}` : null;
                })()}
                acik={!!acikKatman[k.anahtar]}
                onAc={() => setAcikKatman((s) => ({ ...s, [k.anahtar]: !s[k.anahtar] }))}
              />
            );
          })} />
        )}

        {baskiYok && (
          <div style={{
            ...kartYuzey, padding: '11px 14px', borderLeft: `3px solid ${R.yesil}`,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <IkonRozet yol={IK.onay} renk={R.yesil} boyut={14} />
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: R.metin2, minWidth: 0 }}>
              <b style={{ color: R.yesil }}>Bugün ödeme baskısı yok</b> — gecikmiş, bugün vadesi ve 7 gün içi kalem bulunmuyor.
            </div>
          </div>
        )}

        {/* Vadeli alım — AYRI EVREN (tedarikçi sözleri), üstteki "Gecikmiş"
            KPI'ı ödeme PLANLARINI sayar. Para bandında tek satırlık şerit:
            KPI kartı olarak beşinci sütun olduğunda hikâyenin ritmini bozuyordu,
            kısa yol çipi olduğunda ise tutarları kayboluyordu. */}
        <div
          {...(onKopru ? acilirBaslikOzellik(
            () => onKopru('__modul:odeme:tedarikci'), null, 'Tedarikçi Bakiyesi ekranını aç',
          ) : {})}
          style={{
            ...kartYuzey, borderRadius: 13, padding: '6px 11px', borderLeft: `3px solid ${vRenk}`,
            display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
            cursor: onKopru ? 'pointer' : 'default', outline: 'none',
          }}
        >
          <span style={{ display: 'flex', color: vRenk, flexShrink: 0 }}><Ikon yol={IK.kule} boyut={13} /></span>
          <span style={{ fontSize: 12, fontWeight: 600, color: R.krem }}>
            Vadeli alım sözleri{v ? ` · ${sayi(v.bekleyen_adet)}` : ''}
          </span>
          <span style={{ fontSize: 10.5, color: vRenk === R.yesil ? R.not2 : vRenk }}>{vAlt}</span>
          {onKopru && (
            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, color: R.not3, whiteSpace: 'nowrap' }}>
              Tedarikçi Bakiyesi →
            </span>
          )}
        </div>

        </div>} />

        {/* ═════════ BANT 4 — KISA YOLLAR ═══════════════════════════════════
            Sahibin "nereye gideyim?" sorusu. Hedeflerin hepsi MODULLER
            ağacından doğrulandı; rozetler mevcut sayaçlardan. */}
        {/* en=150 · gap 9 → 1010px içerik genişliğinde 6 çip TEK SATIR.
            İkinci satıra taşarsa 2 dakikalık tur kaydırmaya başlar. */}
        <Bant etiket="Kısa yollar" not="sık gidilen ekranlar" cocuk={
          <Izgara en={150} gap={9} cocuk={kisaYollar.map((y) => (
            <Cip
              key={y.k}
              ikonYol={y.ikon}
              renk={y.renk}
              baslik={y.ad}
              rozet={y.rozet}
              aksiyonAd={`${y.ad} ekranını aç`}
              onTikla={onKopru ? () => onKopru(y.hedef) : null}
            />
          ))} />
        } />

        {/* ═════════ AÇILAN KOVANIN DÖKÜMÜ — MOZAİĞİN ALTINDA ════════════════
            K3 — PANO SABİT: döküm 4 bandın ALTINA çizilir, aralarına DEĞİL.
            İki kat koruma:
              1) YER: hangi kova açılırsa açılsın ŞUBELER/BUGÜN/PARA/KISA YOLLAR
                 hep aynı 4 bant yüksekliğinde kalır — hiçbiri fold'un altına
                 itilmez (ölçüm: kapalı 482px, açıkken de ilk 482px aynı).
              2) TAVAN: liste kendi içinde kaydırır (maxHeight 240) — 9 kalemlik
                 bir kova 555px'lik kuyruk açıp sayfayı üç ekran uzatamaz.
            Kova ile dökümü bağlayan iz: açık çipin renk halkası + dökümün
            başlığında kovanın adının tekrarı. */}
        {acikKatmanlar.map((k, i) => (
          <div key={`d-${k.anahtar}`} style={{ ...kartYuzey, padding: '12px 14px', borderLeft: `3px solid ${k.renk}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
              <span style={{ fontFamily: F.baslik, fontSize: 13, fontWeight: 600, color: k.renk }}>{k.baslik}</span>
              {/* 'satıra tıkla' notu YALNIZ ilk açılan dökümde (tekrarı gürültü) */}
              {i === 0 && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3 }}>satıra tıkla → ödeme dosyası</span>}
            </div>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              maxHeight: 240, overflowY: 'auto', paddingRight: 4,
            }}>
              {katmanIcerigi(k.anahtar, k.kayitlar)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ════════════════════════ GÖRÜNÜM: PARA AKIŞI ═════════════════════════════
  if (gorunum === 'akis') {
    const giris = sayi(p.bu_ay_nakit_giris);
    const cikis = sayi(p.bu_ay_nakit_cikis);
    const net = p.bu_ay_net != null ? sayi(p.bu_ay_net) : giris - cikis;
    // ── NAKİT KONUM: "param şu an nerede?" ───────────────────────────────────
    // Kasa bakiyesi tek sayıdır ama para tek yerde durmaz: şube kasasında,
    // yolda (teslim alınmış/bankaya girmemiş) ve bankada bekler. Durakların
    // toplamı ile defter bakiyesi arasındaki fark = mutabakatsız nakit.
    const nk = veri.nakit;
    // 🔴 EVV-GENEL-N2 (2026-08-12 satır-satır denetim) FAKE-GREEN: /nakit-konum okuması
    // DÜŞERSE (nk===null) kart sessizce kayboluyordu → mutabakat tam sorun anında görünmez.
    // Okuma-hatasını (null) veri-yokluğundan (duraklar absent) ayır: null → açık uyarı.
    const nakitHataBlok = nk === null ? (
      <div style={{ ...kartYuzey, padding: '13px 18px', marginBottom: 14, borderLeft: `3px solid ${R.kirmizi}`, fontSize: 12.5, color: R.metin2 }}>
        ⚠ Nakit konum verisi gelmedi — "param nerede?" mutabakatı gizlenmiş olabilir. Yenileyin.
      </div>
    ) : null;
    const nakitBlok = nk?.duraklar ? (() => {
      const du = nk.duraklar;
      const sag = nk.saglik || {};
      const mut = sayi(nk.mutabakatsiz_tl);
      const renk = sag.durum === 'yesil' ? R.yesil : sag.durum === 'sari' ? R.amber : R.kirmizi;
      const duraklar = [
        ['Şube kasalarında', sayi(du.sube_kasalarinda_tl), R.krem, 'son kapanış sayımı'],
        ['Yolda', sayi(du.yolda_tl), renk, 'teslim alınmış · bankaya girmemiş'],
        ['Bankada', sayi(du.bankada_tl), R.mavi, 'yatırım kayıtları'],
      ];
      const enBuyuk = Math.max(1, ...duraklar.map(([, v]) => Math.abs(v)));
      // 🚪 ŞUBE ADI → KASA DEFTERİ ANAHTARI (ikinci katman için)
      // ⚠️ /nakit-konum'un `sube_kasalari` satırlarında `sube_id` YOK — yalnız
      // `sube_adi` var (uç şemasından doğrulandı). Kasa defteri ise ad değil
      // ANAHTAR ile filtreliyor. O yüzden SUBE_ADI haritası tersine çevrilir;
      // ad çözülemezse satır KAPI YAPILMAZ. Ekran adını filtreye yollamak
      // sessizce BOŞ liste getirir — tıklanıp boş açılan kapı, bugünkü dürüst
      // çıkmaz sokaktan daha kötüdür.
      // ⚠️ trKucuk KULLANILDI, trBuyut DEĞİL: bu dosyada `trBuyut` TANIMLI DEĞİL
      // (yalnız trKucuk var, satır 42). Yazarken varsaymıştım — derleme geçerdi,
      // canlıda ReferenceError'a düşerdi. Dosyanın kendi kuralı: yardımcıyı
      // kullanmadan önce O DOSYADA grep'le. Türkçe İ/ı tuzağı için küçültme de
      // büyütme kadar iyi bir normalleştirmedir; önemli olan İKİ TARAFIN da
      // aynı işlemden geçmesi.
      const ADDAN_ANAHTAR = Object.fromEntries(
        Object.entries(SUBE_ADI).map(([anahtar, ad]) => [trKucuk(ad), anahtar]),
      );
      const nakitCekmeceAc = () => onCekmece?.({
        tip: 'NAKİT KONUM',
        baslik: 'Param şu an nerede?',
        alt: `son ${sayi(nk.pencere_gun)} gün · kayıt üretmez, konumu hesaplar`,
        kpi: [
          { etiket: 'Durakların toplamı', deger: fmt(sayi(du.duraklar_toplami_tl)), renk: R.bakirAcik },
          { etiket: 'Kasa defteri', deger: fmt(sayi(nk.defter_bakiyesi_tl)) },
          { etiket: 'Mutabakatsız', deger: fmt(mut), renk: Math.abs(mut) > 1 ? R.kirmizi : R.yesil },
        ],
        listeBaslik: 'Duraklar ve akış',
        satirlar: [
          ...duraklar.map(([ad, v, , alt]) => ({ ad, detay: alt, tutar: fmt(v) })),
          { ad: '= Durakların toplamı', detay: 'konumu doğrulanmış nakit', tutar: fmt(sayi(du.duraklar_toplami_tl)) },
          { ad: 'Kasa defteri bakiyesi', detay: 'kanonik kayıt', tutar: fmt(sayi(nk.defter_bakiyesi_tl)) },
          { ad: '⚠ Mutabakatsız', detay: 'hangi durakta olduğu bilinmeyen', tutar: fmt(mut) },
          { ad: 'Teslim alınan (toplam)', detay: `${sayi(nk.akis?.teslim_adet)} işlem`, tutar: fmt(sayi(nk.akis?.teslim_alinan_tum_tl)) },
          { ad: 'Bankaya yatan (toplam)', detay: `${sayi(nk.akis?.banka_adet)} işlem`, tutar: fmt(sayi(nk.akis?.bankaya_yatan_tum_tl)) },
          ...(nk.sube_kasalari || []).map((s) => {
            const anahtar = ADDAN_ANAHTAR[trKucuk(String(s.sube_adi || ''))];
            return {
              ad: `${s.sube_adi} kasası`,
              detay: `son kapanış ${s.son_kapanis}`,
              tutar: fmt(sayi(s.kasada_tl)),
              // Kapı YALNIZ anahtar çözülebildiyse açılır.
              onTikla: anahtar ? () => kasaDetayAc({
                baslik: `${s.sube_adi} · kasa hareketleri`,
                sube_id: anahtar,
                altBilgi: `son kapanışta ${fmt(sayi(s.kasada_tl))}`,
                geriHedef: { ad: 'Param şu an nerede?', onTikla: () => nakitCekmeceAc() },
              }) : undefined,
            };
          }),
        ],
        not: `${sag.esik || ''} · ${nk.not || ''}`,
      });
      return (
        <div
          onClick={nakitCekmeceAc}
          style={{ ...kartYuzey, padding: '15px 18px', marginBottom: 14, cursor: 'pointer', borderLeft: `3px solid ${renk}` }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 11 }}>
            <span style={{ fontFamily: F.baslik, fontSize: 15, fontWeight: 600 }}>💵 Param şu an nerede?</span>
            {sag.yolda_haftalik_ciro_pct != null && (
              <span style={{ fontSize: 11.5, color: renk, fontWeight: 700 }}>
                {/* ⚠️ trSayi bu dosyada TANIMLI DEĞİL (bugün 8. helper tuzağı) —
                    Math.round ile yazıldı. Kural: helper kullanmadan önce O DOSYADA grep.
                    🔵 (2026-08-26 BAKIŞ kurgusu) %100 ÜSTÜ YÜZDE OKUNMUYOR: canlıda
                    "%337'i" yazıyordu — sahip bunu oran sanıp "yoldaki para cironun
                    üçte biri" diye okur. 100 üstünde insan dili KAT'tır. Eşik 200:
                    %150 hâlâ yüzde olarak anlaşılır, %337 anlaşılmaz. */}
                {(() => {
                  const pct = sayi(sag.yolda_haftalik_ciro_pct);
                  return pct >= 200
                    ? `yoldaki nakit = haftalık cironun ${(pct / 100).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} katı`
                    : `yoldaki nakit = haftalık cironun %${Math.round(pct)}'i`;
                })()}
              </span>
            )}
            <span style={{ fontSize: 11, color: R.not2, marginLeft: 'auto' }}>dokun → tam döküm</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {duraklar.map(([ad, v, c, alt]) => (
              <div key={ad} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ fontSize: 12, width: 132, flexShrink: 0, color: R.metin2 }}>{ad}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 99, background: R.girinti, overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, (Math.abs(v) / enBuyuk) * 100)}%`, height: '100%', background: c, opacity: 0.75 }} />
                </div>
                <span style={{ fontSize: 12.5, fontFamily: F.mono, width: 104, textAlign: 'right', color: c }}>{fmt(v)}</span>
                <span style={{ fontSize: 10.5, color: R.not3, width: 168 }}>{alt}</span>
              </div>
            ))}
          </div>
          {Math.abs(mut) > 1 && (
            <div style={{
              marginTop: 11, padding: '9px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.55,
              background: 'rgba(248,113,113,.08)', border: `1px solid ${R.kirmizi}33`, color: R.metin2,
            }}>
              ⚠ Kasa defteri <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(nk.defter_bakiyesi_tl))}</b> diyor,
              durakların toplamı <b style={{ fontFamily: F.mono, color: R.krem }}>{fmt(sayi(du.duraklar_toplami_tl))}</b> —
              aradaki <b style={{ fontFamily: F.mono, color: R.kirmizi }}>{fmt(mut)}</b> hangi durakta olduğu
              doğrulanmamış nakit. Şube kasası rakamları son kapanış sayımından gelir; sayım eskiyse fark büyür.
            </div>
          )}
        </div>
      );
    })() : null;
    // 🔵 (2026-08-14) BLOK SIRASI DEĞİŞTİ (yalnız yerleşim — veri/mantık aynı):
    // sabah ilk sorulan soru operasyoneldir. Sıra artık
    //   1) param nerede → 2) ödeme baskısı → 3) aylık KPI → 4) tahsilat kanalları
    //   → 5) kasa özeti → 6) bu ay ödenen sabit giderler.
    // Eskiden aylık özet (geçmişe bakan rakamlar) 2. sıradaydı, "bu ay neyi
    // ödemem gerek" ise en alttaydı → sahip her sabah aşağı kaydırıyordu.
    return (
      <>
        {/* ══════════════════════════════════════════════════════════════════
            🔍 ROL: KANIT KATMANI (2026-08-26 kurgusu)
            ══════════════════════════════════════════════════════════════════
            Karar Alanı'nda para ÜÇ KATMANDA anlatılır:
              K1 · 4 KPI (karar için — Karar Alanı)
              K2 · bu görünüm (kanıt: para hangi durakta, baskı nereden geliyor)
              K3 · çekmece (kayıt düzeyi döküm)
            Bu görünüm "her sabah bakılan yer" değil, "şu rakam nereden geliyor?"
            sorusunun cevabı. O yüzden 2 ekran uzunluğunda olması bir kusur
            DEĞİL — kanıt katmanının uzun olması normaldir; kısa olması gereken
            karar katmanıdır ve o tek ekrana sığdırıldı. */}
        <div style={{
          ...kartYuzey, padding: '10px 15px', marginBottom: 13, fontSize: 12,
          color: R.not2, borderLeft: `3px solid ${R.mavi}`,
        }}>
          🔍 <b style={{ color: R.metin2 }}>Kanıt katmanı.</b>{' '}
          Karar Alanı'ndaki para rakamlarının nereden geldiği burada açılır —
          karar için değil, <b style={{ color: R.metin2 }}>doğrulama</b> için.
        </div>
        {nakitHataBlok}
        {nakitBlok}

        <Bolum baslik="⚡ Ödeme baskısı" not="finansman yükü" cocuk={
          <>
            <Satir ad="Bekleyen borç taksiti" deger={fmt(sayi(p.borc_taksit_bekleyen))} alt={sayi(p.borc_taksit_bekleyen_adet) ? `${sayi(p.borc_taksit_bekleyen_adet)} taksit` : null} renk={sayi(p.borc_taksit_bekleyen) ? R.kirmizi : R.krem} />
            <Satir ad="Ödenen borç taksiti" deger={fmt(sayi(p.borc_taksit_odenen))} renk={R.yesil} />
            <Satir ad="Bu ay kart faizi" deger={fmt(sayi(p.bu_ay_kart_faizi))} renk={sayi(p.bu_ay_kart_faizi) ? R.kirmizi : R.krem} />
            <Satir ad="Finansman maliyeti" deger={fmt(sayi(p.bu_ay_finansman_maliyeti))} renk={sayi(p.bu_ay_finansman_maliyeti) ? R.kirmizi : R.krem} />
            <Satir ad="Bekleyen gider sayısı" deger={String(sayi(p.bekleyen_gider_sayisi))} renk={R.metin2} />
          </>
        } />

        <KpiSeridi kpiler={[
          { /* PROD-V2-CIRO-001 FIX: BRÜT bu_ay_ciro (ciro tablosu) — "Bu ay ciro" etiketi brüt olmalı;
               önce NET bu_ay_sadece_ciro tercih ediliyordu, aşağıdaki tahsilat kanalları brütken tutarsızdı. */
            etiket: 'Bu ay ciro', deger: fmt(sayi(p.bu_ay_ciro ?? p.bu_ay_sadece_ciro)), alt: 'sadece ciro', renk: R.krem },
          { etiket: 'Nakit giriş', deger: giris ? fmt(giris) : '—', alt: 'bu ay', renk: giris ? R.yesil : R.not },
          { etiket: 'Nakit çıkış', deger: cikis ? fmt(cikis) : '—', alt: 'bu ay', renk: cikis ? R.kirmizi : R.not },
          { etiket: 'Net akış', deger: net ? fmt(net) : '—', alt: net >= 0 ? 'pozitif' : 'negatif', renk: net >= 0 ? R.yesil : R.kirmizi },
        ]} />

        {/* 🔵 (2026-08-12): başlık "para akışı" idi ama satırlar TAHSİLAT KANALLARI (ciro
            kırılımı: nakit/pos/online/dış/devir) — üstteki nakit-akışı KPI'ıyla (giriş/çıkış/
            net) karıştırılmasın diye başlık nota (tahsilat) hizalandı. Farklı metrikler. */}
        <Bolum baslik="💼 Bu ayın tahsilat kanalları" not="ciro kırılımı — üstteki nakit-akışı KPI'sından farklı" cocuk={
          <>
            <Satir ad="Nakit" deger={fmt(sayi(p.bu_ay_nakit))} />
            <Satir ad="POS / kart" deger={fmt(sayi(p.bu_ay_pos))} alt={sayi(p.bu_ay_pos_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_pos_kesinti))}` : null} />
            <Satir ad="Online" deger={fmt(sayi(p.bu_ay_online))} alt={sayi(p.bu_ay_online_kesinti) ? `kesinti ${fmt(sayi(p.bu_ay_online_kesinti))}` : null} />
            <Satir ad="Dış kaynak geliri" deger={fmt(sayi(p.bu_ay_dis_kaynak))} renk={R.metin2} />
            {/* 🔵 (2026-08-26 BAKIŞ kurgusu) DEVİR AYRI TARAFA ÇEKİLDİ.
                Eskiden not düşülmüştü ("bu ayın tahsilatı değil") ama satır hâlâ
                kanal listesinin İÇİNDEYDİ ve 2.455.178 ₺ ile listenin en büyük
                rakamıydı — göz devirle kanalları toplar, "bu ay 3,5 milyon tahsil
                etmişiz" yanılsaması doğar. Uyarı yazısı, yerleşimin söylediğini
                yenemez. Çözüm: önce KANAL TOPLAMI kapanır, devir çizginin altına
                girintili yazılır. */}
            <Satir
              ad="= Kanal toplamı"
              deger={fmt(sayi(p.bu_ay_nakit) + sayi(p.bu_ay_pos) + sayi(p.bu_ay_online) + sayi(p.bu_ay_dis_kaynak))}
              alt="devir hariç — bu ayın gerçek tahsilatı"
              renk={R.bakirAcik}
            />
            <div style={{ borderTop: `1px solid ${R.cizgi3}`, margin: '7px 0 2px' }} />
            <div style={{ paddingLeft: 14 }}>
              <Satir ad="Devir" deger={fmt(sayi(p.bu_ay_devir))} renk={R.not2} alt="geçmiş aydan devreden — bu ayın tahsilatı DEĞİL" />
            </div>
          </>
        } />

        {/* ══════════════════════════════════════════════════════════════════
            🗑️ "KASA ÖZETİ" BLOĞU KALDIRILDI (2026-08-26, sahip onayıyla)
            ══════════════════════════════════════════════════════════════════
            Blok şu 5 satırı basıyordu:
              Kanonik kasa 1.797.603 · Anlık nakit 53.025 · Anlık kart 0
              · Genel nakit toplamı 631.218 · Genel kart toplamı 39.372

            SEBEP — aynı ekranda ÜÇ FARKLI "nakit" rakamı vardı:
              12.065 ₺  (şube kasalarında — son kapanış sayımı)
              53.025 ₺  (anlık nakit)
              631.218 ₺ (genel nakit toplamı)
            Üçü de "nakit" diyordu, üçü farklı şeydi ve ekran hangisinin ne
            olduğunu SÖYLEMİYORDU. Sahip için bu bilgi değil, gürültüdür:
            "anlık" ile "genel"in farkını ekran anlatmıyor, sahibin dilinde
            karşılığı yok. Bu satırlar dışsal bilişsel yükün en pahalı kalemiydi.

            ⚠️ BU BİR GİZLEME DEĞİL — "boş alanı gizleme" kuralına aykırı değil:
            alanlar BOŞ değildi, ANLAMSIZDI. Ve eşdeğeri daha iyi bir yerde
            zaten var: kasa kırılımını KASA ÇEKMECESİ tanımlı ve satır düzeyinde
            yapıyor; kanonik kasa rakamı da hemen üstteki "param nerede?"
            mutabakat uyarısında ("Kasa defteri … diyor") görünmeye devam ediyor.
            Yani hiçbir sayı kayboldu, sadece TANIMSIZ tekrarı kalktı. */}

        <Bolum baslik="✅ Bu ay ödenen sabit giderler" not="salt-okur" cocuk={
          (() => {
            const liste = Array.isArray(veri.odenen) ? veri.odenen : (veri.odenen?.odemeler || veri.odenen?.satirlar || []);
            // 🔴 (2026-08-14) CANLIDA HEP 0 ₺: tablo `o.tutar` okuyordu ama uç bu adı
            // HİÇ göndermiyor — alanlar {aciklama, gider_adi, odenen_tutar,
            // odenecek_tutar, odeme_tarihi, plan_tarihi, kategori}. Ad da `o.ad`
            // aranıyordu, o da yok → her satır "— · 0 ₺" idi.
            // Ayrıca uç TÜM AYLARI ve tutarı 0/eksi olan "LİMİT YETERSİZ" plan
            // kayıtlarını da döndürüyor; başlık "Bu ay ÖDENEN" diyor → içinde
            // bulunulan ay + gerçekten ödenmiş (odenen_tutar>0) kayıtlar süzülür.
            const simdi = new Date();
            const buAy = `${simdi.getFullYear()}-${String(simdi.getMonth() + 1).padStart(2, '0')}`;
            const buAyLis = liste.filter((o) => (
              String(o.odeme_tarihi || '').slice(0, 7) === buAy && sayi(o.odenen_tutar) > 0
            ));
            if (!buAyLis.length) return <div style={{ fontSize: 12, color: R.not2 }}>Bu ay ödenmiş sabit gider kaydı yok.</div>;
            return (
              <Tablo
                baslik=""
                not={buAyLis.length > 15 ? `ilk 15 / ${buAyLis.length} kayıt` : null}
                kolonlar={[{ ad: 'Gider' }, { ad: 'Tarih' }, { ad: 'Tutar', sag: true }]}
                satirlar={buAyLis.slice(0, 15).map((o, i) => ({
                  id: o.id || `sg-${i}`,
                  hucreler: [
                    { v: kisalt(o.aciklama || o.gider_adi || o.ad || '—', 44), kalin: true },
                    { v: kisaGun(o.odeme_tarihi || o.plan_tarihi || o.tarih), mono: true, renk: R.not },
                    { v: fmt(sayi(o.odenen_tutar ?? o.odenecek_tutar ?? o.tutar)), mono: true, sag: true, kalin: true, renk: R.yesil },
                  ],
                }))}
              />
            );
          })()
        } />
      </>
    );
  }

  // ════════════════════════ GÖRÜNÜM: BİLDİRİMLER ════════════════════════════
  const ciroEksik = Array.isArray(p.ciro_eksik_gunler) ? p.ciro_eksik_gunler : [];
  const mesajlar = Array.isArray(p.merkez_mesajlar) ? p.merkez_mesajlar : [];

  // ── N2/N3 (2026-08-16): MOTOR ÖNERİLERİ ARTIK BURADA LİSTELENMİYOR ────────
  //
  // ⛔ N1 — "Bugün senden karar bekleyenler" şeridi KALDIRILDI: Kokpit'in BUGÜN
  //    bandı aynı soruyu (bugün ne yapmalıyım) zaten cevaplıyordu; iki ayrı
  //    "günlük öncelik" yüzeyi tutmak, ikisinin zamanla ayrışması demekti.
  //    Onay sayısı kaybolmadı → aşağıdaki Onay merkezi bloğu + Kokpit'in
  //    "Onay Kuyruğu" kısa yol rozeti taşıyor.
  //
  // 🧠 N2 — Karar motoru TAM LİSTESİ kalktı, yerine ÖZET KART geldi: bu sekme
  //    "istisna & yönlendirme merkezi"dir, önerilerin KANONİK ekranı Strateji.
  //    Aynı listeyi iki yerde tutmak "tek eylem tek yer" kuralını çiğniyordu
  //    (ve akıbet işareti yalnız Strateji'de yazılabiliyor).
  //
  // 🔗 N3 — Kritik-nakit birleştirme mantığı ./oneriGrup'a taşındı; Strateji
  //    ekranı (DenetimModulu) da oradan besleniyor. Buradaki yerel kopya silindi.
  const enKritik = enKritikOneri(oneriler);

  return (
    <>
      {/* ══════════════════════════════════════════════════════════════════════
          🗂️ ROL: İSTİSNA ARŞİVİ — GÜNLÜK İŞ YÜZEYİ DEĞİL (2026-08-26 kurgusu)
          ══════════════════════════════════════════════════════════════════════
          Bu görünüm İKİNCİ bir "bugün" yüzeyi olmuştu: motorun en kritik önerisi,
          bekleyen onay ve ciro eksiği burada duruyordu — yani sahibin her sabah
          İKİ ayrı yere bakması gerekiyordu ve hangisinin asıl olduğu belirsizdi.
          İki "bugün" listesi olan bir sistemde ikisi de okunmaz.

          Dört sayacın hepsi ARTIK KARAR ALANI'NDAKİ KUYRUĞA besleniyor:
            · karar motoru  → S2 (en kritik öneri, faiz cümlesiyle)
            · onay merkezi  → S3
            · ciro eksiği   → S1
            · bildirimler   → 48 saatlik yük üzerinden zaten kuyrukta
          Buranın işi artık DERİNLİK: tam liste, geçmiş, gerekçe. */}
      <div style={{
        ...kartYuzey, padding: '10px 15px', marginBottom: 13, fontSize: 12,
        color: R.not2, borderLeft: `3px solid ${R.bakir}`,
      }}>
        🗂️ <b style={{ color: R.metin2 }}>Tam liste ve gerekçeler burada.</b>{' '}
        Günün işleri <b style={{ color: R.metin2 }}>Karar Alanı</b> sekmesindeki kuyrukta —
        buradaki dört sayaç oraya besleniyor, ikinci bir “bugün” listesi tutulmuyor.
      </div>
      <KpiSeridi kpiler={[
        { etiket: 'Karar motoru', deger: String(oneriler.length), alt: oneriler.length ? 'öneri bekliyor' : 'öneri yok', renk: oneriler.length ? R.bakir : R.yesil },
        { etiket: 'Onay merkezi', deger: String(onaylar.length), alt: onaylar.length ? 'karar bekliyor' : 'kuyruk boş', renk: onaylar.length ? R.amber : R.yesil },
        { etiket: 'Sistem bildirimi', deger: String(uyarilar.length), alt: 'uyarı defteri', renk: uyarilar.length ? R.amber : R.yesil },
        { etiket: 'Ciro eksiği', deger: String(ciroEksik.length), alt: ciroEksik.length ? 'gün girilmemiş' : 'eksik yok', renk: ciroEksik.length ? R.kirmizi : R.yesil },
      ]} />

      {/* N2 — KARAR MOTORU: tam liste değil ÖZET + kanonik ekrana yönlendirme.
          Hedef DOĞRULANDI: tema.js:143 panel modülünde 'strateji' görünümü var. */}
      <div
        {...(onKopru ? acilirBaslikOzellik(
          () => onKopru('__modul:panel:strateji'), null, 'Strateji Önerileri ekranını aç',
        ) : {})}
        style={{
          ...kartYuzey, padding: '13px 18px', marginBottom: 14,
          borderLeft: `3px solid ${oneriler.length ? R.bakir : R.yesil}`,
          cursor: onKopru ? 'pointer' : 'default', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: enKritik ? 8 : 0 }}>
          <IkonRozet yol={IK.islemci} renk={oneriler.length ? R.bakir : R.yesil} boyut={14} />
          <span style={{ fontFamily: F.baslik, fontSize: 14.5, fontWeight: 600 }}>
            {oneriler.length ? `Karar motorunda ${oneriler.length} öneri` : 'Karar motoru bugün öneri üretmedi'}
          </span>
          <span style={{ fontSize: 11, color: R.not2 }}>öneri-only · hüküm insanın</span>
          {onKopru && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: R.not3, whiteSpace: 'nowrap' }}>
              Strateji ekranında incele →
            </span>
          )}
        </div>
        {enKritik && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px',
            borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi2}`,
          }}>
            <span style={{
              flexShrink: 0, fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase',
              color: R.not3, fontWeight: 700, paddingTop: 2,
            }}>
              en kritiği
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: R.kirmizi, lineHeight: 1.3 }}>
                {kisalt(enKritik.baslik, 74)}
              </div>
              <div style={{ fontSize: 11, color: R.not2, marginTop: 2, lineHeight: 1.3 }}>
                {kisalt(enKritik.alt, 104)}
              </div>
            </div>
          </div>
        )}
      </div>

      <Bolum baslik="🔔 Onay merkezi" sayac={onaylar.length} renk={R.amber} not="KASA kayıtları hariç" cocuk={
        onaylar.length === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Onay bekleyen kayıt yok.</div>
          : <Liste
              satirlar={onaylar.slice(0, 10).map((o, i) => ({
                id: o.id || `oy-${i}`,
                baslik: kisalt(o.aciklama || o.islem_turu || 'Onay kaydı', 70),
                alt: `${String(o.islem_turu || '').toLowerCase().replace(/_/g, ' ')} · ${kisaGun(o.tarih)}`,
                tutar: sayi(o.tutar) ? fmt(sayi(o.tutar)) : '',
                tier: 'uyari',
                aksiyon: 'Onay Kuyruğu\'nda karar ver',
              }))}
              onAc={() => onKopru?.('__modul:onaylar:kuyruk')}
            />
      } />

      <Bolum baslik="📣 Sistem bildirimleri" sayac={uyarilar.length + mesajlar.length} renk={R.mavi} cocuk={
        (uyarilar.length + mesajlar.length) === 0
          ? <div style={{ fontSize: 12, color: R.not2 }}>Bildirim yok.</div>
          : <Liste
              /* 🟡 EVV-GENEL-N6 (2026-08-12): eskiden sırasız birleştirilip slice(0,12)
                 ediliyordu → bir feed ilk 12'yi doldurursa diğerinin daha YENİ/kritik
                 kaydı görünmeden düşüyordu. Önce tarih'e göre (yeni→eski) sırala. */
              satirlar={[...uyarilar, ...mesajlar]
                .sort((a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')))
                .slice(0, 12).map((u, i) => ({
                id: u.id || `u-${i}`,
                // 🔴 (2026-08-14) BİLDİRİMLER İSİMSİZDİ: başlık `mesaj` okuyordu ama
                // `mesaj` jenerik durum cümlesi ("4 gün sonra ödeme var.") — KİMİN
                // ödemesi olduğu `aciklama`da ("Vadeli Alım: Fatura X (FİRMA)").
                // Liste "4 gün sonra ödeme var" × 6 satır hâline geliyordu.
                // Artık alacaklı başlıkta, durum cümlesi alt satırda.
                baslik: kisalt(u.aciklama || u.mesaj || u.baslik || u.metin || 'Bildirim', 88),
                alt: [
                  // `aciklama` yoksa mesaj zaten başlığa çıktı → alt satırda tekrarlanmaz.
                  u.aciklama ? u.mesaj : null,
                  u.sube_ad || u.sube_adi,
                  u.tarih ? kisaGun(u.tarih) : null,
                ].filter(Boolean).join(' · ') || 'genel',
                tutar: sayi(u.tutar) ? fmt(sayi(u.tutar)) : '',
                tier: String(u.seviye || '').toUpperCase() === 'KRITIK' ? 'kritik'
                  : String(u.seviye || '').toUpperCase() === 'UYARI' ? 'uyari' : 'bilgi',
              }))}
            />
      } />

      <Bolum baslik="📉 Ciro eksikleri" sayac={ciroEksik.length} renk={ciroEksik.length ? R.kirmizi : R.yesil} not="ciro girilmemiş günler" cocuk={
        ciroEksik.length === 0
          ? <BosDurum tamam baslik="Ciro eksiği yok" aciklama="Tüm günlerin cirosu girilmiş." />
          /* 🔴 (2026-08-14) 'Şube' kolonu CANLIDA HEP "—" idi: uç gün bazında çalışıyor,
             alanları {tarih, gun_adi, days_ago, kritik} — ŞUBE KIRILIMI YOK. Var
             olmayan alanı kolon yapmak yerine ucun gerçekten verdiği bilgi gösterilir:
             hangi gün, ne kadar zaman önce. */
          : <Tablo
              baslik=""
              not={ciroEksik.length > 15 ? `ilk 15 / ${ciroEksik.length} gün` : null}
              kolonlar={[{ ad: 'Gün' }, { ad: 'Tarih' }, { ad: 'Durum' }]}
              satirlar={ciroEksik.slice(0, 15).map((g, i) => ({
                id: `ce-${i}`,
                hucreler: [
                  { v: gunTr(g.gun_adi), kalin: true },
                  // "0 gün önce" saçma okunuyordu → bugünse "bugün" yazılır.
                  { v: `${kisaGun(g.tarih)} · ${sayi(g.days_ago) === 0 ? 'bugün' : `${sayi(g.days_ago)} gün önce`}`, mono: true, renk: R.not },
                  { v: g.kritik ? 'kritik' : 'eksik', rozet: g.kritik ? R.kirmizi : R.amber },
                ],
              }))}
              onSatir={() => onKopru?.('__modul:para:girisi')}
            />
      } />
    </>
  );
}
