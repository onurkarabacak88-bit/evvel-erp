import { useState, useEffect, useRef } from 'react';
import { api, fmt } from '../utils/api';
import { trT } from './CariEkstrePanel';

// ── 🏷️ FİYAT PANOSU (2026-07-19, sahip: 'izleme alanını ikiye böl — fiyat
// artışlarını Fiyat Girişi alanına kur, şimdikinden daha profesyonel; fiyat
// girişinde olup artışlarda olmayanları da kurgula' + Codex reçetesi).
// Codex katmanı: TAHTA birincil (izleme), GİRİŞ bağlamsal (sağ panelden /
// global Yeni Fiyat), TAM TABLO ikincil (Maliyet sayfasında katlanır kaldı).
// Zam alarmları AYRI liste olarak yaşamaz → 'Alarm Verenler' filtresi + rozet;
// fiyatsız uzun liste → sol rail'de kısa FİYATSIZLAR bölümü + kesikli kutucuk.
// Kaynak şeffaflığı: her fiyat blokunda 🧾 Fatura / ✍️ Elle / 🔧 Düzeltme rozeti.
const DONEMLER = [['7', 'Son 7 gün'], ['30', 'Son 30 gün'], ['90', 'Son 90 gün'], ['tumu', 'Tümü']];

const kaynakRozet = (notlar) => {
  const n = (notlar || '').toLowerCase();
  if (n.includes('düzeltme') || n.includes('duzeltme')) return ['🔧', 'Düzeltme'];
  if (n.includes('fatura onaylandı') || n.includes("pdf'ten") || n.includes('pdften') || n.includes('foto fatura')) return ['🧾', 'Fatura'];
  return ['✍️', 'Elle'];
};

