// ─────────────────────────────────────────────────────────────────────────────
// 🧾 EVVEL YENİ · ÖDEME / GİDER GİRİŞİ — tek form, hepsi listeden seçilir
//
// Sahip (2026-10-15): "Seçmeli ödeme gir: nakit mi, havale mi, kart mı?" · "Kirada
// şubelerin isimlerini seçmeliyiz; toptancıda kayıtlı toptancı; personelde isimler,
// yemek ücreti mesela." Etkiler sunucuda türetilir (kasa, kart, gider, kimin).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { sayiTR } from '../../utils/trSayi';
import { ALAN, AySecici, Cekmece, Cip, Dugme, Etiket, etiketStil, fmt, kart, num, odemeFisi, PATRONLAR, PI_CSS, R, sayfayaGit, soruOnay, soruYaz, tKisa, tl, useSonIstek } from './KasaModulu';
import { ayAdi, ayKaydir, ayTR, bugunTR, gunKaydir as trGunKaydir } from '../../utils/trTarih';
import { Pencere } from './AyTakvim';

export const ODEME_SAYFALAR = [
  { id: 'odemeler', ad: 'Ödeme / gider gir', alt: 'Nakit · havale · kart' },
  { id: 'odeme_defteri', ad: 'Ödeme defteri', alt: 'Gün gün ödenenler' },
  { id: 'patron_harcama', ad: 'Patron harcamaları', alt: 'Şahsi · çekiş · kredi · kart borcu' },
  { id: 'kira_takvimi', ad: 'Kira takvimi', alt: 'Şube × ay · artış ayları' },
];

const alan = { ...ALAN, width: '100%', padding: '10px 12px', fontSize: 15, minWidth: 0 };   // temel stil KasaModulu ALAN (T4-15)
const ayBugun = ayTR;   // Dalga 5 (C-T4-02): tarih tek kaynaktan
const gunBugun = bugunTR;


const yeniId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const BOS_PARCA = () => [{ yontem: 'nakit', cep: '', kart_id: '', tutar: '' }];
const BOS = () => ({ konu: '', tarih: gunBugun(), ait_ay: ayBugun(), parcalar: BOS_PARCA(), istek_id: yeniId() });
// Türkçe klavye: "12,50" da "12.50" de olur; binlik noktası "1.250,00" da olur
const sayi = (x) => sayiTR(x, 0);   // tek kaynak utils/trSayi

