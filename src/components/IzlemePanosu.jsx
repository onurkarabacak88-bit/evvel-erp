import { useState, useEffect } from 'react';
import { api, fmt } from '../utils/api';
import { trT } from './CariEkstrePanel';

// ── 📈 İZLEME PANOSU (2026-07-19, sahip: "sipariş-ver örüntüsüne bak, bu
// tasarımı kullan — tıklayınca içeriğini göreyim: Haziran 1'de 15 TL idi,
// Temmuz 10'da 17 TL oldu; SOL HATTAKİ SON YÜKSELENLER KALSIN").
// Desen = şube paneli sipariş-ver akışı: önce EMOJİ'Lİ KATEGORİ KARTLARI,
// kategoriye tıkla → ürün kutucukları, ürüne tıkla → sağda fiyat zinciri.
// Sol rail (Son Yükselenler) sabit. Yeni izleme görünümü = GORUNUMLER'e kayıt.
// Fiyat Artışları görünümü FiyatPanosu.jsx'e taşındı (sahip 2026-07-19:
// 'izleme alanını ikiye böl — fiyat artışlarını Fiyat Girişi alanına kur').
// Bu pano artık DEPO İZLEME'ye adanmıştır; yeni izleme görünümü gerekirse
// buraya kayıt eklenir.
const GORUNUMLER = [
  { id: 'depo', ad: '📦 Depo & Düşüm' },
];

