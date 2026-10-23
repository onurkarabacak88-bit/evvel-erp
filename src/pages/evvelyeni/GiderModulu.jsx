// ─────────────────────────────────────────────────────────────────────────────
// 💸 EVVEL YENİ · GİDER — şubenin KENDİ işletme yükü (borç/kredi/patron şahsi YOK)
//
// Sahip (2026-10-15): "Şubeler sanki hiç borcu yokmuş gibi — yalnız malı ve tükettiği
// giderleri ödemekle mükellef." · "Her şubeye giden malın değeri kadar sevkiyat gider
// olarak girmeli; depoya geliş fiyatından değil GÜNCELLENMİŞ fiyattan."
// ORTAK KARAR (sahip + Codex + Claude): mal gideri = ÜRÜN AÇ × fiyat; depodan sevk bedeli
// AYRI gösterilir, gidere eklenmez — fark şubenin rafında bekleyen mal.
// Bütün rakamlar /api/evvel-yeni/gider'den; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { api } from '../../utils/api';
import { AySecici, Cekmece, Cip, Dugme, etiketStil, fmt, kart, num, PI_CSS, R, tKisa, tl, tUzun, useSonIstek } from './KasaModulu';
import { ayTR } from '../../utils/trTarih';

export const GIDER_SAYFALAR = [
  { id: 'giderler', ad: 'Giderlerim', alt: 'Şube şube · mal · kira · personel' },
];

const KALEM = ['mal', 'kira', 'personel', 'fatura', 'dukkan', 'anlik', 'diger', 'komisyon'];
const TUR_RENK = { mal: 'var(--pi-accent)', kira: '#7a5c3e', personel: '#4f6d7a', fatura: '#8a7a3a', dukkan: 'var(--pi-warn)', anlik: '#b08850', diger: '#999', komisyon: 'var(--pi-ink3)' };
const TUR_AD = { mal: 'Mal (tüketim — sayımdan)', kira: 'Kira', personel: 'Personel', fatura: 'Fatura', dukkan: 'Dükkân küçük', anlik: 'Anlık', diger: 'Diğer', komisyon: 'Komisyon', sevk: 'Depodan sevk (gider DEĞİL)' };

