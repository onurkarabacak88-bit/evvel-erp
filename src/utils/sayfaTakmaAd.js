// Sayfa takma adları — PAGES anahtarı OLMAYAN, ama Operasyon Merkezi'nin belirli
// bir sekmesini hedefleyen kısayollar. Sekme seçimi sessionStorage üzerinden
// devredilir (OperasyonMerkezi mount'ta `ops_merkez_ac_sekme`'yi okur ve
// MODULLER içinde o sekmeyi barındıran modülü açar).
//
// ⚠️ App.jsx'te HEM readPageFromHash() HEM navigate() bu çözümlemeden geçmek
// ZORUNDA. v2 kabuğu (TasarimV2) köprülemede navigate() kullanıyor; alias yalnız
// hash tarafında çözülürse köprü sessizce CFO Panel'e düşer (yaşanmış hata).

/** Takma ad → gerçek sayfa id. Takma ad değilse id aynen döner. */
export function resolvePageAlias(id) {
  if (id === 'sevkiyat-hazirlama') {
    try {
      sessionStorage.setItem('ops_merkez_ac_sekme', 'siparis-kontrol');
      sessionStorage.setItem('ops_kontrol_kulesi_gorunum', 'depo');
      const sid = sessionStorage.getItem('ops_sevkiyat_hazirlama_sube_id');
      if (sid) {
        sessionStorage.setItem('ops_kontrol_kulesi_depo', sid);
        sessionStorage.removeItem('ops_sevkiyat_hazirlama_sube_id');
      }
    } catch (_) {}
    return 'ops-merkez';
  }
  // Gün sonu kapanış TAKİBİ — kapatma işlemi değil, kapanışın izlendiği ekran.
  // (Kapanışı kasa kimdeyse o yapar: şubede 5 adımlı mühür/QR akışı.)
  if (id === 'kapanis-takip') {
    try {
      sessionStorage.setItem('ops_merkez_ac_sekme', 'kapanis-takip');
    } catch (_) {}
    return 'ops-merkez';
  }
  return id;
}

export default resolvePageAlias;
