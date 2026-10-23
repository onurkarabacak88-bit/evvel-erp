// 🔥 FIRE BİLDİRİMİ — eski sube_panel.html 3 adımlı sihirbaz (11588–12253) yeniden kurgulanmış hâli; PANEL_YENIDEN_KURULUM.md §11.
// Sahip (20 Eki): sebep kartlarını "sen yeniden tasarlayabilirsin" → 8 kart (sunucu FIRE_SEBEP_LISTE — TEK yer, /durum'dan okunur).
//   1 · SEBEP  kart → (Hatalı hazırlık: alt seçim · İade: iade sebebi 6 kart)
//   2 · ÜRÜN   önce sebebin ÖNERİLEN grupları (katalogdan — sabit ürün kodu YOK), altında BÜTÜN katalog + arama; − adet +
//   3 · ONAY   özet · iade: fiş no + saat ZORUNLU, müşteri adı / telefonu isteğe bağlı (sahip) · Diğer: açıklama ≥10
//   → yalnız QR ile girmiş personel + PIN (S3) → kaydet. Bip yok. Taslak tablette (müşteri adı/telefonu TASLAĞA YAZILMAZ).
// Kayıt mekanizması sunucuda (evvel_yeni_panel_api.fire): Depo fire hareketi (tezgah ürünü bardan — D-4) + olay. Gider fire/iade/ikram/
// personel ayrı satır; 'Sayım düzeltmesi' gidere girmez.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { adetAyarla, AdetGirdi, C, Hero, kalemGovde, KategoriKartlari, KisiPin, Modal, panelHata, taslakKaldir, taslakOku, taslakYaz, TONLAR, urunHaritasi, yeniIstek } from './ortak';

const BARDAK = '__bardak__';   // sunucu oneri anahtarı: bardak işaretli ürünler
const aktifSay = (k) => `${k.urunler.filter((u) => u.aktif).length} ürün`;   // pencere / arama pasifi gizler → sayı da aktif (D6-R)

function Kart({ secik, onClick, children, renk = C.kirmizi, kapali }) {
  return (
    <button type="button" className="sp-btn" onClick={onClick} disabled={kapali}
      style={{ minHeight: 84, display: 'grid', gap: 4, alignContent: 'center', textAlign: 'left', padding: '10px 14px',
        borderColor: secik ? renk : undefined, background: secik ? `${renk}33` : undefined }}>{children}</button>
  );
}

