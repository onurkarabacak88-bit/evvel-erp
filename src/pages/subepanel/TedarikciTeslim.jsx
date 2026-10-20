// 📦 TEDARİKÇİDEN GELEN — TESLİM AL (PANEL_YENIDEN_KURULUM.md "BASAMAK 8", sahip onayı 2026-10-19). Eski #svPanel (sube_panel.html
// ~11000-11420) AYNEN: kategori kartları → ürün (− adet +, koli yardımcısı yalnız ekranda) · tedarikçi (zorunlu) · 🧾 FATURA GELDİ Mİ?
// (zorunlu; EVET → toplam tutar + no; HAYIR → kâğıtta tutar yazıyorsa) · not · QR'la içeride personel + PIN → kaydet.
// TEK teslim kapısı (Tema = merkez depo da). Sunucu: evvel_yeni_panel_api.teslim_al → Toptancı teslim_yaz + Depo 'giris' tek işlem.
// Sök-tak: Toptancılar modülü kapalıysa ekran "kapalı" der. Sipariş modu / eksik bildirimi sipariş basamağıyla (ertelendi). Bip YOK (sahip).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { AdetGirdi, C, KategoriKartlari, KisiPin, Modal, panelHata, qrBoyut, TabletQR, taslakKaldir, taslakOku, taslakYaz, tl, tutar, tutarNum, urunHaritasi, yeniIstek } from './ortak';


