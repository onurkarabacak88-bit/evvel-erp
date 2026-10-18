// 📱 TELEFONLAR — yoklama modülünün merkez sayfası (sunucu: evvel_yeni_yoklama_api.py). Personel altında (F10: yeni menü yok).
// Kişi → telefon var / bağlı (⚠️ zayıf bağ) / link bekliyor · "Link üret" (tek kullanımlık, BİR KEZ gösterilir, WhatsApp'tan gönderilir, K1/K9)
// Şube → tablet yok / onay bekliyor [Onayla] / aktif · koordinat var/yok · Çıkışı yapılmamışlar (son 14 gün) → saat + açıklama ile düzelt.
// Uyarılar ayrı sekme kuralı: burada bant yok; eksikler Bekleyen işler › Personel'de.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { bugunTR, tarihKaydir } from '../../utils/trTarih';
import { PI_CSS, R, kart, num, Dugme, Cip } from './KasaModulu';

export const YOKLAMA_SAYFALAR = [{ id: 'personel_telefon', ad: 'Telefonlar', alt: 'Telefon bağla · tablet onayı · çıkış düzelt' }];
const alan = { padding: '6px 9px', borderRadius: 9, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 13.5 };
const satir = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '8px 0', fontSize: 13.5 };

function cihazDurum(c) {
  if (!c.length) return <Cip tur="kirmizi">yok</Cip>;
  const aktif = c.find((x) => x.durum === 'aktif');
  if (aktif) return <><Cip tur="yesil">bağlı</Cip>{aktif.guc === 'jeton' && <Cip tur="sari">⚠️ zayıf bağ</Cip>}</>;
  if (c.some((x) => x.durum === 'onay')) return <Cip tur="sari">onay bekliyor</Cip>;
  return <Cip tur="sari">link bekliyor{c[0].davet_son ? ` · son ${c[0].davet_son.slice(5, 16).replace('-', '.').replace(' ', ' ')}` : ''}</Cip>;
}

