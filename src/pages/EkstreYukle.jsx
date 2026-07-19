import { useState, useEffect } from 'react';
import { fmt } from '../utils/api';

export default function EkstreYukle() {
  const [yukleniyor, setYukleniyor] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [hata, setHata] = useState(null);
  const [dosyaAdi, setDosyaAdi] = useState('');
  const [secili, setSecili] = useState(() => new Set());
  const [impBusy, setImpBusy] = useState(false);
  const [impSonuc, setImpSonuc] = useState(null);
  const [devirBusy, setDevirBusy] = useState(false);
  const [lastFile, setLastFile] = useState(null);
  const [kartEkleBusy, setKartEkleBusy] = useState(false);
  // ── Manuel ekstre girişi (PDF okunamayan kartlar: Axess gibi)
  const [manOpen, setManOpen] = useState(false);
  const [kartlar, setKartlar] = useState([]);
  const [mForm, setMForm] = useState({ kart_id: '', donem: '', son_odeme: '', donem_borcu: '', asgari_tutar: '', faiz_orani: '' });
  const [mBusy, setMBusy] = useState(false);
  const [mSonuc, setMSonuc] = useState(null);
  const [mHata, setMHata] = useState(null);

  useEffect(() => {
    fetch('/api/kartlar').then(r => r.json()).then(d => setKartlar(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  async function manuelKaydet() {
    if (!mForm.kart_id || !mForm.donem || !mForm.donem_borcu) {
      setMHata('Kart, kesim tarihi ve dönem borcu zorunlu.'); return;
    }
    setMBusy(true); setMHata(null); setMSonuc(null);
    try {
      const r = await fetch(`/api/kartlar/${mForm.kart_id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: mForm.donem, son_odeme: mForm.son_odeme || null,
          donem_borcu: parseFloat(mForm.donem_borcu),
          asgari_tutar: mForm.asgari_tutar ? parseFloat(mForm.asgari_tutar) : null,
          faiz_orani: mForm.faiz_orani ? parseFloat(mForm.faiz_orani) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Kaydedilemedi');
      setMSonuc(d);
    } catch (e) { setMHata(e.message); } finally { setMBusy(false); }
  }

  const BANKA_AD = { axess: 'Axess', worldcard: 'Yapı Kredi', enpara: 'Enpara', ziraat: 'Ziraat', garanti: 'Garanti' };
  function gunCikar(d) {
    if (!d) return 1;
    const s = String(d);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return parseInt(m[3], 10);
    m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (m) return parseInt(m[1], 10);
    return 1;
  }

  async function kartiEkle() {
    if (!sonuc) return;
    const bankaLabel = BANKA_AD[sonuc.banka_format] || sonuc.banka_format || 'Banka';
    const body = {
      kart_adi: `${bankaLabel} ${sonuc.kart_sahibi || ''} ${sonuc.son_dort || ''}`.replace(/\s+/g, ' ').trim(),
      banka: bankaLabel,
      limit_tutar: sonuc.limit || 0,
      kesim_gunu: gunCikar(sonuc.kesim_tarihi),
      son_odeme_gunu: gunCikar(sonuc.son_odeme_tarihi),
      faiz_orani: sonuc.akdi_faiz_yillik || 0,
      asgari_oran: sonuc.asgari_oran || 40,
      gecikme_faiz_orani: sonuc.gecikme_faiz_yillik || 0,
      son_dort_hane: sonuc.son_dort || null,
      sahip: sonuc.kart_sahibi || 'İşletme',
    };
    setKartEkleBusy(true); setHata(null);
    try {
      const r = await fetch('/api/kartlar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Kart eklenemedi'); }
      if (lastFile) await yukle(lastFile);  // kart eklendi → tekrar eşleştir + mutabakat
    } catch (e) { setHata(e.message); } finally { setKartEkleBusy(false); }
  }

  async function yukle(file) {
    if (!file) return;
    setLastFile(file);
    setDosyaAdi(file.name); setHata(null); setSonuc(null); setImpSonuc(null); setSecili(new Set()); setYukleniyor(true);
    const fd = new FormData();
    fd.append('dosya', file);
    try {
      const res = await fetch('/api/kartlar/ekstre-yukle', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ayrıştırılamadı');
      setSonuc(data);
    } catch (e) {
      setHata(e.message || 'Hata');
    } finally { setYukleniyor(false); }
  }

  const m = sonuc?.mutabakat;
  const kart = sonuc?.eslesen_kart;
  const yeniIdx = (sonuc?.islemler || []).map((x, i) => x.durum === 'yeni' ? i : -1).filter(i => i >= 0);
  const yeniGuvenliIdx = yeniIdx.filter(i => !sonuc.islemler[i]?.benzer_gider_uyari);
  const yeniUyariliIdx = yeniIdx.filter(i => sonuc.islemler[i]?.benzer_gider_uyari);

  function toggle(i) {
    setSecili(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }

  async function devirKabul(k) {
    if (!k?.id) return;
    setDevirBusy(true); setHata(null);
    try {
      const r = await fetch(`/api/kartlar/${k.id}/manuel-ekstre`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donem: sonuc.kesim_tarihi, son_odeme: sonuc.son_odeme_tarihi || null,
          donem_borcu: sonuc.donem_borcu, asgari_tutar: sonuc.asgari_tutar || null,
          faiz_orani: sonuc.akdi_faiz_yillik || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'Devir kaydedilemedi');
      const yeniBorc = d.yeni_borc;
      setSonuc(s => ({ ...s, mutabakat: { ...s.mutabakat, sistem_borc: yeniBorc, fark: 0, tutar_uyumlu: true } }));
      setImpSonuc({ yazilan: 0, atlanan_veya_mevcut: 0, yeni_sistem_borc: yeniBorc, devir: true });
    } catch (e) { setHata(e.message); } finally { setDevirBusy(false); }
  }
  function tumYeni() {
    // Uyarılı (muhtemelen zaten girilmiş) kalemler otomatik seçilmez — kullanıcı isterse elle işaretler.
    setSecili(prev => prev.size === yeniGuvenliIdx.length ? new Set() : new Set(yeniGuvenliIdx));
  }

  // ⚡ TEK TIK MUTABAKAT (2026-07-10, sahip: 'her seferinde içe aktar + devir mi
  // diyeceğim?' — QuickBooks/YNAB deseni): eksikleri frenli aktar → kalan farkı
  // devir düzeltmesiyle OTOMATİK kapat → tek özet. Büyük farkta (>%5 / 5.000)
  // otomatik kapatmaz, onay ister. İç mekanik (import/devir) kullanıcıya sızmaz.
  const [ttBusy, setTtBusy] = useState(false);
  async function tekTikMutabakat() {
    if (!kart?.id || !sonuc) return;
    setTtBusy(true); setHata(null); setImpSonuc(null);
    try {
      // 1) TÜM eksikleri aktar (sunucu frenleri: çift yazmaz, elle eşi atlar)
      const islemler = (sonuc.islemler || []).filter(x => x && x.durum === 'yeni')
        .map(x => ({ tarih: x.tarih, tutar: x.tutar, tip: x.tip, aciklama: x.aciklama,
                     kategori: x.kategori, harcama_tipi: x.oneri_tipi || undefined,
                     taksit_sayisi: x.taksit_sayisi || undefined,
                     taksit_anapara: x.taksit_anapara || undefined }));
      let yeniBorc = sonuc?.mutabakat?.sistem_borc;
      let impOzet = { yazilan: 0, atlanan_veya_mevcut: 0, atlanan_mevcut_adet: 0 };
      if (islemler.length) {
        const r1 = await fetch('/api/kartlar/ekstre-import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kart_id: kart.id, islemler }),
        });
        const d1 = await r1.json();
        if (!r1.ok) throw new Error(d1.detail || 'İçe aktarılamadı');
        impOzet = d1; yeniBorc = d1.yeni_sistem_borc;
      }
      // 2) kalan fark → otomatik devir düzeltmesi (eşik: max(5000, ekstre %5))
      const ekstreBorc = sonuc?.mutabakat?.ekstre_borc ?? sonuc?.donem_borcu ?? 0;
      const fark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      const esik = Math.max(5000, Math.abs(ekstreBorc) * 0.05);
      let devirYapildi = false, devirDuzeltme = 0;
      // Eşik üstü fark: akışı YARIDA BIRAKMA — tek onay sorusuyla devam et
      // (2026-07-10 dersi: ilk mutabakat ayında eski devir tabanı yüzünden fark
      // hep büyük çıkar; kullanıcı ayrı buton aramak zorunda kalmasın).
      let devamOnayi = Math.abs(fark) <= esik;
      if (Math.abs(fark) > 1 && !devamOnayi) {
        devamOnayi = window.confirm(
          `Fark güvenlik eşiğinin üstünde: ${fark.toLocaleString('tr-TR')} ₺.

` +
          `Bu genelde İLK mutabakatta eski devir tabanından kaynaklanır ve güvenlidir ` +
          `(düzeltme kaydı birikmez, her zaman yeniden hesaplanır).

` +
          `Sistem borcu ekstre borcuna (${ekstreBorc.toLocaleString('tr-TR')} ₺) eşitlensin mi?`
        );
      }
      if (Math.abs(fark) > 1 && devamOnayi) {
        const r2 = await fetch(`/api/kartlar/${kart.id}/manuel-ekstre`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            donem: sonuc.kesim_tarihi, son_odeme: sonuc.son_odeme_tarihi || null,
            donem_borcu: sonuc.donem_borcu, asgari_tutar: sonuc.asgari_tutar || null,
            faiz_orani: sonuc.akdi_faiz_yillik || null,
          }),
        });
        const d2 = await r2.json();
        if (!r2.ok) throw new Error(d2.detail || 'Mutabakat düzeltmesi yapılamadı');
        yeniBorc = d2.yeni_borc; devirYapildi = true; devirDuzeltme = fark;
      }
      const sonFark = Math.round((ekstreBorc - (yeniBorc ?? 0)) * 100) / 100;
      setSonuc(sn => ({ ...sn, mutabakat: { ...sn.mutabakat, sistem_borc: yeniBorc,
        fark: sonFark, tutar_uyumlu: Math.abs(sonFark) < 1 } }));
      setImpSonuc({ ...impOzet, tek_tik: true, devir: devirYapildi,
        devir_duzeltme: devirDuzeltme, yeni_sistem_borc: yeniBorc,
        buyuk_fark_onay_gerek: Math.abs(sonFark) > 1 });
    } catch (e) { setHata(e.message); }
    finally { setTtBusy(false); }
  }

  async function iceAktar() {
    if (!kart?.id) return;
    const islemler = [...secili].map(i => sonuc.islemler[i]).filter(x => x && x.durum === 'yeni')
      .map(x => ({ tarih: x.tarih, tutar: x.tutar, tip: x.tip, aciklama: x.aciklama, kategori: x.kategori, harcama_tipi: x.oneri_tipi || undefined, taksit_sayisi: x.taksit_sayisi || undefined, taksit_anapara: x.taksit_anapara || undefined }));
    if (!islemler.length) return;
    setImpBusy(true); setHata(null);
    try {
      const r = await fetch('/api/kartlar/ekstre-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kart_id: kart.id, islemler }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || 'İçe aktarılamadı');
      setImpSonuc(d);
      // imported satırları 'eslesti' yap + mutabakatı güncelle
      const yeniBorc = d.yeni_sistem_borc;
      setSonuc(s => ({
        ...s,
        mutabakat: { ...s.mutabakat, sistem_borc: yeniBorc, fark: Math.round((s.mutabakat.ekstre_borc - yeniBorc) * 100) / 100, tutar_uyumlu: Math.abs(s.mutabakat.ekstre_borc - yeniBorc) < 1, yeni_islem_adet: Math.max(0, (s.mutabakat.yeni_islem_adet || 0) - islemler.length) },
        islemler: s.islemler.map((x, i) => secili.has(i) && x.durum === 'yeni' ? { ...x, durum: 'eslesti' } : x),
      }));
      setSecili(new Set());
    } catch (e) { setHata(e.message); } finally { setImpBusy(false); }
  }
  const formatAd = { worldcard: 'Worldcard / Yapı Kredi', enpara: 'Enpara', axess: 'Axess / Akbank', ziraat: 'Ziraat Bankkart', garanti: 'Garanti Bonus' }[sonuc?.banka_format] || sonuc?.banka_format;

  return (
    <div className="page">
      <div className="page-header">
        <h2>📄 Ekstre Yükle</h2>
        <p>Banka kredi kartı ekstresini (PDF) yükle → otomatik ayrıştır + mutabakat. <strong>Önizleme — kayıt yazılmaz.</strong></p>
      </div>

      <div className="card mb-16" style={{ padding: 20, textAlign: 'center', border: '1px dashed var(--border)' }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); yukle(e.dataTransfer.files?.[0]); }}>
        <div style={{ fontSize: 34, marginBottom: 8 }}>📥</div>
        <div style={{ color: 'var(--text2)', marginBottom: 12, fontSize: 13 }}>
          PDF ekstreyi buraya sürükle veya seç · <span style={{ color: 'var(--text3)' }}>Worldcard · Enpara · Garanti · Ziraat · Axess/Akbank desteklenir · okunamayan diğer bankalar için aşağıdaki Manuel Giriş</span>
        </div>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          PDF Seç
          <input type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
            onChange={e => yukle(e.target.files?.[0])} />
        </label>
        {dosyaAdi && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 10 }}>📎 {dosyaAdi}</div>}
      </div>

      {/* Manuel ekstre girişi — PDF okunamayan kartlar (Axess gibi) için */}
      <div className="card mb-16" style={{ padding: 0 }}>
        <button onClick={() => setManOpen(o => !o)} style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '14px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700 }}>🖊️ Manuel Ekstre Girişi <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>· PDF okunamayan kartlar (Axess) için borç/asgari/son ödeme elle gir</span></span>
          <span style={{ fontSize: 18, color: 'var(--text3)' }}>{manOpen ? '−' : '+'}</span>
        </button>
        {manOpen && (
          <div style={{ padding: '0 16px 16px' }}>
            {/* H5 — düzeltme güvencesi (2026-07-10): yanlış giriş korkusu kalksın */}
            <div style={{ fontSize: 12, color: 'var(--text3)', margin: '0 0 12px', lineHeight: 1.5 }}>
              💡 Yanlış tutar girdiysen sorun değil: aynı formu doğru değerlerle <b>tekrar gönder</b> —
              düzeltme üst üste binmez, borç her seferinde girdiğin değere çekilir.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
              <div className="form-group">
                <label>Kart *</label>
                <select value={mForm.kart_id} onChange={e => setMForm({ ...mForm, kart_id: e.target.value })}>
                  <option value="">— seç —</option>
                  {kartlar.map(k => <option key={k.id} value={k.id}>{k.kart_adi} ({k.banka})</option>)}
                </select>
              </div>
              <div className="form-group"><label>Kesim tarihi *</label><input type="date" value={mForm.donem} onChange={e => setMForm({ ...mForm, donem: e.target.value })} /></div>
              <div className="form-group"><label>Son ödeme tarihi</label><input type="date" value={mForm.son_odeme} onChange={e => setMForm({ ...mForm, son_odeme: e.target.value })} /></div>
              <div className="form-group"><label>Dönem borcu (₺) *</label><input type="number" step="0.01" value={mForm.donem_borcu} onChange={e => setMForm({ ...mForm, donem_borcu: e.target.value })} /></div>
              <div className="form-group"><label>Asgari tutar (₺)</label><input type="number" step="0.01" value={mForm.asgari_tutar} onChange={e => setMForm({ ...mForm, asgari_tutar: e.target.value })} /></div>
              <div className="form-group"><label>Yıllık akdi faiz oranı (%)</label><input type="number" step="0.01" placeholder="örn. 51" value={mForm.faiz_orani} onChange={e => setMForm({ ...mForm, faiz_orani: e.target.value })} /></div>
            </div>
            {mHata && <div className="alert-box red" style={{ marginTop: 8 }}>⚠️ {mHata}</div>}
            {mSonuc && <div className="alert-box green" style={{ marginTop: 8 }}>✅ Kaydedildi. Kartın güncel borcu: <strong>{fmt(mSonuc.yeni_borc)}</strong> · CFO ödeme planı + snapshot oluşturuldu.</div>}
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" disabled={mBusy} onClick={manuelKaydet}>{mBusy ? '…' : 'Kaydet'}</button>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>Borç tek bir düzeltme kaydıyla hedef değere çekilir (tekrar girişte değişir, birikmez). Kasaya dokunmaz.</span>
            </div>
          </div>
        )}
      </div>

      {yukleniyor && <div className="card" style={{ padding: 20, textAlign: 'center' }}><span className="spinner" /> Ayrıştırılıyor…</div>}
      {hata && <div className="alert-box red mb-16">⚠️ {hata}</div>}

      {sonuc && !yukleniyor && (
        <>
          {impSonuc?.tek_tik && (
            <div className="card mb-16" style={{ padding: 14, borderLeft: `3px solid ${impSonuc.buyuk_fark_onay_gerek ? 'var(--yellow, #f59e0b)' : 'var(--green)'}` }}>
              <div style={{ fontWeight: 800, fontSize: 14,
                color: impSonuc.buyuk_fark_onay_gerek ? 'var(--orange)' : 'var(--green)' }}>
                {impSonuc.buyuk_fark_onay_gerek
                  ? '⚠️ Mutabakat kısmen tamam — büyük fark onayını bekliyor'
                  : '⚡ Mutabakat TAMAM'}
              </div>
              <div style={{ fontSize: 13, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span>📥 Aktarılan: <b>{impSonuc.yazilan ?? 0}</b></span>
                <span>⏭️ Zaten kayıtlı: <b>{(impSonuc.atlanan_veya_mevcut ?? 0)}</b></span>
                {impSonuc.devir && <span>🧮 Mutabakat düzeltmesi: <b>{fmt(impSonuc.devir_duzeltme || 0)}</b></span>}
                <span>💳 Yeni sistem borcu: <b>{fmt(impSonuc.yeni_sistem_borc || 0)}</b></span>
              </div>
              {impSonuc.buyuk_fark_onay_gerek && (
                <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text3)' }}>
                  Onaylamadın — doğruysa ⚡ butona tekrar basıp onaylayabilir ya da aşağıdaki "Devir kabul et"i kullanabilirsin.
                </div>
              )}
            </div>
          )}
          {/* H4 — ESKİ DÖNEM UYARISI + H3 — TEYİT KARTI (2026-07-10 kullanıcı-akışı) */}
          {(() => {
            const sot = String(sonuc.son_odeme_tarihi || sonuc.kesim_tarihi || '');
            const ay = sot.slice(0, 7);
            const buAy = new Date().toISOString().slice(0, 7);
            return (
              <>
                {ay && ay < buAy && (
                  <div className="card mb-16" style={{ padding: 14, borderLeft: '3px solid var(--red)', background: 'rgba(239,68,68,.08)' }}>
                    <div style={{ fontWeight: 800, color: 'var(--red)', fontSize: 14 }}>⚠️ DİKKAT: Bu GÜNCEL dönem değil!</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      Yüklenen ekstre <b>{ay}</b> dönemine ait (son ödeme {sot}). Kayıt doğru aya işlenir —
                      ama güncel borcun için bu ayın ekstresini de yüklemeyi unutma (üstteki şerit hangi kartın beklediğini gösterir).
                    </div>
                  </div>
                )}
                {sonuc.donem_kaydedildi && (
                  <div className="card mb-16" style={{ padding: 14, borderLeft: '3px solid var(--green)', background: 'rgba(34,197,94,.07)' }}>
                    <div style={{ fontWeight: 800, color: 'var(--green)', fontSize: 14 }}>✓ Ekstre işlendi — plan güncellendi</div>
                    <div style={{ fontSize: 13, marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span>📄 Dönem borcu: <b>{fmt(sonuc.donem_borcu || 0)}</b></span>
                      <span>🔻 Asgari: <b>{fmt(sonuc.asgari_tutar || 0)}</b></span>
                      <span>📅 Son ödeme: <b>{sonuc.son_odeme_tarihi || '—'}</b></span>
                      {sonuc.cfo_odeme_plani && <span>🗓️ Ödeme planına işlendi ✓</span>}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
          {/* Mutabakat */}
          {kart ? (
            <div className="card mb-16" style={{ padding: 16, borderLeft: `3px solid ${m?.tutar_uyumlu ? 'var(--green)' : 'var(--red)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>🔗 Eşleşen kart: {kart.kart_adi}</div>
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>{kart.banka} · Sahip: {kart.sahip}</div>
                </div>
                <span className={`badge ${m?.tutar_uyumlu ? 'badge-green' : 'badge-red'}`} style={{ fontSize: 12 }}>
                  {m?.tutar_uyumlu ? '✓ Borç uyumlu' : '⚠ Borç farkı var'}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginTop: 12 }}>
                {[['Sistem borcu', m?.sistem_borc], ['Ekstre borcu', m?.ekstre_borc], ['Fark', m?.fark]].map(([l, v]) => (
                  <div key={l} style={{ background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: l === 'Fark' && Math.abs(v || 0) >= 1 ? 'var(--red)' : 'var(--text1)' }}>{fmt(v)}</div>
                  </div>
                ))}
              </div>
              {!m?.tutar_uyumlu && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  {yeniIdx.length > 0 ? (
                    <div className="alert-box yellow" style={{ fontSize: 12 }}>
                      ⚠️ Önce aşağıdaki <strong>{yeniIdx.length} eksik işlemi</strong> "İçe Aktar" ile aktar. Devir kabul etmeden önce bunları aktarmazsan, bu işlemler ekstre borcuna <strong>iki kere</strong> sayılır (önce devir farkıyla, sonra tekrar tek tek).
                      <div style={{ marginTop: 4 }}>İçe aktardıktan sonra kalan fark için "Devir kabul et" butonu burada çıkacak.</div>
                    </div>
                  ) : (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={devirBusy} onClick={() => devirKabul(kart)}>
                        {devirBusy ? '…' : `📌 Bu borcu açılış/devir olarak kabul et (${fmt(sonuc.donem_borcu)})`}
                      </button>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
                        Kartın borcunu ekstredeki <strong>{fmt(sonuc.donem_borcu)}</strong>'ye eşitler — kalan farkı <strong>açılış/devir</strong> olarak ekler (gider sayılmaz, kasaya dokunmaz). Geçmişten devreden bakiye için ideal.
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="alert-box yellow mb-16">
              <div>🔎 Son 4 hane <strong>{sonuc.son_dort || '—'}</strong> ile eşleşen kart yok.</div>
              <div style={{ fontSize: 12, color: 'var(--text2)', margin: '8px 0' }}>
                Ekstreden okunan bilgilerle bu kartı tek tıkla ekleyebilirsin:
                <strong> {(BANKA_AD[sonuc.banka_format] || sonuc.banka_format)} {sonuc.kart_sahibi || ''} …{sonuc.son_dort}</strong>
                {sonuc.limit ? ` · limit ${fmt(sonuc.limit)}` : ''}
                {sonuc.akdi_faiz_yillik ? ` · faiz %${sonuc.akdi_faiz_yillik}` : ''}
              </div>
              <button className="btn btn-primary btn-sm" disabled={kartEkleBusy} onClick={kartiEkle}>
                {kartEkleBusy ? '…' : '+ Bu Kartı Ekle ve Eşleştir'}
              </button>
            </div>
          )}

          {/* Çift yükleme uyarısı — bu kart için bu ayın ekstresi zaten var */}
          {sonuc.donem_zaten_yuklendi && (
            <div className="alert-box red mb-16">
              ⛔ <strong>Bu kartın {sonuc.donem_zaten_yuklendi.donem} ekstresi daha önce yüklenmiş</strong>
              {sonuc.donem_zaten_yuklendi.onceki_borc ? ` (kayıtlı borç ${fmt(sonuc.donem_zaten_yuklendi.onceki_borc)})` : ''}.
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
                İşlemler çift yazılmaz (sistem aynı işlemi tekrar eklemez) — bu yüzden aşağıda çoğu satır
                "✓ sistemde" görünür ve İçe Aktar sayısı 0 olur. <strong>Aynı ekstreyi tekrar yüklemene gerek yok.</strong>
                Sadece düzeltilmiş/yeni bir ekstre yüklüyorsan devam et.
              </div>
            </div>
          )}

          {/* Ekstre başlık verisi */}
          <div className="card mb-16" style={{ padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>{formatAd} · Kart …{sonuc.son_dort}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10, fontSize: 13 }}>
              {[
                ['Kesim tarihi', sonuc.kesim_tarihi],
                ['Son ödeme', sonuc.son_odeme_tarihi],
                ['Dönem borcu', fmt(sonuc.donem_borcu)],
                ['Asgari', `${fmt(sonuc.asgari_tutar)}${sonuc.asgari_oran ? ` (%${sonuc.asgari_oran})` : ''}`],
                ['Limit', fmt(sonuc.limit)],
                ['Kalan taksit', sonuc.kalan_taksit != null ? fmt(sonuc.kalan_taksit) : '—'],
                ['Önceki borç', sonuc.onceki_borc != null ? fmt(sonuc.onceki_borc) : '—'],
                ['Kart sahibi', sonuc.kart_sahibi || '—'],
              ].map(([l, v]) => (
                <div key={l} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>{l}</div>
                  <div style={{ fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {impSonuc && (
            <div className="alert-box green mb-16">
              {impSonuc.devir
                ? <>📌 Borç <strong>açılış/devir</strong> olarak kaydedildi (gider sayılmaz, kasaya dokunmaz). Kartın güncel borcu: <strong>{fmt(impSonuc.yeni_sistem_borc)}</strong>.</>
                : <>✅ {impSonuc.yazilan} işlem içe aktarıldı{impSonuc.atlanan_veya_mevcut ? ` (${impSonuc.atlanan_veya_mevcut} zaten vardı/atlandı)` : ''}{impSonuc.anlik_gider_yazilan ? `, bunlardan ${impSonuc.anlik_gider_yazilan} tanesi işletme/belirsiz harcama olarak anlık gidere de eklendi (👤 şahsi işaretliler hariç)` : ''}. Yeni sistem borcu: <strong>{fmt(impSonuc.yeni_sistem_borc)}</strong>.</>}
            </div>
          )}

          {/* İşlemler + içe aktar */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontWeight: 700 }}>
                İşlemler ({sonuc.islemler?.length || 0})
                {yeniIdx.length > 0 && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--orange)', fontWeight: 600 }}>· {yeniIdx.length} eksik (sistemde yok)</span>}
                {yeniUyariliIdx.length > 0 && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--red)', fontWeight: 600 }}>· {yeniUyariliIdx.length} olası mükerrer ⚠️</span>}
              </div>
              {kart && yeniIdx.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" disabled={ttBusy || impBusy}
                    onClick={tekTikMutabakat}
                    title="Eksikleri aktarır, kalan farkı mutabakat düzeltmesiyle kapatır — tek adım">
                    {ttBusy ? '⏳ Mutabakat yapılıyor…' : '⚡ Tek Tık Mutabakat (önerilen)'}
                  </button>
                  <details style={{ display: 'inline-block' }}>
                    <summary style={{ fontSize: 11, color: 'var(--text3)', cursor: 'pointer' }}>gelişmiş ▾</summary>
                    <span style={{ display: 'inline-flex', gap: 8, marginLeft: 6 }}>
                      <button className="btn btn-secondary btn-sm" onClick={tumYeni}>{secili.size === yeniGuvenliIdx.length ? 'Seçimi kaldır' : `Tüm eksikleri seç (${yeniGuvenliIdx.length})`}</button>
                      <button className="btn btn-secondary btn-sm" disabled={impBusy || secili.size === 0} onClick={iceAktar}>
                        {impBusy ? '…' : `İçe Aktar (${secili.size})`}
                      </button>
                    </span>
                  </details>
                </div>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th></th><th>Tarih</th><th>İşlem</th><th>Açıklama</th><th>Kategori</th><th>Taksit</th><th style={{ textAlign: 'right' }}>Tutar</th><th>Durum</th></tr></thead>
                <tbody>
                  {(sonuc.islemler || []).map((x, i) => (
                    <tr key={i} style={{ background: x.benzer_gider_uyari ? 'rgba(220,53,69,0.08)' : x.durum === 'yeni' ? 'rgba(212,137,58,0.06)' : undefined }}>
                      <td style={{ width: 28, textAlign: 'center' }}>
                        {x.durum === 'yeni' && kart && <input type="checkbox" checked={secili.has(i)} onChange={() => toggle(i)} />}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>{x.tarih || '—'}</td>
                      <td><span className={`badge ${x.tip === 'ODEME' ? 'badge-blue' : x.tip === 'FAIZ' ? 'badge-red' : 'badge-yellow'}`}>{x.tip}</span></td>
                      <td style={{ fontSize: 12, color: 'var(--text2)' }}>{x.aciklama}</td>
                      <td style={{ fontSize: 11, color: 'var(--text3)' }}>{x.kategori || '—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{x.taksit || '—'}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{fmt(x.tutar)}</td>
                      <td style={{ fontSize: 11 }}>
                        {x.durum === 'eslesti' ? <span style={{ color: 'var(--green)' }}>✓ sistemde</span>
                          : x.durum === 'yeni' ? (
                            <span style={{ color: x.benzer_gider_uyari ? 'var(--red)' : 'var(--orange)', fontWeight: 600 }}>
                              ● eksik{x.oneri_tipi ? (x.oneri_tipi === 'isletme' ? ' · 🏢' : ' · 👤') : ''}
                              {x.benzer_gider_uyari && (
                                <div style={{ fontWeight: 400, fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                                  ⚠️ {x.benzer_gider_uyari.tarih} tarihinde benzer gider zaten girilmiş: "{x.benzer_gider_uyari.aciklama}". Aktarırsan çift sayılabilir.
                                </div>
                              )}
                            </span>
                          )
                          : x.durum === 'taksit' ? <span style={{ color: 'var(--text3)' }}>taksit (elle)</span>
                          : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 12 }}>
            ℹ️ "İçe Aktar" yalnızca <strong>eksik (sistemde yok)</strong> işlemleri kart hareketlerine yazar — kasaya dokunmaz, çift yazmaz. Taksitli satırlar **toplam tutar + taksit sayısıyla** doğru aktarılır (idempotent). İçe aktardıktan sonra harcamaları Kart Hareketleri'nde 🏢/👤 ile sınıflandırabilirsin.
          </div>
        </>
      )}
    </div>
  );
}
