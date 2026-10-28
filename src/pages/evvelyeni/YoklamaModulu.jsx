// 📱 TELEFONLAR — yoklama modülünün merkez sayfası (sunucu: evvel_yeni_yoklama_api.py). Personel altında (F10: yeni menü yok).
// Kişi → telefon var / bağlı (⚠️ zayıf bağ) / link bekliyor · "Link üret" (tek kullanımlık, BİR KEZ gösterilir, WhatsApp'tan gönderilir, K1/K9)
// Şube → tablet yok / onay bekliyor [Onayla] / aktif · koordinat var/yok · Çıkışı yapılmamışlar (son 14 gün) → saat + açıklama ile düzelt.
// İkinci sayfa (export YemekMolalari): Personel › Yemek molaları — ay tablosu · hak ✓/✗/elle · Bitiş yaz · Gördüm · Bekleyenler.
// Üçüncü sayfa (export Devirler, dosya sonu): Personel › Devirler — kasa devri çift onay (B6/D5) ay tablosu · Bekleyenler: İptal / Devir sayıldı / Gördüm.
// Uyarılar ayrı sekme kuralı: burada bant yok; eksikler Bekleyen işler › Personel'de.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { ayTR, bugunTR, ggaaSaat } from '../../utils/trTarih';
import { ALAN, AySecici, Cip, Dugme, dugmeSade, kart, num, PI_CSS, R, sayfayaGit, soruOnay, tKisa } from './KasaModulu';
import { tlYaz } from '../../utils/trSayi';
import { bardakOzet } from '../../utils/devirOzet';

export const YOKLAMA_SAYFALAR = [
  { id: 'personel_telefon', ad: 'Telefonlar', alt: 'Telefon bağla · şube PC onayı · çıkış düzelt' },
  { id: 'personel_mola', ad: 'Yemek molaları', alt: 'Gün gün mola · süre · yemek hakkı ✓/✗ · elle hak' },
  { id: 'personel_devir', ad: 'Devirler', alt: 'Kasa devri · iki kör sayım · tutmayan merkeze bilgi · tamamlanmayanı kapat' },
];
const alan = { ...ALAN, padding: '6px 9px', borderRadius: 9, fontSize: 13.5 };   // temel stil KasaModulu ALAN (T4-15)
const satir = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '8px 0', fontSize: 13.5 };

// B-1 (F1.1 · sim 26 Eki): süresi geçmiş davet "kullanılmamış link · …'e kadar" görünüyordu (telefon "süresi doldu" diyordu)
const davetDoldu = (x) => x?.davet_doldu === true;   // sunucu hesaplar (saat dilimi güvenli)
function cihazDurum(c) {
  if (!c.length) return <Cip tur="kirmizi">yok</Cip>;
  const aktif = c.find((x) => x.durum === 'aktif');
  if (aktif) return <><Cip tur="yesil">bağlı</Cip>{aktif.guc === 'jeton' && <Cip tur="sari">⚠️ zayıf bağ</Cip>}</>;
  if (c.some((x) => x.durum === 'onay')) return <Cip tur="sari">onay bekliyor</Cip>;
  if (davetDoldu(c[0])) return <Cip tur="kirmizi">link süresi doldu — yeni link üret</Cip>;
  return <Cip tur="sari">link bekliyor{c[0].davet_son ? ` · son ${ggaaSaat(c[0].davet_son)}` : ''}</Cip>;
}

