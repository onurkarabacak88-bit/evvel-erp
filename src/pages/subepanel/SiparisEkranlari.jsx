// 🛒 SİPARİŞ VER · 📊 SİPARİŞ TAKİP · 📤 GÖNDERİLECEK (PANEL_YENIDEN_KURULUM.md §7–9 + "S5", sahip D1–D4 2026-10-20).
// Eski panel AYNEN (sade): kategori kartları → ürün (− adet +, koli yardımcısı) · ürünün yanında "⏳ bekliyor / 🚚 yolda" (ADETSİZ — kör sayım)
// · katalogda olmayan ürün = öneri (D4) · not · QR'la içeride personel + PIN → gönder. Takip: son 21 gün, 4 adım (Talep → Yönlendirme →
// Sevk → Kabul), sevk/kabul ADEDİ GÖSTERİLMEZ. Gönderilecek (yalnız merkez depo şubesi): kalem kalem VAR / KISMİ / YOK → "Hazırlığı kaydet"
// ya da "🚚 Yola çıkar" (kısmi → kalan merkeze döner). Sunucu: evvel_yeni_panel_api (/siparis, /siparisler, /gonderilecek) → Sipariş modülü.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { adetAyarla, AdetGirdi, C, Hero, KategoriKartlari, KisiPin, Modal, ModulKapali, panelHata, sor, taslakKaldir, taslakOku, taslakYaz, yeniIstek, panelOku } from './ortak';
import { tarihNokta } from '../../utils/trTarih';

const DURUM = {
  oneri: ['💡 merkez kararı bekliyor', C.sari], yonlendirilmedi: ['⏳ merkez bakıyor', C.sari], hazirlaniyor: ['📦 hazırlanıyor', C.mavi],
  bekleniyor: ['🚚 toptancıdan bekleniyor', C.mavi], yolda: ['🚚 yolda', C.mavi], karsilandi: ['✓ teslim alındı · merkez kontrolünde', C.yesil]   /* M2 + Codex C (24 Eki): eksik gelen de "✓ geldi" görünüyordu; 'eksik' demek de sızdırır → herkese aynı dürüst yazı */, iptal: ['iptal', C.soluk],
};
const tarih = tarihNokta;   // gün yazımı TEK kaynak (F#65)