export default function Fire({ d, subeId, adaylar, kapali, bitti }) {
  const anahtar = `sp_taslak:${subeId}:${d.gun}:fire_sihirbaz`;
  const ilk = useMemo(() => taslakOku(anahtar), [anahtar]);
  const [adim, setAdim] = useState(ilk?.adim || 1);
  const [sebep, setSebep] = useState(ilk?.sebep || '');
  const [hazirlik, setHazirlik] = useState(ilk?.hazirlik || '');
  const [iadeSebep, setIadeSebep] = useState(ilk?.iadeSebep || '');
  const [adet, setAdet] = useState(ilk?.adet || {});
  const [aciklama, setAciklama] = useState(ilk?.aciklama || '');
  const [fis, setFis] = useState(ilk?.fis || '');
  const [iadeSaat, setIadeSaat] = useState(ilk?.iadeSaat || '');
  const [mAd, setMAd] = useState('');      // kişisel veri — taslağa YAZILMAZ
  const [mTel, setMTel] = useState('');
  const [acikGrup, setAcikGrup] = useState(null);
  const [ara, setAra] = useState('');
  const [onay, setOnay] = useState(0);     // 0 · 1 kişi+PIN · 2 özet
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [istek, setIstek] = useState(() => ilk?.istek || yeniIstek());
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  useEffect(() => {
    if (!sebep && !Object.values(adet).some((n) => n > 0) && !aciklama && !fis) { taslakKaldir(anahtar); return; }
    taslakYaz(anahtar, { adim, sebep, hazirlik, iadeSebep, adet, aciklama, fis, iadeSaat, istek });
  },
    [adim, sebep, hazirlik, iadeSebep, adet, aciklama, fis, iadeSaat, istek, anahtar]);

  const sebepler = d.fire_sebepleri || [];
  const sb = sebepler.find((x) => x.kod === sebep);
  const katalog = d.ac_katalog || [];   // pasta dahil (fire'ı olur)
  const urunMap = useMemo(() => urunHaritasi(katalog), [katalog]);
  // önerilen gruplar: sebebin oneri sırası (kategori adı ya da bardaklar) — katalogda olanlar
  const oneri = useMemo(() => (sb?.oneri || []).map((o) => (o === BARDAK
    ? { id: BARDAK, kategori: 'Bardaklar', emoji: '🥤', urunler: katalog.flatMap((k) => k.urunler.filter((u) => u.bardak)) }
    : katalog.find((k) => k.id === o))).filter((k) => k && k.urunler.length), [sb, katalog]);
  const g0 = acikGrup === BARDAK ? oneri.find((k) => k.id === BARDAK) : katalog.find((k) => k.id === acikGrup);
  const aramaSonuc = ara.trim().length >= 2
    ? katalog.flatMap((k) => k.urunler.filter((u) => u.aktif && `${u.ad} ${k.kategori || ''}`.toLocaleLowerCase('tr').includes(ara.trim().toLocaleLowerCase('tr')))).slice(0, 30) : [];   // B20: kategori adıyla da ('pasta')

  const secili = Object.entries(adet).filter(([id, n]) => n > 0 && urunMap[id]);
  const kalem = secili.length;
  const toplam = secili.reduce((a, [, n]) => a + n, 0);
  const { art, degis } = adetAyarla(setAdet);   // ortak adet kuralı (D6-R)
  // aynı kategori önerilende ve katalogda AYNI renk (D6-R)
  const ton = (k) => TONLAR[(k.id === BARDAK ? 0 : Math.max(0, katalog.findIndex((x) => x.id === k.id))) % 4];

  const sebepTamam = sebep && (sebep !== 'hazirlik_deneme' || hazirlik) && (sebep !== 'iade' || iadeSebep);
  const onayEksik = sebep === 'diger' && aciklama.trim().length < 10 ? 'Ne olduğunu en az 10 harfle yaz'
    : sebep === 'iade' && !fis.trim() ? 'Fiş numarasını yaz'
      : sebep === 'iade' && !/^\d{1,2}:\d{2}$/.test(iadeSaat) ? 'İade saatini gir' : '';
  const hazirlikAd = (d.hazirlik_turleri || []).find((x) => x.kod === hazirlik)?.ad;
  const iadeAd = (d.iade_sebepleri || []).find((x) => x.kod === iadeSebep)?.ad;

  const temizle = () => {
    setAdim(1); setSebep(''); setHazirlik(''); setIadeSebep(''); setAdet({}); setAciklama(''); setFis(''); setIadeSaat('');
    setMAd(''); setMTel(''); setAra(''); setIstek(yeniIstek()); taslakKaldir(anahtar);
  };
  const kaydet = async () => {
    if (mesgul) return;
    if (!/^\d{4}$/.test(pin)) { setHata('4 haneli PIN gir'); setOnay(1); return; }
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/fire`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, sebep, aciklama: aciklama.trim() || null,
        hazirlik_turu: sebep === 'hazirlik_deneme' ? hazirlik : null,
        iade: sebep === 'iade' ? { sebep: iadeSebep, fis_no: fis.trim(), iade_saat: iadeSaat, musteri_ad: mAd.trim() || null, musteri_tel: mTel.trim() || null } : null,
        kalemler: kalemGovde(Object.fromEntries(secili)) } });
      setOnay(0); setPin(''); setKisi('');
      temizle();
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : `✅ Fire kaydedildi — ${kalem} kalem / ${toplam} adet`, !!r.kuru);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setOnay(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') { setOnay(0); setPin(''); }
    }
    setMesgul(false);
  };

  const kisiAd = adaylar.find((p) => p.id === kisi)?.ad;
  const ADIMLAR = ['Sebep', 'Ürün', 'Onay'];

  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <Hero ikon="🔥" baslik="Fire Bildirimi" alt="Sebep → ürün → onay · Personel + PIN onayda istenir"
        zemin="linear-gradient(135deg,rgba(127,29,29,.8),rgba(239,68,68,.3))" cerceve="rgba(239,68,68,.4)" renk="#fca5a5" />
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — fire girilemez</div>}
      {/* adım çizgisi */}
      <div style={{ display: 'flex', gap: 6 }}>
        {ADIMLAR.map((a, i) => (
          <div key={a} style={{ flex: 1, padding: '8px 10px', borderRadius: 10, fontWeight: 800, textAlign: 'center',
            background: adim === i + 1 ? C.kirmizi : adim > i + 1 ? 'rgba(34,197,94,.25)' : C.bg2, color: adim === i + 1 ? '#fff' : C.yazi }}>
            {adim > i + 1 ? '✓' : i + 1} · {a}</div>))}
      </div>

      {adim === 1 && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 8 }}>
          {sebepler.map((x) => (
            <Kart kapali={kapali} key={x.kod} secik={sebep === x.kod} onClick={() => { setSebep(x.kod); if (x.kod !== 'hazirlik_deneme') setHazirlik(''); if (x.kod !== 'iade') setIadeSebep(''); }}>
              <span style={{ fontSize: 26 }}>{x.ikon}</span><b style={{ fontSize: 16 }}>{x.ad}</b>
            </Kart>))}
        </div>
        {sb?.not && <div className="sp-kart" style={{ color: C.sari, fontWeight: 700 }}>{sb.not}</div>}
        {sebep === 'hazirlik_deneme' && (
          <div className="sp-kart" style={{ display: 'grid', gap: 8 }}><b>Ne oldu?</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 8 }}>
              {(d.hazirlik_turleri || []).map((x) => <Kart kapali={kapali} key={x.kod} secik={hazirlik === x.kod} renk={C.sari} onClick={() => setHazirlik(x.kod)}><b>{x.ad}</b></Kart>)}
            </div></div>)}
        {sebep === 'iade' && (
          <div className="sp-kart" style={{ display: 'grid', gap: 8 }}><b>İade sebebi</b>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 8 }}>
              {(d.iade_sebepleri || []).map((x) => <Kart kapali={kapali} key={x.kod} secik={iadeSebep === x.kod} renk={C.sari} onClick={() => setIadeSebep(x.kod)}><b>{x.ad}</b></Kart>)}
            </div></div>)}
        <button className="sp-btn sp-ana" disabled={!sebepTamam || kapali} onClick={() => setAdim(2)}>Devam → ürün seç</button>
      </>)}

      {adim === 2 && (<>
        <div className="sp-kart" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 22 }}>{sb?.ikon}</span><b style={{ flex: 1 }}>{sb?.ad}{hazirlikAd ? ` · ${hazirlikAd}` : ''}{iadeAd ? ` · ${iadeAd}` : ''}</b>
          <button className="sp-btn" style={{ minHeight: 56 }} onClick={() => setAdim(1)}>« Sebebi değiştir</button>
        </div>
        {!kapali && <input className="sp-in" style={{ fontSize: 18 }} value={ara} onChange={(e) => setAra(e.target.value)} placeholder="🔎 Ürün ara (en az 2 harf)…" />}
        {aramaSonuc.length > 0 && (
          <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
            {aramaSonuc.map((u) => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontWeight: 700 }}>{u.ad} <span style={{ color: C.soluk, fontSize: 12 }}>{urunMap[u.id]?.kategori}</span></span>
                <AdetGirdi n={adet[u.id] || 0} azalt={() => art(u.id, -1)} artir={() => art(u.id, 1)} yaz={(v) => degis(u.id, v)} genislik={90} font={28} kapali={kapali} />
              </div>))}
          </div>)}
        {oneri.length > 0 && <b style={{ color: C.soluk, fontSize: 12 }}>BU SEBEP İÇİN ÖNERİLEN</b>}
        {oneri.length > 0 && <KategoriKartlari katalog={oneri} adet={adet} kapali={kapali} onSec={setAcikGrup} enAz={170} yukseklik={90} alt={aktifSay} ton={ton} />}
        <b style={{ color: C.soluk, fontSize: 12 }}>BÜTÜN KATALOG</b>
        <KategoriKartlari katalog={katalog} adet={adet} kapali={kapali} onSec={setAcikGrup} enAz={150} yukseklik={80} alt={aktifSay} ton={ton} />
        <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
          {kalem === 0 ? <span style={{ color: C.soluk }}>Henüz ürün seçilmedi</span> : secili.map(([id, n]) => (
            <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad} <span style={{ color: C.soluk }}>· {urunMap[id].kategori}</span></span><b>{n}</b></div>))}
        </div>
        <button className="sp-btn sp-ana" disabled={!kalem || kapali} onClick={() => setAdim(3)}>Devam → onay ({kalem} kalem · {toplam} adet)</button>
      </>)}

      {adim === 3 && (<>
        <div className="sp-kart" style={{ display: 'grid', gap: 6 }}>
          <b style={{ fontSize: 18 }}>{sb?.ikon} {sb?.ad}{hazirlikAd ? ` · ${hazirlikAd}` : ''}{iadeAd ? ` · ${iadeAd}` : ''}</b>
          {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
          <div style={{ display: 'flex', gap: 8 }}><button className="sp-btn" style={{ minHeight: 56 }} onClick={() => setAdim(2)}>« Ürünleri değiştir</button></div>
        </div>
        {sebep === 'iade' && (
          <div className="sp-kart" style={{ display: 'grid', gap: 8 }}>
            <b>↩️ Müşteri iadesi</b>
            <label style={{ display: 'grid', gap: 4 }}>Fiş numarası (zorunlu)<input className="sp-in" style={{ fontSize: 18 }} value={fis} onChange={(e) => setFis(e.target.value.slice(0, 40))} /></label>
            <label style={{ display: 'grid', gap: 4 }}>İade saati (zorunlu)<input className="sp-in" type="time" value={iadeSaat} onChange={(e) => setIadeSaat(e.target.value)} /></label>
            <label style={{ display: 'grid', gap: 4 }}>Müşteri adı (isteğe bağlı)<input className="sp-in" style={{ fontSize: 18 }} value={mAd} onChange={(e) => setMAd(e.target.value.slice(0, 80))} /></label>
            <label style={{ display: 'grid', gap: 4 }}>Müşteri telefonu (isteğe bağlı)<input className="sp-in" inputMode="tel" value={mTel} onChange={(e) => setMTel(e.target.value.replace(/[^\d+ ]/g, '').slice(0, 20))} /></label>
            <span style={{ color: C.soluk, fontSize: 12 }}>Müşteri bilgisi yalnız merkezde görünür.</span>
          </div>)}
        <label className="sp-kart" style={{ display: 'grid', gap: 4 }}>
          <span style={{ color: C.soluk, fontSize: 12, fontWeight: 700 }}>{sebep === 'diger' ? 'NE OLDU? (en az 10 harf)' : 'AÇIKLAMA (isteğe bağlı)'}</span>
          <input className="sp-in" style={{ fontSize: 16 }} value={aciklama} onChange={(e) => setAciklama(e.target.value.slice(0, 200))} placeholder="…" />
        </label>
        {onayEksik && <div style={{ color: C.sari, fontWeight: 700 }}>{onayEksik}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="sp-btn" onClick={temizle} disabled={mesgul}>✕ Vazgeç</button>
          <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={!!onayEksik || !kalem || kapali || mesgul} onClick={() => { setHata(''); setOnay(1); }}>Onayla — personel + PIN</button>
        </div>
      </>)}

      {/* grup penceresi: − adet + */}
      {g0 && (
        <Modal baslik={`${g0.emoji || '📦'} ${g0.kategori}`} kapat={() => setAcikGrup(null)} genislik={640}>
          {g0.urunler.filter((u) => u.aktif).map((u) => {
            const n = adet[u.id] || 0;
            return (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 10, background: n ? 'rgba(239,68,68,.12)' : C.bg2 }}>
                <span style={{ flex: 1, fontWeight: 700, fontSize: 16 }}>{u.ad} <span style={{ color: C.soluk, fontSize: 12, fontWeight: 500 }}>{u.birim}</span></span>
                <AdetGirdi n={n} azalt={() => art(u.id, -1)} artir={() => art(u.id, 1)} yaz={(v) => degis(u.id, v)} genislik={90} font={32} kapali={kapali} />
              </div>);
          })}
          <button className="sp-btn sp-yesil" onClick={() => setAcikGrup(null)}>Tamam</button>
        </Modal>
      )}

      {/* onay: kişi + PIN → özet → kaydet */}
      {onay > 0 && (
        <Modal baslik={onay === 1 ? '🔥 Fire onayı' : `🔥 ${toplam} adet fire kaydedilecek`} kapat={() => { setOnay(0); setPin(''); }}>
          {onay === 1 && <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim bildiriyor?"
            devam={() => { setHata(''); setOnay(2); }} />}
          {onay === 2 && (<>
            <div style={{ color: C.soluk }}>Bildiren: <b style={{ color: C.yazi }}>{kisiAd || '—'}</b></div>
            {!kisiAd && <div style={{ color: C.sari, fontWeight: 700 }}>Seçili kişi çıkış yapmış — geri dönüp adını yeniden seç</div>}
            <b>{sb?.ikon} {sb?.ad}{hazirlikAd ? ` · ${hazirlikAd}` : ''}{iadeAd ? ` · ${iadeAd}` : ''}</b>
            <div style={{ display: 'grid', gap: 4, maxHeight: '40vh', overflow: 'auto' }}>
              {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
            </div>
            {sebep === 'iade' && <div style={{ color: C.soluk }}>Fiş {fis} · {iadeSaat}</div>}
            {hata && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="sp-btn" disabled={mesgul} onClick={() => setOnay(1)}>« Geri</button>
              <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={mesgul || !kisiAd} onClick={kaydet}>{mesgul ? 'Gönderiliyor…' : '✓ Fireyi kaydet'}</button>
            </div>
          </>)}
        </Modal>
      )}
    </div>
  );
}