export default function YoklamaModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [acik, setAcik] = useState(null);        // çıkışsız kayıtlar (son 14 gün)
  const [konumsuz, setKonumsuz] = useState([]);   // IS 5q: konumsuz çıkışlar (son 14 gün) — bilgi
  const [hata, setHata] = useState('');
  const [link, setLink] = useState(null);         // { ad, url, mesaj } — BİR KEZ gösterilir
  const [mesgul, setMesgul] = useState({});
  const [duz, setDuz] = useState({});             // yoklama_id → { saat, aciklama }
  const bugun = bugunTR();
  const yukle = useCallback(() => {
    api('/evvel-yeni/yoklama/cihazlar').then((d) => { setV(d); setHata(''); }).catch((e) => setHata(e?.message || 'Cihazlar okunamadı'));
    api('/evvel-yeni/yoklama/gunler?acik=1')   // Codex: sınırsız + sunucunun iş günü ölçütü (Bekleyen işler ile aynı)
      .then((d) => setAcik(d?.satirlar || []))
      .catch(() => setAcik([]));
    api('/evvel-yeni/yoklama/gunler?konumsuz=1').then((d) => setKonumsuz(d?.satirlar || [])).catch(() => setKonumsuz([]));
  }, [bugun]);
  useEffect(() => {   // sahip: cihaz bağlanınca merkez sayfası yenilemeden görsün — 10 sn'de bir (sekme açıkken), öne gelince hemen
    yukle();
    const t = window.setInterval(() => { if (!document.hidden) yukle(); }, 10000);
    const gor = () => { if (!document.hidden) yukle(); };
    document.addEventListener('visibilitychange', gor);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', gor); };
  }, [yukle]);

  const yap = async (anahtar, yol, govde, sonra) => {
    setMesgul((m) => ({ ...m, [anahtar]: true })); setHata('');
    try { const d = await api(yol, { method: 'POST', body: govde }); sonra?.(d); if (!sonra) onToast?.(d.mesaj); await yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); }
    setMesgul((m) => { const y = { ...m }; delete y[anahtar]; return y; });
  };
  const linkUret = (anahtar, govde) => yap(anahtar, '/evvel-yeni/yoklama/cihaz/davet', govde,
    (d) => setLink({ ad: d.ad, url: `${window.location.origin}${d.yol}`, mesaj: d.mesaj }));
  const kopyala = async (t) => { try { await navigator.clipboard.writeText(t); onToast?.('Kopyalandı'); } catch { onToast?.('Kopyalanamadı — linki elle seç'); } };
  // her satır ne: bağlı cihaz (son kullanım) / onay bekleyen / kullanılmamış link (son geçerlilik) — iki "İptal" karışmasın
  const cihazNe = (c) => (c.durum === 'aktif' ? `bağlı${c.son_kullanim ? ' · son ' + ggaaSaat(c.son_kullanim) : ' · hiç kullanılmadı'}`
    : c.durum === 'onay' ? 'onay bekleyen' : davetDoldu(c) ? `süresi dolmuş link · ${ggaaSaat(c.davet_son)}`
      : `kullanılmamış link${c.davet_son ? ' · son geçerlilik ' + ggaaSaat(c.davet_son) : ''}`);
  const iptal = async (c, ad) => { if (await soruOnay(`${ad} cihazı iptal edilsin mi? Bu telefon / şube bilgisayarı bir daha çalışmaz.`)) yap(c.id, `/evvel-yeni/yoklama/cihaz/${c.id}/iptal`, {}); };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Telefonlar</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Her personelin telefonu bir kez bağlanır: "Link üret" → linki WhatsApp'tan gönder → personel telefonunda açar. Sonra giriş / çıkış için şubedeki panel bilgisayarının ekranındaki QR'ı okutur; PIN yok. Şube bilgisayarı da aynı yolla bağlanır, sen onaylarsın.</div>
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
              <span style={{ flex: '1 1 160px', opacity: p.ayrildi ? 0.6 : 1 }}><b>{p.ad}</b>{p.mudur && <> <Cip tur="bakir">müdür</Cip></>}{p.konum_muaf && <> <Cip>konum muaf</Cip></>}</span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{p.ayrildi ? <Cip>ayrıldı {tKisa(p.ayrildi)}</Cip> : cihazDurum(p.cihazlar)}</span>{/* R4-7 (sim 25 Eki · Opus) */}
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Dugme kucuk ana={!p.ayrildi && !p.cihazlar.some((c) => c.durum === 'aktif')} disabled={!!p.ayrildi || mesgul['p:' + p.id]} title={p.ayrildi ? 'Ayrılan personele bağlantı üretilmez' : ''} onClick={() => linkUret('p:' + p.id, { personel_id: p.id })}>Link üret</Dugme>
                {/* B7: yönetici konum muafiyeti (K2) */}
                <Dugme kucuk disabled={mesgul['m:' + p.id]} onClick={() => yap('m:' + p.id, `/evvel-yeni/yoklama/personel/${p.id}/konum-muaf`, { konum_muaf: !p.konum_muaf })}>
                  {p.konum_muaf ? 'Konum kontrol edilsin' : 'Konumdan muaf tut'}
                </Dugme>
                {p.cihazlar.map((c) => (
                  <Dugme key={c.id} kucuk disabled={mesgul[c.id]} title={c.son_kullanim ? `son kullanım ${c.son_kullanim}` : ''} onClick={() => iptal(c, p.ad)}>
                    İptal · {cihazNe(c)}{c.etiket ? ` (${c.etiket})` : ''}
                  </Dugme>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Şube · panel bilgisayarı (QR'ı yalnız kayıtlı panel gösterir — linki şubedeki PC'de aç)</div>
          {v.subeler.map((s) => (
            <div key={s.id} style={satir}>
              <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b> <a href={`/panel/${encodeURIComponent(s.id)}`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--pi-accent)' }}>paneli aç ↗</a> {s.konum ? <span style={{ fontSize: 12, color: R.not }}>📍 koordinat var</span>
                : <button type="button" onClick={() => sayfayaGit('tanim_sube')} style={{ ...dugmeSade, fontSize: 12, color: R.kirmizi, textDecoration: 'underline' }}>📍 koordinat yok — Tanımlar › Şubeler ›</button>}</span>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{cihazDurum(s.tabletler)}</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {s.tabletler.filter((c) => c.durum === 'onay').map((c) => (
                  <Dugme key={c.id} kucuk ana disabled={mesgul[c.id]} onClick={() => yap(c.id, `/evvel-yeni/yoklama/cihaz/${c.id}/onayla`, {})}>Onayla{c.etiket ? ` (${c.etiket})` : ''}</Dugme>
                ))}
                <Dugme kucuk ana={!s.tabletler.length} disabled={mesgul['s:' + s.id]} onClick={() => linkUret('s:' + s.id, { sube_id: s.id })}>Link üret</Dugme>
                {s.tabletler.map((c) => <Dugme key={c.id} kucuk disabled={mesgul[c.id]} onClick={() => iptal(c, s.ad + ' bilgisayarı')}>İptal · {cihazNe(c)}</Dugme>)}
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
              <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b> · {s.sube || '—'} · giriş {s.giris || '—'}{s.cikis_tur === 'gece_otomatik' && <span style={{ color: R.amber }}> · sistem gece kapattı (0 sa)</span>}</span>
              <input type="time" value={d.saat || ''} onChange={(e) => set('saat', e.target.value)} style={alan} />
              <input value={d.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder="açıklama (zorunlu)" style={{ ...alan, width: 200 }} />
              <Dugme kucuk ana disabled={!d.saat || (d.aciklama || '').trim().length < 2 || mesgul[s.id]}
                onClick={() => yap(s.id, '/evvel-yeni/yoklama/duzelt', { yoklama_id: s.id, cikis_saat: d.saat, aciklama: d.aciklama.trim() })}>Çıkışı yaz</Dugme>
            </div>
          );
        })}
      </div>
      {konumsuz.length > 0 && (   /* IS 5q · sahip 28 Eki: konum alınamadığında çıkış serbest — işaretli, merkez görür (karar gerektirmez) */
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>📍 Konumsuz çıkışlar (son 14 gün) — telefon konum veremedi, çıkış yine kaydedildi</div>
          {konumsuz.map((s) => (
            <div key={s.id} style={satir}>
              <span style={{ width: 90, color: R.not }}>{s.gun.slice(8, 10)}.{s.gun.slice(5, 7)}</span>
              <span style={{ flex: '1 1 160px' }}><b>{s.ad}</b> · {s.sube || '—'} · giriş {s.giris || '—'} · çıkış {s.cikis || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── 🍽 YEMEK MOLALARI — Personel › Yemek molaları (B11, K7/K8) ───────────────────────────
// Ay seçimi → /molalar?bas&son tablosu · işlemler: bitmedi → "Bitiş yaz" (saat + açıklama) · hak ✗ → "Hakkı elle ver" (izli) / "Gördüm".
// Alt: ay özeti (kişi → mola günü · ortalama süre · hak düşen · elle verilen) · "Bekleyenler" bölümü /molalar?acik=1 (bant değil).
const ayGunSon = (ay) => { const [y, m] = ay.split('-').map(Number); return `${ay}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };
const gunKisa = (g) => (g ? `${g.slice(8, 10)}.${g.slice(5, 7)}` : '—');
const DURUM_AD = { suruyor: 'sürüyor', bitmedi: 'bitmedi', bitti: 'bitti', 'merkez yazdı': 'merkez yazdı', 'çıkışla kapandı': 'çıkışla kapandı', 'gece sistem kapattı': 'gece sistem kapattı', 'süre doldu — sistem kapattı': 'süre doldu — sistem kapattı' };

function hakHucre(s) {
  if (s.yemek_hakki === null || s.yemek_hakki === undefined) return <span style={{ color: R.not }}>—</span>;
  if (s.hak_elle) return <Cip tur="yesil">✓ elle: {s.hak_veren || '?'}{s.hak_zaman ? ` · ${ggaaSaat(s.hak_zaman)}` : ''}</Cip>;
  if (s.mudur) return <Cip tur="yesil">✓ müdür (şartsız)</Cip>;   // B56: maaş da tam veriyor — iki ekran aynı söylesin
  return s.yemek_hakki ? <Cip tur="yesil">✓</Cip> : <Cip tur="kirmizi">✗</Cip>;
}

function MolaSatir({ s, duz, setDuz, mesgul, yap, bugun }) {
  const d = duz[s.id] || {};
  const set = (k, x) => setDuz((o) => ({ ...o, [s.id]: { ...d, [k]: x } }));
  const bitmedi = s.durum === 'bitmedi' || (s.durum === 'suruyor' && s.gun < bugun);
  const hakYok = s.yemek_hakki === false && !s.hak_elle;
  return (
    <tr>
      <td style={{ color: R.not }}>{gunKisa(s.gun)}</td>
      <td><b>{s.ad}</b></td>
      <td style={{ color: R.not }}>{s.sube || '—'}</td>
      <td style={num}>{s.bas || '—'}</td>
      <td style={num}>{s.bit || '—'}</td>
      <td style={num}>{s.sure_dk ?? '—'}{s.sure_dk != null ? ' dk' : ''}</td>
      <td><Cip tur={s.durum === 'bitmedi' ? 'kirmizi' : s.durum === 'suruyor' ? 'sari' : undefined}>{DURUM_AD[s.durum] || s.durum}</Cip>
        {s.hak_aciklama && <span title={s.hak_aciklama} style={{ color: R.not, marginLeft: 4 }}>ⓘ</span>}</td>
      <td>{hakHucre(s)}</td>
      <td style={{ color: R.not, ...num }}>{s.mesafe != null ? `${s.mesafe} m` : '—'}</td>
      <td>
        {bitmedi && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="time" value={d.saat || ''} onChange={(e) => set('saat', e.target.value)} style={alan} />
            <input value={d.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder="açıklama (zorunlu)" style={{ ...alan, width: 160 }} />
            <Dugme kucuk ana disabled={!d.saat || (d.aciklama || '').trim().length < 2 || mesgul[s.id]}
              onClick={() => yap(s.id, `/evvel-yeni/yoklama/mola/${s.id}/duzelt`, { bitis_saat: d.saat, aciklama: d.aciklama.trim() })}>Bitiş yaz</Dugme>
          </span>
        )}
        {!bitmedi && hakYok && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={d.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder="neden (zorunlu, izli)" style={{ ...alan, width: 150 }} />
            <Dugme kucuk ana disabled={mesgul[s.id] || (d.aciklama || '').trim().length < 2}
              onClick={() => yap(s.id, `/evvel-yeni/yoklama/mola/${s.id}/hak-ver`, { aciklama: (d.aciklama || '').trim() })}>Hakkı elle ver</Dugme>
            {!s.gorulen && <Dugme kucuk disabled={mesgul[s.id]} onClick={() => yap(s.id, `/evvel-yeni/yoklama/mola/${s.id}/gordum`, {})}>Gördüm</Dugme>}
            {s.gorulen && <span style={{ fontSize: 12, color: R.not }}>görüldü: {s.gorulen === 'otomatik_limit' ? 'sistem (süre doldu)' : s.gorulen}</span>}
          </span>
        )}
      </td>
    </tr>
  );
}

const TH = ['Tarih', 'Kişi', 'Şube', 'Başlangıç', 'Bitiş', 'Süre', 'Durum', 'Yemek hakkı', 'Mesafe', ''];

function MolaTablo({ satirlar, bos, ...p }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 13.5, borderCollapse: 'collapse' }}>
        <thead><tr>{TH.map((h, i) => <th key={i} style={{ textAlign: 'left', fontSize: 12, color: R.not, fontWeight: 700, padding: '6px 8px', borderBottom: `1px solid ${R.cizgi}` }}>{h}</th>)}</tr></thead>
        <tbody>
          {satirlar.map((s) => <MolaSatir key={s.id} s={s} {...p} />)}
          {!satirlar.length && <tr><td colSpan={TH.length} style={{ color: R.not, padding: 8 }}>{bos}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function YemekMolalari({ onToast }) {
  const [ay, setAy] = useState(ayTR());
  const [v, setV] = useState(null);               // { limit_dk, satirlar } — ay
  const [acik, setAcik] = useState(null);         // bekleyenler (bitmemiş + görülmemiş uzun)
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState({});
  const [duz, setDuz] = useState({});             // mola id → { saat, aciklama }
  const bugun = bugunTR();
  const yukle = useCallback(() => {
    api(`/evvel-yeni/yoklama/molalar?bas=${ay}-01&son=${ayGunSon(ay)}`).then((d) => { setV(d); setHata(''); })
      .catch((e) => setHata(e?.message || 'Molalar okunamadı'));
    api('/evvel-yeni/yoklama/molalar?acik=1').then((d) => setAcik(d?.satirlar || [])).catch(() => setAcik([]));
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);
  const yap = async (anahtar, yol, govde) => {
    setMesgul((m) => ({ ...m, [anahtar]: true })); setHata('');
    try { const d = await api(yol, { method: 'POST', body: govde }); onToast?.(d.mesaj); setDuz((o) => { const y = { ...o }; delete y[anahtar]; return y; }); await yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); }
    setMesgul((m) => { const y = { ...m }; delete y[anahtar]; return y; });
  };

  // Ay özeti: kişi → mola günü · ortalama süre · hak düşen gün · elle verilen (Maaş yemek kalemiyle aynı ölçüt: bitmiş mola)
  const ozet = Object.values((v?.satirlar || []).reduce((a, s) => {
    const kim = s.personel_id || s.ad;   // Codex: aynı adlı iki kişi birleşmesin
    const k = a[kim] || (a[kim] = { ad: s.ad, gun: 0, toplam: 0, olculen: 0, dusen: 0, elle: 0 });
    k.gun += 1;
    if (s.sure_dk != null) { k.toplam += s.sure_dk; k.olculen += 1; }
    if (s.hak_elle) k.elle += 1;
    else if (s.yemek_hakki === false) k.dusen += 1;
    return a;
  }, {})).sort((x, y) => x.ad.localeCompare(y.ad, 'tr'));
  const ortak = { duz, setDuz, mesgul, yap, bugun };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Yemek molaları</h1></div>
        <AySecici ay={ay} setAy={setAy} style={{ ...alan, marginLeft: 'auto' }} />
      </div>
      <div style={{ fontSize: 13, color: R.metin2 }}>
        Kişi başı iş gününde bir mola; telefondan QR ile başlar ve biter. Mola ≤ {v?.limit_dk ?? 60} dk → o günün yemek hakkı kazanılır; daha uzunsa ya da o gün mola kullanılmadıysa hak yok (K7/K8).
        Gerekirse hakkı burada elle verirsin — kim, ne zaman, neden yazılır. Bitmeyen molaya bitiş saati yazınca süre ve hak yeniden hesaplanır.
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata} <Dugme kucuk onClick={yukle}>Yeniden dene</Dugme></div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}

      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Gün gün molalar · {ay.slice(5, 7)}.{ay.slice(0, 4)} · en yeni üstte</div>
          <MolaTablo satirlar={(v.satirlar || []).slice().reverse()} bos="Bu ay mola kaydı yok." {...ortak} />
        </div>
      )}

      {v && ozet.length > 0 && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Ay özeti · kişi</div>
          <div style={{ ...satir, borderTop: 'none', fontSize: 12, color: R.not }}>
            <span style={{ flex: '1 1 160px' }}>Kişi</span><span style={{ width: 90 }}>Mola günü</span><span style={{ width: 110 }}>Ortalama süre</span><span style={{ width: 110 }}>Hak düşen gün</span><span style={{ width: 100 }}>Elle verilen</span>
          </div>
          {ozet.map((k) => (
            <div key={k.ad} style={satir}>
              <span style={{ flex: '1 1 160px' }}><b>{k.ad}</b></span>
              <span style={{ width: 90, ...num }}>{k.gun}</span>
              <span style={{ width: 110, ...num }}>{k.olculen ? `${Math.round(k.toplam / k.olculen)} dk` : '—'}</span>
              <span style={{ width: 110, ...num, color: k.dusen ? R.kirmizi : undefined }}>{k.dusen}</span>
              <span style={{ width: 100, ...num }}>{k.elle}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>⏳ Bekleyenler — bitmeyen molalar + görülmemiş uzun molalar (Bekleyen işler › Personel ile aynı liste)</div>
        {acik === null && <div style={{ color: R.not, padding: 6 }}>Okunuyor…</div>}
        {acik && <MolaTablo satirlar={acik} bos="Bekleyen mola yok." {...ortak} />}
      </div>
    </div>
  );
}

// ─────────────────────────── 💵 DEVİRLER — Personel › Devirler (B6, D5/K5, §B8 durum makinesi) ───────────────────────────
// Ay seçimi → /devirler?bas&son tablosu (tarih · şube · devreden → devralan · sayılan · bardak · saatler · durum çipi · not).
// "Bekleyenler" /devirler?acik=1: tamamlanmamış (hazir / devreden_onayladi, gün geçti ya da 2 saat) → "İptal" / "Devir sayıldı" (açıklama zorunlu,
// merkez-kapat); görülmemiş "tutmuyor" → "Gördüm". "Merkez kapattı" satırı AYRI çip — asla kişi onayı gibi görünmez (D5).
const tlYazi = (x) => tlYaz(x);   // ₺ biçimi TEK kaynak (F#58)

function devirCip(s) {
  if (s.durum === 'baslatildi') return <Cip tur="sari">⏳ başladı · kimse okutmadı</Cip>;
  if (s.durum === 'sayiliyor') return <Cip tur="sari">⏳ sayım sürüyor</Cip>;
  if (s.durum === 'yeniden') return <Cip tur="sari">⏳ 2. sayım bekleniyor</Cip>;
  if (s.durum === 'tutmadi') return <Cip tur="kirmizi">⚠ tutmadı (2 kör sayım)</Cip>;
  if (s.durum === 'hazir') return <Cip tur="sari">⏳ devreden bekleniyor</Cip>;
  if (s.durum === 'devreden_onayladi') return <Cip tur="sari">⏳ devralan bekleniyor</Cip>;
  if (s.durum === 'tamam') return <Cip tur="yesil">✓ tuttu{(s.tur || 1) > 1 ? ' (2. sayımda)' : ''}</Cip>;
  if (s.durum === 'tutmuyor') return <Cip tur="kirmizi">⚠ tutmuyor</Cip>;
  if (s.durum === 'merkez_kapatti') return <Cip tur="bakir">🏢 merkez kapattı · {s.merkez_sonuc === 'kapandi' ? 'devir sayıldı' : 'iptal'}</Cip>;
  if (s.durum === 'iptal') return <Cip>iptal (panel)</Cip>;
  return <Cip>{s.durum}</Cip>;
}

function DevirSatir({ s, duz, setDuz, mesgul, yap }) {
  const d = duz[s.id] || {};
  const set = (k, x) => setDuz((o) => ({ ...o, [s.id]: { ...d, [k]: x } }));
  const acikDevir = ['baslatildi', 'hazir', 'devreden_onayladi', 'sayiliyor', 'yeniden'].includes(s.durum);
  const kapat = (sonuc) => yap(s.id, `/evvel-yeni/yoklama/devir/${s.id}/merkez-kapat`, { sonuc, aciklama: (d.aciklama || '').trim() });
  return (
    <tr>
      <td style={{ color: R.not }}>{gunKisa(s.gun)}</td>
      <td style={{ color: R.not }}>{s.sube || '—'}</td>
      <td>{!s.devreden && !s.devralan ? <span style={{ color: R.not }}>henüz kimse okutmadı</span> : <><b>{s.devreden || '—'}</b> → <b>{s.devralan || '—'}</b></>}{s.vekil && s.ustlenen ? <div style={{ fontSize: 12, color: R.not }}>{s.ustlenen_id === s.devreden_id ? 'kasa sahibi içeride değildi' : `${s.ustlenen}, ${s.devreden} adına saydı`}</div> : null}</td>
      <td>{devirCip(s)}</td>
      <td>
        {acikDevir && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={d.aciklama || ''} onChange={(e) => set('aciklama', e.target.value)} placeholder="açıklama (zorunlu)" style={{ ...alan, width: 170 }} />
            <Dugme kucuk disabled={(d.aciklama || '').trim().length < 2 || mesgul[s.id]} onClick={() => kapat('iptal')}>İptal</Dugme>
            <Dugme kucuk ana disabled={(d.aciklama || '').trim().length < 2 || mesgul[s.id]} title="Devir sayılır: vardiya olayı 'merkez istisna' + devredenin çıkışı; kişi onayı yerine GEÇMEZ"
              onClick={() => kapat('kapandi')}>Devir sayıldı</Dugme>
          </span>
        )}
        {(['tutmadi', 'tutmuyor'].includes(s.durum) || (s.durum === 'tamam' && s.vekil)) && !s.gorulen && <Dugme kucuk ana disabled={mesgul[s.id]} onClick={() => yap(s.id, `/evvel-yeni/yoklama/devir/${s.id}/gorundu`, {})}>Gördüm</Dugme>}
        {(['tutmadi', 'tutmuyor'].includes(s.durum) || (s.durum === 'tamam' && s.vekil)) && s.gorulen && <span style={{ fontSize: 12, color: R.not, whiteSpace: 'nowrap' }} title={`görüldü: ${s.gorulen}`}>görüldü ✓</span>}
      </td>
      {/* R5-2/3 yeniden (sim 26 Eki, 1280 ölçüm): hücre 4 satırdı (satır 145 px, tablo 1.254 / 944 px taşıyordu) → tek satır tutar + tutmayan; 1. sayım üzerine gelince */}
      <td style={{ ...num, whiteSpace: 'nowrap' }} title={s.tur1 ? `1. sayım tutmadı → birlikte yeniden sayıldı
1. sayım: devreden ${tlYazi((s.tur1.devreden?.kasa ?? 0) / 100)} · devralan ${tlYazi((s.tur1.devralan?.kasa ?? 0) / 100)}${s.tur1.fark_kalem?.length ? ` · tutmayan: ${s.tur1.fark_kalem.join(', ')}` : ''}` : undefined}>
        {s.sayilan == null ? '—' : tlYazi(s.sayilan)}{s.devralan_sayilan != null && <> → {tlYazi(s.devralan_sayilan)}{s.fark ? <b style={{ color: R.kirmizi }}> · fark {s.fark > 0 ? '+' : ''}{tlYazi(s.fark)}</b> : null}</>}
        {(s.fark_kalem?.length || s.tur1) ? <div style={{ fontSize: 12, color: s.fark_kalem?.length ? R.kirmizi : R.amber, whiteSpace: 'normal', maxWidth: 260 }}>{s.fark_kalem?.length ? `tutmayan: ${s.fark_kalem.join(', ')}` : ''}{s.tur1 ? `${s.fark_kalem?.length ? ' · ' : ''}2 sayım ⓘ` : ''}</div> : null}
      </td>
      <td style={{ color: R.metin2, minWidth: 150, maxWidth: 220, fontSize: 12.5 }}
        title={[s.bardak?.length ? bardakOzet(s.bardak) : '', s.urunler?.length ? s.urunler.map((u) => `${u.ad} ${u.sayilan}`).join(' · ') : '', s.pasta != null ? `pasta ${s.pasta}` : ''].filter(Boolean).join('\n')}>{/* Codex: tek satıra kesilen bardak listesi de ipucunda */}
        <div style={{ maxWidth: 170, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.bardak?.length ? bardakOzet(s.bardak) : '—'}</div>
        {(s.urunler?.length || s.pasta != null) ? <div style={{ fontSize: 11.5, color: R.not }}>+ ürün/pasta (üzerine gel)</div> : null}</td>{/* R5-2/3 (sim 25 Eki): uzun ürün listesi satırı uzatıp tabloyu taşırıyordu */}
      <td style={{ ...num, color: R.not, whiteSpace: 'nowrap' }} title="form · devretti · kabul">{s.panel || '—'} · {s.devreden_saat || '—'} · {s.devralan_saat || '—'}</td>
      <td style={{ color: s.durum === 'tutmuyor' ? R.kirmizi : R.metin2 }} title={s.not || undefined}><div style={{ maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.not || '—'}</div></td>
    </tr>
  );
}

const DEVIR_TH = ['Tarih', 'Şube', 'Devreden → Devralan', 'Durum', '', 'Sayılan (devreden · devralan)', 'Bardak', 'Saatler', 'Not'];   // R5-3 yeniden: uzun başlık sütunu şişiriyordu — açılımı hücrenin ipucunda (form · devretti · kabul)   // G69: durum + düğme öne (1366'da ekranda kalsın)

function DevirTablo({ satirlar, bos, ...p }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 13.5, borderCollapse: 'collapse' }}>
        <thead><tr>{DEVIR_TH.map((h, i) => <th key={i} style={{ textAlign: 'left', fontSize: 12, color: R.not, fontWeight: 700, padding: '6px 8px', borderBottom: `1px solid ${R.cizgi}` }}>{h}</th>)}</tr></thead>
        <tbody>
          {satirlar.map((s) => <DevirSatir key={s.id} s={s} {...p} />)}
          {!satirlar.length && <tr><td colSpan={DEVIR_TH.length} style={{ color: R.not, padding: 8 }}>{bos}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Devirler({ onToast }) {
  const [ay, setAy] = useState(ayTR());
  const [v, setV] = useState(null);               // { satirlar } — ay
  const [acik, setAcik] = useState(null);         // bekleyenler (tamamlanmamış + görülmemiş tutmuyor)
  const [hata, setHata] = useState('');
  const [mesgul, setMesgul] = useState({});
  const [duz, setDuz] = useState({});             // devir id → { aciklama }
  const yukle = useCallback(() => {
    api(`/evvel-yeni/yoklama/devirler?bas=${ay}-01&son=${ayGunSon(ay)}`).then((d) => { setV(d); setHata(''); })
      .catch((e) => setHata(e?.message || 'Devirler okunamadı'));
    api('/evvel-yeni/yoklama/devirler?acik=1').then((d) => setAcik(d?.satirlar || [])).catch(() => setAcik([]));
  }, [ay]);
  useEffect(() => { yukle(); }, [yukle]);
  const yap = async (anahtar, yol, govde) => {
    setMesgul((m) => ({ ...m, [anahtar]: true })); setHata('');
    try { const d = await api(yol, { method: 'POST', body: govde }); onToast?.(d.mesaj); setDuz((o) => { const y = { ...o }; delete y[anahtar]; return y; }); await yukle(); }
    catch (e) { setHata(e?.message || 'İşlenemedi'); if (e?.status === 409) yukle(); }   // Codex: durum değiştiyse liste tazelensin
    setMesgul((m) => { const y = { ...m }; delete y[anahtar]; return y; });
  };
  const ortak = { duz, setDuz, mesgul, yap };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Devirler</h1></div>
        <AySecici ay={ay} setAy={setAy} style={{ ...alan, marginLeft: 'auto' }} />
      </div>
      <div style={{ fontSize: 13, color: R.metin2 }}>
        Kasa devri (v2): kasa sahibi ve kasayı alan kişi kendi telefonlarında AYRI ve KÖR sayar (birbirinin rakamını görmez); sistem karşılaştırır.
        Tutmazsa bir kez birlikte yeniden sayılır; yine tutmazsa devir tamamlanır (resmi rakam devralanın) ve burada bilgi olarak görünür — "Gördüm".
        Onayı gelmeyen devri burada kapatırsın — "iptal" iz bırakmaz, "devir sayıldı" vardiya kaydını merkez istisnası olarak yazar; ikisi de kişi onayı yerine geçmez, satırda "merkez kapattı" yazar.
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata} <Dugme kucuk onClick={yukle}>Yeniden dene</Dugme></div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}

      {/* R5 (sim 25 Eki): patronun İŞ yapacağı Bekleyenler ayın bütün listesinin altındaydı → üstte */}
      <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>⏳ Bekleyenler — şu an AÇIK devirler (takıldıysa buradan kapat) + görülmemiş "tutmadı" · Bekleyen işler'e 2 saat sonra düşer</div>
        {acik === null && <div style={{ color: R.not, padding: 6 }}>Okunuyor…</div>}
        {acik && <DevirTablo satirlar={acik} bos="Bekleyen devir yok." {...ortak} />}
      </div>
      {v && (
        <div style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700, padding: '4px 0' }}>Gün gün devirler · {ay.slice(5, 7)}.{ay.slice(0, 4)} · en yeni üstte</div>
          <DevirTablo satirlar={(v.satirlar || []).slice().reverse()} bos="Bu ay devir kaydı yok." {...ortak} />
        </div>
      )}

    </div>
  );
}
