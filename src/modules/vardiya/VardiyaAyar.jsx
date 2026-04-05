import { useState, useEffect } from 'react';
import { api } from '../../utils/api';

const VARSAYILAN_SUBE = {
  min_kapanis: 1,
  tek_kapanis_izinli: true,
  tek_acilis_izinli: true,
  kaydirma_acik: true,
  sadece_tam_kayabilir: false,
  hafta_sonu_min_kap: 1,
  tam_part_zorunlu: false,
  kapanis_dusurulemez: false,
};

const VARSAYILAN_KISIT = {
  acilis_yapabilir: true,
  ara_yapabilir: true,
  kapanis_yapabilir: true,
  sadece_tip: '',
  sube_degistirebilir: true,
  kapanis_bit_saat: '',
};

const SUBE_KURAL_SATIRLARI = [
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
            m[c.sube_id] = { ...VARSAYILAN_SUBE, ...c };
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
  }, []);

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
        },
      });
      toast('Personel kısıtı kaydedildi');
    } catch (e) {
      toast(e.message, 'red');
    } finally {
      setKayitLoading((l) => ({ ...l, [pid]: false }));
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
          Kuralları bir kez tanımlayın; günlük planda motor bu ayarlara uyar. Şart değişince
          sadece tikleri güncelleyin.
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
