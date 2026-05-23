import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';

/** main.py sistem_sifirla IZINLI anahtarları ile birebir aynı olmalı */
const GRUPLAR = [
  {
    baslik: 'Finans / muhasebe',
    anahtarlar: [
      ['ciro', 'ciro'],
      ['ciro_taslak', 'ciro_taslak'],
      ['kasa', 'kasa_hareketleri'],
      ['kart_hareketleri', 'kart_hareketleri'],
      ['banka_yatirimlari', 'banka_yatırımları'],
      ['anlik_gider', 'anlık giderler'],
      ['vadeli_alim', 'vadeli alımlar'],
      ['sabit_gider', 'sabit giderler'],
      ['borc', 'borç envanteri'],
      ['odeme_plani', 'ödeme planı'],
      ['onay_kuyrugu', 'onay kuyruğu'],
      ['x_rapor_kayit', 'X rapor kayıtları'],
    ],
  },
  {
    baslik: 'Personel (tanım ve aylık kayıtlar da silinir — dikkat)',
    anahtarlar: [
      ['personel', 'personel'],
      ['personel_aylik', 'personel aylık'],
      ['personel_risk_sinyal', 'personel risk'],
      ['personel_takip', 'personel takip'],
    ],
  },
  {
    baslik: 'Şube operasyon & stok',
    anahtarlar: [
      ['sube_acilis', 'şube açılış'],
      ['sube_operasyon_event', 'operasyon olayları (açılış/kapanış…)'],
      ['sube_operasyon_uyari', 'operasyon uyarıları'],
      ['sube_operasyon_ozet', 'operasyon özet'],
      ['sube_fire_haftalik', 'fire haftalık'],
      ['operasyon_defter', 'operasyon defteri'],
      ['sube_kasa_gun_acma', 'kasa gün açma'],
      ['kapanis_kayit', 'kapanış kayıtları'],
      ['sube_depo_stok', 'şube depo stok'],
      ['stok_yolda', 'stok yolda'],
      ['sube_skor', 'şube skor'],
      ['sube_merkez_mesaj', 'merkez mesajları (şube)'],
      ['sube_merkez_not', 'merkez notları'],
      ['panel_pin_guvenlik', 'panel PIN güvenlik olayları'],
      ['operasyon_guvenlik_olay', 'operasyon güvenlik olayları'],
      ['operasyon_guvenlik_alarm_durum', 'güvenlik alarm durumu'],
      ['motor_analitik_olay', 'motor analitik'],
      ['kasa_teslim', 'kasa teslim'],
    ],
  },
  {
    baslik: 'Sipariş & sevkiyat',
    anahtarlar: [
      ['siparis_talep', 'sipariş talepleri'],
      ['siparis_ozel_talep', 'özel sipariş talepleri'],
      ['siparis_sevk_eksik', 'sevk eksik'],
      ['merkez_stok_sevk', 'merkez stok sevk'],
    ],
  },
  {
    baslik: 'Denetim',
    anahtarlar: [['audit_log', 'denetim günlüğü']],
  },
];

const TUM_ANAHTARLAR = GRUPLAR.flatMap((g) => g.anahtarlar.map(([k]) => k));

const ONAY_METNI = 'EVET_SIL';

