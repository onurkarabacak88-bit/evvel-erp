/**
 * 🔥 Fire Bildirim Merkezi — Laptop optimize, profesyonel yeniden tasarım v4
 * Animasyonlar · 2-panel layout · Yeni sebep tipleri · Zengin kart görünümü
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/* ── Animasyon keyframe'leri (SSR-safe) ── */
const STYLES = `
@keyframes fbSlideIn {
  from { opacity: 0; transform: translateY(16px) scale(.98); }
  to   { opacity: 1; transform: translateY(0)   scale(1);   }
}
@keyframes fbPulseRed {
  0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.0); }
  50%     { box-shadow: 0 0 0 6px rgba(239,68,68,.18); }
}
@keyframes fbBarGrow {
  from { height: 0; }
}
@keyframes fbCountUp {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fbFirePop {
  0%   { transform: scale(1) rotate(-5deg); }
  40%  { transform: scale(1.3) rotate(8deg); }
  70%  { transform: scale(.9) rotate(-3deg); }
  100% { transform: scale(1) rotate(0); }
}
@keyframes fbSpinner {
  to { transform: rotate(360deg); }
}
`;

function injectStyles() {
  if (typeof document === 'undefined') return;
  const id = 'fb-panel-v4-styles';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id; el.textContent = STYLES;
  document.head.appendChild(el);
}

/* ── Sebep meta ── */
const SEBEP_META = {
  kirma_dokulme:     { ico: '💔', renk: '#fb923c', label: 'Kırma / Dökülme' },
  kirilma_dokulme:   { ico: '💔', renk: '#fb923c', label: 'Kırma / Dökülme' },
  skt_bozulma:       { ico: '🟡', renk: '#ef4444', label: 'SKT / Bozulma' },
  iade:              { ico: '↩️', renk: '#f97316', label: 'Müşteri İadesi' },
  yanlis_urun:       { ico: '🔄', renk: '#f59e0b', label: 'Yanlış Ürün' },
  hazirlik_deneme:   { ico: '📦', renk: '#94a3b8', label: 'Hazırlık / Deneme' },
  personel_kullanim: { ico: '👤', renk: '#60a5fa', label: 'Personel Kullanımı' },
  ikram:             { ico: '🎁', renk: '#34d399', label: 'İkram' },
  sayim_hatasi:      { ico: '🔢', renk: '#a78bfa', label: 'Sayım Hatası' },
  panel_hatasi:      { ico: '🔧', renk: '#a78bfa', label: 'Panel Hatası' },
  siparis_iptali:    { ico: '🚫', renk: '#a78bfa', label: 'Sipariş İptali' },
  diger:             { ico: '❓', renk: '#71717a', label: 'Diğer' },
};
const YANLIS_SENARYO_LABEL = {
  degisim:  { ico: '🔄', label: 'Ürün / Bardak Değişimi' },
  hazirlik: { ico: '❌', label: 'Hatalı Hazırlık' },
};
const IADE_SEBEP_LABEL = {
  begenmedi: '😒 Beğenmedi', sicaklik: '🌡️ Sıcaklık', yanlis: '❌ Yanlış Ürün',
  yabanci: '🐛 Yabancı Madde', bekleme: '⏱️ Uzun Bekleme', hasar: '📦 Hasar',
};

const getSebep = (k) => SEBEP_META[k] || { ico: '🔥', renk: '#ef4444', label: k || 'Fire' };
const fmt  = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });
const zaman = (iso) => iso ? String(iso).replace('T', ' ').slice(0, 16) : '—';
const zamanKisa = (iso) => {
  if (!iso) return '—';
  const s = String(iso);
  return s.slice(11, 16); // sadece saat:dakika
};

