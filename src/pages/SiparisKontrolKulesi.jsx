import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';

const ASAMA_STIL = {
  bekliyor: { renk: '#4a9eff', ikon: '🕐', label: 'Merkez kuyruğu' },
  depoda: { renk: '#f59e0b', ikon: '🏭', label: 'Depoda' },
  yolda: { renk: '#3b82f6', ikon: '🚚', label: 'Yolda' },
  uyumsuzluk: { renk: '#ef4444', ikon: '⚠', label: 'Uyumsuzluk' },
  tamamlandi: { renk: '#22c55e', ikon: '✅', label: 'Tamamlandı' },
  iptal: { renk: '#94a3b8', ikon: '✕', label: 'İptal' },
  gonderilmedi: { renk: '#f97316', ikon: '⊘', label: 'Gönderilmedi' },
};

const DURUM_OPS = [
  { id: 'var', label: '✓ Var' },
  { id: 'yok', label: '✗ Yok' },
  { id: 'kismi', label: '~ Kısmi' },
];

const GUN_SEC = [7, 14, 30, 60, 90];

function kisaTs(ts) {
  if (!ts) return '—';
  const s = String(ts);
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

function kalemOzet(kalemler) {
  if (!Array.isArray(kalemler) || !kalemler.length) return '—';
  return kalemler
    .filter((k) => k && Number(k.adet) > 0)
    .slice(0, 4)
    .map((k) => `${k.urun_ad || k.kalem_kodu || '?'} ×${k.adet}`)
    .join(' · ');
}

export default function SiparisKontrolKulesi({ vurgulaTalepId: vurgulaProp = null }) {
  const [vurgulaId, setVurgulaId] = useState(vurgulaProp);

  useEffect(() => {
    if (vurgulaProp) {
      setVurgulaId(vurgulaProp);
      return;
    }
    try {
      const tid = sessionStorage.getItem('ops_siparis_vurgula_talep');
      if (tid) {
        sessionStorage.removeItem('ops_siparis_vurgula_talep');
        setVurgulaId(tid);
      }
      const gv = sessionStorage.getItem('ops_kontrol_kulesi_gorunum');
      const dep = sessionStorage.getItem('ops_kontrol_kulesi_depo');
      if (gv === 'depo') {
        sessionStorage.removeItem('ops_kontrol_kulesi_gorunum');
        setGorunum('depo');
      }
      if (dep) {
        sessionStorage.removeItem('ops_kontrol_kulesi_depo');
        setDepoFiltre(dep);
      }
    } catch (_) {}
  }, [vurgulaProp]);
  const [msg, setMsg] = useState(null);
  const toast = useCallback((m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  }, []);

  const [gorunum, setGorunum] = useState('izleme'); // izleme | depo | urun
  const [gun, setGun] = useState(30);
  const [asamaFiltre, setAsamaFiltre] = useState('');
  const [sadeceAcik, setSadeceAcik] = useState(true);
  const [subeArama, setSubeArama] = useState('');
  const [depoFiltre, setDepoFiltre] = useState('');
  const [talepArama, setTalepArama] = useState('');
  const [yukleniyor, setYukleniyor] = useState(true);
  const [veri, setVeri] = useState(null);
  const [secili, setSecili] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [tlYukleniyor, setTlYukleniyor] = useState(false);

  const [bekleyen, setBekleyen] = useState(null);
  const [depolar, setDepolar] = useState([]);
  const [kuyrukDepo, setKuyrukDepo] = useState({});
  const [kuyrukTalimat, setKuyrukTalimat] = useState({});
  const [kuyrukBusy, setKuyrukBusy] = useState(null);

  const [uyumsuzluklar, setUyumsuzluklar] = useState([]);
  const [urunArama, setUrunArama] = useState('');
  const [urunGecmis, setUrunGecmis] = useState(null);

  // Depo hazırlık
  const [depoListe, setDepoListe] = useState([]);
  const [depoSecili, setDepoSecili] = useState(null);
  const [depoKalem, setDepoKalem] = useState({});
  const [depoNot, setDepoNot] = useState('');
  const [depoBusy, setDepoBusy] = useState(false);
  const [depoDurumFiltre, setDepoDurumFiltre] = useState('hazirlaniyor');

  const yukle = useCallback(async () => {
    setYukleniyor(true);
    try {
      const q = new URLSearchParams({
        gun: String(gun),
        sadece_acik: sadeceAcik ? 'true' : 'false',
        limit: '500',
      });
      if (asamaFiltre) q.set('asama', asamaFiltre);
      if (subeArama.trim()) q.set('sube_arama', subeArama.trim());
      if (depoFiltre) q.set('depo_sube_id', depoFiltre);
      if (talepArama.trim()) q.set('talep_arama', talepArama.trim());

      const [kk, bek, dep, uy] = await Promise.all([
        api(`/ops/siparis/kontrol-kulesi?${q}`),
        api(`/ops/v2/bekleyen-siparisler?gun=${Math.min(30, gun)}`).catch(() => ({ siparisler: [] })),
        api('/ops/subeler/depolar').then((r) => r?.satirlar || []).catch(() => []),
        api(`/ops/siparis/sevkiyat-uyumsuzluklar?gun=${gun}&limit=120`).catch(() => ({ satirlar: [] })),
      ]);
      setVeri(kk);
      setBekleyen(bek);
      setDepolar(Array.isArray(dep) ? dep : []);
      setUyumsuzluklar(Array.isArray(uy?.satirlar) ? uy.satirlar : []);
    } catch (e) {
      toast(e.message || 'Kontrol kulesi yüklenemedi', 'red');
    } finally {
      setYukleniyor(false);
    }
  }, [gun, asamaFiltre, sadeceAcik, subeArama, depoFiltre, talepArama, toast]);

  const yukleDepoListe = useCallback(async () => {
    try {
      const qs = `durum=${encodeURIComponent(depoDurumFiltre)}&gun=${gun}${
        depoFiltre ? `&sevkiyat_sube_id=${encodeURIComponent(depoFiltre)}` : ''
      }`;
      const ls = await api(`/ops/siparis/sevkiyat-listesi?${qs}`);
      setDepoListe(ls?.satirlar || []);
    } catch (e) {
      toast(e.message || 'Depo listesi yüklenemedi', 'red');
    }
  }, [depoDurumFiltre, depoFiltre, gun, toast]);

  useEffect(() => {
    yukle();
  }, [yukle]);

  useEffect(() => {
    if (gorunum === 'depo') yukleDepoListe();
  }, [gorunum, yukleDepoListe]);

  useEffect(() => {
    const tid = vurgulaId;
    if (!tid || !veri?.satirlar?.length) return;
    const s = veri.satirlar.find((x) => x.id === tid);
    if (s) setSecili(s);
  }, [vurgulaId, veri]);

  useEffect(() => {
    if (!secili?.id) {
      setTimeline(null);
      return;
    }
    let cancel = false;
    setTlYukleniyor(true);
    api(`/ops/v2/siparis/${encodeURIComponent(secili.id)}/timeline`)
      .then((r) => {
        if (!cancel) setTimeline(r);
      })
      .catch(() => {
        if (!cancel) setTimeline(null);
      })
      .finally(() => {
        if (!cancel) setTlYukleniyor(false);
      });
    return () => {
      cancel = true;
    };
  }, [secili?.id]);

  useEffect(() => {
    if (!depoSecili) return;
    const next = {};
    (depoSecili.kalemler || []).forEach((k, i) => {
      const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
      next[key] = {
        urun_id: k?.urun_id || null,
        urun_ad: k?.urun_ad || null,
        durum: 'var',
        gonderilen_adet: Number(k?.adet || 0),
        not_aciklama: '',
      };
    });
    (depoSecili.kalem_durumlari || []).forEach((d) => {
      const idx = (depoSecili.kalemler || []).findIndex(
        (k) => (k?.urun_id || '') === (d?.urun_id || '') && (k?.urun_ad || '') === (d?.urun_ad || ''),
      );
      const key =
        idx >= 0
          ? `${depoSecili.kalemler[idx]?.urun_id || ''}:${depoSecili.kalemler[idx]?.urun_ad || ''}:${idx}`
          : `${d?.urun_id || ''}:${d?.urun_ad || ''}:x`;
      next[key] = {
        urun_id: d?.urun_id || null,
        urun_ad: d?.urun_ad || null,
        durum: d?.durum || 'var',
        gonderilen_adet: Number(d?.gonderilen_adet || 0),
        not_aciklama: d?.not_aciklama || '',
      };
    });
    setDepoKalem(next);
    setDepoNot(depoSecili?.sevkiyat_notu || '');
  }, [depoSecili]);

  const ozet = veri?.ozet || {};
  const satirlar = veri?.satirlar || [];
  const bekleyenListe = bekleyen?.siparisler || [];

  const pipelineAdimlar = useMemo(
    () => [
      { key: 'bekliyor', ...ASAMA_STIL.bekliyor, adet: ozet.bekliyor || 0 },
      { key: 'depoda', ...ASAMA_STIL.depoda, adet: ozet.depoda || 0 },
      { key: 'yolda', ...ASAMA_STIL.yolda, adet: ozet.yolda || 0 },
      { key: 'uyumsuzluk', ...ASAMA_STIL.uyumsuzluk, adet: ozet.uyumsuzluk || 0 },
    ],
    [ozet],
  );

  const depoyaGonder = async (talepId) => {
    const depo = kuyrukDepo[talepId];
    if (!depo) {
      toast('Önce hedef depo seçin', 'red');
      return;
    }
    setKuyrukBusy(talepId);
    try {
      const body = { talep_id: talepId, hedef_depo_sube_id: depo };
      const tal = (kuyrukTalimat[talepId] || '').trim();
      if (tal) body.operasyon_yonlendirme_talimati = tal;
      await api('/ops/siparis/sevkiyata-gonder', { method: 'POST', body });
      toast('Sipariş depoya yönlendirildi');
      yukle();
    } catch (e) {
      toast(e.message || 'Yönlendirme hatası', 'red');
    } finally {
      setKuyrukBusy(null);
    }
  };

  const depoKaydet = async (gonderildi = false) => {
    if (!depoSecili) return;
    const payload = Object.values(depoKalem);
    if (!payload.length) {
      toast('Kalem durumu seçin', 'red');
      return;
    }
    setDepoBusy(true);
    try {
      await api('/ops/siparis/sevkiyat-guncelle', {
        method: 'POST',
        body: {
          talep_id: depoSecili.id,
          hedef_depo_sube_id: depoSecili.hedef_depo_sube_id || depoSecili.sevkiyat_sube_id,
          kalem_durumlari: payload,
          sevkiyat_notu: (depoNot || '').trim() || null,
          gonderildi,
        },
      });
      toast(gonderildi ? 'Gönderildi olarak kaydedildi' : 'Depo hazırlığı kaydedildi');
      yukleDepoListe();
      yukle();
      setDepoSecili(null);
    } catch (e) {
      toast(e.message || 'Kayıt başarısız', 'red');
    } finally {
      setDepoBusy(false);
    }
  };

  const urunAra = async () => {
    const q = urunArama.trim();
    if (q.length < 2) {
      toast('En az 2 karakter girin', 'red');
      return;
    }
    try {
      const r = await api(
        `/ops/siparis/urun-gecmis?urun=${encodeURIComponent(q)}&gun=${gun}&limit=80`,
      );
      setUrunGecmis(r);
    } catch (e) {
      toast(e.message || 'Ürün geçmişi yüklenemedi', 'red');
    }
  };

  const uyumCoz = async (row) => {
    const cozum = window.prompt(
      `Uzlaşma adedi (sevk: ${row.sevk_adet}, kabul: ${row.kabul_adet}):`,
      String(row.kabul_adet ?? row.sevk_adet ?? 0),
    );
    if (cozum === null) return;
    try {
      await api('/ops/siparis/sevkiyat-uyumsuzluk-coz', {
        method: 'POST',
        body: {
          stok_yolda_id: row.stok_yolda_id,
          cozum_adet: Number(cozum) || 0,
        },
      });
      toast('Uyumsuzluk kaydı güncellendi');
      yukle();
    } catch (e) {
      toast(e.message || 'Çözüm kaydedilemedi', 'red');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {msg && <div className={`alert-box ${msg.t} mb-8`}>{msg.m}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, flex: '1 1 200px' }}>
          📡 Sipariş Kontrol Kulesi
        </h2>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'izleme', label: 'İzleme & Kuyruk' },
            { id: 'depo', label: 'Depo hazırlık' },
            { id: 'urun', label: 'Ürün geçmişi' },
          ].map((g) => (
            <button
              key={g.id}
              type="button"
              className={`btn btn-sm ${gorunum === g.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setGorunum(g.id)}
            >
              {g.label}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-secondary" onClick={yukle} disabled={yukleniyor}>
            ↺ Yenile
          </button>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 13, color: 'var(--text3)', lineHeight: 1.5 }}>
        Tüm şubelerin sipariş taleplerini tek ekranda izleyin: kuyruk → depo → yol → kabul. Eski «Stok Disiplin», «Sipariş Geçmişi», «Kabul takibi» ve «Sevkiyat Hazırlama» menüleri burada birleştirildi.
      </p>

      {gorunum === 'izleme' && (
        <>
          {/* Pipeline özeti */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 10,
            }}
          >
            {pipelineAdimlar.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setAsamaFiltre(asamaFiltre === p.key ? '' : p.key)}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: `2px solid ${asamaFiltre === p.key ? p.renk : 'var(--border)'}`,
                  background: asamaFiltre === p.key ? `${p.renk}18` : 'var(--bg2)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: 22 }}>{p.ikon}</div>
                <div style={{ fontWeight: 700, fontSize: 22, color: p.renk }}>{p.adet}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)' }}>{p.label}</div>
              </button>
            ))}
            <div
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg2)',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Açık toplam</div>
              <div style={{ fontWeight: 700, fontSize: 22 }}>{veri?.acik_toplam ?? '—'}</div>
              <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={!sadeceAcik}
                  onChange={(e) => setSadeceAcik(!e.target.checked)}
                />
                Tamamlananları da göster
              </label>
            </div>
          </div>

          {/* Filtreler */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              placeholder="🔍 Şube adı…"
              value={subeArama}
              onChange={(e) => setSubeArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && yukle()}
              style={{ minWidth: 140, maxWidth: 200 }}
            />
            <input
              className="input"
              placeholder="Sipariş no…"
              value={talepArama}
              onChange={(e) => setTalepArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && yukle()}
              style={{ minWidth: 120, maxWidth: 160 }}
            />
            <select className="input" value={depoFiltre} onChange={(e) => setDepoFiltre(e.target.value)} style={{ minWidth: 160 }}>
              <option value="">Tüm depolar</option>
              {depolar.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.ad || d.id}
                </option>
              ))}
            </select>
            <select className="input" value={String(gun)} onChange={(e) => setGun(Number(e.target.value) || 30)} style={{ width: 90 }}>
              {GUN_SEC.map((g) => (
                <option key={g} value={g}>
                  {g} gün
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={yukle}>
              Filtrele
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(320px, 1.1fr)', gap: 14, alignItems: 'start' }}>
            {/* Sol: liste + kuyruk */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {bekleyenListe.length > 0 && (
                <div className="card" style={{ padding: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>
                    📬 Merkez kuyruğu ({bekleyenListe.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
                    {bekleyenListe.map((sip) => (
                      <div
                        key={sip.id}
                        data-ops-siparis-talep={sip.id}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: 10,
                          background: 'var(--bg)',
                        }}
                      >
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{sip.sube_adi}</div>
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>{kisaTs(sip.olusturma)} · {kalemOzet(sip.kalemler)}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          <select
                            className="input"
                            style={{ flex: 1, minWidth: 120, fontSize: 12 }}
                            value={kuyrukDepo[sip.id] || ''}
                            onChange={(e) => setKuyrukDepo((p) => ({ ...p, [sip.id]: e.target.value }))}
                          >
                            <option value="">Depo seç…</option>
                            {depolar.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.ad}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={kuyrukBusy === sip.id}
                            onClick={() => depoyaGonder(sip.id)}
                          >
                            Yönlendir
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                  {yukleniyor ? 'Yükleniyor…' : `${satirlar.length} sipariş`}
                  {asamaFiltre && (
                    <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: 8 }}>
                      — {ASAMA_STIL[asamaFiltre]?.label}
                    </span>
                  )}
                </div>
                {yukleniyor ? (
                  <div className="loading" style={{ padding: 24 }}>
                    <div className="spinner" />
                  </div>
                ) : satirlar.length === 0 ? (
                  <div className="empty" style={{ padding: 24 }}>
                    <p>Bu filtrede sipariş yok</p>
                  </div>
                ) : (
                  <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                    {satirlar.map((s) => {
                      const st = ASAMA_STIL[s.asama] || { renk: 'var(--text3)', ikon: '•' };
                      const aktif = secili?.id === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          data-ops-siparis-talep={s.id}
                          onClick={() => setSecili(s)}
                          style={{
                            display: 'block',
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 14px',
                            border: 'none',
                            borderBottom: '1px solid var(--border)',
                            borderLeft: `3px solid ${st.renk}`,
                            background: aktif ? 'rgba(59,130,246,0.1)' : 'transparent',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{s.sube_adi}</span>
                            <span style={{ fontSize: 11, color: st.renk }}>{st.ikon}</span>
                          </div>
                          {s.hedef_depo_sube_adi && (
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>→ {s.hedef_depo_sube_adi}</div>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{s.asama_metni}</div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'monospace' }}>
                            #{String(s.id).slice(-8)} · {kisaTs(s.olusturma)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {uyumsuzluklar.length > 0 && (
                <div className="card" style={{ padding: 12, borderColor: '#ef444455' }}>
                  <div style={{ fontWeight: 700, color: '#ef4444', marginBottom: 8 }}>
                    ⚠ Kabul uyumsuzlukları ({uyumsuzluklar.length})
                  </div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', fontSize: 12 }}>
                    {uyumsuzluklar.slice(0, 15).map((u) => (
                      <div
                        key={u.stok_yolda_id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 0',
                          borderBottom: '1px solid var(--border)',
                          gap: 8,
                        }}
                      >
                        <span>
                          {u.hedef_sube_adi}: {u.kalem_adi} (sevk {u.sevk_adet} / kabul {u.kabul_adet})
                        </span>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => uyumCoz(u)}>
                          Çöz
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sağ: detay */}
            <div className="card" style={{ padding: 14, minHeight: 400, position: 'sticky', top: 8 }}>
              {!secili ? (
                <div className="empty" style={{ padding: 40 }}>
                  <p>Listeden bir sipariş seçin</p>
                  <p style={{ fontSize: 12, color: 'var(--text3)' }}>Zaman çizelgesi ve kalem detayı burada görünür</p>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{secili.sube_adi}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {secili.hedef_depo_sube_adi && `Depo: ${secili.hedef_depo_sube_adi} · `}
                        {secili.asama_metni}
                      </div>
                      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text3)' }}>#{secili.id}</div>
                    </div>
                    {secili.asama === 'depoda' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => {
                          setGorunum('depo');
                          if (secili.hedef_depo_sube_id) setDepoFiltre(secili.hedef_depo_sube_id);
                        }}
                      >
                        Depoda aç
                      </button>
                    )}
                  </div>

                  {/* Mini pipeline */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
                    {['bekliyor', 'depoda', 'yolda', 'tamamlandi'].map((a, i) => {
                      const done =
                        ['bekliyor', 'depoda', 'yolda', 'tamamlandi'].indexOf(secili.asama) >= i ||
                        secili.asama === 'uyumsuzluk';
                      const st = ASAMA_STIL[a];
                      return (
                        <div
                          key={a}
                          style={{
                            flex: 1,
                            minWidth: 64,
                            textAlign: 'center',
                            padding: '6px 4px',
                            borderRadius: 6,
                            background: done ? `${st.renk}22` : 'var(--bg3)',
                            fontSize: 10,
                            fontWeight: 600,
                            color: done ? st.renk : 'var(--text3)',
                          }}
                        >
                          {st.ikon} {st.label}
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Kalemler</div>
                  <div style={{ fontSize: 12, marginBottom: 14, maxHeight: 140, overflowY: 'auto' }}>
                    {(secili.kalemler || []).map((k, i) => (
                      <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                        {k.urun_ad || k.kalem_kodu} × {k.adet}
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Zaman çizelgesi</div>
                  {tlYukleniyor ? (
                    <div style={{ color: 'var(--text3)', fontSize: 12 }}>…</div>
                  ) : (
                    <div style={{ fontSize: 11, maxHeight: 200, overflowY: 'auto' }}>
                      <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                        📝 Talep: {kisaTs(secili.olusturma)}
                      </div>
                      {secili.tahsis_ts && (
                        <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                          🏭 Tahsis: {kisaTs(secili.tahsis_ts)} {secili.tahsis_yapan_ad && `· ${secili.tahsis_yapan_ad}`}
                        </div>
                      )}
                      {secili.sevkiyat_ts && (
                        <div style={{ padding: '4px 0', color: 'var(--text3)' }}>
                          🚚 Sevk: {kisaTs(secili.sevkiyat_ts)} {secili.sevkiyat_personel_ad && `· ${secili.sevkiyat_personel_ad}`}
                        </div>
                      )}
                      {(timeline?.olaylar || []).map((o, i) => (
                        <div key={i} style={{ padding: '4px 0', borderLeft: '2px solid var(--border)', paddingLeft: 8, marginLeft: 4 }}>
                          <strong>{o.olay}</strong> {kisaTs(o.zaman)}
                          {o.detay && (
                            <div style={{ color: 'var(--text3)', fontSize: 10 }}>{String(o.detay).slice(0, 120)}</div>
                          )}
                        </div>
                      ))}
                      {(secili.yolda || []).map((y, i) => (
                        <div key={`y${i}`} style={{ padding: '4px 0', fontSize: 11 }}>
                          📦 {y.kalem_adi}: sevk {y.sevk_adet} → kabul {y.kabul_adet || '—'} ({y.durum})
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {gorunum === 'depo' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 14, alignItems: 'start' }}>
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <select className="input" value={depoFiltre} onChange={(e) => setDepoFiltre(e.target.value)}>
                <option value="">Tüm depolar</option>
                {depolar.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.ad}
                  </option>
                ))}
              </select>
              <select className="input" value={depoDurumFiltre} onChange={(e) => setDepoDurumFiltre(e.target.value)}>
                <option value="hazirlaniyor">Açık hazırlık</option>
                <option value="depoda_hazirlaniyor">Depoda hazırlanıyor</option>
                <option value="gonderildi">Gönderildi</option>
              </select>
              <button type="button" className="btn btn-sm btn-secondary" onClick={yukleDepoListe}>
                ↺
              </button>
            </div>
            <div className="card" style={{ maxHeight: 520, overflowY: 'auto', padding: 0 }}>
              {depoListe.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDepoSecili(t)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: 10,
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    background: depoSecili?.id === t.id ? 'rgba(59,130,246,0.12)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{t.talep_sube_adi || t.sube_adi}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{kalemOzet(t.kalemler)}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: 14 }}>
            {!depoSecili ? (
              <div className="empty">Depo listesinden talep seçin</div>
            ) : (
              <>
                <div style={{ fontWeight: 700, marginBottom: 10 }}>{depoSecili.talep_sube_adi || depoSecili.sube_adi}</div>
                {(depoSecili.kalemler || []).map((k, i) => {
                  const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
                  const kd = depoKalem[key] || {};
                  return (
                    <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{ flex: 1, minWidth: 120, fontSize: 13 }}>
                        {k.urun_ad} × {k.adet}
                      </span>
                      <select
                        className="input"
                        style={{ width: 90 }}
                        value={kd.durum || 'var'}
                        onChange={(e) =>
                          setDepoKalem((p) => ({
                            ...p,
                            [key]: { ...kd, durum: e.target.value },
                          }))
                        }
                      >
                        {DURUM_OPS.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        style={{ width: 56 }}
                        value={kd.gonderilen_adet ?? k.adet}
                        onChange={(e) =>
                          setDepoKalem((p) => ({
                            ...p,
                            [key]: { ...kd, gonderilen_adet: Number(e.target.value) },
                          }))
                        }
                      />
                    </div>
                  );
                })}
                <textarea
                  className="input"
                  rows={2}
                  placeholder="Sevkiyat notu"
                  value={depoNot}
                  onChange={(e) => setDepoNot(e.target.value)}
                  style={{ width: '100%', marginTop: 8 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" className="btn btn-secondary" disabled={depoBusy} onClick={() => depoKaydet(false)}>
                    Kaydet
                  </button>
                  <button type="button" className="btn btn-primary" disabled={depoBusy} onClick={() => depoKaydet(true)}>
                    Gönderildi
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {gorunum === 'urun' && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="Ürün adı veya kodu (min 2 karakter)…"
              value={urunArama}
              onChange={(e) => setUrunArama(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && urunAra()}
            />
            <button type="button" className="btn btn-primary" onClick={urunAra}>
              Ara
            </button>
          </div>
          {urunGecmis?.satirlar?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {urunGecmis.satirlar.map((r) => (
                <div
                  key={r.talep_id}
                  style={{
                    padding: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    const s = satirlar.find((x) => x.id === r.talep_id);
                    if (s) {
                      setSecili(s);
                      setGorunum('izleme');
                    } else {
                      setTalepArama(r.talep_id);
                      setGorunum('izleme');
                      yukle();
                    }
                  }}
                >
                  <div style={{ fontWeight: 600 }}>
                    {r.sube_adi} · {r.tarih}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{r.asama_metni}</div>
                  <div style={{ fontSize: 11 }}>
                    {(r.eslesen_kalemler || []).map((k, i) => (
                      <span key={i}>
                        {k.urun_ad} ×{k.adet}{' '}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : urunGecmis ? (
            <div className="empty">Eşleşen talep yok</div>
          ) : (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>
              «Bu ürün daha önce hangi şubeden, ne zaman istendi?» sorusu için ürün adı yazın.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
