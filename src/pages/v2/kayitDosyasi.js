// ─────────────────────────────────────────────────────────────────────────────
// KAYIT DOSYASI KÖPRÜSÜ — çekmecelere iz + belge bağlayan TEK yardımcı.
//
// Dalga 1'de bu mantık GenelModulu içinde duruyordu; Dalga 2'de Ödeme, Borç ve
// Kart çekmeceleri de bağlanınca 4 kopya olacaktı. Kopyalar zamanla ayrışır
// (birinde düzeltilen tuzak diğerinde kalır) → tek yere alındı.
//
// Kapsadığı dört tuzak (hepsi canlıda yaşandı, hepsi testli):
//   1. GEÇ YANIT: fetch dönerken çekmece kapanmış ya da başka kayda geçilmiş
//      olabilir. Fonksiyonel merge ile state'in KENDİSİNE sorulur:
//        · prev null (kapalı)      → null kalır, çekmece kendi kendine AÇILMAZ
//        · prev başka kayıt        → dokunulmaz
//        · aynı kayıt              → merge (eski alanlar korunur)
//      (onCekmece = setCekmece, TasarimV2.jsx:764/767/781/798 — sarmalayıcı yok.)
//   2. KİMLİK: başlık kesilmiş görüntü metnidir, iki kayıtta aynı olabilir →
//      karşılaştırma `_kayitId` üzerinden yapılır, başlıkla DEĞİL.
//   3. HATA ≠ BOŞ: okuma düşerse "iz yok" demek sahte bilgidir; ayrı düğüm.
//   4. HAYALET LİSTE: `belgeler` her durumda yazılır ([] de meşru cevaptır),
//      yoksa yükleme sonrası eski liste ekranda kalır.
// ─────────────────────────────────────────────────────────────────────────────
import { api, fmt } from '../../utils/api';

/** Backend'in tanıdığı kayıt tipleri (kayit_dosyasi_api.TIPLER ile birebir).
 *  Listede olmayan kaynak (null, 'ekstre_import' vb.) için fetch HİÇ yapılmaz —
 *  sunucuya 400 attırıp çekmeceyi kirletmenin anlamı yok. */
export const KAYIT_TIPLERI = [
  'vadeli_alimlar', 'borc_envanteri', 'sabit_giderler',
  'cari_odeme', 'personel', 'kartlar',
];

export const kayitTipiDestekli = (t) => KAYIT_TIPLERI.includes(String(t || ''));

/**
 * 🔗 "Cari ekstresi →" aksiyonu — kayıt bir TEDARİKÇİ taşıyorsa üretilir.
 * Parametreli köprü: '__modul:belge:cari:<encodeURIComponent(ad)>' — hedef ekran
 * (BelgeModulu 'cari') bu adı seçer. Ad listede yoksa SESSİZCE yanlış tedarikçiye
 * düşmez; orada uyarı verilip otomatik seçime dönülür (köprü hedefi doğrulanır).
 * Tedarikçi adı çıkarılamıyorsa null döner → düğme HİÇ çıkmaz.
 */
export function cariEkstreAksiyonu({ kayit, onKopru }) {
  const ad = String(
    kayit?.tedarikci || kayit?.tedarikci_ad || kayit?.toptanci || '',
  ).trim();
  if (!ad || !onKopru) return null;
  return {
    ad: 'Cari ekstresi →',
    onTikla: () => onKopru(`__modul:belge:cari:${encodeURIComponent(ad)}`),
  };
}

const sayi = (v) => Number(v) || 0;

/**
 * Çekmeceye iz + belgeleri sonradan doldurur (çekmece ÖNCE açılır, veri arkadan gelir).
 *
 * @param onCekmece  modülün onCekmece prop'u (= setCekmece)
 * @param tip        çekmecenin `tip` alanı — merge'de tip de doğrulanır
 * @param kaynakTablo/kaynakId  KESİN ikili; ikisi de olmadan çağrılmaz
 * @param kayitId    bu çekmecenin benzersiz kimliği (`_kayitId` olarak yazılır)
 * @param renkler    { kirmizi, amber } — tema renkleri modülden geçer (bu dosya temasız)
 */
