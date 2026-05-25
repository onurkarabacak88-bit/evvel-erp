/**
 * Şube Fire Bildirimleri — Merkez görünümü (profesyonel yeniden tasarım)
 * Sebep + kalem + açıklama + iade bilgisi + görüldü işaretleme
 */
import { useCallback, useState } from 'react';

const fmt = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

const SEBEP_META = {
  kirma_dokulme:   { ico: '💔', renk: '#fb923c', label: 'Kırma/Dökülme' },
  kirilma_dokulme: { ico: '💔', renk: '#fb923c', label: 'Kırma/Dökülme' },
  skt_bozulma:     { ico: '🟡', renk: '#ef4444', label: 'SKT/Bozulma' },
  iade:            { ico: '↩️', renk: '#f97316', label: 'Müşteri İadesi' },
  hazirlik_deneme: { ico: '📦', renk: '#94a3b8', label: 'Hazırlık/Deneme' },
  sayim_hatasi:    { ico: '🔢', renk: '#60a5fa', label: 'Sayım Hatası' },
  panel_hatasi:    { ico: '🔧', renk: '#a78bfa', label: 'Panel Hatası' },
  siparis_iptali:  { ico: '🚫', renk: '#a78bfa', label: 'Sipariş İptali' },
  diger:           { ico: '❓', renk: '#71717a', label: 'Diğer' },
};

const getSebep = (kod) => SEBEP_META[kod] || { ico: '🔥', renk: '#ef4444', label: kod || 'Fire' };

const zaman = (iso) => {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').slice(0, 16);
};

/* ── Metrik kutu ── */
function MetrikKart({ deger, etiket, renk, alt }) {
  return (
    <div style={{
      flex: 1, minWidth: 90,
      background: `${renk}12`,
      border: `1px solid ${renk}35`,
      borderRadius: 12,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 26, fontWeight: 900, color: renk, lineHeight: 1.1 }}>{deger}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, fontWeight: 600 }}>{etiket}</div>
      {alt != null && (
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 1 }}>{alt}</div>
      )}
    </div>
  );
}

/* ── Ürün chip'i ── */
function UrunChip({ line }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', borderRadius: 8,
      background: 'rgba(239,68,68,.09)',
      border: '1px solid rgba(239,68,68,.22)',
    }}>
      <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text1)' }}>
        {line.label || line.kalem_kodu}
      </span>
      <span style={{
        fontWeight: 800, fontSize: 11,
        background: 'rgba(239,68,68,.2)', color: '#fca5a5',
        borderRadius: 5, padding: '1px 6px',
      }}>
        ×{fmt(line.miktar)}
      </span>
    </div>
  );
}

