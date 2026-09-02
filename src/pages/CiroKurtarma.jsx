import { useState } from 'react';
import { api } from '../utils/api';
import { publishGlobalDataRefresh } from '../utils/globalDataRefresh';

/**
 * 🚑 CİRO KURTARMA — `ciro` tablosunu `ciro_taslak`tan geri yazar.
 *
 * NEDEN AYRI EKRAN: uygulama adımı işletme PIN'i ister. PIN bir kimlik
 * bilgisidir ve onu yalnızca SAHİBİ girer — hazırlığı yapan taraf (kuru
 * çalıştırma, liste, kontrol) ile onaylayan taraf ayrıdır.
 *
 * Açılış: adres çubuğuna  #klasik:ciro-kurtarma
 * (Klasik kabuk yalnız bu önekle açılır — "acil kurtarma" kapısı.)
 *
 * ⛔ KASAYA DOKUNMAZ: kasadaki CIRO satırları silinmedi. Sunucu yalnız `ciro`
 *    tablosuna yazar; kasa hareketi üretilirse ciro kasaya İKİNCİ KEZ girer.
 */
const fmt = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ONAY_METNI = 'EVET_KURTAR';

export default function CiroKurtarma() {
  const [plan, setPlan] = useState(null);
  const [sonuc, setSonuc] = useState(null);
  const [pin, setPin] = useState('');
  const [onay, setOnay] = useState('');
  const [busy, setBusy] = useState(false);
  const [hata, setHata] = useState(null);
  const [hepsi, setHepsi] = useState(false);

  const kuruCalistir = async () => {
    setHata(null); setSonuc(null); setPlan(null); setBusy(true);
    try {
      setPlan(await api('/ciro-kurtarma', { method: 'POST', body: {} }));
    } catch (e) {
      setHata(e.message || 'Kuru çalıştırma başarısız');
    } finally { setBusy(false); }
  };

  const uygula = async () => {
    setHata(null);
    if (!plan) { setHata('Önce kuru çalıştırın — liste okunmadan yazma yapılmaz.'); return; }
    if (onay.trim() !== ONAY_METNI) { setHata(`Onay kutusuna tam olarak «${ONAY_METNI}» yazın.`); return; }
    if (!/^\d{4}$/.test(pin.trim())) { setHata('İşletme PIN’i 4 haneli olmalı.'); return; }
    setBusy(true);
    try {
      const r = await api('/ciro-kurtarma', {
        method: 'POST',
        body: { uygula: true, onay: ONAY_METNI, onay_pin: pin.trim() },
      });
      setSonuc(r); setPlan(null); setPin(''); setOnay('');
      try { publishGlobalDataRefresh('ciro-kurtarma'); } catch (_) {}
    } catch (e) {
      setHata(e.message || 'Kurtarma başarısız');
    } finally { setBusy(false); }
  };

  const satirlar = plan?.satirlar || [];
  const gosterilen = hepsi ? satirlar : satirlar.slice(0, 40);

  return (
    <div style={{ padding: 20, maxWidth: 1100 }}>
      <h2 style={{ marginTop: 0 }}>🚑 Ciro Kurtarma</h2>
      <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
        <code>ciro</code> tablosu, korumasız <code>/api/sistem-sifirla</code> ucu yüzünden
        TRUNCATE edildi. Onaylanan her taslak ürettiği ciro satırının kimliğini sakladığı için
        satırlar <b>orijinal ID’leriyle</b> geri yazılabiliyor — kasa bağları kendiliğinden
        yerine oturuyor.
      </p>
      <div style={{ padding: 12, borderRadius: 8, background: 'rgba(234,179,8,0.10)',
                    border: '1px solid rgba(234,179,8,0.35)', fontSize: 13, marginBottom: 18 }}>
        ⛔ <b>Kasaya dokunulmaz.</b> Kasadaki CIRO satırları silinmedi. Kurtarma sırasında
        kasa hareketi de üretilse ciro kasaya <b>ikinci kez</b> girer ve kasa şişerdi.
      </div>

      <button type="button" className="btn btn-secondary" disabled={busy} onClick={kuruCalistir}>
        {busy ? 'Çalışıyor…' : '🧪 Kuru çalıştır (sayar, yazmaz)'}
      </button>

      {plan && (
        <div style={{ marginTop: 18 }}>
          <div style={{ padding: 12, borderRadius: 8, background: 'var(--bg2)',
                        border: '1px solid var(--border)', fontSize: 13 }}>
            <b>{plan.mesaj}</b>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
              <div>Nakit<br /><b>{fmt(plan.toplamlar?.nakit)} ₺</b></div>
              <div>POS<br /><b>{fmt(plan.toplamlar?.pos)} ₺</b></div>
              <div>Online<br /><b>{fmt(plan.toplamlar?.online)} ₺</b></div>
              <div>Brüt<br /><b style={{ color: 'var(--blue)' }}>{fmt(plan.toplamlar?.brut)} ₺</b></div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text3)' }}>
              Zaten duran: {plan.zaten_duran_adet} · Kasadaki CIRO satırı: {plan.kasa_ciro_satiri?.adet}
              {' · '}Kurtarma sonrası yetim kalacak kasa satırı:{' '}
              <b style={{ color: plan.kurtarma_sonrasi_yetim_kasa_satiri > 0 ? '#fca5a5' : 'inherit' }}>
                {plan.kurtarma_sonrasi_yetim_kasa_satiri}
              </b>
            </div>
          </div>

          {(plan.elenen_mukerrer || []).length > 0 && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, fontSize: 12,
                          background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.3)' }}>
              <b>Elenen mükerrer</b> — aynı gün+şube için en yeni onay kazandı:
              {plan.elenen_mukerrer.map((e) => (
                <div key={e.ciro_id} style={{ marginTop: 4 }}>
                  {e.tarih} · {e.sube_adi} · {fmt(e.toplam)} ₺ — {e.neden}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14, maxHeight: 420, overflow: 'auto',
                        border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ position: 'sticky', top: 0, background: 'var(--bg2)' }}>
                  <th style={{ textAlign: 'left', padding: 6 }}>#</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>Tarih</th>
                  <th style={{ textAlign: 'left', padding: 6 }}>Şube</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Nakit</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>POS</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Online</th>
                  <th style={{ textAlign: 'right', padding: 6 }}>Toplam</th>
                </tr>
              </thead>
              <tbody>
                {gosterilen.map((s, i) => (
                  <tr key={s.ciro_id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: 6, color: 'var(--text3)' }}>{i + 1}</td>
                    <td style={{ padding: 6 }}>{s.tarih}</td>
                    <td style={{ padding: 6 }}>{s.sube_adi}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{fmt(s.nakit)}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{fmt(s.pos)}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{fmt(s.online)}</td>
                    <td style={{ padding: 6, textAlign: 'right', fontWeight: 700 }}>{fmt(s.toplam)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {satirlar.length > 40 && (
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}
                    onClick={() => setHepsi((v) => !v)}>
              {hepsi ? 'İlk 40 satırı göster' : `Tümünü göster (${satirlar.length} satır)`}
            </button>
          )}

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>
                Onay — kutuya tam olarak yazın: <strong className="mono">{ONAY_METNI}</strong>
              </span>
              <input className="input" type="text" autoComplete="off" placeholder={ONAY_METNI}
                     value={onay} onChange={(e) => setOnay(e.target.value)} style={{ maxWidth: 260 }} />
            </label>
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 6 }}>
                İşletme onayı — <strong>Merve Karabacak</strong> PIN (4 hane)
              </span>
              <input className="input mono" type="password" inputMode="numeric" maxLength={4}
                     autoComplete="off" placeholder="••••" value={pin}
                     onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                     style={{ maxWidth: 120, letterSpacing: 4 }} />
            </label>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={uygula}>
              {busy ? 'Yazılıyor…' : `${plan.yazilacak_adet} ciro satırını geri yaz`}
            </button>
          </div>
        </div>
      )}

      {hata && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8,
                      background: 'rgba(220,38,38,0.12)', color: '#fecaca', fontSize: 13 }}>{hata}</div>
      )}
      {sonuc && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 8,
                      background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', fontSize: 13 }}>
          <strong style={{ color: '#86efac' }}>{sonuc.mesaj}</strong>
          <div style={{ marginTop: 6, color: 'var(--text2)' }}>
            Yazılan: <b>{sonuc.yazilan_adet}</b> / planlanan {sonuc.yazilacak_adet}
            {sonuc.onaylayan ? ` · onaylayan: ${sonuc.onaylayan}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