// Sahip (2026-10-17): "Ödeme / gider gir ayrı olsun; altındaki defter 'Ödeme defteri' diye ayrı olsun, gün gün bakılabilsin."
export default function OdemeModulu({ onToast, gorunum }) {
  const defter = gorunum === 'odeme_defteri';
  const [L, setL] = useState(null);
  const [f, setF] = useState(BOS);
  const [benzer, setBenzer] = useState(false);
  const [pd, setPd] = useState(null);   // seçili personele bu ay ne ödendi
  const [tb, setTb] = useState(null);   // O-1 (F3.6): seçili toptancının borcu — Toptancılar'ın kendi özetinden (aynı hesap)
  const [ck, setCk] = useState(null);   // ödeme fişi
  const [duz, setDuz] = useState(null);  // {id, konu_tip, kimin, ait_ay, aciklama} — gider tarafı düzeltme
  const [ucretDuz, setUcretDuz] = useState(null);   // {maas, yemek} — tanım düzenleniyor
  const otoTutar = useRef(null);         // son kendiliğinden yazılan tutar (kullanıcı değiştirdiyse üstüne yazılmaz)
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [ay, setAy] = useState(() => { const q = new URLSearchParams(window.location.search).get('gun') || ''; return /^\d{4}-\d{2}-\d{2}$/.test(q) && q <= gunBugun() ? q.slice(0, 7) : ayBugun(); });   // ?gun= ile gelen günün ayı
  const [liste, setListe] = useState(null);
  // F3.13 (sim 26 Eki): başka ekrandan gelen bağ (ör. Krediler › bağlanmamış taksit) o günü açsın — ?gun=YYYY-AA-GG, ileri gün bugüne kırpılır
  const [gun, setGun] = useState(() => { const q = new URLSearchParams(window.location.search).get('gun') || ''; const b = gunBugun(); return /^\d{4}-\d{2}-\d{2}$/.test(q) && q <= b ? q : b; });      // Ödeme defteri: seçili gün
  const [tumAy, setTumAy] = useState(false);       // Ödeme defteri: bütün ay
  const gunKaydir = (n) => { const g = trGunKaydir(gun, n); setGun(g); setAy(g.slice(0, 7)); };
  useEffect(() => {
    if (f.konu !== 'toptanci' || tb) return;
    api('/evvel-yeni/toptanci/ozet').then((d) => setTb(d?.toptancilar || [])).catch(() => setTb([]));   // Toptancılar kapalıysa satır çıkmaz
  }, [f.konu, tb]);
  // Codex: 'Bütün ay'da ay değişip 'Gün gün'e dönülünce gün o ayın içinde olsun (yoksa liste 0 görünüyordu)
  const modDegis = () => setTumAy((x) => { if (x && gun.slice(0, 7) !== ay) setGun(ay === ayBugun() ? gunBugun() : `${ay}-01`); return !x; });
  // 🏦 Krediler modülü açıksa: 'Kredi taksiti' hangi krediye (takvimde 'ödendi'). Kapalıysa liste gelmez, alan görünmez (tak-çıkar).
  const [krediler, setKrediler] = useState(null);
  useEffect(() => {
    api('/evvel-yeni/moduller').then((m) => {
      if (!(m?.moduller || []).some((x) => x.kod === 'kredi' && x.durum === 'yuklendi')) return;
      api('/evvel-yeni/kredi/liste').then((d) => setKrediler(d?.krediler || null)).catch(() => setKrediler(null));
    }).catch(() => {});
  }, []);

  const listeNo = useRef(0);   // Codex: ay sınırında hızlı gezinmede geç gelen eski cevap yeni listeyi ezmesin
  const listeYukle = useCallback(() => {
    const n = ++listeNo.current;
    return api(`/evvel-yeni/odeme/liste?ay=${ay}`).then((d) => { if (n === listeNo.current) setListe(d); })
      .catch(() => { if (n === listeNo.current) setListe({ odemeler: [], hata: true }); });
  }, [ay]);
  useEffect(() => { api('/evvel-yeni/odeme/listeler').then(setL).catch((e) => setHata(e?.message || 'Listeler okunamadı')); }, []);
  useEffect(() => { listeYukle(); }, [listeYukle]);
  // Maaşlar → "Öde": kişi, kalem, çalışma ayı ve kalan hazır gelir (tutar düzeltilebilir)
  useEffect(() => {
    if (!L) return;
    let on = null;
    try { on = JSON.parse(window.sessionStorage.getItem('ey_odeme_on') || 'null'); window.sessionStorage.removeItem('ey_odeme_on'); } catch { /* yut */ }
    if (!on) return;
    const t = on.tutar > 0 ? String(on.tutar) : '';
    otoTutar.current = t;
    setF({ ...BOS(), konu: on.konu, personel_id: on.personel_id, personel_kalemi: on.personel_kalemi, ait_ay: on.ait_ay || ayBugun(), kimin: on.kimin, patron: on.patron, toptanci_id: on.toptanci_id, kredi_id: on.kredi_id, kredi_ad: on.kredi_ad, sube_id: on.sube_id,
      kart_donem: on.konu === 'kart_borcu' ? (on.ait_ay || '') : '',
      parcalar: [{ yontem: 'havale', cep: '', kart_id: '', tutar: t }] });
  }, [L]);

  const set = (k, v) => { setBenzer(false); setF((x) => ({ ...x, [k]: v })); };
  const pdYukle = useCallback(() => {
    setPd(null); setUcretDuz(null);
    if (f.konu !== 'personel' || !f.personel_id || !f.ait_ay) return;
    api(`/evvel-yeni/odeme/personel-durum?personel_id=${encodeURIComponent(f.personel_id)}&ay=${f.ait_ay}`).then(setPd).catch(() => {});
  }, [f.konu, f.personel_id, f.ait_ay]);
  useEffect(() => { pdYukle(); }, [pdYukle]);
  // Sahip: "tutar alanı kendiliğinden dolsun ama düzeltme serbest olsun" — ilk satır boşsa ya da
  // en son sistemin yazdığı değerde duruyorsa önerilen tutar yazılır; kullanıcı değiştirdiyse dokunulmaz.
  useEffect(() => {
    if (!pd) return;
    const o = pd.onerilen?.[f.personel_kalemi];   // avans/prim için öneri yok → sistemin yazdığı silinir
    setF((x) => {
      const t0 = x.parcalar[0]?.tutar ?? '';
      if (t0 !== '' && t0 !== otoTutar.current) return x;
      const yeni = o > 0 ? String(o) : '';
      if (yeni === t0) return x;
      otoTutar.current = yeni;
      return { ...x, parcalar: x.parcalar.map((q, j) => (j === 0 ? { ...q, tutar: yeni } : q)) };
    });
  }, [pd, f.personel_kalemi]);
  // Sahip (2026-10-16): "ödemelerde sadece kira seçilince otomatik gelsin" → şube + ay seçilince o ayın kirası (kalanı) tutara yazılır
  const [kd, setKd] = useState(null);
  useEffect(() => {
    setKd(null);
    if (f.konu !== 'kira' || !f.sube_id || !f.ait_ay) return;
    let on = true;
    api(`/evvel-yeni/kira/tutar?sube_id=${encodeURIComponent(f.sube_id)}&ay=${f.ait_ay}`).then((r) => { if (on) setKd(r); }).catch(() => {});
    return () => { on = false; };
  }, [f.konu, f.sube_id, f.ait_ay]);
  useEffect(() => {
    if (!kd || kd.kalan == null) return;
    setF((x) => {
      const t0 = x.parcalar[0]?.tutar ?? '';
      if (t0 !== '' && t0 !== otoTutar.current) return x;
      const yeni = kd.kalan > 0 ? String(kd.kalan) : '';
      if (yeni === t0) return x;
      otoTutar.current = yeni;
      return { ...x, parcalar: x.parcalar.map((q, j) => (j === 0 ? { ...q, tutar: yeni } : q)) };
    });
  }, [kd]);
  const ucretKaydet = async () => {
    try {
      const r = await api('/evvel-yeni/odeme/personel-ucret', { method: 'POST', body: { personel_id: f.personel_id, ay: f.ait_ay, maas: sayi(ucretDuz.maas) || 0, yemek: sayi(ucretDuz.yemek) || 0 } });
      onToast?.(r.mesaj); pdYukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };
  const duzKaydet = async () => {
    try {
      const govde = duz.borc_ref ? { borc_ref: duz.borc_ref, aciklama: duz.aciklama }   // D-1: alınan borca bağla (para oynamaz)
        : duz.konu_tip === 'kredi' ? { kredi_id: duz.kredi_id || undefined, ait_ay: duz.ait_ay, aciklama: duz.aciklama }   // B67: kredi gider değil — kimin yok
        : { kimin: duz.kimin, ait_ay: duz.ait_ay, aciklama: duz.aciklama };
      const r = await api(`/evvel-yeni/odeme/${duz.id}/duzelt`, { method: 'POST', body: govde });
      onToast?.(r.mesaj); setDuz(null); listeYukle();
      api('/evvel-yeni/odeme/listeler').then(setL).catch(() => {});   // Codex: başka borca taşınınca eski borcun kalanı hemen seçilebilsin
    } catch (e) { onToast?.(e?.message || 'Düzeltilemedi'); }
  };
  const iptalEt = async (x) => {
    const sebep = await soruYaz(`"${x.aciklama}" (${fmt(x.toplam)} ₺) iptal edilsin mi?\nKısaca neden yaz:`);
    if (!sebep || !sebep.trim()) return;
    try { await api(`/evvel-yeni/kasa/hareket/${x.id}/iptal`, { method: 'POST', body: { sebep: sebep.trim() } }); onToast?.('Ödeme iptal edildi — para cebine geri döndü'); setTb(null); listeYukle(); api('/evvel-yeni/odeme/listeler').then(setL).catch(() => {}); }
    catch (e) { onToast?.(e?.message || 'İptal edilemedi'); }
  };
  const parcaSet = (i, k, v) => setF((x) => ({ ...x, parcalar: x.parcalar.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));

  const gonder = async (tekrar_onay = false) => {
    setHata(''); setMesgul(true);
    try {
      // Boş/hatalı satır SESSİZCE atılmaz — sunucu açıkça söyler
      const body = { ...f, ...(f.konu === 'kart_borcu' ? { ait_ay: f.kart_donem || null } : {}), tekrar_onay, parcalar: f.parcalar.map((p) => ({ yontem: p.yontem, cep: p.cep || null, kart_id: p.kart_id || null, tutar: sayi(p.tutar) || 0 })) };
      const r = await api('/evvel-yeni/odeme', { method: 'POST', body });
      onToast?.(r.mesaj);
      setBenzer(false);
      setF({ ...BOS(), tarih: f.tarih });
      setTb(null);   // Fable: toptancı borcu ödemeden sonra bayat kalmasın (sonraki seçimde taze okunur)
      api('/evvel-yeni/odeme/listeler').then(setL).catch(() => {});
      listeYukle();
    } catch (e) { const m = e?.message || 'Kaydedilemedi'; setBenzer(m.startsWith('BENZER KAYIT') || m.startsWith('KALANI AŞIYOR')); setHata(m); } finally { setMesgul(false); }
  };

  if (!L) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: hata ? R.kirmizi : R.not }}>{hata || 'Form hazırlanıyor…'}</div></div>;

  const toplam = f.parcalar.reduce((a, p) => a + (sayi(p.tutar) || 0), 0);   // yalnız giriş geri bildirimi
  const hataliSatir = f.parcalar.some((p) => !(sayi(p.tutar) > 0));
  const subeAd = (id) => (L.sube_adlari || {})[id] || (L.subeler.find((s) => s.id === id) || {}).ad;
  const secPer = L.personel.find((p) => String(p.id) === String(f.personel_id));
  const kiminAd = f.konu === 'anlik' && f.kimin === 'patron' ? `Patron şahsi${f.patron ? ` · ${f.patron}` : ''}`
    : ['kira', 'fatura', 'anlik'].includes(f.konu) ? subeAd(f.sube_id)
    : f.konu === 'personel' ? (secPer ? (subeAd(secPer.sube_id) || 'Ortak') : null)
      : f.konu === 'diger' ? ({ ortak: 'Ortak', patron: 'Patron şahsi' }[f.kimin] || subeAd(f.kimin))
        : (f.konu === 'vergi' || f.konu === 'sgk') ? (f.kimin === 'ortak' ? 'Ortak' : subeAd(f.kimin)) : null;
  const giderAyi = ['kira', 'fatura', 'personel', 'vergi', 'sgk'].includes(f.konu) ? f.ait_ay : (f.tarih || '').slice(0, 7);
  const konuObj = L.konular.find((k) => k.kod === f.konu);
  const izgara = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>{defter ? 'Ödeme defteri' : 'Ödeme / gider gir'}</h1></div>

      {!defter && (
      <div style={{ ...kart, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 1 · NE İÇİN */}
        <div>
          <div style={{ ...etiketStil, marginBottom: 8 }}>1 · Ne için ödendi?</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {L.konular.map((k) => (
              <button key={k.kod} type="button" onClick={() => { setBenzer(false); setF((x) => ({ konu: k.kod, tarih: x.tarih, ait_ay: x.ait_ay, istek_id: x.istek_id,
                parcalar: ['kart_borcu', 'personel'].includes(k.kod) ? x.parcalar.map((q) => (q.yontem === 'kart' ? { ...q, yontem: 'nakit', kart_id: '' } : q)) : x.parcalar })); }} style={{
                padding: '10px 16px', borderRadius: 12, font: 'inherit', fontSize: 15, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${f.konu === k.kod ? 'var(--pi-accent)' : 'var(--pi-line)'}`,
                background: f.konu === k.kod ? 'var(--pi-accent)' : 'var(--pi-paper)', color: f.konu === k.kod ? 'var(--pi-on-accent)' : R.krem,
              }}>{k.ad}</button>
            ))}
          </div>
        </div>

        {f.konu && (<>
          {/* 2 · AYRINTI — hepsi listeden */}
          <div style={izgara}>
            {f.konu === 'toptanci' && (
              <Etiket ad="Toptancı"><select style={alan} value={f.toptanci_id || ''} onChange={(e) => set('toptanci_id', e.target.value)}>
                <option value="">Seç…</option>{L.toptancilar.map((t) => <option key={t.id} value={t.id}>{t.ad}{t.kategori ? ` · ${t.kategori}` : ''}</option>)}
              </select>
              {(() => {   // O-1 (F3.6 · sim 26 Eki): ödemeden ÖNCE borç görünsün (Toptancılar › Öde yolunda görünüyordu, bu formda yoktu)
                const x = f.toptanci_id && (tb || []).find((t) => String(t.id) === String(f.toptanci_id));
                if (!x) return null;
                return (
                  <span style={{ display: 'block', fontSize: 12.5, marginTop: 4, color: x.bakiye > 0 ? R.metin2 : R.not }}>
                    {x.bakiye > 0 ? `Borç ${fmt(x.bakiye)} ₺` : x.bakiye < 0 ? `Alacak ${fmt(-x.bakiye)} ₺ (fazla ödenmiş)` : 'Borç yok'}
                    {x.vadesi_gecen > 0 && <b style={{ color: R.kirmizi }}> · vadesi geçen {fmt(x.vadesi_gecen)} ₺</b>}
                    {x.bilinmeyen_sayi > 0 && ` · ${x.bilinmeyen_sayi} teslimin tutarı bilinmiyor`}
                  </span>
                );
              })()}
              </Etiket>
            )}
            {f.konu === 'anlik' && (
              <Etiket ad="Şube gideri mi, şahsi mi?"><select style={alan} value={f.kimin === 'patron' ? 'patron' : 'sube'} onChange={(e) => set('kimin', e.target.value === 'patron' ? 'patron' : '')}>
                <option value="sube">Şube gideri</option><option value="patron">Patron şahsi (gider değil)</option>
              </select></Etiket>
            )}
            {(['kira', 'fatura'].includes(f.konu) || (f.konu === 'anlik' && f.kimin !== 'patron')) && (
              <Etiket ad="Hangi şube"><select style={alan} value={f.sube_id || ''} onChange={(e) => set('sube_id', e.target.value)}>
                <option value="">Seç…</option>{L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'kira' && kd && (
              <div style={{ gridColumn: '1 / -1', padding: '10px 12px', borderRadius: 10, background: 'var(--pi-accent-soft)', fontSize: 13.5 }}>
                {kd.tanimli ? <>🏠 {ayAdi(kd.ay)} kirası <b style={num}>{fmt(kd.kira)}</b> ₺ · ödenen {fmt(kd.odenen)} · <b>kalan {fmt(kd.kalan)} ₺</b>
                  {kd.kalan > 0 ? <span style={{ color: R.not }}> (tutara yazıldı — gerekirse düzelt)</span> : <span style={{ color: R.yesil }}> · bu ayın kirası ödenmiş ✓</span>}</>
                  : <>Bu şubenin kirası tanımlı değil — Tanımlar → Şubeler'den kira gir, sonra burada kendiliğinden gelir.</>}
              </div>
            )}
            {f.konu === 'fatura' && (
              <Etiket ad="Fatura türü"><select style={alan} value={f.fatura_turu || ''} onChange={(e) => set('fatura_turu', e.target.value)}>
                <option value="">Seç…</option>{L.fatura_turleri.map((t) => <option key={t}>{t}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'personel' && (<>
              <Etiket ad="Personel"><select style={alan} value={f.personel_id || ''} onChange={(e) => set('personel_id', e.target.value)}>
                <option value="">Seç…</option>{L.personel.map((p) => <option key={p.id} value={p.id}>{p.ad}{p.sube_ad ? ` · ${p.sube_ad}` : ''}{p.aktif === false ? ' · ayrıldı (son ödeme)' : ''}</option>)}
              </select></Etiket>
              <Etiket ad="Ne ödendi"><select style={alan} value={f.personel_kalemi || ''} onChange={(e) => set('personel_kalemi', e.target.value)}>
                <option value="">Seç…</option>{L.personel_kalemleri.map((k) => <option key={k}>{k}</option>)}
              </select></Etiket>
              {f.personel_kalemi === 'Maaş' && f.ait_ay === ayBugun() && (
                <div style={{ gridColumn: '1 / -1', fontSize: 13 }}>Maaş genelde bir önceki ayın maaşıdır.{' '}
                  <Dugme kucuk onClick={() => set('ait_ay', ayKaydir(ayTR(), -1))}>Geçen ayın maaşı</Dugme>
                </div>
              )}
              {pd && (
                <div style={{ gridColumn: '1 / -1', padding: '10px 12px', borderRadius: 10, background: 'var(--pi-accent-soft)', fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pd.bulunamadi ? <div>{ayAdi(pd.ay)} için bu kişinin maaş satırı yok (işe giriş/ayrılış tarihine bak).</div> : (<>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span>{ayAdi(pd.ay)} hak edişi <b style={num}>{fmt(pd.hak_edis)}</b> ₺ · avans mahsubu {fmt(pd.avans_mahsup)} · ödenen {fmt(pd.odenen)} · <b>kalan {fmt(pd.kalan)} ₺</b></span>
                    <Cip tur={pd.kaynak === 'eski_sistem' ? 'sari' : pd.onay ? 'yesil' : undefined}>{pd.kaynak === 'eski_sistem' ? 'Ekim: eski sistemin hesabı' : pd.onay ? 'ay onaylı' : 'hesap · Maaşlar ekranında ayrıntı'}</Cip>
                  </div>
                  {(pd.uyari || []).map((u) => <div key={u} style={{ color: R.kirmizi, fontWeight: 600 }}>⚠ {u}</div>)}
                  </>)}
                  {pd.onerilen[f.personel_kalemi] != null && (
                    <div>👉 Ödenecek <b style={num}>{fmt(pd.onerilen[f.personel_kalemi])}</b> ₺
                      {f.personel_kalemi === 'Maaş' && <> (kalan, yemek hariç)</>}
                      {' '}<span style={{ color: R.not }}>(tutara yazıldı — gerekirse düzelt)</span></div>
                  )}
                </div>
              )}
            </>)}
            {/* F3.9 D-1 (sim 26 Eki · Opus + Codex): yeni konu yok — "Kredi / borç taksiti" içinde ALINAN BORÇ (Kasam › Dış giriş › Borç alındı) */}
            {f.konu === 'kredi' && (L.alinan_borclar || []).some((b) => b.tarih <= f.tarih) && (
              <Etiket ad="Ne ödeniyor"><select style={alan} value={f.borc_ref || ''} onChange={(e) => {
                const b = (L.alinan_borclar || []).find((x) => x.id === e.target.value);
                setBenzer(false);
                setF((x) => {
                  const t0 = x.parcalar[0]?.tutar ?? '';
                  const oto = b && (t0 === '' || t0 === otoTutar.current) ? String(b.kalan) : null;
                  if (oto) otoTutar.current = oto;
                  return { ...x, borc_ref: b?.id || '', kredi_id: b ? '' : x.kredi_id, kredi_ad: b ? '' : x.kredi_ad,
                    parcalar: oto ? x.parcalar.map((q, j) => (j === 0 ? { ...q, tutar: oto } : q)) : x.parcalar };
                });
              }}>
                <option value="">Tanımlı kredinin taksiti</option>
                {(L.alinan_borclar || []).filter((b) => b.tarih <= f.tarih).map((b) => <option key={b.id} value={b.id}>Alınan borç · {b.kimden || '?'} · {tKisa(b.tarih)} · kalan {fmt(b.kalan)} ₺</option>)}
              </select></Etiket>
            )}
            {f.konu === 'kredi' && !f.borc_ref && krediler && krediler.length > 0 && (
              <Etiket ad="Hangi kredi"><select style={alan} value={f.kredi_id || ''} onChange={(e) => {
                const k = krediler.find((x) => x.id === e.target.value);
                setBenzer(false);
                setF((x) => {
                  const t0 = x.parcalar[0]?.tutar ?? '';
                  const oto = k && (t0 === '' || t0 === otoTutar.current) ? String(k.taksit) : null;
                  if (oto) otoTutar.current = oto;
                  return { ...x, kredi_id: k?.id || '', kredi_ad: k?.ad || '', parcalar: oto ? x.parcalar.map((q, j) => (j === 0 ? { ...q, tutar: oto } : q)) : x.parcalar };
                });
              }}>
                <option value="">Seç…</option>{krediler.map((k) => <option key={k.id} value={k.id}>{k.ad} · {fmt(k.taksit)} ₺</option>)}
              </select></Etiket>
            )}
            {f.konu === 'kart_borcu' && (
              <Etiket ad="Hangi kartın borcu"><select style={alan} value={f.kimin || ''} onChange={(e) => set('kimin', e.target.value)}>
                <option value="">Seç…</option>{L.kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad}{k.banka ? ` · ${k.banka}` : ''}</option>)}
              </select></Etiket>
            )}
            {f.konu === 'diger' && (
              <Etiket ad="Kimin gideri"><select style={alan} value={f.kimin || ''} onChange={(e) => set('kimin', e.target.value)}>
                <option value="">Seç…</option>{L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
                <option value="ortak">Ortak (şubelere dağıtılmaz)</option><option value="patron">Patron şahsi (gider değil)</option>
              </select></Etiket>
            )}
            {(f.konu === 'diger' || f.konu === 'anlik') && f.kimin === 'patron' && (
              <Etiket ad="Hangi patron"><select style={alan} value={f.patron || ''} onChange={(e) => set('patron', e.target.value)}>
                <option value="">Seç… (sonra da seçilebilir)</option>{PATRONLAR.map((p) => <option key={p}>{p}</option>)}
              </select></Etiket>
            )}
            {['kira', 'fatura', 'personel'].includes(f.konu) && (
              <Etiket ad="Ait olduğu ay" ipucu="Gider bu aya yazılır (ödendiği güne değil)"><input type="month" style={alan} value={f.ait_ay} onChange={(e) => set('ait_ay', e.target.value)} /></Etiket>
            )}
            {f.konu === 'personel' && (
              <div style={{ fontSize: 12, color: R.not }}>SGK ya da vergi mi ödüyorsun?{' '}
                {[['sgk', 'SGK'], ['vergi', 'Vergi']].map(([k, a]) => <button key={k} type="button" onClick={() => set('konu', k)} style={{ border: 'none', background: 'none', color: 'var(--pi-accent)', cursor: 'pointer', font: 'inherit', fontSize: 12, padding: '0 6px 0 0', textDecoration: 'underline' }}>{a}'den gir →</button>)}</div>
            )}
            {(f.konu === 'vergi' || f.konu === 'sgk') && (<>
              {f.konu === 'vergi' && <Etiket ad="Vergi türü"><select style={alan} value={f.vergi_turu || ''} onChange={(e) => set('vergi_turu', e.target.value)}>
                <option value="">Seç…</option>{(L.vergi_turleri || []).map((t) => <option key={t}>{t}</option>)}
              </select></Etiket>}
              <Etiket ad="Hangi şubenin"><select style={alan} value={f.kimin || ''} onChange={(e) => set('kimin', e.target.value)}>
                <option value="">Seç…</option>{L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}<option value="ortak">Ortak</option>
              </select></Etiket>
              <Etiket ad={f.konu === 'sgk' ? 'Hangi ayın SGK primi' : 'Hangi ayın vergisi'}><input type="month" style={alan} value={f.ait_ay} onChange={(e) => set('ait_ay', e.target.value)} /></Etiket>
            </>)}
            {f.konu === 'kredi' && !f.borc_ref && (
              <Etiket ad="Hangi ayın taksiti" ipucu={krediler == null ? 'Krediler modülü kapalı — takvime işlenmez' : krediler.length === 0 ? 'Tanımlı kredi yok — önce Krediler › + Kredi ekle; krediye bağlı olmayan borç: Diğer › Patron şahsi' : "Kredi takviminde bu ay 'ödendi' olur"}><input type="month" style={alan} value={f.ait_ay} onChange={(e) => set('ait_ay', e.target.value)} /></Etiket>
            )}
            {f.konu === 'kart_borcu' && (
              <Etiket ad="Hangi ayın ekstresi (son ödeme ayı)" ipucu="Boş bırakırsan ödeme gününe göre kendiliğinden yerleşir"><input type="month" style={alan} value={f.kart_donem || ''} onChange={(e) => set('kart_donem', e.target.value)} /></Etiket>
            )}
            <Etiket ad="Ödeme günü"><input type="date" style={alan} value={f.tarih} max={gunBugun()} onChange={(e) => set('tarih', e.target.value)} /></Etiket>
            <Etiket ad={['anlik', 'diger'].includes(f.konu) ? 'Ne alındı / açıklama' : 'Not (isteğe bağlı)'}>
              <input style={alan} value={f.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder={f.konu === 'anlik' ? 'ör. bulaşık deterjanı' : ''} />
            </Etiket>
          </div>

          {/* 3 · NASIL ÖDENDİ */}
          <div>
            <div style={{ ...etiketStil, marginBottom: 8 }}>2 · Nasıl ödendi?</div>
            {f.parcalar.map((p, i) => (
              <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10, paddingBottom: 10, borderBottom: '1px dashed var(--pi-line)' }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[['nakit', 'Nakit'], ['havale', 'Havale'], ['kart', 'Kart']].filter(([k]) => k !== 'kart' || !['kart_borcu', 'personel'].includes(f.konu)).map(([k, a]) => (   /* sunucu da reddeder (P-1) */
                    <button key={k} type="button" onClick={() => setF((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, yontem: k, cep: '', kart_id: '' } : q)) }))} style={{
                      padding: '9px 12px', borderRadius: 10, font: 'inherit', fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${p.yontem === k ? 'var(--pi-accent)' : 'var(--pi-line)'}`,
                      background: p.yontem === k ? 'var(--pi-accent)' : 'var(--pi-paper)', color: p.yontem === k ? 'var(--pi-on-accent)' : R.krem,
                    }}>{a}</button>
                  ))}
                </div>
                {p.yontem === 'kart' ? (
                  <select style={{ ...alan, flex: '1 1 200px', width: 'auto' }} value={p.kart_id} onChange={(e) => parcaSet(i, 'kart_id', e.target.value)}>
                    <option value="">Hangi kart…</option>{L.kartlar.map((k) => <option key={k.id} value={k.id}>{k.ad}{k.banka ? ` · ${k.banka}` : ''}</option>)}
                  </select>
                ) : (
                  <select style={{ ...alan, flex: '1 1 200px', width: 'auto' }} value={p.cep} onChange={(e) => parcaSet(i, 'cep', e.target.value)}>
                    <option value="">{p.yontem === 'nakit' ? 'Hangi evdeki nakit…' : 'Hangi banka…'}</option>
                    {(p.yontem === 'nakit' ? L.nakit_cepler : L.banka_cepler).map((c) => <option key={c.id} value={c.id} disabled={c.bakiye <= 0}>{c.ad} · {c.bakiye <= 0 ? 'boş, seçilemez' : `${fmt(c.bakiye)} ₺ var`}</option>)}
                  </select>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 1 170px', fontSize: 13, color: R.metin2 }}>Tutar
                  <input type="text" inputMode="decimal" placeholder="0" aria-label="Tutar" style={{ ...alan, borderColor: p.tutar !== '' && !(sayi(p.tutar) > 0) ? 'var(--pi-bad)' : undefined }} value={p.tutar} onChange={(e) => parcaSet(i, 'tutar', e.target.value)} /> ₺
                </label>
                {f.parcalar.length > 1 ? <Dugme kucuk onClick={() => setF((x) => ({ ...x, parcalar: x.parcalar.filter((_, j) => j !== i) }))}>Sil</Dugme> : <span />}
              </div>
            ))}
            <Dugme kucuk onClick={() => setF((x) => ({ ...x, parcalar: [...x.parcalar, { yontem: 'havale', cep: '', kart_id: '', tutar: '' }] }))}>+ Başka yolla da ödendi</Dugme>
            <div style={{ fontSize: 12.5, color: R.not, marginTop: 6 }}>Dükkân çekmecesinden ödenen harcama burada girilmez — şube panelden girer, buraya kendiliğinden gelir.</div>
          </div>

          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--pi-bg)', fontSize: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Toplam <b style={num}>{fmt(toplam)}</b> ₺</span>
            {konuObj && (konuObj.gider && f.kimin !== 'patron'
              ? <Cip tur="sari">şube/ortak GİDERİ olarak yazılacak</Cip>
              : <Cip>gider DEĞİL — {f.konu === 'toptanci' ? 'toptancı borcunu kapatır' : f.konu === 'kart_borcu' ? 'kart borcunu kapatır' : f.konu === 'kredi' ? 'patronun borcu' : f.konu === 'vergi' ? 'vergi ödemesi (vergiyi muhasebeci hesaplar)' : f.konu === 'sgk' ? 'SGK primi ödemesi' : f.konu === 'kira' ? "o ayın kirasını kapatır (gider tanımlı kiradan, ait olduğu aya yazılır)" : f.konu === 'personel' ? "personelin kalanını kapatır (gider Maaşlar'ın hak edişinden yazılır)" : 'patron çekişi'}</Cip>)}
            {f.parcalar.some((p) => p.yontem === 'kart') && <Cip>kart kısmı kasadan düşmez, kart borcu olur</Cip>}
          </div>
          {kiminAd !== null && f.konu && (
            <div style={{ fontSize: 14, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--pi-line)' }}>
              ✔ Kontrol: <b>{kiminAd || '— şube/kişi seçilmedi —'}</b> · <b>{ayAdi(giderAyi)}</b> {konuObj?.gider && f.kimin !== 'patron' ? 'gideri olarak yazılacak' : ''}
            </div>
          )}
          {hata && <div style={{ color: R.kirmizi, fontWeight: 600, fontSize: 15, padding: '10px 14px', borderRadius: 10, background: 'var(--pi-bg)' }}>{hata}</div>}
          {benzer && <div><Dugme onClick={() => gonder(true)}>Evet, doğru — yine de kaydet</Dugme></div>}
          <div><button type="button" onClick={() => gonder(false)} disabled={mesgul || !toplam || hataliSatir} style={{
            padding: '13px 26px', borderRadius: 12, border: 'none', background: 'var(--pi-accent)', color: 'var(--pi-on-accent)',
            font: 'inherit', fontSize: 16, fontWeight: 700, cursor: mesgul || !toplam || hataliSatir ? 'not-allowed' : 'pointer', opacity: mesgul || !toplam || hataliSatir ? 0.5 : 1,
          }}>{mesgul ? 'Kaydediliyor…' : 'Ödemeyi kaydet'}</button></div>
        </>)}
      </div>
      )}

      {/* ÖDEME DEFTERİ — gün gün (sahip: ayrı sekme) */}
      {defter && (() => {
        const gosterilen = (liste?.odemeler || []).filter((x) => tumAy || x.tarih === gun);
        const t = (k) => gosterilen.reduce((a, x) => a + (k === 'toplam' ? x.toplam : k === 'nakit' ? x.nakit.reduce((q, n) => q + n.tutar, 0) : x.kart.reduce((q, n) => q + n.tutar, 0)), 0);
        return (
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--pi-line)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!tumAy ? <>
            <Dugme kucuk onClick={() => gunKaydir(-1)}>‹</Dugme>
            <input type="date" value={gun} max={gunBugun()} onChange={(e) => { if (e.target.value) { setGun(e.target.value); setAy(e.target.value.slice(0, 7)); } }} style={{ ...alan, width: 'auto', padding: '6px 9px', fontSize: 13 }} />
            <Dugme kucuk disabled={gun >= gunBugun()} onClick={() => gunKaydir(1)}>›</Dugme>
            <Dugme kucuk onClick={() => { setGun(gunBugun()); setAy(ayBugun()); }}>Bugün</Dugme>
          </> : <AySecici ay={ay} setAy={setAy} style={{ ...alan, width: 'auto', padding: '6px 9px', fontSize: 13 }} />}
          <Dugme kucuk ana={tumAy} onClick={modDegis}>{tumAy ? 'Gün gün' : 'Bütün ay'}</Dugme>
          {liste && <span style={{ color: R.not, fontSize: 13, marginLeft: 'auto' }}>{tumAy ? 'bu ay' : 'bu gün'} ödenen <b style={num}>{fmt(t('toplam'))}</b> ₺ · kasadan {fmt(t('nakit'))} · kartla {fmt(t('kart'))}</span>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="pi-tablo pi-excel">
            <thead><tr><th>Gün</th><th style={{ textAlign: 'left' }}>Ne için</th><th style={{ textAlign: 'left' }}>Açıklama</th><th style={{ textAlign: 'left' }}>Kimin</th><th style={{ textAlign: 'left' }}>Nasıl</th><th>Tutar</th><th style={{ textAlign: 'left' }}>Gider mi</th><th /></tr></thead>
            <tbody>
              {gosterilen.map((x) => (
                <tr key={x.id} onClick={() => x.fis && setCk(odemeFisi(x.fis, (id) => (L.nakit_cepler.concat(L.banka_cepler).find((c) => c.id === id) || {}).ad || id))}
                  style={{ cursor: 'pointer' }} title="Ödeme fişini aç">
                  <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(x.tarih)}</td>
                  <td style={{ textAlign: 'left' }}>{x.konu}</td>
                  <td style={{ textAlign: 'left' }}>{x.aciklama}</td>
                  <td style={{ textAlign: 'left' }}>{x.kimin || '—'}</td>
                  <td style={{ textAlign: 'left', fontSize: 12 }}>{[...x.nakit.map((n) => `${n.ad} ${fmt(n.tutar)}`), ...x.kart.map((k) => `💳 ${k.ad} ${fmt(k.tutar)}`)].join(' + ')}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{fmt(x.toplam)}</td>
                  <td style={{ textAlign: 'left' }}>{['vergi', 'sgk'].includes(x.konu_tip) ? <Cip>{x.konu_tip === 'sgk' ? 'SGK' : 'vergi'} · {ayAdi(x.ait_ay)}</Cip> : x.gider ? <Cip tur="sari">gider · {ayAdi(x.ait_ay)}</Cip> : x.konu === 'Dükkân gideri' ? <Cip>dükkân gideri</Cip> : <span style={{ color: R.not }}>gider değil</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {x.duzeltilebilir && x.gider !== undefined && (['kira', 'fatura', 'anlik', 'personel', 'diger', 'vergi', 'sgk'].includes(x.konu_tip) || (x.konu_tip === 'kredi' && (krediler?.length > 0 || x.borc_ref || (L.alinan_borclar || []).length > 0))) && (
                      <Dugme kucuk onClick={(e) => { e?.stopPropagation?.(); setDuz({ id: x.id, tarih: x.tarih, konu_tip: x.konu_tip, kredi_id: x.kredi_id || '', borc_ref: x.borc_ref || '', borc_ad: x.borc_ad || '', bagli_borc: x.borc_ref || '', kimin: x.kimin_kod || '', ait_ay: x.ait_ay || '', aciklama: x.aciklama || '', baslik: `${x.aciklama} · ${fmt(x.toplam)} ₺` }); }}>Düzelt</Dugme>)}{' '}
                    {x.duzeltilebilir && <Dugme kucuk onClick={(e) => { e?.stopPropagation?.(); iptalEt(x); }}>İptal</Dugme>}
                    {x.duzeltmeler?.length > 0 && <span title="Düzeltildi" style={{ marginLeft: 4 }}>✏️</span>}
                  </td>
                </tr>
              ))}
              {liste && !gosterilen.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: R.not }}>{tumAy ? 'Bu ay ödeme yok.' : 'Bu gün ödeme yok.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
        );
      })()}
      {duz && (
        <Pencere baslik="Gider tarafını düzelt" onKapat={() => setDuz(null)} mesgul={mesgul} genislik={460} kapatDugmesi={false} aralik={12}>   {/* ortak Pencere (T4-06) — işlem sürerken kapanmaz */}
            <div style={{ fontSize: 13, color: R.not }}>{duz.baslik}<br />Para oynamaz — cepler ve tutar aynı kalır. Tutar / cep yanlışsa: iptal edip yeniden gir.</div>
            {['kredi', 'diger'].includes(duz.konu_tip) && (duz.bagli_borc || (L.alinan_borclar || []).some((b) => !duz.tarih || b.tarih <= duz.tarih)) && (
              <Etiket ad="Alınan borcun geri ödemesi mi?" ipucu={duz.bagli_borc ? 'Bağlı borç başka borçla değiştirilebilir; bağı tamamen çözmek için ödemeyi iptal edip yeniden gir' : "1 Kasım öncesi 'Diğer' ile girilmiş borç ödemesini bağla — para oynamaz, gider değil olur, iz kalır"}>
                <select style={alan} value={duz.borc_ref || ''} onChange={(e) => setDuz((d) => ({ ...d, borc_ref: e.target.value }))}>
                  {!duz.bagli_borc && <option value="">Hayır</option>}{/* Codex: bağlı ödemede "Hayır" bağı çözmüyordu — çözmek = iptal + yeniden gir (ipucu) */}
                  {duz.bagli_borc && !(L.alinan_borclar || []).some((b) => b.id === duz.bagli_borc) && <option value={duz.bagli_borc}>{duz.borc_ad || 'bağlı borç'} (bağlı)</option>}
                  {(L.alinan_borclar || []).filter((b) => !duz.tarih || b.tarih <= duz.tarih).map((b) => <option key={b.id} value={b.id}>{b.kimden || '?'} · {tKisa(b.tarih)} · kalan {fmt(b.kalan)} ₺</option>)}
                </select>
              </Etiket>
            )}
            {duz.borc_ref ? null : duz.konu_tip === 'kredi' ? (
              <Etiket ad="Hangi kredinin taksiti" ipucu="Seçince kredi takviminde o ay 'ödendi' olur"><select style={alan} value={duz.kredi_id} onChange={(e) => setDuz((d) => ({ ...d, kredi_id: e.target.value }))}>
                <option value="">Seç…</option>{(krediler || []).map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}
              </select></Etiket>
            ) : (
            <Etiket ad="Kimin gideri"><select style={alan} value={duz.kimin} onChange={(e) => setDuz((d) => ({ ...d, kimin: e.target.value }))}>
              {L.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
              {duz.kimin && !L.subeler.some((s) => s.id === duz.kimin) && (L.sube_adlari || {})[duz.kimin] && <option value={duz.kimin}>{L.sube_adlari[duz.kimin]} (pasif)</option>}
              {['diger', 'personel', 'vergi', 'sgk'].includes(duz.konu_tip) && <option value="ortak">Ortak</option>}
              {['diger', 'personel'].includes(duz.konu_tip) && <option value="patron">Patron şahsi (gider değil)</option>}
            </select></Etiket>)}
            {['kira', 'fatura', 'personel', 'vergi', 'sgk', 'kredi'].includes(duz.konu_tip) && (
              <Etiket ad="Ait olduğu ay"><input type="month" style={alan} value={duz.ait_ay} onChange={(e) => setDuz((d) => ({ ...d, ait_ay: e.target.value }))} /></Etiket>
            )}
            <Etiket ad="Açıklama"><input style={alan} value={duz.aciklama} onChange={(e) => setDuz((d) => ({ ...d, aciklama: e.target.value }))} /></Etiket>
            <div style={{ display: 'flex', gap: 8 }}><Dugme onClick={duzKaydet}>Kaydet</Dugme><Dugme kucuk onClick={() => setDuz(null)}>Vazgeç</Dugme></div>
        </Pencere>
      )}
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}

