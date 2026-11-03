// 📦 MİKTAR YAZISI — TEK yer (adım 149, Fable L4b): panel (subepanel/ortak.jsx yeniden dışa verir) ve merkez (Depo) aynısını kullanır.
// "2 paket (100 tane)" · adet biriminde "5 adet". u = {birim, sayim_ici} (sunucudan; ekran tahmin etmez).
export const miktarYazi = (n, u) => {
  const b = u?.birim || 'adet';
  if (b === 'adet') return `${n} adet`;
  return `${n} ${b}${u?.sayim_ici ? ` (${n * u.sayim_ici} tane)` : ''}`;
};
