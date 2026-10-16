// ─────────────────────────────────────────────────────────────────────────────
// 💰 EVVEL YENİ · KASA — sade çekirdeğin ilk bölümü (2026-10-15; eski adı Para İzi)
//
// Sahip: "Evvel her şeyi takip etsin dedik ama hem çok karışık hem sürekli
// hata yapıyor. Sade kurup sonra işlevi artıralım; eski sistemden AYRI modül
// olarak kur, bu aydan itibaren."
//
// Bu ekran YALNIZ /api/para-izi/* okur ve yazar. Eski kasa ekranlarına,
// kasa_hareketleri'ne, kasa_teslim'e DOKUNMAZ.
//
// Ekranın üç sorusu: para KİMDE · NEREDE · NEREDEN GELDİ.
// Kurallar (taslakta sahiple tek tek konuşuldu):
//   · Tek ekran: aşağı inmeden okunur. Gün seçici → solda o günün AKŞAMI
//     para nerede, sağda o günün hareketleri.
//   · Patron evleri üstte YAN YANA (en önemli soru: kimde ne var).
//   · Trafik ışığı: kırmızı müdahale · sarı dikkat · yeşil temiz · gri boş;
//     renk tek başına durmaz, NEDENİ yazar.
//   · Onay gerektiren hiçbir şey gün görünümüne gömülmez → "Bekleyen işler"
//     kutusu güne bağlı değil, en eski üstte.
//   · Ayrıntı Evvel ÇEKMECESİNDE: satırlar kapı, geri yolu çağırana ait.
//   · EKRAN KENDİ ARİTMETİĞİNİ KURMAZ: bütün rakamlar sunucudan gelir.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';

// Kadife (v2) bileşenlerine BAĞIMLILIK YOK — sahip: "kadife tasarımda değil ayrı bir
// alanda yap, sonra (eskiyi) tamamen kaldırsak". Bu dosya src/pages/evvelyeni altında,
// kendi adresinde (/evvel-yeni) çalışır; v2 silinse de etkilenmez.
function HataBandi({ mesaj, kod, onTekrar }) {
  return (
    <div className="pi" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <style>{PI_CSS}</style>
      <b style={{ color: 'var(--pi-bad)' }}>{mesaj}</b><span style={{ color: 'var(--pi-ink3)' }}>{kod}</span>
      {onTekrar && <button type="button" onClick={onTekrar} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)', cursor: 'pointer', font: 'inherit' }}>Tekrar dene</button>}
    </div>
  );
}

// 🎨 YÜZ (sahip 2026-10-15): "Taslak görüntüsü daha iyiydi; Evvel'in kadife yüzü gibi
// hazırlamayalım, taslağı direkt kur." → Bu modül Evvel'in koyu kadife temasını
// KULLANMAZ; taslaktaki krem/espresso/bakır dili, açık-koyu sisteme uyarak.
// Renkler yalnız CSS değişkeni olarak tanımlı — aşağıdaki R aynı adlarla onlara bakar.
const R = {
  krem: 'var(--pi-ink)', metin2: 'var(--pi-ink2)', not: 'var(--pi-ink3)', not2: 'var(--pi-ink3)',
  cizgi: 'var(--pi-line)', cizgi2: 'var(--pi-line)', cizgi3: 'var(--pi-line)', girinti: 'var(--pi-bg)',
  yesil: 'var(--pi-good)', kirmizi: 'var(--pi-bad)', amber: 'var(--pi-warn)', bakirAcik: 'var(--pi-accent)',
};
const alfa = (renk, yuzde) => `color-mix(in srgb, ${renk} ${yuzde}%, transparent)`;
const PI_CSS = `
.pi{--pi-bg:#F4EEE2;--pi-paper:#FCFAF4;--pi-line:#E0D4BE;--pi-ink:#2A1E14;--pi-ink2:#5E4C3A;--pi-ink3:#7F6C57;
  --pi-accent:#9A5F2E;--pi-on-accent:#FFF8EC;--pi-accent-soft:#F1E3D0;--pi-good:#25794F;--pi-good-soft:#E1EFE4;
  --pi-bad:#C03A2B;--pi-bad-soft:#F6E1DC;--pi-warn:#8A680E;--pi-warn-soft:#F4EBCF;
  --pi-f-display:'Fraunces',Georgia,serif;--pi-f-body:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--pi-f-num:'JetBrains Mono',ui-monospace,Consolas,monospace;
  background:var(--pi-bg);color:var(--pi-ink);font-family:var(--pi-f-body);font-size:14px;line-height:1.45;
  border-radius:16px;padding:18px 20px 28px;color-scheme:light}
@media (prefers-color-scheme: dark){.pi{--pi-bg:#161009;--pi-paper:#211710;--pi-line:#3A2C1E;--pi-ink:#F1E9DD;--pi-ink2:#C4B5A2;--pi-ink3:#A3917B;
  --pi-accent:#D29A5B;--pi-on-accent:#241A12;--pi-accent-soft:#3A2817;--pi-good:#5FBE8E;--pi-good-soft:#163020;
  --pi-bad:#E2604F;--pi-bad-soft:#3A1B16;--pi-warn:#E5B84E;--pi-warn-soft:#33290F;color-scheme:dark}}
.pi h1,.pi .pi-baslik{font-family:var(--pi-f-display);font-weight:600;letter-spacing:-.01em;margin:0}
.pi .pi-num,.pi [data-num]{font-family:var(--pi-f-num);font-variant-numeric:tabular-nums}
.pi .pi-eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--pi-ink3);font-weight:600}
.pi input,.pi select{color-scheme:inherit}
.pi button:focus-visible,.pi input:focus-visible,.pi select:focus-visible{outline:2px solid var(--pi-accent);outline-offset:2px}
.pi-ck-arka{position:fixed;inset:0;z-index:96;background:rgba(22,16,9,.45);display:flex;justify-content:flex-end}
.pi-ck{width:min(560px,100vw);height:100%;background:var(--pi-paper);color:var(--pi-ink);border-left:1px solid var(--pi-line);
  border-radius:16px 0 0 16px;display:flex;flex-direction:column;font-family:var(--pi-f-body)}
@media (prefers-reduced-motion:no-preference){.pi-ck{animation:piKay .32s cubic-bezier(.4,0,.2,1)}}
@keyframes piKay{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}
.pi-ck-bas{padding:16px 18px 10px;border-bottom:1px solid var(--pi-line);display:flex;flex-direction:column;gap:3px;position:relative}
.pi-ck-bas h2{font-family:var(--pi-f-display);font-size:22px;margin:0;font-weight:600;padding-right:70px}
.pi-ck-sekme{display:flex;gap:4px;padding:8px 18px 0}
.pi-ck-sekme button{border-radius:8px 8px 0 0;border:1px solid var(--pi-line);border-bottom:0;background:transparent;color:var(--pi-ink2);padding:5px 12px;font:inherit;cursor:pointer}
.pi-ck-sekme button[aria-selected="true"]{background:var(--pi-accent);color:var(--pi-on-accent);border-color:var(--pi-accent);font-weight:600}
.pi-ck-govde{flex:1;overflow:auto;padding:14px 18px 24px;display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--pi-line)}
.pi-kapi{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;width:100%;text-align:left;padding:9px 12px;
  border-radius:8px;border:1px solid var(--pi-line);background:var(--pi-bg);color:var(--pi-ink);font:inherit}
button.pi-kapi{cursor:pointer}
button.pi-kapi:hover{border-color:var(--pi-accent)}
.pi-kapi small{display:block;color:var(--pi-ink3);font-size:12px}
.pi-tablo{border-collapse:collapse;width:100%;font-size:13px}
.pi-tablo th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--pi-ink3);font-weight:600;text-align:right;padding:4px 8px;border-bottom:1px solid var(--pi-line)}
.pi-tablo td{padding:6px 8px;border-bottom:1px solid var(--pi-line);text-align:right}
.pi-tablo th:first-child,.pi-tablo td:first-child{text-align:left}
.pi-excel{font-size:12.5px}
.pi-excel thead th{position:sticky;top:0;background:var(--pi-accent-soft);color:var(--pi-ink2);border-bottom:1px solid var(--pi-line)}
.pi-excel td,.pi-excel th{border-right:1px solid var(--pi-line);padding:6px 9px}
.pi-excel tbody tr:nth-child(even) td{background:color-mix(in srgb, var(--pi-bg) 70%, transparent)}
.pi-excel tbody tr:hover td{background:var(--pi-accent-soft)}
`;

const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const GUNLER = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
// Kuruş görünür (Codex): 999,75 ₺ "1.000" diye yuvarlanmaz.
const fmt = (n) => (Number(n) || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const tl = (n) => `${fmt(n)} ₺`;
const tUzun = (s) => { if (!s) return ''; const p = s.split('-'); return `${+p[2]} ${AY[+p[1] - 1]}`; };
const tKisa = (s) => tUzun(s).replace(/(\S+)$/, (m) => m.slice(0, 3));
const gunAdi = (s) => GUNLER[new Date(`${s}T12:00:00`).getDay()];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const gunEkle = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };

const SEVIYE = {
  kirmizi: { kenar: R.kirmizi, zemin: 'var(--pi-bad-soft)' },
  sari: { kenar: R.amber, zemin: 'var(--pi-warn-soft)' },
  yesil: { kenar: R.yesil, zemin: 'transparent' },
  gri: { kenar: R.cizgi3, zemin: 'transparent' },
};

const kart = { background: 'var(--pi-paper)', border: '1px solid var(--pi-line)', borderRadius: 12 };
const etiketStil = { fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: R.not2, fontWeight: 600 };
const num = { fontFamily: 'var(--pi-f-num)', fontVariantNumeric: 'tabular-nums' };

function Dugme({ children, onClick, ana, kucuk, disabled, title, renk }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} style={{
      padding: kucuk ? '4px 10px' : '7px 13px', borderRadius: 9, fontFamily: 'inherit',
      fontSize: kucuk ? 12 : 12.5, fontWeight: ana ? 700 : 600, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap',
      border: ana ? '1px solid var(--pi-accent)' : `1px solid ${renk || R.cizgi3}`,
      background: ana ? (renk || 'var(--pi-accent)') : 'var(--pi-paper)',
      color: ana ? 'var(--pi-on-accent)' : (renk || R.krem),
    }}>{children}</button>
  );
}

