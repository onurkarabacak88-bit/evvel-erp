import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';

const DURUM_OPS = [
  { id: 'bekliyor', label: '⏳ Bekliyor' },
  { id: 'var', label: '✓ Var' },
  { id: 'yok', label: '✗ Yok' },
  { id: 'kismi', label: '~ Kısmi' },
];

export default function SevkiyatHazirlama() {
  const [subeler, setSubeler] = useState([]);
  const [sevkiyatSubeId, setSevkiyatSubeId] = useState('');
  const [durum, setDurum] = useState('depoda_hazirlaniyor');
  const [liste, setListe] = useState([]);
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
    () => (subeler || []).filter((s) => s?.aktif !== false && ['depo', 'karma', 'sevkiyat', 'merkez'].includes(String(s?.sube_tipi || 'normal'))),
    [subeler],
  );

  async function load() {
    setLoading(true);
    try {
      const [ss, ls] = await Promise.all([
        api('/ops/subeler/depolar').then((r) => r?.satirlar || []).catch(() => []),
        api(`/ops/siparis/sevkiyat-listesi?durum=${encodeURIComponent(durum)}${sevkiyatSubeId ? `&sevkiyat_sube_id=${encodeURIComponent(sevkiyatSubeId)}` : ''}&gun=15`),
      ]);
      setSubeler(Array.isArray(ss) ? ss : []);
      setListe(ls?.satirlar || []);
      if (secili) {
        const guncel = (ls?.satirlar || []).find((x) => x.id === secili.id);
        setSecili(guncel || null);
      }
    } catch (e) {
      toast(e.message || 'Sevkiyat listesi yüklenemedi', 'red');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [durum, sevkiyatSubeId]);

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
      await load();
    } catch (e) {
      toast(e.message || 'Güncelleme başarısız', 'red');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header flex items-center justify-between">
        <div>
          <h2>🚚 Sevkiyat Hazırlama</h2>
          <p>Hazırlanacak siparişleri kalem bazlı işaretle, ardından gönderildi olarak kapat.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>↻ Yenile</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <select className="input" style={{ minWidth: 230 }} value={sevkiyatSubeId} onChange={(e) => setSevkiyatSubeId(e.target.value)}>
          <option value="">Tüm sevkiyat şubeleri</option>
          {sevkiyatSubeler.map((s) => <option key={s.id} value={s.id}>{s.ad || s.id}</option>)}
        </select>
        <select className="input" style={{ minWidth: 190 }} value={durum} onChange={(e) => setDurum(e.target.value)}>
          <option value="depoda_hazirlaniyor">Depoda Hazırlanıyor</option>
          <option value="kismi_hazirlandi">Kısmi Hazırlandı</option>
          <option value="gonderildi">Gönderildi</option>
          <option value="teslim_edildi">Teslim Edildi</option>
          <option value="all">Tümü</option>
        </select>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" />Yükleniyor…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 12 }}>
          <div className="card" style={{ maxHeight: 620, overflow: 'auto' }}>
            {(liste || []).length === 0 ? (
              <div className="empty"><p>Kayıt yok</p></div>
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
                    {r.tarih} · {r.hedef_depo_sube_adi || r.sevkiyat_sube_adi || r.hedef_depo_sube_id || r.sevkiyat_sube_id} · {r.sevkiyat_durumu || r.sevkiyat_durum}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="card">
            {!secili ? (
              <div className="empty"><p>Soldan bir talep seç</p></div>
            ) : (
              <>
                <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                  {secili.sube_adi || secili.sube_id} → {secili.hedef_depo_sube_adi || secili.sevkiyat_sube_adi || secili.hedef_depo_sube_id || secili.sevkiyat_sube_id}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflow: 'auto' }}>
                  {(secili.kalemler || []).map((k, i) => {
                    const key = `${k?.urun_id || ''}:${k?.urun_ad || ''}:${i}`;
                    const v = kalemDurum[key] || { urun_id: k?.urun_id || null, urun_ad: k?.urun_ad || null, durum: 'var', gonderilen_adet: Number(k?.adet || 0), not_aciklama: '' };
                    return (
                      <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 13, marginBottom: 6 }}>
                          <strong>{k?.urun_ad || 'Ürün'}</strong> · İstenen: {Number(k?.adet || 0)}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <select
                            className="input"
                            style={{ minWidth: 140 }}
                            value={v.durum}
                            onChange={(e) => setKalemDurum((p) => ({ ...p, [key]: { ...v, durum: e.target.value } }))}
                          >
                            {DURUM_OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
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
