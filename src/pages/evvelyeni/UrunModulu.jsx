// 📚 ÜRÜN KATALOĞU — tak-çıkar modül (sunucu: evvel_yeni_urun_api.py). Sayfası Tanımlar altında.
// Sahip (2026-10-17): "Katalog örüntüsü ile depo örüntüsü aynı mantıkta; yeni Evvel'in altyapısını yok sayma." Tek ürün kimliği,
// her değişiklik izli; tek sayım birimi (adet), koli = giriş yardımcısı ("1 koli kaç adet"). Fiyat burada değil (Ürün fiyatları).
import React, { useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip } from './KasaModulu';

export const URUN_SAYFALAR = [{ id: 'urunler', ad: 'Ürünler', alt: 'Katalog · birim · koli · KDV' }];
const alan = { padding: '8px 10px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14, minWidth: 0, width: '100%' };
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
  const yukle = () => api('/evvel-yeni/urun/katalog?hepsi=true').then((d) => { setV(d); setHata(''); if (!kat && d.kategoriler[0]) setKat(d.kategoriler[0].id); })
    .catch((e) => setHata(e?.message || 'Katalog okunamadı'));
  useEffect(() => { yukle(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const kaydet = async () => {
    if (mesgul) return;
    setMesgul(true);
    try {
      const govde = { ad: form.ad, kategori_id: form.kategori_id, birim: 'adet', koli_ici: form.koliyle && form.koli_ici ? Number(form.koli_ici) : null,
        kdv_oran: form.kdv_oran === '' ? null : Number(form.kdv_oran), aktif: form.aktif };
      const r = await api(form.id ? `/evvel-yeni/urun/${form.id}` : '/evvel-yeni/urun', { method: 'POST', body: govde });
      onToast?.(r.mesaj); setForm(null); yukle();
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
        <Dugme kucuk ana disabled={!v} onClick={() => setForm({ ad: '', kategori_id: kat || v?.kategoriler[0]?.id || '', koliyle: false, koli_ici: '', kdv_oran: '0.10', aktif: true })}>+ Ürün ekle</Dugme>
      </div>
      <div style={{ fontSize: 13, color: R.metin2 }}>Her ürün <b>adetle</b> sayılır. Koliyle geliyorsa "1 koli kaç adet" yazılır; siparişte ve teslimde "2 koli + 3" yazılınca sistem adede çevirir. Fiyatlar burada değil, Toptancılar › Ürün fiyatları'nda.</div>
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
              <span style={{ width: 120, color: R.metin2 }}>{u.koli_ici ? <>koli = <b style={num}>{u.koli_ici}</b> adet</> : 'adet'}</span>
              <span style={{ width: 70, color: R.metin2 }}>{u.kdv_oran != null ? `KDV %${Math.round(u.kdv_oran * 100)}` : '—'}</span>
              {!u.aktif ? <Cip>pasif</Cip> : !u.birim_teyit ? <Cip tur="sari">birim teyit edilmedi</Cip> : <Cip tur="yesil">teyitli</Cip>}
              <Dugme kucuk onClick={() => setForm({ id: u.id, ad: u.ad, kategori_id: u.kategori_id, koliyle: !!u.koli_ici, koli_ici: u.koli_ici ? String(u.koli_ici) : '', kdv_oran: u.kdv_oran != null ? String(u.kdv_oran) : '', aktif: u.aktif, teyit: u.birim_teyit })}>Düzelt</Dugme>
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
            <div style={{ fontSize: 13 }}>Nasıl sayılır? <b>Adet</b></div>
            <label style={{ fontSize: 13 }}><input type="checkbox" checked={form.koliyle} onChange={(e) => setForm((f) => ({ ...f, koliyle: e.target.checked }))} /> Koliyle gelir</label>
            {form.koliyle && <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>1 koli kaç adet?<input style={alan} inputMode="numeric" value={form.koli_ici} onChange={(e) => setForm((f) => ({ ...f, koli_ici: e.target.value.replace(/\D/g, '') }))} /></label>}
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>KDV<select style={alan} value={form.kdv_oran} onChange={(e) => setForm((f) => ({ ...f, kdv_oran: e.target.value }))}>
              {KDVLER.map(([d, a]) => <option key={d} value={d}>{a}</option>)}</select></label>
            {form.id && <label style={{ fontSize: 13 }}><input type="checkbox" checked={!form.aktif} onChange={(e) => setForm((f) => ({ ...f, aktif: !e.target.checked }))} /> Artık kullanılmıyor (pasif — geçmişi korunur)</label>}
            {form.id && !form.teyit && <div style={{ fontSize: 12.5, color: R.amber }}>Kaydedince bu ürünün birimi ve koli bilgisi "teyitli" olur.</div>}
            <div><Dugme ana disabled={mesgul || !form.ad.trim() || (form.koliyle && Number(form.koli_ici) < 2)} onClick={kaydet}>Kaydet</Dugme></div>
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
