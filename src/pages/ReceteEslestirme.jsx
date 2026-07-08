import { useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';

/**
 * 🔗 REÇETE EŞLEŞTİRME (2026-07-08) — elle eşleştirme ekranı.
 * Reçete kontrolünün iki köprüsü insan eliyle kurulur/denetlenir:
 *   ÜRÜN: reçete ürünü ↔ Evo satış adı (beklenen tüketimin kaynağı)
 *   MALZEME: reçete malzemesi ↔ depo kalemi (gerçek tüketimin kaynağı)
 * Otomatik öneriler burada onaylanır/reddedilir; elle yeni eşleştirme eklenir.
 */

const S = {
  kart: { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 16 },
  baslik: { fontSize: 15, fontWeight: 800, color: 'var(--text1, #e8e9ec)', marginBottom: 4 },
  alt: { fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.5, marginBottom: 10 },
  btn: (renk) => ({ background: 'transparent', border: `1px solid ${renk}`, borderRadius: 8, color: renk, cursor: 'pointer', fontSize: 11.5, padding: '3px 10px', marginLeft: 6 }),
  sec: { background: 'var(--bg)', color: 'var(--text1, #e8e9ec)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, maxWidth: 320 },
  satir: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: 12.5, color: 'var(--text2)' },
};

export default function ReceteEslestirme() {
  const [tip, setTip] = useState('malzeme');
  const [liste, setListe] = useState([]);
  const [adaylar, setAdaylar] = useState(null);
  const [kaynak, setKaynak] = useState('');
  const [hedef, setHedef] = useState('');
  const [mesaj, setMesaj] = useState('');
  const [mesgul, setMesgul] = useState(false);

  const yukle = useCallback(() => {
    api('/recete/eslestirmeler').then((r) => setListe(r.eslestirmeler || [])).catch(() => {});
    api('/recete/eslestirme-adaylar').then(setAdaylar).catch(() => {});
  }, []);
  useEffect(() => { yukle(); }, [yukle]);

  const karar = (id, k) => {
    api('/recete/eslestirme-karar', { method: 'POST', body: { id, karar: k } })
      .then(() => { setMesaj(k === 'onayli' ? '✅ onaylandı' : k === 'reddedildi' ? '❌ reddedildi' : '↩️ geri alındı'); yukle(); })
      .catch((e) => setMesaj('⚠️ ' + e.message));
  };

  const ekle = () => {
    if (!kaynak || !hedef) { setMesaj('⚠️ iki taraf da seçilmeli'); return; }
    setMesgul(true);
    const body = { tip, kaynak_ad: kaynak, hedef_ad: hedef };
    if (tip === 'malzeme') {
      const k = (adaylar?.depo_kalemler || []).find((x) => x.kalem_adi === hedef);
      if (!k) { setMesaj('⚠️ depo kalemi bulunamadı'); setMesgul(false); return; }
      body.hedef_kod = k.kalem_kodu;
    }
    api('/recete/eslestirme-ekle', { method: 'POST', body })
      .then(() => { setMesaj('✅ elle eşleştirme kuruldu (onaylı)'); setKaynak(''); setHedef(''); yukle(); })
      .catch((e) => setMesaj('⚠️ ' + e.message))
      .finally(() => setMesgul(false));
  };

  const oneriler = liste.filter((e) => e.tip === tip && e.durum === 'oneri');
  const onaylilar = liste.filter((e) => e.tip === tip && e.durum === 'onayli');
  const kaynakListe = tip === 'urun' ? (adaylar?.recete_urunler || []) : (adaylar?.recete_malzemeler || []);
  const hedefListe = tip === 'urun' ? (adaylar?.evo_adlar || []) : (adaylar?.depo_kalemler || []).map((k) => k.kalem_adi);

  return (
    <div style={{ padding: 20, maxWidth: 980 }}>
      <div style={{ fontSize: 19, fontWeight: 800, color: 'var(--text1, #e8e9ec)', marginBottom: 4 }}>🔗 Reçete Eşleştirme</div>
      <div style={{ ...S.alt, marginBottom: 14 }}>
        Reçete kontrolünün köprüleri: <b>ÜRÜN</b> = reçete ↔ Evo satış adı (beklenen tüketim) ·{' '}
        <b>MALZEME</b> = reçete ↔ depo kalemi (gerçek tüketim). Eşleşme olmadan o kalem kıyasa girmez.
      </div>

      <div style={{ marginBottom: 14 }}>
        {['malzeme', 'urun'].map((t) => (
          <button key={t} onClick={() => { setTip(t); setKaynak(''); setHedef(''); }}
            style={{
              background: tip === t ? 'var(--purple, #9b72d4)' : 'var(--bg2)',
              color: tip === t ? '#fff' : 'var(--text2)',
              border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer',
              fontSize: 13, fontWeight: 700, padding: '8px 18px', marginRight: 8,
            }}>{t === 'malzeme' ? '🧴 Malzeme ↔ Depo' : '☕ Ürün ↔ Evo Satış'}</button>
        ))}
        {mesaj && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 10 }}>{mesaj}</span>}
      </div>

      {/* ELLE EŞLEŞTİRME */}
      <div style={{ ...S.kart, borderLeft: '3px solid var(--green, #4caf84)' }}>
        <div style={S.baslik}>➕ Elle Eşleştir</div>
        <div style={S.alt}>Sol: reçetedeki ad · Sağ: {tip === 'urun' ? 'Evo satış adı' : 'depo kalemi'}. Elle kurulan eşleşme doğrudan ONAYLI sayılır (insan kararı).</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={kaynak} onChange={(e) => setKaynak(e.target.value)} style={S.sec}>
            <option value="">— reçetedeki {tip === 'urun' ? 'ürün' : 'malzeme'} —</option>
            {kaynakListe.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span style={{ color: 'var(--text3)' }}>→</span>
          <select value={hedef} onChange={(e) => setHedef(e.target.value)} style={S.sec}>
            <option value="">— {tip === 'urun' ? 'Evo satış adı' : 'depo kalemi'} —</option>
            {hedefListe.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button onClick={ekle} disabled={mesgul} style={{
            background: 'var(--green, #4caf84)', color: '#fff', border: 'none', borderRadius: 10,
            padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer', opacity: mesgul ? 0.6 : 1,
          }}>Eşleştir</button>
        </div>
      </div>

      {/* BEKLEYEN ÖNERİLER */}
      <div style={{ ...S.kart, borderLeft: '3px solid var(--yellow, #e8c547)' }}>
        <div style={S.baslik}>⏳ Bekleyen Öneriler ({oneriler.length})</div>
        <div style={S.alt}>Sistemin isim benzerliğinden ürettiği adaylar — sen onaylamadan hiçbiri kullanılmaz.</div>
        {oneriler.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>Bekleyen öneri yok 🎉</div>}
        {oneriler.map((e) => (
          <div key={e.id} style={S.satir}>
            <span><b style={{ color: 'var(--text1, #e8e9ec)' }}>{e.kaynak_ad}</b>
              <span style={{ color: 'var(--text3)' }}> → </span>{e.hedef_ad}
              <span style={{ color: 'var(--text3)', fontSize: 10.5 }}> ({e.benzerlik})</span></span>
            <span>
              <button style={S.btn('var(--green, #4caf84)')} onClick={() => karar(e.id, 'onayli')}>✓ Onayla</button>
              <button style={S.btn('var(--red, #e05c5c)')} onClick={() => karar(e.id, 'reddedildi')}>✗ Reddet</button>
            </span>
          </div>
        ))}
      </div>

      {/* ONAYLILAR */}
      <div style={{ ...S.kart, borderLeft: '3px solid var(--blue, #5b9bd6)' }}>
        <div style={S.baslik}>✅ Onaylı Eşleşmeler ({onaylilar.length})</div>
        <div style={S.alt}>Kıyasta kullanılanlar. Yanlış gördüğünü geri alabilirsin — kıyastan anında çıkar.</div>
        {onaylilar.map((e) => (
          <div key={e.id} style={S.satir}>
            <span><b style={{ color: 'var(--text1, #e8e9ec)' }}>{e.kaynak_ad}</b>
              <span style={{ color: 'var(--text3)' }}> → </span>{e.hedef_ad}
              {e.benzerlik == null && <span style={{ color: 'var(--green, #4caf84)', fontSize: 10.5 }}> (elle)</span>}</span>
            <button style={S.btn('var(--text3)')} onClick={() => karar(e.id, 'oneri')}>↩️ Geri al</button>
          </div>
        ))}
      </div>
    </div>
  );
}
