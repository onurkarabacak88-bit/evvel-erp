import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const DURUM_CFG = {
  bekliyor:  { label: 'Bekliyor',  renk: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  ikon: '⏳' },
  gorusme:   { label: 'Görüşme',   renk: '#4a9eff', bg: 'rgba(74,158,255,0.12)',  ikon: '📞' },
  olumlu:    { label: 'Olumlu',    renk: '#4caf84', bg: 'rgba(76,175,132,0.12)',  ikon: '✅' },
  olumsuz:   { label: 'Olumsuz',   renk: '#e05c5c', bg: 'rgba(224,92,92,0.12)',   ikon: '❌' },
  arsiv:     { label: 'Arşiv',     renk: '#6b7280', bg: 'rgba(107,114,128,0.12)', ikon: '📦' },
};

const POZ_LABEL     = { barista: '☕ Barista', kasiyer: '💵 Kasiyer', servis: '🙋 Servis', diger: '✨ Diğer' };
const DENEYIM_LABEL = { var_1yil: '1 yıldan az', var_2yil: '1–3 yıl', var_uzun: '3+ yıl', kismi: 'Biraz biliyor', yok_ogreneyim: 'Yeni başlayacak' };
const BASLANGIC_LABEL = { hemen: 'Hemen', '2hafta': '2 Hafta', '1ay': '1 Ay' };
const CALISMA_LABEL = { tam: 'Tam Zamanlı', yari: 'Yarı Zamanlı', esnek: 'Esnek' };
const YASAM_LABEL   = { aile: '🏠 Aileyle', yurt: '🏫 Yurtta', arkadas: '👥 Arkadaşlarla', tek: '🔑 Tek başına' };
const EGITIM_LABEL  = { lise: '📚 Lise öğrencisi', universite: '🎓 Üniversite', mezun: '✅ Mezun', calisiyor: '💼 Çalışıyor+part-time', diger: '✨ Diğer' };
const ULASIM_LABEL  = { yurume: '🚶 Yürüme', toplu: '🚌 Toplu taşıma', arac: '🚗 Araç/moto', bisiklet: '🚲 Bisiklet' };
const NEDEN_LABEL   = { part_time: '💰 Ek gelir', tam_zamanli: '💼 Kariyer', barista: '☕ Barista olmak', deneyim: '📈 Deneyim', insan: '🙋 İnsanlarla çalışmak', diger: '✨ Diğer' };
const TEMPO_LABEL   = { hizli: '⚡ Hızlı tempo', sakin: '🌿 Sakin', ikisi: '😄 İkisi de olur' };

function DurumBadge({ durum }) {
  const c = DURUM_CFG[durum] || DURUM_CFG.bekliyor;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: c.bg, color: c.renk, border: `1px solid ${c.renk}55` }}>
      {c.ikon} {c.label}
    </span>
  );
}

