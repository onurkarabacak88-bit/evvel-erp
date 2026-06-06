import { useEffect, useState } from 'react';

const TIP_MAP = {
  green:  { gradient: 'linear-gradient(165deg, #14532d 0%, #0f172a 55%)', border: 'rgba(34,197,94,0.55)',  text: '#86efac', ikon: '✅' },
  red:    { gradient: 'linear-gradient(165deg, #450a0a 0%, #0f172a 55%)', border: 'rgba(239,68,68,0.55)',   text: '#fecaca', ikon: '❌' },
  yellow: { gradient: 'linear-gradient(165deg, #422006 0%, #0f172a 55%)', border: 'rgba(234,179,8,0.55)',   text: '#fde68a', ikon: '⚠️' },
  orange: { gradient: 'linear-gradient(165deg, #431407 0%, #0f172a 55%)', border: 'rgba(249,115,22,0.55)',  text: '#fed7aa', ikon: '🔔' },
};

/**
 * İşlem geri bildirimi — ekranın tam ortasında, blur backdrop ile.
 * Props:
 *   mesaj    — string
 *   tip      — 'green' | 'red' | 'yellow' | 'orange'  (varsayılan: 'green')
 *   basarili — boolean (geriye dönük uyumluluk; tip önceliklidir)
 *   sureMs   — otomatik kapanma süresi ms (varsayılan 3500)
 *   onKapat  — callback
 */
export default function IslemSonucOverlay({ basarili, mesaj, tip, sureMs = 3500, onKapat }) {
  const [goster, setGoster] = useState(false);

  const gercekTip = tip ?? (basarili === false ? 'red' : 'green');
  const stil = TIP_MAP[gercekTip] || TIP_MAP.green;

  useEffect(() => {
    setGoster(false);
    const t0 = requestAnimationFrame(() => setGoster(true));
    const t1 = setTimeout(() => {
      setGoster(false);
      setTimeout(() => onKapat?.(), 260);
    }, sureMs);
    return () => { cancelAnimationFrame(t0); clearTimeout(t1); };
  }, [basarili, mesaj, tip, sureMs, onKapat]);

  const kapat = () => { setGoster(false); setTimeout(() => onKapat?.(), 260); };

  return (
    <div
      role="presentation"
      onClick={kapat}
      style={{
        position: 'fixed', inset: 0, zIndex: 12000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        background: goster ? 'rgba(0,0,0,0.42)' : 'rgba(0,0,0,0)',
        backdropFilter: goster ? 'blur(4px)' : 'none',
        WebkitBackdropFilter: goster ? 'blur(4px)' : 'none',
        transition: 'background 0.22s ease, backdrop-filter 0.22s ease',
        pointerEvents: 'auto',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(92vw, 400px)',
          borderRadius: 16,
          padding: '22px 26px 24px',
          textAlign: 'center',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
          background: stil.gradient,
          border: `2px solid ${stil.border}`,
          transform: goster ? 'scale(1) translateY(0)' : 'scale(0.92) translateY(16px)',
          opacity: goster ? 1 : 0,
          transition: 'transform 0.26s cubic-bezier(0.2,0.8,0.3,1), opacity 0.22s ease',
        }}
      >
        {/* Kapat butonu */}
        <button
          type="button"
          title="Kapat"
          onClick={kapat}
          style={{
            position: 'absolute', top: 10, right: 12,
            width: 28, height: 28, border: 'none', borderRadius: 8,
            background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)',
            cursor: 'pointer', fontSize: 14, lineHeight: '28px',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.18)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
        >✕</button>

        {/* İkon */}
        <div style={{ fontSize: 32, marginBottom: 10, lineHeight: 1 }}>{stil.ikon}</div>

        {/* Başlık */}
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8, color: stil.text, letterSpacing: '0.01em' }}>
          {gercekTip === 'green' ? 'İşlem Başarılı' :
           gercekTip === 'red'   ? 'İşlem Başarısız' :
           gercekTip === 'yellow'? 'Dikkat' : 'Bilgi'}
        </div>

        {/* Mesaj */}
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.82)' }}>{mesaj}</div>

        {/* Otomatik kapanma progress bar */}
        <div style={{ marginTop: 16, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 2,
            background: stil.text,
            animation: goster ? `islemProgress ${sureMs}ms linear forwards` : 'none',
          }} />
        </div>
      </div>
    </div>
  );
}