/* ══════════════════════════════════════════════════════════
   MetrikKart
══════════════════════════════════════════════════════════ */
function MetrikKart({ deger, etiket, renk, sub, pulse }) {
  return (
    <div style={{
      flex: 1, minWidth: 100,
      background: `${renk}10`,
      border: `1.5px solid ${renk}30`,
      borderRadius: 14,
      padding: '14px 16px',
      position: 'relative',
      overflow: 'hidden',
      animation: pulse ? 'fbPulseRed 2s ease-in-out infinite' : undefined,
    }}>
      <div style={{
        position: 'absolute', top: -10, right: -8,
        fontSize: 48, opacity: .07, lineHeight: 1, pointerEvents: 'none',
        color: renk,
      }}>●</div>
      <div style={{
        fontSize: 30, fontWeight: 900, color: renk, lineHeight: 1,
        animation: 'fbCountUp .4s ease-out both',
      }}>{deger}</div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,.45)', marginTop: 5, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase' }}>{etiket}</div>
      {sub != null && <div style={{ fontSize: 10, color: 'rgba(255,255,255,.3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   UrunChip
══════════════════════════════════════════════════════════ */
function UrunChip({ line }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '4px 10px', borderRadius: 8,
      background: 'rgba(239,68,68,.08)',
      border: '1px solid rgba(239,68,68,.2)',
    }}>
      <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text1)' }}>
        {line.label || line.kalem_kodu}
      </span>
      <span style={{
        fontWeight: 900, fontSize: 11,
        background: 'rgba(239,68,68,.22)', color: '#fca5a5',
        borderRadius: 5, padding: '1px 7px',
      }}>×{fmt(line.miktar)}</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   FireKart
══════════════════════════════════════════════════════════ */
function FireKart({ k, onayBusyId, gorulduIsaretle, idx }) {
  const [acik, setAcik] = useState(false);
  const sbp    = getSebep(k.sebep_kodu);
  const busy   = onayBusyId === `fb:${k.id}`;
  const kalemler = k.kalemler || [];
  const gorulmedi = !k.goruldu;

  return (
    <div
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        background: gorulmedi
          ? `linear-gradient(135deg, rgba(239,68,68,.06) 0%, rgba(255,255,255,.03) 100%)`
          : 'rgba(255,255,255,.03)',
        border: gorulmedi
          ? `1px solid ${sbp.renk}35`
          : '1px solid rgba(255,255,255,.07)',
        display: 'flex',
        animation: `fbSlideIn .32s cubic-bezier(.25,.8,.25,1) ${idx * 0.05}s both`,
        transition: 'box-shadow .2s',
        boxShadow: gorulmedi ? `0 2px 16px ${sbp.renk}14` : 'none',
      }}
    >
      {/* Sol renk şeridi */}
      <div style={{
        width: 5, flexShrink: 0,
        background: `linear-gradient(180deg, ${sbp.renk} 0%, ${sbp.renk}44 100%)`,
        borderRadius: '14px 0 0 14px',
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>

        {/* ── Header ── */}
        <div style={{
          padding: '12px 16px 10px',
          borderBottom: '1px solid rgba(255,255,255,.05)',
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-start', gap: 10,
        }}>
          {/* Sol: şube + zaman + personel */}
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontWeight: 800, fontSize: 15, color: 'var(--text1)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {gorulmedi && (
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: sbp.renk,
                  display: 'inline-block', flexShrink: 0,
                  boxShadow: `0 0 6px ${sbp.renk}`,
                }} />
              )}
              {k.sube_ad || k.sube_id}
            </div>
            <div style={{
              marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap',
              alignItems: 'center', fontSize: 11, color: 'rgba(255,255,255,.4)',
            }}>
              <span>🕐 {zaman(k.olusturma)}</span>
              {k.personel_ad && <span>· 👤 {k.personel_ad}</span>}
            </div>
          </div>

          {/* Sağ: badge'lar + görüldü */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
            {/* Sebep badge */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 11px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: `${sbp.renk}20`, color: sbp.renk,
              border: `1px solid ${sbp.renk}45`,
            }}>
              {sbp.ico} {k.sebep_label || sbp.label}
            </span>

            {/* Yanlış ürün senaryo chip */}
            {k.sebep_kodu === 'yanlis_urun' && k.yanlis_senaryo && (() => {
              const ys = YANLIS_SENARYO_LABEL[k.yanlis_senaryo] || {};
              return (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                  background: 'rgba(251,191,36,.12)', color: '#fde68a',
                  border: '1px solid rgba(251,191,36,.3)',
                }}>
                  {ys.ico} {ys.label}
                </span>
              );
            })()}

            {/* Adet badge */}
            <span style={{
              padding: '4px 11px', borderRadius: 20, fontSize: 11, fontWeight: 800,
              background: 'rgba(239,68,68,.16)', color: '#fca5a5',
              border: '1px solid rgba(239,68,68,.32)',
            }}>
              🔥 {fmt(k.toplam_adet)} adet
            </span>

            {/* Görüldü butonu */}
            {gorulmedi ? (
              <button
                type="button" disabled={busy}
                onClick={() => gorulduIsaretle(k.id)}
                style={{
                  padding: '4px 11px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                  border: '1px solid rgba(255,255,255,.18)',
                  background: 'rgba(255,255,255,.06)',
                  color: 'var(--text1)', cursor: 'pointer',
                  transition: 'background .15s, transform .1s',
                  whiteSpace: 'nowrap',
                }}
              >
                {busy
                  ? <span style={{ display: 'inline-block', animation: 'fbSpinner .7s linear infinite' }}>⏳</span>
                  : '👁 Görüldü'}
              </button>
            ) : (
              <span style={{ fontSize: 10, color: '#4ade80', fontWeight: 700 }}>✓ Görüldü</span>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: '10px 16px 14px' }}>

          {/* Ürünler */}
          {kalemler.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{
                fontSize: 10, color: 'rgba(255,255,255,.3)', fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7,
              }}>
                Ürünler
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {kalemler.map((line, i) => <UrunChip key={i} line={line} />)}
              </div>
            </div>
          )}

          {/* Açıklama */}
          {k.aciklama && (
            <div style={{
              marginBottom: 10, padding: '8px 12px',
              borderRadius: 9, background: 'rgba(255,255,255,.03)',
              border: '1px solid rgba(255,255,255,.06)',
              fontSize: 12, color: 'rgba(255,255,255,.55)', lineHeight: 1.6,
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', letterSpacing: '.04em', marginRight: 6 }}>Not:</span>
              {k.aciklama}
            </div>
          )}

          {/* ── İade bilgileri ── */}
          {k.sebep_kodu === 'iade' && (
            <SekmeBlok
              ico="↩️"
              baslik="İade Bilgileri"
              renk="#f97316"
              acik={acik}
              setAcik={setAcik}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 12 }}>
                <BilgiSatir label="İade Sebebi" deger={IADE_SEBEP_LABEL[k.iade_sebep_kodu] || k.iade_sebep_kodu} vurgu />
                <BilgiSatir label="Fiş no" deger={k.fis_no} />
                <BilgiSatir label="İade zamanı" deger={k.iade_zaman} />
                {k.iade_musteri_ad && (
                  <BilgiSatir label="Müşteri Adı" deger={k.iade_musteri_ad} vurgu />
                )}
                {k.iade_musteri_telefon && (
                  <div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,.3)', fontWeight: 700, marginBottom: 3 }}>Telefon 🔒</div>
                    <a
                      href={`tel:0${k.iade_musteri_telefon}`}
                      style={{ color: '#fdba74', fontWeight: 700, fontSize: 12, textDecoration: 'none' }}
                    >
                      0{String(k.iade_musteri_telefon).replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '$1 $2 $3 $4')}
                    </a>
                  </div>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,.2)', lineHeight: 1.5 }}>
                Telefon numarası yalnızca operasyon merkezinde görünür — şube panelinde saklanmaz.
              </div>
            </SekmeBlok>
          )}

          {/* ── Yanlış Ürün detayları ── */}
          {k.sebep_kodu === 'yanlis_urun' && k.yanlis_senaryo && (() => {
            const ys = YANLIS_SENARYO_LABEL[k.yanlis_senaryo] || {};
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 9,
                background: 'rgba(251,191,36,.08)',
                border: '1px solid rgba(251,191,36,.2)',
                fontSize: 12, color: '#fde68a', fontWeight: 600,
              }}>
                {ys.ico} {ys.label}
              </div>
            );
          })()}

        </div>
      </div>
    </div>
  );
}

