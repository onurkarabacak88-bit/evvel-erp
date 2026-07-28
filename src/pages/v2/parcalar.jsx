// ─────────────────────────────────────────────────────────────────────────────
// EVVEL v2 — ortak parçalar (KPI şeridi, hero, liste, tablo, çekmece, toast)
// Tasarım kaynağı: tasarim/cloud-v2/03_evvel-erp-v2_GUNCEL.dc.html
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { R, F, kartYuzey, TIER_RENK } from './tema';

/** Tasarımdaki inline SVG ikonları (ham path stringi) React'e bağlar. */
export function Ikon({ yol, boyut = 21 }) {
  return (
    <svg
      width={boyut} height={boyut} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: yol }}
    />
  );
}

/** Sayı dizisinden sparkline yolu üretir → { cizgi, alan } */
export function sparkYol(degerler, en = 640, boy = 120) {
  const d = (degerler || []).filter(v => Number.isFinite(v));
  if (d.length < 2) return { cizgi: '', alan: '' };
  const enB = Math.max(...d);
  const enK = Math.min(...d);
  const aralik = enB - enK || 1;
  const adim = en / (d.length - 1);
  // y ekseni ters: yüksek değer yukarıda (küçük y)
  const nokta = (v, i) => `${(i * adim).toFixed(1)} ${(boy - 8 - ((v - enK) / aralik) * (boy - 22)).toFixed(1)}`;
  const cizgi = d.map((v, i) => `${i === 0 ? 'M' : 'L'}${nokta(v, i)}`).join(' ');
  return { cizgi, alan: `${cizgi} L${en} ${boy} L0 ${boy} Z` };
}

// ─── KPI şeridi ──────────────────────────────────────────────────────────────
export function KpiSeridi({ kpiler }) {
  if (!kpiler?.length) return null;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))',
      gap: 11, marginBottom: 16,
    }}>
      {kpiler.map((k, i) => (
        <div key={i} style={{ ...kartYuzey, borderRadius: 15, padding: '14px 16px', boxShadow: '0 12px 28px rgba(0,0,0,.3)' }}>
          <div style={{ fontSize: 10, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not, fontWeight: 700 }}>
            {k.etiket}
          </div>
          <div style={{
            whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 22, fontWeight: 700,
            marginTop: 5, color: k.renk || R.krem,
          }}>
            {k.deger}
          </div>
          <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>{k.alt}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Hero (büyük rakam + sparkline + ikincil kartlar) ────────────────────────
export function Hero({ etiket, deger, delta, deltaTip = 'iyi', not, seri, ikincil, onIkincil }) {
  const { cizgi, alan } = sparkYol(seri);
  const deltaRenk = deltaTip === 'kotu' ? R.kirmizi : deltaTip === 'notr' ? R.amber : R.yesil;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 12, marginBottom: 16 }}>
      <div style={{
        position: 'relative', overflow: 'hidden',
        background: `linear-gradient(165deg, ${R.kartUst1}, ${R.kartUst2})`,
        border: '1px solid rgba(243,233,220,.1)', borderRadius: 20, padding: '22px 24px 0',
        boxShadow: '0 16px 38px rgba(0,0,0,.38), inset 0 0 0 1px rgba(217,154,78,.14), 0 0 70px rgba(217,154,78,.07)',
      }}>
        <div style={{ fontSize: 10.5, letterSpacing: '1px', textTransform: 'uppercase', color: R.not, fontWeight: 700 }}>
          {etiket}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 13, marginTop: 9, flexWrap: 'wrap' }}>
          <div style={{
            whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 44, fontWeight: 700,
            letterSpacing: '-2px', lineHeight: 1, color: R.krem,
          }}>
            {deger}
          </div>
          {delta && (
            <span style={{
              padding: '4px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 700,
              background: `${deltaRenk}22`, color: deltaRenk,
            }}>
              {delta}
            </span>
          )}
        </div>
        {not && (
          <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 10, lineHeight: 1.6, maxWidth: 600 }}>
            {not}
          </div>
        )}
        <svg viewBox="0 0 640 120" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 116, marginTop: 12 }}>
          <defs>
            <linearGradient id="v2herofill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={R.bakir} stopOpacity=".3" />
              <stop offset="100%" stopColor={R.bakir} stopOpacity="0" />
            </linearGradient>
          </defs>
          {alan && <path d={alan} fill="url(#v2herofill)" />}
          {cizgi && (
            <path
              d={cizgi} fill="none" stroke={R.bakir} strokeWidth="2.4"
              strokeLinejoin="round" strokeLinecap="round" strokeDasharray="640"
              style={{ animation: 'v2cizim 1.1s cubic-bezier(.22,1,.36,1) .12s both' }}
            />
          )}
        </svg>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {(ikincil || []).map((h, i) => (
          <div
            key={i}
            onClick={() => onIkincil?.(h)}
            className="v2-hover-kalk"
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              ...kartYuzey, borderRadius: 15, padding: '13px 16px', cursor: onIkincil ? 'pointer' : 'default',
              boxShadow: 'none',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, letterSpacing: '.6px', textTransform: 'uppercase', color: R.not, fontWeight: 700 }}>
                {h.etiket}
              </div>
              <div style={{ fontSize: 11.5, color: R.not2, marginTop: 3 }}>{h.alt}</div>
            </div>
            <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 17, fontWeight: 700, color: h.renk || R.krem }}>
              {h.deger}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Bulgu / öneri listesi ───────────────────────────────────────────────────
