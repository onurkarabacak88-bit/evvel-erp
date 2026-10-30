// 🔐 ROL / İZİN — ekran tarafının TEK kaynağı (sahip 30 Eki: "bütün basamaklar tek tek · sök-tak · telefondan da aynı kapı").
// Sunucu: evvel_yeni_yetki.py (/api/evvel-yeni/yetki/ben). Menü, sayfa, düğme ve /cep kartları BURADAN süzülür — ikinci liste yok.
// hepsi=true (ortak yönetim girişi · sahip · gözlem kipi) → süzme yok. Sunucu da aynı kuralı uygular (ekranda gizlemek tek başına güvenlik değil).
let IZ = { hepsi: false, izinler: {}, sayfa_anahtar: {} };   // izin gelene kadar HİÇBİR sayfa (bir an tam menü sızmasın)

export const izinAyarla = (d) => { IZ = { hepsi: !!d?.hepsi, izinler: d?.izinler || {}, sayfa_anahtar: d?.sayfa_anahtar || {} }; };

// Sayfa görünür mü: sözlükte o sayfaya bağlı anahtarlardan biri 'gor' ise. Sözlükte olmayan sayfa (telefon ana sayfası) hep açık.
export const sayfaGorunur = (id) => {
  if (IZ.hepsi) return true;
  const a = IZ.sayfa_anahtar[id];
  if (!a) return id === 'cep_ana';
  return a.some((k) => IZ.izinler[k] === 'gor');
};

// İşlem düğmesi: 'a|b' — biri 'yap' ise.
export const izinVar = (ifade) => IZ.hepsi || String(ifade).split('|').some((k) => IZ.izinler[k] === 'yap' || IZ.izinler[k] === 'gor');
export const yapabilir = (ifade) => IZ.hepsi || String(ifade).split('|').some((k) => IZ.izinler[k] === 'yap');