function CVModal({ b, onKapat, onGuncelle, onSil }) {
  const [durum, setDurum] = useState(b.durum);
  const [silOnay, setSilOnay] = useState(false);
  const [yukleniyor, setYukleniyor] = useState(false);

  const durumGuncelle = async (yeniDurum) => {
    setYukleniyor(true);
    try {
      await api(`/is-basvurusu/${b.id}/durum`, { method: 'PATCH', body: { durum: yeniDurum } });
      setDurum(yeniDurum);
      onGuncelle(b.id, yeniDurum);
    } catch (e) { alert(e.message); }
    finally { setYukleniyor(false); }
  };

  const sil = async () => {
    setYukleniyor(true);
    try {
      await api(`/is-basvurusu/${b.id}`, { method: 'DELETE' });
      onSil(b.id);
      onKapat();
    } catch (e) { alert(e.message); }
    finally { setYukleniyor(false); }
  };

  const tarihFmt = (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const Satir = ({ label, deger }) => deger ? (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #2a2d35' }}>
      <span style={{ color: '#6b7280', fontSize: 12, minWidth: 130, fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#e8e9ec', fontSize: 13, flex: 1 }}>{deger}</span>
    </div>
  ) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onKapat()}>
      <div style={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', padding: 24 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e9ec' }}>{b.ad_soyad}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
              {tarihFmt(b.olusturma_ts)} {b.kaynak_sube ? `· ${b.kaynak_sube}` : ''}
            </div>
          </div>
          <button onClick={onKapat} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 22, cursor: 'pointer', padding: 4 }}>✕</button>
        </div>

        {/* CV Detay */}
        <div style={{ marginBottom: 20 }}>
          <Satir label="📱 Telefon" deger={b.telefon} />
          <Satir label="📅 Doğum Yılı" deger={b.dogum_yili ? `${b.dogum_yili} · ${new Date().getFullYear() - b.dogum_yili} yaşında` : null} />
          <Satir label="📍 Semt" deger={b.ilce} />

          {/* Yaşam & Eğitim — sabah vardiyası sinyalleri */}
          <div style={{ margin: '10px 0 4px', fontSize: 10, fontWeight: 800, color: '#4a9eff', letterSpacing: 1 }}>YAŞAM DURUMU</div>
          <Satir label="🏠 Nerede Kalıyor" deger={YASAM_LABEL[b.yasam_durumu] || b.yasam_durumu} />
          <Satir label="🎓 Eğitim" deger={EGITIM_LABEL[b.egitim_durumu] || b.egitim_durumu} />
          <Satir label="🏫 Okul / Bölüm" deger={b.universite_bol} />
          <Satir label="⏰ En Erken Saat" deger={b.en_erken_saat === 'ogle' ? '🌞 Öğleden sonra' : b.en_erken_saat} />
          <Satir label="🚌 Ulaşım" deger={ULASIM_LABEL[b.ulasim] || b.ulasim} />

          {/* Pozisyon & Tercih */}
          <div style={{ margin: '10px 0 4px', fontSize: 10, fontWeight: 800, color: '#4a9eff', letterSpacing: 1 }}>POZİSYON & TERCİH</div>
          <Satir label="💼 Pozisyon" deger={POZ_LABEL[b.pozisyon] || b.pozisyon} />
          <Satir label="🏪 Tercih Şube" deger={(b.tercih_subeler || []).join(', ') || null} />
          <Satir label="⏱️ Çalışma Şekli" deger={CALISMA_LABEL[b.calisma_tercihi] || b.calisma_tercihi} />
          <Satir label="📅 Müsait Günler" deger={(b.musait_gunler || []).join(', ') || null} />
          <Satir label="🚀 Başlangıç" deger={BASLANGIC_LABEL[b.baslangic] || b.baslangic} />

          {/* Deneyim */}
          <div style={{ margin: '10px 0 4px', fontSize: 10, fontWeight: 800, color: '#4a9eff', letterSpacing: 1 }}>DENEYİM</div>
          <Satir label="☕ Kahve Deneyimi" deger={DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim} />
          <Satir label="💼 Önceki İş" deger={b.onceki_is} />

          {/* Kişilik */}
          <div style={{ margin: '10px 0 4px', fontSize: 10, fontWeight: 800, color: '#4a9eff', letterSpacing: 1 }}>KİŞİLİK</div>
          <Satir label="🎯 Neden Bu İş" deger={NEDEN_LABEL[b.neden_bu_is] || b.neden_bu_is} />
          <Satir label="⚡ Tempo Tercihi" deger={TEMPO_LABEL[b.tempo_tercihi] || b.tempo_tercihi} />
          <Satir label="💪 Güçlü Yönü" deger={b.gucluk_yonu} />

          <Satir label="👤 Referans" deger={b.referans_ad ? `${b.referans_ad}${b.referans_tel ? ' · ' + b.referans_tel : ''}` : null} />
          {b.tanitim && (
            <div style={{ marginTop: 12, padding: 14, background: '#12151b', borderRadius: 10, border: '1px solid #2a2d35' }}>
              <div style={{ fontSize: 11, color: '#4a9eff', fontWeight: 700, marginBottom: 6 }}>KENDİNİ TANITIMI</div>
              <div style={{ fontSize: 14, color: '#d1d5db', lineHeight: 1.7 }}>{b.tanitim}</div>
            </div>
          )}
        </div>

        {/* Durum Güncelleme */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 10, letterSpacing: 0.5 }}>DURUMU GÜNCELLE</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(DURUM_CFG).map(([key, cfg]) => (
              <button key={key}
                onClick={() => durumGuncelle(key)}
                disabled={yukleniyor || durum === key}
                style={{
                  padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${cfg.renk}55`,
                  background: durum === key ? cfg.bg : 'transparent',
                  color: durum === key ? cfg.renk : '#6b7280',
                  fontSize: 12, fontWeight: 700, cursor: durum === key ? 'default' : 'pointer',
                  opacity: yukleniyor ? 0.6 : 1,
                }}>
                {cfg.ikon} {cfg.label}{durum === key ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>

        {/* Sil */}
        <div style={{ borderTop: '1px solid #2a2d35', paddingTop: 16 }}>
          {!silOnay ? (
            <button onClick={() => setSilOnay(true)}
              style={{ width: '100%', padding: '11px', borderRadius: 10, border: '1px solid rgba(224,92,92,0.3)', background: 'rgba(224,92,92,0.06)', color: '#e05c5c', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              🗑️ CV'yi Sil
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={sil} disabled={yukleniyor}
                style={{ flex: 1, padding: '11px', borderRadius: 10, border: 'none', background: '#e05c5c', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {yukleniyor ? '…' : 'Evet, Sil'}
              </button>
              <button onClick={() => setSilOnay(false)}
                style={{ flex: 1, padding: '11px', borderRadius: 10, border: '1px solid #2a2d35', background: 'transparent', color: '#9ca3af', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                Vazgeç
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BasvuruKart({ b, onClick }) {
  const c = DURUM_CFG[b.durum] || DURUM_CFG.bekliyor;
  const tarih = new Date(b.olusturma_ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  const yil = b.dogum_yili ? `${new Date().getFullYear() - b.dogum_yili}y` : '';
  return (
    <div onClick={onClick} style={{
      background: '#1a1d24', border: `1px solid ${c.renk}33`,
      borderRadius: 12, padding: '14px 16px', cursor: 'pointer',
      transition: 'border-color .15s, transform .1s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = c.renk + '88'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = c.renk + '33'; e.currentTarget.style.transform = 'none'; }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#e8e9ec' }}>{b.ad_soyad}</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            {yil && <span>{yil} · </span>}
            {b.ilce && <span>{b.ilce} · </span>}
            <span>{tarih}</span>
          </div>
        </div>
        <DurumBadge durum={b.durum} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {b.pozisyon && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#12151b', color: '#9ca3af' }}>{POZ_LABEL[b.pozisyon] || b.pozisyon}</span>}
        {b.calisma_tercihi && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#12151b', color: '#9ca3af' }}>{CALISMA_LABEL[b.calisma_tercihi] || b.calisma_tercihi}</span>}
        {b.kahve_deneyim && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#12151b', color: '#9ca3af' }}>{DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim}</span>}
        {(b.tercih_subeler || []).slice(0, 2).map(s => <span key={s} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: 'rgba(74,158,255,0.08)', color: '#4a9eff' }}>📍{s}</span>)}
      </div>
    </div>
  );
}

export default function IsBasvuruListesi() {
  const [basvurular, setBasvurular] = useState([]);
  const [ozet, setOzet]            = useState({});
  const [secili, setSecili]        = useState(null);
  const [filtre, setFiltre]        = useState('hepsi');
  const [yukleniyor, setYukleniyor]= useState(true);
  const [qrGoster, setQrGoster]   = useState(false);

  const yukle = () => {
    setYukleniyor(true);
    Promise.all([
      api('/is-basvurusu'),
      api('/is-basvurusu/ozet'),
    ]).then(([liste, oz]) => {
      setBasvurular(liste);
      setOzet(oz);
    }).catch(console.error)
    .finally(() => setYukleniyor(false));
  };

  useEffect(() => { yukle(); }, []);

  const filtrelenmis = filtre === 'hepsi' ? basvurular : basvurular.filter(b => b.durum === filtre);
  const toplam = basvurular.length;

  const onGuncelle = (id, yeniDurum) => {
    setBasvurular(prev => prev.map(b => b.id === id ? { ...b, durum: yeniDurum } : b));
    // ozet güncelle
    yukle();
  };
  const onSil = (id) => setBasvurular(prev => prev.filter(b => b.id !== id));

  return (
    <div className="page">
      <div className="page-header">
        <h2>💼 İş Başvuruları</h2>
        <p>Gelen CV'leri incele, görüşme planla</p>
      </div>

      {/* QR + İstatistik */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 16, marginBottom: 20 }}>
        {/* QR Kart */}
        <div style={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 150 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 6 }}>
            <img src="/api/is-basvurusu/qr/indir" alt="Başvuru QR"
              style={{ width: 100, height: 100, display: 'block' }}
              onError={e => { e.target.style.display = 'none'; }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#e8e9ec', textAlign: 'center' }}>Başvuru QR</div>
          <a href="/api/is-basvurusu/qr/indir" download="evvel_is_basvurusu_qr.png"
            style={{ fontSize: 11, padding: '6px 12px', borderRadius: 8, background: '#4a9eff', color: '#fff', textDecoration: 'none', fontWeight: 700 }}>
            ⬇ İndir
          </a>
        </div>

        {/* Özet istatistikler */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(90px,1fr))', gap: 8 }}>
          {[
            { label: 'Toplam', val: toplam, renk: '#e8e9ec' },
            { label: '⏳ Bekleyen', val: ozet.bekliyor || 0, renk: '#f59e0b' },
            { label: '📞 Görüşme', val: ozet.gorusme  || 0, renk: '#4a9eff' },
            { label: '✅ Olumlu',  val: ozet.olumlu   || 0, renk: '#4caf84' },
            { label: '❌ Olumsuz', val: ozet.olumsuz  || 0, renk: '#e05c5c' },
            { label: '📦 Arşiv',   val: ozet.arsiv    || 0, renk: '#6b7280' },
          ].map(k => (
            <div key={k.label} style={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: k.renk }}>{k.val}</div>
              <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Filtre */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[{ id: 'hepsi', label: 'Tümü' }, ...Object.entries(DURUM_CFG).map(([id, c]) => ({ id, label: c.ikon + ' ' + c.label }))].map(f => (
          <button key={f.id} onClick={() => setFiltre(f.id)} style={{
            padding: '6px 14px', borderRadius: 20, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: filtre === f.id ? 'var(--accent)' : 'var(--bg2)',
            color: filtre === f.id ? '#fff' : 'var(--text3)',
            border: `1px solid ${filtre === f.id ? 'var(--accent)' : 'var(--border)'}`,
          }}>{f.label} {f.id !== 'hepsi' && (ozet[f.id] || 0) > 0 ? `(${ozet[f.id]})` : ''}</button>
        ))}
      </div>

      {/* Liste */}
      {yukleniyor ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Yükleniyor…
        </div>
      ) : filtrelenmis.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          {filtre === 'hepsi' ? (
            <div>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Henüz başvuru yok</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>QR kodu yazdırın ve şubenize asın</div>
            </div>
          ) : 'Bu durumda başvuru yok.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
          {filtrelenmis.map(b => (
            <BasvuruKart key={b.id} b={b} onClick={() => setSecili(b)} />
          ))}
        </div>
      )}

      {/* CV Modal */}
      {secili && (
        <CVModal
          b={secili}
          onKapat={() => setSecili(null)}
          onGuncelle={onGuncelle}
          onSil={onSil}
        />
      )}
    </div>
  );
}