export default function YoklamaModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [acik, setAcik] = useState(null);        // çıkışsız kayıtlar (son 14 gün)
  const [hata, setHata] = useState('');
  const [link, setLink] = useState(null);         // { ad, url, mesaj } — BİR KEZ gösterilir
  const [mesgul, setMesgul] = useState({});
  const [duz, setDuz] = useState({});             // yoklama_id → { saat, aciklama }
  const bugun = bugunTR();
  const yukle = useCallback(() => {
    api('/evvel-yeni/yoklama/cihazlar').then((d) => { setV(d); setHata(''); }).catch((e) => setHata(e?.message || 'Cihazlar okunamadı'));
    api(`/evvel-yeni/yoklama/gunler?bas=${tarihKaydir(-14)}&son=${bugun}`)
      .then((d) => setAcik((d?.satirlar || []).filter((s) => !s.cikis && s.gun < bugun)))
      .catch(() => setAcik([]));
  }, [bugun]);
  useEffect(() => { yukle(); }, [yukle]);

  const yap = async (anahtar, yol, govde, sonra) => {
    setMesgul((m) => ({ ...m, [anahtar]: true })); setHata('');
    try { const d = await api(yol, { method: 'POST', body: govde }); sonra?.(d); if (!sonra) onToast?.(d.mesaj); await yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); }
    setMesgul((m) => { const y = { ...m }; delete y[anahtar]; return y; });
  };
  const linkUret = (anahtar, govde) => yap(anahtar, '/evvel-yeni/yoklama/cihaz/davet', govde,
    (d) => setLink({ ad: d.ad, url: `${window.location.origin}${d.yol}`, mesaj: d.mesaj }));
  const kopyala = async (t) => { try { await navigator.clipboard.writeText(t); onToast?.('Kopyalandı'); } catch { onToast?.('Kopyalanamadı — linki elle seç'); } };
  const iptal = (c, ad) => { if (window.confirm(`${ad} cihazı iptal edilsin mi? Bu telefon/tablet bir daha çalışmaz.`)) yap(c.id, `/evvel-yeni/yoklama/cihaz/${c.id}/iptal`, {}); };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Telefonlar</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Her personelin telefonu bir kez bağlanır: "Link üret" → linki WhatsApp'tan gönder → personel telefonunda açar. Sonra giriş / çıkış için şubedeki tabletin QR'ını okutur; PIN yok. Şube tableti de aynı yolla bağlanır, sen onaylarsın.</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata} <Dugme kucuk onClick={yukle}>Yeniden dene</Dugme></div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}

      {link && (
        <div style={{ ...kart, padding: '12px 14px', display: 'grid', gap: 8, borderColor: 'var(--pi-accent)' }}>
          <b>🔗 {link.ad} için bağlantı linki — yalnız şimdi görünür, kapatınca bir daha gösterilmez</b>
          <div style={{ ...num, fontSize: 13, wordBreak: 'break-all', padding: '8px 10px', background: 'var(--pi-bg)', borderRadius: 9 }}>{link.url}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Dugme ana onClick={() => kopyala(link.url)}>Kopyala</Dugme>
            <a href={`https://wa.me/?text=${encodeURIComponent(`${link.ad}, Evvel yoklama için telefonunu bağla (48 saat, tek kullanım): ${link.url}`)}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
              <Dugme>WhatsApp ile gönder</Dugme>
            </a>
            <Dugme kucuk onClick={() => setLink(null)}>Kapat</Dugme>
          </div>
          <div style={{ fontSize: 12, color: R.not }}>{link.mesaj}</div>
        </div>
      )}

      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Personel · telefon</div>
          {v.personel.length === 0 && <div style={{ color: R.not, padding: 6 }}>Aktif personel yok.</div>}
          {v.personel.map((p) => (
            <div key={p.id} style={satir}>
              <span style={{ width: 110, color: R.not }}>{p.sube_ad || '—'}</span>
              <span style={{ flex: '1 1 160px' }}><b>{p.ad}</b>{p.mudur && <> <Cip tur="bakir">müdür</Cip></>}{p.konum_muaf && <> <Cip>konum muaf</Cip></>}</span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{cihazDurum(p.cihazlar)}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Dugme kucuk ana={!p.cihazlar.some((c) => c.durum === 'aktif')} disabled={mesgul['p:' + p.id]} onClick={() => linkUret('p:' + p.id, { personel_id: p.id })}>Link üret</Dugme>
                {p.cihazlar.map((c) => (
                  <Dugme key={c.id} kucuk disabled={mesgul[c.id]} title={c.son_kullanim ? `son kullanım ${c.son_kullanim}` : ''} onClick={() => iptal(c, p.ad)}>
                    İptal{c.etiket ? ` (${c.etiket})` : ''}
                  </Dugme>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Şube · tablet (QR'ı yalnız kayıtlı tablet gösterir)</div>
          {v.subeler.map((s) => (
            <div key={s.id} style={satir}>
              <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b> <span style={{ fontSize: 12, color: s.konum ? R.not : R.kirmizi }}>{s.konum ? '📍 koordinat var' : '📍 koordinat yok (Tanımlar › Şube)'}</span></span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{cihazDurum(s.tabletler)}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {s.tabletler.filter((c) => c.durum === 'onay').map((c) => (
                  <Dugme key={c.id} kucuk ana disabled={mesgul[c.id]} onClick={() => yap(c.id, `/evvel-yeni/yoklama/cihaz/${c.id}/onayla`, {})}>Onayla{c.etiket ? ` (${c.etiket})` : ''}</Dugme>
                ))}
                <Dugme kucuk ana={!s.tabletler.length} disabled={mesgul['s:' + s.id]} onClick={() => linkUret('s:' + s.id, { sube_id: s.id })}>Link üret</Dugme>
                {s.tabletler.map((c) => <Dugme key={c.id} kucuk disabled={mesgul[c.id]} onClick={() => iptal(c, s.ad + ' tableti')}>İptal</Dugme>)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
        <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>🚪 Çıkışı yapılmamışlar (son 14 gün, bugün hariç) — saat + açıklama yaz</div>
        {acik === null && <div style={{ color: R.not, padding: 6 }}>Okunuyor…</div>}
        {acik && acik.length === 0 && <div style={{ color: R.not, padding: 6 }}>Çıkışsız kayıt yok.</div>}
        {(acik || []).map((s) => {
          const d = duz[s.id] || {};
          const set = (k, x) => setDuz((o) => ({ ...o, [s.id]: { ...d, [k]: x } }));
          return (
            <div key={s.id} style={satir}>
              <span style={{ width: 90, color: R.not }}>{s.gun.slice(8, 10)}.{s.gun.slice(5, 7)}</span>
              <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b> · {s.sube || '—'} · giriş {s.giris || '—'}</span>
              <input type="time" value={d.saat || ''} onChange={(e) => set('saat', e.target.value)} style={alan} />
              <input value={d.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder="açıklama (zorunlu)" style={{ ...alan, width: 200 }} />
              <Dugme kucuk ana disabled={!d.saat || (d.aciklama || '').trim().length < 2 || mesgul[s.id]}
                onClick={() => yap(s.id, '/evvel-yeni/yoklama/duzelt', { yoklama_id: s.id, cikis_saat: d.saat, aciklama: d.aciklama.trim() })}>Çıkışı yaz</Dugme>
            </div>
          );
        })}
      </div>
    </div>
  );
}
