// ⚙️ SİSTEM DURUMU — çekirdek ekranı (sunucu: evvel_yeni_moduller.py · /moduller + /moduller/gorevler). Sayfası Tanımlar altında.
// IS 5c / F3.1 B7+B11 (sim 26 Eki · Opus + Codex + Fable): Kasa ve Depo'nun otomatik işleri ekran açılınca değil arka planda koşar;
// ne zaman koştu, ne yaptı, hata verdi mi TEK yerde + "Şimdi çalıştır". Kural: sök-tak sade, bakım içeride — tek Sistem durumu ekranı.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, Dugme, Cip, soruOnay } from './KasaModulu';

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

// ✂️ 1 KASIM SON AKTARIM (KESIM_1KASIM_ENVANTERI ⚖️ · sunucu: evvel_yeni_moduller /kesim) — eski dönemin çıktısı Evvel Yeni arşivine
// BİR KEZ dondurulur. Adım adım: önce "Kuru dene" (sayar, yazmaz), sonra "Çalıştır" (yalnız 1 Kasım 02:00 sonrası açılır). Kesim yayınında kalkar.
const sonucYaz = (s) => Object.entries(s || {}).filter(([, v]) => v != null).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' && v ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`).join(' · ');

function SonAktarim({ onToast }) {
  const [v, setV] = useState(null);
  const [mesgul, setMesgul] = useState('');
  const [kuru, setKuru] = useState({});
  const [hata, setHata] = useState('');
  const yukle = useCallback(() => { api('/evvel-yeni/moduller/kesim').then(setV).catch((e) => setHata(e?.message || 'Okunamadı')); }, []);
  useEffect(() => { yukle(); }, [yukle]);
  if (!v || !v.adimlar?.length) return hata ? <div style={{ color: R.kirmizi }}>{hata}</div> : null;
  const calistir = async (x, k) => {
    if (!k && !(await soruOnay(`"${x.baslik}" GERÇEKTEN yazılsın mı? (Önce kuru denemenin sonucuna bak.)`, 'Evet, yaz'))) return;
    setMesgul(x.kod + (k ? ':kuru' : ''));
    try {
      const r = await api('/evvel-yeni/moduller/kesim/calistir', { method: 'POST', body: { kod: x.kod, kuru: k } });
      if (k) setKuru((o) => ({ ...o, [x.kod]: r })); else { onToast?.(`${x.ad} arşive yazıldı`); yukle(); }
    } catch (e) { setKuru((o) => ({ ...o, [x.kod]: { hata: e?.message || 'çalışmadı' } })); }   // hata kendi satırında (tek satırda bir sonrakini siliyordu)
    setMesgul('');
  };
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>✂️ 1 Kasım son aktarım — {v.ay}</b>
        {v.gercek_acik ? <Cip tur="sari">çalıştırılabilir</Cip> : <Cip>yalnız kuru deneme · gerçek {v.baslangic} 02:00 sonrası</Cip>}
      </div>
      <div style={{ fontSize: 12.5, color: R.not }}>Eski sistemin {v.ay} kayıtları Evvel Yeni arşivine bir kez dondurulur; sonra ekranlar o ayı arşivden okur. Sırayla: önce kuru dene, sayıları kontrol et, sonra çalıştır. Personel adımı uzun sürebilir — bitene kadar sayfayı kapatma.</div>
      {v.adimlar.map((x) => (
        <div key={x.kod} style={{ borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <span style={{ flex: '1 1 260px' }}><b>{x.ad}</b> — {x.baslik}
            {x.son && <div style={{ color: R.yesil, fontSize: 12 }}>✓ yazıldı {saat(x.son.zaman)} · {x.son.yazan} · {sonucYaz(x.son.sonuc)}</div>}
            {kuru[x.kod]?.hata && <div style={{ color: R.kirmizi, fontSize: 12, overflowWrap: 'anywhere' }}>✗ {kuru[x.kod].hata}</div>}
            {kuru[x.kod]?.sonuc && <div style={{ color: R.metin2, fontSize: 12 }}>kuru ({kuru[x.kod].sure_sn} sn): {sonucYaz(kuru[x.kod].sonuc)}</div>}
          </span>
          <Dugme kucuk disabled={!!mesgul} onClick={() => calistir(x, true)}>{mesgul === `${x.kod}:kuru` ? 'Deneniyor…' : 'Kuru dene'}</Dugme>
          <Dugme kucuk ana disabled={!!mesgul || !v.gercek_acik || !kuru[x.kod]?.sonuc} title={!kuru[x.kod]?.sonuc ? 'Önce kuru dene (hatasız)' : undefined}
            onClick={() => calistir(x, false)}>{mesgul === x.kod ? 'Yazılıyor…' : x.son ? 'Yeniden yaz' : 'Çalıştır'}</Dugme>
        </div>
      ))}
    </div>
  );
}

// 🧪 PİLOT ŞUBE (sahip 27 Eki · Fable L4b A): bir şube 1 Kasım'dan önce yeni panelde GERÇEK kayda geçer; eski panel o şube için kapanır.
// Kaldırınca şube denemeye döner (yazılmış kayıtlar kalır). Sunucu: evvel_yeni_moduller /pilot.
function PilotSube({ onToast }) {
  const [v, setV] = useState(null);
  const [gun, setGun] = useState({});
  const [mesgul, setMesgul] = useState('');
  const yukle = useCallback(() => { api('/evvel-yeni/moduller/pilot').then(setV).catch(() => setV(null)); }, []);
  useEffect(() => { yukle(); }, [yukle]);
  if (!v) return null;
  const yaz = async (s, g) => {
    if (!(await soruOnay(g ? `${s.ad} ${g} iş gününden itibaren yeni panelde GERÇEK kayda geçsin mi? Eski panel bu şube için kapanır.`
      : `${s.ad} pilottan çıksın mı? Yeni panel bu şube için yeniden denemeye döner, eski panel açılır.`, g ? 'Evet, başlat' : 'Evet, kaldır'))) return;
    setMesgul(s.id);
    try { const r = await api('/evvel-yeni/moduller/pilot', { method: 'POST', body: { sube_id: s.id, gun: g || null } }); onToast?.(r.mesaj); yukle(); }
    catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul('');
  };
  return (
    <div style={{ ...kart, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <b>🧪 Pilot şube — {v.panel_baslangic} öncesi yeni panele geçiş</b>
      <div style={{ fontSize: 12.5, color: R.not }}>Pilottaki şube seçilen iş gününden itibaren yeni panelde gerçek kayıt tutar (açılış, kapanış, gider, teslim, sipariş, QR); eski panel o şube için kayıt almaz. İş günü gece 02:00'de değişir.</div>
      {v.subeler.map((s) => (
        <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, fontSize: 13 }}>
          <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b>{s.pilot && <Cip tur="sari">pilot · {s.pilot}'den beri</Cip>}</span>
          {s.pilot ? <Dugme kucuk disabled={!!mesgul} onClick={() => yaz(s, null)}>Pilottan çıkar</Dugme> : (<>
            <input type="date" value={gun[s.id] || ''} min={new Date().toISOString().slice(0, 10)} max={v.panel_baslangic} onChange={(e) => setGun((o) => ({ ...o, [s.id]: e.target.value }))}
              style={{ font: 'inherit', padding: '5px 8px', borderRadius: 8, border: `1px solid ${R.cizgi}`, background: 'var(--pi-bg)', color: 'var(--pi-ink)' }} />
            <Dugme kucuk ana disabled={!!mesgul || !gun[s.id]} onClick={() => yaz(s, gun[s.id])}>Pilot başlat</Dugme></>)}
        </div>
      ))}
    </div>
  );
}

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
          <div style={{ overflowX: 'auto' }}>{/* F6.3 sim: dar ekranda (539 px) tablo sayfayı 57 px yana taşırıyordu */}
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
          </div>
          {g.kayitsiz.length > 0 && <div style={{ color: R.kirmizi, fontSize: 12.5 }}>Kaydedilemeyen iş: {g.kayitsiz.map((x) => `${x.ad} (${x.hata})`).join(' · ')}</div>}
        </div>
      )}
      <SonAktarim onToast={onToast} />
      <PilotSube onToast={onToast} />
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
