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

// Malzeme renk eşlemesi
const MALZEME_RENK = {
  'Plastik Bardak':      '#3b82f6',
  '14oz Karton Bardak':  '#f59e0b',
  '8oz Karton Bardak':   '#10b981',
  'Su Şişesi':           '#6366f1',
  'Çay Bardağı':         '#ef4444',
  'Pasta Tabağı':        '#ec4899',
  'Kutu (Redbull)':      '#8b5cf6',
  'Maden Suyu Şişesi':   '#14b8a6',
};

export default function EvoSatis() {
  const bugun = new Date().toISOString().slice(0, 10);
  const [tarih1, setTarih1] = useState(bugun);
  const [tarih2, setTarih2] = useState(bugun);
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState(null);
  const [tokenDurumu, setTokenDurumu] = useState('bilinmiyor');
  const [tokenGuncelModal, setTokenGuncelModal] = useState(false);
  const [popupBekle, setPopupBekle] = useState(false);
  const [sonGuncelleme, setSonGuncelleme] = useState(null);
  const [aktifSekme, setAktifSekme] = useState('urun'); // 'urun' | 'sube'
  const [subeAnaliz, setSubeAnaliz] = useState(null);
  const [subeYukleniyor, setSubeYukleniyor] = useState(false);
  const [subeHata, setSubeHata] = useState(null);
  const [secilenSube, setSecilenSube] = useState(null);
  const [subeUrunler, setSubeUrunler] = useState(null);   // seçilen şubenin ürün detayı
  const [subeUrunYukleniyor, setSubeUrunYukleniyor] = useState(false);
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

  async function subeAnalızYukle() {
    setSubeYukleniyor(true);
    setSubeHata(null);
    try {
      // Yeni endpoint: her şube için hs_rapor sube=N paralel çağrı
      const r = await api(`/evo/sube-grup-detay?bastar=${tarih1}&bittar=${tarih2}`);
      // Eski yapı uyumu: {subeler: {ad: {ciro, fis_sayisi, ...}}}
      // Yeni: {subeler: {ad: {ciro_toplam, fatura_sayisi, gruplar, ...}}}
      // Eski şube kartları için ciro/fis_sayisi alanı bekleniyor — adapter:
      if (r?.subeler) {
        for (const ad of Object.keys(r.subeler)) {
          const s = r.subeler[ad];
          if (s.ciro_toplam != null) s.ciro = s.ciro_toplam;
          if (s.fatura_sayisi != null) s.fis_sayisi = s.fatura_sayisi;
        }
      }
      setSubeAnaliz(r);
      setTokenDurumu('ok');
      if (!secilenSube && r.subeler) {
        const ilk = Object.keys(r.subeler)[0];
        if (ilk) setSecilenSube(ilk);
      }
    } catch (e) {
      const mesaj = e.message || String(e);
      if (mesaj.includes('503') || mesaj.toLowerCase().includes('token')) {
        setTokenDurumu('yok');
        setSubeHata('token_yok');
      } else {
        setSubeHata(mesaj);
      }
    } finally {
      setSubeYukleniyor(false);
    }
  }

  // YENI: Şube verisi artık /evo/sube-grup-detay içinde geliyor (subeAnaliz state'inde)
  // Bu yüzden ayrı bir subeUrunYukle çağrısına gerek yok; seçili şubenin payload'unu
  // doğrudan subeAnaliz.subeler[secilenSube] üzerinden okuyacağız.
  async function subeUrunYukle(subeAdi) {
    if (!subeAdi) return;
    setSubeUrunYukleniyor(true);
    try {
      const sec = subeAnaliz?.subeler?.[subeAdi];
      if (sec) {
        // Eski UI uyum adapteri: urunler / toplam_fis / islenen_fis / ciro
        const urunler = (sec.cok_satilan || []).map(u => ({
          urun: u.ad, adet: u.adet, grup: u.grup, ciro: u.ciro,
        }));
        setSubeUrunler({
          urunler,
          gruplar: sec.gruplar || {},
          personel: sec.personel_satislar || [],
          toplam_fis: sec.fatura_sayisi || 0,
          islenen_fis: sec.fatura_sayisi || 0,
          ciro: sec.ciro_toplam || 0,
          nakit: sec.nakit || 0,
          kart: sec.kart || 0,
          iskonto: sec.iskonto_toplam || 0,
          evo_sube_id: sec.evo_sube_id,
        });
      } else {
        setSubeUrunler({ hata: 'Şube verisi bulunamadı (önce şube analizini yükleyin)' });
      }
    } catch (e) {
      setSubeUrunler({ hata: e.message || String(e) });
    } finally {
      setSubeUrunYukleniyor(false);
    }
  }

  function subeSecOlayı(ad) {
    setSecilenSube(ad);
    // Yeni endpoint zaten tüm şubelerin ürün/grup detayını döndürüyor; subeAnaliz'den direkt al
    const subePayload = subeAnaliz?.subeler?.[ad];
    if (subePayload) {
      setSubeUrunler({
        sube_adi: ad,
        evo_sube_id: subePayload.evo_sube_id,
        toplam_fis: subePayload.fatura_sayisi,
        ciro: subePayload.ciro_toplam,
        nakit: subePayload.nakit,
        kart: subePayload.kart,
        iskonto: subePayload.iskonto_toplam,
        gruplar: subePayload.gruplar,
        urunler: (subePayload.cok_satilan || []).map(u => ({
          urun: u.ad, adet: u.adet, ciro: u.ciro, grup: u.grup, stok_kodu: u.stok_kodu,
        })),
        personel: subePayload.personel_satislar || [],
      });
    } else {
      // fallback: eski endpoint
      setSubeUrunler(null);
      subeUrunYukle(ad);
    }
  }

  useEffect(() => { veriYukle(); }, [tarih1, tarih2]);
  useEffect(() => { if (aktifSekme === 'sube') subeAnalızYukle(); }, [tarih1, tarih2, aktifSekme]);

  // Yeni sube-grup-detay endpoint'i tüm şubelerin verisini bir kerede dönüyor.
  // İlk yükleme veya tarih değişiminde, seçili şubenin payload'ı otomatik subeUrunler'a yansır.
  useEffect(() => {
    if (!secilenSube || !subeAnaliz?.subeler?.[secilenSube]) return;
    const s = subeAnaliz.subeler[secilenSube];
    // Eğer hem gruplar hem cok_satilan yeni endpoint'ten geldiyse, doğrudan kullan
    if (s.gruplar || s.cok_satilan) {
      setSubeUrunler({
        sube_adi: secilenSube,
        evo_sube_id: s.evo_sube_id,
        toplam_fis: s.fatura_sayisi,
        ciro: s.ciro_toplam,
        nakit: s.nakit,
        kart: s.kart,
        iskonto: s.iskonto_toplam,
        gruplar: s.gruplar,
        urunler: (s.cok_satilan || []).map(u => ({
          urun: u.ad, adet: u.adet, ciro: u.ciro, grup: u.grup, stok_kodu: u.stok_kodu,
        })),
        personel: s.personel_satislar || [],
      });
    }
  }, [subeAnaliz, secilenSube]);

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
              <span>●</span>
              {veri?.kaynak === 'rest_api_fallback' ? 'REST API (token yok)' : 'Bağlı · hs_rapor'}
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

      {/* Sekme navigasyonu */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--border)', paddingBottom: 0 }}>
        {[
          { key: 'urun', label: '📊 Ürün Satışları' },
          { key: 'sube', label: '🏪 Şube Analiz' },
        ].map(s => (
          <button key={s.key} onClick={() => setAktifSekme(s.key)}
            style={{
              padding: '8px 18px', fontSize: 14, fontWeight: aktifSekme === s.key ? 700 : 400,
              border: 'none', borderBottom: aktifSekme === s.key ? '2px solid var(--accent)' : '2px solid transparent',
              background: 'none', cursor: 'pointer', color: aktifSekme === s.key ? 'var(--accent)' : 'var(--muted)',
              marginBottom: -2, transition: 'all .15s',
            }}>
            {s.label}
          </button>
        ))}
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

      {/* Token yok uyarısı — sadece ürün sekmesinde */}
      {aktifSekme === 'urun' && hata === 'token_yok' && (
        <div className="alert-box red" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ Evobulut bağlantısı yok — token gerekiyor.</span>
          <button className="btn btn-primary btn-sm" onClick={() => setTokenGuncelModal(true)}>
            Bağlan →
          </button>
        </div>
      )}

      {/* Genel hata */}
      {aktifSekme === 'urun' && hata && hata !== 'token_yok' && (
        <div className="alert-box red" style={{ marginBottom: 16 }}>{hata}</div>
      )}

      {/* Yükleniyor */}
      {aktifSekme === 'urun' && yukleniyor && (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>
          ⏳ Yükleniyor...
        </div>
      )}

      {/* ─── ŞUBE ANALİZ SEKMESİ ─── */}
      {aktifSekme === 'sube' && (
        <div>
          {subeYukleniyor && (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)' }}>⏳ Şube verileri yükleniyor...</div>
          )}
          {subeHata === 'token_yok' && (
            <div className="alert-box red" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>⚠️ Evobulut bağlantısı yok — token gerekiyor.</span>
              <button className="btn btn-primary btn-sm" onClick={() => setTokenGuncelModal(true)}>Bağlan →</button>
            </div>
          )}
          {subeHata && subeHata !== 'token_yok' && (
            <div className="alert-box red" style={{ marginBottom: 16 }}>{subeHata}</div>
          )}

          {!subeYukleniyor && subeAnaliz && (
            <>
              {/* TOPLAM ÖZET — tüm şubeler */}
              {(() => {
                const subeler = Object.values(subeAnaliz.subeler || {});
                if (subeler.length === 0) return null;
                const top = subeler.reduce((a, s) => ({
                  ciro:    a.ciro    + (Number(s.ciro_toplam || s.ciro) || 0),
                  nakit:   a.nakit   + (Number(s.nakit) || 0),
                  kart:    a.kart    + (Number(s.kart)  || 0),
                  fis:     a.fis     + (Number(s.fatura_sayisi || s.fis_sayisi) || 0),
                  iskonto: a.iskonto + (Number(s.iskonto_toplam) || 0),
                }), { ciro: 0, nakit: 0, kart: 0, fis: 0, iskonto: 0 });
                // Grup toplamları (Ice/14oz/8oz/Su/Redbull/Pasta/ÇAY)
                const grupTop = {};
                subeler.forEach(s => {
                  Object.entries(s.gruplar || {}).forEach(([g, v]) => {
                    if (!grupTop[g]) grupTop[g] = { adet: 0, ciro: 0 };
                    grupTop[g].adet += Number(v.adet || 0);
                    grupTop[g].ciro += Number(v.ciro || 0);
                  });
                });
                return (
                  <div style={{ marginBottom: 16 }}>
                    {/* 5 metrik kartı */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>Toplam Ciro</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)' }}>{fmtTL(top.ciro)}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{top.fis} fiş · {subeler.length} şube</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>💵 Toplam Nakit</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#86efac' }}>{fmtTL(top.nakit)}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{top.ciro > 0 ? Math.round(top.nakit/top.ciro*100) : 0}% nakit</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>💳 Toplam Kart</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#93c5fd' }}>{fmtTL(top.kart)}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{top.ciro > 0 ? Math.round(top.kart/top.ciro*100) : 0}% kart</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>İskonto</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: top.iskonto > 0 ? '#fbbf24' : 'var(--text)' }}>{fmtTL(top.iskonto)}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{top.ciro > 0 ? ((top.iskonto/top.ciro)*100).toFixed(2) : 0}%</div>
                      </div>
                      <div className="card" style={{ padding: 12 }}>
                        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>Ort. Fiş Tutarı</div>
                        <div style={{ fontSize: 20, fontWeight: 800 }}>{fmtTL(top.fis > 0 ? top.ciro / top.fis : 0)}</div>
                      </div>
                    </div>

                    {/* Grup toplamları yatay özet */}
                    {Object.keys(grupTop).length > 0 && (
                      <div className="card" style={{ padding: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                          🥤 Grup Toplamları (tüm şubeler)
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {Object.entries(grupTop).sort((a,b) => b[1].adet - a[1].adet).map(([g, v]) => {
                            const renkMap = {
                              'Ice':'#3b82f6','14 Oz':'#f59e0b','8 Oz':'#10b981',
                              'Su':'#6366f1','Maden Suyu':'#14b8a6',
                              'Redbull':'#8b5cf6','Pasta':'#ec4899','ÇAY':'#ef4444',
                            };
                            const r = renkMap[g] || '#94a3b8';
                            return (
                              <div key={g} style={{
                                padding: '6px 12px', borderRadius: 6, minWidth: 100,
                                background: r + '22', border: `1px solid ${r}66`,
                              }}>
                                <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>{g}</div>
                                <div style={{ fontSize: 16, fontWeight: 800, color: r }}>{Math.round(v.adet)}</div>
                                <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtTL(v.ciro)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ─── ŞUBE × ÜRÜN KARŞILAŞTIRMA MATRİSİ ─── */}
              {(() => {
                const sb = subeAnaliz.subeler || {};
                const subeAdlari = Object.keys(sb).sort();
                if (subeAdlari.length === 0) return null;

                // Pivot: urun ad → { stok_kodu, grup, toplam, subeler: {ad: adet} }
                const urunMap = {};
                subeAdlari.forEach(sad => {
                  ((sb[sad]?.cok_satilan) || []).forEach(u => {
                    const k = u.stok_kodu || u.ad;
                    if (!urunMap[k]) {
                      urunMap[k] = {
                        stok_kodu: u.stok_kodu,
                        ad: u.ad,
                        grup: u.grup,
                        toplam: 0,
                        toplam_ciro: 0,
                        subeler: {},
                      };
                    }
                    urunMap[k].toplam += Number(u.adet || 0);
                    urunMap[k].toplam_ciro += Number(u.ciro || 0);
                    urunMap[k].subeler[sad] = (urunMap[k].subeler[sad] || 0) + Number(u.adet || 0);
                  });
                });
                const urunler = Object.values(urunMap).sort((a, b) => b.toplam - a.toplam);
                if (urunler.length === 0) return null;

                return (
                  <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <strong style={{ fontSize: 13 }}>📊 Şube × Ürün Karşılaştırma</strong>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                        ({urunler.length} ürün, sıralı: toplam adet)
                      </span>
                    </div>
                    <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead style={{ background: 'rgba(255,255,255,0.04)', position: 'sticky', top: 0 }}>
                          <tr>
                            <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>#</th>
                            <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Ürün</th>
                            <th style={{ padding: '8px 10px', textAlign: 'center', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>Grup</th>
                            <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, color: 'var(--green)', fontWeight: 700, textTransform: 'uppercase', borderRight: '2px solid var(--border)' }}>
                              ✦ Toplam
                            </th>
                            {subeAdlari.map(sad => (
                              <th key={sad} style={{ padding: '8px 10px', textAlign: 'right', fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                                {sad.replace(' Şubesi', '')}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {urunler.slice(0, 100).map((u, i) => {
                            const renkMap = {
                              'Ice':'#3b82f6','14 Oz':'#f59e0b','8 Oz':'#10b981',
                              'Su':'#6366f1','Maden Suyu':'#14b8a6',
                              'Redbull':'#8b5cf6','Pasta':'#ec4899','ÇAY':'#ef4444',
                            };
                            const grpRenk = renkMap[u.grup] || '#94a3b8';
                            const maks = Math.max(...subeAdlari.map(s => u.subeler[s] || 0));
                            return (
                              <tr key={u.stok_kodu || u.ad} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                <td style={{ padding: '6px 10px', color: 'var(--muted)', fontSize: 11 }}>{i + 1}</td>
                                <td style={{ padding: '6px 10px', fontWeight: i < 5 ? 700 : 500 }}>
                                  {u.ad}
                                  {u.stok_kodu && (
                                    <span style={{ marginLeft: 6, fontSize: 9, color: 'var(--muted)', fontFamily: 'monospace' }}>
                                      {u.stok_kodu}
                                    </span>
                                  )}
                                </td>
                                <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                                  {u.grup && (
                                    <span style={{
                                      padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
                                      background: grpRenk + '22', color: grpRenk, border: `1px solid ${grpRenk}55`,
                                    }}>
                                      {u.grup}
                                    </span>
                                  )}
                                </td>
                                <td style={{
                                  padding: '6px 10px', textAlign: 'right', fontFamily: 'monospace',
                                  fontWeight: 800, color: 'var(--green)', borderRight: '2px solid var(--border)',
                                }}>
                                  {Math.round(u.toplam)}
                                  <div style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 400 }}>
                                    {fmtTL(u.toplam_ciro)}
                                  </div>
                                </td>
                                {subeAdlari.map(sad => {
                                  const v = u.subeler[sad] || 0;
                                  const yogunluk = maks > 0 ? v / maks : 0;
                                  const bg = v === 0
                                    ? 'transparent'
                                    : `rgba(34,197,94,${0.06 + yogunluk * 0.20})`;
                                  return (
                                    <td key={sad} style={{
                                      padding: '6px 10px', textAlign: 'right',
                                      fontFamily: 'monospace', background: bg,
                                      color: v === 0 ? 'var(--text3)' : 'inherit',
                                      fontWeight: v === maks && v > 0 ? 700 : 400,
                                    }}>
                                      {v === 0 ? '—' : Math.round(v)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {urunler.length > 100 && (
                      <div style={{ padding: '6px 14px', fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
                        … {urunler.length - 100} ürün daha (ilk 100 gösteriliyor)
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Şube kartları */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 20 }}>
                {Object.entries(subeAnaliz.subeler || {})
                  .sort((a, b) => b[1].ciro - a[1].ciro)
                  .map(([ad, bilgi]) => (
                    <div key={ad}
                      onClick={() => subeSecOlayı(ad)}
                      className="card"
                      style={{
                        padding: '14px 18px', cursor: 'pointer',
                        border: secilenSube === ad ? '2px solid var(--accent)' : '2px solid transparent',
                        transition: 'border-color .15s',
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: secilenSube === ad ? 'var(--accent)' : 'var(--text)' }}>
                        🏪 {ad}
                      </div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)' }}>{fmtTL(bilgi.ciro)}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{bilgi.fis_sayisi} fiş</div>
                      {(bilgi.nakit != null || bilgi.kart != null) && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 11 }}>
                          <span style={{ color: '#86efac' }}>💵 {fmtTL(bilgi.nakit || 0)}</span>
                          <span style={{ color: '#93c5fd' }}>💳 {fmtTL(bilgi.kart || 0)}</span>
                        </div>
                      )}
                    </div>
                  ))}
              </div>

              {/* Seçili şubenin ürün detayı */}
              {secilenSube && (
                <div className="card" style={{ padding: 0, marginBottom: 16 }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>🏪 {secilenSube} — Ürün Detayı</span>
                    {subeUrunler && !subeUrunler.hata && subeUrunler.uyari && (
                      <span style={{ fontSize: 11, color: 'var(--yellow)', marginLeft: 'auto' }}>
                        ⚠️ {subeUrunler.uyari}
                      </span>
                    )}
                    {subeUrunler && !subeUrunler.hata && (
                      <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: subeUrunler.uyari ? 0 : 'auto' }}>
                        {subeUrunler.toplam_fis} fiş · {fmtTL(subeUrunler.ciro)}
                        {subeUrunler.evo_sube_id && <span style={{ color: 'var(--text3)' }}> · Evo ID {subeUrunler.evo_sube_id}</span>}
                      </span>
                    )}
                  </div>

                  {/* GRUP TABLOSU (Evo Grup_Pasta) — yeni eklendi */}
                  {!subeUrunYukleniyor && subeUrunler?.gruplar && Object.keys(subeUrunler.gruplar).length > 0 && (
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase' }}>
                        🥤 Grup Dağılımı (Evo) — Nakit {fmtTL(subeUrunler.nakit)} · Kart {fmtTL(subeUrunler.kart)} · İskonto {fmtTL(subeUrunler.iskonto)}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {Object.entries(subeUrunler.gruplar).map(([g, v]) => {
                          const renkMap = {
                            'Ice':'#3b82f6', '14 Oz':'#f59e0b', '8 Oz':'#10b981',
                            'Su':'#6366f1', 'Maden Suyu':'#14b8a6',
                            'Redbull':'#8b5cf6', 'Pasta':'#ec4899', 'ÇAY':'#ef4444',
                          };
                          const r = renkMap[g] || '#94a3b8';
                          return (
                            <div key={g} style={{
                              padding: '8px 12px', borderRadius: 6, minWidth: 110,
                              background: r + '22', border: `1px solid ${r}66`,
                            }}>
                              <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', fontWeight: 600 }}>{g}</div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: r }}>{Math.round(v.adet)}</div>
                              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtTL(v.ciro)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* PERSONEL SATIŞ ÖZETİ */}
                  {!subeUrunYukleniyor && subeUrunler?.personel && subeUrunler.personel.length > 0 && (
                    <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                        👤 Personel Satışları
                      </div>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                        {subeUrunler.personel.slice(0, 8).map((p) => (
                          <div key={p.personel_id} style={{
                            padding: '6px 10px', borderRadius: 4,
                            background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)',
                          }}>
                            <strong>{p.ad}</strong>
                            <span style={{ marginLeft: 6, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                              {p.fis_sayisi} fiş · {fmtTL(p.ciro)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {subeUrunYukleniyor && (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>
                      ⏳ Fatura detayları yükleniyor...
                    </div>
                  )}

                  {!subeUrunYukleniyor && subeUrunler?.hata && (
                    <div style={{ padding: 16, color: 'var(--red)' }}>{subeUrunler.hata}</div>
                  )}

                  {!subeUrunYukleniyor && subeUrunler?.urunler?.length > 0 && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                      {/* Ürün listesi */}
                      <div style={{ borderRight: '1px solid var(--border)' }}>
                        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                          ÜRÜN SATIŞLARI
                        </div>
                        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <tbody>
                              {subeUrunler.urunler.map((u, i) => (
                                <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}>
                                  <td style={{ padding: '7px 14px', color: 'var(--muted)', width: 24, fontSize: 12 }}>{i + 1}</td>
                                  <td style={{ padding: '7px 14px', fontWeight: i < 3 ? 600 : 400 }}>{u.urun}</td>
                                  <td style={{ padding: '7px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                    {Math.round(u.adet)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Malzeme özeti */}
                      <div>
                        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                          TAHMİNİ MALZEME KULLANIMI
                        </div>
                        {(() => {
                          // Ürün adından malzeme tahmin et
                          const malzeme = {};
                          const URUN_MALZEME = {
                            'ICE': 'Plastik Bardak', 'FROZEN': 'Plastik Bardak', 'BUZLU': 'Plastik Bardak',
                            '14 OZ': '14oz Karton Bardak', '8 OZ': '8oz Karton Bardak',
                            'SU': 'Su Şişesi', 'REDBULL': 'Kutu', 'ÇAY': 'Çay Bardağı',
                            'PASTA': 'Pasta Tabağı', 'MADEN': 'Maden Suyu Şişesi',
                          };
                          for (const u of subeUrunler.urunler) {
                            const adUpper = u.urun.toUpperCase();
                            let mal = null;
                            for (const [kw, m] of Object.entries(URUN_MALZEME)) {
                              if (adUpper.includes(kw)) { mal = m; break; }
                            }
                            if (mal) malzeme[mal] = (malzeme[mal] || 0) + u.adet;
                          }
                          return (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                              <tbody>
                                {Object.entries(malzeme).sort((a,b) => b[1]-a[1]).map(([mal, adet], i) => (
                                  <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}>
                                    <td style={{ padding: '9px 14px' }}>
                                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: MALZEME_RENK[mal] || '#94a3b8', marginRight: 6 }}/>
                                      {mal}
                                    </td>
                                    <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                                      {Math.round(adet)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {!subeUrunYukleniyor && subeUrunler?.urunler?.length === 0 && (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>Bu şubede ürün detayı bulunamadı.</div>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>

                {/* Kategori / Malzeme tablosu */}
                <div className="card" style={{ padding: 0 }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                    🧃 Kategori & Malzeme Kullanımı
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>tüm şubeler</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: 'var(--bg2)' }}>
                        <th style={{ padding: '8px 14px', textAlign: 'left', color: 'var(--muted)', fontWeight: 600, fontSize: 11 }}>KATEGORİ</th>
                        <th style={{ padding: '8px 14px', textAlign: 'center', color: 'var(--muted)', fontWeight: 600, fontSize: 11 }}>ADET</th>
                        <th style={{ padding: '8px 14px', textAlign: 'left', color: 'var(--muted)', fontWeight: 600, fontSize: 11 }}>MALZEME</th>
                        <th style={{ padding: '8px 14px', textAlign: 'right', color: 'var(--muted)', fontWeight: 600, fontSize: 11 }}>CİRO</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(subeAnaliz.grup_pasta || []).map((g, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600 }}>{g.kategori}</td>
                          <td style={{ padding: '9px 14px', textAlign: 'center' }}>
                            <span style={{
                              display: 'inline-block', padding: '2px 10px', borderRadius: 12,
                              background: (MALZEME_RENK[g.malzeme] || '#94a3b8') + '22',
                              color: MALZEME_RENK[g.malzeme] || 'var(--text)',
                              fontWeight: 700, fontSize: 13,
                            }}>{Math.round(g.adet)}</span>
                          </td>
                          <td style={{ padding: '9px 14px', fontSize: 12, color: 'var(--muted)' }}>
                            <span style={{
                              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                              background: MALZEME_RENK[g.malzeme] || '#94a3b8', marginRight: 6
                            }}/>
                            {g.malzeme}
                          </td>
                          <td style={{ padding: '9px 14px', textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
                            {fmtTL(g.ciro)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--bg2)' }}>
                        <td colSpan={4} style={{ padding: '8px 14px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}>
                          💡 Adet = o kategoriden bugün satılan → kullanılan malzeme
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* En çok satanlar */}
                <div className="card" style={{ padding: 0 }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>
                    🏆 En Çok Satılan Ürünler
                    <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>ilk 20</span>
                  </div>
                  <div style={{ maxHeight: 380, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <tbody>
                        {(subeAnaliz.cok_satilan || []).map((u, i) => (
                          <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}>
                            <td style={{ padding: '8px 14px', color: 'var(--muted)', width: 28, fontSize: 12 }}>
                              {i < 3 ? ['🥇','🥈','🥉'][i] : i + 1}
                            </td>
                            <td style={{ padding: '8px 14px', fontWeight: i < 3 ? 600 : 400 }}>{u.urun}</td>
                            <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                              {Math.round(u.adet)}
                            </td>
                            <td style={{ padding: '8px 14px', textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
                              {fmtTL(u.ciro)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Kasa / Banka özeti */}
              {((subeAnaliz.kasa || []).length > 0 || (subeAnaliz.banka || []).length > 0) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  {[
                    { baslik: '💵 Nakit Kasalar', veri: subeAnaliz.kasa },
                    { baslik: '💳 Pos / Banka', veri: subeAnaliz.banka },
                  ].map(({ baslik, veri: rows }) => (
                    <div key={baslik} className="card" style={{ padding: 0 }}>
                      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 14 }}>{baslik}</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <tbody>
                          {(rows || []).map((k, i) => (
                            <tr key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined }}>
                              <td style={{ padding: '9px 14px' }}>{k.ad}</td>
                              <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: 'var(--green)' }}>
                                {fmtTL(k.tutar)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ─── ÜRÜN SATIŞLARI SEKMESİ ─── */}
      {aktifSekme === 'urun' && (
        <>

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
        </>
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

            {/* Otomatik sync bilgisi */}
            <div style={{ background: '#0f172a', border: '1px solid #1e3a5f', borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#60a5fa', marginBottom: 6 }}>
                🤖 Otomatik Token (PC Zamanlayıcı)
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.6 }}>
                PC'de <strong style={{ color: '#e2e8f0' }}>Görev Zamanlayıcı</strong> kuruldu — her 2 saatte bir token otomatik yenilenir.<br/>
                PC açık ve <strong style={{ color: '#e2e8f0' }}>Chrome (Evvel ERP)</strong> kısayoluyla başlatılmışsa hiç el atmana gerek yok.
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#64748b' }}>
                📂 Log: <code style={{ fontSize: 10, background: '#1e293b', padding: '1px 5px', borderRadius: 3 }}>Desktop\YAPALIM\evvel_token_sync.log</code>
              </div>
            </div>

            {/* ADIM 2: Butona bas ve evobulut popup'ta açılır */}
            <div style={{ background: 'var(--bg2)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text)' }}>
                🚀 Manuel: Tek tıkla güncelle
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
