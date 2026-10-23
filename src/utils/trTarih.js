/**
 * 🕐 TR TARİH — tarayıcıda "bugün hangi gün" sorusunun TEK cevap yeri.
 *
 * NEDEN VAR (PANEL-010 / PARA-006, 2026-09-02):
 *   Ekranlarda 41 yerde `new Date().toISOString().split('T')[0]` yazıyordu.
 *   `toISOString()` UTC verir. Türkiye UTC+3 olduğu için gece 00:00–03:00
 *   arasında bu ifade BİR ÖNCEKİ GÜNÜ döndürür.
 *
 *   Sonucu somut: kapanışı 00:30'da yapan şube, ciro formunu açtığında tarih
 *   alanında DÜNÜ görür. Kimse fark etmezse ciro yanlış güne yazılır — ve
 *   sunucunun "gelecek tarih" koruması bunu yakalayamaz, çünkü sapma GEÇMİŞE
 *   doğrudur. Kahve zincirinde kapanışlar tam o saatlerde yapılır; yani hata
 *   nadir değil, en sık kullanılan saatte oluşur.
 *
 *   Backend zaten hizalıydı: `database.db()` her oturumda
 *   `SET TIME ZONE 'Europe/Istanbul'` uyguluyor ve `tr_saat.bugun_tr()` var.
 *   Eksik olan tarayıcı tarafıydı.
 *
 * ⚠️ `Intl` kullanıyoruz, elle +3 saat EKLEMİYORUZ: yaz saati uygulaması
 *    değişirse sabit ofset sessizce yanlışa döner. Saat dilimi kuralını
 *    bilen tek yer platformun kendisidir.
 *
 * ⚠️ HER `toISOString()` TARİH DEĞİLDİR. Zaman damgası, dosya adı ve sıralı
 *    anahtar kullanımları UTC KALMALI — onları TR'ye çevirmek başka bir hata
 *    olurdu. Bu dosya yalnız "hangi GÜN" sorusunu cevaplar.
 */

const TR = 'Europe/Istanbul';

/** Verilen Date'in TR karşılığı — 'YYYY-MM-DD'. */
export function tarihTR(d) {
  const _d = d instanceof Date ? d : new Date(d || Date.now());
  try {
    // en-CA biçimi zaten YYYY-MM-DD verir; elle parçalamaya gerek yok.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TR, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(_d);
  } catch (_) {
    // Intl yoksa UTC'ye düşeriz — ama SESSİZCE değil.
    try { console.warn('trTarih: Intl kullanılamadı, UTC tarihe düşüldü'); } catch (_e) {}
    return _d.toISOString().slice(0, 10);
  }
}

/** Bugünün TR iş günü — 'YYYY-MM-DD'. */
export function bugunTR() {
  return tarihTR(new Date());
}

/** TR'ye göre `gun` kadar önce/sonra — 'YYYY-MM-DD'. */
export function tarihKaydir(gun) {
  const d = new Date();
  d.setDate(d.getDate() + Number(gun || 0));
  return tarihTR(d);
}

/** Ayın ilk günü (TR) — 'YYYY-MM-01'. */
export function ayBasiTR() {
  return `${bugunTR().slice(0, 7)}-01`;
}

/** Bu ay — 'YYYY-MM'. */
export function ayTR() {
  return bugunTR().slice(0, 7);
}

/** 'YYYY-MM-DD' + n gün → 'YYYY-MM-DD' (takvim aritmetiği, saat dilimi bağımsız — öğlen UTC üzerinden). Dalga 5 (F#56, C-T4-05):
 *  panel "dün", Ödeme / Satış gün oklarında ayrı ayrı yazılıydı. */
export function gunKaydir(ymd, n) {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' + n ay → 'YYYY-MM'. */
export function ayKaydir(ay, n) {
  const t = Number(String(ay).slice(0, 4)) * 12 + Number(String(ay).slice(5, 7)) - 1 + Number(n || 0);
  return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// Ay / gün ADLARI ve gün yazımı — TEK kaynak (Dalga 5, T4-03/T4-04/F#65: Kasa 3, AyTakvim, Ödeme, Bar, panel ayrı dizi / split tutuyordu)
export const AY_UZUN = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const AY_KISA = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
export const GUN_UZUN = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
export const GUN_KISA = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
/** 'YYYY-MM' → 'Ekim 2026' */
export const ayAdi = (ym) => { const [y, m] = String(ym || '').split('-'); return m ? `${AY_UZUN[Number(m) - 1]} ${y}` : ''; };
/** 'YYYY-MM-DD' → '20.10.2026' */
export const tarihNokta = (ymd) => String(ymd || '').slice(0, 10).split('-').reverse().join('.');
// 'YYYY-AA-GG[T ]SS:DD…' → 'GG.AA SS:DD' (S-B3: ekranda AY.GÜN / ISO kesiği yazılıyordu)
export const ggaaSaat = (z) => { const t = String(z || ''); return t.length >= 16 ? `${t.slice(8, 10)}.${t.slice(5, 7)} ${t.slice(11, 16)}` : t; };
/** 'YYYY-MM-DD' → haftanın günü kısa adı (öğlen üzerinden — saat dilimi kaymaz) */
export const gunKisa = (ymd) => GUN_KISA[new Date(`${String(ymd).slice(0, 10)}T12:00:00`).getDay()];

