// 🛒 SİPARİŞ YÖNLENDİRME — tak-çıkar modül (sunucu: evvel_yeni_siparis_api.py, S5c). Şube panelinden "Sipariş ver" ile gelen talep
// burada kalem kalem yönlendirilir: merkez DEPO (Sevk → Depodan gelen) ya da TOPTANCI (şube Tedarikçiden teslim al'da karşılar).
// Bölünebilir (5 depodan + 5 toptancıdan). Stok / borç YAZMAZ — yalnız "nereden gelecek" kararı. Katalog dışı öneri → ürüne bağla / reddet.
// Eksik karşılanan kalem → sebep yazıp kapat. Yola çıkmış / teslime bağlanmış satır değişmez (sunucu da reddeder).
// Ortak parçalar KasaModulu'ndan (PI_CSS, R, kart, Dugme, Cip) — yeni stil yazılmaz. Listeler: kendi ucu /siparis/liste (aktif toptancılar — Ödeme izni olmayan müdür de görür, sahip 1 Kas) + /urun/katalog.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { ALAN, Cip, Dugme, kart, num, PI_CSS, R, sayfayaGit, sor, tKisa } from './KasaModulu';

export const SIPARIS_SAYFALAR = [{ id: 'siparis_yon', ad: 'Sipariş yönlendirme', alt: 'Şube talepleri → depo / toptancı' }];
const alan = { ...ALAN, padding: '5px 8px', borderRadius: 8, fontSize: 13 };   // temel stil KasaModulu ALAN (T4-15)
const DURUM = {
  yonlendirilmedi: ['Yönlendirilmedi', 'kirmizi'], hazirlaniyor: ['Depoda hazırlanıyor', 'sari'], bekleniyor: ['Toptancıdan bekleniyor', 'sari'],
  yolda: ['Yolda', 'bakir'], karsilandi: ['Karşılandı', 'yesil'], oneri: ['Katalog dışı öneri', 'kirmizi'], iptal: ['İptal', undefined],
};
const kilitli = (y) => !['hazirlaniyor', 'bekleniyor'].includes(y.durum);   // yola çıkmış / teslime bağlanmış → değişmez
// sahip 2 Kas ("bu iki kalem çok altta kalmış, üste çek"): uzun siparişte iş bekleyen kalem dipte kayboluyordu →
// önce yönlendirilmemiş, sonra toptancıdan beklenen, sonra depo / yolda, en son gelen ve iptal (aynı grupta şubenin sırası korunur)
const SIRA = (k) => (k.durum === 'yonlendirilmedi' || k.durum === 'oneri' ? 0 : k.durum === 'iptal' ? 4 : k.durum === 'karsilandi' ? 3
  : k.yonler.some((y) => y.durum === 'bekleniyor') ? 1 : 2);
const YONSUZ_SAAT = 24;   // sunucuyla aynı (evvel_yeni_siparis_api.YONSUZ_SAAT) — aşınca sekme sayısı kırmızı
const yonBekliyor = (s) => s.kalemler.some((k) => k.durum === 'yonlendirilmedi' || k.durum === 'oneri');
const saatOnce = (z) => (z ? (Date.now() - new Date(z).getTime()) / 3600000 : 0);
const sureYazi = (z) => { const sa = saatOnce(z); return !z ? '' : sa < 1 ? `${Math.max(1, Math.round(sa * 60))} dk önce` : sa < 24 ? `${Math.round(sa)} sa önce` : `${Math.floor(sa / 24)} gün önce`; };
const kisaAd = (ad) => String(ad || '').replace(/ deposu$/i, '');
const kaynakOzet = (s) => [...new Set(s.kalemler.flatMap((k) => k.yonler.filter((y) => y.durum !== 'iptal').map((y) => y.kaynak_ad)))].join(' + ') || 'yönlendirilmedi';
// iki ekran (sahip 2 Kas: "PC'de de zor, yalnız telefon düşünülmesin"): geniş ekranda kalem satırı tablo hizası, dar ekranda (≤860 px, yan menü dahil) iki satır; kaydet çubuğu altta sabit
const SY_CSS = `
.sy .sy-kalem{border-top:1px solid var(--pi-line);padding-top:7px;display:grid;gap:5px}
.sy .sy-satir{display:grid;grid-template-columns:minmax(150px,1.4fr) 48px minmax(140px,1.3fr) minmax(150px,1.4fr) auto;gap:8px;align-items:center}
.sy .sy-adet{text-align:right}
.sy .sy-nereden{font-size:12.5px;color:var(--pi-ink2)}
.sy .sy-durum{display:flex;gap:4px;flex-wrap:wrap}
.sy .sy-islem{display:flex;gap:4px;justify-content:flex-end}
.sy .sy-iz{font-size:12px;color:var(--pi-ink3);padding-left:12px}
.sy .sy-ozet{font-size:12.5px;color:var(--pi-ink2);cursor:pointer}
.sy .sy-say{display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;color:#fff;font-size:11px;text-align:center}
.sy .sy-bilgi{border:0;background:none;color:var(--pi-ink3);cursor:pointer;font-size:14px;padding:0 2px}
.sy .sy-cubuk{position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;padding:10px 12px;background:var(--pi-paper,#fbf7f1);border-top:1px solid var(--pi-line);box-shadow:0 -4px 14px rgba(0,0,0,.08)}
@media (max-width:860px){
  .sy .sy-satir{grid-template-columns:1fr auto;row-gap:3px}
  .sy .sy-nereden{grid-column:1/2}
  .sy .sy-durum{grid-column:1/3}
  .sy .sy-islem{grid-column:2/3;grid-row:2/3}
}`;

