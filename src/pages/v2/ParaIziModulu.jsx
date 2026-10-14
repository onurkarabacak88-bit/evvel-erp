// ─────────────────────────────────────────────────────────────────────────────
// 🧵 PARA İZİ — sade çekirdeğin ilk tuğlası (2026-10-15)
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
import { R } from './tema';
import { HataBandi } from './parcalar';

const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const GUNLER = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('tr-TR');
const tl = (n) => `${fmt(n)} ₺`;
const tUzun = (s) => { if (!s) return ''; const p = s.split('-'); return `${+p[2]} ${AY[+p[1] - 1]}`; };
const tKisa = (s) => tUzun(s).replace(/(\S+)$/, (m) => m.slice(0, 3));
const gunAdi = (s) => GUNLER[new Date(`${s}T12:00:00`).getDay()];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const gunEkle = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };

const SEVIYE = {
  kirmizi: { kenar: R.kirmizi, zemin: 'rgba(226,96,79,.10)' },
  sari: { kenar: R.amber, zemin: 'rgba(229,184,78,.09)' },
  yesil: { kenar: R.yesil, zemin: 'transparent' },
  gri: { kenar: R.cizgi3, zemin: 'transparent' },
};

const kart = {
  background: `linear-gradient(160deg, ${R.kart1}, ${R.kart2})`,
  border: `1px solid ${R.cizgi2}`, borderRadius: 14,
};
const etiketStil = { fontSize: 10.5, letterSpacing: '.8px', textTransform: 'uppercase', color: R.not2, fontWeight: 700 };
const num = { fontVariantNumeric: 'tabular-nums' };

function Dugme({ children, onClick, ana, kucuk, disabled, title, renk }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} style={{
      padding: kucuk ? '4px 10px' : '7px 13px', borderRadius: 9, fontFamily: 'inherit',
      fontSize: kucuk ? 12 : 12.5, fontWeight: ana ? 700 : 600, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1, whiteSpace: 'nowrap',
      border: ana ? 'none' : `1px solid ${renk || R.cizgi3}`,
      background: ana ? (renk || 'linear-gradient(150deg, #E0A559, #AF6C29)') : 'transparent',
      color: ana ? '#1C1309' : (renk || R.metin2),
    }}>{children}</button>
  );
}

