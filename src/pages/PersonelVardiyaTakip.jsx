import { useState, useEffect } from 'react';
import { api } from '../utils/api';

const AY_ADLARI = ['', 'Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                   'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function fmt(n, dk = false) {
  if (n == null || isNaN(n)) return '—';
  if (dk) {
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  }
  return Number(n).toFixed(1).replace('.', ',');
}

function Badge({ renk, label }) {
  const renkler = {
    sari: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)', text: '#f59e0b' },
    kirmizi: { bg: 'rgba(224,92,92,0.1)', border: 'rgba(224,92,92,0.3)', text: '#e05c5c' },
    yesil: { bg: 'rgba(76,175,132,0.1)', border: 'rgba(76,175,132,0.3)', text: '#4caf84' },
    mavi: { bg: 'rgba(74,158,255,0.1)', border: 'rgba(74,158,255,0.3)', text: '#4a9eff' },
  };
  const r = renkler[renk] || renkler.mavi;
  return (
    <span style={{
      padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700,
      background: r.bg, border: `1px solid ${r.border}`, color: r.text,
    }}>{label}</span>
  );
}

function EksikGunModal({ p, yil, ay, onKapat, onTamam }) {
  const [gun, setGun] = useState(0.5);
  const [not, setNot] = useState('');
  const [yukleniyor, setYukleniyor] = useState(false);
  const [sonuc, setSonuc] = useState(null);

  const kaydet = async () => {
    setYukleniyor(true);
    try {
      const res = await api('/gorev/gecikme-eksik-gun', {
        method: 'POST',
        body: { personel_id: p.personel_id, yil, ay, eksik_gun: gun, not_aciklama: not || null },
      });
      setSonuc(res);
      setTimeout(() => { onTamam(); onKapat(); }, 1500);
    } catch (e) {
      alert(e.message || 'Hata');
    } finally {
      setYukleniyor(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14,
        padding: 24, maxWidth: 380, width: '90%',
      }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Eksik Güne Çevir</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
          {p.ad_soyad} · {['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'][ay]} {yil}
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>Kaç gün eksik sayılacak?</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[0.5, 1.0].map(g => (
              <button key={g} onClick={() => setGun(g)} style={{
                flex: 1, padding: '10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: gun === g ? 'var(--accent)' : 'var(--bg3)',
                color: gun === g ? '#fff' : 'var(--text2)', fontWeight: 700, fontSize: 14,
              }}>
                {g === 0.5 ? '½ Gün' : '1 Tam Gün'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4 }}>Kesinti: <strong style={{ color: '#e05c5c' }}>-{(28000/30*gun).toFixed(0)} ₺</strong> (maaş/30×{gun})</div>
          <textarea value={not} onChange={e => setNot(e.target.value)}
            placeholder="Not (opsiyonel) — örn: 3 kez geç giriş birikimi"
            rows={2} style={{
              width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 12,
              background: 'var(--bg3)', border: '1px solid var(--border)',
              color: 'var(--text1)', resize: 'none', boxSizing: 'border-box',
            }} />
        </div>
        {sonuc && (
          <div style={{ fontSize: 12, color: '#4caf84', marginBottom: 8, fontWeight: 700 }}>
            ✅ İşlendi — Yeni net: {new Intl.NumberFormat('tr-TR').format(sonuc.hesaplanan_net)} ₺
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onKapat} style={{
            flex: 1, padding: '10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'none', color: 'var(--text3)', cursor: 'pointer',
          }}>İptal</button>
          <button onClick={kaydet} disabled={yukleniyor} style={{
            flex: 2, padding: '10px', borderRadius: 8, border: 'none',
            background: '#e05c5c', color: '#fff', fontWeight: 700, cursor: 'pointer',
          }}>
            {yukleniyor ? 'İşleniyor…' : `Eksik Güne Çevir (-${(28000/30*gun).toFixed(0)} ₺)`}
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonelKart({ p, onDetay, yil, ay, onYenile }) {
  const ayrildi = !p.aktif;
  const [eksikModal, setEksikModal] = useState(false);
  return (
    <div style={{
      marginBottom: 10, borderRadius: 12, overflow: 'hidden',
      border: `1px solid ${ayrildi ? 'rgba(107,111,122,0.3)' : 'var(--border)'}`,
      background: ayrildi ? 'rgba(107,111,122,0.04)' : 'var(--bg2)',
      opacity: ayrildi ? 0.8 : 1,
      transition: 'border-color 0.15s, transform 0.1s',
      cursor: 'pointer',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = ayrildi ? 'rgba(107,111,122,0.3)' : 'var(--border)'}
    >
      {eksikModal && (
        <EksikGunModal p={p} yil={yil} ay={ay}
          onKapat={() => setEksikModal(false)}
          onTamam={onYenile} />
      )}
      {/* Özet satır */}
      <div onClick={() => onDetay(p)} style={{
        padding: '14px 16px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: ayrildi ? 'var(--text3)' : 'var(--text1)', display: 'flex', alignItems: 'center', gap: 8 }}>
            {p.ad_soyad}
            {ayrildi && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 8,
                background: 'rgba(107,111,122,0.15)', color: 'var(--text3)',
                border: '1px solid rgba(107,111,122,0.3)',
              }}>
                Ayrıldı{p.cikis_tarihi ? ` · ${new Date(p.cikis_tarihi).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>
              {p.calisma_turu === 'surekli' ? 'Sürekli' : 'Part-time'}
            </span>
          </div>
        </div>

        {/* Özet metrikler */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: 'var(--text1)' }}>{fmt(p.toplam_planlanan_saat)}s</div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Plan</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: p.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : 'var(--text3)' }}>
              {fmt(p.toplam_fazla_mesai_saat)}s
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Fazla</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: p.toplam_gecikme_dk > 0 ? '#e05c5c' : 'var(--text3)' }}>
              {fmt(p.toplam_gecikme_dk, true)}
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Gecikme</div>
            {p.toplam_gecikme_dk > 30 && (
              <button onClick={e => { e.stopPropagation(); setEksikModal(true); }}
                style={{ fontSize: 9, padding: '2px 6px', borderRadius: 6, border: 'none',
                  background: 'rgba(224,92,92,0.15)', color: '#e05c5c', cursor: 'pointer',
                  marginTop: 2, fontWeight: 700 }}>
                Eksik Güne Çevir
              </button>
            )}
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: '#4caf84' }}>{p.yemek_ucret_gun} gün</div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Yemek</div>
            {p.yemek_ucret_tutari > 0 && (
              <div style={{ fontSize: 10, color: '#4caf84', fontWeight: 600 }}>
                {new Intl.NumberFormat('tr-TR').format(Math.round(p.yemek_ucret_tutari))}₺
              </div>
            )}
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 800, color: '#4caf84', fontSize: 15 }}>
              {p['net_hakediş'] > 0 ? new Intl.NumberFormat('tr-TR').format(Math.round(p['net_hakediş']))+'₺' : '—'}
            </div>
            <div style={{ color: 'var(--text3)', fontSize: 10 }}>Net Hakediş</div>
          </div>
          {p.part_tam_gun > 0 && <Badge renk="sari" label={`${p.part_tam_gun}g Part-Tam`} />}
          {p.haftalik_izin_kullanilmadi > 0 && (
            <Badge renk="kirmizi" label={`${p.haftalik_izin_kullanilmadi} hafta izinsiz`} />
          )}
        </div>

        <span style={{ color: 'var(--accent)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>Detay →</span>
      </div>
    </div>
  );
}

function PersonelDetayModal({ p, yil, ay, onKapat }) {
  const fmt2 = n => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(n) + ' ₺';
  const gunler = (p.gunler || []).filter(g => g.planlanan_saat > 0);

  // Son 7 gün (en yeni en üstte)
  const son7 = [...gunler].sort((a, b) => b.tarih.localeCompare(a.tarih)).slice(0, 7);
  const gecGelinenler = son7.filter(g => g.gecikme_dk > 0);
  const yemekKaybiGunler = son7.filter(g => g.yemek_sure_dk != null && !g.yemek_ucret_hakki);

  const d = p.ucret_detay;
  const satir = (label, val, renk, bold) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0',
      borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text3)', fontSize: 12 }}>{label}</span>
      <span style={{ fontWeight: bold ? 800 : 600, fontSize: 12, color: renk || 'var(--text1)' }}>{val}</span>
    </div>
  );

  return (
    <div onClick={onKapat} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16,
        maxWidth: 640, width: '100%', maxHeight: '88vh', overflowY: 'auto',
      }}>
        {/* Başlık */}
        <div style={{
          padding: '18px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, background: 'var(--bg2)', zIndex: 1,
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text1)' }}>{p.ad_soyad}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
              {AY_ADLARI[ay]} {yil} · {p.calisma_turu === 'surekli' ? 'Sürekli' : 'Part-time'}
            </div>
          </div>
          <button onClick={onKapat} style={{
            border: 'none', background: 'var(--bg3)', color: 'var(--text3)',
            width: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 16,
          }}>✕</button>
        </div>

        <div style={{ padding: '16px 20px' }}>
          {/* Özet metrikler */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, marginBottom: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, color: 'var(--text1)' }}>{fmt(p.toplam_planlanan_saat)}s</div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>Plan</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, color: p.toplam_fazla_mesai_saat > 0 ? '#f59e0b' : 'var(--text3)' }}>
                {fmt(p.toplam_fazla_mesai_saat)}s
              </div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>Fazla</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, color: p.toplam_gecikme_dk > 0 ? '#e05c5c' : 'var(--text3)' }}>
                {fmt(p.toplam_gecikme_dk, true)}
              </div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>Gecikme</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 700, color: '#4caf84' }}>{p.yemek_ucret_gun} gün</div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>Yemek Hakkı</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 800, color: '#4caf84', fontSize: 15 }}>
                {p['net_hakediş'] > 0 ? new Intl.NumberFormat('tr-TR').format(Math.round(p['net_hakediş']))+'₺' : '—'}
              </div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>
                {d?.ay_tamam ? 'Net Hakediş' : `Hakediş (${d?.gecen_gun}/30)`}
              </div>
            </div>
          </div>

          {/* Son 7 gün — gecikme ve yemek hakkı kayıpları */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, letterSpacing: 0.5 }}>
              SON 7 GÜN
            </div>
            {gecGelinenler.length === 0 && yemekKaybiGunler.length === 0 ? (
              <div style={{
                padding: '10px 12px', borderRadius: 10, fontSize: 12, color: '#4caf84',
                background: 'rgba(76,175,132,0.06)', border: '1px solid rgba(76,175,132,0.2)',
              }}>
                ✅ Son 7 günde gecikme yok, yemek molası hakkı kaybı yok.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {gecGelinenler.map(g => (
                  <div key={'gec-'+g.tarih} style={{
                    padding: '8px 12px', borderRadius: 8, fontSize: 12, color: '#e05c5c',
                    background: 'rgba(224,92,92,0.06)', border: '1px solid rgba(224,92,92,0.2)',
                  }}>
                    ⏰ {new Date(g.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'long' })}
                    {' — '}<strong>{fmt(g.gecikme_dk, true)}</strong> geç giriş yapıldı.
                  </div>
                ))}
                {yemekKaybiGunler.map(g => (
                  <div key={'yemek-'+g.tarih} style={{
                    padding: '8px 12px', borderRadius: 8, fontSize: 12, color: '#f59e0b',
                    background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)',
                  }}>
                    🍽️ {new Date(g.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'long' })}
                    {' — yemek molası '}<strong>{Math.round(g.yemek_sure_dk)} dk</strong> sürdü
                    {g.yemek_limit_dk ? <> (limit <strong>{g.yemek_limit_dk} dk</strong>)</> : null}
                    {g.yemek_limit_dk
                      ? <>, <strong>{Math.round(g.yemek_sure_dk - g.yemek_limit_dk)} dk</strong> fazla kaldığı için yemek ücreti hakkı kazanılmadı.</>
                      : <>, limit aşıldığı için yemek ücreti hakkı kazanılmadı.</>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tüm ay tablosu */}
          <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)' }}>
                  {['Tarih','Plan','Gecikme','Fazla','Yemek','Uyarı'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gunler.map((g, i) => (
                  <tr key={g.tarih} style={{ borderTop: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg3)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>
                      {new Date(g.tarih).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', weekday: 'short' })}
                      {g.baslangic_gunu && <span style={{ marginLeft: 6, fontSize: 10, color: '#4a9eff', fontWeight: 700 }}>Sistem başlangıcı</span>}
                      {!g.baslangic_gunu && !g.giris_var && <span style={{ marginLeft: 6, color: '#e05c5c', fontSize: 10 }}>giriş yok</span>}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text1)', fontWeight: 600 }}>{fmt(g.planlanan_saat)}s</td>
                    <td style={{ padding: '8px 12px' }}>
                      {g.gecikme_dk > 0
                        ? <span style={{ color: '#e05c5c', fontWeight: 700 }}>{fmt(g.gecikme_dk, true)}</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {g.fazla_mesai_saat > 0
                        ? <span style={{ color: '#f59e0b', fontWeight: 700 }}>+{fmt(g.fazla_mesai_saat)}s</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {g.yemek_sure_dk != null
                        ? <span style={{ color: g.yemek_ucret_hakki ? '#4caf84' : '#e05c5c' }}
                            title={g.yemek_limit_dk ? `Limit: ${g.yemek_limit_dk} dk` : ''}>
                            {Math.round(g.yemek_sure_dk)}dk {g.yemek_ucret_hakki ? '✅' : '❌'}
                          </span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {g.part_tam_uyari && <Badge renk="sari" label="Part-Tam" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Haftalık izin özeti */}
          {(p.haftalik_izin_detay || []).length > 0 && (
            <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--border)', marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, letterSpacing: 0.5 }}>
                HAFTALIK İZİN TAKİBİ
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {p.haftalik_izin_detay.map((h, i) => (
                  <div key={i} style={{
                    padding: '6px 10px', borderRadius: 8, fontSize: 11,
                    background: h.izin_var
                      ? 'rgba(76,175,132,0.08)' : 'rgba(224,92,92,0.08)',
                    border: `1px solid ${h.izin_var ? 'rgba(76,175,132,0.3)' : 'rgba(224,92,92,0.3)'}`,
                  }}>
                    <span style={{ color: 'var(--text3)' }}>
                      {new Date(h.hafta).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} haftası
                    </span>
                    <span style={{ marginLeft: 6, fontWeight: 700, color: h.izin_var ? '#4caf84' : '#e05c5c' }}>
                      {h.izin_var ? '✓ İzin var' : `⚠️ ${h.calisilan_gun}/${h.toplam_gun} gün — İZİN ALACAĞI`}
                    </span>
                  </div>
                ))}
              </div>
              {p.haftalik_izin_kullanilmadi > 0 && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', borderRadius: 8,
                  background: 'rgba(224,92,92,0.08)', border: '1px solid rgba(224,92,92,0.3)',
                  fontSize: 12, color: '#e05c5c', fontWeight: 600,
                }}>
                  🔴 {p.haftalik_izin_kullanilmadi} haftalık izin alacağı birikti —
                  bu personele <strong>{p.haftalik_izin_kullanilmadi} günlük ücretli izin</strong> verilmeli.
                </div>
              )}
            </div>
          )}

          {/* Ücret hesabı döküm */}
          {d && (
            <div style={{ padding: '12px 16px', borderRadius: 10,
              background: 'var(--bg3)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)',
                marginBottom: 8, letterSpacing: 0.5 }}>
                💰 ÜCRET HESABI
              </div>
              {d.taban_maas != null && (
                d.ay_tamam
                  ? satir('Taban Maaş (tam ay)', fmt2(d.taban_maas), null)
                  : satir(`Taban Maaş (${d.gecen_gun}/30 gün)`, fmt2(d.kazanilan_taban), null, true)
              )}
              {d.saatlik_ucret > 0 && satir('Saatlik Ücret (maaş÷285)', fmt2(d.saatlik_ucret), 'var(--text3)')}
              {d.calisma_saati != null && satir(`Çalışma (${d.calisma_saati}s × ${fmt2(d.saatlik_ucret)}/s)`, fmt2(d.normal_ucret), null)}
              {d.fazla_mesai_saat > 0 && satir(`Fazla Mesai (${d.fazla_mesai_saat}s)`, '+' + fmt2(d.fazla_mesai_ucret), '#f59e0b')}
              {(d.yemek_ucret_gun > 0 || d.yemek_ucret > 0) && satir(
                `🍽️ Yemek (${d.yemek_ucret_gun ?? p.yemek_ucret_gun} gün × ${fmt2(d.yemek_ucret_birim ?? 0)})`,
                '+' + fmt2(d.yemek_ucret), '#4caf84'
              )}
              {d.yol_ucret > 0 && satir(
                !d.ay_tamam ? `Yol Ücreti (${d.gecen_gun}/30 gün)` : 'Yol Ücreti (tam ay)',
                '+' + fmt2(d.yol_ucret), null
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between',
                padding: '8px 0 0', marginTop: 4 }}>
                <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text1)' }}>
                  {d.ay_tamam ? 'NET HAKEDİŞ' : `ŞU ANA KADAR HAKEDİŞ (${d.gecen_gun}/30)`}
                </span>
                <span style={{ fontWeight: 800, fontSize: 15, color: '#4caf84' }}>{fmt2(d['net_hakediş'])}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PersonelVardiyaTakip() {
  const bugun = new Date();
  const [yil, setYil] = useState(bugun.getFullYear());
  const [ay, setAy] = useState(bugun.getMonth() + 1);
  const [veri, setVeri] = useState(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [detayPersonel, setDetayPersonel] = useState(null);
  const [izinAlacagi, setIzinAlacagi] = useState(null);
  const [filtre, setFiltre] = useState('aktif'); // 'aktif' | 'ayrildi' | 'hepsi'
  const [vardiyaDisiGirisler, setVardiyaDisiGirisler] = useState([]);

  const yukle = () => {
    setYukleniyor(true);
    const bugunTarih = new Date().toISOString().slice(0, 10);
    Promise.all([
      api(`/gorev/vardiya-takip?yil=${yil}&ay=${ay}`),
      api(`/gorev/izin-alacagi`).catch(() => null),
      api(`/gorev/yoklama?tarih=${bugunTarih}&sadece_vardiya_disi=true`).catch(() => []),
    ]).then(([v, iz, vd]) => {
      setVeri(v);
      setIzinAlacagi(iz);
      setVardiyaDisiGirisler(vd || []);
      // Açık detay modalı varsa güncel veriyle yenile (yoksa kapat)
      setDetayPersonel(prev => {
        if (!prev) return null;
        return (v?.personeller || []).find(p => p.personel_id === prev.personel_id) || null;
      });
    }).catch(console.error).finally(() => setYukleniyor(false));
  };

  useEffect(() => { yukle(); }, [yil, ay]);

  const personeller = veri?.personeller || [];
  const filtrelenmis = personeller.filter(p =>
    filtre === 'hepsi' ? true :
    filtre === 'ayrildi' ? !p.aktif :
    p.aktif !== false
  );
  const uyarilar = personeller.filter(p => p.aktif !== false && (p.part_tam_gun > 0 || p.toplam_gecikme_dk > 60 || p.haftalik_izin_kullanilmadi > 0));

  return (
    <div className="page">
      <div className="page-header">
        <h2>👥 Personel Vardiya Takip</h2>
        <p>Aylık mesai, gecikme, yemek molası ve part-tam uyarıları</p>
      </div>

      {/* Ay seçici */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <select value={yil} onChange={e => setYil(Number(e.target.value))}
          style={{ padding: '7px 10px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text1)', fontSize: 13 }}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={ay} onChange={e => setAy(Number(e.target.value))}
          style={{ padding: '7px 10px', borderRadius: 7, background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text1)', fontSize: 13 }}>
          {AY_ADLARI.slice(1).map((ad, i) => <option key={i+1} value={i+1}>{ad}</option>)}
        </select>
        {yukleniyor && <div className="spinner" style={{ width: 16, height: 16 }} />}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {[['aktif','Aktif'], ['ayrildi','Ayrıldı'], ['hepsi','Tümü']].map(([k, l]) => (
            <button key={k} onClick={() => setFiltre(k)} style={{
              padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              background: filtre === k ? 'var(--accent)' : 'var(--bg2)',
              color: filtre === k ? '#fff' : 'var(--text3)',
              border: `1px solid ${filtre === k ? 'var(--accent)' : 'var(--border)'}`,
            }}>{l}</button>
          ))}
        </div>
      </div>

      {/* Uyarı özeti */}
      {uyarilar.length > 0 && (
        <div style={{
          marginBottom: 16, padding: '12px 16px', borderRadius: 10,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
          fontSize: 12, color: 'var(--text2)',
        }}>
          ⚠️ <strong>{uyarilar.length} personel</strong> dikkat gerektiriyor:
          {uyarilar.map(p => (
            <span key={p.personel_id} style={{ marginLeft: 8 }}>
              <strong>{p.ad_soyad}</strong>
              {p.part_tam_gun > 0 && ` · ${p.part_tam_gun}g part-tam`}
              {p.toplam_gecikme_dk > 60 && ` · ${fmt(p.toplam_gecikme_dk, true)} gecikme`}
              {p.haftalik_izin_kullanilmadi > 0 && ` · ${p.haftalik_izin_kullanilmadi} hafta izinsiz`}
            </span>
          ))}
        </div>
      )}

      {/* Bugün Vardiya Dışı Girişler */}
      {vardiyaDisiGirisler.length > 0 && (
        <div style={{
          marginBottom: 16, borderRadius: 12, overflow: 'hidden',
          border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.05)',
        }}>
          <div style={{
            padding: '10px 16px', borderBottom: '1px solid rgba(245,158,11,0.2)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 15 }}>🔀</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#f59e0b' }}>
                Bugün Vardiya Dışı Girişler — {vardiyaDisiGirisler.length} kayıt
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                Kendi şubesi dışında çalışan personeller
              </div>
            </div>
          </div>
          <div style={{ padding: '4px 0' }}>
            {vardiyaDisiGirisler.map((g, i) => (
              <div key={i} style={{
                padding: '9px 16px', display: 'flex', alignItems: 'center', gap: 10,
                borderBottom: i < vardiyaDisiGirisler.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text1)', minWidth: 140 }}>
                  {g.ad_soyad}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>asıl: {g.asil_sube_adi || '—'}</span>
                <span style={{ color: 'var(--text3)' }}>→</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b' }}>{g.sube_adi}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
                  {g.vardiya_tip === 'sabahci' ? '🌅 Sabah' : g.vardiya_tip === 'ara_vardiya' ? '☀️ Ara' : '🌙 Kapanış'}
                  {' · '}{new Date(g.giris_ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Genel özet */}
      {personeller.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Toplam Personel', val: personeller.length, renk: 'var(--text1)' },
            { label: 'Toplam Fazla Mesai', val: fmt(personeller.reduce((s,p)=>s+p.toplam_fazla_mesai_saat,0))+'s', renk: '#f59e0b' },
            { label: 'Part-Tam Uyarı', val: personeller.filter(p=>p.part_tam_gun>0).length + ' kişi', renk: '#f59e0b' },
            { label: 'Yemek Ücreti Toplam', val: new Intl.NumberFormat('tr-TR').format(personeller.reduce((s,p)=>s+p.yemek_ucret_tutari,0))+'₺', renk: '#4caf84' },
        { label: 'Toplam Net Hakediş', val: new Intl.NumberFormat('tr-TR').format(Math.round(personeller.reduce((s,p)=>s+(p['net_hakediş']||0),0)))+'₺', renk: '#4caf84' },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: k.renk }}>{k.val}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Birikimli Haftalık İzin Alacağı */}
      {izinAlacagi && (() => {
        const birikmisler = (izinAlacagi.personeller || []).filter(p => p.net_alacak_gun > 0);
        if (!birikmisler.length) return null;
        return (
          <div style={{
            marginBottom: 16, borderRadius: 12, overflow: 'hidden',
            border: '1px solid rgba(224,92,92,0.3)', background: 'rgba(224,92,92,0.04)',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(224,92,92,0.2)',
              display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🔴</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#e05c5c' }}>
                  Birikmiş Haftalık İzin Alacağı
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {izinAlacagi.baslangic} tarihinden bugüne · Verilen izinler düşülmüş
                </div>
              </div>
            </div>
            <div style={{ padding: '8px 0' }}>
              {birikmisler.map(p => (
                <div key={p.personel_id} style={{
                  padding: '10px 16px', borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text1)' }}>{p.ad_soyad}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                      {p.borclu_hafta_sayisi} hafta izinsiz çalışma
                      {p.verilen_izin_gun > 0 && ` · ${p.verilen_izin_gun} gün izin verildi`}
                    </div>
                  </div>
                  <div style={{
                    padding: '5px 12px', borderRadius: 20,
                    background: 'rgba(224,92,92,0.12)', border: '1px solid rgba(224,92,92,0.3)',
                    fontWeight: 800, fontSize: 14, color: '#e05c5c',
                  }}>
                    {p.net_alacak_gun} gün alacak
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Personel listesi */}
      {yukleniyor ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Yükleniyor…
        </div>
      ) : personeller.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text3)' }}>
          Bu ay için veri bulunamadı.
        </div>
      ) : filtrelenmis.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text3)' }}>
          {filtre === 'ayrildi' ? 'Bu dönemde ayrılan personel bulunamadı.' : 'Veri bulunamadı.'}
        </div>
      ) : (
        filtrelenmis.map(p => (
          <PersonelKart
            key={p.personel_id}
            p={p}
            yil={yil}
            ay={ay}
            onYenile={yukle}
            onDetay={setDetayPersonel}
          />
        ))
      )}

      {detayPersonel && (
        <PersonelDetayModal
          p={detayPersonel}
          yil={yil}
          ay={ay}
          onKapat={() => setDetayPersonel(null)}
        />
      )}
    </div>
  );
}
