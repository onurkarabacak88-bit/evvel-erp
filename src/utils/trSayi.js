// TR tutar okuyucu — TEK KAYNAK (tekrar denetimi C-T4-01 + Dalga 1 denetimi C1: 7 ayrı kopya vardı; Kredi/Mülk "1.250,50" → 0).
// "12,50" · "12.50" · "1.250,00" olur. bos: boş girdi ne dönsün (0 ya da null). Okunamazsa NaN (sessiz 0 YOK — çağıran uyarır).
export const sayiTR = (x, bos = 0) => {
  const t = String(x ?? '').trim().replace(/\s/g, '');
  if (!t) return bos;
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : NaN;
};
