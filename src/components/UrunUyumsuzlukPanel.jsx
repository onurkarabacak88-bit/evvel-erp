/**
 * Depo stok ürün uyumsuzlukları — Kasa Uyumsuzluğu ile aynı kart / kuyruk deseni.
 */
import { useCallback, useState } from 'react';

const fmt = (v) => Number(v || 0).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

const sevRenk = (absFark) => absFark >= 20
  ? { border: 'rgba(220,38,38,0.45)', bg: 'rgba(220,38,38,0.06)', hdr: 'rgba(220,38,38,0.1)', sep: 'rgba(220,38,38,0.2)', badge: 'rgba(220,38,38,0.25)', badgeTxt: '#fca5a5' }
  : absFark >= 5
    ? { border: 'rgba(240,128,64,0.4)', bg: 'rgba(240,128,64,0.04)', hdr: 'rgba(240,128,64,0.09)', sep: 'rgba(240,128,64,0.2)', badge: 'rgba(240,128,64,0.25)', badgeTxt: '#fdba74' }
    : { border: 'rgba(139,92,246,0.4)', bg: 'rgba(139,92,246,0.04)', hdr: 'rgba(139,92,246,0.1)', sep: 'rgba(139,92,246,0.2)', badge: 'rgba(139,92,246,0.3)', badgeTxt: '#ddd6fe' };

