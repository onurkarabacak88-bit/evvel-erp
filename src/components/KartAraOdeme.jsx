import { useState } from 'react';
import { api, fmt } from '../utils/api';

// 💳 KART ARA ÖDEME (2026-07-27, sahip: "kart alanında öde alanı + merkez alandan
// ara ödeme imkânı"): dönem kapanmış (planı olmayan) ama borcu süren karta İSTENEN
// tutarla ödeme. TEK YAZICI: POST /kart-hareketleri (islem_turu=ODEME) — kasa düşer
// (KART_ODEME izi), kart borcu azalır, plan tek-otorite yazıcıyla kendini günceller.
// Ödeme Merkezi + Kartlar sayfası AYNI modalı kullanır (iki yerde iki kalite yaşamaz).
export default function KartAraOdemeModal({ kart, kasa, onKapat, onOdendi }) {
  const [tutar, setTutar] = useState('');
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const borc = Number(kart.guncel_borc) || 0;
  const bugunISO = new Date().toISOString().slice(0, 10);

  const ode = async () => {
    const n = Number(String(tutar).replace(',', '.'));
    if (!n || n <= 0) { setHata('Geçerli bir tutar girin'); return; }
    if (borc > 0 && n > borc + 0.01) { setHata(`Tutar borçtan büyük olamaz (borç ${fmt(borc)})`); return; }
    setMesgul(true); setHata('');
    try {
      await api('/kart-hareketleri', { method: 'POST', body: {
        kart_id: kart.id, tarih: bugunISO, islem_turu: 'ODEME', tutar: n,
        taksit_sayisi: 1, faiz_tutari: 0, ana_para: 0,
        aciklama: 'Kart borcu ara ödemesi',
      }});
      onOdendi && onOdendi(n);
    } catch (e) { setHata(e.message || 'Ödeme kaydedilemedi'); }
    finally { setMesgul(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onKapat()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <h3>💳 {kart.kart_adi} — Ara Ödeme</h3>
          <button className="modal-close" onClick={onKapat}>✕</button>
        </div>
        <div className="form-group" style={{ padding: '4px 16px 14px', display: 'grid', gap: 10 }}>
          {hata && <div className="alert-box red">{hata}</div>}
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            Güncel borç: <b style={{ color: 'var(--text)' }}>{fmt(borc)}</b>
            {kart.kalan_limit != null && <> · kullanılabilir limit {fmt(kart.kalan_limit)}</>}
          </div>
          <input type="number" autoFocus value={tutar} placeholder="Ödenecek tutar ₺"
            onChange={e => setTutar(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {borc > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => setTutar(String(Math.round(borc * 100) / 100))}>
                Tamamı · {fmt(borc)}
              </button>
            )}
            {borc > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => setTutar(String(Math.round(borc * 50) / 100))}>
                Yarısı · {fmt(borc / 2)}
              </button>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 10px', background: 'var(--bg3)', borderRadius: 8 }}>
            💵 Ödeme kasadan düşer (nakit/havale){kasa != null ? ` — kasada ${fmt(kasa)}` : ''}. Kart borcu anında azalır;
            bir sonraki ekstre devri buna göre küçülür.
          </div>
          <button className="btn btn-primary" disabled={mesgul} onClick={ode}>
            {mesgul ? 'Kaydediliyor…' : '💸 Ödemeyi Kaydet'}
          </button>
        </div>
      </div>
    </div>
  );
}
