// ─────────────────────────────────────────────────────────────────────────────
// MOTOR ÖNERİLERİ — KRİTİK NAKİT GRUPLAMA (tek yer)
//
// SORUN: motor, serbest nakde sığmayan HER kart için ayrı bir "NAKİT YETERSİZ"
// önerisi üretiyor. Aynı TEK sebep (para yetmiyor) listede 5-6 kez tekrar edip
// diğer önerileri aşağı itiyor — sahip "altı ayrı sorun" sanıyor.
//
// NEDEN BURADA: bu birleştirme önce yalnız Bakış'ın bildirim sekmesinde vardı;
// önerilerin KANONİK ekranı ise Strateji (DenetimModulu). Aynı mantığı iki
// dosyaya kopyalamak "birinde düzeltilen tuzak diğerinde kalır" demek — bu
// yüzden mantık dışarı alındı, iki ekran da BURADAN besleniyor.
//
// ⚠️ TUTAR YAZILMAZ: uç bu önerilerde `tavsiye_tutar = 0` gönderiyor; istenen
// tutar yalnız açıklama METNİNİN içinde geçiyor. Metinden para PARSE ETMEK
// yasak (biçim değişince sessizce yanlış rakam basar) — grup satırı tutarsız
// durur, tutarlar tek tek kartların kendi kayıtlarında görülür.
// ─────────────────────────────────────────────────────────────────────────────

export const KRITIK_NAKIT = 'KRITIK_NAKIT';

/** Grup EN AZ İKİ öneriden kurulur: tek kalemi "grup" yapmak bilgi kazandırmaz,
 *  yalnız bir kademe fazla tıklama ekler. */
export const GRUP_ALT_SINIR = 2;

/**
 * Öneri listesini kritik-nakit / diğer diye ayırır.
 * @returns {{grup: any[], diger: any[], kartlar: string[], birlesir: boolean}}
 */
export function kritikNakitAyir(oneriler) {
  const liste = Array.isArray(oneriler) ? oneriler : [];
  const grup = liste.filter((o) => String(o?.oneri_turu || '') === KRITIK_NAKIT);
  const diger = liste.filter((o) => String(o?.oneri_turu || '') !== KRITIK_NAKIT);
  const kartlar = grup.map((o) => o?.kart_adi || o?.banka).filter(Boolean);
  return { grup, diger, kartlar, birlesir: grup.length >= GRUP_ALT_SINIR };
}

/** Grup satırının başlığı — "kaç kart" sorusunun cevabı başlıkta durur. */
export const kritikNakitBaslik = (grup) => `NAKİT YETERSİZ — ${(grup || []).length} kart`;

/** Grup satırının gerekçesi + hangi kartlar olduğu. */
export const kritikNakitAlt = (kartlar) => (
  `serbest nakit bu ödemelere yetmiyor${(kartlar || []).length ? ` · kartlar: ${kartlar.join(', ')}` : ''}`
);

/** Çekmece/liste için kart dökümü — motorun gönderdiği alanlardan, uydurma yok. */
export const kritikNakitKartSatirlari = (grup) => (grup || []).map((o, i) => ({
  ad: o.kart_adi || o.banka || `Kart ${i + 1}`,
  detay: o.banka || 'banka bilgisi yok',
  tutar: o.tarih ? String(o.tarih).slice(0, 10) : '—',
}));

/**
 * "En kritik tek satır" — Bakış'ın özet kartı için.
 * Kritik-nakit grubu varsa O öne çıkar (tek sebep, en çok kart); yoksa listenin
 * ilk KIRMIZI önerisi, o da yoksa ilk öneri. Hiç öneri yoksa null.
 */
export function enKritikOneri(oneriler) {
  const { grup, diger, kartlar, birlesir } = kritikNakitAyir(oneriler);
  if (birlesir) {
    return { baslik: kritikNakitBaslik(grup), alt: kritikNakitAlt(kartlar), grupMu: true, _grup: grup };
  }
  const havuz = [...grup, ...diger];
  if (!havuz.length) return null;
  const kirmizi = havuz.find((o) => String(o?.renk || '').toUpperCase() === 'KIRMIZI');
  const o = kirmizi || havuz[0];
  return {
    baslik: String(o.baslik || o.oneri || o.aciklama || 'Öneri'),
    alt: String(o.aciklama || o.detay || o.gerekce || 'gerekçe yok'),
    grupMu: false,
    _o: o,
  };
}
