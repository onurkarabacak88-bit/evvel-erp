// 🤝 AVANS TALEPLERİ — tak-çıkar modül (sunucu: evvel_yeni_avans_api.py). Sayfası Personel altında.
// Sahip (2026-10-17): "Avans taleplerini görebileceğim bir mekanizma olmalı." Personel QR sayfasından talep eder;
// burada havaleyle öde (bankadan düşer, maaştan mahsup) · elden ver (şubeden) · reddet.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { ALAN, Cip, Dugme, fmt, kart, num, PI_CSS, R, soruOnay, soruYaz } from './KasaModulu';
// B96: '2026-10-23 11:12' → '23.10 11:12'
const trTalep = (x) => (/^\d{4}-\d{2}-\d{2}/.test(x || '') ? `${x.slice(8, 10)}.${x.slice(5, 7)}${x.length > 10 ? ' ' + x.slice(11, 16) : ''}` : x);

export const AVANS_SAYFALAR = [{ id: 'avans_talepleri', ad: 'Avans talepleri', alt: 'Personelin talepleri · öde / reddet' }];
const alan = { ...ALAN, padding: '6px 9px', borderRadius: 9, fontSize: 13.5 };   // temel stil KasaModulu ALAN (T4-15)

export default function AvansModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [L, setL] = useState(null);
  const [hata, setHata] = useState('');
  const [sec, setSec] = useState({});      // id → { cep, sube_id }
  const [mesgul, setMesgul] = useState({});   // Codex: satır bazlı — paralel işlemler birbirini ezmesin
  const yukle = useCallback(() => api('/evvel-yeni/avans/talepler').then((d) => { setV(d); setHata(''); })
    .catch((e) => setHata(e?.message || 'Talepler okunamadı')), []);
  useEffect(() => { yukle(); api('/evvel-yeni/odeme/listeler').then(setL).catch(() => setHata('Şube listesi okunamadı — sayfayı yenile')); }, [yukle]);
  const yap = async (t, yol, govde) => {
    setMesgul((m) => ({ ...m, [t.id]: true })); setHata('');
    try { const d = await api(`/evvel-yeni/avans/${t.id}/${yol}`, { method: 'POST', body: govde }); onToast?.(d.mesaj); await yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); }
    setMesgul((m) => { const y = { ...m }; delete y[t.id]; return y; });
  };
  const bekleyen = (v?.talepler || []).filter((t) => t.durum === 'talep');
  const elden = (v?.talepler || []).filter((t) => t.durum !== 'talep');
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Avans talepleri</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Personel talebi QR personel sayfasından gönderir. "Havaleyle ödendi" — parayı bankadan gönderdiysen. "Elden ver" — şube panelinden teslim edilince dükkân kasasından düşer. İkisinde de avans o personelin maaşından düşülür.</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {hata && <div><Dugme kucuk onClick={yukle}>Yeniden dene</Dugme></div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          {bekleyen.length === 0 && <div style={{ color: R.not, padding: 6 }}>Bekleyen avans talebi yok.</div>}
          {bekleyen.map((t) => {
            const s = sec[t.id] || {};
            const set = (k, x) => setSec((o) => ({ ...o, [t.id]: { ...s, [k]: x } }));
            return (
              <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '8px 0', fontSize: 13.5 }}>
                <span style={{ flex: '1 1 180px' }}><b>{t.ad}</b>{t.ayrilis && <Cip tur="kirmizi">ayrılış {t.ayrilis}</Cip>}<div style={{ fontSize: 12, color: R.not }}>talep {trTalep(t.talep)}</div>
                  {t.tavan != null && <div style={{ fontSize: 12, color: t.kullanilan > t.tavan ? R.kirmizi : R.metin2 }}>bu ay tavan {fmt(t.tavan)} ₺ · bu talep dahil {fmt(t.kullanilan)} ₺</div>}{t.not && <div style={{ fontSize: 12.5 }}>📝 {t.not}</div>}</span>
                <b style={{ ...num, width: 90, textAlign: 'right' }}>{fmt(t.tutar)} ₺</b>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {!t.ayrildi && t.yeni && <select value={s.cep || ''} onChange={(e) => set('cep', e.target.value)} style={alan}>
                    <option value="">Banka…</option>{(L?.banka_cepler || []).filter((b) => Number(b.bakiye) > 0).map((b) => <option key={b.id} value={b.id}>{b.ad} · şu an {fmt(b.bakiye)} ₺</option>)}
                  </select>}
                  {!t.ayrildi && <Dugme kucuk ana disabled={mesgul[t.id] || (t.yeni && !(L?.banka_cepler || []).some((x) => x.id === s.cep && Number(x.bakiye) > 0))} onClick={async () => { const b = (L?.banka_cepler || []).find((x) => x.id === s.cep); if (await soruOnay(`${t.ad} · ${fmt(t.tutar)} ₺ ${b ? b.ad + "'ndan " : ''}havale ettin mi?
Önce bankadan gönder, sonra onayla — bankadan düşer, maaştan mahsup edilir, personel "hesabına havale edildi" görür.`)) yap(t, 'onayla', { yontem: 'havale', cep: s.cep }); }}>Havaleyi gönderdim</Dugme>}
                  {!t.ayrildi && <select value={s.sube_id ?? t.kisi_sube_id ?? ''} onChange={(e) => set('sube_id', e.target.value)} style={alan}>
                    <option value="">Şube…</option>{(L?.subeler || []).map((b) => <option key={b.id} value={b.id}>{b.ad}</option>)}
                  </select>}
                  {!t.ayrildi && <Dugme kucuk disabled={!(s.sube_id ?? t.kisi_sube_id) || mesgul[t.id]} onClick={() => yap(t, 'onayla', { yontem: 'elden', sube_id: s.sube_id ?? t.kisi_sube_id })}>Elden ver</Dugme>}
                  <Dugme kucuk disabled={mesgul[t.id]} onClick={() => yap(t, 'kapat', { not_: 'daha önce verildi' })}>Kapat (verildi)</Dugme>
                  <Dugme kucuk disabled={mesgul[t.id]} onClick={async () => { const n = await soruYaz(`${t.ad} · ${fmt(t.tutar)} ₺ avans talebi neden reddediliyor? (personel görür)`, false, 2); if (n && n.trim().length >= 2) yap(t, 'reddet', { neden: n.trim() }); }}>Reddet</Dugme>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {(v?.kapananlar || []).length > 0 && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2, opacity: 0.6 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700 }}>Sonuçlananlar (son 60 gün)</div>
          {v.kapananlar.map((t) => (
            <div key={t.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0', fontSize: 13, color: R.not }}>
              <span style={{ flex: '1 1 220px' }}>{t.ad} · talep {trTalep(t.talep)}{t.not ? ` · ${t.not}` : ''}
                {t.durum === 'odendi' && <> · {t.yontem === 'elden' ? `elden · ${t.sube || '—'}${t.veren ? ` · veren ${t.veren}` : ''}` : 'havale'} · {trTalep(t.teslim)}</>}</span>
              <span style={num}>{fmt(t.tutar)} ₺</span>
              {t.kendine && <Cip tur="sari">kendine teslim</Cip>}
              <Cip tur={t.durum === 'odendi' ? 'yesil' : undefined}>{{ reddedildi: 'reddedildi', kapatildi: 'kapatıldı', odendi: 'ödendi' }[t.durum] || t.durum}</Cip>
            </div>
          ))}
        </div>
      )}
      {elden.length > 0 && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700 }}>Onaylandı · şubeden teslim bekleniyor</div>
          {elden.map((t) => (
            <div key={t.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0', fontSize: 13.5 }}>
              <span style={{ flex: '1 1 220px' }}><b>{t.ad}</b>{t.ayrilis && <Cip tur="kirmizi">ayrılış {t.ayrilis}</Cip>} · {t.sube || '—'}</span><b style={num}>{fmt(t.tutar)} ₺</b>{t.bekliyor_gun > 0 && <Cip tur="kirmizi">{t.bekliyor_gun} gündür bekliyor</Cip>}<Cip tur="sari">{t.durum === 'teslim_edildi' ? 'personel onayı bekliyor' : 'elden verilecek — şube panelinde "teslim ettim"'}</Cip>
              {/* Fable O-2: şube teslim etmediyse (kişi ayrıldı, yanlış şube) talep merkezden kapatılır — yoksa kişi yeni talep açamaz */}
              {String(t.id).startsWith('av-') && t.durum === 'onaylandi' && t.yontem === 'elden' && (
                <select value={t.sube_id || ''} disabled={mesgul[t.id]} title="Kişi bu şubeye gelmiyorsa başka şubeden ver (para hareketi yok)"
                  onChange={(e) => e.target.value && yap(t, 'sube', { sube_id: e.target.value })} style={alan}>
                  {(L?.subeler || []).map((b) => <option key={b.id} value={b.id}>{b.ad}</option>)}
                </select>
              )}
              {String(t.id).startsWith('av-') && t.durum === 'onaylandi' && (
                <Dugme kucuk disabled={mesgul[t.id]} onClick={async () => { if (await soruOnay(`${t.ad} · ${fmt(t.tutar)} ₺ — şube teslim etmedi, talep kapatılsın mı? (para hareketi yok)`)) yap(t, 'kapat', { not_: 'şube teslim etmedi — merkez kapattı' }); }}>Kapat</Dugme>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
