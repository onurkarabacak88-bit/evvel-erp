import { useEffect, useState } from 'react';

/**
 * Şube panelindeki «İşlem başarılı» kutusu — ortada küçük modal, varsayılan 5 sn.
 */
export default function IslemSonucOverlay({ basarili, mesaj, sureMs = 5000, onKapat }) {
  const [goster, setGoster] = useState(false);

  useEffect(() => {
    setGoster(false);
    const t0 = requestAnimationFrame(() => setGoster(true));
    const t1 = setTimeout(() => {
      setGoster(false);
      setTimeout(() => onKapat?.(), 280);
    }, sureMs);
    return () => {
      cancelAnimationFrame(t0);
      clearTimeout(t1);
    };
  }, [basarili, mesaj, sureMs, onKapat]);

  const kapat = () => {
    setGoster(false);
    setTimeout(() => onKapat?.(), 280);
  };

  return (
    <div
      role="presentation"
      onClick={kapat}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        background: 'rgba(0, 0, 0, 0.45)',
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
        opacity: goster ? 1 : 0,
        transition: 'opacity 0.22s ease',
        pointerEvents: 'auto',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-live="assertive"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(92vw, 380px)',
          borderRadius: 14,
          padding: '18px 22px 20px',
          textAlign: 'center',
          boxShadow: '0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)',
          transform: goster ? 'scale(1)' : 'scale(0.94)',
          opacity: goster ? 1 : 0,
          transition: 'transform 0.22s ease, opacity 0.22s ease',
          background: basarili
            ? 'linear-gradient(165deg, #14532d 0%, #0f172a 55%)'
            : 'linear-gradient(165deg, #450a0a 0%, #0f172a 55%)',
          border: basarili
            ? '2px solid rgba(34, 197, 94, 0.55)'
            : '2px solid rgba(239, 68, 68, 0.55)',
        }}
      >
        <button
          type="button"
          title="Kapat"
          onClick={kapat}
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            width: 28,
            height: 28,
            border: 'none',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.08)',
            color: 'var(--text3)',
            cursor: 'pointer',
            fontSize: 16,
          }}
        >
          ✕
        </button>
        <div
          style={{
            fontSize: 17,
            fontWeight: 800,
            marginBottom: 8,
            color: basarili ? '#86efac' : '#fecaca',
          }}
        >
          {basarili ? 'İşlem başarılı' : 'İşlem başarısız'}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--text)' }}>{mesaj}</div>
      </div>
    </div>
  );
}
