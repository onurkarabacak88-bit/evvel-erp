// 🚚 DEPODAN GELEN — TESLİM AL (PANEL_YENIDEN_KURULUM.md §6 + "Basamak 5", sahip P3 2026-10-20). Eski panel AYNEN: paket kartları ·
// kalem kalem KÖR SAYIM (beklenen gösterilmez, kutular boş, − / +) · ilerleme çubuğu · QR'la içeride personel + PIN · "✓ Paketi kabul et".
// Ek (sahip P3): her kalemde "hasarlı" sayısı → merkez Depo'da fire / iade kararı. 0 da GERÇEK sayımdır ("hiç gelmedi").
// Gün kapalıyken de açık (D7). Eksik / fazla / hasarlı varsa personele RAKAM söylenmez — "merkeze iletildi" (kör kalır).
// Sunucu: evvel_yeni_panel_api.depodan_kabul → Depo kabul_yaz (tek işlem). Sök-tak: Depo modülü kapalıysa ekran "kapalı" der.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { C, Hero, KisiPin, Modal, ModulKapali, panelHata, taslakKaldir, taslakOku, taslakYaz, yeniIstek } from './ortak';
import { tarihNokta } from '../../utils/trTarih';

export default function DepodanGelen({ d, subeId, adaylar, bitti }) {
  const paketler = useMemo(() => d.depo_yolda || [], [d.depo_yolda]);
  const [secPid, setSecPid] = useState(null);
  const p = paketler.find((x) => x.parti_id === secPid) || null;
  const anahtar = p ? `sp_taslak:${subeId}:depo_kabul:${p.parti_id}` : null;
  const [say, setSay] = useState({});      // bag → {n, h}  (n = sağlam, h = hasarlı) — boş = sayılmadı
  const [istek, setIstek] = useState(yeniIstek);
  const [onay, setOnay] = useState(0);     // 0 · 1 kişi + PIN · 2 özet
  const [kisi, setKisi] = useState('');
  const [pin, setPin] = useState('');      // YALNIZ bellekte
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  useEffect(() => {   // paket değişince o paketin taslağı (yarım sayım kaybolmasın)
    if (!anahtar) return;
    const t = taslakOku(anahtar); setSay(t?.say || {}); setIstek(t?.istek || yeniIstek());
    setHata(''); setOnay(0); setPin(''); setKisi('');
  }, [anahtar]);
  useEffect(() => {
    if (!anahtar) return;
    taslakYaz(anahtar, { say, istek });
  }, [say, istek, anahtar]);
  useEffect(() => { if (secPid && !p) setSecPid(null); }, [secPid, p]);   // paket başka yerden kabul edildiyse

  if (d.depo_acik === false) {
    return <ModulKapali>🚚 Depo modülü kapalı — paket şu an kabul edilemiyor. Merkeze haber ver.</ModulKapali>;
  }
  const kalemler = p?.kalemler || [];
  const sayilan = kalemler.filter((k) => (say[k.bag]?.n ?? '') !== '').length;
  const yaz = (bag, alan, deger) => setSay((o) => ({ ...o, [bag]: { ...(o[bag] || {}), [alan]: deger === '' ? '' : Math.max(0, Math.min(99999, Number(deger) || 0)) } }));
  const art = (bag, dlt) => setSay((o) => { const n = o[bag]?.n; return { ...o, [bag]: { ...(o[bag] || {}), n: Math.max(0, (n === '' || n == null ? 0 : n) + dlt) } }; });
  const onayAc = () => {
    setHata('');
    if (sayilan < kalemler.length) { setHata(`Her ürünü say — ${kalemler.length - sayilan} ürün boş. Hiç gelmediyse 0 yaz.`); return; }
    setOnay(1);
  };
  const kaydet = async () => {
    if (mesgul) return;
    if (!/^\d{4}$/.test(pin)) { setHata('4 haneli PIN gir'); setOnay(1); return; }
    setMesgul(true); setHata('');
    try {
      const r = await api(`/evvel-yeni/panel/${encodeURIComponent(subeId)}/depodan-kabul`, { method: 'POST', body: {
        personel_id: kisi, pin, istek_id: istek, istemci_gunu: d.gun, parti_id: p.parti_id,
        satirlar: kalemler.map((k) => ({ bag: k.bag, sayilan: Number(say[k.bag]?.n || 0), hasarli: Number(say[k.bag]?.h || 0) })) } });
      taslakKaldir(anahtar);
      setOnay(0); setPin(''); setKisi(''); setSay({}); setSecPid(null);
      bitti(r.kuru ? `DENEME — ${r.mesaj || 'kaydedilmedi'}` : (r.mesaj || 'Paket kabul edildi') + (p.not ? ` · 📝 depo notu: ${p.not}` : ''), !!r.kuru);
    } catch (e) {
      // TEK hata kuralı (Dalga 5, F#54): internet · PIN · 409 'zaten' (farklı içerik → yeni istek, form durur)
      const t = panelHata(e, { setHata, pinSifirla: () => { setPin(''); setOnay(1); }, yeniIstekVer: () => setIstek(yeniIstek()) });
      if (t === 'internet') setHata('İnternet yok — bağlantı gelince yeniden gönder (saydıkların duruyor)');
      if (t === 'hata' && e?.status === 409) { setOnay(0); setPin(''); bitti(e?.message || 'Sayfa yenilendi', true); }   /* denetim: yeşil 'tamam' değil, sarı uyarı */   // Fable: gün değişti / paket düştü → yenile (taslak durur)
    }
    setMesgul(false);
  };

  return (
    <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
      <Hero ikon="🚚" baslik="Depodan Gelen — Teslim Al" alt="Merkezden gelen paketi aç · her ürünü SAY (beklenen gösterilmez) · Personel + PIN onayda istenir"
        zemin="linear-gradient(135deg,rgba(6,95,70,.75),rgba(16,185,129,.3))" cerceve="rgba(16,185,129,.35)" renk="#6ee7b7" />

      {!p && (paketler.length === 0
        ? <div className="sp-kart" style={{ color: C.soluk, fontWeight: 700, textAlign: 'center', padding: 24 }}>Bekleyen paket yok ✓</div>
        : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
          {paketler.map((x) => (
            <button key={x.parti_id} type="button" onClick={() => setSecPid(x.parti_id)} className="sp-kart"
              style={{ textAlign: 'left', cursor: 'pointer', display: 'grid', gap: 4, font: 'inherit', color: C.yazi }}>
              <b style={{ fontSize: 17 }}>📦 {x.nereden}</b>
              <span style={{ color: C.soluk, fontSize: 13 }}>{tarihNokta(x.gun)} · {x.kalemler.length} ürün{x.kalemler.length < x.toplam_kalem ? ` (${x.toplam_kalem - x.kalemler.length} kabul edildi)` : ''}</span>
              {/* R4-3 (sim 25 Eki · Opus): depocunun serbest notu ("5 süt") kör sayımı bozuyordu → not yalnız kabulden SONRA (onay mesajında) */}
              <span style={{ color: C.yesil, fontWeight: 800, marginTop: 4 }}>Aç ve say →</span>
            </button>
          ))}
        </div>)}

      {p && (
        <div className="sp-kart" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="sp-btn" style={{ minHeight: 40 }} onClick={() => setSecPid(null)}>« Paketler</button>
            <b style={{ fontSize: 17 }}>📦 {p.nereden} · {tarihNokta(p.gun)}</b>
          </div>
          <div style={{ height: 10, borderRadius: 999, background: C.bg3, overflow: 'hidden' }}>
            <div style={{ width: `${kalemler.length ? Math.round((sayilan / kalemler.length) * 100) : 0}%`, height: '100%', background: C.yesil, transition: 'width .2s' }} />
          </div>
          <div style={{ color: C.soluk, fontSize: 13 }}>{sayilan} / {kalemler.length} ürün sayıldı · Hiç gelmeyen ürüne 0 yaz · Kırık / bozuk geleni "hasarlı"ya yaz (sağlam sayıya katma)</div>
          {kalemler.map((k) => {
            const s = say[k.bag] || {};
            return (
              <div key={k.bag} style={{ display: 'grid', gap: 4, padding: 8, borderRadius: 10, background: (s.n ?? '') !== '' ? 'rgba(34,197,94,.1)' : C.bg2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 140, fontWeight: 700, fontSize: 16 }}>{k.ad}</span>
                  <button type="button" className="sp-pm" onClick={() => art(k.bag, -1)}>−</button>
                  <input className="sp-in" style={{ width: 96, textAlign: 'center', fontSize: 30, fontWeight: 800, padding: '4px 6px' }} inputMode="numeric"
                    value={s.n ?? ''} placeholder="?" onChange={(e) => yaz(k.bag, 'n', e.target.value.replace(/\D/g, ''))} />
                  <button type="button" className="sp-pm" onClick={() => art(k.bag, 1)}>+</button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.soluk, justifyContent: 'flex-end' }}>
                  💔 hasarlı <input className="sp-in" style={{ width: 70, textAlign: 'center' }} inputMode="numeric" value={s.h || ''} placeholder="0"
                    onChange={(e) => yaz(k.bag, 'h', e.target.value.replace(/\D/g, ''))} /></label>
              </div>
            );
          })}
          {hata && onay === 0 && <div style={{ color: C.kirmizi, fontWeight: 700 }}>{hata}</div>}
          <button className="sp-btn sp-yesil" disabled={mesgul} onClick={onayAc}>✓ Paketi kabul et</button>
        </div>
      )}

      {onay > 0 && p && (
        <Modal baslik={`🚚 ${p.nereden} · ${kalemler.length} ürün`} kapat={() => { setOnay(0); setPin(''); }}>
          {/* TEK pencere — özet + kişi + PIN + kabul (sahip 23 Eki, G23) */}
          <div style={{ display: 'grid', gap: 4, maxHeight: '30vh', overflow: 'auto' }}>
            {kalemler.map((k) => <div key={k.bag} style={{ display: 'flex', gap: 8 }}><span style={{ flex: 1 }}>{k.ad}</span>
              <b>{Number(say[k.bag]?.n || 0)}</b>{Number(say[k.bag]?.h || 0) > 0 && <span style={{ color: C.sari }}>💔 {say[k.bag].h}</span>}</div>)}
          </div>
          <KisiPin adaylar={adaylar} kisi={kisi} setKisi={setKisi} pin={pin} setPin={setPin} hata={hata} soru="Kim saydı / teslim aldı?"
            devam={kaydet} devamYazi="✓ Paketi kabul et" mesgul={mesgul} />   {/* ortak Kişi + PIN (Dalga 5, F#48) */}
        </Modal>
      )}
    </div>
  );
}
