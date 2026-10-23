// 🔓 ÜRÜN AÇ — eski sube_panel.html tab-ac AYNEN (5363–5395, 10070–10120, 11479–11560, 12390–12610); PANEL_YENIDEN_KURULUM.md Basamak 5.
// Orta alanda SEKME: hero · yapışkan onay çubuğu · kategori kartları (rozet) · "Pasifleri göster" · kategori penceresi (− adet +) ·
// seçim özeti · not → "Onayla" → TEK pencere: özet + yalnız QR ile girmiş personel + PIN → Kaydet (sahip 23 Eki). Bütün katalog (sahip).
// Kullanımda / Bitti YOK (istisna 4). Taslak tablette (iş gününe bağlı). Sunucu: evvel_yeni_panel_api.urun_ac.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { adetAyarla, AdetGirdi, C, Hero, KategoriKartlari, KisiPin, Modal, panelHata, taslakKaldir, taslakOku, taslakYaz, urunHaritasi, yeniIstek } from './ortak';


export default function UrunAc({ d, subeId, adaylar, kapali, bitti, secimBildir }) {
  const anahtar = `sp_taslak:${subeId}:${d.gun}:urun_ac`;
  const ilk = useMemo(() => { return taslakOku(anahtar) }, [anahtar]);
  const [adet, setAdet] = useState(ilk?.adet || {});
  const [not, setNot] = useState(ilk?.not || '');
  const [pasif, setPasif] = useState(false);
  const [acikKat, setAcikKat] = useState(null);
  const [ara, setAra] = useState('');   // G21: Fire'daki gibi ürün arama (şurup vb. kategoride aranmasın)
  const [onay, setOnay] = useState(0);          // 0 kapalı · 1 tek onay penceresi (özet + kişi + PIN)
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');             // YALNIZ bellekte (taslağa / hiçbir yere yazılmaz)
  const [istek, setIstek] = useState(() => ilk?.istek || yeniIstek());
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const [mesaj, setMesaj] = useState(ilk && Object.keys(ilk.adet || {}).length ? 'taslak' : '');
  const [flas, setFlas] = useState(false);
  useEffect(() => { taslakYaz(anahtar, { adet, not, istek }); }, [adet, not, istek, anahtar]);
  const taslakYol = `/evvel-yeni/panel/${encodeURIComponent(subeId)}/taslak/urun_ac`;
  const sunucuHazir = useRef(false);
  useEffect(() => {   // sahip: fonksiyon kaybı yok — eski panel taslağı sunucuda tutuyordu (başka PC / silinen tarayıcı)
    let canli = true;
    if (ilk && Object.keys(ilk.adet || {}).length) { sunucuHazir.current = true; return undefined; }
    api(`${taslakYol}?gun=${encodeURIComponent(d.gun)}`).then((r) => {
      if (!canli) return;
      const v = r?.veri;
      if (v && Object.keys(v.adet || {}).length) { setAdet(v.adet); setNot(v.not || ''); if (v.istek) setIstek(v.istek); setMesaj('taslak'); }
    }).catch(() => { /* taslak yok / internet yok — sessiz */ }).finally(() => { sunucuHazir.current = true; });
    return () => { canli = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!sunucuHazir.current) return undefined;
    const t = window.setTimeout(() => {
      const bos = !Object.values(adet).some((n) => n > 0);
      (bos ? api(`${taslakYol}?gun=${encodeURIComponent(d.gun)}`, { method: 'DELETE' })
        : api(taslakYol, { method: 'POST', body: { gun: d.gun, veri: { adet, not, istek } } })).catch(() => { /* sessiz */ });
    }, 800);
    return () => window.clearTimeout(t);
  }, [adet, not, istek]);   // eslint-disable-line react-hooks/exhaustive-deps

  // pasta ('gununde') açılmaz — girişte tüketildi (sunucu da reddeder); liste Tedarikçi / Sipariş ile ortak olduğu için burada süzülür
  const katalog = useMemo(() => (d.ac_katalog || []).map((k) => ({ ...k, urunler: k.urunler.filter((u) => u.takip !== 'gununde') }))
    .filter((k) => k.urunler.length), [d.ac_katalog]);
  const urunMap = useMemo(() => urunHaritasi(katalog), [katalog]);
  const secili = Object.entries(adet).filter(([id, n]) => n > 0 && urunMap[id]);
  const kalem = secili.length;
  const toplam = secili.reduce((a, [, n]) => a + n, 0);
  useEffect(() => { secimBildir?.(kalem); }, [kalem, secimBildir]);
  useEffect(() => {   // eski: onaylanmamış seçim varken sayfadan çıkışta uyarı
    if (!kalem) return undefined;
    const u = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', u);
    return () => window.removeEventListener('beforeunload', u);
  }, [kalem]);

  const sonKisiAnahtar = `sp_urunac_kisi:${subeId}`;
  const onayAc = () => {
    setHata('');
    let son = '';
    try { son = localStorage.getItem(sonKisiAnahtar) || ''; } catch { son = ''; }
    if (!kisi && son && adaylar.some((p) => p.id === son)) setKisi(son);
    setOnay(1);
  };
  const { art, degis } = adetAyarla(setAdet);   // ortak adet kuralı (D6-R)
  const temizle = () => {
    setAdet({}); setNot(''); setIstek(yeniIstek()); setMesaj('');
    taslakKaldir(anahtar);
    api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/taslak/urun_ac?gun=${encodeURIComponent(d.gun)}`, { method: 'DELETE' }).catch(() => { /* sessiz */ });
  };

  const kaydet = async () => {
    if (mesgul) return;
    if (!/^\d{4}$/.test(pin)) { setHata('4 haneli PIN gir'); setOnay(1); return; }
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/urun-ac`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, aciklama: not.trim() || null,
        kalemler: secili.map(([urun_id, n]) => ({ urun_id, adet: n })) } });
      try { localStorage.setItem(sonKisiAnahtar, kisi); } catch { /* yok */ }
      setFlas(true); window.setTimeout(() => setFlas(false), 2000);   // sahip (19 Eki): bip sesi YOK
      setOnay(0); setPin(''); setKisi('');
      temizle();
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : `✅ Ürün Aç tamamlandı — ${kalem} kalem / ${toplam} adet`, !!r.kuru);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setOnay(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') { setOnay(0); setPin(''); }
    }
    setMesgul(false);
  };

  const k0 = katalog.find((k) => k.id === acikKat);
  const araT = ara.trim().toLocaleLowerCase('tr');
  const aramaSonuc = araT.length >= 2
    ? katalog.flatMap((k) => k.urunler.filter((u) => (u.aktif || pasif) && `${u.ad} ${k.kategori || ''}`.toLocaleLowerCase('tr').includes(araT))
      .map((u) => ({ ...u, kategori: k.kategori }))).filter((u, i, a) => a.findIndex((x) => x.id === u.id) === i).slice(0, 30) : [];

  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start', ...(flas ? { boxShadow: `0 0 0 4px ${C.yesil}`, borderRadius: 14, transition: 'box-shadow .3s' } : {}) }}>
      {/* yapışkan onay çubuğu — G41 (sim 23 Eki): HEP yerinde (seçim yokken soluk); ilk + dokunuşunda belirip sayfayı itiyordu → ikinci dokunuş kayıyordu */}
      <div className="sp-kart" style={{ position: 'sticky', top: 0, zIndex: 5, display: 'grid', gap: 6, borderColor: kalem ? C.yesil : undefined }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ flex: 1, color: kalem ? undefined : C.soluk }}>{kalem ? `🔓 ${kalem} çeşit · toplam ${toplam} adet seçildi` : '🔓 Henüz ürün seçilmedi'}</b>
          <button className="sp-btn sp-yesil" disabled={!kalem || kapali || mesgul} style={kalem ? undefined : { opacity: 0.35 }} onClick={onayAc}>Onayla →</button>   {/* G12: kısa yazı; kişi + PIN açılan pencerede */}
        </div>
      </div>
      {/* hero */}
      <Hero ikon="🔓" baslik="Ürün Aç — Aktif Kullanıma Al" alt="Depodan bara/sahaya çıkan ürünleri sayın · Personel + PIN onayda istenir"
        zemin="linear-gradient(135deg,rgba(6,78,59,.75),rgba(16,185,129,.3))" cerceve="rgba(34,197,94,.35)" renk="#86efac" />
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — Ürün Aç yapılamaz</div>}
      {mesaj === 'taslak' && kalem > 0 && (
        <div className="sp-kart" style={{ borderColor: C.sari, color: C.sari, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>🔄 Yarım kalan seçimin geri geldi ({kalem} çeşit). Üstteki «Onayla» ile bitir.</span>
          <button className="sp-btn" style={{ minHeight: 40, padding: '4px 12px' }} onClick={temizle}>✕ Taslağı temizle</button>
        </div>
      )}
      {/* G21: ürün arama — kategori bilmeden bulunur */}
      <input className="sp-in" style={{ fontSize: 17 }} value={ara} onChange={(e) => setAra(e.target.value)} disabled={kapali}
        placeholder="🔎 Ürün ara (en az 2 harf)…" />
      {araT.length >= 2 && (
        <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ flex: 1, color: C.soluk, fontSize: 12 }}>ARAMA SONUCU · {aramaSonuc.length}</b>
            <button className="sp-btn" style={{ minHeight: 40, padding: '4px 12px' }} onClick={() => setAra('')}>✕ Aramayı kapat</button>
          </div>
          {aramaSonuc.length === 0 && <div style={{ color: C.soluk }}>“{ara.trim()}” bulunamadı{pasif ? '' : ' — pasif ürünse «Pasifleri göster»i işaretle'}.</div>}
          {aramaSonuc.map((u) => {
            const n = adet[u.id] || 0;
            return (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 10, background: n ? 'rgba(34,197,94,.1)' : C.bg2, opacity: u.aktif ? 1 : 0.6 }}>
                <span style={{ flex: 1, fontWeight: 700, fontSize: 16 }}>{u.ad}{!u.aktif && ' 🚫'} <span style={{ color: C.soluk, fontSize: 12, fontWeight: 500 }}>{u.kategori} · {u.birim}</span></span>
                <AdetGirdi n={n} azalt={() => art(u.id, -1)} artir={() => art(u.id, 1)} genislik={90} font={32} yaz={(v) => degis(u.id, v)} />
              </div>
            );
          })}
        </div>
      )}
      {/* kategori kartları */}
      <KategoriKartlari katalog={katalog.filter((k) => k.urunler.some((u) => u.aktif || pasif))} adet={adet} kapali={kapali} onSec={setAcikKat}
        enAz={170} yukseklik={96} alt={(k) => `${k.urunler.filter((u) => u.aktif).length} ürün · Dokun → liste`} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: C.soluk, fontSize: 13 }}>
        <span style={{ flex: 1 }}>Kategoriye dokunun, adet girin, Tamam deyin.</span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={pasif} onChange={(e) => setPasif(e.target.checked)} /> Pasifleri göster</label>
      </div>
      {/* seçim özeti + not */}
      <div className="sp-kart" style={{ display: 'grid', gap: 8 }}>
        {kalem === 0 ? <span style={{ color: C.soluk }}>Henüz ürün seçilmedi</span> : (<>
          <div style={{ fontSize: 28, fontWeight: 900, color: C.yesil }}>{kalem} kalem · {toplam} adet <span style={{ fontSize: 15, fontWeight: 700 }}>aktif kullanıma alınacak</span></div>
          {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{urunMap[id].ad} <span style={{ color: C.soluk }}>· {urunMap[id].kategori}</span></span><b>{n}</b></div>)}
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 12, fontWeight: 700 }}>NOT (isteğe bağlı)</span>
            <input className="sp-in" style={{ fontSize: 16 }} value={not} onChange={(e) => setNot(e.target.value.slice(0, 200))} placeholder="Opsiyonel açıklama…" /></label>
        </>)}
      </div>

      {/* kategori penceresi: − adet + */}
      {k0 && (
        <Modal baslik={`${k0.emoji || '📦'} ${k0.kategori}`} kapat={() => setAcikKat(null)} genislik={640}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', color: C.soluk, fontSize: 13, justifySelf: 'end' }}>
            <input type="checkbox" checked={pasif} onChange={(e) => setPasif(e.target.checked)} /> Pasifleri göster</label>
          {[['Aktif ürünler', k0.urunler.filter((u) => u.aktif)], ...(pasif ? [['Pasif ürünler', k0.urunler.filter((u) => !u.aktif)]] : [])].map(([baslik, liste]) => (
            <div key={baslik} style={{ display: 'grid', gap: 6 }}>
              <b style={{ color: C.soluk, fontSize: 12 }}>{baslik.toUpperCase()}</b>
              {liste.length === 0 && <div style={{ color: C.soluk }}>Bu kategoride {baslik === 'Aktif ürünler' ? 'aktif' : 'pasif'} ürün yok.</div>}
              {liste.map((u) => {
                const n = adet[u.id] || 0;
                return (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 10, background: n ? 'rgba(34,197,94,.1)' : C.bg2, opacity: u.aktif ? 1 : 0.6 }}>
                    <span style={{ flex: 1, fontWeight: 700, fontSize: 16 }}>{u.ad}{!u.aktif && ' 🚫'} <span style={{ color: C.soluk, fontSize: 12, fontWeight: 500 }}>{u.birim}</span></span>
                    <AdetGirdi n={n} azalt={() => art(u.id, -1)} artir={() => art(u.id, 1)} genislik={90} font={32}
                      yaz={(v) => degis(u.id, v)} />   {/* ortak − adet + (F#51) */}
                  </div>
                );
              })}
            </div>
          ))}
          <button className="sp-btn sp-yesil" onClick={() => setAcikKat(null)}>Tamam</button>
        </Modal>
      )}

      {/* onay: TEK pencere — özet + kişi + PIN + kaydet (sahip 23 Eki, G13/G23: ikinci özet basamağı kalktı) */}
      {onay > 0 && (
        <Modal baslik={`🔓 ${toplam} adet ürün açılacak`} kapat={() => { setOnay(0); setPin(''); }}>
          <div style={{ display: 'grid', gap: 4, maxHeight: '30vh', overflow: 'auto' }}>
            {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
          </div>
          {not.trim() && <div style={{ color: C.soluk }}>Not: {not.trim()}</div>}
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim açıyor?"
            devam={kaydet} devamYazi="✓ Ürünleri aç" mesgul={mesgul} />   {/* ortak Kişi + PIN (Dalga 5, F#48) */}
        </Modal>
      )}
    </div>
  );
}
