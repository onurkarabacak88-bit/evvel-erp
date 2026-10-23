// 🗓️ VARDİYA PLANI — tak-çıkar modül (sunucu: evvel_yeni_vardiya_api.py). Sayfası Personel altında. Tasarım: VARDIYA_PLANI_TASARIM.md.
// Sahip (20 Eki): "daha kolay, mantığı daha hoş; ama en az eskisi kadar işe yarar."
//   · Hafta ızgarası iki görünüm: ŞUBE (satır = kalıp, ör. "Sabah 09:00–18:30 · 1 kişi") · KİŞİ (satır = personel; izinli gri hücre).
//   · Akış: Geçen haftayı kopyala → 2-3 hücre düzelt → Yayınla. Yayınlanana kadar TASLAK (personel görmez — Y2).
//   · Hücreye tıkla → kişi seç / saat düzelt / kaldır. Aynı kişi aynı saatte iki yerde olamaz (sunucu söyler).
//   · Uyarılar bu sayfada (kalıp eksik · 7 gün üst üste · sonradan yazıldı) — personele gitmez, Bekleyen işler'e düşmez (K4).
// Ekran kendi hesabını kurmaz: saat, uyarı, yayın durumu sunucudan gelir.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { gunKaydir, gunKisa, tarihNokta } from '../../utils/trTarih';
import { ALAN, Cip, Dugme, kart, num, PI_CSS, R } from './KasaModulu';
import { Pencere } from './AyTakvim';

export const VARDIYA_SAYFALAR = [{ id: 'vardiya_plani', ad: 'Vardiya planı', alt: 'Hafta hafta kim nerede kaçta · taslak → yayın' }];
const alan = { ...ALAN, padding: '6px 9px', borderRadius: 9, fontSize: 13.5 };   // temel stil KasaModulu ALAN (T4-15)
const kisa = (s) => String(s || '').replace(/:00$/, '');                           // "09:00" → "09", "18:30" kalır
const saatYazi = (p) => `${kisa(p.bas)}–${kisa(p.bit)}`;
const gunBaslik = (g) => `${gunKisa(g)} ${tarihNokta(g).slice(0, 5)}`;   // gün adı TEK kaynak trTarih
const arti = { border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: 15, minHeight: 40, minWidth: 44, padding: '6px 8px', width: '100%', textAlign: 'left' };
const hucre = { borderTop: `1px solid ${R.cizgi}`, borderLeft: `1px solid ${R.cizgi}`, padding: 5, verticalAlign: 'top', minWidth: 96 };

function Rozet({ p, ad, onClick, sube }) {
  const izin = p.tur === 'izin';
  return (
    <button type="button" onClick={onClick} title={p.kaynak === 'sonradan' ? 'sonradan yazıldı' : ''} style={{
      display: 'block', width: '100%', textAlign: 'left', margin: '0 0 4px', padding: '8px 8px', minHeight: 40, borderRadius: 8, cursor: 'pointer',
      font: 'inherit', fontSize: 13, border: `1px solid ${R.cizgi}`, color: izin ? R.not : R.krem,
      background: izin ? 'var(--pi-bg)' : 'var(--pi-accent-soft)', borderStyle: p.kaynak === 'sonradan' ? 'dashed' : 'solid',
    }}>
      {izin ? (ad ? <><b>{ad}</b> · izinli</> : 'İzinli') : <>{ad && <b>{ad} </b>}<span style={num}>{saatYazi(p)}</span></>}{sube ? <div style={{ fontSize: 11, color: R.not }}>{sube}</div> : null}
    </button>
  );
}

// 🖨 Yazdır: tarayıcı yazdırma (PDF kütüphanesi yok) — düğmeler, '+' ve uyarılar kâğıda çıkmaz; ızgara A4 yatay
const YAZDIR_CSS = `@media print { @page { size: A4 landscape; margin: 10mm }
  body * { visibility: hidden } .vd-alan, .vd-alan * { visibility: visible } .vd-alan { position: absolute; left: 0; top: 0; width: 100% }
  .vd-gizle, button.vd-arti { display: none !important } }`;   // yalnız plan basılır (sol menü / kabuk değil)

