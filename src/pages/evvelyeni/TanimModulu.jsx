// ─────────────────────────────────────────────────────────────────────────────
// ⚙️ EVVEL YENİ · TANIMLAR — şube · personel · banka · kart · toptancı ekle / düzelt
//
// Sahip (2026-10-16): "Eski sistem tamamen kaldırılacak; ekleme buraya yazılsın." · "Personel
// eklerken maaş/yemek bilgisi de girilsin." Hiçbir şey SİLİNMEZ — pasif yapılır.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../utils/api';
import { PI_CSS, R, kart, num, Dugme, Cip, fmt } from './KasaModulu';

export const TANIM_SAYFALAR = [
  { id: 'tanim_sube', ad: 'Şubeler', alt: 'Ekle · komisyon oranı' },
  { id: 'tanim_personel', ad: 'Personel', alt: 'Ekle · maaş · yemek' },
  { id: 'tanim_banka', ad: 'Bankalar', alt: 'Hesap ekle' },
  { id: 'tanim_kart', ad: 'Kartlar', alt: 'Kart ekle · açılış borcu' },
  { id: 'tanim_toptanci', ad: 'Toptancılar', alt: 'Ekle · açılış bakiyesi' },
];

const alan = { width: '100%', padding: '9px 11px', borderRadius: 10, border: '1px solid var(--pi-line)', background: 'var(--pi-bg)', color: 'var(--pi-ink)', font: 'inherit', fontSize: 14.5, minWidth: 0 };
const sayi = (x) => { const t = String(x ?? '').trim().replace(/\s/g, ''); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t); return Number.isFinite(n) ? n : NaN; };

