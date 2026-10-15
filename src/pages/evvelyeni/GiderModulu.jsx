// ─────────────────────────────────────────────────────────────────────────────
// 💸 EVVEL YENİ · GİDER — şubenin KENDİ işletme yükü (borç/kredi/patron şahsi YOK)
//
// Sahip (2026-10-15): "Şubeler sanki hiç borcu yokmuş gibi — yalnız malı ve tükettiği
// giderleri ödemekle mükellef." · "Her şubeye giden malın değeri kadar sevkiyat gider
// olarak girmeli; depoya geliş fiyatından değil GÜNCELLENMİŞ fiyattan."
// Bütün rakamlar /api/evvel-yeni/gider'den; ekran yalnız dizer.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, etiketStil, num, Dugme, Cip, Cekmece, fmt, tl, tUzun, tKisa } from './KasaModulu';

export const GIDER_SAYFALAR = [
  { id: 'giderler', ad: 'Giderlerim', alt: 'Şube şube · mal · dükkân · komisyon' },
];

const TUR_RENK = { mal: 'var(--pi-accent)', dukkan: 'var(--pi-warn)', komisyon: 'var(--pi-ink3)' };
const TUR_AD = { mal: 'Mal (sevkiyat)', dukkan: 'Dükkân küçük', komisyon: 'Komisyon' };

