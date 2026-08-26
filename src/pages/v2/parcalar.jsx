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
// ➕ EKLENTİ (2026-08-16): `sik` = SIKI mod. Bakış'ın "sabah kokpiti" mozaiği
// tek ekrana sığmak zorunda (1366×720 kaydırmasız); orada şerit bir BANDIN
// içinde durduğu için kendi alt boşluğunu da taşımamalı. Bayrağı VERMEYEN
// 13 modül birebir eski ölçülerde kalır (varsayılanlar değişmedi).
export function KpiSeridi({ kpiler, sik }) {
  if (!kpiler?.length) return null;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(178px,1fr))',
      gap: sik ? 9 : 11, marginBottom: sik ? 0 : 16,
    }}>
      {kpiler.map((k, i) => (
        // 🖱️ TIKLANABİLİR KPI (2026-08-17, sahip: "kasaya tıkladığımda ayrımları
        // görebilmeliyim"). `onTikla` VEREN kpi tıklanır; vermeyen hiç etkilenmez
        // (undefined → eski davranış birebir). Klavye erişimi de açılır, yoksa
        // fare olmadan ulaşılamayan bir bilgi kalırdı.
        <div
          key={i}
          onClick={k.onTikla}
          tabIndex={k.onTikla ? 0 : undefined}
          role={k.onTikla ? 'button' : undefined}
          onKeyDown={k.onTikla ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); k.onTikla(); }
          } : undefined}
          className={k.onTikla ? 'v2-hover-kalk' : undefined}
          style={{
            ...kartYuzey, borderRadius: 15,
            padding: sik ? '9px 14px' : '14px 16px',
            boxShadow: '0 12px 28px rgba(0,0,0,.3)',
            cursor: k.onTikla ? 'pointer' : 'default',
          }}
        >
          <div style={{ fontSize: 10, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not, fontWeight: 700, lineHeight: sik ? 1.2 : 'normal', display: 'flex', alignItems: 'center', gap: 5 }}>
            {k.etiket}
            {/* Tıklanabilirliğin görünür işareti — yoksa kullanıcı bilgiyi arar */}
            {k.onTikla && <span style={{ fontSize: 9, color: R.not2, letterSpacing: 0 }}>▸</span>}
          </div>
          <div style={{
            whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: sik ? 20 : 22, fontWeight: 700,
            marginTop: sik ? 2 : 5, lineHeight: sik ? 1.15 : 'normal', color: k.renk || R.krem,
          }}>
            {k.deger}
          </div>
          {/* 📉 DEĞİŞİM SATIRI (2026-08-26) — "dünden beri +50.400 · 2 yeni kalem".
              Envanter alışkanlık yapar, değişim yapmaz: sabit rakam üçüncü günden
              sonra duvar kâğıdıdır. YALNIZ modül gerçek bir karşılaştırma tabanı
              verirse çizilir; taban yoksa satır HİÇ ÇIKMAZ (uydurma delta yok). */}
          {k.delta && (
            <div style={{
              fontSize: 10.5, marginTop: 2, lineHeight: 1.3,
              color: k.deltaRenk || R.not2, fontFamily: F.mono,
            }}>
              {k.delta}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10, marginTop: sik ? 1 : 3 }}>
            <div style={{ fontSize: 11, color: R.not2, lineHeight: sik ? 1.25 : 'normal' }}>{k.alt}</div>
            {/* ⚠️ Sparkline YALNIZ gerçek zaman serisi verilirse çizilir.
                Blueprint "etiket+değerden seed'lenen sözde-rastgele seri"
                öneriyor — o uydurma grafiktir, sahte sayı yasağını çiğner.
                Serisi olmayan KPI'da çizgi HİÇ çıkmaz. */}
            {Array.isArray(k.seri) && k.seri.filter(Number.isFinite).length > 2 && (() => {
              const s = k.seri.filter(Number.isFinite);
              const enB = Math.max(...s); const enK = Math.min(...s);
              const ar = enB - enK || 1;
              const nk = (v, idx) => `${((idx / (s.length - 1)) * 74).toFixed(1)},${(22 - ((v - enK) / ar) * 19).toFixed(1)}`;
              const yol = s.map((v, idx) => `${idx === 0 ? 'M' : 'L'}${nk(v, idx)}`).join(' ');
              const yon = s[s.length - 1] - s[0];
              const renk = k.renk || R.bakir;
              return (
                <svg width="74" height="24" viewBox="0 0 74 24" style={{ display: 'block', flexShrink: 0, overflow: 'visible' }}>
                  <path d={`${yol} L74,24 L0,24 Z`} fill={renk} opacity=".14" />
                  <path d={yol} fill="none" stroke={renk} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  {yon !== 0 && (
                    <text x="74" y="7" textAnchor="end" fontSize="9" fill={yon > 0 ? R.yesil : R.kirmizi}>
                      {yon > 0 ? '↗' : '↘'}
                    </text>
                  )}
                </svg>
              );
            })()}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Hero (büyük rakam + sparkline + ikincil kartlar) ────────────────────────