export default function FiyatPanosu() {
  const [d, setD] = useState(null);
  const [hata, setHata] = useState('');
  const [donem, setDonem] = useState('tumu');
  const [sadeceAlarm, setSadeceAlarm] = useState(false);
  const [kat, setKat] = useState(null);
  const [ara, setAra] = useState('');
  const [secili, setSecili] = useState(null);
  const yenile = () => api('/ops/maliyet/fiyat-izleme').then(setD).catch(e => setHata(e?.message || 'yüklenemedi'));
  useEffect(() => { yenile(); }, []);

  // ── bağlamsal fiyat girişi (sağ panel) + global Yeni Fiyat modalı ──
  const [form, setForm] = useState(null);     // {kalem_kodu(locked), yeni, tarih, tedarikci, not}
  const [modal, setModal] = useState(false);  // global giriş (ürün seçilebilir)
  const [mesgul, setMesgul] = useState(false);
  // 📣 Kayıt geri bildirimi — alert() yerine görünür, kendiliğinden sönen toast
  // (Stripe deseni: kullanıcı NE değiştiğini kayıttan sonra da görür)
  const [toast, setToast] = useState(null);   // {t:'ok'|'err', m}
  const toastZaman = useRef(null);
  const bildir = (t, m) => {
    setToast({ t, m });
    clearTimeout(toastZaman.current);
    toastZaman.current = setTimeout(() => setToast(null), 4500);
  };
  useEffect(() => () => clearTimeout(toastZaman.current), []);
  const bugun = new Date().toISOString().slice(0, 10);
  const formAc = (k) => setForm({ kalem_kodu: k.kalem_kodu, kalem_adi: k.kalem_adi, birim: k.birim || 'adet',
                                  guncel: k.guncel_fiyat, yeni: '', tarih: bugun, tedarikci: k.tedarikci || '', not: '' });
  async function fiyatKaydet(f, kapat) {
    const yeni = Number(String(f.yeni).replace(',', '.'));
    if (!f.kalem_kodu || !yeni || yeni <= 0) { bildir('err', '⚠ Ürün ve geçerli bir fiyat gerekli'); return; }
    setMesgul(true);
    try {
      await api('/ops/maliyet/alis-fiyat-kaydet', { method: 'POST', body: {
        kalem_kodu: f.kalem_kodu, kalem_adi: f.kalem_adi, birim: f.birim || 'adet',
        birim_maliyet_tl: yeni, gecerli_baslangic: f.tarih || bugun,
        tedarikci: (f.tedarikci || '').trim() || null,
        notlar: `✍️ Elle giriş${f.not ? ' — ' + f.not.trim() : ''}`,
      }});
      kapat(); yenile();
      bildir('ok', `✅ ${f.kalem_adi || f.kalem_kodu}: ${f.guncel != null ? `${fmt(f.guncel)} → ` : ''}${fmt(yeni)} kaydedildi`);
    } catch (e) { bildir('err', `❌ Kaydedilemedi — ${e?.message || 'bilinmeyen hata'}`); }
    finally { setMesgul(false); }
  }

  if (hata) return (
    <div className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠️ Fiyat panosu yüklenemedi — {hata}</span>
      <button className="btn btn-secondary btn-sm" onClick={() => { setHata(''); yenile(); }}>🔄 Tekrar dene</button>
    </div>
  );
  if (!d) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>🏷️ Fiyat panosu yükleniyor…</div>;

  const esik = d.zam_esik_yuzde || 10;
  const M = 'var(--font-mono)';
  const kesit = donem === 'tumu' ? '' : new Date(Date.now() - Number(donem) * 86400000).toISOString().slice(0, 10);
  const tumu = d.kalemler || [];
  let donemli = donem === 'tumu' ? tumu : tumu.filter(k => k.son_degisim && k.son_degisim >= kesit);
  if (sadeceAlarm) donemli = donemli.filter(k => (k.degisim_pct || 0) >= esik && !k.sicrama);
  const aranan = ara.trim().toLowerCase();
  const seciliK = tumu.find(k => k.kalem_kodu === secili) || null;
  const fiyatsizlar = tumu.filter(k => k.fiyat_yok);

  const katMap = new Map();
  for (const k of donemli) {
    const a = k.kategori || 'Diğer';
    if (!katMap.has(a)) katMap.set(a, { ad: a, emoji: k.kategori_emoji || '📦', sira: k.kategori_sira ?? 999, urunler: [] });
    katMap.get(a).urunler.push(k);
  }
  const katListe = [...katMap.values()].sort((a, b) => (a.sira - b.sira) || a.ad.localeCompare(b.ad, 'tr'));
  // İstisnalar-önce (Stripe deseni): eşik üstü zam alanlar kategori gezmeden görünür.
  // Tek kaynak = kalemler listesi (sol raydaki son_yukselenler backend'den ayrı gelir
  // ve boş kalabilir; kategori rozetleriyle çelişmesin diye buradan türetilir).
  const zamlilar = donemli.filter(k => (k.degisim_pct || 0) >= esik && !k.sicrama)
    .sort((a, b) => (b.degisim_pct || 0) - (a.degisim_pct || 0));
  const urunSirala = (arr) => arr.slice().sort((a, b) => {
    const aa = (a.degisim_pct || 0) >= esik ? 1 : 0, bb = (b.degisim_pct || 0) >= esik ? 1 : 0;
    if (aa !== bb) return bb - aa;
    const at = a.son_degisim || '', bt = b.son_degisim || '';
    if (at !== bt) return bt.localeCompare(at);
    if (!!a.fiyat_yok !== !!b.fiyat_yok) return a.fiyat_yok ? 1 : -1;
    return (a.kalem_adi || '').localeCompare(b.kalem_adi || '', 'tr');
  });
  const aramaSonuc = aranan ? urunSirala(donemli.filter(k => (k.kalem_adi || '').toLowerCase().includes(aranan))) : null;
  const seciliKat = kat ? katMap.get(kat) : null;

  const rozet = (k) => {
    if (k.fiyat_yok) return <span title="Hiç fiyat kaydı yok — maliyette 0 sayılıyor!"
      style={{ fontSize: 10.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>fiyat yok ⚠</span>;
    const pct = k.degisim_pct;
    if (pct == null) return <span style={{ fontSize: 11, color: 'var(--text3)' }}>=</span>;
    if (k.sicrama) return <span title="Birim/veri değişimi olabilir — gerçek zam sayılmaz"
      style={{ fontSize: 11.5, fontWeight: 800, color: '#f59e0b', whiteSpace: 'nowrap' }}>⚠ sıçrama</span>;
    return <span className={`kv-pill ${pct > 0 ? 'r' : 'g'}`}
                 style={{ fontSize: 11.5, fontWeight: 800, whiteSpace: 'nowrap', padding: '2px 9px', borderRadius: 9,
                          color: pct > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
      {pct > 0 ? '↑' : '↓'} %{Math.abs(pct).toFixed(1)}
    </span>;
  };

  const chip = (aktif, onClick, icerik) => (
    <button onClick={onClick} className={aktif ? 'kv-chip-on' : ''}
      style={{ height: 26, padding: '0 11px', borderRadius: 13, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
               border: `1px solid ${aktif ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
               background: aktif ? 'var(--accent, #c9853f)' : 'transparent',
               color: aktif ? '#1a120b' : 'var(--text3)' }}>{icerik}</button>
  );

  const girisAlan = { width: '100%', height: 30, padding: '0 10px', borderRadius: 8, fontSize: 12.5,
                      background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)' };

  const girisFormu = (f, setF, kapat, urunKilitli) => {
    const yeniN = Number(String(f.yeni || '').replace(',', '.'));
    const pct = f.guncel > 0 && yeniN > 0 ? ((yeniN - f.guncel) / f.guncel) * 100 : null;
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {!urunKilitli && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Ürün</div>
            <input list="fp-urunler" style={girisAlan} placeholder="ürün adı yaz/seç…"
              value={f.kalem_adi || ''} onChange={e => {
                const ad = e.target.value;
                const u = tumu.find(x => (x.kalem_adi || '') === ad);
                setF({ ...f, kalem_adi: ad, kalem_kodu: u?.kalem_kodu || '', birim: u?.birim || 'adet', guncel: u?.guncel_fiyat, tedarikci: f.tedarikci || u?.tedarikci || '' });
              }} />
            <datalist id="fp-urunler">
              {tumu.map(u => <option key={u.kalem_kodu} value={u.kalem_adi} />)}
            </datalist>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
              Yeni fiyat {f.guncel != null && <span>· güncel <b style={{ fontFamily: M }}>{fmt(f.guncel)}</b></span>}
            </div>
            <input style={girisAlan} placeholder="0,00" value={f.yeni}
              onChange={e => setF({ ...f, yeni: e.target.value })} />
          </div>
          <div style={{ width: 130 }}>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Geçerli olsun</div>
            <input type="date" style={girisAlan} value={f.tarih} onChange={e => setF({ ...f, tarih: e.target.value })} />
          </div>
        </div>
        {pct != null && Math.abs(pct) > 0.05 && (
          <div style={{ fontSize: 11.5, fontWeight: 700,
                        color: pct > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
            değişim: {pct > 0 ? '+' : ''}%{pct.toFixed(1)} ({pct > 0 ? '+' : ''}{fmt(yeniN - f.guncel)})
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...girisAlan, flex: 1 }} placeholder="Tedarikçi (opsiyonel)"
            value={f.tedarikci} onChange={e => setF({ ...f, tedarikci: e.target.value })} />
          <input style={{ ...girisAlan, flex: 1 }} placeholder="Not (opsiyonel)"
            value={f.not} onChange={e => setF({ ...f, not: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={kapat}>Vazgeç</button>
          <button className="btn btn-primary btn-sm" disabled={mesgul}
            onClick={() => fiyatKaydet(f, kapat)}>{mesgul ? 'Kaydediliyor…' : '💾 Kaydet'}</button>
        </div>
      </div>
    );
  };

  const urunKutusu = (k) => {
    const seciliMi = secili === k.kalem_kodu;
    const alarm = (k.degisim_pct || 0) >= esik && !k.sicrama;
    return (
      <div key={k.kalem_kodu} onClick={() => { setSecili(k.kalem_kodu); setForm(null); }}
        style={{ minHeight: 104, padding: '11px 12px', borderRadius: 14, cursor: 'pointer',
                 background: 'var(--bg2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                 border: `1px solid ${seciliMi ? 'var(--accent, #c9853f)' : alarm ? 'var(--red, #ef4444)' : k.fiyat_yok ? 'rgba(245,158,11,.55)' : 'var(--border)'}`,
                 borderStyle: k.fiyat_yok ? 'dashed' : 'solid',
                 boxShadow: seciliMi ? '0 0 0 1px var(--accent, #c9853f)' : undefined }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, overflow: 'hidden',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {k.kalem_adi}
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 15 }}>
              {k.fiyat_yok ? '—' : fmt(k.guncel_fiyat)}
            </span>
            {rozet(k)}
          </div>
          <div style={{ fontSize: 10.5, color: k.fiyat_yok || k.sicrama ? '#f59e0b' : 'var(--text3)', marginTop: 2 }}>
            {/* Rozetin ANLAMI hover beklemeden görünür (dokunmatikte hover yok) */}
            {k.fiyat_yok ? 'fiyat girilmemiş — maliyete 0 yazılıyor'
              : k.sicrama ? 'birim/veri değişimi olabilir — gerçek zam sayılmaz'
              : k.son_degisim ? `son değişim ${trT(k.son_degisim)}` : 'değişim yok'}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {toast && (
        <div style={{ position: 'fixed', bottom: 26, left: '50%', width: 340, marginLeft: -170, zIndex: 130,
                      padding: '11px 15px', borderRadius: 12, fontSize: 12.5, fontWeight: 700, textAlign: 'center',
                      background: toast.t === 'ok' ? 'linear-gradient(135deg,#4ade80,#22c55e)' : 'linear-gradient(135deg,#fb7185,#ef4444)',
                      color: toast.t === 'ok' ? '#052e14' : '#fff',
                      boxShadow: '0 10px 28px rgba(0,0,0,.4)' }}>
          {toast.m}
        </div>
      )}
      {/* ÜST BAR — arama + filtreler + global Yeni Fiyat */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={ara} onChange={e => setAra(e.target.value)} placeholder="🔍 ürün ara…"
            style={{ width: 180, height: 30, padding: '0 12px', borderRadius: 15, fontSize: 12.5,
                     background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)' }} />
          {DONEMLER.map(([k, lbl]) => chip(donem === k, () => setDonem(k), lbl))}
          {chip(sadeceAlarm, () => setSadeceAlarm(a => !a), `🚨 Alarm Verenler (≥%${esik})`)}
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => {
          setModal(true);
          setForm({ kalem_kodu: '', kalem_adi: '', birim: 'adet', guncel: null, yeni: '', tarih: bugun, tedarikci: '', not: '' });
        }}>➕ Yeni Fiyat</button>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* SOL RAIL — Son Yükselenler + Fiyatsızlar */}
        <div className="card mk-rise" style={{ flex: '0 1 280px', minWidth: 245, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text3)', marginBottom: 6 }}>
            🔺 SON YÜKSELENLER
          </div>
          {(d.son_yukselenler || []).length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>Kayıtlı fiyat artışı yok 🎉</div>
          )}
          {(d.son_yukselenler || []).map(k => (
            <div key={k.kalem_kodu} onClick={() => { setSecili(k.kalem_kodu); setForm(null); }}
              style={{ padding: '8px 8px', borderRadius: 9, cursor: 'pointer', marginBottom: 2,
                       background: secili === k.kalem_kodu ? 'rgba(255,255,255,.05)' : 'transparent',
                       borderLeft: `3px solid ${(k.degisim_pct || 0) >= esik ? 'var(--red, #ef4444)' : '#f59e0b'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {k.kalem_adi}
                </span>
                {rozet(k)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: M }}>{fmt(k.guncel_fiyat)}</span>
                <span>{trT(k.son_degisim)}</span>
              </div>
            </div>
          ))}
          {fiyatsizlar.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 800, color: '#f59e0b', margin: '12px 0 4px' }}>
                ⚠ FİYATSIZLAR ({fiyatsizlar.length}) <span style={{ fontWeight: 400, color: 'var(--text3)' }}>maliyete 0 yazıyor</span>
              </div>
              {fiyatsizlar.slice(0, 8).map(k => (
                <div key={k.kalem_kodu} onClick={() => { setSecili(k.kalem_kodu); setForm(null); }}
                  style={{ padding: '6px 8px', borderRadius: 9, cursor: 'pointer', marginBottom: 2, fontSize: 12,
                           background: secili === k.kalem_kodu ? 'rgba(255,255,255,.05)' : 'transparent',
                           borderLeft: '3px dashed rgba(245,158,11,.6)' }}>
                  {k.kalem_adi}
                </div>
              ))}
            </>
          )}
        </div>

        {/* ORTA — kategori kartları → ürün kutucukları */}
        <div style={{ flex: '1 1 380px', minWidth: 320 }}>
          {aramaSonuc ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>🔍 "{ara}" — {aramaSonuc.length} ürün</div>
              <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                {aramaSonuc.map(urunKutusu)}
              </div>
            </>
          ) : !seciliKat ? (
            <>
              {(donem !== 'tumu' || sadeceAlarm) && (
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8 }}>
                  Filtre aktif — {sadeceAlarm ? 'yalnız eşik üstü zam alanlar' : 'yalnız bu dönemde değişenler'} gösteriliyor.
                </div>
              )}
              {zamlilar.length > 0 && !sadeceAlarm && (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--red, #ef4444)' }}>🔺 Zam Verenler</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)' }}>eşik ≥%{esik} · en yüksek artış önce — tıkla, incele</span>
                  </div>
                  <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
                    {zamlilar.slice(0, 8).map(urunKutusu)}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text3)', marginBottom: 8 }}>📂 Kategoriler</div>
                </>
              )}
              <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                {katListe.map(kt => {
                  const zamli = kt.urunler.filter(u => (u.degisim_pct || 0) > 0 && !u.sicrama).length;
                  const fyok = kt.urunler.filter(u => u.fiyat_yok).length;
                  return (
                    <div key={kt.ad} onClick={() => setKat(kt.ad)}
                      style={{ minHeight: 96, padding: '12px 12px', borderRadius: 14, cursor: 'pointer',
                               background: 'var(--bg2)', border: `1px solid ${zamli > 0 ? 'rgba(239,68,68,.5)' : 'var(--border)'}`,
                               display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 22 }}>{kt.emoji}</div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 800 }}>{kt.ad}</div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                          {kt.urunler.length} ürün
                          {zamli > 0 && <b style={{ color: 'var(--red, #ef4444)' }}> · {zamli} zam</b>}
                          {fyok > 0 && <b style={{ color: '#f59e0b' }}> · {fyok} fiyatsız</b>}
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
                <span style={{ fontWeight: 800, fontSize: 13.5 }}>{seciliKat.emoji} {seciliKat.ad}
                  <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text3)' }}> · {seciliKat.urunler.length} ürün</span>
                </span>
              </div>
              <div className="mk-stagger mk-hovlift" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                {urunSirala(seciliKat.urunler).map(urunKutusu)}
              </div>
            </>
          )}
        </div>

        {/* SAĞ — fiyat geçmişi + bağlamsal YENİ FİYAT girişi */}
        <div className="card mk-rise" style={{ flex: '0 1 380px', minWidth: 300, padding: 14 }}>
          {!seciliK && (
            <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
              👈 Bir ürüne tıkla — fiyat geçmişi burada açılır; aynı panelden yeni fiyat girebilirsin.
            </div>
          )}
          {seciliK && (() => {
            const z = seciliK.zincir || [];
            const ilk = z[0], son = z[z.length - 1];
            const toplamPct = (ilk && son && ilk.fiyat > 0 && !z.some(x => x.duzeltme || x.sicrama))
              ? ((son.fiyat - ilk.fiyat) / ilk.fiyat) * 100 : null;
            return (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{seciliK.kategori_emoji} {seciliK.kalem_adi}</div>
                  {!form && (
                    <button className="btn btn-primary btn-sm" onClick={() => formAc(seciliK)}>🏷️ Yeni Fiyat Gir</button>
                  )}
                </div>
                {seciliK.fiyat_yok ? (
                  <div style={{ fontSize: 12.5, color: '#f59e0b', margin: '8px 0', lineHeight: 1.5 }}>
                    ⚠ Bu ürünün hiç fiyat kaydı yok — her ürün-aç maliyete <b>0 ₺</b> yazıyor.
                    Sağdaki 🏷️ düğmesiyle ilk fiyatını gir; faturası onaylanınca da kendiliğinden oluşur.
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text3)', margin: '2px 0 10px' }}>
                    Güncel <b style={{ fontFamily: M, color: 'var(--text)' }}>{fmt(seciliK.guncel_fiyat)}</b>
                    {toplamPct != null && Math.abs(toplamPct) > 0.05 && (
                      <> · ilk kayıt → bugün <b style={{ color: toplamPct > 0 ? 'var(--red, #ef4444)' : 'var(--green, #22c55e)' }}>
                        {toplamPct > 0 ? '+' : ''}%{toplamPct.toFixed(1)}</b></>
                    )}
                  </div>
                )}
                {!modal && form && form.kalem_kodu === seciliK.kalem_kodu && (
                  <div style={{ margin: '10px 0', padding: '12px', borderRadius: 10,
                                border: '1px solid var(--accent, #c9853f)', background: 'rgba(255,255,255,.03)' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 8 }}>🏷️ Yeni Fiyat — {seciliK.kalem_adi}</div>
                    {girisFormu(form, setForm, () => setForm(null), true)}
                  </div>
                )}
                {z.map((b, i) => (
                  <div key={i} className="mk-stagger-s">
                    {i > 0 && (b.duzeltme ? (
                      <div style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 0 3px 14px', color: 'var(--text3)' }}>
                        🔧 birim düzeltmesi (zam değil)
                      </div>
                    ) : b.sicrama ? (
                      <div style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 0 3px 14px', color: '#f59e0b' }}>
                        ⚠ %{Math.abs(b.degisim_pct || 0).toFixed(0)} sıçrama — birim/veri değişimi olabilir
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 0 3px 14px',
                                    color: (b.degisim_pct || 0) > 0 ? 'var(--red, #ef4444)' : (b.degisim_pct || 0) < 0 ? 'var(--green, #22c55e)' : 'var(--text3)' }}>
                        {(b.degisim_pct || 0) > 0 ? '↑' : (b.degisim_pct || 0) < 0 ? '↓' : '='}{' '}
                        %{Math.abs(b.degisim_pct || 0).toFixed(1)} ({(b.fiyat - z[i - 1].fiyat) > 0 ? '+' : ''}{fmt(b.fiyat - z[i - 1].fiyat)})
                      </div>
                    ))}
                    <div style={{ padding: '9px 12px', borderRadius: 10,
                                  border: `1px solid ${i === z.length - 1 ? 'var(--accent, #c9853f)' : 'var(--border)'}`,
                                  background: i === z.length - 1 ? 'rgba(255,255,255,.04)' : 'transparent' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
                          {trT(b.bas)} — {b.bit ? trT(b.bit) : 'bugün'}
                          {i === z.length - 1 && <b style={{ color: 'var(--accent, #c9853f)' }}> · GÜNCEL</b>}
                        </span>
                        <span style={{ fontFamily: M, fontVariantNumeric: 'tabular-nums', fontWeight: 800, fontSize: 14.5 }}>
                          {fmt(b.fiyat)}
                        </span>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                        {(() => { const [em, ad2] = kaynakRozet(b.notlar); return (
                          <span style={{ padding: '1px 7px', borderRadius: 6, border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{em} {ad2}</span>
                        ); })()}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {b.tedarikci || ''}{b.tedarikci && b.notlar ? ' · ' : ''}{(b.notlar || '').slice(0, 60)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* GLOBAL YENİ FİYAT MODALI — ürün seçilebilir */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 70 }}>
          <div className="mk-perde" onClick={() => setModal(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
          <div className="mk-modal" style={{ position: 'absolute', top: '12%', left: '50%',
                        width: 'min(430px, 92vw)', marginLeft: 'calc(min(430px, 92vw) / -2)', background: 'var(--bg1, #17110c)', borderRadius: 14,
                        border: '1px solid var(--border)', padding: 18, boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>➕ Yeni Fiyat</div>
            {form && girisFormu(form, setForm, () => { setModal(false); setForm(null); }, false)}
          </div>
        </div>
      )}
    </div>
  );
}