export default function GiderModulu({ onToast }) {
  const [ay, setAy] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [ck, setCk] = useState(null);
  const no = useRef(0);
  const yukle = useCallback(async () => {
    const n = ++no.current;
    try { const r = await api(`/evvel-yeni/gider/ozet?ay=${ay}`); if (n === no.current) { setV(r); setHata(null); } } catch (e) { if (n === no.current) setHata(e?.message || 'okunamadı'); }
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);

  const sinifla = async (ref, tur, kimin) => {
    try { await api('/evvel-yeni/gider/siniflandir', { method: 'POST', body: { kaynak_ref: ref, tur, kimin } }); onToast?.(tur === 'cekis' ? 'Patron şahsi olarak ayrıldı' : 'Şube giderine geri alındı'); setCk(null); yukle(); }
    catch (e) { onToast?.(e.message); }
  };

  const subeAc = (s) => setCk({
    tip: 'ŞUBE GİDERİ', baslik: `${s.ad} · ${tUzun(v.ay_basi).split(' ')[1]}`,
    alt: s.depo_mu ? 'Depo bu şubede — depodan kendi kullanımı sevkiyat kaydı yoksa mal gideri eksik görünebilir' : 'Mal = sevk edilen adet × sevk günündeki güncel fiyat (KDV dahil)',
    varsayilan: 'iz',
    kpi: [{ etiket: 'Toplam', deger: tl(s.toplam), renk: R.kirmizi }, { etiket: 'Mal', deger: tl(s.mal) }, { etiket: 'Dükkân küçük', deger: tl(s.dukkan) }, { etiket: 'Komisyon', deger: tl(s.komisyon) }],
    not: [s.fiyat_eksik ? `🔴 ${s.fiyat_eksik} sevk satırının fiyatı yok — gider olduğundan düşük` : null,
      s.katalog_fiyatli ? `${s.katalog_fiyatli} satır katalog fiyatıyla (fatura fiyatı yok)` : null].filter(Boolean).join(' · ') || null,
    listeBaslik: 'Dükkân giderleri · patron şahsi olanı ayır',
    satirlar: s.satirlar.filter((x) => x.tur === 'dukkan').map((x) => ({
      ad: `${tKisa(x.gun)} · ${x.aciklama}${x.oneri_cekis ? '  ⚠ şahsi olabilir' : ''}`, tutar: tl(x.tutar), detay: 'Tıkla → Patron şahsi (çekiş)',
      onTikla: () => sinifla(x.kaynak_ref, 'cekis', 'Onur'),
    })),
    tablo: {
      ad: 'Gider satırları',
      kolonlar: [{ ad: 'Gün' }, { ad: 'Tür' }, { ad: 'Açıklama', sar: true }, { ad: 'Adet', sag: true }, { ad: 'Birim (KDV dahil)', sag: true }, { ad: 'Tutar', sag: true }, { ad: 'Not', sar: true }],
      satirlar: s.satirlar.map((x) => [tKisa(x.gun), TUR_AD[x.tur], x.aciklama, x.adet == null ? '' : fmt(x.adet), x.birim == null ? '' : fmt(x.birim),
        x.not === 'FİYATI EKSİK' ? { t: 'fiyat yok', renk: R.kirmizi } : { t: fmt(x.tutar), kalin: true }, x.not || '']),
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
          <input type="month" value={ay} onChange={(e) => e.target.value && setAy(e.target.value)}
            style={{ font: 'inherit', padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-paper)', color: 'var(--pi-ink)' }} />
        </label>
      </div>

      <div style={{ ...kart, padding: '16px 20px', background: 'var(--pi-accent-soft)', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={etiketStil}>{tUzun(v.ay_basi).split(' ')[1]} şube giderleri{v.ay_bitti ? '' : ' · bugüne kadar'}</div>
          <div style={{ ...num, fontSize: 40, fontWeight: 700, color: R.kirmizi, lineHeight: 1.05 }}>{tl(v.toplam)}</div>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {[['Mal (sevkiyat)', v.mal], ['Dükkân küçük', v.dukkan], ['Komisyon', v.komisyon]].map(([a, t]) => (
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
          const t = s.mal + s.dukkan + s.komisyon || 1;
          return (
            <button key={s.sube_id} type="button" onClick={() => subeAc(s)} style={{
              ...kart, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: R.krem, padding: '14px 16px',
              borderLeft: `5px solid ${s.fiyat_eksik ? R.kirmizi : 'var(--pi-line)'}`, display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <span style={etiketStil}>Şube gideri{s.depo_mu ? ' · depo burada' : ''}</span>
              <b style={{ fontSize: 15 }}>{s.ad}</b>
              <span style={{ ...num, fontSize: 24, fontWeight: 700 }}>{tl(s.toplam)}</span>
              <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--pi-bg)' }} aria-hidden="true">
                {['mal', 'dukkan', 'komisyon'].map((k) => s[k] > 0 && <span key={k} style={{ width: `${(s[k] * 100) / t}%`, background: TUR_RENK[k] }} />)}
              </div>
              <span style={{ fontSize: 12, color: R.metin2 }}>Mal {fmt(s.mal)} · dükkân {fmt(s.dukkan)} · komisyon {fmt(s.komisyon)}</span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {s.fiyat_eksik > 0 && <Cip tur="kirmizi">{s.fiyat_eksik} fiyatsız</Cip>}
                {s.depo_mu && <Cip tur="sari">depo şubesi</Cip>}
                <span style={{ marginLeft: 'auto', color: 'var(--pi-accent)', fontWeight: 700 }}>›</span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ ...kart, padding: 14 }}>
        <b>Patron çekişleri</b> <span style={{ color: R.not, fontSize: 12.5 }}>çekmeceden çıktı ama şube gideri DEĞİL</span>
        {v.cekisler.length ? v.cekisler.map((x) => (
          <div key={x.kaynak_ref} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--pi-line)', fontSize: 13 }}>
            <span>{tKisa(x.gun)} · {x.sube} · {x.aciklama} <span style={{ color: R.not }}>({x.kim})</span></span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b style={num}>{fmt(x.tutar)}</b><Dugme kucuk onClick={() => sinifla(x.kaynak_ref, 'gider')}>Şube giderine al</Dugme></span>
          </div>
        )) : <div style={{ color: R.not, fontSize: 13, marginTop: 6 }}>Ayrılmış çekiş yok. Bir şube kartını açıp dükkân giderinin üstüne tıklayarak "patron şahsi" diye ayırabilirsin.</div>}
        {v.cekisler.length > 0 && <div style={{ textAlign: 'right', marginTop: 6 }}>Toplam <b style={num}>{fmt(v.cekis_toplam)}</b> ₺</div>}
      </div>
      <Cekmece v={ck} onKapat={() => setCk(null)} />
    </div>
  );
}