export function Hero({
  etiket, deger, delta, deltaTip = 'iyi', not, seri, ikincil, onIkincil,
  seriEtiket, seriAd = 'değer', seriBicim,
}) {
  const { cizgi, alan } = sparkYol(seri);
  const deltaRenk = deltaTip === 'kotu' ? R.kirmizi : deltaTip === 'notr' ? R.amber : R.yesil;

  // ── Etkileşimli grafik (yeni handoff): fareyle gez → crosshair + tooltip.
  // Gösterilen sayı SERİNİN GERÇEK DEĞERİDİR — çizginin y'sinden geri
  // hesaplanmaz (yuvarlama hatası olmasın, rakam grafikten sapmasın).
  const [imlec, setImlec] = React.useState(null);   // {i, x}
  const d = (seri || []).filter((v) => Number.isFinite(v));
  const nokta = (i) => {
    const enB = Math.max(...d); const enK = Math.min(...d);
    const aralik = enB - enK || 1;
    return {
      x: (i * (640 / (d.length - 1))),
      y: 120 - 8 - ((d[i] - enK) / aralik) * (120 - 22),
    };
  };
  const grafGez = (e) => {
    if (d.length < 2) return;
    const kutu = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - kutu.left) / kutu.width));
    setImlec({ i: Math.round(t * (d.length - 1)), oran: t });
  };
  const okunan = imlec ? d[imlec.i] : null;
  const okunanEtiket = imlec && seriEtiket?.[imlec.i];
  const bicimle = (v) => (seriBicim ? seriBicim(v) : String(v));
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
        <div
          onMouseMove={grafGez}
          onMouseLeave={() => setImlec(null)}
          style={{ position: 'relative', cursor: d.length > 1 ? 'crosshair' : 'default', marginTop: 12 }}
        >
          <svg viewBox="0 0 640 120" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 116 }}>
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
            {imlec && d.length > 1 && (() => {
              const p = nokta(imlec.i);
              return (
                <>
                  <line
                    x1={p.x} y1="0" x2={p.x} y2="120"
                    stroke="rgba(229,178,122,.45)" strokeWidth="1"
                    strokeDasharray="4 4" vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={p.x} cy={p.y} r="7" fill={R.bakirAcik}
                    stroke={R.kart2} strokeWidth="4" vectorEffect="non-scaling-stroke"
                  />
                </>
              );
            })()}
          </svg>
          {imlec && okunan != null && (
            <div style={{
              position: 'absolute', top: 4, pointerEvents: 'none',
              ...(imlec.oran > 0.62 ? { right: `${(1 - imlec.oran) * 100}%`, marginRight: 10 } : { left: `${imlec.oran * 100}%`, marginLeft: 10 }),
              padding: '7px 11px', borderRadius: 10, whiteSpace: 'nowrap',
              background: 'linear-gradient(168deg,#33261A,#241A0E)',
              border: `1px solid ${R.bakir}55`, boxShadow: '0 12px 28px rgba(0,0,0,.5)',
            }}>
              <div style={{ fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
                {okunanEtiket ? `${okunanEtiket} · ${seriAd}` : seriAd}
              </div>
              <div style={{ fontFamily: F.mono, fontSize: 14, fontWeight: 700, marginTop: 2, color: R.krem }}>
                {bicimle(okunan)}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {(ikincil || []).map((h, i) => (
          <div
            key={i}
            onClick={() => onIkincil?.(h)}
            className="v2-hover-kalk"
            // Klavye erişimi (ui-ux-pro-max sistematik tarama 2026-08-15)
            tabIndex={onIkincil ? 0 : undefined}
            role={onIkincil ? 'button' : undefined}
            onKeyDown={onIkincil ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onIkincil(h); }
            } : undefined}
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
/** 18px seçim kutusu — işaretliyse bakır dolgu + koyu ✓ (yeni handoff). */
function SecimKutusu({ isaretli, boyut = 18, onTikla }) {
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onTikla?.(); }}
      role="checkbox"
      aria-checked={!!isaretli}
      style={{
        flexShrink: 0, width: boyut, height: boyut, borderRadius: 5, cursor: 'pointer',
        border: `1px solid ${isaretli ? R.bakir : R.cizgi3}`,
        background: isaretli ? R.bakir : 'transparent',
        color: '#1C1309', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: boyut * 0.62, fontWeight: 700, lineHeight: 1,
      }}
    >
      {isaretli ? '✓' : ''}
    </span>
  );
}

export function Liste({ satirlar, baslik, onAc, secilebilir, secili, onSec, onHepsi }) {
  if (!satirlar?.length) return null;
  // Seçilebilir satır = kendi `secilemez` bayrağı olmayan satır
  const uygun = satirlar.filter((l) => !l.secilemez);
  const secilenSayi = uygun.filter((l) => secili?.[l.id]).length;
  const hepsiSecili = uygun.length > 0 && secilenSayi === uygun.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {secilebilir && uygun.length > 1 && (
        <div
          onClick={() => onHepsi?.(!hepsiSecili)}
          style={{
            display: 'flex', alignItems: 'center', gap: 11, padding: '9px 16px',
            borderRadius: 12, cursor: 'pointer', background: R.girinti,
            border: `1px solid ${R.cizgi}`, fontSize: 12, color: R.metin2,
          }}
        >
          <SecimKutusu isaretli={hepsiSecili} boyut={16} onTikla={() => onHepsi?.(!hepsiSecili)} />
          <span>{hepsiSecili ? 'Seçimi kaldır' : 'Tümünü seç'}</span>
          <span style={{ marginLeft: 'auto', color: R.not2 }}>
            karar bekleyen {uygun.length} kayıt
          </span>
        </div>
      )}
      {baslik && (
        <div style={{
          fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase',
          color: R.not2, fontWeight: 700, padding: '4px 2px',
        }}>
          {baslik}
        </div>
      )}
      {satirlar.map((l, i) => {
        const renk = TIER_RENK[l.tier] || R.mavi;
        const isaretli = !!secili?.[l.id];
        return (
          <div
            key={l.id || i}
            onClick={() => onAc?.(l)}
            className="v2-hover-kalk"
            // Klavye erişimi (ui-ux-pro-max sistematik tarama 2026-08-15): Liste
            // satırları da Tablo satırları gibi Tab+Enter ile açılır.
            tabIndex={onAc ? 0 : undefined}
            role={onAc ? 'button' : undefined}
            onKeyDown={onAc ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAc(l); }
            } : undefined}
            style={{
              position: 'relative', display: 'flex', alignItems: 'center', gap: 14,
              padding: '13px 16px 13px 18px', borderRadius: 14, overflow: 'hidden',
              background: isaretli
                ? `linear-gradient(165deg, rgba(217,154,78,.14), ${R.kart2})`
                : `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`,
              border: `1px solid ${isaretli ? 'rgba(217,154,78,.38)' : 'rgba(243,233,220,.09)'}`,
              cursor: onAc ? 'pointer' : 'default',
              // ➕ EKLENTİ (2026-08-16, Bakış yeniden-düzeni): `solgun` satırı
              // SİLMEZ, soluklaştırır. "Bu kalemi zaten yukarıda gördün" demek
              // için — listeden düşürmek toplamları/adetleri yalancı yapardı.
              // Bayrağı KOYMAYAN modüller etkilenmez (undefined → opacity 1).
              opacity: l.solgun ? 0.45 : 1,
            }}
          >
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: renk }} />
            {secilebilir && !l.secilemez && (
              <SecimKutusu isaretli={isaretli} onTikla={() => onSec?.(l.id)} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{l.baslik}</div>
              <div style={{ fontSize: 11.5, color: R.not2, marginTop: 3 }}>{l.alt}</div>
            </div>
            {l.tutar && (
              <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 14, fontWeight: 700, color: renk }}>
                {l.tutar}
              </div>
            )}
            {/* Tek aksiyon (yalın) veya çoklu aksiyon (Öde / Ertele gibi) */}
            {l.aksiyon && !l.aksiyonlar && (
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
            {!!l.aksiyonlar?.length && (
              <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
                {l.aksiyonlar.map((a, ai) => (
                  <button
                    key={ai}
                    onClick={(e) => { e.stopPropagation(); a.onTikla?.(l); }}
                    style={a.birincil ? {
                      padding: '6px 14px', borderRadius: 9, border: 'none',
                      background: 'linear-gradient(150deg, #E0A559, #AF6C29)', color: '#1C1309',
                      fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
                    } : {
                      padding: '6px 12px', borderRadius: 9, border: `1px solid ${R.cizgi3}`,
                      background: 'transparent', color: R.not, fontSize: 12, fontWeight: 600,
                      fontFamily: 'inherit', cursor: 'pointer',
                    }}
                  >
                    {a.ad}
                  </button>
                ))}
              </div>
            )}
            {l.rozet && (
              <span style={{
                flexShrink: 0, padding: '4px 11px', borderRadius: 99, fontSize: 11.5, fontWeight: 700,
                background: `${l.rozetRenk || R.yesil}24`, color: l.rozetRenk || R.yesil,
              }}>
                {l.rozet}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Durum şeridi (kart döngüsü rozetleri) ──────────────────────────────────
export function Serit({ rozetler, onAc }) {
  if (!rozetler?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 16 }}>
      {rozetler.map((s, i) => (
        <span
          key={i}
          onClick={() => onAc?.(s)}
          style={{
            padding: '5px 13px', borderRadius: 99, fontSize: 11.5, fontWeight: 700,
            whiteSpace: 'nowrap', cursor: onAc ? 'pointer' : 'default',
            background: `${s.renk}1F`, color: s.renk, border: `1px solid ${s.renk}44`,
          }}
        >
          {s.ad} · {s.durum}{s.ek ? ` ${s.ek}` : ''}
        </span>
      ))}
    </div>
  );
}

// ─── Borç Koçu (strateji seçimi + öncelik + sıralı kart tablosu) ─────────────
const KOC_IZGARA = '34px 1.6fr 1fr 70px 1fr 1fr 1fr';

export function BorcKocu({
  strateji, onStrateji, nakit, onNakit,
  oncelikAd, oncelikNot, ozetNot, satirlar,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '14px 16px', borderRadius: 16, ...kartYuzey, boxShadow: 'none',
      }}>
        <span style={{ fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
          Strateji
        </span>
        {[['cig', 'Çığ · en yüksek faiz'], ['kartopu', 'Kartopu · en küçük borç']].map(([id, ad]) => (
          <div
            key={id}
            onClick={() => onStrateji?.(id)}
            style={{
              padding: '7px 15px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${strateji === id ? R.bakir : R.cizgi3}`,
              color: strateji === id ? R.bakir : R.metin2,
              background: strateji === id ? 'rgba(217,154,78,.14)' : 'transparent',
            }}
          >
            {ad}
          </div>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: R.not2, display: 'flex', alignItems: 'center', gap: 8 }}>
          Bu ay ödeyebileceğin nakit:
          <input
            type="number"
            value={nakit}
            onChange={(e) => onNakit?.(e.target.value)}
            style={{
              width: 120, padding: '6px 10px', borderRadius: 8, border: `1px solid ${R.cizgi3}`,
              background: R.girinti, color: R.krem, fontFamily: F.mono, fontSize: 12.5,
              fontWeight: 700, textAlign: 'right',
            }}
          />
        </span>
      </div>

      {oncelikAd && (
        <div style={{
          padding: '18px 20px', borderRadius: 18,
          background: `linear-gradient(165deg, rgba(217,154,78,.14), ${R.kartUst2})`,
          border: '1px solid rgba(217,154,78,.34)',
        }}>
          <div style={{ fontSize: 12, color: R.metin2 }}>Önce bunu kapat:</div>
          <div style={{ fontFamily: F.baslik, fontSize: 21, fontWeight: 600, color: R.bakir, marginTop: 4 }}>
            {oncelikAd}
          </div>
          {oncelikNot && (
            <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 6, lineHeight: 1.6 }}>{oncelikNot}</div>
          )}
          {ozetNot && (
            <div style={{ fontSize: 12.5, color: R.yesil, marginTop: 10, lineHeight: 1.6 }}>{ozetNot}</div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflowX: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: KOC_IZGARA, gap: 12, padding: '0 14px', minWidth: 720,
          fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase', color: R.not2, fontWeight: 700,
        }}>
          <span>#</span><span>Kart</span>
          <span style={{ textAlign: 'right' }}>Borç</span>
          <span style={{ textAlign: 'right' }}>Faiz</span>
          <span style={{ textAlign: 'right' }}>Aylık faiz</span>
          <span style={{ textAlign: 'right' }}>Asgari</span>
          <span style={{ textAlign: 'right' }}>Önerilen</span>
        </div>
        {satirlar.map((k, i) => (
          <div
            key={k.id || i}
            style={{
              display: 'grid', gridTemplateColumns: KOC_IZGARA, gap: 12, alignItems: 'center',
              padding: '12px 14px', borderRadius: 13, minWidth: 720,
              background: `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`,
              border: `1px solid ${i === 0 ? 'rgba(217,154,78,.4)' : 'rgba(243,233,220,.08)'}`,
            }}
          >
            <span style={{
              width: 22, height: 22, borderRadius: 99, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontSize: 11, fontWeight: 700, fontFamily: F.mono,
              background: i === 0 ? R.bakir : R.cizgi2, color: i === 0 ? '#1C1309' : R.not,
            }}>
              {i + 1}
            </span>
            <span>
              <span style={{ fontWeight: 600 }}>{k.ad}</span>
              <span style={{ display: 'block', fontSize: 10.5, color: R.not2 }}>{k.sahip}</span>
            </span>
            <span style={{ whiteSpace: 'nowrap', textAlign: 'right', fontFamily: F.mono }}>{k.borc}</span>
            <span style={{ textAlign: 'right', fontFamily: F.mono, color: k.faizBelirsiz ? R.not2 : R.kirmizi }}>
              {k.faiz}
            </span>
            <span style={{ whiteSpace: 'nowrap', textAlign: 'right', fontFamily: F.mono, color: R.amber }}>
              {k.aylikFaiz}
            </span>
            <span style={{ whiteSpace: 'nowrap', textAlign: 'right', fontFamily: F.mono, color: R.metin2 }}>
              {k.asgari}
            </span>
            <span style={{ whiteSpace: 'nowrap', textAlign: 'right', fontFamily: F.mono, fontWeight: 700, color: R.yesil }}>
              {k.onerilen}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Tablo ───────────────────────────────────────────────────────────────────
/** Sıralamada sayı kabul edilen BİRİMLER. Kapalı liste bilinçli: "18 Tem"
 *  (tarih) sayıya çevrilirse aylar karışır — ay kısaltmaları listede YOK,
 *  o yüzden tarihler metin gibi sıralanır. */
const SIRA_BIRIM = /^(ay|sa|s|saat|gün|gun|adet|kalem|kişi|kisi|kg|lt|ml|g|x|puan|hafta|yıl|yil)$/i;

/** Sıralama için hücre değerini çöz: tr-TR sayı ise sayısal, değilse metin.
 *  Oran ifadeleri ("4 / 5") metin sayılır — yanlış sıralamaktansa dürüst
 *  metin sıralaması yapar. */
function siralamaDegeri(h) {
  // Hücre içeriği JSX ise String(v) "[object Object]" verir ve o sütun sessizce
  // sıralanamaz hâle gelir. Çok satırlı hücreler kendi anahtarını bildirebilir:
  // `sira` (sayı) ya da `siraMetin` (düz metin).
  if (h?.sira != null && Number.isFinite(Number(h.sira))) {
    return { s: Number(h.sira), m: String(h.sira) };
  }
  const ham = h?.siraMetin != null ? h.siraMetin : h?.v;
  if (ham == null) return { s: null, m: '' };
  const metin = String(ham).trim();
  if (/\d\s*\/\s*\d/.test(metin)) return { s: null, m: metin };

  // "1.234.567,89 ₺" · "%22,4" · "−12,5 sa" · "18 ay" → sayı
  const cekirdek = metin.replace(/[₺%]/g, '').replace(/−/g, '-').trim();
  const m = cekirdek.match(/^(-?[\d.]+(?:,\d+)?)\s*([^\s]*)$/);
  if (m) {
    const kuyruk = m[2];
    if (!kuyruk || SIRA_BIRIM.test(kuyruk)) {
      const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(n)) return { s: n, m: metin };
    }
  }
  return { s: null, m: metin };
}

export function Tablo({ baslik, not, kolonlar, satirlar, onSatir }) {
  // Yeni handoff: başlığa tık → 1. artan, 2. azalan, 3. sıfırla (özgün sıra).
  // Sıralama SALT GÖRSEL — veriyi değiştirmez, sunucuya gitmez.
  const [sirala, setSirala] = React.useState(null);   // {kol, yon}

  const kolTikla = (i) => {
    setSirala((s) => {
      if (!s || s.kol !== i) return { kol: i, yon: 1 };
      if (s.yon === 1) return { kol: i, yon: -1 };
      return null;
    });
  };

  const gosterilen = React.useMemo(() => {
    if (!sirala) return satirlar;
    const { kol, yon } = sirala;
    return [...satirlar].sort((a, b) => {
      const x = siralamaDegeri(a.hucreler?.[kol]);
      const y = siralamaDegeri(b.hucreler?.[kol]);
      if (x.s != null && y.s != null) return (x.s - y.s) * yon;
      return x.m.localeCompare(y.m, 'tr') * yon;
    });
  }, [satirlar, sirala]);

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
              {kolonlar.map((k, i) => {
                const s = sirala?.kol === i ? sirala.yon : 0;
                return (
                  <th
                    key={i}
                    onClick={() => kolTikla(i)}
                    title="Sırala — 1. tık artan, 2. azalan, 3. sıfırlar"
                    style={{
                      padding: '11px 20px', textAlign: k.sag ? 'right' : 'left',
                      fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase',
                      color: s ? R.bakirAcik : R.not2, fontWeight: 700,
                      borderBottom: `1px solid ${R.cizgi2}`, whiteSpace: 'nowrap',
                      cursor: 'pointer', userSelect: 'none',
                    }}
                  >
                    {k.ad}
                    {s !== 0 && <span style={{ marginLeft: 5 }}>{s === 1 ? '↑' : '↓'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {gosterilen.map((s, si) => (
              <tr
                key={s.id || si}
                onClick={() => onSatir?.(s)}
                className="v2-satir"
                // Klavye erişimi (ui-ux-pro-max denetimi 2026-08-14): satır fareyle
                // açılıyordu ama Tab ile gelinemiyordu — tıklanabilir satır artık
                // odaklanabilir, Enter/Space açar, focus-visible halkası index.css'te.
                tabIndex={onSatir ? 0 : undefined}
                onKeyDown={onSatir ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSatir(s); }
                } : undefined}
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

// ─── Vade takvimi (14 gün) ───────────────────────────────────────────────────
const HAFTA_KISA = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

export function Takvim({ gunler, onGun }) {
  return (
    <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14,
      }}>
        <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>Vade takvimi · 14 gün</span>
        <span style={{ fontSize: 11, color: R.not2 }}>güne tıkla → o günün ödemeleri</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 8 }}>
        {gunler.map((g, i) => {
          const dolu = g.tutar > 0;
          const renk = g.gecikmis ? R.kirmizi : g.bugun ? R.bakir : dolu ? R.amber : R.cizgi3;
          return (
            <div
              key={i}
              onClick={() => dolu && onGun?.(g)}
              className={dolu ? 'v2-hover-kalk' : undefined}
              style={{
                padding: '10px 11px', borderRadius: 13, minHeight: 78,
                display: 'flex', flexDirection: 'column', gap: 4,
                cursor: dolu ? 'pointer' : 'default',
                background: dolu
                  ? `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`
                  : 'rgba(255,255,255,.015)',
                border: `1px solid ${dolu ? `${renk}55` : 'rgba(243,233,220,.06)'}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: g.bugun ? R.bakir : R.metin2 }}>{g.gun}</span>
                <span style={{ fontSize: 9.5, color: R.not2, textTransform: 'uppercase', letterSpacing: '.5px' }}>
                  {HAFTA_KISA[g.haftaGunu]}
                </span>
              </div>
              <div style={{
                whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 13, fontWeight: 700,
                color: dolu ? renk : R.not3,
              }}>
                {dolu ? g.tutarMetin : '—'}
              </div>
              <div style={{ fontSize: 10, color: R.not2 }}>{dolu ? `${g.adet} kalem` : 'ödeme yok'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Vardiya ızgarası (şube × 7 gün) ─────────────────────────────────────────
// Tasarım: ekip.vardiya. Masaüstünde SALT-OKUR — atama şube panelinden/planlama
// ekranından yapılır; buradan yazmak tek-yazıcı ilkesini deler.
export function VardiyaIzgara({ baslik, not, gunler, subeler, onHucre }) {
  return (
    <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16, overflowX: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14, gap: 14,
      }}>
        <span style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>{baslik}</span>
        {not && <span style={{ fontSize: 11, color: R.not2, whiteSpace: 'nowrap' }}>{not}</span>}
      </div>

      <div style={{ minWidth: 860 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `128px repeat(7, 1fr)`, gap: 7, marginBottom: 7 }}>
          <span />
          {gunler.map((g, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{
                fontSize: 10, letterSpacing: '.6px', textTransform: 'uppercase',
                color: g.bugun ? R.bakir : R.not2, fontWeight: 700,
              }}>
                {g.haftaAd}
              </div>
              <div style={{ fontSize: 11, color: g.bugun ? R.bakir : R.not3, fontFamily: F.mono }}>{g.gunAd}</div>
            </div>
          ))}
        </div>

        {subeler.map((s, si) => (
          <div key={si} style={{ display: 'grid', gridTemplateColumns: `128px repeat(7, 1fr)`, gap: 7, marginBottom: 7 }}>
            <div style={{
              display: 'flex', alignItems: 'center', fontSize: 12.5, fontWeight: 600,
              color: R.metin2, paddingRight: 8,
            }}>
              {s.ad}
            </div>
            {s.gunler.map((h, gi) => {
              const bos = !h.kisiler.length;
              return (
                <div
                  key={gi}
                  onClick={() => onHucre?.(s, h)}
                  className={onHucre ? 'v2-hover-kalk' : undefined}
                  style={{
                    minHeight: 62, padding: '7px 8px', borderRadius: 11, cursor: onHucre ? 'pointer' : 'default',
                    display: 'flex', flexDirection: 'column', gap: 3,
                    background: bos ? 'rgba(248,113,113,.06)' : `linear-gradient(165deg, ${R.kart1}, ${R.kart2})`,
                    border: `1px solid ${bos ? 'rgba(248,113,113,.28)' : 'rgba(243,233,220,.08)'}`,
                  }}
                >
                  {bos ? (
                    <span style={{ fontSize: 10.5, color: R.kirmizi, fontWeight: 700 }}>boş</span>
                  ) : h.kisiler.slice(0, 3).map((k, ki) => (
                    <span key={ki} style={{ fontSize: 10.5, color: R.krem, lineHeight: 1.35, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {k.ad}
                      {k.saat && <span style={{ color: R.not2 }}> · {k.saat}</span>}
                    </span>
                  ))}
                  {h.kisiler.length > 3 && (
                    <span style={{ fontSize: 10, color: R.not2 }}>+{h.kisiler.length - 3} kişi</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Borç baskı endeksi göstergesi (yarım daire gauge) ──────────────────────
// Tasarım: borc.durum. Skor 0–100; yay uzunluğu skorla orantılı.
export function Gauge({ skor, durum, renk = R.kirmizi, bilesenler, baslik = 'Borç baskı endeksi', not, notBaslik, saglik }) {
  const s = Math.max(0, Math.min(100, Number(skor) || 0));
  // Yarım daire: (20,100) → (172,100), yarıçap 76. Uzunluk ≈ π·76 ≈ 238.8
  const yay = 238.8;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.35fr', gap: 12, marginBottom: 16 }}>
      <div style={{
        background: `linear-gradient(165deg, ${R.kartUst1}, ${R.kartUst2})`,
        border: `1px solid ${renk}4D`, borderRadius: 20, padding: '20px 22px',
        textAlign: 'center', boxShadow: '0 16px 38px rgba(0,0,0,.36)',
      }}>
        <div style={{ fontSize: 10.5, letterSpacing: '1px', textTransform: 'uppercase', color: R.not, fontWeight: 700 }}>
          {baslik}
        </div>
        <svg viewBox="0 0 192 116" style={{ width: '100%', maxWidth: 230, margin: '6px auto 0', display: 'block' }}>
          <path d="M 20 100 A 76 76 0 0 1 172 100" fill="none" stroke={R.cizgi2} strokeWidth="15" strokeLinecap="round" />
          <path
            d="M 20 100 A 76 76 0 0 1 172 100" fill="none" stroke={renk} strokeWidth="15" strokeLinecap="round"
            strokeDasharray={`${(s / 100) * yay} ${yay}`}
          />
          <text x="96" y="88" textAnchor="middle" style={{ fontFamily: F.mono, fontSize: 38, fontWeight: 700, fill: renk }}>
            {Math.round(s)}
          </text>
          <text x="96" y="108" textAnchor="middle" style={{ fontSize: 11, fill: R.not2 }}>/ 100</text>
        </svg>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: renk, marginTop: 4 }}>{durum}</div>

        {!!bilesenler?.length && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 16, textAlign: 'left' }}>
            {bilesenler.map((b, i) => (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: R.metin2, marginBottom: 4 }}>
                  <span>{b.ad} <span style={{ color: R.not2 }}>{b.agirlik}</span></span>
                  <span style={{ fontFamily: F.mono }}>{b.skor}</span>
                </div>
                <div style={{ height: 6, borderRadius: 99, background: R.cizgi2, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 99,
                    width: `${Math.max(0, Math.min(100, Number(b.skorSayi) || 0))}%`,
                    background: b.renk || renk,
                  }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {not && (
          <div style={{
            background: `linear-gradient(165deg, ${renk}1A, ${R.kartUst2})`,
            border: `1px solid ${renk}57`, borderRadius: 18, padding: '18px 20px',
          }}>
            {/* Başlık, gauge'ın altındaki `durum` metnini TEKRAR ETMEZ — aynı cümleyi
                iki kez yazmak yerine burada "ne anlama geliyor" anlatılır. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 9, height: 9, borderRadius: 99, background: renk, flexShrink: 0 }} />
              <span style={{ fontFamily: F.baslik, fontSize: 16, fontWeight: 600, color: renk }}>
                {notBaslik || 'Bu ne demek?'}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 9, lineHeight: 1.65 }}>{not}</div>
          </div>
        )}
        {!!saglik?.length && (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {saglik.map((k, i) => (
              <div key={i} style={{ ...kartYuzey, borderRadius: 15, padding: '14px 16px', boxShadow: 'none' }}>
                <div style={{ fontSize: 10, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not, fontWeight: 700 }}>
                  {k.etiket}
                </div>
                <div style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 22, fontWeight: 700, marginTop: 5, color: k.renk || R.krem }}>
                  {k.deger}
                </div>
                <div style={{ fontSize: 11, color: R.not2, marginTop: 3 }}>{k.alt}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Aylık yük eğrisi (36 ay) ───────────────────────────────────────────────
export function YukEgrisi({ baslik, alt, seri, esik, esikAd, notMetni, etiketler, rozetler, onNokta }) {
  const d = (seri || []).map(x => Number(x.deger) || 0);
  const { cizgi, alan } = sparkYol(d);
  const enB = Math.max(...d, Number(esik) || 0, 1);
  const enK = Math.min(...d, 0);
  // Eşik çizgisinin y'si sparkYol ile aynı ölçekte olmalı (boy 120, üst pay 8/alt 14)
  const esikY = Number.isFinite(esik) && enB !== enK
    ? 120 - 8 - ((esik - enK) / (enB - enK)) * (120 - 22)
    : null;
  return (
    <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14,
        paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 14,
      }}>
        <div>
          <div style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>{baslik}</div>
          {alt && <div style={{ fontSize: 11.5, color: R.not2, marginTop: 4 }}>{alt}</div>}
        </div>
        {esikAd && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: R.not2, whiteSpace: 'nowrap' }}>
            <span style={{ width: 16, height: 2, background: R.yesil, display: 'inline-block' }} /> {esikAd}
          </div>
        )}
      </div>

      {notMetni && (
        <div style={{
          padding: '12px 14px', borderRadius: 12, background: 'rgba(251,191,36,.08)',
          border: '1px solid rgba(251,191,36,.3)', fontSize: 12.5, color: '#E7DCCB',
          lineHeight: 1.6, marginBottom: 14,
        }}>
          {notMetni}
        </div>
      )}

      <svg viewBox="0 0 640 120" preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 150 }}>
        <defs>
          <linearGradient id="v2egrifill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={R.bakir} stopOpacity=".28" />
            <stop offset="100%" stopColor={R.bakir} stopOpacity="0" />
          </linearGradient>
        </defs>
        {alan && <path d={alan} fill="url(#v2egrifill)" />}
        {cizgi && (
          <path d={cizgi} fill="none" stroke={R.bakir} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"
            strokeDasharray="640" style={{ animation: 'v2cizim 1.1s cubic-bezier(.22,1,.36,1) .12s both' }} />
        )}
        {esikY != null && (
          <line x1="0" y1={esikY} x2="640" y2={esikY} stroke={R.yesil} strokeWidth="1.4" strokeDasharray="5 5" />
        )}
      </svg>

      {!!etiketler?.length && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: R.not2, marginTop: 6 }}>
          {etiketler.map((e, i) => <span key={i}>{e}</span>)}
        </div>
      )}

      {!!rozetler?.length && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${R.cizgi2}` }}>
          <div style={{
            fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2,
            fontWeight: 700, marginBottom: 9,
          }}>
            Krediler ne zaman bitiyor — bitince yük düşer
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {rozetler.map((b, i) => (
              <span key={i} style={{
                padding: '5px 12px', borderRadius: 99, background: R.cizgi,
                border: `1px solid ${R.cizgi3}`, fontSize: 11.5, color: R.metin2, whiteSpace: 'nowrap',
              }}>
                {b}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Şube katkı çubuğu (ortadan iki yöne) ───────────────────────────────────
export function KatkiCubugu({ baslik, alt, satirlar, onSatir }) {
  const enBuyuk = Math.max(...satirlar.map(s => Math.abs(Number(s.deger) || 0)), 1);
  return (
    <div style={{ ...kartYuzey, padding: '20px 22px', marginBottom: 16 }}>
      <div style={{ paddingBottom: 12, borderBottom: `1px solid ${R.cizgi2}`, marginBottom: 16 }}>
        <div style={{ fontFamily: F.baslik, fontSize: 15.5, fontWeight: 600 }}>{baslik}</div>
        {alt && <div style={{ fontSize: 11.5, color: R.not2, marginTop: 4 }}>{alt}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {satirlar.map((s, i) => {
          const v = Number(s.deger) || 0;
          const oran = (Math.abs(v) / enBuyuk) * 50; // yarım genişlik
          const pozitif = v >= 0;
          return (
            <div
              key={i}
              onClick={() => onSatir?.(s)}
              style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: onSatir ? 'pointer' : 'default' }}
            >
              <span style={{ width: 104, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{s.ad}</span>
              <div style={{ flex: 1, position: 'relative', height: 22, display: 'flex', alignItems: 'center' }}>
                <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: R.cizgi3 }} />
                <span style={{
                  position: 'absolute', height: 14, borderRadius: 4,
                  left: pozitif ? '50%' : `${50 - oran}%`,
                  width: `${oran}%`,
                  background: pozitif ? R.yesil : R.kirmizi,
                }} />
              </div>
              <span style={{
                width: 128, textAlign: 'right', whiteSpace: 'nowrap', fontFamily: F.mono,
                fontSize: 13.5, fontWeight: 700, color: pozitif ? R.yesil : R.kirmizi,
              }}>
                {s.metin}
              </span>
              <span style={{ width: 66, fontSize: 10.5, color: R.not2 }}>{s.durum}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Onay modalı (para hareketi öncesi son kapı) ────────────────────────────
export function OnayModali({
  acik, baslik, altBaslik, tutar, satirlar, not, onaylaAd, onOnayla, onKapat, calisiyor,
  tehlike, kaynaklar, kaynak, onKaynak, tutarSayi,
}) {
  if (!acik) return null;
  // Ödeme kaynağı seçimi (yeni handoff): para hareketi doğuran onayda paranın
  // NEREDEN çıkacağı seçilir ve seçilen kaynağın ödeme SONRASI bakiyesi canlı
  // görünür. Bakiyeler gerçek hesaplardan gelir — kaynak listesi boşsa blok hiç
  // çıkmaz (uydurma hesap gösterilmez).
  const kList = Array.isArray(kaynaklar) ? kaynaklar : [];
  const seciliKaynak = kList.find((k) => k.id === kaynak) || kList[0];
  const sonrasi = seciliKaynak && Number.isFinite(Number(seciliKaynak.bakiye))
    ? Number(seciliKaynak.bakiye) - (Number(tutarSayi) || 0)
    : null;
  return (
    <div
      onClick={onKapat}
      style={{
        position: 'fixed', inset: 0, zIndex: 120, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 20, background: 'rgba(10,6,2,.7)',
        backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
        animation: 'v2belir .14s ease both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 430, borderRadius: 20,
          background: `linear-gradient(165deg, #2C2116, ${R.kartUst2})`,
          border: '1px solid rgba(243,233,220,.12)', boxShadow: '0 26px 60px rgba(0,0,0,.5)',
          animation: 'v2buyu .26s cubic-bezier(.4,0,.2,1) both',
        }}
      >
        <div style={{ padding: '20px 22px 16px', borderBottom: `1px solid ${R.cizgi2}` }}>
          <div style={{ fontFamily: F.baslik, fontSize: 18, fontWeight: 600 }}>{baslik}</div>
          <div style={{ fontSize: 12, color: R.not, marginTop: 5 }}>{altBaslik}</div>
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 }}>
              Tutar
            </span>
            <span style={{
              whiteSpace: 'nowrap', fontFamily: F.mono, fontSize: 28, fontWeight: 700,
              letterSpacing: '-1px', color: R.krem,
            }}>
              {tutar}
            </span>
          </div>
          {kList.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2, fontWeight: 700, marginBottom: 9 }}>
                Ödeme kaynağı
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, kList.length)}, 1fr)`, gap: 7 }}>
                {kList.map((k) => {
                  const sec = seciliKaynak?.id === k.id;
                  return (
                    <div
                      key={k.id}
                      onClick={() => onKaynak?.(k.id)}
                      style={{
                        padding: '10px 11px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                        border: `1px solid ${sec ? 'rgba(217,154,78,.6)' : R.cizgi3}`,
                        background: sec ? 'rgba(217,154,78,.14)' : 'transparent',
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: sec ? R.bakirAcik : R.metin2 }}>{k.ad}</div>
                      <div style={{ fontFamily: F.mono, fontSize: 10.5, color: R.not2, marginTop: 3 }}>
                        {k.bakiyeMetin}
                      </div>
                    </div>
                  );
                })}
              </div>
              {sonrasi != null && (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 12,
                  paddingTop: 12, borderTop: `1px solid ${R.cizgi2}`, fontSize: 12.5, color: R.metin2,
                }}>
                  <span>{seciliKaynak.ad} · ödeme sonrası</span>
                  <span style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontWeight: 700, color: sonrasi < 0 ? R.kirmizi : R.yesil }}>
                    {seciliKaynak.bicim ? seciliKaynak.bicim(sonrasi) : String(sonrasi)}
                  </span>
                </div>
              )}
            </div>
          )}
          {(satirlar || []).map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              marginTop: 14, paddingTop: 14, borderTop: `1px solid ${R.cizgi2}`,
              fontSize: 12.5, color: R.metin2,
            }}>
              <span>{s.ad}</span>
              <span style={{ whiteSpace: 'nowrap', fontFamily: F.mono, fontWeight: 700, color: s.renk || R.yesil }}>
                {s.deger}
              </span>
            </div>
          ))}
          {not && <div style={{ fontSize: 11.5, color: R.not2, marginTop: 10, lineHeight: 1.55 }}>{not}</div>}
        </div>
        <div style={{ padding: '14px 22px', borderTop: `1px solid ${R.cizgi2}`, display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
          <button onClick={onKapat} disabled={calisiyor} style={{
            padding: '9px 16px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
            background: 'transparent', color: R.not, fontSize: 12.5, fontWeight: 600,
            fontFamily: 'inherit', cursor: calisiyor ? 'default' : 'pointer',
          }}>Vazgeç</button>
          <button onClick={onOnayla} disabled={calisiyor} style={{
            padding: '9px 18px', borderRadius: 10,
            border: tehlike ? `1px solid ${R.kirmizi}55` : 'none',
            background: tehlike ? `${R.kirmizi}26` : 'linear-gradient(150deg, #E0A559, #AF6C29)',
            color: tehlike ? R.kirmizi : '#1C1309',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            cursor: calisiyor ? 'default' : 'pointer', opacity: calisiyor ? 0.6 : 1,
          }}>{calisiyor ? '…' : onaylaAd}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Detay çekmecesi ─────────────────────────────────────────────────────────
// Çekmece aksiyon sözleşmesi: tek aksiyon için {aksiyonAd, onAksiyon};
// ÇOKLU aksiyon için aksiyonlar:[{ad, birincil?, onTikla}] (köprü kaldırma turu,
// 2026-07-30 — "düzenle + işten çıkış" gibi iki yollu dosyalar için).
/** Yüzen seçim çubuğu (alt orta) — seçim varken belirir.
 *  ⚠️ Blueprint burada "Geri al" düğmesi de istiyor; BİZDE YOK ve bilinçli:
 *  onay kasadan para düşürür, geri alma ancak TERS KAYITLA olur (silme yok).
 *  Sahte bir "geri al" düğmesi kullanıcıya olmayan bir güvence satardı —
 *  onun yerine emniyet kapısı ONAY MODALI: ne onaylandığı tek tek gösterilir. */
export function SecimCubugu({ sayi, onOnayla, onReddet, onTemizle, onaylaAd = 'Seçilenleri onayla', reddetAd = 'Reddet', mesgul }) {
  if (!sayi) return null;
  return (
    <div style={{
      position: 'fixed', left: '50%', bottom: 26, transform: 'translateX(-50%)', zIndex: 205,
      display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px', borderRadius: 12,
      background: 'linear-gradient(168deg,#33261A,#241A0E)', border: `1px solid ${R.bakir}44`,
      boxShadow: '0 20px 44px -14px rgba(0,0,0,.8)',
      animation: 'v2yuksel .2s cubic-bezier(.22,1,.36,1) both',
    }}>
      <span style={{ fontFamily: F.mono, fontSize: 15, fontWeight: 700, color: R.bakirAcik }}>{sayi}</span>
      <span style={{ fontSize: 12.5, color: R.metin2 }}>kayıt seçildi</span>
      <span style={{ width: 1, height: 20, background: R.cizgi3 }} />
      {onOnayla && (
        <button disabled={mesgul} onClick={onOnayla} style={{
          padding: '8px 15px', borderRadius: 9, border: 'none', cursor: 'pointer',
          background: `${R.yesil}26`, color: R.yesil, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
        }}>
          {mesgul ? '…' : onaylaAd}
        </button>
      )}
      {onReddet && (
        <button disabled={mesgul} onClick={onReddet} style={{
          padding: '8px 15px', borderRadius: 9, cursor: 'pointer',
          border: `1px solid ${R.kirmizi}55`, background: 'transparent',
          color: R.kirmizi, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
        }}>
          {reddetAd}
        </button>
      )}
      <button disabled={mesgul} onClick={onTemizle} style={{
        padding: '8px 12px', borderRadius: 9, border: 'none', background: 'transparent',
        color: R.not, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
      }}>
        Temizle
      </button>
    </div>
  );
}

/** HATA BANDI — boş durumdan AYRI (yeni handoff kuralı, 2026-07-30).
 *  "veri yok" ile "sistem bozuk" asla aynı görünmez: boş durum kesikli çerçeve
 *  + nötr daire, hata BU banttır (kırmızı, role="alert", içeriğin en üstünde).
 *  Makine okunur teknik satır destek için: kod · kaynak uç · deneme sayısı.
 *  Bilmediğimiz alanı UYDURMAYIZ — yoksa o parça hiç yazılmaz. */
export function HataBandi({ mesaj, kod, kaynak, deneme, onTekrar }) {
  const teknik = [
    kod ? `hata: ${kod}` : null,
    kaynak ? `kaynak: ${kaynak}` : null,
    deneme ? `deneme ${deneme}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div
      role="alert"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 13, padding: '14px 17px',
        borderRadius: 12, marginBottom: 16,
        background: 'linear-gradient(165deg, rgba(248,113,113,.11), #221809)',
        border: '1px solid rgba(248,113,113,.34)',
      }}
    >
      <span style={{
        flexShrink: 0, width: 28, height: 28, borderRadius: 99, marginTop: 1,
        border: `1px solid ${R.kirmizi}66`, color: R.kirmizi,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 15, fontWeight: 700, lineHeight: 1,
      }}>!</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#FCA5A5' }}>
          Veri alınamadı
        </div>
        <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 4, lineHeight: 1.55 }}>
          Bu bir «kayıt yok» durumu değil — bağlantı hatası. Ekrandaki sayılar
          eksik olabilir; karar vermeden önce tekrar deneyin.
          {mesaj ? ` (${String(mesaj).slice(0, 120)})` : ''}
        </div>
        {teknik && (
          <div style={{ fontFamily: F.mono, fontSize: 10.5, color: R.not2, marginTop: 5 }}>
            {teknik}
          </div>
        )}
      </div>
      {onTekrar && (
        <button
          onClick={onTekrar}
          style={{
            flexShrink: 0, padding: '7px 14px', borderRadius: 9, cursor: 'pointer',
            border: `1px solid ${R.kirmizi}55`, background: `${R.kirmizi}18`,
            color: R.kirmizi, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
          }}
        >
          🔄 Tekrar dene
        </button>
      )}
    </div>
  );
}

/** Boş durum — yeni handoff'un kanonik biçimi: kesikli çerçeve, 38px bakır
 *  çerçeveli daire içinde ✓, Fraunces başlık, altında açıklama.
 *  Geriye uyum: eski çağrılar tek `metin` prop'u geçiyordu; o zaman metin
 *  açıklamaya düşer, başlık varsayılan olur.
 *  `tamam=false` verilirse (ör. veri hiç yok) daire ✓ yerine — gösterir:
 *  boş kuyruk ile boş veri farklı şeylerdir. */
export function BosDurum({ baslik, aciklama, metin, tamam = false, ikon }) {
  const alt = aciklama || metin || '';
  // ⚠️ Varsayılan NÖTR: "kayıt yok" ile "kuyruk temizlendi" AYNI ŞEY DEĞİL.
  // Başarı anlamı (✓ + yeşilimsi bakır daire) yalnız çağıran açıkça
  // `tamam` derse verilir; aksi halde "—" ve nötr başlık.
  const ust = baslik || (tamam ? 'Kuyruk temiz' : 'Kayıt yok');
  return (
    <div style={{
      border: `1px dashed ${R.cizgi3}`, borderRadius: 16, padding: '34px 24px',
      textAlign: 'center', marginBottom: 16,
    }}>
      <div style={{
        width: 38, height: 38, borderRadius: 99, margin: '0 auto 13px',
        border: `1px solid ${tamam ? R.bakir : R.cizgi3}`,
        color: tamam ? R.bakir : R.not2,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
      }}>
        {ikon || (tamam ? '✓' : '—')}
      </div>
      <div style={{ fontFamily: F.baslik, fontSize: 17, fontWeight: 600, color: R.metin2 }}>{ust}</div>
      {alt && (
        <div style={{ fontSize: 12.5, color: R.not2, marginTop: 7, lineHeight: 1.6, maxWidth: 380, margin: '7px auto 0' }}>
          {alt}
        </div>
      )}
    </div>
  );
}

/** Çekmece sekme kontrolü — Özet · Belgeler · İz (yeni handoff).
 *  Belgeler/İz sekmeleri modülün GEÇTİĞİ veriyle dolar; veri yoksa sekme
 *  dürüst boş durum gösterir (uydurma belge/iz üretilmez). */
function CekmeceSekme({ aktif, onSec }) {
  const S = [['ozet', 'Özet'], ['belge', 'Belgeler'], ['iz', 'İz']];
  return (
    <div style={{
      display: 'flex', gap: 3, margin: '14px 22px 0', padding: 3,
      borderRadius: 10, background: R.girinti, border: `1px solid ${R.cizgi}`,
    }}>
      {S.map(([id, ad]) => (
        <div
          key={id}
          onClick={() => onSec(id)}
          style={{
            flex: 1, textAlign: 'center', padding: '6px 10px', borderRadius: 7,
            fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
            color: aktif === id ? '#1C1309' : R.not,
            background: aktif === id ? 'linear-gradient(150deg, #E0A559, #AF6C29)' : 'transparent',
          }}
        >
          {ad}
        </div>
      ))}
    </div>
  );
}

/** Sekme boş durumu — neden boş olduğunu SÖYLER, sessizce boş kalmaz. */
function SekmeBos({ baslik, aciklama }) {
  return (
    <div style={{
      border: `1px dashed ${R.cizgi3}`, borderRadius: 14, padding: '30px 20px', textAlign: 'center',
    }}>
      <div style={{ fontFamily: F.baslik, fontSize: 15, color: R.metin2 }}>{baslik}</div>
      <div style={{ fontSize: 12, color: R.not2, marginTop: 6, lineHeight: 1.6, maxWidth: 320, margin: '6px auto 0' }}>
        {aciklama}
      </div>
    </div>
  );
}

export function Cekmece({
  acik, tip, baslik, alt, kpi, listeBaslik, satirlar, not,
  aksiyonAd, onAksiyon, aksiyonlar, onKapat,
  belgeler, iz, dosyaBilgi,
  // 🔙 GERİ (2026-08-26) — { ad, onTikla }. Çekmece artık katmanlanabildiği için
  // (satır bir kapı olabiliyor) geri dönecek bir yol ŞART: derinleşen kullanıcıyı
  // "kapat"a mahkûm etmek, açtığı bağlamı da kapatmak demektir. Verilmezse
  // düğme hiç çizilmez — mevcut çekmecelerin hepsi bugünkü gibi kalır.
  geri,
  // 📎 BELGE YÜKLEME (sahip 2026-08-15: "belge alanına yükleme deseni de koy")
  // Modül bir fonksiyon geçerse Belgeler sekmesinin altında yükleme düğmesi çıkar.
  // Geçmezse hiç görünmez — yükleme yeri olmayan kayıtta boş düğme durmasın.
  belgeYukle,
}) {
  const [sekme, setSekme] = React.useState('ozet');
  const [yukleDurum, setYukleDurum] = React.useState('');   // '' | 'yukleniyor' | hata metni
  const dosyaRef = React.useRef(null);
  // Her açılışta Özet'e döner (blueprint kuralı)
  React.useEffect(() => { setSekme('ozet'); }, [acik, tip, baslik]);
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
              {geri?.onTikla && (
                <div
                  onClick={geri.onTikla}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); geri.onTikla(); }
                  }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                    fontSize: 11.5, color: R.bakirAcik, marginBottom: 7,
                  }}
                >
                  ‹ <span style={{ color: R.not2 }}>{geri.ad || 'geri'}</span>
                </div>
              )}
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

        <CekmeceSekme aktif={sekme} onSec={setSekme} />

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 22px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {sekme === 'belge' && (<>
            {belgeler?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {belgeler.map((b, i) => (
                  // Belge her zaman indirilebilir bir DOSYA değil: kart ekstresi gibi
                  // kayıtlar sistemin kendi ekranında durur → url yoksa ama onTikla
                  // varsa öğe düğme gibi davranır (klavyeyle de açılır).
                  <a
                    key={i}
                    href={b.url || undefined}
                    target={b.url ? '_blank' : undefined}
                    rel="noreferrer"
                    onClick={b.onTikla && !b.url ? (e) => { e.preventDefault(); b.onTikla(); } : undefined}
                    role={b.onTikla && !b.url ? 'button' : undefined}
                    tabIndex={b.onTikla && !b.url ? 0 : undefined}
                    onKeyDown={b.onTikla && !b.url ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.onTikla(); }
                    } : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px',
                      borderRadius: 12, background: R.kart1, border: '1px solid rgba(243,233,220,.08)',
                      textDecoration: 'none', color: 'inherit',
                      cursor: (b.url || b.onTikla) ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{
                      flexShrink: 0, width: 34, height: 34, borderRadius: 9,
                      border: `1px solid ${R.bakir}55`, color: R.bakir, display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700,
                    }}>
                      {(b.tur || 'DOSYA').slice(0, 4).toUpperCase()}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{b.ad}</span>
                      <span style={{ display: 'block', fontSize: 11, color: R.not2, marginTop: 2 }}>{b.boyut || b.detay || '—'}</span>
                    </span>
                    {b.rozet && (
                      <span style={{
                        flexShrink: 0, padding: '3px 9px', borderRadius: 99, fontSize: 10.5, fontWeight: 700,
                        background: `${b.rozetRenk || R.yesil}22`, color: b.rozetRenk || R.yesil,
                      }}>
                        {b.rozet}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            ) : (
              <SekmeBos
                baslik="Bağlı belge yok"
                aciklama="Bu kayda iliştirilmiş fatura/fiş bulunmuyor. Belgeler tedarikçi faturası yüklendiğinde ya da fatura isteği kapandığında burada görünür."
              />
            )}
            {belgeYukle && (
              <div style={{ marginTop: 4 }}>
                <input
                  ref={dosyaRef} type="file" accept="image/*,.pdf" style={{ display: 'none' }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';            // aynı dosya tekrar seçilebilsin
                    if (!f) return;
                    setYukleDurum('yukleniyor');
                    try {
                      await belgeYukle(f);
                      setYukleDurum('');
                    } catch (err) {
                      // Sessiz yutma YASAK: yükleme başarısızsa sahip görsün,
                      // yoksa "belge eklendi" sanıp belgesiz devam eder.
                      setYukleDurum(err?.message || 'Belge yüklenemedi');
                    }
                  }}
                />
                <button
                  onClick={() => dosyaRef.current?.click()}
                  disabled={yukleDurum === 'yukleniyor'}
                  style={{
                    width: '100%', padding: '11px 13px', borderRadius: 12,
                    border: `1px dashed ${R.cizgi3}`, background: 'transparent',
                    color: yukleDurum === 'yukleniyor' ? R.not : R.metin2,
                    fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                    cursor: yukleDurum === 'yukleniyor' ? 'default' : 'pointer',
                  }}
                >
                  {yukleDurum === 'yukleniyor' ? 'Yükleniyor…' : '➕ Belge yükle (fotoğraf/PDF)'}
                </button>
                {yukleDurum && yukleDurum !== 'yukleniyor' && (
                  <div style={{
                    marginTop: 8, padding: '9px 12px', borderRadius: 10, fontSize: 11.5,
                    background: `${R.kirmizi}14`, border: `1px solid ${R.kirmizi}44`, color: R.kirmizi,
                  }}>⚠ {yukleDurum}</div>
                )}
              </div>
            )}
          </>)}

          {sekme === 'iz' && (
            <>
              {iz?.length ? (
                <div>
                  <div style={{
                    fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2,
                    fontWeight: 700, paddingBottom: 9, borderBottom: `1px solid ${R.cizgi}`, marginBottom: 13,
                  }}>
                    İşlem izi · değişmez kayıt
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {iz.map((a, i) => {
                      const renk = a.renk || (a.bekliyor ? R.amber : R.yesil);
                      const son = i === iz.length - 1;
                      return (
                        <div key={i} style={{ display: 'flex', gap: 13 }}>
                          <div style={{ flexShrink: 0, width: 22, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <span style={{
                              width: 9, height: 9, borderRadius: 99, marginTop: 4,
                              background: a.bekliyor ? 'transparent' : renk,
                              boxShadow: a.bekliyor ? `inset 0 0 0 1.5px ${renk}` : `0 0 0 3px ${renk}26`,
                            }} />
                            {!son && <span style={{ flex: 1, width: 1, background: R.cizgi3, marginTop: 4 }} />}
                          </div>
                          <div style={{ paddingBottom: son ? 0 : 16, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, color: a.bekliyor ? R.metin2 : R.krem }}>{a.ad}</div>
                            <div style={{ fontSize: 11, color: R.not2, marginTop: 2, lineHeight: 1.5 }}>{a.detay}</div>
                            {a.zaman && (
                              <div style={{ fontFamily: F.mono, fontSize: 10, color: R.not3, marginTop: 3 }}>{a.zaman}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <SekmeBos
                  baslik="İşlem izi tutulmuyor"
                  aciklama="Bu kayıt tipi için adım adım iz defteri yok. Para hareketleri (ödeme, ciro, kasa) İşlem Defteri'nde değişmez kayıt olarak durur."
                />
              )}

              {dosyaBilgi && (
                <div>
                  <div style={{
                    fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2,
                    fontWeight: 700, paddingBottom: 9, borderBottom: `1px solid ${R.cizgi}`, marginBottom: 11,
                  }}>
                    Dosya bilgisi
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {Object.entries(dosyaBilgi).map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                        <span style={{ color: R.not2 }}>{k}</span>
                        <span style={{ fontFamily: F.mono, fontSize: 11.5, color: R.metin2, textAlign: 'right' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {sekme === 'ozet' && !!kpi?.length && (
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

          {sekme === 'ozet' && !!satirlar?.length && (
            <div>
              <div style={{
                fontSize: 11, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2,
                fontWeight: 700, paddingBottom: 9, borderBottom: `1px solid ${R.cizgi}`, marginBottom: 11,
              }}>
                {listeBaslik}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {satirlar.map((s, i) => {
                  // 🔴 EMNİYET KEMERİ (2026-08-14, canlı ölçüm): çekmece 448px ama
                  // içerik 569px'e taşıyordu — `tutar` span'ı koşulsuz `nowrap`ti ve
                  // Bakış oraya 70 karakterlik ham ödeme adını basıyordu (525px tek
                  // satır). Kaynak düzeltildi; burası ikinci katman: PARA gibi kısa
                  // değerler nowrap kalır, uzun metin gelirse sarar. Böylece ileride
                  // başka modül uzun metin bassa da çekmece bir daha taşamaz.
                  const uzunTutar = String(s.tutar || '').length > 24;
                  // ══════════════════════════════════════════════════════════
                  // 🚪 SATIR BİR KAPI OLABİLİR (2026-08-26) — EKLEMELİ
                  // ══════════════════════════════════════════════════════════
                  // Çekmece bugüne dek TEK KATMANLI ve ÇIKMAZ SOKAKTI: aç, düz
                  // listeyi oku, kapat. Oysa asıl güç "şu satırın içinde ne var"
                  // sorusunu sorabilmek. Satır `onTikla` verirse artık kapıdır.
                  //
                  // ⚠️ TAMAMEN EKLEMELİ: `onTikla` VERMEYEN satır bugünkü hâliyle
                  // birebir aynı çizilir (undefined → eski davranış). Sistemdeki
                  // diğer 50+ çekmecenin hiçbiri etkilenmez.
                  //
                  // ⚠️ KLAVYE DE AÇILIR: yalnız fareyle ulaşılan bir bilgi,
                  // olmayan bilgidir (KPI'da da aynı kural uygulanmıştı).
                  const kapi = typeof s.onTikla === 'function';
                  return (
                    <div
                      key={i}
                      onClick={s.onTikla}
                      tabIndex={kapi ? 0 : undefined}
                      role={kapi ? 'button' : undefined}
                      onKeyDown={kapi ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.onTikla(); }
                      } : undefined}
                      className={kapi ? 'v2-hover-kalk' : undefined}
                      style={{
                        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
                        ...(kapi ? {
                          cursor: 'pointer', borderRadius: 9, padding: '5px 8px', margin: '-5px -8px',
                          border: `1px solid ${R.cizgi}`,
                        } : null),
                      }}
                    >
                      {/* Hem ad hem detay sarabilir: boşluksuz uzun metin (fatura no,
                          referans, kesintisiz ad) hiçbir sütunda taşma üretemesin. */}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                          {s.ad}
                          {/* Tıklanabilirliğin GÖRÜNÜR işareti — yoksa kullanıcı
                              kapının varlığını ancak kazara keşfeder. */}
                          {kapi && <span style={{ color: R.bakir, marginLeft: 6, fontSize: 11 }}>›</span>}
                        </div>
                        <div style={{ fontSize: 11, color: R.not2, marginTop: 2, overflowWrap: 'anywhere' }}>{s.detay}</div>
                      </div>
                      <span style={{
                        whiteSpace: uzunTutar ? 'normal' : 'nowrap',
                        overflowWrap: 'anywhere', textAlign: 'right', maxWidth: '55%',
                        fontFamily: F.mono, fontSize: 12.5, fontWeight: 700, flexShrink: 0, color: R.metin2,
                      }}>
                        {s.tutar}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sekme === 'ozet' && not && (
            // Bilgi notu VURGU ÇALMASIN (sahip şikâyeti 2026-08-14): amber kutu
            // çekmecenin en dikkat çeken öğesiyken içeriği yalnız bir hatırlatma.
            // Küçültüldü — tüm modüllerin notları bundan etkilenir, kasıtlı.
            <div style={{
              padding: '9px 12px', borderRadius: 11, background: 'rgba(217,154,78,.09)',
              border: '1px solid rgba(217,154,78,.28)', fontSize: 11.5, color: '#E7DCCB', lineHeight: 1.55,
            }}>
              {not}
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: `1px solid ${R.cizgi}`, display: 'flex', gap: 9 }}>
          {aksiyonAd && !aksiyonlar?.length && (
            <button onClick={onAksiyon} style={{
              flex: 1, padding: 10, borderRadius: 10, border: 'none',
              background: `linear-gradient(150deg, #E0A559, #AF6C29)`, color: '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            }}>
              {aksiyonAd}
            </button>
          )}
          {!!aksiyonlar?.length && aksiyonlar.map((a, ai) => (
            <button key={ai} onClick={() => a.onTikla?.()} style={a.birincil ? {
              flex: 1, padding: 10, borderRadius: 10, border: 'none',
              background: `linear-gradient(150deg, #E0A559, #AF6C29)`, color: '#1C1309',
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
            } : {
              padding: '10px 14px', borderRadius: 10, border: `1px solid ${R.cizgi3}`,
              background: 'transparent', color: R.metin2, fontSize: 12.5, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
              {a.ad}
            </button>
          ))}
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
          background: `linear-gradient(150deg, #E0A559, #AF6C29)`, color: '#1C1309',
          fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        }}>
          Mevcut ekranı aç
        </button>
      )}
    </div>
  );
}
