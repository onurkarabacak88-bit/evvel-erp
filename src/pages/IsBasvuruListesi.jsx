import { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';

// Durum = SADECE iş akışı (öncelik & arşiv & işe-alındı AYRI boyutlar)
const DURUM_CFG = {
  bekliyor: { label: 'Bekliyor', renk: 'var(--orange)', bg: 'rgba(245,158,11,0.12)', ikon: '⏳' },
  gorusme:  { label: 'Görüşme',  renk: '#4a9eff', bg: 'rgba(74,158,255,0.12)', ikon: '📞' },
  olumlu:   { label: 'Olumlu',   renk: '#4caf84', bg: 'rgba(76,175,132,0.12)', ikon: '✅' },
  olumsuz:  { label: 'Olumsuz',  renk: '#e05c5c', bg: 'rgba(224,92,92,0.12)',  ikon: '❌' },
};
// Öncelik = arşivde bile korunan ayrı işaret
const ONCELIK_CFG = {
  1: { label: '1. Öncelik', renk: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  ikon: '🥇' },
  2: { label: '2. Öncelik', renk: '#a78bfa', bg: 'rgba(167,139,250,0.12)', ikon: '🥈' },
};

const SKOR_CFG = {
  guclu:  { renk: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.3)'  },
  iyi:    { renk: '#4a9eff', bg: 'rgba(74,158,255,0.12)',  border: 'rgba(74,158,255,0.3)'  },
  orta:   { renk: 'var(--orange)', bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.3)'  },
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

const NEREDE_LABEL   = { kurumsal: '🏢 Kurumsal zincir', yerel_bagimsiz: '☕ Yerel/bağımsız', sektor_disi: '🔄 Sektör dışı', hic_calismadim: '🌱 İlk iş' };
const OGRENILEN_LABEL = { musteri_iletisim: '💬 Müşteri iletişimi', hiz_tempo: '⚡ Hız & tempo', duzen_temizlik: '🧹 Düzen & temizlik ✅', takim: '🤝 Takım çalışması', tek_sorumluluk: '🎯 Tek sorumluluk', cok_ogrenmedim: '🤷 Az öğrendi ⚠️' };
const EN_IYI_LABEL   = { musteri_insan: '👥 Müşteri ilişkileri', tempolu_ortam: '🏃 Tempolu ortam ✅', ogrenme: '📚 Öğrenme fırsatı', ekip: '💪 Ekip', para_bagimsizlik: '💰 Para/bağımsızlık' };
const EN_ZOR_LABEL   = { uzun_saatler: '⏰ Uzun saatler 🚩', zor_musteriler: '😤 Zor müşteriler ⚠️', dusuk_ucret: '💸 Düşük ücret', yonetim_sorun: '🚧 Yönetim sorunu ⚠️', monoton: '😴 Monoton' };
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

function OncelikBadge({ oncelik }) {
  const c = ONCELIK_CFG[oncelik];
  if (!c) return null;
  return (
    <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: c.bg, color: c.renk, border: `1px solid ${c.renk}55` }}>
      {c.ikon} {c.label}
    </span>
  );
}