export default function IzlemePanosu() {
  const [gorunum, setGorunum] = useState('depo');
  const [kat, setKat] = useState(null);         // seçili kategori (null = kategori kartları)
  const [ara, setAra] = useState('');
  const [secili, setSecili] = useState(null);   // kalem_kodu
  // 🏢 şube filtresi + ⚠ kritik filtresi (OM 'Depo stokları' sekmesinden devralınan
  // özellikler — sahip 2026-07-19: 'OM depo stoklarını kaldırıp buraya harmanla')
  const [sube, setSube] = useState(null);       // null = tüm şubeler
  const [sadeceKritik, setSadeceKritik] = useState(false);
  // ✏️ stok düzeltme formu (OM onay akışının sadeleşmiş hali — sayım düzeltme)
  const [duz, setDuz] = useState(null);         // {sube_id, adet, min}
  const [mesgul, setMesgul] = useState(false);
  // 📦 depo verisi
  const [dd, setDd] = useState(null);
  const yenile = () => api('/ops/maliyet/depo-izleme').then(setDd).catch(() => setDd({ hata: true }));
  useEffect(() => { yenile(); }, []);
  // Codex kazanç #3: kritik sayacı BAĞLAM-duyarlı — şube seçiliyken o şubenin sayısı
  const kritikSayi = (() => {
    if (!dd || dd.hata) return 0;
    if (!sube) return dd.kritik_sayi || 0;
    return (dd.kalemler || []).filter(k => {
      const e = (k.sube_kirilim || []).find(x => x.sube_id === sube);
      return e && e.min_stok > 0 && e.adet <= e.min_stok;
    }).length;
  })();
  async function stokKaydet(k, f) {
    const kir = (k.sube_kirilim || []).find(x => x.sube_id === f.sube_id);
    setMesgul(true);
    try {
      await api('/ops/v2/sube-depo/guncelle', { method: 'POST', body: {
        sube_id: f.sube_id, kalem_kodu: k.kalem_kodu, kalem_adi: k.kalem_adi,
        mevcut_adet: Math.max(0, Math.round(Number(String(f.adet).replace(',', '.')) || 0)),
        min_stok: Math.max(0, Math.round(Number(String(f.min).replace(',', '.')) || 0)),
        alis_fiyati_tl: kir?.alis_fiyati || 0,   // mevcut depo fiyatı korunur (0'a ezilmesin)
        giris_nedeni: 'sayim_duzeltme',
      }});
      setDuz(null); yenile();
    } catch (e) { alert(e?.message || 'kaydedilemedi'); }
    finally { setMesgul(false); }
  }

  const M = 'var(--font-mono)';

  const chip = (aktif, onClick, icerik, kucuk) => (
    <button onClick={onClick} className={aktif ? 'kv-chip-on' : ''}
      style={{ height: kucuk ? 26 : 30, padding: kucuk ? '0 11px' : '0 14px', borderRadius: 15,
               fontSize: kucuk ? 11.5 : 12.5, fontWeight: 700, cursor: 'pointer',
               border: `1px solid ${aktif ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
               background: aktif ? 'var(--accent, #c9853f)' : 'transparent',
               color: aktif ? '#1a120b' : 'var(--text3)' }}>{icerik}</button>
  );


  return (
    <div>
      {/* KABUK BAŞLIĞI — görünüm pilleri + dönem + arama */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>📦 Depo İzleme</span>
          {GORUNUMLER.map(g => chip(gorunum === g.id, () => setGorunum(g.id), g.ad))}
          {dd && !dd.hata && chip(!sube, () => setSube(null), '🏢 Tümü', true)}
          {dd && !dd.hata && (dd.subeler || []).filter(x => x.id !== 'sube-merkez').map(x =>
            chip(sube === x.id, () => setSube(sube === x.id ? null : x.id), x.ad, true))}
          {dd && !dd.hata && kritikSayi > 0 && (
            <button onClick={() => setSadeceKritik(a => !a)}
              style={{ height: 26, padding: '0 11px', borderRadius: 13, fontSize: 11.5, fontWeight: 800, cursor: 'pointer',
                       border: '1px solid var(--red, #ef4444)',
                       background: sadeceKritik ? 'var(--red, #ef4444)' : 'transparent',
                       color: sadeceKritik ? '#fff' : 'var(--red, #ef4444)' }}>⚠ Kritik ({kritikSayi}{sube ? '' : ' · tüm'})</button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={ara} onChange={e => setAra(e.target.value)} placeholder="🔍 ürün ara…"
            style={{ width: 160, height: 28, padding: '0 10px', borderRadius: 14, fontSize: 12,
                     background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)' }} />
        </div>
      </div>

      {/* ═══ 📦 DEPO & DÜŞÜM — aynı kabuk, açıklayıcı başlıklar ═══ */}
      {gorunum === 'depo' && (!dd ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>📦 Depo verisi yükleniyor…</div>
      ) : dd.hata ? (
        <div className="card" style={{ padding: 14, color: 'var(--red)' }}>Depo verisi alınamadı.</div>
      ) : (() => {
        // şube seçiliyse değerler o şubenin kırılımından okunur (OM davranışı)
        const gz = (k) => {
          if (!sube) return { kalan: k.kalan_toplam, kritik: k.kritik, varMi: true };
          const e = (k.sube_kirilim || []).find(x => x.sube_id === sube);
          return e ? { kalan: e.adet, kritik: e.min_stok > 0 && e.adet <= e.min_stok, varMi: true }
                   : { kalan: 0, kritik: false, varMi: false };
        };
        let dtumu = (dd.kalemler || []).filter(k => gz(k).varMi);
        if (sadeceKritik) dtumu = dtumu.filter(k => gz(k).kritik);
        const dara = ara.trim().toLowerCase();
        const dKat = new Map();
        for (const k of dtumu) {
          const a = k.kategori || 'Diğer';
          if (!dKat.has(a)) dKat.set(a, { ad: a, emoji: k.kategori_emoji || '📦', sira: k.kategori_sira ?? 999, urunler: [] });
          dKat.get(a).urunler.push(k);
        }
        const dKatListe = [...dKat.values()].sort((a, b) => (a.sira - b.sira) || a.ad.localeCompare(b.ad, 'tr'));
        const dSirala = (arr) => arr.slice().sort((a, b) => (b.dusum_7g || 0) - (a.dusum_7g || 0)
          || (b.kalan_toplam || 0) - (a.kalan_toplam || 0));
        const dAramaSonuc = dara ? dSirala(dtumu.filter(k => (k.kalem_adi || '').toLowerCase().includes(dara))) : null;
        const dSeciliKat = kat ? dKat.get(kat) : null;
        const dSecili = dtumu.find(k => k.kalem_kodu === secili) || null;
        const depoKutu = (k) => { const g2 = gz(k); return (
          <div key={k.kalem_kodu} onClick={() => { setSecili(k.kalem_kodu); setDuz(null); }}
            style={{ minHeight: 104, padding: '11px 12px', borderRadius: 14, cursor: 'pointer',
                     background: 'var(--bg2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                     border: `1px solid ${secili === k.kalem_kodu ? 'var(--accent, #c9853f)' : g2.kritik ? 'var(--red, #ef4444)' : 'var(--border)'}`,
                     boxShadow: secili === k.kalem_kodu ? '0 0 0 1px var(--accent, #c9853f)' : undefined }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden',
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {k.kalem_adi}
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 16 }}>
                  {Math.round(g2.kalan)}
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text3)' }}> kalan{sube ? '' : ' (tüm)'}</span>
                </span>
                {(k.dusum_7g || 0) > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>7g −{Math.round(k.dusum_7g)}</span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: g2.kritik ? 'var(--red, #ef4444)' : 'var(--text3)', marginTop: 2 }}>
                {g2.kritik ? '⚠ kritik stok (min altı)' : `30 günde −${Math.round(k.dusum_30g || 0)}`}
              </div>
            </div>
          </div>
        ); };
        return (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* SOL RAIL — en çok tüketilenler */}
            <div className="card mk-rise" style={{ flex: '0 1 280px', minWidth: 245, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text3)', marginBottom: 2 }}>
                🔻 SON 7 GÜNDE EN ÇOK DÜŞENLER
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 6 }}>
                ürün-aç / fire / reçete çıkışları toplamı
              </div>
              {(dd.en_cok_dusen || []).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Son 7 günde çıkış kaydı yok.</div>
              )}
              {(dd.en_cok_dusen || []).map(k => (
                <div key={k.kalem_kodu} onClick={() => setSecili(k.kalem_kodu)}
                  style={{ padding: '8px 8px', borderRadius: 9, cursor: 'pointer', marginBottom: 2,
                           background: secili === k.kalem_kodu ? 'rgba(255,255,255,.05)' : 'transparent',
                           borderLeft: `3px solid ${k.kritik ? 'var(--red, #ef4444)' : '#f59e0b'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {k.kalem_adi}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>−{Math.round(k.dusum_7g)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>depoda {Math.round(k.kalan_toplam)}</span>
                    <span>{k.kategori}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* ORTA — kategori kartları → ürün kutucukları (kalan + düşüm) */}
            <div style={{ flex: '1 1 380px', minWidth: 320 }}>
              {dAramaSonuc ? (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>🔍 "{ara}" — {dAramaSonuc.length} ürün</div>
                  <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                    {dAramaSonuc.map(depoKutu)}
                  </div>
                </>
              ) : !dSeciliKat ? (
                <>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8 }}>
                    Kategoriye tıkla → depodaki ürünler; ürüne tıkla → sağda gün gün düşüm izi.
                  </div>
                  <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                    {dKatListe.map(kt => {
                      const kritik = kt.urunler.filter(u => gz(u).kritik).length;
                      const dusum = Math.round(kt.urunler.reduce((a, u) => a + (u.dusum_7g || 0), 0));
                      return (
                        <div key={kt.ad} onClick={() => setKat(kt.ad)}
                          style={{ minHeight: 96, padding: '12px 12px', borderRadius: 14, cursor: 'pointer',
                                   background: 'var(--bg2)', border: `1px solid ${kritik > 0 ? 'rgba(239,68,68,.5)' : 'var(--border)'}`,
                                   display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                          <div style={{ fontSize: 22 }}>{kt.emoji}</div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 800 }}>{kt.ad}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                              {kt.urunler.length} ürün
                              {dusum > 0 && <b style={{ color: '#f59e0b' }}> · 7g −{dusum}</b>}
                              {kritik > 0 && <b style={{ color: 'var(--red, #ef4444)' }}> · {kritik} kritik</b>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <button onClick={() => setKat(null)} className="btn btn-secondary btn-sm">← Kategoriler</button>
                    <span style={{ fontWeight: 800, fontSize: 13.5 }}>{dSeciliKat.emoji} {dSeciliKat.ad}
                      <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text3)' }}> · {dSeciliKat.urunler.length} ürün</span>
                    </span>
                  </div>
                  <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                    {dSirala(dSeciliKat.urunler).map(depoKutu)}
                  </div>
                </>
              )}
            </div>

            {/* SAĞ — GÜN GÜN DÜŞÜM İZİ (önceki → sonraki) */}
            <div className="card mk-rise" style={{ flex: '0 1 400px', minWidth: 300, padding: 14 }}>
              {!dSecili && (
                <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
                  👈 Bir ürüne tıkla — depodaki kalan + gün gün düşüm izi burada açılır
                  (örn. "18.07 · Zafer · 13 → 12").
                </div>
              )}
              {dSecili && (
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 2 }}>
                    {dSecili.kategori_emoji} {dSecili.kalem_adi}
                  </div>
                  {(() => {
                    // Codex hizalama: şube seçiliyken özet de o şubenin (kalan kırılımdan,
                    // düşüm o şubenin hareket izinden hesaplanır)
                    const hepsi = dSecili.hareketler || [];
                    const hf = sube ? hepsi.filter(h => h.sube_id === sube) : hepsi;
                    const gun = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
                    const dus = (kes) => Math.round(hf.filter(h => h.t >= kes &&
                      ((h.miktar || 0) < 0 || ((h.onceki ?? 0) > (h.sonraki ?? 0))))
                      .reduce((a, h) => a + Math.abs(h.miktar || ((h.onceki || 0) - (h.sonraki || 0))), 0));
                    const kalanG = sube
                      ? Math.round(((dSecili.sube_kirilim || []).find(x => x.sube_id === sube) || {}).adet || 0)
                      : Math.round(dSecili.kalan_toplam);
                    const subeAd = sube ? ((dd.subeler || []).find(x => x.id === sube)?.ad || '') : '';
                    return (
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
                        📦 {sube ? `${subeAd}'de kalan` : 'Depoda kalan (tüm şubeler)'}{' '}
                        <b style={{ fontFamily: M, color: 'var(--text)', fontSize: 14 }}>{kalanG}</b>
                        {' '}· son 7 gün <b style={{ color: '#f59e0b' }}>−{sube ? dus(gun(7)) : Math.round(dSecili.dusum_7g || 0)}</b>
                        {' '}· son 30 gün <b style={{ color: '#f59e0b' }}>−{sube ? dus(gun(30)) : Math.round(dSecili.dusum_30g || 0)}</b>
                      </div>
                    );
                  })()}
                  {(dSecili.sube_kirilim || []).length > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {dSecili.sube_kirilim.map((sk2, j) => (
                        <span key={j} onClick={() => setDuz({ sube_id: sk2.sube_id, adet: String(Math.round(sk2.adet)), min: String(Math.round(sk2.min_stok || 0)) })}
                          title="Tıkla → bu şubenin stoğunu düzelt"
                          style={{ padding: '2px 9px', borderRadius: 8, cursor: 'pointer',
                                   border: `1px solid ${(sk2.min_stok > 0 && sk2.adet <= sk2.min_stok) ? 'var(--red, #ef4444)' : 'var(--border)'}` }}>
                          {sk2.sube}: <b style={{ fontFamily: M }}>{Math.round(sk2.adet)}</b>
                          {sk2.min_stok > 0 && <span style={{ opacity: .7 }}> /min {Math.round(sk2.min_stok)}</span>} ✏️
                        </span>
                      ))}
                    </div>
                  )}
                  {!duz && (
                    <button className="btn btn-secondary btn-sm" style={{ marginBottom: 8 }}
                      onClick={() => {
                        const ilk = (dSecili.sube_kirilim || [])[0];
                        setDuz({ sube_id: sube || ilk?.sube_id || (dd.subeler || [])[0]?.id || '',
                                 adet: ilk ? String(Math.round(ilk.adet)) : '0',
                                 min: ilk ? String(Math.round(ilk.min_stok || 0)) : '0' });
                      }}>✏️ Stok Düzelt (sayım)</button>
                  )}
                  {duz && (
                    <div style={{ margin: '4px 0 10px', padding: 12, borderRadius: 10,
                                  border: '1px solid var(--accent, #c9853f)', background: 'rgba(255,255,255,.03)' }}>
                      <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>✏️ Sayım Düzeltme — {dSecili.kalem_adi}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <select value={duz.sube_id}
                          onChange={e => {
                            const sid = e.target.value;
                            const kk = (dSecili.sube_kirilim || []).find(x => x.sube_id === sid);
                            setDuz({ sube_id: sid, adet: kk ? String(Math.round(kk.adet)) : '0', min: kk ? String(Math.round(kk.min_stok || 0)) : '0' });
                          }}
                          style={{ height: 30, borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', padding: '0 8px', fontSize: 12.5 }}>
                          {(dd.subeler || []).filter(x => x.id !== 'sube-merkez').map(x => (
                            <option key={x.id} value={x.id}>{x.ad}</option>
                          ))}
                        </select>
                        <label style={{ fontSize: 11.5, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          adet <input value={duz.adet} onChange={e => setDuz({ ...duz, adet: e.target.value })}
                            style={{ width: 70, height: 30, borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', padding: '0 8px', fontSize: 12.5 }} />
                        </label>
                        <label style={{ fontSize: 11.5, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          min <input value={duz.min} onChange={e => setDuz({ ...duz, min: e.target.value })}
                            style={{ width: 60, height: 30, borderRadius: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', padding: '0 8px', fontSize: 12.5 }} />
                        </label>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', margin: '6px 0 8px', lineHeight: 1.45 }}>
                        ⚡ Bu alan <b>hızlı düzeltmedir</b> (tek ürün, tek şube) — resmi sayım değildir;
                        kalibrasyon/kontrol için <b>Stok Sayım</b> modülünü kullan. Hareket defterine
                        "sayım düzeltme" izi düşer (önceki → sonraki) — alış fiyatına dokunulmaz.
                      </div>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setDuz(null)}>Vazgeç</button>
                        <button className="btn btn-primary btn-sm" disabled={mesgul}
                          onClick={() => {
                            const sAd = (dd.subeler || []).find(x => x.id === duz.sube_id)?.ad || duz.sube_id;
                            if (!window.confirm(`Bu RESMİ SAYIM DEĞİL, anlık düzeltmedir.\n${sAd} · ${dSecili.kalem_adi} → ${duz.adet} adet (min ${duz.min}) yazılacak.\nOnaylıyor musun?`)) return;
                            stokKaydet(dSecili, duz);
                          }}>{mesgul ? 'Kaydediliyor…' : '💾 Kaydet'}</button>
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--text3)', marginBottom: 4 }}>
                    📉 GÜN GÜN HAREKET <span style={{ fontWeight: 400 }}>(önceki → sonraki)</span>
                  </div>
                  {(dSecili.hareketler || []).filter(h => !sube || h.sube_id === sube).length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu {sube ? 'şubede ' : ''}son 45 günde hareket kaydı yok.</div>
                  )}
                  {(dSecili.hareketler || []).filter(h => !sube || h.sube_id === sube).map((h, j) => {
                    const dusum2 = (h.miktar || 0) < 0 || ((h.onceki ?? 0) > (h.sonraki ?? 0));
                    return (
                      <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {trT(h.t)} {h.saat} · {h.sube}
                          <span style={{ color: 'var(--text3)' }}> · {(h.tur || '').toLowerCase().replace(/_/g, ' ')}</span>
                        </span>
                        <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontWeight: 700,
                                       color: dusum2 ? '#f59e0b' : 'var(--green, #22c55e)' }}>
                          {h.onceki != null && h.sonraki != null
                            ? `${Math.round(h.onceki)} → ${Math.round(h.sonraki)}`
                            : `${(h.miktar || 0) > 0 ? '+' : ''}${Math.round(h.miktar || 0)}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })())}
    </div>
  );
}
