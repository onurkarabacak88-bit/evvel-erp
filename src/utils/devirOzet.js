// 🔄 KASA DEVRİ özet yazıları — TEK kaynak (Dalga 5, F#62: panel KasaDevri, telefon 2 yer, merkez Yoklama ayrı yazıyordu).
// Görünüş (kart / satır) her uygulamada kendi stilinde kalır; yalnız YAZI buradan.
/** [{ad, sayilan}] → "8oz 12 · 14oz 30" (boşsa —) */
export const kalemYazi = (l) => (l || []).map((u) => `${u.ad} ${u.sayilan}`).join(' · ') || '—';
/** bardak listesi kısa: "8oz 12 / 14oz 30" (adın başındaki 'bardak' düşer) */
export const bardakOzet = (b) => (b || []).map((x) => `${String(x.ad || '').replace(/^bardak\s*/i, '') || 'bardak'} ${x.sayilan}`).join(' / ');
