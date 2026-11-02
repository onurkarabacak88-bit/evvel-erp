// 💰 PARA GİRİŞİ — tek kapı (sahip 2 Kas · IS 5ds · GELIR_GIRISI_KURGU.md · Fable + Codex L4b). "Ödeme / gider gir"in aynası:
// kasaya dışarıdan para girişinin TEK formu (şube kapanışı + otomatik POS + taşıma ayrı). Sunucu: evvel_yeni_kasa_api giris_yaz (/kasa/giris).
// Konular sunucudan (kapalı modülün konusu gelmez). Öteki ekranlar kendi formunu açmaz: sessionStorage 'ey_giris_on' ile ön doldurup buraya gelir.
// Sahip K1/K4: iade gelen para · verilen borç tahsilatı · emanet AÇILMADI.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../utils/api';
import { yeniIstekId } from '../../utils/cihazImza';
import { ALAN, Dugme, kart, PI_CSS, R, sor } from './KasaModulu';
import { izinVar } from './yetki';   // 🔐 izin TEK kaynak

const alan = { ...ALAN, width: '100%', padding: '10px 12px', fontSize: 15, minWidth: 0 };
const bugun = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const AY = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const ayAd = (a) => (a ? `${AY[Number(a.slice(5, 7)) - 1]} ${a.slice(0, 4)}` : '');
const BOS = (konu = '') => ({ konu, is_gunu: bugun(), parcalar: [{ cep: '', tutar: '' }], havale: '', elden: '', kimden: '', not: '', gelir: null,
  sube_id: '', brut: '', mulk_id: '', ay: '', kredi_id: '', banka: '' });

function Etiket({ ad, ipucu, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: R.metin2 }}>
      <span>{ad}{ipucu ? <span style={{ color: R.not }}> · {ipucu}</span> : null}</span>
      {children}
    </label>
  );
}

