/**
 * Kart seçim listesi — ödeme ve kısmi ödeme modallarında ortak kullanım.
 * Props:
 *   kartlar       — API'den gelen kart dizisi
 *   seciliKartId  — seçili kart id'si
 *   onSec(kartId) — kart seçilince
 *   yukleniyor    — boolean
 *   onGeri        — geri butonu callback
 *   otomatikIlerl — true ise kart seçince otomatik bir sonraki adıma geçer (onGeri yoksa)
 */
export default function KartSecimListesi({ kartlar, seciliKartId, onSec, yukleniyor, onGeri, otomatikIlerl = false }) {
  if (yukleniyor) {
    return (
      <div style={{ textAlign: 'center', padding: 24, color: 'var(--text3)' }}>
        <div className="spinner" style={{ margin: '0 auto 8px' }} />
        Kartlar yükleniyor...
      </div>
    );
  }

  if (!kartlar?.length) {
    return (
      <div style={{ textAlign: 'center', padding: 24, color: 'var(--text3)', fontSize: 13 }}>
        Uygun kart bulunamadı.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {kartlar.map(k => (
          <button
            key={k.kart_id}
            disabled={!k.uygun}
            onClick={() => { if (k.uygun) onSec(k.kart_id); }}
            style={{
              textAlign: 'left', padding: '12px 14px', borderRadius: 8,
              cursor: k.uygun ? 'pointer' : 'not-allowed',
              border: `2px solid ${seciliKartId === k.kart_id ? 'var(--accent)' : 'var(--border)'}`,
              background: seciliKartId === k.kart_id ? 'var(--accent-dim)' : k.uygun ? 'var(--bg2)' : 'var(--bg3)',
              opacity: k.uygun ? 1 : 0.5,
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{k.banka}</span>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>{k.kart_adi}</span>
                {k.oneri && k.uygun && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                    background: 'rgba(76,175,132,0.15)', color: 'var(--green)', border: '1px solid rgba(76,175,132,0.3)'
                  }}>
                    Önerilen
                  </span>
                )}
              </div>
              <div style={{ textAlign: 'right', fontSize: 12, flexShrink: 0 }}>
                <div style={{ color: 'var(--green)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                  {parseInt(k.kalan_limit).toLocaleString('tr-TR')} ₺
                </div>
                <div style={{ color: 'var(--text3)', fontSize: 11 }}>%{k.faiz_orani} faiz</div>
              </div>
            </div>
            {k.uygun ? (
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {k.kesim_uzakligi != null && <span>Kesim: {k.kesim_uzakligi}g</span>}
                {k.son_odeme_uzakligi != null && <span>Son ödeme: {k.son_odeme_uzakligi}g</span>}
                <span>Doluluk: %{Math.round((k.limit_doluluk ?? 0) * 100)}</span>
              </div>
            ) : (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--red)' }}>{k.uygun_degil_neden}</div>
            )}
          </button>
        ))}
      </div>
      {onGeri && (
        <button className="btn btn-ghost btn-sm" onClick={onGeri}>← Geri</button>
      )}
    </div>
  );
}