export { tl };

// ── 👤 PATRON HARCAMALARI — sahip (2026-10-16): "patron harcamaları için ayrı sekme" ──
export function PatronHarcama() {
  const [ay, setAy] = useState(ayBugun());
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [acik, setAcik] = useState('sahsi');
  useSonIstek(`/evvel-yeni/odeme/patron?ay=${ay}`, setV, setHata, true);   // ortak 'son istek kazanır' (T4-09)
  const gir = () => {
    try { window.sessionStorage.setItem('ey_odeme_on', JSON.stringify({ konu: 'diger', kimin: 'patron' })); } catch { /* yut */ }
    sayfayaGit('odemeler');   // TEK sayfa geçişi (T4-13)
  };
  const IKON = { sahsi: '🛍️', cekis: '🚬', kredi: '🏦', kart_borcu: '💳' };
  const ata = async (x, patron, geri_al = false) => {
    try {
      await api('/evvel-yeni/odeme/patron-ata', { method: 'POST', body: { id: x.id, kaynak: x.kaynak, patron: patron || null, geri_al } });
      const r = await api(`/evvel-yeni/odeme/patron?ay=${ay}`); setV(r);
    } catch (e) { setHata(e?.message || 'kaydedilemedi'); }
  };
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Ödeme</div><h1 style={{ fontSize: 30 }}>Patron harcamaları</h1></div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <AySecici ay={ay} setAy={setAy} style={{ ...alan, width: 'auto', padding: '6px 9px' }} />
          <Dugme ana onClick={gir}>+ Patron harcaması gir</Dugme>
        </span>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && (<>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          {v.gruplar.map((g) => (
            <button key={g.kod} type="button" onClick={() => setAcik(g.kod)} style={{ ...kart, padding: 12, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'var(--pi-ink)', borderLeft: `5px solid ${acik === g.kod ? 'var(--pi-accent)' : 'var(--pi-line)'}` }}>
              <div style={{ fontSize: 12.5, color: R.not }}>{IKON[g.kod]} {g.ad}</div>
              <div style={{ ...num, fontSize: 22, fontWeight: 800 }}>{fmt(g.toplam)} ₺</div>
              <div style={{ fontSize: 12, color: R.not }}>{g.kalemler.length} kayıt</div>
            </button>
          ))}
          <div style={{ ...kart, padding: 12, background: 'var(--pi-accent-soft)' }}>
            <div style={{ fontSize: 12.5, color: R.not }}>Bu ay toplam</div>
            <div style={{ ...num, fontSize: 22, fontWeight: 800 }}>{fmt(v.toplam)} ₺</div>
          </div>
        </div>
        {(v.patron_toplam || []).length > 0 && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>
            <b>Şahsi + çekiş, patron patron:</b>
            {v.patron_toplam.map((p) => <span key={p.ad} style={{ color: p.ad === 'seçilmedi' ? R.amber : undefined }}>{p.ad === 'seçilmedi' ? '❓ patronu seçilmedi' : `👤 ${p.ad}`} <b style={num}>{fmt(p.toplam)}</b> ₺</span>)}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: R.not }}>{v.not}</div>
        {v.gruplar.filter((g) => g.kod === acik).map((g) => (
          <div key={g.kod} style={{ ...kart, overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', fontWeight: 700 }}>{IKON[g.kod]} {g.ad}</div>
            {g.kalemler.length === 0 ? <div style={{ padding: '0 14px 14px', color: R.not, fontSize: 13 }}>Bu ay kayıt yok.</div> : (
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}><tbody>
                {g.kalemler.map((x) => (
                  <tr key={x.id} style={{ borderTop: '1px solid var(--pi-line)' }}>
                    <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{tKisa(x.tarih)}</td>
                    <td style={{ padding: '7px 10px' }}>{x.aciklama}<div style={{ fontSize: 11.5, color: R.not }}>{x.nasil}{x.kaydeden ? ` · ${x.kaydeden}` : ''}</div></td>
                    <td style={{ padding: '7px 10px', textAlign: 'right', ...num, fontWeight: 700 }}>{fmt(x.tutar)}</td>
                    {(g.kod === 'sahsi' || g.kod === 'cekis') && (
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <select value={x.patron || ''} onChange={(e) => e.target.value && ata(x, e.target.value)} style={{ ...alan, width: 'auto', padding: '4px 7px', fontSize: 13, borderColor: x.patron ? 'var(--pi-line)' : R.amber }}>
                          <option value="">hangi patron?</option>{(v.patronlar || []).map((p) => <option key={p}>{p}</option>)}
                        </select>
                        {g.kod === 'cekis' && <Dugme kucuk onClick={async () => (await soruOnay('Bu kayıt patron harcaması değil — şube giderine geri alınsın mı?')) && ata(x, null, true)}>Şube gideri</Dugme>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
        ))}
      </>)}
    </div>
  );
}
