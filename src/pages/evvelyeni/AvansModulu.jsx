// 🤝 AVANS TALEPLERİ — tak-çıkar modül (sunucu: evvel_yeni_avans_api.py). Sayfası Personel altında.
// Sahip (2026-10-17): "Avans taleplerini görebileceğim bir mekanizma olmalı." Personel QR sayfasından talep eder;
// burada havaleyle öde (bankadan düşer, maaştan mahsup) · elden ver (şubeden) · reddet.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt } from './KasaModulu';

export const AVANS_SAYFALAR = [{ id: 'avans_talepleri', ad: 'Avans talepleri', alt: 'Personelin talepleri · öde / reddet' }];
const alan = { padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 13.5 };

export default function AvansModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [L, setL] = useState(null);
  const [hata, setHata] = useState('');
  const [sec, setSec] = useState({});      // id → { cep, sube_id }
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => {
    api('/evvel-yeni/avans/talepler').then(setV).catch((e) => setHata(e?.message || 'Talepler okunamadı'));
  }, []);
  useEffect(() => { yukle(); api('/evvel-yeni/odeme/listeler').then(setL).catch(() => {}); }, [yukle]);
  const yap = async (t, yol, govde) => {
    setMesgul(t.id); setHata('');
    try { const d = await api(`/evvel-yeni/avans/${t.id}/${yol}`, { method: 'POST', body: govde }); onToast?.(d.mesaj); yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); }
    setMesgul('');
  };
  const bekleyen = (v?.talepler || []).filter((t) => t.durum === 'talep');
  const elden = (v?.talepler || []).filter((t) => t.durum !== 'talep');
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Avans talepleri</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Personel talebi QR personel sayfasından gönderir. Havaleyle ödenen avans seçtiğin bankadan düşer; elden verilecekse şube panelinden teslim edilince dükkân kasasından düşer. İkisinde de avans o personelin maaşından düşülür.</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          {bekleyen.length === 0 && <div style={{ color: R.not, padding: 6 }}>Bekleyen avans talebi yok.</div>}
          {bekleyen.map((t) => {
            const s = sec[t.id] || {};
            const set = (k, x) => setSec((o) => ({ ...o, [t.id]: { ...s, [k]: x } }));
            return (
              <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '8px 0', fontSize: 13.5 }}>
                <span style={{ flex: '1 1 180px' }}><b>{t.ad}</b><div style={{ fontSize: 12, color: R.not }}>talep {t.talep}</div></span>
                <b style={{ ...num, width: 90, textAlign: 'right' }}>{fmt(t.tutar)} ₺</b>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={s.cep || ''} onChange={(e) => set('cep', e.target.value)} style={alan}>
                    <option value="">Banka…</option>{(L?.banka_cepler || []).map((c) => <option key={c.id} value={c.id}>{c.ad} ({fmt(c.bakiye)})</option>)}
                  </select>
                  <Dugme kucuk ana disabled={!s.cep || mesgul === t.id} onClick={() => yap(t, 'onayla', { yontem: 'havale', cep: s.cep })}>Havaleyle öde</Dugme>
                  <select value={s.sube_id || ''} onChange={(e) => set('sube_id', e.target.value)} style={alan}>
                    <option value="">Şube…</option>{(L?.subeler || []).map((b) => <option key={b.id} value={b.id}>{b.ad}</option>)}
                  </select>
                  <Dugme kucuk disabled={!s.sube_id || mesgul === t.id} onClick={() => yap(t, 'onayla', { yontem: 'elden', sube_id: s.sube_id })}>Elden ver</Dugme>
                  <Dugme kucuk disabled={mesgul === t.id} onClick={() => yap(t, 'reddet', {})}>Reddet</Dugme>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {elden.length > 0 && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700 }}>Onaylandı · şubeden teslim bekleniyor</div>
          {elden.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0', fontSize: 13.5 }}>
              <span style={{ flex: 1 }}><b>{t.ad}</b> · {t.sube || '—'}</span><b style={num}>{fmt(t.tutar)} ₺</b><Cip tur="sari">{t.durum === 'teslim_edildi' ? 'personel onayı bekliyor' : 'elden verilecek'}</Cip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
