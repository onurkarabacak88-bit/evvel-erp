// Ortak CSV dışa aktarım yardımcısı — UTF-8 BOM'lu, TR Excel uyumlu (";" ayraç)
// Kullanım:
//   listeyiCsvIndir(satirlar, [{ key: 'ad', baslik: 'Ad' }, ...], 'dosya')

function hucreKacis(deger) {
  if (deger == null) return '';
  let s = String(deger);
  // Satır içi noktalı virgül / tırnak / yeni satır varsa tırnakla
  if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * @param {Array<Object>} satirlar  Veri satırları
 * @param {Array<{key:string, baslik:string, fn?:(satir:Object)=>any}>} kolonlar  Kolon tanımları
 * @param {string} dosyaAdi  Uzantısız dosya adı
 */
export function listeyiCsvIndir(satirlar, kolonlar, dosyaAdi = 'liste') {
  if (!Array.isArray(satirlar) || !Array.isArray(kolonlar)) return;

  const baslikSatiri = kolonlar.map((k) => hucreKacis(k.baslik ?? k.key)).join(';');
  const govde = satirlar.map((satir) =>
    kolonlar
      .map((k) => {
        const ham = typeof k.fn === 'function' ? k.fn(satir) : satir?.[k.key];
        return hucreKacis(ham);
      })
      .join(';')
  );

  const icerik = [baslikSatiri, ...govde].join('\r\n');
  // UTF-8 BOM (Excel'in Türkçe karakterleri doğru okuması için)
  const bom = '﻿';
  const blob = new Blob([bom + icerik], { type: 'text/csv;charset=utf-8;' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const tarih = new Date().toISOString().slice(0, 10);
  a.download = `${dosyaAdi}_${tarih}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