export function kayitDosyasiYukle({ onCekmece, tip, kaynakTablo, kaynakId, kayitId, renkler = {} }) {
  if (!kayitTipiDestekli(kaynakTablo) || !kaynakId) return;
  const kirmizi = renkler.kirmizi || '#F87171';
  const amber = renkler.amber || '#FBBF24';
  const beklenen = String(kayitId);

  // 🔴 ARTIŞ SATIRI BOYAMA (2026-08-15, sahip: "izde ödemeleri VE artışları
  // görmem daha uygun, tarih tarih").
  // Backend her iz satırına `yon` ('artis' | 'odeme') basar; '+' öneki de ORADA
  // metne gömülür. Burada YALNIZ görsel eşleme var — hangi satırın artış olduğuna
  // FE karar VERMEZ (tutar işaretine/açıklamaya bakıp tahmin etmek, backend
  // kuralı değişince sessizce yanlış boyardı). Backend renk gönderirse o kazanır.
  const izBoya = (a) => (
    a?.renk ? a : (a?.yon === 'artis' ? { ...a, renk: amber } : a)
  );

  api(`/kayit-dosyasi?kaynak_tablo=${encodeURIComponent(kaynakTablo)}`
      + `&kaynak_id=${encodeURIComponent(kaynakId)}`)
    .catch(() => '__HATA__')
    .then((d) => {
      let iz;
      let belgeler = [];
      if (d === '__HATA__') {
        iz = [{
          ad: 'İz alınamadı', bekliyor: true, renk: kirmizi,
          detay: 'sunucuya ulaşılamadı — çekmeceyi kapatıp tekrar açın',
        }];
      } else {
        const ham = Array.isArray(d?.iz) ? d.iz : [];
        belgeler = Array.isArray(d?.belgeler) ? d.belgeler : [];
        if (d?.iz_hata) {
          iz = [{
            ad: 'İz okunamadı', bekliyor: true, renk: kirmizi,
            detay: 'kayıt defteri sorgusu hata verdi — "iz yok" DEĞİL, bilinmiyor',
          }];
        } else if (ham.length) {
          iz = [
            // Kısmi ödeme gerçektir: kalan varsa en başa bekleyen düğüm.
            // ("Kalan bekliyor" TEPE DÜĞÜMÜ artışlar eklendikten sonra da kalır —
            //  kalan yalnız ödemelerden hesaplanır, artışlar onu değiştirmez.)
            ...(sayi(d.kalan) > 0 ? [{
              ad: `Kalan ${fmt(sayi(d.kalan))}`,
              detay: 'bu kayıttan ödenmesi bekleniyor', bekliyor: true,
            }] : []),
            ...ham.map(izBoya),
          ];
        } else {
          iz = [{
            ad: d?.aday_var_olabilir
              ? 'Kesin iz yok — bu kayıt gerçekten ödenmemiş görünüyor'
              : 'Bu kayda bağlı ödeme kaydı yok',
            detay: d?.aday_var_olabilir
              ? 'kimlik bağı taşıyan hareket bulunamadı; dedektif taraması öneri üretebilir'
              : 'ödeme yapıldığında burada listelenir',
            bekliyor: true,
          }];
        }
        if (d?.belge_hata) {
          belgeler = [{
            tur: 'HATA', ad: 'Belgeler okunamadı',
            detay: 'sorgu hata verdi — "belge yok" değil, bilinmiyor', rozet: 'HATA',
          }];
        }
      }
      onCekmece?.((prev) => (
        prev && prev.tip === tip
        && prev._kayitId != null && String(prev._kayitId) === beklenen
          ? { ...prev, iz, belgeler }
          : prev
      ));
    })
    .catch(() => { /* zincir hatası çekmeceyi bozmasın — özet zaten açık */ });

  // ── 🔍 DEĞİŞİKLİK GEÇMİŞİ (SYS-AUDIT, 2026-09-02) ────────────────────────
  // AYRI çağrı, AYRI merge: kayıt dosyası ucu düşse bile geçmiş gelebilmeli
  // (ve tersi). İkisini tek Promise.all'a bağlamak, birinin arızasını
  // diğerinin boşluğu gibi gösterirdi — "hata ≠ boş" kuralının aynısı.
  //
  // ⚠️ `iz` ≠ `gecmis`: iz PARANIN hareketi, gecmis KAYDIN değişimi. Denetim
  // defterinde bu 6 tablonun 5'inin gerçekten izi var (cari_odeme'ye audit()
  // çağrısı yok — orada dürüst "iz yok" metni çıkar, sahte satır üretilmez).
  const gecmisMerge = (g) => onCekmece?.((prev) => (
    prev && prev.tip === tip
    && prev._kayitId != null && String(prev._kayitId) === beklenen
      ? { ...prev, gecmis: g }
      : prev
  ));
  gecmisMerge({ durum: 'yukleniyor', satirlar: [] });
  api(`/denetim-izi/kayit/${encodeURIComponent(kaynakTablo)}`
      + `/${encodeURIComponent(kaynakId)}?limit=50`)
    .then((d) => {
      // Uç 200 dönüp `okunabildi:false` diyebilir (şema geride / sorgu düştü).
      // Bunu "geçmiş yok" saymak, defterde yazanı ekranda yok göstermektir.
      if (!d || d.okunabildi === false) {
        gecmisMerge({ durum: 'hata', satirlar: [], not: d?.not || '' });
        return;
      }
      gecmisMerge({
        durum: 'tamam',
        satirlar: Array.isArray(d.satirlar) ? d.satirlar : [],
        kirpildi: !!d.kirpildi,
      });
    })
    .catch(() => gecmisMerge({ durum: 'hata', satirlar: [] }));
}