function Cip({ children, tur }) {
  const r = { kirmizi: R.kirmizi, sari: R.amber, yesil: R.yesil, bakir: R.bakirAcik }[tur] || R.metin2;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, padding: '1px 8px',
      borderRadius: 999, color: r, border: `1px solid ${alfa(r, 35)}`, background: alfa(r, 12), whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// ─── Cep kartı (şerit ve liste aynı bileşen) ───
function CepKart({ c, onAc, serit }) {
  const s = SEVIYE[c.seviye] || SEVIYE.gri;
  const bos = c.seviye === 'gri';
  return (
    <button type="button" onClick={() => onAc(c.id)} style={{
      ...(serit ? kart : {}), textAlign: 'left', width: '100%', cursor: 'pointer', fontFamily: 'inherit',
      padding: serit ? '12px 14px' : '10px 14px', color: R.krem,
      borderLeft: `4px solid ${s.kenar}`, background: serit ? kart.background : s.zemin,
      borderTop: serit ? kart.border : 'none', borderRight: serit ? kart.border : 'none',
      borderBottom: serit ? kart.border : `1px solid ${R.cizgi}`, borderRadius: serit ? 14 : 0,
      display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
      boxShadow: serit && c.seviye === 'kirmizi' ? `inset 0 0 0 1px ${alfa(R.kirmizi, 35)}` : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: serit ? 'flex-start' : 'baseline', gap: serit ? 2 : 8, flexDirection: serit ? 'column' : 'row' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{serit && <span style={{ ...etiketStil, display: 'block' }}>{c.kira ? 'Kira hesabı' : ({ ev: 'Patron evi', sube: 'Dükkân nakdi', banka: 'Banka', hesap: 'Geçiş hesabı' }[c.tur])}</span>}{c.ad}</span>
        <span style={{ ...num, fontSize: serit ? 21 : 15, fontWeight: 600, color: bos ? R.not2 : R.krem }}>{tl(c.bakiye)}</span>
      </div>
      {c.kirmizi.map((t, i) => <span key={`k${i}`} style={{ fontSize: 11.5, fontWeight: 700, color: R.kirmizi }}>● {t}</span>)}
      {c.sari.map((t, i) => <span key={`s${i}`} style={{ fontSize: 11.5, fontWeight: 700, color: R.amber }}>● {t}</span>)}
      {!bos && c.tur !== 'sube' && c.gelen.length > 0 && (
        <span style={{ fontSize: 11.5, color: R.metin2 }}>
          {c.gelen.map((g) => `${g.kaynak} ${fmt(g.tutar)}`).join(' · ')}
          {c.cikan > 0 && <span style={{ color: R.not2 }}> · çıkan {fmt(c.cikan)}</span>}
        </span>
      )}
      {!bos && c.tur === 'sube' && !c.kirmizi.length && !c.sari.length && (
        <span style={{ fontSize: 11.5, color: R.not }}>Kapanışlar onaylı{c.son_teslim ? ` · son teslim ${tKisa(c.son_teslim)}` : ''}</span>
      )}
      {bos && !c.kirmizi.length && !c.sari.length && (
        <span style={{ fontSize: 11.5, color: R.not2 }}>{c.bosaldi ? `Boşaldı ${tKisa(c.bosaldi.tarih)}` : 'Hareket yok'}</span>
      )}
    </button>
  );
}

// ─── Hareket satırı (sağ akış) ───
const TUR_AD = { acilis: 'Açılış', kapanis: 'Kapanış', dis: 'Dış giriş', teslim: 'Teslim', tasima: 'Taşıma', odeme: 'Ödeme', sayim: 'Sayım', cozum: 'Fark çözüldü', pos_yatis: 'POS yatışı' };
// 🧾 ÖDEME FİŞİ — "parayı kim verdi" (Kasa) ile "gider kimin" (Gider) aynı kâğıtta
const AY_AD = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
function odemeFisi(h, cepAd) {
  const kasadan = h.parcalar.reduce((a, p) => a + p.tutar, 0);
  const karttan = (h.kart_parcalar || []).reduce((a, p) => a + p.tutar, 0);
  const [y, m] = (h.ait_ay || '').split('-');
  return {
    tip: 'ÖDEME FİŞİ', baslik: h.aciklama || 'Ödeme',
    alt: `${tUzun(h.tarih)}${h.konu ? ` · ${h.konu}` : ''}${h.kaydeden ? ` · giren: ${h.kaydeden}` : ''}`,
    kpi: [
      { etiket: 'Toplam', deger: tl(h.genel_toplam ?? kasadan + karttan) },
      { etiket: 'Kasadan', deger: tl(kasadan), renk: R.kirmizi },
      ...(karttan ? [{ etiket: 'Kartla (borç oldu)', deger: tl(karttan) }] : []),
      { etiket: 'Gider kimin', deger: h.gider === false ? 'gider değil' : (h.kimin || 'Ortak') },
      ...(h.gider && m ? [{ etiket: 'Hangi ayın gideri', deger: `${AY_AD[Number(m) - 1]} ${y}` }] : []),
    ],
    not: `Toplam kasa: ${fmt(h.toplam_once)} → ${fmt(h.toplam_sonra)} ₺`
      + (h.kiradan_destek ? ` · Fatma kira hesabından destek ${fmt(h.kiradan_destek)} ₺` : '')
      + (h.not_ ? ` · Not: ${h.not_}` : '')
      + (h.duzeltmeler || []).map((d) => ` · ✏️ ${d.kim || '?'} ${d.zaman}: ${Object.entries(d.degisen).map(([k, [a, b]]) => `${k} ${a || '—'} → ${b || '—'}`).join(', ')}`).join(''),
    listeBaslik: 'Para nereden çıktı?',
    satirlar: [
      ...h.parcalar.map((p) => ({ ad: p.ad || cepAd(p.cep), tutar: `−${fmt(p.tutar)} ₺`, detay: `payı %${p.pay} · cepte ${fmt(p.once)} → ${fmt(p.sonra)} ₺ kaldı` })),
      ...(h.kart_parcalar || []).map((p) => ({ ad: `💳 ${p.ad}`, tutar: `${fmt(p.tutar)} ₺`, detay: 'kasadan çıkmadı · kart borcu oldu' })),
    ],
  };
}

function HareketSatir({ h, cepAd, onIptal, onTeyit, onFis }) {
  let ust = '', alt = '', tutar = fmt(h.tutar), renk = R.krem, cip = null, cipTur = 'bakir';
  if (h.tur === 'acilis') { ust = cepAd(h.cep); alt = '1 Ekim açılış bakiyesi'; renk = R.yesil; tutar = `+${tutar}`; }
  if (h.tur === 'kapanis') {
    ust = cepAd(h.cep); alt = `Şube panelinden · kart/online ${fmt(h.kart)} ₺ bankaya geçer, nakde girmez`;
    renk = R.yesil; tutar = `+${tutar}`; cipTur = 'yesil';
    cip = h.durum === 'onaylandi' ? <Cip tur="yesil">onaylandı</Cip> : <Dugme kucuk ana onClick={() => onTeyit(h.id)}>Onayla</Dugme>;
  }
  if (h.tur === 'dis') { ust = h.alt_ad + (h.kimden ? ` · ${h.kimden}` : ''); alt = `${cepAd(h.cep)} cebine girdi${h.not_ ? ` · ${h.not_}` : ''}`; renk = R.yesil; tutar = `+${tutar}`; cip = h.geri_odenecek ? <Cip tur="sari">geri ödenecek</Cip> : null; cipTur = 'yesil'; }
  if (h.tur === 'teslim') {
    ust = `${cepAd(h.kaynak)} → ${cepAd(h.hedef)}`;
    alt = 'Dükkân nakdinden çıktı · patron "aldım" deyince evine girer';
    cip = h.durum !== 'onaylandi' ? <Cip tur="sari">onay bekliyor</Cip>
      : (h.fark ? <Cip tur="kirmizi">sayılan {fmt(h.alinan)} · {h.fark > 0 ? 'eksik' : 'fazla'} {fmt(Math.abs(h.fark))}</Cip> : <Cip tur="yesil">alındı</Cip>);
    if (h.durum === 'onaylandi' && h.onay_gunu && h.onay_gunu !== h.tarih) alt = `${tUzun(h.onay_gunu)} günü alındı — o güne kadar "yolda"`;
  }
  if (h.tur === 'tasima') { ust = `${cepAd(h.kaynak)} → ${cepAd(h.hedef)}`; }
  if (h.tur === 'sayim') {
    ust = cepAd(h.cep); alt = `Defterde ${fmt(h.beklenen)} · sayılan ${fmt(h.sayilan)}`;
    cip = !h.fark ? <Cip tur="yesil">tuttu</Cip> : <Cip tur="kirmizi">{fmt(Math.abs(h.fark))} {h.fark > 0 ? 'eksik' : 'fazla'}</Cip>;
  }
  if (h.tur === 'cozum') {
    const zarar = h.zarar;
    ust = h.sebep_ad; alt = `${h.fark_ad || ''}${h.sorumlu ? ` · sorumlu: ${h.sorumlu}` : ''}${h.not_ ? ` · ${h.not_}` : ''}`;
    renk = zarar ? R.kirmizi : R.krem; tutar = zarar ? `−${fmt(Math.abs(h.f))}` : fmt(Math.abs(h.f));
  }
  if (h.tur === 'odeme') {
    ust = h.aciklama; alt = `kimin: ${h.kimin} · ${h.parcalar.map((p) => `${cepAd(p.cep)} ${fmt(p.tutar)}`).join(' + ')}`;
    renk = R.kirmizi; tutar = `−${tutar}`;
    if (h.kiradan_destek) cip = <Cip tur="bakir">kiradan destek {fmt(h.kiradan_destek)}</Cip>;
  }
  if (h.tur === 'pos_yatis') {
    ust = `${cepAd(h.cep)} · ${h.kanal === 'online' ? 'Online' : 'POS'} yatışı`;
    alt = `${cepAd(h.sube_cep)} satışı · brüt ${fmt(h.brut)} ₺${h.brut_tahmini ? ' (komisyon oranıyla tahmini)' : ''}${h.not_ ? ` · ${h.not_}` : ''}`;
    renk = R.yesil; tutar = `+${tutar}`; cipTur = 'yesil';
    if (h.otomatik) {
      cip = <Cip>otomatik · ertesi gün</Cip>;
      alt = `${cepAd(h.sube_cep)} POS satışı ${fmt(h.brut)} ₺ − %${fmt(h.oran || 0)} komisyon = beklenen net · gerçek tutar ekstre bakiyesiyle doğrulanır`;
    }
  }
  return (
    <div style={{ ...kart, padding: '9px 13px', display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center' }}>
      <Cip tur={h.tur === 'odeme' ? 'kirmizi' : cipTur}>{TUR_AD[h.tur]}</Cip>
      <div style={{ minWidth: 0, cursor: h.tur === 'odeme' && onFis ? 'pointer' : 'default' }} onClick={h.tur === 'odeme' && onFis ? () => onFis(h) : undefined}
        title={h.tur === 'odeme' ? 'Ödeme fişini aç' : undefined}>
        <div style={{ fontWeight: 700, fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{ust} {cip}{h.eski_sistem && <Cip>eski sistemden</Cip>}{h.kaydeden && <span style={{ fontSize: 11, color: R.not2, fontWeight: 400 }}>· {h.kaydeden}</span>}</div>
        {alt && <div style={{ fontSize: 11.5, color: R.not }}>{alt}</div>}
      </div>
      <span style={{ ...num, fontSize: 15, fontWeight: 600, color: renk }}>{tutar}</span>
      <button type="button" title="Bu kaydı iptal et (silinmez, iptal kaydı yazılır)" onClick={() => onIptal(h)} style={{
        border: 'none', background: 'transparent', color: R.not2, cursor: 'pointer', fontSize: 15, padding: 2, fontFamily: 'inherit',
      }}>×</button>
    </div>
  );
}

// ─── Form penceresi ───
const BASLIK = {
  acilis: 'Açılış bakiyesi', donem: 'Yeni başlangıç', kapanis: 'Şube kapanışı', dis: 'Dış kaynaktan giriş', teslim: 'Şubeden teslim',
  tasima: 'Para taşı / hesaba yatır', sayim: 'Sayım / ekstre bakiyesi', pos: 'Online platform parası bankaya yattı', odeme: 'Ödeme', coz: 'Farkı çöz', iptal: 'Kaydı iptal et', aktar: 'Eski sistemden aktar',
};
const alanStil = {
  width: '100%', padding: '8px 10px', borderRadius: 9, border: `1px solid ${R.cizgi3}`, background: R.girinti,
  color: R.krem, fontFamily: 'inherit', fontSize: 13, minWidth: 0,
};
function Alan({ etiket, children, ipucu }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: R.metin2, fontWeight: 600, minWidth: 0 }}>
      {etiket}{children}{ipucu && <span style={{ fontWeight: 400, color: R.not2 }}>{ipucu}</span>}
    </label>
  );
}

function FormPenceresi({ form, veri, gun, onKapat, onBitti, onToast }) {
  const tip = form.tip;
  const cepler = veri.cepler;
  const bak = veri.anlik_bakiye || {};
  const secenek = (turler, bakiyeli) => cepler.filter((c) => !turler || turler.includes(c.tur))
    .map((c) => <option key={c.id} value={c.id}>{c.ad}{bakiyeli ? ` · ${fmt(bak[c.id])} ₺` : ''}</option>);
  const ilk = (turler) => (cepler.find((c) => !turler || turler.includes(c.tur)) || {}).id || '';
  const [d, setD] = useState(() => ({
    is_gunu: form.gun || gun, cep: form.cep || (tip === 'pos' ? ((cepler.find((c) => c.tur === 'banka' && !c.kira) || {}).id || '') : ilk(tip === 'kapanis' ? ['sube'] : null)),
    kaynak: ilk(tip === 'teslim' ? ['sube'] : null), hedef: ilk(tip === 'teslim' ? ['ev'] : ['ev', 'hesap']),
    alt: 'borc', kimin: 'Ortak', parcalar: [{ cep: '', tutar: '' }], sorumlu: '', sebep: '',
  }));
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [fark, setFark] = useState(null);
  const [aktar, setAktar] = useState(null);
  const [donem, setDonem] = useState(null);
  const [sayimDefter, setSayimDefter] = useState(null);
  const set = (k) => (e) => setD((x) => {
    const y = { ...x, [k]: e.target.value };
    if (k === 'alt' && e.target.value === 'kira' && cepler.some((c) => c.id === 'banka:fatma_kira')) y.cep = 'banka:fatma_kira';
    return y;
  });

  useEffect(() => {
    if (tip === 'coz') api(`/evvel-yeni/kasa/fark/${form.id}`).then((f) => { setFark(f); setD((x) => ({ ...x, sebep: f.sebep_secenekleri[0]?.kod, is_gunu: (form.gun || gun) < f.tarih ? f.tarih : (form.gun || gun) })); }).catch((e) => setHata(e.message));
    if (tip === 'aktar') api('/evvel-yeni/kasa/aktar?kuru=true', { method: 'POST' }).then(setAktar).catch((e) => setHata(e.message));
    if (tip === 'donem') setD((x) => ({ ...x, is_gunu: veri.bugun }));
  }, [tip, form.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Sayımda "defterde ne olmalı" bilgisi sunucudan, seçilen günün akşamı itibarıyla
  useEffect(() => {
    if (tip !== 'sayim' || !d.cep) return;
    api(`/evvel-yeni/kasa/cep/${encodeURIComponent(d.cep)}?gun=${d.is_gunu}`).then((r) => setSayimDefter(r.cep.bakiye)).catch(() => setSayimDefter(null));
  }, [tip, d.cep, d.is_gunu]);

  const parcaToplam = d.parcalar.reduce((a, p) => a + (Number(p.tutar) || 0), 0);
  const gonder = async () => {
    setHata(''); setMesgul(true);
    try {
      if (tip === 'donem') {
        if (!donem) {   // 1. adım: KURU — ne olacağını göster
          setDonem(await api('/evvel-yeni/kasa/donem', { method: 'POST', body: { gun: d.is_gunu, kuru: true } }));
          setMesgul(false);
          return;
        }
        await api('/evvel-yeni/kasa/donem', { method: 'POST', body: { gun: d.is_gunu, kuru: false } });
        onToast?.(`Yeni dönem ${tUzun(d.is_gunu)} başladı — her cebin açılışını gir`);
        onBitti(d.is_gunu);
        return;
      } else if (tip === 'aktar') {
        const r = await api('/evvel-yeni/kasa/aktar?kuru=false', { method: 'POST' });
        onToast?.(`Aktarıldı: ${r.ozet.kapanis} kapanış · ${r.ozet.teslim} teslim`);
      } else if (tip === 'iptal') {
        await api(`/evvel-yeni/kasa/hareket/${form.id}/iptal`, { method: 'POST', body: { sebep: d.sebep } });
        onToast?.('Kayıt iptal edildi (iz duruyor)');
      } else {
        const body = { tur: tip === 'coz' ? 'cozum' : tip, is_gunu: d.is_gunu };
        if (['acilis', 'kapanis', 'dis', 'sayim', 'pos'].includes(tip)) body.cep = d.cep;
        if (tip === 'pos') { body.tur = 'pos_yatis'; body.alt = 'online'; body.kart = d.kart ? Number(d.kart) : null; }
        if (tip === 'teslim') { body.kaynak = d.kaynak; body.hedef = d.hedef; body.teslim_eden = d.teslim_eden; }
        if (tip === 'tasima') {
          body.hedef = d.hedef;
          body.parcalar = d.parcalar.filter((p) => p.cep && Number(p.tutar) > 0).map((p) => ({ cep: p.cep, tutar: Number(p.tutar) }));
        }
        if (tip === 'sayim') body.sayilan = Number(d.sayilan);
        else if (tip !== 'coz' && tip !== 'odeme' && tip !== 'tasima') body.tutar = Number(d.tutar);
        if (tip === 'kapanis') { body.kart = Number(d.kart || 0); body.online = Number(d.online || 0); }
        if (tip === 'dis') { body.alt = d.alt; body.kimden = d.kimden; body.not = d.not; }
        if (tip === 'odeme') {
          body.tutar = Number(d.tutar); body.aciklama = d.aciklama; body.kimin = d.kimin;
          body.parcalar = d.parcalar.filter((p) => p.cep && Number(p.tutar) > 0).map((p) => ({ cep: p.cep, tutar: Number(p.tutar) }));
        }
        if (tip === 'coz') { body.fark_id = form.id; body.sebep = d.sebep; body.sorumlu = d.sorumlu; body.not = d.not; }
        await api('/evvel-yeni/kasa/hareket', { method: 'POST', body });
        onToast?.('Kaydedildi');
      }
      onBitti(tip === 'aktar' || tip === 'iptal' || tip === 'coz' ? null : d.is_gunu);
    } catch (e) {
      setHata(e?.message || 'Kaydedilemedi');
    } finally { setMesgul(false); }
  };

  const gunAlani = !['acilis', 'iptal', 'aktar', 'donem'].includes(tip) && (
    <Alan etiket="Gün"><input type="date" value={d.is_gunu} min={veri.baslangic} max={veri.bugun} onChange={set('is_gunu')} style={alanStil} /></Alan>
  );
  const tutarAlani = (etiket = 'Tutar (₺)') => (
    <Alan etiket={etiket}><input type="number" min="0" step="0.01" inputMode="decimal" value={d.tutar || ''} onChange={set('tutar')} style={alanStil} /></Alan>
  );
  const izgara = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 };
  const secili = d.parcalar.map((p) => p.cep);
  const cepAdi = (id) => (cepler.find((c) => c.id === id) || {}).ad || '';

  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(22,16,9,.45)', display: 'grid', placeItems: 'center', padding: 16 }} onClick={onKapat}>
      <div className="pi" onClick={(e) => e.stopPropagation()} style={{ ...kart, borderRadius: 14, width: 'min(620px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="pi-baslik" style={{ fontSize: 21 }}>{BASLIK[tip]}</div>
          <Dugme onClick={onKapat}>Kapat</Dugme>
        </div>

        {tip === 'acilis' && (<>
          <div style={{ fontSize: 12.5, color: R.metin2 }}>Bu dönem {tUzun(veri.baslangic)} sabahı başladı. Her cepte o sabah ne kadar para olduğunu bir kez gir (sayarak). Sonradan değiştirmek için eski kaydı iptal edip yenisini girersin.</div>
          <div style={izgara}>
            <Alan etiket="Cep"><select value={d.cep} onChange={set('cep')} style={alanStil}>{cepler.filter((c) => !(veri.acilis_girilen || []).includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.ad}</option>)}</select></Alan>
            {tutarAlani(`${tUzun(veri.baslangic)} sabahı (₺)`)}
          </div>
        </>)}

        {tip === 'kapanis' && (<>
          <div style={{ fontSize: 12, color: R.not }}>Normalde şube panelinden gelir. Gelmediyse şubenin X/Z raporundan buradan girilir. O gün Evo tahmini varsa bu kapanış onun yerini alır (Evo rakamı silinmez, devre dışı kalır).</div>
          <div style={izgara}>
            <Alan etiket="Şube"><select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(['sube'])}</select></Alan>
            {gunAlani}
            {tutarAlani('Nakit (₺)')}
            <Alan etiket="POS / kart (₺)" ipucu="Ertesi gün bankaya kendiliğinden geçer"><input type="number" min="0" step="0.01" value={d.kart || ''} onChange={set('kart')} style={alanStil} /></Alan>
            <Alan etiket="Online (₺)" ipucu="Platform öder, elle girilir"><input type="number" min="0" step="0.01" value={d.online || ''} onChange={set('online')} style={alanStil} /></Alan>
          </div>
        </>)}

        {tip === 'pos' && (() => {
          const bc = cepler.find((c) => c.id === d.cep) || {};
          const bek = (veri.pos || []).filter((x) => x.banka_cep === d.cep);
          return (<>
            <div style={{ fontSize: 12.5, color: R.metin2 }}><b>POS (kart) ertesi gün kendiliğinden yatar — buraya girilmez.</b> Burası yalnız online platform (Yemeksepeti, Getir vb.) yatışları için. Yatan <b>net</b> tutarı gir; brüt satışı bilmiyorsan boş bırak.</div>
            <div style={izgara}>
              <Alan etiket="Hangi şubenin bankasına"><select value={d.cep} onChange={set('cep')} style={alanStil}>{cepler.filter((c) => c.tur === 'banka' && !c.kira).map((c) => <option key={c.id} value={c.id}>{c.ad}</option>)}</select></Alan>
              {tutarAlani('Yatan net (₺)')}
              <Alan etiket="Brüt satış (₺)" ipucu="Bilmiyorsan boş bırak"><input type="number" min="0" step="0.01" value={d.kart || ''} onChange={set('kart')} style={alanStil} /></Alan>
              {gunAlani}
            </div>
            {bc.tur === 'banka' && (bek.length ? bek.map((x) => (
              <div key={x.kanal} style={{ padding: '8px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: R.metin2 }}>
                {x.sube} {x.kanal === 'pos' ? 'POS' : 'online'}: bankaya gelecek <b style={num}>{fmt(x.bekleyen_brut)}</b> ₺ brüt
                {x.oran ? <> · %{fmt(x.oran)} komisyonla beklenen net ≈ <b style={num}>{fmt(x.beklenen_net)}</b> ₺</> : null}
                {x.en_eski_gun ? ` · en eskisi ${tUzun(x.en_eski_gun)}` : ''}
              </div>
            )) : <div style={{ fontSize: 12.5, color: R.not }}>Bu bankanın şubesinde bekleyen POS yok.</div>)}
          </>);
        })()}

        {tip === 'dis' && (
          <div style={izgara}>
            <Alan etiket="Ne geldi"><select value={d.alt} onChange={set('alt')} style={alanStil}>{(veri.dis_turleri || []).map((x) => <option key={x.kod} value={x.kod}>{x.ad}</option>)}</select></Alan>
            <Alan etiket="Kimden" ipucu={d.alt === 'destek' ? 'Desteği koyan patron' : (['borc', 'kredi'].includes(d.alt) ? 'Geri ödenecek — kimden alındı' : null)}>
              <input list="pi-kisiler" value={d.kimden || ''} onChange={set('kimden')} style={alanStil} placeholder="ör. Ziraat, Onur" />
              <datalist id="pi-kisiler"><option value="Onur" /><option value="Fethi" /><option value="Fatma" /></datalist>
            </Alan>
            <Alan etiket="Hangi cebe girdi" ipucu={d.alt === 'kira' ? 'Kira genelde Fatma\'nın kira hesabına girer' : null}>
              <select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(null)}</select>
            </Alan>
            {tutarAlani()}
            {gunAlani}
            <Alan etiket="Not"><input value={d.not || ''} onChange={set('not')} style={alanStil} /></Alan>
          </div>
        )}

        {tip === 'teslim' && (
          <div style={izgara}>
            <Alan etiket="Teslim eden şube"><select value={d.kaynak} onChange={set('kaynak')} style={alanStil}>{secenek(['sube'], true)}</select></Alan>
            <Alan etiket="Teslim alan patron"><select value={d.hedef} onChange={set('hedef')} style={alanStil}>{secenek(['ev'])}</select></Alan>
            <Alan etiket="Teslim eden personel"><input value={d.teslim_eden || ''} onChange={set('teslim_eden')} style={alanStil} placeholder="ör. Ayşe" /></Alan>
            {tutarAlani()}{gunAlani}
          </div>
        )}

        {tip === 'tasima' && (<>
          <div style={{ fontSize: 12.5, color: R.metin2 }}>Birden çok evden toplanıp tek yere (ör. Fethi'nin hesabına) giden parayı tek kayıtta gir.</div>
          <div style={izgara}>
            <Alan etiket="Nereye"><select value={d.hedef} onChange={set('hedef')} style={alanStil}>{secenek(null)}</select></Alan>
            {gunAlani}
          </div>
          <div style={etiketStil}>Nereden · ne kadar</div>
          {d.parcalar.map((p, i) => {
            const pc = cepler.find((c) => c.id === p.cep) || {};
            const hc = cepler.find((c) => c.id === d.hedef) || {};
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 130px auto', gap: 8 }}>
                <select value={p.cep} onChange={(e) => setD((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, cep: e.target.value } : q)) }))} style={alanStil}>
                  <option value="">Cep seç</option>
                  {cepler.map((c) => <option key={c.id} value={c.id} disabled={c.id === d.hedef || (secili.includes(c.id) && p.cep !== c.id) || (c.tur === 'sube' && hc.tur === 'ev')}>{c.ad} · {fmt(bak[c.id])} ₺</option>)}
                </select>
                <input type="number" min="0" step="0.01" placeholder="Tutar" value={p.tutar} onChange={(e) => setD((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, tutar: e.target.value } : q)) }))} style={alanStil} />
                <Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: x.parcalar.filter((_, j) => j !== i) }))}>Sil</Dugme>
                {pc.tur === 'sube' && hc.tur === 'ev' && <div style={{ gridColumn: '1/-1', fontSize: 12, color: R.amber }}>Şubeden patrona para TESLİM ile geçer.</div>}
              </div>
            );
          })}
          <div><Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: [...x.parcalar, { cep: '', tutar: '' }] }))}>+ Kaynak ekle</Dugme></div>
          <div style={{ padding: '8px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: R.metin2 }}>
            {cepAdi(d.hedef)} cebine toplam <b style={num}>{fmt(parcaToplam)}</b> ₺ girecek
          </div>
        </>)}

        {tip === 'sayim' && (<>
          <div style={izgara}>
            <Alan etiket="Neresi sayıldı" ipucu={(cepler.find((c) => c.id === d.cep) || {}).tur === 'banka' ? 'Banka için: ekstredeki o günün kapanış bakiyesini yaz' : null}>
              <select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(null)}</select>
            </Alan>
            {gunAlani}
            <Alan etiket="Sayılan (₺)"><input type="number" min="0" step="0.01" value={d.sayilan ?? ''} onChange={set('sayilan')} style={alanStil} /></Alan>
          </div>
          {sayimDefter !== null && (() => {
            const s = d.sayilan === undefined || d.sayilan === '' ? null : Number(d.sayilan);
            const f = s === null ? 0 : sayimDefter - s;
            return (
              <div style={{ padding: '9px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: s === null ? R.metin2 : Math.abs(f) < 0.005 ? R.yesil : R.amber }}>
                {tUzun(d.is_gunu)} akşamı defterde <b style={num}>{tl(sayimDefter)}</b>
                {s !== null && (Math.abs(f) < 0.005 ? ' · tuttu' : ` · ${f > 0 ? 'eksik' : 'fazla'} ${tl(Math.abs(f))} → açık fark olur, silinmez`)}
              </div>
            );
          })()}
        </>)}

        {tip === 'odeme' && (<>
          <div style={izgara}>
            <Alan etiket="Ne ödendi"><input value={d.aciklama || ''} onChange={set('aciklama')} style={alanStil} /></Alan>
            {tutarAlani()}{gunAlani}
            <Alan etiket="Kimin ödemesi" ipucu="Yalnız aylık karne için, paraya dokunmaz">
              <select value={d.kimin} onChange={set('kimin')} style={alanStil}><option>Ortak</option>{cepler.filter((c) => c.tur === 'sube').map((c) => <option key={c.id}>{c.kisa}</option>)}</select>
            </Alan>
          </div>
          <div style={etiketStil}>Para nereden toplandı</div>
          {d.parcalar.map((p, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 130px auto', gap: 8 }}>
              <select value={p.cep} onChange={(e) => setD((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, cep: e.target.value } : q)) }))} style={alanStil}>
                <option value="">Cep seç</option>
                {cepler.map((c) => <option key={c.id} value={c.id} disabled={(secili.includes(c.id) && p.cep !== c.id) || (bak[c.id] || 0) <= 0}>{c.ad} · {(bak[c.id] || 0) <= 0 ? 'boş' : `${fmt(bak[c.id])} ₺`}</option>)}
              </select>
              <input type="number" min="0" step="0.01" placeholder="Tutar" value={p.tutar} onChange={(e) => setD((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, tutar: e.target.value } : q)) }))} style={alanStil} />
              <Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: x.parcalar.filter((_, j) => j !== i) }))}>Sil</Dugme>
            </div>
          ))}
          <div><Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: [...x.parcalar, { cep: '', tutar: '' }] }))}>+ Kaynak ekle</Dugme></div>
          <div style={{ padding: '8px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: Math.abs(parcaToplam - Number(d.tutar || 0)) < 0.5 && parcaToplam > 0 ? R.yesil : R.amber }}>
            Kaynaklar <b style={num}>{fmt(parcaToplam)}</b> · ödeme <b style={num}>{fmt(d.tutar)}</b>
          </div>
        </>)}

        {tip === 'coz' && fark && (<>
          <div style={{ padding: '9px 12px', borderRadius: 9, background: 'var(--pi-bad-soft)', border: `1px solid ${alfa(R.kirmizi, 35)}`, fontSize: 13 }}>
            <b>{fark.ad}</b> · {tUzun(fark.tarih)} · <b style={num}>{tl(Math.abs(fark.f))}</b> {fark.f > 0 ? 'eksik' : 'fazla'}
          </div>
          <div style={izgara}>
            <Alan etiket="Sebep"><select value={d.sebep} onChange={set('sebep')} style={alanStil}>{fark.sebep_secenekleri.map((s) => <option key={s.kod} value={s.kod}>{s.ad}</option>)}</select></Alan>
            <Alan etiket="Sorumlu"><select value={d.sorumlu} onChange={set('sorumlu')} style={alanStil}>{['', 'Onur', 'Fethi', 'Fatma', 'Şube personeli', 'Bilinmiyor'].map((x) => <option key={x} value={x}>{x || 'Seçilmedi'}</option>)}</select></Alan>
            {gunAlani}
          </div>
          <Alan etiket="Açıklama" ipucu={['kayip', 'harcandi'].includes(d.sebep) ? 'Kayba ya da harcamaya yazarken zorunlu' : null}><input value={d.not || ''} onChange={set('not')} style={alanStil} /></Alan>
        </>)}

        {tip === 'iptal' && (<>
          <div style={{ fontSize: 12.5, color: R.metin2 }}>Kayıt silinmez; "iptal" kaydı yazılır ve iz kalır. Bakiyeler kaydı yokmuş gibi yeniden hesaplanır.</div>
          <Alan etiket="İptal sebebi"><input value={d.sebep || ''} onChange={set('sebep')} style={alanStil} placeholder="ör. yanlış şube seçilmiş" /></Alan>
        </>)}

        {tip === 'donem' && (<>
          <div style={{ fontSize: 12.5, color: R.metin2 }}>
            Yeni başlangıç gününden önceki kayıtlar <b>silinmez</b>; arşivde kalır ama hesaplara girmez.
            Her cep o sabah sayılır ve açılış bakiyesi girilir. Eski sistemden köprü yeni günden itibaren çalışmaya devam eder.
          </div>
          <Alan etiket="Yeni başlangıç günü"><input type="date" value={d.is_gunu} min={veri.baslangic} max={veri.bugun}
            onChange={(e) => { setDonem(null); set('is_gunu')(e); }} style={alanStil} /></Alan>
          {donem && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5 }}>
              <div style={etiketStil}>Önceki dönemin sonu (yalnız bilgi — açılışı sayarak gireceksin)</div>
              {donem.onceki_donem_sonu.map((c) => (
                <div key={c.cep} style={{ display: 'flex', justifyContent: 'space-between', color: c.defterde < 0 ? R.kirmizi : R.metin2 }}>
                  <span>{c.ad}</span><span style={num}>{tl(c.defterde)}</span>
                </div>
              ))}
              {(donem.bekleyen_is > 0 || donem.acik_yolda || donem.acik_fark) ? (
                <div style={{ color: R.amber }}>⚠ Önceki dönemde {donem.bekleyen_is} bekleyen iş, {fmt(donem.acik_yolda)} ₺ yolda, {fmt(donem.acik_fark)} ₺ açık fark kalıyor — arşive geçecek.</div>
              ) : null}
            </div>
          )}
        </>)}

        {tip === 'aktar' && (aktar ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5, color: R.metin2 }}>
            <div>Eski sistemden <b>yalnız okunur</b>; eski tablolara dokunulmaz. Aynı kayıt iki kez aktarılmaz.</div>
            <div style={{ ...num }}>
              <b style={{ color: R.krem }}>{aktar.ozet.kapanis}</b> kapanış (nakit kasaya, kart yalnız bilgi) ·{' '}
              <b style={{ color: R.krem }}>{aktar.ozet.teslim}</b> teslim (patron evlerine) · {aktar.ozet.zaten_aktarilmis} zaten aktarılmış
            </div>
            {aktar.ozet.eslesmeyen_teslim > 0 && (
              <div style={{ color: R.amber }}>⚠ {aktar.ozet.eslesmeyen_teslim} teslim alınmayacak — alan kişi Onur/Fethi/Fatma diye tanınmadı: {aktar.eslesmeyen_teslim.slice(0, 6).map((x) => `${x.gun} ${x.sube} → "${x.alan || '?'}" ${fmt(x.tutar)}`).join(' · ')}</div>
            )}
            {aktar.ozet.dis_kaynak_elle > 0 && (
              <div style={{ color: R.amber }}>⚠ {aktar.ozet.dis_kaynak_elle} dış kaynak kaydı otomatik alınmaz — eski sistem paranın kimde olduğunu tutmuyor. "Dış giriş" ile elle girilmeli.</div>
            )}
          </div>
        ) : !hata && <div style={{ color: R.not }}>Eski sistem okunuyor…</div>)}

        {hata && <div style={{ color: R.kirmizi, fontSize: 13, fontWeight: 600 }}>{hata}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Dugme ana onClick={gonder} disabled={mesgul || (tip === 'aktar' && !aktar) || (tip === 'coz' && !fark)}>
            {mesgul ? 'Kaydediliyor…' : tip === 'donem' ? (donem ? `${tUzun(d.is_gunu)} itibarıyla yeni dönemi başlat` : 'Önce ne olacağını göster')
              : tip === 'aktar' ? 'Aktar' : tip === 'iptal' ? 'İptal et' : tip === 'coz' ? 'Farkı kapat' : 'Kaydet'}
          </Dugme>
        </div>
      </div>
    </div>
  );
}

