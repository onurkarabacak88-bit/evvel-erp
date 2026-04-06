import { useState, useEffect } from 'react';
import { api } from '../../utils/api';

/** API TIME / string → time input HH:MM */
function saatInputVal(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  return s.length >= 5 ? s.slice(0, 5) : s;
}

const VARSAYILAN_SUBE = {
  vardiyaya_dahil: true,
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

const SUBE_KURAL_SATIRLARI = [
  {
    field: 'vardiyaya_dahil',
    label: 'Otomatik vardiya planına dahil (kapalıysa motor bu şubeyi atlar)',
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
  /** personel_id → otomatik vardiya havuzunda mı */
  const [pcVardiyaDahil, setPcVardiyaDahil] = useState({});

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
            m[k.personel_id] = {
              ...VARSAYILAN_KISIT,
              ...k,
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
    if (tab !== 'gunluk' || !gunlukPid) {
      return undefined;
    }
    let cancel = false;
    setGunlukYukleniyor(true);
    api(`/personel-gunluk-kisit/${gunlukPid}`)
      .then((rows) => {
        if (!cancel) setGunlukSatirlar(apiGunlukBirlestir(rows));
      })
      .catch(() => {
        if (!cancel) setGunlukSatirlar(bosGunlukSatirlari());
      })
      .finally(() => {
        if (!cancel) setGunlukYukleniyor(false);
      });
    return () => {
      cancel = true;
    };
  }, [tab, gunlukPid]);

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

  return (
    <div className="page vardiya-module">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}

      <div className="page-header">
        <h2>Vardiya kuralları</h2>
        <p>
          Her şube için vardiya saat aralıklarını (açılış / ara / kapanış) tanımlayın; boş bırakılan
          değerler sistem varsayılanını kullanır. Kurallar ve kaydırma ayarları aynı ekranda.
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
          className={`tab ${tab === 'personel' ? 'active' : ''}`}
          onClick={() => setTab('personel')}
          role="presentation"
        >
          Personel kısıtları
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

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
                  {[
                    { field: 'acilis_yapabilir', label: 'Açılış' },
                    { field: 'ara_yapabilir', label: 'Ara' },
                    { field: 'kapanis_yapabilir', label: 'Kapanış' },
                    { field: 'sube_degistirebilir', label: 'Kaydırılabilir' },
                  ].map((x) => (
                    <label
                      key={x.field}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 10px',
                        background: k[x.field] ? 'rgba(76,175,132,0.1)' : 'var(--bg3)',
                        border: `1px solid ${k[x.field] ? 'var(--green)' : 'var(--border)'}`,
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 12,
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!k[x.field]}
                        onChange={(e) => setKisitVal(p.id, x.field, e.target.checked)}
                      />
                      {x.label}
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
                  <input
                    type="text"
                    placeholder="İzinli şube id (virgülle)"
                    value={k.izinli_sube_ids}
                    onChange={(e) => setKisitVal(p.id, 'izinli_sube_ids', e.target.value)}
                    style={{
                      minWidth: 160,
                      flex: 1,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  />
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

      {tab === 'gunluk' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)' }}>
            Haftanın günü başına: çalışılabilirlik, yalnızca belirli vardiya tipi, o güne özel min
            başlangıç / max çıkış ve günlük max saat. Motor önce genel personel kısıtıyla birleştirir.
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