export default function VeriTemizle() {
  const [secili, setSecili] = useState(() => new Set());
  const [onay, setOnay] = useState('');
  const [busy, setBusy] = useState(false);
  const [sonuc, setSonuc] = useState(null);
  const [hata, setHata] = useState(null);
  const [depoKalinti, setDepoKalinti] = useState(null);
  const [depoBusy, setDepoBusy] = useState(false);
  const [depoSonuc, setDepoSonuc] = useState(null);
  const [depoHata, setDepoHata] = useState(null);

  const depoKalintiYukle = async () => {
    try {
      const r = await api('/ops/siparis/depo-akisi-kalinti');
      setDepoKalinti(r);
    } catch (e) {
      setDepoHata(e.message || 'Kalıntı özeti yüklenemedi');
    }
  };

  useEffect(() => {
    depoKalintiYukle();
  }, []);

  const presetSiparisDepo = () => {
    setSecili(
      new Set([
        'stok_yolda',
        'siparis_talep',
        'siparis_ozel_talep',
        'siparis_sevk_eksik',
        'merkez_stok_sevk',
      ]),
    );
    setSonuc(null);
    setHata(null);
  };

  const depoAkisiTemizle = async () => {
    setDepoHata(null);
    setDepoSonuc(null);
    if (onay.trim() !== ONAY_METNI) {
      setDepoHata(`Onay kutusuna tam olarak «${ONAY_METNI}» yazın.`);
      return;
    }
    setDepoBusy(true);
    try {
      const r = await api('/ops/siparis/depo-akisi-temizle', {
        method: 'POST',
        body: { onay: ONAY_METNI },
      });
      setDepoSonuc(r);
      setOnay('');
      await depoKalintiYukle();
      try {
        publishGlobalDataRefresh('veri-temizleme');
      } catch (_) {}
    } catch (e) {
      setDepoHata(e.message || 'Temizlik başarısız');
    } finally {
      setDepoBusy(false);
    }
  };

  const seciliSayisi = secili.size;

  const toggle = (key) => {
    setSecili((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    setSonuc(null);
    setHata(null);
  };

  const tumunu = (evet) => {
    setSecili(evet ? new Set(TUM_ANAHTARLAR) : new Set());
    setSonuc(null);
    setHata(null);
  };

  const presetOperasyon = () => {
    const op = new Set([
      'sube_acilis',
      'sube_operasyon_event',
      'sube_operasyon_uyari',
      'sube_operasyon_ozet',
      'sube_fire_haftalik',
      'operasyon_defter',
      'sube_kasa_gun_acma',
      'kapanis_kayit',
      'sube_depo_stok',
      'stok_yolda',
      'siparis_talep',
      'siparis_ozel_talep',
      'siparis_sevk_eksik',
      'merkez_stok_sevk',
      'sube_merkez_mesaj',
      'sube_merkez_not',
      'sube_skor',
      'motor_analitik_olay',
      'kasa_teslim',
      'operasyon_guvenlik_olay',
      'operasyon_guvenlik_alarm_durum',
      'panel_pin_guvenlik',
    ]);
    setSecili(op);
    setSonuc(null);
    setHata(null);
  };

  const presetFinans = () => {
    const fin = new Set([
      'ciro',
      'ciro_taslak',
      'kasa',
      'kart_hareketleri',
      'banka_yatirimlari',
      'anlik_gider',
      'vadeli_alim',
      'sabit_gider',
      'borc',
      'odeme_plani',
      'onay_kuyrugu',
      'x_rapor_kayit',
    ]);
    setSecili(fin);
    setSonuc(null);
    setHata(null);
  };

  const calistir = async () => {
    setHata(null);
    setSonuc(null);
    if (seciliSayisi === 0) {
      setHata('En az bir veri grubu seçin.');
      return;
    }
    if (onay.trim() !== ONAY_METNI) {
      setHata(`Onay kutusuna tam olarak «${ONAY_METNI}» yazın.`);
      return;
    }
    setBusy(true);
    try {
      const r = await api('/sistem-sifirla', {
        method: 'POST',
        body: {
          onay: ONAY_METNI,
          tablolar: Array.from(secili),
        },
      });
      setSonuc(r);
      setOnay('');
      try {
        publishGlobalDataRefresh('veri-temizleme');
      } catch (_) {}
    } catch (e) {
      setHata(e.message || 'İşlem başarısız');
    } finally {
      setBusy(false);
    }
  };

  const uyariOzeti = useMemo(
    () =>
      'Şubeler, kartlar, sipariş kataloğu, vardiya kuralları ve merkez stok kartı bu işlemle silinmez. Seçilen tablolarda TRUNCATE CASCADE uygulanır; geri alınamaz.',
    [],
  );

  return (
    <div className="card" style={{ maxWidth: 920, margin: '0 auto', padding: '20px 24px' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 20 }}>Veri temizle</h2>
      <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.55, marginBottom: 16 }}>
        Test ortamı veya yeniden başlangıç için veritabanındaki <strong>izin verilen</strong> tabloları boşaltır.
        {uyariOzeti}
      </p>

      <div
        style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: '1px solid rgba(220, 38, 38, 0.45)',
          background: 'rgba(220, 38, 38, 0.08)',
          marginBottom: 16,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: '#fecaca' }}>Üretim verisinde kullanmayın.</strong> Yedek alın. Bu işlem kalıcıdır.
      </div>

      <div
        style={{
          padding: '14px 16px',
          borderRadius: 8,
          border: '1px solid rgba(245, 158, 11, 0.45)',
          background: 'rgba(245, 158, 11, 0.08)',
          marginBottom: 16,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Depo sipariş akışı kalıntıları</div>
        <p style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.55, margin: '0 0 10px' }}>
          Eski kodlardan kalan yarım siparişler, <strong>stok_yolda</strong> ve panelde görünmeyen paketler buradan
          temizlenir. <strong>Şube depo mevcut stok silinmez</strong> — yalnızca sipariş rezerveleri sıfırlanır.
        </p>
        {depoKalinti && (
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, lineHeight: 1.6 }}>
            Yolda (aktif): <strong>{depoKalinti.yolda_aktif ?? 0}</strong>
            {' · '}
            Panel dışı yolda: <strong>{depoKalinti.yolda_panel_disinda ?? 0}</strong>
            {' · '}
            Açık sipariş: <strong>{depoKalinti.acik_siparis ?? 0}</strong>
            {' · '}
            siparis_talep: <strong>{depoKalinti.siparis_talep ?? 0}</strong>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={depoKalintiYukle}>
            Özeti yenile
          </button>
          <button type="button" className="btn btn-warning btn-sm" disabled={depoBusy} onClick={depoAkisiTemizle}>
            {depoBusy ? 'Temizleniyor…' : 'Depo sipariş akışını temizle'}
          </button>
        </div>
        {depoHata && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#fecaca' }}>{depoHata}</div>
        )}
        {depoSonuc && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#86efac' }}>
            {depoSonuc.mesaj || 'Depo akışı temizlendi.'}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => tumunu(true)}>
          Tümünü seç
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => tumunu(false)}>
          Hiçbirini seçme
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={presetOperasyon}>
          Ön ayar: operasyon + sipariş + stok
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={presetSiparisDepo}>
          Ön ayar: yalnız sipariş/sevk tabloları
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={presetFinans}>
          Ön ayar: finans
        </button>
      </div>

      {GRUPLAR.map((gr) => (
        <div key={gr.baslik} style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: 'var(--text2)' }}>{gr.baslik}</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 8,
            }}
          >
            {gr.anahtarlar.map(([key, label]) => (
              <label
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: secili.has(key) ? 'rgba(74, 158, 255, 0.08)' : 'var(--bg2)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <input
                  type="checkbox"
                  checked={secili.has(key)}
                  onChange={() => toggle(key)}
                  style={{ width: 16, height: 16, accentColor: 'var(--blue)' }}
                />
                <span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--text3)' }}>
                    {key}
                  </span>
                  <br />
                  <span style={{ color: 'var(--text)' }}>{label}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>
          Seçili tablo grubu: <strong>{seciliSayisi}</strong>
        </div>
        <label style={{ display: 'block', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>
            Onay — kutuya tam olarak yazın: <strong className="mono">{ONAY_METNI}</strong>
          </span>
          <input
            className="input"
            type="text"
            autoComplete="off"
            placeholder={ONAY_METNI}
            value={onay}
            onChange={(e) => setOnay(e.target.value)}
            style={{ maxWidth: 280 }}
          />
        </label>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={calistir}>
          {busy ? 'Temizleniyor…' : 'Seçilen verileri kalıcı olarak sil'}
        </button>
      </div>

      {hata && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'rgba(220,38,38,0.12)', color: '#fecaca', fontSize: 13 }}>
          {hata}
        </div>
      )}
      {sonuc && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', fontSize: 13 }}>
          <strong style={{ color: '#86efac' }}>{sonuc.mesaj || 'Tamamlandı.'}</strong>
          {Array.isArray(sonuc.silinen) && sonuc.silinen.length > 0 && (
            <pre
              style={{
                margin: '10px 0 0',
                fontSize: 11,
                overflow: 'auto',
                maxHeight: 180,
                color: 'var(--text2)',
              }}
            >
              {sonuc.silinen.join(', ')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
