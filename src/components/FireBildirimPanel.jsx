/**
 * Şube fire bildirimleri — merkez görünümü (sebep + kalem + açıklama).
 */
import { useCallback } from 'react';

const fmt = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

const sebepRenk = (kod) => {
  const m = {
    iade: '#f97316',
    sayim_hatasi: '#60a5fa',
    panel_hatasi: '#a78bfa',
    skt_bozulma: '#ef4444',
    hazirlik_deneme: '#94a3b8',
    kirilma_dokulme: '#fb923c',
    diger: '#71717a',
  };
  return m[kod] || '#ef4444';
};

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
      <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,.07)', border: '1px solid rgba(239,68,68,.25)', fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>
        <strong style={{ display: 'block', marginBottom: 4 }}>🔥 Şube Fire Bildirimleri</strong>
        Şubelerin girdiği kayıp/zayi bildirimleri: <strong>ne</strong>, <strong>kaç adet</strong>, <strong>sebep</strong> ve <strong>açıklama</strong>.
        Depo stoğu otomatik düşer; Stok Hareketi sekmesinde <code>FIRE</code> olarak da görünür.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn btn-secondary btn-sm" disabled={aramaYukleniyor} onClick={() => gunGit(isoTariheGunEkle(secilenTarih, -1))}>← Önceki gün</button>
        <input
          type="date"
          value={secilenTarih}
          onChange={(e) => gunGit(e.target.value)}
          style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12 }}
        />
        <button type="button" className="btn btn-secondary btn-sm" disabled={aramaYukleniyor} onClick={() => gunGit(isoTariheGunEkle(secilenTarih, 1))}>Sonraki gün →</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={aramaYukleniyor} onClick={() => gunGit(bugunStr)}>Bugün</button>
        <select
          value={sebepFiltre}
          onChange={async (e) => {
            const v = e.target.value;
            setSebepFiltre(v);
            await gunGit(secilenTarih, v);
          }}
          style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text1)', fontSize: 12 }}
        >
          <option value="">Tüm sebepler</option>
          {sebepSecenekleri.map((s) => (
            <option key={s.kod} value={s.kod}>{s.label}</option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost btn-sm" disabled={haftaYukleniyor} onClick={() => haftaYukle()}>7 gün özeti</button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
        <span style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.3)' }}>
          {secilenTarih}: <strong>{gunToplam}</strong> bildirim · <strong>{fmt(gunAdet)}</strong> adet fire
        </span>
      </div>

      {subeSekmeleri.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {subeSekmeleri.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSeciliSubeKey(t.key)}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: seciliSubeKey === t.key ? '1px solid rgba(239,68,68,.5)' : '1px solid var(--border)',
                background: seciliSubeKey === t.key ? 'rgba(239,68,68,.15)' : 'transparent',
                color: 'var(--text1)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {t.label} ({t.adet})
            </button>
          ))}
        </div>
      )}

      {haftaSatirlari.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
          {haftaSatirlari.map((h) => (
            <button
              key={h.tarih}
              type="button"
              onClick={() => gunGit(h.tarih)}
              style={{
                padding: '4px 8px',
                borderRadius: 5,
                border: h.tarih === secilenTarih ? '1px solid rgba(239,68,68,.45)' : '1px solid var(--border)',
                background: h.tarih === secilenTarih ? 'rgba(239,68,68,.1)' : 'var(--bg2)',
                cursor: 'pointer',
                color: 'var(--text2)',
              }}
            >
              {h.tarih.slice(5)} · {h.toplam} ({fmt(h.adet)} ad)
            </button>
          ))}
        </div>
      )}

      {aramaYukleniyor && <div style={{ color: 'var(--text3)', fontSize: 13 }}>Yükleniyor…</div>}

      {!aramaYukleniyor && gorunenKayitlar.length === 0 && (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
          Bu tarihte fire bildirimi yok.
        </div>
      )}

      {gorunenKayitlar.map((k) => {
        const renk = sebepRenk(k.sebep_kodu);
        const busy = onayBusyId === `fb:${k.id}`;
        return (
          <div
            key={k.id}
            style={{
              borderRadius: 10,
              border: `1px solid ${renk}55`,
              background: `${renk}0c`,
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '10px 14px', background: `${renk}18`, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{k.sube_ad || k.sube_id}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {k.olusturma ? String(k.olusturma).replace('T', ' ').slice(0, 16) : k.tarih}
                  {k.personel_ad ? ` · ${k.personel_ad}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: `${renk}33`, color: renk }}>
                  {k.sebep_label || k.sebep_kodu}
                </span>
                <span style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(0,0,0,.2)' }}>
                  {fmt(k.toplam_adet)} adet
                </span>
                {!k.goruldu && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => gorulduIsaretle(k.id)}
                    style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', fontSize: 11, cursor: 'pointer' }}
                  >
                    {busy ? '…' : 'Görüldü'}
                  </button>
                )}
                {k.goruldu && (
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>✓ görüldü</span>
                )}
              </div>
            </div>
            <div style={{ padding: '12px 14px', fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ marginBottom: 10, color: 'var(--text2)' }}>
                <strong>Açıklama:</strong> {k.aciklama}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(k.kalemler || []).map((line, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: 'rgba(239,68,68,.08)',
                      border: '1px solid rgba(239,68,68,.2)',
                      fontSize: 11,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{line.label || line.kalem_kodu}</span>
                    <span style={{ marginLeft: 6, color: 'var(--text3)' }}>×{fmt(line.miktar)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
