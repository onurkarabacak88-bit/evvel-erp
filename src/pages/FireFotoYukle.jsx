import { useState, useEffect, useRef } from 'react';

/**
 * Personelin telefonuyla QR okutunca açılan, sidebar'sız tam ekran sayfa.
 * Yol: /fire-foto/:bildirimId?t=:token
 *
 * - Token doğrulanır, bildirim özeti gösterilir.
 * - Kamera ile fotoğraf çekilir/seçilir → sunucuya yüklenir.
 * - Sunucu, daha önce yüklenmiş aynı/benzer bir fotoğrafı (sha256/aHash) reddeder (409).
 */
export default function FireFotoYukle({ bildirimId, token }) {
  const [durum, setDurum] = useState('yukleniyor'); // yukleniyor | hazir | hata | gonderiliyor | basarili | tekrar | gonderim-hata
  const [bilgi, setBilgi] = useState(null);
  const [hataMesaj, setHataMesaj] = useState('');
  const [onizleme, setOnizleme] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    let aktif = true;
    fetch(`/api/ops/fire-bildirimler/${bildirimId}/foto-bilgi?t=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.detail || 'Bağlantı geçersiz');
        return data;
      })
      .then((data) => {
        if (!aktif) return;
        setBilgi(data);
        setDurum('hazir');
      })
      .catch((e) => {
        if (!aktif) return;
        setHataMesaj(e.message || 'Bağlantı geçersiz');
        setDurum('hata');
      });
    return () => { aktif = false; };
  }, [bildirimId, token]);

  const dosyaSecildi = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setOnizleme(URL.createObjectURL(f));
    yukle(f);
  };

  const yukle = async (file) => {
    setDurum('gonderiliyor');
    setHataMesaj('');
    try {
      const fd = new FormData();
      fd.append('dosya', file, file.name || 'foto.jpg');
      const res = await fetch(
        `/api/ops/fire-bildirimler/${bildirimId}/foto?t=${encodeURIComponent(token)}`,
        { method: 'POST', body: fd }
      );
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setDurum('tekrar');
        setHataMesaj(data?.detail || 'Bu fotoğraf sistemde zaten kayıtlı');
        return;
      }
      if (!res.ok) {
        setDurum('gonderim-hata');
        setHataMesaj(data?.detail || 'Yükleme başarısız');
        return;
      }
      setDurum('basarili');
    } catch (e) {
      setDurum('gonderim-hata');
      setHataMesaj(e.message || 'Yükleme başarısız');
    }
  };

  const tekrarDene = () => {
    setOnizleme(null);
    setDurum('hazir');
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#0b0f17', color: '#fff',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: 20, fontFamily: 'system-ui, sans-serif',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 40, marginBottom: 10 }}>📸</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Fire / İade Kanıt Fotoğrafı</div>

      {durum === 'yukleniyor' && (
        <div style={{ color: 'rgba(255,255,255,.5)', marginTop: 16 }}>Yükleniyor…</div>
      )}

      {durum === 'hata' && (
        <div style={{
          marginTop: 16, padding: '14px 18px', borderRadius: 12,
          background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.35)',
          color: '#fca5a5', maxWidth: 360,
        }}>
          ⚠️ {hataMesaj}
        </div>
      )}

      {bilgi && durum !== 'hata' && (
        <div style={{
          marginTop: 14, padding: '12px 18px', borderRadius: 12,
          background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
          fontSize: 13, color: 'rgba(255,255,255,.7)', maxWidth: 360, lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 700, color: '#fff', marginBottom: 4 }}>{bilgi.sebep_label}</div>
          <div>{bilgi.sube_ad} · {bilgi.tarih}</div>
          {bilgi.aciklama && <div style={{ marginTop: 6, color: 'rgba(255,255,255,.5)' }}>{bilgi.aciklama}</div>}
        </div>
      )}

      {(durum === 'hazir' || durum === 'gonderiliyor') && (
        <div style={{ marginTop: 24, width: '100%', maxWidth: 320 }}>
          {onizleme && (
            <img src={onizleme} alt="önizleme" style={{
              width: '100%', borderRadius: 12, marginBottom: 14,
              border: '1px solid rgba(255,255,255,.1)',
              opacity: durum === 'gonderiliyor' ? 0.5 : 1,
            }} />
          )}
          <label style={{
            display: 'block', padding: '16px 20px', borderRadius: 14,
            background: durum === 'gonderiliyor' ? 'rgba(34,197,94,.15)' : 'linear-gradient(135deg,#22c55e,#16a34a)',
            color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer',
            opacity: durum === 'gonderiliyor' ? 0.7 : 1,
          }}>
            {durum === 'gonderiliyor' ? '⏳ Gönderiliyor…' : (onizleme ? '🔄 Başka Fotoğraf Çek' : '📷 Fotoğraf Çek / Seç')}
            <input
              ref={fileRef} type="file" accept="image/*" capture="environment"
              onChange={dosyaSecildi} disabled={durum === 'gonderiliyor'}
              style={{ display: 'none' }}
            />
          </label>
          <div style={{ marginTop: 12, fontSize: 11, color: 'rgba(255,255,255,.3)' }}>
            Lütfen şimdi, canlı bir fotoğraf çekin — galeriden eski bir fotoğraf seçmeyin.
          </div>
        </div>
      )}

      {durum === 'tekrar' && (
        <div style={{ marginTop: 20, width: '100%', maxWidth: 320 }}>
          {onizleme && (
            <img src={onizleme} alt="önizleme" style={{
              width: '100%', borderRadius: 12, marginBottom: 14,
              border: '1px solid rgba(239,68,68,.35)',
            }} />
          )}
          <div style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.35)',
            color: '#fca5a5', fontSize: 13, lineHeight: 1.6, marginBottom: 14,
          }}>
            🚫 {hataMesaj}
            <div style={{ marginTop: 6, color: 'rgba(255,255,255,.5)', fontSize: 12 }}>
              Bu fotoğraf sistemde başka bir kayıt için zaten kullanılmış. Lütfen şu anda, bu ürün/durum için yeni bir fotoğraf çekin.
            </div>
          </div>
          <button onClick={tekrarDene} style={{
            width: '100%', padding: '14px 20px', borderRadius: 14,
            background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)',
            color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
          }}>
            🔁 Yeni Fotoğraf Çek
          </button>
        </div>
      )}

      {durum === 'gonderim-hata' && (
        <div style={{ marginTop: 20, width: '100%', maxWidth: 320 }}>
          <div style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.35)',
            color: '#fca5a5', fontSize: 13, marginBottom: 14,
          }}>
            ⚠️ {hataMesaj}
          </div>
          <button onClick={tekrarDene} style={{
            width: '100%', padding: '14px 20px', borderRadius: 14,
            background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.15)',
            color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer',
          }}>
            🔁 Tekrar Dene
          </button>
        </div>
      )}

      {durum === 'basarili' && (
        <div style={{ marginTop: 24, width: '100%', maxWidth: 320 }}>
          {onizleme && (
            <img src={onizleme} alt="önizleme" style={{
              width: '100%', borderRadius: 12, marginBottom: 14,
              border: '1px solid rgba(34,197,94,.35)',
            }} />
          )}
          <div style={{
            padding: '16px 20px', borderRadius: 14,
            background: 'rgba(34,197,94,.12)', border: '1px solid rgba(34,197,94,.35)',
            color: '#86efac', fontWeight: 800, fontSize: 15,
          }}>
            ✅ Fotoğraf kaydedildi — teşekkürler!
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,.4)' }}>
            Bu sayfayı kapatabilirsiniz.
          </div>
        </div>
      )}
    </div>
  );
}