function Cip({ children, tur }) {
  const r = { kirmizi: R.kirmizi, sari: R.amber, yesil: R.yesil, bakir: R.bakirAcik }[tur] || R.metin2;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700, padding: '1px 8px',
      borderRadius: 999, color: r, border: `1px solid ${r}55`, background: `${r}14`, whiteSpace: 'nowrap',
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
      boxShadow: serit && c.seviye === 'kirmizi' ? `inset 0 0 0 1px ${R.kirmizi}55` : 'none',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: serit ? 'wrap' : 'nowrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{serit && <span style={{ ...etiketStil, display: 'block' }}>Patron evi</span>}{c.ad}</span>
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
const TUR_AD = { acilis: 'Açılış', kapanis: 'Kapanış', dis: 'Dış giriş', teslim: 'Teslim', tasima: 'Taşıma', odeme: 'Ödeme', sayim: 'Sayım', cozum: 'Fark çözüldü' };
function HareketSatir({ h, cepAd, onIptal, onTeyit }) {
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
    cip = h.durum !== 'onaylandi' ? <Cip tur="sari">onay bekliyor</Cip>
      : (h.alinan !== h.tutar ? <Cip tur="kirmizi">sayılan {fmt(h.alinan)} · eksik {fmt(h.tutar - h.alinan)}</Cip> : <Cip tur="yesil">alındı</Cip>);
  }
  if (h.tur === 'tasima') { ust = `${cepAd(h.kaynak)} → ${cepAd(h.hedef)}`; }
  if (h.tur === 'sayim') {
    ust = cepAd(h.cep); alt = `Defterde ${fmt(h.beklenen)} · sayılan ${fmt(h.sayilan)}`;
    const f = h.beklenen - h.sayilan;
    cip = Math.abs(f) < 0.5 ? <Cip tur="yesil">tuttu</Cip> : <Cip tur="kirmizi">{fmt(Math.abs(f))} {f > 0 ? 'eksik' : 'fazla'}</Cip>;
  }
  if (h.tur === 'cozum') {
    const zarar = ['kayip', 'harcandi'].includes(h.sebep);
    ust = h.sebep_ad; alt = `${h.fark_ad || ''}${h.sorumlu ? ` · sorumlu: ${h.sorumlu}` : ''}${h.not_ ? ` · ${h.not_}` : ''}`;
    renk = zarar ? R.kirmizi : R.krem; tutar = zarar ? `−${fmt(Math.abs(h.f))}` : fmt(Math.abs(h.f));
  }
  if (h.tur === 'odeme') {
    ust = h.aciklama; alt = `kimin: ${h.kimin} · ${h.parcalar.map((p) => `${cepAd(p.cep)} ${fmt(p.tutar)}`).join(' + ')}`;
    renk = R.kirmizi; tutar = `−${tutar}`;
  }
  return (
    <div style={{ ...kart, padding: '9px 13px', display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 10, alignItems: 'center' }}>
      <Cip tur={h.tur === 'odeme' ? 'kirmizi' : cipTur}>{TUR_AD[h.tur]}</Cip>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{ust} {cip}{h.eski_sistem && <Cip>eski sistemden</Cip>}</div>
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
  acilis: '1 Ekim açılış bakiyesi', kapanis: 'Şube kapanışı', dis: 'Dış kaynaktan giriş', teslim: 'Şubeden teslim',
  tasima: 'Para taşı / hesaba yatır', sayim: 'Sayım', odeme: 'Ödeme', coz: 'Farkı çöz', iptal: 'Kaydı iptal et', aktar: 'Eski sistemden aktar',
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
    is_gunu: form.gun || gun, cep: form.cep || ilk(tip === 'kapanis' ? ['sube'] : tip === 'acilis' ? null : null),
    kaynak: ilk(tip === 'teslim' ? ['sube'] : null), hedef: ilk(tip === 'teslim' ? ['ev'] : ['ev', 'hesap']),
    alt: 'borc', kimin: 'Ortak', parcalar: [{ cep: '', tutar: '' }], sorumlu: '', sebep: '',
  }));
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [fark, setFark] = useState(null);
  const [aktar, setAktar] = useState(null);
  const [sayimDefter, setSayimDefter] = useState(null);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    if (tip === 'coz') api(`/para-izi/fark/${form.id}`).then((f) => { setFark(f); setD((x) => ({ ...x, sebep: f.sebep_secenekleri[0]?.kod, is_gunu: (form.gun || gun) < f.tarih ? f.tarih : (form.gun || gun) })); }).catch((e) => setHata(e.message));
    if (tip === 'aktar') api('/para-izi/aktar?kuru=true', { method: 'POST' }).then(setAktar).catch((e) => setHata(e.message));
  }, [tip, form.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Sayımda "defterde ne olmalı" bilgisi sunucudan, seçilen günün akşamı itibarıyla
  useEffect(() => {
    if (tip !== 'sayim' || !d.cep) return;
    api(`/para-izi/cep/${encodeURIComponent(d.cep)}?gun=${d.is_gunu}`).then((r) => setSayimDefter(r.cep.bakiye)).catch(() => setSayimDefter(null));
  }, [tip, d.cep, d.is_gunu]);

  const parcaToplam = d.parcalar.reduce((a, p) => a + (Number(p.tutar) || 0), 0);
  const gonder = async () => {
    setHata(''); setMesgul(true);
    try {
      if (tip === 'aktar') {
        const r = await api('/para-izi/aktar?kuru=false', { method: 'POST' });
        onToast?.(`Aktarıldı: ${r.ozet.kapanis} kapanış · ${r.ozet.teslim} teslim`);
      } else if (tip === 'iptal') {
        await api(`/para-izi/hareket/${form.id}/iptal`, { method: 'POST', body: { sebep: d.sebep } });
        onToast?.('Kayıt iptal edildi (iz duruyor)');
      } else {
        const body = { tur: tip === 'coz' ? 'cozum' : tip, is_gunu: d.is_gunu };
        if (['acilis', 'kapanis', 'dis', 'sayim'].includes(tip)) body.cep = d.cep;
        if (['teslim', 'tasima'].includes(tip)) { body.kaynak = d.kaynak; body.hedef = d.hedef; }
        if (tip === 'sayim') body.sayilan = Number(d.sayilan);
        else if (tip !== 'coz' && tip !== 'odeme') body.tutar = Number(d.tutar);
        if (tip === 'kapanis') body.kart = Number(d.kart || 0);
        if (tip === 'dis') { body.alt = d.alt; body.kimden = d.kimden; body.not = d.not; }
        if (tip === 'odeme') {
          body.tutar = Number(d.tutar); body.aciklama = d.aciklama; body.kimin = d.kimin;
          body.parcalar = d.parcalar.filter((p) => p.cep && Number(p.tutar) > 0).map((p) => ({ cep: p.cep, tutar: Number(p.tutar) }));
        }
        if (tip === 'coz') { body.fark_id = form.id; body.sebep = d.sebep; body.sorumlu = d.sorumlu; body.not = d.not; }
        await api('/para-izi/hareket', { method: 'POST', body });
        onToast?.('Kaydedildi');
      }
      onBitti(tip === 'aktar' || tip === 'iptal' || tip === 'coz' ? null : d.is_gunu);
    } catch (e) {
      setHata(e?.message || 'Kaydedilemedi');
    } finally { setMesgul(false); }
  };

  const gunAlani = !['acilis', 'iptal', 'aktar'].includes(tip) && (
    <Alan etiket="Gün"><input type="date" value={d.is_gunu} min={veri.baslangic} max={veri.bugun} onChange={set('is_gunu')} style={alanStil} /></Alan>
  );
  const tutarAlani = (etiket = 'Tutar (₺)') => (
    <Alan etiket={etiket}><input type="number" min="0" step="1" inputMode="numeric" value={d.tutar || ''} onChange={set('tutar')} style={alanStil} /></Alan>
  );
  const izgara = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 };
  const secili = d.parcalar.map((p) => p.cep);

  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, zIndex: 95, background: 'rgba(10,6,2,.6)', display: 'grid', placeItems: 'center', padding: 16 }} onClick={onKapat}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...kart, width: 'min(620px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: R.krem }}>{BASLIK[tip]}</div>
          <Dugme onClick={onKapat}>Kapat</Dugme>
        </div>

        {tip === 'acilis' && (<>
          <div style={{ fontSize: 12.5, color: R.metin2 }}>Para İzi 1 Ekim sabahından başlar. Her cepte o sabah ne kadar para olduğunu bir kez gir (sayarak). Sonradan değiştirmek için eski kaydı iptal edip yenisini girersin.</div>
          <div style={izgara}>
            <Alan etiket="Cep"><select value={d.cep} onChange={set('cep')} style={alanStil}>{cepler.filter((c) => !(veri.acilis_girilen || []).includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.ad}</option>)}</select></Alan>
            {tutarAlani('1 Ekim sabahı (₺)')}
          </div>
        </>)}

        {tip === 'kapanis' && (<>
          <div style={{ fontSize: 12, color: R.not }}>Normalde şube panelinden gelir ("Eski sistemden aktar"). Gelmediyse buradan elle girilir.</div>
          <div style={izgara}>
            <Alan etiket="Şube"><select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(['sube'])}</select></Alan>
            {gunAlani}
            {tutarAlani('Nakit (₺)')}
            <Alan etiket="Kart / online (₺)" ipucu="Bankaya geçer, nakde girmez"><input type="number" min="0" value={d.kart || ''} onChange={set('kart')} style={alanStil} /></Alan>
          </div>
        </>)}

        {tip === 'dis' && (
          <div style={izgara}>
            <Alan etiket="Ne geldi"><select value={d.alt} onChange={set('alt')} style={alanStil}>{(veri.dis_turleri || []).map((x) => <option key={x.kod} value={x.kod}>{x.ad}</option>)}</select></Alan>
            <Alan etiket="Kimden" ipucu={d.alt === 'destek' ? 'Desteği koyan patron' : (['borc', 'kredi'].includes(d.alt) ? 'Geri ödenecek — kimden alındı' : null)}>
              <input list="pi-kisiler" value={d.kimden || ''} onChange={set('kimden')} style={alanStil} placeholder="ör. Ziraat, Onur" />
              <datalist id="pi-kisiler"><option value="Onur" /><option value="Fethi" /><option value="Fatma" /></datalist>
            </Alan>
            <Alan etiket="Hangi cebe girdi"><select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(null)}</select></Alan>
            {tutarAlani()}
            {gunAlani}
            <Alan etiket="Not"><input value={d.not || ''} onChange={set('not')} style={alanStil} /></Alan>
          </div>
        )}

        {tip === 'teslim' && (
          <div style={izgara}>
            <Alan etiket="Teslim eden şube"><select value={d.kaynak} onChange={set('kaynak')} style={alanStil}>{secenek(['sube'], true)}</select></Alan>
            <Alan etiket="Teslim alan patron"><select value={d.hedef} onChange={set('hedef')} style={alanStil}>{secenek(['ev'])}</select></Alan>
            {tutarAlani()}{gunAlani}
          </div>
        )}

        {tip === 'tasima' && (
          <div style={izgara}>
            <Alan etiket="Nereden"><select value={d.kaynak} onChange={set('kaynak')} style={alanStil}>{secenek(null, true)}</select></Alan>
            <Alan etiket="Nereye"><select value={d.hedef} onChange={set('hedef')} style={alanStil}>{secenek(['ev', 'hesap'])}</select></Alan>
            {tutarAlani()}{gunAlani}
          </div>
        )}

        {tip === 'sayim' && (<>
          <div style={izgara}>
            <Alan etiket="Neresi sayıldı"><select value={d.cep} onChange={set('cep')} style={alanStil}>{secenek(null)}</select></Alan>
            {gunAlani}
            <Alan etiket="Sayılan (₺)"><input type="number" min="0" value={d.sayilan ?? ''} onChange={set('sayilan')} style={alanStil} /></Alan>
          </div>
          {sayimDefter !== null && (() => {
            const s = d.sayilan === undefined || d.sayilan === '' ? null : Number(d.sayilan);
            const f = s === null ? 0 : sayimDefter - s;
            return (
              <div style={{ padding: '9px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: s === null ? R.metin2 : Math.abs(f) < 0.5 ? R.yesil : R.amber }}>
                {tUzun(d.is_gunu)} akşamı defterde <b style={num}>{tl(sayimDefter)}</b>
                {s !== null && (Math.abs(f) < 0.5 ? ' · tuttu' : ` · ${f > 0 ? 'eksik' : 'fazla'} ${tl(Math.abs(f))} → açık fark olur, silinmez`)}
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
                {cepler.map((c) => <option key={c.id} value={c.id} disabled={(secili.includes(c.id) && p.cep !== c.id) || (bak[c.id] || 0) < 0.5}>{c.ad} · {(bak[c.id] || 0) < 0.5 ? 'boş' : `${fmt(bak[c.id])} ₺`}</option>)}
              </select>
              <input type="number" min="0" placeholder="Tutar" value={p.tutar} onChange={(e) => setD((x) => ({ ...x, parcalar: x.parcalar.map((q, j) => (j === i ? { ...q, tutar: e.target.value } : q)) }))} style={alanStil} />
              <Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: x.parcalar.filter((_, j) => j !== i) }))}>Sil</Dugme>
            </div>
          ))}
          <div><Dugme kucuk onClick={() => setD((x) => ({ ...x, parcalar: [...x.parcalar, { cep: '', tutar: '' }] }))}>+ Kaynak ekle</Dugme></div>
          <div style={{ padding: '8px 12px', borderRadius: 9, fontSize: 12.5, background: R.girinti, color: Math.abs(parcaToplam - Number(d.tutar || 0)) < 0.5 && parcaToplam > 0 ? R.yesil : R.amber }}>
            Kaynaklar <b style={num}>{fmt(parcaToplam)}</b> · ödeme <b style={num}>{fmt(d.tutar)}</b>
          </div>
        </>)}

        {tip === 'coz' && fark && (<>
          <div style={{ padding: '9px 12px', borderRadius: 9, background: 'rgba(226,96,79,.10)', border: `1px solid ${R.kirmizi}55`, fontSize: 13 }}>
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
            {mesgul ? 'Kaydediliyor…' : tip === 'aktar' ? 'Aktar' : tip === 'iptal' ? 'İptal et' : tip === 'coz' ? 'Farkı kapat' : 'Kaydet'}
          </Dugme>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── ANA MODÜL ───────────────────────────
export default function ParaIziModulu({ onCekmece, onToast }) {
  const [gun, setGun] = useState(() => {
    try { return localStorage.getItem('paraIziGun') || iso(new Date()); } catch { return iso(new Date()); }
  });
  const [hepsi, setHepsi] = useState(false);
  const [veri, setVeri] = useState(null);
  const [hata, setHata] = useState(null);
  const [form, setForm] = useState(null);
  const yigin = useRef([]);
  const islerRef = useRef(null);

  const yukle = useCallback(async () => {
    setHata(null);
    try {
      setVeri(await api(`/para-izi/durum?gun=${gun}${hepsi ? '&hepsi=true' : ''}`));
    } catch (e) { setHata(e?.message || 'okunamadı'); }
  }, [gun, hepsi]);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => { try { localStorage.setItem('paraIziGun', gun); } catch { /* yut */ } }, [gun]);
  useEffect(() => () => onCekmece?.(null), []);   // eslint-disable-line react-hooks/exhaustive-deps

  const cepAd = (id) => (veri?.cepler.find((c) => c.id === id) || {}).ad || id;
  const formAc = (tip, ek = {}) => { onCekmece?.(null); setForm({ tip, ...ek }); };
  const teyit = async (id) => {
    try { await api(`/para-izi/hareket/${id}/onay`, { method: 'POST', body: {} }); onToast?.('Onaylandı'); yukle(); } catch (e) { onToast?.(e.message); }
  };
  const teslimAl = async (id, sayilan) => {
    try { await api(`/para-izi/hareket/${id}/onay`, { method: 'POST', body: { alinan: Number(sayilan) } }); onToast?.('Teslim alındı'); yukle(); } catch (e) { onToast?.(e.message); }
  };

  // ── ÇEKMECE: satırlar kapı, geri yolu yığından ──
  const cekmeceAc = useCallback(async (g, kok) => {
    if (kok) yigin.current = [];
    yigin.current.push(g);
    const onc = yigin.current[yigin.current.length - 2];
    const geri = onc ? { ad: onc.ad, onTikla: () => { yigin.current.pop(); const p = yigin.current.pop(); cekmeceAc(p, false); } } : undefined;
    const temel = { geri, onKapat: () => onCekmece?.(null) };
    onCekmece?.({ ...temel, tip: g.tip, baslik: g.ad, alt: 'okunuyor…' });
    try {
      if (g.tur === 'cep') {
        const r = await api(`/para-izi/cep/${encodeURIComponent(g.id)}?gun=${gun}${hepsi ? '&hepsi=true' : ''}`);
        const c = r.cep;
        g.ad = c.ad;
        onCekmece?.({
          ...temel, tip: { ev: 'PATRON EVİ', sube: 'ŞUBE KASASI', hesap: 'GEÇİŞ HESABI' }[c.tur], baslik: c.ad,
          alt: hepsi ? 'Şu an' : `${tUzun(gun)} akşamı`,
          kpi: [
            { etiket: 'Bakiye', deger: tl(c.bakiye), renk: R.krem },
            { etiket: 'Gelen', deger: tl(r.gelen_toplam), renk: R.yesil },
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
          iz: r.iz.map((x) => ({ ad: `${x.etiket} · ${x.d < 0 ? '−' : '+'}${fmt(Math.abs(x.d))}`, detay: `bakiye ${tl(x.bakiye)}${x.fark ? ' · fark var' : ''}`, zaman: tUzun(x.tarih), renk: x.d < 0 ? R.kirmizi : R.yesil })),
          aksiyonlar: [{ ad: 'Bu cebi say', birincil: true, onTikla: () => formAc('sayim', { cep: c.id }) }],
        });
      } else if (g.tur === 'fark') {
        const f = await api(`/para-izi/fark/${g.id}`);
        g.ad = f.ad;
        onCekmece?.({
          ...temel, tip: f.tur === 'teslim' ? 'TESLİM FARKI' : 'SAYIM FARKI', baslik: f.ad, alt: tUzun(f.tarih),
          kpi: [
            { etiket: f.f > 0 ? 'Eksik' : 'Fazla', deger: tl(Math.abs(f.f)), renk: R.kirmizi },
            { etiket: 'Durum', deger: f.coz ? 'Kapandı' : 'Açık', renk: f.coz ? R.yesil : R.kirmizi },
          ],
          not: f.coz ? `${f.coz.sebep_ad} · ${tUzun(f.coz.tarih)}${f.coz.sorumlu ? ` · sorumlu: ${f.coz.sorumlu}` : ''}${f.coz.not ? `\n${f.coz.not}` : ''}`
            : 'Para silinmedi, gider de sayılmadı. Sebebi bulunana kadar "açık fark" olarak bekliyor.',
          listeBaslik: 'İlgili cepler',
          satirlar: [
            { ad: 'Farkın görüldüğü yer', detay: f.cep_ad, onTikla: () => cekmeceAc({ tur: 'cep', id: f.cep, ad: f.cep_ad }, false) },
            ...(f.sube_cep ? [{ ad: 'Teslim eden', detay: f.sube_cep_ad, onTikla: () => cekmeceAc({ tur: 'cep', id: f.sube_cep, ad: f.sube_cep_ad }, false) }] : []),
          ],
          aksiyonlar: f.coz ? [] : [{ ad: 'Farkı çöz', birincil: true, onTikla: () => formAc('coz', { id: f.id }) }],
        });
      } else if (g.tur === 'acik') {
        const a = await api('/para-izi/acik-defter');
        const acik = a.farklar.filter((x) => !x.coz);
        onCekmece?.({
          ...temel, tip: 'AÇIK FARKLAR DEFTERİ', baslik: 'Açık farklar', alt: 'Gün gün toplam açık · İz sekmesinde',
          kpi: [
            { etiket: 'Şu an açık', deger: tl(a.acik), renk: a.acik > 0.5 ? R.kirmizi : R.yesil },
            { etiket: 'Çözülmemiş', deger: `${acik.length} fark`, renk: R.krem },
            { etiket: 'Kayba yazılan', deger: tl(a.kayip), renk: R.kirmizi },
          ],
          listeBaslik: 'Farklar · çözülmemişler önce',
          satirlar: [...acik, ...a.farklar.filter((x) => x.coz)].map((x) => ({
            ad: `${x.coz ? '✓' : '🔴'} ${x.ad}`, detay: `${tUzun(x.tarih)} · ${x.coz ? x.coz.sebep_ad : 'çözülmedi'}`,
            tutar: tl(Math.abs(x.f)), solgun: !!x.coz, onTikla: () => cekmeceAc({ tur: 'fark', id: x.id, ad: x.ad }, false),
          })),
          not: a.farklar.length ? null : 'Henüz hiç fark yok.',
          iz: a.gun_gun.slice().reverse().map((x) => ({
            ad: `Gün sonu açık ${tl(x.gun_sonu_acik)}`, zaman: tUzun(x.gun),
            detay: `yeni ${fmt(x.yeni)} · geri dönen ${fmt(x.geri_donen)} · kayba yazılan ${fmt(x.kayba_yazilan)} · toplam kayıp ${fmt(x.toplam_kayip)}`,
            renk: x.gun_sonu_acik > 0.5 ? R.kirmizi : R.yesil,
          })),
        });
      }
    } catch (e) {
      onCekmece?.({ ...temel, tip: 'PARA İZİ', baslik: g.ad || 'Ayrıntı', alt: 'okunamadı', not: `Okunamadı: ${e?.message || ''}. Kayıt yok demek DEĞİL.` });
    }
  }, [gun, hepsi, onCekmece]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (hata && !veri) return <HataBandi mesaj="Para İzi okunamadı" kod={hata} onTekrar={yukle} />;
  if (!veri) return <div style={{ color: R.not, padding: 20 }}>Para İzi okunuyor…</div>;

  const o = veri.ozet;
  const evler = veri.cepler.filter((c) => c.tur === 'ev');
  const subeler = veri.cepler.filter((c) => c.tur === 'sube');
  const hesaplar = veri.cepler.filter((c) => c.tur === 'hesap');
  const acilisEksik = veri.cepler.filter((c) => !(veri.acilis_girilen || []).includes(c.id));
  const deg = veri.onceki_toplam == null ? null : o.toplam - veri.onceki_toplam;
  const k = veri.kpi;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, color: R.krem }}>
      {/* ÜST ÇUBUK */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {veri.isler.length > 0 && (
          <button type="button" onClick={() => islerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{
            padding: '6px 12px', borderRadius: 999, border: 'none', background: R.kirmizi, color: '#1C1309', fontWeight: 800, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          }}>{veri.isler.length} iş bekliyor</button>
        )}
        <Dugme ana onClick={() => formAc('dis')}>+ Dış giriş</Dugme>
        <Dugme ana onClick={() => formAc('teslim')}>+ Teslim</Dugme>
        <Dugme ana onClick={() => formAc('tasima')}>+ Taşı / Yatır</Dugme>
        <Dugme ana onClick={() => formAc('sayim')}>+ Sayım</Dugme>
        <Dugme onClick={() => formAc('odeme')}>+ Ödeme</Dugme>
        <Dugme onClick={() => formAc('kapanis')}>+ Kapanış</Dugme>
        <Dugme onClick={() => formAc('aktar')} title="1 Ekim'den bu yana kapanış ve teslimleri eski sistemden okur">Eski sistemden aktar</Dugme>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <Dugme kucuk disabled={hepsi || gun <= veri.baslangic} onClick={() => setGun(gunEkle(gun, -1))}>‹</Dugme>
          <input type="date" value={gun} min={veri.baslangic} max={veri.bugun} disabled={hepsi} onChange={(e) => e.target.value && setGun(e.target.value)}
            style={{ ...alanStil, width: 'auto', padding: '5px 8px' }} aria-label="Gün" />
          <Dugme kucuk disabled={hepsi || gun >= veri.bugun} onClick={() => setGun(gunEkle(gun, 1))}>›</Dugme>
          <Dugme kucuk onClick={() => { setGun(veri.bugun); setHepsi(false); }}>Bugün</Dugme>
          <Dugme kucuk ana={hepsi} onClick={() => setHepsi(!hepsi)}>Tüm günler</Dugme>
        </div>
      </div>

      {acilisEksik.length > 0 && (
        <div style={{ ...kart, padding: '10px 14px', borderColor: `${R.amber}88`, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
          <Cip tur="sari">Başlangıç</Cip>
          <span style={{ color: R.metin2 }}>{acilisEksik.length} cebin 1 Ekim açılış bakiyesi girilmedi ({acilisEksik.map((c) => c.kisa).join(', ')}). Girilmeden rakamlar eksik başlar.</span>
          <Dugme kucuk ana onClick={() => formAc('acilis', { cep: acilisEksik[0].id })}>Açılış bakiyesi gir</Dugme>
        </div>
      )}

      {/* ŞERİT: toplam + patron evleri + açık farklar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <div style={{ ...kart, padding: '12px 16px', background: `linear-gradient(160deg, ${R.kartUst1}, ${R.kartUst2})`, gridColumn: 'span 2', minWidth: 0 }}>
          <div style={etiketStil}>{hepsi ? 'Şu an' : `${tUzun(gun)} akşamı`} · toplam kasa (banka hariç)</div>
          <div style={{ ...num, fontSize: 30, fontWeight: 700, color: R.bakirAcik, lineHeight: 1.15 }}>{tl(o.toplam)}</div>
          {Math.abs(o.acik) >= 0.5 && <div style={{ fontSize: 12, marginTop: 2 }}><Cip tur="kirmizi">Açık fark {fmt(o.acik)}</Cip> <span style={{ color: R.not }}>defterde {fmt(o.defter)}</span></div>}
          {deg != null && <div style={{ fontSize: 12, color: R.metin2, marginTop: 2 }}>Önceki akşama göre <b style={{ ...num, color: deg < 0 ? R.kirmizi : deg > 0 ? R.yesil : R.metin2 }}>{deg > 0 ? '+' : ''}{fmt(deg)}</b></div>}
          <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
            {[['Evler', o.ev], ['Kasalar', o.sube], ['Geçiş + yolda', o.gecis + o.yolda]].map(([a, v]) => (
              <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 15 }}>{fmt(v)}</div></div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {veri.seviye_sayim.kirmizi > 0 && <Cip tur="kirmizi">{veri.seviye_sayim.kirmizi} cep müdahale bekliyor</Cip>}
            {veri.seviye_sayim.sari > 0 && <Cip tur="sari">{veri.seviye_sayim.sari} cep dikkat</Cip>}
            {!veri.seviye_sayim.kirmizi && !veri.seviye_sayim.sari && <Cip tur="yesil">Her şey temiz</Cip>}
          </div>
        </div>
        {evler.map((c) => <CepKart key={c.id} c={c} serit onAc={(id) => cekmeceAc({ tur: 'cep', id, ad: c.ad }, true)} />)}
        <button type="button" onClick={() => cekmeceAc({ tur: 'acik', ad: 'Açık farklar' }, true)} style={{
          ...kart, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: R.krem, padding: '12px 14px',
          borderLeft: `4px solid ${Math.abs(o.acik) >= 0.5 ? R.kirmizi : R.yesil}`, display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          <span style={etiketStil}>Açık farklar</span>
          <span style={{ ...num, fontSize: 21, fontWeight: 600, color: Math.abs(o.acik) >= 0.5 ? R.kirmizi : R.krem }}>{tl(o.acik)}</span>
          <span style={{ fontSize: 11.5, color: veri.acik_fark_sayisi ? R.kirmizi : R.not, fontWeight: 700 }}>{veri.acik_fark_sayisi ? `● ${veri.acik_fark_sayisi} fark çözülmedi` : 'Çözülmemiş fark yok'}</span>
          <span style={{ fontSize: 11.5, color: R.not }}>Kayba yazılan {fmt(o.kayip)} ₺ · gün gün defter ›</span>
        </button>
      </div>

      {/* GÖVDE */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {[['Şube kasaları', subeler, o.sube], ['Geçiş hesabı · giren çıkmalı', hesaplar, o.gecis]].map(([bas, liste, top]) => (
            <div key={bas} style={{ ...kart, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 14px', borderBottom: `1px solid ${R.cizgi}` }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{bas}</span><span style={{ ...num, color: R.not }}>{tl(top)}</span>
              </div>
              {liste.map((c) => <CepKart key={c.id} c={c} onAc={(id) => cekmeceAc({ tur: 'cep', id, ad: c.ad }, true)} />)}
              {bas.startsWith('Geçiş') && o.yolda >= 0.5 && (
                <div style={{ padding: '9px 14px', fontSize: 12, color: R.amber }}>Yolda {tl(o.yolda)} · teslim edildi, "aldı" onayı bekliyor</div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, gridColumn: 'span 2' }}>
          {/* BEKLEYEN İŞLER — güne bağlı değil */}
          <div ref={islerRef} style={{ ...kart, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, border: veri.isler.length ? `2px solid ${R.amber}` : kart.border }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>Bekleyen işler</span>
              {veri.isler.length ? <Cip tur="kirmizi">{veri.isler.length}</Cip> : <Cip tur="yesil">Hepsi tamam</Cip>}
            </div>
            {veri.isler.map((x) => <IsSatir key={`${x.tur}${x.id}`} x={x} bugun={veri.bugun} onTeyit={teyit} onTeslim={teslimAl} onCoz={(id) => formAc('coz', { id })} />)}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{hepsi ? 'Tüm günler' : tUzun(gun)}</span>
            {!hepsi && <span style={{ color: R.not, fontSize: 12.5 }}>{gunAdi(gun)}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
            {[['Satış nakdi', k.satis_nakdi, R.yesil], ['Dış giriş', k.dis_giris, R.yesil], ['Kart (bankaya)', k.kart, R.metin2], ['Teslim edilen', k.teslim, R.krem], ['Ödenen', k.odenen, R.kirmizi]].map(([a, v, r]) => (
              <div key={a} style={{ ...kart, padding: '8px 11px' }}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 16, color: r }}>{fmt(v)}</div></div>
            ))}
          </div>
          {veri.hareketler.length === 0
            ? <div style={{ padding: 22, textAlign: 'center', color: R.not, border: `1px dashed ${R.cizgi3}`, borderRadius: 12 }}>{hepsi ? 'Henüz kayıt yok.' : `${tUzun(gun)} günü hiç hareket yok.`}</div>
            : (hepsi ? veri.hareketler.slice().reverse() : veri.hareketler).map((h, i, arr) => (
              <React.Fragment key={h.id}>
                {hepsi && (i === 0 || arr[i - 1].tarih !== h.tarih) && <div style={{ ...etiketStil, paddingTop: 6 }}>{tUzun(h.tarih)} · {gunAdi(h.tarih)}</div>}
                <HareketSatir h={h} cepAd={cepAd} onTeyit={teyit} onIptal={(x) => formAc('iptal', { id: x.id })} />
              </React.Fragment>
            ))}
        </div>
      </div>

      {form && (
        <FormPenceresi form={form} veri={veri} gun={hepsi ? veri.bugun : gun} onToast={onToast} onKapat={() => setForm(null)}
          onBitti={(g) => { setForm(null); if (g) { setGun(g); setHepsi(false); } yukle(); }} />
      )}
    </div>
  );
}

function IsSatir({ x, bugun, onTeyit, onTeslim, onCoz }) {
  const [say, setSay] = useState(x.tutar);
  const g = Math.max(0, Math.round((new Date(`${bugun}T12:00:00`) - new Date(`${x.tarih}T12:00:00`)) / 864e5));
  const yas = g === 0 ? 'bugün' : `${g} gündür`;
  const satir = { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 9, background: R.girinti, border: `1px solid ${x.tur === 'fark' ? `${R.kirmizi}88` : R.cizgi2}` };
  if (x.tur === 'kapanis') {
    return (
      <div style={satir}>
        <Cip tur="sari">Kapanış onayı</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · {tUzun(x.tarih)}<div style={{ fontSize: 11.5, color: R.not }}>Nakit <b style={num}>{fmt(x.nakit)}</b> · kart <b style={num}>{fmt(x.kart)}</b> · karşılaştır, doğruysa onayla · {yas}</div></div>
        <Dugme ana kucuk onClick={() => onTeyit(x.id)}>Onayla</Dugme>
      </div>
    );
  }
  if (x.tur === 'teslim') {
    return (
      <div style={satir}>
        <Cip tur="sari">Teslim onayı</Cip>
        <div style={{ minWidth: 0, fontSize: 13 }}><b>{x.ad}</b> · <span style={num}>{fmt(x.tutar)}</span> ₺<div style={{ fontSize: 11.5, color: R.not }}>{x.hedef_kisa} saydığı tutarı yazıp onaylar · {yas}</div></div>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" min="0" value={say} onChange={(e) => setSay(e.target.value)} aria-label="Sayılan tutar" style={{ ...alanStil, width: 100, padding: '4px 7px' }} />
          <Dugme ana kucuk onClick={() => onTeslim(x.id, say)}>{x.hedef_kisa} aldı</Dugme>
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