export function useSiparisler(subeId) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const yukle = useCallback(async () => {
    try { setV(await panelOku(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/siparisler`)); setHata(''); }
    catch (e) { setHata(e?.message || 'Siparişler okunamadı'); }
  }, [subeId]);
  useEffect(() => { yukle(); }, [yukle]);
  return [v, hata, yukle];
}

function Kapali() {
  return <ModulKapali>🛒 Sipariş modülü kapalı — merkeze haber ver.</ModulKapali>;
}

// ─────────────────────────── 🛒 SİPARİŞ VER ───────────────────────────
export function SiparisVer({ d, subeId, adaylar, kapali, bitti }) {
  const anahtar = `sp_taslak:${subeId}:${d.gun}:siparis`;
  const ilk = useMemo(() => { return taslakOku(anahtar) }, [anahtar]);
  const [v, , yukle] = useSiparisler(subeId);
  const [adet, setAdet] = useState(ilk?.adet || {});
  const [oneri, setOneri] = useState(ilk?.oneri || []);      // [{ad, adet}] katalog dışı (D4)
  const [not, setNot] = useState(ilk?.not || '');
  const [istek, setIstek] = useState(() => ilk?.istek || yeniIstek());
  const [acikKat, setAcikKat] = useState(null);
  const [onAd, setOnAd] = useState('');
  const [onAdet, setOnAdet] = useState('');
  const [onay, setOnay] = useState(0);
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  useEffect(() => { taslakYaz(anahtar, { adet, oneri, not, istek }); }, [adet, oneri, not, istek, anahtar]);
  const katalog = useMemo(() => (d.ac_katalog || []).map((k) => ({ ...k, urunler: k.urunler.filter((u) => u.aktif) })).filter((k) => k.urunler.length), [d.ac_katalog]);
  const urunMap = useMemo(() => Object.fromEntries(katalog.flatMap((k) => k.urunler.map((u) => [u.id, u]))), [katalog]);
  const secili = Object.entries(adet).filter(([id, n]) => n > 0 && urunMap[id]);
  const rozet = v?.rozet || {};
  const acikSayi = (v?.siparisler || []).filter((s) => s.durum === 'acik').length;
  if (d.siparis_acik === false) return <Kapali />;
  const { degis } = adetAyarla(setAdet);   // ortak adet kuralı (D6-R)
  const temizle = () => { setAdet({}); setOneri([]); setNot(''); setIstek(yeniIstek()); taslakKaldir(anahtar); };
  const oneriEkle = () => {
    const a = parseInt(onAdet, 10);
    if (onAd.trim().length < 2 || !(a > 0)) { setHata('Katalogda olmayan ürünün adını ve adedini yaz'); return; }
    setOneri((o) => [...o, { ad: onAd.trim().slice(0, 80), adet: a }]); setOnAd(''); setOnAdet(''); setHata('');
  };
  const onayAc = () => { setHata(''); if (!secili.length && !oneri.length) { setHata('En az bir ürün seç'); return; } setOnay(1); };
  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/siparis`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, notu: not.trim() || null,
        kalemler: [...secili.map(([urun_id, n]) => ({ urun_id, adet: n })), ...oneri.map((o) => ({ ad: o.ad, adet: o.adet }))] } });
      setOnay(0); setPin(''); setKisi(''); temizle(); yukle();
      bitti(r.mesaj || 'Sipariş gönderildi', false);
    } catch (e) {
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setOnay(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'farkli') { setOnay(0); setPin(''); }
    }
    setMesgul(false);
  };
  const k0 = katalog.find((k) => k.id === acikKat);
  const RozetU = ({ id }) => (rozet[id] ? <span style={{ fontSize: 12, fontWeight: 800, color: rozet[id] === 'yolda' ? C.mavi : C.sari }}>{rozet[id] === 'yolda' ? '🚚 yolda' : '⏳ bekliyor'}</span> : null);
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <Hero ikon="🛒" baslik="Sipariş Ver" alt={<>Ürün seç · adet yaz · Personel + PIN onayda istenir{acikSayi ? ` · ${acikSayi} siparişin hâlâ açık (Sipariş Takip)` : ''}</>}
        zemin="linear-gradient(135deg,rgba(120,53,15,.75),rgba(245,158,11,.3))" cerceve="rgba(245,158,11,.35)" renk="#fcd34d" />
      {kapali && <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700 }}>🔒 Gün kapandı — sipariş verilemez</div>}
      <div className="sp-teslim" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(260px,340px)', gap: 12, alignItems: 'start' }}>
        <KategoriKartlari katalog={katalog} adet={adet} kapali={kapali} onSec={setAcikKat} />
        <div className="sp-kart sp-sayi-kart" style={{ display: 'grid', gap: 10, position: 'sticky', top: 0 }}>
          <div style={{ display: 'grid', gap: 4, maxHeight: 240, overflow: 'auto' }}>
            {!secili.length && !oneri.length ? <span style={{ color: C.soluk }}>Henüz ürün seçilmedi</span> : (<>
              <b style={{ color: C.yesil }}>{secili.length + oneri.length} kalem</b>
              {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8, fontSize: 14 }}><span style={{ flex: 1 }}>{urunMap[id].ad}</span><b>{n}</b></div>)}
              {oneri.map((o, i) => <div key={`o${i}`} style={{ display: 'flex', gap: 8, fontSize: 14, color: C.sari }}><span style={{ flex: 1 }}>💡 {o.ad}</span><b>{o.adet}</b>
                <button type="button" className="sp-btn sp-orta" aria-label="Öneriyi kaldır" onClick={() => setOneri((x) => x.filter((_, j) => j !== i))}>✕</button></div>)}
            </>)}
          </div>
          <div style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 10, border: `1px dashed ${C.cizgi}` }}>
            <span style={{ fontSize: 13, color: C.soluk }}>💡 Katalogda yok mu? Yaz — merkez karar verir</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="sp-in" style={{ flex: 1, minWidth: 0, fontSize: 15 }} placeholder="Ürün adı" value={onAd} onChange={(e) => setOnAd(e.target.value.slice(0, 80))} disabled={kapali} />
              <input className="sp-in" style={{ width: 70, textAlign: 'center' }} inputMode="numeric" placeholder="adet" value={onAdet} onChange={(e) => setOnAdet(e.target.value.replace(/\D/g, '').slice(0, 5))} disabled={kapali} />
              <button type="button" className="sp-btn sp-orta" onClick={oneriEkle} disabled={kapali}>+</button>
            </div>
          </div>
          <label style={{ display: 'grid', gap: 4 }}><span style={{ color: C.soluk, fontSize: 12, fontWeight: 700 }}>NOT (isteğe bağlı)</span>
            <input className="sp-in" style={{ fontSize: 16 }} value={not} onChange={(e) => setNot(e.target.value.slice(0, 300))} placeholder="ör. hafta sonu için" /></label>
          {hata && onay === 0 && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-yesil" disabled={kapali || mesgul} onClick={onayAc}>🛒 Siparişi gönder</button>
          {(secili.length > 0 || oneri.length > 0) && <button type="button" className="sp-btn sp-orta" onClick={async () => (await sor({ soru: 'Sipariş formu temizlensin mi?', alt: 'Seçtiğin ürünler ve adetler silinir.', tamam: 'Evet, temizle', iptal: 'Vazgeç' })) && temizle()}>✕ Formu temizle</button>}
        </div>
      </div>
      {k0 && (
        <Modal baslik={`${k0.emoji || '📦'} ${k0.kategori}`} kapat={() => setAcikKat(null)} genislik={680}>
          {k0.urunler.map((u) => {
            const n = adet[u.id] || 0;
            const ki = Number(u.koli_ici || 0);
            return (
              <div key={u.id} style={{ display: 'grid', gap: 4, padding: 6, borderRadius: 10, background: n ? 'rgba(34,197,94,.1)' : C.bg2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, fontWeight: 700, fontSize: 16 }}>{u.ad} <span style={{ color: C.soluk, fontSize: 12, fontWeight: 500 }}>{u.birim}</span> <RozetU id={u.id} /></span>
                  <AdetGirdi n={n} azalt={() => degis(u.id, n - 1)} artir={() => degis(u.id, n + 1)} genislik={96} font={30}
                    yaz={(v) => degis(u.id, v)} />   {/* ortak − adet + (F#51) */}
                </div>
                {ki > 1 && <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {[1, 2, 3].map((x) => <button key={x} type="button" className="sp-btn sp-orta" style={{ padding: '0 10px', fontSize: 13 }} onClick={() => degis(u.id, n + x * ki)}>+{x} koli ({x * ki})</button>)}
                </div>}
              </div>
            );
          })}
          <button className="sp-btn sp-yesil" onClick={() => setAcikKat(null)}>Tamam</button>
        </Modal>
      )}
      {onay > 0 && (
        <Modal baslik={`🛒 ${secili.length + oneri.length} çeşit sipariş`} kapat={() => { setOnay(0); setPin(''); }}>
          {/* TEK pencere — özet + kişi + PIN + gönder (sahip 23 Eki, G23) */}
          <div style={{ display: 'grid', gap: 4, maxHeight: '30vh', overflow: 'auto' }}>
            {secili.map(([id, n]) => <div key={id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{urunMap[id].ad} <RozetU id={id} /></span><b>{n}</b></div>)}
            {oneri.map((o, i) => <div key={`o${i}`} style={{ display: 'flex', gap: 8, color: C.sari }}><span style={{ flex: 1 }}>💡 {o.ad} (katalog dışı)</span><b>{o.adet}</b></div>)}
          </div>
          {secili.some(([id]) => rozet[id]) && <div style={{ color: C.sari, fontSize: 13 }}>⏳ İşaretli ürünler zaten bekliyor / yolda — yine de istiyorsan gönder.</div>}
          {not.trim() && <div style={{ color: C.soluk }}>Not: {not.trim()}</div>}
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim sipariş veriyor?"
            devam={kaydet} devamYazi="🛒 Siparişi gönder" mesgul={mesgul} />
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────── 📊 SİPARİŞ TAKİP (KÖR: sevk / kabul adedi yok) ───────────────────────────
export function SiparisTakip({ d, subeId, adaylar, bitti }) {
  const [v, hata, yukle] = useSiparisler(subeId);
  const [filtre, setFiltre] = useState('acik');
  const [geri, setGeri] = useState(null);   // geri çekilecek sipariş
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [hataG, setHataG] = useState('');
  if (d.siparis_acik === false) return <Kapali />;
  const liste = (v?.siparisler || []).filter((s) => filtre === 'hepsi' || (filtre === 'acik' ? s.durum === 'acik' : s.durum !== 'acik'));
  const adim = (s) => {
    const ks = s.kalemler.filter((k) => k.durum !== 'iptal');
    if (s.durum === 'tamamlandi') return 4;
    if (ks.some((k) => ['yolda', 'karsilandi'].includes(k.durum))) return 3;
    if (ks.some((k) => ['hazirlaniyor', 'bekleniyor'].includes(k.durum))) return 2;
    return 1;
  };
  const geriCek = async () => {
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/siparis/${encodeURIComponent(geri.id)}/iptal`, { method: 'POST',
        body: { personel_id: kisi, pin, istek_id: yeniIstek(), istemci_gunu: d.gun } });
      setGeri(null); setPin(''); setKisi(''); yukle(); bitti(r.mesaj || 'Geri çekildi', false);
    } catch (e) { setHataG(e?.message || 'Geri çekilemedi'); setPin(''); }
  };
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <div className="sp-kart" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 28 }}>📊</span><b style={{ fontSize: 18, flex: 1 }}>Sipariş Takip <span style={{ color: C.soluk, fontSize: 13, fontWeight: 500 }}>· son 21 gün</span></b>
        {[['acik', 'Açık'], ['bitti', 'Tamamlanan'], ['hepsi', 'Hepsi']].map(([k, a]) => (
          <button key={k} type="button" className={'sp-btn sp-orta' + (filtre === k ? ' sp-ana' : '')} onClick={() => setFiltre(k)}>{a}</button>))}
        <button type="button" className="sp-btn sp-orta" onClick={yukle}>↻</button>
      </div>
      {hata && <div className="sp-kart" style={{ color: C.kirmizi }}>{hata}</div>}
      {!v ? <div style={{ color: C.soluk }}>Okunuyor…</div> : liste.length === 0 ? <div className="sp-kart" style={{ color: C.soluk, textAlign: 'center', padding: 24 }}>Sipariş yok</div> : liste.map((s) => {
        const a = adim(s);
        return (
          <div key={s.id} className="sp-kart" style={{ display: 'grid', gap: 8, opacity: s.durum === 'iptal' ? 0.55 : 1 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>{tarih(s.gun)}</b><span style={{ color: C.soluk }}>{s.kim}</span>
              {s.deneme && <span style={{ color: C.sari, fontSize: 12, fontWeight: 800 }}>🧪 deneme</span>}
              <span style={{ flex: 1 }} />
              {s.durum === 'iptal' ? <b style={{ color: C.soluk }}>iptal · {s.iptal_sebep}</b> : s.durum === 'tamamlandi' ? <b style={{ color: C.yesil }}>✓ tamamlandı</b> : null}
              {s.durum === 'acik' && s.kalemler.every((k) => k.durum === 'yonlendirilmedi' || k.durum === 'oneri') &&
                <button type="button" className="sp-btn sp-orta" onClick={() => { setGeri(s); setHataG(''); }}>Geri çek</button>}
            </div>
            {s.durum !== 'iptal' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4 }}>
              {['Talep', 'Yönlendirme', 'Sevk / toptancı', 'Geldi'].map((t, i) => (
                <div key={t} style={{ textAlign: 'center', fontSize: 12, fontWeight: 800, padding: '4px 2px', borderRadius: 8, background: i < a ? 'rgba(34,197,94,.25)' : C.bg3, color: i < a ? C.yesil : C.soluk }}>{t}</div>))}
            </div>}
            <div style={{ display: 'grid', gap: 3 }}>
              {s.kalemler.map((k) => (
                <div key={k.i} style={{ display: 'flex', gap: 8, fontSize: 14, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1 }}>{k.oneri ? '💡 ' : ''}{k.ad}</span><b>{k.adet}</b>
                  <span style={{ width: 190, textAlign: 'right', color: (DURUM[k.durum] || [])[1] || C.soluk, fontWeight: 700 }}>{(DURUM[k.durum] || [k.durum])[0]}</span>
                  {(k.yonler || []).length > 1 && (   // B21: bölünmüş kalem — her kaynağın durumu ayrı (adet yok: kör sayım)
                    <div style={{ flexBasis: '100%', paddingLeft: 12, fontSize: 12.5, color: C.soluk }}>
                      {k.yonler.map((y) => `${y.kaynak_ad} · ${(DURUM[y.durum] || [y.durum])[0]}`).join('  |  ')}
                    </div>)}
                </div>))}
            </div>
            {s.notu && <div style={{ color: C.soluk, fontSize: 13 }}>📝 {s.notu}</div>}
          </div>
        );
      })}
      {geri && (
        <Modal baslik="Siparişi geri çek" kapat={() => { setGeri(null); setPin(''); }}>
          <div style={{ color: C.soluk }}>{tarih(geri.gun)} · {geri.kalemler.length} kalem — merkez henüz yönlendirmedi.</div>
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hataG} devam={geriCek} devamYazi="Geri çek" />
        </Modal>
      )}
    </div>
  );
}

// ─────────────────────────── 📤 GÖNDERİLECEK (yalnız merkez depo şubesi — Tema) ───────────────────────────
export function Gonderilecek({ d, subeId, adaylar, bitti }) {
  const [v, hata, yukle] = useSiparisler(subeId);
  const [hedef, setHedef] = useState(null);
  const [sec, setSec] = useState({});      // yon_id → {tur: 'var'|'kismi'|'yok', n}
  const [onay, setOnay] = useState(null);  // 'hazirlik' | 'yola'
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');
  const [istek, setIstek] = useState(yeniIstek);
  const [mesgul, setMesgul] = useState(false);
  const [hataG, setHataG] = useState('');
  const gruplar = useMemo(() => v?.gonderilecek || [], [v]);
  const g = gruplar.find((x) => x.hedef === hedef) || null;
  useEffect(() => {   // grup açılınca kayıtlı hazırlık seçimlere yansır
    if (!g) return;
    setSec(Object.fromEntries(g.kalemler.map((k) => [k.yon_id, k.hazir == null ? {} : k.hazir >= k.adet ? { tur: 'var', n: k.adet } : k.hazir === 0 ? { tur: 'yok', n: 0 } : { tur: 'kismi', n: k.hazir }])));
    setIstek(yeniIstek());
  }, [g?.hedef]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (d.siparis_acik === false) return <Kapali />;
  const adetOf = (k) => { const s = sec[k.yon_id] || {}; return s.tur === 'var' ? k.adet : s.tur === 'yok' ? 0 : s.tur === 'kismi' ? Number(s.n || 0) : null; };
  // Sahip 26 Eki: seçimsiz → ENGEL (sayı belirsiz, depodan düşüm bozulur) · istenenden FAZLA → ENGEL + açık bildirim · kısmi (az) SERBEST
  // (KISMİ 0 = YOK gibi, KISMİ = istenen = VAR gibi gider — eskiden "1 ile istenen arasında olmalı" diye kilitliyordu)
  const kismiBosMu = (k) => sec[k.yon_id]?.tur === 'kismi' && (sec[k.yon_id]?.n ?? '') === '';
  const fazlaMi = (k) => adetOf(k) != null && adetOf(k) > k.adet;
  const eksikSecim = g ? g.kalemler.filter((k) => adetOf(k) == null || kismiBosMu(k) || fazlaMi(k)).length : 0;
  const gonder = async () => {
    if (mesgul) return;
    setMesgul(true); setHataG('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/gonderilecek`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, hedef: g.hedef, yola_cik: onay === 'yola',
        satirlar: g.kalemler.map((k) => ({ yon_id: k.yon_id, siparis_id: k.siparis_id, surum: k.surum, hazir: adetOf(k), gonderilen: onay === 'yola' ? adetOf(k) : null })) } });
      setOnay(null); setPin(''); setKisi(''); if (onay === 'yola') setHedef(null); yukle();
      bitti(r.kuru && onay === 'yola' ? `DENEME — ${r.mesaj}` : (r.mesaj || 'Kaydedildi'), !!(r.kuru && onay === 'yola'));
    } catch (e) {
      setHataG(e?.message || 'Kaydedilemedi');
      if (e?.status === 403 || e?.status === 429) setPin('');
      if (e?.status === 409) { setOnay(null); yukle(); }
    }
    setMesgul(false);
  };
  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <div className="sp-kart" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 28 }}>📤</span>
        <div style={{ flex: 1 }}><b style={{ fontSize: 18 }}>Gönderilecek Siparişler</b>
          <div style={{ color: C.soluk, fontSize: 13 }}>Merkezin depoya yönlendirdiği kalemler · VAR / KISMİ / YOK işaretle → Hazırlığı kaydet ya da 🚚 Yola çıkar</div></div>
        <button type="button" className="sp-btn sp-orta" onClick={yukle}>↻</button>
      </div>
      {hata && <div className="sp-kart" style={{ color: C.kirmizi }}>{hata}</div>}
      {!g && (!v ? <div style={{ color: C.soluk }}>Okunuyor…</div> : gruplar.length === 0 ? <div className="sp-kart" style={{ color: C.soluk, textAlign: 'center', padding: 24 }}>Gönderilecek sipariş yok ✓</div> :
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
          {gruplar.map((x) => (
            <button key={x.hedef} type="button" className="sp-kart" onClick={() => setHedef(x.hedef)} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: C.yazi, display: 'grid', gap: 4 }}>
              <b style={{ fontSize: 17 }}>🏪 {x.hedef_ad}</b>
              <span style={{ color: C.soluk, fontSize: 13 }}>{x.kalemler.length} kalem{x.kalemler.some((k) => k.hazir != null) ? ' · hazırlık başladı' : ''}{x.deneme ? ' · 🧪 deneme' : ''}</span>
              <span style={{ color: C.yesil, fontWeight: 800 }}>Hazırla →</span>
            </button>))}
        </div>)}
      {g && (
        <div className="sp-kart" style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button type="button" className="sp-btn sp-orta" onClick={() => setHedef(null)}>« Şubeler</button>
            <b style={{ fontSize: 17 }}>🏪 {g.hedef_ad} — {g.kalemler.length} kalem</b>
          </div>
          {g.kalemler.map((k) => {
            const s = sec[k.yon_id] || {};
            const t = (tur, n) => setSec((o) => ({ ...o, [k.yon_id]: { tur, n } }));
            return (
              // D2 (sim 24 Eki): KISMİ seçilince kutu araya giriyor, YOK alt satıra iniyordu → sabit ızgara, kutu yeri hep ayrılı (yanlış dokunma)
              <div key={k.yon_id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto 80px auto', gap: 8, alignItems: 'center', padding: 8, borderRadius: 10, background: s.tur ? 'rgba(34,197,94,.08)' : C.bg2 }}>
                <span style={{ minWidth: 0, fontWeight: 700, fontSize: 16 }}>{k.ad} <span style={{ color: C.soluk }}>× {k.adet}</span></span>
                <button type="button" className={'sp-btn sp-orta' + (s.tur === 'var' ? ' sp-yesil' : '')} onClick={() => t('var', k.adet)}>VAR</button>
                <button type="button" className={'sp-btn sp-orta' + (s.tur === 'kismi' ? ' sp-ana' : '')} onClick={() => t('kismi', '')}>KISMİ</button>
                <input className="sp-in" style={{ width: 80, textAlign: 'center', fontSize: 20, visibility: s.tur === 'kismi' ? 'visible' : 'hidden' }} inputMode="numeric" placeholder="kaç?" value={s.n ?? ''}
                  tabIndex={s.tur === 'kismi' ? 0 : -1} onChange={(e) => t('kismi', e.target.value.replace(/\D/g, '').slice(0, 5))} />
                <button type="button" className={'sp-btn sp-orta' + (s.tur === 'yok' ? ' sp-ana' : '')} onClick={() => t('yok', 0)}>YOK</button>
              </div>
            );
          })}
          {(() => {   // G28 (sim 23 Eki): hiçbir şeye basmadan turuncu uyarı çıkıyordu → seçilmemiş = sakin sayaç, sarı yalnız geçersiz KISMİ
            const secilmedi = g.kalemler.filter((k) => !sec[k.yon_id]?.tur).length;
            const kismiBos = g.kalemler.filter((k) => sec[k.yon_id]?.tur === 'kismi' && (sec[k.yon_id]?.n ?? '') === '').length;   // henüz yazılmadı → sakin ipucu
            const fazla = g.kalemler.find(fazlaMi);
            // D2: ipucu TEK satırda, yeri hep ayrılı — yazı değişse de alttaki düğmeler kaymaz
            const ipucu = fazla ? [`${fazla.ad}: istenen ${fazla.adet}, ${adetOf(fazla)} yazdın — istenenden fazla gönderilemez`, C.kirmizi]
              : kismiBos > 0 ? ['KISMİ seçtiğin kaleme kaç tane gönderdiğini yaz', C.soluk]
                : secilmedi > 0 ? [`Her kaleme VAR / KISMİ / YOK seç — ${g.kalemler.length - secilmedi}/${g.kalemler.length} seçildi`, C.soluk]
                  : [`Hepsi seçildi ✓ — ${g.kalemler.length}/${g.kalemler.length}`, C.yesil];
            return <div style={{ color: ipucu[1], fontSize: 13, fontWeight: fazla ? 700 : 400, minHeight: 20 }}>{ipucu[0]}</div>;
          })()}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="sp-btn" style={{ flex: 1 }} disabled={g.kalemler.some(fazlaMi)} onClick={() => { setHataG(''); setOnay('hazirlik'); }}>💾 Hazırlığı kaydet</button>
            <button className="sp-btn sp-yesil" style={{ flex: 1 }} disabled={eksikSecim > 0} onClick={() => { setHataG(''); setOnay('yola'); }}>🚚 Yola çıkar</button>
          </div>
        </div>
      )}
      {onay && g && (
        <Modal baslik={onay === 'yola' ? `🚚 ${g.hedef_ad} — yola çıkar` : '💾 Hazırlığı kaydet'} kapat={() => { setOnay(null); setPin(''); }}>
          {onay === 'yola' && <div style={{ display: 'grid', gap: 3, maxHeight: '30vh', overflow: 'auto' }}>
            {g.kalemler.map((k) => <div key={k.yon_id} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{k.ad}</span>
              <b style={{ color: adetOf(k) === 0 ? C.kirmizi : adetOf(k) < k.adet ? C.sari : C.yesil }}>{adetOf(k) === 0 ? 'YOK' : `${adetOf(k)} / ${k.adet}`}
                {adetOf(k) > 0 && adetOf(k) < k.adet ? ` · ${k.adet - adetOf(k)} eksik` : ''}</b></div>)}
            {g.kalemler.some((k) => adetOf(k) < k.adet) && <div style={{ fontSize: 12.5, color: C.sari }}>Eksik / YOK kalan merkeze döner — merkez başka yerden tamamlar.</div>}
          </div>}
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hataG} soru="Kim hazırladı?" devam={gonder}
            devamYazi={mesgul ? 'Gönderiliyor…' : onay === 'yola' ? '🚚 Yola çıkar' : '💾 Kaydet'} />
        </Modal>
      )}
    </div>
  );
}
