import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';

const DURUM_OPS = [
  { id: 'bekliyor', label: '⏳ Bekliyor' },
  { id: 'var', label: '✓ Var' },
  { id: 'yok', label: '✗ Yok' },
  { id: 'kismi', label: '~ Kısmi' },
];

const GUN_SECENEKLERI = [7, 15, 30, 60, 90, 180, 365];

function kisaTarih(ts) {
  if (!ts) return '—';
  const s = String(ts);
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

export default function SevkiyatHazirlama() {
  const [subeler, setSubeler] = useState([]);
  const [sevkiyatSubeId, setSevkiyatSubeId] = useState('');
  const [durum, setDurum] = useState('depoda_hazirlaniyor');
  const [gun, setGun] = useState(30);
  const [liste, setListe] = useState([]);
  const [listeMeta, setListeMeta] = useState({ gun_sayi: 30, liste_limit: 500 });
  const [subeOzet, setSubeOzet] = useState([]);
  const [depoRaporlar, setDepoRaporlar] = useState([]);
  const [depoRaporMeta, setDepoRaporMeta] = useState({ gun: 30, limit: 120, hedef_depo_sube_id: null });
  const [secili, setSecili] = useState(null);
  const [kalemDurum, setKalemDurum] = useState({});
  const [notu, setNotu] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  const toast = (m, t = 'green') => {
    setMsg({ m, t });
    setTimeout(() => setMsg(null), 3500);
  };

  const sevkiyatSubeler = useMemo(
    () => (subeler || []).filter((s) => s?.aktif !== false),
    [subeler],
  );

  useEffect(() => {
    try {
      const sid = String(sessionStorage.getItem('ops_sevkiyat_hazirlama_sube_id') || '').trim();
      if (!sid) return;
      sessionStorage.removeItem('ops_sevkiyat_hazirlama_sube_id');
      setSevkiyatSubeId(sid);
    } catch (_) {}
  }, []);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const raporQs = `gun=${encodeURIComponent(String(Math.min(365, gun)))}&limit=120${
          sevkiyatSubeId ? `&hedef_depo_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
        }`;
        const [ss, ls, oz, rp] = await Promise.all([
          api('/ops/subeler/depolar').then((r) => r?.satirlar || []).catch(() => []),
          api(
            `/ops/siparis/sevkiyat-listesi?durum=${encodeURIComponent(durum)}${
              sevkiyatSubeId ? `&sevkiyat_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
            }&gun=${encodeURIComponent(String(gun))}`,
          ),
          api(`/ops/siparis/sevkiyat-subeler-ozet?gun=${encodeURIComponent(String(gun))}`).catch(() => ({ satirlar: [] })),
          api(`/ops/siparis/depo-sevkiyat-raporlari?${raporQs}`).catch(() => ({ raporlar: [] })),
        ]);
        if (cancel) return;
        setSubeler(Array.isArray(ss) ? ss : []);
        setListe(ls?.satirlar || []);
        setListeMeta({
          gun_sayi: ls?.gun_sayi ?? gun,
          liste_limit: ls?.liste_limit ?? 500,
        });
        setSubeOzet(Array.isArray(oz?.satirlar) ? oz.satirlar : []);
        setDepoRaporlar(Array.isArray(rp?.raporlar) ? rp.raporlar : []);
        setDepoRaporMeta({
          gun: rp?.gun ?? gun,
          limit: rp?.limit ?? 120,
          hedef_depo_sube_id: rp?.hedef_depo_sube_id ?? (sevkiyatSubeId || null),
        });
      } catch (e) {
        if (!cancel) toast(e.message || 'Sevkiyat verisi yüklenemedi', 'red');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [durum, sevkiyatSubeId, gun]);

  useEffect(() => {
    setSecili((prev) => {
      if (!prev) return prev;
      const g = (liste || []).find((x) => x.id === prev.id);
      return g || null;
    });
  }, [liste]);

  useEffect(() => {
    if (!secili) return;
    const next = {};
    (secili.kalemler || []).forEach((k, i) => {
      const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
      next[key] = { urun_id: k?.urun_id || null, urun_ad: k?.urun_ad || null, durum: 'var', gonderilen_adet: Number(k?.adet || 0), not_aciklama: '' };
    });
    (secili.kalem_durumlari || []).forEach((d) => {
      const idx = (secili.kalemler || []).findIndex((k) => (k?.urun_id || '') === (d?.urun_id || '') && (k?.urun_ad || '') === (d?.urun_ad || ''));
      const key = idx >= 0 ? `${secili.kalemler[idx]?.urun_id || ''}:${secili.kalemler[idx]?.urun_ad || ''}:${idx}` : `${d?.urun_id || ''}:${d?.urun_ad || ''}:${Math.random()}`;
      next[key] = {
        urun_id: d?.urun_id || null,
        urun_ad: d?.urun_ad || null,
        durum: d?.durum || 'var',
        gonderilen_adet: Number(d?.gonderilen_adet || 0),
        not_aciklama: d?.not_aciklama || '',
      };
    });
    setKalemDurum(next);
    setNotu(secili?.sevkiyat_notu || secili?.sevkiyat_notlari || '');
  }, [secili]);

  async function kaydet(gonderildi = false) {
    if (!secili) return;
    const payload = Object.values(kalemDurum);
    if (!payload.length) {
      toast('En az bir kalem durumu seçin', 'red');
      return;
    }
    setBusy(true);
    try {
      await api('/ops/siparis/sevkiyat-guncelle', {
        method: 'POST',
        body: {
          talep_id: secili.id,
          hedef_depo_sube_id: secili.hedef_depo_sube_id || secili.sevkiyat_sube_id,
          kalem_durumlari: payload,
          sevkiyat_notu: (notu || '').trim() || null,
          gonderildi,
        },
      });
      toast(gonderildi ? 'Talep gönderildi olarak güncellendi' : 'Kalem durumları kaydedildi');
      const ls = await api(
        `/ops/siparis/sevkiyat-listesi?durum=${encodeURIComponent(durum)}${
          sevkiyatSubeId ? `&sevkiyat_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
        }&gun=${encodeURIComponent(String(gun))}`,
      );
      setListe(ls?.satirlar || []);
      setListeMeta({
        gun_sayi: ls?.gun_sayi ?? gun,
        liste_limit: ls?.liste_limit ?? 500,
      });
      const oz = await api(`/ops/siparis/sevkiyat-subeler-ozet?gun=${encodeURIComponent(String(gun))}`).catch(() => ({ satirlar: [] }));
      setSubeOzet(Array.isArray(oz?.satirlar) ? oz.satirlar : []);
      const raporQs = `gun=${encodeURIComponent(String(Math.min(365, gun)))}&limit=120${
        sevkiyatSubeId ? `&hedef_depo_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
      }`;
      const rp = await api(`/ops/siparis/depo-sevkiyat-raporlari?${raporQs}`).catch(() => ({ raporlar: [] }));
      setDepoRaporlar(Array.isArray(rp?.raporlar) ? rp.raporlar : []);
      setDepoRaporMeta({
        gun: rp?.gun ?? gun,
        limit: rp?.limit ?? 120,
        hedef_depo_sube_id: rp?.hedef_depo_sube_id ?? (sevkiyatSubeId || null),
      });
    } catch (e) {
      toast(e.message || 'Güncelleme başarısız', 'red');
    } finally {
      setBusy(false);
    }
  }

  const ozettenSubeSec = (depoId) => {
    if (!depoId) return;
    setSevkiyatSubeId((prev) => (prev === depoId ? '' : depoId));
  };

  async function yenile() {
    setLoading(true);
    try {
      const raporQs = `gun=${encodeURIComponent(String(Math.min(365, gun)))}&limit=120${
        sevkiyatSubeId ? `&hedef_depo_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
      }`;
      const [ss, ls, oz, rp] = await Promise.all([
        api('/ops/subeler/depolar').then((r) => r?.satirlar || []).catch(() => []),
        api(
          `/ops/siparis/sevkiyat-listesi?durum=${encodeURIComponent(durum)}${
            sevkiyatSubeId ? `&sevkiyat_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''
          }&gun=${encodeURIComponent(String(gun))}`,
        ),
        api(`/ops/siparis/sevkiyat-subeler-ozet?gun=${encodeURIComponent(String(gun))}`).catch(() => ({ satirlar: [] })),
        api(`/ops/siparis/depo-sevkiyat-raporlari?${raporQs}`).catch(() => ({ raporlar: [] })),
      ]);
      setSubeler(Array.isArray(ss) ? ss : []);
      setListe(ls?.satirlar || []);
      setListeMeta({
        gun_sayi: ls?.gun_sayi ?? gun,
        liste_limit: ls?.liste_limit ?? 500,
      });
      setSubeOzet(Array.isArray(oz?.satirlar) ? oz.satirlar : []);
      setDepoRaporlar(Array.isArray(rp?.raporlar) ? rp.raporlar : []);
      setDepoRaporMeta({
        gun: rp?.gun ?? gun,
        limit: rp?.limit ?? 120,
        hedef_depo_sube_id: rp?.hedef_depo_sube_id ?? (sevkiyatSubeId || null),
      });
    } catch (e) {
      toast(e.message || 'Yenileme başarısız', 'red');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>🚚 Sevkiyat Hazırlama</h2>
          <p>
            Şube (hedef depo) bazında açık ve tamamlanan sevkiyatları izleyin; kalem durumlarını güncelleyip gönderildi olarak kapatabilirsiniz.
            Aşağıda şube panelinden üretilen <strong>depo sevkiyat rapor metinleri</strong> tarihsel olarak listelenir (üstteki gün ve depo filtresiyle).
            Talep listesinde satır limiti uygulanabilir.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => yenile()}>
          ↻ Yenile
        </button>
      </div>

      <div className="card mb-16" style={{ overflow: 'auto' }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>Şubeler · sevkiyat durum özeti</h3>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.45 }}>
          Son <strong>{gun}</strong> gün içinde bu şubeye <strong>hedef depo</strong> atanmış talepler. Satıra tıklayınca aşağıdaki filtrede o şube seçilir
          (yeniden tıklayınca «Tüm sevkiyat şubeleri»).
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '6px 8px' }}>Depo şubesi</th>
              <th style={{ padding: '6px 8px' }}>Tip</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Hazırlıkta</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Gönderildi</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Teslim edildi</th>
              <th style={{ padding: '6px 8px', textAlign: 'right' }}>Toplam</th>
              <th style={{ padding: '6px 8px' }}>Son talep</th>
            </tr>
          </thead>
          <tbody>
            {(subeOzet || []).map((o) => {
              const sid = String(o.depo_sube_id || '');
              const aktif = sevkiyatSubeId === sid;
              const has = (o.toplam || 0) > 0;
              return (
                <tr
                  key={sid || Math.random()}
                  onClick={() => has && ozettenSubeSec(sid)}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    cursor: has ? 'pointer' : 'default',
                    background: aktif ? 'rgba(59,130,246,0.12)' : has ? 'transparent' : 'rgba(0,0,0,0.02)',
                  }}
                  title={has ? 'Filtrelemek için tıklayın' : 'Bu pencerede hedef depo kaydı yok'}
                >
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{o.depo_sube_adi || sid}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text3)' }}>{o.sube_tipi || '—'}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: (o.hazirlikta || 0) > 0 ? '#f59e0b' : 'var(--text3)' }}>{o.hazirlikta ?? 0}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>{o.gonderildi ?? 0}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', color: '#22c55e' }}>{o.teslim_edildi ?? 0}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700 }}>{o.toplam ?? 0}</td>
                  <td style={{ padding: '6px 8px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{o.son_talep_tarih || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" style={{ minWidth: 230 }} value={sevkiyatSubeId} onChange={(e) => setSevkiyatSubeId(e.target.value)}>
          <option value="">Tüm sevkiyat şubeleri</option>
          {sevkiyatSubeler.map((s) => (
            <option key={s.id} value={s.id}>
              {s.ad || s.id}
            </option>
          ))}
        </select>
        <select className="input" style={{ minWidth: 190 }} value={durum} onChange={(e) => setDurum(e.target.value)}>
          <option value="hazirlaniyor">Açık hazırlık (depoda + kısmi)</option>
          <option value="depoda_hazirlaniyor">Yalnız depoda hazırlanıyor</option>
          <option value="kismi_hazirlandi">Kısmi hazırlandı</option>
          <option value="gonderildi">Gönderildi (tarihsel)</option>
          <option value="teslim_edildi">Teslim edildi (tarihsel)</option>
          <option value="all">Tüm durumlar</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--text3)' }}>Gün:</span>
          <select className="input" style={{ minWidth: 90 }} value={String(gun)} onChange={(e) => setGun(Number(e.target.value) || 30)}>
            {GUN_SECENEKLERI.map((g) => (
              <option key={g} value={String(g)}>
                {g} gün
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          Liste en fazla <strong>{listeMeta.liste_limit}</strong> satır (en yeni önce).
        </span>
      </div>

      <div className="card mb-16" style={{ overflow: 'auto' }}>
        <h3 style={{ fontSize: 14, marginBottom: 8 }}>📋 Depo sevkiyat raporları (tarihsel)</h3>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.45 }}>
          Şube panelinde «Depo sevkiyatını kaydet» ile oluşan özet metinler. Son <strong>{depoRaporMeta.gun}</strong> gün, en fazla{' '}
          <strong>{depoRaporMeta.limit}</strong> kayıt
          {depoRaporMeta.hedef_depo_sube_id ? (
            <>
              {' '}
              · Depo filtresi: <code style={{ fontSize: 11 }}>{depoRaporMeta.hedef_depo_sube_id}</code>
            </>
          ) : (
            ' · Tüm depolar'
          )}
          .
        </p>
        {(depoRaporlar || []).length === 0 ? (
          <div className="empty" style={{ padding: '12px 0' }}>
            <p style={{ fontSize: 13 }}>Bu aralıkta rapor kaydı yok.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(depoRaporlar || []).map((rp) => (
              <details
                key={rp.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: 'var(--bg2)',
                }}
              >
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, listStyle: 'none' }}>
                  <span style={{ marginRight: 8 }}>▸</span>
                  {rp.talep_sube_adi || rp.sube_id} → {rp.hedef_depo_adi || rp.hedef_depo_sube_id}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--text3)', fontSize: 12 }}>
                    · {rp.tarih || '—'} · {rp.sevkiyat_durumu || '—'}
                    {rp.depo_sevkiyat_rapor_ts ? ` · Rapor: ${kisaTarih(rp.depo_sevkiyat_rapor_ts)}` : ''}
                    {rp.depo_personel_ad ? ` · ${rp.depo_personel_ad}` : ''}
                  </span>
                  {rp.depo_sevkiyat_rapor_uyari ? (
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#f59e0b' }}>⚠ Uyarı</span>
                  ) : null}
                </summary>
                <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => {
                      e.preventDefault();
                      const r = (liste || []).find((x) => String(x.id) === String(rp.id));
                      if (r) setSecili(r);
                      else toast('Bu talep soldaki listede yok — durumu «Tüm durumlar» yapıp veya gün aralığını genişleterek deneyin.', 'orange');
                    }}
                  >
                    Talebi solda seç
                  </button>
                  <code style={{ fontSize: 10, color: 'var(--text3)' }}>{rp.id}</code>
                </div>
                {rp.depo_sevkiyat_rapor_uyari ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#fbbf24', whiteSpace: 'pre-wrap' }}>{rp.depo_sevkiyat_rapor_uyari}</div>
                ) : null}
                <pre
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 280,
                    overflow: 'auto',
                    padding: 10,
                    borderRadius: 6,
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {rp.depo_sevkiyat_rapor_metni || '—'}
                </pre>
              </details>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner" />
          Yükleniyor…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 12 }}>
          <div className="card" style={{ maxHeight: 620, overflow: 'auto' }}>
            {(liste || []).length === 0 ? (
              <div className="empty">
                <p>Kayıt yok</p>
              </div>
            ) : (
              (liste || []).map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSecili(r)}
                  style={{
                    border: `1px solid ${secili?.id === r.id ? 'var(--blue)' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    cursor: 'pointer',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{r.sube_adi || r.sube_id}</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                    Talep: {r.tarih || '—'} · Depo: {r.hedef_depo_sube_adi || r.sevkiyat_sube_adi || r.hedef_depo_sube_id || r.sevkiyat_sube_id}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Durum: <strong>{r.sevkiyat_durumu || r.sevkiyat_durum}</strong>
                    {r.sevkiyat_ts ? (
                      <span>
                        {' '}
                        · Sevkiyat: {kisaTarih(r.sevkiyat_ts)}
                      </span>
                    ) : null}
                    {r.olusturma ? (
                      <span>
                        {' '}
                        · Oluşturma: {kisaTarih(r.olusturma)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="card">
            {!secili ? (
              <div className="empty">
                <p>Soldan bir talep seç</p>
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                  {secili.sube_adi || secili.sube_id} → {secili.hedef_depo_sube_adi || secili.sevkiyat_sube_adi || secili.hedef_depo_sube_id || secili.sevkiyat_sube_id}
                </h3>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                  ID: <code style={{ fontSize: 10 }}>{secili.id}</code> · {secili.sevkiyat_durumu || secili.sevkiyat_durum}
                  {secili.sevkiyat_ts ? ` · Son işlem: ${kisaTarih(secili.sevkiyat_ts)}` : ''}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto' }}>
                  {(secili.kalemler || []).map((k, i) => {
                    const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
                    const v = kalemDurum[key] || { urun_id: k?.urun_id || null, urun_ad: k?.urun_ad || null, durum: 'var', gonderilen_adet: Number(k?.adet || 0), not_aciklama: '' };
                    return (
                      <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 13, marginBottom: 6 }}>
                          <strong>{k?.depo_stok_ad || k?.urun_ad || 'Ürün'}</strong>
                          {k?.depo_stok_ad && k?.urun_ad && k.depo_stok_ad !== k.urun_ad && (
                            <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 6 }}>({k.urun_ad})</span>
                          )}
                          {' '}· İstenen: {Number(k?.adet || 0)}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <select
                            className="input"
                            style={{ minWidth: 140 }}
                            value={v.durum}
                            onChange={(e) => setKalemDurum((p) => ({ ...p, [key]: { ...v, durum: e.target.value } }))}
                          >
                            {DURUM_OPS.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            style={{ width: 110 }}
                            value={Number(v.gonderilen_adet || 0)}
                            onChange={(e) => setKalemDurum((p) => ({ ...p, [key]: { ...v, gonderilen_adet: Number(e.target.value) || 0 } }))}
                          />
                          <input
                            className="input"
                            style={{ flex: 1, minWidth: 180 }}
                            value={v.not_aciklama || ''}
                            placeholder="Kalem notu (opsiyonel)"
                            onChange={(e) => setKalemDurum((p) => ({ ...p, [key]: { ...v, not_aciklama: e.target.value } }))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop: 10 }}>
                  <textarea
                    rows={3}
                    className="input"
                    style={{ width: '100%' }}
                    placeholder="Sevkiyat notu (opsiyonel)"
                    value={notu}
                    onChange={(e) => setNotu(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => kaydet(false)}>
                    {busy ? '…' : 'Ara kaydet'}
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => kaydet(true)}>
                    {busy ? '…' : 'Gönderildi'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