export default function UrunUyumsuzlukPanel({
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
  durumFiltre,
  setDurumFiltre,
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
  onRefreshHub,
}) {
  const [duzeltModal, setDuzeltModal] = useState(null);
  const [duzeltBusy, setDuzeltBusy] = useState(false);

  const bugunStr = bugunIsoTarih();
  const secilenTarih = aramaTarih || bugunStr;
  const tumKayitlar = Array.isArray(aramaSonuc?.kayitlar) ? aramaSonuc.kayitlar : [];
  const gunToplam = Number(aramaSonuc?.gun_toplam ?? tumKayitlar.length);
  const gunBekleyen = Number(aramaSonuc?.gun_bekleyen ?? tumKayitlar.filter((u) => !u.cozuldu).length);
  const gunCozuldu = Number(aramaSonuc?.gun_cozuldu ?? tumKayitlar.filter((u) => u.cozuldu).length);

  const devirKayitlar = gorunenKayitlar.filter((u) => u.tip === 'STOK_BAR_DEVIR_FARK');
  const gunIciKayitlar = gorunenKayitlar.filter((u) => u.tip === 'STOK_BAR_GUN_ICI_FARK');
  const urunAcKayitlar = gorunenKayitlar.filter((u) => u.tip === 'URUN_AC_UYUMSUZLUK');

  const kuGunGit = useCallback(async (yeniTarih, durumOverride) => {
    setAramaTarih(yeniTarih);
    setAramaYukleniyor(true);
    try {
      const data = await gunYukle(yeniTarih, { durum: durumOverride || durumFiltre });
      setAramaSonuc(data);
      setSeciliSubeKey('all');
    } catch (e) {
      toast(e.message || 'Veri yüklenemedi');
    } finally {
      setAramaYukleniyor(false);
    }
  }, [durumFiltre, gunYukle, setAramaSonuc, setAramaTarih, setAramaYukleniyor, setSeciliSubeKey, toast]);

  const kuDurumDegistir = async (yeniDurum) => {
    setDurumFiltre(yeniDurum);
    await kuGunGit(secilenTarih, yeniDurum);
  };

  const coz = async (uid, farkTl) => {
    const neden = window.prompt('Çözüm notu (opsiyonel):') ?? '';
    setOnayBusyId(`uu:${uid}`);
    try {
      await api(`/ops/urun-uyumsuzluk/${encodeURIComponent(uid)}/coz`, {
        method: 'POST',
        body: { notu: (neden || '').trim() },
      });
      toast('Çözüldü işaretlendi', 'green');
      const yeniDurum = durumFiltre === 'bekleyen' ? 'cozuldu' : durumFiltre;
      if (yeniDurum !== durumFiltre) setDurumFiltre(yeniDurum);
      const data = await gunYukle(secilenTarih, { durum: yeniDurum });
      setAramaSonuc(data);
      if (onRefreshHub) await onRefreshHub();
    } catch (e) {
      toast(e.message || 'Kayıt çözülemedi');
    } finally {
      setOnayBusyId(null);
    }
  };

  const duzeltGonder = async () => {
    if (!duzeltModal) return;
    const { uyari, sebep, payload } = duzeltModal;
    if (sebep === 'depo_girisi' && (!Number.isFinite(Number(payload.giris_adet)) || Number(payload.giris_adet) <= 0)) {
      toast('Depo giriş adedi 1 veya üzeri olmalı', 'red');
      return;
    }
    setDuzeltBusy(true);
    try {
      const { _notu, ...apiPayload } = payload || {};
      const r = await api(`/ops/urun-uyumsuzluk/${encodeURIComponent(uyari.id)}/kaynak-duzelt`, {
        method: 'POST',
        body: { sebep, payload: apiPayload, notu: (_notu || '').trim() || null },
      });
      if (sebep === 'depo_girisi') {
        toast(
          r?.otomatik_cozuldu
            ? `Depo girişi tamam: +${r?.giris_adet} ad, borç kapandı (${r?.kalem_adi})`
            : `Depo girişi: +${r?.giris_adet} ad — kalan borç ${r?.kalan_borc} ad`,
          'green',
        );
      } else {
        toast(
          r?.otomatik_cozuldu
            ? 'Düzeltildi — fark sıfırlandı, kayıt çözüldü'
            : `Düzeltildi: fark ${Number(r?.eski_fark || 0)} → ${Number(r?.yeni_fark || 0)} adet`,
          'green',
        );
      }
      const otomatikCoz = !!r?.otomatik_cozuldu;
      const yeniDurum = (durumFiltre === 'bekleyen' && otomatikCoz) ? 'cozuldu' : durumFiltre;
      if (yeniDurum !== durumFiltre) setDurumFiltre(yeniDurum);
      const data = await gunYukle(secilenTarih, { durum: yeniDurum });
      setAramaSonuc(data);
      setDuzeltModal(null);
      if (onRefreshHub) await onRefreshHub();
    } catch (e) {
      toast(e.message || 'Düzeltme başarısız', 'red');
    } finally {
      setDuzeltBusy(false);
    }
  };

  const CozulduRozet = ({ u }) => {
    const duz = u?.cozum_duzeltilen_tl;
    const show = duz != null && Number.isFinite(Number(duz));
    return (
      <span style={{ background: 'rgba(34,197,94,0.2)', color: '#4ade80', borderRadius: 5, padding: '1px 8px', fontSize: 10, fontWeight: 700 }}>
        ✓ Çözüldü
        {show && <span style={{ marginLeft: 6, fontFamily: 'monospace' }}>→ {Number(duz)} ad</span>}
      </span>
    );
  };

  const Kutu = ({ label, val, renk, sep, alt }) => (
    <div style={{ padding: '10px 12px', borderRight: sep ? `1px solid var(--border)` : 'none' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, fontFamily: 'monospace', color: renk || 'inherit' }}>{fmt(val)}</div>
      {alt && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>{alt}</div>}
    </div>
  );

  const StokKart = ({ u, tipLabel, formulaText, children, varsayilanSebep }) => {
    const cozuldu = !!u.cozuldu;
    const fark = Number(u?.fark_tl || 0);
    const absFark = Math.abs(fark);
    const r = sevRenk(absFark);
    const d = u.detay_json || {};
    const kalemAd = u.kalem_adi || d.kalem_adi || u.kalem_kodu || '—';

    return (
      <div style={{ borderRadius: 10, border: `1px solid ${r.border}`, background: r.bg, overflow: 'hidden', opacity: cozuldu ? 0.85 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', padding: '9px 14px', borderBottom: `1px solid ${r.sep}`, background: r.hdr }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontSize: 13 }}>{tipLabel} {u.sube_adi || u.sube_id}</span>
            <span style={{ background: r.badge, color: r.badgeTxt, borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 800 }}>
              {kalemAd}
            </span>
            <span style={{ background: r.badge, color: r.badgeTxt, borderRadius: 6, padding: '2px 10px', fontSize: 13, fontWeight: 800, fontFamily: 'monospace' }}>
              {fark > 0 ? '+' : ''}{fmt(fark)} ad
            </span>
            {cozuldu ? <CozulduRozet u={u} /> : (
              <span style={{ fontSize: 10, color: 'var(--text3)', padding: '1px 7px', border: '1px solid var(--border)', borderRadius: 4 }}>
                Çözüm bekliyor
              </span>
            )}
          </div>
          {!cozuldu && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm"
                style={{ padding: '4px 10px', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24', fontWeight: 600, fontSize: 12 }}
                disabled={duzeltBusy || !!onayBusyId}
                onClick={() => setDuzeltModal({
                  uyari: u,
                  sebep: u.tip === 'URUN_AC_UYUMSUZLUK' ? 'depo_girisi' : varsayilanSebep,
                  payload: u.tip === 'URUN_AC_UYUMSUZLUK'
                    ? { giris_adet: Number((u.detay_json || {}).eksik_miktar || Math.abs(u.fark_tl || 0) || 1) }
                    : {},
                })}>
                {u.tip === 'URUN_AC_UYUMSUZLUK' ? '📦 Depo girişi' : '🔧 Kaynağı Düzelt'}
              </button>
              <button type="button" className="btn btn-sm"
                style={{ padding: '4px 12px', background: 'rgba(139,92,246,0.2)', border: '1px solid rgba(139,92,246,0.5)', color: '#ddd6fe', fontWeight: 600, fontSize: 12 }}
                disabled={!!onayBusyId}
                onClick={() => coz(u.id, u.fark_tl)}>
                {onayBusyId === `uu:${u.id}` ? '…' : 'Çözüldü işaretle'}
              </button>
            </div>
          )}
        </div>
        {formulaText && (
          <div style={{ padding: '8px 14px 4px', fontSize: 10, color: 'var(--text3)', borderBottom: `1px solid ${r.sep}`, fontFamily: 'monospace' }}>
            {formulaText}
          </div>
        )}
        {children}
        <div style={{ padding: '10px 14px', borderTop: children ? `1px solid ${r.sep}` : 'none' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 4 }}>Fark (0 olmalıydı)</div>
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'monospace', color: fark < 0 ? '#fca5a5' : fark > 0 ? '#fdba74' : 'var(--text2)' }}>
            {fark > 0 ? '+' : ''}{fmt(fark)} adet
          </div>
          {u.mesaj && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6, lineHeight: 1.45 }}>{u.mesaj}</div>}
          {cozuldu && (u.cozum_notu || u.cozum_ts) && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8, paddingTop: 8, borderTop: `1px solid ${r.sep}`, lineHeight: 1.45 }}>
              {u.cozum_notu && <div><strong>Çözüm:</strong> {u.cozum_notu}</div>}
              {u.cozum_ts && <div style={{ marginTop: 4 }}><strong>Zaman:</strong> {String(u.cozum_ts).replace('T', ' ').slice(0, 16)}</div>}
            </div>
          )}
        </div>
      </div>
    );
  };

  const haftaRows = haftaSatirlari.length
    ? haftaSatirlari
    : Array.from({ length: 7 }, (_, i) => ({ tarih: isoTariheGunEkle(bugunStr, -i), adet: 0 }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0, lineHeight: 1.55 }}>
        Kasa uyumsuzlukları ile aynı mantık: formül → fark → <strong>Kaynağı Düzelt</strong> veya <strong>Çözüldü işaretle</strong>.
        <br />
        <strong>Devir:</strong> Dün kapanış ≠ Bugün açılış · <strong>Gün içi:</strong> Açılış + Ürün Aç − Kapanış &lt; 0 · <strong>Karşılıksız ürün aç:</strong> Depoda stok yokken açılan kalem
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
        <button type="button" className="btn btn-sm" onClick={() => kuGunGit(isoTariheGunEkle(secilenTarih, -1))}>‹</button>
        <input type="date" className="input" value={secilenTarih} style={{ fontSize: 13, padding: '5px 9px' }}
          onChange={(e) => e.target.value && kuGunGit(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={secilenTarih >= bugunStr}
          onClick={() => kuGunGit(isoTariheGunEkle(secilenTarih, 1))}>›</button>
        {secilenTarih !== bugunStr && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => kuGunGit(bugunStr)}>Bugün</button>
        )}
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>
          {aramaYukleniyor ? '⏳ yükleniyor…' : `Gösterilen: ${gorunenKayitlar.length} · Gün: ${gunToplam} (${gunBekleyen} bekleyen, ${gunCozuldu} çözüldü)`}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {devirKayitlar.length > 0 && <span className="badge" style={{ background: 'rgba(240,128,64,0.2)', color: '#fdba74' }}>💰 {devirKayitlar.length} devir</span>}
          {gunIciKayitlar.length > 0 && <span className="badge" style={{ background: 'rgba(139,92,246,0.2)', color: '#ddd6fe' }}>📉 {gunIciKayitlar.length} gün içi</span>}
          {urunAcKayitlar.length > 0 && <span className="badge" style={{ background: 'rgba(220,38,38,0.15)', color: '#fca5a5' }}>⚠ {urunAcKayitlar.length} karşılıksız aç</span>}
          {gunToplam === 0 && !aramaYukleniyor && <span style={{ color: '#4ade80', fontWeight: 600 }}>✓ Bu gün sorun yok</span>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {[
          { id: 'all', label: `Tümü (${gunToplam})` },
          { id: 'bekleyen', label: `Çözüm bekleyen (${gunBekleyen})` },
          { id: 'cozuldu', label: `Çözüldü (${gunCozuldu})` },
        ].map((f) => (
          <button key={f.id} type="button" className="btn btn-sm" onClick={() => kuDurumDegistir(f.id)}
            style={{
              padding: '4px 12px',
              fontWeight: durumFiltre === f.id ? 700 : 500,
              border: durumFiltre === f.id ? '1px solid #8b5cf6' : '1px solid var(--border)',
              background: durumFiltre === f.id ? 'rgba(139,92,246,0.2)' : 'var(--bg2)',
              color: durumFiltre === f.id ? '#ddd6fe' : 'var(--text2)',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm" onClick={() => setSeciliSubeKey('all')}
          style={{
            border: seciliSubeKey === 'all' ? '1px solid #8b5cf6' : '1px solid var(--border)',
            background: seciliSubeKey === 'all' ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg2)',
            color: seciliSubeKey === 'all' ? '#ddd6fe' : 'var(--text2)',
            fontWeight: 700,
          }}>Tümü</button>
        {subeSekmeleri.map((s) => (
          <button key={s.key} type="button" className="btn btn-sm" onClick={() => setSeciliSubeKey(s.key)}
            style={{
              border: seciliSubeKey === s.key ? '1px solid #8b5cf6' : '1px solid var(--border)',
              background: seciliSubeKey === s.key ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg2)',
              color: seciliSubeKey === s.key ? '#ddd6fe' : 'var(--text2)',
              fontWeight: 700,
            }}>
            {s.baslik} ({s.adet})
          </button>
        ))}
      </div>

      {!aramaYukleniyor && gorunenKayitlar.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: '#4ade80', fontWeight: 600, background: 'var(--bg2)', borderRadius: 10 }}>
          ✓ Seçilen tarih / filtrede ürün uyumsuzluğu yok
        </div>
      )}

      {devirKayitlar.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#fdba74', marginBottom: 8, textTransform: 'uppercase' }}>💰 Devir uyumsuzluğu</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {devirKayitlar.map((u) => {
              const d = u.detay_json || {};
              const r = sevRenk(Math.abs(Number(u.fark_tl || 0)));
              return (
                <StokKart key={u.id} u={u} tipLabel="💰" varsayilanSebep="devir_yanlis"
                  formulaText="Dün kapanış stoğu = Bugün açılış stoğu (beklenen)">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderBottom: `1px solid ${r.sep}` }}>
                    <Kutu label="Dün kapanış" val={d.dun_kapanis ?? u.beklenen_tl} renk="#c4b5fd" sep />
                    <Kutu label="Bugün açılış" val={d.bugun_acilis ?? u.gercek_tl} renk="#93c5fd" sep />
                    <Kutu label="Δ devir" val={Number(u.fark_tl || 0)} renk="#fdba74" />
                  </div>
                </StokKart>
              );
            })}
          </div>
        </div>
      )}

      {gunIciKayitlar.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#ddd6fe', marginBottom: 8, textTransform: 'uppercase' }}>📉 Gün içi stok tutmuyor</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {gunIciKayitlar.map((u) => {
              const d = u.detay_json || {};
              const r = sevRenk(Math.abs(Number(u.fark_tl || 0)));
              return (
                <StokKart key={u.id} u={u} tipLabel="📉" varsayilanSebep="kapanis_yanlis"
                  formulaText="Açılış + Ürün Aç − Kapanış = 0 (beklenen)">
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderBottom: `1px solid ${r.sep}` }}>
                    <Kutu label="Açılış" val={d.acilis} renk="#86efac" sep />
                    <Kutu label="Ürün Aç" val={d.urun_ac} renk="#86efac" sep />
                    <Kutu label="Kapanış" val={d.kapanis} renk="#fca5a5" />
                  </div>
                </StokKart>
              );
            })}
          </div>
        </div>
      )}

      {urunAcKayitlar.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#fca5a5', marginBottom: 8, textTransform: 'uppercase' }}>⚠ Karşılıksız ürün aç</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {urunAcKayitlar.map((u) => {
              const eksik = Number((u.detay_json || {}).eksik_miktar || Math.abs(u.fark_tl || 0) || 0);
              return (
                <StokKart key={u.id} u={u} tipLabel="⚠" varsayilanSebep="depo_girisi"
                  formulaText="Depo stoğu yetersizken ürün açıldı — «Depo girişi» ile stoğu tamamlayın">
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', padding: '8px 14px', gap: 8, fontSize: 12 }}>
                    <div>
                      <span style={{ color: 'var(--text3)' }}>Borç (eksik)</span>
                      <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'monospace', color: '#fca5a5' }}>{eksik} ad</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text3)' }}>Kalem</span>
                      <div style={{ fontWeight: 700 }}>{u.kalem_adi || u.kalem_kodu}</div>
                    </div>
                  </div>
                </StokKart>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 4, padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Son 7 gün {haftaYukleniyor && '…'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {haftaRows.slice(0, 7).reverse().map((s) => (
            <button key={s.tarih} type="button" className="btn btn-sm" onClick={() => kuGunGit(s.tarih)}
              style={{
                padding: '8px 4px', fontSize: 11, flexDirection: 'column',
                border: s.tarih === secilenTarih ? '1px solid #8b5cf6' : '1px solid var(--border)',
                background: s.adet > 0 ? 'rgba(139,92,246,0.12)' : 'var(--bg2)',
              }}>
              <span>{s.tarih?.slice(5)}</span>
              <strong style={{ color: s.adet > 0 ? '#ddd6fe' : 'var(--text3)' }}>{s.adet}</strong>
            </button>
          ))}
        </div>
      </div>

      {duzeltModal && (
        <div onClick={(e) => { if (e.target === e.currentTarget && !duzeltBusy) setDuzeltModal(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div className="card" style={{ width: 480, maxWidth: '95vw', padding: 24 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 17 }}>🔧 Stok — Kaynak Düzeltme</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
              {duzeltModal.uyari?.sube_adi} · {duzeltModal.uyari?.kalem_adi} · Fark: {Number(duzeltModal.uyari?.fark_tl || 0)} ad
            </p>
            <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Sebep</label>
            <select className="input" style={{ width: '100%', marginBottom: 14 }} value={duzeltModal.sebep}
              disabled={duzeltBusy}
              onChange={(e) => setDuzeltModal((p) => ({ ...p, sebep: e.target.value, payload: {} }))}>
              {duzeltModal.uyari?.tip === 'URUN_AC_UYUMSUZLUK' ? (
                <>
                  <option value="depo_girisi">📦 Depo girişi (stok ekle + borç kapat)</option>
                  <option value="gercek_uyumsuzluk">⚠ Gerçek açık — depo girişi yapılmaz</option>
                </>
              ) : duzeltModal.uyari?.tip === 'STOK_BAR_DEVIR_FARK' ? (
                <>
                  <option value="devir_yanlis">🌙 Dün kapanış sayımı yanlış</option>
                  <option value="acilis_yanlis">🌅 Bugün açılış sayımı yanlış</option>
                  <option value="gercek_uyumsuzluk">⚠ Gerçek uyumsuzluk — kaynak değişmez</option>
                </>
              ) : (
                <>
                  <option value="kapanis_yanlis">🌆 Bugün kapanış sayımı yanlış</option>
                  <option value="acilis_yanlis">🌅 Bugün açılış sayımı yanlış</option>
                  <option value="gercek_uyumsuzluk">⚠ Gerçek uyumsuzluk — kaynak değişmez</option>
                </>
              )}
            </select>
            {duzeltModal.sebep === 'acilis_yanlis' && (
              <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                Yeni açılış adedi
                <input type="number" className="input" style={{ width: '100%', marginTop: 4 }}
                  value={duzeltModal.payload.yeni_acilis_adet ?? ''}
                  onChange={(e) => setDuzeltModal((p) => ({ ...p, payload: { yeni_acilis_adet: Number(e.target.value) } }))} />
              </label>
            )}
            {duzeltModal.sebep === 'kapanis_yanlis' && (
              <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                Yeni kapanış adedi
                <input type="number" className="input" style={{ width: '100%', marginTop: 4 }}
                  value={duzeltModal.payload.yeni_kapanis_adet ?? ''}
                  onChange={(e) => setDuzeltModal((p) => ({ ...p, payload: { yeni_kapanis_adet: Number(e.target.value) } }))} />
              </label>
            )}
            {duzeltModal.sebep === 'devir_yanlis' && (
              <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                Yeni dün kapanış adedi
                <input type="number" className="input" style={{ width: '100%', marginTop: 4 }}
                  value={duzeltModal.payload.yeni_dun_kapanis_adet ?? ''}
                  onChange={(e) => setDuzeltModal((p) => ({ ...p, payload: { yeni_dun_kapanis_adet: Number(e.target.value) } }))} />
              </label>
            )}
            {duzeltModal.sebep === 'depo_girisi' && (
              <>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                  Depoya giren adet (borç kadar önerilir)
                  <input type="number" min={1} className="input" style={{ width: '100%', marginTop: 4 }}
                    value={duzeltModal.payload.giris_adet ?? ''}
                    onChange={(e) => setDuzeltModal((p) => ({
                      ...p,
                      payload: { ...p.payload, giris_adet: Number(e.target.value) },
                    }))} />
                </label>
                <p style={{ fontSize: 11, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.45 }}>
                  Şube deposuna stok eklenir, operasyon defterine <strong>URUN_STOK_EKLE</strong> yazılır,
                  karşılıksız açma borcu mahsup edilir. Aynı gün aynı kalemde başka borç varsa giriş miktarını artırın.
                </p>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" disabled={duzeltBusy} onClick={() => setDuzeltModal(null)}>İptal</button>
              <button type="button" className="btn btn-primary" disabled={duzeltBusy} onClick={duzeltGonder}>
                {duzeltBusy ? '…' : 'Uygula ve yeniden hesapla'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
