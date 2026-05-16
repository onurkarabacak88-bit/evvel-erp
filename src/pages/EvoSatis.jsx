import { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';

// Bugünün tarihini DD.MM.YYYY formatında döndür
function bugunFmt() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

// Tarih: YYYY-MM-DD → DD.MM.YYYY
function toTR(s) {
  if (!s) return '';
  const [y,m,g] = s.split('-');
  return `${g}.${m}.${y}`;
}

// Türkçe para formatı
function fmtTL(n) {
  return Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

export default function EvoSatis() {
  const bugun = new Date().toISOString().slice(0, 10);
  const [tarih1, setTarih1] = useState(bugun);
  const [tarih2, setTarih2] = useState(bugun);
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [tokenDurumu, setTokenDurumu] = useState('bilinmiyor'); // 'ok' | 'yok' | 'bilinmiyor'
  const [tokenGuncelModal, setTokenGuncelModal] = useState(false);
  const [popupBekle, setPopupBekle] = useState(false);
  const [sonGuncelleme, setSonGuncelleme] = useState(null);
  const popupRef = useRef(null);
  const pollRef = useRef(null);

  // Bookmarklet kodu — evobulut.com sayfasında çalışır, localStorage'dan token okur, Railway'e gönderir
  const RAILWAY_URL = window.location.origin; // aynı domain
  const bookmarkletKod = `javascript:(function(){var t=localStorage.getItem('evo_token');if(!t){alert('Token bulunamadı. Önce evobulut.com\\'a giriş yapın.');return;}fetch('${RAILWAY_URL}/api/evo/set-web-token?token='+encodeURIComponent(t)).then(function(r){return r.json();}).then(function(d){if(window.opener||window.name==='evobulut_token'){window.close();}else{alert('✅ Token güncellendi! Evvel ERP\\'ye dönün.');}}).catch(function(e){alert('Hata: '+e.message);});})();`;

  async function veriYukle() {
    setYukleniyor(true);
    setHata(null);
    try {
      const t1 = toTR(tarih1);
      const t2 = toTR(tarih2);
      const r = await api(`/evo/hs-rapor?tarih1=${t1}&tarih2=${t2}`);
      setVeri(r);
      setTokenDurumu('ok');
      setSonGuncelleme(new Date());
    } catch (e) {
      const mesaj = e.message || String(e);
      if (mesaj.includes('503') || mesaj.toLowerCase().includes('token') || mesaj.toLowerCase().includes('web_token')) {
        setTokenDurumu('yok');
        setHata('token_yok');
      } else {
        setTokenDurumu('bilinmiyor');
        setHata(mesaj);
      }
    } finally {
      setYukleniyor(false);
    }
  }

  useEffect(() => { veriYukle(); }, [tarih1, tarih2]);

  // Popup açıldıktan sonra kapanmayı bekle
  useEffect(() => {
    if (!popupBekle) return;
    let sayac = 0;
    pollRef.current = setInterval(() => {
      sayac++;
      // Popup kapandı mı?
      if (popupRef.current && popupRef.current.closed) {
        clearInterval(pollRef.current);
        setPopupBekle(false);
        setTokenGuncelModal(false);
        // Token güncellendi, veriyi yenile
        setTimeout(() => veriYukle(), 800);
      }
      // 60 saniye sonra vazgeç
      if (sayac > 60) {
        clearInterval(pollRef.current);
        setPopupBekle(false);
      }
    }, 1000);
    return () => clearInterval(pollRef.current);
  }, [popupBekle]);

  function evoAc() {
    // Evobulut'u küçük popup olarak aç
    const popup = window.open(
      'https://web.evobulut.com/hizli/hs_rapor.html',
      'evobulut_token',
      'width=900,height=650,left=100,top=80,resizable=yes,scrollbars=yes'
    );
    if (!popup) {
      setHata('Popup engelleyici aktif. Lütfen popup izni verin.');
      return;
    }
    popupRef.current = popup;
    setPopupBekle(true);
  }

  const urunler = veri?.urunler ? Object.entries(veri.urunler) : [];
  const toplamAdet = urunler.reduce((s, [, a]) => s + Number(a || 0), 0);

  return (
    <div className="page">
      {/* Başlık */}
      <div className="page-header" style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>☕ Ürün Bazlı Satış</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            evobulut Hızlı Satış — en çok satılanlar
          </p>
        </div>

        {/* Token durum rozeti */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {tokenDurumu === 'ok' && (
            <span style={{ fontSize: 12, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>●</span> Bağlı
              {sonGuncelleme && <span style={{ color: 'var(--muted)' }}>· {sonGuncelleme.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>}
            </span>
          )}
          {(tokenDurumu === 'yok' || hata === 'token_yok') && (
            <span style={{ fontSize: 12, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>●</span> Token gerekiyor
            </span>
          )}

          {/* Token güncelle butonu */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setTokenGuncelModal(true)}
            title="Evobulut bağlantısını yenile"
          >
            🔄 Token Yenile
          </button>

          {/* Yenile */}
          <button
            className="btn btn-primary btn-sm"
            onClick={veriYukle}
            disabled={yukleniyor}
          >
            {yukleniyor ? '⏳' : '↺'} Yenile
          </button>
        </div>
      </div>

      {/* Tarih seçici */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>Başlangıç</label>
        <input type="date" className="input" value={tarih1} onChange={e => setTarih1(e.target.value)}
          style={{ width: 150, fontSize: 13 }} />
        <label style={{ fontSize: 13, color: 'var(--muted)' }}>Bitiş</label>
        <input type="date" className="input" value={tarih2} onChange={e => setTarih2(e.target.value)}
          style={{ width: 150, fontSize: 13 }} />

        {/* Hızlı kısayollar */}
        {[
          { label: 'Bugün', fn: () => { const b = bugun; setTarih1(b); setTarih2(b); } },
          { label: 'Dün', fn: () => { const d = new Date(); d.setDate(d.getDate()-1); const s = d.toISOString().slice(0,10); setTarih1(s); setTarih2(s); } },
          { label: 'Bu Hafta', fn: () => { const d = new Date(); const gun = d.getDay()||7; d.setDate(d.getDate()-gun+1); setTarih1(d.toISOString().slice(0,10)); setTarih2(bugun); } },
        ].map(({ label, fn }) => (
          <button key={label} className="btn btn-secondary btn-sm" onClick={fn} style={{ fontSize: 12 }}>{label}</button>
        ))}
      </div>

      {/* Token yok uyarısı */}
      {(hata === 'token_yok') && (
        <div className="alert-box red" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ Evobulut bağlantısı yok — token gerekiyor.</span>
          <button className="btn btn-primary btn-sm" onClick={() => setTokenGuncelModal(true)}>
            Bağlan →
          </button>
        </div>
      )}

      {/* Genel hata */}
      {hata && hata !== 'token_yok' && (
        <div className="alert-box red" style={{ marginBottom: 16 }}>{hata}</div>
      )}

      {/* Yükleniyor */}
      {yukleniyor && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>
          ⏳ Yükleniyor...
        </div>
      )}

      {/* Satış tablosu */}
      {!yukleniyor && veri && urunler.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>
              {veri.urun_sayisi} ürün — {toTR(tarih1)}{tarih1 !== tarih2 ? ` → ${toTR(tarih2)}` : ''}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              Toplam: <strong>{Math.round(toplamAdet)} adet</strong>
            </span>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '10px 20px', textAlign: 'left', fontWeight: 600, color: 'var(--muted)', fontSize: 12 }}>#</th>
                <th style={{ padding: '10px 20px', textAlign: 'left', fontWeight: 600, color: 'var(--muted)', fontSize: 12 }}>ÜRÜN</th>
                <th style={{ padding: '10px 20px', textAlign: 'right', fontWeight: 600, color: 'var(--muted)', fontSize: 12 }}>ADET</th>
                <th style={{ padding: '10px 20px', textAlign: 'right', fontWeight: 600, color: 'var(--muted)', fontSize: 12 }}>ORAN</th>
                <th style={{ padding: '10px 20px', textAlign: 'right', fontWeight: 600 }}>
                  <div style={{ height: 4 }} />
                </th>
              </tr>
            </thead>
            <tbody>
              {urunler.map(([ad, adet], i) => {
                const pct = toplamAdet > 0 ? (Number(adet) / toplamAdet) * 100 : 0;
                const renk = i === 0 ? '#f5a623' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : 'var(--accent)';
                return (
                  <tr key={ad} style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg2)'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                    <td style={{ padding: '10px 20px', color: 'var(--muted)', fontSize: 13 }}>
                      {i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}
                    </td>
                    <td style={{ padding: '10px 20px', fontWeight: i < 3 ? 600 : 400 }}>{ad}</td>
                    <td style={{ padding: '10px 20px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      {Math.round(Number(adet))}
                    </td>
                    <td style={{ padding: '10px 20px', textAlign: 'right', color: 'var(--muted)', fontSize: 13 }}>
                      %{pct.toFixed(1)}
                    </td>
                    <td style={{ padding: '10px 20px', width: 120 }}>
                      <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3 }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: renk, borderRadius: 3, transition: 'width .4s' }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Boş sonuç */}
      {!yukleniyor && veri && urunler.length === 0 && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
          <div>Bu tarih aralığında satış verisi yok.</div>
        </div>
      )}


      {/* ─── TOKEN GÜNCELLE MODAL ─── */}
      {tokenGuncelModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }} onClick={e => { if (e.target === e.currentTarget) { setTokenGuncelModal(false); setPopupBekle(false); }}}>
          <div className="card" style={{ width: 480, maxWidth: '95vw', padding: 28 }}>

            <h3 style={{ margin: '0 0 8px', fontSize: 17, fontWeight: 700 }}>🔗 Evobulut Bağlantısı</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--muted)' }}>
              Evobulut'taki satış verilerini çekmek için tarayıcı oturumu gerekir.
            </p>

            {/* ADIM 1: Bookmark kurulumu — sadece ilk kez */}
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>
                📌 İlk kez: Bookmark kur (1 kez yeterli)
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
                Aşağıdaki butonu sürükleyip tarayıcının <strong>yer imleri çubuğuna</strong> bırak.
                Bir kez kurulunca hep kullanabilirsin.
              </p>
              {/* Bookmarklet linki — sürüklenebilir */}
              <a
                href={bookmarkletKod}
                style={{
                  display: 'inline-block',
                  padding: '8px 16px',
                  background: 'var(--accent)',
                  color: '#fff',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                  cursor: 'grab',
                  userSelect: 'none',
                }}
                onClick={e => e.preventDefault()} // Sayfada tıklanmasını engelle (sadece sürükle)
                title="Bu butonu yer imleri çubuğuna sürükle"
              >
                ⭐ Evvel → Evobulut Token
              </a>
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: '8px 0 0' }}>
                💡 Sürükle → Yer imleri çubuğuna bırak. Tıklamaz, sadece sürüklersin.
              </p>
            </div>

            {/* ADIM 2: Butona bas ve evobulut popup'ta açılır */}
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>
                🚀 Her seferinde: Tek tıkla güncelle
              </div>
              {!popupBekle ? (
                <>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>
                    Aşağıdaki butona bas → Evobulut küçük pencerede açılır →
                    Yer imlerinden <strong>"Evvel → Evobulut Token"</strong> butonuna tıkla → Bitti!
                  </p>
                  <button className="btn btn-primary" onClick={evoAc} style={{ width: '100%' }}>
                    🔓 Evobulut'u Aç ve Token Gönder
                  </button>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: 12 }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Evobulut penceresi açık</div>
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                    Açılan pencerede yer imlerindeki<br/>
                    <strong>"⭐ Evvel → Evobulut Token"</strong> butonuna tıkla.<br/>
                    Pencere kapanınca veriler otomatik yüklenir.
                  </div>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'var(--accent)', color: '#fff',
                    padding: '6px 14px', borderRadius: 20, fontSize: 13
                  }}>
                    <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                    Bekleniyor...
                  </div>
                  <br />
                  <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
                    onClick={() => { setPopupBekle(false); clearInterval(pollRef.current); }}>
                    İptal
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setTokenGuncelModal(false); setPopupBekle(false); clearInterval(pollRef.current); }}>
                Kapat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
