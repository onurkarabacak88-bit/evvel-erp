import { useState, useEffect } from 'react';
import { api, fmt, fmtDate, today } from '../utils/api';

export default function Subeler() {
  const [subeler, setSubeler] = useState([]);
  const [msg, setMsg] = useState(null);
  const [duzenle, setDuzenle] = useState({});
  const [onizle, setOnizle] = useState(null);      // { sid, data }
  const [tarihForm, setTarihForm] = useState(null); // { sid, baslangic, bitis }
  const [loading, setLoading] = useState(false);

  const load = () => api('/subeler').then(setSubeler);
  useEffect(() => { load(); }, []);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 4000); };
  const set = (sid, field, val) => setDuzenle(d => ({ ...d, [sid]: { ...d[sid], [field]: val } }));

  // Adım 1: Oranı kaydet → tarih seçim formunu aç
  async function kaydet(s) {
    try {
      const pos_oran = parseFloat(duzenle[s.id]?.pos_oran ?? s.pos_oran ?? 0);
      const online_oran = parseFloat(duzenle[s.id]?.online_oran ?? s.online_oran ?? 0);
      await api(`/subeler/${s.id}`, { method: 'PUT', body: { pos_oran, online_oran } });
      toast('✓ Oranlar kaydedildi');
      load();
      // Ay başı ve bugün varsayılan
      const bugun = today();
      const ayBasi = bugun.slice(0, 7) + '-01';
      setTarihForm({ sid: s.id, baslangic: ayBasi, bitis: bugun });
    } catch (e) { toast(e.message, 'red'); }
  }

  // Adım 2: Tarih seçildi → önizle
  async function onizleGetir() {
    if (!tarihForm) return;
    setLoading(true);
    try {
      const { sid, baslangic, bitis } = tarihForm;
      const data = await api(`/subeler/${sid}/kasa-onizle?baslangic=${baslangic}&bitis=${bitis}`);
      setOnizle({ sid, data });
      setTarihForm(null);
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoading(false); }
  }

  // Adım 3: Kullanıcı onayladı → düzelt
  async function duzeltOnayla() {
    if (!onizle) return;
    setLoading(true);
    try {
      const { sid, data } = onizle;
      const res = await api(`/subeler/${sid}/kasa-duzelt`, {
        method: 'POST',
        body: { baslangic: data.baslangic, bitis: data.bitis }
      });
      if (res.success) {
        toast(`✓ ${res.duzeltilen} kayıt düzeltildi. Kasa etkisi: ${fmt(res.toplam_fark)}`, 'green');
        setOnizle(null);
        load(); // Şube listesini yenile
      } else {
        toast('⚠️ Düzeltme tamamlanamadı. Lütfen tekrar deneyin.', 'red');
      }
    } catch (e) {
      toast(`❌ Hata: ${e.message}`, 'red');
    }
    finally { setLoading(false); }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header">
        <h2>🏪 Şube Ayarları</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)' }}>
          POS ve online kesinti oranlarını gir — ciro girişlerinde otomatik uygulanır
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        {subeler.map(s => {
          const posOran = parseFloat(duzenle[s.id]?.pos_oran ?? s.pos_oran ?? 0);
          const onlineOran = parseFloat(duzenle[s.id]?.online_oran ?? s.online_oran ?? 0);
          return (
            <div key={s.id} style={{
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 10, padding: '16px 20px'
            }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>🏪 {s.ad}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    💳 POS Kesinti Oranı (%)
                  </label>
                  <input type="number" step="0.01" min="0" max="10"
                    defaultValue={s.pos_oran || 0}
                    onChange={e => set(s.id, 'pos_oran', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    🌐 Online Kesinti Oranı (%)
                  </label>
                  <input type="number" step="0.01" min="0" max="10"
                    defaultValue={s.online_oran || 0}
                    onChange={e => set(s.id, 'online_oran', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
              </div>

              {(posOran > 0 || onlineOran > 0) && (
                <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.8 }}>
                  {posOran > 0 && <div>💳 10.000 ₺ POS → <strong style={{ color: 'var(--red)' }}>{fmt(10000 * posOran / 100)} kesinti</strong>, kasaya <strong style={{ color: 'var(--green)' }}>{fmt(10000 - 10000 * posOran / 100)}</strong></div>}
                  {onlineOran > 0 && <div>🌐 10.000 ₺ Online → <strong style={{ color: 'var(--red)' }}>{fmt(10000 * onlineOran / 100)} kesinti</strong>, kasaya <strong style={{ color: 'var(--green)' }}>{fmt(10000 - 10000 * onlineOran / 100)}</strong></div>}
                </div>
              )}

              <button className="btn btn-primary btn-sm" onClick={() => kaydet(s)}>
                Kaydet
              </button>
            </div>
          );
        })}
      </div>

      {/* ADIM 2: Tarih Seçim Modalı */}
      {tarihForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, width: 400 }}>
            <h3 style={{ marginBottom: 6 }}>📅 Geçmiş Kayıtları Düzelt</h3>
            <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 20 }}>
              Hangi tarih aralığındaki kasa kayıtları yeni oranla yeniden hesaplansın?
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Başlangıç</label>
                <input type="date" value={tarihForm.baslangic}
                  onChange={e => setTarihForm(f => ({ ...f, baslangic: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Bitiş</label>
                <input type="date" value={tarihForm.bitis}
                  onChange={e => setTarihForm(f => ({ ...f, bitis: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setTarihForm(null)}>İptal</button>
              <button className="btn btn-primary btn-sm" onClick={onizleGetir} disabled={loading}>
                {loading ? '⏳ Hesaplanıyor...' : 'Önizle →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADIM 3: Önizleme + Onay Modalı */}
      {onizle && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, width: 500, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: 4 }}>🔍 Düzeltme Önizleme</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
              {onizle.data.sube_adi} · {fmtDate(onizle.data.baslangic)} – {fmtDate(onizle.data.bitis)}
              · POS %{onizle.data.pos_oran} · Online %{onizle.data.online_oran}
            </p>

            {onizle.data.etkilenen_kayit === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
                ✅ Bu aralıkta düzeltme gereken kayıt yok.
              </div>
            ) : (
              <>
                <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 24 }}>
                  <div><div style={{ fontSize: 11, color: 'var(--text3)' }}>Etkilenen Kayıt</div><div style={{ fontSize: 18, fontWeight: 700 }}>{onizle.data.etkilenen_kayit}</div></div>
                  <div><div style={{ fontSize: 11, color: 'var(--text3)' }}>Toplam Kasa Etkisi</div><div style={{ fontSize: 18, fontWeight: 700, color: onizle.data.toplam_fark < 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(onizle.data.toplam_fark)}</div></div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, marginBottom: 16 }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: 'var(--text3)' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>Tarih</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Mevcut Kasa</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Doğru Kasa</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Fark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {onizle.data.satirlar.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 8px' }}>{fmtDate(r.tarih)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmt(r.mevcut_kasa)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmt(r.dogru_kasa)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: r.fark < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{fmt(r.fark)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setOnizle(null)}>İptal</button>
              {onizle.data.etkilenen_kayit > 0 && (
                <button className="btn btn-primary btn-sm" onClick={duzeltOnayla} disabled={loading}>
                  {loading ? '⏳ Düzeltiliyor...' : `✓ ${onizle.data.etkilenen_kayit} Kaydı Düzelt`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
