// TR tutar okuyucu — TEK KAYNAK (tekrar denetimi C-T4-01 + Dalga 1 denetimi C1: 7 ayrı kopya vardı; Kredi/Mülk "1.250,50" → 0).
// "12,50" · "12.50" · "1.250,00" · "1.250" (Türkçe bin ayıracı = 1250) olur — sunucudaki çekirdek tutar_oku ile AYNI kural (Codex P2:
// "1.250" burada 1,25, sunucuda 1.250 okunuyordu). bos: boş girdi ne dönsün (0 ya da null). Okunamazsa NaN (sessiz 0 YOK).
export const sayiTR = (x, bos = 0) => {
  if (typeof x === 'number') return Number.isFinite(x) ? x : NaN;
  let t = String(x ?? '').trim().replace(/\s/g, '').replace('₺', '');
  if (!t) return bos;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1 || /^\d+\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
