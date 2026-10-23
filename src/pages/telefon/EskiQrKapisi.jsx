// 🔀 ESKİ QR KAPISI — /gorev-giris/{sube} · /gorev-pin (şubelerde basılı eski QR, telefona kaydedilmiş eski link).
// 1 Kasım kesiminden sonra (TEK kural: sunucu /evvel-yeni/moduller/gecis (çekirdek, her zaman yüklü) = çekirdek eski_panel_zinciri_acik) yeni telefon evine (/q)
// yönlenir (?eski=1 → /q'da 'eski QR' ipucu); öncesinde eski sayfa aynen açılır. Sunucuya ulaşılamazsa eski sayfa açılır — ama kesimden sonra
// eski yazıcı uçlar SUNUCUDA 410 döner (gorev_api._eski_kapi), iki defter riski yok.
import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import GorevGiris from '../GorevGiris';

export default function EskiQrKapisi({ subeId }) {
  const [eski, setEski] = useState(false);
  useEffect(() => {
    let iptal = false;
    api('/evvel-yeni/moduller/gecis')
      .then((r) => { if (iptal) return; if (r?.yeni) window.location.replace('/q?eski=1'); else setEski(true); })
      .catch(() => { if (!iptal) setEski(true); });
    return () => { iptal = true; };
  }, []);
  if (!eski) return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui', color: '#6E6152' }}>Açılıyor…</div>;
  return <GorevGiris subeId={subeId} />;
}
