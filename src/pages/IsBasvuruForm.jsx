import { useState } from 'react';
import { api } from '../utils/api';

const SUBELER = ['Zafer', 'Köyceğiz', 'Gazze', 'Alsancak'];
const GUNLER  = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

const S = {
  page:    { minHeight: '100vh', background: '#0f1117', color: '#e8e9ec', fontFamily: 'Instrument Sans, Inter, sans-serif', padding: '0 0 60px' },
  header:  { background: 'linear-gradient(135deg,#1a1d24,#12151b)', padding: '32px 24px 24px', textAlign: 'center', borderBottom: '1px solid #2a2d35' },
  body:    { maxWidth: 480, margin: '0 auto', padding: '24px 20px' },
  label:   { display: 'block', fontSize: 13, fontWeight: 700, color: '#9ca3af', marginBottom: 8, letterSpacing: 0.3 },
  input:   { width: '100%', background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 10, padding: '13px 14px', fontSize: 15, color: '#e8e9ec', outline: 'none', boxSizing: 'border-box' },
  textarea:{ width: '100%', background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 10, padding: '13px 14px', fontSize: 14, color: '#e8e9ec', outline: 'none', resize: 'vertical', minHeight: 90, boxSizing: 'border-box', fontFamily: 'inherit' },
  card:    { background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 12, padding: '16px', marginBottom: 16 },
  btn:     { width: '100%', padding: '15px', borderRadius: 12, border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  chip:    (aktif) => ({ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${aktif ? '#4a9eff' : '#2a2d35'}`, background: aktif ? 'rgba(74,158,255,0.12)' : '#12151b', color: aktif ? '#4a9eff' : '#6b6f7a', fontSize: 13, fontWeight: 600, cursor: 'pointer', margin: '4px', userSelect: 'none' }),
};

function AdimBaslik({ no, baslik, aciklama }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: '#4a9eff', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>ADIM {no}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: '#e8e9ec', marginBottom: 4 }}>{baslik}</div>
      {aciklama && <div style={{ fontSize: 13, color: '#6b6f7a', lineHeight: 1.5 }}>{aciklama}</div>}
    </div>
  );
}

function ChipGroup({ secenekler, secili, onChange, coklu = false }) {
  const toggle = (v) => {
    if (coklu) {
      const arr = secili || [];
      onChange(arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);
    } else {
      onChange(secili === v ? null : v);
    }
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', margin: '-4px' }}>
      {secenekler.map(({ value, label }) => {
        const aktif = coklu ? (secili || []).includes(value) : secili === value;
        return <span key={value} style={S.chip(aktif)} onClick={() => toggle(value)}>{aktif ? '✓ ' : ''}{label}</span>;
      })}
    </div>
  );
}

export default function IsBasvuruForm() {
  const [adim, setAdim]     = useState(1);
  const [form, setForm]     = useState({
    ad_soyad: '', telefon: '', dogum_yili: '', ilce: '',
    pozisyon: null, tercih_subeler: [],
    kahve_deneyim: null, onceki_is: '',
    calisma_tercihi: null, musait_gunler: [],
    baslangic: null, tanitim: '',
    referans_ad: '', referans_tel: '',
  });
  const [yukleniyor, setYukleniyor] = useState(false);
  const [tamamlandi,  setTamamlandi]  = useState(false);
  const [hata,        setHata]        = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const gonder = async () => {
    if (!form.ad_soyad.trim()) { setHata('Ad soyad zorunlu.'); return; }
    if (!form.telefon.trim())  { setHata('Telefon numarası zorunlu.'); return; }
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
      setHata(e.message || 'Bir hata oluştu, tekrar deneyin.');
    } finally {
      setYukleniyor(false);
    }
  };

  if (tamamlandi) {
    return (
      <div style={S.page}>
        <div style={{ ...S.body, textAlign: 'center', paddingTop: 80 }}>
          <div style={{ fontSize: 64, marginBottom: 20 }}>☕</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#4caf84', marginBottom: 12 }}>Başvurun Alındı!</div>
          <div style={{ fontSize: 15, color: '#9ca3af', lineHeight: 1.7, marginBottom: 32 }}>
            Teşekkürler <strong style={{ color: '#e8e9ec' }}>{form.ad_soyad}</strong>!<br />
            Ekibimiz en kısa sürede <strong style={{ color: '#e8e9ec' }}>{form.telefon}</strong> numarasından seninle iletişime geçecek.
          </div>
          <div style={{ background: '#1a1d24', border: '1px solid #2a2d35', borderRadius: 14, padding: 20, fontSize: 13, color: '#6b6f7a', lineHeight: 1.7 }}>
            🕐 Başvurular genellikle <strong style={{ color: '#e8e9ec' }}>2–5 iş günü</strong> içinde değerlendirilir.<br />
            📱 Seni arayacağız — telefona açık ol!
          </div>
        </div>
      </div>
    );
  }

  const TOPLAM_ADIM = 4;
  const ilerleme = Math.round(((adim - 1) / TOPLAM_ADIM) * 100);

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>☕</div>
        <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Evvel'de Çalışmak İster Misin?</div>
        <div style={{ fontSize: 13, color: '#6b6f7a' }}>Birkaç soru — 2 dakika sürer</div>
        {/* Progress bar */}
        <div style={{ marginTop: 18, background: '#2a2d35', borderRadius: 99, height: 4 }}>
          <div style={{ height: 4, borderRadius: 99, background: '#4a9eff', width: `${ilerleme}%`, transition: 'width .4s ease' }} />
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: '#6b6f7a' }}>{adim} / {TOPLAM_ADIM}</div>
      </div>

      <div style={S.body}>
        {/* ── ADIM 1: Kişisel ── */}
        {adim === 1 && (
          <div>
            <AdimBaslik no={1} baslik="Seni Tanıyalım" aciklama="Temel bilgilerin — sadece seninle iletişim kurmak için kullanılır." />
            <div style={S.card}>
              <label style={S.label}>Ad Soyad *</label>
              <input style={S.input} placeholder="Adın ve soyadın" value={form.ad_soyad}
                onChange={e => set('ad_soyad', e.target.value)} />
            </div>
            <div style={S.card}>
              <label style={S.label}>Telefon *</label>
              <input style={S.input} placeholder="05XX XXX XX XX" inputMode="tel" value={form.telefon}
                onChange={e => set('telefon', e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={S.card}>
                <label style={S.label}>Doğum Yılı</label>
                <input style={S.input} placeholder="1998" inputMode="numeric" maxLength={4} value={form.dogum_yili}
                  onChange={e => set('dogum_yili', e.target.value)} />
              </div>
              <div style={S.card}>
                <label style={S.label}>Semt / İlçe</label>
                <input style={S.input} placeholder="Bornova" value={form.ilce}
                  onChange={e => set('ilce', e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {/* ── ADIM 2: Pozisyon & Şube ── */}
        {adim === 2 && (
          <div>
            <AdimBaslik no={2} baslik="Ne İş Yapmak İstersin?" aciklama="Hangi rolde görmek istersin kendini?" />
            <div style={S.card}>
              <label style={S.label}>Başvurduğun Pozisyon</label>
              <ChipGroup
                secenekler={[
                  { value: 'barista',  label: '☕ Barista' },
                  { value: 'kasiyer', label: '💵 Kasiyer' },
                  { value: 'servis',  label: '🙋 Servis' },
                  { value: 'diger',   label: '✨ Diğer' },
                ]}
                secili={form.pozisyon}
                onChange={v => set('pozisyon', v)}
              />
            </div>
            <div style={S.card}>
              <label style={S.label}>Hangi Şubeye Yakınsın? <span style={{ color: '#6b6f7a', fontWeight: 400 }}>(birden fazla seçebilirsin)</span></label>
              <ChipGroup
                coklu
                secenekler={[...SUBELER.map(s => ({ value: s, label: s })), { value: 'herhangi', label: '📍 Herhangi biri' }]}
                secili={form.tercih_subeler}
                onChange={v => set('tercih_subeler', v)}
              />
            </div>
            <div style={S.card}>
              <label style={S.label}>Çalışma Tercihin</label>
              <ChipGroup
                secenekler={[
                  { value: 'tam',   label: '🕘 Tam Zamanlı' },
                  { value: 'yari',  label: '⏰ Yarı Zamanlı' },
                  { value: 'esnek', label: '🔄 Esnek' },
                ]}
                secili={form.calisma_tercihi}
                onChange={v => set('calisma_tercihi', v)}
              />
            </div>
          </div>
        )}

        {/* ── ADIM 3: Deneyim & Müsaitlik ── */}
        {adim === 3 && (
          <div>
            <AdimBaslik no={3} baslik="Deneyim & Müsaitlik" aciklama="Deneyimin olmasa da sorun değil — öğrenmek yeterli!" />
            <div style={S.card}>
              <label style={S.label}>Kahve / Barista Deneyimin</label>
              <ChipGroup
                secenekler={[
                  { value: 'var_1yil',    label: '1 yıldan az' },
                  { value: 'var_2yil',    label: '1–3 yıl' },
                  { value: 'var_uzun',    label: '3+ yıl' },
                  { value: 'kismi',       label: 'Biraz biliyorum' },
                  { value: 'yok_ogreneyim', label: '🌱 Yok ama öğrenirim' },
                ]}
                secili={form.kahve_deneyim}
                onChange={v => set('kahve_deneyim', v)}
              />
            </div>
            <div style={S.card}>
              <label style={S.label}>Daha Önce Nerede Çalıştın? <span style={{ color: '#6b6f7a', fontWeight: 400 }}>(opsiyonel)</span></label>
              <textarea style={S.textarea} placeholder="Örn: Starbucks Alsancak'ta 8 ay kasiyer olarak çalıştım."
                value={form.onceki_is} onChange={e => set('onceki_is', e.target.value)} />
            </div>
            <div style={S.card}>
              <label style={S.label}>Hangi Günler Çalışabilirsin? <span style={{ color: '#6b6f7a', fontWeight: 400 }}>(birden fazla)</span></label>
              <ChipGroup
                coklu
                secenekler={GUNLER.map(g => ({ value: g, label: g }))}
                secili={form.musait_gunler}
                onChange={v => set('musait_gunler', v)}
              />
            </div>
            <div style={S.card}>
              <label style={S.label}>Ne Zaman Başlayabilirsin?</label>
              <ChipGroup
                secenekler={[
                  { value: 'hemen',   label: '⚡ Hemen' },
                  { value: '2hafta',  label: '📅 2 Hafta içinde' },
                  { value: '1ay',     label: '🗓️ 1 Ay içinde' },
                ]}
                secili={form.baslangic}
                onChange={v => set('baslangic', v)}
              />
            </div>
          </div>
        )}

        {/* ── ADIM 4: Tanıtım & Referans ── */}
        {adim === 4 && (
          <div>
            <AdimBaslik no={4} baslik="Son Dokunuşlar" aciklama="Kendinden bahset ve referansını ekle." />
            <div style={S.card}>
              <label style={S.label}>Kendini Kısaca Tanıt <span style={{ color: '#6b6f7a', fontWeight: 400 }}>(1–3 cümle)</span></label>
              <textarea style={{ ...S.textarea, minHeight: 110 }}
                placeholder="Merhaba! Ben... Boş zamanlarımda... Çünkü..."
                value={form.tanitim} onChange={e => set('tanitim', e.target.value)} />
              <div style={{ fontSize: 11, color: '#6b6f7a', marginTop: 6 }}>{form.tanitim.length}/300 karakter</div>
            </div>
            <div style={S.card}>
              <label style={S.label}>Referans <span style={{ color: '#6b6f7a', fontWeight: 400 }}>(opsiyonel)</span></label>
              <input style={{ ...S.input, marginBottom: 10 }} placeholder="Ad Soyad" value={form.referans_ad}
                onChange={e => set('referans_ad', e.target.value)} />
              <input style={S.input} placeholder="Telefon" inputMode="tel" value={form.referans_tel}
                onChange={e => set('referans_tel', e.target.value)} />
            </div>

            {hata && (
              <div style={{ background: 'rgba(224,92,92,0.1)', border: '1px solid rgba(224,92,92,0.3)', borderRadius: 10, padding: '12px 14px', fontSize: 13, color: '#e05c5c', marginBottom: 16 }}>
                ⚠️ {hata}
              </div>
            )}
          </div>
        )}

        {/* Navigasyon */}
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          {adim > 1 && (
            <button style={{ ...S.btn, background: '#1a1d24', border: '1px solid #2a2d35', color: '#9ca3af', flex: 1 }}
              onClick={() => setAdim(a => a - 1)}>
              ← Geri
            </button>
          )}
          {adim < TOPLAM_ADIM ? (
            <button style={{ ...S.btn, background: '#4a9eff', color: '#fff', flex: 2 }}
              onClick={() => {
                if (adim === 1 && !form.ad_soyad.trim()) { setHata('Ad soyad zorunlu.'); return; }
                if (adim === 1 && !form.telefon.trim()) { setHata('Telefon zorunlu.'); return; }
                setHata('');
                setAdim(a => a + 1);
              }}>
              Devam Et →
            </button>
          ) : (
            <button style={{ ...S.btn, background: yukleniyor ? '#2a2d35' : '#4caf84', color: '#fff', flex: 2, opacity: yukleniyor ? 0.7 : 1 }}
              onClick={gonder} disabled={yukleniyor}>
              {yukleniyor ? '⏳ Gönderiliyor…' : '🚀 Başvuruyu Gönder'}
            </button>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: '#4b5563' }}>
          ☕ Evvel Kahve · evvel-erp-production.up.railway.app
        </div>
      </div>
    </div>
  );
}
