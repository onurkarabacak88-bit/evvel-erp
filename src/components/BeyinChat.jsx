import { useState, useRef, useEffect } from 'react';
import { api } from '../utils/api';

/**
 * 🧠 BEYİN SOHBETİ — canlı yardım balonu (2026-07-08).
 * Her sayfada sağ altta durur; tıklayınca sohbet paneli açılır. Duyu Paneli'ndeki
 * BeyinSor kartıyla aynı API'yi kullanır (/beyin/sor + /beyin/cevap-etiket) —
 * sohbet hafızası (oturum_id), 👍/👎 üslup rehberi beslemesi, kaynak blokları.
 * Bileşen hep monte kalır: sayfa gezinirken sohbet KAYBOLMAZ.
 */
export default function BeyinChat() {
  const [acik, setAcik] = useState(false);
  const [soru, setSoru] = useState('');
  const [mesajlar, setMesajlar] = useState([]);
  const [oturumId, setOturumId] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const kaydirRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (kaydirRef.current) kaydirRef.current.scrollTop = kaydirRef.current.scrollHeight;
  }, [mesajlar, mesgul]);
  useEffect(() => {
    if (acik && inputRef.current) inputRef.current.focus();
  }, [acik]);

  const sor = async () => {
    const s = soru.trim();
    if (s.length < 3 || mesgul) return;
    setMesgul(true); setHata(''); setSoru('');
    setMesajlar((m) => [...m, { rol: 'sen', metin: s }]);
    try {
      const r = await api('/beyin/sor', { method: 'POST', body: { soru: s, oturum_id: oturumId } });
      if (r.oturum_id) setOturumId(r.oturum_id);
      setMesajlar((m) => [...m, { rol: 'beyin', metin: r.cevap, bloklar: r.bloklar, gunlukId: r.gunluk_id, puan: null }]);
    } catch (e) {
      setHata(e.message || 'Beyin yanıt veremedi');
    } finally { setMesgul(false); }
  };

  const etiketle = (gunlukId, karar) => {
    api('/beyin/cevap-etiket', { method: 'POST', body: { gunluk_id: gunlukId, karar } })
      .then(() => setMesajlar((ms) => ms.map((x) => x.gunlukId === gunlukId ? { ...x, puan: karar } : x)))
      .catch(() => {});
  };

  const HAZIR = ['Bugün sorunlar nedir?', 'Bu hafta ödemeleri yapabilecek miyim?', 'En çok satılan ürünler neler?'];

  return (
    <>
      {/* KAYAN BUTON */}
      {!acik && (
        <button onClick={() => setAcik(true)} title="Evvel Beyni'yle konuş"
          style={{
            position: 'fixed', right: 22, bottom: 22, zIndex: 900,
            width: 58, height: 58, borderRadius: '50%',
            background: 'var(--purple, #8b5cf6)', border: 'none', cursor: 'pointer',
            fontSize: 26, boxShadow: '0 6px 24px rgba(139,92,246,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>🧠</button>
      )}

      {/* SOHBET PANELİ */}
      {acik && (
        <div style={{
          position: 'fixed', right: 22, bottom: 22, zIndex: 900,
          width: 'min(420px, calc(100vw - 44px))', height: 'min(620px, calc(100vh - 60px))',
          background: 'var(--bg1, #12141a)', border: '1px solid var(--border)',
          borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,.5)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          {/* Başlık */}
          <div style={{
            padding: '12px 14px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'var(--bg2)',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text1, #e8e9ec)' }}>🧠 Evvel Beyni</div>
              <div style={{ fontSize: 10, color: 'var(--text3)' }}>sohbet hafızalı · isim vermez · karar senin</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {mesajlar.length > 0 && (
                <button onClick={() => { setMesajlar([]); setOturumId(null); setHata(''); }}
                  title="Yeni sohbet"
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text3)', cursor: 'pointer', fontSize: 11, padding: '3px 9px' }}>🆕</button>
              )}
              <button onClick={() => setAcik(false)} title="Kapat"
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text3)', cursor: 'pointer', fontSize: 12, padding: '3px 9px' }}>✕</button>
            </div>
          </div>

          {/* Mesajlar */}
          <div ref={kaydirRef} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {mesajlar.length === 0 && (
              <div>
                <div style={{ fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.6, marginBottom: 12 }}>
                  Kayıtları anlatırım, kayda işaret ederim; karar vermem, isim vermem.
                  Sordukça gelişirim: 👍 verdiğin cevaplar üslubumu, cevaplayamadıklarım
                  dilek defterimi besler.
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 6, fontWeight: 700 }}>Örnek sorular:</div>
                {HAZIR.map((h) => (
                  <button key={h} onClick={() => { setSoru(h); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
                      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
                      color: 'var(--text2)', cursor: 'pointer', fontSize: 12.5, padding: '9px 12px',
                    }}>{h}</button>
                ))}
              </div>
            )}
            {mesajlar.map((m, i) => (
              <div key={i} style={{
                background: m.rol === 'sen' ? 'var(--bg2)' : 'var(--bg, #0b0d12)',
                border: m.rol === 'sen' ? '1px solid var(--border)' : '1px solid var(--purple, #8b5cf6)',
                borderRadius: 10, padding: '9px 11px', marginBottom: 8,
                marginLeft: m.rol === 'sen' ? 30 : 0, marginRight: m.rol === 'sen' ? 0 : 30,
              }}>
                <div style={{ fontSize: 12.5, color: 'var(--text1, #e8e9ec)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{m.metin}</div>
                {m.rol === 'beyin' && (
                  <div style={{ fontSize: 9, color: 'var(--text3)', marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{m.bloklar && m.bloklar.length > 0 ? m.bloklar.map((b) => b.id).join(' ') : ''}</span>
                    {m.gunlukId && (
                      m.puan ? (
                        <span style={{ fontSize: 10.5 }}>{m.puan === 'iyi' ? '👍 üslup rehberine girdi' : '👎'}</span>
                      ) : (
                        <span>
                          <button title="iyi cevap" onClick={() => etiketle(m.gunlukId, 'iyi')}
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '1px 6px', marginRight: 4 }}>👍</button>
                          <button title="kötü cevap" onClick={() => etiketle(m.gunlukId, 'kotu')}
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}>👎</button>
                        </span>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
            {mesgul && <div style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 0' }}>💭 düşünüyor…</div>}
            {hata && <div style={{ color: 'var(--red, #ef4444)', fontSize: 12, marginTop: 6 }}>⚠️ {hata}</div>}
          </div>

          {/* Giriş */}
          <div style={{ padding: 10, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, background: 'var(--bg2)' }}>
            <input ref={inputRef} value={soru} onChange={(e) => setSoru(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sor(); }}
              placeholder={mesajlar.length ? 'Takip sorunu yaz…' : 'Sorunu yaz…'} disabled={mesgul}
              style={{ flex: 1, background: 'var(--bg)', color: 'var(--text1, #e8e9ec)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 13 }} />
            <button onClick={sor} disabled={mesgul || soru.trim().length < 3} style={{
              background: 'var(--purple, #8b5cf6)', color: '#fff', border: 'none', borderRadius: 10,
              padding: '10px 16px', fontSize: 13, fontWeight: 800,
              cursor: mesgul ? 'default' : 'pointer', opacity: mesgul || soru.trim().length < 3 ? 0.55 : 1,
            }}>{mesgul ? '💭' : 'Sor'}</button>
          </div>
        </div>
      )}
    </>
  );
}