/* ── Küçük yardımcı: açılır-kapanır blok ── */
function SekmeBlok({ ico, baslik, renk, acik, setAcik, children }) {
  return (
    <div style={{
      borderRadius: 10, border: `1px solid ${renk}30`,
      background: `${renk}08`, overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setAcik((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '9px 13px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: renk, fontWeight: 700, fontSize: 12,
        }}
      >
        <span>{ico} {baslik}</span>
        <span style={{ fontSize: 10, opacity: .7, transition: 'transform .2s', transform: acik ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {acik && (
        <div style={{ padding: '0 13px 13px', animation: 'fbSlideIn .2s ease-out both' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ── Bilgi satırı ── */
function BilgiSatir({ label, deger, vurgu }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,.28)', fontWeight: 700, marginBottom: 2 }}>{label}</div>
      <div style={{ color: vurgu ? '#fdba74' : 'var(--text1)', fontWeight: vurgu ? 700 : 500, fontSize: 12 }}>{deger || '—'}</div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   HaftaBar — animasyonlu çubuk grafik
══════════════════════════════════════════════════════════ */
function HaftaBar({ satirlar, secilenTarih, onGunSec }) {
  const max = Math.max(1, ...satirlar.map((h) => h.adet));
  return (
    <div style={{
      padding: '14px 16px 12px',
      background: 'rgba(255,255,255,.025)',
      border: '1px solid rgba(255,255,255,.07)',
      borderRadius: 14,
    }}>
      <div style={{
        fontSize: 10, color: 'rgba(255,255,255,.3)', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 12,
      }}>
        📊 7 Günlük Fire Trendi
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 64 }}>
        {satirlar.map((h, i) => {
          const pct = h.adet > 0 ? Math.max(14, Math.round((h.adet / max) * 100)) : 5;
          const aktif = h.tarih === secilenTarih;
          const gunAdi = ['Pz','Pt','Sa','Ça','Pe','Cu','Ct'][new Date(h.tarih).getDay()];
          return (
            <button
              key={h.tarih} type="button"
              onClick={() => onGunSec(h.tarih)}
              title={`${h.tarih} · ${h.toplam} bildirim · ${fmt(h.adet)} adet`}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              <div style={{
                fontSize: 9, fontWeight: aktif ? 800 : 400,
                color: aktif ? '#f87171' : 'rgba(255,255,255,.3)',
                transition: 'color .2s',
              }}>
                {h.adet > 0 ? fmt(h.adet) : ''}
              </div>
              <div style={{
                width: '100%', borderRadius: 5,
                background: aktif
                  ? `linear-gradient(180deg, #ef4444 0%, #7f1d1d 100%)`
                  : `rgba(255,255,255,.${h.adet > 0 ? '14' : '06'})`,
                height: `${pct}%`, minHeight: 4,
                transition: 'height .35s cubic-bezier(.34,1.2,.64,1), background .2s',
                animation: `fbBarGrow .4s ${i * .05}s ease-out both`,
                boxShadow: aktif ? '0 2px 12px rgba(239,68,68,.4)' : 'none',
              }} />
              <div style={{
                fontSize: 9, fontWeight: aktif ? 700 : 400,
                color: aktif ? '#f87171' : 'rgba(255,255,255,.28)',
              }}>
                {gunAdi}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   SebepChip
══════════════════════════════════════════════════════════ */
function SebepChip({ aktif, label, ico, renk, sayi, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '5px 13px', borderRadius: 20, fontSize: 11, fontWeight: 700,
      border: aktif ? `1.5px solid ${renk}60` : '1px solid rgba(255,255,255,.1)',
      background: aktif ? `${renk}1e` : 'rgba(255,255,255,.04)',
      color: aktif ? renk : 'rgba(255,255,255,.4)',
      cursor: 'pointer', transition: 'all .15s',
      boxShadow: aktif ? `0 2px 12px ${renk}25` : 'none',
    }}>
      {ico} {label}
      {sayi != null && (
        <span style={{
          background: aktif ? `${renk}30` : 'rgba(255,255,255,.08)',
          color: aktif ? renk : 'rgba(255,255,255,.35)',
          borderRadius: 10, padding: '0px 6px', fontSize: 10, fontWeight: 800,
        }}>{sayi}</span>
      )}
    </button>
  );
}

/* ══════════════════════════════════════════════════════════
   Ana bileşen
══════════════════════════════════════════════════════════ */
export default function FireBildirimPanel({
  api,
  toast,
  bugunIsoTarih,
  isoTariheGunEkle,
  aramaSonuc,
  setAramaSonuc,
  aramaTarih,
  setAramaTarih,
  aramaYukleniyor,
  setAramaYukleniyor,
  sebepFiltre,
  setSebepFiltre,
  gunYukle,
  haftaYukle,
  haftaSatirlari,
  haftaYukleniyor,
  seciliSubeKey,
  setSeciliSubeKey,
  subeSekmeleri,
  gorunenKayitlar,
  onayBusyId,
  setOnayBusyId,
}) {
  injectStyles();

  const bugunStr       = bugunIsoTarih();
  const secilenTarih   = aramaTarih || bugunStr;
  const tumKayitlar    = Array.isArray(aramaSonuc?.kayitlar) ? aramaSonuc.kayitlar : [];
  const gunToplam      = Number(aramaSonuc?.gun_toplam ?? tumKayitlar.length);
  const gunAdet        = Number(aramaSonuc?.toplam_adet_gun ?? tumKayitlar.reduce((s, k) => s + (k.toplam_adet || 0), 0));
  const gorulmayanSay  = tumKayitlar.filter((k) => !k.goruldu).length;
  const sebepSecenekleri = aramaSonuc?.sebep_secenekleri || [];

  /* Sebep dağılımı (bar hesabı için) */
  const sebepDagilim = {};
  tumKayitlar.forEach((k) => {
    sebepDagilim[k.sebep_kodu] = (sebepDagilim[k.sebep_kodu] || 0) + 1;
  });

  const gunGit = useCallback(async (yeniTarih, sebepOverride) => {
    setAramaTarih(yeniTarih);
    setAramaYukleniyor(true);
    try {
      const data = await gunYukle(yeniTarih, { sebep: sebepOverride ?? sebepFiltre });
      setAramaSonuc(data);
      setSeciliSubeKey('all');
    } catch (e) {
      toast(e.message || 'Veri yüklenemedi');
    } finally {
      setAramaYukleniyor(false);
    }
  }, [gunYukle, sebepFiltre, setAramaSonuc, setAramaTarih, setAramaYukleniyor, setSeciliSubeKey, toast]);

  const gorulduIsaretle = async (id) => {
    setOnayBusyId(`fb:${id}`);
    try {
      await api(`/ops/fire-bildirimler/${encodeURIComponent(id)}/goruldu`, { method: 'POST' });
      toast('Görüldü işaretlendi', 'green');
      const data = await gunYukle(secilenTarih, { sebep: sebepFiltre });
      setAramaSonuc(data);
    } catch (e) {
      toast(e.message || 'İşlem başarısız');
    } finally {
      setOnayBusyId(null);
    }
  };

  const bugunMu = secilenTarih === bugunStr;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ══ BAŞLIK KARTI ══ */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(239,68,68,.16) 0%, rgba(220,38,38,.08) 50%, rgba(153,27,27,.04) 100%)',
        border: '1px solid rgba(239,68,68,.25)',
        borderRadius: 16, padding: '18px 20px',
        display: 'flex', alignItems: 'center', gap: 14,
        flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 36, animation: 'fbFirePop 2s ease-in-out infinite alternate' }}>🔥</div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#fff', letterSpacing: '-.01em' }}>
            Fire Bildirim Merkezi
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,.4)', marginTop: 3 }}>
            {bugunMu ? 'Bugünün kayıtları' : secilenTarih} · Tüm şubeler
          </div>
        </div>

        {/* Tarih navigasyonu — başlık içinde */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <NavBtn onClick={() => gunGit(isoTariheGunEkle(secilenTarih, -1))} disabled={aramaYukleniyor}>← Önceki</NavBtn>
          <input
            type="date" value={secilenTarih}
            onChange={(e) => gunGit(e.target.value)}
            style={{
              padding: '7px 10px', borderRadius: 9,
              border: '1px solid rgba(255,255,255,.18)',
              background: 'rgba(0,0,0,.25)', color: '#fff',
              fontSize: 13, fontWeight: 700, textAlign: 'center',
              minWidth: 130,
            }}
          />
          <NavBtn onClick={() => gunGit(isoTariheGunEkle(secilenTarih, 1))} disabled={aramaYukleniyor || secilenTarih >= bugunStr}>Sonraki →</NavBtn>
          {!bugunMu && (
            <NavBtn
              onClick={() => gunGit(bugunStr)}
              disabled={aramaYukleniyor}
              style={{ background: 'rgba(239,68,68,.18)', borderColor: 'rgba(239,68,68,.4)', color: '#fca5a5' }}
            >Bugün</NavBtn>
          )}
          <NavBtn onClick={() => haftaYukle()} disabled={haftaYukleniyor}>
            {haftaYukleniyor ? '⏳' : '📊 7 Gün'}
          </NavBtn>
        </div>
      </div>

      {/* ══ METRİKLER ══ */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <MetrikKart
          deger={aramaYukleniyor ? '…' : gunToplam}
          etiket="Bildirim"
          renk="#ef4444"
          sub={secilenTarih.slice(5).replace('-', '/')}
        />
        <MetrikKart
          deger={aramaYukleniyor ? '…' : fmt(gunAdet)}
          etiket="Toplam Adet"
          renk="#fb923c"
        />
        <MetrikKart
          deger={aramaYukleniyor ? '…' : gorulmayanSay}
          etiket="Görülmemiş"
          renk={gorulmayanSay > 0 ? '#f59e0b' : '#22c55e'}
          pulse={gorulmayanSay > 0}
          sub={gorulmayanSay > 0 ? 'Onay bekliyor' : 'Tümü onaylandı'}
        />
        {subeSekmeleri.length > 1 && (
          <MetrikKart
            deger={subeSekmeleri.length - 1}
            etiket="Aktif Şube"
            renk="#60a5fa"
          />
        )}
      </div>

      {/* ══ 7 GÜNLÜK TREND ══ */}
      {haftaSatirlari.length > 0 && (
        <HaftaBar
          satirlar={haftaSatirlari}
          secilenTarih={secilenTarih}
          onGunSec={gunGit}
        />
      )}

      {/* ══ FİLTRELER (Sebep + Şube) — YAN YANA ══ */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: subeSekmeleri.length > 1 ? '1fr 1fr' : '1fr',
        gap: 10,
      }}>
        {/* Sebep filtresi */}
        <div style={{
          padding: '12px 14px',
          background: 'rgba(255,255,255,.02)',
          border: '1px solid rgba(255,255,255,.07)',
          borderRadius: 12,
        }}>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,.28)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 9 }}>
            Sebep Filtresi
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <SebepChip
              aktif={!sebepFiltre} label="Tümü" ico="🔥" renk="#ef4444"
              sayi={gunToplam || undefined}
              onClick={async () => { setSebepFiltre(''); await gunGit(secilenTarih, ''); }}
            />
            {sebepSecenekleri.map((s) => {
              const meta = getSebep(s.kod);
              return (
                <SebepChip
                  key={s.kod}
                  aktif={sebepFiltre === s.kod}
                  label={meta.label} ico={meta.ico} renk={meta.renk}
                  sayi={sebepDagilim[s.kod] || undefined}
                  onClick={async () => { setSebepFiltre(s.kod); await gunGit(secilenTarih, s.kod); }}
                />
              );
            })}
          </div>
        </div>

        {/* Şube sekmeleri */}
        {subeSekmeleri.length > 1 && (
          <div style={{
            padding: '12px 14px',
            background: 'rgba(255,255,255,.02)',
            border: '1px solid rgba(255,255,255,.07)',
            borderRadius: 12,
          }}>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,.28)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 9 }}>
              Şube Filtresi
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {subeSekmeleri.map((t) => (
                <button key={t.key} type="button"
                  onClick={() => setSeciliSubeKey(t.key)}
                  style={{
                    padding: '5px 13px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                    border: seciliSubeKey === t.key
                      ? '1.5px solid rgba(96,165,250,.55)'
                      : '1px solid rgba(255,255,255,.1)',
                    background: seciliSubeKey === t.key
                      ? 'rgba(96,165,250,.18)'
                      : 'rgba(255,255,255,.04)',
                    color: seciliSubeKey === t.key ? '#93c5fd' : 'rgba(255,255,255,.4)',
                    cursor: 'pointer', transition: 'all .15s',
                    boxShadow: seciliSubeKey === t.key ? '0 2px 10px rgba(96,165,250,.2)' : 'none',
                  }}
                >
                  {t.label}
                  <span style={{ marginLeft: 5, opacity: .65, fontSize: 10 }}>({t.adet})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ══ YÜKLENİYOR ══ */}
      {aramaYukleniyor && (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          color: 'rgba(255,255,255,.35)', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          border: '1px dashed rgba(255,255,255,.08)', borderRadius: 14,
        }}>
          <span style={{ fontSize: 22, animation: 'fbSpinner .8s linear infinite', display: 'inline-block' }}>⏳</span>
          Veriler yükleniyor…
        </div>
      )}

      {/* ══ BOŞ DURUM ══ */}
      {!aramaYukleniyor && gorunenKayitlar.length === 0 && (
        <div style={{
          padding: '48px 20px', textAlign: 'center',
          border: '1px dashed rgba(255,255,255,.09)', borderRadius: 16,
          background: 'rgba(255,255,255,.01)',
        }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(255,255,255,.6)', marginBottom: 5 }}>
            Bu tarihte fire bildirimi yok
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,.3)' }}>
            {secilenTarih} · {sebepFiltre ? `${getSebep(sebepFiltre).label} filtresi` : 'tüm sebepler'}
          </div>
        </div>
      )}

      {/* ══ KAYIT LİSTESİ ══ */}
      {!aramaYukleniyor && gorunenKayitlar.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Liste başlığı */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,.06)',
          }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>
              {gorunenKayitlar.length} Kayıt
            </div>
            {gorulmayanSay > 0 && (
              <div style={{ fontSize: 11, color: '#fbbf24', fontWeight: 700 }}>
                ⚠️ {gorulmayanSay} görülmemiş
              </div>
            )}
          </div>

          {gorunenKayitlar.map((k, idx) => (
            <FireKart
              key={k.id}
              k={k}
              idx={idx}
              onayBusyId={onayBusyId}
              gorulduIsaretle={gorulduIsaretle}
            />
          ))}
        </div>
      )}

    </div>
  );
}

/* ── NavBtn ── */
function NavBtn({ children, onClick, disabled, style }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{
      padding: '7px 13px', borderRadius: 9, fontSize: 12, fontWeight: 700,
      border: '1px solid rgba(255,255,255,.14)',
      background: 'rgba(255,255,255,.06)',
      color: disabled ? 'rgba(255,255,255,.25)' : 'var(--text1)',
      cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'background .15s',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {children}
    </button>
  );
}