/* ── Tek bildirim kartı ── */
function FireKart({ k, onayBusyId, gorulduIsaretle }) {
  const [acik, setAcik] = useState(false);
  const sbp = getSebep(k.sebep_kodu);
  const busy = onayBusyId === `fb:${k.id}`;
  const kalemler = k.kalemler || [];

  return (
    <div style={{
      borderRadius: 12,
      overflow: 'hidden',
      background: 'rgba(255,255,255,.035)',
      border: '1px solid rgba(255,255,255,.08)',
      display: 'flex',
    }}>
      {/* Sol renk çubuğu */}
      <div style={{
        width: 4, flexShrink: 0,
        background: `linear-gradient(180deg, ${sbp.renk} 0%, ${sbp.renk}88 100%)`,
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{
          padding: '11px 14px 9px',
          borderBottom: '1px solid rgba(255,255,255,.06)',
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-start', gap: 10, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text1)' }}>
              {k.sube_ad || k.sube_id}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>🕐 {zaman(k.olusturma)}</span>
              {k.personel_ad && <span>· 👤 {k.personel_ad}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Sebep badge */}
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: `${sbp.renk}25`, color: sbp.renk,
              border: `1px solid ${sbp.renk}50`,
            }}>
              {sbp.ico} {k.sebep_label || sbp.label}
            </span>
            {/* Adet badge */}
            <span style={{
              padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 800,
              background: 'rgba(239,68,68,.18)', color: '#fca5a5',
              border: '1px solid rgba(239,68,68,.35)',
            }}>
              🔥 {fmt(k.toplam_adet)} adet
            </span>
            {/* Görüldü */}
            {!k.goruldu ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => gorulduIsaretle(k.id)}
                style={{
                  padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                  border: '1px solid rgba(255,255,255,.2)',
                  background: 'rgba(255,255,255,.07)',
                  color: 'var(--text1)', cursor: 'pointer',
                  transition: 'background .15s',
                }}
              >
                {busy ? '⏳' : '👁 Görüldü'}
              </button>
            ) : (
              <span style={{ fontSize: 10, color: 'var(--ok)', fontWeight: 700 }}>✓ Görüldü</span>
            )}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '10px 14px 12px' }}>
          {/* Açıklama */}
          {k.aciklama && (
            <div style={{
              marginBottom: 10, padding: '8px 11px',
              borderRadius: 8, background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.07)',
              fontSize: 12, color: 'var(--text2)', lineHeight: 1.55,
            }}>
              <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: 3 }}>Açıklama</span>
              {k.aciklama}
            </div>
          )}

          {/* Ürünler */}
          {kalemler.length > 0 && (
            <div style={{ marginBottom: k.sebep_kodu === 'iade' ? 10 : 0 }}>
              <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
                Ürünler ({kalemler.length} kalem)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {kalemler.map((line, i) => <UrunChip key={i} line={line} />)}
              </div>
            </div>
          )}

          {/* İade bilgileri */}
          {k.sebep_kodu === 'iade' && (
            <div style={{
              marginTop: 4,
              borderRadius: 10,
              border: '1px solid rgba(249,115,22,.35)',
              background: 'rgba(249,115,22,.07)',
              overflow: 'hidden',
            }}>
              <button
                type="button"
                onClick={() => setAcik((v) => !v)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '9px 12px', background: 'transparent', border: 'none',
                  cursor: 'pointer', color: '#fdba74', fontWeight: 700, fontSize: 12,
                }}
              >
                <span>↩️ İade bilgileri</span>
                <span style={{ fontSize: 11, opacity: .75 }}>{acik ? '▲ gizle' : '▼ göster'}</span>
              </button>
              {acik && (
                <div style={{ padding: '0 12px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 14px', fontSize: 12, lineHeight: 1.5 }}>
                  <div>
                    <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700 }}>Fiş no</span>
                    <div style={{ color: '#fdba74', fontWeight: 700 }}>{k.fis_no || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700 }}>İade zamanı</span>
                    <div style={{ color: 'var(--text1)' }}>{k.iade_zaman || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700 }}>Müşteri</span>
                    <div style={{ color: 'var(--text1)', fontWeight: 600 }}>{k.iade_musteri_ad || '—'}</div>
                  </div>
                  <div>
                    <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700 }}>Telefon</span>
                    <div>
                      {k.iade_musteri_telefon ? (
                        <a
                          href={`tel:0${k.iade_musteri_telefon}`}
                          style={{ color: '#fdba74', fontWeight: 700, textDecoration: 'none' }}
                        >
                          0{String(k.iade_musteri_telefon).replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '$1 $2 $3 $4')}
                        </a>
                      ) : '—'}
                    </div>
                  </div>
                  <div style={{ gridColumn: '1/-1', marginTop: 2 }}>
                    <span style={{ color: 'var(--text3)', fontSize: 10, fontWeight: 700 }}>Panel kayıt zamanı</span>
                    <div style={{ color: 'var(--text3)', fontSize: 11 }}>{k.panel_kayit_zaman || zaman(k.olusturma)}</div>
                  </div>
                  <div style={{ gridColumn: '1/-1', marginTop: 4, padding: '6px 8px', borderRadius: 6, background: 'rgba(0,0,0,.2)', fontSize: 10, color: 'var(--text3)', lineHeight: 1.4 }}>
                    Müşteri adı ve telefonu şube panelinde saklanmaz — yalnızca bu ekranda görünür.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Haftalık bar ── */
