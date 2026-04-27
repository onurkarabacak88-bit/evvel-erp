/**
 * VARDİYA PLANLAMA v2 — 16 maddelik spec ile hizalı akış
 * - Gün matrisi: hafta (üst) + sol personel + saat satırları (plandaki slotlardan 30/60/120 dk bantlar) × şube + sürükle-bırak
 * - Şube haftası: tek şube × 7 gün × saat (alternatif görünüm)
 * - Havuzdan veya slottaki kişi chip’inden sürükleme → başka şube/slota transfer (önce iptal)
 * - Birincil kaynak: API’deki her atama satırının baslangıç–bitiş’i (kısmi mesai / ardışık iki kişi / ek mesai).
 * - Şube slotu: referans çerçeve + kontenjan; kullanıcı saatleri çerçeveyi aşabilir (sunucu slot_band uyarısı, blok değil).
 * - Otomatik doldur (gün): şablon + boş dilim kaydırma + sunucu check
 * - Haftalık motor: `vardiya_plan_motor` — Pzt–Paz eksik önceliği, ana şube / haftalık denge, taşıma (min korunur)
 * - Çakışma kesin blok; kritik ihlal → override; sarı uyarılar → Evet/Hayır; şube çerçevesi taşması uyarı kotunda
 * - Gün kilidi manuel (slot min ile otomatik kilit yok)
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { api } from '../utils/api';

const TR_AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const TR_GUNLER = ['Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi','Pazar'];
/** `personel_gun_preset` ile aynı anahtarlar (vardiya_v2.GUN_KISALTMA) */
const V2_PRESET_GUN_ANAHTARLARI = ['pzt', 'sal', 'car', 'per', 'cum', 'cmt', 'paz'];

const SLOT_TIPI = {
  acilis:   { ikon: '🌅', renk: '#f59e0b', etiket: 'Sabah bandı' },
  normal:   { ikon: '⏱',  renk: '#4f8ef7', etiket: 'Standart mesai' },
  yogun:    { ikon: '🔥', renk: '#ef4444', etiket: 'Yoğun vurgu' },
  kapanis:  { ikon: '🌙', renk: '#7c3aed', etiket: 'Akşam bandı' },
};

/** Yeni atama — spec POST /assign ile aynı gövde (`/atama` ile eşdeğer) */
const V2_ATAMA_POST = '/vardiya/v2/assign';

/**
 * Şube slotu + atama «hızlı seç» — tek kaynak. Asıl tanım başlangıç–bitiş; `tip` liste rengi / özet raporlar için.
 */
const SAAT_SABLONLARI = [
  { etiket: 'Tam gün', bas: '09:00', bit: '18:30', tip: 'normal' },
  { etiket: 'Sabah dilimi', bas: '09:00', bit: '14:30', tip: 'acilis' },
  { etiket: 'Akşam dilimi', bas: '18:30', bit: '23:59', tip: 'kapanis' },
  { etiket: 'Öğleden kapanışa', bas: '14:30', bit: '23:59', tip: 'kapanis' },
  { etiket: 'Aracı bandı A', bas: '10:30', bit: '20:00', tip: 'normal' },
  { etiket: 'Aracı bandı B', bas: '12:00', bit: '21:00', tip: 'normal' },
  { etiket: 'Aracı bandı C', bas: '12:00', bit: '22:30', tip: 'normal' },
  { etiket: 'Öğle yoğun', bas: '12:00', bit: '15:30', tip: 'yogun' },
  { etiket: 'Kaydırmalı part', bas: '15:30', bit: '19:00', tip: 'normal' },
];

const isoToday = () => new Date().toISOString().slice(0, 10);
const fmtSaat  = (t) => (t || '').slice(0, 5);
const fmtTarihKisa = (s) => (s == null || s === '' ? '' : String(s).slice(0, 10));

/**
 * `<input type="time" />` en fazla 23:59 kabul eder; şubede kapanış `24:00` yazılabiliyor.
 */
function saatHtmlTimeInput(raw) {
  const t = fmtSaat(raw);
  if (!t) return '';
  if (t === '24:00' || t.startsWith('24:')) return '23:59';
  return t;
}

/** Yeni slot formu: şube açılış/kapanışı (`/subeler`); yoksa 08:00–23:59 */
function slotVarsayilanSaatleri(subelerList, subeId) {
  const sid = String(subeId || '');
  const sub = (subelerList || []).find((x) => String(x.id) === sid);
  const bas = saatHtmlTimeInput(sub?.acilis_saati) || '08:00';
  let bit = saatHtmlTimeInput(sub?.kapanis_saati);
  if (!bit) bit = '23:59';
  return { baslangic_saat: bas, bitis_saat: bit };
}

/** Gün planından slot_id → "Şube · SS:MM–SS:MM" (override özet metni) */
function slotEtiketiBul(plan, slotId) {
  if (!slotId || !plan?.subeler) return '';
  for (const sub of plan.subeler) {
    for (const sv of sub.slotlar || []) {
      if (sv.slot?.id === slotId) {
        const bas = fmtSaat(sv.slot.baslangic_saat);
        const bit = fmtSaat(sv.slot.bitis_saat);
        const ad = sub.sube_ad || sub.sube_id || '';
        return `${ad} · ${bas}–${bit}`;
      }
    }
  }
  return '';
}

/**
 * Havuzdan sürükleme: yalnızca izinli kapalı.
 * Günlük limit (kalan_saat) kartta uyarı olarak kalır; kısmi saat seçimi için
 * modal açılmalı — aksi halde «hesaplanan limit dolu» ile havuz kilitlenip
 * gerçekte 4.5h gibi kısa vardiya atanamıyordu (toplam yanlış tam slot gibi görünse bile).
 */
function havuzdanSuruklenebilirMi(p) {
  const d = p?.gun_durumu || {};
  if (d.durum === 'IZINLI') return false;
  return true;
}

/** Slottaki chip: yalnızca izinli kapalı (taşıma günlük doluda da mümkün) */
function slottanSuruklenebilirMi(p) {
  const d = p?.gun_durumu || {};
  return d.durum !== 'IZINLI';
}

