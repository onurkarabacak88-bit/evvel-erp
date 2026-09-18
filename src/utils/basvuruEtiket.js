// İş Başvurusu — ORTAK ETİKET SÖZLÜĞÜ + OKUMA YARDIMCILARI
//
// ⚠️ NEDEN BU DOSYA VAR (2026-09-18, sahip bulgusu):
// Kadife (v2) başvuru ekranı, kayıtta OLMAYAN alan adlarını okuyordu —
// `sube_tercihi` / `deneyim` / `olusturma` diye soruyordu ama veritabanındaki
// adlar `tercih_subeler` / `kahve_deneyim` / `olusturma_ts`. Yanlış kapıyı
// çaldığı için 120 başvurunun HEPSİNDE "ayrıntı girilmemiş" yazıyordu ve
// "Yönet" penceresinde adayın doldurduğu formdan TEK SATIR görünmüyordu.
//
// Kural: başvuru alanlarının insan diline çevirisi TEK yerde durur. Klasik
// ekran (IsBasvuruListesi.jsx) ve Kadife ekranı (v2/EkipModulu.jsx) aynı
// sözlükten okur — biri güncellenip diğeri geride kalamaz.

export const DURUM_ETIKET = {
  bekliyor: 'Bekliyor', gorusme: 'Görüşme', olumlu: 'Olumlu', olumsuz: 'Olumsuz',
};

export const DENEYIM_LABEL = { var_1yil: '1 yıldan az', var_2yil: '1–3 yıl', var_uzun: '3+ yıl', kismi: 'Biraz biliyor', yok_ogreneyim: 'Yeni başlayacak' };
export const BASLANGIC_LABEL = { hemen: '⚡ Hemen', '2hafta': '📅 2 Hafta', '1ay': '🗓️ 1 Ay' };
export const CALISMA_LABEL = { tam: 'Tam Zamanlı', yari: 'Yarı Zamanlı', esnek: 'Esnek' };
export const YASAM_LABEL   = { aile: '🏠 Aileyle', yurt: '🏫 Yurtta', arkadas: '👥 Arkadaşlarla', tek: '🔑 Tek başına' };
export const EGITIM_LABEL  = { lise: '📚 Lise öğrencisi', universite: '🎓 Üniversite', mezun: '✅ Mezun', calisiyor: '💼 Çalışıyor+part-time', diger: '✨ Diğer' };
export const ULASIM_LABEL  = { yurume: '🚶 Yürüme', toplu: '🚌 Toplu taşıma', arac: '🚗 Araç/moto', bisiklet: '🚲 Bisiklet' };
export const NEDEN_LABEL   = { part_time: '💰 Ek gelir', tam_zamanli: '💼 Kariyer', barista: '☕ Barista olmak', deneyim: '📈 Deneyim', insan: '🙋 İnsanlarla çalışmak', diger: '✨ Diğer' };
export const TEMPO_LABEL   = { hizli: '⚡ Hızlı tempo', sakin: '🌿 Sakin', ikisi: '😄 İkisi de olur' };

export const NEREDE_LABEL    = { kurumsal: '🏢 Kurumsal zincir', yerel_bagimsiz: '☕ Yerel/bağımsız', sektor_disi: '🔄 Sektör dışı', hic_calismadim: '🌱 İlk iş' };
export const OGRENILEN_LABEL = { musteri_iletisim: '💬 Müşteri iletişimi', hiz_tempo: '⚡ Hız & tempo', duzen_temizlik: '🧹 Düzen & temizlik ✅', takim: '🤝 Takım çalışması', tek_sorumluluk: '🎯 Tek sorumluluk', cok_ogrenmedim: '🤷 Az öğrendi ⚠️' };
export const EN_IYI_LABEL    = { musteri_insan: '👥 Müşteri ilişkileri', tempolu_ortam: '🏃 Tempolu ortam ✅', ogrenme: '📚 Öğrenme fırsatı', ekip: '💪 Ekip', para_bagimsizlik: '💰 Para/bağımsızlık' };
export const EN_ZOR_LABEL    = { uzun_saatler: '⏰ Uzun saatler 🚩', zor_musteriler: '😤 Zor müşteriler ⚠️', dusuk_ucret: '💸 Düşük ücret', yonetim_sorun: '🚧 Yönetim sorunu ⚠️', monoton: '😴 Monoton' };
export const MAKINE_LABEL    = { hemen_siler: 'Hemen siler ✅', vardiya_sonu: 'Vardiya sonunda', kime_duserse: 'Kime düşerse', pek_dusunmem: 'Düşünmemiş ⚠️' };
export const YOGUN_LABEL     = { araliklarda: 'Aralıklarda toplar ✅', rush_bitti: 'Rush sonrası', oldugu_gibi: 'Bırakır', fark_etmez: 'Fark etmez ⚠️' };
export const GUNPLAN_LABEL   = { esnek_akis: 'Esnek ✅', plan_degisir: 'Esnek ama planlı', saatler_belli: 'Saate bağlı', onceden_netlesin: 'Katı plan 🚩' };
export const ARKADASLAR_LABEL = { her_an_hazir: 'Her an hazır ✅', sakin_olculu: 'Sakin & ölçülü', kendi_isine: 'Kendi işine bakan', haklarini_bilen: 'Haklarını bilen 🚩' };
export const SOSYAL_LABEL    = { dogal_isinirim: 'Doğal ısınır ✅', zaman_lazim: 'Zaman ister', karsi_baslasın: 'Bekleme', pek_rahat_degil: 'Zor ⚠️' };
export const MUSTERI_LABEL   = { adini_ogrenip: 'Adını öğrenir ✅', selam_sorar: 'Selamlayıp sorar', hizlica_hazirlar: 'Hızlı geçer', hepsi_ayni: 'Fark etmez ⚠️' };
export const SABAH_LABEL     = { kahve_icer: 'Gelir ✅', zor_gelir: 'Zor ama gelir', izin_dusunur: 'İzin düşünür 🚩', duruma_gore: 'Duruma göre' };
export const YORUCU_LABEL    = { beklenmedik: 'Sürprizler', isler_uzayinca: 'Uzayan işler ⚠️', plan_disi: 'Plan dışı ⚠️', gunun_sonu: 'Günün sonu' };