/**
 * Belge yükleyici üretir (Cekmece'nin `belgeYukle` prop'u).
 * Bağ kurulamıyorsa null döner → düğme HİÇ çıkmaz (işlevsiz düğme göstermeyiz).
 *
 * ⚠️ PDF ≠ FOTO: iki AYRI boru hattı var. PDF /yukle-pdf'te sayfalara bölünüp
 * metinden okunur (vision yok); foto /yukle'de OCR'a girer. Her dosyayı 'foto'
 * alanıyla göndermek PDF'i yanlış hatta sokup "taranmış PDF" hatasına düşürür.
 */
export function belgeYukleyiciUret({ onCekmece, tip, kaynakTablo, kaynakId, kayitId, renkler }) {
  if (!kayitTipiDestekli(kaynakTablo) || !kaynakId) return null;
  return async (dosya) => {
    const ad = String(dosya?.name || '').toLowerCase();
    const pdfMi = ad.endsWith('.pdf') || (dosya?.type || '').toLowerCase() === 'application/pdf';
    const fd = new FormData();
    fd.append(pdfMi ? 'pdf' : 'foto', dosya);
    fd.append('kaynak_tablo', kaynakTablo);
    fd.append('kaynak_id', String(kaynakId));
    const r = await fetch(pdfMi ? '/api/fatura/yukle-pdf' : '/api/fatura/yukle',
      { method: 'POST', body: fd });
    if (!r.ok) {
      // Hata metnini sunucudan al — "yüklenemedi" yetmez, NEDEN önemli
      // (mükerrer belge freni 409 ile anlamlı bir cümle döndürüyor).
      let mesaj = `Yükleme başarısız (${r.status})`;
      try { const j = await r.json(); mesaj = j?.detail || j?.mesaj || mesaj; } catch { /* metin değil */ }
      throw new Error(mesaj);
    }
    kayitDosyasiYukle({ onCekmece, tip, kaynakTablo, kaynakId, kayitId, renkler });
  };
}