export default function GiderModulu({ onToast }) {
  const [ay, setAy] = useState(ayTR);
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ck, setCk] = useState(null);
  const yukle = useSonIstek(`/evvel-yeni/gider/ozet?ay=${ay}`, setV, setHata);   // ortak 'son istek kazanır' (T4-09)

  const sinifla = async (ref, tur, kimin) => {
    try { await api('/evvel-yeni/gider/siniflandir', { method: 'POST', body: { kaynak_ref: ref, tur, kimin } }); onToast?.(tur === 'cekis' ? "Patron harcaması olarak ayrıldı — hangi patron olduğunu Patron harcamaları'nda seç" : 'Şube giderine geri alındı'); setCk(null); yukle(); }
    catch (e) { onToast?.(e.message); }
  };

  const subeAc = (s) => setCk({
    tip: 'ŞUBE GİDERİ', baslik: `${s.ad} · ${tUzun(v.ay_basi).split(' ')[1]}`,
    alt: 'Mal = şubede ÜRÜN AÇ ile açılan × o günkü son alış fiyatı (KDV dahil). Depodan sevk ayrı satırda, gidere eklenmez.',
    varsayilan: 'iz',
    kpi: [{ etiket: 'Toplam gider', deger: tl(s.toplam), renk: R.kirmizi }, ...KALEM.filter((k) => s[k]).map((k) => ({ etiket: TUR_AD[k], deger: tl(s[k]) })),
      ...(s.depo_mu ? [] : [{ etiket: 'Depodan gelen mal', deger: tl(s.sevk_bedeli) },
        { etiket: 'Rafta bekleyen (sevk − ürün aç)', deger: s.rafta_fark < 0 ? 'sevk kaydı eksik olabilir' : tl(s.rafta_fark) }])],
    not: [s.fiyat_eksik ? `🔴 ${s.fiyat_eksik} ürün aç satırının fiyatı yok — gider olduğundan düşük` : null,
      s.katalog_fiyatli ? `${s.katalog_fiyatli} satır katalog fiyatıyla (fatura fiyatı yok)` : null,
      s.kesin_olmayan_gun?.length ? `${s.kesin_olmayan_gun.length} günün kapanışı yok — o günler kesinleşmedi` : null].filter(Boolean).join(' · ') || null,
    listeBaslik: 'Dükkân giderleri · patron harcaması mı?',
    satirlar: s.satirlar.filter((x) => x.tur === 'dukkan').map((x) => ({
      ad: `${tKisa(x.gun)} · ${x.aciklama}${x.oneri_cekis ? '  ⚠ patron harcaması olabilir' : ''}`, tutar: tl(x.tutar), detay: 'Patron harcamasıysa tıkla',
      onTikla: () => window.confirm(`"${x.aciklama}" (${fmt(x.tutar)} ₺) patron harcaması mı? Şube giderinden çıkar.`) && sinifla(x.kaynak_ref, 'cekis', null),
    })),
    tablo: {
      ad: 'Gider satırları',
      kolonlar: [{ ad: 'Gün' }, { ad: 'Tür' }, { ad: 'Açıklama', sar: true }, { ad: 'Adet', sag: true }, { ad: 'Birim (KDV dahil)', sag: true }, { ad: 'Tutar', sag: true }, { ad: 'Not', sar: true }],
      satirlar: [...s.satirlar.map((x) => [tKisa(x.gun), TUR_AD[x.tur], x.aciklama, x.adet == null ? '' : fmt(x.adet), x.birim == null ? '' : fmt(x.birim),
        x.not === 'FİYATI EKSİK' ? { t: 'fiyat yok', renk: R.kirmizi } : { t: fmt(x.tutar), kalin: true }, x.not || '']),
      ...(s.sevk_satirlar || []).map((x) => [tKisa(x.gun), { t: TUR_AD.sevk, renk: R.not }, x.aciklama, fmt(x.adet), x.birim == null ? '' : fmt(x.birim),
        x.birim == null ? { t: 'fiyat yok', renk: R.kirmizi } : { t: fmt(x.tutar), renk: R.not }, 'stok — gider değil'])],
    },
  });

  if (hata && !v) return <div className="pi"><style>{PI_CSS}</style><div style={{ ...kart, padding: 16, color: R.kirmizi }}>Giderler okunamadı: {hata} <Dugme kucuk onClick={yukle}>Tekrar dene</Dugme></div></div>;
  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: R.not }}>Giderler okunuyor…</div></div>;

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Gider</div><h1 style={{ fontSize: 30 }}>Giderlerim</h1></div>
        <label style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>Ay
          <AySecici ay={ay} setAy={setAy}
            style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        </label>
      </div>

      <div style={{ ...kart, padding: '16px 20px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={etiketStil}>{tUzun(v.ay_basi).split(' ')[1]} giderleri{v.ay_bitti ? '' : ' · bugüne kadar'} · şubeler {fmt(v.sube_toplam)} + Ortak {fmt(v.ortak.toplam)}</div>
          <div style={{ ...num, fontSize: 40, fontWeight: 700, color: R.kirmizi, lineHeight: 1.05 }}>{tl(v.toplam)}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {KALEM.filter((k) => v[k]).map((k) => [TUR_AD[k], v[k]]).concat([['Depodan gelen mal (ayrı)', v.sevk_bedeli]]).map(([a, t]) => (
            <div key={a}><div style={etiketStil}>{a}</div><div style={{ ...num, fontSize: 17 }}>{fmt(t)}</div></div>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {v.fiyat_eksik_toplam > 0 ? <Cip tur="kirmizi">{v.fiyat_eksik_toplam} satır fiyatsız</Cip> : <Cip tur="yesil">her satır fiyatlı</Cip>}
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>{v.kapsam_notu}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
        {v.subeler.map((s) => {
          const t = s.toplam || 1;
          return (
            <button key={s.sube_id} type="button" onClick={() => subeAc(s)} style={{
              ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: R.krem, padding: '14px 16px',
              borderLeft: `5px solid ${s.fiyat_eksik ? R.kirmizi : 'var(--pi-line)'}`, display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <span style={etiketStil}>Şube gideri{s.depo_mu ? ' · depo burada' : ''}</span>
              <b style={{ fontSize: 15 }}>{s.ad}</b>
              <span style={{ ...num, fontSize: 24, fontWeight: 700 }}>{tl(s.toplam)}</span>
              <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--pi-bg)' }} aria-hidden="true">
                {KALEM.map((k) => s[k] > 0 && <span key={k} style={{ width: `${(s[k] * 100) / t}%`, background: TUR_RENK[k] }} />)}
              </div>
              <span style={{ fontSize: 12, color: R.metin2 }}>{KALEM.filter((k) => s[k]).map((k) => `${TUR_AD[k]} ${fmt(s[k])}`).join(' · ') || 'gider yok'}</span>
              {!s.depo_mu && <span style={{ fontSize: 12, color: R.not }}>Depodan gelen {fmt(s.sevk_bedeli)} · {s.rafta_fark < 0 ? 'açılan > gelen (sevk kaydı eksik ya da doğrudan alım)' : `rafta ${fmt(s.rafta_fark)}`}</span>}
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {s.fiyat_eksik > 0 && <Cip tur="kirmizi">{s.fiyat_eksik} fiyatsız</Cip>}
                {s.depo_mu && <Cip tur="sari">depo şubesi</Cip>}
                {s.kesin_olmayan_gun?.length > 0 && <Cip>{s.kesin_olmayan_gun.length} gün kesin değil</Cip>}
                <span style={{ marginLeft: 'auto', color: 'var(--pi-accent)', fontWeight: 700 }}>›</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Fable P2-5: "Onur bey sigara" gibi patron şahsi olabilecek dükkân giderleri — tek tuşla ayır */}
      {(() => {
        const aday = v.subeler.flatMap((s) => s.satirlar.filter((x) => x.tur === 'dukkan' && x.oneri_cekis).map((x) => ({ ...x, sube: s.ad })));
        if (!aday.length) return null;
        return (
          <div style={{ ...kart, padding: 14, borderLeft: '5px solid var(--pi-warn)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>🚬 <b>{aday.length} dükkân gideri patron harcaması mı?</b> ({aday.map((x) => `${x.sube} ${tKisa(x.gun)} ${fmt(x.tutar)}`).join(', ')})</span>
            <Dugme ana kucuk onClick={async () => {
              if (!window.confirm(`${aday.length} kayıt patron harcaması olarak ayrılsın mı? Şube giderinden çıkar; hangi patron olduğu Patron harcamaları'nda seçilir.`)) return;
              for (const x of aday) { try { await api('/evvel-yeni/gider/siniflandir', { method: 'POST', body: { kaynak_ref: x.kaynak_ref, tur: 'cekis', kimin: null } }); } catch { /* devam */ } }
              onToast?.(`${aday.length} kayıt patron harcaması olarak ayrıldı`); yukle();
            }}>Evet, patron harcaması</Dugme>
          </div>
        );
      })()}

      <div style={{ ...kart, padding: 14 }}>
        <b>Ortak giderler</b> <span style={{ color: R.not, fontSize: 12.5 }}>tek şubeye ait değil — şubelere dağıtılmaz</span>
        {v.ortak.satirlar.length ? v.ortak.satirlar.map((x, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 13 }}>
            <span>{tKisa(x.gun)} · {TUR_AD[x.tur]} · {x.aciklama}</span><b style={num}>{fmt(x.tutar)}</b>
          </div>
        )) : <div style={{ color: R.not, fontSize: 13, marginTop: 6 }}>Bu ay ortak gider yok. Ödeme bölümünden "Diğer → Ortak" ile girilir.</div>}
        {v.ortak.satirlar.length > 0 && <div style={{ textAlign: 'right', marginTop: 6 }}>Toplam <b style={num}>{fmt(v.ortak.toplam)}</b> ₺</div>}
      </div>

      {/* Sahip (2026-10-16): "patron çekişlerini ilk yerinden kaldır; şube giderinde sadece patron harcaması sorusu sorsun"
          → ayrılanlar Ödeme → Patron harcamaları'nda (hangi patron + geri alma orada) */}
      {v.cekisler.length > 0 && (
        <div style={{ fontSize: 13, color: R.not }}>Bu ay {v.cekisler.length} dükkân gideri patron harcaması olarak ayrıldı ({fmt(v.cekis_toplam)} ₺) — Ödeme → Patron harcamaları'nda.</div>
      )}
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}
