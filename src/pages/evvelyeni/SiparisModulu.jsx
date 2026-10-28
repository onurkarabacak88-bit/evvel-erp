// 🛒 SİPARİŞ YÖNLENDİRME — tak-çıkar modül (sunucu: evvel_yeni_siparis_api.py, S5c). Şube panelinden "Sipariş ver" ile gelen talep
// burada kalem kalem yönlendirilir: merkez DEPO (Sevk → Depodan gelen) ya da TOPTANCI (şube Tedarikçiden teslim al'da karşılar).
// Bölünebilir (5 depodan + 5 toptancıdan). Stok / borç YAZMAZ — yalnız "nereden gelecek" kararı. Katalog dışı öneri → ürüne bağla / reddet.
// Eksik karşılanan kalem → sebep yazıp kapat. Yola çıkmış / teslime bağlanmış satır değişmez (sunucu da reddeder).
// Ortak parçalar KasaModulu'ndan (PI_CSS, R, kart, Dugme, Cip) — yeni stil yazılmaz. Listeler: /odeme/listeler (toptancılar) + /urun/katalog.
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

export default function SiparisModulu({ onToast }) {
  const [gorunum, setGorunum] = useState('acik');
  const [v, setV] = useState(null);
  const [L, setL] = useState(null);
  const [kat, setKat] = useState([]);
  const [hata, setHata] = useState('');
  const [taslak, setTaslak] = useState({});   // sid → { i → [{kaynak, adet}] }
  const [mesgul, setMesgul] = useState({});
  const yukle = useCallback((temizSid) => api(`/evvel-yeni/siparis/liste?gorunum=${gorunum}`).then((d) => {
    setV(d); setHata('');
    setTaslak((o) => { if (!temizSid) return {}; const y_ = { ...o }; delete y_[temizSid]; return y_; });   // Fable D5-S2: öteki siparişlerin taslağı kalsın
  })
    .catch((e) => setHata(e?.message || 'Siparişler okunamadı')), [gorunum]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => {
    api('/evvel-yeni/odeme/listeler').then(setL).catch(() => setHata('Toptancı listesi okunamadı — sayfayı yenile'));
    api('/evvel-yeni/urun/katalog?hepsi=false').then((d) => setKat(d?.kategoriler || [])).catch(() => {});
  }, []);
  const kaynaklar = useMemo(() => [
    ...(v?.depo ? [{ id: `depo:${v.depo}`, ad: '📦 Merkez depo' }] : []),
    ...((L?.toptancilar || []).map((t) => ({ id: `toptanci:${t.id}`, ad: `🚚 ${t.ad}` }))),
  ], [v, L]);
  const urunler = useMemo(() => kat.flatMap((k) => (k.urunler || []).map((u) => ({ ...u, kategori: k.ad }))), [kat]);

  const is_ = async (sid, yol, govde, mesaj) => {
    setMesgul((m) => ({ ...m, [sid]: true })); setHata('');
    try { const d = await api(`/evvel-yeni/siparis/${sid}/${yol}`, { method: 'POST', body: govde }); onToast?.(mesaj || d?.mesaj || 'Kaydedildi'); await yukle(sid); }
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
  const varsayilan = (s) => {
    const ek = {};
    s.kalemler.forEach((k) => {
      if (k.durum === 'yonlendirilmedi' && k.yonsuz > 0 && k.oneri_kaynak) ek[k.i] = [...yonlerOf(s, k), { kaynak: k.oneri_kaynak, adet: k.yonsuz }];
    });
    setTaslak((o) => ({ ...o, [s.id]: { ...(o[s.id] || {}), ...ek } }));
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
    is_(s.id, 'yon', { surum: s.surum, kalemler }, 'Yönlendirildi');
  };

  // G61 (sim 23 Eki): yönlendirilmeyi BEKLEYEN sipariş en üstte (eskiden yeniye sırada bugünkü talep en altta kalıyordu)
  // Y1 (sim 24 Eki): Bekleyen işler'den gelince (?odak=…) o sipariş en üstte ve vurgulu
  const odak = useMemo(() => { try { return new URLSearchParams(window.location.search).get('odak'); } catch { return null; } }, []);
  const liste = [...(v?.siparisler || [])].sort((a, b) => Number(b.id === odak) - Number(a.id === odak)
    || Number((b.kalemler || []).some((k) => k.durum === 'yonlendirilmedi')) - Number((a.kalemler || []).some((k) => k.durum === 'yonlendirilmedi')));
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Sipariş</div><h1 style={{ fontSize: 30 }}>Sipariş yönlendirme</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Şubenin talebini kalem kalem yönlendir: <b>merkez depo</b> (depo şubesinin panelinde '📤 Gönderilecek siparişler'e düşer) ya da <b>toptancı</b> (şube teslim alınca karşılanır). Bölebilirsin. Burada stok ya da borç yazılmaz.</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Dugme kucuk ana={gorunum === 'acik'} onClick={() => setGorunum('acik')}>Açık</Dugme>
        <Dugme kucuk ana={gorunum === 'gecmis'} onClick={() => setGorunum('gecmis')}>Geçmiş (30 gün)</Dugme>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata} <Dugme kucuk onClick={yukle}>Yenile</Dugme></div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && liste.length === 0 && <div style={{ ...kart, padding: 14, color: R.not }}>{gorunum === 'acik' ? 'Açık sipariş yok.' : 'Geçmiş sipariş yok.'}</div>}
      {liste.map((s) => {
        const acik = gorunum === 'acik' && s.durum === 'acik';
        const degisti = !!taslak[s.id] && Object.keys(taslak[s.id]).length > 0;
        return (
          <div key={s.id} style={{ ...kart, padding: '10px 14px', display: 'grid', gap: 8, ...(s.id === odak ? { outline: `2px solid ${R.bakirAcik}`, outlineOffset: 2 } : {}) }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16 }}>{s.sube}</b>
              <span style={{ color: R.not, fontSize: 12.5 }}>{tKisa(s.gun)} · {s.kim || '—'}</span>
              {s.deneme && <Cip tur="sari">deneme</Cip>}
              {s.durum !== 'acik' && <Cip tur={s.durum === 'iptal' ? undefined : 'yesil'}>{s.durum === 'iptal' ? `iptal${s.iptal_sebep ? ` — ${s.iptal_sebep}` : ''}` : 'tamamlandı'}</Cip>}
              <span style={{ flex: 1 }} />
              {acik && <Dugme kucuk disabled={mesgul[s.id]} onClick={() => varsayilan(s)} title="Yönlendirilmemiş kalemleri son toptancıya / merkez depoya doldur">Varsayılanları uygula</Dugme>}
              {acik && <Dugme kucuk ana disabled={mesgul[s.id] || !degisti} onClick={() => kaydet(s)}>{mesgul[s.id] ? 'Kaydediliyor…' : 'Yönlendir'}</Dugme>}
              {acik && <Dugme kucuk disabled={mesgul[s.id]} onClick={async () => { const r = await sor({ soru: 'Sipariş neden iptal ediliyor?', giris: true, tamam: 'Siparişi iptal et' }); if (r && r.trim()) is_(s.id, 'iptal', { sebep: r.trim(), surum: s.surum }, 'Sipariş iptal edildi'); }}>Siparişi iptal</Dugme>}
            </div>
            {s.notu && <div style={{ fontSize: 12.5, color: R.metin2 }}>📝 {s.notu}</div>}
            {s.kalemler.map((k) => {
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
              const kilitler = k.yonler.filter(kilitli);
              const toplam = kilitler.reduce((a, y) => a + (y.kilit ?? y.adet ?? 0), 0) + ys.reduce((a, y) => a + (Number(y.adet) || 0), 0);   // Codex I-2: teslim alınmış/farkı çözülmüş satır GELEN adetle kilitli
              return (
                <div key={k.i} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ flex: '1 1 180px' }}>{k.ad}{k.pasta ? ' 🍰' : ''}</b>
                    <b style={num}>{k.adet}</b>
                    <Cip tur={dTur}>{dAd}</Cip>
                    {k.depo_yok && <Cip tur="sari">depo YOK dedi ({k.depo_yok})</Cip>}
                    {k.fark_bekliyor && <Cip tur="sari">sevk farkı çözülmeyi bekliyor (Depo › Sevk farkları)</Cip>}   {/* Codex H: eksik ancak fark çözülünce */}
                    {acik && k.depo_stok != null && k.durum !== 'karsilandi' && k.durum !== 'iptal' && (   /* Y3 (sim 24 Eki): yönlendirirken depo KAYDI */
                      // sahip 24 Eki: kayıt sayım hatasıyla 0/eksi olup rafta mal olabilir → "yok" denmez; tek gerçek depocunun VAR/YOK'u
                      <span style={{ fontSize: 12, color: k.depo_stok > 0 ? R.metin2 : R.amber }} title="Sistem kaydı — rafta olup olmadığını depocu VAR / YOK ile söyler">
                        depo kaydı: <b style={num}>{k.depo_stok}</b>{k.depo_stok <= 0 ? ' · sayım gerekli' : ''}</span>)}
                    {k.eksik > 0 && k.durum !== 'yonlendirilmedi' && <Cip tur="kirmizi">{k.eksik} eksik geldi</Cip>}   {/* G29: yönlendirilmedi etiketi zaten söylüyor */}
                    {acik && k.durum !== 'iptal' && kilitler.length === 0 && (
                      <Dugme kucuk disabled={mesgul[s.id]} onClick={async () => { const r = await sor({ soru: `${k.ad} kalemi neden iptal ediliyor?`, giris: true, tamam: 'Kalemi iptal et' }); if (r && r.trim()) is_(s.id, 'yon', { surum: s.surum, kalemler: [{ i: k.i, iptal: r.trim() }] }, 'Kalem iptal edildi'); }}>Kalemi iptal</Dugme>
                    )}
                  </div>
                  {kilitler.map((y) => (
                    <div key={y.id} style={{ fontSize: 12.5, color: R.metin2, paddingLeft: 12 }}>
                      🔒 {y.kaynak_ad} · <b style={num}>{y.adet}</b>{y.gelen != null ? ` · gelen ${y.gelen}` : ''} · {y.durum === 'karsilandi' && y.gelen != null && y.gelen < y.adet ? (k.eksik_kapandi ? 'eksik kapandı' : 'eksik geldi') : (DURUM[y.durum] || [y.durum])[0]}{/* Y13 (sim 24 Eki): kapanmamış eksiğe "eksik kapandı" yazıyordu */}
                    </div>
                  ))}
                  {k.durum === 'oneri' && acik && <OneriBagla s={s} k={k} urunler={urunler} mesgul={mesgul[s.id]} is_={is_} />}
                  {duzenlenir && (
                    <div style={{ display: 'grid', gap: 4, paddingLeft: 12 }}>
                      {ys.map((y, n) => (
                        <div key={n} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={y.kaynak} style={alan} onChange={(e) => yonSet(s, k, ys.map((z, m) => (m === n ? { ...z, kaynak: e.target.value } : z)))}>
                            <option value="">Nereden…</option>
                            {kaynaklar.filter((x) => !(k.pasta && x.id.startsWith('depo:'))).map((x) => <option key={x.id} value={x.id}>{x.ad}</option>)}
                          </select>
                          <input style={{ ...alan, width: 70 }} inputMode="numeric" value={y.adet} onChange={(e) => yonSet(s, k, ys.map((z, m) => (m === n ? { ...z, adet: e.target.value.replace(/[^\d]/g, '') } : z)))} />
                          <Dugme kucuk onClick={() => yonSet(s, k, ys.filter((_, m) => m !== n))}>✕</Dugme>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Dugme kucuk onClick={() => yonSet(s, k, [...ys, { kaynak: k.oneri_kaynak || '', adet: Math.max(0, k.adet - toplam) || '' }])}>+ Kaynak ekle (böl)</Dugme>
                        <span style={{ fontSize: 12, color: toplam > k.adet ? R.kirmizi : R.not }}>{toplam} / {k.adet} {taslak[s.id]?.[k.i] ? 'dağıtıldı — kaydetmek için «Yönlendir»' : k.durum === 'yonlendirilmedi' && toplam < k.adet ? 'yönlendirildi · kalan bekliyor' : 'yönlendirildi'}{toplam > k.adet ? ' — istenenden fazla' : ''}</span>   {/* G62 (+denetim 16): kaydedilmemiş değişiklik = taslak */}
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
            {(s.toptancilar || []).length > 0 && <ToptanciIletim s={s} acik={acik} mesgul={mesgul[s.id]} is_={is_} />}
          </div>
        );
      })}
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
