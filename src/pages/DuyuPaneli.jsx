import { useState, useEffect, useCallback } from 'react';
import { api, fmt } from '../utils/api';

/**
 * 🧠 DUYU PANELİ — Duyu Ağı FAZ 1 görünümleri tek ekranda (2026-07-06).
 * İLKE: consistency engine — yan yana koyar, HÜKÜM VERMEZ. Alarm yok, isim yok.
 * Beş pencere: Tüketim Dörtgeni ⭐ · Vergi→Nakit Takvimi · Kapanış-Fark Profili ·
 * Ödeme Mutabakatı · Omurga/Açık Teslimat özeti. Her köşe kesit-tazelik rozetini taşır.
 */

const K = {
  kart: { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 16 },
  baslik: { fontSize: 15, fontWeight: 800, color: 'var(--text1)', marginBottom: 4 },
  alt: { fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.5, marginBottom: 10 },
  rozet: { display: 'inline-block', fontSize: 10.5, color: 'var(--text3)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '2px 8px', marginRight: 6, marginBottom: 4 },
  th: { textAlign: 'right', padding: '6px 10px', fontSize: 11, color: 'var(--text3)', fontWeight: 700, whiteSpace: 'nowrap' },
  thL: { textAlign: 'left', padding: '6px 10px', fontSize: 11, color: 'var(--text3)', fontWeight: 700 },
  td: { textAlign: 'right', padding: '6px 10px', fontSize: 12.5, color: 'var(--text2)', fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' },
  tdL: { textAlign: 'left', padding: '6px 10px', fontSize: 12.5, color: 'var(--text1)' },
};

const num = (v) => (v === null || v === undefined ? '—' : fmt(v));

function Rozetler({ obj }) {
  if (!obj) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      {Object.entries(obj).map(([k, v]) => (
        <span key={k} style={K.rozet}>
          <b>{k}</b>: {typeof v === 'object' ? (v.hata ? `⚠️ ${v.hata}` : `${v.kaynak || ''} · ${v.kesit || ''}${v.canli === true ? ' · canlı' : v.canli === false ? ' · cache' : ''}`) : String(v)}
        </span>
      ))}
    </div>
  );
}

export default function DuyuPaneli() {
  const [subeler, setSubeler] = useState([]);
  const [subeId, setSubeId] = useState('');
  const [gun, setGun] = useState(7);
  const [dortgen, setDortgen] = useState(null);
  const [vergi, setVergi] = useState(null);
  const [fark, setFark] = useState(null);
  const [mutabakat, setMutabakat] = useState(null);
  const [omurga, setOmurga] = useState(null);
  const [acikTeslimat, setAcikTeslimat] = useState(null);
  const [hata, setHata] = useState('');

  useEffect(() => {
    api('/subeler').then((r) => {
      const list = Array.isArray(r) ? r : (r?.subeler || []);
      setSubeler(list);
      if (list.length && !subeId) setSubeId(list[0].id);
    }).catch(() => {});
    api('/duyu/vergi-takvim').then(setVergi).catch(() => {});
    api('/duyu/kapanis-fark-profil?gun=30').then(setFark).catch(() => {});
    api('/duyu/odeme-mutabakat?gun=60').then(setMutabakat).catch(() => {});
    api('/duyu/ozet').then(setOmurga).catch(() => {});
    api('/belge-talep/acik-teslimat').then(setAcikTeslimat).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dortgenYukle = useCallback(() => {
    if (!subeId) return;
    setHata('');
    setDortgen(null);
    api(`/duyu/dortgen?sube_id=${encodeURIComponent(subeId)}&gun=${gun}`)
      .then(setDortgen)
      .catch((e) => setHata(e.message || 'Dörtgen yüklenemedi'));
  }, [subeId, gun]);
  useEffect(() => { dortgenYukle(); }, [dortgenYukle]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>🧠 Duyu Paneli</h2>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>
          Sistem kendi kendini izler — yan yana koyar, hüküm vermez. Değerlendirme senin.
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 16 }}>
        {omurga && <>Omurga: <b>{omurga.toplam_olay}</b> olay · <b>{omurga.etiket_sayisi}</b> öğretmen etiketi</>}
        {acikTeslimat && <> · Açık teslimat: <b>{acikTeslimat.acik_toplam}</b> {acikTeslimat.ic_sevkiyat_yolda_adet > 0 && <> · yolda bekleyen sevk: <b style={{ color: 'var(--red)' }}>{acikTeslimat.ic_sevkiyat_yolda_adet}</b></>}</>}
      </div>

      {/* ── ⭐ TÜKETİM MUHASEBESİ DÖRTGENİ ── */}
      <div style={K.kart}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={K.baslik}>⭐ Tüketim Muhasebesi Dörtgeni</div>
            <div style={K.alt}>Giren ↔ Kullanılan ↔ Satılan (Evo) ↔ Sayım farkı — dört sayı uyumluysa her şey yolunda; uyumsuzsa "buraya bak". "—" = veri yok (sıfır değil).</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={subeId} onChange={(e) => setSubeId(e.target.value)}
              style={{ background: 'var(--bg)', color: 'var(--text1)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}>
              {subeler.map((s) => <option key={s.id} value={s.id}>{s.ad}</option>)}
            </select>
            <select value={gun} onChange={(e) => setGun(Number(e.target.value))}
              style={{ background: 'var(--bg)', color: 'var(--text1)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}>
              {[7, 14].map((g) => <option key={g} value={g}>{g} gün</option>)}
            </select>
          </div>
        </div>
        {hata && <div style={{ color: 'var(--red)', fontSize: 13 }}>{hata}</div>}
        {!dortgen && !hata && <div style={{ color: 'var(--text3)', padding: 12 }}>Yükleniyor…</div>}
        {dortgen && (
          <>
            <Rozetler obj={dortgen.rozetler} />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={K.thL}>Kalem</th>
                  <th style={K.th}>📥 Giren</th>
                  <th style={K.th}>📦 Kullanılan</th>
                  <th style={K.th}>💰 Satılan</th>
                  <th style={K.th}>📋 Sayım Δ</th>
                </tr></thead>
                <tbody>
                  {(dortgen.kalemler || []).slice(0, 30).map((s) => (
                    <tr key={s.kalem_kodu} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={K.tdL}>{s.kalem_adi}</td>
                      <td style={K.td}>{num(s.giren)}</td>
                      <td style={K.td}>{num(s.kullanim)}</td>
                      <td style={K.td}>{num(s.satis)}</td>
                      <td style={{ ...K.td, color: (s.sayim_delta ?? 0) < 0 ? 'var(--red)' : 'var(--text2)' }}>{num(s.sayim_delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6 }}>{dortgen.kalem_sayisi} kalemden ilk 30 gösteriliyor (dolu köşesi çok olan üstte).</div>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
        {/* ── 💰 VERGİ → NAKİT TAKVİMİ ── */}
        <div style={K.kart}>
          <div style={K.baslik}>💰 Vergi → Nakit Takvimi</div>
          <div style={K.alt}>Devlete çıkacak tahmini nakit. Beyanname DEĞİLDİR — muhasebeci takvimi esastır.</div>
          {(vergi?.takvim || []).map((t, i) => (
            <div key={i} style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <b style={{ color: 'var(--text1)' }}>{t.tur}</b>
                <b style={{ color: 'var(--yellow, #f59e0b)' }}>{t.hata ? '⚠️' : fmt(t.odenecek_kdv_tl ?? t.odenecek_tl)}₺</b>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {t.donem} {t.son_odeme && <>· son ödeme <b>{t.son_odeme}</b></>}
              </div>
              {t.rozet && <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2 }}>{t.rozet}</div>}
            </div>
          ))}
        </div>

        {/* ── 📊 KAPANIŞ-FARK ŞUBE PROFİLİ ── */}
        <div style={K.kart}>
          <div style={K.baslik}>📊 Kapanış-Fark Şube Profili <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(30 gün, isimsiz)</span></div>
          <div style={K.alt}>Şube bazında kasa farkı dağılımı — örüntüyü sen okursun, sistem suçlamaz.</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={K.thL}>Şube · Tip</th><th style={K.th}>Gün</th><th style={K.th}>Ort |fark|</th><th style={K.th}>Max</th><th style={K.th}>Eksik/Fazla</th><th style={K.th}>Net</th>
              </tr></thead>
              <tbody>
                {(fark?.profiller || []).map((p, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={K.tdL}>{p.sube_ad} <span style={{ fontSize: 10, color: 'var(--text3)' }}>{String(p.tip || '').startsWith('ACILIS') ? 'açılış' : 'kapanış'}</span></td>
                    <td style={K.td}>{p.gun_sayisi}</td>
                    <td style={K.td}>{fmt(p.ort_mutlak_fark)}</td>
                    <td style={K.td}>{fmt(p.max_mutlak_fark)}</td>
                    <td style={K.td}>{p.eksik_gun}/{p.fazla_gun}</td>
                    <td style={{ ...K.td, color: (p.net_fark_toplam ?? 0) < -100 ? 'var(--red)' : 'var(--text2)' }}>{fmt(p.net_fark_toplam)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 🤝 ÖDEME MUTABAKATI ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🤝 Tedarikçi Ödeme Mutabakatı <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(60 gün, aday)</span></div>
          <div style={K.alt}>Cari bakiye düşüşü ↔ bizim ödeme kaydımız. ADAY eşleştirme — hüküm yok; bakiye düşüşü ödeme kanıtı değildir.</div>
          {mutabakat && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                🟢 eşleşen: <b>{(mutabakat.eslesen || []).length}</b> ·
                🟡 düşüş var, kayıt yok: <b>{(mutabakat.dusus_var_odeme_kaydi_yok || []).length}</b> ·
                🟡 ödeme var, düşüş görülmedi: <b>{(mutabakat.odeme_var_dusus_gorulmedi || []).length}</b>
              </div>
              {(mutabakat.dusus_var_odeme_kaydi_yok || []).slice(0, 5).map((x, i) => (
                <div key={`d${i}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '4px 0' }}>
                  🟡 <b>{x.tedarikci_ad}</b> bakiyesi {fmt(x.dusus_tutar)}₺ düştü ({x.pencere_bas}→{x.pencere_bit}) — kayıtlarımızda karşılık yok
                </div>
              ))}
              {(mutabakat.odeme_var_dusus_gorulmedi || []).slice(0, 6).map((x, i) => (
                <div key={`o${i}`} style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 0' }}>
                  · {x.tedarikci_ad}: {fmt(x.tutar)}₺ ({x.tarih}, {x.kaynak}{x.kayit_guveni < 1 ? ', aday' : ''})
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── 📦 AÇIK TESLİMAT ── */}
        <div style={K.kart}>
          <div style={K.baslik}>📦 Açık Teslimat</div>
          <div style={K.alt}>Teslimat OPEN doğar; fatura / irsaliye / açıklama ile kapanır. "Neden hâlâ açık?"</div>
          {acikTeslimat && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                Yaş: 0-3g <b>{acikTeslimat.yas_kovalari?.['0_3'] ?? 0}</b> · 4-7g <b>{acikTeslimat.yas_kovalari?.['4_7'] ?? 0}</b> · 8-14g <b>{acikTeslimat.yas_kovalari?.['8_14'] ?? 0}</b> · 15g+ <b style={{ color: 'var(--red)' }}>{acikTeslimat.yas_kovalari?.['15_plus'] ?? 0}</b>
              </div>
              {(acikTeslimat.acik_teslimatlar || []).slice(0, 6).map((a) => (
                <div key={a.id} style={{ fontSize: 12, color: 'var(--text2)', padding: '4px 0', display: 'flex', justifyContent: 'space-between' }}>
                  <span><b>{a.tedarikci_ad || '—'}</b> → {a.sube_adi} · {a.yas_gun} gündür açık
                    {a.ritim_medyan_gun != null && <span style={{ color: 'var(--text3)' }}> (genelde ~{a.ritim_medyan_gun}g)</span>}
                  </span>
                  {a.oncelik === 'yuksek' && <b style={{ color: 'var(--red)', fontSize: 10.5 }}>NEDEN AÇIK?</b>}
                </div>
              ))}
              {(acikTeslimat.ic_sevkiyat_yolda || []).slice(0, 4).map((y, i) => (
                <div key={`y${i}`} style={{ fontSize: 11.5, color: 'var(--text3)', padding: '3px 0' }}>
                  🚚 yolda: {y.kalem_adi} ×{y.sevk_adet} → {y.sube_ad} ({y.yas_gun}g)
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