// Excel tablosunda "Hareket" sütunu — şube ayrı sütunda olduğu için kısa ad
const IZ_AD = { teslim_alim: 'Teslim geldi', teslim_cikis: 'Teslim edildi', kapanis: 'Kapanış nakdi', dis: 'Dış giriş',
  acilis: 'Açılış', tasima: 'Taşıma', odeme: 'Ödeme', sayim: 'Sayım farkı', cozum: 'Fark çözüldü', pos_yatis: 'POS yatışı' };

// ─── Çekmece (taslağın yüzü): Özet · İz, satırlar kapı, geri yolu ───
function Cekmece({ v, onKapat }) {
  const [sekme, setSekme] = useState('ozet');
  useEffect(() => { setSekme(v?.varsayilan || 'ozet'); }, [v?.tip, v?.baslik, v?.varsayilan]);
  useEffect(() => {
    if (!v) return undefined;
    const f = (e) => { if (e.key === 'Escape') onKapat(); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [v, onKapat]);
  if (!v) return null;
  const izVar = !!((v.iz && v.iz.length) || (v.tablo && v.tablo.satirlar.length));
  return (
    <div className="pi-ck-arka" onClick={onKapat}>
      <aside className="pi-ck" role="dialog" aria-modal="true" aria-label={v.baslik} onClick={(e) => e.stopPropagation()}
        style={v.tablo ? { width: 'min(960px, 100vw)' } : undefined}>
        <div className="pi-ck-bas">
          {v.geri && <button type="button" onClick={v.geri.onTikla} style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--pi-accent)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 12.5 }}>‹ {v.geri.ad}</button>}
          <div className="pi-eyebrow">{v.tip}</div>
          <h2>{v.baslik}</h2>
          {v.alt && <div style={{ color: 'var(--pi-ink3)', fontSize: 12.5 }}>{v.alt}</div>}
          <div style={{ position: 'absolute', top: 14, right: 16 }}><Dugme kucuk onClick={onKapat}>Kapat</Dugme></div>
        </div>
        {izVar && (
          <div className="pi-ck-sekme" role="tablist">
            {(v.tablo ? [['iz', v.tablo.ad || 'Hareketler'], ['ozet', 'Özet']] : [['ozet', 'Özet'], ['iz', 'İz']]).map(([k, a]) => <button key={k} type="button" role="tab" aria-selected={sekme === k} onClick={() => setSekme(k)}>{a}</button>)}
          </div>
        )}
        <div className="pi-ck-govde">
          {sekme === 'ozet' || !izVar ? (<>
            {!!(v.kpi && v.kpi.length) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
                {v.kpi.map((k) => (
                  <div key={k.etiket} style={{ ...kart, background: 'var(--pi-bg)', padding: '9px 11px' }}>
                    <div style={etiketStil}>{k.etiket}</div>
                    <div style={{ ...num, fontSize: 16, color: k.renk || R.krem }}>{k.deger}</div>
                  </div>
                ))}
              </div>
            )}
            {v.not && <div style={{ fontSize: 12.5, color: R.metin2, padding: '9px 12px', borderRadius: 9, background: 'var(--pi-bg)' }}>{v.not}</div>}
            {!!(v.satirlar && v.satirlar.length) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {v.listeBaslik && <div style={etiketStil}>{v.listeBaslik}</div>}
                {v.satirlar.map((x, i) => {
                  const ic = (<>
                    <span style={{ minWidth: 0, opacity: x.solgun ? 0.6 : 1 }}>{x.ad}{x.detay && <small>{x.detay}</small>}</span>
                    <span style={num}>{x.tutar || ''}</span>
                    <span style={{ color: 'var(--pi-accent)', fontWeight: 600 }}>{x.onTikla ? '›' : ''}</span>
                  </>);
                  return x.onTikla
                    ? <button key={i} type="button" className="pi-kapi" onClick={x.onTikla}>{ic}</button>
                    : <div key={i} className="pi-kapi">{ic}</div>;
                })}
              </div>
            )}
            {!!(v.aksiyonlar && v.aksiyonlar.length) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {v.aksiyonlar.map((a) => <Dugme key={a.ad} ana={a.birincil} onClick={() => { onKapat(); a.onTikla?.(); }}>{a.ad}</Dugme>)}
              </div>
            )}
          </>) : v.tablo ? (
            <div style={{ overflowX: 'auto', border: '1px solid var(--pi-line)', borderRadius: 10 }}>
              <table className="pi-tablo pi-excel">
                <thead><tr>{v.tablo.kolonlar.map((k, i) => <th key={i} style={{ textAlign: k.sag ? 'right' : 'left' }}>{k.ad}</th>)}</tr></thead>
                <tbody>
                  {v.tablo.satirlar.map((r, i) => (
                    <tr key={i}>
                      {r.map((h, j) => (
                        <td key={j} style={{
                          textAlign: v.tablo.kolonlar[j].sag ? 'right' : 'left', whiteSpace: v.tablo.kolonlar[j].sar ? 'normal' : 'nowrap',
                          ...(v.tablo.kolonlar[j].sag ? num : {}), color: (h && h.renk) || 'inherit', fontWeight: (h && h.kalin) ? 600 : 400,
                        }}>{h && typeof h === 'object' ? h.t : (h ?? '—')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="pi-tablo">
                <thead><tr><th>Gün</th><th>Hareket</th></tr></thead>
                <tbody>
                  {v.iz.map((x, i) => (
                    <tr key={i}>
                      <td style={{ ...num, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{x.zaman}</td>
                      <td style={{ textAlign: 'left', color: x.renk || R.krem }}>{x.ad}{x.detay && <div style={{ fontSize: 12, color: R.not }}>{x.detay}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ─── TESLİM ONAYLARI sekmesi (sahip: "teslim onayları için ayrı bir sekme yap") ───
function TeslimSekmesi({ onToast, onDegisti }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [say, setSay] = useState({});
  const [acikGiris, setAcikGiris] = useState({});   // "Farklı saydım" açılan satırlar
  const [duz, setDuz] = useState({});               // düzeltme girişi açık satırlar
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api('/evvel-yeni/kasa/teslimler'); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  // Sahip: "annem 65 yaşında, her gün nasıl onaylayacak?" → TEK DOKUNUŞ: rakam yazmadan
  // "aldım, tuttu"; yalnız farklıysa tutar yazılır. Dokunulmazsa ertesi gün kendiliğinden kabul.
  const al = async (x, tutar) => {
    const t = tutar !== undefined ? tutar : say[x.id];
    if (t === undefined || t === '') { onToast?.('Önce saydığın tutarı yaz'); return; }
    try {
      await api(`/evvel-yeni/kasa/hareket/${x.id}/onay`, { method: 'POST', body: { alinan: Number(t) } });
      const f = x.tutar - Number(t);
      onToast?.(f ? `Alındı — ${fmt(Math.abs(f))} ₺ ${f > 0 ? 'eksik' : 'fazla'}, açık farka yazıldı` : 'Alındı, tuttu');
      setSay((s0) => { const k = { ...s0 }; delete k[x.id]; return k; });
      setAcikGiris((s0) => ({ ...s0, [x.id]: false }));
      yukle(); onDegisti?.();
    } catch (e) { onToast?.(e.message); }
  };
  const duzelt = async (x) => {
    const t = duz[x.id];
    if (t === undefined || t === '') { onToast?.('Saydığın tutarı yaz'); return; }
    try {
      await api(`/evvel-yeni/kasa/hareket/${x.id}/teslim-duzelt`, { method: 'POST', body: { alinan: Number(t) } });
      onToast?.('Düzeltildi — fark açık farka yazıldı');
      setDuz((s0) => { const k = { ...s0 }; delete k[x.id]; return k; });
      yukle(); onDegisti?.();
    } catch (e) { onToast?.(e.message); }
  };
  if (hata && !v) return <div style={{ ...kart, padding: 16, color: R.kirmizi }}>Teslimler okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div>;
  if (!v) return <div style={{ color: R.not }}>Teslimler okunuyor…</div>;
  const gruplar = v.patron_ozet.map((p) => ({ ...p, satirlar: v.bekleyen.filter((x) => x.hedef === p.hedef) }));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...kart, padding: '10px 14px', fontSize: 13, color: R.metin2, background: 'var(--pi-bg)' }}>
        Teslimi alınca <b>tek dokunuşla</b> "aldım" demek yeterli. Hiç dokunulmazsa teslim <b>ertesi gün kendiliğinden kabul</b> edilir.
        Eksik çıkarsa {v.duzeltme_suresi_gun} gün içinde "Düzelt" ile yazılır ya da evdeki sayımda ortaya çıkar.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <div style={{ ...kart, padding: '12px 14px', background: 'var(--pi-accent-soft)' }}>
          <div style={etiketStil}>Yolda · "aldım" bekliyor</div>
          <div style={{ ...num, fontSize: 26, color: R.bakirAcik, fontWeight: 600 }}>{tl(v.bekleyen_toplam)}</div>
          <div style={{ fontSize: 12, color: R.not }}>{v.bekleyen.length} teslim</div>
        </div>
        {v.patron_ozet.map((p) => (
          <div key={p.hedef} style={{ ...kart, padding: '12px 14px', borderLeft: `4px solid ${R.amber}` }}>
            <div style={etiketStil}>{p.ad}</div>
            <div style={{ ...num, fontSize: 20 }}>{tl(p.tutar)}</div>
            <div style={{ fontSize: 12, color: R.amber, fontWeight: 600 }}>● {p.adet} teslim bekliyor</div>
          </div>
        ))}
      </div>

      {v.bekleyen.length === 0 ? (
        <div style={{ ...kart, padding: 18, textAlign: 'center', color: R.yesil, fontWeight: 600 }}>Bekleyen teslim yok — hepsi alındı.</div>
      ) : gruplar.map((g) => (
        <div key={g.hedef} style={{ ...kart, overflow: 'hidden' }}>
          <div style={{ padding: '9px 14px', background: 'var(--pi-accent-soft)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <b>{g.ad}</b><span style={{ ...num, color: R.not }}>{g.adet} teslim · {tl(g.tutar)}</span>
          </div>
          {g.satirlar.map((x) => (
            <div key={x.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '10px 14px', borderTop: `1px solid ${R.cizgi}` }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {x.kaynak_ad} → {x.hedef_kisa}
                  <Cip tur={x.yas_gun >= 3 ? 'kirmizi' : 'sari'}>{x.yas_gun === 0 ? 'bugün' : `${x.yas_gun} gündür`}</Cip>
                  {x.eski_sistem && <Cip>eski sistemden</Cip>}
                </div>
                <div style={{ fontSize: 12, color: R.not }}>{tUzun(x.tarih)} teslim edildi · <span style={num}>{fmt(x.tutar)}</span> ₺{x.kaydeden ? ` · ${x.kaydeden}` : ''}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {!acikGiris[x.id] ? (<>
                  <button type="button" onClick={() => al(x, x.tutar)} style={{
                    padding: '12px 20px', borderRadius: 12, border: '1px solid var(--pi-good)', background: 'var(--pi-good)',
                    color: 'var(--pi-on-accent)', font: 'inherit', fontSize: 16, fontWeight: 700, cursor: 'pointer', minHeight: 48,
                  }}>✓ Aldım, tuttu</button>
                  <button type="button" onClick={() => setAcikGiris((s0) => ({ ...s0, [x.id]: true }))} style={{
                    border: 'none', background: 'transparent', color: R.not, textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
                  }}>Farklı saydım</button>
                </>) : (<>
                  <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="saydığın tutar" aria-label="Saydığın tutar" autoFocus
                    value={say[x.id] ?? ''} onChange={(e) => setSay((s0) => ({ ...s0, [x.id]: e.target.value }))}
                    style={{ ...alanStil, width: 140, padding: '9px 10px', fontSize: 15 }} />
                  <Dugme ana disabled={say[x.id] === undefined || say[x.id] === ''} onClick={() => al(x)}>Kaydet</Dugme>
                  <Dugme kucuk onClick={() => setAcikGiris((s0) => ({ ...s0, [x.id]: false }))}>Vazgeç</Dugme>
                </>)}
              </div>
            </div>
          ))}
        </div>
      ))}

      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '9px 14px', display: 'flex', justifyContent: 'space-between', gap: 8, borderBottom: `1px solid ${R.cizgi}` }}>
          <b>Alınan teslimler · bu dönem</b>
          {v.farkli_alinan > 0 ? <Cip tur="kirmizi">{v.farkli_alinan} tanesi farklı sayıldı</Cip> : <Cip tur="yesil">hepsi tuttu</Cip>}
        </div>
        {v.alinan.length === 0 ? <div style={{ padding: 14, color: R.not }}>Henüz alınan teslim yok.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="pi-tablo">
              <thead><tr><th>Teslim</th><th>Şube → patron</th><th>Teslim edilen</th><th>Sayılan</th><th>Fark</th><th>Alındı</th><th></th></tr></thead>
              <tbody>
                {v.alinan.map((x) => (
                  <tr key={x.id}>
                    <td style={num}>{tKisa(x.tarih)}</td>
                    <td style={{ textAlign: 'left' }}>{x.kaynak_ad} → {x.hedef_kisa}</td>
                    <td style={num}>{fmt(x.tutar)}</td>
                    <td style={num}>{fmt(x.alinan)}</td>
                    <td style={{ ...num, color: x.fark ? R.kirmizi : R.yesil, fontWeight: 600 }}>{x.fark ? `${x.fark > 0 ? '−' : '+'}${fmt(Math.abs(x.fark))}` : 'tuttu'}</td>
                    <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(x.onay_gunu)}{x.otomatik ? <div><Cip>otomatik kabul</Cip></div> : (x.onaylayan ? <div style={{ fontSize: 11, color: R.not }}>{x.onaylayan}</div> : null)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {x.duzeltilebilir && (duz[x.id] === undefined ? (
                        <Dugme kucuk onClick={() => setDuz((s0) => ({ ...s0, [x.id]: '' }))}>Düzelt</Dugme>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4 }}>
                          <input type="number" min="0" step="0.01" inputMode="decimal" placeholder="sayılan" aria-label="Gerçekte sayılan" value={duz[x.id]}
                            onChange={(e) => setDuz((s0) => ({ ...s0, [x.id]: e.target.value }))} style={{ ...alanStil, width: 100, padding: '4px 6px' }} />
                          <Dugme kucuk ana disabled={duz[x.id] === ''} onClick={() => duzelt(x)}>Kaydet</Dugme>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── BANKA MUTABAKATI sekmesi (sahip: "her ay ekstreyi senin mantığınla kontrol eder,
// programdan karşılaştırmasını yaparız") — rakamların hepsi sunucudan; ekran yalnız dizer.
function BankaSekmesi({ onToast, onDegisti }) {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ekstre, setEkstre] = useState({});
  const [acik, setAcik] = useState({});
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/kasa/banka-mutabakat?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);
  const karsilastir = async (b) => {
    const anahtar = `${v.ay}|${b.cep}`;
    const t = ekstre[anahtar];
    if (t === undefined || t === '') { onToast?.('Ekstredeki bakiyeyi yaz'); return; }
    try {
      await api('/evvel-yeni/kasa/hareket', { method: 'POST', body: { tur: 'sayim', cep: b.cep, is_gunu: v.kesit, sayilan: Number(t) } });
      onToast?.('Ekstre bakiyesi kaydedildi');
      setEkstre((x) => { const k = { ...x }; delete k[anahtar]; return k; });
      yukle(); onDegisti?.();
    } catch (e) { onToast?.(e.message); }
  };
  if (hata && !v) return <div style={{ ...kart, padding: 16, color: R.kirmizi }}>Mutabakat okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div>;
  if (!v) return <div style={{ color: R.not }}>Mutabakat okunuyor…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...kart, padding: '10px 14px', fontSize: 13, color: R.metin2, background: 'var(--pi-bg)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Ay sonunda bankanın ekstresini aç: programın hesapladığı <b>ay sonu bakiyesi</b> ekstredekiyle aynı mı? Ekstre bakiyesini yaz, fark varsa açık farka düşer.</span>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>Ay
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)} style={{ ...alanStil, width: 'auto', padding: '5px 8px' }} />
        </label>
      </div>
      {!v.ay_bitti && <div style={{ fontSize: 12.5, color: R.amber }}>Bu ay henüz bitmedi — rakamlar {tUzun(v.kesit)} itibarıyla.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        {v.bankalar.map((b) => {
          const e = b.ekstre;
          const an = `${v.ay}|${b.cep}`;
          const renk = b.acik_farklar.length ? R.kirmizi : !e ? R.cizgi : R.yesil;
          return (
            <div key={b.cep} style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `4px solid ${renk}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <b style={{ fontSize: 15 }}>{b.ad}</b>
                {b.kira ? <Cip tur="bakir">kira · işletmeden ayrı</Cip> : b.tur === 'hesap' ? <Cip>geçiş hesabı</Cip> : null}
              </div>
              <table className="pi-tablo">
                <tbody>
                  <tr><td>Ay başı bakiye</td><td style={num}>{fmt(b.ay_basi)}</td></tr>
                  {b.giris.map((g) => <tr key={`g${g.ad}`}><td style={{ color: R.metin2 }}>+ {g.ad}</td><td style={{ ...num, color: R.yesil }}>{fmt(g.tutar)}</td></tr>)}
                  {b.cikis.map((g) => <tr key={`c${g.ad}`}><td style={{ color: R.metin2 }}>− {g.ad}</td><td style={{ ...num, color: R.kirmizi }}>{fmt(g.tutar)}</td></tr>)}
                  <tr><td><b>Programa göre ay sonu</b></td><td style={{ ...num, fontWeight: 700 }}>{fmt(b.program_ay_sonu)}</td></tr>
                </tbody>
              </table>
              {(b.ekstreler || []).map((x) => (
                <div key={x.gun} style={{ padding: '8px 12px', borderRadius: 9, fontSize: 13, background: x.fark ? 'var(--pi-bad-soft)' : 'var(--pi-good-soft)', color: x.fark ? R.kirmizi : R.yesil, fontWeight: 600 }}>
                  Ekstre {tUzun(x.gun)}: <span style={num}>{fmt(x.bakiye)}</span> ₺ · {x.fark ? `${fmt(Math.abs(x.fark))} ₺ ${x.fark > 0 ? 'eksik' : 'fazla'} → açık farka düştü` : 'TUTTU ✓'}
                </div>
              ))}
              {b.duzeltme_sonrasi !== b.program_ay_sonu && <div style={{ fontSize: 12, color: R.not }}>Ekstre düzeltmesi sonrası bakiye: <b style={num}>{fmt(b.duzeltme_sonrasi)}</b> ₺</div>}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="number" step="0.01" inputMode="decimal" placeholder={`ekstredeki ${tUzun(v.kesit)} bakiyesi`} aria-label={`${b.ad} ekstre bakiyesi`}
                  value={ekstre[an] ?? ''} onChange={(ev) => setEkstre((x) => ({ ...x, [an]: ev.target.value }))} style={{ ...alanStil, flex: 1, minWidth: 160 }} />
                <Dugme ana disabled={ekstre[an] === undefined || ekstre[an] === ''} onClick={() => karsilastir(b)}>{e ? 'Yeni ekstre' : 'Karşılaştır'}</Dugme>
              </div>
              {b.acik_farklar.length > 0 && <div style={{ fontSize: 12, color: R.kirmizi }}>● {b.acik_farklar.length} açık fark çözülmeyi bekliyor (Açık farklar sayfası)</div>}
              {b.satir_sayisi > 0 && (
                <div>
                  <button type="button" onClick={() => setAcik((x) => ({ ...x, [b.cep]: !x[b.cep] }))} style={{ border: 'none', background: 'transparent', color: 'var(--pi-accent)', cursor: 'pointer', font: 'inherit', fontSize: 12.5, padding: 0 }}>
                    {acik[b.cep] ? '▾' : '▸'} Ayın {b.satir_sayisi} hareketi — ekstreyle satır satır karşılaştır
                  </button>
                  {acik[b.cep] && (
                    <div style={{ overflowX: 'auto', marginTop: 6, border: '1px solid var(--pi-line)', borderRadius: 10 }}>
                      <table className="pi-tablo pi-excel">
                        <thead><tr><th>Gün</th><th style={{ textAlign: 'left' }}>Hareket</th><th style={{ textAlign: 'left' }}>Şube</th><th style={{ textAlign: 'left' }}>Kim</th><th>Giren</th><th>Çıkan</th></tr></thead>
                        <tbody>
                          {b.satirlar.map((x, i) => (
                            <tr key={i}>
                              <td style={{ ...num, whiteSpace: 'nowrap' }}>{tKisa(x.gun)}</td>
                              <td style={{ textAlign: 'left' }}>{IZ_AD[x.tur] || x.etiket}{x.otomatik ? <span style={{ color: R.not }}> · otomatik</span> : null}</td>
                              <td style={{ textAlign: 'left' }}>{x.sube || '—'}</td>
                              <td style={{ textAlign: 'left' }}>{x.personel || '—'}</td>
                              <td style={{ ...num, color: R.yesil }}>{x.d > 0 ? fmt(x.d) : ''}</td>
                              <td style={{ ...num, color: R.kirmizi }}>{x.d < 0 ? fmt(-x.d) : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────── ANA MODÜL ───────────────────────────
// Sahip: "Sadece kasam görünür; buraya tıkladığımda şubelerin kasaları, evde bulunan
// paralar vs. kart hâlinde görünür — gibi düşün." → her konu kendi SAYFASI (sol menü).
export const SAYFALAR = [
  { id: 'kasam', ad: 'Kasam', alt: 'Toplam kasa · gruplar' },
  { id: 'subeler', ad: 'Dükkân nakitleri', alt: 'Çekmecedeki nakit · şube şube' },
  { id: 'evler', ad: 'Evler', alt: 'Onur · Fethi · Fatma' },
  { id: 'bankalar', ad: 'Bankalar', alt: 'Şube bankaları · kira · geçiş' },
  { id: 'hareketler', ad: 'Günlük hareketler', alt: 'Gün seç, ne oldu' },
  { id: 'isler', ad: 'Bekleyen işler', alt: 'Onaylar · farklar' },
  { id: 'teslim', ad: 'Teslim onayları', alt: 'Şubeden patrona' },
  { id: 'banka', ad: 'Banka mutabakatı', alt: 'Aylık ekstre kontrolü' },
  { id: 'farklar', ad: 'Açık farklar', alt: 'Gün gün defter' },
];
const SEVIYE_SIRA = { kirmizi: 3, sari: 2, yesil: 1, gri: 0 };

export default function KasaModulu({ gorunum, onToast, onSekme, sekmesiz, onVeri }) {
  const [ck, setCk] = useState(null);
  const sayfaCoz = (g) => (SAYFALAR.some((x) => x.id === g) ? g : 'kasam');
  const [sekme, setSekme] = useState(sayfaCoz(gorunum));
  useEffect(() => { if (gorunum) setSekme(sayfaCoz(gorunum)); }, [gorunum]);   // eslint-disable-line react-hooks/exhaustive-deps
  const git = (k) => { setSekme(k); onSekme?.(k); };
  const onCekmece = setCk;   // aşağıdaki çekmece çağrıları aynı kalır, Evvel kabuğuna değil buraya açılır
  const [gun, setGun] = useState(() => {
    try { return localStorage.getItem('paraIziGun') || iso(new Date()); } catch { return iso(new Date()); }
  });
  const [hepsi, setHepsi] = useState(false);
  const [veri, setVeri] = useState(null);
  const [hata, setHata] = useState(null);
  const [form, setForm] = useState(null);
  const yigin = useRef([]);
  const islerRef = useRef(null);
  // ⚠️ İSTEK SIRASI (Codex): gün hızlı değişince eski yanıt yenisini ezmesin.
  const istekNo = useRef(0);
  const cekmeceNo = useRef(0);
  const [sonYukleme, setSonYukleme] = useState(null);

  const yukle = useCallback(async () => {
    const no = ++istekNo.current;
    setHata(null);
    try {
      const r = await api(`/evvel-yeni/kasa/durum?gun=${gun}${hepsi ? '&hepsi=true' : ''}`);
      if (no !== istekNo.current) return;
      setVeri(r); setSonYukleme(new Date());
    } catch (e) { if (no === istekNo.current) setHata(e?.message || 'okunamadı'); }
  }, [gun, hepsi]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => { try { localStorage.setItem('paraIziGun', gun); } catch { /* yut */ } }, [gun]);

  const cepAd = (id) => (veri?.cepler.find((c) => c.id === id) || {}).ad || id;
  // Formu çekmeceden açınca kapanışta aynı çekmeceye geri dönülür (Codex: geldiği yere dönemiyordu).
  const formAc = (tip, ek = {}, donus = null) => { cekmeceNo.current += 1; onCekmece?.(null); setForm({ tip, ...ek, donus }); };
  const teyit = async (id) => {
    try { await api(`/evvel-yeni/kasa/hareket/${id}/onay`, { method: 'POST', body: {} }); onToast?.('Onaylandı'); yukle(); } catch (e) { onToast?.(e.message); }
  };
  const [topluSor, setTopluSor] = useState(false);
  const topluOnay = async (idler) => {
    try {
      const r = await api('/evvel-yeni/kasa/onay-toplu', { method: 'POST', body: { idler } });
      onToast?.(`${r.onaylanan} kapanış onaylandı`); setTopluSor(false); yukle();
    } catch (e) { onToast?.(e.message); }
  };
  const teslimAl = async (id, sayilan) => {
    if (sayilan === '' || sayilan == null || Number.isNaN(Number(sayilan))) { onToast?.('Önce saydığın tutarı yaz'); return; }
    try { await api(`/evvel-yeni/kasa/hareket/${id}/onay`, { method: 'POST', body: { alinan: Number(sayilan) } }); onToast?.('Teslim alındı'); yukle(); } catch (e) { onToast?.(e.message); }
  };

  // ── ÇEKMECE: satırlar kapı, geri yolu yığından ──
  const cekmeceAc = useCallback(async (g, kok) => {
    if (kok) yigin.current = [];
    yigin.current.push(g);
    const no = ++cekmeceNo.current;
    const guncel = () => no === cekmeceNo.current;
    const onc = yigin.current[yigin.current.length - 2];
    const geri = onc ? { ad: onc.ad, onTikla: () => { yigin.current.pop(); const p = yigin.current.pop(); cekmeceAc(p, false); } } : undefined;
    const temel = { geri, onKapat: () => onCekmece?.(null) };
    onCekmece?.({ ...temel, tip: g.tip, baslik: g.ad, alt: 'okunuyor…' });
    try {
      if (g.tur === 'cep') {
        const r = await api(`/evvel-yeni/kasa/cep/${encodeURIComponent(g.id)}?gun=${gun}${hepsi ? '&hepsi=true' : ''}`);
        if (!guncel()) return;
        const c = r.cep;
        g.ad = c.ad;
        onCekmece?.({
          ...temel, tip: { ev: 'PATRON EVİ', sube: 'ŞUBE KASASI', hesap: 'GEÇİŞ HESABI' }[c.tur], baslik: c.ad,
          alt: hepsi ? 'Şu an' : `${tUzun(gun)} akşamı`,
          kpi: [
            { etiket: 'Bakiye', deger: tl(c.bakiye), renk: R.krem },
            { etiket: 'Gelen', deger: tl(c.gelen_toplam), renk: R.yesil },
            { etiket: 'Çıkan', deger: tl(c.cikan), renk: R.kirmizi },
          ],
          not: [...c.kirmizi.map((t) => `🔴 ${t}`), ...c.sari.map((t) => `🟡 ${t}`)].join(' · ') || 'Sorun yok.',
          listeBaslik: 'Bu bakiye nereden geldi · farklar',
          satirlar: [
            ...c.gelen.map((x) => ({
              ad: x.kaynak, detay: x.cep ? 'kaynağın çekmecesi ›' : '', tutar: tl(x.tutar),
              onTikla: x.cep ? () => cekmeceAc({ tur: 'cep', id: x.cep, ad: x.kaynak }, false) : undefined,
            })),
            ...r.farklar.map((x) => ({
              ad: `${x.coz ? '✓' : '🔴'} ${x.ad}`, detay: `${tUzun(x.tarih)} · ${x.coz ? `kapandı: ${x.coz.sebep_ad}` : 'çözülmedi'}`,
              tutar: tl(Math.abs(x.f)), onTikla: () => cekmeceAc({ tur: 'fark', id: x.id, ad: x.ad }, false),
            })),
          ],
          // 📊 Sahip: "kasada nakit geleni Excel tablosu gibi; tıkladığımızda teslim şubesi ve
          // teslimi yapan personel görünmeli" → cebe tıklayınca İLK bu tablo açılır.
          varsayilan: 'iz',
          tablo: {
            ad: 'Nakit hareketleri',
            kolonlar: [{ ad: 'Gün' }, { ad: 'Hareket', sar: true }, { ad: 'Şube' }, { ad: 'Teslim eden / yapan' }, { ad: 'Alan' },
              { ad: 'Giren', sag: true }, { ad: 'Çıkan', sag: true }, { ad: 'Bakiye', sag: true }],
            satirlar: r.iz.map((x) => [
              tKisa(x.tarih), IZ_AD[x.tur] || x.etiket, x.sube || '—', x.personel || '—', x.alan || '—',
              x.d > 0 ? { t: fmt(x.d), renk: R.yesil } : '', x.d < 0 ? { t: fmt(-x.d), renk: R.kirmizi } : '',
              { t: fmt(x.bakiye), kalin: true, renk: x.bakiye < 0 ? R.kirmizi : undefined },
            ]),
          },
          aksiyonlar: [{ ad: 'Bu cebi say', birincil: true, onTikla: () => formAc('sayim', { cep: c.id }, { tur: 'cep', id: c.id, ad: c.ad }) }],
        });
      } else if (g.tur === 'fark') {
        const f = await api(`/evvel-yeni/kasa/fark/${g.id}`);
        if (!guncel()) return;
        g.ad = f.ad;
        onCekmece?.({
          ...temel, tip: f.tur === 'teslim' ? 'TESLİM FARKI' : 'SAYIM FARKI', baslik: f.ad, alt: tUzun(f.tarih),
          kpi: [
            { etiket: f.f > 0 ? 'Eksik' : 'Fazla', deger: tl(Math.abs(f.f)), renk: R.kirmizi },
            { etiket: 'Durum', deger: f.coz ? 'Kapandı' : 'Açık', renk: f.coz ? R.yesil : R.kirmizi },
          ],
          not: f.coz ? `${f.coz.sebep_ad} · ${tUzun(f.coz.tarih)}${f.coz.sorumlu ? ` · sorumlu: ${f.coz.sorumlu}` : ''}${f.coz.kaydeden ? ` · kaydeden: ${f.coz.kaydeden}` : ''}${f.coz.not ? ` · ${f.coz.not}` : ''}`
            : 'Para silinmedi, gider de sayılmadı. Sebebi bulunana kadar "açık fark" olarak bekliyor.',
          listeBaslik: 'İlgili cepler',
          satirlar: [
            { ad: 'Farkın görüldüğü yer', detay: f.cep_ad, onTikla: () => cekmeceAc({ tur: 'cep', id: f.cep, ad: f.cep_ad }, false) },
            ...(f.sube_cep ? [{ ad: 'Teslim eden', detay: f.sube_cep_ad, onTikla: () => cekmeceAc({ tur: 'cep', id: f.sube_cep, ad: f.sube_cep_ad }, false) }] : []),
          ],
          aksiyonlar: f.coz ? [] : [{ ad: 'Farkı çöz', birincil: true, onTikla: () => formAc('coz', { id: f.id }, { tur: 'fark', id: f.id, ad: f.ad }) }],
        });
      } else if (g.tur === 'acik') {
        const a = await api('/evvel-yeni/kasa/acik-defter');
        if (!guncel()) return;
        const acik = a.farklar.filter((x) => !x.coz);
        onCekmece?.({
          ...temel, tip: 'AÇIK FARKLAR DEFTERİ', baslik: 'Açık farklar', alt: 'Gün gün toplam açık · İz sekmesinde',
          kpi: [
            { etiket: 'Açık eksik', deger: tl(a.acik_eksik), renk: a.acik_eksik ? R.kirmizi : R.yesil },
            { etiket: 'Açık fazla', deger: tl(a.acik_fazla), renk: a.acik_fazla ? R.amber : R.yesil },
            { etiket: 'Çözülmemiş', deger: `${acik.length} fark`, renk: acik.length ? R.kirmizi : R.yesil },
            { etiket: 'Kayba yazılan', deger: tl(a.kayip), renk: R.kirmizi },
            { etiket: 'Kayıtsız harcama', deger: tl(a.harcanan), renk: R.amber },
          ],
          listeBaslik: 'Farklar · çözülmemişler önce',
          satirlar: [...acik, ...a.farklar.filter((x) => x.coz)].map((x) => ({
            ad: `${x.coz ? '✓' : '🔴'} ${x.ad}`, detay: `${tUzun(x.tarih)} · ${x.coz ? x.coz.sebep_ad : 'çözülmedi'}`,
            tutar: tl(Math.abs(x.f)), solgun: !!x.coz, onTikla: () => cekmeceAc({ tur: 'fark', id: x.id, ad: x.ad }, false),
          })),
          not: a.farklar.length ? null : 'Henüz hiç fark yok.',
          iz: a.gun_gun.slice().reverse().map((x) => ({
            ad: `Gün sonu açık ${tl(x.gun_sonu_acik)}`, zaman: tUzun(x.gun),
            detay: `yeni ${fmt(x.yeni)} · geri dönen ${fmt(x.geri_donen)} · kayba ${fmt(x.kayba_yazilan)} · harcamaya ${fmt(x.harcamaya_yazilan)} · toplam kayıp ${fmt(x.toplam_kayip)} · toplam kayıtsız harcama ${fmt(x.toplam_harcanan)}`,
            renk: x.gun_sonu_acik ? R.kirmizi : R.yesil,
          })),
        });
      }
    } catch (e) {
      if (!guncel()) return;
      onCekmece?.({ ...temel, tip: 'PARA İZİ', baslik: g.ad || 'Ayrıntı', alt: 'okunamadı', not: `Okunamadı: ${e?.message || ''}. Kayıt yok demek DEĞİL.` });
    }
  }, [gun, hepsi]);   // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => { if (veri) onVeri?.(veri); }, [veri]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (hata && !veri) return <HataBandi mesaj="Kasa bilgisi okunamadı" kod={hata} onTekrar={yukle} />;
  if (!veri) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Kasa okunuyor…</div></div>;

  const o = veri.ozet;
  const evler = veri.cepler.filter((c) => c.tur === 'ev');
  const subeler = veri.cepler.filter((c) => c.tur === 'sube');
  const hesaplar = veri.cepler.filter((c) => c.tur === 'hesap');
  const bankalar = veri.cepler.filter((c) => c.tur === 'banka' && !c.kira);
  const kiraHesap = veri.cepler.filter((c) => c.tur === 'banka' && c.kira);
  const acilisEksik = veri.cepler.filter((c) => !(veri.acilis_girilen || []).includes(c.id));
  const deg = veri.degisim;
  const k = veri.kpi;

  const cepAc = (c) => cekmeceAc({ tur: 'cep', id: c.id, ad: c.ad }, true);
  const enKotu = (liste) => liste.reduce((m, c) => (SEVIYE_SIRA[c.seviye] > SEVIYE_SIRA[m] ? c.seviye : m), 'gri');
  const sayfaAd = (SAYFALAR.find((x) => x.id === sekme) || SAYFALAR[0]).ad;
  const guneBagli = ['kasam', 'subeler', 'evler', 'bankalar', 'hareketler'].includes(sekme);
  const KartIzgara = ({ liste }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
      {liste.map((c) => <CepKart key={c.id} c={c} serit onAc={() => cepAc(c)} />)}
    </div>
  );
  // Kasam sayfasının grup kartı: toplam + üye sayısı + en kötü durum; tıklayınca o sayfa
  const GrupKart = ({ ad, tutar, liste, hedef, alt, renk, deger }) => {
    const sv = renk || enKotu(liste || []);
    const kenar = { kirmizi: R.kirmizi, sari: R.amber, yesil: R.yesil, gri: 'var(--pi-line)' }[sv];
    const kir = (liste || []).filter((c) => c.seviye === 'kirmizi').length;
    const sar = (liste || []).filter((c) => c.seviye === 'sari').length;
    return (
      <button type="button" onClick={() => git(hedef)} style={{
        ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: R.krem, padding: '14px 16px',
        borderLeft: `5px solid ${kenar}`, display: 'flex', flexDirection: 'column', gap: 4, minHeight: 118,
      }}>
        <span style={etiketStil}>{ad}</span>
        <span style={{ ...num, fontSize: 24, fontWeight: 700 }}>{deger ?? tl(tutar)}</span>
        {alt && <span style={{ fontSize: 12.5, color: R.metin2 }}>{alt}</span>}
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
          {kir > 0 && <Cip tur="kirmizi">{kir} kırmızı</Cip>}
          {sar > 0 && <Cip tur="sari">{sar} dikkat</Cip>}
          {liste && !kir && !sar && <Cip tur="yesil">temiz</Cip>}
          <span style={{ marginLeft: 'auto', color: 'var(--pi-accent)', fontWeight: 700 }}>›</span>
        </span>
      </button>
    );
  };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <style>{PI_CSS}</style>
      {/* BAŞLIK + TOPLAM KASA (her sayfada küçük) */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="pi-eyebrow">Evvel Yeni · Para · dönem {tUzun(veri.baslangic)}</div>
          <h1 style={{ fontSize: 30 }}>{sayfaAd}</h1>
        </div>
        {sekme !== 'kasam' && (
          <button type="button" onClick={() => git('kasam')} style={{ marginLeft: 'auto', padding: '8px 14px', borderRadius: 12, background: 'var(--pi-accent-soft)', border: '1px solid var(--pi-line)', cursor: 'pointer', font: 'inherit', color: R.krem, textAlign: 'left' }}>
            <div className="pi-eyebrow">Toplam kasa · {hepsi ? 'şu an' : `${tUzun(gun)} akşamı`}</div>
            <div style={{ ...num, fontSize: 22, fontWeight: 700, color: R.bakirAcik }}>{tl(o.hepsi)}</div>
          </button>
        )}
      </div>

      {sekme === 'banka' ? <BankaSekmesi onToast={onToast} onDegisti={yukle} />
        : sekme === 'teslim' ? <TeslimSekmesi onToast={onToast} onDegisti={yukle} />
        : sekme === 'farklar' ? <AcikSayfa onCoz={(id) => formAc('coz', { id })} onCepAc={(id, ad) => cekmeceAc({ tur: 'cep', id, ad }, true)} yenile={veri.hareket_sayisi} />
        : (<>
      {/* KAYIT GİR + GÜN SEÇİCİ */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Dugme ana onClick={() => formAc('dis')}>+ Dış giriş</Dugme>
        <Dugme ana onClick={() => formAc('teslim')}>+ Teslim</Dugme>
        <Dugme ana onClick={() => formAc('tasima')}>+ Taşı / Yatır</Dugme>
        <Dugme ana onClick={() => formAc('sayim')}>+ Sayım</Dugme>
        <Dugme ana onClick={() => formAc('pos')}>+ Online yattı</Dugme>
        <Dugme onClick={() => (onSekme ? onSekme('odemeler') : formAc('odeme'))}>+ Ödeme</Dugme>
        <Dugme onClick={() => formAc('kapanis')}>+ Kapanış</Dugme>
        {/* Fable P3: büyük ve tehlikeli iki düğme gözden uzak "Ayarlar" içinde */}
        <details style={{ fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: R.not, padding: '6px 4px' }}>⚙️ Ayarlar</summary>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <Dugme kucuk onClick={() => formAc('aktar')} title="Dönem başından bu yana kapanış ve teslimleri eski sistemden okur">Eski sistemden aktar</Dugme>
            <Dugme kucuk onClick={() => formAc('donem')} title="Önceki kayıtlar arşive geçer; her cep sayılıp yeniden başlanır">Yeni başlangıç</Dugme>
          </div>
        </details>
        {guneBagli && <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <Dugme kucuk disabled={hepsi || gun <= veri.baslangic} onClick={() => setGun(gunEkle(gun, -1))}>‹</Dugme>
          <input type="date" value={gun} min={veri.baslangic} max={veri.bugun} disabled={hepsi} onChange={(e) => e.target.value && setGun(e.target.value)}
            style={{ ...alanStil, width: 'auto', padding: '5px 8px' }} aria-label="Gün" />
          <Dugme kucuk disabled={hepsi || gun >= veri.bugun} onClick={() => setGun(gunEkle(gun, 1))}>›</Dugme>
          <Dugme kucuk onClick={() => { setGun(veri.bugun); setHepsi(false); }}>Bugün</Dugme>
          <Dugme kucuk ana={hepsi} onClick={() => setHepsi(!hepsi)}>Tüm günler</Dugme>
        </div>}
      </div>
      {hata && veri && (
        <div style={{ ...kart, padding: '9px 14px', borderColor: `${alfa(R.kirmizi, 55)}`, fontSize: 12.5, color: R.kirmizi, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          Güncellenemedi: {hata}. Ekrandaki rakamlar {sonYukleme ? sonYukleme.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : 'önceki'} itibarıyla — güncel olmayabilir.
          <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme>
        </div>
      )}
      {veri.senkron && (veri.senkron.tamam === false ? (
        <div style={{ fontSize: 12, color: R.kirmizi }}>Eski sistemden köprü çalışmadı: {veri.senkron.hata}</div>
      ) : veri.senkron.zaman ? (
        <div style={{ fontSize: 11.5, color: R.not2 }}>
          Eski sistemle yan yana · köprü {new Date(veri.senkron.zaman).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
          {(veri.senkron.kapanis || veri.senkron.teslim) ? ` · yeni: ${veri.senkron.kapanis} kapanış, ${veri.senkron.teslim} teslim` : ' · yeni kayıt yok'}
          {veri.senkron.eslesmeyen_teslim ? <span style={{ color: R.amber }}> · {veri.senkron.eslesmeyen_teslim} teslim alıcısı tanınmadı</span> : null}
        </div>
      ) : null)}
      {acilisEksik.length > 0 && sekme === 'kasam' && (
        <div style={{ ...kart, padding: '10px 14px', borderColor: `${alfa(R.amber, 55)}`, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <Cip tur="sari">Başlangıç</Cip>
          <span style={{ color: R.metin2 }}>{acilisEksik.length} cebin {tUzun(veri.baslangic)} açılış bakiyesi girilmedi ({acilisEksik.map((c) => c.kisa).join(', ')}). Girilmeden rakamlar eksik başlar.</span>
          <Dugme kucuk ana onClick={() => formAc('acilis', { cep: acilisEksik[0].id })}>Açılış bakiyesi gir</Dugme>
        </div>
      )}

      {sekme === 'kasam' && (<>
        <div style={{ ...kart, padding: '16px 20px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={etiketStil}>Toplam kasa · {hepsi ? 'şu an' : `${tUzun(gun)} akşamı`}</div>
            <div style={{ ...num, fontSize: 40, fontWeight: 700, color: R.bakirAcik, lineHeight: 1.05 }}>{tl(o.hepsi)}</div>
            {deg != null && <div style={{ fontSize: 12.5, color: R.metin2, marginTop: 4 }}>Önceki akşama göre <b style={{ ...num, color: deg < 0 ? R.kirmizi : deg > 0 ? R.yesil : R.metin2 }}>{deg > 0 ? '+' : ''}{fmt(deg)}</b></div>}
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {[['İşletme parası', o.toplam], ['Nakit', o.nakit], ['Banka', o.banka], ['Kira hesabı', o.kira]].map(([a, v]) => (
              <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 17 }}>{fmt(v)}</div></div>
            ))}
          </div>
          {veri.pos_bekleyen_brut > 0 && <div style={{ marginLeft: 'auto', fontSize: 12.5, color: R.amber }}>Toplama dahil değil · POS/online bankaya gelecek (brüt) <b style={num}>{fmt(veri.pos_bekleyen_brut)}</b> ₺</div>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
          <GrupKart ad="Dükkân nakitleri" tutar={o.sube} liste={subeler} hedef="subeler" alt={`${subeler.length} dükkân · çekmecedeki nakit`} />
          <GrupKart ad="Evler" tutar={o.ev} liste={evler} hedef="evler" alt={evler.map((c) => c.kisa).join(' · ')} />
          <GrupKart ad="Bankalar" tutar={o.banka} liste={bankalar} hedef="bankalar" alt={veri.pos_bekleyen_brut > 0 ? `+ ${fmt(veri.pos_bekleyen_brut)} ₺ POS/online gelecek` : `${bankalar.length} şube bankası`} />
          <GrupKart ad="Geçiş + yolda" tutar={o.gecis_yolda} liste={hesaplar} hedef="bankalar" alt={o.yolda >= 0.005 ? `${fmt(o.yolda)} ₺ teslim yolda` : "Fethi'nin hesabı · giren çıkmalı"} />
          <GrupKart ad="Kira hesabı" tutar={o.kira} liste={kiraHesap} hedef="bankalar" alt="İşletmeden ayrı · destek için" />
          <GrupKart ad="Açık farklar" tutar={o.acik_eksik} hedef="farklar" renk={o.acik_fark_sayisi ? 'kirmizi' : 'yesil'}
            alt={o.acik_fark_sayisi ? `${o.acik_fark_sayisi} fark çözülmedi${o.acik_fazla > 0 ? ` · +${fmt(o.acik_fazla)} fazla` : ''}` : 'Çözülmemiş fark yok'} />
          <GrupKart ad="Bekleyen işler" tutar={0} deger={`${veri.isler.length} iş`} hedef="isler" renk={veri.isler.length ? 'sari' : 'yesil'}
            alt={veri.isler.length ? `${veri.isler.length} iş · onay / fark` : 'Hepsi tamam'} />
        </div>
      </>)}

      {sekme === 'subeler' && <KartIzgara liste={subeler} />}
      {sekme === 'evler' && <KartIzgara liste={evler} />}
      {sekme === 'bankalar' && (<>
        <div style={etiketStil}>Şube bankaları</div><KartIzgara liste={bankalar} />
        {veri.pos.length > 0 && (
          <div style={{ ...kart, padding: '10px 14px', fontSize: 12.5, color: R.metin2 }}>
            POS ertesi gün kendiliğinden yatar; online elle girilir. Bankaya gelecek: {veri.pos.filter((x) => x.bekleyen_brut > 0.004).map((x) => `${x.sube} ${x.kanal === 'pos' ? 'POS' : 'online'} ${fmt(x.bekleyen_brut)} ₺`).join(' · ') || 'yok'}
          </div>
        )}
        {hesaplar.length > 0 && (<><div style={etiketStil}>Geçiş hesabı · giren çıkmalı</div><KartIzgara liste={hesaplar} /></>)}
        {kiraHesap.length > 0 && (<><div style={etiketStil}>Kira hesabı · işletmeden ayrı</div><KartIzgara liste={kiraHesap} /></>)}
      </>)}
      {sekme === 'isler' && (
          <div ref={islerRef} style={{ ...kart, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, border: veri.isler.length ? `2px solid ${R.amber}` : kart.border }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Bekleyen işler</span>
              {veri.isler.length ? <Cip tur="kirmizi">{veri.isler.length}</Cip> : <Cip tur="yesil">Hepsi tamam</Cip>}
            </div>
            {(() => {
              const kp = veri.isler.filter((x) => x.tur === 'kapanis');
              if (kp.length < 2) return null;
              return (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, padding: '6px 2px' }}>
                  {!topluSor ? (
                    <Dugme kucuk onClick={() => setTopluSor(true)}>{kp.length} kapanışı toplu onayla</Dugme>
                  ) : (<>
                    <span style={{ color: R.amber }}>{kp.length} kapanış onaylanacak — her birini kontrol ettiysen onayla.</span>
                    <Dugme kucuk ana onClick={() => topluOnay(kp.map((x) => x.id))}>Evet, hepsini onayla</Dugme>
                    <Dugme kucuk onClick={() => setTopluSor(false)}>Vazgeç</Dugme>
                  </>)}
                </div>
              );
            })()}
            {(() => {
              const t = veri.isler.filter((x) => x.tur === 'teslim');
              if (!t.length) return null;
              return (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', borderRadius: 9, background: R.girinti, border: `1px solid ${R.cizgi}` }}>
                  <Cip tur="sari">Teslim onayı</Cip>
                  <span style={{ fontSize: 13 }}><b>{t.length} teslim</b> "aldım" bekliyor · <span style={num}>{fmt(veri.ozet.yolda)}</span> ₺ yolda</span>
                  <span style={{ marginLeft: 'auto' }}><Dugme ana kucuk onClick={() => git('teslim')}>Teslim Onayları ›</Dugme></span>
                </div>
              );
            })()}
            {/* Sahip/Fable: "30 Evo tahmini tek tek çözülemez" → şube başına TEK satır + toplu kabul */}
            {Object.entries(veri.isler.filter((x) => x.tur === 'evo_kapanis').reduce((a, x) => { (a[x.cep] = a[x.cep] || []).push(x); return a; }, {})).map(([cep, xs]) => (
              <div key={`evo${cep}`} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 9, background: R.girinti, border: `1px solid ${alfa(R.amber, 55)}` }}>
                <Cip tur="sari">Evo tahmini · {xs.length} gün</Cip>
                <div style={{ fontSize: 13 }}><b>{xs[0].ad}</b> · {xs.map((x) => tKisa(x.tarih)).join(', ')}
                  <div style={{ fontSize: 11.5, color: R.not }}>Şube bu günlerde kapanış yapmadı; rakam Evo kasasından (nakit {fmt(xs.reduce((a, x) => a + x.nakit, 0))} · kart {fmt(xs.reduce((a, x) => a + x.kart, 0))}). Gerçeğini biliyorsan tek tek gir, bilmiyorsan kabul et.</div></div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <Dugme kucuk onClick={() => formAc('kapanis', { gun: xs[0].tarih, cep })}>Gerçeğini gir</Dugme>
                  <Dugme ana kucuk onClick={async () => {
                    if (!window.confirm(`${xs[0].ad}: ${xs.length} günün Evo rakamı kabul edilsin mi? Rakam değişmez, yalnız uyarı kapanır.`)) return;
                    try { const r = await api('/evvel-yeni/kasa/evo-kabul', { method: 'POST', body: { cep } }); onToast?.(r.mesaj); yukle(); } catch (e) { onToast?.(e.message); }
                  }}>Hepsini kabul et</Dugme>
                </span>
              </div>
            ))}
            {veri.isler.filter((x) => x.tur !== 'teslim' && x.tur !== 'evo_kapanis').map((x) => <IsSatir key={`${x.tur}${x.id}`} x={x} bugun={veri.bugun} onTeyit={teyit} onTeslim={teslimAl} onCoz={(id) => formAc('coz', { id })} onKapanis={(x) => formAc('kapanis', { gun: x.tarih, cep: x.cep })}
              onPosKabul={async (id) => { try { const r = await api('/evvel-yeni/kasa/pos-sifir-kabul', { method: 'POST', body: { id } }); onToast?.(r.mesaj); yukle(); } catch (e) { onToast?.(e.message); } }} />)}
          </div>
      )}
      {sekme === 'hareketler' && (<>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{hepsi ? 'Tüm günler' : tUzun(gun)}</span>
            {!hepsi && <span style={{ color: R.not, fontSize: 12.5 }}>{gunAdi(gun)}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            {[['Satış nakdi', k.satis_nakdi, R.yesil], ['Dış giriş', k.dis_giris, R.yesil], ['Kart (bankaya)', k.kart, R.metin2], ['Bankaya giren', k.bankaya_giren, R.yesil], ['Kiradan destek', k.kiradan_destek, R.bakirAcik], ['Teslim edilen', k.teslim, R.krem], ['Ödenen', k.odenen, R.kirmizi]].map(([a, v, r]) => (
              <div key={a} style={{ ...kart, padding: '8px 11px' }}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 16, color: r }}>{fmt(v)}</div></div>
            ))}
          </div>
          {(veri.gec_alimlar || []).map((x) => (
            <div key={`al${x.id}`} style={{ ...kart, padding: '9px 13px', fontSize: 12.5, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Cip tur="yesil">Teslim alındı</Cip><b>{x.ad}</b><span style={{ color: R.not }}>{tUzun(x.teslim_gunu)} teslimi bugün eve girdi</span>
              <span style={{ ...num, marginLeft: 'auto', color: R.yesil }}>+{fmt(x.alinan)}</span>
            </div>
          ))}
          {(veri.iptaller || []).map((x) => (
            <div key={`ip${x.id}`} style={{ ...kart, padding: '9px 13px', fontSize: 12.5, color: R.not, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Cip>İptal</Cip><span>Bir {TUR_AD[x.hedef_tur] || 'kayıt'} kaydı iptal edildi · {x.sebep}{x.kaydeden ? ` · ${x.kaydeden}` : ''}</span>
            </div>
          ))}
          {veri.hareketler.length === 0
            ? <div style={{ padding: 22, textAlign: 'center', color: R.not, border: `1px dashed ${R.cizgi3}`, borderRadius: 12 }}>{hepsi ? 'Henüz kayıt yok.' : `${tUzun(gun)} günü hiç hareket yok.`}</div>
            : (hepsi ? veri.hareketler.slice().reverse() : veri.hareketler).map((h, i, arr) => (
              <React.Fragment key={h.id}>
                {hepsi && (i === 0 || arr[i - 1].tarih !== h.tarih) && <div style={{ ...etiketStil, paddingTop: 6 }}>{tUzun(h.tarih)} · {gunAdi(h.tarih)}</div>}
                <HareketSatir h={h} cepAd={cepAd} onTeyit={teyit} onIptal={(x) => formAc('iptal', { id: x.id })} onFis={(x) => setCk(odemeFisi(x, cepAd))} />
              </React.Fragment>
            ))}
      </>)}
      </>)}
      <Cekmece v={ck} onKapat={() => setCk(null)} />
      {form && (
        <FormPenceresi form={form} veri={veri} gun={hepsi ? veri.bugun : gun} onToast={onToast}
          onKapat={() => { const dn = form.donus; setForm(null); if (dn) cekmeceAc(dn, true); }}
          onBitti={(g) => { const dn = form.donus; setForm(null); if (g) { setGun(g); setHepsi(false); } yukle(); if (dn) cekmeceAc(dn, true); }} />
      )}
    </div>
  );
}

// ─── AÇIK FARKLAR sayfası (gün gün defter) ───
function AcikSayfa({ onCoz, onCepAc, yenile }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  useEffect(() => {
    let canli = true;
    api('/evvel-yeni/kasa/acik-defter').then((r) => { if (canli) { setV(r); setHata(null); } }).catch((e) => { if (canli) setHata(e?.message || 'okunamadı'); });
    return () => { canli = false; };
  }, [yenile]);
  if (hata && !v) return <div style={{ ...kart, padding: 16, color: R.kirmizi }}>Açık farklar okunamadı: {hata}</div>;
  if (!v) return <div style={{ color: R.not }}>Okunuyor…</div>;
  const acik = v.farklar.filter((x) => !x.coz);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {[['Açık eksik', v.acik_eksik, v.acik_eksik ? R.kirmizi : R.yesil], ['Açık fazla', v.acik_fazla, v.acik_fazla ? R.amber : R.yesil],
          ['Kayba yazılan', v.kayip, R.kirmizi], ['Kayıtsız harcama', v.harcanan, R.amber]].map(([a, t, r]) => (
          <div key={a} style={{ ...kart, padding: '10px 13px' }}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 20, color: r }}>{fmt(t)}</div></div>
        ))}
      </div>
      <div style={{ ...kart, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <b>Çözülmemiş farklar {acik.length ? <Cip tur="kirmizi">{acik.length}</Cip> : <Cip tur="yesil">yok</Cip>}</b>
        {acik.map((x) => (
          <div key={x.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 9, border: `1px solid ${alfa(R.kirmizi, 45)}`, background: 'var(--pi-bad-soft)' }}>
            <div style={{ minWidth: 0 }}>
              <button type="button" onClick={() => onCepAc(x.cep, x.ad)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontWeight: 700, color: R.krem, cursor: 'pointer', textAlign: 'left' }}>{x.ad} ›</button>
              <div style={{ fontSize: 12, color: R.not }}>{tUzun(x.tarih)} · <span style={num}>{fmt(Math.abs(x.f))}</span> ₺ {x.f > 0 ? 'eksik' : 'fazla'}</div>
            </div>
            <Dugme ana kucuk onClick={() => onCoz(x.id)}>Farkı çöz</Dugme>
          </div>
        ))}
      </div>
      <div style={{ ...kart, overflow: 'hidden' }}>
        <div style={{ padding: '9px 14px', borderBottom: `1px solid ${R.cizgi}` }}><b>Gün gün</b></div>
        <div style={{ overflowX: 'auto' }}>
          <table className="pi-tablo pi-excel">
            <thead><tr><th>Gün</th><th>Yeni fark</th><th>Geri dönen</th><th>Kayba</th><th>Harcamaya</th><th>Gün sonu açık</th><th>Toplam kayıp</th></tr></thead>
            <tbody>
              {v.gun_gun.length ? v.gun_gun.map((x) => (
                <tr key={x.gun}>
                  <td style={num}>{tUzun(x.gun)}</td><td style={num}>{x.yeni ? fmt(x.yeni) : '—'}</td><td style={{ ...num, color: R.yesil }}>{x.geri_donen ? fmt(x.geri_donen) : '—'}</td>
                  <td style={{ ...num, color: R.kirmizi }}>{x.kayba_yazilan ? fmt(x.kayba_yazilan) : '—'}</td><td style={{ ...num, color: R.amber }}>{x.harcamaya_yazilan ? fmt(x.harcamaya_yazilan) : '—'}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{fmt(x.gun_sonu_acik)}</td><td style={num}>{fmt(x.toplam_kayip)}</td>
                </tr>
              )) : <tr><td colSpan={7}>Henüz fark yok.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {v.farklar.some((x) => x.coz) && (
        <div style={{ ...kart, overflow: 'hidden' }}>
          <div style={{ padding: '9px 14px', borderBottom: `1px solid ${R.cizgi}` }}><b>Kapanan farklar</b></div>
          <div style={{ overflowX: 'auto' }}>
            <table className="pi-tablo pi-excel">
              <thead><tr><th>Fark</th><th>Tutar</th><th>Sebep</th><th>Sorumlu</th><th>Kapanış</th></tr></thead>
              <tbody>{v.farklar.filter((x) => x.coz).map((x) => (
                <tr key={x.id}><td style={{ textAlign: 'left' }}>{x.ad}</td><td style={num}>{fmt(Math.abs(x.f))}</td>
                  <td style={{ textAlign: 'left' }}>{x.coz.sebep_ad}{x.coz.not ? ` · ${x.coz.not}` : ''}</td><td style={{ textAlign: 'left' }}>{x.coz.sorumlu || '—'}</td><td style={num}>{tKisa(x.coz.tarih)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function IsSatir({ x, bugun, onTeyit, onTeslim, onCoz, onKapanis, onPosKabul }) {
  const [say, setSay] = useState('');   // Codex: dolu gelirse saymadan onaylanır — boş başlar
  const g = Math.max(0, Math.round((new Date(`${bugun}T12:00:00`) - new Date(`${x.tarih}T12:00:00`)) / 864e5));
  const yas = g === 0 ? 'bugün' : `${g} gündür`;
  const satir = { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 9, background: R.girinti, border: `1px solid ${x.tur === 'fark' ? `${alfa(R.kirmizi, 55)}` : R.cizgi2}` };
  if (x.tur === 'kapanis') {
    return (
      <div style={satir}>
        <Cip tur="sari">Kapanış onayı</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · {tUzun(x.tarih)} {x.eski_sistem && <Cip>eski sistemden</Cip>}<div style={{ fontSize: 11.5, color: R.not }}>Nakit <b style={num}>{fmt(x.nakit)}</b> · kart <b style={num}>{fmt(x.kart)}</b> · karşılaştır, doğruysa onayla · {yas}</div></div>
        <Dugme ana kucuk onClick={() => onTeyit(x.id)}>Onayla</Dugme>
      </div>
    );
  }
  // Sahip (2026-10-16): "Girilmemiş ciro uyarı versin; o günün girişi yeniden istensin."
  if (x.tur === 'eksik_kapanis') {
    return (
      <div style={{ ...satir, border: `1px solid ${alfa(R.kirmizi, 55)}` }}>
        <Cip tur="kirmizi">Kapanış YOK</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · {tUzun(x.tarih)}<div style={{ fontSize: 11.5, color: R.not }}>Şube o günün kapanışını girmedi — gelir eksik. Şubeden iste; X/Z raporu geldiyse buradan gir · {yas}</div></div>
        <Dugme ana kucuk onClick={() => onKapanis?.(x)}>Kapanışı gir</Dugme>
      </div>
    );
  }
  if (x.tur === 'pos_sifir') {
    return (
      <div style={{ ...satir, border: `1px solid ${alfa(R.amber, 55)}` }}>
        <Cip tur="sari">POS 0 girilmiş</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · {tUzun(x.tarih)}<div style={{ fontSize: 11.5, color: R.not }}>Kapanışta yalnız nakit ({fmt(x.nakit)} ₺) var, kart satışı 0 — bu şube başka günlerde POS alıyor. Kart satışı kapanışa yazılmamış olabilir · {yas}</div></div>
        <Dugme kucuk onClick={() => onPosKabul?.(x.id)}>Gerçekten POS yoktu</Dugme>
      </div>
    );
  }
  if (x.tur === 'evo_kapanis') {
    return (
      <div style={{ ...satir, border: `1px solid ${alfa(R.amber, 55)}` }}>
        <Cip tur="sari">Kapanış yapılmadı · Evo tahmini</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · {tUzun(x.tarih)}<div style={{ fontSize: 11.5, color: R.not }}>Rakam Evo kasasından (nakit {fmt(x.nakit)} · kart {fmt(x.kart)}) — kimse saymadı. Gerçek kapanış girilince Evo rakamının yerini alır · {yas}</div></div>
        <Dugme kucuk onClick={() => onKapanis?.(x)}>Gerçeğini gir</Dugme>
      </div>
    );
  }
  if (x.tur === 'teslim') {
    return (
      <div style={satir}>
        <Cip tur="sari">Teslim onayı</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · <span style={num}>{fmt(x.tutar)}</span> ₺<div style={{ fontSize: 11.5, color: R.not }}>{x.hedef_kisa} saydığı tutarı yazıp onaylar · {yas}</div></div>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" min="0" step="0.01" value={say} placeholder="saydığın" onChange={(e) => setSay(e.target.value)} aria-label="Sayılan tutar" style={{ ...alanStil, width: 110, padding: '4px 7px' }} />
          <Dugme ana kucuk disabled={say === ''} onClick={() => onTeslim(x.id, say)}>{x.hedef_kisa} aldı</Dugme>
        </span>
      </div>
    );
  }
  return (
    <div style={satir}>
      <Cip tur="kirmizi">Açık fark</Cip>
      <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · <span style={num}>{fmt(Math.abs(x.f))}</span> ₺ {x.f > 0 ? 'eksik' : 'fazla'}<div style={{ fontSize: 11.5, color: R.not }}>Sebebi bulunup kapatılmalı · {yas}</div></div>
      <Dugme ana kucuk onClick={() => onCoz(x.id)}>Farkı çöz</Dugme>
    </div>
  );
}

// Diğer Evvel Yeni bölümleri (Gelir, Gider…) aynı görsel dili kullanır
export { odemeFisi, PI_CSS, R, kart, etiketStil, num, Dugme, Cip, Cekmece, fmt, tl, tUzun, tKisa, gunAdi, alfa };
