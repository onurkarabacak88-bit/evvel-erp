// 🏦 KREDİLER — tak-çıkar modül (sunucu: evvel_yeni_kredi_api.py). Sahip (2026-10-17): "Krediler içinde kredi takvimi" —
// kredi × 12 ay (kira takvimi gibi). Borç = taksit; ödeme Ödeme ekranından (kredi seçilerek) → takvimde "ödendi".
import React, { useState } from 'react';
import { api } from '../../utils/api';
import { ALAN, Dugme, fmt, num, PI_CSS, R, sayfayaGit, sayiTR, tKisa, useSonIstek } from './KasaModulu';
import { ayTR } from '../../utils/trTarih';
import { AY_UZUN, AyIzgara, DURUM, Lejant, Pencere, YilSecici, tutarYaz } from './AyTakvim';

export const KREDI_SAYFALAR = [{ id: 'kredi_takvimi', ad: 'Kredi takvimi', alt: 'Kredi × ay · taksitler' }];
const alan = { ...ALAN, minWidth: 0, width: '100%' };   // temel stil KasaModulu ALAN (T4-15)
const ayBugun = ayTR;   // C-T4-02: UTC değil TR (gece 00–03 arası önceki aya kaymasın)

export default function KrediModulu({ onToast, onSekme }) {
  const [yil, setYil] = useState(() => new Date().getFullYear());
  const [v, setV] = useState(null);
  const [hata, setHata] = useState(null);
  const [sec, setSec] = useState(null);
  const [form, setForm] = useState(null);   // {id?, ad, tur, aylik_taksit, odeme_gunu, ilk_ay, taksit_sayisi, aktif}
  const yukle = useSonIstek(`/evvel-yeni/kredi/takvim?yil=${yil}`, setV, setHata, true);   // ortak 'son istek kazanır' (T4-09)

  const ode = (k, a) => {   // takvimden → Ödeme formu hazır (kredi + ay + kalan)
    try { window.sessionStorage.setItem('ey_odeme_on', JSON.stringify({ konu: 'kredi', kredi_id: k.id, kredi_ad: k.ad, ait_ay: a.ay, tutar: a.kalan })); } catch { /* yut */ }
    onSekme?.('odemeler');
  };
  const kaydet = async () => {
    try {
      const tk = sayiTR(form.aylik_taksit);
      if (Number.isNaN(tk)) { onToast?.('Taksiti sayı olarak yaz (ör. 12.500,00)'); return; }
      const govde = { ...form, aylik_taksit: tk, odeme_gunu: Number(form.odeme_gunu) || 0,
        taksit_sayisi: form.taksit_sayisi ? Number(form.taksit_sayisi) : null };
      const r = await api(form.id ? `/evvel-yeni/kredi/${form.id}` : '/evvel-yeni/kredi', { method: 'POST', body: govde });
      onToast?.(r.mesaj); setForm(null); yukle();
    } catch (e) { onToast?.(e?.message || 'Kaydedilemedi'); }
  };

  const satirlar = (v?.krediler || []).map((k) => ({
    id: k.id, baslik: k.ad, alt: `${fmt(k.taksit)} ₺/ay · ${k.odeme_gunu}'i${k.son_ay ? ` · son ${k.son_ay}` : ''}`, k,
    aylar: k.aylar.map((a) => ({ ...a, ust: a.odenen > 0 ? fmt(a.odenen) : a.durum === 'once' ? '·' : fmt(a.beklenen), alt: a.iki_yerde ? '⚠ iki sistemde' : (a.durum === 'kismi' || (a.odenen > 0 && a.kalan > 0)) ? `kalan ${fmt(a.kalan)}` : null })),
    sag: fmt(k.yil_odenen), sagAlt: `/ ${fmt(k.yil_beklenen)}`,
  }));
  return (
    <div className="pi" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{PI_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
        <div><div className="pi-eyebrow">Evvel Yeni · Krediler</div><h1 style={{ fontSize: 30 }}>Kredi takvimi</h1></div>
        <Dugme kucuk ana onClick={() => setForm({ ad: '', tur: 'Kredi', aylik_taksit: '', odeme_gunu: '', ilk_ay: ayBugun(), taksit_sayisi: '', aktif: true })}>+ Kredi ekle</Dugme>
        <YilSecici yil={yil} setYil={setYil} />
      </div>
      <Lejant />
      {hata && <div style={{ color: R.kirmizi }}>{hata}</div>}
      {!v && !hata && <div style={{ color: R.not }}>Takvim hazırlanıyor…</div>}
      {v && v.krediler.length === 0 && <div style={{ color: R.not }}>Tanımlı kredi yok. "+ Kredi ekle" ile ekle.</div>}
      {v && v.krediler.length > 0 && <>
        <AyIzgara satirlar={satirlar} onHucre={(s, a, i) => setSec({ k: s.k, a, i })} />
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: R.metin2 }}>
          {v.ay_toplam.map((t, i) => <span key={t.ay}>{AY_UZUN[i].slice(0, 3)}: <b style={num}>{fmt(t.beklenen)}</b></span>)}
        </div>
        <div style={{ fontSize: 12, color: R.not }}>Bir aya tıkla: taksiti öde ya da krediyi düzelt. {v.baslangic} öncesi aylar "·" (Evvel Yeni öncesi, kayıt yok).</div>
      </>}
      {/* B67: krediye bağlanmamış taksit ödemesi takvimde görünmez — kaybolmasın, tek yol Ödeme defteri › Düzelt */}
      {v && v.bagsiz?.length > 0 && <div style={{ fontSize: 13, color: R.amber }}>⚠ Krediye bağlanmamış {v.bagsiz.length} taksit ödemesi var ({v.bagsiz.map((b) => `${tKisa(b.tarih)} · ${fmt(b.toplam)} ₺`).join(', ')}) — takvimde görünmez. <a href={`/evvel-yeni/odeme_defteri?gun=${v.bagsiz[0].tarih}`} onClick={(e) => { e.preventDefault(); sayfayaGit('odeme_defteri', `?gun=${v.bagsiz[0].tarih}`); }} style={{ color: 'inherit', fontWeight: 700 }}>Ödeme defteri ›</a> Düzelt ile krediyi seç.</div>}
      {/* F3.9 D-1 (sim 26 Eki · Opus + Fable + Codex A): Kasam › Dış giriş "Borç alındı / Kredi çekildi" — geri ödenecek para unutulmasın.
          Kaynak Kasa'nın dış giriş kaydı (tek gerçek); geri ödeme Ödeme › Kredi / borç taksiti › "Ne ödeniyor" ile bu borca bağlanır. */}
      {v && (v.alinan_borclar || []).length > 0 && (() => {
        const acik = v.alinan_borclar.filter((b) => !b.kapandi);
        const kapanan = v.alinan_borclar.length - acik.length;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <b style={{ fontSize: 15 }}>Alınan borçlar (kişi) · kredi çekişleri</b>
            <table className="pi-tablo" style={{ fontSize: 13 }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Gün</th><th style={{ textAlign: 'left' }}>Kimden</th><th style={{ textAlign: 'left' }}>Nereye girdi</th><th>Alınan</th><th>Geri ödenen</th><th>Kalan</th></tr></thead>
              <tbody>{acik.map((b) => (
                <tr key={b.id}>
                  <td style={{ textAlign: 'left' }}>{tKisa(b.tarih)}</td>
                  <td style={{ textAlign: 'left' }}>{b.alt === 'kredi' ? '🏦 Kredi çekildi' : '🤝'} {b.kimden || '—'}{b.not ? <span style={{ color: R.not }}> · {b.not}</span> : null}</td>
                  <td style={{ textAlign: 'left' }}>{b.cep_ad || '—'}</td>
                  <td style={num}>{fmt(b.tutar)}</td>
                  <td style={num}>{b.alt === 'kredi' ? '—' : fmt(b.geri_odenen)}</td>
                  <td style={{ ...num, fontWeight: 700, color: b.alt === 'kredi' ? R.not : R.kirmizi }}>{b.alt === 'kredi' ? 'taksit planı → + Kredi ekle' : `${fmt(b.kalan)} ₺`}</td>
                </tr>))}</tbody>
            </table>
            <div style={{ fontSize: 12, color: R.not }}>Geri ödeme: Ödeme › Kredi / borç taksiti › "Ne ödeniyor" → bu borç. Kredi çekildiyse taksitleri yukarıdaki takvimde izlemek için + Kredi ekle.{kapanan ? ` · ${kapanan} borç tamamen ödendi` : ''}</div>
          </div>
        );
      })()}
      {sec && (
        <Pencere baslik={`🏦 ${sec.k.ad} · ${AY_UZUN[sec.i]} ${v.yil}`} onKapat={() => setSec(null)}>
          <div>Taksit <b style={num}>{tutarYaz(sec.a.beklenen)}</b> ₺ · ödenen <b style={num}>{fmt(sec.a.odenen)}</b> ₺ · kalan <b style={num}>{fmt(sec.a.kalan)}</b> ₺</div>
          <div style={{ color: R.not, fontSize: 13 }}>Ödeme günü {tKisa(sec.a.vade)} · {DURUM[sec.a.durum]?.ad}</div>
          {sec.a.iki_yerde && <div style={{ color: R.amber, fontSize: 13 }}>⚠ Bu taksit hem eski sistemde hem Evvel Yeni'de ödenmiş görünüyor — biri mükerrer olabilir (toplanmadı).</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {sec.a.kalan > 0 && sec.a.durum !== 'once' && <Dugme kucuk ana onClick={() => ode(sec.k, sec.a)}>Bu taksiti öde →</Dugme>}
            <Dugme kucuk onClick={() => { setForm({ id: sec.k.id, ad: sec.k.ad, tur: sec.k.tur || 'Kredi', aylik_taksit: String(sec.k.taksit), odeme_gunu: String(sec.k.odeme_gunu), ilk_ay: sec.k.ilk_ay, taksit_sayisi: sec.k.son_ay ? String(monthsBetween(sec.k.ilk_ay, sec.k.son_ay)) : '', aktif: true }); setSec(null); }}>Krediyi düzelt</Dugme>
          </div>
        </Pencere>
      )}
      {form && (
        <Pencere baslik={form.id ? 'Krediyi düzelt' : 'Yeni kredi'} onKapat={() => setForm(null)}>
          {[['ad', 'Adı (banka · hesap no)'], ['aylik_taksit', 'Aylık taksit (₺)'], ['odeme_gunu', 'Ödeme günü (1–31)'], ['ilk_ay', 'İlk taksit ayı (YYYY-AA)'], ['taksit_sayisi', 'Taksit sayısı (bilmiyorsan boş)']].map(([k, a]) => (
            <label key={k} style={{ display: 'grid', gap: 4, fontSize: 13 }}>{a}
              <input style={alan} type={k === 'ilk_ay' ? 'month' : 'text'} inputMode={['aylik_taksit', 'odeme_gunu', 'taksit_sayisi'].includes(k) ? 'decimal' : undefined}
                value={form[k] ?? ''} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} /></label>
          ))}
          {form.id && <label style={{ fontSize: 13 }}><input type="checkbox" checked={!form.aktif} onChange={(e) => setForm((f) => ({ ...f, aktif: !e.target.checked }))} /> Kredi bitti / kapandı (takvimden kalksın)</label>}
          <div><Dugme ana onClick={kaydet}>Kaydet</Dugme></div>
        </Pencere>
      )}
    </div>
  );
}

function monthsBetween(a, b) {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) + 1;
}
