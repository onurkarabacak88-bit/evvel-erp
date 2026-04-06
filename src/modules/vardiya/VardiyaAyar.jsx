import { useState, useEffect } from 'react';
import { api, today } from '../../utils/api';

/** API TIME / string → time input HH:MM */
function saatInputVal(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

/** GET personel-kisit → form: şube yasakları (kayıt yok = serbest) */
function normalizeSubeYasaklariFromApi(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => ({
      sube_id: String(x.sube_id || x.branch_id || '').trim(),
      yasak: x.yasak !== false,
    }))
    .filter((x) => x.sube_id);
}

/** PUT personel-kisit: kontrat { branch_id, sube_id, yasak } */
function subeYasaklariToApiPayload(rows) {
  const a = Array.isArray(rows) ? rows : [];
  return a
    .filter((r) => r && String(r.sube_id || '').trim())
    .map((r) => {
      const id = String(r.sube_id).trim();
      return { branch_id: id, sube_id: id, yasak: r.yasak !== false };
    });
}

const VARSAYILAN_SUBE = {
  vardiyaya_dahil: true,
  planla_acilis: true,
  planla_kapanis: true,
  min_kapanis: 1,
  tek_kapanis_izinli: true,
  tek_acilis_izinli: true,
  kaydirma_acik: true,
  sadece_tam_kayabilir: false,
  hafta_sonu_min_kap: 1,
  tam_part_zorunlu: false,
  kapanis_dusurulemez: false,
  acilis_bas_saat: '',
  acilis_bit_saat: '',
  ara_bas_saat: '',
  ara_bit_saat: '',
  kapanis_bas_saat: '',
  kapanis_bit_saat: '',
};

const SUBE_VARDIYA_SAAT = [
  {
    tip: 'ACILIS',
    label: 'Açılış (ACILIS)',
    bas: 'acilis_bas_saat',
    bit: 'acilis_bit_saat',
  },
  { tip: 'ARA', label: 'Ara (ARA)', bas: 'ara_bas_saat', bit: 'ara_bit_saat' },
  {
    tip: 'KAPANIS',
    label: 'Kapanış (KAPANIS)',
    bas: 'kapanis_bas_saat',
    bit: 'kapanis_bit_saat',
  },
];

/**
 * Personel API kontratı (Bölüm 2): GET/PUT `vardiya_yetkisi: { acilis, ara, kapanis }`.
 * Form state kolon adlarıyla (`*_yapabilir`) senkron tutulur.
 */
const VARDIYA_YETKISI_KEYS = [
  { kontrat: 'acilis', state: 'acilis_yapabilir', label: 'Açılış' },
  { kontrat: 'ara', state: 'ara_yapabilir', label: 'Ara' },
  { kontrat: 'kapanis', state: 'kapanis_yapabilir', label: 'Kapanış' },
];

const VARSAYILAN_KISIT = {
  acilis_yapabilir: true,
  ara_yapabilir: true,
  kapanis_yapabilir: true,
  sadece_tip: '',
  sube_degistirebilir: true,
  kapanis_bit_saat: '',
  calisma_profili: '',
  hafta_max_gun: '',
  gunluk_max_saat: '',
  haftalik_max_saat: '',
  min_baslangic_saat: '',
  max_cikis_saat: '',
  izinli_sube_ids: '',
  kaydirma_izin_ciftleri: '',
  part_gunluk_min_saat: '',
  part_gunluk_max_saat: '',
  gunluk_mesai_fazlasi_saat: '',
  /** { sube_id, yasak }[] — API sube_yasaklari ile aynı mantık */
  sube_yasaklari: [],
};

const HAFTA_GUNU_ADLARI = [
  'Pazartesi',
  'Salı',
  'Çarşamba',
  'Perşembe',
  'Cuma',
  'Cumartesi',
  'Pazar',
];

function bosGunlukSatirlari() {
  return [0, 1, 2, 3, 4, 5, 6].map((hg) => ({
    hafta_gunu: hg,
    calisabilir: true,
    sadece_tip: '',
    min_baslangic: '',
    max_cikis: '',
    max_saat: '',
  }));
}

