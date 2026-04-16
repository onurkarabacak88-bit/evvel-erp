import { useState, useEffect } from 'react';
import { api, fmt, fmtDate, today } from '../utils/api';
import PersonelVardiyaPlanning from './PersonelVardiyaPlanning';

const IHTIYAC_GUN_ETIKET = {
  hergun: 'Her gün',
  hafta_ici: 'Hafta içi',
  hafta_sonu: 'Hafta sonu',
  pazartesi: 'Pazartesi',
  sali: 'Salı',
  carsamba: 'Çarşamba',
  persembe: 'Perşembe',
  cuma: 'Cuma',
  cumartesi: 'Cumartesi',
  pazar: 'Pazar',
};

function ihtiyacGunEtiket(kod) {
  return IHTIYAC_GUN_ETIKET[kod] || kod;
}

function ihtiyacTurEtiket(kod) {
  if (kod === 'tam') return 'Tam zamanlı';
  if (kod === 'part') return 'Yarı zamanlı';
  if (kod === 'farketmez') return 'Fark etmez';
  return kod;
}

export default function Subeler() {
  const [subeler, setSubeler] = useState([]);
  const [aktifSekme, setAktifSekme] = useState('sube-kurallari');
  const [seciliSubeId, setSeciliSubeId] = useState(null);
  const [ihtiyaclar, setIhtiyaclar] = useState([]);
  const [altKurallar, setAltKurallar] = useState([]);
  const [karsilanmayanlar, setKarsilanmayanlar] = useState([]);
  const [kontrolTarih, setKontrolTarih] = useState(today());
  const [ihtiyacForm, setIhtiyacForm] = useState({
    gun_tipi: 'hergun',
    rol: 'genel',
    bas_saat: '09:00',
    bit_saat: '18:00',
    gereken_kisi: 1,
    minimum_kisi: 1,
    gereken_tur: 'farketmez',
    kritik: false,
  });

  const [altForm, setAltForm] = useState({
    gun_tipi: 'hergun',
    rol: 'genel',
    minimum_kisi: 1,
    ideal_kisi: 1,
    izinli_tam: true,
    izinli_part: true,
    mesai_izinli: false,
    notlar: '',
  });
  const [msg, setMsg] = useState(null);
  const [duzenle, setDuzenle] = useState({});
  const [onizle, setOnizle] = useState(null);      // { sid, data }
  const [tarihForm, setTarihForm] = useState(null); // { sid, baslangic, bitis }
  const [loading, setLoading] = useState(false);

  // Sistem sıfırlama
  const TABLOLAR = [
    { key: 'ciro',             label: 'Ciro Girişleri',         ikon: '📈', aciklama: 'Tüm ciro kayıtları' },
    { key: 'kasa',             label: 'Kasa Hareketleri',        ikon: '💰', aciklama: 'Tüm kasa işlemleri' },
    { key: 'kart_hareketleri', label: 'Kart Hareketleri',        ikon: '💳', aciklama: 'Tüm kart işlemleri' },
    { key: 'anlik_gider',      label: 'Anlık Giderler',          ikon: '💸', aciklama: 'Anlık gider kayıtları' },
    { key: 'vadeli_alim',      label: 'Vadeli Alımlar',          ikon: '📦', aciklama: 'Vadeli alım kayıtları' },
    { key: 'personel',         label: 'Personel',                ikon: '👥', aciklama: 'Personel listesi' },
    { key: 'personel_aylik',   label: 'Aylık Maaş Kayıtları',   ikon: '👤', aciklama: 'Maaş giriş kayıtları' },
    { key: 'sabit_gider',      label: 'Sabit Giderler',          ikon: '🏠', aciklama: 'Sabit gider tanımları' },
    { key: 'borc',             label: 'Borç Envanteri',          ikon: '🏦', aciklama: 'Kredi/borç kayıtları' },
    { key: 'odeme_plani',      label: 'Ödeme Planları',          ikon: '📅', aciklama: 'Bekleyen ödeme planları' },
    { key: 'onay_kuyrugu',     label: 'Onay Kuyruğu',            ikon: '✅', aciklama: 'Bekleyen onaylar' },
    { key: 'audit_log',        label: 'Denetim günlüğü',        ikon: '📋', aciklama: 'İşlem geçmişi' },
  ];
  const [sifirlaModal, setSifirlaModal] = useState(false);
  const [seciliTablolar, setSeciliTablolar] = useState({});
  const [sifirlaOnay, setSifirlaOnay] = useState('');
  const [sifirlaLoading, setSifirlaLoading] = useState(false);

  const tumunuSec = (val) => {
    const yeni = {};
    TABLOLAR.forEach(t => { yeni[t.key] = val; });
    setSeciliTablolar(yeni);
  };

  const seciliSayi = Object.values(seciliTablolar).filter(Boolean).length;

  async function sistemSifirla() {
    const tablolar = TABLOLAR.filter(t => seciliTablolar[t.key]).map(t => t.key);
    if (tablolar.length === 0) { toast('En az 1 tablo seçin', 'red'); return; }
    if (sifirlaOnay !== 'EVET_SIL') { toast("Onay için EVET_SIL yazın", 'red'); return; }
    setSifirlaLoading(true);
    try {
      const res = await api('/sistem-sifirla', { method: 'POST', body: { onay: 'EVET_SIL', tablolar } });
      toast(`✓ ${res.silinen?.length || tablolar.length} tablo temizlendi`, 'green');
      setSifirlaModal(false);
      setSifirlaOnay('');
      setSeciliTablolar({});
    } catch(e) { toast(e.message, 'red'); }
    finally { setSifirlaLoading(false); }
  }

  const load = () => api('/subeler').then(setSubeler);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!subeler.length) return;
    if (!seciliSubeId || !subeler.some((s) => s.id === seciliSubeId)) {
      setSeciliSubeId(subeler[0].id);
    }
  }, [subeler, seciliSubeId]);
  useEffect(() => {
    if (!seciliSubeId) return;
    api(`/subeler/${seciliSubeId}/ihtiyaclar`)
      .then((rows) => setIhtiyaclar(Array.isArray(rows) ? rows : []))
      .catch(() => setIhtiyaclar([]));
  }, [seciliSubeId]);
  useEffect(() => {
    if (!seciliSubeId) return;
    api(`/subeler/${seciliSubeId}/vardiya-alternatif-kurallar`)
      .then((rows) => setAltKurallar(Array.isArray(rows) ? rows : []))
      .catch(() => setAltKurallar([]));
  }, [seciliSubeId]);

  const toast = (m, t = 'green') => { setMsg({ m, t }); setTimeout(() => setMsg(null), 4000); };
  const set = (sid, field, val) => setDuzenle(d => ({ ...d, [sid]: { ...d[sid], [field]: val } }));

  // Adım 1: Oranı kaydet → tarih seçim formunu aç
  async function kaydet(s) {
    try {
      const pos_oran = parseFloat(duzenle[s.id]?.pos_oran ?? s.pos_oran ?? 0);
      const online_oran = parseFloat(duzenle[s.id]?.online_oran ?? s.online_oran ?? 0);
      const min_personel = parseInt(duzenle[s.id]?.min_personel ?? s.min_personel ?? 1, 10);
      const yogun_saat_ek_personel = parseInt(
        duzenle[s.id]?.yogun_saat_ek_personel ?? s.yogun_saat_ek_personel ?? 0,
        10
      );
      await api(`/subeler/${s.id}`, {
        method: 'PUT',
        body: {
          pos_oran,
          online_oran,
          acilis_saati: duzenle[s.id]?.acilis_saati ?? s.acilis_saati ?? null,
          kapanis_saati: duzenle[s.id]?.kapanis_saati ?? s.kapanis_saati ?? null,
          yogun_saat_baslangic: duzenle[s.id]?.yogun_saat_baslangic ?? s.yogun_saat_baslangic ?? null,
          yogun_saat_bitis: duzenle[s.id]?.yogun_saat_bitis ?? s.yogun_saat_bitis ?? null,
          ortusme_gerekli: Boolean(duzenle[s.id]?.ortusme_gerekli ?? s.ortusme_gerekli ?? false),
          vardiya_yazilsin: Boolean(duzenle[s.id]?.vardiya_yazilsin ?? s.vardiya_yazilsin ?? true),
          acilis_sadece_part: Boolean(duzenle[s.id]?.acilis_sadece_part ?? s.acilis_sadece_part ?? false),
          kapanis_sadece_part: Boolean(duzenle[s.id]?.kapanis_sadece_part ?? s.kapanis_sadece_part ?? false),
          min_personel: Number.isNaN(min_personel) ? 1 : min_personel,
          yogun_saat_ek_personel: Number.isNaN(yogun_saat_ek_personel) ? 0 : yogun_saat_ek_personel,
          acilis_max_kisi: (() => {
            const raw = duzenle[s.id]?.acilis_max_kisi ?? s.acilis_max_kisi;
            if (raw === '' || raw === undefined || raw === null) return null;
            const n = parseInt(raw, 10);
            return Number.isNaN(n) || n < 1 ? null : n;
          })(),
          sube_tipi: (duzenle[s.id]?.sube_tipi ?? s.sube_tipi ?? 'normal'),
        },
      });
      toast('✓ Oranlar kaydedildi');
      load();
      // Ay başı ve bugün varsayılan
      const bugun = today();
      const ayBasi = bugun.slice(0, 7) + '-01';
      setTarihForm({ sid: s.id, baslangic: ayBasi, bitis: bugun });
    } catch (e) { toast(e.message, 'red'); }
  }

  // Adım 2: Tarih seçildi → önizle
  async function onizleGetir() {
    if (!tarihForm) return;
    setLoading(true);
    try {
      const { sid, baslangic, bitis } = tarihForm;
      const data = await api(`/subeler/${sid}/kasa-onizle?baslangic=${baslangic}&bitis=${bitis}`);
      setOnizle({ sid, data });
      setTarihForm(null);
    } catch (e) { toast(e.message, 'red'); }
    finally { setLoading(false); }
  }

  // Adım 3: Kullanıcı onayladı → düzelt
  async function duzeltOnayla() {
    if (!onizle) return;
    setLoading(true);
    try {
      const { sid, data } = onizle;
      const res = await api(`/subeler/${sid}/kasa-duzelt`, {
        method: 'POST',
        body: { baslangic: data.baslangic, bitis: data.bitis }
      });
      if (res.success) {
        toast(`✓ ${res.duzeltilen} kayıt düzeltildi. Kasa etkisi: ${fmt(res.toplam_fark)}`, 'green');
        setOnizle(null);
        load(); // Şube listesini yenile
      } else {
        toast('⚠️ Düzeltme tamamlanamadı. Lütfen tekrar deneyin.', 'red');
      }
    } catch (e) {
      toast(`❌ Hata: ${e.message}`, 'red');
    }
    finally { setLoading(false); }
  }

  async function ihtiyacEkle() {
    if (!seciliSubeId) return;
    try {
      await api(`/subeler/${seciliSubeId}/ihtiyaclar`, {
        method: 'POST',
        body: {
          ...ihtiyacForm,
          gereken_kisi: Number(ihtiyacForm.gereken_kisi || 1),
          minimum_kisi: Number(ihtiyacForm.minimum_kisi || 0),
        },
      });
      const rows = await api(`/subeler/${seciliSubeId}/ihtiyaclar`);
      setIhtiyaclar(Array.isArray(rows) ? rows : []);
      toast('✓ İhtiyaç satırı eklendi');
    } catch (e) {
      toast(e.message || 'İhtiyaç eklenemedi', 'red');
    }
  }

  async function ihtiyacSil(iid) {
    if (!seciliSubeId) return;
    try {
      await api(`/subeler/${seciliSubeId}/ihtiyaclar/${iid}`, { method: 'DELETE' });
      const rows = await api(`/subeler/${seciliSubeId}/ihtiyaclar`);
      setIhtiyaclar(Array.isArray(rows) ? rows : []);
      toast('✓ İhtiyaç satırı silindi');
    } catch (e) {
      toast(e.message || 'İhtiyaç silinemedi', 'red');
    }
  }

  async function altKuralEkle() {
    if (!seciliSubeId) return;
    try {
      await api(`/subeler/${seciliSubeId}/vardiya-alternatif-kurallar`, {
        method: 'POST',
        body: {
          ...altForm,
          minimum_kisi: Number(altForm.minimum_kisi || 0),
          ideal_kisi: Number(altForm.ideal_kisi || 1),
          notlar: altForm.notlar || null,
        },
      });
      const rows = await api(`/subeler/${seciliSubeId}/vardiya-alternatif-kurallar`);
      setAltKurallar(Array.isArray(rows) ? rows : []);
      toast('✓ Alternatif kural eklendi');
    } catch (e) {
      toast(e.message || 'Kural eklenemedi', 'red');
    }
  }

  async function altKuralSil(rid) {
    if (!seciliSubeId) return;
    try {
      await api(`/subeler/${seciliSubeId}/vardiya-alternatif-kurallar/${rid}`, { method: 'DELETE' });
      const rows = await api(`/subeler/${seciliSubeId}/vardiya-alternatif-kurallar`);
      setAltKurallar(Array.isArray(rows) ? rows : []);
      toast('✓ Kural silindi');
    } catch (e) {
      toast(e.message || 'Kural silinemedi', 'red');
    }
  }

  async function ihtiyacKontroluCalistir() {
    if (!seciliSubeId || !kontrolTarih) return;
    try {
      const res = await api(`/subeler/${seciliSubeId}/ihtiyac-kontrol?tarih=${encodeURIComponent(kontrolTarih)}`);
      setKarsilanmayanlar(Array.isArray(res.karsilanmayan_ihtiyaclar) ? res.karsilanmayan_ihtiyaclar : []);
      toast('✓ İhtiyaç kontrolü tamamlandı');
    } catch (e) {
      toast(e.message || 'İhtiyaç kontrolü başarısız', 'red');
      setKarsilanmayanlar([]);
    }
  }

  return (
    <div className="page">
      {msg && <div className={`alert-box ${msg.t} mb-16`}>{msg.m}</div>}
      <div className="page-header">
        <h2>🗓️ Vardiya Planlaması</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)' }}>
          Şubeye tıklayarak vardiya kurallarını o şube için ayrı tanımlayın.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 10 }}>
        <button
          className={`btn btn-sm ${aktifSekme === 'sube-kurallari' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setAktifSekme('sube-kurallari')}
        >
          Şube Kuralları
        </button>
        <button
          className={`btn btn-sm ${aktifSekme === 'personel-kisitlari' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setAktifSekme('personel-kisitlari')}
        >
          Personel Kısıtları
        </button>
      </div>

      {aktifSekme === 'sube-kurallari' && (
      <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        {subeler.map(s => {
          const secili = seciliSubeId === s.id;
          const posOran = parseFloat(duzenle[s.id]?.pos_oran ?? s.pos_oran ?? 0);
          const onlineOran = parseFloat(duzenle[s.id]?.online_oran ?? s.online_oran ?? 0);
          return (
            <div key={s.id} style={{
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 10, padding: '16px 20px', cursor: 'pointer',
              boxShadow: secili ? '0 0 0 2px rgba(74,158,255,0.35) inset' : 'none'
            }}>
              <div
                onClick={() => setSeciliSubeId(s.id)}
                style={{ fontWeight: 700, fontSize: 15, marginBottom: secili ? 14 : 0 }}
              >
                🏪 {s.ad} {secili ? '· seçili' : ''}
              </div>
              {secili && (
              <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    💳 POS kesinti oranı (%)
                  </label>
                  <input type="number" step="0.01" min="0" max="10"
                    defaultValue={s.pos_oran || 0}
                    onChange={e => set(s.id, 'pos_oran', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    🌐 Çevrimiçi kesinti oranı (%)
                  </label>
                  <input type="number" step="0.01" min="0" max="10"
                    defaultValue={s.online_oran || 0}
                    onChange={e => set(s.id, 'online_oran', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Şube tipi
                  </label>
                  <select
                    defaultValue={s.sube_tipi || 'normal'}
                    onChange={e => set(s.id, 'sube_tipi', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  >
                    <option value="normal">Normal Şube</option>
                    <option value="depo">Depo Şubesi</option>
                    <option value="karma">Karma (Şube + Depo)</option>
                  </select>
                </div>
                <div />
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Açılış saati
                  </label>
                  <input type="time"
                    defaultValue={s.acilis_saati || ''}
                    onChange={e => set(s.id, 'acilis_saati', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Kapanış saati
                  </label>
                  <input type="time"
                    defaultValue={s.kapanis_saati || ''}
                    onChange={e => set(s.id, 'kapanis_saati', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Yoğun saat başlangıç
                  </label>
                  <input type="time"
                    defaultValue={s.yogun_saat_baslangic || ''}
                    onChange={e => set(s.id, 'yogun_saat_baslangic', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Yoğun saat bitiş
                  </label>
                  <input type="time"
                    defaultValue={s.yogun_saat_bitis || ''}
                    onChange={e => set(s.id, 'yogun_saat_bitis', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Minimum personel
                  </label>
                  <input type="number" min="1"
                    defaultValue={s.min_personel ?? 1}
                    onChange={e => set(s.id, 'min_personel', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Açılışta en fazla kişi (boş = sınır yok)
                  </label>
                  <input type="number" min="1" placeholder="Örn. 1"
                    defaultValue={s.acilis_max_kisi ?? ''}
                    onChange={e => set(s.id, 'acilis_max_kisi', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>
                    Yoğun saat ek personel
                  </label>
                  <input type="number" min="0"
                    defaultValue={s.yogun_saat_ek_personel ?? 0}
                    onChange={e => set(s.id, 'yogun_saat_ek_personel', e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 14 }}
                  />
                </div>
              </div>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                <input
                  type="checkbox"
                  defaultChecked={Boolean(s.vardiya_yazilsin ?? true)}
                  onChange={e => set(s.id, 'vardiya_yazilsin', e.target.checked)}
                />
                Bu şubeye vardiya yazılsın
              </label>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                <input
                  type="checkbox"
                  defaultChecked={Boolean(s.ortusme_gerekli)}
                  onChange={e => set(s.id, 'ortusme_gerekli', e.target.checked)}
                />
                Yoğun saatlerde örtüşme (aynı anda ek personel) gerekli
              </label>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  defaultChecked={Boolean(s.acilis_sadece_part)}
                  onChange={e => set(s.id, 'acilis_sadece_part', e.target.checked)}
                />
                Açılışta sadece yarı zamanlı personel
              </label>
              <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                <input
                  type="checkbox"
                  defaultChecked={Boolean(s.kapanis_sadece_part)}
                  onChange={e => set(s.id, 'kapanis_sadece_part', e.target.checked)}
                />
                Kapanışta sadece yarı zamanlı personel
              </label>

              {(posOran > 0 || onlineOran > 0) && (
                <div style={{ background: 'var(--bg3)', borderRadius: 6, padding: '10px 12px', fontSize: 12, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.8 }}>
                  {posOran > 0 && <div>💳 10.000 ₺ POS → <strong style={{ color: 'var(--red)' }}>{fmt(10000 * posOran / 100)} kesinti</strong>, kasaya <strong style={{ color: 'var(--green)' }}>{fmt(10000 - 10000 * posOran / 100)}</strong></div>}
                  {onlineOran > 0 && <div>🌐 10.000 ₺ çevrimiçi → <strong style={{ color: 'var(--red)' }}>{fmt(10000 * onlineOran / 100)} kesinti</strong>, kasaya <strong style={{ color: 'var(--green)' }}>{fmt(10000 - 10000 * onlineOran / 100)}</strong></div>}
                </div>
              )}

              <button className="btn btn-primary btn-sm" onClick={() => kaydet(s)}>
                Kaydet
              </button>
              </>
              )}
            </div>
          );
        })}
      </div>
      </>
      )}

      {aktifSekme === 'personel-kisitlari' && <PersonelVardiyaPlanning />}

      <div style={{ marginTop: 22, maxWidth: 760 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
          Şube İhtiyaç Satırları
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 120px 100px 100px 90px 90px 120px 90px auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</label>
            <select value={ihtiyacForm.gun_tipi} onChange={(e) => setIhtiyacForm((f) => ({ ...f, gun_tipi: e.target.value }))}>
              <option value="hergun">Her gün</option>
              <option value="hafta_ici">Hafta içi</option>
              <option value="hafta_sonu">Hafta sonu</option>
              <option value="pazartesi">Pazartesi</option>
              <option value="sali">Salı</option>
              <option value="carsamba">Çarşamba</option>
              <option value="persembe">Perşembe</option>
              <option value="cuma">Cuma</option>
              <option value="cumartesi">Cumartesi</option>
              <option value="pazar">Pazar</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Rol</label>
            <select value={ihtiyacForm.rol} onChange={(e) => setIhtiyacForm((f) => ({ ...f, rol: e.target.value }))}>
              <option value="genel">Genel</option>
              <option value="acilis">Açılış</option>
              <option value="kapanis">Kapanış</option>
              <option value="yogunluk">Yoğunluk</option>
              <option value="araci">Aracı</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Başlangıç</label>
            <input type="time" value={ihtiyacForm.bas_saat} onChange={(e) => setIhtiyacForm((f) => ({ ...f, bas_saat: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Bitiş</label>
            <input type="time" value={ihtiyacForm.bit_saat} onChange={(e) => setIhtiyacForm((f) => ({ ...f, bit_saat: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>İdeal kişi</label>
            <input type="number" min="1" value={ihtiyacForm.gereken_kisi} onChange={(e) => setIhtiyacForm((f) => ({ ...f, gereken_kisi: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Minimum kişi</label>
            <input type="number" min="0" value={ihtiyacForm.minimum_kisi} onChange={(e) => setIhtiyacForm((f) => ({ ...f, minimum_kisi: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Tür</label>
            <select value={ihtiyacForm.gereken_tur} onChange={(e) => setIhtiyacForm((f) => ({ ...f, gereken_tur: e.target.value }))}>
              <option value="farketmez">Fark etmez</option>
              <option value="tam">Tam zamanlı</option>
              <option value="part">Yarı zamanlı</option>
            </select>
          </div>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
            <input type="checkbox" checked={ihtiyacForm.kritik} onChange={(e) => setIhtiyacForm((f) => ({ ...f, kritik: e.target.checked }))} />
            Kritik
          </label>
          <button className="btn btn-primary btn-sm" onClick={ihtiyacEkle} disabled={!seciliSubeId}>Satır ekle</button>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 14 }}>
          {!ihtiyaclar.length ? (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu şube için ihtiyaç satırı yok.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ihtiyaclar.map((x) => (
                <div key={x.id} style={{ display: 'grid', gridTemplateColumns: '120px 90px 170px 120px 100px 70px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <div>{ihtiyacGunEtiket(x.gun_tipi)}</div>
                  <div>{x.rol || 'genel'}</div>
                  <div>{x.bas_saat} - {x.bit_saat}</div>
                  <div>{x.minimum_kisi ?? 1}–{x.gereken_kisi} kişi</div>
                  <div>{ihtiyacTurEtiket(x.gereken_tur)}</div>
                  <button className="btn btn-danger btn-sm" onClick={() => ihtiyacSil(x.id)}>Sil</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
          Vardiya Alternatif Kuralları (minimum/ideal, karışım, mesai)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 120px 90px 90px 140px 120px auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Gün</label>
            <select value={altForm.gun_tipi} onChange={(e) => setAltForm((f) => ({ ...f, gun_tipi: e.target.value }))}>
              <option value="hergun">Her gün</option>
              <option value="hafta_ici">Hafta içi</option>
              <option value="hafta_sonu">Hafta sonu</option>
              <option value="pazartesi">Pazartesi</option>
              <option value="sali">Salı</option>
              <option value="carsamba">Çarşamba</option>
              <option value="persembe">Perşembe</option>
              <option value="cuma">Cuma</option>
              <option value="cumartesi">Cumartesi</option>
              <option value="pazar">Pazar</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Rol</label>
            <select value={altForm.rol} onChange={(e) => setAltForm((f) => ({ ...f, rol: e.target.value }))}>
              <option value="genel">Genel</option>
              <option value="acilis">Açılış</option>
              <option value="kapanis">Kapanış</option>
              <option value="yogunluk">Yoğunluk</option>
              <option value="araci">Aracı</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Minimum</label>
            <input type="number" min="0" value={altForm.minimum_kisi} onChange={(e) => setAltForm((f) => ({ ...f, minimum_kisi: e.target.value }))} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>İdeal</label>
            <input type="number" min="1" value={altForm.ideal_kisi} onChange={(e) => setAltForm((f) => ({ ...f, ideal_kisi: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
              <input type="checkbox" checked={altForm.izinli_tam} onChange={(e) => setAltForm((f) => ({ ...f, izinli_tam: e.target.checked }))} />
              Tam
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
              <input type="checkbox" checked={altForm.izinli_part} onChange={(e) => setAltForm((f) => ({ ...f, izinli_part: e.target.checked }))} />
              Yarı zamanlı
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 7 }}>
              <input type="checkbox" checked={altForm.mesai_izinli} onChange={(e) => setAltForm((f) => ({ ...f, mesai_izinli: e.target.checked }))} />
              Mesai izinli
            </label>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Not</label>
            <input value={altForm.notlar} onChange={(e) => setAltForm((f) => ({ ...f, notlar: e.target.value }))} placeholder="Örn. Köyceğiz: zorlanınca 1 tam + 1 part" />
          </div>
          <button className="btn btn-primary btn-sm" onClick={altKuralEkle} disabled={!seciliSubeId}>Kural ekle</button>
        </div>

        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 14 }}>
          {!altKurallar.length ? (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>Bu şube için alternatif kural yok.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {altKurallar.map((r) => (
                <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '120px 90px 120px 140px auto 70px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <div>{ihtiyacGunEtiket(r.gun_tipi)}</div>
                  <div>{r.rol}</div>
                  <div>{r.minimum_kisi}–{r.ideal_kisi} kişi</div>
                  <div>
                    {(r.izinli_tam ? 'Tam' : '—')}{r.izinli_tam && r.izinli_part ? ' + ' : ''}{(r.izinli_part ? 'Yarı' : '')}
                    {r.mesai_izinli ? ' · Mesai' : ''}
                  </div>
                  <div style={{ color: 'var(--text3)' }}>{r.notlar || ''}</div>
                  <button className="btn btn-danger btn-sm" onClick={() => altKuralSil(r.id)}>Sil</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
          İhtiyaç Karşılama Kontrolü
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <input type="date" value={kontrolTarih} onChange={(e) => setKontrolTarih(e.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={ihtiyacKontroluCalistir} disabled={!seciliSubeId}>Kontrol et</button>
        </div>
        {karsilanmayanlar.length > 0 && (
          <div className="alert-box red">
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Karşılanmayan ihtiyaçlar</div>
            {karsilanmayanlar.map((k) => (
              <div key={k.ihtiyac_id} style={{ fontSize: 12 }}>
                {k.aralik} · {k.gereken_kisi} kişi · {ihtiyacTurEtiket(k.gereken_tur)}{k.kritik ? ' · KRİTİK' : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ADIM 2: Tarih Seçim Modalı */}
      {tarihForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, width: 400 }}>
            <h3 style={{ marginBottom: 6 }}>📅 Geçmiş Kayıtları Düzelt</h3>
            <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 20 }}>
              Hangi tarih aralığındaki kasa kayıtları yeni oranla yeniden hesaplansın?
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Başlangıç</label>
                <input type="date" value={tarihForm.baslangic}
                  onChange={e => setTarihForm(f => ({ ...f, baslangic: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Bitiş</label>
                <input type="date" value={tarihForm.bitis}
                  onChange={e => setTarihForm(f => ({ ...f, bitis: e.target.value }))}
                  style={{ width: '100%', padding: '8px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text1)', fontSize: 13 }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setTarihForm(null)}>İptal</button>
              <button className="btn btn-primary btn-sm" onClick={onizleGetir} disabled={loading}>
                {loading ? '⏳ Hesaplanıyor...' : 'Önizle →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ADIM 3: Önizleme + Onay Modalı */}
      {onizle && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, width: 500, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginBottom: 4 }}>🔍 Düzeltme Önizleme</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
              {onizle.data.sube_adi} · {fmtDate(onizle.data.baslangic)} – {fmtDate(onizle.data.bitis)}
              · POS %{onizle.data.pos_oran} · Çevrimiçi %{onizle.data.online_oran}
            </p>

            {onizle.data.etkilenen_kayit === 0 ? (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
                ✅ Bu aralıkta düzeltme gereken kayıt yok.
              </div>
            ) : (
              <>
                <div style={{ background: 'var(--bg3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 24 }}>
                  <div><div style={{ fontSize: 11, color: 'var(--text3)' }}>Etkilenen Kayıt</div><div style={{ fontSize: 18, fontWeight: 700 }}>{onizle.data.etkilenen_kayit}</div></div>
                  <div><div style={{ fontSize: 11, color: 'var(--text3)' }}>Toplam Kasa Etkisi</div><div style={{ fontSize: 18, fontWeight: 700, color: onizle.data.toplam_fark < 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(onizle.data.toplam_fark)}</div></div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, marginBottom: 16 }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: 'var(--text3)' }}>
                        <th style={{ textAlign: 'left', padding: '4px 8px' }}>Tarih</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Mevcut Kasa</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Doğru Kasa</th>
                        <th style={{ textAlign: 'right', padding: '4px 8px' }}>Fark</th>
                      </tr>
                    </thead>
                    <tbody>
                      {onizle.data.satirlar.map((r, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 8px' }}>{fmtDate(r.tarih)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmt(r.mevcut_kasa)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{fmt(r.dogru_kasa)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: r.fark < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{fmt(r.fark)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setOnizle(null)}>İptal</button>
              {onizle.data.etkilenen_kayit > 0 && (
                <button className="btn btn-primary btn-sm" onClick={duzeltOnayla} disabled={loading}>
                  {loading ? '⏳ Düzeltiliyor...' : `✓ ${onizle.data.etkilenen_kayit} Kaydı Düzelt`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── SİSTEM SIFIRLA BÖLÜMÜ ── */}
      <div style={{
        marginTop: 40, padding: '20px 24px',
        background: 'rgba(220,50,50,0.05)',
        border: '1px solid rgba(220,50,50,0.2)',
        borderRadius: 10, maxWidth: 560
      }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--red)', marginBottom: 4 }}>
          ⚠️ Tehlikeli Bölge — Veri Temizleme
        </div>
        <p style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
          Seçtiğiniz tabloların verileri kalıcı olarak silinir. Şubeler ve kartlar korunur.
        </p>
        <button className="btn btn-danger btn-sm"
          onClick={() => { setSifirlaModal(true); setSifirlaOnay(''); setSeciliTablolar({}); }}>
          🗑️ Veri Temizle
        </button>
      </div>

      {/* Sıfırlama Modalı */}
      {sifirlaModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ background:'var(--bg2)', border:'2px solid rgba(220,50,50,0.4)',
            borderRadius:12, padding:28, width:500, maxHeight:'90vh', overflowY:'auto' }}>

            <h3 style={{ color:'var(--red)', marginBottom:4 }}>🗑️ Veri Temizleme</h3>
            <p style={{ fontSize:12, color:'var(--text3)', marginBottom:16 }}>
              Silinecek tabloları seçin. Şubeler ve kartlar bu listede yok — korunur.
            </p>

            {/* Hepsi / Hiçbiri */}
            <div style={{ display:'flex', gap:8, marginBottom:12 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => tumunuSec(true)}>
                ☑️ Hepsini Seç
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => tumunuSec(false)}>
                ☐ Hiçbirini Seçme
              </button>
              {seciliSayi > 0 && (
                <span style={{ fontSize:12, color:'var(--red)', marginLeft:'auto', alignSelf:'center' }}>
                  {seciliSayi} tablo seçili
                </span>
              )}
            </div>

            {/* Tablo listesi */}
            <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:20 }}>
              {TABLOLAR.map(t => (
                <label key={t.key} style={{
                  display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
                  background: seciliTablolar[t.key] ? 'rgba(220,50,50,0.08)' : 'var(--bg3)',
                  border: `1px solid ${seciliTablolar[t.key] ? 'rgba(220,50,50,0.3)' : 'var(--border)'}`,
                  borderRadius:8, cursor:'pointer'
                }}>
                  <input type="checkbox"
                    checked={!!seciliTablolar[t.key]}
                    onChange={e => setSeciliTablolar(prev => ({...prev, [t.key]: e.target.checked}))}
                  />
                  <span style={{ fontSize:16 }}>{t.ikon}</span>
                  <div>
                    <div style={{ fontSize:13, fontWeight:600 }}>{t.label}</div>
                    <div style={{ fontSize:11, color:'var(--text3)' }}>{t.aciklama}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Onay */}
            {seciliSayi > 0 && (
              <>
                <p style={{ fontSize:12, color:'var(--text3)', marginBottom:6 }}>
                  Onaylamak için <strong style={{color:'var(--red)'}}>EVET_SIL</strong> yazın:
                </p>
                <input
                  value={sifirlaOnay}
                  onChange={e => setSifirlaOnay(e.target.value)}
                  placeholder="EVET_SIL"
                  style={{ width:'100%', padding:'10px 12px', borderRadius:6,
                    border:'1px solid var(--red)', background:'var(--bg3)',
                    color:'var(--text1)', fontSize:14, marginBottom:16, boxSizing:'border-box' }}
                />
              </>
            )}

            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button className="btn btn-secondary btn-sm"
                onClick={() => { setSifirlaModal(false); setSifirlaOnay(''); setSeciliTablolar({}); }}>
                İptal
              </button>
              <button className="btn btn-danger btn-sm"
                onClick={sistemSifirla}
                disabled={seciliSayi === 0 || sifirlaOnay !== 'EVET_SIL' || sifirlaLoading}>
                {sifirlaLoading ? '⏳ Siliniyor...' : `🗑️ ${seciliSayi} Tabloyu Temizle`}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