export default function SiparisModulu({ onToast }) {
  const [sekme, setSekme] = useState('yon');   // yon | yolda | gecmis
  const [v, setV] = useState(null);            // açık siparişler (iki sekmenin ortak kaynağı — sekme istemcide süzülür)
  const [g, setG] = useState(null);            // geçmiş (yalnız o sekmede okunur)
  const [acikKart, setAcikKart] = useState({});   // sid → elle açıldı / kapandı
  const [degistir, setDegistir] = useState({});   // 'sid:i' → bitmiş kalemin formu açık
  const [tasindi, setTasindi] = useState({});     // sid → şube adı (2 sn "Teslim bekleyen'e taşındı")
  const [bilgi, setBilgi] = useState(false);
  const [hazirOnay, setHazirOnay] = useState({});   // sid → «Değiştir»de 'depo hazırlıyor' zaten onaylandı (sunucu L1 sorusu ikinci kez sorulmasın — Fable L6)
  const [kat, setKat] = useState([]);
  const [hata, setHata] = useState('');
  const [taslak, setTaslak] = useState({});   // sid → { i → [{kaynak, adet}] }
  const [mesgul, setMesgul] = useState({});
  const yukle = useCallback((temizSid) => api('/evvel-yeni/siparis/liste?gorunum=acik').then((d) => {
    setV(d); setHata('');
    setTaslak((o) => { if (!temizSid) return {}; const y_ = { ...o }; delete y_[temizSid]; return y_; });   // Fable D5-S2: öteki siparişlerin taslağı kalsın
    if (temizSid) setDegistir((o) => Object.fromEntries(Object.entries(o).filter(([a]) => !a.startsWith(`${temizSid}:`))));
    if (temizSid) setHazirOnay((o) => { const y_ = { ...o }; delete y_[temizSid]; return y_; });
    return d;
  })
    .catch((e) => { setHata(e?.message || 'Siparişler okunamadı'); return null; }), []);
  useEffect(() => { yukle(); }, [yukle]);
  const gecmisOku = useCallback(() => api('/evvel-yeni/siparis/liste?gorunum=gecmis').then((d) => { setG(d); setHata(''); }).catch((e) => setHata(e?.message || 'Geçmiş okunamadı')), []);
  useEffect(() => { if (sekme === 'gecmis') gecmisOku(); }, [sekme, gecmisOku]);
  useEffect(() => {
    api('/evvel-yeni/urun/katalog?hepsi=false').then((d) => setKat(d?.kategoriler || [])).catch(() => {});
  }, []);
  const kaynaklar = useMemo(() => [
    ...(v?.depo ? [{ id: `depo:${v.depo}`, ad: '📦 Merkez depo' }] : []),
    ...((v?.toptancilar || []).map((t) => ({ id: `toptanci:${t.id}`, ad: `🚚 ${t.ad}` }))),
  ], [v]);
  const urunler = useMemo(() => kat.flatMap((k) => (k.urunler || []).map((u) => ({ ...u, kategori: k.ad }))), [kat]);

  const is_ = async (sid, yol, govde, mesaj) => {
    setMesgul((m) => ({ ...m, [sid]: true })); setHata('');
    try {
      const once = (v?.siparisler || []).find((x) => x.id === sid);
      const d = await api(`/evvel-yeni/siparis/${sid}/${yol}`, { method: 'POST', body: govde }); onToast?.(mesaj || d?.mesaj || 'Kaydedildi');
      const yeni = await yukle(sid);
      const sonra = (yeni?.siparisler || []).find((x) => x.id === sid);
      // Fable: kaydedince kart Yönlendirilecek'ten kaybolur — kayıp sanılmasın, 2 sn "Teslim bekleyen'e taşındı →"
      if (once && yonBekliyor(once) && sonra && sonra.durum === 'acik' && !yonBekliyor(sonra)) {
        setTasindi((o) => ({ ...o, [sid]: once.sube }));
        setTimeout(() => setTasindi((o) => { const y_ = { ...o }; delete y_[sid]; return y_; }), 2500);
      }
    }
    catch (e) {
      // L1 (sim 24 Eki): depocu hazırlamaya başladıysa sunucu onay ister — merkez bilerek değiştirsin
      if (e?.status === 409 && (yol === 'yon' || yol === 'iptal') && !govde.hazir_onay && /hazırlamaya başladı/.test(e?.message || '') && await sor({ soru: e.message, tamam: 'Yine de değiştir' })) {
        setMesgul((m) => { const y = { ...m }; delete y[sid]; return y; });
        return is_(sid, yol, { ...govde, hazir_onay: true }, mesaj);
      }
      setHata(e?.message || 'İşlenemedi');
    }
    setMesgul((m) => { const y = { ...m }; delete y[sid]; return y; });
  };
  // kalemin DÜZENLENEBİLİR yönleri: taslak varsa o, yoksa mevcut kilitsiz yönler; hiç yoksa öneri kaynağıyla yönsüz adet
  const yonlerOf = (s, k) => {
    const t = taslak[s.id]?.[k.i];
    if (t) return t;
    const ac = k.yonler.filter((y) => !kilitli(y)).map((y) => ({ kaynak: y.kaynak, adet: y.adet }));
    return ac;
  };
  const yonSet = (s, k, liste) => setTaslak((o) => ({ ...o, [s.id]: { ...(o[s.id] || {}), [k.i]: liste } }));
  // sahip 1 Kas (Fable L4b): "Hepsini: Nereden…" — yönlendirilmemiş kalemlerin KALANI tek seçimle; 'oneri' = kalem başına önerilen
  // (eski 'Varsayılanları uygula'). ÜSTÜNE YAZAR (taban sunucudaki açık satırlar) → iki kez basınca toplam aşmaz. Pasta depoya gitmez.
  const uygunlar = (s) => s.kalemler.filter((k) => k.durum === 'yonlendirilmedi' && k.yonsuz > 0 && k.urun_id);
  const hepsini = (s, secim) => {
    if (!secim) return;
    const ek = {}; const pasta = []; const onerisiz = []; let ezilen = 0;
    uygunlar(s).forEach((k) => {
      const kaynak = secim === 'oneri' ? k.oneri_kaynak : secim;
      if (!kaynak) { onerisiz.push(k.ad); return; }
      if (k.pasta && kaynak.startsWith('depo:')) { pasta.push(k.ad); return; }
      if (taslak[s.id]?.[k.i]) ezilen += 1;   // Fable L6: elle yapılmış taslak değişti — söylensin
      ek[k.i] = [...k.yonler.filter((y) => !kilitli(y)).map((y) => ({ kaynak: y.kaynak, adet: y.adet })), { kaynak, adet: k.yonsuz }];
    });
    setTaslak((o) => ({ ...o, [s.id]: { ...(o[s.id] || {}), ...ek } }));
    const ad = secim === 'oneri' ? 'önerilene' : (kaynaklar.find((x) => x.id === secim)?.ad || '');
    onToast?.(`${Object.keys(ek).length} kalem → ${ad}${ezilen ? ` · ${ezilen} kalemde elle yapılan seçim değişti` : ''}${pasta.length ? ` · 🍰 ${pasta.join(', ')}: pasta depodan gönderilmez — toptancı seç` : ''}${onerisiz.length ? ` · öneri yok: ${onerisiz.join(', ')}` : ''} — kaydetmek için «Yönlendir»`);
  };
  const kaydet = async (s) => {
    const t = taslak[s.id] || {};
    const kalemler = Object.entries(t).map(([i, ys]) => ({ i: Number(i), yonler: ys.filter((y) => y.kaynak && Number(y.adet) > 0).map((y) => ({ kaynak: y.kaynak, adet: Number(y.adet) })) }));
    if (!kalemler.length) { setHata('Değişiklik yok'); return; }
    // Y6 ek (sim 24 Eki): varsayılan boş ("Nereden…") gelebilir — kaynaksız satır sessizce düşmesin, ne eksik söylensin
    const kaynaksiz = Object.entries(t).filter(([, ys]) => ys.some((y) => !y.kaynak && Number(y.adet) > 0)).map(([i]) => (s.kalemler.find((x) => x.i === Number(i)) || {}).ad);
    if (kaynaksiz.length) { setHata(`Kaynak seç: ${kaynaksiz.join(', ')} (depo ya da toptancı)`); return; }
    const bosalan = kalemler.filter((k) => !k.yonler.length).map((k) => (s.kalemler.find((x) => x.i === k.i) || {}).ad);
    if (bosalan.length && !(await sor({ soru: `${bosalan.join(', ')}: bütün kaynaklar kaldırıldı — kalem 'Yönlendirilmedi'ye döner. Devam?`, tamam: 'Devam' }))) return;   // Fable D5-S1
    is_(s.id, 'yon', { surum: s.surum, kalemler, ...(hazirOnay[s.id] ? { hazir_onay: true } : {}) }, 'Yönlendirildi');
  };

  // G61 (sim 23 Eki): yönlendirilmeyi BEKLEYEN sipariş en üstte · Y1 (sim 24 Eki): Bekleyen işler'den gelince (?odak=…) o sipariş en üstte ve vurgulu
  // sahip 2 Kas (Fable L4b): üç sekme — Yönlendirilecek (merkezden yönlendirme bekleyen) · Teslim bekleyen · Geçmiş.
  // ('Yolda' adı yalnız Depo › Yoldakiler'de — paket kabulü orada; sahip "aşağıda başka alanda da vardı", Fable: ayrı amaç, ad çakışmasın)
  // Ölçüt kalem durumundan TÜRETİLİR (yeni sütun yok); depo YOK / kısmi artık kalemi 'yönlendirilmedi' döndüğü için sipariş kendiliğinden geri gelir.
  const odak = useMemo(() => { try { return new URLSearchParams(window.location.search).get('odak'); } catch { return null; } }, []);
  // Fable L6: Bekleyen işler'den (?odak=) gelen sipariş yönlendirilmemiş kalem taşımıyorsa (ör. "eksik karşılandı") Teslim bekleyen'de — o sekme açılsın
  const [odakBakildi, setOdakBakildi] = useState(false);
  useEffect(() => {
    if (odakBakildi || !odak || !v) return;
    const s = (v.siparisler || []).find((x) => x.id === odak);
    if (s && !yonBekliyor(s)) setSekme('yolda');
    setOdakBakildi(true);
  }, [odak, v, odakBakildi]);
  const acikListe = (v?.siparisler || []).filter((s) => s.durum === 'acik');
  const yonListe = acikListe.filter(yonBekliyor);
  const yoldaListe = acikListe.filter((s) => !yonBekliyor(s));
  const gecikti = yonListe.some((s) => saatOnce(s.zaman) >= YONSUZ_SAAT);
  const liste = [...(sekme === 'gecmis' ? (g?.siparisler || []) : sekme === 'yolda' ? yoldaListe : yonListe)]
    .sort((a, b) => Number(b.id === odak) - Number(a.id === odak));
  const taslakli = acikListe.filter((s) => taslak[s.id] && Object.keys(taslak[s.id]).length);
  return (
    <div className="pi sy" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: taslakli.length ? 70 : 0 }}>
      <style>{PI_CSS}{SY_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Sipariş</div><h1 style={{ fontSize: 30 }}>Sipariş yönlendirme</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Şube talebini depoya ya da toptancıya yönlendir. <button type="button" className="sy-bilgi" onClick={() => setBilgi((b) => !b)}>ⓘ</button>
        {bilgi && <div style={{ marginTop: 4 }}><b>Merkez depo</b> seçilen kalem depo şubesinin panelinde '📤 Gönderilecek siparişler'e düşer; <b>toptancı</b> seçilen kalem şube teslim alınca karşılanır. Bir kalemi bölebilirsin. Burada stok ya da borç yazılmaz.</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Dugme kucuk ana={sekme === 'yon'} onClick={() => setSekme('yon')}>Yönlendirilecek <span className="sy-say" style={{ background: yonListe.length ? (gecikti ? R.kirmizi : R.bakir) : R.cizgi }}>{yonListe.length}</span></Dugme>
        <Dugme kucuk ana={sekme === 'yolda'} onClick={() => setSekme('yolda')}>Teslim bekleyen <span className="sy-say" style={{ background: yoldaListe.length ? R.metin2 : R.cizgi }}>{yoldaListe.length}</span></Dugme>
        <Dugme kucuk ana={sekme === 'gecmis'} onClick={() => setSekme('gecmis')}>Geçmiş (30 gün)</Dugme>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata} <Dugme kucuk onClick={() => (sekme === 'gecmis' ? gecmisOku() : yukle())}>Yenile</Dugme></div>}
      {sekme === 'yon' && Object.entries(tasindi).map(([sid, ad]) => (
        <div key={sid} style={{ ...kart, padding: '8px 14px', color: R.yesil, fontSize: 13 }}>✓ {ad} siparişi Teslim bekleyen'e taşındı → <Dugme kucuk onClick={() => setSekme('yolda')}>Teslim bekleyen'e git</Dugme></div>
      ))}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && liste.length === 0 && <div style={{ ...kart, padding: 14, color: R.not }}>{sekme === 'yon' ? 'Yönlendirilecek sipariş yok ✓' : sekme === 'yolda' ? 'Teslim bekleyen sipariş yok.' : (g ? 'Geçmiş sipariş yok.' : 'Hazırlanıyor…')}</div>}
      {liste.map((s) => {
        const acik = sekme !== 'gecmis' && s.durum === 'acik';
        const degisti = !!taslak[s.id] && Object.keys(taslak[s.id]).length > 0;
        const kapali = !(acikKart[s.id] ?? (sekme === 'yon' || s.id === odak || degisti));   // Teslim bekleyen / Geçmiş kartı kapalı başlar
        const aktarilmadi = (s.toptancilar || []).filter((t) => !t.aktarildi).length;
        const eksikli = s.kalemler.filter((k) => k.eksik > 0 || k.fark_bekliyor).length;
        const yonsuzSay = s.kalemler.filter((k) => k.durum === 'yonlendirilmedi' || k.durum === 'oneri').length;
        return (
          <div key={s.id} style={{ ...kart, padding: '10px 14px', display: 'grid', gap: 8, ...(s.id === odak ? { outline: `2px solid ${R.bakirAcik}`, outlineOffset: 2 } : {}) }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setAcikKart((o) => ({ ...o, [s.id]: kapali }))}>
              <b style={{ fontSize: 16 }}>{s.sube}</b>
              <span style={{ color: R.not, fontSize: 12.5 }}>{tKisa(s.gun)} · {s.kim || '—'} · {sureYazi(s.zaman)}</span>
              {s.deneme && <Cip tur="sari">deneme</Cip>}
              {s.durum !== 'acik' && <Cip tur={s.durum === 'iptal' ? undefined : 'yesil'}>{s.durum === 'iptal' ? `iptal${s.iptal_sebep ? ` — ${s.iptal_sebep}` : ''}` : 'tamamlandı'}</Cip>}
              {yonsuzSay > 0 && <Cip tur="kirmizi">{yonsuzSay} kalem yönlendirilmedi</Cip>}
              {acik && aktarilmadi > 0 && <Cip tur="kirmizi">📲 {aktarilmadi} toptancıya aktarılmadı</Cip>}
              {acik && eksikli > 0 && <Cip tur="sari">{eksikli} kalemde eksik / fark</Cip>}
              <span style={{ flex: 1 }} />
              {acik && degisti && <Dugme kucuk ana disabled={mesgul[s.id]} onClick={(e) => { e.stopPropagation(); kaydet(s); }}>{mesgul[s.id] ? 'Kaydediliyor…' : 'Yönlendir'}</Dugme>}
              <span style={{ color: R.not, fontSize: 13 }}>{kapali ? '▸' : '▾'}</span>
            </div>
            {kapali && <div className="sy-ozet" onClick={() => setAcikKart((o) => ({ ...o, [s.id]: true }))}>{s.kalemler.length} kalem · {kaynakOzet(s)}</div>}
            {!kapali && <>
            {acik && uygunlar(s).length > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Dugme kucuk ana disabled={mesgul[s.id]} onClick={() => hepsini(s, 'oneri')}>⭐ Hepsini önerilene dağıt</Dugme>
                <select value="" disabled={mesgul[s.id]} style={{ ...alan, flex: '1 1 160px', minWidth: 0 }} title="Yönlendirilmemiş bütün kalemleri tek seçimle doldur — tek tek değiştirilebilir"
                  onChange={(e) => hepsini(s, e.target.value)}>
                  <option value="">Hepsini nereden… ({uygunlar(s).length} kalem)</option>
                  {kaynaklar.map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                </select>
              </div>
            )}
            {s.notu && <div style={{ fontSize: 12.5, color: R.metin2 }}>📝 {s.notu}</div>}
            {(s.toptancilar || []).length > 0 && <ToptanciIletim s={s} acik={acik} mesgul={mesgul[s.id]} is_={is_} />}
            {[...s.kalemler].sort((x, y) => SIRA(x) - SIRA(y)).map((k) => {
              const [dAd0, dTur0] = DURUM[k.durum] || [k.durum];
              // B28: kısmen yönlendirilmişse kaç adedin beklediğini söyle
              let dAd = k.durum === 'yonlendirilmedi' && k.yonsuz > 0 && k.yonsuz < k.adet ? `${k.yonsuz} adet yönlendirilmedi` : dAd0;
              let dTur = dTur0;
              // G29 (sahip ekran denemesi 23 Eki): bölünmüş kalemde (8 depo yolda + 4 toptancı bekleniyor) tek "Yolda" yarım anlatıyordu
              const parcalar = {};
              // R4 (sim 25 Eki): "geldi" parçası GELEN adetle (4 istendi 3 geldi + 1 toptancıya → "4 geldi · 1 bekleniyor" yazıyordu)
              k.yonler.filter((y) => y.durum !== 'iptal').forEach((y) => { parcalar[y.durum] = (parcalar[y.durum] || 0) + (y.durum === 'karsilandi' && y.gelen != null ? y.gelen : (y.adet || 0)); });
              const KISA = { hazirlaniyor: 'depoda hazırlanıyor', bekleniyor: 'toptancıdan bekleniyor', yolda: 'yolda', karsilandi: 'geldi' };
              if (k.durum !== 'yonlendirilmedi' && k.durum !== 'karsilandi' && Object.keys(parcalar).length > 1) {
                dAd = Object.entries(parcalar).map(([d, n]) => `${n} ${KISA[d] || d}`).join(' · ');
              }
              // G27: karşılandı ama eksik geldi (10 istendi 8 geldi, kalan kapatıldı) → yeşil "Karşılandı" değil
              const gelenTop = k.yonler.filter((y) => y.durum === 'karsilandi').reduce((a, y) => a + (y.gelen != null ? y.gelen : (y.adet || 0)), 0);   // denetim: sunucu gibi (boş gelen = istenen)
              if (k.durum === 'karsilandi' && k.eksik_kapandi && gelenTop < k.adet) {   // denetim: yalnız eksik KAPATILDIYSA (açık eksik = kırmızı çip)
                dAd = `${gelenTop}/${k.adet} geldi · kalanı kapatıldı`; dTur = 'sari';
              }
              const ys = yonlerOf(s, k);
              const duzenlenir = acik && k.durum !== 'iptal' && k.durum !== 'oneri' && !!k.urun_id;
              // sahip 2 Kas (Fable L4b): bitmiş kalem form DEĞİL tek satır — form yalnız yönlendirilmemişte, taslakta ya da «Değiştir»le
              const form = duzenlenir && (k.durum === 'yonlendirilmedi' || !!taslak[s.id]?.[k.i] || !!degistir[`${s.id}:${k.i}`]);
              const kilitler = k.yonler.filter(kilitli);
              const toplam = kilitler.reduce((a, y) => a + (y.kilit ?? y.adet ?? 0), 0) + ys.reduce((a, y) => a + (Number(y.adet) || 0), 0);   // Codex I-2: teslim alınmış/farkı çözülmüş satır GELEN adetle kilitli
              const acikYonler = k.yonler.filter((y) => !kilitli(y));
              // Fable: depo hazırlamaya başladıysa / toptancıya aktarıldıysa değiştirmek hayalet sevk doğurabilir → sorarak aç (sunucu da 409 ile sorar)
              const aktarilan = acikYonler.some((y) => (s.toptancilar || []).some((t) => t.aktarildi && y.kaynak === `toptanci:${t.toptanci_id}`));
              const uyari = acikYonler.some((y) => y.hazir) ? 'Depo bu kalemi hazırlamaya başladı' : aktarilan ? "Bu kalem toptancıya WhatsApp'tan gönderildi" : '';
              return (
                <div key={k.i} className="sy-kalem">
                  <div className="sy-satir">
                    <b className="sy-ad">{k.ad}{k.pasta ? ' 🍰' : ''}</b>
                    <b className="sy-adet" style={num}>{k.adet}</b>
                    <span className="sy-nereden">{k.yonler.filter((y) => y.durum !== 'iptal').map((y) => `${y.kaynak.startsWith('depo:') ? '📦' : '🚚'} ${kisaAd(y.kaynak_ad)} ${y.adet ?? ''}`.trim()).join(' · ') || '—'}</span>
                    <span className="sy-durum">
                      <Cip tur={dTur}>{dAd}</Cip>
                      {k.depo_yok && <Cip tur="sari">depo YOK dedi ({k.depo_yok})</Cip>}
                      {k.fark_bekliyor && <Cip tur="sari">sevk farkı çözülmeyi bekliyor (Depo › Sevk farkları)</Cip>}   {/* Codex H: eksik ancak fark çözülünce */}
                      {k.eksik > 0 && k.durum !== 'yonlendirilmedi' && <Cip tur="kirmizi">{k.eksik} eksik geldi</Cip>}   {/* G29: yönlendirilmedi etiketi zaten söylüyor */}
                      {acik && k.yonler.some((y) => y.durum === 'yolda') && <Dugme kucuk onClick={() => sayfayaGit('depo_yolda')}>Depo › Yoldakiler</Dugme>}   {/* Fable: paket kabulü / fark orada */}
                    </span>
                    <span className="sy-islem">
                      {duzenlenir && !form && acikYonler.length > 0 && (
                        <Dugme kucuk onClick={async () => { if (uyari && !(await sor({ soru: `${uyari} — yine de değiştirmek istiyor musun?`, tamam: 'Değiştir' }))) return; if (acikYonler.some((y) => y.hazir)) setHazirOnay((o) => ({ ...o, [s.id]: true }));   /* Fable L6-2: yalnız DEPO hazırlığı onayı taşınır (toptancı uyarısı değil) */ setDegistir((o) => ({ ...o, [`${s.id}:${k.i}`]: true })); }}>Değiştir</Dugme>
                      )}
                      {form && !taslak[s.id]?.[k.i] && k.durum !== 'yonlendirilmedi' && <Dugme kucuk onClick={() => setDegistir((o) => { const y_ = { ...o }; delete y_[`${s.id}:${k.i}`]; return y_; })}>Kapat</Dugme>}
                    </span>
                  </div>
                  {!form && kilitler.some((y) => y.alan || y.gelen != null) && (
                    <div className="sy-iz">{kilitler.map((y) => `🔒 ${kisaAd(y.kaynak_ad)} ${y.adet}${y.gelen != null ? ` · gelen ${y.gelen}` : ''}${y.durum === 'karsilandi' && y.gelen != null && y.gelen < y.adet ? (k.eksik_kapandi ? ' · eksik kapandı' : ' · eksik geldi') : ''}${y.alan ? ` · teslim alan ${y.alan}` : ''}`).join('  ·  ')}</div>
                  )}
                  {form && kilitler.map((y) => (
                    <div key={y.id} style={{ fontSize: 12.5, color: R.metin2, paddingLeft: 12 }}>
                      🔒 {y.kaynak_ad} · <b style={num}>{y.adet}</b>{y.gelen != null ? ` · gelen ${y.gelen}` : ''} · {y.durum === 'karsilandi' && y.gelen != null && y.gelen < y.adet ? (k.eksik_kapandi ? 'eksik kapandı' : 'eksik geldi') : (DURUM[y.durum] || [y.durum])[0]}{/* Y13 (sim 24 Eki): kapanmamış eksiğe "eksik kapandı" yazıyordu */}{y.alan ? ` · teslim alan ${y.alan}` : ''}{/* E26 (29 Eki): kim · ne zaman aldı */}
                    </div>
                  ))}
                  {k.durum === 'oneri' && acik && <OneriBagla s={s} k={k} urunler={urunler} mesgul={mesgul[s.id]} is_={is_} />}
                  {form && (
                    <div style={{ display: 'grid', gap: 4, paddingLeft: 12 }}>
                      {ys.map((y, n) => (
                        <div key={n} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={y.kaynak} style={alan} onChange={(e) => yonSet(s, k, ys.map((z, m) => (m === n ? { ...z, kaynak: e.target.value } : z)))}>
                            <option value="">Nereden…</option>
                            {kaynaklar.filter((x) => !(k.pasta && x.id.startsWith('depo:'))).map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                          </select>
                          <input style={{ ...alan, width: 70 }} inputMode="numeric" value={y.adet} onChange={(e) => yonSet(s, k, ys.map((z, m) => (m === n ? { ...z, adet: e.target.value.replace(/[^\d]/g, '') } : z)))} />
                          <Dugme kucuk onClick={() => yonSet(s, k, ys.filter((_, m) => m !== n))}>✕</Dugme>
                          {k.depo_stok != null && y.kaynak.startsWith('depo:') && ys.findIndex((z) => z.kaynak.startsWith('depo:')) === n && (
                            // Y3 → sahip 2 Kas (Fable + Codex L4b): depo SEÇİLİNCE soluk bilgi, seçimin yanında. Kayıt sayım hatasıyla 0/eksi olup
                            // rafta mal olabilir → "yok" / eksi hesap yazılmaz, engellemez; tek gerçek depocunun VAR/YOK'u
                            <span style={{ fontSize: 12, color: k.depo_stok > 0 ? R.not : R.amber }} title="Sistem kaydı — rafta olup olmadığını depocu VAR / YOK ile söyler">
                              depoda <b style={num}>{k.depo_stok}</b>{k.depo_stok <= 0 ? ' · sayım gerekli' : ''}{k.depo_ayrilan > 0 ? ` · ${k.depo_ayrilan} başka siparişe ayrıldı` : ''}</span>)}
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Dugme kucuk onClick={() => yonSet(s, k, [...ys, { kaynak: k.oneri_kaynak || '', adet: Math.max(0, k.adet - toplam) || '' }])}>+ Kaynak ekle (böl)</Dugme>
                        <span style={{ fontSize: 12, color: toplam > k.adet ? R.kirmizi : R.not }}>{toplam} / {k.adet} {taslak[s.id]?.[k.i] ? 'dağıtıldı — kaydetmek için «Yönlendir»' : k.durum === 'yonlendirilmedi' && toplam < k.adet ? 'yönlendirildi · kalan bekliyor' : 'yönlendirildi'}{toplam > k.adet ? ' — istenenden fazla' : ''}</span>   {/* G62 (+denetim 16): kaydedilmemiş değişiklik = taslak */}
                        {kilitler.length === 0 && (
                          <Dugme kucuk disabled={mesgul[s.id]} onClick={async () => { const r = await sor({ soru: `${k.ad} kalemi neden iptal ediliyor?`, giris: true, tamam: 'Kalemi iptal et' }); if (r && r.trim()) is_(s.id, 'yon', { surum: s.surum, kalemler: [{ i: k.i, iptal: r.trim() }] }, 'Kalem iptal edildi'); }}>Kalemi iptal</Dugme>
                        )}
                      </div>
                    </div>
                  )}
                  {acik && k.eksik > 0 && (
                    <div style={{ paddingLeft: 12 }}>
                      <Dugme kucuk disabled={mesgul[s.id]} onClick={async () => { const r = await sor({ soru: `${k.ad}: ${k.eksik} eksik — neden kapatılıyor?`, ipucu: 'ör. toptancıda yoktu, gerek kalmadı', giris: true, tamam: 'Eksiği kapat' }); if (r && r.trim()) is_(s.id, `kalem/${k.i}/eksik-kapat`, { surum: s.surum, sebep: r.trim() }, 'Eksik kapatıldı'); }}>Eksiği kapat</Dugme>
                    </div>
                  )}
                </div>
              );
            })}
            {acik && (   /* Fable: yıkıcı düğme «Yönlendir»in yanında değil, kartın dibinde */
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Dugme kucuk disabled={mesgul[s.id]} onClick={async () => { const r = await sor({ soru: 'Sipariş neden iptal ediliyor?', giris: true, tamam: 'Siparişi iptal et' }); if (r && r.trim()) is_(s.id, 'iptal', { sebep: r.trim(), surum: s.surum }, 'Sipariş iptal edildi'); }}>Siparişi iptal</Dugme>
              </div>
            )}
            </>}
          </div>
        );
      })}
      {taslakli.length > 0 && (   /* Fable: kaydet çubuğu altta sabit — iki siparişte taslak varsa şube adıyla ayrı ayrı */
        <div className="sy-cubuk">
          {taslakli.map((s) => (
            <Dugme key={s.id} ana disabled={mesgul[s.id]} onClick={() => kaydet(s)}>{mesgul[s.id] ? 'Kaydediliyor…' : `Yönlendir — ${s.sube} · ${Object.keys(taslak[s.id]).length} kalem`}</Dugme>
          ))}
        </div>
      )}
    </div>
  );
}

// 📲 TOPTANCIYA WHATSAPP (sahip 28 Eki: "toptancıya yönlendirdik, PC WhatsApp açıktı ama bağlantı olmadı" · L4b Fable): sistem hattı YOK —
// wa.me ile PC'deki WhatsApp açılır, mesaj hazır (metin sunucudan: şube · tarih · kalem · adet · birim; fiyat / not yok), Gönder'e sahip basar.
// Düğmeye basınca "aktarıldı" izi (kanıt değil). Aktarılmamış toptancı amber. Telefon yoksa Tanımlar'a yönlendirir.
function ToptanciIletim({ s, acik, mesgul, is_ }) {
  return (
    <div style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, display: 'grid', gap: 6 }}>
      {s.toptancilar.map((t) => (
        <div key={t.toptanci_id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13,
          ...(t.aktarildi ? {} : { background: 'transparent', border: `1px solid ${R.amber}`, borderRadius: 9, padding: '6px 10px' }) }}>
          <span style={{ flex: '1 1 200px' }}>🚚 <b>{t.ad}</b> · {t.kalem_sayi} kalem</span>
          {t.aktarildi
            ? <Cip tur="yesil">WhatsApp'a aktarıldı {t.aktarildi}{t.aktaran ? ` · ${t.aktaran}` : ''}</Cip>
            : <Cip tur="sari">toptancıya henüz gönderilmedi</Cip>}
          {acik && (t.wa_no
            ? <Dugme kucuk ana={!t.aktarildi} disabled={mesgul} onClick={() => {   /* Fable L6-109: tek öğe (a > button değil) */
                // Fable L6-111: uzun siparişte (≈15+ kalem) wa.me bağlantısı sınırı aşabilir → metin panoya, WhatsApp yalnız numarayla açılır
                const url = `https://wa.me/${t.wa_no}?text=${encodeURIComponent(t.wa_metin)}`;
                const uzun = url.length > 1800;
                if (uzun) { try { navigator.clipboard?.writeText(t.wa_metin); } catch { /* pano yok */ } }
                window.open(uzun ? `https://wa.me/${t.wa_no}` : url, '_blank', 'noopener');
                is_(s.id, 'ilet', { toptanci_id: t.toptanci_id }, uzun ? `${t.ad}: sipariş uzun — mesaj kopyalandı, WhatsApp'ta yapıştırıp Gönder'e bas`
                  : `${t.ad}: WhatsApp açıldı — mesajı orada Gönder'e bas`);
              }}>{t.aktarildi ? 'Yeniden gönder' : '📲 WhatsApp ile gönder'}</Dugme>
            : <span style={{ color: R.amber }}>Toptancının telefonu yok — <Dugme kucuk onClick={() => sayfayaGit('tanim_toptanci')}>Tanımlar › Toptancılar</Dugme></span>)}
        </div>
      ))}
    </div>
  );
}

