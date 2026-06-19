import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

// Merkez/telefondan verilen DENEME siparişlerini temizleme aracı (masaüstü ikiz).
// Aynı uçları kullanır: /ops/siparis/merkez-liste + /ops/siparis/merkez-test-temizle.
// GUARD backend'de: yalnızca personel_ad='MERKEZ' silinebilir.
export default function MerkezTemizlik() {
  const [liste, setListe] = useState(null);
  const [hata, setHata] = useState('');
  const [bilgi, setBilgi] = useState('');
  const [mesgul, setMesgul] = useState('');

  const yukle = useCallback(() => {
    setHata('');
    api('/ops/siparis/merkez-liste')
      .then(d => setListe(Array.isArray(d?.siparisler) ? d.siparisler : []))
      .catch(e => { setHata(e.message || 'Yüklenemedi'); setListe([]); });
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const sil = async (s) => {
    const stokUyari = s.teslim_alindi
      ? '\n\n⚠️ Bu sipariş TESLİM ALINMIŞ — eklenen stok da Tema deposundan GERİ ALINACAK.'
      : '';
    if (!window.confirm(`${s.tedarikci_ad || 'Sipariş'} (${s.sube_adi || ''}) silinsin mi?${stokUyari}\n\nBu işlem geri alınamaz.`)) return;
    setMesgul(s.talep_id); setHata(''); setBilgi('');
    try {
      const r = await api('/ops/siparis/merkez-test-temizle', {
        method: 'POST', body: { talep_id: s.talep_id, stok_geri_al: true },
      });
      const gr = Array.isArray(r?.stok_geri_alinan) ? r.stok_geri_alinan : [];
      setBilgi(gr.length ? `Silindi · stok geri alındı: ${gr.join(', ')}` : 'Silindi.');
      yukle();
    } catch (e) { setHata(e.message || 'Silinemedi'); }
    finally { setMesgul(''); }
  };

  const durumEtiket = (s) => {
    if (s.iptalli) return { t: 'iptal', renk: '#94a3b8' };
    if (s.teslim_alindi) return { t: 'teslim alındı · stok eklendi', renk: '#22c55e' };
    return { t: 'yolda/bekliyor', renk: '#f59e0b' };
  };

  return (
    <div style={{ padding: 24, maxWidth: 820 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>🧹 Merkez Sipariş Temizliği</h2>
        <button onClick={yukle} style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>↻ Yenile</button>
      </div>
      <p style={{ color: '#64748b', fontSize: 14, marginTop: 4 }}>
        Telefondan/merkezden verilen deneme siparişleri. Sil dersen sipariş kaydı kalkar;
        teslim alınmışsa eklenen stok da geri alınır. <b>Sadece MERKEZ siparişleri silinebilir.</b>
      </p>

      {bilgi && <div style={{ padding: 10, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, color: '#047857', marginBottom: 12 }}>{bilgi}</div>}
      {hata && <div style={{ padding: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 12 }}>{hata}</div>}

      {liste === null && <div style={{ color: '#94a3b8', padding: 30 }}>Yükleniyor…</div>}
      {liste && liste.length === 0 && !hata && (
        <div style={{ color: '#94a3b8', padding: 30, textAlign: 'center' }}>Merkez siparişi yok.</div>
      )}
      {(liste || []).map(s => {
        const d = durumEtiket(s);
        return (
          <div key={s.talep_id} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
            background: '#fff', border: '1px solid #e2e8f0', borderLeft: `4px solid ${d.renk}`,
            borderRadius: 12, padding: '12px 16px', marginBottom: 10,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{s.tedarikci_ad || 'Tedarikçi yok'}</div>
              <div style={{ fontSize: 13, color: '#475569', marginTop: 2 }}>{s.sube_adi || ''}{s.kalem_ozet ? ` · ${s.kalem_ozet}` : ''}</div>
              <div style={{ fontSize: 12, color: d.renk, fontWeight: 600, marginTop: 2 }}>
                {d.t}{s.olusturma ? ` · ${new Date(s.olusturma).toLocaleDateString('tr-TR')}` : ''}
              </div>
            </div>
            <button onClick={() => sil(s)} disabled={mesgul === s.talep_id} style={{
              background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8,
              padding: '9px 16px', fontWeight: 700, whiteSpace: 'nowrap',
              cursor: mesgul === s.talep_id ? 'default' : 'pointer', opacity: mesgul === s.talep_id ? 0.6 : 1,
            }}>{mesgul === s.talep_id ? 'Siliniyor…' : '🗑️ Sil'}</button>
          </div>
        );
      })}
    </div>
  );
}
