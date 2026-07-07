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

function BeyinSor() {
  const [soru, setSoru] = useState('');
  const [cevap, setCevap] = useState(null);
  const [mesgul, setMesgul] = useState(false);
  const [hata, setHata] = useState('');
  const sor = async () => {
    const s = soru.trim();
    if (s.length < 3 || mesgul) return;
    setMesgul(true); setHata(''); setCevap(null);
    try {
      const r = await api('/beyin/sor', { method: 'POST', body: { soru: s } });
      setCevap(r);
    } catch (e) { setHata(e.message || 'Beyin yanıt veremedi'); }
    finally { setMesgul(false); }
  };
  return (
    <div style={{ ...K.kart, borderLeft: '3px solid var(--purple, #8b5cf6)' }}>
      <div style={K.baslik}>🧠 Evvel Beyni'ne Sor <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>v0.1 — gözlem katmanı</span></div>
      <div style={K.alt}>Duyuların gördüğünü sorabilirsin ("Köyceğiz'de bu hafta ne oldu?", "vergi çıkışı ne kadar?"). Karar vermez, alarm kapatmaz, isim vermez — sadece kayıtları anlatır.</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={soru} onChange={(e) => setSoru(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sor(); }}
          placeholder="Sorunu yaz…" disabled={mesgul}
          style={{ flex: 1, background: 'var(--bg)', color: 'var(--text1)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 13.5 }} />
        <button onClick={sor} disabled={mesgul || soru.trim().length < 3} style={{
          background: 'var(--purple, #8b5cf6)', color: '#fff', border: 'none', borderRadius: 10,
          padding: '10px 18px', fontSize: 13.5, fontWeight: 800, cursor: mesgul ? 'default' : 'pointer', opacity: mesgul ? 0.6 : 1,
        }}>{mesgul ? '💭…' : 'Sor'}</button>
      </div>
      {hata && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠️ {hata}</div>}
      {cevap && (
        <div style={{ background: 'var(--bg)', borderRadius: 10, padding: '12px 14px', marginTop: 10 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--yellow, #f59e0b)', marginBottom: 6 }}>{cevap.etiket}</div>
          <div style={{ fontSize: 13.5, color: 'var(--text1)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{cevap.cevap}</div>
          {cevap.bloklar && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 8 }}>
              Kaynak blokları: {cevap.bloklar.map((b) => `[${b.id}] ${b.baslik}`).join(' · ')}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, fontStyle: 'italic' }}>{cevap.dipnot}</div>
        </div>
      )}
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
  const [mudahale, setMudahale] = useState(null);
  const [disiplin, setDisiplin] = useState(null);
  const [butunluk, setButunluk] = useState(null);
  const [sinaps, setSinaps] = useState(null);
  const [hazirlik, setHazirlik] = useState(null);
  const [gunluk, setGunluk] = useState(null);
  const [yavru, setYavru] = useState(null);
  const [karne, setKarne] = useState(null);
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
    api('/duyu/mudahale-izi?gun=30').then(setMudahale).catch(() => {});
    api('/duyu/kayit-disiplini?gun=14').then(setDisiplin).catch(() => {});
    api('/duyu/satis-butunluk?gun=14').then(setButunluk).catch(() => {});
    api('/duyu/sinapsler?gun=14').then(setSinaps).catch(() => {});
    api('/duyu/uyanis-hazirlik').then(setHazirlik).catch(() => {});
    api('/beyin/gunluk?limit=12').then(setGunluk).catch(() => {});
    api('/duyu/yavru-kurallari?gun=7').then(setYavru).catch(() => {});
    api('/duyu/kural-karnesi').then(setKarne).catch(() => {});
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

      {/* ── 🧠 EVVEL BEYNİ ── */}
      <BeyinSor />

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

        {/* ── 🪞 MÜDAHALE İZİ (sahip dahil) ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🪞 Müdahale İzi <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(30 gün, sahip dahil)</span></div>
          <div style={K.alt}>Geçmişe dokunan her işlem — iptal, geri alma, düzeltme — kim yaparsa yapsın iz bırakır. Hüküm yok: her müdahale meşru olabilir; yoğunlaşmayı sen okursun.</div>
          {mudahale && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                Toplam: <b>{mudahale.toplam}</b> müdahale
              </div>
              {(mudahale.islem_turleri || []).slice(0, 7).map((t, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--text2)', padding: '4px 0', display: 'flex', justifyContent: 'space-between' }}>
                  <span><b>{t.islem}</b> <span style={{ color: 'var(--text3)' }}>({t.tablo})</span></span>
                  <span style={{ fontFamily: 'ui-monospace, monospace' }}>×{t.adet} <span style={{ color: 'var(--text3)', fontSize: 10.5 }}>{t.ilk === t.son ? t.son : `${t.ilk}→${t.son}`}</span></span>
                </div>
              ))}
              {(mudahale.gunluk_yogunluk || []).some((g) => g.adet >= 10) && (
                <div style={{ fontSize: 11, color: 'var(--yellow, #f59e0b)', marginTop: 6 }}>
                  ⚡ Yoğun günler: {(mudahale.gunluk_yogunluk || []).filter((g) => g.adet >= 10).map((g) => `${g.gun} (×${g.adet})`).join(' · ')}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 🧾 KAYIT DİSİPLİNİ (FAZ 2) ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🧾 Kayıt Disiplini <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(14 gün, Sv0 ham)</span></div>
          <div style={K.alt}>Manuel açıklama oranı + geriye tarihli yazım + şube nakit oranı. Hepsi meşru olabilir — örüntüye sen bakarsın.</div>
          {disiplin && (
            <>
              {(() => {
                const sonGunler = {};
                (disiplin.aciklama_yogunlugu || []).forEach((a) => { sonGunler[a.tablo] = a; });
                return Object.values(sonGunler).map((a, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text2)', padding: '3px 0', display: 'flex', justifyContent: 'space-between' }}>
                    <span>📝 <b>{a.tablo}</b> <span style={{ color: 'var(--text3)', fontSize: 10.5 }}>{a.gun}</span></span>
                    <span style={{ fontFamily: 'ui-monospace, monospace' }}>{a.aciklamali}/{a.toplam} açıklamalı ({Math.round((a.oran || 0) * 100)}%)</span>
                  </div>
                ));
              })()}
              {(disiplin.geriye_tarihli_bugun || []).map((b, i) => (
                <div key={`b${i}`} style={{ fontSize: 12, color: 'var(--yellow, #f59e0b)', padding: '3px 0' }}>
                  ⏪ bugün geçmiş tarihe yazım: <b>{b.tablo}</b> ×{b.n} (en eski {b.max_gecikme_gun}g geride)
                </div>
              ))}
              {(() => {
                const sonKarma = {};
                (disiplin.odeme_karmasi || []).forEach((k2) => { sonKarma[k2.sube_ad] = k2; });
                return Object.values(sonKarma).map((k2, i) => (
                  <div key={`k${i}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '3px 0', display: 'flex', justifyContent: 'space-between' }}>
                    <span>💳 <b>{k2.sube_ad}</b> <span style={{ color: 'var(--text3)', fontSize: 10.5 }}>{k2.gun}</span></span>
                    <span style={{ fontFamily: 'ui-monospace, monospace' }}>nakit {k2.nakit_oran != null ? `${Math.round(k2.nakit_oran * 100)}%` : '—'} · {fmt(k2.toplam)}₺</span>
                  </div>
                ));
              })()}
            </>
          )}
        </div>

        {/* ── 🎯 SATIŞ BÜTÜNLÜĞÜ (FAZ 2) ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🎯 Satış Bütünlüğü <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(zımni fiyat + iade/fire, aday)</span></div>
          <div style={K.alt}>Ciro÷adet = zımni fiyat; menüden sapanlar ADAY (kampanya/ikram da aynı izi bırakır). İade-fire yerli bildirimlerden.</div>
          {butunluk && (
            <>
              {(butunluk.zimni_fiyat || []).map((z, i) => (
                <div key={`z${i}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '3px 0' }}>
                  🏷️ <b>{z.sube_ad}</b> <span style={{ color: 'var(--text3)', fontSize: 10.5 }}>{z.gun}{z.canli === false ? ' · cache' : ''}</span>: {z.urun_n} ürün, {z.menu_eslesen_n} menü eşleşti
                  {(z.sapma_adaylari || []).length > 0 && (
                    <div style={{ marginLeft: 16, color: 'var(--yellow, #f59e0b)', fontSize: 11.5 }}>
                      {(z.sapma_adaylari || []).slice(0, 4).map((sa, j) => (
                        <div key={j}>≈ {sa.ad}: zımni {fmt(sa.liste_tahmin)}₺ / menü {fmt(sa.menu_fiyat)}₺ ({sa.sapma_oran > 0 ? '+' : ''}{Math.round(sa.sapma_oran * 100)}%)</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {(butunluk.iade_fire || []).slice(-6).map((f, i) => (
                <div key={`f${i}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '3px 0', display: 'flex', justifyContent: 'space-between' }}>
                  <span>♻️ <b>{f.sube_ad}</b> <span style={{ color: 'var(--text3)', fontSize: 10.5 }}>{f.gun}</span></span>
                  <span style={{ fontFamily: 'ui-monospace, monospace' }}>{f.bildirim_n} bildirim · {f.toplam_adet} adet{f.iade_n > 0 ? ` · ${f.iade_n} iade` : ''}</span>
                </div>
              ))}
              {(butunluk.zimni_fiyat || []).length === 0 && (butunluk.iade_fire || []).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Henüz veri yok — zımni fiyat Evo çekimiyle, iade/fire şube bildirimiyle dolar.</div>
              )}
            </>
          )}
        </div>

        {/* ── 🕸️ SİNAPSLAR (FAZ 3) ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🕸️ Sinapslar <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(duyular arası birliktelik, aday)</span></div>
          <div style={K.alt}>Duyular birbirine bağlandı: aynı yere düşen işaretler yan yana. Birliktelik kaydı — hüküm değil.</div>
          {sinaps && (
            <>
              {(sinaps.kase_canli || []).slice(0, 4).map((a, i) => (
                <div key={`ka${i}`} style={{ fontSize: 12, color: 'var(--yellow, #f59e0b)', padding: '3px 0' }}>
                  ⭐ <b>{a.kalem_adi}</b> ({a.sube_ad}): sayım {fmt(a.sayim_delta)} · satış {fmt(a.satis)} &gt; kullanım {fmt(a.kullanim)}{a.fire_bildirimi_var ? ' · fire bildirimi VAR' : ' · fire bildirimi YOK'}
                </div>
              ))}
              {(sinaps.zincir_canli || []).filter((z) => z.zincir_kor).slice(0, 4).map((z, i) => (
                <div key={`zi${i}`} style={{ fontSize: 12, color: 'var(--text2)', padding: '3px 0' }}>
                  🔗 <b>{z.tedarikci_ad}</b>: {z.acik_teslimat_n} açık teslimat ({z.max_yas_gun}g) · ödeme izi yok
                </div>
              ))}
              {(sinaps.sinaps_olaylari || []).slice(0, 5).map((o, i) => (
                <div key={`so${i}`} style={{ fontSize: 11.5, color: 'var(--text3)', padding: '3px 0' }}>
                  · {String(o.occurred_at || '').slice(0, 10)} {o.signal_name} {o.duyu === 'sinaps_kompozit' && o.payload_json?.duyular ? `— ${o.payload_json.duyular.join(' + ')}` : ''}
                </div>
              ))}
              {(sinaps.kase_canli || []).length === 0 && (sinaps.zincir_canli || []).filter((z) => z.zincir_kor).length === 0 && (sinaps.sinaps_olaylari || []).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>Şu an birliktelik yok — sinapslar her gece tarar.</div>
              )}
            </>
          )}
        </div>

        {/* ── 🌡️ MOTOR UYANIŞ KARNESİ (FAZ 4, uyur) ── */}
        <div style={{ ...K.kart, borderLeft: '3px solid var(--text3)' }}>
          <div style={K.baslik}>🌡️ Motor Uyanış Karnesi <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(motor uyuyor)</span></div>
          <div style={K.alt}>Takvim değil termometre: kriterler veri biriktikçe kendiliğinden yeşerir. 7/7 + senin onayın olmadan motor uyanmaz.</div>
          {hazirlik && (
            <>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text1)', marginBottom: 8 }}>
                {hazirlik.durum} <span style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--text3)' }}>· olgunluk bekçisi D+{hazirlik.olgunluk_bekcisi_gun}</span>
              </div>
              {(hazirlik.kriterler || []).map((k2, i) => (
                <div key={i} style={{ fontSize: 12, padding: '3px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: k2.gecti ? 'var(--green, #22c55e)' : 'var(--text3)' }}>
                    {k2.gecti ? '✅' : '⬜'} {k2.kriter.replace(/_/g, ' ')}
                  </span>
                  <span style={{ color: 'var(--text3)', fontFamily: 'ui-monospace, monospace', fontSize: 11, textAlign: 'right' }}>{k2.durum}</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 8, fontStyle: 'italic' }}>
                Uyanış günü motor omurgayı SADECE OKUR; isme yaklaşmak ≥2-3 bağımsız kaynak ailesi ister; hiçbir duyu verisi alarm kapatamaz.
              </div>
            </>
          )}
        </div>

        {/* ── 🧶 YAVRU ÖRME (kural kütüphanesi + bağlar) ── */}
        <div style={K.kart}>
          <div style={K.baslik}>🧶 Yavru Örme <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>("şu söylerse bu da bundandır")</span></div>
          <div style={K.alt}>T1 = açıklayıcı bağ (kapatmaz, iliştirir) · T2 = beklenti (çocuk doğmalıydı; doğmadıysa yokluk sinyaldir). Kural ekleme yalnız senin onayınla.</div>
          {yavru && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>
                Kütüphane: <b>{yavru.kural_n}</b> kural — {(yavru.kurallar || []).filter((k2) => k2.tur === 'T1').length} açıklayıcı, {(yavru.kurallar || []).filter((k2) => k2.tur === 'T2').length} beklenti
              </div>
              {(yavru.kurallar || []).map((k2, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text3)', padding: '2px 0' }}>
                  {k2.tur === 'T2' ? '⏳' : '🔗'} <b style={{ color: 'var(--text2)' }}>{k2.kural_id}</b> — {k2.aciklama}
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                {(yavru.son_baglar || []).slice(0, 8).map((b, i) => (
                  <div key={`b${i}`} style={{ fontSize: 11.5, padding: '3px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, color: String(b.olay_tipi).includes('cocuk_gelmedi') ? 'var(--yellow, #f59e0b)' : 'var(--text2)' }}>
                    <span>{String(b.olay_tipi).includes('cocuk_gelmedi') ? '⚠️' : '·'} {String(b.occurred_at || '').slice(0, 10)} <b>{b.payload_json?.kural_id}</b>: {b.signal_name}</span>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      {b.insan_karari ? (
                        <span style={{ fontSize: 10.5, color: b.insan_karari === 'dogru_bag' ? 'var(--green, #22c55e)' : 'var(--red)' }}>{b.insan_karari === 'dogru_bag' ? '✓ doğru' : '✗ yanlış'}</span>
                      ) : (
                        <>
                          <button title="doğru bağ" onClick={() => { api('/duyu/yavru-etiket', { method: 'POST', body: { event_id: b.event_id, karar: 'dogru_bag' } }).then(() => api('/duyu/yavru-kurallari?gun=7').then(setYavru)).catch(() => {}); }}
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--green, #22c55e)', cursor: 'pointer', fontSize: 11, padding: '1px 6px', marginRight: 4 }}>✓</button>
                          <button title="yanlış bağ" onClick={() => { api('/duyu/yavru-etiket', { method: 'POST', body: { event_id: b.event_id, karar: 'yanlis_bag' } }).then(() => api('/duyu/yavru-kurallari?gun=7').then(setYavru)).catch(() => {}); }}
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--red)', cursor: 'pointer', fontSize: 11, padding: '1px 6px' }}>✗</button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
                {(yavru.son_baglar || []).length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>Henüz bağ yok — motor her gece örer.</div>
                )}
              </div>
              {karne && (
                <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 4 }}>
                    📋 Kural karnesi <b>(öğrenme {karne.ogrenme_aktif ? 'AÇIK' : 'kapalı — sadece gösterir'})</b>
                  </div>
                  {(karne.karne || []).filter((k2) => k2.bag_n > 0 || k2.etiketli_n > 0).map((k2, i) => (
                    <div key={i} style={{ fontSize: 10.5, color: 'var(--text3)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>{k2.kural_id}</span>
                      <span style={{ fontFamily: 'ui-monospace, monospace' }}>{k2.bag_n} bağ · ✓{k2.dogru_n} ✗{k2.yanlis_n} · {k2.n_esigi_rozet.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                  {(karne.karne || []).every((k2) => k2.bag_n === 0 && k2.etiketli_n === 0) && (
                    <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>Karne boş — bağlar ve işaretlerin biriktikçe dolar.</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 📓 BEYİN GÜNLÜĞÜ (iç sesin okunabilir hali) ── */}
        <div style={{ ...K.kart, borderLeft: '3px solid var(--purple, #8b5cf6)' }}>
          <div style={K.baslik}>📓 Beyin Günlüğü <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>(gece öz-anlatıları)</span></div>
          <div style={K.alt}>Beyin her gece duyuların gördüğünü kendi kelimeleriyle günlüğüne yazar ve sabah WhatsApp'ına gönderir. Gözlem dili — karar değil.</div>
          {gunluk && (() => {
            const sentezler = (gunluk.kayitlar || []).filter((k2) => k2.tip === 'gece_sentez' && k2.cevap && !k2.red_nedeni);
            if (!sentezler.length) return <div style={{ fontSize: 12, color: 'var(--text3)' }}>Henüz gece anlatısı yok — beyin her gece 00:30 civarı yazar.</div>;
            return sentezler.slice(0, 3).map((s, i) => (
              <div key={i} style={{ background: 'var(--bg)', borderRadius: 10, padding: '10px 12px', marginBottom: 8 }}>
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginBottom: 4 }}>{String(s.olusturma || '').slice(0, 16)} · {s.model}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text1)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{s.cevap}</div>
              </div>
            ));
          })()}
        </div>
      </div>
    </div>
  );
}
