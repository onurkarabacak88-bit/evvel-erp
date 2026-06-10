import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const DURUM_CFG = {
  bekliyor:  { label: 'Bekliyor',  renk: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  ikon: '⏳' },
  gorusme:   { label: 'Görüşme',   renk: '#4a9eff', bg: 'rgba(74,158,255,0.12)',  ikon: '📞' },
  olumlu:    { label: 'Olumlu',    renk: '#4caf84', bg: 'rgba(76,175,132,0.12)',  ikon: '✅' },
  olumsuz:   { label: 'Olumsuz',   renk: '#e05c5c', bg: 'rgba(224,92,92,0.12)',   ikon: '❌' },
  arsiv:     { label: 'Arşiv',     renk: '#6b7280', bg: 'rgba(107,114,128,0.12)', ikon: '📦' },
};

const SKOR_CFG = {
  guclu:  { renk: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  iyi:    { renk: '#4a9eff', bg: 'rgba(74,158,255,0.12)',  border: 'rgba(74,158,255,0.3)'  },
  orta:   { renk: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
  zayif:  { renk: '#e05c5c', bg: 'rgba(224,92,92,0.12)',   border: 'rgba(224,92,92,0.3)'   },
};

const DENEYIM_LABEL = { var_1yil: '1 yıldan az', var_2yil: '1–3 yıl', var_uzun: '3+ yıl', kismi: 'Biraz biliyor', yok_ogreneyim: 'Yeni başlayacak' };
const BASLANGIC_LABEL = { hemen: '⚡ Hemen', '2hafta': '📅 2 Hafta', '1ay': '🗓️ 1 Ay' };
const CALISMA_LABEL = { tam: 'Tam Zamanlı', yari: 'Yarı Zamanlı', esnek: 'Esnek' };
const YASAM_LABEL   = { aile: '🏠 Aileyle', yurt: '🏫 Yurtta', arkadas: '👥 Arkadaşlarla', tek: '🔑 Tek başına' };
const EGITIM_LABEL  = { lise: '📚 Lise öğrencisi', universite: '🎓 Üniversite', mezun: '✅ Mezun', calisiyor: '💼 Çalışıyor+part-time', diger: '✨ Diğer' };
const ULASIM_LABEL  = { yurume: '🚶 Yürüme', toplu: '🚌 Toplu taşıma', arac: '🚗 Araç/moto', bisiklet: '🚲 Bisiklet' };
const NEDEN_LABEL   = { part_time: '💰 Ek gelir', tam_zamanli: '💼 Kariyer', barista: '☕ Barista olmak', deneyim: '📈 Deneyim', insan: '🙋 İnsanlarla çalışmak', diger: '✨ Diğer' };
const TEMPO_LABEL   = { hizli: '⚡ Hızlı tempo', sakin: '🌿 Sakin', ikisi: '😄 İkisi de olur' };

// Behavioral cevap etiketleri
const MAKINE_LABEL   = { hemen_siler: 'Hemen siler ✅', vardiya_sonu: 'Vardiya sonunda', kime_duserse: 'Kime düşerse', pek_dusunmem: 'Düşünmemiş ⚠️' };
const YOGUN_LABEL    = { araliklarda: 'Aralıklarda toplar ✅', rush_bitti: 'Rush sonrası', oldugu_gibi: 'Bırakır', fark_etmez: 'Fark etmez ⚠️' };
const GUNPLAN_LABEL  = { esnek_akis: 'Esnek ✅', plan_degisir: 'Esnek ama planlı', saatler_belli: 'Saate bağlı', onceden_netlesin: 'Katı plan 🚩' };
const ARKADASLAR_LABEL = { her_an_hazir: 'Her an hazır ✅', sakin_olculu: 'Sakin & ölçülü', kendi_isine: 'Kendi işine bakan', haklarini_bilen: 'Haklarını bilen 🚩' };
const SOSYAL_LABEL   = { dogal_isinirim: 'Doğal ısınır ✅', zaman_lazim: 'Zaman ister', karsi_baslasın: 'Bekleme', pek_rahat_degil: 'Zor ⚠️' };
const MUSTERI_LABEL  = { adini_ogrenip: 'Adını öğrenir ✅', selam_sorar: 'Selamlayıp sorar', hizlica_hazirlar: 'Hızlı geçer', hepsi_ayni: 'Fark etmez ⚠️' };
const SABAH_LABEL    = { kahve_icer: 'Gelir ✅', zor_gelir: 'Zor ama gelir', izin_dusunur: 'İzin düşünür 🚩', duruma_gore: 'Duruma göre' };
const YORUCU_LABEL   = { beklenmedik: 'Sürprizler', isler_uzayinca: 'Uzayan işler ⚠️', plan_disi: 'Plan dışı ⚠️', gunun_sonu: 'Günün sonu' };

function DurumBadge({ durum }) {
  const c = DURUM_CFG[durum] || DURUM_CFG.bekliyor;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: c.bg, color: c.renk, border: `1px solid ${c.renk}55` }}>
      {c.ikon} {c.label}
    </span>
  );
}