// Katalog dışı öneri: şube "katalogda yok" diye ad yazdı → merkez katalogdaki bir ürüne BAĞLAR (sonra yönlendirilir) ya da reddeder.
function OneriBagla({ s, k, urunler, mesgul, is_ }) {
  const [ara, setAra] = useState(k.ad || '');
  const [sec, setSec] = useState('');
  const kucuk = (x) => String(x || '').replace(/I/g, 'ı').replace(/İ/g, 'i').toLocaleLowerCase('tr');
  // B49: kelime kelime ve kök (ilk 5 harf) — 'peçete paketi' katalogdaki 'Peçete Paket'i bulsun; en çok eşleşen üstte
  const aday = useMemo(() => {
    const kok = kucuk(ara).split(/\s+/).filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
    if (!kok.length) return urunler.slice(0, 30);
    return urunler.map((u) => [u, kok.filter((w) => kucuk(u.ad).includes(w)).length]).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 30);
  }, [urunler, ara]);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingLeft: 12 }}>
      <span style={{ fontSize: 12.5, color: R.metin2 }}>Şubenin yazdığı: <b>{k.ad}</b> →</span>
      <input style={{ ...alan, width: 160 }} value={ara} onChange={(e) => { setAra(e.target.value); setSec(''); }} placeholder="Katalogda ara" />
      <select style={alan} value={sec} onChange={(e) => setSec(e.target.value)}>
        <option value="">Ürün seç…</option>
        {aday.map((u) => <option key={u.id} value={u.id}>{u.ad} · {u.kategori}</option>)}
      </select>
      <Dugme kucuk ana disabled={mesgul || !sec} onClick={() => is_(s.id, `kalem/${k.i}/oneri`, { surum: s.surum, urun_id: sec }, 'Ürüne bağlandı — şimdi yönlendir')}>Bağla</Dugme>
      <Dugme kucuk disabled={mesgul} onClick={async () => { const r = await sor({ soru: 'Öneri neden reddediliyor?', giris: true, tamam: 'Reddet' }); if (r && r.trim()) is_(s.id, `kalem/${k.i}/oneri`, { surum: s.surum, urun_id: null, sebep: r.trim() }, 'Öneri reddedildi'); }}>Reddet</Dugme>
    </div>
  );
}
