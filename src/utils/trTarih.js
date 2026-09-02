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
