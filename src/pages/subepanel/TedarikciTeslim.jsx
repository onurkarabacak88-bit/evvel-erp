// 📦 TEDARİKÇİDEN GELEN — TESLİM AL (PANEL_YENIDEN_KURULUM.md "BASAMAK 8", sahip onayı 2026-10-19). Eski #svPanel (sube_panel.html
// ~11000-11420) AYNEN: kategori kartları → ürün (− adet +, koli yardımcısı yalnız ekranda) · tedarikçi (zorunlu) · 🧾 FATURA GELDİ Mİ?
// (zorunlu; EVET → toplam tutar + no; HAYIR → kâğıtta tutar yazıyorsa) · not · QR'la içeride personel + PIN → kaydet.
// TEK teslim kapısı (Tema = merkez depo da). Sunucu: evvel_yeni_panel_api.teslim_al → Toptancı teslim_yaz + Depo 'giris' tek işlem.
// Sök-tak: Toptancılar modülü kapalıysa ekran "kapalı" der. Sipariş modu / eksik bildirimi sipariş basamağıyla (ertelendi). Bip YOK (sahip).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { adetAyarla, AdetGirdi, C, Hero, KategoriKartlari, KisiPin, Modal, ModulKapali, panelHata, qrBoyut, sor, TabletQR, taslakKaldir, taslakOku, taslakYaz, tl, tutar, tutarNum, urunHaritasi, yeniIstek } from './ortak';


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
  const [foto, setFoto] = useState(null);
  // ↩ S9 "Hatalı? Geri al": bugünkü teslim → sebep + yetkili kişi + PIN (sunucu yetkiyi Tanımlar'dan denetler)
  const [geri, setGeri] = useState(null);   // { teslim, sebep, kisi, pin, istek }   // E1: kayıttan sonra { teslim_id, toptanci, fatura } → "📷 Faturayı çek" QR
  // 🛒 S5d (A10, D3): bu şubeye toptancıdan BEKLENEN sipariş kalemleri — işaretlenen kart teslime bağlanır (sipariş 'karşılandı' olur)
  const [bekl, setBekl] = useState([]);
  const [secYon, setSecYon] = useState(ilk?.secYon || []);
  const [disi, setDisi] = useState(false);       // Codex F (24 Eki): açık kart varken "sipariş dışı teslim" bilerek seçildi
  const [bagsizSor, setBagsizSor] = useState(null);   // [{yon_id, ad}] — kart işaretlenmeden aynı ürün eklendi
  // Fable S9: teslim kaydı / geri alma sonrası beklenen kartlar yeniden okunur (geri alınan teslimin kartı yeniden 'bekleniyor' olur)
  const teslimIzi = (d.teslimler_bugun || []).map((t) => t.id + (t.iptal ? ':x' : '')).join(',');
  useEffect(() => {
    api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/siparisler`).then((r) => setBekl(r?.toptanci_beklenen || [])).catch(() => setBekl([]));
  }, [subeId, teslimIzi]);
  useEffect(() => {
    taslakYaz(anahtar, { adet, koli, toptanci, fatura, ftTutar, ftNo, not, istek, secYon });
  }, [adet, koli, toptanci, fatura, ftTutar, ftNo, not, istek, secYon, anahtar]);

  const katalog = d.ac_katalog || [];
  const urunMap = useMemo(() => urunHaritasi(katalog), [katalog]);
  const secili = Object.entries(adet).filter(([id, n]) => n > 0 && urunMap[id]);
  const kalem = secili.length;
  const toplam = secili.reduce((a, [, n]) => a + n, 0);
  useEffect(() => { secimBildir?.(kalem); }, [kalem, secimBildir]);
  const tAd = (d.toptancilar || []).find((t) => t.id === toptanci)?.ad;

  const ayar = adetAyarla(setAdet);   // ortak adet kuralı (D6-R)
  const degis = ayar.degis;
  const art = (id, dlt) => { setKoli((o) => { const x = { ...o }; delete x[id]; return x; }); ayar.art(id, dlt); };
  const koliYaz = (u, alan, deger) => {   // "2 koli × 12 + 3" → adet (sayım birimi); sunucuya yalnız adet gider
    const n = Number(String(deger).replace(/\D/g, '') || 0);
    const x = { ...(koli[u.id] || { koli: 0, tek: 0 }), [alan]: n };
    setKoli((o) => ({ ...o, [u.id]: x }));
    degis(u.id, x.koli * Number(u.koli_ici || 0) + x.tek);
  };
  const beklenenler = (bekl.find((g) => String(g.toptanci_id) === String(toptanci)) || {}).kalemler || [];
  const yonSec = (k, sec) => {   // kartı işaretle → beklenen adet listeye eklenir (personel gelen GERÇEK adede göre düzeltir); kaldır → düşer
    setSecYon((o) => (sec ? [...o, k.yon_id] : o.filter((x) => x !== k.yon_id)));
    if (k.urun_id) setAdet((o) => ({ ...o, [k.urun_id]: Math.max(0, Math.min(99999, (o[k.urun_id] || 0) + (sec ? k.adet : -k.adet))) }));
  };
  const temizle = () => {
    setSecYon([]); setDisi(false); setBagsizSor(null);
    setAdet({}); setKoli({}); setToptanci(''); setFatura(null); setFtTutar(''); setFtNo(''); setNot(''); setIstek(yeniIstek());
    taslakKaldir(anahtar);
  };
  useEffect(() => { setHata(''); }, [adet, toptanci, fatura]);   // B15: düzeltilince eski hata kalmasın
  const onayAc = () => {   // eski validateAndSubmit sırası
    setHata('');
    if (!kalem) { setHata('Katalogdan en az bir üründe adet girin'); return; }
    if (!toptanci) { setHata('Tedarikçi seçin'); return; }
    if (fatura === null) { setHata('🧾 Fatura geldi mi? — EVET ya da HAYIR seçin'); return; }
    if (ftTutar && !(tutarNum(ftTutar) > 0)) { setHata('Tutarı sayı olarak yazın (ör. 1250,50)'); return; }
    if (fatura === true && !(tutarNum(ftTutar) > 0)) { setHata('Fatura geldiyse faturadaki TOPLAM tutarı yazın'); return; }
    // Codex F (24 Eki): bu tedarikçiden açık sipariş kartı olan ürün kart işaretlenmeden eklendiyse sor (yoksa sipariş sonsuza "bekleniyor")
    const bagliUrun = new Set(beklenenler.filter((y) => secYon.includes(y.yon_id)).map((y) => y.urun_id));   // o üründen kart işaretliyse bağlı
    const bagsiz = disi ? [] : beklenenler.filter((y) => !bagliUrun.has(y.urun_id) && (adet[y.urun_id] || 0) > 0);
    if (bagsiz.length) { setBagsizSor(bagsiz); return; }
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
        siparis_yon: secYon.length ? secYon : null,   // S5d: işaretli beklenen sipariş kartları bu teslime bağlanır
        siparis_disi: disi,
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

  const geriAl = async () => {
    if (mesgul || !geri) return;
    if (geri.sebep.trim().length < 3) { setGeri({ ...geri, hata: 'Neden geri alındığını yaz' }); return; }
    if (!/^\d{4}$/.test(geri.pin)) { setGeri({ ...geri, hata: '4 haneli PIN gir' }); return; }
    setMesgul(true); setGeri({ ...geri, hata: '' });
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/teslim-geri-al`, { method: 'POST', body: {
        personel_id: geri.kisi, pin: geri.pin, istek_id: geri.istek, istemci_gunu: d.gun, teslim_id: geri.teslim.id, sebep: geri.sebep.trim() } });
      setGeri(null);
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.mesaj || 'Teslim geri alındı'), !!r.kuru);
    } catch (e) {
      panelHata(e, { setHata: (h) => setGeri((g) => g && { ...g, hata: h }), pinSifirla: () => setGeri((g) => g && { ...g, pin: '' }), yeniIstekVer: () => setGeri((g) => g && { ...g, istek: yeniIstek() }) });
    }
    setMesgul(false);
  };

  if (!d.toptanci_acik) {
    return <ModulKapali>📦 Toptancılar modülü kapalı — teslim şu an alınamıyor. Merkeze haber ver.</ModulKapali>;
  }
  const k0 = katalog.find((k) => k.id === acikKat);
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <Hero ikon="📦" baslik="Tedarikçiden Gelen — Teslim Al" alt="Gelen ürünleri say · tedarikçi + fatura · Personel + PIN onayda istenir"
        zemin="linear-gradient(135deg,rgba(30,58,138,.75),rgba(59,130,246,.3))" cerceve="rgba(59,130,246,.35)" renk="#93c5fd" />
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — teslim alınamaz (merkez girer)</div>}

      <div className="sp-teslim" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(260px,340px)', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <KategoriKartlari katalog={katalog.filter((k) => k.urunler.some((u) => u.aktif || pasif))} adet={adet} kapali={kapali} onSec={setAcikKat} />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', color: C.soluk, fontSize: 13, justifySelf: 'end' }}>
            <input type="checkbox" checked={pasif} onChange={(e) => setPasif(e.target.checked)} /> Pasifleri göster</label>
        </div>

        {/* sağ sabit panel (eski): tedarikçi · özet · fatura · not · kaydet */}
        <div className="sp-kart sp-sayi-kart" style={{ display: 'grid', gap: 10, position: 'sticky', top: 0 }}>
          <label style={{ display: 'grid', gap: 4 }}><b>🚚 Tedarikçi *</b>
            <select className="sp-in" style={{ fontSize: 16 }} value={toptanci} onChange={(e) => { setToptanci(e.target.value); setSecYon([]); setDisi(false); }} disabled={kapali}>
              <option value="">— seç —</option>
              {(d.toptancilar || []).map((t) => <option key={t.id} value={t.id}>{t.ad}{bekl.some((g) => String(g.toptanci_id) === String(t.id)) ? ' · 🛒 sipariş bekleniyor' : ''}</option>)}
            </select></label>
          {beklenenler.length > 0 && (
            <div style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 10, background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.35)' }}>
              <b style={{ fontSize: 14 }}>🛒 Bu tedarikçiden beklenen sipariş — gelenleri işaretle</b>
              {beklenenler.map((k) => (
                <label key={k.yon_id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
                  <input type="checkbox" checked={secYon.includes(k.yon_id)} disabled={kapali} onChange={(e) => yonSec(k, e.target.checked)} />
                  <span style={{ flex: 1 }}>{k.ad}</span><b>{k.adet}</b>
                </label>
              ))}
              <span style={{ color: C.soluk, fontSize: 12 }}>İşaretleyince adet aşağıya eklenir — gelen farklıysa aşağıda − / + ile düzelt.</span>
            </div>
          )}
          <div style={{ display: 'grid', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {kalem === 0 ? <span style={{ color: C.soluk }}>Henüz ürün girilmedi</span> : (<>
              <b style={{ color: C.yesil }}>{kalem} kalem · {toplam} adet</b>
              {/* Z4 (sim 24 Eki): beklenen kart adedi doldurur; kurye kapıdayken gelen farklıysa BURADAN düzelt (kategoriye girmeden) */}
              {secili.map(([id, n]) => (
                <div key={id} style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'center' }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span>
                  <button type="button" className="sp-btn" style={{ minHeight: 64, minWidth: 64, padding: 0, fontSize: 24 }} disabled={kapali || n <= 1} onClick={() => ayar.art(id, -1)} aria-label={`${urunMap[id].ad} azalt`}>−</button>
                  <b style={{ minWidth: 56, textAlign: 'center', fontSize: 22 }}>{n}</b>
                  <button type="button" className="sp-btn" style={{ minHeight: 64, minWidth: 64, padding: 0, fontSize: 24 }} disabled={kapali} onClick={() => ayar.art(id, 1)} aria-label={`${urunMap[id].ad} artır`}>+</button>
                </div>))}
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
          {(kalem > 0 || toptanci) && <button type="button" className="sp-btn sp-orta" onClick={async () => (await sor({ soru: 'Teslim formu temizlensin mi?', alt: 'Seçtiğin ürünler ve adetler silinir.', tamam: 'Evet, temizle', iptal: 'Vazgeç' })) && temizle()}>✕ Formu temizle</button>}
        </div>
      </div>

      {(d.teslimler_bugun || []).length > 0 && (
        <div className="sp-kart" style={{ display: 'grid', gap: 8 }}>
          <b>📋 Bugün alınan teslimler</b>
          {d.teslimler_bugun.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', opacity: t.iptal ? 0.55 : 1 }}>
              <span style={{ flex: 1, minWidth: 200 }}>{t.saat} · <b>{t.toptanci}</b> · {t.kalem} kalem / {t.adet} adet{t.teslim_alan ? ` · ${t.teslim_alan}` : ''}</span>
              {t.iptal ? <span style={{ color: C.soluk, fontWeight: 700 }}>{t.iptal_eden === 'merkez' ? '✕ merkez iptal etti' : '↩ geri alındı'}</span>
                : t.merkez_isledi ? <span style={{ color: C.soluk, fontSize: 13 }}>merkez işledi — hata varsa merkeze haber ver</span>
                : <button type="button" className="sp-btn sp-orta" disabled={kapali}
                    onClick={() => setGeri({ teslim: t, sebep: '', kisi: '', pin: '', istek: yeniIstek(), hata: '' })}>Hatalı? Geri al</button>}
            </div>
          ))}
        </div>
      )}

      {geri && (
        <Modal baslik="↩ Teslimi geri al" kapat={() => setGeri(null)}>
          <div><b>{geri.teslim.toptanci}</b> · {geri.teslim.saat} · {geri.teslim.kalem} kalem / {geri.teslim.adet} adet</div>
          <span style={{ color: C.soluk, fontSize: 14 }}>Teslim silinmez, iptal olarak kalır; merkez kaydı düzeltir. Doğrusunu sonra yeniden girebilirsin. Yalnız geri alma yetkisi olan kişi yapabilir.</span>
          <label style={{ display: 'grid', gap: 4 }}><b>Neden? *</b>
            <input className="sp-in" style={{ fontSize: 16 }} value={geri.sebep} maxLength={200} placeholder="ör. yanlış tedarikçi seçildi, adet yanlış girildi"
              onChange={(e) => setGeri({ ...geri, sebep: e.target.value })} /></label>
          <KisiPin adaylar={adaylar} kisi={geri.kisi} setKisi={(k) => setGeri((g) => ({ ...g, kisi: k }))} pin={geri.pin}
            setPin={(v) => setGeri((g) => ({ ...g, pin: v }))} hata={geri.hata} soru="Kim geri alıyor?" />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sp-btn" disabled={mesgul} onClick={() => setGeri(null)}>Vazgeç</button>
            <button className="sp-btn sp-ana" style={{ flex: 1 }} disabled={mesgul || !geri.kisi || geri.pin.length !== 4 || geri.sebep.trim().length < 3}
              onClick={geriAl}>{mesgul ? 'Gönderiliyor…' : '↩ Geri al'}</button>
          </div>
        </Modal>
      )}
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

      {bagsizSor && (   /* Codex F (24 Eki): açık sipariş kartı işaretlenmeden aynı ürün geldi — bilerek seç */
        <Modal baslik="🛒 Bu ürünün açık siparişi var" kapat={() => setBagsizSor(null)}>
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: C.soluk }}>{tAd} için bekleyen sipariş kartı işaretlenmedi:</span>
            {bagsizSor.map((y) => <b key={y.yon_id}>• {y.ad}</b>)}
            <button type="button" className="sp-btn sp-orta sp-yesil"
              onClick={() => { setSecYon((o) => [...new Set([...o, ...bagsizSor.map((y) => y.yon_id)])]); setBagsizSor(null); setOnay(1); }}>
              ✓ Bu siparişe bağla (gelen bu sipariş)</button>
            <button type="button" className="sp-btn sp-orta" onClick={() => { setDisi(true); setBagsizSor(null); setOnay(1); }}>
              Sipariş dışı teslim (ayrıca geldi)</button>
          </div>
        </Modal>
      )}
      {onay > 0 && (
        <Modal baslik={`📦 ${tAd || ''} · ${toplam} adet`} kapat={() => { setOnay(0); setPin(''); }}>
          {/* TEK pencere — özet + kişi + PIN + kaydet (sahip 23 Eki, G23) */}
          <div style={{ display: 'grid', gap: 4, maxHeight: '30vh', overflow: 'auto' }}>
            {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
          </div>
          <div>🧾 Fatura: <b>{fatura ? 'GELDİ' : 'gelmedi'}</b>{ftTutar ? ` · ${tl(tutarNum(ftTutar))}` : ''}{fatura && ftNo.trim() ? ` · no ${ftNo.trim()}` : ''}</div>
          {not.trim() && <div style={{ color: C.soluk }}>Not: {not.trim()}</div>}
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim teslim aldı?"
            devam={kaydet} devamYazi="📦 Teslim al ve kaydet" mesgul={mesgul} />   {/* ortak Kişi + PIN (Dalga 5, F#48) */}
        </Modal>
      )}
    </div>
  );
}