export default function ParaGirisi({ onToast }) {
  const [L, setL] = useState(null);
  const [hata, setHata] = useState('');
  const [f, setF] = useState(BOS());
  const [istek, setIstek] = useState(() => yeniIstekId());
  const [mesgul, setMesgul] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const yukle = useCallback(() => api('/evvel-yeni/kasa/giris/listeler').then((d) => { setL(d); setHata(''); return d; })
    .catch((e) => { setHata(e?.message || 'Listeler okunamadı'); return null; }), []);
  useEffect(() => {
    yukle().then((d) => {
      if (!d) return;
      let on = null;   // öteki ekrandan gelen ön doldurma (Mülk › Kira geldi, Kasam, Krediler)
      try { on = JSON.parse(window.sessionStorage.getItem('ey_giris_on') || 'null'); window.sessionStorage.removeItem('ey_giris_on'); } catch { /* yut */ }
      if (on && d.konular.some((k) => k.kod === on.konu)) setF({ ...BOS(on.konu), ...on, parcalar: [{ cep: on.cep || '', tutar: on.tutar ? String(on.tutar) : '' }] });
    });
  }, [yukle]);

  const konu = (L?.konular || []).find((k) => k.kod === f.konu);
  const normalCepler = useMemo(() => (L?.cepler || []).filter((c) => !c.kira), [L]);
  const bankalar = useMemo(() => normalCepler.filter((c) => c.tur === 'banka'), [normalCepler]);
  const evler = L?.secenekler?.kira?.evler || [];
  const ev = evler.find((e) => e.id === f.mulk_id);
  const krediler = L?.secenekler?.kredi?.krediler || [];
  const bagsiz = L?.secenekler?.kira?.baglanmamis || [];
  // IS 5ds parça 3: evin tek açık ayı varsa kendiliğinden seçilir ("Kira gelmedi" birden çok ay olabilir → o zaman sorulur)
  const otoAy = useRef('');   // Fable L6-140: ev başına BİR kez — kullanıcı ayı boşaltırsa geri doldurulmaz
  useEffect(() => {
    if (f.konu !== 'kira' || !ev || otoAy.current === ev.id) return;
    otoAy.current = ev.id;
    if (!f.ay && ev.acik_aylar.length === 1) setF((x) => ({ ...x, ay: ev.acik_aylar[0].ay }));
  }, [f.konu, f.ay, ev]);
  const sayi = (t) => { const n = Number(String(t || '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const bagla = async (g) => {   // eski "Kira geldi" penceresindeki "Bunu bağla": para yeniden yazılmaz, eski giriş eve + aya bağlanır (Codex)
    setMesgul(true); setHata('');
    try { const r = await api('/evvel-yeni/mulk/bagla', { method: 'POST', body: { hareket_id: g.id, mulk_id: f.mulk_id, ay: f.ay } }); onToast?.(r?.mesaj || 'Bağlandı'); setF(BOS('kira')); yukle(); }
    catch (e) { setHata(e?.message || 'Bağlanamadı'); }
    setMesgul(false);
  };

  const govde = (tekrar) => {
    const b = { konu: f.konu, is_gunu: f.is_gunu, not: f.not || null, istek_id: istek, tekrar_onay: !!tekrar };
    if (f.konu === 'kira') {
      b.mulk_id = f.mulk_id; b.ay = f.ay;
      b.parcalar = [{ cep: 'banka:fatma_kira', tutar: f.havale }, { cep: 'nakit:kira', tutar: f.elden }].filter((p) => String(p.tutar || '').trim());
    } else if (f.konu === 'online') {
      b.parcalar = [{ cep: f.banka, tutar: f.parcalar[0]?.tutar }]; b.brut = String(f.brut || '').trim() || null;
    } else {
      b.parcalar = f.parcalar.filter((p) => p.cep && String(p.tutar || '').trim());
    }
    if (f.konu === 'kredi') b.kredi_id = f.kredi_id;
    if (['borc', 'destek'].includes(f.konu)) b.kimden = f.kimden;
    if (f.konu === 'satis') b.sube_id = f.sube_id;
    if (f.konu === 'diger') b.gelir = f.gelir;
    return b;
  };
  const kaydet = async (tekrar = false) => {
    setMesgul(true); setHata('');
    try {
      const r = await api('/evvel-yeni/kasa/giris', { method: 'POST', body: govde(tekrar) });
      onToast?.(r?.tekrar ? (r.mesaj || 'Bu giriş zaten yazılmıştı') : `${konu?.ad || 'Giriş'} kaydedildi`);
      setF(BOS(f.konu)); setIstek(yeniIstekId()); yukle();
    } catch (e) {
      // Ödeme aynası: BENZER KAYIT bilerek geçilebilir (bağ / cep / kilit yasakları sunucuda yine geçerli)
      if (e?.status === 409 && /BENZER KAYIT/.test(e?.message || '') && !tekrar && await sor({ soru: e.message, tamam: 'Evet, ikinci giriş' })) { setMesgul(false); return kaydet(true); }
      setHata(e?.message || 'Kaydedilemedi');
    }
    setMesgul(false);
  };

  const parcaSatiri = (p, n, liste) => (
    <div key={n} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) auto', gap: 6 }}>
      <select value={p.cep} style={alan} onChange={(e) => set('parcalar', f.parcalar.map((z, m) => (m === n ? { ...z, cep: e.target.value } : z)))}>
        <option value="">Hangi cebe girdi…</option>
        {liste.map((c) => <option key={c.id} value={c.id}>{c.ad}</option>)}
      </select>
      <input style={alan} inputMode="decimal" placeholder="Tutar ₺" value={p.tutar} onChange={(e) => set('parcalar', f.parcalar.map((z, m) => (m === n ? { ...z, tutar: e.target.value } : z)))} />
      <Dugme kucuk disabled={f.parcalar.length < 2} onClick={() => set('parcalar', f.parcalar.filter((_, m) => m !== n))}>✕</Dugme>
    </div>
  );

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 }}>
      <style>{PI_CSS}</style>
      <div><div className="pi-eyebrow">Evvel Yeni · Gelir</div><h1 style={{ fontSize: 30 }}>Para girişi gir</h1></div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Kasaya dışarıdan giren para buradan girilir. Şube satışı (kapanış) şube panelinden, POS ertesi gün kendiliğinden girer.</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!L && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {L && (
        <div style={{ ...kart, padding: 16, display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {L.konular.map((k) => <Dugme key={k.kod} kucuk ana={f.konu === k.kod} onClick={() => setF({ ...BOS(k.kod), is_gunu: f.is_gunu })}>{k.ad}</Dugme>)}
          </div>
          {konu && <div style={{ fontSize: 12.5, color: R.not }}>{konu.ipucu}{konu.gelir === true ? ' · gelir sayılır' : konu.gelir === false ? ' · gelir sayılmaz' : ''}</div>}

          {f.konu === 'kira' && (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Etiket ad="Ev"><select value={f.mulk_id} style={alan} onChange={(e) => setF((x) => ({ ...x, mulk_id: e.target.value, ay: '' }))}>
                <option value="">Ev seç…</option>{evler.map((e) => <option key={e.id} value={e.id}>{e.ad}{e.kiraci ? ` · ${e.kiraci}` : ''}</option>)}</select></Etiket>
              <Etiket ad="Hangi ayın kirası" ipucu={ev && ev.acik_aylar.length > 1 ? `${ev.acik_aylar.length} ay açık — seç` : null}>
                {ev && ev.acik_aylar.length
                  ? <select value={f.ay} style={alan} onChange={(e) => set('ay', e.target.value)}><option value="">Ay seç…</option>
                      {ev.acik_aylar.map((a) => <option key={a.ay} value={a.ay}>{ayAd(a.ay)} · kalan {a.kalan.toLocaleString('tr-TR')} ₺</option>)}</select>
                  : <input type="month" value={f.ay} style={alan} onChange={(e) => set('ay', e.target.value)} />}
              </Etiket>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Etiket ad="Bankaya (Fatma'nın kira hesabı)"><input style={alan} inputMode="decimal" placeholder="₺" value={f.havale} onChange={(e) => set('havale', e.target.value)} /></Etiket>
              <Etiket ad="Elden (Fatma'nın elindeki kira)"><input style={alan} inputMode="decimal" placeholder="₺" value={f.elden} onChange={(e) => set('elden', e.target.value)} /></Etiket>
            </div>
            {ev && f.ay && (() => {   // eski Mülk penceresinin bilgisi: bekleyen · yazılan toplam · fazla (çift yazma görünsün)
              const h = ev.acik_aylar.find((a) => a.ay === f.ay);
              if (!h) return null;   // açık aylar listesinde olmayan ay (ör. peşin kira) — "bekleyen 0" yanıltmasın
              const kalan = h.kalan || 0;
              const top = sayi(f.havale) + sayi(f.elden); const fz = top - kalan;
              return <div style={{ fontSize: 12.5, color: fz > 0.5 ? R.amber : R.not }}>Bekleyen <b>{kalan.toLocaleString('tr-TR')}</b> ₺ · yazılan toplam <b>{top.toLocaleString('tr-TR')}</b> ₺{fz > 0.5 ? ` · ${fz.toLocaleString('tr-TR')} ₺ fazla` : ''}</div>;
            })()}
            {ev && f.ay && bagsiz.length > 0 && izinVar('mulk.islem') && (
              <div style={{ borderTop: '1px solid var(--pi-line)', paddingTop: 8, display: 'grid', gap: 4, fontSize: 13 }}>
                <div style={{ color: R.metin2 }}>Bu kira Kasa'ya daha önce girildiyse yenisini yazma — o girişi bu eve <b>bağla</b> (para iki kez girmesin):</div>
                {bagsiz.slice(-8).reverse().map((g) => (
                  <div key={g.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{g.gun} · <b>{Number(g.tutar).toLocaleString('tr-TR')}</b> ₺{g.kimden ? ` · ${g.kimden}` : ''}</span>
                    <Dugme kucuk disabled={mesgul} onClick={() => bagla(g)}>Bunu bağla</Dugme>
                  </div>
                ))}
              </div>
            )}
          </>)}

          {f.konu === 'online' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Etiket ad="Hangi şubenin bankasına"><select value={f.banka} style={alan} onChange={(e) => set('banka', e.target.value)}>
                <option value="">Banka seç…</option>{bankalar.map((c) => <option key={c.id} value={c.id}>{c.ad}</option>)}</select></Etiket>
              <Etiket ad="Yatan net (₺)"><input style={alan} inputMode="decimal" value={f.parcalar[0]?.tutar || ''} onChange={(e) => set('parcalar', [{ cep: '', tutar: e.target.value }])} /></Etiket>
              <Etiket ad="Brüt satış (₺)" ipucu="bilmiyorsan boş bırak"><input style={alan} inputMode="decimal" value={f.brut} onChange={(e) => set('brut', e.target.value)} /></Etiket>
              {f.banka && (() => {   // eski "Online yattı" penceresindeki bilgi: bu bankanın şubesinde bankaya gelecek online
                const x = (L.online_bekleyen || []).find((o) => o.banka_cep === f.banka);
                return (
                  <div style={{ gridColumn: '1 / -1', padding: '8px 12px', borderRadius: 9, fontSize: 12.5, background: 'var(--pi-bg)', color: R.metin2 }}>
                    {x ? <>{x.sube} online: bankaya gelecek <b>{x.bekleyen_brut.toLocaleString('tr-TR')}</b> ₺ brüt{x.oran ? <> · %{x.oran} komisyonla beklenen net ≈ <b>{x.beklenen_net.toLocaleString('tr-TR')}</b> ₺</> : null}{x.en_eski_gun ? ` · en eskisi ${x.gun_sayisi} gün önce` : ''}</>
                      : 'Bu bankanın şubesinde bekleyen online satış yok.'}
                  </div>
                );
              })()}
            </div>
          )}

          {f.konu === 'kredi' && (
            <Etiket ad="Hangi kredi" ipucu={krediler.length ? null : 'listede yok — önce Krediler › + Kredi ekle'}>
              <select value={f.kredi_id} style={alan} onChange={(e) => set('kredi_id', e.target.value)}><option value="">Kredi seç…</option>
                {krediler.map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}</select>
            </Etiket>
          )}
          {f.konu === 'borc' && <Etiket ad="Kimden" ipucu="geri ödenecek"><input style={alan} value={f.kimden} onChange={(e) => set('kimden', e.target.value)} placeholder="ör. Ali Bey" /></Etiket>}
          {f.konu === 'destek' && (
            <Etiket ad="Desteği koyan patron"><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(L.patronlar || []).map((p) => <Dugme key={p} kucuk ana={f.kimden === p} onClick={() => set('kimden', p)}>{p}</Dugme>)}</div></Etiket>
          )}
          {f.konu === 'satis' && (
            <Etiket ad="Hangi şubenin"><select value={f.sube_id} style={alan} onChange={(e) => set('sube_id', e.target.value)}><option value="">Şube seç…</option>
              {(L.subeler || []).map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}</select></Etiket>
          )}
          {f.konu === 'diger' && (
            <Etiket ad="Gelir mi?"><div style={{ display: 'flex', gap: 6 }}>
              <Dugme kucuk ana={f.gelir === true} onClick={() => set('gelir', true)}>Evet, gelir</Dugme>
              <Dugme kucuk ana={f.gelir === false} onClick={() => set('gelir', false)}>Hayır (geri verilecek / emanet vb.)</Dugme></div></Etiket>
          )}

          {f.konu && !['kira', 'online'].includes(f.konu) && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12.5, color: R.metin2 }}>Nereye girdi</span>
              {f.parcalar.map((p, n) => parcaSatiri(p, n, normalCepler))}
              <div><Dugme kucuk onClick={() => set('parcalar', [...f.parcalar, { cep: '', tutar: '' }])}>+ Başka cebe de girdi (böl)</Dugme></div>
            </div>
          )}

          {f.konu && (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Etiket ad="Ne zaman girdi"><input type="date" value={f.is_gunu} max={bugun()} style={alan} onChange={(e) => set('is_gunu', e.target.value)} /></Etiket>
              <Etiket ad={f.konu === 'diger' ? 'Ne olduğu (en az 10 harf)' : 'Not'}><input style={alan} value={f.not} onChange={(e) => set('not', e.target.value)} /></Etiket>
            </div>
            {izinVar('gelir.giris.islem|kasa.islem')   /* Fable L6-2: yalnız görme izni olana kaydet düğmesi yok (sunucu da 403) */
              ? <div><Dugme ana disabled={mesgul} onClick={() => kaydet(false)}>{mesgul ? 'Kaydediliyor…' : 'Girişi kaydet'}</Dugme></div>
              : <div style={{ fontSize: 12.5, color: R.not }}>Para girişi kaydetme iznin yok — merkeze sor</div>}
          </>)}
        </div>
      )}
    </div>
  );
}