export function Liste({ satirlar, onAc }) {
  if (!satirlar?.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {satirlar.map((l, i) => {
        const renk = TIER_RENK[l.tier] || R.mavi;
        return (
          <div
            key={l.id || i}
            onClick={() => onAc?.(l)}
            className="v2-hover-kalk"
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 14,
              padding: '13px 16px 13px 18px', borderRadius: 14, overflow: 'hidden',
              background: `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`,
              border: '1px solid rgba(243,233,220,.09)',
              cursor: onAc ? 'pointer' : 'default',
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: renk }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{l.baslik}</div>
              <div style={{ fontSize: 11.5, color: R.not2, marginTop: 3 }}>{l.alt}</div>
            </div>
            {l.tutar && (
              <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: renk }}>
                {l.tutar}
              </div>
            )}
            {l.aksiyon && (
              <button
                onClick={(e) => { e.stopPropagation(); onAc?.(l); }}
                style={{
                  flexShrink: 0, padding: '6px 13px', borderRadius: 9, border: `1px solid ${R.cizgi3}`,
                  background: R.cizgi, color: R.krem, fontSize: 12, fontWeight: 600,
                  fontFamily: 'inherit', cursor: 'pointer',
                }}
              >
                {l.aksiyon}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Tablo ───────────────────────────────────────────────────────────────────
export function Tablo({ baslik, not, kolonlar, satirlar, onSatir }) {
  return (
    <div style={{ ...kartYuzey, overflow: 'hidden', marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 20px 13px', borderBottom: `1px solid ${R.cizgi2}`,
      }}>
        <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>{baslik}</span>
        {not && <span style={{ fontSize: 11, color: R.not2 }}>{not}</span>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr>
              {kolonlar.map((k, i) => (
                <th key={i} style={{
                  padding: '11px 20px', textAlign: k.sag ? 'right' : 'left',
                  fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase',
                  color: R.not2, fontWeight: 700, borderBottom: `1px solid ${R.cizgi2}`,
                  whiteSpace: 'nowrap',
                }}>
                  {k.ad}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {satirlar.map((s, si) => (
              <tr
                key={s.id || si}
                onClick={() => onSatir?.(s)}
                className="v2-satir"
                style={{ cursor: onSatir ? 'pointer' : 'default' }}
              >
                {s.hucreler.map((h, hi) => (
                  <td key={hi} style={{
                    padding: '12px 20px', borderBottom: `1px solid ${R.cizgi2}`,
                    textAlign: h.sag ? 'right' : 'left',
                    fontFamily: h.mono ? F.mono : 'inherit',
                    fontWeight: h.kalin ? 700 : 400,
                    color: h.renk || R.krem,
                    whiteSpace: h.mono ? 'nowrap' : 'normal',
                  }}>
                    {h.rozet ? (
                      <span style={{
                        padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                        background: `${h.rozet}22`, color: h.rozet, whiteSpace: 'nowrap',
                      }}>
                        {h.v}
                      </span>
                    ) : h.bar != null ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-end' }}>
                        <span style={{ width: 82, height: 6, borderRadius: 99, background: R.cizgi2, overflow: 'hidden', display: 'block' }}>
                          <span style={{
                            display: 'block', height: '100%', borderRadius: 99,
                            width: `${Math.max(0, Math.min(100, h.bar))}%`, background: h.renk || R.yesil,
                          }} />
                        </span>
                        <span style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 12.5, fontWeight: 700 }}>{h.v}</span>
                      </span>
                    ) : h.v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Detay çekmecesi ─────────────────────────────────────────────────────────
export function Cekmece({ acik, tip, baslik, alt, kpi, listeBaslik, satirlar, not, aksiyonAd, onAksiyon, onKapat }) {
  if (!acik) return null;
  return (
    <>
      <div
        onClick={onKapat}
        style={{
          position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,6,2,.6)',
          backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
          animation: 'v2belir .2s ease both',
        }}
      />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 448, maxWidth: '92vw', zIndex: 90,
        display: 'flex', flexDirection: 'column',
        background: `linear-gradient(180deg, #241A10, #1B1309)`,
        borderLeft: `1px solid ${R.cizgi3}`, boxShadow: '-24px 0 60px rgba(0,0,0,.5)',
        animation: 'v2kay .42s cubic-bezier(.4,0,.2,1) both',
      }}>
        <div style={{ padding: '20px 22px 16px', borderBottom: `1px solid ${R.cizgi}` }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: '1px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
                {tip}
              </div>
              <div style={{ fontFamily: F.baslik, fontSize: 20, fontWeight: 600, lineHeight: 1.25, marginTop: 4 }}>
                {baslik}
              </div>
              <div style={{ fontSize: 12, color: R.not, marginTop: 5, lineHeight: 1.5 }}>{alt}</div>
            </div>
            <button onClick={onKapat} style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: 8, border: `1px solid ${R.cizgi3}`,
              background: R.cizgi, color: R.metin2, fontSize: 15, fontFamily: 'inherit',
              cursor: 'pointer', lineHeight: 1,
            }}>×</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!!kpi?.length && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
              {kpi.map((k, i) => (
                <div key={i} style={{ background: R.kart1, border: '1px solid rgba(243,233,220,.08)', borderRadius: 13, padding: '12px 14px' }}>
                  <div style={{ fontSize: 9.5, letterSpacing: '.7px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
                    {k.etiket}
                  </div>
                  <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 16, fontWeight: 700, marginTop: 4, color: k.renk || R.krem }}>
                    {k.deger}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!satirlar?.length && (
            <div>
              <div style={{
                fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2,
                fontWeight: 700, paddingBottom: 9, borderBottom: `1px solid ${R.cizgi}`, marginBottom: 11,
              }}>
                {listeBaslik}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {satirlar.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{s.ad}</div>
                      <div style={{ fontSize: 11, color: R.not2, marginTop: 2 }}>{s.detay}</div>
                    </div>
                    <span style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, flexShrink: 0, color: R.metin2 }}>
                      {s.tutar}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {not && (
            <div style={{
              padding: '13px 15px', borderRadius: 13, background: 'rgba(217,154,78,.09)',
              border: '1px solid rgba(217,154,78,.28)', fontSize: 12.5, color: '#E7DCCB', lineHeight: 1.6,
            }}>
              {not}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: `1px solid ${R.cizgi}`, display: 'flex', gap: 9 }}>
          {aksiyonAd && (
            <button onClick={onAksiyon} style={{
              flex: 1, padding: 10, borderRadius: 10, border: 'none',
              background: `linear-gradient(150deg, #D99A4E, #B06E2C)`, color: '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            }}>
              {aksiyonAd}
            </button>
          )}
          <button onClick={onKapat} style={{
            padding: '10px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
            background: 'transparent', color: R.not, fontSize: 12.5, fontWeight: 600,
            fontFamily: 'inherit', cursor: 'pointer',
          }}>
            Kapat
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────
export function Toast({ metin }) {
  if (!metin) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 26, left: '50%', transform: 'translateX(-50%)', zIndex: 200,
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 12,
      background: '#312415', border: '1px solid rgba(217,154,78,.3)', color: R.krem,
      fontSize: 13, fontWeight: 600, boxShadow: '0 16px 38px rgba(0,0,0,.5)',
      animation: 'v2yuksel .22s cubic-bezier(.22,1,.36,1) both',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: R.bakir }} />
      {metin}
    </div>
  );
}

// ─── Boş / köprü durumu ──────────────────────────────────────────────────────
export function KopruDurumu({ ad, onGit }) {
  return (
    <div style={{
      ...kartYuzey, padding: '46px 30px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
    }}>
      <div style={{ fontFamily: F.baslik, fontSize: 19, fontWeight: 600 }}>
        {ad} henüz v2 tasarımına geçmedi
      </div>
      <div style={{ fontSize: 13, color: R.not, lineHeight: 1.6, maxWidth: 460 }}>
        Bu ekran şimdilik mevcut tasarımıyla çalışıyor. Kadife koyu tema pilot onayından
        sonra sıraya alınacak — veriler ve işleyiş aynen duruyor.
      </div>
      {onGit && (
        <button onClick={onGit} style={{
          marginTop: 4, padding: '10px 20px', borderRadius: 10, border: 'none',
          background: `linear-gradient(150deg, #D99A4E, #B06E2C)`, color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>
          Mevcut ekranı aç
        </button>
      )}
    </div>
  );
}