function SkorPanel({ skor }) {
  if (!skor) return null;
  const c = SKOR_CFG[skor.genel] || SKOR_CFG.orta;
  return (
    <div style={{ background: 'var(--bg3)', border: `1px solid ${c.border}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 700, letterSpacing: 0.8, marginBottom: 4 }}>IK DEĞERLENDİRMESİ</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: c.renk }}>{skor.genel_label}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 900, color: c.renk, lineHeight: 1 }}>{skor.toplam}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)' }}>/ 100 puan</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {Object.entries(skor.boyutlar).map(([key, b]) => (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>{b.label}</span>
              <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 700 }}>{b.puan}/20</span>
            </div>
            <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 99 }}>
              <div style={{ height: 6, borderRadius: 99, background: b.puan >= 16 ? '#34d399' : b.puan >= 12 ? 'var(--accent)' : b.puan >= 8 ? 'var(--orange)' : '#e05c5c', width: `${(b.puan / 20) * 100}%`, transition: 'width 0.6s ease' }} />
            </div>
          </div>
        ))}
      </div>
      {skor.sinyaller.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {skor.sinyaller.filter(s => s.tip === 'olumlu').map((s, i) => (<div key={i} style={{ fontSize: 12, color: '#34d399', display: 'flex', gap: 6 }}><span>✅</span><span>{s.mesaj}</span></div>))}
          {skor.sinyaller.filter(s => s.tip === 'dikkat').map((s, i) => (<div key={i} style={{ fontSize: 12, color: 'var(--orange)', display: 'flex', gap: 6 }}><span>⚠️</span><span>{s.mesaj}</span></div>))}
          {skor.sinyaller.filter(s => s.tip === 'tutarsizlik').map((s, i) => (<div key={i} style={{ fontSize: 12, color: '#a78bfa', display: 'flex', gap: 6 }}><span>🔍</span><span>{s.mesaj}</span></div>))}
        </div>
      )}
    </div>
  );
}

function CVModal({ b, onKapat, onPatch, onSil }) {
  const [yukleniyor, setYukleniyor] = useState(false);
  const [silOnay, setSilOnay] = useState(false);
  const durum = b.durum;
  const oncelik = b.oncelik || 0;

  const istek = async (fn) => { setYukleniyor(true); try { await fn(); } catch (e) { alert(e.message); } finally { setYukleniyor(false); } };

  const durumGuncelle = (yeniDurum) => istek(async () => {
    await api(`/is-basvurusu/${b.id}/durum`, { method: 'PATCH', body: { durum: yeniDurum } });
    onPatch(b.id, { durum: yeniDurum });
  });
  const oncelikSet = (onc) => istek(async () => {
    await api(`/is-basvurusu/${b.id}/oncelik`, { method: 'PATCH', body: { oncelik: onc } });
    onPatch(b.id, { oncelik: onc });
  });
  const arsivToggle = () => istek(async () => {
    const yeni = !b.arsivli;
    await api(`/is-basvurusu/${b.id}/arsiv`, { method: 'PATCH', body: { arsivli: yeni } });
    onPatch(b.id, { arsivli: yeni });
  });
  const iseAl = () => {
    if (b.ise_alindi) return;
    if (!window.confirm(`İŞE AL — PERSONEL EKLE\n\n${b.ad_soyad}\n📱 ${b.telefon}\n\nBu kişiyi personel listesine ekleyeyim mi?`)) return;
    istek(async () => {
      const r = await api(`/is-basvurusu/${b.id}/ise-al`, { method: 'POST', body: {} });
      onPatch(b.id, { ise_alindi: true, personel_id: r.personel_id, durum: 'olumlu' });
      alert(`✅ ${b.ad_soyad} personele eklendi.\nPersonel & Maaş ekranından maaş/şube bilgilerini tamamlayabilirsin.`);
    });
  };
  const sil = () => istek(async () => { await api(`/is-basvurusu/${b.id}`, { method: 'DELETE' }); onSil(b.id); onKapat(); });

  const tarihFmt = ts => ts ? new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const Satir = ({ label, deger }) => deger ? (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text2)', fontSize: 12, minWidth: 140, fontWeight: 600 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontSize: 13, flex: 1 }}>{deger}</span>
    </div>
  ) : null;
  const Baslik = ({ label }) => (<div style={{ margin: '14px 0 6px', fontSize: 10, fontWeight: 800, color: 'var(--accent)', letterSpacing: 1 }}>{label}</div>);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={e => e.target === e.currentTarget && onKapat()}>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{b.ad_soyad}</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 4 }}>{tarihFmt(b.olusturma_ts)}{b.kaynak_sube ? ` · ${b.kaynak_sube}` : ''}</div>
          </div>
          <button onClick={onKapat} style={{ background: 'none', border: 'none', color: 'var(--text2)', fontSize: 22, cursor: 'pointer', padding: 4 }}>✕</button>
        </div>

        {/* Rozetler: durum + öncelik + işe-alındı */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <DurumBadge durum={b.durum} />
          <OncelikBadge oncelik={oncelik} />
          {b.ise_alindi && <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(52,211,153,0.14)', color: '#34d399', border: '1px solid #34d39955' }}>👤 İşe Alındı</span>}
          {b.arsivli && <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(107,114,128,0.14)', color: 'var(--text2)', border: '1px solid #6b728055' }}>📦 Arşivde</span>}
        </div>

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
            <div style={{ marginTop: 8, padding: 12, background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>EK NOT</div>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>{b.ek_not}</div>
            </div>
          )}
          <Baslik label="DENEYİM & GEÇMİŞ" />
          <Satir label="☕ Kahve Deneyimi" deger={DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim} />
          <Satir label="💼 Önceki İş" deger={b.onceki_is} />
          {b.onceki_is_ogrenilen && (<div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><div style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, marginBottom: 4 }}>📘 En Çok Ne Öğrendi</div><div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>{b.onceki_is_ogrenilen}</div></div>)}
          {b.onceki_is_iyi_zor && (<div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}><div style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, marginBottom: 4 }}>⚖️ En İyi & En Zor</div><div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>{b.onceki_is_iyi_zor}</div></div>)}
          <Baslik label="DAVRANIŞSAL YANIT (MASKELI SORULAR)" />
          <Satir label="☕ Makine sonrası" deger={MAKINE_LABEL[b.makine_sonrasi] || b.makine_sonrasi} />
          <Satir label="🧹 Yoğunlukta düzen" deger={YOGUN_LABEL[b.yogun_duzen] || b.yogun_duzen} />
          <Satir label="📅 Gün planlaması" deger={GUNPLAN_LABEL[b.gun_planlama] || b.gun_planlama} />
          <Satir label="👥 Arkadaşlar tanımı" deger={ARKADASLAR_LABEL[b.arkadaslar_tanim] || b.arkadaslar_tanim} />
          <Satir label="🤝 Sosyal yaklaşım" deger={SOSYAL_LABEL[b.sosyal_yaklasim] || b.sosyal_yaklasim} />
          <Satir label="☕ Müşteri bağı" deger={MUSTERI_LABEL[b.musteri_bagli] || b.musteri_bagli} />
          <Satir label="🌅 Sabah hazırlığı" deger={SABAH_LABEL[b.sabah_hazirlik] || b.sabah_hazirlik} />
          <Satir label="😓 En yorucu an" deger={YORUCU_LABEL[b.yorucu_an] || b.yorucu_an} />
          <Baslik label="DENEYİM GEÇMİŞİ (YAPISAL)" />
          <Satir label="🏢 Nerede çalıştı" deger={NEREDE_LABEL[b.nerede_calistim] || b.nerede_calistim} />
          {b.nerede_calistim && b.nerede_calistim !== 'hic_calismadim' && <>
            <Satir label="📚 Ne öğrendi" deger={OGRENILEN_LABEL[b.is_ogrenilen] || b.is_ogrenilen} />
            <Satir label="✨ En iyi yanı" deger={EN_IYI_LABEL[b.isten_en_iyi] || b.isten_en_iyi} />
            <Satir label="⚠️ En zor yanı" deger={EN_ZOR_LABEL[b.isten_en_zor] || b.isten_en_zor} />
          </>}
          <Baslik label="MOTİVASYON & KİŞİLİK" />
          <Satir label="🎯 Neden Bu İş" deger={NEDEN_LABEL[b.neden_bu_is] || b.neden_bu_is} />
          <Satir label="⚡ Tempo Tercihi" deger={TEMPO_LABEL[b.tempo_tercihi] || b.tempo_tercihi} />
          <Satir label="👤 Referans" deger={b.referans_ad ? `${b.referans_ad}${b.referans_tel ? ' · ' + b.referans_tel : ''}` : null} />
          {b.tanitim && (<div style={{ marginTop: 12, padding: 14, background: 'var(--bg3)', borderRadius: 10, border: '1px solid var(--border)' }}><div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, marginBottom: 6 }}>KENDİ TANITIMI</div><div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.7 }}>{b.tanitim}</div></div>)}
        </div>

        {/* İŞE AL — PERSONEL EKLE */}
        <div style={{ marginBottom: 16 }}>
          <button onClick={iseAl} disabled={yukleniyor || b.ise_alindi}
            style={{ width: '100%', padding: 13, borderRadius: 12, border: 'none',
              background: b.ise_alindi ? 'rgba(52,211,153,0.15)' : '#34d399',
              color: b.ise_alindi ? '#34d399' : '#06281d', fontSize: 14, fontWeight: 800,
              cursor: b.ise_alindi ? 'default' : 'pointer', opacity: yukleniyor ? 0.6 : 1 }}>
            {b.ise_alindi ? '✅ İşe Alındı (personele eklendi)' : '👤 İşe Al / Personel Ekle'}
          </button>
        </div>

        {/* DURUM */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, letterSpacing: 0.5 }}>DURUM</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(DURUM_CFG).map(([key, cfg]) => (
              <button key={key} onClick={() => durumGuncelle(key)} disabled={yukleniyor || durum === key}
                style={{ padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${cfg.renk}55`, background: durum === key ? cfg.bg : 'transparent', color: durum === key ? cfg.renk : 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: durum === key ? 'default' : 'pointer', opacity: yukleniyor ? 0.6 : 1 }}>
                {cfg.ikon} {cfg.label}{durum === key ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>

        {/* ÖNCELİK (arşivde bile korunur) */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, letterSpacing: 0.5 }}>ÖNCELİK</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {[1, 2].map(o => {
              const cfg = ONCELIK_CFG[o];
              return (
                <button key={o} onClick={() => oncelikSet(oncelik === o ? 0 : o)} disabled={yukleniyor}
                  style={{ padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${cfg.renk}55`, background: oncelik === o ? cfg.bg : 'transparent', color: oncelik === o ? cfg.renk : 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: yukleniyor ? 0.6 : 1 }}>
                  {cfg.ikon} {cfg.label}{oncelik === o ? ' ✓' : ''}
                </button>
              );
            })}
            {oncelik > 0 && (
              <button onClick={() => oncelikSet(0)} disabled={yukleniyor}
                style={{ padding: '8px 12px', borderRadius: 20, border: '1.5px solid #6b728055', background: 'transparent', color: 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                ✖ Önceliği Kaldır
              </button>
            )}
          </div>
        </div>

        {/* ARŞİV + SİL */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={arsivToggle} disabled={yukleniyor}
            style={{ width: '100%', padding: 11, borderRadius: 10, border: '1px solid #6b728055', background: 'rgba(107,114,128,0.08)', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            {b.arsivli ? '📤 Arşivden Çıkar' : '📦 Arşivle (öncelik & durum korunur)'}
          </button>
          {!silOnay ? (
            <button onClick={() => setSilOnay(true)}
              style={{ width: '100%', padding: 11, borderRadius: 10, border: '1px solid rgba(224,92,92,0.3)', background: 'rgba(224,92,92,0.06)', color: '#e05c5c', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              🗑️ CV'yi Kalıcı Sil
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={sil} disabled={yukleniyor} style={{ flex: 1, padding: 11, borderRadius: 10, border: 'none', background: '#e05c5c', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{yukleniyor ? '…' : 'Evet, Sil'}</button>
              <button onClick={() => setSilOnay(false)} style={{ flex: 1, padding: 11, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Vazgeç</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BasvuruKart({ b, onClick, secili, onSec }) {
  const c = DURUM_CFG[b.durum] || DURUM_CFG.bekliyor;
  const oc = ONCELIK_CFG[b.oncelik] || null;
  const sc = b.skor ? SKOR_CFG[b.skor.genel] || SKOR_CFG.orta : null;
  const renk = oc ? oc.renk : c.renk;
  const tarih = new Date(b.olusturma_ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) + ' · ' + new Date(b.olusturma_ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const yas = b.dogum_yili ? `${new Date().getFullYear() - b.dogum_yili}y` : '';

  return (
    <div onClick={onClick} style={{
      position: 'relative', background: 'var(--bg2)', border: `1px solid ${secili ? 'var(--accent)' : renk + '33'}`,
      borderRadius: 14, padding: '14px 16px 14px 40px', cursor: 'pointer', transition: 'border-color .15s, transform .1s',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = renk + '88'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = secili ? 'var(--accent)' : renk + '33'; }}>

      {/* Tik (checkbox) — kart tıklamasını engeller */}
      <input type="checkbox" checked={secili} onClick={e => e.stopPropagation()} onChange={() => onSec(b.id)}
        style={{ position: 'absolute', top: 14, left: 14, width: 16, height: 16, cursor: 'pointer' }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8, gap: 6 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{b.ad_soyad}</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>
            {yas && <span>{yas} · </span>}{b.ilce && <span>{b.ilce} · </span>}<span>{tarih}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
          <DurumBadge durum={b.durum} />
          {oc && <OncelikBadge oncelik={b.oncelik} />}
        </div>
      </div>

      {sc && b.skor && (
        <div style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, fontWeight: 700, background: sc.bg, color: sc.renk, border: `1px solid ${sc.border}` }}>
            {b.skor.genel_label} · {b.skor.toplam}/100
            {b.skor.dikkat_sayisi > 0 && <span style={{ marginLeft: 6, color: 'var(--orange)' }}>⚠️×{b.skor.dikkat_sayisi}</span>}
            {b.skor.tutarsizlik_sayisi > 0 && <span style={{ marginLeft: 6, color: '#a78bfa' }}>🔍×{b.skor.tutarsizlik_sayisi}</span>}
          </span>
        </div>
      )}
      {b.ise_alindi && <div style={{ marginBottom: 8 }}><span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 20, fontWeight: 700, background: 'rgba(52,211,153,0.14)', color: '#34d399', border: '1px solid #34d39955' }}>👤 İşe Alındı</span></div>}
      {!b.goruldu_ts && (<div style={{ position: 'absolute', top: 10, right: 10, width: 10, height: 10, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 0 3px rgba(34,197,94,0.18)' }} title="Yeni" />)}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {b.calisma_tercihi && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text2)' }}>{b.calisma_tercihi === 'tam' ? 'Tam Z.' : b.calisma_tercihi === 'yari' ? 'Yarı Z.' : 'Esnek'}</span>}
        {b.kahve_deneyim && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text2)' }}>{DENEYIM_LABEL[b.kahve_deneyim] || b.kahve_deneyim}</span>}
      </div>
    </div>
  );
}

export default function IsBasvuruListesi() {
  const [basvurular, setBasvurular] = useState([]);
  const [ozet, setOzet]            = useState({});
  const [secili, setSecili]        = useState(null);     // açık CV
  const [secimler, setSecimler]    = useState(new Set()); // tiklenenler
  const [filtre, setFiltre]        = useState('hepsi');
  const [view, setView]            = useState('aktif');   // aktif | arsiv
  const [yukleniyor, setYukleniyor]= useState(true);
  const [arama, setArama]          = useState('');
  const [siralama, setSiralama]    = useState('tarih');
  const [topluYukleniyor, setTopluYukleniyor] = useState(false);

  const yukle = () => {
    setYukleniyor(true);
    const q = view === 'arsiv' ? '?arsivli=true' : '';
    Promise.all([api('/is-basvurusu' + q), api('/is-basvurusu/ozet')])
      .then(([liste, oz]) => { setBasvurular(liste); setOzet(oz); })
      .catch(console.error)
      .finally(() => setYukleniyor(false));
  };
  useEffect(() => { setSecimler(new Set()); yukle(); }, [view]);

  const aramaKucuk = arama.toLowerCase().trim();
  const filtrelenmis = basvurular
    .filter(b => {
      if (filtre === 'oncelik1' && b.oncelik !== 1) return false;
      if (filtre === 'oncelik2' && b.oncelik !== 2) return false;
      if (filtre === 'ise_alindi' && !b.ise_alindi) return false;
      if (DURUM_CFG[filtre] && b.durum !== filtre) return false;
      if (aramaKucuk) {
        const ad = (b.ad_soyad || '').toLowerCase();
        const tel = (b.telefon || '').toLowerCase();
        if (!ad.includes(aramaKucuk) && !tel.includes(aramaKucuk)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (siralama === 'skor_desc') return (b.skor?.toplam || 0) - (a.skor?.toplam || 0);
      if (siralama === 'skor_asc')  return (a.skor?.toplam || 0) - (b.skor?.toplam || 0);
      const oa = a.oncelik || 99, ob = b.oncelik || 99;
      if (oa !== ob) return oa - ob;
      return new Date(b.olusturma_ts) - new Date(a.olusturma_ts);
    });

  const onPatch = (id, patch) => setBasvurular(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
  const onSil = (id) => setBasvurular(prev => prev.filter(b => b.id !== id));
  const onSec = (id) => setSecimler(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const tumunuSec = () => {
    const ids = filtrelenmis.map(b => b.id);
    if (ids.every(i => secimler.has(i)) && ids.length) setSecimler(new Set());
    else setSecimler(new Set(ids));
  };
  const topluArsivle = async () => {
    if (!secimler.size) return;
    setTopluYukleniyor(true);
    try {
      const arsivle = view === 'aktif';  // aktif görünümde arşivle, arşivde çıkar
      await api('/is-basvurusu/toplu-arsiv', { method: 'POST', body: { ids: [...secimler], arsivli: arsivle } });
      setSecimler(new Set());
      publishGlobalDataRefresh('is-basvurusu');
      yukle();
    } catch (e) { alert(e.message); }
    finally { setTopluYukleniyor(false); }
  };

  const ac = (b) => {
    setSecili(b);
    if (!b.goruldu_ts) {
      onPatch(b.id, { goruldu_ts: new Date().toISOString() });
      api(`/is-basvurusu/${b.id}/gor`, { method: 'PATCH' }).then(() => publishGlobalDataRefresh('is-basvurusu')).catch(() => {});
    }
  };

  // Açık CV güncel kalsın (modal local state yok — listeden okur)
  const seciliGuncel = secili ? (basvurular.find(b => b.id === secili.id) || secili) : null;

  const filtreler = [
    { id: 'hepsi', label: 'Tümü' },
    { id: 'oncelik1', label: '🥇 1. Öncelik', sayi: ozet.oncelik1 },
    { id: 'oncelik2', label: '🥈 2. Öncelik', sayi: ozet.oncelik2 },
    { id: 'bekliyor', label: '⏳ Bekliyor', sayi: ozet.bekliyor },
    { id: 'gorusme', label: '📞 Görüşme', sayi: ozet.gorusme },
    { id: 'olumlu', label: '✅ Olumlu', sayi: ozet.olumlu },
    { id: 'olumsuz', label: '❌ Olumsuz', sayi: ozet.olumsuz },
    { id: 'ise_alindi', label: '👤 İşe Alınanlar', sayi: ozet.ise_alindi },
  ];

  return (
    <div className="page">
      <div className="page-header"><h2>💼 İş Başvuruları</h2><p>Gelen CV'leri incele, öncelikle, işe al</p></div>

      {/* QR + İstatistik */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 16, marginBottom: 20 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 150 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 6 }}>
            <img src="/api/is-basvurusu/qr/indir" alt="Başvuru QR" style={{ width: 100, height: 100, display: 'block' }} onError={e => { e.target.style.display = 'none'; }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>Başvuru QR</div>
          <a href="/api/is-basvurusu/qr/indir" download="evvel_is_basvurusu_qr.png" style={{ fontSize: 11, padding: '6px 12px', borderRadius: 8, background: 'var(--accent)', color: '#fff', textDecoration: 'none', fontWeight: 700 }}>⬇ İndir</a>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(86px,1fr))', gap: 8 }}>
          {[
            { label: '🥇 1.Öncelik', val: ozet.oncelik1||0, renk: '#fbbf24' },
            { label: '🥈 2.Öncelik', val: ozet.oncelik2||0, renk: '#a78bfa' },
            { label: '⏳ Bekleyen', val: ozet.bekliyor||0, renk: 'var(--orange)' },
            { label: '📞 Görüşme',  val: ozet.gorusme||0,  renk: '#4a9eff' },
            { label: '✅ Olumlu',   val: ozet.olumlu||0,   renk: '#4caf84' },
            { label: '👤 İşe Alınan', val: ozet.ise_alindi||0, renk: '#34d399' },
            { label: '📦 Arşiv',    val: ozet.arsiv||0,    renk: 'var(--text2)' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: k.renk }}>{k.val}</div>
              <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Aktif / Arşiv görünüm */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[{ id: 'aktif', label: '📋 Aktif Başvurular' }, { id: 'arsiv', label: `📦 Arşiv${ozet.arsiv ? ` (${ozet.arsiv})` : ''}` }].map(v => (
          <button key={v.id} onClick={() => { setView(v.id); setFiltre('hepsi'); }} style={{
            padding: '8px 16px', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700,
            background: view === v.id ? 'var(--accent)' : 'var(--bg2)', color: view === v.id ? '#fff' : 'var(--text3)',
            border: `1px solid ${view === v.id ? 'var(--accent)' : 'var(--border)'}`,
          }}>{v.label}</button>
        ))}
      </div>

      {/* Arama + Sıralama */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={arama} onChange={e => setArama(e.target.value)} placeholder="🔍 İsim veya telefon ara..."
          style={{ flex: 1, minWidth: 180, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', fontSize: 13, color: 'var(--text)', outline: 'none' }} />
        <select value={siralama} onChange={e => setSiralama(e.target.value)}
          style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
          <option value="tarih">🥇 Öncelik / Yeni</option>
          <option value="skor_desc">⭐ En yüksek skor</option>
          <option value="skor_asc">🔻 En düşük skor</option>
        </select>
      </div>

      {/* Filtre */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {filtreler.map(f => (
          <button key={f.id} onClick={() => setFiltre(f.id)} style={{
            padding: '6px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 600,
            background: filtre === f.id ? 'var(--accent)' : 'var(--bg2)', color: filtre === f.id ? '#fff' : 'var(--text3)',
            border: `1px solid ${filtre === f.id ? 'var(--accent)' : 'var(--border)'}`,
          }}>{f.label}{f.sayi > 0 ? ` (${f.sayi})` : ''}</button>
        ))}
      </div>

      {/* Seçim çubuğu (tik + toplu arşiv) */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{filtrelenmis.length} başvuru{aramaKucuk ? ` · "${arama}"` : ''}</span>
          {filtrelenmis.length > 0 && (
            <button onClick={tumunuSec} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text3)' }}>
              {filtrelenmis.every(b => secimler.has(b.id)) && filtrelenmis.length ? '☐ Seçimi kaldır' : '☑ Tümünü seç'}
            </button>
          )}
        </div>
        {secimler.size > 0 && (
          <button onClick={topluArsivle} disabled={topluYukleniyor} style={{
            fontSize: 12, padding: '8px 16px', borderRadius: 10, cursor: 'pointer', fontWeight: 700,
            background: view === 'aktif' ? 'var(--text2)' : 'var(--accent)', color: '#fff', border: 'none', opacity: topluYukleniyor ? 0.6 : 1,
          }}>
            {topluYukleniyor ? '⏳…' : view === 'aktif' ? `📦 ${secimler.size} kartı Arşivle` : `📤 ${secimler.size} kartı Arşivden Çıkar`}
          </button>
        )}
      </div>

      {/* Liste */}
      {yukleniyor ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}><div className="spinner" style={{ margin: '0 auto 12px' }} />Yükleniyor…</div>
      ) : filtrelenmis.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          {view === 'arsiv' ? '📦 Arşivde başvuru yok.' : (filtre === 'hepsi' ? (<div><div style={{ fontSize: 40, marginBottom: 12 }}>📭</div><div style={{ fontSize: 15, fontWeight: 700 }}>Henüz başvuru yok</div><div style={{ fontSize: 13, marginTop: 6 }}>QR kodu yazdırın ve şubenize asın</div></div>) : 'Bu filtrede başvuru yok.')}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12 }}>
          {filtrelenmis.map(b => (
            <BasvuruKart key={b.id} b={b} onClick={() => ac(b)} secili={secimler.has(b.id)} onSec={onSec} />
          ))}
        </div>
      )}

      {seciliGuncel && (
        <CVModal b={seciliGuncel} onKapat={() => setSecili(null)} onPatch={onPatch} onSil={onSil} />
      )}
    </div>
  );
}