export default function TedarikciTeslim({ d, subeId, adaylar, kapali, bitti, secimBildir, tabletVar }) {
  const anahtar = `sp_taslak:${subeId}:${d.gun}:teslim_al`;
  const ilk = useMemo(() => { return taslakOku(anahtar) }, [anahtar]);
  const [adet, setAdet] = useState(ilk?.adet || {});
  const [koli, setKoli] = useState(ilk?.koli || {});            // {urun_id: {koli, tek}} — yalnız ekran yardımcısı + iz
  const [toptanci, setToptanci] = useState(ilk?.toptanci || '');
  const [fatura, setFatura] = useState(ilk?.fatura ?? null);    // true | false | null (zorunlu soru)
  const [ftTutar, setFtTutar] = useState(ilk?.ftTutar || '');
  const [ftNo, setFtNo] = useState(ilk?.ftNo || '');
  const [not, setNot] = useState(ilk?.not || '');
  const [istek, setIstek] = useState(() => ilk?.istek || yeniIstek());
  const [acikKat, setAcikKat] = useState(null);
  const [pasif, setPasif] = useState(false);
  const [onay, setOnay] = useState(0);   // 0 · 1 kişi + PIN · 2 özet
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');    // YALNIZ bellekte
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const [foto, setFoto] = useState(null);   // E1: kayıttan sonra { teslim_id, toptanci, fatura } → "📷 Faturayı çek" QR
  useEffect(() => {
    taslakYaz(anahtar, { adet, koli, toptanci, fatura, ftTutar, ftNo, not, istek });
  }, [adet, koli, toptanci, fatura, ftTutar, ftNo, not, istek, anahtar]);

  const katalog = d.ac_katalog || [];
  const urunMap = useMemo(() => urunHaritasi(katalog), [katalog]);
  const secili = Object.entries(adet).filter(([id, n]) => n > 0 && urunMap[id]);
  const kalem = secili.length;
  const toplam = secili.reduce((a, [, n]) => a + n, 0);
  useEffect(() => { secimBildir?.(kalem); }, [kalem, secimBildir]);
  const tAd = (d.toptancilar || []).find((t) => t.id === toptanci)?.ad;
  const kisiAd = adaylar.find((p) => p.id === kisi)?.ad;

  const degis = (id, n) => setAdet((o) => ({ ...o, [id]: Math.max(0, Math.min(99999, n)) }));
  const art = (id, dlt) => { setKoli((o) => { const x = { ...o }; delete x[id]; return x; }); setAdet((o) => ({ ...o, [id]: Math.max(0, Math.min(99999, (o[id] || 0) + dlt)) })); };
  const koliYaz = (u, alan, deger) => {   // "2 koli × 12 + 3" → adet (sayım birimi); sunucuya yalnız adet gider
    const n = Number(String(deger).replace(/\D/g, '') || 0);
    const x = { ...(koli[u.id] || { koli: 0, tek: 0 }), [alan]: n };
    setKoli((o) => ({ ...o, [u.id]: x }));
    degis(u.id, x.koli * Number(u.koli_ici || 0) + x.tek);
  };
  const temizle = () => {
    setAdet({}); setKoli({}); setToptanci(''); setFatura(null); setFtTutar(''); setFtNo(''); setNot(''); setIstek(yeniIstek());
    taslakKaldir(anahtar);
  };
  const onayAc = () => {   // eski validateAndSubmit sırası
    setHata('');
    if (!kalem) { setHata('Katalogdan en az bir üründe adet girin'); return; }
    if (!toptanci) { setHata('Tedarikçi seçin'); return; }
    if (fatura === null) { setHata('🧾 Fatura geldi mi? — EVET ya da HAYIR seçin'); return; }
    if (ftTutar && !(tutarNum(ftTutar) > 0)) { setHata('Tutarı sayı olarak yazın (ör. 1250,50)'); return; }
    if (fatura === true && !(tutarNum(ftTutar) > 0)) { setHata('Fatura geldiyse faturadaki TOPLAM tutarı yazın'); return; }
    setOnay(1);
  };
  const kaydet = async () => {
    if (mesgul) return;
    if (!/^\d{4}$/.test(pin)) { setHata('4 haneli PIN gir'); setOnay(1); return; }
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/teslim-al`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, toptanci_id: toptanci,
        kalemler: secili.map(([urun_id, n]) => ({ urun_id, adet: n })), fatura_geldi: fatura,
        tutar: ftTutar ? tutarNum(ftTutar) : null, fatura_no: fatura ? (ftNo.trim() || null) : null, aciklama: not.trim() || null,
        koli: Object.keys(koli).length ? Object.fromEntries(Object.entries(koli).map(([id, x]) => [id, { ...x, koli_ici: urunMap[id]?.koli_ici || null }])) : null } });
      setOnay(0); setPin(''); setKisi('');
      temizle();
      if (!r.kuru && r.teslim_id) setFoto({ teslim_id: r.teslim_id, toptanci: r.toptanci, fatura });   // E1: belgeyi telefonla çek
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'} · 📷 fatura fotoğrafı 1 Kasım'dan sonra` : (r.mesaj || 'Teslim kaydedildi'), !!r.kuru);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setOnay(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') { setOnay(0); setPin(''); }
    }
    setMesgul(false);
  };

  if (!d.toptanci_acik) {
    return <div className="sp-kart" style={{ color: C.sari, fontWeight: 700 }}>📦 Toptancılar modülü kapalı — teslim şu an alınamıyor. Merkeze haber ver.</div>;
  }
  const k0 = katalog.find((k) => k.id === acikKat);
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <div className="sp-kart" style={{ display: 'flex', gap: 12, alignItems: 'center', background: 'linear-gradient(135deg,rgba(30,58,138,.75),rgba(59,130,246,.3))', borderColor: 'rgba(59,130,246,.35)' }}>
        <span style={{ fontSize: 28 }}>📦</span>
        <div><b style={{ fontSize: 18, color: '#93c5fd' }}>Tedarikçiden Gelen — Teslim Al</b>
          <div style={{ color: C.soluk, fontSize: 13 }}>Gelen ürünleri say · tedarikçi + fatura · Personel + PIN onayda istenir</div></div>
      </div>
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — teslim alınamaz (merkez girer)</div>}

      <div className="sp-teslim" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(260px,340px)', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <KategoriKartlari katalog={katalog.filter((k) => k.urunler.some((u) => u.aktif || pasif))} adet={adet} kapali={kapali} onSec={setAcikKat} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', color: C.soluk, fontSize: 13, justifySelf: 'end' }}>
            <input type="checkbox" checked={pasif} onChange={(e) => setPasif(e.target.checked)} /> Pasifleri göster</label>
        </div>

        {/* sağ sabit panel (eski): tedarikçi · özet · fatura · not · kaydet */}
        <div className="sp-kart" style={{ display: 'grid', gap: 10, position: 'sticky', top: 0 }}>
          <label style={{ display: 'grid', gap: 4 }}><b>🚚 Tedarikçi *</b>
            <select className="sp-in" style={{ fontSize: 16 }} value={toptanci} onChange={(e) => setToptanci(e.target.value)} disabled={kapali}>
              <option value="">— seç —</option>
              {(d.toptancilar || []).map((t) => <option key={t.id} value={t.id}>{t.ad}</option>)}
            </select></label>
          <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {kalem === 0 ? <span style={{ color: C.soluk }}>Henüz ürün girilmedi</span> : (<>
              <b style={{ color: C.yesil }}>{kalem} kalem · {toplam} adet</b>
              {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
            </>)}
          </div>
          <div style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 10, border: `2px solid ${fatura === null && hata.includes('Fatura') ? C.kirmizi : C.cizgi}` }}>
            <b>🧾 FATURA GELDİ Mİ? *</b>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className={'sp-btn' + (fatura === true ? ' sp-ana' : '')} style={{ flex: 1 }} onClick={() => setFatura(true)}>EVET</button>
              <button type="button" className={'sp-btn' + (fatura === false ? ' sp-ana' : '')} style={{ flex: 1 }} onClick={() => setFatura(false)}>HAYIR</button>
            </div>
            {fatura !== null && (<>
              <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 13, color: C.soluk }}>{fatura ? 'Faturadaki TOPLAM tutar (₺) *' : 'Kâğıtta (irsaliye / fiş) tutar yazıyorsa ₺ — yazmıyorsa BOŞ bırak'}</span>
                <input className="sp-in" inputMode="decimal" value={ftTutar} onChange={(e) => setFtTutar(tutar(e.target.value))} placeholder="0,00" /></label>
              {fatura && <label style={{ display: 'grid', gap: 4 }}><span style={{ fontSize: 13, color: C.soluk }}>Fatura no (varsa)</span>
                <input className="sp-in" style={{ fontSize: 16 }} value={ftNo} onChange={(e) => setFtNo(e.target.value.slice(0, 40))} /></label>}
            </>)}
          </div>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 12, fontWeight: 700 }}>NOT (isteğe bağlı)</span>
            <input className="sp-in" style={{ fontSize: 16 }} value={not} onChange={(e) => setNot(e.target.value.slice(0, 300))} placeholder="Opsiyonel açıklama…" /></label>
          {hata && onay === 0 && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-yesil" disabled={kapali || mesgul} onClick={onayAc}>📦 Teslim al ve kaydet</button>
          {(kalem > 0 || toptanci) && <button type="button" className="sp-btn" style={{ minHeight: 40 }} onClick={temizle}>✕ Formu temizle</button>}
        </div>
      </div>

      {foto && (
        <Modal baslik="📷 Faturayı çek" kapat={() => setFoto(null)}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 10, textAlign: 'center' }}>
            <b>{foto.toptanci} teslimi kaydedildi ✓</b>
            {tabletVar ? <TabletQR boyut={qrBoyut(300, 220, 120)} teslim={foto.teslim_id} />
              : <b style={{ color: C.sari }}>Bu bilgisayar kayıtlı değil — QR çıkamaz; faturayı merkez ekler.</b>}
            <span style={{ color: C.soluk }}>{foto.fatura ? 'Teslim alan kişi telefonuyla okutsun → faturanın her sayfasını çeksin (en çok 6).' : 'Kâğıt (irsaliye / fiş) varsa telefonla okutup çekin.'}
              <br />Fotoğraf teslime eklenir — merkez Toptancılar'da sayfa sayfa görür.</span>
            <button className="sp-btn" onClick={() => setFoto(null)}>Bitti / sonra</button>
          </div>
        </Modal>
      )}
      {k0 && (
        <Modal baslik={`${k0.emoji || '📦'} ${k0.kategori}`} kapat={() => setAcikKat(null)} genislik={680}>
          {k0.urunler.filter((u) => u.aktif || pasif).map((u) => {
            const n = adet[u.id] || 0;
            const ki = Number(u.koli_ici || 0);
            return (
              <div key={u.id} style={{ display: 'grid', gap: 4, padding: 6, borderRadius: 10, background: n ? 'rgba(34,197,94,.1)' : C.bg2, opacity: u.aktif ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontWeight: 700, fontSize: 16 }}>{u.ad}{!u.aktif && ' 🚫'} <span style={{ color: C.soluk, fontSize: 12, fontWeight: 500 }}>{u.birim}</span></span>
                  <AdetGirdi n={n} azalt={() => art(u.id, -1)} artir={() => art(u.id, 1)} genislik={96} font={30}
                    yaz={(v) => { setKoli((o) => { const x = { ...o }; delete x[u.id]; return x; }); degis(u.id, v); }} />   {/* ortak − adet + (F#51) */}
                </div>
                {ki > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.soluk, justifyContent: 'flex-end' }}>
                    🧮 <input className="sp-in" style={{ width: 64, textAlign: 'center' }} inputMode="numeric" value={koli[u.id]?.koli || ''} placeholder="0" onChange={(e) => koliYaz(u, 'koli', e.target.value)} />
                    koli × {ki} +
                    <input className="sp-in" style={{ width: 64, textAlign: 'center' }} inputMode="numeric" value={koli[u.id]?.tek || ''} placeholder="0" onChange={(e) => koliYaz(u, 'tek', e.target.value)} />
                    tek = <b style={{ color: C.yazi }}>{n}</b>
                  </div>
                )}
              </div>
            );
          })}
          <button className="sp-btn sp-yesil" onClick={() => setAcikKat(null)}>Tamam</button>
        </Modal>
      )}

      {onay > 0 && (
        <Modal baslik={onay === 1 ? '📦 Teslim onayı' : `📦 ${tAd || ''} · ${toplam} adet`} kapat={() => { setOnay(0); setPin(''); }}>
          {onay === 1 && (<>
            <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim teslim aldı?"
              devam={() => { setHata(''); setOnay(2); }} />   {/* ortak Kişi + PIN (Dalga 5, F#48) */}
          </>)}
          {onay === 2 && (<>
            <div style={{ color: C.soluk }}>Teslim alan: <b style={{ color: C.yazi }}>{kisiAd || '—'}</b> · Tedarikçi: <b style={{ color: C.yazi }}>{tAd}</b></div>
            {!kisiAd && <div style={{ color: C.sari, fontWeight: 700 }}>Seçili kişi çıkış yapmış — geri dönüp adını yeniden seç</div>}
            <div style={{ fontSize: 22, fontWeight: 900, color: C.yesil }}>{kalem} kalem · {toplam} adet</div>
            <div style={{ display: 'grid', gap: 4, maxHeight: '36vh', overflow: 'auto' }}>
              {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
            </div>
            <div>🧾 Fatura: <b>{fatura ? 'GELDİ' : 'gelmedi'}</b>{ftTutar ? ` · ${tl(tutarNum(ftTutar))}` : ''}{fatura && ftNo.trim() ? ` · no ${ftNo.trim()}` : ''}</div>
            {not.trim() && <div style={{ color: C.soluk }}>Not: {not.trim()}</div>}
            {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="sp-btn" disabled={mesgul} onClick={() => setOnay(1)}>« Geri</button>
              <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={mesgul || !kisiAd} onClick={kaydet}>{mesgul ? 'Gönderiliyor…' : '📦 Teslim al ve kaydet'}</button>
            </div>
          </>)}
        </Modal>
      )}
    </div>
  );
}