function parseIzinliSubeCsv(s) {
  return (s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function apiGunlukBirlestir(apiRows) {
  const byHg = {};
  (apiRows || []).forEach((r) => {
    byHg[Number(r.hafta_gunu)] = r;
  });
  return bosGunlukSatirlari().map((b) => {
    const r = byHg[b.hafta_gunu];
    if (!r) return b;
    const cal =
      r.calisabilir !== undefined && r.calisabilir !== null
        ? !!r.calisabilir
        : !r.calisamaz;
    return {
      hafta_gunu: b.hafta_gunu,
      calisabilir: cal,
      sadece_tip: r.sadece_tip || '',
      min_baslangic: saatInputVal(r.min_baslangic),
      max_cikis: saatInputVal(r.max_cikis),
      max_saat: r.max_saat != null && r.max_saat !== '' ? String(r.max_saat) : '',
    };
  });
}

const VPLAN_TIP_FROM_API = { ACILIS: 'acilis', ARA: 'ara', KAPANIS: 'kapanis' };

const DEFAULT_PLAN_VARDIYA = [
  { tip: 'acilis', aktif: true, kisi_sayisi: 1, personel_turu: 'farketmez', oncelik: 'normal' },
  { tip: 'ara', aktif: true, kisi_sayisi: 1, personel_turu: 'farketmez', oncelik: 'normal' },
  { tip: 'kapanis', aktif: true, kisi_sayisi: 1, personel_turu: 'farketmez', oncelik: 'normal' },
];

function tarihPlusGun(isoYmd, gun) {
  const d = new Date(`${isoYmd}T12:00:00`);
  d.setDate(d.getDate() + gun);
  return d.toISOString().split('T')[0];
}

/** Planlama API kök varsayılan saat (override ile aynı anahtar adları) */
function planlamaDefaultSaat(d, alan) {
  if (alan === 'acilis')
    return d.acilis_saati != null ? d.acilis_saati : d.default_acilis_saati;
  return d.kapanis_saati != null ? d.kapanis_saati : d.default_kapanis_saati;
}

function apiGirdiToFormPlan(vg) {
  const raw =
    !vg || vg.length === 0
      ? DEFAULT_PLAN_VARDIYA.map((x) => ({ ...x }))
      : vg.map((r) => ({
          tip: VPLAN_TIP_FROM_API[r.tip] || String(r.tip || 'acilis').toLowerCase(),
          aktif: !!r.aktif,
          kisi_sayisi: Number(r.kisi_sayisi) || 0,
          personel_turu: r.personel_turu || 'farketmez',
          oncelik: r.oncelik || 'normal',
        }));
  return raw.map((row) => patchPlanGirdiRow(row, {}));
}

function patchPlanGirdiRow(row, patch) {
  const next = { ...row, ...patch };
  const ks = Math.max(0, parseInt(String(next.kisi_sayisi), 10) || 0);
  next.kisi_sayisi = ks;
  next.aktif = !!next.aktif && ks > 0;
  return next;
}

function planGirdiToPayload(rows) {
  return rows.map((r) => {
    const ks = Math.max(0, parseInt(String(r.kisi_sayisi), 10) || 0);
    return {
      tip: r.tip,
      aktif: !!r.aktif && ks > 0,
      kisi_sayisi: ks,
      personel_turu: r.personel_turu || 'farketmez',
      oncelik: r.oncelik || 'normal',
    };
  });
}

const SUBE_KURAL_SATIRLARI = [
  {
    field: 'planla_acilis',
    label: 'Bu şubede açılış (ACILIS) vardiyası otomatik planda atansın',
    tip: 'bool',
  },
  {
    field: 'planla_kapanis',
    label: 'Bu şubede kapanış (KAPANIS) vardiyası otomatik planda atansın',
    tip: 'bool',
  },
  { field: 'min_kapanis', label: 'Minimum kapanış personeli (hafta içi)', tip: 'number', min: 1, max: 5 },
  { field: 'hafta_sonu_min_kap', label: 'Hafta sonu minimum kapanış', tip: 'number', min: 1, max: 5 },
  { field: 'tek_kapanis_izinli', label: 'Tek kişi ile kapanış yapılabilir', tip: 'bool' },
  { field: 'tek_acilis_izinli', label: 'Tek kişi ile açılış yeterli', tip: 'bool' },
  { field: 'kapanis_dusurulemez', label: 'Kapanış düşürülemez (tek personelde bile KAPANIS)', tip: 'bool' },
  { field: 'kaydirma_acik', label: 'Bağlantılı şubelerden kaydırma açık', tip: 'bool' },
  { field: 'sadece_tam_kayabilir', label: 'Kaydırılacak personel: sadece tam zamanlı', tip: 'bool' },
  { field: 'tam_part_zorunlu', label: 'Hedef: 1 tam + 1 part (uyarı motoru)', tip: 'bool' },
];

/**
 * Şube kuralları, personel kısıtları, şube bağlantıları, izin talepleri.
 */
export default function VardiyaAyar() {
  const [subeler, setSubeler] = useState([]);
  const [personeller, setPersoneller] = useState([]);
  const [subeCfg, setSubeCfg] = useState({});
  const [kisitlar, setKisitlar] = useState({});
  const [baglantilar, setBaglantilar] = useState([]);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('subeler');
  const [kayitLoading, setKayitLoading] = useState({});
  const [izinler, setIzinler] = useState([]);
  const [izinForm, setIzinForm] = useState({
    personel_id: '',
    baslangic_tarih: '',
    bitis_tarih: '',
    aciklama: '',
  });
  const [gunlukPid, setGunlukPid] = useState('');
  const [gunlukSatirlar, setGunlukSatirlar] = useState(bosGunlukSatirlari);
  const [gunlukYukleniyor, setGunlukYukleniyor] = useState(false);
  const [gunlukKaydediliyor, setGunlukKaydediliyor] = useState(false);
  /** Bölüm 3: `personel_gunluk_durum` — { tarih, calisabilir, tur } (tam|part|'') */
  const [durumSatirlar, setDurumSatirlar] = useState([]);
  const [durumKaydediliyor, setDurumKaydediliyor] = useState(false);
  const [subeKisitPid, setSubeKisitPid] = useState('');
  const [hatKaynakSel, setHatKaynakSel] = useState('');
  const [hatHedefSel, setHatHedefSel] = useState('');
  /** personel_id → otomatik vardiya havuzunda mı */
  const [pcVardiyaDahil, setPcVardiyaDahil] = useState({});
  /** GET/PUT /api/sube-planlama — şube aktif, varsayılan saat, günlük override, vardiya girdileri */
  const [planlamaSid, setPlanlamaSid] = useState('');
  const [planYukleniyor, setPlanYukleniyor] = useState(false);
  const [planKaydediliyor, setPlanKaydediliyor] = useState(false);
  const [planAktif, setPlanAktif] = useState(true);
  const [planAcilis, setPlanAcilis] = useState('');
  const [planKapanis, setPlanKapanis] = useState('');
  const [planGirdi, setPlanGirdi] = useState(() => DEFAULT_PLAN_VARDIYA.map((x) => ({ ...x })));
  const [planOverrides, setPlanOverrides] = useState([]);
  /** Sunucudan silinecek günlük override tarihleri (PUT ile çift null gönderilir) */
  const [planOverrideDeletes, setPlanOverrideDeletes] = useState([]);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 4000);
  };

  const yukleIzinler = () => {
    api('/personel-izin')
      .then(setIzinler)
      .catch(() => setIzinler([]));
  };

  useEffect(() => {
    api('/subeler')
      .then((s) => {
        setSubeler(s);
        Promise.all(
          s.map((sub) =>
            api(`/sube-config/${sub.id}`).catch(() => ({
              sube_id: sub.id,
              ...VARSAYILAN_SUBE,
            })),
          ),
        ).then((cfgs) => {
          const m = {};
          cfgs.forEach((c) => {
            m[c.sube_id] = {
              ...VARSAYILAN_SUBE,
              ...c,
              acilis_bas_saat: saatInputVal(c.acilis_bas_saat),
              acilis_bit_saat: saatInputVal(c.acilis_bit_saat),
              ara_bas_saat: saatInputVal(c.ara_bas_saat),
              ara_bit_saat: saatInputVal(c.ara_bit_saat),
              kapanis_bas_saat: saatInputVal(c.kapanis_bas_saat),
              kapanis_bit_saat: saatInputVal(c.kapanis_bit_saat),
            };
          });
          setSubeCfg(m);
        });
      })
      .catch(() => setSubeler([]));

    api('/personel?aktif=true')
      .then((p) => {
        setPersoneller(p);
        Promise.all(
          p.map((per) =>
            api(`/personel-kisit/${per.id}`).catch(() => ({
              personel_id: per.id,
              ...VARSAYILAN_KISIT,
            })),
          ),
        ).then((ks) => {
          const m = {};
          ks.forEach((k) => {
            const vy = k.vardiya_yetkisi;
            let ac = k.acilis_yapabilir !== false;
            let ar = k.ara_yapabilir !== false;
            let kap = k.kapanis_yapabilir !== false;
            if (vy && typeof vy === 'object') {
              if ('acilis' in vy) ac = !!vy.acilis;
              if ('ara' in vy) ar = !!vy.ara;
              if ('kapanis' in vy) kap = !!vy.kapanis;
            }
            m[k.personel_id] = {
              ...VARSAYILAN_KISIT,
              ...k,
              acilis_yapabilir: ac,
              ara_yapabilir: ar,
              kapanis_yapabilir: kap,
              sadece_tip: k.sadece_tip || '',
              kapanis_bit_saat: k.kapanis_bit_saat
                ? String(k.kapanis_bit_saat).slice(0, 5)
                : '',
              calisma_profili: k.calisma_profili || '',
              hafta_max_gun: k.hafta_max_gun != null ? String(k.hafta_max_gun) : '',
              gunluk_max_saat:
                k.gunluk_max_saat != null && k.gunluk_max_saat !== ''
                  ? String(k.gunluk_max_saat)
                  : '',
              haftalik_max_saat:
                k.haftalik_max_saat != null && k.haftalik_max_saat !== ''
                  ? String(k.haftalik_max_saat)
                  : '',
              min_baslangic_saat: saatInputVal(k.min_baslangic_saat),
              max_cikis_saat: saatInputVal(k.max_cikis_saat),
              izinli_sube_ids:
                k.izinli_sube_ids != null && k.izinli_sube_ids !== ''
                  ? String(k.izinli_sube_ids)
                  : '',
              part_gunluk_min_saat:
                k.part_gunluk_min_saat != null && k.part_gunluk_min_saat !== ''
                  ? String(k.part_gunluk_min_saat)
                  : '',
              part_gunluk_max_saat:
                k.part_gunluk_max_saat != null && k.part_gunluk_max_saat !== ''
                  ? String(k.part_gunluk_max_saat)
                  : '',
              gunluk_mesai_fazlasi_saat:
                k.gunluk_mesai_fazlasi_saat != null && k.gunluk_mesai_fazlasi_saat !== ''
                  ? String(k.gunluk_mesai_fazlasi_saat)
                  : '',
              kaydirma_izin_ciftleri:
                k.kaydirma_izin_ciftleri != null && k.kaydirma_izin_ciftleri !== ''
                  ? String(k.kaydirma_izin_ciftleri)
                  : '',
              sube_yasaklari: normalizeSubeYasaklariFromApi(k.sube_yasaklari),
            };
          });
          setKisitlar(m);
        });
      })
      .catch(() => setPersoneller([]));

    api('/sube-baglanti')
      .then(setBaglantilar)
      .catch(() => setBaglantilar([]));

    yukleIzinler();

    api('/personel-config')
      .then((rows) => {
        const m = {};
        (rows || []).forEach((r) => {
          m[r.personel_id] = r.vardiyaya_dahil !== false;
        });
        setPcVardiyaDahil(m);
      })
      .catch(() => setPcVardiyaDahil({}));
  }, []);

  useEffect(() => {
    if (subeler.length > 0 && !planlamaSid) {
      setPlanlamaSid(String(subeler[0].id));
    }
  }, [subeler, planlamaSid]);

  useEffect(() => {
    if (tab !== 'plan-model' || !planlamaSid) {
      return undefined;
    }
    let cancel = false;
    setPlanYukleniyor(true);
    const fromD = today();
    const toD = tarihPlusGun(fromD, 60);
    api(`/sube-planlama/${planlamaSid}?from_tarih=${fromD}&to_tarih=${toD}`)
      .then((d) => {
        if (cancel) return;
        setPlanAktif(!!d.aktif_mi);
        setPlanAcilis(saatInputVal(planlamaDefaultSaat(d, 'acilis')));
        setPlanKapanis(saatInputVal(planlamaDefaultSaat(d, 'kapanis')));
        setPlanGirdi(apiGirdiToFormPlan(d.vardiya_girdileri));
        setPlanOverrides(
          (d.gunluk_overrides || []).map((o) => ({
            tarih: o.tarih || '',
            acilis_saati: saatInputVal(o.acilis_saati),
            kapanis_saati: saatInputVal(o.kapanis_saati),
          })),
        );
        setPlanOverrideDeletes([]);
      })
      .catch((e) => {
        if (!cancel) toast(e.message, 'red');
      })
      .finally(() => {
        if (!cancel) setPlanYukleniyor(false);
      });
    return () => {
      cancel = true;
    };
  }, [tab, planlamaSid]);

  useEffect(() => {
    if (tab !== 'gunluk' || !gunlukPid) {
      return undefined;
    }
    let cancel = false;
    setGunlukYukleniyor(true);
    const fromD = today();
    const toD = tarihPlusGun(fromD, 120);
    Promise.all([
      api(`/personel-gunluk-kisit/${gunlukPid}`)
        .then((rows) => {
          if (!cancel) setGunlukSatirlar(apiGunlukBirlestir(rows));
        })
        .catch(() => {
          if (!cancel) setGunlukSatirlar(bosGunlukSatirlari());
        }),
      api(
        `/personel-gunluk-durum/${gunlukPid}?from_tarih=${fromD}&to_tarih=${toD}`,
      )
        .then((rows) => {
          if (!cancel) {
            setDurumSatirlar(
              (Array.isArray(rows) ? rows : []).map((r) => {
                const sk = r.saat_kisiti && typeof r.saat_kisiti === 'object' ? r.saat_kisiti : {};
                return {
                  tarih: String(r.tarih || '').slice(0, 10),
                  calisabilir: r.calisabilir !== false,
                  tur: r.tur === 'tam' || r.tur === 'part' ? r.tur : '',
                  en_erken: saatInputVal(sk.en_erken),
                  en_gec: saatInputVal(sk.en_gec),
                };
              }),
            );
          }
        })
        .catch(() => {
          if (!cancel) setDurumSatirlar([]);
        }),
    ]).finally(() => {
      if (!cancel) setGunlukYukleniyor(false);
    });
    return () => {
      cancel = true;
    };
  }, [tab, gunlukPid]);

  useEffect(() => {
    setHatKaynakSel('');
    setHatHedefSel('');
  }, [subeKisitPid]);

  const setSubeCfgVal = (sid, field, val) =>
    setSubeCfg((prev) => ({
      ...prev,
      [sid]: { ...(prev[sid] || VARSAYILAN_SUBE), [field]: val },
    }));

  const setKisitVal = (pid, field, val) =>
    setKisitlar((prev) => ({
      ...prev,
      [pid]: { ...(prev[pid] || VARSAYILAN_KISIT), [field]: val },
    }));

  const setKisitSubeYasaklari = (pid, updater) => {
    setKisitlar((prev) => {
      const base = { ...(prev[pid] || VARSAYILAN_KISIT) };
      const cur = Array.isArray(base.sube_yasaklari) ? base.sube_yasaklari : [];
      const next = typeof updater === 'function' ? updater(cur) : updater;
      return { ...prev, [pid]: { ...base, sube_yasaklari: next } };
    });
  };

  function toggleSubeIzin(pid, sid, checked) {
    const k = kisitlar[pid] || VARSAYILAN_KISIT;
    const set = new Set(parseIzinliSubeCsv(k.izinli_sube_ids));
    if (checked) set.add(sid);
    else set.delete(sid);
    if (set.size === 0) {
      toast(
        'En az bir şube seçili olmalı. Tüm şubeler için üstte “tüm şubeler” seçeneğini kullanın.',
        'red',
      );
      return;
    }
    setKisitVal(pid, 'izinli_sube_ids', [...set].join(','));
  }

  function setIzinliTumu(pid) {
    setKisitVal(pid, 'izinli_sube_ids', '');
  }

  function setIzinliSeciliBaslat(pid) {
    if (!subeler.length) return;
    setKisitVal(pid, 'izinli_sube_ids', subeler.map((s) => s.id).join(','));
  }

  function addKaydirmaHat(pid, kaynakId, hedefId) {
    if (!kaynakId || !hedefId || kaynakId === hedefId) return;
    const k = kisitlar[pid] || VARSAYILAN_KISIT;
    const parts = (k.kaydirma_izin_ciftleri || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const tok = `${kaynakId}>${hedefId}`;
    if (!parts.includes(tok)) parts.push(tok);
    setKisitVal(pid, 'kaydirma_izin_ciftleri', parts.join(','));
  }

  function removeKaydirmaHat(pid, rawToken) {
    const k = kisitlar[pid] || VARSAYILAN_KISIT;
    const parts = (k.kaydirma_izin_ciftleri || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    setKisitVal(
      pid,
      'kaydirma_izin_ciftleri',
      parts.filter((p) => p !== rawToken).join(','),
    );
  }

  async function subeKisitFormKaydet() {
    if (!subeKisitPid) {
      toast('Önce personel seçin', 'red');
      return;
    }
    const k = kisitlar[subeKisitPid] || VARSAYILAN_KISIT;
    const izinliStr = (k.izinli_sube_ids || '').trim();
    const ids = parseIzinliSubeCsv(izinliStr);
    if (izinliStr !== '' && ids.length === 0) {
      toast('Geçersiz şube seçimi', 'red');
      return;
    }
    if ((k.kaydirma_izin_ciftleri || '').trim() && !k.sube_degistirebilir) {
      toast('Kaydırma hattı tanımlıysa “başka şubede çalışabilir” işaretli olmalı', 'red');
      return;
    }
    await kisitKaydet(subeKisitPid);
  }

  async function personelVardiyaDahilToggle(pid, checked) {
    const prev = pcVardiyaDahil[pid] !== false;
    setPcVardiyaDahil((m) => ({ ...m, [pid]: checked }));
    try {
      await api(`/personel-config/${pid}`, {
        method: 'PUT',
        body: { vardiyaya_dahil: checked },
      });
      toast('Vardiya havuzu güncellendi');
    } catch (e) {
      toast(e.message, 'red');
      setPcVardiyaDahil((m) => ({ ...m, [pid]: prev }));
    }
  }

  async function subeKaydet(sid) {
    setKayitLoading((l) => ({ ...l, [sid]: true }));
    try {
      const cfg = subeCfg[sid] || VARSAYILAN_SUBE;
      await api(`/sube-config/${sid}`, { method: 'PUT', body: cfg });
      toast('Şube kuralları kaydedildi');
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setKayitLoading((l) => ({ ...l, [sid]: false }));
    }
  }

  async function kisitKaydet(pid) {
    setKayitLoading((l) => ({ ...l, [pid]: true }));
    try {
      const k = { ...(kisitlar[pid] || VARSAYILAN_KISIT) };
      await api(`/personel-kisit/${pid}`, {
        method: 'PUT',
        body: {
          vardiya_yetkisi: {
            acilis: !!k.acilis_yapabilir,
            ara: !!k.ara_yapabilir,
            kapanis: !!k.kapanis_yapabilir,
          },
          acilis_yapabilir: !!k.acilis_yapabilir,
          ara_yapabilir: !!k.ara_yapabilir,
          kapanis_yapabilir: !!k.kapanis_yapabilir,
          sadece_tip: k.sadece_tip || null,
          sube_degistirebilir: !!k.sube_degistirebilir,
          kapanis_bit_saat: k.kapanis_bit_saat || null,
          calisma_profili: k.calisma_profili || null,
          hafta_max_gun:
            k.hafta_max_gun === '' || k.hafta_max_gun == null
              ? null
              : (() => {
                  const n = parseInt(k.hafta_max_gun, 10);
                  return Number.isFinite(n) ? n : null;
                })(),
          gunluk_max_saat:
            k.gunluk_max_saat === '' || k.gunluk_max_saat == null
              ? null
              : (() => {
                  const n = parseFloat(k.gunluk_max_saat);
                  return Number.isFinite(n) ? n : null;
                })(),
          haftalik_max_saat:
            k.haftalik_max_saat === '' || k.haftalik_max_saat == null
              ? null
              : (() => {
                  const n = parseFloat(k.haftalik_max_saat);
                  return Number.isFinite(n) ? n : null;
                })(),
          min_baslangic_saat: k.min_baslangic_saat || null,
          max_cikis_saat: k.max_cikis_saat || null,
          izinli_sube_ids: k.izinli_sube_ids || null,
          kaydirma_izin_ciftleri: !k.sube_degistirebilir
            ? null
            : k.kaydirma_izin_ciftleri && String(k.kaydirma_izin_ciftleri).trim()
              ? String(k.kaydirma_izin_ciftleri).trim()
              : null,
          part_gunluk_min_saat:
            k.part_gunluk_min_saat === '' || k.part_gunluk_min_saat == null
              ? null
              : (() => {
                  const n = parseFloat(k.part_gunluk_min_saat);
                  return Number.isFinite(n) ? n : null;
                })(),
          part_gunluk_max_saat:
            k.part_gunluk_max_saat === '' || k.part_gunluk_max_saat == null
              ? null
              : (() => {
                  const n = parseFloat(k.part_gunluk_max_saat);
                  return Number.isFinite(n) ? n : null;
                })(),
          gunluk_mesai_fazlasi_saat:
            k.gunluk_mesai_fazlasi_saat === '' || k.gunluk_mesai_fazlasi_saat == null
              ? null
              : (() => {
                  const n = parseFloat(k.gunluk_mesai_fazlasi_saat);
                  return Number.isFinite(n) ? n : null;
                })(),
          sube_yasaklari: subeYasaklariToApiPayload(k.sube_yasaklari),
        },
      });
      toast('Personel kısıtı kaydedildi');
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setKayitLoading((l) => ({ ...l, [pid]: false }));
    }
  }

  function setGunlukSatir(hg, field, val) {
    setGunlukSatirlar((prev) =>
      prev.map((row) => (row.hafta_gunu === hg ? { ...row, [field]: val } : row)),
    );
  }

  async function gunlukKaydet() {
    if (!gunlukPid) {
      toast('Önce personel seçin', 'red');
      return;
    }
    setGunlukKaydediliyor(true);
    try {
      const satirlar = gunlukSatirlar.map((r) => ({
        hafta_gunu: r.hafta_gunu,
        calisabilir: !!r.calisabilir,
        sadece_tip: r.sadece_tip || null,
        min_baslangic: r.min_baslangic || null,
        max_cikis: r.max_cikis || null,
        max_saat:
          r.max_saat === '' || r.max_saat == null
            ? null
            : (() => {
                const n = parseFloat(r.max_saat);
                return Number.isFinite(n) ? n : null;
              })(),
      }));
      await api(`/personel-gunluk-kisit/${gunlukPid}`, {
        method: 'PUT',
        body: { satirlar },
      });
      toast('Günlük kısıtlar kaydedildi');
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setGunlukKaydediliyor(false);
    }
  }

  function setDurumSatirIx(i, patch) {
    setDurumSatirlar((rows) =>
      rows.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    );
  }

  async function gunlukDurumKaydet() {
    if (!gunlukPid) {
      toast('Önce personel seçin', 'red');
      return;
    }
    setDurumKaydediliyor(true);
    try {
      const gunluk_durumlar = durumSatirlar
        .filter((r) => r.tarih && String(r.tarih).trim())
        .map((r) => {
          const t = String(r.tarih).slice(0, 10);
          const tu = r.tur === 'tam' || r.tur === 'part' ? r.tur : null;
          const eer = saatInputVal(r.en_erken);
          const ege = saatInputVal(r.en_gec);
          const row = {
            tarih: t,
            calisabilir: !!r.calisabilir,
          };
          if (tu) row.tur = tu;
          const sk = {};
          if (eer) sk.en_erken = eer;
          if (ege) sk.en_gec = ege;
          if (Object.keys(sk).length) row.saat_kisiti = sk;
          return row;
        });
      await api(`/personel-gunluk-durum/${gunlukPid}`, {
        method: 'PUT',
        body: { gunluk_durumlar },
      });
      toast('Günlük durum kaydedildi (liste tamamen değiştirildi)');
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setDurumKaydediliyor(false);
    }
  }

  async function baglantiToggle(kaynak, hedef) {
    const mevcut = baglantilar.find(
      (b) =>
        (b.kaynak_id === kaynak && b.hedef_id === hedef) ||
        (b.kaynak_id === hedef && b.hedef_id === kaynak),
    );
    try {
      if (mevcut) {
        await api(`/sube-baglanti/${mevcut.id}`, { method: 'DELETE' });
        setBaglantilar((b) => b.filter((x) => x.id !== mevcut.id));
      } else {
        await api('/sube-baglanti', {
          method: 'POST',
          body: { kaynak_id: kaynak, hedef_id: hedef, aktif: true },
        });
        const fresh = await api('/sube-baglanti');
        setBaglantilar(fresh);
      }
      toast('Bağlantı güncellendi');
    } catch (e) {
      toast(e.message, 'red');
    }
  }

  const bagliMi = (a, b) =>
    baglantilar.some(
      (x) =>
        (x.kaynak_id === a && x.hedef_id === b) ||
        (x.kaynak_id === b && x.hedef_id === a),
    );

  async function izinEkle(e) {
    e.preventDefault();
    if (!izinForm.personel_id || !izinForm.baslangic_tarih || !izinForm.bitis_tarih) {
      toast('Personel ve tarih aralığı zorunlu', 'red');
      return;
    }
    try {
      await api('/personel-izin', {
        method: 'POST',
        body: {
          personel_id: izinForm.personel_id,
          baslangic_tarih: izinForm.baslangic_tarih,
          bitis_tarih: izinForm.bitis_tarih,
          tip: 'izin',
          aciklama: izinForm.aciklama || null,
        },
      });
      toast('İzin talebi oluşturuldu — onay bekliyor');
      setIzinForm({ personel_id: '', baslangic_tarih: '', bitis_tarih: '', aciklama: '' });
      yukleIzinler();
    } catch (err) {
      toast(err.message, 'red');
    }
  }

  function setPlanGirdiIx(i, patch) {
    setPlanGirdi((rows) =>
      rows.map((row, j) => (j === i ? patchPlanGirdiRow(row, patch) : row)),
    );
  }

  function planOverrideSil(i) {
    setPlanOverrides((rows) => {
      const row = rows[i];
      const next = rows.filter((_, j) => j !== i);
      if (row?.tarih) {
        const t = String(row.tarih).slice(0, 10);
        setPlanOverrideDeletes((d) => (d.includes(t) ? d : [...d, t]));
      }
      return next;
    });
  }

  async function planlamaKaydet() {
    if (!planlamaSid) {
      toast('Şube seçin', 'red');
      return;
    }
    setPlanKaydediliyor(true);
    const fromD = today();
    const toD = tarihPlusGun(fromD, 60);
    try {
      const ovsFromForm = planOverrides
        .filter((o) => o.tarih && String(o.tarih).trim())
        .map((o) => {
          const t = String(o.tarih).slice(0, 10);
          const ac = saatInputVal(o.acilis_saati);
          const kc = saatInputVal(o.kapanis_saati);
          const row = { tarih: t };
          if (ac) row.acilis_saati = ac;
          if (kc) row.kapanis_saati = kc;
          return row;
        });
      const delPayload = planOverrideDeletes.map((t) => ({
        tarih: t,
        acilis_saati: null,
        kapanis_saati: null,
      }));
      await api(`/sube-planlama/${planlamaSid}`, {
        method: 'PUT',
        body: {
          aktif_mi: planAktif,
          acilis_saati: planAcilis || null,
          kapanis_saati: planKapanis || null,
          vardiya_girdileri: planGirdiToPayload(planGirdi),
          gunluk_overrides: [...ovsFromForm, ...delPayload],
        },
      });
      toast('Planlama modeli kaydedildi');
      setPlanOverrideDeletes([]);
      const d = await api(
        `/sube-planlama/${planlamaSid}?from_tarih=${fromD}&to_tarih=${toD}`,
      );
      setPlanAktif(!!d.aktif_mi);
      setPlanAcilis(saatInputVal(planlamaDefaultSaat(d, 'acilis')));
      setPlanKapanis(saatInputVal(planlamaDefaultSaat(d, 'kapanis')));
      setPlanGirdi(apiGirdiToFormPlan(d.vardiya_girdileri));
      setPlanOverrides(
        (d.gunluk_overrides || []).map((o) => ({
          tarih: o.tarih || '',
          acilis_saati: saatInputVal(o.acilis_saati),
          kapanis_saati: saatInputVal(o.kapanis_saati),
        })),
      );
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setPlanKaydediliyor(false);
    }
  }

  async function planlamaYenile() {
    if (!planlamaSid) return;
    setPlanYukleniyor(true);
    const fromD = today();
    const toD = tarihPlusGun(fromD, 60);
    try {
      const d = await api(
        `/sube-planlama/${planlamaSid}?from_tarih=${fromD}&to_tarih=${toD}`,
      );
      setPlanAktif(!!d.aktif_mi);
      setPlanAcilis(saatInputVal(planlamaDefaultSaat(d, 'acilis')));
      setPlanKapanis(saatInputVal(planlamaDefaultSaat(d, 'kapanis')));
      setPlanGirdi(apiGirdiToFormPlan(d.vardiya_girdileri));
      setPlanOverrides(
        (d.gunluk_overrides || []).map((o) => ({
          tarih: o.tarih || '',
          acilis_saati: saatInputVal(o.acilis_saati),
          kapanis_saati: saatInputVal(o.kapanis_saati),
        })),
      );
      setPlanOverrideDeletes([]);
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setPlanYukleniyor(false);
    }
  }

  return (
    <div className="page vardiya-module">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header">
        <h2>Vardiya kuralları</h2>
        <p>
          Her şube için saat aralıklarını ve açılış/kapanışın planda olup olmayacağını seçin.
          Personelde yarı zamanlı günlük min–max saat ve mesai fazlası tavanı motor kotasına girer.
          Haftalık izin günleri <strong>Haftalık gün kısıtı</strong> sekmesinde; onaylı tarihsel izinler{' '}
          <strong>İzinler</strong> sekmesindedir. Hangi şubelerde çalışılabileceği ve kaydırma hatları{' '}
          <strong>Şubeler &amp; kaydırma</strong> sekmesindedir.
        </p>
      </div>

      <div className="tabs" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
        <div
          className={`tab ${tab === 'subeler' ? 'active' : ''}`}
          onClick={() => setTab('subeler')}
          role="presentation"
        >
          Şube kuralları
        </div>
        <div
          className={`tab ${tab === 'plan-model' ? 'active' : ''}`}
          onClick={() => setTab('plan-model')}
          role="presentation"
        >
          Plan modeli
        </div>
        <div
          className={`tab ${tab === 'personel' ? 'active' : ''}`}
          onClick={() => setTab('personel')}
          role="presentation"
        >
          Personel kısıtları
        </div>
        <div
          className={`tab ${tab === 'sube-kaydir' ? 'active' : ''}`}
          onClick={() => setTab('sube-kaydir')}
          role="presentation"
        >
          Şubeler &amp; kaydırma
        </div>
        <div
          className={`tab ${tab === 'gunluk' ? 'active' : ''}`}
          onClick={() => setTab('gunluk')}
          role="presentation"
        >
          Haftalık gün kısıtı
        </div>
        <div
          className={`tab ${tab === 'baglanti' ? 'active' : ''}`}
          onClick={() => setTab('baglanti')}
          role="presentation"
        >
          Şube bağlantıları
        </div>
        <div
          className={`tab ${tab === 'izin' ? 'active' : ''}`}
          onClick={() => setTab('izin')}
          role="presentation"
        >
          İzinler
        </div>
      </div>

      {tab === 'plan-model' && (
        <div
          style={{
            background: 'var(--bg2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
            <strong>Şube aktif</strong> kapalıysa motor bu şubeyi yok sayar. Varsayılan açılış/kapanış saatleri günlük
            kayıt yoksa kullanılır; tarih bazlı kayıt varsa o gün için override geçerlidir.{' '}
            <strong>Kişi sayısı 0</strong> olan vardiya satırı her zaman pasif sayılır (aktif işareti otomatik düşer).
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ marginBottom: 0, minWidth: 200 }}>
              <label>Şube</label>
              <select
                value={planlamaSid}
                onChange={(e) => setPlanlamaSid(e.target.value)}
                disabled={!subeler.length}
              >
                {subeler.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.ad}
                  </option>
                ))}
              </select>
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                checked={planAktif}
                onChange={(e) => setPlanAktif(e.target.checked)}
              />
              Şube aktif (planlamaya dahil)
            </label>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>
                Varsayılan açılış <span className="mono">(acilis_saati)</span>
              </label>
              <input
                type="time"
                value={planAcilis}
                onChange={(e) => setPlanAcilis(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>
                Varsayılan kapanış <span className="mono">(kapanis_saati)</span>
              </label>
              <input
                type="time"
                value={planKapanis}
                onChange={(e) => setPlanKapanis(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn"
              onClick={planlamaYenile}
              disabled={!planlamaSid || planYukleniyor}
            >
              {planYukleniyor ? 'Yükleniyor…' : 'Yenile'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={planlamaKaydet}
              disabled={!planlamaSid || planKaydediliyor || planYukleniyor}
            >
              {planKaydediliyor ? 'Kaydediliyor…' : 'Kaydet'}
            </button>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 14 }}>Vardiya girdileri</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tip</th>
                    <th>Aktif</th>
                    <th>Kişi</th>
                    <th>Personel türü</th>
                    <th>Öncelik</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {planGirdi.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <select
                          value={row.tip}
                          onChange={(e) => setPlanGirdiIx(i, { tip: e.target.value })}
                        >
                          <option value="acilis">Açılış</option>
                          <option value="ara">Ara</option>
                          <option value="kapanis">Kapanış</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.aktif}
                          onChange={(e) => setPlanGirdiIx(i, { aktif: e.target.checked })}
                        />
                      </td>
                      <td style={{ width: 88 }}>
                        <input
                          type="number"
                          min={0}
                          max={99}
                          value={row.kisi_sayisi}
                          onChange={(e) =>
                            setPlanGirdiIx(i, { kisi_sayisi: e.target.value })
                          }
                          style={{ width: '100%' }}
                        />
                      </td>
                      <td>
                        <select
                          value={row.personel_turu}
                          onChange={(e) => setPlanGirdiIx(i, { personel_turu: e.target.value })}
                        >
                          <option value="tam">Tam</option>
                          <option value="part">Part</option>
                          <option value="farketmez">Farketmez</option>
                        </select>
                      </td>
                      <td>
                        <select
                          value={row.oncelik}
                          onChange={(e) => setPlanGirdiIx(i, { oncelik: e.target.value })}
                        >
                          <option value="kritik">Kritik</option>
                          <option value="normal">Normal</option>
                          <option value="dusuk">Düşük</option>
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setPlanGirdi((rows) => rows.filter((_, j) => j !== i))
                          }
                        >
                          Sil
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 10 }}
              onClick={() =>
                setPlanGirdi((r) => [
                  ...r,
                  {
                    tip: 'ara',
                    aktif: true,
                    kisi_sayisi: 1,
                    personel_turu: 'farketmez',
                    oncelik: 'normal',
                  },
                ])
              }
            >
              Satır ekle
            </button>
          </div>

          <div>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 14 }}>
              Günlük saat override (60 gün)
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Açılış</th>
                    <th>Kapanış</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {planOverrides.map((row, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="date"
                          value={String(row.tarih || '').slice(0, 10)}
                          onChange={(e) =>
                            setPlanOverrides((rows) =>
                              rows.map((x, j) =>
                                j === i ? { ...x, tarih: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          value={row.acilis_saati || ''}
                          onChange={(e) =>
                            setPlanOverrides((rows) =>
                              rows.map((x, j) =>
                                j === i ? { ...x, acilis_saati: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          value={row.kapanis_saati || ''}
                          onChange={(e) =>
                            setPlanOverrides((rows) =>
                              rows.map((x, j) =>
                                j === i ? { ...x, kapanis_saati: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => planOverrideSil(i)}
                        >
                          Sil
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {planOverrides.length === 0 && (
                <p style={{ padding: 12, color: 'var(--text3)', fontSize: 13, margin: 0 }}>
                  Kayıt yok. Boş bırakılan günlerde varsayılan saatler kullanılır.
                </p>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginTop: 10 }}
              onClick={() =>
                setPlanOverrides((r) => [
                  ...r,
                  { tarih: '', acilis_saati: '', kapanis_saati: '' },
                ])
              }
            >
              Günlük satır ekle
            </button>
          </div>
        </div>
      )}

      {tab === 'subeler' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {subeler.map((s) => {
            const cfg = { ...VARSAYILAN_SUBE, ...(subeCfg[s.id] || {}) };
            return (
              <div
                key={s.id}
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '18px 20px',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>{s.ad}</div>
                <div
                  style={{
                    marginBottom: 14,
                    padding: '12px 14px',
                    background: 'var(--bg3)',
                    borderRadius: 8,
                    border: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                    Bu şubeyi otomatik vardiya planına ekleyelim mi?
                  </div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: 'var(--text)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!cfg.vardiyaya_dahil}
                      onChange={(e) => setSubeCfgVal(s.id, 'vardiyaya_dahil', e.target.checked)}
                    />
                    Evet, bu şube otomatik planda yer alsın (işareti kaldırırsanız motor bu şubeyi tamamen
                    atlar)
                  </label>
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
                    gap: 10,
                  }}
                >
                  {SUBE_KURAL_SATIRLARI.map((k) => (
                    <label
                      key={k.field}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        background: 'var(--bg3)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        cursor: k.tip === 'bool' ? 'pointer' : 'default',
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text2)' }}>{k.label}</span>
                      {k.tip === 'bool' ? (
                        <input
                          type="checkbox"
                          checked={!!cfg[k.field]}
                          onChange={(e) => setSubeCfgVal(s.id, k.field, e.target.checked)}
                        />
                      ) : (
                        <input
                          type="number"
                          min={k.min}
                          max={k.max}
                          value={cfg[k.field] ?? k.min}
                          onChange={(e) =>
                            setSubeCfgVal(s.id, k.field, parseInt(e.target.value, 10) || k.min)
                          }
                          style={{
                            width: 50,
                            textAlign: 'center',
                            padding: '4px 6px',
                            borderRadius: 4,
                            border: '1px solid var(--border)',
                            background: 'var(--bg2)',
                            color: 'var(--text)',
                          }}
                        />
                      )}
                    </label>
                  ))}
                </div>
                <div style={{ marginTop: 16 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      marginBottom: 10,
                      color: 'var(--text2)',
                    }}
                  >
                    Bu şubenin vardiya saatleri (motor buna göre yazar)
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {SUBE_VARDIYA_SAAT.map((row) => (
                      <div
                        key={row.tip}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 10px',
                          background: 'var(--bg3)',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                        }}
                      >
                        <span style={{ minWidth: 140, fontSize: 12 }}>{row.label}</span>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          Başlangıç
                          <input
                            type="time"
                            value={cfg[row.bas] || ''}
                            onChange={(e) => setSubeCfgVal(s.id, row.bas, e.target.value)}
                            style={{
                              marginLeft: 6,
                              padding: '4px 8px',
                              borderRadius: 6,
                              border: '1px solid var(--border)',
                              background: 'var(--bg2)',
                              color: 'var(--text)',
                            }}
                          />
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          Bitiş
                          <input
                            type="time"
                            value={cfg[row.bit] || ''}
                            onChange={(e) => setSubeCfgVal(s.id, row.bit, e.target.value)}
                            style={{
                              marginLeft: 6,
                              padding: '4px 8px',
                              borderRadius: 6,
                              border: '1px solid var(--border)',
                              background: 'var(--bg2)',
                              color: 'var(--text)',
                            }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>
                    Boş alanlar: varsayılan 09:00–13:00 / 13:00–17:00 / 17:00–21:00
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 14 }}
                  disabled={kayitLoading[s.id]}
                  onClick={() => subeKaydet(s.id)}
                >
                  {kayitLoading[s.id] ? 'Kaydediliyor…' : 'Kaydet'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'personel' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {personeller.map((p) => {
            const k = { ...VARSAYILAN_KISIT, ...(kisitlar[p.id] || {}) };
            return (
              <div
                key={p.id}
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '14px 18px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 160 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{p.ad_soyad}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{p.gorev || '—'}</div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginTop: 8,
                      fontSize: 11,
                      color: 'var(--text2)',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={pcVardiyaDahil[p.id] !== false}
                      onChange={(e) => personelVardiyaDahilToggle(p.id, e.target.checked)}
                    />
                    Otomatik vardiya planına dahil
                  </label>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1, alignItems: 'center' }}>
                  <div
                    style={{
                      flexBasis: '100%',
                      fontWeight: 700,
                      fontSize: 12,
                      color: 'var(--text2)',
                      marginBottom: 2,
                    }}
                  >
                    Vardiya yetkisi{' '}
                    <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 11 }}>
                      (kontrat:{' '}
                      <span className="mono">
                        {'{'} acilis, ara, kapanis {'}'}
                      </span>
                      )
                    </span>
                  </div>
                  {VARDIYA_YETKISI_KEYS.map((x) => (
                    <label
                      key={x.state}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 10px',
                        background: k[x.state] ? 'rgba(76,175,132,0.1)' : 'var(--bg3)',
                        border: `1px solid ${k[x.state] ? 'var(--green)' : 'var(--border)'}`,
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 12,
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!k[x.state]}
                        onChange={(e) => setKisitVal(p.id, x.state, e.target.checked)}
                      />
                      <span className="mono" style={{ fontSize: 11 }}>
                        {x.kontrat}
                      </span>
                      <span style={{ color: 'var(--text3)' }}>·</span>
                      <span>{x.label}</span>
                    </label>
                  ))}

                  <select
                    value={k.sadece_tip || ''}
                    onChange={(e) => setKisitVal(p.id, 'sadece_tip', e.target.value)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  >
                    <option value="">Tüm tipler</option>
                    <option value="ACILIS">Sadece ACILIS</option>
                    <option value="ARA">Sadece ARA</option>
                    <option value="KAPANIS">Sadece KAPANIS</option>
                  </select>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--text2)',
                    }}
                  >
                    Kapanış bitiş (erken çıkış)
                    <input
                      type="time"
                      value={k.kapanis_bit_saat || ''}
                      onChange={(e) => setKisitVal(p.id, 'kapanis_bit_saat', e.target.value)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--bg2)',
                        color: 'var(--text)',
                      }}
                    />
                  </label>

                  <select
                    value={k.calisma_profili || ''}
                    onChange={(e) => setKisitVal(p.id, 'calisma_profili', e.target.value)}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  >
                    <option value="">Çalışma profili (yok)</option>
                    <option value="full_time">Tam zamanlı</option>
                    <option value="part_time">Yarı zamanlı (varsayılan haftalık 45 saat)</option>
                    <option value="ogrenci">Öğrenci (varsayılan 30 saat / 4 gün)</option>
                  </select>

                  <input
                    type="number"
                    min={1}
                    max={7}
                    placeholder="Hafta max gün"
                    title="Haftada en fazla kaç gün"
                    value={k.hafta_max_gun}
                    onChange={(e) => setKisitVal(p.id, 'hafta_max_gun', e.target.value)}
                    style={{
                      width: 110,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  />
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    placeholder="Günlük max saat"
                    value={k.gunluk_max_saat}
                    onChange={(e) => setKisitVal(p.id, 'gunluk_max_saat', e.target.value)}
                    style={{
                      width: 120,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  />
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    placeholder="Haftalık max saat"
                    value={k.haftalik_max_saat}
                    onChange={(e) => setKisitVal(p.id, 'haftalik_max_saat', e.target.value)}
                    style={{
                      width: 120,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  />
                  <div
                    style={{
                      width: '100%',
                      flexBasis: '100%',
                      marginTop: 4,
                      padding: '8px 10px',
                      background: 'var(--bg3)',
                      borderRadius: 8,
                      border: '1px dashed var(--border)',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--text2)' }}>
                      Part / yarı zamanlı günlük hedef (personel kartı sürekli değilse veya profil part ise
                      motor uygular)
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <input
                        type="number"
                        step="0.5"
                        min={0}
                        placeholder="Günlük min saat (hedef)"
                        title="Çalıştığı günlerde en az bu kadar süre atanması beklenir; altında kalırsa motor uyarı yazar"
                        value={k.part_gunluk_min_saat}
                        onChange={(e) => setKisitVal(p.id, 'part_gunluk_min_saat', e.target.value)}
                        style={{
                          width: 148,
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                          background: 'var(--bg2)',
                          color: 'var(--text)',
                          fontSize: 12,
                        }}
                      />
                      <input
                        type="number"
                        step="0.5"
                        min={0}
                        placeholder="Part günlük max saat"
                        title="Günlük üst sınırı daraltır (boşsa sadece günlük max saat geçer)"
                        value={k.part_gunluk_max_saat}
                        onChange={(e) => setKisitVal(p.id, 'part_gunluk_max_saat', e.target.value)}
                        style={{
                          width: 148,
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                          background: 'var(--bg2)',
                          color: 'var(--text)',
                          fontSize: 12,
                        }}
                      />
                      <input
                        type="number"
                        step="0.5"
                        min={0}
                        placeholder="Mesai fazlası (+saat)"
                        title="Zorunlu hallerde günlük tavana eklenecek ekstra saat"
                        value={k.gunluk_mesai_fazlasi_saat}
                        onChange={(e) =>
                          setKisitVal(p.id, 'gunluk_mesai_fazlasi_saat', e.target.value)
                        }
                        style={{
                          width: 148,
                          padding: '6px 8px',
                          borderRadius: 6,
                          border: '1px solid var(--border)',
                          background: 'var(--bg2)',
                          color: 'var(--text)',
                          fontSize: 12,
                        }}
                      />
                    </div>
                  </div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      color: 'var(--text3)',
                    }}
                  >
                    Min başlangıç
                    <input
                      type="time"
                      value={k.min_baslangic_saat || ''}
                      onChange={(e) =>
                        setKisitVal(p.id, 'min_baslangic_saat', e.target.value)
                      }
                      style={{
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--bg2)',
                        color: 'var(--text)',
                      }}
                    />
                  </label>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      color: 'var(--text3)',
                    }}
                  >
                    Max çıkış
                    <input
                      type="time"
                      value={k.max_cikis_saat || ''}
                      onChange={(e) => setKisitVal(p.id, 'max_cikis_saat', e.target.value)}
                      style={{
                        padding: '4px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        background: 'var(--bg2)',
                        color: 'var(--text)',
                      }}
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={kayitLoading[p.id]}
                  onClick={() => kisitKaydet(p.id)}
                >
                  {kayitLoading[p.id] ? '…' : 'Kaydet'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'sube-kaydir' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>
            Gidebilecek şubeleri tikleyin; yalnızca bir şube işaretliyse motor o personeli yalnızca o
            şubede kullanır. Kaydırma kapalıysa yalnızca ana (kart) şubesinde atanır. Kaydırma açıkken
            hat listesi <strong>boş</strong> ise işaretli şubelerin tamamına atanabilir; hat
            <strong> dolu</strong> ise yalnızca kaynak → hedef yönünde kaydırma serbesttir (ters yön
            için ayrı satır ekleyin).
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 13 }}>
              Personel
              <select
                value={subeKisitPid}
                onChange={(e) => setSubeKisitPid(e.target.value)}
                style={{
                  marginLeft: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg2)',
                  color: 'var(--text)',
                  minWidth: 220,
                }}
              >
                <option value="">— Seçin —</option>
                {personeller.map((per) => (
                  <option key={per.id} value={per.id}>
                    {per.ad_soyad}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!subeKisitPid || kayitLoading[subeKisitPid]}
              onClick={() => subeKisitFormKaydet()}
            >
              {kayitLoading[subeKisitPid] ? 'Kaydediliyor…' : 'Şube & kaydırma kaydet'}
            </button>
          </div>

          {subeKisitPid && (() => {
            const k = { ...VARSAYILAN_KISIT, ...(kisitlar[subeKisitPid] || {}) };
            const izinliTumu = !(k.izinli_sube_ids || '').trim();
            const izinSet = new Set(parseIzinliSubeCsv(k.izinli_sube_ids));
            const hatParcalari = (k.kaydirma_izin_ciftleri || '')
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
              .map((raw) => {
                const [a, b] = raw.split('>').map((x) => x.trim());
                return { a, b, raw };
              })
              .filter((x) => x.a && x.b);
            const subeAd = (id) => subeler.find((s) => s.id === id)?.ad || id;

            return (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '18px 20px',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                    Gidebileceği şubeler
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`izinli-mod-${subeKisitPid}`}
                        checked={izinliTumu}
                        onChange={() => setIzinliTumu(subeKisitPid)}
                      />
                      <span style={{ fontSize: 13 }}>Tüm şubeler (kısıt yok)</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`izinli-mod-${subeKisitPid}`}
                        checked={!izinliTumu}
                        onChange={() => setIzinliSeciliBaslat(subeKisitPid)}
                      />
                      <span style={{ fontSize: 13 }}>Yalnızca aşağıda işaretli şubeler</span>
                    </label>
                  </div>
                  {!izinliTumu && (
                    <div
                      style={{
                        marginTop: 12,
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                        gap: 8,
                      }}
                    >
                      {subeler.map((s) => (
                        <label
                          key={s.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            background: 'var(--bg3)',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={izinSet.has(s.id)}
                            onChange={(e) => toggleSubeIzin(subeKisitPid, s.id, e.target.checked)}
                          />
                          {s.ad}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 16,
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Şube yasakları</div>
                  <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.45 }}>
                    Kontrat:{' '}
                    <span className="mono">
                      {'{'} branch_id, yasak {'}'}
                    </span>
                    . <strong>Kayıt yok = o şube için serbest</strong>; yalnızca listede ve yasak işaretli
                    şubeler plana atanmaz (beyaz liste ile birlikte her iki kural da uygulanır).
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(Array.isArray(k.sube_yasaklari) ? k.sube_yasaklari : []).map((row, yi) => (
                      <div
                        key={yi}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <select
                          value={row.sube_id || ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setKisitSubeYasaklari(subeKisitPid, (rows) =>
                              rows.map((r, j) => (j === yi ? { ...r, sube_id: v } : r)),
                            );
                          }}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            background: 'var(--bg3)',
                            color: 'var(--text)',
                            fontSize: 12,
                            minWidth: 200,
                          }}
                        >
                          <option value="">Şube seçin</option>
                          {subeler.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.ad}
                            </option>
                          ))}
                        </select>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={row.yasak !== false}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setKisitSubeYasaklari(subeKisitPid, (rows) =>
                                rows.map((r, j) => (j === yi ? { ...r, yasak: on } : r)),
                              );
                            }}
                          />
                          <span className="mono">yasak</span>
                        </label>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            setKisitSubeYasaklari(subeKisitPid, (rows) =>
                              rows.filter((_, j) => j !== yi),
                            )
                          }
                        >
                          Sil
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() =>
                        setKisitSubeYasaklari(subeKisitPid, (rows) => [
                          ...rows,
                          { sube_id: subeler[0]?.id || '', yasak: true },
                        ])
                      }
                    >
                      Yasak satırı ekle
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Kaydırma</div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 12,
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!k.sube_degistirebilir}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setKisitVal(subeKisitPid, 'sube_degistirebilir', on);
                        if (!on) setKisitVal(subeKisitPid, 'kaydirma_izin_ciftleri', '');
                      }}
                    />
                    Ana şubesi dışında başka şubede çalışabilir (kaydırma)
                  </label>

                  {k.sube_degistirebilir && (
                    <>
                      <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
                        Hat listesi boş: izinli şubeler arasında serbest. Dolu: yalnızca seçilen
                        kaynak→hedef çiftleri (A→B ile B→A aynı değildir).
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <select
                          value={hatKaynakSel}
                          onChange={(e) => setHatKaynakSel(e.target.value)}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            background: 'var(--bg3)',
                            color: 'var(--text)',
                            fontSize: 12,
                          }}
                        >
                          <option value="">Kaynak şube</option>
                          {subeler.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.ad}
                            </option>
                          ))}
                        </select>
                        <span style={{ color: 'var(--text3)' }}>→</span>
                        <select
                          value={hatHedefSel}
                          onChange={(e) => setHatHedefSel(e.target.value)}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 6,
                            border: '1px solid var(--border)',
                            background: 'var(--bg3)',
                            color: 'var(--text)',
                            fontSize: 12,
                          }}
                        >
                          <option value="">Hedef şube</option>
                          {subeler.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.ad}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            addKaydirmaHat(subeKisitPid, hatKaynakSel, hatHedefSel);
                            setHatKaynakSel('');
                            setHatHedefSel('');
                          }}
                        >
                          Hat ekle
                        </button>
                      </div>
                      {baglantilar.filter((b) => b.aktif !== false).length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                            Şube bağlantılarından hızlı ekle:{' '}
                          </span>
                          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                            {baglantilar
                              .filter((b) => b.aktif !== false)
                              .map((b) => (
                                <button
                                  key={b.id}
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  style={{ fontSize: 11 }}
                                  onClick={() =>
                                    addKaydirmaHat(subeKisitPid, b.kaynak_id, b.hedef_id)
                                  }
                                >
                                  {b.kaynak_adi || b.kaynak_id} → {b.hedef_adi || b.hedef_id}
                                </button>
                              ))}
                          </span>
                        </div>
                      )}
                      <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 12 }}>
                        {hatParcalari.length === 0 && (
                          <li style={{ color: 'var(--text3)' }}>Tanımlı hat yok (tüm izinli şubelere serbest)</li>
                        )}
                        {hatParcalari.map((h) => (
                          <li key={h.raw} style={{ marginBottom: 4 }}>
                            {subeAd(h.a)} → {subeAd(h.b)}
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
                              onClick={() => removeKaydirmaHat(subeKisitPid, h.raw)}
                            >
                              Kaldır
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === 'gunluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>
            <strong>Haftalık şablon</strong> (hafta günü başına): çalışılabilirlik, sadece tip, min
            başlangıç / max çıkış, max saat — genel kısıtla birleşir.{' '}
            <strong>Günlük durum</strong> (takvim tarihi): o güne özel çalışabilir ve tam/part
            override; kayıt yoksa şablon + personel kartı geçerlidir. Kayıt kaydedince liste sunucuda
            tamamen değişir (silinen tarihler override kalkar).
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 13 }}>
              Personel
              <select
                value={gunlukPid}
                onChange={(e) => setGunlukPid(e.target.value)}
                style={{
                  marginLeft: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg2)',
                  color: 'var(--text)',
                  minWidth: 200,
                }}
              >
                <option value="">— Seçin —</option>
                {personeller.map((per) => (
                  <option key={per.id} value={per.id}>
                    {per.ad_soyad}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!gunlukPid || gunlukKaydediliyor || gunlukYukleniyor}
              onClick={() => gunlukKaydet()}
            >
              {gunlukKaydediliyor ? 'Kaydediliyor…' : 'Gün kısıtlarını kaydet'}
            </button>
            {gunlukYukleniyor && (
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>Yükleniyor…</span>
            )}
          </div>
          {gunlukPid && (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ minWidth: 720, fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Gün</th>
                    <th>Çalışabilir</th>
                    <th>Sadece tip</th>
                    <th>Min başlangıç</th>
                    <th>Max çıkış</th>
                    <th>Max saat</th>
                  </tr>
                </thead>
                <tbody>
                  {gunlukSatirlar.map((r) => (
                    <tr key={r.hafta_gunu}>
                      <td>{HAFTA_GUNU_ADLARI[r.hafta_gunu]}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!r.calisabilir}
                          onChange={(e) =>
                            setGunlukSatir(r.hafta_gunu, 'calisabilir', e.target.checked)
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={r.sadece_tip || ''}
                          onChange={(e) =>
                            setGunlukSatir(r.hafta_gunu, 'sadece_tip', e.target.value)
                          }
                          style={{ padding: 4, fontSize: 12 }}
                        >
                          <option value="">—</option>
                          <option value="ACILIS">ACILIS</option>
                          <option value="ARA">ARA</option>
                          <option value="KAPANIS">KAPANIS</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="time"
                          value={r.min_baslangic || ''}
                          onChange={(e) =>
                            setGunlukSatir(r.hafta_gunu, 'min_baslangic', e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          value={r.max_cikis || ''}
                          onChange={(e) =>
                            setGunlukSatir(r.hafta_gunu, 'max_cikis', e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.5"
                          min={0}
                          placeholder="—"
                          value={r.max_saat}
                          onChange={(e) =>
                            setGunlukSatir(r.hafta_gunu, 'max_saat', e.target.value)
                          }
                          style={{ width: 72 }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {gunlukPid && (
            <div
              style={{
                marginTop: 8,
                paddingTop: 20,
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>Günlük durum (tarih bazlı)</div>
              <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0, lineHeight: 1.5 }}>
                Her satır: <span className="mono">tarih</span>, çalışabilir, tür; isteğe bağlı{' '}
                <span className="mono">saat_kisiti: {'{'} en_erken, en_gec {'}'}</span>. Boş saat =
                o uçta günlük override yok. Dolu saat, haftalık gün şablonu ve personel kartındaki
                min/max ile kesişir (başlangıç için daha geç, çıkış için daha erken kazanır). Tür
                boşsa kart + şablon geçerli kalır.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setDurumSatirlar((r) => [
                      ...r,
                      { tarih: today(), calisabilir: true, tur: '', en_erken: '', en_gec: '' },
                    ])
                  }
                >
                  Tarih satırı ekle
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={durumKaydediliyor || gunlukYukleniyor}
                  onClick={() => gunlukDurumKaydet()}
                >
                  {durumKaydediliyor ? 'Kaydediliyor…' : 'Günlük durumu kaydet'}
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ minWidth: 720, fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Tarih</th>
                      <th>Çalışabilir</th>
                      <th>Tür</th>
                      <th title="Boş = bu uçta ek saat kısıtı yok">En erken</th>
                      <th title="Boş = bu uçta ek saat kısıtı yok">En geç çıkış</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {durumSatirlar.map((r, i) => (
                      <tr key={`${r.tarih}-${i}`}>
                        <td>
                          <input
                            type="date"
                            value={String(r.tarih || '').slice(0, 10)}
                            onChange={(e) => setDurumSatirIx(i, { tarih: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={!!r.calisabilir}
                            onChange={(e) =>
                              setDurumSatirIx(i, { calisabilir: e.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={r.tur === 'tam' || r.tur === 'part' ? r.tur : ''}
                            onChange={(e) => setDurumSatirIx(i, { tur: e.target.value })}
                            style={{ padding: 4, fontSize: 12 }}
                          >
                            <option value="">(şablona bırak)</option>
                            <option value="tam">tam</option>
                            <option value="part">part</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="time"
                            value={r.en_erken || ''}
                            onChange={(e) => setDurumSatirIx(i, { en_erken: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="time"
                            value={r.en_gec || ''}
                            onChange={(e) => setDurumSatirIx(i, { en_gec: e.target.value })}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() =>
                              setDurumSatirlar((rows) => rows.filter((_, j) => j !== i))
                            }
                          >
                            Sil
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {durumSatirlar.length > 0 && (
                  <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text3)' }}>
                    Boş saat alanı = o uç için kısıt yok. Tür &quot;şablona bırak&quot; = tür override
                    yok.
                  </p>
                )}
                {durumSatirlar.length === 0 && (
                  <p style={{ padding: 12, color: 'var(--text3)', fontSize: 12, margin: 0 }}>
                    Bu aralıkta kayıt yok. Kayıt eklemeden bırakırsanız motor şablonu kullanır.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'baglanti' && (
        <div>
          <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
            Sadece işaretli şube çiftleri arasında kapanış eksikliğinde personel kaydırması
            yapılır.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {subeler.map((a, i) =>
              subeler.slice(i + 1).map((b) => {
                const bagli = bagliMi(a.id, b.id);
                return (
                  <label
                    key={`${a.id}-${b.id}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      padding: '12px 16px',
                      background: bagli ? 'rgba(76,175,132,0.08)' : 'var(--bg2)',
                      border: `1px solid ${bagli ? 'var(--green)' : 'var(--border)'}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                      maxWidth: 480,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={bagli}
                      onChange={() => baglantiToggle(a.id, b.id)}
                    />
                    <span style={{ fontSize: 13 }}>
                      <strong>{a.ad}</strong>
                      <span style={{ color: 'var(--text3)', margin: '0 8px' }}>↔</span>
                      <strong>{b.ad}</strong>
                    </span>
                  </label>
                );
              }),
            )}
          </div>
        </div>
      )}

      {tab === 'izin' && (
        <div>
          <form
            onSubmit={izinEkle}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
              gap: 12,
              marginBottom: 24,
              padding: 16,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Personel</label>
              <select
                value={izinForm.personel_id}
                onChange={(e) => setIzinForm((f) => ({ ...f, personel_id: e.target.value }))}
              >
                <option value="">Seçin</option>
                {personeller.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.ad_soyad}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Başlangıç</label>
              <input
                type="date"
                value={izinForm.baslangic_tarih}
                onChange={(e) =>
                  setIzinForm((f) => ({ ...f, baslangic_tarih: e.target.value }))
                }
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Bitiş</label>
              <input
                type="date"
                value={izinForm.bitis_tarih}
                onChange={(e) => setIzinForm((f) => ({ ...f, bitis_tarih: e.target.value }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Not</label>
              <input
                type="text"
                value={izinForm.aciklama}
                onChange={(e) => setIzinForm((f) => ({ ...f, aciklama: e.target.value }))}
                placeholder="İsteğe bağlı"
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="submit" className="btn btn-primary">
                Talep oluştur
              </button>
            </div>
          </form>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Personel</th>
                  <th>Başlangıç</th>
                  <th>Bitiş</th>
                  <th>Durum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {izinler.map((iz) => (
                  <tr key={iz.id}>
                    <td>{iz.ad_soyad}</td>
                    <td className="mono">{String(iz.baslangic_tarih).slice(0, 10)}</td>
                    <td className="mono">{String(iz.bitis_tarih).slice(0, 10)}</td>
                    <td>
                      <span className="badge badge-gray">{iz.durum}</span>
                    </td>
                    <td>
                      {iz.durum === 'bekliyor' && (
                        <span style={{ display: 'inline-flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={async () => {
                              try {
                                await api(`/personel-izin/${iz.id}/onayla`, { method: 'POST' });
                                yukleIzinler();
                                toast('İzin onaylandı');
                              } catch (err) {
                                toast(err.message, 'red');
                              }
                            }}
                          >
                            Onayla
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={async () => {
                              try {
                                await api(`/personel-izin/${iz.id}/reddet`, { method: 'POST' });
                                yukleIzinler();
                                toast('Talep reddedildi', 'red');
                              } catch (err) {
                                toast(err.message, 'red');
                              }
                            }}
                          >
                            Reddet
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {izinler.length === 0 && (
              <p style={{ padding: 16, color: 'var(--text3)', fontSize: 13 }}>
                Kayıt yok. Onaylı izinler vardiya motorunda dışlanır.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
