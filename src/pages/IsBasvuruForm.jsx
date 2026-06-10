import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const GUNLER = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const TOPLAM_ADIM = 7;

const MOTIVASYON = {
  1: { emoji: '👏', mesaj: 'Harika başlangıç!',   alt: 'Biraz daha devam edelim...' },
  2: { emoji: '🔥', mesaj: 'Süper gidiyorsun!',   alt: 'Deneyimlerine bakalım.' },
  3: { emoji: '⭐', mesaj: 'İyi iş!',             alt: 'Seni biraz daha tanıyalım...' },
  4: { emoji: '💪', mesaj: 'Çok yaklaştın!',      alt: 'Son anlık sorular...' },
  5: { emoji: '🚀', mesaj: 'Neredeyse bitti!',    alt: 'Motivasyonunu merak ediyoruz.' },
  6: { emoji: '✨', mesaj: 'Son adım!',            alt: 'Kendini tanıt ve gönder!' },
};

const BG   = '#09090f';
const BG2  = '#12141c';
const BG3  = '#1c1f2e';
const BORD = '#242736';
const ACC  = '#4f8fff';
const GRN  = '#34d399';
const T1   = '#f0f1f5';
const T2   = '#8b92a5';
const T3   = '#4a4f63';

const S = {
  page:     { minHeight: '100vh', background: BG, color: T1, fontFamily: "'Inter', system-ui, sans-serif", overflowX: 'hidden' },
  body:     { maxWidth: 480, margin: '0 auto', padding: '24px 18px 100px' },
  label:    { fontSize: 17, fontWeight: 700, color: T1, display: 'block', marginBottom: 6, lineHeight: 1.35 },
  sublabel: { fontSize: 13, color: T2, display: 'block', marginBottom: 16, lineHeight: 1.5 },
  input:    { width: '100%', background: BG2, border: `1.5px solid ${BORD}`, borderRadius: 12, padding: '14px 16px', fontSize: 16, color: T1, outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', background: BG2, border: `1.5px solid ${BORD}`, borderRadius: 12, padding: '14px 16px', fontSize: 15, color: T1, outline: 'none', resize: 'vertical', minHeight: 100, boxSizing: 'border-box', fontFamily: 'inherit' },
  section:  { marginBottom: 28 },
  navRow:   { display: 'flex', gap: 10, marginTop: 32 },
};

// ── Bileşenler ──────────────────────────────────────────────────────

function RadioCard({ secenek, secili, onSec }) {
  const aktif = secili === secenek.value;
  return (
    <div
      className="radio-card"
      onClick={() => onSec(aktif ? null : secenek.value)}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '13px 16px', borderRadius: 12, marginBottom: 8,
        border: `1.5px solid ${aktif ? ACC : BORD}`,
        background: aktif ? 'rgba(79,143,255,0.09)' : BG2,
        cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      <div style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${aktif ? ACC : T3}`,
        background: aktif ? ACC : 'transparent',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.15s',
      }}>
        {aktif && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }} />}
      </div>
      <span style={{ fontSize: 15, color: aktif ? T1 : T2, fontWeight: aktif ? 600 : 400, lineHeight: 1.4 }}>
        {secenek.label}
      </span>
    </div>
  );
}

function CheckKart({ label, aktif, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '9px 14px', borderRadius: 10, margin: '4px',
      border: `1.5px solid ${aktif ? ACC : BORD}`,
      background: aktif ? 'rgba(79,143,255,0.1)' : BG2,
      color: aktif ? ACC : T2,
      fontSize: 13, fontWeight: aktif ? 700 : 500,
      cursor: 'pointer', userSelect: 'none', transition: 'all 0.12s',
    }}>
      {aktif ? '☑' : '☐'} {label}
    </div>
  );
}

function AdimBaslik({ no, baslik, aciklama }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 11, color: ACC, fontWeight: 800, letterSpacing: 1.2, marginBottom: 8 }}>
        ADIM {no} / {TOPLAM_ADIM}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: T1, marginBottom: aciklama ? 8 : 0, lineHeight: 1.3 }}>
        {baslik}
      </div>
      {aciklama && <div style={{ fontSize: 14, color: T2, lineHeight: 1.6 }}>{aciklama}</div>}
    </div>
  );
}

// ── Ana Bileşen ─────────────────────────────────────────────────────

export default function IsBasvuruForm() {
  const [adim, setAdim] = useState(1);
  const [yon, setYon] = useState('ileri');
  const [motivGoster, setMotivGoster] = useState(false);
  const [motivData, setMotivData] = useState(null);
  const [hata, setHata] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);
  const [tamamlandi, setTamamlandi] = useState(false);

  const [form, setForm] = useState({
    // Adım 1
    ad_soyad: '', telefon: '', dogum_yili: '', ilce: '',
    yasam_durumu: null, egitim_durumu: null, universite_bol: '',
    en_erken_saat: null, ulasim: null,
    // Adım 2
    calisma_tercihi: null, musait_gunler: [], baslangic: null, ek_not: '',
    // Adım 3
    kahve_deneyim: null,
    nerede_calistim: null,   // kurumsal | yerel_bagimsiz | sektor_disi | hic_calismadim
    is_ogrenilen: null,      // musteri_iletisim | hiz_tempo | duzen_temizlik | takim | tek_sorumluluk | cok_ogrenmedim
    isten_en_iyi: null,      // musteri_insan | tempolu_ortam | ogrenme | ekip | para_bagimsizlik | yonetim
    isten_en_zor: null,      // uzun_saatler | zor_musteriler | dusuk_ucret | yonetim_sorun | monoton | hic_yoktu
    // Adım 4 — behavioral (temizlik + esneklik maskeli)
    makine_sonrasi: null, yogun_duzen: null,
    gun_planlama: null, arkadaslar_tanim: null,
    // Adım 5 — behavioral (iletişim + mesai + sabah maskeli)
    sosyal_yaklasim: null, musteri_bagli: null,
    sabah_hazirlik: null, yorucu_an: null,
    // Adım 6
    neden_bu_is: null, tempo_tercihi: null,
    // Adım 7
    tanitim: '', referans_ad: '', referans_tel: '',
    pozisyon: 'barista',
  });

  // CSS animasyonları
  useEffect(() => {
    const el = document.createElement('style');
    el.id = 'basvuru-anim';
    el.textContent = `
      @keyframes slideRight { from { transform: translateX(50px); opacity:0 } to { transform: translateX(0); opacity:1 } }
      @keyframes slideLeft  { from { transform: translateX(-50px); opacity:0 } to { transform: translateX(0); opacity:1 } }
      @keyframes fadeUp     { from { transform: translateY(30px); opacity:0 } to { transform: translateY(0); opacity:1 } }
      @keyframes bounceIn   { 0%{transform:scale(0.1);opacity:0} 60%{transform:scale(1.15)} 100%{transform:scale(1);opacity:1} }
      @keyframes popIn      { 0%{transform:scale(0.8);opacity:0} 100%{transform:scale(1);opacity:1} }
      .adim-ileri { animation: slideRight 0.32s cubic-bezier(0.4,0,0.2,1) }
      .adim-geri  { animation: slideLeft  0.32s cubic-bezier(0.4,0,0.2,1) }
      .motiv-emoji { animation: bounceIn 0.55s ease }
      .motiv-mesaj { animation: fadeUp 0.4s ease 0.2s both }
      .motiv-alt   { animation: fadeUp 0.4s ease 0.35s both }
      .radio-card:active { transform: scale(0.98) }
      .bitis-kart  { animation: popIn 0.4s ease }
    `;
    if (!document.getElementById('basvuru-anim')) document.head.appendChild(el);
    return () => { const e = document.getElementById('basvuru-anim'); if (e) e.remove(); };
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const toggleGun = (gun) => {
    const arr = form.musait_gunler || [];
    set('musait_gunler', arr.includes(gun) ? arr.filter(g => g !== gun) : [...arr, gun]);
  };

  const hepsiToggle = () => {
    set('musait_gunler', form.musait_gunler.length === GUNLER.length ? [] : [...GUNLER]);
  };

  const ileriGit = () => {
    setHata('');
    if (adim === 1) {
      if (!form.ad_soyad.trim()) { setHata('Adın ve soyadın olmadan devam edemeyiz 🙂'); return; }
      if (!form.telefon.trim())  { setHata('Telefon numarana ihtiyacımız var.'); return; }
    }
    if (adim === 2) {
      if (!form.calisma_tercihi)               { setHata('Nasıl çalışmak istediğini seçmeyi unuttun 🗓️'); return; }
      if (!form.musait_gunler.length)           { setHata('En az bir gün seçmen gerekiyor.'); return; }
      if (!form.baslangic)                     { setHata('Ne zaman başlayabileceğini belirtir misin?'); return; }
    }
    if (adim === 3) {
      if (!form.kahve_deneyim)                 { setHata('Kahve deneyimini seçmeyi unuttun ☕'); return; }
      if (!form.nerede_calistim)               { setHata('Daha önce nerede çalıştığını belirtir misin?'); return; }
      if (form.nerede_calistim !== 'hic_calismadim') {
        if (!form.is_ogrenilen)                { setHata('O işte en çok ne öğrendiğini seçmeyi unuttun 📚'); return; }
        if (!form.isten_en_iyi)                { setHata('O işte seni en çok ne mutlu ettiğini seçmeyi unuttun ✨'); return; }
        if (!form.isten_en_zor)                { setHata('O işte en zor ne geldiğini seçmeyi unuttun ⚠️'); return; }
      }
    }
    if (adim === 4) {
      if (!form.makine_sonrasi)                { setHata('Kahve makinesi sorusunu yanıtlamayı unuttun ☕'); return; }
      if (!form.yogun_duzen)                   { setHata('Yoğun anlarda düzen sorusunu yanıtlamayı unuttun 🧹'); return; }
      if (!form.gun_planlama)                  { setHata('Gün planlama sorusunu yanıtlamayı unuttun 📅'); return; }
      if (!form.arkadaslar_tanim)              { setHata('Arkadaşları tanımlama sorusunu yanıtlamayı unuttun 👥'); return; }
    }
    if (adim === 5) {
      if (!form.sosyal_yaklasim)               { setHata('Sosyal yaklaşım sorusunu yanıtlamayı unuttun 🤝'); return; }
      if (!form.musteri_bagli)                 { setHata('Müşteri bağı sorusunu yanıtlamayı unuttun ☕'); return; }
      if (!form.sabah_hazirlik)                { setHata('Sabah hazırlık sorusunu yanıtlamayı unuttun 🌅'); return; }
      if (!form.yorucu_an)                     { setHata('En yorucu an sorusunu yanıtlamayı unuttun 😓'); return; }
    }
    if (adim === 6) {
      if (!form.neden_bu_is)                   { setHata('Bu işi neden istediğini seçmeyi unuttun 🎯'); return; }
      if (!form.tempo_tercihi)                 { setHata('Tempo tercihini seçmeyi unuttun ⚡'); return; }
    }
    const m = MOTIVASYON[adim];
    setYon('ileri');
    if (m) {
      setMotivData(m);
      setMotivGoster(true);
      setTimeout(() => { setMotivGoster(false); setAdim(a => a + 1); }, 950);
    } else {
      setAdim(a => a + 1);
    }
  };

  const geriGit = () => {
    setHata('');
    setYon('geri');
    setAdim(a => a - 1);
  };

  const gonder = async () => {
    setYukleniyor(true); setHata('');
    try {
      const params = new URLSearchParams(window.location.search);
      await api('/is-basvurusu', {
        method: 'POST',
        body: {
          ...form,
          dogum_yili: form.dogum_yili ? parseInt(form.dogum_yili) : null,
          kaynak_sube: params.get('sube') || null,
        },
      });
      setTamamlandi(true);
    } catch (e) {
      setHata(e.message || 'Bir hata oluştu, tekrar dene.');
    } finally {
      setYukleniyor(false);
    }
  };

  // ── Tamamlandı ekranı ──────────────────────────────────────────────
  if (tamamlandi) {
    return (
      <div style={{ ...S.page, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
          <div style={{ fontSize: 72, marginBottom: 16, animation: 'bounceIn 0.6s ease' }}>☕</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: GRN, marginBottom: 10 }}>Başvurun Alındı!</div>
          <div style={{ fontSize: 15, color: T2, lineHeight: 1.8, marginBottom: 28 }}>
            Teşekkürler <strong style={{ color: T1 }}>{form.ad_soyad}</strong>!<br />
            <strong style={{ color: T1 }}>{form.telefon}</strong> numarasından en kısa sürede seni arayacağız.
          </div>
          <div style={{ background: BG2, border: `1px solid ${BORD}`, borderRadius: 16, padding: 20, fontSize: 13, color: T2, lineHeight: 2 }}>
            🕐 Başvurular genellikle <strong style={{ color: T1 }}>2–5 iş günü</strong> içinde değerlendirilir.<br />
            📱 Telefona açık ol, seni arayacağız!<br />
            ☕ TuliPi Coffee ailesine hoş geldin diyelim diye sabırsızlanıyoruz.
          </div>
        </div>
      </div>
    );
  }

  const ilerleme = Math.round(((adim - 1) / TOPLAM_ADIM) * 100);

  return (
    <div style={S.page}>

      {/* ── Motivasyon Overlay ── */}
      {motivGoster && motivData && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200, background: BG,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <div className="motiv-emoji" style={{ fontSize: 80 }}>{motivData.emoji}</div>
          <div className="motiv-mesaj" style={{ fontSize: 28, fontWeight: 800, color: T1 }}>{motivData.mesaj}</div>
          <div className="motiv-alt"   style={{ fontSize: 15, color: T2 }}>{motivData.alt}</div>
        </div>
      )}

      {/* ── Header + Progress ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: BG, borderBottom: `1px solid ${BORD}`, padding: '12px 18px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: T1 }}>☕ TuliPi Coffee</div>
          <div style={{ fontSize: 12, color: T3, fontWeight: 600 }}>{adim} / {TOPLAM_ADIM}</div>
        </div>
        {/* Progress bar */}
        <div style={{ height: 3, background: BG3, borderRadius: 99 }}>
          <div style={{
            height: 3, borderRadius: 99,
            background: `linear-gradient(90deg, ${ACC}, ${GRN})`,
            width: `${ilerleme}%`, transition: 'width 0.5s cubic-bezier(0.4,0,0.2,1)',
          }} />
        </div>
        {/* Step dots */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 2px 10px' }}>
          {Array.from({ length: TOPLAM_ADIM }).map((_, i) => (
            <div key={i} style={{
              width: adim === i + 1 ? 20 : 6, height: 6, borderRadius: 99,
              background: i < adim ? ACC : BORD,
              transition: 'all 0.3s ease',
            }} />
          ))}
        </div>
      </div>

      <div style={S.body}>
        <div className={yon === 'ileri' ? 'adim-ileri' : 'adim-geri'} key={adim}>

          {/* ═══ ADIM 1: Merhaba ═══════════════════════════════════════════ */}
          {adim === 1 && (
            <div>
              <AdimBaslik no={1} baslik="Merhaba! 👋" aciklama="Seni tanımak için birkaç temel bilgi — 1 dakika sürer." />

              <div style={S.section}>
                <label style={S.label}>Adın Soyadın *</label>
                <input style={S.input} placeholder="Adın ve soyadın" value={form.ad_soyad}
                  onChange={e => set('ad_soyad', e.target.value)} autoFocus />
              </div>

              <div style={S.section}>
                <label style={S.label}>Telefon Numaran *</label>
                <input style={S.input} placeholder="05XX XXX XX XX" inputMode="tel" value={form.telefon}
                  onChange={e => set('telefon', e.target.value)} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 28 }}>
                <div>
                  <label style={{ ...S.label, fontSize: 14 }}>Doğum Yılı</label>
                  <input style={S.input} placeholder="2000" inputMode="numeric" maxLength={4}
                    value={form.dogum_yili} onChange={e => set('dogum_yili', e.target.value)} />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 14 }}>Semt / İlçe</label>
                  <input style={S.input} placeholder="Bornova" value={form.ilce}
                    onChange={e => set('ilce', e.target.value)} />
                </div>
              </div>

              <div style={S.section}>
                <label style={S.label}>Şu an nerede kalıyorsun?</label>
                {[
                  { value: 'aile',    label: '🏠 Aileyle birlikte' },
                  { value: 'yurt',    label: '🏫 Öğrenci yurdunda' },
                  { value: 'arkadas', label: '👥 Arkadaşlarla birlikte' },
                  { value: 'tek',     label: '🔑 Tek başıma' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.yasam_durumu} onSec={v => set('yasam_durumu', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Hayat evren nasıl?</label>
                {[
                  { value: 'lise',       label: '📚 Lise öğrencisiyim' },
                  { value: 'universite', label: '🎓 Üniversite öğrencisiyim' },
                  { value: 'mezun',      label: '✅ Mezunum, iş arıyorum' },
                  { value: 'calisiyor',  label: '💼 Çalışıyorum, ek iş istiyorum' },
                  { value: 'diger',      label: '✨ Diğer' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.egitim_durumu} onSec={v => set('egitim_durumu', v)} />)}
                {(form.egitim_durumu === 'universite' || form.egitim_durumu === 'lise') && (
                  <input style={{ ...S.input, marginTop: 10 }}
                    placeholder="Okul ve bölüm (örn: Ege Üni. — İşletme 2. sınıf)"
                    value={form.universite_bol} onChange={e => set('universite_bol', e.target.value)} />
                )}
              </div>

              <div style={S.section}>
                <label style={S.label}>En erken kaçta işe gelebilirsin?</label>
                <span style={S.sublabel}>Açılış 09:00 — sabah vardiyası için önemli bir bilgi.</span>
                {[
                  { value: '07:00', label: '🌅 07:00 — Erken kuşum' },
                  { value: '08:00', label: '🌄 08:00 — Rahatça yetişirim' },
                  { value: '09:00', label: '☀️ 09:00 — Tam açılışa yetişirim' },
                  { value: '10:00', label: '🕙 10:00 — Bu kadar erken zor' },
                  { value: 'ogle',  label: '🌞 Öğleden sonra uygunum' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.en_erken_saat} onSec={v => set('en_erken_saat', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Ulaşım nasıl gelirsin?</label>
                {[
                  { value: 'yurume',   label: '🚶 Yürüme mesafesindeyim' },
                  { value: 'toplu',    label: '🚌 Toplu taşımayla' },
                  { value: 'arac',     label: '🚗 Araç / motosiklet' },
                  { value: 'bisiklet', label: '🚲 Bisikletle' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.ulasim} onSec={v => set('ulasim', v)} />)}
              </div>
            </div>
          )}

          {/* ═══ ADIM 2: Tercihler ═════════════════════════════════════════ */}
          {adim === 2 && (
            <div>
              <AdimBaslik no={2} baslik="Çalışma Tercihlerin 🗓️" aciklama="Sana en uygun programı bulmak için." />

              <div style={S.section}>
                <label style={S.label}>Nasıl çalışmak istersin?</label>
                {[
                  { value: 'tam',   label: '🕘 Tam zamanlı' },
                  { value: 'yari',  label: '⏰ Yarı zamanlı' },
                  { value: 'esnek', label: '🔄 Esnek / Değişken' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.calisma_tercihi} onSec={v => set('calisma_tercihi', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Hangi günler müsaitsin?</label>
                <span style={S.sublabel}>Birden fazla seçebilirsin.</span>
                <div style={{ marginBottom: 8 }}>
                  <CheckKart
                    label="📅 Hepsi"
                    aktif={form.musait_gunler.length === GUNLER.length}
                    onClick={hepsiToggle}
                  />
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                  {GUNLER.map(g => (
                    <CheckKart key={g} label={g}
                      aktif={(form.musait_gunler || []).includes(g)}
                      onClick={() => toggleGun(g)} />
                  ))}
                </div>
              </div>

              <div style={S.section}>
                <label style={S.label}>Ne zaman başlayabilirsin?</label>
                {[
                  { value: 'hemen',  label: '⚡ Hemen başlayabilirim' },
                  { value: '2hafta', label: '📅 2 hafta içinde' },
                  { value: '1ay',    label: '🗓️ 1 ay içinde' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.baslangic} onSec={v => set('baslangic', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Eklemek istediğin bir şey var mı?</label>
                <span style={S.sublabel}>Belirtmek istediğin kısıtlama veya tercih.</span>
                <textarea style={S.textarea}
                  placeholder="Örn: Salı günleri yokum / Sabah 08:00'den önce ulaşmam zor / Hafta sonları full müsaitim..."
                  value={form.ek_not} onChange={e => set('ek_not', e.target.value)} />
              </div>
            </div>
          )}

          {/* ═══ ADIM 3: Deneyim & Geçmiş ══════════════════════════════════ */}
          {adim === 3 && (
            <div>
              <AdimBaslik no={3} baslik="Deneyimin ☕" aciklama="Deneyimin olmasa da sorun değil — öğrenmek istiyorsan yeterli!" />

              <div style={S.section}>
                <label style={S.label}>Kahve / Barista deneyimin?</label>
                {[
                  { value: 'var_1yil',      label: '☕ 1 yıldan az var' },
                  { value: 'var_2yil',      label: '☕☕ 1–3 yıl arası' },
                  { value: 'var_uzun',      label: '☕☕☕ 3 yıldan fazla' },
                  { value: 'kismi',         label: '🌱 Biraz biliyorum' },
                  { value: 'yok_ogreneyim', label: '✨ Yok ama hızlı öğrenirim' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.kahve_deneyim} onSec={v => set('kahve_deneyim', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Daha önce nerede çalıştın?</label>
                {[
                  { value: 'kurumsal',       label: '🏢 Kurumsal zincirde', alt: 'Starbucks, McDonald\'s, market zinciri gibi' },
                  { value: 'yerel_bagimsiz', label: '☕ Yerel / bağımsız işletmede', alt: 'Mahalle kafesi, butik restoran, küçük işletme' },
                  { value: 'sektor_disi',    label: '🔄 Farklı bir sektörde', alt: 'Giyim, büro, fabrika, eğitim, sağlık...' },
                  { value: 'hic_calismadim', label: '🌱 Hiç çalışmadım', alt: 'İlk iş deneyimim olacak' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.nerede_calistim} onSec={v => set('nerede_calistim', v)} />)}
              </div>

              {form.nerede_calistim && form.nerede_calistim !== 'hic_calismadim' && (
                <>
                  <div style={S.section}>
                    <label style={S.label}>O işte en çok ne öğrendin?</label>
                    {[
                      { value: 'musteri_iletisim', label: '💬 Müşteriyle iletişim kurmayı' },
                      { value: 'hiz_tempo',        label: '⚡ Hızlı ve tempolu çalışmayı' },
                      { value: 'duzen_temizlik',   label: '🧹 Düzen ve temizliğin önemini' },
                      { value: 'takim',            label: '🤝 Takım olarak çalışmayı' },
                      { value: 'tek_sorumluluk',   label: '🎯 İşi tek başıma yönetmeyi' },
                      { value: 'cok_ogrenmedim',   label: '🤷 Pek bir şey öğrenemedim' },
                    ].map(s => <RadioCard key={s.value} secenek={s} secili={form.is_ogrenilen} onSec={v => set('is_ogrenilen', v)} />)}
                  </div>

                  <div style={S.section}>
                    <label style={S.label}>O işte seni en çok ne mutlu etti?</label>
                    {[
                      { value: 'musteri_insan',    label: '👥 Müşteriler ve insan ilişkileri' },
                      { value: 'tempolu_ortam',    label: '🏃 Tempolu ortam — gün hızlı geçti' },
                      { value: 'ogrenme',          label: '📚 Sürekli bir şeyler öğrendim' },
                      { value: 'ekip',             label: '💪 Ekip arkadaşlarım' },
                      { value: 'para_bagimsizlik', label: '💰 Kendi param, kendi kararlarım' },
                    ].map(s => <RadioCard key={s.value} secenek={s} secili={form.isten_en_iyi} onSec={v => set('isten_en_iyi', v)} />)}
                  </div>

                  <div style={S.section}>
                    <label style={S.label}>O işte en zor ne geldi?</label>
                    {[
                      { value: 'uzun_saatler',   label: '⏰ Uzun saatler / geç çıkışlar' },
                      { value: 'zor_musteriler', label: '😤 Zor veya sinirli müşteriler' },
                      { value: 'dusuk_ucret',    label: '💸 Emek karşılığı azdı' },
                      { value: 'yonetim_sorun',  label: '🚧 Yönetim veya organizasyon sorunları' },
                      { value: 'monoton',        label: '😴 Tekrarcı / monoton işti' },
                    ].map(s => <RadioCard key={s.value} secenek={s} secili={form.isten_en_zor} onSec={v => set('isten_en_zor', v)} />)}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ═══ ADIM 4: Bir Gün Seninle ════════════════════════════════════ */}
          {adim === 4 && (
            <div>
              <AdimBaslik no={4} baslik="Günlük Çalışma Tarzın ☕" aciklama="Birkaç kısa senaryo — hangisi sana daha yakın?" />

              <div style={S.section}>
                <label style={S.label}>Kahve makinesini kullandıktan sonra ne yaparsın?</label>
                {[
                  { value: 'hemen_siler',    label: 'Hemen silerim, hazır bırakırım' },
                  { value: 'vardiya_sonu',   label: 'Vardiya sonunda toplu temizlerim' },
                  { value: 'kime_duserse',   label: 'Temizlik görevi kime düşerse o yapar' },
                  { value: 'pek_dusunmem',   label: 'Pek düşünmemişim açıkçası' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.makine_sonrasi} onSec={v => set('makine_sonrasi', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Yoğun bir anda tezgah karıştı — ne zaman toparlarsın?</label>
                {[
                  { value: 'araliklarda',   label: 'Küçük aralıklarda bile fırsat bulsam toplarım' },
                  { value: 'rush_bitti',    label: 'Rush bitince hepsini bir anda' },
                  { value: 'oldugu_gibi',   label: 'Akış bozulmasın diye olduğu gibi bırakırım' },
                  { value: 'fark_etmez',    label: 'Fark etmez, iş yetişsin' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.yogun_duzen} onSec={v => set('yogun_duzen', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Bir günü nasıl planlamayı seversin?</label>
                {[
                  { value: 'esnek_akis',        label: 'Esnek olurum, akışa göre giderim' },
                  { value: 'plan_degisir',       label: 'Planım olsun ama değişebilir' },
                  { value: 'saatler_belli',      label: 'Saatlerim belli olsun, ona göre ayarlarım' },
                  { value: 'onceden_netlesin',   label: 'Her şey önceden netleşmeli' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.gun_planlama} onSec={v => set('gun_planlama', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Arkadaşların seni nasıl tanımlar?</label>
                {[
                  { value: 'her_an_hazir',    label: 'Her an hazır, güvenilir' },
                  { value: 'sakin_olculu',    label: 'Sakin, ölçülü' },
                  { value: 'kendi_isine',     label: 'Kendi işine bakan' },
                  { value: 'haklarini_bilen', label: 'Haklarını bilen' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.arkadaslar_tanim} onSec={v => set('arkadaslar_tanim', v)} />)}
              </div>
            </div>
          )}

          {/* ═══ ADIM 5: Anlık Tepkiler ════════════════════════════════════ */}
          {adim === 5 && (
            <div>
              <AdimBaslik no={5} baslik="Biraz Daha Tanışalım 🤝" aciklama="Sana birkaç durum sorduk — en doğal hissettiğin cevabı seç." />

              <div style={S.section}>
                <label style={S.label}>Tanımadığın biriyle ilk 30 saniyede nasıl hissedersin?</label>
                {[
                  { value: 'dogal_isinirim',    label: 'Doğal geliyor, hemen ısınırım' },
                  { value: 'zaman_lazim',       label: 'Biraz zaman lazım ama olur' },
                  { value: 'karsi_baslasın',    label: 'Genelde karşı taraf başlamalı' },
                  { value: 'pek_rahat_degil',   label: 'Pek rahat değilimdir' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.sosyal_yaklasim} onSec={v => set('sosyal_yaklasim', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Düzenli bir müşteri her gün aynı şeyi alıyor — ne yaparsın?</label>
                {[
                  { value: 'adini_ogrenip',    label: 'Adını öğrenirim, siparişini sormadan hazırlarım' },
                  { value: 'selam_sorar',      label: 'Selam veririm, siparişini sorarım' },
                  { value: 'hizlica_hazirlar', label: 'Hızlıca hazırlarım, vakit kaybetmem' },
                  { value: 'hepsi_ayni',       label: 'Her müşteri aynı benim için' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.musteri_bagli} onSec={v => set('musteri_bagli', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Sabah 07:00'de işe başlayacaksın, gece kötü uyudun — ne yaparsın?</label>
                {[
                  { value: 'kahve_icer',    label: 'Kahvemi içer, hazırlanır gelirim' },
                  { value: 'zor_gelir',     label: 'Zor olur ama gelirim' },
                  { value: 'izin_dusunur',  label: 'İzin almayı düşünürüm' },
                  { value: 'duruma_gore',   label: 'Duruma göre karar veririm' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.sabah_hazirlik} onSec={v => set('sabah_hazirlik', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Bir günün en yorucu anı ne zaman olur?</label>
                {[
                  { value: 'beklenmedik',    label: 'Hiç beklemediğim bir şey çıkınca' },
                  { value: 'isler_uzayinca', label: 'İşler uzayıp gidince' },
                  { value: 'plan_disi',      label: 'Plan dışı bir şey istenince' },
                  { value: 'gunun_sonu',     label: 'Günün sonunda birden bire' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.yorucu_an} onSec={v => set('yorucu_an', v)} />)}
              </div>
            </div>
          )}

          {/* ═══ ADIM 6: Son Bir Şey ══════════════════════════════════════ */}
          {adim === 6 && (
            <div>
              <AdimBaslik no={6} baslik="Sana Göre Nasıl Bir Yer? 🌟" aciklama="Bu işte ne arıyorsun, hangi ortamda daha iyi çalışırsın?" />

              <div style={S.section}>
                <label style={S.label}>Neden bu işi istiyorsun?</label>
                {[
                  { value: 'part_time',   label: '💰 Ek gelir istiyorum' },
                  { value: 'tam_zamanli', label: '💼 Kariyer yapmak istiyorum' },
                  { value: 'barista',     label: '☕ Gerçekten barista olmak istiyorum' },
                  { value: 'deneyim',     label: '📈 İş deneyimi kazanmak' },
                  { value: 'insan',       label: '🙋 İnsanlarla çalışmayı seviyorum' },
                  { value: 'diger',       label: '✨ Diğer' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.neden_bu_is} onSec={v => set('neden_bu_is', v)} />)}
              </div>

              <div style={S.section}>
                <label style={S.label}>Nasıl bir ortamda çalışmayı seversin?</label>
                {[
                  { value: 'hizli', label: '⚡ Hızlı tempolu, yoğun — tam bana göre!' },
                  { value: 'sakin', label: '🌿 Sakin, her müşteriyle ilgilenemek' },
                  { value: 'ikisi', label: '😄 İkisi de — ne gelirse' },
                ].map(s => <RadioCard key={s.value} secenek={s} secili={form.tempo_tercihi} onSec={v => set('tempo_tercihi', v)} />)}
              </div>
            </div>
          )}

          {/* ═══ ADIM 7: Bize Ulaş ════════════════════════════════════════ */}
          {adim === 7 && (
            <div>
              <AdimBaslik no={7} baslik="Son Dokunuşlar ✨" aciklama="Neredeyse bitti — kendini tanıt ve gönder!" />

              <div style={S.section}>
                <label style={S.label}>Kendini kısaca tanıt <span style={{ color: T3, fontWeight: 400, fontSize: 14 }}>(opsiyonel)</span></label>
                <textarea style={{ ...S.textarea, minHeight: 110 }}
                  placeholder="Merhaba, ben... Boş zamanlarımda... Bu işi seçmemin sebebi..."
                  value={form.tanitim} onChange={e => set('tanitim', e.target.value.slice(0, 400))} />
                <div style={{ fontSize: 11, color: T3, marginTop: 5 }}>{form.tanitim.length} / 400</div>
              </div>

              <div style={S.section}>
                <label style={S.label}>Referans <span style={{ color: T3, fontWeight: 400, fontSize: 14 }}>(opsiyonel)</span></label>
                <span style={S.sublabel}>Eski işyeri, hoca, komşu... Seni tanıyan biri.</span>
                <input style={{ ...S.input, marginBottom: 10 }} placeholder="Ad Soyad"
                  value={form.referans_ad} onChange={e => set('referans_ad', e.target.value)} />
                <input style={S.input} placeholder="Telefon" inputMode="tel"
                  value={form.referans_tel} onChange={e => set('referans_tel', e.target.value)} />
              </div>

              {/* İletişim Kartı */}
              <div style={{ background: BG2, border: `1px solid ${BORD}`, borderRadius: 16, padding: 20, marginBottom: 24 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: ACC, marginBottom: 14, letterSpacing: 0.8 }}>
                  📬 BİZE ULAŞ
                </div>
                <div style={{ fontSize: 14, color: T1, lineHeight: 2 }}>
                  📱 <strong>Telefon:</strong> 0XXX XXX XX XX<br />
                  💬 WhatsApp ile de ulaşabilirsin
                </div>
                <div style={{
                  marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BORD}`,
                  fontSize: 13, color: T2, lineHeight: 1.9, fontStyle: 'italic',
                }}>
                  Telefona ulaşamazsan tekrar ara —<br />
                  ya da mektupla da uğrayabilirsin 😄<br />
                  <span style={{ color: T3, fontSize: 12 }}>
                    "En geç sabah 09:00'da kahven hazır olur."
                  </span>
                </div>
              </div>

              {hata && (
                <div style={{ background: 'rgba(224,92,92,0.1)', border: '1px solid rgba(224,92,92,0.3)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#e05c5c', marginBottom: 16 }}>
                  ⚠️ {hata}
                </div>
              )}
            </div>
          )}

        </div>{/* adim wrapper */}

        {/* ── Navigasyon ── */}
        <div style={S.navRow}>
          {adim > 1 && (
            <button onClick={geriGit} style={{
              flex: 1, padding: '15px', borderRadius: 14,
              border: `1px solid ${BORD}`, background: BG2, color: T2,
              fontSize: 15, fontWeight: 700, cursor: 'pointer',
            }}>
              ← Geri
            </button>
          )}
          {adim < TOPLAM_ADIM ? (
            <button onClick={ileriGit} style={{
              flex: 2, padding: '15px', borderRadius: 14, border: 'none',
              background: ACC, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer',
            }}>
              Devam Et →
            </button>
          ) : (
            <button onClick={gonder} disabled={yukleniyor} style={{
              flex: 2, padding: '16px', borderRadius: 14, border: 'none',
              background: yukleniyor ? BG3 : GRN, color: '#fff',
              fontSize: 16, fontWeight: 800,
              cursor: yukleniyor ? 'default' : 'pointer',
              opacity: yukleniyor ? 0.7 : 1,
            }}>
              {yukleniyor ? '⏳ Gönderiliyor…' : '🚀 Başvuruyu Gönder'}
            </button>
          )}
        </div>

        {hata && adim !== 7 && (
          <div style={{ background: 'rgba(224,92,92,0.1)', border: '1px solid rgba(224,92,92,0.3)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#e05c5c', marginTop: 12 }}>
            ⚠️ {hata}
          </div>
        )}

        <div style={{ textAlign: 'center', marginTop: 28, fontSize: 12, color: T3 }}>
          ☕ TuliPi Coffee — Gizliliğin korunur, bilgilerin sadece ekibimizle paylaşılır.
        </div>
      </div>
    </div>
  );
}
