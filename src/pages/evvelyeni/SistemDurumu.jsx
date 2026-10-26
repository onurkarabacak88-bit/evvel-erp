// ⚙️ SİSTEM DURUMU — çekirdek ekranı (sunucu: evvel_yeni_moduller.py · /moduller + /moduller/gorevler). Sayfası Tanımlar altında.
// IS 5c / F3.1 B7+B11 (sim 26 Eki · Opus + Codex + Fable): Kasa ve Depo'nun otomatik işleri ekran açılınca değil arka planda koşar;
// ne zaman koştu, ne yaptı, hata verdi mi TEK yerde + "Şimdi çalıştır". Kural: sök-tak sade, bakım içeride — tek Sistem durumu ekranı.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, Dugme, Cip } from './KasaModulu';

export const SISTEM_SAYFALAR = [{ id: 'sistem_durumu', ad: 'Sistem durumu', alt: 'Modüller · otomatik işler' }];

const saat = (z) => (z ? new Date(z).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const ozetYaz = (o) => (o?.kesildi ? (o.not || 'kapandı') : Object.entries(o || {})   // Fable: 1 Kasım sonrası depo aktarımı "kapandı" der
  .filter(([k, v]) => typeof v === 'number' && v > 0 && k !== 'kilitli')
  .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(' · ') || 'yeni iş yoktu');

// sunucunun teknik durumu → sade söz ('eksik:tanim,depo' → 'Tanımlar, Depo kapalı olduğu için yüklenmedi')
const durumYaz = (d, liste) => {
  if (d === 'kapali') return 'kapalı';
  if (d?.startsWith('eksik:')) {
    const ad = (k) => (liste || []).find((x) => x.kod === k)?.ad || k;
    return `${d.slice(6).split(',').map(ad).join(', ')} kapalı olduğu için yüklenmedi`;
  }
  if (d?.startsWith('hata:')) return `yüklenirken hata — ${d.slice(5)}`;
  return d;
};

export default function SistemDurumu({ onToast }) {
  const [g, setG] = useState(null);
  const [m, setM] = useState(null);
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => {
    setHata('');
    Promise.all([api('/evvel-yeni/moduller/gorevler'), api('/evvel-yeni/moduller')])
      .then(([a, b]) => { setG(a); setM(b); }).catch((e) => setHata(e?.message || 'Okunamadı'));
  }, []);
  useEffect(() => { yukle(); }, [yukle]);
  const calistir = async (ad) => {
    setMesgul(ad);
    try {
      const r = await api(`/evvel-yeni/moduller/gorevler/${ad}/calistir`, { method: 'POST' });
      onToast?.(r.zaten ? 'Bu iş şu an zaten çalışıyor' : r.ok ? `Çalıştı · ${ozetYaz(r.ozet)}` : `Hata: ${r.hata || r.mesaj}`);
      yukle();
    } catch (e) { setHata(e?.message || 'Çalıştırılamadı'); }
    setMesgul('');
  };
  const sorunluMod = (m?.moduller || []).filter((x) => x.durum !== 'yuklendi');
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Tanımlar</div><h1 style={{ fontSize: 30 }}>Sistem durumu</h1></div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!g && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {g && (
        <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b>Otomatik işler</b>
            {g.zamanlayici ? <Cip tur="yesil">zamanlayıcı çalışıyor</Cip> : <Cip tur="kirmizi">zamanlayıcı çalışmıyor</Cip>}
          </div>
          <table className="pi-tablo" style={{ fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left' }}>İş</th><th style={{ textAlign: 'left' }}>Son koşu</th><th style={{ textAlign: 'left' }}>Ne yaptı</th><th>24 saatte</th><th /></tr></thead>
            <tbody>{g.gorevler.map((x) => {
              const son = x.son;
              return (
                <tr key={x.ad} style={{ background: son && !son.tamam ? 'var(--pi-bad-soft, #fbe9e7)' : x.gecikti ? 'var(--pi-warn-soft, #fff4e0)' : undefined }}>
                  <td style={{ textAlign: 'left' }}><b>{x.baslik}</b><div style={{ fontSize: 11.5, color: R.not }}>{x.modul} · her {Math.round(x.aralik_sn / 60)} dk</div></td>
                  <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {son ? saat(son.bitir) : 'henüz koşmadı'}{son?.elle ? ' (elle)' : ''}
                    {x.gecikti && <div style={{ color: R.amber, fontSize: 12 }}>gecikti{x.son_basarili ? ` · son başarılı ${saat(x.son_basarili.bitir)}` : ''}</div>}
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    {son ? (son.hata ? <span style={{ color: son.tamam ? R.amber : R.kirmizi }}>{son.hata}</span> : ozetYaz(son.ozet)) : '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{x.kosu_24s} kez{x.hatali_24s ? <span style={{ color: R.kirmizi }}> · {x.hatali_24s} hatalı</span> : ''}</td>
                  <td><Dugme kucuk disabled={mesgul === x.ad} onClick={() => calistir(x.ad)}>{mesgul === x.ad ? 'Çalışıyor…' : 'Şimdi çalıştır'}</Dugme></td>
                </tr>
              );
            })}</tbody>
          </table>
          {g.kayitsiz.length > 0 && <div style={{ color: R.kirmizi, fontSize: 12.5 }}>Kaydedilemeyen iş: {g.kayitsiz.map((x) => `${x.ad} (${x.hata})`).join(' · ')}</div>}
        </div>
      )}
      {m && (
        <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <b>Modüller</b>
          <div style={{ fontSize: 13 }}>{(m.moduller || []).filter((x) => x.durum === 'yuklendi').length} modül yüklü{sorunluMod.length ? '' : ' · sorun yok'}</div>
          {sorunluMod.map((x) => <div key={x.kod} style={{ fontSize: 13, color: x.durum === 'kapali' ? R.not : R.kirmizi }}>{x.ikon} {x.ad}: {durumYaz(x.durum, m.moduller)}</div>)}
        </div>
      )}
    </div>
  );
}