function SkorBadge({ skor }) {
  if (!skor) return null;
  const c = SKOR_CFG[skor.genel] || SKOR_CFG.orta;
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
      background: c.bg, color: c.renk, border: `1px solid ${c.border}`,
    }}>
      {skor.genel_label} · {skor.toplam}/100
    </span>
  );
}

function SkorPanel({ skor }) {
  if (!skor) return null;
  const c = SKOR_CFG[skor.genel] || SKOR_CFG.orta;
  return (
    <div style={{ background: '#12141c', border: `1px solid ${c.border}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
      {/* Genel skor */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, letterSpacing: 0.8, marginBottom: 4 }}>IK DEĞERLENDİRMESİ</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: c.renk }}>{skor.genel_label}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 900, color: c.renk, lineHeight: 1 }}>{skor.toplam}</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>/ 100 puan</div>
        </div>
      </div>

      {/* 5 boyut barları */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {Object.entries(skor.boyutlar).map(([key, b]) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600 }}>{b.label}</span>
              <span style={{ fontSize: 12, color: '#e8e9ec', fontWeight: 700 }}>{b.puan}/20</span>
            </div>
            <div style={{ height: 6, background: '#242736', borderRadius: 99 }}>
              <div style={{
                height: 6, borderRadius: 99,
                background: b.puan >= 16 ? '#34d399' : b.puan >= 12 ? '#4a9eff' : b.puan >= 8 ? '#f59e0b' : '#e05c5c',
                width: `${(b.puan / 20) * 100}%`,
                transition: 'width 0.6s ease',
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* Sinyaller */}
      {skor.sinyaller.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {skor.sinyaller.filter(s => s.tip === 'olumlu').map((s, i) => (
            <div key={i} style={{ fontSize: 12, color: '#34d399', display: 'flex', gap: 6 }}>
              <span>✅</span><span>{s.mesaj}</span>
            </div>
          ))}
          {skor.sinyaller.filter(s => s.tip === 'dikkat').map((s, i) => (
            <div key={i} style={{ fontSize: 12, color: '#f59e0b', display: 'flex', gap: 6 }}>
              <span>⚠️</span><span>{s.mesaj}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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
      onSil(b.id); onKapat();
    } catch (e) { alert(e.message); }
    finally { setYukleniyor(false); }
  };

  const tarihFmt = ts => ts
    ? new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  const Satir = ({ label, deger }) => deger ? (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #2a2d35' }}>
      <span style={{ color: '#6b7280', fontSize: 12, minWidth: 140, fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#e8e9ec', fontSize: 13, flex: 1 }}>{deger}</span>
    </div>
  ) : null;

  const Baslik = ({ label }) => (
    <div style={{ margin: '14px 0 6px', fontSize: 10, fontWeight: 800, color: '#4a9eff', letterSpacing: 1 }}>{label}</div>
  );

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onKapat()}
    >
      <div style={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', padding: 24 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e9ec' }}>{b.ad_soyad}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
              {tarihFmt(b.olusturma_ts)}{b.kaynak_sube ? ` · ${b.kaynak_sube}` : ''}
            </div>
          </div>
          <button onClick={onKapat} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 22, cursor: 'pointer', padding: 4 }}>✕</button>
        </div>

        {/* IK Skor Paneli */}
        <SkorPanel skor={b.skor} />

        {/* CV Detay */}
        <div style={{ marginBottom: 20 }}>
          <Satir label="📱 Telefon" deger={b.telefon} />
          <Satir label="📅 Doğum Yılı" deger={b.dogum_yili ? `${b.dogum_yili} · ${new Date().getFullYear() - b.dogum_yili} yaşında` : null} />
          <Satir label="📍 Semt" deger={b.ilce} />

          <Baslik label="YAŞAM & EĞİTİM" />
          <Satir label="🏠 Nerede Kalıyor" deger={YASAM_LABEL[b.yasam_durumu] || b.yasam_durumu} />
          <Satir label="🎓 Eğitim" deger={EGITIM_LABEL[b.egitim_durumu] || b.egitim_durumu} />
          <Satir label="🏫 Okul / Bölüm" deger={b.universite_bol} />
          <Satir label="⏰ En Erken Saat" deger={b.en_erken_saat === 'ogle' ? '🌞 Öğleden sonra' : b.en_erken_saat} />
          <Satir label="🚌 Ulaşım" deger={ULASIM_LABEL[b.ulasim] || b.ulasim} />

          <Baslik label="ÇALIŞMA TERCİHİ" />
          <Satir label="⏱️ Çalışma Şekli" deger={CALISMA_LABEL[b.calisma_tercihi] || b.calisma_tercihi} />
          <Satir label="📅 Müsait Günler" deger={(b.musait_gunler || []).join(', ') || null} />
          <Satir label="🚀 Başlangıç" deger={BASLANGIC_LABEL[b.baslangic] || b.baslangic} />
          {b.ek_not && (
            <div style={{ marginTop: 8, padding: 12, background: '#12151b', borderRadius: 8, border: '1px solid #2a2d35' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>EK NOT</div>
              <div style={{ fontSize: 13, color: '#d1d5db' }}>{b.ek_not}</div>
            </div>
          )}

          <Baslik label="DENEYİM & GEÇMİŞ" />
          <Satir label="☕ Kahve Deneyimi" deger={DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim} />
          <Satir label="💼 Önceki İş" deger={b.onceki_is} />
          {b.onceki_is_ogrenilen && (
            <div style={{ padding: '8px 0', borderBottom: '1px solid #2a2d35' }}>
              <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 4 }}>📘 En Çok Ne Öğrendi</div>
              <div style={{ fontSize: 13, color: '#e8e9ec', lineHeight: 1.6 }}>{b.onceki_is_ogrenilen}</div>
            </div>
          )}
          {b.onceki_is_iyi_zor && (
            <div style={{ padding: '8px 0', borderBottom: '1px solid #2a2d35' }}>
              <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 4 }}>⚖️ En İyi & En Zor</div>
              <div style={{ fontSize: 13, color: '#e8e9ec', lineHeight: 1.6 }}>{b.onceki_is_iyi_zor}</div>
            </div>
          )}

          <Baslik label="DAVRANIŞSAL YANIT (MASKELI SORULAR)" />
          <Satir label="☕ Makine sonrası" deger={MAKINE_LABEL[b.makine_sonrasi] || b.makine_sonrasi} />
          <Satir label="🧹 Yoğunlukta düzen" deger={YOGUN_LABEL[b.yogun_duzen] || b.yogun_duzen} />
          <Satir label="📅 Gün planlaması" deger={GUNPLAN_LABEL[b.gun_planlama] || b.gun_planlama} />
          <Satir label="👥 Arkadaşlar tanımı" deger={ARKADASLAR_LABEL[b.arkadaslar_tanim] || b.arkadaslar_tanim} />
          <Satir label="🤝 Sosyal yaklaşım" deger={SOSYAL_LABEL[b.sosyal_yaklasim] || b.sosyal_yaklasim} />
          <Satir label="☕ Müşteri bağı" deger={MUSTERI_LABEL[b.musteri_bagli] || b.musteri_bagli} />
          <Satir label="🌅 Sabah hazırlığı" deger={SABAH_LABEL[b.sabah_hazirlik] || b.sabah_hazirlik} />
          <Satir label="😓 En yorucu an" deger={YORUCU_LABEL[b.yorucu_an] || b.yorucu_an} />

          <Baslik label="MOTİVASYON & KİŞİLİK" />
          <Satir label="🎯 Neden Bu İş" deger={NEDEN_LABEL[b.neden_bu_is] || b.neden_bu_is} />
          <Satir label="⚡ Tempo Tercihi" deger={TEMPO_LABEL[b.tempo_tercihi] || b.tempo_tercihi} />
          <Satir label="👤 Referans" deger={b.referans_ad ? `${b.referans_ad}${b.referans_tel ? ' · ' + b.referans_tel : ''}` : null} />

          {b.tanitim && (
            <div style={{ marginTop: 12, padding: 14, background: '#12151b', borderRadius: 10, border: '1px solid #2a2d35' }}>
              <div style={{ fontSize: 11, color: '#4a9eff', fontWeight: 700, marginBottom: 6 }}>KENDİ TANITIMI</div>
              <div style={{ fontSize: 14, color: '#d1d5db', lineHeight: 1.7 }}>{b.tanitim}</div>
            </div>
          )}
        </div>

        {/* Durum Güncelleme */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginBottom: 10, letterSpacing: 0.5 }}>DURUMU GÜNCELLE</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(DURUM_CFG).map(([key, cfg]) => (
              <button key={key} onClick={() => durumGuncelle(key)} disabled={yukleniyor || durum === key}
                style={{
                  padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${cfg.renk}55`,
                  background: durum === key ? cfg.bg : 'transparent',
                  color: durum === key ? cfg.renk : '#6b7280',
                  fontSize: 12, fontWeight: 700,
                  cursor: durum === key ? 'default' : 'pointer',
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
              style={{ width: '100%', padding: 11, borderRadius: 10, border: '1px solid rgba(224,92,92,0.3)', background: 'rgba(224,92,92,0.06)', color: '#e05c5c', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              🗑️ CV'yi Sil
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={sil} disabled={yukleniyor}
                style={{ flex: 1, padding: 11, borderRadius: 10, border: 'none', background: '#e05c5c', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {yukleniyor ? '…' : 'Evet, Sil'}
              </button>
              <button onClick={() => setSilOnay(false)}
                style={{ flex: 1, padding: 11, borderRadius: 10, border: '1px solid #2a2d35', background: 'transparent', color: '#9ca3af', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
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
  const sc = b.skor ? SKOR_CFG[b.skor.genel] || SKOR_CFG.orta : null;
  const tarih = new Date(b.olusturma_ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  const yas = b.dogum_yili ? `${new Date().getFullYear() - b.dogum_yili}y` : '';

  return (
    <div onClick={onClick} style={{
      background: '#1a1d24', border: `1px solid ${c.renk}33`,
      borderRadius: 14, padding: '14px 16px', cursor: 'pointer',
      transition: 'border-color .15s, transform .1s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = c.renk + '88'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = c.renk + '33'; e.currentTarget.style.transform = 'none'; }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#e8e9ec' }}>{b.ad_soyad}</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
            {yas && <span>{yas} · </span>}
            {b.ilce && <span>{b.ilce} · </span>}
            <span>{tarih}</span>
          </div>
        </div>
        <DurumBadge durum={b.durum} />
      </div>

      {/* Skor badge */}
      {sc && b.skor && (
        <div style={{ marginBottom: 8 }}>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 20, fontWeight: 700,
            background: sc.bg, color: sc.renk, border: `1px solid ${sc.border}`,
          }}>
            {b.skor.genel_label} · {b.skor.toplam}/100
            {b.skor.dikkat_sayisi > 0 && <span style={{ marginLeft: 6, color: '#f59e0b' }}>⚠️×{b.skor.dikkat_sayisi}</span>}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {b.calisma_tercihi && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#12151b', color: '#9ca3af' }}>{b.calisma_tercihi === 'tam' ? 'Tam Z.' : b.calisma_tercihi === 'yari' ? 'Yarı Z.' : 'Esnek'}</span>}
        {b.kahve_deneyim && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: '#12151b', color: '#9ca3af' }}>{DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim}</span>}
        {b.en_erken_saat && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: 'rgba(74,158,255,0.08)', color: '#4a9eff' }}>⏰ {b.en_erken_saat === 'ogle' ? 'Öğle+' : b.en_erken_saat}</span>}
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

  const yukle = () => {
    setYukleniyor(true);
    Promise.all([api('/is-basvurusu'), api('/is-basvurusu/ozet')])
      .then(([liste, oz]) => { setBasvurular(liste); setOzet(oz); })
      .catch(console.error)
      .finally(() => setYukleniyor(false));
  };

  useEffect(() => { yukle(); }, []);

  const filtrelenmis = filtre === 'hepsi' ? basvurular : basvurular.filter(b => b.durum === filtre);
  const toplam = basvurular.length;

  const onGuncelle = (id, yeniDurum) => {
    setBasvurular(prev => prev.map(b => b.id === id ? { ...b, durum: yeniDurum } : b));
    setOzet(prev => {
      const eski = basvurular.find(b => b.id === id);
      if (!eski) return prev;
      const yeni = { ...prev };
      yeni[eski.durum] = Math.max(0, (yeni[eski.durum] || 1) - 1);
      yeni[yeniDurum] = (yeni[yeniDurum] || 0) + 1;
      return yeni;
    });
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(90px,1fr))', gap: 8 }}>
          {[
            { label: 'Toplam',      val: toplam,           renk: '#e8e9ec' },
            { label: '⏳ Bekleyen', val: ozet.bekliyor||0, renk: '#f59e0b' },
            { label: '📞 Görüşme',  val: ozet.gorusme||0,  renk: '#4a9eff' },
            { label: '✅ Olumlu',   val: ozet.olumlu||0,   renk: '#4caf84' },
            { label: '❌ Olumsuz',  val: ozet.olumsuz||0,  renk: '#e05c5c' },
            { label: '📦 Arşiv',    val: ozet.arsiv||0,    renk: '#6b7280' },
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
            padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: filtre === f.id ? 'var(--accent)' : 'var(--bg2)',
            color: filtre === f.id ? '#fff' : 'var(--text3)',
            border: `1px solid ${filtre === f.id ? 'var(--accent)' : 'var(--border)'}`,
          }}>
            {f.label}{f.id !== 'hepsi' && (ozet[f.id]||0) > 0 ? ` (${ozet[f.id]})` : ''}
          </button>
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

      {secili && (
        <CVModal b={secili} onKapat={() => setSecili(null)} onGuncelle={onGuncelle} onSil={onSil} />
      )}
    </div>
  );
}