// ── Küçük okuyucular ────────────────────────────────────────────────────────

const cev = (sozluk, v) => (v == null || v === '' ? null : (sozluk[v] || String(v)));

/** Dizi ya da JSON metni olabilen alanı güvenle diziye çevirir. */
export function dizi(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  }
  return [];
}

/** Başvuru okunmuş mu? Okunmamışlık DURUM değil, GÖRÜLDÜ İZİ ile belirlenir. */
export const okunmadi = (b) => !b?.goruldu_ts;

export const tercihSubeMetni = (b) => dizi(b?.tercih_subeler).join(', ') || null;
export const musaitGunMetni  = (b) => dizi(b?.musait_gunler).join(', ') || null;

export const yasHesapla = (b) => (b?.dogum_yili ? new Date().getFullYear() - Number(b.dogum_yili) : null);

/**
 * Liste satırının ALT metni — adayı tek bakışta tanıtan özet.
 * ⚠️ Buradaki alan adları veritabanı şemasıyla birebir aynıdır; uydurma ad
 * eklenirse satır yine sessizce boşalır (bu dosyanın var oluş sebebi).
 */
export function basvuruSatirOzeti(b) {
  if (!b) return '';
  const yas = yasHesapla(b);
  return [
    b.ilce || null,
    yas ? `${yas} yaş` : null,
    cev(CALISMA_LABEL, b.calisma_tercihi),
    cev(DENEYIM_LABEL, b.kahve_deneyim),
    tercihSubeMetni(b),
    b.arsivli ? 'arşivde' : null,
    (b.ise_alindi || b.personel_id) ? 'işe alındı ✓' : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Başvuru detayının TAM dökümü — bölüm bölüm {baslik, satirlar:[[etiket,deger]]}.
 * Klasik ekran da Kadife ekranı da aynı dökümü gösterir; hiçbir cevap
 * ekranların birinde görünüp diğerinde kaybolmaz.
 */
export function basvuruBloklari(b) {
  if (!b) return [];
  const yas = yasHesapla(b);
  const blok = (baslik, satirlar) => ({
    baslik,
    satirlar: satirlar.filter(([, v]) => v != null && String(v).trim() !== ''),
  });
  const bloklar = [
    blok('KİMLİK & İLETİŞİM', [
      ['📱 Telefon', b.telefon],
      ['📅 Doğum Yılı', b.dogum_yili ? `${b.dogum_yili} · ${yas} yaşında` : null],
      ['📍 Semt', b.ilce],
      ['🏬 Tercih ettiği şubeler', tercihSubeMetni(b)],
      ['📨 Başvuru kaynağı', b.kaynak_sube],
    ]),
    blok('YAŞAM & EĞİTİM', [
      ['🏠 Nerede Kalıyor', cev(YASAM_LABEL, b.yasam_durumu)],
      ['🎓 Eğitim', cev(EGITIM_LABEL, b.egitim_durumu)],
      ['🏫 Okul / Bölüm', b.universite_bol],
      ['⏰ En Erken Saat', b.en_erken_saat === 'ogle' ? '🌞 Öğleden sonra' : b.en_erken_saat],
      ['🚌 Ulaşım', cev(ULASIM_LABEL, b.ulasim)],
    ]),
    blok('ÇALIŞMA TERCİHİ', [
      ['⏱️ Çalışma Şekli', cev(CALISMA_LABEL, b.calisma_tercihi)],
      ['📅 Müsait Günler', musaitGunMetni(b)],
      ['🚀 Başlangıç', cev(BASLANGIC_LABEL, b.baslangic)],
      ['🎯 Pozisyon', b.pozisyon],
    ]),
    blok('DENEYİM & GEÇMİŞ', [
      ['☕ Kahve Deneyimi', cev(DENEYIM_LABEL, b.kahve_deneyim)],
      ['💼 Önceki İş', b.onceki_is],
      ['📘 En çok ne öğrendi', b.onceki_is_ogrenilen],
      ['⚖️ En iyi & en zor', b.onceki_is_iyi_zor],
      ['🏢 Nerede çalıştı', cev(NEREDE_LABEL, b.nerede_calistim)],
      ['📚 Ne öğrendi', b.nerede_calistim !== 'hic_calismadim' ? cev(OGRENILEN_LABEL, b.is_ogrenilen) : null],
      ['✨ En iyi yanı', b.nerede_calistim !== 'hic_calismadim' ? cev(EN_IYI_LABEL, b.isten_en_iyi) : null],
      ['⚠️ En zor yanı', b.nerede_calistim !== 'hic_calismadim' ? cev(EN_ZOR_LABEL, b.isten_en_zor) : null],
    ]),
    blok('DAVRANIŞSAL YANIT (MASKELİ SORULAR)', [
      ['☕ Makine sonrası', cev(MAKINE_LABEL, b.makine_sonrasi)],
      ['🧹 Yoğunlukta düzen', cev(YOGUN_LABEL, b.yogun_duzen)],
      ['📅 Gün planlaması', cev(GUNPLAN_LABEL, b.gun_planlama)],
      ['👥 Arkadaşlar tanımı', cev(ARKADASLAR_LABEL, b.arkadaslar_tanim)],
      ['🤝 Sosyal yaklaşım', cev(SOSYAL_LABEL, b.sosyal_yaklasim)],
      ['☕ Müşteri bağı', cev(MUSTERI_LABEL, b.musteri_bagli)],
      ['🌅 Sabah hazırlığı', cev(SABAH_LABEL, b.sabah_hazirlik)],
      ['😓 En yorucu an', cev(YORUCU_LABEL, b.yorucu_an)],
    ]),
    blok('MOTİVASYON & KİŞİLİK', [
      ['🎯 Neden Bu İş', cev(NEDEN_LABEL, b.neden_bu_is)],
      ['⚡ Tempo Tercihi', cev(TEMPO_LABEL, b.tempo_tercihi)],
      ['👤 Referans', b.referans_ad ? `${b.referans_ad}${b.referans_tel ? ' · ' + b.referans_tel : ''}` : null],
    ]),
  ];
  return bloklar.filter(x => x.satirlar.length > 0);
}

/** Serbest metin alanları (uzun paragraflar) — satır yerine kutu olarak gösterilir. */
export function basvuruMetinBloklari(b) {
  if (!b) return [];
  return [
    ['KENDİ TANITIMI', b.tanitim],
    ['EK NOT', b.ek_not],
  ].filter(([, v]) => v != null && String(v).trim() !== '');
}

/** Sıralama seçenekleri — klasik ve Kadife ekranı AYNI listeyi kullanır. */
export const SIRALAMA_SECENEKLERI = [
  { id: 'oncelik',   ad: '🥇 Öncelikliler üstte' },
  { id: 'yeni',      ad: '🕐 Yeniden eskiye' },
  { id: 'eski',      ad: '🕓 Eskiden yeniye' },
  { id: 'skor_desc', ad: '⭐ En yüksek skor' },
  { id: 'skor_asc',  ad: '🔻 En düşük skor' },
  { id: 'ad',        ad: '🔤 İsme göre (A→Z)' },
];

const zaman = (b) => {
  const t = new Date(b?.olusturma_ts || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Seçilen sıralamayı uygular (diziyi kopyalar, kaynağı bozmaz). */
export function basvuruSirala(liste, sira) {
  const arr = [...(liste || [])];
  if (sira === 'yeni')      return arr.sort((a, b) => zaman(b) - zaman(a));
  if (sira === 'eski')      return arr.sort((a, b) => zaman(a) - zaman(b));
  if (sira === 'skor_desc') return arr.sort((a, b) => (b?.skor?.toplam || 0) - (a?.skor?.toplam || 0));
  if (sira === 'skor_asc')  return arr.sort((a, b) => (a?.skor?.toplam || 0) - (b?.skor?.toplam || 0));
  if (sira === 'ad')        return arr.sort((a, b) => String(a?.ad_soyad || '').localeCompare(String(b?.ad_soyad || ''), 'tr'));
  // varsayılan: öncelikliler üstte, içinde yeniden eskiye
  return arr.sort((a, b) => {
    const oa = Number(a?.oncelik) || 99, ob = Number(b?.oncelik) || 99;
    if (oa !== ob) return oa - ob;
    return zaman(b) - zaman(a);
  });
}
