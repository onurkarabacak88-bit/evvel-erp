import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, today } from '../../utils/api';
import './vardiya.css';

/** Verilen tarihin bulunduğu haftanın pazartesisini YYYY-MM-DD döner (yerel saat). */
function pazartesiISO(iso) {
  const d = new Date(iso + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Tulipi tarzı haftalık vardiya tablosu (PDF ile aynı mantık: şube, görev, isim,
 * Pazartesi–Pazar hücreleri: saat, İZİNLİ veya şube adı).
 */
export default function VardiyaHaftalik({ onNavigate }) {
  const [pzt, setPzt] = useState(() => pazartesiISO(today()));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [baslik, setBaslik] = useState('Tulipi Haftalık Vardiya Listesi');
  const [notMetni, setNotMetni] = useState('');
  const [gunler, setGunler] = useState([]);
  const [satirlar, setSatirlar] = useState([]);

  const yukle = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api(`/vardiya/haftalik?tarih=${encodeURIComponent(pzt)}`);
      setBaslik(res.baslik || 'Tulipi Haftalık Vardiya Listesi');
      setNotMetni(res.not_metni || '');
      setGunler(res.gunler || []);
      setSatirlar(
        (res.satirlar || []).map((s) => ({
          ...s,
          hucreler: { ...s.hucreler },
        })),
      );
    } catch (e) {
      setErr(e.message || 'Yüklenemedi');
      setSatirlar([]);
      setGunler([]);
    } finally {
      setLoading(false);
    }
  }, [pzt]);

  useEffect(() => {
    yukle();
  }, [yukle]);

  const haftaOzet = useMemo(() => {
    if (!gunler.length) return '';
    return `${gunler[0].kisa} – ${gunler[6].kisa}`;
  }, [gunler]);

  const hucreDegistir = (personelId, tarih, val) => {
    setSatirlar((rows) =>
      rows.map((r) =>
        r.personel_id === personelId
          ? { ...r, hucreler: { ...r.hucreler, [tarih]: val } }
          : r,
      ),
    );
  };

  const satirExtraDegistir = (personelId, field, val) => {
    setSatirlar((rows) =>
      rows.map((r) => (r.personel_id === personelId ? { ...r, [field]: val } : r)),
    );
  };

  const kaydet = async () => {
    setSaving(true);
    setErr(null);
    setOkMsg(null);
    const hucreler = [];
    for (const s of satirlar) {
      for (const g of gunler) {
        const t = g.tarih;
        const ic = (s.hucreler[t] ?? '').trim();
        hucreler.push({ personel_id: s.personel_id, tarih: t, icerik: ic });
      }
    }
    const satir_extra = satirlar.map((s) => ({
      personel_id: s.personel_id,
      kapanis_sayisi: (s.kapanis_sayisi || '').trim() || null,
      alacak_saat: (s.alacak_saat || '').trim() || null,
    }));
    try {
      await api('/vardiya/haftalik', {
        method: 'PUT',
        body: {
          hafta_baslangic: pzt,
          baslik: baslik.trim() || 'Tulipi Haftalık Vardiya Listesi',
          not_metni: notMetni,
          hucreler,
          satir_extra,
        },
      });
      setOkMsg('Haftalık liste kaydedildi.');
      yukle();
    } catch (e) {
      setErr(e.message || 'Kayıt başarısız');
    } finally {
      setSaving(false);
    }
  };

  const oncekiHafta = () => {
    const d = new Date(pzt + 'T12:00:00');
    d.setDate(d.getDate() - 7);
    setPzt(d.toISOString().slice(0, 10));
  };

  const sonrakiHafta = () => {
    const d = new Date(pzt + 'T12:00:00');
    d.setDate(d.getDate() + 7);
    setPzt(d.toISOString().slice(0, 10));
  };

  const buHafta = () => {
    setPzt(pazartesiISO(today()));
  };

  return (
    <div className="page vardiya-module vardiya-haftalik">
      <div className="page-header vardiya-haftalik-header">
        <div>
          <h2>Haftalık vardiya listesi</h2>
          <p>
            Tulipi PDF formatı: her hücrede saat aralığı (ör. 09.00-18.30),{' '}
            <strong>İZİNLİ</strong> veya o gün çalışılacak <strong>şube adı</strong>.
          </p>
        </div>
        <div className="vardiya-haftalik-header-actions">
          {typeof onNavigate === 'function' && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onNavigate('vardiya')}
            >
              Günlük plan
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
            Yazdır / PDF
          </button>
        </div>
      </div>

      <div className="vardiya-haftalik-toolbar no-print">
        <div className="form-group" style={{ marginBottom: 0, minWidth: 160 }}>
          <label>Hafta (Pazartesi)</label>
          <input type="date" value={pzt} onChange={(e) => setPzt(pazartesiISO(e.target.value))} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button type="button" className="btn btn-sm" onClick={oncekiHafta}>
            ← Önceki hafta
          </button>
          <button type="button" className="btn btn-sm" onClick={buHafta}>
            Bu hafta
          </button>
          <button type="button" className="btn btn-sm" onClick={sonrakiHafta}>
            Sonraki hafta →
          </button>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || loading}
          onClick={kaydet}
        >
          {saving ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
      </div>

      {err && <div className="alert-box red mb-16">{err}</div>}
      {okMsg && <div className="alert-box green mb-16">{okMsg}</div>}

      <div className="form-group no-print" style={{ maxWidth: 560 }}>
        <label>Liste başlığı</label>
        <input
          type="text"
          value={baslik}
          onChange={(e) => setBaslik(e.target.value)}
          placeholder="Tulipi Haftalık Vardiya Listesi"
        />
      </div>

      {loading ? (
        <div className="loading" style={{ padding: 48 }}>
          <div className="spinner" />
          <span>Yükleniyor…</span>
        </div>
      ) : (
        <>
          <div className="vardiya-haftalik-baslik-print">
            <h1>{baslik}</h1>
            <p className="vardiya-haftalik-tarih">
              {haftaOzet} · Pazartesi {pzt}
            </p>
          </div>

          <div className="vardiya-haftalik-scroll">
            <table className="vardiya-haftalik-table">
              <thead>
                <tr>
                  <th rowSpan={2}>Şube</th>
                  <th rowSpan={2}>Görev</th>
                  <th rowSpan={2}>Ad Soyad</th>
                  {gunler.map((g) => (
                    <th key={g.tarih} className="vardiya-haftalik-day">
                      <div>{g.hafta_gunu}</div>
                      <div className="vardiya-haftalik-daydate">{g.kisa}</div>
                    </th>
                  ))}
                  <th rowSpan={2}>Kapanış sayısı</th>
                  <th rowSpan={2}>Alacak saat</th>
                </tr>
                <tr>
                  {gunler.map((g) => (
                    <th key={`d-${g.tarih}`} className="vardiya-haftalik-sub">
                      {g.tarih.slice(8, 10)}.{g.tarih.slice(5, 7)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {satirlar.length === 0 ? (
                  <tr>
                    <td colSpan={3 + gunler.length + 2} className="vardiya-haftalik-empty">
                      Aktif personel yok. Personel tanımlayın.
                    </td>
                  </tr>
                ) : (
                  satirlar.map((s) => (
                    <tr key={s.personel_id}>
                      <td className="vardiya-haftalik-sube">{s.sube_adi}</td>
                      <td>{s.gorev || '—'}</td>
                      <td className="vardiya-haftalik-ad">{s.ad_soyad}</td>
                      {gunler.map((g) => (
                        <td key={g.tarih} className="vardiya-haftalik-cell">
                          <input
                            type="text"
                            className="vardiya-haftalik-input"
                            value={s.hucreler[g.tarih] ?? ''}
                            onChange={(e) => hucreDegistir(s.personel_id, g.tarih, e.target.value)}
                            placeholder="09.00-18.30 / İZİNLİ / şube"
                          />
                        </td>
                      ))}
                      <td>
                        <input
                          type="text"
                          className="vardiya-haftalik-input vardiya-haftalik-input-sm"
                          value={s.kapanis_sayisi ?? ''}
                          onChange={(e) =>
                            satirExtraDegistir(s.personel_id, 'kapanis_sayisi', e.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="vardiya-haftalik-input vardiya-haftalik-input-sm"
                          value={s.alacak_saat ?? ''}
                          onChange={(e) =>
                            satirExtraDegistir(s.personel_id, 'alacak_saat', e.target.value)
                          }
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="form-group no-print" style={{ marginTop: 20 }}>
            <label>Not (PDF’deki gibi: yemek molası vb.)</label>
            <textarea
              rows={3}
              value={notMetni}
              onChange={(e) => setNotMetni(e.target.value)}
              placeholder="Örn: NOT: YEMEK MOLASI KÖYCEĞİZDE YAPILACAK"
            />
          </div>

          {notMetni.trim() && (
            <div className="vardiya-haftalik-not-print">
              <strong>Not</strong>
              <pre className="vardiya-haftalik-not-pre">{notMetni}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