// Her tanımın alanları — tek bileşen hepsini çizer
const YAPI = {
  tanim_sube: {
    tur: 'sube', liste: 'subeler', baslik: 'Şubeler', tekil: 'şube',
    not: 'Şube eklenince Kasa\'da "dükkân nakdi" ve "bankası" cepleri kendiliğinden açılır.',
    alanlar: [{ k: 'ad', ad: 'Şube adı', zorunlu: true }, { k: 'pos_oran', ad: 'POS komisyonu %', sayi: true }, { k: 'online_oran', ad: 'Online komisyonu %', sayi: true },
      { k: 'kira', ad: 'Aylık kira ₺', sayi: true }, { k: 'kira_ay', ad: 'Kira hangi aydan geçerli', tip: 'month' },
      { k: 'kira_odeme_gunu', ad: 'Kira ödeme günü (1–31)', sayi: true }, { k: 'kira_artis_ayi', ad: 'Kira artış ayı (1–12, ör. 6 = Haziran)', sayi: true },
      { k: 'kira_yok', ad: 'Kira yok — mülk bizim', secim: 'evet_hayir' }],
    kolon: (x) => [x.ad, `POS %${fmt(x.pos_oran)} · online %${fmt(x.online_oran)}`,
      x.kira_yok ? 'mülk bizim — kira yok' : x.kira != null ? `kira ${fmt(x.kira)} ₺${x.kira_odeme_gunu ? ` · her ayın ${x.kira_odeme_gunu}'i` : ''}${x.kira_artis_ayi ? ` · artış ${['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'][x.kira_artis_ayi - 1]}` : ''}` : 'kira tanımsız'],
  },
  tanim_personel: {
    tur: 'personel', liste: 'personel', baslik: 'Personel', tekil: 'personel',
    not: 'Maaş ve yemek ücreti Ödeme formunda kendiliğinden kullanılır. Değişiklik "hangi aydan itibaren" geçerli olur — eski aylar bozulmaz.',
    alanlar: [{ k: 'ad', ad: 'Ad soyad', zorunlu: true }, { k: 'sube_id', ad: 'Şube', secim: 'sube' }, { k: 'gorev', ad: 'Görev' },
      { k: 'calisma_turu', ad: 'Çalışma türü', secim: 'calisma' }, { k: 'giris', ad: 'İşe giriş', tip: 'date' }, { k: 'cikis', ad: 'Ayrılış (varsa)', tip: 'date' },
      { k: 'maas', ad: 'Aylık maaş ₺ (tam zamanlı)', sayi: true, zorunluYeni: true }, { k: 'saatlik', ad: 'Saatlik ücret ₺ (yarı zamanlı)', sayi: true },
      { k: 'yemek', ad: 'Aylık yemek ₺', sayi: true }, { k: 'yol', ad: 'Aylık yol ₺', sayi: true },
      { k: 'ucret_ay', ad: 'Ücret hangi aydan itibaren', tip: 'month', duzeltmede: true },
      // B7: müdür AYRI işaret değil — görev "MÜDÜR" yazılınca maaş her durumda tam (Maaş + Yoklama aynı kuralı okur)
      { k: 'erken_acilis', ad: 'Erken açılış izni (07:00 öncesi)', secim: 'erken' },
      // Panel PIN'i: sık işlemlerde (ürün aç, fire, ara teslim…) ad + PIN. Boş bırakılırsa değişmez; PIN ekrana asla geri gelmez.
      { k: 'pin', ad: 'Panel PIN (4 hane) — değiştirmek için yaz', tip: 'password' },
      { k: 'yetki_geri_alma', ad: 'Hatalı teslimi geri alabilir (yetki)', secim: 'evet_yetki' }],
    kolon: (x) => [x.ad, `${x.sube_ad}${x.gorev ? ` · ${x.gorev}` : ''} · ${x.calisma_turu === 'yari' ? 'yarı zamanlı' : 'tam zamanlı'}${x.cikis ? ` · ayrıldı ${x.cikis}` : ''}${x.erken_acilis ? ' · erken açılış izni' : ''}${x.pin_var ? '' : ' · PIN yok'}${x.yetki_geri_alma ? ' · geri alma yetkisi' : ''}`,
      x.calisma_turu === 'yari' ? `saatlik ${fmt(x.saatlik)} · yemek ${fmt(x.yemek)}` : `maaş ${fmt(x.maas)} · yemek ${fmt(x.yemek)}${x.yol ? ` · yol ${fmt(x.yol)}` : ''}`, x.ucret_eski ? <Cip tur="sari">ücret eski sistemden — kontrol et</Cip> : null],
  },
  tanim_banka: {
    tur: 'banka', liste: 'bankalar', baslik: 'Bankalar', tekil: 'banka hesabı',
    not: 'Şubelerin bankası şube eklenince kendiliğinden açılır. Buradan patron hesapları ya da ek hesaplar eklenir. "Geçiş hesabı" = Fethi hesabı gibi para toplanıp dağıtılan hesap.',
    alanlar: [{ k: 'ad', ad: 'Hesap adı (ör. Ziraat Onur)', zorunlu: true }, { k: 'tur', ad: 'Türü', secim: 'banka_tur', yalnizYeni: true }, { k: 'sube_id', ad: 'Şubenin mi? (boş = patron)', secim: 'sube', yalnizYeni: true }],
    kolon: (x) => [x.ad, x.tur === 'hesap' ? 'geçiş hesabı' : x.sube_ad ? `${x.sube_ad} şubesi` : 'patron / ortak'],
  },
  tanim_kart: {
    tur: 'kart', liste: 'kartlar', baslik: 'Kartlar', tekil: 'kart',
    not: 'Kartın bankadaki kullanılabilir limiti Kartlar bölümünden teyit edilir. Aynı limiti paylaşan kartlara aynı "ortak limit" adını yaz.',
    alanlar: [{ k: 'ad', ad: 'Kart adı (ör. Garanti Onur 3018)', zorunlu: true }, { k: 'banka', ad: 'Banka' }, { k: 'kimin', ad: 'Kimin kartı' },
      { k: 'limit_tutar', ad: 'Kart limiti ₺', sayi: true }, { k: 'kesim_gunu', ad: 'Hesap kesim günü (1–31)', sayi: true }, { k: 'son_odeme_gunu', ad: 'Son ödeme günü (1–31)', sayi: true },
      { k: 'limit_grup', ad: 'Ortak limit adı (varsa)' }],
    kolon: (x) => [x.ad, [x.banka, x.kimin].filter(Boolean).join(' · ') || '—', `limit ${x.limit_tutar != null ? fmt(x.limit_tutar) : '—'} · kesim ${x.kesim_gunu || '—'} · son ödeme ${x.son_odeme_gunu || '—'}${x.limit_grup ? ` · ortak: ${x.limit_grup}` : ''}`],
  },
  tanim_toptanci: {
    tur: 'toptanci', liste: 'toptancilar', baslik: 'Toptancılar', tekil: 'toptancı',
    not: 'Açılış bakiyesi: yeni dönem başında bu toptancıya olan borç. Toptancı bakiyesi bundan başlar.',
    alanlar: [{ k: 'ad', ad: 'Toptancı adı', zorunlu: true }, { k: 'kategori', ad: 'Ne satıyor' }, { k: 'telefon', ad: 'Telefon' }, { k: 'acilis_bakiye', ad: 'Açılış borcumuz ₺', sayi: true },
      { k: 'vade_gun', ad: 'Vade (teslimden kaç gün sonra ödenir)', sayi: true }],
    kolon: (x) => [x.ad, x.kategori || '—', `açılış ${fmt(x.acilis_bakiye)} · vade ${x.vade_gun != null ? `${x.vade_gun} gün` : 'tanımsız'}`],
  },
};

export default function TanimModulu({ gorunum, onToast }) {
  const y = YAPI[gorunum] || YAPI.tanim_sube;
  const [v, setV] = useState(null);
  const [hata, setHata] = useState('');
  const [form, setForm] = useState(null);   // {id?: düzeltme, ...alanlar}
  const [mesgul, setMesgul] = useState(false);
  const [pasifGoster, setPasifGoster] = useState(false);
  const yukle = useCallback(() => api('/evvel-yeni/tanim/liste').then((r) => { setV(r); setHata(''); }).catch((e) => setHata(e?.message || 'okunamadı')), []);
  useEffect(() => { yukle(); }, [yukle]);
  useEffect(() => { setForm(null); }, [gorunum]);

  if (!v) return <div className="pi"><style>{PI_CSS}</style><div style={{ color: hata ? R.kirmizi : R.not }}>{hata || 'Tanımlar okunuyor…'}</div></div>;

  const satirlar = (v[y.liste] || []).filter((x) => pasifGoster || x.aktif !== false);
  const pasifSay = (v[y.liste] || []).filter((x) => x.aktif === false).length;
  const yeni = form && !form.id;
  const secimler = {
    sube: [{ id: '', ad: y.tur === 'banka' ? '— patron / ortak —' : 'Ortak (şubesiz)' }, ...v.subeler.filter((s) => s.aktif).map((s) => ({ id: s.id, ad: s.ad }))],
    banka_tur: [{ id: 'banka', ad: 'Banka hesabı' }, { id: 'hesap', ad: 'Geçiş hesabı (para toplanıp dağıtılan)' }],
    evet_hayir: [{ id: '', ad: '— değiştirme —' }, { id: '0', ad: 'Hayır (kira ödeniyor)' }, { id: '1', ad: 'Evet — mülk bizim' }],
    calisma: [{ id: 'tam', ad: 'Tam zamanlı (aylık maaş)' }, { id: 'yari', ad: 'Yarı zamanlı (saatlik)' }],
    erken: [{ id: '', ad: '— değiştirme —' }, { id: '0', ad: 'Yok (07:00\'dan önce açamaz)' }, { id: '1', ad: 'Var — 07:00 öncesi açabilir' }],
    evet_yetki: [{ id: '', ad: '— değiştirme —' }, { id: '0', ad: 'Yok' }, { id: '1', ad: 'Var' }],
  };

  const kaydet = async (ek = {}) => {
    setMesgul(true); setHata('');
    try {
      const body = { ...ek };
      for (const a of y.alanlar) {
        if (!(a.k in form) || (a.yalnizYeni && !yeni)) continue;
        if (a.sayi) { const n = sayi(form[a.k]); if (Number.isNaN(n)) throw new Error(`${a.ad}: sayı yaz`); if (n != null) body[a.k] = n; }
        else if (a.secim === 'sube') body[a.k] = form[a.k] || (yeni ? null : 'ortak');
        else if (a.secim === 'evet_hayir' || a.secim === 'erken' || a.secim === 'evet_yetki') body[a.k] = form[a.k] === '1' ? true : form[a.k] === '0' ? false : null;
        else body[a.k] = form[a.k] || null;
      }
      const r = await api(`/evvel-yeni/tanim/${y.tur}${form.id ? `/${encodeURIComponent(form.id)}` : ''}`, { method: 'POST', body });
      onToast?.(r.mesaj); setForm(null); yukle();
    } catch (e) { setHata(e?.message || 'Kaydedilemedi'); } finally { setMesgul(false); }
  };
  const aktiflik = async (x) => {
    const soru = y.tur === 'kart' ? `"${x.ad}" kartı silinsin mi?\nListelerden ve Kartlar ekranından kalkar; geçmiş ödemelerde adı kalır.` : `"${x.ad}" pasif yapılsın mı?\nSilinmez; listelerde çıkmaz, geçmiş kayıtlarda adı kalır.`;
    if (x.aktif && !window.confirm(soru)) return;
    try { const r = await api(`/evvel-yeni/tanim/${y.tur}/${encodeURIComponent(x.id)}`, { method: 'POST', body: { aktif: !x.aktif } }); onToast?.(x.aktif ? (y.tur === 'kart' ? 'Kart silindi' : 'Pasif yapıldı') : 'Yeniden aktif'); yukle(); void r; }
    catch (e) { onToast?.(e?.message || 'Olmadı'); }
  };
  const duzeltAc = (x) => {
    const f = { id: x.id };
    for (const a of y.alanlar) if (!a.yalnizYeni) f[a.k] = a.k === 'ucret_ay' ? v.ay : (x[a.k] ?? '') === null ? '' : String(x[a.k] ?? '');
    setForm(f);
  };

  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Tanımlar</div><h1 style={{ fontSize: 30 }}>{y.baslik}</h1></div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {pasifSay > 0 && <Dugme kucuk onClick={() => setPasifGoster((p) => !p)}>{pasifGoster ? 'Pasifleri gizle' : `Pasifler (${pasifSay})`}</Dugme>}
          {!yeni && <Dugme onClick={() => setForm({})}>+ {y.tekil[0].toUpperCase() + y.tekil.slice(1)} ekle</Dugme>}
        </div>
      </div>
      <div style={{ fontSize: 13, color: R.not }}>{y.not}</div>

      {form && (
        <div style={{ ...kart, padding: 16, display: 'flex', flexDirection: 'column', gap: 12, borderLeft: '5px solid var(--pi-accent)' }}>
          <b>{yeni ? `Yeni ${y.tekil}` : `Düzelt · ${(v[y.liste].find((x) => x.id === form.id) || {}).ad}`}</b>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {y.alanlar.filter((a) => !(a.yalnizYeni && !yeni) && !(a.duzeltmede && yeni)).map((a) => (
              <label key={a.k} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 600, color: R.metin2 }}>
                {a.ad}{(a.zorunlu || (a.zorunluYeni && yeni)) && ' *'}
                {a.secim ? (
                  <select style={alan} value={form[a.k] ?? (a.secim === 'banka_tur' ? '' : '')} onChange={(e) => setForm((f) => ({ ...f, [a.k]: e.target.value }))}>
                    {a.secim === 'banka_tur' && <option value="">Seç…</option>}
                    {secimler[a.secim].map((o) => <option key={o.id} value={o.id}>{o.ad}</option>)}
                  </select>
                ) : (
                  <input style={alan} type={a.tip || 'text'} inputMode={a.sayi ? 'decimal' : undefined} value={form[a.k] ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, [a.k]: e.target.value }))} />
                )}
              </label>
            ))}
          </div>
          {hata && <div style={{ color: R.kirmizi, fontWeight: 600 }}>{hata}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Dugme onClick={() => kaydet()} disabled={mesgul}>{mesgul ? 'Kaydediliyor…' : 'Kaydet'}</Dugme>
            <Dugme kucuk onClick={() => { setForm(null); setHata(''); }}>Vazgeç</Dugme>
          </div>
        </div>
      )}

      <div style={{ ...kart, overflow: 'hidden' }}>
        {satirlar.map((x) => (
          <div key={x.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--pi-line)', opacity: x.aktif === false ? 0.5 : 1 }}>
            {y.kolon(x).map((h, i) => h == null ? null : <span key={i} style={i === 0 ? { fontWeight: 700, minWidth: 160 } : { fontSize: 13, color: R.metin2, ...(typeof h === 'string' && /\d/.test(h) ? num : {}) }}>{h}</span>)}
            {x.aktif === false && <Cip>pasif</Cip>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {x.aktif !== false && <Dugme kucuk onClick={() => duzeltAc(x)}>Düzelt</Dugme>}
              <Dugme kucuk onClick={() => aktiflik(x)}>{x.aktif === false ? (y.tur === 'kart' ? 'Geri getir' : 'Aktif yap') : (y.tur === 'kart' ? '🗑 Sil' : 'Pasif yap')}</Dugme>
            </span>
          </div>
        ))}
        {!satirlar.length && <div style={{ padding: 16, color: R.not }}>Henüz kayıt yok.</div>}
      </div>
    </div>
  );
}
