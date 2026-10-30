// 📱 TELEFON ANA SAYFASI — F7 /cep (sim 27 Eki · Fable): ayrı uygulama değil, Evvel Yeni'nin telefon girişi.
// 5 büyük kart var olan EY ekranlarını açar; yeni uç yok, aynı oturum. /cep adresi buraya açılır (sahip 27 Eki: eski CepApp kaldırıldı, yeni aynı alanda).
import React from 'react';
import { R, kart, dugmeSade } from './KasaModulu';
import { sayfaGorunur } from './yetki';   // 🔐 izin TEK kaynak

export const CEP_SAYFALAR = [{ id: 'cep_ana', ad: 'Telefon ana sayfası', alt: 'Kasam · beklenen satış · işler · avans · ödeme · sipariş' }];

const KARTLAR = [
  { id: 'kasam', ikon: '💰', ad: 'Kasam', alt: 'Toplam kasa · şube nakitleri' },
  // sahip 28 Eki "beklenen satışı şube şube telefondan takip edeyim" (Fable A): bakış kartı Kasam'ın altında, ekran telefonda kart kart
  { id: 'satis_beklenen', ikon: '📈', ad: 'Beklenen satış', alt: 'Şube şube bardak → beklenen ↔ girilen ciro' },
  { id: 'isler_kasa', ikon: '📋', ad: 'Bekleyen işler', alt: 'Kararını bekleyenler' },
  { id: 'avans_talepleri', ikon: '🤝', ad: 'Avans talepleri', alt: 'Öde · elden · reddet' },
  { id: 'odemeler', ikon: '🧾', ad: 'Ödemeler', alt: 'Ödeme / gider gir' },
  { id: 'siparis_yon', ikon: '🛒', ad: 'Sipariş yönlendirme', alt: 'Şube talebi → depo / toptancı' },
];

// Sayı rozeti YOK: kabuğun rozeti yalnız Kasa verisi gelince dolar — burada boş kalıp "iş yok" sanılırdı.
export default function CepAna({ onSekme }) {
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 520, margin: '0 auto', padding: '8px 0' }}>
      {KARTLAR.filter((k) => sayfaGorunur(k.id)).map((k) => (   // 🔐 telefon da AYNI izin kaynağı (sahip 30 Eki)
        <button key={k.id} type="button" onClick={() => onSekme(k.id)}
          style={{ ...dugmeSade, ...kart, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', minHeight: 72, textAlign: 'left', width: '100%', cursor: 'pointer' }}>
          <span aria-hidden="true" style={{ fontSize: 28 }}>{k.ikon}</span>
          <span style={{ flex: 1 }}>
            <b style={{ display: 'block', fontSize: 17, color: R.krem }}>{k.ad}</b>
            <small style={{ fontSize: 13, color: 'var(--pi-ink3, var(--ink3))' }}>{k.alt}</small>
          </span>
          <span aria-hidden="true" style={{ color: 'var(--pi-ink3, var(--ink3))' }}>›</span>
        </button>
      ))}
    </div>
  );
}
