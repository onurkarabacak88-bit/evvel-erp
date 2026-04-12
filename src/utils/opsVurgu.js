/**
 * Operasyon merkezi kart vurgusu: tam kart / açılış bloğu / yalnızca metin.
 * Evvel CFO içi `OperasyonMerkezi.jsx` ile aynı mantık.
 */

function _tsMs(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/** Açılış olayı son teslimden sonra tamamlanmış mı (gecikerek yapıldı)? */
export function acilisGecikerekTamamlandi(events) {
  const list = events || [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.tip !== 'ACILIS' || e.durum !== 'tamamlandi') continue;
    const c = _tsMs(e.cevap_ts);
    const d = _tsMs(e.son_teslim_ts);
    if (c != null && d != null && c > d) return true;
  }
  return false;
}

/**
 * @returns {{ mode: 'card' | 'acilis' | 'ciro_text' | null }}
 */
export function computeOpsKartVurgu(k) {
  if (!k) return { mode: null };
  const b = k.bayraklar || {};
  const o = k.ozet || {};
  const op = k.operasyon || {};
  const aktif = op.aktif;
  const aktifBekliyor =
    aktif && (aktif.durum === 'bekliyor' || aktif.durum === 'gecikti');

  const ciroKantEksik =
    o.kapanis_tamam && !k.ciro_girildi && !k.ciro_taslak_bekliyor;
  const acilisGecTamam = acilisGecikerekTamamlandi(op.events);

  if (b.kritik || aktifBekliyor) return { mode: 'card' };
  if (ciroKantEksik) return { mode: 'ciro_text' };
  if (acilisGecTamam) return { mode: 'acilis' };
  return { mode: null };
}