/** Saat sayısı: 3 veya 6.5 (gereksiz ondalık sıfır atılır) */
function saatSayiMetin(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Slot avatar baş harfleri (TR uyumlu: ilk iki kelimenin başı) */
function avatarBasHarfler(ad, soyad) {
  const a = (ad || '').trim();
  const s = (soyad || '').trim();
  const u = (s) => (s && s.length ? Array.from(s)[0] : '');
  const c1 = u(a);
  const c2 = u(s);
  const t = `${c1}${c2}`.toUpperCase();
  return t || '?';
}

/** Personel id → sabit avatar zemini (gradient) */
function avatarRenkGradient(personelId) {
  const s = String(personelId || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const hue = Math.abs(h) % 360;
  return `linear-gradient(145deg, hsl(${hue} 48% 44%), hsl(${hue} 56% 28%))`;
}

/** Havuz günü `gun_durumu.atamalar` içinden benzersiz şubeler (o şubedeki tüm atama id’leri) */
function gunAtamaSubeleriGrup(atamalar, subelerList) {
  const m = new Map();
  for (const a of atamalar || []) {
    const sid = a.sube_id != null ? String(a.sube_id) : '';
    if (!sid) continue;
    if (!m.has(sid)) {
      const sn = (subelerList || []).find((x) => String(x.id) === sid)?.ad || `Şube`;
      m.set(sid, { sube_id: sid, sube_ad: sn, atama_ids: [] });
    }
    const row = m.get(sid);
    if (a.id) row.atama_ids.push(a.id);
  }
  return [...m.values()];
}

/**
 * Slotta bırakma önizlemesi (drag-over) — API `uyarilar` listesinden üçlü durum.
 * engel: SADECE çakışma (fizik kuralı; aynı anda iki yerde olunamaz)
 * uyari: çakışma dışı (override `override_gerekir` ile; sarı onay modalı)
 */
function slotHoverDurumuFromCheck(uyarilar) {
  if (!uyarilar || uyarilar.length === 0) return 'ok';
  for (const u of uyarilar) {
    if (u.tip === 'cakisma') return 'engel';
  }
  return 'uyari';
}

function _parseSaatDakika(s) {
  if (s == null || s === '') return 0;
  const p = String(s).slice(0, 8).split(':');
  const h = parseInt(p[0], 10) || 0;
  const m = parseInt(p[1], 10) || 0;
  return h * 60 + m;
}

// ── Otomatik doldur «zekâ» — şube slotu çerçeve; kişi süresi şablon + kaydırmalı dilimlerle bulunur
const OTOMATIK_VARSAYILAN_MIN_GECIS_DK = 30;
const OTOMATIK_SLOT_ICI_ADIM_DK = 30;
const OTOMATIK_MIN_DILIM_DK = 120;
const OTOMATIK_MAX_KAYDIRMA_DILIM_DK = 5 * 60;
const OTOMATIK_ADAY_LIMITI = 40;

function _aralikDakikaExtended(basStr, bitStr) {
  let b0 = _parseSaatDakika(basStr);
  let b1 = _parseSaatDakika(bitStr);
  if (b1 <= b0) b1 += 24 * 60;
  return [b0, b1];
}

function dakikaToHHMM(extMin) {
  const r = ((Math.round(extMin) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(r / 60);
  const mi = r % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function birlestirAraliklar(intervals) {
  if (!intervals.length) return [];
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  let cs = s[0][0];
  let ce = s[0][1];
  for (let i = 1; i < s.length; i += 1) {
    const [ns, ne] = s[i];
    if (ns <= ce) ce = Math.max(ce, ne);
    else {
      out.push([cs, ce]);
      cs = ns;
      ce = ne;
    }
  }
  out.push([cs, ce]);
  return out;
}

/** Mevcut atamalar + (farklı şubeden geliyorsa) geçiş tamponu — çakışma ve min geçişe yakın tahmin */
function personelMesgulExtended(atamalar, targetSubeId, minGecisDk) {
  const sidT = targetSubeId != null ? String(targetSubeId) : '';
  const blocks = [];
  for (const a of atamalar || []) {
    const [b0, b1] = _aralikDakikaExtended(a.baslangic_saat, a.bitis_saat);
    blocks.push([b0, b1]);
    const sidA = String(a.sube_id || '');
    if (sidA && sidT && sidA !== sidT) {
      blocks.push([b1, b1 + minGecisDk]);
    }
  }
  return birlestirAraliklar(blocks);
}

function slotAralikExtended(slot) {
  return _aralikDakikaExtended(slot.baslangic_saat, slot.bitis_saat);
}

/** Backend `vardiya_v2._atama_slot_bandini_icinde_mi` ile uyumlu — plan API `slot_cercevesinde` kullanır (varsa). */
function atamaSlotCercevesindeMi(a, slot) {
  if (a?.slot_cercevesinde !== undefined && a?.slot_cercevesinde !== null) {
    return !!a.slot_cercevesinde;
  }
  if (!a?.baslangic_saat || !a?.bitis_saat || !slot?.baslangic_saat || !slot?.bitis_saat) return true;
  try {
    const [s0, s1] = slotAralikExtended(slot);
    const [a0, a1] = _aralikDakikaExtended(a.baslangic_saat, a.bitis_saat);
    return a0 >= s0 && a1 <= s1;
  } catch {
    return true;
  }
}

/** Bu slottaki atamaların genişletilmiş dakika ekseninde en erken başlangıç / en geç bitiş (özet satırı için). */
function atamaListesiIsOzeti(atamalar) {
  if (!atamalar?.length) return null;
  let minS = Infinity;
  let maxE = -Infinity;
  for (const a of atamalar) {
    const [x0, x1] = _aralikDakikaExtended(a.baslangic_saat, a.bitis_saat);
    if (Number.isFinite(x0)) {
      if (x0 < minS) minS = x0;
      if (x1 > maxE) maxE = x1;
    }
  }
  if (!Number.isFinite(minS)) return null;
  return { basStr: dakikaToHHMM(minS), bitStr: dakikaToHHMM(maxE) };
}

/** [s0,s1) ile çakışan mesaiyi çıkarıp boş dilimleri döndür */
function bosDilimlerSlotIcinde(s0, s1, mesgulBirlesik) {
  const free = [];
  let cur = s0;
  const busy = mesgulBirlesik
    .filter(([a, b]) => b > s0 && a < s1)
    .map(([a, b]) => [Math.max(s0, a), Math.min(s1, b)])
    .sort((x, y) => x[0] - y[0]);
  for (const [b0, b1] of busy) {
    if (cur < b0) free.push([cur, b0]);
    cur = Math.max(cur, b1);
    if (cur >= s1) break;
  }
  if (cur < s1) free.push([cur, s1]);
  return free.filter(([a, b]) => b - a >= OTOMATIK_MIN_DILIM_DK);
}

/**
 * İnsan mantığına yakın: önce tanımlı şablonlardan slot içinde kesişenler,
 * sonra aynı boş dilimde süreyi kaydırarak (30 dk adım) aday üretir.
 */
function otomatikAtamaSaatAdaylari(person, slot, targetSubeId) {
  const kalanMin = Math.floor((Number(person?.gun_durumu?.kalan_saat) || 0) * 60);
  if (kalanMin < OTOMATIK_MIN_DILIM_DK) return [];

  const [s0, s1] = slotAralikExtended(slot);
  const span = s1 - s0;
  if (span < OTOMATIK_MIN_DILIM_DK) return [];

  const mesgul = personelMesgulExtended(person?.gun_durumu?.atamalar, targetSubeId, OTOMATIK_VARSAYILAN_MIN_GECIS_DK);
  const bos = bosDilimlerSlotIcinde(s0, s1, mesgul);
  if (!bos.length) return [];

  const seen = new Set();
  const tmp = [];

  const pushPair = (basMin, bitMin) => {
    if (bitMin <= basMin) return;
    const dur = bitMin - basMin;
    if (dur < OTOMATIK_MIN_DILIM_DK || dur > kalanMin) return;
    if (basMin < s0 || bitMin > s1) return;
    const bas = dakikaToHHMM(basMin);
    const bit = dakikaToHHMM(bitMin);
    const key = `${bas}|${bit}`;
    if (seen.has(key)) return;
    seen.add(key);
    tmp.push({ bas, bit, _basMin: basMin, _dur: dur });
  };

  for (const sab of SAAT_SABLONLARI) {
    const [t0, t1] = _aralikDakikaExtended(sab.bas, sab.bit);
    for (const [f0, f1] of bos) {
      const lo = Math.max(t0, f0);
      const hi = Math.min(t1, f1);
      if (hi - lo >= OTOMATIK_MIN_DILIM_DK) pushPair(lo, hi);
    }
  }

  const maxChunk = Math.min(kalanMin, OTOMATIK_MAX_KAYDIRMA_DILIM_DK, span);
  const durList = [];
  for (let d = maxChunk; d >= OTOMATIK_MIN_DILIM_DK; d -= OTOMATIK_SLOT_ICI_ADIM_DK) {
    if (!durList.includes(d)) durList.push(d);
  }

  for (const dur of durList) {
    for (const [f0, f1] of bos) {
      const maxStart = f1 - dur;
      if (maxStart < f0) continue;
      for (let st = f0; st <= maxStart; st += OTOMATIK_SLOT_ICI_ADIM_DK) {
        pushPair(st, st + dur);
      }
    }
  }

  tmp.sort((a, b) => {
    if (b._dur !== a._dur) return b._dur - a._dur;
    return a._basMin - b._basMin;
  });

  return tmp.slice(0, OTOMATIK_ADAY_LIMITI).map(({ bas, bit }) => ({ bas, bit }));
}

/** Bant [bandStartMin, bandEndMin) ile slot aralığı çakışıyor mu (bitiş ≤ başlangıç → ertesi güne uzanır). */
function slotBantIleKesisir(sv, bandStartMin, bandEndMin) {
  if (!sv?.slot) return false;
  const bas = _parseSaatDakika(sv.slot.baslangic_saat);
  let bit = _parseSaatDakika(sv.slot.bitis_saat);
  if (bit <= bas) bit += 24 * 60;
  return bas < bandEndMin && bit > bandStartMin;
}

/** Matris satır etiketi: 24:00 sonrası için (+1) ile ertesi gün vurgusu */
function _saatEtiketiDakika(m) {
  const u = Math.max(0, Math.floor(m));
  const day = Math.floor(u / (24 * 60));
  const r = u % (24 * 60);
  const h = Math.floor(r / 60);
  const mi = r % 60;
  const core = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  if (day === 0) return core;
  return `${core}\u2009(+${day})`;
}

/** Şube listesindeki tüm slotlardan [min,max) dakika aralığı (yoksa any=false) */
function _slotZamanAraligiDakika(list) {
  let minM = Infinity;
  let maxM = -Infinity;
  let any = false;
  for (const s of list || []) {
    for (const sv of s.slotlar || []) {
      if (!sv?.slot) continue;
      const bas = _parseSaatDakika(sv.slot.baslangic_saat);
      let bit = _parseSaatDakika(sv.slot.bitis_saat);
      if (bit <= bas) bit += 24 * 60;
      any = true;
      if (bas < minM) minM = bas;
      if (bit > maxM) maxM = bit;
    }
  }
  return { minM, maxM, any };
}

/**
 * Sürükle-bırak matrisi: satırlar plandaki gerçek slotlardan türetilir (varsayılan 30 dk;
 * çok satır olursa 60 / 120 dk’ya çıkar). Böylece sol etiket ile hücredeki slot saati hizalı kalır.
 */
function saatBantlariPlandan(plan, subeListesi, istenenAdim = 30) {
  const list = subeListesi?.length ? subeListesi : (plan?.subeler || []);
  const { minM, maxM, any } = _slotZamanAraligiDakika(list);
  if (!any || !Number.isFinite(minM) || !Number.isFinite(maxM)) return saatBantlari();
  let step = istenenAdim;
  const span = maxM - minM;
  if (span / step > 50) step = 60;
  if (span / step > 50) step = 120;
  let minBand = Math.floor(minM / step) * step;
  let maxBand = Math.ceil(maxM / step) * step;
  if (maxBand <= minBand) maxBand = minBand + step;
  const out = [];
  for (let a = minBand; a < maxBand; a += step) {
    const b = a + step;
    out.push({
      key: `${a}-${b}`,
      startMin: a,
      endMin: b,
      label: `${_saatEtiketiDakika(a)}–${_saatEtiketiDakika(b)}`,
    });
  }
  return out.length ? out : saatBantlari();
}

function pazartesiIso(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

function _ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO-8601 hafta yılı ve hafta numarası (Pazartesi başlangıçlı) */
function isoYilVeHafta(ymd) {
  const d = new Date(`${ymd}T12:00:00`);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - (t.getDay() + 6) % 7);
  const isoY = t.getFullYear();
  const jan4 = new Date(isoY, 0, 4, 12, 0, 0, 0);
  const w1d = (jan4.getDay() + 6) % 7;
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - w1d);
  const diff = Math.round((d - week1Mon) / 86400000);
  return { year: isoY, week: 1 + Math.floor(diff / 7) };
}

function isoHaftaSayisiYil(y) {
  const dec28 = new Date(y, 11, 28, 12, 0, 0, 0);
  return isoYilVeHafta(_ymd(dec28)).week;
}

/** Verilen ISO yıl + haftanın Pazartesi tarihi YYYY-MM-DD */
function isoHaftaPazartesi(isoY, w) {
  const jan4 = new Date(isoY, 0, 4, 12, 0, 0, 0);
  const w1d = (jan4.getDay() + 6) % 7;
  const week1Mon = new Date(jan4);
  week1Mon.setDate(jan4.getDate() - w1d);
  const out = new Date(week1Mon);
  out.setDate(week1Mon.getDate() + (w - 1) * 7);
  return _ymd(out);
}

/** Aynı hafta içi gün kaydırarak ISO hafta ±delta */
function isoHaftaKaydir(ymd, delta) {
  let { year: y, week: w } = isoYilVeHafta(ymd);
  w += delta;
  for (;;) {
    const maxw = isoHaftaSayisiYil(y);
    if (w < 1) {
      y -= 1;
      w += isoHaftaSayisiYil(y);
      continue;
    }
    if (w > maxw) {
      w -= maxw;
      y += 1;
      continue;
    }
    break;
  }
  const mon = isoHaftaPazartesi(y, w);
  const d0 = new Date(`${ymd}T12:00:00`);
  const dow = (d0.getDay() + 6) % 7;
  const out = new Date(`${mon}T12:00:00`);
  out.setDate(out.getDate() + dow);
  return _ymd(out);
}

/** Gün planında slot_id → { sv, sube_ad } */
function planSlotSatirBul(plan, slotId) {
  if (!plan?.subeler || slotId == null || slotId === '') return null;
  const sid = String(slotId);
  for (const sub of plan.subeler) {
    for (const sv of sub.slotlar || []) {
      if (String(sv.slot?.id) === sid) return { sv, sube_ad: sub.sube_ad };
    }
  }
  return null;
}

/** Yerel: aynı gün mevcut atamalarla slot saatleri çakışıyor mu (hızlı engel önizlemesi; gece slotu basit) */
function yerelAtamaSlotCakisir(a, sv) {
  if (!a || !sv?.slot) return false;
  if (a.slot_id === sv.slot.id) return false;
  const ab = _parseSaatDakika(a.baslangic_saat);
  let ae = _parseSaatDakika(a.bitis_saat);
  if (ae <= ab || a.gece_vardiyasi) ae += 24 * 60;
  const bb = _parseSaatDakika(sv.slot.baslangic_saat);
  let be = _parseSaatDakika(sv.slot.bitis_saat);
  if (be <= bb || sv.slot.gece_vardiyasi) be += 24 * 60;
  return !(ae <= bb || be <= ab);
}

/** Yerel önizleme: null = bilinmiyor (API’ye bırak), 'engel' | 'ok' */
function yerelDragSlotDurum(person, slotId, gunTarihi, planGun) {
  if (!person || !planGun?.subeler) return null;
  const row = planSlotSatirBul(planGun, slotId);
  if (!row) return null;
  const at = person.gun_durumu?.atamalar || [];
  for (const a of at) {
    if (yerelAtamaSlotCakisir(a, row.sv)) return 'engel';
  }
  return 'ok';
}

/** 06:00–22:00 arası 2 saatlik bantlar */
function saatBantlari() {
  const out = [];
  for (let h = 6; h < 22; h += 2) {
    const a = h * 60;
    const b = (h + 2) * 60;
    out.push({
      key: `${h}-${h + 2}`,
      startMin: a,
      endMin: b,
      label: `${String(h).padStart(2, '0')}:00–${String(h + 2).padStart(2, '0')}:00`,
    });
  }
  return out;
}

/** Gün planından şube×bant → { sv, s, bandKey } listesi; slot birden fazla satırla kesişiyorsa her satırda görünür */
function slotMatrisHaritasiOlustur(plan, subeListesi, bands) {
  const m = new Map();
  if (!plan?.subeler || !bands?.length) return m;
  const list = subeListesi?.length ? subeListesi : plan.subeler;
  for (const s of list) {
    for (const sv of s.slotlar || []) {
      for (const b of bands) {
        if (!slotBantIleKesisir(sv, b.startMin, b.endMin)) continue;
        const key = `${s.sube_id}|${b.key}`;
        if (!m.has(key)) m.set(key, []);
        m.get(key).push({ sv, s, bandKey: b.key });
      }
    }
  }
  return m;
}

/** Havuz kartı: risk seviyesi + sol şerit rengi + rozet metinleri */
function personelKartGosterge(d, gunKilitli) {
  const izinli = d.durum === 'IZINLI';
  const calisiyor = d.durum === 'CALISIYOR';
  const planYok = d.durum === 'PLANLANMADI';
  const maxGun = (Number.isFinite(Number(d.max_gunluk_saat)) && Number(d.max_gunluk_saat) > 0)
    ? Number(d.max_gunluk_saat)
    : 9.5;
  const toplam = Number(d.toplam_saat) || 0;
  const kalan = Number(d.kalan_saat);
  const kalanN = Number.isFinite(kalan) ? kalan : Math.max(0, maxGun - toplam);
  const fazla = Number(d.fazla_gunluk_saat) || 0;
  const yuzde = maxGun > 0 ? Math.min(100, (toplam / maxGun) * 100) : 0;
  const doluGunluk = !izinli && kalanN <= 0 && calisiyor;
  const rozetler = [];

  // Spec renkleri: Aktif #22c55e · Uyarı #facc15 · Kilitli #9ca3af
  // İzinli #ef4444 (KIRMIZI) · Override #a855f7
  if (izinli) {
    const tip = d.izin?.tip || 'izin';
    rozetler.push({ k: 'izin', t: tip, renk: '#ef4444' });
    return {
      accent: '#ef4444',
      border: '1px solid rgba(239,68,68,0.5)',
      bg: 'rgba(239,68,68,0.06)',
      rozetler,
      kalanMetin: null,
      izinOzeti: d.izin
        ? `${tip} · ${fmtTarihKisa(d.izin.baslangic_tarih)} → ${fmtTarihKisa(d.izin.bitis_tarih)}`
        : 'İzinli',
      yuzde: 0,
      doluGunluk: false,
      fazla,
      seviye: 'izin',
    };
  }

  // Override geçmişi varsa rozette mor
  const overrideVar = !!d.override_var;
  if (overrideVar) rozetler.push({ k: 'override', t: 'Override geçmişi', renk: '#a855f7' });
  if (gunKilitli) rozetler.push({ k: 'kilit', t: 'Gün kilidi', renk: '#9ca3af' });
  if (fazla > 0) rozetler.push({ k: 'fazla', t: `+${fazla.toFixed(1)}h limit üstü`, renk: '#ef4444' });
  if (doluGunluk) rozetler.push({ k: 'limit', t: 'Günlük süre dolu', renk: '#9ca3af' });
  else if (yuzde >= 90) rozetler.push({ k: 'yuksek', t: 'Süre neredeyse doldu', renk: '#facc15' });
  else if (yuzde >= 70) rozetler.push({ k: 'orta', t: 'Yüksek yük', renk: '#facc15' });
  if (kalanN > 0 && kalanN <= 1 && !doluGunluk) rozetler.push({ k: 'az', t: 'Az süre kaldı', renk: '#facc15' });
  if (planYok) rozetler.push({ k: 'plan', t: 'Plan yok', renk: '#d97706' });
  if (d.durum === 'BOS') rozetler.push({ k: 'bos', t: 'Bilinçli boş', renk: '#64748b' });

  let seviye = 'ok';
  let accent = '#22c55e';     // Aktif yeşil
  let bg = 'transparent';
  if (doluGunluk) {
    seviye = 'kilit';
    accent = '#9ca3af';        // Kilitli gri
    bg = 'rgba(156,163,175,0.08)';
  } else if (fazla > 0) {
    seviye = 'kritik';
    accent = '#ef4444';
    bg = 'rgba(239,68,68,0.06)';
  } else if (overrideVar) {
    seviye = 'override';
    accent = '#a855f7';        // Override mor
    bg = 'rgba(168,85,247,0.06)';
  } else if (gunKilitli || yuzde >= 70 || (kalanN > 0 && kalanN <= 1)) {
    seviye = 'uyari';
    accent = '#facc15';        // Uyarı sarı
    bg = 'rgba(250,204,21,0.06)';
  }

  return {
    accent,
    bg,
    border: seviye === 'kritik' ? '1px solid rgba(239,68,68,0.45)'
          : seviye === 'kilit' ? '1px solid rgba(156,163,175,0.55)'
          : seviye === 'override' ? '1px solid rgba(168,85,247,0.5)'
          : seviye === 'uyari' ? '1px solid rgba(250,204,21,0.55)'
          : '1px solid var(--border)',
    rozetler,
    kalanMetin: `Kalan: ${saatSayiMetin(kalanN)} saat / Toplam: ${saatSayiMetin(toplam)}/${saatSayiMetin(maxGun)}`,
    izinOzeti: null,
    yuzde,
    doluGunluk,
    fazla,
    seviye,
  };
}

export default function VardiyaPlanlamaV2() {
  const [tarih, setTarih] = useState(isoToday());
  const [subeler, setSubeler] = useState([]);
  const [subeFilter, setSubeFilter] = useState('');
  const [gunPlani, setGunPlani] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState('');

  // Modal state
  /** Yeni slot: `defaultBaslangicSaat` / `defaultBitisSaat` şube açılış-kapanıştan */
  const [slotModal, setSlotModal] = useState(null);    // {sube_id, slot?, defaultBaslangicSaat?, defaultBitisSaat?} | null
  const [kisitModal, setKisitModal] = useState(null);  // personel_id | null
  const [sistemPresetModal, setSistemPresetModal] = useState(false);
  /** Sürükle-bırak sonrası saat seçimi + check/atama */
  const [dropSaatModal, setDropSaatModal] = useState(null);
  const [izinModal, setIzinModal] = useState(false);
  /** Seçili haftada izin kaydı olmayan aktif personel (yasal hatırlatma) */
  const [izinHaftaOzet, setIzinHaftaOzet] = useState(null);
  const [overrideModal, setOverrideModal] = useState(null); // {payload, uyarilar, ozetMetni?, transferAtamaId?} | null
  /** Sadece seviye uyari — drop öncesi EVET/HAYIR (override log yok) */
  const [uyariOnayModal, setUyariOnayModal] = useState(null); // aynı şekil
  const [logPanel, setLogPanel] = useState(false);
  const [raporAcik, setRaporAcik] = useState(false);
  const [raporBas, setRaporBas] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [raporBit, setRaporBit] = useState(isoToday());
  const [raporFazla, setRaporFazla] = useState(null);
  const [raporIzinli, setRaporIzinli] = useState(null);
  const [raporYukleniyor, setRaporYukleniyor] = useState(false);
  const [personelMetinFiltre, setPersonelMetinFiltre] = useState('');
  /** null → sol havuz ana `tarih` planıyla aynı; ISO string → o günün personel_havuzu ayrı çekilir */
  const [havuzTarihOverride, setHavuzTarihOverride] = useState(null);
  const [havuzGunPlani, setHavuzGunPlani] = useState(null);
  const [havuzYukleniyor, setHavuzYukleniyor] = useState(false);

  const havuzKaynakTarih = havuzTarihOverride ?? tarih;

  const [draggedPersonel, setDraggedPersonel] = useState(null);
  /** { slotId, gunTarihi, durum: 'ok'|'uyari'|'engel' } | null — sürüklerken slot highlight */
  const [dragSlotPreview, setDragSlotPreview] = useState(null);
  const draggedRef = useRef(null);
  const previewTimerRef = useRef(null);
  const previewReqRef = useRef(0);
  /** Slottaki kişiyi başka slota taşırken: iptal + yeni atama */
  const transferAtamaRef = useRef(null);

  const [gorunumModu, setGorunumModu] = useState('gun_matris'); // 'gun_matris' | 'sube_hafta' | 'personel_hafta'
  const [personelHafta, setPersonelHafta] = useState(null);
  const [personelHaftaYukleniyor, setPersonelHaftaYukleniyor] = useState(false);
  const [subeHaftaId, setSubeHaftaId] = useState('');
  const [haftaPlanCache, setHaftaPlanCache] = useState(null);
  const [haftaYukleniyor, setHaftaYukleniyor] = useState(false);
  const [otomatikBusy, setOtomatikBusy] = useState(false);
  const [motorBusy, setMotorBusy] = useState(false);
  const [motorSonuc, setMotorSonuc] = useState(null);
  const PREVIEW_DEBOUNCE_MS = 220;
  /** Alt özet — varsayılan kapalı; vardiya grid’ine yer açar */
  const [altPanelAcik, setAltPanelAcik] = useState(false);

  const isoHaftaEtiket = useMemo(() => isoYilVeHafta(tarih), [tarih]);
  const [isoJump, setIsoJump] = useState(() => {
    const z = isoYilVeHafta(isoToday());
    return { y: z.year, w: z.week };
  });
  useEffect(() => {
    const z = isoYilVeHafta(tarih);
    setIsoJump({ y: z.year, w: z.week });
  }, [tarih]);

  const pazartesiSecili = useMemo(() => pazartesiIso(tarih), [tarih]);

  const haftaAralikMetin = useMemo(() => {
    const d0 = new Date(`${pazartesiSecili}T12:00:00`);
    const d6 = new Date(d0);
    d6.setDate(d6.getDate() + 6);
    const y = d6.getFullYear();
    if (d0.getMonth() === d6.getMonth()) {
      return `${d0.getDate()}–${d6.getDate()} ${TR_AYLAR[d0.getMonth()]} ${y}`;
    }
    return `${d0.getDate()} ${TR_AYLAR[d0.getMonth()]} – ${d6.getDate()} ${TR_AYLAR[d6.getMonth()]} ${y}`;
  }, [pazartesiSecili]);

  const yukleSubeler = useCallback(async () => {
    try {
      const r = await api('/subeler');
      setSubeler((r || []).filter(s => s.aktif));
    } catch (e) { setHata(e.message); }
  }, []);

  const yukleGun = useCallback(async () => {
    setYukleniyor(true); setHata('');
    try {
      const q = subeFilter ? `&sube_id=${subeFilter}` : '';
      const r = await api(`/vardiya/v2/gun?tarih=${tarih}${q}`);
      setGunPlani(r);
    } catch (e) { setHata(e.message); }
    finally { setYukleniyor(false); }
  }, [tarih, subeFilter]);

  const yukleIzinHaftaOzet = useCallback(async () => {
    try {
      const r = await api(`/vardiya/v2/izin-hafta-ozet?pazartesi=${encodeURIComponent(tarih)}`);
      setIzinHaftaOzet(r);
    } catch {
      setIzinHaftaOzet(null);
    }
  }, [tarih]);

  const planGunTazele = useCallback(async (gunTarihi) => {
    try {
      const q = subeFilter ? `&sube_id=${subeFilter}` : '';
      const rGun = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(gunTarihi)}${q}`);
      if (havuzTarihOverride === gunTarihi) setHavuzGunPlani(rGun);
      if (gorunumModu === 'sube_hafta') {
        setHaftaPlanCache((prev) => (prev && typeof prev === 'object' ? { ...prev, [gunTarihi]: rGun } : prev));
      }
    } catch { /* ignore */ }
  }, [subeFilter, havuzTarihOverride, gorunumModu]);

  const tamamlaNormalAtama = useCallback(async (body, transferAtamaId) => {
    if (transferAtamaId) {
      await api(`/vardiya/v2/atama/${transferAtamaId}`, { method: 'DELETE' });
    }
    await api(V2_ATAMA_POST, { method: 'POST', body: { ...body, override: false } });
    await yukleGun();
    await planGunTazele(body.tarih);
  }, [yukleGun, planGunTazele]);

  /**
   * Saat seçiminden sonra atama/check.
   * Çakışma = kesin engel; override yalnızca çakışma dışı kritikler için (API `override_gerekir`).
   */
  const devamAtamaKontrolVeKaydet = useCallback(async (body, transferAtamaId, ctx) => {
    const planGun = ctx?.planForGun || gunPlani;
    const personelAd = `${ctx.personel.ad || ''} ${ctx.personel.soyad || ''}`.trim() || 'Bu personel';
    const slotEtiket = (planGun && slotEtiketiBul(planGun, body.slot_id))
      || slotEtiketiBul(gunPlani, body.slot_id);
    const ozetMetni = slotEtiket
      ? `${personelAd} bu saat uygun değil (${slotEtiket}).`
      : `${personelAd} bu atama için uygun değil.`;
    try {
      const c = await api('/vardiya/v2/atama/check', { method: 'POST', body });
      const hover = slotHoverDurumuFromCheck(c.uyarilar || []);
      const cakismaVar = c.cakisma_var === true || hover === 'engel';
      if (cakismaVar) {
        setHata('Bu personel aynı saatte başka bir slotta zaten atanmış (çakışma).');
        await yukleGun();
        return;
      }
      const needOverride = c.override_gerekir === true
        || (c.override_gerekir === undefined && c.kritik_var);
      if (needOverride) {
        setOverrideModal({
          payload: body,
          uyarilar: c.uyarilar,
          transferAtamaId,
          ozetMetni,
        });
        return;
      }
      if ((c.uyarilar || []).length > 0) {
        setUyariOnayModal({
          payload: body,
          uyarilar: c.uyarilar,
          transferAtamaId,
          ozetMetni,
        });
        return;
      }
      await tamamlaNormalAtama(body, transferAtamaId);
    } catch (e) {
      setHata(e.message || 'Atama başarısız');
      await yukleGun();
    }
  }, [gunPlani, tamamlaNormalAtama, yukleGun]);

  useEffect(() => { yukleSubeler(); }, [yukleSubeler]);
  useEffect(() => { yukleGun(); }, [yukleGun]);
  useEffect(() => { void yukleIzinHaftaOzet(); }, [yukleIzinHaftaOzet]);

  useEffect(() => {
    setHavuzTarihOverride(null);
  }, [tarih]);

  useEffect(() => {
    let cancel = false;
    if (havuzKaynakTarih === tarih) {
      setHavuzGunPlani(null);
      setHavuzYukleniyor(false);
      return;
    }
    (async () => {
      setHavuzYukleniyor(true);
      try {
        const q = subeFilter ? `&sube_id=${subeFilter}` : '';
        const r = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(havuzKaynakTarih)}${q}`);
        if (!cancel) setHavuzGunPlani(r);
      } catch (e) {
        if (!cancel) setHata(e.message || 'Havuz günü yüklenemedi');
      } finally {
        if (!cancel) setHavuzYukleniyor(false);
      }
    })();
    return () => { cancel = true; };
  }, [havuzKaynakTarih, tarih, subeFilter, gunPlani]);

  useEffect(() => {
    if (!raporAcik) return;
    let cancel = false;
    (async () => {
      setRaporYukleniyor(true);
      try {
        const q = `baslangic=${encodeURIComponent(raporBas)}&bitis=${encodeURIComponent(raporBit)}`;
        const [f, iz] = await Promise.all([
          api(`/vardiya/v2/rapor/fazla-mesai?${q}`),
          api(`/vardiya/v2/rapor/izinli-calisti?${q}`),
        ]);
        if (!cancel) {
          setRaporFazla(f);
          setRaporIzinli(iz);
        }
      } catch (e) {
        if (!cancel) setHata(e.message || 'Rapor yüklenemedi');
      } finally {
        if (!cancel) setRaporYukleniyor(false);
      }
    })();
    return () => { cancel = true; };
  }, [raporAcik, raporBas, raporBit]);

  const tarihGoster = useMemo(() => {
    const d = new Date(tarih + 'T00:00:00');
    return `${d.getDate()} ${TR_AYLAR[d.getMonth()]} ${d.getFullYear()} (${TR_GUNLER[(d.getDay() + 6) % 7]})`;
  }, [tarih]);

  const haftaGunleri = useMemo(() => {
    const pzt = pazartesiIso(tarih);
    const d0 = new Date(`${pzt}T12:00:00`);
    return Array.from({ length: 7 }, (_, i) => {
      const x = new Date(d0);
      x.setDate(x.getDate() + i);
      const iso = x.toISOString().slice(0, 10);
      const idx = (x.getDay() + 6) % 7;
      return { iso, kisa: TR_GUNLER[idx].slice(0, 3), secili: iso === tarih };
    });
  }, [tarih]);

  const havuzPersonelKaynagi = useMemo(() => {
    if (havuzKaynakTarih === tarih) return gunPlani;
    return havuzGunPlani;
  }, [havuzKaynakTarih, tarih, gunPlani, havuzGunPlani]);

  const filtrelenmisHavuz = useMemo(() => {
    const q = personelMetinFiltre.trim().toLowerCase();
    const list = havuzPersonelKaynagi?.personel_havuzu || [];
    if (!q) return list;
    return list.filter((p) => `${p.ad || ''} ${p.soyad || ''}`.toLowerCase().includes(q));
  }, [havuzPersonelKaynagi, personelMetinFiltre]);

  const eksikSlotSayisi = useMemo(() => {
    if (!gunPlani?.subeler) return 0;
    let n = 0;
    for (const s of gunPlani.subeler) {
      for (const sv of s.slotlar || []) {
        if (sv.eksik > 0) n += 1;
      }
    }
    return n;
  }, [gunPlani]);

  const filtrelenmisSubeler = useMemo(() => {
    const raw = gunPlani?.subeler || [];
    if (!subeFilter) return raw;
    return raw.filter((s) => String(s.sube_id) === String(subeFilter));
  }, [gunPlani, subeFilter]);

  /** Gün matrisi: seçili gün + şube filtresindeki slotlardan bantlar (30/60/120 dk) */
  const saatBantlariGunMatris = useMemo(
    () => saatBantlariPlandan(gunPlani, filtrelenmisSubeler, 30),
    [gunPlani, filtrelenmisSubeler],
  );

  /** Şube×hafta matrisi: haftadaki tüm günlerin slot birleşimi — her güne aynı satır hizası */
  const saatBantlariHaftaMatris = useMemo(() => {
    if (!haftaPlanCache || typeof haftaPlanCache !== 'object') return saatBantlari();
    const list = [];
    for (const p of Object.values(haftaPlanCache)) {
      for (const s of p?.subeler || []) list.push(s);
    }
    if (!list.length) return saatBantlari();
    return saatBantlariPlandan({ subeler: list }, list, 30);
  }, [haftaPlanCache]);

  const slotMatris = useMemo(
    () => slotMatrisHaritasiOlustur(gunPlani, filtrelenmisSubeler, saatBantlariGunMatris),
    [gunPlani, filtrelenmisSubeler, saatBantlariGunMatris],
  );

  const altOzetPersonel = useMemo(() => {
    const list = gunPlani?.personel_havuzu || [];
    return list.map((p) => {
      const d = p.gun_durumu || {};
      const maxGun = (Number.isFinite(Number(d.max_gunluk_saat)) && Number(d.max_gunluk_saat) > 0)
        ? Number(d.max_gunluk_saat)
        : 9.5;
      const toplam = Number(d.toplam_saat) || 0;
      const fazla  = Number(d.fazla_gunluk_saat) || Math.max(0, toplam - maxGun);
      return {
        id: p.id,
        etiket: `${p.ad || ''} ${p.soyad || ''}`.trim(),
        toplam,
        maxGun,
        fazla,
        izinli: d.durum === 'IZINLI',
      };
    });
  }, [gunPlani]);

  const fazlaMesaiSayisi = useMemo(
    () => altOzetPersonel.filter(o => !o.izinli && o.fazla > 0).length,
    [altOzetPersonel]
  );

  /** Gün planından anlık uyarı satırları (alt panel / şema benzeri canlı liste) */
  const canliUyariListesi = useMemo(() => {
    if (!gunPlani) return [];
    const uy = [];
    const MAX = 28;
    const push = (seviye, metin) => {
      if (uy.length >= MAX) return;
      uy.push({ seviye, metin });
    };

    if (gunPlani.gun_kilitli) {
      push('kritik', 'Gün kilitli — yeni atamalar yalnızca override onayı ile yapılabilir.');
    }

    for (const s of gunPlani.subeler || []) {
      if (s.ihtiyac_hedef_kisi != null && s.ihtiyac_durumu === 'altinda') {
        const at = Number.isFinite(Number(s.atanan_benzersiz_kisi)) ? Number(s.atanan_benzersiz_kisi) : 0;
        push(
          'uyari',
          `${s.sube_ad}: şube hedefi altında (hedef ${s.ihtiyac_hedef_kisi} kişi, bugün bu şubede atanan benzersiz ${at}) — slot min’den bağımsız`,
        );
      }
      for (const sv of s.slotlar || []) {
        if (sv.eksik > 0) {
          push(
            'uyari',
            `${s.sube_ad}: ${sv.slot?.ad || 'Slot'} ${fmtSaat(sv.slot?.baslangic_saat)}–${fmtSaat(sv.slot?.bitis_saat)} · min ${sv.min_personel}, eksik ${sv.eksik}`,
          );
        } else if ((sv.ideal_eksik || 0) > 0) {
          push(
            'bilgi',
            `${s.sube_ad}: ${sv.slot?.ad || 'Slot'} · ideal altı (${sv.atanan_personel}/${sv.ideal_personel})`,
          );
        }
      }
    }

    const fm = altOzetPersonel.filter((o) => !o.izinli && o.fazla > 0);
    if (fm.length) {
      const names = fm.map((o) => o.etiket).filter(Boolean);
      const head = names.slice(0, 10).join(', ');
      const tail = names.length > 10 ? ` (+${names.length - 10} kişi daha)` : '';
      push('kritik', `Günlük limit üstü saat: ${fm.length} kişi — ${head}${tail}`);
    }

    for (const o of altOzetPersonel) {
      if (o.izinli) continue;
      if (o.maxGun <= 0) continue;
      const pct = (o.toplam / o.maxGun) * 100;
      if (pct >= 90 && o.fazla <= 0) {
        push('uyari', `${o.etiket}: günlük süre %${Math.round(pct)} dolu (${o.toplam.toFixed(1)}/${o.maxGun} saat)`);
      }
    }

    let planYokN = 0;
    for (const p of gunPlani.personel_havuzu || []) {
      const d = p.gun_durumu || {};
      if (d.durum === 'PLANLANMADI') {
        planYokN += 1;
        if (planYokN <= 6) {
          push('bilgi', `${p.ad || ''} ${p.soyad || ''}: plan yok (bu güne atanmamış)`.trim());
        }
      }
      if (d.override_var) {
        push('bilgi', `${p.ad || ''} ${p.soyad || ''}: bu gün için override log kaydı var`.trim());
      }
    }
    if (planYokN > 6) {
      push('bilgi', `… ve ${planYokN - 6} personel daha: plan yok durumunda`);
    }

    return uy;
  }, [gunPlani, altOzetPersonel]);

  const havuzById = useMemo(() => {
    const m = new Map();
    for (const p of gunPlani?.personel_havuzu || []) m.set(p.id, p);
    for (const p of havuzPersonelKaynagi?.personel_havuzu || []) m.set(p.id, p);
    return m;
  }, [gunPlani, havuzPersonelKaynagi]);

  useEffect(() => {
    if (gorunumModu !== 'sube_hafta') {
      setHaftaPlanCache(null);
      return;
    }
    const sid = subeHaftaId || gunPlani?.subeler?.[0]?.sube_id || subeler[0]?.id;
    if (!sid) return;
    let cancel = false;
    (async () => {
      setHaftaYukleniyor(true);
      try {
        const d0 = new Date(`${pazartesiSecili}T12:00:00`);
        const isolar = Array.from({ length: 7 }, (_, i) => {
          const x = new Date(d0);
          x.setDate(x.getDate() + i);
          return x.toISOString().slice(0, 10);
        });
        const entries = await Promise.all(
          isolar.map(async (iso) => {
            try {
              const pl = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(iso)}&sube_id=${encodeURIComponent(sid)}`);
              return [iso, pl];
            } catch {
              return [iso, null];
            }
          }),
        );
        if (!cancel) setHaftaPlanCache(Object.fromEntries(entries));
      } finally {
        if (!cancel) setHaftaYukleniyor(false);
      }
    })();
    return () => { cancel = true; };
  }, [gorunumModu, pazartesiSecili, subeHaftaId, gunPlani, subeler]);

  useEffect(() => {
    if (gorunumModu !== 'personel_hafta') {
      setPersonelHafta(null);
      return;
    }
    let cancel = false;
    (async () => {
      setPersonelHaftaYukleniyor(true);
      try {
        const r = await api(`/vardiya/v2/hafta-personel-tablo?pazartesi=${encodeURIComponent(pazartesiSecili)}`);
        if (!cancel) setPersonelHafta(r);
      } catch (e) {
        if (!cancel) setHata(e.message || 'Haftalık personel tablosu yüklenemedi');
      } finally {
        if (!cancel) setPersonelHaftaYukleniyor(false);
      }
    })();
    return () => { cancel = true; };
  }, [gorunumModu, pazartesiSecili]);

  useEffect(() => {
    if (gorunumModu === 'sube_hafta' && !subeHaftaId && (gunPlani?.subeler?.[0]?.sube_id || subeler[0]?.id)) {
      setSubeHaftaId(String(gunPlani?.subeler?.[0]?.sube_id || subeler[0].id));
    }
  }, [gorunumModu, subeHaftaId, gunPlani, subeler]);

  useEffect(() => {
    transferAtamaRef.current = null;
    setDraggedPersonel(null);
    setDragSlotPreview(null);
    draggedRef.current = null;
  }, [tarih]);

  function tarihKaydir(gun) {
    const d = new Date(tarih + 'T00:00:00');
    d.setDate(d.getDate() + gun);
    setTarih(d.toISOString().slice(0, 10));
  }

  // ── DRAG-DROP: havuzda izinli / günlük süre dolu → baştan kapalı; slot üzerinde yeşil/sarı/kırmızı önizleme ──
  function onDragStartHavuz(e, p) {
    if (!havuzdanSuruklenebilirMi(p)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    draggedRef.current = p;
    setDragSlotPreview(null);
    setDraggedPersonel(p);
  }

  function planGunDragOnizleme(gunTarihi) {
    if (gunTarihi === tarih) return gunPlani;
    if (gorunumModu === 'sube_hafta' && haftaPlanCache?.[gunTarihi]) return haftaPlanCache[gunTarihi];
    return null;
  }

  /** Yerel çakışma (anı) + debounced atama/check (kesin) */
  function planlaSlotOnizleme(slotId, gunTarihi = tarih) {
    const p = draggedRef.current;
    if (!p || !havuzdanSuruklenebilirMi(p)) return;
    const planGun = planGunDragOnizleme(gunTarihi);
    const yerel = yerelDragSlotDurum(p, slotId, gunTarihi, planGun);
    if (yerel === 'engel') {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      setDragSlotPreview({ slotId, gunTarihi, durum: 'engel', yerelOnly: true });
      return;
    }
    if (yerel === 'ok') {
      setDragSlotPreview({ slotId, gunTarihi, durum: 'ok', yerelOnly: true });
    }
    const seq = ++previewReqRef.current;
    previewTimerRef.current = setTimeout(async () => {
      if (draggedRef.current?.id !== p.id || seq !== previewReqRef.current) return;
      try {
        const body = {
          personel_id: p.id,
          slot_id: slotId,
          tarih: gunTarihi,
          override: false,
          otomatik_saat_cozumu: true,
        };
        const c = await api('/vardiya/v2/atama/check', { method: 'POST', body });
        if (draggedRef.current?.id !== p.id || seq !== previewReqRef.current) return;
        const durum = slotHoverDurumuFromCheck(c.uyarilar || []);
        setDragSlotPreview({ slotId, gunTarihi, durum, yerelOnly: false });
      } catch {
        if (draggedRef.current?.id === p.id && seq === previewReqRef.current) {
          setDragSlotPreview({ slotId, gunTarihi, durum: 'uyari', yerelOnly: false });
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
  }

  function slotDragOver(e, slotId, gunTarihi = tarih) {
    e.preventDefault();
    if (!draggedRef.current || !havuzdanSuruklenebilirMi(draggedRef.current)) {
      try { e.dataTransfer.dropEffect = 'none'; } catch { /* yok */ }
      return;
    }
    const pv = dragSlotPreview;
    const engelMi = pv?.slotId === slotId && pv?.gunTarihi === gunTarihi && pv?.durum === 'engel';
    e.dataTransfer.dropEffect = engelMi ? 'none' : 'copy';
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    planlaSlotOnizleme(slotId, gunTarihi);
  }

  async function kasitliBosDegistir(personelId, kasitliBos) {
    const gun = havuzKaynakTarih;
    try {
      await api('/vardiya/v2/personel-gun', {
        method: 'PUT',
        body: { personel_id: personelId, tarih: gun, kasitli_bos: kasitliBos },
      });
      if (gun === tarih) await yukleGun();
      else {
        const q = subeFilter ? `&sube_id=${subeFilter}` : '';
        const r = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(gun)}${q}`);
        setHavuzGunPlani(r);
      }
    } catch (e) {
      setHata(e.message || 'Kaydedilemedi');
    }
  }

  /** Şube × gün hedef kişi (vardiya_sube_gun_hedef); null = hedef kaldır */
  async function subeGunHedefKaydet(subeId, rawVal) {
    let hedef_personel = null;
    if (rawVal != null && String(rawVal).trim() !== '') {
      const n = parseInt(String(rawVal).trim(), 10);
      if (Number.isNaN(n) || n < 0) {
        setHata('Hedef kişi: 0 veya pozitif tam sayı girin.');
        return;
      }
      hedef_personel = n;
    }
    try {
      await api('/vardiya/v2/sube-gun-hedef', {
        method: 'PUT',
        body: { sube_id: subeId, tarih, hedef_personel },
      });
      await yukleGun();
    } catch (e) {
      setHata(e.message || 'Hedef kaydedilemedi');
    }
  }

  async function toggleGunKilit() {
    try {
      const next = !gunPlani?.gun_kilitli;
      await api('/vardiya/v2/gun-kilit', { method: 'PUT', body: { tarih, kilitli: next } });
      await yukleGun();
    } catch (e) {
      setHata(e.message || 'Gün kilidi güncellenemedi');
    }
  }

  async function slotUretFromSube(subeId, subeAd) {
    const msg = `${subeAd || 'Şube'}: Şube kartındaki çalışma saatleri ve yoğun penceresi bilgisine göre zaman dilimleri (AUTO:) otomatik bölünür.\n`
      + 'Ataması olan AUTO slot silinmez; kalanları silinip yenilenir. Devam?';
    if (!confirm(msg)) return;
    try {
      setHata('');
      const r = await api('/vardiya/v2/slot/uret', {
        method: 'POST',
        body: {
          sube_id: subeId,
          mod: 'yenile',
          hafta_ici: false,
          acilis_dakika: 60,
          kapanis_dakika: 60,
          normal_slot_dakika: 120,
        },
      });
      if (r?.uyarilar?.length) window.alert(r.uyarilar.join('\n'));
      await yukleGun();
    } catch (e) {
      setHata(e.message || 'Slot üretimi başarısız');
    }
  }

  async function slotUretTumSubeler() {
    const list = gunPlani?.subeler || [];
    if (!list.length) {
      setHata('Şube listesi boş.');
      return;
    }
    if (!confirm(`${list.length} şube için şube saatlerinden AUTO slot yenilenecek (ataması olan AUTO slot korunur). Devam?`)) return;
    setHata('');
    for (const s of list) {
      try {
        const r = await api('/vardiya/v2/slot/uret', {
          method: 'POST',
          body: {
            sube_id: s.sube_id,
            mod: 'yenile',
            hafta_ici: false,
            acilis_dakika: 60,
            kapanis_dakika: 60,
            normal_slot_dakika: 120,
          },
        });
        if (r?.uyarilar?.length) window.alert(`${s.sube_ad}:\n${r.uyarilar.join('\n')}`);
      } catch (e) {
        setHata(`${s.sube_ad}: ${e.message || 'Slot üretimi başarısız'}`);
        await yukleGun();
        return;
      }
    }
    await yukleGun();
  }

  function onDragEnd() {
    previewReqRef.current += 1;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    transferAtamaRef.current = null;
    draggedRef.current = null;
    setDraggedPersonel(null);
    setDragSlotPreview(null);
  }

  async function dropToSlot(slotId, gunTarihi = tarih) {
    /** State bazen henüz commit olmadan drop gelir; ref dragstart'ta senkron yazılır */
    const personel = draggedPersonel || draggedRef.current;
    if (!personel) {
      setHata('Sürüklenen personel bulunamadı — tekrar sürükleyip bırakın.');
      return;
    }
    const xfer = transferAtamaRef.current;
    const transferAtamaId = xfer?.atamaId || null;
    const fromGun = xfer?.fromGunTarihi || tarih;
    if (xfer?.fromSlotId && xfer.fromSlotId === slotId && fromGun === gunTarihi) {
      transferAtamaRef.current = null;
      previewReqRef.current += 1;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      return;
    }
    // Havuz → slot: yalnızca izinli kartlar drop zincirine girmesin (toast / önizleme yok)
    if (!transferAtamaId && !havuzdanSuruklenebilirMi(personel)) {
      transferAtamaRef.current = null;
      previewReqRef.current += 1;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      setDraggedPersonel(null);
      draggedRef.current = null;
      setDragSlotPreview(null);
      setHata('İzinli personel havuzdan slota atanamaz.');
      return;
    }
    const planForGun = (gorunumModu === 'sube_hafta' && haftaPlanCache?.[gunTarihi])
      ? haftaPlanCache[gunTarihi]
      : gunPlani;
    const row = planSlotSatirBul(planForGun, slotId);
    if (!row?.sv?.slot) {
      setHata('Slot bulunamadı — planı yenileyin.');
      transferAtamaRef.current = null;
      previewReqRef.current += 1;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      return;
    }
    setDraggedPersonel(null);
    draggedRef.current = null;
    setDragSlotPreview(null);
    transferAtamaRef.current = null;
    previewReqRef.current += 1;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    setDropSaatModal({
      personel,
      slotId,
      gunTarihi,
      transferAtamaId,
      planForGun,
    });
  }

  async function uyariOnaylaEvet() {
    if (!uyariOnayModal) return;
    const { payload, transferAtamaId } = uyariOnayModal;
    setUyariOnayModal(null);
    try {
      await tamamlaNormalAtama(payload, transferAtamaId);
    } catch (e) {
      setHata(e.message || 'Atama başarısız');
      await yukleGun();
    }
  }

  async function uyariOnayIptal() {
    setUyariOnayModal(null);
    await yukleGun();
  }

  function personelHaftaGunBaslik(iso) {
    const d = new Date(`${iso}T12:00:00`);
    return TR_GUNLER[(d.getDay() + 6) % 7].slice(0, 3);
  }

  function personelHaftaExcel() {
    if (!personelHafta?.gunler?.length || !personelHafta?.satirlar) return;
    const { gunler, satirlar, pazartesi: pzt } = personelHafta;
    const hdr = ['Şube', 'Görev', 'Ad', 'Soyad', ...gunler.map(personelHaftaGunBaslik), 'Kapanış', 'Notlar'];
    const rows = satirlar.map((row) => [
      row.sube_ad,
      row.gorev,
      row.ad,
      row.soyad,
      ...gunler.map((g) => (row.gunler?.[g]?.metin || '').replace(/\n/g, ' | ')),
      row.kapanis_sayisi,
      row.notlar || '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([hdr, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hafta');
    XLSX.writeFile(wb, `vardiya-personel-hafta-${pzt}.xlsx`);
  }

  function personelHaftaPdf() {
    if (!personelHafta?.gunler?.length || !personelHafta?.satirlar) return;
    const { gunler, satirlar, pazartesi: pzt } = personelHafta;
    const head = [['Şube', 'Görev', 'Ad', 'Soyad', ...gunler.map(personelHaftaGunBaslik), 'Kap.', 'Notlar']];
    const body = satirlar.map((row) => [
      row.sube_ad,
      row.gorev,
      row.ad,
      row.soyad,
      ...gunler.map((g) => (row.gunler?.[g]?.metin || '—').replace(/\n/g, ' ')),
      String(row.kapanis_sayisi ?? ''),
      (row.notlar || '').slice(0, 200),
    ]);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
    autoTable(doc, {
      head,
      body,
      styles: { fontSize: 6, cellPadding: 1 },
      headStyles: { fillColor: [79, 142, 247] },
    });
    doc.save(`vardiya-personel-hafta-${pzt}.pdf`);
  }

  async function otomatikDoldur() {
    if (gunPlani?.gun_kilitli) {
      setHata('Gün kilitli — otomatik doldurma override gerektiren atamaları yapmaz.');
      return;
    }
    if (!confirm(
      'Akıllı otomatik doldur: eksik slotlarda önce tanımlı şablonlar ve slot içindeki boş zamana uygun dilimler, '
      + 'gerekirse 30 dk kaydırarak denenir; şube geçiş tamponu ve kurallar sunucuda doğrulanır. '
      + 'Override gerektiren kritikleri atlar. Devam?',
    )) return;
    setOtomatikBusy(true);
    setHata('');
    let toplam = 0;
    try {
      for (let round = 0; round < 120; round += 1) {
        const r = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(tarih)}`);
        const eksikler = [];
        for (const sub of r.subeler || []) {
          for (const sv of sub.slotlar || []) {
            if (sv.eksik > 0) eksikler.push({ sv, sube_id: sub.sube_id });
          }
        }
        eksikler.sort((a, b) => {
          const pa = (a.sv.eksik || 0) * 100 + (a.sv.ideal_eksik || 0);
          const pb = (b.sv.eksik || 0) * 100 + (b.sv.ideal_eksik || 0);
          if (pb !== pa) return pb - pa;
          return String(a.sv.slot.baslangic_saat || '').localeCompare(String(b.sv.slot.baslangic_saat || ''));
        });
        if (!eksikler.length) break;
        let ilerleme = false;
        for (const row of eksikler) {
          if (ilerleme) break;
          const kadro = (r.personel_havuzu || []).filter((p) => {
            const d = p.gun_durumu || {};
            if (d.durum === 'IZINLI') return false;
            if ((d.kalan_saat || 0) <= 0) return false;
            return true;
          }).sort((a, b) => {
            const ka = Number(a.gun_durumu?.kalan_saat) || 0;
            const kb = Number(b.gun_durumu?.kalan_saat) || 0;
            if (kb !== ka) return kb - ka;
            const na = Number(a.gun_durumu?.atama_sayisi) || 0;
            const nb = Number(b.gun_durumu?.atama_sayisi) || 0;
            return na - nb;
          });
          for (const p of kadro) {
            const adaylar = otomatikAtamaSaatAdaylari(p, row.sv.slot, row.sube_id);
            let yerlesti = false;
            for (const ab of adaylar) {
              const checkBody = {
                personel_id: p.id,
                slot_id: row.sv.slot.id,
                tarih,
                override: false,
                baslangic_saat: ab.bas,
                bitis_saat: ab.bit,
              };
              const c = await api('/vardiya/v2/atama/check', { method: 'POST', body: checkBody });
              if (slotHoverDurumuFromCheck(c.uyarilar || []) === 'engel') continue;
              if (c.kritik_var) continue;
              await api(V2_ATAMA_POST, { method: 'POST', body: checkBody });
              toplam += 1;
              yerlesti = true;
              ilerleme = true;
              break;
            }
            if (yerlesti) break;
            const fallbackBody = {
              personel_id: p.id,
              slot_id: row.sv.slot.id,
              tarih,
              override: false,
              otomatik_saat_cozumu: true,
            };
            const c0 = await api('/vardiya/v2/atama/check', { method: 'POST', body: fallbackBody });
            if (slotHoverDurumuFromCheck(c0.uyarilar || []) === 'engel') continue;
            if (c0.kritik_var) continue;
            await api(V2_ATAMA_POST, { method: 'POST', body: fallbackBody });
            toplam += 1;
            ilerleme = true;
            break;
          }
        }
        if (!ilerleme) break;
      }
      await yukleGun();
      window.alert(toplam > 0 ? `Otomatik doldur: ${toplam} atama yapıldı (şablon/kaydırma veya sunucu önerisi).` : 'Uygun yeni atama kalmadı (veya tüm eksikler kurallara takılıyor).');
    } catch (e) {
      setHata(e.message || 'Otomatik doldur başarısız');
      await yukleGun();
    } finally {
      setOtomatikBusy(false);
    }
  }

  async function haftaMotoruCalistir() {
    if (!confirm(
      'Haftalık plan motoru: seçili tarihin ISO haftası (Pzt–Paz) için eksik slotları öncelik sırasıyla doldurur '
      + '(ana şube, haftalık saat dengesi, gün içi çoklu şube maliyeti). Gerekirse kişiyi başka bir slottan '
      + 'taşır (verilebilir atama = donor slotta iptal sonrası min kontenjan korunur). Devam?',
    )) return;
    setMotorBusy(true);
    setHata('');
    try {
      const r = await api('/vardiya/v2/motor/hafta-doldur', {
        method: 'POST',
        body: {
          pazartesi: pazartesiSecili,
          max_rounds: 120,
          tasima_izni: true,
          dry_run: false,
        },
      });
      setMotorSonuc({
        mesaj: r.mesaj || '',
        log: r.log || [],
        atama_sayisi: r.atama_sayisi,
        tur_sayisi: r.tur_sayisi,
      });
      await yukleGun();
    } catch (e) {
      setHata(e.message || 'Haftalık motor başarısız');
      await yukleGun();
    } finally {
      setMotorBusy(false);
    }
  }

  async function overrideOnayla(kullaniciGerekce = '') {
    if (!overrideModal) return;
    const gerekce = (kullaniciGerekce || '').trim() || null;
    try {
      const tid = overrideModal.transferAtamaId;
      if (tid) {
        await api(`/vardiya/v2/atama/${tid}`, { method: 'DELETE' });
      }
      await api(V2_ATAMA_POST, {
        method: 'POST',
        body: { ...overrideModal.payload, override: true, aciklama: gerekce },
      });
      const gt = overrideModal.payload.tarih;
      setOverrideModal(null);
      await yukleGun();
      await planGunTazele(gt);
    } catch (e) {
      setHata(e.message || 'Override başarısız');
    }
  }

  async function izinliYapHizli(p) {
    if (!confirm(`${p.ad} ${p.soyad || ''} için ${tarih} tarihine 1 günlük "mazeret" izni eklensin mi?`)) return;
    try {
      await api('/vardiya/v2/izin', {
        method: 'POST',
        body: { personel_id: p.id, baslangic_tarih: tarih, bitis_tarih: tarih, tip: 'mazeret', aciklama: 'Hızlı izin' },
      });
      await yukleGun();
    } catch (e) { setHata(e.message || 'İzin eklenemedi'); }
  }

  async function gunTemizle() {
    if (!confirm(`${tarih} tarihindeki ${subeFilter ? 'seçili şube' : 'TÜM ŞUBELERİN'} atamaları iptal edilsin mi?`)) return;
    try {
      const q = subeFilter ? `&sube_id=${subeFilter}` : '';
      const r = await api(`/vardiya/v2/gun-temizle?tarih=${tarih}${q}`, { method: 'POST' });
      window.alert(`${r.iptal_edilen || 0} atama iptal edildi.`);
      await yukleGun();
    } catch (e) { setHata(e.message || 'Temizleme başarısız'); }
  }

  async function gunKopyala() {
    const k = window.prompt(`Hedef tarihi gir (YYYY-MM-DD). ${tarih} → ?`, tarih);
    if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
    if (k === tarih) { setHata('Kaynak ve hedef tarih aynı.'); return; }
    if (!confirm(`${tarih} → ${k} kopyalansın mı? Hedef gün önce TEMİZLENECEK.`)) return;
    try {
      const q = subeFilter ? `&sube_id=${subeFilter}` : '';
      const r = await api(`/vardiya/v2/gun-kopyala?kaynak=${tarih}&hedef=${k}${q}&temizle=true`, { method: 'POST' });
      window.alert(`${r.kopyalanan || 0} atama kopyalandı (${tarih} → ${k}).`);
      setTarih(k);
    } catch (e) { setHata(e.message || 'Kopyalama başarısız'); }
  }

  async function atamaIptal(atamaId, silent = false) {
    if (!silent && !confirm('Atamayı iptal etmek istediğinden emin misin?')) return;
    try {
      await api(`/vardiya/v2/atama/${atamaId}`, { method: 'DELETE' });
      await yukleGun();
      if (gorunumModu === 'sube_hafta') setHaftaPlanCache(null);
    } catch (e) { setHata(e.message); }
  }

  /** Havuz kartı: seçilen şubede o gün için personelin tüm atamalarını iptal eder (başka şubeye sürüklemek için). */
  async function personelSubeGunAtamalariniKaldir(p, subeId) {
    const gun = havuzKaynakTarih;
    const ids = (p.gun_durumu?.atamalar || [])
      .filter((a) => String(a.sube_id || '') === String(subeId))
      .map((a) => a.id)
      .filter(Boolean);
    if (!ids.length) return;
    const sid = String(subeId);
    const ad = (subeler || []).find((s) => String(s.id) === sid)?.ad || sid;
    if (!confirm(`${p.ad} ${p.soyad || ''} — ${gun} · ${ad}\nBu şubedeki ${ids.length} atama iptal edilsin mi?`)) return;
    try {
      for (const id of ids) {
        await api(`/vardiya/v2/atama/${id}`, { method: 'DELETE' });
      }
      await yukleGun();
      if (gorunumModu === 'sube_hafta') setHaftaPlanCache(null);
      await planGunTazele(gun);
      if (gun !== tarih) {
        const q = subeFilter ? `&sube_id=${subeFilter}` : '';
        const r = await api(`/vardiya/v2/gun?tarih=${encodeURIComponent(gun)}${q}`);
        setHavuzGunPlani(r);
      }
    } catch (e) {
      setHata(e.message || 'Atamalar iptal edilemedi');
    }
  }

  /** Matris hücresi: saat bandı + üst üste avatarlar + [+] drop · 🟢… + sürükle (havuz / chip transfer) */
  function matrisSlotHucre(sv, s, gunTarihi = tarih, matrisBandKey = '') {
    const t = SLOT_TIPI[sv.slot.tip] || SLOT_TIPI.normal;
    const eksik = sv.eksik > 0;
    const idealUyari = !eksik && (sv.ideal_eksik > 0);
    const doluTam = sv.atanan_personel >= sv.min_personel && !eksik;
    const pv = dragSlotPreview?.slotId === sv.slot.id && dragSlotPreview?.gunTarihi === gunTarihi
      ? dragSlotPreview.durum
      : null;
    const ringDrag = pv === 'ok' ? '0 0 0 3px rgba(34,197,94,0.85)' : pv === 'uyari' ? '0 0 0 3px rgba(250,204,21,0.95)' : pv === 'engel' ? '0 0 0 3px rgba(239,68,68,0.95)' : '';
    // Spec: Boş gri / Dolu yeşil / Eksik turuncu; açılış|kapanış ekstra mavi halka (durum çerçevesini ezmez)
    const kritikSlot = sv.slot.tip === 'acilis' || sv.slot.tip === 'kapanis';
    let borderCol = '#cbd5e1';                  // Boş = gri
    let bgHucre   = 'transparent';
    const borderW = 2;
    if (eksik) {
      borderCol = '#fb923c';                    // Eksik = turuncu
      bgHucre   = 'rgba(251,146,60,0.10)';
    } else if (idealUyari) {
      borderCol = '#facc15';                    // Yetersiz ideal = sarı
      bgHucre   = 'rgba(250,204,21,0.10)';
    } else if (doluTam) {
      borderCol = '#22c55e';                    // Dolu = yeşil
      bgHucre   = 'rgba(34,197,94,0.08)';
    } else if (sv.atanan_personel === 0) {
      borderCol = '#cbd5e1';                    // Boş gri
      bgHucre   = 'transparent';
    }
    const kritikMaviHalka = kritikSlot ? '0 0 0 2px rgba(37,99,235,0.88)' : '';
    const boxShadowParts = [kritikMaviHalka, ringDrag].filter(Boolean);
    const hucreBoxShadow = boxShadowParts.length ? boxShadowParts.join(', ') : 'none';
    return (
      <div
        key={`${sv.slot.id}-${gunTarihi}-${matrisBandKey || '0'}`}
        onDragOver={(e) => slotDragOver(e, sv.slot.id, gunTarihi)}
        onDrop={(e) => {
          e.preventDefault();
          if (
            dragSlotPreview?.slotId === sv.slot.id
            && dragSlotPreview?.gunTarihi === gunTarihi
            && dragSlotPreview?.durum === 'engel'
          ) {
            setHata('Bu personel aynı saatte başka bir slotta zaten atanmış (çakışma).');
            previewReqRef.current += 1;
            if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
            draggedRef.current = null;
            transferAtamaRef.current = null;
            setDraggedPersonel(null);
            setDragSlotPreview(null);
            return;
          }
          dropToSlot(sv.slot.id, gunTarihi);
        }}
        style={{
          border: `${borderW}px solid ${borderCol}`,
          borderRadius: 8,
          padding: 8,
          marginBottom: 8,
          background: draggedPersonel ? 'rgba(79,142,247,0.07)' : bgHucre,
          boxShadow: hucreBoxShadow,
          transition: 'background 0.15s, box-shadow 0.12s',
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text2)', marginBottom: 4, letterSpacing: 0.2 }}>
          <span style={{ color: 'var(--text3)', fontWeight: 600 }}>Çerçeve </span>
          {fmtSaat(sv.slot.baslangic_saat)}–{fmtSaat(sv.slot.bitis_saat)}
          <span style={{ marginLeft: 6, fontWeight: 600, color: eksik ? '#ea580c' : idealUyari ? '#ca8a04' : doluTam ? '#64748b' : '#16a34a' }}>
            {eksik ? '🟠' : idealUyari ? '🟡' : doluTam ? '⚫' : '🟢'}
          </span>
        </div>
        {sv.atamalar.length > 0 ? (() => {
          const oz = atamaListesiIsOzeti(sv.atamalar);
          if (!oz) return null;
          return (
            <div style={{ fontSize: 9, color: 'var(--text3)', marginBottom: 4, lineHeight: 1.3 }}>
              Atama özeti: <span style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, color: 'var(--text2)' }}>{oz.basStr}–{oz.bitStr}</span>
            </div>
          );
        })() : null}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 11, color: t.renk }}>
            {t.ikon} {sv.slot.ad}
          </div>
          <button
            type="button"
            onClick={() => setSlotModal({ sube_id: s.sube_id, slot: sv.slot })}
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 11 }}
            title="Slot ayarı"
          >⚙
          </button>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>
          <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{sv.atanan_personel}/{sv.min_personel}</span>
          {sv.ideal_personel > 0 && (
            <span style={{ marginLeft: 6 }}>ideal {sv.atanan_personel}/{sv.ideal_personel}</span>
          )}
        </div>
        {sv.atamalar.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic', padding: '8px 0', textAlign: 'center', borderTop: '1px dashed var(--border)' }}>
            <div>Sürükle bırak</div>
            <div style={{ marginTop: 6, fontWeight: 800, color: '#94a3b8', letterSpacing: 2 }}>[ ＋ ]</div>
          </div>
        ) : (
          <div className="slot-avatar-stack" aria-label="Atanan personel">
            {sv.atamalar.map((a, i) => {
              const pChip = havuzById.get(a.personel_id) || {
                id: a.personel_id,
                ad: a.personel_ad,
                soyad: a.personel_soyad,
                gun_durumu: {},
                haftalik_saat: 0,
              };
              const tamAd = `${a.personel_ad || ''} ${a.personel_soyad || ''}`.trim() || 'Personel';
              const initials = avatarBasHarfler(a.personel_ad, a.personel_soyad);
              return (
                <div
                  key={a.id}
                  className="slot-avatar-wrap"
                  style={{ marginLeft: i === 0 ? 0 : -11, zIndex: i + 1 }}
                  title={`${tamAd} · ${s.sube_ad || 'Şube'}${a.yemek_sube_ad ? ` · 🍽 ${a.yemek_sube_ad}` : ''} — sürükleyerek taşı · ✕ tek atama iptal`}
                >
                  <div
                    className="slot-avatar-face"
                    draggable={slottanSuruklenebilirMi(pChip)}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      if (!slottanSuruklenebilirMi(pChip)) {
                        e.preventDefault();
                        return;
                      }
                      transferAtamaRef.current = { atamaId: a.id, fromSlotId: sv.slot.id, fromGunTarihi: gunTarihi };
                      draggedRef.current = pChip;
                      setDragSlotPreview(null);
                      setDraggedPersonel(pChip);
                    }}
                    onDragEnd={onDragEnd}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: avatarRenkGradient(a.personel_id),
                      border: '2px solid var(--bg2)',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.22)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 800,
                      color: 'rgba(255,255,255,0.95)',
                      letterSpacing: '-0.03em',
                    }}
                  >
                    {initials}
                  </div>
                  <button
                    type="button"
                    className="slot-av-remove"
                    onClick={(e) => { e.stopPropagation(); atamaIptal(a.id); }}
                    title={`${tamAd} atamasını iptal et`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {eksik ? (
              <div
                style={{
                  marginLeft: 10,
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  border: '2px dashed var(--text3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text3)',
                  fontWeight: 800,
                  fontSize: 15,
                  lineHeight: 1,
                  alignSelf: 'center',
                  zIndex: sv.atamalar.length + 2,
                }}
                title="Eksik kontenjan — personel sürükleyin"
              >
                +
              </div>
            ) : null}
          </div>
        )}
        {/* HÜCRE SAAT LİSTESİ — kim hangi saatte (slot dışı uzayanları da göster) */}
        {sv.atamalar.length > 0 && (
          <div style={{ marginTop: 6, paddingTop: 4, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {sv.atamalar.map((a) => {
              const slotBas = sv.slot.baslangic_saat ? fmtSaat(sv.slot.baslangic_saat) : '';
              const slotBit = sv.slot.bitis_saat ? fmtSaat(sv.slot.bitis_saat) : '';
              const aBas = fmtSaat(a.baslangic_saat);
              const aBit = fmtSaat(a.bitis_saat);
              const cercevede = atamaSlotCercevesindeMi(a, sv.slot);
              const tamSlot = aBas === slotBas && aBit === slotBit;
              const renk = cercevede ? 'var(--text2)' : '#a855f7';
              const tip = cercevede ? '' : ' ↔';
              const adKisa = (a.personel_ad || '?').split(' ')[0];
              return (
                <div
                  key={`saat-${a.id}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 10,
                    color: renk,
                    fontWeight: cercevede ? 500 : 700,
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                  title={`${a.personel_ad || ''} ${a.personel_soyad || ''} · ${aBas}–${aBit}${cercevede ? (tamSlot ? '' : ' (kısmi mesai, çerçeve içinde)') : ' (çerçeve dışı — ek mesai veya özel dilim; kayıtta esas bu saatler)'}`}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 70 }}>
                    {adKisa}
                  </span>
                  <span>{aBas}–{aBit}{tip}</span>
                </div>
              );
            })}
          </div>
        )}
        {sv.atamalar.length > 0 ? (() => {
          const ads = [...new Set(sv.atamalar.map((at) => at.yemek_sube_ad).filter(Boolean))];
          if (!ads.length) return null;
          return (
            <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 4, lineHeight: 1.35 }}>
              🍽 Mola şubesi: {ads.join(' · ')}
            </div>
          );
        })() : null}
      </div>
    );
  }

  // ── RENDER ──
  return (
    <div className="page" style={{ paddingBottom: altPanelAcik ? 240 : 64 }}>
      {/* ── FULL LAYOUT: tek üst kart (HEADER) + ana gövde + alt panel ── */}
      <div className="card mb-14" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, letterSpacing: 0.02 }}>🗓 Vardiya Planlama</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text3)' }}>Personel · şube · saat · tek ekran</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIzinModal(true)}>🌴 İzinler</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRaporAcik((v) => !v)}>📊 Raporlar</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLogPanel(true)}>📜 Override Log</button>
          </div>
        </div>
        {izinHaftaOzet && (izinHaftaOzet.izin_gormeyen_sayisi || 0) > 0 && (
          <div
            role="status"
            style={{
              padding: '10px 16px',
              background: 'rgba(245, 158, 11, 0.14)',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--text2)',
              lineHeight: 1.45,
            }}
          >
            <strong style={{ color: '#b45309' }}>İzin hatırlatması</strong>
            {' '}(hafta {izinHaftaOzet.hafta_pazartesi} – {izinHaftaOzet.hafta_pazar}): bu hafta için henüz
            {' '}<strong>hiç izin kaydı olmayan</strong> aktif personel{' '}
            <strong>{izinHaftaOzet.izin_gormeyen_sayisi}</strong> kişi — yasal izin planlaması için «İzinler»den
            (yıllık / mazeret / rapor vb.) kayıt ekleyin.
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)', maxHeight: 44, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(izinHaftaOzet.izin_gormeyen_personel || []).slice(0, 18).map((x) => x.ad_soyad).join(' · ')}
              {(izinHaftaOzet.izin_gormeyen_sayisi || 0) > 18 ? ` … +${(izinHaftaOzet.izin_gormeyen_sayisi || 0) - 18}` : ''}
            </div>
          </div>
        )}

        <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.14, color: 'var(--text3)', marginBottom: 8 }}>HEADER · HAFTA & GÜNLER</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Hafta seç</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <button type="button" className="btn btn-sm btn-secondary" title="Önceki hafta" onClick={() => tarihKaydir(-7)}>⟨⟨</button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => tarihKaydir(-1)}>◀</button>
              <input type="date" value={tarih} onChange={(e) => setTarih(e.target.value)} className="input input-sm" style={{ minWidth: 148 }} />
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => tarihKaydir(1)}>▶</button>
              <button type="button" className="btn btn-sm btn-secondary" title="Sonraki hafta" onClick={() => tarihKaydir(7)}>⟩⟩</button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setTarih(isoToday())}>Bugün</button>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>{haftaAralikMetin}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}>
            {haftaGunleri.map((g) => (
              <button
                key={g.iso}
                type="button"
                className={g.secili ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
                onClick={() => setTarih(g.iso)}
              >
                {g.kisa}
              </button>
            ))}
            <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6, fontWeight: 600 }}>{tarihGoster}</span>
            <label
              title="Manuel gün kilidi. Slotlar dolsun diye gün otomatik kilitlenmez (şube hedefi / kısmi vardiya için)."
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                cursor: gunPlani ? 'pointer' : 'default',
                marginLeft: 'auto',
                color: gunPlani?.gun_kilitli ? '#ef4444' : 'var(--text2)',
                flexWrap: 'wrap',
              }}
            >
              <input
                type="checkbox"
                checked={!!gunPlani?.gun_kilitli}
                disabled={!gunPlani}
                onChange={() => toggleGunKilit()}
              />
              Gün kilidi
            </label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.12, color: 'var(--text3)' }}>ISO hafta</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', fontFamily: 'var(--font-mono, monospace)' }} title="ISO-8601 hafta">
              {isoHaftaEtiket.year}-W{String(isoHaftaEtiket.week).padStart(2, '0')}
            </span>
            <button type="button" className="btn btn-sm btn-secondary" title="Önceki ISO haftası (aynı hafta içi gün)" onClick={() => setTarih(isoHaftaKaydir(tarih, -1))}>−1 ISO</button>
            <button type="button" className="btn btn-sm btn-secondary" title="Sonraki ISO haftası" onClick={() => setTarih(isoHaftaKaydir(tarih, 1))}>+1 ISO</button>
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              Yıl
              <input
                type="number"
                className="input input-sm"
                style={{ width: 76 }}
                value={isoJump.y}
                onChange={(e) => setIsoJump((s) => ({ ...s, y: parseInt(e.target.value, 10) || s.y }))}
              />
            </label>
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              Hafta
              <input
                type="number"
                className="input input-sm"
                style={{ width: 56 }}
                min={1}
                max={53}
                value={isoJump.w}
                onChange={(e) => setIsoJump((s) => ({ ...s, w: Math.min(53, Math.max(1, parseInt(e.target.value, 10) || 1)) }))}
              />
            </label>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              title="Seçilen ISO haftasının Pazartesi gününe git"
              onClick={() => setTarih(isoHaftaPazartesi(isoJump.y, isoJump.w))}
            >
              ISO haftasına git
            </button>
          </div>
        </div>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'rgba(79,142,247,0.07)' }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.14, color: 'var(--text3)', marginBottom: 8 }}>AMAÇLI İŞLEMLER</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-sm btn-secondary" title="TAM/PART vb. sistem genel preset — ekle / düzenle / pasifleştir" onClick={() => setSistemPresetModal(true)}>🗂 Sistem presetleri</button>
            <button type="button" className="btn btn-sm btn-secondary" disabled={otomatikBusy || motorBusy || yukleniyor} title="Eksik slotlara akıllı atama: şablon + boş dilimde kaydırma, ardından sunucu önerisi" onClick={() => otomatikDoldur()}>🤖 Otomatik doldur (gün)</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={motorBusy || otomatikBusy || yukleniyor} title="Haftalık motor: bu ISO haftasında (Pzt–Paz) tüm şubelerde eksikleri sırayla kapatır; gerekirse taşır" onClick={() => haftaMotoruCalistir()}>🧠 Haftalık motor</button>
            <button type="button" className="btn btn-sm btn-secondary" title="Bu günün tüm atamalarını iptal et (şube filtresi varsa yalnız o şube)" onClick={() => gunTemizle()}>🧹 Tümünü temizle</button>
            <button type="button" className="btn btn-sm btn-primary" title="Sunucudan planı yeniden çek (sürükle-bırak atamaları zaten anında kaydedilir)" onClick={() => yukleGun()}>↻ Yenile</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 }}>
            Atamalar slota bırakılınca <strong>anında</strong> sunucuya yazılır; <strong>Yenile</strong> yalnızca ekranı günceller.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <button type="button" className="btn btn-sm btn-secondary" title="Bu günü başka güne kopyala" onClick={() => gunKopyala()}>📋 Gün kopyala</button>
            <button type="button" className="btn btn-sm btn-secondary" title="Tüm şubelerde slot üret" onClick={() => slotUretTumSubeler()}>⚙ Tüm şubelerde slot</button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              title="Yeni slot"
              onClick={() => {
                const s0 = filtrelenmisSubeler[0] || gunPlani?.subeler?.[0];
                if (!s0) {
                  setHata('Şube yok — önce şube tanımlayın.');
                  return;
                }
                const d = slotVarsayilanSaatleri(subeler, s0.sube_id);
                setSlotModal({
                  sube_id: s0.sube_id,
                  slot: null,
                  defaultBaslangicSaat: d.baslangic_saat,
                  defaultBitisSaat: d.bitis_saat,
                });
              }}
            >＋ Slot ekle
            </button>
          </div>
        </div>

        <div style={{ padding: '10px 16px 12px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', background: 'var(--bg)' }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.12, color: 'var(--text3)', width: '100%' }}>FİLTRELER</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>Şube</span>
            <select className="input input-sm" value={subeFilter} onChange={(e) => setSubeFilter(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">Tümü</option>
              {subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flex: 1, minWidth: 200 }}>
            <span style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>Personel</span>
            <input type="search" className="input input-sm" placeholder="Ad / soyad…" value={personelMetinFiltre} onChange={(e) => setPersonelMetinFiltre(e.target.value)} style={{ flex: 1, maxWidth: 320 }} />
          </label>
        </div>
      </div>

      {hata && <div className="alert-box red mb-16">{hata}</div>}
      {gunPlani?.gun_kilitli && (
        <div className="alert-box mb-16" style={{ borderColor: '#ef4444', background: 'rgba(239,68,68,0.08)' }}>
          Bu tarih <strong>plana kilitli</strong>. Yeni atamalar yalnızca uyarıları onaylayarak (override) yapılabilir.
        </div>
      )}
      {draggedPersonel && (
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 12, padding: '8px 12px', background: 'var(--bg2)', borderRadius: 6 }}>
          <div>
            <strong>{draggedPersonel.ad} {draggedPersonel.soyad}</strong>
            {(() => {
              const gr = gunAtamaSubeleriGrup(draggedPersonel.gun_durumu?.atamalar, subeler);
              if (!gr.length) return null;
              return (
                <span style={{ color: 'var(--text3)', fontWeight: 500 }}>
                  {' '}· havuz günü şubeler: {gr.map((x) => x.sube_ad).join(', ')}
                </span>
              );
            })()}
          </div>
          <div style={{ marginTop: 6, fontSize: 11 }}>
            Sürükleme: önce <strong>yerel</strong> çakışma (anı), ardından <strong>atama/check</strong> ({PREVIEW_DEBOUNCE_MS}ms gecikmeli) kesin renk.
            {' '}<strong style={{ color: '#22c55e' }}>Yeşil</strong> = uygun ·{' '}
            <strong style={{ color: '#facc15' }}>Sarı</strong> = uyarı / onay ·{' '}
            <strong style={{ color: '#ef4444' }}>Kırmızı</strong> = atanamaz.
          </div>
        </div>
      )}

      {raporAcik && (
        <div className="card mb-16" style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <strong>📊 Raporlar</strong>
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>personel_gun_state · override log</span>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
            <label style={{ fontSize: 13 }}>Başlangıç{' '}
              <input type="date" className="input input-sm" value={raporBas} onChange={(e) => setRaporBas(e.target.value)} />
            </label>
            <label style={{ fontSize: 13 }}>Bitiş{' '}
              <input type="date" className="input input-sm" value={raporBit} onChange={(e) => setRaporBit(e.target.value)} />
            </label>
          </div>
          {raporYukleniyor ? <p style={{ color: 'var(--text3)' }}>Yükleniyor…</p> : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>Günlük limit üstü (fazla saat)</div>
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
                  {(raporFazla?.gunluk_limit_ustu || []).length === 0 ? (
                    <div style={{ padding: 10, color: 'var(--text3)' }}>Kayıt yok</div>
                  ) : (
                    <table className="table-compact" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: 'var(--bg2)' }}><th style={{ padding: 4 }}>Tarih</th><th>Personel</th><th>Toplam</th><th>+Fazla</th></tr></thead>
                      <tbody>
                        {(raporFazla.gunluk_limit_ustu || []).map((r, i) => (
                          <tr key={i}><td style={{ padding: 4 }}>{r.tarih}</td><td>{r.personel_ad} {r.personel_soyad}</td><td>{r.toplam_saat}h</td><td>{r.fazla_gunluk_saat}h</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div style={{ fontWeight: 700, margin: '14px 0 6px', fontSize: 13 }}>Override: saat aşımı</div>
                <div style={{ maxHeight: 160, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}>
                  {(raporFazla?.override_saat_asimi || []).length === 0 ? (
                    <div style={{ padding: 8, color: 'var(--text3)' }}>Kayıt yok</div>
                  ) : (
                    <table className="table-compact" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: 'var(--bg2)' }}><th style={{ padding: 4 }}>Zaman</th><th>Personel</th><th>Tarih</th></tr></thead>
                      <tbody>
                        {(raporFazla.override_saat_asimi || []).map((r, i) => (
                          <tr key={i}><td style={{ padding: 4 }}>{(r.ts || '').slice(0, 16)}</td><td>{r.personel_ad} {r.personel_soyad}</td><td>{r.tarih}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>İzinliyken atandı (override)</div>
                <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
                  {(raporIzinli?.kayitlar || []).length === 0 ? (
                    <div style={{ padding: 10, color: 'var(--text3)' }}>Kayıt yok</div>
                  ) : (
                    <table className="table-compact" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr style={{ background: 'var(--bg2)' }}><th style={{ padding: 4 }}>Zaman</th><th>Personel</th><th>Tarih</th></tr></thead>
                      <tbody>
                        {(raporIzinli.kayitlar || []).map((r, i) => (
                          <tr key={i}><td style={{ padding: 4 }}>{(r.ts || '').slice(0, 16)}</td><td>{r.personel_ad} {r.personel_soyad}</td><td>{r.tarih}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Ana gövde: iki kolon başlığı + sol personel | saat × şube matris */}
      <>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 300px) 1fr', gap: 14, marginBottom: 6 }}>
          <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.08em', color: 'var(--text3)', textTransform: 'uppercase' }}>Personel paneli</div>
          <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: '0.08em', color: 'var(--text3)', textTransform: 'uppercase' }}>Vardiya gridi</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 300px) 1fr', gap: 14, alignItems: 'start' }}>
        {/* SOL: Personel paneli — sürükleme buradan */}
        <div className="card" style={{ padding: 12, position: 'sticky', top: 10, maxHeight: '85vh', overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 14 }}>👥 Personel</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 8, lineHeight: 1.45 }}>
            <strong>Havuz günü:</strong>{' '}
            {havuzKaynakTarih === tarih ? (
              <span style={{ color: 'var(--text3)' }}>plan ile aynı ({tarih})</span>
            ) : (
              <span>
                {havuzKaynakTarih}{' '}
                <span style={{ color: 'var(--text3)' }}>
                  ({TR_GUNLER[(new Date(`${havuzKaynakTarih}T12:00:00`).getDay() + 6) % 7]})
                </span>
              </span>
            )}
            {havuzKaynakTarih !== tarih && (
              <button type="button" className="btn btn-sm btn-secondary" style={{ marginLeft: 8 }} onClick={() => setHavuzTarihOverride(null)}>
                Plan güne eşitle
              </button>
            )}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.45 }}>
            Şube×hafta: sütun başlığındaki <strong>Havuz</strong> ile listeyi o güne çekin. Sürükleme hedefi her hücrenin tarihidir.
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.45 }}>
            Kart şeridi:{' '}
            <span style={{ color: '#22c55e', fontWeight: 700 }}>●</span> uygun{' '}
            <span style={{ color: '#facc15', fontWeight: 700 }}>●</span> uyarı{' '}
            <span style={{ color: '#a855f7', fontWeight: 700 }}>●</span> override{' '}
            <span style={{ color: '#9ca3af', fontWeight: 700 }}>●</span> günlük limit (hesap) dolu — yine de sürükleme açık, saat modalında kısmi seçim mümkün{' '}
            <span style={{ color: '#ef4444', fontWeight: 700 }}>●</span> izin / limit aşımı · İzinli: sürükleme kapalı (izin: tıkla / 🌴)
          </div>
          {havuzKaynakTarih !== tarih && havuzYukleniyor && !havuzGunPlani ? (
            <div style={{ color: 'var(--text3)' }}>Havuz günü yükleniyor…</div>
          ) : !havuzPersonelKaynagi ? (
            <div style={{ color: 'var(--text3)' }}>Yükleniyor…</div>
          ) : filtrelenmisHavuz.length === 0 ? (
              <div style={{ color: 'var(--text3)', fontSize: 12 }}>Filtreyle eşleşen personel yok.</div>
            ) : (
            filtrelenmisHavuz.map((p) => {
              const d = p.gun_durumu || {};
              const izinli = d.durum === 'IZINLI';
              const calisiyor = d.durum === 'CALISIYOR';
              const planYok = d.durum === 'PLANLANMADI';
              /** Hesaplanan günlük limit (kart uyarısı); sürükleme buna bağlı değil */
              const hesapGunlukDolu = !izinli && calisiyor && (Number(d.kalan_saat) || 0) <= 0;
              const suruklenebilir = havuzdanSuruklenebilirMi(p);
              const g = personelKartGosterge(d, !!havuzPersonelKaynagi?.gun_kilitli);
              const haftaPlan = (d.haftalik_saat_snapshot != null)
                ? Number(d.haftalik_saat_snapshot)
                : Number(p.haftalik_saat) || 0;
              const barBg = g.doluGunluk || g.fazla > 0 ? '#ef4444' : (g.yuzde >= 70 ? '#facc15' : '#22c55e');
              const subeAtamalar = calisiyor ? gunAtamaSubeleriGrup(d.atamalar, subeler) : [];
              const tt = !suruklenebilir
                ? (izinli ? 'İzinli — tıkla: izin veya kısıtlar' : 'Tıkla: kısıtlar')
                : hesapGunlukDolu
                  ? 'Günlük süre (hesap) dolu görünüyor — yine de sürükleyip kısmi saat seçebilirsiniz; sistem kontrol eder · Tıkla: kısıtlar'
                  : 'Tıkla: kısıtlar · Sürükle: slota ata';
              return (
                <div
                  key={p.id}
                  draggable={suruklenebilir === true}
                  onDragStart={(e) => onDragStartHavuz(e, p)}
                  onDragEnd={onDragEnd}
                  onClick={() => setKisitModal(p.id)}
                  style={{
                    display: 'flex',
                    marginBottom: 8,
                    borderRadius: 8,
                    overflow: 'hidden',
                    border: g.border,
                    boxShadow: g.seviye === 'kritik' ? '0 0 0 1px rgba(239,68,68,0.2)'
                            : g.seviye === 'kilit' ? '0 0 0 1px rgba(156,163,175,0.25)'
                            : g.seviye === 'override' ? '0 0 0 1px rgba(168,85,247,0.25)'
                            : g.seviye === 'uyari' ? '0 0 0 1px rgba(250,204,21,0.25)' : 'none',
                    cursor: suruklenebilir ? 'grab' : (izinli ? 'default' : 'not-allowed'),
                    opacity: suruklenebilir ? (hesapGunlukDolu ? 0.92 : 1) : 0.4,
                    background: g.bg && g.bg !== 'transparent' ? g.bg
                              : (izinli ? 'rgba(239,68,68,0.11)'
                                : calisiyor ? 'rgba(34,197,94,0.08)' : planYok ? 'rgba(245,158,11,0.06)' : 'var(--bg3)'),
                    transition: 'transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease',
                    transform: 'scale(1)',
                    userSelect: suruklenebilir ? undefined : 'none',
                    WebkitUserDrag: suruklenebilir ? undefined : 'none',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.zIndex = '5'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.zIndex = ''; }}
                  title={tt}
                >
                  <div style={{ width: 5, flexShrink: 0, background: g.accent }} aria-hidden />
                  <div style={{ flex: 1, padding: '8px 10px 8px 8px', minWidth: 0 }}>
                    {subeAtamalar.length > 0 && (
                      <div
                        style={{
                          marginBottom: 8,
                          paddingBottom: 8,
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.04, color: 'var(--text3)', marginBottom: 6 }}>
                          Bu gün atanmış şube{subeAtamalar.length > 1 ? 'ler' : ''} ({fmtTarihKisa(havuzKaynakTarih)})
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          {subeAtamalar.map((row) => (
                            <div
                              key={row.sube_id}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                background: 'rgba(79,142,247,0.1)',
                                border: '1px solid rgba(79,142,247,0.28)',
                                borderRadius: 6,
                                padding: '3px 4px 3px 8px',
                                maxWidth: '100%',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: '#334155',
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                                title={row.sube_ad}
                              >
                                🏢 {row.sube_ad}
                              </span>
                              <button
                                type="button"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  personelSubeGunAtamalariniKaldir(p, row.sube_id);
                                }}
                                style={{
                                  flexShrink: 0,
                                  width: 22,
                                  height: 22,
                                  borderRadius: 6,
                                  border: '1px solid rgba(239,68,68,0.55)',
                                  background: 'rgba(239,68,68,0.08)',
                                  color: '#b91c1c',
                                  fontSize: 16,
                                  fontWeight: 800,
                                  lineHeight: 1,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  padding: 0,
                                }}
                                title={`${row.sube_ad}: bu gün bu şubedeki tüm atamaları kaldır`}
                                aria-label={`${row.sube_ad} atamalarını kaldır`}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.25 }}>
                        {p.ad} {p.soyad}
                      </span>
                      <span style={{
                        fontSize: 9, fontWeight: 800, letterSpacing: 0.3, padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                        background: izinli ? 'rgba(239,68,68,0.12)' : calisiyor ? 'rgba(34,197,94,0.15)' : planYok ? '#ffedd5' : '#f1f5f9',
                        color: izinli ? '#b91c1c' : calisiyor ? '#15803d' : planYok ? '#c2410c' : '#475569',
                      }}>
                        {izinli ? 'İZİNLİ' : calisiyor ? 'ÇALIŞIYOR' : planYok ? 'PLAN YOK' : 'BOS'}
                      </span>
                    </div>
                    {g.izinOzeti && (
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, lineHeight: 1.35 }}>{g.izinOzeti}</div>
                    )}
                    {g.kalanMetin && (
                      <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, color: g.doluGunluk || g.fazla > 0 ? '#dc2626' : '#0f172a' }}>
                        {g.kalanMetin}
                      </div>
                    )}
                    {!izinli && (
                      <div style={{ height: 4, background: 'var(--border)', borderRadius: 3, marginTop: 6, overflow: 'hidden' }}>
                        <div style={{ width: `${g.yuzde}%`, height: '100%', background: barBg, transition: 'width 0.2s' }} />
                      </div>
                    )}
                    {g.rozetler.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                        {g.rozetler.map((rz, ri) => (
                          <span
                            key={`${rz.k}-${ri}`}
                            style={{
                              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                              background: `${rz.renk}22`, color: rz.renk, border: `1px solid ${rz.renk}44`,
                            }}
                          >
                            {rz.t}
                          </span>
                        ))}
                      </div>
                    )}
                    {p.yemek_sube_ad && (
                      <div style={{ fontSize: 10, color: '#64748b', marginTop: 4, lineHeight: 1.35 }}>
                        🍽 Mola: <strong style={{ color: '#475569' }}>{p.yemek_sube_ad}</strong>
                      </div>
                    )}
                    {!izinli && !calisiyor && (
                      <label
                        style={{ fontSize: 10, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text2)' }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={!!d.kasitli_bos}
                          onChange={(e) => kasitliBosDegistir(p.id, e.target.checked)}
                        />
                        Bilinçli boş (izin değil)
                      </label>
                    )}
                    {!izinli && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); izinliYapHizli(p); }}
                        style={{
                          marginTop: 6, fontSize: 10, padding: '3px 8px',
                          background: 'transparent', border: '1px solid #ef4444',
                          color: '#ef4444', borderRadius: 4, cursor: 'pointer',
                        }}
                        title={`Bu güne (${tarih}) bir günlük izin ekle`}
                      >🌴 İzinli yap (bugün)</button>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <span>Hafta (planlı): <strong style={{ color: 'var(--text2)' }}>{haftaPlan.toFixed(1)}h</strong></span>
                      {p.calisma_turu && <span>{p.calisma_turu}</span>}
                    </div>
                  </div>
                </div>
              );
            })
            )}
        </div>

        {/* SAĞ: Gün×şube matrisi veya şube×7 gün */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>
              {gorunumModu === 'gun_matris' ? (
                <>
                  {TR_GUNLER[(new Date(`${tarih}T12:00:00`).getDay() + 6) % 7]} · <span style={{ color: 'var(--text2)' }}>{tarih}</span>
                  <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>Saat ↓ · Şube →</span>
                </>
              ) : gorunumModu === 'sube_hafta' ? (
                <>
                  Şube × hafta
                  <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>
                    Pazartesi–Pazar · saat ↓ · gün →
                  </span>
                </>
              ) : gorunumModu === 'gun_gantt' ? (
                <>
                  Gantt · {TR_GUNLER[(new Date(`${tarih}T12:00:00`).getDay() + 6) % 7]} · <span style={{ color: 'var(--text2)' }}>{tarih}</span>
                  <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>Saat ekseni · şube grupları · personel çubukları</span>
                </>
              ) : (
                <>
                  Personel × hafta
                  <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>
                    Hafta <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{personelHafta?.pazartesi || pazartesiSecili}</span>
                    {' '}· şube · görev · ad · 7 gün · kapanış · notlar
                  </span>
                </>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
              <button type="button" className={gorunumModu === 'gun_matris' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'} onClick={() => setGorunumModu('gun_matris')}>Gün × şube</button>
              <button type="button" className={gorunumModu === 'sube_hafta' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'} onClick={() => setGorunumModu('sube_hafta')}>Şube × hafta</button>
              <button type="button" className={gorunumModu === 'personel_hafta' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'} onClick={() => setGorunumModu('personel_hafta')}>Personel × hafta</button>
              <button type="button" className={gorunumModu === 'gun_gantt' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'} onClick={() => setGorunumModu('gun_gantt')} title="Saat ekseni — kim ne zaman çalışacak görsel">📊 Gantt (saat çubuğu)</button>
              {gorunumModu === 'sube_hafta' && (
                <select className="input input-sm" value={subeHaftaId} onChange={(e) => setSubeHaftaId(e.target.value)} style={{ minWidth: 170 }}>
                  {(gunPlani?.subeler?.length ? gunPlani.subeler : (subeler || []).map((x) => ({ sube_id: x.id, sube_ad: x.ad }))).map((s) => (
                    <option key={s.sube_id} value={s.sube_id}>{s.sube_ad}</option>
                  ))}
                </select>
              )}
              {gorunumModu === 'personel_hafta' && personelHafta && (
                <>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => personelHaftaExcel()}>⬇ Excel</button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => personelHaftaPdf()}>⬇ PDF</button>
                </>
              )}
            </div>
            {gorunumModu === 'gun_matris' && (
              <div style={{ fontSize: 11, color: 'var(--text3)', width: '100%' }}>
                Şube sütununda <strong>hedef kişi</strong> girin; sistem o gün o şubede <strong>benzersiz atanmış</strong> kişi sayısına göre <strong>altında / tam / üstünde</strong> der (saat/rol atama modalında).
                {' '}Çerçeve: gri boş · yeşil min tam · turuncu min eksik · sarı ideal eksik · açılış/kapanışta ek mavi halka · sürüklerken yeşil/sarı/kırmızı vurgu · atananlar üst üste avatar
              </div>
            )}
            {gorunumModu === 'personel_hafta' && (
              <div style={{ fontSize: 11, color: 'var(--text3)', width: '100%' }}>
                Üstteki hafta pill’leri veya tarih ile haftayı değiştirin. Hücre: saat aralığı + şube adı; izin günü <strong>İZİNLİ</strong>.
              </div>
            )}
          </div>
          {gorunumModu === 'gun_gantt' ? (
            <GanttGorunumu
              gunPlani={gunPlani}
              filtrelenmisSubeler={filtrelenmisSubeler}
              tarih={tarih}
              havuzById={havuzById}
            />
          ) : gorunumModu === 'gun_matris' ? (
            !gunPlani ? (
              <div className="empty" style={{ padding: 24 }}><p>Yükleniyor…</p></div>
            ) : (gunPlani.subeler || []).length === 0 ? (
              <div className="empty" style={{ padding: 24 }}><p>Şube yok</p></div>
            ) : filtrelenmisSubeler.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}><p>Şube filtresi eşleşmedi — üstten &quot;Tümü&quot; seçin.</p></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                {(() => {
                  const n = filtrelenmisSubeler.length;
                  const tpl = `88px repeat(${n}, minmax(160px, 1fr))`;
                  return (
                    <div style={{ minWidth: 88 + n * 160 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: tpl, gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                        <div style={{ padding: '10px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>Saat</div>
                        {filtrelenmisSubeler.map((s) => {
                          const hedef = s.ihtiyac_hedef_kisi;
                          const atanan = Number.isFinite(Number(s.atanan_benzersiz_kisi))
                            ? Number(s.atanan_benzersiz_kisi)
                            : 0;
                          const dur = s.ihtiyac_durumu;
                          let durumParca = '';
                          let durumRenk = 'var(--text3)';
                          if (hedef != null) {
                            if (dur === 'altinda') {
                              durumParca = '→ altında';
                              durumRenk = '#c2410c';
                            } else if (dur === 'ustunde') {
                              durumParca = '→ üstünde';
                              durumRenk = '#1d4ed8';
                            } else {
                              durumParca = '→ tam';
                              durumRenk = '#15803d';
                            }
                          }
                          const hid = `vardiya-hedef-${s.sube_id}`;
                          return (
                          <div key={s.sube_id} style={{ padding: '8px 6px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>🏪 {s.sube_ad}</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
                              <button type="button" className="btn btn-sm btn-secondary" title="Şube saatlerinden slot" onClick={() => slotUretFromSube(s.sube_id, s.sube_ad)}>⚙</button>
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                title="Slot tanımla"
                                onClick={() => {
                                  const d = slotVarsayilanSaatleri(subeler, s.sube_id);
                                  setSlotModal({
                                    sube_id: s.sube_id,
                                    slot: null,
                                    defaultBaslangicSaat: d.baslangic_saat,
                                    defaultBitisSaat: d.bitis_saat,
                                  });
                                }}
                              >＋</button>
                            </div>
                            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center', alignItems: 'center', fontSize: 10 }}>
                                <label htmlFor={hid} style={{ color: 'var(--text3)', fontWeight: 700 }}>Hedef kişi</label>
                                <input
                                  id={hid}
                                  type="number"
                                  min={0}
                                  className="input input-sm"
                                  style={{ width: 52 }}
                                  placeholder="—"
                                  defaultValue={hedef != null ? String(hedef) : ''}
                                  key={`${s.sube_id}-${tarih}-${hedef ?? 'x'}`}
                                />
                                <button
                                  type="button"
                                  className="btn btn-sm btn-secondary"
                                  title="Hedefi kaydet"
                                  onClick={() => {
                                    const el = document.getElementById(hid);
                                    subeGunHedefKaydet(s.sube_id, el?.value);
                                  }}
                                >Kaydet</button>
                                <button
                                  type="button"
                                  className="btn btn-sm btn-secondary"
                                  title="Hedefi kaldır"
                                  onClick={() => subeGunHedefKaydet(s.sube_id, null)}
                                >Temizle</button>
                              </div>
                              <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: durumRenk, lineHeight: 1.35 }}>
                                İhtiyaç: {hedef != null ? hedef : '—'} · Atanan: {atanan}
                                {hedef != null ? ` ${durumParca}` : ''}
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                      {saatBantlariGunMatris.map((band) => (
                        <div
                          key={band.key}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: tpl,
                            alignItems: 'start',
                            borderBottom: '1px solid var(--border)',
                            background: 'var(--bg)',
                          }}
                        >
                          <div
                            style={{
                              padding: '10px 8px',
                              fontSize: 11,
                              fontWeight: 700,
                              color: 'var(--text2)',
                              position: 'sticky',
                              left: 0,
                              background: 'var(--bg)',
                              zIndex: 1,
                              borderRight: '1px solid var(--border)',
                            }}
                          >
                            {band.label}
                          </div>
                          {filtrelenmisSubeler.map((s) => {
                            const hucre = slotMatris.get(`${s.sube_id}|${band.key}`) || [];
                            return (
                              <div
                                key={`${s.sube_id}-${band.key}`}
                                style={{
                                  borderLeft: '1px solid var(--border)',
                                  padding: 8,
                                  minHeight: 64,
                                }}
                              >
                                {hucre.length === 0 ? (
                                  <div style={{ fontSize: 11, color: 'var(--text3)', padding: '12px 0', textAlign: 'center' }}>—</div>
                                ) : (
                                  hucre.map(({ sv, s: subeRow, bandKey }) => matrisSlotHucre(sv, subeRow, tarih, bandKey))
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )
          ) : gorunumModu === 'sube_hafta' ? (
            <div style={{ padding: 12 }}>
              {haftaYukleniyor || !haftaPlanCache ? (
                <div className="empty"><p>Haftalık plan yükleniyor…</p></div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  {(() => {
                    const tplH = `76px repeat(7, minmax(132px, 1fr))`;
                    return (
                      <div style={{ minWidth: 76 + 7 * 132 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: tplH, gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                          <div style={{ padding: '8px 6px', fontSize: 11, fontWeight: 700, color: 'var(--text3)' }}>Saat</div>
                          {haftaGunleri.map((g) => (
                            <div key={g.iso} style={{ padding: '8px 4px', textAlign: 'center', borderLeft: '1px solid var(--border)' }}>
                              <button
                                type="button"
                                className={g.secili ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-secondary'}
                                style={{ width: '100%' }}
                                onClick={() => setTarih(g.iso)}
                              >
                                {g.kisa}
                              </button>
                              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{g.iso.slice(5)}</div>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                style={{ width: '100%', marginTop: 4, fontSize: 10, padding: '2px 4px' }}
                                title="Sol personel listesini bu güne göre yenile (matris aynı kalır)"
                                onClick={() => setHavuzTarihOverride(g.iso)}
                              >
                                Havuz
                              </button>
                            </div>
                          ))}
                        </div>
                        {saatBantlariHaftaMatris.map((band) => (
                          <div
                            key={`w-${band.key}`}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: tplH,
                              alignItems: 'start',
                              borderBottom: '1px solid var(--border)',
                              background: 'var(--bg)',
                            }}
                          >
                            <div style={{ padding: '8px 6px', fontSize: 11, fontWeight: 700, color: 'var(--text2)', borderRight: '1px solid var(--border)' }}>{band.label}</div>
                            {haftaGunleri.map((g) => {
                              const planGun = haftaPlanCache[g.iso];
                              const sub = planGun?.subeler?.[0];
                              const hucre = sub
                                ? (slotMatrisHaritasiOlustur(planGun, [sub], saatBantlariHaftaMatris).get(`${sub.sube_id}|${band.key}`) || [])
                                : [];
                              return (
                                <div
                                  key={`${g.iso}-${band.key}`}
                                  style={{ borderLeft: '1px solid var(--border)', padding: 6, minHeight: 56 }}
                                >
                                  {!sub ? (
                                    <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>—</div>
                                  ) : hucre.length === 0 ? (
                                    <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center' }}>—</div>
                                  ) : (
                                    hucre.map(({ sv, s: subeRow, bandKey }) => matrisSlotHucre(sv, subeRow, g.iso, bandKey))
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 12, overflowX: 'auto' }}>
              {personelHaftaYukleniyor || !personelHafta?.gunler ? (
                <div className="empty"><p>Haftalık personel tablosu yükleniyor…</p></div>
              ) : (
                <table className="table" style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg2)' }}>
                      <th style={{ padding: 8, textAlign: 'left', whiteSpace: 'nowrap' }}>Şube</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Görev</th>
                      <th style={{ padding: 8, textAlign: 'left' }}>Ad Soyad</th>
                      {personelHafta.gunler.map((iso) => (
                        <th key={iso} style={{ padding: 8, textAlign: 'center', minWidth: 88 }}>
                          <div>{personelHaftaGunBaslik(iso)}</div>
                          <div style={{ fontSize: 9, color: 'var(--text3)', fontWeight: 500 }}>{iso.slice(5)}</div>
                        </th>
                      ))}
                      <th style={{ padding: 8, textAlign: 'center' }}>Kapanış</th>
                      <th style={{ padding: 8, textAlign: 'left', minWidth: 120 }}>Notlar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(personelHafta.satirlar || []).map((row) => (
                      <tr key={row.personel_id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: 8, verticalAlign: 'top' }}>{row.sube_ad}</td>
                        <td style={{ padding: 8, verticalAlign: 'top' }}>{row.gorev}</td>
                        <td style={{ padding: 8, verticalAlign: 'top', fontWeight: 600 }}>
                          {row.ad}{row.soyad ? ` ${row.soyad}` : ''}
                        </td>
                        {personelHafta.gunler.map((iso) => {
                          const c = row.gunler?.[iso];
                          const m = c?.metin || '—';
                          const iz = c?.tip === 'izinli';
                          return (
                            <td
                              key={iso}
                              style={{
                                padding: 8,
                                verticalAlign: 'top',
                                whiteSpace: 'pre-line',
                                textAlign: 'center',
                                fontSize: 10,
                                color: iz ? '#b91c1c' : 'var(--text2)',
                                fontWeight: iz ? 700 : 400,
                                background: iz ? 'rgba(239,68,68,0.07)' : 'transparent',
                              }}
                            >
                              {m}
                            </td>
                          );
                        })}
                        <td style={{ padding: 8, textAlign: 'center', verticalAlign: 'top' }}>{row.kapanis_sayisi}</td>
                        <td style={{ padding: 8, verticalAlign: 'top', fontSize: 10, color: 'var(--text3)', maxWidth: 220 }}>{row.notlar || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
      </>

      {/* Alt panel — kapalıyken ince şerit; tıklanınca açılır (vardiya alanını kaplamasın) */}
      {gunPlani && (
        <div
          style={{
            position: 'sticky',
            bottom: 8,
            zIndex: 12,
            marginTop: 14,
          }}
        >
          {!altPanelAcik ? (
            <button
              type="button"
              className="card"
              onClick={() => setAltPanelAcik(true)}
              style={{
                width: '100%',
                padding: '10px 14px',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                cursor: 'pointer',
                textAlign: 'left',
                border: '1px solid var(--border)',
                boxShadow: '0 -4px 16px rgba(0,0,0,0.12)',
                background: 'var(--bg2)',
                font: 'inherit',
                color: 'var(--text2)',
              }}
            >
              <span style={{ fontWeight: 800, fontSize: 13 }}>
                ▲ Gün özeti · uyarılar <span style={{ fontWeight: 500, color: 'var(--text3)' }}>(genişlet)</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                Eksik slot: <strong style={{ color: eksikSlotSayisi ? '#fb923c' : '#22c55e' }}>{eksikSlotSayisi}</strong>
                {' · '}
                Fazla mesai: <strong style={{ color: fazlaMesaiSayisi ? '#ef4444' : '#22c55e' }}>{fazlaMesaiSayisi}</strong>
                {' · '}
                Uyarı satırı: <strong>{canliUyariListesi.length}</strong>
              </span>
            </button>
          ) : (
            <div
              className="card"
              style={{
                padding: 14,
                border: '1px solid var(--border)',
                boxShadow: '0 -10px 28px rgba(0,0,0,0.18)',
                background: 'var(--bg)',
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>Alt panel — Gün özeti · canlı uyarılar</div>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAltPanelAcik(false)}>
                  ▼ Daralt
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'baseline', marginBottom: 10 }}>
                <span style={{ fontSize: 13 }}>
                  Eksik personelli slot: <strong style={{ color: eksikSlotSayisi ? '#fb923c' : '#22c55e' }}>{eksikSlotSayisi}</strong>
                </span>
                <span style={{ fontSize: 13 }}>
                  Fazla mesai: <strong style={{ color: fazlaMesaiSayisi ? '#ef4444' : '#22c55e' }}>{fazlaMesaiSayisi} kişi</strong>
                </span>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Raporlar üstteki <strong>📊 Raporlar</strong> kartında.
                </span>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, letterSpacing: 0.04 }}>PERSONEL SAAT (X/Y)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', fontSize: 12, marginBottom: 14 }}>
                {altOzetPersonel.map((o) => (
                  <span key={o.id} style={{ color: o.izinli ? 'var(--text3)' : 'var(--text2)' }}>
                    {o.etiket || '—'} → {o.izinli ? 'İZİNLİ' : `${Number(o.toplam).toFixed(1)}/${o.maxGun} saat`}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 6, letterSpacing: 0.04 }}>CANLI UYARI LİSTESİ</div>
              {canliUyariListesi.length === 0 ? (
                <div style={{ fontSize: 13, color: '#22c55e', padding: '10px 12px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, border: '1px solid rgba(34,197,94,0.25)' }}>
                  Bu gün için listede kritik uyarı yok (kilit / eksik slot / limit üstü / plan yok taraması temiz).
                </div>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    padding: '4px 0 0 0',
                    listStyle: 'none',
                    maxHeight: 220,
                    overflowY: 'auto',
                    borderTop: '1px dashed var(--border)',
                  }}
                >
                  {canliUyariListesi.map((u, i) => {
                    const col = u.seviye === 'kritik' ? '#ef4444' : u.seviye === 'uyari' ? '#fb923c' : 'var(--text3)';
                    const bg = u.seviye === 'kritik' ? 'rgba(239,68,68,0.07)' : u.seviye === 'uyari' ? 'rgba(251,146,60,0.08)' : 'rgba(148,163,184,0.08)';
                    return (
                      <li
                        key={i}
                        style={{
                          fontSize: 12,
                          padding: '8px 10px',
                          marginBottom: 6,
                          borderRadius: 6,
                          borderLeft: `4px solid ${col}`,
                          background: bg,
                          color: 'var(--text2)',
                          lineHeight: 1.45,
                        }}
                      >
                        <span style={{ fontWeight: 800, color: col, marginRight: 8 }}>
                          {u.seviye === 'kritik' ? '●' : u.seviye === 'uyari' ? '▲' : '◇'}
                        </span>
                        {u.metin}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* MODAL'lar */}
      {slotModal && (
        <SlotModal
          key={slotModal.slot?.id ? String(slotModal.slot.id) : `new-${slotModal.sube_id}`}
          sube_id={slotModal.sube_id}
          slot={slotModal.slot}
          defaultBaslangicSaat={slotModal.defaultBaslangicSaat}
          defaultBitisSaat={slotModal.defaultBitisSaat}
          onClose={() => setSlotModal(null)}
          onKaydet={() => { setSlotModal(null); yukleGun(); }}
        />
      )}
      {dropSaatModal && (
        <DropAtamaSaatModal
          personel={dropSaatModal.personel}
          slotId={dropSaatModal.slotId}
          gunTarihi={dropSaatModal.gunTarihi}
          planForGun={dropSaatModal.planForGun}
          onClose={() => setDropSaatModal(null)}
          onTamam={async (bas, bit) => {
            const m = dropSaatModal;
            if (!m?.personel) return;
            const b0 = (bas || '').trim();
            const b1 = (bit || '').trim();
            if (!b0 || !b1) {
              setHata('Başlangıç ve bitiş saati birlikte zorunludur (örn. 09:00–14:30); tek saat gönderilemez.');
              return;
            }
            setDropSaatModal(null);
            const body = {
              personel_id: m.personel.id,
              slot_id: m.slotId,
              tarih: m.gunTarihi,
              override: false,
              baslangic_saat: b0,
              bitis_saat: b1,
            };
            await devamAtamaKontrolVeKaydet(body, m.transferAtamaId, m);
          }}
        />
      )}
      {sistemPresetModal && (
        <SistemPresetYonetimModal
          onClose={() => setSistemPresetModal(false)}
          onDegisti={() => { yukleGun(); }}
        />
      )}
      {kisitModal && <KisitModal
        personel_id={kisitModal}
        subeler={subeler}
        onClose={() => setKisitModal(null)}
        onKaydet={() => { setKisitModal(null); yukleGun(); }}
      />}
      {izinModal && <IzinModal
        personeller={(gunPlani?.personel_havuzu) || []}
        onClose={() => { setIzinModal(false); yukleGun(); void yukleIzinHaftaOzet(); }}
      />}
      {uyariOnayModal && (
        <UyariOnayModal
          uyarilar={uyariOnayModal.uyarilar}
          ozetMetni={uyariOnayModal.ozetMetni}
          onHayir={() => uyariOnayIptal()}
          onEvet={() => uyariOnaylaEvet()}
        />
      )}
      {overrideModal && <OverrideModal
        uyarilar={overrideModal.uyarilar}
        ozetMetni={overrideModal.ozetMetni}
        onIptal={() => setOverrideModal(null)}
        onOnayla={(g) => overrideOnayla(g)}
      />}
      {motorSonuc ? (
        <Modal onClose={() => setMotorSonuc(null)} title="Haftalık plan motoru — sonuç" geniş>
          <p style={{ fontSize: 14, fontWeight: 700, marginTop: 0 }}>{motorSonuc.mesaj}</p>
          {(motorSonuc.atama_sayisi != null || motorSonuc.tur_sayisi != null) && (
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
              Atama: <strong>{motorSonuc.atama_sayisi ?? '—'}</strong>
              {' · '}
              Tur: <strong>{motorSonuc.tur_sayisi ?? '—'}</strong>
            </p>
          )}
          <div style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono, monospace)',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.45,
            maxHeight: 420,
            overflowY: 'auto',
            padding: 12,
            background: 'var(--bg3)',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}>
            {(motorSonuc.log || []).length ? (motorSonuc.log || []).join('\n') : 'Günlük satırı yok.'}
          </div>
        </Modal>
      ) : null}
      {logPanel && <LogModal onClose={() => setLogPanel(false)} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SLOT TANIMI MODAL
// ═══════════════════════════════════════════════════════════════════
function SlotModal({
  sube_id,
  slot,
  defaultBaslangicSaat,
  defaultBitisSaat,
  onClose,
  onKaydet,
}) {
  const [form, setForm] = useState(() => (slot ? { ...slot, sube_id } : {
    sube_id,
    ad: '',
    tip: 'normal',
    baslangic_saat: defaultBaslangicSaat || '08:00',
    bitis_saat: defaultBitisSaat || '23:59',
    gece_vardiyasi: false,
    min_personel: 1,
    ideal_personel: 1,
    aktif_gunler: [1, 2, 3, 4, 5, 6, 7],
    aktif: true,
    sira: 0,
  }));
  const [busy, setBusy] = useState(false);

  async function kaydet() {
    setBusy(true);
    try {
      const body = { ...form, sube_id };
      if (slot?.id) {
        await api(`/vardiya/v2/slot/${slot.id}`, { method: 'PUT', body });
      } else {
        await api('/vardiya/v2/slot', { method: 'POST', body });
      }
      onKaydet();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function sil() {
    if (!slot?.id) return;
    if (!confirm('Bu slotu silmek istediğine emin misin? İlgili atamalar da silinir.')) return;
    setBusy(true);
    try {
      await api(`/vardiya/v2/slot/${slot.id}`, { method: 'DELETE' });
      onKaydet();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  function gunToggle(g) {
    const yeni = form.aktif_gunler.includes(g)
      ? form.aktif_gunler.filter(x => x !== g)
      : [...form.aktif_gunler, g].sort();
    setForm({ ...form, aktif_gunler: yeni });
  }

  function sablonUygula(s) {
    setForm((prev) => ({
      ...prev,
      ad: s.etiket,
      baslangic_saat: s.bas,
      bitis_saat: s.bit,
      tip: s.tip,
    }));
  }

  return (
    <Modal onClose={onClose} title={slot?.id ? 'Slot Düzenle' : 'Yeni Slot'}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Slot adı</label>
          <input className="input" value={form.ad} onChange={e => setForm({ ...form, ad: e.target.value })} placeholder="Şablon seçildiğinde otomatik dolar; dilerseniz özelleştirin." />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Tanımlı saat şablonları</label>
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 8px', lineHeight: 1.35 }}>
            Planın omurgası saat aralığıdır; aşağıdan bir dilim seçin veya başlangıç/bitişi elle yazın.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {SAAT_SABLONLARI.map((s) => (
              <button
                key={s.etiket}
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => sablonUygula(s)}
                title={`${s.etiket}: ${s.bas}–${s.bit}`}
              >
                {s.etiket} ({s.bas}–{s.bit})
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label>Başlangıç</label>
          <input className="input" type="time" value={fmtSaat(form.baslangic_saat)} onChange={e => setForm({ ...form, baslangic_saat: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Bitiş</label>
          <input className="input" type="time" value={fmtSaat(form.bitis_saat)} onChange={e => setForm({ ...form, bitis_saat: e.target.value })} />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>
            <input type="checkbox" checked={form.gece_vardiyasi} onChange={e => setForm({ ...form, gece_vardiyasi: e.target.checked })} />
            {' '}Gece vardiyası (bitiş ertesi gün)
          </label>
        </div>
        <details className="form-group" style={{ gridColumn: '1/-1', marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
            Özet tipi — liste rengi ve raporlar (isteğe bağlı)
          </summary>
          <p style={{ fontSize: 11, color: 'var(--text3)', margin: '8px 0 6px', lineHeight: 1.35 }}>
            Şablon seçildiğinde otomatik atanır. Matris vurgusu ve kapanış sayımı için <code>tip</code> alanı kullanılır; özel durumda değiştirin.
          </p>
          <select className="input" style={{ maxWidth: 280 }} value={form.tip} onChange={e => setForm({ ...form, tip: e.target.value })}>
            <option value="normal">{SLOT_TIPI.normal.ikon} {SLOT_TIPI.normal.etiket}</option>
            <option value="acilis">{SLOT_TIPI.acilis.ikon} {SLOT_TIPI.acilis.etiket}</option>
            <option value="yogun">{SLOT_TIPI.yogun.ikon} {SLOT_TIPI.yogun.etiket}</option>
            <option value="kapanis">{SLOT_TIPI.kapanis.ikon} {SLOT_TIPI.kapanis.etiket}</option>
          </select>
        </details>
        <div className="form-group">
          <label>Min Personel</label>
          <input className="input" type="number" min={0} value={form.min_personel} onChange={e => setForm({ ...form, min_personel: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="form-group">
          <label>İdeal Personel</label>
          <input className="input" type="number" min={form.min_personel} value={form.ideal_personel} onChange={e => setForm({ ...form, ideal_personel: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Aktif Günler</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {TR_GUNLER.map((g, i) => {
              const idx = i + 1;
              const aktif = form.aktif_gunler.includes(idx);
              return (
                <button key={idx} type="button"
                  onClick={() => gunToggle(idx)}
                  className={`btn btn-sm ${aktif ? 'btn-primary' : 'btn-secondary'}`}>
                  {g.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
        <div className="form-group">
          <label>Sıra (alttan üste, küçük önce)</label>
          <input className="input" type="number" value={form.sira} onChange={e => setForm({ ...form, sira: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" checked={form.aktif} onChange={e => setForm({ ...form, aktif: e.target.checked })} />
            {' '}Aktif
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
        {slot?.id ? <button className="btn btn-danger" onClick={sil} disabled={busy}>🗑 Sil</button> : <span />}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>İptal</button>
          <button className="btn btn-primary" onClick={kaydet} disabled={busy || !form.ad}>{busy ? '…' : 'Kaydet'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SİSTEM PRESET YÖNETİMİ (`vardiya_preset` — tüm kurulum)
// ═══════════════════════════════════════════════════════════════════
function saatApiToInput(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.slice(0, 5);
  return String(v).slice(0, 8);
}

function SistemPresetYonetimModal({ onClose, onDegisti }) {
  const [liste, setListe] = useState([]);
  const [busy, setBusy] = useState(false);
  /** null = yeni kayıt formu; string = düzenlenen `kod` */
  const [duzenKod, setDuzenKod] = useState(null);
  const [form, setForm] = useState({
    kod: '',
    ad: '',
    bas_saat: '09:00',
    bit_saat: '18:00',
    gece_vardiyasi: false,
    renk: '#3b82f6',
    sira: 10,
    aktif: true,
  });

  const yukle = useCallback(() => api('/vardiya/v2/preset-admin').then((r) => setListe(r.presetler || [])).catch(() => setListe([])), []);

  useEffect(() => { yukle(); }, [yukle]);

  function satirDuzenle(row) {
    setDuzenKod(row.kod);
    setForm({
      kod: row.kod,
      ad: row.ad || '',
      bas_saat: saatApiToInput(row.bas_saat),
      bit_saat: saatApiToInput(row.bit_saat),
      gece_vardiyasi: !!row.gece_vardiyasi,
      renk: row.renk || '#3b82f6',
      sira: Number(row.sira) || 0,
      aktif: row.aktif !== false,
    });
  }

  function yeniSatir() {
    const maxS = liste.length ? Math.max(...liste.map((x) => Number(x.sira) || 0)) : 0;
    setDuzenKod(null);
    setForm({
      kod: '',
      ad: '',
      bas_saat: '09:00',
      bit_saat: '18:00',
      gece_vardiyasi: false,
      renk: '#3b82f6',
      sira: maxS + 1,
      aktif: true,
    });
  }

  async function kaydet() {
    const kod = (form.kod || '').trim().toUpperCase();
    if (!kod) {
      window.alert('Kod zorunlu (benzersiz, örn. TAM, OZEL_1).');
      return;
    }
    if (!(form.ad || '').trim()) {
      window.alert('Ad zorunlu.');
      return;
    }
    setBusy(true);
    try {
      await api('/vardiya/v2/preset', {
        method: 'POST',
        body: {
          kod,
          ad: (form.ad || '').trim(),
          bas_saat: form.bas_saat || '09:00',
          bit_saat: form.bit_saat || '18:00',
          gece_vardiyasi: !!form.gece_vardiyasi,
          renk: (form.renk || '').trim() || null,
          sira: Number(form.sira) || 0,
          aktif: !!form.aktif,
        },
      });
      await yukle();
      onDegisti?.();
      yeniSatir();
    } catch (e) {
      window.alert(e.message || 'Kayıt başarısız');
    } finally {
      setBusy(false);
    }
  }

  async function pasiflestir(kod) {
    if (!window.confirm(`"${kod}" pasifleştirilsin mi? (Personel seçimlerinde listelenmez.)`)) return;
    setBusy(true);
    try {
      await api(`/vardiya/v2/preset/${encodeURIComponent(kod)}`, { method: 'DELETE' });
      await yukle();
      onDegisti?.();
      if (duzenKod === kod) yeniSatir();
    } catch (e) {
      window.alert(e.message || 'İşlem başarısız');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title="🗂 Sistem vardiya presetleri" geniş>
      <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0, lineHeight: 1.45 }}>
        Tüm şubelerde personel kısıtında seçilebilen hazır saat şablonları. Kayıt <strong>kod</strong> ile benzersizdir; aynı kodla gönderince güncellenir.
      </p>
      <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 14 }}>
        <table className="table" style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'var(--bg2)' }}>
              <th style={{ padding: 6 }}>Aktif</th>
              <th style={{ padding: 6 }}>Kod</th>
              <th style={{ padding: 6 }}>Ad</th>
              <th style={{ padding: 6 }}>Saat</th>
              <th style={{ padding: 6 }}>Sıra</th>
              <th style={{ padding: 6 }} />
            </tr>
          </thead>
          <tbody>
            {liste.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 12, color: 'var(--text3)' }}>Preset yok — aşağıdan ekleyin.</td></tr>
            )}
            {liste.map((row) => (
              <tr key={row.kod} style={{ opacity: row.aktif === false ? 0.55 : 1 }}>
                <td style={{ padding: 6 }}>{row.aktif === false ? '—' : '✓'}</td>
                <td style={{ padding: 6, fontFamily: 'monospace' }}>{row.kod}</td>
                <td style={{ padding: 6 }}>{row.ad}</td>
                <td style={{ padding: 6 }}>{fmtSaat(saatApiToInput(row.bas_saat))}–{fmtSaat(saatApiToInput(row.bit_saat))}{row.gece_vardiyasi ? ' · gece' : ''}</td>
                <td style={{ padding: 6 }}>{row.sira}</td>
                <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => satirDuzenle(row)} disabled={busy}>Düzenle</button>
                  {row.aktif !== false && (
                    <button type="button" className="btn btn-sm btn-danger" style={{ marginLeft: 4 }} onClick={() => pasiflestir(row.kod)} disabled={busy}>Pasifleştir</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>{duzenKod ? `Düzenle: ${duzenKod}` : 'Yeni preset'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <div className="form-group">
          <label>Kod</label>
          <input className="input" value={form.kod} disabled={!!duzenKod} onChange={(e) => setForm({ ...form, kod: e.target.value.toUpperCase() })} placeholder="TAM" />
        </div>
        <div className="form-group">
          <label>Ad</label>
          <input className="input" value={form.ad} onChange={(e) => setForm({ ...form, ad: e.target.value })} placeholder="Tam mesai" />
        </div>
        <div className="form-group">
          <label>Sıra</label>
          <input className="input" type="number" value={form.sira} onChange={(e) => setForm({ ...form, sira: parseInt(e.target.value, 10) || 0 })} />
        </div>
        <div className="form-group">
          <label>Başlangıç</label>
          <input className="input" type="time" value={form.bas_saat} onChange={(e) => setForm({ ...form, bas_saat: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Bitiş</label>
          <input className="input" type="time" value={form.bit_saat} onChange={(e) => setForm({ ...form, bit_saat: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Renk (hex)</label>
          <input className="input" value={form.renk} onChange={(e) => setForm({ ...form, renk: e.target.value })} placeholder="#3b82f6" />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>
            <input type="checkbox" checked={form.gece_vardiyasi} onChange={(e) => setForm({ ...form, gece_vardiyasi: e.target.checked })} />
            {' '}Gece vardiyası (bitiş ertesi gün)
          </label>
          {' '}
          <label style={{ marginLeft: 16 }}>
            <input type="checkbox" checked={form.aktif} onChange={(e) => setForm({ ...form, aktif: e.target.checked })} />
            {' '}Aktif (listede görünsün)
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn btn-secondary" onClick={yeniSatir} disabled={busy}>Formu temizle</button>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Kapat</button>
        <button type="button" className="btn btn-primary" onClick={kaydet} disabled={busy}>{busy ? '…' : 'Kaydet (ekle / güncelle)'}</button>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GANTT GÖRÜNÜMÜ — saat ekseni × şube grupları × personel çubukları
// ═══════════════════════════════════════════════════════════════════
function GanttGorunumu({ gunPlani, filtrelenmisSubeler, tarih, havuzById }) {
  // Saat ekseni: 06:00 → 24:00 (eksen tamamı). Slot ve atamalara göre dinamik daraltabiliriz.
  const SAAT_BAS = 6;   // 06:00
  const SAAT_BIT = 24;  // 24:00 (gece slotu varsa +24 olarak hesaplanır)
  const SAAT_GENISLIK = 60; // her saat için piksel
  const SATIR_YUKSEKLIK = 32;

  if (!gunPlani) {
    return <div className="empty" style={{ padding: 24 }}><p>Yükleniyor…</p></div>;
  }
  const subeler = filtrelenmisSubeler && filtrelenmisSubeler.length
    ? filtrelenmisSubeler
    : (gunPlani.subeler || []);
  if (subeler.length === 0) {
    return <div className="empty" style={{ padding: 24 }}><p>Şube yok</p></div>;
  }

  const dkToPix = (hh, mm) => Math.max(0, ((hh - SAAT_BAS) * 60 + mm) * (SAAT_GENISLIK / 60));
  const saatToPix = (saatStr, gece = false) => {
    if (!saatStr) return 0;
    const [h, m] = String(saatStr).split(':').map((x) => parseInt(x, 10));
    let dk = (h || 0) * 60 + (m || 0);
    if (gece && dk < SAAT_BAS * 60) dk += 24 * 60; // gece taşması
    return Math.max(0, ((dk - SAAT_BAS * 60) * (SAAT_GENISLIK / 60)));
  };

  const toplamGenislik = (SAAT_BIT - SAAT_BAS) * SAAT_GENISLIK;

  // Saat etiketleri — saat başlarında işaret çizgisi
  const saatBaslari = [];
  for (let h = SAAT_BAS; h <= SAAT_BIT; h++) {
    saatBaslari.push(h);
  }

  return (
    <div style={{ overflowX: 'auto', padding: 14 }}>
      <div style={{ minWidth: 200 + toplamGenislik, position: 'relative' }}>
        {/* Saat ekseni başlığı */}
        <div style={{ display: 'flex', borderBottom: '2px solid var(--border)', paddingBottom: 6 }}>
          <div style={{ width: 200, fontWeight: 700, fontSize: 12, color: 'var(--text3)' }}>
            ŞUBE / PERSONEL
          </div>
          <div style={{ position: 'relative', width: toplamGenislik, height: 20 }}>
            {saatBaslari.map((h) => (
              <div
                key={`sb-${h}`}
                style={{
                  position: 'absolute',
                  left: dkToPix(h, 0),
                  fontSize: 10,
                  color: 'var(--text3)',
                  fontFamily: 'var(--font-mono, monospace)',
                  transform: 'translateX(-50%)',
                }}
              >
                {String(h).padStart(2, '0')}:00
              </div>
            ))}
          </div>
        </div>

        {/* Her şube bir grup */}
        {subeler.map((s) => {
          const slotlar = (s.slotlar || []);
          // Her slot içindeki tüm atamaları topla
          const tumAtamalar = [];
          slotlar.forEach((sv) => {
            (sv.atamalar || []).forEach((a) => {
              tumAtamalar.push({ ...a, slot: sv.slot });
            });
          });

          if (tumAtamalar.length === 0 && slotlar.length === 0) return null;

          // Personel başına bir satır (aynı kişi birden fazla atama olabilir → satırda yan yana)
          const personelGruplari = {};
          tumAtamalar.forEach((a) => {
            if (!personelGruplari[a.personel_id]) {
              personelGruplari[a.personel_id] = {
                personel_id: a.personel_id,
                personel_ad: a.personel_ad,
                personel_soyad: a.personel_soyad,
                atamalar: [],
              };
            }
            personelGruplari[a.personel_id].atamalar.push(a);
          });
          const personelListe = Object.values(personelGruplari).sort((a, b) =>
            String(a.personel_ad || '').localeCompare(String(b.personel_ad || ''), 'tr')
          );

          return (
            <div key={s.sube_id} style={{ marginBottom: 18, borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
              {/* Şube başlığı */}
              <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0', background: 'var(--bg2)', borderRadius: 4, marginBottom: 4 }}>
                <div style={{ width: 200, fontWeight: 700, fontSize: 13, paddingLeft: 8 }}>
                  🏪 {s.sube_ad}
                </div>
                <div style={{ position: 'relative', width: toplamGenislik, height: 24 }}>
                  {/* Şube genel slot zemini (açık renk) */}
                  {slotlar.map((sv) => {
                    const x = saatToPix(fmtSaat(sv.slot.baslangic_saat));
                    const x2 = saatToPix(fmtSaat(sv.slot.bitis_saat), sv.slot.gece_vardiyasi);
                    const w = Math.max(2, x2 - x);
                    const tipRenkleri = { acilis: '#f59e0b22', kapanis: '#a855f722', yogun: '#ef444422', normal: '#3b82f622' };
                    const renk = tipRenkleri[sv.slot.tip] || '#3b82f622';
                    return (
                      <div
                        key={`zemin-${sv.slot.id}`}
                        style={{
                          position: 'absolute', left: x, top: 2, width: w, height: 18,
                          background: renk, borderRadius: 3,
                          fontSize: 9, color: 'var(--text3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          overflow: 'hidden', whiteSpace: 'nowrap',
                        }}
                        title={`${sv.slot.ad} (${fmtSaat(sv.slot.baslangic_saat)}–${fmtSaat(sv.slot.bitis_saat)})`}
                      >
                        {w > 60 ? sv.slot.ad : ''}
                      </div>
                    );
                  })}
                  {/* Saat çizgileri */}
                  {saatBaslari.map((h) => (
                    <div key={`sl-${h}`} style={{
                      position: 'absolute', left: dkToPix(h, 0), top: 0, bottom: 0,
                      width: 1, background: 'rgba(148,163,184,0.18)',
                    }}/>
                  ))}
                </div>
              </div>

              {/* Personel satırları */}
              {personelListe.length === 0 ? (
                <div style={{ padding: '8px 0 8px 200px', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                  Bu şubede atama yok
                </div>
              ) : (
                personelListe.map((p) => {
                  const pInfo = havuzById?.get(p.personel_id);
                  const tamAd = `${p.personel_ad || ''} ${p.personel_soyad || ''}`.trim() || 'Personel';
                  return (
                    <div key={`${s.sube_id}-${p.personel_id}`} style={{ display: 'flex', alignItems: 'center', height: SATIR_YUKSEKLIK, position: 'relative' }}>
                      <div style={{ width: 200, fontSize: 12, paddingLeft: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tamAd}
                      </div>
                      <div style={{ position: 'relative', width: toplamGenislik, height: SATIR_YUKSEKLIK }}>
                        {/* Saat dikey çizgileri (zemin) */}
                        {saatBaslari.map((h) => (
                          <div key={`pl-${p.personel_id}-${h}`} style={{
                            position: 'absolute', left: dkToPix(h, 0), top: 4, bottom: 4,
                            width: 1, background: 'rgba(148,163,184,0.12)',
                          }}/>
                        ))}
                        {/* Atama çubukları */}
                        {p.atamalar.map((a) => {
                          const x = saatToPix(fmtSaat(a.baslangic_saat));
                          const x2 = saatToPix(fmtSaat(a.bitis_saat), a.gece_vardiyasi);
                          const w = Math.max(8, x2 - x);
                          const tip = a.slot?.tip || 'normal';
                          const tipRenkleri = { acilis: '#f59e0b', kapanis: '#a855f7', yogun: '#ef4444', normal: '#3b82f6' };
                          const renk = tipRenkleri[tip] || '#3b82f6';
                          const cercevede = atamaSlotCercevesindeMi(a, a.slot);
                          return (
                            <div
                              key={a.id}
                              style={{
                                position: 'absolute', left: x, top: 4, width: w, height: SATIR_YUKSEKLIK - 8,
                                background: renk, borderRadius: 4,
                                color: '#fff', fontSize: 10, fontWeight: 700,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                paddingLeft: 6, paddingRight: 6, overflow: 'hidden', whiteSpace: 'nowrap',
                                boxShadow: cercevede
                                  ? '0 2px 4px rgba(0,0,0,0.15)'
                                  : '0 0 0 2px rgba(251,191,36,0.95), 0 2px 4px rgba(0,0,0,0.18)',
                                cursor: 'help',
                              }}
                              title={`${tamAd} · ${fmtSaat(a.baslangic_saat)}–${fmtSaat(a.bitis_saat)} · ${a.slot?.ad || ''}${cercevede ? '' : ' · Şube çerçevesi dışı (ek mesai / özel dilim olabilir)'}`}
                            >
                              {w > 80 ? `${fmtSaat(a.baslangic_saat)}–${fmtSaat(a.bitis_saat)}` : ''}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}

        {/* Açıklama */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)' }}>
          <div><span style={{ display: 'inline-block', width: 12, height: 12, background: '#f59e0b', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>{SLOT_TIPI.acilis.etiket}</div>
          <div><span style={{ display: 'inline-block', width: 12, height: 12, background: '#3b82f6', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>{SLOT_TIPI.normal.etiket}</div>
          <div><span style={{ display: 'inline-block', width: 12, height: 12, background: '#ef4444', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>{SLOT_TIPI.yogun.etiket}</div>
          <div><span style={{ display: 'inline-block', width: 12, height: 12, background: '#a855f7', borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }}></span>{SLOT_TIPI.kapanis.etiket}</div>
          <div style={{ marginLeft: 'auto' }}>
            Açık renk: slot zemini (referans bandı) · Koyu çubuk: kayıtlı gerçek mesai · Sarı kontur: çerçeve dışı dilim (bilinçli ek mesai vb.)
          </div>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// PERSONEL KISIT MODAL
// ═══════════════════════════════════════════════════════════════════
function KisitModal({ personel_id, subeler, onClose, onKaydet }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [presetler, setPresetler] = useState([]);

  useEffect(() => {
    api('/vardiya/v2/preset').then(r => setPresetler(r.presetler || [])).catch(() => {});
  }, []);

  useEffect(() => {
    api(`/vardiya/v2/kisit/${personel_id}`).then(r => setForm({
      max_gunluk_saat: r.max_gunluk_saat,
      max_haftalik_saat: r.max_haftalik_saat,
      izinli_subeler: r.izinli_subeler || [],
      yasak_subeler: r.yasak_subeler || [],
      calisilabilir_saat_min: r.calisilabilir_saat_min ? fmtSaat(r.calisilabilir_saat_min) : '',
      calisilabilir_saat_max: r.calisilabilir_saat_max ? fmtSaat(r.calisilabilir_saat_max) : '',
      min_gecis_dk: r.min_gecis_dk,
      vardiya_preset_json: r.vardiya_preset_json || {},
      gun_saat_kisitlari_json: r.gun_saat_kisitlari_json || {},
      yemek_sube_id: r.yemek_sube_id || '',
    }));
  }, [personel_id]);

  async function kaydet() {
    setBusy(true);
    try {
      await api(`/vardiya/v2/kisit/${personel_id}`, { method: 'PUT', body: {
        ...form,
        calisilabilir_saat_min: form.calisilabilir_saat_min || null,
        calisilabilir_saat_max: form.calisilabilir_saat_max || null,
        yemek_sube_id: form.yemek_sube_id || null,
      }});
      onKaydet();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  function presetSet(slot, kod) {
    setForm({ ...form, vardiya_preset_json: { ...(form.vardiya_preset_json||{}), [slot]: kod || undefined }});
  }

  function dersEkle() {
    const gun = window.prompt('Hangi gün? (pzt/sal/car/per/cum/cmt/paz)', 'car');
    if (!gun || !['pzt','sal','car','per','cum','cmt','paz'].includes(gun)) return;
    const bas = window.prompt('Yasak başlangıç saati (HH:MM)', '09:00');
    if (!bas) return;
    const bit = window.prompt('Yasak bitiş saati (HH:MM)', '13:00');
    if (!bit) return;
    const neden = window.prompt('Neden? (Ders/Lab/Randevu)', 'Ders') || 'Ders';
    const cur = (form.gun_saat_kisitlari_json || {})[gun] || [];
    const yeni = [...cur, { yasak_bas: bas, yasak_bit: bit, neden }];
    setForm({ ...form, gun_saat_kisitlari_json: { ...(form.gun_saat_kisitlari_json||{}), [gun]: yeni }});
  }

  function dersSil(gun, idx) {
    const cur = (form.gun_saat_kisitlari_json || {})[gun] || [];
    const yeni = cur.filter((_, i) => i !== idx);
    const j = { ...(form.gun_saat_kisitlari_json||{}) };
    if (yeni.length) j[gun] = yeni; else delete j[gun];
    setForm({ ...form, gun_saat_kisitlari_json: j });
  }

  function subeToggle(arr_field, sid) {
    const yeni = form[arr_field].includes(sid)
      ? form[arr_field].filter(x => x !== sid)
      : [...form[arr_field], sid];
    setForm({ ...form, [arr_field]: yeni });
  }

  if (!form) return null;
  return (
    <Modal onClose={onClose} title="Personel Kısıtları">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="form-group">
          <label>Max Günlük Saat</label>
          <input className="input" type="number" step="0.5" value={form.max_gunluk_saat}
            onChange={e => setForm({ ...form, max_gunluk_saat: parseFloat(e.target.value) || 0 })} />
        </div>
        <div className="form-group">
          <label>Max Haftalık Saat</label>
          <input className="input" type="number" step="0.5" value={form.max_haftalik_saat}
            onChange={e => setForm({ ...form, max_haftalik_saat: parseFloat(e.target.value) || 0 })} />
        </div>
        <div className="form-group">
          <label>Çalışabilir Saat Min</label>
          <input className="input" type="time" value={form.calisilabilir_saat_min}
            onChange={e => setForm({ ...form, calisilabilir_saat_min: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Çalışabilir Saat Max</label>
          <input className="input" type="time" value={form.calisilabilir_saat_max}
            onChange={e => setForm({ ...form, calisilabilir_saat_max: e.target.value })} />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.45 }}>
            <strong>Gündüz penceresi:</strong> Min ≤ Max (ör. 08:00–22:00) — slot bu aralığa uymalı.
            {' '}
            <strong>Gece penceresi:</strong> Min &gt; Max (ör. 23:59–08:00) — yalnızca bu gece dilimine
            denk slotlar uygundur; gündüz dilimi (ör. 09:00–22:00) ile kesişen atamalarda uyarı verilir.
          </div>
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Şube A → B minimum boşluk (dk)</label>
          <input className="input" type="number" min={0} value={form.min_gecis_dk}
            onChange={e => setForm({ ...form, min_gecis_dk: parseInt(e.target.value) || 0 })} />
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, lineHeight: 1.45 }}>
            Aynı gün, <strong>farklı şubelerde</strong> ardışık atamalar arasında en az bu kadar dakika olmalı.
            Sistemde sabit 30 dk yok; değer tamamen buradan (varsayılan genelde <strong>60</strong>, örneğin <strong>30</strong> yapılabilir).
            <strong>0</strong> yazarsanız şube geçiş süresi uyarısı üretilmez.
          </div>
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>İzinli Şubeler (boş = tümü)</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {subeler.map(s => {
              const aktif = form.izinli_subeler.includes(s.id);
              return (
                <button key={s.id} type="button"
                  onClick={() => subeToggle('izinli_subeler', s.id)}
                  className={`btn btn-sm ${aktif ? 'btn-primary' : 'btn-secondary'}`}>
                  {s.ad}
                </button>
              );
            })}
          </div>
        </div>
        {/* ─── Yemek molası şubesi ─── */}
        <div className="form-group" style={{ gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>🍽 Yemek Molası Şubesi</label>
          <select className="input" value={form.yemek_sube_id || ''}
            onChange={e => setForm({ ...form, yemek_sube_id: e.target.value })}>
            <option value="">— Seçilmemiş —</option>
            {subeler.map(s => <option key={s.id} value={s.id}>{s.ad}</option>)}
          </select>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
            Personelin yemek molasını yapacağı sabit şube. Sol havuz kartında ve atama hücresinde 🍽 satırı olarak gösterilir.
          </div>
        </div>

        {/* ─── Vardiya Preset (hibrit) ─── */}
        <div className="form-group" style={{ gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>⏱ Vardiya Preset (atama saati önceliği)</label>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
            Sürükle-bırak atamasında sunucu önce <strong>gün kodu</strong> (pzt…paz), yoksa hafta içi/sonu, yoksa varsayılan preset saatini kullanır; hepsi boşsa slot saati kalır.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Hafta İçi (Pzt–Cum)</div>
              <select className="input" value={form.vardiya_preset_json?.hafta_ici || ''}
                onChange={e => presetSet('hafta_ici', e.target.value)}>
                <option value="">— Yok —</option>
                {presetler.map(pr => (
                  <option key={pr.kod} value={pr.kod}>
                    {pr.ad} ({fmtSaat(pr.bas_saat)}–{fmtSaat(pr.bit_saat)})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Hafta Sonu (Cmt–Paz)</div>
              <select className="input" value={form.vardiya_preset_json?.hafta_sonu || ''}
                onChange={e => presetSet('hafta_sonu', e.target.value)}>
                <option value="">— Yok —</option>
                {presetler.map(pr => (
                  <option key={pr.kod} value={pr.kod}>
                    {pr.ad} ({fmtSaat(pr.bas_saat)}–{fmtSaat(pr.bit_saat)})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', margin: '10px 0 6px' }}>
            <strong>Gün başına</strong> (doluysa hafta içi/sonu yerine o günün kodu kullanılır):
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {V2_PRESET_GUN_ANAHTARLARI.map((gk, i) => (
              <div key={gk}>
                <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 2, color: 'var(--text3)' }}>{TR_GUNLER[i].slice(0, 3)}</div>
                <select
                  className="input"
                  style={{ fontSize: 11, padding: '4px 2px' }}
                  value={form.vardiya_preset_json?.[gk] || ''}
                  onChange={(e) => presetSet(gk, e.target.value)}
                >
                  <option value="">—</option>
                  {presetler.map((pr) => (
                    <option key={pr.kod} value={pr.kod}>{pr.kod}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Varsayılan preset</div>
            <select className="input" value={form.vardiya_preset_json?.default || ''}
              onChange={(e) => presetSet('default', e.target.value)}>
              <option value="">— Yok —</option>
              {presetler.map((pr) => (
                <option key={pr.kod} value={pr.kod}>
                  {pr.ad} ({fmtSaat(pr.bas_saat)}–{fmtSaat(pr.bit_saat)})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* ─── Gün-bazlı yasak saatler (öğrenci/ders) ─── */}
        <div className="form-group" style={{ gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label>🚫 Çalışamayacağı Saatler (öğrenci/ders/randevu)</label>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
            Bu saat aralığında atanırsa drop popup'ı kritik uyarı verir, override ile geçilebilir.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
            {Object.keys(form.gun_saat_kisitlari_json || {}).length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                Henüz tanımlı kısıt yok.
              </div>
            )}
            {Object.entries(form.gun_saat_kisitlari_json || {}).flatMap(([gun, liste]) =>
              (liste || []).map((item, i) => (
                <div key={`${gun}-${i}`} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '4px 8px', background: 'var(--bg3)', borderRadius: 4, fontSize: 12,
                }}>
                  <span>
                    <strong>{gun.toUpperCase()}</strong>: {item.yasak_bas} – {item.yasak_bit}
                    {item.neden && <span style={{ color: 'var(--text3)' }}> · {item.neden}</span>}
                  </span>
                  <button type="button" onClick={() => dersSil(gun, i)}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>✕</button>
                </div>
              ))
            )}
          </div>
          <button type="button" className="btn btn-sm btn-secondary" onClick={dersEkle}>
            + Saat kısıtı ekle
          </button>
        </div>

        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Yasaklı Şubeler</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {subeler.map(s => {
              const aktif = form.yasak_subeler.includes(s.id);
              return (
                <button key={s.id} type="button"
                  onClick={() => subeToggle('yasak_subeler', s.id)}
                  className={`btn btn-sm ${aktif ? 'btn-danger' : 'btn-secondary'}`}>
                  {s.ad}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>İptal</button>
        <button className="btn btn-primary" onClick={kaydet} disabled={busy}>{busy ? '…' : 'Kaydet'}</button>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// İZİN MODAL
// ═══════════════════════════════════════════════════════════════════
function IzinModal({ personeller, onClose }) {
  const [izinler, setIzinler] = useState([]);
  const [yeni, setYeni] = useState({ personel_id: '', baslangic_tarih: isoToday(), bitis_tarih: isoToday(), tip: 'mazeret', aciklama: '' });
  const [busy, setBusy] = useState(false);

  const yukle = useCallback(async () => {
    const r = await api('/vardiya/v2/izin');
    setIzinler(r.izinler || []);
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  async function ekle() {
    if (!yeni.personel_id) return;
    setBusy(true);
    const temiz = {
      personel_id: yeni.personel_id,
      baslangic_tarih: yeni.baslangic_tarih,
      bitis_tarih: yeni.bitis_tarih,
      tip: yeni.tip,
      aciklama: yeni.aciklama || undefined,
    };
    try {
      await api('/vardiya/v2/izin', { method: 'POST', body: temiz });
      setYeni({ personel_id: '', baslangic_tarih: isoToday(), bitis_tarih: isoToday(), tip: 'mazeret', aciklama: '' });
      await yukle();
    } catch (e) {
      const msg = String(e?.message || '');
      const ayniHaftaIkinci =
        msg.includes('force') || msg.includes('aynı takvim haftasında');
      if (ayniHaftaIkinci) {
        if (confirm(`${msg}\n\nYine de bu hafta ikinci izin kaydı oluşturulsun mu?`)) {
          try {
            await api('/vardiya/v2/izin', { method: 'POST', body: { ...temiz, force: true } });
            setYeni({ personel_id: '', baslangic_tarih: isoToday(), bitis_tarih: isoToday(), tip: 'mazeret', aciklama: '' });
            await yukle();
          } catch (e2) {
            alert(String(e2?.message || 'Kaydedilemedi'));
          }
        }
      } else {
        alert(msg || 'Kaydedilemedi');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sil(id) {
    if (!confirm('İzni sil?')) return;
    await api(`/vardiya/v2/izin/${id}`, { method: 'DELETE' });
    await yukle();
  }

  return (
    <Modal onClose={onClose} title="🌴 İzin Yönetimi" geniş>
      <div className="card" style={{ padding: 12, marginBottom: 14, background: 'var(--bg3)' }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>+ Yeni İzin</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, alignItems: 'end' }}>
          <select className="input" value={yeni.personel_id} onChange={e => setYeni({ ...yeni, personel_id: e.target.value })}>
            <option value="">Personel seç…</option>
            {personeller.map(p => <option key={p.id} value={p.id}>{p.ad} {p.soyad}</option>)}
          </select>
          <input className="input" type="date" value={yeni.baslangic_tarih} onChange={e => setYeni({ ...yeni, baslangic_tarih: e.target.value })} />
          <input className="input" type="date" value={yeni.bitis_tarih} onChange={e => setYeni({ ...yeni, bitis_tarih: e.target.value })} />
          <select className="input" value={yeni.tip} onChange={e => setYeni({ ...yeni, tip: e.target.value })}>
            <option value="yillik">Yıllık</option>
            <option value="mazeret">Mazeret</option>
            <option value="rapor">Rapor</option>
            <option value="ucretsiz">Ücretsiz</option>
          </select>
          <button className="btn btn-primary" onClick={ekle} disabled={busy || !yeni.personel_id}>Ekle</button>
        </div>
        <input className="input" placeholder="Açıklama (opsiyonel)" value={yeni.aciklama}
          onChange={e => setYeni({ ...yeni, aciklama: e.target.value })}
          style={{ marginTop: 8 }} />
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        <table className="table" style={{ fontSize: 12 }}>
          <thead><tr><th>Personel</th><th>Başlangıç</th><th>Bitiş</th><th>Tip</th><th>Açıklama</th><th /></tr></thead>
          <tbody>
            {izinler.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 20 }}>İzin kaydı yok</td></tr>}
            {izinler.map(i => (
              <tr key={i.id}>
                <td>{i.personel_ad} {i.personel_soyad}</td>
                <td>{i.baslangic_tarih}</td>
                <td>{i.bitis_tarih}</td>
                <td>{i.tip}</td>
                <td>{i.aciklama}</td>
                <td><button className="btn btn-sm btn-danger" onClick={() => sil(i.id)}>Sil</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// UYARI (sarı) — DROP ÖNCESİ EVET / HAYIR
// ═══════════════════════════════════════════════════════════════════
function UyariOnayModal({ uyarilar, ozetMetni, onHayir, onEvet }) {
  return (
    <Modal onClose={onHayir} title="Uyarı — devam edilsin mi?">
      {ozetMetni ? (
        <div style={{ marginBottom: 14, fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.45 }}>
          {ozetMetni}
        </div>
      ) : null}
      <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text2)', lineHeight: 1.45 }}>
        Bu atama kurallara göre riskli uyarılar içeriyor (kritik değil). Yine de kaydetmek istiyor musunuz?
        {' '}Override log’a yazılmaz; yalnızca atama oluşturulur.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
        {(uyarilar || []).map((u, i) => (
          <div
            key={i}
            style={{
              padding: '8px 12px',
              borderLeft: '4px solid #f59e0b',
              background: 'rgba(245,158,11,0.08)',
              borderRadius: 4,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 11, color: '#d97706' }}>
              Uyarı · {String(u.tip || '').replace(/_/g, ' ')}
            </div>
            <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text2)' }}>{u.mesaj}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary" onClick={onHayir}>Hayır</button>
        <button type="button" className="btn btn-primary" onClick={onEvet}>Evet</button>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OVERRIDE ONAY MODAL
// ═══════════════════════════════════════════════════════════════════
function OverrideModal({ uyarilar, ozetMetni, onIptal, onOnayla }) {
  const [gerekce, setGerekce] = useState('');
  return (
    <Modal onClose={onIptal} title="Kural ihlali — onay">
      {ozetMetni ? (
        <div style={{ marginBottom: 14, fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.45 }}>
          {ozetMetni}
        </div>
      ) : null}
      <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text3)' }}>
        Aşağıdaki uyarılar geçilirse atama yapılır; ihlaller override log’a yazılır (otomatik metin + sizin gerekçeniz ayrı).
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
        {uyarilar.map((u, i) => (
          <div key={i} style={{
            padding: '8px 12px',
            borderLeft: `4px solid ${u.seviye === 'kritik' ? '#ef4444' : '#f59e0b'}`,
            background: u.seviye === 'kritik' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
            borderRadius: 4,
          }}>
            <div style={{ fontWeight: 700, fontSize: 11, color: u.seviye === 'kritik' ? '#ef4444' : '#f59e0b' }}>
              {u.seviye === 'kritik' ? 'Kritik' : 'Uyarı'} · {String(u.tip || '').replace(/_/g, ' ')}
            </div>
            <div style={{ fontSize: 13, marginTop: 4, color: 'var(--text2)' }}>{u.mesaj}</div>
          </div>
        ))}
      </div>
      <div className="form-group" style={{ marginTop: 14 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>Override gerekçesi (serbest metin, opsiyonel)</label>
        <textarea
          className="input"
          rows={3}
          value={gerekce}
          onChange={(e) => setGerekce(e.target.value)}
          placeholder="Örn. müşteri yoğunluğu, yönetici onayı, acil eksik kapatma…"
          style={{ width: '100%', resize: 'vertical', minHeight: 72, marginTop: 6 }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary" onClick={onIptal}>Vazgeç</button>
        <button type="button" className="btn btn-primary" onClick={() => onOnayla(gerekce)}>Yine de Ata</button>
      </div>
    </Modal>
  );
}

/** Override log payload_json → nesne (API dict veya JSON string) */
function vardiyaOverridePayloadObj(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════
// LOG MODAL
// ═══════════════════════════════════════════════════════════════════
function LogModal({ onClose }) {
  const [kayitlar, setKayitlar] = useState([]);
  useEffect(() => {
    api('/vardiya/v2/override-log').then(r => setKayitlar(r.kayitlar || []));
  }, []);
  return (
    <Modal onClose={onClose} title="📜 Override Log" geniş>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        <table className="table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Zaman</th>
              <th>Personel</th>
              <th>İhlal</th>
              <th>Tarih</th>
              <th>Kullanıcı gerekçesi</th>
              <th>Sistem mesajı</th>
            </tr>
          </thead>
          <tbody>
            {kayitlar.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 20 }}>Log kaydı yok</td></tr>
            )}
            {kayitlar.map((k) => {
              const pl = vardiyaOverridePayloadObj(k.payload_json);
              const hasSistem = Object.prototype.hasOwnProperty.call(pl, 'sistem_mesaji');
              const sistemTxt = hasSistem ? String(pl.sistem_mesaji || '').trim() : '';
              const userTxt = (k.aciklama || '').trim();
              const sistemHucre = hasSistem ? (sistemTxt || '—') : (userTxt || '—');
              const userHucre = hasSistem ? (userTxt || '—') : '—';
              return (
                <tr key={k.id}>
                  <td>{new Date(k.ts).toLocaleString('tr-TR')}</td>
                  <td>{k.personel_ad} {k.personel_soyad}</td>
                  <td><span style={{ color: '#f59e0b', fontWeight: 600 }}>{k.ihlal_tipi}</span></td>
                  <td>{k.tarih}</td>
                  <td style={{ maxWidth: 220, wordBreak: 'break-word' }}>{userHucre}</td>
                  <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>{sistemHucre}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════
// GENERIC MODAL
// ═══════════════════════════════════════════════════════════════════
function Modal({ children, onClose, title, geniş = false }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: geniş ? 900 : 600, width: '90%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// DROP ATAMA — saat + hızlı preset (atama/check öncesi)
// ═══════════════════════════════════════════════════════════════════
function DropAtamaSaatModal({
  personel,
  slotId,
  gunTarihi,
  planForGun,
  onClose,
  onTamam,
}) {
  const [bas, setBas] = useState('09:00');
  const [bit, setBit] = useState('18:00');
  const [oneriKaynak, setOneriKaynak] = useState(null);
  const [busy, setBusy] = useState(true);

  const mesaiOneriSlot = oneriKaynak === 'mesai_slot' || oneriKaynak === 'part_slot';

  useEffect(() => {
    let cancel = false;
    (async () => {
      const row = planSlotSatirBul(planForGun, slotId);
      let b0 = fmtSaat(row?.sv?.slot?.baslangic_saat) || '09:00';
      let b1 = fmtSaat(row?.sv?.slot?.bitis_saat) || '18:00';
      try {
        const pr = await api(
          `/vardiya/v2/personel-onerilen-saat?personel_id=${encodeURIComponent(personel.id)}`
          + `&tarih=${encodeURIComponent(gunTarihi)}`
          + `&slot_id=${encodeURIComponent(slotId)}`,
        );
        if (pr?.preset?.bas_saat) b0 = fmtSaat(pr.preset.bas_saat);
        if (pr?.preset?.bit_saat) b1 = fmtSaat(pr.preset.bit_saat);
        if (!cancel) setOneriKaynak(pr?.kaynak || null);
      } catch {
        if (!cancel) setOneriKaynak(null);
      }
      if (!cancel) {
        setBas(b0);
        setBit(b1);
        setBusy(false);
      }
    })();
    return () => { cancel = true; };
  }, [personel.id, slotId, gunTarihi, planForGun]);

  const slotRow = planSlotSatirBul(planForGun, slotId);
  const slotAd = slotRow?.sv?.slot?.ad || 'Slot';
  const slotBasDef = fmtSaat(slotRow?.sv?.slot?.baslangic_saat);
  const slotBitDef = fmtSaat(slotRow?.sv?.slot?.bitis_saat);

  async function handleTamam() {
    const b0 = (bas || '').trim();
    const b1 = (bit || '').trim();
    if (!b0 || !b1) {
      window.alert('Başlangıç ve bitiş saatini birlikte girin (örn. mesai 14:30\'ta bitecekse bitiş 14:30 olmalı).');
      return;
    }
    setBusy(true);
    try {
      await onTamam(b0, b1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title="Atama saati">
      <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 0 }}>
        <strong>{personel.ad} {personel.soyad || ''}</strong>
        {' → '}
        <strong>{slotAd}</strong>
        {' · '}
        {gunTarihi}
      </p>
      <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, marginBottom: 0, lineHeight: 1.35 }}>
        Slot şubenin <strong>referans çerçevesi ve kontenjan bandıdır</strong>. Bu kişinin o şubede gerçekte{' '}
        <strong>ne zaman çalışacağını</strong> yalnızca aşağıdaki başlangıç–bitiş belirler (kısmi mesai, ardışık iki vardiya veya çerçeveden uzun mesai dahil).
      </p>
      <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8, marginBottom: 0, lineHeight: 1.35 }}>
        Aynı slot altında iki kişiyi ardışık çalıştırabilirsiniz (ör. 09:00–14:30 ve 14:30’dan sonra). Çerçeveyi{' '}
        <strong>bilinçli aştığınızda</strong> (ek mesai vb.) sistem bilgilendirici uyarı verir; kayıtta esas olan yine burada yazdığınız saatlerdir.
      </p>
      {mesaiOneriSlot && (
        <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, marginBottom: 0, lineHeight: 1.35 }}>
          Başlangıç saatleri <strong>slot + günlük çalışma limitine</strong> göre önerildi; uzun slotlarda otomatik
          <strong> tam slot doldurma</strong> varsayılmaz. Tam gün veya başka dilim için{' '}
          <strong>tanımlı şablonlar</strong> veya <strong>Slot saati</strong> kullanın.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 10 }}>
        <div className="form-group">
          <label>Başlangıç</label>
          <input className="input" type="time" value={bas} onChange={(e) => setBas(e.target.value)} disabled={busy} />
        </div>
        <div className="form-group">
          <label>Bitiş</label>
          <input className="input" type="time" value={bit} onChange={(e) => setBit(e.target.value)} disabled={busy} />
        </div>
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text3)', marginTop: 10 }}>Tanımlı saat şablonları</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => { setBas(slotBasDef); setBit(slotBitDef); }}>
          Slot saati ({slotBasDef}–{slotBitDef})
        </button>
        {SAAT_SABLONLARI.map((h) => (
          <button
            key={h.etiket}
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={busy}
            onClick={() => {
              setBas(h.bas);
              setBit(h.bit);
            }}
            title={`${h.etiket}: ${h.bas} – ${h.bit}`}
          >
            {h.etiket} ({h.bas}–{h.bit})
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>İptal</button>
        <button type="button" className="btn btn-primary" onClick={handleTamam} disabled={busy}>{busy ? '…' : 'Atamaya devam'}</button>
      </div>
    </Modal>
  );
}
