/**
 * CacheFreshnessBadge — Toast/Lightspeed standardı veri tazelik göstergesi
 *
 * Dünya standardı pattern:
 *   - Sol: durum ikonu (🟢/🟡/🟠/🔴/⚫)
 *   - Orta: kısa label ("Canlı" / "3 dk önce" / "Eski veri")
 *   - Sağ (opsiyonel): kaynak (⚡ Cache / 🌐 Live)
 *   - Hover: tooltip ile detay (kaç saniye, hangi endpoint)
 *
 * Kullanım:
 *   <CacheFreshnessBadge
 *     guncelleme={sonGuncelleme}
 *     kaynak={kaynak}
 *     onYenile={() => yenile()}
 *   />
 */
import { cacheFreshness, cacheTooltip } from '../utils/raporCache';

export default function CacheFreshnessBadge({
  guncelleme,
  kaynak = null,
  cacheGuncelleme = null,
  onYenile = null,
  yenileniyor = false,
  kompakt = false,
}) {
  const f = cacheFreshness(guncelleme);
  const tooltip = cacheTooltip(kaynak, guncelleme, cacheGuncelleme);

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: f.bg,
        border: `1px solid ${f.border}`,
        borderRadius: 999,
        padding: kompakt ? '2px 8px' : '4px 12px',
        fontSize: kompakt ? 10 : 11,
        fontWeight: 600,
        color: f.renk,
        cursor: 'default',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <span style={{ fontSize: kompakt ? 8 : 9 }}>{f.icon}</span>
      <span>{f.label}</span>
      {kaynak === 'cache' && (
        <span
          title="Bu veri cache'ten geldi — milisaniyede yüklendi"
          style={{
            background: 'rgba(99,102,241,0.18)',
            color: '#a5b4fc',
            borderRadius: 4,
            padding: '0 5px',
            fontSize: kompakt ? 8 : 9,
            fontWeight: 700,
            letterSpacing: '0.03em',
          }}
        >
          ⚡ CACHE
        </span>
      )}
      {kaynak === 'live' && (
        <span
          title="Bu veri canlı sorgulandı — saniye sürmüş olabilir ama en güncel hâl"
          style={{
            background: 'rgba(99,102,241,0.18)',
            color: '#c7d2fe',
            borderRadius: 4,
            padding: '0 5px',
            fontSize: kompakt ? 8 : 9,
            fontWeight: 700,
            letterSpacing: '0.03em',
          }}
        >
          🌐 LIVE
        </span>
      )}
      {onYenile && (
        <button
          type="button"
          onClick={onYenile}
          disabled={yenileniyor}
          title="Şimdi yenile"
          style={{
            background: 'transparent',
            border: 'none',
            color: f.renk,
            cursor: yenileniyor ? 'wait' : 'pointer',
            padding: '0 2px',
            fontSize: kompakt ? 10 : 12,
            opacity: yenileniyor ? 0.4 : 0.8,
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { if (!yenileniyor) e.currentTarget.style.opacity = 1; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = yenileniyor ? 0.4 : 0.8; }}
        >
          {yenileniyor ? '⏳' : '↻'}
        </button>
      )}
    </span>
  );
}
