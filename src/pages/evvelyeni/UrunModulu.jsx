// 📚 ÜRÜN KATALOĞU — tak-çıkar modül (sunucu: evvel_yeni_urun_api.py). Sayfası Tanımlar altında.
// Sahip (2026-10-18): katalog SIFIRDAN — eski sisteme bağ yok (eski kimlik / kod / geri yazma yok). Tek ürün kimliği,
// her değişiklik izli; tek sayım birimi (adet), koli = giriş yardımcısı ("1 koli kaç adet"). Fiyat burada değil (Ürün fiyatları).
import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { ALAN, Cip, Dugme, kart, num, PI_CSS, R } from './KasaModulu';

export const URUN_SAYFALAR = [{ id: 'urunler', ad: 'Ürünler', alt: 'Katalog · birim · koli · KDV' }];
const alan = { ...ALAN, minWidth: 0, width: '100%' };   // temel stil KasaModulu ALAN (T4-15)
const KDVLER = [['', '—'], ['0.01', '%1'], ['0.10', '%10'], ['0.20', '%20']];

export default function UrunModulu({ onToast }) {
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [kat, setKat] = useState('');
  const [ara, setAra] = useState('');
  const [yalnizBelirsiz, setYalnizBelirsiz] = useState(false);
  const [form, setForm] = useState(null);
  const [iz, setIz] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [katForm, setKatForm] = useState(null);
  const yukle = () => api('/evvel-yeni/urun/katalog?hepsi=true').then((d) => { setV(d); setHata(''); setKat((k) => k || d.kategoriler.find((x) => x.id)?.id || ''); })
    .catch((e) => setHata(e?.message || 'Katalog okunamadı'));
  useEffect(() => { yukle(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true);
    try {
      const farkli = form.fatura_birim && form.fatura_birim !== form.birim;
      const govde = { ad: form.ad, kategori_id: form.kategori_id, birim: form.birim, koli_ici: form.koliyle && form.koli_ici ? Number(form.koli_ici) : null,
        kdv_oran: form.kdv_oran === '' ? null : Number(form.kdv_oran), aktif: form.aktif,
        fatura_birim: farkli ? form.fatura_birim : null,
        sayim_ici: farkli && form.fatura_birim !== 'koli' && form.yon === 'sayim' && form.cevrim ? Number(form.cevrim) : null,
        fatura_ici: farkli && form.fatura_birim !== 'koli' && form.yon === 'fatura' && form.cevrim ? Number(form.cevrim) : null,
        takip: form.takip || 'sayim', panel_sayim: !!form.panel_sayim };
      const r = await api(form.id ? `/evvel-yeni/urun/${form.id}` : '/evvel-yeni/urun', { method: 'POST', body: govde });
      onToast?.(r.mesaj); setForm(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const katKaydet = async () => {
    if (mesgul) return;
    setMesgul(true);
    try {
      const r = await api('/evvel-yeni/urun/kategori', { method: 'POST', body: { ad: katForm.ad, emoji: katForm.emoji || null } });
      onToast?.(r.mesaj); setKatForm(null); setKat(r.id); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
    setMesgul(false);
  };
  const izAc = (u) => api(`/evvel-yeni/urun/${u.id}/iz`).then((d) => setIz({ u, satir: d.iz })).catch(() => {});

  const tum = (v?.kategoriler || []).flatMap((k) => k.urunler.map((u) => ({ ...u, kategori_id: k.id, kategori: k.ad })));
  const liste = (ara || yalnizBelirsiz ? tum : (v?.kategoriler.find((k) => k.id === kat)?.urunler || []).map((u) => ({ ...u, kategori_id: kat })))
    .filter((u) => (!ara || u.ad.toLocaleLowerCase('tr').includes(ara.toLocaleLowerCase('tr'))) && (!yalnizBelirsiz || (u.aktif && !u.birim_teyit)));
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Tanımlar</div><h1 style={{ fontSize: 30 }}>Ürünler</h1></div>
        <Dugme kucuk ana disabled={!v} onClick={() => setForm({ ad: '', kategori_id: (kat && kat !== '' ? kat : '') || v?.kategoriler.find((k) => k.id)?.id || '', koliyle: false, koli_ici: '', kdv_oran: '0.10', aktif: true, birim: 'adet', fatura_birim: 'adet', yon: 'sayim', cevrim: '', takip: 'sayim' })}>+ Ürün ekle</Dugme>
        <Dugme kucuk disabled={!v} onClick={() => setKatForm({ ad: '', emoji: '' })}>+ Kategori</Dugme>
      </div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Her ürün <b>personelin saydığı birimle</b> (adet, paket, kutu…) tutulur. Koliyle geliyorsa "1 koli kaç paket/adet" yazılır. Faturada başka birimle geliyorsa (ör. peçete faturada tek tek, biz paket sayıyoruz) çevrim yazılır; maliyet ona göre hesaplanır. Fiyatlar burada değil.</div>
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Hazırlanıyor…</div>}
      {v && (<>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {v.kategoriler.map((k) => <Dugme key={k.id} kucuk ana={!ara && !yalnizBelirsiz && kat === k.id} onClick={() => { setKat(k.id); setAra(''); setYalnizBelirsiz(false); }}>{k.emoji ? `${k.emoji} ` : ''}{k.ad} ({k.urunler.length})</Dugme>)}
          <input value={ara} onChange={(e) => setAra(e.target.value)} placeholder="Ürün ara…" style={{ ...alan, width: 180, padding: '6px 9px' }} />
          {v.birim_belirsiz > 0 && <Dugme kucuk ana={yalnizBelirsiz} onClick={() => setYalnizBelirsiz((x) => !x)}>Birimi teyit edilmemiş ({v.birim_belirsiz})</Dugme>}
        </div>
        <div style={{ ...kart, padding: '6px 14px', display: 'grid', gap: 0 }}>
          {liste.length === 0 && <div style={{ color: R.not, padding: 8 }}>Ürün yok.</div>}
          {liste.map((u) => (
            <div key={u.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${R.cizgi}`, padding: '7px 0', fontSize: 13.5, opacity: u.aktif ? 1 : 0.5 }}>
              <span style={{ flex: '1 1 220px', minWidth: 0 }}><b>{u.ad}</b>{(ara || yalnizBelirsiz) && <span style={{ color: R.not }}> · {u.kategori}</span>}</span>
              <span style={{ flex: '0 1 300px', minWidth: 160, color: R.metin2 }}><b>{u.birim}</b>{u.koli_ici ? <> · koli = <b style={num}>{u.koli_ici}</b> {u.birim}</> : ''}
                {u.sayim_ici ? <> · 1 {u.birim} = {u.sayim_ici} {u.fatura_birim}</> : u.fatura_ici && u.fatura_birim !== 'koli' ? <> · faturada 1 {u.fatura_birim} = {u.fatura_ici} {u.birim}</> : u.fatura_birim === 'koli' && u.fatura_birim !== u.birim ? ' · faturada koli' : ''}</span>
              {u.takip === 'acilinca' && <Cip>sayılmaz · açılınca gider</Cip>}
              {u.takip === 'gununde' && <Cip>🍰 gününde tüketilir</Cip>}
              {u.panel_sayim && <Cip tur="yesil">açılış / kapanışta sayılır</Cip>}
              <span style={{ width: 70, color: R.metin2 }}>{u.kdv_oran != null ? `KDV %${Math.round(u.kdv_oran * 100)}` : '—'}</span>
              {!u.aktif ? <Cip>pasif</Cip> : !u.birim_teyit ? <Cip tur="sari">birim teyit edilmedi</Cip> : <Cip tur="yesil">teyitli</Cip>}
              <Dugme kucuk onClick={() => setForm({ id: u.id, ad: u.ad, kategori_id: u.kategori_id, koliyle: !!u.koli_ici, koli_ici: u.koli_ici ? String(u.koli_ici) : '', kdv_oran: u.kdv_oran != null ? Number(u.kdv_oran).toFixed(2) : '', aktif: u.aktif, teyit: u.birim_teyit,
                birim: u.birim || 'adet', fatura_birim: u.fatura_birim || u.birim || 'adet', yon: u.fatura_ici ? 'fatura' : 'sayim', cevrim: String(u.sayim_ici || u.fatura_ici || ''), takip: u.takip || 'sayim', panel_sayim: !!u.panel_sayim })}>Düzelt</Dugme>
              <Dugme kucuk onClick={() => izAc(u)}>İz</Dugme>
            </div>
          ))}
        </div>
      </>)}
      {form && (
        <div onClick={() => setForm(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...kart, padding: 18, width: 'min(460px, 100%)', display: 'grid', gap: 10 }}>
            <b style={{ fontSize: 17 }}>{form.id ? 'Ürünü düzelt' : 'Yeni ürün'}</b>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Adı<input style={alan} value={form.ad} onChange={(e) => setForm((f) => ({ ...f, ad: e.target.value }))} /></label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Kategori<select style={alan} value={form.kategori_id} onChange={(e) => setForm((f) => ({ ...f, kategori_id: e.target.value }))}>
              {v.kategoriler.filter((k) => k.id).map((k) => <option key={k.id} value={k.id}>{k.ad}</option>)}</select></label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Personel nasıl sayar?<select style={alan} value={form.birim} onChange={(e) => setForm((f) => ({ ...f, birim: e.target.value, fatura_birim: f.fatura_birim === f.birim ? e.target.value : f.fatura_birim }))}>
              {(v.birimler || ['adet']).map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={form.koliyle} onChange={(e) => setForm((f) => ({ ...f, koliyle: e.target.checked }))} /> Koliyle gelir</label>
            {form.koliyle && <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>1 koli kaç {form.birim}?<input style={alan} inputMode="numeric" value={form.koli_ici} onChange={(e) => setForm((f) => ({ ...f, koli_ici: e.target.value.replace(/\D/g, '') }))} /></label>}
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Faturada nasıl geliyor?<select style={alan} value={form.fatura_birim} onChange={(e) => setForm((f) => ({ ...f, fatura_birim: e.target.value }))}>
              {(v.fatura_birimleri || ['adet']).map((b) => <option key={b} value={b}>{b}{b === form.birim ? ' (sayımla aynı)' : ''}</option>)}</select></label>
            {form.fatura_birim === 'koli' && form.fatura_birim !== form.birim && <div style={{ fontSize: 12.5, color: R.metin2 }}>Faturada koli: çevrim yukarıdaki "1 koli kaç {form.birim}" bilgisinden alınır{form.koliyle ? '' : ' — "Koliyle gelir"i işaretle'}.</div>}
            {form.fatura_birim !== form.birim && form.fatura_birim !== 'koli' && (
              <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                <label><input type="radio" checked={form.yon === 'sayim'} onChange={() => setForm((f) => ({ ...f, yon: 'sayim' }))} /> 1 {form.birim} içinde kaç {form.fatura_birim} var</label>
                <label><input type="radio" checked={form.yon === 'fatura'} onChange={() => setForm((f) => ({ ...f, yon: 'fatura' }))} /> 1 {form.fatura_birim} içinde kaç {form.birim} var</label>
                <input style={alan} inputMode="numeric" placeholder="sayı" value={form.cevrim} onChange={(e) => setForm((f) => ({ ...f, cevrim: e.target.value.replace(/\D/g, '') }))} />
              </div>
            )}
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Nasıl takip edilir?<select style={alan} value={form.takip} onChange={(e) => setForm((f) => ({ ...f, takip: e.target.value }))}>
              <option value="sayim">Sayılır</option>
              <option value="acilinca">Sayılmaz — gideri ürün açılınca yazılır</option>
              <option value="gununde">Gününde tüketilir (pasta) — şubeye girdiği an gider</option></select></label>
            {form.takip === 'sayim' && <label style={{ fontSize: 13 }}><input type="checkbox" checked={!!form.panel_sayim} onChange={(e) => setForm((f) => ({ ...f, panel_sayim: e.target.checked }))} /> Şube açılış / kapanışında sayılır (panel listesi)</label>}
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>KDV<select style={alan} value={form.kdv_oran} onChange={(e) => setForm((f) => ({ ...f, kdv_oran: e.target.value }))}>
              {KDVLER.map(([d, a]) => <option key={d} value={d}>{a}</option>)}</select></label>
            {form.id && <label style={{ fontSize: 13 }}><input type="checkbox" checked={!form.aktif} onChange={(e) => setForm((f) => ({ ...f, aktif: !e.target.checked }))} /> Artık kullanılmıyor (pasif — geçmişi korunur)</label>}
            {form.id && !form.teyit && <div style={{ fontSize: 12.5, color: R.amber }}>Kaydedince bu ürünün birimi ve koli bilgisi "teyitli" olur.</div>}
            <div><Dugme ana disabled={mesgul || !form.ad.trim() || (form.koliyle && Number(form.koli_ici) < 2) || (form.fatura_birim !== form.birim && (form.fatura_birim === 'koli' ? !(form.koliyle && Number(form.koli_ici) >= 2) : Number(form.cevrim) < 2))} onClick={kaydet}>Kaydet</Dugme></div>
          </div>
        </div>
      )}
      {katForm && (
        <div onClick={() => setKatForm(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...kart, padding: 18, width: 'min(380px, 100%)', display: 'grid', gap: 10 }}>
            <b style={{ fontSize: 17 }}>Yeni kategori</b>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Adı<input style={alan} value={katForm.ad} onChange={(e) => setKatForm((f) => ({ ...f, ad: e.target.value }))} /></label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>Simge (isteğe bağlı)<input style={alan} value={katForm.emoji} maxLength={4} onChange={(e) => setKatForm((f) => ({ ...f, emoji: e.target.value }))} /></label>
            <div><Dugme ana disabled={mesgul || katForm.ad.trim().length < 2} onClick={katKaydet}>Kaydet</Dugme></div>
          </div>
        </div>
      )}
      {iz && (
        <div onClick={() => setIz(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...kart, padding: 18, width: 'min(520px, 100%)', display: 'grid', gap: 6, maxHeight: '80vh', overflow: 'auto' }}>
            <b style={{ fontSize: 16 }}>📜 {iz.u.ad} — değişiklik izi</b>
            {iz.satir.map((x, i) => <div key={i} style={{ fontSize: 13, borderTop: `1px solid ${R.cizgi}`, paddingTop: 4 }}>{x.zaman} · <b>{x.alan}</b>: {x.eski ?? '—'} → {x.yeni ?? '—'} <span style={{ color: R.not }}>· {x.kim}</span></div>)}
            <div style={{ textAlign: 'right' }}><Dugme kucuk onClick={() => setIz(null)}>Kapat</Dugme></div>
          </div>
        </div>
      )}
    </div>
  );
}