function HaftaBar({ satirlar, secilenTarih, onGunSec }) {
  const max = Math.max(1, ...satirlar.map((h) => h.adet));
  return (
    <div style={{
      padding: '12px 14px',
      background: 'rgba(255,255,255,.03)',
      border: '1px solid rgba(255,255,255,.08)',
      borderRadius: 12, marginBottom: 2,
    }}>
      <div style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
        7 Günlük Özet
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 54 }}>
        {satirlar.map((h) => {
          const pct = h.adet > 0 ? Math.max(18, Math.round((h.adet / max) * 100)) : 6;
          const aktif = h.tarih === secilenTarih;
          return (
            <button
              key={h.tarih}
              type="button"
              onClick={() => onGunSec(h.tarih)}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 4, background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 0,
              }}
              title={`${h.tarih} · ${h.toplam} bildirim · ${fmt(h.adet)} adet`}
            >
              <div style={{ fontSize: 9, color: aktif ? '#f87171' : 'var(--text3)', fontWeight: aktif ? 700 : 400 }}>
                {fmt(h.adet)}
              </div>
              <div style={{
                width: '100%', borderRadius: 4,
                background: aktif
                  ? 'linear-gradient(180deg, #ef4444 0%, #991b1b 100%)'
                  : 'rgba(255,255,255,.12)',
                height: `${pct}%`,
                minHeight: 4,
                transition: 'height .25s',
              }} />
              <div style={{ fontSize: 9, color: aktif ? '#f87171' : 'var(--text3)', fontWeight: aktif ? 700 : 400 }}>
                {h.tarih.slice(5).replace('-', '/')}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Ana component ── */
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
  const bugunStr = bugunIsoTarih();
  const secilenTarih = aramaTarih || bugunStr;
  const tumKayitlar = Array.isArray(aramaSonuc?.kayitlar) ? aramaSonuc.kayitlar : [];
  const gunToplam = Number(aramaSonuc?.gun_toplam ?? tumKayitlar.length);
  const gunAdet = Number(aramaSonuc?.toplam_adet_gun ?? tumKayitlar.reduce((s, k) => s + (k.toplam_adet || 0), 0));
  const gorulmayanSayisi = tumKayitlar.filter((k) => !k.goruldu).length;
  const sebepSecenekleri = aramaSonuc?.sebep_secenekleri || [];

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Metrik bar ── */}
      <div style={{ display: 'flex', gap: 10 }}>
        <MetrikKart
          deger={aramaYukleniyor ? '…' : gunToplam}
          etiket="Bildirim"
          renk="#ef4444"
          alt={secilenTarih.slice(5).replace('-', '/')}
        />
        <MetrikKart
          deger={aramaYukleniyor ? '…' : fmt(gunAdet)}
          etiket="Toplam Adet"
          renk="#fb923c"
        />
        <MetrikKart
          deger={aramaYukleniyor ? '…' : gorulmayanSayisi}
          etiket="Görülmemiş"
          renk={gorulmayanSayisi > 0 ? '#f59e0b' : '#22c55e'}
        />
      </div>

      {/* ── Tarih navigasyonu ── */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 12px',
        background: 'rgba(255,255,255,.03)',
        border: '1px solid rgba(255,255,255,.08)',
        borderRadius: 12,
      }}>
        <button
          type="button"
          disabled={aramaYukleniyor}
          onClick={() => gunGit(isoTariheGunEkle(secilenTarih, -1))}
          style={navBtnStyle}
        >
          ← Önceki
        </button>
        <input
          type="date"
          value={secilenTarih}
          onChange={(e) => gunGit(e.target.value)}
          style={{
            flex: 1, minWidth: 130, padding: '7px 10px',
            borderRadius: 8, border: '1px solid rgba(255,255,255,.15)',
            background: 'rgba(255,255,255,.07)', color: 'var(--text1)',
            fontSize: 13, fontWeight: 600, textAlign: 'center',
          }}
        />
        <button
          type="button"
          disabled={aramaYukleniyor || secilenTarih >= bugunStr}
          onClick={() => gunGit(isoTariheGunEkle(secilenTarih, 1))}
          style={navBtnStyle}
        >
          Sonraki →
        </button>
        <button
          type="button"
          disabled={aramaYukleniyor || secilenTarih === bugunStr}
          onClick={() => gunGit(bugunStr)}
          style={{ ...navBtnStyle, background: 'rgba(239,68,68,.15)', borderColor: 'rgba(239,68,68,.35)', color: '#fca5a5' }}
        >
          Bugün
        </button>
        <button
          type="button"
          disabled={haftaYukleniyor}
          onClick={() => haftaYukle()}
          style={{ ...navBtnStyle, fontSize: 11 }}
        >
          {haftaYukleniyor ? '⏳' : '📊 7 Gün'}
        </button>
      </div>

      {/* ── Haftalık bar grafik ── */}
      {haftaSatirlari.length > 0 && (
        <HaftaBar
          satirlar={haftaSatirlari}
          secilenTarih={secilenTarih}
          onGunSec={gunGit}
        />
      )}

      {/* ── Sebep filtresi (chip) ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <SebepChip
          aktif={!sebepFiltre}
          label="Tümü"
          ico="🔥"
          renk="#ef4444"
          onClick={async () => {
            setSebepFiltre('');
            await gunGit(secilenTarih, '');
          }}
        />
        {sebepSecenekleri.map((s) => {
          const meta = getSebep(s.kod);
          return (
            <SebepChip
              key={s.kod}
              aktif={sebepFiltre === s.kod}
              label={meta.label}
              ico={meta.ico}
              renk={meta.renk}
              onClick={async () => {
                const v = s.kod;
                setSebepFiltre(v);
                await gunGit(secilenTarih, v);
              }}
            />
          );
        })}
      </div>

      {/* ── Şube sekmeleri ── */}
      {subeSekmeleri.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {subeSekmeleri.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSeciliSubeKey(t.key)}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                border: seciliSubeKey === t.key
                  ? '1px solid rgba(239,68,68,.55)'
                  : '1px solid rgba(255,255,255,.12)',
                background: seciliSubeKey === t.key
                  ? 'rgba(239,68,68,.18)'
                  : 'rgba(255,255,255,.05)',
                color: seciliSubeKey === t.key ? '#fca5a5' : 'var(--text2)',
                cursor: 'pointer', transition: 'all .15s',
              }}
            >
              {t.label} <span style={{ opacity: .7 }}>({t.adet})</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Yükleniyor ── */}
      {aramaYukleniyor && (
        <div style={{
          padding: '24px', textAlign: 'center',
          color: 'var(--text3)', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
          Yükleniyor…
        </div>
      )}

      {/* ── Boş durum ── */}
      {!aramaYukleniyor && gorunenKayitlar.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center',
          border: '1px dashed rgba(255,255,255,.1)',
          borderRadius: 12,
        }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text2)', marginBottom: 4 }}>
            Bu tarihte fire bildirimi yok
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {secilenTarih} · {sebepFiltre ? `${getSebep(sebepFiltre).label} filtresiyle` : 'tüm sebepler'}
          </div>
        </div>
      )}

      {/* ── Kayıt listesi ── */}
      {!aramaYukleniyor && gorunenKayitlar.map((k) => (
        <FireKart
          key={k.id}
          k={k}
          onayBusyId={onayBusyId}
          gorulduIsaretle={gorulduIsaretle}
        />
      ))}

    </div>
  );
}

/* ── Yardımcı: Sebep chip ── */
function SebepChip({ aktif, label, ico, renk, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
        border: aktif ? `1px solid ${renk}70` : '1px solid rgba(255,255,255,.1)',
        background: aktif ? `${renk}20` : 'rgba(255,255,255,.04)',
        color: aktif ? renk : 'var(--text3)',
        cursor: 'pointer', transition: 'all .15s',
      }}
    >
      {ico} {label}
    </button>
  );
}

/* ── Nav buton stili ── */
const navBtnStyle = {
  padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700,
  border: '1px solid rgba(255,255,255,.12)',
  background: 'rgba(255,255,255,.05)',
  color: 'var(--text1)', cursor: 'pointer',
  transition: 'background .15s',
  whiteSpace: 'nowrap',
};