// 👥 BOŞTA = o gün aktif, işe başlamış / ayrılmamış, izinli DEĞİL ve hiçbir şubeye yazılmamış kişi (sahip 20 Eki: "solda kalan
// personel belli olsun; güne yazılınca soldan silinsin, seçimde de görünmesin"). Sol liste ve kişi seçme penceresi bu TEK kuralı okur.
const gunuDolu = (v, pid, g) => v.plan.some((x) => x.personel_id === pid && x.gun === g);
const calisabilir = (p, g) => p.aktif && !(p.giris && g < p.giris) && !(p.cikis && g > p.cikis);
const bostakiler = (v, g) => v.personel.filter((p) => calisabilir(p, g) && !gunuDolu(v, p.id, g));

export default function VardiyaModulu({ onToast }) {
  const [pzt, setPzt] = useState(null);         // null → sunucu bu haftayı seçer
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [gorunum, setGorunum] = useState('sube');
  const [mesgul, setMesgul] = useState(false);
  const [form, setForm] = useState(null);       // ekle / düzenle penceresi
  const [kalipAcik, setKalipAcik] = useState(false);
  const [gunSec, setGunSec] = useState(null);   // sol 'Boştakiler' listesinin günü
  const [secili, setSecili] = useState(null);   // soldan dokunulan kişi → '+' kutusuna dokununca doğrudan yazılır
  const yukle = useCallback(() => api(`/evvel-yeni/vardiya/hafta${pzt ? `?pazartesi=${pzt}` : ''}`)
    .then((d) => { setV(d); setHata(''); }).catch((e) => setHata(e?.message || 'Plan okunamadı')), [pzt]);
  useEffect(() => { yukle(); }, [yukle]);

  const yap = async (yol, govde, sonra) => {
    setMesgul(true); setHata('');
    try { const d = await api(`/evvel-yeni/vardiya/${yol}`, { method: 'POST', body: govde }); onToast?.(d.mesaj); sonra?.(); await yukle(); return true; }
    catch (e) { setHata(e?.message || 'İşlenemedi'); return false; }
    finally { setMesgul(false); }
  };

  const pad = useMemo(() => Object.fromEntries((v?.personel || []).map((p) => [p.id, p.ad])), [v]);
  const sad = useMemo(() => Object.fromEntries((v?.subeler || []).map((s) => [s.id, s.ad])), [v]);
  const bugun = v?.bugun;
  const gecmis = (g) => bugun && g < bugun;

  if (!v) return (
    <div className="pi" style={{ display: 'grid', gap: 10 }}><style>{PI_CSS}</style>
      {hata ? <><div style={{ color: R.kirmizi }}>{hata}</div><div><Dugme kucuk onClick={yukle}>Yeniden dene</Dugme></div></> : <div style={{ color: R.not }}>Hazırlanıyor…</div>}
    </div>
  );

  const hafta = v.pazartesi;
  const gun = v.gunler.includes(gunSec) ? gunSec : (v.gunler.includes(bugun) ? bugun : v.gunler[0]);
  const bosta = bostakiler(v, gun);
  // Seçili kişi (soldan dokunuldu): BOŞ olduğu HER günün kutusu '+ Ad' olur, dokununca pencere açmadan yazılır; seçim KALIR (art arda
  // birkaç güne yazılır — sahip 20 Eki: 'tıkladığımız herhangi bir boş alana direkt kişiyi atayabilelim'). Bitince isme tekrar dokun.
  const seciliP = secili ? v.personel.find((p) => p.id === secili) : null;
  const bostaMi = (g) => !!seciliP && calisabilir(seciliP, g) && !gunuDolu(v, seciliP.id, g);
  // '+' : soldan kişi seçiliyse ve o gün boştaysa PENCERE AÇMADAN yazılır; değilse seçim penceresi
  const arti_ = (o) => {
    setGunSec(o.gun);   // sol liste eklenen güne geçer → eklenen kişinin listeden düştüğü görünür (sahip: 'Elif soldan kaybolmadı')
    if (bostaMi(o.gun) && o.kalip_id) {
      yap('plan', { personel_id: secili, gun: o.gun, sube_id: o.sube_id, bas: o.bas, bit: o.bit, kalip_id: o.kalip_id });
      return;
    }
    ekleAc({ ...o, personel_id: bostaMi(o.gun) ? secili : '' });
  };
  const ekleAc = (o) => setForm({ yeni: true, tur: 'calisma', personel_id: '', bas: '09:00', bit: '18:30', ...o });
  const duzenleAc = (p) => setForm({ yeni: false, ...p });

  return (
    <div className="pi vd-alan" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS + YAZDIR_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Personel</div><h1 style={{ fontSize: 30 }}>Vardiya planı</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>
        Geçen haftayı kopyala, değişen hücreleri düzelt, şubenin haftasını <b>Yayınla</b>. Yayınlanana kadar taslaktır: personel görmez,
        geç kalma ölçülmez. Yayından sonraki değişiklik hemen geçerli olur. Bugün ve geçmiş günler her zaman geçerlidir.
      </div>

      {/* hafta gezgini + görünüm + toplu işler */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dugme kucuk onClick={() => setPzt(gunKaydir(hafta, -7))}>◀</Dugme>
        <b style={{ ...num, minWidth: 150, textAlign: 'center' }}>{tarihNokta(hafta).slice(0, 5)} – {tarihNokta(gunKaydir(hafta, 6))}</b>
        <Dugme kucuk onClick={() => setPzt(gunKaydir(hafta, 7))}>▶</Dugme>
        <Dugme kucuk onClick={() => setPzt(null)}>Bu hafta</Dugme>
        <span style={{ flex: 1 }} />
        <Dugme kucuk ana={gorunum === 'sube'} onClick={() => setGorunum('sube')}>Şube</Dugme>
        <Dugme kucuk ana={gorunum === 'kisi'} onClick={() => setGorunum('kisi')}>Kişi</Dugme>
      </div>
      <div className="vd-gizle" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Dugme kucuk disabled={mesgul} onClick={() => { if (window.confirm('Geçen haftanın planı bu haftaya kopyalansın mı? (Dolu hücreler atlanır, taslak olarak gelir.)')) yap('hafta-kopyala', { pazartesi: hafta }); }}>📋 Geçen haftayı kopyala</Dugme>
        {v.eski_kopya && <Dugme kucuk disabled={mesgul} onClick={() => { if (window.confirm('Eski vardiya ekranında bu hafta için yazılmış plan buraya alınsın mı? (Alınan hafta yayında sayılır.)')) yap('eski-kopya', { pazartesi: hafta }); }}>⤵ Eski plandan al</Dugme>}
        <Dugme kucuk onClick={() => setKalipAcik(true)}>⚙ Kalıplar</Dugme>
        <Dugme kucuk onClick={() => window.print()}>🖨 Yazdır</Dugme>
      </div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}

      {gorunum === 'sube' ? (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="vd-gizle" style={{ ...kart, padding: '10px 12px', width: 190, flex: '0 0 190px', position: 'sticky', top: 8, display: 'grid', gap: 6 }}>
            <b style={{ fontSize: 14 }}>👥 Boştakiler</b>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {v.gunler.map((g) => (
                <button key={g} type="button" onClick={() => { setGunSec(g); setSecili(null); }} style={{
                  border: `1px solid ${R.cizgi}`, borderRadius: 7, padding: '6px 7px', minHeight: 36, cursor: 'pointer', font: 'inherit', fontSize: 12,
                  background: g === gun ? 'var(--pi-accent)' : 'transparent', color: g === gun ? 'var(--pi-on-accent)' : R.metin2 }}>{gunKisa(g)}</button>))}
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: R.bakirAcik }}>{gunBaslik(gun)}{gun === bugun ? ' (bugün)' : ''} · {bosta.length} kişi boşta</div>
            {bosta.map((p) => (
              <button key={p.id} type="button" onClick={() => setSecili(secili === p.id ? null : p.id)} style={{
                textAlign: 'left', padding: '9px 10px', minHeight: 42, borderRadius: 9, cursor: 'pointer', font: 'inherit', fontSize: 13.5,
                border: `1px solid ${secili === p.id ? 'var(--pi-accent)' : R.cizgi}`,
                background: secili === p.id ? 'var(--pi-accent-soft)' : 'var(--pi-paper)', color: R.krem }}>
                <b>{p.ad}</b><div style={{ fontSize: 11, color: R.not }}>{sad[p.sube_id] || 'Ortak'}{p.calisma_turu === 'yari' ? ' · yarı zamanlı' : ''}</div>
              </button>))}
            {!bosta.length && <div style={{ fontSize: 12.5, color: R.yesil }}>Herkes yazıldı ya da izinli ✓</div>}
            {seciliP && <div style={{ fontSize: 12.5, padding: '6px 8px', borderRadius: 8, background: 'var(--pi-accent-soft)' }}><b>{seciliP.ad}</b> seçili → boş olduğu günlerdeki '+ {seciliP.ad}' kutularına dokun (art arda olur) · <button type="button" onClick={() => setSecili(null)} style={{ border: 'none', background: 'none', color: R.bakirAcik, cursor: 'pointer', font: 'inherit', padding: 0 }}>bitir</button></div>}
            {!seciliP && <div style={{ fontSize: 11.5, color: R.not }}>Bir isme dokun, sonra o kişinin gireceği kutulara dokun.</div>}
          </div>
          <div style={{ flex: '1 1 600px', minWidth: 0, display: 'grid', gap: 14 }}>
      {v.subeler.map((s) => {
        const kaliplar = v.kaliplar.filter((k) => k.sube_id === s.id);
        const plan = v.plan.filter((p) => p.sube_id === s.id && p.tur === 'calisma');
        const kalipIds = new Set(kaliplar.map((k) => k.id));
        const diger = plan.filter((p) => !kalipIds.has(p.kalip_es));   // kalip_es: sunucu aynı saatli satırı kalıba eşler
        return (
          <div key={s.id} style={{ ...kart, padding: '10px 14px', display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16 }}>{s.ad}</b>
              {s.yayin ? <Cip tur="yesil">yayında · {tarihNokta(s.yayin.zaman).slice(0, 5)} {s.yayin.zaman.slice(11, 16)}</Cip> : <Cip tur="sari">taslak — personel görmüyor</Cip>}
              {s.yayin && s.degisen > 0 && <Cip tur="bakir">yayından sonra {s.degisen} değişiklik (geçerli)</Cip>}
              <span style={{ flex: 1 }} />
              {(!s.yayin || s.degisen > 0) && s.satir > 0 && (
                <Dugme kucuk ana disabled={mesgul} onClick={() => yap('yayinla', { pazartesi: hafta, sube_id: s.id })}>{s.yayin ? 'Yeniden yayınla' : 'Yayınla'}</Dugme>)}
              {!s.yayin && s.satir > 0 && (
                <span className="vd-gizle"><Dugme kucuk disabled={mesgul} onClick={() => { if (window.confirm(`${s.ad} · bu haftanın taslağı (bugünden sonraki günler) temizlensin mi?`)) yap('taslak-temizle', { pazartesi: hafta, sube_id: s.id }); }}>🧹 Taslağı temizle</Dugme></span>)}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead><tr><th style={{ textAlign: 'left', padding: 5, minWidth: 130 }} />{v.gunler.map((g) => (
                  <th key={g} onClick={() => { setGunSec(g); setSecili(null); }} style={{ padding: 5, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
                    color: g === bugun ? R.bakirAcik : R.metin2, background: g === gun ? 'var(--pi-accent-soft)' : undefined }}>{gunBaslik(g)}</th>))}</tr></thead>
                <tbody>
                  {kaliplar.map((k) => (
                    <tr key={k.id}>
                      <td style={{ ...hucre, borderLeft: 'none' }}><b>{k.ad}</b><div style={{ fontSize: 11.5, color: R.not, ...num }}>{saatYazi(k)} · {k.kisi} kişi</div></td>
                      {v.gunler.map((g, i) => {
                        const aktifGun = k.gunler.includes(i + 1);
                        const bu = plan.filter((p) => p.gun === g && p.kalip_es === k.id);
                        const eksik = aktifGun && !gecmis(g) && bu.length < k.kisi;
                        return (
                          <td key={g} style={{ ...hucre, background: !aktifGun ? 'var(--pi-bg)' : eksik ? 'var(--pi-warn-soft)' : undefined }}>
                            {bu.map((p) => <Rozet key={p.id} p={p} ad={pad[p.personel_id] || '—'} onClick={() => duzenleAc(p)} />)}
                            {aktifGun && <button type="button" className="vd-arti" disabled={mesgul} onClick={() => arti_({ sube_id: s.id, gun: g, kalip_id: k.id, bas: k.bas, bit: k.bit })}
                              style={{ ...arti, color: eksik ? R.amber : R.not, background: bostaMi(g) ? 'var(--pi-accent-soft)' : 'none' }}>
                              {bostaMi(g) ? `+ ${seciliP.ad}` : eksik ? `+ ${bu.length}/${k.kisi}` : '+'}</button>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...hucre, borderLeft: 'none' }}><b>Diğer saatler</b><div style={{ fontSize: 11.5, color: R.not }}>kalıp dışı</div></td>
                    {v.gunler.map((g) => (
                      <td key={g} style={hucre}>
                        {diger.filter((p) => p.gun === g).map((p) => <Rozet key={p.id} p={p} ad={pad[p.personel_id] || '—'} onClick={() => duzenleAc(p)} />)}
                        <button type="button" className="vd-arti" disabled={mesgul} onClick={() => arti_({ sube_id: s.id, gun: g, kalip_id: null })}
                          style={{ ...arti, color: R.not, background: bostaMi(g) ? 'var(--pi-accent-soft)' : 'none' }}>{bostaMi(g) ? `+ ${seciliP.ad}` : '+'}</button>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            {!kaliplar.length && <div style={{ fontSize: 12.5, color: R.not }}>Bu şubenin kalıbı yok — ⚙ Kalıplar'dan ekle (ör. Sabah 09:00–18:30 · 1 kişi).</div>}
          </div>
        );
      })}
          </div>
        </div>
      ) : (
        <div style={{ ...kart, padding: '10px 14px', overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
            <thead><tr><th style={{ textAlign: 'left', padding: 5, minWidth: 130 }}>Personel</th>{v.gunler.map((g) => (
              <th key={g} style={{ padding: 5, fontWeight: 600, color: g === bugun ? R.bakirAcik : R.metin2, textAlign: 'left' }}>{gunBaslik(g)}</th>))}<th style={{ padding: 5 }}>Saat</th></tr></thead>
            <tbody>
              {v.personel.filter((p) => p.aktif || v.plan.some((x) => x.personel_id === p.id)).map((p) => {
                const yedi = v.uyarilar.some((u) => u.tur === 'yedi_gun' && u.personel_id === p.id);
                const top = v.plan.filter((x) => x.personel_id === p.id).reduce((a, x) => a + (x.saat || 0), 0);
                return (
                  <tr key={p.id}>
                    <td style={{ ...hucre, borderLeft: 'none', background: yedi ? 'var(--pi-warn-soft)' : undefined }}>
                      <b>{p.ad}</b><div style={{ fontSize: 11.5, color: R.not }}>{sad[p.sube_id] || 'Ortak'}{p.calisma_turu === 'yari' ? ' · yarı zamanlı' : ''}{yedi ? ' · 7 gün üst üste' : ''}</div>
                    </td>
                    {v.gunler.map((g) => {
                      const bu = v.plan.filter((x) => x.personel_id === p.id && x.gun === g);
                      return (
                        <td key={g} style={hucre}>
                          {bu.map((x) => <Rozet key={x.id} p={x} ad="" sube={x.tur === 'calisma' ? sad[x.sube_id] : null} onClick={() => duzenleAc(x)} />)}
                          {!bu.some((x) => x.tur === 'izin') && (
                            <button type="button" className="vd-arti" disabled={mesgul} onClick={() => ekleAc({ personel_id: p.id, gun: g, sube_id: p.sube_id || '', kalip_id: null, kisiSabit: true })}
                              style={{ ...arti, color: R.not }}>+</button>)}
                        </td>
                      );
                    })}
                    <td style={{ ...hucre, ...num, textAlign: 'right' }}>{top ? `${Math.round(top * 10) / 10} sa` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* UYARILAR — modülün kendi listesi (K4) */}
      <div className="vd-gizle" style={{ ...kart, padding: '8px 14px', display: 'grid', gap: 2 }}>
        <div style={{ fontSize: 12, color: R.metin2, fontWeight: 700 }}>Uyarılar · bu hafta</div>
        {!v.uyarilar.length && <div style={{ color: R.not, padding: 6, fontSize: 13 }}>Uyarı yok.</div>}
        {v.uyarilar.map((u, i) => (
          <div key={i} style={{ borderTop: `1px solid ${R.cizgi}`, padding: '6px 0', fontSize: 13 }}>
            {{ ayrildi: '🚪', kalip_eksik: '👤', yedi_gun: '🟡', sonradan: '✎' }[u.tur] || '•'} {u.metin}
          </div>
        ))}
      </div>

      {form && <PlanFormu form={form} setForm={setForm} v={v} mesgul={mesgul} yap={yap} />}
      {kalipAcik && <Kaliplar v={v} mesgul={mesgul} yap={yap} onKapat={() => setKalipAcik(false)} />}
    </div>
  );
}

// ── Ekle / düzenle penceresi ──
function PlanFormu({ form, setForm, v, mesgul, yap }) {
  const set = (k, x) => setForm((f) => ({ ...f, [k]: x }));
  const kapat = () => setForm(null);
  const kisi = v.personel.find((p) => p.id === form.personel_id);
  // kişi listesi: o gün BOŞTA olanlar (sol listeyle aynı kural); önce o şubenin kendi personeli. 'Bölünmüş vardiya' işaretlenirse
  // o gün başka şubede yazılı olanlar da gelir (aynı gün iki şube serbest — saat çakışmasını sunucu söyler); izinli asla gelmez.
  const izinli = (pid) => v.plan.some((x) => x.personel_id === pid && x.gun === form.gun && x.tur === 'izin');
  const liste = v.personel.filter((p) => calisabilir(p, form.gun) && !izinli(p.id) && (form.bolunmus || !gunuDolu(v, p.id, form.gun)))
    .sort((a, b) => ((b.sube_id === form.sube_id) - (a.sube_id === form.sube_id)) || a.ad.localeCompare(b.ad, 'tr'));
  const baslik = form.yeni
    ? `${form.kisiSabit ? (kisi?.ad || '') + ' · ' : ''}${gunBaslik(form.gun)}${form.sube_id && !form.kisiSabit ? ' · ' + (v.subeler.find((s) => s.id === form.sube_id)?.ad || '') : ''}`
    : `${kisi?.ad || '—'} · ${gunBaslik(form.gun)}`;
  if (!form.yeni) {
    return (
      <Pencere baslik={baslik} onKapat={kapat} mesgul={mesgul}>
        {form.tur === 'izin' ? <div style={{ fontSize: 13.5 }}><b>İzinli</b> · {tarihNokta(form.izin_bas).slice(0, 5)}–{form.izin_bit ? tarihNokta(form.izin_bit).slice(0, 5) : 'bitişi belli değil'}<div style={{ fontSize: 12, color: R.not }}>İzin Personel'in izin defterinde (maaş da buradan okur).</div></div> : (
          <>
            <div style={{ fontSize: 13, color: R.metin2 }}>{v.subeler.find((s) => s.id === form.sube_id)?.ad} · {form.saat} saat{form.kaynak === 'sonradan' ? ' · sonradan yazıldı' : ''}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="time" value={form.bas || ''} onChange={(e) => set('bas', e.target.value)} style={alan} />–
              <input type="time" value={form.bit || ''} onChange={(e) => set('bit', e.target.value)} style={alan} />
              <Dugme kucuk ana disabled={mesgul} onClick={() => yap(`plan/${form.id}/degistir`, { bas: form.bas, bit: form.bit }, kapat)}>Saati kaydet</Dugme>
            </div>
          </>
        )}
        <div style={{ fontSize: 11.5, color: R.not }}>yazan: {form.degistiren || '—'}{form.zaman ? ` · ${form.zaman}` : ''}</div>
        <div><Dugme kucuk disabled={mesgul} onClick={() => { if (window.confirm(form.tur === 'izin' ? 'İzin (bütün aralık) kaldırılsın mı?' : 'Bu vardiya plandan kaldırılsın mı?')) yap(form.tur === 'izin' ? `izin/${encodeURIComponent(form.id)}/kaldir` : `plan/${form.id}/iptal`, {}, kapat); }}>
          {form.tur === 'izin' ? 'İzni kaldır' : 'Plandan kaldır'}</Dugme></div>
      </Pencere>
    );
  }
  const kaydet = () => (form.tur === 'izin'
    ? yap('izin', { personel_id: form.personel_id, bas: form.gun, bit: form.izin_bit || form.gun }, kapat)
    : yap('plan', { personel_id: form.personel_id, gun: form.gun, tur: 'calisma', sube_id: form.sube_id, bas: form.bas, bit: form.bit, kalip_id: form.kalip_id }, kapat));
  const kaliplar = v.kaliplar.filter((k) => k.sube_id === form.sube_id);
  return (
    <Pencere baslik={baslik} onKapat={kapat} mesgul={mesgul}>
      {form.kisiSabit && v.izin_acik && (
        <div style={{ display: 'flex', gap: 6 }}>
          <Dugme kucuk ana={form.tur === 'calisma'} onClick={() => set('tur', 'calisma')}>Çalışıyor</Dugme>
          <Dugme kucuk ana={form.tur === 'izin'} onClick={() => set('tur', 'izin')}>İzinli</Dugme>
        </div>
      )}
      {form.tur === 'izin' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13.5 }}>
          {tarihNokta(form.gun).slice(0, 5)} → <input type="date" min={form.gun} value={form.izin_bit || form.gun} onChange={(e) => set('izin_bit', e.target.value)} style={alan} /> gününe kadar
          <span style={{ fontSize: 12, color: R.not }}>tek hamlede; maaş da aynı kaydı okur</span>
        </div>
      )}
      {!form.kisiSabit && (
        <select value={form.personel_id} onChange={(e) => set('personel_id', e.target.value)} style={alan}>
          <option value="">Kişi seç…</option>
          {liste.map((p) => <option key={p.id} value={p.id}>{p.ad}{p.sube_id && p.sube_id !== form.sube_id ? ` (${v.subeler.find((s) => s.id === p.sube_id)?.ad || 'başka şube'})` : ''}{gunuDolu(v, p.id, form.gun) ? ' · bugün başka yerde' : ''}</option>)}
        </select>
      )}
      {!form.kisiSabit && (
        <label style={{ fontSize: 12.5, color: R.not, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={!!form.bolunmus} onChange={(e) => set('bolunmus', e.target.checked)} />
          o gün başka şubede yazılı olanları da göster (bölünmüş vardiya)
        </label>
      )}
      {form.tur === 'calisma' && (
        <>
          {form.kisiSabit && (
            <select value={form.sube_id || ''} onChange={(e) => setForm((f) => ({ ...f, sube_id: e.target.value, kalip_id: null }))} style={alan}>
              <option value="">Şube seç…</option>{v.subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
            </select>
          )}
          {form.kisiSabit && kaliplar.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {kaliplar.map((k) => <Dugme key={k.id} kucuk ana={form.kalip_id === k.id} onClick={() => setForm((f) => ({ ...f, kalip_id: k.id, bas: k.bas, bit: k.bit }))}>{k.ad} {saatYazi(k)}</Dugme>)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="time" value={form.bas || ''} onChange={(e) => set('bas', e.target.value)} style={alan} />–
            <input type="time" value={form.bit || ''} onChange={(e) => set('bit', e.target.value)} style={alan} />
            <span style={{ fontSize: 12, color: R.not }}>bitiş başlangıçtan önceyse ertesi gün sayılır</span>
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Dugme kucuk disabled={mesgul} onClick={kapat}>Vazgeç</Dugme>
        <Dugme kucuk ana disabled={mesgul || !form.personel_id || (form.tur === 'calisma' && (!form.sube_id || !form.bas || !form.bit))} onClick={kaydet}>Plana yaz</Dugme>
      </div>
    </Pencere>
  );
}

// ── Kalıplar (şubenin kadro iskeleti) + geç kalma toleransı ──
const GUN_SIRA = [1, 2, 3, 4, 5, 6, 7];
const GUN_AD = ['', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct', 'Pz'];

function Kaliplar({ v, mesgul, yap, onKapat }) {
  const [duz, setDuz] = useState({});      // id → değişen alanlar
  const [yeni, setYeni] = useState(null);
  const [ayar, setAyar] = useState(null);
  useEffect(() => { api('/evvel-yeni/vardiya/ayar').then(setAyar).catch(() => setAyar(null)); }, []);
  const deger = (k, a) => (duz[k.id] && duz[k.id][a] !== undefined ? duz[k.id][a] : k[a]);
  const set = (k, a, x) => setDuz((d) => ({ ...d, [k.id]: { ...(d[k.id] || {}), [a]: x } }));
  const gunDegis = (gunler, g) => (gunler.includes(g) ? gunler.filter((x) => x !== g) : [...gunler, g].sort());
  const Satir = ({ k, onDegis, d }) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '6px 0' }}>
      <input value={d('ad') || ''} onChange={(e) => onDegis('ad', e.target.value)} placeholder="Ad (Sabah)" style={{ ...alan, width: 110 }} />
      <input type="time" value={d('bas') || ''} onChange={(e) => onDegis('bas', e.target.value)} style={alan} />–
      <input type="time" value={d('bit') || ''} onChange={(e) => onDegis('bit', e.target.value)} style={alan} />
      <input type="number" min={0} max={20} value={d('kisi') ?? 1} onChange={(e) => onDegis('kisi', Number(e.target.value))} style={{ ...alan, width: 56 }} title="kaç kişi" />
      <span style={{ fontSize: 12, color: R.not }}>kişi</span>
      <span style={{ display: 'flex', gap: 2 }}>{GUN_SIRA.map((g) => {
        const on = (d('gunler') || []).includes(g);
        return <button key={g} type="button" onClick={() => onDegis('gunler', gunDegis(d('gunler') || [], g))} style={{
          border: `1px solid ${R.cizgi}`, borderRadius: 6, padding: '2px 5px', fontSize: 11.5, cursor: 'pointer', font: 'inherit',
          background: on ? 'var(--pi-accent-soft)' : 'transparent', color: on ? R.krem : R.not }}>{GUN_AD[g]}</button>;
      })}</span>
    </div>
  );
  return (
    <Pencere baslik="Kalıplar · şubenin kadro iskeleti" onKapat={onKapat} mesgul={mesgul} genislik={760}>
      <div style={{ fontSize: 12.5, color: R.metin2 }}>Her satır: bir vardiya düzeni ve kaç kişi gerektiği. Eksik kalan gün ızgarada sarı görünür. Kalıp silinmez, pasife alınır (geçmiş plan bozulmaz).</div>
      {v.subeler.map((s) => (
        <div key={s.id} style={{ display: 'grid', gap: 2 }}>
          <b>{s.ad}</b>
          {v.kaliplar.filter((k) => k.sube_id === s.id).map((k) => (
            <div key={k.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {Satir({ k, d: (a) => deger(k, a), onDegis: (a, x) => set(k, a, x) })}
              {duz[k.id] && <Dugme kucuk ana disabled={mesgul} onClick={() => yap(`kalip/${k.id}/degistir`, duz[k.id], () => setDuz((d) => { const y = { ...d }; delete y[k.id]; return y; }))}>Kaydet</Dugme>}
              <Dugme kucuk disabled={mesgul} onClick={() => { if (window.confirm(`${s.ad} · ${k.ad} kalıbı pasife alınsın mı?`)) yap(`kalip/${k.id}/degistir`, { aktif: false }); }}>Pasife al</Dugme>
            </div>
          ))}
          {yeni?.sube_id === s.id ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {Satir({ k: yeni, d: (a) => yeni[a], onDegis: (a, x) => setYeni((y) => ({ ...y, [a]: x })) })}
              <Dugme kucuk ana disabled={mesgul || !yeni.ad || !yeni.bas || !yeni.bit} onClick={() => yap('kalip', yeni, () => setYeni(null))}>Ekle</Dugme>
              <Dugme kucuk onClick={() => setYeni(null)}>Vazgeç</Dugme>
            </div>
          ) : <div><Dugme kucuk onClick={() => setYeni({ sube_id: s.id, ad: '', bas: '09:00', bit: '18:30', kisi: 1, gunler: GUN_SIRA })}>+ Kalıp ekle</Dugme></div>}
        </div>
      ))}
      {ayar && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: `1px solid ${R.cizgi}`, paddingTop: 8, fontSize: 13 }}>
          Geç kalma toleransı
          <input type="number" min={0} max={60} value={ayar.gec_tolerans_dk} onChange={(e) => setAyar((a) => ({ ...a, gec_tolerans_dk: Number(e.target.value) }))} style={{ ...alan, width: 64 }} /> dk
          <Dugme kucuk disabled={mesgul} onClick={() => yap('ayar', { gec_tolerans_dk: ayar.gec_tolerans_dk })}>Kaydet</Dugme>
        </div>
      )}
    </Pencere>
  );
}
